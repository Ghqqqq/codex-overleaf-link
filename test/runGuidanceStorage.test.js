const assert = require('node:assert/strict');
const test = require('node:test');
const StorageDb = require('../extension/src/shared/storageDb');
const SessionState = require('../extension/src/shared/sessionState');
const ActivityModel = require('../extension/src/shared/runActivityModel');

const timestamp = '2026-10-10T09:12:34.000Z';
const guidance = (guidanceId, status = 'completed') => ({
  title: 'Read this section', kind: 'guidance', guidanceId, status, timestamp
});
const session = events => ({ id: 'guidance-session', projectId: 'example', accountScopeId: 'test-account',
  runs: [{ id: 'guidance-run', status: 'completed', task: 'Read', events }] });

function reload(input) {
  const stored = JSON.parse(JSON.stringify(StorageDb.buildSessionRecord(input)));
  return { ...stored, runs: SessionState.normalizeRuns(stored.runs) };
}

test('confirmed guidance retains message identity and send timestamp through repeated main-storage reloads', () => {
  const events = [guidance('g-first'), { ...guidance('g-second'), timestamp: '2026-10-10T09:12:35.000Z' }];
  let value = session(events);
  for (let attempt = 0; attempt < 3; attempt++) {
    value = reload(value);
    assert.deepEqual(value.runs[0].events.map(({ guidanceId, title, timestamp, status }) =>
      ({ guidanceId, title, timestamp, status })), events.map(({ guidanceId, title, timestamp, status }) =>
      ({ guidanceId, title, timestamp, status })));
  }
});

test('guidance identity keeps old pending/confirmed snapshots as one message without merging repeated text', () => {
  const events = [guidance('g-first', 'queued'), guidance('g-first'), guidance('g-second')];
  const restored = reload(session(events)).runs[0];
  const blocks = ActivityModel.project(restored).blocks.filter(block => block.kind === 'guidance');
  assert.deepEqual(blocks.map(block => [block.event.guidanceId, block.event.status, block.event.title]), [
    ['g-first', 'completed', 'Read this section'], ['g-second', 'completed', 'Read this section']
  ]);
});

test('guidance survives the fallback compactor before returning to main storage', () => {
  const input = session([guidance('g-fallback')]);
  const compact = SessionState.prepareStateForStorage({ sessions: [input], activeSessionId: input.id,
    runs: input.runs, task: '' });
  const restored = reload(compact.sessions[0]);
  assert.equal(restored.runs[0].events[0].guidanceId, 'g-fallback');
  assert.equal(restored.runs[0].events[0].timestamp, timestamp);
});

test('main storage applies the existing bounded ID policy and does not invent legacy guidance identity', () => {
  const stored = StorageDb.buildSessionRecord(session([
    guidance('g'.repeat(200)), { title: 'Old guidance', kind: 'guidance', status: 'completed', timestamp }
  ]));
  assert.equal(stored.runs[0].events[0].guidanceId, 'g'.repeat(159) + '…');
  assert.equal(stored.runs[0].events[1].guidanceId || '', '');
  assert.equal(stored.runs[0].events[1].timestamp, timestamp);
});
