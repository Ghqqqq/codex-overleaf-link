(function initCodexOverleafProjectSessionCleanup() {
  'use strict';

  const FRESH_RUNNING_WINDOW_MS = 30 * 60 * 1000;

  function create(deps = {}) {
    const {
      tr,
      getAccountScopeId,
      showPluginConfirm,
      showPluginToast,
      sendBackgroundNative,
      mutateProjectPanelState,
      renderRecentProjectsVariant
    } = deps;

    function isFreshRunningRecord(StorageDb, record) {
      if (StorageDb.derivePrimaryStatusBadge(record) !== 'running') {
        return false;
      }
      const touched = Date.parse(record.updatedAt || record.lastActivityAt || record.createdAt || '');
      return !Number.isFinite(touched) || (Date.now() - touched) <= FRESH_RUNNING_WINDOW_MS;
    }

    async function clearProjectSessions(projectId, projectName) {
      const StorageDb = deps.StorageDb;
      const SessionState = deps.SessionState;
      if (!StorageDb || !SessionState) {
        return;
      }
      const scope = getAccountScopeId();
      const records = (await StorageDb.getAllByIndex('sessions', 'projectId', projectId))
        .filter(record => record && (!scope || record.accountScopeId === scope));
      if (!records.length) {
        await renderRecentProjectsVariant();
        return;
      }
      if (records.some(record => isFreshRunningRecord(StorageDb, record))) {
        showPluginToast(tr('recentProjects_clearProject_running'), { status: 'warning', sticky: true });
        return;
      }
      const approved = await showPluginConfirm({
        title: tr('recentProjects_clearProject_title', { project: projectName }),
        message: tr('recentProjects_clearProject_message', { count: String(records.length), project: projectName }),
        confirmLabel: tr('recentProjects_clearProject_confirm'),
        cancelLabel: tr('confirmDefaultCancel'),
        destructive: true
      });
      if (!approved) {
        return;
      }
      const Migration = deps.StorageMigration;
      if (Migration?.addSessionTombstones) {
        await Migration.addSessionTombstones(projectId, records.map(record => record.id));
      }
      try {
        await mutateProjectPanelState(projectId, state => records.reduce(
          (nextState, record) => SessionState.deleteSession(nextState, record.id),
          state
        ));
      } catch (_error) { /* IndexedDB deletion remains authoritative for the dashboard. */ }

      let removed = 0;
      let historyFailures = 0;
      for (const record of records) {
        try {
          await StorageDb.deleteRecord('sessions', record.id);
          removed++;
        } catch (_error) { /* The remaining record stays visible and can be retried. */ }
        try {
          const response = await sendBackgroundNative({
            method: 'codex.history.clearPlugin',
            params: { sessionId: record.id, threadId: record.codexThreadId || '' }
          });
          if (!response || !response.ok) {
            historyFailures++;
          }
        } catch (_error) {
          historyFailures++;
        }
      }
      if (removed < records.length) {
        showPluginToast(tr('recentProjects_clearProject_partial', {
          removed: String(removed),
          count: String(records.length)
        }), { status: 'warning', sticky: true });
      } else if (historyFailures) {
        showPluginToast(tr('recentProjects_clearProject_historyPartial', {
          count: String(historyFailures)
        }), { status: 'warning', sticky: true });
      } else {
        showPluginToast(tr('recentProjects_clearProject_done', {
          count: String(removed),
          project: projectName
        }), { status: 'completed' });
      }
      await renderRecentProjectsVariant();
    }

    return { clearProjectSessions };
  }

  window.CodexOverleafProjectSessionCleanup = { create };
})();
