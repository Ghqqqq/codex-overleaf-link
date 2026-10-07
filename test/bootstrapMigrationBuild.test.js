'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const Contract = require('../native-host/src/bootstrapMigrationContract');
const { buildRuntimeFileManifest, installRuntimeFromPackage } = require('../native-host/src/runtimeInstaller');
const { isAllowedUpdatePath } = require('../native-host/src/updateArchive');
const repoRoot = path.resolve(__dirname, '..');
const descriptor = () => Contract.buildBootstrapMigrationDescriptor({ packageRoot: repoRoot, version: '2.5.1' });

async function boundary() {
  const previous = process.env.CODEX_OVERLEAF_TEST_IMPORT;
  process.env.CODEX_OVERLEAF_TEST_IMPORT = '1';
  try { return await import(pathToFileURL(path.join(repoRoot, 'scripts/verify-update-boundary.mjs')).href); }
  finally {
    if (previous === undefined) delete process.env.CODEX_OVERLEAF_TEST_IMPORT;
    else process.env.CODEX_OVERLEAF_TEST_IMPORT = previous;
  }
}

test('migration descriptor hashes the complete target Bootstrap against a closed published source baseline', () => {
  const value = descriptor();
  assert.equal(value.targetRevision, '3.1');
  assert.deepEqual(value.sourceVersions, ['2.5.0']);
  assert.equal(value.files.length, 10);
  assert.equal(value.files.find(file => file.path === 'bootstrap/popupFallback.js').sourceSha256, null);
  for (const file of value.files) {
    assert.equal(file.sourceSha256, Contract.BOOTSTRAP_MIGRATION_BASELINE[file.path]);
    assert.equal(file.targetSha256, crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(repoRoot, 'extension', file.path))).digest('hex'));
  }
  assert.equal(Contract.buildBootstrapMigrationDescriptor({ packageRoot: repoRoot, version: '2.5.2' }), null);
});

test('descriptor rejects widened versions, protocols, paths, source hashes, missing and duplicate files', () => {
  const mutations = [
    value => { value.sourceVersions.push('2.4.1'); },
    value => { value.targetVersion = '2.5.2'; },
    value => { value.bootstrapProtocol = 4; },
    value => { value.targetRevision = '3.2'; },
    value => { value.files[0].path = '../bootstrap/background.js'; },
    value => { value.files[0].sourceSha256 = 'a'.repeat(64); },
    value => { value.files[0].targetSha256 = 'bad'; },
    value => { value.files.pop(); },
    value => { value.files[0] = value.files[1]; }
  ];
  for (const mutate of mutations) {
    const value = descriptor(); mutate(value);
    assert.throws(() => Contract.validateBootstrapMigrationDescriptor(value), /Bootstrap migration/);
  }
  assert.throws(() => Contract.validateBootstrapMigrationDescriptor(descriptor(), { targetVersion: '2.5.0' }), /descriptor/);
});

test('Bootstrap migration preserves all manifest shape fields including permissions and extension key', () => {
  const template = JSON.parse(fs.readFileSync(path.join(repoRoot, 'extension/bootstrap/manifest.template.json')));
  assert.doesNotThrow(() => Contract.assertBootstrapManifestShape(template, { version: '2.5.1' }));
  for (const changed of [{ ...template, key: 'different' }, { ...template, permissions: [...template.permissions, 'tabs'] },
    { ...template, action: {} }, { ...template, version: '2.5.0' }]) {
    assert.throws(() => Contract.assertBootstrapManifestShape(changed, { version: '2.5.1' }), /manifest shape/);
  }
});

