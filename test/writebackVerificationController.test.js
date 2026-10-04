'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Intent = require('../extension/src/shared/writebackIntent');
const Session = require('../extension/src/shared/sessionState');
const Storage = require('../extension/src/shared/storageDb');
const Controller = require('../extension/src/content/writebackController');
const Verification = require('../extension/src/content/writebackVerificationController');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
function harness(options = {}) {
  let account = 'a', projectId = 'p', generation = 1, run = { id: 'r', runProjectId: 'p', status: 'failed', task: 'synthetic',
    appliedOperations: [{ type: 'edit', path: 'known.tex', patches: [] }], undoOperations: [{ type: 'delete', path: 'known.tex' }], undoTrackedChanges: [{ key: 'existing-track' }] };
  const state = { activeSessionId: 's', sessions: [{ id: 's', accountScopeId: 'a', runs: [run], history: [] }] };
  let active = { recordId: 'r', sessionId: 's', runProjectId: 'p' }, stored, serial = 0;
  const log = { persists: [], reads: [], messages: [] }, fault = { fail: false, omit: false };
  const snapshot = { id: 'p', files: [{ path: 'main.tex', content: 'after', source: 'overleaf-zip' }],
    capabilities: { fullProjectSnapshot: true, method: 'overleaf-zip', skipped: [] } };
  const api = Verification.create({ getState: () => state, getCurrentRun: () => active,
    getProjectId: () => projectId, getAccountScopeId: () => account, getRouteGeneration: () => generation,
    findRunRecord: (id, sessionId) => state.sessions.find(s => s.id === sessionId)?.runs.find(r => r.id === id),
    randomUUID: () => 'plan-' + (++serial), tx: en => en, notify: text => log.messages.push(text), refresh() {}, canCheck: () => !active,
    async persist(input) {
      log.persists.push(input); if (fault.fail) throw new Error('synthetic durable failure');
      stored = Storage.buildSessionRecord({ ...state.sessions[0], projectId, accountScopeId: account }, { preserveRunActionPayload: true });
      if (fault.omit) delete stored.runs[0].writebackCheck;
      await options.afterPersist?.();
    },
    async readSession() { await options.beforeRead?.(); return clone(stored); },
    async callPageBridge(method, params) { log.reads.push({ method, params }); assert.equal(method, 'getProjectSnapshot');
      await options.afterSnapshot?.(); return clone(snapshot); }
  });
  return { api, state, run, log, fault, snapshot,
    begin() { active = { recordId: 'r', sessionId: 's', runProjectId: 'p' }; }, idle() { active = null; },
    changeAccount() { account = 'b'; }, changeProject() { projectId = 'other'; }, changeGeneration() { generation++; },
    reload() { const normalized = Session.normalizePanelState({ sessions: [stored], activeSessionId: 's' }); state.sessions = normalized.sessions; run = state.sessions[0].runs[0]; return run; },
    live: () => state.sessions[0].runs[0], stored: () => stored };
}
const project = { id: 'p', files: [{ path: 'main.tex', content: 'before' }] };
const operations = Controller.buildSyncApplyOperations([{ type: 'write', path: 'main.tex', previousContent: 'before', content: 'after' }], project);
const stage = h => h.api.stage({ operations, project, target: { runProjectId: 'p', sessionId: 's', recordId: 'r' }, requireReviewing: false });

