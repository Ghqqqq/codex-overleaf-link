'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Transcript = require('../extension/src/shared/agentTranscript');
const Session = require('../extension/src/shared/sessionState');
const Storage = require('../extension/src/shared/storageDb');
const Settlement = require('../extension/src/shared/writebackSettlement');
const Actions = require('../extension/src/content/runResultActions').create();
const { extractFunction } = require('./_helpers/extractFunction');
const runtime = fs.readFileSync(require.resolve('../extension/src/content/contentRuntime'), 'utf8');
const timeline = fs.readFileSync(require.resolve('../extension/src/content/runTimelineView'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const copy = { en: 'This run was cancelled. It did not continue syncing or writing to Overleaf.', zh: '这轮已中断，没有继续同步或写入 Overleaf。' };
function cancelled(locale) {
  const events = [], context = vm.createContext({ state: {}, getActiveSession: () => ({}),
    tx: (en, zh) => locale === 'zh' ? zh : en, getLocale: () => locale,
    currentRunView: null, WritebackSettlement: Settlement, getRunUndoCount: () => 0,
    buildHumanCompletionReport: Transcript.buildHumanCompletionReport, appendRunEvent: event => events.push(clone(event)) });
  for (const name of ['appendCompletionReport', 'appendRunCancelledReport']) vm.runInContext(extractFunction(runtime, name), context);
  context.appendRunCancelledReport();
  return { id: 'r', status: 'cancelled', events };
}
function persisted(run, useFallback = true) {
  const state = Session.normalizePanelState({ activeSessionId: 's', sessions: [{ id: 's', projectId: 'p', runs: [run] }] });
  const fallback = useFallback ? Session.prepareStateForStorage(state) : state;
  const row = Storage.buildSessionRecord(fallback.sessions[0], { preserveRunActionPayload: true });
  return Session.normalizePanelState({ activeSessionId: 's', sessions: [clone(row)] }).sessions[0].runs[0];
}
function render(event, run, locale) {
  class Node { constructor() { this.children = []; this.dataset = {}; this.textContent = ''; } append(node) { this.children.push(node); } }
  const context = vm.createContext({ document: { createElement: () => new Node() },
    tx: (en, zh) => locale === 'zh' ? zh : en, getLocale: () => locale,
    RunResultActions: Actions, sanitizeAssistantVisibleText: value => value || '', sanitizeAssistantVisibleValue: value => value,
    stripEmptyHtmlCommentPlaceholders: value => value, localizeCompileReason: value => value, localizeProductActivity: () => null,
    formatEventDetail: value => value, splitFlatCompletionReport: Actions.splitFlatCompletionReport,
    renderMarkdownBlockText: (node, text) => { node.textContent = text; }, decorateCompletionReport() {},
    failureNotice: null, appendCompletionMetaBlock() {}, appendRecoveryActionForFailure() {} });
  for (const name of ['sanitizeRunEventForRender', 'renderCompletionReport']) vm.runInContext(extractFunction(timeline, name), context);
  return context.renderCompletionReport(event, run).children[0].textContent;
}
for (const from of ['en', 'zh']) {
  test(`product cancellation survives producer/storage and renders ${from} in the opposite locale`, () => {
    const run = persisted(cancelled(from)), event = run.events.at(-1), before = JSON.stringify(run);
    const to = from === 'en' ? 'zh' : 'en';
    assert.equal(render(event, run, to), copy[to]);
    assert.equal(render(event, run, from), copy[from]);
    assert.equal(JSON.stringify(run), before);
  });
  test(`model and explicit user-report cancellation lookalikes remain ${from}`, () => {
    for (const input of [{ conclusion: copy[from] }, { userReport: { conclusion: copy[from], conclusionKey: 'cancelled' } }]) {
      const report = Transcript.buildHumanCompletionReport({ ...input, locale: from });
      const run = persisted({ id: 'model', status: 'completed', events: [{ kind: 'report', title: report.title, status: report.status, detail: report.text, detailStructured: report.structured }] });
      assert.equal(render(run.events[0], run, from === 'en' ? 'zh' : 'en'), copy[from]);
    }
  });
}

function reportRun(input, locale = 'en') {
  const report = Transcript.buildHumanCompletionReport({ ...input, locale });
  return { id: 'report', status: input.status || 'completed', events: [{ kind: 'report', title: report.title,
    status: report.status, detail: report.text, detailStructured: report.structured }] };
}
for (const from of ['en', 'zh']) {
  test(`known error and automatic fallback conclusions reproject after ${from} persistence`, () => {
    const to = from === 'en' ? 'zh' : 'en';
    const inputs = ['provider_auth_rejected', 'Codex CLI was not found locally', 'Agent returned invalid JSON',
      'Could not parse Codex output', 'timed out', 'quota', 'checkpoint', 'unknown external failure'];
    for (const errorMessage of inputs) {
      const run = persisted(reportRun({ errorMessage, status: 'failed' }, from));
      assert.equal(render(run.events[0], run, to), Transcript.buildHumanCompletionReport({ errorMessage, locale: to }).structured.conclusion);
    }
    for (const operations of [[], [{ type: 'create', path: '研究.tex', content: '' }]]) {
      const run = persisted(reportRun({ operations }, from));
      assert.ok(render(run.events[0], run, to).startsWith(Transcript.buildHumanCompletionReport({ operations, locale: to }).structured.conclusion));
    }
  });
  test(`legacy cancellation requires the real adjacent lifecycle in ${from}`, () => {
    const to = from === 'en' ? 'zh' : 'en';
    for (const flat of [false, true]) {
      const run = persisted(cancelled(from), false), event = run.events.at(-1);
      delete event.detailStructured.conclusionSource;
      if (flat) delete event.detailStructured;
      assert.equal(render(event, run, to), flat ? (to === 'zh' ? `结论：${copy[to]}` : `Conclusion: ${copy[to]}`) : copy[to]);
      const raw = render(event, run, from);
      for (const changed of [
        value => { value.status = 'completed'; },
        value => { value.events.shift(); },
        value => { value.events[0].streamRole = 'assistant'; },
        value => { value.events[0].activity.target = 'other'; },
        value => { value.events.at(-1).title = 'User report'; }
      ]) {
        const copyRun = clone(run); changed(copyRun);
        assert.equal(render(copyRun.events.at(-1), copyRun, to), raw);
      }
    }
  });
}

test('invalid, unknown and mismatched product identities never overwrite the raw answer', () => {
  for (const source of [{ origin: 'model', key: 'cancelled' }, { origin: 'product', key: 'unknown' },
    { origin: 'product', key: 'error:__proto__' }, { origin: 'product', key: 'cancelled' },
    { origin: 'product', key: 'writeback', outcome: 'partial_sync', prefixLength: 3 },
    { origin: 'product', key: 'writeback', outcome: 'invented', prefixLength: 0 }]) {
    const run = reportRun({ conclusion: 'User/model 原文' });
    run.events[0].detailStructured.conclusionSource = source;
    const saved = persisted(run);
    assert.equal(render(saved.events[0], saved, 'zh'), 'User/model 原文');
  }
});

test('an explicit model report drops even a forged valid product identity', () => {
  const input = { conclusion: copy.en, conclusionKey: 'cancelled', conclusionSource: { origin: 'product', key: 'cancelled' } };
  const report = Transcript.buildHumanCompletionReport({ conclusionKey: 'cancelled', userReport: input });
  assert.equal(report.structured.conclusionSource, undefined);
  const run = persisted(reportRun({ userReport: input }));
  assert.equal(render(run.events[0], run, 'zh'), copy.en);
});

// Exercise the actual writeback producer, including its composite model/system boundary.
const orchestratorSource = fs.readFileSync(require.resolve('../extension/src/content/writebackOrchestrator'), 'utf8');
const compileAt = vm.runInNewContext(`(${extractFunction(orchestratorSource, 'appendCompileSummaryToConclusion')})`, {
  tx: (en, zh) => en, compileAdapter: { localizeCompileReason: value => value }, getLocale: () => 'en'
});
const { createFlow } = require('./_helpers/writebackOutcomeHarness');
const Compile = require('../extension/src/shared/compileAdapter');

test('real writeback report retains model prefix and changes only system suffix after storage', async () => {
  const flow = createFlow({ autoRecompile: true });
  const run = persisted(await flow.run()), event = run.events.findLast(item => item.kind === 'report');
  const source = event.detailStructured.conclusionSource;
  assert.equal(source.key, 'writeback');
  assert.equal(Object.hasOwn(source, 'prefix'), false, 'do not duplicate the model answer in metadata');
  assert.equal(Actions.projectCompletionConclusion(event, run, 'zh'), 'Synthetic model result\n写后编译检查已通过，未发现错误。');
  assert.ok(render(event, run, 'zh').startsWith('Synthetic model result\n写后编译检查已通过，未发现错误。'));
});

test('writeback preserves every model character and the original compile count beyond diagnostic sampling', () => {
  const prefix = '模型保留 @file:研究.tex\nPost-write compile check succeeded with no reported errors.';
  const compile = { status: 'failed', errors: Array.from({ length: 8 }, (_, n) => `研究.tex:${n + 1}: untouched error`), warnings: [] };
  const base = `${prefix}\n\nSync note: local Codex changes were sent to Overleaf, but some items were skipped.`;
  const conclusion = compileAt(base, compile);
  const run = persisted(reportRun({ conclusion, conclusionSource: { origin: 'product', key: 'writeback', outcome: 'partial_sync',
    prefixLength: prefix.length, hasCompile: true, compileStatus: compile.status, errorCount: compile.errors.length, errors: compile.errors, warningCount: 0 } }));
  const rendered = render(run.events[0], run, 'zh');
  assert.ok(rendered.startsWith(prefix + '\n\n同步提示：'));
  assert.match(rendered, /仍有 8 个错误：研究.tex:1: untouched error；研究.tex:2: untouched error；研究.tex:3: untouched error$/);
});

test('compacted long writeback and changed raw suffix cannot be reconstructed from source metadata', () => {
  const prefix = '原始模型 answer '.repeat(10000);
  const conclusion = prefix + '\n\nSync note: local Codex changes were sent to Overleaf, but some items were skipped.';
  const run = persisted(reportRun({ conclusion, conclusionSource: { origin: 'product', key: 'writeback', outcome: 'partial_sync', prefixLength: prefix.length } }));
  const event = run.events[0], raw = event.detailStructured.conclusion;
  assert.ok(raw.length < conclusion.length, 'exercise actual storage compaction');
  assert.equal(render(event, run, 'zh'), raw);
  assert.ok(JSON.stringify(event.detailStructured.conclusionSource).length < 500, 'metadata does not store the long prefix');
  const damaged = reportRun({ conclusion: 'Model\n\nChanged suffix', conclusionSource: { origin: 'product', key: 'writeback', outcome: 'partial_sync', prefixLength: 5 } });
  assert.equal(render(damaged.events[0], damaged, 'zh'), damaged.events[0].detailStructured.conclusion);
});

test('appendRunRecordEvent retains the structured identity for historical report insertion', () => {
  const record = { id: 'r', events: [] };
  const context = vm.createContext({ findRunRecord: () => record, Modules: { RunActivityModel: require('../extension/src/shared/runActivityModel') },
    sanitizeAssistantVisibleValue: clone, sanitizeAssistantVisibleText: value => value || '', MAX_RUN_EVENTS: 100,
    saveStateSoon() {}, panel: null, cssEscape: value => value });
  vm.runInContext(extractFunction(runtime, 'appendRunRecordEvent'), context);
  context.appendRunRecordEvent('r', cancelled('en').events.at(-1));
  const saved = persisted(record);
  assert.equal(render(saved.events[0], saved, 'zh'), copy.zh);
});

test('real fork snapshots keep conclusion identity and render/copy the selected language', async () => {
  const Fork = require('../extension/src/content/sessionForkController');
  let state = Session.normalizePanelState({ activeSessionId: 's', sessions: [{ id: 's', codexThreadId: 'thread',
    runs: [{ ...cancelled('en'), codexTurnId: 'turn' }] }] });
  const controller = Fork.create({ SessionState: Session, getState: () => state, setState: value => { state = value; },
    sendBackgroundNative: async () => ({ ok: true, result: { threadId: 'fork-thread' } }), saveState: async () => {},
    applyStateToPanel() {}, tr: key => key, showPluginToast() {} });
  await controller.forkRunFromNode('r');
  const run = persisted(state.sessions.at(-1).runs[0]);
  assert.equal(run.forkSnapshot, true);
  const visible = render(run.events.at(-1), run, 'zh');
  let handler, copied;
  const button = { setAttribute() {}, addEventListener: (_, fn) => { handler = fn; }, cloneNode() { return this; }, replaceWith() {} };
  const context = vm.createContext({ tr: key => key, writeClipboardText: async text => { copied = text; } });
  vm.runInContext(extractFunction(fs.readFileSync(require.resolve('../extension/src/content/runResultActions'), 'utf8'), 'configureCopyButton'), context);
  context.configureCopyButton({ querySelector: selector => selector === '[data-run-copy]' ? button : { textContent: visible } });
  await handler({ stopPropagation() {} });
  assert.equal(copied, copy.zh);
});

test('actual Retry sync labels its owned fallback prefix without marking model prose', async () => {
  const flow = createFlow({ creatorOptions: { zipUnavailable: true } });
  await flow.run(); flow.creatorOptions.zipUnavailable = false;
  await flow.retry();
  const input = flow.reportInputs.at(-1);
  assert.equal(input.conclusionSource.prefixKey, 'retry_sync');
  const run = persisted(reportRun(input));
  assert.ok(render(run.events[0], run, 'zh').startsWith('已重试本轮未完成的文件同步。'));
});

test('the known post-processing error keeps its selected meaning through report generation', () => {
  for (const locale of ['en', 'zh']) {
    const translated = Transcript.translateRawError('synthetic unknown failure', { locale, codexReturned: true });
    const run = persisted(reportRun({ ...translated, errorMessage: 'synthetic unknown failure', status: 'failed' }, locale));
    const to = locale === 'en' ? 'zh' : 'en';
    assert.equal(render(run.events[0], run, to), Transcript.translateRawError('synthetic unknown failure', { locale: to, codexReturned: true }).conclusion);
  }
});
