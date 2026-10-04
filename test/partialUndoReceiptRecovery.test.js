'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReviewFixture, plain } = require('./_helpers/nativeReviewHarness');
const { createPersistenceFixture } = require('./_helpers/undoPersistenceHarness');

const files = [
  { path: 'nested.tex', before: '% baseline\n', content: '% baseline\n% added nested\n', changes: [] },
  { path: 'main.tex', before: 'before\n', content: 'before\n% added main\n', changes: [] }
];
const fixtures = (page, input = files) => ({ files: input.map(file => ({ path: file.path, content: file.before })),
  operations: input.map(file => ({ type: 'edit', path: file.path, replaceAll: file.content, verifiedContent: file.content })),
  createRouter: () => page.router });

test('actual controller, Page RPC and storage reload resume a partial Undo whose receipt was lost', async t => {
  const page = createReviewFixture(t, { files, reviewing: false, navigationMs: 100 });
  page.state.projectId = 'qa-project'; page.window.location.pathname = '/project/qa-project';
  const old = await createPersistenceFixture(fixtures(page));
  let savedBeforeReceipt;
  old.context.callPageBridge = async (method, params) => {
    assert.equal(method, 'rejectTrackedChanges');
    assert.equal(params.untrackedUndo, true);
    // The running-state debounce reached main persistence before the page reload.
    await old.context.flushQueuedSaveState({ requireDurable: true });
    savedBeforeReceipt = plain(old.memory.rows);
    const pending = page.rpc(method, params);
    await page.timer.until(() => page.state.writes.length === 1);
    page.context.bumpWriteCancellationSequence();
    await page.timer.settle(pending);
    throw new Error('Synthetic document reload lost the per-file Undo receipt');
  };
  let fresh;
  try {
    await page.ready();
    await page.timer.settle(assert.rejects(old.undo(), /lost the per-file Undo receipt/));
    assert.equal(page.docs.get('nested.tex').content, files[0].before);
    assert.equal(page.docs.get('main.tex').content, files[1].content);
    assert.equal(savedBeforeReceipt[0].runs[0].undoStatus, 'running');
    assert.equal(savedBeforeReceipt[0].runs[0].undoExpectedFiles.length, 2);
    old.disposeDocument();

    fresh = await createPersistenceFixture(fixtures(page));
    fresh.memory.rows = savedBeforeReceipt;
    const loaded = await fresh.load();
    for (const key of Object.keys(fresh.run)) delete fresh.run[key];
    Object.assign(fresh.run, loaded.run);
    const received = [];
    fresh.context.callPageBridge = async (method, params) => {
      const result = await page.rpc(method, params); received.push(plain(result)); return result;
    };
    // The independent owner-lease suite covers the background fence. This call
    // starts at its verified owner-free outcome and must remain readonly.
    await fresh.context.getRunReviewController().recoverInterruptedUndoStatuses();
    assert.equal(fresh.run.undoStatus, 'partial');
    assert.equal(page.state.writes.length, 1);
    await page.timer.settle(fresh.undo());

    assert.equal(fresh.run.undoStatus, 'applied', JSON.stringify(received));
    assert.deepEqual(page.state.writes.map(write => write.path), ['nested.tex', 'main.tex']);
    assert.equal(page.docs.get('nested.tex').content, files[0].before);
    assert.equal(page.docs.get('main.tex').content, files[1].before);
    assert.equal((await fresh.load()).run.undoStatus, 'applied');
    assert.equal((await fresh.load()).buttons.undo.disabled, true);
    const unchanged = received[0].applied.find(entry => entry.trackedChange?.path === 'nested.tex');
    assert.equal(unchanged.result.idempotent, true);
    assert.equal(unchanged.result.changedDocument, false);
    assert.equal(unchanged.result.verifiedContent, files[0].before);
  } finally { old.close(); fresh?.close(); page.close(); }
});

async function ordinaryFixture(t, options = {}) {
  const input = options.files || files;
  const page = createReviewFixture(t, { ...options, files: input, reviewing: false });
  page.state.projectId = 'qa-project'; page.window.location.pathname = '/project/qa-project';
  const content = await createPersistenceFixture(fixtures(page, input));
  const responses = [];
  content.context.callPageBridge = async (method, params) => {
    const result = await page.rpc(method, params); responses.push(plain(result)); return result;
  };
  await page.ready();
  t.after(() => { content.close(); page.close(); });
  return { page, content, responses, undo: () => page.timer.settle(content.undo()) };
}

