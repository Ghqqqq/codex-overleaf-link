'use strict';
// Production audit writers, local storage queries and the actual diagnostic Blob exporter.
// No real browser/IndexedDB, account, Native process, network, or model is used.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
const AuditRecords = require(path.join(root, 'extension/src/shared/auditRecords'));
const StorageDb = require(path.join(root, 'extension/src/shared/storageDb'));
const DiagnosticsExport = require(path.join(root, 'extension/src/content/diagnosticsExport'));
const ChangeHistoryModel = require(path.join(root, 'extension/src/shared/changeHistoryModel'));
const { extractFunction } = require(path.join(root, 'test/_helpers/extractFunction'));
const runtimePath = 'extension/src/content/contentRuntime.js';
const writers = ['createAuditDraftForRun', 'updateAuditSensitiveFindings', 'finalizeAuditDraftPartial', 'finalizeAuditRecord'];
const runtimeSource = source(runtimePath);
const writerSource = writers.map(name => extractFunction(runtimeSource, name)).join('\n');
const clone = value => structuredClone(value);
const SAME_PROJECT = 'synthetic-shared-project';
const OTHER_PROJECT = 'synthetic-other-project';
const ACC_A = 'synthetic-account-A';
const ACC_B = 'synthetic-account-B';
const no = () => {};

// Narrow async request adapter. Production StorageDb.openDb/putRecord/getAllByIndex
// are intact. This substitute models equality-index queries and record cloning;
// it does not model browser quota, account hydration, real IDB scheduling/commits.
function memoryIndexedDb() {
  const stores = new Map();
  const calls = [];
  const request = operation => {
    const req = {};
    setImmediate(() => {
      try { req.result = clone(operation()); req.onsuccess?.({ target: req }); }
      catch (error) { req.error = error; req.onerror?.({ target: req }); }
    });
    return req;
  };
  const db = {
    transaction(storeName, mode) {
      calls.push({ action: 'transaction', storeName, mode });
      if (!stores.has(storeName)) stores.set(storeName, new Map());
      const records = stores.get(storeName);
      return { objectStore(name) {
        assert.equal(name, storeName);
        return {
          put(record) { return request(() => { records.set(record.id, clone(record)); return record.id; }); },
          get(id) { return request(() => records.get(id)); },
          index(indexName) { return { getAll(range) {
            calls.push({ action: 'index.getAll', storeName, indexName, value: range.only });
            assert.equal(StorageDb.STORES[storeName].indexes[indexName].keyPath, indexName);
            return request(() => [...records.values()].filter(record => record[indexName] === range.only));
          } }; }
        };
      } };
    }
  };
  return {
    indexedDB: { open(name, version) {
      calls.push({ action: 'open', name, version });
      const req = {}; setImmediate(() => { req.result = db; req.onsuccess?.({ target: req }); }); return req;
    } },
    IDBKeyRange: { only: value => ({ only: value }) },
    calls, records: name => [...(stores.get(name) || new Map()).values()].map(clone)
  };
}

