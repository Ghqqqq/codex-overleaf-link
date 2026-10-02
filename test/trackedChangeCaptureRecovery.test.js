const assert = require('node:assert/strict');
const test = require('node:test');
const Capture = require('../extension/src/page/trackedChangeCapture');
const Controller = require('../extension/src/content/trackedChangeCaptureController');
const StorageActions = require('../extension/src/shared/storageRunActions');
const Evidence = require('../extension/src/shared/writebackOperationEvidence');

function node({ pos = null, id = '', text = 'the', file = 'main.tex', className = 'review-panel-entry review-panel-entry-change review-panel-entry-insert' } = {}) {
  return {
    tagName: 'DIV', className, textContent: 'Added: ' + text, innerText: 'Added: ' + text,
    getAttribute(name) {
      return { 'data-pos': pos === null ? null : String(pos), 'data-change-id': id || null, 'data-path': file }[name] ?? null;
    },
    closest() { return null; },
    querySelector(selector) { return selector === '.review-panel-entry-user' ? { textContent: 'author' } : null; },
    querySelectorAll(selector) {
      return selector === '.review-panel-expandable-content' ? [{ textContent: text }] : [];
    }
  };
}
function harness(nodes = () => [], clockStep = 0, overrides = {}) {
  let clock = 0, activePath = 'main.tex', current = 'the';
  const api = Capture.create({
    now: () => { const value = clock; clock += clockStep; return value; },
    delay: async ms => { clock += ms; },
    collectElements: () => nodes(clock),
    compact: (value, limit) => String(value).replace(/\s+/g, ' ').trim().slice(0, limit),
    getActiveFilePath: () => activePath,
    getProjectId: () => 'project-a',
    readActiveEditorText: () => current,
    isInsideCodexPanel: () => false,
    normalizeSafeProjectPath: value => String(value || ''),
    readNodeSignalText: value => [value.innerText, value.textContent, value.className].join(' '),
    ...overrides
  });
  const operation = { type: 'edit', path: 'main.tex', patches: [{ from: 0, to: 3, expected: 'old', insert: 'the' }] };
  return {
    api, operation,
    write: (before = []) => api.captureTrackedWrite({
      trackedBefore: before, operation, beforeContent: 'old', postContent: 'the', runProjectId: 'project-a'
    }),
    getClock: () => clock,
    setClock: value => { clock = value; },
    setPath: value => { activePath = value; },
    setText: value => { current = value; }
  };
}

test('identical insertions at three positions retain three references', async () => {
  const h = harness(() => [node({ pos: 10 }), node({ pos: 40 }), node({ pos: 80 })]);
  const result = await h.api.waitForTrackedChangeDiff([], ['main.tex'], { waitMs: 1800 });
  assert.equal(result.trackedChanges.length, 3);
  assert.equal(new Set(result.trackedChanges.map(ref => ref.key)).size, 3);
});

test('full change text distinguishes equal prefixes at the same position', () => {
  const prefix = 'a'.repeat(220);
  const h = harness(() => [node({ pos: 10, text: prefix + 'x' }), node({ pos: 10, text: prefix + 'y' })]);
  const refs = h.api.collectTrackedChangeRefsForPaths(['main.tex']);
  assert.notEqual(refs[0].key, refs[1].key);
});

test('highlight and surrounding display text do not change positional identity', () => {
  const item = node({ pos: 10 });
  const h = harness(() => [item]);
  const key = h.api.collectTrackedChangeRefsForPaths(['main.tex'])[0].key;
  item.className += ' review-panel-entry-highlighted';
  item.innerText = 'A different date label; Added: the';
  assert.equal(h.api.collectTrackedChangeRefsForPaths(['main.tex'])[0].key, key);
});

test('ordinary numeric DOM ids cannot masquerade as tracked changes', () => {
  const ordinary = node({ className: 'pdf-annotation' });
  ordinary.getAttribute = attr => attr === 'id' ? 'pdfjs_internal_id_1234' : null;
  const h = harness(() => [ordinary]);
  assert.deepEqual(h.api.collectTrackedChangeRefsForPaths(['main.tex']), []);
});

