'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { extractFunction } = require('./_helpers/extractFunction');

const runtime = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
const composerSource = fs.readFileSync(path.join(__dirname, '../extension/src/content/composerPanel.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../extension/styles/panel.css'), 'utf8');

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    emit(type, event = {}) { for (const listener of listeners.get(type) || []) listener(event); },
    listenerCount() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); }
  };
}

function element(tag = 'div') {
  let text = '';
  const properties = new Map();
  const node = Object.assign(eventTarget(), {
    tagName: tag.toUpperCase(), children: [], dataset: {}, hidden: false,
    style: { setProperty(name, value) { properties.set(name, value); }, getPropertyValue(name) { return properties.get(name); } },
    append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } },
    setAttribute(name, value) { this[name] = value; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    focus() {}, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    scrollIntoView() { assert.fail('menu navigation must not scroll document ancestors'); }
  });
  Object.defineProperty(node, 'textContent', {
    get() { return text; },
    set(value) { text = value; this.children = []; }
  });
  return node;
}

// Geometry is explicit test data. These Node checks execute production menu
// functions and the whole ComposerPanel module, but do not simulate CSS layout,
// trusted wheel input, or actual browser scroll chaining; those need browser QA.
function harness({ count = 58, composerTop = 500, panelTop = 0, viewportTop = 0, clientHeight = 180 } = {}) {
  const geometry = { composerTop, panelTop, viewportTop, clientHeight };
  const root = Object.assign(eventTarget(), { visualViewport: eventTarget() });
  Object.defineProperty(root.visualViewport, 'offsetTop', { get: () => geometry.viewportTop });
  const menu = element(), form = element('form'), input = element('textarea'), run = element('button');
  menu.clientTop = 1;
  Object.defineProperty(menu, 'clientHeight', { get: () => geometry.clientHeight });
  let scroll = 0;
  Object.defineProperty(menu, 'scrollTop', {
    get: () => scroll,
    set: value => { scroll = Math.max(0, Math.min(value, Math.max(0, menu.scrollHeight - geometry.clientHeight))); }
  });
  Object.defineProperty(menu, 'scrollHeight', { get: () => 10 + menu.children.reduce((sum, node) => sum + (node.rowHeight || 52) + 2, 0) });
  menu.querySelectorAll = selector => selector === '[data-slash-command]' ? menu.children.filter(node => node.dataset.slashCommand) : [];
  menu.getBoundingClientRect = () => ({ top: 100, bottom: 102 + geometry.clientHeight, height: 2 + geometry.clientHeight });
  form.getBoundingClientRect = () => ({ top: geometry.composerTop });
  let submitted = 0;
  form.requestSubmit = () => { submitted++; };
  input.value = '/'; input.selectionStart = 1;
  const controls = new Map([['[data-slash-menu]', menu], ['[data-composer-form]', form], ['[data-task]', input], ['[data-run]', run]]);
  const panel = { querySelector: selector => controls.get(selector) || null, getBoundingClientRect: () => ({ top: geometry.panelTop }) };
  const background = { chat: 143, page: 27 };
  for (const key of ['chat', 'page']) {
    const value = background[key];
    Object.defineProperty(background, key, { get: () => value, set() { assert.fail('background scroll must stay unchanged'); } });
  }
  const document = {
    defaultView: root,
    createElement(tag) {
      const node = element(tag);
      node.getBoundingClientRect = () => {
        const index = menu.children.indexOf(node);
        const preceding = menu.children.slice(0, index).reduce((sum, row) => sum + (row.rowHeight || 52) + 2, 0);
        const top = 100 + menu.clientTop + 5 + preceding - menu.scrollTop;
        return { top, bottom: top + (node.rowHeight || 52), height: node.rowHeight || 52 };
      };
      return node;
    }
  };
  const commands = Array.from({ length: count }, (_, index) => ({
    id: `local-skill:${index}`, kind: 'codex-local-skill', skillId: `local-${index}`, scope: 'codex-local',
    title: index === count - 1 ? '末项 / A long local skill title' : `Skill ${String(index).padStart(2, '0')}`,
    subtitle: 'Local Codex · Use for this turn · long-plugin-source'
  }));
  const selected = [], focusFiles = [], files = Array.from({ length: 12 }, (_, i) => ({ path: `chapter${i}.tex`, selectable: true }));
  const context = {
    root, window: root, document, panel, renderedSlashCommands: new Map(), currentRunView: null, state: {},
    getSlashCommands: () => commands, tr: key => key, tx: en => en,
    activateSkillInstallerComposerContext: () => selected.push('installer'),
    activateCodexOverleafSkillComposerContext: command => selected.push(command.id),
    autosizeTaskTextarea() {}, syncComposerSendAvailability() {}, saveStateSoon() {}, appendPlainLog() {},
    ensureContextFilesForAtMenu() {},
    contextTrayController: {
      getContextProject: () => ({ files }), getContextProjectFiles: source => source,
      getContextFileRank: () => 0, getActiveFocusFiles: () => focusFiles,
      selectFocusFile: file => { focusFiles.push(file); }
    }
  };
  vm.createContext(context);
  for (const name of ['renderSlashMenu', 'updateSlashMenuLayout', 'setSlashMenuActiveIndex', 'handleSlashMenuKeydown',
    'closeSlashMenu', 'handleTaskInputKeydown', 'selectSlashCommand', 'clearSlashTriggerFromTaskInput',
    'getSlashTrigger', 'getAtFileTrigger', 'updateSlashMenuForTaskInput', 'renderAtFileMenu', 'applyAtFileSelection']) {
    vm.runInContext(extractFunction(runtime, name), context, { filename: `contentRuntime.js:${name}` });
  }
  function key(key, extra = {}) {
    const event = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    context.handleTaskInputKeydown(event);
    return event;
  }
  function activeVisible() {
    const row = menu.children[Number(menu.dataset.activeIndex)].getBoundingClientRect();
    const top = menu.getBoundingClientRect().top + menu.clientTop;
    return row.top >= top && row.bottom <= top + menu.clientHeight;
  }
  return { context, geometry, root, document, controls, menu, form, input, commands, selected, focusFiles, files,
    background, key, activeVisible, submitted: () => submitted };
}

