'use strict';

// Discovery and diagnostics are external fixture boundaries. The real index,
// runtime cancellation, runner, stop implementation and barrier remain active.
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.CODEX_TEST_DISCONNECT_ROOT;
const repo = process.env.CODEX_TEST_REPOSITORY_ROOT;
if (!root || !repo || !path.isAbsolute(root) || !path.isAbsolute(repo)) throw new Error('Missing isolated paths');
const native = name => path.join(repo, 'native-host/src', name);
const record = (name, value) => fs.appendFileSync(path.join(root, name + '.jsonl'), JSON.stringify({ at: Date.now(), ...value }) + '\n');
const childProcess = require('node:child_process');
const originalExecFile = childProcess.execFile;
childProcess.execFile = function(command, args, options, callback) {
  if (!/^taskkill(?:\.exe)?$/i.test(path.win32.basename(String(command)))) return originalExecFile.apply(this, arguments);
  record('taskkill', { event: 'started', command, args });
  return originalExecFile.call(this, command, args, options, (error, stdout, stderr) => {
    record('taskkill', { event: 'finished', code: error?.code ?? null, killed: error?.killed ?? false,
      signal: error?.signal ?? null, stdout: String(stdout || '').slice(0, 4096), stderr: String(stderr || '').slice(0, 4096) });
    callback(error, stdout, stderr);
  });
};
const debug = require(native('debugLog'));
const originalLog = debug.logDebug;
debug.logDebug = (event, detail) => originalLog(event, detail, { homeDir: root });
const environment = require(native('nativeEnvironment'));
environment.buildNativeRuntimeEnv = env => ({ ...env });
environment.refreshCodexRuntimeEnv = env => ({ ...env });
globalThis.fetch = async () => { throw new Error('Fixture forbids network'); };
const timing = require(native('codexSessionTiming'));
const originalStop = timing.stopCodexAppServer;
timing.stopCodexAppServer = (child, options) => {
  record('stop', { event: 'started', pid: child.pid, reason: options.reason?.code });
  if (process.env.CODEX_TEST_DISCONNECT_MODE === 'stalled-stop') {
    options.interrupt?.().catch(() => {});
    return new Promise(() => {}); // Inject a stalled lower-level stop after real abort.
  }
  return originalStop(child, options).then(value => {
    record('stop', { event: 'resolved', pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode });
    return value;
  }, error => {
    record('stop', { event: 'rejected', pid: child.pid, code: error.code });
    throw error;
  });
};
const barrier = require(native('processStopBarrier'));
const originalRecord = barrier.record;
barrier.record = (...args) => { record('barrier', { event: 'called', code: args[2]?.code }); return originalRecord(...args); };
const runtime = require(native('taskRunnerRuntime'));
process.on('exit', code => record('host-exit', { pid: process.pid, code, work: runtime.getActiveNativeWorkState() }));
setTimeout(() => process.exit(93), 12000).unref();
