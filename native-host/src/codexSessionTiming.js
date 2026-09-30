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

function rejectPendingRequests(pending, error) {
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
}

async function stopCodexAppServer(child, {
  interrupt, reason, processGroup = false, platform = process.platform,
  interruptTimeoutMs = 1500, terminateTimeoutMs = 500, forceTimeoutMs = 1500,
  kill = process.kill.bind(process), taskkill = defaultTaskkill
} = {}) {
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return;
  const grouped = processGroup && platform !== 'win32';
  const exited = () => child.exitCode != null || child.signalCode != null;
  const groupGone = () => {
    if (!grouped) return true;
    try { kill(-pid, 0); return false; } catch (error) { return error?.code === 'ESRCH'; }
  };
  const stopped = () => exited() && groupGone();
  const waitForStop = async timeoutMs => {
    const deadline = Date.now() + timeoutMs;
    while (!stopped() && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))));
    }
    return stopped();
  };
  const signal = value => {
    if (grouped) {
      try { kill(-pid, value); return; } catch (_error) { /* fall back to the owned child */ }
    }
    if (!exited()) {
      try { child.kill(value); } catch (_error) { /* the exit check remains authoritative */ }
    }
  };
  if (stopped()) return;
  if (!exited() && typeof interrupt === 'function') {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(interrupt).catch(() => {}),
        new Promise(resolve => { timer = setTimeout(resolve, interruptTimeoutMs); })
      ]);
    } finally { clearTimeout(timer); }
  }
  if (platform === 'win32') {
    if (!exited()) await taskkill(pid, forceTimeoutMs).catch(() => {});
  } else {
    signal('SIGTERM');
    if (await waitForStop(terminateTimeoutMs)) return;
    signal('SIGKILL');
  }
  if (!await waitForStop(forceTimeoutMs)) {
    const error = new Error('Codex process exit could not be confirmed. Do not retry this project until the old process has stopped.');
    error.code = 'codex_process_stop_unconfirmed';
    error.processId = pid;
    error.processGroup = grouped;
    error.isStopped = stopped;
    error.cause = reason;
    throw error;
  }
}

function defaultTaskkill(pid, timeout) {
  return new Promise((resolve, reject) => {
    require('node:child_process').execFile('taskkill', ['/pid', String(pid), '/t', '/f'],
      { windowsHide: true, timeout }, error => error ? reject(error) : resolve());
  });
}

module.exports = {
  createCodexIdleWatchdog,
  createOptionalTimeout,
  getAbortReason,
  parseOptionalPositiveInteger,
  rejectPendingRequests,
  stopCodexAppServer,
  throwIfAborted
};
