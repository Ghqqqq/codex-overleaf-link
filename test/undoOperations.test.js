const assert = require('node:assert/strict');
const test = require('node:test');
const StaleGuard = require('../extension/src/shared/staleGuard');
const Settlement = require('../extension/src/shared/writebackSettlement');
const { computeTextPatches } = require('../native-host/src/textPatch');

const {
  buildUndoCheckpoint,
  buildExpectedFilesAfterOperations,
  buildUndoOperations,
  buildSnapshotRestoreUndo
} = require('../extension/src/shared/undoOperations');

for (const [sourceEnding, editorEnding] of [['\r\n', '\n'], ['\n', '\r\n']]) {
  test('verified Undo checkpoints keep editor coordinates after mixed line endings ' + JSON.stringify(sourceEnding), () => {
    const source = 'a\nbc'.replace(/\n/g, sourceEnding), target = 'a\nbXc'.replace(/\n/g, sourceEnding);
    const verified = 'a\nbXc'.replace(/\n/g, editorEnding) + ' from collaborator';
    const project = { files: [{ path: 'main.tex', content: source }] };
    const operation = Settlement.attachVerifiedContentToOperation({ type: 'edit', path: 'main.tex',
      patches: computeTextPatches(source, target) }, { verified: true, verifiedContent: verified });
    const checkpoint = buildUndoCheckpoint(project, [operation]);
    assert.ok(checkpoint.undoOperations[0].patches.length, 'retain local inverse patches');
    assert.equal(checkpoint.undoOperations[0].replaceAll, null);
    const inverse = StaleGuard.prepareOperationPatches(checkpoint.undoOperations[0], verified,
      StaleGuard.buildBaseFileLookup(checkpoint.undoBaseFiles));
    assert.equal(inverse.ok, true);
    assert.equal(buildExpectedFilesAfterOperations({ files: checkpoint.undoBaseFiles }, checkpoint.undoOperations).get('main.tex'),
      'a\nbc'.replace(/\n/g, editorEnding) + ' from collaborator');
    assert.deepEqual(Settlement.selectExpectedFilesForTrackedUndo(project, [operation]),
      [{ path: 'main.tex', content: 'a\nbc'.replace(/\n/g, editorEnding) + ' from collaborator' }]);
  });

  test('verified Undo checkpoints retain source coordinates across sequential edits ' + JSON.stringify(sourceEnding), () => {
    const originals = ['a\nbc\nend', 'a\nbXc\nend', 'a\nbXc\nDONE'];
    const texts = originals.map(text => text.replace(/\n/g, sourceEnding));
    const project = { files: [{ path: 'main.tex', content: texts[0] }] };
    const operations = texts.slice(1).map((content, index) => Settlement.attachVerifiedContentToOperation({
      type: 'edit', path: 'main.tex', patches: computeTextPatches(texts[index], content)
    }, { verifiedContent: originals[index + 1].replace(/\n/g, editorEnding) }));
    const checkpoint = buildUndoCheckpoint(project, operations);
    assert.ok(checkpoint.undoOperations.every(operation => operation.patches?.length && operation.replaceAll === null));
    assert.equal(buildExpectedFilesAfterOperations({ files: checkpoint.undoBaseFiles }, checkpoint.undoOperations).get('main.tex'),
      originals[0].replace(/\n/g, editorEnding));
  });
}

test('builds undo operations from the pre-run project snapshot', () => {
  const project = {
    files: [
      { path: 'main.tex', content: 'alpha' },
      { path: 'old.tex', content: 'old body' },
      { path: 'unused.tex', content: 'unused body' }
    ]
  };

  const undo = buildUndoOperations(project, [
    { type: 'edit', path: 'main.tex', find: 'alpha', replace: 'beta' },
    { type: 'create', path: 'new.tex', content: 'new body' },
    { type: 'rename', path: 'old.tex', to: 'renamed.tex' },
    { type: 'delete', path: 'unused.tex', reason: 'not referenced' }
  ]);

  assert.deepEqual(undo, [
    { type: 'create', path: 'unused.tex', to: null, find: null, replace: null, replaceAll: null, content: 'unused body', reason: 'Undo delete' },
    { type: 'rename', path: 'renamed.tex', to: 'old.tex', find: null, replace: null, replaceAll: null, content: null, reason: 'Undo rename' },
    { type: 'delete', path: 'new.tex', to: null, find: null, replace: null, replaceAll: null, content: null, reason: 'Undo create' },
    { type: 'edit', path: 'main.tex', to: null, find: null, replace: null, replaceAll: 'alpha', content: null, reason: 'Undo edit' }
  ]);
});

