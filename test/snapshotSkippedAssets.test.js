const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ProjectFiles = require('../extension/src/shared/projectFiles');
const { createStoredZip } = require('./_helpers/storedZip');
const { extractFunction } = require('./_helpers/extractFunction');
const { handleRequest } = require('../native-host/src/taskRunnerRuntime');
const { runCodexSession } = require('../native-host/src/codexSessionRunner');
const { getProjectMirror, getMirrorStatus, collectMirrorChangesDetailed, syncOverleafToMirror,
  confirmWritebackFiles, patchMirrorFiles, applyFileOverlays } = require('../native-host/src/mirrorWorkspace');
const routerSource = fs.readFileSync(path.join(__dirname, '../extension/src/page/snapshotRouter.js'), 'utf8');
const runtimeSource = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
const diagnosticsSource = fs.readFileSync(path.join(__dirname, '../extension/src/content/diagnosticsPanel.js'), 'utf8');
const MIB = 1024 * 1024;
const MAIN = '\\documentclass{article}\n\\begin{document}\n' + 'Safe synthetic project source. '.repeat(8) + '\n\\end{document}\n';
const ASSET = 'figures/target.png';

function setup(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'col-skipped-assets-'));
  t.after(() => fs.rmSync(rootDir, { force: true, recursive: true }));
  const projectId = 'skipped-asset-project';
  const mirror = getProjectMirror(projectId, { rootDir });
  let zip;
  let mainContent = MAIN;
  const window = {
    location: { href: `https://fixture.invalid/project/${projectId}`, origin: 'https://fixture.invalid' },
    CodexOverleafProjectFiles: ProjectFiles,
    btoa: text => Buffer.from(text, 'latin1').toString('base64'), setTimeout, clearTimeout
  };
  const context = vm.createContext({
    window, TextDecoder, AbortController, setTimeout, clearTimeout,
    fetch: async () => ({ ok: true, headers: { get: () => 'application/zip' }, arrayBuffer: async () => zip })
  });
  vm.runInContext(routerSource, context);
  vm.runInContext(diagnosticsSource, context);
  const router = window.CodexOverleafSnapshotRouter.create({
    window, normalizePath: ProjectFiles.normalizeSafeProjectPath, readActiveEditorText: () => mainContent,
    treeOperations: { getProjectId: () => projectId, getActiveFilePath: () => 'main.tex',
      getEditorStoreFilePath: () => 'main.tex', collectDocRecords: () => [] }
  });
  Object.assign(context, {
    RUN_SNAPSHOT_ZIP_TIMEOUT_MS: 30000, getActiveFocusFiles: () => [], Modules: { ProjectFiles },
    DiagnosticsPanel: window.CodexOverleafDiagnosticsPanel,
    callPageBridge: async (method, params) => {
      assert.equal(method, 'getProjectSnapshot');
      return router.buildProjectSnapshot(params);
    }
  });
  vm.runInContext(['normalizeSnapshotPath', 'sanitizeRunProjectSnapshot', 'getRunProjectSnapshot',
    'getProjectSnapshotWarnings', 'isTextSnapshotFile', 'uniqueContentSignatures']
    .map(name => extractFunction(runtimeSource, name)).join('\n'), context);
  const baseline = () => JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
  const entry = () => baseline().files.find(file => file.path === ASSET);
  const read = file => fs.readFileSync(path.join(mirror.workspacePath, file), 'utf8');
  const request = project => handleRequest({ id: 'sync', method: 'mirror.sync', params: { projectId, project } },
    { CODEX_OVERLEAF_MIRROR_ROOT: rootDir });
  async function snapshot(assets = {}) {
    zip = createStoredZip({ 'main.tex': mainContent, ...assets });
    const project = await context.getRunProjectSnapshot();
    assert.equal(project.capabilities.fullProjectSnapshot, true);
    assert.equal(context.getProjectSnapshotWarnings(project).blocking.length, 0);
    return project;
  }
  async function sync(assets = {}) {
    const project = await snapshot(assets);
    const response = await request(project);
    assert.equal(response.ok, true, JSON.stringify(response.error));
    return project;
  }
  const seed = () => sync({ [ASSET]: 'old-png-content' });
  const oversized = () => sync({ [ASSET]: 'X'.repeat(10 * MIB + 1) });
  return { rootDir, projectId, mirror, baseline, entry, read, request, snapshot, sync, seed, oversized,
    setMain: content => { mainContent = content; } };
}

