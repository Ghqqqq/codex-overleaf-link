'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { classifyResponsesRoute } = require('./providerBridgeRoutes');
const { providerError } = require('./providerProfile');
const { sanitizeProviderMessage } = require('./providerRedaction');
const { logDebug } = require('./debugLog');
const {
  createProviderStreamLifecycle,
  resolveProviderIdleTimeoutMs,
  resolveProviderTotalTimeoutMs
} = require('./providerStreamLifecycle');

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_HISTORY_ENTRIES = 64;
const MAX_HISTORY_ITEMS = 4096;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const MAX_DUPLICATE_CONTINUATIONS = 2;
const MAX_STREAM_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_COMPACT_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_TOKENS = 65536;
const CONTINUATION_MARKER = '[codex-overleaf-provider-reasoning-continuation]';

async function startResponsesPassthroughBridge({ launch, signal } = {}) {
  if (!launch?.baseUrl) {
    throw providerError('provider_base_url_invalid', 'Responses routing requires a provider Base URL.');
  }
  const clientToken = crypto.randomBytes(32).toString('base64url');
  const activeRequests = new Set();
  const history = new Map();
  const server = http.createServer((req, res) => {
    handleRequest({ req, res, launch, clientToken, activeRequests, history }).catch(error => {
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
  const idleTimeoutMs = resolveProviderIdleTimeoutMs(launch);
  const totalTimeoutMs = resolveProviderTotalTimeoutMs(launch, idleTimeoutMs);
  server.keepAliveTimeout = 5000;
  server.requestTimeout = totalTimeoutMs + 5000;
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
    await closeServer(server);
  };
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) await close();
  return { baseUrl, clientToken, close };
}

async function handleRequest({ req, res, launch, clientToken, activeRequests, history }) {
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
  const route = classifyResponsesRoute(req.method, url.pathname);
  if (!route) {
    sendJsonError(res, 404, 'not_found', 'The local provider bridge only exposes Responses, Responses Compact, and Models endpoints.');
    return;
  }

  const requestBody = await readJsonBody(req);
  const traceId = crypto.randomUUID().slice(0, 12);
  const startedAt = Date.now();
  const originalPreviousResponseId = String(requestBody.previous_response_id || '');
  const previous = history.get(originalPreviousResponseId);
  if (previous?.duplicateContinuations >= MAX_DUPLICATE_CONTINUATIONS) {
    throw providerError(
      'provider_responses_continuation_repeated',
      'The provider repeated the same unfinished response without making progress.'
    );
  }

  const prepared = route === 'responses'
    ? prepareResponsesRequest({ requestBody, launch, history, previous, originalPreviousResponseId })
    : {
        body: { ...requestBody },
        currentInput: normalizeInputItems(requestBody.input),
        replayed: false
      };
  const idleTimeoutMs = resolveProviderIdleTimeoutMs(launch);
  const totalTimeoutMs = resolveProviderTotalTimeoutMs(launch, idleTimeoutMs);
  logDebug('provider.responses.request', {
    traceId,
    providerName: launch.providerName,
    model: prepared.body.model || launch.modelId,
    route,
    reasoningEffort: launch.reasoningEffort,
    maxOutputTokens: route === 'responses' ? prepared.body.max_output_tokens : null,
    stream: prepared.body.stream !== false,
    hasPreviousResponseId: Boolean(originalPreviousResponseId),
    historyHit: Boolean(previous),
    replayed: prepared.replayed,
    inputItemCount: prepared.currentInput.length,
    idleTimeoutMs,
    totalTimeoutMs
  });

  const controller = new AbortController();
  activeRequests.add(controller);
  let abortReason = '';
  const lifecycle = createProviderStreamLifecycle({
    controller,
    idleTimeoutMs,
    totalTimeoutMs,
    onAbort: reason => { abortReason = reason; }
  });
  const onClientClose = () => {
    if (!res.writableEnded) lifecycle.abort('client_close');
  };
  req.on('aborted', onClientClose);
  res.on('close', onClientClose);
  lifecycle.start();
  try {
    const upstream = await fetch(buildResponsesUrl(launch.baseUrl, launch, route), {
      method: 'POST',
      headers: buildUpstreamHeaders(launch),
      body: JSON.stringify(prepared.body),
      signal: controller.signal
    });
    lifecycle.touch();
    if (!upstream.ok) {
      await forwardUpstreamError(upstream, res, launch.apiKey);
      return;
    }
    if (route === 'compact') {
      await forwardCompactResponse(upstream, res, lifecycle.touch, launch.apiKey);
      return;
    }

    let response;
    if (prepared.body.stream !== false) {
      const contentType = String(upstream.headers.get('content-type') || '').toLowerCase();
      if (!contentType.includes('text/event-stream')) {
        throw providerError(
          'provider_protocol_incompatible',
          'The provider returned a non-streaming payload for a streaming Responses request.'
        );
      }
      response = await forwardResponsesSse(upstream, res, lifecycle.touch, launch.apiKey);
    } else {
      const text = await upstream.text();
      try {
        response = JSON.parse(text);
      } catch (_error) {
        throw providerError('provider_response_invalid', 'The provider returned an invalid Responses JSON response.');
      }
      lifecycle.touch();
      sanitizeProtocolErrors(response, launch.apiKey, hasDuplicateJsonKeys(text));
      sendJson(res, 200, response);
    }
    if (response?.id) {
      rememberResponse(history, {
        response,
        previous,
        previousResponseId: originalPreviousResponseId,
        currentInput: prepared.currentInput,
        replayed: prepared.replayed
      });
      const entry = history.get(String(response.id));
      logDebug('provider.responses.response', {
        traceId,
        responseId: response.id,
        previousResponseId: originalPreviousResponseId,
        durationMs: Date.now() - startedAt,
        responseStatus: response.status || '',
        incompleteReason: response.incomplete_details?.reason || '',
        outputItemCount: entry?.outputItems.length || 0,
        reasoningChars: entry?.metrics.reasoningChars || 0,
        contentChars: entry?.metrics.contentChars || 0,
        toolCallCount: entry?.metrics.toolCallCount || 0,
        continuationRequired: Boolean(entry?.continuationRequired),
        duplicateContinuations: entry?.duplicateContinuations || 0,
        replayed: prepared.replayed,
        outputTokens: Number(response.usage?.output_tokens) || 0
      });
    } else {
      logDebug('provider.responses.response', {
        traceId,
        durationMs: Date.now() - startedAt,
        responseStatus: 'missing_terminal_response',
        replayed: prepared.replayed
      });
    }
  } catch (error) {
    logDebug('provider.responses.error', {
      traceId,
      durationMs: Date.now() - startedAt,
      code: normalizeBridgeErrorCode(error?.code),
      aborted: controller.signal.aborted,
      abortReason,
      replayed: prepared.replayed
    });
    if (controller.signal.aborted) {
      throw providerError('provider_connection_timeout', 'The provider request was cancelled or timed out.');
    }
    throw error;
  } finally {
    lifecycle.dispose();
    activeRequests.delete(controller);
    req.removeListener('aborted', onClientClose);
    res.removeListener('close', onClientClose);
  }
}

function prepareResponsesRequest({ requestBody, launch, history, previous, originalPreviousResponseId }) {
  const currentInput = normalizeInputItems(requestBody.input);
  const body = {
    ...requestBody,
    max_output_tokens: resolveMaxOutputTokens(launch.maxOutputTokens, requestBody.max_output_tokens)
  };
  if (!previous?.continuationRequired) {
    return { body, currentInput, replayed: false };
  }
  if (previous.replayUnavailableReason) {
    throw providerError('provider_responses_continuation_unrecoverable', previous.replayUnavailableReason);
  }
  const replayInput = buildReplayInput(history, originalPreviousResponseId);
  const instruction = buildContinuationInstruction();
  body.input = [...replayInput, ...currentInput, instruction];
  delete body.previous_response_id;
  logDebug('provider.responses.replay', {
    providerName: launch.providerName,
    model: body.model || launch.modelId,
    previousResponseId: originalPreviousResponseId,
    replayItemCount: replayInput.length,
    currentInputItemCount: currentInput.length
  });
  return { body, currentInput: [...currentInput, instruction], replayed: true };
}

function rememberResponse(history, { response, previous, previousResponseId, currentInput, replayed }) {
  const responseId = String(response.id || '');
  if (!responseId) return;
  const outputItems = Array.isArray(response.output) ? response.output : [];
  const metrics = inspectOutput(response, outputItems);
  const incompleteReason = String(response.incomplete_details?.reason || '');
  const continuationRequired = ['max_output_tokens', 'max_tokens', 'length'].includes(incompleteReason)
    || (response.status !== 'incomplete' && metrics.hasReasoning && metrics.contentChars === 0 && metrics.toolCallCount === 0);
  const duplicate = replayed && previous
    ? outputsRepeat(previous.metrics.normalizedOutput, metrics.normalizedOutput)
    : false;
  const duplicateContinuations = duplicate
    ? (Number(previous?.duplicateContinuations) || 0) + 1
    : 0;
  const serializedBytes = serializedSize(currentInput) + serializedSize(outputItems);
  const replayUnavailableReason = outputItems.length > MAX_HISTORY_ITEMS || serializedBytes > MAX_HISTORY_BYTES
    ? 'The unfinished provider response is too large to replay safely.'
    : '';
  history.delete(responseId);
  history.set(responseId, {
    responseId,
    previousResponseId,
    requestInput: currentInput,
    outputItems,
    status: String(response.status || ''),
    incompleteReason: String(response.incomplete_details?.reason || ''),
    continuationRequired,
    duplicateContinuations,
    replayUnavailableReason,
    metrics,
    serializedBytes,
    createdAt: Date.now()
  });
  pruneHistory(history);
}

function buildReplayInput(history, responseId) {
  const chain = [];
  const visited = new Set();
  let currentId = String(responseId || '');
  while (currentId) {
    if (visited.has(currentId)) {
      throw providerError('provider_responses_continuation_unrecoverable', 'The provider response lineage contains a cycle.');
    }
    visited.add(currentId);
    const entry = history.get(currentId);
    if (!entry) {
      throw providerError(
        'provider_responses_continuation_unrecoverable',
        'The unfinished provider response no longer has enough local history to continue safely.'
      );
    }
    chain.unshift(entry);
    currentId = String(entry.previousResponseId || '');
    if (chain.length > MAX_HISTORY_ENTRIES) {
      throw providerError('provider_continuation_history_limit', 'The provider continuation history is too long to replay safely.');
    }
  }
  const items = [];
  let bytes = 0;
  for (const entry of chain) {
    items.push(...entry.requestInput, ...entry.outputItems);
    bytes += entry.serializedBytes;
    if (items.length > MAX_HISTORY_ITEMS || bytes > MAX_HISTORY_BYTES) {
      throw providerError('provider_continuation_history_limit', 'The provider continuation history is too large to replay safely.');
    }
  }
  return items;
}

function inspectOutput(response, outputItems) {
  const reasoningParts = [];
  const contentParts = [];
  const toolParts = [];
  let hasReasoning = false;
  for (const item of outputItems) {
    const type = String(item?.type || '');
    if (type === 'reasoning') {
      hasReasoning = true;
      collectTextParts(item.summary, reasoningParts);
      collectTextParts(item.content, reasoningParts);
    } else if (type === 'message') {
      collectTextParts(item.content, contentParts);
    } else if (type === 'function_call' || type === 'custom_tool_call' || type === 'computer_call') {
      toolParts.push([type, item.name, item.call_id, item.arguments, item.input].filter(Boolean).join(':'));
    }
  }
  if (typeof response.output_text === 'string') contentParts.push(response.output_text);
  const reasoningText = reasoningParts.join('\n');
  const contentText = contentParts.join('\n');
  const normalizedOutput = normalizeComparableText([reasoningText, contentText, ...toolParts].join('\n'));
  return {
    hasReasoning,
    reasoningChars: reasoningText.length,
    contentChars: contentText.length,
    toolCallCount: toolParts.length,
    normalizedOutput,
    outputFingerprint: normalizedOutput
      ? crypto.createHash('sha256').update(normalizedOutput).digest('hex').slice(0, 16)
      : ''
  };
}

function collectTextParts(value, target) {
  if (!Array.isArray(value)) return;
  for (const part of value) {
    const text = typeof part === 'string' ? part : part?.text;
    if (typeof text === 'string' && text) target.push(text);
  }
}

function outputsRepeat(previous, current) {
  if (!previous || !current) return false;
  return previous === current;
}

function normalizeComparableText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeInputItems(value) {
  if (Array.isArray(value)) return value.slice();
  if (typeof value === 'string') {
    return [{ role: 'user', content: [{ type: 'input_text', text: value }] }];
  }
  return value && typeof value === 'object' ? [value] : [];
}

function buildContinuationInstruction() {
  return {
    role: 'user',
    content: [{
      type: 'input_text',
      text: [
        CONTINUATION_MARKER,
        'The preceding response output is established work from this same unfinished task.',
        'Continue from the exact point where it stopped.',
        'Do not restart the analysis, reread files already covered, or repeat conclusions already produced.',
        'Proceed to the next tool call or final answer as soon as the remaining reasoning is complete.'
      ].join('\n')
    }]
  };
}

function resolveMaxOutputTokens(configured, requested) {
  const value = Number(configured ?? requested ?? DEFAULT_MAX_OUTPUT_TOKENS);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_OUTPUT_TOKENS;
  return Math.max(1, Math.floor(value));
}

async function forwardResponsesSse(upstream, res, onActivity, apiKey) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive'
  });
  if (!upstream.body) {
    throw providerError('provider_response_invalid', 'The provider returned an empty Responses stream.');
  }
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const observer = { buffer: '', position: 0, lineStart: 0, terminalResponse: null };
  const forward = frame => {
    const safeFrame = inspectSseFrame(observer, frame, apiKey);
    if (!res.writableEnded) res.write(safeFrame);
  };
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity();
      forwardSseText(observer, decoder.decode(value, { stream: true }), forward);
    }
    forwardSseText(observer, decoder.decode(), forward, true);
    complete = true;
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!res.writableEnded) res.end();
  return observer.terminalResponse;
}

