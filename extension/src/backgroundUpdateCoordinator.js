(function initCodexOverleafUpdateCoordinator(root) {
  'use strict';

  const UPDATE_STATE_KEY = 'codex-overleaf-managed-update-state-v1';
  const CONSENT_STATE_KEY = 'codex-overleaf-update-consent-v1';
  const UPDATE_RELOAD_TABS_KEY = 'codex-overleaf-managed-update-tabs-v1';
  const CHECK_ALARM = 'codex-overleaf-consent-update-check';
  const IDLE_ALARM = 'codex-overleaf-consent-update-idle';
  const WATCHDOG_ALARM = 'codex-overleaf-consent-update-watchdog';
  const STARTUP_CHECK_SESSION_KEY = 'codex-overleaf-startup-update-check-v1';
  const STARTUP_CHECK_CLAIMED_FLAG = '__codexOverleafStartupUpdateCheckClaimed';
  const CHECK_INTERVAL_MINUTES = 24 * 60;
  const SNOOZE_MS = 24 * 60 * 60 * 1000;
  const CANDIDATE_MAX_AGE_MS = 5 * 60 * 1000;
  const CHECK_REQUEST_TIMEOUT_MS = 15 * 1000;
  const ACTIVATION_TIMEOUT_MS = 20 * 1000;
  const ACTIVATION_POLL_MS = 250;
  const FAST_IDLE_RETRY_MS = 4000;
  const SLOW_IDLE_RETRY_MS = 15000;
  const FAST_IDLE_RETRY_BLOCKERS = new Set(['recent_user_activity', 'save_state_not_stable']);
  const WATCHDOG_INTERVAL_MINUTES = 1;
  const PHASE_TIMEOUT_MS = Object.freeze({
    checking: 30 * 1000,
    downloading: 2 * 60 * 1000,
    applying: 90 * 1000,
    awaiting_health: 2 * 60 * 1000,
    rolling_back: 60 * 1000
  });
  const LEGACY_GUARD = Number.MAX_SAFE_INTEGER;
  const OVERLEAF_MATCHES = [
    'https://www.overleaf.com/project',
    'https://overleaf.com/project',
    'https://www.overleaf.com/project/*',
    'https://overleaf.com/project/*'
  ];
  const MESSAGE_TYPES = new Set([
    'codex-overleaf/consent-update-get-state',
    'codex-overleaf/consent-update-check',
    'codex-overleaf/consent-update-install',
    'codex-overleaf/consent-update-later',
    'codex-overleaf/consent-update-dismiss'
  ]);

  const policy = root.CodexOverleafUpdateConsent;
  let nativeBridge = null;
  let initialized = false;
  let policyTail = Promise.resolve();
  let idleRetryTimer = null;
  let activationPromise = null;

  function init(options = {}) {
    if (initialized || !policy) return;
    initialized = true;
    nativeBridge = options.nativeBridge || root.CodexOverleafNativeBridge;

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!MESSAGE_TYPES.has(message?.type)) return undefined;
      if (!isAllowedSender(sender)) {
        sendResponse({ ok: false, error: { code: 'forbidden_sender', message: 'Update actions are limited to this extension and Overleaf project tabs.' } });
        return false;
      }
      enqueuePolicyAction(() => handleMessage(message))
        .then(result => sendResponse({ ok: true, result }))
        .catch(error => sendResponse({ ok: false, error: safeError(error) }));
      return true;
    });

    chrome.alarms?.onAlarm?.addListener(alarm => {
      if (alarm?.name === CHECK_ALARM) {
        void enqueuePolicyAction(() => checkOnly({ manual: false })).catch(() => {});
      }
      if (alarm?.name === WATCHDOG_ALARM) {
        void enqueuePolicyAction(() => reconcileExpiredPhase()).catch(() => {});
      }
      if (alarm?.name === IDLE_ALARM) {
        void enqueuePolicyAction(() => tryActivateStagedUpdate()).catch(() => {});
      }
    });

    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'local' || (!changes[UPDATE_STATE_KEY] && !changes[CONSENT_STATE_KEY])) return;
      void handleObservedStateChange();
    });

    void startup();
  }

  async function startup() {
    chrome.alarms?.create?.(CHECK_ALARM, {
      delayInMinutes: 0.5,
      periodInMinutes: CHECK_INTERVAL_MINUTES
    });
    chrome.alarms?.create?.(WATCHDOG_ALARM, {
      delayInMinutes: WATCHDOG_INTERVAL_MINUTES,
      periodInMinutes: WATCHDOG_INTERVAL_MINUTES
    });
    await recoverInterruptedCheck();
    await reconcileExpiredPhase();
    await settleTerminalConsent();
    await armLegacyGuard();
    await publishView();
    const updateState = await getUpdateState();
    if (['staged', 'waiting_for_idle'].includes(updateState.state)) {
      scheduleIdleRetry(updateState.blockers);
    }
    if (await claimStartupCheck()) {
      void enqueuePolicyAction(() => checkOnly({ manual: false })).catch(() => {});
    }
  }

  async function claimStartupCheck() {
    if (root[STARTUP_CHECK_CLAIMED_FLAG] === true) return false;
    root[STARTUP_CHECK_CLAIMED_FLAG] = true;
    const sessionStorage = chrome.storage?.session;
    if (!sessionStorage?.get || !sessionStorage?.set) return true;
    try {
      const stored = await sessionStorage.get(STARTUP_CHECK_SESSION_KEY);
      if (stored?.[STARTUP_CHECK_SESSION_KEY] === true) return false;
      await sessionStorage.set({ [STARTUP_CHECK_SESSION_KEY]: true });
      return true;
    } catch (_error) {
      return true;
    }
  }

  async function handleMessage(message) {
    switch (message.type) {
      case 'codex-overleaf/consent-update-get-state':
        return getView();
      case 'codex-overleaf/consent-update-check':
        return checkOnly({ manual: true });
      case 'codex-overleaf/consent-update-install':
        return installUpdate();
      case 'codex-overleaf/consent-update-later':
        return postponeUpdate();
      case 'codex-overleaf/consent-update-dismiss':
        return dismissCompletedUpdate();
      default:
        throw codedError('unknown_update_action', 'Unknown update action.');
    }
  }

  async function checkOnly({ manual }) {
    const [currentState, consent] = await Promise.all([getUpdateState(), getConsentState()]);
    if (consent.authorizedVersion || policy.isExecutionState(currentState.state)) {
      return getView();
    }
    await setUpdateState({
      ...currentState,
      state: 'checking',
      initiatedBy: manual ? 'manual' : 'automatic',
      code: '',
      message: '',
      blocker: '',
      blockers: []
    });

    try {
      const result = await withTimeout(
        requestNative('update.check', {
          currentVersion: currentVersion(),
          etag: currentState.etag || ''
        }),
        CHECK_REQUEST_TIMEOUT_MS,
        codedError('update_check_timeout', 'The managed update check did not complete in time.')
      );
      const checkedAt = Date.now();
      if (result.available) {
        const nextConsent = result.latestVersion !== consent.snoozedVersion
          ? { ...consent, snoozedVersion: '', snoozedUntil: 0 }
          : consent;
        await setConsentState({
          ...nextConsent,
          lastPromptedVersion: result.latestVersion,
          lastPromptedAt: manual ? checkedAt : nextConsent.lastPromptedAt
        });
        await setUpdateState({
          ...currentState,
          state: 'update_available',
          managed: true,
          currentVersion: result.currentVersion || currentVersion(),
          latestVersion: result.latestVersion,
          etag: result.etag || currentState.etag || '',
          lastCheckedAt: checkedAt,
          postponeUntil: LEGACY_GUARD,
          code: '',
          message: ''
        });
      } else if (result.reason === 'not_modified' &&
          policy.compareStableVersions(currentState.latestVersion, currentVersion()) > 0) {
        await setUpdateState({
          ...currentState,
          state: 'update_available',
          lastCheckedAt: checkedAt,
          postponeUntil: LEGACY_GUARD,
          code: '',
          message: ''
        });
      } else {
        await setUpdateState({
          ...currentState,
          state: 'idle',
          currentVersion: result.currentVersion || currentVersion(),
          latestVersion: result.latestVersion || result.currentVersion || currentVersion(),
          etag: result.etag || currentState.etag || '',
          lastCheckedAt: checkedAt,
          postponeUntil: LEGACY_GUARD,
          transactionId: '',
          code: '',
          message: ''
        });
      }
      return getView();
    } catch (error) {
      await setUpdateState({
        ...currentState,
        state: 'failed',
        initiatedBy: manual ? 'manual' : 'automatic',
        postponeUntil: LEGACY_GUARD,
        code: safeCode(error),
        message: safeMessage(error)
      });
      throw error;
    }
  }

  async function recoverInterruptedCheck() {
    const state = await getUpdateState();
    if (state.state !== 'checking') return;
    const nextState = policy.compareStableVersions(state.latestVersion, currentVersion()) > 0
      ? 'update_available'
      : 'idle';
    await setUpdateState({
      ...state,
      state: nextState,
      blocker: '',
      blockers: [],
      code: '',
      message: ''
    });
  }

  async function dismissCompletedUpdate() {
    const state = await getUpdateState();
    if (state.state !== 'committed') return getView();
    const version = state.latestVersion || state.currentVersion || currentVersion();
    await setUpdateState({
      ...state,
      state: 'idle',
      currentVersion: version,
      latestVersion: version,
      transactionId: '',
      stagedAt: 0,
      blocker: '',
      blockers: [],
      code: '',
      message: ''
    });
    return getView();
  }

  async function installUpdate() {
    let state = await getUpdateState();
    let consent = await getConsentState();
    const candidateStale = !state.lastCheckedAt || Date.now() - state.lastCheckedAt > CANDIDATE_MAX_AGE_MS;
    if (state.state !== 'update_available' || candidateStale) {
      await checkOnly({ manual: true });
      state = await getUpdateState();
      consent = await getConsentState();
    }
    if (state.state !== 'update_available' ||
        policy.compareStableVersions(state.latestVersion, currentVersion()) <= 0) {
      throw codedError('update_candidate_missing', 'No newer signed stable update is available.');
    }

    const authorizationId = crypto.randomUUID();
    try {
      await requestNative('update.authorize', {
        authorizationId,
        targetVersion: state.latestVersion,
        currentVersion: currentVersion()
      });
      await setConsentState({
        ...consent,
        snoozedVersion: '',
        snoozedUntil: 0,
        authorizedVersion: state.latestVersion,
        authorizationId,
        authorizedAt: Date.now()
      });
      await setUpdateState({ ...state, postponeUntil: 0, code: '', message: '' });
      const executor = globalThis.CodexOverleafManagedUpdateExecutor;
      if (!executor || typeof executor.installAuthorizedUpdate !== 'function') {
        throw codedError(
          'update_executor_unavailable',
          'The managed update executor is unavailable.'
        );
      }
      await executor.installAuthorizedUpdate();
      return getView();
    } catch (error) {
      await bestEffortRevoke({
        authorizationId,
        targetVersion: state.latestVersion,
        transactionId: ''
      });
      await setConsentState({
        ...consent,
        authorizedVersion: '',
        authorizationId: '',
        authorizedAt: 0
      });
      const observed = await getUpdateState().catch(() => state);
      if (!['awaiting_health', 'committed', 'rolled_back'].includes(observed.state)) {
        await setUpdateState({
          ...observed,
          state: 'failed',
          initiatedBy: 'manual',
          blocker: '',
          blockers: [],
          code: safeCode(error),
          message: safeMessage(error)
        });
      }
      await armLegacyGuard();
      throw error;
    }
  }

  async function stageAuthorizedUpdate() {
    const current = await getUpdateState();
    await setUpdateState({
      ...current,
      state: 'downloading',
      initiatedBy: 'manual',
      blocker: '',
      blockers: [],
      code: '',
      message: ''
    });
    const staged = await requestNative('update.stage');
    await setUpdateState({
      ...current,
      state: 'staged',
      initiatedBy: 'manual',
      latestVersion: staged.targetVersion,
      transactionId: staged.transactionId,
      stagedAt: Date.now(),
      blocker: '',
      blockers: [],
      code: '',
      message: ''
    });
    return tryActivateStagedUpdate();
  }

  function tryActivateStagedUpdate() {
    const executor = root.CodexOverleafManagedUpdateExecutor;
    if (typeof executor?.installAuthorizedUpdate === 'function') {
      if (activationPromise) return activationPromise;
      activationPromise = Promise.resolve(executor.installAuthorizedUpdate()).finally(() => {
        activationPromise = null;
      });
      return activationPromise;
    }
    if (activationPromise) return activationPromise;
    activationPromise = tryActivateStagedUpdateCore().finally(() => {
      activationPromise = null;
    });
    return activationPromise;
  }

  async function tryActivateStagedUpdateCore() {
    clearIdleRetryTimer();
    const state = await getUpdateState();
    if (!['staged', 'waiting_for_idle'].includes(state.state)) {
      await chrome.alarms?.clear?.(IDLE_ALARM).catch(() => {});
      return state;
    }
    const surfaceTabs = await chrome.tabs.query({ url: OVERLEAF_MATCHES }).catch(() => []);
    const editorTabs = surfaceTabs.filter(isUsableEditorTab);
    const reloadTabs = surfaceTabs
      .filter(tab => Number.isInteger(tab?.id) && !tab.discarded && tab.status !== 'unloaded')
      .map(tab => tab.id);
    const probes = await Promise.all(editorTabs.map(tab => probeTabIdle(tab.id)));
    const nativeGate = await requestNative('update.canApply')
      .then(result => ({ ok: true, result }))
      .catch(error => ({ ok: false, error: safeError(error) }));
    const blockers = root.CodexOverleafUpdateStatus?.collectBlockers(probes, nativeGate) || ['busy'];
    if (blockers.length) {
      const waiting = await setUpdateState({
        ...state,
        state: 'waiting_for_idle',
        blocker: blockers[0],
        blockers
      });
      scheduleIdleRetry(blockers);
      return waiting;
    }

    await chrome.alarms?.clear?.(IDLE_ALARM).catch(() => {});
    await chrome.storage.local.set({ [UPDATE_RELOAD_TABS_KEY]: reloadTabs });
    await setUpdateState({
      ...state,
      state: 'applying',
      blocker: '',
      blockers: [],
      code: '',
      message: ''
    });
    const activation = await requestNative('update.activate', {
      transactionId: state.transactionId
    });
    const transaction = await waitForActivatedTransaction(activation.transactionId || state.transactionId);
    if (transaction.state === 'rolled_back') {
      throw codedError(transaction.reasonCode || 'update_apply_failed', 'The managed update was rolled back during activation.');
    }
    await setUpdateState({
      ...state,
      state: 'awaiting_health',
      latestVersion: transaction.targetVersion,
      transactionId: transaction.id,
      code: '',
      message: ''
    });
    chrome.runtime.reload();
    return { state: 'awaiting_health' };
  }

  async function waitForActivatedTransaction(transactionId) {
    const deadline = Date.now() + ACTIVATION_TIMEOUT_MS;
    while (Date.now() <= deadline) {
      const status = await requestNative('update.status').catch(() => null);
      const transaction = status?.transaction;
      if (transaction?.id === transactionId && ['awaiting_health', 'rolled_back'].includes(transaction.state)) {
        return transaction;
      }
      await new Promise(resolve => setTimeout(resolve, ACTIVATION_POLL_MS));
    }
    throw codedError('update_activation_timeout', 'The managed update did not reach health verification after activation.');
  }

  function scheduleIdleRetry(blockers = []) {
    clearIdleRetryTimer();
    const values = Array.isArray(blockers) ? blockers.filter(Boolean) : [];
    const fast = values.length > 0 && values.every(value => FAST_IDLE_RETRY_BLOCKERS.has(value));
    idleRetryTimer = setTimeout(() => {
      idleRetryTimer = null;
      void enqueuePolicyAction(() => tryActivateStagedUpdate()).catch(() => {});
    }, fast ? FAST_IDLE_RETRY_MS : SLOW_IDLE_RETRY_MS);
    chrome.alarms?.create?.(IDLE_ALARM, { delayInMinutes: 0.5 });
  }

  function clearIdleRetryTimer() {
    if (idleRetryTimer === null) return;
    clearTimeout(idleRetryTimer);
    idleRetryTimer = null;
  }

  function isUsableEditorTab(tab) {
    if (!Number.isInteger(tab?.id) || tab.discarded || tab.status === 'unloaded') return false;
    try {
      const url = new URL(tab.url || '');
      return url.protocol === 'https:' &&
        (url.hostname === 'www.overleaf.com' || url.hostname === 'overleaf.com') &&
        /^\/project\/[^/]+(?:\/|$)/.test(url.pathname);
    } catch (_error) {
      return false;
    }
  }

  async function probeTabIdle(tabId) {
    try {
      return await withTimeout(
        chrome.tabs.sendMessage(tabId, { type: 'codex-overleaf/update-idle-probe' }),
        3500,
        codedError('tab_probe_timeout', 'An Overleaf tab did not answer the idle check in time.')
      );
    } catch (error) {
      return { idle: false, blockers: [safeCode(error) === 'tab_probe_timeout' ? 'tab_probe_timeout' : 'tab_probe_unavailable'] };
    }
  }

  async function postponeUpdate() {
    const [state, consent] = await Promise.all([getUpdateState(), getConsentState()]);
    if (['applying', 'awaiting_health'].includes(state.state)) {
      throw codedError('update_revoke_too_late', 'The update is already being installed.');
    }
    if (consent.authorizationId) {
      try {
        await requestNative('update.revoke', {
          authorizationId: consent.authorizationId,
          targetVersion: consent.authorizedVersion || state.latestVersion,
          transactionId: state.transactionId || ''
        });
      } catch (error) {
        if (error?.code === 'update_revoke_too_late') {
          return getView();
        }
        throw error;
      }
    } else if (['staged', 'waiting_for_idle'].includes(state.state)) {
      throw codedError('update_consent_mismatch', 'The staged update has no matching runtime authorization.');
    }

    const snoozedUntil = Date.now() + SNOOZE_MS;
    clearIdleRetryTimer();
    await chrome.alarms?.clear?.(IDLE_ALARM).catch(() => {});
    await setUpdateState({
      ...state,
      state: 'update_available',
      transactionId: '',
      stagedAt: 0,
      blocker: '',
      blockers: [],
      postponeUntil: LEGACY_GUARD,
      code: '',
      message: ''
    });
    await setConsentState({
      ...consent,
      snoozedVersion: state.latestVersion,
      snoozedUntil,
      authorizedVersion: '',
      authorizationId: '',
      authorizedAt: 0
    });
    return getView();
  }

  async function settleTerminalConsent() {
    const [state, consent] = await Promise.all([getUpdateState(), getConsentState()]);
    if (!policy.isTerminalState(state.state) || !consent.authorizationId) return;
    await setConsentState({
      ...consent,
      authorizedVersion: '',
      authorizationId: '',
      authorizedAt: 0
    });
  }

  async function reconcileExpiredPhase() {
    const state = await getUpdateState();
    if (!state.deadlineAt || Date.now() <= state.deadlineAt || policy.isTerminalState(state.state)) {
      return state;
    }
    if (['applying', 'awaiting_health', 'rolling_back'].includes(state.state)) {
      const status = await requestNative('update.status').catch(() => null);
      const transaction = status?.transaction;
      if (transaction?.state === 'awaiting_health') {
        await requestNative('update.rollback', {
          transactionId: transaction.id,
          reasonCode: 'update_health_timeout'
        }).catch(() => null);
        return setUpdateState({
          ...state,
          state: 'failed',
          currentVersion: transaction.sourceVersion || state.currentVersion,
          code: 'update_health_timeout',
          message: 'The updated runtime did not complete its health check and was rolled back. Retry, or use the manual update command.'
        });
      }
      if (transaction?.state === 'committed') {
        return setUpdateState({
          ...state,
          state: 'committed',
          currentVersion: transaction.targetVersion,
          latestVersion: transaction.targetVersion,
          code: '',
          message: ''
        });
      }
      if (transaction?.state === 'rolled_back') {
        return setUpdateState({
          ...state,
          state: 'rolled_back',
          currentVersion: transaction.sourceVersion || state.currentVersion,
          code: transaction.reasonCode || 'update_rolled_back',
          message: 'The managed update was rolled back after activation did not complete.'
        });
      }
    }
    return setUpdateState({
      ...state,
      state: 'failed',
      code: 'update_phase_timeout',
      message: 'The managed update phase did not complete in time. Retry, or use the manual update command.'
    });
  }

  async function handleObservedStateChange() {
    await settleTerminalConsent();
    const [state, consent] = await Promise.all([getUpdateState(), getConsentState()]);
    if (!consent.authorizationId && !policy.isExecutionState(state.state)) {
      await armLegacyGuard();
    }
    await publishView();
  }

  async function armLegacyGuard() {
    const [state, consent] = await Promise.all([getUpdateState(), getConsentState()]);
    if (consent.authorizationId || state.postponeUntil === LEGACY_GUARD) return state;
    return setUpdateState({ ...state, postponeUntil: LEGACY_GUARD });
  }

  async function getView() {
    const [state, consent] = await Promise.all([getUpdateState(), getConsentState()]);
    return policy.deriveViewModel(state, consent, {
      currentVersion: currentVersion(),
      now: Date.now()
    });
  }

  async function publishView() {
    const view = await getView();
    await setBadge(view.badge);
    const tabs = await chrome.tabs.query({ url: OVERLEAF_MATCHES }).catch(() => []);
    await Promise.all((tabs || []).map(tab => {
      if (!Number.isInteger(tab?.id)) return Promise.resolve();
      return chrome.tabs.sendMessage(tab.id, {
        type: 'codex-overleaf/consent-update-state',
        view
      }).catch(() => {});
    }));
    return view;
  }

  async function setBadge(badge = {}) {
    try {
      await chrome.action.setBadgeText({ text: String(badge.text || '').slice(0, 4) });
      if (badge.text) {
        await chrome.action.setBadgeBackgroundColor({ color: badge.color || '#3578bd' });
      }
    } catch (_error) {
      // Badge rendering is best-effort and never participates in update state.
    }
  }

  async function getUpdateState() {
    const stored = await chrome.storage.local.get(UPDATE_STATE_KEY);
    return policy.normalizeUpdateState(stored?.[UPDATE_STATE_KEY], currentVersion());
  }

  async function setUpdateState(value) {
    const stored = await chrome.storage.local.get(UPDATE_STATE_KEY);
    const previous = policy.normalizeUpdateState(stored?.[UPDATE_STATE_KEY], currentVersion());
    const now = Date.now();
    const changedPhase = value.state && value.state !== previous.state;
    const timeoutMs = PHASE_TIMEOUT_MS[value.state] || 0;
    const next = policy.normalizeUpdateState({
      ...value,
      initiatedBy: value.initiatedBy || previous.initiatedBy,
      phaseStartedAt: changedPhase ? now : (value.phaseStartedAt || previous.phaseStartedAt),
      deadlineAt: changedPhase ? (timeoutMs ? now + timeoutMs : 0) : (value.deadlineAt || previous.deadlineAt),
      heartbeatAt: now
    }, currentVersion());
    await chrome.storage.local.set({ [UPDATE_STATE_KEY]: next });
    return next;
  }

  async function getConsentState() {
    const stored = await chrome.storage.local.get(CONSENT_STATE_KEY);
    return policy.normalizeConsentState(stored?.[CONSENT_STATE_KEY]);
  }

  async function setConsentState(value) {
    const next = policy.normalizeConsentState(value);
    await chrome.storage.local.set({ [CONSENT_STATE_KEY]: next });
    return next;
  }

  async function requestNative(method, params = {}) {
    const response = await nativeBridge?.requestInternal?.({
      id: crypto.randomUUID(),
      method,
      params
    });
    if (!response?.ok) {
      throw codedError(
        response?.error?.code || 'native_connection_failed',
        response?.error?.message || 'Native Host update request failed.'
      );
    }
    return response.result || {};
  }

  async function bestEffortRevoke(params) {
    try {
      await requestNative('update.revoke', params);
    } catch (_error) {
      // Native authorization remains the hard gate if cleanup cannot connect.
    }
  }

  function enqueuePolicyAction(action) {
    const result = policyTail.then(action, action);
    policyTail = result.catch(() => {});
    return result;
  }

  function isAllowedSender(sender) {
    if (sender?.id !== chrome.runtime.id) return false;
    try {
      const url = new URL(sender?.url || sender?.tab?.url || '');
      const extensionRoot = new URL(chrome.runtime.getURL(''));
      if (url.origin === extensionRoot.origin) {
        return url.pathname === '/bootstrap/popup.html';
      }
      return url.protocol === 'https:' &&
        (url.hostname === 'www.overleaf.com' || url.hostname === 'overleaf.com') &&
        (url.pathname === '/project' || url.pathname.startsWith('/project/'));
    } catch (_error) {
      return false;
    }
  }

  function currentVersion() {
    return String(
      root.CodexOverleafCompatibility?.BUILD_TARGET_VERSION ||
      chrome.runtime.getManifest().version ||
      ''
    );
  }

  function codedError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function withTimeout(promise, timeoutMs, timeoutError) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(timeoutError), timeoutMs);
      Promise.resolve(promise).then(
        value => {
          clearTimeout(timer);
          resolve(value);
        },
        error => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  function safeError(error) {
    return { code: safeCode(error), message: safeMessage(error) };
  }

  function safeCode(error) {
    const code = String(error?.code || '');
    return /^[a-z0-9_]{1,80}$/.test(code) ? code : 'update_failed';
  }

  function safeMessage(error) {
    return String(error?.message || 'Update failed.')
      .replace(/(?:file:\/\/)?(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/)[^\s]*/g, '[local path]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
  }

  root.CodexOverleafUpdateCoordinator = Object.freeze({ init });
})(globalThis);
