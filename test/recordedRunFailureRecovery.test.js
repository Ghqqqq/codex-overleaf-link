'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const root = process.env.CODEX_OVERLEAF_REPO || path.resolve(__dirname, '..');
const Sessions = require(path.join(root, 'extension/src/shared/sessionState'));
const Storage = require(path.join(root, 'extension/src/shared/storageDb'));
const Activity = require(path.join(root, 'extension/src/shared/runActivityModel'));
const I18n = require(path.join(root, 'extension/src/shared/i18n'));
const Transcript = require(path.join(root, 'extension/src/shared/agentTranscript'));
const endedAt = '2026-09-28T09:36:13.890Z';
function failureEvent(locale = 'en') {
  const event = { title: Transcript.translateRawError("Cannot read properties of undefined (reading 'notices')", {
    mode: 'ask', locale, codexReturned: true
  }).conclusion, kind: 'activity', status: 'failed', timestamp: endedAt,
    technicalDetail: { message: "Cannot read properties of undefined (reading 'notices')" } };
  event.activity = Activity.capture(event);
  return event;
}
function legacyRun(locale = 'en') {
  return { id: 'run-old-postprocess', mode: 'ask', task: 'Inspect two files', runProjectId: 'qa-project',
    status: 'running', statusText: 'Running', startedAt: '2026-09-28T09:34:06.000Z', finishedAt: '',
    nativeRequestId: 'old-native-request', codexThreadId: 'parent-thread', codexTurnId: 'parent-turn',
    events: [{ title: 'Both checks completed.', kind: 'stream', streamRole: 'assistant',
      streamPhase: 'final_answer', status: 'completed', timestamp: '2026-09-28T09:36:12.000Z' }, failureEvent(locale)],
    subagents: [{ v: 1, source: 'codex', key: 'codex:child-a', threadId: 'child-a', title: 'Inspect main',
      task: '', status: 'completed', events: [] }] };
}
function roundTrip(run) {
  const record = Storage.buildSessionRecord({ id: 'session-old', projectId: 'qa-project', runs: [run] });
  return Sessions.normalizeRuns(JSON.parse(JSON.stringify(record.runs)), { restoreRunningRuns: false })[0];
}

test('shared-history hydration recovers a recorded parent post-processing failure without owner-loss guessing', () => {
  const input = legacyRun(), original = JSON.stringify(input);
  const result = Sessions.normalizeRuns([input], { restoreRunningRuns: false })[0];
  assert.equal(result.status, 'failed');
  assert.equal(result.statusText, I18n.t('en', 'processedFailed', { elapsed: '' }).trim());
  assert.equal(result.finishedAt, endedAt);
  assert.equal(result.events.length, input.events.length);
  assert.equal(result.events[0].title, 'Both checks completed.');
  assert.equal(result.events.some(event => event.failure?.source === 'panel_reload'), false);
  assert.equal(result.subagents[0].status, 'completed');
  assert.equal(result.nativeRequestId, input.nativeRequestId);
  assert.equal(result.codexThreadId, input.codexThreadId);
  assert.equal(result.runProjectId, input.runProjectId);
  assert.equal(JSON.stringify(input), original);
  assert.equal(Activity.project(result).notices.length, 1);
});

test('canonical status normalization agrees with recorded failure recovery', () => {
  const run = legacyRun();
  assert.equal(run.events[1].activity.scope, JSON.stringify(['', '']));
  assert.equal(Sessions.normalizeRunStatus(run.status, run), 'failed');
});

test('legacy empty scopes remain recoverable without treating child or turn scopes as local', () => {
  for (const scope of ['', JSON.stringify(['', ''])]) {
    const run = legacyRun(); run.events[1].activity.scope = scope;
    assert.equal(roundTrip(run).status, 'failed');
  }
  for (const scope of [JSON.stringify(['child', '']), JSON.stringify(['', 'turn']),
    JSON.stringify(['child', 'turn']), '[]', '[null,null]', 'invalid']) {
    const run = legacyRun(); run.events[1].activity.scope = scope;
    assert.equal(roundTrip(run).status, 'running', scope);
  }
});

test('raw local failure capture and persisted capture produce the same recovery', () => {
  const run = legacyRun(); delete run.events[1].activity;
  const captured = Activity.capture(run.events[1]);
  assert.equal(captured.scope, JSON.stringify(['', '']));
  assert.equal(Sessions.normalizeRuns([run], { restoreRunningRuns: false })[0].status, 'failed');
  const restored = roundTrip(run);
  assert.equal(restored.status, 'failed');
  assert.equal(restored.finishedAt, endedAt);
  assert.equal(restored.events[1].activity.scope, captured.scope);
});

test('recovered status, label and terminal timestamp survive repeated shared storage', () => {
  const input = legacyRun();
  const stored = Storage.buildSessionRecord({ id: 'session-old', projectId: 'qa-project', runs: [input] });
  assert.equal(stored.runs[0].status, 'failed');
  assert.doesNotMatch(stored.runs[0].statusText, /Running/);
  assert.equal(stored.runs[0].finishedAt, endedAt);
  const once = roundTrip(input), twice = roundTrip(once);
  assert.equal(twice.status, 'failed');
  assert.equal(twice.finishedAt, endedAt);
  assert.equal(twice.events.length, once.events.length);
});

