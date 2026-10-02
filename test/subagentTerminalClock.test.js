'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const root = process.env.CODEX_OVERLEAF_REPO || path.resolve(__dirname, '..');
const Agents = require(path.join(root, 'extension/src/shared/subagentActivityModel'));
const Activity = require(path.join(root, 'extension/src/shared/runActivityModel'));
const viewSource = fs.readFileSync(path.join(root, 'extension/src/content/subagentActivityView.js'), 'utf8');
const base = Date.parse('2026-10-02T00:00:00.000Z');
const at = seconds => new Date(base + seconds * 1000).toISOString();
const child = (overrides = {}) => ({ source: 'codex', key: 'codex:child', threadId: 'child', title: 'Child',
  status: 'running', startedAt: at(0), updatedAt: at(12), events: [], ...overrides });
const parent = (subagents = [child()], overrides = {}) => ({ id: 'parent', status: 'running',
  startedAt: at(-5), events: [], subagents, ...overrides });

class Element {
  constructor(tag, className = '') {
    this.tagName = tag; this.className = className; this.children = []; this.parentNode = null;
    this.dataset = {}; this.listeners = new Map(); this.attributes = {}; this.textContent = '';
    this.inert = false; this.scrollTop = 0; this.scrollHeight = 100; this.clientHeight = 100;
  }
  get isConnected() { return this.tagName === 'body' || Boolean(this.parentNode?.isConnected); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
  before(node) {
    node.remove(); node.parentNode = this.parentNode;
    this.parentNode.children.splice(this.parentNode.children.indexOf(this), 0, node);
  }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  replaceChildren(...nodes) { for (const node of [...this.children]) node.remove(); this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  click() { this.listeners.get('click')?.(); }
  focus() {}
  querySelector(selector) {
    for (const node of this.children) {
      if (selector === '[data-log]' ? node.dataset.log !== undefined : node.className.split(' ').includes(selector.slice(1))) return node;
      const found = node.querySelector(selector); if (found) return found;
    }
    return null;
  }
}

function harness(run, seconds = 100) {
  let now = base + seconds * 1000, api;
  const make = (tag, className) => new Element(tag, className);
  const body = make('body'), panel = make('aside'), events = make('div'), log = make('div');
  log.dataset.log = ''; body.append(panel); panel.append(log); log.append(events);
  vm.runInNewContext(viewSource, { Date: class extends Date { static now() { return now; } },
    console: { warn(...args) { assert.fail(args.join(' ')); } },
    CodexOverleafModuleRegistry: { define(name, dependencies, factory) { api = factory(Agents, Activity); } } });
  const ui = api.create({ tx: en => en, getPanel: () => panel, plain: value => String(value || ''),
    make, icon: () => make('span'), formatElapsed: String, renderBlocks() {} });
  const card = { id: run.id, run, events };
  ui.update(card);
  return { card, panel, update: () => ui.update(card), tick(value) { now = base + value * 1000; ui.update(card); },
    row: key => card.subagentGroup.cache.get(key || run.subagents[0].key),
    open(key) { card.subagentGroup.cache.get(key || run.subagents[0].key).el.click(); },
    meta: () => panel.querySelector('.codex-subagent-meta').textContent };
}

function observe(run, type, seconds, detail = {}) {
  Agents.ingest(run, { type: 'codex.subagent.' + type, ...(seconds === undefined ? {} : { timestamp: at(seconds) }),
    detail: { source: 'codex', threadId: 'child', ...detail } });
  return run.subagents[0];
}
function turn(run, method, seconds, status) {
  return observe(run, 'event', seconds, { event: { type: 'codex.event',
    detail: { method, params: { threadId: 'child', turn: { status } } } } });
}

test('cancelled parent freezes both missing-finish child rows and the detail clock at 44s/34s', () => {
  const first = child(), second = child({ key: 'codex:second', threadId: 'second', startedAt: at(10) });
  const run = parent([first, second]);
  const h = harness(run, 44);
  h.open();
  run.status = 'cancelled'; run.finishedAt = at(44);
  for (const now of [44, 196, 316]) {
    h.tick(now);
    assert.equal(h.row(first.key).time.textContent, '44000');
    assert.equal(h.row(second.key).time.textContent, '34000');
    assert.equal(h.row(first.key).status.textContent, 'Stopped');
    assert.equal(h.meta(), 'Stopped \u00b7 44000');
  }
  h.open(second.key);
  assert.equal(h.meta(), 'Stopped \u00b7 34000');
  assert.equal(first.status, 'running', 'projection must not invent a child terminal result');
});

for (const status of ['rejected', 'completed', 'failed', 'interrupted']) {
  test(`${status} parent freezes the clock without inventing child completion`, () => {
    const agent = child(), run = parent([agent], { status, finishedAt: at(44) });
    const h = harness(run); h.open(); h.tick(316);
    const label = status === 'rejected' ? 'Stopped' : 'Status unconfirmed';
    assert.equal(h.row().time.textContent, '44000');
    assert.equal(h.meta(), label + ' \u00b7 44000');
    assert.equal(agent.status, 'running');
  });
}

test('missing or invalid terminal dates use the last valid evidence, never advancing wall time', () => {
  for (const invalid of ['', 'not-a-date']) {
    const agent = child({ finishedAt: invalid, updatedAt: invalid,
      events: [{ title: 'Last child evidence', status: 'running', timestamp: at(18) },
        { title: 'Invalid timestamp', timestamp: 'invalid' }] });
    const run = parent([agent], { status: 'cancelled', finishedAt: invalid,
      events: [{ title: 'Last parent evidence', timestamp: at(22) }] });
    const h = harness(run); h.open(); h.tick(316);
    assert.equal(h.row().time.textContent, '22000');
    assert.equal(h.meta(), 'Stopped \u00b7 22000');
  }
});

test('missing or invalid starts hide elapsed time and absent evidence yields a fixed zero', () => {
  for (const startedAt of ['', 'invalid']) {
    const h = harness(parent([child({ startedAt })], { status: 'cancelled' }));
    h.open(); h.tick(316);
    assert.equal(h.row().time.textContent, '');
    assert.equal(h.meta(), 'Stopped');
  }
  const run = parent([child({ updatedAt: '' })], { status: 'cancelled', startedAt: '' });
  const h = harness(run); h.open(); h.tick(316);
  assert.equal(h.meta(), 'Stopped \u00b7 0');
  run.finishedAt = at(-1); h.update();
  assert.equal(h.row().time.textContent, '0', 'clock skew must not produce a negative duration');
});

test('a child completed before its parent keeps its own terminal clock in both surfaces', () => {
  const agent = child({ status: 'completed', finishedAt: at(12) });
  const run = parent([agent], { status: 'cancelled', finishedAt: at(44) });
  const h = harness(run); h.open(); h.tick(316);
  assert.equal(h.row().time.textContent, '12000');
  assert.equal(h.meta(), 'Completed \u00b7 12000');
});

test('genuinely active children advance even if a historical finish remains in a live record', () => {
  for (const status of ['running', 'pending']) {
    const h = harness(parent([child({ status, finishedAt: at(12) })]), 20);
    h.open();
    assert.equal(h.row().time.textContent, '20000');
    h.tick(30);
    assert.equal(h.row().time.textContent, '30000');
    assert.equal(h.meta(), (status === 'running' ? 'Running' : 'Starting') + ' \u00b7 30000');
  }
});

test('unknown children remain unconfirmed and do not borrow a running parent clock', () => {
  const agent = child({ status: 'unknown' });
  const run = parent([agent], { updatedAt: at(50), finishedAt: at(60), events: [{ title: 'Parent working', timestamp: at(70) }] });
  const h = harness(run); h.open(); h.tick(316);
  assert.equal(h.meta(), 'Status unconfirmed \u00b7 12000');
  assert.equal(agent.status, 'unknown');
});

for (const status of ['completed', 'failed', 'cancelled']) {
  test(`${status} terminal time survives later observations, final answers and stale replays`, () => {
    const run = parent();
    const agent = observe(run, status === 'completed' ? 'completed' : 'failed', 20, { status });
    const h = harness(run, 30); h.open();
    for (const seconds of [50, 60, 19]) {
      observe(run, 'observed', seconds, { status, summary: 'Final answer' });
      h.tick(seconds + 300);
      assert.equal(agent.finishedAt, at(20));
      assert.equal(h.row().time.textContent, '20000');
      assert.ok(h.meta().endsWith(' \u00b7 20000'));
    }
    observe(run, 'observed', 70, { status: 'running' });
    observe(run, 'started', 80);
    assert.equal(agent.status, status, 'snapshots and broker starts do not reopen terminal children');
    assert.equal(agent.finishedAt, at(20));
    const restored = Agents.normalize(JSON.parse(JSON.stringify(run.subagents)))[0];
    assert.equal(Agents.elapsedMs(restored, run, base + 999000), 20000);
  });
}

test('first terminal event with missing or invalid time latches prior evidence instead of receipt time', () => {
  for (const timestamp of [undefined, 'invalid']) {
    const run = parent(), agent = run.subagents[0];
    Agents.ingest(run, { type: 'codex.subagent.completed', timestamp,
      detail: { source: 'codex', threadId: 'child' } });
    assert.equal(agent.finishedAt, at(12));
    observe(run, 'observed', 50, { status: 'completed' });
    assert.equal(agent.finishedAt, at(12));
  }
});

test('legacy terminal records without valid finish latch pre-observation evidence', () => {
  for (const finishedAt of ['', 'invalid']) {
    const agent = child({ status: 'completed', finishedAt });
    const run = parent([agent]);
    observe(run, 'observed', 50, { status: 'completed' });
    observe(run, 'observed', 60, { status: 'completed' });
    assert.equal(agent.finishedAt, at(12));
  }
});

test('late observations on a cancelled parent preserve the evidence cutoff without fabricating success', () => {
  const run = parent(undefined, { status: 'cancelled' }), agent = run.subagents[0];
  const h = harness(run); h.open();
  for (const seconds of [50, 60]) {
    observe(run, 'observed', seconds, { status: 'running' });
    h.tick(seconds + 300);
    assert.equal(h.meta(), 'Stopped \u00b7 12000');
    assert.equal(agent.status, 'running');
  }
});

test('an explicit child turn reopens its clock, and stale prior-turn completion cannot close it', () => {
  const run = parent(), agent = observe(run, 'completed', 20);
  observe(run, 'observed', 70, { status: 'completed', summary: 'Repeated final' });
  turn(run, 'turn/started', 30);
  assert.equal(agent.status, 'running');
  assert.equal(agent.startedAt, at(30));
  assert.equal(agent.finishedAt, '');
  const h = harness(run, 35); h.open();
  assert.equal(h.meta(), 'Running \u00b7 5000');
  h.tick(45);
  assert.equal(h.row().time.textContent, '15000');
  turn(run, 'turn/completed', 20, 'completed');
  observe(run, 'observed', 25, { status: 'completed' });
  assert.equal(agent.status, 'running');
  assert.equal(agent.finishedAt, '');
  turn(run, 'turn/completed', 50, 'completed');
  observe(run, 'observed', 60, { status: 'completed' });
  h.tick(316);
  assert.equal(agent.finishedAt, at(50));
  assert.equal(h.meta(), 'Completed \u00b7 20000');
});

test('a new child turn in the same millisecond reopens a cancelled clock and advances both surfaces', () => {
  const run = parent();
  observe(run, 'event', 20, { sequence: 1, event: { type: 'codex.session.event',
    detail: { method: 'turn/completed', params: { threadId: 'child',
      turn: { id: 'old-child-turn', status: 'interrupted' } } } } });
  const agent = run.subagents[0], h = harness(run, 20);
  h.open();
  assert.equal(agent.status, 'cancelled');
  assert.equal(agent.finishedAt, at(20));
  assert.equal(h.meta(), 'Stopped \u00b7 20000');
  observe(run, 'event', 20, { sequence: 2, event: { type: 'codex.session.event',
    detail: { method: 'turn/started', params: { threadId: 'child',
      turn: { id: 'new-child-turn', status: 'inProgress' } } } } });
  h.update();
  assert.equal(agent.status, 'running');
  assert.equal(agent.startedAt, at(20));
  assert.equal(agent.finishedAt, '');
  assert.equal(h.row().time.textContent, '0');
  assert.equal(h.meta(), 'Running \u00b7 0');
  h.tick(25);
  assert.equal(h.row().time.textContent, '5000');
  assert.equal(h.meta(), 'Running \u00b7 5000');
});

test('an explicit child turn without a timestamp still reopens the terminal lifecycle', () => {
  const run = parent(), agent = observe(run, 'completed', 20);
  turn(run, 'turn/started');
  assert.equal(agent.status, 'running');
  assert.equal(agent.finishedAt, '');
  assert.ok(Number.isFinite(Date.parse(agent.startedAt)));
  const h = harness(run); h.open();
  const start = (Date.parse(agent.startedAt) - base) / 1000;
  h.tick(start + 5);
  assert.equal(h.row().time.textContent, '5000');
  assert.equal(h.meta(), 'Running \u00b7 5000');
});
