(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexOverleafModuleRegistry.define('SharedSessionViewSync', [], factory);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const sameScope = (a, b) => a.accountScopeId === b.accountScopeId
    && a.projectId === b.projectId && a.generation === b.generation;

  function applySnapshot(options, sessions) {
    const previous = options.getState(), scope = options.getScope();
    const input = sessions.length ? { ...previous, sessions } : {
      ...previous, session: null, sessions: [], runs: [], activeSessionId: '',
      task: '', focusFiles: [], selectionContext: null, composerAttachments: []
    };
    const next = options.normalize(input, { restoreRunningRuns: false });
    const unchangedSnapshot = JSON.stringify(next);
    options.setState(next);
    try {
      options.render();
    } catch (error) {
      // A callback may replace state, edit it in place or navigate. Restore only
      // the unchanged view owned by this failed passive application.
      let unchanged = false;
      try {
        unchanged = options.getState() === next && sameScope(scope, options.getScope())
          && JSON.stringify(options.getState()) === unchangedSnapshot;
      } catch (_error) { /* Unknown state must not overwrite a newer edit. */ }
      if (unchanged) {
        options.setState(previous);
        // A second render can also fail. The old merge base still protects
        // subsequent saves, including values from partially restored controls.
        try { options.render(); } catch (_error) { /* Report the first failure. */ }
      }
      throw error;
    }
  }

  function install(options) {
    const { Bridge, StorageDb, getScope, getState, isBusy, notice } = options;
    const apply = options.apply || (sessions => applySnapshot(options, sessions));
    let saving = 0, version = 0, pending = false, timer = null, refreshing = false, stopped = false;
    let retryCount = 0;
    const signature = state => JSON.stringify([state.activeSessionId,
      (state.sessions || []).map(session => [session.id, session.updatedAt, session.task])]);
    function schedule(delay = 250) {
      if (stopped || timer || !pending) return;
      timer = setTimeout(() => { timer = null; void refresh(); }, delay);
    }
    async function refresh() {
      if (refreshing || stopped || !pending) return;
      const scope = getScope();
      if (!scope.projectId || !scope.accountScopeId) { pending = false; return; }
      if (saving || isBusy()) { schedule(1000); return; }
      const local = getState();
      // A locally edited draft or a not-yet-persisted edit takes priority over
      // passive history refresh. Callers may distinguish imported shared drafts.
      if ((options.hasLocalDraft ? options.hasLocalDraft(local) : Boolean(local.task))
        || (local.sessions || []).some(session => StorageDb.hasUnpersistedSharedSession(session))) {
        schedule(1500); return;
      }
      const capturedVersion = version, capturedSignature = signature(local);
      pending = false; refreshing = true;
      try {
        const records = await StorageDb.readSharedProjectSnapshot(scope.projectId);
        if (!sameScope(scope, getScope())) return;
        if (saving || isBusy() || version !== capturedVersion || signature(getState()) !== capturedSignature) {
          pending = true; return;
        }
        const ids = new Set(records.map(record => record.id));
        const newLocal = (local.sessions || []).filter(session =>
          !ids.has(session.id) && !StorageDb.wasSharedSessionStored(session.id));
        // Rendering may fail after only part of the composer was updated.
        // Keep the prior merge base until the complete view accepts the data.
        apply([...records, ...newLocal]);
        if (stopped || !sameScope(scope, getScope())) return;
        if (saving || version !== capturedVersion) { pending = true; return; }
        StorageDb.adoptSharedSessionBaseline(records);
        retryCount = 0;
      } catch (error) {
        notice?.(error);
        // One retry can recover transient DOM failures. Local edits, navigation
        // and persistent failures stop it; another notification starts afresh.
        if (!stopped && sameScope(scope, getScope()) && version === capturedVersion
          && signature(getState()) === capturedSignature && retryCount < 1) {
          retryCount++; pending = true;
        }
      } finally {
        refreshing = false;
        schedule(1000);
      }
    }
    const unsubscribe = Bridge.subscribe(change => {
      const scope = getScope();
      if (options.isDashboard?.()) {
        if (scope.accountScopeId && change.accountScopeId === scope.accountScopeId) options.refreshDashboard?.();
        return;
      }
      if (!change.projectId || change.projectId === scope.projectId) {
        retryCount = 0; pending = true; schedule();
      }
    });
    return {
      beginSave() {
        saving += 1; version += 1;
        let ended = false;
        return () => {
          if (ended) return;
          ended = true; saving -= 1; version += 1; schedule();
        };
      },
      dispose() {
        stopped = true; clearTimeout(timer); unsubscribe();
      }
    };
  }
  return { install, applySnapshot };
});
