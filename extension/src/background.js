if (!globalThis.CodexOverleafCompatibility) {
  importScripts('shared/compatibility.js');
}

(function initBackground() {
  'use strict';

  const HOST_NAME = 'com.codex.overleaf';
  const COMPATIBILITY_REQUIRED_METHODS = new Set([
    'codex.run',
    'task.run',
    'task.confirm',
    'mirror.sync',
    'mirror.patchFiles',
    'mirror.confirmWriteback',
    'mirror.scanSensitive',
    'codex.history.clearPlugin',
    'codex.providers.list',
    'codex.providers.test',
    'codex.providers.test.cancel',
    'codex.providers.upsert',
    'codex.providers.activate',
    'codex.providers.clear-secret',
    'codex.providers.delete',
    'skills.list',
    'skills.install',
    'skills.remove'
  ]);
  const RECOVERABLE_COMPATIBILITY_METHODS = new Set([
    'bridge.ping',
    'mirror.status',
    'codex.models',
    'codex.cancel'
  ]);
  const CodexOverleafCompatibility = globalThis.CodexOverleafCompatibility;
  let port = null;
  const pending = new Map();
  globalThis.CodexOverleafNativeBridge = Object.freeze({
    requestInternal: payload => sendNativeRequest(payload, null, { skipCompatibility: true }),
    getPendingState: () => ({
      executionRequests: Array.from(pending.values()).filter(item => item.retryClass === 'no_silent_retry').length,
      totalRequests: pending.size
    })
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'codex-overleaf/native-request') {
      return undefined;
    }

    if (!isAllowedOverleafSender(sender)) {
      sendResponse({
        ok: false,
        error: {
          code: 'forbidden_sender',
          message: 'Native requests are only accepted from Overleaf project pages.'
        }
      });
      return undefined;
    }

    if (message.payload?.method === 'codex.cancel') {
      const compatibilityBlock = getNativeCompatibilityBlock(message.payload);
      if (compatibilityBlock) {
        sendResponse({
          ok: false,
          error: compatibilityBlock
        });
        return undefined;
      }

      try {
        const id = sendNativeCancel(message.payload);
        sendResponse({
          ok: true,
          result: {
            sent: true,
            id
          }
        });
      } catch (error) {
        sendResponse({
          ok: false,
          error: {
            code: 'native_connection_failed',
            message: getErrorMessage(error, 'Native host request failed.')
          }
        });
      }
      return undefined;
    }

    sendNativeRequest(message.payload, sender)
      .then(result => sendResponse(result))
      .catch(error => {
        const userFacingError = toUserFacingNativeError(error);
        sendResponse({
          ok: false,
          error: userFacingError
        });
      });

    return true;
  });

  function getNativeRetryClass(method) {
    switch (method) {
      case 'bridge.ping':
        return 'safe_read_retry';
      case 'mirror.status':
        return 'safe_read_retry';
      case 'mirror.scanSensitive':
        return 'safe_read_retry';
      case 'mirror.sync':
        return 'safe_sync_retry';
      case 'mirror.patchFiles':
        return 'safe_sync_retry';
      case 'mirror.confirmWriteback':
        return 'safe_sync_retry';
      case 'codex.cancel':
        return 'best_effort';
      case 'codex.run':
        return 'no_silent_retry';
      case 'task.run':
        return 'no_silent_retry';
      case 'task.confirm':
        return 'no_silent_retry';
      default:
        return 'no_silent_retry';
    }
  }

  function sendNativeRequest(payload, sender, options = {}) {
    const id = payload.id || crypto.randomUUID();
    const requestWithEvidence = { ...payload, id };
    const compatibilityBlock = options.skipCompatibility ? null : getNativeCompatibilityBlock(requestWithEvidence);
    if (compatibilityBlock) {
      return Promise.resolve({
        ok: false,
        error: compatibilityBlock
      });
    }
    const request = sanitizeNativeRequest(requestWithEvidence);

    return new Promise((resolve, reject) => {
      const pendingRequest = {
        resolve,
        reject,
        tabId: sender?.tab?.id,
        request,
        method: request.method,
        retryClass: getNativeRetryClass(request.method),
        retryCount: 0,
        nativePort: null,
        finalResponseReceived: false,
        eventForwarded: false
      };
      pending.set(id, pendingRequest);

      try {
        postNativeRequest(pendingRequest);
      } catch (error) {
        handleNativePostFailure(id, pendingRequest, error);
      }
    });
  }

  function getNativeCompatibilityBlock(request = {}) {
    const evidence = getNativeCompatibilityEvidence(request);
    if (!evidence) {
      if (COMPATIBILITY_REQUIRED_METHODS.has(request.method)) {
        return createNativeUpdateRequiredBlock(request.method, {
          status: 'unknown_native',
          classification: 'incompatible'
        });
      }
      return null;
    }

    if (isNativeMethodAllowedByCompatibility(request.method, evidence)) {
      return null;
    }

    const status = getNativeCompatibilityStatus(evidence);
    return createNativeUpdateRequiredBlock(request.method, evidence, status);
  }

  function isNativeMethodAllowedByCompatibility(method, evidence) {
    if (!CodexOverleafCompatibility || typeof CodexOverleafCompatibility.isNativeMethodAllowed !== 'function') {
      return true;
    }

    if (!COMPATIBILITY_REQUIRED_METHODS.has(method) && !RECOVERABLE_COMPATIBILITY_METHODS.has(method)) {
      return CodexOverleafCompatibility.isNativeMethodAllowed(method, evidence);
    }

    return CodexOverleafCompatibility.isNativeMethodAllowed(method, evidence);
  }

  function getNativeCompatibilityEvidence(request = {}) {
    const params = request.params;
    if (!params || typeof params !== 'object') {
      return null;
    }
    return params.nativeCompatibility || params.compatibilityStatus || params.compatibility || null;
  }

  function getNativeCompatibilityStatus(evidence) {
    if (typeof evidence === 'string') {
      return evidence;
    }
    return evidence?.status || evidence?.classification || 'native_missing';
  }

  function getNativeCompatibilityClassification(evidence) {
    if (typeof evidence === 'string') {
      return isNativeCompatibilityClassification(evidence)
        ? evidence
        : evidence === 'ok'
          ? 'compatible'
          : 'incompatible';
    }
    if (isNativeCompatibilityClassification(evidence?.classification)) {
      return evidence.classification;
    }
    if (isNativeCompatibilityClassification(evidence?.status)) {
      return evidence.status;
    }
    return evidence?.status === 'ok' ? 'compatible' : 'incompatible';
  }

  function isNativeCompatibilityClassification(status) {
    return status === 'compatible' || status === 'update-available' || status === 'incompatible';
  }

  function createNativeUpdateRequiredBlock(method, evidence = {}, status = getNativeCompatibilityStatus(evidence)) {
    const classification = getNativeCompatibilityClassification(evidence);
    const requiredVersion = getNativeRequiredVersion(evidence);
    const recommendedVersion = getNativeRecommendedVersion(evidence);
    const updateCommand = getNativeUpdateCommand(evidence);
    const currentNativeVersion = getCurrentNativeVersion(evidence);
    return {
      code: 'native_update_required',
      message: formatNativeCompatibilityBlockMessage(status, requiredVersion, recommendedVersion),
      method,
      status,
      classification,
      updateCommand,
      installCommand: updateCommand,
      currentNativeVersion,
      requiredVersion,
      recommendedVersion,
      releaseUrl: evidence?.releaseUrl || CodexOverleafCompatibility?.buildReleaseUrl?.(recommendedVersion)
    };
  }

  function getNativeRequiredVersion(evidence = {}) {
    return evidence.requiredVersion ||
      evidence.minimumNativeVersion ||
      CodexOverleafCompatibility?.MIN_COMPATIBLE_NATIVE_VERSION ||
      '1.0.0';
  }

  function getNativeRecommendedVersion(evidence = {}) {
    return evidence.recommendedVersion ||
      CodexOverleafCompatibility?.BUILD_TARGET_VERSION ||
      getNativeRequiredVersion(evidence);
  }

  function getCurrentNativeVersion(evidence = {}) {
    return evidence.currentNativeVersion ||
      evidence.nativeVersion ||
      evidence.native?.version;
  }

  function getNativeUpdateCommand(evidence = {}) {
    const command = CodexOverleafCompatibility?.buildInstallCommand?.(
      getNativeRecommendedVersion(evidence),
      evidence.native?.platform || evidence.platform,
      getCurrentExtensionId()
    );
    if (command) {
      return command;
    }
    return evidence.updateCommand || evidence.installCommand;
  }

  function getCurrentExtensionId() {
    return typeof chrome === 'object' && chrome?.runtime?.id
      ? chrome.runtime.id
      : '';
  }

  function sanitizeNativeRequest(request) {
    if (!request?.params || typeof request.params !== 'object') {
      return request;
    }
    const { nativeCompatibility, compatibilityStatus, compatibility, ...params } = request.params;
    if (!nativeCompatibility && !compatibilityStatus && !compatibility) {
      return request;
    }
    return {
      ...request,
      params
    };
  }

  function formatNativeCompatibilityBlockMessage(status, requiredVersion, recommendedVersion = requiredVersion) {
    switch (status) {
      case 'extension_too_old':
        return 'Extension update required before this request can run. Update the Chrome extension and try again.';
      case 'protocol_unsupported':
        return 'Native host protocol mismatch. Update the extension and native host together, then try again.';
      case 'native_unhealthy':
        return 'Native host responded, but the local Codex environment is not healthy enough to run this request.';
      case 'native_missing':
        return 'Native host is not connected. Install the local native host, reload the extension, and try again.';
      default:
        if (recommendedVersion && recommendedVersion !== requiredVersion) {
          return `This operation requires native host v${requiredVersion} or later. The recommended update target is v${recommendedVersion}. Run the update command to upgrade.`;
        }
        return `This operation requires native host v${requiredVersion} or later. Run the update command to upgrade.`;
    }
  }

  function sendNativeCancel(payload) {
    const nativePort = ensurePort();
    const id = payload.id || crypto.randomUUID();
    const request = sanitizeNativeRequest({ ...payload, id });
    try {
      nativePort.postMessage(request);
    } catch (error) {
      handleNativeConnectionFailure(
        nativePort,
        getErrorMessage(error, 'Native host connection failed.')
      );
      throw error;
    }
    return id;
  }

  function postNativeRequest(pendingRequest) {
    const nativePort = ensurePort();
    pendingRequest.nativePort = nativePort;
    nativePort.postMessage(pendingRequest.request);
  }

  function ensurePort() {
    if (port) {
      return port;
    }

    const nativePort = chrome.runtime.connectNative(HOST_NAME);
    port = nativePort;
    nativePort.onMessage.addListener(message => {
      if (nativePort !== port) {
        return;
      }

      const id = message?.id;
      if (!pending.has(id)) {
        if (message?.ok === false && isMissingNativeRequestId(id)) {
          resolveUnmatchedNativeError(message);
        }
        return;
      }
      const pendingRequest = pending.get(id);
      if (message?.event) {
        pendingRequest.eventForwarded = (
          forwardNativeEvent(pendingRequest.tabId, id, message.event) ||
          pendingRequest.eventForwarded
        );
        return;
      }
      pendingRequest.finalResponseReceived = true;
      pending.delete(id);
      pendingRequest.resolve(message);
    });
    nativePort.onDisconnect.addListener(() => {
      if (nativePort !== port) {
        return;
      }

      const error = chrome.runtime.lastError?.message || 'Native host disconnected';
      handlePortDisconnect(error);
    });

    return port;
  }

  function handlePortDisconnect(errorMessage) {
    handleNativeConnectionFailure(port, errorMessage);
  }

  function handleNativeConnectionFailure(failedPort, errorMessage) {
    if (!failedPort || port === failedPort) {
      port = null;
    }

    const interruptedRequests = Array.from(pending.entries()).filter(([_pendingId, pendingRequest]) => {
      return !failedPort || pendingRequest.nativePort === failedPort;
    });
    for (const [pendingId, pendingRequest] of interruptedRequests) {
      if (!pending.has(pendingId)) {
        continue;
      }

      if (canRetryNativeRequest(pendingRequest)) {
        retryNativeRequest(pendingId, pendingRequest);
        continue;
      }

      rejectInterruptedNativeRequest(pendingId, pendingRequest, errorMessage);
    }
  }

  function retryNativeRequest(pendingId, pendingRequest) {
    pendingRequest.retryCount += 1;
    try {
      postNativeRequest(pendingRequest);
    } catch (error) {
      handleNativePostFailure(pendingId, pendingRequest, error);
    }
  }

  function handleNativePostFailure(pendingId, pendingRequest, error) {
    handleNativeConnectionFailure(
      pendingRequest.nativePort || port,
      getErrorMessage(error, 'Native host connection failed.')
    );
  }

  function rejectInterruptedNativeRequest(pendingId, pendingRequest, errorMessage) {
    pending.delete(pendingId);
    if (pendingRequest.retryClass === 'no_silent_retry') {
      pendingRequest.reject(createNativeRequestError(
        'native_execution_interrupted',
        'Native host disconnected while an execution request was running. The request was not retried to avoid repeating side effects.'
      ));
      return;
    }

    pendingRequest.reject(createNativeRequestError(
      'native_connection_failed',
      errorMessage || 'Native host disconnected'
    ));
  }

  function canRetryNativeRequest(pendingRequest) {
    if (pendingRequest.retryCount >= 1 || pendingRequest.finalResponseReceived) {
      return false;
    }

    return (
      pendingRequest.retryClass === 'safe_read_retry' ||
      pendingRequest.retryClass === 'safe_sync_retry'
    );
  }

  function resolveUnmatchedNativeError(message) {
    if (pending.size === 1) {
      const [pendingId, pendingRequest] = pending.entries().next().value;
      pendingRequest.finalResponseReceived = true;
      pendingRequest.resolve({
        ...message,
        id: pendingId
      });
      pending.delete(pendingId);
      return;
    }

    const ambiguousRequests = Array.from(pending.entries());
    if (ambiguousRequests.length > 0) {
      handlePortDisconnect(getUnmatchedNativeErrorMessage(message));
    }
  }

  function getUnmatchedNativeErrorMessage(message) {
    return getErrorMessage(
      message?.error || message,
      'Native host returned an error without a request id while multiple requests were pending.'
    );
  }

  function isMissingNativeRequestId(id) {
    return id === undefined || id === null || id === '';
  }

  function createNativeRequestError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function toUserFacingNativeError(error) {
    return {
      code: error?.code || 'native_connection_failed',
      message: getErrorMessage(error, 'Native host request failed.')
    };
  }

  function getErrorMessage(error, fallback) {
    const message = String(error?.message || fallback);
    return message.split('\n')[0] || fallback;
  }

  function isAllowedOverleafSender(sender) {
    if (!sender?.tab) {
      const extensionUrl = chrome.runtime.getURL('');
      const senderUrl = sender?.url || '';
      return sender?.id === chrome.runtime.id && senderUrl.startsWith(extensionUrl);
    }

    const senderUrl = sender.tab?.url || '';
    try {
      const url = new URL(senderUrl);
      return url.protocol === 'https:' && (
        url.hostname === 'www.overleaf.com' || url.hostname === 'overleaf.com'
      );
    } catch (_error) {
      return false;
    }
  }

  function forwardNativeEvent(tabId, id, event) {
    if (typeof tabId !== 'number') {
      return false;
    }

    chrome.tabs.sendMessage(tabId, {
      type: 'codex-overleaf/native-event',
      id,
      event
    }, () => {
      void chrome.runtime.lastError;
    });
    return true;
  }
})();

(function loadConsentDrivenUpdateRuntime(root) {
  'use strict';

  try {
    const workerPath = chrome.runtime.getManifest().background?.service_worker || '';
    const runtimePrefix = workerPath.startsWith('bootstrap/') ? 'runtime/' : '';
    if (!root.CodexOverleafUpdateConsent) {
      importScripts(chrome.runtime.getURL(runtimePrefix + 'src/shared/updateConsent.js'));
    }
    if (!root.CodexOverleafUpdateCoordinator) {
      importScripts(chrome.runtime.getURL(runtimePrefix + 'src/backgroundUpdateCoordinator.js'));
    }
    root.CodexOverleafUpdateCoordinator?.init?.({
      nativeBridge: root.CodexOverleafNativeBridge
    });
  } catch (error) {
    console.error('Consent-driven updater failed to initialize:', error?.message || String(error));
  }
})(globalThis);
