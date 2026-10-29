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

  // Review owns recovery progress and its settlement decision. Log events,
  // compilation/mirror evidence, and later draft/display data have other writers.
  const REVIEW_FIELDS = ['appliedOperations', 'undoOperations', 'undoBaseFiles', 'undoTrackedChanges',
    'undoExpectedFiles', 'undoStatus', 'trackedChangeStatus', 'trackedChangeCaptures', 'interruptedDraft',
    'retryWriteback', 'saveCheck'];
  const REVIEW_FACT_FIELDS = ['documentEffect', 'fileSettlements', 'failures', 'recoveryAvailability', 'recoveryDisposition'];
  const AUXILIARY_EVIDENCE = ['mirrored', 'compiled'];
  const REVIEW_SOURCE_FIELDS = ['id', 'runProjectId', 'runAccountScopeId', 'startedAt', 'nativeEventSeq',
    'codexThreadId', 'codexTurnId', 'executionSnapshot', 'forkSnapshot'];
  const factsOf = record => record?.settlement || record?.settlementFacts || {};
  function reviewSnapshot(record, SessionState) {
    const normalized = SessionState?.normalizeRuns?.([record])?.[0] || record;
    const facts = factsOf(normalized);
    return JSON.stringify([
      [...REVIEW_SOURCE_FIELDS, ...REVIEW_FIELDS].map(key => normalized[key]),
      REVIEW_FACT_FIELDS.map(key => facts[key]),
      Object.entries(facts.evidence || {}).filter(([key]) => !AUXILIARY_EVIDENCE.includes(key)).sort(([a], [b]) => a.localeCompare(b))
    ]);
  }
  function restoreReviewFields(record, previous, staged, legacyUndo) {
    for (const key of REVIEW_FIELDS) {
      if (Object.hasOwn(previous, key)) record[key] = cloneSnapshot(previous[key]);
      else delete record[key];
    }
    Object.assign(record, legacyUndo ? { undoStatus: 'partial' } : { trackedChangeStatus: 'needs_review' });
    const currentFacts = factsOf(record), stagedFacts = factsOf(staged);
    const restored = cloneSnapshot(factsOf(previous));
    const preserveLateFields = (target, current, initial, excluded) => {
      for (const key of new Set([...Object.keys(current), ...Object.keys(initial)])) {
        if (excluded.includes(key) || JSON.stringify(current[key]) === JSON.stringify(initial[key])) continue;
        if (Object.hasOwn(current, key)) target[key] = cloneSnapshot(current[key]); else delete target[key];
      }
    };
    preserveLateFields(restored, currentFacts, stagedFacts, [...REVIEW_FACT_FIELDS, 'evidence']);
    const evidence = { ...(restored.evidence || {}) };
    const currentEvidence = currentFacts.evidence || {}, stagedEvidence = stagedFacts.evidence || {};
    preserveLateFields(evidence, currentEvidence, stagedEvidence,
      [...Object.keys(currentEvidence), ...Object.keys(stagedEvidence)].filter(key => !AUXILIARY_EVIDENCE.includes(key)));
    if (Object.keys(evidence).length) restored.evidence = evidence; else delete restored.evidence;
    delete record.settlementFacts;
    if (Object.keys(restored).length) record.settlement = restored; else delete record.settlement;
  }

  async function applyReviewTransition({ getState, runId, transition, persist, legacyUndo = false, assertCurrent, SessionState }) {
    const targets = () => Array.from(new Set([
      ...(getState().runs || []),
      ...(getState().sessions || []).flatMap(session => session.runs || [])
    ])).filter(run => run.id === runId);
    assertCurrent?.();
    const capturedState = getState(), capturedSessionId = capturedState.activeSessionId;
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
    const snapshot = record => reviewSnapshot(record, SessionState);
    const stagedRecords = records.map(cloneSnapshot), staged = records.map(snapshot);
    const sameRecord = (original, record) => original === record
      || (assertCurrent && SessionState?.sameRunIdentity?.(original, record));
    const stillStaged = record => records.some((original, index) =>
      sameRecord(original, record) && snapshot(record) === staged[index]);
    const sameView = () => getState().activeSessionId === capturedSessionId
      && (getState() === capturedState || (assertCurrent && SessionState?.sameRunIdentity));
    try {
      await persist({ preserveRunActionPayload: true, reviewRunIds: [runId], requireDurable: true });
      assertCurrent?.();
      const current = targets();
      if (!sameView() || !current.length || current.some(record => !stillStaged(record))
        || records.some(original => !current.some(record => sameRecord(original, record))))
        throw reviewPersistenceError();
    } catch (error) {
      try { assertCurrent?.(); } catch (_stale) { throw error; }
      // The envelope still failed closed, but an exact run-scoped readback
      // already acknowledges this outcome. Keep the error/notice, not a false retry.
      if (error.code === 'shared_session_conflict' && error.durableReviewRunIds?.includes(runId)) throw error;
      // The remote action may have succeeded. Keep its recovery data and expose uncertainty.
      for (const record of targets()) {
        if (!sameView() || !stillStaged(record)) continue;
        const index = records.findIndex((original, index) => sameRecord(original, record) && snapshot(record) === staged[index]);
        restoreReviewFields(record, previous, stagedRecords[index], legacyUndo);
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

  function projectPreferenceValues(input, prefs, projectId) {
    return {
      experimentalOtByProject: input.normalizeExperimentalOtByProject(prefs.experimentalOtByProject)[projectId] === true,
      reviewingAvailabilityByProject: prefs.reviewingAvailabilityByProject?.[projectId],
      governanceRulesByProject: input.normalizeGovernanceRulesByProject({
        [projectId]: prefs.governanceRulesByProject?.[projectId] || {}
      })[projectId],
      customInstructionsByProject: input.normalizeCustomInstructionsByProject({
        [projectId]: prefs.customInstructionsByProject?.[projectId] || ''
      })[projectId]
    };
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
    var preferenceBaseline = input.projectPreferenceBaseline
      || Migration.getProjectPreferenceBaseline?.(accountScopeId, projectId);
    var preferenceWrite = input.projectPreferenceWrite || Migration.captureProjectPreferenceWrite?.({
      ...input, state: state, baseline: preferenceBaseline, accountScopeId: accountScopeId, projectId: projectId
    });
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
    var currentPreferences = projectPreferenceValues(input, state, projectId);
    if (preferenceWrite) {
      Object.assign(prefs, Migration.projectPreferencePatch(preferenceWrite, accountScopeId, projectId));
    } else {
      var baselinePreferences = projectPreferenceValues(input, preferenceBaseline || latestPrefs || {}, projectId);
      for (var name of Object.keys(currentPreferences)) {
        prefs[name] = JSON.stringify(currentPreferences[name]) === JSON.stringify(baselinePreferences[name])
          ? {} : { [projectId]: currentPreferences[name] };
      }
    }
    var savedPrefs = await Migration.savePrefs(prefs, accountScopeId, projectId);
    if (savedPrefs) {
      var fields = preferenceWrite ? Migration.completeProjectPreferenceWrite(preferenceWrite, savedPrefs)
        : Object.keys(currentPreferences);
      var applied = input.applyProjectPreferences?.(savedPrefs, state, fields);
      if (!preferenceWrite && applied !== false) Migration.adoptProjectPreferenceBaseline?.(savedPrefs, accountScopeId, projectId);
    }
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
    sessionRecords = StorageDb.compactSessionBatchActions?.(sessionRecords, { activeSessionId: state.activeSessionId }) || sessionRecords;
    var written;
    try {
      written = await input.SessionPersistence.writeSessions({
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
    } catch (error) {
      if (error.code === 'shared_session_conflict' && error.reviewReceipts && StorageDb.reviewStateSnapshot) {
        error.durableReviewRunIds = (input.reviewRunIds || []).filter(id => sessionRecords.some(expected => {
          const proposed = expected.runs?.find(run => run.id === id);
          const saved = error.reviewReceipts.find(record => record.id === expected.id
            && record.accountScopeId === expected.accountScopeId && record.projectId === expected.projectId)
            ?.runs?.find(run => run.id === id);
          return proposed && saved && StorageDb.reviewStateSnapshot(proposed) === StorageDb.reviewStateSnapshot(saved);
        }));
        delete error.reviewReceipts;
      }
      throw error;
    }
    if (!reviewRuns.every(reviewRun => (written || []).some(session => (session.runs || []).some(run =>
      run.id === reviewRun.id
      && (!reviewRun.trackedChangeStatus && ['applied', 'partial'].includes(reviewRun.undoStatus)
        ? run.undoStatus === reviewRun.undoStatus && (reviewRun.undoStatus === 'applied'
          || ['undoOperations', 'undoBaseFiles', 'undoExpectedFiles', 'undoTrackedChanges']
            .every(field => JSON.stringify(run[field] || []) === JSON.stringify(reviewRun[field] || [])))
        : run.trackedChangeStatus === reviewRun.trackedChangeStatus)
    )))) throw reviewPersistenceError();
    verifyRecoveredRuns(input.recoveryRuns, sessionRecords, written);
    return written;
  }

  return Object.freeze({ persistPanelState: persistPanelState, applyReviewTransition: applyReviewTransition });
});
