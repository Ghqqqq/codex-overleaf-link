'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const repo = path.resolve(__dirname, '..');
const load = name => require(path.join(repo, name));
const { extractFunction } = load('test/_helpers/extractFunction');
const SessionState = load('extension/src/shared/sessionState');
const StorageDb = load('extension/src/shared/storageDb');
const SessionPersistence = load('extension/src/content/sessionPersistence');
const Scoped = load('extension/src/content/scopedPersistenceCoordinator');
const Transaction = load('extension/src/shared/scopedPersistenceTransaction');
const ActiveTurnControl = load('extension/src/content/activeTurnControl');
const Transcript = load('extension/src/shared/agentTranscript');
const RunInputQueue = load('extension/src/shared/runInputQueue');
const ComposerAttachmentDraft = load('extension/src/shared/composerAttachmentDraft');
const { createMemoryDraftDb } = require('./_helpers/memoryDraftDb');
const runtimeSource = fs.readFileSync(path.join(repo, 'extension/src/content/contentRuntime.js'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(repo, 'extension/src/background.js'), 'utf8');
const markdownSource = fs.readFileSync(path.join(repo, 'extension/src/content/markdownText.js'), 'utf8');
const clone = value => structuredClone(value);
const denyFetch = async () => { throw new Error('Unexpected network in isolated PROJ-036 fixture'); };
const originalFetch = globalThis.fetch;
globalThis.fetch = denyFetch;
test.after(() => { globalThis.fetch = originalFetch; });
const MARKER = 'SYNTHETIC_RECOVERY_TEXT_036';
const projectId = 'synthetic-project-036';
const accountScopeId = 'synthetic-account-036';
const requestId = 'synthetic-request-036';
const sessionId = 'synthetic-session-036';
const journalKey = 'codex-overleaf:run-journal:' + requestId;
const fixedTime = '2026-10-04T01:00:00.000Z';
const hasMarker = value => JSON.stringify(value).includes(MARKER);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function createHarness(options = {}) {
  const trace = [];
  let currentProjectId = projectId;
  const record = { id: 'synthetic-run-036', task: 'Synthetic recovery check', mode: 'ask',
    status: 'running', runProjectId: options.runProjectId ?? projectId, nativeRequestId: requestId,
    startedAt: fixedTime, events: [{ title: 'Earlier saved event', kind: 'activity', status: 'running', timestamp: fixedTime }] };
  const state = SessionState.normalizePanelState({ activeSessionId: sessionId, sessions: [{
    id: sessionId, accountScopeId, projectId, title: 'Synthetic session', titleSource: 'manual',
    createdAt: fixedTime, updatedAt: fixedTime, task: '', runs: [record], history: [],
    pendingInputs: [{ id: 'queued-036', text: 'queued task', status: 'queued', createdAt: fixedTime }]
  }] }, { restoreRunningRuns: false });
  const mainRecords = new Map([[sessionId, StorageDb.buildSessionRecord({ ...state.sessions[0], projectId, accountScopeId })]]);
  if (options.newerSession) mainRecords.get(sessionId).updatedAt = '2099-01-01T00:00:00.000Z';
  const sessionStorage = new Map();
  const localStorage = new Map();
  let prefs = {};
  let loadFails = false;
  const journal = { requestId, projectKey: projectId, clientRunId: record.id,
    sessionId: options.missingSession ? 'absent-session' : sessionId,
    terminal: true, ownerLost: options.ownerLost !== false,
    createdAt: fixedTime, updatedAt: fixedTime, nextSequence: 3,
    events: [
      { sequence: 1, event: { type: 'codex.turn.bound', detail: { threadId: 'thread-036', turnId: 'turn-036' } } },
      { sequence: 2, event: { type: 'codex.session.event', timestamp: fixedTime,
        detail: { method: 'item/agentMessage/delta', params: { itemId: 'item-036', delta: options.message || MARKER } } } }
    ] };
  sessionStorage.set(journalKey, clone(journal));
  const runJournals = new Map([[requestId, clone(journal)]]);
  const journalWrites = new Map();
  const chrome = {
    storage: {
      session: {
        async get() { return Object.fromEntries([...sessionStorage].map(([k, v]) => [k, clone(v)])); },
        async remove(key) { trace.push('journal-storage-remove'); sessionStorage.delete(key); }
      },
      local: {
        async set(values) {
          trace.push('fallback-write-attempt');
          if (options.fallbackFails) throw new Error('synthetic fallback I/O failure');
          for (const [key, value] of Object.entries(values)) localStorage.set(key, clone(value));
          trace.push('fallback-write-success');
        },
        async get(keys) { return Object.fromEntries(keys.filter(key => localStorage.has(key)).map(key => [key, clone(localStorage.get(key))])); }
      }
    }
  };
  const background = vm.createContext({ chrome, runJournals, journalWrites,
    journalLoads: new Map(), ownerBindings: new Map(),
    RUN_JOURNAL_PREFIX: 'codex-overleaf:run-journal:', fetch: denyFetch });
  for (const name of ['listRunJournals', 'acknowledgeRunJournal', 'removeRunJournal',
    'queueJournalStorage', 'invalidateJournalLoad', 'journalMatchesBinding']) {
    vm.runInContext(extractFunction(backgroundSource, name), background, { filename: 'background.' + name + '.js' });
  }
  chrome.runtime = { async sendMessage(message) {
    if (message.type === 'codex-overleaf/run-journal/list') {
      trace.push('list-journals');
      const journals = await background.listRunJournals(message.projectKey);
      if (options.loseProjectAfterList) currentProjectId = '';
      if (options.changeProjectAfterList) currentProjectId = 'another-project';
      if (options.changeAccountAfterList) context.cachedAccountScopeId = 'another-account';
      return { ok: true, journals };
    }
    if (message.type === 'codex-overleaf/run-journal/ack') {
      trace.push('ack-request');
      await background.acknowledgeRunJournal(message.requestId);
      return { ok: true };
    }
    throw new Error('Unexpected message: ' + message.type);
  } };
  const activeTurnControl = ActiveTurnControl.create({ chrome });
  const draftStore = ComposerAttachmentDraft.createStore(createMemoryDraftDb().openDb);
  const db = { ...StorageDb, sharedSessionsEnabled: () => true,
    readComposerAttachmentDraft: draftStore.read, writeComposerAttachmentDraft: draftStore.write,
    async getAllByIndex(store, index, key) {
      assert.equal(store, 'sessions'); assert.equal(index, 'projectId'); assert.equal(key, projectId);
      return clone([...mainRecords.values()]);
    },
    async putRecords(store, records) {
      assert.equal(store, 'sessions');
      trace.push('main-sessions-write-attempt');
      options.writeStarted?.resolve();
      if (options.writeGate) await options.writeGate.promise;
      if (options.mainFails) throw Object.assign(new Error('synthetic sessions I/O failure'), { code: 'sessions_io_failed' });
      if (options.dropRunOnWrite) records = records.map(value => ({ ...value, runs: [] }));
      if (options.dropEventsOnWrite) records = records.map(value => ({ ...value, runs: value.runs.map(run => ({ ...run, events: [] })) }));
      for (const value of records) mainRecords.set(value.id, clone(value));
      trace.push('main-sessions-write-success');
      return clone(records);
    },
    async deleteRecord(_store, id) {
      assert.equal(options.deletedSession, true, 'unexpected delete'); mainRecords.delete(id);
    }
  };
  const Migration = {
    async loadPrefs() { return clone(prefs); },
    async savePrefs(value) { prefs = clone(value); trace.push('prefs-write'); },
    async loadSessionTombstones() { return options.deletedSession ? { [sessionId]: true } : {}; },
    getDeletedSessionIds() { return options.deletedSession ? [sessionId] : []; },
    async runMigrationIfNeeded(key, _legacyKey, account) {
      assert.equal(key, projectId); assert.equal(account, accountScopeId);
      if (loadFails) throw new Error('synthetic main-read I/O failure');
      return { prefs: clone(prefs), sessions: clone([...mainRecords.values()]), activeSessionId: sessionId };
    }
  };
  let metadata = { revision: 0 };
  const adapter = {
    async read() { return clone(metadata); },
    async write(_scope, value) {
      if (options.failReceipt && !value.pendingCommit) throw new Error('synthetic receipt I/O failure');
      metadata = clone(value); trace.push(value.pendingCommit ? 'fence-write' : 'receipt-write');
    },
    async withLock(_scope, action) { return action(); }
  };
  const coordinator = Scoped.createController({
    Transaction: { ...Transaction, createBrowserAdapter: () => adapter },
    getAccountScopeId: () => context.cachedAccountScopeId,
    sessionStorage: { getItem: () => 'synthetic-writer-036', setItem() {} },
    chromeApi: chrome
  });
  const markdown = vm.createContext({ window: {}, fetch: denyFetch });
  vm.runInContext(markdownSource, markdown);
  const sanitizers = markdown.window.CodexOverleafMarkdownText.create({});
  const context = vm.createContext({
    state, currentRunView: null, cachedAccountScopeId: accountScopeId,
    storageKey: 'synthetic-storage-036', chrome, fetch: denyFetch, structuredClone,
    activeTurnControl, RunInputQueue, MAX_RUN_EVENTS: 300, PANEL_DEFAULT_WIDTH: 380,
    composerDraftPersistence: null,
    composerAttachmentController: { serializePersistableAttachments: () => [], clear() {}, restorePersistedAttachments() {} },
    saveStateSoon() {},
    Modules: { StorageDb: db, StorageMigration: Migration, SessionState, ComposerAttachmentDraft,
      ScopedPersistenceCoordinator: Scoped, SessionPersistence },
    getScopedPersistenceCoordinator: () => options.staleCommit ? { commit: async () => ({ ok: false, reason: 'stale_view' }) } : coordinator,
    getCurrentProjectId: () => currentProjectId, getLocale: () => 'en', tr: key => key, tx: english => english,
    localizeVisibleReason: value => value,
    findSessionById: id => state.sessions.find(session => session.id === id),
    getActiveSession: SessionState.getActiveSession,
    normalizePanelState: SessionState.normalizePanelState,
    prepareStateForStorage: SessionState.prepareStateForStorage,
    getGlobalPreferences: () => ({ overlay: input => input }),
    mapAgentEventToActivity: Transcript.mapAgentEventToActivity,
    stripEmptyHtmlCommentPlaceholders: Transcript.stripEmptyHtmlCommentPlaceholders,
    sanitizeAssistantVisibleText: sanitizers.sanitizeAssistantVisibleText,
    sanitizeAssistantVisibleValue: sanitizers.sanitizeAssistantVisibleValue,
    normalizeExperimentalOtByProject: value => value || {},
    normalizeGovernanceRulesByProject: value => value || {},
    normalizeCustomInstructionsByProject: value => value || {},
    getCodexOverleafSkillEnabled: () => ({}), getCodexLocalSkillEnabled: () => ({}),
    notifyAggressiveCompactionOnce() { trace.push('compaction-notice'); },
    appendPlainLog() { trace.push('plain-log'); },
    appendStorageNoticeOnce() { trace.push('save-failed-notice'); }
  });
  for (const name of ['recoverInterruptedRunJournals', 'upsertRunStreamRecordEvent', 'appendStreamText',
    'saveState', 'readLiveRunViewForSaveStateGuard', 'prepareCompactFallbackState',
    'buildScopedFallbackStorageKey', 'isScopedPersistenceIdentityFailure', 'isStorageQuotaError',
    'loadStoredState', 'loadStoredStateForProject', 'normalizeLoadedPanelState',
    'getComposerDraftPersistence', 'loadComposerAttachmentsForProject']) {
    vm.runInContext(extractFunction(runtimeSource, name), context, { filename: 'contentRuntime.' + name + '.js' });
  }
  return {
    state, trace, mainRecords, sessionStorage, localStorage, runJournals, context,
    run: () => context.recoverInterruptedRunJournals(),
    async reload({ mainReadFails = false } = {}) {
      loadFails = mainReadFails;
      const stored = await context.loadStoredState();
      return context.normalizeLoadedPanelState(stored);
    },
    async remainingJournals() { return activeTurnControl.listJournals(projectId); },
    restoreMainWrites() { options.mainFails = false; },
    close: () => activeTurnControl.destroy()
  };
}

function observe(t, fixture, reloaded) {
  t.diagnostic(JSON.stringify({ trace: fixture.trace,
    currentMemoryHasRecoveredText: hasMarker(fixture.state),
    durableMainHasRecoveredText: hasMarker([...fixture.mainRecords.values()]),
    fallbackHasRecoveredText: hasMarker([...fixture.localStorage.values()]),
    inMemoryJournalPresent: fixture.runJournals.has(requestId),
    sessionJournalPresent: fixture.sessionStorage.has(journalKey),
    ...(reloaded ? { reloadHasRecoveredText: hasMarker(reloaded) } : {}) }));
}

test('control: successful recovery persists replay before acknowledging journal', { timeout: 5000 }, async t => {
  const writeGate = deferred(), writeStarted = deferred();
  const f = createHarness({ writeGate, writeStarted }); t.after(f.close);
  const pending = f.run();
  await writeStarted.promise;
  assert.equal(hasMarker(f.state), true);
  assert.equal(f.trace.includes('ack-request'), false);
  assert.equal(f.sessionStorage.has(journalKey), true);
  writeGate.resolve();
  await pending;
  const reloaded = await f.reload();
  observe(t, f, reloaded);
  assert.equal(hasMarker(reloaded), true);
  assert.equal(f.state.sessions[0].runs[0].interruptedDraft.reason, 'page_owner_lost');
  assert.equal(f.state.sessions[0].pendingInputs[0].status, 'paused');
  assert.equal(f.trace.indexOf('main-sessions-write-success') < f.trace.indexOf('ack-request'), true);
  assert.equal(f.runJournals.has(requestId), false);
  assert.equal(f.sessionStorage.has(journalKey), false);
});

test('recovery runtime saves and reloads quoted token/password examples unchanged', async t => {
  const message = 'PDF token: QA_PDF_20261006_7319\ntoken: 120\npassword="example"\nsk-' + 'synthetic'.repeat(3);
  const fixture = createHarness({ message });
  t.after(fixture.close);
  await fixture.run();
  const restored = await fixture.reload();
  const event = restored.sessions[0].runs[0].events.find(item => item.kind === 'stream');
  assert.equal(event.title, message);
  assert.equal(fixture.trace.indexOf('main-sessions-write-success') < fixture.trace.indexOf('ack-request'), true);
  assert.equal(fixture.runJournals.has(requestId), false);
});

test('control: terminal journal with live shared owner is retained and not replayed', async t => {
  const f = createHarness({ ownerLost: false }); t.after(f.close);
  const before = clone(f.state);
  await f.run();
  observe(t, f);
  assert.deepEqual(clone(f.state), before);
  assert.deepEqual(f.trace, ['list-journals']);
  assert.equal(f.runJournals.has(requestId), true);
  assert.equal(f.sessionStorage.has(journalKey), true);
});

test('control: journal belonging to an unavailable session is retained', async t => {
  const f = createHarness({ missingSession: true }); t.after(f.close);
  await f.run();
  observe(t, f);
  assert.equal(hasMarker(f.state), false);
  assert.equal(f.trace.includes('ack-request'), false);
  assert.equal((await f.remainingJournals()).length, 1);
});

test('boundary control: a later successful save on the still-live page can rescue recovered text', async t => {
  const f = createHarness({ mainFails: true }); t.after(f.close);
  await f.run();
  assert.equal(hasMarker(f.state), true);
  assert.equal(f.sessionStorage.has(journalKey), true, 'failed save retains replay source');
  f.restoreMainWrites();
  await f.run();
  assert.equal(f.sessionStorage.has(journalKey), false, 'retry acknowledges only after durable recovery');
  const reloaded = await f.reload();
  observe(t, f, reloaded);
  assert.equal(hasMarker(reloaded), true);
  assert.equal(JSON.stringify(reloaded.sessions[0].runs[0].events).split(MARKER).length - 1, 1);
});

test('contract: failed main save with settings-only fallback must retain replay journal', async t => {
  const f = createHarness({ mainFails: true }); t.after(f.close);
  await f.run();
  observe(t, f);
  assert.equal(hasMarker(f.state), true, 'current in-memory recovery still exists');
  assert.equal(hasMarker([...f.mainRecords.values()]), false, 'failed I/O did not modify old durable sessions');
  const fallback = [...f.localStorage.values()][0];
  assert.equal(fallback.__codexOverleafCompactFallback, true);
  assert.equal(fallback.sessions.length, 0);
  assert.equal(fallback.runs.length, 0);
  assert.equal(f.trace.includes('save-failed-notice'), true);
  assert.equal(f.sessionStorage.has(journalKey), true, 'journal must survive until replay has durable acknowledgement');
});

test('contract: failure of both main save and fallback must not acknowledge journal', async t => {
  const f = createHarness({ mainFails: true, fallbackFails: true }); t.after(f.close);
  await f.run();
  observe(t, f);
  assert.equal(hasMarker(f.state), true);
  assert.equal(f.trace.includes('fallback-write-attempt'), true);
  assert.equal(f.trace.includes('fallback-write-success'), false);
  assert.equal(f.localStorage.size, 0);
  assert.equal(f.trace.includes('save-failed-notice'), true);
  assert.equal(f.trace.includes('ack-request'), false, 'neither persistence lane succeeded, so ack is forbidden');
});

test('contract: after main-save failure a fresh main-store load must retain a replay route', async t => {
  const f = createHarness({ mainFails: true }); t.after(f.close);
  await f.run();
  const reloaded = await f.reload();
  const remaining = await f.remainingJournals();
  observe(t, f, reloaded);
  assert.equal(hasMarker(f.state), true, 'recovery remains on original live page');
  assert.equal(reloaded.sessions.length, 1, 'older session still loads');
  assert.equal(hasMarker(reloaded) || hasMarker(remaining), true,
    'new page must obtain recovered text from durable sessions or remaining journal');
});

test('contract: fallback-only reload after main-save failure must retain a replay route', async t => {
  const f = createHarness({ mainFails: true }); t.after(f.close);
  await f.run();
  const reloaded = await f.reload({ mainReadFails: true });
  const remaining = await f.remainingJournals();
  observe(t, f, reloaded);
  assert.equal(hasMarker(f.state), true);
  assert.equal(hasMarker(reloaded) || hasMarker(remaining), true,
    'empty fallback projection must not accompany deletion of replay journal');
});

for (const [name, options] of [
  ['a stale view prevents a commit', { staleCommit: true }],
  ['the commit receipt fails after session write', { failReceipt: true }],
  ['the existing run belongs to another project', { runProjectId: 'another-project' }],
  ['a session was deleted', { deletedSession: true }],
  ['a newer durable session rejects an older recovery view', { newerSession: true }],
  ['the project changes to another valid project', { changeProjectAfterList: true }],
  ['the account changes after listing journals', { changeAccountAfterList: true }],
  ['the project disappears before save', { loseProjectAfterList: true }],
  ['the durable response omits the recovered run', { dropRunOnWrite: true }],
  ['the durable response omits recovered event content', { dropEventsOnWrite: true }]
]) test(`journal remains when ${name}`, async t => {
  const f = createHarness(options); t.after(f.close);
  await f.run();
  assert.equal(f.trace.includes('ack-request'), false);
  assert.equal(f.runJournals.has(requestId), true);
  assert.equal(f.sessionStorage.has(journalKey), true);
});

test('ordinary save retains its existing fallback and resolution semantics', async t => {
  const f = createHarness({ mainFails: true }); t.after(f.close);
  assert.equal(await f.context.saveState(), undefined);
  assert.equal(f.trace.includes('fallback-write-success'), true);
  assert.equal(f.trace.includes('save-failed-notice'), true);
});

test('a legacy run without project identity inherits the scoped journal project', async t => {
  const f = createHarness({ runProjectId: '' }); t.after(f.close);
  await f.run();
  assert.equal(f.runJournals.has(requestId), false);
  assert.equal(f.state.sessions[0].runs[0].runProjectId, projectId);
  assert.equal(hasMarker(await f.reload()), true);
});
