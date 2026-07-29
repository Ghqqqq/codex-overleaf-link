const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  DEFAULT_CHROME_EXTENSION_ID,
  buildHostManifest,
  getNativeHostManifestPath,
  getWindowsRegistryMetadata
} = require('../native-host/src/manifest');
const { getDefaultBridgePath } = require('../native-host/src/nativeHostPlatform');
const {
  buildDoctorBridgeSpawnInvocation,
  classifyDoctorResult,
  normalizeDiagnosticPath,
  runDoctor
} = require('../native-host/src/nativeDoctor');
const {
  assertSafeManagedRuntimeRoot,
  installRuntimeFromPackage,
  readRuntimeMarker,
  uninstallManagedRuntime
} = require('../native-host/src/runtimeInstaller');
const {
  MIN_COMPATIBLE_EXTENSION_VERSION,
  REQUIRED_CAPABILITIES,
  UPDATE_AVAILABLE_CAPABILITIES
} = require('../extension/src/shared/compatibility');

const CURRENT_PACKAGE_VERSION = require('../package.json').version;
const CURRENT_RELEASE_REF = `v${CURRENT_PACKAGE_VERSION}`;
const CANONICAL_RELEASE_INSTALL_COMMAND = `CODEX_OVERLEAF_REF=${CURRENT_RELEASE_REF} bash -c "$(curl -fsSL https://raw.githubusercontent.com/Ghqqqq/codex-overleaf-link/${CURRENT_RELEASE_REF}/install.sh)"`;
const CANONICAL_WINDOWS_RELEASE_REF_COMMAND = `$env:CODEX_OVERLEAF_REF='${CURRENT_RELEASE_REF}'`;
const CANONICAL_WINDOWS_RELEASE_INSTALL_URL = `https://raw.githubusercontent.com/Ghqqqq/codex-overleaf-link/${CURRENT_RELEASE_REF}/install.ps1`;
const CANONICAL_WINDOWS_RELEASE_RUN_COMMAND = 'powershell -ExecutionPolicy Bypass -File install.ps1';
const CANONICAL_NPM_EXEC_PREFIX = `npm exec --yes codex-overleaf-link@${CURRENT_PACKAGE_VERSION} --`;

function writeFakeRegistryCommand(tempDir, options = {}) {
  const scriptPath = path.join(tempDir, 'fake-reg.js');
  const exitCode = Number.isInteger(options.exitCode) ? options.exitCode : 0;
  fs.writeFileSync(scriptPath, [
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    'fs.appendFileSync(process.env.REG_LOG, `${args.join("\\n")}\\n`);',
    options.stderr ? `process.stderr.write(${JSON.stringify(options.stderr)});` : '',
    `process.exit(${exitCode});`,
    ''
  ].filter(Boolean).join('\n'), 'utf8');

  return {
    CODEX_OVERLEAF_REG_EXE: process.execPath,
    CODEX_OVERLEAF_REG_EXE_ARGS_JSON: JSON.stringify([scriptPath])
  };
}

function getTestWindowsLocalAppData(tempDir) {
  if (process.platform === 'win32') {
    return path.win32.join(tempDir, 'LocalAppData');
  }
  return 'C:\\Users\\Alice\\AppData\\Local';
}

