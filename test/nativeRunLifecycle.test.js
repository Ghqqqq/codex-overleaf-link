'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProcessStopIdentity } = require('../native-host/src/codexSessionTiming');
require('../native-host/src/debugLog').logDebug = () => {};

function fresh(name) {
  const filename = require.resolve('../native-host/src/' + name);
  delete require.cache[filename];
  return require(filename);
}
function fixture(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-lifetime-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const barrier = fresh('processStopBarrier');
  const lifecycle = fresh('nativeRunLifecycle');
  const controller = new AbortController();
  const projectKey = 'owned-lifetime-project';
  const entry = lifecycle.register({ controller, rootDir, projectKey });
  return { rootDir, projectKey, barrier, lifecycle, controller, entry };
}

test('shutdown waits for complete and does not quarantine a run that never spawned', async t => {
  const f = fixture(t);
  assert.deepEqual(f.lifecycle.quarantineActiveOperations(), []);
  let done = false;
  const drained = f.lifecycle.abortAllActiveOperations().then(() => { done = true; });
  await Promise.resolve();
  assert.equal(f.controller.signal.aborted, true);
  assert.equal(done, false);
  assert.equal(f.barrier.isBlocked(f.projectKey, f.rootDir), false);
  const lateController = new AbortController();
  const late = f.lifecycle.register({ controller: lateController, rootDir: f.rootDir, projectKey: 'late-preparation' });
  assert.equal(lateController.signal.aborted, true, 'late preparation cannot pass the production pre-spawn abort guard');
  late.complete();
  f.entry.complete();
  await drained;
  assert.equal(done, true);
});

test('confirmed Windows exit clears durable quarantine for a reader that already cached it', async t => {
  const f = fixture(t);
  // Only the platform-specific identity predicate is injected; no OS signal
  // or process is used. The persisted barrier and both readers are real.
  const child = { pid: 4321, exitCode: null, signalCode: null };
  f.entry.trackProcess(createProcessStopIdentity(child, { platform: 'win32', processGroup: false }));
  const reader = fresh('processStopBarrier');
  assert.equal(reader.isBlocked(f.projectKey, f.rootDir), false);
  assert.deepEqual(f.lifecycle.quarantineActiveOperations(), []);
  assert.equal(reader.isBlocked(f.projectKey, f.rootDir), true);
  const drained = f.lifecycle.abortAllActiveOperations();
  child.exitCode = 0;
  f.entry.complete();
  await drained;
  assert.equal(reader.isBlocked(f.projectKey, f.rootDir), false);
  assert.equal(fresh('processStopBarrier').isBlocked(f.projectKey, f.rootDir), false);
});

test('a process identity reported during shutdown is quarantined immediately', async t => {
  const f = fixture(t);
  const drained = f.lifecycle.abortAllActiveOperations();
  const child = { pid: 4321, exitCode: null, signalCode: null };
  f.entry.trackProcess(createProcessStopIdentity(child, { platform: 'win32' }));
  assert.equal(fresh('processStopBarrier').isBlocked(f.projectKey, f.rootDir), true);
  child.exitCode = 0;
  f.entry.complete();
  await drained;
  assert.equal(fresh('processStopBarrier').isBlocked(f.projectKey, f.rootDir), false);
});

test('a failed spawn without an owned PID never leaves an unknown permanent barrier', async t => {
  const f = fixture(t);
  f.entry.trackProcess(createProcessStopIdentity({ pid: undefined, exitCode: null, signalCode: null }));
  const drained = f.lifecycle.abortAllActiveOperations();
  assert.deepEqual(f.lifecycle.quarantineActiveOperations(), []);
  assert.equal(f.barrier.isBlocked(f.projectKey, f.rootDir), false);
  f.entry.complete();
  await drained;
});

test('quarantine persistence failure is explicit while shutdown still aborts and drains', async t => {
  const f = fixture(t);
  const child = { pid: 4321, exitCode: null, signalCode: null };
  f.entry.trackProcess(createProcessStopIdentity(child, { platform: 'win32' }));
  const obstruction = path.join(f.rootDir, f.projectKey);
  fs.writeFileSync(obstruction, 'file prevents barrier directory creation');
  const failures = f.lifecycle.quarantineActiveOperations();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].projectKey, f.projectKey);
  assert.match(failures[0].message, /ENOTDIR|EEXIST/);
  const drained = f.lifecycle.abortAllActiveOperations();
  assert.equal(f.controller.signal.aborted, true);
  child.exitCode = 0;
  f.entry.complete();
  await drained;
});

test('malformed persisted records remain blocked until the corrupted evidence is replaced', t => {
  const f = fixture(t);
  const dir = path.join(f.rootDir, f.projectKey);
  fs.mkdirSync(dir, { recursive: true });
  const filename = path.join(dir, '.codex-stop-barrier.json');
  fs.writeFileSync(filename, '[null]');
  assert.equal(f.barrier.isBlocked(f.projectKey, f.rootDir), true);
  fs.writeFileSync(filename, '[]');
  assert.equal(f.barrier.isBlocked(f.projectKey, f.rootDir), false);
  f.entry.complete();
});
