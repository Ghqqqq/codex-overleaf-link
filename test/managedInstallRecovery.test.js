'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { managedFixture, loadWithFs, pingInstalled, stageLocalUpdate } = require('./helpers/managedUpdateFixture');
const updater = require('../native-host/src/updateManager');
const { createCoordinatorHarness, UPDATE_KEY, CONSENT_KEY } = require('./helpers/updateCoordinatorHarness');

test('registration failure restores an existing extension and the actual Native launcher pair', async t => {
  const f = managedFixture(t);
  f.install('2.4.9');
  assert.equal(f.registry.get(f.registration.registryKey), f.registration.manifestPath);
  const active = path.join(f.context.nativeRoot, 'active-version');
  const manifest = path.join(f.context.extensionRoot, 'manifest.json');
  const oldManifest = fs.readFileSync(manifest);
  let injected = false;
  const faulty = f.loadInstallerWithFs({ ...fs, writeFileSync(file, ...args) {
    if (!injected && file === f.registration.manifestPath) {
      injected = true; throw Object.assign(new Error('Registration fixture failure'), { code: 'EACCES' });
    }
    return fs.writeFileSync(file, ...args);
  } });
  assert.throws(() => f.install('2.5.0', faulty), /Registration fixture failure/);
  assert.equal(injected, true);
  assert.deepEqual(fs.readFileSync(manifest), oldManifest);
  assert.equal(f.registry.get(f.registration.registryKey), f.registration.manifestPath);
  assert.equal(fs.readFileSync(active, 'utf8').trim(), '2.4.9');
  assert.equal(fs.existsSync(path.join(f.context.nativeRoot, 'versions/2.5.0')), false);
  assert.equal((await pingInstalled(f)).result.version, '2.4.9');
  assert.equal((await pingInstalled(f, 'update.status')).result.installedAligned, true);
});

test('same-version failed reinstall restores its prior Native bytes and registration modes', t => {
  const f = managedFixture(t);
  const oldPackage = f.packageFor('2.5.0');
  fs.writeFileSync(path.join(oldPackage, 'native-host/src/build-sentinel.txt'), 'old bytes');
  f.install('2.5.0');
  fs.chmodSync(f.bridge, 0o751);
  const originalMode = fs.statSync(f.bridge).mode & 0o777;
  const registration = fs.readFileSync(f.registration.manifestPath);
  const newPackage = f.packageFor('2.5.0', '-replacement');
  fs.writeFileSync(path.join(newPackage, 'native-host/src/build-sentinel.txt'), 'new bytes');
  let injected = false;
  const faulty = f.loadInstallerWithFs({ ...fs, writeFileSync(file, ...args) {
    if (!injected && file === f.registration.manifestPath) { injected = true; throw new Error('same-version failure'); }
    return fs.writeFileSync(file, ...args);
  } });
  assert.throws(() => f.install('2.5.0', faulty, '-replacement'), /same-version failure/);
  assert.equal(fs.readFileSync(path.join(f.context.nativeRoot, 'versions/2.5.0/native-host/src/build-sentinel.txt'), 'utf8'), 'old bytes');
  assert.equal(fs.statSync(f.bridge).mode & 0o777, originalMode);
  assert.deepEqual(fs.readFileSync(f.registration.manifestPath), registration);
  assert.equal(fs.existsSync(path.join(f.context.nativeRoot, 'previous-version')), false);
});

test('failed first registration removes newly created destinations and permits a clean retry', t => {
  const f = managedFixture(t);
  let injected = false;
  const faulty = f.loadInstallerWithFs({ ...fs, writeFileSync(file, ...args) {
    if (!injected && file === f.registration.manifestPath) { injected = true; throw new Error('first-install failure'); }
    return fs.writeFileSync(file, ...args);
  } });
  assert.throws(() => f.install('2.5.0', faulty), /first-install failure/);
  assert.equal(fs.existsSync(f.context.nativeRoot), false);
  assert.equal(fs.existsSync(f.context.extensionRoot), false);
  assert.equal(fs.existsSync(f.bridge), false);
  assert.equal(f.install('2.5.0').ok, true);
});

test('an interrupted Native copy leaves the old pair and no orphan version staging', t => {
  const f = managedFixture(t); f.install('2.4.9');
  let injected = false;
  const faulty = f.loadInstallerWithFs({ ...fs, copyFileSync(source, target, ...args) {
    if (!injected && target.includes(path.join('versions', '.2.5.0.staging-'))) { injected = true; throw new Error('copy failure'); }
    return fs.copyFileSync(source, target, ...args);
  } });
  assert.throws(() => f.install('2.5.0', faulty), /copy failure/);
  assert.deepEqual(fs.readdirSync(path.join(f.context.nativeRoot, 'versions')), ['2.4.9']);
  assert.equal(fs.readFileSync(path.join(f.context.nativeRoot, 'active-version'), 'utf8').trim(), '2.4.9');
});

