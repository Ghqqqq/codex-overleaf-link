const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(repoRoot, 'extension/bootstrap/popupFallback.js'), 'utf8');
const markup = fs.readFileSync(path.join(repoRoot, 'extension/bootstrap/popup.html'), 'utf8');
const english = 'Codex Overleaf Link could not load its runtime. Rerun the installer, then reload the extension.';
const chinese = 'Codex Overleaf Link 无法加载运行组件。请重新运行安装程序，再重新加载扩展。';
const flush = () => new Promise(resolve => setImmediate(resolve));

function createHarness({ locale = 'en', read } = {}) {
  const h = { present: true, message: { textContent: english }, html: { lang: 'en' }, locale };
  const shell = { querySelector: selector => selector === 'p' ? h.message : null };
  const context = {
    document: { documentElement: h.html, querySelector: selector => h.present && selector === '[data-bootstrap-shell]' ? shell : null },
    chrome: { storage: {
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
