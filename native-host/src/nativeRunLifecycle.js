'use strict';

const processStopBarrier = require('./processStopBarrier');
const { logDebug } = require('./debugLog');
const active = new Set();
let closingError;

// Shutdown ownership is independent of RPC ids: absent/reused ids must not
// hide a live run from transport shutdown or its durable quarantine.
function register({ controller, projectKey, rootDir }) {
  let resolveDone;
  const entry = { controller, projectKey, rootDir, processes: [], done: new Promise(resolve => { resolveDone = resolve; }) };
  active.add(entry);
  if (closingError) controller.abort(closingError);
  return {
    trackProcess(identity) {
      if (!Number.isInteger(identity?.processId) || identity.processId <= 0) return;
      entry.processes.push(identity);
      if (closingError) quarantine(entry, identity);
    },
    complete() {
      active.delete(entry);
      try {
        if (entry.processes.some(identity => identity.quarantined)) processStopBarrier.isBlocked(projectKey, rootDir);
      } catch (error) { logDebug('native_transport.quarantine_cleanup_failed', { projectKey, message: error.message }); }
      finally { resolveDone(); }
    }
  };
}

function abortAllActiveOperations(reason = 'Native messaging transport disconnected.') {
  closingError = new Error(String(reason || 'Native messaging transport disconnected.'));
  closingError.code = 'native_transport_closed';
  const entries = Array.from(active);
  for (const entry of entries) {
    if (!entry.controller.signal.aborted) entry.controller.abort(closingError);
  }
  return Promise.all(entries.map(entry => entry.done));
}

function quarantineActiveOperations() {
  const failures = [];
  for (const entry of active) {
    // A preparing run has no process to quarantine. Its aborted signal is
    // checked again after provider preparation and immediately before spawn.
    for (const identity of entry.processes) {
      const failure = quarantine(entry, identity);
      if (failure) failures.push(failure);
    }
  }
  return failures;
}

function quarantine(entry, identity) {
  if (identity.quarantined) return null;
  const error = Object.assign(new Error('Native transport closed before run settlement.'), identity, {
    code: 'codex_process_stop_unconfirmed'
  });
  try {
    processStopBarrier.record(entry.projectKey, entry.rootDir, error);
    if (error.stopBarrierPersistenceError) throw new Error(error.stopBarrierPersistenceError);
    identity.quarantined = true;
    return null;
  } catch (failure) {
    const detail = { projectKey: entry.projectKey, message: failure.message };
    logDebug('native_transport.quarantine_failed', detail);
    return detail;
  }
}

module.exports = { register, abortAllActiveOperations, quarantineActiveOperations };
