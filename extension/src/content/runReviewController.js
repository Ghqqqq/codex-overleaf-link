(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafRunReviewController = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  function create(deps = {}) {
    const {
      Modules, WritebackSettlement, trackedChangeInFlight, findRunRecord,
      getRunUndoCount, isTrackedChangeLifecycleRun, getPendingMirrorRefresh, hasTrackedEditorUndo,
      buildNoTraceUndoRestore, findUnsafeFullFileUndoOperation, showUndoFileSelection, showPluginConfirm,
      tr, truncateRunTitle, formatOperationFiles, formatTrackedChangeFiles,
      formatTrackedUndoFiles, getPageBridgeTimeoutMs, callPageBridge, setRunUndoStatus,
      appendRunRecordEvent, getRunProjectIdForWriteback, isUndoResultEffectivelyApplied, writebackOrchestrator,
      appendUndoReviewingPolicyEvent, formatOperationType, formatApplyResultReason, buildTrackedUndoPostFiles,
      getTrackedChangeCaptureController, buildContentFailure, applyTrackedChangeSettlement, refreshRunCardControls,
      formatBridgeResultReason, advanceRunUndoProgress, saveStateSoon, flushQueuedSaveState,
      getState, getCurrentProjectId, getAccountScopeId, getRouteGeneration, notify, tx,
    } = deps;
    async function withUndoLock(runId, work) {
      const run = findRunRecord(runId);
      if (!run || run.forkSnapshot || run.undoStatus === 'applied' || !getRunUndoCount(run) || trackedChangeInFlight.has(runId)) return;
      const assertOwner = undoOwner(run);
      trackedChangeInFlight.set(runId, 'reject'); refreshRunCardControls(runId);
      try { return await work(); }
      catch (error) {
        let current = true; try { assertOwner(); } catch (_stale) { current = false; }
        if (current && findRunRecord(runId) === run) {
          if (run.undoStatus === 'running') setRunUndoStatus(runId, 'partial');
          appendRunRecordEvent(runId, { title: tr('undoNoTraceTitle'), status: 'failed',
            detail: { [tr('detailReason')]: error.message } });
        }
        notify?.(error.message);
        throw error;
      } finally { trackedChangeInFlight.delete(runId); refreshRunCardControls(runId); }
    }
    const undoRun = runId => withUndoLock(runId, () => executeUndo(runId));
    const undoRunTrackedChanges = (runId, run) => withUndoLock(runId, () => executeTrackedUndo(runId, run));

function undoOwner(run) {
    const captured = getState(), sessionId = captured.activeSessionId;
    const scope = [getCurrentProjectId?.(), getAccountScopeId?.(), getRouteGeneration?.()];
    return () => {
      if (getState() !== captured || captured.activeSessionId !== sessionId || findRunRecord(run.id) !== run
        || JSON.stringify(scope) !== JSON.stringify([getCurrentProjectId?.(), getAccountScopeId?.(), getRouteGeneration?.()]))
        throw Object.assign(new Error('The Undo project, account or session changed.'), { code: 'review_context_changed' });
    };
  }

async function executeUndo(runId) {
    const run = findRunRecord(runId);
    if (run) Object.assign(run, Modules.UndoOperations.prepareRunUndo(run));
    const assertCurrent = undoOwner(run);
    if (!getRunUndoCount(run) || run.undoStatus === 'applied') {
      return;
    }
    // Wait out any background mirror refresh before undoing (v1.7.5): a
    // mirror.sync finishing after the undo would push the pre-undo snapshot
    // as the local baseline and resurrect the undone content next run.
    const pendingMirror = getPendingMirrorRefresh?.();
    if (pendingMirror) {
      await pendingMirror.catch(() => {});
      assertCurrent();
    }

    if ((Array.isArray(run.undoTrackedChanges) && run.undoTrackedChanges.length) || hasTrackedEditorUndo(run)
      || (run.trackedChangeStatus === 'needs_review' && run.undoOperations?.some(Modules.UndoOperations.isFileUndoOperation))) {
      await executeTrackedUndo(runId, run);
      return;
    }

    const undoRestore = buildNoTraceUndoRestore(run);
    const undoOperations = undoRestore.operations;
    const unsafeFullFileUndo = findUnsafeFullFileUndoOperation(undoOperations, {
      allowSnapshotRestore: undoRestore.snapshotRestore
    });
    if (unsafeFullFileUndo) {
      appendRunRecordEvent(runId, {
        title: tr('undoUnsafeFullFileTitle'),
        status: 'failed',
        detail: {
          [tr('detailFile')]: unsafeFullFileUndo.path,
          [tr('detailReason')]: tr('undoUnsafeFullFileReason')
        }
      });
      return;
    }

    // v1.8.0 C3: multi-file undos confirm through a per-file selection —
    // undoing a subset leaves undoStatus 'partial' and the button usable;
    // re-undoing an already-restored file is skipped by the base check.
    const undoPaths = Array.from(new Set(undoOperations.map(operation => operation?.path).filter(Boolean)));
    let selectedOperations = undoOperations;
    if (undoPaths.length > 1 && typeof showUndoFileSelection === 'function') {
      const selectedPaths = await showUndoFileSelection({
        title: tr('undoFileSelectTitle'),
        task: truncateRunTitle(run.task),
        confirmLabel: tr('undoFileSelectConfirm'),
        cancelLabel: tr('confirmDefaultCancel'),
        selectAllLabel: tr('undoFileSelectAll'),
        paths: undoPaths
      });
      if (!selectedPaths) {
        return;
      }
      const selectedSet = new Set(selectedPaths);
      selectedOperations = undoOperations.filter(operation => selectedSet.has(operation?.path));
    } else {
      const approved = await showPluginConfirm({
        title: tr('undoNoTraceTitle'),
        message: [
          truncateRunTitle(run.task),
          '',
          tr('undoNoTraceMessage', { files: formatOperationFiles(undoOperations) })
        ].join('\n'),
        confirmLabel: tr('undoConfirm'),
        cancelLabel: tr('confirmDefaultCancel'),
        destructive: true
      });
      if (!approved) {
        return;
      }
    }

    assertCurrent();
    const deadlineAt = Date.now() + getPageBridgeTimeoutMs('rejectTrackedChanges');
    setRunUndoStatus(runId, 'running');
    appendRunRecordEvent(runId, {
      title: tr('undoNoTraceStarted'),
      status: 'running',
      detail: { [tr('detailWillUndo')]: formatOperationFiles(selectedOperations) }
    });

      const result = await callPageBridge('applyOperations', {
        operations: selectedOperations, deadlineAt,
        baseFiles: run.undoBaseFiles || [],
        reviewingPolicy: 'no-trace-undo',
        // Undo remains bound to its original project, including after navigation.
        runProjectId: getRunProjectIdForWriteback(run)
      });
      assertCurrent();
      const undoApplied = isUndoResultEffectivelyApplied(run, result);
      writebackOrchestrator.invalidateMirrorAfterUndo(runId, getRunProjectIdForWriteback(run), result);
      appendUndoReviewingPolicyEvent(runId, result.reviewingPolicy);
      appendRunRecordEvent(runId, {
        title: tr('undoResult', { applied: result.applied?.length || 0, skipped: result.skipped?.length || 0 }),
        status: undoApplied ? 'completed' : 'failed',
        detail: {
          [tr('detailUndone')]: (result.applied || []).map(item => ({
            [tr('detailAction')]: formatOperationType(item.operation?.type),
            [tr('detailFile')]: item.operation?.path
        })),
        [tr('detailSkipped')]: (result.skipped || []).map(item => ({
          [tr('detailAction')]: formatOperationType(item.operation?.type),
          [tr('detailFile')]: item.operation?.path,
            [tr('detailReason')]: formatApplyResultReason(item)
          }))
        }
      });
      // A subset undo never closes the ledger: unselected files can still
      // be undone later, so the run stays 'partial' and the button usable.
      const fullSelection = selectedOperations.length === undoOperations.length;
      await applyLegacyUndoSettlement(
        runId,
        undoApplied && fullSelection ? 'applied' : 'partial',
        result
      );
  }

async function executeTrackedUndo(runId, run) {
    const assertCurrent = undoOwner(run);
    const fileUndoOperations = Modules.UndoOperations.getFileUndoOperations(run);
    const textRun = Modules.UndoOperations.textUndoRun(run);
    const trackedUndo = textRun.undoTrackedChanges.length > 0;
    const hasTextUndo = trackedUndo || buildTrackedUndoPostFiles(textRun).length > 0;
    const approved = await showPluginConfirm({
      title: !hasTextUndo ? tr('undoNoTraceTitle') : trackedUndo ? tr('undoTrackedTitle') : tr('undoNativeTitle'),
      message: [
        truncateRunTitle(run.task),
        '',
        ...(hasTextUndo ? [trackedUndo
          ? tr('undoTrackedMessage', { files: formatTrackedChangeFiles(run.undoTrackedChanges) })
          : tr('undoNativeMessage', { files: formatTrackedUndoFiles(run) })] : []),
        ...(fileUndoOperations.length ? [tr('undoNoTraceMessage', { files: formatOperationFiles(fileUndoOperations) })] : [])
      ].join('\n'),
      confirmLabel: trackedUndo ? tr('undoTrackedConfirm') : tr('undoConfirm'),
      cancelLabel: tr('confirmDefaultCancel'),
      destructive: true
    });
    if (!approved) {
      return;
    }

    assertCurrent();
    const deadlineAt = Date.now() + getPageBridgeTimeoutMs('rejectTrackedChanges');
    // Keep the review lifecycle until every pending part has settled.
    // Its local lock stays active while verified recovery progress is persisted.
    const lifecycleReject = (trackedUndo || fileUndoOperations.length > 0) && isTrackedChangeLifecycleRun(run);
    if (lifecycleReject) {
      trackedChangeInFlight.set(runId, 'reject');
      refreshRunCardControls(runId);
    } else {
      setRunUndoStatus(runId, 'running');
    }
    appendRunRecordEvent(runId, {
      title: !hasTextUndo ? tr('undoNoTraceStarted') : trackedUndo ? tr('undoTrackedStarted') : tr('undoNativeStarted'),
      status: 'running',
      detail: { [tr('detailWillUndo')]: !hasTextUndo ? formatOperationFiles(fileUndoOperations)
        : trackedUndo ? formatTrackedChangeFiles(run.undoTrackedChanges) : formatTrackedUndoFiles(run) }
    });

    let result;
    try {
      const trackedUndoPostFilesAtDispatch = buildTrackedUndoPostFiles(textRun);
      result = hasTextUndo ? await callPageBridge('rejectTrackedChanges', {
        trackedChanges: textRun.undoTrackedChanges || [], deadlineAt,
        expectedFiles: textRun.undoExpectedFiles || [],
        postFiles: trackedUndoPostFilesAtDispatch,
        untrackedUndo: run.executionSnapshot
          ? run.executionSnapshot.requireReviewing === false && ['submitted', 'legacy-captured'].includes(run.executionSnapshot.source)
          : getTrackedChangeCaptureController().hasLegacyUntrackedCheckpoint(run),
        // The page-side project guard still refuses writes after navigation.
        runProjectId: getRunProjectIdForWriteback(run)
      }) : { ok: true, applied: [], skipped: [] };
      assertCurrent();
      if (hasTextUndo) WritebackSettlement.attachUndoNotVerifiedFailure(textRun, result, {
        buildFailure: buildContentFailure, postFiles: trackedUndoPostFilesAtDispatch });
      if (fileUndoOperations.length && lifecycleReject && hasTextUndo) {
        WritebackSettlement.attachUndoNotVerifiedFailure(textRun, result, { buildFailure: buildContentFailure, postFiles: trackedUndoPostFilesAtDispatch });
        await applyTrackedChangeSettlement(runId, 'reject', { ...result, ok: false }, { assertCurrent });
      }
      if (fileUndoOperations.length) {
        let createdResult;
        try {
          if (result.ok === false || result.skipped?.length) {
            throw new Error('Text changes remain unresolved; file restoration was kept for the next undo attempt.');
          }
          createdResult = await callPageBridge('applyOperations', {
            operations: fileUndoOperations, deadlineAt,
            baseFiles: run.undoBaseFiles || [],
            reviewingPolicy: 'no-trace-undo',
            runProjectId: getRunProjectIdForWriteback(run)
          });
        } catch (error) {
          createdResult = { ok: false, applied: [], skipped: fileUndoOperations.map(operation => ({
            operation, result: { ok: false, code: 'undo_operation_failed', reason: error.message }
          })) };
        }
        assertCurrent();
        result = Modules.UndoOperations.mergeFileUndoResult(result, createdResult, fileUndoOperations);
      }
      appendRunRecordEvent(runId, {
        title: fileUndoOperations.length ? tr('undoResult', { applied: result.applied?.length || 0, skipped: result.skipped?.length || 0 }) : trackedUndo
          ? tr('undoTrackedResult', { applied: result.applied?.length || 0, skipped: result.skipped?.length || 0 })
          : tr('undoNativeResult', { applied: result.applied?.length || 0, skipped: result.skipped?.length || 0 }),
        status: result.ok === true && !result.skipped?.length ? 'completed' : 'failed',
        detail: {
          [trackedUndo && !fileUndoOperations.length ? tr('detailRejected') : tr('detailUndone')]: (result.applied || []).map(item => ({
            [tr('detailFile')]: item.trackedChange?.path || item.operation?.path || tr('unknownFile'),
            [tr('detailRecord')]: item.trackedChange?.label || item.trackedChange?.id || item.trackedChange?.key || item.operation?.type
          })),
          [tr('detailSkipped')]: (result.skipped || []).map(item => ({
            [tr('detailFile')]: item.trackedChange?.path || item.operation?.path || tr('unknownFile'),
            [tr('detailRecord')]: item.trackedChange?.label || item.trackedChange?.id || item.trackedChange?.key || item.operation?.type || '',
            [tr('detailReason')]: formatBridgeResultReason(item.result, item.trackedChange?.path || item.operation?.path)
          }))
        }
      });
      if (lifecycleReject) {
        WritebackSettlement.attachUndoNotVerifiedFailure(textRun, result, {
          buildFailure: buildContentFailure,
          postFiles: trackedUndoPostFilesAtDispatch
        });
        await applyTrackedChangeSettlement(runId, 'reject', result, { assertCurrent });
        return;
      }
      await applyLegacyUndoSettlement(runId, result.ok === true && !result.skipped?.length ? 'applied' : 'partial', result);
    } finally {
      // Known Page changes require invalidation even when a durable checkpoint fails.
      if (result) writebackOrchestrator.invalidateMirrorAfterUndo(runId, getRunProjectIdForWriteback(run), result);
    }
  }

function reviewOwner(run) {
    const owner = { run, state: getState(), sessionId: getState().activeSessionId,
      projectId: getCurrentProjectId(), accountScopeId: getAccountScopeId(), generation: getRouteGeneration() };
    const assert = () => {
      if (!owner.projectId || !owner.accountScopeId || run.runProjectId !== owner.projectId
        || getCurrentProjectId() !== owner.projectId || getAccountScopeId() !== owner.accountScopeId
        || getRouteGeneration() !== owner.generation || getState() !== owner.state
        || getState().activeSessionId !== owner.sessionId || findRunRecord(run.id) !== run
        || (run.runAccountScopeId && run.runAccountScopeId !== owner.accountScopeId))
        throw Object.assign(new Error('The original review project, account or session changed.'), { code: 'review_context_changed' });
      return run;
    };
    assert(); return { ...owner, assert };
  }

  async function openManualReviewFile(runId, path) {
    const run = findRunRecord(runId);
    if (!run || run.forkSnapshot || !['pending', 'needs_review'].includes(run.trackedChangeStatus)) return;
    const owner = reviewOwner(run), proof = Modules.ManualReviewProof.normalize(run.manualReviewProof);
    const allowed = proof ? proof.accountScopeId === owner.accountScopeId && proof.runProjectId === owner.projectId
      && proof.files.some(file => file.path === path) : (run.undoTrackedChanges || []).some(ref => ref.path === path);
    if (!allowed || !Modules.ManualReviewProof.safePath(path)) return;
    const result = await callPageBridge('jumpToPosition', { path, line: 1, runProjectId: owner.projectId });
    owner.assert();
    if (result?.ok !== true) { notify?.(result?.reason || tx('The original review file could not be opened.', '无法打开原始审阅文件。')); return result; }
    notify?.(tx('Review only this run’s entries in Overleaf, then use “Verify manual review”.',
      '请在 Overleaf Review 中仅接受本轮记录，再点击“核验手动 Review”。'));
  }

  async function verifyManualReview(runId) {
    const run = findRunRecord(runId), proof = Modules.ManualReviewProof.normalize(run?.manualReviewProof);
    if (!proof || run.forkSnapshot || !['pending', 'needs_review'].includes(run.trackedChangeStatus)
      || trackedChangeInFlight.has(runId)) return;
    const owner = reviewOwner(run), signature = JSON.stringify(proof);
    if (proof.runProjectId !== owner.projectId || proof.accountScopeId !== owner.accountScopeId) return;
    trackedChangeInFlight.set(runId, 'accept'); refreshRunCardControls(runId);
    try {
      const result = await callPageBridge('acceptTrackedChanges', { verifyManualReview: true,
        manualReviewProof: proof, postFiles: buildTrackedUndoPostFiles(run),
        trackedChanges: run.undoTrackedChanges || [], expectedFiles: run.undoExpectedFiles || [],
        accountScopeId: owner.accountScopeId, runProjectId: owner.projectId });
      owner.assert();
      if (JSON.stringify(Modules.ManualReviewProof.normalize(run.manualReviewProof)) !== signature)
        throw new Error('The manual review proof changed during verification.');
      const verified = result?.ok === true && result.verified === true && result.proofId === proof.id;
      if (!verified) {
        notify?.(result?.skipped?.[0]?.result?.reason || tx('Manual review could not be verified. Recovery evidence is retained.',
          '尚未核验手动 Review，恢复记录已保留。'));
        return result;
      }
      await applyTrackedChangeSettlement(runId, 'accept', result, { assertCurrent: owner.assert });
      owner.assert();
      notify?.(tx('Manual review is verified. This run’s tracked changes are accepted.', '已核验手动 Review，本轮留痕已接受。'));
      return result;
    } catch (error) { notify?.(error.message); throw error; }
    finally { trackedChangeInFlight.delete(runId); refreshRunCardControls(runId); }
  }

async function acceptRun(runId) {
    const run = findRunRecord(runId);
    if (!run || !isTrackedChangeLifecycleRun(run)) {
      return;
    }
    const status = run.trackedChangeStatus || '';
    // pending and needs_review are both actionable per §7: needs_review means
    // the prior attempt could not prove a clean post-action state, and the
    // user is supposed to be able to retry after inspecting Overleaf.
    if (status !== 'pending' && status !== 'needs_review') {
      return;
    }
    if (!Array.isArray(run.undoTrackedChanges) || !run.undoTrackedChanges.length) {
      return;
    }
    if (trackedChangeInFlight.get(runId)) {
      return;
    }

    const owner = reviewOwner(run);
    trackedChangeInFlight.set(runId, 'accept');
    refreshRunCardControls(runId);
    appendRunRecordEvent(runId, {
      title: tr('runAcceptTrackedStarted'),
      status: 'running',
      detail: { [tr('detailAccepted')]: formatTrackedChangeFiles(run.undoTrackedChanges) }
    });

    try {
      const result = await callPageBridge('acceptTrackedChanges', {
        trackedChanges: run.undoTrackedChanges || [],
        expectedFiles: run.undoExpectedFiles || [],
        postFiles: buildTrackedUndoPostFiles(run),
        appliedOperations: Array.isArray(run.appliedOperations) ? run.appliedOperations : [],
        runProjectId: owner.projectId, accountScopeId: owner.accountScopeId
      });
      owner.assert();
      const manualProof = Modules.ManualReviewProof.normalize(result.manualReviewProof);
      if (manualProof?.runProjectId === owner.projectId && manualProof.accountScopeId === owner.accountScopeId) {
        run.manualReviewProof = manualProof;
      }
      appendAcceptDiagnosticEvents(runId, Array.isArray(result.diagnostics) ? result.diagnostics : []);
      appendRunRecordEvent(runId, {
        title: tr('runAcceptTrackedResult', { applied: result.applied?.length || 0, skipped: result.skipped?.length || 0 }),
        status: result.ok === true && !result.skipped?.length ? 'completed' : 'failed',
        detail: {
          [tr('detailAccepted')]: (result.applied || []).map(item => ({
            [tr('detailFile')]: item.trackedChange?.path || tr('unknownFile'),
            [tr('detailRecord')]: item.trackedChange?.label || item.trackedChange?.id || item.trackedChange?.key
          })),
          [tr('detailSkipped')]: (result.skipped || []).map(item => ({
            [tr('detailFile')]: item.trackedChange?.path || tr('unknownFile'),
            [tr('detailRecord')]: item.trackedChange?.label || item.trackedChange?.id || item.trackedChange?.key || '',
            [tr('detailReason')]: formatBridgeResultReason(item.result, item.trackedChange?.path)
          }))
        }
      });
      if (result.ok === false) {
        appendRunRecordEvent(runId, {
          title: tr('runAcceptTrackedFailed'),
          status: 'failed',
          detail: {
            [tr('detailReason')]: tr('runAcceptTrackedFailedReason')
          }
        });
        if (!WritebackSettlement.isSuccessfulTrackedChangeSettlement(result)) {
          refreshRunCardControls(runId);
        }
      }
      WritebackSettlement.attachAcceptNotVerifiedFailure(run, result, {
        buildFailure: buildContentFailure
      });
      await applyTrackedChangeSettlement(runId, 'accept', result, { assertCurrent: owner.assert });
      owner.assert();
      if (manualProof) notify?.(tx('Automatic acceptance is unavailable for this editor. Open the original file, accept only this run’s entries in Overleaf Review, then verify manual review.',
        '当前编辑器不支持本轮自动接受。请打开原文件，在 Overleaf Review 中仅接受本轮记录，再点击核验手动 Review。'));
    } catch (error) { notify?.(error.message); throw error; }
    finally {
      trackedChangeInFlight.delete(runId);
      refreshRunCardControls(runId);
    }
  }

function appendAcceptDiagnosticEvents(runId, diagnostics) {
    for (const entry of diagnostics || []) {
      const step = entry && entry.step;
      const info = (entry && entry.info) || {};
      const titleKey = WritebackSettlement.ACCEPT_DIAGNOSTIC_TITLE_KEYS[step];
      if (!titleKey) {
        continue;
      }
      const title = titleKey === 'runAcceptTrackedStepReplayStart' || titleKey === 'runAcceptTrackedStepReplayDone'
        ? tr(titleKey, { path: info.path || tr('unknownFile') })
        : tr(titleKey);
      const status = WritebackSettlement.acceptDiagnosticStatus(step, info);
      appendRunRecordEvent(runId, {
        title,
        kind: 'activity',
        status,
        detail: info
      });
    }
  }

async function applyLegacyUndoSettlement(runId, undoStatus, result) {
    const run = findRunRecord(runId);
    if (!run) return;
    const assertCurrent = undoOwner(run);
    const checkpoint = advanceRunUndoProgress(run, result);
    const transition = WritebackSettlement.applySettlementTransition(
      checkpoint,
      WritebackSettlement.settleLegacyUndo({
        run: checkpoint,
        status: undoStatus,
        result
      })
    );
    await Modules.ScopedPersistenceCoordinator.applyReviewTransition({ getState, runId, transition,
      legacyUndo: true, persist: flushQueuedSaveState, assertCurrent });
    refreshRunCardControls(runId);
  }
    return { undoRun, undoRunTrackedChanges, acceptRun, applyLegacyUndoSettlement, openManualReviewFile, verifyManualReview };
  }
  return { create };
});
