const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');
const trust = require('../native-host/src/updateTrust');
const UpdateConsent = require('../extension/src/shared/updateConsent');
const { createCoordinatorHarness, UPDATE_KEY } = require('./helpers/updateCoordinatorHarness');
const { managedFixture } = require('./helpers/managedUpdateFixture');

const NOTE = { reason: { en: 'Adds a new Overleaf site permission.', zh: '新增了一个 Overleaf 站点权限。' } };

// A release signed for the next Bootstrap protocol, served through a fake GitHub.
function harness(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'col-manual-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'active-version'), '2.5.0');
  const keys = crypto.generateKeyPairSync('ed25519');
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, repository: 'Ghqqqq/codex-overleaf-link',
    channel: 'stable', version: '2.6.0', tag: 'v2.6.0', bootstrapProtocol: trust.BOOTSTRAP_PROTOCOL + 1,
    gitCommit: 'a'.repeat(40), createdAt: new Date().toISOString(), artifacts: [], manualInstall: NOTE,
    updateBundle: { name: 'codex-overleaf-update-v2.6.0.tar.gz', size: 1, sha256: 'a'.repeat(64) }, ...overrides }));
  const signature = Buffer.from(JSON.stringify({ algorithm: 'Ed25519', keyId: 'test',
    signature: crypto.sign(null, manifest, keys.privateKey).toString('base64') }));
  const filename = path.join(__dirname, '../native-host/src/updateManager.js');
  const realRequire = createRequire(filename);
  const sandbox = { module: { exports: {} }, process, Buffer, URL, setTimeout, clearTimeout,
    require(name) {
      return name === './updateTrust'
        ? { ...trust, verifySignedReleaseManifest: (bytes, sig, options = {}) =>
          trust.verifySignedReleaseManifest(bytes, sig, { ...options, publicKeys: { test: keys.publicKey } }) }
        : realRequire(name);
    }
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  const fetch = async (url, options = {}) => {
    const body = String(url).endsWith('release-manifest.json') ? manifest
      : String(url).endsWith('release-manifest.sig') ? signature : Buffer.alloc(0);
    return { ok: true, status: options.method === 'HEAD' && options.headers?.['If-None-Match'] ? 304 : 200,
      url: options.method === 'HEAD' ? 'https://github.com/Ghqqqq/codex-overleaf-link/releases/tag/v2.6.0' : url,
      headers: { get: name => String(name).toLowerCase() === 'content-length' ? String(body.length) : (name === 'etag' ? 'W/"e1"' : '') },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
  return { root, updater: sandbox.module.exports, fetch,
    context: { nativeRoot: root, extensionRoot: root, updatesRoot: root, managed: true } };
}

test('a release for another Bootstrap protocol reports a manual install instead of failing', async t => {
  const { root, updater, context, fetch } = harness(t);
  const result = await updater.checkForUpdate(context, { currentVersion: '2.5.0' }, { fetch, network: { delayMs: 0 } });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'manual_install_required');
  assert.equal(result.latestVersion, '2.6.0');
  assert.equal(result.requiredBootstrapProtocol, trust.BOOTSTRAP_PROTOCOL + 1);
  assert.deepEqual(result.manualInstall.reason, NOTE.reason);
  assert.equal(fs.existsSync(path.join(root, 'candidate.json')), false, 'nothing is staged for a manual-only release');

  // A later 304 still remembers the target instead of falling back to "up to date".
  const cached = await updater.checkForUpdate(context, { currentVersion: '2.5.0', etag: 'W/"e1"' }, { fetch, network: { delayMs: 0 } });
  assert.equal(cached.reason, 'manual_install_required');
  assert.equal(cached.latestVersion, '2.6.0');
  // Once the reinstall happened, the remembered notice no longer applies.
  fs.writeFileSync(path.join(root, 'active-version'), '2.6.0');
  const after = await updater.checkForUpdate(context, { currentVersion: '2.6.0', etag: 'W/"e1"' }, { fetch, network: { delayMs: 0 } });
  assert.equal(after.reason, 'not_modified');
});

test('a withdrawn manual release cannot reappear under the replacement latest ETag', async t => {
  const { root, updater, context, fetch } = harness(t);
  const first = await updater.checkForUpdate(context, {}, { fetch });
  assert.equal(first.reason, 'manual_install_required');
  const withdrawn = await updater.checkForUpdate(context, { etag: first.etag }, { fetch: async () => ({
    ok: true, status: 200,
    url: 'https://github.com/Ghqqqq/codex-overleaf-link/releases/tag/v2.5.0',
    headers: { get: name => name === 'etag' ? 'W/"current"' : '' }
  }) });
  assert.equal(withdrawn.reason, 'up_to_date');
  const cached = await updater.checkForUpdate(context, { etag: withdrawn.etag }, { fetch });
  assert.equal(cached.reason, 'not_modified');
  assert.equal(cached.available, false);
  assert.equal(fs.existsSync(path.join(root, 'manual-candidate.json')), false);
});

test('manual 304 cache uses signed fields and only the same discovery source and ETag', async t => {
  const { root, updater, context, fetch } = harness(t);
  await updater.checkForUpdate(context, {}, { fetch });
  const filename = path.join(root, 'manual-candidate.json');
  const candidate = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const check = etag => updater.checkForUpdate(context, { etag }, { fetch });
  fs.writeFileSync(filename, JSON.stringify({ ...candidate, latestVersion: '9.9.9',
    manualInstall: { reason: { en: 'Unsigned text', zh: '未签名文本' } } }));
  const verified = await check(candidate.etag);
  assert.equal(verified.latestVersion, '2.6.0');
  assert.deepEqual(verified.manualInstall.reason, NOTE.reason);
  assert.equal((await check('W/"another-response"')).reason, 'not_modified');
  fs.writeFileSync(filename, JSON.stringify({ ...candidate, currentVersion: '2.4.9' }));
  assert.equal((await check(candidate.etag)).reason, 'not_modified');
  const modifiedManifest = JSON.parse(Buffer.from(candidate.manifestBase64, 'base64'));
  modifiedManifest.version = '9.9.9';
  fs.writeFileSync(filename, JSON.stringify({ ...candidate,
    manifestBase64: Buffer.from(JSON.stringify(modifiedManifest)).toString('base64') }));
  assert.equal((await check(candidate.etag)).reason, 'not_modified');
  delete candidate.manifestBase64;
  delete candidate.signatureBase64;
  fs.writeFileSync(filename, JSON.stringify(candidate));
  assert.equal((await check(candidate.etag)).reason, 'not_modified', 'old derived-only cache is a miss');
});

test('a source-bound 304 miss clears browser offers and permits the next unconditional check', async t => {
  const f = managedFixture(t); f.install('2.4.9');
  const signed = harness(t);
  const requests = [];
  const onNative = request => {
    requests.push(structuredClone(request));
    return signed.updater.handleUpdateRequest(request, { env: { ...f.env,
      CODEX_OVERLEAF_ACTIVE_VERSION: fs.readFileSync(path.join(f.context.nativeRoot, 'active-version'), 'utf8').trim()
    }, fetch: signed.fetch });
  };
  const before = await createCoordinatorHarness({ version: '2.4.9', onNative });
  const first = await before.send('codex-overleaf/consent-update-check');
  assert.equal(first.result.state.state, 'manual_install_required');
  assert.equal(first.result.state.latestVersion, '2.6.0');
  const persisted = structuredClone(before.data[UPDATE_KEY]);
  f.install('2.5.0');
  const after = await createCoordinatorHarness({ version: '2.5.0', onNative });
  after.seed(persisted);
  const countBefore = requests.filter(request => request.method === 'update.check').length;
  const missed = await after.send('codex-overleaf/consent-update-check');
  assert.equal(missed.result.actions.install, false);
  assert.equal(missed.result.actions.copyInstall, false);
  assert.equal(missed.result.manualInstall, false);
  assert.equal(missed.result.available, false);
  assert.equal(missed.result.showPanel, false);
  assert.equal(missed.result.state.state, 'idle');
  assert.equal(missed.result.state.latestVersion, '2.5.0');
  assert.equal(after.data[UPDATE_KEY].etag, '');
  assert.deepEqual(after.data[UPDATE_KEY].manualReason, {});
  assert.equal(requests.filter(request => request.method === 'update.check').length, countBefore + 1,
    'a cache miss must not add an immediate network retry');
  const refreshed = await after.send('codex-overleaf/consent-update-check');
  const checked = requests.filter(request => request.method === 'update.check');
  assert.equal(checked.at(-1).params.etag, '');
  assert.equal(refreshed.result.state.state, 'manual_install_required');
  assert.equal(refreshed.result.state.latestVersion, '2.6.0');
  assert.equal(refreshed.result.actions.copyInstall, true);
  assert.equal(refreshed.result.actions.install, false);
  assert.equal(requests.some(request => ['update.authorize', 'update.stage', 'update.apply'].includes(request.method)), false);
});

test('staging and applying still refuse a foreign Bootstrap protocol', () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, repository: 'Ghqqqq/codex-overleaf-link', channel: 'stable',
    version: '2.6.0', tag: 'v2.6.0', bootstrapProtocol: trust.BOOTSTRAP_PROTOCOL + 1, gitCommit: 'a'.repeat(40),
    createdAt: new Date().toISOString(), artifacts: [],
    updateBundle: { name: 'codex-overleaf-update-v2.6.0.tar.gz', size: 1, sha256: 'a'.repeat(64) } }));
  const sig = Buffer.from(JSON.stringify({ algorithm: 'Ed25519', keyId: 'k', signature: crypto.sign(null, bytes, keys.privateKey).toString('base64') }));
  assert.throws(() => trust.verifySignedReleaseManifest(bytes, sig, { publicKeys: { k: keys.publicKey } }),
    { code: 'update_bootstrap_upgrade_required' });
  assert.equal(trust.verifySignedReleaseManifest(bytes, sig, { publicKeys: { k: keys.publicKey }, allowBootstrapMismatch: true }).version, '2.6.0');
});