test('runtime payload maps original source paths and remains inside the legacy archive namespace', () => {
  const entries = buildRuntimeFileManifest({ packageRoot: repoRoot });
  for (const name of ['manifest.template.json', ...Contract.BOOTSTRAP_MIGRATION_FILES]) {
    const target = 'native-host/bootstrap-payload/' + name;
    const entry = entries.find(value => value.relativePath === target);
    assert.ok(entry, target);
    const source = name === 'manifest.template.json' ? 'extension/bootstrap/' + name : 'extension/' + name;
    assert.equal(entry.sourceRelativePath, source);
    assert.equal(entry.sourcePath, path.join(repoRoot, source));
    assert.equal(isAllowedUpdatePath('native-runtime/' + target), true);
  }
  const filtered = buildRuntimeFileManifest({ packageRoot: repoRoot,
    allowedFiles: new Set(['extension/bootstrap/background.js', 'native-host/bootstrap-payload/bootstrap/popup.html']) });
  assert.deepEqual(filtered.map(entry => entry.relativePath), ['native-host/bootstrap-payload/bootstrap/background.js']);
});

test('full runtime install materializes payload from source and can reinstall a standalone mapped Native package', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'col-bootstrap-payload-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'first/runtime'), second = path.join(root, 'second/runtime');
  installRuntimeFromPackage({ packageRoot: repoRoot, runtimeRoot: first });
  installRuntimeFromPackage({ packageRoot: first, runtimeRoot: second });
  for (const file of descriptor().files) {
    assert.deepEqual(fs.readFileSync(path.join(second, 'native-host/bootstrap-payload', file.path)),
      fs.readFileSync(path.join(repoRoot, 'extension', file.path)));
  }
});

test('installer exemption is limited to the exact warning presentation line', async () => {
  const { isManagedInstallerPresentationOnlyChange } = await boundary();
  const current = fs.readFileSync(path.join(repoRoot, 'scripts/install-managed.mjs'), 'utf8');
  const warning = "    ...(result.warning ? ['Warning: ' + result.warning] : []),\n";
  const previous = current.replace(warning, '');
  assert.notEqual(previous, current);
  assert.equal(isManagedInstallerPresentationOnlyChange(previous, current), true);
  assert.equal(isManagedInstallerPresentationOnlyChange(previous, current + '\nthrow new Error();'), false);
  assert.equal(isManagedInstallerPresentationOnlyChange(current, previous), false);
  assert.equal(isManagedInstallerPresentationOnlyChange(previous, current.replace('result.warning]', 'result.ok]')), false);
});

test('migration boundary rejects unknown source bytes and a changed protocol', async () => {
  const { coveredBootstrapMigrationPaths } = await boundary();
  const input = { descriptor: descriptor(), previousVersion: '2.5.0', currentVersion: '2.5.1',
    previousProtocol: 3, currentProtocol: 3,
    readPreviousFile: () => Buffer.from('unknown local edit'),
    readCurrentFile: relativePath => fs.readFileSync(path.join(repoRoot, relativePath)) };
  assert.throws(() => coveredBootstrapMigrationPaths(input), /source\/target bytes/);
  assert.throws(() => coveredBootstrapMigrationPaths({ ...input, previousVersion: '2.4.1' }), /version\/protocol/);
  assert.throws(() => coveredBootstrapMigrationPaths({ ...input, currentProtocol: 4 }), /version\/protocol/);
});

test('migration boundary covers only the closed Bootstrap list with the actual published source bytes', async () => {
  const { coveredBootstrapMigrationPaths } = await boundary();
  const legacy = require('./fixtures/bootstrap-v2.5.0.json');
  const input = { descriptor: descriptor(), previousVersion: '2.5.0', currentVersion: '2.5.1',
    previousProtocol: 3, currentProtocol: 3,
    readPreviousFile: relativePath => legacy.files[relativePath.slice('extension/'.length)] ?? null,
    readCurrentFile: relativePath => fs.readFileSync(path.join(repoRoot, relativePath)) };
  const covered = coveredBootstrapMigrationPaths(input);
  assert.deepEqual([...covered], Contract.BOOTSTRAP_MIGRATION_FILES.map(file => 'extension/' + file));
  for (const file of ['native-host/src/launcher.js', 'native-host/src/updateTrust.js',
    'extension/bootstrap/manifest.template.json', 'extension/bootstrap/unknown.js']) assert.equal(covered.has(file), false);
  assert.throws(() => coveredBootstrapMigrationPaths({ ...input,
    readCurrentFile: () => Buffer.from('unexpected target bytes') }), /source\/target bytes/);
});

