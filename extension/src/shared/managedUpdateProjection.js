(function initCodexOverleafManagedUpdateProjection(root) {
  'use strict';

  const PHASE_ALIASES = Object.freeze({
    waiting: 'waiting_for_idle',
    waiting_for_safe_point: 'waiting_for_idle',
    awaiting_health_check: 'awaiting_health',
    health_checking: 'awaiting_health'
  });

  const PHASES = Object.freeze([
    'idle',
    'up_to_date',
    'checking',
    'update_available',
    'downloading',
    'staged',
    'waiting_for_idle',
    'applying',
    'awaiting_health',
    'committed',
    'failed',
    'rolling_back',
    'rolled_back',
    'deferred'
  ]);

  const PHASE_TIMEOUTS = Object.freeze({
    checking: 30 * 1000,
    downloading: 2 * 60 * 1000,
    applying: 90 * 1000,
    awaiting_health: 2 * 60 * 1000,
    rolling_back: 60 * 1000
  });

  const PROGRESS = Object.freeze({
    checking: 8,
    update_available: 0,
    downloading: 25,
    staged: 48,
    waiting_for_idle: 55,
    applying: 75,
    awaiting_health: 90,
    committed: 100,
    rolled_back: 100
  });

  const ACTIVE_STAGE = Object.freeze({
    downloading: 0,
    staged: 1,
    waiting_for_idle: 1,
    applying: 2,
    awaiting_health: 2,
    committed: 3
  });

  const ACTIVE_PHASES = Object.freeze({
    update_page: Object.freeze([
      'checking',
      'downloading',
      'staged',
      'waiting_for_idle',
      'applying',
      'awaiting_health'
    ]),
    panel: Object.freeze([
      'downloading',
      'staged',
      'waiting_for_idle',
      'applying',
      'awaiting_health'
    ])
  });

  const TRANSITIONS = Object.freeze({
    idle: Object.freeze(['checking']),
    up_to_date: Object.freeze(['checking', 'idle']),
    checking: Object.freeze(['idle', 'up_to_date', 'update_available', 'failed']),
    update_available: Object.freeze(['checking', 'downloading', 'deferred', 'failed']),
    downloading: Object.freeze(['staged', 'failed']),
    staged: Object.freeze(['waiting_for_idle', 'applying', 'update_available', 'deferred', 'failed']),
    waiting_for_idle: Object.freeze(['applying', 'update_available', 'deferred', 'failed']),
    applying: Object.freeze(['staged', 'awaiting_health', 'rolling_back', 'failed']),
    awaiting_health: Object.freeze(['staged', 'committed', 'rolling_back', 'failed']),
    committed: Object.freeze(['checking', 'idle']),
    failed: Object.freeze(['checking', 'rolling_back', 'update_available', 'idle']),
    rolling_back: Object.freeze(['rolled_back', 'failed']),
    rolled_back: Object.freeze(['checking', 'idle']),
    deferred: Object.freeze(['checking', 'update_available', 'idle'])
  });

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function unwrap(value) {
    const source = asObject(value);
    return source.state && typeof source.state === 'object' && !Array.isArray(source.state)
      ? source.state
      : source;
  }

  function normalizePhase(value) {
    const normalized = String(value || 'idle').trim().toLowerCase().replace(/[- ]+/g, '_');
    return PHASE_ALIASES[normalized] || normalized || 'idle';
  }

  function phaseOf(value) {
    if (typeof value === 'string') {
      return normalizePhase(value);
    }
    const source = unwrap(value);
    return normalizePhase(source.phase || source.status || source.state || source.lifecycle || 'idle');
  }

  function normalizeBlockers(values, normalizeFn) {
    if (typeof normalizeFn === 'function') {
      return normalizeFn(values);
    }
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : [values]) {
      const code = String(value || '').trim();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      result.push(code);
    }
    return result;
  }

  function normalize(value, options = {}) {
    const source = unwrap(value);
    const currentVersion = String(
      source.currentVersion || options.currentVersion || source.latestVersion || ''
    ).replace(/^v/i, '');
    const latestVersion = String(
      source.latestVersion || source.targetVersion || currentVersion
    ).replace(/^v/i, '');
    const blockers = normalizeBlockers(
      Array.isArray(source.blockers) ? source.blockers : (source.blocker ? [source.blocker] : []),
      options.normalizeBlockers
    );
    return {
      ...source,
      state: phaseOf(source),
      managed: source.managed !== false,
      currentVersion,
      latestVersion,
      etag: String(source.etag || ''),
      lastCheckedAt: Number(source.lastCheckedAt || 0),
      stagedAt: Number(source.stagedAt || 0),
      postponeUntil: Number(source.postponeUntil || 0),
      transactionId: String(source.transactionId || ''),
      blocker: blockers[0] || '',
      blockers,
      code: String(source.code || ''),
      message: String(source.message || '').slice(0, 300),
      phaseStartedAt: Number(source.phaseStartedAt || 0),
      deadlineAt: Number(source.deadlineAt || 0),
      heartbeatAt: Number(source.heartbeatAt || 0)
    };
  }

  function getPhaseTimeoutMs(value) {
    return Number(PHASE_TIMEOUTS[phaseOf(value)] || 0);
  }

  function ensurePhaseMetadata(value, options = {}) {
    const normalized = normalize(value, options);
    const phase = phaseOf(normalized);
    const timeoutMs = getPhaseTimeoutMs(phase);
    if (!timeoutMs) {
      return {
        ...normalized,
        phaseStartedAt: 0,
        deadlineAt: 0,
        heartbeatAt: 0
      };
    }
    const now = Number(options.now || Date.now());
    const phaseStartedAt = Number(normalized.phaseStartedAt || now);
    return {
      ...normalized,
      phaseStartedAt,
      deadlineAt: Number(normalized.deadlineAt || (phaseStartedAt + timeoutMs)),
      heartbeatAt: Number(normalized.heartbeatAt || now)
    };
  }

  function transition(previous, patch, options = {}) {
    const prior = normalize(previous, options);
    const nextSource = buildTransitionSource(prior, patch, options);
    const nextPhase = phaseOf(nextSource);
    const previousPhase = phaseOf(prior);
    if (nextPhase !== previousPhase) {
      nextSource.phaseStartedAt = 0;
      nextSource.deadlineAt = 0;
      nextSource.heartbeatAt = 0;
    }
    const transitioned = ensurePhaseMetadata(nextSource, options);
    if (getPhaseTimeoutMs(nextPhase)) {
      transitioned.heartbeatAt = Number(options.now || Date.now());
    }
    return transitioned;
  }

  function transitionCommand(previous, patch, options = {}) {
    const prior = normalize(previous, options);
    const nextSource = buildTransitionSource(prior, patch, options);
    const previousPhase = phaseOf(prior);
    const nextPhase = phaseOf(nextSource);
    if (!isLegalTransition(previousPhase, nextPhase)) {
      const error = new Error(`Illegal managed update transition: ${previousPhase} -> ${nextPhase}`);
      error.code = 'managed_update_transition_invalid';
      error.from = previousPhase;
      error.to = nextPhase;
      throw error;
    }
    return transition(prior, nextSource, { ...options, merge: false });
  }

  function buildTransitionSource(prior, patch, options = {}) {
    return options.merge === false
      ? asObject(patch)
      : { ...prior, ...asObject(patch) };
  }

  function isLegalTransition(from, to) {
    const fromPhase = phaseOf(from);
    const toPhase = phaseOf(to);
    if (fromPhase === toPhase) return true;
    return (TRANSITIONS[fromPhase] || []).includes(toPhase);
  }

  function reconcile(value, transaction, options = {}) {
    const state = normalize(value, options);
    const native = asObject(transaction);
    if (native.state === 'rolled_back') {
      return {
        action: 'reload_tabs',
        state: transition(state, {
          state: 'rolled_back',
          currentVersion: native.sourceVersion || state.currentVersion,
          transactionId: native.id || state.transactionId,
          code: native.reasonCode || state.code || 'update_rolled_back'
        }, options)
      };
    }
    if (native.state === 'committed') {
      const targetVersion = native.targetVersion || state.latestVersion || state.currentVersion;
      return {
        action: 'reload_tabs',
        state: transition(state, {
          state: 'committed',
          currentVersion: targetVersion,
          latestVersion: targetVersion,
          transactionId: '',
          blocker: '',
          blockers: [],
          code: '',
          message: ''
        }, options)
      };
    }
    if (native.state === 'staged' && ['applying', 'awaiting_health'].includes(phaseOf(state))) {
      return {
        action: 'retry_install',
        state: transition(state, {
          state: 'staged',
          transactionId: native.id || state.transactionId,
          blocker: '',
          blockers: [],
          code: '',
          message: ''
        }, options)
      };
    }
    if (!native.state && ['applying', 'awaiting_health', 'rolling_back'].includes(phaseOf(state))) {
      return {
        action: 'none',
        state: transition(state, {
          state: 'failed',
          code: 'update_transaction_lost',
          message: options.transactionLostMessage
            || 'The managed update transaction could not be recovered. Use the manual update command.'
        }, options)
      };
    }
    return { action: 'none', state };
  }

  function progressFor(value) {
    const source = asObject(value);
    const raw = asObject(source.progress).percent
      ?? asObject(source.progress).value
      ?? source.progressPercent
      ?? (typeof source.progress === 'number' ? source.progress : undefined);
    if (Number.isFinite(Number(raw))) {
      const numeric = Number(raw);
      return Math.max(0, Math.min(100, numeric <= 1 ? numeric * 100 : numeric));
    }
    return Number(PROGRESS[phaseOf(value)] || 0);
  }

  function activeStageFor(value) {
    return ACTIVE_STAGE[phaseOf(value)] ?? -1;
  }

  function activePhases(surface = 'update_page') {
    return [...(ACTIVE_PHASES[surface] || ACTIVE_PHASES.update_page)];
  }

  function isActive(value, surface = 'update_page') {
    return activePhases(surface).includes(phaseOf(value));
  }

  root.CodexOverleafManagedUpdateProjection = Object.freeze({
    ACTIVE_PHASES,
    PHASE_ALIASES,
    PHASE_TIMEOUTS,
    PHASES,
    PROGRESS,
    TRANSITIONS,
    activePhases,
    activeStageFor,
    ensurePhaseMetadata,
    getPhaseTimeoutMs,
    isActive,
    isLegalTransition,
    normalize,
    phaseOf,
    progressFor,
    reconcile,
    transition,
    transitionCommand
  });
})(typeof window !== 'undefined' ? window : globalThis);
