const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const packageJson = require('../package.json');
const {
  DEFAULT_CHROME_EXTENSION_ID,
  HOST_NAME,
  buildAllowedOrigin,
  buildHostManifest,
  getChromeNativeHostManifestPath,
  getNativeHostManifestPath,
  getWindowsRegistryMetadata,
  validateChromeExtensionId,
  validateExtensionId
} = require('../native-host/src/manifest');
const {
  getDefaultBridgePath,
  getDefaultRuntimeRoot,
  getNativeHostRegistrationTarget
} = require('../native-host/src/nativeHostPlatform');
const extensionManifest = require('../extension/manifest.json');

test('release metadata is prepared for v2.1.1', () => {
  assert.equal(packageJson.version, '2.1.1');
  assert.equal(extensionManifest.version, packageJson.version);
});

test('release docs carry exact v2.1.1 badge and changelog heading', () => {
  const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
  const changelog = fs.readFileSync(path.join(__dirname, '../CHANGELOG.md'), 'utf8');
  const escapedVersion = packageJson.version.replace(/\./g, '\\.');

  assert.match(readme, new RegExp(`version-${escapedVersion}-blue`));
  assert.doesNotMatch(readme, /version-1\.0\.0-blue/);
  assert.match(changelog, new RegExp(`^## v${escapedVersion} - 2026-07-18$`, 'm'));
  assert.doesNotMatch(changelog, new RegExp(`^## \\[${escapedVersion}\\] - 2026-07-18$`, 'm'));
  assert.doesNotMatch(changelog, /^## v1\.0\.0 - 2026-05-07[\s\S]*version-1\.1\.0-blue/m);
});

test('loads line reference shared module immediately after project files', () => {
  const contentScript = extensionManifest.content_scripts[0];
  const js = contentScript.js;
  const projectFilesIndex = js.indexOf('src/shared/projectFiles.js');
  const lineReferencesIndex = js.indexOf('src/shared/lineReferences.js');
  const sessionStateIndex = js.indexOf('src/shared/sessionState.js');
  const contentRuntimeIndex = js.indexOf('src/content/contentRuntime.js');

  assert.notEqual(projectFilesIndex, -1);
  assert.notEqual(lineReferencesIndex, -1);
  assert.notEqual(sessionStateIndex, -1);
  assert.notEqual(contentRuntimeIndex, -1);
  assert.equal(lineReferencesIndex, projectFilesIndex + 1);
  assert.equal(lineReferencesIndex < sessionStateIndex, true);
  assert.equal(lineReferencesIndex < contentRuntimeIndex, true);
});

test('loads storage run-action helpers immediately before storageDb', () => {
  const js = extensionManifest.content_scripts[0].js;
  const runActionsIndex = js.indexOf('src/shared/storageRunActions.js');
  const storageDbIndex = js.indexOf('src/shared/storageDb.js');

  assert.notEqual(runActionsIndex, -1);
  assert.notEqual(storageDbIndex, -1);
  assert.equal(storageDbIndex, runActionsIndex + 1);
});

test('pins the Native Messaging host name', () => {
  assert.equal(HOST_NAME, 'com.codex.overleaf');
});

test('validates Chrome extension ids with the exact lowercase a-p alphabet', () => {
  assert.equal(validateExtensionId('abcdefghijklmnopabcdefghijklmnop'), true);
  assert.equal(validateExtensionId(DEFAULT_CHROME_EXTENSION_ID), true);
  assert.equal(validateExtensionId('ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP'), false);
  assert.equal(validateExtensionId('short'), false);
  assert.equal(validateExtensionId('abcdefghijklmnopabcdefghijklmnopq'), false);
  assert.equal(validateExtensionId('abcdefghijklmnopabcdefghijklmno1'), false);
  assert.equal(validateExtensionId('abcdefghijklmnopabcdefghijklmnoq'), false);
  assert.equal(validateExtensionId(' abcdefghijklmnopabcdefghijklmno'), false);
  assert.equal(validateChromeExtensionId, validateExtensionId);
});

test('builds allowed Chrome extension origins exactly', () => {
  assert.equal(
    buildAllowedOrigin('abcdefghijklmnopabcdefghijklmnop'),
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/'
  );
  assert.throws(
    () => buildAllowedOrigin('abcdefghijklmnopabcdefghijklmnoq'),
    /Invalid Chrome extension id/
  );
});

test('builds a Chrome Native Messaging host manifest locked to one extension origin', () => {
  const manifest = buildHostManifest({
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    bridgePath: '/Applications/CodexOverleaf/codex-overleaf-bridge'
  });

  assert.deepEqual(manifest, {
    name: 'com.codex.overleaf',
    description: 'Codex Overleaf local bridge',
    path: '/Applications/CodexOverleaf/codex-overleaf-bridge',
    type: 'stdio',
    allowed_origins: ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/']
  });
});

test('builds a host manifest with an injectable Windows absolute bridge path', () => {
  const manifest = buildHostManifest({
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    bridgePath: 'C:\\Users\\Alice\\AppData\\Local\\CodexOverleaf\\codex-overleaf-bridge.cmd',
    platform: 'win32'
  });

  assert.equal(
    manifest.path,
    'C:\\Users\\Alice\\AppData\\Local\\CodexOverleaf\\codex-overleaf-bridge.cmd'
  );
});

test('returns the user-level macOS Chrome native host manifest path', t => {
  if (process.platform === 'win32') {
    t.skip('default macOS helper requires a POSIX home path; injected macOS paths are covered separately');
    return;
  }

  assert.equal(
    getChromeNativeHostManifestPath(),
    path.posix.join(os.homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.codex.overleaf.json')
  );
});

test('returns the macOS Chrome native host manifest path from injected environment', () => {
  assert.equal(
    getChromeNativeHostManifestPath({ env: { HOME: '/Users/injected' } }),
    '/Users/injected/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.codex.overleaf.json'
  );
});

test('returns exact macOS Chrome and Chromium native host manifest paths', () => {
  assert.equal(
    getNativeHostManifestPath({ platform: 'darwin', homeDir: '/Users/alice', browser: 'chrome' }),
    '/Users/alice/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.codex.overleaf.json'
  );
  assert.equal(
    getNativeHostManifestPath({ platform: 'darwin', homeDir: '/Users/alice', browser: 'chromium' }),
    '/Users/alice/Library/Application Support/Chromium/NativeMessagingHosts/com.codex.overleaf.json'
  );
});

test('returns exact Linux Chrome and Chromium native host manifest paths', () => {
  assert.equal(
    getNativeHostManifestPath({ platform: 'linux', homeDir: '/home/alice', browser: 'chrome' }),
    '/home/alice/.config/google-chrome/NativeMessagingHosts/com.codex.overleaf.json'
  );
  assert.equal(
    getNativeHostManifestPath({ platform: 'linux', homeDir: '/home/alice', browser: 'chromium' }),
    '/home/alice/.config/chromium/NativeMessagingHosts/com.codex.overleaf.json'
  );
});

test('returns native host paths from an injected HOME environment', () => {
  assert.equal(
    getNativeHostManifestPath({ platform: 'linux', env: { HOME: '/home/env-user' } }),
    '/home/env-user/.config/google-chrome/NativeMessagingHosts/com.codex.overleaf.json'
  );
});

test('accepts auto browser by resolving it to Chrome manifest paths', () => {
  assert.equal(
    getNativeHostManifestPath({ platform: 'linux', homeDir: '/home/alice', browser: 'auto' }),
    '/home/alice/.config/google-chrome/NativeMessagingHosts/com.codex.overleaf.json'
  );
});

test('returns exact Windows Chrome native host manifest path and quoted registry metadata', () => {
  const metadata = getWindowsRegistryMetadata({
    browser: 'chrome',
    homeDir: 'C:\\Users\\Alice',
    env: {
      LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local'
    }
  });

  assert.equal(metadata.kind, 'registry');
  assert.equal(metadata.root, 'HKCU');
  assert.equal(
    metadata.registryKey,
    'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.codex.overleaf'
  );
  assert.equal(
    metadata.manifestPath,
    'C:\\Users\\Alice\\AppData\\Local\\codex-overleaf\\native-messaging-hosts\\com.codex.overleaf.json'
  );
  assert.equal(path.win32.isAbsolute(metadata.manifestPath), true);
  assert.equal(
    metadata.quotedRegistryKey,
    '"HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.codex.overleaf"'
  );
  assert.equal(
    metadata.quotedManifestPath,
    '"C:\\Users\\Alice\\AppData\\Local\\codex-overleaf\\native-messaging-hosts\\com.codex.overleaf.json"'
  );
  assert.equal(
    metadata.addCommand,
    'reg.exe add "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.codex.overleaf" /ve /t REG_SZ /d "C:\\Users\\Alice\\AppData\\Local\\codex-overleaf\\native-messaging-hosts\\com.codex.overleaf.json" /f'
  );
  assert.equal(
    metadata.deleteCommand,
    'reg.exe delete "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.codex.overleaf" /f'
  );
});

test('actual native host registration target uses pinned Windows manifest path', () => {
  const target = getNativeHostRegistrationTarget({
    platform: 'win32',
    browser: 'chrome',
    env: {
      LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local'
    }
  });

  assert.equal(target.kind, 'registry');
  assert.equal(target.browser, 'chrome');
  assert.equal(
    target.registryKey,
    'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.codex.overleaf'
  );
  assert.equal(
    target.manifestPath,
    'C:\\Users\\Alice\\AppData\\Local\\codex-overleaf\\native-messaging-hosts\\com.codex.overleaf.json'
  );
});

test('actual native host registration target normalizes auto browser to Chrome', () => {
  assert.deepEqual(
    getNativeHostRegistrationTarget({
      platform: 'linux',
      browser: 'auto',
      homeDir: '/home/alice'
    }),
    {
      kind: 'file',
      browser: 'chrome',
      manifestPath: '/home/alice/.config/google-chrome/NativeMessagingHosts/com.codex.overleaf.json'
    }
  );

  const target = getNativeHostRegistrationTarget({
    platform: 'win32',
    browser: 'auto',
    env: {
      LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local'
    }
  });
  assert.equal(target.browser, 'chrome');
  assert.equal(
    target.registryKey,
    'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.codex.overleaf'
  );
  assert.equal(
    target.manifestPath,
    'C:\\Users\\Alice\\AppData\\Local\\codex-overleaf\\native-messaging-hosts\\com.codex.overleaf.json'
  );
});

test('uses Windows USERPROFILE before HOME when local app data is not injected', () => {
  assert.equal(
    getDefaultRuntimeRoot({
      platform: 'win32',
      env: {
        HOME: 'C:\\msys64\\home\\alice',
        USERPROFILE: 'C:\\Users\\Alice'
      }
    }),
    'C:\\Users\\Alice\\AppData\\Local\\CodexOverleaf\\native-host-runtime'
  );
});

test('returns injectable default runtime and bridge paths without mutating process platform', () => {
  assert.equal(
    getDefaultRuntimeRoot({ platform: 'linux', homeDir: '/home/alice' }),
    '/home/alice/.codex-overleaf/native-host-runtime'
  );
  assert.equal(
    getDefaultBridgePath({ platform: 'linux', homeDir: '/home/alice' }),
    '/home/alice/.codex-overleaf/codex-overleaf-bridge'
  );
});

test('rejects unsupported native host platforms before registration', () => {
  assert.throws(
    () => getNativeHostManifestPath({ platform: 'freebsd', homeDir: '/home/alice' }),
    /Unsupported native host platform: freebsd/
  );
});

test('rejects invalid extension ids when building the manifest', () => {
  assert.throws(() => buildHostManifest({ extensionId: 'bad', bridgePath: '/tmp/bridge' }), /Invalid Chrome extension id/);
});

test('content script loads shared i18n before the panel script', () => {
  const scripts = extensionManifest.content_scripts[0].js;
  assert.ok(scripts.indexOf('src/shared/i18n.js') > -1);
  assert.ok(scripts.indexOf('src/shared/i18n.js') < scripts.indexOf('src/contentScript.js'));
});

test('content script loads shared model catalog before the panel script', () => {
  const scripts = extensionManifest.content_scripts[0].js;
  assert.ok(scripts.indexOf('src/shared/models.js') > -1);
  assert.ok(scripts.indexOf('src/shared/models.js') < scripts.indexOf('src/contentScript.js'));
});

test('content script loads shared compatibility before native and panel scripts', () => {
  const scripts = extensionManifest.content_scripts[0].js;
  const compatibilityIndex = scripts.indexOf('src/shared/compatibility.js');

  assert.ok(compatibilityIndex > -1);
  assert.ok(compatibilityIndex < scripts.indexOf('src/content/nativeChannel.js'));
  assert.ok(compatibilityIndex < scripts.indexOf('src/contentScript.js'));
});

test('content script loads governance, sensitive scan, and audit helpers before the panel script', () => {
  const scripts = extensionManifest.content_scripts[0].js;
  for (const helper of [
    'src/shared/governanceRules.js',
    'src/shared/sensitiveScan.js',
    'src/shared/auditRecords.js'
  ]) {
    assert.ok(scripts.indexOf(helper) > -1, `${helper} should be loaded`);
    assert.ok(scripts.indexOf(helper) < scripts.indexOf('src/contentScript.js'), `${helper} should load before contentScript.js`);
  }
});

test('page bridge injection can load shared helpers from web accessible resources', () => {
  const resources = extensionManifest.web_accessible_resources[0].resources;
  for (const helper of [
    'src/shared/compatibility.js',
    'src/shared/governanceRules.js',
    'src/shared/sensitiveScan.js',
    'src/shared/auditRecords.js'
  ]) {
    assert.ok(resources.includes(helper), `${helper} should be web accessible`);
  }
});

test('page bridge capability guard loads before the page bridge from web accessible resources', () => {
  const resources = extensionManifest.web_accessible_resources[0].resources;
  const capabilityIndex = resources.indexOf('src/page/pageBridgeCapability.js');
  const pageBridgeIndex = resources.indexOf('src/pageBridge.js');

  assert.ok(capabilityIndex > -1, 'page bridge capability guard should be web accessible');
  assert.ok(pageBridgeIndex > -1, 'page bridge should be web accessible');
  assert.ok(capabilityIndex < pageBridgeIndex, 'page bridge capability guard should load before pageBridge.js');
});

test('carved settings, session-menu, and save-state modules load before their consumers', () => {
  const scripts = extensionManifest.content_scripts[0].js;
  const resources = extensionManifest.web_accessible_resources[0].resources;
  assert.ok(scripts.indexOf('src/content/projectSettingsCoordinator.js') < scripts.indexOf('src/content/contentRuntime.js'));
  assert.ok(scripts.indexOf('src/content/sessionMenuView.js') < scripts.indexOf('src/content/sessionManager.js'));
  assert.ok(resources.includes('src/page/saveState.js'));
  assert.ok(resources.indexOf('src/page/saveState.js') < resources.indexOf('src/pageBridge.js'));
});

test('manifest loads and exposes read-only OT page dependencies', () => {
  const scripts = extensionManifest.content_scripts[0].js;
  const resources = extensionManifest.web_accessible_resources[0].resources;

  assert.ok(scripts.indexOf('src/shared/otText.js') > -1);
  assert.ok(scripts.indexOf('src/shared/otText.js') < scripts.indexOf('src/contentScript.js'));
  assert.ok(resources.includes('src/shared/otText.js'));
  assert.ok(resources.includes('src/page/overleafRealtimeObserver.js'));
});

test('content script loads mirror health helper before the panel script', () => {
  const scripts = extensionManifest.content_scripts[0].js;
  assert.ok(scripts.indexOf('src/content/mirrorHealth.js') > -1);
  assert.ok(scripts.indexOf('src/content/mirrorHealth.js') < scripts.indexOf('src/contentScript.js'));
});

test('content script loads OT warm mirror controller after lower-level helpers and before the panel script', () => {
  const scripts = extensionManifest.content_scripts[0].js;
  const controllerIndex = scripts.indexOf('src/content/otWarmMirrorController.js');
  assert.ok(controllerIndex > -1);
  for (const helper of [
    'src/content/nativeChannel.js',
    'src/content/writebackController.js',
    'src/content/runController.js',
    'src/content/mirrorHealth.js'
  ]) {
    assert.ok(scripts.indexOf(helper) < controllerIndex);
  }
  assert.ok(controllerIndex < scripts.indexOf('src/contentScript.js'));
});

test('content script loads review hunks helper after writeback and before run and panel scripts', () => {
  const scripts = extensionManifest.content_scripts[0].js;
  const reviewHunksIndex = scripts.indexOf('src/content/reviewHunks.js');

  assert.ok(reviewHunksIndex > -1);
  assert.ok(scripts.indexOf('src/content/writebackController.js') < reviewHunksIndex);
  assert.ok(reviewHunksIndex < scripts.indexOf('src/content/runController.js'));
  assert.ok(reviewHunksIndex < scripts.indexOf('src/contentScript.js'));
});
