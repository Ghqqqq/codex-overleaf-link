'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, sha } = require('./_helpers/fileMoveFixture');
for (const kind of ['text', 'binary']) {
  test(`historical ${kind} move restoration preserves entity identity, bytes, comments and review records`, async () => {
    const h = fixture({ kind, source: kind === 'text' ? 'old.tex' : 'old.png', target: kind === 'text' ? 'new.tex' : 'new.png' });
    const original = h.files.get(h.operation.path);
    const result = await h.move(); assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(h.files.has(h.operation.path), false); assert.equal(h.files.get(h.operation.to), original);
    assert.equal(result.moveProof.sourceEntityId, original.id); assert.equal(result.moveProof.targetEntityId, original.id);
    assert.equal(h.state.posts.length, 1); assert.equal(h.state.posts[0].action, 'rename');
    assert.equal(original.comments[0].id, 'comment-original'); assert.equal(original.reviewing[0].id, 'review-original');
  });
}
test('combined rename and folder move verifies each step and reports the final same entity', async () => {
  const h = fixture({ target: 'dest/new.tex' }); const result = await h.move();
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(h.files.has('old.tex'), false);
  assert.equal(h.files.get('dest/new.tex').id, 'entity-source');
  assert.deepEqual(h.state.posts.map(call => call.action), ['rename', 'move']);
});
test('refused second step compensates a verified first step without touching file bytes', async () => {
  const h = fixture({ target: 'dest/new.tex', failStep: 2 }); const before = h.files.get('old.tex');
  const result = await h.move(); assert.equal(result.ok, false); assert.equal(result.rolledBack, true, JSON.stringify(result));
  assert.equal(h.files.get('old.tex'), before); assert.deepEqual(h.state.posts.map(call => call.action), ['rename', 'move', 'rename']);
});
test('compensation stops when the original path is occupied by a collaborator', async () => {
  const h = fixture({ target: 'dest/new.tex', failStep: 2, onFailure(_state, files) {
    files.set('old.tex', { path: 'old.tex', id: 'collaborator', type: 'doc', bytes: Buffer.from('keep collaborator') });
  } });
  const result = await h.move(); assert.equal(result.ok, false); assert.equal(result.rolledBack, false);
  assert.equal(h.state.posts.length, 2); assert.equal(h.files.get('old.tex').id, 'collaborator');
  assert.equal(h.files.get('new.tex').id, 'entity-source'); assert.equal(result.moveRecovery.observedPath, 'new.tex');
});
for (const interference of ['hash', 'identity', 'destination', 'project', 'cancel']) {
  test('move rejects ' + interference + ' before any mutation', async () => {
    const h = fixture();
    if (interference === 'hash') h.files.get('old.tex').bytes = Buffer.from('changed');
    if (interference === 'identity') h.operation.moveProof.sourceEntityId = 'a-different-entity';
    if (interference === 'destination') h.files.set('new.tex', { path: 'new.tex', id: 'existing', type: 'doc', bytes: Buffer.from('keep') });
    if (interference === 'project') h.state.projectId = 'other-project';
    if (interference === 'cancel') h.state.current = false;
    const result = await h.move(); assert.equal(result.ok, false); assert.equal(h.state.posts.length, 0);
    assert.equal(h.files.has('old.tex'), true);
  });
}
test('unknown network outcome is not automatically replayed or compensated', async () => {
  const h = fixture({ target: 'dest/new.tex', unknownStep: 1 });
  const result = await h.move(); assert.equal(result.ok, false); assert.equal(h.state.posts.length, 1);
  assert.equal(result.receiptUnconfirmed, true); assert.equal(h.files.has('old.tex'), true);
});
test('a server error is an unknown outcome and cannot authorize compensating an earlier step', async () => {
  const h = fixture({ target: 'dest/new.tex', failStep: 2, failStatus: 500 });
  const result = await h.move(); assert.equal(result.ok, false); assert.equal(h.state.posts.length, 2);
  assert.equal(result.rolledBack, false); assert.equal(result.receiptUnconfirmed, true);
  assert.equal(h.files.get('new.tex').id, 'entity-source');
});
test('a lost response can be settled by exact same-entity path and byte readback', async () => {
  const h = fixture({ loseResponseAt: 1 }); const result = await h.move();
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(h.state.posts.length, 1);
});
test('cancel after a confirmed mutation retains precise recovery metadata and stops later requests', async () => {
  const h = fixture({ target: 'dest/new.tex', afterPost(state) { state.current = false; } });
  const result = await h.move(); assert.equal(result.ok, false); assert.equal(h.state.posts.length, 1);
  assert.equal(h.files.get('new.tex').id, 'entity-source'); assert.equal(result.moveRecovery.entityId, 'entity-source');
});
test('inverse move uses the original entity proof and preserves a later replacement', async () => {
  const h = fixture(); const moved = await h.move(); assert.equal(moved.ok, true);
  const inverse = { type: 'move', path: 'new.tex', to: 'old.tex', moveProof: {
    ...moved.moveProof, sourceEntityId: moved.moveProof.targetEntityId
  } };
  h.files.get('new.tex').id = 'replacement';
  const undone = await h.move(inverse); assert.equal(undone.ok, false); assert.equal(h.state.posts.length, 1);
});
test('occupied intermediate basenames use a unique temporary name without replacing either neighbor', async () => {
  const h = fixture({ target: 'dest/new.tex' });
  for (const path of ['new.tex', 'dest/old.tex']) h.files.set(path, { path, id: 'neighbor-' + path, type: 'doc', bytes: Buffer.from('neighbor') });
  const result = await h.move(); assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.files.get('dest/new.tex').id, 'entity-source');
  assert.equal(h.files.get('new.tex').id, 'neighbor-new.tex'); assert.equal(h.files.get('dest/old.tex').id, 'neighbor-dest/old.tex');
  assert.equal(h.state.posts.length, 3); assert.equal([...h.files.keys()].some(path => path.includes('codex-move-')), false);
});
for (const reason of ['zip_path_invalid', 'zip_path_duplicate']) {
  test('an incomplete ZIP path identity manifest cannot authorize a move: ' + reason, async () => {
    const h = fixture({ transformSnapshot: value => ({ ...value, pathIdentityComplete: false,
      capabilities: undefined, skipped: [{ path: 'ambiguous-entry', reason }] }) });
    const result = await h.move(); assert.equal(result.ok, false); assert.equal(h.state.posts.length, 0);
    assert.equal(h.files.get('old.tex').id, 'entity-source');
  });
}
test('source entity type cannot change between baseline capture and mutation', async () => {
  const h = fixture({ beforeSnapshot(state, files) { if (state.snapshots === 3) files.get('old.tex').type = 'file'; } });
  const result = await h.move(); assert.equal(result.ok, false); assert.equal(h.state.posts.length, 0);
  assert.equal(result.code, 'file_move_identity_changed');
});
test('JSON-encoded CSRF metadata follows the native frontend parsing contract', async () => {
  const h = fixture({ csrfMeta: { content: '"fixture-csrf"', dataset: { type: 'json' } } });
  const result = await h.move(); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(h.state.posts.length, 1);
});
for (const meta of [{ content: '7', dataset: { type: 'number' } }, { content: '{bad json', dataset: { type: 'json' } },
  { content: 'fixture-csrf', dataset: { type: 'boolean' } }]) {
  test('invalid/non-string CSRF metadata cannot begin a mutation: ' + meta.dataset.type, async () => {
    const h = fixture({ csrfMeta: meta }); const result = await h.move();
    assert.equal(result.ok, false); assert.equal(h.state.posts.length, 0); assert.equal(result.code, 'file_move_identity_unavailable');
  });
}
for (const phase of ['source', 'destination']) {
  test('folder preparation shares the move deadline before any controls can mutate: ' + phase, async t => {
    let clock = 1000, controlMutations = 0;
    t.mock.method(Date, 'now', () => clock);
    const h = fixture({ source: phase === 'source' ? 'source/old.tex' : 'old.tex', target: 'missing/new.tex', deadlineAt: 1001,
      async prepareUploadParent(_folder, options) {
        clock = 1002;
        if (options.isCurrent()) controlMutations++;
      } });
    const result = await h.move();
    assert.equal(result.ok, false); assert.equal(result.code, 'file_move_deadline_exceeded');
    assert.equal(controlMutations, 0); assert.equal(h.state.posts.length, 0); assert.equal(h.files.has(h.operation.path), true);
  });
}

test('metadata consumer rejects forward dispatch and unproved recovery before any I/O', async () => {
  const h = fixture();
  const blocked = await h.mover.moveFile(h.operation, { runProjectId: h.state.projectId });
  assert.equal(blocked.ok, false); assert.equal(blocked.code, 'file_tree_controls_unavailable');
  for (const moveProof of [{ v: 1, kind: 'text', sha256: sha('original contents\n') },
    { ...h.operation.moveProof, sourceEntityId: 'other' }, { ...h.operation.moveProof, targetEntityId: '' }]) {
    const result = await h.move({ ...h.operation, moveProof });
    assert.equal(result.ok, false); assert.equal(result.changedDocument, false);
  }
  assert.equal(h.state.posts.length, 0); assert.equal(h.state.snapshots, 0);
});
