(function initCodexOverleafUpdateCoordinator(root) {
  'use strict';

  const UPDATE_STATE_KEY = 'codex-overleaf-managed-update-state-v1';
  const CONSENT_STATE_KEY = 'codex-overleaf-update-consent-v1';
  const UPDATE_RELOAD_TABS_KEY = 'codex-overleaf-managed-update-tabs-v1';
  const MANUAL_RELOAD_TABS_KEY = 'codex-overleaf-manual-runtime-reload-v1';
  const CHECK_ALARM = 'codex-overleaf-consent-update-check';
  const IDLE_ALARM = 'codex-overleaf-consent-update-idle';
  const WATCHDOG_ALARM = 'codex-overleaf-consent-update-watchdog';
  const STARTUP_CHECK_SESSION_KEY = 'codex-overleaf-startup-update-check-v1';
  const STARTUP_CHECK_CLAIMED_FLAG = '__codexOverleafStartupUpdateCheckClaimed';
  const CHECK_INTERVAL_MINUTES = 24 * 60;
  const SNOOZE_MS = 24 * 60 * 60 * 1000;
  const CANDIDATE_MAX_AGE_MS = 5 * 60 * 1000;
  const CHECK_REQUEST_TIMEOUT_MS = 55 * 1000;
  const ACTIVATION_TIMEOUT_MS = 20 * 1000;
  const ACTIVATION_POLL_MS = 250;
  const FAST_IDLE_RETRY_MS = 4000;
  const SLOW_IDLE_RETRY_MS = 15000;
  const FAST_IDLE_RETRY_BLOCKERS = new Set(['recent_user_activity', 'save_state_not_stable']);
  const WATCHDOG_INTERVAL_MINUTES = 1;
  const LEGACY_GUARD = Number.MAX_SAFE_INTEGER;
  const OVERLEAF_MATCHES = [
    'https://www.overleaf.com/project',
    'https://overleaf.com/project',
    'https://cn.overleaf.com/project',
    'https://www.overleaf.com/project/*',
    'https://overleaf.com/project/*',
    'https://cn.overleaf.com/project/*'
  ];
  const MESSAGE_TYPES = new Set([
    'codex-overleaf/consent-update-get-state',
    'codex-overleaf/consent-update-check',
    'codex-overleaf/consent-update-install',
    'codex-overleaf/consent-update-later',
    'codex-overleaf/consent-update-cancel',
    'codex-overleaf/consent-update-recover',
    'codex-overleaf/consent-update-dismiss',
    'codex-overleaf/consent-update-reload'
  ]);

  const policy = root.CodexOverleafUpdateConsent;
  const revocation = root.CodexOverleafUpdateRevocation;
  let nativeBridge = null;
  let initialized = false;
  let policyTail = Promise.resolve();
  let idleRetryTimer = null;
  let activationPromise = null;
  let runtimeStatus = null;
  let runtimeStatusAt = 0;
  let runtimeStatusRead = null;
  let runtimeReloadMessage = '';
  let operationGeneration = 0;
  let activeOperation = null;
  let cancellationPromise = null;
  let recoveryPromise = null;
  let stateWriteTail = Promise.resolve();

  function init(options = {}) {
    if (initialized || !policy || !revocation) return;
    initialized = true;
    nativeBridge = options.nativeBridge || root.CodexOverleafNativeBridge;

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!MESSAGE_TYPES.has(message?.type)) return undefined;
      if (!isAllowedSender(sender)) {
        sendResponse({ ok: false, error: { code: 'forbidden_sender', message: 'Update actions are limited to this extension and Overleaf project tabs.' } });
        return false;
      }
      const direct = ['codex-overleaf/consent-update-get-state',
        'codex-overleaf/consent-update-cancel', 'codex-overleaf/consent-update-later',
        'codex-overleaf/consent-update-recover'].includes(message.type);
      (direct ? handleMessage(message) : enqueuePolicyAction(() => handleMessage(message)))
        .then(result => sendResponse({ ok: true, result }))
        .catch(error => sendResponse({ ok: false, error: safeError(error) }));
      return true;
    });

    chrome.alarms?.onAlarm?.addListener(alarm => {
      if (alarm?.name === CHECK_ALARM) {
        void enqueuePolicyAction(() => checkOnly({ manual: false })).catch(() => {});
      }
      if (alarm?.name === WATCHDOG_ALARM) {
        void reconcileRecoveryState().catch(() => {});
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
    await reconcileRecoveryState();
    await settleTerminalConsent();
    await armLegacyGuard();
    await finishManualRuntimeReload();
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
      case 'codex-overleaf/consent-update-recover':
        await reconcileRecoveryState();
        return getView();
      case 'codex-overleaf/consent-update-check':
        return checkOnly({ manual: true });
      case 'codex-overleaf/consent-update-install':
        return installUpdate();
      case 'codex-overleaf/consent-update-later':
        return snoozeManualInstall().then(view => view || postponeUpdate());
      case 'codex-overleaf/consent-update-cancel':
        return postponeUpdate();
      case 'codex-overleaf/consent-update-dismiss':
        return dismissCompletedUpdate();
      case 'codex-overleaf/consent-update-reload':
        return reloadInstalledRuntime();
      default:
        throw codedError('unknown_update_action', 'Unknown update action.');
    }
  }

  async function checkOnly({ manual }, inheritedOperation) {
    const operation = inheritedOperation || beginOperation();
    try {
      const [currentState, consent] = await Promise.all([getUpdateState(), getConsentState()]);
      assertOperation(operation);
      if (currentState.cancelRequested || currentState.recoveryPending
        || consent.authorizedVersion || policy.isExecutionState(currentState.state)) return getView();
      operation.phase = 'checking';
      await setUpdateState({ ...currentState, state: 'checking', operationId: operation.id,
        cancelRequested: false, initiatedBy: manual ? 'manual' : 'automatic',
        code: '', message: '', blocker: '', blockers: [], postponeUntil: LEGACY_GUARD }, { operation });
      try {
        const result = await withTimeout(requestNative('update.check', {
          operationId: operation.id, currentVersion: currentVersion(), etag: currentState.etag || ''
        }), CHECK_REQUEST_TIMEOUT_MS, codedError('update_check_timeout', 'The managed update check did not complete in time.'));
        assertOperation(operation);
        const checkedAt = Date.now();
        if (result.available || (result.reason === 'not_modified'
          && policy.compareStableVersions(currentState.latestVersion, currentVersion()) > 0)) {
          const latestVersion = result.latestVersion || currentState.latestVersion;
          await setConsentState({ ...consent,
            ...(latestVersion !== consent.snoozedVersion ? { snoozedVersion: '', snoozedUntil: 0 } : {}),
            lastPromptedVersion: latestVersion,
            lastPromptedAt: manual ? checkedAt : consent.lastPromptedAt
          }, { operation });
          await setUpdateState({ ...currentState, state: 'update_available', operationId: operation.id,
            currentVersion: result.currentVersion || currentVersion(), latestVersion,
            managed: true, etag: result.etag || currentState.etag || '', lastCheckedAt: checkedAt,
            postponeUntil: LEGACY_GUARD, code: '', message: '', cancelRequested: false
          }, { operation });
        } else if (result.reason === 'manual_install_required'
          && policy.compareStableVersions(result.latestVersion, currentVersion()) > 0) {
          await setUpdateState({ ...currentState, state: 'manual_install_required', operationId: operation.id,
            currentVersion: result.currentVersion || currentVersion(), latestVersion: result.latestVersion,
            managed: true, etag: result.etag || currentState.etag || '', lastCheckedAt: checkedAt,
            postponeUntil: LEGACY_GUARD, code: 'update_bootstrap_upgrade_required', message: '',
            manualReason: result.manualInstall?.reason || {}, cancelRequested: false
          }, { operation });
        } else {
          await setUpdateState({ ...currentState, state: 'idle', operationId: operation.id,
            currentVersion: result.currentVersion || currentVersion(),
            latestVersion: result.latestVersion || result.currentVersion || currentVersion(),
            etag: result.etag || currentState.etag || '', lastCheckedAt: checkedAt,
            postponeUntil: LEGACY_GUARD, transactionId: '', code: '', message: '', cancelRequested: false
          }, { operation });
        }
        return getView();
      } catch (error) {
        if (!isCurrentOperation(operation)) return getView();
        await requestNative('update.cancel', { operationId: operation.id }).catch(() => {});
        assertOperation(operation);
        await setUpdateState({ ...currentState, state: 'failed', operationId: operation.id,
          initiatedBy: manual ? 'manual' : 'automatic', postponeUntil: LEGACY_GUARD,
          code: safeCode(error), message: safeMessage(error)
        }, { operation });
        throw error;
      }
    } finally {
      if (!inheritedOperation) finishOperation(operation);
    }
  }


  async function recoverInterruptedCheck() {
    const state = await getUpdateState();
    if (state.state !== 'checking' || activeOperation || state.cancelRequested) return;
    if (state.operationId) {
      await postponeUpdate().catch(() => {});
      return;
    }
    await setUpdateState({ ...state,
      state: policy.compareStableVersions(state.latestVersion, currentVersion()) > 0 ? 'update_available' : 'idle',
      blocker: '', blockers: [], code: '', message: ''
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
    const operation = beginOperation();
    let state, consent, authorizationId = '';
    try {
      state = await getUpdateState();
      consent = await getConsentState();
      assertOperation(operation);
      if (state.cancelRequested || state.recoveryPending || policy.isExecutionState(state.state)) return getView();
      const candidateStale = !state.lastCheckedAt || Date.now() - state.lastCheckedAt > CANDIDATE_MAX_AGE_MS;
      if (state.state !== 'update_available' || candidateStale) {
        await checkOnly({ manual: true }, operation);
        assertOperation(operation);
        state = await getUpdateState();
        consent = await getConsentState();
        assertOperation(operation);
      }
      // The fresh check found a release only a reinstall can apply; show that notice.
      if (state.state === 'manual_install_required') return getView();
      if (state.state !== 'update_available'
        || policy.compareStableVersions(state.latestVersion, currentVersion()) <= 0) {
        throw codedError('update_candidate_missing', 'No newer signed stable update is available.');
      }
      authorizationId = crypto.randomUUID();
      operation.authorizationId = authorizationId;
      operation.targetVersion = state.latestVersion;
      const intent = revocation.prepareAuthorization(consent, authorizationId, state.latestVersion, Date.now());
      await setConsentState(intent, { operation });
      assertOperation(operation);
      await requestNative('update.authorize', {
        operationId: operation.id, authorizationId, targetVersion: state.latestVersion, currentVersion: currentVersion()
      });
      assertOperation(operation);
      await setConsentState(revocation.clear({ ...intent, snoozedVersion: '', snoozedUntil: 0,
        authorizedVersion: state.latestVersion, authorizationId, authorizedAt: Date.now()
      }), { operation });
      await setUpdateState({ ...state, operationId: operation.id, postponeUntil: LEGACY_GUARD,
        cancelRequested: false, recoveryPending: false, code: '', message: ''
      }, { operation });
      // Replaceable runtime owns this transfer. The immutable Bootstrap keeps
      // its health-confirmation role and cannot resume a postponed operation.
      await stageAuthorizedUpdate(operation);
      return getView();
    } catch (error) {
      if (!isCurrentOperation(operation)) return getView();
      if (authorizationId) {
        const observed = await getConsentState();
        assertOperation(operation);
        const pending = revocation.prepareAuthorization({ ...observed,
          authorizedVersion: state.latestVersion, authorizationId,
          authorizedAt: observed.authorizedAt || Date.now()
        }, authorizationId, state.latestVersion, Date.now());
        await setConsentState(pending, { operation });
        try {
          await requestNative('update.revoke', {
            operationId: operation.id, authorizationId, targetVersion: state.latestVersion
          });
          assertOperation(operation);
          await setConsentState(revocation.clear({ ...pending,
            authorizedVersion: '', authorizationId: '', authorizedAt: 0
          }), { operation });
        } catch (revokeError) {
          if (!isCurrentOperation(operation)) return getView();
          operation.revocationPending = true;
          error.revocationError = safeMessage(revokeError);
        }
      }
      const observedState = await getUpdateState();
      assertOperation(operation);
      if (!['awaiting_health', 'committed', 'rolled_back'].includes(observedState.state)) {
        await setUpdateState({ ...observedState, state: 'failed', initiatedBy: 'manual',
          blocker: '', blockers: [], code: safeCode(error), message: safeMessage(error),
          operationId: operation.id,
          cancelRequested: operation.phase !== 'applying' && operation.revocationPending === true,
          recoveryPending: operation.phase === 'applying'
        }, { operation });
      }
      throw error;
    } finally { finishOperation(operation); }
  }


  async function stageAuthorizedUpdate(operation) {
    operation.phase = 'downloading';
    await setUpdateState({ state: 'downloading', operationId: operation.id,
      initiatedBy: 'manual', blocker: '', blockers: [], code: '', message: '',
      postponeUntil: LEGACY_GUARD
    }, { operation });
    assertOperation(operation);
    const staged = await requestNative('update.stage', { operationId: operation.id });
    assertOperation(operation);
    await setUpdateState({ state: 'staged', operationId: operation.id, initiatedBy: 'manual',
      latestVersion: staged.targetVersion, transactionId: staged.transactionId, stagedAt: Date.now(),
      blocker: '', blockers: [], code: '', message: '', postponeUntil: LEGACY_GUARD
    }, { operation });
    return tryActivateStagedUpdate(operation);
  }


  async function tryActivateStagedUpdate(inheritedOperation) {
    if (activationPromise) return activationPromise;
    const state = await getUpdateState();
    if (state.cancelRequested || state.recoveryPending || cancellationPromise
      || !['staged', 'waiting_for_idle'].includes(state.state)) return state;
    const operation = inheritedOperation || beginOperation(state.operationId);
    assertOperation(operation);
    activationPromise = tryActivateStagedUpdateCore(operation).finally(() => {
      activationPromise = null;
      if (!inheritedOperation) finishOperation(operation);
    });
    return activationPromise;
  }


  async function tryActivateStagedUpdateCore(operation) {
    clearIdleRetryTimer();
    const state = await getUpdateState();
    assertOperation(operation);
    if (state.cancelRequested || !['staged', 'waiting_for_idle'].includes(state.state)) return state;
    operation.phase = 'waiting_for_idle';
    const surfaceTabs = await chrome.tabs.query({ url: OVERLEAF_MATCHES });
    const editorTabs = surfaceTabs.filter(isUsableEditorTab);
    const reloadTabs = surfaceTabs.filter(tab => Number.isInteger(tab?.id) && !tab.discarded && tab.status !== 'unloaded').map(tab => tab.id);
    const probes = await Promise.all(editorTabs.map(tab => probeTabIdle(tab.id)));
    const nativeGate = await requestNative('update.canApply')
      .then(result => ({ ok: true, result })).catch(error => ({ ok: false, error: safeError(error) }));
    assertOperation(operation);
    const blockers = root.CodexOverleafUpdateStatus?.collectBlockers(probes, nativeGate) || ['busy'];
    if (nativeBridge?.getPendingState?.().executionRequests > 0) blockers.push('background_execution_pending');
    if (blockers.length) {
      const waiting = await setUpdateState({ state: 'waiting_for_idle',
        operationId: operation.id, blocker: blockers[0], blockers
      }, { operation });
      if (isCurrentOperation(operation)) scheduleIdleRetry(blockers);
      return waiting;
    }
    operation.phase = 'applying';
    await chrome.alarms?.clear?.(IDLE_ALARM).catch(() => {});
    assertOperation(operation);
    await chrome.storage.local.set({ [UPDATE_RELOAD_TABS_KEY]: reloadTabs });
    await setUpdateState({ state: 'applying', operationId: operation.id,
      blocker: '', blockers: [], code: '', message: ''
    }, { operation });
    assertOperation(operation);
    // requestInternal rechecks the safe point and blocks new native work.
    let applied;
    try {
      applied = await requestNative('update.apply', {
        operationId: operation.id, transactionId: state.transactionId
      });
    } catch (error) {
      assertOperation(operation);
      if (!['update_not_idle', 'update_native_busy'].includes(error.code)) throw error;
      operation.phase = 'waiting_for_idle';
      const waiting = await setUpdateState({ state: 'waiting_for_idle',
        blocker: 'busy', blockers: ['busy'], recoveryPending: false
      }, { operation, observed: true });
      scheduleIdleRetry(waiting.blockers);
      return waiting;
    }
    assertOperation(operation);
    if (applied.state !== 'awaiting_health' || applied.transactionId !== state.transactionId) {
      throw codedError('update_apply_unconfirmed', 'Update activation did not return matching transaction evidence.');
    }
    await setUpdateState({ state: 'awaiting_health', operationId: operation.id,
      latestVersion: applied.targetVersion, transactionId: applied.transactionId,
      recoveryPending: false, code: '', message: ''
    }, { operation });
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
        (['overleaf.com', 'www.overleaf.com', 'cn.overleaf.com'].includes(url.hostname)) &&
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

  // A reinstall notice has no download or authorization to cancel; Later only
  // hides it for a day.
  async function snoozeManualInstall() {
    const [state, consent] = await Promise.all([getUpdateState(), getConsentState()]);
    if (state.state !== 'manual_install_required') return null;
    await setConsentState({ ...consent, snoozedVersion: state.latestVersion, snoozedUntil: Date.now() + SNOOZE_MS });
    return getView();
  }

  function postponeUpdate() {
    if (cancellationPromise) return cancellationPromise;
    cancellationPromise = cancelUpdateCore().finally(() => { cancellationPromise = null; });
    return cancellationPromise;
  }

  async function cancelUpdateCore() {
    const [state, consent] = await Promise.all([getUpdateState(), getConsentState()]);
    if (['applying', 'awaiting_health', 'rolling_back'].includes(state.state)
      || activeOperation?.phase === 'applying' || state.recoveryPending) {
      throw codedError('update_revoke_too_late', 'The update is being installed or recovered.');
    }
    const operation = activeOperation;
    const generation = ++operationGeneration;
    activeOperation = null;
    clearIdleRetryTimer();
    const operationId = operation?.id || state.operationId || '';
    const authorizationId = consent.authorizationId || consent.revokingAuthorizationId || operation?.authorizationId || '';
    const targetVersion = consent.authorizedVersion || consent.revokingVersion || operation?.targetVersion || state.latestVersion;
    const pending = authorizationId ? revocation.begin({ ...consent, authorizationId,
      authorizedVersion: targetVersion }, state, Date.now()) : consent;
    await setUpdateAndConsentState({ ...state, operationId, cancelRequested: true,
      postponeUntil: LEGACY_GUARD, code: '', message: ''
    }, pending, { generation });
    await chrome.alarms?.clear?.(IDLE_ALARM).catch(() => {});
    try {
      if (operationId) {
        const result = await withTimeout(requestNative('update.cancel', { operationId }), 15000,
          codedError('update_cancel_unconfirmed', 'Update cancellation has not been acknowledged yet.'));
        if (result.state !== 'cancelled' || result.operationId !== operationId) {
          throw codedError('update_cancel_unconfirmed', 'Update cancellation returned incomplete evidence.');
        }
      } else if (state.state === 'downloading') {
        throw codedError('update_cancel_unconfirmed', 'This older download has no operation identity. Reload the extension to recover it.');
      }
      if (authorizationId) {
        await withTimeout(requestNative('update.revoke', {
          operationId, authorizationId, targetVersion
        }), 15000, codedError('update_cancel_unconfirmed', 'Update authorization cleanup has not finished yet.'));
      }
      const completed = revocation.complete(state, pending, { now: Date.now(),
        snoozeMs: SNOOZE_MS, postponeUntil: LEGACY_GUARD });
      await setUpdateAndConsentState({ ...completed.updateState,
        state: policy.compareStableVersions(state.latestVersion, currentVersion()) > 0 ? 'update_available' : 'idle',
        operationId: '', cancelRequested: false, recoveryPending: false,
        code: 'update_cancelled', message: ''
      }, completed.consentState, { generation, observed: true });
      return getView();
    } catch (error) {
      if (error.code === 'update_revoke_too_late') {
        await setUpdateAndConsentState({ cancelRequested: false, recoveryPending: true,
          state: 'failed', code: 'update_recovery_pending', message: 'The update reached installation before cancellation. Checking its result.'
        }, revocation.clear(pending), { generation, observed: true });
      } else {
        await setUpdateState({ cancelRequested: true, code: 'update_cancel_unconfirmed',
          message: safeMessage(error)
        }, { generation });
      }
      throw error;
    }
  }


  function reconcileRecoveryState() {
    if (recoveryPromise) return recoveryPromise;
    recoveryPromise = (async () => {
      const state = await getUpdateState();
      if (state.recoveryPending) return reconcileExpiredPhase();
      if (state.cancelRequested) return postponeUpdate();
      if (!activeOperation) await reconcilePendingRevocation();
      return reconcileExpiredPhase();
    })().finally(() => { recoveryPromise = null; });
    return recoveryPromise;
  }


  async function reconcilePendingRevocation() {
    const consent = await getConsentState();
    if (!revocation.hasPending(consent) || activeOperation) return getUpdateState();
    return postponeUpdate().then(view => view.state);
  }


  async function settleTerminalConsent() {
    const [state, consent] = await Promise.all([getUpdateState(), getConsentState()]);
    if (!policy.isTerminalState(state.state) || state.cancelRequested || state.recoveryPending
      || revocation.hasPending(consent) || !consent.authorizationId) return;
    await setConsentState({ ...consent, authorizedVersion: '', authorizationId: '', authorizedAt: 0 },
      { expectedAuthorizationId: consent.authorizationId });
  }


  async function reconcileExpiredPhase() {
    const state = await getUpdateState();
    if (!state.recoveryPending && (!state.deadlineAt || Date.now() <= state.deadlineAt
      || policy.isTerminalState(state.state))) return state;
    if (['checking', 'downloading'].includes(state.state)) {
      await postponeUpdate();
      return setUpdateState({ state: 'failed', cancelRequested: false,
        code: 'update_phase_timeout', message: 'The update timed out and its download was stopped. Retry when the connection is available.'
      }, { observed: true });
    }
    if (state.recoveryPending || ['applying', 'awaiting_health', 'rolling_back'].includes(state.state)) {
      try {
        let status = await withTimeout(requestNative('update.status'), 10000,
          codedError('update_status_timeout', 'Update recovery status is unavailable.'));
        let transaction = status.transaction;
        if (state.transactionId && transaction?.id !== state.transactionId) {
          throw codedError('update_transaction_mismatch', 'The update recovery transaction could not be matched.');
        }
        if (transaction?.state === 'staged' || (!transaction && status.installedAligned
          && status.activeVersion === state.currentVersion)) {
          if (state.operationId) await requestNative('update.cancel', { operationId: state.operationId });
          const consent = await getConsentState();
          const authorizationId = consent.authorizationId || consent.revokingAuthorizationId;
          const targetVersion = consent.authorizedVersion || consent.revokingVersion || state.latestVersion;
          if (authorizationId) await requestNative('update.revoke', { authorizationId, targetVersion });
          await setConsentState(revocation.clear({ ...consent,
            authorizedVersion: '', authorizationId: '', authorizedAt: 0
          }));
          return setUpdateState({ state: 'failed', recoveryPending: false, cancelRequested: false,
            operationId: '', code: 'update_not_applied', message: 'The update was stopped before installation. Retry when ready.'
          }, { observed: true });
        }
        if (transaction?.state === 'awaiting_health') {
          const rolledBack = await requestNative('update.rollback', {
            transactionId: transaction.id, expectedState: 'awaiting_health', reasonCode: 'update_health_timeout'
          });
          if (rolledBack.state !== 'rolled_back' || rolledBack.version !== transaction.sourceVersion) {
            throw codedError('update_rollback_unconfirmed', 'Rollback returned incomplete evidence.');
          }
          status = await requestNative('update.status');
          transaction = status.transaction;
        }
        if (transaction?.state === 'committed' && status.installedAligned
          && status.activeVersion === transaction.targetVersion) {
          return setUpdateState({ state: 'committed', currentVersion: transaction.targetVersion,
            latestVersion: transaction.targetVersion, transactionId: transaction.id,
            recoveryPending: false, cancelRequested: false, code: '', message: ''
          }, { observed: true });
        }
        if (transaction?.state === 'rolled_back' && status.installedAligned
          && status.activeVersion === transaction.sourceVersion
          && (!state.transactionId || transaction.id === state.transactionId)) {
          const restored = await setUpdateState({ state: 'rolled_back', currentVersion: transaction.sourceVersion,
            transactionId: transaction.id, recoveryPending: false, cancelRequested: false,
            code: transaction.reasonCode || 'update_rolled_back', message: 'The previous version has been restored.'
          }, { observed: true });
          setTimeout(() => chrome.runtime.reload(), 0);
          return restored;
        }
        throw codedError('update_recovery_pending', 'The installed update result has not been confirmed.');
      } catch (error) {
        return setUpdateState({ state: 'failed', recoveryPending: true, cancelRequested: false,
          code: safeCode(error), message: safeMessage(error)
        }, { observed: true });
      }
    }
    return state;
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
    return setUpdateState({ postponeUntil: LEGACY_GUARD });
  }

  async function getView() {
    let [state, consent] = await Promise.all([getUpdateState(), getConsentState()]);
    const busy = state.state === 'checking' || policy.isExecutionState(state.state) || consent.authorizationId || state.cancelRequested;
    const runtime = busy ? { state: 'transaction_active' } : await readRuntimeStatus();
    if (!state.recoveryPending && !state.cancelRequested && runtime.state === 'aligned' && ['failed', 'rolled_back'].includes(state.state) &&
        policy.compareStableVersions(state.latestVersion || state.currentVersion, runtime.installedVersion) <= 0) {
      state = await setUpdateState({ ...state, state: 'idle', currentVersion: runtime.installedVersion,
        latestVersion: runtime.installedVersion, code: '', message: '', transactionId: '', blocker: '', blockers: [] });
    }
    const view = policy.deriveViewModel(state, consent, {
      currentVersion: currentVersion(),
      now: Date.now()
    });
    view.runtime = runtime;
    const pending = (await chrome.storage.local.get(MANUAL_RELOAD_TABS_KEY))?.[MANUAL_RELOAD_TABS_KEY];
    const pagesPending = runtime.state === 'aligned' && pending?.targetVersion === runtime.installedVersion && pending.tabIds?.length;
    if (runtime.state === 'reload_required' || pagesPending) {
      view.showPanel = true;
      view.state = { ...state, state: pagesPending ? 'reload_tabs_required' : 'reload_required',
        currentVersion: runtime.extensionVersion, latestVersion: runtime.installedVersion,
        code: 'update_reload_required', message: runtimeReloadMessage };
      view.badge = { text: 'UP', color: '#3578bd' };
    }
    return view;
  }

  async function readRuntimeStatus(force = false) {
    if (!root.CodexOverleafUpdateRuntimeIdentity) return { state: 'unknown' };
    if (!force && runtimeStatus && Date.now() - runtimeStatusAt < 5000) return runtimeStatus;
    if (runtimeStatusRead) return runtimeStatusRead;
    runtimeStatusRead = withTimeout(requestNative('update.status'), 4000,
      codedError('update_status_timeout', 'Installed version inspection timed out.')).then(status => {
      runtimeStatusAt = Date.now();
      runtimeStatus = root.CodexOverleafUpdateRuntimeIdentity.inspectInstalledRuntime(status, {
        extensionVersion: chrome.runtime.getManifest().version, runtimeVersion: currentVersion()
      });
      return runtimeStatus;
    }).catch(() => ({ state: 'unknown' })).finally(() => { runtimeStatusRead = null; });
    return runtimeStatusRead;
  }

  async function requireReloadSafePoint() {
    const tabs = await chrome.tabs.query({ url: OVERLEAF_MATCHES });
    const probes = await Promise.all(tabs.filter(isUsableEditorTab).map(tab => probeTabIdle(tab.id)));
    const nativeGate = await requestNative('update.canApply').then(result => ({ ok: true, result }))
      .catch(error => ({ ok: false, error: safeError(error) }));
    const blockers = root.CodexOverleafUpdateStatus?.collectBlockers(probes, nativeGate) || ['busy'];
    if (nativeBridge?.getPendingState?.().executionRequests > 0) blockers.push('background_execution_pending');
    if (blockers.length) {
      runtimeReloadMessage = 'Reload is waiting for Overleaf to be saved and idle (' + blockers.join(', ') + ').';
      throw codedError('update_reload_busy', runtimeReloadMessage);
    }
    runtimeReloadMessage = '';
    return tabs.filter(tab => Number.isInteger(tab.id) && !tab.discarded && tab.status !== 'unloaded');
  }

  async function reloadInstalledRuntime() {
    const runtime = await readRuntimeStatus(true);
    if (runtime.state === 'aligned') { await finishManualRuntimeReload(); return getView(); }
    if (runtime.state !== 'reload_required') throw codedError('update_reload_unavailable', 'No verified installed update is awaiting reload.');
    const tabs = await requireReloadSafePoint();
    await chrome.storage.local.set({ [MANUAL_RELOAD_TABS_KEY]: {
      targetVersion: runtime.installedVersion, tabIds: tabs.map(tab => tab.id)
    } });
    setTimeout(() => chrome.runtime.reload(), 0);
    return getView();
  }

  async function finishManualRuntimeReload() {
    const pending = (await chrome.storage.local.get(MANUAL_RELOAD_TABS_KEY))?.[MANUAL_RELOAD_TABS_KEY];
    if (!pending || !Array.isArray(pending.tabIds)) return;
    const runtime = await readRuntimeStatus(true);
    if (runtime.state !== 'aligned' || runtime.installedVersion !== pending.targetVersion) return;
    let tabs;
    try { tabs = await requireReloadSafePoint(); } catch (_error) { return; }
    const remaining = [];
    for (const tab of tabs.filter(tab => pending.tabIds.includes(tab.id))) {
      try { await chrome.tabs.reload(tab.id); } catch (_error) { remaining.push(tab.id); }
    }
    if (remaining.length) await chrome.storage.local.set({ [MANUAL_RELOAD_TABS_KEY]: { ...pending, tabIds: remaining } });
    else await chrome.storage.local.remove(MANUAL_RELOAD_TABS_KEY);
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

  function setUpdateState(value, options = {}) {
    return enqueueStateWrite(async () => {
      assertWriteOwner(options);
      const stored = await chrome.storage.local.get(UPDATE_STATE_KEY);
      assertWriteOwner(options);
      const previous = policy.normalizeUpdateState(stored?.[UPDATE_STATE_KEY], currentVersion());
      const next = projectUpdateState(previous, value, options);
      await chrome.storage.local.set({ [UPDATE_STATE_KEY]: next });
      return next;
    });
  }


  function projectUpdateState(previous, value, options = {}) {
    const now = Date.now();
    const candidate = {
      ...previous,
      ...value,
      initiatedBy: value.initiatedBy || previous.initiatedBy
    };
    const projection = root.CodexOverleafManagedUpdateProjection;
    let next;
    if (projection) {
      const transition = options.observed === true
        ? projection.transition
        : projection.transitionCommand;
      next = transition(previous, candidate, {
        merge: true,
        currentVersion: currentVersion(),
        now
      });
    } else {
      next = policy.normalizeUpdateState(candidate, currentVersion());
    }
    return next;
  }

  async function getConsentState() {
    const stored = await chrome.storage.local.get(CONSENT_STATE_KEY);
    return policy.normalizeConsentState(stored?.[CONSENT_STATE_KEY]);
  }

  function setConsentState(value, options = {}) {
    return enqueueStateWrite(async () => {
      assertWriteOwner(options);
      if (options.expectedAuthorizationId) {
        const current = await getConsentState();
        if (current.authorizationId !== options.expectedAuthorizationId) return current;
      }
      assertWriteOwner(options);
      const next = policy.normalizeConsentState(value);
      await chrome.storage.local.set({ [CONSENT_STATE_KEY]: next });
      return next;
    });
  }


  function setUpdateAndConsentState(updateValue, consentValue, options = {}) {
    return enqueueStateWrite(async () => {
      assertWriteOwner(options);
      const stored = await chrome.storage.local.get([UPDATE_STATE_KEY, CONSENT_STATE_KEY]);
      assertWriteOwner(options);
      const previous = policy.normalizeUpdateState(stored?.[UPDATE_STATE_KEY], currentVersion());
      const updateState = projectUpdateState(previous, updateValue, options);
      const consentState = policy.normalizeConsentState(consentValue);
      await chrome.storage.local.set({ [UPDATE_STATE_KEY]: updateState, [CONSENT_STATE_KEY]: consentState });
      return { updateState, consentState };
    });
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

  function enqueuePolicyAction(action) {
    const generation = operationGeneration;
    const guarded = () => generation !== operationGeneration || cancellationPromise ? getView() : action();
    const result = policyTail.then(guarded, guarded);
    policyTail = result.catch(() => {});
    return result;
  }

  function beginOperation(id) {
    const operation = { id: id || crypto.randomUUID(), generation: ++operationGeneration, phase: 'checking' };
    activeOperation = operation;
    return operation;
  }

  function isCurrentOperation(operation) {
    return activeOperation === operation && operation.generation === operationGeneration;
  }

  function assertOperation(operation) {
    if (!isCurrentOperation(operation)) throw codedError('update_network_cancelled', 'The update request was cancelled.');
  }

  function finishOperation(operation) {
    if (activeOperation === operation) activeOperation = null;
  }

  function assertWriteOwner(options) {
    if (options.operation) assertOperation(options.operation);
    if (options.generation !== undefined && options.generation !== operationGeneration) {
      throw codedError('update_network_cancelled', 'The update request was superseded.');
    }
  }

  function enqueueStateWrite(action) {
    const result = stateWriteTail.then(action, action);
    stateWriteTail = result.catch(() => {});
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
        (['overleaf.com', 'www.overleaf.com', 'cn.overleaf.com'].includes(url.hostname)) &&
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
