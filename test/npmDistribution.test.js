const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const packageJson = require('../package.json');
const cliPath = path.join(repoRoot, 'bin/codex-overleaf-link.mjs');
const validExtensionId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: options.env || process.env
  });
}

function makeIsolatedCliEnv(tempDir) {
  return {
    ...process.env,
    HOME: tempDir,
    USERPROFILE: tempDir,
    LOCALAPPDATA: path.join(tempDir, 'LocalAppData'),
    APPDATA: path.join(tempDir, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: path.join(tempDir, '.config')
  };
}

function makeIsolatedNpmEnv(tempDir) {
  const cacheDir = path.join(tempDir, 'npm-cache');
  const userConfigPath = path.join(tempDir, 'npm-userconfig');

  return {
    ...makeIsolatedCliEnv(tempDir),
    npm_config_cache: cacheDir,
    npm_config_userconfig: userConfigPath,
    NPM_CONFIG_CACHE: cacheDir,
    NPM_CONFIG_USERCONFIG: userConfigPath
  };
}

function makeTarballSmokeEnv(tempDir, options = {}) {
  const platform = options.platform || process.platform;
  const env = makeIsolatedNpmEnv(tempDir);
  const fakeCodex = createFakeCodexCommand(tempDir, platform);
  const fakeRegistry = platform === 'win32'
    ? createFakeWindowsRegistryCommand(tempDir)
    : null;

  prependPath(env, fakeCodex.binDir);
  if (fakeRegistry) {
    prependPath(env, fakeRegistry.binDir);
    env.CODEX_OVERLEAF_REG_EXE = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
    env.CODEX_OVERLEAF_REG_EXE_ARGS_JSON = JSON.stringify(['/d', '/s', '/c', fakeRegistry.cmdPath]);
    env.CODEX_OVERLEAF_FAKE_REG_LOG = fakeRegistry.logPath;
    env.CODEX_OVERLEAF_FAKE_REG_RECORDER = fakeRegistry.recorderPath;
    env.CODEX_OVERLEAF_FAKE_NODE_EXE = process.execPath;
  }

  return { env, fakeRegistry };
}

function prependPath(env, dir) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const currentPath = env[pathKey] || '';
  env[pathKey] = currentPath ? `${dir}${path.delimiter}${currentPath}` : dir;
}

function getPathValue(env) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  return env[pathKey] || '';
}

function createFakeWindowsRegistryCommand(tempDir) {
  const binDir = path.join(tempDir, 'fake-registry-bin');
  const logPath = path.join(tempDir, 'fake-registry-calls.jsonl');
  const recorderPath = path.join(binDir, 'record-reg-call.cjs');
  const cmdPath = path.join(binDir, 'reg.cmd');

  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(recorderPath, [
    "const fs = require('node:fs');",
    "const logPath = process.env.CODEX_OVERLEAF_FAKE_REG_LOG;",
    "if (!logPath) {",
    "  console.error('Missing CODEX_OVERLEAF_FAKE_REG_LOG');",
    "  process.exit(2);",
    "}",
    "fs.appendFileSync(logPath, `${JSON.stringify(process.argv.slice(2))}\\n`);",
    ''
  ].join('\n'));
  fs.writeFileSync(cmdPath, [
    '@echo off',
    '"%CODEX_OVERLEAF_FAKE_NODE_EXE%" "%CODEX_OVERLEAF_FAKE_REG_RECORDER%" %*',
    'exit /b %ERRORLEVEL%',
    ''
  ].join('\r\n'));

  return { binDir, cmdPath, logPath, recorderPath };
}

function createFakeCodexCommand(tempDir, platform = process.platform) {
  const binDir = path.join(tempDir, 'fake-codex-bin');
  fs.mkdirSync(binDir, { recursive: true });
  if (platform === 'win32') {
    const cmdPath = path.join(binDir, 'codex.cmd');
    fs.writeFileSync(cmdPath, [
      '@echo off',
      'echo codex 1.0.0',
      'exit /b 0',
      ''
    ].join('\r\n'));
    return { binDir, cmdPath };
  }

  const scriptPath = path.join(binDir, 'codex');
  fs.writeFileSync(scriptPath, [
    '#!/bin/sh',
    'echo "codex 1.0.0"',
    'exit 0',
    ''
  ].join('\n'));
  fs.chmodSync(scriptPath, 0o755);
  return { binDir, scriptPath };
}

