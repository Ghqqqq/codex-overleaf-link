const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const packageJson = require('../package.json');
const packageLock = require('../package-lock.json');
const extensionManifest = require('../extension/manifest.json');
const compatibility = require('../extension/src/shared/compatibility');
const { CONTENT_BUNDLE_RUNTIME_PATH } = require('./_helpers/contentBundleEntry');

const GENERATED_RUNTIME_FILES = new Set([
  `extension/${CONTENT_BUNDLE_RUNTIME_PATH}`
]);

test('current development version surfaces are aligned for packaging', () => {
  assert.match(packageJson.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);
  assert.equal(extensionManifest.version, packageJson.version);
  assert.equal(compatibility.BUILD_TARGET_VERSION, packageJson.version);
  assert.equal(compatibility.EXTENSION_PROTOCOL_VERSION, 2);
  assert.deepEqual(compatibility.SUPPORTED_NATIVE_PROTOCOL, { min: 1, max: 2 });
});

function readGitTrackedFiles() {
  const result = spawnSync('git', ['ls-files'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return new Set(result.stdout.split(/\r?\n/).filter(Boolean));
}

function normalizeRelativePath(fullPath) {
  return path.relative(repoRoot, fullPath).replace(/\\/g, '/');
}

function collectManifestExtensionPaths() {
  const paths = new Set();

  for (const contentScript of extensionManifest.content_scripts || []) {
    for (const script of contentScript.js || []) {
      paths.add(`extension/${script}`);
    }
    for (const stylesheet of contentScript.css || []) {
      paths.add(`extension/${stylesheet}`);
    }
  }

  if (extensionManifest.background?.service_worker) {
    paths.add(`extension/${extensionManifest.background.service_worker}`);
  }
  if (extensionManifest.action?.default_popup) {
    paths.add(`extension/${extensionManifest.action.default_popup}`);
  }

  for (const iconMap of [extensionManifest.icons, extensionManifest.action?.default_icon]) {
    for (const iconPath of Object.values(iconMap || {})) {
      paths.add(`extension/${iconPath}`);
    }
  }

  for (const resourceGroup of extensionManifest.web_accessible_resources || []) {
    for (const resource of resourceGroup.resources || []) {
      paths.add(`extension/${resource}`);
    }
  }

  return [...paths].sort();
}

function walkFiles(rootDir) {
  const entries = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      entries.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      entries.push(fullPath);
    }
  }
  return entries;
}

function resolveRelativeRequire(sourcePath, specifier) {
  const basePath = path.resolve(path.dirname(sourcePath), specifier);
  const candidates = [
    basePath,
    `${basePath}.js`,
    `${basePath}.json`,
    path.join(basePath, 'index.js')
  ];
  return candidates.find(candidate => fs.existsSync(candidate));
}

function collectNativeRelativeRequireTargets() {
  const sourceRoot = path.join(repoRoot, 'native-host/src');
  const sourceFiles = walkFiles(sourceRoot).filter(filePath => filePath.endsWith('.js'));
  const targets = new Set(sourceFiles.map(normalizeRelativePath));

  for (const sourcePath of sourceFiles) {
    const source = fs.readFileSync(sourcePath, 'utf8');
    const requirePattern = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    for (const match of source.matchAll(requirePattern)) {
      const resolved = resolveRelativeRequire(sourcePath, match[1]);
      assert.ok(resolved, `${normalizeRelativePath(sourcePath)} should resolve ${match[1]}`);
      targets.add(normalizeRelativePath(resolved));
    }
  }

  return [...targets].sort();
}

function collectContentBundleInputs() {
  const entryPath = path.join(repoRoot, 'extension/entries/content-entry.mjs');
  const source = fs.readFileSync(entryPath, 'utf8');
  const inputs = new Set([normalizeRelativePath(entryPath)]);
  const importPattern = /^\s*import\s+['"](\.[^'"]+)['"]\s*;?/gm;

  for (const match of source.matchAll(importPattern)) {
    const resolved = resolveRelativeRequire(entryPath, match[1]);
    assert.ok(resolved, `${normalizeRelativePath(entryPath)} should resolve ${match[1]}`);
    inputs.add(normalizeRelativePath(resolved));
  }

  return [...inputs].sort();
}

test('manifest-referenced extension files are git-tracked for release packaging', () => {
  const trackedFiles = readGitTrackedFiles();
  for (const relativePath of collectManifestExtensionPaths()) {
    if (GENERATED_RUNTIME_FILES.has(relativePath)) {
      assert.equal(fs.existsSync(path.join(repoRoot, relativePath)), true, `${relativePath} must be built before packaging`);
      assert.equal(trackedFiles.has(relativePath), false, `${relativePath} must remain generated and untracked`);
      continue;
    }
    if (relativePath.endsWith('/*')) {
      const trackedPrefix = relativePath.slice(0, -1);
      assert.ok(
        [...trackedFiles].some(filePath => filePath.startsWith(trackedPrefix)),
        `${relativePath} must match at least one git-tracked file because release packaging uses git ls-files`
      );
      continue;
    }
    assert.ok(
      trackedFiles.has(relativePath),
      `${relativePath} must be git-tracked because release packaging uses git ls-files`
    );
  }
});

test('native source files and relative require targets are git-tracked for release packaging', () => {
  const trackedFiles = readGitTrackedFiles();
  for (const relativePath of collectNativeRelativeRequireTargets()) {
    assert.ok(
      trackedFiles.has(relativePath),
      `${relativePath} must be git-tracked because release packaging uses git ls-files`
    );
  }
});

test('content bundle entry and static imports are git-tracked for release packaging', () => {
  const trackedFiles = readGitTrackedFiles();
  for (const relativePath of collectContentBundleInputs()) {
    assert.ok(
      trackedFiles.has(relativePath),
      `${relativePath} must be git-tracked because the content bundle imports it`
    );
  }
});
