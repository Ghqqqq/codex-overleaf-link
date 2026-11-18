'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Transcript = require('../extension/src/shared/agentTranscript');
const Session = require('../extension/src/shared/sessionState');
const Storage = require('../extension/src/shared/storageDb');
const { projectCompletionConclusion } = require('../extension/src/content/runCompletionMeta');

function saveReport(input, locale) {
  const report = Transcript.buildHumanCompletionReport({ ...input, locale });
  const state = Session.normalizePanelState({ activeSessionId: 's', sessions: [{ id: 's', projectId: 'p', runs: [{
    id: 'r', status: 'completed', events: [{ kind: 'report', title: report.title,
      status: report.status, detail: report.text, detailStructured: report.structured }]
  }] }] });
  const row = Storage.buildSessionRecord(Session.prepareStateForStorage(state).sessions[0], { preserveRunActionPayload: true });
  const restored = Session.normalizePanelState({ activeSessionId: 's', sessions: [JSON.parse(JSON.stringify(row))] });
  const run = restored.sessions[0].runs[0];
  return { run, event: run.events[0] };
}
const productText = (key, locale) => Transcript.projectProductConclusion({ origin: 'product', key }, locale);
const project = (saved, locale) => projectCompletionConclusion(saved.event, saved.run, locale);

test('model and user text remains verbatim even when it resembles a product conclusion', () => {
  for (const locale of ['en', 'zh']) {
    const raw = productText('cancelled', locale);
    for (const input of [{ conclusion: raw }, { userReport: { conclusion: raw,
      conclusionSource: { origin: 'product', key: 'cancelled' } } }]) {
      const saved = saveReport(input, locale);
      assert.equal(project(saved, 'en'), raw);
      assert.equal(project(saved, 'zh'), raw);
    }
  }
});

test('a persisted composite report translates only its product suffix and preserves the model prefix', () => {
  const prefix = 'Model 原文🙂\nKeep this exact text.';
  const suffix = locale => productText('partial_sync_note', locale);
  const raw = prefix + '\n\n' + suffix('en');
  const saved = saveReport({ conclusion: raw, conclusionSource: {
    origin: 'product', key: 'writeback', outcome: 'partial_sync', prefixLength: prefix.length
  } }, 'en');
  assert.equal(project(saved, 'zh'), prefix + '\n\n' + suffix('zh'));
  assert.equal(project(saved, 'en'), raw);
  saved.event.detailStructured.conclusion = prefix + '\nA later user edit';
  assert.equal(project(saved, 'zh'), prefix + '\nA later user edit');
});

const Completion = require('../extension/src/content/runCompletionMeta');
const ActivityModel = require('../extension/src/shared/runActivityModel');
const Controller = require('../extension/src/content/runController');
const Settlement = require('../extension/src/shared/writebackSettlement');
const Failures = require('../extension/src/shared/failureReasons');
const I18n = require('../extension/src/shared/i18n');
const projectOutcome = (run, locale = 'en') => Completion.projectFinishedRun(run, locale, {
  projectRunSettlement: Settlement.projectRunSettlement
});
function outcomeRun(input, fields = {}) {
  return roundtripRun(reportRun(input, fields));
}
function reportRun(input, fields = {}) {
  const report = Transcript.buildHumanCompletionReport({ includeWriteResult: true, undoCount: 0, ...input });
  return { id: 'outcome', mode: 'auto', status: report.status, ...fields, events: [{
    kind: 'report', title: report.title, status: report.status, detail: report.text,
    detailStructured: report.structured, failure: input.failure
  }] };
}
function roundtripRun(run, fallback = true) {
  const state = Session.normalizePanelState({ activeSessionId: 's', sessions: [{ id: 's', projectId: 'p', runs: [run] }] });
  const row = Storage.buildSessionRecord((fallback ? Session.prepareStateForStorage(state) : state).sessions[0], { preserveRunActionPayload: true });
  return Session.normalizePanelState({ activeSessionId: 's', sessions: [JSON.parse(JSON.stringify(row))] }).sessions[0].runs[0];
}

test('new refresh reports distinguish Ask zero writes from Auto uncertainty through storage', () => {
  for (const locale of ['en', 'zh']) {
    for (const [mode, fields, kind] of [['ask', {}, 'didnt-finish'], ['auto', {}, 'didnt-finish'],
      ['auto', { undoOperations: [{ type: 'edit', path: 'main.tex', replaceAll: 'before' }] }, 'check-overleaf']]) {
      const state = Session.normalizePanelState({ locale, activeSessionId: 's', sessions: [{ id: 's', projectId: 'p',
        runs: [{ id: 'refresh', mode, status: 'running', events: [], ...fields }] }] }, { restoreRunningRuns: true });
      const live = state.sessions[0].runs[0];
      assert.equal(live.events.at(-1).detail, I18n.t(locale, 'restoredRunStoppedDetail'));
      for (const run of [live, roundtripRun(live), roundtripRun(live, false)]) {
        const before = JSON.stringify(run), event = run.events.at(-1);
        assert.equal(run.status, 'interrupted');
        assert.equal(event.detailStructured.conclusion, productText('reload_interrupted', locale));
        assert.equal(event.detailStructured.meta.some(row => row.key === 'writeResult'), mode === 'ask');
        assert.equal(Controller.isRetryReplacementEligible(run, Settlement.projectRunSettlement(run)), mode === 'ask');
        assert.equal(Controller.isRetryReplacementEligible(run, {}), mode === 'ask');
        for (const to of ['en', 'zh']) {
          const outcome = projectOutcome(run, to);
          assert.equal(outcome.kind, kind);
          assert.equal(outcome.noWrites, mode === 'ask');
          assert.equal(Completion.projectNotStartedRun(run, to), null);
          if (kind === 'didnt-finish') {
            assert.equal(outcome.title, I18n.t(to, 'runOutcomeCause_panel_reload_interrupted'));
            assert.equal(outcome.body, I18n.t(to, mode === 'ask' ? 'runOutcomeNoWrites' : 'runOutcomeReloadUnknownBody'));
            assert.equal(outcome.nextStep, I18n.t(to, 'failureReason_panel_reload_interrupted_next'));
          } else assert.equal(outcome.unconfirmed, true);
        }
        assert.equal(JSON.stringify(run), before);
      }
    }
  }
});

