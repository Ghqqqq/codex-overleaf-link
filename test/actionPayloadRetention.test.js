'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnvironment, clone } = require('./_helpers/sharedStorageHarness');
const SessionState = require('../extension/src/shared/sessionState');
const SessionPersistence = require('../extension/src/content/sessionPersistence');
const PanelState = require('../extension/src/content/scopedPersistencePanelState');
const Actions = require('../extension/src/shared/storageRunActions');
const Settlement = require('../extension/src/shared/writebackSettlement');
const Transfer = require('../extension/src/shared/sharedSessionTransfer');

function run(id, chars = 10, extra = {}) {
  const before = 'a'.repeat(chars), after = before + '\n% appended';
  return { id, mode: 'auto', status: 'completed', runProjectId: 'project-a',
    appliedOperations: [{ type: 'edit', path: 'main.tex', replaceAll: after }],
    undoOperations: [{ type: 'edit', path: 'main.tex', replaceAll: before }],
    undoBaseFiles: [{ path: 'main.tex', content: after }],
    undoExpectedFiles: [], undoTrackedChanges: [], events: [], ...extra };
}
function session(runs) {
  return { id: 'retention-session', projectId: 'project-a', accountScopeId: 'account-one',
    title: 'Retention', titleSource: 'manual', updatedAt: '2026-10-04T00:00:00Z', runs };
}
async function persist(h, runs) {
  const state = SessionState.normalizePanelState({ sessions: [session(runs)], activeSessionId: 'retention-session' });
  await PanelState.persistPanelState({ state, compactState: SessionState.prepareStateForStorage(state),
    projectId: h.projectId, Migration: h.Migration, StorageDb: h.StorageDb, SessionPersistence,
    normalizeExperimentalOtByProject: value => value || {}, normalizeGovernanceRulesByProject: value => value || {},
    normalizeCustomInstructionsByProject: value => value || {},
    persistenceContext: { scope: { accountScopeId: h.accountScopeId, projectId: h.projectId }, nextMeta: {}, writerId: 'retention' } });
  const records = await h.StorageDb.getAllByIndex('sessions', 'projectId', h.projectId);
  return SessionState.normalizePanelState({ sessions: records, activeSessionId: 'retention-session' }).sessions[0].runs;
}

test('all retained ordinary runs survive the real shared writer and reader, including a payload over 2 MiB', async () => {
  const h = createEnvironment();
  try {
    const originals = Array.from({ length: 20 }, (_, i) => run('edit-' + i, i === 19 ? 819201 : 20));
    const restored = await persist(h, originals);
    assert.equal(restored.length, originals.length);
    for (let i = 0; i < restored.length; i++) {
      assert.deepEqual(clone(restored[i].undoOperations), originals[i].undoOperations);
      assert.deepEqual(clone(restored[i].undoBaseFiles), originals[i].undoBaseFiles);
      assert.equal(Settlement.projectRunSettlement(restored[i]).canUndo, true);
      assert.notEqual(restored[i].recoveryRetention?.state, 'omitted');
    }
    const repeated = await persist(h, restored);
    assert.deepEqual(repeated.map(r => r.undoOperations), restored.map(r => r.undoOperations));
  } finally { h.close(); }
});

test('an oversized newest run never prevents older small runs from retaining recovery data', () => {
  const h = createEnvironment();
  try {
    const record = h.StorageDb.buildSessionRecord(session([run('older'), run('newest', 6 * 1024 * 1024)]), { preserveRunActionPayload: true });
    assert.equal(record.runs[0].undoOperations.length, 1);
    assert.equal(record.runs[1].undoOperations.length, 0);
    assert.equal(record.runs[1].recoveryRetention.state, 'omitted');
    assert.equal(record.runs[1].recoveryRetention.reason, 'run-budget');
    const restored = SessionState.normalizePanelState({ sessions: [record], activeSessionId: record.id }).sessions[0].runs;
    assert.deepEqual(restored[1].recoveryRetention, record.runs[1].recoveryRetention);
    assert.equal(Settlement.projectRunSettlement(restored[1]).canUndo, false);
  } finally { h.close(); }
});

test('summary fallback explicitly identifies missing action data without storing document content', () => {
  const original = run('fallback', 50);
  const compact = SessionState.prepareStateForStorage({ sessions: [session([original])], activeSessionId: 'retention-session' });
  const stored = compact.sessions[0].runs[0];
  assert.equal(stored.undoOperations.length, 0);
  assert.equal(stored.recoveryRetention?.state, 'omitted');
  assert.equal(stored.recoveryRetention.reason, 'fallback');
  assert.equal(JSON.stringify(compact).includes('a'.repeat(50)), false);
});

