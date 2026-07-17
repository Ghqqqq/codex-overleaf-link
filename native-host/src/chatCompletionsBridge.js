'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { buildChatRequest } = require('./chatBridgeRequest');
const {
  convertChatResponse,
  streamChatResponse,
  writeConvertedResponseAsSse
} = require('./chatBridgeResponse');
const { requiresReasoningContentReplay } = require('./providerReasoning');
const { classifyResponsesRoute } = require('./providerBridgeRoutes');
const { providerError } = require('./providerProfile');
const { sanitizeProviderMessage } = require('./providerRedaction');
const { logDebug } = require('./debugLog');

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_HISTORY_ENTRIES = 64;
const MAX_REASONING_CONTINUATIONS = 2;
const REASONING_CONTINUATION_MARKER = '[codex-overleaf-provider-reasoning-continuation]';

async function startChatCompletionsBridge({ launch, signal } = {}) {
  if (!launch?.baseUrl) {
    throw providerError('provider_base_url_invalid', 'Chat routing requires a provider Base URL.');
  }
  const clientToken = crypto.randomBytes(32).toString('base64url');
  const activeRequests = new Set();
  const history = new Map();
  const continuationState = {
    anchorMessages: [],
    attempts: 0,
    responseId: ''
  };
  const server = http.createServer((req, res) => {
    handleRequest({
      req,
      res,
      launch,
      clientToken,
      activeRequests,
      history,
      continuationState
    }).catch(error => {
      if (res.writableEnded) return;
      const code = normalizeBridgeErrorCode(error?.code);
      const message = sanitizeProviderMessage(error?.message, [launch.apiKey]) || bridgeErrorMessage(code);
      if (res.headersSent) {
        const payload = {
          type: 'response.failed',
          sequence_number: 999999,
          response: { status: 'failed', error: { code, message } }
        };
        res.end(`event: response.failed\ndata: ${JSON.stringify(payload)}\n\n`);
      } else {
        sendJsonError(res, code === 'provider_connection_timeout' ? 504 : 502, code, message);
      }
    });
  });
  const requestTimeoutMs = resolveRequestTimeoutMs(launch);
  server.keepAliveTimeout = 5000;
  server.requestTimeout = requestTimeoutMs + 5000;
  await listen(server);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
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
  return { baseUrl, clientToken, close };
}

