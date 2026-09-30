const assert = require('node:assert/strict');
const test = require('node:test');
const Router = require('../extension/src/page/writebackRouter');
const StaleGuard = require('../extension/src/shared/staleGuard');
const ProjectFiles = require('../extension/src/shared/projectFiles');
const WriteGuard = require('../extension/src/page/writeGuard');

async function runBatch(t, { reuseOldId = false } = {}) {
  const paths = ['notes.tex', 'sub/nested.tex'], original = 'body\nold-note\n', marker = '% QA TRACK\n';
  let clock = 0, active = paths[0];
  const files = new Map(paths.map(path => [path, original]));
  const writtenAt = new Map(), leftAt = new Map(), writes = [];
  t.mock.method(Date, 'now', () => clock);
  const oldId = path => 'prior-' + path;
  const changes = path => {
    const written = writtenAt.has(path);
    if (written && reuseOldId) return [{ id: oldId(path), op: { p: 0, i: files.get(path) } }];
    const previous = { id: oldId(path), op: { p: 5 + (written ? marker.length : 0), i: 'old-note\n' } };
    return written && clock - writtenAt.get(path) >= 8000
      ? [previous, { id: 'current-' + path, op: { p: 0, i: marker } }] : [previous];
  };
  const router = Router.create({
    window: { CodexOverleafStaleGuard: StaleGuard, CodexOverleafProjectFiles: ProjectFiles,
      CodexOverleafWriteGuard: WriteGuard, _ide: { project: { _id: 'project-a' } }, setTimeout, clearTimeout },
    treeOperations: {
      getProjectId: () => 'project-a', getActiveFilePath: () => active,
      projectPathExists: path => files.has(path),
      openFileByPath: async path => { leftAt.set(active, clock); active = path; return { ok: true, path }; },
      waitForActiveEditorText: async path => ({ ok: true, path, text: files.get(path) })
    },
    ensureReviewing: async () => ({ ok: true }),
    readActiveEditorText: () => files.get(active),
    getCodeMirrorEditorView: () => ({ state: {
      doc: { length: files.get(active).length, toString: () => files.get(active) },
      values: [{ ranges: { docId: 'doc-' + active, changes: changes(active), comments: [] }, threads: {} }]
    } }),
    getTrackedChangeDocumentId: path => 'doc-' + path,
    replaceActiveEditorPatches(_patches, next) {
      writes.push(active); files.set(active, next); writtenAt.set(active, clock); return { ok: true };
    },
    collectElements: () => [],
    readNodeSignalText: node => node.textContent,
    compact: (value, limit) => String(value).slice(0, limit),
    delay: async ms => { clock += ms; }
  });
  const result = await router.applyOperations({
    runProjectId: 'project-a', requireReviewing: true,
    baseFiles: paths.map(path => ({ path, content: original })),
    operations: paths.map(path => ({ type: 'edit', path,
      patches: [{ from: 0, to: 0, insert: marker }] }))
  });
  return { result, files, paths, original, marker, writes, writtenAt, leftAt, clock };
}

test('multi-file Track finishes delayed attribution before navigating away, without claiming old changes', async t => {
  const h = await runBatch(t);
  assert.equal(h.result.ok, true, JSON.stringify(h.result));
  assert.equal(h.result.applied.length, 2);
  assert.equal(h.result.trackedChanges.length, 2, 'both files need attributable Track references');
  assert.ok(h.result.trackedChangeCaptures.every(capture => capture.state === 'observed'));
  assert.deepEqual(h.result.trackedChanges.map(ref => ref.id), h.paths.map(path => 'current-' + path));
  assert.ok(h.leftAt.get(h.paths[0]) - h.writtenAt.get(h.paths[0]) >= 8000,
    'the first editor must remain active until its delayed ledger is usable');
  assert.deepEqual(h.writes, h.paths, 'attribution must never replay the writes');
  for (const path of h.paths) assert.equal(h.files.get(path), h.marker + h.original);
});

test('old native IDs merged with unrelated text stay unowned and the wait remains bounded', async t => {
  const h = await runBatch(t, { reuseOldId: true });
  assert.equal(h.result.applied.length, 2);
  assert.deepEqual(h.result.trackedChanges, []);
  assert.ok(h.result.trackedChangeCaptures.every(capture => capture.state === 'needs_review'));
  assert.ok(h.clock < 80000, 'two captures must respect their existing 35-second budgets');
  assert.deepEqual(h.writes, h.paths);
});
