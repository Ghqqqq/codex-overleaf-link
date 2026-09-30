'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const root = process.env.CODEX_OVERLEAF_REPO || path.resolve(__dirname, '..');
const Activity = require(path.join(root, 'extension/src/shared/runActivityModel'));
const Agents = require(path.join(root, 'extension/src/shared/subagentActivityModel'));
const Sessions = require(path.join(root, 'extension/src/shared/sessionState'));
const Storage = require(path.join(root, 'extension/src/shared/storageDb'));

class Element {
  constructor(document, tag) {
    this.ownerDocument = document; this.tagName = tag.toUpperCase();
    this.children = []; this.parentNode = null; this.dataset = {}; this.attributes = {};
    this.className = ''; this.listeners = new Map(); this._text = '';
    this.inert = false; this.hidden = false; this.open = false;
    this.scrollTop = 0; this.scrollHeight = 100; this.clientHeight = 100;
    this.classList = { add: (...names) => {
      this.className = [...new Set(this.className.split(/\s+/).filter(Boolean).concat(names))].join(' ');
    } };
  }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentNode?.isConnected); }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children.at(-1) || null; }
  get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value ?? ''); }
  get innerHTML() { return this._text; }
  set innerHTML(value) { this.textContent = value; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) {
    if (name.startsWith('data-')) return this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] ?? null;
    return this.attributes[name] ?? null;
  }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, reference) {
    if (node === reference) return node;
    node.remove();
    const index = reference ? this.children.indexOf(reference) : this.children.length;
    if (index < 0) throw new Error('Reference is not a child');
    this.children.splice(index, 0, node); node.parentNode = this; return node;
  }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  before(node) { this.parentNode.insertBefore(node, this); }
  after(node) { this.parentNode.insertBefore(node, this.nextSibling); }
  replaceChildren(...nodes) { for (const node of [...this.children]) node.remove(); this._text = ''; this.append(...nodes); }
  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    const attr = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attr) return attr[2] === undefined ? this.getAttribute(attr[1]) !== null : this.getAttribute(attr[1]) === attr[2];
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => (child.matches(selector) ? [child] : []).concat(child.querySelectorAll(selector)));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); }
  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener({ target: this, preventDefault() {}, stopPropagation() {}, ...event });
  }
  click() { this.dispatch('click'); }
  focus() { this.ownerDocument.activeElement = this; }
}