async function governanceReport(locale, assistantMessage, rules) {
  const tx = (en, zh) => locale === 'zh' ? zh : en;
  const tr = (key, values) => I18n.t(locale, key, values);
  const plan = require('../extension/src/content/writebackPlan').create({ tx, tr,
    normalizeSafeProjectPath: require('../extension/src/shared/projectFiles').normalizeSafeProjectPath,
    GovernanceRules: require('../extension/src/shared/governanceRules'), getGovernanceRulesForCurrentProject: () => rules,
    getAppliedEntries: result => result.applied || [], getSkippedEntries: result => result.skipped || [] });
  // Load the complete browser module; production planning, governance and settlement own the result.
  const window = {};
  require('node:vm').runInNewContext(require('node:fs').readFileSync(
    require.resolve('../extension/src/content/writebackOrchestrator'), 'utf8'), { window, Function });
  let input;
  const orchestrator = window.CodexOverleafWritebackOrchestrator.create({ ...plan, tx, tr, getLocale: () => locale,
    getState: () => ({ mode: 'auto' }), cleanFinalAnswer: value => String(value || '').trim(),
    getAssistantAnswerForCurrentRun: () => '', appendRunEvent() {}, appendApplyResult() {},
    appendCompletionReport: value => { input = value; },
    buildSyncApplyOperations: require('../extension/src/content/writebackController').buildSyncApplyOperations,
    getSkippedEntries: result => result.skipped || [], formatWritebackSkippedNextStep: () => '',
    writebackSettlement: Settlement });
  const result = await orchestrator.applySyncChangesToOverleaf([{ path: 'main.tex', content: 'after' }],
    { files: [{ path: 'main.tex', content: 'before' }] }, { mode: 'auto', assistantMessage });
  return { input: { ...input, locale }, fields: { settlement: result.settlement.facts } };
}

test('governance blocks preserve the model prefix and project the actual path-rule cause', async () => {
  const prefix = 'Added % b6-readonly …\nModel 原文🙂  stays exact.';
  for (const locale of ['en', 'zh']) {
    for (const [rules, code, message] of [[{ readonlyPatterns: ['main.tex'] }, 'governance_readonly', prefix],
      [{ writablePatterns: ['allowed.tex'] }, 'governance_writable_allowlist', '']]) {
      const { input, fields } = await governanceReport(locale, message, rules);
      const raw = message ? message + '\n\n' + productText('blocked_sync_note', locale) : productText('blocked_sync', locale);
      assert.equal(input.conclusion, raw);
      assert.equal(input.conclusionSource.prefixLength, message.length);
      assert.equal(input.failure.retryable, false);
      const live = reportRun(input, fields);
      // The old model-only report was retry-replaceable via unchanged settlement, not its 0/N row.
      const legacy = outcomeRun({ ...input, conclusion: message || 'Legacy model answer', conclusionSource: undefined }, fields);
      assert.equal(projectOutcome(legacy), null);
      assert.equal(Controller.isRetryReplacementEligible(legacy, Settlement.projectRunSettlement(legacy)), true);
      for (const run of [live, roundtripRun(live)]) {
        const before = JSON.stringify(run);
        assert.equal(Controller.isRetryReplacementEligible(run, Settlement.projectRunSettlement(run)), true);
        assert.equal(Controller.isRetryReplacementEligible(run, {}), false);
        for (const to of ['en', 'zh']) {
          const outcome = projectOutcome(run, to);
          assert.equal(outcome.kind, 'not-written');
          assert.equal(outcome.title, I18n.t(to, `runOutcomeCause_${code}`, { file: 'main.tex' }));
          assert.equal(outcome.nextStep, I18n.t(to, `failureReason_${code}_next`));
          assert.equal(projectCompletionConclusion(run.events[0], run, to), message
            ? message + '\n\n' + productText('blocked_sync_note', to) : productText('blocked_sync', to));
          assert.equal(run.events[0].detailStructured.conclusion, raw);
        }
        assert.equal(JSON.stringify(run), before);
      }
    }
  }
});

