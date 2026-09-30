const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const popupSource = fs.readFileSync(path.join(root, 'extension/src/popup.js'), 'utf8');
const coordinatorSource = fs.readFileSync(path.join(root, 'extension/src/backgroundUpdateCoordinator.js'), 'utf8');
const noticeSource = fs.readFileSync(path.join(root, 'extension/src/content/updateNotice.js'), 'utf8');
const bootstrapSource = fs.readFileSync(path.join(root, 'extension/bootstrap/background.js'), 'utf8');
const bootstrapPopupCss = fs.readFileSync(path.join(root, 'extension/bootstrap/popup.css'), 'utf8');
const bootstrapPopupMarkup = fs.readFileSync(path.join(root, 'extension/bootstrap/popup.html'), 'utf8');
const settingsSource = fs.readFileSync(path.join(root, 'extension/src/content/settingsPanel.js'), 'utf8');
const extensionManifest = require('../extension/manifest.json');
const runtimeManifest = require('../extension/runtime-manifest.json');
const { getContentBundleSourceOrder } = require('./_helpers/contentBundleEntry');
const { extractFunction } = require('./_helpers/extractFunction');
const { createCoordinatorHarness, UPDATE_KEY, CONSENT_KEY } = require('./helpers/updateCoordinatorHarness');

