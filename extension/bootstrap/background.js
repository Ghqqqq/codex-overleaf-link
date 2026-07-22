'use strict';

const CODEX_OVERLEAF_HOST = 'com.codex.overleaf';
const RUNTIME_SCRIPT_ID = 'codex-overleaf-managed-runtime';
const UPDATE_STATE_KEY = 'codex-overleaf-managed-update-state-v1';
const UPDATE_RELOAD_TABS_KEY = 'codex-overleaf-managed-update-tabs-v1';
const CHECK_ALARM = 'codex-overleaf-stable-update-check';
const IDLE_ALARM = 'codex-overleaf-staged-update-idle';
const OVERLEAF_EDITOR_MATCHES = [
  'https://www.overleaf.com/project/*',
  'https://overleaf.com/project/*'
];
const OVERLEAF_MATCHES = [
  'https://www.overleaf.com/project',
  'https://overleaf.com/project',
  ...OVERLEAF_EDITOR_MATCHES
];
const APPLYING_STATES = new Set(['applying', 'awaiting_health', 'rolling_back']);
const FAST_IDLE_RETRY_BLOCKERS = new Set(['recent_user_activity', 'save_state_not_stable']);
const FAST_IDLE_RETRY_MS = 4000;
const SLOW_IDLE_RETRY_MS = 15000;
const IDLE_RETRY_ALARM_MINUTES = 0.5;
const RUNTIME_RECOVERY_SETTLE_MS = 250;

let idleRetryTimer = null;
let idleApplyPromise = null;
let managedRuntimeAssets = null;

let runtimeLoadError = null;
try {
  globalThis.__CODEX_OVERLEAF_RUNTIME_BASE__ = 'runtime';
  importScripts(
    chrome.runtime.getURL('bootstrap/updateStatus.js'),
    chrome.runtime.getURL('runtime/src/shared/compatibility.js'),
    chrome.runtime.getURL('runtime/src/background.js')
  );
} catch (error) {
  runtimeLoadError = error;
}

globalThis.CodexOverleafManagedUpdateExecutor = Object.freeze({
  installAuthorizedUpdate: () => checkAndStage({ manual: true })
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'codex-overleaf/update-get-state') {
    getUpdateState().then(sendResponse);
    return true;
  }
  if (message?.type === 'codex-overleaf/update-check-now') {
    checkAndStage({ manual: true }).then(sendResponse).catch(error => sendResponse(failureBody(error)));
    return true;
  }
  if (message?.type === 'codex-overleaf/update-postpone') {
    postponeUpdate().then(sendResponse);
    return true;
  }
  return undefined;
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === CHECK_ALARM) {
    checkAndStage().catch(() => {});
  }
  if (alarm.name === IDLE_ALARM) {
    tryApplyStagedUpdate().catch(() => {});
  }
});

initializeBootstrap().catch(async error => {
  await setUpdateState({ state: 'failed', code: safeCode(error), message: safeMessage(error) });
});

async function initializeBootstrap() {
  try {
    await registerManagedRuntime();
  } catch (error) {
    runtimeLoadError = runtimeLoadError || error;
  }

  if (runtimeLoadError) {
    await rollbackBrokenRuntime(runtimeLoadError);
    return;
  }

  const nativeStatus = await requestInternal({ method: 'update.status', params: {} }).catch(() => null);
  const transaction = nativeStatus?.ok ? nativeStatus.result?.transaction : null;
  if (transaction?.state === 'awaiting_health') {
    await confirmPendingUpdate(transaction);
  } else if (transaction?.state === 'rolled_back') {
    await reloadPendingOverleafTabs();
  }

  chrome.alarms.create(CHECK_ALARM, { delayInMinutes: 0.5, periodInMinutes: 24 * 60 });
  const state = await getUpdateState();
  if (state.state === 'staged' || state.state === 'waiting_for_idle') {
    scheduleIdleRetry(state.blockers);
  }
}

