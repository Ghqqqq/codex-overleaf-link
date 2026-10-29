'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { managedFixture, loadWithFs, pingInstalled, stageLocalUpdate } = require('../helpers/managedUpdateFixture');
const updater = require('../../native-host/src/updateManager');
const targetVersion = require('../../package.json').version;
const sourceVersion = '0.0.1';

// Synthetic version numbers exercise filesystem/process behavior. Compatibility
// with an actual published predecessor is checked by verify:update-hop.
test('failed registration preserves an installed pair that can still start', async t => {
  const f = managedFixture(t);
  f.install(sourceVersion);
  const manifestPath = path.join(f.context.extensionRoot, 'manifest.json');
  const original = fs.readFileSync(manifestPath);
  let failed = false;
  const faulty = f.loadInstallerWithFs({ ...fs, writeFileSync(file, ...args) {
    if (!failed && file === f.registration.manifestPath) {
      failed = true;
      throw Object.assign(new Error('Registration unavailable'), { code: 'EACCES' });
    }
    return fs.writeFileSync(file, ...args);
  } });
  assert.throws(() => f.install(targetVersion, faulty), /Registration unavailable/);
  assert.equal(failed, true);
  assert.deepEqual(fs.readFileSync(manifestPath), original);
  assert.equal(f.registry.get(f.registration.registryKey), f.registration.manifestPath);
  assert.equal((await pingInstalled(f)).result.version, sourceVersion);
  assert.equal((await pingInstalled(f, 'update.status')).result.installedAligned, true);
});

test('failed same-version reinstall retains the previous executable bytes', async t => {
  const f = managedFixture(t);
  const originalPackage = f.packageFor(targetVersion);
  const sentinel = 'native-host/src/install-sentinel.txt';
  fs.writeFileSync(path.join(originalPackage, sentinel), 'original');
  f.install(targetVersion);
  const replacement = f.packageFor(targetVersion, '-replacement');
  fs.writeFileSync(path.join(replacement, sentinel), 'replacement');
  let failed = false;
  const faulty = f.loadInstallerWithFs({ ...fs, writeFileSync(file, ...args) {
    if (!failed && file === f.registration.manifestPath) {
      failed = true;
      throw new Error('Registration unavailable');
    }
    return fs.writeFileSync(file, ...args);
  } });
  assert.throws(() => f.install(targetVersion, faulty, '-replacement'), /Registration unavailable/);
  assert.equal(fs.readFileSync(path.join(f.context.nativeRoot, 'versions', targetVersion, sentinel), 'utf8'), 'original');
  assert.equal((await pingInstalled(f)).result.version, targetVersion);
});

test('signed update activates the paired runtimes and the installed Native confirms health', async t => {
  const f = managedFixture(t);
  f.install(sourceVersion);
  const staged = await stageLocalUpdate(f, targetVersion);
  updater.applyStagedUpdate(f.context, { transactionId: staged.transactionId });
  const extension = JSON.parse(fs.readFileSync(path.join(f.context.extensionRoot, 'manifest.json')));
  const ping = await pingInstalled(f);
  assert.equal(extension.version, targetVersion);
  assert.equal(ping.result.version, targetVersion);
  assert.equal((await pingInstalled(f, 'update.status')).result.installedAligned, true);
  const confirmed = await pingInstalled(f, 'update.confirm', {
    transactionId: staged.transactionId, extensionVersion: extension.version, nativeVersion: ping.result.version
  });
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed.error));
  assert.equal(confirmed.result.state, 'committed');
  assert.equal((await pingInstalled(f, 'update.status')).result.transaction.state, 'committed');
});

test('failed update restoration remains retryable and restores a runnable source pair', async t => {
  const f = managedFixture(t);
  f.install(sourceVersion);
  const staged = await stageLocalUpdate(f, targetVersion);
  updater.applyStagedUpdate(f.context, { transactionId: staged.transactionId });
  const runtime = path.join(f.context.extensionRoot, 'runtime');
  const faulty = loadWithFs('native-host/src/updateManager.js', { ...fs, renameSync(source, target) {
    if (target === runtime) throw new Error('Restore unavailable');
    return fs.renameSync(source, target);
  } });
  assert.throws(() => faulty.rollbackUpdate(f.context, { transactionId: staged.transactionId }), /Restore unavailable/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.context.updatesRoot, 'transaction.json'))).state, 'awaiting_health');
  const restored = updater.rollbackUpdate(f.context, { transactionId: staged.transactionId });
  assert.equal(restored.restoredPair.nativeVersion, sourceVersion);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.context.extensionRoot, 'manifest.json'))).version, sourceVersion);
  assert.equal((await pingInstalled(f)).result.version, sourceVersion);
});

