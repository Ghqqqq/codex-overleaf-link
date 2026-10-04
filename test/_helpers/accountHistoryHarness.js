'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { createMemoryIdb } = require('./memoryHistoryDb');
const repo = path.resolve(__dirname, '../..');
const { extractFunction } = require(path.join(repo, 'test/_helpers/extractFunction'));
const SessionState = require(path.join(repo, 'extension/src/shared/sessionState'));
const SharedSessionBridge = require(path.join(repo, 'extension/src/shared/sharedSessionBridge'));
const I18n = require(path.join(repo, 'extension/src/shared/i18n'));
const StorageKeys = require(path.join(repo, 'extension/src/shared/storageKeys'));
const PROJECT = 'c'.repeat(24);
const A = 'account-A', B = 'account-B', SA = 'session-A', SB = 'session-B';

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));
function read(file) { return fs.readFileSync(path.join(repo, file), 'utf8'); }
function common(file, environment, overrides = {}) {
  const filename = path.join(repo, file); const localRequire = createRequire(filename);
  const context = { ...environment, module: { exports: {} }, require: id => overrides[id] || localRequire(id) };
  vm.runInNewContext(read(file), context, { filename }); return context.module.exports;
}
function emitter() { const listeners = []; return { addListener: cb => listeners.push(cb), fire: (...args) => listeners.forEach(cb => cb(...args)) }; }
function localStorage(initial) {
  const data = clone(initial || {}), writes = [];
  return { data, writes, api: {
    async get(keys, callback) {
      const wanted = keys === null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
      const result = Object.fromEntries(wanted.filter(key => Object.hasOwn(data, key)).map(key => [key, clone(data[key])]));
      callback?.(result); return result;
    },
    async set(value, callback) { writes.push(clone(value)); Object.assign(data, clone(value)); callback?.(); },
    async remove(keys) { for (const key of [].concat(keys)) delete data[key]; }
  } };
}
function session(id, account) {
  return { id, projectId: PROJECT, accountScopeId: account, title: id, titleSource: 'manual',
    task: 'synthetic ' + id, codexThreadId: 'thread-' + id, status: 'active',
    createdAt: '2026-10-01T01:00:00.000Z', updatedAt: '2026-10-01T01:00:00.000Z',
    lastActivityAt: '2026-10-01T01:00:00.000Z', runs: [], history: [], pendingInputs: [] };
}
async function harness(initialScope = A) {
  const env = { scope: initialScope, approve: true, confirmations: [], toasts: [], nativeCalls: [], messages: [], cleanup: null };
  const rawA = session(SA, A), rawB = session(SB, B);
  const legacyKey = StorageKeys.getProjectStorageKey('codexOverleafPanelState', 'https://www.overleaf.com/project/' + PROJECT);
  const local = localStorage({ [legacyKey]: SessionState.normalizePanelState({ sessions: [rawA], activeSessionId: SA }) });
  const localGet = local.api.get;
  local.api.get = async (...args) => {
    const value = await localGet(...args);
    if (args[0] === legacyKey && env.afterLegacyRead) env.afterLegacyRead();
    return value;
  };
  const idb = createMemoryIdb();
  const sender = { id: 'extension-fixture', url: 'https://www.overleaf.com/project', tab: { id: 112 }, frameId: 0 };
  const runtime = { id: sender.id, onMessage: emitter(), onConnect: emitter(),
    async sendMessage(message) {
      env.messages.push(clone(message));
      return new Promise(resolve => runtime.onMessage.fire(message, sender, response => {
        env.messages.at(-1).response = clone(response); resolve(response);
      }));
    },
    connect({ name }) {
      const client = { name, onMessage: emitter(), onDisconnect: emitter() };
      const server = { name, sender, onMessage: emitter(), onDisconnect: emitter() };
      let disconnected = false;
      const disconnect = () => { if (disconnected) return; disconnected = true; client.onDisconnect.fire(); server.onDisconnect.fire(); };
      client.disconnect = server.disconnect = disconnect;
      client.postMessage = message => queueMicrotask(() => { if (!disconnected) server.onMessage.fire(clone(message)); });
      server.postMessage = message => queueMicrotask(() => { if (!disconnected) client.onMessage.fire(clone(message)); });
      runtime.onConnect.fire(server); return client;
    }
  };
  const chrome = { runtime, storage: { local: local.api, onChanged: emitter() } };
  const background = common('extension/src/backgroundSharedSessions.js', { crypto: crypto.webcrypto, URL });
  const service = background.createService({ chromeApi: chrome, indexedDB: idb.indexedDB, IDBKeyRange: idb.IDBKeyRange });
  service.install();
  // Seed a legitimate already-migrated state; no migration or guard is disabled.
  await service.handle({ method: 'migration-status', scope: { accountScopeId: A, projectId: PROJECT } }, sender);
  await settle();
  const shared = idb.databases.get('codex-overleaf-shared-sessions');
  for (const record of [rawA, rawB]) {
    shared.seed('sessions', { accountScopeId: record.accountScopeId, projectId: PROJECT, id: record.id, record, revision: 1 });
    shared.seed('migrations', { accountScopeId: record.accountScopeId, origin: 'https://www.overleaf.com', complete: true });
  }
  const location = { protocol: 'https:', hostname: 'www.overleaf.com', pathname: '/project', href: 'https://www.overleaf.com/project', assign() {} };
  const bridgeEnvironment = { chrome, crypto: crypto.webcrypto, location,
    codexOverleafDeriveAccountScopeId: () => env.scope,
    setTimeout, clearTimeout, setInterval, clearInterval };
  const bridge = SharedSessionBridge.createBridge(bridgeEnvironment);
  const storage = common('extension/src/shared/storageDb.js', { indexedDB: idb.indexedDB, IDBKeyRange: idb.IDBKeyRange }, { './sharedSessionBridge': bridge });
  const Migration = common('extension/src/shared/storageMigration.js', { chrome }, { './storageDb': storage });
  const Persistence = common('extension/src/content/sessionPersistence.js', {}, { '../shared/storageMigration': Migration });

  // Mechanically reuse the repo's DOM-only dashboard node, without its mocked
  // cleanup/controller/storage fixture. This is no real Chrome rendering.
  const domSource = read('test/dashboardSessions.test.js');
  const start = domSource.indexOf('class DashboardNode {');
  const end = domSource.indexOf('\nfunction dashboardHarness(', start);
  assert.ok(start >= 0 && end > start);
  const domContext = { assert, settle }; vm.createContext(domContext);
  const Node = vm.runInContext(domSource.slice(start, end) + '\nDashboardNode;', domContext);
  Node.prototype.append = function (...children) { for (const child of children) this.appendChild(child); };
  const document = { visibilityState: 'visible', title: 'Overleaf', activeElement: null };
  document.addEventListener = () => {}; document.removeEventListener = () => {};
  document.createElement = tag => new Node(tag, document);
  document.body = document.createElement('body');
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.querySelector = selector => document.body.querySelector(selector);
  const panel = document.body.appendChild(document.createElement('aside'));
  const context = { window: { location, codexOverleafDeriveAccountScopeId: () => env.scope }, chrome, document, URL,
    setInterval: () => 1, clearInterval() {} };
  vm.createContext(context);
  vm.runInContext(read('extension/src/content/projectSessionCleanup.js'), context);
  vm.runInContext(read('extension/src/content/recentProjects.js'), context);
  vm.runInContext(extractFunction(read('extension/src/content/panelRenderer.js'), 'createConfirmController'), context);
  const confirmController = context.createConfirmController({ getPanel: () => panel, tr: key => I18n.t('en', key) });
  const actualCleanup = context.window.CodexOverleafProjectSessionCleanup;
  const api = context.window.CodexOverleafRecentProjects.create({
    tr: (key, params) => I18n.t('en', key, params), tx: en => en,
    getPanel: () => panel, getCachedAccountScopeId: () => env.scope, refreshAccountScopeId: async () => env.scope,
    openCustomInstructionsSettings() {}, enterProject() {}, applyStateToPanel() {},
    showPluginConfirm: request => { env.confirmations.push(clone(request)); return confirmController.show(request); },
    showPluginToast: (message, options) => env.toasts.push({ message, options: clone(options) }),
    sendBackgroundNative: async request => { env.nativeCalls.push(clone(request)); return { ok: true, result: {} }; },
    PANEL_STATE_BASE_KEY: 'codexOverleafPanelState', PROJECT_EDITOR_RESERVED_IDS: new Set(), STATUS_BADGE_CLASS: {},
    ProjectSessionCleanup: { create(deps) {
      const cleanup = actualCleanup.create(deps);
      return { clearProjectSessions(...args) {
        env.cleanup = cleanup.clearProjectSessions(...args); return env.cleanup;
      } };
    } },
    SessionPersistence: Persistence, SessionState, StorageDb: storage, StorageKeys, StorageMigration: Migration
  });
  return Object.assign(env, { api, panel, local, shared, idb, storage, Migration, Persistence, service, sender, legacyKey,
    render: () => api.renderRecentProjectsVariant(),
    button: () => panel.querySelector('[data-project-session-row="' + SA + '"]')?.querySelector('[data-project-clear]'),
    records: account => shared.values('sessions').filter(item => item.accountScopeId === account).map(item => item.id) });
}
async function waitFor(predicate, label) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await settle(); }
  assert.fail('Timed out waiting for ' + label);
}
async function answerConfirmation(h, approved) {
  await waitFor(() => h.panel.querySelector('[data-plugin-confirm]'), 'real confirmation DOM');
  await h.panel.querySelector(approved ? '.codex-plugin-confirm-confirm' : '.codex-plugin-confirm-cancel').click();
}

module.exports = { harness, answerConfirmation, waitFor, clone, A, B, SA, SB, PROJECT };
