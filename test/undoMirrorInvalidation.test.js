'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { extractFunction } = require('./_helpers/extractFunction');
const { handleRequest } = require('../native-host/src/taskRunner');
const { syncOverleafToMirror, getMirrorStatus, getProjectMirror } = require('../native-host/src/mirrorWorkspace');
const Compatibility = require('../extension/src/shared/compatibility');
const NativeCompatibilityController = require('../extension/src/content/nativeCompatibilityController');
const packageVersion = require('../package.json').version;
const runtimeSource = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
const orchestratorSource = fs.readFileSync(path.join(__dirname, '../extension/src/content/writebackOrchestrator.js'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(__dirname, '../extension/src/background.js'), 'utf8');

function methodSet(source, name) {
  const declaration = source.match(new RegExp(`const ${name} = new Set\\((\\[[\\s\\S]*?\\])\\);`));
  assert.ok(declaration, name);
  return new Set(vm.runInNewContext(declaration[1]));
}

function compatibleClient(rootDir, throwIfCancellationRequested) {
  const env = { CODEX_OVERLEAF_MIRROR_ROOT: rootDir,
    CODEX_OVERLEAF_ENV_READY: '1', CODEX_OVERLEAF_CODEX_PATH: process.execPath };
  return NativeCompatibilityController.create({
    compatibility: Compatibility,
    gatedMethods: methodSet(runtimeSource, 'NATIVE_COMPATIBILITY_GATED_METHODS'),
    getExtensionCompatibilityMetadata: () => ({ version: packageVersion }),
    getNativeCompatibilityClassification: value => value.classification,
    throwIfCancellationRequested,
    tx: en => en, tr: key => key, getPanel: () => null, showPluginToast() {},
    nativeChannel: {
      async sendBackgroundNative(payload) {
        if (payload.method !== 'bridge.ping') {
          assert.equal(Compatibility.isNativeMethodAllowed(payload.method, payload.params?.nativeCompatibility), true,
            'the background compatibility gate must receive evidence from the actual content controller');
        }
        return handleRequest(payload, env);
      }
    }
  });
}

function tempRoot(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'col-undo-mirror-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true }));
  return rootDir;
}

function orchestration(options = {}) {
  const context = { window: {} };
  vm.runInNewContext(orchestratorSource, context);
  const events = [];
  const cacheCalls = [];
  const instance = context.window.CodexOverleafWritebackOrchestrator.create({
    tx: en => en,
    getCurrentProjectId: () => options.currentProject || 'undo-project',
    resetContextProject: () => cacheCalls.push('context'),
    callPageBridge: async method => cacheCalls.push(method),
    sendBackgroundNative: options.send || compatibleClient(options.rootDir).sendBackgroundNative,
    appendRunRecordEvent: (id, event) => events.push({ id, ...event })
  });
  return { instance, events, cacheCalls };
}

for (const kind of ['legacy', 'tracked']) {
  test(`real ${kind} Undo entry invalidates the old mirror before the next run`, async t => {
    const rootDir = tempRoot(t);
    const before = [{ path: 'root.tex', content: 'root base\n' }, { path: 'sub/child.tex', content: 'child base\n' }];
    const written = before.map(file => ({ ...file, content: file.content + '% old run\n' }));
    await syncOverleafToMirror({ projectId: 'undo-project', rootDir, project: { files: written } });
    const h = orchestration({ rootDir });
    const run = { id: 'undo-run', task: 'QA', undoStatus: '',
      executionSnapshot: { source: 'submitted', requireReviewing: kind === 'tracked' },
      undoTrackedChanges: kind === 'tracked' ? [{ id: 'change', path: 'root.tex' }] : [],
      undoExpectedFiles: before, undoBaseFiles: written };
    const operations = before.map(file => ({ type: 'edit', path: file.path }));
    const receipt = { changedDocument: true, skipped: [], applied: operations.map(operation => ({ operation,
      trackedChange: { path: operation.path, id: operation.path } })) };
    const scope = {
      writebackOrchestrator: h.instance,
      getPendingMirrorRefresh: h.instance.getPendingMirrorRefresh,
      findRunRecord: () => run, getRunUndoCount: () => 1,
      hasTrackedEditorUndo: () => false, isTrackedChangeLifecycleRun: () => kind === 'tracked',
      showPluginConfirm: async () => true, showUndoFileSelection: async () => operations.map(op => op.path),
      buildNoTraceUndoRestore: () => ({ operations, snapshotRestore: true }),
      findUnsafeFullFileUndoOperation: () => null,
      buildTrackedUndoPostFiles: () => written,
      getRunProjectIdForWriteback: () => 'undo-project',
      getPageBridgeTimeoutMs: () => 120000,
      callPageBridge: async () => receipt,
      isUndoResultEffectivelyApplied: () => true,
      tr: key => key, truncateRunTitle: value => value,
      formatOperationFiles: () => '', formatTrackedChangeFiles: () => '', formatTrackedUndoFiles: () => '',
      formatOperationType: value => value, formatApplyResultReason: () => '', formatBridgeResultReason: () => '',
      appendRunRecordEvent() {}, appendUndoReviewingPolicyEvent() {},
      trackedChangeInFlight: new Map(), refreshRunCardControls() {},
      setRunUndoStatus: (_id, status) => { run.undoStatus = status; },
      applyLegacyUndoSettlement: (_id, status) => { run.undoStatus = status; },
      applyTrackedChangeSettlement: () => { run.trackedChangeStatus = 'rejected'; },
      WritebackSettlement: { attachUndoNotVerifiedFailure() {} }, buildContentFailure() {}
    };
    vm.createContext(scope);
    vm.runInContext(extractFunction(runtimeSource, 'undoRunTrackedChanges') + '\n' + extractFunction(runtimeSource, 'undoRun'), scope);
    await scope.undoRun(run.id);
    await h.instance.getPendingMirrorRefresh();
    assert.equal(getMirrorStatus('undo-project', { rootDir }).exists, false);
    assert.equal(getMirrorStatus('undo-project', { rootDir }).dirty, true);
    assert.deepEqual(h.cacheCalls, ['context', 'invalidateProjectSnapshot']);
    assert.equal(kind === 'tracked' ? run.trackedChangeStatus : run.undoStatus, kind === 'tracked' ? 'rejected' : 'applied');
    const mirror = getProjectMirror('undo-project', { rootDir });
    assert.equal(fs.readFileSync(path.join(mirror.workspacePath, 'root.tex'), 'utf8'), written[0].content,
      'invalidation changes metadata only; it must not replay a pre-image into the workspace');
    const observed = [before[0], { ...before[1], content: before[1].content + 'later collaborator edit\n' }];
    const synced = await handleRequest({ method: 'mirror.sync', params: { projectId: 'undo-project',
      project: { files: observed, capabilities: { fullProjectSnapshot: true } } } }, { CODEX_OVERLEAF_MIRROR_ROOT: rootDir });
    assert.equal(synced.ok, true);
    assert.equal(getMirrorStatus('undo-project', { rootDir }).exists, true);
    for (const file of observed) assert.equal(fs.readFileSync(path.join(mirror.workspacePath, file.path), 'utf8'), file.content);
  });
}

test('mirror invalidation is idempotent and isolated to its explicit project', async t => {
  const rootDir = tempRoot(t);
  for (const projectId of ['undo-project', 'other-project']) {
    await syncOverleafToMirror({ projectId, rootDir, project: { files: [{ path: 'main.tex', content: projectId }] } });
  }
  for (let i = 0; i < 2; i++) {
    const response = await handleRequest({ method: 'mirror.invalidate', params: { projectId: 'undo-project' } }, { CODEX_OVERLEAF_MIRROR_ROOT: rootDir });
    assert.equal(response.ok, true);
    assert.equal(response.result.invalidated, true);
  }
  assert.equal(getMirrorStatus('other-project', { rootDir }).exists, true);
  const invalid = await handleRequest({ method: 'mirror.invalidate', params: {} }, { CODEX_OVERLEAF_MIRROR_ROOT: rootDir });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'invalid_project_id');
});

