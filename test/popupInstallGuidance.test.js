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

async function loadPopupHarness({ nativeResponse, activeTab = null, onSendMessage, onTabMessage, onClipboardWrite } = {}) {
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
    brandIcon: 'brand-icon', popupStyles: 'popup-styles'
  };
  const elements = Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, createPopupElement(id)]));
  elements.nativeInstall.hidden = true;
  elements.connectionDetails.hidden = true;
  elements.copyFeedback.hidden = true;
  const elementById = Object.fromEntries(Object.values(elements).map(element => [element.id, element]));

  const harness = { closed: false };
  const sandbox = {
    chrome: {
      runtime: {
        id: TEST_EXTENSION_ID,
        getURL: value => 'chrome-extension://' + TEST_EXTENSION_ID + '/' + value,
        getManifest() {
          return { version: compatibility.BUILD_TARGET_VERSION };
        },
        sendMessage(message) {
          if (typeof onSendMessage === 'function') {
            onSendMessage(message);
          }
          return Promise.resolve(nativeResponse);
        }
      },
      storage: { local: { get: async () => ({ codexOverleafGlobalPrefsV1: { values: { locale: 'en', theme: 'dark' } } }) }, onChanged: { addListener() {} } },
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
    id,
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
