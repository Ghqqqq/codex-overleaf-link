const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createCoordinatorHarness, UPDATE_KEY } = require('./helpers/updateCoordinatorHarness');

const repoRoot = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('Overleaf tab exposes the persistent staged update experience', () => {
  const notice = read('extension/src/content/updateNotice.js');

  assert.match(notice, /waiting_for_idle/);
  assert.match(notice, /codex-update-notice-progress/);
  assert.match(notice, /role', 'progressbar'/);
  assert.match(notice, /Update in progress/);
  assert.match(notice, /state === 'committed'/);
  assert.match(notice, /id: 'dismiss'/);
});

test('Overleaf update notice restores persisted progress after managed restarts', () => {
  const source = read('extension/src/content/updateNotice.js');

  assert.match(source, /consent-update-get-state/);
  assert.match(source, /consent-update-check/);
  assert.match(source, /consent-update-install/);
  assert.match(source, /consent-update-later/);
  assert.match(source, /consent-update-dismiss/);
  assert.match(source, /consent-update-state/);
});

test('Overleaf update actions stay in the current tab and never create an update window', () => {
  const notice = read('extension/src/content/updateNotice.js');
  const coordinator = read('extension/src/backgroundUpdateCoordinator.js');

  assert.match(notice, /install: 'codex-overleaf\/consent-update-install'/);
  assert.match(notice, /retry: 'codex-overleaf\/consent-update-check'/);
  assert.doesNotMatch(notice, /consent-update-open-center/);
  assert.doesNotMatch(coordinator, /function openUpdateCenter/);
  assert.doesNotMatch(coordinator, /bootstrap\/update\.html/);
  assert.doesNotMatch(coordinator, /chrome\.windows\.create/);
});

test('the failure notice retains the public manual-install recovery action', () => {
  const notice = read('extension/src/content/updateNotice.js');
  assert.match(notice, /codex-overleaf-link@\$\{version\} -- install-managed/);
  assert.match(notice, /update_recovery_timeout/);
  assert.match(notice, /id: 'copy-manual'/);
});

test('health recovery verifies rollback and settles into a terminal state', async () => {
  let rolledBack = false;
  const transaction = { id: 'transaction-1', sourceVersion: '2.4.1', targetVersion: '2.4.2' };
  const h = await createCoordinatorHarness({ onNative(request) {
    if (request.method === 'update.rollback') {
      assert.equal(request.params.transactionId, transaction.id);
      assert.equal(request.params.expectedState, 'awaiting_health');
      rolledBack = true;
      return { ok: true, result: { state: 'rolled_back', version: transaction.sourceVersion } };
    }
    if (request.method === 'update.status') return { ok: true, result: {
      managed: true, installedAligned: rolledBack,
      activeVersion: rolledBack ? transaction.sourceVersion : transaction.targetVersion,
      runtimeVersion: transaction.sourceVersion,
      transaction: { ...transaction, state: rolledBack ? 'rolled_back' : 'awaiting_health', reasonCode: 'update_health_timeout' }
    } };
  } });
  h.seed({ state: 'awaiting_health', currentVersion: '2.4.1', latestVersion: '2.4.2',
    transactionId: transaction.id, deadlineAt: 1, recoveryPending: true });
  const result = await h.send('codex-overleaf/consent-update-recover');
  assert.equal(result.ok, true);
  assert.equal(rolledBack, true);
  assert.equal(h.data[UPDATE_KEY].state, 'rolled_back');
  assert.equal(h.data[UPDATE_KEY].currentVersion, '2.4.1');
  assert.equal(h.data[UPDATE_KEY].recoveryPending, false);
  assert.equal(h.data[UPDATE_KEY].cancelRequested, false);
  const rollbackIndex = h.events.findIndex(event => event.type === 'native' && event.method === 'update.rollback');
  assert.ok(h.events.slice(rollbackIndex + 1).some(event => event.type === 'native' && event.method === 'update.status'));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.reloads(), 1);
});

test('unconfirmed rollback stays recoverable instead of reporting restored success', async () => {
  const h = await createCoordinatorHarness({ onNative(request) {
    if (request.method === 'update.status') return { ok: true, result: { managed: true, installedAligned: false,
      activeVersion: '2.4.2', runtimeVersion: '2.4.1', transaction: {
        id: 'transaction-1', sourceVersion: '2.4.1', targetVersion: '2.4.2', state: 'awaiting_health'
      } } };
    if (request.method === 'update.rollback') return { ok: false, error: { code: 'fixture_rollback_failed', message: 'still recovering' } };
  } });
  h.seed({ state: 'awaiting_health', currentVersion: '2.4.1', latestVersion: '2.4.2',
    transactionId: 'transaction-1', deadlineAt: 1, recoveryPending: true });
  await h.send('codex-overleaf/consent-update-recover');
  assert.equal(h.data[UPDATE_KEY].state, 'failed');
  assert.equal(h.data[UPDATE_KEY].recoveryPending, true);
  assert.equal(h.reloads(), 0);
});

test('consent updater checks once at browser or extension startup without changing periodic checks', () => {
  const coordinator = read('extension/src/backgroundUpdateCoordinator.js');

  assert.match(coordinator, /STARTUP_CHECK_SESSION_KEY/);
  assert.match(coordinator, /chrome\.storage\?\.session/);
  assert.match(coordinator, /if \(await claimStartupCheck\(\)\)/);
  assert.match(coordinator, /enqueuePolicyAction\(\(\) => checkOnly\(\{ manual: false \}\)\)/);
  assert.match(coordinator, /delayInMinutes:\s*0\.5/);
  assert.match(coordinator, /periodInMinutes:\s*CHECK_INTERVAL_MINUTES/);
});

test('managed updater preserves authorized candidates across ETag 304 and re-verifies staged bytes before apply', () => {
  const updater = read('native-host/src/updateManager.js');
  assert.match(updater, /releaseResponse\.status === 304[\s\S]*CANDIDATE_FILE[\s\S]*available: true/);
  assert.match(updater, /bundleSha256: manifest\.updateBundle\.sha256/);
  assert.match(updater, /const verifiedPayloadRoot = path\.join\(journal\.stageRoot, 'payload-apply'\)/);
  assert.match(updater, /verifyStagedArchive\(journal\)/);
  assert.match(updater, /extractVerifiedUpdateBundle\(\{\s*archivePath: journal\.archivePath,\s*destinationRoot: verifiedPayloadRoot/);
  assert.match(updater, /update_runtime_asset_missing/);
});
