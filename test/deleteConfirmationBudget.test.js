'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const Creator = require('../extension/src/page/textFileCreator');

// Exercise the real deletion DOM/ZIP lifecycle with a deterministic transport and clock.
class Clock {
  time = 1700000000000;
  id = 0;
  timers = new Map();
  now = () => this.time;
  setTimeout = (fn, ms = 0) => {
    const id = ++this.id;
    this.timers.set(id, { at: this.time + Math.max(0, Number(ms)), fn });
    return id;
  };
  clearTimeout = id => this.timers.delete(id);
  sleep = ms => new Promise(resolve => this.setTimeout(resolve, ms));
  async run(promise) {
    let done = false, value, error;
    promise.then(result => { value = result; done = true; }, failure => { error = failure; done = true; });
    for (let step = 0; step < 20000; step++) {
      for (let i = 0; i < 100; i++) await Promise.resolve();
      if (done) { if (error) throw error; return value; }
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      assert.ok(next, 'Deletion must not wait on real I/O in this harness');
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].fn();
    }
    throw new Error('Deletion exceeded the virtual event-loop step limit');
  }
}
const present = (ms = 100) => ({ kind: 'present', ms });
const absent = (ms = 100) => ({ kind: 'absent', ms });
const fail = (ms = 1000, status = 503) => ({ kind: 'fail', ms, status });
const node = (label, attributes = {}) => ({
  textContent: label, disabled: false, getAttribute: key => attributes[key] ?? null,
  getClientRects: () => [{}], querySelector: () => null, querySelectorAll: () => [], closest: () => null,
  cloneNode: () => ({ textContent: label, querySelectorAll: () => [] }),
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 20 })
});