test('collection accumulates later batches instead of stopping at the first reference', async () => {
  const h = harness(time => [node({ id: 'a' }), ...(time >= 720 ? [node({ id: 'b' })] : []),
    ...(time >= 1980 ? [node({ id: 'c' })] : [])]);
  const result = await h.api.waitForTrackedChangeDiff([], ['main.tex'], { waitMs: 3000 });
  assert.deepEqual(result.trackedChanges.map(ref => ref.id), ['a', 'b', 'c']);
});

test('markers appearing after the former 1.8 second limit can be captured', async () => {
  const h = harness(time => time >= 3200 ? [node({ id: 'late' })] : []);
  const result = await h.write();
  assert.equal(result.capture.state, 'observed');
  assert.equal(result.trackedChanges[0].id, 'late');
});

test('a timeout leaves explicit pending evidence and no actionable references', async () => {
  const h = harness();
  const result = await h.write();
  assert.equal(result.capture.state, 'pending');
  assert.equal(result.capture.reason, 'capture_timeout');
  assert.deepEqual(result.trackedChanges, []);
  assert.equal(result.capture.diagnostics.capturedCount, 0);
});

test('serialized capture evidence can be reconciled after delayed rendering', async () => {
  const h = harness(time => time >= 6000 ? [node({ pos: 0 })] : []);
  const first = await h.write();
  h.setClock(6000);
  const result = await h.api.reconcileTrackedChangeCapture({
    runProjectId: 'project-a', capture: JSON.parse(JSON.stringify(first.capture)), expectedContent: 'the'
  });
  assert.equal(result.capture.state, 'observed');
  assert.equal(result.trackedChanges.length, 1);
});

test('pre-existing same-text changes and shifted positions are excluded', async () => {
  let after = false;
  const h = harness(() => after ? [node({ pos: 0 }), node({ pos: 23 })] : [node({ pos: 20 })]);
  const before = h.api.collectTrackedChangeRefsForPaths(['main.tex']);
  after = true;
  h.setText('theold');
  const result = await h.api.captureTrackedWrite({
    trackedBefore: before,
    operation: { type: 'edit', path: 'main.tex', patches: [{ from: 0, to: 0, insert: 'the' }] },
    beforeContent: 'old', postContent: 'theold', runProjectId: 'project-a'
  });
  assert.equal(result.capture.state, 'observed');
  assert.equal(result.trackedChanges.length, 1);
  assert.match(result.trackedChanges[0].key, /^pos:0:/);
});

test('overlap with a pre-existing positional change remains non-actionable', async () => {
  const h = harness(() => [node({ pos: 1 })]);
  const result = await h.write(h.api.collectTrackedChangeRefsForPaths(['main.tex']));
  assert.equal(result.capture.state, 'needs_review');
  assert.equal(result.capture.reason, 'preexisting_change_overlap');
  assert.deepEqual(result.trackedChanges, []);
});

test('missing ranges keep a partial capture pending', async () => {
  const h = harness(() => [node({ pos: 0 })]);
  h.setText('the---the');
  const result = await h.api.captureTrackedWrite({
    trackedBefore: [], beforeContent: 'old---old', postContent: 'the---the', runProjectId: 'project-a',
    operation: { path: 'main.tex', patches: [
      { from: 0, to: 3, insert: 'the' }, { from: 6, to: 9, insert: 'the' }
    ] }
  });
  assert.equal(result.capture.state, 'pending');
  assert.deepEqual(result.trackedChanges, []);
});

test('post-write user edits stop automatic reconciliation', async () => {
  const h = harness();
  const first = await h.write();
  h.setText('user edit');
  const result = await h.api.reconcileTrackedChangeCapture({
    runProjectId: 'project-a', capture: first.capture, expectedContent: 'the'
  });
  assert.equal(result.capture.state, 'needs_review');
  assert.equal(result.capture.reason, 'capture_context_changed');
});

test('project mismatch and expiry cannot recover references', async () => {
  const h = harness();
  const first = await h.write();
  const mismatch = await h.api.reconcileTrackedChangeCapture({
    runProjectId: 'project-b', capture: first.capture, expectedContent: 'the'
  });
  assert.equal(mismatch.ok, false);
  h.setClock(36000);
  const expired = await h.api.reconcileTrackedChangeCapture({
    runProjectId: 'project-a', capture: first.capture, expectedContent: 'the'
  });
  assert.equal(expired.capture.state, 'needs_review');
  assert.equal(expired.capture.reason, 'capture_expired');
});

