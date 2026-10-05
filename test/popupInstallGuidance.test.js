const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const compatibility = require('../extension/src/shared/compatibility');
const TEST_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

test('popup sends compatibility-aware bridge ping params', async () => {
  let sentMessage = null;
  await loadPopupHarness({
    nativeResponse: compatibleNativeResponse(),
    onSendMessage(message) {
      sentMessage = message;
    }
  });

  assert.equal(sentMessage?.payload?.method, 'bridge.ping');
  assert.deepEqual(
    JSON.parse(JSON.stringify(sentMessage?.payload?.params)),
    compatibility.buildBridgePingParams({ version: compatibility.BUILD_TARGET_VERSION, extensionId: TEST_EXTENSION_ID })
  );
});

test('popup shows version pair and compatible status when native host is current', async () => {
  const harness = await loadPopupHarness({
    nativeResponse: compatibleNativeResponse()
  });

  assert.equal(harness.elements.nativeInstall.hidden, true);
  assert.equal(harness.elements.compatStatusIcon.textContent, '');
  assert.equal(harness.elements.compatStatusIcon.dataset.status, 'compatible');
  assert.equal(
    harness.elements.extensionVersion.textContent,
    `v${compatibility.BUILD_TARGET_VERSION}`
  );
  assert.equal(harness.elements.nativeVersion.textContent, `v${compatibility.BUILD_TARGET_VERSION}`);
  assert.equal(harness.elements.connectionLabel.textContent, 'Connected');
  await harness.elements.connectionToggle.click();
  assert.equal(harness.elements.connectionDetails.hidden, false);
  assert.equal(harness.elements.connectionToggle.attributes['aria-expanded'], 'true');
});

test('popup treats an older capability-compatible native response as update-available', async () => {
  const harness = await loadPopupHarness({
    nativeResponse: oldUpdateAvailableNativeResponse()
  });

  assert.equal(harness.elements.nativeInstall.hidden, false);
  assert.equal(harness.elements.compatStatusIcon.textContent, '');
  assert.equal(harness.elements.compatStatusIcon.dataset.status, 'update-available');
  assert.equal(harness.elements.extensionVersion.textContent, `v${compatibility.BUILD_TARGET_VERSION}`);
  assert.equal(harness.elements.nativeVersion.textContent, 'v0.9.5');
  assert.equal(harness.elements.connectionLabel.textContent, 'Update available');
  assert.match(harness.elements.nativeStatusMessage.textContent, /update is available for the local bridge/i);
  assert.equal(
    harness.elements.installCommand.textContent,
    compatibility.buildInstallCommand(compatibility.BUILD_TARGET_VERSION, 'darwin', TEST_EXTENSION_ID)
  );
});

test('popup shows platform-specific Windows update command for incompatible native responses', async () => {
  const harness = await loadPopupHarness({
    nativeResponse: incompatibleWindowsNativeResponse()
  });

  assert.equal(harness.elements.nativeInstall.hidden, false);
  assert.equal(harness.elements.compatStatusIcon.textContent, '');
  assert.equal(harness.elements.compatStatusIcon.dataset.status, 'incompatible');
  assert.equal(
    harness.elements.installCommand.textContent,
    compatibility.buildInstallCommand(compatibility.BUILD_TARGET_VERSION, 'win32', TEST_EXTENSION_ID)
  );
});

test('popup copies the currently displayed update command', async () => {
  let copied = '';
  const harness = await loadPopupHarness({
    nativeResponse: incompatibleWindowsNativeResponse(),
    onClipboardWrite(text) {
      copied = text;
    }
  });

  await harness.elements.copyInstallCommand.click();

  assert.equal(copied, harness.elements.installCommand.textContent);
  assert.equal(harness.elements.copyInstallCommand.textContent, 'Copy install command');
});

test('popup reflects the enabled Overleaf edge button and toggles it without changing panel visibility', async () => {
  const tabMessages = [];
  let launcherVisible = true;
  const panelOpen = true;
  const harness = await loadPopupHarness({
    nativeResponse: compatibleNativeResponse(),
    activeTab: { id: 42, url: 'https://www.overleaf.com/project/example' },
    onTabMessage(_tabId, message) {
      tabMessages.push(message);
      if (message.type === 'codex-overleaf/get-panel-state') return { ok: true, open: panelOpen, launcherVisible };
      if (message.type === 'codex-overleaf/toggle-launcher') {
        launcherVisible = !launcherVisible;
        return { ok: true, open: panelOpen, launcherVisible };
      }
      throw new Error('Unexpected panel mutation: ' + message.type);
    }
  });
  assert.equal(harness.elements.launcherToggle.checked, true);
  assert.equal(harness.elements.launcherToggle.disabled, false);
  await harness.elements.launcherToggle.change(false);
  assert.deepEqual(tabMessages.map(message => message.type), [
    'codex-overleaf/get-panel-state', 'codex-overleaf/get-panel-state',
    'codex-overleaf/toggle-launcher', 'codex-overleaf/get-panel-state'
  ]);
  assert.equal(harness.elements.launcherToggle.checked, false);
  assert.equal(harness.elements.launcherToggle.disabled, false);
  assert.equal(launcherVisible, false);
  assert.equal(panelOpen, true);
  assert.equal(harness.closed, false);
});