async function registerManagedRuntime() {
  const response = await fetch(chrome.runtime.getURL('runtime/runtime-manifest.json'), { cache: 'no-store' });
  if (!response.ok) {
    throw new Error('Managed runtime manifest could not be loaded.');
  }
  const manifest = await response.json();
  validateRuntimeManifest(manifest);
  managedRuntimeAssets = {
    js: ['bootstrap/runtimeContext.js', ...manifest.js.map(value => 'runtime/' + value)],
    css: manifest.css.map(value => 'runtime/' + value)
  };
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [RUNTIME_SCRIPT_ID] });
  if (registered.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [RUNTIME_SCRIPT_ID] });
  }
  await chrome.scripting.registerContentScripts([{
    id: RUNTIME_SCRIPT_ID,
    matches: manifest.matches,
    js: managedRuntimeAssets.js,
    css: managedRuntimeAssets.css,
    runAt: manifest.runAt || 'document_idle',
    persistAcrossSessions: true
  }]);
}

function validateRuntimeManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.matches) || !Array.isArray(manifest.js) || !Array.isArray(manifest.css)) {
    throw new Error('Managed runtime manifest is invalid.');
  }
  if (!manifest.matches.length || manifest.matches.some(value => !OVERLEAF_MATCHES.includes(value))) {
    throw new Error('Managed runtime match patterns are invalid.');
  }
  const paths = [...manifest.js, ...manifest.css];
  if (!manifest.js.length || paths.some(value => typeof value !== 'string' || value.startsWith('/') || value.includes('..') || !/^[a-zA-Z0-9_./-]+$/.test(value))) {
    throw new Error('Managed runtime file list is invalid.');
  }
}

async function checkAndStage(options = {}) {
  const current = await getUpdateState();
  if (APPLYING_STATES.has(current.state)) {
    return current;
  }
  if (['staged', 'waiting_for_idle'].includes(current.state) && current.transactionId) {
    return tryApplyStagedUpdate();
  }
  if (!options.manual && Number(current.postponeUntil || 0) > Date.now()) {
    return current;
  }
  await setUpdateState({ ...current, state: 'checking', blocker: '', blockers: [], code: '', message: '' });
  const checked = await requestInternal({
    method: 'update.check',
    params: {
      currentVersion: chrome.runtime.getManifest().version,
      etag: current.etag || ''
    }
  });
  if (!checked?.ok) {
    const code = checked?.error?.code || 'update_check_failed';
    if (code === 'update_not_managed') {
      return setUpdateState({ state: 'idle', managed: false, code, message: checked.error.message });
    }
    throw nativeError(checked);
  }
  const checkResult = checked.result || {};
  if (!checkResult.available) {
    return setUpdateState({
      state: 'idle',
      managed: checkResult.managed !== false,
      currentVersion: chrome.runtime.getManifest().version,
      latestVersion: checkResult.latestVersion || chrome.runtime.getManifest().version,
      etag: checkResult.etag || current.etag || '',
      lastCheckedAt: Date.now(),
      code: checkResult.reason || '',
      message: ''
    });
  }

  await setUpdateState({
    ...current,
    state: 'update_available',
    managed: true,
    currentVersion: chrome.runtime.getManifest().version,
    latestVersion: checkResult.latestVersion,
    etag: checkResult.etag || '',
    lastCheckedAt: Date.now()
  });
  await setUpdateState({ state: 'downloading', managed: true, currentVersion: chrome.runtime.getManifest().version, latestVersion: checkResult.latestVersion });
  const staged = await requestInternal({ method: 'update.stage', params: {} });
  if (!staged?.ok) {
    throw nativeError(staged);
  }
  await setUpdateState({
    state: 'staged',
    managed: true,
    currentVersion: chrome.runtime.getManifest().version,
    latestVersion: staged.result.targetVersion,
    transactionId: staged.result.transactionId,
    stagedAt: Date.now(),
    blocker: '',
    blockers: []
  });
  await broadcastUpdateState('staged');
  return tryApplyStagedUpdate();
}

