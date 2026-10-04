const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { extractFunction } = require('./_helpers/extractFunction');
const SessionState = require('../extension/src/shared/sessionState');

const sourceCache = new Map();
const repo = (p) => {
  if (!sourceCache.has(p)) sourceCache.set(p, fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
  return sourceCache.get(p);
};
const I18n = require('../extension/src/shared/i18n');
const StorageDb = require('../extension/src/shared/storageDb');
const PROJECT_A = 'a'.repeat(24);
const PROJECT_B = 'b'.repeat(24);
const NOW = Date.parse('2026-09-21T12:00:00.000Z');
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function session(id, projectId = PROJECT_A, overrides = {}) {
  const timestamp = new Date(NOW - (overrides.minutes ?? 10) * 60000).toISOString();
  return {
    id, projectId, accountScopeId: 'account-a', accountScopeUnavailable: false,
    title: id, titleSource: 'auto', status: 'active', task: '', safeTaskSummary: '',
    codexThreadId: '', runs: [], history: [], pendingInputs: [],
    createdAt: timestamp, updatedAt: timestamp, lastActivityAt: timestamp, ...overrides
  };
}

// Only DOM tree, focus and bubbling semantics used by this module; no browser or native I/O.
class DashboardNode {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = [];
    this.parentElement = null; this.dataset = {}; this.attributes = {}; this.listeners = {};
    this.className = ''; this.id = ''; this._text = ''; this.hidden = false; this.open = false;
    this.disabled = false; this.scrollTop = 0; this.value = '';
  }
  get childNodes() { return this.children; }
  get parentNode() { return this.parentElement; }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentElement && this.parentElement.isConnected); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this._text = String(value ?? ''); }
  set innerHTML(value) { assert.equal(value, '', 'the dashboard should build text-safe nodes'); this.textContent = ''; }
  get classList() {
    return {
      add: (...names) => { this.className = [...new Set(this.className.split(/\s+/).filter(Boolean).concat(names))].join(' '); },
      contains: name => this.className.split(/\s+/).includes(name)
    };
  }
  setAttribute(name, value) {
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
    else if (name === 'class') this.className = String(value);
    else if (name === 'id') this.id = String(value);
    else if (name === 'open') this.open = true;
    else this.attributes[name] = String(value);
  }
  getAttribute(name) {
    if (name.startsWith('data-')) return this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] ?? null;
    if (name === 'class') return this.className;
    if (name === 'id') return this.id;
    if (name === 'open') return this.open ? '' : null;
    return this.attributes[name] ?? null;
  }
  removeAttribute(name) {
    if (name.startsWith('data-')) delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
    else if (name === 'open') this.open = false;
    else delete this.attributes[name];
  }
  appendChild(child) { if (child.parentElement) child.remove(); child.parentElement = this; this.children.push(child); return child; }
  removeChild(child) { const index = this.children.indexOf(child); assert.notEqual(index, -1); this.children.splice(index, 1); child.parentElement = null; return child; }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  insertBefore(child, reference) { const index = this.children.indexOf(reference); assert.notEqual(index, -1, 'rename input must use the title actual parent'); child.parentElement = this; this.children.splice(index, 0, child); }
  matches(selector) {
    return selector.split(',').some(part => {
      part = part.trim();
      const attributes = [...part.matchAll(/\[([\w-]+)(?:(\^?=)["']?([^"'\]]*)["']?)?\]/g)];
      const classes = [...part.replace(/\[[^\]]*\]/g, '').matchAll(/\.([\w-]+)/g)].map(match => match[1]);
      const tag = part.replace(/\[[^\]]*\]/g, '').replace(/\.[\w-]+/g, '').trim();
      return (!tag || tag.toUpperCase() === this.tagName) && classes.every(name => this.classList.contains(name))
        && attributes.every(([, name, operator, value]) => {
          const actual = this.getAttribute(name);
          return actual !== null && (!operator || (operator === '^=' ? actual.startsWith(value) : actual === value));
        });
    });
  }
  querySelectorAll(selector) { return this.children.flatMap(child => (child.matches(selector) ? [child] : []).concat(child.querySelectorAll(selector))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  contains(other) { for (let node = other; node; node = node.parentElement) if (node === this) return true; return false; }
  focus() { this.ownerDocument.activeElement = this; }
  select() { this.selected = true; }
  addEventListener(type, listener, capture = false) { (this.listeners[type] ||= []).push({ listener, capture: capture === true }); }
  async fire(type, fields = {}) {
    const event = { target: this, defaultPrevented: false, stopped: false, ...fields,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    const path = []; for (let node = this; node; node = node.parentElement) path.push(node);
    for (const [nodes, capture] of [[path.slice().reverse(), true], [path, false]]) {
      for (const node of nodes) {
        for (const entry of node.listeners[type] || []) if (entry.capture === capture) await entry.listener(event);
        if (event.stopped) break;
      }
      if (event.stopped) break;
    }
    if (type === 'click' && this.tagName === 'SUMMARY' && !event.defaultPrevented) {
      this.parentElement.open = !this.parentElement.open;
      await this.parentElement.fire('toggle');
    }
    await settle();
  }
  async click() { if (!this.disabled) await this.fire('click'); }
}

function dashboardHarness(records, options = {}) {
  const env = { records: structuredClone(records), scope: 'account-a', locale: 'en', deleted: {},
    allReads: 0, indexedReads: 0, clearCalls: [], prompts: [], nativeCalls: [], toasts: [],
    navigations: [], prefWrites: [], approve: false, local: {}, ...options };
  const document = { visibilityState: 'visible', title: 'Overleaf', activeElement: null };
  document.createElement = tag => new DashboardNode(tag, document);
  document.body = document.createElement('body');
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.querySelector = selector => document.body.querySelector(selector);
  const panel = document.body.appendChild(document.createElement('aside'));
  panel.dataset.view = 'recent-projects';
  const location = { pathname: '/project', assign: url => { env.navigations.push(url); location.pathname = new URL(url).pathname; } };
  const sandbox = {
    window: { location, codexOverleafDeriveAccountScopeId: () => env.scope }, document,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } },
    setInterval: () => 1, clearInterval: () => {},
    chrome: { storage: { local: {
      get: async (keys, callback) => {
        const result = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) if (Object.hasOwn(env.local, key)) result[key] = structuredClone(env.local[key]);
        if (callback) callback(result);
        return result;
      },
      set: async payload => { Object.assign(env.local, structuredClone(payload)); },
      remove: async keys => { for (const key of [].concat(keys)) delete env.local[key]; }
    } } }
  };
  env.local.projectNameCacheByAccount = { 'account-a': { [PROJECT_A]: 'Alpha', [PROJECT_B]: 'Beta' }, 'account-b': { [PROJECT_B]: 'Other account' } };
  vm.createContext(sandbox);
  vm.runInContext(repo('extension/src/content/recentProjects.js'), sandbox);
  const isVisibleRecord = vm.runInContext('(' + extractFunction(repo('extension/src/content/sessionPersistence.js'), 'isVisibleRecord') + ')', sandbox);
  const storage = {
    ...StorageDb,
    getAllSessions: async () => {
      env.allReads++;
      if (env.pendingAll) { const pending = env.pendingAll; env.pendingAll = null; return pending.promise; }
      if (env.readError) throw env.readError;
      return structuredClone(env.records);
    },
    getAllByIndex: async (store, index, projectId) => {
      assert.equal(store, 'sessions'); assert.equal(index, 'projectId'); env.indexedReads++;
      if (env.pendingIndexed) { const pending = env.pendingIndexed; env.pendingIndexed = null; return pending.promise; }
      return structuredClone(env.records.filter(record => record.projectId === projectId));
    },
    putRecord: async (_store, record) => { env.records = env.records.map(old => old.id === record.id ? structuredClone(record) : old); },
    deleteRecord: async (_store, id) => { env.records = env.records.filter(record => record.id !== id); }
  };
  const api = sandbox.window.CodexOverleafRecentProjects.create({
    tr: (key, params) => I18n.t(env.locale, key, params), tx: (en, zh) => env.locale === 'zh' ? zh : en,
    getPanel: () => panel, getCachedAccountScopeId: () => env.scope, refreshAccountScopeId: async () => env.scope,
    openCustomInstructionsSettings: () => {}, enterProject: () => {}, applyStateToPanel: () => {},
    showPluginConfirm: async request => { env.prompts.push(request); return env.approve; },
    showPluginToast: (message, detail) => env.toasts.push({ message, detail }),
    sendBackgroundNative: async request => { env.nativeCalls.push(request); return { ok: true, result: {} }; },
    PANEL_STATE_BASE_KEY: 'qaPanel', PROJECT_EDITOR_RESERVED_IDS: new Set(),
    STATUS_BADGE_CLASS: Object.fromEntries(['pending', 'accepted', 'rejected', 'needs_review', 'running', 'completed', 'failed', 'interrupted', 'stale', 'background_completed', 'needs_review_after_navigation', 'abandoned_after_navigation'].map(status => [status, 'badge-' + status.replace(/_/g, '-')])),
    ProjectSessionCleanup: { create: () => ({ clearProjectSessions: async (projectId, name) => { env.clearCalls.push({ projectId, name }); } }) },
    SessionPersistence: {
      isVisibleRecord, loadTombstones: async () => structuredClone(env.deleted),
      getDeletedSessionIds: async projectId => structuredClone(env.deleted[projectId] || []),
      addTombstones: async (projectId, ids) => { env.deleted[projectId] = [...new Set((env.deleted[projectId] || []).concat(ids))]; }
    },
    SessionState, StorageDb: storage,
    StorageKeys: { getProjectStorageKey: (_base, url) => 'legacy:' + url },
    StorageMigration: {
      loadPrefs: async () => ({ untouched: true, activeSessionByProject: {} }),
      savePrefs: async (prefs, scope, projectId) => { env.prefWrites.push(structuredClone({ prefs, scope, projectId })); }
    }
  });
  Object.assign(env, { api, panel, location, document,
    render: async opts => { await api.renderRecentProjectsVariant(opts); await settle(); },
    row: id => panel.querySelector('[data-project-session-row="' + id + '"]'),
    root: () => panel.querySelector('[data-recent-projects-root]')
  });
  return env;
}