test('ZIP skipped asset preserves old bytes and baseline without claiming complete fresh contents', async t => {
  const h = setup(t);
  await h.seed();
  const oldEntry = h.entry(), lastFull = h.baseline().lastFullSyncAt;
  const project = await h.oversized();
  assert.equal(fs.existsSync(path.join(h.mirror.workspacePath, ASSET)), true, 'skipped asset must remain in the mirror');
  assert.equal(project.capabilities.contentComplete, false);
  assert.equal(project.capabilities.skipped[0].reason, 'binary_file_too_large');
  assert.equal(h.read(ASSET), 'old-png-content');
  assert.deepEqual(h.entry(), oldEntry);
  assert.deepEqual(h.baseline().unreadFiles.map(file => file.path), [ASSET]);
  assert.equal(h.baseline().lastFullSyncAt, lastFull);
  assert.equal(h.baseline().dirty, true);
  assert.equal(getMirrorStatus(h.projectId, { rootDir: h.rootDir }).exists, false);
});

test('unread asset cannot produce writeback while ordinary text edits still work', async t => {
  const h = setup(t);
  await h.seed();
  const project = await h.oversized();
  let prompt;
  const result = await runCodexSession({
    params: { projectId: h.projectId, project, task: 'Update text.', mode: 'auto',
      loadCodexLocalSkills: false, loadCodexOverleafSkills: false },
    rootDir: h.rootDir,
    env: { HOME: h.rootDir },
    executeCodex: async input => {
      prompt = input.task;
      fs.writeFileSync(path.join(input.workspacePath, 'main.tex'), MAIN + '\nupdated');
      fs.mkdirSync(path.dirname(path.join(input.workspacePath, ASSET)), { recursive: true });
      fs.writeFileSync(path.join(input.workspacePath, ASSET), 'locally-changed-stale-asset');
      return { assistantMessage: 'Text updated.' };
    }
  });
  assert.deepEqual(result.syncChanges.map(file => file.path), ['main.tex']);
  assert.equal(result.unsupportedChanges.find(file => file.path === ASSET)?.reason, 'snapshot_content_unavailable');
  assert.match(prompt, /figures\/target\.png/);
  assert.match(prompt, /not read|unavailable/i);
  assert.match(prompt, /stale|outdated/i);
  assert.doesNotMatch(prompt, /The local workspace was synced from Overleaf immediately before this turn\./);
  const before = h.baseline();
  const confirmation = await confirmWritebackFiles({ projectId: h.projectId, rootDir: h.rootDir, paths: ['main.tex'] });
  assert.equal(confirmation.ok, false);
  assert.deepEqual(h.baseline(), before, 'writeback confirmation must not wash away unread state');
  const main = before.files.find(file => file.path === 'main.tex');
  const patch = await patchMirrorFiles({ projectId: h.projectId, rootDir: h.rootDir,
    files: [{ path: 'main.tex', baseHash: main.hash, nextContent: MAIN + '\nOT' }] });
  assert.equal(patch.appliedFiles.length, 0);
  assert.equal(h.baseline().dirty, true);
  assert.deepEqual(h.baseline().unreadFiles, before.unreadFiles);
  await h.oversized();
  assert.equal(h.baseline().dirty, true, 'a later full ZIP with the same unread asset cannot restore freshness');
  assert.deepEqual(h.baseline().unreadFiles, before.unreadFiles);
});

