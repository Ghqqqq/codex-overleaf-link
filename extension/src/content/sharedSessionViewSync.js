(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexOverleafModuleRegistry.define('SharedSessionViewSync', [], factory);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function install(options) {
    const { Bridge, StorageDb, getScope, getState, isBusy, apply, notice } = options;
    let saving = 0, version = 0, pending = false, timer = null, refreshing = false, stopped = false;
    const sameScope = (a, b) => a.accountScopeId === b.accountScopeId
      && a.projectId === b.projectId && a.generation === b.generation;
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
      // A draft or a not-yet-persisted edit always takes priority over passive
      // history refresh. It remains on screen until the user saves/sends it.
      if (local.task || (local.sessions || []).some(session => StorageDb.hasUnpersistedSharedSession(session))) {
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
        // The data has now been adopted by this view; future writes may use it
        // as a merge baseline. Snapshot reads alone never advance the baseline.
        StorageDb.adoptSharedSessionBaseline(records);
        apply([...records, ...newLocal]);
      } catch (error) {
        notice?.(error);
      } finally {
        refreshing = false;
        schedule(1000);
      }
    }
    const unsubscribe = Bridge.subscribe(change => {
      const scope = getScope();
      if (!change.projectId || change.projectId === scope.projectId) {
        pending = true; schedule();
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
  return { install };
});