test('popup enables a hidden Overleaf edge button without opening the panel', async () => {
  let launcherVisible = false;
  const tabMessages = [];
  const harness = await loadPopupHarness({
    nativeResponse: compatibleNativeResponse(),
    activeTab: { id: 43, url: 'https://overleaf.com/project/example' },
    onTabMessage(_tabId, message) {
      tabMessages.push(message.type);
      if (message.type === 'codex-overleaf/toggle-launcher') launcherVisible = !launcherVisible;
      else assert.equal(message.type, 'codex-overleaf/get-panel-state');
      return { ok: true, open: false, launcherVisible };
    }
  });
  assert.equal(harness.elements.launcherToggle.checked, false);
  assert.equal(harness.elements.launcherToggle.disabled, false);
  await harness.elements.launcherToggle.change(true);
  assert.equal(harness.elements.launcherToggle.checked, true);
  assert.equal(launcherVisible, true);
  assert.deepEqual(tabMessages, [
    'codex-overleaf/get-panel-state', 'codex-overleaf/get-panel-state',
    'codex-overleaf/toggle-launcher', 'codex-overleaf/get-panel-state'
  ]);
  assert.equal(harness.closed, false);
});

function compatibleNativeResponse() {
  return {
    ok: true,
    result: {
      host: 'com.codex.overleaf',
      platform: 'darwin',
      version: compatibility.BUILD_TARGET_VERSION,
      protocolVersion: 1,
      supportedProtocol: { min: 1, max: 1 },
      capabilities: Object.fromEntries(
        compatibility.REQUIRED_CAPABILITIES.map(capability => [capability, true])
      ),
      minExtensionVersion: '0.9.5',
      environment: {
        codex: { ok: true }
      }
    }
  };
}

function oldUpdateAvailableNativeResponse() {
  return {
    ok: true,
    result: {
      host: 'com.codex.overleaf',
      platform: 'darwin',
      version: '0.9.5',
      protocolVersion: 1,
      supportedProtocol: { min: 1, max: 1 },
      capabilities: Object.fromEntries(
        compatibility.UPDATE_AVAILABLE_CAPABILITIES.map(capability => [capability, true])
      ),
      minExtensionVersion: '0.9.5',
      environment: {
        codex: { ok: true }
      }
    }
  };
}

function incompatibleWindowsNativeResponse() {
  return {
    ok: true,
    result: {
      host: 'com.codex.overleaf',
      platform: 'win32',
      version: '0.9.5',
      protocolVersion: 1,
      supportedProtocol: { min: 1, max: 1 },
      capabilities: {
        bridgePing: true,
        mirrorStatus: true
      },
      minExtensionVersion: '0.9.5',
      environment: {
        codex: { ok: true }
      }
    }
  };
}

