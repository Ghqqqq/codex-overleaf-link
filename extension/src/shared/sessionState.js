(function initSessionState(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafSessionState = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function sessionStateFactory() {
  'use strict';

  const i18n = (typeof module === 'object' && module.exports)
    ? require('./i18n')
    : (typeof globalThis !== 'undefined' ? globalThis : window).CodexOverleafI18n;

  const DEFAULT_PANEL_STATE = {
    mode: 'confirm',
    providerId: 'builtin',
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    speedTier: 'standard',
    locale: 'en',
    requireReviewing: true,
    autoOpen: true,
    preloadProjectContext: true,
    loadCodexLocalSkills: true,
    loadCodexOverleafSkills: true,
    codexOverleafSkillEnabled: {},
    theme: 'dark',
    panelWidth: 380,
    task: '',
    focusFiles: [],
    session: null,
    runs: [],
    sessions: [],
    activeSessionId: '',
    customInstructionsByProject: {}
  };

  const VALID_MODES = new Set(['ask', 'confirm', 'auto']);
  // Keep the persisted/session-level contract aligned with the model picker
  // and native provider bridge. Custom providers can explicitly disable
  // reasoning (`none`) or expose the lightest Codex tier (`minimal`). Dropping
  // either value here silently restores the global `high` default after the
  // user has selected it in the composer.
  const VALID_REASONING = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  const VALID_SPEED_TIERS = new Set(['standard', 'fast']);
  const VALID_LOCALES = new Set(['en', 'zh']);
  const VALID_EVENT_STATUSES = new Set(['info', 'running', 'completed', 'failed', 'warning', 'blocked', 'skipped', 'pending']);
  const VALID_TITLE_SOURCES = new Set(['auto', 'manual']);
  // `needs_review` is the §7 settlement state surfaced when Accept/Undo cannot
  // prove a clean post-action state. It is non-terminal for UI purposes: both
  // Accept and Undo remain visible AND actionable so the user can inspect
  // Overleaf and reconcile. Step 3 (terminal payload cleanup) intentionally
  // does NOT empty refs for `needs_review` — the user is supposed to retry.
  const VALID_TRACKED_CHANGE_STATUS = new Set([
    'pending',
    'accepted',
    'rejected',
    'needs_review'
  ]);
  const TERMINAL_TRACKED_CHANGE_STATUS = new Set(['accepted', 'rejected']);
  const LEGACY_DEFAULT_SESSION_TITLE = 'New task';
  const SESSION_AUTO_TITLE_CHARS = 24;
  const MAX_RUN_EVENTS = 300;
  const CUSTOM_INSTRUCTIONS_MAX_CHARS = 12000;
  const PROJECT_PREF_KEY_MAX_CHARS = 160;
  const STORAGE_DEFAULT_LIMITS = {
    maxSessions: 12,
    maxRunsPerSession: 10,
    maxEventsPerRun: 120,
    maxUndoRunsPerSession: 2,
    maxUndoBytesPerRun: 320 * 1024,
    targetBytes: 4 * 1024 * 1024,
    // Stream events carry accumulated assistant/reasoning text in `title`.
    // Keep one provider-sized response intact; the 4 MiB state target below
    // remains the aggregate history guard and prunes older events when needed.
    titleChars: 128 * 1024,
    detailChars: 3000,
    reportDetailChars: 64000,
    historyChars: 1800,
    taskChars: 12000,
    sessionTitleChars: 80,
    statusTextChars: 800,
    attachmentPreviewChars: 768 * 1024
  };
  const STORAGE_AGGRESSIVE_LIMITS = {
    maxSessions: 4,
    maxRunsPerSession: 3,
    maxEventsPerRun: 20,
    maxUndoRunsPerSession: 1,
    maxUndoBytesPerRun: 160 * 1024,
    targetBytes: 768 * 1024,
    titleChars: 1000,
    detailChars: 300,
    reportDetailChars: 16000,
    historyChars: 400,
    taskChars: 2000,
    sessionTitleChars: 80,
    statusTextChars: 400,
    attachmentPreviewChars: 160 * 1024
  };
  const REDACTED_SECRET = '[REDACTED_SECRET]';
  const SECRET_REDACTION_PATTERNS = [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\b(?:sk|pk)-[A-Za-z0-9][A-Za-z0-9_-]{7,}\b/g,
    /\b(?:api[_-]?key|token|password|passwd|secret)\b\s*[:=]\s*["']?[^"'\s,;]+["']?/gi
  ];
  const LineReferences = loadLineReferences();
  const PathRedaction = loadPathRedaction();

  function normalizePanelState(input = {}, options = {}) {
    const state = {
      ...DEFAULT_PANEL_STATE,
      ...input
    };

    if (!VALID_MODES.has(state.mode)) {
      state.mode = DEFAULT_PANEL_STATE.mode;
    }
    if (!VALID_REASONING.has(state.reasoningEffort)) {
      state.reasoningEffort = DEFAULT_PANEL_STATE.reasoningEffort;
    }
    if (!VALID_SPEED_TIERS.has(state.speedTier)) {
      state.speedTier = DEFAULT_PANEL_STATE.speedTier;
    }
    if (!VALID_LOCALES.has(state.locale)) {
      state.locale = DEFAULT_PANEL_STATE.locale;
    }
    state.requireReviewing = state.requireReviewing !== false;
    state.autoOpen = state.autoOpen !== false;
    state.loadCodexLocalSkills = state.loadCodexLocalSkills !== false;
    state.loadCodexOverleafSkills = state.loadCodexOverleafSkills !== false;
    state.codexOverleafSkillEnabled = normalizeCodexOverleafSkillEnabled(state.codexOverleafSkillEnabled);
    state.theme = ['dark', 'light', 'auto'].includes(state.theme) ? state.theme : 'dark';
    state.panelWidth = normalizePanelWidth(state.panelWidth);
    state.task = typeof state.task === 'string' ? state.task : '';
    state.model = typeof state.model === 'string' && state.model ? state.model : DEFAULT_PANEL_STATE.model;
    state.customInstructionsByProject = normalizeCustomInstructionsByProject(state.customInstructionsByProject);
    state.composerAttachments = normalizeComposerAttachmentsForPersistence(state.composerAttachments);
    const localizedOptions = { ...options, locale: state.locale };
    state.runs = normalizeRuns(state.runs, localizedOptions);
    state.sessions = normalizeSessions(state, input, localizedOptions);
    state.activeSessionId = resolveActiveSessionId(state.sessions, input.activeSessionId);
    state.sessions = pruneHiddenEmptySessions(state.sessions, state.activeSessionId);

    return mirrorActiveSession(state);
  }

  // Drop empty (non-displayable) sessions that are not the active one. Empty
  // sessions never appear in the list yet still consume the storage cap, so they
  // would otherwise accumulate and evict real history. The active session is
  // always kept (even when empty) so the user is never left with nothing.
  function pruneHiddenEmptySessions(sessions, activeSessionId) {
    if (!Array.isArray(sessions) || sessions.length <= 1) {
      return sessions;
    }
    const kept = sessions.filter(session =>
      session.id === activeSessionId || isDisplayableSession(session));
    return kept.length ? kept : sessions;
  }

  function normalizeSessions(state, input, options = {}) {
    const explicitSessions = Array.isArray(input.sessions) ? input.sessions : [];
    const sessions = explicitSessions
      .filter(session => session && typeof session.id === 'string')
      .map(session => normalizeSession(session, state, options));

    if (sessions.length) {
      return sessions.slice(-20);
    }

    const legacySession = input.session?.id ? input.session : createSession();
    return [normalizeSession({
      ...legacySession,
      task: state.task,
      mode: state.mode,
      providerId: 'builtin',
      model: state.model,
      reasoningEffort: state.reasoningEffort,
      speedTier: state.speedTier,
      requireReviewing: state.requireReviewing,
      focusFiles: normalizeFocusFiles(state.focusFiles || legacySession.focusFiles),
      runs: state.runs,
      title: legacySession.title || deriveSessionTitle(state.runs, state.task),
      titleSource: legacySession.titleSource,
      updatedAt: legacySession.updatedAt
    }, state, options)];
  }

  function normalizeSession(session, fallbackState = DEFAULT_PANEL_STATE, options = {}) {
    const history = normalizeHistoryEntries(session.history);
    const normalizedRuns = normalizeRuns(session.runs, options);
    const runs = normalizedRuns.length ? normalizedRuns : recoverRunsFromHistory(session, history);
    const rawTitle = typeof session.title === 'string' ? session.title.trim() : '';
    const derivedTitle = deriveSessionTitle(runs, session.task);
    const titleSource = normalizeTitleSource(session.titleSource, rawTitle, derivedTitle);
    const title = normalizeSessionTitle(rawTitle, derivedTitle, titleSource);

    return {
      id: session.id,
      title,
      titleSource,
      createdAt: typeof session.createdAt === 'string' ? session.createdAt : new Date().toISOString(),
      updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : new Date().toISOString(),
      history,
      runs,
      task: sanitizeAssistantVisibleText(session.task),
      mode: VALID_MODES.has(session.mode) ? session.mode : fallbackState.mode,
      providerId: typeof session.providerId === 'string' && session.providerId.trim()
        ? session.providerId.trim()
        : 'builtin',
      model: typeof session.model === 'string' && session.model ? session.model : fallbackState.model,
      reasoningEffort: VALID_REASONING.has(session.reasoningEffort)
        ? session.reasoningEffort
        : fallbackState.reasoningEffort,
      speedTier: VALID_SPEED_TIERS.has(session.speedTier)
        ? session.speedTier
        : fallbackState.speedTier,
      requireReviewing: session.requireReviewing !== false,
      focusFiles: normalizeFocusFiles(session.focusFiles),
      codexThreadId: typeof session.codexThreadId === 'string' ? session.codexThreadId : ''
    };
  }

  function recoverRunsFromHistory(session, history) {
    if (!Array.isArray(history) || !history.length) {
      return [];
    }
    return normalizeRuns(history.map((entry, index) => {
      const task = typeof entry?.task === 'string' && entry.task.trim()
        ? entry.task.trim()
        : (typeof session.task === 'string' && session.task.trim() ? session.task.trim() : 'untitled task');
      const timestamp = typeof entry?.at === 'string' ? entry.at : session.updatedAt;
      const result = typeof entry?.result === 'string' && entry.result.trim()
        ? entry.result.trim()
        : '这轮任务有历史记录，但没有保存详细结果。';
      return {
        id: `recovered_${session.id}_${index}`,
        task,
        mode: session.mode,
        providerId: session.providerId || 'builtin',
        model: session.model,
        reasoningEffort: session.reasoningEffort,
        speedTier: session.speedTier,
        status: 'completed',
        statusText: '已处理',
        startedAt: timestamp,
        finishedAt: timestamp,
        events: [{
          title: '本轮完成报告',
          status: 'completed',
          kind: 'report',
          timestamp,
          detail: {
            '结论': result
          }
        }]
      };
    }));
  }

  function resolveActiveSessionId(sessions, activeSessionId) {
    if (typeof activeSessionId === 'string' && sessions.some(session => session.id === activeSessionId)) {
      return activeSessionId;
    }
    return sessions[sessions.length - 1]?.id || createSession().id;
  }

  function mirrorActiveSession(state) {
    const active = getActiveSession(state);
    if (!active) {
      const session = createSession({
        mode: state.mode,
        providerId: state.providerId,
        model: state.model,
        reasoningEffort: state.reasoningEffort,
        speedTier: state.speedTier,
        requireReviewing: state.requireReviewing
      });
      state.sessions = [session];
      state.activeSessionId = session.id;
      return mirrorActiveSession(state);
    }

    state.session = {
      id: active.id,
      history: Array.isArray(active.history) ? active.history.slice(-10) : [],
      focusFiles: normalizeFocusFiles(active.focusFiles),
      codexThreadId: active.codexThreadId || '',
      providerId: active.providerId || 'builtin'
    };
    state.runs = Array.isArray(active.runs) ? active.runs : [];
    state.task = typeof active.task === 'string' ? active.task : '';
    state.focusFiles = normalizeFocusFiles(active.focusFiles);
    state.mode = VALID_MODES.has(active.mode) ? active.mode : DEFAULT_PANEL_STATE.mode;
    state.providerId = typeof active.providerId === 'string' && active.providerId
      ? active.providerId
      : 'builtin';
    state.model = typeof active.model === 'string' && active.model ? active.model : DEFAULT_PANEL_STATE.model;
    state.reasoningEffort = VALID_REASONING.has(active.reasoningEffort)
      ? active.reasoningEffort
      : DEFAULT_PANEL_STATE.reasoningEffort;
    state.speedTier = VALID_SPEED_TIERS.has(active.speedTier)
      ? active.speedTier
      : DEFAULT_PANEL_STATE.speedTier;
    state.requireReviewing = active.requireReviewing !== false;

    return state;
  }

  function createSession(overrides = {}) {
    const runs = Array.isArray(overrides.runs) ? normalizeRuns(overrides.runs) : [];
    const rawTitle = typeof overrides.title === 'string' ? overrides.title.trim() : '';
    const derivedTitle = deriveSessionTitle(runs, overrides.task || rawTitle);
    const titleSource = VALID_TITLE_SOURCES.has(overrides.titleSource)
      ? overrides.titleSource
      : (rawTitle && rawTitle !== LEGACY_DEFAULT_SESSION_TITLE ? 'manual' : 'auto');
    return {
      id: `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      title: normalizeSessionTitle(rawTitle, derivedTitle, titleSource),
      titleSource,
      createdAt: overrides.createdAt || new Date().toISOString(),
      updatedAt: overrides.updatedAt || new Date().toISOString(),
      history: normalizeHistoryEntries(overrides.history),
      runs,
      task: sanitizeAssistantVisibleText(overrides.task),
      mode: VALID_MODES.has(overrides.mode) ? overrides.mode : DEFAULT_PANEL_STATE.mode,
      providerId: typeof overrides.providerId === 'string' && overrides.providerId.trim()
        ? overrides.providerId.trim()
        : 'builtin',
      model: typeof overrides.model === 'string' && overrides.model ? overrides.model : DEFAULT_PANEL_STATE.model,
      reasoningEffort: VALID_REASONING.has(overrides.reasoningEffort)
        ? overrides.reasoningEffort
        : DEFAULT_PANEL_STATE.reasoningEffort,
      speedTier: VALID_SPEED_TIERS.has(overrides.speedTier)
        ? overrides.speedTier
        : DEFAULT_PANEL_STATE.speedTier,
      requireReviewing: overrides.requireReviewing !== false,
      focusFiles: normalizeFocusFiles(overrides.focusFiles),
      codexThreadId: typeof overrides.codexThreadId === 'string' ? overrides.codexThreadId : ''
    };
  }

  function recordSessionResult(session, entry) {
    const base = session?.id ? session : createSession();
    const task = sanitizeAssistantVisibleText(entry?.task) || 'untitled task';
    const result = sanitizeAssistantVisibleText(entry?.result || entry?.status) || 'completed';
    return {
      ...base,
      id: base.id,
      titleSource: VALID_TITLE_SOURCES.has(base.titleSource) ? base.titleSource : 'auto',
      history: [
        ...(Array.isArray(base.history) ? base.history : []),
        {
          task,
          result,
          at: entry?.at || new Date().toISOString()
        }
      ].slice(-10),
      updatedAt: entry?.at || new Date().toISOString()
    };
  }

  function getActiveSession(state) {
    return (state?.sessions || []).find(session => session.id === state.activeSessionId) || null;
  }

  function updateActiveSession(state, patch) {
    const activeSessionId = state.activeSessionId;
    const sessions = (state.sessions || []).map(session => {
      if (session.id !== activeSessionId) {
        return session;
      }
      const next = {
        ...session,
        ...patch,
        updatedAt: patch.updatedAt || new Date().toISOString()
      };
      if (
        session.titleSource === 'manual' &&
        patch.titleSource !== 'manual' &&
        Object.prototype.hasOwnProperty.call(patch, 'title')
      ) {
        next.title = session.title;
        next.titleSource = 'manual';
      }
      return normalizeSession({
        ...next
      }, state);
    });
    return mirrorActiveSession({
      ...state,
      sessions
    });
  }

  function setActiveSession(state, sessionId) {
    if (!(state.sessions || []).some(session => session.id === sessionId)) {
      return mirrorActiveSession(state);
    }
    return mirrorActiveSession({
      ...state,
      activeSessionId: sessionId
    });
  }

  function deleteSession(state, sessionId) {
    const sessions = state.sessions || [];
    if (!sessions.some(session => session.id === sessionId)) {
      return mirrorActiveSession(state);
    }

    const remaining = sessions.filter(session => session.id !== sessionId);
    if (!remaining.length) {
      const replacement = createSession({
        mode: state.mode,
        providerId: state.providerId,
        model: state.model,
        reasoningEffort: state.reasoningEffort,
        speedTier: state.speedTier,
        requireReviewing: state.requireReviewing
      });
      return mirrorActiveSession({
        ...state,
        sessions: [replacement],
        activeSessionId: replacement.id
      });
    }

    const activeSessionId = state.activeSessionId === sessionId
      ? getMostRecentSession(remaining).id
      : state.activeSessionId;

    return mirrorActiveSession({
      ...state,
      sessions: remaining,
      activeSessionId
    });
  }

  function getMostRecentSession(sessions) {
    return sessions.reduce((latest, session) => {
      const latestTime = Date.parse(latest.updatedAt || latest.createdAt || '');
      const sessionTime = Date.parse(session.updatedAt || session.createdAt || '');
      if (Number.isNaN(latestTime)) {
        return session;
      }
      if (Number.isNaN(sessionTime)) {
        return latest;
      }
      return sessionTime >= latestTime ? session : latest;
    }, sessions[0]);
  }

  function deriveSessionTitle(runs, task) {
    const taskTitle = sanitizeAutoTitle(task);
    if (taskTitle) {
      return taskTitle;
    }
    const firstRunTask = Array.isArray(runs) && runs.length ? runs[0]?.task : '';
    return sanitizeAutoTitle(firstRunTask);
  }

  // Rename a session with the placeholder/derived-title ghost guard (mirrors
  // the in-panel header rename): committing the localized "New Session"
  // placeholder or the auto-derived title must NOT promote the session to a
  // manual title — that would resurrect the empty-session ghosts the
  // normalize-prune eliminates and freeze one locale's literal as the title.
  function renameSession(state, sessionId, rawTitle, options = {}) {
    const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
    const target = sessions.find(session => session && session.id === sessionId);
    if (!target) {
      return normalizePanelState(state);
    }
    const cleanTitle = String(rawTitle || '').trim().slice(0, 80);
    const derived = deriveSessionTitle(target.runs, target.task);
    const placeholder = String(options.placeholderTitle || '').trim();
    const isCustom = Boolean(cleanTitle)
      && (!placeholder || cleanTitle !== placeholder)
      && cleanTitle !== derived;
    return normalizePanelState({
      ...state,
      sessions: sessions.map(session => (session && session.id === sessionId
        ? { ...session, title: isCustom ? cleanTitle : derived, titleSource: isCustom ? 'manual' : 'auto' }
        : session))
    });
  }

  function normalizeTitleSource(value, rawTitle, derivedTitle) {
    if (VALID_TITLE_SOURCES.has(value)) {
      return value;
    }
    if (rawTitle && rawTitle !== LEGACY_DEFAULT_SESSION_TITLE && rawTitle !== derivedTitle) {
      return 'manual';
    }
    return 'auto';
  }

  function normalizeSessionTitle(rawTitle, derivedTitle, titleSource) {
    if (titleSource === 'manual') {
      return normalizeTextField(rawTitle === LEGACY_DEFAULT_SESSION_TITLE ? '' : rawTitle, STORAGE_DEFAULT_LIMITS.sessionTitleChars);
    }
    return sanitizeAutoTitle(rawTitle === LEGACY_DEFAULT_SESSION_TITLE ? '' : rawTitle) || derivedTitle || '';
  }

  function sanitizeAutoTitle(value) {
    const title = sanitizeAssistantVisibleText(value)
      .replace(/@file:[^\s]+/g, ' ')
      .replace(/@(context|compile-log)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!title) {
      return '';
    }
    return title.length > SESSION_AUTO_TITLE_CHARS
      ? `${title.slice(0, SESSION_AUTO_TITLE_CHARS - 1)}…`
      : title;
  }

  function isDisplayableSession(session) {
    if (!session?.id) {
      return false;
    }
    const hasTask = typeof session.task === 'string' && session.task.trim().length > 0;
    const hasRuns = Array.isArray(session.runs) && session.runs.length > 0;
    const hasHistory = Array.isArray(session.history) && session.history.length > 0;
    const title = typeof session.title === 'string' ? session.title.trim() : '';
    const hasRealTitle = title.length > 0 && title !== LEGACY_DEFAULT_SESSION_TITLE;
    return hasTask || hasRuns || hasHistory || hasRealTitle;
  }

  function selectVisibleSessionsForList(sessions, activeSessionId, options = {}) {
    const maxVisible = Number.isFinite(options.maxVisible) && options.maxVisible > 0
      ? Math.floor(options.maxVisible)
      : 3;
    const displayable = (Array.isArray(sessions) ? sessions : []).filter(isDisplayableSession);
    if (options.showAll || displayable.length <= maxVisible) {
      return displayable.slice().reverse();
    }

    const pinnedSessionIds = Array.isArray(options.pinnedSessionIds)
      ? options.pinnedSessionIds.filter(Boolean)
      : [];
    const recent = displayable.slice(-maxVisible).reverse();
    if (pinnedSessionIds.length) {
      const selected = [];
      const pushSession = session => {
        if (session && !selected.some(item => item.id === session.id)) {
          selected.push(session);
        }
      };
      pushSession(displayable.find(session => session.id === activeSessionId));
      for (const pinnedId of pinnedSessionIds) {
        pushSession(displayable.find(session => session.id === pinnedId));
      }
      for (const session of recent) {
        pushSession(session);
      }
      return selected.slice(0, maxVisible);
    }

    if (!activeSessionId || recent.some(session => session.id === activeSessionId)) {
      return recent;
    }

    const active = displayable.find(session => session.id === activeSessionId);
    if (!active) {
      return recent;
    }
    return [active, ...recent.filter(session => session.id !== activeSessionId).slice(0, maxVisible - 1)];
  }

  function normalizeRuns(runs, options = {}) {
    return (Array.isArray(runs) ? runs : [])
      .filter(run => run && typeof run.id === 'string')
      .map(run => normalizeRun(run, options))
      .slice(-20);
  }

  function normalizeRun(run, options = {}) {
    const shouldStopRestoredRun = options.restoreRunningRuns === true && run.status === 'running';
    const locale = options.locale || i18n.DEFAULT_LOCALE;
    const events = normalizeRunEvents(run.events);
    if (shouldStopRestoredRun) {
      // v1.7.5: a reload-orphaned run is 'interrupted', not 'failed' — nothing
      // went wrong with the task itself. The notice is a report-kind event
      // carrying a retryable failure code so the recovery-action registry
      // offers "Edit & resend" right on the card.
      events.push({
        title: i18n.t(locale, 'restoredRunStoppedTitle'),
        status: 'failed',
        kind: 'report',
        detail: i18n.t(locale, 'restoredRunStoppedDetail'),
        failure: { code: 'native_request_failed', source: 'panel_reload' },
        timestamp: new Date().toISOString()
      });
    }

    const normalized = {
      id: run.id,
      task: sanitizeAssistantVisibleText(run.task) || 'untitled task',
      mode: typeof run.mode === 'string' ? run.mode : '',
      providerId: typeof run.providerId === 'string' && run.providerId ? run.providerId : 'builtin',
      providerName: typeof run.providerName === 'string' ? run.providerName : '',
      providerRevision: Number.isFinite(Number(run.providerRevision)) ? Number(run.providerRevision) : 0,
      providerEndpointHost: typeof run.providerEndpointHost === 'string' ? run.providerEndpointHost : '',
      model: typeof run.model === 'string' ? run.model : '',
      reasoningEffort: typeof run.reasoningEffort === 'string' ? run.reasoningEffort : '',
      speedTier: typeof run.speedTier === 'string' ? run.speedTier : '',
      status: shouldStopRestoredRun ? 'interrupted' : normalizeRunStatus(run.status),
      statusText: shouldStopRestoredRun ? i18n.t(locale, 'restoredRunStoppedStatus') : sanitizeAssistantVisibleText(run.statusText),
      runProjectId: normalizeProjectPrefKey(run.runProjectId),
      startedAt: typeof run.startedAt === 'string' ? run.startedAt : '',
      finishedAt: shouldStopRestoredRun ? new Date().toISOString() : typeof run.finishedAt === 'string' ? run.finishedAt : '',
      events: events.slice(-MAX_RUN_EVENTS),
      attachments: normalizeRunAttachments(run.attachments, STORAGE_DEFAULT_LIMITS),
      appliedOperations: Array.isArray(run.appliedOperations) ? run.appliedOperations : [],
      undoOperations: Array.isArray(run.undoOperations) ? run.undoOperations : [],
      undoBaseFiles: normalizeRunFiles(run.undoBaseFiles),
      undoTrackedChanges: normalizeRunTrackedChanges(run.undoTrackedChanges),
      undoExpectedFiles: normalizeRunFiles(run.undoExpectedFiles),
      undoStatus: sanitizeAssistantVisibleText(run.undoStatus)
    };

    applyTrackedChangeStatus(normalized, run.trackedChangeStatus);

    return normalized;
  }

  // Resolves `trackedChangeStatus` on an already-normalized run via three ordered
  // steps: (1) value recovery, (2) migration of pre-feature runs, (3) terminal
  // payload cleanup. Mutates `run` in place. Idempotent: re-running it on its own
  // output yields the same result.
  function applyTrackedChangeStatus(run, rawStatus) {
    const hasRefs = run.undoTrackedChanges.length > 0;
    const hasRawStatus = rawStatus !== undefined && rawStatus !== null && rawStatus !== '';

    // Step 1 — value recovery. Keep a stable value; recover any other present
    // value (corruption, an old persisted `partial_accept` / `partial_reject` /
    // `resolved_elsewhere`, a stray in-flight value) to `pending` (with refs)
    // or drop it. An absent value falls through.
    let status;
    if (VALID_TRACKED_CHANGE_STATUS.has(rawStatus)) {
      status = rawStatus;
    } else if (hasRawStatus) {
      status = hasRefs ? 'pending' : undefined;
    } else {
      status = undefined;
    }

    // Step 1 — reload reconciliation. A non-terminal status (`pending`) with no
    // refs is the post-reload state of an un-acted tracked-change run: the heavy refs are
    // never persisted, so without them there is nothing to act on. Drop it so
    // the run returns to the legacy-undo world. A terminal status with no refs
    // is kept — step 3 already empties terminal payloads and the label stays
    // meaningful.
    if (!hasRefs && status !== undefined && !TERMINAL_TRACKED_CHANGE_STATUS.has(status)) {
      status = undefined;
    }

    // Step 2 — migration of pre-feature runs (no status after step 1).
    if (status === undefined && hasRefs) {
      status = run.undoStatus === 'applied' ? 'rejected' : 'pending';
    }

    // Step 3 — terminal payload cleanup; keeps `trackedChangeStatus`.
    if (TERMINAL_TRACKED_CHANGE_STATUS.has(status)) {
      run.undoTrackedChanges = [];
      run.undoExpectedFiles = [];
    }

    if (status !== undefined) {
      run.trackedChangeStatus = status;
    }
  }

  // Welcome-panel + write-guard: the run lifecycle now
  // settles on three additional values when the user navigates away mid-run
  // and the original run completes (or aborts) in the background. They land on
  // the ORIGINAL project's session record, not the active one. The catalog is
  // a `Set` so the recovery branch can defensively coerce any unknown legacy
  // value to `pending` without throwing.
  const VALID_RUN_STATUS = new Set([
    'pending',
    'running',
    'completed',
    'failed',
    'interrupted',
    'background_completed',
    'needs_review_after_navigation',
    'abandoned_after_navigation'
  ]);

  function normalizeRunStatus(status) {
    if (VALID_RUN_STATUS.has(status)) return status;
    // Legacy persisted runs without an explicit status fall back to `completed`
    // (the historical default for the recovery branch); unknown values land on
    // `pending` so the UI surfaces them as fresh / actionable rather than
    // pretending they finished.
    if (status === undefined || status === null || status === '') return 'completed';
    return 'pending';
  }

  function normalizeEventStatus(status) {
    return VALID_EVENT_STATUSES.has(status) ? status : 'info';
  }

  function normalizeRunEvents(events) {
    return (Array.isArray(events) ? events : [])
      .filter(event => event && typeof event.title === 'string')
      .map(event => {
        const normalized = {
          title: sanitizeAssistantVisibleText(event.title) || 'Event',
          status: typeof event.status === 'string' ? event.status : 'info',
          detail: sanitizeAssistantVisibleValue(event.detail),
          timestamp: typeof event.timestamp === 'string' ? event.timestamp : '',
          kind: typeof event.kind === 'string' ? event.kind : 'activity',
          technicalDetail: sanitizeAssistantVisibleValue(event.technicalDetail),
          streamKey: sanitizeAssistantVisibleText(event.streamKey),
          streamRole: sanitizeAssistantVisibleText(event.streamRole)
        };
        // Preserve the structured completion-report payload and the structured
        // failure across reload. Without these the report re-renders via the
        // flat legacy path (Write result / Undo / Next NOT demoted into the
        // muted meta block) and the recovery action button disappears.
        if (event.detailStructured) {
          normalized.detailStructured = sanitizeAssistantVisibleValue(event.detailStructured);
        }
        if (event.failure) {
          normalized.failure = sanitizeAssistantVisibleValue(event.failure);
        }
        if (Array.isArray(event.compileErrors) && event.compileErrors.length) {
          normalized.compileErrors = event.compileErrors.slice(0, 5)
            .map(item => sanitizeAssistantVisibleText(String(item)))
            .filter(Boolean);
        }
        if (Array.isArray(event.rejectedHunks) && event.rejectedHunks.length) {
          normalized.rejectedHunks = event.rejectedHunks.slice(0, 10)
            .map(item => ({
              path: sanitizeAssistantVisibleText(String(item?.path || '')),
              summary: sanitizeAssistantVisibleText(String(item?.summary || ''))
            }))
            .filter(item => item.path);
        }
        return normalized;
      })
      .slice(-MAX_RUN_EVENTS);
  }

  // v1.8.0 C4: composer attachments that survive a page refresh. Hard caps
  // keep chrome.storage and every debounced saveState cheap: 3 attachments,
  // 1MB of base64 each.
  function normalizeComposerAttachmentsForPersistence(attachments) {
    const MAX_COUNT = 3;
    const MAX_CONTENT_CHARS = 1024 * 1024;
    return (Array.isArray(attachments) ? attachments : [])
      .filter(item => item && typeof item === 'object'
        && normalizeAttachmentName(item.name)
        && typeof item.contentBase64 === 'string'
        && item.contentBase64.length > 0
        && item.contentBase64.length <= MAX_CONTENT_CHARS)
      .slice(0, MAX_COUNT)
      .map(item => ({
        id: normalizeTextField(item.id, 80),
        name: normalizeAttachmentName(item.name),
        mimeType: normalizeTextField(item.mimeType, 120),
        size: Number(item.size) || 0,
        kind: item.kind === 'image' ? 'image' : 'file',
        previewDataUrl: typeof item.previewDataUrl === 'string' ? item.previewDataUrl : '',
        contentBase64: item.contentBase64,
        dedupeKey: normalizeTextField(item.dedupeKey, 200)
      }));
  }

  function normalizeRunAttachments(attachments, limits = STORAGE_DEFAULT_LIMITS) {
    const normalized = [];
    for (const attachment of Array.isArray(attachments) ? attachments : []) {
      const name = normalizeAttachmentName(attachment?.name);
      if (!name) {
        continue;
      }
      const mimeType = normalizeTextField(attachment.mimeType, 120);
      const size = Number(attachment.size);
      const previewDataUrl = normalizeAttachmentPreviewDataUrl(attachment.previewDataUrl, limits);
      const kind = attachment.kind === 'image' || /^image\//i.test(mimeType) || /^data:image\//i.test(previewDataUrl)
        ? 'image'
        : 'file';
      normalized.push({
        name,
        mimeType,
        size: Number.isFinite(size) && size >= 0 ? Math.round(size) : 0,
        kind,
        previewDataUrl: kind === 'image' ? previewDataUrl : ''
      });
      if (normalized.length >= 8) {
        break;
      }
    }
    return normalized;
  }

  function compactRunAttachmentsForStorage(attachments, limits = STORAGE_DEFAULT_LIMITS) {
    return normalizeRunAttachments(attachments, limits).map(attachment => ({
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      kind: attachment.kind
    }));
  }

  function normalizeAttachmentName(value) {
    return normalizeTextField(String(value || '')
      .replace(/\0/g, '')
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .pop() || '', 180);
  }

  function normalizeAttachmentPreviewDataUrl(value, limits = STORAGE_DEFAULT_LIMITS) {
    const text = String(value || '').trim();
    if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(text)) {
      return '';
    }
    return normalizeTextField(text, limits.attachmentPreviewChars || 0);
  }

  function normalizeRunFiles(files) {
    return (Array.isArray(files) ? files : [])
      .filter(file => typeof file?.path === 'string' && typeof file.content === 'string')
      .map(file => ({
        path: file.path,
        content: file.content
      }));
  }

  function normalizeRunTrackedChanges(changes) {
    const seen = new Set();
    const normalized = [];
    for (const change of Array.isArray(changes) ? changes : []) {
      const key = typeof change?.key === 'string' ? change.key : '';
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      normalized.push({
        key,
        id: typeof change.id === 'string' ? change.id : '',
        path: sanitizeAssistantVisibleText(change.path),
        label: sanitizeAssistantVisibleText(change.label)
      });
    }
    return normalized;
  }

  function normalizeFocusFiles(value) {
    const seen = new Set();
    const files = [];
    for (const item of Array.isArray(value) ? value : []) {
      if (typeof item !== 'string') {
        continue;
      }
      const path = sanitizeAssistantVisibleText(item.trim());
      if (!path || seen.has(path)) {
        continue;
      }
      seen.add(path);
      files.push(path);
    }
    return files.slice(0, 5);
  }

  function normalizeCustomInstructionsByProject(value) {
    const result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return result;
    }
    const keys = Object.keys(value);
    for (const rawKey of keys) {
      const key = normalizeProjectPrefKey(rawKey);
      if (!key) {
        continue;
      }
      result[key] = typeof value[rawKey] === 'string'
        ? normalizeTextField(value[rawKey], CUSTOM_INSTRUCTIONS_MAX_CHARS)
        : '';
    }
    return result;
  }

  function normalizeCodexOverleafSkillEnabled(value) {
    const result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return result;
    }
    for (const key of Object.keys(value)) {
      if (typeof key !== 'string' || !key) {
        continue;
      }
      if (typeof value[key] !== 'boolean') {
        continue;
      }
      result[key] = value[key];
    }
    return result;
  }

  function normalizeProjectPrefKey(value) {
    const key = typeof value === 'string' ? value.trim() : '';
    if (!key) {
      return '';
    }
    return normalizeTextField(key, PROJECT_PREF_KEY_MAX_CHARS);
  }

  function prepareStateForStorage(input = {}, options = {}) {
    const limits = options.aggressive ? STORAGE_AGGRESSIVE_LIMITS : STORAGE_DEFAULT_LIMITS;
    const compact = compactPanelStateForStorage(input, limits);
    if (!options.aggressive && estimateJsonBytes(compact) > limits.targetBytes) {
      // Surface the silent degradation: callers can pass onAggressive to tell
      // the user history is being trimmed harder than the normal limits.
      if (typeof options.onAggressive === 'function') {
        options.onAggressive();
      }
      return prepareStateForStorage(input, { ...options, aggressive: true });
    }
    return compact;
  }

  function compactCodexOverleafSkillsForStorage(skills) {
    return (Array.isArray(skills) ? skills : [])
      .slice(0, 32)
      .map(skill => ({
        id: String(skill?.id || '').trim().slice(0, 64),
        name: String(skill?.name || '').trim().slice(0, 80)
      }))
      .filter(skill => skill.id);
  }

  function compactPanelStateForStorage(input, limits) {
    const source = {
      ...DEFAULT_PANEL_STATE,
      ...(input && typeof input === 'object' ? input : {})
    };
    const sourceSessions = getSourceSessions(source);
    const activeSessionId = typeof source.activeSessionId === 'string'
      ? source.activeSessionId
      : source.session?.id;
    const selectedSessions = selectSessionsForStorage(sourceSessions, activeSessionId, limits.maxSessions);
    const compactSessions = selectedSessions.map(session => compactSessionForStorage(session, source, limits));
    const resolvedActiveId = compactSessions.some(session => session.id === activeSessionId)
      ? activeSessionId
      : compactSessions[compactSessions.length - 1]?.id || '';
    const active = compactSessions.find(session => session.id === resolvedActiveId) || compactSessions[0] || null;

    return {
      // The Codex-Overleaf skills catalog must survive reloads: the parallel-
      // subagents broker gate reads it at run time, and before v1.6.1 it was
      // stripped here — so the gate silently died after any reload until the
      // Skills page was reopened.
      codexOverleafSkills: compactCodexOverleafSkillsForStorage(source.codexOverleafSkills),
      composerAttachments: normalizeComposerAttachmentsForPersistence(source.composerAttachments),
      mode: VALID_MODES.has(active?.mode) ? active.mode : normalizeMode(source.mode),
      model: normalizeTextField(active?.model || source.model || DEFAULT_PANEL_STATE.model, 80),
      reasoningEffort: VALID_REASONING.has(active?.reasoningEffort)
        ? active.reasoningEffort
        : normalizeReasoning(source.reasoningEffort),
      speedTier: normalizeSpeedTier(active?.speedTier || source.speedTier),
      locale: normalizeLocale(source.locale),
      requireReviewing: active ? active.requireReviewing !== false : source.requireReviewing !== false,
      autoOpen: source.autoOpen !== false,
      preloadProjectContext: source.preloadProjectContext !== false,
      loadCodexLocalSkills: source.loadCodexLocalSkills !== false,
      loadCodexOverleafSkills: source.loadCodexOverleafSkills !== false,
      codexOverleafSkillEnabled: normalizeCodexOverleafSkillEnabled(source.codexOverleafSkillEnabled),
      theme: ['dark', 'light', 'auto'].includes(source.theme) ? source.theme : 'dark',
      panelWidth: normalizePanelWidth(source.panelWidth),
      task: summarizeTextForStorage(active?.task || source.task || '', 'task'),
      focusFiles: normalizeFocusFiles(active?.focusFiles || source.focusFiles),
      session: active ? {
        id: active.id,
        history: compactHistory(active.history, limits),
        focusFiles: normalizeFocusFiles(active.focusFiles)
      } : null,
      runs: [],
      sessions: compactSessions,
      activeSessionId: active?.id || '',
      customInstructionsByProject: normalizeCustomInstructionsByProject(source.customInstructionsByProject)
    };
  }

  function getSourceSessions(source) {
    if (Array.isArray(source.sessions) && source.sessions.some(session => session?.id)) {
      return source.sessions;
    }
    const legacySession = source.session?.id ? source.session : createSession({
      mode: source.mode,
      model: source.model,
      reasoningEffort: source.reasoningEffort,
      speedTier: source.speedTier,
      requireReviewing: source.requireReviewing
    });
    return [{
      ...legacySession,
      task: source.task,
      mode: source.mode,
      model: source.model,
      reasoningEffort: source.reasoningEffort,
      speedTier: source.speedTier,
      requireReviewing: source.requireReviewing,
      focusFiles: normalizeFocusFiles(source.focusFiles || legacySession.focusFiles),
      runs: Array.isArray(source.runs) ? source.runs : legacySession.runs,
      title: legacySession.title || deriveSessionTitle(source.runs, source.task),
      titleSource: legacySession.titleSource,
      updatedAt: legacySession.updatedAt
    }];
  }

  function selectSessionsForStorage(sessions, activeSessionId, maxSessions) {
    const filtered = (Array.isArray(sessions) ? sessions : [])
      .filter(session => session && typeof session.id === 'string');
    if (filtered.length <= maxSessions) {
      return filtered;
    }

    const active = filtered.find(session => session.id === activeSessionId);
    const recent = filtered.slice(-maxSessions);
    if (!active || recent.some(session => session.id === active.id)) {
      return recent;
    }
    return [
      active,
      ...recent.filter(session => session.id !== active.id).slice(-(maxSessions - 1))
    ];
  }

  function compactSessionForStorage(session, fallbackState, limits) {
    const runs = compactRunsForStorage(session.runs, limits);
    const titleSource = VALID_TITLE_SOURCES.has(session.titleSource) ? session.titleSource : 'auto';
    const compact = {
      id: session.id,
      title: compactSessionTitleForStorage(session, titleSource, limits),
      titleSource,
      createdAt: typeof session.createdAt === 'string' ? session.createdAt : new Date().toISOString(),
      updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : new Date().toISOString(),
      history: compactHistory(session.history, limits),
      runs,
      task: summarizeTextForStorage(session.task, 'task'),
      mode: normalizeMode(session.mode || fallbackState.mode),
      model: normalizeTextField(session.model || fallbackState.model || DEFAULT_PANEL_STATE.model, 80),
      reasoningEffort: normalizeReasoning(session.reasoningEffort || fallbackState.reasoningEffort),
      speedTier: normalizeSpeedTier(session.speedTier || fallbackState.speedTier),
      requireReviewing: session.requireReviewing !== false,
      focusFiles: normalizeFocusFiles(session.focusFiles)
    };
    // Welcome-panel + write-guard: preserve the four
    // Recent-projects fields through compaction so they round-trip when state
    // is reloaded from chrome.storage.local. The active record builder in
    // `buildSessionRecord` is the canonical writer; this branch preserves an
    // existing value so it survives.
    if (typeof session.lastActivityAt === 'string' && session.lastActivityAt) {
      compact.lastActivityAt = session.lastActivityAt;
    }
    if (typeof session.accountScopeId === 'string' && session.accountScopeId) {
      compact.accountScopeId = session.accountScopeId;
    }
    if (typeof session.accountScopeUnavailable === 'boolean') {
      compact.accountScopeUnavailable = session.accountScopeUnavailable;
    }
    if (typeof session.safeTaskSummary === 'string' && session.safeTaskSummary) {
      compact.safeTaskSummary = session.safeTaskSummary;
    }
    return compact;
  }

  function compactSessionTitleForStorage(session, titleSource, limits) {
    const rawTitle = typeof session.title === 'string' ? session.title.trim() : '';
    if (titleSource === 'manual') {
      return normalizeTextField(rawTitle === LEGACY_DEFAULT_SESSION_TITLE ? '' : rawTitle, limits.sessionTitleChars);
    }
    if (isOmittedStorageSummary(rawTitle)) {
      return normalizeTextField(rawTitle, limits.sessionTitleChars);
    }
    const firstRunTask = Array.isArray(session.runs) && session.runs.length ? session.runs[0]?.task : '';
    const seed = rawTitle && rawTitle !== LEGACY_DEFAULT_SESSION_TITLE
      ? rawTitle
      : (session.task || firstRunTask || '');
    return summarizeTextForStorage(seed, 'session title');
  }

  function compactHistory(history, limits) {
    return (Array.isArray(history) ? history : [])
      .slice(-10)
      .map(entry => ({
        task: summarizeTextForStorage(entry?.task, 'history task'),
        result: summarizeTextForStorage(entry?.result, 'history result'),
        at: typeof entry?.at === 'string' ? entry.at : ''
      }));
  }

  function compactRunsForStorage(runs, limits) {
    const selectedRuns = (Array.isArray(runs) ? runs : [])
      .filter(run => run && typeof run.id === 'string')
      .slice(-limits.maxRunsPerSession);
    const undoRunIds = new Set(selectedRuns
      .slice()
      .reverse()
      .filter(run => Array.isArray(run.undoOperations) && run.undoOperations.length)
      .slice(0, limits.maxUndoRunsPerSession)
      .map(run => run.id));
    return selectedRuns.map(run => compactRunForStorage(run, limits, undoRunIds.has(run.id)));
  }

  function compactRunForStorage(run, limits, keepUndoPayload) {
    const undoPayload = compactUndoPayload(run, limits, keepUndoPayload);
    const compact = {
      id: run.id,
      task: summarizeTextForStorage(run.task || 'untitled task', 'run task'),
      mode: typeof run.mode === 'string' ? run.mode : '',
      model: normalizeTextField(run.model, 80),
      reasoningEffort: typeof run.reasoningEffort === 'string' ? run.reasoningEffort : '',
      speedTier: typeof run.speedTier === 'string' ? run.speedTier : '',
      status: normalizeRunStatus(run.status),
      statusText: summarizeTextForStorage(run.statusText, 'status text'),
      runProjectId: normalizeProjectPrefKey(run.runProjectId),
      startedAt: typeof run.startedAt === 'string' ? run.startedAt : '',
      finishedAt: typeof run.finishedAt === 'string' ? run.finishedAt : '',
      events: compactRunEvents(run.events, limits),
      attachments: compactRunAttachmentsForStorage(run.attachments, limits),
      appliedOperations: [],
      undoOperations: undoPayload.undoOperations,
      undoBaseFiles: undoPayload.undoBaseFiles,
      undoTrackedChanges: undoPayload.undoTrackedChanges,
      undoExpectedFiles: undoPayload.undoExpectedFiles,
      undoStatus: summarizeTextForStorage(run.undoStatus, 'undo status')
    };
    if (VALID_TRACKED_CHANGE_STATUS.has(run.trackedChangeStatus)) {
      compact.trackedChangeStatus = run.trackedChangeStatus;
    }
    return compact;
  }

  function compactRunEvents(events, limits) {
    return (Array.isArray(events) ? events : [])
      .filter(event => event && typeof event.title === 'string')
      .slice(-limits.maxEventsPerRun)
      .map(event => {
        const compact = {
          title: summarizeTextForStorage(event.title, 'event title') || 'Event',
          status: normalizeEventStatus(event.status),
          timestamp: typeof event.timestamp === 'string' ? event.timestamp : '',
          kind: typeof event.kind === 'string' ? event.kind : 'activity',
          streamKey: typeof event.streamKey === 'string' ? event.streamKey : '',
          streamRole: typeof event.streamRole === 'string' ? event.streamRole : ''
        };
        if (event.subagent === true) {
          compact.subagent = true;
        }
        const detail = compactDetailForStorage(event.detail, getEventDetailLimit(event, limits));
        if (detail !== undefined) {
          compact.detail = detail;
        }
        // Keep the structured report payload + structured failure so the
        // demoted meta block and the recovery action survive a reload.
        if (event.detailStructured) {
          compact.detailStructured = sanitizeAssistantVisibleValue(event.detailStructured);
        }
        if (event.failure) {
          compact.failure = sanitizeAssistantVisibleValue(event.failure);
        }
        if (Array.isArray(event.compileErrors) && event.compileErrors.length) {
          compact.compileErrors = event.compileErrors.slice(0, 5)
            .map(item => sanitizeAssistantVisibleText(String(item)))
            .filter(Boolean);
        }
        if (Array.isArray(event.rejectedHunks) && event.rejectedHunks.length) {
          compact.rejectedHunks = event.rejectedHunks.slice(0, 10)
            .map(item => ({
              path: sanitizeAssistantVisibleText(String(item?.path || '')),
              summary: sanitizeAssistantVisibleText(String(item?.summary || ''))
            }))
            .filter(item => item.path);
        }
        return compact;
      });
  }

  function getEventDetailLimit(event, limits) {
    return event.kind === 'report'
      ? (limits.reportDetailChars || limits.detailChars)
      : limits.detailChars;
  }

  function compactDetailForStorage(detail, maxChars) {
    if (detail === undefined) {
      return undefined;
    }
    if (typeof detail === 'string') {
      return summarizeTextForStorage(detail, 'detail');
    }
    if (detail === null || typeof detail === 'number' || typeof detail === 'boolean') {
      return detail;
    }
    return summarizeStructuredValueForStorage(detail, maxChars);
  }

  function summarizeStructuredValueForStorage(value, maxChars) {
    const serialized = safeJsonStringify(value);
    const summary = {
      redacted: true,
      type: Array.isArray(value) ? 'array' : 'object',
      chars: serialized.length,
      hash: hashString(serialized)
    };
    const paths = collectPathMetadata(value, maxChars);
    if (paths.items.length) {
      summary.paths = paths.items;
      summary.pathCount = paths.count;
    }
    return summary;
  }

  function summarizeTextForStorage(value, label) {
    if (typeof value !== 'string' || !value.trim()) {
      return '';
    }
    const text = sanitizeAssistantVisibleText(value);
    if (isOmittedStorageSummary(text)) {
      return text;
    }
    return `[${label} omitted; chars=${text.length}; hash=${hashString(text)}]`;
  }

  function isOmittedStorageSummary(value) {
    return /^\[[^\]]+ omitted; chars=\d+; hash=[a-f0-9]{8}\]$/.test(String(value || '').trim());
  }

  function collectPathMetadata(value, maxChars, state = { seen: new Set(), items: [], count: 0 }) {
    if (!value || typeof value !== 'object') {
      return state;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        collectPathMetadata(item, maxChars, state);
      }
      return state;
    }
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (/(^|[A-Z_])path$/i.test(key) && typeof item === 'string') {
        const path = sanitizeAssistantVisibleText(item).replace(/\\/g, '/').replace(/^\/+/, '').trim();
        if (path) {
          state.count += 1;
          if (!state.seen.has(path) && state.items.length < 5) {
            state.seen.add(path);
            state.items.push(normalizeTextField(path, Math.min(maxChars || 240, 240)));
          }
        }
      } else {
        collectPathMetadata(item, maxChars, state);
      }
    }
    return state;
  }

  function compactUndoPayload(run, limits, keepUndoPayload) {
    return {
      undoOperations: [],
      undoBaseFiles: [],
      undoTrackedChanges: [],
      undoExpectedFiles: []
    };
  }

  function normalizeMode(mode) {
    return VALID_MODES.has(mode) ? mode : DEFAULT_PANEL_STATE.mode;
  }

  function normalizeReasoning(reasoningEffort) {
    return VALID_REASONING.has(reasoningEffort)
      ? reasoningEffort
      : DEFAULT_PANEL_STATE.reasoningEffort;
  }

  function normalizeSpeedTier(speedTier) {
    return VALID_SPEED_TIERS.has(speedTier)
      ? speedTier
      : DEFAULT_PANEL_STATE.speedTier;
  }

  function normalizeLocale(locale) {
    return VALID_LOCALES.has(locale) ? locale : DEFAULT_PANEL_STATE.locale;
  }

  function normalizePanelWidth(value) {
    const width = Number(value);
    if (!Number.isFinite(width) || width <= 0) {
      return DEFAULT_PANEL_STATE.panelWidth;
    }
    return Math.round(Math.min(760, Math.max(340, width)));
  }

  // Welcome-panel + write-guard: the Recent-projects
  // dashboard variant renders one sanitized line per project. `computeSafeTaskSummary`
  // is the privacy floor for that line. It is written on every `saveState` and
  // stored on the session record (`session.safeTaskSummary`), so the dashboard
  // never has to touch the raw `task` text on render.
  //
  // The `@` regex is intentionally broad — see spec §5.6.2:
  //   > Replace `@<token>` references with `@…` (regex `/@[\w./-]+/g` → `'@…'`).
  //   > This intentionally over-redacts: it will also strip plain email
  //   > addresses, social handles, and any `@foo` mention in the task body.
  //   > That is the conservative-privacy choice and is by design — future
  //   > implementers must not narrow the pattern to "only known attachment
  //   > tokens" because doing so would re-expose paths, citation keys,
  //   > reviewer names, etc. that users frequently combine with `@` in task
  //   > text.
  function computeSafeTaskSummary(task) {
    if (typeof task !== 'string' || !task) return '';
    let s = task;
    // Strip absolute local paths via the canonical shared helper
    // (spec §5.6.2). The helper covers Unix (/Users, /home,
    // /private/var, /tmp, /var/folders, /Volumes, /etc, /opt, /usr, ...),
    // Windows drive letters with both `\\` and `/`, UNC `\\server\share`,
    // and `file:///` URLs. Adding a new path shape is a one-line change
    // in `pathRedaction.js` and benefits both this summary and the
    // storage-side audit redaction in lockstep.
    if (PathRedaction && PathRedaction.redactLocalPaths instanceof Function) {
      s = PathRedaction.redactLocalPaths(s, '<local-path>');
    } else {
      // Defensive fallback for hosts where the shared helper failed to
      // load. The narrower legacy patterns ship a baseline (better than
      // nothing) and the test suite asserts the broad coverage path
      // succeeds, so this branch should never run in production.
      s = s.replace(/(?:\/Users\/[^\s]+|\/home\/[^\s]+|\/private\/var\/[^\s]+|\/tmp\/[^\s]+|\/Volumes\/[^\s]+)/g, '<local-path>');
      s = s.replace(/[A-Za-z]:[\\/][^\s]+/g, '<local-path>');
    }
    // INTENTIONALLY OVER-REDACT @<token>: spec §5.6.2 — do not narrow to
    // attachment tokens, that would re-expose user info / paths / handles.
    s = s.replace(/@[\w./-]+/g, '@…');
    // Collapse whitespace runs to single space; trim.
    s = s.replace(/\s+/g, ' ').trim();
    // Hard cap 80 visible chars.
    if (s.length > 80) s = s.slice(0, 79) + '…';
    return s;
  }

  function normalizeTextField(value, maxChars) {
    const text = sanitizeAssistantVisibleText(value);
    if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
      return text;
    }
    return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
  }

  function normalizeHistoryEntries(history) {
    return (Array.isArray(history) ? history : [])
      .slice(-10)
      .map(entry => ({
        task: sanitizeAssistantVisibleText(entry?.task) || 'untitled task',
        result: sanitizeAssistantVisibleText(entry?.result || entry?.status) || 'completed',
        at: typeof entry?.at === 'string' ? entry.at : ''
      }));
  }

  function sanitizeAssistantVisibleValue(value, depth = 0) {
    if (typeof value === 'string') {
      return sanitizeAssistantVisibleText(value);
    }
    if (value === undefined || value === null || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (depth > 12) {
      return '[redacted nested value]';
    }
    if (Array.isArray(value)) {
      return value.map(item => sanitizeAssistantVisibleValue(item, depth + 1));
    }
    if (typeof value === 'object') {
      const result = {};
      for (const key of Object.keys(value)) {
        const safeKey = sanitizeAssistantVisibleText(key) || key;
        result[safeKey] = sanitizeAssistantVisibleValue(value[key], depth + 1);
      }
      return result;
    }
    return value;
  }

  function sanitizeAssistantVisibleText(value) {
    if (typeof value !== 'string' || !value) {
      return '';
    }
    const secretRedacted = redactSecretLikeText(value);
    if (!mightContainLocalReferenceText(secretRedacted)) {
      return secretRedacted;
    }
    if (LineReferences?.sanitizeLocalReferences) {
      try {
        return LineReferences.sanitizeLocalReferences(secretRedacted, {
          projectFiles: [],
          context: 'persist'
        });
      } catch (_error) {
        return fallbackSanitizeLocalReferences(secretRedacted);
      }
    }
    return fallbackSanitizeLocalReferences(secretRedacted);
  }

  function mightContainLocalReferenceText(value) {
    return /(?:file:\/\/\/?|[A-Za-z]:[\\/]|\/(?:Users|home|private|var|tmp)\/|[\\/]\.codex-overleaf[\\/]projects[\\/]|\.codex-overleaf[\\/]projects[\\/])/i.test(String(value || ''));
  }

  function loadLineReferences() {
    if (typeof globalThis !== 'undefined' && globalThis.CodexOverleafLineReferences) {
      return globalThis.CodexOverleafLineReferences;
    }
    if (typeof require === 'function') {
      try {
        return require('./lineReferences');
      } catch (_error) {
        return null;
      }
    }
    return null;
  }

  function loadPathRedaction() {
    if (typeof globalThis !== 'undefined' && globalThis.CodexOverleafPathRedaction) {
      return globalThis.CodexOverleafPathRedaction;
    }
    if (typeof require === 'function') {
      try {
        return require('./pathRedaction');
      } catch (_error) {
        return null;
      }
    }
    return null;
  }

  function fallbackSanitizeLocalReferences(value) {
    return String(value || '')
      .replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_raw, label, target) => {
        const safeLabel = fallbackSanitizeBareLocalPaths(label);
        return /^https?:\/\//i.test(String(target || '').trim())
          ? `[${safeLabel}](${target})`
          : `[${safeLabel}]`;
      })
      .replace(/(?:file:\/\/\/?[^\s)\]]+|[A-Za-z]:[\\/][^\s)\]]+|\/(?:Users|home|private|var|tmp)\/[^\s)\]]+|[^\s)\]]*[\\/]\.codex-overleaf[\\/][^\s)\]]+)/gi, rawPath => {
        const line = String(rawPath || '').match(/:(\d+)(?::\d+)?(?:[.,;!?])?$/)?.[1];
        return line ? `[local path:${line}]` : '[local path]';
      });
  }

  function fallbackSanitizeBareLocalPaths(value) {
    return String(value || '').replace(/(?:file:\/\/\/?[^\s)\]]+|[A-Za-z]:[\\/][^\s)\]]+|\/(?:Users|home|private|var|tmp)\/[^\s)\]]+|[^\s)\]]*[\\/]\.codex-overleaf[\\/][^\s)\]]+)/gi, rawPath => {
      const line = String(rawPath || '').match(/:(\d+)(?::\d+)?(?:[.,;!?])?$/)?.[1];
      return line ? `[local path:${line}]` : '[local path]';
    });
  }

  function redactSecretLikeText(value) {
    if (typeof value !== 'string') {
      return '';
    }
    let redacted = value;
    for (const pattern of SECRET_REDACTION_PATTERNS) {
      pattern.lastIndex = 0;
      redacted = redacted.replace(pattern, REDACTED_SECRET);
    }
    return redacted;
  }

  function containsSecretLikeText(value) {
    if (typeof value === 'string') {
      return SECRET_REDACTION_PATTERNS.some(pattern => {
        pattern.lastIndex = 0;
        return pattern.test(value);
      });
    }
    if (Array.isArray(value)) {
      return value.some(containsSecretLikeText);
    }
    if (value && typeof value === 'object') {
      return Object.values(value).some(containsSecretLikeText);
    }
    return false;
  }

  function safeJsonStringify(value) {
    try {
      return JSON.stringify(value) || '';
    } catch (_error) {
      return '[unserializable]';
    }
  }

  function safeJsonClone(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_error) {
      return [];
    }
  }

  function hashString(value) {
    let hash = 2166136261;
    const text = String(value || '');
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function estimateJsonBytes(value) {
    let serialized = '';
    try {
      serialized = JSON.stringify(value);
    } catch (_error) {
      return Infinity;
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.byteLength(serialized, 'utf8');
    }
    return new Blob([serialized]).size;
  }

  return {
    DEFAULT_PANEL_STATE,
    createSession,
    deleteSession,
    getActiveSession,
    isDisplayableSession,
      normalizePanelState,
      deriveSessionTitle,
    renameSession,
      recordSessionResult,
    selectVisibleSessionsForList,
    setActiveSession,
    updateActiveSession,
    normalizeRuns,
    prepareStateForStorage,
    estimateJsonBytes,
    computeSafeTaskSummary
  };
});
