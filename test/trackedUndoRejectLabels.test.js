'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractFunction } = require('./_helpers/extractFunction');
const { createReviewFixture } = require('./_helpers/nativeReviewHarness');
const pageSource = fs.readFileSync(path.join(__dirname, '../extension/src/pageBridge.js'), 'utf8');
const lifecycleSource = fs.readFileSync(path.join(__dirname, '../extension/src/page/trackedChangesLifecycle.js'), 'utf8');
const signalContext = vm.createContext({});
for (const name of ['readNodeSignalText', 'normalizeReviewingSignalText']) vm.runInContext(extractFunction(pageSource, name), signalContext);
vm.runInContext(extractFunction(lifecycleSource, 'isRejectTrackedChangeControl'), signalContext);

// Exact public DOM shape observed in real Chrome on 2026-10-05:
// <button class="btn"><span class="material-symbols ..." aria-hidden="true">close</span>
// <span class="visually-hidden">Reject change</span></button>
// Both innerText and textContent were "closeReject change", without a separator.
function actionButton(action, extras = {}) {
  const hiddenLabels = extras.labels || [action + ' change'];
  const text = (action === 'Reject' ? 'close' : 'check') + hiddenLabels.join('');
  return { tagName: 'BUTTON', className: 'btn', innerText: text, textContent: text,
    disabled: extras.disabled === true,
    getAttribute: name => name === 'aria-disabled' ? extras.ariaDisabled || null : null,
    querySelectorAll: selector => selector === '.visually-hidden' ? hiddenLabels.map(textContent => ({ textContent })) : [] };
}

test('actual icon plus visually-hidden Reject label is recognized despite glued rendered text', () => {
  const reject = actionButton('Reject'), accept = actionButton('Accept');
  assert.equal(signalContext.readNodeSignalText(reject), 'closeReject change closeReject change btn');
  assert.equal(signalContext.readNodeSignalText(accept), 'checkAccept change checkAccept change btn');
  assert.equal(signalContext.isRejectTrackedChangeControl(reject), true);
  assert.equal(signalContext.isRejectTrackedChangeControl(accept), false);
});

test('Chinese native Review labels keep Reject actionable and Accept excluded', () => {
  assert.equal(signalContext.isRejectTrackedChangeControl(actionButton('Reject', { labels: ['拒绝更改'] })), true);
  assert.equal(signalContext.isRejectTrackedChangeControl(actionButton('Accept', { labels: ['接受更改'] })), false);
  assert.equal(signalContext.isRejectTrackedChangeControl(actionButton('Reject', { labels: ['Reject change', '接受更改'] })), false);
});

test('hidden labels do not enable disabled, aria-disabled or ambiguous Accept/Reject controls', () => {
  for (const extras of [{ disabled: true }, { ariaDisabled: 'true' }, { labels: ['Accept change', 'Reject change'] }])
    assert.equal(signalContext.isRejectTrackedChangeControl(actionButton('Reject', extras)), false);
});

function reviewCard(file, options = {}) {
  const accept = actionButton('Accept'), reject = actionButton('Reject', options);
  const body = { textContent: file.changes[0]?.op.i || '' };
  const card = { className: 'review-panel-entry review-panel-entry-change review-panel-entry-insert',
    textContent: 'editusercheckAccept changecloseReject changeAdded:' + body.textContent,
    getAttribute: name => name === 'data-pos' ? String(file.before.length) : null,
    querySelector: selector => selector === '.review-panel-change-body' ? body : null,
    querySelectorAll: selector => selector === '.review-panel-expandable-content' ? [body]
      : selector === '.visually-hidden' ? [{ textContent: 'Accept change' }, { textContent: 'Reject change' }]
      : /button/.test(selector) ? [accept, reject] : [] };
  const inline = { className: 'ol-cm-change ol-cm-change-i', textContent: body.textContent,
    getAttribute: () => null, querySelectorAll: () => [], querySelector: () => null };
  return { nodes: [inline, card], accept, reject };
}

for (const { priorNativeUndo, unowned } of [{ priorNativeUndo: false }, { priorNativeUndo: true }, { priorNativeUndo: true, unowned: true }]) test('production Page RPC resolves real Review labels across two files: ' + (unowned ? 'unowned native change blocks all controls' : priorNativeUndo ? 'partial native Undo fallback' : 'retained refs and preimages'), async t => {
  const files = ['main.tex', 'nested/part.tex'].map((path, i) => {
    const before = `% baseline ${i}\n`, marker = `% marker ${i}\n`;
    return { path, before, content: before + marker, changes: [{ id: 'owned-' + i, op: { p: before.length, i: marker } }] };
  });
  const cards = new Map(files.map(file => [file.path, reviewCard(file)])), rejects = [];
  const h = createReviewFixture(t, { files, editorUndoPaths: priorNativeUndo ? ['main.tex'] : [],
    readNodeSignalText: signalContext.readNodeSignalText,
    collectReviewNodes({ selector, state, docs }) {
      if (!selector.includes('[data-change-id]')) return null;
      return docs.get(state.active).changes.length ? cards.get(state.active).nodes : [];
    },
    clickReviewNode({ node, state, docs }) {
      assert.equal(node, cards.get(state.active).reject, 'must click the scoped Reject, never Accept');
      rejects.push(state.active);
      docs.get(state.active).content = docs.get(state.active).before;
      docs.get(state.active).changes = [];
    }
  });
  t.after(() => h.close());
  const refs = [];
  for (const file of files) { h.state.active = file.path; refs.push(...h.capture.prepareTrackedChangeCapture(file.path).refs); }
  h.state.active = files[0].path;
  if (unowned) h.docs.get(files[0].path).changes.push({ id: 'collaborator', op: { p: 0, i: files[0].before } });
  await h.ready();
  const result = await h.timer.settle(h.rpc('rejectTrackedChanges', { runProjectId: 'project-one', trackedChanges: refs,
    expectedFiles: files.map(file => ({ path: file.path, content: file.before })),
    // Retained refs/preimages need no guessed native history; the existing DOM
    // route also handles the tail after the first native file Undo succeeded.
    postFiles: priorNativeUndo ? files.map(file => ({ path: file.path, content: file.content })) : [] }));
  if (unowned) {
    assert.equal(result.ok, false);
    assert.equal(result.skipped[0].result.code, 'native_reject_mixed_changes');
    assert.deepEqual(rejects, []);
    assert.equal(h.state.editorUndos?.length || 0, 0);
    assert.equal(h.state.writes.length, 0);
    assert.ok(files.every(file => h.docs.get(file.path).content === file.content));
    return;
  }
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(rejects, priorNativeUndo ? ['nested/part.tex'] : files.map(file => file.path));
  assert.equal(result.applied.length, 2);
  assert.ok(files.every(file => h.docs.get(file.path).content === file.before && h.docs.get(file.path).changes.length === 0));
  assert.equal(h.state.writes.length, 0, 'native Review performs the rejection without text fallback');
  assert.equal(result.saveVerification.ok, true);
});

