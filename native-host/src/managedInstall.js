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
const { queryWindowsNativeHostRegistration } = require('./nativeHostRegistration');
const { buildRuntimeFileManifest } = require('./runtimeInstaller');
const { BOOTSTRAP_PROTOCOL, parseSemver, updateError } = require('./updateTrust');
const { createInstallRestorePoint } = require('./managedInstallRecovery');
const { settleReinstalledUpdate } = require('./updateManager');

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
  try {
    buildManagedExtensionTree({
      packageRoot,
      targetRoot: extensionStage,
      version,
      releaseRef,
      releaseChannel,
      allowedFiles: options.allowedFiles,
      installIdentity: { managedRoot, browser: browser === 'auto' ? 'chrome' : browser, extensionId, platform }
    });
  } catch (error) {
    safeRemove(extensionStage);
    throw error;
  }

  let previousExtensionMarker = readManagedMarker(extensionRoot, EXTENSION_MARKER);
  if (fs.existsSync(extensionRoot) && !isManagedMarker(previousExtensionMarker, 'extension')) {
    safeRemove(extensionStage);
    throw new Error('Refusing to replace an unmarked managed extension root: ' + extensionRoot);
  }
  let extensionRollbackCreated = false;
  let restorePoint;
  let previousTransaction;
  const registration = getNativeHostRegistrationTarget({ platform, browser, env });
  const bridgePath = getDefaultBridgePath({ platform, browser, env });
  let previousRegistration = null;
  let registrationAttempted = false;
  try {
    const nativeMarker = readManagedMarker(nativeRoot, NATIVE_MARKER);
    if (fs.existsSync(nativeRoot) && !isManagedMarker(nativeMarker, 'native')) {
      throw new Error('Refusing to replace an unmarked managed native root: ' + nativeRoot);
    }
    restorePoint = createInstallRestorePoint({ nativeRoot, version, files: [
      path.join(nativeRoot, 'active-version'), path.join(nativeRoot, 'previous-version'),
      path.join(nativeRoot, NATIVE_MARKER), path.join(nativeRoot, 'bootstrap', 'launcher.js'),
      path.join(nativeRoot, 'updates', 'transaction.json'), path.join(nativeRoot, 'updates', 'authorization.json'),
      path.join(managedRoot, '.codex-overleaf-managed.json'), bridgePath, registration.manifestPath
    ] });
    previousExtensionMarker = readManagedMarker(extensionRoot, EXTENSION_MARKER);
    if (fs.existsSync(extensionRoot) && !isManagedMarker(previousExtensionMarker, 'extension')) {
      throw new Error('Refusing to replace an unmarked managed extension root: ' + extensionRoot);
    }
    previousRegistration = registration.kind === 'registry'
      ? queryWindowsNativeHostRegistration(registration, { env }) : null;
    previousTransaction = readManagedMarker(path.join(nativeRoot, 'updates'), 'transaction.json');
    if (fs.existsSync(extensionRoot)) {
      fs.renameSync(extensionRoot, extensionRollback);
      extensionRollbackCreated = true;
    }
    fs.renameSync(extensionStage, extensionRoot);
    installManagedNativeVersion({ packageRoot, nativeRoot, version, releaseRef, releaseChannel,
      allowUnmarkedRoot: !restorePoint.nativeExisted });
    installManagedNativeRegistration({
      browser,
      env,
      extensionId,
      managedRoot,
      nativeRoot,
      platform,
      onRegistryMutation: () => { registrationAttempted = true; }
    });
    settleReinstalledUpdate({ managed: true, nativeRoot, extensionRoot,
      updatesRoot: path.join(nativeRoot, 'updates'), env }, version, previousTransaction);
  } catch (error) {
    const failures = [];
    try {
      safeRemove(extensionStage);
      if (extensionRollbackCreated && fs.existsSync(extensionRollback)) {
        safeRemove(extensionRoot);
        fs.renameSync(extensionRollback, extensionRoot);
      } else if (!previousExtensionMarker && restorePoint) safeRemove(extensionRoot);
    } catch (failure) { failures.push(failure); }
    if (restorePoint) {
      try { restorePoint.restore(); } catch (failure) { failures.push(failure); }
      if (registrationAttempted && registration.kind === 'registry') {
        try {
          if (!previousRegistration?.registeredManifestPath) throw new Error('Previous browser registration could not be verified.');
          runRegistry(['add', registration.registryKey, '/ve', '/t', 'REG_SZ', '/d', previousRegistration.registeredManifestPath, '/f']);
        } catch (failure) { failures.push(failure); }
      }
      try { failures.length ? restorePoint.release() : restorePoint.finish(); }
      catch (failure) { failures.push(failure); }
    }
    if (failures.length) throw updateError('managed_install_restore_failed',
      'Managed installation failed and the previous installation could not be fully restored.', { cause: error });
    throw error;
  }
  // The installed pair is committed. Cleanup errors must not trigger a second
  // rollback after some of its retained files have already been removed.
  const warnings = [];
  try { safeRemove(extensionRollback); } catch (_) { warnings.push('Previous extension cleanup is incomplete.'); }
  try { restorePoint.finish(); } catch (_) { warnings.push('Previous Native installation cleanup is incomplete.'); }

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
    allowedOrigin: buildAllowedOrigin(extensionId),
    ...(warnings.length ? { warning: warnings.join(' ') } : {})
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
  assertManagedRuntimeManifestFiles(targetRoot);
  fs.writeFileSync(path.join(targetRoot, EXTENSION_MARKER), JSON.stringify({
    managedBy: MANAGED_BY,
    kind: 'extension',
    ...(options.installIdentity ? { installIdentity: options.installIdentity } : {}),
    bootstrapProtocol: BOOTSTRAP_PROTOCOL,
    version,
    releaseRef,
    releaseChannel,
    installedAt: new Date().toISOString()
  }, null, 2) + '\n', 'utf8');
  return { targetRoot, version };
}

