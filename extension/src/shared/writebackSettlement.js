(function initCodexOverleafWritebackSettlement(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./failureReasons'),
      require('./settlementFacts'),
      require('./writebackEvidenceProjection'),
      require('./writebackOperationEvidence')
    );
  } else {
    root.CodexOverleafModuleRegistry.define('WritebackSettlement', [
      'FailureReasons',
      'SettlementFacts',
      'WritebackEvidenceProjection',
      'WritebackOperationEvidence'
    ], factory);
  }
})(typeof window !== 'undefined' ? window : globalThis, function writebackSettlementFactory(
  DefaultFailureReasons,
  SettlementFacts,
  EvidenceProjection,
  OperationEvidence
) {
  'use strict';

  const SETTLEMENT_FACTS_MAX_BYTES = SettlementFacts.SETTLEMENT_FACTS_MAX_BYTES;
  const RECOVERY_FIELDS = SettlementFacts.RECOVERY_FIELDS;
  const compactSettlementFacts = SettlementFacts.compactSettlementFacts;
  const projectRunSettlement = SettlementFacts.projectRunSettlement;
  const deriveLegacyProjection = SettlementFacts.deriveLegacyProjection;
  const aggregateFileSettlements = EvidenceProjection.aggregateFileSettlements;
  const deriveAppliedEvidence = EvidenceProjection.deriveAppliedEvidence;
  const deriveApplyResultReadbacks = EvidenceProjection.deriveApplyResultReadbacks;
  const deriveDocumentEffect = EvidenceProjection.deriveDocumentEffect;
  const deriveReadbackEvidence = EvidenceProjection.deriveReadbackEvidence;
  const normalizeFileReadbackEvidence = EvidenceProjection.normalizeFileReadbackEvidence;
  const normalizeFailure = OperationEvidence.normalizeFailure;
  const normalizeOperationEvidence = OperationEvidence.normalizeOperationEvidence;
  const normalizeTrackedChanges = OperationEvidence.normalizeTrackedChanges;
  const ACCEPT_NEEDS_REVIEW_CODES = new Set([
    'tracked_changes_remain',
    'accept_not_verified',
    'tracked_changes_created_unexpectedly',
    'accept_replay_created_tracked_changes',
    'write_observed_mismatch'
  ]);
  const REJECT_NEEDS_REVIEW_CODES = new Set([
    'undo_not_verified',
    'undo_operation_failed',
    'undo_reviewing_restore_unverified',
    'tracked_change_nodes_not_identified',
    'tracked_changes_remain',
    'write_observed_mismatch'
  ]);
  const CONTENT_FAILURE_CATALOG = {
    project_snapshot_unavailable: {
      stage: 'context', severity: 'error', defaultRetryable: true,
      fallbackUserMessage: 'Codex could not read the Overleaf project snapshot.',
      fallbackNextAction: 'Refresh Overleaf, then rerun the task.'
    },
    selected_context_unresolved: {
      stage: 'context', severity: 'warning', defaultRetryable: true,
      fallbackUserMessage: 'Codex could not resolve the requested selection or context.',
      fallbackNextAction: 'Select the target again or specify the file/section explicitly.'
    },
    codex_no_usable_result: {
      stage: 'codex', severity: 'error', defaultRetryable: true,
      fallbackUserMessage: 'Local Codex returned no usable final report or operations.',
      fallbackNextAction: 'Open Technical Details and resolve the local Codex error.'
    },
    codex_project_locked: {
      stage: 'codex', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'Another Codex task is already running for this Overleaf project.',
      fallbackNextAction: 'Wait for the active task to finish, or cancel it before retrying.'
    },
    storage_quota_exceeded: {
      stage: 'storage', severity: 'warning', defaultRetryable: true,
      fallbackUserMessage: 'Browser storage quota was exceeded.',
      fallbackNextAction: 'Clear old run history or reduce attachments.'
    },
    native_bridge_unavailable: {
      stage: 'native', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'Extension cannot connect to the Codex native host.',
      fallbackNextAction: 'Run install-native or reload the extension.'
    },
    undo_not_verified: {
      stage: 'undo', severity: 'warning', defaultRetryable: true,
      fallbackUserMessage: 'Undo ran, but Codex could not prove the file returned to pre-run content.',
      fallbackNextAction: 'Inspect the file manually before continuing.'
    },
    accept_not_verified: {
      stage: 'accept', severity: 'warning', defaultRetryable: true,
      fallbackUserMessage: 'Accept appeared to run but Codex could not prove final content/state.',
      fallbackNextAction: 'Inspect Overleaf Reviewing before continuing.'
    }
  };
  const ACCEPT_DIAGNOSTIC_TITLE_KEYS = Object.freeze({
    editorUndo: 'runAcceptTrackedStepEditorUndo',
    modeBefore: 'runAcceptTrackedStepModeBefore',
    forceEditing: 'runAcceptTrackedStepForceEditing',
    replayStart: 'runAcceptTrackedStepReplayStart',
    replayDone: 'runAcceptTrackedStepReplayDone',
    restoreReviewing: 'runAcceptTrackedStepRestoreReviewing'
  });

  function settle(input = {}) {
    const operationEvidence = normalizeOperationEvidence(input.operations, input.applyResult);
    const readbacks = input.readbacks === undefined
      ? deriveApplyResultReadbacks(input.applyResult)
      : input.readbacks;
    const fileSettlements = aggregateFileSettlements(operationEvidence, readbacks);
    const failures = operationEvidence.flatMap(entry => entry.failures);
    const failureReasons = input.failureReasons || DefaultFailureReasons;
    const primaryFailure = selectPrimaryFailure(failures, failureReasons);
    const documentEffect = deriveDocumentEffect(operationEvidence);
    const recovery = preserveRecovery();
    const facts = compactSettlementFacts({
      schemaVersion: 1,
      documentEffect,
      evidence: {
        applied: deriveAppliedEvidence(input.operations, operationEvidence),
        readBack: deriveReadbackEvidence(fileSettlements, readbacks),
        saved: normalizeSaveEvidence(input.saveVerification).confidence,
        mirrored: normalizeMirrorEvidence(input.mirror),
        compiled: normalizeCompileEvidence(input.compile),
        settled: deriveSettledEvidence(primaryFailure, fileSettlements)
      },
      fileSettlements,
      failures,
      recoveryAvailability: deriveRecoveryAvailability(input.recovery, operationEvidence),
      recoveryDisposition: projectRecoveryDisposition(recovery),
      capturedAt: normalizeTimestamp(input.capturedAt)
    });
    return {
      schemaVersion: 1,
      statePatch: {},
      recovery,
      facts
    };
  }

  function normalizeSaveEvidence(value = {}) {
    if (value?.state === 'verified_saved') {
      return { state: 'verified_saved', confidence: 'verified' };
    }
    if (value?.state === 'verified_quiet' || (value?.ok === true && !value?.state)) {
      return { state: 'verified_quiet', confidence: 'quiet-observed' };
    }
    const state = normalizeText(value?.state);
    if (state === 'not_required' || state === 'not-required') {
      return { state, confidence: 'not-required' };
    }
    if (state === 'unavailable') {
      return { state, confidence: 'unavailable' };
    }
    if (value?.ok === false) {
      return { state: state || 'failed', confidence: 'failed' };
    }
    if (!state) {
      return { state: 'not_started', confidence: 'not-attempted' };
    }
    return {
      state,
      confidence: 'unavailable'
    };
  }

  function normalizeAuxiliaryEvidence(value = {}) {
    if (!value || typeof value !== 'object') {
      return { state: 'not_started' };
    }
    return {
      state: normalizeText(value.state || value.status) || 'unknown',
      reason: normalizeText(value.reason)
    };
  }

  function normalizeMirrorEvidence(value = {}) {
    const state = normalizeText(value?.state || value?.status);
    if (state === 'pending') return 'not-attempted';
    return ['not-attempted', 'complete', 'partial', 'failed', 'unknown'].includes(state)
      ? state
      : (state === 'not_started' || !state ? 'not-attempted' : 'unknown');
  }

  function normalizeCompileEvidence(value = {}) {
    const state = normalizeText(value?.state || value?.status);
    if (state === 'success' || state === 'completed') return 'succeeded';
    return ['not-attempted', 'succeeded', 'failed', 'unknown'].includes(state)
      ? state
      : (state === 'not_started' || !state ? 'not-attempted' : 'unknown');
  }

  function deriveSettledEvidence(primaryFailure, fileSettlements = []) {
    if (primaryFailure?.terminalState === 'needs_review'
      || fileSettlements.some(file => file.readBack === 'mismatch')) {
      return 'needs-review';
    }
    if (primaryFailure) return 'partial';
    return 'complete';
  }

  function deriveRecoveryAvailability(recovery = {}, operationEvidence = []) {
    const value = recovery && typeof recovery === 'object' ? recovery : {};
    return {
      trackedChanges: hasItems(value.undoTrackedChanges)
        || operationEvidence.some(entry => entry.trackedChanges.length > 0),
      editorHistory: hasItems(value.undoOperations)
        || hasItems(value.appliedOperations)
        || operationEvidence.some(entry => entry.undoIds.length > 0),
      legacyBaseline: hasItems(value.undoBaseFiles)
        || hasItems(value.undoExpectedFiles)
        || operationEvidence.some(entry => entry.baseAvailable || entry.expectedAvailable)
    };
  }

  function projectRecoveryDisposition(recovery = {}) {
    return Object.fromEntries(RECOVERY_FIELDS.map(field => [
      field,
      recovery[field]?.kind === 'clear' ? 'clear' : 'preserve'
    ]));
  }

  function hasItems(value) {
    if (Array.isArray(value)) return value.length > 0;
    return Boolean(value && typeof value === 'object' && Object.keys(value).length);
  }

  function settlePostNavigation(input = {}) {
    if (input.navigation?.occurred !== true) return null;
    if (input.navigation?.identityGuardFailed === true) {
      return 'abandoned_after_navigation';
    }
    const skipped = collectRunResultSkipped(input.runResult);
    if (skipped.some(entry => {
      const code = entry?.result?.code || entry?.result?.failure?.code || entry?.failure?.code;
      return code === 'aborted_project_changed' || code === 'editor_project_id_unavailable';
    })) {
      return 'abandoned_after_navigation';
    }
    if (input.runResult?.hasSkippedOperations === true || skipped.length > 0) {
      return 'needs_review_after_navigation';
    }
    return 'background_completed';
  }

  function collectRunResultSkipped(value = {}) {
    return [
      ...(Array.isArray(value?.applied?.skipped) ? value.applied.skipped : []),
      ...(Array.isArray(value?.skipped) ? value.skipped : [])
    ].filter(Boolean);
  }

  function settleTrackedChangeLifecycle(input = {}) {
    const kind = input.kind === 'reject' ? 'reject' : 'accept';
    const failures = collectFailuresFromResult(input.result, input.failureReasons);
    const primary = selectPrimaryFailure(failures, input.failureReasons);
    if (primary?.terminalState === 'blocked' || primary?.severity === 'blocked') {
      return {
        decision: 'blocked',
        statePatch: {},
        recovery: preserveRecovery(),
        facts: {
          documentEffect: primary?.changedDocument === true ? 'possibly-changed' : 'unknown',
          failures,
          evidence: { settled: 'needs-review' },
          recoveryAvailability: deriveRecoveryAvailability(input.run),
          recoveryDisposition: projectRecoveryDisposition(preserveRecovery())
        }
      };
    }
    const successful = isSuccessfulTrackedChangeSettlement(input.result);
    const reviewCodes = kind === 'accept' ? ACCEPT_NEEDS_REVIEW_CODES : REJECT_NEEDS_REVIEW_CODES;
    // Reject/Undo is an all-target recovery transaction. A successful entry
    // only proves that one tracked target was restored; any failed/skipped
    // sibling can still leave this run's content in another file. Keep that
    // recovery actionable instead of collapsing a partial multi-file reject
    // into the terminal `rejected` state. Accept retains its established
    // best-effort terminal policy.
    const incompleteReject = kind === 'reject'
      && collectRunResultSkipped(input.result).length > 0;
    const needsReview = incompleteReject || (!successful && failures.some(failure =>
      failure.terminalState === 'needs_review' || reviewCodes.has(failure.code)
    ));
    const status = needsReview ? 'needs_review' : kind === 'accept' ? 'accepted' : 'rejected';
    return {
      decision: status,
      statePatch: { trackedChangeStatus: status },
      recovery: status === 'accepted' || status === 'rejected'
        ? terminalTrackedChangeRecovery()
        : preserveRecovery(),
      facts: {
        documentEffect: failures.some(failure => failure?.changedDocument === true)
          ? 'possibly-changed'
          : 'unknown',
        failures,
        evidence: { settled: needsReview ? 'needs-review' : 'complete' },
        recoveryAvailability: deriveRecoveryAvailability(input.run),
        recoveryDisposition: projectRecoveryDisposition(
          status === 'accepted' || status === 'rejected'
            ? terminalTrackedChangeRecovery()
            : preserveRecovery()
        )
      }
    };
  }

  function transitionTrackedChangeStatus(status) {
    const recovery = status === 'accepted' || status === 'rejected'
      ? terminalTrackedChangeRecovery()
      : preserveRecovery();
    return {
      statePatch: { trackedChangeStatus: status },
      recovery,
      facts: {
        evidence: { settled: status === 'needs_review' ? 'needs-review' : 'complete' },
        recoveryDisposition: projectRecoveryDisposition(recovery)
      }
    };
  }

  function settleLegacyUndo(input = {}) {
    const status = input.status === 'applied' ? 'applied' : 'partial';
    const recovery = preserveRecovery();
    return {
      statePatch: { undoStatus: status },
      recovery,
      facts: {
        documentEffect: status === 'applied' ? 'changed' : 'possibly-changed',
        failures: collectFailuresFromResult(input.result, input.failureReasons),
        evidence: { settled: status === 'applied' ? 'complete' : 'needs-review' },
        recoveryAvailability: deriveRecoveryAvailability(input.run),
        recoveryDisposition: projectRecoveryDisposition(recovery)
      }
    };
  }

  function transitionPostNavigationStatus(input = {}) {
    const status = normalizeText(input.status);
    const recovery = preserveRecovery();
    return {
      statePatch: {
        status,
        statusText: normalizeText(input.statusText),
        finishedAt: normalizeText(input.finishedAt)
      },
      recovery,
      facts: {
        evidence: {
          settled: status === 'background_completed' ? 'complete' : 'needs-review'
        },
        recoveryDisposition: projectRecoveryDisposition(recovery)
      }
    };
  }

  function applySettlementTransition(currentRun = {}, settlementResult = {}) {
    const next = cloneValue(currentRun);
    const patch = settlementResult.statePatch && typeof settlementResult.statePatch === 'object'
      ? settlementResult.statePatch
      : {};
    Object.assign(next, cloneValue(patch));
    const recovery = settlementResult.recovery || {};
    for (const field of RECOVERY_FIELDS) {
      const disposition = recovery[field] || { kind: 'preserve' };
      if (disposition.kind === 'clear') {
        next[field] = Array.isArray(next[field]) ? [] : '';
      } else if (disposition.kind === 'replace') {
        next[field] = cloneValue(disposition.value);
      }
    }
    if (settlementResult.facts) {
      const existingSettlement = next.settlement && typeof next.settlement === 'object'
        ? next.settlement
        : next.settlementFacts;
      next.settlement = compactSettlementFacts({
        ...(existingSettlement && typeof existingSettlement === 'object' ? existingSettlement : {}),
        ...settlementResult.facts,
        evidence: {
          ...(existingSettlement?.evidence || {}),
          ...(settlementResult.facts.evidence || {})
        },
        recoveryAvailability: {
          ...(existingSettlement?.recoveryAvailability || {}),
          ...(settlementResult.facts.recoveryAvailability || {})
        },
        recoveryDisposition: {
          ...(existingSettlement?.recoveryDisposition || {}),
          ...(settlementResult.facts.recoveryDisposition || {})
        }
      });
      delete next.settlementFacts;
    }
    return next;
  }

  function attachUndoNotVerifiedFailure(run, result, options = {}) {
    if (!result || typeof result !== 'object' || result.ok === false) return result;
    if (Array.isArray(result.skipped) && result.skipped.length > 0) return result;
    const expectedFiles = Array.isArray(run?.undoExpectedFiles) ? run.undoExpectedFiles : [];
    if (!expectedFiles.length || isUndoVerifiedContentMatching(run, result)) return result;
    const path = expectedFiles.find(entry => typeof entry?.path === 'string')?.path || '';
    appendSyntheticFailure(result, options.buildFailure?.('undo_not_verified', { path, type: 'undo' }, {
      changedDocument: true,
      terminalState: 'needs_review',
      evidence: { undoApplied: true, verified: false, expectedFileCount: expectedFiles.length }
    }), path, 'undo_not_verified', 'undo');
    return result;
  }

  function isUndoVerifiedContentMatching(run, result) {
    const expectedByPath = new Map((run?.undoExpectedFiles || [])
      .filter(file => typeof file?.path === 'string' && typeof file?.content === 'string')
      .map(file => [normalizeSettlementPath(file.path), file.content])
      .filter(([path]) => path));
    if (!expectedByPath.size) return true;
    const applied = Array.isArray(result?.applied) ? result.applied : [];
    return Array.from(expectedByPath).every(([path, expected]) =>
      applied.some(entry => isVerifiedUndoEntryForPath(entry, path, expected))
    );
  }

  function isUndoResultEffectivelyApplied(run, result, undoOperations = []) {
    if (!result?.skipped?.length) return true;
    const expectedByPath = new Map((run?.undoExpectedFiles || [])
      .filter(file => file?.path && typeof file.content === 'string')
      .map(file => [normalizeSettlementPath(file.path), file.content])
      .filter(([path]) => path));
    if (!expectedByPath.size) return false;
    const editPaths = Array.from(new Set((Array.isArray(undoOperations) ? undoOperations : [])
      .filter(operation =>
        operation?.type === 'edit'
        && operation.path
        && expectedByPath.has(normalizeSettlementPath(operation.path))
      )
      .map(operation => normalizeSettlementPath(operation.path))));
    return editPaths.length > 0 && editPaths.every(path => (result.applied || []).some(item =>
      isVerifiedUndoEntryForPath(item, path, expectedByPath.get(path))
    ));
  }

  function isVerifiedUndoEntryForPath(entry, path, expectedContent) {
    const inner = entry?.result || {};
    if (inner.ok === false) return false;
    const normalizedPath = normalizeSettlementPath(path);
    const operationPath = normalizeSettlementPath(entry?.operation?.path);
    if (entry?.operation?.type === 'edit' && operationPath === normalizedPath) {
      return inner.verifiedContent === expectedContent;
    }

    const trackedPath = normalizeSettlementPath(entry?.trackedChange?.path);
    if (trackedPath !== normalizedPath) return false;
    const key = String(entry?.trackedChange?.key || '');
    if (key === `editor-undo:${normalizedPath}`) {
      return inner.method === 'overleaf-editor-undo'
        && inner.verified === true
        && inner.verifiedContent === expectedContent;
    }
    if (key === `snapshot-undo:${normalizedPath}`) {
      return inner.verifiedContent === expectedContent;
    }
    return false;
  }

  function normalizeSettlementPath(value) {
    return String(value || '')
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^\/+|\/+$/g, '');
  }

  function attachAcceptNotVerifiedFailure(run, result, options = {}) {
    if (!result || typeof result !== 'object' || result.ok === false) return result;
    if (Array.isArray(result.skipped) && result.skipped.length > 0) return result;
    if (isAcceptResultEffectivelyVerified(run, result)) return result;
    const expectedFiles = Array.isArray(run?.undoExpectedFiles) ? run.undoExpectedFiles : [];
    const path = expectedFiles.find(entry => typeof entry?.path === 'string')?.path
      || (run?.undoTrackedChanges || []).find(change => typeof change?.path === 'string')?.path
      || '';
    appendSyntheticFailure(result, options.buildFailure?.('accept_not_verified', { path, type: 'accept' }, {
      changedDocument: true,
      terminalState: 'needs_review',
      evidence: {
        acceptApplied: true,
        verified: false,
        expectedFileCount: expectedFiles.length,
        trackedChangeCount: Array.isArray(run?.undoTrackedChanges) ? run.undoTrackedChanges.length : 0
      }
    }), path, 'accept_not_verified', 'accept');
    return result;
  }

  function isAcceptResultEffectivelyVerified(run, result) {
    if (!result || typeof result !== 'object') return true;
    const expectedFiles = Array.isArray(run?.undoExpectedFiles) ? run.undoExpectedFiles : [];
    if (!expectedFiles.length || result.verified === true) return true;
    const trackedChanges = Array.isArray(run?.undoTrackedChanges) ? run.undoTrackedChanges : [];
    if (!trackedChanges.length) return true;
    const applied = Array.isArray(result.applied) ? result.applied : [];

    // The current Accept lifecycle first removes this run's tracked writeback,
    // then replays each changed file in Editing mode. Its successful evidence
    // is therefore file-scoped (`accept-replay:<path>`), while
    // `undoTrackedChanges` contains the many node-scoped refs captured before
    // the replay. Requiring every original node key to reappear in `applied`
    // produces a false accept_not_verified result even when the page verified
    // the final replayed content.
    const normalizePath = value => String(value || '')
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^\/+|\/+$/g, '');
    const replayEntries = applied.filter(entry =>
      String(entry?.trackedChange?.key || '').startsWith('accept-replay:')
    );
    if (replayEntries.length > 0) {
      const expectedPaths = Array.from(new Set(expectedFiles
        .map(file => normalizePath(file?.path))
        .filter(Boolean)));
      return expectedPaths.length > 0 && expectedPaths.every(path =>
        replayEntries.some(entry => {
          const inner = entry?.result || {};
          return normalizePath(entry?.trackedChange?.path) === path
            && inner.ok !== false
            && (inner.verified === true || typeof inner.verifiedContent === 'string');
        })
      );
    }

    // Compatibility path for the earlier direct-node Accept implementation.
    return trackedChanges.every(change => {
      const key = change?.key || change?.id || change?.label;
      return Boolean(key) && applied.some(entry => {
        const ref = entry?.trackedChange;
        return (ref?.key || ref?.id || ref?.label) === key && entry?.result?.ok !== false;
      });
    });
  }

  function collectFailuresFromResult(result, failureReasons = DefaultFailureReasons) {
    const failures = [];
    const applied = collectTrackedChangeAppliedEntries(result);
    const skipped = collectRunResultSkipped(result);
    const failedEntries = [
      ...skipped,
      ...applied.filter(item => (item?.result || item)?.ok === false)
    ];
    if (result?.ok === false && failedEntries.length === 0) failedEntries.push(result);
    for (const entry of failedEntries) {
      const inner = entry?.result || entry;
      if (!inner || inner.ok === true) continue;
      const operation = entry?.operation || (entry?.trackedChange ? { path: entry.trackedChange.path } : undefined);
      failures.push(failureReasons?.normalizeFailureReason instanceof Function
        ? failureReasons.normalizeFailureReason(inner, operation)
        : normalizeFailure(inner, operation));
    }
    return failures.filter(Boolean);
  }

  function collectTrackedChangeAppliedEntries(result) { return Array.isArray(result?.applied) ? result.applied : (Array.isArray(result?.applied?.applied) ? result.applied.applied : []); }

  function isSuccessfulTrackedChangeSettlement(result) {
    if (!result || typeof result !== 'object') return false;
    const hasSuccessfulAppliedEntry = collectTrackedChangeAppliedEntries(result).some(entry => {
      const inner = entry?.result || entry;
      return !inner || inner.ok !== false;
    });
    if (hasSuccessfulAppliedEntry) return true;
    return result.ok === true;
  }

  function buildContentFailure(code, operation = {}, overrides = {}, failureReasons = DefaultFailureReasons) {
    const entry = CONTENT_FAILURE_CATALOG[code] || failureReasons?.FAILURE_CODE_CATALOG?.[code];
    if (!entry) return null;
    const failure = {
      code,
      stage: entry.stage,
      severity: entry.severity,
      userMessage: overrides.userMessage || entry.fallbackUserMessage,
      retryable: overrides.retryable === undefined ? entry.defaultRetryable : overrides.retryable === true,
      nextAction: overrides.nextAction || entry.fallbackNextAction
    };
    const file = overrides.file !== undefined ? overrides.file : operation?.path;
    const operationType = overrides.operationType !== undefined ? overrides.operationType : operation?.type;
    if (file) failure.file = file;
    if (operationType) failure.operationType = operationType;
    for (const field of [
      'activeFile',
      'terminalState',
      'technicalMessage',
      'evidence'
    ]) {
      if (overrides[field] !== undefined) failure[field] = overrides[field];
    }
    if (overrides.changedDocument !== undefined) {
      failure.changedDocument = overrides.changedDocument === true;
    }
    return failure;
  }

  function attachVerifiedContentToOperation(operation, result) {
    if (!operation || typeof operation !== 'object') return operation;
    return operation.type === 'edit' && typeof result?.verifiedContent === 'string'
      ? { ...operation, verifiedContent: result.verifiedContent }
      : operation;
  }

  function selectExpectedFilesForTrackedUndo(
    project,
    operations = [],
    trackedChanges = [],
    previousExpectedFiles = []
  ) {
    const paths = new Set();
    for (const change of trackedChanges || []) {
      if (change?.path) paths.add(change.path);
    }
    for (const operation of operations || []) {
      if (operation?.path) paths.add(operation.path);
      if (operation?.to) paths.add(operation.to);
    }
    const expectedByPath = new Map();
    for (const file of previousExpectedFiles || []) {
      if (paths.has(file?.path) && typeof file?.content === 'string' && !expectedByPath.has(file.path)) {
        expectedByPath.set(file.path, { path: file.path, content: file.content });
      }
    }
    for (const file of project?.files || []) {
      if (paths.has(file?.path) && typeof file?.content === 'string' && !expectedByPath.has(file.path)) {
        expectedByPath.set(file.path, { path: file.path, content: file.content });
      }
    }
    return Array.from(expectedByPath.values());
  }

  function acceptDiagnosticStatus(step, info) {
    if (step === 'modeBefore' || step === 'replayStart') return 'info';
    if (step === 'editorUndo'
      || step === 'forceEditing'
      || step === 'restoreReviewing'
      || step === 'replayDone') {
      return info?.ok === true ? 'info' : 'failed';
    }
    return 'info';
  }

  function selectPrimaryFailure(failures, failureReasons) {
    return failureReasons?.selectPrimaryFailure instanceof Function
      ? failureReasons.selectPrimaryFailure(failures)
      : failures[0] || null;
  }

  function appendSyntheticFailure(result, failure, path, code, type) {
    const normalized = failure || {
      code,
      stage: type,
      severity: 'warning',
      userMessage: code,
      retryable: true,
      file: path,
      changedDocument: true,
      terminalState: 'needs_review'
    };
    if (!Array.isArray(result.skipped)) result.skipped = [];
    result.skipped.push({
      operation: { path, type },
      result: { ok: false, code, reason: normalized.userMessage, failure: normalized }
    });
    result.ok = false;
  }

  function preserveRecovery() {
    return Object.fromEntries(RECOVERY_FIELDS.map(field => [field, { kind: 'preserve' }]));
  }

  function terminalTrackedChangeRecovery() {
    const recovery = preserveRecovery();
    recovery.undoTrackedChanges = { kind: 'clear' };
    recovery.undoExpectedFiles = { kind: 'clear' };
    return recovery;
  }

  function cloneValue(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function normalizeTimestamp(value) {
    return typeof value === 'string' && value ? value : new Date().toISOString();
  }

  return {
    ACCEPT_DIAGNOSTIC_TITLE_KEYS,
    RECOVERY_FIELDS,
    SETTLEMENT_FACTS_MAX_BYTES,
    aggregateFileSettlements,
    applySettlementTransition,
    acceptDiagnosticStatus,
    attachVerifiedContentToOperation,
    attachAcceptNotVerifiedFailure,
    attachUndoNotVerifiedFailure,
    collectFailuresFromResult,
    collectRunResultSkipped,
    compactSettlementFacts,
    deriveApplyResultReadbacks,
    deriveLegacyProjection,
    buildContentFailure,
    isAcceptResultEffectivelyVerified,
    isSuccessfulTrackedChangeSettlement,
    isUndoResultEffectivelyApplied,
    isUndoVerifiedContentMatching,
    normalizeApplyTrackedChanges: normalizeTrackedChanges,
    normalizeFileReadbackEvidence,
    normalizeOperationEvidence,
    normalizeSaveEvidence,
    projectRunSettlement,
    selectExpectedFilesForTrackedUndo,
    settle,
    settleLegacyUndo,
    settlePostNavigation,
    settleTrackedChangeLifecycle,
    transitionPostNavigationStatus,
    transitionTrackedChangeStatus
  };
});
