'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { bootstrapMigrationFixture } = require('./helpers/bootstrapMigrationFixture');
const { createCoordinatorHarness, UPDATE_KEY, CONSENT_KEY } = require('./helpers/updateCoordinatorHarness');
const { extractFunction } = require('./_helpers/extractFunction');
const ROOT = path.resolve(__dirname, '..');
const TABS_KEY = 'codex-overleaf-managed-update-tabs-v1';
const MANUAL_TABS_KEY = 'codex-overleaf-manual-runtime-reload-v1';

// The coordinator talks to the real Native updater over a temporary managed
// installation; only Chrome storage, tabs and reload are doubles.
async function committedHarness(t, onNative, prepare) {
  const f = bootstrapMigrationFixture(t);
  await f.apply(); await f.migrate(); await f.migrate('3.1'); await f.confirm();
  prepare?.(f);
  const h = await createCoordinatorHarness({ version: '2.5.1', onNative: async request => {
    const custom = await onNative?.(request, f);
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
  assert.equal(h.data[CONSENT_KEY].snoozedVersion, '2.5.1');
  assert.ok(h.data[CONSENT_KEY].snoozedUntil > Date.now() + 23 * 60 * 60 * 1000);
  assert.ok(h.data[CONSENT_KEY].snoozedUntil <= Date.now() + 24 * 60 * 60 * 1000);
  assert.equal(h.reloads(), 1);
  assert.equal(fs.readFileSync(path.join(f.context.nativeRoot, 'active-version'), 'utf8').trim(), '2.5.0');
  const rollback = h.events.find(event => event.method === 'update.rollback');
  assert.deepEqual(rollback.params, { transactionId: f.journal().id, expectedState: 'committed', reasonCode: 'update_user_rollback' });
});

for (const badEvidence of ['missing', 'invalid-hash', 'wrong-source', 'bootstrap-mismatch']) {
  test(`restore refuses ${badEvidence} evidence before requesting a reload`, async t => {
    const { h } = await committedHarness(t, async (request, f) => {
      if (!['update.rollback', 'update.status'].includes(request.method)) return;
      const response = await f.response(request.method, request.params || {});
      const pair = response.result?.restoredPair;
      if (!pair) return response;
      if (badEvidence === 'missing') delete response.result.restoredPair;
      if (badEvidence === 'invalid-hash') pair.nativeSha256 = 'not-a-digest';
      if (badEvidence === 'wrong-source') pair.extensionVersion = '2.4.9';
      if (badEvidence === 'bootstrap-mismatch' && request.method === 'update.status') pair.bootstrapSha256 = 'a'.repeat(64);
      return response;
    });
    const response = await h.send('codex-overleaf/consent-update-rollback');
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'update_rollback_unconfirmed');
    assert.equal(h.reloads(), 0);
    assert.equal(h.data[UPDATE_KEY].recoveryPending, true);
    const view = await h.send('codex-overleaf/consent-update-get-state');
    assert.equal(view.result.state.state, 'failed');
    const reload = await h.send('codex-overleaf/consent-update-reload');
    assert.equal(reload.ok, false);
    if (badEvidence !== 'bootstrap-mismatch') {
      await h.send('codex-overleaf/consent-update-recover');
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(h.data[UPDATE_KEY].recoveryPending, true, 'recovery cannot waive missing source evidence');
      assert.equal(h.reloads(), 0);
    }
  });
}

test('restore rechecks page safety and leaves a verified disk restore pending until Reload is safe', async t => {
  let busyAfterRestore = true;
  const { f, h } = await committedHarness(t, async (request, fixture) => {
    if (request.method === 'update.canApply' && fixture.journal()?.state === 'rolled_back' && busyAfterRestore) {
      return { ok: true, result: { idle: false, blockers: ['native_run_active'] } };
    }
  });
  h.sandbox.chrome.tabs.query = async () => [{ id: 17, url: 'https://www.overleaf.com/project/example', status: 'complete' }];
  h.data[TABS_KEY] = [17];
  const response = await h.send('codex-overleaf/consent-update-rollback');
  assert.equal(response.ok, true);
  assert.equal(f.journal().state, 'rolled_back');
  assert.equal(h.data[UPDATE_KEY].recoveryPending, false);
  assert.equal(response.result.state.state, 'reload_required');
  assert.equal(h.reloads(), 0);
  assert.deepEqual(h.data[TABS_KEY], [], 'the old Bootstrap must never consume an unconditional refresh list');
  assert.deepEqual(h.data[MANUAL_TABS_KEY], { targetVersion: '2.5.0', tabIds: [17] });
  busyAfterRestore = false;
  const reloaded = await h.send('codex-overleaf/consent-update-reload');
  assert.equal(reloaded.ok, true);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.reloads(), 1);
  assert.equal(h.events.filter(event => event.method === 'update.rollback').length, 1);
});

