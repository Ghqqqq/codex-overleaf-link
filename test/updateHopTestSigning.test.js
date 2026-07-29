const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('ephemeral update signatures are accepted only by the temporary trust anchor', async () => {
  const {
    createEphemeralReleaseSignature,
    replaceTrustedUpdateKeySource
  } = await import('../scripts/update-hop-test-signing.mjs');
  const manifestBytes = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    repository: 'Ghqqqq/codex-overleaf-link',
    channel: 'stable',
    version: '2.3.0',
    tag: 'v2.3.0',
    bootstrapProtocol: 2,
    gitCommit: 'a'.repeat(40),
    createdAt: '2026-07-27T00:00:00.000Z',
    updateBundle: {
      name: 'codex-overleaf-update-v2.3.0.tar.gz',
      size: 1,
      sha256: 'b'.repeat(64)
    },
    artifacts: []
  }));
  const signed = createEphemeralReleaseSignature(manifestBytes);
  const source = fs.readFileSync(
    path.join(__dirname, '../native-host/src/updateTrust.js'),
    'utf8'
  );
  const patched = replaceTrustedUpdateKeySource(source, {
    keyId: signed.keyId,
    publicKeyPem: signed.publicKeyPem
  });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-test-trust-'));

  try {
    const trustPath = path.join(tempRoot, 'updateTrust.cjs');
    fs.writeFileSync(trustPath, patched);
    const trust = require(trustPath);
    const manifest = trust.verifySignedReleaseManifest(
      manifestBytes,
      signed.signatureBytes
    );
    assert.equal(manifest.version, '2.3.0');
    assert.throws(
      () => trust.verifySignedReleaseManifest(
        Buffer.concat([manifestBytes, Buffer.from(' ')]),
        signed.signatureBytes
      ),
      error => error?.code === 'update_signature_invalid'
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('temporary trust replacement fails closed when the expected key is absent', async () => {
  const { replaceTrustedUpdateKeySource } = await import(
    '../scripts/update-hop-test-signing.mjs'
  );

  assert.throws(
    () => replaceTrustedUpdateKeySource('module.exports = {};', {
      keyId: 'release-2026-01',
      publicKeyPem:
        '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA7j6QhE+CKK1ZV1zZ4VfFOK9lK0jEJ8Qx5vT5MViJ8hA=\n-----END PUBLIC KEY-----\n'
    }),
    /not found/i
  );
});
