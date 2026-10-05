'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReviewFixture } = require('./_helpers/nativeReviewHarness');

const paths = ['main.tex', 'nested/part.tex'];
function fixture(t, options = {}) {
  const files = paths.map((path, i) => {
    const before = `% baseline ${i}\n`, marker = `% current marker ${i}\n`;
    return { path, before, content: before + marker,
      changes: [{ id: 'current-' + i, op: { p: before.length, i: marker } }] };
  });
  let page, readyAt = 0, waiting = false;
  page = createReviewFixture(t, { files, editorUndoPaths: paths,
    editorUndoNoProgressPaths: options.noProgress ? [paths[1]] : [],
    editorUndoPresent({ state, timer }) {
      return !options.missing || state.active !== paths[1] || timer.now >= readyAt;
    },
    editorUndoDisabled({ state, timer }) {
      if (state.active !== paths[1] || options.noProgress) return false;
      const disabled = options.permanent || timer.now < readyAt;
      if (disabled && state.editorUndos?.includes(paths[0])) waiting = true;
      return disabled;
    },
    onOpen({ path, state, docs }) {
      if (path !== paths[1]) return;
      readyAt = page.timer.now + (options.delayMs ?? 180);
      if (state.editorUndos?.includes(paths[0]) && options.drift) {
        page.timer.setTimeout(() => options.drift({ state, docs }), 60);
      }
    }
  });
  t.after(() => page.close());
  const refs = [];
  for (const path of paths) {
    page.state.active = path;
    refs.push(...page.capture.prepareTrackedChangeCapture(path).refs);
  }
  page.state.active = paths[0];
  return { ...page, files, waiting: () => waiting,
    start(extras = {}) { return page.rpc('rejectTrackedChanges', { runProjectId: 'project-one', trackedChanges: refs,
      expectedFiles: files.map(file => ({ path: file.path, content: file.before })),
      postFiles: files.map(file => ({ path: file.path, content: file.content })), ...extras }); } };
}

function firstRestoredOnly(h, result) {
  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].result.verifiedContent, h.files[0].before);
  assert.equal(h.docs.get(paths[0]).content, h.files[0].before);
  assert.equal(h.docs.get(paths[1]).content, h.files[1].content);
  assert.equal(h.docs.get(paths[1]).changes.length, 1);
  assert.equal(h.state.writes.length, 0);
}

for (const kind of ['missing', 'disabled']) test('Track Undo waits for a ' + kind + ' second-file native Undo control after exact text and ledger readiness', async t => {
  const h = fixture(t, { missing: kind === 'missing' }); await h.ready();
  const result = await h.timer.settle(h.start());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.applied.length, 2);
  assert.deepEqual(h.state.editorUndos, paths);
  assert.ok(h.files.every(file => h.docs.get(file.path).content === file.before && h.docs.get(file.path).changes.length === 0));
  assert.equal(h.state.writes.length, 0, 'must use the native Undo controls, without snapshot text replacement');
  assert.equal(result.saveVerification.ok, true);
});

test('a permanently disabled native Undo control remains a bounded partial result with retained native change', async t => {
  const h = fixture(t, { permanent: true }); await h.ready();
  const started = h.timer.now, result = await h.timer.settle(h.start());
  firstRestoredOnly(h, result);
  assert.equal(result.skipped[0].result.code, 'tracked_change_not_found');
  assert.deepEqual(h.state.editorUndos, [paths[0]]);
  assert.ok(h.timer.now - started < 8000);
});

for (const kind of ['cancellation', 'deadline']) test('native Undo control wait honors ' + kind + ' after a verified first file', async t => {
  const h = fixture(t, { permanent: true }); await h.ready();
  const pending = h.start(kind === 'deadline' ? { deadlineAt: h.timer.now + 400 } : {});
  await h.timer.until(h.waiting);
  if (kind === 'cancellation') await h.timer.settle(h.rpc('cancelActiveWrite', {}));
  const result = await h.timer.settle(pending);
  firstRestoredOnly(h, result);
  assert.equal(result.skipped[0].result.code, kind === 'cancellation' ? 'codex_cancelled' : 'writeback_deadline_exceeded');
  assert.deepEqual(h.state.editorUndos, [paths[0]]);
  await h.timer.settle(h.timer.sleep(10000));
  assert.deepEqual(h.state.editorUndos, [paths[0]], 'late control readiness must not restart the expired action');
});

const drifts = {
  path: ({ state }) => { state.active = paths[0]; },
  content: ({ docs }) => { docs.get(paths[1]).content += '% human edit\n'; },
  document: ({ docs }) => { docs.get(paths[1]).id = 'replacement-document'; },
  ledger: ({ docs }) => { docs.get(paths[1]).changes.push({ id: 'collaborator', op: { p: 0, i: '% baseline 1\n' } }); }
};
for (const [kind, drift] of Object.entries(drifts)) test('native Undo control wait stops all fallback on ' + kind + ' drift', async t => {
  const h = fixture(t, { drift }); await h.ready();
  const result = await h.timer.settle(h.start());
  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 1);
  assert.equal(result.skipped[0].result.code, 'native_review_scope_changed');
  assert.deepEqual(h.state.editorUndos, [paths[0]]);
  assert.equal(h.state.writes.length, 0);
  assert.equal(h.docs.get(paths[0]).content, h.files[0].before);
  assert.equal(h.docs.get(paths[1]).content, h.files[1].content + (kind === 'content' ? '% human edit\n' : ''));
  assert.equal(h.docs.get(paths[1]).changes.length, kind === 'ledger' ? 2 : 1);
});

test('an enabled native Undo control with no progress is clicked only once', async t => {
  const h = fixture(t, { noProgress: true }); await h.ready();
  const result = await h.timer.settle(h.start());
  firstRestoredOnly(h, result);
  assert.deepEqual(h.state.editorUndos, paths, 'readiness polling must not repeat an already dispatched Undo');
});