test('renameSession shared helper enforces the ghost guard (manual vs auto)', () => {
  const base = SessionState.normalizePanelState({
    sessions: [{ id: 's1', title: '', titleSource: 'auto', task: 'fix the intro', runs: [], history: [] }],
    activeSessionId: 's1'
  });
  const derived = SessionState.deriveSessionTitle(base.sessions[0].runs, base.sessions[0].task);
  const opts = { placeholderTitle: 'New Session' };

  const custom = SessionState.renameSession(base, 's1', 'My survey draft', opts).sessions[0];
  assert.equal(custom.titleSource, 'manual');
  assert.equal(custom.title, 'My survey draft');
  // committing the placeholder or the derived/auto title must stay auto
  assert.equal(SessionState.renameSession(base, 's1', 'New Session', opts).sessions[0].titleSource, 'auto');
  assert.equal(SessionState.renameSession(base, 's1', derived, opts).sessions[0].titleSource, 'auto');
  assert.equal(SessionState.renameSession(base, 's1', '   ', opts).sessions[0].titleSource, 'auto');
  // unknown session id is a normalize-only no-op
  const untouched = SessionState.renameSession(base, 'nope', 'X', opts);
  assert.equal(untouched.sessions[0].title, base.sessions[0].title);
});

test('dashboard session loading uses the injected StorageDb dependency', async () => {
  const src = repo('extension/src/content/recentProjects.js');
  const load = extractFunction(src, 'loadProjectSessionRecords');
  const sandbox = { storageReads: 0 };
  vm.createContext(sandbox);

  const records = await vm.runInContext(
    "const StorageDb = {"
      + "  getAllByIndex: async (store, index, projectId) => {"
      + "    storageReads += 1;"
      + "    return [{ id: 's1', projectId, accountScopeId: 'account-a', lastActivityAt: '2026-07-29T00:00:00.000Z' }];"
      + "  }"
      + "};"
      + "const SessionPersistence = {"
      + "  getDeletedSessionIds: async () => [],"
      + "  isVisibleRecord: (record, _deletedIds, scope) => record.accountScopeId === scope"
      + "};"
      + "function getCachedAccountScopeId() { return 'account-a'; }"
      + load
      + ";loadProjectSessionRecords('project-a');",
    sandbox
  );

  assert.equal(sandbox.storageReads, 1, 'dashboard must read through the StorageDb injected into RecentProjects.create');
  assert.equal(records.length, 1);
  assert.equal(records[0].projectId, 'project-a');
});

