'use strict';

// Full production worker + coordinator loaded without source extraction or patching.
// All Chrome/Native I/O is in memory; no real installation, browser or network access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const UPDATE_KEY = 'codex-overleaf-managed-update-state-v1';
const CONSENT_KEY = 'codex-overleaf-update-consent-v1';
const STARTUP_KEY = 'codex-overleaf-startup-update-check-v1';
const VERSION = require(path.join(ROOT, 'extension/manifest.json')).version;
const TARGET = VERSION.replace(/\d+$/, value => String(Number(value) + 1));
const TRANSACTION = 'PROJ-114-synthetic-transaction';
const EDITOR = { id: 114, url: 'https://www.overleaf.com/project/synthetic-114', status: 'complete' };

async function bounded(promise, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Harness timeout: ${description}`)), 2000); })
    ]);
  } finally { clearTimeout(timer); }
}

async function createHarness(scenario) {
  const data = {
    [UPDATE_KEY]: { state: 'idle', currentVersion: VERSION, latestVersion: VERSION },
    [CONSENT_KEY]: {}
  };
  const messages = [], native = [], queries = [], probes = [], loaded = [];
  const timers = new Map();
  let timerId = 0, reloads = 0, active = false;
  let reloadDone;
  const reloaded = new Promise(resolve => { reloadDone = resolve; });
  let startupDone;
  const startup = new Promise(resolve => { startupDone = resolve; });
  const noListener = { addListener() {} };
  const chrome = {
    runtime: {
      id: 'proj114', lastError: null,
      getURL: relative => `chrome-extension://proj114/${relative}`,
      getManifest: () => ({ version: VERSION, background: { service_worker: 'bootstrap/background.js' } }),
      onMessage: { addListener(listener) { messages.push(listener); } },
      onConnect: noListener,
      reload() { reloads += 1; reloadDone(); },
      connectNative(host) {
        assert.equal(host, 'com.codex.overleaf');
        const listeners = [];
        return {
          onMessage: { addListener(listener) { listeners.push(listener); } },
          onDisconnect: noListener,
          postMessage(request) {
            native.push(structuredClone(request));
            let result;
            switch (request.method) {
              case 'update.status': result = {
                managed: true, activeVersion: VERSION, runtimeVersion: VERSION,
                installedAligned: true, transaction: null, authorization: null
              }; break;
              case 'update.authorize': result = { authorized: true }; break;
              case 'update.stage': result = { targetVersion: TARGET, transactionId: TRANSACTION }; break;
              case 'update.canApply': result = { idle: true, blockers: [] }; break;
              case 'update.apply': result = { state: 'awaiting_health', targetVersion: TARGET, transactionId: TRANSACTION }; break;
              case 'update.revoke': result = { revoked: true }; break;
              default: throw new Error(`Unexpected Native method: ${request.method}`);
            }
            queueMicrotask(() => listeners.forEach(listener => listener({ id: request.id, ok: true, result })));
          }
        };
      }
    },
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return structuredClone(data);
          return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])]));
        },
        async set(values) { Object.assign(data, structuredClone(values)); },
        async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
      },
      session: {
        async get(key) {
          // This is startup's final claim, after its publish/status work settled.
          if (key === STARTUP_KEY) startupDone();
          return { [key]: true };
        },
        async set() {}, async remove() {}
      },
      onChanged: noListener
    },
    alarms: { create() {}, async clear() {}, onAlarm: noListener },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    tabs: {
      async query(filter) {
        if (!active) return [];
        const pass = queries.length + 1;
        const reject = scenario.rejectQuery === pass;
        const invalid = pass === 2 && Object.hasOwn(scenario, 'invalidInventory');
        queries.push({ pass, filter: structuredClone(filter), result: reject ? 'rejected' : invalid ? 'invalid' : (scenario.empty ? 'empty' : 'one-editor') });
        if (reject) throw new Error('PROJ-114 synthetic tabs.query unavailable');
        if (invalid) return scenario.invalidInventory;
        return scenario.empty ? [] : [structuredClone(EDITOR)];
      },
      async sendMessage(id, message) {
        if (message.type !== 'codex-overleaf/update-idle-probe') return {};
        assert.equal(id, EDITOR.id);
        const pass = queries.length;
        const outcome = pass === 2 ? (scenario.secondProbe || 'idle') : 'idle';
        probes.push({ pass, outcome });
        if (outcome === 'reject') throw new Error('PROJ-114 synthetic probe unavailable');
        return outcome === 'busy' ? { idle: false, blockers: ['run'] } : { idle: true, blockers: [] };
      },
      async reload() { throw new Error('Unexpected tab reload'); }
    }
  };
  const sandbox = {
    chrome, URL, crypto, console,
    indexedDB: { open() { throw new Error('Unexpected IndexedDB access'); } },
    IDBKeyRange: {},
    // Timers run only when a test advances the idle retry; Native responses use microtasks.
    // Startup reconciliation and probe timeouts never fire autonomously.
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    importScripts(...scripts) { scripts.forEach(load); }
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  function load(input) {
    let filename;
    if (input.startsWith('chrome-extension://proj114/runtime/src/')) {
      filename = path.join(ROOT, 'extension/src', input.slice('chrome-extension://proj114/runtime/src/'.length));
    } else if (input === 'BOOTSTRAP_STATUS') {
      filename = path.join(ROOT, 'extension/bootstrap/updateStatus.js');
    } else {
      assert.match(input, /^[A-Za-z0-9_./-]+\.js$/);
      filename = path.resolve(ROOT, 'extension/src', input);
    }
    const relative = path.relative(ROOT, filename).split(path.sep).join('/');
    assert.ok(relative.startsWith('extension/') && !relative.includes('..'));
    loaded.push(relative);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }
  load('BOOTSTRAP_STATUS');
  load('background.js');
  await bounded(startup, 'coordinator startup');
  // Drain the continuation after the last awaited startup claim, with no wall-clock delay.
  await new Promise(setImmediate);
  assert.equal(typeof sandbox.CodexOverleafNativeBridge.requestInternal, 'function');
  assert.ok(loaded.includes('extension/src/backgroundUpdateCoordinator.js'));
  native.length = 0;
  data[UPDATE_KEY] = {
    state: 'update_available', currentVersion: VERSION, latestVersion: TARGET, lastCheckedAt: Date.now()
  };
  data[CONSENT_KEY] = {};
  active = true;
  return {
    data, native, queries, probes, loaded,
    reloads: () => reloads,
    hasIdleRetry: () => [...timers.values()].some(timer => timer.delay === 15000),
    async runIdleRetry() {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === 15000);
      assert.ok(entry, 'blocked update must retain its scheduled safe-point retry');
      timers.delete(entry[0]);
      entry[1].callback();
      await bounded(reloaded, 'safe-point retry');
    },
    async install() {
      const sender = { id: 'proj114', url: EDITOR.url, tab: EDITOR };
      return bounded(new Promise(resolve => {
        let handled = false;
        for (const listener of messages) {
          if (listener({ type: 'codex-overleaf/consent-update-install' }, sender, resolve) === true) handled = true;
        }
        assert.equal(handled, true, 'actual production install listener must accept the fixture sender');
      }), 'install response');
    },
    dispose() { timers.clear(); active = false; }
  };
}

