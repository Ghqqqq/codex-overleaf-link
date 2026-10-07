'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { bootstrapMigrationFixture, nativeRequest, read, write, hash, oldBootstrap, repo } = require('./helpers/bootstrapMigrationFixture');

function assertSource(fixture) {
  for (const [relative, bytes] of Object.entries(oldBootstrap.files)) {
    assert.equal(fs.readFileSync(path.join(fixture.context.extensionRoot, relative), 'utf8'), bytes, relative);
  }
  assert.equal(fs.existsSync(path.join(fixture.context.extensionRoot, 'bootstrap/popupFallback.js')), false);
  assert.equal(fs.readFileSync(path.join(fixture.context.extensionRoot, 'user-settings.json'), 'utf8'), 'preserved user data\n');
}

function assertTarget(fixture) {
  for (const file of fixture.descriptor.files) {
    assert.equal(hash(fs.readFileSync(path.join(fixture.context.extensionRoot, file.path))), file.targetSha256, file.path);
  }
}

function assertRestored(fixture, result) {
  assert.equal(result.state, 'rolled_back');
  assert.equal(result.version, '2.5.0');
  assert.equal(result.restoredPair.extensionVersion, '2.5.0');
  assert.equal(result.restoredPair.nativeVersion, '2.5.0');
  for (const field of ['extensionSha256', 'nativeSha256', 'bootstrapSha256']) {
    assert.match(result.restoredPair[field], /^[a-f0-9]{64}$/, field);
  }
  assert.equal(read(path.join(fixture.context.extensionRoot, 'manifest.json')).version, '2.5.0');
  assert.equal(fs.readFileSync(path.join(fixture.context.nativeRoot, 'active-version'), 'utf8').trim(), '2.5.0');
  assertSource(fixture);
}

test('verified committed recovery also removes its already consumed authorization after interrupted deletion', async t => {
  const f = bootstrapMigrationFixture(t);
  await f.apply(); await f.migrate(); await f.migrate('3.1');
  const filename = path.join(f.context.updatesRoot, 'authorization.json');
  const authorization = read(filename);
  await f.confirm();
  write(filename, { ...authorization, state: 'consumed' });
  const status = await f.request('update.status');
  assert.equal(status.transaction.state, 'committed');
  assert.equal(status.authorization, null);
  assert.equal(fs.existsSync(filename), false);
});

test('signed 2.5.0 update stages, applies, migrates, reloads and only then confirms all three components', async t => {
  const f = bootstrapMigrationFixture(t);
  const transactionId = await f.apply();
  assert.equal(f.journal().state, 'bootstrap_pending');
  assertSource(f);
  const first = await f.migrate();
  assert.equal(first.state, 'reload_required');
  assert.equal(first.transactionId, transactionId);
  assertTarget(f);
  assert.equal(f.journal().bootstrapMigration.phase, 'applied');
  await assert.rejects(f.confirm(), { code: 'update_confirmation_unexpected' });
  const loaded = await f.migrate('3.1');
  assert.equal(loaded.state, 'awaiting_health');
  assert.equal(f.journal().bootstrapMigration.phase, 'loaded');
  await assert.rejects(f.confirm(''), { code: 'update_bootstrap_confirmation_pending' });
  assert.deepEqual(await f.confirm(), { version: '2.5.1', state: 'committed' });
  assert.equal(f.journal().state, 'committed');
  assert.equal(fs.existsSync(path.join(f.context.updatesRoot, 'authorization.json')), false);
  assert.equal(fs.existsSync(f.journal().stageRoot), false);
  assertTarget(f);
});

test('2.5.0 legacy health confirmation cannot bypass a not-yet-bound Bootstrap migration', async t => {
  const f = bootstrapMigrationFixture(t);
  await f.apply({ bind: false });
  assert.equal(f.journal().state, 'awaiting_health');
  await assert.rejects(f.confirm(), { code: 'update_bootstrap_confirmation_pending' });
  const status = await f.request('update.status');
  assert.equal(status.transaction.state, 'bootstrap_pending');
  assert.equal(f.journal().state, 'bootstrap_pending');
  assertSource(f);
});