test('homepage promotes actual content and keeps empty conversations in a lazy section', async () => {
  const h = dashboardHarness([
    session('empty', PROJECT_A, { title: 'New Session', minutes: 1 }),
    session('latest', PROJECT_A, { title: 'Latest real conversation', minutes: 3, runs: [{ status: 'completed' }] }),
    session('older', PROJECT_B, { title: 'Older conversation', minutes: 6, runs: [{ status: 'completed' }] }),
    session('deleted', PROJECT_A, { minutes: 0, task: 'must stay deleted' }),
    session('foreign', PROJECT_B, { minutes: 0, accountScopeId: 'account-b', task: 'private' }),
    session('unscoped', PROJECT_A, { minutes: 0, accountScopeUnavailable: true, task: 'unknown identity' })
  ], { deleted: { [PROJECT_A]: ['deleted'] } });
  await h.render();
  const focus = h.panel.querySelector('.recent-projects-focus');
  assert.equal(focus.getAttribute('data-project-session-row'), 'latest');
  assert.equal(h.panel.querySelectorAll('[data-session-resume]').length, 1);
  assert.equal(h.allReads, 1);
  assert.equal(h.indexedReads, 0, 'first paint must not fetch every project again');
  for (const id of ['empty', 'deleted', 'foreign', 'unscoped']) assert.equal(h.row(id), null);
  assert.equal(h.row('older').getAttribute('role'), 'button');
  assert.equal(h.row('older').querySelector('.recent-projects-row-badge'), null, 'normal completion should stay quiet');
  const drafts = h.panel.querySelector('[data-unstarted-conversations]');
  await drafts.querySelector('summary').click();
  assert.ok(h.row('empty'));
  assert.equal(h.panel.querySelectorAll('[data-session-resume]').length, 1);
  assert.equal(h.records.length, 6, 'folding must not delete records');
});

