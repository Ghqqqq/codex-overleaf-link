'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const Trust = require('../native-host/src/updateTrust');
const Native = require('../native-host/src/updateManager');
const Identity = require('../extension/src/shared/updateRuntimeIdentity');
const { createCoordinatorHarness, UPDATE_KEY, CONSENT_KEY } = require('./helpers/updateCoordinatorHarness');
const { extractFunction } = require('./_helpers/extractFunction');
const ROOT = path.resolve(__dirname, '..');
const TABS_KEY = 'codex-overleaf-managed-update-tabs-v1';
const AUTH = '11111111-1111-4111-8111-111111111111';
const source = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise(setImmediate);

function nativeFixture(t, version = '2.4.2') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'col-update-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = { managed: true, nativeRoot: path.join(root, 'native'), extensionRoot: path.join(root, 'extension') };
  context.updatesRoot = path.join(context.nativeRoot, 'updates');
  for (const dir of [context.updatesRoot, path.join(context.nativeRoot, 'versions', version), path.join(context.extensionRoot, 'runtime')]) fs.mkdirSync(dir, { recursive: true });
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
  const runtime = (directory, value) => {
    fs.mkdirSync(path.join(directory, 'src/shared'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'src/shared/compatibility.js'), `const BUILD_TARGET_VERSION = '${value}';\n`);
    write(path.join(directory, 'runtime-manifest.json'), { schemaVersion: 1, js: ['src/shared/compatibility.js'], css: [] });
    const native = path.join(context.nativeRoot, 'versions', value);
    fs.mkdirSync(path.join(native, 'native-host/src'), { recursive: true });
    write(path.join(native, 'package.json'), { version: value });
    fs.writeFileSync(path.join(native, 'native-host/src/index.js'), 'void 0;\n');
  };
  const align = value => {
    fs.writeFileSync(path.join(context.nativeRoot, 'active-version'), value + '\n');
    for (const [dir, kind] of [[context.nativeRoot, 'native'], [context.extensionRoot, 'extension']]) {
      write(path.join(dir, `.codex-overleaf-managed-${kind}.json`), { managedBy: 'codex-overleaf-link', kind, bootstrapProtocol: Trust.BOOTSTRAP_PROTOCOL, version: value });
    }
    write(path.join(context.extensionRoot, 'manifest.json'), { manifest_version: 3, version: value, background: { service_worker: 'bootstrap/background.js' } });
    fs.mkdirSync(path.join(context.extensionRoot, 'bootstrap'), { recursive: true });
    fs.writeFileSync(path.join(context.extensionRoot, 'bootstrap/background.js'), '// fixture');
    runtime(path.join(context.extensionRoot, 'runtime'), value);
  };
  align(version);
  runtime(path.join(context.extensionRoot, 'slots/previous/runtime'), '2.4.1');
  const env = { CODEX_OVERLEAF_MANAGED: '1', CODEX_OVERLEAF_ACTIVE_VERSION: version,
    CODEX_OVERLEAF_MANAGED_NATIVE_ROOT: context.nativeRoot, CODEX_OVERLEAF_MANAGED_EXTENSION_ROOT: context.extensionRoot };
  const journal = { id: 'old-transaction', state: 'awaiting_health', sourceVersion: '2.4.1', targetVersion: '2.4.2', authorizationId: AUTH,
    previousManifest: JSON.stringify({ manifest_version: 3, version: '2.4.1', background: { service_worker: 'bootstrap/background.js' } }) };
  const authorization = { id: AUTH, state: 'bound', transactionId: journal.id, sourceVersion: journal.sourceVersion,
    targetVersion: journal.targetVersion, expiresAt: '2020-01-01T00:00:00.000Z' };
  write(path.join(context.updatesRoot, 'transaction.json'), journal);
  write(path.join(context.updatesRoot, 'authorization.json'), authorization);
  const status = () => Native.handleUpdateRequest({ id: 'status', method: 'update.status', params: {} }, { env });
  return { root, context, env, write, align, journal, authorization, status };
}