test('actual display record size reserves transport capacity before choosing checkpoints', async () => {
  const h = createEnvironment();
  try {
    const originals = Array.from({ length: 8 }, (_, i) => run('large-' + i, 1024 * 1024, {
      events: Array.from({ length: 100 }, (_, j) => ({ kind: 'activity', status: 'completed',
        title: `Event ${i} ${j} ` + 'z'.repeat(14 * 1024) }))
    }));
    const record = h.StorageDb.buildSessionRecord(session(originals), { preserveRunActionPayload: true });
    assert.doesNotThrow(() => Transfer.validateRecord(record));
    assert.ok(record.runs.some(r => r.recoveryRetention?.reason === 'session-budget'));
    assert.ok(record.runs.at(-1).undoOperations.length);
    const restored = await persist(h, originals);
    assert.deepEqual(restored.map(r => r.undoOperations.length), record.runs.map(r => r.undoOperations.length));
    assert.deepEqual(restored.map(r => r.events.length), originals.map(r => r.events.length));
  } finally { h.close(); }
});

test('optional captures cannot displace core payloads, and terminal or fork runs consume no recovery budget', () => {
  const h = createEnvironment();
  try {
    const record = h.StorageDb.buildSessionRecord(session([
      run('small'), run('medium', 819201), run('terminal', 6 * 1024 * 1024, { undoStatus: 'applied' }),
      run('fork', 6 * 1024 * 1024, { forkSnapshot: true }),
      run('newest', 10, { trackedChangeCaptures: [{ text: 'c'.repeat(16 * 1024 * 1024) }] })
    ]), { preserveRunActionPayload: true });
    assert.deepEqual(record.runs.map(r => r.undoOperations.length), [1, 1, 0, 0, 1]);
    assert.equal(record.runs.at(-1).trackedChangeCaptures, undefined);
    assert.equal(record.runs[2].recoveryRetention, undefined);
    assert.equal(record.runs[3].recoveryRetention, undefined);
  } finally { h.close(); }
});

test('the existing UTF-16 compatibility window retains small recovery data beside large Unicode history', () => {
  const h = createEnvironment();
  try {
    const original = run('unicode', 256 * 1024, {
      events: Array.from({ length: 80 }, (_, index) => ({ kind: 'activity', status: 'completed',
        title: `${index}` + '中'.repeat(128 * 1024 - 8) }))
    });
    const record = h.StorageDb.buildSessionRecord(session([original]), { preserveRunActionPayload: true });
    assert.ok(Transfer.byteLength(JSON.stringify(record)) > Transfer.MAX_WIRE_BYTES);
    assert.doesNotThrow(() => Transfer.validateRecord(record));
    assert.deepEqual(record.runs[0].undoOperations, original.undoOperations);
  } finally { h.close(); }
});

test('multiple sessions share the actual response budget without sacrificing display history', () => {
  const h = createEnvironment();
  try {
    const records = Array.from({ length: 3 }, (_, index) => h.StorageDb.buildSessionRecord({
      ...session(Array.from({ length: 6 }, (_, ri) => run(`s${index}-r${ri}`, 819201))), id: 'session-' + index
    }, { preserveRunActionPayload: true }));
    assert.ok(Transfer.byteLength(JSON.stringify(records)) > Transfer.MAX_RESPONSE_BYTES);
    const compact = h.StorageDb.compactSessionBatchActions(records, { activeSessionId: 'session-2' });
    assert.doesNotThrow(() => Transfer.validateResponse(compact));
    for (const record of compact) assert.doesNotThrow(() => Transfer.validateRecord(record));
    assert.deepEqual(compact.map(r => r.runs.length), [6, 6, 6]);
    assert.ok(compact[2].runs.every(r => r.undoOperations.length === 1));
    assert.ok(compact.flatMap(r => r.runs).some(r => r.recoveryRetention?.reason === 'session-budget'));
  } finally { h.close(); }
});

