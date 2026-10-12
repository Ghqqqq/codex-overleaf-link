'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const Files = require('../extension/src/shared/projectFiles');
const Stale = require('../extension/src/shared/staleGuard');
const Writeback = require('../extension/src/content/writebackController');
const Router = require('../extension/src/page/writebackRouter');
const Editor = require('../extension/src/page/overleafEditor');
const Guard = require('../extension/src/page/writeGuard');
const Capture = require('../extension/src/page/trackedChangeCapture');
const Lifecycle = require('../extension/src/page/trackedChangesLifecycle');
const Undo = require('../extension/src/shared/undoOperations');
const { computeTextPatches } = require('../native-host/src/textPatch');
const PROJECT = 'document-integrity';

// Only the external editor, file navigation and server snapshot are substituted.
// Production code owns patching, identity/freshness checks, readback and Undo.
function harness(t, initial, options = {}) {
  let active = Object.keys(initial)[0], selected = active, clock = 1000, reviewing = false;
  const files = new Map(Object.entries(initial)), views = new Map(), writes = [];
  t.mock.method(Date, 'now', () => clock);
  for (const path of files.keys()) {
    const doc = { toString: () => files.get(path), get length() { return files.get(path).length; } };
    views.set(path, { state: { doc, values: [{ ranges: { docId: path, changes: structuredClone(options.changes?.[path] || []), comments: [] }, threads: {} }] },
      dispatch({ changes }) {
        let next = files.get(path);
        for (const change of (Array.isArray(changes) ? changes : [changes]).slice().sort((a, b) => b.from - a.from))
          next = next.slice(0, change.from) + change.insert + next.slice(change.to);
        files.set(path, options.corruptWrite ? next + 'unexpected' : next);
        writes.push(path);
      }
    });
  }
  const win = { _ide: { project: { _id: PROJECT } }, document: { querySelector: selector => selector === 'meta[name="ol-csrfToken"]' ? { getAttribute: () => 'fixture-csrf' } : null },
    AbortController, setTimeout, clearTimeout,
    CodexOverleafProjectFiles: Files, CodexOverleafStaleGuard: Stale, CodexOverleafWriteGuard: Guard,
    CodexOverleafTrackedChangeCapture: Capture, CodexOverleafTrackedChangesLifecycle: Lifecycle };
  win.fetch = async (_url, init) => {
    const ids = new Set(JSON.parse(init.body).change_ids);
    const ledger = views.get(active).state.values[0].ranges;
    ledger.changes = ledger.changes.filter(change => !ids.has(change.id));
    return { ok: true };
  };
  const capture = Capture.create({ getCodeMirrorEditorView: () => views.get(active),
    getTrackedChangeDocumentId: path => path, getActiveFilePath: () => active });
  const adapter = Editor.create({ getCodeMirrorEditorView: () => views.get(active),
    getCodeMirrorDocText: view => view.state.doc.toString(), getCodeMirrorDocLength: view => view.state.doc.length,
    normalizeTextPatches: patches => ({ ok: true, patches: Writeback.normalizeTextPatches(patches) }) });
  const router = Router.create({ ...adapter, window: win,
    getCodeMirrorEditorView: () => views.get(active), getTrackedChangeDocumentId: path => path,
    getActiveEditorIdentity: () => ({ type: 'codemirror-view', doc: views.get(active).state.doc }),
    activeEditorIdentityChanged: previous => previous?.doc !== views.get(active).state.doc,
    normalizeSafeProjectPath: Files.normalizeSafeProjectPath,
    writebackOpenSettleMs: 0, delay: async ms => { clock += ms; },
    compileBridge: { markSourceEdited() {} },
    getReviewingState: () => ({ reviewing: { ok: reviewing } }),
    isReviewingConfirmedForWrite: state => state.reviewing.ok,
    isEditingConfirmedForNoTraceUndo: state => !state.reviewing.ok,
    ensureEditing: async () => { reviewing = false; return { ok: true }; },
    ensureReviewing: async () => { reviewing = true; return { ok: true }; },
    setReviewingEnabled: async enabled => { reviewing = enabled; return { ok: true, enabled }; },
    collectElements: () => [], isInsideCodexPanel: () => false,
    waitForSaveState: async () => ({ ok: true, state: 'verified_saved' }),
    treeOperations: {
      getProjectId: () => win._ide.project._id, getActiveFilePath: () => selected,
      projectPathExists: path => files.has(path),
      async openFileByPath(path) { selected = path; if (!options.stuckEditor) active = path; return { ok: true }; },
      async waitForActiveEditorText(path) { return { ok: true, path, text: files.get(active) }; }
    }
  });
  const snapshot = () => ({ id: PROJECT, capabilities: { fullProjectSnapshot: true, method: 'overleaf-zip', skipped: [] },
    files: [...files].map(([path, content]) => ({ path, content, source: 'overleaf-zip' })) });
  return { router, files, writes, win, snapshot, refs: () => capture.prepareTrackedChangeCapture(active).refs,
    apply(baseFiles, operations, extra = {}) {
      return router.applyOperations({ runProjectId: PROJECT, requireEditing: true, baseFiles, operations, ...extra });
    }
  };
}

