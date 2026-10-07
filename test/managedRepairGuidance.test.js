'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const Compatibility = require('../extension/src/shared/compatibility');
const currentVersion = require('../package.json').version;
const Controller = require('../extension/src/content/nativeCompatibilityController');
const Messaging = require('../native-host/src/nativeMessaging');
const root = path.resolve(__dirname, '..'), extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const identity = { managed: true, managedRoot: "/tmp/fixture's $HOME `value`", browser: 'chromium', extensionId, platform: 'darwin' };
function background(marker, managed = true) {
  const listeners = [], nativeMessages = [], fetches = [];
  const chrome = { runtime: { id: extensionId,
    getManifest: () => ({ version: currentVersion, background: { service_worker: managed ? 'bootstrap/background.js' : 'src/background.js' } }),
    getURL: name => 'chrome-extension://' + extensionId + '/' + name,
    onMessage: { addListener: f => listeners.push(f) }, onConnect: { addListener() {} },
    connectNative() { const replies = []; return { onMessage: { addListener: f => replies.push(f) }, onDisconnect: { addListener() {} },
      postMessage(request) { nativeMessages.push(request); queueMicrotask(() => replies.forEach(f => f({ id: request.id, ok: false,
        error: { code: 'native_missing', message: 'Synthetic disconnected installation' } }))); } }; }
  }, storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } }, tabs: { sendMessage() {} } };
  const context = { chrome, URL, crypto: { randomUUID: () => 'repair-fixture' }, setTimeout: () => 1, clearTimeout() {},
    fetch: async url => { fetches.push(url); return { ok: Boolean(marker), json: async () => marker }; },
    CodexOverleafCompatibility: Compatibility,
    CodexOverleafManagedUpdateProjection: require('../extension/src/shared/managedUpdateProjection'),
    CodexOverleafNativeRequestIdentity: require('../extension/src/shared/nativeRequestIdentity'),
    CodexOverleafGlobalPreferences: { installBackground() {} }, CodexOverleafStorageRunActions: {}, CodexOverleafSharedSessionTransfer: {},
    CodexOverleafSharedSessionsBackground: { installBackground() {} }, CodexOverleafUpdateRuntimeIdentity: {},
    CodexOverleafUpdateCoordinator: { init() {} }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'extension/src/background.js'), 'utf8'), context);
  return { nativeMessages, fetches, send: payload => new Promise(resolve => {
    for (const listener of listeners) listener({ type: 'codex-overleaf/native-request', payload: { id: 'fixture-' + nativeMessages.length, ...payload } },
      { id: extensionId, url: chrome.runtime.getURL('bootstrap/popup.html') }, resolve);
  }) };
}
function node(tag) {
  return { tag, dataset: {}, style: {}, children: [], handlers: {}, textContent: '', disabled: false,
    append(...values) { this.children.push(...values); }, setAttribute() {}, querySelector() { return null; },
    addEventListener(type, fn) { this.handlers[type] = fn; }, focus() {}, remove() {} };
}
const flatten = value => [value, ...value.children.flatMap(flatten)];
function panel(h, managed) {
  const element = node('panel'), copied = [];
  const metadata = { version: currentVersion, extensionId, installIdentity: { managed } };
  const controller = Controller.create({ compatibility: Compatibility, nativeChannel: { sendBackgroundNative: h.send },
    gatedMethods: new Set(['codex.run']), getExtensionCompatibilityMetadata: () => metadata,
    getNativeCompatibilityClassification: value => value.classification, getPanel: () => element,
    document: { createElement: node }, navigator: { clipboard: { writeText: async value => copied.push(value) } },
    installCommand: 'dangerous-legacy-install-native-fallback', tr: key => key, tx: en => en });
  return { element, copied, controller, metadata };
}
for (const known of [true, false]) test('existing background ping carries Managed identity through Panel and Diagnostics: known=' + known, async () => {
  const marker = known ? { managedBy: 'codex-overleaf-link', kind: 'extension', installIdentity: identity } : { managedBy: 'codex-overleaf-link', kind: 'extension' };
  const h = background(marker), p = panel(h, true);
  const gate = await p.controller.ensureForMethod('codex.run');
  assert.equal(gate.ok, false); assert.equal(h.nativeMessages.length, 1); assert.equal(h.nativeMessages[0].method, 'bridge.ping');
  assert.equal(h.fetches.length, 1); assert.ok(h.fetches[0].endsWith('/.codex-overleaf-managed-extension.json'));
  assert.equal(gate.response.error.installIdentity.managed, true);
  assert.doesNotMatch(gate.response.error.installCommand, /install-native/);
  p.controller.showUpdateGuidance({}); // The existing Fix native host action passes no evidence itself.
  const nodes = flatten(p.element), code = nodes.filter(x => x.tag === 'code').at(-1), copy = nodes.filter(x => x.tag === 'button').find(x => x.textContent === 'Copy command');
  assert.equal(Boolean(code.textContent), known); assert.equal(copy.disabled, !known);
  await copy.handlers.click(); assert.equal(p.copied.length, known ? 1 : 0);
  if (known) assert.match(code.textContent, /install-managed --browser chromium --managed-root/);
  else assert.ok(nodes.some(x => /original managed root/.test(x.textContent)));
  const win = {}; new Function('window', fs.readFileSync(path.join(root, 'extension/src/content/diagnosticsController.js'), 'utf8'))(win);
  const diagnostics = win.CodexOverleafDiagnosticsController.create({ Compatibility, getExtensionCompatibilityMetadata: () => p.metadata,
    sendBackgroundNative: h.send, getCurrentProjectId: () => 'fixture', getScope: () => ({ projectId: 'fixture' }),
    INSTALL_COMMAND: 'dangerous-legacy-install-native-fallback', tx: en => en, tr: key => key });
  const result = await diagnostics.inspectNativeEnvironment({ collectOnly: true });
  assert.equal(Boolean(result.installCommand), known); assert.doesNotMatch(result.installCommand, /install-native/);
  if (!known) assert.match(result.nextStep, /original managed root/);
});
test('Direct repair keeps the established three-argument command', async () => {
  const h = background(null, false), p = panel(h, false);
  const gate = await p.controller.ensureForMethod('codex.run');
  assert.equal(gate.response.error.installCommand, Compatibility.buildInstallCommand(currentVersion, undefined, extensionId));
  assert.equal(h.fetches.length, 0); assert.match(gate.response.error.installCommand, / -- install-native/);
});
test('Managed command generation refuses missing or mismatched identity and quotes platform paths', () => {
  for (const input of [{}, { ...identity, extensionId: undefined }, { ...identity, extensionId: 'b'.repeat(32) },
    { ...identity, managedRoot: 'relative' }, { ...identity, managedRoot: '/tmp/bad\nline' }, { ...identity, browser: 'unknown' }]) {
    assert.equal(Compatibility.buildInstallCommand('2.5.0', 'darwin', extensionId, { ...input, managed: true }), '');
  }
  const windows = { ...identity, platform: 'win32', managedRoot: "C:\\Users\\Alice's 100% $HOME\\managed" };
  assert.ok(Compatibility.buildInstallCommand('2.5.0', 'win32', extensionId, windows).includes("--managed-root 'C:\\Users\\Alice''s 100% $HOME\\managed'"));
});
test('displayed POSIX Managed repair command preserves literal arguments and installs a managed launcher', t => {
  if (process.platform === 'win32') { t.skip('POSIX command execution; Windows quoting has a separate controlled assertion'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'col-managed-command-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'), bin = path.join(dir, 'bin'), managedRoot = path.join(home, "managed's $HOME `quoted`");
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(home);
  const npm = path.join(bin, 'npm');
  fs.writeFileSync(npm, '#!' + process.execPath + '\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
  const command = Compatibility.buildInstallCommand('2.5.0', process.platform, extensionId, { ...identity, browser: 'chrome', managedRoot });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, 'codex'),
    CODEX_OVERLEAF_MIRROR_ROOT: path.join(home, 'mirror'), PATH: bin + ':' + process.env.PATH };
  const parsed = spawnSync('/bin/sh', ['-c', command], { env, encoding: 'utf8' }); assert.equal(parsed.status, 0, parsed.stderr);
  const args = JSON.parse(parsed.stdout); assert.equal(args[args.indexOf('--managed-root') + 1], managedRoot);
  assert.equal(args[args.indexOf('--browser') + 1], 'chrome'); assert.equal(args[args.indexOf('--extension-id') + 1], extensionId);
  // Execute the actual existing installer with the parsed displayed parameters, without npm or network.
  const installed = require('../native-host/src/managedInstall').installManagedDistribution({ packageRoot: root, managedRoot,
    browser: args[args.indexOf('--browser') + 1], extensionId: args[args.indexOf('--extension-id') + 1], env });
  const marker = JSON.parse(fs.readFileSync(path.join(installed.extensionRoot, '.codex-overleaf-managed-extension.json'), 'utf8'));
  assert.equal(marker.installIdentity.managedRoot, managedRoot); assert.equal(marker.installIdentity.extensionId, extensionId);
  const bridge = require('../native-host/src/nativeHostPlatform').getDefaultBridgePath({ env });
  const result = spawnSync(bridge, [], { env, input: Messaging.encodeMessage({ id: 'fixture-status', method: 'update.status', params: {} }), timeout: 6000 });
  assert.equal(result.status, 0, result.stderr?.toString());
  const response = Messaging.decodeFrames(result.stdout).messages.find(value => value.id === 'fixture-status');
  assert.equal(response?.ok, true, JSON.stringify(response)); assert.equal(response.result.managed, true);
});