function discoveryFixture(t) {
  const fixture = nativeFixture(t);
  const keys = crypto.generateKeyPairSync('ed25519');
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, repository: 'Ghqqqq/codex-overleaf-link', channel: 'stable', version: '2.4.2',
    tag: 'v2.4.2', bootstrapProtocol: Trust.BOOTSTRAP_PROTOCOL, gitCommit: 'a'.repeat(40), createdAt: new Date().toISOString(), artifacts: [],
    updateBundle: { name: 'codex-overleaf-update-v2.4.2.tar.gz', size: 1, sha256: 'a'.repeat(64) } }));
  const sig = Buffer.from(JSON.stringify({ algorithm: 'Ed25519', keyId: 'fixture', signature: crypto.sign(null, manifest, keys.privateKey).toString('base64') }));
  const filename = path.join(ROOT, 'native-host/src/updateManager.js'), realRequire = createRequire(filename);
  const sandbox = { module: { exports: {} }, process, Buffer, URL, setTimeout, clearTimeout,
    require: name => name === './updateTrust' ? { ...Trust, verifySignedReleaseManifest: (bytes, signature, options = {}) =>
      Trust.verifySignedReleaseManifest(bytes, signature, { ...options, publicKeys: { fixture: keys.publicKey } }) } : realRequire(name) };
  vm.runInNewContext(source('native-host/src/updateManager.js'), sandbox, { filename });
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method });
    const bytes = String(url).endsWith('release-manifest.json') ? manifest : String(url).endsWith('release-manifest.sig') ? sig : Buffer.alloc(0);
    return { ok: true, status: 200, url: options.method === 'HEAD' ? 'https://github.com/Ghqqqq/codex-overleaf-link/releases/tag/v2.4.2' : url,
      headers: { get: name => name === 'content-length' ? String(bytes.length) : '' },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
  return { ...fixture, calls, updater: sandbox.module.exports,
    check: () => sandbox.module.exports.checkForUpdate(fixture.context, {}, { fetch, network: { delayMs: 0 } }) };
}

function renderExistingSettings(view, locale = 'en') {
  const nodes = Object.fromEntries(['summary', 'state', 'button'].map(key => [key, { textContent: '', hidden: false, disabled: false }]));
  const sandbox = { currentView: view, settingsRoot: { querySelector: selector => nodes[selector.includes('summary') ? 'summary' : selector.includes('state]') ? 'state' : 'button'] },
    chrome: { runtime: { getManifest: () => ({ version: '2.4.1' }) } }, ACTIVE_UPDATE_STATES: new Set(['downloading', 'staged', 'waiting_for_idle', 'applying', 'awaiting_health']),
    actionInFlight: false, settingsActionInFlight: false, cancellationInFlight: false, getLocale: () => locale, tx: (en, zh) => locale === 'zh' ? zh : en, Date };
  vm.createContext(sandbox);
  const notice = source('extension/src/content/updateNotice.js');
  for (const name of ['manualReasonText', 'manualUpdateCommand', 'formatUpdateMessage', 'blockerCopy', 'blockersCopy', 'getCopy', 'renderSettings']) vm.runInContext(extractFunction(notice, name), sandbox);
  sandbox.renderSettings();
  return { ...nodes, command: sandbox.manualUpdateCommand(view.state), copy: sandbox.getCopy(view.state) };
}