const scenarios = [
  { name: 'idle editor on both passes allows apply', allow: true, secondProbe: 'idle' },
  { name: 'empty editor inventory on both passes allows apply', allow: true, empty: true },
  { name: 'second-pass editor busy blocks apply', allow: false, secondProbe: 'busy' },
  { name: 'second-pass single-tab probe rejection blocks apply', allow: false, secondProbe: 'reject' },
  { name: 'first-pass inventory rejection blocks apply', allow: false, rejectQuery: 1 },
  { name: 'second-pass inventory rejection blocks apply and preserves retry', allow: false, rejectQuery: 2, unknownInventory: true },
  { name: 'second-pass null inventory blocks apply and preserves retry', allow: false, invalidInventory: null, unknownInventory: true },
  { name: 'second-pass missing inventory blocks apply and preserves retry', allow: false, invalidInventory: undefined, unknownInventory: true },
  { name: 'second-pass non-array inventory blocks apply and preserves retry', allow: false, invalidInventory: {}, unknownInventory: true }
];

for (const scenario of scenarios) {
  test(scenario.name, { timeout: 5000 }, async () => {
    const harness = await createHarness(scenario);
    try {
      const response = await harness.install();
      const methods = harness.native.map(request => request.method);
      const applied = methods.filter(method => method === 'update.apply').length;
      const state = harness.data[UPDATE_KEY].state;
      // Sanity assertions prevent setup failures or a skipped path masquerading as this defect.
      assert.ok(methods.includes('update.authorize'));
      assert.ok(methods.includes('update.stage'));
      assert.equal(harness.queries.length, scenario.rejectQuery === 1 ? 1 : 2);
      if (scenario.unknownInventory) {
        assert.equal(harness.probes.length, 1, 'first pass is genuinely probed before second enumeration fails');
      }
      // Correct contract: an unknown editor inventory must never authorize apply.
      assert.equal(applied, scenario.allow ? 1 : 0, 'unknown/busy browser state must block Native update.apply');
      assert.equal(harness.reloads(), scenario.allow ? 1 : 0);
      if (scenario.allow) assert.equal(state, 'awaiting_health');
      else if (scenario.rejectQuery === 1) assert.equal(state, 'failed');
      else assert.equal(state, 'waiting_for_idle');
      if (scenario.unknownInventory) {
        assert.equal(methods.filter(method => method === 'update.canApply').length, 2);
        assert.equal(response.ok, true, 'the coordinator keeps the staged update available');
        assert.equal(harness.data[UPDATE_KEY].transactionId, TRANSACTION);
        assert.equal(harness.data[CONSENT_KEY].authorizedVersion, TARGET);
        assert.equal(harness.hasIdleRetry(), true);
        assert.equal(methods.includes('update.revoke'), false);
        await harness.runIdleRetry();
        assert.equal(harness.data[UPDATE_KEY].state, 'awaiting_health');
        assert.equal(harness.native.filter(request => request.method === 'update.apply').length, 1);
        assert.equal(harness.native.filter(request => request.method === 'update.stage').length, 1, 'retry reuses the staged update');
        assert.equal(harness.reloads(), 1);
        assert.equal(harness.queries.length, 4, 'retry repeats both browser gates');
      }
    } finally { harness.dispose(); }
  });
}
