'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { loadWithDependencies } = require('./managedUpdateFixture');
const trust = require('../../native-host/src/updateTrust');
const contract = require('../../native-host/src/bootstrapMigrationContract');
const { createUpdateBundleArchive } = require('../../native-host/src/updateArchive');
const oldBootstrap = require('../fixtures/bootstrap-v2.5.0.json');
const { migrationPackageRoot, writeMigrationTemplate } = require('./bootstrapMigrationPackage');
const repo = path.resolve(__dirname, '../..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
function write(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(value) + '\n');
}
function text(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, value);
}

// All installation roots and signing keys are disposable. The source Bootstrap
// is the checked-in published 2.5.0 fixture; no live installation is accessed.
function bootstrapMigrationFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'col-bootstrap-update-'));
  const home = path.join(root, 'home');
  const extensionRoot = path.join(root, 'extension');
  const nativeRoot = path.join(root, 'native');
  const updatesRoot = path.join(nativeRoot, 'updates');
  const watchdogs = new Set();
  t.after(() => {
    for (const pid of watchdogs) if (pid !== process.pid) {
      try { process.kill(pid, 'SIGKILL'); } catch (_) { /* A completed monitor exits itself. */ }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(home);
  fs.mkdirSync(updatesRoot, { recursive: true });
  // Do not carry provider credentials, Codex homes or discovery settings into a
  // subprocess. Runtime discovery is disabled only in the isolated child.
  const env = { PATH: process.env.PATH || '', HOME: home, USERPROFILE: home,
    CODEX_HOME: path.join(home, 'codex'), CODEX_OVERLEAF_ENV_READY: '1',
    CODEX_OVERLEAF_MANAGED: '1', CODEX_OVERLEAF_MANAGED_ROOT: root,
    CODEX_OVERLEAF_MANAGED_NATIVE_ROOT: nativeRoot,
    CODEX_OVERLEAF_MANAGED_EXTENSION_ROOT: extensionRoot };
  const context = { managed: true, nativeRoot, extensionRoot, updatesRoot, env };
  for (const [relative, content] of Object.entries(oldBootstrap.files)) text(path.join(extensionRoot, relative), content);
  const sourceManifest = { ...read(path.join(repo, 'extension/bootstrap/manifest.template.json')), version: '2.5.0' };
  write(path.join(extensionRoot, 'manifest.json'), sourceManifest);
  for (const [kind, directory] of [['extension', extensionRoot], ['native', nativeRoot]]) {
    write(path.join(directory, '.codex-overleaf-managed-' + kind + '.json'), {
      managedBy: 'codex-overleaf-link', kind, bootstrapProtocol: trust.BOOTSTRAP_PROTOCOL, version: '2.5.0'
    });
  }
  text(path.join(nativeRoot, 'active-version'), '2.5.0\n');
  function runtime(directory, version) {
    write(path.join(directory, 'runtime-manifest.json'), { schemaVersion: 1,
      js: ['src/shared/compatibility.js', 'src/main.js'], css: [] });
    text(path.join(directory, 'src/shared/compatibility.js'), `const BUILD_TARGET_VERSION = '${version}';\n`);
    text(path.join(directory, 'src/main.js'), `// runtime ${version}\n`);
  }
  runtime(path.join(extensionRoot, 'runtime'), '2.5.0');
  write(path.join(nativeRoot, 'versions/2.5.0/package.json'), { version: '2.5.0' });
  text(path.join(nativeRoot, 'versions/2.5.0/native-host/src/index.js'), '// native source fixture\n');
  text(path.join(extensionRoot, 'user-settings.json'), 'preserved user data\n');

  const payload = path.join(root, 'payload');
  runtime(path.join(payload, 'extension-runtime'), '2.5.1');
  write(path.join(payload, 'native-runtime/package.json'), { version: '2.5.1' });
  text(path.join(payload, 'native-runtime/native-host/src/index.js'), '// native target fixture\n');
  const bootstrapPayload = path.join(payload, 'native-runtime/native-host/bootstrap-payload');
  fs.mkdirSync(bootstrapPayload, { recursive: true });
  fs.cpSync(path.join(repo, 'extension/bootstrap'), path.join(bootstrapPayload, 'bootstrap'), { recursive: true });
  writeMigrationTemplate(path.join(bootstrapPayload, 'manifest.template.json'));
  writeMigrationTemplate(path.join(bootstrapPayload, 'bootstrap/manifest.template.json'));
  options.mutatePayload?.(payload);
  const entries = [];
  function walk(directory, relative = '') {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const next = relative ? relative + '/' + item.name : item.name;
      if (item.isDirectory()) walk(path.join(directory, item.name), next);
      else entries.push({ sourcePath: path.join(directory, item.name), archivePath: next });
    }
  }
  walk(payload);
  const archive = path.join(root, 'bundle.tar.gz');
  createUpdateBundleArchive({ outputPath: archive, entries });
  const bundle = fs.readFileSync(archive);
  const keys = crypto.generateKeyPairSync('ed25519');
  const descriptor = contract.buildBootstrapMigrationDescriptor({ packageRoot: migrationPackageRoot(), version: '2.5.1' });
  const manifest = { schemaVersion: 2, repository: 'Ghqqqq/codex-overleaf-link', channel: 'stable',
    version: '2.5.1', tag: 'v2.5.1', bootstrapProtocol: trust.BOOTSTRAP_PROTOCOL,
    gitCommit: 'a'.repeat(40), createdAt: new Date().toISOString(), artifacts: [],
    updateBundle: { name: 'codex-overleaf-update-v2.5.1.tar.gz', size: bundle.length, sha256: hash(bundle) },
    bootstrapMigration: descriptor };
  options.mutateManifest?.(manifest);
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const signatureBytes = Buffer.from(JSON.stringify({ algorithm: 'Ed25519', keyId: 'fixture',
    signature: crypto.sign(null, manifestBytes, keys.privateKey).toString('base64') }));
  const updater = loadWithDependencies('native-host/src/updateManager.js', {
    // The migration runs inside the 2.5.1 Native it installed, whatever the checkout version.
    '../../package.json': { ...require('../../package.json'), version: '2.5.1' },
    'node:fs': options.updateFs || fs,
    './updateTrust': { ...trust, verifySignedReleaseManifest: (bytes, signature, verifyOptions) =>
      trust.verifySignedReleaseManifest(bytes, signature, { ...verifyOptions, publicKeys: { fixture: keys.publicKey } }) }
  });
  const fetch = async (url, request) => {
    const body = url.endsWith('.json') ? manifestBytes : url.endsWith('.sig') ? signatureBytes : bundle;
    return { ok: true, status: 200, url: request.method === 'HEAD'
      ? 'https://github.com/Ghqqqq/codex-overleaf-link/releases/tag/v2.5.1' : url,
    headers: { get: key => key === 'content-length' ? String(body.length) : '' },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
  const journalPath = path.join(updatesRoot, 'transaction.json');
  const fixture = { root, home, context, env, updater, descriptor, manifest, manifestBytes, signatureBytes,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    journalPath, journal: () => read(journalPath),
    setJournal: journal => write(journalPath, journal),
    installedPayload: () => path.join(nativeRoot, 'versions/2.5.1/native-host/bootstrap-payload'),
    recordRoot: () => path.join(updatesRoot, 'bootstrap-migrations', read(journalPath).id),
    trackWatchdog() { const pid = read(journalPath).bootstrapMigration?.watchdogPid; if (pid) watchdogs.add(pid); },
    async response(method, params = {}, rpcOptions = {}) {
      return updater.handleUpdateRequest({ id: crypto.randomUUID(), method, params }, { env, fetch,
        bootstrapMigration: { startWatchdog: async (_context, journal, token) => {
          write(path.join(updatesRoot, 'bootstrap-migrations', journal.id, 'watchdog.json'), {
            transactionId: journal.id, token, pid: process.pid, at: Date.now()
          });
          return process.pid;
        } }, ...rpcOptions });
    },
    async request(method, params = {}, rpcOptions = {}) {
      const response = await fixture.response(method, params, rpcOptions);
      if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
      return response.result;
    },
    async apply({ bind = true } = {}) {
      const checked = await fixture.request('update.check');
      await fixture.request('update.authorize', { authorizationId: crypto.randomUUID(),
        targetVersion: '2.5.1', currentVersion: checked.currentVersion });
      const staged = await fixture.request('update.stage');
      await fixture.request('update.apply', { transactionId: staged.transactionId });
      if (bind) await fixture.request('update.status');
      return staged.transactionId;
    },
    migrate(revision = '', rpcOptions = {}) {
      return fixture.request('update.bootstrap', { transactionId: fixture.journal().id,
        bootstrapRevision: revision }, rpcOptions);
    },
    confirm(revision = '3.1') {
      return fixture.request('update.confirm', { transactionId: fixture.journal().id,
        extensionVersion: '2.5.1', nativeVersion: '2.5.1', bootstrapRevision: revision });
    }
  };
  return fixture;
}

// Exercise the production framed Native entry. The optional preload only
// replaces shell/Codex discovery; dispatch and the migration gate stay real.
function nativeRequest(fixture, method) {
  const preload = path.join(fixture.root, 'discovery-preload.cjs');
  text(preload, `const Module=require('node:module'),load=Module._load;Module._load=function(name){const value=load.apply(this,arguments);return ['nativeEnvironment','nativeEnvironment.js'].includes(name.split('/').at(-1))?{...value,buildNativeRuntimeEnv:env=>env}:value};\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', preload, path.join(repo, 'native-host/src/index.js')], {
      env: fixture.env, stdio: ['pipe', 'pipe', 'pipe']
    });
    let bytes = Buffer.alloc(0), stderr = '', response;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Native fixture timed out: ' + stderr)); }, 5000);
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (!response && bytes.length >= 4 && bytes.length >= 4 + bytes.readUInt32LE(0)) {
        response = JSON.parse(bytes.subarray(4, 4 + bytes.readUInt32LE(0))); child.stdin.end();
      }
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      response ? resolve(response) : reject(new Error(`Native fixture exited ${code}: ${stderr}`));
    });
    const body = Buffer.from(JSON.stringify({ id: 'migration-barrier', method, params: {} }));
    const frame = Buffer.alloc(4 + body.length); frame.writeUInt32LE(body.length); body.copy(frame, 4); child.stdin.write(frame);
  });
}

module.exports = { bootstrapMigrationFixture, nativeRequest, read, write, hash, oldBootstrap, repo };
