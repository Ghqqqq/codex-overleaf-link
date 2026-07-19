'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { HOST_NAME, validateChromeExtensionId } = require('./manifest');
const {
  getHomeDir,
  getNativeHostPlatform,
  getNativeHostRegistrationTarget
} = require('./nativeHostPlatform');
const { decodeFrames, encodeMessage } = require('./nativeMessaging');
const {
  buildBridgePingParams,
  evaluateNativeCompatibility
} = require('../../extension/src/shared/compatibility');
const { version: PACKAGE_VERSION } = require('../../package.json');

const DEFAULT_DOCTOR_TIMEOUT_MS = 3000;
const DOCTOR_PING_ID = 'doctor-ping';
const MAX_DOCTOR_STDERR_BYTES = 64 * 1024;
const MAX_DOCTOR_STDOUT_BYTES = 2 * 1024 * 1024;

async function runDoctor(options = {}) {
  const platform = getNativeHostPlatform(options);
  const browser = normalizeBrowser(options.browser || 'auto');
  const env = options.env || process.env;
  const homeDir = options.homeDir || getHomeDir({ ...options, env, platform });
  const pathOptions = {
    revealPaths: Boolean(options.revealPaths),
    homeDir,
    platform
  };
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const registrationTarget = getNativeHostRegistrationTarget({
    ...options,
    browser,
    env,
    homeDir,
    platform
  });
  const runtimeRoot = options.runtimeRoot
    ? normalizeDiagnosticPath(resolveRuntimeRoot(options.runtimeRoot), pathOptions)
    : undefined;
  const body = {
    ok: false,
    status: 'unknown',
    browser: registrationTarget.browser,
    platform,
    registration: sanitizeRegistrationTarget(registrationTarget, pathOptions),
    manifest: {
      path: normalizeDiagnosticPath(registrationTarget.manifestPath, pathOptions),
      exists: false,
      valid: false,
      errors: []
    },
    bridge: null,
    codex: null,
    ping: {
      attempted: false
    },
    compatibility: null,
    diagnostics: {
      browser: registrationTarget.browser,
      registrationKind: registrationTarget.kind,
      manifestPath: normalizeDiagnosticPath(registrationTarget.manifestPath, pathOptions)
    }
  };

  if (runtimeRoot) {
    body.runtimeRoot = runtimeRoot;
    body.diagnostics.runtimeRoot = runtimeRoot;
  }

  const manifestResult = readAndValidateManifest(registrationTarget.manifestPath, {
    platform,
    pathOptions
  });
  Object.assign(body.manifest, manifestResult.manifest);

  if (!manifestResult.manifest.exists || !manifestResult.manifest.valid) {
    return finalizeDoctorResult(body);
  }

  const bridgePath = manifestResult.bridgePath;
  body.bridge = validateBridgePath(bridgePath, { platform, pathOptions });
  body.diagnostics.bridgePath = body.bridge.path;
  body.diagnostics.allowedOrigins = body.manifest.allowedOrigins || [];

  if (!body.bridge.valid || !body.bridge.exists) {
    return finalizeDoctorResult(body);
  }

  const pingResult = await pingNativeBridge(bridgePath, {
    id: DOCTOR_PING_ID,
    method: 'bridge.ping',
    params: buildBridgePingParams({ version: PACKAGE_VERSION })
  }, {
    env,
    pathOptions,
    platform,
    timeoutMs
  });
  const rawPingResponse = pingResult.rawResponse;
  delete pingResult.rawResponse;
  body.ping = pingResult;

  if (body.ping.ok) {
    body.codex = sanitizeCodexRuntime(
      rawPingResponse?.result?.environment?.codex,
      pathOptions
    );
    body.compatibility = sanitizeCompatibility(
      evaluateNativeCompatibility(rawPingResponse, { version: PACKAGE_VERSION })
    );
  }

  return finalizeDoctorResult(body);
}

