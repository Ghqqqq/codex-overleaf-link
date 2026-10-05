'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SessionState = require('../extension/src/shared/sessionState');
const StorageDb = require('../extension/src/shared/storageDb');
const Transcript = require('../extension/src/shared/agentTranscript');
const Queue = require('../extension/src/shared/runInputQueue');
const AuditRecords = require('../extension/src/shared/auditRecords');
const SensitiveScan = require('../extension/src/shared/sensitiveScan');
const SensitivePreflight = require('../extension/src/content/sensitivePreflight');
const GovernanceRules = require('../extension/src/shared/governanceRules');
const Fork = require('../extension/src/content/sessionForkController');
const { background, memoryStorage, ownerClient, recoveryOptions, bind, flush, prefix } = require('./_helpers/backgroundJournalHarness');
const managerContext = { window: {}, document: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/src/content/sessionManager.js'), 'utf8'), managerContext);
const SessionManager = managerContext.window.CodexOverleafSessionManager;
// Synthetic examples only. The regression deliberately includes the complete old
// pattern family, so preserving one QA marker cannot mask another rewrite path.
const examples = [
  'PDF token: QA_PDF_20261006_7319', 'token: 120', 'password="example-password"',
  'api_key = "example-key"', 'secret: example', 'sk-' + 'synthetic'.repeat(3),
  'ghp_' + 'A'.repeat(36), 'github_pat_' + 'B'.repeat(36), 'xoxb-' + 'C'.repeat(24),
  'AKIA' + 'D'.repeat(16), 'Bearer ' + 'E'.repeat(24),
  'eyJ' + 'A'.repeat(12) + '.' + 'B'.repeat(12) + '.' + 'C'.repeat(12),
  '-----BEGIN PRIVATE KEY-----\nSYNTHETIC_EXAMPLE_ONLY\n-----END PRIVATE KEY-----'
];
const copy = value => JSON.parse(JSON.stringify(value));
function roundTrip(session) {
  const record = StorageDb.buildSessionRecord({ ...session, projectId: 'project-one', accountScopeId: 'account-one' });
  return SessionState.normalizePanelState({ activeSessionId: record.id, sessions: [copy(record)] }).sessions[0];
}
function responseEvent(text) {
  return Transcript.mapAgentEventToActivity({ type: 'codex.session.event', detail: {
    method: 'item/agentMessage/delta', params: { itemId: 'answer-item', delta: text }
  } }, { locale: 'en' });
}
for (const text of examples) test('conversation survives live capture, history, queue and reload: ' + text.split('\n')[0], () => {
  const pendingInputs = Queue.enqueue([], { text, payload: { submissionContext: { customInstructions: text } } }, { randomUUID: () => 'queued-one' }).queue;
  let state = { activeSessionId: 'session-one', sessions: [{ id: 'session-one', task: text,
    title: 'password: example', titleSource: 'manual', pendingInputs, history: [], runs: [{ id: 'run-one', task: text,
      status: 'completed', runProjectId: 'project-one', events: [responseEvent(text), {
        title: 'Result', kind: 'report', detail: text, detailStructured: { conclusion: text, body: text, meta: [] }
      }] }] }] };
  const manager = SessionManager.create({ SessionState, SessionMenuView: { create: () => ({}) },
    getState: () => state, setState: next => { state = next; } });
  manager.replaceSessionInState(SessionState.recordSessionResult(state.sessions[0], { task: text, result: text }));
  for (let cycle = 0; cycle < 3; cycle++) {
    const session = state.sessions[0];
    assert.equal(session.title, 'password: example');
    assert.equal(session.task, text);
    assert.equal(session.runs[0].task, text);
    assert.equal(session.runs[0].events[0].title, text);
    assert.equal(session.runs[0].events[1].detail, text);
    assert.equal(session.runs[0].events[1].detailStructured.body, text);
    assert.equal(session.history[0].task, text);
    assert.equal(session.history[0].result, text);
    assert.equal(session.pendingInputs[0].text, text);
    assert.equal(session.pendingInputs[0].payload.submissionContext.customInstructions, text);
    state.sessions[0] = roundTrip(session);
  }
});

test('project instructions retain examples through lightweight preferences and queue submission', () => {
  const text = examples.join('\n');
  let state = SessionState.normalizePanelState({ customInstructionsByProject: { 'project-one': text } });
  for (let cycle = 0; cycle < 3; cycle++) {
    const prefs = copy(StorageDb.extractLightweightPrefs(state));
    assert.equal(prefs.customInstructionsByProject['project-one'], text);
    state = SessionState.normalizePanelState(prefs);
    assert.equal(state.customInstructionsByProject['project-one'], text);
  }
});

test('forked conversation copies examples intact and persists its history', async () => {
  const text = examples.join('\n');
  let state = SessionState.normalizePanelState({ sessions: [SessionState.createSession({
    title: 'Example', codexThreadId: 'thread-one', runs: [{ id: 'run-one', task: text,
      status: 'completed', codexTurnId: 'turn-one', events: [responseEvent(text)] }]
  })] });
  const controller = Fork.create({ SessionState, getState: () => state, setState: next => { state = next; },
    sendBackgroundNative: async request => {
      assert.equal(request.method, 'codex.thread.fork');
      return { ok: true, result: { threadId: 'thread-forked' } };
    }, saveState: async () => {}, applyStateToPanel() {}, showPluginToast() {}, tr: key => key });
  const forked = roundTrip(await controller.forkRunFromNode('run-one'));
  assert.equal(forked.runs[0].forkSnapshot, true);
  assert.equal(forked.runs[0].task, text);
  assert.equal(forked.runs[0].events[0].title, text);
});

test('background recovery journal preserves conversation text without copying request credentials', async () => {
  const text = examples.join('\n'), storage = memoryStorage(), bg = background(storage);
  const route = { current: bg }, owner = ownerClient(route), requestId = 'text-examples';
  const pending = bg.run(requestId, { task: text, apiKey: 'CONFIG_KEY_MUST_NOT_ENTER_JOURNAL' });
  bind(owner, requestId);
  bg.ports[0].emit({ id: requestId, event: { type: 'codex.session.event', title: text, status: 'completed', detail: {
    method: 'item/agentMessage/delta', params: { itemId: 'answer-item', delta: text },
    output: { password: 'example', secret: 'example', token: 120 }
  } } });
  bg.ports[0].emit({ id: requestId, ok: true, result: { status: 'completed' } });
  await pending; await flush();
  const journal = storage.values[prefix + requestId];
  assert.equal(journal.task, text);
  assert.equal(journal.events[0].event.detail.params.delta, text);
  assert.doesNotMatch(JSON.stringify(journal), /CONFIG_KEY_MUST_NOT_ENTER_JOURNAL/);
  assert.deepEqual(journal.events[0].event.detail.output, { password: 'example', secret: 'example', token: 120 });
  owner.control.destroy(); await bg.timer.fire(150);
  // A fresh worker restores from the stored journal, then the production owner
  // recovery and transcript mapping pass the text into the normal session store.
  route.current = background(storage);
  const observer = ownerClient(route), target = recoveryOptions(requestId);
  target.options.mapEvent = event => Transcript.mapAgentEventToActivity(event, { locale: 'en' });
  target.options.upsertStream = (record, event) => { record.events.push(event); };
  const result = await observer.control.recoverJournals(target.options);
  assert.equal(result.changed, true);
  const restored = roundTrip(target.session);
  assert.equal(restored.runs[0].events.find(event => event.kind === 'stream').title, text);
  await observer.control.acknowledge(requestId);
  observer.control.destroy(); bg.timer.clear(); route.current.timer.clear();
});

test('captured credential-shaped task still reaches the existing sensitive preflight unchanged', async () => {
  const task = 'Explain this synthetic key: ' + examples[5];
  const captured = SessionState.createSession({ task }).task;
  assert.equal(captured, task);
  const observations = [];
  const preflight = SensitivePreflight.create({ SensitiveScan,
    normalizeGovernanceRules: GovernanceRules.normalizeGovernanceRules,
    isTextSnapshotFile: () => true, getCurrentProjectId: () => 'project-one',
    appendRunEvent: event => observations.push(event), appendCompletionReport() {},
    showPluginConfirm: async () => { throw new Error('default policy does not confirm'); },
    sendBackgroundNative: async () => { throw new Error('no mirror read requested'); },
    tr: key => key, tx: en => en });
  const result = await preflight.run({ task: captured, project: { files: [] }, rules: {} });
  assert.equal(result.blocked, true);
  assert.ok(result.findings.length > 0);
  assert.equal(JSON.stringify(observations).includes(examples[5]), false);
});

test('diagnostic/audit exports still summarize conversation and exclude raw text', () => {
  const text = examples.join('\n');
  const draft = AuditRecords.buildAuditDraftRecord({ task: text });
  const diagnostic = AuditRecords.buildDiagnosticBundle({ auditLogs: [draft], run: {
    id: 'run-one', task: text, events: [{ title: text, detail: text }]
  } });
  assert.match(draft.promptSummary, /^\[prompt omitted;/);
  assert.doesNotMatch(JSON.stringify(diagnostic), /QA_PDF_20261006_7319|SYNTHETIC_EXAMPLE_ONLY|example-password/);
});
