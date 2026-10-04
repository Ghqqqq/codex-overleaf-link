'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createReviewFixture } = require('./_helpers/nativeReviewHarness');
const Save = require('../extension/src/page/saveState');
const files = count => Array.from({ length: count }, (_, i) => ({ path: `section-${i}.tex`, before: `before ${i}\n`,
  content: `before ${i}\n% added\n`, changes: [] }));
function start(h, extras = {}) { return h.rpc('rejectTrackedChanges', { ...h.requestParams(), trackedChanges: [], untrackedUndo: true, ...extras }); }

test('default 120-second client budget stops a 40-file native Undo before any late writes and returns partial evidence', async t => {
  const h = createReviewFixture(t, { files: files(40), reviewing: false, navigationMs: 1100 });
  try {
    await h.ready(); const began = h.timer.now;
    const result = await h.timer.settle(start(h));
    const request = h.posted.find(message => message.method === 'rejectTrackedChanges');
    assert.equal(request.params.deadlineAt, began + 120000);
    assert.equal(result.ok, false); assert.ok(result.applied.length > 0); assert.ok(result.applied.length < 40);
    assert.equal(result.applied.length, h.state.writes.length);
    assert.ok(result.skipped.length > 0);
    assert.ok(h.state.writes.every(write => write.at < began + 120000));
    const completedWrites = h.state.writes.length;
    await h.timer.settle(h.timer.sleep(30000));
    assert.equal(h.state.writes.length, completedWrites, 'expired request cannot start further editor writes');
    t.diagnostic(JSON.stringify({ deadlineAt: request.params.deadlineAt, applied: result.applied.length,
      skipped: result.skipped.length, lastWriteAt: h.state.writes.at(-1).at, writesAfter30Seconds: h.state.writes.length }));
  } finally { h.close(); }
});

test('normal native Undo keeps default policy and completes with saved proof', async t => {
  const h = createReviewFixture(t, { files: files(2), reviewing: false, navigationMs: 100 });
  try {
    await h.ready(); const result = await h.timer.settle(start(h));
    assert.equal(result.ok, true); assert.equal(result.applied.length, 2); assert.equal(result.skipped.length, 0);
    assert.equal(result.saveVerification.ok, true); assert.equal(h.state.writes.length, 2);
  } finally { h.close(); }
});

test('cancellation during native preparation stays active through later restore and writes nothing', async t => {
  const h = createReviewFixture(t, { files: files(6), reviewing: false, navigationMs: 1100 });
  try {
    await h.ready(); const pending = start(h);
    await h.timer.until(() => h.state.opens.length >= 2);
    await h.timer.settle(h.rpc('cancelActiveWrite', {}));
    const result = await h.timer.settle(pending);
    assert.equal(result.ok, false); assert.equal(h.state.writes.length, 0);
    assert.equal(result.skipped[0].result.code, 'codex_cancelled');
  } finally { h.close(); }
});

test('project switch during preparation refuses restoration in the new project', async t => {
  const h = createReviewFixture(t, { files: files(5), reviewing: false, navigationMs: 1100 });
  try {
    await h.ready(); const pending = start(h);
    await h.timer.until(() => h.state.opens.length >= 1); h.state.projectId = 'new-project';
    const result = await h.timer.settle(pending);
    assert.equal(result.ok, false); assert.equal(h.state.writes.length, 0);
  } finally { h.close(); }
});

test('cancellation after the first restored file retains its proof and stops the remaining writes', async t => {
  const h = createReviewFixture(t, { files: files(5), reviewing: false, navigationMs: 200 });
  try {
    await h.ready(); const pending = start(h);
    await h.timer.until(() => h.state.writes.length > 0);
    await h.timer.settle(h.rpc('cancelActiveWrite', {}));
    const result = await h.timer.settle(pending);
    assert.equal(result.ok, false); assert.ok(result.applied.length > 0);
    assert.equal(result.applied.length, h.state.writes.length); assert.ok(result.applied.length < 5);
    const count = h.state.writes.length;
    await h.timer.settle(h.timer.sleep(10000)); assert.equal(h.state.writes.length, count);
    assert.ok(result.skipped.some(entry => entry.result.code === 'codex_cancelled'));
  } finally { h.close(); }
});

test('source guard still protects human changes made while the next file opens', async t => {
  const h = createReviewFixture(t, { files: files(4), reviewing: false, navigationMs: 100 });
  try {
    await h.ready(); const pending = start(h);
    await h.timer.until(() => h.state.writes.length >= 1);
    h.docs.get('section-2.tex').content = 'human edit';
    const result = await h.timer.settle(pending);
    assert.equal(result.ok, false); assert.equal(h.docs.get('section-2.tex').content, 'human edit');
    assert.ok(result.applied.length > 0);
  } finally { h.close(); }
});

test('an explicit short deadline prevents navigation completion from starting a write', async t => {
  const h = createReviewFixture(t, { files: files(3), reviewing: false, navigationMs: 1100 });
  try {
    await h.ready(); const result = await h.timer.settle(start(h, { deadlineAt: h.timer.now + 1500 }));
    assert.equal(result.ok, false); assert.equal(h.state.writes.length, 0);
    await h.timer.settle(h.timer.sleep(10000)); assert.equal(h.state.writes.length, 0);
  } finally { h.close(); }
});

test('review save verification is capped by the original deadline and never accepts a late snapshot', async () => {
  let now = 1000, reads = 0, readBudget;
  const result = { ok: true, applied: [{ trackedChange: { path: 'main.tex' }, result: { ok: true, verifiedContent: 'before' } }], skipped: [] };
  const answer = await Save.confirmReviewWriteback({
    params: { runProjectId: 'p', deadlineAt: 1100, expectedFiles: [{ path: 'main.tex', content: 'before' }] }, result,
    now: () => now, getProjectId: () => 'p', delay: async ms => { now += ms; },
    readSnapshot: async options => { reads++; readBudget = options.zipTimeoutMs; now = 1101;
      return { ok: true, files: [{ path: 'main.tex', content: 'before', source: 'overleaf-zip' }] }; }
  });
  assert.equal(answer.ok, false); assert.equal(answer.applied.length, 1); assert.equal(reads, 1);
  assert.ok(readBudget <= 100);
  assert.equal(answer.saveVerification.ok, false);
});