function classifyDoctorResult(body = {}) {
  if (!body.manifest || body.manifest.exists === false) {
    return {
      exitCode: 2,
      ok: false,
      status: 'missing_install'
    };
  }

  if (body.manifest.valid === false) {
    return {
      exitCode: 2,
      ok: false,
      status: 'invalid_manifest'
    };
  }

  if (!body.bridge || body.bridge.valid === false) {
    return {
      exitCode: 2,
      ok: false,
      status: 'invalid_bridge'
    };
  }

  if (body.bridge.exists === false) {
    return {
      exitCode: 2,
      ok: false,
      status: 'missing_bridge'
    };
  }

  if (!body.ping || body.ping.ok !== true) {
    return {
      exitCode: 3,
      ok: false,
      status: 'execution_failure'
    };
  }

  if (body.compatibility?.classification === 'compatible') {
    return {
      exitCode: 0,
      ok: true,
      status: 'ok'
    };
  }

  if (body.compatibility?.classification === 'update-available') {
    return {
      exitCode: 3,
      ok: false,
      status: 'native_stale'
    };
  }

  return {
    exitCode: 3,
    ok: false,
    status: 'native_incompatible'
  };
}

function formatDoctorHuman(body = {}) {
  const lines = [
    'Native host doctor',
    `Status: ${body.status || 'unknown'}`,
    `OK: ${body.ok === true ? 'yes' : 'no'}`,
    `Browser: ${body.browser || 'unknown'}`,
    `Manifest: ${body.manifest?.path || 'unknown'}`
  ];

  if (body.registration?.kind) {
    lines.push(`Registration: ${body.registration.kind}`);
  }
  if (body.registration?.registryKey) {
    lines.push(`Registry key: ${body.registration.registryKey}`);
  }
  if (body.bridge?.path) {
    lines.push(`Bridge: ${body.bridge.path}`);
  }
  if (body.runtimeRoot) {
    lines.push(`Runtime root: ${body.runtimeRoot}`);
  }
  if (Array.isArray(body.manifest?.allowedOrigins) && body.manifest.allowedOrigins.length) {
    lines.push(`Allowed origins: ${body.manifest.allowedOrigins.join(', ')}`);
  }
  if (body.compatibility) {
    lines.push(`Native compatibility: ${body.compatibility.classification || 'unknown'}`);
    lines.push(`Native version: ${body.compatibility.nativeVersion || 'unknown'}`);
  }
  if (body.codex) {
    lines.push(`Codex status: ${body.codex.ok ? 'available' : 'not found'}`);
    lines.push(`Codex path: ${body.codex.path || 'unknown'}`);
    lines.push(`Codex version: ${body.codex.version || 'unknown'}`);
    lines.push(`Codex source: ${body.codex.source || 'unknown'}`);
    if (body.codex.multipleInstallations) {
      lines.push('Warning: multiple Codex installations detected.');
      lines.push('Codex candidates:');
      for (const candidate of body.codex.candidates) {
        lines.push(`  ${candidate.selected ? '*' : '-'} ${candidate.path || 'unknown'} (${candidate.version || 'unknown'}, ${candidate.source || 'path'})`);
      }
    }
  }
  if (body.ping?.ok === false) {
    lines.push(`Ping: failed (${body.ping.error || 'unknown error'})`);
  } else if (body.ping?.ok === true) {
    lines.push('Ping: ok');
  } else {
    lines.push('Ping: not run');
  }
  if (Array.isArray(body.manifest?.errors) && body.manifest.errors.length) {
    lines.push(`Manifest errors: ${body.manifest.errors.join('; ')}`);
  }
  if (Array.isArray(body.bridge?.errors) && body.bridge.errors.length) {
    lines.push(`Bridge errors: ${body.bridge.errors.join('; ')}`);
  }

  return `${lines.join('\n')}\n`;
}

function normalizeDiagnosticPath(targetPath, options = {}) {
  if (!targetPath) {
    return '';
  }
  const value = String(targetPath);
  if (options.revealPaths) {
    return value;
  }

  const platform = options.platform || process.platform;
  const platformPath = getPlatformPath(platform);
  const homeDir = options.homeDir || getHomeFromEnv(options.env || process.env, platform);
  const normalizedValue = platformPath.normalize(value);
  const normalizedHome = homeDir ? platformPath.normalize(String(homeDir)) : '';
  const comparisonValue = platform === 'win32' ? normalizedValue.toLowerCase() : normalizedValue;
  const comparisonHome = platform === 'win32' ? normalizedHome.toLowerCase() : normalizedHome;

  if (comparisonHome && comparisonValue === comparisonHome) {
    return '~';
  }

  if (comparisonHome && comparisonValue.startsWith(`${comparisonHome}${platformPath.sep}`)) {
    return `~${platformPath.sep}${normalizedValue.slice(normalizedHome.length + 1)}`;
  }

  if (isAbsolutePathForPlatform(value, platform)) {
    return `${platformPath.sep}<absolute-path>${platformPath.sep}${platformPath.basename(value)}`;
  }

  return value;
}

