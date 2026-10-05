'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { harness, flush } = require('./_helpers/writingStyleSettingsHarness');
const marker = '-----BEGIN PRIVATE KEY-----'; // Detector shape, never a real secret.
for (const spec of [
  { name: 'default block', marker, expected: 0 },
  { name: 'clean project', expected: 1 },
  { name: 'scan disabled', marker, rules: { sensitiveCheckEnabled: false }, expected: 1 },
  { name: 'confirmation denied', marker, rules: { sensitiveConfirmAllowed: true }, expected: 0 },
  { name: 'confirmation approved', marker, rules: { sensitiveConfirmAllowed: true }, approve: true, expected: 1 },
  { name: 'Chinese block', marker, locale: 'zh', expected: 0 }
]) test('style project references use production sensitive policy: ' + spec.name, async t => {
  const h = await harness(t, spec); await h.generate();
  assert.equal(h.sent.length, spec.expected);
  assert.equal(h.confirmations.length, spec.rules?.sensitiveConfirmAllowed ? 1 : 0);
  assert.equal(JSON.stringify(h.confirmations).includes(marker), false, 'confirmation must redact detected material');
  if (spec.locale === 'zh') assert.match(h.host.textContent, /已阻止：需要处理敏感内容/);
  if (spec.expected) assert.equal(h.sent[0].writingStyleBuild.sources[0].kind, 'project');
});
for (const change of ['scope', 'cancel']) test('style preflight rechecks ' + change + ' after confirmation', async t => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const confirmation = new Promise(resolve => { release = resolve; });
  const h = await harness(t, { marker, rules: { sensitiveConfirmAllowed: true }, approve: true,
    onConfirm: async () => { entered(); await confirmation; } });
  await h.generate(); await ready;
  if (change === 'scope') h.scope({ accountScopeId: 'account-two', projectId: 'target-two' });
  else h.host.querySelector('[data-style-focus="cancel-generation"]').dispatch('click');
  release(); await flush(); assert.equal(h.sent.length, 0);
});
test('new style availability and lock errors follow the Chinese locale', async t => {
  const h = await harness(t, { locale: 'zh', initializeOnly: true,
    metadata: { enabled: false, ready: false, sources: [], snapshot: null, error: 'The saved writing skill changed. Rebuild it in General settings.', errorCode: 'writing_style_changed' } });
  assert.match(h.host.textContent, /写作风格资产不可用/);
  const ctl = require('../extension/src/content/writingStyleSettings').create({ tx: (_en, zh) => zh,
    getScope: () => ({ accountScopeId: 'a', projectId: 'p' }), request: async () => ({ ok: false, error: { code: 'writing_style_busy', message: 'English fallback' } }) });
  await assert.rejects(ctl.ensureLoaded(true), /写作风格设置正在由另一个本地进程更新/);
});
for (const [message, expected] of [
  ['Writing-style settings are being updated by another Native Host. Retry shortly.', /写作风格设置正在由另一个本地进程更新/],
  ['Writing-style asset integrity changed.', /写作风格资产不可用/]
]) test('wrapped Native build failure keeps the Chinese locale: ' + message, async t => {
  const h = await harness(t, { locale: 'zh', buildError: { code: 'codex_run_failed', message } });
  await h.generate(); assert.equal(h.sent.length, 1); assert.match(h.host.textContent, expected);
});