function harness() {
  const memory = memoryIndexedDb();
  const previous = { indexedDB: global.indexedDB, IDBKeyRange: global.IDBKeyRange };
  global.indexedDB = memory.indexedDB;
  global.IDBKeyRange = memory.IDBKeyRange;
  let projectId = SAME_PROJECT;
  let accountScopeId = ACC_A;
  let state = { accountScopeId, activeSessionId: '', sessions: [], runs: [] };
  let projectAfterMirror = null; let accountAfterMirror = null; let activeRecord = null;
  const downloads = [], toasts = [];
  const snapshots = { mode: 'auto', providerId: 'builtin', providerRevision: 1,
    model: 'synthetic-model', reasoningEffort: 'high', speedTier: 'standard' };
  const context = vm.createContext({
    Modules: { StorageDb }, AuditRecords, currentRunView: null,
    state, cachedAccountScopeId: accountScopeId,
    getCurrentProjectId: () => projectId,
    captureCurrentExecutionSnapshot: () => snapshots,
    providerSettingsCoordinator: { getProviderSnapshot: () => ({ providerId: 'builtin', providerName: 'Synthetic provider' }) }
  });
  vm.runInContext(writerSource, context, { filename: runtimePath + ':extracted-audit-writers' });
  const exporter = DiagnosticsExport.create({
    root: {}, window: { setTimeout: fn => { fn(); return 0; } }, Blob, TextEncoder,
    document: {
      createElement: name => { assert.equal(name, 'a'); return { click() { downloads.at(-1).clicked = true; downloads.at(-1).filename = this.download; }, remove: no }; },
      body: { append: no }
    },
    URL: { createObjectURL(blob) { downloads.push({ blob }); return 'blob:synthetic-diagnostic-download'; }, revokeObjectURL: no },
    AuditRecords, StorageDb,
    getState: () => state, getCurrentRunView: () => context.currentRunView, findRunRecord: () => activeRecord,
    getCurrentProjectId: () => projectId, getAccountScopeId: () => accountScopeId,
    getMirrorFreshness: async () => { if (projectAfterMirror) projectId = projectAfterMirror; if (accountAfterMirror !== null) accountScopeId = accountAfterMirror; return { status: 'ready', fileCount: 0 }; },
    getExtensionCompatibilityMetadata: () => ({ version: '2.5.0', protocolVersion: 1 }),
    getModelDiscovery: () => ({ status: 'ready' }),
    getGovernanceRulesForCurrentProject: () => ({ sensitiveCheckEnabled: true }),
    sendBackgroundNative: async request => { assert.equal(request.method, 'bridge.ping'); return { ok: true, result: { platform: 'synthetic', environment: {} } }; },
    tr: value => value, showPluginToast: (...args) => toasts.push(args)
  });
  const switchScope = (account, project, sessionId) => {
    accountScopeId = account; projectId = project;
    state = { accountScopeId: account, activeSessionId: sessionId, sessions: sessionId ? [{ id: sessionId, runs: [] }] : [], runs: [] };
    context.state = state; context.cachedAccountScopeId = account;
    context.currentRunView = { recordId: 'turn-' + sessionId, runProjectId: project, runAccountScopeId: account, executionSnapshot: snapshots };
  };
  return {
    memory, context, downloads, toasts,
    switchScope, state: () => state,
    async write({ account, project = SAME_PROJECT, session, timestamp = '2026-10-04T00:00:01.000Z' }) {
      switchScope(account, project, session);
      let draft = await context.createAuditDraftForRun({ sessionId: session, accountScopeId: account,
        task: 'SYNTHETIC_PRIVATE_PROMPT_' + session, focusFiles: ['SYNTHETIC_PRIVATE_FILE_' + session + '.tex'], selectedSkillIds: ['synthetic-skill'] });
      assert.ok(draft?.id);
      draft = await context.updateAuditSensitiveFindings(draft, [{ detectorId: 'synthetic', path: 'SYNTHETIC_PRIVATE_FINDING.tex', preview: 'SYNTHETIC_PRIVATE_PREVIEW' }]);
      draft = await context.finalizeAuditDraftPartial(draft, { createdAt: timestamp });
      await context.finalizeAuditRecord(draft, { changedFiles: [{ path: 'SYNTHETIC_PRIVATE_FILE_' + session + '.tex', size: 123 }], appliedFiles: ['SYNTHETIC_PRIVATE_FILE_' + session + '.tex'],
        diffSummary: { filesChanged: 1, additions: 2, deletions: 1 }, resultStatus: 'completed', saveVerification: { status: 'saved', ok: true } });
      return memory.records('auditLogs').find(record => record.id === draft.id);
    },
    async export() { await exporter.exportDiagnosticsBundle(); const last = downloads.at(-1); assert.equal(last.clicked, true); return JSON.parse(await last.blob.text()); },
    changeProjectDuringExport(value) { projectAfterMirror = value; },
    changeAccountDuringExport(value) { accountAfterMirror = value; },
    setActiveRecord(value) { activeRecord = value; },
    async invokeExport() { return exporter.exportDiagnosticsBundle(); },
    close() {
      for (const name of Object.keys(previous)) {
        if (previous[name] === undefined) delete global[name]; else global[name] = previous[name];
      }
    }
  };
}

async function withHarness(fn) { const h = harness(); try { await fn(h); } finally { h.close(); } }

test('audit draft, partial/final updates and storage preserve the run account owner', () => withHarness(async h => {
  const a = await h.write({ account: ACC_A, session: 'session-A' });
  assert.equal(a.accountScopeId, ACC_A);
  assert.equal(AuditRecords.normalizeAuditLogRecord(a).accountScopeId, ACC_A);
  h.switchScope(ACC_B, SAME_PROJECT, 'session-B');
  const updated = await h.context.finalizeAuditDraftPartial(a, { accountScopeId: ACC_B, projectId: OTHER_PROJECT });
  assert.equal(updated.accountScopeId, ACC_A); assert.equal(updated.projectId, SAME_PROJECT);
  h.context.currentRunView = { recordId: 'original-run', runAccountScopeId: ACC_A, runProjectId: OTHER_PROJECT };
  const owned = await h.context.createAuditDraftForRun({ sessionId: 'session-A', task: 'original task' });
  assert.equal(owned.accountScopeId, ACC_A); assert.equal(owned.projectId, OTHER_PROJECT);
}));