function pendingRun() {
  return {
    id: 'run-a', runProjectId: 'project-a', startedAt: '2026-09-09T00:00:00.000Z', status: 'completed',
    executionSnapshot: { requireReviewing: true },
    appliedOperations: [{ type: 'edit', path: 'main.tex', verifiedContent: 'the' }],
    undoExpectedFiles: [{ path: 'main.tex', content: 'old' }], undoTrackedChanges: [],
    trackedChangeCaptures: [{ version: 1, path: 'main.tex', runProjectId: 'project-a',
      state: 'pending', startedAt: 0, expiresAt: 35000, before: [], refs: [] }]
  };
}
function worker(records, rpc, overrides = {}) {
  let saves = 0, refreshes = 0;
  const controller = Controller.create({
    getRuns: () => records, getProjectId: () => 'project-a', now: () => 6000,
    setTimeout: () => 1, clearTimeout() {},
    buildExpectedFilesAfterOperations: () => new Map([['main.tex', 'the']]),
    normalizeTrackedChanges: Evidence.normalizeTrackedChanges,
    persist: async () => { saves++; },
    refresh: () => { refreshes++; },
    callPageBridge: rpc, ...overrides
  });
  return { controller, saves: () => saves, refreshes: () => refreshes };
}

test('worker persists recovered references without changing completed task status', async () => {
  const run = pendingRun();
  const w = worker([run], async (_method, params) => ({ capture: {
    ...params.capture, state: 'observed', refs: [{ key: 'id:new', id: 'new', path: 'main.tex' }]
  } }));
  await w.controller.flush();
  assert.equal(run.status, 'completed');
  assert.equal(run.trackedChangeStatus, 'pending');
  assert.equal(run.undoTrackedChanges.length, 1);
  assert.equal(w.saves(), 1);
  assert.equal(w.refreshes(), 1);
  w.controller.dispose();
});

test('a newer task prevents attribution to the previous task', async () => {
  const run = pendingRun();
  let calls = 0;
  const w = worker([run, { id: 'run-b', runProjectId: 'project-a', startedAt: '2026-09-09T00:00:01.000Z' }],
    async () => { calls++; });
  await w.controller.flush();
  assert.equal(calls, 0);
  assert.equal(run.trackedChangeCaptures[0].state, 'needs_review');
  assert.deepEqual(run.undoTrackedChanges, []);
  w.controller.dispose();
});

test('navigation during an awaited response cannot mutate the previous run', async () => {
  const run = pendingRun();
  let project = 'project-a';
  const w = worker([run], async (_method, params) => {
    project = 'project-b';
    return { capture: { ...params.capture, state: 'observed', refs: [{ key: 'id:new', path: 'main.tex' }] } };
  }, { getProjectId: () => project });
  await w.controller.flush();
  assert.deepEqual(run.undoTrackedChanges, []);
  assert.equal(w.saves(), 0);
  w.controller.dispose();
});

test('terminal and forked runs cannot be resurrected by background capture', async () => {
  for (const patch of [{ trackedChangeStatus: 'accepted' }, { undoStatus: 'applied' }, { forkSnapshot: true }]) {
    const run = Object.assign(pendingRun(), patch);
    const w = worker([run], async () => { throw new Error('must not call'); });
    await w.controller.flush();
    assert.deepEqual(run.trackedChangeCaptures, []);
    assert.deepEqual(run.undoTrackedChanges, []);
    w.controller.dispose();
  }
});

test('action storage round-trips pending capture and keeps Undo within the action budget', () => {
  const run = pendingRun();
  const payload = StorageActions.compactRunActionPayload(run, true);
  assert.deepEqual(payload.trackedChangeCaptures, run.trackedChangeCaptures);
  run.trackedChangeCaptures[0].oversize = 'x'.repeat(2100 * 1024);
  const limited = StorageActions.compactRunActionPayload(run, true);
  assert.deepEqual(limited.appliedOperations, run.appliedOperations);
  assert.deepEqual(limited.undoExpectedFiles, run.undoExpectedFiles);
  assert.equal(limited.trackedChangeCaptures, undefined);
});

test('unicode fingerprint includes both halves of supplementary characters', () => {
  const h = harness(() => [node({ pos: 10, text: 'A\u{1F600}B' }), node({ pos: 10, text: 'A\u{1F601}B' })]);
  const refs = h.api.collectTrackedChangeRefsForPaths(['main.tex']);
  assert.notEqual(refs[0].key, refs[1].key);
});

