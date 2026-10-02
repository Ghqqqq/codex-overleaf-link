'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const Creator = require('../extension/src/page/textFileCreator');
const Router = require('../extension/src/page/writebackRouter');
const StaleGuard = require('../extension/src/shared/staleGuard');
const ProjectFiles = require('../extension/src/shared/projectFiles');

function harness(options = {}) {
  const target = 'qa/nested/probe.tex', expected = '% generated\n';
  const files = new Map([['main.tex', 'unchanged'], ...(options.absent ? [] : [[target, options.serverConflict ? 'collaborator' : expected]])]);
  const state = { project: 'qa-project', active: 'main.tex', clock: 0, cancellation: 0,
    outer: options.open === true || options.innerOnly === true, inner: options.open === true,
    selected: null, menu: null, dialog: null, deletes: 0, reads: 0, opened: [], expanded: [], id: 'probe-id' };
  const visible = props => Object.defineProperties({ disabled: false, getClientRects: () => [{}], getAttribute: () => '' }, Object.getOwnPropertyDescriptors(props));
  const button = (name, click) => visible({ textContent: name, click });
  const text = () => state.active === target && options.clientConflict ? 'unsaved collaborator edit' : files.get(state.active) || '';
  let row;
  const leaf = visible({ textContent: 'probe.tex', getBoundingClientRect: () => ({ left: 0, top: 0, width: 30, height: 20 }),
    click() { state.selected = row; state.active = target; },
    dispatchEvent(event) {
      if (event.type !== 'contextmenu') return;
      state.menu = visible({ closest: () => null, querySelectorAll: () => [
        button('Delete', () => {
          state.menu = null;
          state.dialog = visible({ querySelectorAll(selector) {
            if (selector === 'li') return [visible({ textContent: options.wrongDialog ? 'main.tex' : 'probe.tex' })];
            return [button('Cancel', () => { state.dialog = null; }),
              button('Delete', () => { state.deletes++; files.delete(target); state.dialog = null; })];
          } });
        })
      ] });
    } });
  row = visible({ closest: () => row,
    querySelector(selector) {
      if (selector === '[data-file-type="doc"][data-file-id]') return { getAttribute: () => state.id };
      if (selector.includes('.file-tree-entity-details') || selector.includes('.item-name')) return leaf;
      return null;
    } });
  const group = children => ({ children, getAttribute: name => name === 'role' ? 'tree' : '' });
  const innerGroup = () => group(files.has(target) ? [row] : []);
  const folder = (name, flag, child) => visible({
    getAttribute: attr => ({ role: 'treeitem', 'aria-label': name, 'aria-expanded': String(state[flag]) }[attr] || ''),
    get nextElementSibling() { return state[flag] ? child() : null; },
    querySelector(selector) {
      if (selector === '[data-file-type="folder"]') return {};
      if (selector === '.folder-expand-collapse-button') return button(name, () => { state[flag] = true; state.expanded.push(name); });
      return null;
    }
  });
  const inner = folder('nested', 'inner', innerGroup);
  const outerGroup = () => group([inner, ...(state.inner ? [innerGroup()] : [])]);
  const outer = folder('qa', 'outer', outerGroup);
  const root = () => group([outer, ...(state.outer ? [outerGroup()] : [])]);
  const inTree = path => path === target && files.has(target) && state.outer && state.inner;
  const document = {
    querySelector: selector => selector.includes('file-tree-list-root') ? root() : null,
    querySelectorAll(selector) {
      if (selector === '[role="dialog"]') return state.dialog ? [state.dialog] : [];
      if (selector === '[role="menu"]') return state.menu ? [state.menu] : [];
      if (selector.includes('aria-selected')) return state.selected ? [state.selected] : [];
      return [];
    }
  };
  const views = new Map(['main.tex', target].map(path => [path, { state: {
    doc: { toString: text, get length() { return text().length; } },
    values: [{ ranges: { docId: path === target ? 'probe-id' : 'main-id', changes: [], comments: [] }, threads: {} }]
  } }]));
  const tree = { getProjectId: () => state.project, getActiveFilePath: () => state.active,
    projectPathExists: inTree, findFileTreeNode: path => inTree(path) ? row : null,
    invalidateDomProjectPathCache() {}, collectProjectTextPaths: () => ['main.tex', ...(inTree(target) ? [target] : [])],
    async openFileByPath(path) {
      if (!inTree(path)) return { ok: false, reason: 'The folded path is not mounted in the tree.' };
      state.opened.push(path); state.active = path;
      if (options.projectChange) state.project = 'another-project';
      if (options.cancelOnOpen) state.cancellation++;
      return { ok: true };
    }
  };
  const window = { document, CodexOverleafProjectFiles: ProjectFiles, CodexOverleafStaleGuard: StaleGuard,
    setTimeout: (callback, ms = 0) => setImmediate(() => { state.clock += ms; callback(); }),
    clearTimeout: clearImmediate, MouseEvent: class { constructor(type) { this.type = type; } } };
  const creator = Creator.create({ window, document, treeOperations: tree, now: () => state.clock,
    readActiveEditorText: text, readWriteCancellationSequence: () => state.cancellation,
    snapshotRouter: { invalidateCache() {}, async fetchProjectZipSnapshot() {
      state.reads++;
      if (options.replaceIdentity && state.reads === 2) state.id = 'replacement-id';
      return { ok: true, files: [...files].map(([path, content]) => ({ path, content })) };
    } }
  });
  const router = Router.create({ window, treeOperations: tree, now: () => state.clock,
    deleteTextFile: creator.deleteFile, readActiveEditorText: text, writebackOpenSettleMs: 0,
    getCodeMirrorEditorView: () => views.get(state.active),
    getTrackedChangeDocumentId: path => path === target ? 'probe-id' : 'main-id',
    getActiveEditorIdentity: () => views.get(state.active),
    activeEditorIdentityChanged: previous => previous !== views.get(state.active),
    readWriteCancellationSequence: () => state.cancellation,
    getReviewingState: () => ({ reviewing: { ok: false } }),
    isEditingConfirmedForNoTraceUndo: value => value.reviewing.ok === false,
    delay: async ms => { state.clock += ms; } });
  return { state, files, target, undo: () => router.applyOperations({
    runProjectId: 'qa-project', deadlineAt: 120000, reviewingPolicy: 'no-trace-undo',
    baseFiles: [{ path: target, content: expected }],
    operations: [{ type: 'delete', path: target, undoCreatedFile: { v: 1, kind: 'text' } }]
  }) };
}
for (const options of [{}, { innerOnly: true }, { open: true }]) {
  test('server-proven text can be checked and deleted regardless of folded UI: ' + JSON.stringify(options), async () => {
    const h = harness(options), result = await h.undo();
    assert.equal(result.applied.length, 1, JSON.stringify(result));
    assert.equal(result.skipped.length, 0);
    assert.equal(result.applied[0].result.verification, 'overleaf-zip');
    assert.deepEqual(h.state.opened, [h.target]);
    assert.equal(h.state.deletes, 1);
    assert.equal(h.files.has(h.target), false);
    assert.equal(h.files.get('main.tex'), 'unchanged');
    assert.deepEqual(h.state.expanded, options.open ? [] : options.innerOnly ? ['nested'] : ['qa', 'nested']);
  });
}
test('a genuinely absent created file needs no editor opening or folder expansion', async () => {
  const h = harness({ absent: true }), result = await h.undo();
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].result.idempotent, true);
  assert.equal(result.applied[0].result.changedDocument, false);
  assert.equal(h.state.deletes, 0);
  assert.deepEqual(h.state.opened, []);
  assert.deepEqual(h.state.expanded, []);
});
for (const option of ['serverConflict', 'clientConflict', 'projectChange', 'cancelOnOpen', 'wrongDialog', 'replaceIdentity']) {
  test('folded-file preparation keeps the existing guard: ' + option, async () => {
    const h = harness({ [option]: true }), result = await h.undo();
    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].result.changedDocument, false);
    assert.equal(h.state.deletes, 0);
    assert.equal(h.files.has(h.target), true);
    assert.equal(h.files.get('main.tex'), 'unchanged');
    if (option === 'projectChange') assert.equal(result.skipped[0].result.code, 'aborted_project_changed');
    if (option === 'cancelOnOpen') assert.equal(result.skipped[0].result.code, 'codex_cancelled');
    if (option === 'clientConflict') assert.deepEqual(h.state.opened, [h.target]);
    if (option === 'serverConflict') assert.deepEqual(h.state.expanded, []);
    if (option === 'wrongDialog') assert.match(result.skipped[0].result.reason, /exactly the authorized file/);
    if (option === 'replaceIdentity') assert.match(result.skipped[0].result.reason, /changed before confirmation/);
  });
}
