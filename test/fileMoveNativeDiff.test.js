'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Mirror = require('../native-host/src/mirrorWorkspace');
const Assets = require('../native-host/src/nativeAssetTransfer');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
async function setup(t, files) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'col-move-diff-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  await Mirror.syncOverleafToMirror({ projectId: 'move-test', rootDir,
    project: { id: 'move-test', files, capabilities: { fullProjectSnapshot: true } } });
  return { rootDir, workspace: Mirror.getProjectMirror('move-test', { rootDir }).workspacePath,
    collect: () => Mirror.collectMirrorChangesDetailed({ projectId: 'move-test', rootDir }) };
}
for (const content of ['exact\r\ncontent\n', '']) {
  test('unique same-content text relocation becomes one proved move, including empty text', async t => {
    const h = await setup(t, [{ path: 'old.tex', content }]);
    fs.mkdirSync(path.join(h.workspace, 'sections'));
    fs.renameSync(path.join(h.workspace, 'old.tex'), path.join(h.workspace, 'sections/new.tex'));
    const result = await h.collect();
    assert.deepEqual(result.unsupportedChanges, []); assert.equal(result.changes.length, 1);
    assert.deepEqual(result.changes[0], { type: 'move', path: 'old.tex', to: 'sections/new.tex',
      moveProof: { v: 1, kind: 'text', sha256: hash(content) }, previousExists: true, previousKind: 'text',
      size: Buffer.byteLength(content) });
  });
}
test('unique binary relocation becomes one move and does not allocate a Native upload token', async t => {
  const bytes = Buffer.from('binary source content');
  const h = await setup(t, [{ path: 'old.png', kind: 'binary', contentBase64: bytes.toString('base64') }]);
  fs.renameSync(path.join(h.workspace, 'old.png'), path.join(h.workspace, 'new.png'));
  const result = await h.collect();
  assert.equal(result.changes.length, 1); assert.deepEqual(result.unsupportedChanges, []);
  assert.equal(result.changes[0].type, 'move'); assert.equal(result.changes[0].moveProof.kind, 'binary');
  assert.equal(result.changes[0].moveProof.sha256, hash(bytes));
  const prepared = Assets.prepareBinaryAssetChanges({ projectId: 'move-test', rootDir: h.rootDir, changes: result.changes });
  assert.deepEqual(prepared.changes, result.changes); assert.equal(prepared.changes[0].assetRef, undefined);
});
test('ambiguous equal-content sources are not arbitrarily paired', async t => {
  const h = await setup(t, [{ path: 'a.tex', content: 'same' }, { path: 'b.tex', content: 'same' }]);
  fs.unlinkSync(path.join(h.workspace, 'a.tex')); fs.renameSync(path.join(h.workspace, 'b.tex'), path.join(h.workspace, 'c.tex'));
  const result = await h.collect();
  assert.equal(result.changes.some(change => change.type === 'move'), false);
  assert.deepEqual(result.changes.map(change => [change.type, change.path]).sort((a, b) => a[1].localeCompare(b[1])),
    [['delete', 'a.tex'], ['delete', 'b.tex'], ['write', 'c.tex']]);
});
test('different new content and standalone binary deletion retain existing operation boundaries', async t => {
  const h = await setup(t, [{ path: 'old.tex', content: 'old' }, { path: 'old.png', kind: 'binary', contentBase64: 'Ymlu' }]);
  fs.unlinkSync(path.join(h.workspace, 'old.tex')); fs.unlinkSync(path.join(h.workspace, 'old.png'));
  fs.writeFileSync(path.join(h.workspace, 'new.tex'), 'different');
  const result = await h.collect();
  assert.equal(result.changes.some(change => change.type === 'move'), false);
  assert.equal(result.unsupportedChanges.find(change => change.path === 'old.png').reason, 'binary_delete_unsupported');
  assert.equal(result.changes.length, 2);
});
