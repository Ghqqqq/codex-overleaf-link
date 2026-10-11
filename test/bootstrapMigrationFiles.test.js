'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { loadWithFs } = require('./helpers/managedUpdateFixture');
const migration = require('../native-host/src/bootstrapMigration');
const { buildBootstrapMigrationDescriptor, BOOTSTRAP_MIGRATION_BASELINE } = require('../native-host/src/bootstrapMigrationContract');
const old = require('./fixtures/bootstrap-v2.5.0.json');
const repo = path.resolve(__dirname, '..');
const { writeMigrationTemplate } = require('./helpers/bootstrapMigrationPackage');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const extensionRoot = path.join(root, 'installed');
  const packageRoot = path.join(root, 'package');
  const payloadRoot = path.join(packageRoot, 'extension');
  fs.mkdirSync(path.join(extensionRoot, 'bootstrap'), { recursive: true });
  fs.mkdirSync(payloadRoot, { recursive: true });
  fs.cpSync(path.join(repo, 'extension/bootstrap'), path.join(payloadRoot, 'bootstrap'), { recursive: true });
  writeMigrationTemplate(path.join(payloadRoot, 'bootstrap/manifest.template.json'));
  for (const [relative, contents] of Object.entries(old.files)) {
    fs.writeFileSync(path.join(extensionRoot, relative), contents);
    fs.chmodSync(path.join(extensionRoot, relative), 0o644);
  }
  // Keep unrelated data in every fixture; all recovery cases must preserve it.
  fs.writeFileSync(path.join(extensionRoot, 'manifest.json'), '{"version":"2.5.1","preserved":true}\n');
  fs.writeFileSync(path.join(extensionRoot, 'settings.json'), 'private user settings\n');
  const descriptor = buildBootstrapMigrationDescriptor({ packageRoot, version: '2.5.1' });
  return { root, extensionRoot, payloadRoot,
    options: { descriptor, extensionRoot, payloadRoot, backupRoot: path.join(root, 'updates/bootstrap-migrations'),
      transactionId: 'transaction-one', sourceVersion: '2.5.0', targetVersion: '2.5.1' } };
}

function expectSource(f) {
  for (const [relative, contents] of Object.entries(old.files)) assert.equal(fs.readFileSync(path.join(f.extensionRoot, relative), 'utf8'), contents);
  assert.equal(fs.existsSync(path.join(f.extensionRoot, 'bootstrap/popupFallback.js')), false);
  expectUserData(f);
}
function expectTarget(f) {
  for (const file of f.options.descriptor.files) assert.deepEqual(fs.readFileSync(path.join(f.extensionRoot, file.path)), fs.readFileSync(path.join(f.payloadRoot, file.path)));
  expectUserData(f);
}
function expectUserData(f) {
  assert.equal(fs.readFileSync(path.join(f.extensionRoot, 'manifest.json'), 'utf8'), '{"version":"2.5.1","preserved":true}\n');
  assert.equal(fs.readFileSync(path.join(f.extensionRoot, 'settings.json'), 'utf8'), 'private user settings\n');
}
function crashAt(index, f) {
  let step = 0;
  return { onStep() {
    assert.ok(fs.existsSync(path.join(f.extensionRoot, 'bootstrap/background.js')), 'the entry is never moved away');
    if (step++ === index) throw Object.assign(new Error('simulated process interruption'), { code: 'TEST_INTERRUPTION' });
  } };
}

test('migration uses exact published 2.5.0 Bootstrap bytes as its source fixture', () => {
  assert.equal(old.source, 'v2.5.0');
  assert.match(old.commit, /^[a-f0-9]{40}$/);
  for (const [relative, expected] of Object.entries(BOOTSTRAP_MIGRATION_BASELINE)) {
    const actual = old.files[relative] === undefined ? null : crypto.createHash('sha256').update(old.files[relative]).digest('hex');
    assert.equal(actual, expected, relative);
  }
});

test('apply and restore are durable, reloadable, idempotent, mode-preserving and limited to Bootstrap files', t => {
  const f = fixture(t);
  const modeFile = path.join(f.extensionRoot, 'bootstrap/background.js');
  fs.chmodSync(modeFile, 0o640);
  const plan = migration.prepareBootstrapMigration(f.options);
  assert.equal(plan.state, 'prepared');
  assert.deepEqual(migration.prepareBootstrapMigration(f.options), plan);
  const applied = migration.applyBootstrapMigration(plan);
  assert.equal(applied.state, 'applied');
  assert.equal(applied.digest, plan.targetDigest);
  assert.equal(fs.statSync(modeFile).mode & 0o777, process.platform === 'win32' ? 0o666 : 0o640);
  expectTarget(f);
  const reloaded = migration.loadBootstrapMigration(f.options);
  assert.deepEqual(migration.applyBootstrapMigration(reloaded), applied);
  const restored = migration.restoreBootstrapMigration(reloaded);
  assert.equal(restored.state, 'restored');
  assert.equal(restored.digest, plan.sourceDigest);
  expectSource(f);
  assert.deepEqual(migration.restoreBootstrapMigration(plan), restored);
  assert.throws(() => migration.applyBootstrapMigration(plan), { code: 'update_bootstrap_already_restoring' });
  assert.ok(fs.existsSync(path.join(plan.recordRoot, 'files/bootstrap/background.js')), 'recovery material survives all terminal states');
});