test('explicit ordinary Undo terminal survives a stale autosave in the production merge', () => {
  const old = session([run('undo')]);
  const terminal = { ...old, updatedAt: '2026-10-05T00:00:00Z', runs: [{ ...old.runs[0], undoStatus: 'applied' }] };
  const committed = Actions.mergeSessionReviewState(terminal, old, ['undo']);
  assert.equal(committed.runs[0].undoStatus, 'applied');
  const stale = { ...old, updatedAt: '2026-10-06T00:00:00Z' };
  assert.equal(Actions.mergeSessionReviewState(stale, committed, []).runs[0].undoStatus, 'applied');
  const other = { ...stale, accountScopeId: 'another-account' };
  assert.equal(Actions.mergeSessionReviewState(other, committed, []).runs[0].undoStatus, undefined);
});

test('post-save retention warnings belong only to the same view and unchanged action revision', () => {
  const state = { sessions: [session([run('visible')])] };
  const scope = { accountScopeId: 'account-one', projectId: 'project-a', generation: 3 };
  const stored = session([{ ...run('visible'), recoveryRetention: { state: 'omitted', reason: 'session-budget', bytes: 99 } }]);
  const args = { liveState: state, capturedState: clone(state), written: [stored], capturedScope: scope, currentScope: scope };
  assert.deepEqual(Actions.projectRetentionWarnings(args), ['visible']);
  const restoredMaterials = session([run('visible')]);
  assert.deepEqual(Actions.projectRetentionUpdates({ ...args, written: [restoredMaterials] }), [{ runId: 'visible', retention: null }]);
  assert.deepEqual(Actions.projectRetentionWarnings({ ...args, currentScope: { ...scope, generation: 4 } }), []);
  assert.deepEqual(Actions.projectRetentionWarnings({ ...args, currentScope: { ...scope, accountScopeId: 'account-two' } }), []);
  const saved = clone(state);
  state.sessions[0].runs[0].undoOperations[0].replaceAll = 'new checkpoint';
  assert.deepEqual(Actions.projectRetentionWarnings(args), []);
  assert.deepEqual(args.capturedState, saved);
  assert.equal(state.sessions[0].runs[0].undoOperations[0].replaceAll, 'new checkpoint');
});

test('directory cleanup observations survive text review terminal states and only support read-only follow-up', async () => {
  const h = createEnvironment();
  try {
    for (const terminal of [{ undoStatus: 'applied' }, { trackedChangeStatus: 'accepted' }]) {
      const original = run('directory', 20, { ...terminal, pendingDirectoryCleanup: {
        v: 1, accountScopeId: 'account-one', projectId: 'project-a', sessionId: 'retention-session', runId: 'directory',
        directories: [{ v: 1, projectId: 'project-a', path: 'new/nested', nativeFolderId: 'observed-folder',
          ownershipConfirmed: false, observedAfterCreate: true }]
      } });
      const [restored] = await persist(h, [original]);
      assert.deepEqual(restored.pendingDirectoryCleanup, original.pendingDirectoryCleanup);
      assert.equal(restored.undoOperations.length, 0);
      assert.equal(Settlement.projectRunSettlement(restored).canUndo, false);
      assert.equal(Settlement.projectRunSettlement(restored).canAccept, false);
      const fork = h.StorageDb.buildSessionRecord(session([{ ...original, forkSnapshot: true }]), { preserveRunActionPayload: true });
      assert.equal(fork.runs[0].pendingDirectoryCleanup, undefined);
    }
  } finally { h.close(); }
});

test('pending file recovery survives persistence after all text review refs have been settled', async () => {
  const h = createEnvironment();
  try {
    const original = run('file-tail', 20, { undoStatus: 'partial', trackedChangeStatus: 'pending', undoTrackedChanges: [],
      undoExpectedFiles: [], undoOperations: [{ type: 'create', path: 'deleted.tex', content: 'restore deleted original' }] });
    const [restored] = await persist(h, [original]);
    assert.equal(restored.trackedChangeStatus, 'pending');
    assert.equal(restored.undoStatus, 'partial');
    assert.deepEqual(restored.undoOperations, original.undoOperations);
    assert.equal(Settlement.projectRunSettlement(restored).canUndo, true);
    assert.equal(Settlement.projectRunSettlement(restored).canAccept, false);
  } finally { h.close(); }
});

