(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafScopedPersistencePanelState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function cloneSnapshot(value) {
    if (!value || typeof value !== 'object') {
      return value;
    }
    if (typeof structuredClone === 'function') {
      return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
  }

  async function persistPanelState(input) {
    var state = cloneSnapshot(input.state || {});
    var compactState = cloneSnapshot(input.compactState || {});
    var projectId = input.projectId;
    var Migration = input.Migration;
    var StorageDb = input.StorageDb;
    var scope = input.persistenceContext?.scope || {};
    var accountScopeId = typeof scope.accountScopeId === 'string'
      ? scope.accountScopeId.trim()
      : '';
    if (!accountScopeId) {
      throw Object.assign(new Error('Scoped persistence requires an account identity.'), {
        code: 'account_scope_unavailable'
      });
    }
    if (scope.projectId !== projectId) {
      throw Object.assign(new Error('Scoped persistence project changed before commit.'), {
        code: 'stale_view'
      });
    }
    var latestPrefs = typeof Migration.loadPrefs === 'function'
      ? await Migration.loadPrefs(accountScopeId, projectId)
      : {};
    var prefs = Object.assign(
      {},
      latestPrefs && typeof latestPrefs === 'object' ? latestPrefs : {},
      StorageDb.extractLightweightPrefs(compactState, projectId)
    );
    prefs.activeSessionByProject = StorageDb.buildActiveSessionByProject(
      latestPrefs && latestPrefs.activeSessionByProject || {},
      projectId,
      compactState.activeSessionId || state.activeSessionId || ''
    );
    prefs.experimentalOtByProject = Object.assign(
      {},
      latestPrefs && latestPrefs.experimentalOtByProject || {},
      { [projectId]: input.normalizeExperimentalOtByProject(state.experimentalOtByProject)[projectId] === true }
    );
    prefs.governanceRulesByProject = Object.assign(
      {},
      latestPrefs && latestPrefs.governanceRulesByProject || {},
      input.normalizeGovernanceRulesByProject(state.governanceRulesByProject)
    );
    var normalizedCustomProject = input.normalizeCustomInstructionsByProject({ [projectId]: '' });
    var customProjectId = Object.keys(normalizedCustomProject)[0] || '';
    var currentCustom = input.normalizeCustomInstructionsByProject(state.customInstructionsByProject);
    prefs.customInstructionsByProject = Object.assign(
      {},
      latestPrefs && latestPrefs.customInstructionsByProject || {}
    );
    if (customProjectId) {
      prefs.customInstructionsByProject[customProjectId] =
        Object.prototype.hasOwnProperty.call(currentCustom, customProjectId)
          ? currentCustom[customProjectId]
          : '';
    }
    await Migration.savePrefs(prefs, accountScopeId, projectId);
    var persistenceMeta = input.persistenceContext?.nextMeta || {};
    var queueTombstones = persistenceMeta.queueTombstones || {};
    var sessionTombstones = persistenceMeta.sessionTombstones || {};
    var deletedSessionIds = Array.from(new Set([
      ...(Array.isArray(input.deletedSessionIds) ? input.deletedSessionIds : []),
      ...Object.keys(sessionTombstones)
    ]));
    var sessionRecords = (state.sessions || []).map(function (session) {
      return StorageDb.buildSessionRecord(Object.assign({}, session, {
        projectId: projectId,
        accountScopeId: accountScopeId,
        title: session.title || '',
        titleSource: session.titleSource || 'auto',
        codexThreadId: session.codexThreadId || '',
        status: 'active',
        focusFiles: Array.isArray(session.focusFiles) ? session.focusFiles : [],
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        pendingInputs: (Array.isArray(session.pendingInputs) ? session.pendingInputs : [])
          .filter(function (item) { return !queueTombstones[item?.id]; })
      }), { preserveRunActionPayload: true });
    });
    await input.SessionPersistence.writeSessions({
      Migration: Migration,
      StorageDb: StorageDb,
      projectId: projectId,
      accountScopeId: accountScopeId,
      deletedSessionIds: deletedSessionIds,
      sessionRecords: sessionRecords,
      queueClaims: persistenceMeta.queueClaims || {},
      queueTombstones: queueTombstones,
      writerId: input.persistenceContext?.writerId || ''
    });
  }

  return Object.freeze({ persistPanelState: persistPanelState });
});
