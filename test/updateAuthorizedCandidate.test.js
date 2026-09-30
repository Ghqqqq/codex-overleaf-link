const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');
const trust = require('../native-host/src/updateTrust');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'col-authorized-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = { nativeRoot: root, extensionRoot: root, updatesRoot: root, managed: true };
  fs.writeFileSync(path.join(root, 'active-version'), '2.3.5');
  const keys = crypto.generateKeyPairSync('ed25519');
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, repository: 'Ghqqqq/codex-overleaf-link',
    channel: 'stable', version: '2.3.6', tag: 'v2.3.6', bootstrapProtocol: trust.BOOTSTRAP_PROTOCOL,
    gitCommit: 'a'.repeat(40), createdAt: new Date().toISOString(), artifacts: [],
    updateBundle: { name: 'codex-overleaf-update-v2.3.6.tar.gz', size: 1, sha256: 'a'.repeat(64) } }));
  const signature = Buffer.from(JSON.stringify({ algorithm: 'Ed25519', keyId: 'test',
    signature: crypto.sign(null, manifest, keys.privateKey).toString('base64') }));
  const candidate = { latestVersion: '2.3.6', currentVersion: '2.3.5',
    checkedAt: new Date().toISOString(), manifestBase64: manifest.toString('base64'), signatureBase64: signature.toString('base64') };
  fs.writeFileSync(path.join(root, 'candidate.json'), JSON.stringify(candidate));
  const filename = path.join(__dirname, '../native-host/src/updateManager.js');
  const realRequire = createRequire(filename);
  const sandbox = { module: { exports: {} }, process, Buffer, URL, setTimeout, clearTimeout,
    require(name) {
      return name === './updateTrust'
        ? { ...trust, verifySignedReleaseManifest: (bytes, sig) => trust.verifySignedReleaseManifest(bytes, sig, { publicKeys: { test: keys.publicKey } }) }
        : realRequire(name);
    }
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  const updater = sandbox.module.exports;
  updater.authorizeUpdate(context, { authorizationId: '11111111-1111-4111-8111-111111111111',
    targetVersion: '2.3.6', currentVersion: '2.3.5' });
  return { root, context, updater, candidate };
}

test('the legacy bootstrap recheck reuses the exact authorized signed candidate without a network request', async t => {
  const { context, updater } = fixture(t);
  let requests = 0;
  const result = await updater.checkForUpdate(context, { currentVersion: '2.3.5' }, {
    network: { delayMs: 0 }, fetch: async () => { requests += 1; throw new Error('offline'); }
  });
  assert.equal(result.available, true);
  assert.equal(result.latestVersion, '2.3.6');
  assert.equal(result.cached, true);
  assert.equal(requests, 0);
});

test('a cached candidate cannot switch the authorized target version', async t => {
  const { root, context, updater, candidate } = fixture(t);
  fs.writeFileSync(path.join(root, 'candidate.json'), JSON.stringify({ ...candidate, latestVersion: '2.3.7' }));
  await assert.rejects(updater.checkForUpdate(context, {}, { network: { delayMs: 0 },
    fetch: async () => { throw new Error('network must not decide the authorized target'); }
  }), { code: 'update_consent_mismatch' });
});

test('expired authorization is rejected even while the signed candidate remains cached', async t => {
  const { root, context, updater } = fixture(t);
  const file = path.join(root, 'authorization.json');
  const authorization = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...authorization, expiresAt: '2000-01-01T00:00:00.000Z' }));
  await assert.rejects(updater.checkForUpdate(context, {}, { network: { delayMs: 0 },
    fetch: async () => { throw new Error('offline'); }
  }), { code: 'update_consent_required' });
});
