(function initCodexOverleafProjectSessionCleanup() {
  'use strict';

  const FRESH_RUNNING_WINDOW_MS = 30 * 60 * 1000;

  function create(deps = {}) {
    const {
      tr,
      tx = en => en,
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

    async function clearProjectSessions(projectId, projectName, options = {}) {
      const StorageDb = deps.StorageDb;
      const SessionState = deps.SessionState;
      if (!StorageDb || !SessionState) {
        return;
      }
      const scope = options.accountScopeId ?? getAccountScopeId();
      const scopeChanged = error => error?.code === 'history_cleanup_scope_changed'
        || error?.code === 'account_scope_unavailable';
      const assertCurrent = () => {
        if (!scope || getAccountScopeId() !== scope || options.isCurrent?.() === false
          || options.generation !== undefined && deps.getViewGeneration?.() !== options.generation) {
          throw Object.assign(new Error('History cleanup identity changed.'), { code: 'history_cleanup_scope_changed' });
        }
      };
      const readRecords = async () => {
        assertCurrent();
        const records = await StorageDb.getAllByIndex('sessions', 'projectId', projectId);
        assertCurrent();
        return records.filter(record => record && record.accountScopeId === scope);
      };
      try {
        let records = await readRecords();
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
        // Re-read after the destructive dialog: another tab can have started a
        // run or added a conversation while the original count was displayed.
        const approvedIds = new Set(records.map(record => record.id));
        const latest = await readRecords();
        if (latest.some(record => isFreshRunningRecord(StorageDb, record))) {
          showPluginToast(tr('recentProjects_clearProject_running'), { status: 'warning', sticky: true });
          return;
        }
        records = latest.filter(record => approvedIds.has(record.id));
        if (!records.length) { await renderRecentProjectsVariant(); return; }
        const Migration = deps.StorageMigration;
        if (Migration?.addSessionTombstones) {
          assertCurrent();
          await Migration.addSessionTombstones(projectId, records.map(record => record.id));
          assertCurrent();
        }
        try {
          assertCurrent();
          await mutateProjectPanelState(projectId, state => records.reduce(
            (nextState, record) => SessionState.deleteSession(nextState, record.id),
            state
          ), { assertCurrent });
          assertCurrent();
        } catch (error) {
          if (scopeChanged(error)) throw error;
          assertCurrent(); // Other legacy-blob failures do not replace shared deletion.
        }

        let removed = 0;
        let historyFailures = 0;
        for (const record of records) {
          try {
            assertCurrent();
            await StorageDb.deleteRecord('sessions', record.id, { accountScopeId: scope, projectId });
            assertCurrent();
            removed++;
          } catch (error) {
            if (scopeChanged(error)) throw error;
            assertCurrent(); // The remaining record can be retried in the same scope.
          }
          try {
            assertCurrent();
            const response = await sendBackgroundNative({
              method: 'codex.history.clearPlugin',
              params: { sessionId: record.id, threadId: record.codexThreadId || '' }
            });
            assertCurrent();
            if (!response || !response.ok) {
              historyFailures++;
            }
          } catch (error) {
            if (scopeChanged(error)) throw error;
            assertCurrent();
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
      } catch (error) {
        if (!scopeChanged(error)) throw error;
        showPluginToast(tx('History view or account changed. Reopen the history list before deleting sessions.',
          '历史视图或账号已变化，请重新打开历史列表后再清理会话。'), { status: 'warning', sticky: true });
        return false;
      }
    }

    return { clearProjectSessions };
  }

  window.CodexOverleafProjectSessionCleanup = { create };
})();