test('a malformed manual-install note is rejected', async t => {
  const { updater, context, fetch } = harness(t, { manualInstall: { reason: { fr: 'x' } } });
  await assert.rejects(updater.checkForUpdate(context, { currentVersion: '2.5.0' }, { fetch, network: { delayMs: 0 } }),
    { code: 'update_manifest_manual_install_invalid' });
});

test('the view model shows a manual install even after an automatic check', () => {
  const view = UpdateConsent.deriveViewModel({ state: 'manual_install_required', currentVersion: '2.5.0', latestVersion: '2.6.0',
    initiatedBy: 'automatic', manualReason: NOTE.reason }, {}, { currentVersion: '2.5.0', now: 1000 });
  assert.equal(view.showPanel, true);
  assert.equal(view.manualInstall, true);
  assert.equal(view.actions.install, false, 'Update now can never apply it');
  assert.equal(view.actions.copyInstall, true);
  assert.deepEqual(view.state.manualReason, NOTE.reason);
  const snoozed = UpdateConsent.deriveViewModel(view.state, { snoozedVersion: '2.6.0', snoozedUntil: 5000 }, { currentVersion: '2.5.0', now: 1000 });
  assert.equal(snoozed.showPanel, false, 'Later hides it for a day');
  const reinstalled = UpdateConsent.deriveViewModel(view.state, {}, { currentVersion: '2.6.0', now: 1000 });
  assert.equal(reinstalled.showPanel, false);
});