test('coalesces multiple edits to the same file into one full-file restore', () => {
  const undo = buildUndoOperations({
    files: [{ path: 'main.tex', content: 'original' }]
  }, [
    { type: 'edit', path: 'main.tex', find: 'a', replace: 'b' },
    { type: 'edit', path: 'main.tex', find: 'c', replace: 'd' }
  ]);

  assert.deepEqual(undo, [
    { type: 'edit', path: 'main.tex', to: null, find: null, replace: null, replaceAll: 'original', content: null, reason: 'Undo edit' }
  ]);
});

test('builds local inverse patches for patch-based edits instead of full-file undo replacement', () => {
  const undo = buildUndoOperations({
    files: [{ path: 'main.tex', content: 'alpha beta gamma' }]
  }, [
    {
      type: 'edit',
      path: 'main.tex',
      patches: [
        { from: 6, to: 10, expected: 'beta', insert: 'delta' }
      ]
    }
  ]);

  assert.deepEqual(undo, [
    {
      type: 'edit',
      path: 'main.tex',
      to: null,
      find: null,
      replace: null,
      replaceAll: null,
      patches: [
        { from: 6, to: 11, expected: 'delta', insert: 'beta' }
      ],
      content: null,
      reason: 'Undo edit'
    }
  ]);
});

test('builds inverse patch ranges against the post-edit content after earlier patch shifts', () => {
  const undo = buildUndoOperations({
    files: [{ path: 'main.tex', content: 'one two three four' }]
  }, [
    {
      type: 'edit',
      path: 'main.tex',
      patches: [
        { from: 4, to: 7, expected: 'two', insert: 'twenty' },
        { from: 14, to: 18, expected: 'four', insert: '4' }
      ]
    }
  ]);

  assert.deepEqual(undo[0].patches, [
    { from: 4, to: 10, expected: 'twenty', insert: 'two' },
    { from: 17, to: 18, expected: '4', insert: 'four' }
  ]);
});

test('does not add fragile inverse patches after a full-file undo restore already covers the file', () => {
  const undo = buildUndoOperations({
    files: [{ path: 'main.tex', content: 'original alpha' }]
  }, [
    { type: 'edit', path: 'main.tex', replaceAll: 'rewritten beta' },
    {
      type: 'edit',
      path: 'main.tex',
      patches: [
        { from: 10, to: 14, expected: 'beta', insert: 'gamma' }
      ]
    }
  ]);

  assert.deepEqual(undo, [
    { type: 'edit', path: 'main.tex', to: null, find: null, replace: null, replaceAll: 'original alpha', content: null, reason: 'Undo edit' }
  ]);
});

test('skips undo operations that need unavailable original content', () => {
  const undo = buildUndoOperations({
    files: []
  }, [
    { type: 'edit', path: 'missing.tex', find: 'a', replace: 'b' },
    { type: 'delete', path: 'missing.tex' }
  ]);

  assert.deepEqual(undo, []);
});

test('builds an undo checkpoint guarded by the expected post-apply project state', () => {
  const checkpoint = buildUndoCheckpoint({
    files: [
      { path: 'main.tex', content: 'alpha old' },
      { path: 'old.tex', content: 'old body' },
      { path: 'deleted.tex', content: 'delete me' },
      { path: 'unrelated.tex', content: 'large unrelated file' }
    ]
  }, [
    { type: 'edit', path: 'main.tex', find: 'old', replace: 'new' },
    { type: 'create', path: 'created.tex', content: 'created body' },
    { type: 'rename', path: 'old.tex', to: 'renamed.tex' },
    { type: 'delete', path: 'deleted.tex', reason: 'cleanup' }
  ]);

  assert.deepEqual(checkpoint.undoBaseFiles, [
    { path: 'main.tex', content: 'alpha new' },
    { path: 'created.tex', content: 'created body' },
    { path: 'renamed.tex', content: 'old body' }
  ]);
  assert.deepEqual(checkpoint.undoOperations, [
    { type: 'create', path: 'deleted.tex', to: null, find: null, replace: null, replaceAll: null, content: 'delete me', reason: 'Undo delete' },
    { type: 'rename', path: 'renamed.tex', to: 'old.tex', find: null, replace: null, replaceAll: null, content: null, reason: 'Undo rename' },
    { type: 'delete', path: 'created.tex', to: null, find: null, replace: null, replaceAll: null, content: null, reason: 'Undo create' },
    { type: 'edit', path: 'main.tex', to: null, find: null, replace: null, replaceAll: 'alpha old', content: null, reason: 'Undo edit' }
  ]);
});

