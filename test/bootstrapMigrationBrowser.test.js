'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createBootstrapHarness, UPDATE_KEY } = require('./helpers/bootstrapUpdateHarness');
const compatibility = require('../extension/src/shared/compatibility');
// Exact public v2.5.0 Bootstrap bytes; the update entrypoint remains
// the old implementation while the runtime beneath it is the candidate.
const OLD_BOOTSTRAP = require('./fixtures/bootstrap-v2.5.0.json').files['bootstrap/background.js'];
assert.equal(crypto.createHash('sha256').update(OLD_BOOTSTRAP).digest('hex'),
  '5e15d208f07668f96cb94a84642d5fd9ad2dd921991bb3bd5bf67cc43037c87a');
const VERSION = compatibility.BUILD_TARGET_VERSION;
const TAB = { id: 1, url: 'https://www.overleaf.com/project/fixture', status: 'complete' };
const sourcePair = { extensionVersion: '2.5.0', nativeVersion: '2.5.0',
  extensionSha256: 'a'.repeat(64), nativeSha256: 'b'.repeat(64), bootstrapSha256: 'd'.repeat(64) };

function transport(options = {}) {
  const transaction = { id: 'bootstrap-transaction', sourceVersion: '2.5.0', targetVersion: VERSION, state: 'bootstrap_pending' };
  return { transaction, native(request) {
    const ok = result => ({ ok: true, result });
    if (request.method === 'update.status') return ok({ transaction: { ...transaction },
      activeVersion: transaction.state === 'rolled_back' ? '2.5.0' : VERSION,
      installedAligned: true, restoredPair: transaction.state === 'rolled_back'
        ? options.badReadback ? { ...sourcePair, nativeSha256: 'c'.repeat(64) }
          : options.missingBootstrapProof ? { ...sourcePair, bootstrapSha256: undefined }
            : options.badBootstrapProof ? { ...sourcePair, bootstrapSha256: 'e'.repeat(64) } : sourcePair : null });
    if (request.method === 'update.bootstrap') {
      if (options.activationError) return { ok: false, error: { code: 'update_health_failed', message: 'Migration failed.' } };
      if (request.params.bootstrapRevision !== '3.1') return ok({ state: 'reload_required',
        transactionId: transaction.id, targetVersion: transaction.targetVersion });
      transaction.state = 'awaiting_health';
      return ok({ state: transaction.state, transactionId: transaction.id,
        targetVersion: transaction.targetVersion, bootstrapRevision: '3.1' });
    }
    if (request.method === 'update.confirm') {
      assert.equal(request.params.bootstrapRevision, '3.1');
      assert.equal(transaction.state, 'awaiting_health');
      transaction.state = 'committed';
      return ok({ state: 'committed', version: VERSION });
    }
    if (request.method === 'update.rollback') {
      assert.equal(request.params.transactionId, transaction.id);
      assert.equal(request.params.expectedState, 'bootstrap_pending');
      transaction.state = 'rolled_back';
      return ok({ transactionId: transaction.id, state: 'rolled_back', version: '2.5.0', restoredPair: sourcePair });
    }
    if (request.method === 'update.canApply') return ok({ idle: true, blockers: [] });
    if (request.method === 'bridge.ping') return ok({ version: VERSION, protocolVersion: 2,
      supportedProtocol: { min: 1, max: 2 },
      capabilities: Object.fromEntries(compatibility.REQUIRED_CAPABILITIES.map(key => [key, true])) });
    return ok({});
  } };
}

async function create(t, native, options = {}) {
  const h = await createBootstrapHarness({ version: VERSION, tabs: [TAB], pendingTabs: [1], native,
    data: { [UPDATE_KEY]: { state: 'awaiting_health', transactionId: 'bootstrap-transaction',
      currentVersion: '2.5.0', latestVersion: VERSION, phaseStartedAt: Date.now(), deadlineAt: Date.now() + 120000 } },
    ...options });
  t.after(() => h.dispose());
  await h.settle();
  return h;
}

test('public 2.5.0 Bootstrap receives a hidden pending phase and reloads once through the candidate runtime', async t => {
  const f = transport();
  const h = await create(t, f.native, { bootstrapSource: OLD_BOOTSTRAP });
  assert.equal(h.sandbox.__CODEX_OVERLEAF_BOOTSTRAP_REVISION__, undefined);
  const migrated = h.nativeCalls.filter(call => call.method === 'update.bootstrap');
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].params.bootstrapRevision, '');
  assert.equal(h.reloads(), 1);
  assert.equal(h.nativeCalls.some(call => call.method === 'update.confirm'), false);
  assert.equal(h.nativeCalls.some(call => call.method === 'update.rollback'), false);
  assert.equal(h.data[UPDATE_KEY].state, 'awaiting_health');
  assert.ok(h.probes.some(probe => probe.type === 'codex-overleaf/update-idle-probe'));
  await h.sandbox.CodexOverleafBootstrapMigration.ready();
  await h.sandbox.CodexOverleafBootstrapMigration.init({});
  assert.equal(h.reloads(), 1, 'duplicate startup uses the same ownership promise');
});