test('missing discovery evidence cannot silently convert the migration into ordinary successful health', async t => {
  const f = bootstrapMigrationFixture(t);
  await f.apply({ bind: false });
  fs.rmSync(path.join(f.context.updatesRoot, 'candidate.json'));
  const status = await f.request('update.status');
  assert.equal(status.transaction.state, 'bootstrap_pending');
  assert.equal(f.journal().bootstrapMigration.verificationError, 'update_bootstrap_manifest_mismatch');
  await assert.rejects(f.migrate(), { code: 'update_bootstrap_manifest_mismatch' });
  await assert.rejects(f.confirm(), { code: 'update_confirmation_unexpected' });
  assertSource(f);
});

test('a signed release without a migration descriptor remains blocked and can restore untouched source', async t => {
  const f = bootstrapMigrationFixture(t, { mutateManifest: manifest => { delete manifest.bootstrapMigration; } });
  await f.apply();
  const status = await f.request('update.status');
  assert.equal(status.transaction.state, 'bootstrap_pending');
  assert.ok(f.journal().bootstrapMigration.verificationError);
  await assert.rejects(f.migrate(), /Unsupported Bootstrap migration descriptor/);
  await assert.rejects(f.confirm());
  const restored = await f.request('update.rollback', { transactionId: f.journal().id });
  assertRestored(f, restored);
  assert.equal(restored.restoredPair.bootstrapSourceUnchanged, true);
  assert.equal(f.journal().bootstrapMigration.sourceUnchanged, true);
  assert.equal((await f.request('update.status')).restoredPair.bootstrapSha256, restored.restoredPair.bootstrapSha256);
});

test('migration rechecks the signature of persisted evidence instead of trusting a previously staged descriptor', async t => {
  const f = bootstrapMigrationFixture(t);
  await f.apply();
  const journal = f.journal();
  const signature = JSON.parse(Buffer.from(journal.bootstrapMigration.signatureBase64, 'base64'));
  signature.signature = Buffer.alloc(64).toString('base64');
  journal.bootstrapMigration.signatureBase64 = Buffer.from(JSON.stringify(signature)).toString('base64');
  f.setJournal(journal);
  await assert.rejects(f.migrate(), { code: 'update_signature_invalid' });
  assertSource(f);
  assert.equal(fs.existsSync(f.recordRoot()), false);
});

test('a signed descriptor cannot authorize unknown source hashes', async t => {
  const f = bootstrapMigrationFixture(t, { mutateManifest: manifest => {
    manifest.bootstrapMigration.files[0].sourceSha256 = 'a'.repeat(64);
  } });
  await f.apply();
  await assert.rejects(f.migrate(), /Bootstrap migration file identity is invalid/);
  assertSource(f);
});

test('the journal manifest hash prevents swapping in another valid signed release', async t => {
  const f = bootstrapMigrationFixture(t);
  await f.apply();
  const journal = f.journal();
  journal.manifestSha256 = '0'.repeat(64);
  f.setJournal(journal);
  await assert.rejects(f.migrate(), { code: 'update_bootstrap_manifest_mismatch' });
  assertSource(f);
});

test('source edits, payload edits, and permission additions stop before replacing the browser entry', async t => {
  for (const kind of ['source', 'payload', 'manifest', 'payloadManifest']) {
    await t.test(kind, async tt => {
      const f = bootstrapMigrationFixture(tt);
      await f.apply();
      if (kind === 'source') fs.appendFileSync(path.join(f.context.extensionRoot, 'bootstrap/update.js'), '\n// local edit\n');
      if (kind === 'payload') fs.appendFileSync(path.join(f.installedPayload(), 'bootstrap/background.js'), '\n// altered\n');
      if (kind === 'manifest' || kind === 'payloadManifest') {
        const file = kind === 'manifest' ? path.join(f.context.extensionRoot, 'manifest.json')
          : path.join(f.installedPayload(), 'manifest.template.json');
        const value = read(file);
        value.permissions.push('history'); write(file, value);
      }
      const before = fs.readFileSync(path.join(f.context.extensionRoot, 'bootstrap/background.js'));
      const result = await f.response('update.bootstrap', { transactionId: f.journal().id });
      assert.equal(result.ok, false);
      if (kind === 'source') assert.equal(result.error.code, 'update_bootstrap_source_mismatch');
      if (kind === 'payload') assert.equal(result.error.code, 'update_bootstrap_payload_mismatch');
      if (kind === 'manifest' || kind === 'payloadManifest') {
        assert.equal(result.error.code, 'update_bootstrap_failed', 'owned validation failures reach the bilingual Bootstrap error projection');
        assert.match(result.error.message, /manifest shape or permissions/);
      }
      assert.deepEqual(fs.readFileSync(path.join(f.context.extensionRoot, 'bootstrap/background.js')), before);
      assert.equal(fs.existsSync(path.join(f.recordRoot(), 'state.json')), false);
    });
  }
});