function getWindowsSimulationFilePath(tempDir, targetPath) {
  if (process.platform === 'win32') {
    return targetPath;
  }
  return path.join(tempDir, targetPath);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function writeRuntimePackageFixture(tempDir, version = '9.8.7') {
  const packageRoot = path.join(tempDir, 'package-root');
  const files = {
    'package.json': JSON.stringify({ name: 'codex-overleaf-link', version }, null, 2),
    'native-host/src/index.js': 'module.exports = {};\n',
    'extension/src/shared/compatibility.js': 'module.exports = {};\n',
    'scripts/codex-json-agent.mjs': '#!/usr/bin/env node\n',
    'scripts/install-native-host.mjs': '#!/usr/bin/env node\n',
    'scripts/uninstall-native-host.mjs': '#!/usr/bin/env node\n'
  };

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(packageRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }

  return packageRoot;
}

function makeDoctorEnv(tempDir) {
  return {
    ...process.env,
    HOME: tempDir,
    USERPROFILE: tempDir,
    LOCALAPPDATA: path.join(tempDir, 'LocalAppData')
  };
}

function writeDoctorManifest(tempDir, bridgePath, overrides = {}) {
  const env = makeDoctorEnv(tempDir);
  const manifestPath = getNativeHostManifestPath({
    browser: 'chrome',
    platform: process.platform,
    homeDir: tempDir,
    env
  });
  const manifest = {
    ...buildHostManifest({
      extensionId: DEFAULT_CHROME_EXTENSION_ID,
      bridgePath,
      platform: process.platform
    }),
    ...overrides
  };
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { env, manifest, manifestPath };
}

function buildDoctorNativePayload(overrides = {}) {
  return {
    host: 'com.codex.overleaf',
    platform: process.platform,
    protocolVersion: 1,
    supportedProtocol: { min: 1, max: 1 },
    capabilities: Object.fromEntries(REQUIRED_CAPABILITIES.map(capability => [capability, true])),
    minExtensionVersion: MIN_COMPATIBLE_EXTENSION_VERSION,
    version: CURRENT_PACKAGE_VERSION,
    environment: { codex: { ok: true } },
    ...overrides
  };
}

function writeFakeDoctorBridge(tempDir, options = {}) {
  const scriptPath = path.join(tempDir, 'doctor-bridge.js');
  const launcherPath = path.join(tempDir, process.platform === 'win32' ? 'doctor-bridge.cmd' : 'doctor-bridge');
  const response = options.response === undefined
    ? { id: 'doctor-ping', ok: true, result: buildDoctorNativePayload() }
    : options.response;
  const exitCode = Number.isInteger(options.exitCode) ? options.exitCode : 0;
  fs.writeFileSync(scriptPath, [
    `const response = ${JSON.stringify(response)};`,
    `const mode = ${JSON.stringify(options.mode || 'response')};`,
    `const exitCode = ${exitCode};`,
    `const trailingPartial = ${options.trailingPartial ? 'true' : 'false'};`,
    'process.stdin.resume();',
    'process.stdin.once("data", () => {',
    '  if (mode === "exit") process.exit(7);',
    '  const payload = Buffer.from(JSON.stringify(response), "utf8");',
    '  const frame = Buffer.alloc(4 + payload.length);',
    '  frame.writeUInt32LE(payload.length, 0);',
    '  payload.copy(frame, 4);',
    '  const trailing = trailingPartial ? Buffer.from([1, 2]) : Buffer.alloc(0);',
    '  process.stdout.write(Buffer.concat([frame, trailing]), () => process.exit(exitCode));',
    '});',
    ''
  ].join('\n'), 'utf8');

  if (process.platform === 'win32') {
    fs.writeFileSync(launcherPath, [
      '@echo off',
      `"${process.execPath}" "${scriptPath}"`,
      'exit /b %ERRORLEVEL%',
      ''
    ].join('\r\n'), 'utf8');
  } else {
    fs.writeFileSync(launcherPath, [
      '#!/bin/sh',
      `exec ${shellSingleQuote(process.execPath)} ${shellSingleQuote(scriptPath)}`,
      ''
    ].join('\n'), 'utf8');
    fs.chmodSync(launcherPath, 0o755);
  }

  return launcherPath;
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

test('classifyDoctorResult maps native doctor states to deterministic exit codes', () => {
  const base = {
    manifest: { exists: true, valid: true },
    bridge: { exists: true, valid: true },
    ping: { ok: true }
  };

  assert.deepEqual(classifyDoctorResult({ manifest: { exists: false } }), {
    exitCode: 2,
    ok: false,
    status: 'missing_install'
  });
  assert.deepEqual(classifyDoctorResult({
    ...base,
    bridge: { exists: false, valid: true }
  }), {
    exitCode: 2,
    ok: false,
    status: 'missing_bridge'
  });
  assert.deepEqual(classifyDoctorResult({
    ...base,
    compatibility: { classification: 'update-available', status: 'native_too_old' }
  }), {
    exitCode: 3,
    ok: false,
    status: 'native_stale'
  });
  assert.deepEqual(classifyDoctorResult({
    ...base,
    compatibility: { classification: 'incompatible', status: 'native_too_old' }
  }), {
    exitCode: 3,
    ok: false,
    status: 'native_incompatible'
  });
  assert.deepEqual(classifyDoctorResult({
    ...base,
    compatibility: { classification: 'compatible', status: 'ok' }
  }), {
    exitCode: 0,
    ok: true,
    status: 'ok'
  });
  assert.deepEqual(classifyDoctorResult({
    ...base,
    ping: { ok: false, error: 'spawn failed' }
  }), {
    exitCode: 3,
    ok: false,
    status: 'execution_failure'
  });
});

test('normalizeDiagnosticPath redacts home paths unless revealPaths is set', () => {
  const homeDir = path.join(os.tmpdir(), 'codex-overleaf-doctor-home');
  const targetPath = path.join(homeDir, 'NativeMessagingHosts', 'com.codex.overleaf.json');

  assert.equal(
    normalizeDiagnosticPath(targetPath, { homeDir }),
    `~${path.sep}NativeMessagingHosts${path.sep}com.codex.overleaf.json`
  );
  assert.equal(
    normalizeDiagnosticPath(targetPath, { homeDir, revealPaths: true }),
    targetPath
  );
});

test('doctor launches Windows command bridge through cmd.exe', () => {
  const bridgePath = 'C:\\Users\\Alice Smith\\AppData\\Local\\codex-overleaf\\codex-overleaf-bridge.cmd';
  const invocation = buildDoctorBridgeSpawnInvocation(bridgePath, { platform: 'win32' });

  assert.match(path.win32.basename(invocation.command).toLowerCase(), /^cmd(?:\.exe)?$/);
  assert.deepEqual(invocation.args, ['/d', '/c', `"${bridgePath}"`]);
  assert.equal(invocation.windowsVerbatimArguments, true);

  const exeInvocation = buildDoctorBridgeSpawnInvocation('C:\\Tools\\codex-overleaf-bridge.exe', { platform: 'win32' });
  assert.equal(exeInvocation.command, 'C:\\Tools\\codex-overleaf-bridge.exe');
  assert.deepEqual(exeInvocation.args, []);
});

test('runDoctor reports missing manifest as missing install with redacted paths', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-doctor-missing-manifest-'));
  try {
    const result = await runDoctor({
      browser: 'chrome',
      env: makeDoctorEnv(tempDir),
      homeDir: tempDir,
      timeoutMs: 50
    });

    assert.equal(result.exitCode, 2);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.status, 'missing_install');
    assert.match(result.body.manifest.path, /^~/);
    assert.doesNotMatch(JSON.stringify(result.body), new RegExp(escapeRegExp(tempDir)));

    const revealed = await runDoctor({
      browser: 'chrome',
      env: makeDoctorEnv(tempDir),
      homeDir: tempDir,
      revealPaths: true,
      timeoutMs: 50
    });
    assert.match(revealed.body.manifest.path, new RegExp(escapeRegExp(tempDir)));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runDoctor reports missing bridge from installed manifest', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-doctor-missing-bridge-'));
  try {
    const bridgePath = path.join(tempDir, 'missing-bridge');
    const { env } = writeDoctorManifest(tempDir, bridgePath);
    const result = await runDoctor({
      browser: 'chrome',
      env,
      homeDir: tempDir,
      timeoutMs: 50
    });

    assert.equal(result.exitCode, 2);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.status, 'missing_bridge');
    assert.equal(result.body.bridge.exists, false);
    assert.match(result.body.bridge.path, /^~/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runDoctor reports stale native ping as native_stale', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-doctor-stale-'));
  try {
    const staleResponse = {
      id: 'doctor-ping',
      ok: true,
      result: buildDoctorNativePayload({
        version: '0.9.5',
        capabilities: Object.fromEntries(UPDATE_AVAILABLE_CAPABILITIES.map(capability => [capability, true]))
      })
    };
    const bridgePath = writeFakeDoctorBridge(tempDir, { response: staleResponse });
    const { env } = writeDoctorManifest(tempDir, bridgePath);
    const result = await runDoctor({
      browser: 'chrome',
      env,
      homeDir: tempDir,
      timeoutMs: 5000
    });

    assert.equal(result.exitCode, 3);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.status, 'native_stale');
    assert.equal(result.body.compatibility.classification, 'update-available');
    assert.equal(result.body.compatibility.nativeVersion, '0.9.5');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runDoctor reports compatible native ping as ok', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-doctor-compatible-'));
  try {
    const bridgePath = writeFakeDoctorBridge(tempDir);
    const { env } = writeDoctorManifest(tempDir, bridgePath);
    const result = await runDoctor({
      browser: 'chrome',
      env,
      homeDir: tempDir,
      timeoutMs: 5000
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.status, 'ok');
    assert.equal(result.body.compatibility.classification, 'compatible');
    assert.equal(result.body.ping.ok, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runDoctor rejects a compatible native frame from a non-zero bridge exit', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-doctor-nonzero-frame-'));
  try {
    const bridgePath = writeFakeDoctorBridge(tempDir, { exitCode: 7 });
    const { env } = writeDoctorManifest(tempDir, bridgePath);
    const result = await runDoctor({
      browser: 'chrome',
      env,
      homeDir: tempDir,
      timeoutMs: 5000
    });

    assert.equal(result.exitCode, 3);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.status, 'execution_failure');
    assert.equal(result.body.ping.ok, false);
    assert.equal(result.body.ping.exitCode, 7);
    assert.equal(result.body.compatibility, null);
    assert.equal(result.body.diagnostics.manifestPath, result.body.manifest.path);
    assert.equal(result.body.diagnostics.bridgePath, result.body.bridge.path);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runDoctor rejects compatible native frames with the wrong response id', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-doctor-wrong-id-'));
  try {
    const wrongIdResponse = {
      id: 'not-doctor-ping',
      ok: true,
      result: buildDoctorNativePayload()
    };
    const bridgePath = writeFakeDoctorBridge(tempDir, { response: wrongIdResponse });
    const { env } = writeDoctorManifest(tempDir, bridgePath);
    const result = await runDoctor({
      browser: 'chrome',
      env,
      homeDir: tempDir,
      timeoutMs: 5000
    });

    assert.equal(result.exitCode, 3);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.status, 'execution_failure');
    assert.equal(result.body.ping.ok, false);
    assert.equal(result.body.compatibility, null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runDoctor rejects trailing partial native output after a valid frame', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-doctor-partial-output-'));
  try {
    const bridgePath = writeFakeDoctorBridge(tempDir, { trailingPartial: true });
    const { env } = writeDoctorManifest(tempDir, bridgePath);
    const result = await runDoctor({
      browser: 'chrome',
      env,
      homeDir: tempDir,
      timeoutMs: 5000
    });

    assert.equal(result.exitCode, 3);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.status, 'execution_failure');
    assert.equal(result.body.ping.ok, false);
    assert.equal(result.body.compatibility, null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runDoctor redacts home paths from native error response messages by default', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-doctor-error-redaction-'));
  try {
    const leakedPath = path.join(tempDir, 'private', 'project.tex');
    const errorResponse = {
      id: 'doctor-ping',
      ok: false,
      error: {
        code: 'native_error',
        message: `Failed to read ${leakedPath}`
      }
    };
    const bridgePath = writeFakeDoctorBridge(tempDir, { response: errorResponse });
    const { env } = writeDoctorManifest(tempDir, bridgePath);
    const redacted = await runDoctor({
      browser: 'chrome',
      env,
      homeDir: tempDir,
      timeoutMs: 5000
    });

    assert.equal(redacted.exitCode, 3);
    assert.equal(redacted.body.ok, false);
    assert.equal(redacted.body.ping.response.error.message, `Failed to read ~${path.sep}private${path.sep}project.tex`);
    assert.doesNotMatch(JSON.stringify(redacted.body), new RegExp(escapeRegExp(tempDir)));

    const revealed = await runDoctor({
      browser: 'chrome',
      env,
      homeDir: tempDir,
      revealPaths: true,
      timeoutMs: 5000
    });

    assert.equal(revealed.exitCode, 3);
    assert.equal(revealed.body.ping.response.error.message, `Failed to read ${leakedPath}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runDoctor redacts non-home absolute paths from native error response messages by default', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-doctor-error-outside-home-'));
  try {
    const leakedPath = process.platform === 'win32'
      ? 'C:\\outside-home\\private\\project.tex'
      : '/tmp/outside-home/private/project.tex';
    const errorResponse = {
      id: 'doctor-ping',
      ok: false,
      error: {
        code: 'native_error',
        message: `Failed to read ${leakedPath}`
      }
    };
    const bridgePath = writeFakeDoctorBridge(tempDir, { response: errorResponse });
    const { env } = writeDoctorManifest(tempDir, bridgePath);
    const redacted = await runDoctor({
      browser: 'chrome',
      env,
      homeDir: tempDir,
      timeoutMs: 5000
    });

    assert.equal(redacted.exitCode, 3);
    assert.equal(redacted.body.ok, false);
    assert.doesNotMatch(redacted.body.ping.response.error.message, new RegExp(escapeRegExp(leakedPath)));
    assert.doesNotMatch(JSON.stringify(redacted.body), new RegExp(escapeRegExp(leakedPath)));

    const revealed = await runDoctor({
      browser: 'chrome',
      env,
      homeDir: tempDir,
      revealPaths: true,
      timeoutMs: 5000
    });

    assert.equal(revealed.exitCode, 3);
    assert.equal(revealed.body.ping.response.error.message, `Failed to read ${leakedPath}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runDoctor redacts non-home POSIX paths with spaces from native error response messages by default', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-doctor-error-spaces-'));
  try {
    const leakedPath = '/Volumes/Work Drive/private/project.tex';
    const errorResponse = {
      id: 'doctor-ping',
      ok: false,
      error: {
        code: 'native_error',
        message: `Failed to read ${leakedPath}`
      }
    };
    const bridgePath = writeFakeDoctorBridge(tempDir, { response: errorResponse });
    const { env } = writeDoctorManifest(tempDir, bridgePath);
    const redacted = await runDoctor({
      browser: 'chrome',
      env,
      homeDir: tempDir,
      timeoutMs: 5000
    });

    assert.equal(redacted.exitCode, 3);
    assert.equal(redacted.body.ok, false);
    assert.doesNotMatch(redacted.body.ping.response.error.message, new RegExp(escapeRegExp(leakedPath)));
    assert.doesNotMatch(redacted.body.ping.response.error.message, /Work Drive/);
    assert.doesNotMatch(redacted.body.ping.response.error.message, /private\/project\.tex/);
    assert.doesNotMatch(JSON.stringify(redacted.body), new RegExp(escapeRegExp(leakedPath)));

    const revealed = await runDoctor({
      browser: 'chrome',
      env,
      homeDir: tempDir,
      revealPaths: true,
      timeoutMs: 5000
    });

    assert.equal(revealed.exitCode, 3);
    assert.equal(revealed.body.ping.response.error.message, `Failed to read ${leakedPath}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runDoctor redacts bracketed POSIX paths with spaces from native error response messages by default', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-doctor-error-bracketed-'));
  try {
    const leakedPath = '/Volumes/Work Drive/private/project.tex';
    const errorResponse = {
      id: 'doctor-ping',
      ok: false,
      error: {
        code: 'native_error',
        message: `Failed [${leakedPath}]`
      }
    };
    const bridgePath = writeFakeDoctorBridge(tempDir, { response: errorResponse });
    const { env } = writeDoctorManifest(tempDir, bridgePath);
    const redacted = await runDoctor({
      browser: 'chrome',
      env,
      homeDir: tempDir,
      timeoutMs: 5000
    });

    assert.equal(redacted.exitCode, 3);
    assert.equal(redacted.body.ok, false);
    assert.doesNotMatch(redacted.body.ping.response.error.message, /\/Volumes/);
    assert.doesNotMatch(redacted.body.ping.response.error.message, /Work Drive/);
    assert.doesNotMatch(redacted.body.ping.response.error.message, /private\/project\.tex/);
    assert.doesNotMatch(JSON.stringify(redacted.body), new RegExp(escapeRegExp(leakedPath)));

    const revealed = await runDoctor({
      browser: 'chrome',
      env,
      homeDir: tempDir,
      revealPaths: true,
      timeoutMs: 5000
    });

    assert.equal(revealed.exitCode, 3);
    assert.equal(revealed.body.ping.response.error.message, `Failed [${leakedPath}]`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runDoctor redacts rooted Windows paths with spaces from native error response messages by default', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-doctor-error-windows-rooted-'));
  try {
    const leakedPath = String.raw`\Users\Alice Smith\private\project.tex`;
    const errorResponse = {
      id: 'doctor-ping',
      ok: false,
      error: {
        code: 'native_error',
        message: `Failed [${leakedPath}]`
      }
    };
    const bridgePath = writeFakeDoctorBridge(tempDir, { response: errorResponse });
    const { env } = writeDoctorManifest(tempDir, bridgePath);
    const redacted = await runDoctor({
      browser: 'chrome',
      env,
      homeDir: tempDir,
      timeoutMs: 5000
    });

    assert.equal(redacted.exitCode, 3);
    assert.equal(redacted.body.ok, false);
    assert.doesNotMatch(redacted.body.ping.response.error.message, /Alice Smith/);
    assert.doesNotMatch(redacted.body.ping.response.error.message, /private\\project\.tex/);
    assert.doesNotMatch(redacted.body.ping.response.error.message, new RegExp(escapeRegExp(leakedPath)));
    assert.doesNotMatch(JSON.stringify(redacted.body), new RegExp(escapeRegExp(leakedPath)));

    const revealed = await runDoctor({
      browser: 'chrome',
      env,
      homeDir: tempDir,
      revealPaths: true,
      timeoutMs: 5000
    });

    assert.equal(revealed.exitCode, 3);
    assert.equal(revealed.body.ping.response.error.message, `Failed [${leakedPath}]`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runDoctor reports bridge execution failure with static diagnostics', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-doctor-exec-failure-'));
  try {
    const bridgePath = writeFakeDoctorBridge(tempDir, { mode: 'exit' });
    const { env } = writeDoctorManifest(tempDir, bridgePath);
    const result = await runDoctor({
      browser: 'chrome',
      env,
      homeDir: tempDir,
      timeoutMs: 5000
    });

    assert.equal(result.exitCode, 3);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.status, 'execution_failure');
    assert.equal(result.body.diagnostics.manifestPath, result.body.manifest.path);
    assert.equal(result.body.diagnostics.bridgePath, result.body.bridge.path);
    assert.equal(result.body.ping.ok, false);
    assert.doesNotMatch(JSON.stringify(result.body), /at .*nativeDoctor/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('installRuntimeFromPackage creates stable managed runtime layout and marker', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-runtime-installer-'));
  const packageRoot = writeRuntimePackageFixture(tempDir, '2.3.4');
  const runtimeRoot = path.join(tempDir, 'runtime');
  try {
    const result = installRuntimeFromPackage({ packageRoot, runtimeRoot });

    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(runtimeRoot, '.codex-overleaf-runtime.json')), true);
    assert.equal(fs.existsSync(path.join(runtimeRoot, 'package.json')), true);
    assert.equal(fs.existsSync(path.join(runtimeRoot, 'native-host/src/index.js')), true);
    assert.equal(fs.existsSync(path.join(runtimeRoot, 'extension/src/shared/compatibility.js')), true);
    assert.equal(fs.existsSync(path.join(runtimeRoot, 'scripts/codex-json-agent.mjs')), true);
    assert.equal(fs.existsSync(path.join(runtimeRoot, 'scripts/install-native-host.mjs')), true);
    assert.equal(fs.existsSync(path.join(runtimeRoot, 'scripts/uninstall-native-host.mjs')), true);

    const marker = readRuntimeMarker(runtimeRoot);
    assert.equal(marker.managedBy, 'codex-overleaf-link');
    assert.equal(marker.version, '2.3.4');
    assert.equal(marker.installedFrom, 'npm');
    assert.equal(typeof marker.installedAt, 'string');
    assert.ok(Number.isFinite(Date.parse(marker.installedAt)));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('assertSafeManagedRuntimeRoot rejects dangerous roots and accepts a temp runtime child', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-runtime-safe-'));
  const packageRoot = writeRuntimePackageFixture(tempDir);
  try {
    const dangerousRoots = ['/', os.homedir(), packageRoot, '/usr', '/tmp'];
    for (const dangerousRoot of dangerousRoots) {
      assert.throws(
        () => assertSafeManagedRuntimeRoot(dangerousRoot, { packageRoot }),
        /Refusing to recursively remove unsafe runtime root/
      );
    }

    assert.equal(
      assertSafeManagedRuntimeRoot(path.join(tempDir, 'runtime'), { packageRoot }),
      path.join(tempDir, 'runtime')
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('managed runtime safety refuses temp roots through symlinked ancestors', t => {
  if (process.platform === 'win32') {
    t.skip('symlinked POSIX temp ancestor behavior is covered on POSIX runners');
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-runtime-symlink-'));
  const outsideDir = fs.mkdtempSync(path.join(process.cwd(), '.runtime-installer-outside-'));
  const packageRoot = writeRuntimePackageFixture(tempDir);
  const linkPath = path.join(tempDir, 'link');
  const runtimeRoot = path.join(linkPath, 'runtime');
  try {
    fs.symlinkSync(outsideDir, linkPath, 'dir');

    assert.throws(
      () => assertSafeManagedRuntimeRoot(runtimeRoot, { packageRoot }),
      /Refusing to recursively remove unsafe runtime root/
    );
    assert.throws(
      () => installRuntimeFromPackage({ packageRoot, runtimeRoot }),
      /Refusing to recursively remove unsafe runtime root/
    );
    assert.throws(
      () => uninstallManagedRuntime({ runtimeRoot }),
      /Refusing to recursively remove unsafe runtime root/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('installRuntimeFromPackage refuses to replace an unmarked existing runtime root', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-runtime-unmarked-'));
  const packageRoot = writeRuntimePackageFixture(tempDir);
  const runtimeRoot = path.join(tempDir, 'runtime');
  try {
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'keep.txt'), 'keep', 'utf8');

    assert.throws(
      () => installRuntimeFromPackage({ packageRoot, runtimeRoot }),
      /Refusing to replace unmarked runtime root/
    );
    assert.equal(fs.readFileSync(path.join(runtimeRoot, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('uninstallManagedRuntime removes marked runtime, refuses unmarked runtime, and honors keepRuntime', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-runtime-uninstall-'));
  const packageRoot = writeRuntimePackageFixture(tempDir);
  const runtimeRoot = path.join(tempDir, 'runtime');
  try {
    installRuntimeFromPackage({ packageRoot, runtimeRoot });
    const kept = uninstallManagedRuntime({ runtimeRoot, keepRuntime: true });
    assert.equal(kept.action, 'kept');
    assert.equal(fs.existsSync(runtimeRoot), true);

    const removed = uninstallManagedRuntime({ runtimeRoot });
    assert.equal(removed.action, 'removed');
    assert.equal(fs.existsSync(runtimeRoot), false);

    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'keep.txt'), 'keep', 'utf8');
    assert.throws(
      () => uninstallManagedRuntime({ runtimeRoot }),
      /Refusing to remove unmarked runtime root/
    );
    assert.equal(fs.readFileSync(path.join(runtimeRoot, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('installRuntimeFromPackage leaves previous runtime in place when staged verification fails', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-runtime-rollback-'));
  const packageRoot = writeRuntimePackageFixture(tempDir, '1.0.0');
  const runtimeRoot = path.join(tempDir, 'runtime');
  try {
    installRuntimeFromPackage({ packageRoot, runtimeRoot });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'codex-overleaf-link', version: '2.0.0' }), 'utf8');

    assert.throws(
      () => installRuntimeFromPackage({
        packageRoot,
        runtimeRoot,
        verifyRuntime() {
          throw new Error('simulated staged verification failure');
        }
      }),
      /simulated staged verification failure/
    );

    assert.equal(readRuntimeMarker(runtimeRoot).version, '1.0.0');
    assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8')).version, '1.0.0');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('installRuntimeFromPackage reports rollback cleanup warnings without failing activation', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-runtime-cleanup-warning-'));
  const packageRoot = writeRuntimePackageFixture(tempDir, '1.0.0');
  const runtimeRoot = path.join(tempDir, 'runtime');
  try {
    installRuntimeFromPackage({ packageRoot, runtimeRoot });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'codex-overleaf-link', version: '2.0.0' }), 'utf8');

    const result = installRuntimeFromPackage({
      packageRoot,
      runtimeRoot,
      cleanupRollback() {
        throw new Error('simulated cleanup failure');
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'replaced');
    assert.match(result.warning, /simulated cleanup failure/);
    assert.equal(readRuntimeMarker(runtimeRoot).version, '2.0.0');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('native install script defaults to the committed extension id', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../scripts/install-native-host.mjs'),
    'utf8'
  );

  assert.match(source, /DEFAULT_CHROME_EXTENSION_ID/);
  assert.match(source, /options\.extensionId \|\| DEFAULT_CHROME_EXTENSION_ID/);
  assert.match(source, /const extensionIds = \[extensionId\]/);
  assert.equal(DEFAULT_CHROME_EXTENSION_ID, 'illdpneeeopfffmiepaejglgmhpmdhdc');
});

test('repository does not ship a generated native bridge with local absolute paths', () => {
  assert.equal(
    fs.existsSync(path.join(__dirname, '../native-host/bin/codex-overleaf-bridge')),
    false
  );
});

test('package exposes install and uninstall native host commands', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));

  assert.equal(pkg.scripts['install:native'], 'node scripts/install-native-host.mjs');
  assert.equal(pkg.scripts['uninstall:native'], 'node scripts/uninstall-native-host.mjs');
});

test('native install helpers pin Linux and Windows Native Messaging manifest locations', () => {
  assert.equal(
    getNativeHostManifestPath({ platform: 'linux', browser: 'chrome', homeDir: '/home/alice' }),
    '/home/alice/.config/google-chrome/NativeMessagingHosts/com.codex.overleaf.json'
  );
  assert.equal(
    getNativeHostManifestPath({ platform: 'linux', browser: 'chromium', homeDir: '/home/alice' }),
    '/home/alice/.config/chromium/NativeMessagingHosts/com.codex.overleaf.json'
  );

  const windowsMetadata = getWindowsRegistryMetadata({
    browser: 'chrome',
    env: {
      LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local'
    }
  });
  assert.equal(
    windowsMetadata.manifestPath,
    'C:\\Users\\Alice\\AppData\\Local\\codex-overleaf\\native-messaging-hosts\\com.codex.overleaf.json'
  );
  assert.equal(
    windowsMetadata.registryKey,
    'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.codex.overleaf'
  );
  assert.equal(
    windowsMetadata.addCommand,
    'reg.exe add "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.codex.overleaf" /ve /t REG_SZ /d "C:\\Users\\Alice\\AppData\\Local\\codex-overleaf\\native-messaging-hosts\\com.codex.overleaf.json" /f'
  );
});

test('repository ships a one-command Windows installer', () => {
  const installer = fs.readFileSync(path.join(__dirname, '../install.ps1'), 'utf8');

  assert.match(installer, /CODEX_OVERLEAF_INSTALL_DIR/);
  assert.match(installer, /CODEX_OVERLEAF_REF/);
  assert.match(installer, /CODEX_OVERLEAF_REPO_URL/);
  assert.match(installer, /CODEX_OVERLEAF_EXTENSION_ID/);
  assert.match(installer, /github\.com\/Ghqqqq\/codex-overleaf-link\.git/);
  assert.match(installer, /Get-Command\s+git/);
  assert.match(installer, /Get-Command\s+node/);
  assert.match(installer, /Get-Command\s+npm/);
  assert.match(installer, /git clone/);
  assert.match(installer, /git -C/);
  assert.match(installer, /npm ci/);
  assert.match(installer, /npm run build:content/);
  assert.ok(
    installer.indexOf('npm run build:content') < installer.indexOf('$InstallManagedScript'),
    'Windows installer should build the content bundle before managed installation'
  );
  assert.match(installer, /scripts[\\/]install-managed\.mjs/);
  assert.match(installer, /--json/);
  assert.match(installer, /--extension-id/);
  assert.match(installer, /chrome:\/\/extensions/);
  assert.match(installer, /Load unpacked/);
  assert.match(installer, /Reload the Chrome extension/);
  assert.match(installer, /Refresh the Overleaf page/);
});

test('Windows installer guards recursive replacement of existing non-checkout install directories', () => {
  const installer = fs.readFileSync(path.join(__dirname, '../install.ps1'), 'utf8');

  assert.match(installer, /function Assert-SafeInstallDir/);
  assert.match(installer, /Refusing to remove unsafe install directory/);
  assert.match(installer, /\[System\.IO\.Path\]::GetFullPath/);
  assert.match(installer, /\[System\.IO\.Path\]::GetPathRoot/);
  assert.match(
    installer,
    /Assert-SafeInstallDir\s+\$InstallDir[\s\S]*Remove-Item\s+-LiteralPath\s+\$InstallDir\s+-Recurse\s+-Force/
  );
});

test('native install runtime includes package metadata required by bridge ping', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-runtime-test-'));
  const runtimeRoot = path.join(tempDir, 'runtime');
  const bridgePath = path.join(tempDir, 'codex-overleaf-bridge');
  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '../scripts/install-native-host.mjs'),
      '--extension-id',
      DEFAULT_CHROME_EXTENSION_ID,
      '--runtime-root',
      runtimeRoot,
      '--bridge-path',
      bridgePath
    ], {
      env: {
        ...process.env,
        HOME: tempDir
      },
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, new RegExp(`Runtime package version: ${escapeRegExp(CURRENT_PACKAGE_VERSION)}`));
    const runtimePackagePath = path.join(runtimeRoot, 'package.json');
    const runtimeAgentPath = path.join(runtimeRoot, 'scripts/codex-json-agent.mjs');
    assert.equal(fs.existsSync(runtimePackagePath), true);
    assert.equal(fs.existsSync(runtimeAgentPath), true);
    const bridgeContent = fs.readFileSync(bridgePath, 'utf8');
    const jsonEscapedRuntimeAgentPath = JSON.stringify(runtimeAgentPath).slice(1, -1);
    assert.ok(
      bridgeContent.includes(runtimeAgentPath) || bridgeContent.includes(jsonEscapedRuntimeAgentPath),
      bridgeContent
    );
    const runtimePackage = JSON.parse(fs.readFileSync(runtimePackagePath, 'utf8'));
    const { handleRequest } = require(path.join(runtimeRoot, 'native-host/src/taskRunner.js'));
    const response = await handleRequest({ id: 'runtime-ping', method: 'bridge.ping', params: {} }, {});

    assert.equal(response.ok, true);
    assert.equal(response.result.version, runtimePackage.version);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('native install script writes Linux Chrome manifest under injected HOME', t => {
  if (process.platform === 'win32') {
    t.skip('Linux install path behavior is covered on POSIX runners');
    return;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-linux-chrome-test-'));
  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '../scripts/install-native-host.mjs'),
      '--extension-id',
      DEFAULT_CHROME_EXTENSION_ID,
      '--platform',
      'linux',
      '--browser',
      'chrome'
    ], {
      env: {
        ...process.env,
        HOME: tempDir
      },
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifestPath = path.join(tempDir, '.config/google-chrome/NativeMessagingHosts/com.codex.overleaf.json');
    assert.equal(fs.existsSync(manifestPath), true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.path, path.posix.join(tempDir, '.codex-overleaf/codex-overleaf-bridge'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('native install script writes Linux Chromium manifest under injected HOME', t => {
  if (process.platform === 'win32') {
    t.skip('Linux install path behavior is covered on POSIX runners');
    return;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-linux-chromium-test-'));
  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '../scripts/install-native-host.mjs'),
      '--extension-id',
      DEFAULT_CHROME_EXTENSION_ID,
      '--platform',
      'linux',
      '--browser',
      'chromium'
    ], {
      env: {
        ...process.env,
        HOME: tempDir
      },
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifestPath = path.join(tempDir, '.config/chromium/NativeMessagingHosts/com.codex.overleaf.json');
    assert.equal(fs.existsSync(manifestPath), true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.path, path.posix.join(tempDir, '.codex-overleaf/codex-overleaf-bridge'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('native install script registers Windows Chrome host with reg.exe add', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-win-install-test-'));
  const regLog = path.join(tempDir, 'reg.log');
  const registryEnv = writeFakeRegistryCommand(tempDir);
  const localAppData = getTestWindowsLocalAppData(tempDir);
  const expectedManifestPath = path.win32.join(localAppData, 'codex-overleaf', 'native-messaging-hosts', 'com.codex.overleaf.json');

  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '../scripts/install-native-host.mjs'),
      '--extension-id',
      DEFAULT_CHROME_EXTENSION_ID,
      '--platform',
      'win32',
      '--browser',
      'chrome'
    ], {
      cwd: tempDir,
      env: {
        ...process.env,
        ...registryEnv,
        HOME: tempDir,
        LOCALAPPDATA: localAppData,
        REG_LOG: regLog
      },
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const regArgs = fs.readFileSync(regLog, 'utf8');
    assert.match(regArgs, /^add\n/);
    assert.match(regArgs, /HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com\.codex\.overleaf/);
    assert.match(regArgs, new RegExp(`/d\\n${escapeRegExp(expectedManifestPath)}`));
    assert.match(result.stdout, /Registered Native Messaging host registry key:/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('native install script uses a .cmd Windows bridge path by default', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-win-cmd-bridge-test-'));
  const regLog = path.join(tempDir, 'reg.log');
  const registryEnv = writeFakeRegistryCommand(tempDir);
  const localAppData = getTestWindowsLocalAppData(tempDir);
  const expectedBridgePath = path.win32.join(localAppData, 'CodexOverleaf', 'codex-overleaf-bridge.cmd');
  const expectedManifestPath = path.win32.join(localAppData, 'codex-overleaf', 'native-messaging-hosts', 'com.codex.overleaf.json');

  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '../scripts/install-native-host.mjs'),
      '--extension-id',
      DEFAULT_CHROME_EXTENSION_ID,
      '--platform',
      'win32',
      '--browser',
      'chrome'
    ], {
      cwd: tempDir,
      env: {
        ...process.env,
        ...registryEnv,
        HOME: tempDir,
        LOCALAPPDATA: localAppData,
        REG_LOG: regLog
      },
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(
      getDefaultBridgePath({
        platform: 'win32',
        env: {
          LOCALAPPDATA: localAppData
        }
      }),
      expectedBridgePath
    );
    const manifest = JSON.parse(fs.readFileSync(getWindowsSimulationFilePath(tempDir, expectedManifestPath), 'utf8'));
    assert.equal(manifest.path, expectedBridgePath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('native install script rejects unsafe runtime roots before deleting them', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-install-guard-test-'));
  const unsafeRoot = path.join(tempDir, 'user-data');
  const markerPath = path.join(unsafeRoot, 'marker.txt');
  fs.mkdirSync(unsafeRoot, { recursive: true });
  fs.writeFileSync(markerPath, 'keep');

  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '../scripts/install-native-host.mjs'),
      '--extension-id',
      DEFAULT_CHROME_EXTENSION_ID,
      '--runtime-root',
      unsafeRoot
    ], {
      env: {
        ...process.env,
        HOME: tempDir
      },
      encoding: 'utf8'
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to recursively remove unsafe runtime root/);
    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'keep');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('native uninstall script removes Windows Chrome host with reg.exe delete', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-win-uninstall-test-'));
  const regLog = path.join(tempDir, 'reg.log');
  const registryEnv = writeFakeRegistryCommand(tempDir);

  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '../scripts/uninstall-native-host.mjs'),
      '--platform',
      'win32',
      '--browser',
      'chrome'
    ], {
      cwd: tempDir,
      env: {
        ...process.env,
        ...registryEnv,
        HOME: tempDir,
        LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local',
        REG_LOG: regLog
      },
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const regArgs = fs.readFileSync(regLog, 'utf8');
    assert.match(regArgs, /^delete\n/);
    assert.match(regArgs, /HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com\.codex\.overleaf/);
    assert.match(regArgs, /\/f/);
    assert.match(result.stdout, /Removed Native Messaging host registry key:/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('native uninstall script rejects unsafe runtime roots before deleting them', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-uninstall-guard-test-'));
  const unsafeRoot = path.join(tempDir, 'user-data');
  const markerPath = path.join(unsafeRoot, 'marker.txt');
  fs.mkdirSync(unsafeRoot, { recursive: true });
  fs.writeFileSync(markerPath, 'keep');

  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '../scripts/uninstall-native-host.mjs'),
      '--runtime-root',
      unsafeRoot
    ], {
      env: {
        ...process.env,
        HOME: tempDir
      },
      encoding: 'utf8'
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to recursively remove unsafe runtime root/);
    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'keep');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('native uninstall script refuses to recursively delete a bridge directory', t => {
  if (process.platform === 'win32') {
    t.skip('Linux uninstall path behavior is covered on POSIX runners');
    return;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-bridge-dir-guard-test-'));
  const bridgePath = path.join(tempDir, 'bridge-dir');
  const markerPath = path.join(bridgePath, 'marker.txt');
  fs.mkdirSync(bridgePath, { recursive: true });
  fs.writeFileSync(markerPath, 'keep');

  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '../scripts/uninstall-native-host.mjs'),
      '--platform',
      'linux',
      '--browser',
      'chrome',
      '--bridge-path',
      bridgePath,
      '--keep-runtime'
    ], {
      env: {
        ...process.env,
        HOME: tempDir
      },
      encoding: 'utf8'
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to remove bridge directory/);
    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'keep');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('native uninstall script refuses to recursively delete a manifest directory', t => {
  if (process.platform === 'win32') {
    t.skip('Linux manifest path behavior is covered on POSIX runners');
    return;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-manifest-dir-guard-test-'));
  const manifestPath = path.join(tempDir, '.config/google-chrome/NativeMessagingHosts/com.codex.overleaf.json');
  const markerPath = path.join(manifestPath, 'marker.txt');
  const bridgePath = path.join(tempDir, 'codex-overleaf-bridge');
  fs.mkdirSync(manifestPath, { recursive: true });
  fs.writeFileSync(markerPath, 'keep');

  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '../scripts/uninstall-native-host.mjs'),
      '--platform',
      'linux',
      '--browser',
      'chrome',
      '--bridge-path',
      bridgePath,
      '--keep-runtime'
    ], {
      env: {
        ...process.env,
        HOME: tempDir
      },
      encoding: 'utf8'
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to remove Native Messaging host manifest directory/);
    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'keep');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('native uninstall script continues when Windows registry key is already missing', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-win-uninstall-missing-reg-test-'));
  const regLog = path.join(tempDir, 'reg.log');
  const runtimeRoot = path.join(tempDir, 'runtime');
  const bridgePath = path.join(tempDir, 'codex-overleaf-bridge.cmd');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, '.codex-overleaf-runtime.json'), JSON.stringify({
    managedBy: 'codex-overleaf-link',
    version: CURRENT_PACKAGE_VERSION,
    installedFrom: 'npm',
    installedAt: new Date().toISOString()
  }));
  fs.writeFileSync(bridgePath, '@echo off\r\n');
  const registryEnv = writeFakeRegistryCommand(tempDir, {
    exitCode: 1,
    stderr: 'ERROR: The system was unable to find the specified registry key or value.\n'
  });

  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '../scripts/uninstall-native-host.mjs'),
      '--platform',
      'win32',
      '--browser',
      'chrome',
      '--runtime-root',
      runtimeRoot,
      '--bridge-path',
      bridgePath
    ], {
      cwd: tempDir,
      env: {
        ...process.env,
        ...registryEnv,
        HOME: tempDir,
        LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local',
        REG_LOG: regLog
      },
      encoding: 'utf8'
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(runtimeRoot), false);
    assert.equal(fs.existsSync(bridgePath), false);
    assert.match(result.stdout, /Native Messaging host registry key not found:/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function readStableReleaseMetadata(readme) {
  const version = readme.match(/img\.shields\.io\/badge\/version-(\d+\.\d+\.\d+)-blue/)?.[1] || '';
  assert.match(version, /^\d+\.\d+\.\d+$/, 'expected README stable-version badge');
  const ref = `v${version}`;
  return {
    version,
    ref,
    npmExecPrefix: `npm exec --yes codex-overleaf-link@${version} --`,
    windowsInstallUrl: `https://raw.githubusercontent.com/Ghqqqq/codex-overleaf-link/${ref}/install.ps1`,
    windowsRefCommand: `$env:CODEX_OVERLEAF_REF='${ref}'`,
    windowsRunCommand: 'powershell -ExecutionPolicy Bypass -File install.ps1'
  };
}

