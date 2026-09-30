const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const Observer = require('../extension/src/page/overleafRealtimeObserver');
const OtController = require('../extension/src/content/otWarmMirrorController');
const ScrollLayout = require('../extension/src/content/runScrollLayout');
const I18n = require('../extension/src/shared/i18n');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const sources = {
  runtime: read('extension/src/content/contentRuntime.js'),
  provider: read('extension/src/content/providerSettingsCoordinator.js'),
  ot: read('extension/src/content/otWarmMirror.js'),
  timeline: read('extension/src/content/runTimelineView.js')
};
const noop = () => {};

function browserFactory(source, name, globals = {}) {
  const context = { ...globals };
  context.window = { ...globals.window };
  vm.runInNewContext(source, context);
  return context.window[name];
}

function providerHarness(getLocale, selected = 'builtin') {
  let summary = '';
  let requests = 0;
  const builtin = { id: 'builtin', kind: 'builtin' };
  const custom = { id: 'dpsk', name: 'dpsk', kind: 'custom', defaultModelId: 'model' };
  const api = browserFactory(sources.provider, 'CodexOverleafProviderSettingsCoordinator').create({
    document: {}, window: {},
    ProviderProfiles: {
      normalizeCatalog: () => ({ providers: [builtin, custom] }),
      getProviderById: (_catalog, id) => id === 'builtin' ? builtin : custom,
      getActiveProvider: () => builtin
    },
    ProviderSettingsDialog: { create: () => ({ destroy: noop }) },
    tx: (en, zh) => getLocale() === 'zh' ? zh : en,
    getSelectedProviderId: () => selected,
    getSelectedModel: () => 'model',
    getSettingsPanelInstance: () => ({ setProviderSummary: value => { summary = value.summary; } }),
    sendBackgroundNative: () => { requests += 1; throw new Error('Locale projection must not fetch'); }
  });
  return { api, summary: () => summary, requests: () => requests };
}

function localeHarness() {
  let locale = 'en';
  const provider = providerHarness(() => locale);
  const status = { dataset: {}, textContent: '' };
  const task = { placeholder: '', value: '' };
  const runButton = { dataset: {}, disabled: false, title: '',
    setAttribute(name, value) { this[name] = value; } };
  const skill = { textContent: '' };
  let storageRefreshes = 0;
  let styleRefreshes = 0;
  const context = {
    panel: { querySelectorAll: () => [], querySelector: selector => ({
      '[data-probe-status]': status, '[data-task]': task, '[data-run]': runButton
    })[selector] || null },
    state: { mode: 'ask' }, currentRunView: null, probeStatusSnapshot: null, runCancellationRequested: false,
    settingsPanelInstance: { refreshNotes: noop, container: { querySelector: () => ({ open: true }) } },
    providerSettingsCoordinator: provider.api,
    writingStyleSettings: { sync() { styleRefreshes += 1; } },
    tr: (key, params) => I18n.t(locale, key, params),
    getCurrentProjectId: () => 'example', getActiveFocusFiles: () => [],
    isExperimentalOtEnabled: () => false,
    callPageBridge: async () => ({ editor: { ok: false }, reviewing: { ok: false } }),
    updateSkillsEntrySummary: () => { skill.textContent = I18n.t(locale, 'codexOverleafSkillsSummaryCount', { count: 2 }); },
    refreshStorageUsageSummary: () => { storageRefreshes += 1; }
  };
  for (const name of ['setElementTitleAndAria', 'setDiagnosticsHealth', 'updateOtStatusDisplay',
    'updateExperimentalOtMenuStatus', 'renderModelConfigChoices', 'updateModelDisplay', 'renderSessionList',
    'renderContextSelection', 'updateExistingProbeNotice', 'appendProbeUserStatus', 'setRefreshProbeLoading']) context[name] = noop;
  vm.createContext(context);
  for (const name of ['syncModeControls', 'syncProbeStatus', 'applyLocaleToPanel', 'syncComposerSendAvailability', 'refreshProbe', 'formatProbeStatusBar', 'appendOtStatusToProbeStatus',
    'getProbeRunReadiness', 'formatModeLabel', 'isProbeReadyForCurrentMode']) {
    const match = sources.runtime.match(new RegExp(`  (?:async )?function ${name}\\([^]*?\\n  \\}`));
    assert.ok(match, `${name} must remain available at its runtime seam`);
    vm.runInContext(match[0], context);
  }
  return { context, status, task, skill, provider, runButton,
    change(value) { locale = value; context.applyLocaleToPanel(); }, storageRefreshes: () => storageRefreshes, styleRefreshes: () => styleRefreshes };
}

