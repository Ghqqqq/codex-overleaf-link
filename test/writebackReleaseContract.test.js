'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Controller = require('../extension/src/content/writebackController');
const Plan = require('../extension/src/content/writebackPlan');
const ProjectFiles = require('../extension/src/shared/projectFiles');
const Compile = require('../extension/src/shared/compileAdapter');

function harness() {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/src/content/writebackOrchestrator.js'), 'utf8'), sandbox);
  const events = [], reports = [];
  const plan = Plan.create({ tx: en => en, tr: value => value,
    normalizeSafeProjectPath: ProjectFiles.normalizeSafeProjectPath,
    getAppliedEntries: value => value.applied || [], getSkippedEntries: value => value.skipped || [],
    getGovernanceRulesForCurrentProject: () => ({}) });
  const orchestrator = sandbox.window.CodexOverleafWritebackOrchestrator.create({
    ...plan, tx: en => en, tr: value => value, getLocale: () => 'en',
    getState: () => ({ mode: 'auto' }), getCurrentRunView: () => null,
    getAssistantAnswerForCurrentRun: () => 'Answer', cleanFinalAnswer: value => value,
    appendRunEvent: event => events.push(event), appendCompletionReport: report => reports.push(report),
    writebackController: Controller, compileAdapter: Compile,
    callPageBridge() { throw new Error('Read-only/withheld results must not write'); }
  });
  return { orchestrator, events, reports, plan };
}

for (const reason of ['subagent_unfinished_output', 'subagent_unauthorized_edit']) {
  test('withheld ' + reason + ' settles with its explanation instead of throwing in post-processing', async () => {
    const h = harness();
    const result = await h.orchestrator.applySyncChangesToOverleaf([], {}, {
      mode: 'auto', unsupportedChanges: [{ path: 'main.tex', reason }]
    });
    assert.equal(result.hasSkippedOperations, true);
    assert.equal(result.applied.applied.length, 0);
    assert.equal(result.applied.skipped[0].result.code, reason);
    assert.equal(result.applied.skipped[0].result.changedDocument, false);
    assert.match(result.applied.skipped[0].result.reason, /subagent/i);
    assert.equal(h.reports.length, 1);
    assert.equal(h.reports[0].status, 'failed');
  });
}

test('submitted Ask mode ignores local and withheld changes without a failed completion', async () => {
  const h = harness();
  const result = await h.orchestrator.applySyncChangesToOverleaf(
    [{ type: 'create', path: 'new.tex', content: 'unexpected write' }], {}, {
      mode: 'ask', unsupportedChanges: [{ path: 'held.tex', reason: 'subagent_unfinished_output' }]
    });
  assert.equal(result.hasSkippedOperations, false);
  assert.equal(result.audit.resultStatus, 'ask_ignored_local_changes');
  assert.ok(h.reports.every(report => report.status !== 'failed'));
});

test('extracted writeback planning retains path and null-audit contracts', () => {
  const h = harness();
  const plan = h.plan.partitionUnsafeProjectPathOperations([
    { type: 'create', path: '../outside.tex' },
    { type: 'create', path: 'sections/valid.tex', content: '' }
  ]);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].result.code, 'invalid_project_path');
  assert.equal(plan.safe[0].path, 'sections/valid.tex');
  assert.equal(h.plan.summarizeOperationForAudit(null, null).path, '');
});

test('compile summary extraction keeps error evidence bounded and does not infer success', () => {
  const summary = Compile.buildPostWriteCompileSummary({
    result: { ok: false, reason: 'compile failed' },
    logResult: { ok: true, errors: Array(9).fill('x'.repeat(300)), warnings: [] }
  });
  assert.equal(summary.status, 'failed');
  assert.equal(summary.errors.length, 5);
  assert.ok(summary.errors.every(value => value.length <= 182));
  assert.equal(Compile.buildPostWriteCompileSummary({ result: { ok: true } }).status, 'triggered');
});