function bindProductionBackground(h, statusReader) {
  Object.assign(h.sandbox, { ManagedUpdateProjection: h.sandbox.CodexOverleafManagedUpdateProjection,
    MANAGED_UPDATE_STATE_KEY: UPDATE_KEY, MANAGED_UPDATE_CONSENT_KEY: CONSENT_KEY, MANAGED_UPDATE_TABS_KEY: TABS_KEY,
    sendNativeRequest: async () => ({ ok: true, result: await statusReader() }) });
  const background = source('extension/src/background.js');
  for (const name of ['getManagedUpdateState', 'setManagedUpdateState', 'reconcileManagedUpdateTransaction']) {
    vm.runInContext(extractFunction(background, name), h.sandbox);
  }
  return () => h.sandbox.reconcileManagedUpdateTransaction();
}
const oldState = { state: 'failed', recoveryPending: true, currentVersion: '2.4.1', latestVersion: '2.4.2', transactionId: 'old-transaction', operationId: 'old-operation' };
const superseded = { managed: true, installedAligned: true, activeVersion: '2.4.3', runtimeVersion: '2.4.3', authorization: null,
  transaction: { id: 'old-transaction', state: 'superseded', sourceVersion: '2.4.1', targetVersion: '2.4.2', supersededByVersion: '2.4.3' } };

for (const locale of ['en', 'zh']) test(`117 rollback cooldown retains reason and expiry through existing settings (${locale})`, async t => {
  const n = discoveryFixture(t);
  n.updater.rollbackUpdate(n.context, { transactionId: n.journal.id, expectedState: 'awaiting_health', reasonCode: 'update_health_failed' });
  const h = await createCoordinatorHarness({ onNative: async request => request.method === 'update.check' ? { ok: true, result: await n.check() } : undefined });
  const response = await h.send('codex-overleaf/consent-update-check');
  assert.equal(response.ok, true);
  assert.equal(response.result.state.code, 'update_cooldown');
  const until = JSON.parse(fs.readFileSync(path.join(n.context.updatesRoot, 'cooldowns.json')))["2.4.2"];
  assert.equal(response.result.state.cooldownUntil, until.until);
  assert.equal(response.result.actions.install, false);
  const ui = renderExistingSettings(response.result, locale);
  assert.equal(ui.state.hidden, false);
  assert.match(ui.state.textContent, locale === 'zh' ? /冷却|暂停/ : /cooldown|paused/i);
  assert.match(ui.state.textContent, /2\.4\.2/);
  assert.deepEqual(h.events.filter(x => ['update.authorize', 'update.stage', 'update.apply'].includes(x.method)), []);
  n.write(path.join(n.context.updatesRoot, 'cooldowns.json'), { '2.4.2': { until: Date.now() - 1 } });
  const after = await h.send('codex-overleaf/consent-update-check');
  assert.equal(after.result.state.state, 'update_available');
  assert.equal(after.result.state.code, '');
  assert.equal(after.result.state.cooldownUntil || 0, 0);
});

test('126 same-number RC promotion reaches existing reinstall copy and never automatic installation', async t => {
  const n = discoveryFixture(t);
  fs.rmSync(path.join(n.context.updatesRoot, 'authorization.json'));
  n.write(path.join(n.context.extensionRoot, '.codex-overleaf-managed-extension.json'), { releaseChannel: 'prerelease' });
  const h = await createCoordinatorHarness({ version: '2.4.2', onNative: async request => request.method === 'update.check' ? { ok: true, result: await n.check() } : undefined });
  const response = await h.send('codex-overleaf/consent-update-check');
  assert.equal(response.result.state.state, 'manual_install_required');
  assert.equal(response.result.manualInstall, true);
  assert.equal(response.result.actions.copyInstall, true);
  assert.equal(response.result.actions.install, false);
  for (const locale of ['en', 'zh']) {
    const ui = renderExistingSettings(response.result, locale);
    assert.match(ui.copy.detail, locale === 'zh' ? /候选|预发布/ : /prerelease|release candidate/i);
    assert.equal(ui.command, 'npm exec --yes codex-overleaf-link@2.4.2 -- install-managed');
  }
  await h.send('codex-overleaf/consent-update-later');
  const snoozed = await h.send('codex-overleaf/consent-update-get-state');
  assert.equal(snoozed.result.showPanel, false);
  n.write(path.join(n.context.extensionRoot, '.codex-overleaf-managed-extension.json'), { releaseChannel: 'stable' });
  const after = await h.send('codex-overleaf/consent-update-check');
  assert.equal(after.result.state.state, 'idle');
  assert.equal(after.result.manualInstall, false);
  assert.equal(h.events.some(x => ['update.authorize', 'update.stage', 'update.apply'].includes(x.method)), false);
});