test('dashboard project rows expose a guarded one-confirm clear-all action', () => {
  const dashboard = repo('extension/src/content/recentProjects.js');
  const cleanupSource = repo('extension/src/content/projectSessionCleanup.js');
  const clear = extractFunction(cleanupSource, 'clearProjectSessions');
  assert.match(dashboard, /data-project-clear/);
  assert.match(dashboard, /projectSessionCleanup\.clearProjectSessions\(/);
  assert.match(clear, /getAllByIndex\('sessions', 'projectId', projectId\)/);
  assert.match(clear, /record\.accountScopeId === scope/);
  assert.match(clear, /recentProjects_clearProject_running/);
  assert.match(clear, /recentProjects_clearProject_title/);
  assert.match(clear, /destructive: true/);
  assert.match(clear, /SessionState\.deleteSession\(nextState, record\.id\)/);
  assert.match(clear, /deleteRecord\('sessions', record\.id, \{ accountScopeId: scope, projectId \}\)/);
  assert.match(clear, /codex\.history\.clearPlugin/);
  assert.match(clear, /renderRecentProjectsVariant\(\)/);
  const I18n = require('../extension/src/shared/i18n');
  for (const key of ['recentProjects_clearProject', 'recentProjects_clearProject_title', 'recentProjects_clearProject_message', 'recentProjects_clearProject_confirm', 'recentProjects_clearProject_running', 'recentProjects_clearProject_done', 'recentProjects_clearProject_partial', 'recentProjects_clearProject_historyPartial']) {
    assert.notEqual(I18n.t('en', key), key, `missing English ${key}`);
    assert.notEqual(I18n.t('zh', key), key, `missing Chinese ${key}`);
  }
});

test('dashboard delete mirrors the in-project flow: confirm, storage, record, native, toasts', () => {
  const src = repo('extension/src/content/recentProjects.js');
  const del = extractFunction(src, 'deleteDashboardSession');
  // v1.8.1: the hard running-guard became a stronger confirm — zombie
  // sessions must be deletable from the dashboard.
  assert.match(del, /recentProjects_zombieDeleteConfirm/);
  assert.doesNotMatch(del, /deleteSessionRunningToast/,
    'the undeletable hard-guard must not return');
  assert.match(del, /deleteSessionTitle/);
  assert.match(del, /deleteSessionConfirm/);
  assert.match(del, /confirmDefaultCancel/);
  assert.match(del, /destructive: true/);
  assert.match(del, /SessionState\.deleteSession\(state, record\.id\)/);
  assert.match(del, /deleteRecord\('sessions', record\.id\)/);
  assert.match(del, /codex\.history\.clearPlugin/);
  assert.match(del, /sessionId: record\.id/);
  assert.match(del, /threadId: record\.codexThreadId \|\| ''/);
  assert.match(del, /deleteSessionHistoryFailedToast/);
  assert.match(del, /deleteSessionNoThreadToast/);
  assert.match(del, /deleteSessionDoneToast/);
  // the variant re-renders and restores the expansion afterwards
  assert.match(del, /await refreshDashboardView\(\)/);
});

test('dashboard storage writeback uses the same key + normalize/prepare pipeline as saveState', () => {
  const src = repo('extension/src/content/recentProjects.js');
  const mutate = extractFunction(src, 'mutateProjectPanelState');
  assert.match(src, /getProjectStorageKey\(PANEL_STATE_BASE_KEY, 'https:\/\/www\.overleaf\.com\/project\/' \+ projectId\)/);
  assert.match(mutate, /normalizePanelState\(blob\)/);
  assert.match(mutate, /prepareStateForStorage\(nextState\)/);
  // wiring hands over the runtime's storage base key + modal/toast/native fns
  const runtime = repo('extension/src/content/contentRuntime.js');
  assert.match(runtime, /PANEL_STATE_BASE_KEY: LEGACY_STORAGE_KEY/);
  for (const dep of ['showPluginConfirm', 'showPluginToast', 'sendBackgroundNative']) {
    const wiring = runtime.match(/const recentProjects = Modules\.RecentProjects\.create\(\{[\s\S]*?\}\);/)?.[0] || '';
    assert.match(wiring, new RegExp(dep));
  }
});

test('dashboard rename reuses the shared ghost guard and treats unchanged input as cancel', () => {
  const src = repo('extension/src/content/recentProjects.js');
  const begin = extractFunction(src, 'beginDashboardSessionRename');
  assert.match(begin, /record\.titleSource === 'manual'/, 'seed only from a real manual title');
  assert.match(begin, /nextRaw\.trim\(\) === seed\.trim\(\)/, 'unchanged rename is a no-op');
  assert.match(begin, /event\.key === 'Escape'/);
  const commit = extractFunction(src, 'commitDashboardSessionRename');
  assert.match(commit, /SessionState\.renameSession\(/);
  assert.match(commit, /placeholderTitle: tr\('newSessionFallback'\)/);
  assert.match(commit, /buildSessionRecord\(/, 'IndexedDB record renormalized via buildSessionRecord');
});

test('dead project-link-unavailable rows get a cleanup action', () => {
  const src = repo('extension/src/content/recentProjects.js');
  assert.match(src, /data-row-cleanup/);
  const cleanup = extractFunction(src, 'cleanupDeadProjectEntry');
  // destructive confirm with honest copy
  assert.match(cleanup, /recentProjects_cleanup_title/);
  assert.match(cleanup, /recentProjects_cleanup_confirm/);
  assert.match(cleanup, /destructive: true/);
  // full-scan matching (undefined projectId is not indexed) + account scope
  assert.match(cleanup, /getAllSessions\(\)/);
  assert.match(cleanup, /record\.accountScopeId === scope/);
  assert.match(cleanup, /String\(record\.projectId \|\| ''\) === wanted/);
  assert.match(cleanup, /deleteRecord\('sessions', records\[i\]\.id\)/);
  assert.match(cleanup, /codex\.history\.clearPlugin/);
  // the panel-state blob is deliberately untouched: an empty projectId would
  // map getProjectStorageKey onto the global legacy key
  assert.doesNotMatch(cleanup, /mutateProjectPanelState/);
  assert.match(cleanup, /renderRecentProjectsVariant\(\)/);
  const I18n = require('../extension/src/shared/i18n');
  for (const key of ['recentProjects_cleanup', 'recentProjects_cleanup_title', 'recentProjects_cleanup_message', 'recentProjects_cleanup_confirm', 'recentProjects_cleanup_done']) {
    assert.notEqual(I18n.t('en', key), key, `missing English ${key}`);
    assert.notEqual(I18n.t('zh', key), key, `missing Chinese ${key}`);
  }
});

test('homepage copy exists in both locales and focus styling is semantic', () => {
  for (const key of ['recentProjects_focusEyebrow', 'recentProjects_historyHeading', 'recentProjects_projectConversations', 'recentProjects_unstarted', 'recentProjects_loadFailed', 'recentProjects_continueHint']) {
    for (const locale of ['en', 'zh']) assert.notEqual(I18n.t(locale, key), key, 'missing ' + locale + ': ' + key);
  }
  assert.match(I18n.t('zh', 'recentProjects_unstarted', { count: 2 }), /2/);
  const css = repo('extension/styles/panel.css');
  for (const selector of ['recent-projects-focus', 'recent-projects-history-list', 'recent-projects-drafts', 'recent-projects-session-rename-input']) {
    assert.ok(css.includes('.' + selector), 'missing style: ' + selector);
  }
  assert.doesNotMatch(css, /\.recent-projects-row-wrap:first-child\s+\.recent-projects-continue/);
});

test('manual, queued, drafted and compacted conversations do not become empty just because runs are absent', () => {
  const hasContent = vm.runInNewContext('(' + extractFunction(repo('extension/src/content/recentProjects.js'), 'conversationHasContent') + ')');
  const cases = [
    [{ title: 'New Session', titleSource: 'auto', task: '  ' }, false],
    [{ title: 'Named draft', titleSource: 'manual' }, true],
    [{ task: 'Unsent task' }, true],
    [{ pendingInputs: [{ task: 'Queued task' }] }, true],
    [{ history: [{ result: 'Saved response' }] }, true],
    [{ safeTaskSummary: 'Compacted result' }, true],
    [{ codexThreadId: 'existing-thread' }, true],
    [{ runs: [{ status: 'running' }] }, true]
  ];
  for (const [fields, expected] of cases) assert.equal(Boolean(hasContent(fields)), expected, JSON.stringify(fields));
});

test('empty-only history has no fake primary continuation and remains accessible in Chinese', async () => {
  const h = dashboardHarness([session('blank')], { locale: 'zh' });
  await h.render();
  assert.equal(h.panel.querySelector('[data-session-resume]'), null);
  assert.ok(h.panel.textContent.includes(I18n.t('zh', 'recentProjects_noStarted')));
  await h.panel.querySelector('[data-unstarted-conversations]').querySelector('summary').click();
  assert.ok(h.row('blank'));
});

test('storage failures remain errors and a retry can recover without an empty-history claim', async () => {
  const h = dashboardHarness([session('real', PROJECT_A, { task: 'Actual task' })], { readError: new Error('IDB unavailable') });
  await h.render();
  assert.ok(h.panel.textContent.includes(I18n.t('en', 'recentProjects_loadFailed')));
  assert.equal(h.panel.querySelector('[data-recent-projects-empty]'), null);
  h.readError = null;
  await h.panel.querySelector('.recent-projects-show-all').click();
  assert.ok(h.row('real'));
  assert.equal(h.allReads, 2);
});

test('a late account-A query cannot overwrite an account-B dashboard', async () => {
  const wait = deferred();
  const h = dashboardHarness([
    session('account-a-record', PROJECT_A, { task: 'A private context' }),
    session('account-b-record', PROJECT_B, { accountScopeId: 'account-b', task: 'B context' })
  ], { pendingAll: wait });
  const oldRender = h.api.renderRecentProjectsVariant();
  await settle();
  assert.equal(h.allReads, 1);
  h.scope = 'account-b';
  await h.render();
  wait.resolve(structuredClone(h.records));
  await oldRender;
  assert.ok(h.row('account-b-record'));
  assert.equal(h.row('account-a-record'), null);
  assert.equal(h.root().dataset.accountScopeId, 'account-b');
});

test('continuation rechecks visibility and opens the selected session, not a newer sibling', async () => {
  const h = dashboardHarness([session('chosen', PROJECT_A, { task: 'Original', codexThreadId: 'thread-chosen' })]);
  await h.render();
  const button = h.row('chosen').querySelector('[data-session-resume]');
  h.records.push(session('newer', PROJECT_A, { minutes: 1, task: 'Later conversation' }));
  await button.click();
  assert.equal(h.indexedReads, 1);
  assert.equal(h.prefWrites.length, 1);
  assert.equal(h.prefWrites[0].prefs.activeSessionByProject[PROJECT_A], 'chosen');
  assert.equal(h.prefWrites[0].scope, 'account-a');
  assert.deepEqual(h.navigations, ['https://www.overleaf.com/project/' + PROJECT_A]);
  assert.equal(h.nativeCalls.length, 0, 'opening a conversation must not start a task');
});

test('a deleted selection cannot be revived and an account switch cancels pending navigation', async () => {
  const h = dashboardHarness([session('chosen', PROJECT_A, { task: 'Selected task' })]);
  await h.render();
  h.deleted[PROJECT_A] = ['chosen'];
  await h.row('chosen').querySelector('[data-session-resume]').click();
  assert.equal(h.prefWrites.length, 0);
  assert.equal(h.navigations.length, 0);
  assert.ok(h.toasts.some(toast => toast.message === I18n.t('en', 'recentProjects_conversationGone')));
  const wait = deferred();
  const other = dashboardHarness([session('pending', PROJECT_A, { task: 'Context' })], { pendingIndexed: wait });
  await other.render();
  await other.row('pending').querySelector('[data-session-resume]').click();
  other.scope = 'account-b';
  wait.resolve(structuredClone(other.records));
  await settle();
  assert.equal(other.prefWrites.length, 0);
  assert.equal(other.navigations.length, 0);
});

test('project filtering, return, and show-all keep every visible conversation reachable', async () => {
  const records = Array.from({ length: 12 }, (_, i) => session('history-' + i, i % 2 ? PROJECT_B : PROJECT_A, { minutes: i + 1, task: 'Task ' + i }));
  const h = dashboardHarness(records);
  await h.render();
  assert.equal(h.panel.querySelectorAll('[data-project-session-row]').length, 10);
  await h.panel.querySelector('[data-recent-projects-show-all]').click();
  assert.equal(h.panel.querySelectorAll('[data-project-session-row]').length, 12);
  const first = h.row('history-0');
  await first.querySelector('.recent-projects-menu').querySelector('summary').click();
  await first.querySelector('[data-project-conversations]').click();
  assert.equal(h.root().dataset.projectFilter, PROJECT_A);
  assert.equal(h.panel.querySelectorAll('[data-project-session-row]').length, 6);
  await h.panel.querySelector('.recent-projects-filter').querySelector('button').click();
  assert.equal(h.root().dataset.projectFilter, '');
  assert.equal(h.panel.querySelectorAll('[data-project-session-row]').length, 10);
});

test('menu keyboard actions do not navigate and rename updates the nested title and preview', async () => {
  const h = dashboardHarness([
    session('focus', PROJECT_A, { minutes: 1, task: 'Latest' }),
    session('rename-me', PROJECT_B, { minutes: 2, task: 'Older' })
  ]);
  await h.render();
  let row = h.row('rename-me');
  const summary = row.querySelector('.recent-projects-menu').querySelector('summary');
  await summary.fire('keydown', { key: 'Enter' });
  assert.equal(h.navigations.length, 0);
  await summary.click();
  await row.querySelector('[data-session-rename-dash]').click();
  let input = row.querySelector('input');
  assert.ok(input);
  assert.equal(input.parentElement, row.querySelector('.recent-projects-session-copy'));
  input.value = 'Discard this title';
  await input.fire('keydown', { key: 'Escape' });
  assert.equal(h.records.find(record => record.id === 'rename-me').title, 'rename-me');
  await row.querySelector('[data-session-rename-dash]').click();
  input = row.querySelector('input');
  input.value = 'Renamed QA conversation';
  await input.fire('keydown', { key: 'Enter' });
  assert.equal(h.records.find(record => record.id === 'rename-me').title, 'Renamed QA conversation');
  assert.equal(h.records.find(record => record.id === 'rename-me').titleSource, 'manual');
  assert.equal(h.row('rename-me').querySelector('.recent-projects-session-title').textContent, 'Renamed QA conversation');
  assert.equal(h.navigations.length, 0);
});

test('delete keeps cancellation, tombstones, native cleanup and filtered scroll restoration', async () => {
  const target = session('remove-me', PROJECT_A, { task: 'A task', codexThreadId: 'thread-owned' });
  const h = dashboardHarness([target, session('keep-me', PROJECT_A, { minutes: 20, task: 'Keep' }), session('foreign', PROJECT_B, { accountScopeId: 'account-b', task: 'Private' })]);
  await h.render();
  await h.render({ projectFilter: PROJECT_A, showAll: true });
  h.root().scrollTop = 123;
  await h.row('remove-me').querySelector('[data-session-delete-dash]').click();
  assert.equal(h.records.length, 3);
  assert.equal(h.nativeCalls.length, 0);
  h.approve = true;
  await h.row('remove-me').querySelector('[data-session-delete-dash]').click();
  assert.ok(!h.records.some(record => record.id === 'remove-me'));
  assert.ok(h.records.some(record => record.id === 'foreign'));
  assert.ok(h.deleted[PROJECT_A].includes('remove-me'));
  assert.equal(h.nativeCalls[0].method, 'codex.history.clearPlugin');
  assert.equal(h.nativeCalls[0].params.sessionId, 'remove-me');
  assert.equal(h.nativeCalls[0].params.threadId, 'thread-owned');
  assert.equal(h.root().dataset.projectFilter, PROJECT_A);
  assert.equal(h.root().scrollTop, 123);
  assert.ok(h.prompts.every(prompt => prompt.destructive));
});

test('running and invalid-link records retain their existing stronger confirmation paths', async () => {
  const h = dashboardHarness([session('running', PROJECT_A, { minutes: 1, runs: [{ status: 'running' }] }), session('dead', 'invalid', { task: 'Recoverable record' })]);
  await h.render();
  const running = h.row('running');
  assert.equal(running.querySelector('[data-session-rename-dash]').disabled, true);
  await running.querySelector('[data-session-delete-dash]').click();
  assert.ok(h.prompts.at(-1).message.includes(I18n.t('en', 'recentProjects_zombieDeleteConfirm')));
  await running.querySelector('[data-project-clear]').click();
  assert.deepEqual(h.clearCalls, [{ projectId: PROJECT_A, name: 'Alpha' }]);
  assert.equal(h.row('dead'), null);
  const cleanup = h.panel.querySelector('[data-row-cleanup]');
  assert.ok(cleanup);
  await cleanup.click();
  assert.equal(h.prompts.at(-1).title, I18n.t('en', 'recentProjects_cleanup_title'));
  assert.equal(h.prompts.at(-1).destructive, true);
  assert.ok(h.records.some(record => record.id === 'dead'), 'cancelled cleanup must retain the record');
});
