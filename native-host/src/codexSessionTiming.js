'use strict';

function createOptionalTimeout(value, onTimeout) {
  const timeoutMs = parseOptionalPositiveInteger(value);
  if (!timeoutMs) return { cancel() {} };
  const timer = setTimeout(() => onTimeout(timeoutMs), timeoutMs);
  return { cancel: () => clearTimeout(timer) };
}

function createCodexIdleWatchdog(idleMs, onIdle) {
  if (!(idleMs > 0)) return { reset() {}, cancel() {} };
  let timer = setTimeout(() => onIdle(idleMs), idleMs);
  return {
    reset() {
      clearTimeout(timer);
      timer = setTimeout(() => onIdle(idleMs), idleMs);
    },
    cancel: () => clearTimeout(timer)
  };
}

function parseOptionalPositiveInteger(value) {
  if (value === undefined || value === null || value === '') return 0;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function getAbortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Codex run was cancelled by the user');
  error.code = 'codex_cancelled';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw getAbortReason(signal);
}

module.exports = {
  createCodexIdleWatchdog,
  createOptionalTimeout,
  getAbortReason,
  parseOptionalPositiveInteger,
  throwIfAborted
};