test('new popup dependency is installed before HTML and removed after HTML restoration', t => {
  const f = fixture(t), plan = migration.prepareBootstrapMigration(f.options), applied = [], restored = [];
  migration.applyBootstrapMigration(plan, { onStep: s => { if (s.phase === 'apply:replaced') applied.push(path.basename(s.path)); } });
  assert.ok(applied.indexOf('popupFallback.js') < applied.indexOf('popup.html'));
  assert.equal(applied.at(-1), 'background.js');
  migration.restoreBootstrapMigration(plan, { onStep: s => { if (s.phase === 'restore:replaced' || s.phase === 'restore:removed') restored.push(path.basename(s.path)); } });
  assert.ok(restored.indexOf('popup.html') < restored.indexOf('popupFallback.js'));
});

test('every preparation persistence point can be interrupted and safely retried', t => {
  const base = fixture(t); let count = 0;
  migration.prepareBootstrapMigration(base.options, { onStep: () => count++ });
  for (let cut = 0; cut < count; cut++) {
    const f = fixture(t);
    assert.throws(() => migration.prepareBootstrapMigration(f.options, crashAt(cut, f)), { code: 'TEST_INTERRUPTION' });
    expectSource(f);
    const plan = migration.prepareBootstrapMigration(f.options);
    migration.applyBootstrapMigration(plan);
    expectTarget(f);
    migration.restoreBootstrapMigration(plan);
    expectSource(f);
  }
});

test('every apply persistence point resumes or rolls back with the entry always present', t => {
  const base = fixture(t), baseline = migration.prepareBootstrapMigration(base.options); let count = 0;
  migration.applyBootstrapMigration(baseline, { onStep: () => count++ });
  for (let cut = 0; cut < count; cut++) {
    for (const recover of ['resume', 'restore']) {
      const f = fixture(t), plan = migration.prepareBootstrapMigration(f.options);
      assert.throws(() => migration.applyBootstrapMigration(plan, crashAt(cut, f)), { code: 'TEST_INTERRUPTION' });
      const reloaded = migration.loadBootstrapMigration(f.options);
      if (recover === 'resume') { migration.applyBootstrapMigration(reloaded); expectTarget(f); }
      migration.restoreBootstrapMigration(reloaded);
      expectSource(f);
    }
  }
});

test('every rollback persistence point is repeatable after an interrupted restoration', t => {
  const base = fixture(t), baseline = migration.prepareBootstrapMigration(base.options); let count = 0;
  migration.applyBootstrapMigration(baseline);
  migration.restoreBootstrapMigration(baseline, { onStep: () => count++ });
  for (let cut = 0; cut < count; cut++) {
    const f = fixture(t), plan = migration.prepareBootstrapMigration(f.options);
    migration.applyBootstrapMigration(plan);
    assert.throws(() => migration.restoreBootstrapMigration(plan, crashAt(cut, f)), { code: 'TEST_INTERRUPTION' });
    migration.restoreBootstrapMigration(migration.loadBootstrapMigration(f.options));
    expectSource(f);
  }
});

test('a killed process resumes from disk after the entry replacement and before the completion journal', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), plan = migration.prepareBootstrapMigration(f.options);
  const code = `const m=require(process.argv[1]);const plan=JSON.parse(process.argv[2]);m.applyBootstrapMigration(plan,{onStep(s){if(s.phase==='apply:replaced'&&s.path.endsWith('/bootstrap/background.js'))process.kill(process.pid,'SIGKILL');}});`;
  const result = spawnSync(process.execPath, ['-e', code, path.join(repo, 'native-host/src/bootstrapMigration.js'), JSON.stringify(plan)], { encoding: 'utf8' });
  assert.equal(result.signal, 'SIGKILL', result.stderr);
  const recovered = migration.loadBootstrapMigration(f.options);
  assert.equal(recovered.state, 'applying');
  assert.equal(recovered.pending, 'bootstrap/background.js');
  migration.applyBootstrapMigration(recovered);
  expectTarget(f);
  migration.restoreBootstrapMigration(recovered);
  expectSource(f);
});