test('locale switches re-project the cached composer, provider, skills and storage without rerunning probe', async () => {
  const h = localeHarness();
  await h.context.refreshProbe({ quiet: true });
  h.context.callPageBridge = () => { throw new Error('Locale switch must stay local'); };
  for (const locale of ['zh', 'en', 'zh', 'en']) {
    h.change(locale);
    assert.equal(h.status.textContent, `${I18n.t(locale, 'modeAsk')} · ${I18n.t(locale, 'wholeProjectContext')}`);
    assert.equal(h.task.placeholder, I18n.t(locale, 'placeholder'));
    assert.equal(h.skill.textContent, I18n.t(locale, 'codexOverleafSkillsSummaryCount', { count: 2 }));
    assert.match(h.provider.summary(), locale === 'zh' ? /当前项目/ : /current project/);
  }
  assert.equal(h.provider.requests(), 0);
  assert.equal(h.storageRefreshes(), 4);
  assert.equal(h.styleRefreshes(), 4);
});

test('locale projection preserves failed/loading status and never reuses another project probe', async () => {
  const h = localeHarness();
  await h.context.refreshProbe({ quiet: true });
  h.status.dataset.refreshing = 'true';
  h.change('zh');
  assert.equal(h.status.textContent, I18n.t('zh', 'refreshProbeLoading'));
  h.status.dataset.refreshing = 'false';
  h.context.probeStatusSnapshot = { projectId: 'example', failed: true };
  h.change('en');
  assert.equal(h.status.textContent, I18n.t('en', 'refreshProbeFailed'));
  h.context.getCurrentProjectId = () => 'another-project';
  h.status.textContent = 'another project status';
  h.change('zh');
  assert.equal(h.status.textContent, 'another project status');
});

test('locale refresh keeps send and stop labels aligned after a queued draft is cleared', () => {
  const h = localeHarness();
  h.context.currentRunView = { recordId: 'active-run' };
  h.task.value = 'queued follow-up';
  h.change('en');
  assert.equal(h.runButton.dataset.action, 'send');
  assert.equal(h.runButton['aria-label'], I18n.t('en', 'queueNextInput'));
  h.task.value = '';
  for (const locale of ['en', 'zh']) {
    h.change(locale);
    assert.equal(h.runButton.dataset.action, 'cancel');
    assert.equal(h.runButton.title, I18n.t(locale, 'cancelRun'));
    assert.equal(h.runButton['aria-label'], h.runButton.title);
    assert.equal(h.runButton.disabled, false);
  }
  h.context.runCancellationRequested = true;
  h.change('en');
  assert.equal(h.runButton.disabled, true);
  h.context.currentRunView = null;
  h.context.runCancellationRequested = false;
  h.change('en');
  assert.equal(h.runButton.dataset.action, 'send');
  assert.equal(h.runButton.title, I18n.t('en', 'send'));
  assert.equal(h.runButton.disabled, true);
});

test('custom provider locale projection retains its selection and does not fetch or activate', () => {
  let locale = 'en';
  const h = providerHarness(() => locale, 'dpsk');
  for (locale of ['zh', 'en']) {
    h.api.renderSummary();
    assert.match(h.summary(), /^dpsk · model/);
    assert.match(h.summary(), locale === 'zh' ? /当前项目/ : /Current project/);
  }
  assert.equal(h.requests(), 0);
});

test('OT diagnostics describe the supported mirror in both languages while retaining fallback guidance', () => {
  for (const locale of ['en', 'zh']) {
    for (const key of ['diagnosticsOtSummaryEnabled', 'diagnosticsOtSummaryDisabled']) {
      assert.doesNotMatch(I18n.t(locale, key), /experimental|实验性/i);
      assert.match(I18n.t(locale, key), /normal project read|常规项目读取/);
    }
  }
});

