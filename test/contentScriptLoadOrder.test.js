// Loads every manifest content script in order inside a minimal DOM/chrome
// sandbox and runs the real init() — the load path no other test executes.
//
// Why this exists: the v1.4.6–v1.5.0 module carves left the module-composition
// wiring (const { scrollLogToBottom, ... } = runTimelineView, ...) AFTER the
// controller creations that consume those exports by value, so init() died in
// the temporal dead zone and the panel never mounted in the browser — while
// the entire suite stayed green, because source-contract tests never execute
// initialization. This test fails on any load-order / TDZ / missing-global
// regression in the composition path.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function noopEl() {
  return {
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    // querySelector resolves to a fresh stub so the full panel mount
    // (renderer slots -> DiagnosticsPanel/SessionPanel/Composer containers)
    // can compose; querySelectorAll stays empty so list logic no-ops.
    appendChild() {}, append() {}, prepend() {}, querySelector() { return noopEl(); }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    style: { setProperty() {} }, dataset: {}, remove() {}, replaceChildren() {}, replaceWith() {},
    cloneNode() { return noopEl(); }, contains() { return false; }, focus() {}, select() {},
    insertBefore() {}, closest() { return null; }, add() {},
    options: [], selectedIndex: 0, checked: false,
    innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, title: ''
  };
}

function createSandbox(options = {}) {
  const storage = {
    get(keys, cb) {
      if (typeof cb === 'function') { cb({}); return undefined; }
      return Promise.resolve({});
    },
    set(values, cb) { if (typeof cb === 'function') { cb(); return undefined; } return Promise.resolve(); },
    remove(keys, cb) { if (typeof cb === 'function') { cb(); return undefined; } return Promise.resolve(); }
  };
  const documentStub = {
    createElement: () => noopEl(),
    documentElement: noopEl(),
    getElementById: () => null,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; }
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    // Timers never fire and sendMessage never settles: the contract under test
    // is the synchronous load + init() composition path; post-init async work
    // must neither hold the event loop open nor surface stub-shaped
    // rejections that would fail the test file.
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    URL, Blob: class {}, TextEncoder, TextDecoder, crypto: globalThis.crypto,
    document: documentStub,
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: options.resolveRuntimeMessages
          ? () => Promise.resolve({})
          : () => new Promise(() => {}),
        getURL: p => `chrome-extension://test/${p}`,
        id: 'test'
      },
      storage: { local: storage, onChanged: { addListener() {} } }
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    // Non-project route: the contract under test is the load + composition
    // path inside init(); a project route would auto-mount the panel, which
    // the minimal element stubs cannot support.
    location: {
      pathname: options.pathname || '/',
      href: options.href || 'https://www.overleaf.com/'
    },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    addEventListener() {}, removeEventListener() {},
    history: { pushState() {}, replaceState() {} },
    navigator: { platform: 'MacIntel', language: 'en' },
    performance: { now: () => 0 }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

test('every content script loads in manifest order and init() mounts the runtime', async () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../extension/manifest.json'), 'utf8')
  );
  const files = manifest.content_scripts[0].js;
  const sandbox = createSandbox();
  const ctx = vm.createContext(sandbox);
  for (const file of files) {
    const src = fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8');
    try {
      vm.runInContext(src, ctx, { filename: file });
    } catch (error) {
      assert.fail(`content script ${file} threw during load/init: ${error.stack.split('\n').slice(0, 4).join(' | ')}`);
    }
  }
  const state = sandbox.__codexOverleafContentRuntimeState;
  assert.ok(state, 'contentScript must run init() and record the runtime state');
  assert.equal(state.ok, true, `init() must complete: ${JSON.stringify(state)}`);
  // Quarantine post-init async stub noise (storage microtasks settling against
  // the minimal DOM) so it cannot escape past the test as an unhandled
  // rejection; the load/composition contract above has already been asserted.
  const trap = () => {};
  process.on('unhandledRejection', trap);
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  process.off('unhandledRejection', trap);
});

test('project route mounts the panel while account identity is still hydrating', async () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../extension/manifest.json'), 'utf8')
  );
  const files = manifest.content_scripts[0].js;
  const sandbox = createSandbox({
    pathname: '/project/0123456789abcdef01234567',
    href: 'https://www.overleaf.com/project/0123456789abcdef01234567',
    resolveRuntimeMessages: true
  });
  const ctx = vm.createContext(sandbox);
  for (const file of files) {
    const src = fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8');
    vm.runInContext(src, ctx, { filename: file });
  }

  const trap = () => {};
  process.on('unhandledRejection', trap);
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  process.off('unhandledRejection', trap);

  const state = sandbox.__codexOverleafContentRuntimeState;
  assert.ok(state, 'content runtime state should be recorded');
  assert.equal(state.ok, true, `project-route init must not fail closed before panel mount: ${JSON.stringify(state)}`);
});