test('sensitive blocks retain only bounded detector evidence and localize the finding after storage', async () => {
  const SensitiveScan = require('../extension/src/shared/sensitiveScan');
  const single = SensitiveScan.scanSensitiveInputs({ task: 'AKIA' + 'A'.repeat(16) });
  const mixed = SensitiveScan.scanSensitiveInputs({ task: 'AKIA' + 'A'.repeat(16) + '\nBearer ' + 'b'.repeat(20) });
  const cases = [[single, 'aws_access_key'], [mixed, 'mixed'], [[...single, ...single], 'aws_access_key'],
    [[...single, { detectorId: 'unknown-detector', preview: 'private-preview', match: 'private-match' }], 'mixed'],
    [[...single, ...['private-key', 'api-token', 'jwt-token', 'secret-assignment', 'google-api-key']
      .map(detectorId => ({ detectorId, preview: 'private-preview' }))], 'mixed']];
  for (const locale of ['en', 'zh']) {
    for (const [findings, label] of cases) {
      let input;
      const preflight = require('../extension/src/content/sensitivePreflight').create({
        SensitiveScan: { scanSensitiveInputs: () => findings }, normalizeGovernanceRules: rules => rules,
        isTextSnapshotFile: () => true, appendRunEvent() {}, appendCompletionReport: value => { input = value; },
        tx: (en, zh) => locale === 'zh' ? zh : en, tr: key => I18n.t(locale, key)
      });
      assert.equal((await preflight.run({ task: 'fixture', project: { files: [] }, rules: {} })).blocked, true);
      assert.equal(input.conclusionKey, 'sensitive_blocked');
      assert.equal(input.conclusion, productText('sensitive_blocked', locale));
      const { failure } = input;
      assert.deepEqual(Object.keys(failure.evidence).sort(), ['detectorIds', 'findingCount']);
      assert.equal(failure.evidence.findingCount, findings.length);
      assert.ok(failure.evidence.detectorIds.length <= 5);
      assert.equal(new Set(failure.evidence.detectorIds).size, failure.evidence.detectorIds.length);
      assert.equal(failure.retryable, false);
      assert.equal(failure.changedDocument, false);
      assert.equal(Failures.normalizeFailureReason({ code: failure.code }).severity, 'blocked');
      assert.equal(Failures.normalizeFailureReason({ code: failure.code }).retryable, false);
      const live = reportRun({ ...input, locale });
      const legacy = outcomeRun({ ...input, locale, failure: undefined });
      assert.equal(projectOutcome(legacy), null);
      assert.equal(Controller.isRetryReplacementEligible(legacy, Settlement.projectRunSettlement(legacy)), true);
      for (const run of [live, roundtripRun(live)]) {
        const before = JSON.stringify(run);
        assert.deepEqual(run.events[0].failure.evidence, failure.evidence);
        assert.doesNotMatch(JSON.stringify(run.events[0]), /private-preview|private-match|AKIA|unknown-detector/);
        assert.equal(Controller.isRetryReplacementEligible(run, Settlement.projectRunSettlement(run)), true);
        for (const to of ['en', 'zh']) {
          const outcome = projectOutcome(run, to);
          assert.equal(outcome.kind, 'didnt-finish');
          const finding = I18n.t(to, `sensitiveFinding_${label}`);
          assert.equal(outcome.title, I18n.t(to, 'runOutcomeCause_sensitive_content_blocked', {
            finding: to === 'zh' && /^[A-Za-z]/.test(finding) ? ` ${finding}` : finding
          }));
          assert.equal(outcome.body, I18n.t(to, 'runOutcomeNoWrites'));
          assert.equal(outcome.nextStep, I18n.t(to, 'failureReason_sensitive_content_blocked_next'));
        }
        assert.equal(JSON.stringify(run), before);
      }
    }
  }
});

test('quiet zero-write failures retain the durable report used by retry replacement', () => {
  for (const locale of ['en', 'zh']) {
    const failure = Failures.normalizeFailureReason({ ok: false, code: 'codex_context_limit' });
    const run = outcomeRun({ status: 'failed', errorMessage: 'codex_context_limit', failure, locale });
    const stored = JSON.stringify(run);
    // Deliberately no settlement/mode shortcut: eligibility must parse the saved 0/0 row.
    assert.equal(Controller.isRetryReplacementEligible(run, {}), true);
    for (const to of ['en', 'zh']) {
      const outcome = projectOutcome(run, to);
      assert.equal(outcome.kind, 'didnt-finish');
      assert.equal(outcome.noWrites, true);
      assert.equal(outcome.tone, 'warning');
      assert.equal(Controller.isRetryReplacementEligible(run, {}), true);
    }
    assert.equal(JSON.stringify(run), stored);
    delete run.events[0].detailStructured.conclusionSource;
    assert.equal(projectOutcome(run), null);
    assert.equal(projectOutcome({ events: null }), null);
  }
});