function sanitizeCodexRuntime(codex, pathOptions) {
  if (!codex || typeof codex !== 'object') return null;
  const normalizeCodexPath = value => {
    const normalized = normalizeDiagnosticPath(value, pathOptions);
    return normalized.includes('<absolute-path>') ? String(value || '') : normalized;
  };
  return {
    ok: codex.ok === true,
    path: normalizeCodexPath(codex.path || ''),
    version: String(codex.version || ''),
    source: String(codex.source || ''),
    selectedBy: String(codex.selectedBy || ''),
    multipleInstallations: codex.multipleInstallations === true,
    candidates: Array.isArray(codex.candidates) ? codex.candidates.map(candidate => ({
      path: normalizeCodexPath(candidate?.path || ''),
      version: String(candidate?.version || ''),
      source: String(candidate?.source || ''),
      selected: candidate?.selected === true
    })) : []
  };
}

function finalizeDoctorResult(body) {
  const classification = classifyDoctorResult(body);
  body.ok = classification.ok;
  body.status = classification.status;
  return {
    exitCode: classification.exitCode,
    body
  };
}

function readAndValidateManifest(manifestPath, options) {
  const manifest = {
    path: normalizeDiagnosticPath(manifestPath, options.pathOptions),
    exists: false,
    valid: false,
    errors: []
  };

  let raw;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
    manifest.exists = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      manifest.errors.push(`Unable to read manifest: ${sanitizePathInMessage(error.message, manifestPath, options.pathOptions)}`);
    }
    return { manifest, bridgePath: '' };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    manifest.errors.push(`Invalid manifest JSON: ${error.message}`);
    return { manifest, bridgePath: '' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    manifest.errors.push('Manifest must be a JSON object');
    return { manifest, bridgePath: '' };
  }

  if (parsed.name !== HOST_NAME) {
    manifest.errors.push(`Manifest name must be ${HOST_NAME}`);
  }
  if (parsed.type !== 'stdio') {
    manifest.errors.push('Manifest type must be stdio');
  }
  if (typeof parsed.path !== 'string' || !parsed.path) {
    manifest.errors.push('Manifest path must be a non-empty string');
  } else if (!isAbsolutePathForPlatform(parsed.path, options.platform)) {
    manifest.errors.push('Manifest path must be absolute');
  } else {
    manifest.bridgePath = normalizeDiagnosticPath(parsed.path, options.pathOptions);
  }

  try {
    manifest.allowedOrigins = normalizeAllowedOrigins(parsed.allowed_origins);
  } catch (error) {
    manifest.errors.push(error.message);
  }

  manifest.valid = manifest.errors.length === 0;
  return {
    manifest,
    bridgePath: typeof parsed.path === 'string' ? parsed.path : ''
  };
}

function normalizeAllowedOrigins(origins) {
  if (!Array.isArray(origins) || origins.length === 0) {
    throw new Error('Manifest allowed_origins must be a non-empty array');
  }

  const seen = new Set();
  const normalized = [];
  for (const origin of origins) {
    const value = typeof origin === 'string' ? origin.trim() : '';
    const match = /^chrome-extension:\/\/([a-p]{32})\/?$/.exec(value);
    if (!match || !validateChromeExtensionId(match[1])) {
      throw new Error(`Invalid allowed origin: ${String(origin)}`);
    }
    const clean = `chrome-extension://${match[1]}/`;
    if (!seen.has(clean)) {
      seen.add(clean);
      normalized.push(clean);
    }
  }

  if (!normalized.length) {
    throw new Error('Manifest allowed_origins must contain at least one valid Chrome extension origin');
  }

  return normalized;
}