test('next-run barrier waits for invalidation and does not clear a newer refresh', async () => {
  let release;
  const h = orchestration({ send: () => new Promise(resolve => { release = resolve; }) });
  const pending = h.instance.invalidateMirrorAfterUndo('run', 'undo-project', { changedDocument: true });
  assert.equal(h.instance.getPendingMirrorRefresh(), pending);
  for (let i = 0; i < 8 && !release; i++) await Promise.resolve();
  release({ ok: true, result: { invalidated: true } });
  await pending;
  assert.equal(h.instance.getPendingMirrorRefresh(), null);
});

test('post-navigation invalidation stays with the original project and native failure is explicit', async () => {
  const calls = [];
  const h = orchestration({ currentProject: 'another-project', send: async request => {
    calls.push(request); return { ok: false, error: { message: 'native unavailable' } };
  } });
  await h.instance.invalidateMirrorAfterUndo('original-run', 'undo-project', { applied: [{}] });
  assert.deepEqual(h.cacheCalls, []);
  assert.equal(calls[0].params.projectId, 'undo-project');
  assert.equal(h.events[0].id, 'original-run');
  assert.match(h.events[0].title, /native unavailable/);
});

test('a no-change rejected request does not invalidate mirror data', async () => {
  const h = orchestration({ send: async () => { throw new Error('must not call native'); } });
  await h.instance.invalidateMirrorAfterUndo('run', 'undo-project', { applied: [], changedDocument: false });
  assert.deepEqual(h.cacheCalls, []);
  assert.deepEqual(h.events, []);
});

test('every background-gated mirror method receives compatibility evidence from content', () => {
  const content = methodSet(runtimeSource, 'NATIVE_COMPATIBILITY_GATED_METHODS');
  const background = methodSet(backgroundSource, 'COMPATIBILITY_REQUIRED_METHODS');
  for (const method of background) {
    if (method.startsWith('mirror.')) assert.equal(content.has(method), true, method);
  }
});

test('Undo cache invalidation survives an ended run cancellation without weakening execution cancellation', async t => {
  const rootDir = tempRoot(t);
  const client = compatibleClient(rootDir, () => { throw new Error('run cancelled'); });
  const response = await client.sendBackgroundNative({ method: 'mirror.invalidate', params: { projectId: 'undo-project' } });
  assert.equal(response.ok, true);
  assert.equal(response.result.invalidated, true);
  await assert.rejects(client.sendBackgroundNative({ method: 'codex.run', params: { projectId: 'undo-project' } }), /run cancelled/);
});
