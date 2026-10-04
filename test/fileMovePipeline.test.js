'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { runCodexSession } = require('../native-host/src/codexSessionRunner');
const { fixture } = require('./_helpers/fileMoveFixture');
const { extractFunction } = require('./_helpers/extractFunction');
const Controller = require('../extension/src/content/writebackController');
const Plan = require('../extension/src/content/writebackPlan');
const Broker = require('../extension/src/content/assetTransferBroker');
const Router = require('../extension/src/page/writebackRouter');
const Journal = require('../extension/src/page/writebackReceiptJournal');
const Guard = require('../extension/src/page/writeGuard');
const Stale = require('../extension/src/shared/staleGuard');
const Files = require('../extension/src/shared/projectFiles');
const Governance = require('../extension/src/shared/governanceRules');
const Undo = require('../extension/src/shared/undoOperations');
const Settlement = require('../extension/src/shared/writebackSettlement');
const Summary = require('../extension/src/shared/summary');
const no = () => {};
async function nativeMove(t, kind, restrictToFocusFiles = false) {
  const h = fixture({ kind, source: kind === 'text' ? 'old.tex' : 'old.png', target: kind === 'text' ? 'new.tex' : 'new.png' });
  const before = await h.snapshotRouter.fetchProjectZipSnapshot();
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'col-move-pipeline-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const response = await runCodexSession({ rootDir, env: {}, params: {
    projectId: h.state.projectId, project: before, task: 'Move the existing file', mode: 'auto',
    loadCodexLocalSkills: false, loadCodexOverleafSkills: false,
    restrictToFocusFiles, focusFiles: [h.operation.path]
  }, executeCodex: async ({ workspacePath }) => {
    fs.renameSync(path.join(workspacePath, h.operation.path), path.join(workspacePath, h.operation.to));
    return { assistantMessage: 'Prepared a move.' };
  } });
  return { h, before, response };
}
function contentPipeline(h, approve) {
  Object.assign(h.window, { CodexOverleafWriteGuard: Guard, CodexOverleafStaleGuard: Stale });
  const router = Router.create({ window: h.window, treeOperations: h.treeOperations, moveFile: h.mover.moveFile,
    normalizeSafeProjectPath: Files.normalizeSafeProjectPath,
    ensureEditing: async () => ({ ok: true }), ensureReviewing: async () => ({ ok: true }) });
  const pageApply = vm.runInNewContext('(' + extractFunction(fs.readFileSync(path.join(__dirname, '../extension/src/pageBridge.js'), 'utf8'), 'applyOperations') + ')', { writebackRouter: router });
  const journal = Journal.create({ getProjectId: () => h.state.projectId, prepareEditor: async () => ({ ok: true }), applyOperations: pageApply });
  const calls = [], prompts = [], reports = []; let count = 0, checkpoint;
  const callPageBridge = async (method, params) => {
    calls.push(method);
    if (method === 'applyOperations') return journal.apply({ ...params, writebackRequestId: 'pipeline-' + (++count) });
    if (method === 'getWritebackReceipt') return journal.get(params);
    if (method === 'getProjectSnapshot') return h.snapshotRouter.fetchProjectZipSnapshot(params);
    if (method === 'waitForSaveState') return { ok: true, state: 'verified_saved' };
    if (method === 'invalidateProjectSnapshot') return { ok: true };
    throw new Error('Unexpected Page method: ' + method);
  };
  const sendBackgroundNative = async () => ({ ok: true, result: { ok: true, invalidated: true } });
  const broker = Broker.create({ callPageBridge, sendBackgroundNative });
  const getAppliedEntries = value => value?.applied || [], getSkippedEntries = value => value?.skipped || [];
  const approvePlan = async config => { prompts.push(config); return approve; };
  const deps = { tx: en => en, tr: key => key, normalizeSafeProjectPath: Files.normalizeSafeProjectPath,
    GovernanceRules: Governance, getGovernanceRulesForCurrentProject: () => ({}), showPluginConfirm: approvePlan,
    formatOperationFiles: operations => operations.map(op => op.path).join(', '), getAppliedEntries, getSkippedEntries };
  const window = {}; new Function('window', fs.readFileSync(path.join(__dirname, '../extension/src/content/writebackOrchestrator.js'), 'utf8'))(window);
  const orchestrator = window.CodexOverleafWritebackOrchestrator.create({ ...deps, ...Plan.create(deps),
    getState: () => ({ mode: 'auto', autoRecompile: false, requireReviewing: false }), getCurrentProjectId: () => h.state.projectId,
    getCurrentRunView: () => ({ runProjectId: h.state.projectId, recordId: 'r', sessionId: 's' }),
    getLocale: () => 'en', getAssistantAnswerForCurrentRun: () => '', cleanFinalAnswer: value => value,
    appendRunEvent: no, appendRunRecordEvent: no, appendChangeSummary: Summary.buildChangeSummaryLine,
    appendCompletionReport: report => reports.push(report), appendOperationsPreview: no, appendPartialWritebackWarning: no,
    appendApplyResult: no, renderReadOnlyDiffReview: no, ensureReviewingBeforeWrite: async () => ({ ok: true }),
    recordUndoFromApply: (project, result) => { checkpoint = Undo.buildUndoCheckpoint(project,
      result.applied.map(entry => Settlement.attachVerifiedContentToOperation(entry.operation, entry.result))); },
    assetTransferBroker: broker, callPageBridge, sendBackgroundNative, writebackController: Controller, writebackSettlement: Settlement,
    buildSyncApplyOperations: Controller.buildSyncApplyOperations, getAppliedOperationPaths: Controller.getAppliedOperationPaths,
    getAppliedSyncChanges: Controller.getAppliedSyncChanges, hasApplyResultEntries: result => result.applied.length + result.skipped.length > 0,
    hasSkippedApplyOperations: values => values.some(value => value.skipped.length), formatWritebackSkippedNextStep: () => 'Review the file plan.',
    resetContextProject: no, sanitizeRunProjectSnapshot: value => value, RUN_SNAPSHOT_ZIP_TIMEOUT_MS: 30000 });
  return { calls, prompts, reports, async apply(response, before) {
    const result = await orchestrator.applySyncChangesToOverleaf(response.syncChanges, before,
      { mode: 'auto', requireReviewing: false, autoRecompile: false, unsupportedChanges: response.unsupportedChanges });
    await orchestrator.getPendingMirrorRefresh(); return result;
  }, undo: () => broker.applyOperations({ ...checkpoint, operations: checkpoint.undoOperations,
    baseFiles: checkpoint.undoBaseFiles, runProjectId: h.state.projectId, requireEditing: true }) };
}
for (const kind of ['text', 'binary']) for (const approve of [true, false]) {
  test(`Native mirror to confirmation, Page receipt and inverse move: ${kind}, approve=${approve}`, async t => {
    const { h, before, response } = await nativeMove(t, kind);
    assert.equal(response.syncChanges.length, 1); assert.equal(response.syncChanges[0].type, 'move');
    const original = h.files.get(h.operation.path); const pipeline = contentPipeline(h, approve);
    const result = await pipeline.apply(response, before); assert.equal(pipeline.prompts.length, 1);
    if (!approve) {
      assert.equal(h.state.posts.length, 0); assert.equal(pipeline.calls.includes('applyOperations'), false);
      assert.equal(h.files.get(h.operation.path), original); assert.equal(h.files.has(h.operation.to), false);
      assert.equal(result.hasSkippedOperations, true); return;
    }
    assert.equal(result.applied.applied.length, 1, JSON.stringify(result)); assert.equal(h.files.get(h.operation.to), original);
    assert.equal(pipeline.reports.at(-1).saveVerification.state, 'verified_saved');
    const check = await Controller.buildSaveCheck(result.applied, before, { projectId: h.state.projectId });
    assert.ok(check); assert.equal(check.files.find(file => file.path === h.operation.path).absent, true);
    assert.equal(check.files.find(file => file.path === h.operation.to).sha256, response.syncChanges[0].moveProof.sha256);
    const undone = await pipeline.undo(); assert.equal(undone.ok, true, JSON.stringify(undone));
    assert.equal(h.files.get(h.operation.path), original); assert.equal(h.files.has(h.operation.to), false);
    assert.equal(original.comments[0].id, 'comment-original'); assert.equal(original.reviewing[0].id, 'review-original');
  });
}
test('a focus-restricted Native run cannot move its source outside the captured focus set', async t => {
  const { response } = await nativeMove(t, 'text', true);
  assert.deepEqual(response.syncChanges, []);
  assert.equal(response.unsupportedChanges[0].reason, 'out_of_focus_partial_snapshot');
});