test('two-file write, server save verification and persisted Undo restore all original bytes including an empty file', async t => {
  const initial = { 'main.tex': 'Original 正文\n', 'nested/empty.tex': '' }, h = harness(t, initial);
  const before = h.snapshot();
  const operations = Writeback.buildSyncApplyOperations(Object.entries(initial).map(([path, content]) => ({
    type: 'write', path, content: content + '% unique edit\n'
  })), before);
  const result = await h.apply(before.files, operations);
  assert.equal(result.ok, true, JSON.stringify(result));
  for (const [path, content] of Object.entries(initial)) assert.equal(h.files.get(path), content + '% unique edit\n');
  const check = JSON.parse(JSON.stringify(await Writeback.buildSaveCheck(result, before, { projectId: PROJECT })));
  assert.equal((await Writeback.confirmSaveCheck(check, { assertCurrent() {}, readSnapshot: async () => before })).ok, false,
    'editor readback alone cannot prove the server saved the new content');
  assert.equal((await Writeback.confirmSaveCheck(check, { assertCurrent() {}, readSnapshot: async () => h.snapshot() })).ok, true);
  const checkpoint = JSON.parse(JSON.stringify(Undo.buildUndoCheckpoint(before, result.applied.map(entry => entry.operation))));
  const restored = Undo.buildSnapshotRestoreUndo(checkpoint);
  const undone = await h.apply(checkpoint.undoBaseFiles, restored.operations, { reviewingPolicy: 'no-trace-undo' });
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.deepEqual(Object.fromEntries(h.files), initial);
});

test('an empty baseline changed by a collaborator cannot be overwritten', async t => {
  const h = harness(t, { 'main.tex': 'collaborator content' });
  const result = await h.apply([{ path: 'main.tex', content: '' }], [{ type: 'edit', path: 'main.tex', replaceAll: 'model content' }]);
  assert.equal(result.ok, false);
  assert.equal(h.files.get('main.tex'), 'collaborator content');
  assert.deepEqual(h.writes, []);
});

test('a nonconflicting insertion keeps later collaborator text', async t => {
  const h = harness(t, { 'main.tex': 'collaborator content' });
  const result = await h.apply([{ path: 'main.tex', content: '' }], [{ type: 'edit', path: 'main.tex', patches: computeTextPatches('', 'prefix ') }]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.files.get('main.tex'), 'prefix collaborator content');
});

test('selecting a different file without switching its editor never writes to the old document', async t => {
  const initial = { 'main.tex': 'root body', 'nested/empty.tex': '' }, h = harness(t, initial, { stuckEditor: true });
  const result = await h.apply(h.snapshot().files, [{ type: 'edit', path: 'nested/empty.tex', replaceAll: 'new body' }]);
  assert.equal(result.ok, false);
  assert.deepEqual(Object.fromEntries(h.files), initial);
  assert.deepEqual(h.writes, []);
});

test('a changed project identity blocks the Page mutation', async t => {
  const h = harness(t, { 'main.tex': 'original' });
  h.win._ide.project._id = 'other-project';
  const result = await h.apply(h.snapshot().files, [{ type: 'edit', path: 'main.tex', replaceAll: 'new' }]);
  assert.equal(result.ok, false);
  assert.equal(h.files.get('main.tex'), 'original');
  assert.deepEqual(h.writes, []);
});

test('an editor readback mismatch cannot become a successful write', async t => {
  const h = harness(t, { 'main.tex': 'original' }, { corruptWrite: true });
  const result = await h.apply(h.snapshot().files, [{ type: 'edit', path: 'main.tex', replaceAll: 'new' }]);
  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped[0].result.failure.changedDocument, true);
  assert.notEqual(h.files.get('main.tex'), 'new');
});

test('Track Accept uses persisted ownership after refresh and preserves text and unrelated changes', async t => {
  const content = 'before edited\n';
  const h = harness(t, { 'main.tex': content }, { changes: { 'main.tex': [
    { id: 'owned', op: { p: 6, i: ' edited' } }, { id: 'collaborator', op: { p: 0, d: 'removed text' } }
  ] } });
  const owned = h.refs().filter(ref => ref.id === 'owned');
  const unrelated = h.refs().filter(ref => ref.id === 'collaborator');
  assert.equal(owned.length, 1);
  const checkpoint = JSON.parse(JSON.stringify({ runProjectId: PROJECT, trackedChanges: owned,
    expectedFiles: [{ path: 'main.tex', content: 'before\n' }],
    postFiles: [{ path: 'main.tex', content }] }));
  const accepted = await h.router.acceptTrackedChanges(checkpoint);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(h.files.get('main.tex'), content);
  assert.deepEqual(h.refs(), unrelated);
  assert.deepEqual(h.writes, [], 'Accept cannot rewrite the document to clear unrelated tracking');
});