test('all files already restored settle durably without writes or native history calls', async t => {
  const h = await ordinaryFixture(t);
  for (const file of files) h.page.docs.get(file.path).content = file.before;
  await h.undo();
  assert.equal(h.content.run.undoStatus, 'applied');
  assert.equal((await h.content.load()).buttons.undo.disabled, true);
  assert.equal(h.page.state.writes.length, 0);
  assert.equal(h.page.state.dispatches.length, 0);
  assert.equal(h.page.state.fetches.length, 0);
  assert.equal(h.page.state.sourceEdits, 0);
  assert.equal(h.responses[0].saveVerification.state, 'verified_saved');
  assert.equal(h.responses[0].applied.length, 2);
  assert.ok(h.responses[0].applied.every(entry => entry.result.idempotent && entry.result.changedDocument === false));
});

for (const before of ['', 'prefix\nremoved\nsuffix\n']) test('exact preimage safely consumes a checkpoint: ' + JSON.stringify(before), async t => {
  const input = [{ ...files[0], before, content: before ? 'prefix\nsuffix\n' : '% added\n' }, files[1]];
  const h = await ordinaryFixture(t, { files: input });
  h.page.docs.get('nested.tex').content = before;
  await h.undo();
  assert.equal(h.content.run.undoStatus, 'applied');
  assert.equal(h.page.docs.get('nested.tex').content, before);
  assert.deepEqual(h.page.state.writes.map(write => write.path), ['main.tex']);
});

for (const current of ['user replaced the file\n', '% baseline\r\n']) test('a distinct current value preserves the full pending tail: ' + JSON.stringify(current), async t => {
  const h = await ordinaryFixture(t);
  h.page.docs.get('nested.tex').content = current;
  await h.undo();
  assert.equal(h.content.run.undoStatus, 'partial');
  assert.equal(h.page.state.writes.length, 0);
  assert.equal(h.page.docs.get('nested.tex').content, current);
  assert.equal(h.page.docs.get('main.tex').content, files[1].content);
  assert.equal((await h.content.load()).run.undoExpectedFiles.length, 2);
});

for (const change of ['content', 'docId', 'native-refs', 'project']) test('preflight ' + change + ' drift cannot turn an observed preimage into recovery authority', async t => {
  let mainOpens = 0;
  const h = await ordinaryFixture(t, { onOpen({ path, state, docs }) {
    if (path !== 'main.tex' || ++mainOpens !== 2) return;
    const nested = docs.get('nested.tex');
    if (change === 'content') nested.content = 'collaborator replacement\n';
    if (change === 'docId') nested.id = 'new-same-content-entity';
    if (change === 'native-refs') nested.changes = [{ id: 'other-user-change', op: { p: 0, i: '%' } }];
    if (change === 'project') state.projectId = 'different-project';
  } });
  h.page.docs.get('nested.tex').content = files[0].before;
  await h.undo();
  assert.equal(h.content.run.undoStatus, 'partial');
  assert.equal(h.page.state.writes.length, 0);
  assert.equal(h.page.docs.get('main.tex').content, files[1].content);
  assert.equal((await h.content.load()).run.undoExpectedFiles.length, 2);
});

test('post-write drift prevents a false terminal and preserves the changed file checkpoint', async t => {
  const h = await ordinaryFixture(t, { onWrite({ path, docs }) {
    if (path === 'main.tex') docs.get('nested.tex').content = 'later collaborator content\n';
  } });
  h.page.docs.get('nested.tex').content = files[0].before;
  await h.undo();
  assert.equal(h.content.run.undoStatus, 'partial');
  assert.equal(h.page.docs.get('nested.tex').content, 'later collaborator content\n');
  assert.deepEqual(h.page.state.writes.map(write => write.path), ['main.tex']);
  assert.deepEqual((await h.content.load()).run.undoExpectedFiles.map(file => file.path), ['nested.tex']);
  await h.undo();
  assert.equal(h.content.run.undoStatus, 'partial');
  assert.equal(h.page.state.writes.length, 1);
});

test('a tracked run with missing ownership cannot claim a same-text baseline as recovered', async t => {
  const page = createReviewFixture(t, { files, reviewing: true });
  t.after(() => page.close()); await page.ready();
  page.docs.get('nested.tex').content = files[0].before;
  const result = await page.timer.settle(page.rpc('rejectTrackedChanges', {
    runProjectId: 'project-one', untrackedUndo: false,
    expectedFiles: files.map(file => ({ path: file.path, content: file.before })),
    postFiles: files.map(file => ({ path: file.path, content: file.content })),
    trackedChanges: [{ path: 'nested.tex', key: 'native:missing-owned-ref', id: 'missing-owned-ref' }]
  }));
  assert.equal(result.ok, false); assert.equal(result.applied.length, 0);
  assert.equal(page.state.writes.length, 0); assert.equal(page.state.fetches.length, 0);
});
