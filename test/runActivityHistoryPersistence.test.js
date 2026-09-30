const assert = require('node:assert/strict');
const test = require('node:test');
const StorageDb = require('../extension/src/shared/storageDb');
const SessionState = require('../extension/src/shared/sessionState');
const Model = require('../extension/src/shared/runActivityModel');

function roundTrip(run) {
  const record = StorageDb.buildSessionRecord({
    id: 'history-session', projectId: 'example', accountScopeId: 'test-account',
    runs: [run]
  });
  const stored = JSON.parse(JSON.stringify(record));
  return { stored: stored.runs[0], restored: SessionState.normalizeRuns(stored.runs)[0] };
}

function activity(kind, id, fields = {}) {
  return {
    title: kind + ' ' + id, kind: 'activity', status: 'completed',
    timestamp: '2026-09-26T12:00:00.000Z',
    activity: Model.normalize({ kind, id, scope: 'thread/turn', state: 'completed', ...fields })
  };
}

function projection(run) {
  const result = Model.project(run);
  const describe = block => ({
    key: block.key, kind: block.kind, meta: block.meta, file: block.file,
    text: block.kind === 'message' ? block.event.title : undefined,
    items: block.items?.map(describe)
  });
  return { blocks: result.blocks.map(describe), fileCount: result.fileCount, stage: result.stage };
}

test('IndexedDB record compaction preserves runtime tools through repeated hydration', () => {
  const run = {
    id: 'tools-run', status: 'completed', events: [
      activity('explore', 'read-1', { action: 'read', paths: ['main.tex'], command: 'cat main.tex' }),
      activity('explore', 'read-2', { action: 'search', target: 'citation', paths: ['references.bib'] }),
      activity('command', 'cmd-1', { state: 'running', command: 'latexmk main.tex' }),
      activity('command', 'cmd-1', { command: 'latexmk main.tex', output: 'Complete', exitCode: 0, durationMs: 150 }),
      activity('tool', 'tool-1', { target: 'project.read', durationMs: 10 }),
      activity('edit', 'edit-1', { paths: ['main.tex'],
        files: [{ path: 'main.tex', operation: 'update', added: 1, removed: 1, preview: '-old\n+new' }] }),
      activity('plan', 'plan-1', { output: 'completed: inspect project' }),
      activity('agent', 'agent-1', { target: 'chapter review' }),
      activity('sync', 'sync-1', { written: 1, skipped: 0 }),
      activity('compile', 'compile-1', { state: 'failed', output: 'Undefined command', exitCode: 1 })
    ]
  };
  const expected = projection(run);
  assert.ok(expected.blocks.length >= 8);
  let restored = run;
  for (let round = 0; round < 3; round++) {
    const result = roundTrip(restored);
    assert.ok(result.stored.events.every(event => event.activity?.v === 1));
    restored = result.restored;
    assert.deepEqual(projection(restored), expected);
  }
  assert.equal(expected.blocks.find(block => block.kind === 'command').meta.state, 'completed');
  assert.equal(expected.fileCount, 1);
});

test('record builder derives allowlisted activity from raw events before discarding technical payloads', () => {
  const event = {
    title: 'Read main.tex', kind: 'activity', status: 'completed',
    timestamp: '2026-09-26T12:00:00.000Z',
    technicalDetail: { type: 'codex.command.completed', detail: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1',
      command: 'cat main.tex', commandActions: [{ type: 'read', path: 'main.tex' }],
      output: 'Document text', exitCode: 0, durationMs: 42
    } }
  };
  const run = { id: 'raw-tool-run', status: 'completed', events: [event] };
  const { stored, restored } = roundTrip(run);
  assert.equal(stored.events[0].technicalDetail, undefined);
  assert.equal(stored.events[0].activity.kind, 'explore');
  assert.equal(stored.events[0].activity.command, 'cat main.tex');
  assert.deepEqual(projection(restored), projection(run));
});

test('message phases survive storage so commentary remains and the final answer is not duplicated', () => {
  const run = { id: 'phases-run', status: 'completed', events: [
    { title: 'Inspecting the document.', kind: 'stream', status: 'completed',
      streamKey: 'commentary-1', streamRole: 'assistant', streamPhase: 'commentary' },
    activity('tool', 'tool-1', { target: 'project.read' }),
    { title: 'A streamed final answer.', kind: 'stream', status: 'completed',
      streamKey: 'final-1', streamRole: 'assistant', streamPhase: 'final_answer' },
    { title: 'Complete', kind: 'report', status: 'completed',
      detailStructured: { conclusion: 'The authoritative final report.', body: [], meta: [] } }
  ] };
  const { stored, restored } = roundTrip(run);
  assert.equal(stored.events[0].streamPhase, 'commentary');
  assert.equal(stored.events[2].streamPhase, 'final_answer');
  assert.deepEqual(projection(restored), projection(run));
  assert.deepEqual(Model.project(restored).blocks.map(block => block.kind), ['message', 'tool']);
});

test('persisted activity remains bounded and redacted without retaining unknown tool fields', () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
  const raw = {
    v: 1, kind: 'command', id: 'safe-id', scope: 'thread/turn', state: 'completed',
    command: 'cat /Users/demo/private/paper.tex ' + secret + ' ' + 'x'.repeat(800),
    output: 'Bearer abcdefghijklmnopqrstuvwxyz ' + 'x'.repeat(2400),
    paths: Array.from({ length: 30 }, (_, i) => 'chapter-' + i + '.tex'),
    files: Array.from({ length: 30 }, (_, i) => ({
      path: 'chapter-' + i + '.tex', preview: 'x'.repeat(4000), operation: 'update'
    })),
    arguments: { password: 'do-not-persist' }
  };
  const { stored } = roundTrip({ id: 'privacy-run', status: 'completed',
    events: [{ title: 'Run command', kind: 'activity', activity: raw,
      technicalDetail: { apiKey: secret } }] });
  const meta = stored.events[0].activity;
  const serialized = JSON.stringify(stored);
  assert.equal(meta.paths.length, 12);
  assert.equal(meta.files.length, 12);
  assert.ok(meta.command.length <= 400);
  assert.ok(meta.output.length <= 1200);
  assert.ok(meta.files.every(file => file.preview.length <= 1800));
  assert.equal(meta.clipped, true);
  assert.match(serialized, /REDACTED_SECRET/);
  for (const excluded of [secret, '/Users/demo/', 'abcdefghijklmnopqrstuvwxyz', 'do-not-persist', '"arguments"', '"technicalDetail"']) {
    assert.equal(serialized.includes(excluded), false, excluded);
  }
});

test('legacy records without runtime facts remain readable without fabricated tool calls', () => {
  const { stored, restored } = roundTrip({ id: 'legacy-run', status: 'completed',
    events: [{ title: 'Historical activity', kind: 'activity', status: 'completed',
      activity: { v: 1, kind: 'unsupported', payload: 'ignored' }, streamPhase: 'unknown' }] });
  assert.equal(stored.events[0].activity, undefined);
  assert.equal(stored.events[0].streamPhase, undefined);
  assert.equal(restored.events[0].title, 'Historical activity');
  assert.equal(Model.project(restored).blocks.length, 0);
});
