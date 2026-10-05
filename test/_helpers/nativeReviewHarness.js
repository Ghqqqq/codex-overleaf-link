'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const Client = require(path.join(root, 'extension/src/content/pageBridgeClient'));
const Contract = require(path.join(root, 'extension/src/shared/pageRpcContract'));
const Compatibility = require(path.join(root, 'extension/src/shared/compatibility'));
const Capability = require(path.join(root, 'extension/src/page/pageBridgeCapability'));
const Router = require(path.join(root, 'extension/src/page/writebackRouter'));
const Capture = require(path.join(root, 'extension/src/page/trackedChangeCapture'));
const Lifecycle = require(path.join(root, 'extension/src/page/trackedChangesLifecycle'));
const StaleGuard = require(path.join(root, 'extension/src/shared/staleGuard'));
const WriteGuard = require(path.join(root, 'extension/src/page/writeGuard'));
const ProjectFiles = require(path.join(root, 'extension/src/shared/projectFiles'));
const Journal = require(path.join(root, 'extension/src/page/writebackReceiptJournal'));
const Save = require(path.join(root, 'extension/src/page/saveState'));
const Tree = require(path.join(root, 'extension/src/page/treeOperations'));
const { extractFunction } = require(path.join(root, 'test/_helpers/extractFunction'));
const pageSource = fs.readFileSync(path.join(root, 'extension/src/pageBridge.js'), 'utf8');
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
async function drain() { for (let i = 0; i < 6; i++) await flush(); }
function clock() {
  let time = 1000000, sequence = 0;
  const timers = new Map();
  const result = { get now() { return time; },
    setTimeout(fn, ms) { const id = ++sequence; timers.set(id, { fn, at: time + Math.max(0, Number(ms) || 0) }); return id; },
    clearTimeout(id) { timers.delete(id); },
    sleep(ms) { return new Promise(resolve => result.setTimeout(resolve, ms)); },
    clear() { timers.clear(); }, count: () => timers.size,
    async next() {
      await drain();
      const pair = [...timers.entries()].sort((a,b) => a[1].at - b[1].at || a[0] - b[0])[0];
      assert.ok(pair, 'fixture has no pending timer while awaiting progress');
      timers.delete(pair[0]); time = pair[1].at; pair[1].fn(); await drain();
    },
    async until(predicate, max = 12000) { for (let i = 0; i < max; i++) { await drain(); if (predicate()) return; await result.next(); } throw new Error('synthetic clock step bound exceeded'); },
    async settle(promise) {
      let outcome;
      promise.then(value => { outcome = { value }; }, error => { outcome = { error }; });
      await result.until(() => outcome);
      if (outcome.error) throw outcome.error;
      return outcome.value;
    }
  };
  return result;
}

