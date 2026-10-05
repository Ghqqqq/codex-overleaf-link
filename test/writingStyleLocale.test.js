const assert = require('node:assert/strict');
const test = require('node:test');
const { harness, flush } = require('./_helpers/writingStyleSettingsHarness');
const field = (h, key) => h.host.querySelector('[data-style-focus="' + key + '"]');
const status = h => h.host.querySelector('.ws2-status')?.textContent || '';
function find(root, predicate) { if (predicate(root)) return root; for (const child of root.children) { const found = find(child, predicate); if (found) return found; } return null; }
function switchBoth(h, english, chinese) {
  h.changeLocale('zh'); assert.equal(status(h), chinese);
  h.changeLocale('en'); assert.equal(status(h), english);
  h.changeLocale('zh'); assert.equal(status(h), chinese);
}

test('reference-limit status changes language without changing selected sources or enabled state', async t => {
  const h = await harness(t);
  const input = find(h.host, node => node.type === 'file');
  input.files = ['中文论文.pdf', 'English paper.pdf', 'extra.pdf'].map((name, index) => ({ name, size: 10, lastModified: index }));
  input.dispatch('change');
  assert.equal(status(h), 'Three references selected. Remove one to add another.');
  switchBoth(h, 'Three references selected. Remove one to add another.', '已选三份资料，移除一份后可继续添加。');
  assert.match(h.host.textContent, /中文论文.pdf/);
  assert.match(h.host.textContent, /English paper.pdf/);
  assert.doesNotMatch(h.host.textContent, /extra.pdf/);
  assert.equal(field(h, 'enable-style').checked, true);
  assert.equal(field(h, 'add-pdf').disabled, true);
  assert.equal(h.sent.length, 0);
});

test('completed writing-style status changes language without changing generated labels or captured style', async t => {
  const metadata = { enabled: false, ready: false, sources: [], snapshot: null };
  const snapshot = { accountScopeId: 'account-one', projectId: 'target-one', version: 'a'.repeat(36), bundleHash: 'b'.repeat(64), label: '用户风格 User style' };
  let builds = 0;
  const h = await harness(t, { metadata, overrides: { startBuild: async () => {
    builds++;
    Object.assign(metadata, { ready: true, enabled: true, label: snapshot.label, sources: [{ kind: 'project', projectId: 'reference-one', name: '用户标题 User title' }],
      snapshot, sections: [], traits: [], createdAt: '2026-10-05T00:00:00Z' });
    return { id: 'style-build', promise: Promise.resolve({ ok: true, result: { writingStyle: metadata } }) };
  } } });
  await h.generate();
  const before = h.ctl.capture();
  assert.equal(status(h), 'Writing style is ready.');
  switchBoth(h, 'Writing style is ready.', '写作风格已就绪。');
  assert.deepEqual(h.ctl.capture(), before);
  assert.match(h.host.textContent, /用户风格 User style/);
  assert.match(h.host.textContent, /用户标题 User title/);
  assert.equal(field(h, 'enable-style').checked, true);
  assert.equal(builds, 1);
});

test('cancelled generation status follows language while cancellation still prevents a build', async t => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const h = await harness(t, { marker: '-----BEGIN PRIVATE KEY-----', rules: { sensitiveConfirmAllowed: true }, approve: true,
    onConfirm: async () => { entered(); await wait; } });
  await h.generate(); await ready;
  field(h, 'cancel-generation').dispatch('click');
  h.changeLocale('zh');
  assert.match(h.host.textContent, /正在取消生成/);
  assert.equal(field(h, 'cancel-generation').disabled, true);
  release(); await flush();
  switchBoth(h, 'Style generation cancelled.', '已取消风格生成。');
  assert.equal(h.sent.length, 0);
  assert.equal(field(h, 'enable-style').checked, true);
  assert.match(h.host.textContent, /Reference one/);
});

test('known request failure follows both languages while unknown external diagnostics stay original', async t => {
  const h = await harness(t, { buildError: { code: 'codex_run_failed', message: 'Writing-style asset integrity changed.' } });
  await h.generate();
  switchBoth(h, 'Writing-style asset integrity changed.', '写作风格资产不可用，请在常规设置中重新生成。');
});

test('unknown external diagnostics are preserved on locale refresh', async t => {
  const detail = '外部诊断 external diagnostic';
  const h = await harness(t, { buildError: { code: 'unknown_external_failure', message: detail } });
  await h.generate();
  switchBoth(h, detail, detail);
});

test('a failed reference-directory message changes language with the existing picker', async t => {
  const h = await harness(t, { initializeOnly: true, overrides: { listProjects: async () => null } });
  const toggle = field(h, 'enable-style'); toggle.checked = true; toggle.dispatch('change'); await flush();
  assert.match(h.host.textContent, /The project directory could not be read\./);
  h.changeLocale('zh');
  assert.match(h.host.textContent, /项目目录未能读取。/);
  assert.doesNotMatch(h.host.textContent, /The project directory could not be read\./);
  h.changeLocale('en');
  assert.match(h.host.textContent, /The project directory could not be read\./);
  assert.equal(field(h, 'enable-style').checked, true);
});

test('known reference-read errors translate their own sentence and preserve the user title', async t => {
  const title = '参考文章 Paper title';
  const h = await harness(t, { overrides: {
    listProjects: async () => [{ projectId: 'reference-one', name: title }],
    getReferenceSnapshot: async () => ({ projectId: 'different-project' })
  } });
  await h.generate();
  switchBoth(h, 'The reference project could not be read completely: ' + title, '参考项目未能完整读取：' + title);
  assert.match(h.host.textContent, /参考文章 Paper title/);
  assert.equal(field(h, 'enable-style').checked, true);
  assert.equal(h.sent.length, 0);
});