test('directory-only omission remains explicit across terminal storage and repeated reload without reviving Undo', () => {
  const h = createEnvironment();
  try {
    const input = run('dir-terminal', 10, { undoStatus: 'applied', pendingDirectoryCleanup: {
      v: 1, accountScopeId: 'account-one', projectId: 'project-a', sessionId: 'retention-session', runId: 'dir-terminal',
      directories: [{ v: 1, projectId: 'project-a', path: 'new', nativeFolderId: 'folder', ownershipConfirmed: false, observedAfterCreate: true }]
    } });
    let record = h.StorageDb.buildSessionRecord(session([input]), { preserveRunActionPayload: true, maxActionPayloadBytes: 0 });
    for (let cycle = 0; cycle < 2; cycle++) {
      const restored = SessionState.normalizePanelState({ sessions: [record], activeSessionId: record.id }).runs[0];
      assert.equal(restored.pendingDirectoryCleanup, undefined);
      assert.equal(restored.recoveryRetention.directoryCleanup, true);
      assert.equal(Settlement.projectRunSettlement(restored).canUndo, false);
      record = h.StorageDb.buildSessionRecord(session([restored]), { preserveRunActionPayload: true });
    }
  } finally { h.close(); }
});

const proof = () => ({ v: 1, id: 'manual-proof', runProjectId: 'project-a', accountScopeId: 'account-one',
  files: [{ path: 'main.tex', nativeDocId: 'native-doc', postHash: 'a'.repeat(64),
    targetKeys: ['native:["change","insert",0,1,"1:a:b"]'], preservedKeys: [] }] });
const check = id => ({ v: 1, id: 'write-check', purpose: 'writeback-revalidation', projectId: 'project-a',
  accountScopeId: 'account-one', sessionId: 'retention-session', runId: id, createdAt: '2026-10-04T00:00:00Z',
  files: [{ path: 'main.tex', kind: 'text', sha256: 'b'.repeat(64) }] });

test('retired manual review and writeback-check fields are ignored across repeated real scoped storage', async () => {
  const h = createEnvironment();
  try {
    const input = run('read-only', 10, { appliedOperations: [], undoOperations: [], undoBaseFiles: [],
      trackedChangeStatus: 'pending', manualReviewProof: proof(), writebackCheck: check('read-only') });
    const [restored] = await persist(h, [input]);
    assert.equal(restored.manualReviewProof, undefined);
    assert.equal(restored.writebackCheck, undefined);
    assert.equal(restored.trackedChangeStatus, undefined);
    assert.equal(restored.recoveryRetention, undefined);
    const compact = Actions.compactRunActionPayload(input, true);
    assert.equal(compact.manualReviewProof, undefined);
    assert.equal(compact.recoveryRetention, undefined);
    assert.equal(Settlement.projectRunSettlement(restored).canUndo, false);
    assert.equal(Settlement.projectRunSettlement(restored).canAccept, false);
    const [again] = await persist(h, [restored]);
    assert.equal(again.manualReviewProof, undefined);
    assert.equal(again.writebackCheck, undefined);
    assert.equal(again.trackedChangeStatus, undefined);
  } finally { h.close(); }
});

test('retired recovery fields are ignored in ordinary, terminal, foreign-scope and fork projections', () => {
  const h = createEnvironment();
  try {
    const inputs = [run('owned', 10, { manualReviewProof: proof(), writebackCheck: check('owned') }),
      run('wrong-session', 10, { writebackCheck: { ...check('wrong-session'), sessionId: 'other-session' } }),
      run('wrong-account', 10, { manualReviewProof: { ...proof(), accountScopeId: 'account-two' } }),
      run('finished', 10, { undoStatus: 'applied', manualReviewProof: proof(), writebackCheck: check('finished') }),
      run('fork', 10, { forkSnapshot: true, manualReviewProof: proof(), writebackCheck: check('fork') })];
    const record = h.StorageDb.buildSessionRecord(session(inputs), { preserveRunActionPayload: true });
    for (const item of record.runs) {
      assert.equal(item.manualReviewProof, undefined);
      assert.equal(item.writebackCheck, undefined);
    }
    const restored = SessionState.normalizePanelState({ sessions: [session(inputs)], activeSessionId: 'retention-session' });
    for (const item of restored.runs) {
      assert.equal(item.manualReviewProof, undefined);
      assert.equal(item.writebackCheck, undefined);
    }
  } finally { h.close(); }
});

