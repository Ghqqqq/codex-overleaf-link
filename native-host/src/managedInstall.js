'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildLauncher } = require('./launcher');
const {
  DEFAULT_CHROME_EXTENSION_ID,
  buildAllowedOrigin,
  buildHostManifest,
  validateChromeExtensionId
} = require('./manifest');
const {
  getDefaultBridgePath,
  getDefaultManagedExtensionRoot,
  getDefaultManagedNativeRoot,
  getDefaultManagedRoot,
  getNativeHostRegistrationTarget
} = require('./nativeHostPlatform');
const { buildRuntimeFileManifest } = require('./runtimeInstaller');
const { parseSemver, updateError } = require('./updateTrust');

const MANAGED_BY = 'codex-overleaf-link';
const EXTENSION_MARKER = '.codex-overleaf-managed-extension.json';
const NATIVE_MARKER = '.codex-overleaf-managed-native.json';

function installManagedDistribution(options = {}) {
  const packageRoot = path.resolve(options.packageRoot || path.resolve(__dirname, '../..'));
  const pkg = readJson(path.join(packageRoot, 'package.json'));
  const version = String(options.version || pkg.version || '');
  if (!parseSemver(version)) {
    throw updateError('managed_version_invalid', 'Managed installation requires a stable semantic version.');
  }
  const releaseRef = String(options.releaseRef || process.env.CODEX_OVERLEAF_RELEASE_REF || process.env.CODEX_OVERLEAF_REF || `v${version}`);
  const releaseChannel = options.releaseChannel || (releaseRef === `v${version}` ? 'stable' : 'prerelease');
  const platform = options.platform || process.platform;
  const browser = options.browser || 'chrome';
  const env = options.env || process.env;
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const managedRoot = resolveForPlatform(options.managedRoot || getDefaultManagedRoot({ platform, env }), platformPath);
  const extensionRoot = resolveForPlatform(options.extensionRoot || platformPath.join(managedRoot, 'extension'), platformPath);
  const nativeRoot = resolveForPlatform(options.nativeRoot || platformPath.join(managedRoot, 'native'), platformPath);
  const extensionId = options.extensionId || DEFAULT_CHROME_EXTENSION_ID;
  if (!validateChromeExtensionId(extensionId)) {
    throw new Error('Invalid Chrome extension id: ' + extensionId);
  }
  assertSafeManagedRoot(managedRoot, { platformPath, packageRoot, env, platform });
  assertManagedChildRoot(extensionRoot, managedRoot, platformPath, 'extension');
  assertManagedChildRoot(nativeRoot, managedRoot, platformPath, 'native');

  const parent = path.dirname(path.resolve(extensionRoot));
  fs.mkdirSync(parent, { recursive: true });
  const unique = process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const extensionStage = path.join(parent, '.extension.staging-' + unique);
  const extensionRollback = path.join(parent, '.extension.rollback-' + unique);
  buildManagedExtensionTree({
    packageRoot,
    targetRoot: extensionStage,
    version,
    releaseRef,
    releaseChannel,
    allowedFiles: options.allowedFiles
  });

  const previousExtensionMarker = readManagedMarker(extensionRoot, EXTENSION_MARKER);
  if (fs.existsSync(extensionRoot) && !isManagedMarker(previousExtensionMarker, 'extension')) {
    safeRemove(extensionStage);
    throw new Error('Refusing to replace an unmarked managed extension root: ' + extensionRoot);
  }
  let extensionRollbackCreated = false;
  try {
    if (fs.existsSync(extensionRoot)) {
      fs.renameSync(extensionRoot, extensionRollback);
      extensionRollbackCreated = true;
    }
    fs.renameSync(extensionStage, extensionRoot);
  } catch (error) {
    safeRemove(extensionStage);
    if (extensionRollbackCreated && !fs.existsSync(extensionRoot)) {
      fs.renameSync(extensionRollback, extensionRoot);
    }
    throw error;
  }

  try {
    installManagedNativeVersion({ packageRoot, nativeRoot, version, releaseRef, releaseChannel });
    installManagedNativeRegistration({
      browser,
      env,
      extensionId,
      managedRoot,
      nativeRoot,
      platform
    });
    safeRemove(extensionRollback);
  } catch (error) {
    safeRemove(extensionRoot);
    if (extensionRollbackCreated && fs.existsSync(extensionRollback)) {
      fs.renameSync(extensionRollback, extensionRoot);
    }
    throw error;
  }

  return {
    ok: true,
    action: previousExtensionMarker ? 'updated' : 'installed',
    browser: browser === 'auto' ? 'chrome' : browser,
    extensionId,
    version,
    managedRoot,
    extensionRoot,
    nativeRoot,
    loadUnpackedPath: extensionRoot,
    allowedOrigin: buildAllowedOrigin(extensionId)
  };
}