function child(overrides = {}) {
  return { key: 'codex:child-a', source: 'codex', threadId: 'child-a', title: 'Inspect main',
    task: 'Read the main title', status: 'running', startedAt: '2026-09-29T00:00:00.000Z', events: [
      { kind: 'stream', streamRole: 'assistant', title: 'Child answer', status: 'running' },
      { title: 'Read main.tex', status: 'completed', activity: { v: 1, kind: 'command', scope: 'child-a', id: 'read-main',
        state: 'completed', command: 'head -5 main.tex', output: 'title: Your Paper' } }
    ], ...overrides };
}
function makeRun(children = [child()]) {
  return { id: 'parent-run', task: 'Parallel read', status: 'running', mode: 'ask',
    events: [{ kind: 'stream', streamRole: 'assistant', title: 'Main keeps working', status: 'running' }], subagents: children };
}
function harness(run = makeRun()) {
  const document = { createElement: tag => new Element(document, tag) };
  document.body = document.createElement('body');
  const panel = document.createElement('aside'), log = document.createElement('div'), composer = document.createElement('textarea');
  log.dataset.log = ''; log.scrollTop = 37; composer.value = 'Unsent draft';
  const alreadyInert = document.createElement('div'); alreadyInert.inert = true;
  panel.append(log, composer, alreadyInert); document.body.append(panel);
  const card = document.createElement('section'); card.dataset.runId = run.id;
  const process = document.createElement('details'); process.dataset.runProcess = '';
  const summary = document.createElement('summary'); summary.dataset.runProcessSummary = '';
  const status = document.createElement('span'); status.dataset.runStatus = ''; summary.append(status);
  const events = document.createElement('div'); events.dataset.runEvents = '';
  process.append(summary, events); card.append(process); log.append(card);
  const modules = { RunActivityModel: Activity, SubagentActivityModel: Agents };
  const warnings = [], controls = { throwChild: false };
  const context = { document, console: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
    sessionStorage: { getItem: () => null, setItem() {} },
    CodexOverleafModuleRegistry: { define(name, dependencies, factory) {
      modules[name] = factory(...dependencies.map(name => modules[name]));
      context['CodexOverleaf' + name] = modules[name];
    } } };
  context.window = context;
  for (const name of ['subagentActivityView', 'runActivitySummary'])
    vm.runInNewContext(fs.readFileSync(path.join(root, 'extension/src/content/' + name + '.js'), 'utf8'), context);
  const summaryApi = modules.RunActivitySummary || context.CodexOverleafRunActivitySummary;
  const ui = summaryApi.create({ RunActivityModel: Activity, SubagentActivityView: modules.SubagentActivityView,
    tx: en => en, findRunRecord: id => id === run.id ? run : null, getPanel: () => panel, cssEscape: String,
    isGuidance: () => false, formatElapsed: ms => String(ms), sanitizeAssistantVisibleText: String,
    renderMarkdownBlockText(node, value) {
      if (controls.throwChild && value === 'Child answer') throw new Error('Injected child Markdown failure');
      node.textContent = value;
    }, renderRunEvent(event) { const el = document.createElement('div'); el.textContent = event.title; return el; }
  });
  ui.mount(card, run);
  return { ui, run, panel, log, composer, alreadyInert, card, status, document, warnings, controls,
    update: () => ui.update({ root: card, recordId: run.id }),
    open: (index = 0) => card.querySelectorAll('.run-subagent-row')[index].click(),
    viewer: () => panel.querySelector('.codex-subagent-view') };
}

test('real child viewer supplies the shared tool renderer with its own activity projection', () => {
  const h = harness();
  h.open();
  assert.match(h.viewer().querySelector('.run-workflow-list').textContent, /head -5 main.tex/);
  assert.match(h.viewer().textContent, /Child answer/);
  assert.equal(h.warnings.length, 0);
  h.run.subagents[0].events[1].activity.output = 'updated child output';
  assert.doesNotThrow(h.update);
  assert.match(h.viewer().textContent, /updated child output/);
  h.run.subagents[0].status = 'completed'; h.run.status = 'completed';
  assert.doesNotThrow(() => h.ui.settle({ root: h.card, recordId: h.run.id, status: h.status }, 'Done'));
  assert.equal(h.status.textContent, 'Done');
  assert.match(h.viewer().querySelector('.codex-subagent-meta').textContent, /Completed/);
  assert.equal(h.viewer().querySelector('.codex-subagent-parent-label').textContent, 'Main agent · Run ended');
});

test('child notice expansion uses child notices without suppressing real failures', () => {
  const c = child({ events: [{ title: 'Compilation failed', status: 'failed',
    activity: { v: 1, kind: 'compile', state: 'failed', scope: 'child-a', id: 'compile-child' } }] });
  const h = harness(makeRun([c])); h.open();
  const tool = h.viewer().querySelector('.run-workflow-tool');
  assert.equal(tool.dataset.state, 'failed');
  assert.equal(tool.open, true);
  assert.equal(h.warnings.length, 0);
});

test('diagnostic-only advisories never replace a child progress preview', () => {
  const c = child(); c.events.push({ title: 'Codex is ignoring 2 unrecognized configuration settings.', status: 'warning',
    activity: { v: 1, kind: 'notice', state: 'warning', noticeSource: 'configWarning' } });
  const h = harness(makeRun([c]));
  const preview = h.card.querySelector('.run-subagent-activity').textContent;
  assert.match(preview, /head -5 main.tex/);
  assert.doesNotMatch(preview, /configuration settings/);
  h.open(); assert.doesNotMatch(h.viewer().querySelector('.run-workflow-list').textContent, /configuration settings/);
});