test('cold mirror records unavailable path without fake baseline and withholds recreated asset', async t => {
  const h = setup(t);
  await h.oversized();
  assert.equal(h.entry(), undefined);
  assert.equal(fs.existsSync(path.join(h.mirror.workspacePath, ASSET)), false);
  assert.deepEqual((h.baseline().unreadFiles || []).map(file => file.path), [ASSET]);
  assert.equal(getMirrorStatus(h.projectId, { rootDir: h.rootDir }).exists, false);
  fs.mkdirSync(path.dirname(path.join(h.mirror.workspacePath, ASSET)), { recursive: true });
  fs.writeFileSync(path.join(h.mirror.workspacePath, ASSET), 'new local asset');
  const changes = await collectMirrorChangesDetailed({ projectId: h.projectId, rootDir: h.rootDir });
  assert.deepEqual(changes.changes, []);
  assert.equal(changes.unsupportedChanges[0].reason, 'snapshot_content_unavailable');
});

test('later readable asset refreshes bytes, replaces old baseline, and restores normal reuse', async t => {
  const h = setup(t);
  await h.seed();
  await h.oversized();
  const project = await h.sync({ [ASSET]: 'current-readable-png' });
  assert.equal(project.capabilities.contentComplete, true);
  assert.equal(h.read(ASSET), 'current-readable-png');
  assert.equal(h.entry().size, 'current-readable-png'.length);
  assert.deepEqual(h.baseline().unreadFiles, []);
  assert.equal(h.baseline().dirty, false);
  assert.equal(getMirrorStatus(h.projectId, { rootDir: h.rootDir }).exists, true);
});

test('true remote deletion after a skipped read removes old asset and unread marker', async t => {
  const h = setup(t);
  await h.seed();
  await h.oversized();
  await h.sync({});
  assert.equal(fs.existsSync(path.join(h.mirror.workspacePath, ASSET)), false);
  assert.equal(h.entry(), undefined);
  assert.deepEqual(h.baseline().unreadFiles, []);
  assert.equal(h.baseline().dirty, false);
});

test('partial text refresh keeps unread asset metadata, bytes, baseline and dirty state', async t => {
  const h = setup(t);
  await h.seed();
  await h.oversized();
  const before = h.entry();
  await syncOverleafToMirror({ projectId: h.projectId, rootDir: h.rootDir,
    project: { capabilities: { fullProjectSnapshot: false }, files: [{ path: 'main.tex', content: MAIN + '\npartial' }] } });
  assert.deepEqual(h.entry(), before);
  assert.equal(h.read(ASSET), 'old-png-content');
  assert.deepEqual(h.baseline().unreadFiles.map(file => file.path), [ASSET]);
  assert.equal(h.baseline().dirty, true);
});

test('normal asset at 10 MiB stays supported and native-side oversized filtering also preserves old data', async t => {
  const h = setup(t);
  const project = await h.sync({ [ASSET]: 'A'.repeat(10 * MIB) });
  assert.equal(project.capabilities.contentComplete, true);
  assert.equal(h.entry().size, 10 * MIB);
  const before = h.entry();
  const response = await h.request({ capabilities: { fullProjectSnapshot: true },
    files: [{ path: 'main.tex', content: MAIN },
      { path: ASSET, kind: 'binary', size: 10 * MIB + 1, contentBase64: Buffer.alloc(10 * MIB + 1).toString('base64') }] });
  assert.equal(response.ok, true);
  assert.deepEqual(h.entry(), before);
  assert.equal(h.read(ASSET).length, 10 * MIB);
  assert.equal(h.baseline().dirty, true);
});

test('page aggregate skip still hits Native 32 MiB quota without modifying prior mirror', async t => {
  const h = setup(t);
  await h.seed();
  const before = h.baseline();
  const assets = {};
  for (let i = 0; i < 8; i++) assets[`figures/filler-${i}.png`] = 'B'.repeat(10 * MIB);
  assets[ASSET] = 'too-late';
  const project = await h.snapshot(assets);
  assert.equal(project.capabilities.skipped[0].reason, 'binary_project_too_large');
  const response = await h.request(project);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'native_request_quota_exceeded');
  assert.deepEqual(h.baseline(), before);
  assert.equal(h.read(ASSET), 'old-png-content');
});