function validateBridgePath(bridgePath, options) {
  const bridge = {
    path: normalizeDiagnosticPath(bridgePath, options.pathOptions),
    exists: false,
    valid: true,
    errors: []
  };

  if (!bridgePath || typeof bridgePath !== 'string') {
    bridge.valid = false;
    bridge.errors.push('Bridge path is missing');
    return bridge;
  }

  if (!isAbsolutePathForPlatform(bridgePath, options.platform)) {
    bridge.valid = false;
    bridge.errors.push('Bridge path must be absolute');
    return bridge;
  }

  let stat;
  try {
    stat = fs.statSync(bridgePath);
    bridge.exists = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      bridge.valid = false;
      bridge.errors.push(`Unable to inspect bridge: ${sanitizePathInMessage(error.message, bridgePath, options.pathOptions)}`);
    }
    return bridge;
  }

  if (!stat.isFile()) {
    bridge.valid = false;
    bridge.errors.push('Bridge path must point to a file');
  }

  return bridge;
}

function pingNativeBridge(bridgePath, message, options = {}) {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const env = options.env || process.env;
  const spawnInvocation = buildDoctorBridgeSpawnInvocation(bridgePath, {
    env,
    platform: options.platform
  });

  return new Promise(resolve => {
    let child;
    let settled = false;
    let timedOut = false;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let forceKillTimer = null;

    function settle(result) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      resolve({
        attempted: true,
        ...result
      });
    }

    function killChild(signal) {
      try {
        if (child && !child.killed) {
          child.kill(signal);
        }
      } catch {
        // Best effort; the close/error handlers will settle the ping.
      }
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killChild('SIGTERM');
      forceKillTimer = setTimeout(() => {
        killChild('SIGKILL');
        settle({
          ok: false,
          timedOut: true,
          error: `Bridge ping timed out after ${timeoutMs}ms`
        });
      }, 500);
      if (typeof forceKillTimer.unref === 'function') {
        forceKillTimer.unref();
      }
    }, timeoutMs);
    if (typeof timeoutTimer.unref === 'function') {
      timeoutTimer.unref();
    }

    try {
      child = spawn(spawnInvocation.command, spawnInvocation.args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsVerbatimArguments: spawnInvocation.windowsVerbatimArguments === true,
        windowsHide: true
      });
    } catch (error) {
      settle({
        ok: false,
        error: `Unable to start bridge: ${sanitizePathInMessage(error.message, bridgePath, options.pathOptions)}`,
        errorCode: error.code || undefined
      });
      return;
    }

    child.on('error', error => {
      settle({
        ok: false,
        error: `Unable to start bridge: ${sanitizePathInMessage(error.message, bridgePath, options.pathOptions)}`,
        errorCode: error.code || undefined
      });
    });

    child.stdout.on('data', chunk => {
      stdout = appendBoundedBuffer(stdout, chunk, MAX_DOCTOR_STDOUT_BYTES);
    });

    child.stderr.on('data', chunk => {
      stderr = appendBoundedBuffer(stderr, chunk, MAX_DOCTOR_STDERR_BYTES);
    });

    child.stdin.on('error', () => {
      // The close/error handlers produce the deterministic doctor result.
    });

    child.on('close', (exitCode, signal) => {
      if (settled) {
        return;
      }
      if (timedOut) {
        settle({
          ok: false,
          timedOut: true,
          exitCode,
          signal: signal || undefined,
          error: `Bridge ping timed out after ${timeoutMs}ms`
        });
        return;
      }

      if ((exitCode !== 0 && exitCode !== null) || signal) {
        settle({
          ok: false,
          exitCode,
          signal: signal || undefined,
          error: summarizeBridgeFailure(exitCode, signal, stderr)
        });
        return;
      }

      let decoded;
      try {
        decoded = decodeFrames(stdout);
      } catch (error) {
        settle({
          ok: false,
          exitCode,
          signal: signal || undefined,
          error: `Bridge returned an invalid native message: ${error.message}`
        });
        return;
      }

      if (decoded.remainder.length) {
        settle({
          ok: false,
          exitCode,
          signal: signal || undefined,
          error: 'Bridge returned trailing partial native output'
        });
        return;
      }

      const response = decoded.messages.find(item => item?.id === message.id);
      if (response) {
        settle({
          ok: true,
          exitCode,
          signal: signal || undefined,
          rawResponse: response,
          response: sanitizePingResponse(response, options.pathOptions)
        });
        return;
      }

      settle({
        ok: false,
        exitCode,
        signal: signal || undefined,
        error: `Bridge did not return a response for ${message.id}`
      });
    });

    try {
      child.stdin.end(encodeMessage(message));
    } catch (error) {
      killChild('SIGTERM');
      settle({
        ok: false,
        error: `Unable to write bridge ping: ${sanitizePathInMessage(error.message, bridgePath, options.pathOptions)}`
      });
    }
  });
}