test('outcome projection preserves settlement and gives uncertain document evidence precedence over counts', () => {
  const ops = ['intro.tex', 'refs.bib', 'main.tex'].map(path => ({ type: 'replace', path, content: 'new content' }));
  for (const [appliedCount, code, kind] of [[2, 'stale_source_changed', 'partly-written'],
    [0, 'stale_source_changed', 'not-written'], [2, 'write_timeout', 'check-overleaf'], [0, 'write_observed_mismatch', 'check-overleaf']]) {
    const operations = appliedCount ? ops : [ops[2]];
    const failure = Failures.normalizeWritebackFailure({ ok: false, code }, ops[2]);
    const applied = operations.slice(0, appliedCount).map(operation => ({ operation, result: { ok: true, changedDocument: true, verified: true } }));
    const skipped = [{ operation: ops[2], result: { ok: false, code, failure } }];
    const applyResult = { applied, skipped };
    const facts = Settlement.settle({ operations, applyResult }).facts;
    const source = { origin: 'product', key: 'writeback', outcome: 'partial_sync', prefixLength: 0 };
    const run = outcomeRun({ status: 'failed', failure, operations, applyResults: [applyResult],
      conclusion: productText('partial_sync', 'en'), conclusionSource: source }, { settlement: facts });
    const before = JSON.stringify(run), beforeActions = Settlement.projectRunSettlement(run);
    const outcome = projectOutcome(run);
    assert.equal(outcome.kind, kind);
    assert.equal(outcome.tone, kind === 'check-overleaf' ? 'error' : 'warning');
    assert.equal(outcome.wrote, appliedCount);
    if (kind === 'partly-written') assert.deepEqual(outcome.files.map(item => [item.file, item.written]),
      [['intro.tex', true], ['refs.bib', true], ['main.tex', false]]);
    assert.deepEqual(Settlement.projectRunSettlement(run), beforeActions);
    assert.equal(JSON.stringify(run), before);
  }
});

const CompileAdapter = require('../extension/src/shared/compileAdapter');
const CompileBridge = require('../extension/src/page/compileBridge');
function compileHarness({ response = () => compileResponse('success'), log = '' } = {}) {
  const window = { location: { origin: 'https://www.overleaf.com' }, CodexOverleafCompileAdapter: CompileAdapter,
    async fetch(url, init) {
      if (init?.method === 'POST') return new Response(JSON.stringify(await response()), { status: 200 });
      return new Response(log, { status: 200 });
    } };
  // Overleaf's idle main Recompile button; clicking it posts one compile.
  const button = { tagName: 'BUTTON', textContent: 'Recompile', disabled: false,
    classList: { contains: name => name === 'compile-button' }, getAttribute: () => null, closest: () => null,
    click() { void window.fetch('/project/fixture/compile', { method: 'POST' }); } };
  const bridge = CompileBridge.create({ window, document: { querySelectorAll: () => [button] },
    waitForSaveState: async () => ({ state: 'verified_saved' }) });
  bridge.install(); bridge.markSourceEdited(1);
  return { bridge };
}
const compileResponse = status => ({ status,
  outputFiles: [{ path: 'output.log', url: '/build/output.log' }, { path: 'output.pdf', url: '/build/output.pdf' }] });

test('a successful compile response with TeX errors projects compile errors, never a successful compile', async () => {
  const h = compileHarness({ response: () => compileResponse('success'), log: [
    'This is pdfTeX', './main.tex:119: Undefined control sequence.', 'l.119 \\undefinedcommandxyz', '',
    '! Missing $ inserted.', 'l.120 example', '', 'Output written on output.pdf (1 page).'
  ].join('\n') });
  const result = await h.bridge.triggerCompile({ preferUiClick: true });
  const logResult = await h.bridge.getCompileLog({ triggerIfStale: false, captureId: result.compile.captureId });
  const summary = CompileAdapter.buildPostWriteCompileSummary({ result, logResult });
  assert.equal(summary.status, 'failed');
  assert.equal(summary.errors.length, 2);
  assert.match(summary.errors[0], /main\.tex:119: Undefined control sequence/);
  const prefix = 'Keep the model answer exactly. 模型原文';
  const source = { origin: 'product', key: 'writeback', outcome: 'synced', prefixLength: prefix.length,
    hasCompile: true, compileStatus: summary.status, errorCount: summary.errors.length, errors: summary.errors };
  const run = outcomeRun({ conclusion: prefix + '\nPost-write compile check: 2 remaining error(s): ' + summary.errors.join('; '),
    conclusionSource: source, compileErrors: summary.errors }, { status: 'completed' });
  const before = JSON.stringify(run);
  for (const locale of ['en', 'zh']) {
    const outcome = projectOutcome(run, locale);
    assert.equal(outcome.kind, 'compile-errors');
    assert.equal(outcome.compileCount, 2);
    assert.equal(outcome.conclusion, prefix);
    assert.deepEqual(outcome.compileErrors, summary.errors);
    assert.equal(run.events[0].detailStructured.conclusionSource.compileStatus, 'failed');
  }
  assert.equal(JSON.stringify(run), before);
  run.events[0].detailStructured.conclusion += ' user edit';
  assert.equal(projectOutcome(run), null);
});