async function handleRequest({
  req,
  res,
  launch,
  clientToken,
  activeRequests,
  history,
  continuationState
}) {
  if (!isAuthorized(req, clientToken)) {
    sendJsonError(res, 401, 'unauthorized', 'Local bridge authorization failed.');
    return;
  }
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'GET' && /\/models\/?$/.test(url.pathname)) {
    sendJson(res, 200, {
      object: 'list',
      data: [{ id: launch.modelId, object: 'model', created: 0, owned_by: launch.providerName || 'custom' }]
    });
    return;
  }
  const responsesRoute = classifyResponsesRoute(req.method, url.pathname);
  if (!responsesRoute) {
    sendJsonError(res, 404, 'not_found', 'The local provider bridge only exposes Responses, Responses Compact, and Models endpoints.');
    return;
  }
  const requestBody = await readJsonBody(req);
  const traceId = crypto.randomUUID().slice(0, 12);
  const startedAt = Date.now();
  const previousResponseId = String(requestBody.previous_response_id || '');
  const previous = history.get(previousResponseId);
  const fallbackAnchor = previous
    ? []
    : continuationState.anchorMessages;
  const translated = buildChatRequest({
    requestBody,
    launch,
    historyMessages: previous?.messages || fallbackAnchor
  });
  assertReasoningContinuationBudget(translated.messages, continuationState.attempts);
  const idleTimeoutMs = resolveRequestTimeoutMs(launch);
  const totalTimeoutMs = resolveTotalRequestTimeoutMs(launch, idleTimeoutMs);
  logDebug('provider.bridge.request', {
    traceId,
    providerName: launch.providerName,
    model: translated.body.model,
    reasoningEffort: launch.reasoningEffort,
    maxOutputTokens: translated.body.max_tokens,
    stream: translated.body.stream,
    hasPreviousResponseId: Boolean(previousResponseId),
    historyHit: Boolean(previous),
    usedFallbackAnchor: fallbackAnchor.length > 0,
    inputItemCount: Array.isArray(requestBody.input) ? requestBody.input.length : requestBody.input ? 1 : 0,
    messageCount: translated.messages.length,
    continuationAttempts: continuationState.attempts,
    idleTimeoutMs,
    totalTimeoutMs
  });
  const controller = new AbortController();
  activeRequests.add(controller);
  let abortReason = '';
  let idleTimeout;
  const abortRequest = reason => {
    if (controller.signal.aborted) return;
    abortReason = reason;
    controller.abort();
  };
  const refreshIdleTimeout = () => {
    clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => abortRequest('idle_timeout'), idleTimeoutMs);
  };
  const onClientClose = () => {
    if (!res.writableEnded) abortRequest('client_close');
  };
  req.on('aborted', onClientClose);
  res.on('close', onClientClose);
  refreshIdleTimeout();
  const totalTimeout = setTimeout(() => abortRequest('total_timeout'), totalTimeoutMs);
  try {
    const upstream = await fetch(buildChatCompletionsUrl(launch.baseUrl, launch), {
      method: 'POST',
      headers: buildUpstreamHeaders(launch),
      body: JSON.stringify(translated.body),
      signal: controller.signal
    });
    refreshIdleTimeout();
    if (!upstream.ok) {
      await forwardUpstreamError(upstream, res, launch.apiKey);
      return;
    }
    const context = {
      launch,
      requestBody,
      model: translated.body.model,
      toolKinds: translated.toolKinds
    };
    const remember = converted => {
      const continuation = buildHistoryContinuation(converted);
      const anchored = isReasoningContinuation(continuation);
      const assistant = converted.assistantMessage || {};
      const reasoningChars = typeof assistant.reasoning_content === 'string'
        ? assistant.reasoning_content.length
        : 0;
      const contentChars = typeof assistant.content === 'string'
        ? assistant.content.length
        : 0;
      const toolCallCount = Array.isArray(assistant.tool_calls)
        ? assistant.tool_calls.length
        : 0;
      if (anchored) {
        continuationState.anchorMessages = continuation;
        continuationState.attempts += 1;
        continuationState.responseId = converted.response.id;
      } else {
        continuationState.anchorMessages = [];
        continuationState.attempts = 0;
        continuationState.responseId = '';
      }
      logDebug('provider.bridge.response', {
        traceId,
        responseId: converted.response.id,
        previousResponseId,
        durationMs: Date.now() - startedAt,
        providerFinishReason: converted.providerFinishReason || '',
        responseStatus: converted.response.status,
        incompleteReason: converted.response.incomplete_details?.reason || '',
        reasoningChars,
        contentChars,
        toolCallCount,
        continuationAnchored: anchored,
        continuationAttempts: continuationState.attempts
      });
      rememberHistory(history, converted.response.id, [
        ...translated.messages,
        ...continuation
      ]);
    };
    if (requestBody.stream !== false) {
      const contentType = String(upstream.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('text/event-stream')) {
        await streamChatResponse({
          upstream,
          res,
          context,
          onComplete: remember,
          onActivity: refreshIdleTimeout,
          recoverInterrupted: () => (
            ['idle_timeout', 'total_timeout'].includes(abortReason)
              ? abortReason
              : ''
          )
        });
      } else {
        const converted = convertChatResponse(await upstream.json(), context);
        writeConvertedResponseAsSse(res, converted, context, remember);
      }
    } else {
      const converted = convertChatResponse(await upstream.json(), context);
      remember(converted);
      sendJson(res, 200, converted.response);
    }
  } catch (error) {
    logDebug('provider.bridge.error', {
      traceId,
      durationMs: Date.now() - startedAt,
      code: normalizeBridgeErrorCode(error?.code),
      aborted: controller.signal.aborted,
      abortReason
    });
    if (controller.signal.aborted) {
      throw providerError('provider_connection_timeout', 'The provider request was cancelled or timed out.');
    }
    throw error;
  } finally {
    clearTimeout(idleTimeout);
    clearTimeout(totalTimeout);
    activeRequests.delete(controller);
    req.removeListener('aborted', onClientClose);
    res.removeListener('close', onClientClose);
  }
}