test('129 status supersedes journal, settles its bound authorization and unblocks the next check', async t => {
  const n = nativeFixture(t); n.align('2.4.3'); n.env.CODEX_OVERLEAF_ACTIVE_VERSION = '2.4.3';
  const response = await n.status();
  assert.equal(response.result.transaction.state, 'superseded');
  assert.equal(response.result.authorization, null);
  assert.equal(fs.existsSync(path.join(n.context.updatesRoot, 'authorization.json')), false);
  const identity = Identity.inspectInstalledRuntime(response.result, { extensionVersion: '2.4.3', runtimeVersion: '2.4.3' });
  assert.equal(identity.state, 'aligned');
  const next = await Native.checkForUpdate(n.context, {}, { fetch: async () => ({ ok: true, status: 200,
    url: 'https://github.com/Ghqqqq/codex-overleaf-link/releases/tag/v2.4.3', headers: { get: () => '' } }) });
  assert.equal(next.reason, 'up_to_date');
});
for (const change of [{ id: '22222222-2222-4222-8222-222222222222' }, { transactionId: 'new-transaction' }, { sourceVersion: '2.4.3' }, { state: 'authorized' }]) {
  test(`129 superseded old journal retains unrelated authorization ${JSON.stringify(change)}`, async t => {
    const n = nativeFixture(t); n.align('2.4.3');
    const authorization = { ...n.authorization, ...change };
    n.write(path.join(n.context.updatesRoot, 'authorization.json'), authorization);
    const response = await n.status();
    assert.equal(response.result.transaction.state, 'superseded');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(n.context.updatesRoot, 'authorization.json'))), authorization);
  });
}

test('132 production background settlement cannot be revived by the older coordinator status', async () => {
  const pending = defer(); let wait = false;
  const h = await createCoordinatorHarness({ onNative: request => request.method === 'update.status' && wait ? pending.promise : undefined });
  h.seed(oldState, { authorizationId: AUTH, authorizedVersion: '2.4.2' }); wait = true;
  const recovering = h.send('codex-overleaf/consent-update-recover'); await flush();
  const background = bindProductionBackground(h, async () => superseded);
  await background();
  assert.equal(h.data[UPDATE_KEY].state, 'idle');
  pending.resolve({ ok: true, result: superseded }); await recovering;
  assert.equal(h.data[UPDATE_KEY].state, 'idle');
  assert.equal(h.data[UPDATE_KEY].recoveryPending || false, false);
  assert.equal(h.data[UPDATE_KEY].currentVersion, '2.4.3');
});

test('132 delayed background superseded status cannot clear a new transaction or consent', async () => {
  const h = await createCoordinatorHarness(); h.seed(oldState);
  const pending = defer(), background = bindProductionBackground(h, () => pending.promise);
  const settling = background(); await flush();
  const newer = { state: 'awaiting_health', currentVersion: '2.4.3', latestVersion: '2.4.4', transactionId: 'new-transaction', operationId: 'new-operation', recoveryPending: true };
  const consent = { authorizationId: 'new-authorization', authorizedVersion: '2.4.4' };
  h.seed(newer, consent); h.data[TABS_KEY] = [99]; pending.resolve(superseded); await settling;
  assert.deepEqual(h.data[UPDATE_KEY], newer);
  assert.deepEqual(h.data[CONSENT_KEY], consent);
  assert.deepEqual(h.data[TABS_KEY], [99]);
});