test('toolbar Popup stays focused on connection status and removes duplicate update controls', () => {
  const schedule = extractFunction(popupSource, 'scheduleConsentUpdateUi');
  assert.match(schedule, /querySelector\('\.updates'\)\?\.remove\(\)/);
  assert.doesNotMatch(schedule, /sendConsentAction|renderUpdateSection/);
  assert.doesNotMatch(bootstrapPopupMarkup, /class="updates"/);
  assert.doesNotMatch(bootstrapPopupMarkup, /id="check-update"/);
  assert.doesNotMatch(bootstrapPopupMarkup, /<script src="popup\.js"><\/script>/);
  assert.match(bootstrapPopupCss, /html\s*\{[\s\S]*background:/);
  assert.doesNotMatch(bootstrapPopupCss, /@keyframes popup-enter\s*\{[^@]*translateY/);
  for (const id of ['connection-toggle', 'connection-details', 'extension-version', 'native-version', 'native-install']) {
    assert.match(bootstrapPopupMarkup, new RegExp(`id="${id}"`));
  }
  assert.match(bootstrapPopupMarkup, /aria-controls="connection-details"/);
  assert.match(bootstrapPopupMarkup, /id="launcher-toggle"[^>]*type="checkbox"/);
  assert.match(bootstrapPopupMarkup, /<script src="\.\.\/runtime\/src\/popup\.js"><\/script>/);
  assert.doesNotMatch(popupSource, /navigator\.language/);
});

test('automatic checks are check-only and the replaceable coordinator owns guarded installation', () => {
  const automaticCheck = extractFunction(coordinatorSource, 'checkOnly');
  const installUpdate = extractFunction(coordinatorSource, 'installUpdate');
  const stageUpdate = extractFunction(coordinatorSource, 'stageAuthorizedUpdate');
  const activateUpdate = extractFunction(coordinatorSource, 'tryActivateStagedUpdateCore');
  assert.match(automaticCheck, /'update\.check'/);
  assert.doesNotMatch(automaticCheck, /'update\.(authorize|stage|apply)'/);
  assert.match(installUpdate, /'update\.authorize'/);
  assert.match(coordinatorSource, /recoverInterruptedCheck/);
  assert.match(coordinatorSource, /update_check_timeout/);
  assert.match(coordinatorSource, /consent-update-dismiss/);
  assert.match(installUpdate, /await stageAuthorizedUpdate\(operation\)/);
  assert.ok(installUpdate.indexOf("'update.authorize'") < installUpdate.indexOf('await stageAuthorizedUpdate(operation)'));
  assert.match(stageUpdate, /'update\.stage'/);
  assert.match(stageUpdate, /tryActivateStagedUpdate\(operation\)/);
  assert.match(activateUpdate, /collectBlockers/);
  assert.match(activateUpdate, /'update\.apply'/);
  assert.ok(activateUpdate.indexOf('collectBlockers') < activateUpdate.indexOf("'update.apply'"));
  assert.doesNotMatch(installUpdate, /CodexOverleafManagedUpdateExecutor|installAuthorizedUpdate/);
  assert.doesNotMatch(installUpdate, /chrome\.runtime\.sendMessage/);
  // Keep the immutable Bootstrap's compatibility executor available to older runtimes.
  assert.match(bootstrapSource, /CodexOverleafManagedUpdateExecutor\s*=\s*Object\.freeze/);
  assert.match(bootstrapSource, /installAuthorizedUpdate:\s*\(\)\s*=>\s*checkAndStage\(\{ manual: true \}\)/);
  assert.match(coordinatorSource, /Number\.MAX_SAFE_INTEGER/);
  assert.match(coordinatorSource, /update_revoke_too_late[\s\S]*return getView\(\)/);
});

test('a coordinator check discovers updates without authorizing, staging or applying them', async () => {
  const harness = await createCoordinatorHarness();
  const response = await harness.send('codex-overleaf/consent-update-check');
  const methods = harness.events.filter(event => event.type === 'native').map(event => event.method);

  assert.equal(response.ok, true);
  assert.equal(harness.data[UPDATE_KEY].state, 'update_available');
  assert.equal(methods.filter(method => method === 'update.check').length, 1);
  assert.deepEqual(methods.filter(method => ['update.authorize', 'update.stage', 'update.apply'].includes(method)), []);
  assert.equal(harness.reloads(), 0);
});

test('coordinator installation authorizes, stages and checks idle before applying a matching transaction', async () => {
  const targetVersion = '2.4.2';
  const transactionId = 'popup-update-transaction';
  const harness = await createCoordinatorHarness({
    onNative(request) {
      if (request.method === 'update.stage') {
        return { ok: true, result: { targetVersion, transactionId } };
      }
      if (request.method === 'update.apply') {
        return { ok: true, result: { state: 'awaiting_health', targetVersion, transactionId } };
      }
      return undefined;
    }
  });
  harness.seed({
    state: 'update_available',
    currentVersion: harness.data[UPDATE_KEY].currentVersion,
    latestVersion: targetVersion,
    lastCheckedAt: Date.now()
  });

  const response = await harness.send('codex-overleaf/consent-update-install');
  const requests = harness.events.filter(event => event.type === 'native' && event.method !== 'update.status');

  assert.equal(response.ok, true, JSON.stringify(response));
  assert.deepEqual(requests.map(request => request.method), [
    'update.authorize', 'update.stage', 'update.canApply', 'update.apply'
  ]);
  const [authorization, staged, , applied] = requests;
  assert.equal(authorization.params.targetVersion, targetVersion);
  assert.ok(authorization.params.authorizationId);
  assert.equal(staged.params.operationId, authorization.params.operationId);
  assert.equal(applied.params.operationId, authorization.params.operationId);
  assert.equal(applied.params.transactionId, transactionId);
  assert.equal(harness.data[CONSENT_KEY].authorizationId, authorization.params.authorizationId);
  assert.equal(harness.data[UPDATE_KEY].state, 'awaiting_health');
  assert.equal(harness.reloads(), 1);
});

test('managed update actions trust exact Overleaf and toolbar senders without a separate update window', () => {
  const senderPolicySource = extractFunction(coordinatorSource, 'isAllowedSender');
  const runtimeId = 'codex-overleaf-test-extension';
  const extensionRoot = `chrome-extension://${runtimeId}/`;
  const isAllowedSender = vm.runInNewContext(`(${senderPolicySource})`, {
    URL,
    chrome: {
      runtime: {
        id: runtimeId,
        getURL: relativePath => extensionRoot + relativePath
      }
    }
  });

  assert.equal(isAllowedSender({
    id: runtimeId,
    url: `${extensionRoot}bootstrap/update.html?action=install`,
    tab: { url: `${extensionRoot}bootstrap/update.html?action=install` }
  }), false);
  assert.equal(isAllowedSender({
    id: runtimeId,
    url: `${extensionRoot}bootstrap/popup.html`
  }), true);
  assert.equal(isAllowedSender({
    id: runtimeId,
    url: 'https://www.overleaf.com/project/example',
    tab: { url: 'https://www.overleaf.com/project/example' }
  }), true);
  assert.equal(isAllowedSender({
    id: runtimeId,
    url: 'https://www.overleaf.com/project',
    tab: { url: 'https://www.overleaf.com/project' }
  }), true);
  assert.equal(isAllowedSender({
    id: runtimeId,
    url: `${extensionRoot}bootstrap/background.js`,
    tab: { url: `${extensionRoot}bootstrap/background.js` }
  }), false);
  assert.equal(isAllowedSender({
    id: 'another-extension',
    url: `${extensionRoot}bootstrap/update.html`
  }), false);
  assert.equal(isAllowedSender({ id: runtimeId }), false);
});

test('panel notice loads after the idle gate and before content runtime', () => {
  const sourceOrder = getContentBundleSourceOrder();
  const idle = sourceOrder.indexOf('src/content/updateIdle.js');
  const notice = sourceOrder.indexOf('src/content/updateNotice.js');
  const runtime = sourceOrder.indexOf('src/content/contentRuntime.js');
  assert.equal(idle >= 0 && idle < notice && notice < runtime, true);
  assert.match(noticeSource, /data-update-notice-action/);
  assert.match(noticeSource, /waiting_for_idle/);
  assert.match(noticeSource, /aria-valuetext/);
  assert.match(noticeSource, /options\.getLocale/);
  assert.match(noticeSource, /consent-update-install/);
  assert.doesNotMatch(noticeSource, /consent-update-open-center/);
  assert.doesNotMatch(coordinatorSource, /chrome\.windows\.create/);
  assert.match(noticeSource, /save_state_unverified/);
  assert.match(bootstrapSource, /FAST_IDLE_RETRY_MS\s*=\s*4000/);
  assert.match(bootstrapSource, /idleApplyPromise/);
  assert.match(noticeSource, /data-check-updates/);
  assert.match(settingsSource, /data-i18n="softwareUpdatesTitle"/);
  assert.match(settingsSource, /software:\s*'<rect/);
  assert.match(settingsSource, /codexSetIcon\('software'\)/);
  assert.match(settingsSource, /data-check-updates/);
  assert.equal(runtimeManifest.matches.includes('https://www.overleaf.com/project'), true);
  assert.equal(extensionManifest.content_scripts[0].matches.includes('https://www.overleaf.com/project'), true);
  assert.equal(extensionManifest.host_permissions.includes('https://www.overleaf.com/project'), true);
  assert.match(bootstrapSource, /OVERLEAF_EDITOR_MATCHES/);
  assert.match(noticeSource, /isRuntimeRestartError/);
  assert.match(noticeSource, /buildRestartingView/);
  assert.match(noticeSource, /consent-update-get-state/);
  assert.doesNotMatch(noticeSource, /navigator\.language/);
});