test('a damaged signed archive is refused even when the installed migration payload still has correct hashes', async t => {
  const f = bootstrapMigrationFixture(t);
  await f.apply();
  fs.appendFileSync(f.journal().archivePath, 'changed');
  await assert.rejects(f.migrate(), { code: 'update_bundle_size_mismatch' });
  assertSource(f);
});

test('old revision can request at most two reloads and the same transaction remains recoverable', async t => {
  const f = bootstrapMigrationFixture(t);
  await f.apply();
  assert.equal((await f.migrate()).state, 'reload_required');
  const firstToken = f.journal().bootstrapMigration.watchdogToken;
  assert.equal((await f.migrate()).state, 'reload_required');
  assert.notEqual(f.journal().bootstrapMigration.watchdogToken, firstToken);
  await assert.rejects(f.migrate(), { code: 'update_bootstrap_reload_failed' });
  assert.equal(f.journal().bootstrapMigration.reloadCount, 2);
  assertRestored(f, await f.request('update.rollback', { transactionId: f.journal().id }));
});

test('an expired migration cannot rewrite Bootstrap and status restores the runtime and Bootstrap together', async t => {
  const f = bootstrapMigrationFixture(t);
  await f.apply();
  const journal = f.journal(); journal.bootstrapMigration.deadline = Date.now() - 1; f.setJournal(journal);
  await assert.rejects(f.migrate(), { code: 'update_bootstrap_health_timeout' });
  assertSource(f);
  const result = await f.request('update.status');
  assert.equal(result.transaction.state, 'rolled_back');
  assert.equal(result.activeVersion, '2.5.0');
  assert.match(result.restoredPair.bootstrapSha256, /^[a-f0-9]{64}$/);
  assertSource(f);
});

test('Native work and transaction identity checks prevent starting a second or busy migration', async t => {
  const f = bootstrapMigrationFixture(t);
  await f.apply();
  const wrong = await f.response('update.bootstrap', { transactionId: 'other-transaction' });
  assert.equal(wrong.error.code, 'update_transaction_mismatch');
  const busy = await f.response('update.bootstrap', { transactionId: f.journal().id }, {
    getWorkState: () => ({ projectLocks: 1, runControllers: 0 })
  });
  assert.equal(busy.error.code, 'update_native_busy');
  assertSource(f);
  await f.migrate('3.1');
  await assert.rejects(f.migrate('3.1'), { code: 'update_transaction_state_changed' });
  await f.confirm();
  assert.equal((await f.migrate('3.1')).state, 'not_required');
});

test('revoked authorization stops migration before Bootstrap mutation and leaves a recoverable transaction', async t => {
  const f = bootstrapMigrationFixture(t);
  await f.apply();
  const filename = path.join(f.context.updatesRoot, 'authorization.json'), authorization = read(filename);
  authorization.state = 'revoked'; write(filename, authorization);
  await assert.rejects(f.migrate(), { code: 'update_consent_required' });
  assertSource(f);
  assertRestored(f, await f.request('update.rollback', { transactionId: f.journal().id }));
});

test('an authorization already bound to this transaction can finish after its initial consent window', async t => {
  const f = bootstrapMigrationFixture(t);
  await f.apply();
  const filename = path.join(f.context.updatesRoot, 'authorization.json'), authorization = read(filename);
  authorization.expiresAt = '2000-01-01T00:00:00.000Z'; write(filename, authorization);
  assert.equal((await f.migrate('3.1')).state, 'awaiting_health');
  assert.equal((await f.confirm()).state, 'committed');
});

