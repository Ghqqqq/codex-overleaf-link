'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const installer = require('../../native-host/src/managedInstall');
const platform = require('../../native-host/src/nativeHostPlatform');
const repo = path.resolve(__dirname, '../..');

function managedFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'col-managed-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const managedRoot = path.join(home, 'managed');
  const discoveryPreload = path.join(root, 'discovery-preload.cjs');
  fs.writeFileSync(discoveryPreload, `const Module=require('node:module');const load=Module._load;
Module._load=function(name){const value=load.apply(this,arguments);
return /(?:^|\\/)nativeEnvironment(?:\\.js)?$/.test(name)?{...value,
buildNativeRuntimeEnv:env=>({...env,CODEX_OVERLEAF_ENV_READY:'1'}),refreshCodexRuntimeEnv:env=>env}:value};\n`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: home,
    NODE_OPTIONS: '--require=' + discoveryPreload, CODEX_HOME: path.join(home, 'codex'),
    CODEX_OVERLEAF_MANAGED: '1', CODEX_OVERLEAF_MANAGED_ROOT: managedRoot,
    CODEX_OVERLEAF_MANAGED_NATIVE_ROOT: path.join(managedRoot, 'native'),
    CODEX_OVERLEAF_MANAGED_EXTENSION_ROOT: path.join(managedRoot, 'extension') };
  const context = { managed: true, nativeRoot: env.CODEX_OVERLEAF_MANAGED_NATIVE_ROOT,
    extensionRoot: env.CODEX_OVERLEAF_MANAGED_EXTENSION_ROOT,
    updatesRoot: path.join(managedRoot, 'native/updates'), env };
  function packageFor(version, suffix = '') {
    const destination = path.join(root, 'package-' + version + suffix);
    if (fs.existsSync(destination)) return destination;
    fs.mkdirSync(destination);
    for (const dir of ['extension', 'native-host', 'scripts']) {
      fs.cpSync(path.join(repo, dir), path.join(destination, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify({
      ...JSON.parse(fs.readFileSync(path.join(repo, 'package.json'))), version
    }));
    const compatibility = path.join(destination, 'extension/src/shared/compatibility.js');
    fs.writeFileSync(compatibility, fs.readFileSync(compatibility, 'utf8')
      .replace(/BUILD_TARGET_VERSION = '[^']+'/, `BUILD_TARGET_VERSION = '${version}'`));
    return destination;
  }
  const options = (version, suffix) => ({ packageRoot: packageFor(version, suffix),
    managedRoot, version, env, platform: process.platform, browser: 'chrome' });
  return { root, home, managedRoot, context, env, packageFor, options,
    install: (version, impl = installer, suffix) => impl.installManagedDistribution(options(version, suffix)),
    registration: platform.getNativeHostRegistrationTarget({ env, platform: process.platform }),
    bridge: platform.getDefaultBridgePath({ env, platform: process.platform }) };
}

function loadWithFs(relative, io) {
  return loadWithDependencies(relative, { 'node:fs': io });
}

function loadWithDependencies(relative, overrides) {
  const filename = path.join(repo, relative), actualRequire = createRequire(filename), module = { exports: {} };
  vm.runInThisContext('(function(require,module,exports,__dirname){\n' + fs.readFileSync(filename, 'utf8') + '\n})', { filename })(
    name => Object.hasOwn(overrides, name) ? overrides[name] : actualRequire(name), module, module.exports, path.dirname(filename));
  return module.exports;
}

function pingInstalled(fixture, method = 'bridge.ping') {
  return new Promise((resolve, reject) => {
    const child = spawn(fixture.bridge, [], { env: fixture.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let bytes = Buffer.alloc(0), response, stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Fixture bridge timeout: ' + stderr)); }, 5000);
    child.stderr.on('data', value => { stderr += value; });
    child.stdout.on('data', value => {
      bytes = Buffer.concat([bytes, value]);
      if (!response && bytes.length >= 4 && bytes.length >= 4 + bytes.readUInt32LE(0)) {
        response = JSON.parse(bytes.subarray(4, 4 + bytes.readUInt32LE(0))); child.stdin.end();
      }
    });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); response ? resolve(response) : reject(new Error(`Fixture bridge exited ${code}: ${stderr}`)); });
    const body = Buffer.from(JSON.stringify({ id: 'fixture-ping', method, params: {} }));
    const frame = Buffer.alloc(4 + body.length); frame.writeUInt32LE(body.length); body.copy(frame, 4); child.stdin.write(frame);
  });
}

async function stageLocalUpdate(fixture, version = '2.5.0') {
  const payload = path.join(fixture.root, 'bundle-' + crypto.randomUUID());
  const tree = path.join(payload, 'managed-extension');
  installer.buildManagedExtensionTree({ packageRoot: fixture.packageFor(version), targetRoot: tree, version });
  const entries = [];
  function walk(directory, prefix) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const sourcePath = path.join(directory, entry.name), archivePath = prefix + '/' + entry.name;
      if (entry.isDirectory()) walk(sourcePath, archivePath);
      else entries.push({ sourcePath, archivePath });
    }
  }
  walk(path.join(tree, 'runtime'), 'extension-runtime');
  for (const entry of require('../../native-host/src/runtimeInstaller').buildRuntimeFileManifest({ packageRoot: fixture.packageFor(version) })) {
    entries.push({ sourcePath: entry.sourcePath, archivePath: 'native-runtime/' + entry.relativePath });
  }
  const archive = path.join(payload, 'bundle.tar.gz');
  require('../../native-host/src/updateArchive').createUpdateBundleArchive({ outputPath: archive, entries });
  const bytes = fs.readFileSync(archive), trust = require('../../native-host/src/updateTrust');
  const keys = crypto.generateKeyPairSync('ed25519');
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, repository: 'Ghqqqq/codex-overleaf-link',
    channel: 'stable', version, tag: 'v' + version, bootstrapProtocol: trust.BOOTSTRAP_PROTOCOL,
    gitCommit: 'a'.repeat(40), createdAt: new Date().toISOString(), artifacts: [],
    updateBundle: { name: `codex-overleaf-update-v${version}.tar.gz`, size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex') } }));
  const signature = Buffer.from(JSON.stringify({ algorithm: 'Ed25519', keyId: 'fixture',
    signature: crypto.sign(null, manifest, keys.privateKey).toString('base64') }));
  const updater = loadWithDependencies('native-host/src/updateManager.js', { './updateTrust': {
    ...trust, verifySignedReleaseManifest: (body, sig, options) => trust.verifySignedReleaseManifest(body, sig,
      { ...options, publicKeys: { fixture: keys.publicKey } })
  } });
  const fetch = async (url, options) => {
    const body = url.endsWith('.json') ? manifest : url.endsWith('.sig') ? signature : bytes;
    return { ok: true, status: 200,
      url: options.method === 'HEAD' ? 'https://github.com/Ghqqqq/codex-overleaf-link/releases/tag/v' + version : url,
      headers: { get: key => key === 'content-length' ? String(body.length) : key === 'etag' ? 'fixture' : '' },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
  async function request(method, params = {}) {
    const response = await updater.handleUpdateRequest({ id: crypto.randomUUID(), method, params }, { env: fixture.env, fetch });
    if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.result;
  }
  const checked = await request('update.check');
  await request('update.authorize', { authorizationId: crypto.randomUUID(), targetVersion: version, currentVersion: checked.currentVersion });
  return request('update.stage');
}

module.exports = { managedFixture, loadWithFs, loadWithDependencies, pingInstalled, stageLocalUpdate };