test('a retired manual-review proof alone keeps no pending state in any parent scope', () => {
  const h = createEnvironment();
  try {
    const original = run('manual', 10, { appliedOperations: [], undoOperations: [], undoBaseFiles: [],
      manualReviewProof: proof(), writebackCheck: check('manual'), trackedChangeStatus: 'pending' });
    for (const scope of [{}, { projectId: 'project-b' }, { accountScopeId: 'account-two' }]) {
      const input = { ...session([original]), ...scope };
      const stored = h.StorageDb.buildSessionRecord(input, { preserveRunActionPayload: true });
      const restored = SessionState.normalizePanelState({ sessions: [input], activeSessionId: input.id });
      for (const value of [stored.runs[0], restored.runs[0]]) {
        assert.equal(value.manualReviewProof, undefined);
        assert.equal(value.writebackCheck, undefined);
        assert.equal(value.trackedChangeStatus, undefined);
      }
    }
  } finally { h.close(); }
});


test('retiring proof-only workflows preserves real Undo materials, owner protocol and existing writeback recovery', async () => {
  const h = createEnvironment();
  try {
    const owner = { projectId: 'project-a', accountScopeId: 'account-one', sessionId: 'retention-session',
      runId: 'legacy-recovery', createdAt: '2026-10-04T00:00:00Z' };
    const input = run(owner.runId, 10, { undoOwnerProtocol: 1, manualReviewProof: proof(), writebackCheck: check(owner.runId),
      retryWriteback: { v: 1, id: 'retry', ...owner, operations: [{ type: 'edit', path: 'main.tex', replaceAll: 'after' }],
        baseFiles: [{ path: 'main.tex', content: 'before' }] },
      saveCheck: { v: 1, ...owner, files: [{ path: 'main.tex', kind: 'text', sha256: 'b'.repeat(64) }] } });
    const [restored] = await persist(h, [input]);
    assert.deepEqual(restored.undoOperations, input.undoOperations);
    assert.deepEqual(restored.undoBaseFiles, input.undoBaseFiles);
    assert.equal(restored.undoOwnerProtocol, 1);
    assert.deepEqual(restored.retryWriteback.operations, input.retryWriteback.operations);
    assert.deepEqual(restored.saveCheck, input.saveCheck);
    assert.equal(Settlement.projectRunSettlement(restored).canUndo, true);
    assert.equal(restored.manualReviewProof, undefined);
    assert.equal(restored.writebackCheck, undefined);
  } finally { h.close(); }
});

function directoryFact(id, path = 'created/nested') {
  return { v: 1, accountScopeId: 'account-one', projectId: 'project-a', sessionId: 'retention-session', runId: id,
    directories: [{ v: 1, projectId: 'project-a', path, nativeFolderId: 'folder-' + id,
      ownershipConfirmed: false, observedAfterCreate: true }] };
}
const coreFields = ['appliedOperations', 'undoOperations', 'undoBaseFiles', 'undoTrackedChanges', 'undoExpectedFiles', 'trackedChangeCaptures'];
const cores = runs => runs.map(run => Object.fromEntries(coreFields.map(key => [key, run[key]])));

test('optional directory history cannot displace the same run or an older run Undo core', () => {
  const h = createEnvironment();
  try {
    const originals = [run('older', 512), run('newer', 512)];
    const budget = originals.reduce((n, item) => n + Buffer.byteLength(JSON.stringify(Actions.compactRunActionPayload(item, true))), 0);
    const plain = h.StorageDb.buildSessionRecord(session(originals), { preserveRunActionPayload: true, maxActionPayloadBytes: budget });
    const withFacts = originals.map(item => ({ ...item, pendingDirectoryCleanup: directoryFact(item.id) }));
    const saved = h.StorageDb.buildSessionRecord(session(withFacts), { preserveRunActionPayload: true, maxActionPayloadBytes: budget });
    assert.deepEqual(cores(saved.runs), cores(plain.runs));
    for (const item of saved.runs) {
      assert.equal(item.pendingDirectoryCleanup, undefined);
      assert.equal(item.recoveryRetention.directoryCleanup, true);
      assert.equal(item.recoveryRetention.coreRetained, true);
      assert.equal(Settlement.projectRunSettlement(item).canUndo, true);
    }
    const reloaded = SessionState.normalizePanelState({ sessions: [saved], activeSessionId: saved.id });
    const resaved = h.StorageDb.buildSessionRecord(reloaded.sessions[0], { preserveRunActionPayload: true });
    assert.deepEqual(cores(resaved.runs), cores(saved.runs));
    assert.ok(resaved.runs.every(item => item.recoveryRetention.coreRetained === true));
    const fallback = SessionState.prepareStateForStorage(reloaded).sessions[0];
    assert.ok(fallback.runs.every(item => item.recoveryRetention.directoryCleanup === true));
    assert.ok(fallback.runs.every(item => item.recoveryRetention.coreRetained !== true));
  } finally { h.close(); }
});