test('capture start and deadline share one clock snapshot even across millisecond ticks', async () => {
  const h = harness(() => [node({ pos: 0 })], 1);
  const result = await h.write();
  assert.equal(result.capture.state, 'observed');
  assert.equal(result.capture.expiresAt - result.capture.startedAt, 35000);
});

test('native ledger captures document-start and document-end writes when DOM renders only the end', async () => {
  const beforeContent = 'body\n';
  const marker = '% same marker\n';
  const postContent = marker + beforeContent + marker;
  const end = marker.length + beforeContent.length;
  const nativeChanges = [{ id: 'start-id', op: { p: 0, i: marker } }, { id: 'end-id', op: { p: end, i: marker } }];
  const h = harness(() => [node({ pos: end, text: marker })], 0, {
    getCodeMirrorEditorView: () => ({ state: { doc: { length: postContent.length, toString: () => postContent }, values: [{ ranges: { docId: 'doc-a', changes: nativeChanges, comments: [] }, threads: {} }] } }),
    getTrackedChangeDocumentId: () => 'doc-a'
  });
  h.setText(postContent);
  const result = await h.api.captureTrackedWrite({
    trackedBefore: [], captureBaseline: { source: 'native', ready: true, nativeDocId: 'doc-a', refs: [] },
    operation: { type: 'edit', path: 'main.tex', patches: [{ from: 0, to: 0, insert: marker }, { from: beforeContent.length, to: beforeContent.length, insert: marker }] },
    beforeContent, postContent, runProjectId: 'project-a'
  });
  assert.equal(result.capture.state, 'observed');
  assert.equal(result.trackedChanges.length, 2);
  assert.deepEqual(result.trackedChanges.map(ref => ref.id), ['start-id', 'end-id']);
});

function nativeFixture(initial = 'old', nodes = () => []) {
  let text = initial, changes = [], docId = 'doc-a';
  const h = harness(nodes, 0, {
    getCodeMirrorEditorView: () => ({ state: {
      doc: { length: text.length, toString: () => text },
      values: [{ ranges: { docId: typeof docId === 'function' ? docId(h.getClock()) : docId,
        changes: typeof changes === 'function' ? changes(h.getClock()) : changes, comments: [] }, threads: {} }]
    } }),
    getTrackedChangeDocumentId: () => 'doc-a'
  });
  h.setText(initial);
  return { ...h,
    setDocument(value) { text = value; h.setText(value); },
    setChanges(value) { changes = value; },
    setDocumentId(value) { docId = value; }
  };
}

test('native baseline is authoritative even when empty and DOM contains unrelated markers', () => {
  const f = nativeFixture('old', () => { throw new Error('native capture must not enumerate DOM'); });
  const baseline = f.api.prepareTrackedChangeCapture('main.tex');
  assert.equal(baseline.source, 'native');
  assert.equal(baseline.ready, true);
  assert.deepEqual(baseline.refs, []);
  assert.equal(f.api.getTrackedChangeCaptureStatus().adapter, 'cm-ranges-v1');
});

test('native IDs exclude pre-existing changes after their positions move', async () => {
  const f = nativeFixture('old-tail');
  f.setChanges([{ id: 'old-id', op: { p: 4, i: 'tail' } }]);
  const baseline = f.api.prepareTrackedChangeCapture('main.tex');
  f.setDocument('newold-tail');
  f.setChanges([{ id: 'old-id', op: { p: 7, i: 'tail' } }, { id: 'new-id', op: { p: 0, i: 'new' } }]);
  const result = await f.api.captureTrackedWrite({
    trackedBefore: baseline.refs, captureBaseline: baseline,
    operation: { path: 'main.tex', patches: [{ from: 0, to: 0, insert: 'new' }] },
    beforeContent: 'old-tail', postContent: 'newold-tail', runProjectId: 'project-a'
  });
  assert.equal(result.capture.state, 'observed');
  assert.deepEqual(result.trackedChanges.map(ref => ref.id), ['new-id']);
  assert.equal(baseline.refs[0].from, 4);
});