const { createPersistenceFixture } = require('./_helpers/undoPersistenceHarness');
for (const fault of ['', 'empty preimage', 'missing proof', 'wrong proof', 'wrong method', 'wrong key', 'wrong readback']) test('Controller → Page DOM reject → durable Undo settlement: ' + (fault || 'exact verified receipt'), async t => {
  const files = ['main.tex', 'nested/part.tex'].map((path, i) => {
    const before = fault === 'empty preimage' ? '' : `% baseline ${i}\n`, marker = `% current marker ${i}\n`;
    return { path, before, content: before + marker,
      changes: [{ id: 'owned-' + i, op: { p: before.length, i: marker } }] };
  });
  const cards = new Map(files.map(file => [file.path, reviewCard(file)]));
  const page = createReviewFixture(t, { files, editorUndoPaths: ['main.tex'],
    readNodeSignalText: signalContext.readNodeSignalText,
    collectReviewNodes({ selector, state, docs }) {
      return selector.includes('[data-change-id]') ? docs.get(state.active).changes.length ? cards.get(state.active).nodes : [] : null;
    },
    clickReviewNode({ node, state, docs }) {
      assert.equal(node, cards.get(state.active).reject);
      const file = docs.get(state.active);
      file.content = file.before + (fault === 'wrong readback' ? '% unexpected retained content\n' : '');
      file.changes = [];
    }
  });
  page.state.projectId = 'qa-project'; page.window.location.pathname = '/project/qa-project';
  const content = await createPersistenceFixture({ track: true,
    files: files.map(file => ({ path: file.path, content: file.before })),
    operations: files.map(file => ({ type: 'edit', path: file.path, replaceAll: file.content, verifiedContent: file.content })),
    createRouter: () => page.router });
  t.after(() => { content.close(); page.close(); });
  content.run.undoTrackedChanges = files.flatMap(file => { page.state.active = file.path;
    return page.capture.prepareTrackedChangeCapture(file.path).refs; });
  page.state.active = files[0].path;
  await content.context.flushQueuedSaveState({ requireDurable: true });
  const replies = [];
  content.context.callPageBridge = async (method, params) => {
    assert.equal(params.postFiles.length, 2, 'real Controller must send both derived postimages');
    const result = await page.rpc(method, params);
    const domEntry = result.applied.find(entry => entry.result.method === 'overleaf-review-reject-sweep');
    assert.ok(domEntry, 'must reach the production native Review fallback');
    if (fault === 'missing proof') delete domEntry.result.verified;
    if (fault === 'wrong proof') domEntry.result.verifiedContent = 'wrong content';
    if (fault === 'wrong method') domEntry.result.method = 'unrelated-operation';
    if (fault === 'wrong key') domEntry.trackedChange.key = 'unknown-proof';
    replies.push(result); return result;
  };
  await page.ready(); await page.timer.settle(content.undo());
  const loaded = await content.load();
  assert.equal(page.state.writes.length, 0);
  assert.equal(page.docs.get(files[0].path).content, files[0].before);
  if (!fault || fault === 'empty preimage') {
    assert.equal(content.run.trackedChangeStatus, 'rejected', JSON.stringify(replies[0]));
    assert.equal(loaded.run.trackedChangeStatus, 'rejected');
    assert.equal(loaded.buttons.undo.disabled, true);
    assert.equal(loaded.run.undoTrackedChanges.length, 0);
    assert.equal(loaded.run.undoExpectedFiles.length, 0);
    assert.equal(page.docs.get(files[1].path).content, files[1].before);
  } else {
    assert.notEqual(loaded.run.trackedChangeStatus, 'rejected');
    assert.equal(loaded.buttons.undo.disabled, false);
    assert.ok(loaded.run.undoExpectedFiles.some(file => file.path === files[1].path));
    assert.ok(loaded.run.undoTrackedChanges.some(ref => ref.path === files[1].path));
    if (fault === 'wrong readback') {
      assert.equal(replies[0].skipped[0].result.code, 'tracked_change_undo_verify_failed');
      assert.deepEqual(loaded.run.undoExpectedFiles.map(file => file.path), [files[1].path]);
      assert.deepEqual(loaded.run.undoTrackedChanges.map(ref => ref.path), [files[1].path]);
    }
  }
});
