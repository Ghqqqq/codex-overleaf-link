(function initBootstrapMigration(root) {
  'use strict';

  const UPDATE_STATE_KEY = 'codex-overleaf-managed-update-state-v1';
  const RETRY_ALARM = 'codex-overleaf-bootstrap-migration-retry';
  const RETRY_MS = 4000;
  const MAX_WAIT_MS = 2 * 60 * 1000;
  let readyPromise;
  let lockedOwner;
  let setExecutionLocked;

  function init(options) {
    if (readyPromise) return readyPromise;
    readyPromise = prepare(options);
    return readyPromise;
  }

  async function prepare(options) {
    let transaction;
    const revision = String(root.__CODEX_OVERLEAF_BOOTSTRAP_REVISION__ || '');
    const request = async (method, params = {}) => {
      const response = await options.request({ id: crypto.randomUUID(), method,
        params: { ...params, bootstrapRevision: revision } });
      if (!response?.ok) throw Object.assign(new Error(response?.error?.message || 'Managed update request failed.'),
        { code: response?.error?.code || 'update_health_failed' });
      return response.result || {};
    };
    try {
      const status = await request('update.status');
      transaction = status.transaction;
      if (transaction?.state !== 'bootstrap_pending') return { continueInitialization: true };
      options.setExecutionLocked(true);
      lockedOwner = { id: transaction.id, targetVersion: transaction.targetVersion, revision };
      setExecutionLocked = options.setExecutionLocked;
      if (!transaction.id || transaction.targetVersion !== root.CodexOverleafCompatibility?.BUILD_TARGET_VERSION) {
        throw codedError('The running update does not match the pending Bootstrap transaction.');
      }
      await writeState({ state: 'awaiting_health', transactionId: transaction.id,
        latestVersion: transaction.targetVersion, code: '', message: '' });

      // The first reload may leave old content contexts alive. Recheck the same
      // idle/save contract before replacing their loader and reloading again.
      const deadline = Date.now() + MAX_WAIT_MS;
      while (revision !== '3.1') {
        const gate = await options.verifySafety();
        if (gate?.ok) break;
        if (Date.now() >= deadline) throw codedError('The Bootstrap update did not reach a safe point.');
        await writeState({ blockers: gate?.error?.blockers || ['busy'] });
        await waitForRetry();
        const refreshed = await request('update.status');
        if (refreshed.transaction?.id !== transaction.id || refreshed.transaction?.state !== 'bootstrap_pending') {
          throw codedError('The pending Bootstrap transaction changed before activation.');
        }
      }

      const result = await request('update.bootstrap', { transactionId: transaction.id });
      if (result.transactionId !== transaction.id || result.targetVersion !== transaction.targetVersion) {
        throw codedError('The Bootstrap activation result does not match the pending update.');
      }
      await writeState({ blockers: [], blocker: '' });
      if (result.state === 'reload_required') {
        // Only one reload per worker. Native owns the persistent attempt limit
        // so a broken target cannot create a loop across worker restarts.
        chrome.runtime.reload();
        return { continueInitialization: false, state: result.state };
      }
      if (result.state !== 'awaiting_health' || revision !== '3.1' || result.bootstrapRevision !== revision) {
        throw codedError('The updated Bootstrap did not provide its loaded revision.');
      }
      return { continueInitialization: true, state: result.state };
    } catch (error) {
      if (!transaction || transaction.state !== 'bootstrap_pending') return { continueInitialization: true };
      const code = /^[a-z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'update_health_failed';
      await writeState({ state: 'rolling_back', code }).catch(() => {});
      try {
        const rollback = await request('update.rollback', { transactionId: transaction.id,
          expectedState: 'bootstrap_pending', reasonCode: code });
        const status = await request('update.status');
        if (!hasRestoredSource(transaction, rollback, status)) throw codedError('Bootstrap rollback is unconfirmed.');
        await writeState({ state: 'rolled_back', currentVersion: transaction.sourceVersion,
          transactionId: transaction.id, recoveryPending: false, blockers: [], blocker: '', code });
        chrome.runtime.reload();
        return { continueInitialization: false, state: 'rolled_back' };
      } catch (_rollbackError) {
        await writeState({ state: 'failed', recoveryPending: true, transactionId: transaction.id,
          code: 'update_recovery_pending', message: 'The installed update result has not been confirmed.' }).catch(() => {});
        return { continueInitialization: false, state: 'failed' };
      }
    } finally {
      await chrome.alarms?.clear?.(RETRY_ALARM).catch?.(() => {});
    }
  }

  async function writeState(patch) {
    const stored = await chrome.storage.local.get(UPDATE_STATE_KEY);
    const state = root.CodexOverleafManagedUpdateProjection.transition(stored[UPDATE_STATE_KEY] || {}, patch,
      { currentVersion: chrome.runtime.getManifest().version });
    await chrome.storage.local.set({ [UPDATE_STATE_KEY]: state });
  }

  function waitForRetry() {
    return new Promise(resolve => {
      let settled = false;
      let timer;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        chrome.alarms?.onAlarm?.removeListener?.(onAlarm);
        resolve();
      };
      const onAlarm = alarm => { if (alarm?.name === RETRY_ALARM) finish(); };
      chrome.alarms?.onAlarm?.addListener?.(onAlarm);
      chrome.alarms?.create?.(RETRY_ALARM, { delayInMinutes: 0.5 });
      timer = setTimeout(finish, RETRY_MS);
    });
  }

  function hasRestoredSource(transaction, rollback, status) {
    const pair = status?.restoredPair;
    return rollback?.transactionId === transaction.id && rollback.state === 'rolled_back'
      && rollback.version === transaction.sourceVersion && status?.transaction?.id === transaction.id
      && status.transaction.state === 'rolled_back' && status.activeVersion === transaction.sourceVersion
      && status.installedAligned === true && pair?.extensionVersion === transaction.sourceVersion
      && pair?.nativeVersion === transaction.sourceVersion
      && /^[0-9a-f]{64}$/.test(pair.extensionSha256 || '') && /^[0-9a-f]{64}$/.test(pair.nativeSha256 || '')
      && /^[0-9a-f]{64}$/.test(pair.bootstrapSha256 || '')
      && ['extensionVersion', 'nativeVersion', 'extensionSha256', 'nativeSha256', 'bootstrapSha256']
        .every(key => pair[key] === rollback.restoredPair?.[key]);
  }

  function codedError(message) {
    return Object.assign(new Error(message), { code: 'update_health_failed' });
  }

  function observeConfirmation(params, response) {
    if (!lockedOwner || !response?.ok || response.result?.state !== 'committed'
      || response.result.version !== lockedOwner.targetVersion || params?.transactionId !== lockedOwner.id
      || params.extensionVersion !== lockedOwner.targetVersion || params.nativeVersion !== lockedOwner.targetVersion
      || params.bootstrapRevision !== lockedOwner.revision || lockedOwner.revision !== '3.1') return;
    lockedOwner = null;
    setExecutionLocked(false);
  }

  root.CodexOverleafBootstrapMigration = Object.freeze({
    init,
    observeConfirmation,
    ready: () => readyPromise || Promise.resolve({ continueInitialization: true })
  });
})(globalThis);
