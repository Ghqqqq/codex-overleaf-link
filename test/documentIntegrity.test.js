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
    ensureReviewing: options.ensureReviewing || (async () => { reviewing = true; return { ok: true }; }),
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

const Reviewing = require('../extension/src/shared/reviewing');
const Failures = require('../extension/src/shared/failureReasons');
const Snapshots = require('../extension/src/shared/runExecutionSnapshot');
const State = require('../extension/src/shared/sessionState');
const Migration = require('../extension/src/shared/storageMigration');
const fs = require('node:fs');
const vm = require('node:vm');

// Minimal external DOM fixture. Production owns modal detection, polling, dismissal,
// dialog choices and policy. Real selector matching still needs browser acceptance.
function reviewingDom() {
  class Element extends EventTarget {
    constructor(tag, doc) { super(); this.tagName = tag; this.ownerDocument = doc; this.children = []; this.dataset = {}; this.attrs = {}; this.isConnected = true; }
    append(...children) { this.children.push(...children); for (const child of children) child.parent = this; }
    setAttribute(key, value) { this.attrs[key] = value; }
    getAttribute(key) { return this.attrs[key]; }
    getClientRects() { return this.isConnected ? [{}] : []; }
    closest() { return this.modal || null; }
    querySelector(selector) { return selector.includes('.modal-header') ? this.closeButton : null; }
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    click() { this.dispatchEvent(new Event('click')); }
    focus() { this.ownerDocument.activeElement = this; }
    showModal() {}
    close() { this.dispatchEvent(new Event('close')); }
  }
  const doc = new EventTarget();
  doc.createElement = tag => new Element(tag, doc);
  doc.defaultView = { getComputedStyle: () => ({}), KeyboardEvent: class extends Event { constructor(type, props) { super(type); this.key = props.key; } } };
  const panel = doc.createElement('aside'), modal = doc.createElement('div'), body = doc.createElement('div');
  body.modal = modal;
  modal.isConnected = false;
  modal.closeButton = doc.createElement('button');
  modal.closeButton.addEventListener('click', () => { modal.isConnected = false; });
  doc.querySelectorAll = () => modal.isConnected ? [body] : [];
  const globals = { window: {}, document: doc, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.runInNewContext(fs.readFileSync(require.resolve('../extension/src/content/panelRenderer'), 'utf8'), globals);
  const confirm = globals.window.CodexOverleafPanelRenderer.createConfirmController({ getPanel: () => panel });
  return { doc, panel, modal, confirm, buttons: () => panel.children[0].children[0].children[2].children };
}
function pageModeFixture(dom, { existingModal = false, escapeOnly = false } = {}) {
  let clicks = 0, menuOpen = false;
  dom.modal.isConnected = existingModal;
  if (escapeOnly) {
    dom.modal.closeButton = null;
    dom.modal.addEventListener('keydown', event => { if (event.key === 'Escape') dom.modal.isConnected = false; });
  }
  const control = {}, option = {};
  const deps = { document: dom.doc, assertCurrent() {}, delay: async () => {},
    getState: () => ({ reviewing: { ok: false } }), isConfirmed: () => false,
    findControls: () => [control], findOption: () => menuOpen ? option : null,
    click(node) { clicks++; if (node === control) menuOpen = true; else dom.modal.isConnected = true; },
    buildFailure: (code, overrides) => ({ ...Failures.normalizeFailureReason({ code }), ...overrides }) };
  return { toggle: () => Reviewing.toggleMode(true, { waitMs: 240 }, deps), clicks: () => clicks, deps };
}

test('Page mode activation stops at the upgrade modal, dismisses only it and preserves the canonical failure', async () => {
  for (const options of [{}, { existingModal: true }, { escapeOnly: true }]) {
    const dom = reviewingDom(), page = pageModeFixture(dom, options);
    const creator = require('../extension/src/page/textFileCreator').create({
      window: {}, document: dom.doc, treeOperations: {},
      findUpgradeModal: () => Reviewing.findUpgradeModal(dom.doc), ensureReviewing: page.toggle,
      collectElements() { throw new Error('An existing paywall must be handled before editor preparation'); }
    });
    const result = options.existingModal ? await creator.ensureWriteMode(true, { runProjectId: PROJECT }) : await page.toggle();
    assert.equal(result.code, 'reviewing_unavailable');
    assert.deepEqual(result.evidence, { upgradeModal: true, dismissed: true });
    assert.equal(result.failure.stage, 'reviewing');
    assert.equal(result.failure.retryable, false);
    assert.equal(result.failure.changedDocument, false);
    assert.equal(page.clicks(), options.existingModal ? 0 : 2);
    assert.equal(dom.modal.isConnected, false);
    assert.equal(dom.panel.isConnected, true);
  }
});

test('a Page upgrade failure reaches each blocked write unchanged and never mutates document bytes', async t => {
  const dom = reviewingDom(), page = pageModeFixture(dom, { existingModal: true });
  // No working close control: failure must retain the unsuccessful dismissal evidence.
  dom.modal.closeButton = null;
  const pageResult = await page.toggle();
  assert.equal(pageResult.evidence.dismissed, false);
  const h = harness(t, { 'main.tex': 'original' }, { ensureReviewing: async params => {
    assert.equal(params.runProjectId, PROJECT);
    return pageResult;
  } });
  const result = await h.apply(h.snapshot().files, [{ type: 'edit', path: 'main.tex', replaceAll: 'new' }], { requireReviewing: true });
  assert.equal(result.ok, false);
  assert.equal(result.skipped[0].result.code, 'reviewing_unavailable');
  assert.deepEqual(result.skipped[0].result.evidence, pageResult.evidence);
  assert.deepEqual(result.skipped[0].result.failure, pageResult.failure);
  assert.deepEqual(h.writes, []);
  assert.equal(page.clicks(), 0);
});

const policyChoices = [{ value: 'continue', label: 'Continue' }, { value: 'disable', label: 'Disable' }, { value: 'cancel', label: 'Cancel' }];

test('unavailable Track Cancel, dismissal and timeout do not dispatch a write or lower the run policy', async t => {
  const h = harness(t, { 'main.tex': 'original' });
  for (const choice of ['cancel', 'dismiss', 'timeout']) {
    const dom = reviewingDom(), page = pageModeFixture(dom);
    let snapshot = Snapshots.create({ mode: 'auto', requireReviewing: true });
    let lowers = 0;
    const result = await Reviewing.resolveWritePolicy({ requireReviewing: true }, {
      assertCurrent() {}, ensureMode: page.toggle, observe() {}, applyUntracked() { lowers++; },
      choose: () => {
        const promise = dom.confirm.show({ choices: policyChoices, timeoutMs: choice === 'timeout' ? 5 : 1000 });
        if (choice === 'cancel') dom.buttons()[2].click();
        if (choice === 'dismiss') dom.confirm.dismiss();
        return promise;
      }
    });
    if (result.ok) await h.apply(h.snapshot().files, [{ type: 'edit', path: 'main.tex', replaceAll: 'new' }]);
    assert.equal(result.code, 'reviewing_unavailable');
    assert.equal(snapshot.requireReviewing, true);
    assert.equal(lowers, 0);
    assert.equal(dom.confirm.isOpen(), false);
  }
  assert.deepEqual(h.writes, []);
  assert.equal(h.files.get('main.tex'), 'original');
});

test('an explicit untracked choice persists the effective policy and keeps an ordinary recoverable Undo checkpoint', async t => {
  const h = harness(t, { 'main.tex': 'original' }), before = h.snapshot();
  const dom = reviewingDom(), page = pageModeFixture(dom);
  let snapshot = Snapshots.create({ mode: 'auto', requireReviewing: true });
  const record = { id: 'untracked-run', ...Snapshots.toRunCompatibilityTuple(snapshot) };
  const submitted = snapshot, view = { recordId: record.id, executionSnapshot: snapshot };
  const checks = [];
  const result = await Reviewing.resolveWritePolicy({ requireReviewing: true }, {
    assertCurrent() {}, observe() {},
    ensureMode: required => { checks.push(required); return required ? page.toggle() : { ok: true }; },
    choose: () => {
      const promise = dom.confirm.show({ choices: policyChoices });
      dom.buttons()[0].click(); return promise;
    },
    applyUntracked(choice) { snapshot = Snapshots.applyUntrackedDecision(view, record, choice); }
  });
  assert.equal(result.ok, true);
  assert.equal(result.requireReviewing, false);
  assert.deepEqual(checks, [true, false]);
  assert.equal(submitted.requireReviewing, true);
  assert.equal(view.executionSnapshot.requireReviewing, false);
  assert.equal(record.requireReviewing, false);
  const restoredPolicy = State.normalizePanelState({ activeSessionId: 's', sessions: [{ id: 's', runs: [record] }] }).runs[0].executionSnapshot;
  assert.equal(restoredPolicy.requireReviewing, false);
  const applied = await h.apply(before.files, [{ type: 'edit', path: 'main.tex', replaceAll: 'new' }], {
    requireReviewing: restoredPolicy.requireReviewing, requireEditing: !restoredPolicy.requireReviewing
  });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const checkpoint = JSON.parse(JSON.stringify(Undo.buildUndoCheckpoint(before, applied.applied.map(entry => entry.operation))));
  assert.equal(checkpoint.undoOperations.length, 1);
  const undone = await h.apply(checkpoint.undoBaseFiles, Undo.buildSnapshotRestoreUndo(checkpoint).operations, { reviewingPolicy: 'no-trace-undo' });
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.equal(h.files.get('main.tex'), 'original');
});

test('run-bound choice abort or changed ownership cannot authorize an untracked write; boolean confirms stay boolean', async () => {
  const dom = reviewingDom(), abort = new AbortController();
  const pending = dom.confirm.show({ choices: policyChoices, signal: abort.signal });
  abort.abort();
  assert.equal(await pending, 'cancel');
  assert.equal(dom.confirm.isOpen(), false);
  const ordinary = dom.confirm.show();
  dom.buttons()[1].click();
  assert.equal(await ordinary, true);
  const cancelled = dom.confirm.show(); dom.confirm.dismiss(); assert.equal(await cancelled, false);
  let current = true, lowers = 0;
  await assert.rejects(Reviewing.resolveWritePolicy({ requireReviewing: true, knownUnavailable: true }, {
    assertCurrent() { if (!current) throw new Error('owner changed'); },
    ensureMode() { throw new Error('remembered unavailability must skip activation'); },
    observe() {}, choose() { current = false; return 'continue'; }, applyUntracked() { lowers++; }
  }), /owner changed/);
  assert.equal(lowers, 0);
});

test('Track capability memory scopes and expires failures; retry and positive evidence survive stale saves', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const store = {};
  const originalChrome = globalThis.chrome;
  t.after(() => { if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome; });
  globalThis.chrome = { storage: { local: {
    async get() { return structuredClone(store); }, async set(values) { Object.assign(store, structuredClone(values)); }
  } } };
  let state = {}, projectId = 'p1';
  const globals = { window: {}, Date };
  vm.runInNewContext(fs.readFileSync(require.resolve('../extension/src/content/projectSettingsCoordinator'), 'utf8'), globals);
  const coordinator = globals.window.CodexOverleafProjectSettingsCoordinator.create({
    getState: () => state, setState: next => { state = next; }, getCurrentProjectId: () => projectId, saveStateSoon() {}
  });
  coordinator.observeReviewingAvailability('unavailable', 'upgrade_modal');
  const unavailable = structuredClone(state.reviewingAvailabilityByProject);
  await Migration.savePrefs(state, 'account-a', projectId);
  const loaded = await Migration.loadPrefs('account-a', projectId);
  assert.equal(Reviewing.knownUnavailable(loaded.reviewingAvailabilityByProject.p1), true);
  assert.equal(Reviewing.knownUnavailable(loaded.reviewingAvailabilityByProject.p1, loaded.reviewingAvailabilityByProject.p1.observedAt + Reviewing.UNAVAILABLE_TTL_MS), false);
  assert.equal((await Migration.loadPrefs('account-b', projectId)).reviewingAvailabilityByProject.p1, undefined);
  assert.equal((await Migration.loadPrefs('account-a', 'p2')).reviewingAvailabilityByProject.p2, undefined);
  let activations = 0;
  const remembered = await Reviewing.resolveWritePolicy({ requireReviewing: true, knownUnavailable: true }, {
    assertCurrent() {}, ensureMode() { activations++; }, observe() {}, choose: () => 'cancel', applyUntracked() {}
  });
  assert.equal(remembered.code, 'reviewing_unavailable');
  assert.equal(activations, 0);

  // A retry is an observation, not a deletion. Even within the same millisecond
  // it must outrank the failure still held by another tab.
  coordinator.observeReviewingAvailability('unknown', 'user_retry');
  const retry = structuredClone(coordinator.getReviewingAvailability());
  assert.equal(retry.status, 'unknown');
  assert.equal(retry.evidence, 'user_retry');
  assert.ok(retry.observedAt > unavailable.p1.observedAt);
  assert.equal(Reviewing.knownUnavailable(retry), false);
  await Promise.all([
    Migration.savePrefs(state, 'account-a', projectId),
    Migration.savePrefs({ reviewingAvailabilityByProject: unavailable }, 'account-a', projectId)
  ]);
  assert.deepEqual((await Migration.loadPrefs('account-a', projectId)).reviewingAvailabilityByProject.p1, retry);

  now += 100;
  const available = await Reviewing.resolveWritePolicy({ requireReviewing: true,
    knownUnavailable: Reviewing.knownUnavailable(coordinator.getReviewingAvailability()) }, {
    assertCurrent() {}, ensureMode: async () => { activations++; return { ok: true }; },
    observe: coordinator.observeReviewingAvailability,
    choose() { throw new Error('positive evidence must not prompt'); }
  });
  assert.equal(activations, 1);
  assert.equal(available.requireReviewing, true);
  await Migration.savePrefs(state, 'account-a', projectId);
  assert.equal((await Migration.loadPrefs('account-a', projectId)).reviewingAvailabilityByProject.p1.status, 'available');
  unavailable.p1.observedAt -= 1000;
  await Migration.savePrefs({ reviewingAvailabilityByProject: unavailable }, 'account-a', projectId);
  assert.equal((await Migration.loadPrefs('account-a', projectId)).reviewingAvailabilityByProject.p1.status, 'available');

  now += 100;
  coordinator.observeReviewingAvailability('unavailable', 'upgrade_modal');
  coordinator.observeReviewingAvailability('unknown', 'user_retry');
  now += 100;
  let choices = 0;
  const stillUnavailable = await Reviewing.resolveWritePolicy({ requireReviewing: true,
    knownUnavailable: Reviewing.knownUnavailable(coordinator.getReviewingAvailability()) }, {
    assertCurrent() {}, ensureMode: async () => { activations++; return { ok: false, code: 'reviewing_unavailable' }; },
    observe: coordinator.observeReviewingAvailability,
    choose: () => { choices++; return 'cancel'; },
    applyUntracked() { throw new Error('Cancel must preserve the requested Track policy'); }
  });
  assert.equal(stillUnavailable.code, 'reviewing_unavailable');
  assert.equal(activations, 2);
  assert.equal(choices, 1);
  assert.equal(Reviewing.knownUnavailable(coordinator.getReviewingAvailability()), true);
  await Migration.savePrefs(state, 'account-a', projectId);
  await Migration.savePrefs({ reviewingAvailabilityByProject: { p1: retry } }, 'account-a', projectId);
  assert.equal((await Migration.loadPrefs('account-a', projectId)).reviewingAvailabilityByProject.p1.status, 'unavailable');
});