function readFakeRegistryCalls(logPath) {
  return fs.readFileSync(logPath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function runNpm(args, options = {}) {
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    env: options.env || process.env,
    shell: process.platform === 'win32',
    windowsHide: true
  });
}

function installedPackageBinPath(prefix) {
  return path.join(
    prefix,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'codex-overleaf-link.cmd' : 'codex-overleaf-link'
  );
}

function runInstalledCli(prefix, args, options = {}) {
  return spawnSync(installedPackageBinPath(prefix), args, {
    cwd: options.cwd || prefix,
    encoding: 'utf8',
    env: options.env || process.env,
    shell: process.platform === 'win32',
    windowsHide: true
  });
}

function manifestPathForHome(tempDir, browser = 'chrome') {
  if (process.platform === 'darwin') {
    const browserDir = browser === 'chromium' ? 'Chromium' : 'Google/Chrome';
    return path.join(tempDir, 'Library/Application Support', browserDir, 'NativeMessagingHosts', 'com.codex.overleaf.json');
  }
  if (process.platform === 'linux') {
    const browserDir = browser === 'chromium' ? '.config/chromium' : '.config/google-chrome';
    return path.join(tempDir, browserDir, 'NativeMessagingHosts', 'com.codex.overleaf.json');
  }
  if (process.platform === 'win32') {
    return path.join(tempDir, 'LocalAppData', 'codex-overleaf', 'native-messaging-hosts', 'com.codex.overleaf.json');
  }
  throw new Error(`Unsupported test platform: ${process.platform}`);
}

function bridgePathForHome(tempDir) {
  if (process.platform === 'win32') {
    return path.join(tempDir, 'LocalAppData', 'CodexOverleaf', 'codex-overleaf-bridge.cmd');
  }
  return path.join(tempDir, '.codex-overleaf', 'codex-overleaf-bridge');
}

test('package metadata is configured for npm distribution', () => {
  assert.equal(packageJson.name, 'codex-overleaf-link');
  assert.equal(packageJson.version, '2.1.5');
  assert.equal(packageJson.bin['codex-overleaf-link'], 'bin/codex-overleaf-link.mjs');
  assert.match(packageJson.packageManager, /^npm@/);
  assert.deepEqual(packageJson.repository, {
    type: 'git',
    url: 'git+https://github.com/Ghqqqq/codex-overleaf-link.git'
  });
  assert.ok(packageJson.files.includes('bin/'));
});

test('version command prints the package version', () => {
  const result = runCli(['version']);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim(), packageJson.version);
});

test('version command supports json output', () => {
  const result = runCli(['version', '--json']);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { packageVersion: packageJson.version });
});

test('help command lists available commands', () => {
  const result = runCli(['help']);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Commands:/);
  assert.match(result.stdout, /install-native/);
  assert.match(result.stdout, /uninstall-native/);
  assert.match(result.stdout, /doctor/);
  assert.match(result.stdout, /version/);
  assert.match(result.stdout, /help/);
});