function installManagedNativeVersion({ packageRoot, nativeRoot, version, releaseRef = `v${version}`, releaseChannel = 'stable', allowUnmarkedRoot = false }) {
  const marker = readManagedMarker(nativeRoot, NATIVE_MARKER);
  if (fs.existsSync(nativeRoot) && !isManagedMarker(marker, 'native') && !allowUnmarkedRoot) {
    throw new Error('Refusing to replace an unmarked managed native root: ' + nativeRoot);
  }
  fs.mkdirSync(path.join(nativeRoot, 'versions'), { recursive: true });
  fs.mkdirSync(path.join(nativeRoot, 'updates'), { recursive: true });
  fs.mkdirSync(path.join(nativeRoot, 'bootstrap'), { recursive: true });

  const stage = path.join(nativeRoot, 'versions', '.' + version + '.staging-' + process.pid + '-' + Date.now());
  const target = path.join(nativeRoot, 'versions', version);
  try {
    for (const entry of buildRuntimeFileManifest({ packageRoot })) {
      copyFile(entry.sourcePath, path.join(stage, entry.relativePath));
    }
    fs.writeFileSync(path.join(stage, '.codex-overleaf-version.json'), JSON.stringify({
      version,
      releaseRef,
      releaseChannel
    }, null, 2) + '\n');
    if (fs.existsSync(target)) safeRemove(target);
    fs.renameSync(stage, target);
  } catch (error) {
    safeRemove(stage);
    throw error;
  }

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
    bootstrapProtocol: BOOTSTRAP_PROTOCOL,
    version,
    installedAt: new Date().toISOString()
  }, null, 2) + '\n', 'utf8');
}

