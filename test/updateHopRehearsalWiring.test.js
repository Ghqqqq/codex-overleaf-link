const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

test('package scripts expose the local managed-update rehearsal', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  );

  assert.equal(
    pkg.scripts['verify:update-hop:local'],
    'node scripts/verify-update-hop.mjs --local-test-key',
  );
  assert.equal(
    pkg.scripts['rehearse:update-hop'],
    'npm run build:release && npm run verify:update-hop:local',
  );
});

test('pull-request CI rehearses the update hop once on Ubuntu', () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, '.github/workflows/test.yml'),
    'utf8',
  );

  assert.match(
    workflow,
    /- name: Rehearse previous-stable managed update hop\s+if: matrix\.os == 'ubuntu-latest'\s+run: npm run rehearse:update-hop/,
  );
  assert.equal(
    (workflow.match(/run: npm run rehearse:update-hop/g) || []).length,
    1,
  );
});

test('rehearsal verifies the full source and target Bootstrap inventory', async (t) => {
  const { assertBootstrapSnapshot } = await import('../scripts/update-hop-runtime.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'update-hop-hashes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'bootstrap'));
  const source = 'old loader';
  const target = 'new loader';
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const descriptor = { files: [
    { path: 'bootstrap/background.js', sourceSha256: hash(source), targetSha256: hash(target) },
    { path: 'bootstrap/new.js', sourceSha256: null, targetSha256: hash('new file') }
  ] };
  fs.writeFileSync(path.join(root, 'bootstrap/background.js'), source);
  assert.doesNotThrow(() => assertBootstrapSnapshot(root, descriptor, 'source'));
  assert.throws(() => assertBootstrapSnapshot(root, descriptor, 'target'), /target hash mismatch/);
  fs.writeFileSync(path.join(root, 'bootstrap/background.js'), target);
  fs.writeFileSync(path.join(root, 'bootstrap/new.js'), 'new file');
  assert.doesNotThrow(() => assertBootstrapSnapshot(root, descriptor, 'target'));
  fs.writeFileSync(path.join(root, 'bootstrap/unexpected.js'), 'unlisted');
  assert.throws(() => assertBootstrapSnapshot(root, descriptor, 'target'), /Unexpected Bootstrap entry/);
});

test('local rehearsal trust is injected without changing signed input or target source bytes', async (t) => {
  const { writeTestTrustPreload, isolatedHopEnvironment } = await import('../scripts/update-hop-runtime.mjs');
  const { createEphemeralReleaseSignature } = await import('../scripts/update-hop-test-signing.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'update-hop-trust-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetRoot = path.join(root, 'candidate');
  const trustPath = path.join(targetRoot, 'native-host/src/updateTrust.js');
  fs.mkdirSync(path.dirname(trustPath), { recursive: true });
  const trustSource = fs.readFileSync(path.join(repoRoot, 'native-host/src/updateTrust.js'));
  fs.writeFileSync(trustPath, trustSource);
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, repository: 'Ghqqqq/codex-overleaf-link',
    channel: 'stable', version: '2.5.1', tag: 'v2.5.1', bootstrapProtocol: 3,
    gitCommit: '1'.repeat(40), createdAt: '2026-10-07T00:00:00Z', artifacts: [],
    updateBundle: { name: 'codex-overleaf-update-v2.5.1.tar.gz', size: 1, sha256: 'a'.repeat(64) } }));
  const signed = createEphemeralReleaseSignature(manifest);
  const preload = writeTestTrustPreload({ tempRoot: root, targetRoot, ...signed });
  const input = path.join(root, 'manifest.json'), signature = path.join(root, 'manifest.sig');
  fs.writeFileSync(input, manifest); fs.writeFileSync(signature, signed.signatureBytes);
  const script = `const fs=require('node:fs'); const trust=require(${JSON.stringify(trustPath)});\n`
    + `process.stdout.write(trust.verifySignedReleaseManifest(fs.readFileSync(${JSON.stringify(input)}),fs.readFileSync(${JSON.stringify(signature)})).version);`;
  const env = isolatedHopEnvironment(root, process.env);
  const result = spawnSync(process.execPath, ['--require', preload, '-e', script], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '2.5.1');
  assert.deepEqual(fs.readFileSync(trustPath), trustSource);
  assert.deepEqual(fs.readFileSync(input), manifest);
  assert.deepEqual(fs.readFileSync(signature), signed.signatureBytes);
  const untrusted = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
  assert.notEqual(untrusted.status, 0);
  assert.match(untrusted.stderr, /signature verification failed/);
});

test('rehearsal isolates caller homes, credentials and inherited Node hooks', async (t) => {
  const { isolatedHopEnvironment } = await import('../scripts/update-hop-runtime.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'update-hop-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = isolatedHopEnvironment(root, { HOME: '/real', CODEX_HOME: '/private', NODE_OPTIONS: '--require /private/hook',
    OPENAI_API_KEY: 'private', GH_TOKEN: 'private', CODEX_OVERLEAF_MANAGED_NATIVE_ROOT: '/real/native', PATH: '/usr/bin' });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, path.join(root, 'home'));
  assert.equal(env.CODEX_HOME, path.join(root, 'codex'));
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.CODEX_OVERLEAF_MANAGED_NATIVE_ROOT, undefined);
});
