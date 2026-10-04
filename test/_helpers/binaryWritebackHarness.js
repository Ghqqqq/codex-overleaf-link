'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const os = require('node:os');
const { deflateSync } = require('node:zlib');
const repo = path.resolve(__dirname, '../..');
const load = file => require(path.join(repo, file));
const read = file => fs.readFileSync(path.join(repo, file), 'utf8');
const Client = load('extension/src/content/pageBridgeClient');
const Contract = load('extension/src/shared/pageRpcContract');
const Capability = load('extension/src/page/pageBridgeCapability');
const Broker = load('extension/src/content/assetTransferBroker');
const Uploader = load('extension/src/page/binaryAssetUploader');
const Journal = load('extension/src/page/writebackReceiptJournal');
const Guard = load('extension/src/page/writeGuard');
const Router = load('extension/src/page/writebackRouter');
const Editor = load('extension/src/page/overleafEditor');
const Stale = load('extension/src/shared/staleGuard');
const Files = load('extension/src/shared/projectFiles');
const Plan = load('extension/src/content/writebackPlan');
const Controller = load('extension/src/content/writebackController');
const Settlement = load('extension/src/shared/writebackSettlement');
const Undo = load('extension/src/shared/undoOperations');
const Session = load('extension/src/shared/sessionState');
const Storage = load('extension/src/shared/storageDb');
const { extractFunction } = load('test/_helpers/extractFunction');
const pageSource = read('extension/src/pageBridge.js');
const runtimeSource = read('extension/src/content/contentRuntime.js');
const PROJECT = 'synthetic-original-project', TARGET = 'figure.png';
function png(red) {
  function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
  function chunk(type, data) { const name = Buffer.from(type), output = Buffer.alloc(data.length + 12);
    output.writeUInt32BE(data.length); name.copy(output, 4); data.copy(output, 8);
    output.writeUInt32BE(crc32(Buffer.concat([name, data])), output.length - 4); return output; }
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, red, 50, 90, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
const BEFORE = png(20), COLLAB = png(100), NEW = png(200);
const hash = value => value == null ? null : crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const noFetch = async () => { throw new Error('Network is forbidden in this fixture'); };
const noop = () => {};
let clock = 1000;

async function until(predicate, label) { for (let n = 0; n < 1000; n++) { if (predicate()) return; await tick(); } throw new Error('Fixture wait: ' + label); }

function recoveryProjection(project, result) {
  const record = { id: 'synthetic-run', runProjectId: PROJECT, task: 'synthetic fixture', status: 'completed' };
  const state = { requireReviewing: false, activeSessionId: 'synthetic-session', runs: [record],
    sessions: [{ id: 'synthetic-session', accountScopeId: 'synthetic-account', runs: [record], history: [] }] };
  const context = vm.createContext({ state, currentRunView: { recordId: record.id, sessionId: 'synthetic-session', executionSnapshot: { requireReviewing: false } },
    getAppliedEntries: result => Array.isArray(result?.applied) ? result.applied : [],
    getSkippedEntries: result => Array.isArray(result?.skipped) ? result.skipped : [],
    attachVerifiedContentToOperation: Settlement.attachVerifiedContentToOperation,
    normalizeApplyTrackedChanges: Settlement.normalizeApplyTrackedChanges,
    selectExpectedFilesForTrackedUndo: Settlement.selectExpectedFilesForTrackedUndo,
    buildUndoCheckpoint: Undo.buildUndoCheckpoint, buildCreatedFileUndoCheckpoint: Undo.buildCreatedFileUndoCheckpoint,
    findRunRecord: () => record, Modules: { UndoOperations: Undo }, refreshRunCardControls: noop, appendRunEvent: noop,
    tr: x => x, formatOperationType: x => x });
  vm.runInContext(extractFunction(runtimeSource, 'recordUndoFromApply'), context);
  context.recordUndoFromApply(project, result);
  const stored = Storage.buildSessionRecord({ ...state.sessions[0], projectId: PROJECT }, { preserveRunActionPayload: true });
  const restored = Session.normalizePanelState({ sessions: [stored], activeSessionId: stored.id }).sessions[0];
  return { record: clone(record), storedRun: clone(stored.runs[0]), restoredRun: clone(restored.runs[0]),
    undoCount: record.undoOperations?.length || 0, restoredUndoCount: restored.runs[0].undoOperations?.length || 0 };
}

async function harness(t, options = {}) {
  const projectIdentifier = options.projectId || PROJECT;
  const target = options.targetPath || TARGET;
  clock = 1000;
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(Math, 'random', () => 0.314159);
  const Native = load('native-host/src/nativeAssetTransfer'), Mirror = load('native-host/src/mirrorWorkspace');
  const nativeRoot = options.native ? fs.mkdtempSync(path.join(os.tmpdir(), 'col-binary-baseline-')) : null;
  const nativeChunks = []; let nativeChanges = [], assetToken = '';
  if (nativeRoot) t.after(() => { if (assetToken) Native.releaseAsset({ token: assetToken }); fs.rmSync(nativeRoot, { recursive: true, force: true }); });
  let projectId = projectIdentifier, cancelled = false, nextId = 0, timerId = 0, activePath = 'main.tex';
  let uploader, journal, page, capGuard, pendingFile = null, uploadPending = Promise.resolve();
  let fileIdentity = 'exact-' + target.replace(/\//g, '-');
  const uploadParent = {}; let uploadParentCurrent = true;
  const server = new Map(options.create ? [] : [[target, Buffer.from(BEFORE)]]);
  const textFiles = new Map([['main.tex', options.editorText ?? options.baseText ?? 'before']]);
  const calls = [], replies = [], uploads = [], reads = [], confirmations = [], editorWrites = [], events = [], errors = [], tasks = [], directoryCleanups = [];
  const listeners = new Set(), timers = new Map();
  const input = { className: 'uppy-Dashboard-input', disabled: false, isConnected: true, multiple: true,
    getAttribute: () => '', closest: selector => selector.includes('.uppy-Dashboard') ? {} : null,
    dispatchEvent(event) {
      if (event.type !== 'change') return;
      events.push('DOM-change'); pendingFile = input.files[0];
      if (options.mutateAt === 'before-replace') { server.set(target, Buffer.from(COLLAB)); events.push('collaborator-change-before-replace'); }
      if (options.create) replace.click();
    } };
  const replacementDialog = { textContent: options.wrongDialog ? 'Replace unrelated.png?' : 'Replace figure.png?' };
  const replace = { textContent: 'Replace', closest: selector => selector === '[role="dialog"]' ? replacementDialog : null, click() {
    assert.ok(pendingFile, 'the production uploader staged a file before Replace');
    const preimage = hash(server.get(target)); events.push('DOM-replace');
    uploadPending = pendingFile.arrayBuffer().then(buffer => {
      server.set(target, Buffer.from(buffer)); uploads.push({ path: target, beforeHash: preimage, afterHash: hash(server.get(target)) });
      pendingFile = null;
    });
  } };
  let visibleInput = input;
  const document = { querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === 'input[type="file"]') return [visibleInput];
      if (selector === '[role="dialog"] button') return pendingFile && !options.create
        ? (options.duplicateDialog ? [replace, { ...replace }] : [replace]) : [];
      return [];
    } };
  const tree = { getProjectId: () => projectId, findFileTreeManager: () => null,
    projectPathExists: file => server.has(file),
    findFileTreeNode: file => server.has(file) ? { dataset: { fileId: fileIdentity } } : null,
    getActiveFilePath: () => activePath, openFileByPath: async file => { activePath = file; return { ok: true }; } };
  const window = { location: { origin: 'https://fixture.invalid' }, CodexOverleafPageBridgeCapability: Capability,
    get _ide() { return { project: { _id: projectId } }; }, fetch: noFetch,
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); }, queueMicrotask,
    addEventListener(_type, listener) { listeners.add(listener); }, removeEventListener(_type, listener) { listeners.delete(listener); },
    postMessage(message) {
      if (message.source === 'codex-overleaf/content') {
        calls.push(clone(message));
        tasks.push(tick().then(async () => {
          await page.pageHandler({ source: window, origin: window.location.origin, data: message });
        }).catch(error => { errors.push(error.stack); }));
      } else {
        replies.push(clone(message));
        const method = calls.find(call => call.id === message.id)?.method;
        if (options.dropReply === method) return;
        for (const listener of [...listeners]) listener({ source: window, origin: window.location.origin, data: message });
      }
    }
  };
  const uploadWindow = { File, FormData, Event, crypto: crypto.webcrypto, atob,
    setTimeout(callback, ms) { clock += ms; queueMicrotask(callback); },
    async fetch(url, request = {}) {
      assert.notEqual(request.method, 'POST', 'DOM transport must not fall back to another write');
      assert.equal(url, `/project/${projectId}/file/${fileIdentity}`);
      if (!uploads.length && options.onBaselineRead) {
        const response = await options.onBaselineRead({ request,
          changeIdentity() { fileIdentity = 'replacement-identity'; },
          replaceInput() { visibleInput = { ...input }; },
          switchUploadParent() { uploadParentCurrent = false; },
          changeDialog() { replacementDialog.textContent = 'Replace unrelated.png?'; }
        });
        if (response) return response;
      }
      await uploadPending; reads.push({ url, hash: hash(server.get(target)), afterUpload: uploads.length > 0 });
      const bytes = Buffer.from(server.get(target) || []);
      return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    },
    DataTransfer: class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } }
  };
  const doc = { toString: () => textFiles.get(activePath), get length() { return textFiles.get(activePath)?.length || 0; } };
  const view = { state: { doc }, dispatch({ changes }) {
    let value = textFiles.get(activePath);
    for (const change of (Array.isArray(changes) ? changes : [changes]).slice().sort((a, b) => b.from - a.from))
      value = value.slice(0, change.from) + change.insert + value.slice(change.to);
    textFiles.set(activePath, value); editorWrites.push({ path: activePath, content: value });
  } };
  const editor = Editor.create({ getCodeMirrorEditorView: () => view, getCodeMirrorDocText: v => v.state.doc.toString(),
    getCodeMirrorDocLength: v => v.state.doc.length, normalizeTextPatches: patches => ({ ok: true, patches: Controller.normalizeTextPatches(patches) }) });
  const router = Router.create({ ...editor, treeOperations: tree, window: { CodexOverleafStaleGuard: Stale, CodexOverleafWriteGuard: Guard,
    _ide: { project: { _id: projectIdentifier } }, fetch: noFetch, setTimeout, clearTimeout },
    writebackOpenSettleMs: 0, getActiveEditorIdentity: () => ({ type: 'codemirror-view', doc }), activeEditorIdentityChanged: () => true,
    readWriteCancellationSequence: () => 0, normalizeSafeProjectPath: Files.normalizeSafeProjectPath, ensureEditing: async () => ({ ok: true }) });
  const writeGuard = Guard.create({ window, document, treeOperations: tree, sleep: async ms => { clock += ms; } });
  const handlerLines = pageSource.match(/^    (?:applyOperations: writebackReceipts\.apply,|getWritebackReceipt: writebackReceipts\.get,|binaryUpload\w+:.*)$/gm);
  assert.equal(handlerLines.length, 7);
  const handlerSource = pageSource.slice(pageSource.indexOf('  const pageBridgeMessageHandler = async event => {'),
    pageSource.indexOf('\n  window.__codexOverleafPageBridgeMessageHandler = pageBridgeMessageHandler;'));
  function rebuildHolder() {
    uploader = Uploader.create({ window: uploadWindow, document, treeOperations: tree,
      snapshotRouter: { buildProjectFileList: async () => ({ files: server.has(target)
        ? [{ path: options.metadataPath || target, id: fileIdentity }] : [] }) },
      cleanupCreatedDirectories: async (proofs, owner) => {
        directoryCleanups.push({ proofs: clone(proofs), projectId: owner.projectId, current: owner.isCurrent() });
        return { ok: false, removed: [], remaining: proofs, requiresExplicitCleanup: true };
      },
      isUploadParentCurrent: (_path, parent) => parent === uploadParent && uploadParentCurrent,
      prepareUploadParent: async (_path, guard) => {
        assert.equal(guard.isCurrent(), true);
        if (options.createdDirectory) {
          guard.onMutation();
          guard.onCreatedDirectory({ v: 1, projectId: projectIdentifier, path: options.createdDirectory, nativeFolderId: '', ownershipConfirmed: false, observedAfterCreate: false });
          guard.onCreatedDirectory({ v: 1, projectId: projectIdentifier, path: options.createdDirectory, nativeFolderId: 'new-folder-id', ownershipConfirmed: false, observedAfterCreate: true });
          if (options.failAfterDirectory) throw new Error('synthetic upload preparation failed');
        }
        if (options.changeProjectInPrepare) projectId = 'synthetic-other-project';
        return uploadParent;
      } });
    journal = Journal.create({ getProjectId: expected => writeGuard.getEditorProjectIdPageSide(expected), now: () => clock,
      prepareEditor: async () => ({ ok: true }), applyOperations: (ops, params) => router.applyOperations(ops, params) });
    capGuard = Capability.create();
    page = vm.createContext({ window, pageRpcContract: Contract, PAGE_BRIDGE_CAPABILITY_METHOD: 'initializeCapability',
      PAGE_BRIDGE_INSTALL_VERSION: '2.5.0', PAGE_BRIDGE_INSTALL_REVISION: Contract.REVISION,
      pageBridgeCapabilityGuard: capGuard, writeGuard, binaryAssetUploader: uploader, writebackReceipts: journal });
    vm.runInContext(`const pageRpcHandlers = {\n${handlerLines.join('\n')}\n};\n${extractFunction(pageSource, 'dispatch')}\n${handlerSource}\nthis.pageHandler = pageBridgeMessageHandler;`, page);
  }
  rebuildHolder();
  const client = Client.create({ window, document: {}, now: () => clock, contract: Contract,
    compatibility: { BUILD_TARGET_VERSION: '2.5.0' }, crypto: { randomUUID: () => 'synthetic-request-' + (++nextId) },
    isCancellationRequested: () => cancelled });
  let afterAppendDone = false;
  async function callPageBridge(method, params) {
    const result = await client.send(method, params, Contract.resolveDispatchPolicy(method));
    if (method === 'binaryUploadAppend' && !afterAppendDone) {
      afterAppendDone = true;
      if (options.cancelBeforeCommit) cancelled = true;
      if (options.changeProjectBeforeCommit) projectId = 'synthetic-other-project';
      if (options.abortBeforeCommit) await client.send('binaryUploadAbort', { transferId: params.transferId, runProjectId: projectIdentifier }, Contract.resolveDispatchPolicy('binaryUploadAbort'));
    }
    return result;
  }
  const broker = Broker.create({ callPageBridge, now: () => clock, delay: async ms => { clock += ms; }, receiptTimeoutMs: 1000,
    sendBackgroundNative: async ({ method, params }) => {
      assert.ok(nativeRoot, 'only isolated native fixture storage is allowed');
      if (method === 'asset.readChunk') { const result = Native.readAssetChunk(params); nativeChunks.push(result.offset); return { ok: true, result }; }
      assert.equal(method, 'asset.release'); return { ok: true, result: Native.releaseAsset(params) };
    } });
  const plan = Plan.create({ tx: x => x, tr: x => x, formatOperationFiles: ops => ops.map(op => op.path).join(','),
    async showPluginConfirm(dialog) {
      confirmations.push(clone(dialog));
      if (options.mutateAt === 'confirmation') { server.set(target, Buffer.from(COLLAB)); events.push('collaborator-change-at-confirmation'); }
      return options.approved !== false;
    } });
  const project = { id: projectIdentifier, files: [
    { path: 'main.tex', kind: 'text', content: options.baseText ?? 'before' },
    ...(options.create ? [] : [{ path: target, kind: 'binary', contentBase64: BEFORE.toString('base64'), size: BEFORE.length, sha256: hash(BEFORE) }])
  ] };
  await client.send('initializeCapability', {}, Contract.resolveDispatchPolicy('initializeCapability'));
  return { client, broker, project, server, textFiles, calls, replies, uploads, reads, confirmations, editorWrites, events, directoryCleanups,
    get uploader() { return uploader; }, get journal() { return journal; },
    get nativeChanges() { return nativeChanges; }, nativeChunks,
    dispatch: (method, params) => page.dispatch(method, params),
    async rebuild() { rebuildHolder(); await client.send('initializeCapability', {}, Contract.resolveDispatchPolicy('initializeCapability')); },
    setClock(value) { clock = value; }, now: () => clock,
    async upload() {
      let changes = [{ type: options.create ? 'binary-create' : 'overwrite-binary', path: target, contentBase64: NEW.toString('base64'),
        sha256: options.badHash ? hash(BEFORE) : hash(NEW), size: NEW.length, mimeType: 'image/png',
        previousExists: !options.create, previousKind: 'binary', previousSize: BEFORE.length }];
      if (nativeRoot) {
        await Mirror.syncOverleafToMirror({ projectId: projectIdentifier, project, rootDir: nativeRoot });
        const mirror = Mirror.getProjectMirror(projectIdentifier, { rootDir: nativeRoot });
        fs.writeFileSync(path.join(mirror.workspacePath, target), NEW);
        const collected = await Mirror.collectMirrorChangesDetailed({ projectId: projectIdentifier, rootDir: nativeRoot });
        nativeChanges = collected.changes;
        const prepared = Native.prepareBinaryAssetChanges({ projectId: projectIdentifier, rootDir: nativeRoot, changes: nativeChanges });
        assert.equal(prepared.unsupportedChanges.length, 0); changes = prepared.changes;
        assetToken = changes[0].assetRef.token; changes[0].assetRef.chunkSize = 13;
      }
      const operations = Controller.buildSyncApplyOperations(changes, project);
      const decision = await plan.confirmBinaryOperations(operations);
      const result = await broker.applyOperations({ operations: decision.operations, baseFiles: project.files, runProjectId: projectIdentifier });
      result.skipped.push(...decision.skipped); if (decision.skipped.length) result.ok = false;
      return result;
    },
    timeout(method) { const call = [...calls].reverse().find(call => call.method === method); assert.ok(call);
      const timer = [...timers.values()].find(timer => timer.ms === Contract.resolveTimeoutMs(method)); assert.ok(timer, 'live RPC timeout'); timer.fn(); },
    async cleanup() { await Promise.all(tasks); await uploadPending; assert.deepEqual(errors, []); assert.equal(timers.size, 0); assert.equal(listeners.size, 0); }
  };
}

module.exports = { harness, recoveryProjection, PROJECT, TARGET, BEFORE, COLLAB, NEW, hash, until };