test('manual checking clears the existing reminder snooze and offers the rolled-back release', async () => {
  const h = await createCoordinatorHarness({ version: '2.5.1', onNative: async request => request.method === 'update.check'
    ? { ok: true, result: { available: true, currentVersion: '2.5.1', latestVersion: '2.5.5' } } : undefined });
  h.seed({ state: 'rolled_back', currentVersion: '2.5.1', latestVersion: '2.5.5', code: 'update_user_rollback' },
    { snoozedVersion: '2.5.5', snoozedUntil: Date.now() + 86400000 });
  const view = await h.send('codex-overleaf/consent-update-check');
  assert.equal(view.ok, true);
  assert.equal(view.result.available, true);
  assert.equal(view.result.snoozed, false);
  assert.equal(view.result.showPanel, true);
  assert.equal(view.result.actions.install, true);
});

test('recovery confirms a lost restore response but still defers reload while the page becomes busy', async t => {
  let busy = true;
  const { f, h } = await committedHarness(t, async (request, fixture) => {
    if (request.method === 'update.rollback') {
      await fixture.response(request.method, request.params || {});
      return { ok: false, error: { code: 'update_rollback_unconfirmed', message: 'response lost' } };
    }
    if (request.method === 'update.canApply' && fixture.journal()?.state === 'rolled_back' && busy) {
      return { ok: true, result: { idle: false, blockers: ['native_run_active'] } };
    }
  });
  h.sandbox.chrome.tabs.query = async () => [{ id: 17, url: 'https://www.overleaf.com/project/example', status: 'complete' }];
  assert.equal((await h.send('codex-overleaf/consent-update-rollback')).ok, false);
  assert.equal(f.journal().state, 'rolled_back');
  // Include the handoff left by an older worker interrupted during restoration.
  delete h.data[MANUAL_TABS_KEY];
  h.data[TABS_KEY] = [17];
  const recovered = await h.send('codex-overleaf/consent-update-recover');
  assert.equal(recovered.ok, true);
  assert.equal(recovered.result.state.state, 'reload_required');
  assert.equal(h.data[UPDATE_KEY].recoveryPending, false);
  assert.equal(h.data[CONSENT_KEY].snoozedVersion, '2.5.1');
  assert.deepEqual(h.data[TABS_KEY], []);
  assert.deepEqual(h.data[MANUAL_TABS_KEY], { targetVersion: '2.5.0', tabIds: [17] });
  assert.equal(h.reloads(), 0);
  busy = false;
  assert.equal((await h.send('codex-overleaf/consent-update-reload')).ok, true);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.reloads(), 1);
  assert.equal(h.events.filter(event => event.method === 'update.rollback').length, 1);
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
  const copy = sandbox.getCopy({ state: 'rolled_back', code: 'update_user_rollback' });
  assert.match(copy.detail, locale === 'zh' ? /24 小时/ : /24 hours/);
  if (locale === 'en') assert.doesNotMatch(copy.detail, /[\u4e00-\u9fff]/);
});