function installManagedNativeRegistration({ browser, env, extensionId, managedRoot, nativeRoot, platform, onRegistryMutation }) {
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
    onRegistryMutation?.();
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
  const bridgeOwned = () => isBridgeForManagedRoot(bridgePath, nativeRoot, platform);
  const manifestOwned = () => {
    try {
      const manifest = readJson(registration.manifestPath);
      return bridgeOwned() && manifest.name === 'com.codex.overleaf' && manifest.path === bridgePath;
    } catch (_) { return false; }
  };
  if (registration.kind === 'registry' && manifestOwned()
    && queryWindowsNativeHostRegistration(registration, { env }).verified) {
    runRegistry(['delete', registration.registryKey, '/f'], { allowMissing: true });
  }
  if (manifestOwned()) fs.rmSync(registration.manifestPath, { force: true });
  if (bridgeOwned()) fs.rmSync(bridgePath, { force: true });
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

// Older installs lack ownership metadata. Compare the existing launcher's
// exact target argument and agent assignment; the Node executable may change.
function isBridgeForManagedRoot(bridgePath, nativeRoot, platform) {
  try {
    const platformPath = platform === 'win32' ? path.win32 : path.posix;
    const entry = platformPath.join(nativeRoot, 'bootstrap', 'launcher.js');
    const expected = buildLauncher({ platform, nodePath: '__node__', bridgeEntryPath: entry, agentPath: entry }).split(/\r?\n/);
    const actual = fs.readFileSync(bridgePath, 'utf8').split(/\r?\n/);
    const assignment = expected.find(line => line.includes('CODEX_OVERLEAF_AGENT_ARGS_JSON='));
    const launch = expected.find(line => platform === 'win32' ? line.startsWith('"__node__" ') : line.startsWith('exec "__node__" '));
    const target = launch.slice(launch.indexOf('"__node__"') + '"__node__"'.length);
    const invocation = platform === 'win32' ? /^"(?:[^"]|"")*"/ : /^exec "(?:[^"\\]|\\.)+"/;
    return actual.includes(assignment) && actual.some(line => {
      const first = line.match(invocation); return first && line.slice(first[0].length) === target;
    });
  } catch (_) { return false; }
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
  return marker?.managedBy === MANAGED_BY &&
    marker?.kind === kind &&
    Number.isInteger(marker?.bootstrapProtocol) &&
    marker.bootstrapProtocol >= 1 && marker.bootstrapProtocol <= BOOTSTRAP_PROTOCOL;
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

function assertManagedRuntimeManifestFiles(targetRoot) {
  const runtimeRoot = path.join(targetRoot, 'runtime');
  const runtimeManifest = readJson(path.join(runtimeRoot, 'runtime-manifest.json'));
  const runtimeFiles = [
    ...(Array.isArray(runtimeManifest.js) ? runtimeManifest.js : []),
    ...(Array.isArray(runtimeManifest.css) ? runtimeManifest.css : [])
  ];
  const missing = [];

  for (const relativePath of runtimeFiles) {
    if (
      typeof relativePath !== 'string'
      || relativePath.length === 0
      || path.isAbsolute(relativePath)
      || relativePath.split(/[\\/]+/).includes('..')
    ) {
      throw new Error('Managed runtime manifest contains an unsafe path: ' + String(relativePath));
    }
    const filePath = path.resolve(runtimeRoot, relativePath);
    const relativeToRuntime = path.relative(runtimeRoot, filePath);
    if (
      relativeToRuntime.startsWith('..')
      || path.isAbsolute(relativeToRuntime)
      || !fs.existsSync(filePath)
      || !fs.statSync(filePath).isFile()
    ) {
      missing.push(relativePath);
    }
  }

  if (missing.length > 0) {
    throw new Error('Managed runtime is incomplete; missing file(s): ' + missing.join(', '));
  }
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
  assertManagedRuntimeManifestFiles,
  assertSafeManagedRoot,
  buildManagedExtensionTree,
  installManagedDistribution,
  uninstallManagedDistribution
};