test('the coordinator records the manual state with the signed reason, and Later only snoozes it', async () => {
  const h = await createCoordinatorHarness({
    onNative: request => request.method === 'update.check' ? { ok: true, result: {
      managed: true, available: false, reason: 'manual_install_required', currentVersion: '2.4.1', latestVersion: '2.6.0',
      manualInstall: NOTE } } : undefined
  });
  const view = await h.send('codex-overleaf/consent-update-check');
  assert.equal(h.data[UPDATE_KEY].state, 'manual_install_required');
  assert.equal(h.data[UPDATE_KEY].latestVersion, '2.6.0');
  assert.deepEqual(h.data[UPDATE_KEY].manualReason, NOTE.reason);
  assert.equal(view.showPanel ?? view.result?.showPanel, true);
  await h.send('codex-overleaf/consent-update-later');
  assert.equal(h.data[UPDATE_KEY].state, 'manual_install_required', 'Later keeps the notice');
  assert.equal(h.events.some(event => event.method === 'update.cancel' || event.method === 'update.revoke'), false);
  // Update now refreshes and lands on the same notice rather than an error.
  const install = await h.send('codex-overleaf/consent-update-install');
  assert.notEqual(install?.ok, false);
  assert.equal(h.data[UPDATE_KEY].state, 'manual_install_required');
});

