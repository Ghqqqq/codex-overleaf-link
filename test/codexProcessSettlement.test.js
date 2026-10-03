'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');
const repo = path.resolve(__dirname, '..');
const native = name => path.join(repo, 'native-host/src', name);
const debug = require(native('debugLog'));
debug.logDebug = () => {}; // No user-home logs, including module assembly.
const environment = require(native('nativeEnvironment'));
environment.refreshCodexRuntimeEnv = env => env; // Discovery only: never probe installed Codex binaries.
const timing = require(native('codexSessionTiming'));
const stop = timing.stopCodexAppServer;
let denyStopSignals = false;
timing.stopCodexAppServer = (child, options) => stop(child, denyStopSignals ? {
  ...options, kill: () => false, terminateTimeoutMs: 0, forceTimeoutMs: 0
} : options);
const { handleRequest, getActiveNativeWorkState } = require(native('taskRunnerRuntime'));
const { isBlocked } = require(native('processStopBarrier'));
const { getProjectMirror } = require(native('mirrorWorkspace'));
const stableContent = 'Stable synthetic output before completion.\n';

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function until(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out: ' + label);
    await wait(10);
  }
}
async function bounded(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Native fixture request exceeded deadline')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
function read(root, name) {
  const file = path.join(root, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}
function latch(root, name, value) {
  const temporary = path.join(root, '.tmp-parent-' + name);
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, path.join(root, name));
}
function fixtureEnv(root, mode) {
  const script = path.join(root, 'app-server.cjs');
  fs.copyFileSync(path.join(__dirname, 'fixtures/codex-process-settlement/app-server.cjs'), script);
  const command = path.join(root, 'synthetic-codex');
  fs.writeFileSync(command, `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`, { mode: 0o755 });
  const userHome = path.join(root, 'user-codex-home'); fs.mkdirSync(userHome);
  return {
    HOME: root, USERPROFILE: root, PATH: root,
    CODEX_OVERLEAF_ENV_READY: '1', CODEX_OVERLEAF_CODEX_PATH: command,
    CODEX_OVERLEAF_USER_CODEX_HOME: userHome, CODEX_HOME: userHome,
    CODEX_OVERLEAF_CODEX_HOME: path.join(root, 'plugin-codex-home'),
    CODEX_OVERLEAF_SKILLS_ROOT: path.join(root, '.codex-overleaf', 'skills'),
    CODEX_OVERLEAF_PROVIDER_STORE_DIR: path.join(root, 'provider-store'),
    CODEX_OVERLEAF_WRITING_STYLE_ROOT: path.join(root, 'writing-styles'),
    CODEX_OVERLEAF_MIRROR_ROOT: path.join(root, 'mirrors'),
    CODEX_OVERLEAF_CODEX_TIMEOUT_MS: '6000', CODEX_OVERLEAF_CODEX_IDLE_TIMEOUT_MS: '6000',
    CODEX_TEST_EXIT_ROOT: root, CODEX_TEST_EXIT_MODE: mode
  };
}
async function scenario(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-exit-probe-'));
  const env = fixtureEnv(root, mode === 'unconfirmed-success' ? 'hold-success' : mode);
  denyStopSignals = mode === 'unconfirmed-success';
  const projectId = 'synthetic-exit-project';
  const workspace = getProjectMirror(projectId, { rootDir: env.CODEX_OVERLEAF_MIRROR_ROOT }).workspacePath;
  const observation = { mode, platform: process.platform, eventTypes: [], cleanup: {} };
  let registeredPid;
  try {
    observation.response = await bounded(handleRequest({ id: 'synthetic-exit-request', method: 'codex.run', params: {
      projectId, task: 'Synthetic exit-boundary verification', mode: 'auto',
      loadCodexLocalSkills: false, loadCodexOverleafSkills: false, enabledCodexOverleafSkillIds: [],
      project: { capabilities: { fullProjectSnapshot: true }, files: [{ path: 'main.tex', content: 'Original synthetic baseline.\n' }] }
    } }, env, event => observation.eventTypes.push(event.type)), 7000);
    const peer = read(root, 'peer.json');
    assert.ok(Number.isInteger(peer?.pid) && peer.pid > 0, 'fixture must register its own PID');
    assert.equal(peer.root, fs.realpathSync(root));
    registeredPid = peer.pid;
    observation.pid = peer.pid;
    observation.aliveAtNativeReturn = alive(peer.pid);
    observation.nativeWorkAtReturn = getActiveNativeWorkState();
    observation.stopBarrierAtReturn = isBlocked(projectId, env.CODEX_OVERLEAF_MIRROR_ROOT);
    observation.diskAtReturn = fs.readFileSync(path.join(workspace, 'main.tex'), 'utf8');
    observation.returnedChanges = observation.response.result?.syncChanges || [];
    observation.initialWrite = read(root, 'initial-write.json');
    observation.lateWriteBeforeLatch = read(root, 'late-write.json');
    if (mode === 'hold-success' && observation.response.ok && alive(peer.pid)) {
      await until(() => read(root, 'sigterm-received.json') || !alive(peer.pid), 1000, 'SIGTERM acknowledgement');
      observation.sigtermReceived = read(root, 'sigterm-received.json');
      // This gate is deliberately created only after response/diff/lock state
      // was captured. The peer cannot write late before this causal barrier.
      latch(root, 'write-after-result.json', { pid: peer.pid, nativeResultReceived: true });
      await until(() => read(root, 'late-write.json') || !alive(peer.pid), 2000, 'gated late write or exit');
    } else if (observation.response.error?.code !== 'codex_process_stop_unconfirmed') {
      await until(() => !alive(peer.pid), 2000, 'normal or failure peer exit');
    }
    observation.lateWrite = read(root, 'late-write.json');
    observation.diskAfterGate = fs.readFileSync(path.join(workspace, 'main.tex'), 'utf8');
    observation.aliveAfterObservation = alive(peer.pid);
    return observation;
  } finally {
    denyStopSignals = false;
    // Cleanup only the PID registered by this fixture in its owned directory.
    const peer = read(root, 'peer.json');
    if (peer && peer.root === fs.realpathSync(root) && Number.isInteger(peer.pid) && peer.pid > 0) registeredPid = peer.pid;
    const pid = registeredPid;
    if (pid) {
      observation.cleanup.pid = pid;
      observation.cleanup.aliveBefore = alive(pid);
      latch(root, 'shutdown.json', { pid });
      await until(() => !alive(pid), 1000, 'cleanup latch').catch(() => {});
      observation.cleanup.signals = [];
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        if (!alive(pid)) break;
        try { process.kill(pid, signal); observation.cleanup.signals.push(signal); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
        await until(() => !alive(pid), 1000, 'owned peer ' + signal).catch(() => {});
      }
      observation.cleanup.aliveAfter = alive(pid);
      observation.cleanup.exitIntent = read(root, 'exit-intent.json');
    }
    observation.cleanup.rootRemoved = !pid || !alive(pid);
    if (observation.cleanup.rootRemoved) fs.rmSync(root, { recursive: true, force: true });
    console.log('CASE_EVIDENCE ' + JSON.stringify(observation));
    assert.ok(observation.cleanup.rootRemoved, 'owned fixture process must be gone before cleanup completes');
  }
}

const options = { timeout: 12000, skip: process.platform === 'win32' };
test('normal success has stable matching output after normal peer exit', options, async () => {
  const value = await scenario('normal-success');
  assert.equal(value.response.ok, true);
  assert.equal(value.returnedChanges.find(change => change.path === 'main.tex').content, stableContent);
  assert.equal(value.diskAfterGate, stableContent);
  assert.equal(value.aliveAfterObservation, false);
  assert.equal(value.lateWrite, null);
});

test('unconfirmed stop after successful terminal withholds changes and persists quarantine', options, async () => {
  const value = await scenario('unconfirmed-success');
  assert.equal(value.response.ok, false);
  assert.equal(value.response.error.code, 'codex_process_stop_unconfirmed');
  assert.equal(value.response.result, undefined);
  assert.equal(value.aliveAtNativeReturn, true);
  assert.equal(value.stopBarrierAtReturn, true);
  assert.deepEqual(value.nativeWorkAtReturn, { projectLocks: 0, runControllers: 0, activeTurnControls: 0 });
});

test('a process-registration hook failure stops its owned child before rejecting', options, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-stop-'));
  const env = fixtureEnv(root, 'normal-success');
  const workspacePath = path.join(root, 'workspace'); fs.mkdirSync(workspacePath);
  let pid;
  try {
    const { runCodexAppServerSession } = require(native('codexSessionRunner'));
    await assert.rejects(bounded(runCodexAppServerSession({
      env, workspacePath, task: 'Synthetic registration failure', mode: 'ask',
      loadCodexLocalSkills: false, loadCodexOverleafSkills: false, emit() {},
      onProcessStarted(identity) {
        pid = identity.processId;
        throw new Error('Synthetic process-registration failure');
      }
    }), 5000), /Synthetic process-registration failure/);
    assert.ok(Number.isInteger(pid) && pid > 0, 'capture only the spawned child identity');
    assert.equal(alive(pid), false, 'hook exception must not orphan the owned process');
  } finally {
    if (pid && alive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await until(() => !alive(pid), 1000, 'hook failure owned peer cleanup');
    }
    assert.ok(!pid || !alive(pid));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed terminal rejects without exposing changes and waits for peer exit', options, async () => {
  const value = await scenario('failed');
  assert.equal(value.response.ok, false);
  assert.equal(value.response.error.code, 'codex_run_failed');
  assert.equal(value.response.result, undefined);
  assert.equal(value.aliveAtNativeReturn, false);
  assert.deepEqual(value.nativeWorkAtReturn, { projectLocks: 0, runControllers: 0, activeTurnControls: 0 });
});

test('successful Native result must not precede a live writer changing its collected mirror bytes', options, async () => {
  const value = await scenario('hold-success');
  if (!value.response.ok) {
    assert.equal(value.response.result, undefined, 'safe refusal must not expose changes');
    assert.ok(['codex_run_failed', 'codex_process_stop_unconfirmed'].includes(value.response.error.code));
    return;
  }
  assert.equal(value.initialWrite.content, stableContent);
  assert.equal(value.diskAtReturn, stableContent);
  assert.equal(value.returnedChanges.find(change => change.path === 'main.tex').content, stableContent);
  assert.equal(value.lateWriteBeforeLatch, null, 'late write cannot happen before the result-dependent latch');
  assert.deepEqual(value.nativeWorkAtReturn, { projectLocks: 0, runControllers: 0, activeTurnControls: 0 });
  if (value.lateWrite) {
    assert.equal(value.sigtermReceived.pid, value.pid);
    assert.equal(value.lateWrite.pid, value.pid);
    assert.equal(value.lateWrite.nativeResultReceived, true);
  }
  assert.equal(value.lateWrite, null,
    'Expected stable exit or safe refusal before successful diff handoff; actual owned peer received SIGTERM, survived Native return/lock release, then wrote different mirror bytes through a post-result latch');
  assert.equal(value.diskAfterGate, stableContent);
});
