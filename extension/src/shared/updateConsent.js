(function initCodexOverleafUpdateConsent(root, factory) {
  'use strict';

  const api = factory();
  root.CodexOverleafUpdateConsent = api;
  if (typeof module === 'object' && module?.exports) {
    module.exports = api;
  }
})(typeof globalThis === 'object' ? globalThis : this, function createUpdateConsentApi() {
  'use strict';

  const UPDATE_STATES = new Set([
    'idle',
    'checking',
    'update_available',
    'downloading',
    'staged',
    'waiting_for_idle',
    'applying',
    'awaiting_health',
    'rolling_back',
    'committed',
    'rolled_back',
    'failed'
  ]);
  const EXECUTION_STATES = new Set([
    'downloading',
    'staged',
    'waiting_for_idle',
    'applying',
    'awaiting_health',
    'rolling_back'
  ]);
  const TERMINAL_STATES = new Set(['committed', 'rolled_back', 'failed']);
  const QUIET_FAILURE_CODES = new Set([
    'update_network_failed',
    'update_network_unavailable',
    'update_github_http_error'
  ]);
  const PROGRESS = Object.freeze({
    idle: { value: 0, determinate: true, phase: 'idle' },
    checking: { value: 0, determinate: false, phase: 'checking' },
    update_available: { value: 0, determinate: true, phase: 'available' },
    downloading: { value: 35, determinate: false, phase: 'downloading' },
    staged: { value: 65, determinate: true, phase: 'staged' },
    waiting_for_idle: { value: 65, determinate: true, phase: 'waiting' },
    applying: { value: 82, determinate: false, phase: 'applying' },
    awaiting_health: { value: 94, determinate: false, phase: 'health' },
    rolling_back: { value: 94, determinate: false, phase: 'rollback' },
    committed: { value: 100, determinate: true, phase: 'committed' },
    rolled_back: { value: 94, determinate: true, phase: 'rolled_back' },
    failed: { value: 0, determinate: true, phase: 'failed' }
  });

  function normalizeUpdateState(value = {}, currentVersion = '') {
    const blockers = Array.isArray(value.blockers)
      ? value.blockers.map(safeToken).filter(Boolean).slice(0, 12)
      : [safeToken(value.blocker)].filter(Boolean);
    const state = UPDATE_STATES.has(value.state) ? value.state : 'idle';
    return {
      state,
      managed: value.managed !== false,
      currentVersion: safeVersion(value.currentVersion) || safeVersion(currentVersion),
      latestVersion: safeVersion(value.latestVersion) || safeVersion(value.currentVersion) || safeVersion(currentVersion),
      etag: String(value.etag || '').slice(0, 300),
      blocker: blockers[0] || '',
      blockers,
      transactionId: safeId(value.transactionId),
      initiatedBy: ['automatic', 'manual'].includes(value.initiatedBy) ? value.initiatedBy : '',
      lastCheckedAt: finiteNumber(value.lastCheckedAt),
      stagedAt: finiteNumber(value.stagedAt),
      phaseStartedAt: finiteNumber(value.phaseStartedAt),
      deadlineAt: finiteNumber(value.deadlineAt),
      heartbeatAt: finiteNumber(value.heartbeatAt),
      postponeUntil: finiteNumber(value.postponeUntil),
      code: safeToken(value.code),
      message: String(value.message || '').replace(/\s+/g, ' ').trim().slice(0, 300)
    };
  }

  function normalizeConsentState(value = {}) {
    return {
      schemaVersion: 1,
      mode: 'consent',
      snoozedVersion: safeVersion(value.snoozedVersion),
      snoozedUntil: finiteNumber(value.snoozedUntil),
      authorizedVersion: safeVersion(value.authorizedVersion),
      authorizationId: safeId(value.authorizationId),
      authorizedAt: finiteNumber(value.authorizedAt),
      revokingAuthorizationId: safeId(value.revokingAuthorizationId),
      revokingVersion: safeVersion(value.revokingVersion),
      revokingTransactionId: safeId(value.revokingTransactionId),
      revokingAt: finiteNumber(value.revokingAt),
      lastPromptedVersion: safeVersion(value.lastPromptedVersion),
      lastPromptedAt: finiteNumber(value.lastPromptedAt)
    };
  }

  function deriveViewModel(updateValue = {}, consentValue = {}, options = {}) {
    const now = finiteNumber(options.now) || Date.now();
    const state = normalizeUpdateState(updateValue, options.currentVersion);
    const consent = normalizeConsentState(consentValue);
    const newer = compareStableVersions(state.latestVersion, state.currentVersion) > 0;
    const snoozed = newer &&
      consent.snoozedVersion === state.latestVersion &&
      consent.snoozedUntil > now;
    const execution = EXECUTION_STATES.has(state.state);
    const available = state.state === 'update_available' && newer;
    const progress = getProgressModel(state);
    const quietFailure = state.state === 'failed' &&
      state.initiatedBy !== 'manual' &&
      QUIET_FAILURE_CODES.has(state.code);
    const visibleFailure = state.state === 'failed' &&
      (state.initiatedBy === 'manual' || (!quietFailure && newer));

    return {
      state,
      consent: {
        mode: consent.mode,
        snoozedVersion: consent.snoozedVersion,
        snoozedUntil: consent.snoozedUntil,
        authorizedVersion: consent.authorizedVersion,
        authorizedAt: consent.authorizedAt
      },
      progress,
      available,
      snoozed,
      execution,
      showPanel: (available && !snoozed) || execution || state.state === 'rolled_back' ||
        visibleFailure,
      badge: getBadge(state, { available, snoozed }),
      actions: {
        check: ['idle', 'committed', 'rolled_back', 'failed'].includes(state.state),
        install: available,
        later: available || ['staged', 'waiting_for_idle'].includes(state.state),
        retry: ['failed', 'rolled_back'].includes(state.state)
      }
    };
  }

  function getProgressModel(stateValue = {}) {
    const state = normalizeUpdateState(stateValue);
    const base = PROGRESS[state.state] || PROGRESS.idle;
    return {
      ...base,
      blocker: state.blocker,
      code: state.code,
      message: state.message
    };
  }

  function getBadge(state, flags) {
    if (state.state === 'applying' || state.state === 'awaiting_health' || state.state === 'rolling_back') {
      return { text: '...', color: '#3578bd' };
    }
    if (state.state === 'failed' || state.state === 'rolled_back') {
      return { text: '!', color: '#b85450' };
    }
    if (flags.available) {
      return { text: 'UP', color: flags.snoozed ? '#6f6755' : '#3578bd' };
    }
    return { text: '', color: '#3578bd' };
  }

  function isExecutionState(value) {
    return EXECUTION_STATES.has(String(value || ''));
  }

  function isTerminalState(value) {
    return TERMINAL_STATES.has(String(value || ''));
  }

  function compareStableVersions(left, right) {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (!a || !b) return 0;
    for (let index = 0; index < 3; index += 1) {
      if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    }
    return 0;
  }

  function parseVersion(value) {
    const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
    return match ? match.slice(1).map(Number) : null;
  }

  function safeVersion(value) {
    return parseVersion(value) ? String(value) : '';
  }

  function safeToken(value) {
    const token = String(value || '');
    return /^[a-z0-9_.-]{1,100}$/i.test(token) ? token : '';
  }

  function safeId(value) {
    const id = String(value || '');
    return /^[a-z0-9-]{1,100}$/i.test(id) ? id : '';
  }

  function finiteNumber(value) {
    const number = Number(value || 0);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  }

  return Object.freeze({
    compareStableVersions,
    deriveViewModel,
    getProgressModel,
    isExecutionState,
    isTerminalState,
    normalizeConsentState,
    normalizeUpdateState
  });
});
