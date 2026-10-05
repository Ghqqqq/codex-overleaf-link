'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const updater = require('../native-host/src/updateManager');
const { managedFixture, stageLocalUpdate, loadWithFs, pingInstalled } = require('./helpers/managedUpdateFixture');
const { createBootstrapHarness, UPDATE_KEY } = require('./helpers/bootstrapUpdateHarness');

test('rollback refuses missing source runtime bytes before changing the active pair', async t => {
  const f = managedFixture(t); f.install('2.4.9');
  const staged = await stageLocalUpdate(f);
  updater.applyStagedUpdate(f.context, { transactionId: staged.transactionId });
  fs.rmSync(path.join(f.context.extensionRoot, 'slots/previous'), { recursive: true });
  const before = fs.readFileSync(path.join(f.context.extensionRoot, 'manifest.json'));
  assert.throws(() => updater.rollbackUpdate(f.context, {
    transactionId: staged.transactionId, expectedState: 'awaiting_health'
  }), { code: 'update_rollback_source_unavailable' });
  assert.deepEqual(fs.readFileSync(path.join(f.context.extensionRoot, 'manifest.json')), before);
  assert.equal(fs.readFileSync(path.join(f.context.nativeRoot, 'active-version'), 'utf8').trim(), '2.5.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.context.updatesRoot, 'transaction.json'))).state, 'awaiting_health');
});

test('Bootstrap health rollback binds the observed transaction and reads restored source bytes', async t => {
  const f = managedFixture(t); f.install('2.4.9');
  const staged = await stageLocalUpdate(f);
  updater.applyStagedUpdate(f.context, { transactionId: staged.transactionId });
  const h = await createBootstrapHarness({ version: '2.5.0', native: request =>
    updater.handleUpdateRequest(request, { env: f.env }) });
  t.after(() => h.dispose());
  await h.settle();
  const rollback = h.nativeCalls.find(request => request.method === 'update.rollback');
  assert.equal(rollback.params.transactionId, staged.transactionId);
  assert.equal(rollback.params.expectedState, 'awaiting_health');
  assert.equal(h.data[UPDATE_KEY].state, 'rolled_back');
  assert.equal(h.data[UPDATE_KEY].currentVersion, '2.4.9');
  assert.equal(h.reloads(), 1);
  const after = h.nativeCalls.slice(h.nativeCalls.indexOf(rollback) + 1);
  assert.ok(after.some(request => request.method === 'update.status'), 'success needs a post-rollback readback');
});

test('rollback state/identity guards and byte readback remain independent of matching markers', async t => {
  const f = managedFixture(t); f.install('2.4.9');
  const staged = await stageLocalUpdate(f);
  updater.applyStagedUpdate(f.context, { transactionId: staged.transactionId });
  assert.throws(() => updater.rollbackUpdate(f.context, { transactionId: 'obsolete' }), { code: 'update_transaction_mismatch' });
  assert.throws(() => updater.rollbackUpdate(f.context, { transactionId: staged.transactionId, expectedState: 'committed' }),
    { code: 'update_transaction_state_changed' });
  const result = updater.rollbackUpdate(f.context, { transactionId: staged.transactionId, expectedState: 'awaiting_health' });
  const status = () => updater.handleUpdateRequest({ id: 'readback', method: 'update.status' }, { env: f.env });
  assert.deepEqual((await status()).result.restoredPair, result.restoredPair);
  fs.appendFileSync(path.join(f.context.nativeRoot, 'versions/2.4.9/native-host/src/index.js'), '\n// changed after restoration\n');
  const changed = await status();
  assert.equal(changed.result.installedAligned, true, 'metadata still match');
  assert.equal(changed.result.restoredPair, null, 'changed actual Native bytes cannot confirm the old rollback proof');
});

test('Bootstrap refuses success when source bytes disappear before its rollback readback', async t => {
  const f = managedFixture(t); f.install('2.4.9');
  const staged = await stageLocalUpdate(f);
  updater.applyStagedUpdate(f.context, { transactionId: staged.transactionId });
  let rolledBack = false;
  const h = await createBootstrapHarness({ version: '2.5.0', native: async request => {
    if (rolledBack && request.method === 'update.status') {
      fs.rmSync(path.join(f.context.nativeRoot, 'versions/2.4.9/native-host/src/index.js'), { force: true });
    }
    const response = await updater.handleUpdateRequest(request, { env: f.env });
    if (request.method === 'update.rollback' && response.ok) rolledBack = true;
    return response;
  } });
  t.after(() => h.dispose()); await h.settle();
  assert.equal(rolledBack, true);
  assert.equal(h.data[UPDATE_KEY].state, 'failed');
  assert.equal(h.reloads(), 0);
});

test('an early applying interruption recovers the verified source still in the current slot', async t => {
  const f = managedFixture(t); f.install('2.4.9');
  const staged = await stageLocalUpdate(f);
  const journalFile = path.join(f.context.updatesRoot, 'transaction.json');
  const interrupted = loadWithFs('native-host/src/updateManager.js', { ...fs, renameSync(source, target) {
    fs.renameSync(source, target);
    if (target === journalFile && JSON.parse(fs.readFileSync(target)).state === 'applying') throw new Error('interrupted before moving files');
  } });
  assert.throws(() => interrupted.applyStagedUpdate(f.context, { transactionId: staged.transactionId }), /before moving/);
  assert.equal(fs.existsSync(path.join(f.context.extensionRoot, 'slots/previous/runtime')), false);
  const status = await updater.handleUpdateRequest({ id: 'early-recovery', method: 'update.status' }, { env: f.env });
  assert.equal(status.result.transaction.state, 'rolled_back');
  assert.equal(status.result.activeVersion, '2.4.9');
  assert.equal(status.result.restoredPair.extensionVersion, '2.4.9');
});

test('a missing Native source entry prevents rollback before moving its extension source slot', async t => {
  const f = managedFixture(t); f.install('2.4.9');
  const staged = await stageLocalUpdate(f);
  updater.applyStagedUpdate(f.context, { transactionId: staged.transactionId });
  fs.rmSync(path.join(f.context.nativeRoot, 'versions/2.4.9/native-host/src/index.js'));
  assert.throws(() => updater.rollbackUpdate(f.context, { transactionId: staged.transactionId }), { code: 'update_rollback_source_unavailable' });
  assert.equal(fs.existsSync(path.join(f.context.extensionRoot, 'slots/previous/runtime')), true);
  assert.equal(fs.readFileSync(path.join(f.context.nativeRoot, 'active-version'), 'utf8').trim(), '2.5.0');
});

test('Bootstrap cannot roll back a different transaction that appeared after its health snapshot', async t => {
  const f = managedFixture(t); f.install('2.4.9');
  const staged = await stageLocalUpdate(f); updater.applyStagedUpdate(f.context, { transactionId: staged.transactionId });
  const journalFile = path.join(f.context.updatesRoot, 'transaction.json');
  const h = await createBootstrapHarness({ version: '2.5.0', native: request => {
    if (request.method === 'update.rollback') {
      const newer = { ...JSON.parse(fs.readFileSync(journalFile)), id: 'newer-transaction' };
      fs.writeFileSync(journalFile, JSON.stringify(newer));
    }
    return updater.handleUpdateRequest(request, { env: f.env });
  } });
  t.after(() => h.dispose()); await h.settle();
  assert.equal(h.data[UPDATE_KEY].state, 'failed');
  assert.equal(h.reloads(), 0);
  assert.equal(JSON.parse(fs.readFileSync(journalFile)).id, 'newer-transaction');
  assert.equal(fs.readFileSync(path.join(f.context.nativeRoot, 'active-version'), 'utf8').trim(), '2.5.0');
});

test('failed file restoration retains the unconfirmed transaction and can be retried', async t => {
  const f = managedFixture(t); f.install('2.4.9');
  const staged = await stageLocalUpdate(f); updater.applyStagedUpdate(f.context, { transactionId: staged.transactionId });
  const runtime = path.join(f.context.extensionRoot, 'runtime');
  const faulty = loadWithFs('native-host/src/updateManager.js', { ...fs, renameSync(source, target) {
    if (target === runtime) throw new Error('source restoration I/O failure');
    return fs.renameSync(source, target);
  } });
  assert.throws(() => faulty.rollbackUpdate(f.context, { transactionId: staged.transactionId }), /restoration I\/O failure/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.context.updatesRoot, 'transaction.json'))).state, 'awaiting_health');
  assert.equal(updater.rollbackUpdate(f.context, { transactionId: staged.transactionId }).restoredPair.nativeVersion, '2.4.9');
});

test('healthy replacement runtime and actual installed Native still commit normally', async t => {
  const f = managedFixture(t); f.install('2.4.9');
  const staged = await stageLocalUpdate(f); updater.applyStagedUpdate(f.context, { transactionId: staged.transactionId });
  const h = await createBootstrapHarness({ version: '2.5.0',
    tabs: [{ id: 1, url: 'https://www.overleaf.com/project/fixture', status: 'complete' }], pendingTabs: [1],
    native: request => request.method === 'bridge.ping' ? pingInstalled(f) : updater.handleUpdateRequest(request, { env: f.env }) });
  t.after(() => h.dispose());
  const deadline = Date.now() + 5000;
  while (h.data[UPDATE_KEY].state !== 'committed' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.data[UPDATE_KEY].state, 'committed');
  assert.equal(h.nativeCalls.some(request => request.method === 'update.rollback'), false);
});
