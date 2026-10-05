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
  const body = { textContent: file.changes[0]?.op.i ?? file.changes[0]?.op.d ?? '' };
  const deletion = typeof file.changes[0]?.op.d === 'string';
  const card = { className: 'review-panel-entry review-panel-entry-change review-panel-entry-' + (deletion ? 'delete' : 'insert'),
    textContent: 'editusercheckAccept changecloseReject changeAdded:' + body.textContent,
    getAttribute: name => name === 'data-pos' ? String(file.changes[0]?.op.p ?? file.before.length) : null,
    querySelector: selector => selector === '.review-panel-change-body' ? body : null,
    querySelectorAll: selector => selector === '.review-panel-expandable-content' ? [body]
      : selector === '.visually-hidden' ? [{ textContent: 'Accept change' }, { textContent: 'Reject change' }]
      : /button/.test(selector) ? [accept, reject] : [] };
  const inline = { className: 'ol-cm-change ol-cm-change-' + (deletion ? 'd' : 'i'), textContent: body.textContent,
    getAttribute: () => null, querySelectorAll: () => [], querySelector: () => null };
  return { nodes: [inline, card], accept, reject };
}

for (const { priorNativeUndo, unowned, noPreimage } of [{ priorNativeUndo: false }, { priorNativeUndo: true }, { priorNativeUndo: true, unowned: true }, { priorNativeUndo: false, noPreimage: true }]) test('production Page RPC resolves real Review labels across two files: ' + (noPreimage ? 'refs-only stale card cannot authorize a repeat Reject' : unowned ? 'unowned native change blocks all controls' : priorNativeUndo ? 'partial native Undo fallback' : 'retained refs and preimages'), async t => {
  const files = ['main.tex', 'nested/part.tex'].map((path, i) => {
    const before = `% baseline ${i}\n`, marker = `% marker ${i}\n`;
    return { path, before, content: before + marker, changes: [{ id: 'owned-' + i, op: { p: before.length, i: marker } }] };
  });
  const cards = new Map(files.map(file => [file.path, reviewCard(file)])), rejects = [], visibleUntil = new Map();
  const h = createReviewFixture(t, { files, editorUndoPaths: priorNativeUndo ? ['main.tex'] : [],
    readNodeSignalText: signalContext.readNodeSignalText,
    collectReviewNodes({ selector, state, docs, timer }) {
      if (!selector.includes('[data-change-id]')) return null;
      return docs.get(state.active).changes.length || timer.now < (visibleUntil.get(state.active) || 0) ? cards.get(state.active).nodes : [];
    },
    clickReviewNode({ node, state, docs }) {
      assert.equal(node, cards.get(state.active).reject, 'must click the scoped Reject, never Accept');
      rejects.push(state.active);
      docs.get(state.active).content = docs.get(state.active).before;
      docs.get(state.active).changes = [];
      if (noPreimage) visibleUntil.set(state.active, h.timer.now + 180);
    }
  });
  t.after(() => h.close());
  const refs = [];
  for (const file of files) { h.state.active = file.path; refs.push(...h.capture.prepareTrackedChangeCapture(file.path).refs); }
  h.state.active = files[0].path;
  if (unowned) h.docs.get(files[0].path).changes.push({ id: 'collaborator', op: { p: 0, i: files[0].before } });
  await h.ready();
  const result = await h.timer.settle(h.rpc('rejectTrackedChanges', { runProjectId: 'project-one', trackedChanges: refs,
    expectedFiles: noPreimage ? [] : files.map(file => ({ path: file.path, content: file.before })),
    // Retained refs/preimages need no guessed native history; the existing DOM
    // route also handles the tail after the first native file Undo succeeded.
    postFiles: priorNativeUndo ? files.map(file => ({ path: file.path, content: file.content })) : [] }));
  if (noPreimage) {
    assert.equal(result.ok, false);
    assert.equal(result.skipped[0].result.code, 'native_review_scope_changed');
    assert.deepEqual(rejects, [files[0].path]);
    assert.equal(h.docs.get(files[1].path).content, files[1].content);
    assert.equal(h.state.writes.length, 0);
    return;
  }
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
for (const fault of ['', 'empty preimage', 'delayed card', 'stale card', 'async navigation', 'lagged ledger', 'lagged card', 'missing proof', 'wrong proof', 'wrong method', 'wrong key', 'wrong readback']) test('Controller → Page DOM reject → durable Undo settlement: ' + (fault || 'exact verified receipt'), async t => {
  const files = ['main.tex', 'nested/part.tex'].map((path, i) => {
    const before = fault === 'empty preimage' ? '' : `% baseline ${i}\n`, marker = `% current marker ${i}\n`;
    return { path, before, content: before + marker,
      changes: [{ id: 'owned-' + i, op: { p: before.length, i: marker } }] };
  });
  const cards = new Map(files.map(file => [file.path, reviewCard(file)])), readyAt = new Map(), cardUntil = new Map();
  let rejectClicks = 0;
  let collector;
  const page = createReviewFixture(t, { files, editorUndoPaths: ['main.tex'],
    ...(fault === 'async navigation' ? { navigationDelays: { text: 450, ledger: 750 } } : {}),
    readNodeSignalText: signalContext.readNodeSignalText,
    onOpen({ path }) { readyAt.set(path, page.timer.now + 180); },
    collectReviewNodes({ selector, state, docs }) {
      if (['delayed card', 'stale card'].includes(fault) && selector.includes('[data-change-id]')) return collector.collectElements(selector, 1200);
      return selector.includes('[data-change-id]') ? docs.get(state.active).changes.length || page.timer.now < (cardUntil.get(state.active) || 0) ? cards.get(state.active).nodes : [] : null;
    },
    clickReviewNode({ node, state, docs }) {
      assert.equal(node, cards.get(state.active).reject);
      rejectClicks++;
      const file = docs.get(state.active);
      file.content = file.before + (fault === 'wrong readback' ? '% unexpected retained content\n' : '');
      if (fault === 'lagged ledger') page.timer.setTimeout(() => { file.changes = []; }, 180);
      else file.changes = [];
      if (fault === 'lagged card') cardUntil.set(state.active, page.timer.now + 180);
    }
  });
  if (['delayed card', 'stale card'].includes(fault)) {
    page.window.document.querySelectorAll = selector => {
      if (selector !== '*' && !selector.includes('[data-change-id]')) return [];
      if (!page.docs.get(page.state.active).changes.length) return [];
      const nodes = cards.get(page.state.active).nodes;
      return page.timer.now < (readyAt.get(page.state.active) || 0)
        ? fault === 'stale card' ? [nodes[0], cards.get(files[0].path).nodes[1]] : [nodes[0]] : nodes;
    };
    collector = vm.createContext({ document: page.window.document });
    for (const name of ['collectSearchRoots', 'collectElements']) vm.runInContext(extractFunction(pageSource, name), collector);
  }
  page.state.projectId = 'qa-project'; page.window.location.pathname = '/project/qa-project';
  const content = await createPersistenceFixture({ track: true,
    files: files.map(file => ({ path: file.path, content: file.before })),
    operations: files.map(file => ({ type: 'edit', path: file.path, replaceAll: file.content, verifiedContent: file.content })),
    createRouter: () => page.router });
  t.after(() => { content.close(); page.close(); });
  content.run.undoTrackedChanges = files.flatMap(file => { page.state.active = file.path;
    if (fault === 'async navigation') page.state.editorActive = page.state.ledgerActive = file.path;
    return page.capture.prepareTrackedChangeCapture(file.path).refs; });
  page.state.active = files[0].path;
  if (fault === 'async navigation') page.state.editorActive = page.state.ledgerActive = files[0].path;
  await content.context.flushQueuedSaveState({ requireDurable: true });
  const replies = [];
  content.context.callPageBridge = async (method, params) => {
    assert.equal(params.postFiles.length, 2, 'real Controller must send both derived postimages');
    const result = await page.rpc(method, params);
    const domEntry = result.applied.find(entry => entry.result.method === 'overleaf-review-reject-sweep');
    assert.ok(domEntry, 'must reach the production native Review fallback: ' + JSON.stringify({ result, opens: page.state.opens, now: page.timer.now, reads: page.state.reads.slice(-5) }));
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
  if (!fault || ['empty preimage', 'delayed card', 'stale card', 'async navigation', 'lagged ledger', 'lagged card'].includes(fault)) {
    assert.equal(content.run.trackedChangeStatus, 'rejected', JSON.stringify(replies[0]));
    assert.equal(loaded.run.trackedChangeStatus, 'rejected');
    assert.equal(loaded.buttons.undo.disabled, true);
    assert.equal(loaded.run.undoTrackedChanges.length, 0);
    assert.equal(loaded.run.undoExpectedFiles.length, 0);
    assert.equal(page.docs.get(files[1].path).content, files[1].before);
    assert.equal(rejectClicks, 1, 'readback completion must not repeat Reject on a stale card');
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

for (const scenario of ['card-before-inline', 'delayed-card', 'stale-card', 'permanent-old-card', 'ambiguous-old-card', 'identical-new-card', 'permanent-inline', 'detached-control', 'cancel', 'deadline', 'path-drift', 'text-drift', 'ledger-drift', 'document-drift']) test('production DOM collector resolves Review controls with ' + scenario, async t => {
  const files = ['main.tex', 'nested/part.tex'].map((path, i) => {
    const same = ['ambiguous-old-card', 'identical-new-card'].includes(scenario);
    const before = same ? '% baseline\n' : `% baseline ${i}\n`, marker = same ? '% current marker\n' : `% current marker ${i}\n`;
    return { path, before, content: before + marker,
      changes: [{ id: 'owned-' + i, op: { p: before.length, i: marker } }] };
  });
  const cards = new Map(files.map(file => [file.path, reviewCard(file)]));
  const cardReady = new Map(), rejects = [];
  let collector, h, queries = 0, waiting = false;
  h = createReviewFixture(t, { files, editorUndoPaths: ['main.tex'],
    readNodeSignalText: signalContext.readNodeSignalText,
    onOpen({ path }) { cardReady.set(path, h.timer.now + 180); queries = 0; },
    collectReviewNodes({ selector, state }) {
      if (selector.includes('[data-change-id]') && state.active === 'nested/part.tex' && ++queries >= 2
        && state.opens.filter(open => open.path === state.active).length >= 4) waiting = true;
      return selector.includes('[data-change-id]') ? collector.collectElements(selector, 1200) : null;
    },
    clickReviewNode({ node, state, docs }) {
      assert.equal(node, cards.get(state.active).reject);
      rejects.push(state.active);
      docs.get(state.active).content = docs.get(state.active).before;
      docs.get(state.active).changes = [];
    }
  });
  t.after(() => h.close());
  h.window.document.querySelectorAll = selector => {
    if (selector !== '*' && !selector.includes('[data-change-id]')) return [];
    if (!h.docs.get(h.state.active).changes.length) return [];
    const [inline, card] = cards.get(h.state.active).nodes;
    if (scenario === 'detached-control') cards.get(h.state.active).reject.isConnected = false;
    if (['permanent-old-card', 'ambiguous-old-card'].includes(scenario) || (['stale-card', 'identical-new-card'].includes(scenario) && h.timer.now < (cardReady.get(h.state.active) || 0))) return [inline, cards.get(files[0].path).nodes[1]];
    return scenario === 'permanent-inline' ? [inline] : scenario === 'card-before-inline' ? [card, inline]
      : h.timer.now >= (cardReady.get(h.state.active) || 0) ? [inline, card] : [inline];
  };
  collector = vm.createContext({ document: h.window.document });
  for (const name of ['collectSearchRoots', 'collectElements']) vm.runInContext(extractFunction(pageSource, name), collector);
  const refs = [];
  for (const file of files) { h.state.active = file.path; refs.push(...h.capture.prepareTrackedChangeCapture(file.path).refs); }
  h.state.active = files[0].path;
  await h.ready();
  const pending = h.rpc('rejectTrackedChanges', { runProjectId: 'project-one', trackedChanges: refs,
    ...(scenario === 'deadline' ? { deadlineAt: h.timer.now + 3370 } : {}),
    expectedFiles: files.map(file => ({ path: file.path, content: file.before })),
    postFiles: files.map(file => ({ path: file.path, content: file.content })) });
  if (scenario === 'cancel' || scenario.endsWith('-drift')) {
    await h.timer.until(() => waiting);
    if (scenario === 'cancel') await h.timer.settle(h.rpc('cancelActiveWrite', {}));
    if (scenario === 'path-drift') h.state.active = files[0].path;
    if (scenario === 'text-drift') h.docs.get(files[1].path).content += '% human edit\n';
    if (scenario === 'document-drift') h.docs.get(files[1].path).id = 'replacement-document';
    if (scenario === 'ledger-drift') h.docs.get(files[1].path).changes.push({ id: 'collaborator', op: { p: 0, i: files[1].before } });
  }
  const result = await h.timer.settle(pending);
  if (!['card-before-inline', 'delayed-card', 'stale-card', 'identical-new-card'].includes(scenario)) {
    assert.equal(result.ok, false);
    assert.deepEqual(rejects, []);
    assert.equal(h.state.writes.length, 0);
    assert.equal(h.docs.get(files[0].path).content, files[0].before);
    const code = result.skipped[0].result.code;
    assert.equal(code, scenario === 'cancel' ? 'codex_cancelled' : scenario === 'deadline' ? 'writeback_deadline_exceeded' : scenario.endsWith('-drift') ? 'native_review_scope_changed' : 'tracked_change_reject_control_not_found');
    const count = rejects.length; await h.timer.settle(h.timer.sleep(3000));
    assert.equal(rejects.length, count);
    return;
  }
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(rejects, ['nested/part.tex']);
  assert.equal(result.applied.length, 2);
  assert.ok(files.every(file => h.docs.get(file.path).content === file.before));
  assert.equal(h.state.writes.length, 0);
});

for (const kind of ['deletion', 'multiple insertions']) test('native Review card ownership handles ' + kind, async t => {
  const file = kind === 'deletion'
    ? { path: 'main.tex', before: 'abcDEFghi', content: 'abcghi', changes: [{ id: 'deleted', op: { p: 3, d: 'DEF' } }] }
    : { path: 'main.tex', before: 'abc', content: 'aXXbYYc', changes: [{ id: 'first', op: { p: 1, i: 'XX' } }, { id: 'second', op: { p: 4, i: 'YY' } }] };
  const cards = new Map(file.changes.map(change => [change.id, reviewCard({ ...file, changes: [change] })])), clicked = [];
  const h = createReviewFixture(t, { files: [file], readNodeSignalText: signalContext.readNodeSignalText,
    collectReviewNodes({ selector, state, docs }) {
      return selector.includes('[data-change-id]') ? docs.get(state.active).changes.flatMap(change => cards.get(change.id).nodes) : null;
    },
    clickReviewNode({ node, state, docs }) {
      const doc = docs.get(state.active), change = doc.changes.find(change => cards.get(change.id).reject === node);
      assert.ok(change, 'only an owned native card may be rejected'); clicked.push(change.id);
      const op = change.op;
      if (typeof op.i === 'string') {
        assert.equal(doc.content.slice(op.p, op.p + op.i.length), op.i);
        doc.content = doc.content.slice(0, op.p) + doc.content.slice(op.p + op.i.length);
      } else doc.content = doc.content.slice(0, op.p) + op.d + doc.content.slice(op.p);
      doc.changes = doc.changes.filter(other => other !== change);
    }
  });
  t.after(() => h.close()); await h.ready();
  const result = await h.timer.settle(h.rpc('rejectTrackedChanges', { runProjectId: 'project-one',
    trackedChanges: h.capture.prepareTrackedChangeCapture(file.path).refs,
    expectedFiles: [{ path: file.path, content: file.before }], postFiles: [] }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.docs.get(file.path).content, file.before);
  assert.deepEqual(clicked, kind === 'deletion' ? ['deleted'] : ['second', 'first']);
  assert.ok(result.applied.every(entry => entry.result.verified === true && entry.result.verifiedContent === file.before));
  assert.equal(h.state.writes.length, 0);
});

test('configured native adapter with unavailable state never falls back to legacy DOM permission', () => {
  const Capture = require('../extension/src/page/trackedChangeCapture');
  const candidate = reviewCard({ path: 'main.tex', before: 'a', changes: [{ op: { p: 1, i: 'X' } }] }).nodes[1];
  const native = Capture.create({ getCodeMirrorEditorView: () => null, getTrackedChangeDocumentId: () => 'doc-a' });
  const legacy = Capture.create({});
  assert.equal(native.isTrackedChangeNodeInNativeScope(candidate, 'main.tex'), false);
  assert.equal(legacy.isTrackedChangeNodeInNativeScope(candidate, 'main.tex'), true);
});