test('a child rendering exception remains local and cannot prevent parent settlement', () => {
  const h = harness(); h.controls.throwChild = true;
  assert.doesNotThrow(h.open);
  assert.equal(h.viewer().querySelector('.codex-subagent-empty').hidden, false);
  assert.match(h.viewer().querySelector('.codex-subagent-empty').textContent, /Unable to display/);
  h.run.status = 'completed';
  assert.doesNotThrow(() => h.ui.settle({ root: h.card, recordId: h.run.id, status: h.status }, 'Done'));
  assert.equal(h.status.textContent, 'Done');
  assert.equal(h.warnings.length, 1);
  h.controls.throwChild = false;
  assert.doesNotThrow(h.update);
  assert.match(h.viewer().querySelector('.run-workflow-list').textContent, /Child answer/);
  assert.equal(h.viewer().querySelector('.codex-subagent-empty').hidden, true);
});

test('closing a child viewer restores draft, focus, inert states and scroll position', () => {
  const h = harness(); const trigger = h.card.querySelector('.run-subagent-row'); h.open();
  assert.equal(h.log.inert, true); assert.equal(h.composer.inert, true);
  h.viewer().dispatch('keydown', { key: 'Escape' });
  assert.equal(h.viewer(), null); assert.equal(h.log.inert, false); assert.equal(h.composer.inert, false);
  assert.equal(h.alreadyInert.inert, true); assert.equal(h.composer.value, 'Unsent draft');
  assert.equal(h.document.activeElement, trigger); assert.equal(h.log.scrollTop, 37);
});

test('persisted completed children still open through the real shared renderer after recovery', () => {
  const run = makeRun(); run.status = 'completed'; run.subagents[0].status = 'completed';
  const stored = Storage.buildSessionRecord({ id: 'history-session', projectId: 'qa-project', runs: [run] });
  const restored = Sessions.normalizeRuns(JSON.parse(JSON.stringify(stored.runs)))[0];
  const h = harness(restored); h.open();
  assert.match(h.viewer().querySelector('.run-workflow-list').textContent, /head -5 main.tex/);
  assert.equal(h.warnings.length, 0);
  assert.equal(h.run.status, 'completed');
});

test('missing or encrypted assignment text stays hidden until real task metadata arrives', () => {
  const h = harness(makeRun([child({ task: '', events: [] })])); h.open();
  assert.equal(h.viewer().querySelector('.codex-subagent-assignment').hidden, true);
  assert.doesNotMatch(h.viewer().textContent, /no prompt text/);
  h.run.subagents[0].task = 'Read bibliography entries'; h.update();
  assert.equal(h.viewer().querySelector('.codex-subagent-assignment').hidden, false);
  assert.match(h.viewer().querySelector('.codex-subagent-assignment').textContent, /Read bibliography entries/);
});

test('switching child conversations keeps tool state and notice projection isolated', () => {
  const second = child({ key: 'codex:child-b', threadId: 'child-b', title: 'Check bibliography', task: 'Inspect sample.bib',
    events: [{ title: 'Child B compile failed', status: 'failed',
      activity: { v: 1, kind: 'compile', scope: 'child-b', id: 'compile-b', state: 'failed' } }] });
  const h = harness(makeRun([child(), second])); h.open();
  h.viewer().querySelector('.codex-subagent-siblings').children[1].click();
  assert.equal(h.viewer().querySelector('.codex-subagent-title').textContent, 'Check bibliography');
  assert.equal(h.viewer().querySelector('.run-workflow-tool').open, true);
  assert.doesNotMatch(h.viewer().querySelector('.run-workflow-list').textContent, /head -5 main.tex/);
  h.viewer().querySelector('.codex-subagent-siblings').children[0].click();
  assert.match(h.viewer().querySelector('.run-workflow-list').textContent, /head -5 main.tex/);
  assert.equal(h.viewer().querySelector('.run-workflow-tool').open, false);
  assert.equal(h.warnings.length, 0);
});