test('an audit without a stable owner is not persisted or assigned to a later account', () => withHarness(async h => {
  h.switchScope('', SAME_PROJECT, 'unknown');
  assert.equal(await h.context.createAuditDraftForRun({ task: 'unscoped task' }), null);
  assert.deepEqual(h.memory.records('auditLogs'), []);
  assert.equal(StorageDb.buildAuditLogRecord({ id: 'old' }).accountScopeId, '');
}));

test('B diagnostics include only B same-project audit; old unowned records are excluded without mutation', () => withHarness(async h => {
  const a = await h.write({ account: ACC_A, session: 'session-A' });
  const b = await h.write({ account: ACC_B, session: 'session-B' });
  await h.write({ account: ACC_B, project: OTHER_PROJECT, session: 'other-project' });
  const legacy = StorageDb.buildAuditLogRecord({ id: 'old-unowned', projectId: SAME_PROJECT, sessionId: 'session-B' });
  await StorageDb.putRecord('auditLogs', legacy);
  h.switchScope(ACC_B, SAME_PROJECT, 'session-B');
  const bundle = await h.export();
  assert.deepEqual(bundle.auditLogs.map(record => record.id), [b.id]);
  assert.equal(bundle.auditLogs.some(record => record.id === a.id), false);
  assert.equal(h.memory.records('auditLogs').find(record => record.id === legacy.id).accountScopeId, '');
  const projected = ChangeHistoryModel.project([a, b], { projectId: SAME_PROJECT, accountScopeId: ACC_B,
    sessions: h.state().sessions, activeSessionId: 'session-B', activeRuns: [] });
  assert.deepEqual(projected.map(record => record.sessionId), ['session-B']);
}));

test('same-account exports retain metadata while omitting prompt bodies, paths and raw account identity', () => withHarness(async h => {
  const a = await h.write({ account: ACC_A, session: 'session-A' });
  const bundle = await h.export(); const text = JSON.stringify(bundle);
  assert.equal(bundle.auditLogs[0].id, a.id); assert.equal(bundle.auditLogs[0].changedByteCount, 123);
  assert.equal(bundle.auditLogs[0].promptPreview.redacted, true);
  for (const marker of ['SYNTHETIC_PRIVATE_', '.tex', SAME_PROJECT, ACC_A]) assert.equal(text.includes(marker), false, marker);
}));

for (const account of [ACC_B, '']) {
  test(`diagnostic collection rejects account ${account ? 'change' : 'loss'} before download`, () => withHarness(async h => {
    await h.write({ account: ACC_A, session: 'session-A' });
    h.changeAccountDuringExport(account);
    await assert.rejects(h.invokeExport(), /[Aa]ccount/); assert.equal(h.downloads.length, 0);
  }));
}

test('unresolved account cannot begin diagnostics export', () => withHarness(async h => {
  h.switchScope('', SAME_PROJECT, '');
  await assert.rejects(h.invokeExport(), /[Aa]ccount/);
  assert.equal(h.downloads.length, 0); assert.equal(h.memory.calls.length, 0);
}));

test('diagnostic project-change protection is preserved', () => withHarness(async h => {
  await h.write({ account: ACC_A, session: 'session-A' });
  h.changeProjectDuringExport(OTHER_PROJECT);
  await assert.rejects(h.invokeExport(), /Project changed during diagnostics export/);
  assert.equal(h.downloads.length, 0);
}));

test('diagnostics reject explicitly foreign current and recent run owners while retaining same-account summaries', () => withHarness(async h => {
  h.switchScope(ACC_A, SAME_PROJECT, 'session-A');
  h.state().runs = [
    { id: 'owned', runProjectId: SAME_PROJECT, runAccountScopeId: ACC_A },
    { id: 'foreign', runProjectId: SAME_PROJECT, runAccountScopeId: ACC_B }
  ];
  h.context.currentRunView.runAccountScopeId = ACC_B;
  h.setActiveRecord({ id: 'foreign-active', runProjectId: SAME_PROJECT });
  const bundle = await h.export();
  assert.deepEqual(bundle.recentRuns.map(run => run.id), ['owned']);
  assert.equal(bundle.run.id, 'owned');
}));

test('an explicit foreign hydrated session prevents its ownerless run summaries from being exported', () => withHarness(async h => {
  h.switchScope(ACC_A, SAME_PROJECT, 'session-A');
  h.state().sessions[0].accountScopeId = ACC_B;
  h.state().runs = [{ id: 'old-ownerless', runProjectId: SAME_PROJECT }];
  const bundle = await h.export(); assert.deepEqual(bundle.recentRuns, []);
}));
