'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const {
  buildAnthropicRequest,
  rectifyAnthropicRequestForRetry
} = require('./anthropicBridgeRequest');
const {
  convertAnthropicResponse,
  streamAnthropicResponse
} = require('./anthropicBridgeResponse');
const { writeConvertedResponseAsSse } = require('./chatBridgeResponse');
const { classifyResponsesRoute } = require('./providerBridgeRoutes');
const { providerError } = require('./providerProfile');
const { sanitizeProviderMessage } = require('./providerRedaction');
const {
  createProviderStreamLifecycle,
  resolveProviderIdleTimeoutMs,
  resolveProviderTotalTimeoutMs
} = require('./providerStreamLifecycle');

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_HISTORY_ENTRIES = 64;
const MAX_CONTINUATION_CHARS = 512 * 1024;
const MAX_REASONING_CONTINUATIONS = 2;
const REASONING_CONTINUATION_MARKER = '[codex-overleaf-provider-reasoning-continuation]';

async function startAnthropicMessagesBridge({ launch, signal } = {}) {
  if (!launch?.baseUrl) throw providerError('provider_base_url_invalid', 'Anthropic routing requires a provider Base URL.');
  const clientToken = crypto.randomBytes(32).toString('base64url');
  const activeRequests = new Set();
  const history = new Map();
  const continuationState = { anchorMessages: [], attempts: 0, responseId: '' };
  const server = http.createServer((req, res) => {
    handleRequest({ req, res, launch, clientToken, activeRequests, history, continuationState }).catch(error => {
      if (res.writableEnded) return;
      const code = normalizeBridgeErrorCode(error?.code);
      const message = sanitizeProviderMessage(error?.message, [launch.apiKey]) || 'The Anthropic provider bridge failed.';
      if (res.headersSent) {
        res.end(`event: response.failed\ndata: ${JSON.stringify({
          type: 'response.failed',
          sequence_number: 999999,
          response: { status: 'failed', error: { code, message } }
        })}\n\n`);
      } else {
        sendJsonError(res, code === 'provider_connection_timeout' ? 504 : 502, code, message);
      }
    });
  });
  const idleTimeoutMs = resolveProviderIdleTimeoutMs(launch);
  const totalTimeoutMs = resolveProviderTotalTimeoutMs(launch, idleTimeoutMs);
  server.keepAliveTimeout = 5000;
  server.requestTimeout = totalTimeoutMs + 5000;
  await listen(server);
  const address = server.address();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', close);
    for (const controller of activeRequests) controller.abort();
    activeRequests.clear();
    history.clear();
    continuationState.anchorMessages = [];
    continuationState.attempts = 0;
    continuationState.responseId = '';
    await closeServer(server);
  };
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) await close();
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, clientToken, close };
}

