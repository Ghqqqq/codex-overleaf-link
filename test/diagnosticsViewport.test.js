const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { extractFunction } = require('./_helpers/extractFunction');
const source = fs.readFileSync(path.join(__dirname, '../extension/src/content/diagnosticsPanel.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../extension/styles/panel.css'), 'utf8');

function place({ width, height, anchor, panel, visualViewport, hidden = false, preferredWidth = 400 }) {
  let closed = 0;
  const button = { getBoundingClientRect: () => anchor, getClientRects: () => hidden ? [] : [anchor] };
  const document = { defaultView: { innerWidth: width, innerHeight: height, visualViewport } };
  const instance = { container: { ownerDocument: document, querySelector: () => button,
    closest: () => panel ? { getBoundingClientRect: () => panel } : null } };
  const element = { hidden: false, style: {}, getBoundingClientRect() { return { width: Number.parseFloat(this.style.width), height: Math.min(380, Number.parseFloat(this.style.maxHeight)) }; } };
  const position = vm.runInNewContext('(' + extractFunction(source, 'positionFloating') + ')', { closeMenu: () => { closed++; }, closeResult: () => { closed++; } });
  position(instance, element, preferredWidth);
  return { element, closed };
}

test('diagnostic result stays inside a 340px sidebar instead of covering the editor', () => {
  const { element } = place({ width: 800, height: 600, anchor: { top: 20, bottom: 40, right: 760 },
    panel: { left: 460, right: 800, top: 0, bottom: 600 } });
  assert.equal(element.style.width, '316px');
  assert.equal(element.style.left, '472px');
  assert.equal(element.style.top, '48px');
});

test('diagnostic menu and result both follow a resized sidebar', () => {
  for (const preferredWidth of [300, 400]) {
    for (const sidebarWidth of [240, 340, 460]) {
      const left = 800 - sidebarWidth;
      const { element } = place({ width: 800, height: 600, preferredWidth,
        anchor: { top: 20, bottom: 40, right: 760 }, panel: { left, right: 800, top: 0, bottom: 600 } });
      const actualLeft = Number.parseFloat(element.style.left);
      const actualWidth = Number.parseFloat(element.style.width);
      assert.ok(actualLeft >= left + 12);
      assert.ok(actualLeft + actualWidth <= 788);
      assert.equal(actualWidth, Math.min(preferredWidth, sidebarWidth - 24));
    }
  }
});

test('small viewports clamp both axes instead of clipping actions below the screen', () => {
  const { element } = place({ width: 260, height: 180, anchor: { top: 148, bottom: 168, right: 252 } });
  assert.equal(element.style.width, '236px');
  assert.equal(element.style.maxHeight, '156px');
  assert.equal(element.style.left, '12px');
  assert.equal(element.style.top, '12px');
});

test('visual viewport offsets are included when the page is zoomed', () => {
  const { element } = place({ width: 800, height: 600, visualViewport: { width: 320, height: 240, offsetLeft: 100, offsetTop: 50 }, anchor: { top: 245, bottom: 270, right: 380 } });
  assert.equal(element.style.width, '296px');
  assert.equal(element.style.left, '112px');
  assert.equal(element.style.top, '62px');
});

test('zoomed diagnostics fit the intersection of the viewport and sidebar', () => {
  const { element } = place({ width: 800, height: 600,
    visualViewport: { width: 320, height: 240, offsetLeft: 100, offsetTop: 50 },
    anchor: { top: 245, bottom: 270, right: 380 }, panel: { left: 280, right: 800, top: 0, bottom: 600 } });
  assert.equal(element.style.width, '116px');
  assert.equal(element.style.left, '292px');
  assert.equal(element.style.top, '62px');
});

test('closing the sidebar dismisses its detached diagnostic surfaces', () => {
  const result = place({ width: 800, height: 600, anchor: { top: 20, bottom: 40, right: 760 }, hidden: true });
  assert.equal(result.closed, 2);
});

test('diagnostics outside the visible viewport are dismissed', () => {
  const result = place({ width: 320, height: 600, anchor: { top: 20, bottom: 40, right: 760 },
    panel: { left: 460, right: 800, top: 0, bottom: 600 } });
  assert.equal(result.closed, 2);
});