function buildManagedExtensionTree(options = {}) {
  const packageRoot = path.resolve(options.packageRoot || path.resolve(__dirname, '../..'));
  const targetRoot = path.resolve(String(options.targetRoot || ''));
  const version = String(options.version || readJson(path.join(packageRoot, 'package.json')).version || '');
  const releaseRef = String(options.releaseRef || `v${version}`);
  const releaseChannel = options.releaseChannel || (releaseRef === `v${version}` ? 'stable' : 'prerelease');
  if (!parseSemver(version)) {
    throw new Error('Managed extension version is invalid.');
  }
  if (fs.existsSync(targetRoot) && fs.readdirSync(targetRoot).length) {
    throw new Error('Managed extension target must be empty: ' + targetRoot);
  }
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  const allowedFiles = normalizeAllowedFiles(options.allowedFiles);
  const templatePath = path.join(packageRoot, 'extension/bootstrap/manifest.template.json');
  const manifest = readJson(templatePath);
  manifest.version = version;
  fs.writeFileSync(path.join(targetRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  copyPackageTree(packageRoot, 'extension/bootstrap', targetRoot, 'bootstrap', {
    allowedFiles,
    exclude: new Set(['extension/bootstrap/manifest.template.json'])
  });
  copyPackageTree(packageRoot, 'extension/assets', targetRoot, 'assets', { allowedFiles });
  copyPackageTree(packageRoot, 'extension/src', targetRoot, 'runtime/src', { allowedFiles });
  copyPackageTree(packageRoot, 'extension/styles', targetRoot, 'runtime/styles', { allowedFiles });
  copyPackageTree(packageRoot, 'extension/vendor', targetRoot, 'runtime/vendor', { allowedFiles });
  copyPackageFile(packageRoot, 'extension/runtime-manifest.json', targetRoot, 'runtime/runtime-manifest.json', allowedFiles);
  rewriteManagedRuntimeAssetPaths(targetRoot);
  fs.writeFileSync(path.join(targetRoot, EXTENSION_MARKER), JSON.stringify({
    managedBy: MANAGED_BY,
    kind: 'extension',
    bootstrapProtocol: 1,
    version,
    releaseRef,
    releaseChannel,
    installedAt: new Date().toISOString()
  }, null, 2) + '\n', 'utf8');
  return { targetRoot, version };
}

function installManagedNativeVersion({ packageRoot, nativeRoot, version, releaseRef = `v${version}`, releaseChannel = 'stable' }) {
  const marker = readManagedMarker(nativeRoot, NATIVE_MARKER);
  if (fs.existsSync(nativeRoot) && !isManagedMarker(marker, 'native')) {
    throw new Error('Refusing to replace an unmarked managed native root: ' + nativeRoot);
  }
  fs.mkdirSync(path.join(nativeRoot, 'versions'), { recursive: true });
  fs.mkdirSync(path.join(nativeRoot, 'updates'), { recursive: true });
  fs.mkdirSync(path.join(nativeRoot, 'bootstrap'), { recursive: true });

  const stage = path.join(nativeRoot, 'versions', '.' + version + '.staging-' + process.pid + '-' + Date.now());
  const target = path.join(nativeRoot, 'versions', version);
  for (const entry of buildRuntimeFileManifest({ packageRoot })) {
    copyFile(entry.sourcePath, path.join(stage, entry.relativePath));
  }
  fs.writeFileSync(path.join(stage, '.codex-overleaf-version.json'), JSON.stringify({
    version,
    releaseRef,
    releaseChannel
  }, null, 2) + '\n');
  if (fs.existsSync(target)) {
    safeRemove(target);
  }
  fs.renameSync(stage, target);

  copyFile(
    path.join(packageRoot, 'native-host/src/managedLauncherRuntime.js'),
    path.join(nativeRoot, 'bootstrap/launcher.js')
  );
  const previous = readVersionPointer(nativeRoot, 'active-version');
  if (previous && previous !== version) {
    atomicWrite(path.join(nativeRoot, 'previous-version'), previous + '\n');
  }
  atomicWrite(path.join(nativeRoot, 'active-version'), version + '\n');
  fs.writeFileSync(path.join(nativeRoot, NATIVE_MARKER), JSON.stringify({
    managedBy: MANAGED_BY,
    kind: 'native',
    bootstrapProtocol: 1,
    version,
    installedAt: new Date().toISOString()
  }, null, 2) + '\n', 'utf8');
}

function installManagedNativeRegistration({ browser, env, extensionId, managedRoot, nativeRoot, platform }) {
  const bridgePath = getDefaultBridgePath({ platform, browser, env });
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const bootstrapEntry = platformPath.join(nativeRoot, 'bootstrap', 'launcher.js');
  const bridge = buildLauncher({
    platform,
    nodePath: process.execPath,
    bridgeEntryPath: bootstrapEntry,
    agentPath: bootstrapEntry
  });
  fs.mkdirSync(platformPath.dirname(bridgePath), { recursive: true });
  fs.writeFileSync(bridgePath, bridge, 'utf8');
  if (platform !== 'win32') {
    fs.chmodSync(bridgePath, 0o755);
  }

  const target = getNativeHostRegistrationTarget({ platform, browser, env });
  const manifest = buildHostManifest({ extensionId, extensionIds: [extensionId], bridgePath, platform });
  fs.mkdirSync(platformPath.dirname(target.manifestPath), { recursive: true });
  fs.writeFileSync(target.manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  if (target.kind === 'registry') {
    runRegistry(['add', target.registryKey, '/ve', '/t', 'REG_SZ', '/d', target.manifestPath, '/f']);
  }
  fs.writeFileSync(path.join(managedRoot, '.codex-overleaf-managed.json'), JSON.stringify({
    managedBy: MANAGED_BY,
    extensionId,
    browser: target.browser,
    bridgePath,
    manifestPath: target.manifestPath
  }, null, 2) + '\n');
}

function uninstallManagedDistribution(options = {}) {
  const platform = options.platform || process.platform;
  const browser = options.browser || 'chrome';
  const env = options.env || process.env;
  const managedRoot = path.resolve(options.managedRoot || getDefaultManagedRoot({ platform, env }));
  const extensionRoot = path.resolve(options.extensionRoot || path.join(managedRoot, 'extension'));
  const nativeRoot = path.resolve(options.nativeRoot || path.join(managedRoot, 'native'));
  assertSafeManagedRoot(managedRoot, { packageRoot: path.resolve(__dirname, '../..'), env, platform });
  assertManagedChildRoot(extensionRoot, managedRoot, path, 'extension');
  assertManagedChildRoot(nativeRoot, managedRoot, path, 'native');
  if (fs.existsSync(extensionRoot) && !isManagedMarker(readManagedMarker(extensionRoot, EXTENSION_MARKER), 'extension')) {
    throw new Error('Refusing to remove an unmarked managed extension root.');
  }
  if (fs.existsSync(nativeRoot) && !isManagedMarker(readManagedMarker(nativeRoot, NATIVE_MARKER), 'native')) {
    throw new Error('Refusing to remove an unmarked managed native root.');
  }
  const registration = getNativeHostRegistrationTarget({ platform, browser, env });
  const bridgePath = getDefaultBridgePath({ platform, browser, env });
  if (registration.kind === 'registry') {
    runRegistry(['delete', registration.registryKey, '/f'], { allowMissing: true });
  }
  fs.rmSync(registration.manifestPath, { force: true });
  fs.rmSync(bridgePath, { force: true });
  safeRemove(extensionRoot);
  safeRemove(nativeRoot);
  try {
    if (fs.existsSync(managedRoot) && fs.readdirSync(managedRoot).length === 1 && fs.existsSync(path.join(managedRoot, '.codex-overleaf-managed.json'))) {
      safeRemove(managedRoot);
    }
  } catch (_error) {
    // Managed roots are already removed; leave harmless metadata when another process owns it.
  }
  return { ok: true, managedRoot, extensionRoot, nativeRoot, removed: true };
}

function assertSafeManagedRoot(root, options = {}) {
  const platformPath = options.platformPath || path;
  const resolved = platformPath.resolve(root);
  const home = platformPath.resolve(options.platform === 'win32'
    ? (options.env?.USERPROFILE || os.homedir())
    : (options.env?.HOME || os.homedir()));
  const repo = platformPath.resolve(options.packageRoot || path.resolve(__dirname, '../..'));
  if (resolved === platformPath.parse(resolved).root || resolved === home || resolved === repo) {
    throw new Error('Refusing unsafe managed installation root: ' + root);
  }
  const temp = platformPath.resolve(os.tmpdir());
  const underHome = isSameOrDescendant(resolved, home, platformPath);
  const underTemp = isSameOrDescendant(resolved, temp, platformPath);
  if (!underHome && !underTemp) {
    throw new Error('Managed installation root must stay under the user home or temporary directory: ' + root);
  }
  const trustedBase = underHome ? home : temp;
  if (options.platform !== 'win32' || process.platform === 'win32') {
    assertNoSymlinkAncestors(resolved, trustedBase, platformPath);
  }
  return resolved;
}

function assertManagedChildRoot(target, managedRoot, platformPath, label) {
  const resolvedTarget = platformPath.resolve(target);
  const resolvedRoot = platformPath.resolve(managedRoot);
  if (resolvedTarget === resolvedRoot || !isSameOrDescendant(resolvedTarget, resolvedRoot, platformPath)) {
    throw new Error('Managed ' + label + ' root must stay inside the managed installation root.');
  }
  if (process.platform !== 'win32' || platformPath === path.win32) {
    assertNoSymlinkAncestors(resolvedTarget, resolvedRoot, platformPath);
  }
}

function assertNoSymlinkAncestors(target, stopAt, platformPath) {
  let current = platformPath.resolve(target);
  const boundary = platformPath.resolve(stopAt);
  while (current !== boundary) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error('Managed installation path contains a symlink: ' + current);
    }
    const parent = platformPath.dirname(current);
    if (parent === current || !isSameOrDescendant(parent, boundary, platformPath)) break;
    current = parent;
  }
}

function isSameOrDescendant(target, parent, platformPath) {
  if (target === parent) return true;
  const relative = platformPath.relative(parent, target);
  return Boolean(relative) && !relative.startsWith('..') && !platformPath.isAbsolute(relative);
}

function copyPackageTree(packageRoot, sourceRelative, targetRoot, targetRelative, options = {}) {
  const source = path.join(packageRoot, sourceRelative);
  for (const dirent of fs.readdirSync(source, { withFileTypes: true })) {
    const childSourceRelative = path.posix.join(sourceRelative.replace(/\\/g, '/'), dirent.name);
    const childTargetRelative = path.posix.join(targetRelative.replace(/\\/g, '/'), dirent.name);
    if (dirent.isSymbolicLink()) {
      throw new Error('Managed package source cannot contain symlinks: ' + childSourceRelative);
    }
    if (dirent.isDirectory()) {
      copyPackageTree(packageRoot, childSourceRelative, targetRoot, childTargetRelative, options);
    } else if (dirent.isFile() && !options.exclude?.has(childSourceRelative)) {
      copyPackageFile(packageRoot, childSourceRelative, targetRoot, childTargetRelative, options.allowedFiles);
    }
  }
}

function copyPackageFile(packageRoot, sourceRelative, targetRoot, targetRelative, allowedFiles) {
  if (allowedFiles && !allowedFiles.has(sourceRelative)) {
    return;
  }
  copyFile(path.join(packageRoot, sourceRelative), path.join(targetRoot, targetRelative));
}

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  fs.chmodSync(target, fs.statSync(source).mode & 0o777);
}

