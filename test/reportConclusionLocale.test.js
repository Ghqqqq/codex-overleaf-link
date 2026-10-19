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