function tryApplyStagedUpdate() {
  if (idleApplyPromise) return idleApplyPromise;
  idleApplyPromise = tryApplyStagedUpdateCore().finally(() => {
    idleApplyPromise = null;
  });
  return idleApplyPromise;
}

async function tryApplyStagedUpdateCore() {
  cancelIdleRetryTimer();
  const state = await getUpdateState();
  if (!['staged', 'waiting_for_idle'].includes(state.state)) {
    await clearIdleRetry();
    return state;
  }
  if (Number(state.postponeUntil || 0) > Date.now()) {
    return state;
  }
  const surfaceTabs = await chrome.tabs.query({ url: OVERLEAF_MATCHES });
  const activeTabs = surfaceTabs.filter(tab => isEditorProjectTab(tab) && !tab.discarded && tab.status !== 'unloaded');
  const refreshTabs = surfaceTabs.filter(tab => !tab.discarded && tab.status !== 'unloaded');
  const probes = await Promise.all(activeTabs.map(tab => probeTabIdle(tab)));
  const nativeGate = await requestInternal({ method: 'update.canApply', params: {} }).catch(error => ({
    ok: false,
    error: { code: safeCode(error), message: safeMessage(error) }
  }));
  const blockers = globalThis.CodexOverleafUpdateStatus?.collectBlockers(probes, nativeGate)
    || ['busy'];
  if (blockers.length) {
    const waiting = await setUpdateState({
      ...state,
      state: 'waiting_for_idle',
      blocker: blockers[0],
      blockers
    });
    await broadcastUpdateState('waiting_for_idle');
    scheduleIdleRetry(blockers);
    return waiting;
  }

  await clearIdleRetry();
  await chrome.storage.local.set({ [UPDATE_RELOAD_TABS_KEY]: refreshTabs.map(tab => tab.id).filter(Number.isInteger) });
  await setUpdateState({ ...state, state: 'applying', blocker: '', blockers: [] });
  await broadcastUpdateState('applying');
  const applied = await requestInternal({
    method: 'update.apply',
    params: { transactionId: state.transactionId }
  });
  if (!applied?.ok) {
    throw nativeError(applied);
  }
  await setUpdateState({ ...state, state: 'awaiting_health', latestVersion: applied.result.targetVersion });
  chrome.runtime.reload();
  return { state: 'awaiting_health' };
}

function scheduleIdleRetry(blockers = []) {
  cancelIdleRetryTimer();
  const values = Array.isArray(blockers) ? blockers.filter(Boolean) : [];
  const onlyFastBlockers = values.length > 0 && values.every(value => FAST_IDLE_RETRY_BLOCKERS.has(value));
  const delayMs = onlyFastBlockers ? FAST_IDLE_RETRY_MS : SLOW_IDLE_RETRY_MS;
  idleRetryTimer = setTimeout(() => {
    idleRetryTimer = null;
    tryApplyStagedUpdate().catch(() => {});
  }, delayMs);
  chrome.alarms.create(IDLE_ALARM, { delayInMinutes: IDLE_RETRY_ALARM_MINUTES });
}

function cancelIdleRetryTimer() {
  if (idleRetryTimer !== null) {
    clearTimeout(idleRetryTimer);
    idleRetryTimer = null;
  }
}

async function clearIdleRetry() {
  cancelIdleRetryTimer();
  await chrome.alarms.clear(IDLE_ALARM).catch(() => {});
}

async function probeTabIdle(tab) {
  if (!Number.isInteger(tab?.id)) {
    return { idle: false, blockers: ['tab_unavailable'] };
  }
  if (!isEditorProjectTab(tab)) {
    return { idle: true, saved: true, ignored: true, blockers: [] };
  }
  if (tab.discarded || tab.status === 'unloaded') {
    return { idle: true, saved: true, ignored: true, blockers: [] };
  }
  const firstProbe = await sendTabIdleProbe(tab.id);
  if (firstProbe) return firstProbe;
  if (await injectManagedRuntimeIntoTab(tab.id)) {
    const recoveredProbe = await sendTabIdleProbe(tab.id);
    if (recoveredProbe) return recoveredProbe;
  }
  return { idle: false, blockers: ['tab_probe_unavailable'] };
}

