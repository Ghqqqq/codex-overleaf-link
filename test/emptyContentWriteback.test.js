const assert = require('node:assert/strict');
const test = require('node:test');
const projectFiles = require('../extension/src/shared/projectFiles');
const staleGuard = require('../extension/src/shared/staleGuard');
const writebackController = require('../extension/src/content/writebackController');
const writebackRouter = require('../extension/src/page/writebackRouter');
const editorAdapter = require('../extension/src/page/overleafEditor');
const writeGuard = require('../extension/src/page/writeGuard');
const { computeTextPatches } = require('../native-host/src/textPatch');

// The editor view and navigation are I/O fixtures. The controller, guard,
// freshness check, router, editor adapter and readback remain production code.
function createHarness(initialContent) {
  let content = initialContent;
  let dispatches = 0;
  const doc = { toString: () => content, get length() { return content.length; } };
  const view = { state: { doc }, dispatch({ changes }) {
    dispatches++;
    for (const change of (Array.isArray(changes) ? changes : [changes]).slice().sort((a, b) => b.from - a.from)) {
      content = content.slice(0, change.from) + change.insert + content.slice(change.to);
    }
  } };
  const adapter = editorAdapter.create({
    getCodeMirrorEditorView: () => view,
    getCodeMirrorDocText: editor => editor.state.doc.toString(),
    getCodeMirrorDocLength: editor => editor.state.doc.length,
    normalizeTextPatches: patches => ({ ok: true, patches: writebackController.normalizeTextPatches(patches) })
  });
  const router = writebackRouter.create({
    ...adapter, getActiveEditorIdentity: () => ({ type: 'codemirror-view', view, doc }),
    activeEditorIdentityChanged: () => false, writebackOpenSettleMs: 0,
    ensureEditing: async () => ({ ok: true }),
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    treeOperations: {
      getActiveFilePath: () => 'main.tex', getProjectId: () => 'empty-content-project',
      openFileByPath: async () => ({ ok: true, method: 'already-active' })
    },
    window: { _ide: { project: { _id: 'empty-content-project' } },
      CodexOverleafStaleGuard: staleGuard, CodexOverleafWriteGuard: writeGuard, setTimeout, clearTimeout }
  });
  return { read: () => content, dispatches: () => dispatches,
    apply: (baseline, operation) => router.applyOperations({ runProjectId: 'empty-content-project',
      requireEditing: true, baseFiles: [{ path: 'main.tex', content: baseline }], operations: [operation] }) };
}

for (const baseline of ['', ' \t\n']) {
  test('blank baseline rejects stale replaceAll without dispatch: ' + JSON.stringify(baseline), async () => {
    const h = createHarness('collaborator text');
    const [operation] = writebackController.buildSyncApplyOperations([
      { type: 'write', path: 'main.tex', content: 'model text' }
    ], { files: [{ path: 'main.tex', content: baseline }] });
    assert.equal(operation.replaceAll, 'model text', 'exercise the supported whole-file fallback');
    const result = await h.apply(baseline, operation);
    assert.equal(h.read(), 'collaborator text');
    assert.equal(h.dispatches(), 0);
    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped[0].result.failure.code, 'stale_source_changed');
  });

  test('unchanged blank file remains writable: ' + JSON.stringify(baseline), async () => {
    const h = createHarness(baseline);
    const result = await h.apply(baseline, { type: 'edit', path: 'main.tex', replaceAll: 'new text' });
    assert.equal(result.ok, true);
    assert.equal(result.applied[0].result.verified, true);
    assert.equal(h.read(), 'new text');
    assert.equal(h.dispatches(), 1);
  });
}

test('nonempty stale baseline keeps its whole-file protection', async () => {
  const h = createHarness('later text');
  const result = await h.apply('earlier text', { type: 'edit', path: 'main.tex', replaceAll: 'new text' });
  assert.equal(result.skipped[0].result.failure.code, 'stale_source_changed');
  assert.equal(h.read(), 'later text');
  assert.equal(h.dispatches(), 0);
});

test('blank baseline still checks conflicting patch anchors', async () => {
  const h = createHarness('later text');
  const result = await h.apply('   ', { type: 'edit', path: 'main.tex', patches: computeTextPatches('   ', 'new text') });
  assert.equal(result.skipped[0].result.failure.code, 'patch_anchor_not_found');
  assert.equal(h.read(), 'later text');
  assert.equal(h.dispatches(), 0);
});

test('empty-baseline insertion patch retains nonconflicting later text', async () => {
  const h = createHarness('later text');
  const [operation] = writebackController.buildSyncApplyOperations([
    { type: 'write', path: 'main.tex', previousContent: '', content: 'prefix ', patches: computeTextPatches('', 'prefix ') }
  ], { files: [{ path: 'main.tex', content: '' }] });
  const result = await h.apply('', operation);
  assert.equal(result.ok, true);
  assert.equal(result.applied[0].result.verified, true);
  assert.equal(h.read(), 'prefix later text');
  assert.equal(h.dispatches(), 1);
});