function harness(plan, config = {}) {
  const clock = new Clock(), start = clock.now(), requests = [], trace = [];
  const target = config.binary ? 'probe.png' : 'nested/probe.tex', expected = 'checked pre-image\n';
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const state = { exists: true, selected: false, menu: false, dialog: false, current: true,
    projectId: 'budget-project', identity: 'stable-id', label: target.split('/').pop(),
    expanded: config.collapsed ? 'false' : 'true', deletes: 0, cancels: 0, aborts: 0, unexpectedReads: 0 };
  const entity = node('');
  entity.getAttribute = key => key === 'data-file-id' ? state.identity : null;
  const details = node('probe');
  const row = node('probe', { role: 'treeitem' });
  details.click = () => { state.selected = !config.selectNever; };
  details.dispatchEvent = event => { if (event.type === 'contextmenu') state.menu = true; };
  row.closest = () => row;
  row.querySelector = selector => selector === '[data-file-type="folder"]' ? null
    : selector.includes('[data-file-id]') ? entity
      : /entity-details|entity-button|item-name/.test(selector) ? details : null;
  const folder = node('nested');
  folder.getAttribute = key => key === 'aria-expanded' ? state.expanded : 'true';
  folder.querySelector = () => ({ click() {
    trace.push({ event: 'expand', at: clock.now() });
    if (!config.expandNever) state.expanded = 'true';
  } });
  const menuItem = node('Delete');
  menuItem.click = () => { state.menu = false; state.dialog = true; config.onDialog?.(state, clock); };
  const menu = node('');
  menu.querySelectorAll = () => [menuItem];
  const confirm = node('Delete'), cancel = node('Cancel');
  confirm.click = () => {
    state.deletes++; state.exists = false; state.dialog = false;
    trace.push({ event: 'delete', at: clock.now() });
    config.onDelete?.(state, clock);
  };
  cancel.click = () => { state.dialog = false; state.cancels++; };
  const dialog = node('');
  dialog.querySelectorAll = selector => selector === 'li' ? [node(state.label)] : [confirm, cancel];
  const foreignDialog = node('Foreign dialog');
  const document = { querySelector: () => null, querySelectorAll: selector =>
    selector === '[role="dialog"]' ? [...(state.dialog ? [dialog] : []), ...(config.foreignDialog ? [foreignDialog] : [])]
      : selector === '[role="menu"]' ? (state.menu ? [menu] : [])
        : selector.includes('[aria-selected="true"]') ? (state.exists && state.selected ? [row] : []) : [] };
  const window = { document, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, AbortController,
    CodexOverleafProjectFiles: { isTextProjectPath: path => path.endsWith('.tex') },
    MouseEvent: class { constructor(type) { this.type = type; } },
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    crypto: { subtle: { digest: async (_, input) => Uint8Array.from(createHash('sha256').update(input).digest()).buffer } } };
  const snapshotRouter = { invalidateCache() {}, async fetchProjectZipSnapshot(options) {
    const index = requests.length, item = plan[index] || config.fallback;
    requests.push({ at: clock.now(), timeoutMs: options.zipTimeoutMs, includeBinaryFiles: options.includeBinaryFiles,
      serverOnly: options.serverOnly, force: options.force });
    if (!item) { state.unexpectedReads++; throw new Error('Unexpected snapshot read'); }
    options.signal?.addEventListener('abort', () => { state.aborts++; }, { once: true });
    // Deliberately do not honor zipTimeoutMs: the production caller must enforce its deadline.
    await clock.sleep(item.ms);
    config.afterRead?.(index, state, clock);
    if (item.throw) throw Object.assign(new Error('transport rejected'), item.throw);
    if (item.kind === 'fail') return { ok: false, status: item.status, code: 'injected_zip_failure',
      reason: 'ZIP transport failed', diagnostics: { attempts: [{ status: item.status, reason: 'injected failure' }], marker: 'raw-diagnostic' } };
    const files = item.kind === 'absent' ? [] : [{ path: target, ...(config.binary
      ? { contentBase64: (item.bytes || bytes).toString('base64') } : { content: item.content ?? expected }) }];
    return { ok: true, files, skipped: item.skipped ? [{ path: target }] : [] };
  } };
  const api = Creator.create({ window, document, now: clock.now, snapshotRouter, uploadHelpers: {}, treeOperations: {
    getProjectId: () => state.projectId,
    findFileTreeNode: path => path === 'nested' ? folder : path === target && state.exists ? row : null,
    projectPathExists: () => state.exists, collectProjectTextPaths: () => ['main.tex', target],
    invalidateDomProjectPathCache() {}, getActiveFilePath: () => target
  } });
  const operation = { type: 'delete', path: target, undoCreatedFile: { v: 1, kind: config.binary ? 'binary' : 'text' } };
  const options = { expectedContent: expected, expectedSha256: createHash('sha256').update(bytes).digest('hex'),
    undoCreatedFile: true, canDelete: () => state.exists && state.current, isCurrent: () => state.current };
  return { api, state, trace, requests, clock, start, options, operation,
    async run(overrides = {}) {
      const result = await clock.run(api.deleteFile(operation, { ...options, ...overrides }));
      assert.equal(state.unexpectedReads, 0, 'Every snapshot must have an explicit test response');
      return result;
    } };
}

for (const binary of [false, true]) test('fresh text/binary server absence certifies one deletion: ' + binary, async () => {
  const h = harness([present(), present(), absent()], { binary });
  const result = await h.run();
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.changedDocument, true);
  assert.equal(h.state.deletes, 1);
  assert.equal(h.requests.length, 3);
  assert.ok(h.requests.every(request => request.serverOnly && request.force && request.includeBinaryFiles === binary));
});

test('the 29s + 30s + retry prechecks cannot spend the reserved confirmation budget', async () => {
  const h = harness([present(29000), fail(29999), present(30000)]);
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.equal(result.changedDocument, false);
  assert.equal(h.state.deletes, 0);
  assert.equal(h.state.exists, true);
  assert.equal(h.clock.now() - h.start, 75000);
  assert.equal(result.remainingMs, 15000);
  assert.equal(h.requests.at(-1).timeoutMs, 15001);
  assert.ok(result.diagnostics.zipFailures.some(failure => failure.status === 503));
  assert.ok(result.technicalMessage);
  assert.equal(h.state.cancels, 1);
});

