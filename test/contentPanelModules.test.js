const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('contentScript delegates panel construction to focused content modules', () => {
  const contentScript = read('extension/src/content/contentRuntime.js');

  assert.match(contentScript, /Modules\.PanelRenderer/);
  assert.match(contentScript, /Modules\.SessionPanel/);
  assert.match(contentScript, /Modules\.SettingsPanel/);
  assert.match(contentScript, /Modules\.DiagnosticsPanel/);
  assert.match(contentScript, /Modules\.ComposerPanel/);
  assert.match(contentScript, /PanelRenderer\.create/);
  assert.match(contentScript, /SessionPanel\.create/);
  assert.match(contentScript, /SettingsPanel\.create/);
  assert.match(contentScript, /DiagnosticsPanel\.create/);
  assert.match(contentScript, /ComposerPanel\.create/);
  assert.doesNotMatch(contentScript, /panel\.innerHTML\s*=\s*`/);
});

test('new content modules expose the v1 panel API globals', () => {
  const modules = {
    panelRenderer: read('extension/src/content/panelRenderer.js'),
    sessionPanel: read('extension/src/content/sessionPanel.js'),
    settingsPanel: read('extension/src/content/settingsPanel.js'),
    diagnosticsPanel: read('extension/src/content/diagnosticsPanel.js'),
    composerPanel: read('extension/src/content/composerPanel.js')
  };

  assert.match(modules.panelRenderer, /window\.CodexOverleafPanelRenderer\s*=\s*\{/);
  assert.match(modules.panelRenderer, /create,/);
  assert.match(modules.panelRenderer, /setVisible,/);
  assert.match(modules.panelRenderer, /setBadge,/);

  assert.match(modules.sessionPanel, /window\.CodexOverleafSessionPanel\s*=\s*\{/);
  assert.match(modules.sessionPanel, /create,/);
  assert.match(modules.sessionPanel, /update,/);
  assert.match(modules.sessionPanel, /getDisplayTitle/);

  assert.match(modules.settingsPanel, /window\.CodexOverleafSettingsPanel\s*=\s*\{/);
  assert.match(modules.settingsPanel, /create,/);
  assert.match(modules.settingsPanel, /loadState,/);
  assert.match(modules.settingsPanel, /readState,/);

  assert.match(modules.diagnosticsPanel, /window\.CodexOverleafDiagnosticsPanel\s*=\s*\{/);
  assert.match(modules.diagnosticsPanel, /create,/);
  assert.match(modules.diagnosticsPanel, /updateStatus,/);
  assert.match(modules.diagnosticsPanel, /showResult/);

  assert.match(modules.composerPanel, /window\.CodexOverleafComposerPanel\s*=\s*\{/);
  assert.match(modules.composerPanel, /create,/);
  assert.match(modules.composerPanel, /setState,/);
  assert.match(modules.composerPanel, /setModels/);
});

test('session rows are rendered with DOM APIs in the extracted session panel', () => {
  const sessionPanel = read('extension/src/content/sessionPanel.js');
  const renderRow = sessionPanel.match(/function renderSessionRow\(instance, session\) \{[\s\S]*?\n  function beginRename/)?.[0] || '';

  assert.match(renderRow, /document\.createElement\('button'\)/);
  assert.match(renderRow, /row\.dataset\.active/);
  assert.match(renderRow, /row\.dataset\.running/);
  assert.match(sessionPanel, /callbacks\.onRename/);
  assert.doesNotMatch(renderRow, /innerHTML\s*=/);
});

// Task 1: panel view-state and full-screen settings shell

function buildFakeDocument() {
  // Minimal fake DOM for testing panelRenderer and settingsPanel in Node.
  const elements = [];
  function makeEl(tag) {
    const el = {
      tag,
      id: '',
      className: '',
      innerHTML: '',
      textContent: '',
      hidden: false,
      dataset: {},
      style: { setProperty() {} },
      classList: {
        _classes: new Set(),
        add(...cs) { for (const c of cs) this._classes.add(c); },
        remove(...cs) { for (const c of cs) this._classes.delete(c); },
        toggle(c, force) {
          if (force === undefined) { if (this._classes.has(c)) this._classes.delete(c); else this._classes.add(c); }
          else if (force) this._classes.add(c);
          else this._classes.delete(c);
        },
        contains(c) { return this._classes.has(c); }
      },
      _children: [],
      get children() { return this._children; },
      _listeners: {},
      addEventListener(type, fn) {
        if (!this._listeners[type]) this._listeners[type] = [];
        this._listeners[type].push(fn);
      },
      removeEventListener(type, fn) {
        if (this._listeners[type]) this._listeners[type] = this._listeners[type].filter(f => f !== fn);
      },
      _fire(type, event = {}) {
        for (const fn of (this._listeners[type] || [])) fn(event);
      },
      append(...children) { for (const c of children) { this._children.push(c); c._parent = this; } },
      prepend(...children) { for (const c of children.reverse()) { this._children.unshift(c); c._parent = this; } },
      remove() { if (this._parent) this._parent._children = this._parent._children.filter(c => c !== this); },
      querySelector(sel) { return queryOne(this, sel); },
      querySelectorAll(sel) { return queryAll(this, sel); },
      setAttribute(name, value) { this[`_attr_${name}`] = value; },
      getAttribute(name) { return this[`_attr_${name}`] ?? null; },
      focus() {},
      getBoundingClientRect() { return { width: 380 }; },
      setPointerCapture() {},
      _parent: null
    };
    // Intercept innerHTML setter to build a child tree
    let _innerHTML = '';
    Object.defineProperty(el, 'innerHTML', {
      get() { return _innerHTML; },
      set(html) {
        _innerHTML = html;
        el._children = [];
        parseHtml(el, html, makeEl, elements);
      }
    });
    // Intercept textContent setter: setting it clears child elements (real DOM behavior)
    let _textContent = '';
    Object.defineProperty(el, 'textContent', {
      get() { return _textContent; },
      set(value) {
        _textContent = String(value);
        if (_textContent === '') {
          el._children = [];
        }
      }
    });
    elements.push(el);
    return el;
  }

  const docEl = makeEl('html');
  const bodyEl = makeEl('body');
  const doc = {
    documentElement: docEl,
    body: bodyEl,
    createElement(tag) { return makeEl(tag); },
    addEventListener() {},
    removeEventListener() {},
    querySelector(sel) { return queryOne(docEl, sel); }
  };
  return { doc, elements };
}

function parseHtml(parent, html, makeEl, registry) {
  // Simple parser: extract top-level tags and their immediate content.
  // Good enough for the flat templates in panelRenderer and settingsPanel.
  // The void-element branch is FIRST so <input> (which has no closing tag and
  // is commonly written without a trailing slash) is matched as a leaf before
  // the paired-tag branch tries to pair it with a distant closing tag.
  const tagRe = /<(input|br|hr|img|meta|link)\b([^>]*?)\/?>|<(\w[\w-]*)([^>]*)>([\s\S]*?)<\/\3>|<(\w[\w-]*)([^>]*)\/>/g;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[1] || m[3] || m[6];
    const attrs = m[2] || m[4] || m[7] || '';
    const inner = m[5] || '';
    const el = makeEl(tag);
    registry.push(el);

    // Parse id
    const idM = attrs.match(/id="([^"]*)"/);
    if (idM) el.id = idM[1];

    // Parse class
    const classM = attrs.match(/class="([^"]*)"/);
    if (classM) {
      el.className = classM[1];
      for (const c of classM[1].split(/\s+/).filter(Boolean)) el.classList.add(c);
    }

    // Parse data-* attributes
    const dataRe = /data-([\w-]+)(?:="([^"]*)")?/g;
    let dm;
    while ((dm = dataRe.exec(attrs)) !== null) {
      const key = dm[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      el.dataset[key] = dm[2] || '';
    }

    // Parse type, title, aria-label, aria-expanded, hidden, for, href attrs
    for (const [, aName, aVal] of attrs.matchAll(/(\w[\w-]*)="([^"]*)"/g)) {
      el.setAttribute(aName, aVal);
      if (aName === 'hidden') el.hidden = true;
      if (aName === 'type') el.type = aVal;
      if (aName === 'rows') el.rows = Number(aVal);
      if (aName === 'placeholder') el.placeholder = aVal;
      if (aName === 'checked') el.checked = true;
      if (aName === 'value') el.value = aVal;
    }
    if (/\bhidden\b/.test(attrs) && !attrs.includes('hidden="')) el.hidden = true;

    // Recurse into inner
    if (inner.trim()) {
      parseHtml(el, inner, makeEl, registry);
    }

    parent._children.push(el);
    el._parent = parent;
  }
}

function queryOne(root, sel) {
  // Support: [data-foo], [data-foo="bar"], #id, .class, tag, and simple combinator-free forms.
  const results = queryAll(root, sel);
  return results[0] || null;
}

function queryAll(root, sel) {
  const results = [];
  function walk(el) {
    if (matchesSel(el, sel)) results.push(el);
    for (const child of el._children || []) walk(child);
  }
  for (const child of root._children || []) walk(child);
  return results;
}

function matchesSel(el, sel) {
  // Handle comma-separated selectors
  if (sel.includes(',')) {
    return sel.split(',').some(s => matchesSel(el, s.trim()));
  }
  // Handle descendant combinator (space)
  const parts = sel.trim().split(/\s+/);
  if (parts.length > 1) {
    // Match the last part against el, then check ancestors match earlier parts
    if (!matchesSel(el, parts[parts.length - 1])) return false;
    let ancestor = el._parent;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (ancestor && !matchesSel(ancestor, parts[i])) ancestor = ancestor._parent;
      if (!ancestor) return false;
      ancestor = ancestor._parent;
    }
    return true;
  }

  const s = sel.trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1);
    if (inner.includes('=')) {
      const eqIdx = inner.indexOf('=');
      const attr = inner.slice(0, eqIdx).trim();
      const val = inner.slice(eqIdx + 1).replace(/^["']|["']$/g, '');
      if (attr.startsWith('data-')) {
        const key = attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        return el.dataset[key] === val;
      }
      return el.getAttribute(attr) === val;
    }
    const attr = inner.trim();
    if (attr.startsWith('data-')) {
      const key = attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return Object.prototype.hasOwnProperty.call(el.dataset, key);
    }
    return el.getAttribute(attr) !== null;
  }
  if (s.startsWith('#')) return el.id === s.slice(1);
  if (s.startsWith('.')) return el.classList.contains(s.slice(1));
  return el.tag === s;
}

test('panelRenderer.create sets data-view="session" and setView updates it', () => {
  const { doc } = buildFakeDocument();
  const fakeWindow = { innerWidth: 1200, addEventListener() {}, removeEventListener() {} };

  // Load the module into a sandboxed context.
  // The IIFE assigns to the `window` parameter directly, so pass fakeWindow as `window`.
  const src = read('extension/src/content/panelRenderer.js');
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(fakeWindow, doc);

  const PanelRenderer = fakeWindow.CodexOverleafPanelRenderer;
  const result = PanelRenderer.create({
    document: doc,
    container: doc.documentElement,
    window: fakeWindow
  });

  assert.equal(result.panelEl.dataset.view, 'session', 'data-view should be "session" after create');

  result.setView('settings');
  assert.equal(result.panelEl.dataset.view, 'settings', 'setView("settings") should update data-view');

  result.setView('skills');
  assert.equal(result.panelEl.dataset.view, 'skills', 'setView("skills") should update data-view to the third view');

  result.setView('session');
  assert.equal(result.panelEl.dataset.view, 'session', 'setView("session") should revert data-view');
});

test('settingsPanel renders [data-settings-back] and no [data-custom-instructions-close]', () => {
  const { doc } = buildFakeDocument();
  const container = doc.createElement('div');
  doc.documentElement._children.push(container);

  // The IIFE assigns to the `window` parameter directly.
  const fakeWindow2 = {};
  const src = read('extension/src/content/settingsPanel.js');
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(fakeWindow2, doc);

  const SettingsPanel = fakeWindow2.CodexOverleafSettingsPanel;
  SettingsPanel.create({ container });

  const backBtn = container.querySelector('[data-settings-back]');
  const closeBtn = container.querySelector('[data-custom-instructions-close]');

  assert.ok(backBtn, 'should render [data-settings-back] button');
  assert.equal(closeBtn, null, 'should NOT render [data-custom-instructions-close]');
});

test('clicking [data-settings-back] fires the onBack callback', () => {
  const { doc } = buildFakeDocument();
  const container = doc.createElement('div');
  doc.documentElement._children.push(container);

  const fakeWindow3 = {};
  const src = read('extension/src/content/settingsPanel.js');
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(fakeWindow3, doc);

  const SettingsPanel = fakeWindow3.CodexOverleafSettingsPanel;
  let called = false;
  SettingsPanel.create({
    container,
    callbacks: { onBack: () => { called = true; } }
  });

  const backBtn = container.querySelector('[data-settings-back]');
  assert.ok(backBtn, 'back button must exist');
  backBtn._fire('click');
  assert.equal(called, true, 'onBack callback should be fired when back button is clicked');
});

// Task 2: unified auto-save and save-status indicator

test('a change event on [data-custom-instructions-input] fires the onInputChange callback', () => {
  const { doc } = buildFakeDocument();
  const container = doc.createElement('div');
  doc.documentElement._children.push(container);

  const fakeWindow4 = {};
  const src = read('extension/src/content/settingsPanel.js');
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(fakeWindow4, doc);

  const SettingsPanel = fakeWindow4.CodexOverleafSettingsPanel;
  let callCount = 0;
  SettingsPanel.create({
    container,
    callbacks: { onInputChange: () => { callCount++; } }
  });

  const input = container.querySelector('[data-custom-instructions-input]');
  assert.ok(input, '[data-custom-instructions-input] must exist');
  input._fire('change');
  assert.equal(callCount, 1, 'onInputChange should be called once on change event from [data-custom-instructions-input]');
});

test('settingsPanel renders NO [data-custom-instructions-save] button', () => {
  const { doc } = buildFakeDocument();
  const container = doc.createElement('div');
  doc.documentElement._children.push(container);

  const fakeWindow5 = {};
  const src = read('extension/src/content/settingsPanel.js');
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(fakeWindow5, doc);

  const SettingsPanel = fakeWindow5.CodexOverleafSettingsPanel;
  SettingsPanel.create({ container });

  const saveBtn = container.querySelector('[data-custom-instructions-save]');
  assert.equal(saveBtn, null, 'should NOT render [data-custom-instructions-save] button after Task 2');
});

test('OT click interceptor reads the POST-flip checked value as the target (v1.7.5 lock)', () => {
  // The switch died once already: click on a checkbox fires AFTER pre-click
  // activation flips .checked, so `!checkbox.checked` computed the pre-click
  // state and inverted the whole flow (enable ran the disable branch).
  const src = read('extension/src/content/otWarmMirror.js');
  const click = src.match(/async function handleExperimentalOtToggleClick\([\s\S]*?\n  \}/)?.[0] || '';
  assert.match(click, /clicked\.checked/, 'the flipped value IS the intended target');
  assert.match(click, /toggleExperimentalOtCheckbox\(targetEnabled\)/);
  const toggle = src.match(/async function toggleExperimentalOtCheckbox\([\s\S]*?\n  \}/)?.[0] || '';
  assert.match(toggle, /typeof targetEnabled === 'boolean' \? targetEnabled : !checkbox\.checked/,
    'explicit target wins; inversion only for un-flipped callers');
});

test('broad-glob guardrail probes the REAL governance matcher (v1.7.5 lock)', () => {
  // Hardcoded pattern sets cried wolf on inert './**' (never matches) and
  // missed genuinely-total '***'. Verify against the real engine.
  const rules = require('../extension/src/shared/governanceRules');
  const everything = pattern => ['main.tex', 'sections/deep/chapter.tex']
    .every(p => rules.matchesGovernancePattern(p, pattern));
  assert.equal(everything('**'), true);
  assert.equal(everything('***'), true, 'a triple-star really matches everything');
  assert.equal(everything('./**'), false, "'./**' is inert in the real matcher — must NOT warn");
  assert.equal(everything('sections/**'), false);
  const panel = read('extension/src/content/settingsPanel.js');
  assert.match(panel, /matchesGovernancePattern/, 'guardrail delegates to the engine');
  assert.doesNotMatch(panel, /BROAD_GLOBS/, 'the hardcoded set is gone');
});

test('settingsPanel renders per-card saved badges (v1.7.1: global chip replaced)', () => {
  // The single header "Saved" chip was replaced by a ✓ badge on each settings
  // card so feedback appears next to the thing that changed.
  const src = read('extension/src/content/settingsPanel.js');
  assert.doesNotMatch(src, /data-settings-save-status/);
  const badgeCount = (src.match(/data-set-saved/g) || []).length;
  assert.ok(badgeCount >= 6, `every card carries a saved badge (found ${badgeCount})`);
  assert.match(src, /closest\?\.\('details\.codex-set-group, section'\)/,
    'flashSaved targets the changed card');
});

// Task 3: per-skill enable toggles for Codex Overleaf skills

test('codexOverleafSkillEnabled defaults to {} in DEFAULT_PANEL_STATE', () => {
  const SessionState = require('../extension/src/shared/sessionState');
  assert.deepEqual(SessionState.DEFAULT_PANEL_STATE.codexOverleafSkillEnabled, {});
});

test('normalizePanelState preserves codexOverleafSkillEnabled map with valid boolean values', () => {
  const SessionState = require('../extension/src/shared/sessionState');
  const state = SessionState.normalizePanelState({ codexOverleafSkillEnabled: { 'my-skill': false, 'other-skill': true } });
  assert.deepEqual(state.codexOverleafSkillEnabled, { 'my-skill': false, 'other-skill': true });
});

test('normalizePanelState drops non-boolean values from codexOverleafSkillEnabled', () => {
  const SessionState = require('../extension/src/shared/sessionState');
  const state = SessionState.normalizePanelState({ codexOverleafSkillEnabled: { 'good': false, 'bad-string': 'yes', 'bad-num': 42, 'bad-null': null } });
  assert.deepEqual(state.codexOverleafSkillEnabled, { 'good': false });
});

test('normalizePanelState coerces non-object codexOverleafSkillEnabled to {}', () => {
  const SessionState = require('../extension/src/shared/sessionState');
  const a = SessionState.normalizePanelState({ codexOverleafSkillEnabled: null });
  const b = SessionState.normalizePanelState({ codexOverleafSkillEnabled: 'bad' });
  const c = SessionState.normalizePanelState({ codexOverleafSkillEnabled: [1, 2] });
  assert.deepEqual(a.codexOverleafSkillEnabled, {});
  assert.deepEqual(b.codexOverleafSkillEnabled, {});
  assert.deepEqual(c.codexOverleafSkillEnabled, {});
});

test('normalizePanelState absent codexOverleafSkillEnabled becomes {}', () => {
  const SessionState = require('../extension/src/shared/sessionState');
  const state = SessionState.normalizePanelState({});
  assert.deepEqual(state.codexOverleafSkillEnabled, {});
});

test('extractLightweightPrefs round-trips codexOverleafSkillEnabled', () => {
  const StorageDb = require('../extension/src/shared/storageDb');
  const prefs = StorageDb.extractLightweightPrefs({ codexOverleafSkillEnabled: { 'skill-a': false, 'skill-b': true } }, 'proj1');
  assert.deepEqual(prefs.codexOverleafSkillEnabled, { 'skill-a': false, 'skill-b': true });
});

test('extractLightweightPrefs drops non-string keys and non-boolean values from codexOverleafSkillEnabled', () => {
  const StorageDb = require('../extension/src/shared/storageDb');
  const prefs = StorageDb.extractLightweightPrefs({ codexOverleafSkillEnabled: { 'ok': false, 'bad': 'yes', 42: true } }, 'proj1');
  // non-string key (42) is cast to string by JS object, but value 'yes' is non-boolean and should be dropped
  assert.equal(prefs.codexOverleafSkillEnabled['ok'], false);
  assert.ok(!Object.prototype.hasOwnProperty.call(prefs.codexOverleafSkillEnabled, 'bad'), 'non-boolean value should be dropped');
});

test('localSkillsPanel renders per-skill enable checkbox for each codex-overleaf skill row', () => {
  const { doc } = buildFakeDocument();
  const listEl = doc.createElement('div');
  listEl.dataset.localSkillList = '';
  doc.documentElement._children.push(listEl);

  const LocalSkillsPanel = require('../extension/src/content/localSkillsPanel');
  const enabledMap = {};
  const calls = [];

  const controller = LocalSkillsPanel.createLocalSkillsPanelController({
    document: doc,
    getPanel: () => ({ querySelector: sel => sel === '[data-local-skill-list]' ? listEl : null }),
    getState: () => ({ codexOverleafSkills: [{ id: 'my-skill', title: 'My Skill', removable: false }], codexOverleafSkillEnabled: enabledMap }),
    setState: () => {},
    getSkillLoadingSettings: () => ({ loadCodexOverleafSkills: true }),
    isCodexOverleafSkillEnabled: (id) => enabledMap[id] !== false,
    setCodexOverleafSkillEnabled: (id, val) => calls.push({ id, val }),
    tr: key => key,
    tx: (en) => en
  });

  controller.renderLocalSkillList();

  const rows = listEl.querySelectorAll
    ? listEl._children.filter(c => c.className && c.className.includes('codex-local-skill-row'))
    : [];
  assert.equal(rows.length, 1, 'should render one skill row');

  const checkbox = rows[0]._children.find(c => c.tag === 'input' && c.type === 'checkbox');
  assert.ok(checkbox, 'each skill row should have a leading enable checkbox');
  assert.equal(checkbox.checked, true, 'checkbox should be checked when skill is enabled (default true)');
});

test('localSkillsPanel per-skill toggle fires setCodexOverleafSkillEnabled on change', () => {
  const { doc } = buildFakeDocument();
  const listEl = doc.createElement('div');
  listEl.dataset.localSkillList = '';
  doc.documentElement._children.push(listEl);

  const LocalSkillsPanel = require('../extension/src/content/localSkillsPanel');
  const calls = [];

  const controller = LocalSkillsPanel.createLocalSkillsPanelController({
    document: doc,
    getPanel: () => ({ querySelector: sel => sel === '[data-local-skill-list]' ? listEl : null }),
    getState: () => ({ codexOverleafSkills: [{ id: 'toggle-skill', title: 'Toggle Skill', removable: false }], codexOverleafSkillEnabled: {} }),
    setState: () => {},
    getSkillLoadingSettings: () => ({ loadCodexOverleafSkills: true }),
    isCodexOverleafSkillEnabled: () => true,
    setCodexOverleafSkillEnabled: (id, val) => calls.push({ id, val }),
    tr: key => key,
    tx: (en) => en
  });

  controller.renderLocalSkillList();

  const rows = listEl._children.filter(c => c.className && c.className.includes('codex-local-skill-row'));
  assert.equal(rows.length, 1);
  const checkbox = rows[0]._children.find(c => c.tag === 'input' && c.type === 'checkbox');
  assert.ok(checkbox, 'toggle checkbox must exist');

  // Simulate unchecking (disable skill)
  checkbox.checked = false;
  checkbox._fire('change', { target: checkbox });

  assert.equal(calls.length, 1, 'setCodexOverleafSkillEnabled should be called once');
  assert.equal(calls[0].id, 'toggle-skill');
  assert.equal(calls[0].val, false);
});

test('localSkillsPanel disables per-skill toggle when master toggle is off', () => {
  const { doc } = buildFakeDocument();
  const listEl = doc.createElement('div');
  listEl.dataset.localSkillList = '';
  doc.documentElement._children.push(listEl);

  const LocalSkillsPanel = require('../extension/src/content/localSkillsPanel');

  const controller = LocalSkillsPanel.createLocalSkillsPanelController({
    document: doc,
    getPanel: () => ({ querySelector: sel => sel === '[data-local-skill-list]' ? listEl : null }),
    getState: () => ({ codexOverleafSkills: [{ id: 'a-skill', title: 'A Skill', removable: false }], codexOverleafSkillEnabled: {} }),
    setState: () => {},
    getSkillLoadingSettings: () => ({ loadCodexOverleafSkills: false }),
    isCodexOverleafSkillEnabled: () => true,
    setCodexOverleafSkillEnabled: () => {},
    tr: key => key,
    tx: (en) => en
  });

  controller.renderLocalSkillList();

  const rows = listEl._children.filter(c => c.className && c.className.includes('codex-local-skill-row'));
  const checkbox = rows[0]?._children.find(c => c.tag === 'input' && c.type === 'checkbox');
  assert.ok(checkbox, 'toggle checkbox must exist even when master is off');
  assert.equal(checkbox.disabled, true, 'per-skill toggle should be disabled when master toggle is off');
});

// Task 4: skill remove-confirmation + loading states

// Recursively flatten a fake-DOM element tree. Skill rows nest their
// Remove/Confirm/Cancel buttons inside a [codex-local-skill-actions] wrapper,
// so a non-recursive _children scan no longer finds them.
function descendants(el, acc = []) {
  for (const child of el?._children || []) {
    acc.push(child);
    descendants(child, acc);
  }
  return acc;
}

function findRowButton(row, label) {
  return descendants(row).find(c => c.tag === 'button' && c.textContent === label);
}

function buildSkillRowWithRemove(doc, listEl, deps = {}) {
  const LocalSkillsPanel = require('../extension/src/content/localSkillsPanel');
  const nativeCalls = [];
  const controller = LocalSkillsPanel.createLocalSkillsPanelController({
    document: doc,
    getPanel: () => ({ querySelector: sel => sel === '[data-local-skill-list]' ? listEl : null }),
    getState: () => ({ codexOverleafSkills: [{ id: 'removable-skill', title: 'My Skill', removable: true }], codexOverleafSkillEnabled: {} }),
    setState: () => {},
    getSkillLoadingSettings: () => ({ loadCodexOverleafSkills: true }),
    isCodexOverleafSkillEnabled: () => true,
    setCodexOverleafSkillEnabled: () => {},
    setProjectSettingsStatus: () => {},
    tr: key => key,
    tx: (en) => en,
    sendBackgroundNative(req) {
      nativeCalls.push(req);
      return deps.nativeResolve
        ? new Promise(resolve => deps.nativeResolve.push(resolve))
        : Promise.resolve({ ok: true });
    },
    normalizeComposerSkillInvocation: v => v,
    getComposerSkillInvocation: () => null,
    clearComposerSkillInvocation: () => {},
    setSlashCodexOverleafSkills: () => {},
    clearSlashCodexOverleafSkills: () => {},
    saveState: () => Promise.resolve()
  });
  controller.renderLocalSkillList();
  return { controller, nativeCalls };
}

test('clicking Remove button shows Confirm/Cancel and does NOT call skills.remove', () => {
  const { doc } = buildFakeDocument();
  const listEl = doc.createElement('div');
  listEl.dataset.localSkillList = '';
  doc.documentElement._children.push(listEl);

  // Clear module cache so require gets a fresh copy
  delete require.cache[require.resolve('../extension/src/content/localSkillsPanel')];
  const { nativeCalls } = buildSkillRowWithRemove(doc, listEl);

  const rows = listEl._children.filter(c => c.className && c.className.includes('codex-local-skill-row'));
  assert.equal(rows.length, 1, 'should have one skill row');

  // Find the Remove button
  const removeBtn = findRowButton(rows[0], 'localSkillRemove');
  assert.ok(removeBtn, 'Remove button must exist');

  // Click it — should NOT call skills.remove
  removeBtn._fire('click', { preventDefault() {} });

  assert.equal(nativeCalls.filter(r => r.method === 'skills.remove').length, 0, 'clicking Remove should NOT call skills.remove');

  // Row should now have Confirm and Cancel buttons
  const confirmBtn = findRowButton(rows[0], 'localSkillRemoveConfirm');
  const cancelBtn = findRowButton(rows[0], 'localSkillRemoveCancel');
  assert.ok(confirmBtn, 'Confirm button should be shown after clicking Remove');
  assert.ok(cancelBtn, 'Cancel button should be shown after clicking Remove');

  // Original Remove button should be gone
  const originalRemove = findRowButton(rows[0], 'localSkillRemove');
  assert.equal(originalRemove, undefined, 'Original Remove button should not be visible during confirmation');
});

test('clicking Cancel restores the original Remove button', () => {
  const { doc } = buildFakeDocument();
  const listEl = doc.createElement('div');
  listEl.dataset.localSkillList = '';
  doc.documentElement._children.push(listEl);

  delete require.cache[require.resolve('../extension/src/content/localSkillsPanel')];
  buildSkillRowWithRemove(doc, listEl);

  const rows = listEl._children.filter(c => c.className && c.className.includes('codex-local-skill-row'));
  const removeBtn = findRowButton(rows[0], 'localSkillRemove');
  removeBtn._fire('click', { preventDefault() {} });

  // Cancel should restore
  const cancelBtn = findRowButton(rows[0], 'localSkillRemoveCancel');
  assert.ok(cancelBtn, 'Cancel button should be present');
  cancelBtn._fire('click', { preventDefault() {} });

  const restoredRemove = findRowButton(rows[0], 'localSkillRemove');
  assert.ok(restoredRemove, 'Original Remove button should be restored after Cancel');

  const confirmAfterCancel = findRowButton(rows[0], 'localSkillRemoveConfirm');
  assert.equal(confirmAfterCancel, undefined, 'Confirm button should be gone after Cancel');
});

test('clicking Confirm calls skills.remove', async () => {
  const { doc } = buildFakeDocument();
  const listEl = doc.createElement('div');
  listEl.dataset.localSkillList = '';
  doc.documentElement._children.push(listEl);

  delete require.cache[require.resolve('../extension/src/content/localSkillsPanel')];
  const { nativeCalls } = buildSkillRowWithRemove(doc, listEl);

  const rows = listEl._children.filter(c => c.className && c.className.includes('codex-local-skill-row'));
  const removeBtn = findRowButton(rows[0], 'localSkillRemove');
  removeBtn._fire('click', { preventDefault() {} });

  const confirmBtn = findRowButton(rows[0], 'localSkillRemoveConfirm');
  assert.ok(confirmBtn, 'Confirm button should be present');
  confirmBtn._fire('click', { preventDefault() {} });

  // Allow the async remove to settle
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(
    nativeCalls.filter(r => r.method === 'skills.remove').length,
    1,
    'clicking Confirm should call skills.remove exactly once'
  );
  assert.equal(nativeCalls.find(r => r.method === 'skills.remove').params.id, 'removable-skill');
});

test('one-at-a-time: opening confirm on a second row resets the first', () => {
  const { doc } = buildFakeDocument();
  const listEl = doc.createElement('div');
  listEl.dataset.localSkillList = '';
  doc.documentElement._children.push(listEl);

  delete require.cache[require.resolve('../extension/src/content/localSkillsPanel')];
  const LocalSkillsPanel = require('../extension/src/content/localSkillsPanel');
  const controller = LocalSkillsPanel.createLocalSkillsPanelController({
    document: doc,
    getPanel: () => ({ querySelector: sel => sel === '[data-local-skill-list]' ? listEl : null }),
    getState: () => ({
      codexOverleafSkills: [
        { id: 'skill-a', title: 'Skill A', removable: true },
        { id: 'skill-b', title: 'Skill B', removable: true }
      ],
      codexOverleafSkillEnabled: {}
    }),
    setState: () => {},
    getSkillLoadingSettings: () => ({ loadCodexOverleafSkills: true }),
    isCodexOverleafSkillEnabled: () => true,
    setCodexOverleafSkillEnabled: () => {},
    setProjectSettingsStatus: () => {},
    tr: key => key,
    tx: (en) => en,
    sendBackgroundNative: () => Promise.resolve({ ok: true }),
    normalizeComposerSkillInvocation: v => v,
    getComposerSkillInvocation: () => null,
    clearComposerSkillInvocation: () => {},
    setSlashCodexOverleafSkills: () => {},
    clearSlashCodexOverleafSkills: () => {},
    saveState: () => Promise.resolve()
  });
  controller.renderLocalSkillList();

  const rows = listEl._children.filter(c => c.className && c.className.includes('codex-local-skill-row'));
  assert.equal(rows.length, 2, 'should have two skill rows');

  // Open confirm on first row
  const removeA = findRowButton(rows[0], 'localSkillRemove');
  removeA._fire('click', { preventDefault() {} });
  assert.ok(findRowButton(rows[0], 'localSkillRemoveConfirm'), 'row 0 should show Confirm');

  // Open confirm on second row — should reset first row back to Remove
  const removeB = findRowButton(rows[1], 'localSkillRemove');
  removeB._fire('click', { preventDefault() {} });

  assert.equal(findRowButton(rows[0], 'localSkillRemoveConfirm'), undefined, 'row 0 Confirm should be gone when row 1 enters confirm');
  assert.ok(findRowButton(rows[0], 'localSkillRemove'), 'row 0 should have its Remove button restored');
  assert.ok(findRowButton(rows[1], 'localSkillRemoveConfirm'), 'row 1 should now show Confirm');
});

test('skill list shows loading placeholder before refreshLocalSkills resolves', async () => {
  const { doc } = buildFakeDocument();
  const listEl = doc.createElement('div');
  listEl.dataset.localSkillList = '';
  doc.documentElement._children.push(listEl);

  delete require.cache[require.resolve('../extension/src/content/localSkillsPanel')];
  const LocalSkillsPanel = require('../extension/src/content/localSkillsPanel');

  let resolveNative;
  const nativePromise = new Promise(resolve => { resolveNative = resolve; });

  const controller = LocalSkillsPanel.createLocalSkillsPanelController({
    document: doc,
    getPanel: () => ({ querySelector: sel => sel === '[data-local-skill-list]' ? listEl : null }),
    getState: () => ({ codexOverleafSkills: [], codexOverleafSkillEnabled: {} }),
    setState: () => {},
    getSkillLoadingSettings: () => ({ loadCodexOverleafSkills: true }),
    isCodexOverleafSkillEnabled: () => true,
    setCodexOverleafSkillEnabled: () => {},
    setProjectSettingsStatus: () => {},
    tr: key => key,
    tx: (en) => en,
    sendBackgroundNative: () => nativePromise,
    setSlashCodexOverleafSkills: () => {},
    clearSlashCodexOverleafSkills: () => {}
  });

  // Start the refresh (don't await yet)
  const refreshPromise = controller.refreshLocalSkills();

  // Give the microtask queue a tick to allow the loading state to appear
  await new Promise(resolve => setImmediate(resolve));

  // Loading placeholder should be visible before native resolves
  const allText = listEl._children.map(c => c.textContent).join('');
  assert.match(allText, /codexOverleafSkillsLoading/, 'loading placeholder should appear before refreshLocalSkills resolves');

  // Now resolve the native call
  resolveNative({ ok: true, result: { skills: [] } });
  await refreshPromise;

  // After resolution, loading placeholder should be gone
  const afterText = listEl._children.map(c => c.textContent).join('');
  assert.doesNotMatch(afterText, /codexOverleafSkillsLoading/, 'loading placeholder should be gone after refreshLocalSkills resolves');
});

test('confirm failure restores Confirm button and toggle so user can retry', async () => {
  const { doc } = buildFakeDocument();
  const listEl = doc.createElement('div');
  listEl.dataset.localSkillList = '';
  doc.documentElement._children.push(listEl);

  delete require.cache[require.resolve('../extension/src/content/localSkillsPanel')];
  const LocalSkillsPanel = require('../extension/src/content/localSkillsPanel');

  const controller = LocalSkillsPanel.createLocalSkillsPanelController({
    document: doc,
    getPanel: () => ({ querySelector: sel => sel === '[data-local-skill-list]' ? listEl : null }),
    getState: () => ({ codexOverleafSkills: [{ id: 'fail-skill', title: 'Fail Skill', removable: true }], codexOverleafSkillEnabled: {} }),
    setState: () => {},
    getSkillLoadingSettings: () => ({ loadCodexOverleafSkills: true }),
    isCodexOverleafSkillEnabled: () => true,
    setCodexOverleafSkillEnabled: () => {},
    setProjectSettingsStatus: () => {},
    tr: key => key,
    tx: (en) => en,
    sendBackgroundNative(req) {
      if (req.method === 'skills.remove') {
        return Promise.resolve({ ok: false, error: { message: 'removal failed' } });
      }
      return Promise.resolve({ ok: true });
    },
    normalizeComposerSkillInvocation: v => v,
    getComposerSkillInvocation: () => null,
    clearComposerSkillInvocation: () => {},
    setSlashCodexOverleafSkills: () => {},
    clearSlashCodexOverleafSkills: () => {},
    saveState: () => Promise.resolve()
  });

  controller.renderLocalSkillList();

  const rows = listEl._children.filter(c => c.className && c.className.includes('codex-local-skill-row'));
  assert.equal(rows.length, 1, 'should have one skill row');

  // Click Remove, then Confirm
  const removeBtn = findRowButton(rows[0], 'localSkillRemove');
  assert.ok(removeBtn, 'Remove button must exist');
  removeBtn._fire('click', { preventDefault() {} });

  const confirmBtn = findRowButton(rows[0], 'localSkillRemoveConfirm');
  assert.ok(confirmBtn, 'Confirm button should be present after clicking Remove');
  const toggle = rows[0]._children.find(c => c.tag === 'input' && c.type === 'checkbox');
  assert.ok(toggle, 'Toggle checkbox must exist');

  confirmBtn._fire('click', { preventDefault() {} });

  // Allow async rejection to settle
  await new Promise(resolve => setImmediate(resolve));

  // After failure: Confirm button re-enabled, text restored, toggle re-enabled
  assert.equal(confirmBtn.disabled, false, 'Confirm button should be re-enabled after removal failure');
  assert.equal(confirmBtn.textContent, 'localSkillRemoveConfirm', 'Confirm button text should be restored after removal failure');
  assert.equal(toggle.disabled, false, 'Per-skill enable toggle should be re-enabled after removal failure');
});

// Task 5: labels, scope sectioning, cleanup, and type hierarchy

function buildSettingsPanel() {
  const { doc } = buildFakeDocument();
  const container = doc.createElement('div');
  doc.documentElement._children.push(container);
  const fakeWin = {};
  const src = read('extension/src/content/settingsPanel.js');
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(fakeWin, doc);
  const SettingsPanel = fakeWin.CodexOverleafSettingsPanel;
  SettingsPanel.create({ container });
  return { container };
}

test('settingsPanel renders NO [data-custom-instructions-learn-more] element', () => {
  const { container } = buildSettingsPanel();
  const learnMore = container.querySelector('[data-custom-instructions-learn-more]');
  assert.equal(learnMore, null, 'should NOT render [data-custom-instructions-learn-more] after Task 5 cleanup');
});

test('settingsPanel renders NO hidden span with data-i18n="customInstructionsTitle"', () => {
  const { container } = buildSettingsPanel();
  // Query all spans and look for any with dataset.i18n === 'customInstructionsTitle'
  function findAll(el, pred, acc = []) {
    if (pred(el)) acc.push(el);
    for (const child of el._children || []) findAll(child, pred, acc);
    return acc;
  }
  const deadSpans = findAll(container, el =>
    el.tag === 'span' && el.dataset && el.dataset.i18n === 'customInstructionsTitle'
  );
  assert.equal(deadSpans.length, 0, 'should NOT render a span with data-i18n="customInstructionsTitle" (dead markup removed)');
});

test('settingsPanel source includes scope section headings for "This project" and "All projects"', () => {
  // Source-text assertion: the fake-DOM parser cannot resolve nested same-tag <div> structure. TODO: switch to a DOM ancestry assertion if the parser is upgraded.
  // Verify the raw source markup contains the scope heading i18n keys.
  // (The fake DOM parser doesn't handle deeply nested divs, so we test the source directly.)
  const src = read('extension/src/content/settingsPanel.js');
  assert.match(src, /data-i18n="settingsScopeProjectTitle"/, 'settingsPanel should include data-i18n="settingsScopeProjectTitle"');
  assert.match(src, /data-i18n="settingsScopeGlobalTitle"/, 'settingsPanel should include data-i18n="settingsScopeGlobalTitle"');
});

test('[data-project-settings-status] appears before skill loading controls in settingsPanel source', () => {
  // Source-text assertion: the fake-DOM parser cannot resolve nested same-tag <div> structure. TODO: switch to a DOM ancestry assertion if the parser is upgraded.
  // Verify [data-project-settings-status] is positioned at panel level (before the skill toggles),
  // not nested inside the skill list section. We check source order as a proxy for DOM position.
  const src = read('extension/src/content/settingsPanel.js');
  const statusIdx = src.indexOf('data-project-settings-status');
  const skillToggleIdx = src.indexOf('data-load-codex-local-skills');
  const skillListIdx = src.indexOf('data-local-skill-list');
  const scopeIdx = src.indexOf('codex-project-settings-scope');
  assert.ok(statusIdx >= 0, '[data-project-settings-status] must appear in settingsPanel source');
  assert.ok(skillToggleIdx >= 0, '[data-load-codex-local-skills] must appear in settingsPanel source');
  assert.ok(skillListIdx >= 0, '[data-local-skill-list] must appear in settingsPanel source');
  assert.ok(scopeIdx >= 0, 'codex-project-settings-scope must appear in settingsPanel source');
  assert.ok(
    statusIdx < skillToggleIdx,
    '[data-project-settings-status] must appear before [data-load-codex-local-skills] in source (panel-level, not inside skills section)'
  );
  assert.ok(
    statusIdx < skillListIdx,
    '[data-project-settings-status] must appear before [data-local-skill-list] in source (panel-level, not inside skills section)'
  );
  assert.ok(
    statusIdx < scopeIdx,
    '[data-project-settings-status] must appear before the first codex-project-settings-scope block in source (panel-level, not inside a scope)'
  );
});

// Task 6: Codex Overleaf skills moved to a dedicated sub-page with sliding switches

test('settingsPanel renders a navigable [data-skills-entry] row and NOT the inline master/list', () => {
  const { container } = buildSettingsPanel();

  const entry = container.querySelector('[data-skills-entry]');
  assert.ok(entry, 'settings screen should render a [data-skills-entry] navigation row');

  const summary = container.querySelector('[data-skills-entry-summary]');
  assert.ok(summary, 'the skills entry row should have a [data-skills-entry-summary] element');

  // The inline master checkbox and skill list move to the skills screen,
  // so they must no longer live inside the settings screen <section>.
  const settingsScreen = container.querySelector('[data-project-settings-panel]');
  assert.ok(settingsScreen, 'settings screen section must exist');
  assert.equal(
    settingsScreen.querySelector('[data-load-codex-overleaf-skills]'),
    null,
    'the master "Load Codex Overleaf skills" control must NOT be inside the settings screen'
  );
  assert.equal(
    settingsScreen.querySelector('[data-local-skill-list]'),
    null,
    'the [data-local-skill-list] must NOT be inside the settings screen'
  );
});

test('settingsPanel renders a dedicated skills screen with its own header, master toggle, and skill list', () => {
  const { container } = buildSettingsPanel();

  const skillsScreen = container.querySelector('[data-skills-screen]');
  assert.ok(skillsScreen, 'a [data-skills-screen] section must be rendered');

  const backBtn = skillsScreen.querySelector('[data-skills-back]');
  assert.ok(backBtn, 'the skills screen must render a [data-skills-back] button');

  const masterToggle = skillsScreen.querySelector('[data-load-codex-overleaf-skills]');
  assert.ok(masterToggle, 'the master "Load Codex Overleaf skills" toggle must live on the skills screen');
  assert.equal(masterToggle.type, 'checkbox', 'the master toggle must remain a real checkbox input');

  const list = skillsScreen.querySelector('[data-local-skill-list]');
  assert.ok(list, 'the [data-local-skill-list] must live on the skills screen');
});

test('clicking [data-skills-back] fires the onSkillsBack callback', () => {
  const { doc } = buildFakeDocument();
  const container = doc.createElement('div');
  doc.documentElement._children.push(container);

  const fakeWin = {};
  const src = read('extension/src/content/settingsPanel.js');
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(fakeWin, doc);

  const SettingsPanel = fakeWin.CodexOverleafSettingsPanel;
  let called = false;
  SettingsPanel.create({
    container,
    callbacks: { onSkillsBack: () => { called = true; } }
  });

  const backBtn = container.querySelector('[data-skills-back]');
  assert.ok(backBtn, 'skills back button must exist');
  backBtn._fire('click');
  assert.equal(called, true, 'onSkillsBack callback should fire when the skills back button is clicked');
});

test('clicking [data-skills-entry] fires the onSkillsOpen callback', () => {
  const { doc } = buildFakeDocument();
  const container = doc.createElement('div');
  doc.documentElement._children.push(container);

  const fakeWin = {};
  const src = read('extension/src/content/settingsPanel.js');
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(fakeWin, doc);

  const SettingsPanel = fakeWin.CodexOverleafSettingsPanel;
  let called = false;
  SettingsPanel.create({
    container,
    callbacks: { onSkillsOpen: () => { called = true; } }
  });

  const entry = container.querySelector('[data-skills-entry]');
  assert.ok(entry, 'skills entry row must exist');
  entry._fire('click');
  assert.equal(called, true, 'onSkillsOpen callback should fire when the skills entry row is clicked');
});

test('settingsPanel.setSkillsSummary updates the [data-skills-entry-summary] text', () => {
  const { doc } = buildFakeDocument();
  const container = doc.createElement('div');
  doc.documentElement._children.push(container);

  const fakeWin = {};
  const src = read('extension/src/content/settingsPanel.js');
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(fakeWin, doc);

  const SettingsPanel = fakeWin.CodexOverleafSettingsPanel;
  const instance = SettingsPanel.create({ container });

  instance.setSkillsSummary('3 enabled');
  assert.equal(
    container.querySelector('[data-skills-entry-summary]').textContent,
    '3 enabled',
    'setSkillsSummary should write the summary text into the entry row'
  );

  instance.setSkillsSummary('Off');
  assert.equal(
    container.querySelector('[data-skills-entry-summary]').textContent,
    'Off',
    'setSkillsSummary should overwrite the summary text'
  );
});

test('settingsPanel exposes setSkillsSummary in its module API', () => {
  const settingsPanelSrc = read('extension/src/content/settingsPanel.js');
  assert.match(settingsPanelSrc, /window\.CodexOverleafSettingsPanel\s*=\s*\{/);
  assert.match(settingsPanelSrc, /setSkillsSummary/);
});

// Returns the start..end (brace-balanced) source of a named function declaration
// so the real settings-coordinator helpers can be evaluated inside a synthetic scope.
function extractRuntimeFunction(source, name) {
  const markers = [`function ${name}(`, `async function ${name}(`];
  const start = markers
    .map(marker => source.indexOf(marker))
    .filter(index => index !== -1)
    .sort((a, b) => a - b)[0] ?? -1;
  assert.notEqual(start, -1, `${name} should exist in the settings coordinator source`);
  const openBrace = source.indexOf('{', start);
  let depth = 0;
  for (let index = openBrace; index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`${name} body should close`);
}

test('skills entry-row summary tracks the enabled-skill state through the real summary path', () => {
  // This test wires the REAL settingsPanel, the REAL localSkillsPanel controller,
  // and the REAL project-settings summary helpers (updateSkillsEntrySummary /
  // countEnabledCodexOverleafSkills / renderLocalSkillList / per-skill enable
  // state) together. Nothing in the summary-writing path is stubbed, so it
  // genuinely verifies that the [data-skills-entry-summary] text stays in sync.
  const { doc } = buildFakeDocument();
  const container = doc.createElement('div');
  doc.documentElement._children.push(container);

  // Real settingsPanel: builds the skills entry row + [data-local-skill-list].
  const fakeWin = {};
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', read('extension/src/content/settingsPanel.js'))(fakeWin, doc);
  const SettingsPanel = fakeWin.CodexOverleafSettingsPanel;
  const settingsPanelInstance = SettingsPanel.create({ container });

  // Real i18n so the summary text is produced by the production string table.
  delete require.cache[require.resolve('../extension/src/shared/i18n')];
  const I18n = require('../extension/src/shared/i18n');
  const tr = (key, params) => I18n.t('en', key, params);

  // Real localSkillsPanel controller.
  delete require.cache[require.resolve('../extension/src/content/localSkillsPanel')];
  const LocalSkillsPanel = require('../extension/src/content/localSkillsPanel');

  const projectSettingsSrc = read('extension/src/content/projectSettingsCoordinator.js');
  const harness = Function(
    'SettingsPanel', 'LocalSkillsPanel', 'settingsPanelInstance', 'tr', 'panel',
    `
    let state = {
      codexOverleafSkills: [
        { id: 'skill-a', title: 'Skill A', removable: false },
        { id: 'skill-b', title: 'Skill B', removable: false }
      ],
      codexOverleafSkillEnabled: {},
      loadCodexOverleafSkills: true
    };
    function getState() { return state; }
    function setState(next) { state = next; }
    function getSettingsPanelInstance() { return settingsPanelInstance; }
    function getLocalSkillsPanel() { return localSkillsPanel; }
    function setMasterEnabled(value) { state = { ...state, loadCodexOverleafSkills: value }; }
    function saveStateSoon() {}
    // Real localSkillsPanel controller, fed the synthetic state.
    const localSkillsPanel = LocalSkillsPanel.createLocalSkillsPanelController({
      document: panel.ownerDocument,
      getPanel: () => panel,
      getState: () => state,
      setState: next => { state = next; },
      getSkillLoadingSettings,
      isCodexOverleafSkillEnabled,
      setCodexOverleafSkillEnabled,
      tr,
      tx: en => en
    });
    ${extractRuntimeFunction(projectSettingsSrc, 'getSkillLoadingSettings')}
    ${extractRuntimeFunction(projectSettingsSrc, 'getCodexOverleafSkillEnabled')}
    ${extractRuntimeFunction(projectSettingsSrc, 'isCodexOverleafSkillEnabled')}
    ${extractRuntimeFunction(projectSettingsSrc, 'setCodexOverleafSkillEnabled')}
    ${extractRuntimeFunction(projectSettingsSrc, 'countEnabledCodexOverleafSkills')}
    ${extractRuntimeFunction(projectSettingsSrc, 'updateSkillsEntrySummary')}
    ${extractRuntimeFunction(projectSettingsSrc, 'renderLocalSkillList')}
    return {
      renderLocalSkillList,
      setMasterEnabled,
      getState: () => state
    };
    `
  );

  // The local-skill list lives inside the settingsPanel template.
  const listEl = container.querySelector('[data-local-skill-list]');
  assert.ok(listEl, 'settingsPanel must render the [data-local-skill-list]');
  const panel = {
    ownerDocument: doc,
    querySelector: sel => (sel === '[data-local-skill-list]' ? listEl : container.querySelector(sel))
  };

  const runtime = harness(SettingsPanel, LocalSkillsPanel, settingsPanelInstance, tr, panel);

  // Initial render: both skills enabled by default (absent => enabled).
  runtime.renderLocalSkillList();
  const summaryEl = container.querySelector('[data-skills-entry-summary]');
  assert.equal(summaryEl.textContent, '2 enabled',
    'summary should reflect 2 enabled skills after the initial render');

  // Flip a per-skill toggle off via its real change handler -> setCodexOverleafSkillEnabled
  // -> renderLocalSkillList -> updateSkillsEntrySummary.
  const rows = listEl._children.filter(c => c.className && c.className.includes('codex-local-skill-row'));
  assert.equal(rows.length, 2, 'two skill rows should render');
  const firstToggle = rows[0]._children.find(c => c.tag === 'input' && c.type === 'checkbox');
  assert.ok(firstToggle, 'per-skill toggle must exist');
  firstToggle.checked = false;
  firstToggle._fire('change', { target: firstToggle });

  assert.equal(
    container.querySelector('[data-skills-entry-summary]').textContent,
    '1 enabled',
    'summary should drop to "1 enabled" after a per-skill toggle is switched off'
  );

  // Master toggle off: summary should show the "Off" form.
  runtime.setMasterEnabled(false);
  runtime.renderLocalSkillList();
  assert.equal(
    container.querySelector('[data-skills-entry-summary]').textContent,
    'Off',
    'summary should show "Off" when the master toggle is disabled'
  );
});

test('the "Load local Codex skills" control and skill toggles render as sliding switches', () => {
  const settingsPanelSrc = read('extension/src/content/settingsPanel.js');
  const localSkillsSrc = read('extension/src/content/localSkillsPanel.js');

  // The local-skills control row must carry the sliding-switch class.
  assert.match(settingsPanelSrc, /codex-switch/, 'settingsPanel should use the codex-switch sliding-switch class');
  // The per-skill enable toggle must carry the sliding-switch class.
  assert.match(localSkillsSrc, /codex-switch/, 'localSkillsPanel should render the per-skill toggle as a codex-switch');

  // A+ redesign: every boolean setting (governance + skills) uses the unified
  // sliding-switch treatment, so the governance toggles carry the switch class too.
  const sensitiveCheck = settingsPanelSrc.match(/<input[^>]*data-sensitive-check-enabled[^>]*>/)?.[0] || '';
  const sensitiveConfirm = settingsPanelSrc.match(/<input[^>]*data-sensitive-confirm-allowed[^>]*>/)?.[0] || '';
  assert.match(sensitiveCheck, /codex-switch/, 'sensitive-check toggle should render as a sliding switch');
  assert.match(sensitiveConfirm, /codex-switch/, 'sensitive-confirm toggle should render as a sliding switch');
});

test('panel.css defines the sliding-switch component and the data-view="skills" rules', () => {
  const css = read('extension/styles/panel.css');
  assert.match(css, /\.codex-switch/, 'panel.css must define the .codex-switch sliding-switch component');
  assert.match(css, /\[data-view="skills"\]/, 'panel.css must define [data-view="skills"] visibility rules');
  assert.match(css, /\.codex-skills-entry/, 'panel.css must style the skills entry row');
});