async function handleRequest({ req, res, launch, clientToken, activeRequests, history, continuationState }) {
  if (!isAuthorized(req, clientToken)) {
    sendJsonError(res, 401, 'unauthorized', 'Local bridge authorization failed.');
    return;
  }
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'GET' && /\/models\/?$/.test(url.pathname)) {
    sendJson(res, 200, { object: 'list', data: [{ id: launch.modelId, object: 'model', created: 0, owned_by: launch.providerName || 'anthropic' }] });
    return;
  }
  const responsesRoute = classifyResponsesRoute(req.method, url.pathname);
  if (!responsesRoute) {
    sendJsonError(res, 404, 'not_found', 'The local Anthropic bridge only exposes Responses, Responses Compact, and Models endpoints.');
    return;
  }
  const requestBody = await readJsonBody(req);
  const previousResponseId = String(requestBody.previous_response_id || '');
  const previous = history.get(previousResponseId);
  const fallbackAnchor = previous ? [] : continuationState.anchorMessages;
  const continuing = Boolean(previous?.continuation || fallbackAnchor.length);
  if (continuing && continuationState.attempts >= MAX_REASONING_CONTINUATIONS) {
    throw providerError(
      'provider_reasoning_continuation_exhausted',
      'The provider repeatedly interrupted the same reasoning stream. Retry the task or use a different model endpoint.'
    );
  }
  const translated = buildAnthropicRequest({
    requestBody,
    launch,
    historyMessages: previous?.messages || fallbackAnchor
  });
  const controller = new AbortController();
  activeRequests.add(controller);
  let abortReason = '';
  const lifecycle = createProviderStreamLifecycle({
    controller,
    idleTimeoutMs: resolveProviderIdleTimeoutMs(launch),
    totalTimeoutMs: resolveProviderTotalTimeoutMs(launch),
    onAbort: reason => { abortReason = reason; }
  });
  const onClientClose = () => {
    if (!res.writableEnded) lifecycle.abort('client_close');
  };
  req.on('aborted', onClientClose);
  res.on('close', onClientClose);
  lifecycle.start();
  try {
    const upstream = await fetchWithRectification(launch, translated.body, controller.signal);
    lifecycle.touch();
    if (!upstream.response.ok) {
      forwardUpstreamError(upstream.response, upstream.errorText, res, launch.apiKey);
      return;
    }
    const context = {
      launch,
      requestBody,
      model: translated.body.model,
      toolContext: translated.toolContext
    };
    const remember = converted => {
      const baseMessages = upstream.requestBody.messages || translated.messages;
      const continuation = buildAnthropicHistoryContinuation(converted);
      const anchored = continuation.length > 0;
      const assistantMessages = anchored
        ? continuation
        : [{ role: 'assistant', content: converted.assistantBlocks }];
      const messages = [...baseMessages, ...assistantMessages];
      if (anchored) {
        continuationState.anchorMessages = messages;
        continuationState.attempts += 1;
        continuationState.responseId = converted.response.id;
      } else {
        continuationState.anchorMessages = [];
        continuationState.attempts = 0;
        continuationState.responseId = '';
      }
      rememberHistory(history, converted.response.id, messages, { continuation: anchored });
    };
    const contentType = String(upstream.response.headers.get('content-type') || '').toLowerCase();
    if (requestBody.stream !== false) {
      if (contentType.includes('text/event-stream')) {
        await streamAnthropicResponse({
          upstream: upstream.response,
          res,
          context,
          onComplete: remember,
          onActivity: lifecycle.touch,
          recoverInterrupted: lifecycle.recoverInterrupted
        });
      } else {
        const converted = convertAnthropicResponse(await upstream.response.json(), context);
        writeConvertedResponseAsSse(res, converted, context, remember);
      }
    } else if (contentType.includes('text/event-stream')) {
      let converted;
      const sink = { writeHead() {}, write() {}, end() {} };
      await streamAnthropicResponse({
        upstream: upstream.response,
        res: sink,
        context,
        onComplete: value => { converted = value; },
        onActivity: lifecycle.touch,
        recoverInterrupted: lifecycle.recoverInterrupted
      });
      remember(converted);
      sendJson(res, 200, converted.response);
    } else {
      const converted = convertAnthropicResponse(await upstream.response.json(), context);
      remember(converted);
      sendJson(res, 200, converted.response);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw providerError(
        'provider_connection_timeout',
        abortReason === 'total_timeout'
          ? 'The provider exceeded the maximum total request duration.'
          : 'The provider stopped producing data before the request completed.'
      );
    }
    throw error;
  } finally {
    lifecycle.dispose();
    activeRequests.delete(controller);
    req.removeListener('aborted', onClientClose);
    res.removeListener('close', onClientClose);
  }
}

async function fetchWithRectification(launch, body, signal) {
  let requestBody = body;
  let response = await fetch(buildAnthropicMessagesUrl(launch.baseUrl, launch), {
    method: 'POST',
    headers: buildAnthropicHeaders(launch),
    body: JSON.stringify(body),
    signal
  });
  if (response.ok) return { response, errorText: '', requestBody };
  let errorText = (await response.text()).slice(0, MAX_ERROR_BYTES);
  if (response.status === 400) {
    const retryBody = JSON.parse(JSON.stringify(body));
    if (rectifyAnthropicRequestForRetry(retryBody, errorText)) {
      requestBody = retryBody;
      response = await fetch(buildAnthropicMessagesUrl(launch.baseUrl, launch), {
        method: 'POST',
        headers: buildAnthropicHeaders(launch),
        body: JSON.stringify(retryBody),
        signal
      });
      errorText = response.ok ? '' : (await response.text()).slice(0, MAX_ERROR_BYTES);
    }
  }
  return { response, errorText, requestBody };
}