function buildDoctorBridgeSpawnInvocation(bridgePath, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(String(bridgePath))) {
    return {
      command: bridgePath,
      args: []
    };
  }

  return {
    command: options.env?.ComSpec || options.env?.COMSPEC || 'cmd.exe',
    args: ['/d', '/c', quoteWindowsCommandPath(bridgePath)],
    windowsVerbatimArguments: true
  };
}

function quoteWindowsCommandPath(targetPath) {
  return `"${String(targetPath).replace(/"/g, '""')}"`;
}

function sanitizePingResponse(response, pathOptions) {
  if (!response || typeof response !== 'object') {
    return response;
  }
  if (response.ok !== true) {
    return {
      id: response.id,
      ok: response.ok,
      error: sanitizeNativeError(response.error, pathOptions)
    };
  }
  const native = response.result && typeof response.result === 'object' ? response.result : {};
  return {
    id: response.id,
    ok: true,
    result: sanitizeNativePingResult(native)
  };
}

function sanitizeNativePingResult(native) {
  return {
    host: native.host,
    platform: native.platform,
    protocolVersion: native.protocolVersion,
    supportedProtocol: native.supportedProtocol,
    capabilities: native.capabilities && typeof native.capabilities === 'object'
      ? Object.keys(native.capabilities).filter(capability => native.capabilities[capability] === true).sort()
      : [],
    minExtensionVersion: native.minExtensionVersion,
    version: native.version,
    environment: {
      codexOk: native.environment?.codex?.ok === true,
      latexOk: native.environment?.latex?.ok === true
    }
  };
}

function sanitizeNativeError(error, pathOptions) {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  return {
    code: typeof error.code === 'string' ? error.code : undefined,
    message: typeof error.message === 'string'
      ? sanitizeDiagnosticMessage(error.message, pathOptions)
      : undefined
  };
}

function sanitizeCompatibility(compatibility) {
  if (!compatibility || typeof compatibility !== 'object') {
    return null;
  }
  return {
    status: compatibility.status,
    classification: compatibility.classification,
    nativeVersion: compatibility.nativeVersion,
    currentNativeVersion: compatibility.currentNativeVersion,
    extensionVersion: compatibility.extensionVersion,
    requiredVersion: compatibility.requiredVersion,
    platform: compatibility.platform,
    missingCapabilities: Array.isArray(compatibility.missingCapabilities)
      ? compatibility.missingCapabilities.slice()
      : [],
    missingUpdateCapabilities: Array.isArray(compatibility.missingUpdateCapabilities)
      ? compatibility.missingUpdateCapabilities.slice()
      : [],
    releaseUrl: compatibility.releaseUrl,
    updateCommand: compatibility.updateCommand
  };
}

function sanitizeRegistrationTarget(target, pathOptions) {
  const sanitized = {
    kind: target.kind,
    browser: target.browser,
    manifestPath: normalizeDiagnosticPath(target.manifestPath, pathOptions)
  };
  if (target.registryKey) {
    sanitized.registryKey = target.registryKey;
  }
  return sanitized;
}

function appendBoundedBuffer(current, chunk, maxBytes) {
  const next = Buffer.concat([current, chunk]);
  if (next.length <= maxBytes) {
    return next;
  }
  return next.subarray(next.length - maxBytes);
}