async function loadPopupHarness({ nativeResponse, activeTab = null, onSendMessage, onTabMessage, onClipboardWrite, managed = false, marker = null, locale = 'en', newSiteMatches = [] } = {}) {
  const compatibilitySource = fs.readFileSync(
    path.join(__dirname, '../extension/src/shared/compatibility.js'),
    'utf8'
  );
  const popupSource = fs.readFileSync(
    path.join(__dirname, '../extension/src/popup.js'),
    'utf8'
  );
  const ids = {
    launcherToggle: 'launcher-toggle', status: 'status', compatStatusIcon: 'compat-status-icon',
    versionPair: 'version-pair', extensionVersion: 'extension-version', nativeVersion: 'native-version',
    connectionLabel: 'connection-label', connectionToggle: 'connection-toggle', connectionDetails: 'connection-details',
    nativeInstall: 'native-install', nativeStatusMessage: 'native-status-message',
    installCommand: 'install-command', copyInstallCommand: 'copy-install-command', copyFeedback: 'copy-feedback',
    launcherLabel: 'launcher-label', launcherDescription: 'launcher-description',
    extensionVersionLabel: 'extension-version-label', nativeInstallTitle: 'native-install-title',
    brandIcon: 'brand-icon', popupStyles: 'popup-styles', popupShell: 'popup-shell'
  };
  const elements = Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, createPopupElement(id)]));
  elements.nativeInstall.hidden = true;
  elements.connectionDetails.hidden = true;
  elements.copyFeedback.hidden = true;
  const elementById = Object.fromEntries(Object.values(elements).map(element => [element.id, element]));

  const harness = { closed: false, permissionRequests: 0 };
  const sandbox = {
    chrome: {
      runtime: {
        id: TEST_EXTENSION_ID,
        getURL: value => 'chrome-extension://' + TEST_EXTENSION_ID + '/' + value,
        getManifest() {
          return { version: compatibility.BUILD_TARGET_VERSION, ...(managed ? { background: { service_worker: 'bootstrap/background.js' } } : {}) };
        },
        sendMessage(message) {
          if (typeof onSendMessage === 'function') {
            onSendMessage(message);
          }
          return Promise.resolve(nativeResponse);
        }
      },
      storage: { local: { get: async () => ({ codexOverleafGlobalPrefsV1: { values: { locale, theme: 'dark' } } }) }, onChanged: { addListener(listener) {
        harness.changeLocale = nextLocale => listener({ codexOverleafGlobalPrefsV1: { newValue: { values: { locale: nextLocale, theme: 'dark' } } } }, 'local');
      } } },
      ...(newSiteMatches.length ? { permissions: { contains: async () => false, request: async () => { harness.permissionRequests += 1; return false; } } } : {}),
      tabs: {
        query() {
          return Promise.resolve(activeTab ? [activeTab] : []);
        },
        sendMessage(tabId, message) {
          if (typeof onTabMessage === 'function') {
            return Promise.resolve(onTabMessage(tabId, message));
          }
          return Promise.resolve();
        }
      }
    },
    fetch: async url => {
      if (String(url).endsWith('/runtime-manifest.json')) return { ok: true, json: async () => ({ matches: newSiteMatches }) };
      assert.equal(url, 'chrome-extension://' + TEST_EXTENSION_ID + '/.codex-overleaf-managed-extension.json');
      return { ok: Boolean(marker), json: async () => marker };
    },
    crypto: {
      randomUUID() {
        return 'popup-request-id';
      }
    },
    URL,
    document: {
      documentElement: createPopupElement('html'),
      body: createPopupElement('body'),
      querySelector() { return null; },
      createElement(tag) { return createPopupElement(tag); },
      getElementById(id) {
        return elementById[id] || null;
      }
    },
    navigator: {
      clipboard: {
        writeText(text) {
          if (typeof onClipboardWrite === 'function') {
            onClipboardWrite(text);
          }
          return Promise.resolve();
        }
      }
    },
    setTimeout(callback) {
      callback();
      return 1;
    },
    clearTimeout() {},
    console
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.close = () => {
    harness.closed = true;
  };

  vm.runInNewContext(`${compatibilitySource}\n${popupSource}`, sandbox);
  await new Promise(resolve => setImmediate(resolve));
  await Promise.resolve();
  await Promise.resolve();

  harness.elements = elements;
  return harness;
}

function createPopupElement(id, options = {}) {
  const listeners = new Map();
  return {
    id, children: [],
    append(...children) { this.children.push(...children); },
    hidden: options.hidden === true,
    textContent: '',
    className: '',
    checked: false, disabled: false,
    classList: { values: new Set(), add(value) { this.values.add(value); }, remove(value) { this.values.delete(value); }, contains(value) { return this.values.has(value); } },
    title: '',
    dataset: {},
    attributes: {},
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    click() {
      const listener = listeners.get('click');
      return listener?.({ preventDefault() {}, target: this, currentTarget: this });
    },
    change(checked) {
      this.checked = checked;
      return listeners.get('change')?.({ target: this, currentTarget: this });
    }
  };
}