test('compiler failure without a log is an error; missing or untimely success evidence is unconfirmed', async () => {
  const h = compileHarness({ response: () => ({ status: 'failure', outputFiles: [] }) });
  const result = await h.bridge.triggerCompile({ preferUiClick: true });
  const failed = CompileAdapter.buildPostWriteCompileSummary({ result });
  assert.equal(failed.status, 'failed');
  assert.ok(failed.errors.length > 0);
  const success = { ok: true, resultCaptured: true, compile: { ok: true, status: 'success', captureId: 1 } };
  for (const logResult of [null, { ok: false }, { ok: true, fresh: false, captureId: 1 },
    { ok: true, fresh: true, captureId: 2, errors: [] }]) {
    const summary = CompileAdapter.buildPostWriteCompileSummary({ result: success, logResult });
    assert.equal(summary.status, 'unconfirmed');
    assert.equal(summary.errors.length, 0);
  }
  assert.equal(CompileAdapter.buildPostWriteCompileSummary({ result: success,
    logResult: { ok: true, fresh: true, captureId: 1, errors: [], warnings: [] } }).status, 'success');
  assert.equal(CompileAdapter.buildPostWriteCompileSummary({ result: { ...success, compile: { ...success.compile, fromCache: true } },
    logResult: { ok: true, fresh: true, captureId: 1, errors: [] } }).status, 'unconfirmed');
  for (const locale of ['en', 'zh']) {
    const source = { origin: 'product', key: 'writeback', outcome: 'synced', prefixLength: 0,
      hasCompile: true, compileStatus: 'unconfirmed' };
    const conclusion = productText('synced', locale) + '\n' + require('../extension/src/shared/i18n').t(locale, 'runCompileUnconfirmed');
    const saved = saveReport({ conclusion, conclusionSource: source }, locale);
    assert.notEqual(project(saved, locale === 'en' ? 'zh' : 'en'), conclusion);
    assert.equal(saved.event.detailStructured.conclusionSource.compileStatus, 'unconfirmed');
  }
});

// Mount the real activity view with the DOM operations used by its disclosures and rows.
function mountActivity(run, locale, { open = false, incoming } = {}) {
  class Element {
    constructor(tag, attribute) {
      this.tag = tag;
      this.attribute = attribute;
      this.children = [];
      this.dataset = {};
      this.classList = { add() {} };
      this.value = '';
    }
    get textContent() { return this.value + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this.value = value; }
    get firstChild() { return this.children[0]; }
    get nextSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1]; }
    insertBefore(child, next) {
      child.remove();
      this.children.splice(next ? this.children.indexOf(next) : this.children.length, 0, child);
      child.parent = this;
    }
    append(...children) { children.forEach(child => this.insertBefore(child)); }
    replaceChildren(...children) { while (this.firstChild) this.firstChild.remove(); this.append(...children); }
    before(child) { this.parent.insertBefore(child, this); }
    after(child) { this.parent.insertBefore(child, this.nextSibling); }
    remove() {
      if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = undefined;
    }
    querySelector(selector) {
      const matches = child => selector === child.tag || selector === `[${child.attribute}]`
        || (selector.startsWith('.') && child.className?.split(' ').includes(selector.slice(1)));
      return this.children.map(child => matches(child) ? child : child.querySelector(selector)).find(Boolean);
    }
    addEventListener() {}
    setAttribute() {}
  }
  const storage = new Map([['codex-overleaf:workflow-disclosure:v1', JSON.stringify([[run.id + ':run', open]])]]);
  const window = { sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } };
  require('node:vm').runInNewContext(require('node:fs').readFileSync(
    require.resolve('../extension/src/content/runActivitySummary'), 'utf8'), {
    window, document: { createElement: tag => new Element(tag) }
  });
  const root = new Element('article');
  const process = new Element('details', 'data-run-process');
  process.append(new Element('summary', 'data-run-process-summary'));
  root.append(process, new Element('div', 'data-run-events'));
  const view = window.CodexOverleafRunActivitySummary.create({ RunActivityModel: ActivityModel, formatElapsed: String,
    renderMarkdownBlockText() {}, findRunRecord: () => run, tx: (en, zh) => locale === 'zh' ? zh : en });
  view.mount(root, run);
  if (incoming) view.update({ root, recordId: run.id }, incoming);
  return root;
}