function summarizeBridgeFailure(exitCode, signal, stderr) {
  const stderrSummary = stderr && stderr.length
    ? firstDiagnosticLine(stderr.toString('utf8'))
    : '';
  if (exitCode !== 0 && exitCode !== null) {
    return stderrSummary
      ? `Bridge exited with status ${exitCode}: ${stderrSummary}`
      : `Bridge exited with status ${exitCode}`;
  }
  if (signal) {
    return stderrSummary
      ? `Bridge exited with signal ${signal}: ${stderrSummary}`
      : `Bridge exited with signal ${signal}`;
  }
  if (stderrSummary) {
    return `Bridge wrote stderr but no native response: ${stderrSummary}`;
  }
  return 'Bridge produced no native response';
}

function sanitizePathInMessage(message, targetPath, pathOptions) {
  const firstLine = firstDiagnosticLine(message);
  if (!targetPath || !firstLine.includes(targetPath)) {
    return firstLine;
  }
  return firstLine.split(targetPath).join(normalizeDiagnosticPath(targetPath, pathOptions));
}

function sanitizeDiagnosticMessage(message, pathOptions = {}) {
  const firstLine = firstDiagnosticLine(message);
  if (pathOptions.revealPaths) {
    return firstLine;
  }

  const platform = pathOptions.platform || process.platform;
  const platformPath = getPlatformPath(platform);
  const homeDir = pathOptions.homeDir || getHomeFromEnv(pathOptions.env || process.env, platform);
  let redacted = firstLine;

  if (homeDir) {
    const normalizedHome = platformPath.normalize(String(homeDir));
    redacted = platform === 'win32'
      ? replaceCaseInsensitive(redacted, normalizedHome, '~')
      : redacted.split(normalizedHome).join('~');
  }

  if (hasUnredactedAbsolutePath(redacted)) {
    return 'Native error message redacted (absolute path omitted)';
  }

  return redacted;
}

function firstDiagnosticLine(message) {
  return String(message || '')
    .split(/\r?\n/)
    .find(line => line.trim() && !/^\s*at\s+/.test(line)) ||
    'unknown error';
}

function replaceCaseInsensitive(value, needle, replacement) {
  const lowerValue = String(value).toLowerCase();
  const lowerNeedle = String(needle).toLowerCase();
  if (!lowerNeedle) {
    return value;
  }

  let result = '';
  let offset = 0;
  let index = lowerValue.indexOf(lowerNeedle, offset);
  while (index !== -1) {
    result += value.slice(offset, index) + replacement;
    offset = index + needle.length;
    index = lowerValue.indexOf(lowerNeedle, offset);
  }
  return result + value.slice(offset);
}

function hasUnredactedAbsolutePath(message) {
  const candidate = String(message)
    .replace(/~\/[^\s"'`<>|]+/g, '~')
    .replace(/~\\[^\s"'`<>|]+/g, '~');
  if (/[A-Za-z]:[\\/]/.test(candidate)) {
    return true;
  }
  if (candidate.includes('\\')) {
    return true;
  }
  return candidate.includes('/');
}

function normalizeTimeoutMs(timeoutMs) {
  const value = Number(timeoutMs);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_DOCTOR_TIMEOUT_MS;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeBrowser(browser) {
  if (!browser || browser === 'auto') {
    return 'auto';
  }
  if (browser === 'chrome' || browser === 'chromium') {
    return browser;
  }
  throw new Error(`Unsupported doctor browser: ${browser}`);
}

function resolveRuntimeRoot(runtimeRoot) {
  if (!runtimeRoot) {
    return '';
  }
  return path.isAbsolute(String(runtimeRoot))
    ? String(runtimeRoot)
    : path.resolve(String(runtimeRoot));
}

function getHomeFromEnv(env, platform) {
  if (platform === 'win32') {
    return env.USERPROFILE || env.HOME || os.homedir();
  }
  return env.HOME || env.USERPROFILE || os.homedir();
}

function isAbsolutePathForPlatform(targetPath, platform) {
  if (platform === 'win32') {
    return path.win32.isAbsolute(targetPath);
  }
  if (platform === 'darwin' || platform === 'linux') {
    return path.posix.isAbsolute(targetPath);
  }
  return path.isAbsolute(targetPath);
}

function getPlatformPath(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

module.exports = {
  buildDoctorBridgeSpawnInvocation,
  classifyDoctorResult,
  formatDoctorHuman,
  normalizeDiagnosticPath,
  normalizeBrowser,
  runDoctor
};
