#!/usr/bin/env node
'use strict';

const { decodeInputFrames, encodeOutputFrame } = require('./nativeTransportEnvelope');
const { logDebug } = require('./debugLog');
const { handleRequest } = require('./taskRunner');
const { abortAllActiveOperations, quarantineActiveOperations, getActiveNativeWorkState } = require('./taskRunnerRuntime');
const { handleUpdateRequest, isUpdateMethod, assertBootstrapBusinessAvailable } = require('./updateManager');
const { buildNativeRuntimeEnv, summarizeNativeEnvironment } = require('./nativeEnvironment');

let buffered = Buffer.alloc(0);
let stdoutUnavailable = false;
let nativeDisconnectHandled = false;
let fatalShutdownStarted = false;
const FATAL_SHUTDOWN_TIMEOUT_MS = 3000;
const runtimeEnv = buildNativeRuntimeEnv(process.env);
Object.assign(process.env, runtimeEnv);
logDebug('environment.ready', summarizeNativeEnvironment(runtimeEnv));

process.stdin.on('data', chunk => {
  logDebug('stdin.data', { bytes: chunk.length, bufferedBytes: buffered.length });
  buffered = Buffer.concat([buffered, chunk]);

  let decoded;
  try {
    decoded = decodeInputFrames(buffered);
  } catch (error) {
    writeResponse({
      ok: false,
      error: {
        code: 'invalid_native_message',
        message: error.message
      }
    });
    buffered = Buffer.alloc(0);
    return;
  }

  buffered = decoded.remainder;
  for (const message of decoded.messages) {
    handleDecodedMessage(message);
  }
});

async function handleDecodedMessage(message) {
  if (nativeDisconnectHandled) return;
  try {
    logDebug('request.received', summarizeRequest(message));
    assertBootstrapBusinessAvailable(message, { env: runtimeEnv });
    const response = isUpdateMethod(message?.method)
      ? await handleUpdateRequest(message, {
          env: runtimeEnv,
          getWorkState: () => getActiveNativeWorkState(runtimeEnv)
        })
      : await handleRequest(message, runtimeEnv, event => {
      writeResponse({
        id: message?.id,
        ok: true,
        event
      });
      });
    logDebug('response.ready', summarizeResponse(response));
    writeResponse(response);
  } catch (error) {
    const response = {
      id: message?.id,
      ok: false,
      error: {
        code: /^[a-z0-9_]{1,80}$/.test(String(error?.code || '')) ? error.code : 'internal_error',
        message: error.message
      }
    };
    logDebug('response.internal_error', summarizeResponse(response));
    writeResponse(response);
  }
}

process.stdin.on('error', error => {
  logDebug('stdin.error', { message: error.message });
  handleNativeDisconnect('stdin_error', error);
});
process.stdin.on('end', () => handleNativeDisconnect('stdin_end'));
process.stdin.on('close', () => handleNativeDisconnect('stdin_close'));

process.stdout.on('error', error => {
  if (isExpectedNativeDisconnect(error)) {
    handleNativeDisconnect('stdout_disconnected', error);
    return;
  }
  logDebug('stdout.error', { code: error.code, message: error.message, stack: error.stack });
});

process.on('uncaughtException', error => {
  if (isExpectedNativeDisconnect(error)) {
    handleNativeDisconnect('uncaught_native_disconnect', error);
    return;
  }
  handleFatalError('process.uncaught_exception', error);
});

process.on('unhandledRejection', reason => {
  handleFatalError('process.unhandled_rejection', reason);
});