function isEditorProjectTab(tab) {
  try {
    const url = new URL(tab?.url || '');
    return url.protocol === 'https:' &&
      (url.hostname === 'www.overleaf.com' || url.hostname === 'overleaf.com') &&
      /^\/project\/[^/]+(?:\/|$)/.test(url.pathname);
  } catch (_error) {
    return false;
  }
}

async function sendTabIdleProbe(tabId) {
  try {
    return await withTimeout(
      chrome.tabs.sendMessage(tabId, { type: 'codex-overleaf/update-idle-probe' }),
      3500,
      { idle: false, blockers: ['tab_probe_timeout'] }
    );
  } catch (_error) {
    return null;
  }
}

async function injectManagedRuntimeIntoTab(tabId) {
  if (!managedRuntimeAssets) return false;
  try {
    if (managedRuntimeAssets.css.length) {
      await chrome.scripting.insertCSS({ target: { tabId }, files: managedRuntimeAssets.css });
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: managedRuntimeAssets.js });
    await new Promise(resolve => setTimeout(resolve, RUNTIME_RECOVERY_SETTLE_MS));
    return true;
  } catch (_error) {
    return false;
  }
}

async function confirmPendingUpdate(transaction) {
  const targetVersion = transaction.targetVersion;
  const runtimeHealthy = await verifyPendingRuntimeHealth(targetVersion);
  if (!runtimeHealthy) {
    await rollbackBrokenRuntime(new Error('Updated Overleaf content runtime did not report the target version.'));
    return;
  }
  const ping = await requestInternal({ method: 'bridge.ping', params: {} }).catch(() => null);
  if (!ping?.ok || ping.result?.version !== targetVersion) {
    await rollbackBrokenRuntime(new Error('Updated native host did not report the target version.'));
    return;
  }
  const confirmed = await requestInternal({
    method: 'update.confirm',
    params: {
      transactionId: transaction.id,
      extensionVersion: chrome.runtime.getManifest().version,
      nativeVersion: ping.result.version
    }
  });
  if (!confirmed?.ok) {
    await rollbackBrokenRuntime(nativeError(confirmed));
    return;
  }
  await setUpdateState({
    state: 'committed',
    managed: true,
    currentVersion: targetVersion,
    latestVersion: targetVersion,
    lastCheckedAt: Date.now()
  });
  await chrome.storage.local.remove(UPDATE_RELOAD_TABS_KEY);
  await broadcastUpdateState('committed');
}

async function verifyPendingRuntimeHealth(targetVersion) {
  const tabIds = await getPendingOverleafTabIds();
  if (!tabIds.length) return true;
  await Promise.allSettled(tabIds.map(tabId => chrome.tabs.reload(tabId)));
  const remaining = new Set(tabIds);
  const deadline = Date.now() + 20000;
  while (remaining.size && Date.now() < deadline) {
    await Promise.all([...remaining].map(async tabId => {
      try {
        const response = await withTimeout(
          chrome.tabs.sendMessage(tabId, { type: 'codex-overleaf/runtime-health-probe' }),
          2500,
          null
        );
        if (response?.ok === true && response.version === targetVersion) {
          remaining.delete(tabId);
        }
      } catch (_error) {
        // The tab may still be reloading; retry until the bounded deadline.
      }
    }));
    if (remaining.size) await new Promise(resolve => setTimeout(resolve, 250));
  }
  return remaining.size === 0;
}

async function rollbackBrokenRuntime(error) {
  await setUpdateState({ state: 'rolling_back', code: safeCode(error), message: safeMessage(error) });
  const rolledBack = await requestInternal({
    method: 'update.rollback',
    params: { reasonCode: safeCode(error) }
  }).catch(() => null);
  if (rolledBack?.ok) {
    await setUpdateState({ state: 'rolled_back', code: safeCode(error), currentVersion: rolledBack.result.version });
    chrome.runtime.reload();
    return;
  }
  await setUpdateState({ state: 'failed', code: safeCode(error), message: safeMessage(error) });
}

