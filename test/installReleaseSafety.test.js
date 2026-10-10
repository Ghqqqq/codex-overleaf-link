'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const vm = require('node:vm'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { extractFunction } = require('./_helpers/extractFunction');
const root = path.resolve(__dirname, '..');
const Platform = require('../native-host/src/nativeHostPlatform');
const Registration = require('../native-host/src/nativeHostRegistration');
const Compatibility = require('../extension/src/shared/compatibility');
const { encodeMessage } = require('../native-host/src/nativeMessaging');
const Trust = require('../native-host/src/updateTrust');
function load(relative, overrides = {}) {
  const file = path.join(root, relative), actualRequire = createRequire(file), module = { exports: {} };
  const run = vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file });
  run(name => Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : actualRequire(name), module, module.exports, path.dirname(file), file);
  return module.exports;
}
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'col-install-safety-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function doctorFixture(registration) {
  const env = { USERPROFILE: 'C:\\Users\\fixture', LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local' };
  const target = Platform.getNativeHostRegistrationTarget({ platform: 'win32', browser: 'chrome', env });
  const bridge = 'C:\\Users\\fixture\\AppData\\Local\\CodexOverleaf\\bridge.cmd';
  const calls = [], payload = { id: 'doctor-ping', ok: true, result: { version: Compatibility.BUILD_TARGET_VERSION,
    platform: 'win32', protocolVersion: 2, supportedProtocol: { min: 1, max: 2 }, minExtensionVersion: '1.0.0',
    capabilities: Object.fromEntries(Compatibility.REQUIRED_CAPABILITIES.map(name => [name, true])), environment: { codex: { ok: true } } } };
  const spawn = (command, args) => {
    calls.push({ command, args }); const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter(); child.kill = () => {};
    child.stdin.end = () => queueMicrotask(() => { child.stdout.emit('data', encodeMessage(payload)); child.emit('close', 0, null); }); return child;
  };
  const query = (command, args) => {
    calls.push({ command, args }); assert.equal(args[0], 'query'); assert.equal(args[1], target.registryKey); assert.equal(args[2], '/ve');
    return registration === null ? { status: 1, stdout: '', stderr: 'query unavailable' }
      : { status: 0, stdout: target.registryKey + '\r\n    (Default)    REG_SZ    ' + (registration || target.manifestPath) + '\r\n', stderr: '' };
  };
  const doctor = load('native-host/src/nativeDoctor.js', {
    'node:fs': { ...fs, readFileSync(name) {
      assert.equal(name, target.manifestPath); return JSON.stringify({ name: 'com.codex.overleaf', type: 'stdio', path: bridge,
        allowed_origins: ['chrome-extension://' + 'abcdefghijklmnopabcdefghijklmnop' + '/'] });
    }, statSync(name) { assert.equal(name, bridge); return { isFile: () => true }; } },
    'node:child_process': { spawn }
  });
  return { run: () => doctor.runDoctor({ platform: 'win32', env, browser: 'chrome', spawnSync: query }), calls };
}
for (const [label, registration, healthy] of [['valid', '', true], ['missing', null, false], ['wrong-target', 'C:\\Other\\manifest.json', false]]) {
  test('Windows Doctor requires browser registration evidence: ' + label, async () => {
    const h = doctorFixture(registration), result = await h.run();
    assert.equal(result.body.ping.ok, true, 'direct bridge still works in every control');
    assert.equal(result.body.ok, healthy); assert.equal(result.exitCode === 0, healthy);
    assert.equal(h.calls.some(call => call.args[0] === 'query'), true);
  });
}
function installerLocations(home, platform = process.platform) {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const env = { ...process.env, HOME: home, USERPROFILE: home,
    LOCALAPPDATA: platformPath.join(home, 'AppData', 'Local') };
  return { platform, env,
    target: Platform.getNativeHostRegistrationTarget({ platform, browser: 'chrome', env }),
    bridge: Platform.getDefaultBridgePath({ platform, env }) };
}
test('installer fixture registration paths retain the temporary home under Windows path semantics', () => {
  const home = 'C:\\Users\\fixture\\AppData\\Local\\Temp\\col-install-safety';
  const { env, target, bridge } = installerLocations(home, 'win32');
  for (const filename of [env.LOCALAPPDATA, target.manifestPath, bridge]) {
    assert.equal(path.win32.isAbsolute(filename), true);
    assert.equal(path.win32.relative(home, filename).startsWith('..'), false);
  }
  assert.throws(() => Platform.getNativeHostRegistrationTarget({ platform: 'linux', browser: 'chrome', env }), /must be absolute/);
});
function installerFixture(t) {
  const home = temporary(t), registry = new Map(), calls = [];
  const { platform, env, target, bridge } = installerLocations(home);
  const registration = { ...target, kind: 'registry', registryKey: 'HKCU\\fixture-native-host' };
  const spawnSync = (command, args) => {
    calls.push(args);
    if (args[0] === 'add') { registry.set(args[1], args[args.indexOf('/d') + 1]); return { status: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'delete') { registry.delete(args[1]); return { status: 0, stdout: '', stderr: '' }; }
    assert.equal(args[0], 'query'); const value = registry.get(args[1]);
    return value ? { status: 0, stdout: args[1] + '\n    (Default)    REG_SZ    ' + value + '\n', stderr: '' }
      : { status: 1, stdout: '', stderr: 'missing' };
  };
  const install = load('native-host/src/managedInstall.js', { 'node:child_process': { spawnSync },
    './nativeHostPlatform': { ...Platform, getNativeHostRegistrationTarget: () => registration,
      getDefaultBridgePath: () => bridge },
    './nativeHostRegistration': { queryWindowsNativeHostRegistration: (target, options) => Registration.queryWindowsNativeHostRegistration(target, { ...options, spawnSync }) } });
  const options = managedRoot => ({ packageRoot: root, managedRoot, platform, browser: 'chrome', env });
  return { home, env, install, options, registry, calls, registration, bridge };
}
test('uninstalling old managed A preserves B shared bridge, manifest and browser registration', t => {
  const h = installerFixture(t), a = path.join(h.home, 'A'), b = path.join(h.home, 'B');
  h.install.installManagedDistribution(h.options(a)); h.install.installManagedDistribution(h.options(b));
  const bridge = fs.readFileSync(h.bridge, 'utf8'), manifest = fs.readFileSync(h.registration.manifestPath, 'utf8');
  h.install.uninstallManagedDistribution(h.options(a));
  assert.equal(fs.existsSync(a), false); assert.equal(fs.existsSync(path.join(b, 'native/active-version')), true);
  assert.equal(fs.readFileSync(h.bridge, 'utf8'), bridge); assert.equal(fs.readFileSync(h.registration.manifestPath, 'utf8'), manifest);
  assert.equal(h.registry.get(h.registration.registryKey), h.registration.manifestPath);
  h.install.uninstallManagedDistribution(h.options(b));
  assert.equal(fs.existsSync(h.bridge), false); assert.equal(fs.existsSync(h.registration.manifestPath), false); assert.equal(h.registry.size, 0);
});
test('uninstall preserves a registry entry changed to another manifest', t => {
  const h = installerFixture(t), a = path.join(h.home, 'A'); h.install.installManagedDistribution(h.options(a));
  h.registry.set(h.registration.registryKey, path.join(h.home, 'another.json'));
  h.install.uninstallManagedDistribution(h.options(a));
  assert.equal(h.registry.get(h.registration.registryKey), path.join(h.home, 'another.json'));
});
function signedFixture(t) {
  const dir = temporary(t), bundle = 'codex-overleaf-update-v2.5.0.tar.gz';
  const tree = path.join(dir, 'tree');
  const files = {
    'extension-runtime/runtime-manifest.json': JSON.stringify({ js: ['src/contentScript.js'], css: ['vendor/katex/katex.min.css'] }),
    'extension-runtime/src/contentScript.js': '// fixture',
    'extension-runtime/vendor/markdown-it/markdown-it.min.js': '// fixture',
    'extension-runtime/vendor/katex/katex.min.css': 'a{src:url(chrome-extension://__MSG_@@extension_id__/runtime/vendor/katex/fonts/KaTeX_Main-Regular.woff2)}',
    'native-runtime/package.json': JSON.stringify({ version: '2.5.0' }),
    'native-runtime/native-host/src/index.js': '// fixture'
  };
  for (const [name, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(tree, name)), { recursive: true }); fs.writeFileSync(path.join(tree, name), content); }
  const packed = spawnSync('tar', ['-czf', path.join(dir, bundle), '-C', tree, ...Object.keys(files)], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const bytes = fs.readFileSync(path.join(dir, bundle)); const keys = crypto.generateKeyPairSync('ed25519');
  const manifest = { schemaVersion: Trust.UPDATE_MANIFEST_SCHEMA, repository: Trust.UPDATE_REPOSITORY, channel: 'stable',
    version: '2.5.0', tag: 'v2.5.0', bootstrapProtocol: Trust.BOOTSTRAP_PROTOCOL, gitCommit: 'a'.repeat(40), createdAt: '2026-10-05T00:00:00Z',
    updateBundle: { name: bundle, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, artifacts: [] };
  const manifestBytes = Buffer.from(JSON.stringify(manifest)); fs.writeFileSync(path.join(dir, 'release-manifest.json'), manifestBytes);
  fs.writeFileSync(path.join(dir, 'release-manifest.sig'), JSON.stringify({ algorithm: 'Ed25519', keyId: 'test-local', signature: crypto.sign(null, manifestBytes, keys.privateKey).toString('base64') }));
  const script = path.join(root, 'scripts/verify-release-artifacts.mjs');
  let source = fs.readFileSync(script, 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '')
    .replace('const require = createRequire(import.meta.url);', '')
    .replaceAll('import.meta.url', JSON.stringify(require('node:url').pathToFileURL(script).href));
  const originalRequire = createRequire(script);
  const context = { fs, path, crypto, spawnSync, process, console,
    fileURLToPath: require('node:url').fileURLToPath,
    require: name => name === '../native-host/src/updateTrust.js' ? { ...Trust,
      verifySignedReleaseManifest: (m, sig, opts) => Trust.verifySignedReleaseManifest(m, sig, { ...opts, publicKeys: { 'test-local': keys.publicKey } })
    } : originalRequire(name) };
  vm.runInNewContext(source + '\nglobalThis.verify = verifyReleaseSignature;globalThis.verifyBundle = verifyUpdateBundle;', context);
  return { dir, bundle, bytes,
    structure: () => { const errors = []; context.verifyBundle(path.join(dir, bundle), errors); return errors; },
    verify: () => { const errors = []; context.verify(dir, errors, { version: '2.5.0', updateBundleName: bundle }); return errors; } };

}
test('release signature verification accepts the exact signed bundle bytes', t => {
  const h = signedFixture(t); assert.deepEqual(h.structure(), []); assert.deepEqual(h.verify(), []);
});
for (const sizeChange of [false, true]) test('release signature verification rejects changed actual bundle, sizeChange=' + sizeChange, t => {
  const h = signedFixture(t), changed = Buffer.from(h.bytes); changed[4] ^= 1;
  const next = sizeChange ? Buffer.concat([changed, require('node:zlib').gzipSync(Buffer.alloc(0))]) : changed;
  assert.deepEqual(require('node:zlib').gunzipSync(next), require('node:zlib').gunzipSync(h.bytes));
  fs.writeFileSync(path.join(h.dir, h.bundle), next);
  assert.deepEqual(h.structure(), [], 'archive checks accept the byte-distinct equivalent payload');
  // The independent checksum file is attacker-consistent; it cannot replace the signed digest.
  fs.writeFileSync(path.join(h.dir, 'SHA256SUMS'), crypto.createHash('sha256').update(fs.readFileSync(path.join(h.dir, h.bundle))).digest('hex') + '  ' + h.bundle + '\n');
  assert.ok(h.verify().some(error => /bundle|size|digest|hash/i.test(error)), 'signed declaration must be checked against actual bytes');
});
function boundaryFixture() {
  let source = fs.readFileSync(path.join(root, 'scripts/verify-update-boundary.mjs'), 'utf8');
  source = source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '')
    .replace("const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');", "const rootDir = '/controlled-boundary';")
    .replace('const require = createRequire(import.meta.url);', 'const require = createRequire(scriptFilename);');
  const context = { process: { env: { CODEX_OVERLEAF_TEST_IMPORT: '1', CODEX_OVERLEAF_UPDATE_BASE_REF: 'v2.4.9' } }, path, crypto, createRequire,
    scriptFilename: path.join(root, 'scripts/verify-update-boundary.mjs'),
    console: { log() {} }, fs: { readFileSync(name) { return name.endsWith('package.json') ? JSON.stringify({ version: '2.5.0' }) : 'const BOOTSTRAP_PROTOCOL = 3;'; } },
    spawnSync(_command, args) {
      let stdout = '';
      if (args[0] === 'diff' && args.includes('native-host/src/launcher.js')) stdout = 'native-host/src/launcher.js';
      if (args[0] === 'show') stdout = args[1].endsWith('package.json') ? JSON.stringify({ version: '2.4.9' }) : 'const BOOTSTRAP_PROTOCOL = 3;';
      return { status: 0, stdout, stderr: '' };
    } };
  vm.runInNewContext(source + '\nglobalThis.verify = verifyUpdateBoundary;', context); return context.verify;
}
test('existing update boundary rejects an outer launcher generator change without protocol migration', () => {
  assert.throws(boundaryFixture(), /launcher\.js|Bootstrap protocol migration/);
});

test('uninstall recognizes an owned Windows launcher without depending on the current Node executable', t => {
  const h = installerFixture(t), a = path.join(h.home, 'A'); h.install.installManagedDistribution(h.options(a));
  const entry = path.win32.join(a, 'native', 'bootstrap', 'launcher.js');
  fs.writeFileSync(h.bridge, require('../native-host/src/launcher').buildLauncher({ platform: 'win32', nodePath: 'C:\\Old Node\\node.exe', bridgeEntryPath: entry, agentPath: entry }));
  h.install.uninstallManagedDistribution({ ...h.options(a), platform: 'win32' });
  assert.equal(fs.existsSync(h.bridge), false); assert.equal(h.registry.size, 0);
});
test('a modified unknown bridge is retained when its managed root is uninstalled', t => {
  const h = installerFixture(t), a = path.join(h.home, 'A'); h.install.installManagedDistribution(h.options(a));
  fs.writeFileSync(h.bridge, '#!/bin/sh\nexec /different/owner\n');
  h.install.uninstallManagedDistribution(h.options(a));
  assert.equal(fs.readFileSync(h.bridge, 'utf8'), '#!/bin/sh\nexec /different/owner\n');
  assert.equal(fs.existsSync(h.registration.manifestPath), true); assert.equal(h.registry.size, 1);
});