test('repository ships a one-command macOS installer', () => {
  const installer = fs.readFileSync(path.join(__dirname, '../install.sh'), 'utf8');
  const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
  const stable = readStableReleaseMetadata(readme);

  assert.match(installer, /CODEX_OVERLEAF_INSTALL_DIR/);
  assert.match(installer, /CODEX_OVERLEAF_REF/);
  assert.match(installer, /github\.com\/Ghqqqq\/codex-overleaf-link\.git/);
  assert.match(installer, /need_command npm/);
  assert.match(installer, /npm ci/);
  assert.match(installer, /npm run build:content/);
  assert.ok(
    installer.indexOf('npm run build:content') < installer.indexOf('scripts/install-managed.mjs'),
    'shell installer should build the content bundle before managed installation'
  );
  assert.match(installer, /scripts\/install-managed\.mjs/);
  assert.doesNotMatch(installer, /rm -rf "\$INSTALL_DIR"/);
  assert.match(installer, /Package version/);
  assert.match(installer, /Extension path/);
  assert.match(installer, /chrome:\/\/extensions/);
  assert.match(installer, /extension/);
  assert.match(installer, /CODEX_OVERLEAF_EXTENSION_LINK/);
  assert.match(installer, /Codex Overleaf Link Extension/);
  assert.match(installer, /ln -s/);
  assert.match(installer, /pbcopy/);
  assert.match(installer, /open -a "Google Chrome" "chrome:\/\/extensions"/);
  assert.match(installer, /open -R/);
  assert.match(readme, new RegExp(`CODEX_OVERLEAF_REF=${escapeRegExp(stable.ref)}\\s+bash -c "\\$\\(curl -fsSL https://raw\\.githubusercontent\\.com/Ghqqqq/codex-overleaf-link/${escapeRegExp(stable.ref)}/install\\.sh\\)"`));
  assert.match(readme, new RegExp(`codex-overleaf-link-extension-${escapeRegExp(stable.ref)}\\.zip`));
  assert.doesNotMatch(readme, /select `~\/\.codex-overleaf\/source\/extension`/);
});

