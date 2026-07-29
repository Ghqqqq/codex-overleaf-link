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

test('toolbar Popup stays focused on connection status and removes duplicate update controls', () => {
  const schedule = popupSource.match(/function scheduleConsentUpdateUi\(\) \{[\s\S]*?\n  \}(?=\n\n  function ensureUpdateSection)/)[0];
  assert.match(schedule, /querySelector\('\.updates'\)\?\.remove\(\)/);
  assert.doesNotMatch(schedule, /sendConsentAction|renderUpdateSection/);
  assert.doesNotMatch(bootstrapPopupMarkup, /class="updates"/);
  assert.doesNotMatch(bootstrapPopupMarkup, /id="check-update"/);
  assert.doesNotMatch(bootstrapPopupMarkup, /<script src="popup\.js"><\/script>/);
  assert.match(bootstrapPopupCss, /html\s*\{[\s\S]*background:/);
  assert.doesNotMatch(bootstrapPopupCss, /@keyframes popup-enter\s*\{[^@]*translateY/);
  assert.match(bootstrapPopupMarkup, /data-popup-context/);
  assert.doesNotMatch(popupSource, /navigator\.language/);
});

test('automatic runtime checks are check-only and installation delegates to the guarded bootstrap executor', () => {
  const automaticCheck = coordinatorSource.match(/async function checkOnly[\s\S]*?\n  }\n\n  async function installUpdate/)[0];
  const installUpdate = coordinatorSource.match(/async function installUpdate[\s\S]*?\n  }\n\n  async function postponeUpdate/)[0];
  assert.match(automaticCheck, /'update\.check'/);
  assert.doesNotMatch(automaticCheck, /'update\.(authorize|stage|apply)'/);
  assert.match(coordinatorSource, /'update\.authorize'/);
  assert.match(coordinatorSource, /recoverInterruptedCheck/);
  assert.match(coordinatorSource, /update_check_timeout/);
  assert.match(coordinatorSource, /consent-update-dismiss/);
  assert.match(installUpdate, /CodexOverleafManagedUpdateExecutor/);
  assert.match(installUpdate, /installAuthorizedUpdate/);
  assert.doesNotMatch(installUpdate, /chrome\.runtime\.sendMessage/);
  assert.match(bootstrapSource, /CodexOverleafManagedUpdateExecutor\s*=\s*Object\.freeze/);
  assert.match(bootstrapSource, /installAuthorizedUpdate:\s*\(\)\s*=>\s*checkAndStage\(\{ manual: true \}\)/);
  assert.match(coordinatorSource, /Number\.MAX_SAFE_INTEGER/);
  assert.match(coordinatorSource, /update_revoke_too_late[\s\S]*return getView\(\)/);
});

test('managed update actions trust exact Overleaf and toolbar senders without a separate update window', () => {
  const senderPolicySource = coordinatorSource.match(
    /function isAllowedSender\(sender\) \{[\s\S]*?\n  \}(?=\n\n  function currentVersion)/
  )[0];
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
