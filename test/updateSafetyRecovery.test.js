'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const { extractFunction } = require('./_helpers/extractFunction');
function harness() {
  let now = 100000;
  const url = 'https://www.overleaf.com/project/fixture';
  const h = { url, documentId: 'document-one', fileId: 'file-one', saved: true, mutations: [], calls: [], inputListeners: {},
    panel: { dataset: {}, textContent: 'original draft', getClientRects: () => [{}] }, state: 'bootstrap_pending', locked: true,
    tx: { id: 'transaction-one', targetVersion: '2.5.1', sourceVersion: '2.5.0' }, bgListeners: [], contentListeners: [], windowListeners: [],
    data: { 'codex-overleaf-managed-update-tabs-v1': [1] }, reorderStorage: true, storageReads: 0,
    advance(ms) { now += ms; } };
  class Clock extends Date { static now() { return now; } }
  const location = { get href() { return h.url; }, get origin() { return new URL(h.url).origin; } };
  const saveNode = { get textContent() { return h.saved ? 'All changes saved' : 'Unsaved changes'; },
    getAttribute: () => null, hasAttribute: () => false, closest: () => null, getClientRects: () => [{}] };
  const document = { querySelector(selector) {
    if (selector === '#codex-overleaf-panel') return h.panel;
    if (selector.includes('data-file-id')) return { getAttribute: () => h.fileId };
    return null;
  }, querySelectorAll(selector) {
    if (selector.includes('dialog') || selector.includes('button')) return h.dialog ? [saveNode] : [];
    return h.noIndicator ? [] : [saveNode];
  }, addEventListener(type, fn) { (h.inputListeners[type] ||= []).push(fn); } };
  const timers = { setTimeout(fn, ms) {
    if (ms <= 1500) { now += ms; queueMicrotask(fn); return 0; }
    return setTimeout(fn, ms);
  }, clearTimeout };
  h.main = vm.createContext({ location, document, crypto, Date: Clock, navigator: { onLine: true }, ...timers });
  h.main.window = h.main;
  h.isolated = vm.createContext({ location, document, crypto, Date: Clock, ...timers });
  h.isolated.window = h.isolated;
  h.isolated.addEventListener = (type, fn) => { if (type === 'message') h.windowListeners.push(fn); };
  const dispatch = (listeners, message, sender) => new Promise(resolve => {
    let handled = false;
    for (const listener of listeners) if (listener(message, sender, resolve) === true) handled = true;
    if (!handled) resolve(undefined);
  });
  h.isolated.chrome = { runtime: { id: 'fixture', onMessage: { addListener: fn => h.contentListeners.push(fn) },
    sendMessage: message => dispatch(h.bgListeners, message, { id: 'fixture', tab: { id: 1 }, frameId: 0,
      documentId: h.documentId, url: h.url }) } };
  const chrome = { runtime: { id: 'fixture', onMessage: { addListener: fn => h.bgListeners.push(fn) } },
    storage: { local: { async get(keys) {
      const result = Object.fromEntries(keys.map(key => [key, structuredClone(h.data[key])]));
      return h.reorderStorage ? reorderKeys(result, ++h.storageReads % 2 === 0) : result;
    }, async set(value) {
      if (h.storageFailure) throw Error('storage failed');
      Object.assign(h.data, h.reorderStorage ? reorderKeys(structuredClone(value)) : structuredClone(value));
    } } },
    tabs: { async query() { return h.closed ? [] : [{ id: 1, url: h.url }]; }, async sendMessage(id, message, target) {
      h.calls.push(message.type);
      if (!target) return undefined; // Chrome can resolve an unhandled message without an ACK.
      assert.equal(target.documentId, h.documentId);
      return dispatch(h.contentListeners, message, { id: 'fixture' });
    } }, scripting: { async executeScript(input) {
      h.calls.push(input.files || input.world);
      if (input.target.documentIds && input.target.documentIds[0] !== h.documentId) throw Error('document disappeared');
      const context = input.world === 'MAIN' ? h.main : h.isolated;
      let result;
      if (input.files) {
        if (h.failInjection) { h.failInjection = false; throw Error('transient injection failure'); }
        for (const name of input.files) vm.runInContext(fs.readFileSync(path.join(ROOT, 'extension', name.replace(/^runtime\//, '')), 'utf8'), context);
      } else {
        context.__args = input.args || [];
        result = await vm.runInContext(`(${input.func.toString()})(...__args)`, context);
      }
      return [{ frameId: 0, documentId: h.documentId, result }];
    } } };
  h.background = vm.createContext({ chrome, crypto, ...timers });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'extension/src/backgroundUpdateSafety.js'), 'utf8'), h.background);
  h.options = { isExecutionLocked: () => h.locked, request: async () => ({ ok: true, result: { transaction: { ...h.tx, state: h.state } } }) };
  h.recovery = h.background.CodexOverleafBackgroundUpdateSafety.create(h.options);
  h.owner = { transactionId: h.tx.id, sourceVersion: h.tx.sourceVersion, targetVersion: h.tx.targetVersion, expectedState: 'bootstrap_pending' };
  h.probe = () => h.recovery.probe({ id: 1, url: h.url }, h.owner);
  h.input = () => h.inputListeners.input.forEach(fn => fn({ target: { closest: () => h.panel } }));
  h.pageMessage = data => h.windowListeners.forEach(fn => {
    h.isolated.__message = data;
    vm.runInContext('globalThis.__event={source:globalThis,origin:location.origin,data:__message}', h.isolated);
    fn(h.isolated.__event);
  });
  return h;
}
function reorderKeys(value, reverse = false) {
  if (Array.isArray(value)) return value.map(item => reorderKeys(item, reverse));
  if (!value || typeof value !== 'object') return value;
  const keys = Object.keys(value).sort();
  if (reverse) keys.reverse();
  return Object.fromEntries(keys.map(key => [key, reorderKeys(value[key], reverse)]));
}

test('a disconnected page gets only safety receivers and retains the old panel and idle/save delays', async () => {
  const h = harness();
  const before = h.panel;
  const first = await h.probe();
  assert.equal(first.idle, false);
  assert.ok(first.blockers.includes('recent_user_activity'));
  h.advance(30000);
  assert.equal((await h.probe()).idle, true);
  assert.equal(h.panel, before);
  assert.equal(h.panel.textContent, 'original draft');
  assert.equal(h.calls.flat().some(value => /content-bundle|contentRuntime|pageBridge\.js/.test(value)), false);
  h.input();
  assert.equal((await h.probe()).idle, false, 'old panel input also resets the quiet window');
});

test('unsaved documents and dialogs remain blocked and only an actual saved interval releases them', async () => {
  const h = harness(); h.saved = false;
  assert.equal((await h.probe()).saved, false);
  h.advance(30000);
  assert.equal((await h.probe()).idle, false);
  h.saved = true;
  assert.equal((await h.probe()).idle, false, 'the first saved observation has no 3s history');
  h.advance(3000); h.dialog = true;
  assert.equal((await h.probe()).idle, false);
  h.dialog = false;
  assert.equal((await h.probe()).idle, true);
});

test('old page write RPCs stay busy through their matching response and then restart idle timing', async () => {
  const h = harness(); await h.probe(); h.advance(30000);
  h.pageMessage({ source: 'codex-overleaf/content', method: 'applyOperations', id: 'old-write' });
  h.advance(60000);
  assert.ok((await h.probe()).blockers.includes('reviewAction'));
  h.pageMessage({ source: 'codex-overleaf/page', id: 'different-write' });
  assert.equal((await h.probe()).idle, false);
  h.pageMessage({ source: 'codex-overleaf/page', id: 'old-write' });
  assert.equal((await h.probe()).idle, false);
  h.advance(30000);
  assert.equal((await h.probe()).idle, true);
});

test('injection failure retries and a new worker rotates its token without adding listeners', async () => {
  const h = harness(); h.failInjection = true;
  assert.equal((await h.probe()).idle, false);
  await h.probe(); h.advance(30000);
  assert.equal((await h.probe()).idle, true);
  const count = h.contentListeners.length;
  h.bgListeners.length = 0; // The terminated worker has no surviving Chrome listeners.
  h.recovery = h.background.CodexOverleafBackgroundUpdateSafety.create(h.options);
  assert.equal((await h.probe()).idle, true);
  assert.equal(h.contentListeners.length, count);
});

for (const change of ['document', 'url', 'transaction', 'lock']) test(`${change} change invalidates the captured recovery scope`, async () => {
  const h = harness(); await h.probe(); h.advance(30000);
  if (change === 'document') h.documentId = 'replacement-document';
  if (change === 'url') h.url += '/another';
  if (change === 'transaction') h.tx.id = 'replacement-transaction';
  if (change === 'lock') h.locked = false;
  assert.equal((await h.probe()).idle, false);
});

test('positive save signals do not require CM, while quiet fallback cannot use rendered viewport text', async () => {
  const h = harness();
  assert.equal((await h.probe()).saved, true);
  h.noIndicator = true; h.advance(30000);
  assert.equal((await h.probe()).saved, false);
  h.main.overleaf = { unstable: { editorView: { dispatch() {}, state: { doc: { toString: () => 'the full document' } } } } };
  assert.equal((await h.probe()).saved, true);
});

test('changing active file with the same empty CM document invalidates a pending save proof', async () => {
  const h = harness(); await h.probe();
  const doc = { toString: () => '' };
  h.main.overleaf = { unstable: { editorView: { dispatch() {}, state: { doc } } } };
  h.main.CodexOverleafSaveState = { create: () => ({ waitForSaveState: async () => {
    h.fileId = 'other-empty-file'; return { ok: true, state: 'verified_saved' };
  } }) };
  assert.equal((await h.probe()).saved, false);
});

test('guarded reload is durable, document-bound and preserves the source list on storage failure', async () => {
  const h = harness();
  h.storageFailure = true;
  await assert.rejects(h.recovery.protectReloadTabs(h.tx));
  assert.deepEqual(h.data['codex-overleaf-managed-update-tabs-v1'], [1]);
  h.storageFailure = false;
  assert.equal(await h.recovery.protectReloadTabs(h.tx), true);
  assert.deepEqual(h.data['codex-overleaf-managed-update-tabs-v1'], []);
  assert.equal(h.data['codex-overleaf-managed-update-guarded-tabs-v1'].entries[0].documentId, h.documentId);
  h.documentId = 'replacement-document';
  assert.equal(await h.recovery.releaseReloadTabs(h.tx), false);
  h.state = 'rolled_back';
  assert.equal(await h.recovery.hasReplacedReloadDocument(h.tx), true);
  assert.deepEqual(h.data['codex-overleaf-managed-update-tabs-v1'], [], 'new documents never inherit the old refresh list');
  h.documentId = 'document-one';
  assert.equal(await h.recovery.releaseReloadTabs(h.tx, 'rolled_back'), true);
  assert.deepEqual(h.data['codex-overleaf-managed-update-tabs-v1'], [1]);
});

test('a disabled unknown Undo remains busy, while completed historical reviews do not block recovery', async () => {
  const h = harness();
  const original = h.isolated.document.querySelectorAll;
  let terminal = false;
  h.isolated.document.querySelectorAll = selector => selector.includes('button:disabled') ? [{
    hidden: false, textContent: 'Undo changes', getAttribute: () => null, getClientRects: () => [{}],
    hasAttribute: key => key === 'data-run-undo', closest: () => ({ querySelector: () => ({ textContent: terminal ? 'Accepted' : 'Accept All' }) })
  }] : original(selector);
  await h.probe(); h.advance(30000);
  assert.ok((await h.probe()).blockers.includes('reviewAction'));
  terminal = true;
  assert.equal((await h.probe()).idle, true);
});

test('an older guard retires only after every captured document has disappeared', async () => {
  const h = harness();
  assert.equal(await h.recovery.protectReloadTabs(h.tx), true);
  h.tx.id = 'new-transaction';
  h.data['codex-overleaf-managed-update-tabs-v1'] = [1];
  assert.equal(await h.recovery.protectReloadTabs(h.tx), false, 'an unchanged old document is still protected');
  h.documentId = 'new-document';
  assert.equal(await h.recovery.protectReloadTabs(h.tx), true);
  assert.equal(h.data['codex-overleaf-managed-update-guarded-tabs-v1'].transactionId, 'new-transaction');
});

test('the temporary receiver has no full-runtime health or ordinary update-idle endpoint', async () => {
  const h = harness(); await h.probe();
  for (const type of ['codex-overleaf/runtime-health-probe', 'codex-overleaf/update-idle-probe']) {
    for (const listener of h.contentListeners) assert.equal(listener({ type }, { id: 'fixture' }, () => {
      assert.fail('safety-only receiver must not answer runtime health');
    }), undefined);
  }
});

test('the real background retries an unacknowledged standard probe through the temporary receiver', async () => {
  const h = harness();
  const source = fs.readFileSync(path.join(ROOT, 'extension/src/background.js'), 'utf8');
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'extension/bootstrap/updateStatus.js'), 'utf8'), h.background);
  Object.assign(h.background, { migrationSafety: h.recovery, MANAGED_OVERLEAF_MATCHES: ['https://www.overleaf.com/project/*'],
    isManagedEditorTab: () => true, sendNativeRequest: async () => ({ ok: true, result: { idle: true, blockers: [] } }) });
  vm.runInContext(extractFunction(source, 'probeManagedUpdateTab'), h.background);
  vm.runInContext(extractFunction(source, 'verifyManagedUpdateSafety'), h.background);
  assert.equal((await h.background.verifyManagedUpdateSafety(h.owner)).ok, false);
  h.advance(30000);
  assert.equal((await h.background.verifyManagedUpdateSafety(h.owner)).ok, true);
  assert.equal(h.calls.filter(value => value === 'codex-overleaf/update-idle-probe').length, 2);
  assert.ok(h.calls.filter(value => value === 'codex-overleaf/migration-idle-probe').length >= 3);
});

