(function initCodexOverleafCompatibility(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafCompatibility = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function compatibilityFactory() {
  'use strict';

  const EXTENSION_PROTOCOL_VERSION = 2;
  const SUPPORTED_NATIVE_PROTOCOL = Object.freeze({ min: 1, max: 2 });
  const MIN_NATIVE_VERSION = '1.0.0';
  const MIN_COMPATIBLE_NATIVE_VERSION = '1.0.0';
  const MIN_COMPATIBLE_EXTENSION_VERSION = '1.0.0';
  const BUILD_TARGET_VERSION = '2.3.2';
  const DEFAULT_CHROME_EXTENSION_ID = 'illdpneeeopfffmiepaejglgmhpmdhdc';
  const REQUIRED_CAPABILITIES = Object.freeze([
    'bridgePing',
    'mirrorSync',
    'mirrorPatchFiles',
    'mirrorStatus',
    'codexRun',
    'codexCancel',
    'codexSteer',
    'codexModels',
    'historyClearPlugin',
    'localSkills',
    'mirrorSensitiveScan',
    'providerProfiles',
    'assetTransfer',
    'threadFork'
  ]);
  const UPDATE_AVAILABLE_CAPABILITIES = Object.freeze([
    'bridgePing',
    'mirrorStatus',
    'codexModels',
    'codexCancel',
    'localSkills'
  ]);
  const COMPATIBILITY_CLASSIFICATIONS = Object.freeze({
    compatible: 'compatible',
    updateAvailable: 'update-available',
    incompatible: 'incompatible'
  });
  const UPDATE_AVAILABLE_METHODS = new Set([
    'bridge.ping',
    'mirror.status',
    'codex.models',
    'codex.cancel',
    'skills.list'
  ]);
  const INCOMPATIBLE_ALLOWED_METHODS = new Set([
    'bridge.ping'
  ]);

  function buildBridgePingParams(metadata = {}) {
    const extensionVersion = resolveMetadataVersion(metadata);
    return {
      extensionVersion: extensionVersion.normalized,
      extensionProtocolVersion: EXTENSION_PROTOCOL_VERSION,
      supportedNativeProtocol: { ...SUPPORTED_NATIVE_PROTOCOL },
      requiredCapabilities: REQUIRED_CAPABILITIES.slice()
    };
  }

  function evaluateNativeCompatibility(response, metadata = {}) {
    const native = unwrapNativeResponse(response);
    if (!native) {
      return compatibilityResult('native_missing', response, metadata, 'incompatible');
    }

    const analysis = analyzeNativeCompatibility(native, metadata);
    return compatibilityResult(analysis.status, native, metadata, analysis.classification);
  }

  function classifyNativeCompatibility(pingResult, extensionVersion) {
    const metadata = extensionVersion === undefined
      ? {}
      : typeof extensionVersion === 'object'
      ? extensionVersion
      : { version: extensionVersion };
    const native = unwrapNativeResponse(pingResult);
    if (!native) {
      return 'incompatible';
    }
    return analyzeNativeCompatibility(native, metadata).classification;
  }

  function buildInstallCommand(version = BUILD_TARGET_VERSION, platform, extensionId) {
    const normalized = normalizeReleaseVersion(version) || BUILD_TARGET_VERSION;
    const allowedExtensionId = normalizeInstallExtensionId(extensionId);
    const extensionIdArg = allowedExtensionId && allowedExtensionId !== DEFAULT_CHROME_EXTENSION_ID
      ? ` --extension-id ${allowedExtensionId}`
      : '';

    return `npm exec --yes codex-overleaf-link@${normalized} -- install-native${extensionIdArg}`;
  }

  function buildReleaseUrl(version = BUILD_TARGET_VERSION) {
    const normalized = normalizeReleaseVersion(version) || BUILD_TARGET_VERSION;
    return `https://github.com/Ghqqqq/codex-overleaf-link/releases/tag/v${normalized}`;
  }

  function isMethodAllowed(method, classification) {
    const normalizedClassification = normalizeClassification(classification);
    if (method === 'bridge.ping') {
      return true;
    }
    if (normalizedClassification === 'compatible') {
      return true;
    }
    if (normalizedClassification === 'update-available') {
      return UPDATE_AVAILABLE_METHODS.has(method);
    }
    if (normalizedClassification === 'incompatible') {
      return INCOMPATIBLE_ALLOWED_METHODS.has(method);
    }
    return false;
  }

  function isNativeMethodAllowed(method, compatibilityStatus) {
    return isMethodAllowed(method, getClassification(compatibilityStatus));
  }

  function compatibilityResult(status, native, metadata = {}, classification = 'incompatible') {
    const extensionVersion = resolveMetadataVersion(metadata);
    const nativeVersion = native && typeof native === 'object' ? native.version : undefined;
    const platform = native && typeof native === 'object' ? native.platform : undefined;
    const updateCommand = buildInstallCommand(BUILD_TARGET_VERSION, platform, metadata.extensionId);
    const updateAvailable = isOlderReleaseVersion(nativeVersion, BUILD_TARGET_VERSION);
    return {
      status,
      classification,
      native,
      nativeVersion,
      currentNativeVersion: nativeVersion,
      extensionVersion: extensionVersion.normalized,
      minimumNativeVersion: MIN_COMPATIBLE_NATIVE_VERSION,
      requiredVersion: MIN_COMPATIBLE_NATIVE_VERSION,
      recommendedVersion: BUILD_TARGET_VERSION,
      updateAvailable,
      installCommand: updateCommand,
      updateCommand,
      releaseUrl: buildReleaseUrl(BUILD_TARGET_VERSION),
      platform: normalizePlatform(platform) || platform || undefined,
      missingCapabilities: getMissingCapabilities(native?.capabilities, REQUIRED_CAPABILITIES),
      missingUpdateCapabilities: getMissingCapabilities(native?.capabilities, UPDATE_AVAILABLE_CAPABILITIES)
    };
  }

  function analyzeNativeCompatibility(native, metadata = {}) {
    const extensionVersion = resolveMetadataVersion(metadata);
    const nativeVersion = parseSemver(native.version);
    const minimumNativeVersion = parseSemver(MIN_COMPATIBLE_NATIVE_VERSION);

    if (!native.version || !nativeVersion) {
      return { status: 'native_too_old', classification: 'incompatible' };
    }

    if (!reportsSupportedProtocol(native)) {
      return { status: 'protocol_unsupported', classification: 'incompatible' };
    }

    if (!native.capabilities || typeof native.capabilities !== 'object') {
      return { status: 'native_too_old', classification: 'incompatible' };
    }

    const minExtensionVersion = native.minExtensionVersion ? parseSemver(native.minExtensionVersion) : null;
    if (
      native.minExtensionVersion &&
      (!minExtensionVersion || !extensionVersion.valid || compareSemver(extensionVersion.parsed, minExtensionVersion) < 0)
    ) {
      return { status: 'extension_too_old', classification: 'incompatible' };
    }

    if (native.environment?.codex?.ok === false) {
      return { status: 'native_unhealthy', classification: 'incompatible' };
    }

    if (compareSemver(nativeVersion, minimumNativeVersion) >= 0) {
      return hasCapabilities(native.capabilities, REQUIRED_CAPABILITIES)
        ? { status: 'ok', classification: 'compatible' }
        : { status: 'native_too_old', classification: 'incompatible' };
    }

    return hasCapabilities(native.capabilities, UPDATE_AVAILABLE_CAPABILITIES)
      ? { status: 'native_too_old', classification: 'update-available' }
      : { status: 'native_too_old', classification: 'incompatible' };
  }

  function unwrapNativeResponse(response) {
    if (!response || response.ok === false) {
      return null;
    }
    const native = response.ok === true ? response.result : response;
    return native && typeof native === 'object' ? native : null;
  }

  function getClassification(compatibilityStatus) {
    if (typeof compatibilityStatus === 'string') {
      return normalizeClassification(compatibilityStatus) || mapLegacyStatusToClassification(compatibilityStatus);
    }
    if (!compatibilityStatus || typeof compatibilityStatus !== 'object') {
      return 'incompatible';
    }
    return normalizeClassification(compatibilityStatus.classification) ||
      normalizeClassification(compatibilityStatus.status) ||
      mapLegacyStatusToClassification(compatibilityStatus.status);
  }

  function mapLegacyStatusToClassification(status) {
    if (status === 'ok') {
      return 'compatible';
    }
    return 'incompatible';
  }

  function normalizeClassification(classification) {
    if (
      classification === 'compatible' ||
      classification === 'update-available' ||
      classification === 'incompatible'
    ) {
      return classification;
    }
    return '';
  }

  function hasCapabilities(capabilities, requiredCapabilities) {
    return requiredCapabilities.every(capability => capabilities[capability] === true);
  }

  function getMissingCapabilities(capabilities, requiredCapabilities) {
    if (!capabilities || typeof capabilities !== 'object') {
      return requiredCapabilities.slice();
    }
    return requiredCapabilities.filter(capability => capabilities[capability] !== true);
  }

  function reportsSupportedProtocol(native) {
    if (!Number.isInteger(native.protocolVersion) ||
        native.protocolVersion < SUPPORTED_NATIVE_PROTOCOL.min ||
        native.protocolVersion > SUPPORTED_NATIVE_PROTOCOL.max) {
      return false;
    }
    if (native.supportedProtocol === undefined || native.supportedProtocol === null) {
      return true;
    }
    return protocolRangesOverlap(SUPPORTED_NATIVE_PROTOCOL, native.supportedProtocol);
  }

  function isProtocolRange(range) {
    return range &&
      Number.isInteger(range.min) &&
      Number.isInteger(range.max) &&
      range.min <= range.max;
  }

  function protocolRangesOverlap(left, right) {
    return isProtocolRange(left) &&
      isProtocolRange(right) &&
      left.min <= right.max &&
      right.min <= left.max;
  }

  function resolveMetadataVersion(metadata = {}) {
    const hasVersion = metadata &&
      typeof metadata === 'object' &&
      Object.prototype.hasOwnProperty.call(metadata, 'version');
    if (!hasVersion) {
      return {
        normalized: BUILD_TARGET_VERSION,
        parsed: parseSemver(BUILD_TARGET_VERSION),
        valid: true
      };
    }

    const normalized = normalizeReleaseVersion(metadata.version);
    if (!normalized) {
      return {
        normalized: BUILD_TARGET_VERSION,
        parsed: parseSemver(BUILD_TARGET_VERSION),
        valid: false
      };
    }

    return {
      normalized,
      parsed: parseSemver(normalized),
      valid: true
    };
  }

  function normalizeReleaseVersion(version) {
    if (typeof version !== 'string') {
      return '';
    }
    const match = /^v?(\d+\.\d+\.\d+)$/.exec(version);
    return match ? match[1] : '';
  }

  function isOlderReleaseVersion(version, targetVersion) {
    const parsedVersion = parseSemver(version);
    const parsedTarget = parseSemver(targetVersion);
    return Boolean(parsedVersion && parsedTarget && compareSemver(parsedVersion, parsedTarget) < 0);
  }

  function normalizePlatform(platform) {
    const normalized = String(platform || '').toLowerCase();
    if (!normalized) {
      return '';
    }
    if (normalized === 'win32' || normalized === 'windows' || normalized.startsWith('win')) {
      return 'windows';
    }
    if (normalized === 'darwin' || normalized === 'mac' || normalized === 'macos' || normalized.includes('mac')) {
      return 'darwin';
    }
    if (normalized === 'linux' || normalized.includes('linux')) {
      return 'linux';
    }
    return '';
  }

  function normalizeInstallExtensionId(extensionId) {
    return typeof extensionId === 'string' && /^[a-p]{32}$/.test(extensionId)
      ? extensionId
      : '';
  }

  function detectCurrentPlatform() {
    if (typeof navigator === 'undefined') {
      return '';
    }
    return normalizePlatform(navigator.userAgentData?.platform || navigator.platform || '');
  }

  function parseSemver(version) {
    const normalized = normalizeReleaseVersion(version);
    if (!normalized) {
      return null;
    }
    const [major, minor, patch] = normalized.split('.').map(Number);
    return {
      major,
      minor,
      patch
    };
  }

  function compareSemver(left, right) {
    for (const key of ['major', 'minor', 'patch']) {
      if (left[key] !== right[key]) {
        return left[key] < right[key] ? -1 : 1;
      }
    }
    return 0;
  }

  return {
    EXTENSION_PROTOCOL_VERSION,
    SUPPORTED_NATIVE_PROTOCOL,
    MIN_NATIVE_VERSION,
    MIN_COMPATIBLE_NATIVE_VERSION,
    MIN_COMPATIBLE_EXTENSION_VERSION,
    REQUIRED_CAPABILITIES,
    UPDATE_AVAILABLE_CAPABILITIES,
    BUILD_TARGET_VERSION,
    COMPATIBILITY_CLASSIFICATIONS,
    buildBridgePingParams,
    evaluateNativeCompatibility,
    classifyNativeCompatibility,
    buildInstallCommand,
    buildReleaseUrl,
    isMethodAllowed,
    isNativeMethodAllowed
  };
});
