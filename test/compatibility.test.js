const assert = require('node:assert/strict');
const test = require('node:test');

const packageJson = require('../package.json');
const extensionManifest = require('../extension/manifest.json');
const { handleRequest } = require('../native-host/src/taskRunner');
const compatibility = require('../extension/src/shared/compatibility');

const REQUIRED_CAPABILITIES = compatibility.REQUIRED_CAPABILITIES;
const UPDATE_AVAILABLE_CAPABILITIES = compatibility.UPDATE_AVAILABLE_CAPABILITIES;

function capabilityMap(capabilities = REQUIRED_CAPABILITIES) {
  return Object.fromEntries(capabilities.map(capability => [capability, true]));
}

function nativeResponse(overrides = {}) {
  return {
    ok: true,
    result: {
      host: 'com.codex.overleaf',
      platform: 'darwin',
      version: compatibility.BUILD_TARGET_VERSION,
      protocolVersion: 2,
      supportedProtocol: { min: 1, max: 2 },
      capabilities: capabilityMap(),
      minExtensionVersion: compatibility.MIN_COMPATIBLE_EXTENSION_VERSION,
      environment: {
        codex: { ok: true }
      },
      ...overrides
    }
  };
}

function canonicalInstallCommand(platform) {
  return compatibility.buildInstallCommand(compatibility.BUILD_TARGET_VERSION, platform);
}

test('release version metadata is aligned for v2.1.4 while the RC handshake uses protocol 2', async () => {
  assert.equal(packageJson.version, '2.1.4');
  assert.equal(extensionManifest.version, packageJson.version);
  assert.equal(compatibility.BUILD_TARGET_VERSION, packageJson.version);
  assert.equal(compatibility.MIN_COMPATIBLE_NATIVE_VERSION, '1.0.0');
  assert.equal(compatibility.MIN_COMPATIBLE_EXTENSION_VERSION, '1.0.0');
  assert.equal(compatibility.EXTENSION_PROTOCOL_VERSION, 2);
  assert.deepEqual(compatibility.SUPPORTED_NATIVE_PROTOCOL, { min: 1, max: 2 });

  const response = await handleRequest({ id: 'metadata', method: 'bridge.ping', params: {} }, {});

  assert.equal(response.ok, true);
  assert.equal(response.result.version, packageJson.version);
  assert.equal(response.result.minExtensionVersion, compatibility.MIN_COMPATIBLE_EXTENSION_VERSION);
  assert.equal(response.result.protocolVersion, 2);
  assert.deepEqual(response.result.supportedProtocol, { min: 1, max: 2 });
});

test('buildBridgePingParams returns protocol 2 metadata with protocol 1 compatibility', () => {
  assert.equal(compatibility.BUILD_TARGET_VERSION, '2.1.4');
  assert.equal(compatibility.EXTENSION_PROTOCOL_VERSION, 2);
  assert.deepEqual(compatibility.buildBridgePingParams({ version: '2.1.4' }), {
    extensionVersion: '2.1.4',
    extensionProtocolVersion: 2,
    supportedNativeProtocol: { min: 1, max: 2 },
    requiredCapabilities: REQUIRED_CAPABILITIES
  });
});

test('classifyNativeCompatibility returns compatible for protocol 2 hosts with all required capabilities', () => {
  const result = compatibility.evaluateNativeCompatibility(nativeResponse(), { version: '2.1.4' });

  assert.equal(compatibility.classifyNativeCompatibility(nativeResponse(), '2.1.4'), 'compatible');
  assert.equal(result.status, 'ok');
  assert.equal(result.classification, 'compatible');
  assert.equal(result.requiredVersion, '1.0.0');
  assert.equal(result.recommendedVersion, '2.1.4');
  assert.equal(result.updateAvailable, false);
  assert.equal(result.updateCommand, canonicalInstallCommand('darwin'));
  assert.equal(result.releaseUrl, 'https://github.com/Ghqqqq/codex-overleaf-link/releases/tag/v2.1.4');
});

test('classifyNativeCompatibility keeps v1.0 protocol 1 hosts with required capabilities operational under v2.1', () => {
  const response = nativeResponse({
    version: '1.0.0',
    minExtensionVersion: '1.0.0',
    protocolVersion: 1,
    supportedProtocol: { min: 1, max: 1 }
  });
  const result = compatibility.evaluateNativeCompatibility(response, { version: '2.1.4' });

  assert.equal(compatibility.classifyNativeCompatibility(response, '2.1.4'), 'compatible');
  assert.equal(result.status, 'ok');
  assert.equal(result.classification, 'compatible');
  assert.equal(result.minimumNativeVersion, '1.0.0');
  assert.equal(result.requiredVersion, '1.0.0');
  assert.equal(result.recommendedVersion, '2.1.4');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.updateCommand, compatibility.buildInstallCommand('2.1.4', 'darwin'));
  assert.equal(compatibility.isNativeMethodAllowed('codex.run', result), true);
});

test('classifyNativeCompatibility returns update-available for older protocol 1 hosts with the allowed-method capability subset', () => {
  const response = nativeResponse({
    version: '0.9.5',
    capabilities: capabilityMap(UPDATE_AVAILABLE_CAPABILITIES)
  });
  const result = compatibility.evaluateNativeCompatibility(response, { version: '1.3.0' });

  assert.equal(compatibility.classifyNativeCompatibility(response.result, '1.3.0'), 'update-available');
  assert.equal(result.status, 'native_too_old');
  assert.equal(result.classification, 'update-available');
  assert.deepEqual(result.missingUpdateCapabilities, []);
});