function buildAnthropicMessagesUrl(baseUrl, launch = {}) {
  const url = new URL(baseUrl);
  if (!launch.fullEndpoint && !/\/v1\/messages\/?$/i.test(url.pathname.replace(/\/+$/, ''))) {
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = /\/v1$/i.test(path)
      ? `${path}/messages`
      : `${!path || path === '/' ? '' : path}/v1/messages`;
  }
  url.hash = '';
  for (const [key, value] of Object.entries(launch.queryParams || {})) url.searchParams.set(key, value);
  return url.toString();
}

function buildAnthropicHeaders(launch = {}) {
  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'user-agent': launch.impersonateClaudeCode ? 'claude-cli/2.1.0 (external, cli)' : 'Codex-Overleaf-Link/provider-bridge',
    'anthropic-version': launch.anthropicVersion || '2023-06-01',
    ...(launch.customHeaders || {})
  };
  if (launch.anthropicBeta) headers['anthropic-beta'] = launch.anthropicBeta;
  if (launch.impersonateClaudeCode) headers['x-app'] = 'cli';
  if (!launch.apiKey || launch.authMode === 'none') return headers;
  if (launch.authMode === 'bearer') headers.authorization = `Bearer ${launch.apiKey}`;
  else if (launch.authMode === 'api-key') headers['api-key'] = launch.apiKey;
  else if (launch.authMode === 'custom' && launch.apiKeyHeaderName) headers[launch.apiKeyHeaderName] = launch.apiKey;
  else headers['x-api-key'] = launch.apiKey;
  return headers;
}

function forwardUpstreamError(response, errorText, res, apiKey) {
  let message = `Provider returned HTTP ${response.status}.`;
  try {
    const parsed = JSON.parse(errorText || '{}');
    message = parsed?.error?.message || parsed?.message || message;
  } catch (_error) {}
  sendJsonError(res, response.status, 'provider_upstream_error', sanitizeProviderMessage(message, [apiKey]));
}

function rememberHistory(history, responseId, messages, metadata = {}) {
  history.delete(responseId);
  history.set(responseId, { messages, ...metadata });
  while (history.size > MAX_HISTORY_ENTRIES) history.delete(history.keys().next().value);
}

function buildAnthropicHistoryContinuation(converted = {}) {
  if (converted.response?.status !== 'incomplete') return [];
  const blocks = Array.isArray(converted.assistantBlocks) ? converted.assistantBlocks : [];
  if (blocks.some(block => block?.type === 'tool_use')) return [];
  const partial = blocks.map(block => {
    if (block?.type === 'thinking') return String(block.thinking || '');
    if (block?.type === 'text') return String(block.text || '');
    return '';
  }).filter(Boolean).join('\n\n').trim();
  if (!partial) return [];
  const retained = partial.length > MAX_CONTINUATION_CHARS
    ? partial.slice(-MAX_CONTINUATION_CHARS)
    : partial;
  return [{
    role: 'assistant',
    content: [{
      type: 'text',
      text: `${REASONING_CONTINUATION_MARKER}\nThe previous provider stream was interrupted. Continue from this preserved partial analysis without restarting it.\n\n${retained}`
    }]
  }];
}

function normalizeBridgeErrorCode(value) {
  return [
    'provider_connection_timeout',
    'provider_reasoning_continuation_exhausted',
    'provider_response_invalid',
    'provider_request_invalid',
    'provider_upstream_error'
  ].includes(value)
    ? value
    : 'provider_bridge_failed';
}

function isAuthorized(req, token) {
  const value = String(req.headers.authorization || '');
  const supplied = value.startsWith('Bearer ') ? value.slice(7) : '';
  const expectedBuffer = Buffer.from(token);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) {
        reject(providerError('provider_request_too_large', 'Provider request exceeded the local bridge limit.'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (_error) { reject(providerError('provider_request_invalid', 'Codex sent an invalid Responses request.')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function sendJsonError(res, status, code, message) {
  sendJson(res, status, { error: { type: 'provider_error', code, message } });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

module.exports = {
  buildAnthropicHeaders,
  buildAnthropicMessagesUrl,
  startAnthropicMessagesBridge
};
