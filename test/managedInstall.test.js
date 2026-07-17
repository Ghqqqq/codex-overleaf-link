const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const packageJson = require('../package.json');
const {
  EXTENSION_MARKER,
  assertSafeManagedRoot,
  buildManagedExtensionTree
} = require('../native-host/src/managedInstall');

test('builds a loadable managed extension with stable Bootstrap and replaceable runtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-managed-extension-'));
  try {
    buildManagedExtensionTree({
      packageRoot: path.resolve(__dirname, '..'),
      targetRoot: root,
      version: packageJson.version
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, packageJson.version);
    assert.equal(manifest.background.service_worker, 'bootstrap/background.js');
    assert.equal(manifest.permissions.includes('scripting'), true);
    assert.equal(manifest.host_permissions.includes('https://www.overleaf.com/project'), true);
    assert.equal(fs.existsSync(path.join(root, 'runtime/runtime-manifest.json')), true);
    assert.equal(fs.existsSync(path.join(root, 'runtime/src/content/contentRuntime.js')), true);
    assert.equal(fs.existsSync(path.join(root, 'runtime/src/content/mathText.js')), true);
    assert.equal(fs.existsSync(path.join(root, 'runtime/vendor/katex/katex.min.js')), true);
    assert.equal(fs.existsSync(path.join(root, 'runtime/vendor/katex/katex.min.css')), true);
    assert.equal(fs.existsSync(path.join(root, 'runtime/vendor/katex/fonts/KaTeX_Main-Regular.woff2')), true);
    const sourceManifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../extension/manifest.json'), 'utf8'));
    const runtimeManifest = JSON.parse(fs.readFileSync(path.join(root, 'runtime/runtime-manifest.json'), 'utf8'));
    assert.deepEqual(runtimeManifest.matches, sourceManifest.content_scripts[0].matches);
    assert.deepEqual(runtimeManifest.js, sourceManifest.content_scripts[0].js);
    assert.deepEqual(runtimeManifest.css, sourceManifest.content_scripts[0].css);
    assert.equal(manifest.web_accessible_resources[0].resources.includes('runtime/vendor/katex/fonts/*'), true);
    assert.equal(fs.existsSync(path.join(root, 'bootstrap/update.html')), true);
    assert.equal(fs.existsSync(path.join(root, 'bootstrap/update.css')), true);
    assert.equal(fs.existsSync(path.join(root, 'bootstrap/update.js')), true);
    const marker = JSON.parse(fs.readFileSync(path.join(root, EXTENSION_MARKER), 'utf8'));
    assert.equal(marker.bootstrapProtocol, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('managed root safety rejects paths reached through a symlinked ancestor', (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows symlink creation requires privileges outside this test contract.');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-managed-root-'));
  const home = path.join(root, 'home');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(home);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(home, 'linked'));
  try {
    assert.throws(() => assertSafeManagedRoot(path.join(home, 'linked', 'managed'), {
      env: { HOME: home },
      packageRoot: path.join(root, 'repo'),
      platform: process.platform,
      platformPath: path
    }), /symlink/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
