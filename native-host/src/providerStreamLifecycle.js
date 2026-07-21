'use strict';

const DEFAULT_IDLE_TIMEOUT_MS = 120000;
const DEFAULT_TOTAL_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TOTAL_TIMEOUT_MS = 60 * 60 * 1000;

function createProviderStreamLifecycle({
  controller,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
  onAbort = () => {}
} = {}) {
  if (!controller?.signal || typeof controller.abort !== 'function') {
    throw new TypeError('A provider stream lifecycle requires an AbortController.');
  }
  let idleTimeout = null;
  let totalTimeout = null;
  let abortReason = '';
  let started = false;
  let finished = false;

  const clearTimers = () => {
    clearTimeout(idleTimeout);
    clearTimeout(totalTimeout);
    idleTimeout = null;
    totalTimeout = null;
  };
  const abort = reason => {
    if (finished || controller.signal.aborted) return;
    abortReason = String(reason || 'cancelled');
    onAbort(abortReason);
    clearTimers();
    controller.abort();
  };
  const touch = () => {
    if (finished || controller.signal.aborted) return;
    clearTimeout(idleTimeout);
    idleTimeout = setTimeout(() => abort('idle_timeout'), idleTimeoutMs);
    idleTimeout.unref?.();
  };
  const start = () => {
    if (started || finished || controller.signal.aborted) return;
    started = true;
    touch();
    totalTimeout = setTimeout(() => abort('total_timeout'), totalTimeoutMs);
    totalTimeout.unref?.();
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimers();
  };
  const recoverInterrupted = error => {
    if (abortReason === 'idle_timeout' || abortReason === 'total_timeout') return abortReason;
    if (abortReason) return '';
    return isTransportInterruption(error) ? 'transport_interrupted' : '';
  };

  return {
    abort,
    dispose: finish,
    finish,
    recoverInterrupted,
    start,
    touch,
    get abortReason() { return abortReason; }
  };
}

function resolveProviderIdleTimeoutMs(launch = {}) {
  const configured = Number(launch.requestTimeoutMs);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_IDLE_TIMEOUT_MS;
  return Math.min(MAX_IDLE_TIMEOUT_MS, Math.max(5000, Math.floor(configured)));
}

function resolveProviderTotalTimeoutMs(launch = {}, idleTimeoutMs = resolveProviderIdleTimeoutMs(launch)) {
  const configured = Number(launch.totalRequestTimeoutMs);
  const requested = Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_TOTAL_TIMEOUT_MS;
  return Math.min(MAX_TOTAL_TIMEOUT_MS, Math.max(requested, idleTimeoutMs * 2));
}

function isTransportInterruption(error) {
  const code = String(error?.cause?.code || error?.code || '').toUpperCase();
  if (['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return true;
  const message = String(error?.message || '').toLowerCase();
  return error?.name === 'AbortError'
    || message.includes('fetch failed')
    || message.includes('terminated')
    || message.includes('socket')
    || message.includes('connection reset');
}

module.exports = {
  createProviderStreamLifecycle,
  resolveProviderIdleTimeoutMs,
  resolveProviderTotalTimeoutMs
};
