'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');
const debugLog = require('../native-host/src/debugLog');
const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-terminal-log-'));
const originalLogDebug = debugLog.logDebug;
debugLog.logDebug = (event, detail) => originalLogDebug(event, detail, {
  homeDir: logRoot, platform: process.platform, env: {}
});
const { runCodexAppServerSession, runCodexSession } = require('../native-host/src/codexSessionRunner');
const { handleRequest, getActiveNativeWorkState } = require('../native-host/src/taskRunnerRuntime');
debugLog.logDebug = originalLogDebug;
test.after(() => fs.rmSync(logRoot, { recursive: true, force: true }));

function writeFixtureCommand(root) {
  const script = path.join(root, 'app-server.cjs');
  fs.copyFileSync(path.join(__dirname, 'fixtures/codex-terminal-app-server.cjs'), script);
  const command = path.join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  fs.writeFileSync(command, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/usr/bin/env node\nrequire(${JSON.stringify(script)});\n`, { mode: 0o755 });
  return command;
}

async function scenario(mode, fields, { explicitError = false, explicitErrorMessage = 'Synthetic explicit failure' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-terminal-'));
  const events = [];
  const workspacePath = path.join(root, 'workspace');
  const userHome = path.join(root, 'user-codex-home');
  fs.mkdirSync(workspacePath);
  fs.mkdirSync(userHome);
  const env = {
    HOME: root, USERPROFILE: root,
    PATH: path.dirname(process.execPath),
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}),
    CODEX_OVERLEAF_ENV_READY: '1', CODEX_OVERLEAF_CODEX_PATH: writeFixtureCommand(root),
    CODEX_OVERLEAF_USER_CODEX_HOME: userHome, CODEX_HOME: userHome,
    CODEX_OVERLEAF_CODEX_HOME: path.join(root, 'plugin-codex-home'),
    CODEX_OVERLEAF_SKILLS_ROOT: path.join(root, '.codex-overleaf', 'skills'),
    CODEX_OVERLEAF_WRITING_STYLE_ROOT: path.join(root, 'writing-styles'),
    CODEX_OVERLEAF_MIRROR_ROOT: path.join(root, 'mirrors'),
    CODEX_OVERLEAF_CODEX_TIMEOUT_MS: '12000', CODEX_OVERLEAF_CODEX_IDLE_TIMEOUT_MS: '12000',
    CODEX_TEST_TERMINAL_ROOT: root, CODEX_TEST_TERMINAL_MODE: mode,
    CODEX_TEST_TERMINAL_FIELDS: JSON.stringify(fields),
    CODEX_TEST_TERMINAL_EXPLICIT_ERROR: explicitError ? '1' : '0',
    CODEX_TEST_TERMINAL_ERROR_MESSAGE: explicitErrorMessage
  };
  const controller = new AbortController();
  const abortReason = Object.assign(new Error('Synthetic caller cancellation'), { code: 'codex_cancelled' });
  try {
    let result, error;
    try {
      result = mode === 'native'
        ? await handleRequest({ id: 'terminal-request', method: 'codex.run', params: {
          projectId: 'terminal-native-project', task: 'Synthetic worker', mode: 'auto',
          loadCodexLocalSkills: false, loadCodexOverleafSkills: false,
          project: { capabilities: { fullProjectSnapshot: true }, files: [{ path: 'main.tex', content: 'Original.\n' }] }
        } }, env, event => events.push(event))
        : mode === 'broker'
        ? await runCodexSession({ rootDir: path.join(root, 'mirrors'), env,
          params: { projectId: 'terminal-project', task: 'SYNTHETIC_TERMINAL_PARENT', mode: 'auto',
            loadCodexLocalSkills: false, loadCodexOverleafSkills: true,
            enabledCodexOverleafSkillIds: ['parallel-subagents'],
            project: { files: [{ path: 'main.tex', content: 'Original.\n' }] } },
          emit: event => events.push(event) })
        : await runCodexAppServerSession({ workspacePath, task: 'Synthetic worker', env,
          loadCodexLocalSkills: false, loadCodexOverleafSkills: false,
          signal: controller.signal,
          onControlReady: () => { if (mode === 'abort') controller.abort(abortReason); },
          emit: event => events.push(event) });
    } catch (caught) { error = caught; }
    const receipt = mode === 'broker' && result
      ? JSON.parse(fs.readFileSync(path.join(result.workspacePath, '.codex-overleaf-subagents/results/terminal-worker.json'), 'utf8')) : null;
    if (!fs.existsSync(path.join(root, 'pids.jsonl'))) throw error || new Error('Synthetic peer did not start');
    const pids = fs.readFileSync(path.join(root, 'pids.jsonl'), 'utf8').trim().split('\n').map(Number);
    if (mode === 'direct' && error) {
      assert.ok(pids.every(pid => !isAlive(pid)), 'terminal rejection waits for synthetic child exit');
    }
    return { result, error, receipt, events, abortReason };
  } finally {
    const pidFile = path.join(root, 'pids.jsonl');
    const pids = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim().split('\n').map(Number) : [];
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    const deadline = Date.now() + 2000;
    while (pids.some(isAlive) && Date.now() < deadline) await wait(10);
    const remaining = pids.filter(isAlive);
    for (const pid of remaining) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
    assert.deepEqual(remaining, [], 'fixture children exit during bounded cleanup');
  }
}

for (const status of ['failed', 'unexpected']) {
  test(`Native ${status} status stays failed when error text mentions cancellation`, { timeout: 15000 }, async () => {
    const { result } = await scenario('native', { status, error: { message: 'Synthetic operation was cancelled after another failure' } });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'codex_run_failed');
    assert.equal(result.result, undefined);
    assert.deepEqual(getActiveNativeWorkState(), { projectLocks: 0, runControllers: 0, activeTurnControls: 0 });
  });
}

test('Native legacy error notification keeps cancellation-message fallback', { timeout: 15000 }, async () => {
  const { result } = await scenario('native', { status: 'completed' }, {
    explicitError: true, explicitErrorMessage: 'Synthetic operation was cancelled'
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'codex_cancelled');
});

for (const [status, code] of [['completed', null], ['failed', 'codex_run_failed'], ['interrupted', 'codex_cancelled'], ['unexpected', 'codex_run_failed']]) {
  test(`Native request maps ${status} to its existing public outcome and releases activity`, { timeout: 15000 }, async () => {
    const { result, error } = await scenario('native', { status });
    assert.equal(error, undefined);
    assert.equal(result.id, 'terminal-request');
    assert.equal(result.ok, code === null);
    if (code) {
      assert.equal(result.error.code, code);
      assert.equal(result.result, undefined, 'failed/cancelled run must not expose sync changes');
    } else assert.deepEqual(result.result.syncChanges.map(change => change.path), ['main.tex']);
    assert.deepEqual(getActiveNativeWorkState(), { projectLocks: 0, runControllers: 0, activeTurnControls: 0 });
  });
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

for (const [name, fields] of [['completed', { status: 'completed', error: null }], ['legacy without status', {}]]) {
  test(`direct runner preserves successful ${name}`, { timeout: 15000 }, async () => {
    const { result, error } = await scenario('direct', fields);
    assert.equal(error, undefined);
    assert.equal(result.assistantMessage, 'Synthetic answer.');
    assert.equal(result.threadId, 'terminal-thread');
  });
}

const failures = [
  ['failed with structured error', { status: 'failed', error: { message: 'Synthetic terminal failure' } }, 'codex_turn_failed', /Synthetic terminal failure/],
  ['failed without error', { status: 'failed' }, 'codex_turn_failed', /failed/i],
  ['interrupted', { status: 'interrupted' }, 'codex_cancelled', /interrupted/i],
  ['unknown status', { status: 'futureTerminal' }, 'codex_turn_status_invalid', /status/i],
  ['in progress', { status: 'inProgress' }, 'codex_turn_status_invalid', /status/i],
  ['null status', { status: null }, 'codex_turn_status_invalid', /status/i],
  ['empty status', { status: '' }, 'codex_turn_status_invalid', /status/i],
  ['completed with structured error', { status: 'completed', error: { message: 'Synthetic contradictory failure' } }, 'codex_turn_failed', /Synthetic contradictory failure/],
  ['legacy with structured error', { error: { code: 'unknownSyntheticError' } }, 'codex_turn_failed', /failed/i]
];
for (const [name, fields, code, message] of failures) {
  test(`direct runner rejects ${name}`, { timeout: 15000 }, async () => {
    const { result, error, events } = await scenario('direct', fields);
    assert.equal(result, undefined);
    assert.ok(error, 'non-success terminal must reject');
    assert.equal(error.code, code);
    assert.match(error.message, message);
    assert.equal(error.turnStatus, fields.status);
    const completion = events.find(event => event.detail?.method === 'turn/completed');
    assert.equal(completion.status, code === 'codex_cancelled' ? 'cancelled' : 'failed');
  });
}

test('independent error notification and caller abort retain their rejection paths', { timeout: 30000 }, async () => {
  const explicit = await scenario('direct', { status: 'completed' }, { explicitError: true });
  assert.match(explicit.error?.message || '', /Synthetic explicit failure/);
  assert.equal(explicit.result, undefined);
  const aborted = await scenario('abort', {});
  assert.equal(aborted.error, aborted.abortReason);
  assert.equal(aborted.result, undefined);
});

for (const [name, fields, status] of [
  ['completed', { status: 'completed' }, 'completed'],
  ['legacy without status', {}, 'completed'],
  ['failed', { status: 'failed', error: { message: 'Synthetic failure' } }, 'failed'],
  ['interrupted', { status: 'interrupted' }, 'cancelled'],
  ['unknown terminal', { status: 'futureTerminal' }, 'failed'],
  ['contradictory completed error', { status: 'completed', error: { code: 'synthetic' } }, 'failed']
]) {
  test(`real runner → broker → mirror diff handles ${name}`, { timeout: 15000 }, async () => {
    const { result, error, receipt } = await scenario('broker', fields);
    assert.equal(error, undefined, 'successful parent remains successful after reading settled worker receipt');
    assert.equal(receipt.status, status);
    assert.deepEqual(receipt.changedFiles, ['main.tex']);
    assert.deepEqual(result.syncChanges.map(change => change.path), status === 'completed' ? ['main.tex'] : []);
    assert.deepEqual(result.unsupportedChanges.map(change => ({ path: change.path, reason: change.reason })),
      status === 'completed' ? [] : [{ path: 'main.tex', reason: 'subagent_unfinished_output' }]);
  });
}
