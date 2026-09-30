const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Coordinates = require('../extension/src/page/textCoordinates');
const Pruning = require('../extension/src/shared/storageValuePruning');
const { materializeTurnAttachments } = require('../native-host/src/turnAttachments');
const { safeWorkspaceRelativePath } = require('../native-host/src/subagentWorkspacePath');
const Snapshot = require('../extension/src/shared/runExecutionSnapshot');

test('line coordinates preserve CRLF, empty final lines and bounds', () => {
  const text = 'ab\r\ncd\n';
  assert.deepEqual(Coordinates.resolveJumpToPositionRange({ line: 2, column: 2 }, text, 'main.tex'), { ok: true, from: 5, to: 5 });
  assert.deepEqual(Coordinates.resolveJumpToPositionRange({ line: 3, selectLine: true }, text, 'main.tex'), { ok: true, from: 7, to: 7 });
  assert.equal(Coordinates.resolveJumpToPositionRange({ line: 2, column: 4 }, text, 'main.tex').code, 'column_out_of_range');
});

test('storage pruning preserves false, zero and the two distinct null policies', () => {
  const value = { no: false, count: 0, empty: '', absent: undefined, nil: null, list: [], map: {} };
  assert.deepEqual(Pruning.removeEmptySummaryFields(value), { no: false, count: 0 });
  assert.deepEqual(Pruning.removeEmptyFields(value), { no: false, count: 0, nil: null, list: [], map: {} });
});

test('subagent paths keep control-plane files unownable while permitting work slices', () => {
  assert.equal(safeWorkspaceRelativePath('.codex-overleaf-subagents/jobs/a.json'), null);
  assert.equal(safeWorkspaceRelativePath('.codex-overleaf-subagents/work/a.tex'), '.codex-overleaf-subagents/work/a.tex');
  assert.equal(safeWorkspaceRelativePath('../a.tex'), null);
  assert.equal(safeWorkspaceRelativePath('example/test.tex'), 'example/test.tex');
});

test('attachments are materialized below their own directory with unique basenames', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-attachment-boundary-'));
  try {
    const contentBase64 = Buffer.from('synthetic attachment').toString('base64');
    const results = materializeTurnAttachments([{ name: '../sample.txt', contentBase64 }, { name: 'sample.txt', contentBase64 }], root);
    assert.equal(results[0].path, '.codex-overleaf-attachments/sample.txt');
    assert.equal(results[1].path, '.codex-overleaf-attachments/sample-2.txt');
    for (const item of results) assert.equal(fs.readFileSync(path.join(root, item.path), 'utf8'), 'synthetic attachment');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('execution snapshots normalize declared selection and writing-style dependencies', () => {
  const snapshot = Snapshot.create({ mode: 'auto', model: 'gpt-6-luna', reasoningEffort: 'max',
    selectionContext: { projectId: 'project', path: 'main.tex', text: 'abc', from: 0, to: 3, documentHash: 'a'.repeat(64), mode: 'edit' },
    writingStyle: { accountScopeId: 'account', projectId: 'project', version: '11111111-1111-4111-8111-111111111111', bundleHash: 'b'.repeat(64), label: 'Style' }
  });
  assert.equal(snapshot.selectionContext.path, 'main.tex');
  assert.equal(snapshot.writingStyle.label, 'Style');
  assert.equal(Object.isFrozen(snapshot), true);
});
