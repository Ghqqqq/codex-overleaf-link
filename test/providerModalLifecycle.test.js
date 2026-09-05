const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractFunction } = require('./_helpers/extractFunction');
const Theme = require('../extension/src/content/themeController');
const source = fs.readFileSync(path.join(__dirname, '../extension/src/content/providerSettingsDialog.js'), 'utf8');
const coordinatorSource = fs.readFileSync(path.join(__dirname, '../extension/src/content/providerSettingsCoordinator.js'), 'utf8');

function production(text, name, deps) {
  return Function(...Object.keys(deps), `${extractFunction(text, name)}; return ${name};`)(...Object.values(deps));
}

test('provider root is a native modal dialog and cancellation goes through unsaved-change protection', () => {
  const listeners = {};
  let root;
  let closeRequests = 0;
  const ensureRoot = production(source, 'ensureRoot', {
    handleClick() {}, handleInput() {}, handleKeydown() {}, requestClose() { closeRequests++; }
  });
  const instance = { document: {
    createElement(tag) {
      return { tag, attrs: {}, setAttribute(key, value) { this.attrs[key] = value; },
        addEventListener(type, listener) { listeners[type] = listener; } };
    },
    documentElement: { appendChild(value) { root = value; } }
  } };
  ensureRoot(instance);
  assert.equal(root.tag, 'dialog');
  assert.equal(root.hidden, true);
  assert.equal(root.attrs['aria-labelledby'], 'codex-provider-dialog-title');
  let prevented = false;
  listeners.cancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(closeRequests, 1);
});

test('provider open enters the top layer, preserves selected focus and restores it on close', () => {
  const events = [];
  const microtasks = [];
  let discard = false;
  const selected = { focus: () => events.push('selected') };
  const root = { hidden: true, open: false,
    showModal() { this.open = true; events.push('showModal'); },
    close() { this.open = false; events.push('close'); },
    querySelector: () => selected };
  const instance = { root, dirty: false, busy: '', callbacks: {}, tx: value => value,
    document: { activeElement: { focus: () => events.push('returnFocus') }, defaultView: { confirm: () => discard } } };
  const open = production(source, 'open', { syncTheme() {}, setCatalog() {}, queueMicrotask: fn => microtasks.push(fn) });
  const close = production(source, 'requestClose', {});
  open(instance, {});
  microtasks.shift()();
  assert.deepEqual(events, ['showModal', 'selected']);
  instance.dirty = true;
  assert.equal(close(instance), false);
  assert.equal(root.open, true);
  discard = true;
  assert.equal(close(instance), true);
  assert.equal(root.hidden, true);
  assert.deepEqual(events, ['showModal', 'selected', 'close', 'returnFocus']);
});

test('theme changes reach open provider dialogs and the edge launcher', () => {
  const targets = [{ attrs: {} }, { attrs: {} }].map(target => ({ ...target,
    setAttribute(key, value) { this.attrs[key] = value; } }));
  const panel = { attrs: {}, setAttribute(key, value) { this.attrs[key] = value; },
    ownerDocument: { querySelectorAll: () => targets } };
  Theme.applyTheme('light', panel);
  assert.deepEqual(targets.map(target => target.attrs['data-theme']), ['light', 'light']);
  Theme.applyTheme('auto', panel, { matches: false });
  assert.deepEqual(targets.map(target => target.attrs['data-theme']), ['dark', 'dark']);
});

test('dashboard provider management retains Save but hides project activation', () => {
  const context = { window: {} };
  vm.runInNewContext(source, context);
  const footer = context.window.CodexOverleafProviderSettingsDialog.getFooterActionState;
  for (const input of [{ isNew: true, dirty: true }, { isNew: false, dirty: false }]) {
    const result = footer({ ...input, hasProject: false, canSave: true, canActivate: true });
    assert.equal(result.showSaveAndUse, false);
    assert.equal(result.showUse, false);
  }
  assert.equal(footer({ isNew: true, hasProject: false, canSave: true }).showSave, true);
});

test('dashboard activation is rejected before confirmation, model loading or a native mutation', async () => {
  const requireCurrentProject = production(coordinatorSource, 'requireCurrentProject', {
    createClientError: (code, message) => Object.assign(new Error(message), { code })
  });
  const prepare = production(coordinatorSource, 'prepareProviderActivation', { requireCurrentProject });
  let reachedModelLoading = false;
  await assert.rejects(prepare({ hasCurrentProject: () => false, tx: value => value,
    getSelectedProviderId() { reachedModelLoading = true; } }, 'custom'), { code: 'provider_project_required' });
  assert.equal(reachedModelLoading, false);
});