function observerHarness() {
  let content = 'original';
  let file = 'main.tex';
  const listeners = {};
  const observer = Observer.create({ document: {
    addEventListener: (type, listener) => { listeners[type] = listener; }, removeEventListener: noop
  }, window: {}, getActiveFilePath: () => file, readActiveEditorText: () => content });
  observer.start();
  return { observer, listeners, text: value => { content = value; }, file: value => { file = value; } };
}

test('OT drain captures the committed transaction after capture-phase input read the old text', () => {
  const h = observerHarness();
  h.listeners.input({ target: {} });
  h.text('original plus typed text');
  const [event] = h.observer.drainEvents();
  assert.equal(event.nextContent, 'original plus typed text');
  assert.equal(h.observer.drainEvents().length, 0);
});

test('OT polling captures paste and undo without DOM input and maintains the hash chain', () => {
  const h = observerHarness();
  h.text('pasted content');
  const [paste] = h.observer.drainEvents();
  assert.equal(paste.nextContent, 'pasted content');
  h.text('original');
  const [undo] = h.observer.drainEvents();
  assert.equal(undo.baseHash, paste.nextHash);
  assert.equal(undo.nextHash, paste.baseHash);
  const observedAt = h.observer.getStatus().lastEventAt;
  assert.equal(h.observer.drainEvents().length, 0);
  assert.equal(h.observer.getStatus().lastEventAt, observedAt, 'no-op polling cannot renew freshness');
});

test('OT polling respects stopped observers and adopts a switched file without cross-file patches', () => {
  const h = observerHarness();
  h.file('example/test.tex');
  h.text('nested baseline');
  assert.equal(h.observer.drainEvents().length, 0);
  h.text('nested edit');
  assert.equal(h.observer.drainEvents()[0].path, 'example/test.tex');
  h.observer.stop();
  h.text('must not observe');
  assert.equal(h.observer.drainEvents().length, 0);
  assert.equal(h.observer.getStatus().status, 'off');
});

function toggleHarness(enabled) {
  let state = { experimentalOtByProject: { example: enabled } };
  let project = 'example';
  let confirm = async () => true;
  const checkbox = { checked: enabled };
  const panel = { querySelector: selector => selector === '[data-experimental-ot]' ? checkbox : null };
  const schedule = (callback, delay) => delay === 0 ? setTimeout(callback, 0) : null;
  const api = browserFactory(sources.ot, 'CodexOverleafOtWarmMirror', {
    window: { setTimeout: schedule, clearTimeout }, setTimeout: schedule, clearTimeout
  }).create({ otWarmMirrorController: OtController, getState: () => state, setState: value => { state = value; },
    getPanel: () => panel, getCurrentProjectId: () => project, getCurrentRunView: () => null,
    closeDiagnosticsMenu: noop, showPluginConfirm: () => confirm(), showPluginToast: noop,
    tr: key => key, tx: en => en, updateProbeStatusOtSuffix: noop, saveStateSoon: noop,
    appendPlainLog: noop, callPageBridge: async method => ({ ok: true, status: method === 'stopOtObserver' ? 'off' : 'observing' }) });
  return { api, checkbox, state: () => state, project: value => { project = value; },
    confirm: value => { confirm = value; },
    click(target) {
      const previous = checkbox.checked;
      checkbox.checked = target;
      const promise = api.handleExperimentalOtToggleClick({ currentTarget: checkbox, preventDefault: noop });
      checkbox.checked = previous; // Browser cancelled-click default action, after dispatch.
      return promise;
    } };
}

test('turning OT off projects the checkbox after cancelled click rollback', async () => {
  const h = toggleHarness(true);
  await h.click(false);
  assert.equal(h.checkbox.checked, false);
  assert.equal(h.state().experimentalOtByProject.example, false);
  assert.equal(h.api.getCurrentOtStatus(), 'off');
});