test('README documents stable cross-platform manual install, uninstall, release artifacts, and bundled extension id flow', () => {
  const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
  const stable = readStableReleaseMetadata(readme);

  assert.match(readme, new RegExp(`CODEX_OVERLEAF_REF=${escapeRegExp(stable.ref)}\\s+bash -c "\\$\\(curl -fsSL https://raw\\.githubusercontent\\.com/Ghqqqq/codex-overleaf-link/${escapeRegExp(stable.ref)}/install\\.sh\\)"`));
  assert.ok(readme.includes(`${stable.npmExecPrefix} install-managed`));
  assert.match(readme, new RegExp(`iwr\\s+https://raw\\.githubusercontent\\.com/Ghqqqq/codex-overleaf-link/${escapeRegExp(stable.ref)}/install\\.ps1`, 'i'));
  assert.match(readme, /powershell\s+-ExecutionPolicy\s+Bypass\s+-File\s+install\.ps1/i);
  assert.match(readme, /macOS\s+\/\s+Linux/i);
  assert.match(readme, /Windows/i);
  assert.match(readme, new RegExp(`codex-overleaf-link-extension-${escapeRegExp(stable.ref)}\\.zip`));
  assert.match(readme, /manual unpacked installation/i);
  assert.match(readme, new RegExp(`codex-overleaf-native-host-${escapeRegExp(stable.ref)}\\.tar\\.gz`));
  assert.match(readme, /native host runtime/i);
  assert.match(readme, /install\.sh/);
  assert.match(readme, /install\.ps1/);
  assert.match(readme, /uninstall-native-host\.mjs/);
  assert.match(readme, /node\s+~\/\.codex-overleaf\/source\/scripts\/uninstall-native-host\.mjs/);
  assert.match(readme, /node\s+\$env:LOCALAPPDATA\\CodexOverleaf\\source\\scripts\\uninstall-native-host\.mjs/);
  assert.match(readme, /native host update required/i);
  assert.match(readme, /CODEX_OVERLEAF_EXTENSION_ID/);
  assert.match(readme, /allowed_origins/);
  assert.match(readme, /bundled extension key/i);
  assert.match(readme, /stable id/i);
  assert.ok(readme.includes(`${stable.npmExecPrefix} install-native`));
  assert.doesNotMatch(readme, new RegExp(`${escapeRegExp(stable.npmExecPrefix)} install-native --extension-id <chrome-extension-id>`));
  assert.ok(readme.includes(`${stable.npmExecPrefix} doctor`));
  assert.ok(readme.includes(`${stable.npmExecPrefix} uninstall-native`));
  assert.match(readme, /npm installs, updates, and uninstalls the coordinated managed extension\/native pair/i);
  assert.match(readme, /legacy `install-native` command remains available only for explicitly unmanaged extension directories/i);
  assert.match(readme, /Use `--extension-id <chrome-extension-id>` only for a custom\/dev unpacked extension id/i);
  assert.doesNotMatch(readme, /Chrome Web Store once published/i);
  assert.doesNotMatch(readme, /version-0\.4\.0-blue/);
  assert.doesNotMatch(readme, /platform-macOS-lightgrey/);
});