function handleFatalError(event, error) {
  if (fatalShutdownStarted) {
    process.exit(1);
    return;
  }
  fatalShutdownStarted = true;
  nativeDisconnectHandled = true;
  stdoutUnavailable = true;
  process.exitCode = 1;
  logDebug(event, { message: error?.message || String(error), stack: error?.stack });
  const exitTimer = setTimeout(() => {
    const failures = quarantineActiveOperations();
    logDebug('process.fatal_shutdown_deadline', { persistenceFailures: failures });
    process.exit(1);
  }, FATAL_SHUTDOWN_TIMEOUT_MS);
  try {
    // Persist protection before aborting; stop confirmation owns its removal.
    quarantineActiveOperations();
    Promise.resolve(abortAllActiveOperations('Native Host stopped after a fatal error.')).then(() => {
      clearTimeout(exitTimer);
      process.exit(1);
    }, failure => {
      logDebug('process.fatal_shutdown_failed', { message: failure?.message });
      clearTimeout(exitTimer);
      process.exit(1);
    });
  } catch (failure) {
    logDebug('process.fatal_shutdown_failed', { message: failure?.message });
    clearTimeout(exitTimer);
    process.exit(1);
  }
}

function writeResponse(response) {
  if (stdoutUnavailable || process.stdout.destroyed || process.stdout.writableEnded) {
    logDebug('stdout.write_skipped', { ok: response?.ok, code: response?.error?.code });
    return false;
  }
  const frame = encodeOutputFrame(response);
  logDebug('stdout.write', { bytes: frame.length, ok: response?.ok, code: response?.error?.code });
  try {
    process.stdout.write(frame, error => {
      if (!error) return;
      if (isExpectedNativeDisconnect(error)) {
        handleNativeDisconnect('stdout_write_disconnected', error);
        return;
      }
      logDebug('stdout.write_failed', { code: error.code, message: error.message });
    });
    return true;
  } catch (error) {
    if (isExpectedNativeDisconnect(error)) {
      handleNativeDisconnect('stdout_write_disconnected', error);
      return false;
    }
    throw error;
  }
}

function isExpectedNativeDisconnect(error) {
  return ['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'].includes(String(error?.code || ''));
}

function handleNativeDisconnect(source, error) {
  if (nativeDisconnectHandled) return;
  nativeDisconnectHandled = true;
  stdoutUnavailable = true;
  logDebug('native_transport.disconnected', {
    source,
    code: error?.code,
    message: error?.message
  });
  process.exitCode = 0;
  // Publish protection before stopping: another Host may reconnect while the
  // old owned process is still inside its interrupt/termination budget.
  quarantineActiveOperations();
  const exitTimer = setTimeout(() => {
    if (fatalShutdownStarted) return;
    const failures = quarantineActiveOperations();
    logDebug('native_transport.shutdown_deadline', { persistenceFailures: failures });
    process.exit(failures.length ? 1 : 0);
  }, 5000);
  // Keep the prior grace for other entry points while owned Codex runs drain.
  Promise.all([
    abortAllActiveOperations('Native messaging transport disconnected.'),
    new Promise(resolve => setTimeout(resolve, 1500))
  ]).then(() => {
    clearTimeout(exitTimer);
    if (!fatalShutdownStarted) process.exit(0);
  });
}

function summarizeRequest(message) {
  const params = message?.params || {};
  return {
    id: message?.id,
    method: message?.method,
    mode: params.mode,
    model: params.model,
    reasoningEffort: params.reasoningEffort,
    taskLength: String(params.task || '').length,
    reviewingOk: params.reviewing?.ok,
    checkpointOk: params.checkpoint?.ok,
    activePath: params.project?.activePath,
    fileCount: Array.isArray(params.project?.files) ? params.project.files.length : 0,
    fileSummary: summarizeProjectFiles(params.project?.files)
  };
}

function summarizeProjectFiles(files) {
  return (Array.isArray(files) ? files : []).slice(0, 50).map(file => ({
    path: file?.path,
    kind: file?.kind || (file?.contentBase64 ? 'binary' : 'text'),
    size: Number(file?.size || file?.byteLength || 0) || stringByteLength(file?.content)
  }));
}

function stringByteLength(value) {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
}

function summarizeResponse(response) {
  return {
    id: response?.id,
    ok: response?.ok,
    code: response?.error?.code,
    message: response?.error?.message,
    status: response?.result?.status,
    operationCount: Array.isArray(response?.result?.operations) ? response.result.operations.length : 0,
    hasDeletePlan: Boolean(response?.result?.deletePlan),
    hasPlanId: Boolean(response?.result?.planId)
  };
}