test('132 wrong-transaction recovery remains pending without claiming a completed recovery', async () => {
  const h = await createCoordinatorHarness({ onNative: request => request.method === 'update.status'
    ? { ok: true, result: { ...superseded, transaction: { ...superseded.transaction, id: 'other-transaction' } } } : undefined });
  h.seed(oldState);
  const result = await h.send('codex-overleaf/consent-update-recover');
  assert.equal(result.result.state.recoveryPending, true);
  assert.equal(h.data[UPDATE_KEY].code, 'update_transaction_mismatch');
  assert.equal(h.reloads(), 0);
});

test('129 an already superseded journal also settles only its leftover matching bound authorization', async t => {
  const n = nativeFixture(t); n.align('2.4.3');
  n.write(path.join(n.context.updatesRoot, 'transaction.json'), { ...n.journal, state: 'superseded', supersededByVersion: '2.4.3' });
  const result = await n.status();
  assert.equal(result.result.transaction.state, 'superseded');
  assert.equal(result.result.authorization, null);
});

test('129 a same-target aligned install does not retire the existing bound transaction', async t => {
  const n = nativeFixture(t);
  const result = await n.status();
  assert.equal(result.result.transaction.state, 'awaiting_health');
  assert.equal(result.result.authorization.state, 'bound');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(n.context.updatesRoot, 'authorization.json'))), n.authorization);
});

test('132 the coordinator alone settles a matching superseded transaction and its stale recovery intent', async () => {
  let recovering = false;
  const h = await createCoordinatorHarness({ version: '2.4.3', onNative: request => recovering && request.method === 'update.status'
    ? { ok: true, result: superseded } : undefined });
  h.seed(oldState, { authorizationId: AUTH, authorizedVersion: '2.4.2' }); h.data[TABS_KEY] = [7]; recovering = true;
  const result = await h.send('codex-overleaf/consent-update-recover');
  assert.equal(result.ok, true);
  assert.equal(h.data[UPDATE_KEY].state, 'idle');
  assert.equal(h.data[UPDATE_KEY].recoveryPending, false);
  assert.equal(h.data[CONSENT_KEY].authorizationId, '');
  assert.deepEqual(h.data[TABS_KEY], []);
  assert.equal(h.events.some(x => ['update.rollback', 'update.revoke', 'update.apply'].includes(x.method)), false);
});

for (const change of [{ installedAligned: false }, { activeVersion: '2.4.2' },
  { authorization: { state: 'bound', transactionId: 'new-transaction' } }]) {
  test(`132 incomplete or newer Native evidence cannot retire browser recovery ${JSON.stringify(change)}`, async () => {
    let recovering = false;
    const h = await createCoordinatorHarness({ onNative: request => recovering && request.method === 'update.status'
      ? { ok: true, result: { ...superseded, ...change } } : undefined });
    h.seed(oldState, { authorizationId: AUTH, authorizedVersion: '2.4.2' }); recovering = true;
    await h.send('codex-overleaf/consent-update-recover');
    assert.equal(h.data[UPDATE_KEY].recoveryPending, true);
    assert.equal(h.data[UPDATE_KEY].transactionId, oldState.transactionId);
    assert.equal(h.data[CONSENT_KEY].authorizationId, AUTH);
  });
}

test('132 an older coordinator response cannot overwrite a newly persisted transaction even with a matching old terminal response', async () => {
  const pending = defer(); let recovering = false;
  const h = await createCoordinatorHarness({ onNative: request => recovering && request.method === 'update.status' ? pending.promise : undefined });
  h.seed(oldState); recovering = true;
  const response = h.send('codex-overleaf/consent-update-recover'); await flush();
  const newer = { ...oldState, transactionId: 'new-transaction', operationId: 'new-operation', latestVersion: '2.4.4' };
  h.seed(newer, { authorizationId: 'new-authorization', authorizedVersion: '2.4.4' });
  pending.resolve({ ok: true, result: { ...superseded, transaction: { ...superseded.transaction, state: 'committed' } } });
  await response;
  assert.deepEqual(h.data[UPDATE_KEY], newer);
  assert.equal(h.data[CONSENT_KEY].authorizationId, 'new-authorization');
});