test('unknown source, target payload and corrupted backup are refused without overwriting user data', t => {
  const source = fixture(t);
  fs.appendFileSync(path.join(source.extensionRoot, 'bootstrap/update.js'), '\n// locally edited\n');
  assert.throws(() => migration.prepareBootstrapMigration(source.options), { code: 'update_bootstrap_source_mismatch' });
  assert.equal(fs.existsSync(path.join(source.options.backupRoot, 'transaction-one/state.json')), false);
  const payload = fixture(t);
  fs.appendFileSync(path.join(payload.payloadRoot, 'bootstrap/background.js'), '\n// corrupt download\n');
  assert.throws(() => migration.prepareBootstrapMigration(payload.options), { code: 'update_bootstrap_payload_mismatch' });
  expectSource(payload);
  const backup = fixture(t), plan = migration.prepareBootstrapMigration(backup.options);
  fs.appendFileSync(path.join(plan.recordRoot, 'files/bootstrap/background.js'), '\n// corrupt backup\n');
  assert.throws(() => migration.applyBootstrapMigration(plan), { code: 'update_bootstrap_backup_mismatch' });
  expectSource(backup);
});

test('late third-party edits prevent both continuation and rollback', t => {
  const f = fixture(t), plan = migration.prepareBootstrapMigration(f.options);
  migration.applyBootstrapMigration(plan);
  const changed = path.join(f.extensionRoot, 'bootstrap/background.js');
  fs.appendFileSync(changed, '\n// preserve this edit\n');
  const bytes = fs.readFileSync(changed);
  assert.throws(() => migration.applyBootstrapMigration(plan), { code: 'update_bootstrap_source_mismatch' });
  assert.throws(() => migration.restoreBootstrapMigration(plan), { code: 'update_bootstrap_source_mismatch' });
  assert.deepEqual(fs.readFileSync(changed), bytes);
});

test('disk-full, read-only and permission failures preserve a recoverable source entry', t => {
  for (const code of ['ENOSPC', 'EROFS', 'EACCES']) {
    const f = fixture(t), plan = migration.prepareBootstrapMigration(f.options);
    const target = path.join(f.extensionRoot, 'bootstrap/background.js');
    const faulty = loadWithFs('native-host/src/bootstrapMigration.js', { ...fs, renameSync(source, destination) {
      if (destination === target) throw Object.assign(new Error('simulated ' + code), { code });
      fs.renameSync(source, destination);
    } });
    assert.throws(() => faulty.applyBootstrapMigration(plan), { code });
    assert.equal(fs.readFileSync(target, 'utf8'), old.files['bootstrap/background.js']);
    assert.equal(migration.loadBootstrapMigration(f.options).state, 'applying');
    migration.restoreBootstrapMigration(plan);
    expectSource(f);
  }
});

test('symlink targets and symlink parents are rejected', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), victim = path.join(f.root, 'victim'); fs.writeFileSync(victim, 'unrelated');
  const target = path.join(f.extensionRoot, 'bootstrap/background.js'); fs.unlinkSync(target);
  fs.symlinkSync(victim, target);
  assert.throws(() => migration.prepareBootstrapMigration(f.options), { code: 'update_bootstrap_path_unsafe' });
  assert.equal(fs.readFileSync(victim, 'utf8'), 'unrelated');
  const dirs = fixture(t); fs.renameSync(path.join(dirs.extensionRoot, 'bootstrap'), path.join(dirs.root, 'outside'));
  fs.symlinkSync(path.join(dirs.root, 'outside'), path.join(dirs.extensionRoot, 'bootstrap'), 'dir');
  assert.throws(() => migration.prepareBootstrapMigration(dirs.options), { code: 'update_bootstrap_path_unsafe' });
});

test('journal substitution, transaction mismatch and path escape are rejected', t => {
  const journal = fixture(t), plan = migration.prepareBootstrapMigration(journal.options);
  assert.throws(() => migration.loadBootstrapMigration({ backupRoot: plan.backupRoot, transactionId: '../escape' }), { code: 'update_bootstrap_transaction_invalid' });
  const other = fixture(t);
  assert.throws(() => migration.prepareBootstrapMigration({ ...journal.options, extensionRoot: other.extensionRoot }), { code: 'update_bootstrap_transaction_mismatch' });
  const record = JSON.parse(fs.readFileSync(plan.journalPath)); record.files[0].path = '../victim';
  fs.writeFileSync(plan.journalPath, JSON.stringify(record));
  assert.throws(() => migration.loadBootstrapMigration(journal.options), { code: 'update_bootstrap_record_invalid' });
});
