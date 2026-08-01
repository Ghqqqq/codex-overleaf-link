if (!globalThis.CodexOverleafCompatibility) {
  importScripts('shared/compatibility.js');
}
if (!globalThis.CodexOverleafManagedUpdateProjection) {
  const runtimeBase = String(globalThis.__CODEX_OVERLEAF_RUNTIME_BASE__ || '');
  const projectionPath = runtimeBase
    ? `${runtimeBase}/src/shared/managedUpdateProjection.js`
    : 'shared/managedUpdateProjection.js';
  importScripts(runtimeBase ? chrome.runtime.getURL(projectionPath) : projectionPath);
}
if (!globalThis.CodexOverleafNativeRequestIdentity) {
  const runtimeBase = String(globalThis.__CODEX_OVERLEAF_RUNTIME_BASE__ || '');
  const identityPath = runtimeBase
    ? `${runtimeBase}/src/shared/nativeRequestIdentity.js`
    : 'shared/nativeRequestIdentity.js';
  importScripts(runtimeBase ? chrome.runtime.getURL(identityPath) : identityPath);
}

(function initBackground() {
  'use strict';

  const HOST_NAME = 'com.codex.overleaf';
  const MANAGED_UPDATE_STATE_KEY = 'codex-overleaf-managed-update-state-v1';
  const MANAGED_UPDATE_CONSENT_KEY = 'codex-overleaf-update-consent-v1';
  const MANAGED_UPDATE_TABS_KEY = 'codex-overleaf-managed-update-tabs-v1';
  const MANAGED_OVERLEAF_MATCHES = [
    'https://www.overleaf.com/project',
    'https://overleaf.com/project',
    'https://www.overleaf.com/project/*',
    'https://overleaf.com/project/*'
  ];
  const COMPATIBILITY_REQUIRED_METHODS = new Set([
    'codex.run',
    'codex.steer',
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
  const ManagedUpdateProjection = globalThis.CodexOverleafManagedUpdateProjection;
  const NativeRequestIdentity = globalThis.CodexOverleafNativeRequestIdentity;
  let port = null;
  let managedUpdateExecutionLocked = false;
  const pending = new Map();
  const runJournals = new Map();
  const journalWrites = new Map();
  const ownerBindings = new Map();
  const ownerCancelTimers = new Map();
  const RUN_JOURNAL_PREFIX = 'codex-overleaf:run-journal:';
  const RUN_JOURNAL_MAX_EVENTS = 300;
  const RUN_JOURNAL_MAX_BYTES = 512 * 1024;
  const managedBootstrapRuntime = isManagedBootstrapRuntime();
  globalThis.CodexOverleafNativeBridge = Object.freeze({
    requestInternal: payload => requestManagedInternal(payload),
    getPendingState: () => ({
      executionRequests: Array.from(pending.values()).filter(item => item.retryClass === 'no_silent_retry').length,
      totalRequests: pending.size
    })
  });

  if (managedBootstrapRuntime) {
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'local' || !changes[MANAGED_UPDATE_STATE_KEY]?.newValue) {
        return;
      }
      void repairManagedUpdatePhaseMetadata(changes[MANAGED_UPDATE_STATE_KEY].newValue);
    });
    setTimeout(() => {
      void reconcileManagedUpdateTransaction();
    }, 250);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'codex-overleaf/run-journal/list') {
      if (!isAllowedOverleafSender(sender)) {
        sendResponse({ ok: false, journals: [] });
        return undefined;
      }
      listRunJournals(String(message.projectKey || ''))
        .then(journals => sendResponse({ ok: true, journals }))
        .catch(error => sendResponse({ ok: false, journals: [], error: getErrorMessage(error, 'Journal read failed.') }));
      return true;
    }
    if (message?.type === 'codex-overleaf/run-journal/ack') {
      if (!isAllowedOverleafSender(sender)) {
        sendResponse({ ok: false });
        return undefined;
      }
      acknowledgeRunJournal(String(message.requestId || ''))
        .then(() => sendResponse({ ok: true }))
        .catch(error => sendResponse({ ok: false, error: getErrorMessage(error, 'Journal cleanup failed.') }));
      return true;
    }
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

  chrome.runtime.onConnect?.addListener(portConnection => {
    if (portConnection.name !== 'codex-overleaf/run-owner' || !isAllowedOverleafSender(portConnection.sender)) {
      return;
    }
    portConnection.onMessage.addListener(message => {
      const requestId = String(message?.requestId || '');
      if (!requestId) {
        return;
      }
      if (message.type === 'release') {
        ownerBindings.delete(portConnection);
        clearTimeout(ownerCancelTimers.get(requestId));
        ownerCancelTimers.delete(requestId);
        return;
      }
      if (message.type === 'bind') {
        ownerBindings.set(portConnection, {
          requestId,
          projectKey: String(message.projectKey || ''),
          documentId: String(portConnection.sender?.documentId || '')
        });
        clearTimeout(ownerCancelTimers.get(requestId));
        ownerCancelTimers.delete(requestId);
      }
    });
    portConnection.onDisconnect.addListener(() => {
      const binding = ownerBindings.get(portConnection);
      ownerBindings.delete(portConnection);
      if (!binding?.requestId) {
        return;
      }
      const timer = setTimeout(() => interruptOwnerlessRun(binding), 150);
      ownerCancelTimers.set(binding.requestId, timer);
    });
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
    const identity = NativeRequestIdentity.resolve(payload?.id, () => crypto.randomUUID());
    if (!identity.ok) {
      return Promise.resolve({
        ok: false,
        error: identity.error
      });
    }
    const id = identity.id;
    const requestWithEvidence = { ...payload, id };
    const compatibilityBlock = options.skipCompatibility ? null : getNativeCompatibilityBlock(requestWithEvidence);
    if (compatibilityBlock) {
      return Promise.resolve({
        ok: false,
        error: compatibilityBlock
      });
    }
    const request = sanitizeNativeRequest(requestWithEvidence);
    if (managedUpdateExecutionLocked &&
        !request.method.startsWith('update.') &&
        request.method !== 'codex.cancel' &&
        getNativeRetryClass(request.method) === 'no_silent_retry') {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'update_applying',
          message: 'A managed update is activating. Retry after the extension reloads.'
        }
      });
    }

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
      if (request.method === 'codex.run') {
        createRunJournal(id, pendingRequest);
      }

      try {
        postNativeRequest(pendingRequest);
      } catch (error) {
        handleNativePostFailure(id, pendingRequest, error);
      }
    });
  }

  async function requestManagedInternal(payload) {
    if (managedBootstrapRuntime && payload?.method === 'update.apply') {
      const gate = await verifyManagedUpdateSafety();
      if (!gate.ok) {
        return gate;
      }
      managedUpdateExecutionLocked = true;
      try {
        const result = await sendNativeRequest(payload, null, { skipCompatibility: true });
        if (!result?.ok) {
          managedUpdateExecutionLocked = false;
        }
        return result;
      } catch (error) {
        managedUpdateExecutionLocked = false;
        throw error;
      }
    }
    return sendNativeRequest(payload, null, { skipCompatibility: true });
  }

  async function verifyManagedUpdateSafety() {
    const tabs = await chrome.tabs.query({ url: MANAGED_OVERLEAF_MATCHES }).catch(() => []);
    const editorTabs = tabs.filter(tab => (
      isManagedEditorTab(tab) && !tab.discarded && tab.status !== 'unloaded'
    ));
    const probes = await Promise.all(editorTabs.map(tab => probeManagedUpdateTab(tab.id)));
    const nativeGate = await sendNativeRequest({
      id: crypto.randomUUID(),
      method: 'update.canApply',
      params: {}
    }, null, { skipCompatibility: true }).catch(error => ({
      ok: false,
      error: {
        code: error?.code || 'native_connection_failed',
        message: getErrorMessage(error, 'Native Host update safety check failed.')
      }
    }));
    const pendingState = globalThis.CodexOverleafNativeBridge?.getPendingState?.() || {};
    const backgroundBlockers = Number(pendingState.executionRequests || 0) > 0
      ? ['background_execution_pending']
      : [];
    const blockers = [
      ...backgroundBlockers,
      ...(globalThis.CodexOverleafUpdateStatus?.collectBlockers(probes, nativeGate) || ['busy'])
    ];
    if (!blockers.length) {
      return { ok: true };
    }
    return {
      ok: false,
      error: {
        code: 'update_not_idle',
        message: 'The update paused because Overleaf or the Native Host became busy. It will retry at the next safe point.',
        blockers
      }
    };
  }

  async function probeManagedUpdateTab(tabId) {
    if (!Number.isInteger(tabId)) {
      return { idle: false, blockers: ['tab_unavailable'] };
    }
    try {
      return await Promise.race([
        chrome.tabs.sendMessage(tabId, { type: 'codex-overleaf/update-idle-probe' }),
        new Promise(resolve => setTimeout(() => resolve({
          idle: false,
          blockers: ['tab_probe_timeout']
        }), 3500))
      ]);
    } catch (_error) {
      return { idle: false, blockers: ['tab_probe_unavailable'] };
    }
  }

  function isManagedEditorTab(tab) {
    try {
      const url = new URL(tab?.url || '');
      return url.protocol === 'https:' &&
        (url.hostname === 'www.overleaf.com' || url.hostname === 'overleaf.com') &&
        /^\/project\/[^/]+(?:\/|$)/.test(url.pathname);
    } catch (_error) {
      return false;
    }
  }

  function isManagedBootstrapRuntime() {
    if (typeof chrome.runtime?.getManifest !== 'function') {
      return false;
    }
    return chrome.runtime.getManifest().background?.service_worker === 'bootstrap/background.js';
  }

  async function repairManagedUpdatePhaseMetadata(state) {
    const repaired = ManagedUpdateProjection.ensurePhaseMetadata(state, {
      currentVersion: chrome.runtime.getManifest().version
    });
    if (Number(repaired.deadlineAt || 0) === Number(state?.deadlineAt || 0)) {
      return;
    }
    await chrome.storage.local.set({
      [MANAGED_UPDATE_STATE_KEY]: repaired
    });
  }

  async function reconcileManagedUpdateTransaction() {
    const response = await sendNativeRequest({
      id: crypto.randomUUID(),
      method: 'update.status',
      params: {}
    }, null, { skipCompatibility: true }).catch(() => null);
    if (!response?.ok) {
      return;
    }

    const transaction = response.result?.transaction || null;
    if (transaction?.state === 'superseded') {
      const activeVersion = response.result?.activeVersion || chrome.runtime.getManifest().version;
      await chrome.storage.local.remove([
        MANAGED_UPDATE_CONSENT_KEY,
        MANAGED_UPDATE_TABS_KEY
      ]);
      await setManagedUpdateState({
        state: 'idle',
        managed: true,
        currentVersion: activeVersion,
        latestVersion: activeVersion,
        transactionId: '',
        blocker: '',
        blockers: [],
        code: '',
        message: ''
      });
      return;
    }
    const state = await getManagedUpdateState();
    const reconciled = ManagedUpdateProjection.reconcile(state, transaction, {
      currentVersion: chrome.runtime.getManifest().version
    });
    await setManagedUpdateState(reconciled.state);
    if (reconciled.action === 'reload_tabs') {
      await reloadManagedUpdateTabs();
      return;
    }
    if (reconciled.action === 'retry_install') {
      setTimeout(() => {
        void globalThis.CodexOverleafManagedUpdateExecutor?.installAuthorizedUpdate?.().catch?.(() => {});
      }, 250);
    }
  }

  async function getManagedUpdateState() {
    const stored = await chrome.storage.local.get(MANAGED_UPDATE_STATE_KEY);
    return ManagedUpdateProjection.normalize(stored?.[MANAGED_UPDATE_STATE_KEY] || {
      state: 'idle',
      managed: true,
      currentVersion: chrome.runtime.getManifest().version,
      latestVersion: chrome.runtime.getManifest().version
    }, { currentVersion: chrome.runtime.getManifest().version });
  }

  async function setManagedUpdateState(state) {
    const value = ManagedUpdateProjection.ensurePhaseMetadata(state, {
      currentVersion: chrome.runtime.getManifest().version
    });
    await chrome.storage.local.set({ [MANAGED_UPDATE_STATE_KEY]: value });
    return value;
  }

  async function reloadManagedUpdateTabs() {
    const stored = await chrome.storage.local.get(MANAGED_UPDATE_TABS_KEY);
    const pendingIds = Array.isArray(stored?.[MANAGED_UPDATE_TABS_KEY])
      ? stored[MANAGED_UPDATE_TABS_KEY]
      : [];
    const openTabs = await chrome.tabs.query({ url: MANAGED_OVERLEAF_MATCHES }).catch(() => []);
    const openIds = new Set(openTabs.map(tab => tab.id).filter(Number.isInteger));
    const reloadIds = [...new Set(pendingIds.filter(tabId => Number.isInteger(tabId) && openIds.has(tabId)))];
    await chrome.storage.local.remove(MANAGED_UPDATE_TABS_KEY);
    await Promise.allSettled(reloadIds.map(tabId => chrome.tabs.reload(tabId)));
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
    const identity = NativeRequestIdentity.resolve(payload?.id, () => crypto.randomUUID());
    if (!identity.ok) {
      const error = new Error(identity.error.message);
      error.code = identity.error.code;
      error.details = identity.error.details;
      throw error;
    }
    const id = identity.id;
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
        const { sequence, write } = appendRunJournalEvent(id, message.event);
        Promise.resolve(write).catch(() => {}).then(() => {
          pendingRequest.eventForwarded = (
            forwardNativeEvent(pendingRequest.tabId, id, message.event, sequence) ||
            pendingRequest.eventForwarded
          );
        });
        return;
      }
      pendingRequest.finalResponseReceived = true;
      pending.delete(id);
      finalizeRunJournal(id, message).catch(() => {}).finally(() => {
        pendingRequest.resolve(message);
      });
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
    finalizeRunJournal(pendingId, {
      ok: false,
      error: {
        code: 'native_execution_interrupted',
        message: errorMessage || 'Native host disconnected'
      }
    }).catch(() => {});
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

  function forwardNativeEvent(tabId, id, event, journalSeq = 0) {
    if (typeof tabId !== 'number') {
      return false;
    }

    chrome.tabs.sendMessage(tabId, {
      type: 'codex-overleaf/native-event',
      id,
      event,
      journalSeq
    }, () => {
      void chrome.runtime.lastError;
    });
    return true;
  }

  function createRunJournal(id, pendingRequest) {
    const params = pendingRequest.request?.params || {};
    const journal = {
      requestId: id,
      projectKey: String(params.projectId || params.project?.projectId || ''),
      clientRunId: String(params.clientRunId || ''),
      sessionId: String(params.clientSessionId || ''),
      task: sanitizeJournalString(params.task).slice(0, 12000),
      mode: String(params.mode || ''),
      model: String(params.model || ''),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      terminal: false,
      ownerLost: false,
      nextSequence: 1,
      events: []
    };
    runJournals.set(id, journal);
    pruneInMemoryRunJournals();
    return queueJournalWrite(id);
  }

  function appendRunJournalEvent(id, event) {
    const journal = runJournals.get(id);
    if (!journal) {
      return { sequence: 0, write: Promise.resolve() };
    }
    const sequence = journal.nextSequence++;
    journal.events.push({ sequence, event: sanitizeJournalValue(event) });
    journal.updatedAt = new Date().toISOString();
    trimRunJournal(journal);
    return { sequence, write: queueJournalWrite(id) };
  }

  function finalizeRunJournal(id, response) {
    const journal = runJournals.get(id);
    if (!journal) {
      return Promise.resolve();
    }
    journal.terminal = true;
    journal.updatedAt = new Date().toISOString();
    journal.final = {
      ok: response?.ok === true,
      code: String(response?.error?.code || ''),
      status: String(response?.result?.status || '')
    };
    return queueJournalWrite(id);
  }

  function trimRunJournal(journal) {
    if (journal.events.length > RUN_JOURNAL_MAX_EVENTS) {
      journal.events.splice(0, journal.events.length - RUN_JOURNAL_MAX_EVENTS);
    }
    while (journal.events.length && JSON.stringify(journal).length * 2 > RUN_JOURNAL_MAX_BYTES) {
      journal.events.shift();
    }
  }

  function sanitizeJournalValue(value, depth = 0) {
    if (typeof value === 'string') {
      return sanitizeJournalString(value);
    }
    if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (depth > 10) {
      return '[nested value omitted]';
    }
    if (Array.isArray(value)) {
      return value.slice(0, 200).map(item => sanitizeJournalValue(item, depth + 1));
    }
    if (typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).slice(0, 200).map(([key, item]) => [
        sanitizeJournalString(key).slice(0, 160),
        sanitizeJournalValue(item, depth + 1)
      ]));
    }
    return String(value);
  }

  function sanitizeJournalString(value) {
    return String(value || '')
      .replace(/\b(?:sk|hf|glpat|npm|ghp|github_pat|AKIA|AIza)[_-]?[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
      .replace(/(?:file:\/\/)?\/(?:Users|home|private|var|opt|Library)\/[^\s"'<>]+/g, '[local path]')
      .slice(0, 131072);
  }

  function queueJournalWrite(id) {
    const storage = chrome.storage?.session;
    if (!storage || !runJournals.has(id)) {
      return Promise.resolve();
    }
    const previous = journalWrites.get(id) || Promise.resolve();
    const snapshot = JSON.parse(JSON.stringify(runJournals.get(id)));
    const next = previous.catch(() => {}).then(() => storage.set({
      [RUN_JOURNAL_PREFIX + id]: snapshot
    }));
    journalWrites.set(id, next);
    return next.finally(() => {
      if (journalWrites.get(id) === next) {
        journalWrites.delete(id);
      }
    });
  }

  async function listRunJournals(projectKey) {
    await Promise.allSettled(Array.from(journalWrites.values()));
    const storage = chrome.storage?.session;
    if (!storage) {
      return [];
    }
    const values = await storage.get(null);
    const entries = Object.entries(values || {})
      .filter(([key, value]) => key.startsWith(RUN_JOURNAL_PREFIX)
        && (!projectKey || value?.projectKey === projectKey)
        && (value?.terminal || value?.ownerLost))
      .sort((a, b) => String(a[1]?.createdAt || '').localeCompare(String(b[1]?.createdAt || '')));
    return entries.slice(-16).map(([_key, value]) => value);
  }

  function pruneInMemoryRunJournals() {
    if (runJournals.size <= 16) {
      return;
    }
    const oldest = Array.from(runJournals.values())
      .filter(journal => journal?.terminal || journal?.ownerLost)
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
      .slice(0, runJournals.size - 16);
    for (const journal of oldest) {
      runJournals.delete(journal.requestId);
      journalWrites.delete(journal.requestId);
      chrome.storage?.session?.remove?.(RUN_JOURNAL_PREFIX + journal.requestId).catch?.(() => {});
    }
  }

  async function acknowledgeRunJournal(id) {
    if (!id) {
      return;
    }
    await (journalWrites.get(id) || Promise.resolve()).catch(() => {});
    runJournals.delete(id);
    journalWrites.delete(id);
    await chrome.storage?.session?.remove?.(RUN_JOURNAL_PREFIX + id);
  }

  async function interruptOwnerlessRun(binding) {
    ownerCancelTimers.delete(binding.requestId);
    if (Array.from(ownerBindings.values()).some(value => value.requestId === binding.requestId)) {
      return;
    }
    const journal = runJournals.get(binding.requestId);
    if (journal) {
      journal.ownerLost = true;
      journal.updatedAt = new Date().toISOString();
      await queueJournalWrite(binding.requestId).catch(() => {});
    }
    if (!pending.has(binding.requestId)) {
      return;
    }
    try {
      sendNativeCancel({
        method: 'codex.cancel',
        params: {
          requestId: binding.requestId,
          projectKey: binding.projectKey || undefined
        }
      });
    } catch (_error) {
      // The original request disconnect path will settle the journal.
    }
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
    if (!root.CodexOverleafUpdateRevocation) {
      importScripts(chrome.runtime.getURL(runtimePrefix + 'src/shared/updateRevocationIntent.js'));
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
