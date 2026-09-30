const assert = require('node:assert/strict');
const test = require('node:test');
const Model = require('../extension/src/shared/runActivityModel');
const { mapAgentEventToActivity: mapEvent } = require('../extension/src/shared/agentTranscript');
const StorageDb = require('../extension/src/shared/storageDb');
const SessionState = require('../extension/src/shared/sessionState');

function activity(kind, id, fields = {}, extra = {}) {
  return { kind: 'activity', title: kind + ' ' + id, status: fields.state || 'completed',
    activity: Model.normalize({ kind, id, scope: 'thread/turn', state: 'completed', ...fields }), ...extra };
}

function notice(method, params, status = 'info') {
  return mapEvent({ type: 'codex.session.event', status, detail: { method, params } });
}

function restore(events) {
  const record = StorageDb.buildSessionRecord({ id: 'notice-session', projectId: 'example',
    accountScopeId: 'test-account', runs: [{ id: 'notice-run', status: 'completed', events }] });
  return SessionState.normalizeRuns(JSON.parse(JSON.stringify(record)).runs)[0];
}

test('a recovered search attempt stays in the tools without warning about a successful task', () => {
  const failed = mapEvent({ type: 'codex.command.completed', status: 'failed', detail: {
    threadId: 'thread', turnId: 'turn', itemId: 'search', exitCode: 1,
    command: 'sed -n \'13,21p\' main.tex\nrg -n -F \'\\\\title{Workflow Test}\' main.tex',
    commandActions: [{ type: 'read', path: 'main.tex' }, { type: 'search', path: 'main.tex' }],
    output: '\\title{Workflow Test}\n\\author{Codex}'
  } });
  const events = [failed,
    activity('explore', 'read', { action: 'read', paths: ['main.tex'], exitCode: 0 }),
    activity('sync', 'sync', { written: 1, skipped: 0 })];
  for (const run of [{ status: 'completed', events }, restore(events)]) {
    const result = Model.project(run);
    assert.equal(result.notices.length, 0);
    const attempt = result.blocks[0].items[0];
    assert.equal(attempt.meta.state, 'failed');
    assert.equal(attempt.meta.exitCode, 1);
    assert.match(attempt.meta.command, /rg -n -F/);
    assert.equal(result.blocks.at(-1).meta.written, 1);
  }
});

test('intermediate local tool errors are not promoted to task warnings', () => {
  for (const kind of ['explore', 'command', 'tool', 'edit', 'agent']) {
    for (const status of ['running', 'completed', 'failed', 'cancelled']) {
      const event = activity(kind, 'attempt', { state: 'failed', command: 'node check.js', exitCode: 1 });
      const result = Model.project({ status, events: [event] });
      assert.equal(result.notices.length, 0, kind + ':' + status);
      const row = kind === 'explore' ? result.blocks[0].items[0] : result.blocks[0];
      assert.equal(row.meta.state, 'failed');
    }
  }
});

test('native environment and runtime advisories remain diagnostic after persistence', () => {
  const events = [
    notice('configWarning', { summary: 'An obsolete setting is ignored.', details: 'features.old_setting' }),
    notice('warning', { message: 'Reconnecting before continuing.' })
  ];
  for (const run of [{ status: 'running', events }, restore(events)]) {
    const result = Model.project(run);
    assert.equal(result.blocks.length, 0);
    assert.equal(result.notices.length, 0);
    assert.equal(result.diagnostics.length, 2);
  }
  const restored = restore(events);
  assert.equal(restored.events[0].activity.noticeSource, 'configWarning');
  assert.equal(restored.events[0].activity.output, 'features.old_setting');
});

test('empty native notices no longer invent a visible generic warning', () => {
  for (const method of ['warning', 'configWarning']) {
    const event = notice(method, {});
    assert.equal(event.visible, false);
    assert.equal(event.kind, 'technical');
    const projected = Model.project({ status: 'completed', events: [event] });
    assert.equal(projected.notices.length, 0);
    assert.equal(projected.diagnostics.length, 1);
  }
});

test('old saved empty and ignored-config notices disappear from conversation without deletion', () => {
  const events = [
    activity('notice', 'empty', { state: 'warning' }, { title: 'Codex returned a runtime notice.' }),
    activity('notice', 'empty-zh', { state: 'warning' }, { title: 'Codex \u8fd4\u56de\u4e86\u4e00\u6761\u8fd0\u884c\u63d0\u793a\u3002' }),
    activity('notice', 'config', { state: 'warning' }, {
      title: 'Codex is ignoring 2 unrecognized configuration settings. user ([local path]): features.remote_connections is ignored.'
    })
  ];
  const result = Model.project(restore(events));
  assert.equal(result.blocks.length, 0);
  assert.equal(result.notices.length, 0);
  assert.equal(result.diagnostics.length, 3);
  assert.equal(events.length, 3);
});

test('duplicate advisory events have one diagnostic projection and keep the original record', () => {
  const first = notice('warning', { message: 'A compatibility setting was ignored.' });
  const events = [first, { ...first, timestamp: '2026-09-28T04:00:01.000Z' }];
  const result = Model.project({ status: 'completed', events });
  assert.equal(result.diagnostics.length, 1);
  assert.equal(events.length, 2);
});

test('real result failures and skipped writes remain actionable even in a completed run', () => {
  const events = [
    activity('sync', 'partial', { state: 'warning', written: 1, skipped: 1 }),
    activity('sync', 'skipped', { written: 0, skipped: 1 }),
    activity('compile', 'compile', { state: 'failed', exitCode: 1 }),
    activity('agent', 'scope-violation', { state: 'warning' }),
    activity('tool', 'auth', { state: 'failed' }, { failure: { code: 'authentication_failed' } }),
    notice('guardianWarning', { message: 'A requested operation needs review.' }),
    notice('warning', { message: 'A fatal runtime problem.' }, 'failed')
  ];
  for (const run of [{ status: 'completed', events }, restore(events)]) {
    const result = Model.project(run);
    assert.equal(result.notices.length, events.length);
  }
});

test('local LaTeX compilation failures are not mistaken for routine command attempts', () => {
  for (const command of ['latexmk -pdf main.tex', '/usr/bin/pdflatex main.tex', '/bin/zsh -lc "xelatex main.tex"']) {
    const event = activity('command', command, { state: 'failed', command, exitCode: 1 });
    assert.equal(Model.project({ status: 'completed', events: [event] }).notices.length, 1, command);
  }
});

test('unknown legacy warnings and explicit failures are retained', () => {
  const unknown = activity('notice', 'unknown', { state: 'warning' }, { title: 'Some files were not synced.' });
  const failure = activity('notice', 'failure', { state: 'warning', noticeSource: 'warning' }, {
    title: 'Write confirmation failed.', failure: { code: 'partial_write_needs_review' }
  });
  const result = Model.project(restore([unknown, failure]));
  assert.equal(result.notices.length, 2);
});

test('a resolved result warning needs a completed matching recovery, not just a success headline', () => {
  const failed = activity('sync', 'write', { state: 'warning', resolvedBy: 'recovery' });
  const unrelated = activity('sync', 'recovery', { scope: 'other-thread/turn' });
  const running = activity('sync', 'recovery', { state: 'running' });
  const recovered = activity('sync', 'recovery', { written: 1, skipped: 0 });
  for (const events of [[failed], [failed, unrelated], [failed, running]]) {
    assert.equal(Model.project({ status: 'completed', events }).notices.length, 1);
  }
  const result = Model.project({ status: 'completed', events: [failed, recovered] });
  assert.equal(result.notices.length, 0);
  assert.equal(result.blocks[0].meta.state, 'warning');
});
