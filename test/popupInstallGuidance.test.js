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
    compatibility.buildBridgePingParams({ version: compatibility.BUILD_TARGET_VERSION })
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
    harness.elements.versionPair.textContent,
    `Extension v${compatibility.BUILD_TARGET_VERSION} / Native v${compatibility.BUILD_TARGET_VERSION}`
  );
  assert.match(harness.elements.status.textContent, /Native host connected/i);
});

test('popup treats an older capability-compatible native response as update-available', async () => {
  const harness = await loadPopupHarness({
    nativeResponse: oldUpdateAvailableNativeResponse()
  });

  assert.equal(harness.elements.nativeInstall.hidden, false);
  assert.equal(harness.elements.compatStatusIcon.textContent, '');
  assert.equal(harness.elements.compatStatusIcon.dataset.status, 'update-available');
  assert.equal(harness.elements.versionPair.textContent, `Extension v${compatibility.BUILD_TARGET_VERSION} / Native v0.9.5`);
  assert.match(harness.elements.status.textContent, /Native host update available/i);
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

test('popup reflects the enabled Overleaf edge button and toggles it', async () => {
  const tabMessages = [];
  const harness = await loadPopupHarness({
    nativeResponse: compatibleNativeResponse(),
    activeTab: {
      id: 42,
      url: 'https://www.overleaf.com/project/example'
    },
    onTabMessage(_tabId, message) {
      tabMessages.push(message);
      if (message.type === 'codex-overleaf/get-panel-state') {
        return { ok: true, open: true, launcherVisible: true };
      }
      if (message.type === 'codex-overleaf/toggle-launcher') {
        return { ok: true, open: false, launcherVisible: false };
      }
      return { ok: false };
    }
  });

  assert.equal(harness.elements.button.textContent, 'Hide Codex edge button');
  assert.match(harness.elements.status.textContent, /edge button appears/i);

  await harness.elements.button.click();

  assert.deepEqual(tabMessages.map(message => message.type), [
    'codex-overleaf/get-panel-state',
    'codex-overleaf/toggle-launcher'
  ]);
  assert.equal(harness.closed, true);
});

test('popup shows an enable action when the Overleaf edge button is hidden', async () => {
  const harness = await loadPopupHarness({
    nativeResponse: compatibleNativeResponse(),
    activeTab: {
      id: 43,
      url: 'https://overleaf.com/project/example'
    },
    onTabMessage(_tabId, message) {
      if (message.type === 'codex-overleaf/get-panel-state') {
        return { ok: true, open: false, launcherVisible: false };
      }
      return { ok: true, open: false, launcherVisible: true };
    }
  });

  assert.equal(harness.elements.button.textContent, 'Show Codex edge button');
  assert.match(harness.elements.status.textContent, /edge button is hidden/i);
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
  const elements = {
    button: createPopupElement('open-panel'),
    status: createPopupElement('status'),
    compatStatusIcon: createPopupElement('compat-status-icon'),
    versionPair: createPopupElement('version-pair'),
    nativeInstall: createPopupElement('native-install', { hidden: true }),
    installCommand: createPopupElement('install-command'),
    copyInstallCommand: createPopupElement('copy-install-command')
  };
  const elementById = {
    'open-panel': elements.button,
    status: elements.status,
    'compat-status-icon': elements.compatStatusIcon,
    'version-pair': elements.versionPair,
    'native-install': elements.nativeInstall,
    'install-command': elements.installCommand,
    'copy-install-command': elements.copyInstallCommand
  };

  const harness = { closed: false };
  const sandbox = {
    chrome: {
      runtime: {
        id: TEST_EXTENSION_ID,
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
    document: {
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
      return listener?.({ preventDefault() {} });
    }
  };
}