test('successful same-target full reinstall retires the interrupted applying transaction', async t => {
  const f = managedFixture(t); f.install('2.4.9');
  const staged = await stageLocalUpdate(f);
  const journalFile = path.join(f.context.updatesRoot, 'transaction.json');
  const interrupted = loadWithFs('native-host/src/updateManager.js', { ...fs, renameSync(source, target) {
    if (target === journalFile && JSON.parse(fs.readFileSync(source, 'utf8')).state === 'awaiting_health') {
      throw Object.assign(new Error('Final journal persistence failed'), { code: 'EIO' });
    }
    return fs.renameSync(source, target);
  } });
  assert.throws(() => interrupted.applyStagedUpdate(f.context, { transactionId: staged.transactionId }), /Final journal/);
  assert.equal(JSON.parse(fs.readFileSync(journalFile)).state, 'applying');
  f.install('2.5.0');
  const status = await updater.handleUpdateRequest({ id: 'after-reinstall', method: 'update.status' }, { env: f.env });
  assert.equal(status.result.transaction.id, staged.transactionId);
  assert.equal(status.result.transaction.state, 'superseded');
  assert.equal(status.result.activeVersion, '2.5.0');
  assert.equal(status.result.authorization, null);
  assert.equal((await pingInstalled(f)).result.version, '2.5.0');
  assert.match(fs.readFileSync(path.join(f.context.extensionRoot, 'runtime/src/shared/compatibility.js'), 'utf8'), /BUILD_TARGET_VERSION = '2.5.0'/);
  assert.equal(fs.existsSync(path.join(f.context.nativeRoot, 'versions/2.5.0')), true);
  const h = await createCoordinatorHarness({ version: '2.5.0', onNative: request =>
    updater.handleUpdateRequest(request, { env: f.env }) });
  h.seed({ state: 'failed', recoveryPending: true, currentVersion: '2.4.9', latestVersion: '2.5.0',
    transactionId: staged.transactionId, operationId: 'old-operation' },
  { authorizationId: 'old-authorization', authorizedVersion: '2.5.0' });
  await h.send('codex-overleaf/consent-update-recover');
  assert.equal(h.data[UPDATE_KEY].recoveryPending, false);
  assert.equal(h.data[UPDATE_KEY].currentVersion, '2.5.0');
  assert.equal(h.data[CONSENT_KEY].authorizationId, '');
  assert.equal(h.events.some(event => event.method === 'update.rollback'), false);
});

test('failed same-target reinstall leaves the old transaction and its recovery slot intact', async t => {
  const f = managedFixture(t); f.install('2.4.9');
  const staged = await stageLocalUpdate(f);
  updater.applyStagedUpdate(f.context, { transactionId: staged.transactionId });
  const journal = path.join(f.context.updatesRoot, 'transaction.json');
  const before = fs.readFileSync(journal);
  let injected = false;
  const faulty = f.loadInstallerWithFs({ ...fs, writeFileSync(file, ...args) {
    if (!injected && file === f.registration.manifestPath) { injected = true; throw new Error('registration failed before settlement'); }
    return fs.writeFileSync(file, ...args);
  } });
  assert.throws(() => f.install('2.5.0', faulty), /before settlement/);
  assert.deepEqual(fs.readFileSync(journal), before);
  assert.equal(fs.existsSync(path.join(f.context.extensionRoot, 'slots/previous/runtime')), true);
  const restored = updater.rollbackUpdate(f.context, { transactionId: staged.transactionId, expectedState: 'awaiting_health' });
  assert.equal(restored.restoredPair.extensionVersion, '2.4.9');
});

test('full-install retirement rejects another journal and retains unrelated authorization', async t => {
  const f = managedFixture(t); f.install('2.4.9');
  const staged = await stageLocalUpdate(f);
  updater.applyStagedUpdate(f.context, { transactionId: staged.transactionId });
  const journal = JSON.parse(fs.readFileSync(path.join(f.context.updatesRoot, 'transaction.json')));
  assert.throws(() => updater.settleReinstalledUpdate(f.context, '2.5.0', { ...journal, id: 'other-transaction' }),
    { code: 'update_transaction_mismatch' });
  const authorizationFile = path.join(f.context.updatesRoot, 'authorization.json');
  const different = { ...JSON.parse(fs.readFileSync(authorizationFile)), id: 'unrelated-authorization', transactionId: 'different' };
  fs.writeFileSync(authorizationFile, JSON.stringify(different));
  f.install('2.5.0');
  assert.deepEqual(JSON.parse(fs.readFileSync(authorizationFile)), different);
});

