'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Plan = require('../extension/src/content/writebackPlan');
const Controller = require('../extension/src/content/writebackController');
const Governance = require('../extension/src/shared/governanceRules');
const Files = require('../extension/src/shared/projectFiles');
function plan(approve) {
  const prompts = [];
  const deps = { tx: en => en, tr: key => key, normalizeSafeProjectPath: Files.normalizeSafeProjectPath,
    GovernanceRules: Governance, getGovernanceRulesForCurrentProject: () => ({}),
    showPluginConfirm: async value => { prompts.push(value); return approve; },
    formatOperationFiles: operations => operations.map(operation => operation.path).join(', '),
    getAppliedEntries: value => value?.applied || [], getSkippedEntries: value => value?.skipped || [] };
  return { deps, prompts, api: Plan.create(deps) };
}
test('a move and its source/destination are confirmed as one file plan', async () => {
  const h = plan(false), operations = [{ type: 'move', path: 'old.tex', to: 'new.tex' }];
  const decision = await h.api.confirmWholeFilePlan(operations);
  assert.deepEqual(decision.operations, []); assert.equal(decision.skipped.length, 1);
  assert.match(h.prompts[0].message, /old\.tex.*new\.tex/); assert.equal(h.prompts[0].destructive, true);
});
test('unpaired create plus delete is all-or-none approval without guessing a move', async () => {
  const h = plan(false), operations = [{ type: 'create', path: 'new.tex', content: 'changed content' }, { type: 'delete', path: 'old.tex' }];
  const decision = await h.api.confirmWholeFilePlan(operations);
  assert.deepEqual(decision.operations, []); assert.equal(decision.skipped.length, 2);
  assert.match(h.prompts[0].message, /new\.tex/); assert.match(h.prompts[0].message, /old\.tex/);
});
test('independent create-only operations keep their existing confirmation behavior', async () => {
  const h = plan(false), operations = [{ type: 'create', path: 'new.tex', content: 'new' }];
  assert.equal(await h.api.confirmWholeFilePlan(operations), null); assert.equal(h.prompts.length, 0);
});
test('approved whole plan retains every operation and covers its binary action', async () => {
  const h = plan(true), operations = [{ type: 'binary-create', path: 'new.png' }, { type: 'delete', path: 'old.tex' }];
  const decision = await h.api.confirmWholeFilePlan(operations);
  assert.equal(decision.approved, true); assert.deepEqual(decision.operations, operations); assert.deepEqual(decision.skipped, []);
});
test('a governance-filtered delete does not turn a compound plan into a silently applied create', async () => {
  const h = plan(false), operations = [{ type: 'create', path: 'new.tex', content: 'new' }];
  const decision = await h.api.confirmWholeFilePlan(operations, { originalOperations: [...operations, { type: 'delete', path: 'old.tex' }] });
  assert.deepEqual(decision.operations, []); assert.match(h.prompts[0].message, /old\.tex \(blocked\)/);
});
test('real orchestrator does not create a copy when an unmatched create/delete plan is rejected', async () => {
  const h = plan(false); const window = {}; let writes = 0, report;
  new Function('window', fs.readFileSync(path.join(__dirname, '../extension/src/content/writebackOrchestrator.js'), 'utf8'))(window);
  const runtime = window.CodexOverleafWritebackOrchestrator.create({ ...h.deps, ...h.api,
    getState: () => ({ mode: 'auto' }), getCurrentRunView: () => ({ runProjectId: 'p' }),
    getLocale: () => 'en', getAssistantAnswerForCurrentRun: () => '', cleanFinalAnswer: value => value,
    appendRunEvent() {}, appendCompletionReport(value) { report = value; }, appendApplyResult() {},
    buildSyncApplyOperations: Controller.buildSyncApplyOperations, writebackController: Controller,
    assetTransferBroker: { async applyOperations() { writes++; throw new Error('No write may be dispatched after plan rejection'); } },
    formatWritebackSkippedNextStep: () => 'Review the rejected file plan.' });
  const result = await runtime.applySyncChangesToOverleaf([{ type: 'write', path: 'new.tex', content: 'different' }, { type: 'delete', path: 'old.tex' }],
    { files: [{ path: 'old.tex', content: 'old' }] }, { mode: 'auto' });
  assert.equal(writes, 0); assert.equal(result.hasSkippedOperations, true);
  assert.equal(report.applyResults[0].skipped.length, 2); assert.equal(h.prompts.length, 1);
});
