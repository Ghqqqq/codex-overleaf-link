const assert = require('node:assert/strict');
const test = require('node:test');

const projectFiles = require('../extension/src/shared/projectFiles');
const WritebackController = require('../extension/src/content/writebackController');

test('safe project path validator rejects traversal, absolute, Windows, encoded, and control paths', () => {
  const unsafePaths = [
    '../x',
    '.',
    '..',
    '/abs.tex',
    'C:\\tmp\\x.tex',
    'folder\\file.tex',
    'folder/%2e%2e/file.tex',
    'bad\u0000name.tex'
  ];

  for (const filePath of unsafePaths) {
    assert.equal(projectFiles.normalizeSafeProjectPath(filePath), '', filePath);
    assert.throws(
      () => projectFiles.assertSafeProjectPath(filePath),
      /Invalid path/,
      filePath
    );
  }
});

test('safe project path validator keeps normal Overleaf project paths', () => {
  assert.deepEqual([
    projectFiles.normalizeSafeProjectPath('main.tex'),
    projectFiles.normalizeSafeProjectPath('sections/intro.tex'),
    projectFiles.normalizeSafeProjectPath('figures/plot.pdf')
  ], [
    'main.tex',
    'sections/intro.tex',
    'figures/plot.pdf'
  ]);
});

test('buildSyncApplyOperations prefers local text patches for existing files', () => {
  const operations = WritebackController.buildSyncApplyOperations([
    {
      type: 'write',
      path: 'main.tex',
      previousContent: 'alpha beta',
      content: 'alpha gamma'
    }
  ], {
    files: [
      { path: 'main.tex', content: 'alpha beta' }
    ]
  });

  assert.deepEqual(operations, [
    {
      type: 'edit',
      path: 'main.tex',
      patches: [
        {
          from: 6,
          to: 9,
          expected: 'bet',
          insert: 'gamm'
        }
      ],
      reasonKey: 'localWorkspacePatch',
      reasonParams: { count: 1 },
      reason: 'Synced 1 local Codex workspace edit.'
    }
  ]);
});

test('buildSyncApplyOperations preserves filtered review hunk patches', () => {
  const operations = WritebackController.buildSyncApplyOperations([
    {
      type: 'write',
      path: 'main.tex',
      previousContent: 'alpha beta gamma',
      content: 'alpha zeta delta',
      patches: [
        {
          from: 6,
          to: 10,
          expected: 'beta',
          insert: 'zeta'
        }
      ]
    }
  ], {
    files: [
      { path: 'main.tex', content: 'alpha beta gamma' }
    ]
  });

  assert.deepEqual(operations, [
    {
      type: 'edit',
      path: 'main.tex',
      patches: [
        {
          from: 6,
          to: 10,
          expected: 'beta',
          insert: 'zeta'
        }
      ],
      reasonKey: 'localWorkspacePatch',
      reasonParams: { count: 1 },
      reason: 'Synced 1 local Codex workspace edit.'
    }
  ]);
});

test('mergeVerifiedAppliedFiles preserves Overleaf snapshot but overlays verified writeback content', () => {
  const merged = WritebackController.mergeVerifiedAppliedFiles({
    files: [
      { path: 'main.tex', kind: 'text', content: 'stale' },
      { path: 'refs.bib', kind: 'text', content: '@article{x}' }
    ]
  }, {
    files: [
      { path: 'main.tex', kind: 'text', content: 'before' }
    ]
  }, {
    applied: [
      {
        operation: { type: 'edit', path: 'main.tex' },
        result: { verifiedContent: 'after' }
      }
    ]
  });

  assert.equal(merged.files.find(file => file.path === 'main.tex').content, 'after');
  assert.equal(merged.files.find(file => file.path === 'main.tex').source, 'verified-writeback');
  assert.equal(merged.files.find(file => file.path === 'refs.bib').content, '@article{x}');
});

test('getAppliedSyncChanges returns only changes that were actually written', () => {
  const changes = WritebackController.getAppliedSyncChanges([
    { path: 'main.tex' },
    { path: 'refs.bib' }
  ], {
    applied: [
      { operation: { type: 'edit', path: 'main.tex' } }
    ]
  });

  assert.deepEqual(changes, [{ path: 'main.tex' }]);
});

test('getAppliedOperationPaths includes rename and move destinations', () => {
  const paths = WritebackController.getAppliedOperationPaths({
    applied: [
      { operation: { type: 'rename', path: 'old.tex', to: 'new.tex' } },
      { operation: { type: 'move', path: 'sections/a.tex', to: 'appendix/a.tex' } },
      { operation: { type: 'edit', path: 'main.tex' } },
      { operation: { type: 'rename', path: 'old.tex', to: 'new.tex' } }
    ]
  });

  assert.deepEqual(paths, ['old.tex', 'new.tex', 'sections/a.tex', 'appendix/a.tex', 'main.tex']);
});

