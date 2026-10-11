'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { bootstrapMigrationFixture } = require('./helpers/bootstrapMigrationFixture');
const { createCoordinatorHarness, UPDATE_KEY } = require('./helpers/updateCoordinatorHarness');
const { extractFunction } = require('./_helpers/extractFunction');
const ROOT = path.resolve(__dirname, '..');
const TABS_KEY = 'codex-overleaf-managed-update-tabs-v1';

// The coordinator talks to the real Native updater over a temporary managed
// installation; only Chrome storage, tabs and reload are doubles.
async function committedHarness(t, onNative, prepare) {
  const f = bootstrapMigrationFixture(t);
  await f.apply(); await f.migrate(); await f.migrate('3.1'); await f.confirm();
  prepare?.(f);
  const h = await createCoordinatorHarness({ version: '2.5.1', onNative: async request => {
    const custom = await onNative?.(request);
    if (custom !== undefined) return custom;
    if (request.method.startsWith('update.')) return f.response(request.method, request.params || {});
    return undefined;
  } });
  h.seed({ state: 'committed', currentVersion: '2.5.1', latestVersion: '2.5.1', transactionId: f.journal().id });
  return { f, h };
}

test('committed update offers Restore previous version and returns to the verified source pair', async t => {
  const { f, h } = await committedHarness(t);
  const view = await h.send('codex-overleaf/consent-update-get-state');
  assert.equal(view.result.actions.restorePrevious, true);
  assert.equal(view.result.restorePrevious.version, '2.5.0');
  const restored = await h.send('codex-overleaf/consent-update-rollback');
  assert.equal(restored.ok, true, JSON.stringify(restored.error));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.data[UPDATE_KEY].state, 'rolled_back');
  assert.equal(h.data[UPDATE_KEY].code, 'update_user_rollback');
  assert.equal(h.data[UPDATE_KEY].currentVersion, '2.5.0');
  assert.deepEqual(h.data[TABS_KEY], []);
  assert.equal(h.reloads(), 1);
  assert.equal(fs.readFileSync(path.join(f.context.nativeRoot, 'active-version'), 'utf8').trim(), '2.5.0');
  const rollback = h.events.find(event => event.method === 'update.rollback');
  assert.deepEqual(rollback.params, { transactionId: f.journal().id, expectedState: 'committed', reasonCode: 'update_user_rollback' });
});

test('restore waits for saved, idle Overleaf tabs and does not touch the installation while busy', async t => {
  const { f, h } = await committedHarness(t, async request => request.method === 'update.canApply'
    ? { ok: true, result: { idle: false, blockers: ['native_run_active'] } } : undefined);
  const response = await h.send('codex-overleaf/consent-update-rollback');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'update_reload_busy');
  assert.equal(h.events.some(event => event.method === 'update.rollback'), false);
  assert.equal(f.journal().state, 'committed');
  assert.equal(h.reloads(), 0);
});

test('a failed restore stays visible as recovery instead of a completed rollback', async t => {
  const { f, h } = await committedHarness(t, async request => request.method === 'update.rollback'
    ? { ok: false, error: { code: 'update_rollback_unconfirmed', message: 'fixture' } } : undefined);
  const response = await h.send('codex-overleaf/consent-update-rollback');
  assert.equal(response.ok, false);
  assert.equal(h.data[UPDATE_KEY].state, 'failed');
  assert.equal(h.data[UPDATE_KEY].recoveryPending, true);
  assert.equal(h.reloads(), 0);
  assert.equal(f.journal().state, 'committed');
});

test('no restore action is offered when Native reports the source pair is gone', async t => {
  // The offer is a cached projection; Native still decides when clicked.
  const { h } = await committedHarness(t, undefined,
    f => fs.rmSync(path.join(f.context.extensionRoot, 'slots'), { recursive: true, force: true }));
  const view = await h.send('codex-overleaf/consent-update-get-state');
  assert.equal(view.result.actions.restorePrevious, false);
  const response = await h.send('codex-overleaf/consent-update-rollback');
  assert.equal(response.error.code, 'update_rollback_unavailable');
});

for (const locale of ['en', 'zh']) test(`existing banner and settings show the restore action and skip reason (${locale})`, () => {
  const notice = fs.readFileSync(path.join(ROOT, 'extension/src/content/updateNotice.js'), 'utf8');
  const tx = (en, zh) => locale === 'zh' ? zh : en;
  const nodes = Object.fromEntries(['summary', 'state', 'button', 'restore'].map(key => [key, { textContent: '', hidden: false, disabled: false }]));
  const select = selector => nodes[selector.includes('restore') ? 'restore' : selector.includes('summary') ? 'summary'
    : selector.includes('state]') ? 'state' : 'button'];
  const sandbox = vm.createContext({ settingsRoot: { querySelector: select }, currentView: null, tx, getLocale: () => locale,
    chrome: { runtime: { getManifest: () => ({ version: '2.5.1' }) } }, actionInFlight: false, settingsActionInFlight: false,
    cancellationInFlight: false, manualCommandCopied: false, ACTIVE_UPDATE_STATES: new Set(['downloading', 'staged', 'waiting_for_idle', 'applying', 'awaiting_health']), Date });
  for (const name of ['restorePreviousLabel', 'manualReasonText', 'manualUpdateCommand', 'formatUpdateMessage', 'blockerCopy',
    'blockersCopy', 'getCopy', 'renderSettings', 'visibleActions']) vm.runInContext(extractFunction(notice, name), sandbox);
  sandbox.currentView = { state: { state: 'committed', currentVersion: '2.5.1', latestVersion: '2.5.1' },
    actions: { restorePrevious: true }, restorePrevious: { version: '2.5.0' } };
  sandbox.renderSettings();
  assert.equal(nodes.restore.hidden, false);
  assert.match(nodes.restore.textContent, locale === 'zh' ? /恢复到 v2\.5\.0/ : /Restore v2\.5\.0/);
  assert.deepEqual(Array.from(sandbox.visibleActions('committed'), action => action.id), ['restore-previous', 'dismiss']);
  sandbox.currentView = { state: { state: 'failed', recoveryPending: true, currentVersion: '2.5.1', latestVersion: '2.5.1' },
    actions: { restorePrevious: true }, restorePrevious: { version: '' } };
  assert.deepEqual(Array.from(sandbox.visibleActions('failed'), action => action.id), ['restore-previous', 'recover']);
  sandbox.currentView = { state: { state: 'idle', code: 'update_skipped_after_rollback', currentVersion: '2.5.0', latestVersion: '2.5.1' },
    actions: {} };
  sandbox.renderSettings();
  assert.equal(nodes.restore.hidden, true);
  assert.match(nodes.state.textContent, locale === 'zh' ? /跳过 v2\.5\.1/ : /v2\.5\.1 is skipped/);
  assert.match(sandbox.manualReasonText({ code: 'update_bootstrap_source_mismatch' }), locale === 'zh' ? /重新安装/ : /Reinstall/);
});
