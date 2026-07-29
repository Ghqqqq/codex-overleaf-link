(function initCodexOverleafSessionManager() {
  'use strict';

  // Session manager — the session lifecycle + list/delete surface
  // carved out of contentRuntime.js (v1.4.7 structural-debt phase 3). Code
  // moved verbatim except that mutable runtime state is read through
  // getState()/getPanel()/getSessionPanelInstance() and written back through
  // setState() (sessions are immutable-update: every mutation rebuilds state
  // via the shared sessionState helpers and hands it back to the runtime).
  function create(deps = {}) {
    const {
      SessionPanel,
      SessionState,
      SessionMenuView
    } = deps;
    const {
      createSession,
      deleteSession,
      setActiveSession,
      getActiveSession,
      isDisplayableSession,
      normalizePanelState,
      deriveSessionTitle
    } = SessionState;
    const {
      tr,
      showPluginConfirm,
      showPluginToast,
      sendBackgroundNative,
      saveState,
      saveStateSoon,
      readPanelInputs,
      applyStateToPanel,
      syncSessionProvider,
      getPanel,
      getState,
      setState,
      getSessionPanelInstance,
      formatSessionTime
    } = deps;

    const sessionMenuView = SessionMenuView.create({
      commitSessionRename,
      deleteSessionWithConfirm,
      document,
      formatSessionTime,
      getActiveSession,
      getPanel,
      getSessionDisplayTitle,
      getState,
      isDisplayableSession,
      isSessionRunning,
      startNewSession,
      switchSession,
      tr
    });
    const {
      applySessionLabel,
      bindActiveSessionHeader,
      closeSessionMenu
    } = sessionMenuView;

  async function startNewSession() {
    // Leaving a still-running session is allowed but never silent: the run
    // keeps going in the background and lands in its own session.
    const runningActive = getActiveSession(getState());
    if (runningActive && isSessionRunning(runningActive)) {
      const approved = await showPluginConfirm({
        title: tr('sessionSwitchRunningTitle'),
        message: tr('sessionSwitchRunningMessage'),
        confirmLabel: tr('sessionSwitchRunningConfirm')
      });
      if (!approved) {
        return;
      }
    }
    readPanelInputs();
    // Reuse an already-empty, idle active session instead of minting a ghost.
    // Empty sessions are invisible in the list yet still consume the storage cap
    // (slice(-20) / maxSessions), so spamming "New Session" could silently evict
    // real history. Only mint when the current session holds real work.
    const active = getActiveSession(getState());
    if (active && !isDisplayableSession(active) && !isSessionRunning(active)) {
      getPanel().querySelector('[data-task]')?.focus();
      return;
    }
    // The 21st session silently and PERMANENTLY evicts the oldest one
    // (slice(-20) + the storage retention diff physically deletes its
    // record). Never let that happen without consent.
    const currentSessions = getState().sessions || [];
    if (currentSessions.length >= 20) {
      const oldest = currentSessions[0];
      const evictionApproved = await showPluginConfirm({
        title: tr('sessionEvictTitle'),
        message: tr('sessionEvictMessage', { title: String(oldest?.title || '').slice(0, 40) || '…' }),
        confirmLabel: tr('sessionEvictConfirm'),
        destructive: true
      });
      if (!evictionApproved) {
        return;
      }
    }
    const session = createSession({
      mode: getState().mode,
      providerId: getState().providerId || 'builtin',
      model: getState().model,
      reasoningEffort: getState().reasoningEffort,
      speedTier: getState().speedTier,
      requireReviewing: getState().requireReviewing
    });
    setState(normalizePanelState({
      ...getState(),
      sessions: [...(getState().sessions || []), session].slice(-20),
      activeSessionId: session.id
    }));
    applyStateToPanel();
    await syncSessionProvider?.();
    await saveState();
    getPanel().querySelector('[data-task]')?.focus();
  }

  async function switchSession(sessionId) {
    if (sessionId === getState().activeSessionId) {
      return;
    }
    const runningActive = getActiveSession(getState());
    if (runningActive && isSessionRunning(runningActive)) {
      const approved = await showPluginConfirm({
        title: tr('sessionSwitchRunningTitle'),
        message: tr('sessionSwitchRunningMessage'),
        confirmLabel: tr('sessionSwitchRunningConfirm')
      });
      if (!approved) {
        return;
      }
    }
    readPanelInputs();
    setState(setActiveSession(getState(), sessionId));
    applyStateToPanel();
    await syncSessionProvider?.();
    await saveState();
  }

  async function deleteSessionWithConfirm(sessionId) {
    const target = (getState().sessions || []).find(session => session.id === sessionId);
    if (!target) {
      return;
    }
    if (isSessionRunning(target)) {
      showPluginToast(tr('deleteSessionRunningToast'), { status: 'warning' });
      return;
    }

    const remaining = (getState().sessions || []).filter(session => session.id !== sessionId);

    // An empty (non-displayable) session has no task/runs/history and no native
    // thread, so deleting it is a lossless local action — skip the destructive
    // modal. Deleting the sole empty session would just mint another empty, so
    // it is a no-op.
    if (!isDisplayableSession(target)) {
      if (!remaining.length) {
        return;
      }
      setState(deleteSession(getState(), sessionId));
      await saveState({ deletedSessionIds: [sessionId] });
      applyStateToPanel();
      showPluginToast(tr('deleteSessionDeletedToast'), { status: 'info' });
      return;
    }

    // Deleting the only session is really a reset (deleteSession mints a fresh
    // empty replacement), so use honest copy for that case.
    const lastSession = remaining.length === 0;
    const approved = await showPluginConfirm({
      title: lastSession ? tr('resetSessionTitle') : tr('deleteSessionTitle'),
      message: lastSession
        ? tr('resetSessionMessage')
        : [
          getSessionDisplayTitle(target),
          '',
          tr('deleteSessionMessage')
        ].join('\n'),
      confirmLabel: lastSession ? tr('resetSessionConfirm') : tr('deleteSessionConfirm'),
      cancelLabel: tr('confirmDefaultCancel'),
      destructive: true
    });
    if (!approved) {
      return;
    }

    setState(deleteSession(getState(), sessionId));
    await saveState({ deletedSessionIds: [sessionId] });
    applyStateToPanel();

    try {
      const response = await sendBackgroundNative({
        method: 'codex.history.clearPlugin',
        params: {
          sessionId,
          threadId: target.codexThreadId || ''
        }
      });
      if (!response?.ok) {
        showPluginToast(tr('deleteSessionHistoryFailedToast', { message: response?.error?.message || 'native host did not return success' }), { status: 'warning', sticky: true });
      } else if (response.result?.skipped) {
        showPluginToast(tr('deleteSessionNoThreadToast'), { status: 'info' });
      } else {
        showPluginToast(tr('deleteSessionDoneToast'), { status: 'completed' });
      }
    } catch (error) {
      showPluginToast(tr('deleteSessionHistoryFailedToast', { message: error.message }), { status: 'warning', sticky: true });
    }
  }
  function renderSessionList(options = {}) {
    // Omit showAll unless a caller explicitly sets it, so the getPanel() keeps its own
    // expanded/collapsed getState() across re-renders (see sessionPanel.update).
    const updateOptions = { pinnedSessionIds: getRunningSessionIds() };
    if (options.showAll !== undefined) {
      updateOptions.showAll = options.showAll;
    }
    SessionPanel.update(getSessionPanelInstance(), getState()?.sessions || [], getState()?.activeSessionId || null, updateOptions);
  }

  function getSessionDisplayTitle(session) {
    return SessionPanel.getDisplayTitle(getSessionPanelInstance(), session);
  }



  async function commitSessionRename(sessionId, title) {
    const session = findSessionById(sessionId);
    if (!session) {
      return;
    }
    const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim();
    const derived = deriveSessionTitle(session.runs, session.task);
    // Only a value that is genuinely a custom title becomes a pinned manual
    // title. An empty value, the localized New Session placeholder, or the
    // auto-derived title itself all stay 'auto' — otherwise renaming an empty
    // session would promote the placeholder into a real title (resurrecting the
    // ghost the prune/reuse-guard eliminate) and a no-op blur would freeze an
    // auto title.
    const isCustom = Boolean(cleanTitle) && cleanTitle !== tr('newSessionFallback') && cleanTitle !== derived;
    replaceSessionInState({
      ...session,
      title: isCustom ? cleanTitle : derived,
      titleSource: isCustom ? 'manual' : 'auto',
      updatedAt: new Date().toISOString()
    });
    await saveState();
    applySessionLabel();
    renderSessionList();
  }
  function getRunningSessionIds() {
    return (getState().sessions || [])
      .filter(isSessionRunning)
      .map(session => session.id);
  }

  function isSessionRunning(session) {
    return Boolean((session?.runs || []).some(run => run.status === 'running'));
  }
  function findSessionById(sessionId) {
    if (!sessionId) {
      return null;
    }
    return (getState().sessions || []).find(session => session.id === sessionId)
      || (getState().session?.id === sessionId ? getState().session : null);
  }

  function replaceSessionInState(session) {
    if (!session?.id) {
      return;
    }
    setState(normalizePanelState({
      ...getState(),
      sessions: (getState().sessions || []).map(item => item.id === session.id ? session : item)
    }));
  }

  function updateSessionById(sessionId, patch = {}) {
    const session = findSessionById(sessionId);
    if (!session) {
      return;
    }
    replaceSessionInState({
      ...session,
      ...patch
    });
  }

    return {
      closeSessionMenu,
      applySessionLabel,
      bindActiveSessionHeader,
      startNewSession,
      switchSession,
      deleteSessionWithConfirm,
      renderSessionList,
      commitSessionRename,
      getRunningSessionIds,
      isSessionRunning,
      findSessionById,
      replaceSessionInState,
      updateSessionById
    };
  }

  window.CodexOverleafSessionManager = { create };
})();
