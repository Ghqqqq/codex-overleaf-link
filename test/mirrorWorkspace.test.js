const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  SAFE_INLINE_BINARY_CHANGE_BYTES,
  confirmWritebackFiles,
  markMirrorDirty,
  collectMirrorChangesDetailed,
  collectMirrorChanges,
  getDefaultMirrorRoot,
  getProjectMirror,
  getMirrorStatus,
  syncOverleafToMirror
} = require('../native-host/src/mirrorWorkspace');
const { encodeMessage } = require('../native-host/src/nativeMessaging');

test('default mirror root falls back to USERPROFILE when HOME is absent', () => {
  const userProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-profile-'));
  try {
    const env = { USERPROFILE: userProfile };
    const expectedRoot = path.join(userProfile, '.codex-overleaf', 'projects');
    const mirror = getProjectMirror('profile-fallback-project', { env });

    assert.equal(getDefaultMirrorRoot({ env }), expectedRoot);
    assert.equal(mirror.projectRoot, path.join(expectedRoot, 'profile-fallback-project'));
  } finally {
    fs.rmSync(userProfile, { recursive: true, force: true });
  }
});

test('maps the same Overleaf project to a stable local mirror workspace', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    const first = getProjectMirror('https://www.overleaf.com/project/aabbccddeeff001122334455', { rootDir });
    const second = getProjectMirror('aabbccddeeff001122334455', { rootDir });

    assert.equal(first.workspacePath, second.workspacePath);
    assert.equal(first.projectKey, 'aabbccddeeff001122334455');
    assert.equal(first.workspacePath.startsWith(rootDir), true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('syncs Overleaf text files to the mirror and removes files missing from the next snapshot', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    const first = await syncOverleafToMirror({
      projectId: 'project-a',
      rootDir,
      project: {
        files: [
          { path: 'main.tex', content: 'hello' },
          { path: 'sections/old.tex', content: 'old' }
        ]
      }
    });

    assert.equal(fs.readFileSync(path.join(first.workspacePath, 'main.tex'), 'utf8'), 'hello');
    assert.equal(fs.existsSync(path.join(first.workspacePath, 'sections/old.tex')), true);

    const second = await syncOverleafToMirror({
      projectId: 'project-a',
      rootDir,
      project: {
        files: [
          { path: 'main.tex', content: 'hello again' }
        ]
      }
    });

    assert.equal(fs.readFileSync(path.join(second.workspacePath, 'main.tex'), 'utf8'), 'hello again');
    assert.equal(fs.existsSync(path.join(second.workspacePath, 'sections/old.tex')), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('normalizes Windows-style Overleaf file paths to forward slash baseline identity', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    const mirror = await syncOverleafToMirror({
      projectId: 'project-windows-paths',
      rootDir,
      project: {
        files: [
          { path: 'sections\\intro.tex', content: 'intro' }
        ]
      }
    });

    assert.equal(fs.readFileSync(path.join(mirror.workspacePath, 'sections', 'intro.tex'), 'utf8'), 'intro');
    const baseline = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
    assert.deepEqual(baseline.files.map(file => file.path), ['sections/intro.tex']);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('partial Overleaf snapshots update provided files without deleting the full mirror', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    const first = await syncOverleafToMirror({
      projectId: 'project-partial-overlay',
      rootDir,
      project: {
        capabilities: { fullProjectSnapshot: true },
        files: [
          { path: 'main.tex', content: 'before' },
          { path: 'refs.bib', content: '@article{a}' }
        ]
      }
    });
    const firstBaseline = JSON.parse(fs.readFileSync(path.join(first.metadataPath, 'baseline.json'), 'utf8'));

    const second = await syncOverleafToMirror({
      projectId: 'project-partial-overlay',
      rootDir,
      project: {
        capabilities: { fullProjectSnapshot: false },
        files: [
          { path: 'main.tex', content: 'live unsaved editor text' }
        ]
      }
    });

    assert.equal(fs.readFileSync(path.join(second.workspacePath, 'main.tex'), 'utf8'), 'live unsaved editor text');
    assert.equal(fs.readFileSync(path.join(second.workspacePath, 'refs.bib'), 'utf8'), '@article{a}');

    const secondBaseline = JSON.parse(fs.readFileSync(path.join(second.metadataPath, 'baseline.json'), 'utf8'));
    assert.equal(secondBaseline.lastFullSyncAt, firstBaseline.lastFullSyncAt);
    assert.equal(typeof secondBaseline.lastPartialSyncAt, 'string');
    assert.deepEqual(secondBaseline.files.map(file => file.path).sort(), ['main.tex', 'refs.bib']);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('legacy capturedAt-only baselines are not reusable as verified full mirrors', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    const mirror = getProjectMirror('legacy-captured-only', { rootDir });
    fs.mkdirSync(mirror.metadataPath, { recursive: true });
    fs.writeFileSync(mirror.baselinePath, JSON.stringify({
      capturedAt: new Date().toISOString(),
      files: [{ path: 'main.tex', kind: 'text', content: 'legacy', hash: 'legacy' }]
    }, null, 2), 'utf8');

    const status = getMirrorStatus('legacy-captured-only', { rootDir });

    assert.equal(status.exists, false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('invalid lastFullSyncAt baselines are not reusable as verified full mirrors', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    const mirror = getProjectMirror('invalid-full-sync-time', { rootDir });
    fs.mkdirSync(mirror.metadataPath, { recursive: true });
    fs.writeFileSync(mirror.baselinePath, JSON.stringify({
      lastFullSyncAt: 'not-a-date',
      files: [{ path: 'main.tex', kind: 'text', content: 'corrupt', hash: 'corrupt' }]
    }, null, 2), 'utf8');

    const status = getMirrorStatus('invalid-full-sync-time', { rootDir });

    assert.equal(status.exists, false);
    assert.equal(status.ageMs, Infinity);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('syncs binary Overleaf assets to the mirror without treating them as editable text changes', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    const binary = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const mirror = await syncOverleafToMirror({
      projectId: 'project-assets',
      rootDir,
      project: {
        files: [
          { path: 'main.tex', content: '\\includegraphics{Figures/plot.pdf}' },
          {
            path: 'Figures/plot.pdf',
            kind: 'binary',
            contentBase64: binary.toString('base64')
          }
        ]
      }
    });

    assert.deepEqual(fs.readFileSync(path.join(mirror.workspacePath, 'Figures/plot.pdf')), binary);
    assert.equal(fs.existsSync(path.join(mirror.workspacePath, 'Figures')), true);

    fs.writeFileSync(path.join(mirror.workspacePath, 'main.tex'), '\\includegraphics{Figures/plot.pdf}\n% note', 'utf8');
    fs.writeFileSync(path.join(mirror.workspacePath, 'Figures/plot.pdf'), Buffer.from([0x00, 0x01]));

    const changes = await collectMirrorChanges({ projectId: 'project-assets', rootDir });
    assert.deepEqual(changes.map(change => [change.type, change.path]).sort(), [
      ['overwrite-binary', 'Figures/plot.pdf'],
      ['write', 'main.tex']
    ].sort());
    const binaryChange = changes.find(change => change.path === 'Figures/plot.pdf');
    assert.equal(binaryChange.contentBase64, Buffer.from([0x00, 0x01]).toString('base64'));
    assert.equal(binaryChange.previousExists, true);
    assert.equal(binaryChange.previousKind, 'binary');
    assert.equal(binaryChange.previousSize, binary.length);
    assert.equal(binaryChange.size, 2);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reports deleted binary assets instead of silently ignoring them', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    const mirror = await syncOverleafToMirror({
      projectId: 'project-delete-binary',
      rootDir,
      project: {
        files: [
          { path: 'main.tex', content: '\\includegraphics{figures/old.png}' },
          {
            path: 'figures/old.png',
            kind: 'binary',
            contentBase64: Buffer.from([1, 2, 3]).toString('base64')
          }
        ]
      }
    });

    fs.rmSync(path.join(mirror.workspacePath, 'figures/old.png'));

    const detailed = await collectMirrorChangesDetailed({ projectId: 'project-delete-binary', rootDir });

    assert.deepEqual(detailed.unsupportedChanges.map(change => [
      change.type,
      change.path,
      change.reason,
      change.previousKind
    ]), [
      ['unsupported-local-file', 'figures/old.png', 'binary_delete_unsupported', 'binary']
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('collects new supported binary assets while leaving generated PDFs unsupported', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    const mirror = await syncOverleafToMirror({
      projectId: 'project-new-assets',
      rootDir,
      project: {
        files: [
          { path: 'main.tex', content: '\\documentclass{article}\n' }
        ]
      }
    });

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const pdf = Buffer.from('%PDF-1.7 user attachment');
    fs.mkdirSync(path.join(mirror.workspacePath, 'figures'), { recursive: true });
    fs.mkdirSync(path.join(mirror.workspacePath, 'appendix'), { recursive: true });
    fs.writeFileSync(path.join(mirror.workspacePath, 'figures', 'diagram.png'), png);
    fs.writeFileSync(path.join(mirror.workspacePath, 'appendix', 'supplement.pdf'), pdf);
    fs.writeFileSync(path.join(mirror.workspacePath, 'supplement-root.pdf'), pdf);
    fs.writeFileSync(path.join(mirror.workspacePath, 'main.pdf'), '%PDF-1.7 generated', 'utf8');

    const result = await collectMirrorChangesDetailed({ projectId: 'project-new-assets', rootDir });

    assert.deepEqual(result.changes.map(change => [change.type, change.path]), [
      ['binary-create', 'appendix/supplement.pdf'],
      ['binary-create', 'figures/diagram.png'],
      ['binary-create', 'supplement-root.pdf']
    ]);
    const pngChange = result.changes.find(change => change.path === 'figures/diagram.png');
    assert.equal(pngChange.contentBase64, png.toString('base64'));
    assert.equal(pngChange.previousExists, false);
    assert.equal(pngChange.size, png.length);
    assert.deepEqual(result.unsupportedChanges.map(change => [change.path, change.reason, change.size]), [
      ['main.pdf', 'generated_artifact', Buffer.byteLength('%PDF-1.7 generated')]
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reports oversized binary changes without inlining native response payloads', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    const mirror = await syncOverleafToMirror({
      projectId: 'project-large-binary-writeback',
      rootDir,
      project: {
        files: [
          { path: 'main.tex', content: '\\includegraphics{figures/large.pdf}' }
        ]
      }
    });

    const largePdf = Buffer.alloc(600 * 1024, 7);
    fs.mkdirSync(path.join(mirror.workspacePath, 'figures'), { recursive: true });
    fs.writeFileSync(path.join(mirror.workspacePath, 'figures', 'large.pdf'), largePdf);

    const result = await collectMirrorChangesDetailed({ projectId: 'project-large-binary-writeback', rootDir });

    assert.equal(result.changes.some(change => change.path === 'figures/large.pdf'), false);
    const unsupported = result.unsupportedChanges.find(change => change.path === 'figures/large.pdf');
    assert.deepEqual({
      type: unsupported?.type,
      path: unsupported?.path,
      reason: unsupported?.reason,
      size: unsupported?.size,
      attemptedChangeType: unsupported?.attemptedChangeType
    }, {
      type: 'unsupported-local-file',
      path: 'figures/large.pdf',
      reason: 'binary_payload_exceeds_native_message_limit',
      size: largePdf.length,
      attemptedChangeType: 'binary-create'
    });
    assert.equal(Object.hasOwn(unsupported, 'contentBase64'), false);
    assert.match(unsupported.guidance, /native messaging.*Overleaf/i);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('keeps aggregate inline binary changes within the native response frame budget', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    const mirror = await syncOverleafToMirror({
      projectId: 'project-aggregate-binary-writeback',
      rootDir,
      project: {
        files: [
          { path: 'main.tex', content: '\\includegraphics{figures/a.png}\\includegraphics{figures/b.png}' }
        ]
      }
    });

    const mediumBinary = Buffer.alloc(Math.floor(SAFE_INLINE_BINARY_CHANGE_BYTES * 0.84), 5);
    fs.mkdirSync(path.join(mirror.workspacePath, 'figures'), { recursive: true });
    fs.writeFileSync(path.join(mirror.workspacePath, 'figures', 'a.png'), mediumBinary);
    fs.writeFileSync(path.join(mirror.workspacePath, 'figures', 'b.png'), mediumBinary);

    const result = await collectMirrorChangesDetailed({ projectId: 'project-aggregate-binary-writeback', rootDir });
    const inlineBinaryChanges = result.changes.filter(change => change.type === 'binary-create');
    const degradedBinaryChanges = result.unsupportedChanges.filter(change =>
      change.reason === 'binary_payload_exceeds_native_message_limit'
    );

    assert.equal(inlineBinaryChanges.length, 1);
    assert.equal(degradedBinaryChanges.length, 1);
    assert.equal(Object.hasOwn(degradedBinaryChanges[0], 'contentBase64'), false);
    assert.match(degradedBinaryChanges[0].guidance, /native messaging.*Overleaf/i);
    assert.doesNotThrow(() => encodeMessage({
      status: 'completed',
      projectId: 'project-aggregate-binary-writeback',
      workspacePath: mirror.workspacePath,
      assistantMessage: '',
      threadId: '',
      syncChanges: result.changes,
      unsupportedChanges: result.unsupportedChanges
    }));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('ignores turn attachment context files in mirror change collection and status checks', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    const mirror = await syncOverleafToMirror({
      projectId: 'project-turn-attachments',
      rootDir,
      project: {
        files: [
          { path: 'main.tex', content: '\\documentclass{article}\n' }
        ]
      }
    });

    const attachmentDir = path.join(mirror.workspacePath, '.codex-overleaf-attachments');
    fs.mkdirSync(attachmentDir, { recursive: true });
    fs.writeFileSync(path.join(attachmentDir, 'CV_CN.pdf'), Buffer.from('%PDF context'));

    const result = await collectMirrorChangesDetailed({ projectId: 'project-turn-attachments', rootDir });
    const status = getMirrorStatus('project-turn-attachments', { rootDir });

    assert.deepEqual(result.changes, []);
    assert.deepEqual(result.unsupportedChanges, []);
    assert.equal(status.exists, true);
    assert.equal(status.dirty, false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('collects local mirror writes and deletes as sync changes, not Codex operation JSON', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    const mirror = await syncOverleafToMirror({
      projectId: 'project-b',
      rootDir,
      project: {
        files: [
          { path: 'main.tex', content: 'before' },
          { path: 'refs.bib', content: '@article{x}' }
        ]
      }
    });

    fs.writeFileSync(path.join(mirror.workspacePath, 'main.tex'), 'after', 'utf8');
    fs.writeFileSync(path.join(mirror.workspacePath, 'new.tex'), 'new file', 'utf8');
    fs.rmSync(path.join(mirror.workspacePath, 'refs.bib'));

    const changes = await collectMirrorChanges({ projectId: 'project-b', rootDir });

    assert.deepEqual(changes.map(change => [change.type, change.path]), [
      ['write', 'main.tex'],
      ['write', 'new.tex'],
      ['delete', 'refs.bib']
    ]);
    assert.equal(changes[0].content, 'after');
    assert.equal(changes[0].previousContent, 'before');
    assert.equal(changes[0].previousExists, true);
    assert.equal(changes[1].previousExists, false);
    assert.equal(changes[2].previousExists, true);
    assert.equal(Object.hasOwn(changes[0], 'find'), false);
    assert.equal(Object.hasOwn(changes[0], 'replace'), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('delete changes preserve baseline existence for empty existing files', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    const mirror = await syncOverleafToMirror({
      projectId: 'project-empty-delete',
      rootDir,
      project: {
        files: [
          { path: 'empty.tex', content: '' }
        ]
      }
    });

    fs.rmSync(path.join(mirror.workspacePath, 'empty.tex'));
    const changes = await collectMirrorChanges({ projectId: 'project-empty-delete', rootDir });

    assert.deepEqual(changes.map(change => [change.type, change.path]), [
      ['delete', 'empty.tex']
    ]);
    assert.equal(changes[0].previousContent, '');
    assert.equal(changes[0].previousExists, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('mirror status is not reusable when workspace content differs from baseline', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    const mirror = await syncOverleafToMirror({
      projectId: 'project-dirty-status',
      rootDir,
      project: {
        capabilities: { fullProjectSnapshot: true },
        files: [{ path: 'main.tex', content: 'overleaf' }]
      }
    });
    fs.writeFileSync(path.join(mirror.workspacePath, 'main.tex'), 'local dirty edit', 'utf8');

    const status = getMirrorStatus('project-dirty-status', { rootDir });

    assert.equal(status.exists, false);
    assert.equal(status.dirty, true);
    assert.equal(status.dirtyReason, 'workspace_mismatch');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('mirror status is not reusable when workspace contains extra managed text files', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    const mirror = await syncOverleafToMirror({
      projectId: 'project-extra-file-status',
      rootDir,
      project: {
        capabilities: { fullProjectSnapshot: true },
        files: [{ path: 'main.tex', content: 'overleaf' }]
      }
    });
    fs.writeFileSync(path.join(mirror.workspacePath, 'new.tex'), 'local only', 'utf8');

    const status = getMirrorStatus('project-extra-file-status', { rootDir });

    assert.equal(status.exists, false);
    assert.equal(status.dirty, true);
    assert.equal(status.dirtyReason, 'workspace_extra_file');
    assert.equal(status.dirtyPath, 'new.tex');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('mirror status is not reusable when workspace contains an extra latexmkrc file', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    const mirror = await syncOverleafToMirror({
      projectId: 'project-extra-latexmkrc-status',
      rootDir,
      project: {
        capabilities: { fullProjectSnapshot: true },
        files: [{ path: 'main.tex', content: 'overleaf' }]
      }
    });
    fs.writeFileSync(path.join(mirror.workspacePath, '.latexmkrc'), '$pdf_mode = 1;', 'utf8');

    const status = getMirrorStatus('project-extra-latexmkrc-status', { rootDir });

    assert.equal(status.exists, false);
    assert.equal(status.dirty, true);
    assert.equal(status.dirtyReason, 'workspace_extra_file');
    assert.equal(status.dirtyPath, '.latexmkrc');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('full mirror sync rewrites files whose workspace content was dirtied despite matching baseline hash', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    const mirror = await syncOverleafToMirror({
      projectId: 'project-full-clean',
      rootDir,
      project: {
        capabilities: { fullProjectSnapshot: true },
        files: [{ path: 'main.tex', content: 'overleaf clean' }]
      }
    });
    fs.writeFileSync(path.join(mirror.workspacePath, 'main.tex'), 'local dirty edit', 'utf8');

    const result = await syncOverleafToMirror({
      projectId: 'project-full-clean',
      rootDir,
      project: {
        capabilities: { fullProjectSnapshot: true },
        files: [{ path: 'main.tex', content: 'overleaf clean' }]
      }
    });

    assert.equal(fs.readFileSync(path.join(mirror.workspacePath, 'main.tex'), 'utf8'), 'overleaf clean');
    assert.equal(result.writtenCount, 1);
    assert.equal(getMirrorStatus('project-full-clean', { rootDir }).exists, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('explicit dirty marker makes mirror status non-reusable until the next full sync', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    await syncOverleafToMirror({
      projectId: 'project-dirty-marker',
      rootDir,
      project: {
        capabilities: { fullProjectSnapshot: true },
        files: [{ path: 'main.tex', content: 'overleaf' }]
      }
    });

    markMirrorDirty({ projectId: 'project-dirty-marker', rootDir, reason: 'codex_run_local_changes' });
    const dirtyStatus = getMirrorStatus('project-dirty-marker', { rootDir });

    assert.equal(dirtyStatus.exists, false);
    assert.equal(dirtyStatus.dirty, true);
    assert.equal(dirtyStatus.dirtyReason, 'codex_run_local_changes');

    await syncOverleafToMirror({
      projectId: 'project-dirty-marker',
      rootDir,
      project: {
        capabilities: { fullProjectSnapshot: true },
        files: [{ path: 'main.tex', content: 'overleaf' }]
      }
    });

    const cleanStatus = getMirrorStatus('project-dirty-marker', { rootDir });
    assert.equal(cleanStatus.exists, true);
    assert.equal(cleanStatus.dirty, false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('removes and ignores unmanaged LaTeX build artifacts in the local mirror', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    const mirror = await syncOverleafToMirror({
      projectId: 'project-generated-artifacts',
      rootDir,
      project: {
        files: [
          { path: 'main.tex', content: '\\documentclass{article}\n' }
        ]
      }
    });

    fs.writeFileSync(path.join(mirror.workspacePath, 'main.pdf'), '%PDF-1.7 generated', 'utf8');
    fs.writeFileSync(path.join(mirror.workspacePath, 'main.aux'), '\\relax\n', 'utf8');
    fs.writeFileSync(path.join(mirror.workspacePath, 'main.log'), 'latex log\n', 'utf8');
    fs.writeFileSync(path.join(mirror.workspacePath, 'new.tex'), 'new source', 'utf8');

    const changes = await collectMirrorChanges({ projectId: 'project-generated-artifacts', rootDir });
    assert.deepEqual(changes.map(change => change.path), ['new.tex']);

    await syncOverleafToMirror({
      projectId: 'project-generated-artifacts',
      rootDir,
      project: {
        files: [
          { path: 'main.tex', content: '\\documentclass{article}\n' }
        ]
      }
    });

    assert.equal(fs.existsSync(path.join(mirror.workspacePath, 'main.pdf')), false);
    assert.equal(fs.existsSync(path.join(mirror.workspacePath, 'main.aux')), false);
    assert.equal(fs.existsSync(path.join(mirror.workspacePath, 'main.log')), false);
    assert.equal(fs.existsSync(path.join(mirror.workspacePath, 'new.tex')), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('withholds a changed root PDF that matches a root TeX source already present in the baseline', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    const mirror = await syncOverleafToMirror({
      projectId: 'project-existing-root-build-pdf',
      rootDir,
      project: {
        files: [
          { path: 'LOE2Dplus.tex', content: '\\documentclass{article}\n' },
          {
            path: 'LOE2Dplus.pdf',
            kind: 'binary',
            contentBase64: Buffer.from('%PDF-1.7 baseline').toString('base64')
          }
        ]
      }
    });

    fs.writeFileSync(
      path.join(mirror.workspacePath, 'LOE2Dplus.pdf'),
      Buffer.from('%PDF-1.7 generated by local compile')
    );

    const detailed = await collectMirrorChangesDetailed({
      projectId: 'project-existing-root-build-pdf',
      rootDir
    });

    assert.equal(
      detailed.changes.some(change => change.path === 'LOE2Dplus.pdf'),
      false,
      'a derived root PDF must not become a binary writeback operation'
    );
    assert.deepEqual(
      detailed.unsupportedChanges
        .filter(change => change.path === 'LOE2Dplus.pdf')
        .map(change => [change.path, change.reason]),
      [['LOE2Dplus.pdf', 'generated_artifact']]
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('reports local files that cannot be synchronized back to Overleaf', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    const mirror = await syncOverleafToMirror({
      projectId: 'project-unsupported-local-files',
      rootDir,
      project: {
        files: [
          { path: 'main.tex', content: '\\documentclass{article}\n' }
        ]
      }
    });

    fs.writeFileSync(path.join(mirror.workspacePath, 'data.bin'), Buffer.from([0x00, 0x01]));
    fs.writeFileSync(path.join(mirror.workspacePath, 'main.pdf'), '%PDF-1.7 generated', 'utf8');

    const result = await collectMirrorChangesDetailed({ projectId: 'project-unsupported-local-files', rootDir });

    assert.deepEqual(result.changes, []);
    assert.deepEqual(result.unsupportedChanges.map(change => [change.path, change.reason, change.size]), [
      ['data.bin', 'unsupported_non_text_file', 2],
      ['main.pdf', 'generated_artifact', Buffer.byteLength('%PDF-1.7 generated')]
    ]);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('skips oversized binary assets instead of mirroring them into the local workspace', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    const oversized = Buffer.alloc(11 * 1024 * 1024, 1);
    const mirror = await syncOverleafToMirror({
      projectId: 'project-large-assets',
      rootDir,
      project: {
        files: [
          { path: 'main.tex', content: '\\includegraphics{Figures/huge.png}' },
          {
            path: 'Figures/huge.png',
            kind: 'binary',
            size: oversized.length,
            contentBase64: oversized.toString('base64')
          }
        ]
      }
    });

    assert.equal(fs.existsSync(path.join(mirror.workspacePath, 'Figures/huge.png')), false);
    assert.equal(mirror.fileCount, 1);
    assert.equal(mirror.skippedFiles[0].path, 'Figures/huge.png');
    assert.equal(mirror.skippedFiles[0].reason, 'binary_file_too_large');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('rejects project paths that would escape the local mirror', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    await assert.rejects(
      syncOverleafToMirror({
        projectId: 'project-c',
        rootDir,
        project: {
          files: [
            { path: '../outside.tex', content: 'bad' }
          ]
        }
      }),
      /Unsafe project path/
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('confirmWritebackFiles re-hashes written workspace files in place and refreshes freshness (v1.8.0)', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    await syncOverleafToMirror({
      projectId: 'confirm-project',
      project: {
        files: [
          { path: 'main.tex', content: 'original content\n' },
          { path: 'other.tex', content: 'untouched\n' }
        ],
        capabilities: { fullProjectSnapshot: true }
      },
      rootDir
    });
    const mirror = getProjectMirror('confirm-project', { rootDir });
    const statusBefore = getMirrorStatus('confirm-project', { rootDir });

    // Codex edits the workspace copy (the writeback SOURCE), then the
    // writeback lands it in Overleaf. Confirm must adopt the workspace
    // content as the new baseline without any re-download.
    fs.writeFileSync(path.join(mirror.workspacePath, 'main.tex'), 'edited by codex\n', 'utf8');

    const result = await confirmWritebackFiles({
      projectId: 'confirm-project',
      paths: ['main.tex'],
      rootDir
    });
    assert.equal(result.ok, true);
    assert.equal(result.confirmed.length, 1);
    assert.equal(result.confirmed[0].path, 'main.tex');

    const baseline = JSON.parse(fs.readFileSync(mirror.baselinePath, 'utf8'));
    const mainEntry = baseline.files.find(file => file.path === 'main.tex');
    assert.equal(mainEntry.content, 'edited by codex\n', 'baseline adopts the workspace content');
    const otherEntry = baseline.files.find(file => file.path === 'other.tex');
    assert.equal(otherEntry.content, 'untouched\n', 'untouched files keep their baseline');
    assert.equal(baseline.lastSyncSource, 'writeback-confirm');
    assert.ok(baseline.lastFullSyncAt >= statusBefore.lastFullSyncAt, 'freshness is renewed');

    const statusAfter = getMirrorStatus('confirm-project', { rootDir });
    assert.equal(statusAfter.exists, true, 'mirror stays reusable after confirm');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('confirmWritebackFiles refuses dirty mirrors, unknown files and missing baselines (v1.8.0)', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-'));
  try {
    // No baseline yet -> refuse (caller falls back to the full resync).
    const noBaseline = await confirmWritebackFiles({ projectId: 'confirm-guards', paths: ['main.tex'], rootDir });
    assert.equal(noBaseline.ok, false);
    assert.equal(noBaseline.reason, 'no_baseline');

    await syncOverleafToMirror({
      projectId: 'confirm-guards',
      project: {
        files: [{ path: 'main.tex', content: 'original\n' }],
        capabilities: { fullProjectSnapshot: true }
      },
      rootDir
    });

    // A path outside the baseline (e.g. a tree op slipped through) -> refuse.
    const unknown = await confirmWritebackFiles({ projectId: 'confirm-guards', paths: ['new-file.tex'], rootDir });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.reason, 'missing_baseline_file');

    // Empty path list -> refuse.
    const empty = await confirmWritebackFiles({ projectId: 'confirm-guards', paths: [], rootDir });
    assert.equal(empty.ok, false);

    // Dirty mirror -> refuse.
    markMirrorDirty({ projectId: 'confirm-guards', rootDir, reason: 'test_dirty' });
    const dirty = await confirmWritebackFiles({ projectId: 'confirm-guards', paths: ['main.tex'], rootDir });
    assert.equal(dirty.ok, false);
    assert.equal(dirty.reason, 'dirty_mirror');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('mirror rejects pre-existing symlink escapes before partial sync or change collection', { skip: process.platform === 'win32' }, async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-symlink-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-mirror-outside-'));
  try {
    const mirror = await syncOverleafToMirror({
      projectId: 'symlink-escape',
      rootDir,
      project: {
        capabilities: { fullProjectSnapshot: true },
        files: [{ path: 'main.tex', content: 'safe\n' }]
      }
    });
    fs.symlinkSync(outsideDir, path.join(mirror.workspacePath, 'sections'), 'dir');

    await assert.rejects(
      syncOverleafToMirror({
        projectId: 'symlink-escape',
        rootDir,
        project: {
          capabilities: { fullProjectSnapshot: false },
          files: [{ path: 'sections/intro.tex', content: 'escaped\n' }]
        }
      }),
      /Unsafe mirror path/
    );
    assert.equal(fs.existsSync(path.join(outsideDir, 'intro.tex')), false);
    await assert.rejects(
      collectMirrorChangesDetailed({ projectId: 'symlink-escape', rootDir }),
      /Unsafe mirror symlink/
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});