test('a terminal directory-only run cannot consume space reserved for active Undo cores', () => {
  const h = createEnvironment();
  try {
    const active = run('active', 512);
    const budget = Buffer.byteLength(JSON.stringify(Actions.compactRunActionPayload(active, true)));
    const saved = h.StorageDb.buildSessionRecord(session([active, run('terminal', 10, {
      undoStatus: 'applied', pendingDirectoryCleanup: directoryFact('terminal')
    })]), { preserveRunActionPayload: true, maxActionPayloadBytes: budget });
    assert.deepEqual(saved.runs[0].undoOperations, active.undoOperations);
    assert.equal(saved.runs[1].undoOperations.length, 0);
    assert.equal(saved.runs[1].pendingDirectoryCleanup, undefined);
    assert.equal(saved.runs[1].recoveryRetention.directoryCleanup, true);
    assert.equal(saved.runs[1].recoveryRetention.coreRetained, true);
  } finally { h.close(); }
});

test('cross-session response allocation reserves all existing cores before optional directory history', () => {
  const h = createEnvironment();
  try {
    const make = (id, withDirectory) => h.StorageDb.buildSessionRecord({ ...session([run(id, 2048, withDirectory
      ? { pendingDirectoryCleanup: { ...directoryFact(id, 'd'.repeat(1800)), sessionId: id } } : {})]), id }, { preserveRunActionPayload: true });
    const plain = [make('session-a', false), make('session-b', false)];
    const facts = [make('session-a', true), make('session-b', true)];
    const budget = Buffer.byteLength(JSON.stringify(plain)) + 512;
    const transfer = { MAX_RESPONSE_BYTES: budget + 64 * 1024, byteLength: text => Buffer.byteLength(text) };
    const saved = Actions.compactSessionBatchActions(facts, { activeSessionId: 'session-b' }, h.StorageDb.buildSessionRecord, transfer);
    assert.deepEqual(saved.map(s => cores(s.runs)), plain.map(s => cores(s.runs)));
    assert.ok(Buffer.byteLength(JSON.stringify(saved)) <= transfer.MAX_RESPONSE_BYTES);
    assert.ok(saved.every(s => s.runs[0].recoveryRetention?.directoryCleanup === true));
  } finally { h.close(); }
});


test('a directory fact crossing the single-run core limit omits only that fact', () => {
  const limit = 16 * 1024 * 1024;
  const overhead = Buffer.byteLength(JSON.stringify(Actions.compactRunActionPayload(run('edge', 0), true)));
  const original = run('edge', Math.floor((limit - overhead) / 3));
  const core = Actions.compactRunActionPayload(original, true);
  assert.equal(core.undoOperations.length, 1);
  const saved = Actions.compactRunActionPayload({ ...original, pendingDirectoryCleanup: directoryFact('edge') }, true);
  assert.deepEqual(cores([saved]), cores([core]));
  assert.equal(saved.pendingDirectoryCleanup, undefined);
  assert.equal(saved.recoveryRetention.coreRetained, true);
  assert.equal(saved.recoveryRetention.reason, 'run-budget');
});

test('directory history has lower priority than existing optional capture evidence', () => {
  const h = createEnvironment();
  try {
    const original = run('capture', 100, { trackedChangeCaptures: [{ path: 'main.tex', state: 'observed', text: 'c'.repeat(100) }] });
    const budget = Buffer.byteLength(JSON.stringify(Actions.compactRunActionPayload(original, true))) + 8;
    const plain = h.StorageDb.buildSessionRecord(session([original]), { preserveRunActionPayload: true, maxActionPayloadBytes: budget });
    const saved = h.StorageDb.buildSessionRecord(session([{ ...original, pendingDirectoryCleanup: directoryFact(original.id) }]),
      { preserveRunActionPayload: true, maxActionPayloadBytes: budget });
    assert.ok(plain.runs[0].trackedChangeCaptures.length);
    assert.deepEqual(cores(saved.runs), cores(plain.runs));
    assert.equal(saved.runs[0].recoveryRetention.coreRetained, true);
  } finally { h.close(); }
});