test('a failed compensation is reported explicitly instead of claiming the prior pair was restored', t => {
  const f = managedFixture(t); f.install('2.4.9');
  const active = path.join(f.context.nativeRoot, 'active-version');
  const originalWrite = fs.writeFileSync;
  const faulty = f.loadInstallerWithFs({ ...fs, writeFileSync(file, ...args) {
    if (file === f.registration.manifestPath) throw new Error('registration fixture error');
    return originalWrite(file, ...args);
  } });
  fs.writeFileSync = (file, ...args) => {
    if (file === active) throw new Error('restore write fixture error');
    return originalWrite(file, ...args);
  };
  try { assert.throws(() => f.install('2.5.0', faulty), { code: 'managed_install_restore_failed' }); }
  finally { fs.writeFileSync = originalWrite; }
});

test('shared mutation lock recovery preserves live and newly written owners', t => {
  const f = managedFixture(t); f.install('2.5.0');
  const lock = path.join(f.context.updatesRoot, 'mutation.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'live', expiresAt: 0 }));
  assert.equal(updater.removeStaleUpdateFileLock(lock), false);
  fs.writeFileSync(lock, '');
  assert.equal(updater.removeStaleUpdateFileLock(lock), false, 'exclusive-open before owner write remains protected');
  fs.utimesSync(lock, 1, 1);
  assert.equal(updater.removeStaleUpdateFileLock(lock), true, 'old unreadable owner can be reclaimed');
  fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647, token: 'dead', expiresAt: Date.now() + 60000 }));
  assert.equal(updater.removeStaleUpdateFileLock(lock), true, 'confirmed absent process does not wait for expiry');
});

test('an installation completed before lock acquisition is retained when the next extension swap fails', t => {
  const f = managedFixture(t);
  let advanced = false;
  const recovery = loadWithFs('native-host/src/managedInstallRecovery.js', { ...fs, openSync(filename, ...args) {
    if (!advanced && filename === path.join(f.context.updatesRoot, 'mutation.lock')) {
      advanced = true;
      // Another installer completed after initial path checks but before the
      // next owner acquired the lock. Filesystem I/O provides this ordering.
      // Remove only the empty directories the acquiring helper just made.
      fs.rmdirSync(f.context.updatesRoot); fs.rmdirSync(f.context.nativeRoot);
      f.install('2.4.9');
    }
    return fs.openSync(filename, ...args);
  } });
  let failed = false;
  const faulty = f.loadInstaller({
    './managedInstallRecovery': recovery,
    'node:fs': { ...fs, renameSync(source, target) {
      if (!failed && source === f.context.extensionRoot) { failed = true; throw new Error('swap failure after other install'); }
      return fs.renameSync(source, target);
    } }
  });
  assert.throws(() => f.install('2.5.0', faulty), /swap failure/);
  assert.equal(advanced, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.context.extensionRoot, 'manifest.json'))).version, '2.4.9');
  assert.equal(fs.readFileSync(path.join(f.context.nativeRoot, 'active-version'), 'utf8').trim(), '2.4.9');
  assert.equal(fs.existsSync(path.join(f.context.nativeRoot, 'versions/2.4.9/native-host/src/index.js')), true);
});

test('first-install compensation cannot erase a successor after its own Native root is removed', t => {
  const f = managedFixture(t);
  let intervened = false;
  function afterRemoval(filename) {
    if (filename === f.context.nativeRoot && !intervened) {
      intervened = true;
      assert.equal(f.install('2.5.0').ok, true);
    }
  }
  const recovery = loadWithFs('native-host/src/managedInstallRecovery.js', { ...fs,
    rmSync(filename, ...args) { const result = fs.rmSync(filename, ...args); afterRemoval(filename); return result; },
    rmdirSync(filename, ...args) { const result = fs.rmdirSync(filename, ...args); afterRemoval(filename); return result; }
  });
  let injected = false;
  const faulty = f.loadInstaller({
    './managedInstallRecovery': recovery,
    'node:fs': { ...fs, writeFileSync(filename, ...args) {
      if (!injected && filename === f.registration.manifestPath) { injected = true; throw new Error('first registration failed'); }
      return fs.writeFileSync(filename, ...args);
    } }
  });
  assert.throws(() => f.install('2.6.0', faulty), /first registration failed/);
  assert.equal(intervened, true);
  assert.equal(fs.readFileSync(path.join(f.context.nativeRoot, 'active-version'), 'utf8').trim(), '2.5.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.context.nativeRoot, '.codex-overleaf-managed-native.json'))).version, '2.5.0');
  assert.equal(fs.existsSync(f.bridge), true);
});
