'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const Notice = require('../extension/src/content/runFailureNotice');
const Session = require('../extension/src/shared/sessionState');
const timeline = fs.readFileSync(path.join(__dirname, '../extension/src/content/runTimelineView.js'), 'utf8');
const runtime = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
const failed = title => ({ title, status: 'failed', kind: 'activity',
  activity: { v: 1, kind: 'notice', state: 'failed', output: title } });
const titles = ['Undo result: undone 1 item(s), skipped 2 item(s)',
  'Undo result: rejected 0 tracked change(s), skipped 1',
  'Undo result: undone 0 file(s), skipped 1',
  '撤销结果：已撤销 0 项，跳过 2 项', '撤销结果：已拒绝 1 条留痕，跳过 2 条'];
for (const terminal of [{ undoStatus: 'applied' }, { trackedChangeStatus: 'rejected' }]) {
  test('resolved undo hides only obsolete attempt notices: ' + JSON.stringify(terminal), () => {
    const other = failed('Could not compile the current document.');
    const stream = { ...failed(titles[0]), kind: 'stream', streamRole: 'assistant' };
    const completed = { ...failed(titles[0]), status: 'completed' };
    const run = { ...terminal, events: [...titles.map(failed), other, stream, completed] };
    const saved = JSON.stringify(run), projected = Notice.projectResolvedUndo(run);
    assert.deepEqual(projected.events, [other, stream, completed]);
    assert.equal(JSON.stringify(run), saved, 'raw events and normalized activity metadata remain intact');
  });
}
for (const status of [{}, { undoStatus: 'running' }, { undoStatus: 'partial' },
  { trackedChangeStatus: 'needs_review' }, { trackedChangeStatus: 'accepted' }]) {
  test('unresolved or accepted run retains its failed undo evidence: ' + JSON.stringify(status), () => {
    const run = { ...status, events: titles.map(failed) };
    assert.equal(Notice.projectResolvedUndo(run), run);
  });
}
test('presentation remains selective after session hydration', () => {
  const hydrated = Session.normalizePanelState({ sessions: [{ id: 's', runs: [{ id: 'r', status: 'completed',
    undoStatus: 'applied', events: [failed(titles[0]), failed('Unrelated write failed')] }] }], activeSessionId: 's' });
  const run = hydrated.sessions[0].runs[0];
  assert.equal(run.events.length, 2);
  assert.deepEqual(Notice.projectResolvedUndo(run).events.map(event => event.title), ['Unrelated write failed']);
});
test('live activity projection uses the same filtered run without changing persistence', () => {
  let options;
  const run = { id: 'r', undoStatus: 'applied', events: [failed(titles[0])] };
  const context = vm.createContext({ window: {} });
  vm.runInContext(timeline, context);
  context.window.CodexOverleafRunTimelineView.create({ RunFailureNotice: Notice,
    RunActivitySummary: { create(value) { options = value; return {}; } }, findRunRecord: () => run });
  assert.equal(options.findRunRecord('r').events.length, 0);
  assert.equal(run.events.length, 1);
});
function extract(source, name) {
  const match = new RegExp('^  (?:async )?function ' + name + '\\(', 'm').exec(source);
  assert.ok(match, name);
  const end = /\n  }(?=\n|$)/.exec(source.slice(match.index + match[0].length));
  assert.ok(end, name + ' closing boundary');
  return source.slice(match.index, match.index + match[0].length + end.index + end[0].length);
}
test('resolved card refresh preserves disclosure and scroll position', () => {
  const run = { id: 'r', undoStatus: 'applied', events: [failed(titles[0])] };
  const process = { open: false }, next = { querySelector: () => process };
  let replacement, restored;
  const existing = { querySelector: () => ({ open: true }), replaceWith: node => { replacement = node; } };
  const log = { querySelector: () => existing };
  const context = vm.createContext({ getPanel: () => ({ querySelector: () => log }),
    cssEscape: value => value, findRunRecord: () => run, displayRun: Notice.projectResolvedUndo,
    scrollLayout: { snapshot: () => ({ scrollTop: 123 }), restore: value => { restored = value; } },
    renderRunCard: value => { assert.equal(value, run); return next; } });
  vm.runInContext(extract(timeline, 'refreshRunCard'), context);
  assert.equal(context.refreshRunCard('r'), true);
  assert.equal(replacement, next);
  assert.equal(process.open, true);
  assert.equal(restored.scrollTop, 123);
});
test('settlement control refresh replaces the resolved transcript before stale rows survive', () => {
  let refreshed = 0;
  const context = vm.createContext({ findRunRecord: () => ({ id: 'r' }),
    panel: { querySelector: () => ({}) }, cssEscape: value => value,
    runTimelineView: { refreshResolvedUndo: id => { assert.equal(id, 'r'); refreshed++; return true; } },
    configureAcceptButton() { assert.fail('old card must not be reused'); } });
  vm.runInContext(extract(runtime, 'refreshRunCardControls'), context);
  context.refreshRunCardControls('r');
  assert.equal(refreshed, 1);
});
