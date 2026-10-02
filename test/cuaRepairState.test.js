'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const Db = require('../extension/src/shared/storageDb');
const State = require('../extension/src/shared/sessionState');
const Intent = require('../extension/src/shared/writebackIntent');
const Settlement = require('../extension/src/shared/writebackSettlement');
const Results = require('../extension/src/content/runResultActions').create();
const { extractFromContentScript } = require('./_helpers/contentScriptSource');
const owner = { projectId: 'project-a', accountScopeId: 'account-a', sessionId: 'session-a', runId: 'run-a' };
const tx = en => en;
const metaOptions = { tx, trackedChangeInFlight: new Map(),
  isTrackedChangeLifecycleRun: run => Boolean(run.trackedChangeStatus), projectRunSettlement: () => ({ canUndo: true }) };
const selection = mode => ({ projectId: owner.projectId, path: 'main.tex', from: 0, to: 3,
  text: 'abc', documentHash: 'a'.repeat(64), lineStart: 1, lineEnd: 1, mode, capturedAt: '2026-10-02T00:00:00Z' });

async function restoreDraft(value) {
  const record = Db.buildSessionRecord({ id: owner.sessionId, projectId: owner.projectId,
    accountScopeId: owner.accountScopeId, task: 'Edited draft', mode: value?.mode === 'edit' ? 'auto' : 'ask',
    selectionContext: value, runs: [] });
  const sandbox = { Modules: { StorageDb: Db, StorageMigration: { runMigrationIfNeeded: async () => ({
    prefs: {}, sessions: [record], activeSessionId: record.id }) } },
    getCurrentProjectId: () => owner.projectId, storageKey: 'qa-state', PANEL_DEFAULT_WIDTH: 400,
    normalizeGovernanceRulesByProject: value => value || {}, cachedAccountScopeId: owner.accountScopeId };
  const load = vm.runInNewContext('(' + extractFromContentScript('loadStoredStateForProject') + ')', sandbox);
  return State.normalizePanelState(await load(owner.accountScopeId));
}

for (const mode of ['reference', 'edit']) test('actual persisted-session hydration restores ' + mode + ' draft selection', async () => {
  const restored = await restoreDraft(selection(mode));
  assert.equal(restored.task, 'Edited draft');
  assert.equal(restored.selectionContext?.text, 'abc');
  assert.equal(restored.selectionContext?.mode, mode);
  assert.equal(restored.mode, mode === 'edit' ? 'auto' : 'ask');
});
test('draft hydration never imports another project selection', async () => {
  assert.equal((await restoreDraft({ ...selection('edit'), projectId: 'other-project' })).selectionContext, null);
  assert.equal((await restoreDraft(null)).selectionContext, null);
});

test('mixed partial Undo summary uses recovery state rather than digits in prose', () => {
  const run = { id: 'run-a', trackedChangeStatus: 'needs_review', undoOperations: [{
    type: 'delete', path: 'qa.png', undoCreatedFile: { v: 1, kind: 'binary', sha256: 'a'.repeat(64) } }] };
  const rows = Results.projectCompletionMeta([{ key: 'undo', label: 'Undo', value: '1 reversible write' }], run, metaOptions);
  assert.match(rows[0].value, /Undo is incomplete/);
  const summary = Results.summarizeCompletionMeta(rows, run, { tx });
  assert.equal(summary.facts.find(fact => fact.key === 'undo').text, 'Undo incomplete');
});

function recoverableRun() {
  const saveCheck = Intent.normalizeSaveCheck({ ...owner, files: [{ path: 'qa.tex', sha256: 'a'.repeat(64), kind: 'text' }] });
  const retryWriteback = Intent.normalize({ ...owner, id: 'retry-a', operations: [{ type: 'create', path: 'qa.tex', content: 'abc' }], baseFiles: [] });
  assert.ok(saveCheck); assert.ok(retryWriteback);
  return { id: owner.runId, runProjectId: owner.projectId, saveCheck, retryWriteback, trackedChangeStatus: 'pending' };
}
for (const kind of ['tracked', 'legacy']) test(kind + ' full Undo clears forward write/save recovery', () => {
  const run = recoverableRun();
  const result = kind === 'tracked' ? Settlement.transitionTrackedChangeStatus('rejected')
    : Settlement.settleLegacyUndo({ run, status: 'applied', result: { ok: true, skipped: [] } });
  const next = Settlement.applySettlementTransition(run, result);
  assert.equal(next.saveCheck, null); assert.equal(next.retryWriteback, null);
  assert.ok(run.saveCheck, 'input must remain unchanged');
});
test('partial Undo and accepted edits retain their pending save evidence', () => {
  const run = recoverableRun();
  for (const transition of [Settlement.transitionTrackedChangeStatus('needs_review'),
    Settlement.transitionTrackedChangeStatus('accepted'), Settlement.settleLegacyUndo({ run, status: 'partial' })]) {
    assert.deepEqual(Settlement.applySettlementTransition(run, transition).saveCheck, run.saveCheck);
  }
});
test('old terminal Undo records cannot rehydrate forward recovery', () => {
  for (const terminal of [{ trackedChangeStatus: 'rejected' }, { undoStatus: 'applied' }]) {
    assert.deepEqual(State.pickWritebackRecovery({ ...recoverableRun(), ...terminal }), {});
  }
});
test('terminal Undo hides obsolete save status even in legacy recorded reports', () => {
  const run = { ...recoverableRun(), trackedChangeStatus: 'rejected' };
  const rows = [{ key: 'undo', label: 'Undo', value: '1 reversible write' },
    { key: 'saveState', label: 'Save', value: 'Pending confirmation' }];
  const projected = Results.projectCompletionMeta(rows, run, metaOptions);
  assert.equal(projected.some(row => row.key === 'saveState'), false);
  assert.equal(Results.summarizeCompletionMeta(rows, run, { tx }).facts.some(fact => fact.key === 'save'), false);
  assert.equal(rows.length, 2);
});
