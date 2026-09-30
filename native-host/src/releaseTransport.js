'use strict';

const { updateError } = require('./updateTrust');
const { fetchRelease } = require('./releaseProxy');

const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504]);
const CERTIFICATE_ERRORS = /CERT|TLS_CERT|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/;

function abortable(promise, signal) {
  if (signal.aborted) {
    void Promise.resolve(promise).catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function terminalError(code, message) {
  return Object.assign(updateError(code, message), { retryable: false });
}

async function readBoundedBody(response, limit, signal, onProgress = () => {}) {
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared > limit) throw terminalError('update_download_limit', 'Update response exceeds its size limit.');
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = Buffer.from(await abortable(response.arrayBuffer(), signal));
    if (!bytes.length || bytes.length > limit) throw terminalError('update_download_limit', 'Update response exceeds its size limit.');
    return bytes;
  }
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      const bytes = Buffer.from(chunk.value);
      length += bytes.length;
      if (bytes.length) onProgress();
      if (length > limit) throw terminalError('update_download_limit', 'Update response exceeds its size limit.');
      chunks.push(bytes);
    }
    if (!length) throw terminalError('update_download_limit', 'Update response is empty.');
    return Buffer.concat(chunks, length);
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function networkFailure(error, signal, callerSignal) {
  let cause = error;
  for (let depth = 0; depth < 8 && cause?.cause && cause.cause !== cause; depth += 1) cause = cause.cause;
  const reason = String(typeof cause?.code === 'string' ? cause.code : cause?.name || error?.name || 'network_error');
  if (callerSignal?.aborted) return { code: 'update_network_cancelled', reason: 'cancelled', retryable: false };
  if (error?.retryable === false) return { code: error.code || 'update_network_failed', reason, retryable: false };
  if (CERTIFICATE_ERRORS.test(reason)) return { code: 'update_network_certificate', reason, retryable: false };
  if (signal.aborted || /TIMEOUT|Timeout|AbortError/.test(reason)) {
    return { code: 'update_network_timeout', reason, retryable: true };
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(reason)) return { code: 'update_network_dns', reason, retryable: true };
  return { code: /^update_[a-z0-9_]+$/.test(error?.code || '') ? error.code : 'update_network_failed',
    reason, retryable: error?.retryable !== false };
}

function retryDelay(response, fallback) {
  const value = response?.headers?.get?.('retry-after');
  if (!value) return fallback;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(fallback, delay, 0) : fallback;
}

function delay(milliseconds, signal) {
  if (!milliseconds) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

async function requestRelease(url, options = {}) {
  const started = Date.now();
  const deadline = options.deadlineAt || started + (options.totalTimeoutMs ?? 45000);
  const maxAttempts = Math.max(1, Math.min(5, options.maxAttempts ?? 3));
  const host = new URL(url).hostname;
  let failure;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const controller = new AbortController();
    const timeout = () => controller.abort(new DOMException('Update request timed out.', 'TimeoutError'));
    const totalTimer = setTimeout(timeout, remaining);
    let phaseTimer = setTimeout(timeout, Math.min(remaining, options.timeoutMs ?? 12000));
    const receivedBytes = () => {
      clearTimeout(phaseTimer);
      phaseTimer = setTimeout(timeout, Math.min(Math.max(1, deadline - Date.now()),
        options.idleTimeoutMs ?? options.timeoutMs ?? 12000));
    };
    const cancel = () => controller.abort(options.signal.reason);
    if (options.signal?.aborted) cancel();
    else options.signal?.addEventListener('abort', cancel, { once: true });
    let response;
    let retryAfter = 0;
    try {
      const fetchImpl = options.fetch || ((value, init) => fetchRelease(value, init, options));
      response = await abortable(fetchImpl(url, {
        method: options.method || 'GET', headers: options.headers,
        redirect: 'follow', signal: controller.signal
      }), controller.signal);
      receivedBytes();
      const finalUrl = new URL(response.url || url);
      if (options.allowedHosts && (finalUrl.protocol !== 'https:' || !options.allowedHosts.has(finalUrl.hostname))) {
        throw terminalError('update_asset_redirect_forbidden', 'Release request redirected to an untrusted host.');
      }
      if (!response.ok && response.status !== 304) {
        throw Object.assign(updateError(options.httpErrorCode || 'update_asset_http_error',
          'Update request failed with HTTP ' + response.status + '.'), { retryable: RETRYABLE_HTTP.has(response.status) });
      }
      const bytes = options.method === 'HEAD' || response.status === 304
        ? null : await readBoundedBody(response, options.limit ?? 32 * 1024 * 1024, controller.signal, receivedBytes);
      return { ok: response.ok, status: response.status, url: finalUrl.href, headers: response.headers,
        bytes, attempts: attempt, elapsedMs: Date.now() - started };
    } catch (error) {
      const classified = networkFailure(error, controller.signal, options.signal);
      const diagnostics = { stage: options.stage || 'download', host, attempt,
        elapsedMs: Date.now() - started, reason: classified.reason, retryable: classified.retryable,
        ...(response ? { httpStatus: response.status } : {}) };
      const description = classified.code === 'update_network_timeout' ? 'Connection or download timed out'
        : classified.code === 'update_network_dns' ? 'DNS lookup failed'
          : classified.code === 'update_network_certificate' ? 'TLS certificate verification failed'
            : classified.code === 'update_network_cancelled' ? 'Update request was cancelled'
              : error?.retryable === false ? error.message : 'Network request failed';
      const reason = response ? 'HTTP ' + response.status
        : /^[A-Z][A-Z0-9_]{1,79}$/.test(classified.reason) ? classified.reason : '';
      failure = updateError(classified.code,
        description.replace(/\.$/, '') + ' (' + diagnostics.stage + ', ' + host + ', attempt ' + attempt +
          (reason ? ', ' + reason : '') + ', ' + (diagnostics.elapsedMs / 1000).toFixed(1) + 's).',
        { cause: error, network: diagnostics });
      try { options.onDiagnostic?.(diagnostics); } catch (_error) { /* diagnostics are best effort */ }
      if (!classified.retryable || attempt === maxAttempts) throw failure;
      retryAfter = retryDelay(response, (options.delayMs ?? 500) * attempt);
    } finally {
      clearTimeout(totalTimer);
      clearTimeout(phaseTimer);
      options.signal?.removeEventListener('abort', cancel);
      controller.abort();
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
    if (Date.now() + retryAfter >= deadline) break;
    await delay(retryAfter, options.signal);
  }
  throw failure || updateError('update_network_timeout', 'The update network time budget was exhausted.');
}

module.exports = { requestRelease };
