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
function harness(run = makeRun(), { tx = en => en } = {}) {
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
    tx, findRunRecord: id => id === run.id ? run : null, getPanel: () => panel, cssEscape: String,
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

test('a live reasoning round streams its tail, then folds to a timed line whose full text renders on open', () => {
  const run = makeRun([]);
  run.events = [
    { kind: 'activity', title: 'Codex is analyzing.', timestamp: '2026-09-30T14:47:13.000Z',
      activity: { v: 1, kind: 'lifecycle', state: 'running', target: 'working' } },
    { kind: 'stream', streamRole: 'reasoning', streamKey: 'think-1', status: 'running',
      title: 'Check the decision rule first. Then the algorithm box.', timestamp: '2026-09-30T14:47:31.000Z' }
  ];
  const h = harness(run);
  const row = () => h.card.querySelector('.run-workflow-thought');
  assert.equal(row().dataset.live, 'true');
  assert.match(row().querySelector('.run-workflow-thought-tail').textContent, /algorithm box/);
  run.events[1].status = 'completed';
  run.status = 'completed';
  h.update();
  assert.equal(row().dataset.live, 'false');
  assert.equal(row().querySelector('.run-workflow-thought-label').textContent, 'Thought 18000');
  assert.equal(row().querySelector('.run-workflow-thought-lead').textContent, 'Check the decision rule first.');
  assert.equal(row().querySelector('.run-workflow-thought-full').textContent, '', 'full text waits until opened');
  row().open = true;
  row().dispatch('toggle');
  assert.match(row().querySelector('.run-workflow-thought-full').textContent, /Then the algorithm box\./);
});

function setupRun() {
  const at = seconds => new Date(Date.parse('2026-10-01T03:29:11.000Z') + seconds * 1000).toISOString();
  const run = makeRun([]);
  run.mode = 'auto';
  run.events = [
    ['Checking Overleaf Editing mode before starting.', 'running', 0],
    ['Overleaf is already in Editing mode. Starting the task.', 'completed', 0.1],
    ['Syncing the Overleaf project to the local Codex workspace.', 'running', 5.3],
    ['Read Overleaf project: 39 text file(s), 19 asset file(s), current file: Thesis_v1.tex.', 'completed', 16.8],
    ['Note: 1 file(s) have empty/loading content.', 'info', 16.8],
    ['Local Codex session is starting.', 'running', 16.8],
    ['Using Codex CLI 0.159.0; 2 installations were detected.', 'completed', 17.3],
    ['Synced 58 text files. Local Codex will work from this workspace.', 'completed', 17.3]
  ].map(([title, status, seconds]) => ({ kind: 'activity', title, status, timestamp: at(seconds) }));
  run.events.push({ kind: 'activity', title: 'Codex started processing this request.', status: 'running', timestamp: at(17.8),
    activity: { v: 1, kind: 'lifecycle', state: 'running', target: 'working' } });
  return { run, at };
}

for (const [locale, tx, expect] of [
  ['en', en => en, { read: 'Read the Overleaf project · 39 text files', note: '1 file(s) are empty or still loading',
    waiting: "Waiting for the model's first response…", fold: 'Setup 17800 · 58 files · Codex 0.159.0' }],
  ['zh', (_en, zh) => zh, { read: '已读取 Overleaf 项目 · 39 个文本文件', note: '1 个文件内容为空或尚未加载完',
    waiting: '等待模型首次响应…', fold: '启动 17800 · 58 个文件 · Codex 0.159.0' }]
]) {
  test('the start-up block narrates each step until the first response, then folds (' + locale + ')', () => {
    const { run, at } = setupRun();
    const h = harness(run, { tx });
    const setup = h.card.querySelector('.run-setup');
    const peek = h.card.querySelector('.run-peek');
    const peekLeads = () => peek.querySelectorAll('.run-peek-lead').map(node => node.textContent);
    // A live run starts collapsed: the peek shows the newest three start-up steps.
    assert.equal(peek.hidden, false);
    assert.equal(setup.hidden, true);
    assert.equal(peekLeads().length, 3);
    assert.equal(peekLeads().at(-1), expect.waiting);
    assert.equal(h.card.querySelector('.run-peek-more').hidden, false);
    // Expanding is a remembered choice, just like a real click on the run header.
    h.card.querySelector('[data-run-process-summary]').click();
    h.card.querySelector('[data-run-process]').open = true;
    h.update();
    const labels = () => setup.querySelectorAll('.run-setup-label').map(node => node.textContent);
    assert.equal(peek.hidden, true);
    assert.equal(setup.hidden, false);
    assert.equal(setup.dataset.folded, 'false');
    assert.equal(setup.open, true);
    assert.equal(labels().length, 5);
    assert.equal(labels()[1], expect.read);
    assert.equal(setup.querySelector('.run-setup-note').textContent, expect.note);
    assert.equal(labels().at(-1), expect.waiting);
    assert.equal(setup.querySelectorAll('.run-setup-step').at(-1).dataset.state, 'running');
    run.events.push({ kind: 'stream', streamRole: 'reasoning', streamKey: 'r', status: 'completed', title: 'Check first.', timestamp: at(46.9) });
    h.update();
    assert.equal(setup.dataset.folded, 'true');
    assert.equal(setup.open, false);
    assert.equal(setup.querySelector('.run-setup-fold').textContent, expect.fold);
    assert.ok(setup.querySelectorAll('.run-setup-step').every(row => row.dataset.state !== 'running'));
  });
}

test('an empty run shows a starting row at once, and Chinese-locale history titles classify too', () => {
  const run = makeRun([]);
  run.events = [];
  const h = harness(run, { tx: (_en, zh) => zh });
  assert.equal(h.card.querySelector('.run-peek-lead').textContent, '正在启动任务…');
  const Model = require(path.join(root, 'extension/src/shared/runActivityModel'));
  const zh = Model.project({ status: 'completed', events: [
    { kind: 'activity', title: '正在确认 Overleaf Editing 模式。', status: 'running', timestamp: '2026-10-01T00:00:00.000Z' },
    { kind: 'activity', title: '已读取 Overleaf 项目：39 个文本文件，19 个资源文件。', status: 'completed', timestamp: '2026-10-01T00:00:05.000Z' },
    { kind: 'activity', title: '已同步 58 个文本文件，本地 Codex 将直接处理这份 workspace。', status: 'completed', timestamp: '2026-10-01T00:00:06.000Z' }
  ] });
  assert.deepEqual(zh.setup.steps.map(step => [step.step, step.count ?? null]), [['editing', null], ['read', 39], ['workspace', 58]]);
});

test('the collapsed peek slides through thoughts and tool calls, never prose', () => {
  const { run, at } = setupRun();
  const h = harness(run);
  run.events.push(
    { kind: 'stream', streamRole: 'reasoning', streamKey: 'r1', status: 'completed', title: 'Check the decision rule first. Then more.', timestamp: at(46.9) },
    { title: 'Read', status: 'completed', timestamp: at(47.5), activity: { v: 1, kind: 'explore', scope: 's', id: 'e1', state: 'completed', action: 'read', paths: ['main.tex'], target: 'main.tex' } },
    { kind: 'stream', streamRole: 'assistant', streamKey: 'a1', status: 'completed', title: 'Now applying the edits.', timestamp: at(48) },
    { kind: 'stream', streamRole: 'reasoning', streamKey: 'r2', status: 'running', title: 'The regret equation appears twice; only the active copy should change.', timestamp: at(50) });
  h.update();
  const rows = h.card.querySelector('.run-peek').querySelectorAll('.run-peek-row');
  assert.deepEqual(rows.map(row => row.dataset.kind), ['thought', 'tool', 'thought']);
  assert.equal(rows[0].querySelector('.run-peek-label').textContent, 'Thought 29100');
  assert.equal(rows[0].querySelector('.run-peek-lead').textContent, 'Check the decision rule first.');
  assert.equal(rows[2].dataset.state, 'running');
  assert.ok(!h.card.querySelector('.run-peek').textContent.includes('Now applying'), 'prose stays out of the peek');
  assert.match(h.card.querySelector('.run-peek-more').textContent, /^1 earlier step/, 'the folded setup row was pushed out');
  run.status = 'completed';
  h.update();
  assert.equal(h.card.querySelector('.run-peek').hidden, true, 'finished runs drop the peek');
});

test('timer re-renders leave settled peek rows in place, so their slide-in never replays', () => {
  const { run } = setupRun();
  const h = harness(run);
  const track = h.card.querySelector('.run-peek-track');
  const moves = [];
  const insert = track.insertBefore.bind(track);
  track.insertBefore = (node, ref) => { moves.push(node); return insert(node, ref); };
  for (let tick = 0; tick < 3; tick += 1) h.update();
  assert.equal(moves.length, 0, 'an unchanged peek is not re-inserted on each tick');
  assert.ok(track.children.every(row => row.className === 'run-peek-row'), 'the entering class is dropped after the first render');
});

test('the peek window is only as tall as its rows, and fades its top edge only once rows scroll out', () => {
  const run = makeRun([]);
  run.events = [{ kind: 'activity', title: 'Checking Overleaf Editing mode before starting.', status: 'running', timestamp: new Date().toISOString() }];
  const h = harness(run);
  const peek = h.card.querySelector('.run-peek');
  assert.equal(peek.dataset.rows, '1');
  assert.equal(peek.dataset.overflow, 'false');
  const { run: full } = setupRun();
  const g = harness(full);
  assert.equal(g.card.querySelector('.run-peek').dataset.rows, '3');
  assert.equal(g.card.querySelector('.run-peek').dataset.overflow, 'true');
  const css = fs.readFileSync(path.join(root, 'extension/styles/panel.css'), 'utf8');
  assert.match(css, /\.run-peek\[data-rows="1"\] \{ height: 22px; \}/);
  assert.match(css, /\.run-peek\[data-overflow="true"\] \{ -webkit-mask-image/);
});