test('artifact verification checks identical signed Bootstrap payloads and required migration consumers', async t => {
  for (const command of ['zip', 'unzip', 'tar']) {
    if (spawnSync(command, ['--help']).error?.code === 'ENOENT') {
      t.skip(command + ' is required to inspect migration artifacts');
      return;
    }
  }
  const { verifyBootstrapMigrationArtifacts } = await import(pathToFileURL(path.join(repoRoot, 'scripts/verify-release-artifacts.mjs')).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'col-bootstrap-artifact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const releaseDir = path.join(root, 'release');
  fs.mkdirSync(releaseDir);
  const options = { releaseDir, version: '2.5.1', extensionZipName: 'extension.zip',
    nativeTarballName: 'native.tar.gz', npmTarballName: 'package.tgz', updateBundleName: 'update.tar.gz' };
  const trees = Object.fromEntries(['extension', 'native', 'npm', 'update'].map(name => [name, path.join(root, name)]));
  const write = (tree, file, bytes) => {
    const destination = path.join(trees[tree], file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
  };
  const manifest = { version: '2.5.1', bootstrapProtocol: 3, bootstrapMigration: descriptor() };
  fs.writeFileSync(path.join(releaseDir, 'release-manifest.json'), JSON.stringify(manifest));
  for (const file of manifest.bootstrapMigration.files) {
    const bytes = fs.readFileSync(path.join(repoRoot, 'extension', file.path));
    write('extension', file.path, bytes);
    write('npm', 'package/extension/' + file.path, bytes);
    write('native', 'native-host/bootstrap-payload/' + file.path, bytes);
    write('update', 'native-runtime/native-host/bootstrap-payload/' + file.path, bytes);
  }
  const template = fs.readFileSync(path.join(repoRoot, 'extension/bootstrap/manifest.template.json'));
  write('native', 'native-host/bootstrap-payload/manifest.template.json', template);
  write('update', 'native-runtime/native-host/bootstrap-payload/manifest.template.json', template);
  for (const source of Contract.BOOTSTRAP_MIGRATION_IMPLEMENTATION_FILES) {
    write('update', source.startsWith('extension/') ? 'extension-runtime/' + source.slice(10) : 'native-runtime/' + source, '// consumer fixture\n');
  }
  const archive = (tree, name) => {
    const result = spawnSync(tree === 'extension' ? 'zip' : 'tar', tree === 'extension'
      ? ['-qr', path.join(releaseDir, name), '.'] : ['-czf', path.join(releaseDir, name), ...fs.readdirSync(trees[tree])],
    { cwd: trees[tree], encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  archive('extension', options.extensionZipName);
  archive('native', options.nativeTarballName);
  archive('npm', options.npmTarballName);
  archive('update', options.updateBundleName);
  let errors = [];
  verifyBootstrapMigrationArtifacts(options, errors);
  assert.deepEqual(errors, []);
  const target = 'native-runtime/native-host/bootstrap-payload/bootstrap/background.js';
  const original = fs.readFileSync(path.join(trees.update, target));
  write('update', target, 'tampered payload');
  archive('update', options.updateBundleName);
  verifyBootstrapMigrationArtifacts(options, errors);
  assert.match(errors.join('\n'), /digest mismatch/);
  write('update', target, original);
  fs.rmSync(path.join(trees.update, 'extension-runtime/src/backgroundBootstrapMigration.js'));
  archive('update', options.updateBundleName);
  errors = [];
  verifyBootstrapMigrationArtifacts(options, errors);
  assert.match(errors.join('\n'), /implementation is missing/);
  fs.writeFileSync(path.join(releaseDir, 'release-manifest.json'), JSON.stringify({ version: '2.5.1', bootstrapProtocol: 3 }));
  errors = [];
  verifyBootstrapMigrationArtifacts(options, errors);
  assert.match(errors.join('\n'), /descriptor/);
});
