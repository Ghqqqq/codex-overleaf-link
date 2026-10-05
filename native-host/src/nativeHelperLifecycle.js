'use strict';

const { register } = require('./nativeRunLifecycle');

// Helpers own no project mirror lock, but their preparation and process-stop
// promises must finish before the Host's transport shutdown can finish.
async function runOwnedNativeHelper(execute, signal) {
  const controller = new AbortController();
  const lifetime = register({ controller });
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    return await execute(controller.signal);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    lifetime.complete();
  }
}

module.exports = { runOwnedNativeHelper };