test('late cancel and revoke cannot discard migration authorization or its signed recovery archive', async t => {
  for (const state of ['bootstrap_pending', 'bootstrap_rolling_back']) {
    await t.test(state, async tt => {
      const f = bootstrapMigrationFixture(tt);
      await f.apply(); await f.migrate();
      const journal = f.journal(); journal.state = state; f.setJournal(journal);
      const authorizationFile = path.join(f.context.updatesRoot, 'authorization.json');
      const authorization = fs.readFileSync(authorizationFile);
      const params = { transactionId: journal.id, authorizationId: journal.authorizationId,
        targetVersion: '2.5.1', operationId: journal.id };
      await assert.rejects(f.request('update.cancel', params), { code: 'update_revoke_too_late' });
      await assert.rejects(f.request('update.revoke', params), { code: 'update_revoke_too_late' });
      await assert.rejects(f.request('update.authorize', { authorizationId: journal.id,
        currentVersion: '2.5.1', targetVersion: '2.5.2' }), { code: 'update_transaction_in_progress' });
      await assert.rejects(f.request('update.stage'), { code: 'update_transaction_in_progress' });
      assert.deepEqual(fs.readFileSync(authorizationFile), authorization);
      assert.equal(fs.existsSync(journal.archivePath), true);
      assert.equal(f.journal().state, state);
    });
  }
});

test('a stale watchdog token cannot recover a newer monitor and terminal recovery is idempotent', async t => {
  const f = bootstrapMigrationFixture(t);
  await f.apply(); await f.migrate();
  const staleToken = f.journal().bootstrapMigration.watchdogToken;
  await f.migrate();
  const journal = f.journal(); journal.bootstrapMigration.deadline = Date.now() - 1; f.setJournal(journal);
  assert.deepEqual(await f.updater.recoverBootstrapTransaction({ env: f.env }, journal.id, staleToken), { state: 'obsolete' });
  assert.equal(f.journal().state, 'bootstrap_pending');
  const recovered = await f.updater.recoverBootstrapTransaction({ env: f.env }, journal.id, journal.bootstrapMigration.watchdogToken);
  assertRestored(f, recovered);
  const receipt = fs.readFileSync(f.journalPath);
  const repeated = await f.updater.recoverBootstrapTransaction({ env: f.env }, journal.id, journal.bootstrapMigration.watchdogToken);
  assert.equal(repeated.state, 'rolled_back');
  assert.deepEqual(fs.readFileSync(f.journalPath), receipt);
});

test('a live process id without the monitor token heartbeat cannot suppress requested recovery', async t => {
  const f = bootstrapMigrationFixture(t);
  await f.apply(); await f.migrate();
  const heartbeatFile = path.join(f.recordRoot(), 'watchdog.json');
  const heartbeat = read(heartbeatFile); heartbeat.token = 'stale-monitor'; write(heartbeatFile, heartbeat);
  const status = await f.request('update.status', { bootstrapRecovery: true });
  assert.equal(status.transaction.state, 'rolled_back');
  assert.match(status.restoredPair.bootstrapSha256, /^[a-f0-9]{64}$/);
  assertSource(f);
});

test('real framed Native dispatch blocks business before binding, while applied, and until health commits', async t => {
  const f = bootstrapMigrationFixture(t);
  await f.apply({ bind: false });
  for (const phase of ['unbound', 'applied', 'loaded']) {
    if (phase === 'applied') await f.migrate();
    if (phase === 'loaded') await f.migrate('3.1');
    const business = await nativeRequest(f, 'codex.run');
    assert.equal(business.ok, false, phase);
    assert.equal(business.error.code, 'update_applying', phase);
  }
  const ping = await nativeRequest(f, 'bridge.ping');
  assert.equal(ping.ok, true);
  await f.confirm();
  assert.doesNotThrow(() => f.updater.assertBootstrapBusinessAvailable({ method: 'codex.run' }, { env: f.env }));
});

