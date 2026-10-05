'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: wait } = require('node:timers/promises');
const repo = path.resolve(__dirname, '..');
const { isBlocked } = require(path.join(repo, 'native-host/src/processStopBarrier'));
const baseline = 'Original isolated mirror contents.\n';
const read = (root, name) => fs.existsSync(path.join(root, name)) ? JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')) : null;
const rows = (root, name) => fs.existsSync(path.join(root, name)) ? fs.readFileSync(path.join(root, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
function latch(root, name, value) {
  const temp = path.join(root, '.parent-' + name);
  fs.writeFileSync(temp, JSON.stringify(value)); fs.renameSync(temp, path.join(root, name));
}
async function until(predicate, timeout, label) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out: ' + label);
    await wait(10);
  }
}
function nativeFrame(value) {
  const data = Buffer.from(JSON.stringify(value));
  const size = Buffer.alloc(4); size.writeUInt32LE(data.length);
  return Buffer.concat([size, data]);
}
function fixtureEnv(root, mode) {
  const command = path.join(root, 'synthetic-codex');
  fs.writeFileSync(command, `#!${process.execPath}\nrequire(${JSON.stringify(path.join(__dirname, 'fixtures/native-disconnect-settlement/app-server.cjs'))});\n`, { mode: 0o755 });
  const userHome = path.join(root, 'user-codex-home'); fs.mkdirSync(userHome);
  return {
    HOME: root, USERPROFILE: root, PATH: root, TMPDIR: root,
    CODEX_OVERLEAF_ENV_READY: '1', CODEX_OVERLEAF_DISABLE_SHELL_ENV: '1',
    CODEX_OVERLEAF_CODEX_PATH: command, CODEX_OVERLEAF_CODEX_TIMEOUT_MS: '9000', CODEX_OVERLEAF_CODEX_IDLE_TIMEOUT_MS: '9000',
    CODEX_OVERLEAF_USER_CODEX_HOME: userHome, CODEX_HOME: userHome,
    CODEX_OVERLEAF_CODEX_HOME: path.join(root, 'plugin-codex-home'),
    CODEX_OVERLEAF_SKILLS_ROOT: path.join(root, '.codex-overleaf', 'skills'),
    CODEX_OVERLEAF_PROVIDER_STORE_DIR: path.join(root, 'provider-store'),
    CODEX_OVERLEAF_WRITING_STYLE_ROOT: path.join(root, 'styles'),
    CODEX_OVERLEAF_MIRROR_ROOT: path.join(root, 'mirrors'),
    CODEX_TEST_DISCONNECT_ROOT: root, CODEX_TEST_DISCONNECT_MODE: mode, CODEX_TEST_REPOSITORY_ROOT: repo
  };
}
async function probeReconnectedHost(mirrorRoot, onResponse) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-reconnect-admission-'));
  const env = { ...fixtureEnv(root, 'admission-only'), CODEX_OVERLEAF_MIRROR_ROOT: mirrorRoot };
  const host = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/native-disconnect-settlement/host-preload.cjs'), path.join(repo, 'native-host/src/index.js')], {
    cwd: root, env, stdio: ['pipe', 'pipe', 'pipe']
  });
  let exited = false, response, buffer = Buffer.alloc(0);
  host.on('exit', () => { exited = true; });
  host.stdin.on('error', () => {});
  host.stderr.resume();
  host.stdout.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const length = buffer.readUInt32LE(0);
      const message = JSON.parse(buffer.subarray(4, 4 + length).toString());
      buffer = buffer.subarray(4 + length);
      if (!message.event) { response = message; onResponse(message); }
    }
  });
  try {
    // Missing snapshot makes a broken barrier safely fail before any spawn.
    host.stdin.write(nativeFrame({ id: 'reconnected-admission', method: 'codex.run', params: { projectId: 'owned-disconnect-project', task: 'Admission only' } }));
    await until(() => response || exited, 3000, 'reconnected Host admission');
    assert.equal(fs.existsSync(path.join(root, 'peer.json')), false, 'admission probe must never spawn an app-server');
    return response;
  } finally {
    host.stdin.end();
    await until(() => exited, 2200, 'admission Host exit').catch(() => {});
    if (!exited) host.kill('SIGKILL');
    await until(() => exited, 1000, 'owned admission Host cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
async function scenario(mode, requestId = 'owned-disconnect-run') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-disconnect-probe-'));
  const env = fixtureEnv(root, mode);
  const observation = { mode, platform: process.platform, messages: [], cleanup: {} };
  let host, peerPid, hostExited = false, buffer = Buffer.alloc(0), stderr = '';
  try {
    host = spawn(process.execPath, ['--require', path.join(__dirname, 'fixtures/native-disconnect-settlement/host-preload.cjs'), path.join(repo, 'native-host/src/index.js')], {
      cwd: root, env, stdio: ['pipe', 'pipe', 'pipe']
    });
    observation.hostPid = host.pid;
    host.on('exit', (code, signal) => { hostExited = true; observation.hostExit = { code, signal, at: Date.now() }; });
    host.on('error', error => { observation.hostError = error.message; });
    host.stdin.on('error', error => { observation.stdinError = error.code; });
    host.stderr.on('data', data => { stderr += data.toString(); });
    host.stdout.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const size = buffer.readUInt32LE(0);
        observation.messages.push(JSON.parse(buffer.subarray(4, 4 + size).toString()));
        buffer = buffer.subarray(4 + size);
      }
    });
    host.stdin.write(nativeFrame({ id: requestId, method: 'codex.run', params: {
      projectId: 'owned-disconnect-project', task: 'Synthetic disconnect verification', mode: 'auto',
      loadCodexLocalSkills: false, loadCodexOverleafSkills: false, enabledCodexOverleafSkillIds: [],
      project: { capabilities: { fullProjectSnapshot: true }, files: [{ path: 'main.tex', content: baseline }] }
    } }));
    await until(() => observation.messages.some(message => message.event?.type === 'codex.turn.bound') || hostExited,
      4000, 'active real Native turn');
    assert.equal(hostExited, false, 'Host must reach real active turn before trigger: ' + stderr);
    const peer = read(root, 'peer.json');
    assert.equal(peer.root, fs.realpathSync(root));
    assert.ok(Number.isInteger(peer.pid) && peer.pid > 0);
    peerPid = peer.pid;
    const workspace = read(root, 'workspace.json').workspace;
    const barrier = path.join(path.dirname(workspace), '.codex-stop-barrier.json');
    observation.peerPid = peerPid;
    observation.beforeTriggerContent = fs.readFileSync(path.join(workspace, 'main.tex'), 'utf8');
    observation.guardBeforeTrigger = isBlocked('owned-disconnect-project', env.CODEX_OVERLEAF_MIRROR_ROOT);
    observation.triggerAt = Date.now();
    if (mode === 'connected-failure') {
      latch(root, 'fail-now.json', { pid: peerPid });
      await until(() => observation.messages.some(message => message.id === 'owned-disconnect-run' && !message.event),
        6000, 'connected failure response after real stopping');
      observation.response = observation.messages.find(message => message.id === 'owned-disconnect-run' && !message.event);
      observation.peerAliveAtResponse = alive(peerPid);
      observation.hostAliveAtResponse = !hostExited;
      host.stdin.end();
    } else host.stdin.end();
    if (['ignore-disconnect', 'stalled-stop'].includes(mode)) {
      await until(() => read(root, 'interrupt.json') || hostExited, 3000, 'stop begins after disconnect');
      observation.guardDuringStop = isBlocked('owned-disconnect-project', env.CODEX_OVERLEAF_MIRROR_ROOT);
      observation.hostAliveDuringStop = !hostExited;
      observation.newHostResponse = await probeReconnectedHost(env.CODEX_OVERLEAF_MIRROR_ROOT, () => {
        observation.oldHostAliveAtNewAdmission = !hostExited;
        observation.peerAliveAtNewAdmission = alive(peerPid);
      });
    }
    await until(() => hostExited, 7000, 'Host exit after stdin end');
    observation.hostExitEvidence = rows(root, 'host-exit.jsonl');
    observation.peerAliveAtHostExit = alive(peerPid);
    observation.stopAtHostExit = rows(root, 'stop.jsonl');
    observation.barrierCallsAtHostExit = rows(root, 'barrier.jsonl');
    observation.barrierExistsAtHostExit = fs.existsSync(barrier);
    // This parent process never shared the Host's barrier cache. Each scenario
    // has a fresh root, so the actual admission reader loads persisted state.
    try {
      observation.durableBarrierBlocksAtHostExit = isBlocked('owned-disconnect-project', env.CODEX_OVERLEAF_MIRROR_ROOT);
    } catch (error) {
      observation.durableBarrierBlocksAtHostExit = false;
      observation.barrierReadError = { code: error.code, message: error.message };
    }
    observation.interrupt = read(root, 'interrupt.json');
    observation.term = read(root, 'term.json');
    observation.lateWriteBeforeGate = read(root, 'late-write.json');
    if (['ignore-disconnect', 'stalled-stop'].includes(mode) && alive(peerPid)) {
      // Parent cannot publish this gate until the actual owned Host exit event.
      latch(root, 'write-after-host-exit.json', { pid: peerPid, hostPid: host.pid, hostExited: true });
      await until(() => read(root, 'late-write.json') || !alive(peerPid), 1500, 'post-Host-exit write or confirmed peer exit');
    }
    observation.lateWrite = read(root, 'late-write.json');
    observation.finalContent = fs.readFileSync(path.join(workspace, 'main.tex'), 'utf8');
    observation.stderr = stderr;
    return observation;
  } finally {
    // Exact owned PIDs only; never query/terminate unrelated processes.
    if (host && !hostExited) {
      host.stdin.end();
      await until(() => hostExited, 1800, 'Host graceful cleanup').catch(() => {});
      if (!hostExited) host.kill('SIGTERM');
      await until(() => hostExited, 800, 'Host TERM cleanup').catch(() => {});
      if (!hostExited) host.kill('SIGKILL');
      await until(() => hostExited, 1000, 'Host KILL cleanup').catch(() => {});
    }
    const peer = read(root, 'peer.json');
    if (peer && peer.root === fs.realpathSync(root) && Number.isInteger(peer.pid) && peer.pid > 0) peerPid = peer.pid;
    if (peerPid && alive(peerPid)) {
      latch(root, 'shutdown.json', { pid: peerPid });
      await until(() => !alive(peerPid), 1000, 'peer cleanup latch').catch(() => {});
      if (alive(peerPid)) { try { process.kill(peerPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      await until(() => !alive(peerPid), 1000, 'owned peer final exit').catch(() => {});
    }
    observation.guardAfterCleanup = isBlocked('owned-disconnect-project', env.CODEX_OVERLEAF_MIRROR_ROOT);
    observation.cleanup = { hostExited: !host || hostExited, peerExited: !peerPid || !alive(peerPid), peerExitIntent: read(root, 'peer-exit.json') };
    observation.logs = rows(root, '.codex-overleaf/native-host.log').map(value => ({ event: value.event, code: value.detail?.code, source: value.detail?.source }));
    if (observation.cleanup.hostExited && observation.cleanup.peerExited) fs.rmSync(root, { recursive: true, force: true });
    console.log('CASE_EVIDENCE ' + JSON.stringify(observation));
    assert.equal(observation.cleanup.hostExited, true, 'owned Host must exit');
    assert.equal(observation.cleanup.peerExited, true, 'owned peer must exit');
  }
}
const options = { timeout: 16000, skip: process.platform === 'win32' };
test('cooperative app-server exits before disconnected Host exits', options, async () => {
  const value = await scenario('cooperative-disconnect');
  assert.equal(value.hostExit.code, 0);
  assert.equal(value.peerAliveAtHostExit, false);
  assert.equal(value.stopAtHostExit.at(-1).event, 'resolved');
  assert.deepEqual(value.hostExitEvidence.at(-1).work, { projectLocks: 0, processStopBarriers: 0, runControllers: 0, activeTurnControls: 0 });
  assert.equal(value.finalContent, baseline);
});
test('connected failure waits through interrupt and TERM to confirmed KILL exit', options, async () => {
  const value = await scenario('connected-failure');
  assert.equal(value.response.ok, false);
  assert.equal(value.response.error.code, 'codex_run_failed');
  assert.equal(value.hostAliveAtResponse, true);
  assert.equal(value.peerAliveAtResponse, false);
  assert.equal(value.stopAtHostExit.at(-1).event, 'resolved');
  assert.equal(value.stopAtHostExit.at(-1).signalCode, 'SIGKILL');
  assert.equal(value.finalContent, baseline);
});
test('disconnected Native Host must not abandon a live mirror writer without a durable stop barrier', options, async () => {
  const value = await scenario('ignore-disconnect');
  assert.ok(value.interrupt, 'real stop routine must reach turn/interrupt');
  assert.equal(value.lateWriteBeforeGate, null, 'write is causally gated on actual Host exit');
  const safeExit = !value.peerAliveAtHostExit || value.durableBarrierBlocksAtHostExit;
  assert.equal(safeExit, true,
    'Expected confirmed peer exit or durable quarantine before Host exit; actual Host exited with stop pending, no barrier, and owned peer still able to write through a post-exit gate');
  // A live quarantined process may still write; that is an observation, while
  // the tested contract requires it to block new admission. Only confirmed
  // exit also promises that this owned process cannot perform a later write.
  if (!value.peerAliveAtHostExit) assert.equal(value.lateWrite, null, 'confirmed peer exit must rule out its later write');
});

test('disconnect publishes quarantine before the slow stop finishes, including an already-running reader', options, async () => {
  const value = await scenario('ignore-disconnect', 0);
  assert.equal(value.guardBeforeTrigger, false);
  assert.equal(value.hostAliveDuringStop, true);
  assert.equal(value.guardDuringStop, true);
  assert.equal(value.oldHostAliveAtNewAdmission, true);
  assert.equal(value.peerAliveAtNewAdmission, true);
  assert.equal(value.newHostResponse.error.code, 'codex_process_stop_unconfirmed');
  assert.equal(value.peerAliveAtHostExit, false);
  assert.equal(value.guardAfterCleanup, false);
});
test('a stalled stop keeps shutdown bounded and leaves effective persistent quarantine', options, async () => {
  const value = await scenario('stalled-stop');
  assert.equal(value.hostAliveDuringStop, true);
  assert.equal(value.guardDuringStop, true);
  assert.equal(value.oldHostAliveAtNewAdmission, true);
  assert.equal(value.peerAliveAtNewAdmission, true);
  assert.equal(value.newHostResponse.error.code, 'codex_process_stop_unconfirmed');
  assert.equal(value.peerAliveAtHostExit, true);
  assert.equal(value.durableBarrierBlocksAtHostExit, true);
  assert.ok(value.hostExit.at - value.triggerAt >= 4500);
  assert.ok(value.hostExit.at - value.triggerAt < 7000);
  assert.equal(value.lateWrite.hostExited, true);
  assert.equal(value.guardAfterCleanup, false);
});