test('unread metadata independently blocks reuse, confirmation and OT even if dirty was cleared', async t => {
  const h = setup(t);
  await h.seed();
  await h.oversized();
  const baseline = h.baseline();
  fs.writeFileSync(h.mirror.baselinePath, JSON.stringify({ ...baseline, dirty: false }));
  assert.equal(getMirrorStatus(h.projectId, { rootDir: h.rootDir }).exists, false);
  const confirmation = await confirmWritebackFiles({ projectId: h.projectId, rootDir: h.rootDir, paths: ['main.tex'] });
  assert.equal(confirmation.ok, false);
  const main = baseline.files.find(file => file.path === 'main.tex');
  const patch = await patchMirrorFiles({ projectId: h.projectId, rootDir: h.rootDir,
    files: [{ path: 'main.tex', baseHash: main.hash, nextContent: MAIN + '\nOT' }] });
  assert.equal(patch.appliedFiles.length, 0);
  await applyFileOverlays({ projectId: h.projectId, rootDir: h.rootDir,
    overlays: [{ path: ASSET, content: 'overlay cannot overwrite unread binary' }] });
  assert.equal(h.read(ASSET), 'old-png-content');
  assert.deepEqual(h.entry(), baseline.files.find(file => file.path === ASSET));
  assert.deepEqual(h.baseline().unreadFiles, baseline.unreadFiles);
});

test('invalid skipped path rejects before changing mirror files or baseline', async t => {
  const h = setup(t);
  await h.seed();
  const before = h.baseline();
  const response = await h.request({ capabilities: { fullProjectSnapshot: true,
    skipped: [{ path: '../outside.png', reason: 'binary_file_too_large', size: 10 * MIB + 1 }] },
    files: [{ path: 'main.tex', content: MAIN + '\nshould not land' }] });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'mirror_sync_failed');
  assert.deepEqual(h.baseline(), before);
  assert.equal(h.read(ASSET), 'old-png-content');
  assert.equal(h.read('main.tex'), MAIN);
});