test('partial workspace sync shows unread paths in live and restored setup rows and summaries', () => {
  const skippedFiles = [{ path: 'pictures/large.pdf', reason: 'binary_file_too_large' },
    { path: 'pictures/second.png', reason: 'binary_project_too_large' },
    { path: 'pictures/Smith, Jones、draft.png' }, { path: 'pictures/fourth.png' }];
  for (const locale of ['en', 'zh']) {
    for (const detail of [{ contentComplete: false, skippedFiles }, { skippedFiles: skippedFiles.slice(0, 2) }, { contentComplete: false }]) {
      const event = { type: 'overleaf.sync.completed', status: 'completed',
        title: 'Readable files synced', detail: { fileCount: 2, ...detail } };
      const before = JSON.stringify(event);
      const activity = Transcript.mapAgentEventToActivity(event, { locale });
      assert.equal(activity.visible, true);
      assert.equal(activity.status, 'warning');
      for (const file of (detail.skippedFiles || []).slice(0, 3)) assert.ok(activity.title.includes(file.path));
      assert.deepEqual(activity.technicalDetail.detail, event.detail);
      assert.equal(JSON.stringify(event), before);
      const live = { id: 'sync-partial', mode: 'ask', status: 'running', events: [activity] };
      const run = roundtripRun({ ...live, status: 'completed' });
      assert.equal(run.status, 'completed');
      assert.equal(run.events[0].status, 'warning');
      assert.ok(!run.events[0].technicalDetail);
      const { title, status, kind } = activity;
      const thinking = ['Checking the readable files', 'Reading the introduction', 'Reviewing the results'].map(title => ({
        kind: 'stream', streamRole: 'reasoning', title, status: 'running'
      }));
      const verifyWarning = node => {
        assert.match(node.textContent, /Some project content was not read|部分项目内容未读取/);
        for (const file of (detail.skippedFiles || []).slice(0, 3)) assert.ok(node.textContent.includes(file.path));
        if (detail.skippedFiles?.length > 3) {
          assert.ok(!node.textContent.includes(skippedFiles[3].path));
          assert.match(node.textContent, /and 1 more|等 4 个文件/);
        }
      };
      for (const view of [locale, locale === 'en' ? 'zh' : 'en']) {
        const language = view === 'en' ? /Some project content was not read/ : /部分项目内容未读取/;
        const peek = mountActivity(live, view).querySelector('.run-peek-row');
        assert.equal(peek.dataset.state, 'warning');
        assert.match(peek.textContent, language);
        verifyWarning(peek);
        const foldedPeek = mountActivity({ ...live, events: [activity, ...thinking] }, view).querySelector('.run-peek-row');
        assert.equal(foldedPeek.dataset.state, 'warning');
        verifyWarning(foldedPeek);
        const activityOnly = { ...run.events[0], title: 'Event' };
        const titleOnly = { title, status, kind };
        const olderActivity = { ...titleOnly, activity: { v: 1, kind: 'lifecycle', target: 'setup.workspace', state: 'completed', written: 2 } };
        for (const record of [live, ...[activityOnly, titleOnly, olderActivity].map(saved => ({ ...run, events: [saved] }))]) {
          const root = mountActivity(record, view, { open: true });
          assert.equal(root.querySelector('.run-setup').hidden, false);
          const row = root.querySelector('.run-setup-step');
          assert.equal(row.dataset.state, 'warning');
          assert.match(row.textContent, language);
          verifyWarning(row);
          const fold = root.querySelector('.run-setup-summary');
          assert.equal(fold.dataset.notes, 'true');
          assert.match(fold.textContent, language);
          verifyWarning(fold);
        }
      }
    }
  }
});

test('a sync completion and its localized live copy update one setup row', () => {
  const started = { ...Transcript.mapAgentEventToActivity({ type: 'overleaf.sync.started' }), timestamp: '2026-11-18T01:00:00Z' };
  const event = { type: 'overleaf.sync.completed', detail: { fileCount: 2, skippedFiles: [{ path: 'fig.png' }] } };
  const completed = locale => ({ ...Transcript.mapAgentEventToActivity(event, { locale }), timestamp: '2026-11-18T01:00:01Z' });
  const run = { id: 'one-sync', mode: 'ask', status: 'running', events: [started, completed('en')] };
  const root = mountActivity(run, 'zh', { open: true, incoming: completed('zh') });
  const steps = root.querySelector('.run-setup-steps');
  assert.equal(steps.children.length, 1);
  assert.equal(steps.firstChild.dataset.state, 'warning');
  assert.match(steps.firstChild.textContent, /部分项目内容未读取.*fig\.png/);
});

test('sync-like titles preserve typed notices and assistant messages', () => {
  const titleSources = ['Synced 2 files.', '已同步 2 个文件。', 'Synced the Overleaf project.',
    'Synced 2 readable files; some project content is unavailable. Unread: fig.png.'];
  for (const title of titleSources) {
    const notice = { kind: 'activity', status: 'warning', title,
      technicalDetail: { type: 'codex.session.event', detail: { method: 'guardianWarning' } } };
    const message = { kind: 'activity', status: 'completed', title,
      technicalDetail: { type: 'codex.agent.message', detail: { phase: 'commentary' } } };
    const stored = roundtripRun({ id: 'typed-events', status: 'completed', events: [notice, message] }, false);
    assert.equal(stored.events[0].activity.noticeSource, 'guardianWarning');
    assert.equal(stored.events[1].activity.kind, 'message');
    const projection = ActivityModel.project(stored);
    assert.equal(projection.setup.steps.length, 0);
    assert.equal(projection.notices[0].event.title, title);
    assert.equal(projection.blocks.at(-1).kind, 'message');
  }
  const partial = titleSources.at(-1);
  const existing = { v: 1, kind: 'notice', target: 'setup.workspace', state: 'completed' };
  assert.equal(ActivityModel.capture({ title: partial, activity: existing }).kind, 'notice');
});

test('complete workspace sync retains the ordinary setup row and summary for current and legacy titles', () => {
  for (const locale of ['en', 'zh']) {
    for (const detail of [{ fileCount: 2 }, { fileCount: 2, contentComplete: true, skippedFiles: [] }]) {
      const activity = Transcript.mapAgentEventToActivity({ type: 'overleaf.sync.completed', detail }, { locale });
      assert.equal(activity.status, 'completed');
      assert.equal(activity.visible, true);
      const { kind, title, status } = activity;
      const oldTitle = locale === 'zh' ? title.replace('2 个文件', '2 个文本文件') : title.replace('2 files.', '2 text files.');
      for (const event of [activity, { kind, title, status }, { kind, title: oldTitle, status }]) {
        const root = mountActivity({ id: 'complete', mode: 'ask', status: 'completed', events: [event] }, locale, { open: true });
        const row = root.querySelector('.run-setup-step');
        assert.equal(row.dataset.state, 'completed');
        assert.equal(row.textContent, locale === 'zh' ? '已同步 2 个文件到本地工作区' : 'Synced 2 files to the local workspace');
        const fold = root.querySelector('.run-setup-summary');
        assert.equal(fold.dataset.notes, 'false');
        assert.equal(fold.textContent, locale === 'zh' ? '启动 · 2 个文件' : 'Setup · 2 files');
      }
    }
  }
});