test('shared menu limits its own scroll box and preserves readable long labels', () => {
  const menuRule = css.match(/#codex-overleaf-panel \.codex-slash-menu\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(menuRule, /box-sizing:\s*border-box/);
  assert.match(menuRule, /max-height:\s*min\(360px,\s*var\(--codex-slash-menu-space,\s*50vh\)\)/);
  assert.match(menuRule, /overflow-y:\s*auto/);
  assert.match(menuRule, /overscroll-behavior:\s*contain/);
  assert.match(menuRule, /grid-auto-rows:\s*max-content/);
  const rowRule = css.match(/#codex-overleaf-panel \.codex-slash-menu button\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(rowRule, /overflow-wrap:\s*anywhere/);
  assert.match(rowRule, /min-width:\s*0/);
});

test('available height follows the actual composer and visible viewport without negative heights', () => {
  const h = harness();
  h.context.renderSlashMenu(h.commands);
  assert.equal(h.menu.style.getPropertyValue('--codex-slash-menu-space'), '488px');
  h.geometry.composerTop = 204.8; h.geometry.panelTop = 34; h.geometry.viewportTop = 54;
  h.context.updateSlashMenuLayout();
  assert.equal(h.menu.style.getPropertyValue('--codex-slash-menu-space'), '138px');
  h.geometry.panelTop = 74;
  h.context.updateSlashMenuLayout();
  assert.equal(h.menu.style.getPropertyValue('--codex-slash-menu-space'), '118px');
  h.geometry.composerTop = 20;
  h.context.updateSlashMenuLayout();
  assert.equal(h.menu.style.getPropertyValue('--codex-slash-menu-space'), '0px');
});

test('hidden or missing menu does not measure or change layout', () => {
  const h = harness(); h.menu.hidden = true;
  h.form.getBoundingClientRect = () => assert.fail('closed menus do not require geometry');
  h.context.updateSlashMenuLayout();
  assert.equal(h.menu.style.getPropertyValue('--codex-slash-menu-space'), undefined);
  h.controls.delete('[data-slash-menu]'); h.context.updateSlashMenuLayout();
  h.context.panel = null; h.context.updateSlashMenuLayout();
});

test('all 58 commands remain selectable and keyboard wraps while revealing the active row', () => {
  const h = harness(); h.context.renderSlashMenu(h.commands);
  assert.equal(h.menu.children.length, 58);
  assert.equal(h.context.renderedSlashCommands.size, 58);
  h.key('ArrowUp');
  assert.equal(h.menu.dataset.activeIndex, '57'); assert.equal(h.activeVisible(), true);
  assert.ok(h.menu.scrollTop > 2500);
  h.key('ArrowDown');
  assert.equal(h.menu.dataset.activeIndex, '0'); assert.equal(h.activeVisible(), true);
  for (let i = 1; i < 58; i++) {
    assert.equal(h.key('ArrowDown').defaultPrevented, true);
    assert.equal(h.menu.dataset.activeIndex, String(i)); assert.equal(h.activeVisible(), true);
  }
  assert.equal(h.background.chat, 143); assert.equal(h.background.page, 27);
  h.key('Enter');
  assert.deepEqual(h.selected, ['local-skill:57']); assert.equal(h.menu.hidden, true);
  assert.equal(h.submitted(), 0, 'selecting a skill does not submit a model task');
});

test('already visible rows do not move the scroll offset and oversized rows reveal their start', () => {
  const h = harness(); h.context.renderSlashMenu(h.commands);
  h.context.setSlashMenuActiveIndex(1); assert.equal(h.menu.scrollTop, 0);
  h.menu.children[2].rowHeight = 250;
  h.context.setSlashMenuActiveIndex(2);
  const row = h.menu.children[2].getBoundingClientRect();
  assert.equal(row.top, h.menu.getBoundingClientRect().top + h.menu.clientTop);
  h.geometry.clientHeight = 0;
  const previous = h.menu.scrollTop; h.context.setSlashMenuActiveIndex(3);
  assert.equal(h.menu.scrollTop, previous);
});

test('filtering and reopening reset the viewport together with the first active command', () => {
  const h = harness(); h.context.renderSlashMenu(h.commands); h.key('ArrowUp');
  assert.ok(h.menu.scrollTop > 0);
  h.context.renderSlashMenu(h.commands.slice(0, 3));
  assert.equal(h.menu.scrollTop, 0); assert.equal(h.menu.dataset.activeIndex, '0');
  assert.equal(h.menu.children[0].dataset.active, 'true');
  h.context.closeSlashMenu(); h.context.renderSlashMenu(h.commands);
  assert.equal(h.menu.scrollTop, 0); assert.equal(h.menu.children.length, 58);
  h.context.renderSlashMenu([]); assert.equal(h.menu.hidden, true);
});

test('resize preserves a pointer-chosen scroll position and the next arrow reveals its selection', () => {
  const h = harness(); h.context.renderSlashMenu(h.commands);
  h.menu.scrollTop = 1200;
  h.geometry.composerTop = 150; h.geometry.clientHeight = 90;
  h.context.updateSlashMenuLayout();
  assert.equal(h.menu.scrollTop, 1200, 'layout does not snap a reader back to the unchanged keyboard selection');
  h.key('ArrowDown');
  assert.equal(h.menu.dataset.activeIndex, '1'); assert.equal(h.activeVisible(), true);
});

test('Escape dismisses, IME Enter remains untouched, and ordinary menu-free Enter submits', () => {
  const h = harness(); h.context.renderSlashMenu(h.commands);
  assert.equal(h.key('Enter', { isComposing: true }).defaultPrevented, false);
  assert.equal(h.key('Enter', { keyCode: 229 }).defaultPrevented, false);
  assert.deepEqual(h.selected, []); assert.equal(h.submitted(), 0); assert.equal(h.menu.hidden, false);
  assert.equal(h.key('Escape').defaultPrevented, true); assert.equal(h.menu.hidden, true);
  assert.equal(h.input.value, '/');
  assert.equal(h.key('Enter', { shiftKey: true }).defaultPrevented, false);
  assert.equal(h.key('Enter').defaultPrevented, true); assert.equal(h.submitted(), 1);
});

test('the @ picker uses the same scroll/navigation path and preserves its file-selection semantics', () => {
  const h = harness({ clientHeight: 100 });
  h.input.value = 'Line one\nInspect @'; h.input.selectionStart = h.input.value.length;
  h.context.updateSlashMenuForTaskInput();
  assert.equal(h.menu.children.length, 9, 'eight ranked files plus the compile-log built-in');
  assert.equal(h.menu.children[0].dataset.slashCommand, 'at-builtin:compile-log');
  h.key('ArrowUp'); assert.equal(h.menu.dataset.activeIndex, '8'); assert.equal(h.activeVisible(), true);
  const path = h.context.renderedSlashCommands.get(h.menu.children[8].dataset.slashCommand).path;
  h.key('Enter');
  assert.equal(h.input.value, `Line one\nInspect @${path} `);
  assert.deepEqual(h.focusFiles, [path]); assert.equal(h.submitted(), 0);
  assert.equal(h.menu.hidden, true);
});

test('whole ComposerPanel owns resize listeners and observer cleanup', () => {
  const h = harness();
  const observers = [];
  h.root.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.observed = []; observers.push(this); }
    observe(node) { this.observed.push(node); }
    disconnect() { this.disconnected = true; }
    fire(target) {
      if (this.disconnected) return;
      if (target) assert.ok(this.observed.includes(target), 'resize target must be observed');
      this.callback();
    }
  };
  const container = Object.assign(element(), {
    ownerDocument: h.document,
    querySelector: selector => h.controls.get(selector) || null,
    querySelectorAll: () => [],
    closest: selector => selector === '#codex-overleaf-panel' ? h.context.panel : null
  });
  vm.runInContext(composerSource, h.context, { filename: 'composerPanel.js' });
  let updates = 0;
  const composer = h.root.CodexOverleafComposerPanel.create({ container, callbacks: {
    onTaskKeydown: h.context.handleTaskInputKeydown,
    onMenuLayoutChange() { updates++; h.context.updateSlashMenuLayout(); }
  } });
  assert.deepEqual(observers[0].observed, [h.form, container, h.context.panel]);
  h.context.renderSlashMenu(h.commands);
  h.geometry.composerTop = 180;
  h.root.emit('resize');
  assert.equal(h.menu.style.getPropertyValue('--codex-slash-menu-space'), '168px');
  h.geometry.viewportTop = 28;
  h.root.visualViewport.emit('resize'); h.root.visualViewport.emit('scroll');
  assert.equal(h.menu.style.getPropertyValue('--codex-slash-menu-space'), '140px');
  h.geometry.composerTop = 150; observers[0].fire();
  assert.equal(h.menu.style.getPropertyValue('--codex-slash-menu-space'), '110px');
  assert.equal(updates, 4);
  // The panel can move the composer without resizing the form or its slot.
  h.geometry.composerTop = 120; observers[0].fire(h.context.panel);
  assert.equal(h.menu.style.getPropertyValue('--codex-slash-menu-space'), '80px');
  assert.equal(updates, 5);
  h.input.emit('keydown', { key: 'ArrowUp', preventDefault() {} });
  assert.equal(h.menu.dataset.activeIndex, '57'); assert.equal(h.activeVisible(), true);
  composer.destroy();
  assert.equal(observers[0].disconnected, true); assert.equal(h.root.listenerCount(), 0);
  assert.equal(h.root.visualViewport.listenerCount(), 0); assert.equal(h.input.listenerCount(), 0);
  h.root.emit('resize'); h.root.visualViewport.emit('scroll'); observers[0].fire(h.context.panel);
  assert.equal(updates, 5, 'destroyed composer has no remaining resize callbacks');
});
