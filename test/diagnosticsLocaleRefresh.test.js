'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const I18n = require('../extension/src/shared/i18n');

function fixture(options = {}) {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/src/content/diagnosticsController.js'), 'utf8'), { window });
  let locale = 'en', projectId = 'project', nativeCalls = 0, pageCalls = 0, mirrorCalls = 0, result;
  let nativeResolve;
  let otEnabled = options.otEnabled === true, warmStartCalls = 0;
  const mirrorState = {};
  const tx = (en, zh) => locale === 'zh' ? zh : en;
  const tr = key => I18n.t(locale, key);
  const controller = window.CodexOverleafDiagnosticsController.create({ tr, tx,
    getExtensionCompatibilityMetadata: () => ({}), getCurrentProjectId: () => projectId,
    getScope: () => ({ projectId }),
    showDiagnosticsLoading: (title, subtitle) => { result = { title, subtitle, status: 'running' }; },
    showDiagnosticsResult: value => { result = value; }, setDiagnosticsHealth() {},
    sendBackgroundNative: () => { nativeCalls++; return new Promise(resolve => { nativeResolve = resolve; }); },
    callPageBridge: async method => { pageCalls++; if (options.failPage) throw new Error('External error 用户原文'); if (method === 'probe') return {
      editor: { ok: true }, reviewing: { ok: true }, capabilities: { editor: { write: true } },
      reviewingDiagnostics: { reviewLikeControls: [{ tag: 'button', text: '用户原文 External text' }] }
    }; if (method === 'getProjectSnapshot') return { files: [{ path: '用户.tex', content: 'user 原文' }], capabilities: { fullProjectSnapshot: true, method: 'external-source' } };
      return { ok: true, status: 'observing' }; },
    getState: () => ({ mode: 'ask' }), getProbeRunReadiness: () => ({}),
    formatProbeStatusBar: () => tx('Current file ready', '当前文件可用'),
    isExperimentalOtEnabled: () => otEnabled, getOtWarmMirrorState: () => mirrorState,
    getCurrentOtStatus: () => 'observing', getActiveFocusFiles: () => [],
    otWarmMirrorController: { canUseOtWarmStart: () => { warmStartCalls++; return { ok: true }; }, getFailureMessageKey: () => 'diagnosticsCheckErrored' },
    getMirrorFreshness: async () => { mirrorCalls++; return {}; },
    readOtBridgeStatus: value => value.status, normalizeOtStatus: value => value, formatOtStatusLabel: value => value,
    isTextSnapshotFile: file => file.content !== undefined,
    getProjectSnapshotWarnings: () => ({ blocking: [], nonBlocking: [] }),
    formatProjectSnapshotWarning: value => value, formatProjectSnapshotLog: () => 'External project log 用户原文',
    INSTALL_COMMAND: 'synthetic-install', RUN_SNAPSHOT_ZIP_TIMEOUT_MS: 1
  });
  return { controller, get result() { return result; }, counts: () => [nativeCalls, pageCalls, mirrorCalls],
    warmStartCalls: () => warmStartCalls,
    disableOtWithFailure() { otEnabled = false; mirrorState.failureActive = true; mirrorState.lastErrorCode = 'later_failure'; },
    changeLocale(value) { locale = value; }, changeScope() { projectId = 'another-project'; },
    resolveNative() { nativeResolve({ ok: true, result: { environment: { codex: { ok: true, path: '/external/用户/codex' }, latex: { available: ['latexmk'] } } } }); }
  };
}

for (const method of ['inspectNativeEnvironment', 'inspectPageStateDiagnostics', 'inspectProjectSnapshot', 'inspectOtWarmMirrorDiagnostics', 'runAllDiagnostics']) {
  test(`${method}: locale refresh reuses existing results and keeps raw details`, async () => {
    const f = fixture(), pending = f.controller[method]();
    if (method === 'inspectNativeEnvironment' || method === 'runAllDiagnostics') f.resolveNative();
    await pending;
    const before = JSON.stringify(f.result), calls = f.counts();
    f.changeLocale('zh');
    const translated = f.controller.refreshLocale();
    assert.notEqual(translated.title, f.result.title);
    assert.equal(translated.status, f.result.status);
    assert.equal(translated.technical, f.result.technical);
    if (method === 'runAllDiagnostics') {
      assert.equal(translated.checks.length, 4);
      assert.equal(translated.checks[0].title, I18n.t('zh', 'diagnosticsNativeShort'));
      assert.match(translated.checks[0].summary, /Codex 已连接/);
    }
    assert.deepEqual(f.counts(), calls);
    assert.equal(JSON.stringify(f.result), before);
    f.changeLocale('en');
    assert.equal(JSON.stringify(f.controller.refreshLocale()), before);
  });
}

test('loading locale refresh does not restart the check and stale scope is not projected', async () => {
  const f = fixture(), pending = f.controller.inspectNativeEnvironment();
  f.changeLocale('zh');
  const loading = f.controller.refreshLocale();
  assert.equal(loading.title, I18n.t('zh', 'diagnosticsNativeTitle'));
  assert.equal(loading.status, 'running');
  assert.deepEqual(f.counts(), [1, 0, 0]);
  f.changeScope();
  assert.equal(f.controller.refreshLocale(), null);
  f.resolveNative(); await pending;
  assert.equal(f.result.status, 'running');
});

