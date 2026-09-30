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
  let root;
  let closeRequests = 0;
  const ensureRoot = production(source, 'ensureRoot', {
    handleClick() {}, handleInput() {}, handleKeydown() {}, requestClose() { closeRequests++; }
  });
  const instance = { document: {
    createElement(tag) {
      const listeners = new Map();
      return { tag, attrs: {}, dataset: {}, children: [],
        setAttribute(key, value) { this.attrs[key] = value; },
        appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
        addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); },
        emit(type, event) { for (const listener of listeners.get(type) || []) listener(event); }
      };
    },
    documentElement: { appendChild(value) { root = value; value.parentElement = this; } }
  } };
  ensureRoot(instance);
  assert.equal(root.tag, 'dialog');
  assert.equal(root.hidden, true);
  assert.equal(root.attrs['aria-labelledby'], 'codex-provider-dialog-title');
  assert.equal(root.children.length, 2);
  assert.ok(root.children.some(child => Object.hasOwn(child.attrs, 'data-provider-model-editor')));
  assert.ok(root.children.some(child => Object.hasOwn(child.attrs, 'data-provider-confirmation')));
  let prevented = false;
  root.emit('cancel', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(closeRequests, 1);
});

test('provider open enters the top layer, protects dirty drafts asynchronously and restores focus', async () => {
  const events = [], microtasks = [];
  const document = { activeElement: null, documentElement: { appendChild(node) { node.parentElement = this; } } };
  const origin = { focus() { events.push('returnFocus'); document.activeElement = this; } };
  const selected = { focus() { events.push('selected'); document.activeElement = this; } };
  document.activeElement = origin;
  const answer = value => ({ dataset: { providerConfirmAnswer: value },
    focus() { document.activeElement = this; },
    closest(selector) { return selector === '[data-provider-confirm-answer]' ? this : null; }
  });
  const cancel = answer('cancel'), confirm = answer('confirm');
  const confirmation = { open: false, innerHTML: '',
    showModal() { this.open = true; }, close() { this.open = false; },
    setAttribute() {}, removeAttribute() {}, replaceChildren() { this.innerHTML = ''; },
    querySelector(selector) { return selector === '[data-provider-confirm-answer="cancel"]' ? cancel : confirm; }
  };
  const secret = { value: 'transient-secret' }, status = { dataset: {}, textContent: '' };
  const root = { hidden: true, open: false, dataset: {}, attrs: {},
    showModal() { this.open = true; events.push('showModal'); },
    close() { this.open = false; events.push('close'); },
    setAttribute(key, value) { this.attrs[key] = value; },
    closest(selector) { return selector === '[hidden]' && this.hidden ? this : null; },
    querySelector(selector) {
      if (selector === '[data-provider-confirmation]') return confirmation;
      if (selector === '[data-provider-field="apiKey"]') return secret;
      if (selector === '[data-provider-status]') return status;
      return selected;
    }
  };
  document.documentElement.appendChild(root);
  const instance = { root, document, dirty: false, busy: '', callbacks: {}, tx: value => value,
    selectedId: 'custom', catalog: { providers: [{ id: 'custom', revision: 1 }] } };
  const open = production(source, 'open', { syncTheme() {}, setCatalog() {}, queueMicrotask: fn => microtasks.push(fn) });
  const methods = Function([
    'getSelectedProvider', 'escapeHtml', 'setStatus', 'finishProviderConfirmation',
    'confirmProviderAction', 'closeModelEditor', 'requestClose', 'handleClick'
  ].map(name => extractFunction(source, name)).join('\n') + '\nreturn { requestClose, handleClick };')();
  open(instance, {});
  microtasks.shift()();
  assert.deepEqual(events, ['showModal', 'selected']);
  assert.equal(root.attrs.role, 'dialog');
  assert.equal(root.dataset.embedded, 'false');
  instance.dirty = true;
  const rejectedClose = methods.requestClose(instance);
  assert.equal(confirmation.open, true);
  assert.equal(root.open, true);
  await methods.handleClick(instance, { target: cancel, preventDefault() {} });
  assert.equal(await rejectedClose, false);
  assert.equal(root.open, true);
  assert.equal(document.activeElement, selected);
  const acceptedClose = methods.requestClose(instance);
  assert.equal(confirmation.open, true);
  await methods.handleClick(instance, { target: confirm, preventDefault() {} });
  assert.equal(await acceptedClose, true);
  assert.equal(root.hidden, true);
  assert.equal(document.activeElement, origin);
  assert.equal(secret.value, '');
  assert.deepEqual(events, ['showModal', 'selected', 'selected', 'selected', 'close', 'returnFocus']);
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