test('buildSyncApplyOperations maps binary asset changes without degrading them to text creates', () => {
  const operations = WritebackController.buildSyncApplyOperations([
    {
      type: 'binary-create',
      path: 'figures/new.png',
      contentBase64: Buffer.from([0, 1, 2]).toString('base64'),
      size: 3
    },
    {
      type: 'overwrite-binary',
      path: 'figures/old.pdf',
      contentBase64: Buffer.from('%PDF-next').toString('base64'),
      size: 9,
      previousExists: true
    }
  ], {
    files: [
      { path: 'figures/old.pdf', kind: 'binary', size: 7 }
    ]
  });

  assert.deepEqual(operations.map(operation => ({
    type: operation.type,
    path: operation.path,
    content: operation.content,
    contentBase64: operation.contentBase64,
    size: operation.size
  })), [
    {
      type: 'binary-create',
      path: 'figures/new.png',
      content: undefined,
      contentBase64: Buffer.from([0, 1, 2]).toString('base64'),
      size: 3
    },
    {
      type: 'overwrite-binary',
      path: 'figures/old.pdf',
      content: undefined,
      contentBase64: Buffer.from('%PDF-next').toString('base64'),
      size: 9
    }
  ]);
});

test('malformed applied entries do not count as written sync changes or paths', () => {
  const syncChanges = [
    { path: 'main.tex' },
    { path: 'refs.bib' }
  ];

  for (const applied of [
    { applied: 'x', skipped: [] },
    { applied: { length: 1 }, skipped: [] }
  ]) {
    assert.deepEqual(WritebackController.getAppliedSyncChanges(syncChanges, applied), []);
    assert.deepEqual(WritebackController.getAppliedOperationPaths(applied), []);
  }
});

test('malformed applied entries do not alter verified mirror merge', () => {
  const freshProject = {
    files: [
      { path: 'main.tex', kind: 'text', content: 'fresh' }
    ]
  };
  const originalProject = {
    files: [
      { path: 'main.tex', kind: 'text', content: 'before' }
    ]
  };

  for (const applied of [
    { applied: 'x', skipped: [] },
    { applied: { length: 1 }, skipped: [] }
  ]) {
    assert.deepEqual(
      WritebackController.mergeVerifiedAppliedFiles(freshProject, originalProject, applied),
      freshProject
    );
  }
});

test('unsupported local changes default to English per-file user-readable reasons', () => {
  const summary = WritebackController.formatUnsupportedLocalChangeSummary([
    { path: 'main.pdf', reason: 'generated_artifact' },
    { path: 'diagram.png', reason: 'unsupported_non_text_file' },
    { path: 'unknown.bin', reason: 'unknown_reason' }
  ]);

  assert.match(summary, /Codex generated these local files, but the extension did not sync them back to Overleaf/);
  assert.match(summary, /- main\.pdf: LaTeX build artifact; not written back by default\./);
  assert.match(summary, /- diagram\.png: Non-text file; automatic writeback is not supported yet\./);
  assert.match(summary, /- unknown\.bin: This file type is not supported for automatic writeback yet\./);
});

test('oversized binary native payload unsupported changes get explicit guidance', () => {
  const english = WritebackController.formatUnsupportedLocalChangeSummary([
    {
      path: 'figures/large.pdf',
      reason: 'binary_payload_exceeds_native_message_limit',
      size: 614400,
      limit: 524288
    }
  ], 'en');
  const chinese = WritebackController.formatUnsupportedLocalChangeSummary([
    {
      path: 'figures/large.pdf',
      reason: 'binary_payload_exceeds_native_message_limit',
      size: 614400,
      limit: 524288
    }
  ], 'zh');

  assert.match(english, /figures\/large\.pdf: Binary change is too large to send through native messaging \(600 KB\)\. Upload it in Overleaf or reduce it below 512 KB\./);
  assert.doesNotMatch(english, /file type is not supported/i);
  assert.match(chinese, /figures\/large\.pdf：二进制改动过大，无法通过 Native Messaging 返回（600 KB）。请在 Overleaf 中手动上传，或减小到 512 KB 以下。/);
  assert.doesNotMatch(chinese, /当前类型暂不支持/);
});

test('unsupported local changes are localized in English', () => {
  const summary = WritebackController.formatUnsupportedLocalChangeSummary([
    { path: 'main.pdf', reason: 'generated_artifact' },
    { path: 'diagram.png', reason: 'unsupported_non_text_file' },
    { path: 'unknown.bin', reason: 'unknown_reason' }
  ], 'en');

  assert.match(summary, /Codex generated these local files, but the extension did not sync them back to Overleaf/);
  assert.match(summary, /- main\.pdf: LaTeX build artifact; not written back by default\./);
  assert.match(summary, /- diagram\.png: Non-text file; automatic writeback is not supported yet\./);
  assert.match(summary, /- unknown\.bin: This file type is not supported for automatic writeback yet\./);
  assert.doesNotMatch(summary, /[\u4e00-\u9fff]/);
});