function forwardSseText(observer, text, forward, flush = false) {
  observer.buffer += text;
  // Hold each event until its diagnostics can be inspected. Line endings and
  // successful frames remain intact, including CRLF split across HTTP chunks.
  while (observer.position < observer.buffer.length) {
    const position = observer.position;
    const char = observer.buffer[position];
    if (char !== '\r' && char !== '\n') { observer.position += 1; continue; }
    if (char === '\r' && position + 1 === observer.buffer.length && !flush) break;
    const end = position + (char === '\r' && observer.buffer[position + 1] === '\n' ? 2 : 1);
    if (position === observer.lineStart) {
      forward(observer.buffer.slice(0, end));
      observer.buffer = observer.buffer.slice(end);
      observer.position = observer.lineStart = 0;
    } else {
      observer.position = observer.lineStart = end;
    }
  }
  if (Buffer.byteLength(observer.buffer, 'utf8') > MAX_STREAM_BUFFER_BYTES) {
    throw providerError('provider_stream_frame_too_large', 'Provider stream frame exceeded the local bridge limit.');
  }
  if (flush && observer.buffer.trim()) {
    forward(observer.buffer);
    observer.buffer = '';
  }
}

function inspectSseFrame(observer, frame, apiKey) {
  if (Buffer.byteLength(frame, 'utf8') > MAX_STREAM_BUFFER_BYTES) {
    throw providerError('provider_stream_frame_too_large', 'Provider stream frame exceeded the local bridge limit.');
  }
  const parts = frame.split(/(\r\n|\r|\n)/);
  const dataIndexes = [];
  let event = '';
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index].replace(/^\uFEFF/, '');
    if (/^data(?::|$)/.test(line)) dataIndexes.push(index);
    if (line.startsWith('event:')) event = line.slice(6).replace(/^ /, '');
  }
  const failedEvent = ['error', 'response.failed', 'response.error'].includes(event);
  if (!dataIndexes.length && !failedEvent) return frame;
  const data = dataIndexes.map(index => parts[index].replace(/^\uFEFF/, '').replace(/^data:? ?/, '')).join('\n');
  if ((!data || data === '[DONE]') && !failedEvent) return frame;
  let payload;
  try {
    payload = JSON.parse(data);
  } catch (_error) {
    throw providerError('provider_response_invalid', 'The provider returned an invalid Responses stream event.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw providerError('provider_response_invalid', 'The provider returned an invalid Responses stream event.');
  }
  const changed = sanitizeProtocolErrors(payload, apiKey, failedEvent || hasDuplicateJsonKeys(data));
  if (['response.completed', 'response.incomplete', 'response.failed'].includes(payload.type || event) && payload.response) {
    observer.terminalResponse = payload.response;
  }
  if (!changed) return frame;
  parts[dataIndexes[0]] = `data: ${JSON.stringify(payload)}`;
  for (const index of dataIndexes.slice(1)) parts[index] = parts[index + 1] = '';
  return parts.join('');
}