test('OT enable requires approval and cancellation leaves UI and state off', async () => {
  const h = toggleHarness(false);
  h.confirm(async () => false);
  await h.click(true);
  assert.equal(h.checkbox.checked, false);
  assert.equal(h.state().experimentalOtByProject.example, false);
  h.confirm(async () => true);
  await h.click(true);
  assert.equal(h.checkbox.checked, true);
  assert.equal(h.state().experimentalOtByProject.example, true);
});

test('OT approval from a departed project cannot enable the newly selected project', async () => {
  const h = toggleHarness(false);
  let approve;
  let announceConfirmation;
  const confirmationShown = new Promise(resolve => { announceConfirmation = resolve; });
  h.confirm(() => new Promise(resolve => { approve = resolve; announceConfirmation(); }));
  const pending = h.click(true);
  await confirmationShown;
  h.project('another-project');
  approve(true);
  await pending;
  assert.equal(h.state().experimentalOtByProject.example, false);
  assert.equal(h.state().experimentalOtByProject['another-project'], undefined);
});

test('OT projection waits past a microtask checkpoint before cancelled-click default actions', async () => {
  const h = toggleHarness(true);
  h.checkbox.checked = false;
  const pending = h.api.handleExperimentalOtToggleClick({ currentTarget: h.checkbox, preventDefault: noop });
  await Promise.resolve();
  await Promise.resolve();
  h.checkbox.checked = true; // Native input dispatch may run microtasks BEFORE cancellation rollback.
  await pending;
  assert.equal(h.checkbox.checked, false);
  assert.equal(h.state().experimentalOtByProject.example, false);
});

test('an OT click cannot cross projects while waiting for the next task', async () => {
  const h = toggleHarness(true);
  const pending = h.click(false);
  h.project('another-project');
  await pending;
  assert.equal(h.state().experimentalOtByProject.example, true);
  assert.equal(h.state().experimentalOtByProject['another-project'], undefined);
});

test('terminal persistence opts into reading preservation without changing default session positioning', () => {
  assert.match(sources.runtime, /await saveState\(\);\s*applyStateToPanel\(\{ preserveScroll: true \}\);\s*\} catch \(persistenceError\)/);
  const apply = sources.runtime.match(/function applyStateToPanel\(options = \{\}\)[^]*?\n  \}/)?.[0];
  assert.match(apply, /renderRunHistory\(options\)/);
  const render = sources.timeline.match(/function renderRunHistory\(options = \{\}\)[^]*?\n  \}/)?.[0];
  assert.match(render, /options\.preserveScroll === true && !logAutoFollow/);
  assert.match(render, /else scrollLogToBottom\(\{ force: true \}\)/);
});

test('reading snapshots rebind replaced nodes by run identity and restore paragraph position', () => {
  let paragraphTop = 550;
  let run;
  let paragraph;
  const scroller = { scrollHeight: 2000, clientHeight: 200, scrollTop: 500, children: [],
    getBoundingClientRect: () => ({ top: 0, bottom: 200 }), contains: node => node === paragraph,
    querySelectorAll: selector => selector === '[data-run-id]' ? [run] : [paragraph] };
  function replaceNodes(runId) {
    run = { dataset: { runId }, querySelectorAll: () => [paragraph] };
    paragraph = { closest: () => run, getBoundingClientRect: () => ({
      top: paragraphTop - scroller.scrollTop, bottom: paragraphTop - scroller.scrollTop + 40, height: 40 }) };
  }
  replaceNodes('historical-run');
  const layout = ScrollLayout.create({ getScroller: () => scroller, isFollowing: () => false, onLayoutChange: noop,
    window: { ResizeObserver: class { observe() {} disconnect() {} } } });
  layout.bind(scroller);
  const reading = layout.snapshot();
  const oldParagraph = paragraph;
  replaceNodes('historical-run');
  paragraphTop += 120;
  scroller.scrollTop = 0; // replaceChildren can clamp the old scroll offset.
  layout.restore(reading);
  assert.notEqual(paragraph, oldParagraph);
  assert.equal(paragraph.getBoundingClientRect().top, 50);
  replaceNodes('unrelated-run');
  scroller.scrollTop = 0;
  layout.restore(reading);
  assert.equal(scroller.scrollTop, reading.scrollTop, 'a missing stable anchor uses the saved offset');
  layout.dispose();
});

