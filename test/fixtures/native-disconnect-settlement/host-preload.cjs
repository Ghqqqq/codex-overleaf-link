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
  return originalStop(child, options).then(value => {
    record('stop', { event: 'resolved', pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode });
    return value;
  }, error => {
    record('stop', { event: 'rejected', pid: child.pid, code: error.code });
    throw error;
  });
};
const runtime = require(native('taskRunnerRuntime'));
process.on('exit', code => record('host-exit', { pid: process.pid, code, work: runtime.getActiveNativeWorkState() }));
setTimeout(() => process.exit(93), 12000).unref();