test('the reloaded Bootstrap proves its actual revision before normal content health and commit', async t => {
  const f = transport();
  const h = await create(t, f.native, { fireStorageChanges: true });
  assert.equal(h.sandbox.__CODEX_OVERLEAF_BOOTSTRAP_REVISION__, '3.1');
  assert.equal(h.data[UPDATE_KEY].state, 'committed');
  assert.equal(h.reloads(), 0);
  assert.ok(h.nativeCalls.findIndex(call => call.method === 'update.bootstrap')
    < h.nativeCalls.findIndex(call => call.method === 'update.confirm'));
  assert.ok(h.probes.some(probe => probe.type === 'codex-overleaf/runtime-health-probe'));
  assert.ok(h.nativeCalls.filter(call => call.method === 'update.status')
    .every(call => call.params.bootstrapRevision === '3.1'));
  const resumed = await h.sandbox.CodexOverleafNativeBridge.requestInternal({ id: crypto.randomUUID(),
    method: 'task.run', params: {} });
  assert.equal(resumed.ok, true, 'verified commit releases the startup execution barrier');
});

test('a busy old content context delays Bootstrap writes and still blocks fresh execution', async t => {
  const f = transport();
  const idle = { idle: false, blockers: ['run'] };
  const h = await create(t, f.native, { bootstrapSource: OLD_BOOTSTRAP, idle });
  assert.equal(h.reloads(), 0);
  assert.equal(h.nativeCalls.some(call => call.method === 'update.bootstrap'), false);
  const response = await h.sandbox.CodexOverleafNativeBridge.requestInternal({ id: crypto.randomUUID(),
    method: 'task.run', params: {} });
  assert.equal(response.error.code, 'update_applying');
  idle.idle = true; idle.blockers = [];
  await h.fireTimer(4000);
  assert.equal(h.reloads(), 1);
  assert.equal(h.nativeCalls.filter(call => call.method === 'update.bootstrap').length, 1);
});

test('a superseded transaction cannot receive the prior worker migration request', async t => {
  const f = transport();
  const idle = { idle: false, blockers: ['run'] };
  const h = await create(t, f.native, { bootstrapSource: OLD_BOOTSTRAP, idle });
  f.transaction.id = 'newer-transaction';
  idle.idle = true; idle.blockers = [];
  await h.fireTimer(4000);
  assert.equal(h.nativeCalls.some(call => call.method === 'update.bootstrap'), false);
  assert.equal(h.reloads(), 0);
  assert.equal(h.data[UPDATE_KEY].recoveryPending, true);
});

test('a persisted watchdog cannot race the pending safe-point migration', async t => {
  const f = transport();
  const idle = { idle: false, blockers: ['run'] };
  const h = await create(t, f.native, { bootstrapSource: OLD_BOOTSTRAP, idle, fireStorageChanges: true,
    data: { [UPDATE_KEY]: { state: 'awaiting_health', transactionId: 'bootstrap-transaction',
      currentVersion: '2.5.0', latestVersion: VERSION, phaseStartedAt: 1, deadlineAt: 2 } } });
  await h.fireAlarm('codex-overleaf-consent-update-watchdog');
  assert.equal(h.nativeCalls.some(call => call.method === 'update.rollback'), false);
  assert.equal(h.data[UPDATE_KEY].state, 'awaiting_health');
  idle.idle = true; idle.blockers = [];
  await h.fireTimer(4000);
  assert.equal(h.reloads(), 1);
  assert.equal(h.nativeCalls.some(call => call.method === 'update.rollback'), false);
});

for (const badReadback of [false, true]) test(`migration failure ${badReadback ? 'retains unconfirmed recovery' : 'reloads the verified source pair'}`, async t => {
  const f = transport({ activationError: true, badReadback });
  const h = await create(t, f.native, { bootstrapSource: OLD_BOOTSTRAP });
  assert.equal(h.reloads(), badReadback ? 0 : 1);
  assert.equal(h.data[UPDATE_KEY].state, badReadback ? 'failed' : 'rolled_back');
  assert.equal(h.nativeCalls.filter(call => call.method === 'update.rollback').length, 1);
  assert.equal(h.nativeCalls.some(call => call.method === 'update.confirm'), false);
});

for (const option of ['missingBootstrapProof', 'badBootstrapProof']) test(`migration rollback refuses ${option}`, async t => {
  const f = transport({ activationError: true, [option]: true });
  const h = await create(t, f.native, { bootstrapSource: OLD_BOOTSTRAP });
  assert.equal(h.reloads(), 0);
  assert.equal(h.data[UPDATE_KEY].state, 'failed');
  assert.equal(h.data[UPDATE_KEY].recoveryPending, true);
});

test('a mismatching target fails closed before any Bootstrap migration or reload', async t => {
  const f = transport({ badReadback: true });
  f.transaction.targetVersion = '99.0.0';
  const h = await create(t, f.native, { bootstrapSource: OLD_BOOTSTRAP });
  assert.equal(h.nativeCalls.some(call => call.method === 'update.bootstrap'), false);
  assert.equal(h.reloads(), 0);
  assert.equal(h.data[UPDATE_KEY].state, 'failed');
});
