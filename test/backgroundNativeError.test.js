const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const compatibility = require('../extension/src/shared/compatibility');
const backgroundPath = path.join(__dirname, '../extension/src/background.js');
const managedUpdateProjectionSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/shared/managedUpdateProjection.js'),
  'utf8'
);

function readBackground() {
  return fs.readFileSync(backgroundPath, 'utf8');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('background blocks side-effecting native requests with non-ok compatibility evidence before posting', async () => {
  const harness = loadBackgroundHarness();
  const sender = {
    tab: {
      id: 101,
      url: 'https://www.overleaf.com/project/abc123'
    }
  };

  const runResponse = harness.sendNative({
    id: 'run-incompatible',
    method: 'codex.run',
    params: {
      task: 'write',
      nativeCompatibility: {
        status: 'native_too_old',
        classification: 'update-available',
        installCommand: compatibility.buildInstallCommand()
      }
    }
  }, sender);

  assert.equal(harness.ports.length, 0);

  const blockedRun = await settleWithin(runResponse);
  assert.equal(blockedRun.ok, false);
  assert.equal(blockedRun.error.code, 'native_update_required');
  assert.equal(blockedRun.error.classification, 'update-available');
  assert.equal(blockedRun.error.currentNativeVersion, undefined);
  assert.equal(blockedRun.error.requiredVersion, compatibility.MIN_COMPATIBLE_NATIVE_VERSION);
  assert.equal(blockedRun.error.recommendedVersion, compatibility.BUILD_TARGET_VERSION);
  assert.equal(blockedRun.error.updateCommand, compatibility.buildInstallCommand());
  assert.match(blockedRun.error.message, /requires native host v1\.0\.0/i);
  assert.match(blockedRun.error.message, new RegExp(`recommended update target is v${escapeRegExp(compatibility.BUILD_TARGET_VERSION)}`, 'i'));
});

test('background blocks side-effecting native requests without compatibility evidence before posting', async () => {
  const harness = loadBackgroundHarness();
  const sender = {
    tab: {
      id: 101,
      url: 'https://www.overleaf.com/project/abc123'
    }
  };

  const runResponse = harness.sendNative({
    id: 'run-no-evidence',
    method: 'codex.run',
    params: { task: 'write' }
  }, sender);

  assert.equal(harness.ports.length, 0);

  const blockedRun = await settleWithin(runResponse);
  assert.equal(blockedRun.ok, false);
  assert.equal(blockedRun.error.code, 'native_update_required');
  assert.equal(blockedRun.error.classification, 'incompatible');
  assert.equal(blockedRun.error.requiredVersion, compatibility.MIN_COMPATIBLE_NATIVE_VERSION);
  assert.equal(blockedRun.error.recommendedVersion, compatibility.BUILD_TARGET_VERSION);
  assert.equal(blockedRun.error.updateCommand, compatibility.buildInstallCommand());
  assert.match(blockedRun.error.message, /requires native host v1\.0\.0/i);
  assert.match(blockedRun.error.message, new RegExp(`recommended update target is v${escapeRegExp(compatibility.BUILD_TARGET_VERSION)}`, 'i'));
});

test('background allows only update-available methods when native evidence is older but capability-compatible', async () => {
  const harness = loadBackgroundHarness();
  const sender = {
    tab: {
      id: 101,
      url: 'https://www.overleaf.com/project/abc123'
    }
  };

  const skillsResponse = harness.sendNative({
    id: 'skills-update-available',
    method: 'skills.list',
    params: withUpdateAvailableNativeCompatibility({})
  }, sender);
  const syncResponse = harness.sendNative({
    id: 'sync-update-available',
    method: 'mirror.sync',
    params: withUpdateAvailableNativeCompatibility({ projectId: 'abc123' })
  }, sender);

  assert.equal(harness.ports.length, 1);
  assert.deepEqual(
    harness.ports[0].messages.map(message => `${message.id}:${message.method}`),
    ['skills-update-available:skills.list']
  );

  harness.ports[0].emitMessage({
    id: 'skills-update-available',
    ok: true,
    result: {
      skills: []
    }
  });

  const skills = await skillsResponse;
  const sync = await settleWithin(syncResponse);
  assert.equal(skills.ok, true);
  assert.equal(sync.ok, false);
  assert.equal(sync.error.code, 'native_update_required');
  assert.equal(sync.error.classification, 'update-available');
  assert.equal(sync.error.currentNativeVersion, '0.9.5');
  assert.equal(sync.error.requiredVersion, compatibility.MIN_COMPATIBLE_NATIVE_VERSION);
  assert.equal(sync.error.recommendedVersion, compatibility.BUILD_TARGET_VERSION);
  assert.equal(sync.error.updateCommand, compatibility.buildInstallCommand());
  assert.match(sync.error.message, /requires native host v1\.0\.0/i);
  assert.match(sync.error.message, new RegExp(`recommended update target is v${escapeRegExp(compatibility.BUILD_TARGET_VERSION)}`, 'i'));
});

test('background blocks codex.cancel when compatibility evidence is incompatible', async () => {
  const harness = loadBackgroundHarness();
  const sender = {
    tab: {
      id: 101,
      url: 'https://www.overleaf.com/project/abc123'
    }
  };

  const cancelResponse = await harness.sendNative({
    id: 'cancel-incompatible',
    method: 'codex.cancel',
    params: {
      requestId: 'run-id',
      nativeCompatibility: {
        status: 'native_too_old',
        classification: 'incompatible',
        nativeVersion: '0.9.4',
        installCommand: compatibility.buildInstallCommand()
      }
    }
  }, sender);

  assert.equal(harness.ports.length, 0);
  assert.equal(cancelResponse.ok, false);
  assert.equal(cancelResponse.error.code, 'native_update_required');
  assert.equal(cancelResponse.error.classification, 'incompatible');
  assert.equal(cancelResponse.error.currentNativeVersion, '0.9.4');
});

test('background allows recoverable native requests without compatibility evidence', async () => {
  const harness = loadBackgroundHarness();
  const sender = {
    tab: {
      id: 101,
      url: 'https://www.overleaf.com/project/abc123'
    }
  };

  const pingResponse = harness.sendNative(
    { id: 'ping-no-evidence', method: 'bridge.ping', params: {} },
    sender
  );
  const statusResponse = harness.sendNative(
    { id: 'status-no-evidence', method: 'mirror.status', params: { projectId: 'abc123' } },
    sender
  );
  const modelsResponse = harness.sendNative(
    { id: 'models-no-evidence', method: 'codex.models', params: {} },
    sender
  );

  assert.equal(harness.ports.length, 1);
  assert.deepEqual(
    harness.ports[0].messages.map(message => `${message.id}:${message.method}`),
    [
      'ping-no-evidence:bridge.ping',
      'status-no-evidence:mirror.status',
      'models-no-evidence:codex.models'
    ]
  );

  harness.ports[0].emitMessage({ id: 'ping-no-evidence', ok: true, result: { version: '0.4.0' } });
  harness.ports[0].emitMessage({ id: 'status-no-evidence', ok: true, result: { status: 'ready' } });
  harness.ports[0].emitMessage({ id: 'models-no-evidence', ok: true, result: { models: [] } });

  assert.equal((await pingResponse).ok, true);
  assert.equal((await statusResponse).ok, true);
  assert.equal((await modelsResponse).ok, true);

  const cancelResponse = await harness.sendNative(
    { id: 'cancel-no-evidence', method: 'codex.cancel', params: { requestId: 'run-id' } },
    sender
  );
  assert.equal(cancelResponse.ok, true);
  assert.deepEqual(
    harness.ports[0].messages.map(message => `${message.id}:${message.method}`),
    [
      'ping-no-evidence:bridge.ping',
      'status-no-evidence:mirror.status',
      'models-no-evidence:codex.models',
      'cancel-no-evidence:codex.cancel'
    ]
  );
});

test('background retries safe status after disconnect while failing codex.run without restart', async () => {
  const harness = loadBackgroundHarness();
  const sender = {
    tab: {
      id: 101,
      url: 'https://www.overleaf.com/project/abc123'
    }
  };

  const statusResponse = harness.sendNative(
    { id: 'status-1', method: 'mirror.status', params: { projectId: 'abc123' } },
    sender
  );
  const runResponse = harness.sendNative(
    { id: 'run-1', method: 'codex.run', params: withOkNativeCompatibility({ task: 'write' }) },
    sender
  );

  assert.equal(harness.ports.length, 1);
  assert.deepEqual(
    harness.ports[0].messages.map(message => message.id),
    ['status-1', 'run-1']
  );

  harness.ports[0].disconnect('Native host disconnected');

  assert.equal(harness.ports.length, 2);
  assert.deepEqual(
    harness.ports[1].messages.map(message => `${message.id}:${message.method}`),
    ['status-1:mirror.status']
  );

  const interruptedRun = await runResponse;
  assert.equal(interruptedRun.ok, false);
  assert.equal(interruptedRun.error.code, 'native_execution_interrupted');
  assert.equal(
    interruptedRun.error.message,
    'Native host disconnected while an execution request was running. The request was not retried to avoid repeating side effects.'
  );

  harness.ports[1].emitMessage({
    id: 'status-1',
    ok: true,
    result: {
      status: 'ready'
    }
  });

  const retriedStatus = await statusResponse;
  assert.equal(retriedStatus.id, 'status-1');
  assert.equal(retriedStatus.ok, true);
  assert.equal(retriedStatus.result.status, 'ready');
});

test('background retries a safe request once when cached native port postMessage throws', async () => {
  const harness = loadBackgroundHarness({
    configurePort(port, index) {
      if (index === 0) {
        port.failNextPostMessage('Stale native port');
      }
    }
  });
  const sender = {
    tab: {
      id: 101,
      url: 'https://www.overleaf.com/project/abc123'
    }
  };

  const statusResponse = harness.sendNative(
    { id: 'status-stale', method: 'mirror.status', params: { projectId: 'abc123' } },
    sender
  );

  assert.equal(harness.ports.length, 2);
  assert.deepEqual(harness.ports[0].messages, []);
  assert.deepEqual(
    harness.ports[1].messages.map(message => `${message.id}:${message.method}`),
    ['status-stale:mirror.status']
  );

  harness.ports[1].emitMessage({
    id: 'status-stale',
    ok: true,
    result: {
      status: 'ready'
    }
  });

  const retriedStatus = await statusResponse;
  assert.equal(retriedStatus.id, 'status-stale');
  assert.equal(retriedStatus.ok, true);
  assert.equal(retriedStatus.result.status, 'ready');
});

test('background does not retry execution requests when native postMessage throws', async () => {
  const harness = loadBackgroundHarness({
    configurePort(port, index) {
      if (index === 0) {
        port.failNextPostMessage('Stale native port');
      }
    }
  });
  const sender = {
    tab: {
      id: 101,
      url: 'https://www.overleaf.com/project/abc123'
    }
  };

  const runResponse = harness.sendNative(
    { id: 'run-stale', method: 'codex.run', params: withOkNativeCompatibility({ task: 'write' }) },
    sender
  );

  assert.equal(harness.ports.length, 1);
  assert.deepEqual(harness.ports[0].messages, []);

  const interruptedRun = await runResponse;
  assert.equal(interruptedRun.ok, false);
  assert.equal(interruptedRun.error.code, 'native_execution_interrupted');
});

test('background scopes no-id native errors through per-request retry policy', async () => {
  const harness = loadBackgroundHarness();
  const sender = {
    tab: {
      id: 101,
      url: 'https://www.overleaf.com/project/abc123'
    }
  };

  const statusResponse = harness.sendNative(
    { id: 'status-bad-frame', method: 'mirror.status', params: { projectId: 'abc123' } },
    sender
  );
  const runResponse = harness.sendNative(
    { id: 'run-bad-frame', method: 'codex.run', params: withOkNativeCompatibility({ task: 'write' }) },
    sender
  );

  assert.deepEqual(
    harness.ports[0].messages.map(message => `${message.id}:${message.method}`),
    ['status-bad-frame:mirror.status', 'run-bad-frame:codex.run']
  );

  harness.ports[0].emitMessage({
    ok: false,
    error: {
      code: 'bad_frame',
      message: 'Native host returned an error without a request id.'
    }
  });

  assert.equal(harness.ports.length, 2);
  assert.deepEqual(
    harness.ports[1].messages.map(message => `${message.id}:${message.method}`),
    ['status-bad-frame:mirror.status']
  );

  const interruptedRun = await runResponse;
  assert.equal(interruptedRun.ok, false);
  assert.equal(interruptedRun.error.code, 'native_execution_interrupted');

  harness.ports[1].emitMessage({
    id: 'status-bad-frame',
    ok: true,
    result: {
      status: 'ready'
    }
  });

  const retriedStatus = await statusResponse;
  assert.equal(retriedStatus.id, 'status-bad-frame');
  assert.equal(retriedStatus.ok, true);
  assert.equal(retriedStatus.result.status, 'ready');
});

test('background ignores explicit unknown native error ids for a single pending request', async () => {
  const harness = loadBackgroundHarness();
  const sender = {
    tab: {
      id: 101,
      url: 'https://www.overleaf.com/project/abc123'
    }
  };

  const statusResponse = harness.sendNative(
    { id: 'status-known', method: 'mirror.status', params: { projectId: 'abc123' } },
    sender
  );

  harness.ports[0].emitMessage({
    id: 'unknown',
    ok: false,
    error: {
      code: 'cancel_failed',
      message: 'Cancel request was not found.'
    }
  });

  await assert.rejects(
    settleWithin(statusResponse),
    /Timed out waiting for native response to settle/
  );
  assert.equal(harness.ports.length, 1);

  harness.ports[0].emitMessage({
    id: 'status-known',
    ok: true,
    result: {
      status: 'ready'
    }
  });

  const status = await statusResponse;
  assert.equal(status.ok, true);
  assert.equal(status.result.status, 'ready');
});

test('background ignores explicit unknown native error ids while multiple requests are pending', async () => {
  const harness = loadBackgroundHarness();
  const sender = {
    tab: {
      id: 101,
      url: 'https://www.overleaf.com/project/abc123'
    }
  };

  const statusResponse = harness.sendNative(
    { id: 'status-known-multi', method: 'mirror.status', params: { projectId: 'abc123' } },
    sender
  );
  const runResponse = harness.sendNative(
    { id: 'run-known-multi', method: 'codex.run', params: withOkNativeCompatibility({ task: 'write' }) },
    sender
  );

  harness.ports[0].emitMessage({
    id: 'unknown',
    ok: false,
    error: {
      code: 'cancel_failed',
      message: 'Cancel request was not found.'
    }
  });

  await assert.rejects(
    settleWithin(statusResponse),
    /Timed out waiting for native response to settle/
  );
  await assert.rejects(
    settleWithin(runResponse),
    /Timed out waiting for native response to settle/
  );
  assert.equal(harness.ports.length, 1);
  assert.deepEqual(
    harness.ports[0].messages.map(message => `${message.id}:${message.method}`),
    ['status-known-multi:mirror.status', 'run-known-multi:codex.run']
  );

  harness.ports[0].emitMessage({
    id: 'status-known-multi',
    ok: true,
    result: {
      status: 'ready'
    }
  });
  harness.ports[0].emitMessage({
    id: 'run-known-multi',
    ok: false,
    error: {
      code: 'native_execution_interrupted',
      message: 'Native host disconnected while an execution request was running.'
    }
  });

  const status = await statusResponse;
  const run = await runResponse;
  assert.equal(status.ok, true);
  assert.equal(status.result.status, 'ready');
  assert.equal(run.ok, false);
  assert.equal(run.error.code, 'native_execution_interrupted');
});

test('background retries all safe requests attached to a port when a later postMessage throws', async () => {
  const harness = loadBackgroundHarness({
    configurePort(port, index) {
      if (index === 0) {
        port.failPostMessageWhen(message => message.id === 'status-new');
      }
    }
  });
  const sender = {
    tab: {
      id: 101,
      url: 'https://www.overleaf.com/project/abc123'
    }
  };

  const oldStatusResponse = harness.sendNative(
    { id: 'status-old', method: 'mirror.status', params: { projectId: 'abc123' } },
    sender
  );
  const newStatusResponse = harness.sendNative(
    { id: 'status-new', method: 'mirror.status', params: { projectId: 'abc123' } },
    sender
  );

  assert.equal(harness.ports.length, 2);
  assert.deepEqual(
    harness.ports[0].messages.map(message => `${message.id}:${message.method}`),
    ['status-old:mirror.status']
  );
  assert.deepEqual(
    harness.ports[1].messages.map(message => `${message.id}:${message.method}`),
    ['status-old:mirror.status', 'status-new:mirror.status']
  );

  harness.ports[1].emitMessage({
    id: 'status-old',
    ok: true,
    result: {
      status: 'old-ready'
    }
  });
  harness.ports[1].emitMessage({
    id: 'status-new',
    ok: true,
    result: {
      status: 'new-ready'
    }
  });

  const oldStatus = await oldStatusResponse;
  const newStatus = await newStatusResponse;
  assert.equal(oldStatus.result.status, 'old-ready');
  assert.equal(newStatus.result.status, 'new-ready');
});

test('background fails older execution request when later safe postMessage throws on same port', async () => {
  const harness = loadBackgroundHarness({
    configurePort(port, index) {
      if (index === 0) {
        port.failPostMessageWhen(message => message.id === 'status-after-run');
      }
    }
  });
  const sender = {
    tab: {
      id: 101,
      url: 'https://www.overleaf.com/project/abc123'
    }
  };

  const runResponse = harness.sendNative(
    { id: 'run-old', method: 'codex.run', params: withOkNativeCompatibility({ task: 'write' }) },
    sender
  );
  const statusResponse = harness.sendNative(
    { id: 'status-after-run', method: 'mirror.status', params: { projectId: 'abc123' } },
    sender
  );

  assert.equal(harness.ports.length, 2);
  assert.deepEqual(
    harness.ports[0].messages.map(message => `${message.id}:${message.method}`),
    ['run-old:codex.run']
  );
  assert.deepEqual(
    harness.ports[1].messages.map(message => `${message.id}:${message.method}`),
    ['status-after-run:mirror.status']
  );

  const interruptedRun = await settleWithin(runResponse);
  assert.equal(interruptedRun.ok, false);
  assert.equal(interruptedRun.error.code, 'native_execution_interrupted');

  harness.ports[1].emitMessage({
    id: 'status-after-run',
    ok: true,
    result: {
      status: 'ready'
    }
  });

  const retriedStatus = await statusResponse;
  assert.equal(retriedStatus.ok, true);
  assert.equal(retriedStatus.result.status, 'ready');
});

test('background fails pending codex.run when cancel postMessage throws on the same stale port', async () => {
  const harness = loadBackgroundHarness({
    configurePort(port, index) {
      if (index === 0) {
        port.failPostMessageWhen(message => message.method === 'codex.cancel');
      }
    }
  });
  const sender = {
    tab: {
      id: 101,
      url: 'https://www.overleaf.com/project/abc123'
    }
  };

  const runResponse = harness.sendNative(
    { id: 'run-cancel-target', method: 'codex.run', params: withOkNativeCompatibility({ task: 'write' }) },
    sender
  );
  const cancelResponse = await harness.sendNative(
    { id: 'cancel-stale', method: 'codex.cancel', params: { requestId: 'run-cancel-target' } },
    sender
  );

  assert.equal(cancelResponse.ok, false);
  assert.equal(cancelResponse.error.code, 'native_connection_failed');
  assert.equal(harness.ports.length, 1);
  assert.deepEqual(
    harness.ports[0].messages.map(message => `${message.id}:${message.method}`),
    ['run-cancel-target:codex.run']
  );

  const interruptedRun = await settleWithin(runResponse);
  assert.equal(interruptedRun.ok, false);
  assert.equal(interruptedRun.error.code, 'native_execution_interrupted');

  const postedRunCount = harness.ports
    .flatMap(port => port.messages)
    .filter(message => message.method === 'codex.run').length;
  assert.equal(postedRunCount, 1);
});

test('background retries pending safe request when cancel postMessage throws on the same stale port', async () => {
  const harness = loadBackgroundHarness({
    configurePort(port, index) {
      if (index === 0) {
        port.failPostMessageWhen(message => message.method === 'codex.cancel');
      }
    }
  });
  const sender = {
    tab: {
      id: 101,
      url: 'https://www.overleaf.com/project/abc123'
    }
  };

  const statusResponse = harness.sendNative(
    { id: 'status-before-cancel', method: 'mirror.status', params: { projectId: 'abc123' } },
    sender
  );
  const cancelResponse = await harness.sendNative(
    { id: 'cancel-stale-safe', method: 'codex.cancel', params: { requestId: 'run-id' } },
    sender
  );

  assert.equal(cancelResponse.ok, false);
  assert.equal(cancelResponse.error.code, 'native_connection_failed');
  assert.equal(harness.ports.length, 2);
  assert.deepEqual(
    harness.ports[0].messages.map(message => `${message.id}:${message.method}`),
    ['status-before-cancel:mirror.status']
  );
  assert.deepEqual(
    harness.ports[1].messages.map(message => `${message.id}:${message.method}`),
    ['status-before-cancel:mirror.status']
  );

  harness.ports[1].emitMessage({
    id: 'status-before-cancel',
    ok: true,
    result: {
      status: 'ready'
    }
  });

  const retriedStatus = await statusResponse;
  assert.equal(retriedStatus.ok, true);
  assert.equal(retriedStatus.result.status, 'ready');
});

function loadBackgroundHarness(options = {}) {
  const ports = [];
  let onMessageListener = null;
  let uuidCounter = 0;

  const chrome = {
    runtime: {
      id: 'extension-id',
      lastError: null,
      getURL(pathname) {
        return `chrome-extension://extension-id/${pathname}`;
      },
      onMessage: {
        addListener(listener) {
          onMessageListener = listener;
        }
      },
      connectNative() {
        const port = createNativePort(chrome);
        ports.push(port);
        if (typeof options.configurePort === 'function') {
          options.configurePort(port, ports.length - 1);
        }
        return port;
      }
    },
    tabs: {
      sendMessage(_tabId, _message, callback) {
        if (typeof callback === 'function') {
          callback();
        }
      }
    }
  };

  const sandbox = {
    chrome,
    crypto: {
      randomUUID() {
        uuidCounter += 1;
        return `uuid-${uuidCounter}`;
      }
    },
    importScripts(...scriptPaths) {
      for (const scriptPath of scriptPaths) {
        if (scriptPath === 'shared/compatibility.js') {
          sandbox.CodexOverleafCompatibility = compatibility;
          continue;
        }
        if (scriptPath === 'shared/managedUpdateProjection.js') {
          vm.runInNewContext(managedUpdateProjectionSource, sandbox);
          continue;
        }
        if (scriptPath === 'shared/nativeRequestIdentity.js') {
          sandbox.CodexOverleafNativeRequestIdentity = require(
            '../extension/src/shared/nativeRequestIdentity'
          );
          continue;
        }
        if (scriptPath === 'shared/globalPreferences.js') {
          sandbox.CodexOverleafGlobalPreferences = require('../extension/src/shared/globalPreferences');
          continue;
        }
        throw new Error(`Unexpected importScripts path: ${scriptPath}`);
      }
    },
    URL
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(readBackground(), sandbox);

  assert.equal(typeof onMessageListener, 'function');

  return {
    ports,
    sendNative(payload, sender) {
      return new Promise(resolve => {
        onMessageListener({
          type: 'codex-overleaf/native-request',
          payload
        }, sender, resolve);
      });
    }
  };
}

function createNativePort(chrome) {
  const messageListeners = [];
  const disconnectListeners = [];
  const postMessageFailures = [];
  const postMessageFailurePredicates = [];

  return {
    messages: [],
    onMessage: {
      addListener(listener) {
        messageListeners.push(listener);
      }
    },
    onDisconnect: {
      addListener(listener) {
        disconnectListeners.push(listener);
      }
    },
    postMessage(message) {
      if (postMessageFailures.length > 0) {
        throw postMessageFailures.shift();
      }
      const failureIndex = postMessageFailurePredicates.findIndex(predicate => predicate(message));
      if (failureIndex !== -1) {
        postMessageFailurePredicates.splice(failureIndex, 1);
        throw new Error('Native postMessage failed');
      }
      this.messages.push(message);
    },
    failNextPostMessage(message = 'Native postMessage failed') {
      postMessageFailures.push(new Error(message));
    },
    failPostMessageWhen(predicate) {
      postMessageFailurePredicates.push(predicate);
    },
    emitMessage(message) {
      for (const listener of messageListeners) {
        listener(message);
      }
    },
    disconnect(message = 'Native host disconnected') {
      chrome.runtime.lastError = { message };
      for (const listener of disconnectListeners) {
        listener();
      }
      chrome.runtime.lastError = null;
    }
  };
}

function settleWithin(promise) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('Timed out waiting for native response to settle.')), 20);
    })
  ]);
}

function withOkNativeCompatibility(params = {}) {
  return {
    ...params,
    nativeCompatibility: {
      status: 'ok',
      classification: 'compatible',
      installCommand: compatibility.buildInstallCommand()
    }
  };
}

function withUpdateAvailableNativeCompatibility(params = {}) {
  return {
    ...params,
    nativeCompatibility: {
      status: 'native_too_old',
      classification: 'update-available',
      nativeVersion: '0.9.5',
      minimumNativeVersion: compatibility.MIN_COMPATIBLE_NATIVE_VERSION,
      requiredVersion: compatibility.MIN_COMPATIBLE_NATIVE_VERSION,
      recommendedVersion: compatibility.BUILD_TARGET_VERSION,
      installCommand: compatibility.buildInstallCommand()
    }
  };
}