test('doctor command supports json output', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-cli-doctor-json-'));
  try {
    const result = runCli([
      'doctor',
      '--json',
      '--browser',
      'chrome',
      '--runtime-root',
      path.join(tempDir, 'runtime')
    ], {
      env: makeIsolatedCliEnv(tempDir)
    });

    assert.equal(result.status, 2);
    assert.equal(result.stderr, '');
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.status, 'missing_install');
    assert.equal(body.browser, 'chrome');
    assert.match(body.manifest.path, /^~/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('doctor command supports human output', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-cli-doctor-human-'));
  try {
    const result = runCli(['doctor', '--browser', 'chrome'], {
      env: makeIsolatedCliEnv(tempDir)
    });

    assert.equal(result.status, 2);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /Native host doctor/);
    assert.match(result.stdout, /missing_install/);
    assert.doesNotMatch(result.stdout, /not implemented yet/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('unknown command exits with an error', () => {
  const result = runCli(['missing-command']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command/);
});

test('tarball smoke Windows registry isolation routes writes through fake reg command', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-reg-isolation-'));
  try {
    const { env, fakeRegistry } = makeTarballSmokeEnv(tempDir, { platform: 'win32' });

    assert.ok(fakeRegistry);
    assert.equal(path.basename(fakeRegistry.cmdPath).toLowerCase(), 'reg.cmd');
    assert.equal(getPathValue(env).split(path.delimiter)[0], fakeRegistry.binDir);
    assert.equal(JSON.parse(env.CODEX_OVERLEAF_REG_EXE_ARGS_JSON).at(-1), fakeRegistry.cmdPath);
    assert.equal(env.CODEX_OVERLEAF_FAKE_REG_LOG, fakeRegistry.logPath);
    assert.equal(fs.existsSync(fakeRegistry.cmdPath), true);
    assert.equal(fs.existsSync(fakeRegistry.recorderPath), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('test PATH prepending preserves existing environment variable casing', () => {
  const env = { Path: 'C:\\Windows\\System32' };

  prependPath(env, 'C:\\fake-bin');

  assert.equal(env.Path, `C:\\fake-bin${path.delimiter}C:\\Windows\\System32`);
  assert.equal(Object.hasOwn(env, 'PATH'), false);
});

test('packed npm tarball installs executable CLI and manages temp native host', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-npm-tarball-smoke-'));
  const installPrefix = path.join(tempDir, 'prefix');
  const runtimeRoot = path.join(tempDir, 'runtime');
  const runtimeRootArgs = process.platform === 'win32' ? [] : ['--runtime-root', runtimeRoot];
  const tarballName = `${packageJson.name}-${packageJson.version}.tgz`;
  const tarballPath = path.join(tempDir, tarballName);
  const { env, fakeRegistry } = makeTarballSmokeEnv(tempDir);

  try {
    fs.rmSync(tarballPath, { force: true });

    const pack = runNpm(['pack', '--pack-destination', tempDir], { env });
    assert.equal(pack.status, 0, pack.stderr || pack.stdout);
    assert.equal(fs.existsSync(tarballPath), true);

    const install = runNpm([
      'install',
      '--prefix',
      installPrefix,
      tarballPath,
      '--no-audit',
      '--fund=false'
    ], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);
    assert.equal(fs.existsSync(installedPackageBinPath(installPrefix)), true);

    const version = runInstalledCli(installPrefix, ['version'], { env });
    assert.equal(version.status, 0, version.stderr || version.stdout);
    assert.equal(version.stdout.trim(), packageJson.version);

    const help = runInstalledCli(installPrefix, ['help'], { env });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Commands:/);

    const unknown = runInstalledCli(installPrefix, ['missing-command'], { env });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown command/);

    const doctorBeforeInstall = runInstalledCli(installPrefix, ['doctor', '--json'], { env });
    assert.equal(doctorBeforeInstall.status, 2, doctorBeforeInstall.stderr || doctorBeforeInstall.stdout);
    assert.equal(doctorBeforeInstall.stderr, '');
    const beforeInstallBody = JSON.parse(doctorBeforeInstall.stdout);
    assert.equal(beforeInstallBody.ok, false);
    assert.equal(beforeInstallBody.status, 'missing_install');

    const installNative = runInstalledCli(installPrefix, [
      'install-native',
      '--extension-id',
      validExtensionId,
      ...runtimeRootArgs,
      '--json'
    ], { env });
    assert.equal(installNative.status, 0, installNative.stderr || installNative.stdout);

    const doctorAfterInstall = runInstalledCli(installPrefix, [
      'doctor',
      '--json',
      ...runtimeRootArgs
    ], { env });
    assert.equal(doctorAfterInstall.status, 0, doctorAfterInstall.stderr || doctorAfterInstall.stdout);

    const uninstallNative = runInstalledCli(installPrefix, [
      'uninstall-native',
      ...runtimeRootArgs,
      '--json'
    ], { env });
    assert.equal(uninstallNative.status, 0, uninstallNative.stderr || uninstallNative.stdout);

    const doctorAfterUninstall = runInstalledCli(installPrefix, [
      'doctor',
      '--json',
      ...runtimeRootArgs
    ], { env });
    assert.equal(doctorAfterUninstall.status, 2, doctorAfterUninstall.stderr || doctorAfterUninstall.stdout);
    assert.equal(doctorAfterUninstall.stderr, '');
    const afterUninstallBody = JSON.parse(doctorAfterUninstall.stdout);
    assert.equal(afterUninstallBody.ok, false);
    assert.equal(afterUninstallBody.status, 'missing_install');

    if (process.platform === 'win32') {
      assert.ok(fakeRegistry);
      assert.equal(getPathValue(env).split(path.delimiter)[0], fakeRegistry.binDir);
      const registryCalls = readFakeRegistryCalls(fakeRegistry.logPath);
      assert.deepEqual(registryCalls.map((call) => call[0]), ['add', 'delete']);
      assert.equal(registryCalls.every((call) => call[1].startsWith('HKCU\\')), true);
    }
  } finally {
    fs.rmSync(tarballPath, { force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('install-native with valid extension id writes manifest and reports json', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-cli-install-json-'));
  try {
    const runtimeRoot = path.join(tempDir, 'runtime');
    const result = runCli([
      'install-native',
      '--extension-id',
      validExtensionId,
      '--browser',
      'chrome',
      '--runtime-root',
      runtimeRoot,
      '--json'
    ], {
      env: makeIsolatedCliEnv(tempDir)
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.manifest.allowedOrigin, `chrome-extension://${validExtensionId}/`);
    assert.ok(body.manifest.allowedOrigins.includes(`chrome-extension://${validExtensionId}/`));
    assert.equal(JSON.parse(fs.readFileSync(manifestPathForHome(tempDir), 'utf8')).allowed_origins.includes(`chrome-extension://${validExtensionId}/`), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('install-native rejects invalid extension id', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-cli-install-invalid-'));
  try {
    const result = runCli([
      'install-native',
      '--extension-id',
      'invalid-extension-id',
      '--runtime-root',
      path.join(tempDir, 'runtime'),
      '--json'
    ], {
      env: makeIsolatedCliEnv(tempDir)
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid Chrome extension id/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('install-native without extension id defaults to bundled extension id', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-cli-install-default-id-'));
  try {
    const result = runCli([
      'install-native',
      '--runtime-root',
      path.join(tempDir, 'runtime'),
      '--json'
    ], {
      env: makeIsolatedCliEnv(tempDir)
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const body = JSON.parse(result.stdout);
    assert.equal(body.extensionId, 'illdpneeeopfffmiepaejglgmhpmdhdc');
    assert.deepEqual(body.manifest.allowedOrigins, ['chrome-extension://illdpneeeopfffmiepaejglgmhpmdhdc/']);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('uninstall-native --keep-runtime removes manifest and keeps runtime', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-cli-uninstall-keep-'));
  try {
    const runtimeRoot = path.join(tempDir, 'runtime');
    const env = makeIsolatedCliEnv(tempDir);
    const install = runCli([
      'install-native',
      '--extension-id',
      validExtensionId,
      '--runtime-root',
      runtimeRoot,
      '--json'
    ], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const uninstall = runCli([
      'uninstall-native',
      '--runtime-root',
      runtimeRoot,
      '--keep-runtime',
      '--json'
    ], { env });

    assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
    assert.equal(uninstall.stderr, '');
    const body = JSON.parse(uninstall.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.keepRuntime, true);
    assert.equal(body.manifest.removed, true);
    assert.equal(fs.existsSync(manifestPathForHome(tempDir)), false);
    assert.equal(fs.existsSync(bridgePathForHome(tempDir)), false);
    assert.equal(fs.existsSync(runtimeRoot), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('uninstall-native full failure leaves manifest and bridge intact for unmarked runtime', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-cli-uninstall-unmarked-'));
  try {
    const runtimeRoot = path.join(tempDir, 'runtime');
    const env = makeIsolatedCliEnv(tempDir);
    const install = runCli([
      'install-native',
      '--extension-id',
      validExtensionId,
      '--runtime-root',
      runtimeRoot,
      '--json'
    ], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);
    assert.equal(fs.existsSync(manifestPathForHome(tempDir)), true);
    assert.equal(fs.existsSync(bridgePathForHome(tempDir)), true);
    fs.rmSync(path.join(runtimeRoot, '.codex-overleaf-runtime.json'), { force: true });

    const uninstall = runCli([
      'uninstall-native',
      '--runtime-root',
      runtimeRoot,
      '--json'
    ], { env });

    assert.equal(uninstall.status, 1);
    assert.match(uninstall.stderr, /Refusing to remove unmarked runtime root/);
    assert.equal(fs.existsSync(manifestPathForHome(tempDir)), true);
    assert.equal(fs.existsSync(bridgePathForHome(tempDir)), true);
    assert.equal(fs.existsSync(runtimeRoot), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('uninstall-native removes marked runtime when safe', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-cli-uninstall-full-'));
  try {
    const runtimeRoot = path.join(tempDir, 'runtime');
    const env = makeIsolatedCliEnv(tempDir);
    const install = runCli([
      'install-native',
      '--extension-id',
      validExtensionId,
      '--runtime-root',
      runtimeRoot,
      '--json'
    ], { env });
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const uninstall = runCli([
      'uninstall-native',
      '--runtime-root',
      runtimeRoot,
      '--json'
    ], { env });

    assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
    assert.equal(uninstall.stderr, '');
    const body = JSON.parse(uninstall.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.keepRuntime, false);
    assert.equal(body.runtime.removed, true);
    assert.equal(fs.existsSync(manifestPathForHome(tempDir)), false);
    assert.equal(fs.existsSync(runtimeRoot), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('install-native rejects unknown option', () => {
  const result = runCli(['install-native', '--unknown-option']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option/);
});

test('install-native rejects missing option value', () => {
  const result = runCli(['install-native', '--extension-id']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing value/);
});


test('npm package verifier rejects forbidden package paths and allows runtime paths', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'scripts/verify-npm-package.mjs')).href;
  const { findForbiddenNpmPackagePaths } = await import(moduleUrl);

  const forbiddenPaths = [
    'package/docs/guide.md',
    'package/specs/api.md',
    'package/superpowers/internal.md',
    'package/private/token.txt',
    'package/test/npmDistribution.test.js',
    'package/tests/fixture.test.js',
    'package/fixtures/sample.json',
    'package/dist/bundle.js',
    'package/.github/workflows/release.yml',
    'package/node_modules/dependency/index.js',
    'package/config/.env',
    'package/config/.env.local',
    'package/config/.env.production',
    'package/certificates/dev.pem',
    'package/certificates/dev.key',
    'package/certificates/profile.p12'
  ];
  const allowedPaths = [
    'package/native-host/src/index.js',
    'package/extension/src/shared/compatibility.js'
  ];

  assert.deepEqual(findForbiddenNpmPackagePaths([...forbiddenPaths, ...allowedPaths]), [...forbiddenPaths].sort());
});

test('npm package exact manifest checker reports missing and extra files', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'scripts/verify-npm-package.mjs')).href;
  const { compareExactManifest, verifyPackagePaths } = await import(moduleUrl);
  const expected = [
    'package/package.json',
    'package/native-host/src/index.js',
    'package/extension/src/shared/compatibility.js'
  ];
  const actual = [
    'package/package.json',
    'package/extension/src/shared/compatibility.js',
    'package/bin/extra.mjs'
  ];

  assert.deepEqual(compareExactManifest(actual, expected), {
    missing: ['package/native-host/src/index.js'],
    extra: ['package/bin/extra.mjs']
  });

  const result = verifyPackagePaths(actual, expected);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['package/native-host/src/index.js']);
  assert.deepEqual(result.extra, ['package/bin/extra.mjs']);
});

test('npm package verifier CLI checks actual package contents by default', () => {
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts/verify-npm-package.mjs')
  ], {
    cwd: repoRoot,
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Verified npm package manifest/);
  assert.equal(result.stderr, '');
});

test('npm package verifier CLI checks newline file lists', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'scripts/verify-npm-package.mjs')).href;
  const { readExpectedManifest } = await import(moduleUrl);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-npm-package-'));
  try {
    const fileListPath = path.join(tempDir, 'files.txt');
    fs.writeFileSync(fileListPath, `${readExpectedManifest().join('\n')}\n`);

    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts/verify-npm-package.mjs'),
      '--file-list',
      fileListPath
    ], {
      cwd: repoRoot,
      encoding: 'utf8'
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Verified npm package manifest/);
    assert.equal(result.stderr, '');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


test('npm package verifier rejects removed tarball mode with usage', () => {
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts/verify-npm-package.mjs'),
    '--tarball',
    path.join(os.tmpdir(), 'not-current-package.tgz')
  ], {
    cwd: repoRoot,
    encoding: 'utf8'
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
  assert.doesNotMatch(result.stderr, /--tarball/);
  assert.equal(result.stdout, '');
});