for (const method of ['inspectPageStateDiagnostics', 'inspectProjectSnapshot']) {
  test(`${method}: failure summary follows locale while external error evidence stays exact`, async () => {
    const f = fixture({ failPage: true });
    await f.controller[method]();
    const before = JSON.stringify(f.result), calls = f.counts();
    f.changeLocale('zh');
    const result = f.controller.refreshLocale();
    assert.equal(result.status, 'failed');
    assert.match(result.summary, /插件|Overleaf 页面/);
    assert.equal(result.technical, f.result.technical);
    assert.match(result.technical, /External error 用户原文/);
    assert.deepEqual(f.counts(), calls);
    assert.equal(JSON.stringify(f.result), before);
  });
}

test('enabled OT results retain their observed state without running warm-start checks again', async () => {
  const f = fixture({ otEnabled: true });
  await f.controller.inspectOtWarmMirrorDiagnostics();
  const before = JSON.stringify(f.result), calls = f.counts(), warmStartCalls = f.warmStartCalls();
  assert.equal(f.result.status, 'completed');
  f.disableOtWithFailure();
  f.changeLocale('zh');
  const result = f.controller.refreshLocale();
  assert.equal(result.status, 'completed');
  assert.equal(result.summary, I18n.t('zh', 'diagnosticsOtSummaryEnabled'));
  assert.equal(result.technical, f.result.technical);
  assert.deepEqual(f.counts(), calls);
  assert.equal(f.warmStartCalls(), warmStartCalls);
  assert.equal(JSON.stringify(f.result), before);
});

function panelFixture() {
  class Node {
    constructor() { this.children = []; this.dataset = {}; this.attributes = {}; this.hidden = false; this.style = {}; this.open = false; this.scrollTop = 0; this._text = ''; this.isConnected = false; }
    append(...items) { this.children.push(...items); }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key]; }
    set textContent(value) { this._text = value; this.children = []; }
    get textContent() { return this._text + this.children.map(item => item.textContent).join(''); }
    querySelectorAll(selector) { return this.children.flatMap(child => [(selector === '.' + child.className ? child : null), ...child.querySelectorAll(selector)]).filter(Boolean); }
    querySelector(selector) { return this.nodes?.[selector] || this.querySelectorAll(selector)[0] || null; }
  }
  const window = {}, document = { createElement: () => new Node() };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/src/content/diagnosticsPanel.js'), 'utf8'), { window, document });
  const nodes = Object.fromEntries(['result', 'result-title', 'result-subtitle', 'result-body', 'result-details', 'result-technical', 'result-close', 'menu', 'health-dot', 'popover'].map(key => ['[data-diagnostics-' + key + ']', new Node()]));
  nodes['.codex-diagnostics-result-scroll'] = new Node();
  const result = nodes['[data-diagnostics-result]']; result.nodes = nodes;
  result.children = [nodes['[data-diagnostics-result-body]']];
  const container = new Node(); container.nodes = nodes;
  const state = { container, resultDismissed: false, i18n: { tr: key => I18n.t('zh', key) } };
  const api = window.CodexOverleafDiagnosticsPanel;
  return { api, state, nodes, result };
}

test('visible diagnostic repaint preserves disclosures and scroll without reopening a dismissed result', () => {
  const f = panelFixture();
  const original = { title: 'Diagnostics', status: 'warning', checks: [{ status: 'warning', title: 'Local connection', summary: 'Check it' }], technical: 'External log 用户原文' };
  f.api.showResult(f.state, original);
  const details = f.nodes['[data-diagnostics-result-details]'];
  details.open = true;
  f.nodes['.codex-diagnostics-result-scroll'].scrollTop = 63;
  f.result.querySelectorAll('.codex-diagnostics-check')[0].open = false;
  f.nodes['[data-diagnostics-health-dot]'].dataset.health = 'warn';
  const projected = { ...original, title: '诊断', checks: [{ status: 'warning', title: '本机连接', summary: '请检查' }] };
  f.api.refreshLocale(f.state, projected);
  assert.equal(f.nodes['[data-diagnostics-result-title]'].textContent, '诊断');
  assert.equal(f.nodes['[data-diagnostics-result-technical]'].textContent, original.technical);
  assert.equal(f.nodes['[data-diagnostics-result-close]'].getAttribute('aria-label'), I18n.t('zh', 'closeDiagnostics'));
  assert.equal(details.open, true);
  assert.equal(f.result.querySelectorAll('.codex-diagnostics-check')[0].open, false);
  assert.equal(f.nodes['.codex-diagnostics-result-scroll'].scrollTop, 63);
  f.api.closeResult(f.state);
  f.api.refreshLocale(f.state, original);
  assert.equal(f.result.hidden, true);
  assert.equal(f.nodes['[data-diagnostics-result-title]'].textContent, '诊断');
});
