const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const crypto = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(repoRoot, 'extension/bootstrap/popupFallback.js'), 'utf8');
const markup = fs.readFileSync(path.join(repoRoot, 'extension/bootstrap/popup.html'), 'utf8');
const english = 'Codex Overleaf Link could not load its runtime. Rerun the installer, then reload the extension.';
const chinese = 'Codex Overleaf Link 无法加载运行组件。请重新运行安装程序，再重新加载扩展。';
const flush = () => new Promise(resolve => setImmediate(resolve));

function createHarness({ locale = 'en', read, nativeResponse } = {}) {
  const h = { present: true, message: { textContent: english }, html: { lang: 'en' }, locale, nativeCalls: [], reloads: 0 };
  const shell = { querySelector: selector => selector === 'p' ? h.message : null };
  const context = {
    crypto, setTimeout: callback => { h.timer = callback; },
    document: { documentElement: h.html, querySelector: selector => h.present && selector === '[data-bootstrap-shell]' ? shell : null,
      addEventListener: (type, callback) => { if (type === 'DOMContentLoaded') h.loaded = callback; } },
    chrome: { runtime: { reload: () => { h.reloads++; }, sendNativeMessage: (host, request, callback) => {
      h.nativeCalls.push({ host, request }); callback(nativeResponse); h.nativeCallback = callback;
    } }, storage: {
      local: { get: read || (async () => ({ codexOverleafGlobalPrefsV1: { values: { locale: h.locale } } })) },
      onChanged: { addListener: listener => { h.changed = listener; } }
    } }
  };
  vm.runInNewContext(script, context);
  h.changeLocale = value => { h.locale = value; h.changed({ codexOverleafGlobalPrefsV1: { newValue: { values: { locale: value } } } }, 'local'); };
  return h;
}

test('Managed fallback has an independent script before the replaceable runtime assets', () => {
  assert.match(markup, /<script src="popupFallback\.js"><\/script>/);
  assert.ok(markup.indexOf('src="popupFallback.js"') < markup.indexOf('src="../runtime/src/shared/compatibility.js"'));
  assert.ok(require('../package.json').files.includes('extension/bootstrap/'));
});

test('the existing runtime-load failure follows stored language and both hot-switch directions', async () => {
  // Deliberately execute only the Bootstrap script: the runtime asset did not load.
  const h = createHarness({ locale: 'zh' });
  await flush();
  assert.equal(h.message.textContent, chinese);
  assert.equal(h.html.lang, 'zh-CN');
  h.changeLocale('en');
  await flush();
  assert.equal(h.message.textContent, english);
  assert.equal(h.html.lang, 'en');
  h.changeLocale('zh');
  await flush();
  assert.equal(h.message.textContent, chinese);
});

test('a late fallback preference read never overwrites a healthy runtime shell or language', async () => {
  let finish;
  const h = createHarness({ read: () => new Promise(resolve => { finish = resolve; }) });
  h.present = false;
  h.html.lang = 'en';
  h.message.textContent = 'healthy runtime';
  finish({ codexOverleafGlobalPrefsV1: { values: { locale: 'zh' } } });
  await flush();
  assert.equal(h.message.textContent, 'healthy runtime');
  assert.equal(h.html.lang, 'en');
});

test('a stale initial preference read cannot revert a newer fallback locale', async () => {
  let finish;
  let reads = 0;
  const h = createHarness({ read: () => ++reads === 1
    ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve({ codexOverleafGlobalPrefsV1: { values: { locale: 'zh' } } }) });
  h.changeLocale('zh');
  await flush();
  finish({ codexOverleafGlobalPrefsV1: { values: { locale: 'en' } } });
  await flush();
  assert.equal(h.message.textContent, chinese);
  assert.equal(h.html.lang, 'zh-CN');
});

test('fallback honors legacy preferences and keeps the product default if storage is unavailable', async () => {
  const legacy = createHarness({ read: async () => ({ codexOverleafPrefs: { locale: 'zh' } }) });
  const unavailable = createHarness({ read: async () => { throw new Error('storage unavailable'); } });
  await flush();
  assert.equal(legacy.message.textContent, chinese);
  assert.equal(unavailable.message.textContent, english);
});

test('a surviving fallback wakes native recovery without guessing a rollback transaction', async () => {
  const h = createHarness();
  await flush(); h.loaded(); h.timer();
  assert.equal(h.nativeCalls.length, 1);
  assert.equal(h.nativeCalls[0].host, 'com.codex.overleaf');
  assert.equal(h.nativeCalls[0].request.method, 'update.status');
  assert.equal(h.nativeCalls[0].request.params.bootstrapRecovery, true);
  assert.equal(h.nativeCalls[0].request.params.transactionId, undefined);
  assert.equal(h.message.textContent, english);
});

test('a healthy popup never invokes bootstrap recovery', async () => {
  const h = createHarness();
  await flush(); h.loaded(); h.present = false; h.timer();
  assert.equal(h.nativeCalls.length, 0);
});

function restoredStatus() {
  return { ok: true, result: { transaction: { id: 'fixture-transaction', state: 'rolled_back', sourceVersion: '2.5.0' },
    installedAligned: true, activeVersion: '2.5.0', restoredPair: { extensionVersion: '2.5.0', nativeVersion: '2.5.0',
      extensionSha256: 'a'.repeat(64), nativeSha256: 'b'.repeat(64), bootstrapSha256: 'c'.repeat(64) } } };
}

test('a fallback reloads once after Native proves the complete restored source', async () => {
  const nativeResponse = restoredStatus();
  const h = createHarness({ nativeResponse });
  await flush(); h.loaded(); h.timer();
  assert.equal(h.reloads, 1);
  h.nativeCallback(nativeResponse);
  assert.equal(h.reloads, 1);
});

for (const defect of ['bootstrapProof', 'nativeProof', 'sourceVersion', 'transaction', 'aligned']) {
  test(`fallback preserves its existing message when restoration lacks ${defect}`, async () => {
    const nativeResponse = restoredStatus();
    if (defect === 'bootstrapProof') delete nativeResponse.result.restoredPair.bootstrapSha256;
    if (defect === 'nativeProof') nativeResponse.result.restoredPair.nativeSha256 = 'invalid';
    if (defect === 'sourceVersion') nativeResponse.result.activeVersion = '2.5.1';
    if (defect === 'transaction') delete nativeResponse.result.transaction.id;
    if (defect === 'aligned') nativeResponse.result.installedAligned = false;
    const h = createHarness({ locale: 'zh', nativeResponse });
    await flush(); h.loaded(); h.timer();
    assert.equal(h.reloads, 0);
    assert.equal(h.message.textContent, chinese);
  });
}
