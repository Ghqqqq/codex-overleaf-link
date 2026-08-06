(function initCodexOverleafSessionForkController(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafSessionForkController = api;
})(typeof window !== 'undefined' ? window : globalThis, function sessionForkControllerFactory() {
  'use strict';

  function create(deps = {}) {
    const {
      SessionState, getState, setState, sendBackgroundNative, saveState,
      applyStateToPanel, showPluginToast, tr
    } = deps;

    async function forkRunFromNode(runId) {
      const previousState = getState();
      const source = findSource(previousState, runId);
      if (!source) return failFork('session_fork_source_missing', tr('forkRunUnavailable'));
      const { session, run, runIndex } = source;
      if (run.status === 'running' || !session.codexThreadId || !run.codexTurnId) {
        return failFork('session_fork_unavailable', tr('forkRunUnavailable'));
      }
      const response = await sendBackgroundNative({
        method: 'codex.thread.fork',
        params: {
          threadId: session.codexThreadId,
          lastTurnId: run.codexTurnId,
          speedTier: session.speedTier,
          loadCodexLocalSkills: previousState.loadCodexLocalSkills !== false,
          loadCodexOverleafSkills: previousState.loadCodexOverleafSkills !== false
        }
      });
      if (!response?.ok || !response.result?.threadId) {
        return failFork(response?.error?.code || 'session_fork_failed', response?.error?.message || tr('forkRunFailed'));
      }
      const copiedRuns = session.runs.slice(0, runIndex + 1).map(copyRunSnapshot);
      const titleBase = String(session.title || copiedRuns[0]?.task || tr('newSessionFallback')).trim();
      const forkTitle = buildUniqueForkTitle(previousState.sessions, titleBase);
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
      setState(SessionState.normalizePanelState({
        ...previousState,
        sessions: [...(previousState.sessions || []), forked],
        activeSessionId: forked.id
      }));
      try {
        await saveState();
      } catch (error) {
        setState(previousState);
        await sendBackgroundNative({
          method: 'codex.history.clearPlugin',
          params: { sessionId: forked.id, threadId: response.result.threadId }
        }).catch(() => null);
        showPluginToast(error.message || tr('forkRunFailed'), { status: 'failed', sticky: true });
        throw error;
      }
      applyStateToPanel();
      showPluginToast(tr('forkRunDone'), { status: 'completed' });
      return forked;
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