function buildChatCompletionsUrl(baseUrl, launch = {}) {
  const url = new URL(baseUrl);
  if (launch.fullEndpoint) {
    for (const [key, value] of Object.entries(launch.queryParams || {})) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }
  let pathname = url.pathname.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(pathname)) {
    url.pathname = pathname;
    for (const [key, value] of Object.entries(launch.queryParams || {})) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }
  pathname = !pathname || pathname === '/'
    ? '/v1'
    : pathname;
  url.pathname = `${pathname}/chat/completions`;
  url.search = '';
  url.hash = '';
  for (const [key, value] of Object.entries(launch.queryParams || {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function buildUpstreamHeaders(launch = {}) {
  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'user-agent': 'Codex-Overleaf-Link/provider-bridge',
    ...(launch.customHeaders || {})
  };
  if (!launch.apiKey || launch.authMode === 'none') return headers;
  if (launch.authMode === 'x-api-key') headers['x-api-key'] = launch.apiKey;
  else if (launch.authMode === 'api-key') headers['api-key'] = launch.apiKey;
  else if (launch.authMode === 'custom' && launch.apiKeyHeaderName) {
    headers[launch.apiKeyHeaderName] = launch.apiKey;
  } else {
    headers.authorization = `Bearer ${launch.apiKey}`;
  }
  return headers;
}

function resolveRequestTimeoutMs(launch = {}) {
  const configured = Math.min(300000, Math.max(5000, Number(launch.requestTimeoutMs) || 30000));
  const deepSeekThinking = requiresReasoningContentReplay(launch, launch.modelId)
    && String(launch.reasoningEffort || '').toLowerCase() !== 'none';
  return deepSeekThinking ? Math.max(120000, configured) : configured;
}

function resolveTotalRequestTimeoutMs(launch = {}, idleTimeoutMs = resolveRequestTimeoutMs(launch)) {
  const deepSeekThinking = requiresReasoningContentReplay(launch, launch.modelId)
    && String(launch.reasoningEffort || '').toLowerCase() !== 'none';
  const floor = deepSeekThinking ? 30 * 60 * 1000 : 5 * 60 * 1000;
  return Math.max(floor, idleTimeoutMs * 2);
}

function buildHistoryContinuation(converted = {}) {
  const assistant = converted.assistantMessage || {};
  const reasoning = typeof assistant.reasoning_content === 'string'
    ? assistant.reasoning_content.trim()
    : '';
  const content = String(assistant.content || '').trim();
  const toolCallCount = Array.isArray(assistant.tool_calls)
    ? assistant.tool_calls.length
    : 0;
  // Some OpenAI-compatible DeepSeek gateways end a partial thinking stream
  // with `finish_reason: stop`. A reasoning-only turn still has no usable
  // answer or action for Codex, regardless of the provider's terminal label.
  const reasoningOnlyTurn = reasoning && !content && toolCallCount === 0;
  const interruptedContentTurn = converted.response?.status === 'incomplete'
    && content
    && toolCallCount === 0;
  if (!reasoningOnlyTurn && !interruptedContentTurn) {
    return [assistant];
  }
  const preservedOutput = interruptedContentTurn
    ? `Partial answer preserved from the same unfinished task:\n\n${content}`
    : `Partial analysis preserved from the same unfinished task:\n\n${reasoning}`;
  return [
    {
      role: 'assistant',
      content: preservedOutput
    },
    {
      role: 'user',
      content: [
        REASONING_CONTINUATION_MARKER,
        'The preceding assistant message is established output from this same task.',
        'Continue from the exact point where that partial output stopped.',
        'Do not restart the analysis, reread files already covered, restate the task, or repeat conclusions above.',
        'Move to the next tool call or final answer as soon as the remaining reasoning is complete.'
      ].join('\n')
    }
  ];
}

function isReasoningContinuation(messages = []) {
  return messages.some(message => (
    message?.role === 'user'
    && typeof message.content === 'string'
    && message.content.includes(REASONING_CONTINUATION_MARKER)
  ));
}

function assertReasoningContinuationBudget(messages = [], stateAttempts = 0) {
  const historyAttempts = messages.filter(message => (
    message?.role === 'user'
    && typeof message.content === 'string'
    && message.content.includes(REASONING_CONTINUATION_MARKER)
  )).length;
  const count = Math.max(historyAttempts, Number(stateAttempts) || 0);
  if (count <= MAX_REASONING_CONTINUATIONS) {
    return;
  }
  throw providerError(
    'provider_reasoning_continuation_exhausted',
    'The provider repeatedly stopped during reasoning. Reduce the task scope or use a lower reasoning effort.'
  );
}

function normalizeBridgeErrorCode(value) {
  return [
    'provider_connection_timeout',
    'provider_response_invalid',
    'provider_agent_tools_incompatible',
    'provider_reasoning_continuation_exhausted',
    'provider_stream_tool_parse_failed',
    'provider_protocol_incompatible'
  ].includes(value) ? value : 'provider_bridge_failed';
}

function bridgeErrorMessage(code) {
  return code === 'provider_connection_timeout'
    ? 'The provider request was cancelled or timed out.'
    : 'The local provider bridge failed.';
}

async function forwardUpstreamError(upstream, res, apiKey) {
  const text = (await upstream.text()).slice(0, MAX_ERROR_BYTES);
  let message = `Provider returned HTTP ${upstream.status}.`;
  try {
    const parsed = JSON.parse(text);
    message = parsed?.error?.message || parsed?.message || message;
  } catch (_error) {}
  sendJsonError(res, upstream.status, 'provider_upstream_error', sanitizeProviderMessage(message, [apiKey]));
}

function rememberHistory(history, responseId, messages) {
  history.delete(responseId);
  history.set(responseId, { messages });
  while (history.size > MAX_HISTORY_ENTRIES) {
    history.delete(history.keys().next().value);
  }
}

function isAuthorized(req, token) {
  const value = String(req.headers.authorization || '');
  const supplied = value.startsWith('Bearer ') ? value.slice(7) : '';
  const expectedBuffer = Buffer.from(token);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
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
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (_error) {
        reject(providerError('provider_request_invalid', 'Codex sent an invalid Responses request.'));
      }
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

module.exports = { buildChatCompletionsUrl, buildUpstreamHeaders, startChatCompletionsBridge };