test('panel and update window show the pinned reinstall command for the target version', () => {
  const notice = fs.readFileSync(path.join(__dirname, '../extension/src/content/updateNotice.js'), 'utf8');
  assert.match(notice, /state\.state === 'manual_install_required'/);
  assert.match(notice, /manualUpdateCommand\(state\)/);
  assert.match(notice, /id: 'copy-manual'/);
  const center = fs.readFileSync(path.join(__dirname, '../extension/bootstrap/update.js'), 'utf8');
  assert.match(center, /manual_install_required: \['This update needs a one-time reinstall'/);
  assert.match(center, /codex-overleaf-link@\$\{pinned\} -- install-managed/);
});

test('Overleaf sites come from the runtime manifest, gated by granted permissions', () => {
  const bootstrap = fs.readFileSync(path.join(__dirname, '../extension/bootstrap/background.js'), 'utf8');
  const sandbox = { URL, chrome: { permissions: { contains: async ({ origins }) => origins[0].startsWith('https://beta.overleaf.com') } } };
  vm.createContext(sandbox);
  for (const name of ['BUILT_IN_OVERLEAF_MATCHES', 'isProjectMatch', 'hostsOf', 'grantedMatches']) {
    const start = bootstrap.indexOf(name === 'BUILT_IN_OVERLEAF_MATCHES' ? 'const BUILT_IN_OVERLEAF_MATCHES' : (name === 'grantedMatches' ? 'async function grantedMatches' : 'function ' + name));
    const end = name === 'BUILT_IN_OVERLEAF_MATCHES' ? bootstrap.indexOf(']);', start) + 3 : bootstrap.indexOf('\n}\n', start) + 2;
    vm.runInContext(bootstrap.slice(start, end).replace(/^const /, 'var '), sandbox);
  }
  // Only overleaf.com project pages are acceptable runtime matches.
  assert.equal(sandbox.isProjectMatch('https://beta.overleaf.com/project/*'), true);
  assert.equal(sandbox.isProjectMatch('https://evil.example/project/*'), false);
  assert.equal(sandbox.isProjectMatch('https://*.overleaf.com/project/*'), false);
  assert.equal(sandbox.isProjectMatch('https://www.overleaf.com/settings'), false);
  return sandbox.grantedMatches(['https://www.overleaf.com/project/*', 'https://beta.overleaf.com/project/*', 'https://new.overleaf.com/project/*'])
    .then(granted => {
      assert.equal(JSON.stringify(granted), JSON.stringify(['https://www.overleaf.com/project/*', 'https://beta.overleaf.com/project/*']), 'an ungranted site is skipped');
      assert.equal(JSON.stringify([...sandbox.hostsOf(granted)]), JSON.stringify(['www.overleaf.com', 'beta.overleaf.com']));
    });
});

test('manifest keeps optional hosts within overleaf.com and the popup only requests them on click', () => {
  for (const file of ['../extension/manifest.json', '../extension/bootstrap/manifest.template.json']) {
    const manifest = require(file);
    assert.deepEqual(manifest.optional_host_permissions, ['https://*.overleaf.com/*']);
    assert.ok(manifest.web_accessible_resources.every(entry => entry.matches.every(match => /overleaf\.com\/\*$/.test(match))));
  }
  const popup = fs.readFileSync(path.join(__dirname, '../extension/src/popup.js'), 'utf8');
  assert.match(popup, /button\.addEventListener\('click', async \(\) => \{\s*const granted = await chrome\.permissions\.request/);
  const bootstrap = fs.readFileSync(path.join(__dirname, '../extension/bootstrap/background.js'), 'utf8');
  assert.match(bootstrap, /chrome\.permissions\?\.onAdded\?\.addListener/);
});