test('legacy compact persistence recovers before event titles are redacted', () => {
  const compact = Sessions.prepareStateForStorage({ activeSessionId: 'session-old',
    sessions: [{ id: 'session-old', runs: [legacyRun()] }] });
  assert.equal(compact.sessions[0].runs[0].status, 'failed');
  assert.equal(compact.sessions[0].runs[0].finishedAt, endedAt);
  assert.equal(Sessions.normalizeRuns(compact.sessions[0].runs)[0].status, 'failed');
});

test('Chinese failure acknowledgement recovers with a localized terminal label', () => {
  const result = Sessions.normalizeRuns([legacyRun('zh')], { locale: 'zh', restoreRunningRuns: false })[0];
  assert.equal(result.status, 'failed');
  assert.equal(result.statusText, I18n.t('zh', 'processedFailed', { elapsed: '' }).trim());
});

test('explicit failure evidence outranks the generic reload-interruption fallback', () => {
  const result = Sessions.normalizeRuns([legacyRun()], { restoreRunningRuns: true })[0];
  assert.equal(result.status, 'failed');
  assert.equal(result.finishedAt, endedAt);
  assert.equal(result.events.some(event => event.failure?.source === 'panel_reload'), false);
});

test('another live shared session is unchanged regardless of its age', () => {
  const live = { ...legacyRun(), id: 'run-live', events: [], startedAt: '2020-01-01T00:00:00.000Z' };
  const normalized = Sessions.normalizePanelState({ activeSessionId: 'session-live', sessions: [
    { id: 'session-old', runs: [legacyRun()] }, { id: 'session-live', runs: [live] }
  ] }, { restoreRunningRuns: false });
  assert.equal(normalized.sessions.find(s => s.id === 'session-old').runs[0].status, 'failed');
  assert.equal(normalized.sessions.find(s => s.id === 'session-live').runs[0].status, 'running');
  assert.equal(normalized.activeSessionId, 'session-live');
});

test('assistant quotations, child errors and tool notices cannot settle the parent', () => {
  const variants = [
    { kind: 'stream', streamRole: 'assistant' }, { kind: 'report' }, { kind: 'guidance', guidanceId: 'g1' },
    { subagent: true }, { status: 'warning' },
    { title: 'Quoted: ' + failureEvent().title },
    { activity: { v: 1, kind: 'command', state: 'failed', id: 'command-1' } },
    { activity: { v: 1, kind: 'notice', state: 'failed', scope: 'child-thread' } },
    { activity: { v: 1, kind: 'notice', state: 'failed', id: 'tool-1' } },
    { activity: { v: 1, kind: 'notice', state: 'failed', noticeSource: 'guardianWarning' } }
  ];
  for (const patch of variants) {
    const run = legacyRun(); run.events = [{ ...failureEvent(), ...patch }];
    assert.equal(Sessions.normalizeRuns([run], { restoreRunningRuns: false })[0].status, 'running', JSON.stringify(patch));
  }
});

test('a resumed parent activity after the failure prevents stale terminal inference', () => {
  const run = legacyRun();
  run.events.push({ title: 'Continuing parent work', status: 'running', kind: 'stream', streamRole: 'assistant',
    timestamp: '2026-09-28T09:37:00.000Z' });
  assert.equal(roundTrip(run).status, 'running');
});

test('invalid or pre-run failure timestamps do not fabricate a finish time', () => {
  for (const timestamp of ['', 'invalid', '2020-01-01T00:00:00.000Z']) {
    const run = legacyRun(); run.events[1].timestamp = timestamp;
    assert.equal(roundTrip(run).status, 'running');
  }
});

test('existing terminal outcomes and ordinary interrupted-run recovery keep their contracts', () => {
  for (const status of ['completed', 'failed', 'cancelled', 'interrupted']) {
    const run = { ...legacyRun(), status, finishedAt: '2026-09-28T09:37:00.000Z' };
    const result = roundTrip(run);
    assert.equal(result.status, status); assert.equal(result.finishedAt, run.finishedAt);
  }
  const run = legacyRun(); run.events = [];
  assert.equal(Sessions.normalizeRuns([run], { restoreRunningRuns: true })[0].status, 'interrupted');
});

test('recovery preserves writeback and undo evidence instead of claiming no writes or success', () => {
  const run = { ...legacyRun(), mode: 'auto', changedDocument: true, trackedChangeStatus: 'needs_review',
    undoStatus: 'partial', undoExpectedFiles: [{ path: 'main.tex', content: 'before' }],
    undoBaseFiles: [{ path: 'main.tex', content: 'after' }],
    appliedOperations: [{ type: 'edit', path: 'main.tex', replaceAll: 'after' }] };
  const result = Sessions.normalizeRuns([run], { restoreRunningRuns: false })[0];
  assert.equal(result.status, 'failed');
  assert.equal(result.changedDocument, true);
  assert.equal(result.trackedChangeStatus, 'needs_review');
  assert.equal(result.undoStatus, 'partial');
  assert.deepEqual(result.undoExpectedFiles, run.undoExpectedFiles);
  assert.deepEqual(result.appliedOperations, run.appliedOperations);
});