test('classifyNativeCompatibility returns incompatible when an older native host lacks any update-available capability', () => {
  const response = nativeResponse({
    version: '0.9.5',
    capabilities: capabilityMap(['bridgePing', 'mirrorStatus', 'codexModels', 'localSkills'])
  });
  const result = compatibility.evaluateNativeCompatibility(response, { version: '1.3.0' });

  assert.equal(result.status, 'native_too_old');
  assert.equal(result.classification, 'incompatible');
  assert.deepEqual(result.missingUpdateCapabilities, ['codexCancel']);
});

test('classifyNativeCompatibility returns incompatible when a target-version native host lacks any required capability', () => {
  const response = nativeResponse({
    capabilities: {
      ...capabilityMap(),
      mirrorPatchFiles: false
    }
  });
  const result = compatibility.evaluateNativeCompatibility(response, { version: '1.3.0' });

  assert.equal(result.status, 'native_too_old');
  assert.equal(result.classification, 'incompatible');
  assert.deepEqual(result.missingCapabilities, ['mirrorPatchFiles']);
});

test('classifyNativeCompatibility returns incompatible for missing native, unsupported protocol, extension mismatch, or unhealthy local Codex', () => {
  assert.equal(compatibility.classifyNativeCompatibility(null, '1.3.0'), 'incompatible');
  assert.equal(
    compatibility.evaluateNativeCompatibility({ ok: false, error: { code: 'native_disconnected' } }).classification,
    'incompatible'
  );
  assert.equal(
    compatibility.evaluateNativeCompatibility(nativeResponse({ protocolVersion: 3, supportedProtocol: { min: 3, max: 3 } })).status,
    'protocol_unsupported'
  );
  assert.equal(
    compatibility.evaluateNativeCompatibility(nativeResponse({ minExtensionVersion: '1.3.1' }), { version: '1.3.0' }).status,
    'extension_too_old'
  );
  assert.equal(
    compatibility.evaluateNativeCompatibility(nativeResponse({ environment: { codex: { ok: false } } })).status,
    'native_unhealthy'
  );
});

test('buildInstallCommand returns release-pinned npm native update commands', () => {
  assert.equal(
    compatibility.buildInstallCommand('1.3.0', 'darwin'),
    'npm exec --yes codex-overleaf-link@1.3.0 -- install-native'
  );
  assert.equal(
    compatibility.buildInstallCommand('v1.3.0', 'linux'),
    'npm exec --yes codex-overleaf-link@1.3.0 -- install-native'
  );
  assert.equal(
    compatibility.buildInstallCommand('1.3.0', 'win32'),
    'npm exec --yes codex-overleaf-link@1.3.0 -- install-native'
  );
});


test('buildInstallCommand omits bundled id but embeds a custom extension id', () => {
  const bundledExtensionId = 'illdpneeeopfffmiepaejglgmhpmdhdc';
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';

  assert.equal(
    compatibility.buildInstallCommand('1.3.0', 'darwin', bundledExtensionId),
    'npm exec --yes codex-overleaf-link@1.3.0 -- install-native'
  );
  assert.equal(
    compatibility.buildInstallCommand('1.3.0', 'darwin', extensionId),
    `npm exec --yes codex-overleaf-link@1.3.0 -- install-native --extension-id ${extensionId}`
  );
  assert.equal(
    compatibility.buildInstallCommand('1.3.0', 'win32', extensionId),
    `npm exec --yes codex-overleaf-link@1.3.0 -- install-native --extension-id ${extensionId}`
  );
});

test('buildInstallCommand falls back to the build target for unsafe versions', () => {
  for (const version of [
    '1.3.0; touch /tmp/pwned',
    '1.3.0 && touch /tmp/pwned',
    ' 1.3.0',
    '1.3.0 ',
    '1.3.0/bad',
    'v1.3.0$(id)',
    '',
    null
  ]) {
    assert.equal(compatibility.buildInstallCommand(version, 'darwin'), canonicalInstallCommand('darwin'));
  }
});

test('isMethodAllowed applies the v1.3 native compatibility method matrix', () => {
  for (const method of [
    'bridge.ping',
    'mirror.status',
    'codex.models',
    'codex.cancel',
    'mirror.sync',
    'mirror.patchFiles',
    'mirror.scanSensitive',
    'codex.run',
    'task.run',
    'task.confirm',
    'codex.history.clearPlugin',
    'skills.list',
    'skills.install',
    'skills.remove'
  ]) {
    assert.equal(compatibility.isMethodAllowed(method, 'compatible'), true, method);
  }

  for (const method of ['bridge.ping', 'mirror.status', 'codex.models', 'codex.cancel', 'skills.list']) {
    assert.equal(compatibility.isMethodAllowed(method, 'update-available'), true, method);
  }

  for (const method of [
    'mirror.sync',
    'mirror.patchFiles',
    'mirror.scanSensitive',
    'codex.run',
    'task.run',
    'task.confirm',
    'codex.history.clearPlugin',
    'skills.install',
    'skills.remove'
  ]) {
    assert.equal(compatibility.isMethodAllowed(method, 'update-available'), false, method);
  }

  assert.equal(compatibility.isMethodAllowed('bridge.ping', 'incompatible'), true);
  for (const method of ['mirror.status', 'codex.models', 'codex.cancel', 'skills.list']) {
    assert.equal(compatibility.isMethodAllowed(method, 'incompatible'), false, method);
  }
});

test('isNativeMethodAllowed keeps the legacy ok status as compatible but treats old unclassified statuses as incompatible', () => {
  assert.equal(compatibility.isNativeMethodAllowed('codex.run', { status: 'ok' }), true);
  assert.equal(compatibility.isNativeMethodAllowed('skills.list', { classification: 'update-available' }), true);
  assert.equal(compatibility.isNativeMethodAllowed('skills.list', { status: 'native_too_old' }), false);
});
