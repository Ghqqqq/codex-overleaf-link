'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const Activity = require('../extension/src/shared/runActivityModel');
const Storage = require('../extension/src/shared/storageDb');
const Sessions = require('../extension/src/shared/sessionState');
const read = name => fs.readFileSync(path.join(__dirname, '../extension/src/content', name + '.js'), 'utf8');

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {};
    this.className = ''; this.listeners = new Map(); this._text = ''; this.open = false;
    this.classList = { add: (...names) => { this.className += ' ' + names.join(' '); } };
  }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value ?? ''); }
  set innerHTML(value) { this.textContent = value; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) {
    if (name.startsWith('data-')) return this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] ?? null;
    return this.attributes[name] ?? null;
  }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, reference) {
    if (node === reference) return node;
    node.remove(); const index = reference ? this.children.indexOf(reference) : this.children.length;
    if (index < 0) throw new Error('Reference is not a child');
    this.children.splice(index, 0, node); node.parentNode = this; return node;
  }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  before(node) { this.parentNode.insertBefore(node, this); }
  after(node) { this.parentNode.insertBefore(node, this.nextSibling); }
  replaceChildren(...nodes) { for (const node of [...this.children]) node.remove(); this._text = ''; this.append(...nodes); }
  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    const attr = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    return attr ? (attr[2] === undefined ? this.getAttribute(attr[1]) !== null : this.getAttribute(attr[1]) === attr[2]) : this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector) { return this.children.flatMap(child => (child.matches(selector) ? [child] : []).concat(child.querySelectorAll(selector))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); }
  dispatch(type) { for (const listener of this.listeners.get(type) || []) listener({ target: this }); }
}

function guidance(id, text = 'Read the methods', status = 'completed', timestamp = '2026-10-10T10:00:01.000Z') {
  return { kind: 'guidance', guidanceId: id, title: text, status, timestamp };
}
function harness(run, initialLocale = 'en', pending = []) {
  let locale = initialLocale;
  const document = { createElement: tag => new Element(tag) };
  const context = { window: { sessionStorage: { getItem: () => null, setItem() {} } }, document };
  for (const name of ['runGuidanceView', 'runActivitySummary']) vm.runInNewContext(read(name), context);
  const Guide = context.window.CodexOverleafRunGuidanceView;
  const tx = (en, zh) => locale === 'zh' ? zh : en;
  const root = document.createElement('section'); root.dataset.runId = run.id;
  const prompt = document.createElement('div'); prompt.textContent = 'Original task';
  const container = document.createElement('div'); container.dataset.runGuidance = '';
  const process = document.createElement('details'); process.dataset.runProcess = '';
  const summary = document.createElement('summary'); summary.dataset.runProcessSummary = '';
  const status = document.createElement('span'); status.dataset.runStatus = ''; summary.append(status); process.append(summary);
  const events = document.createElement('div'); events.dataset.runEvents = '';
  const report = document.createElement('div'); report.textContent = 'Final answer';
  root.append(prompt, container, process, events, report);
  const ui = context.window.CodexOverleafRunActivitySummary.create({
    RunActivityModel: Activity, RunGuidanceView: Guide, getPendingGuidance: () => pending, tx, findRunRecord: () => run,
    getPanel: () => root, cssEscape: String, isGuidance: event => Boolean(Guide.getGuidanceText(event)),
    formatElapsed: String, renderMarkdownBlockText: (node, value) => { node.textContent = value; },
    renderRunEvent: event => Guide.renderGuidanceMessage(event, Guide.getGuidanceText(event), tx)
  });
  const view = { root, recordId: run.id, status };
  ui.mount(root, run);
  return { Guide, tx, root, container, process, summary, events, report, ui, view, pending,
    update: event => ui.update(view, event), setLocale: value => { locale = value; } };
}
const rows = h => h.container.querySelectorAll('.run-guidance-message');
const rowTexts = h => rows(h).map(row => row.querySelector('.run-guidance-text').textContent);

test('live guidance stays above the runtime and never enters its collapsible activity rows', () => {
  const run = { id: 'run-1', status: 'running', events: [guidance('g1')] };
  const h = harness(run);
  assert.deepEqual(rowTexts(h), ['Read the methods']);
  assert.equal(h.events.querySelectorAll('[data-kind="guidance"]').length, 0);
  h.summary.dispatch('click'); h.process.open = true; h.process.dispatch('toggle');
  run.events.push(guidance('g2', 'Keep the references', 'completed', '2026-10-10T10:00:02.000Z'));
  h.update();
  assert.equal(h.process.open, true, 'a guidance render preserves the explicit runtime expansion');
  assert.deepEqual(rowTexts(h), ['Read the methods', 'Keep the references']);
  assert.equal(h.events.querySelectorAll('[data-kind="guidance"]').length, 0);
  for (const status of ['completed', 'cancelled']) {
    run.status = status; h.ui.settle(h.view, status);
    assert.equal(h.process.open, true);
    assert.deepEqual(rowTexts(h), ['Read the methods', 'Keep the references']);
  }
});

test('confirmed history uses the newest state per ID and preserves repeated actual sends', () => {
  const run = { id: 'run-1', status: 'completed', events: [
    guidance('g1', 'Read', 'queued'), guidance('g1', 'Read', 'completed'),
    guidance('g2', 'Read', 'completed', '2026-10-10T10:00:02.000Z')
  ] };
  const stored = Storage.buildSessionRecord({ id: 'session', projectId: 'project', runs: [run] });
  const restored = Sessions.normalizeRuns(JSON.parse(JSON.stringify(stored.runs)))[0];
  const h = harness(restored);
  assert.deepEqual(rowTexts(h), ['Read', 'Read']);
  assert.deepEqual(rows(h).map(row => row.dataset.status), ['completed', 'completed']);
  assert.doesNotMatch(h.container.textContent, /Sending|发送中/);
  assert.equal(h.events.querySelectorAll('[data-kind="guidance"]').length, 0);
});