test('native deletion records work without a rendered deletion widget', async () => {
  const f = nativeFixture('prefix REMOVE suffix');
  const baseline = f.api.prepareTrackedChangeCapture('main.tex');
  f.setDocument('prefix  suffix');
  f.setChanges([{ id: 'delete-id', op: { p: 7, d: 'REMOVE' } }]);
  const result = await f.api.captureTrackedWrite({
    trackedBefore: baseline.refs, captureBaseline: baseline,
    operation: { path: 'main.tex', patches: [{ from: 7, to: 13, insert: '' }] },
    beforeContent: 'prefix REMOVE suffix', postContent: 'prefix  suffix', runProjectId: 'project-a'
  });
  assert.equal(result.capture.state, 'observed');
  assert.equal(result.trackedChanges[0].kind, 'delete');
});

test('a deletion merged with older deleted text is not assigned to the current run', async () => {
  const f = nativeFixture('REMOVE body');
  f.setChanges([{ id: 'older-delete', op: { p: 0, d: 'OLD' } }]);
  const baseline = f.api.prepareTrackedChangeCapture('main.tex');
  f.setDocument(' body');
  f.setChanges([{ id: 'merged-delete', op: { p: 0, d: 'OLDREMOVE' } }]);
  const result = await f.api.captureTrackedWrite({
    trackedBefore: baseline.refs, captureBaseline: baseline,
    operation: { path: 'main.tex', patches: [{ from: 0, to: 6, insert: '' }] },
    beforeContent: 'REMOVE body', postContent: ' body', runProjectId: 'project-a'
  });
  assert.equal(result.capture.state, 'pending');
  assert.deepEqual(result.trackedChanges, []);
});

test('separate native fragments sharing an ID do not collapse across positions', async () => {
  const f = nativeFixture('body\n');
  const baseline = f.api.prepareTrackedChangeCapture('main.tex');
  f.setDocument('#\nbody\n#\n');
  f.setChanges([{ id: 'batch-id', op: { p: 0, i: '#\n' } }, { id: 'batch-id', op: { p: 7, i: '#\n' } }]);
  const result = await f.api.captureTrackedWrite({
    trackedBefore: baseline.refs, captureBaseline: baseline,
    operation: { path: 'main.tex', patches: [{ from: 0, to: 0, insert: '#\n' }, { from: 5, to: 5, insert: '#\n' }] },
    beforeContent: 'body\n', postContent: '#\nbody\n#\n', runProjectId: 'project-a'
  });
  assert.equal(result.capture.state, 'observed');
  assert.equal(result.trackedChanges.length, 2);
  assert.notEqual(result.trackedChanges[0].key, result.trackedChanges[1].key);
});

test('a native ledger from another document cannot fall back to ambiguous DOM evidence', () => {
  const f = nativeFixture('old', () => [node({ pos: 0 })]);
  f.setDocumentId('other-document');
  const baseline = f.api.prepareTrackedChangeCapture('main.tex');
  assert.equal(baseline.ready, false);
  assert.equal(baseline.source, 'native');
  assert.equal(baseline.reason, 'native_ledger_not_ready');
  assert.deepEqual(baseline.refs, []);
});

test('stale native insertion positions are rejected before attribution', () => {
  const f = nativeFixture('old');
  f.setChanges([{ id: 'stale', op: { p: 0, i: 'different' } }]);
  const baseline = f.api.prepareTrackedChangeCapture('main.tex');
  assert.equal(baseline.ready, false);
  assert.equal(baseline.reason, 'native_ledger_stale');
});

test('native capture remains bound to its source after serialization and delayed updates', async () => {
  const f = nativeFixture('old');
  const baseline = f.api.prepareTrackedChangeCapture('main.tex');
  f.setDocument('the');
  f.setChanges(time => time < 6000 ? [] : [{ id: 'late-native', op: { p: 0, i: 'the' } }]);
  const first = await f.api.captureTrackedWrite({
    trackedBefore: baseline.refs, captureBaseline: baseline, operation: f.operation,
    beforeContent: 'old', postContent: 'the', runProjectId: 'project-a'
  });
  assert.equal(first.capture.state, 'pending');
  f.setClock(6000);
  const result = await f.api.reconcileTrackedChangeCapture({
    runProjectId: 'project-a', capture: JSON.parse(JSON.stringify(first.capture)), expectedContent: 'the'
  });
  assert.equal(result.capture.source, 'native');
  assert.equal(result.capture.nativeDocId, 'doc-a');
  assert.equal(result.capture.state, 'observed');
});