test('builds post-apply undo base files from local edit patches', () => {
  const expected = buildExpectedFilesAfterOperations({
    files: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ]
  }, [
    {
      type: 'edit',
      path: 'main.tex',
      patches: [
        { from: 6, to: 10, expected: 'beta', insert: 'delta' }
      ]
    }
  ]);

  assert.deepEqual(Array.from(expected.entries()), [
    ['main.tex', 'alpha delta gamma']
  ]);
});

test('builds full snapshot undo restores from legacy base files when original files are missing', () => {
  const restore = buildSnapshotRestoreUndo({
    undoExpectedFiles: [],
    undoBaseFiles: [
      { path: 'main.tex', content: 'alpha delta omega' }
    ],
    undoOperations: [
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 6, to: 11, expected: 'delta', insert: 'beta' }
        ]
      },
      {
        type: 'edit',
        path: 'main.tex',
        patches: [
          { from: 11, to: 16, expected: 'omega', insert: 'gamma' }
        ]
      }
    ]
  });

  assert.equal(restore.snapshotRestore, true);
  assert.deepEqual(restore.operations, [
    {
      type: 'edit',
      path: 'main.tex',
      to: null,
      find: null,
      replace: null,
      replaceAll: 'alpha beta gamma',
      content: null,
      reason: 'Undo edit'
    }
  ]);
});

// Regression: a "natural granularity" paragraph rewrite emits ONE wide patch
// whose `expected` spans the whole old paragraph. The post-apply derivation
// re-applies that patch against `undoExpectedFiles`, but that base is the
// Overleaf project snapshot which can drift slightly from the patch's base
// (the native mirror copy). A wide `expected` then fails to match, the patch
// silently does not apply, and the derived post-write content collapses to the
// un-patched paragraph. Reviewing-mode undo uses this content to decide
// whether the editor is still at the post-write state; when it is wrong, undo
// refuses its safe paths and the Codex-written paragraph is not reverted.
// Narrow token patches hid the bug: their tiny `expected` windows still match
// across the same drift. The writeback already verified the content it wrote,
// so the operation carries `verifiedContent`; the post-apply derivation must
// trust it instead of re-applying the wide patch.
test('uses verified post-write content for a wide paragraph patch even when its expected drifted', () => {
  const OLD_PARAGRAPH =
    'The quick brown fox jumps over the lazy dog near the river bank every single morning.';
  const NEW_PARAGRAPH =
    'A swift auburn fox leaps above a sleepy hound beside the stream each and every dawn.';

  // The Overleaf snapshot used for undoExpectedFiles drifted by one character
  // ("morning." -> "morning ") relative to the patch's native-mirror base.
  const DRIFTED_SNAPSHOT = OLD_PARAGRAPH.replace('morning.', 'morning ');

  const widePatch = {
    type: 'edit',
    path: 'main.tex',
    patches: [
      {
        from: 0,
        to: OLD_PARAGRAPH.length,
        expected: OLD_PARAGRAPH,
        insert: NEW_PARAGRAPH
      }
    ],
    // The writeback verified this exact content in the live editor.
    verifiedContent: NEW_PARAGRAPH
  };

  const expected = buildExpectedFilesAfterOperations(
    { files: [{ path: 'main.tex', content: DRIFTED_SNAPSHOT }] },
    [widePatch]
  );

  // Without trusting verifiedContent the wide patch fails to re-apply against
  // the drifted base and the result collapses back to DRIFTED_SNAPSHOT, which
  // makes Reviewing-mode undo think the editor is not at the post-write state.
  assert.equal(
    expected.get('main.tex'),
    NEW_PARAGRAPH,
    'post-write content must be the verified paragraph, not the un-patched snapshot'
  );

  // The same operation without verifiedContent (legacy shape) still falls back
  // to patch re-application, confirming the drift is what previously broke it.
  const legacy = buildExpectedFilesAfterOperations(
    { files: [{ path: 'main.tex', content: DRIFTED_SNAPSHOT }] },
    [{ type: 'edit', path: 'main.tex', patches: widePatch.patches }]
  );
  assert.equal(
    legacy.get('main.tex'),
    DRIFTED_SNAPSHOT,
    'legacy re-application collapses to the un-patched paragraph (the bug)'
  );
});
