'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Minimal DOM: enough for buttons, text, attributes and click/input events.
class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {};
    this.listeners = {}; this.className = ''; this._text = ''; this.hidden = false; this.disabled = false; this.value = ''; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.children = []; this._text = String(value ?? ''); }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren() { this.children = []; this._text = ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatchEvent(event) { for (const fn of this.listeners[event.type] || []) fn(event); }
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
  focus() { this.focused = true; }
  setSelectionRange() {}
  all(predicate) { return this.children.flatMap(child => [...(predicate(child) ? [child] : []), ...child.all(predicate)]); }
  find(className) { return this.all(node => node.className.split(/\s+/).includes(className))[0] || null; }
  querySelector(selector) { return selector === '[data-task]' ? this.all(node => node.dataset.task !== undefined)[0] || null : null; }
}
global.document = { createElement: tag => new Node(tag), createElementNS: (_ns, tag) => new Node(tag) };
global.Event = class { constructor(type) { this.type = type; } };

const View = require('../extension/src/content/pendingInputView');
const strings = { queuedInputUpNext: 'Up next · sends after this run', queuedInputUpNextMany: 'Up next · sends in order after this run',
  queuedInputMore: '{count} more queued', queuedInputGuide: 'Steer now', queuedInputPaused: 'Queue paused', queuedInputResume: 'Resume',
  queuedInputSteering: 'Steering the current turn…', queuedInputGuideHint: 'Steer is available once the current tool step finishes.',
  queuedInputEditBlocked: 'Send or clear the current draft first.' };
const tr = (key, params = {}) => (strings[key] || '').replace(/\{(\w+)\}/g, (_, name) => params[name]);

function mount() {
  const parent = new Node('div'), container = new Node('div'), task = new Node('textarea');
  task.dataset.task = '';
  parent.append(container, task);
  const calls = { guide: [], remove: [], resume: 0, toast: [] };
  const view = View.create({ container, tr, onGuide: id => calls.guide.push(id), onRemove: id => calls.remove.push(id),
    onResume: () => { calls.resume += 1; }, onToast: message => calls.toast.push(message) });
  return { view, container, task, calls };
}
const items = [{ id: 'a', text: 'Also fix the caption', status: 'queued' }, { id: 'b', text: 'Then compile', status: 'queued' },
  { id: 'c', text: 'List overfull hboxes', status: 'queued' }];

test('the docked card says what happens next and shows only the first message', () => {
  const h = mount();
  h.view.render(items, { running: true, canGuide: true });
  assert.equal(h.container.dataset.state, 'queued');
  assert.equal(h.container.find('codex-pending-head-label').textContent, 'Up next · sends in order after this run');
  assert.equal(h.container.find('codex-pending-count').textContent, '3');
  assert.equal(h.container.all(node => node.className === 'codex-pending-input').length, 1);
  const more = h.container.find('codex-pending-more');
  assert.equal(more.textContent, '2 more queued');
  more.click();
  assert.equal(h.container.all(node => node.className === 'codex-pending-input').length, 3);
});

test('Steer now is a labelled action on the first item; disabled with a reason before the turn is ready', () => {
  const h = mount();
  h.view.render(items.slice(0, 1), { running: true, canGuide: false });
  const steer = h.container.find('codex-pending-steer');
  assert.match(steer.textContent, /Steer now/);
  assert.equal(steer.disabled, true);
  assert.match(h.container.find('codex-pending-hint').textContent, /tool step finishes/);
  h.view.render(items.slice(0, 1), { running: true, canGuide: true });
  h.container.find('codex-pending-steer').click();
  assert.deepEqual(h.calls.guide, ['a']);
});

test('paused and steering states change the header, and pause offers Resume', () => {
  const h = mount();
  h.view.render([{ ...items[0], status: 'paused' }], { running: true, canGuide: true });
  assert.equal(h.container.dataset.state, 'paused');
  assert.equal(h.container.find('codex-pending-steer'), null);
  h.container.find('codex-pending-resume').click();
  assert.equal(h.calls.resume, 1);
  h.view.render([{ ...items[0], status: 'steering' }], { running: true, canGuide: true });
  assert.equal(h.container.find('codex-pending-head-label').textContent, 'Steering the current turn…');
  assert.equal(h.container.find('codex-pending-input-remove').disabled, true);
});

test('clicking the text pulls it back into an empty composer, but never overwrites a draft', () => {
  const h = mount();
  h.view.render(items.slice(0, 1), { running: true, canGuide: true });
  h.task.value = 'my draft';
  h.container.find('codex-pending-input-text').click();
  assert.equal(h.task.value, 'my draft');
  assert.deepEqual(h.calls.remove, []);
  assert.equal(h.calls.toast.length, 1);
  h.task.value = '';
  h.container.find('codex-pending-input-text').click();
  assert.equal(h.task.value, 'Also fix the caption');
  assert.deepEqual(h.calls.remove, ['a']);
  assert.equal(h.task.focused, true);
});

test('the card docks onto the composer border', () => {
  const css = fs.readFileSync(path.join(__dirname, '../extension/styles/panel.css'), 'utf8');
  assert.match(css, /\.codex-pending-inputs:not\(\[hidden\]\) \+ \.codex-composer \{ margin-top: 0; border-top-left-radius: 0;/);
});