function sanitizeProtocolErrors(payload, apiKey, failedEvent = false) {
  let changed = false;
  const clean = value => {
    if (typeof value === 'string' && value) {
      const safe = sanitizeProviderMessage(value, [apiKey], MAX_ERROR_BYTES);
      changed ||= safe !== value;
      return safe;
    }
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) value[key] = clean(value[key]);
    }
    return value;
  };
  const visit = (value, inheritedFailure) => {
    if (!value || typeof value !== 'object') return;
    if (value.error != null) { changed = true; value.error = clean(value.error); }
    const failed = inheritedFailure || ['error', 'response.failed', 'response.error'].includes(value.type)
      || ['failed', 'error'].includes(value.status);
    if (failed) {
      // Re-encode failures even when the surviving values need no replacement:
      // duplicate JSON keys must not retain an earlier raw diagnostic value.
      changed = true;
      for (const key of ['message', 'code', 'param', 'detail', 'details', 'reason', 'description']) {
        if (value[key] != null) value[key] = clean(value[key]);
      }
    }
    // Response envelopes carry diagnostics; model output and tool arguments
    // retain their original protocol semantics, even if they resemble secrets.
    visit(value.response, failed);
  };
  visit(payload, failedEvent);
  return changed;
}

function hasDuplicateJsonKeys(text) {
  // Called only after JSON.parse succeeds. Track keys per object and skip
  // entire string values, including JSON-looking tool arguments. A duplicate
  // can hide both an error value and an earlier failed status, so its protocol
  // diagnostics require cleaning even when the surviving status is completed.
  const stack = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') stack.push({ keys: new Set(), expectsKey: true });
    else if (char === '[') stack.push(null);
    else if (char === '}' || char === ']') stack.pop();
    else if (char === ',' && stack.at(-1)) stack.at(-1).expectsKey = true;
    else if (char === '"') {
      let end = index;
      while (true) {
        end = text.indexOf('"', end + 1);
        let backslashes = 0;
        for (let at = end - 1; text[at] === '\\'; at -= 1) backslashes += 1;
        if (backslashes % 2 === 0) break;
      }
      const object = stack.at(-1);
      if (object?.expectsKey) {
        const key = JSON.parse(text.slice(index, end + 1));
        if (object.keys.has(key)) return true;
        object.keys.add(key);
        object.expectsKey = false;
      }
      index = end;
    }
  }
  return false;
}

