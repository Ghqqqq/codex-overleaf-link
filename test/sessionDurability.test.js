'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNetwork, deferred } = require('./_helpers/sharedSessionServiceHarness');
const State = require('../extension/src/shared/sessionState');
const Db = require('../extension/src/shared/storageDb');
const Panel = require('../extension/src/content/scopedPersistencePanelState');
const Sessions = require('../extension/src/content/sessionPersistence');
const Transfer = require('../extension/src/shared/sharedSessionTransfer');
const ContextUsage = require('../extension/src/shared/contextUsage');
const ViewSync = require('../extension/src/content/sharedSessionViewSync');

const scope = { accountScopeId: 'account-one', projectId: 'project-one' };
const record = (id, task = '') => ({ id, ...scope, task,
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z' });
const connect = (network, tab, account = scope.accountScopeId) => network.client(tab, account).bridge.decorate(Db);
const migration = { loadPrefs: async () => ({}), savePrefs: async () => {}, loadSessionTombstones: async () => ({}) };
function persist(db, state, extra = {}) {
  return Panel.persistPanelState({ state, compactState: State.prepareStateForStorage(state), projectId: scope.projectId,
    StorageDb: db, SessionPersistence: Sessions, Migration: migration, persistenceContext: { scope },
    normalizeExperimentalOtByProject: value => value || {}, normalizeGovernanceRulesByProject: value => value || {},
    normalizeCustomInstructionsByProject: value => value || {}, ...extra });
}

test('a stale tab saves its draft without reverting shared project instructions or governance', async () => {
  const network = createNetwork();
  try {
    const first = connect(network, 1), second = connect(network, 2);
    function preferences(db) {
      const context = { module: { exports: {} }, require: () => db, chrome: network.chromeApi, navigator: {} };
      require('node:vm').runInNewContext(require('node:fs').readFileSync(
        require.resolve('../extension/src/shared/storageMigration'), 'utf8'), context);
      return context.module.exports;
    }
    const firstPrefs = preferences(first), secondPrefs = preferences(second);
    const projectId = scope.projectId, account = scope.accountScopeId;
    await first.putRecord('sessions', record('settings'));
    await firstPrefs.savePrefs({
      customInstructionsByProject: { [projectId]: 'Original instructions' },
      governanceRulesByProject: { [projectId]: { readonlyPatterns: ['original.tex'], writablePatterns: [] } },
      experimentalOtByProject: { [projectId]: false },
      reviewingAvailabilityByProject: { [projectId]: { status: 'unknown', observedAt: 1 } }
    }, account, projectId);
    const load = async migration => {
      const loaded = JSON.parse(JSON.stringify(await migration.runMigrationIfNeeded(projectId, 'legacy-settings', account)));
      return State.normalizePanelState({ ...loaded.prefs, sessions: loaded.sessions, activeSessionId: loaded.activeSessionId });
    };
    const a = await load(firstPrefs), b = await load(secondPrefs);
    a.customInstructionsByProject[projectId] = 'Use the latest project instructions';
    a.governanceRulesByProject[projectId] = { readonlyPatterns: ['protected.tex'], writablePatterns: ['chapter.tex'] };
    a.experimentalOtByProject[projectId] = true;
    a.reviewingAvailabilityByProject[projectId] = { status: 'available', observedAt: 2 };
    await persist(first, a, { Migration: firstPrefs });
    const draft = State.updateActiveSessionDraft(b, 'An unrelated draft from the stale tab');
    await persist(second, draft, {
      Migration: secondPrefs,
      applyProjectPreferences: (saved, _captured, fields) => {
        for (const field of fields) draft[field] = saved[field];
      }
    });
    const stored = await secondPrefs.loadPrefs(account, projectId);
    for (const field of ['customInstructionsByProject', 'governanceRulesByProject',
      'experimentalOtByProject', 'reviewingAvailabilityByProject']) {
      assert.deepEqual(JSON.parse(JSON.stringify(stored[field])), a[field]);
      assert.deepEqual(JSON.parse(JSON.stringify(draft[field])), a[field], 'adopt the current project preference');
    }
    assert.equal((await first.getRecord('sessions', 'settings')).task, draft.task);
    draft.customInstructionsByProject[projectId] = '';
    await persist(second, draft, { Migration: secondPrefs });
    const edited = await firstPrefs.loadPrefs(account, projectId);
    assert.equal(edited.customInstructionsByProject[projectId], '', 'an intentional clear remains writable');
    assert.deepEqual(JSON.parse(JSON.stringify(edited.governanceRulesByProject)), a.governanceRulesByProject);
  } finally { network.close(); }
});

test('overlapping preference saves preserve restored instructions and read-only rules', async () => {
  const network = createNetwork();
  try {
    const db = connect(network, 1);
    const context = { module: { exports: {} }, require: () => db, chrome: network.chromeApi, navigator: {} };
    require('node:vm').runInNewContext(require('node:fs').readFileSync(
      require.resolve('../extension/src/shared/storageMigration'), 'utf8'), context);
    const Migration = context.module.exports;
    const projectId = scope.projectId, account = scope.accountScopeId;
    const original = {
      customInstructionsByProject: { [projectId]: 'Keep original instructions' },
      governanceRulesByProject: { [projectId]: { readonlyPatterns: ['protected.tex'], writablePatterns: [] } }
    };
    await db.putRecord('sessions', record('settings'));
    await Migration.savePrefs(original, account, projectId);
    const loaded = JSON.parse(JSON.stringify(await Migration.runMigrationIfNeeded(projectId, 'legacy-settings', account)));
    const state = State.normalizePanelState({ ...loaded.prefs, sessions: loaded.sessions, activeSessionId: 'settings' });
    const normalizers = { normalizeExperimentalOtByProject: value => value || {},
      normalizeGovernanceRulesByProject: value => value || {}, normalizeCustomInstructionsByProject: value => value || {} };
    function capture() {
      const snapshot = JSON.parse(JSON.stringify(state));
      const baseline = Migration.getProjectPreferenceBaseline(account, projectId);
      return { state: snapshot, compactState: State.prepareStateForStorage(snapshot), projectId,
        Migration, StorageDb: db, SessionPersistence: Sessions, persistenceContext: { scope }, ...normalizers,
        projectPreferenceBaseline: baseline,
        projectPreferenceWrite: Migration.captureProjectPreferenceWrite({
          state: snapshot, baseline, accountScopeId: account, projectId, ...normalizers
        }),
        applyProjectPreferences: (saved, captured, fields) => {
          for (const field of fields) {
            if (JSON.stringify(state[field]?.[projectId]) === JSON.stringify(captured[field]?.[projectId])) {
              state[field] = saved[field];
            }
          }
        }
      };
    }
    function restore() {
      for (const field of Object.keys(original)) state[field] = JSON.parse(JSON.stringify(original[field]));
    }
    function remove() {
      state.customInstructionsByProject[projectId] = '';
      state.governanceRulesByProject[projectId] = { readonlyPatterns: [], writablePatterns: [] };
    }
    const save = Migration.savePrefs;
    let started = deferred(), release = deferred();
    Migration.savePrefs = async (...args) => {
      started.resolve();
      await release.promise;
      return save(...args);
    };
    remove();
    const deleting = Panel.persistPanelState(capture());
    await started.promise;
    restore();
    const restored = capture();
    release.resolve();
    await deleting;
    assert.equal((await Migration.loadPrefs(account, projectId)).customInstructionsByProject[projectId], '');
    assert.equal(state.customInstructionsByProject[projectId], original.customInstructionsByProject[projectId]);
    await Panel.persistPanelState(restored);
    let stored = await Migration.loadPrefs(account, projectId);
    for (const field of Object.keys(original)) {
      assert.deepEqual(JSON.parse(JSON.stringify(stored[field])), original[field]);
      assert.deepEqual(JSON.parse(JSON.stringify(state[field])), original[field]);
    }

    // An older unchanged save must not adopt a peer value after local input
    // changed away and back, even though the live value equals its snapshot.
    started = deferred();
    release = deferred();
    const unchanged = Panel.persistPanelState(capture());
    await started.promise;
    remove();
    const intermediate = capture();
    restore();
    const latest = capture();
    await save({ customInstructionsByProject: { [projectId]: 'Peer instructions' },
      governanceRulesByProject: { [projectId]: { readonlyPatterns: ['peer.tex'], writablePatterns: [] } } }, account, projectId);
    release.resolve();
    await unchanged;
    for (const field of Object.keys(original)) assert.deepEqual(JSON.parse(JSON.stringify(state[field])), original[field]);
    await Panel.persistPanelState(intermediate);
    await Panel.persistPanelState(latest);
    stored = await Migration.loadPrefs(account, projectId);
    for (const field of Object.keys(original)) {
      assert.deepEqual(JSON.parse(JSON.stringify(stored[field])), original[field]);
      assert.deepEqual(JSON.parse(JSON.stringify(state[field])), original[field]);
    }
  } finally { network.close(); }
});

test('renaming a dashboard conversation preserves every saved run and its Undo material', async () => {
  // Exercise the rendered rename action with the real shared storage service.
  // This small DOM substitute supplies only the dashboard's browser I/O.
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    insertBefore(child, before) { child.parentElement = this; this.children.splice(this.children.indexOf(before), 0, child); }
    remove() { this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    querySelector(selector) {
      const matches = node => selector.startsWith('[')
        ? Object.hasOwn(node.attributes, selector.slice(1, -1)) : node.tag === selector;
      for (const child of this.children) {
        const found = matches(child) ? child : child.querySelector(selector);
        if (found) return found;
      }
      return null;
    }
    set innerHTML(_value) { this.children = []; }
    focus() {}
    select() {}
  }
  const network = createNetwork();
  try {
    const writer = connect(network, 1), dashboard = connect(network, 2);
    const projectId = '0123456789abcdef01234567';
    const runs = Array.from({ length: 20 }, (_, i) => ({
      id: 'run-' + i, task: 'Edit manuscript', mode: 'auto', status: 'completed', runProjectId: projectId,
      appliedOperations: [{ type: 'edit', path: 'main.tex', replaceAll: 'after-' + i }],
      undoOperations: [{ type: 'edit', path: 'main.tex', replaceAll: i ? 'before-' + i : '' }],
      undoBaseFiles: [{ path: 'main.tex', content: i ? 'before-' + i : '' }],
      undoExpectedFiles: [{ path: 'main.tex', content: 'after-' + i }],
      events: [{ kind: 'report', title: 'Answer', detail: 'Saved answer ' + i, status: 'completed' }]
    }));
    await writer.putRecord('sessions', Db.buildSessionRecord({ ...record('dashboard'), projectId, runs },
      { preserveRunActionPayload: true }));
    const before = await writer.getRecord('sessions', 'dashboard');
    assert.equal(before.runs.filter(run => run.undoOperations.length).length, 20);
    const panel = new Element('section'), saved = deferred();
    const context = { window: { location: { pathname: '/project' },
      codexOverleafDeriveAccountScopeId: () => scope.accountScopeId },
      document: { createElement: tag => new Element(tag), querySelectorAll: () => [] },
      chrome: { storage: { local: { get: async (_key, callback) => { callback?.({}); return {}; } } } },
      setInterval: () => 1 };
    require('node:vm').runInNewContext(require('node:fs').readFileSync(
      require.resolve('../extension/src/content/recentProjects'), 'utf8'), context);
    const view = context.window.CodexOverleafRecentProjects.create({
      tr: key => key, tx: en => en, getPanel: () => panel, getCachedAccountScopeId: () => scope.accountScopeId,
      PROJECT_EDITOR_RESERVED_IDS: new Set(), STATUS_BADGE_CLASS: { completed: 'completed', pending: 'pending' },
      ProjectSessionCleanup: { create: () => ({}) }, SessionState: State,
      SessionPersistence: { ...Sessions, loadTombstones: async () => ({}) },
      StorageKeys: { getProjectStorageKey: () => 'legacy-panel' },
      StorageDb: { ...dashboard, putRecord: async (...args) => {
        try { await dashboard.putRecord(...args); saved.resolve(); }
        catch (error) { saved.resolve(error); throw error; }
      } }
    });
    await view.renderRecentProjectsVariant();
    panel.querySelector('[data-session-rename-dash]').listeners.click();
    const input = panel.querySelector('input');
    input.value = 'Renamed in dashboard';
    input.listeners.keydown({ key: 'Enter', preventDefault() {} });
    assert.equal(await saved.promise, undefined);
    const after = await connect(network, 3).getRecord('sessions', 'dashboard');
    assert.equal(after.title, 'Renamed in dashboard');
    assert.equal(after.titleSource, 'manual');
    assert.deepEqual(after.runs, before.runs);
  } finally { network.close(); }
});

test('saved conversation text and recovery survive a new page without crossing account scope', async () => {
  const network = createNetwork();
  try {
    const text = '中文🙂 manuscript password=example-value';
    const recovery = { undoOperations: [{ type: 'edit', path: 'main.tex', replaceAll: '' }],
      undoBaseFiles: [{ path: 'main.tex', content: text }], undoExpectedFiles: [{ path: 'main.tex', content: '' }] };
    const owner = { id: 'r', codexThreadId: 'thread-one', codexTurnId: 'turn-one',
      providerId: 'builtin', providerRevision: 0, model: 'example-model' };
    const contextUsage = ContextUsage.fromEvent({ type: 'codex.session.event', nativeEventSeq: 3,
      timestamp: '2026-10-12T00:00:00Z', detail: { method: 'thread/tokenUsage/updated',
        params: { threadId: owner.codexThreadId, turnId: owner.codexTurnId,
          tokenUsage: { last: { totalTokens: 218700, inputTokens: 210000, outputTokens: 8700, cachedInputTokens: 150000 },
            total: { totalTokens: 9876543 }, modelContextWindow: 1000000 } } } }, owner);
    const session = { ...record('s', text), codexThreadId: owner.codexThreadId, contextUsage,
      runs: [{ ...owner, contextUsage, task: text, mode: 'auto', status: 'completed',
      runProjectId: scope.projectId, ...recovery, events: [{ kind: 'report', title: 'Answer', status: 'completed', detail: text }] }] };
    let state = State.normalizePanelState({ activeSessionId: 's', sessions: [session] });
    const liveRun = state.runs[0], draft = '下一轮草稿：中文输入🙂';
    state = State.updateActiveSessionDraft(state, draft);
    liveRun.events.push({ kind: 'assistant', title: 'Later response', status: 'completed', detail: 'Arrived while typing' });
    await persist(connect(network, 1), state);
    const loaded = await connect(network, 2).getRecord('sessions', 's');
    const restored = State.normalizePanelState({ activeSessionId: 's', sessions: [loaded] });
    assert.equal(restored.task, draft);
    assert.equal(restored.runs[0].task, text);
    assert.equal(restored.runs[0].events[0].detail, text);
    assert.equal(restored.runs[0].events.at(-1).detail, 'Arrived while typing');
    assert.deepEqual(restored.runs[0].undoBaseFiles, recovery.undoBaseFiles);
    assert.deepEqual(restored.runs[0].undoExpectedFiles, recovery.undoExpectedFiles);
    assert.equal(contextUsage.usedTokens, 218700);
    assert.deepEqual(restored.session.contextUsage, contextUsage);
    assert.deepEqual(restored.runs[0].contextUsage, contextUsage);
    assert.deepEqual(ContextUsage.select(restored.sessions[0], owner), contextUsage);
    assert.equal(ContextUsage.select(restored.sessions[0], { ...owner, providerRevision: 1 }), null);
    assert.equal(ContextUsage.select(restored.sessions[0], { ...owner, codexThreadId: 'replacement-thread' }), null);
    assert.equal((await connect(network, 3, 'other-account').getAllByIndex('sessions', 'projectId', scope.projectId)).length, 0);
  } finally { network.close(); }
});

test('display-only shared reads preserve the visible baseline so an idle page adopts a remote run', { timeout: 5000 }, async () => {
  const network = createNetwork();
  let sync;
  try {
    const writer = connect(network, 1), peer = network.client(2), db = peer.bridge.decorate(Db);
    await writer.putRecords('sessions', [record('s')]);
    let state = State.normalizePanelState({ activeSessionId: 's',
      sessions: await db.claimSessionsForAccount(scope.projectId, scope.accountScopeId) });
    assert.equal(db.wasSharedSessionStored('s'), true);
    assert.equal(db.hasUnpersistedSharedSession(state.sessions[0]), false);
    assert.equal(db.hasUnpersistedSharedSession({ ...state.sessions[0], task: 'Unsaved edit' }), true,
      'hydration adopts the visible baseline');
    const adoptingReader = connect(network, 3);
    const [older] = await adoptingReader.claimSessionsForAccount(scope.projectId, scope.accountScopeId);
    let applied = deferred();
    const errors = [], checkedDrafts = [];
    sync = ViewSync.install({ Bridge: peer.bridge, StorageDb: db,
      getScope: () => ({ ...scope, generation: 1 }), getState: () => state, setState: next => { state = next; },
      normalize: State.normalizePanelState, render: () => applied.resolve(), isBusy: () => false,
      hasLocalDraft: current => { checkedDrafts.push(current.task); return false; },
      notice: error => errors.push(error) });
    const draft = 'Shared draft';
    await writer.putRecords('sessions', [{ ...await writer.getRecord('sessions', 's'),
      task: draft, updatedAt: '2026-10-13T00:00:00Z' }]);
    await applied.promise;
    assert.equal(state.task, draft);
    assert.equal(state.sessions[0].task, draft);
    assert.equal(db.hasUnpersistedSharedSession(state.sessions[0]), false,
      'the imported draft is a clean shared baseline');
    applied = deferred();
    const run = { id: 'remote-run', task: draft, status: 'completed', runProjectId: scope.projectId,
      events: [{ kind: 'assistant', title: 'Answer', detail: 'A durable answer', status: 'completed' }] };
    await writer.putRecords('sessions', [{ ...await writer.getRecord('sessions', 's'),
      task: '', updatedAt: '2026-10-14T00:00:00Z', runs: [run] }]);
    const reads = [
      () => db.getRecord('sessions', 's', { adopt: false }),
      () => db.getAllByIndex('sessions', 'projectId', scope.projectId),
      () => db.getAllSessions(),
      () => db.listRecentProjectsAcrossAccount({ accountScopeId: scope.accountScopeId })
    ];
    for (const read of reads) {
      await read();
      assert.equal(db.hasUnpersistedSharedSession(state.sessions[0]), false,
        'a storage read must not make the unchanged visible session look edited');
    }
    assert.equal((await adoptingReader.getRecord('sessions', 's')).runs[0].id, run.id);
    assert.equal(adoptingReader.hasUnpersistedSharedSession(older), true,
      'ordinary single-record reads still adopt the stored baseline');
    await applied.promise;
    assert.deepEqual(errors, []);
    assert.ok(checkedDrafts.includes(draft), 'the imported nonempty draft is checked on the later refresh');
    assert.equal(state.task, '');
    assert.equal(state.sessions[0].task, '');
    assert.equal(state.runs[0].task, draft);
    assert.deepEqual(state.runs.map(item => item.id), [run.id]);
    assert.equal(state.runs[0].events[0].detail, run.events[0].detail);
    assert.equal(state.sessions[0].updatedAt, '2026-10-14T00:00:00Z');
    assert.equal(db.hasUnpersistedSharedSession(state.sessions[0]), false,
      'successful passive application adopts the new visible baseline');
  } finally { sync?.dispose(); network.close(); }
});

test('a draft edited in this page defers passive shared history updates after saving', { timeout: 5000 }, async () => {
  const network = createNetwork();
  let sync;
  try {
    const peer = network.client(1), db = peer.bridge.decorate(Db), writer = connect(network, 2);
    const draft = 'typed-in-a';
    await db.putRecords('sessions', [record('s', draft)]);
    let state = State.normalizePanelState({ activeSessionId: 's',
      sessions: await db.claimSessionsForAccount(scope.projectId, scope.accountScopeId) });
    assert.equal(db.hasUnpersistedSharedSession(state.sessions[0]), false,
      'the draft is already saved, so only the composer guard can defer refresh');
    const original = state, attempted = deferred(), errors = [];
    let reads = 0, renders = 0, checkedState;
    sync = ViewSync.install({ Bridge: peer.bridge,
      StorageDb: { ...db, readSharedProjectSnapshot: (...args) => {
        reads++; return db.readSharedProjectSnapshot(...args);
      } },
      getScope: () => ({ ...scope, generation: 1 }), getState: () => state, setState: next => { state = next; },
      normalize: State.normalizePanelState, render: () => { renders++; },
      isBusy: () => { attempted.resolve(); return false; },
      hasLocalDraft: current => { checkedState = current; return true; },
      notice: error => errors.push(error) });
    const run = { id: 'remote-run', task: 'B finished a task', status: 'completed', runProjectId: scope.projectId };
    await writer.putRecords('sessions', [{ ...await writer.getRecord('sessions', 's'),
      task: '', updatedAt: '2026-10-14T00:00:00Z', runs: [run] }]);
    await attempted.promise;
    assert.deepEqual(errors, []);
    assert.equal(checkedState, original, 'the draft callback receives the visible state');
    assert.equal(reads, 0, 'refresh defers before reading a replacement snapshot');
    assert.equal(renders, 0);
    assert.equal(state, original);
    assert.equal(state.task, draft);
    assert.equal(state.sessions[0].task, draft);
    assert.deepEqual(state.runs, []);
  } finally { sync?.dispose(); network.close(); }
});

test('an older shared draft is durably merged with a newer remote run', async () => {
  const network = createNetwork();
  try {
    const writer = connect(network, 1), peer = connect(network, 2);
    await writer.putRecords('sessions', [writer.buildSessionRecord(record('s'))]);
    const [older] = await peer.claimSessionsForAccount(scope.projectId, scope.accountScopeId);
    const draft = peer.buildSessionRecord({ ...older, task: 'B draft 中文🙂', updatedAt: '2026-10-13T00:00:00Z' });
    const run = { id: 'remote-run', task: 'A finished task', status: 'completed', runProjectId: scope.projectId,
      events: [{ kind: 'assistant', title: 'Answer', detail: 'A durable answer', status: 'completed' }] };
    await writer.putRecords('sessions', [{ ...await writer.getRecord('sessions', 's'),
      updatedAt: '2026-10-14T00:00:00Z', runs: [run] }]);
    const written = await Sessions.writeSessions({ StorageDb: peer, Migration: migration, ...scope,
      sessionRecords: [draft] });
    assert.deepEqual(written.map(item => item.id), ['s']);
    assert.equal(written[0].task, draft.task);
    assert.deepEqual(written[0].runs, [run], 'the acknowledgement contains the durable merge, not just the local proposal');
    const stored = await connect(network, 3).getRecord('sessions', 's');
    assert.equal(stored.task, draft.task);
    assert.deepEqual(stored.runs, [run]);
    assert.equal(stored.updatedAt, '2026-10-14T00:00:00Z');
  } finally { network.close(); }
});

// Publication and guarded consumption share a baseline; later progress must
// preserve peer edits and the provenance of subsequent submissions.
test('submitted draft consumption preserves a peer edit (consumption saves first)', async () => {
  const network = createNetwork();
  try {
    const a = connect(network, 1), b = connect(network, 2);
    let stateA = State.normalizePanelState({ activeSessionId: 's', sessions: [{ ...record('s', 'Edit manuscript'),
      runs: [{ id: 'r', task: 'Edit manuscript', status: 'running', runProjectId: scope.projectId }] }] });
    await persist(a, stateA);
    let stateB = State.normalizePanelState({ activeSessionId: 's',
      sessions: await b.claimSessionsForAccount(scope.projectId, scope.accountScopeId) });
    stateB = State.renameSession(State.updateActiveSessionDraft(stateB, 'Peer next draft'), 's', 'Peer title');
    stateA = State.updateActiveSession(stateA, { task: '' });
    stateA.sessions[0].draftConsumption = { runId: 'r', task: 'Edit manuscript' };
    await persist(a, stateA);
    const consumedState = stateA;
    await persist(a, State.updateActiveSession(stateA, { projectReferenceFiles: [] }));
    await persist(b, stateB);
    assert.equal((await connect(network, 4).getRecord('sessions', 's')).draftConsumption, undefined,
      'editing the task retires its consumption marker');
    // An unrelated normalization drops page-local metadata; later progress
    // still uses this page's own submitted envelope as its merge ancestor.
    stateA = State.updateActiveSession(stateA, { projectReferenceFiles: [] });
    stateA.runs[0].nativeEventSeq = 2;
    await persist(a, stateA);
    stateA.runs[0].nativeEventSeq = 3;
    await persist(a, stateA);
    const fresh = State.normalizePanelState({ activeSessionId: 's',
      sessions: await connect(network, 3).claimSessionsForAccount(scope.projectId, scope.accountScopeId) });
    assert.equal(fresh.task, 'Peer next draft');
    assert.equal(fresh.sessions[0].title, 'Peer title');
    assert.equal(fresh.sessions[0].titleSource, 'manual');
    assert.equal(fresh.runs[0].nativeEventSeq, 3);
    stateB = State.updateActiveSessionDraft(stateB, 'Peer later draft');
    await persist(b, stateB);
    assert.equal((await connect(network, 4).getRecord('sessions', 's')).task, 'Peer later draft');
    // A stale running page must not replace a later submission's provenance
    // when both pages still display an empty composer.
    let next = stateB;
    next = State.updateActiveSession(next, { runs: [...next.runs,
      { id: 'next-run', task: 'Peer later draft', status: 'running', runProjectId: scope.projectId }] });
    await persist(b, next);
    const c = connect(network, 4);
    const third = State.normalizePanelState({ activeSessionId: 's',
      sessions: await c.claimSessionsForAccount(scope.projectId, scope.accountScopeId) });
    next = State.updateActiveSession(next, { task: '' });
    next.sessions[0].draftConsumption = { runId: 'next-run', task: 'Peer later draft' };
    await persist(b, next);
    await persist(a, consumedState);
    assert.equal((await connect(network, 5).getRecord('sessions', 's')).draftConsumption.runId, 'next-run');
    await persist(c, State.updateActiveSessionDraft(third, 'Third draft'));
    assert.equal((await connect(network, 6).getRecord('sessions', 's')).task, 'Third draft');
  } finally { network.close(); }
});

test('live thread reset and detached thread patches never adopt an unseen peer envelope', async () => {
  for (const detached of [false, true]) {
    const network = createNetwork();
    try {
      const a = connect(network, 1), b = connect(network, 2);
      let stateA = State.normalizePanelState({ activeSessionId: 's', sessions: [{ ...record('s'),
        codexThreadId: 'old-thread', title: 'Edit manuscript', titleSource: 'auto',
        runs: [{ id: 'r', task: 'Edit manuscript', status: 'running', runProjectId: scope.projectId }] }] });
      await persist(a, stateA);
      let stateB = State.normalizePanelState({ activeSessionId: 's', sessions: await b.claimSessionsForAccount(scope.projectId, scope.accountScopeId) });
      stateB = State.renameSession(State.updateActiveSessionDraft(stateB, 'Peer draft'), 's', 'Peer title');
      await persist(b, stateB);
      if (detached) {
        const fetched = await a.getRecord('sessions', 's', { adopt: false });
        fetched.codexThreadId = '';
        await a.putRecord('sessions', fetched, { adopt: false });
      } else {
        // The live thread_resume_failed -> new branch submits this view through
        // saveState, rather than reading and patching a remote full record.
        stateA = State.updateActiveSession(stateA, { codexThreadId: '' });
        await persist(a, stateA);
      }
      assert.equal(a.hasUnpersistedSharedSession(stateA.sessions[0]), false);
      stateA = State.updateActiveSession(stateA, { projectReferenceFiles: [] });
      stateA.runs[0].nativeEventSeq = 2;
      await persist(a, stateA);
      let fresh = await connect(network, 3).getRecord('sessions', 's');
      assert.equal(fresh.task, 'Peer draft');
      assert.equal(fresh.title, 'Peer title');
      assert.equal(fresh.codexThreadId, '');
      stateB = State.renameSession(State.updateActiveSessionDraft(stateB, 'Peer second draft'), 's', 'Peer second title');
      await persist(b, stateB);
      fresh = await connect(network, 4).getRecord('sessions', 's');
      assert.equal(fresh.task, 'Peer second draft');
      assert.equal(fresh.title, 'Peer second title');
    } finally { network.close(); }
  }
});

test('derived titles and summaries yield to a peer rename and draft, including legacy normalization', async () => {
  for (const legacy of [false, true]) {
    const network = createNetwork();
    try {
      const a = connect(network, 1), b = connect(network, 2);
      const initial = Db.buildSessionRecord({ ...record('s'), title: legacy ? '' : 'Original title', titleSource: 'auto',
        runs: [{ id: 'r', task: 'Original title', status: 'running', runProjectId: scope.projectId }] });
      if (legacy) delete initial.titleSource;
      network.db.seed('sessions', { ...scope, id: 's', record: initial, revision: 1 });
      const aView = State.normalizePanelState({ activeSessionId: 's', sessions: await a.claimSessionsForAccount(scope.projectId, scope.accountScopeId) });
      let bView = State.normalizePanelState({ activeSessionId: 's', sessions: await b.claimSessionsForAccount(scope.projectId, scope.accountScopeId) });
      bView = State.renameSession(State.updateActiveSessionDraft(bView, 'Peer task'), 's', 'Manual peer title');
      await persist(b, bView);
      const autoView = State.updateActiveSession(aView, { title: 'Automatic next run title',
        updatedAt: '2026-10-13T00:00:00Z' });
      await persist(a, autoView);
      const fresh = await connect(network, 3).getRecord('sessions', 's');
      assert.equal(fresh.task, 'Peer task');
      assert.equal(fresh.title, 'Manual peer title');
      assert.equal(fresh.titleSource, 'manual');
      assert.equal(fresh.safeTaskSummary, State.computeSafeTaskSummary('Peer task'));
      const current = State.normalizePanelState({ activeSessionId: 's',
        sessions: await a.claimSessionsForAccount(scope.projectId, scope.accountScopeId) });
      await persist(a, State.renameSession(current, 's', 'First manual rename'));
      await assert.rejects(persist(b, State.renameSession(bView, 's', 'Conflicting manual rename')),
        { code: 'shared_session_conflict' });
      assert.equal((await connect(network, 4).getRecord('sessions', 's')).title, 'First manual rename');
    } finally { network.close(); }
  }
});

test('an older shared draft still fails closed when the remote draft also changed', async () => {
  const network = createNetwork();
  try {
    const writer = connect(network, 1), peer = connect(network, 2);
    await writer.putRecords('sessions', [writer.buildSessionRecord(record('s', 'Original draft'))]);
    const [older] = await peer.claimSessionsForAccount(scope.projectId, scope.accountScopeId);
    const draft = peer.buildSessionRecord({ ...older, task: 'Local draft', title: 'Local title', titleSource: 'manual',
      updatedAt: '2026-10-13T00:00:00Z' });
    await writer.putRecords('sessions', [{ ...await writer.getRecord('sessions', 's'),
      task: 'Remote draft', title: 'Remote title', titleSource: 'manual', updatedAt: '2026-10-14T00:00:00Z' }]);
    // An unmarked manual clear is an edit, even when a submitted clear would merge.
    const cleared = peer.buildSessionRecord({ ...older, task: '' });
    await assert.rejects(Sessions.writeSessions({ StorageDb: peer, Migration: migration, ...scope,
      sessionRecords: [cleared] }), { code: 'shared_session_conflict' });
    await assert.rejects(Sessions.writeSessions({ StorageDb: peer, Migration: migration, ...scope,
      sessionRecords: [draft] }), { code: 'shared_session_conflict' });
    assert.equal((await writer.getRecord('sessions', 's')).task, 'Remote draft');
    assert.equal(draft.task, 'Local draft');
    assert.equal((await writer.getRecord('sessions', 's')).title, 'Remote title');
    assert.equal(draft.title, 'Local title');
  } finally { network.close(); }
});

test('a mismatched scope or a deleted session cannot be saved back over durable history', async () => {
  const network = createNetwork();
  try {
    const db = connect(network, 1), state = State.normalizePanelState({ activeSessionId: 's', sessions: [record('s', 'Keep')] });
    await persist(db, state);
    await assert.rejects(persist(db, state, { persistenceContext: { scope: { ...scope, projectId: 'other-project' } } }), { code: 'stale_view' });
    assert.equal((await db.getRecord('sessions', 's')).task, 'Keep');
    await persist(db, state, { deletedSessionIds: ['s'] });
    assert.equal(await db.getRecord('sessions', 's'), null);
    await assert.rejects(persist(db, state), { code: 'shared_session_deleted' });
    assert.equal(await connect(network, 2).getRecord('sessions', 's'), null);
  } finally { network.close(); }
});

test('withheld Undo reasons survive normalization, fallback compaction and durable reload without gaining write authority', async () => {
  const Undo = require('../extension/src/shared/undoOperations');
  const Settlement = require('../extension/src/shared/writebackSettlement');
  const network = createNetwork();
  try {
    const unavailable = { path: 'main.tex', code: 'stale_source_changed' };
    const operation = { type: 'edit', path: 'main.tex', patches: [{ from: 0, to: 1, expected: 'a', insert: '' }],
      appliedPatches: [{ from: 0, to: 1, expected: 'a', insert: '' }], verifiedContent: 'collaborator text',
      undoUnavailable: unavailable };
    const session = { ...record('withheld'), runs: [{ id: 'r', runProjectId: scope.projectId,
      task: 'Edit', mode: 'auto', status: 'completed', undoStatus: 'partial', appliedOperations: [operation],
      undoOperations: [], undoBaseFiles: [], undoExpectedFiles: [], events: [] }] };
    const state = State.normalizePanelState({ activeSessionId: session.id, sessions: [session] });
    assert.deepEqual(Undo.getUndoUnavailableFiles(state.runs[0]), [unavailable]);
    assert.deepEqual(State.pickWritebackRecovery(state.runs[0]), {}, 'the reason grants no retry/save-check authority');
    const fallback = State.prepareStateForStorage(state);
    assert.deepEqual(fallback.sessions[0].runs[0].appliedOperations,
      [{ type: 'edit', path: 'main.tex', undoUnavailable: unavailable }], 'fallback history keeps no document content');
    assert.deepEqual(Undo.getUndoUnavailableFiles(State.normalizePanelState(JSON.parse(JSON.stringify(fallback))).runs[0]), [unavailable]);
    const projected = Db.buildSessionRecord(state.sessions[0], { preserveRunActionPayload: true });
    assert.deepEqual(projected.runs[0].appliedOperations[0], operation);
    assert.deepEqual(Undo.getUndoUnavailableFiles(Db.buildSessionRecord(state.sessions[0],
      { preserveRunActionPayload: false }).runs[0]), [unavailable]);
    await persist(connect(network, 1), state);
    const loaded = JSON.parse(JSON.stringify(await connect(network, 2).getRecord('sessions', session.id)));
    const restored = State.normalizePanelState({ activeSessionId: session.id, sessions: [loaded] }).runs[0];
    assert.deepEqual(restored.appliedOperations[0], operation);
    assert.deepEqual(Undo.getUndoUnavailableFiles(restored), [unavailable]);
    assert.equal(Settlement.projectRunSettlement(restored).canUndo, false);
    assert.deepEqual(Undo.buildSnapshotRestoreUndo(Undo.prepareRunUndo(restored)).operations, []);
  } finally { network.close(); }
});

test('compressed multi-record conflict is atomic; rereading permits a lossless retry', async () => {
  const network = createNetwork();
  try {
    const writer = connect(network, 1), peer = connect(network, 2);
    const largeText = 'x'.repeat(Math.ceil(Transfer.MAX_WIRE_BYTES / 2) + 1024);
    await writer.putRecords('sessions', [record('large', largeText), record('small', 'original')]);
    const large = await writer.getRecord('sessions', 'large'), small = await writer.getRecord('sessions', 'small');
    await peer.putRecords('sessions', [{ ...await peer.getRecord('sessions', 'small'), task: 'Remote change' }]);
    await assert.rejects(writer.putRecords('sessions', [{ ...large, title: 'Local title' }, { ...small, task: 'Conflicting change' }]),
      { code: 'shared_session_conflict' });
    assert.equal((await writer.getRecord('sessions', 'large')).title, undefined);
    assert.equal((await writer.getRecord('sessions', 'small')).task, 'Remote change');
    const latestLarge = await writer.getRecord('sessions', 'large'), latestSmall = await writer.getRecord('sessions', 'small');
    await writer.putRecords('sessions', [{ ...latestLarge, title: 'Local title' }, { ...latestSmall, title: 'Independent title' }]);
    const saved = await peer.getRecord('sessions', 'large');
    assert.equal(saved.task, largeText);
    assert.equal(saved.title, 'Local title');
    assert.equal((await peer.getRecord('sessions', 'small')).task, 'Remote change');
    assert.ok(network.messages.some(item => item.message.method === 'put-compressed'));
  } finally { network.close(); }
});

test('oversized new data leaves durable history intact and a later valid save succeeds', async () => {
  const network = createNetwork();
  try {
    const db = connect(network, 1);
    await db.putRecords('sessions', [record('s', 'Saved manuscript')]);
    const previous = await db.getRecord('sessions', 's');
    await assert.rejects(db.putRecords('sessions', [{ ...previous, task: 'x'.repeat(Transfer.MAX_RECORD_BYTES) }]),
      { code: 'shared_session_too_large' });
    assert.equal((await db.getRecord('sessions', 's')).task, 'Saved manuscript');
    await db.putRecords('sessions', [{ ...previous, task: 'Valid retry' }]);
    assert.equal((await connect(network, 2).getRecord('sessions', 's')).task, 'Valid retry');
  } finally { network.close(); }
});

test('compile repair diagnostics and rejected hunks survive shared storage and hydration within display limits', async () => {
  const Compile = require('../extension/src/shared/compileAdapter');
  const Transcript = require('../extension/src/shared/agentTranscript');
  const Completion = require('../extension/src/content/runCompletionMeta');
  const network = createNetwork();
  try {
    const compileErrors = ['Undefined control sequence.\nl.119 \\undefinedcommandxyz', 'x'.repeat(4000),
      ...Array.from({ length: 5 }, (_, i) => 'LaTeX error ' + i)];
    const rejectedHunks = Array.from({ length: 12 }, (_, i) => ({
      path: i ? `chapter-${i}.tex` : 'p'.repeat(300) + '.tex',
      summary: i ? `Rejected edit ${i}` : 's'.repeat(4000), privatePayload: 'must not persist'
    }));
    const errors = compileErrors.slice(0, 3).map(Compile.formatCompileDiagnosticForSummary);
    const prefix = 'Updated the document.';
    const report = Transcript.buildHumanCompletionReport({ status: 'completed',
      conclusion: prefix + '\nPost-write compile check: 7 remaining error(s): ' + errors.join('; '),
      conclusionSource: { origin: 'product', key: 'writeback', outcome: 'synced', prefixLength: prefix.length,
        hasCompile: true, compileStatus: 'failed', errorCount: 7, errors } });
    const session = { ...record('compile-repair'), runs: [{ id: 'r', task: 'Compile check', mode: 'auto',
      status: 'completed', runProjectId: scope.projectId, events: [{ kind: 'report', title: report.title, status: report.status,
        detail: report.text, detailStructured: report.structured, compileErrors, rejectedHunks }] }] };
    const projected = Db.buildSessionRecord(session).runs[0].events[0];
    assert.equal(projected.compileErrors.length, 5);
    assert.equal(projected.compileErrors[0], compileErrors[0]);
    assert.equal(projected.compileErrors[1].length, 3000);
    assert.equal(projected.rejectedHunks.length, 10);
    assert.equal(projected.rejectedHunks[0].path.length, 240);
    assert.equal(projected.rejectedHunks[0].summary.length, 3000);
    assert.ok(projected.rejectedHunks.every(item => !('privatePayload' in item)));
    await persist(connect(network, 1), State.normalizePanelState({ activeSessionId: session.id, sessions: [session] }));
    const loaded = JSON.parse(JSON.stringify(await connect(network, 2).getRecord('sessions', session.id)));
    const run = State.normalizePanelState({ activeSessionId: session.id, sessions: [loaded] }).runs[0];
    const restored = run.events[0];
    assert.deepEqual(restored.compileErrors, projected.compileErrors);
    assert.deepEqual(restored.rejectedHunks, projected.rejectedHunks);
    assert.equal(restored.detailStructured.conclusionSource.compileStatus, 'failed');
    for (const locale of ['en', 'zh']) {
      const outcome = Completion.projectFinishedRun(run, locale);
      assert.equal(outcome.kind, 'compile-errors');
      assert.equal(outcome.compileCount, 7);
      assert.deepEqual(outcome.compileErrors, errors);
    }
  } finally { network.close(); }
});