test('pending guidance survives unrelated projection and merges confirmation without moving or duplicating', () => {
  const run = { id: 'run-1', status: 'running', events: [] };
  const h = harness(run, 'en', [{ ...guidance('g1', 'First', 'steering'), guidancePending: true }]);
  const pending = rows(h)[0];
  run.events.push(guidance('g2', 'Second', 'completed', '2026-10-10T10:00:02.000Z'));
  h.update();
  assert.deepEqual(rowTexts(h), ['First', 'Second']);
  assert.equal(rows(h)[0], pending);
  assert.match(pending.textContent, /Sending/);
  run.events.push(guidance('g1', 'First', 'completed'));
  h.update();
  assert.deepEqual(rowTexts(h), ['First', 'Second']);
  assert.equal(rows(h)[0], pending);
  assert.notEqual(pending.dataset.guidancePending, 'true');
  assert.doesNotMatch(pending.textContent, /Sending/);
});

test('pending projection rebuilds across locale or history redraw and disappears when delivery fails', () => {
  const run = { id: 'run-1', status: 'running', events: [] };
  const pending = [{ ...guidance('g1', 'Unchanged input', 'steering'), guidancePending: true }];
  const h = harness(run, 'en', pending);
  h.setLocale('zh'); h.update();
  assert.match(h.container.textContent, /补充指令.*发送中/s);
  assert.doesNotMatch(h.container.textContent, /Sending|Follow-up guidance/);
  const remounted = harness(run, 'zh', pending);
  assert.deepEqual(rowTexts(remounted), ['Unchanged input']);
  pending.splice(0); h.update(); remounted.update();
  assert.equal(rows(h).length, 0);
  assert.equal(rows(remounted).length, 0);
  assert.equal(run.events.length, 0, 'the preview itself does not become persisted guidance');
});

test('an unacknowledged preview still says Sending if its run finishes before the delivery receipt', () => {
  const run = { id: 'run-1', status: 'running', events: [] };
  const h = harness(run, 'en', [{ ...guidance('g1', 'In flight', 'steering'), guidancePending: true }]);
  run.status = 'completed'; h.ui.settle(h.view, 'Done');
  assert.match(h.container.textContent, /Sending/);
  h.setLocale('zh'); h.update();
  assert.match(h.container.textContent, /发送中/);
  run.events.push(guidance('g1', 'In flight', 'completed')); h.update();
  assert.doesNotMatch(h.container.textContent, /Sending|发送中/);
  assert.equal(rows(h).length, 1);
});

test('earlier send time survives old duplicate lifecycle records before the activity model coalesces them', () => {
  const run = { id: 'old-order', status: 'completed', events: [
    guidance('g1', 'First', 'queued', '2026-10-10T10:00:01.000Z'),
    guidance('g2', 'Second', 'completed', '2026-10-10T10:00:02.000Z'),
    guidance('g1', 'First', 'completed', '2026-10-10T10:00:03.000Z')
  ] };
  const h = harness(run);
  assert.deepEqual(rowTexts(h), ['First', 'Second']);
  assert.deepEqual(rows(h).map(row => row.dataset.status), ['completed', 'completed']);
});

test('guidance labels follow current locale while the original user text remains unchanged', () => {
  const run = { id: 'run-1', status: 'running', events: [guidance('g1', 'User text 用户原文', 'steering')] };
  const h = harness(run);
  assert.match(h.container.textContent, /Follow-up guidance.*Sending/s);
  assert.doesNotMatch(h.container.textContent, /补充指令|发送中/);
  h.setLocale('zh'); h.update();
  assert.match(h.container.textContent, /补充指令.*发送中/s);
  assert.doesNotMatch(h.container.textContent, /Follow-up guidance|Sending/);
  assert.equal(rowTexts(h)[0], 'User text 用户原文');
  run.events[0].status = 'completed'; h.update();
  assert.doesNotMatch(h.container.textContent, /发送中|已执行/);
});

test('legacy guidance is outside runtime and legacy queued duplicates do not survive completion', () => {
  const run = { id: 'legacy', status: 'completed', events: [
    guidance('', 'Legacy queued', 'queued'), guidance('', 'Legacy queued', 'completed'),
    { title: 'Follow-up guidance was delivered to the active Codex turn.', detail: 'Guidance delivered: Older user input', status: 'completed' }
  ] };
  const h = harness(run);
  assert.deepEqual(rowTexts(h), ['Legacy queued', 'Older user input']);
  assert.equal(h.events.querySelectorAll('[data-kind="guidance"]').length, 0);
  assert.doesNotMatch(h.container.textContent, /Sending/);
});

test('plain guidance renderer uses the same history reconciliation without the workflow presenter', () => {
  const run = { id: 'plain', status: 'completed', events: [] };
  const h = harness(run);
  h.Guide.reconcileGuidance(h.container, [guidance('g1', 'Read', 'queued'), guidance('g1', 'Read', 'completed')], h.tx, { active: false });
  assert.deepEqual(rowTexts(h), ['Read']);
  assert.equal(rows(h)[0].dataset.status, 'completed');
  assert.doesNotMatch(h.container.textContent, /Sending/);
});