function createReviewFixture(t, options = {}) {
  const timer = clock(); t.mock.method(Date, 'now', () => timer.now);
  const files = options.files || [{ path: 'main.tex', before: 'aold', content: 'aNEWold', changes: [
    { id: 'owned', op: { p: 1, i: 'NEW' } }, { id: 'unrelated', op: { p: 4, i: 'old' } }
  ] }];
  const docs = new Map(files.map((file,index) => [file.path, { ...plain(file), id: 'synthetic-doc-' + index }]));
  const state = { projectId: 'project-one', active: files[0].path, reviewing: options.reviewing !== false,
    reads: [], opens: [], writes: [], dispatches: [], fetches: [], events: [], results: [], sourceEdits: 0, cancelCalls: 0 };
  if (options.navigationDelays) Object.assign(state, { editorActive: files[0].path, ledgerActive: files[0].path });
  const listeners = new Set(), posted = [], views = new Map();
  const document = { querySelector: selector => selector === 'meta[name="ol-csrfToken"]'
    ? { getAttribute: () => '"synthetic-csrf-token"' } : null };
  const window = { document, location: { origin: 'https://www.overleaf.com', pathname: '/project/project-one' },
    _ide: { project: { get _id() { return state.projectId; } } }, crypto: webcrypto, AbortController,
    setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout, queueMicrotask,
    addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
    postMessage(data, origin) {
      assert.equal(origin, window.location.origin);
      posted.push({ at: timer.now, ...plain(data) });
      queueMicrotask(() => { for (const listener of [...listeners]) void listener({ source: window, origin, data }); });
    },
    CodexOverleafPageBridgeCapability: Capability, CodexOverleafTrackedChangeCapture: Capture,
    CodexOverleafTrackedChangesLifecycle: Lifecycle, CodexOverleafStaleGuard: StaleGuard,
    CodexOverleafWriteGuard: WriteGuard, CodexOverleafProjectFiles: ProjectFiles,
    async fetch(url, init) {
      const body = JSON.parse(init.body); state.fetches.push({ at: timer.now, url, changeIds: body.change_ids });
      assert.equal(init.method, 'POST'); assert.equal(init.credentials, 'same-origin'); assert.equal(init.redirect, 'error');
      const file = docs.get(state.active);
      file.changes = file.changes.filter(change => !body.change_ids.includes(change.id));
      return { ok: true, status: 200 };
    }
  };
  for (const [filePath, file] of docs) {
    views.set(filePath, {
      get state() { const ledger = docs.get(state.ledgerActive) || file;
        return { doc: { toString: () => file.content, get length() { return file.content.length; } },
          values: [{ ranges: { docId: ledger.id, changes: ledger.changes || [], comments: [] }, threads: {} }] }; },
      dispatch(transaction) {
        state.dispatches.push({ at: timer.now, path: filePath, transaction: plain(transaction) });
        for (const change of [...transaction.changes].sort((a,b) => b.from - a.from)) {
          file.content = file.content.slice(0, change.from) + change.insert + file.content.slice(change.to);
        }
        if (options.merged) file.changes = [{ id: 'prior', op: { p: 0, i: 'old' } }];
      }
    });
  }
  const no = () => {};
  const context = vm.createContext({ window, pageRpcContract: Contract,
    PAGE_BRIDGE_CAPABILITY_METHOD: 'initializeCapability', PAGE_BRIDGE_INSTALL_VERSION: Compatibility.BUILD_TARGET_VERSION,
    PAGE_BRIDGE_INSTALL_REVISION: Contract.REVISION, pageBridgeCapabilityGuard: Capability.create(),
    writeCancellationSequence: 0, probe: no, withSnapshotCacheIdentity: value => value,
    referenceProjects: {}, createCheckpoint: no, getSelectionContext: no, binaryAssetUploader: {}, jumpToPosition: no,
    getCompileLog: no, waitForSaveState: no, otObserver: {}, sanitizeOtEventForContent: value => value,
    textFileCreator: { cancelVerifications() { state.cancelCalls++; }, ensureWriteMode: no },
    snapshotRouter: { cancelWritebackReads() { state.cancelCalls++; } },
    projectSnapshotBridge: { getProjectSnapshot: async () => ({ id: state.projectId, files: [...docs.values()] }) },
    compileBridge: { markSourceEdited() { state.sourceEdits++; } } });
  for (const name of ['bumpWriteCancellationSequence','readWriteCancellationSequence']) vm.runInContext(extractFunction(pageSource, name), context);
  const current = () => docs.get(state.editorActive || state.active);
  let tree = { getProjectId: () => state.projectId, getActiveFilePath: () => state.active,
    projectPathExists: filePath => docs.has(filePath),
    async openFileByPath(filePath, config = {}) {
      if (!docs.has(filePath)) return { ok: false };
      if (state.active !== filePath || config.force) {
        state.opens.push({ at: timer.now, path: filePath }); await timer.sleep(options.navigationMs || 1);
        state.active = filePath;
        options.onOpen?.({ path: filePath, state, docs });
      }
      return { ok: true, method: 'synthetic-bounded-navigation' };
    }
  };
  const identity = () => views.get(state.editorActive || state.active);
  const readText = () => { state.reads.push({ at: timer.now, path: state.active }); return current()?.content; };
  if (options.navigationDelays) {
    // Exercise production TreeOperations' manager navigation: selected path
    // can become ready before the editor document and native ledger settle.
    document.querySelectorAll = () => [];
    window._ide.fileTreeManager = { async openDoc(target) {
      const file = docs.get(target) || [...docs.values()].find(item => item.id === target);
      if (!file) throw new Error('unknown fixture tree target');
      const targetPath = file.path;
      state.active = targetPath; state.opens.push({ at: timer.now, path: targetPath });
      timer.setTimeout(() => { state.editorActive = targetPath; }, options.navigationDelays.text);
      timer.setTimeout(() => { state.ledgerActive = targetPath; }, options.navigationDelays.ledger);
      options.onOpen?.({ path: targetPath, state, docs });
    } };
    tree = Tree.create({ window, document, normalizePath: ProjectFiles.normalizeSafeProjectPath,
      getActiveFilePathFromEditorStore: () => state.active, readActiveEditorText: readText,
      getActiveEditorIdentity: identity, activeEditorIdentityChanged: previous => previous !== identity() });
  }
  const undoControl = { tagName: 'BUTTON', disabled: false,
    getAttribute: name => name === 'aria-label' ? 'Undo' : null };
  const router = Router.create({ window, now: () => timer.now, treeOperations: tree, writebackOpenSettleMs: 0,
    normalizeSafeProjectPath: ProjectFiles.normalizeSafeProjectPath,
    getCodeMirrorEditorView: identity, getTrackedChangeDocumentId: filePath => docs.get(filePath)?.id || '',
    readWriteCancellationSequence: () => context.readWriteCancellationSequence(),
    readActiveEditorText: readText, getActiveEditorIdentity: identity, activeEditorIdentityChanged: prior => prior !== identity(),
    replaceActiveEditorText(content) { state.writes.push({ at: timer.now, path: state.active, content }); current().content = content;
      options.onWrite?.({ path: state.active, state, docs }); return { ok: true }; },
    replaceActiveEditorPatches(patches, content) { state.writes.push({ at: timer.now, path: state.active, content, patches: plain(patches) }); current().content = content;
      options.onWrite?.({ path: state.active, state, docs }); return { ok: true }; },
    getReviewingState: () => ({ reviewing: { ok: state.reviewing }, editorMode: state.reviewing ? 'reviewing' : 'editing', signals: {} }),
    isEditingConfirmedForNoTraceUndo: value => value.reviewing.ok === false,
    isReviewingConfirmedForWrite: value => value.reviewing.ok === true,
    setReviewingEnabled: async enabled => { state.reviewing = enabled; return { ok: true, enabled }; },
    ensureEditing: async () => { state.reviewing = false; return { ok: true }; },
    ensureReviewing: async () => { state.reviewing = true; return { ok: true }; },
    collectElements: selector => /button/i.test(selector) && options.editorUndoPaths?.includes(state.active) ? [undoControl] : [],
    isInsideCodexPanel: () => false, readNodeSignalText: node => node === undoControl ? 'Undo' : node.textContent || '',
    clickNode(node) {
      assert.equal(node, undoControl);
      (state.editorUndos ||= []).push(state.active);
      current().content = current().before;
      current().changes = [];
    },
    delay: timer.sleep, compileBridge: context.compileBridge,
    waitForSaveState: async () => ({ ok: true, state: 'verified_saved' }),
    confirmReviewWriteback: (params, result) => Save.confirmReviewWriteback({ params, result,
      now: () => timer.now, delay: timer.sleep, getProjectId: () => state.projectId,
      readSnapshot: async () => ({ ok: true, files: [...docs.values()].map(file => ({ path: file.path, content: file.content, source: 'overleaf-zip' })) })
    })
  });
  const capture = Capture.create({ getCodeMirrorEditorView: identity, getTrackedChangeDocumentId: filePath => docs.get(filePath)?.id || '',
    getProjectId: () => state.projectId, getActiveFilePath: () => state.active, readActiveEditorText: readText,
    normalizeSafeProjectPath: ProjectFiles.normalizeSafeProjectPath, now: () => timer.now, delay: timer.sleep,
    collectElements: () => [], compact: value => String(value), isInsideCodexPanel: () => false, readNodeSignalText: () => '' });
  Object.assign(context, { writebackRouter: router,
    writeGuard: WriteGuard.create({ window, treeOperations: tree, sleep: timer.sleep }),
    writebackReceipts: Journal.create({ now: () => timer.now, getProjectId: () => state.projectId,
      prepareEditor: async () => ({ ok: true }), applyOperations: (operations, config) => router.applyOperations(operations, config) }) });
  for (const name of ['rejectTrackedChanges','acceptTrackedChanges','dispatch']) vm.runInContext(extractFunction(pageSource, name), context);
  function declaration(marker, end) {
    const start = pageSource.indexOf(marker); assert.ok(start >= 0);
    const finish = pageSource.indexOf(end, start); assert.ok(finish > start);
    return pageSource.slice(start, finish + end.length);
  }
  vm.runInContext(declaration('  const pageRpcHandlers = {', '\n  };'), context);
  vm.runInContext(declaration('  const pageBridgeMessageHandler = async event => {', '\n  };')
    + '\nwindow.addEventListener("message", pageBridgeMessageHandler);', context);
  let uuid = 0, cancel = false;
  const client = Client.create({ window, now: () => timer.now, contract: Contract, compatibility: Compatibility,
    crypto: { randomUUID: () => 'synthetic-rpc-capability-' + (++uuid) }, isCancellationRequested: () => cancel });
  const rpc = (method, params) => client.send(method, params, Contract.resolveDispatchPolicy(method));
  const ready = () => timer.settle(rpc('initializeCapability', {}));
  return { timer, state, docs, window, context, router, capture, client, rpc, posted, ready,
    requestParams() { return { runProjectId: 'project-one', expectedFiles: files.map(file => ({ path: file.path, content: file.before })),
      postFiles: files.map(file => ({ path: file.path, content: file.content })),
      trackedChanges: capture.prepareTrackedChangeCapture(state.active).refs.filter(ref => ref.id !== 'unrelated') }; },
    setCancelled(value) { cancel = value; },
    close() { timer.clear(); listeners.clear(); }
  };
}
module.exports = { root, plain, drain, clock, createReviewFixture };