test('README documents Windows source installer with bundled extension id default', () => {
  const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
  const stable = readStableReleaseMetadata(readme);
  const installCommand = `iwr ${stable.windowsInstallUrl} -OutFile install.ps1`;
  const installIndex = readme.indexOf(installCommand);

  assert.notEqual(installIndex, -1, 'expected Windows source installer download command');
  const segment = readme.slice(installIndex, installIndex + 320);
  assert.ok(segment.includes(stable.windowsRefCommand), segment);
  assert.ok(segment.includes(stable.windowsRunCommand), segment);
  assert.ok(
    segment.indexOf(stable.windowsRefCommand) < segment.indexOf(stable.windowsRunCommand),
    segment
  );
});

test('README documents Windows cleanup roots and Codex skill loading boundaries', () => {
  const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
  const uninstallSection = readme.match(/<summary><strong>Uninstall<\/strong><\/summary>[\s\S]*?<\/details>/)?.[0] || '';

  assert.match(uninstallSection, /%LOCALAPPDATA%\\CodexOverleaf/i);
  assert.match(uninstallSection, /%USERPROFILE%\\.codex-overleaf/i);
  assert.doesNotMatch(
    uninstallSection,
    /\$env:LOCALAPPDATA\\CodexOverleaf` on Windows to remove local mirrors, native runtime files, and plugin history/i
  );
  assert.match(readme, /Remove-Item -Recurse -Force "\$env:LOCALAPPDATA\\CodexOverleaf", "\$env:USERPROFILE\\.codex-overleaf"/);

  assert.match(readme, /`Load local Codex skills`[\s\S]{0,800}~\/\.codex\/skills/);
  assert.match(readme, /`Load local Codex skills`[\s\S]{0,800}plugins/);
  assert.match(readme, /`Load Codex Overleaf skills`[\s\S]{0,800}~\/\.codex-overleaf\/skills/);
  assert.match(readme, /skill loading toggles default to enabled/i);
  assert.match(readme, /isolated `~\/\.codex-overleaf\/codex-home`/i);
  assert.match(readme, /does not write to or reuse global `~\/\.codex\/sessions`/i);
});

test('one-command installer works on macOS Bash 3.2 with bundled extension id default', t => {
  if (process.platform === 'win32') {
    t.skip('macOS shell installer behavior is covered on POSIX runners');
    return;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-install-test-'));
  const binDir = path.join(tempDir, 'bin');
  const installDir = path.join(tempDir, 'source');
  const visibleExtensionLink = path.join(tempDir, 'Codex Overleaf Link Extension');
  const nodeLog = path.join(tempDir, 'node-args.json');
  const npmLog = path.join(tempDir, 'npm-args.txt');
  const openLog = path.join(tempDir, 'open-args.txt');
  const pbcopyLog = path.join(tempDir, 'pbcopy.txt');
  fs.mkdirSync(binDir, { recursive: true });

  fs.writeFileSync(path.join(binDir, 'git'), [
    '#!/bin/bash',
    'if [ "$1" = "clone" ]; then',
    '  target=""',
    '  for arg in "$@"; do target="$arg"; done',
    '  mkdir -p "$target/.git"',
    '  mkdir -p "$target/extension"',
    `  printf '{"version":"${CURRENT_PACKAGE_VERSION}"}\\n' > "$target/package.json"`,
    '  exit 0',
    'fi',
    'exit 0'
  ].join('\n'));
  fs.writeFileSync(path.join(binDir, 'node'), [
    '#!/bin/bash',
    `for arg in "$@"; do printf '%s\\n' "$arg"; done > "${nodeLog}"`,
    `echo '{"version":"${CURRENT_PACKAGE_VERSION}","extensionRoot":"'"$HOME"'/.codex-overleaf/managed/extension","nativeRoot":"'"$HOME"'/.codex-overleaf/managed/native"}'`,
    'exit 0'
  ].join('\n'));
  fs.writeFileSync(path.join(binDir, 'npm'), [
    '#!/bin/bash',
    `printf '%s\\n' "$*" >> "${npmLog}"`,
    'exit 0'
  ].join('\n'));
  fs.writeFileSync(path.join(binDir, 'open'), [
    '#!/bin/bash',
    `for arg in "$@"; do printf '%s\\n' "$arg"; done >> "${openLog}"`,
    'exit 0'
  ].join('\n'));
  fs.writeFileSync(path.join(binDir, 'pbcopy'), [
    '#!/bin/bash',
    `cat > "${pbcopyLog}"`,
    'exit 0'
  ].join('\n'));
  fs.chmodSync(path.join(binDir, 'git'), 0o755);
  fs.chmodSync(path.join(binDir, 'node'), 0o755);
  fs.chmodSync(path.join(binDir, 'npm'), 0o755);
  fs.chmodSync(path.join(binDir, 'open'), 0o755);
  fs.chmodSync(path.join(binDir, 'pbcopy'), 0o755);

  const result = spawnSync('/bin/bash', [path.join(__dirname, '../install.sh')], {
    env: {
      HOME: tempDir,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      CODEX_OVERLEAF_REPO_URL: 'https://example.invalid/repo.git',
      CODEX_OVERLEAF_INSTALL_DIR: installDir
    },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /CODEX_OVERLEAF_REF: main/);
  assert.match(result.stdout, new RegExp(`Package version: ${escapeRegExp(CURRENT_PACKAGE_VERSION)}`));
  assert.match(result.stdout, /managed extension and native host are installed/);
  assert.ok(result.stdout.includes(`Extension path: ${path.join(tempDir, '.codex-overleaf', 'managed', 'extension')}`));
  assert.match(result.stdout, /Reload the Chrome extension/);
  assert.match(result.stdout, /Refresh the Overleaf page/);
  const nodeArgs = fs.readFileSync(nodeLog, 'utf8');
  assert.match(nodeArgs, /scripts\/install-managed\.mjs/);
  assert.match(nodeArgs, /--json/);
  assert.doesNotMatch(nodeArgs, /--extension-id/);
  assert.deepEqual(
    fs.readFileSync(npmLog, 'utf8').trim().split('\n'),
    ['ci', 'run build:content']
  );
  assert.equal(fs.readlinkSync(visibleExtensionLink), path.join(tempDir, '.codex-overleaf', 'managed', 'extension'));
  assert.equal(fs.readFileSync(pbcopyLog, 'utf8'), visibleExtensionLink);
  const openArgs = fs.readFileSync(openLog, 'utf8');
  assert.match(openArgs, /-a\nGoogle Chrome\nchrome:\/\/extensions/);
  assert.match(openArgs, /-R/);
  assert.match(openArgs, /Codex Overleaf Link Extension/);
});

test('one-command shell installer refuses dangerous or unmarked existing source directories', t => {
  if (process.platform === 'win32') {
    t.skip('POSIX shell installer safety is covered on POSIX runners');
    return;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-install-safe-'));
  const existing = path.join(home, 'existing-source');
  const sentinel = path.join(existing, 'keep.txt');
  fs.mkdirSync(existing, { recursive: true });
  fs.writeFileSync(sentinel, 'keep\n');
  try {
    const existingResult = spawnSync('/bin/bash', [path.join(__dirname, '../install.sh')], {
      env: { ...process.env, HOME: home, CODEX_OVERLEAF_INSTALL_DIR: existing },
      encoding: 'utf8'
    });
    assert.notEqual(existingResult.status, 0);
    assert.match(existingResult.stderr, /Refusing to replace an existing unmarked source directory/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep\n');

    const homeResult = spawnSync('/bin/bash', [path.join(__dirname, '../install.sh')], {
      env: { ...process.env, HOME: home, CODEX_OVERLEAF_INSTALL_DIR: home },
      encoding: 'utf8'
    });
    assert.notEqual(homeResult.status, 0);
    assert.match(homeResult.stderr, /Refusing unsafe install directory/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