function assertZipGuidance(nextStep, locale) {
  assert.match(nextStep, locale === 'zh'
    ? /确认能在 Overleaf 中下载项目源码 ZIP.*输入 @ 或点击 ＋ 添加要处理的文件后重试。$/
    : /download the project's source ZIP from Overleaf.*add the files you want to work on with @ or ＋ and retry\.$/);
  assert.doesNotMatch(nextStep, /Menu|菜单|https?:\/\/|example-private-id/);
}

test('blocked project-read cards localize the ZIP cause and preserve bounded path-form evidence across storage', () => {
  const origin = 'https://overleaf.invalid';
  const endpoint = origin + '/project/example-private-id/download/zip';
  const secondEndpoint = origin + '/download/project/example-private-id';
  const timedOut = 'Overleaf ZIP download timed out after 30000ms';
  const couldNotRead = [/project source download could not be read/, /无法读取 Overleaf 项目源码下载内容/];
  const cases = [
    [`${endpoint} returned 503; ${secondEndpoint} returned 503`, [{ endpoint, status: 503 }, { endpoint: secondEndpoint, status: 503 }],
      [/project download returned HTTP 503/, /项目源码下载返回 HTTP 503/], 'http', 503],
    [`${endpoint} returned 404; ${secondEndpoint} failed: ${timedOut}`, [{ endpoint, status: 404 }, { endpoint: secondEndpoint, error: timedOut }],
      [/project download timed out/, /项目源码下载超时/], 'timeout'],
    [`${endpoint} returned 502`, [], [/project download returned HTTP 502/, /项目源码下载返回 HTTP 502/], 'http', 502],
    [`${endpoint} failed: Failed to fetch`, [{ endpoint, error: 'Failed to fetch' }], couldNotRead, 'unavailable'],
    [`${endpoint} returned no text files (application/zip)`, [{ endpoint, status: 200 }], couldNotRead, 'unavailable'],
    ['binary_file_too_large', [], null],
    ['ZIP file identities were incomplete', [], null],
    ['', [], null]
  ];
  for (const [reason, attempts, cause, kind, status] of cases) {
    const capabilities = { skipped: reason ? [{ path: 'project.zip', reason }] : [], diagnostics: { zipTiming: { attempts } } };
    const zipFailure = Failures.captureProjectZipFailure(capabilities);
    const expected = cause ? { reason: reason.replaceAll(origin, ''), kind, ...(status ? { status } : {}),
      attempts: attempts.map(({ endpoint: _endpoint, ...attempt }) => attempt) } : undefined;
    assert.deepEqual(zipFailure, expected);
    for (const locale of ['en', 'zh']) {
      const failure = Settlement.buildContentFailure('project_snapshot_unavailable', null, {
        evidence: { fetchFailed: true, ...(zipFailure ? { zipFailure } : {}) }
      });
      const live = reportRun({ conclusionKey: 'full_project_unread', conclusion: productText('full_project_unread', locale),
        status: 'blocked', locale, failure, nextStep: locale === 'zh'
          ? '请刷新 Overleaf 项目或重新打开要处理的 .tex 文件后再试。'
          : 'Reload the Overleaf project or reopen the .tex file you want to process, then retry.' });
      for (const run of [live, roundtripRun(live)]) {
        assert.deepEqual(run.events[0].failure.evidence.zipFailure, expected);
        const card = projectOutcome(run, locale);
        assert.equal(card.kind, 'didnt-finish');
        const visible = [card.title, card.body, card.nextStep].join('\n');
        assert.doesNotMatch(visible, /https?:\/\/|example-private-id/);
        if (cause) {
          assert.match(card.title, cause[locale === 'zh' ? 1 : 0]);
          assertZipGuidance(card.nextStep, locale);
        } else {
          assert.equal(card.title, I18n.t(locale, 'runOutcomeCause_project_snapshot_unavailable'));
          assert.equal(card.nextStep, I18n.t(locale, 'failureReason_project_snapshot_unavailable_next'));
        }
      }
    }
  }
});

test('warm-mirror rejection keeps its explanation and uses the ZIP guidance only when recovery has ZIP evidence', async () => {
  const window = {};
  require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve('../extension/src/content/otWarmMirror'), 'utf8'), { window });
  const blocked = { blocking: ['Full project snapshot was not captured.'] };
  const projects = [
    { capabilities: { skipped: [{ path: 'project.zip', reason: 'https://overleaf.invalid/project/example-private-id/download/zip returned 503' }] } },
    { capabilities: { skipped: [] } }
  ];
  for (const locale of ['en', 'zh']) {
    const tr = key => I18n.t(locale, key);
    for (const project of projects) {
      let input, status;
      const warmMirror = window.CodexOverleafOtWarmMirror.create({
        tr, tx: (en, zh) => locale === 'zh' ? zh : en, runController: Controller,
        projectFiles: require('../extension/src/shared/projectFiles'), throwIfRunCancellationRequested() {},
        formatProjectSnapshotUserLog: () => '', formatProjectSnapshotWarning: value => value, getProjectSnapshotWarnings: () => blocked,
        buildProjectSnapshotFailure: snapshot => {
          const zipFailure = Failures.captureProjectZipFailure(snapshot.capabilities);
          const failure = Settlement.buildContentFailure('project_snapshot_unavailable', null, { evidence: { zipFailure } });
          return { ...failure, ...Failures.localizeFailureReason(failure, locale, tr) };
        },
        appendLog() {}, appendCompletionReport: report => { input = report; }, finishRunView: (_title, result) => { status = result; }
      });
      assert.equal((await warmMirror.prepareMirrorStaleRetry({ project })).ok, false);
      assert.equal(status, 'failed');
      assert.equal(input.conclusion, tr('warmMirrorStaleBlockedConclusion'));
      if (project.capabilities.skipped.length) {
        assertZipGuidance(input.nextStep, locale);
        const run = roundtripRun(reportRun({ ...input, locale }));
        for (const language of ['en', 'zh']) {
          const card = projectOutcome(run, language);
          assert.match(card.title, /HTTP 503/);
          assert.equal(card.body, I18n.t(language, 'warmMirrorStaleBlockedConclusion'));
          assertZipGuidance(card.nextStep, language);
        }
      } else {
        assert.equal(input.failure, undefined);
        assert.equal(input.nextStep, tr('warmMirrorStaleBlockedNextStep'));
        assert.equal(projectOutcome(reportRun({ ...input, locale }), locale), null);
      }
    }
  }
});