for (const platform of ['darwin', 'win32']) test('Managed repair retains original install identity when Native is unavailable: ' + platform, async () => {
  const managedRoot = platform === 'win32' ? "C:\\Users\\Alice's 100%\\Managed" : "/tmp/Alice's $HOME `name`/Managed";
  const h = await loadPopupHarness({ managed: true, nativeResponse: { ok: false }, marker: {
    managedBy: 'codex-overleaf-link', kind: 'extension', bootstrapProtocol: 3,
    installIdentity: { managedRoot, browser: 'chromium', extensionId: TEST_EXTENSION_ID, platform }
  } });
  assert.match(h.elements.installCommand.textContent, / -- install-managed /);
  assert.match(h.elements.installCommand.textContent, /--browser chromium/);
  assert.ok(h.elements.installCommand.textContent.includes('--extension-id ' + TEST_EXTENSION_ID));
  assert.ok(h.elements.installCommand.textContent.includes('--managed-root '));
  assert.doesNotMatch(h.elements.installCommand.textContent, /install-native/);
  assert.equal(h.elements.copyInstallCommand.disabled, false);
  if (platform === 'win32') assert.match(h.elements.nativeStatusMessage.textContent, /PowerShell/);
});
for (const marker of [null, { managedBy: 'codex-overleaf-link', kind: 'extension' },
  { managedBy: 'codex-overleaf-link', kind: 'extension', installIdentity: { managedRoot: '/tmp/original', browser: 'chrome', extensionId: 'wrong' } }]) {
  test('older/mismatched Managed identity never silently generates a Direct or default-root repair', async () => {
    let copied = false;
    const h = await loadPopupHarness({ managed: true, marker, nativeResponse: { ok: false }, onClipboardWrite() { copied = true; } });
    assert.equal(h.elements.installCommand.textContent, ''); assert.equal(h.elements.copyInstallCommand.disabled, true);
    assert.match(h.elements.nativeStatusMessage.textContent, /original.*managed.*root|managed.*original.*root/i);
    await h.elements.copyInstallCommand.click(); assert.equal(copied, false);
  });
}


test('popup refreshes existing launcher and clipboard failure copy in both locale directions', async () => {
  const h = await loadPopupHarness({ locale: 'zh', nativeResponse: { ok: false }, onClipboardWrite() { throw new Error('clipboard unavailable'); } });
  await h.elements.copyInstallCommand.click();
  assert.equal(h.elements.status.textContent, '打开 Overleaf 项目页后可设置侧边入口。');
  assert.match(h.elements.copyFeedback.textContent, /复制失败/);
  h.changeLocale('en');
  assert.equal(h.elements.status.textContent, 'Open an Overleaf project to change this preference.');
  assert.equal(h.elements.copyFeedback.textContent, 'Copy failed. Select the command above to copy it.');
  h.changeLocale('zh');
  assert.equal(h.elements.status.textContent, '打开 Overleaf 项目页后可设置侧边入口。');
  assert.match(h.elements.copyFeedback.textContent, /复制失败/);
});

test('popup refreshes an existing new-site permission prompt without changing its hosts or requesting permission', async () => {
  const h = await loadPopupHarness({ locale: 'zh', nativeResponse: compatibleNativeResponse(), newSiteMatches: ['https://new.overleaf.com/project/*'] });
  const [title, detail, button] = h.elements.popupShell.children[0].children;
  assert.equal(button.textContent, '允许');
  h.changeLocale('en');
  assert.equal(title.textContent, 'This version supports another Overleaf site');
  assert.equal(button.textContent, 'Allow');
  assert.equal(detail.textContent, 'Allow access to new.overleaf.com to use Codex there. Chrome will ask you to confirm.');
  h.changeLocale('zh');
  assert.equal(button.textContent, '允许');
  assert.match(detail.textContent, /允许访问 new.overleaf.com/);
  assert.equal(h.permissionRequests, 0);
});

test('popup locale refresh retains Managed repair guidance and Windows shell instructions', async () => {
  const missing = await loadPopupHarness({ locale: 'en', managed: true, nativeResponse: { ok: false } });
  missing.changeLocale('zh');
  assert.match(missing.elements.nativeStatusMessage.textContent, /原管理根目录、浏览器和扩展 ID/);
  assert.equal(missing.elements.installCommand.textContent, '');
  const win = await loadPopupHarness({ locale: 'zh', managed: true, nativeResponse: { ok: false }, marker: {
    managedBy: 'codex-overleaf-link', kind: 'extension', installIdentity: { managedRoot: 'C:\\Managed', browser: 'chrome', extensionId: TEST_EXTENSION_ID, platform: 'win32' }
  } });
  win.changeLocale('en');
  assert.match(win.elements.nativeStatusMessage.textContent, /Run the command in PowerShell/);
});

test('popup locale refresh preserves unknown external failure details', async () => {
  const detail = '诊断原文：unrecognized external failure';
  const h = await loadPopupHarness({ locale: 'zh', nativeResponse: compatibleNativeResponse(), activeTab: { id: 42, url: 'https://www.overleaf.com/project/example' },
    onTabMessage(_id, message) { return message.type === 'codex-overleaf/toggle-launcher' ? { ok: false, error: { message: detail } } : { launcherVisible: false }; }
  });
  await h.elements.launcherToggle.change(true);
  assert.equal(h.elements.status.textContent, detail);
  h.changeLocale('en');
  assert.equal(h.elements.status.textContent, detail);
});