test('close affordance has an explicit icon and stays outside the scrollable content', () => {
  const close = source.match(/<button[^>]*data-diagnostics-result-close[^>]*>[\s\S]*?<\/button>/)?.[0] || '';
  assert.match(close, /aria-label="Close diagnostics result"/);
  assert.match(close, /<svg width="14" height="14"/);
  const head = css.match(/#codex-overleaf-panel \.codex-diagnostics-result-head\s*\{[^}]*\}/)?.[0] || '';
  const button = css.match(/#codex-overleaf-panel \.codex-diagnostics-result-head button\s*\{[^}]*\}/)?.[0] || '';
  const scroll = css.match(/#codex-overleaf-panel \.codex-diagnostics-result-scroll\s*\{[^}]*\}/)?.[0] || '';
  assert.match(head, /flex:\s*0 0 auto/);
  assert.match(button, /font-size:\s*16px/);
  assert.match(scroll, /min-height:\s*0/);
  assert.match(scroll, /overflow:\s*auto/);
});

test('closing a running check prevents its late result from reopening the panel', () => {
  const result = { hidden: false };
  const instance = { container: { querySelector: () => result } };
  const closeResult = vm.runInNewContext('(' + extractFunction(source, 'closeResult') + ')', {
    hideFloating: element => { element.hidden = true; }
  });
  closeResult(instance);
  assert.equal(instance.resultDismissed, true);
  assert.equal(result.hidden, true);
  const showResult = vm.runInNewContext('(' + extractFunction(source, 'showResult') + ')', {});
  showResult(instance, { status: 'completed', title: 'Done' });
  assert.equal(result.hidden, true);
  let shown = 0;
  const showLoading = vm.runInNewContext('(' + extractFunction(source, 'showLoading') + ')', {
    t: (_, key) => key, showResult: () => { shown++; }
  });
  showLoading(instance, 'Check again');
  assert.equal(instance.resultDismissed, false);
  assert.equal(shown, 1);
});

test('Escape and outside click dismiss diagnostics without intercepting inside clicks', () => {
  const handlers = {};
  const menu = { hidden: true };
  const result = { hidden: false };
  let focused = 0;
  const inside = {};
  const nodes = {
    '.codex-diagnostics-wrap': { contains: target => target === inside },
    '[data-diagnostics-popover]': menu,
    '[data-diagnostics-result]': result,
    '[data-diagnostics-menu]': { focus: () => { focused++; } }
  };
  const doc = { defaultView: {}, addEventListener: (type, handler) => { handlers[type] = handler; } };
  const instance = { cleanup: [], container: { ownerDocument: doc, querySelector: selector => nodes[selector] } };
  const install = vm.runInNewContext('(' + extractFunction(source, 'installDismiss') + ')', {
    closeMenu: () => { menu.hidden = true; },
    closeResult: () => { result.hidden = true; }
  });
  install(instance);
  handlers.click({ target: inside });
  assert.equal(result.hidden, false);
  handlers.click({ target: {} });
  assert.equal(result.hidden, true);
  result.hidden = false;
  let prevented = false;
  handlers.keydown({ key: 'Escape', preventDefault: () => { prevented = true; }, stopPropagation() {} });
  assert.equal(result.hidden, true);
  assert.equal(prevented, true);
  assert.equal(focused, 1);
});

test('passed checks collapse their explanations while warnings and failures stay open', () => {
  const makeNode = tag => ({ tag, children: [], dataset: {}, append(...nodes) { this.children.push(...nodes); }, setAttribute() {} });
  const context = { document: { createElement: makeNode } };
  context.healthBucket = vm.runInNewContext('(' + extractFunction(source, 'healthBucket') + ')', context);
  const render = vm.runInNewContext('(' + extractFunction(source, 'renderCheckRows') + ')', context);
  const container = makeNode('div');
  render(container, ['completed', 'warning', 'failed'].map(status => ({ status, title: status, summary: 'Details' })));
  const rows = container.children[0].children;
  assert.deepEqual(rows.map(row => row.tag), ['details', 'details', 'details']);
  assert.deepEqual(rows.map(row => row.open), [false, true, true]);
  assert.ok(rows.every(row => row.children[0].tag === 'summary'));
});

test('confirmations opened from the settings workbench cover the viewport instead of the sidebar', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '../extension/src/content/panelRenderer.js'), 'utf8');
  const overlay = css.match(/#codex-overleaf-panel \.codex-plugin-confirm\[data-context="workbench"\]\s*\{[^}]*\}/)?.[0] || '';
  assert.match(renderer, /\.codex-settings-workbench\[open\][\s\S]{0,80}overlay\.dataset\.context = 'workbench'/);
  assert.match(overlay, /inset:\s*0;/);
  assert.match(overlay, /width:\s*100vw/);
});

test('confirmation actions have intrinsic height and can wrap long labels', () => {
  const actions = css.match(/#codex-overleaf-panel \.codex-plugin-confirm-actions\s*\{[^}]*\}/)?.[0] || '';
  const button = css.match(/#codex-overleaf-panel \.codex-plugin-confirm-actions button\s*\{[^}]*\}/)?.[0] || '';
  assert.match(actions, /flex-wrap:\s*wrap/);
  assert.match(button, /height:\s*auto/);
  assert.match(button, /white-space:\s*normal/);
  assert.doesNotMatch(button, /height:\s*30px/);
});
