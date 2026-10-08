'use strict';
// Real composer + runtime save/load/hydration; only IO and unrelated UI are synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const root = path.resolve(__dirname, '..');
const { extractFunction } = require(path.join(root, 'test/_helpers/extractFunction.js'));
const SessionState = require(path.join(root, 'extension/src/shared/sessionState.js'));
const RealStorageDb = require(path.join(root, 'extension/src/shared/storageDb.js'));
const SessionPersistence = require(path.join(root, 'extension/src/content/sessionPersistence.js'));
const PanelState = require(path.join(root, 'extension/src/content/scopedPersistencePanelState.js'));
const Draft = require('../extension/src/shared/composerAttachmentDraft');
const { createMemoryDraftDb } = require('./_helpers/memoryDraftDb');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const runtime = read('extension/src/content/contentRuntime.js');
const composerSource = read('extension/src/content/composerAttachments.js');
const plain = value => JSON.parse(JSON.stringify(value));
const no = () => {};
const flush = () => new Promise(resolve => setImmediate(resolve));


const { harness } = require('./_helpers/runSubmissionHarness');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.hidden = true; this.dataset = {};
    this.className = ''; this.textContent = ''; this.attributes = {}; this.listeners = {};
  }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this.children = values; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
function file(name, size = 4) {
  return { name, size, type: 'text/plain', lastModified: 1,
    dataUrl: `data:text/plain;base64,${Buffer.alloc(size, 65).toString('base64')}` };
}
function fixture() {
  const h = harness();
  const readers = [], logs = [], strip = new Element(), form = new Element();
  class Reader {
    readAsDataURL(value) { this.file = value; readers.push(this); }
  }
  h.context.FileReader = Reader;
  h.context.document = { body: new Element(), createElement: tag => new Element(tag) };
  const oldQuery = h.context.panel.querySelector;
  h.context.panel.querySelector = selector => selector === '[data-attachment-strip]' ? strip
    : selector === '[data-composer-form]' ? form : oldQuery(selector);
  vm.runInContext(composerSource, h.context,
    { filename: path.join(root, 'extension/src/content/composerAttachments.js') });
  const controller = h.context.window.CodexOverleafComposerAttachments.createComposerAttachmentController({
    getPanel: () => h.context.panel, appendPlainLog: value => logs.push(String(value)),
    onChange: () => h.context.getComposerDraftPersistence().changed()
  });
  h.context.composerAttachmentController = controller;
  h.context.composerDraftPersistence = null;
  h.context.Modules.ComposerAttachmentDraft = Draft;
  vm.runInContext(extractFunction(runtime, 'getComposerDraftPersistence'), h.context);
  for (const name of ['getComposerAttachmentsForRun', 'createRunAttachmentSnapshots', 'renderComposerAttachments']) {
    vm.runInContext(extractFunction(runtime, name), h.context);
  }
  function settle(index, fail = false) {
    const reader = readers[index];
    assert.ok(reader && !reader.settled, 'one live synthetic FileReader expected');
    reader.settled = true;
    if (fail) { reader.error = new Error('Synthetic read failure'); reader.onerror(); }
    else { reader.result = reader.file.dataUrl; reader.onload(); }
  }
  const names = () => plain(controller.getAttachmentsForRun()).map(value => value.name);
  function renderedNames() {
    const found = [];
    function walk(node) {
      if (node.className === 'codex-attachment-preview-name') found.push(node.textContent);
      for (const child of node.children || []) walk(child);
    }
    walk(strip); return found;
  }
  return { h, readers, logs, strip, controller, settle, names, renderedNames };
}
async function addOne(f, value) {
  const adding = f.controller.addFiles([value]);
  f.settle(f.readers.length - 1); await adding;
}
function observe(id, name, value) {
  const entry = { issue: id, name, ...plain(value) };
  console.log('OBSERVATION ' + JSON.stringify(entry));
}
function attachMemoryPersistence(h) {
  const memory = { prefs: {}, sessions: [], commits: 0, writes: 0, loaded: 0, fallbackAttempts: 0 };
  const draftDb = createMemoryDraftDb(), draftStore = Draft.createStore(draftDb.openDb);
  const Migration = {
    async loadPrefs(account, project) { assert.equal(account, 'account-one'); assert.equal(project, 'project-one'); return plain(memory.prefs); },
    async savePrefs(prefs, account, project) { assert.equal(account, 'account-one'); assert.equal(project, 'project-one'); memory.prefs = plain(prefs); },
    async loadSessionTombstones() { return {}; }, getDeletedSessionIds() { return []; },
    async runMigrationIfNeeded(project, key, account) {
      assert.equal(project, 'project-one'); assert.equal(account, 'account-one'); memory.loaded++;
      return { prefs: plain(memory.prefs), sessions: plain(memory.sessions), activeSessionId: memory.prefs.activeSessionByProject[project] };
    }
  };
  const StorageDb = { ...RealStorageDb,
    readComposerAttachmentDraft: draftStore.read,
    writeComposerAttachmentDraft: draftStore.write,
    async getAllByIndex(store, key, project) {
      assert.deepEqual([store, key, project], ['sessions', 'projectId', 'project-one']); return plain(memory.sessions);
    },
    async putRecords(store, records) {
      assert.equal(store, 'sessions'); memory.writes++;
      for (const record of records) {
        const index = memory.sessions.findIndex(item => item.id === record.id);
        if (index < 0) memory.sessions.push(plain(record)); else memory.sessions[index] = plain(record);
      }
      return plain(records);
    },
    async deleteRecord() { throw new Error('unexpected synthetic deletion'); }
  };
  Object.assign(h.context.Modules, { StorageDb, StorageMigration: Migration,
    ScopedPersistenceCoordinator: PanelState, SessionPersistence });
  Object.assign(h.context, { storageKey: 'synthetic-legacy-key', prepareStateForStorage: SessionState.prepareStateForStorage,
    notifyAggressiveCompactionOnce: no, getCodexOverleafSkillEnabled: () => ({}),
    getCodexLocalSkillEnabled: () => ({}),
    normalizeExperimentalOtByProject: value => value || {}, normalizeGovernanceRulesByProject: value => value || {},
    normalizeCustomInstructionsByProject: value => value || {},
    getScopedPersistenceCoordinator: () => ({ async commit(project, options, persist) {
      assert.equal(project, 'project-one'); memory.commits++;
      await persist({ scope: { projectId: project, accountScopeId: 'account-one' }, nextMeta: {}, writerId: 'synthetic-writer' });
      return { ok: true };
    } }),
    isScopedPersistenceIdentityFailure: () => false,
    buildScopedFallbackStorageKey: () => { memory.fallbackAttempts++; throw new Error('unexpected save fallback reached'); },
    chrome: { storage: { local: { async get() { throw new Error('unexpected fallback read'); },
      async set() { throw new Error('unexpected fallback write'); } } } },
    isStorageQuotaError: () => false
  });
  for (const name of ['readLiveRunViewForSaveStateGuard', 'saveState', 'loadStoredStateForProject', 'loadComposerAttachmentsForProject']) {
    vm.runInContext(extractFunction(runtime, name), h.context);
  }
  return { memory, Migration, StorageDb, draftStore, draftDb };
}
async function reloadFromMemory(memoryFixture) {
  const f = fixture();
  f.h.context.Modules.StorageDb = memoryFixture.StorageDb;
  f.h.context.Modules.StorageMigration = memoryFixture.Migration;
  f.h.context.storageKey = 'synthetic-legacy-key';
  f.h.context.isScopedPersistenceIdentityFailure = () => false;
  f.h.context.normalizeGovernanceRulesByProject = value => value || {};
  f.h.context.buildScopedFallbackStorageKey = () => { throw new Error('unexpected reload fallback reached'); };
  vm.runInContext(extractFunction(runtime, 'loadStoredStateForProject'), f.h.context);
  vm.runInContext(extractFunction(runtime, 'loadComposerAttachmentsForProject'), f.h.context);
  const loaded = await f.h.context.loadStoredStateForProject('account-one');
  f.h.context.state = SessionState.normalizePanelState(loaded);
  f.h.context.applyStateToPanel();
  return { f, loaded };
}