test('the project-read diagnostic reads assets like a run and never calls a project with unread content complete', async () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/src/content/diagnosticsController.js'), 'utf8'), sandbox);
  const zip = (skipped, contentComplete) => ({ id: 'p', activePath: 'main.tex', files: [
    { path: 'main.tex', content: '\\documentclass{article}\n'.repeat(8) }, { path: 'fig/a.png', kind: 'binary', contentBase64: 'AA==', size: 1 }],
  capabilities: { fullProjectSnapshot: true, contentComplete, method: 'overleaf-zip', skipped } });
  const failed = { id: 'p', files: [], capabilities: { fullProjectSnapshot: false, method: 'overleaf-zip-file-list-unavailable',
    skipped: [{ path: 'project.zip', reason: 'https://overleaf.invalid/project/p/download/zip returned 503' }] } };
  for (const locale of ['en', 'zh']) {
    const tr = key => I18n.t(locale, key);
    let snapshot, params;
    const controller = sandbox.window.CodexOverleafDiagnosticsController.create({
      tr, tx: (en, zh) => locale === 'zh' ? zh : en,
      callPageBridge: async (_method, value) => { params = value; return snapshot; },
      getCurrentProjectId: () => 'p', RUN_SNAPSHOT_ZIP_TIMEOUT_MS: 30000,
      formatProjectSnapshotLog: () => '', formatProjectSnapshotWarning: value => value,
      getProjectSnapshotWarnings: value => ({ blocking: [], nonBlocking: (value?.capabilities?.skipped || []).length ? ['skipped'] : [] }),
      isTextSnapshotFile: file => file.kind !== 'binary' && typeof file.content === 'string',
      describeProjectZipFailure: project => {
        const zipFailure = Failures.captureProjectZipFailure(project?.capabilities);
        return zipFailure ? Failures.localizeFailureReason({ code: 'project_snapshot_unavailable', evidence: { zipFailure } }, locale, tr) : null;
      }
    });
    const check = async value => { snapshot = value; return controller.inspectProjectSnapshot({ collectOnly: true }); };

    const complete = await check(zip([], true));
    assert.equal(params.includeBinaryFiles, true);
    assert.equal(params.projectId, 'p');
    assert.equal(complete.status, 'completed');
    assert.equal(complete.title, locale === 'zh' ? '项目读取正常' : 'Project Read OK');

    const quota = await check(zip([{ path: 'fig/huge.png', reason: 'binary_file_too_large' }], false));
    assert.equal(quota.status, 'warning');
    assert.match(quota.summary, /fig\/huge\.png/);
    assert.match(quota.nextStep, /10 MB/);

    const realZipAsset = await check(zip([{ path: 'project.zip', reason: 'binary_file_too_large' }], false));
    assert.equal(realZipAsset.status, 'warning');
    assert.match(realZipAsset.summary, /project\.zip/);

    const overlay = await check(zip([{ path: 'main.tex', reason: 'editor_not_ready', source: 'active-editor' }], true));
    assert.equal(overlay.status, 'completed');
    assert.equal(overlay.notes.length, 0);

    const blocked = await check(failed);
    assert.equal(blocked.status, 'warning');
    assert.match(blocked.summary, locale === 'zh' ? /HTTP 503/ : /returned HTTP 503/);
    assert.equal(blocked.nextStep, I18n.t(locale, 'failureReason_project_source_download_next'));
    assert.doesNotMatch(blocked.summary + blocked.nextStep, /overleaf\.invalid|\/project\/p\//);
  }
});