function scrollHarness() {
  const listeners = {};
  const frames = [];
  const host = { append: noop };
  const button = { isConnected: true, addEventListener: noop, setAttribute: noop };
  const scroller = { dataset: {}, scrollHeight: 1000, clientHeight: 200, scrollTop: 800,
    addEventListener: (type, listener) => { listeners[type] = listener; }, closest: () => host };
  const api = browserFactory(sources.timeline, 'CodexOverleafRunTimelineView', {
    document: { createElement: () => button }, window: { requestAnimationFrame: callback => { frames.push(callback); return frames.length; } }
  }).create({ getPanel: () => ({ querySelector: () => scroller }), tx: en => en });
  api.bindLogAutoFollow();
  return { api, scroller, button, listeners, paint() { while (frames.length) frames.shift()(); },
    detach() { listeners.wheel({ type: 'wheel', deltaY: -100 }); scroller.scrollTop = 500; listeners.scroll(); } };
}

test('completion layout clamping to bottom cannot re-arm detached scroll, even inside the intent window', () => {
  const h = scrollHarness();
  h.detach();
  h.scroller.scrollHeight = 700;
  h.listeners.scroll();
  h.api.scrollLogToBottom();
  h.paint();
  assert.equal(h.scroller.dataset.logAutoFollow, 'false');
  assert.equal(h.scroller.scrollTop, 500);
  h.scroller.scrollHeight = 900;
  h.api.scrollLogToBottom();
  h.paint();
  assert.equal(h.scroller.scrollTop, 500);
});

test('explicit scrolling to the bottom and forced jumps still re-arm following', () => {
  const h = scrollHarness();
  h.detach();
  h.listeners.wheel({ type: 'wheel', deltaY: 100 });
  h.scroller.scrollTop = 800;
  h.listeners.scroll();
  assert.equal(h.scroller.dataset.logAutoFollow, 'true');
  h.detach();
  h.api.scrollLogToBottom({ force: true });
  h.paint();
  assert.equal(h.scroller.dataset.logAutoFollow, 'true');
});

test('upward user intent wins over a queued frame and process clicks do not authorize follow', () => {
  const h = scrollHarness();
  h.api.scrollLogToBottom();
  h.detach();
  h.paint();
  assert.equal(h.scroller.scrollTop, 500);
  h.listeners.pointerdown({ type: 'pointerdown', target: {} });
  h.scroller.scrollHeight = 700;
  h.listeners.scroll();
  assert.equal(h.scroller.dataset.logAutoFollow, 'false');
});

test('detached layout changes retain the visible text anchor across collapse and reflow', () => {
  let notify;
  let following = false;
  let paragraphTop = 550;
  const scroller = { scrollHeight: 1000, clientHeight: 200, scrollTop: 500, children: [],
    getBoundingClientRect: () => ({ top: 0, bottom: 200 }), contains: node => node === paragraph,
    querySelectorAll: () => [paragraph] };
  const paragraph = { getBoundingClientRect: () => ({ top: paragraphTop - scroller.scrollTop,
    bottom: paragraphTop - scroller.scrollTop + 40, height: 40 }) };
  const api = ScrollLayout.create({ getScroller: () => scroller, isFollowing: () => following, onLayoutChange: noop,
    window: { ResizeObserver: class { constructor(callback) { notify = callback; } observe() {} disconnect() {} } } });
  api.bind(scroller);
  paragraphTop -= 120;
  scroller.scrollHeight -= 120;
  api.captureAnchor(); // Layout-triggered scroll arrives before ResizeObserver.
  notify();
  assert.equal(paragraph.getBoundingClientRect().top, 50);
  paragraphTop += 80;
  scroller.scrollHeight += 80;
  notify();
  assert.equal(paragraph.getBoundingClientRect().top, 50);
  following = true;
  paragraphTop += 30;
  notify();
  assert.equal(paragraph.getBoundingClientRect().top, 80, 'follow mode must not restore a detached anchor');
  api.dispose();
});
