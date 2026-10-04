'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture } = require('./_helpers/createdDirectoryFixture');
const proof = { v: 1, projectId: 'example', path: 'qa', nativeFolderId: 'created-qa', ownershipConfirmed: false, observedAfterCreate: true };
const gaps = [
  ['raw flag', { pathIdentityComplete: false }],
  ['capability flag', { capabilities: { pathIdentityComplete: false } }],
  ['raw unknown path', { skipped: [{ path: '', unknownPath: true, reason: 'unreadable_name' }] }],
  ['capability unknown path', { capabilities: { skipped: [{ path: '', unknownPath: true }] } }],
  ['raw invalid path', { skipped: [{ path: 'unresolved', reason: 'zip_path_invalid' }] }],
  ['capability invalid path', { capabilities: { skipped: [{ path: 'unresolved', reason: 'zip_path_invalid' }] } }],
  ['raw duplicate path', { skipped: [{ path: 'duplicate.tex', reason: 'zip_path_duplicate' }] }],
  ['capability duplicate path', { capabilities: { skipped: [{ path: 'duplicate.tex', reason: 'zip_path_duplicate' }] } }]
];
for (const [label, snapshotMetadata] of gaps) {
  test('text creation refuses an incomplete ZIP identity list before mutation: ' + label, async () => {
    const f = fixture({ snapshotMetadata });
    const result = await f.create('new.tex');
    assert.equal(result.ok, false); assert.equal(result.changedDocument, false);
    assert.equal(f.files.has('new.tex'), false); assert.deepEqual(f.created, []);
    assert.equal(result.code, 'source_zip_unavailable');
  });
  test('file deletion refuses an incomplete ZIP identity list before mutation: ' + label, async () => {
    const f = fixture({ files: { 'leaf.tex': 'generated' }, snapshotMetadata });
    const result = await f.undo('leaf.tex', []);
    assert.equal(result.ok, false); assert.equal(result.changedDocument, false);
    assert.equal(f.files.get('leaf.tex'), 'generated'); assert.deepEqual(f.removed, []);
    assert.equal(result.code, 'source_zip_unavailable');
  });
  test('missing directory plus incomplete ZIP cannot become an absence receipt: ' + label, async () => {
    const f = fixture({ snapshotMetadata });
    const result = await f.cleanup([proof]);
    assert.equal(result.ok, false); assert.deepEqual(result.remaining, [proof]);
    assert.deepEqual(result.removed, []); assert.deepEqual(f.removed, []);
  });
}
for (const reason of ['binary_file_too_large', 'binary_project_too_large']) {
  test('known unrelated binary quota skip preserves ordinary text create/delete and directory checks: ' + reason, async () => {
    const snapshotMetadata = { pathIdentityComplete: true, skipped: [{ path: 'elsewhere/large.png', reason }] };
    const f = fixture({ snapshotMetadata });
    assert.equal((await f.create('new.tex')).ok, true);
    assert.equal((await f.undo('new.tex', [])).ok, true);
    const result = await f.cleanup([proof]);
    assert.equal(result.ok, true); assert.equal(result.removed[0].alreadyAbsent, true);
    assert.deepEqual(f.removed, ['new.tex']);
  });
  test('known quota skip inside missing directory keeps that directory unresolved: ' + reason, async () => {
    const f = fixture({ snapshotMetadata: { pathIdentityComplete: true, skipped: [{ path: 'qa/large.png', reason }] } });
    const result = await f.cleanup([proof]);
    assert.equal(result.ok, false); assert.deepEqual(result.remaining, [proof]); assert.deepEqual(f.removed, []);
  });
}