test('native records disappearing during observation are not retained as stale ownership', async () => {
  const f = nativeFixture('old');
  const baseline = f.api.prepareTrackedChangeCapture('main.tex');
  f.setDocument('the');
  f.setChanges(time => time < 720 ? [{ id: 'removed', op: { p: 0, i: 'the' } }] : []);
  const result = await f.api.captureTrackedWrite({
    trackedBefore: baseline.refs, captureBaseline: baseline, operation: f.operation,
    beforeContent: 'old', postContent: 'the', runProjectId: 'project-a'
  });
  assert.equal(result.capture.state, 'pending');
  assert.deepEqual(result.trackedChanges, []);
});

test('unavailable native data at the end of observation cannot confirm earlier records', async () => {
  const f = nativeFixture('old');
  const baseline = f.api.prepareTrackedChangeCapture('main.tex');
  f.setDocument('the');
  f.setChanges([{ id: 'new', op: { p: 0, i: 'the' } }]);
  f.setDocumentId(time => time < 720 ? 'doc-a' : 'other-document');
  const result = await f.api.captureTrackedWrite({
    trackedBefore: baseline.refs, captureBaseline: baseline, operation: f.operation,
    beforeContent: 'old', postContent: 'the', runProjectId: 'project-a'
  });
  assert.equal(result.capture.state, 'pending');
  assert.deepEqual(result.trackedChanges, []);
});

test('legacy editors without the native schema preserve DOM fallback', () => {
  const h = harness(() => [node({ pos: 0 })], 0, {
    getCodeMirrorEditorView: () => ({ state: { doc: {} } }),
    getTrackedChangeDocumentId: () => 'doc-a'
  });
  const baseline = h.api.prepareTrackedChangeCapture('main.tex');
  assert.equal(baseline.source, 'dom');
  assert.equal(baseline.ready, true);
  assert.equal(baseline.refs.length, 1);
});

test('production writeback router carries full native references through the normal Track path', async t => {
  const WritebackRouter = require('../extension/src/page/writebackRouter');
  const StaleGuard = require('../extension/src/shared/staleGuard');
  const ProjectFiles = require('../extension/src/shared/projectFiles');
  const original = 'body\n', marker = '#\n', expected = marker + original + marker;
  let current = original, changes = [], clock = 0;
  t.mock.method(Date, 'now', () => clock);
  const router = WritebackRouter.create({
    window: { CodexOverleafStaleGuard: StaleGuard, CodexOverleafProjectFiles: ProjectFiles, setTimeout, clearTimeout },
    treeOperations: { getProjectId: () => 'project-a', getActiveFilePath: () => 'main.tex',
      projectPathExists: () => true, openFileByPath: async () => ({ ok: true, path: 'main.tex' }),
      waitForActiveEditorText: async () => ({ ok: true, path: 'main.tex', text: current }) },
    ensureReviewing: async () => ({ ok: true }),
    readActiveEditorText: () => current,
    getCodeMirrorEditorView: () => ({ state: {
      doc: { length: current.length, toString: () => current },
      values: [{ ranges: { docId: 'doc-a', changes, comments: [] }, threads: {} }]
    } }),
    getTrackedChangeDocumentId: () => 'doc-a',
    replaceActiveEditorPatches(_patches, next) {
      current = next;
      changes = [{ id: 'first', op: { p: 0, i: marker } }, { id: 'last', op: { p: 7, i: marker } }];
      return { ok: true };
    },
    collectElements: () => [node({ pos: 7, text: marker })],
    readNodeSignalText: n => n.textContent,
    compact: (value, limit) => String(value).slice(0, limit),
    delay: async ms => { clock += ms; }
  });
  const result = await router.applyOperations({
    runProjectId: 'project-a', requireReviewing: true,
    baseFiles: [{ path: 'main.tex', content: original }],
    operations: [{ type: 'edit', path: 'main.tex', patches: [
      { from: 0, to: 0, insert: marker }, { from: original.length, to: original.length, insert: marker }
    ] }]
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(current, expected);
  assert.equal(result.trackedChanges.length, 2);
  assert.equal(result.trackedChangeCaptures[0].source, 'native');
});
