const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  compareSemver,
  verifySignedReleaseManifest
} = require('../native-host/src/updateTrust');

function signedFixture(overrides = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const manifest = {
    schemaVersion: 2,
    repository: 'Ghqqqq/codex-overleaf-link',
    channel: 'stable',
    version: '1.9.1',
    tag: 'v1.9.1',
    bootstrapProtocol: 2,
    gitCommit: 'a'.repeat(40),
    createdAt: '2026-07-10T00:00:00.000Z',
    updateBundle: {
      name: 'codex-overleaf-update-v1.9.1.tar.gz',
      size: 123,
      sha256: 'b'.repeat(64)
    },
    artifacts: [],
    ...overrides
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const signature = crypto.sign(null, bytes, privateKey);
  const envelope = Buffer.from(JSON.stringify({
    keyId: 'fixture',
    algorithm: 'Ed25519',
    signature: signature.toString('base64')
  }));
  return {
    bytes,
    envelope,
    publicKeys: { fixture: publicKey.export({ type: 'spki', format: 'pem' }) }
  };
}

test('verifies an exact signed stable update manifest', () => {
  const fixture = signedFixture();
  const result = verifySignedReleaseManifest(fixture.bytes, fixture.envelope, { publicKeys: fixture.publicKeys });
  assert.equal(result.version, '1.9.1');
});

test('verifies a numbered RC only when the caller explicitly scopes its channel and tag', () => {
  const fixture = signedFixture({ channel: 'prerelease', tag: 'v1.9.1-rc.2' });
  assert.throws(
    () => verifySignedReleaseManifest(fixture.bytes, fixture.envelope, { publicKeys: fixture.publicKeys }),
    error => error.code === 'update_manifest_origin_mismatch'
  );
  const result = verifySignedReleaseManifest(fixture.bytes, fixture.envelope, {
    publicKeys: fixture.publicKeys,
    channel: 'prerelease',
    tag: 'v1.9.1-rc.2'
  });
  assert.equal(result.tag, 'v1.9.1-rc.2');
});

test('rejects tampered signed manifest bytes', () => {
  const fixture = signedFixture();
  assert.throws(
    () => verifySignedReleaseManifest(Buffer.concat([fixture.bytes, Buffer.from(' ')]), fixture.envelope, { publicKeys: fixture.publicKeys }),
    error => error.code === 'update_signature_invalid'
  );
});

test('rejects prerelease syntax and bootstrap protocol changes', () => {
  const prerelease = signedFixture({ version: '1.9.2-beta.1', tag: 'v1.9.2-beta.1' });
  assert.throws(
    () => verifySignedReleaseManifest(prerelease.bytes, prerelease.envelope, { publicKeys: prerelease.publicKeys }),
    error => error.code === 'update_manifest_version_invalid'
  );
  const bootstrap = signedFixture({ bootstrapProtocol: 1 });
  assert.throws(
    () => verifySignedReleaseManifest(bootstrap.bytes, bootstrap.envelope, { publicKeys: bootstrap.publicKeys }),
    error => error.code === 'update_bootstrap_upgrade_required'
  );
});

test('compares stable semantic versions without lexical ordering bugs', () => {
  assert.equal(compareSemver('1.10.0', '1.9.9'), 1);
  assert.equal(compareSemver('2.0.0', '2.0.0'), 0);
  assert.equal(compareSemver('1.8.9', '1.9.0'), -1);
});
