const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createUpdateBundleArchive,
  extractVerifiedUpdateBundle
} = require('../native-host/src/updateArchive');

test('creates and extracts an allowlisted coordinated update bundle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-update-archive-'));
  try {
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    const files = {
      'extension-runtime/runtime-manifest.json': '{}\n',
      'extension-runtime/src/contentScript.js': 'void 0;\n',
      'extension-runtime/vendor/markdown-it/LICENSE': 'MIT\n',
      'extension-runtime/vendor/markdown-it/SOURCE.json': '{"source":"markdown-it"}\n',
      'extension-runtime/vendor/markdown-it/VERSION': '14.1.0\n',
      'extension-runtime/vendor/markdown-it/markdown-it.min.js': 'void 0;\n',
      'native-runtime/package.json': '{"version":"1.9.1"}\n',
      'native-runtime/native-host/src/index.js': 'void 0;\n'
    };
    const entries = Object.entries(files).map(([archivePath, content], index) => {
      const sourcePath = path.join(source, String(index));
      fs.writeFileSync(sourcePath, content);
      return { archivePath, sourcePath };
    });
    const archivePath = path.join(root, 'bundle.tar.gz');
    createUpdateBundleArchive({ outputPath: archivePath, entries });
    const destinationRoot = path.join(root, 'extracted');
    const result = extractVerifiedUpdateBundle({ archivePath, destinationRoot });
    assert.deepEqual(result.files, Object.keys(files).sort());
    assert.equal(fs.readFileSync(path.join(destinationRoot, 'native-runtime/package.json'), 'utf8'), files['native-runtime/package.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects traversal and non-runtime paths before creating an archive', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-update-traversal-'));
  try {
    const sourcePath = path.join(root, 'file');
    fs.writeFileSync(sourcePath, 'x');
    assert.throws(
      () => createUpdateBundleArchive({
        outputPath: path.join(root, 'bad.tar.gz'),
        entries: [{ archivePath: '../private.key', sourcePath }]
      }),
      error => error.code === 'update_archive_path_forbidden'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