test('missing durable recovery records after applied or loaded states never become successful rollback or confirmation', async t => {
  for (const phase of ['applied', 'loaded']) {
    await t.test(phase, async tt => {
      const f = bootstrapMigrationFixture(tt);
      await f.apply();
      await f.migrate(phase === 'loaded' ? '3.1' : '');
      fs.rmSync(path.join(f.recordRoot(), 'state.json'));
      const rollback = await f.response('update.rollback', { transactionId: f.journal().id });
      assert.equal(rollback.ok, false);
      assert.equal(rollback.error.code, 'update_bootstrap_record_missing');
      assert.notEqual(f.journal().state, 'rolled_back');
      await assert.rejects(f.confirm());
      assert.equal(fs.readFileSync(path.join(f.context.nativeRoot, 'active-version'), 'utf8').trim(), '2.5.1');
      assertTarget(f);
    });
  }
});

test('loaded Bootstrap confirmation checks durable byte evidence again', async t => {
  const f = bootstrapMigrationFixture(t);
  await f.apply(); await f.migrate('3.1');
  fs.appendFileSync(path.join(f.context.extensionRoot, 'bootstrap/background.js'), '\n// changed after load\n');
  await assert.rejects(f.confirm());
  assert.equal(f.journal().state, 'awaiting_health');
});

test('rollback before Bootstrap mutation includes source proof even with missing candidate data', async t => {
  const f = bootstrapMigrationFixture(t);
  await f.apply({ bind: false });
  fs.rmSync(path.join(f.context.updatesRoot, 'candidate.json'));
  await f.request('update.status');
  const restored = await f.request('update.rollback', { transactionId: f.journal().id });
  assertRestored(f, restored);
  assert.equal(f.journal().bootstrapMigration.sourceUnchanged, true);
  const status = await f.request('update.status');
  assert.equal(status.restoredPair.bootstrapSha256, restored.restoredPair.bootstrapSha256);
});

test('rollback before the first status binds source Bootstrap evidence only after validating caller identity and state', async t => {
  const f = bootstrapMigrationFixture(t);
  await f.apply({ bind: false });
  const original = fs.readFileSync(f.journalPath);
  await assert.rejects(f.request('update.rollback', { transactionId: 'wrong-transaction' }), { code: 'update_transaction_mismatch' });
  await assert.rejects(f.request('update.rollback', { transactionId: f.journal().id, expectedState: 'staged' }),
    { code: 'update_transaction_state_changed' });
  assert.deepEqual(fs.readFileSync(f.journalPath), original);
  assert.equal(f.journal().bootstrapMigration, undefined);
  const restored = await f.request('update.rollback', { transactionId: f.journal().id, expectedState: 'awaiting_health' });
  assertRestored(f, restored);
  assert.equal(restored.restoredPair.bootstrapSourceUnchanged, true);
  assert.equal(f.journal().bootstrapMigration.sourceUnchanged, true);
  assert.equal(f.journal().sourceActivationPending, false);
});

test('rollback pending source activation resumes from disk only after exact runtime and Bootstrap proof', async t => {
  const f = bootstrapMigrationFixture(t);
  await f.apply(); await f.migrate();
  const restored = await f.request('update.rollback', { transactionId: f.journal().id });
  assertRestored(f, restored);
  const journal = f.journal(); journal.sourceActivationPending = true; f.setJournal(journal);
  fs.writeFileSync(path.join(f.context.nativeRoot, 'active-version'), '2.5.1\n');
  assert.throws(() => f.updater.assertBootstrapBusinessAvailable({ method: 'provider.save' }, { env: f.env }), { code: 'update_applying' });
  const late = { transactionId: journal.id, authorizationId: journal.authorizationId,
    targetVersion: '2.5.1', operationId: journal.id };
  await assert.rejects(f.request('update.cancel', late), { code: 'update_revoke_too_late' });
  await assert.rejects(f.request('update.revoke', late), { code: 'update_revoke_too_late' });
  const status = await f.request('update.status');
  assert.equal(status.activeVersion, '2.5.0');
  assert.equal(f.journal().sourceActivationPending, false);
  assert.equal(status.restoredPair.bootstrapSha256, restored.restoredPair.bootstrapSha256);
});

