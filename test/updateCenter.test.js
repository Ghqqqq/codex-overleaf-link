const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

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

test('failed managed updates stop progress and expose an actionable recovery command', () => {
  const notice = read('extension/src/content/updateNotice.js');
  const bootstrap = read('extension/bootstrap/background.js');
  const coordinator = read('extension/src/backgroundUpdateCoordinator.js');

  assert.match(notice, /codex-overleaf-link@\$\{version\} -- install-managed/);
  assert.match(notice, /update_recovery_timeout/);
  assert.match(notice, /id: 'copy-manual'/);
  assert.match(bootstrap, /setFailedUpdateState/);
  assert.match(bootstrap, /readNativeUpdateStatus\(UPDATE_RECOVERY_TIMEOUT_MS\)/);
  assert.match(coordinator, /state: 'failed'/);
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