test('PROJ-101 CONTROL real serialize/normalize/hydration supports a small attachment when explicitly supplied', async () => {
  const first = fixture(); await addOne(first, file('draft.txt'));
  first.h.context.readPanelInputs();
  const compact = SessionState.prepareStateForStorage(first.h.context.state);
  assert.equal(compact.composerAttachments.length, 1);
  const second = fixture();
  second.h.context.state = SessionState.normalizePanelState(compact);
  second.h.context.applyStateToPanel();
  assert.deepEqual(second.names(), ['draft.txt']); assert.deepEqual(second.renderedNames(), ['draft.txt']);
  observe('PROJ-101', 'helper-positive-control', { compactNames: compact.composerAttachments.map(x => x.name),
    restoredNames: second.names(), renderedNames: second.renderedNames() });
});

test('PROJ-101 CONTROL production save/load restores a normal text draft and correct session', async () => {
  const first = fixture(); first.h.type('ordinary synthetic draft');
  const memoryFixture = attachMemoryPersistence(first.h);
  await first.h.context.saveState();
  assert.equal(memoryFixture.memory.commits, 1); assert.equal(memoryFixture.memory.writes, 1);
  assert.equal(memoryFixture.memory.fallbackAttempts, 0);
  assert.deepEqual(plain(first.h.io.errors), []);
  const { f: next } = await reloadFromMemory(memoryFixture);
  assert.equal(next.h.context.state.activeSessionId, 'A');
  assert.equal(next.h.controls.get('[data-task]').value, 'ordinary synthetic draft');
  assert.deepEqual(next.names(), []);
  observe('PROJ-101', 'storage-positive-control', { restoredTask: next.h.controls.get('[data-task]').value,
    restoredSession: next.h.context.state.activeSessionId, commits: memoryFixture.memory.commits, writes: memoryFixture.memory.writes,
    fallbackAttempts: memoryFixture.memory.fallbackAttempts });
});