test('source activation remains blocked if restored Bootstrap changed after the durable recovery record', async t => {
  const f = bootstrapMigrationFixture(t);
  await f.apply(); await f.migrate();
  await f.request('update.rollback', { transactionId: f.journal().id });
  const journal = f.journal(); journal.sourceActivationPending = true; f.setJournal(journal);
  fs.writeFileSync(path.join(f.context.nativeRoot, 'active-version'), '2.5.1\n');
  fs.appendFileSync(path.join(f.context.extensionRoot, 'bootstrap/background.js'), '\n// late edit\n');
  const result = await f.response('update.status');
  assert.equal(result.ok, false);
  assert.equal(f.journal().sourceActivationPending, true);
  assert.equal(fs.readFileSync(path.join(f.context.nativeRoot, 'active-version'), 'utf8').trim(), '2.5.1');
});

test('a real detached watchdog restores the whole transaction after the persisted health deadline expires', { timeout: 10000 }, async t => {
  const f = bootstrapMigrationFixture(t);
  await f.apply();
  await f.migrate('', { bootstrapMigration: {} });
  f.trackWatchdog();
  const initial = f.journal();
  assert.ok(initial.bootstrapMigration.watchdogPid > 0);
  assert.notEqual(initial.bootstrapMigration.watchdogPid, process.pid);
  const heartbeat = read(path.join(f.recordRoot(), 'watchdog.json'));
  assert.equal(heartbeat.pid, initial.bootstrapMigration.watchdogPid);
  assert.equal(heartbeat.token, initial.bootstrapMigration.watchdogToken);
  initial.bootstrapMigration.deadline = Date.now() - 1;
  f.setJournal(initial);
  const end = Date.now() + 6000;
  // Do not call update.status here: the standalone monitor must do recovery.
  while ((f.journal().state !== 'rolled_back' || f.journal().sourceActivationPending) && Date.now() < end) {
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  const journal = f.journal();
  assert.equal(journal.state, 'rolled_back');
  assert.equal(journal.reasonCode, 'update_bootstrap_health_timeout');
  assert.equal(journal.sourceActivationPending, false);
  assert.match(journal.rollbackEvidence.bootstrapSha256, /^[a-f0-9]{64}$/);
  assertSource(f);
  assert.equal(fs.readFileSync(path.join(f.context.nativeRoot, 'active-version'), 'utf8').trim(), '2.5.0');
});

test('a real watchdog survives a SIGKILL immediately after replacing the browser entry and restores all layers',
  { timeout: 12000, skip: process.platform === 'win32' }, async t => {
    const f = bootstrapMigrationFixture(t);
    await f.apply();
    const input = path.join(f.root, 'child-migration.json');
    write(input, { transactionId: f.journal().id, publicKey: f.publicKey });
    const code = `const fs=require('node:fs'),path=require('node:path');
const fixture=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const repo=process.argv[2],trust=require(path.join(repo,'native-host/src/updateTrust.js'));
const {loadWithDependencies}=require(path.join(repo,'test/helpers/managedUpdateFixture.js'));
const update=loadWithDependencies('native-host/src/updateManager.js',{'./updateTrust':{...trust,
verifySignedReleaseManifest:(bytes,sig,options)=>trust.verifySignedReleaseManifest(bytes,sig,{...options,publicKeys:{fixture:fixture.publicKey}})}});
update.handleUpdateRequest({id:'killed-migration',method:'update.bootstrap',params:{transactionId:fixture.transactionId}},
{env:process.env,bootstrapMigration:{fileHooks:{onStep(step){if(step.phase==='apply:replaced'&&step.path.endsWith('/bootstrap/background.js'))process.kill(process.pid,'SIGKILL');}}}})
.then(result=>{process.stderr.write(JSON.stringify(result));process.exitCode=2;});`;
    const child = spawnSync(process.execPath, ['-e', code, input, repo], {
      env: f.env, encoding: 'utf8', timeout: 6000
    });
    f.trackWatchdog();
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    assert.equal(read(path.join(f.recordRoot(), 'state.json')).state, 'applying');
    const journal = f.journal(); journal.bootstrapMigration.deadline = Date.now() - 1; f.setJournal(journal);
    const end = Date.now() + 6000;
    while ((f.journal().state !== 'rolled_back' || f.journal().sourceActivationPending) && Date.now() < end) {
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    assert.equal(f.journal().state, 'rolled_back');
    assert.equal(f.journal().sourceActivationPending, false);
    assert.match(f.journal().rollbackEvidence.bootstrapSha256, /^[a-f0-9]{64}$/);
    assertSource(f);
    assert.equal(fs.readFileSync(path.join(f.context.nativeRoot, 'active-version'), 'utf8').trim(), '2.5.0');
  });

test('SIGKILL before source activation settles bound consent first and the independent watchdog completes recovery',
  { timeout: 10000, skip: process.platform === 'win32' }, async t => {
    const f = bootstrapMigrationFixture(t);
    await f.apply(); await f.migrate('', { bootstrapMigration: {} });
    f.trackWatchdog();
    const watchdogPid = f.journal().bootstrapMigration.watchdogPid;
    // Hold only this fixture's monitor until the exact crash point is observed.
    // Resuming it then proves recovery needs no parent/status RPC.
    process.kill(watchdogPid, 'SIGSTOP');
    const code = `const fs=require('node:fs'),path=require('node:path');
const root=process.argv[1],journalPath=path.join(root,'native/updates/transaction.json');
const {loadWithDependencies}=require(process.argv[2]);
const io={...fs,renameSync(from,to){if(to===path.join(root,'native/active-version')){
const journal=JSON.parse(fs.readFileSync(journalPath,'utf8'));if(journal.sourceActivationPending)process.kill(process.pid,'SIGKILL');}
return fs.renameSync(from,to);}};
const updater=loadWithDependencies('native-host/src/updateManager.js',{'node:fs':io});
const journal=JSON.parse(fs.readFileSync(journalPath,'utf8'));
updater.handleUpdateRequest({id:'killed-rollback',method:'update.rollback',params:{transactionId:journal.id}},{env:process.env})
.then(result=>{process.stderr.write(JSON.stringify(result));process.exitCode=2;});`;
    const child = spawnSync(process.execPath, ['-e', code, f.root, path.join(repo, 'test/helpers/managedUpdateFixture.js')], {
      env: f.env, encoding: 'utf8', timeout: 6000
    });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    assert.equal(f.journal().state, 'rolled_back');
    assert.equal(f.journal().sourceActivationPending, true);
    assert.equal(fs.existsSync(path.join(f.context.updatesRoot, 'authorization.json')), false,
      'bound authorization is settled before the old launcher may select the source version');
    assert.equal(fs.readFileSync(path.join(f.context.nativeRoot, 'active-version'), 'utf8').trim(), '2.5.1');
    assertSource(f);
    assert.ok(f.journal().bootstrapMigration.deadline > Date.now(), 'source activation recovery does not need to await health timeout');
    process.kill(watchdogPid, 'SIGCONT');
    const end = Date.now() + 6000;
    while (f.journal().sourceActivationPending && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(f.journal().sourceActivationPending, false);
    assert.equal(fs.readFileSync(path.join(f.context.nativeRoot, 'active-version'), 'utf8').trim(), '2.5.0');
    assert.match(f.journal().rollbackEvidence.bootstrapSha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(f.journal().stageRoot), false);
  });

function killAfterCommittedEvidence(f) {
  const code = `const fs=require('node:fs'),path=require('node:path');
const root=process.argv[1],journalPath=path.join(root,'native/updates/transaction.json');
const authorizationPath=path.join(root,'native/updates/authorization.json');
const {loadWithDependencies}=require(process.argv[2]);
const io={...fs,writeFileSync(filename,...args){
if(typeof filename==='string'&&filename.startsWith(authorizationPath+'.tmp-')){
const journal=JSON.parse(fs.readFileSync(journalPath,'utf8'));
if(journal.state==='committed'&&journal.committedEvidence)process.kill(process.pid,'SIGKILL');}
return fs.writeFileSync(filename,...args);}};
const updater=loadWithDependencies('native-host/src/updateManager.js',{'node:fs':io});
const journal=JSON.parse(fs.readFileSync(journalPath,'utf8'));
updater.handleUpdateRequest({id:'killed-confirm',method:'update.confirm',params:{transactionId:journal.id,
extensionVersion:'2.5.1',nativeVersion:'2.5.1',bootstrapRevision:'3.1'}},{env:process.env})
.then(result=>{process.stderr.write(JSON.stringify(result));process.exitCode=2;});`;
  const child = spawnSync(process.execPath, ['-e', code, f.root, path.join(repo, 'test/helpers/managedUpdateFixture.js')], {
    env: f.env, encoding: 'utf8', timeout: 6000
  });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.equal(f.journal().state, 'committed');
  assert.match(f.journal().committedEvidence.extensionSha256, /^[a-f0-9]{64}$/);
  assert.match(f.journal().committedEvidence.nativeSha256, /^[a-f0-9]{64}$/);
  assert.equal(read(path.join(f.context.updatesRoot, 'authorization.json')).state, 'bound');
  assert.equal(fs.existsSync(f.journal().stageRoot), true);
}

test('status finishes same-byte health commit cleanup after SIGKILL between durable receipt and consent settlement',
  { timeout: 10000, skip: process.platform === 'win32' }, async t => {
    const f = bootstrapMigrationFixture(t);
    await f.apply(); await f.migrate('3.1');
    killAfterCommittedEvidence(f);
    const evidence = f.journal().committedEvidence;
    const status = await f.request('update.status');
    assert.equal(status.transaction.state, 'committed');
    assert.equal(status.activeVersion, '2.5.1');
    assert.equal(fs.existsSync(path.join(f.context.updatesRoot, 'authorization.json')), false);
    assert.equal(fs.existsSync(f.journal().stageRoot), false);
    assert.deepEqual(f.journal().committedEvidence, evidence);
    assertTarget(f);
  });

test('interrupted commit cleanup preserves another authorization even when some identity fields match',
  { skip: process.platform === 'win32' }, async t => {
    for (const field of ['id', 'transactionId', 'sourceVersion', 'targetVersion']) {
      await t.test(field, async tt => {
        const f = bootstrapMigrationFixture(tt);
        await f.apply(); await f.migrate('3.1');
        killAfterCommittedEvidence(f);
        const filename = path.join(f.context.updatesRoot, 'authorization.json'), authorization = read(filename);
        authorization[field] = field.endsWith('Version') ? '2.5.2' : '22222222-2222-4222-8222-222222222222';
        write(filename, authorization);
        const bytes = fs.readFileSync(filename);
        const status = await f.request('update.status');
        assert.equal(status.transaction.state, 'committed');
        assert.deepEqual(fs.readFileSync(filename), bytes);
        assertTarget(f);
      });
    }
  });

test('interrupted commit cleanup keeps authorization and recovery archive when runtime or Bootstrap bytes changed',
  { skip: process.platform === 'win32' }, async t => {
    for (const component of ['extension', 'native', 'bootstrap']) {
      await t.test(component, async tt => {
        const f = bootstrapMigrationFixture(tt);
        await f.apply(); await f.migrate('3.1');
        killAfterCommittedEvidence(f);
        const authorizationPath = path.join(f.context.updatesRoot, 'authorization.json');
        const authorization = fs.readFileSync(authorizationPath);
        const file = component === 'extension' ? path.join(f.context.extensionRoot, 'runtime/src/main.js')
          : component === 'native' ? path.join(f.context.nativeRoot, 'versions/2.5.1/native-host/src/index.js')
            : path.join(f.context.extensionRoot, 'bootstrap/background.js');
        fs.appendFileSync(file, '\n// changed after the durable commit receipt\n');
        const changed = fs.readFileSync(file);
        await f.response('update.status');
        assert.deepEqual(fs.readFileSync(authorizationPath), authorization);
        assert.equal(fs.existsSync(f.journal().stageRoot), true);
        assert.deepEqual(fs.readFileSync(file), changed);
      });
    }
  });