async function forwardCompactResponse(upstream, res, onActivity, apiKey) {
  if (!upstream.body) {
    throw providerError('provider_response_invalid', 'The provider returned an empty compact response.');
  }
  const reader = upstream.body.getReader();
  const chunks = [];
  let bytes = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity();
      bytes += value.byteLength;
      if (bytes > MAX_COMPACT_RESPONSE_BYTES) {
        throw providerError('provider_response_too_large', 'The compact response exceeded the 32 MiB local bridge limit.');
      }
      chunks.push(Buffer.from(value));
    }
    complete = true;
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks, bytes);
  let text;
  let payload;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    payload = JSON.parse(text);
  } catch (_error) {
    throw providerError('provider_response_invalid', 'The provider returned an invalid compact JSON response.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw providerError('provider_response_invalid', 'The provider returned an invalid compact JSON response.');
  }
  const changed = sanitizeProtocolErrors(payload, apiKey, hasDuplicateJsonKeys(text));
  const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
  res.writeHead(upstream.status, { 'content-type': contentType, 'cache-control': 'no-store' });
  if (!res.writableEnded) res.end(changed ? JSON.stringify(payload) : body);
}

function buildResponsesUrl(baseUrl, launch = {}, route = 'responses') {
  const url = new URL(baseUrl);
  let pathname = url.pathname.replace(/\/+$/, '');
  if (launch.fullEndpoint) {
    if (route === 'compact' && /\/responses$/i.test(pathname)) {
      url.pathname = `${pathname}/compact`;
    }
  } else if (/\/responses(?:\/compact)?$/i.test(pathname)) {
    url.pathname = route === 'compact'
      ? pathname.replace(/\/responses(?:\/compact)?$/i, '/responses/compact')
      : pathname.replace(/\/responses(?:\/compact)?$/i, '/responses');
  } else {
    pathname = !pathname || pathname === '/' ? '/v1' : pathname;
    url.pathname = `${pathname}/responses${route === 'compact' ? '/compact' : ''}`;
  }
  if (!launch.fullEndpoint) {
    url.search = '';
    url.hash = '';
  }
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

async function forwardUpstreamError(upstream, res, apiKey) {
  const text = (await upstream.text()).slice(0, MAX_ERROR_BYTES);
  let message = `Provider returned HTTP ${upstream.status}.`;
  try {
    const parsed = JSON.parse(text);
    message = parsed?.error?.message || parsed?.message || message;
  } catch (_error) {}
  sendJsonError(res, upstream.status, 'provider_upstream_error', sanitizeProviderMessage(message, [apiKey]));
}

function pruneHistory(history) {
  while (history.size > MAX_HISTORY_ENTRIES || historyBytes(history) > MAX_HISTORY_BYTES) {
    history.delete(history.keys().next().value);
  }
}

function historyBytes(history) {
  let total = 0;
  for (const entry of history.values()) total += Number(entry.serializedBytes) || 0;
  return total;
}

function serializedSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch (_error) {
    return MAX_HISTORY_BYTES + 1;
  }
}

function normalizeBridgeErrorCode(value) {
  return [
    'provider_connection_timeout',
    'provider_response_invalid',
    'provider_response_too_large',
    'provider_protocol_incompatible',
    'provider_request_invalid',
    'provider_request_too_large',
    'provider_responses_continuation_repeated',
    'provider_responses_continuation_unrecoverable',
    'provider_continuation_history_limit'
  ].includes(value) ? value : 'provider_bridge_failed';
}

function bridgeErrorMessage(code) {
  return code === 'provider_connection_timeout'
    ? 'The provider request was cancelled or timed out.'
    : 'The local Responses bridge failed.';
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

module.exports = {
  buildResponsesUrl,
  startResponsesPassthroughBridge
};
