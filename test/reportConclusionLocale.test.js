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

test('saved product conclusions follow the selected language without rewriting stored history', () => {
  for (const from of ['en', 'zh']) {
    const saved = saveReport({ conclusion: productText('cancelled', from), conclusionKey: 'cancelled' }, from);
    const before = JSON.stringify(saved);
    const en = project(saved, 'en'), zh = project(saved, 'zh');
    assert.equal(en, productText('cancelled', 'en'));
    assert.equal(zh, productText('cancelled', 'zh'));
    assert.doesNotMatch(en, /\p{Script=Han}/u);
    assert.match(zh, /\p{Script=Han}/u);
    assert.notEqual(en, zh);
    assert.equal(JSON.stringify(saved), before);
  }
});

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
const projectOutcome = (run, locale = 'en') => Completion.projectFinishedRun(run, locale, {
  projectRunSettlement: Settlement.projectRunSettlement
});
function outcomeRun(input, fields = {}) {
  const report = Transcript.buildHumanCompletionReport({ includeWriteResult: true, undoCount: 0, ...input });
  const run = { id: 'outcome', mode: 'auto', status: report.status, ...fields, events: [{
    kind: 'report', title: report.title, status: report.status, detail: report.text,
    detailStructured: report.structured, failure: input.failure
  }] };
  const state = Session.normalizePanelState({ activeSessionId: 's', sessions: [{ id: 's', projectId: 'p', runs: [run] }] });
  const row = Storage.buildSessionRecord(Session.prepareStateForStorage(state).sessions[0], { preserveRunActionPayload: true });
  return Session.normalizePanelState({ activeSessionId: 's', sessions: [JSON.parse(JSON.stringify(row))] }).sessions[0].runs[0];
}

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

test('compile projection removes only an intact product suffix and preserves the model prefix and archived report', () => {
  const prefix = 'Keep the model answer exactly. 模型原文';
  const errors = ['Undefined control sequence', 'Missing $ inserted'];
  const conclusion = prefix + '\nPost-write compile check: 2 remaining error(s): ' + errors.join('; ');
  const source = { origin: 'product', key: 'writeback', outcome: 'synced', prefixLength: prefix.length,
    hasCompile: true, compileStatus: 'failed', errorCount: 2, errors };
  const run = outcomeRun({ conclusion, conclusionSource: source }, { status: 'completed' });
  const before = JSON.stringify(run);
  for (const locale of ['en', 'zh']) {
    const outcome = projectOutcome(run, locale);
    assert.equal(outcome.kind, 'compile-errors');
    assert.equal(outcome.conclusion, prefix);
    assert.deepEqual(outcome.compileErrors, errors);
  }
  assert.equal(JSON.stringify(run), before);
  run.events[0].detailStructured.conclusion += ' user edit';
  assert.equal(projectOutcome(run), null);
});
