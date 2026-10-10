'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ScrollLayout = require('../extension/src/content/runScrollLayout');

function harness({ rowTop = 600, rowHeight = 40, headerBottom = 700, total = 1400, open = true } = {}) {
  const listeners = {}, frames = [], buttonListeners = {};
  let resize, position = total - 400, offset = 0;
  const process = { open };
  const button = { isConnected: true, hidden: true, setAttribute() {},
    addEventListener(type, listener) { buttonListeners[type] = listener; } };
  const host = { append() {} };
  const scroller = { dataset: {}, children: [], clientHeight: 400, scrollHeight: total,
    get scrollTop() { return position; }, set scrollTop(value) { position = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
    getBoundingClientRect: () => ({ top: 100, bottom: 500, height: 400 }),
    contains: node => node === row || node === text,
    closest: () => host, querySelectorAll: selector => selector === '[data-run-id]' ? [card] : [text],
    addEventListener(type, listener) { listeners[type] = listener; } };
  const rect = (start, height) => ({ top: 100 + start + offset - position, bottom: 100 + start + offset - position + height, height });
  const summary = { getBoundingClientRect: () => rect(headerBottom - 24, 24) };
  const card = { dataset: { runId: 'guidance-run' },
    querySelector: selector => selector === '[data-run-process-summary]' ? summary : process,
    querySelectorAll: () => [text] };
  const row = { getBoundingClientRect: () => rect(rowTop, rowHeight), closest: () => card };
  const text = { getBoundingClientRect: () => rect(rowTop, rowHeight), closest: () => card };
  const browserWindow = {
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    ResizeObserver: class { constructor(callback) { resize = callback; } observe() {} disconnect() {} }
  };
  const context = { window: browserWindow, document: { createElement: () => button } };
  for (const name of ['moduleRegistryKernel', 'runRecoveryActions', 'runTimelineView']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/src/content', name + '.js'), 'utf8'), context);
  }
  const api = browserWindow.CodexOverleafRunTimelineView.create({
    getPanel: () => ({ querySelector: () => scroller }), tx: en => en,
    RunScrollLayout: { create: options => ScrollLayout.create({ ...options, window: browserWindow }) }
  });
  api.bindLogAutoFollow();
  return { api, row, text, scroller, process, button,
    paint() { while (frames.length) frames.shift()(); },
    resize(delta = 0) { offset += delta; scroller.scrollHeight += delta; resize(); },
    detach() { listeners.wheel({ type: 'wheel', deltaY: -100 }); scroller.scrollTop = 200; listeners.scroll(); },
    jump() { buttonListeners.click({ stopPropagation() {} }); } };
}

test('revealing guidance above a long expanded runtime persists across auto-follow and resize', () => {
  const h = harness();
  h.api.revealGuidance(h.row); h.paint();
  const top = h.row.getBoundingClientRect().top;
  assert.ok(top >= 100 && top < 200, 'the new input is brought into the panel viewport');
  assert.equal(h.process.open, true, 'revealing input does not collapse runtime');
  assert.equal(h.scroller.dataset.logAutoFollow, 'false');
  const position = h.scroller.scrollTop;
  h.api.scrollLogToBottom(); h.paint();
  assert.equal(h.scroller.scrollTop, position, 'the next activity repaint does not hide the new input');
  h.resize(80); h.paint();
  assert.equal(h.row.getBoundingClientRect().top, top, 'layout changes retain the guidance text anchor');
  assert.equal(h.button.hidden, false, 'the existing latest action is available');
  h.jump(); h.paint();
  assert.equal(h.scroller.scrollTop, h.scroller.scrollHeight - h.scroller.clientHeight);
  assert.equal(h.scroller.dataset.logAutoFollow, 'true');
});

test('collapsed runtime with room for guidance and its header keeps following the bottom', () => {
  const h = harness({ rowTop: 980, headerBottom: 1080, total: 1100, open: false });
  h.api.revealGuidance(h.row); h.paint();
  assert.equal(h.scroller.scrollTop, 700);
  assert.equal(h.scroller.dataset.logAutoFollow, 'true');
  assert.equal(h.process.open, false);
  h.scroller.scrollHeight += 20; h.api.scrollLogToBottom(); h.paint();
  assert.equal(h.scroller.scrollTop, 720);
});

test('reading history before reveal or before its queued frame wins without any forced scroll', () => {
  for (const before of [true, false]) {
    const h = harness();
    if (before) h.detach();
    h.api.revealGuidance(h.row);
    if (!before) h.detach();
    h.paint();
    assert.equal(h.scroller.scrollTop, 200);
    assert.equal(h.scroller.dataset.logAutoFollow, 'false');
    assert.equal(h.process.open, true);
  }
});

test('a queued ordinary follow cannot override reveal and a forced latest jump cancels it', () => {
  const h = harness();
  h.api.scrollLogToBottom(); h.api.revealGuidance(h.row); h.paint();
  assert.ok(h.row.getBoundingClientRect().top >= 100);
  const forced = harness();
  forced.api.revealGuidance(forced.row); forced.api.scrollLogToBottom({ force: true }); forced.paint();
  assert.equal(forced.scroller.scrollTop, 1000);
  assert.equal(forced.scroller.dataset.logAutoFollow, 'true');
});

test('an oversized guidance bubble reveals its beginning without scrolling the surrounding page', () => {
  const h = harness({ rowTop: 300, rowHeight: 650, headerBottom: 1000, total: 1800 });
  h.row.scrollIntoView = () => { throw new Error('global scrolling is not allowed'); };
  h.api.revealGuidance(h.row); h.paint();
  assert.ok(h.row.getBoundingClientRect().top >= 100 && h.row.getBoundingClientRect().top < 120);
  assert.equal(h.process.open, true);
});