test('a changed Native owner cannot revalidate an empty probe set or release an old refresh list', async () => {
  const h = harness(), original = { ...h.tx };
  await h.recovery.protectReloadTabs(original);
  h.tx.id = 'another-transaction';
  assert.equal(await h.recovery.revalidate([], h.owner), false);
  assert.equal(await h.recovery.releaseReloadTabs(original), false);
  assert.deepEqual(h.data['codex-overleaf-managed-update-tabs-v1'], []);
});

test('Chrome storage may reorder nested object keys without changing protected document identities', async () => {
  const h = harness(); h.reorderStorage = true; h.storageReads = 0;
  assert.equal(await h.recovery.protectReloadTabs(h.tx), true);
  assert.deepEqual(h.data['codex-overleaf-managed-update-tabs-v1'], []);
  assert.equal(await h.recovery.releaseReloadTabs(h.tx), true);
  assert.deepEqual(h.data['codex-overleaf-managed-update-tabs-v1'], [1]);
});

test('structural readback still rejects changed fields, extra keys, types and reordered tab arrays', () => {
  const context = vm.createContext({});
  vm.runInContext(extractFunction(fs.readFileSync(path.join(ROOT, 'extension/src/backgroundUpdateSafety.js'), 'utf8'), 'sameStored'), context);
  const guard = { transactionId: 'original', sourceVersion: '2.5.0', targetVersion: '2.5.1', state: 'guarded',
    entries: [{ tabId: 1, documentId: 'doc-one', url: 'https://www.overleaf.com/project/one' },
      { tabId: 2, documentId: 'doc-two', url: 'https://www.overleaf.com/project/two' }] };
  assert.equal(context.sameStored(guard, reorderKeys(guard, true)), true);
  for (const change of [value => { value.transactionId = 'other'; }, value => { value.sourceVersion = '2.4.9'; },
    value => { value.targetVersion = '2.5.2'; }, value => { value.state = 'ready'; },
    value => { value.entries[0].tabId = '1'; }, value => { value.entries[0].documentId = 'new-document'; },
    value => { value.entries[0].url += '/new'; }, value => { value.extra = true; },
    value => { delete value.entries[0].url; }, value => { value.entries.reverse(); }]) {
    const changed = structuredClone(guard); change(changed);
    assert.equal(context.sameStored(guard, changed), false);
  }
});
