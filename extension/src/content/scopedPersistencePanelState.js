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

  async function applyReviewTransition({ getState, runId, transition, persist }) {
    const targets = () => Array.from(new Set([
      ...(getState().runs || []),
      ...(getState().sessions || []).flatMap(session => session.runs || [])
    ])).filter(run => run.id === runId);
    const records = targets();
    const sessions = (getState().sessions || []).filter(session =>
      (session.runs || []).some(run => run.id === runId));
    if (!records.length || !sessions.length) throw reviewPersistenceError();
    const previous = cloneSnapshot(records[0]);
    for (const record of records) Object.assign(record, cloneSnapshot(transition));
    for (const session of sessions) {
      session.updatedAt = new Date(Math.max(Date.now(), (Date.parse(session.updatedAt) || 0) + 1,
        (Date.parse(session.lastActivityAt) || 0) + 1)).toISOString();
      session.lastActivityAt = session.updatedAt;
    }
    try {
      await persist({ preserveRunActionPayload: true, reviewRunIds: [runId] });
    } catch (error) {
      // The remote action may have succeeded. Keep its recovery data and expose uncertainty.
      for (const record of targets()) {
        Object.assign(record, cloneSnapshot(previous), { trackedChangeStatus: 'needs_review' });
        for (const field of ['settlement', 'settlementFacts']) {
          if (!Object.prototype.hasOwnProperty.call(previous, field)) delete record[field];
        }
      }
      throw error;
    }
  }

  function reviewPersistenceError() {
    return Object.assign(new Error('The review outcome was not durably saved. Check Overleaf before retrying.'), {
      code: 'review_state_not_persisted'
    });
  }

  function verifyRecoveredRuns(recoveredRuns, proposed, written) {
    for (var target of recoveredRuns || []) {
      var expectedSession = proposed.find(session => session.id === target.sessionId);
      var storedSession = (written || []).find(session => session.id === target.sessionId
        && session.projectId === expectedSession?.projectId
        && session.accountScopeId === expectedSession?.accountScopeId);
      var expected = expectedSession?.runs?.find(run => run.id === target.runId);
      var stored = storedSession?.runs?.find(run => run.id === target.runId);
      var retained = expected && stored
        && expected.runProjectId === target.projectId && stored.runProjectId === target.projectId
        && Number(stored.nativeEventSeq || 0) >= Number(expected.nativeEventSeq || 0)
        && stored.codexThreadId === expected.codexThreadId
        && stored.codexTurnId === expected.codexTurnId
        && JSON.stringify(stored.interruptedDraft) === JSON.stringify(expected.interruptedDraft)
        && (expected.events || []).every(event => (stored.events || [])
          .some(saved => JSON.stringify(saved) === JSON.stringify(event)));
      if (!retained) throw Object.assign(new Error('Recovered run was not durably saved; its replay journal is retained.'), {
        code: 'recovery_state_not_persisted'
      });
    }
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
    if ((input.recoveryRuns || []).some(target => target.projectId !== projectId
      || target.accountScopeId !== accountScopeId)) {
      throw Object.assign(new Error('Journal recovery scope changed before persistence.'), {
        code: 'recovery_scope_changed'
      });
    }
    var reviewRuns = (input.reviewRunIds || []).map(id =>
      (state.sessions || []).flatMap(session => session.runs || []).find(run => run.id === id));
    if (reviewRuns.some(run => !run)) throw reviewPersistenceError();
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
    var written = await input.SessionPersistence.writeSessions({
      Migration: Migration,
      StorageDb: StorageDb,
      projectId: projectId,
      accountScopeId: accountScopeId,
      deletedSessionIds: deletedSessionIds,
      sessionRecords: sessionRecords,
      reviewRunIds: input.reviewRunIds,
      queueClaims: persistenceMeta.queueClaims || {},
      queueTombstones: queueTombstones,
      writerId: input.persistenceContext?.writerId || ''
    });
    if (!reviewRuns.every(reviewRun => (written || []).some(session => (session.runs || []).some(run =>
      run.id === reviewRun.id && run.trackedChangeStatus === reviewRun.trackedChangeStatus
    )))) throw reviewPersistenceError();
    verifyRecoveredRuns(input.recoveryRuns, sessionRecords, written);
  }

  return Object.freeze({ persistPanelState: persistPanelState, applyReviewTransition: applyReviewTransition });
});
