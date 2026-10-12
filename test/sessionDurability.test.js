'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNetwork } = require('./_helpers/sharedSessionServiceHarness');
const State = require('../extension/src/shared/sessionState');
const Db = require('../extension/src/shared/storageDb');
const Panel = require('../extension/src/content/scopedPersistencePanelState');
const Sessions = require('../extension/src/content/sessionPersistence');
const Transfer = require('../extension/src/shared/sharedSessionTransfer');
const ContextUsage = require('../extension/src/shared/contextUsage');

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
          tokenUsage: { last: { totalTokens: 218700 }, total: { totalTokens: 9876543 }, modelContextWindow: 1000000 } } } }, owner);
    const session = { ...record('s', text), codexThreadId: owner.codexThreadId, contextUsage,
      runs: [{ ...owner, contextUsage, task: text, mode: 'auto', status: 'completed',
      runProjectId: scope.projectId, ...recovery, events: [{ kind: 'report', title: 'Answer', status: 'completed', detail: text }] }] };
    const state = State.normalizePanelState({ activeSessionId: 's', sessions: [session] });
    await persist(connect(network, 1), state);
    const loaded = await connect(network, 2).getRecord('sessions', 's');
    const restored = State.normalizePanelState({ activeSessionId: 's', sessions: [loaded] });
    assert.equal(restored.task, text);
    assert.equal(restored.runs[0].task, text);
    assert.equal(restored.runs[0].events[0].detail, text);
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