test('interrupted terminal rollback settles only its authorization after verifying the restored files', async t => {
  const f = managedFixture(t);
  f.install(sourceVersion);
  const staged = await stageLocalUpdate(f, targetVersion);
  updater.applyStagedUpdate(f.context, { transactionId: staged.transactionId });
  const journalPath = path.join(f.context.updatesRoot, 'transaction.json');
  const authorizationPath = path.join(f.context.updatesRoot, 'authorization.json');
  const faulty = loadWithFs('native-host/src/updateManager.js', { ...fs, renameSync(source, target) {
    const result = fs.renameSync(source, target);
    if (target === journalPath && JSON.parse(fs.readFileSync(target)).state === 'rolled_back') {
      throw new Error('Interrupted after rollback journal');
    }
    return result;
  } });
  assert.throws(() => faulty.rollbackUpdate(f.context, { transactionId: staged.transactionId,
    reasonCode: 'update_user_rollback' }), /Interrupted after rollback journal/);
  const journal = JSON.parse(fs.readFileSync(journalPath));
  const authorization = JSON.parse(fs.readFileSync(authorizationPath));
  assert.equal(authorization.state, 'bound');
  assert.equal(fs.existsSync(journal.stageRoot), true);
  const compatibility = path.join(f.context.extensionRoot, 'runtime/src/shared/compatibility.js');
  const original = fs.readFileSync(compatibility);
  fs.appendFileSync(compatibility, '\n');
  const changed = (await pingInstalled(f, 'update.status')).result;
  assert.equal(changed.restoredPair, null);
  assert.equal(changed.authorization.state, 'bound');
  assert.equal(fs.existsSync(journal.stageRoot), true);
  fs.writeFileSync(compatibility, original);
  const unrelated = { ...authorization, transactionId: require('node:crypto').randomUUID() };
  fs.writeFileSync(authorizationPath, JSON.stringify(unrelated));
  await pingInstalled(f, 'update.status');
  assert.deepEqual(JSON.parse(fs.readFileSync(authorizationPath)), unrelated);
  assert.equal(fs.existsSync(journal.stageRoot), false);
  fs.writeFileSync(authorizationPath, JSON.stringify(authorization));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const recovered = (await pingInstalled(f, 'update.status')).result;
    assert.equal(recovered.transaction.state, 'rolled_back');
    assert.deepEqual(recovered.restoredPair, journal.rollbackEvidence);
    assert.equal(recovered.authorization, null);
  }
  assert.equal((await pingInstalled(f)).result.version, sourceVersion);
  const next = await stageLocalUpdate(f, targetVersion);
  assert.notEqual(next.transactionId, staged.transactionId);
});

test('early interrupted apply ignores a stale previous slot only when the current source files verify', async t => {
  const f = managedFixture(t);
  f.install(sourceVersion);
  const currentVersion = '0.0.2';
  const previous = await stageLocalUpdate(f, currentVersion);
  updater.applyStagedUpdate(f.context, { transactionId: previous.transactionId });
  assert.equal((await pingInstalled(f, 'update.confirm', { transactionId: previous.transactionId,
    extensionVersion: currentVersion, nativeVersion: currentVersion })).ok, true);
  const staged = await stageLocalUpdate(f, targetVersion);
  const journalPath = path.join(f.context.updatesRoot, 'transaction.json');
  const faulty = loadWithFs('native-host/src/updateManager.js', { ...fs, renameSync(source, target) {
    const result = fs.renameSync(source, target);
    if (target === journalPath && JSON.parse(fs.readFileSync(target)).state === 'applying') {
      throw new Error('Interrupted before source backup');
    }
    return result;
  } });
  assert.throws(() => faulty.applyStagedUpdate(f.context, { transactionId: staged.transactionId }),
    /Interrupted before source backup/);
  const asset = path.join(f.context.extensionRoot, 'runtime/src/content/generated/content.bundle.js');
  const original = fs.readFileSync(asset);
  fs.rmSync(asset);
  const unavailable = await pingInstalled(f, 'update.status');
  assert.equal(unavailable.error?.code, 'update_rollback_source_unavailable');
  assert.equal(JSON.parse(fs.readFileSync(journalPath)).state, 'applying');
  fs.writeFileSync(asset, original);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const recovered = (await pingInstalled(f, 'update.status')).result;
    assert.equal(recovered.transaction.state, 'rolled_back');
    assert.equal(recovered.restoredPair.extensionVersion, currentVersion);
    assert.equal(recovered.restoredPair.nativeVersion, currentVersion);
    assert.deepEqual(recovered.restoredPair, JSON.parse(fs.readFileSync(journalPath)).rollbackEvidence);
    assert.equal(recovered.authorization, null);
  }
  assert.equal((await pingInstalled(f)).result.version, currentVersion);
});

test('tampered signed inputs cannot stage or replace the installed pair', async t => {
  const f = managedFixture(t);
  f.install(sourceVersion);
  const manifestPath = path.join(f.context.extensionRoot, 'manifest.json');
  const original = fs.readFileSync(manifestPath);
  for (const [tamper, code] of [
    ['signature', 'update_signature_invalid'],
    ['archive', 'update_bundle_hash_mismatch']
  ]) {
    await assert.rejects(stageLocalUpdate(f, targetVersion, { tamper }), { code });
    assert.deepEqual(fs.readFileSync(manifestPath), original);
    assert.equal(fs.existsSync(path.join(f.context.updatesRoot, 'transaction.json')), false);
    assert.equal((await pingInstalled(f)).result.version, sourceVersion);
    assert.equal((await pingInstalled(f, 'update.status')).result.installedAligned, true);
  }
});