function rewriteManagedRuntimeAssetPaths(targetRoot) {
  const cssPath = path.join(targetRoot, 'runtime/vendor/katex/katex.min.css');
  if (!fs.existsSync(cssPath)) {
    return;
  }
  const sourcePrefix = 'chrome-extension://__MSG_@@extension_id__/vendor/katex/fonts/';
  const managedPrefix = 'chrome-extension://__MSG_@@extension_id__/runtime/vendor/katex/fonts/';
  const css = fs.readFileSync(cssPath, 'utf8');
  if (!css.includes(sourcePrefix)) {
    throw new Error('Managed KaTeX CSS does not contain the expected source font prefix.');
  }
  const rewritten = css.split(sourcePrefix).join(managedPrefix);
  if (rewritten.includes(sourcePrefix)) {
    throw new Error('Managed KaTeX CSS retained a source-only font path.');
  }
  fs.writeFileSync(cssPath, rewritten, 'utf8');
}

function normalizeAllowedFiles(value) {
  if (!value) return null;
  return value instanceof Set ? value : new Set(value);
}

function readManagedMarker(root, markerName) {
  try {
    return readJson(path.join(root, markerName));
  } catch (_error) {
    return null;
  }
}

function isManagedMarker(marker, kind) {
  return marker?.managedBy === MANAGED_BY && marker?.kind === kind && marker?.bootstrapProtocol === 1;
}

function readVersionPointer(nativeRoot, name) {
  try {
    const value = fs.readFileSync(path.join(nativeRoot, name), 'utf8').trim();
    return parseSemver(value) ? value : '';
  } catch (_error) {
    return '';
  }
}

function atomicWrite(target, content) {
  const temp = target + '.tmp-' + process.pid + '-' + Date.now();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.renameSync(temp, target);
}

function runRegistry(args, options = {}) {
  const result = spawnSync(process.env.CODEX_OVERLEAF_REG_EXE || 'reg.exe', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowMissing) {
    throw new Error(result.stderr || result.stdout || 'Windows registry command failed.');
  }
}

function resolveForPlatform(value, platformPath) {
  return platformPath.isAbsolute(value) ? value : platformPath.resolve(value);
}

function safeRemove(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

module.exports = {
  EXTENSION_MARKER,
  MANAGED_BY,
  NATIVE_MARKER,
  assertSafeManagedRoot,
  buildManagedExtensionTree,
  installManagedDistribution,
  uninstallManagedDistribution
};