test('successful text writeback settles while skipped-asset refresh invalidates once and clears pending state', async t => {
  const h = setup(t);
  await h.seed();
  const project = await h.oversized();
  const Controller = require('../extension/src/content/writebackController');
  const Plan = require('../extension/src/content/writebackPlan');
  const Broker = require('../extension/src/content/assetTransferBroker');
  const Governance = require('../extension/src/shared/governanceRules');
  const outer = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/src/content/writebackOrchestrator.js'), 'utf8'), outer);
  const noop = () => {}, tx = en => en, tr = key => key;
  const events = [], reports = [], nativeCalls = [], pageCalls = [], mirrorSettlements = [], undoResults = [];
  const view = { runProjectId: h.projectId, recordId: 'run-text', sessionId: 'session-text' };
  const getAppliedEntries = value => value?.applied || [], getSkippedEntries = value => value?.skipped || [];
  const plan = Plan.create({ tx, tr, normalizeSafeProjectPath: ProjectFiles.normalizeSafeProjectPath,
    GovernanceRules: Governance, getGovernanceRulesForCurrentProject: () => ({}),
    showPluginConfirm: async () => true, formatOperationFiles: () => '', getAppliedEntries, getSkippedEntries });
  const nextMain = MAIN + '\nText update survives an unavailable image.';
  // Native produced the text delta locally; the page apply/save endpoints are
  // synthetic. Broker, orchestration, save decisions, snapshot and Native
  // confirmation/invalidation are the actual production modules.
  fs.writeFileSync(path.join(h.mirror.workspacePath, 'main.tex'), nextMain);
  const sendBackgroundNative = async request => {
    nativeCalls.push(request.method);
    return handleRequest({ id: 'writeback', ...request }, { CODEX_OVERLEAF_MIRROR_ROOT: h.rootDir });
  };
  let appliedCount = 0;
  const callPageBridge = async (method, params) => {
    pageCalls.push(method);
    if (method === 'applyOperations') {
      assert.equal(params.operations.length, 1);
      assert.equal(params.operations[0].path, 'main.tex');
      h.setMain(nextMain);
      appliedCount++;
      return { ok: true, applied: params.operations.map(operation => ({ operation,
        result: { ok: true, changedDocument: true, verified: true, verifiedContent: nextMain, content: nextMain } })), skipped: [] };
    }
    if (method === 'waitForSaveState') return { ok: true, state: 'verified_saved' };
    if (method === 'invalidateProjectSnapshot') return { ok: true };
    if (method === 'getProjectSnapshot') return h.snapshot({ [ASSET]: 'X'.repeat(10 * MIB + 1) });
    throw new Error('Unexpected Page method ' + method);
  };
  const orchestrator = outer.window.CodexOverleafWritebackOrchestrator.create({
    compileAdapter: require('../extension/src/shared/compileAdapter'),
    ...plan, tr, tx, getLocale: () => 'en', getState: () => ({ mode: 'auto', requireReviewing: false }),
    getCurrentRunView: () => view, getCurrentProjectId: () => h.projectId,
    getAssistantAnswerForCurrentRun: () => 'Text updated.', cleanFinalAnswer: value => value,
    appendRunEvent: event => events.push(event), appendRunRecordEvent: noop,
    appendChangeSummary: () => 'Text synced.', appendCompletionReport: report => reports.push(report),
    appendOperationsPreview: noop, appendPartialWritebackWarning: noop, appendApplyResult: noop,
    renderReadOnlyDiffReview: noop, showPluginConfirm: async () => true,
    ensureReviewingBeforeWrite: async () => ({ ok: true }),
    recordUndoFromApply: (_project, result) => undoResults.push(result),
    assetTransferBroker: Broker.create({ callPageBridge, sendBackgroundNative }),
    callPageBridge, sendBackgroundNative, writebackController: Controller,
    buildSyncApplyOperations: Controller.buildSyncApplyOperations,
    getAppliedOperationPaths: Controller.getAppliedOperationPaths,
    getAppliedSyncChanges: Controller.getAppliedSyncChanges, getSkippedEntries,
    hasApplyResultEntries: value => getAppliedEntries(value).length + getSkippedEntries(value).length > 0,
    hasSkippedApplyOperations: values => values.some(value => getSkippedEntries(value).length),
    formatWritebackSkippedNextStep: () => 'review skipped', resetContextProject: noop,
    sanitizeRunProjectSnapshot: value => value, RUN_SNAPSHOT_ZIP_TIMEOUT_MS: 30000,
    onMirrorRefreshSettled: value => mirrorSettlements.push(value)
  });
  const result = await orchestrator.applySyncChangesToOverleaf([
    { type: 'write', path: 'main.tex', previousContent: MAIN, previousExists: true, content: nextMain }
  ], project, { mode: 'auto', requireReviewing: false, autoRecompile: false });
  await orchestrator.getPendingMirrorRefresh();
  assert.equal(result.hasSkippedOperations, false);
  assert.equal(result.applied.applied.length, 1);
  assert.equal(result.applied.skipped.length, 0);
  assert.equal(appliedCount, 1);
  assert.equal(undoResults.length, 1);
  assert.equal(reports.length, 1);
  assert.deepEqual(nativeCalls, ['mirror.confirmWriteback', 'mirror.invalidate']);
  assert.equal(pageCalls.filter(method => method === 'getProjectSnapshot').length, 1);
  assert.equal(mirrorSettlements.length, 1);
  assert.equal(mirrorSettlements[0].state, 'not-attempted');
  assert.equal(orchestrator.getPendingMirrorRefresh(), null);
  assert.equal(h.read('main.tex'), nextMain);
  assert.equal(h.read(ASSET), 'old-png-content');
  assert.deepEqual(h.baseline().unreadFiles.map(file => file.path), [ASSET]);
  assert.equal(getMirrorStatus(h.projectId, { rootDir: h.rootDir }).exists, false);
  assert.equal(events.some(event => /workspace refreshed|workspace confirmed in place/.test(event.title || '')), false);
});