test('more than three fast transient failures recover within the same deletion attempt', async () => {
  const h = harness([present(), present(), fail(), fail(), fail(), absent()]);
  const result = await h.run();
  assert.equal(result.ok, true);
  assert.equal(h.state.deletes, 1);
  assert.equal(h.requests.length, 6);
  assert.ok(h.clock.now() - h.start > 6200);
});

test('a stale present snapshot after 15s keeps polling until the absolute deadline', async () => {
  const h = harness([present(), present(), present(16000), absent()]);
  assert.equal((await h.run()).ok, true);
  assert.equal(h.state.deletes, 1);
  assert.equal(h.requests.length, 4);
});

test('a transport ignoring timeout cannot return late success past the caller deadline', async () => {
  const h = harness([present(), present(), absent(60000)]);
  const result = await h.run({ deadlineAt: h.start + 20000 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'file_tree_operation_unverified');
  assert.equal(result.changedDocument, true);
  assert.equal(result.stage, 'server_deletion_receipt');
  assert.equal(result.remainingMs, 0);
  assert.equal(h.clock.now(), h.start + 20000);
  assert.equal(h.state.aborts, 1);
  assert.equal(h.state.deletes, 1);
  assert.equal(h.requests.at(-1).timeoutMs, 19800);
  assert.match(result.reason, /could not be confirmed/);
  assert.ok(result.failure.technicalMessage);
});

for (const externalBudget of [30000, 120000]) test('confirmation obeys the caller/local minimum: ' + externalBudget, async () => {
  const h = harness([present(), present()], { fallback: fail(0) });
  const result = await h.run({ deadlineAt: h.start + externalBudget });
  const expectedDeadline = h.start + Math.min(90000, externalBudget);
  assert.equal(result.ok, false);
  assert.equal(result.deadlineAt, expectedDeadline);
  assert.equal(h.clock.now(), expectedDeadline);
  assert.equal(result.remainingMs, 0);
  assert.equal(h.state.deletes, 1);
  assert.ok(h.requests.every(request => request.at < expectedDeadline && request.timeoutMs <= expectedDeadline - request.at));
  assert.ok(result.diagnostics.zipFailures.length <= 8);
  assert.ok(result.diagnostics.zipFailures.some(failure => failure.diagnostics?.marker === 'raw-diagnostic'));
});

for (const budget of [0, 14999, 15000]) test('no deletion or preflight read starts without the reserve: ' + budget, async () => {
  const h = harness([]);
  const result = await h.run({ deadlineAt: h.start + budget });
  assert.equal(result.changedDocument, false);
  assert.equal(result.code, 'delete_confirmation_budget_exhausted');
  assert.equal(h.requests.length, 0);
  assert.equal(h.state.deletes, 0);
});

for (const phase of ['selection', 'folder']) test('DOM waits also preserve the confirmation reserve: ' + phase, async () => {
  const h = harness([present(1000)], phase === 'selection' ? { selectNever: true } : { collapsed: true, expandNever: true });
  const result = await h.run({ deadlineAt: h.start + 17000 });
  assert.equal(result.changedDocument, false);
  assert.equal(result.remainingMs, 15000);
  assert.equal(h.clock.now() - h.start, 2000);
  assert.equal(h.state.deletes, 0);
});

for (const status of [401, 403]) for (const postDelete of [false, true]) {
  test('permission ' + status + ' is terminal before/after deletion: ' + postDelete, async () => {
    const h = harness([...(postDelete ? [present(), present()] : []), fail(100, status)]);
    const result = await h.run();
    assert.equal(result.ok, false);
    assert.equal(result.changedDocument, postDelete);
    assert.equal(result.failure.retryable, false);
    assert.equal(result.diagnostics.marker, 'raw-diagnostic');
    assert.equal(result.diagnostics.status, status);
    assert.equal(result.technicalMessage, 'ZIP transport failed');
    assert.equal(h.requests.length, postDelete ? 3 : 1);
    assert.equal(h.state.deletes, postDelete ? 1 : 0);
  });
}

test('thrown permission failures retain diagnostics and stop without retry', async () => {
  const h = harness([{ ms: 100, throw: { status: 403, diagnostics: { marker: 'thrown-diagnostic' }, technicalMessage: 'Forbidden by server' } }]);
  const result = await h.run();
  assert.equal(result.failure.retryable, false);
  assert.equal(result.diagnostics.marker, 'thrown-diagnostic');
  assert.equal(result.technicalMessage, 'Forbidden by server');
  assert.equal(h.requests.length, 1);
});

for (const cause of ['cancel', 'project']) for (const postDelete of [false, true]) {
  test('ownership change stops reads/mutations: ' + cause + ', post-delete ' + postDelete, async () => {
    const h = harness([present(), present(), fail()], { afterRead(index, state) {
      if (index === (postDelete ? 2 : 0)) {
        if (cause === 'cancel') state.current = false;
        else state.projectId = 'other-project';
      }
    } });
    const result = await h.run();
    assert.equal(result.code, cause === 'cancel' ? 'codex_cancelled' : 'aborted_project_changed');
    assert.equal(result.changedDocument, postDelete);
    assert.equal(result.failure.retryable, false);
    assert.equal(h.requests.length, postDelete ? 3 : 1);
    assert.equal(h.state.deletes, postDelete ? 1 : 0);
  });
}

test('cancelVerifications interrupts a non-cooperative in-flight snapshot', async () => {
  const h = harness([present(30000)]);
  h.clock.setTimeout(() => h.api.cancelVerifications(), 1000);
  const result = await h.run();
  assert.equal(result.code, 'codex_cancelled');
  assert.equal(h.clock.now() - h.start, 1000);
  assert.equal(h.state.deletes, 0);
  assert.equal(h.requests.length, 1);
});

test('cancellation during backoff cannot start another snapshot', async () => {
  const h = harness([fail(100)]);
  h.clock.setTimeout(() => { h.state.current = false; }, 500);
  const result = await h.run();
  assert.equal(result.code, 'codex_cancelled');
  assert.equal(h.requests.length, 1);
  assert.equal(h.state.deletes, 0);
});

for (const kind of ['content', 'sha', 'identity', 'dialog', 'scope']) test('pre-image and DOM guards survive: ' + kind, async () => {
  const second = present();
  if (kind === 'content') second.content = 'collaborator changed this';
  if (kind === 'sha') second.bytes = Buffer.from('modified image');
  const h = harness([present(), second], { binary: kind === 'sha', onDialog(state) {
    if (kind === 'identity') state.identity = 'replacement-id';
    if (kind === 'dialog') state.label = 'other.tex';
  } });
  const result = await h.run(kind === 'scope' ? { canDelete: () => false } : {});
  assert.equal(result.ok, false);
  assert.equal(result.changedDocument, false);
  assert.equal(h.state.deletes, 0);
  assert.equal(h.state.exists, true);
});

test('a foreign dialog remains untouched', async () => {
  const h = harness([], { foreignDialog: true });
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.equal(h.state.cancels, 0);
  assert.equal(h.state.deletes, 0);
});

test('a skipped target cannot be mistaken for confirmed server absence', async () => {
  const h = harness([present(), present(), { ...absent(), skipped: true }]);
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.equal(result.changedDocument, true);
  assert.equal(result.failure.retryable, false);
  assert.match(result.technicalMessage, /skipped/);
  assert.equal(h.requests.length, 3);
});

test('a later manual retry confirms absence without a second delete', async () => {
  const h = harness([present(), present(), fail(100, 403), absent()]);
  const first = await h.run();
  const second = await h.run();
  assert.equal(first.ok, false);
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);
  assert.equal(second.changedDocument, false);
  assert.equal(h.state.deletes, 1);
});