test('CONTRACT actual save/load/hydration retains eligible attachment beside its draft', async () => {
  const first = fixture(); await addOne(first, file('draft.txt'));
  first.h.type('synthetic text beside attachment');
  const compact = SessionState.prepareStateForStorage(first.h.context.state);
  assert.equal(compact.composerAttachments.length, 1, 'eligible small attachment reached preparation');
  const memoryFixture = attachMemoryPersistence(first.h);
  await first.h.context.saveState();
  assert.equal(memoryFixture.memory.commits, 1); assert.equal(memoryFixture.memory.writes, 1);
  assert.equal(memoryFixture.memory.fallbackAttempts, 0);
  assert.deepEqual(plain(first.h.io.errors), []);
  assert.equal(Object.hasOwn(memoryFixture.memory.prefs, 'composerAttachments'), false);
  assert.equal(memoryFixture.memory.sessions.some(s => Object.hasOwn(s, 'composerAttachments')), false);
  const { f: next, loaded } = await reloadFromMemory(memoryFixture);
  assert.equal(Object.hasOwn(loaded, 'composerAttachments'), true);
  assert.equal(next.h.controls.get('[data-task]').value, 'synthetic text beside attachment');
  assert.deepEqual(next.names(), ['draft.txt']); assert.deepEqual(next.renderedNames(), ['draft.txt']);
  assert.equal(next.strip.hidden, false);
  observe('PROJ-101', 'full-save-load-hydration-success', { beforeNames: first.names(), beforeRendered: first.renderedNames(),
    serializedNames: compact.composerAttachments.map(x => x.name), persistedPrefsHasAttachments: false,
    persistedSessionsHaveAttachments: false, loadedHasAttachments: true,
    restoredTask: next.h.controls.get('[data-task]').value, restoredNames: next.names(),
    restoredRenderedNames: next.renderedNames(), commits: memoryFixture.memory.commits, writes: memoryFixture.memory.writes,
    memoryLoads: memoryFixture.memory.loaded, fallbackAttempts: memoryFixture.memory.fallbackAttempts });
});

test('removing a restored attachment alone triggers a durable empty draft', async () => {
  const first = fixture(), memoryFixture = attachMemoryPersistence(first.h);
  await addOne(first, file('draft.txt')); await first.h.context.saveState();
  const { f: next } = await reloadFromMemory(memoryFixture);
  const button = next.strip.children[0].children.find(x => x.className === 'codex-attachment-preview-remove');
  button.listeners.click({ preventDefault: no, stopPropagation: no });
  assert.deepEqual(next.names(), []);
  await next.h.context.getComposerDraftPersistence().save();
  const { f: third } = await reloadFromMemory(memoryFixture);
  assert.deepEqual(third.names(), []); assert.equal(third.strip.hidden, true);
});

test('attachment read failure preserves successful history load and reports unavailable attachments', async () => {
  const first = fixture(), memoryFixture = attachMemoryPersistence(first.h);
  first.h.type('keep this draft'); await first.h.context.saveState();
  memoryFixture.StorageDb.readComposerAttachmentDraft = async () => { throw new Error('synthetic draft IO error'); };
  const { f: next } = await reloadFromMemory(memoryFixture);
  assert.equal(next.h.controls.get('[data-task]').value, 'keep this draft');
  assert.equal(next.h.context.state.activeSessionId, 'A');
  assert.deepEqual(next.names(), []);
  assert.match(next.h.io.errors.join('\n'), /Saved attachments could not be restored/);
});

test('compact emergency fallback never copies attachment bytes outside their scoped artifact', async () => {
  const f = fixture(); await addOne(f, file('draft.txt')); f.h.context.readPanelInputs();
  f.h.context.prepareStateForStorage = SessionState.prepareStateForStorage;
  vm.runInContext(extractFunction(runtime, 'prepareCompactFallbackState'), f.h.context);
  const fallback = f.h.context.prepareCompactFallbackState(f.h.context.state);
  assert.deepEqual(plain(fallback.composerAttachments), []);
  assert.equal(JSON.stringify(fallback).includes('QUFBQQ=='), false);
});

test('runtime scope synchronization clears the real controller and invalidates an old pending FileReader', async () => {
  const f = fixture(); f.h.context.getComposerDraftPersistence();
  const adding = f.controller.addFiles([file('old-project.txt')]);
  f.h.changeProject(); f.h.context.getComposerDraftPersistence().syncScope();
  f.settle(0); await adding;
  assert.deepEqual(f.names(), []); assert.deepEqual(f.renderedNames(), []);
  assert.deepEqual(plain(f.h.context.state.composerAttachments), []);
});