async function reloadPendingOverleafTabs() {
  const tabIds = await getPendingOverleafTabIds();
  await chrome.storage.local.remove(UPDATE_RELOAD_TABS_KEY);
  await Promise.allSettled(tabIds.map(tabId => chrome.tabs.reload(tabId)));
}

async function getPendingOverleafTabIds() {
  const stored = await chrome.storage.local.get(UPDATE_RELOAD_TABS_KEY);
  const tabIds = Array.isArray(stored[UPDATE_RELOAD_TABS_KEY]) ? stored[UPDATE_RELOAD_TABS_KEY] : [];
  const openTabs = await chrome.tabs.query({ url: OVERLEAF_MATCHES });
  const openIds = new Set(openTabs.map(tab => tab.id).filter(Number.isInteger));
  return [...new Set(tabIds.filter(tabId => Number.isInteger(tabId) && openIds.has(tabId)))];
}

async function postponeUpdate() {
  const state = await getUpdateState();
  return setUpdateState({ ...state, postponeUntil: Date.now() + 24 * 60 * 60 * 1000 });
}

async function requestInternal(payload) {
  if (globalThis.CodexOverleafNativeBridge?.requestInternal) {
    return globalThis.CodexOverleafNativeBridge.requestInternal({
      id: crypto.randomUUID(),
      ...payload
    });
  }
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(CODEX_OVERLEAF_HOST, {
      id: crypto.randomUUID(),
      ...payload
    }, response => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

async function getUpdateState() {
  const stored = await chrome.storage.local.get(UPDATE_STATE_KEY);
  return stored[UPDATE_STATE_KEY] || {
    state: 'idle',
    managed: true,
    currentVersion: chrome.runtime.getManifest().version,
    latestVersion: chrome.runtime.getManifest().version
  };
}

async function setUpdateState(next) {
  const blockers = globalThis.CodexOverleafUpdateStatus?.normalizeBlockers(
    Array.isArray(next.blockers) ? next.blockers : (next.blocker ? [next.blocker] : [])
  ) || [];
  const value = {
    state: next.state || 'idle',
    managed: next.managed !== false,
    currentVersion: next.currentVersion || chrome.runtime.getManifest().version,
    latestVersion: next.latestVersion || next.currentVersion || chrome.runtime.getManifest().version,
    etag: next.etag || '',
    lastCheckedAt: Number(next.lastCheckedAt || 0),
    stagedAt: Number(next.stagedAt || 0),
    postponeUntil: Number(next.postponeUntil || 0),
    transactionId: next.transactionId || '',
    blocker: blockers[0] || '',
    blockers,
    code: next.code || '',
    message: String(next.message || '').slice(0, 300)
  };
  await chrome.storage.local.set({ [UPDATE_STATE_KEY]: value });
  return value;
}

async function broadcastUpdateState(state) {
  const tabs = await chrome.tabs.query({ url: OVERLEAF_MATCHES });
  await Promise.allSettled(tabs.filter(tab => Number.isInteger(tab.id)).map(tab => (
    chrome.tabs.sendMessage(tab.id, { type: 'codex-overleaf/update-state', state })
  )));
}

function withTimeout(promise, timeoutMs, fallback) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), timeoutMs))
  ]);
}

function nativeError(response) {
  const error = new Error(response?.error?.message || 'Managed update request failed.');
  error.code = response?.error?.code || 'update_request_failed';
  return error;
}

function safeCode(error) {
  return /^[a-z0-9_]{1,80}$/.test(String(error?.code || '')) ? error.code : 'update_health_failed';
}

function safeMessage(error) {
  return String(error?.message || 'Managed update failed.').replace(/(?:file:\/\/)?(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/)[^\s]*/g, '[local path]').slice(0, 300);
}

function failureBody(error) {
  return { ok: false, error: { code: safeCode(error), message: safeMessage(error) } };
}