test('stage durably roundtrips a hash-only check before write permission and reload allows only read verification', async () => {
  const h = harness();
  await stage(h);
  assert.equal(h.log.persists[0].requireDurable, true);
  assert.deepEqual(h.log.persists[0].reviewRunIds, ['r']);
  assert.equal(h.stored().runs[0].writebackCheck.files[0].sha256, hash('after'));
  assert.doesNotMatch(JSON.stringify(h.stored().runs[0].writebackCheck), /before|after|patches|insert|expected/);
  const reloaded = h.reload(); h.idle();
  const before = clone({ status: reloaded.status, applied: reloaded.appliedOperations, undo: reloaded.undoOperations, tracks: reloaded.undoTrackedChanges });
  await h.api.check('r');
  const after = h.live(); assert.equal(after.writebackCheck.observation, 'matches');
  assert.deepEqual({ status: after.status, applied: after.appliedOperations, undo: after.undoOperations, tracks: after.undoTrackedChanges }, before);
  assert.equal(after.saveConfirmedAt, undefined); assert.equal(h.log.reads.length, 1);
  assert.match(h.log.messages.at(-1), /ownership remains unconfirmed/i);
});
for (const kind of ['fail', 'omit']) test(`stage blocks write permission when durable storage ${kind}`, async () => {
  const h = harness(); h.fault[kind] = true;
  let writes = 0;
  await assert.rejects(stage(h).then(() => { writes++; }));
  assert.equal(writes, 0);
});
for (const changed of ['changeAccount', 'changeProject', 'changeGeneration']) test(`read verification rejects ${changed} during the snapshot wait`, async () => {
  let h; h = harness({ afterSnapshot: () => h[changed]() }); await stage(h); h.idle();
  const original = clone(h.live().writebackCheck);
  await assert.rejects(h.api.check('r'));
  assert.deepEqual(h.live().writebackCheck, original);
  assert.equal(h.live().saveConfirmedAt, undefined);
});
for (const mode of ['mismatch', 'editor-overlay', 'partial']) test(`read verification cannot confirm ${mode}`, async () => {
  const h = harness(); await stage(h); h.idle();
  if (mode === 'mismatch') h.snapshot.files[0].content = 'collaborator text';
  if (mode === 'editor-overlay') h.snapshot.files[0].source = 'editor';
  if (mode === 'partial') h.snapshot.capabilities.fullProjectSnapshot = false;
  await h.api.check('r');
  assert.notEqual(h.live().writebackCheck.observation, 'matches');
  assert.equal(h.live().saveConfirmedAt, undefined); assert.ok(h.log.reads.every(read => read.method === 'getProjectSnapshot'));
});
test('stage retains prior planned files outside the retried subset and keeps create Retry intent distinct', async () => {
  const h = harness(); await stage(h);
  const create = [{ type: 'create', path: 'new.tex', content: 'new' }];
  await h.api.stage({ operations: create, project, target: { runProjectId: 'p', sessionId: 's', recordId: 'r' }, requireReviewing: true });
  assert.deepEqual(h.live().writebackCheck.files.map(file => file.path), ['main.tex', 'new.tex']);
  assert.equal(Intent.normalize(h.live().retryWriteback).operations[0].content, 'new');
});

for (const changed of ['changeAccount', 'changeProject', 'changeGeneration']) test(`stage cannot grant write permission after ${changed} during persistence`, async () => {
  let h; h = harness({ afterPersist: () => h[changed]() });
  let writes = 0;
  await assert.rejects(stage(h).then(() => { writes++; })); assert.equal(writes, 0);
});
test('replacing the check while a snapshot is pending rejects the old observation', async () => {
  let h; h = harness({ afterSnapshot: () => { h.live().writebackCheck = { ...h.live().writebackCheck, id: 'replacement-plan' }; } });
  await stage(h); h.idle(); await assert.rejects(h.api.check('r'));
  assert.equal(h.live().writebackCheck.id, 'replacement-plan'); assert.equal(h.live().writebackCheck.observation, undefined);
});
for (const mode of ['matches', 'missing-bytes', 'wrong-kind']) test(`binary planned content verification preserves execution uncertainty: ${mode}`, async () => {
  const h = harness(), bytes = Buffer.from([1, 2, 3]);
  await h.api.stage({ operations: [{ type: 'binary-create', path: 'image.png', sha256: hash(bytes), size: bytes.length }], project,
    target: { runProjectId: 'p', sessionId: 's', recordId: 'r' }, requireReviewing: false });
  h.idle();
  h.snapshot.files = [{ path: 'image.png', source: 'overleaf-zip',
    ...(mode === 'matches' ? { contentBase64: bytes.toString('base64') } : mode === 'wrong-kind' ? { content: bytes.toString() } : {}) }];
  const before = clone(h.live().appliedOperations);
  const result = await h.api.check('r');
  assert.equal(result.ok, mode === 'matches'); assert.equal(result.executionConfirmed, false);
  assert.notEqual(result.state, 'verified_saved'); assert.equal(h.live().saveConfirmedAt, undefined);
  assert.deepEqual(h.live().appliedOperations, before);
});
test('a create retry intent does not cause the separate content-check action to replay the write', async () => {
  const h = harness();
  await h.api.stage({ operations: [{ type: 'create', path: 'new.tex', content: '' }], project,
    target: { runProjectId: 'p', sessionId: 's', recordId: 'r' }, requireReviewing: false });
  const retry = clone(h.live().retryWriteback); h.idle();
  h.snapshot.files = [{ path: 'new.tex', content: '', source: 'overleaf-zip' }];
  const result = await h.api.check('r');
  assert.equal(result.state, 'planned_content_matches'); assert.equal(result.executionConfirmed, false);
  assert.deepEqual(h.live().retryWriteback, retry);
  assert.ok(h.log.reads.every(read => read.method === 'getProjectSnapshot'));
});
