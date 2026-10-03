(function initCodexOverleafSessionForkController(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafSessionForkController = api;
})(typeof window !== 'undefined' ? window : globalThis, function sessionForkControllerFactory() {
  'use strict';

  function create(deps = {}) {
    const {
      SessionState, getState, setState, getScope, sendBackgroundNative, saveState,
      applyStateToPanel, showPluginToast, tr
    } = deps;

    async function forkRunFromNode(runId) {
      const previousState = getState();
      const source = findSource(previousState, runId);
      if (!source) return failFork('session_fork_source_missing', tr('forkRunUnavailable'));
      const scope = getScope ? { ...getScope() } : null;
      const requestedActiveId = previousState.activeSessionId;
      // The Native request and copied history must describe the same origin,
      // even when the source session is edited while the request is pending.
      const { session, run, runIndex } = JSON.parse(JSON.stringify(source));
      const sameScope = () => {
        const current = getScope?.();
        return !scope || ['accountScopeId', 'projectId', 'generation'].every(key => current?.[key] === scope[key]);
      };
      const currentSource = () => {
        const current = findSource(getState(), runId);
        return current?.session.id === session.id && current.run.codexTurnId === run.codexTurnId;
      };
      const draftThreadId = run.codexTurnId && run.interruptedDraft?.turnId === run.codexTurnId
        ? run.interruptedDraft.threadId : '';
      // Provider switches replace the session thread, not the selected node's origin.
      const sourceThreadId = String(run.codexThreadId || draftThreadId || session.codexThreadId || '').trim();
      if (run.status === 'running' || !sourceThreadId || !run.codexTurnId) {
        return failFork('session_fork_unavailable', tr('forkRunUnavailable'));
      }
      let response;
      try {
        response = await sendBackgroundNative({
          method: 'codex.thread.fork',
          params: {
            threadId: sourceThreadId,
            lastTurnId: run.codexTurnId,
            speedTier: session.speedTier,
            loadCodexLocalSkills: previousState.loadCodexLocalSkills !== false,
            loadCodexOverleafSkills: previousState.loadCodexOverleafSkills !== false
          }
        });
      } catch (error) {
        if (!sameScope() || !currentSource()) return null;
        return failFork(error?.code || 'session_fork_failed', error?.message || tr('forkRunFailed'));
      }
      if (!sameScope() || !currentSource()) {
        if (response?.ok && response.result?.threadId) await clearFork(response.result.threadId);
        return null;
      }
      if (!response?.ok || !response.result?.threadId) {
        return failFork(response?.error?.code || 'session_fork_failed', response?.error?.message || tr('forkRunFailed'));
      }
      const copiedRuns = session.runs.slice(0, runIndex + 1).map(copyRunSnapshot);
      const titleBase = String(session.title || copiedRuns[0]?.task || tr('newSessionFallback')).trim();
      const mergeBase = getState();
      const forkTitle = buildUniqueForkTitle(mergeBase.sessions, titleBase);
      const forked = SessionState.createSession({
        title: forkTitle,
        titleSource: 'manual',
        runs: copiedRuns,
        task: '',
        mode: session.mode,
        providerId: session.providerId,
        model: session.model,
        reasoningEffort: session.reasoningEffort,
        speedTier: session.speedTier,
        requireReviewing: session.requireReviewing,
        focusFiles: session.focusFiles,
        projectReferenceFiles: session.projectReferenceFiles,
        codexThreadId: response.result.threadId,
        pendingInputs: [],
        forkedFromSessionId: session.id,
        forkedFromRunId: run.id
      });
      const activeId = mergeBase.activeSessionId === requestedActiveId
        ? forked.id : mergeBase.activeSessionId;
      const installed = SessionState.setActiveSession({
        ...mergeBase, sessions: [...(mergeBase.sessions || []), forked]
      }, activeId);
      const installedSnapshot = JSON.stringify(installed);
      const forkSnapshot = JSON.stringify(forked);
      setState(installed);
      try {
        // Keep the visible composer and active-session owner aligned during save.
        applyStateToPanel();
        await saveState();
      } catch (error) {
        if (sameScope()) {
          const current = getState();
          const currentFork = current.sessions?.find(item => item.id === forked.id);
          // Never erase work entered into the fork after its optimistic insert.
          if (!currentFork || JSON.stringify(currentFork) === forkSnapshot) {
            if (currentFork) {
              if (current === installed && JSON.stringify(current) === installedSnapshot) {
                setState(mergeBase);
              } else {
                const remaining = current.sessions.filter(item => item.id !== forked.id);
                const fallbackId = remaining.some(item => item.id === mergeBase.activeSessionId)
                  ? mergeBase.activeSessionId : remaining[remaining.length - 1]?.id;
                setState(SessionState.setActiveSession({ ...current, sessions: remaining },
                  current.activeSessionId === forked.id ? fallbackId : current.activeSessionId));
              }
              try { applyStateToPanel(); } catch (_renderError) { /* Preserve the original failure and finish cleanup. */ }
            }
            await clearFork(response.result.threadId, forked.id);
          }
          if (sameScope()) showPluginToast(error.message || tr('forkRunFailed'), { status: 'failed', sticky: true });
        }
        throw error;
      }
      // Persistence owns its captured scope. A late result cannot render a new
      // view or delete a thread that may already have been saved in the old one.
      if (!sameScope() || !getState().sessions?.some(item => item.id === forked.id)) return null;
      showPluginToast(tr('forkRunDone'), { status: 'completed' });
      return forked;
    }

    async function clearFork(threadId, sessionId) {
      try {
        await sendBackgroundNative({ method: 'codex.history.clearPlugin', params: { sessionId, threadId } });
      } catch (_error) { /* Best-effort cleanup must not restore a stale view. */ }
    }

    function failFork(code, message) {
      showPluginToast(message, { status: 'failed', sticky: true });
      throw codedError(code, message);
    }

    return { forkRunFromNode };
  }

  function buildUniqueForkTitle(sessions = [], sourceTitle = '') {
    const fallback = String(sourceTitle || 'New Session').trim() || 'New Session';
    const baseTitle = fallback
      .replace(/\s+\(fork\)$/i, '')
      .replace(/\s+\(\d+\)$/, '')
      .trim() || fallback;
    const usedTitles = new Set((sessions || []).map(session => String(session?.title || '').trim()));
    let index = 1;
    while (usedTitles.has(`${baseTitle} (${index})`)) index += 1;
    return `${baseTitle} (${index})`;
  }

  function findSource(state, runId) {
    for (const session of state?.sessions || []) {
      const runIndex = (session.runs || []).findIndex(run => run.id === runId);
      if (runIndex >= 0) return { session, run: session.runs[runIndex], runIndex };
    }
    return null;
  }

  function copyRunSnapshot(run) {
    const copy = JSON.parse(JSON.stringify(run || {}));
    return {
      ...copy,
      id: `fork_${String(copy.id || 'run')}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      forkSnapshot: true,
      forkSourceRunId: String(copy.id || ''),
      attachments: [], appliedOperations: [], undoOperations: [], undoBaseFiles: [],
      undoTrackedChanges: [], undoExpectedFiles: [], undoStatus: '',
      trackedChangeStatus: '', nativeRequestId: '', queueItemId: '', interruptedDraft: undefined
    };
  }

  function codedError(code, message) { const error = new Error(message); error.code = code; return error; }
  return { copyRunSnapshot, create };
});
