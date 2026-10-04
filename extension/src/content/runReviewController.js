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
    const reviewOwners = new Map();
    let undoRecoveryTimer = null, undoRecoveryView = null, undoRecoveryGeneration = 0;
    const undoRecoveryFailures = new Map();
    async function prepareUndoDispatch(runId) {
      const owner = reviewOwners.get(runId);
      if (owner && !owner.deadlineAt) await owner.markDispatched();
      owner?.();
      return Math.min(Date.now() + getPageBridgeTimeoutMs('rejectTrackedChanges'), owner?.deadlineAt || Infinity);
    }
    async function persistUndoOwnerMarker(runId) {
      if (Modules.StorageDb?.sharedSessionsEnabled?.() !== true) return;
      findRunRecord(runId).undoOwnerProtocol = 1;
      try { await flushQueuedSaveState({ requireDurable: true, reviewRunIds: [runId] }); }
      catch (cause) { throw Object.assign(new Error('The Undo owner marker could not be durably saved.'), { code: 'review_state_not_persisted', cause }); }
      reviewOwners.get(runId)?.();
      const saved = await Modules.StorageDb.getRecord('sessions', getState().activeSessionId);
      if (saved?.runs?.find(run => run.id === runId)?.undoOwnerProtocol !== 1)
        throw Object.assign(new Error('The Undo owner marker was not durably retained.'), { code: 'review_state_not_persisted' });
      reviewOwners.get(runId)?.();
    }
    async function withSharedReviewOwnership(runId, work) {
      const db = Modules.StorageDb;
      if (db?.sharedSessionsEnabled?.() !== true) return work();
      const run = findRunRecord(runId);
      if (!run || trackedChangeInFlight.has(runId)) return;
      const assertCurrent = undoOwner(run);
      const sessionId = getState().activeSessionId;
      return db.withSharedReviewLock({ projectId: getRunProjectIdForWriteback(run), accountScopeId: getAccountScopeId(), runId,
        onLost: token => { void callPageBridge('cancelActiveWrite', { reviewOwnerToken: token }).catch(() => {}); } }, async assertOwner => {
        reviewOwners.set(runId, assertOwner);
        try {
          assertCurrent();
          const session = await db.getRecord('sessions', sessionId);
          assertCurrent();
          const latest = session?.runs?.find(record => record.id === runId);
          if (!latest || session.projectId !== getRunProjectIdForWriteback(run) || session.accountScopeId !== getAccountScopeId())
            throw Object.assign(new Error('The shared Undo run is no longer available in its original scope.'), { code: 'review_context_changed' });
          const restored = Modules.SessionState.normalizeRuns([latest], { recoverSettledRuns: true })[0];
          // A budget-omitted first checkpoint may still be complete in its original page.
          // Shared partial/terminal progress always wins over that in-memory copy.
          const keepCheckpoint = restored.recoveryRetention?.state === 'omitted'
            && !restored.undoStatus && !restored.trackedChangeStatus && !run.undoStatus && !run.trackedChangeStatus
            && restored.runProjectId === run.runProjectId && restored.nativeEventSeq === run.nativeEventSeq
            && restored.codexThreadId === run.codexThreadId && restored.codexTurnId === run.codexTurnId
            && restored.startedAt === run.startedAt && JSON.stringify(restored.executionSnapshot) === JSON.stringify(run.executionSnapshot);
          const checkpoint = keepCheckpoint ? Object.fromEntries(['appliedOperations', 'undoOperations', 'undoBaseFiles', 'undoTrackedChanges', 'undoExpectedFiles', 'trackedChangeCaptures']
            .filter(key => Object.hasOwn(run, key)).map(key => [key, run[key]])) : {};
          for (const key of Object.keys(run)) delete run[key];
          Object.assign(run, restored, checkpoint);
          if (run.undoStatus === 'applied' || ['accepted', 'rejected'].includes(run.trackedChangeStatus)) return;
          if (run.undoStatus === 'running' && run.undoOwnerProtocol !== 1) {
            const checked = await showPluginConfirm({ title: tx('Check Undo recovery', '检查撤销恢复'),
              message: tx('Close or reload every older project page and inspect the current files in Overleaf before continuing. Confirm only after those checks are complete.',
                '请先关闭或重载全部旧版项目页面，并在 Overleaf 核对当前文件。完成这些检查后才能继续恢复撤销。'),
              confirmLabel: tx('Checks complete', '已完成检查'), cancelLabel: tr('confirmDefaultCancel'), destructive: true });
            assertCurrent(); if (!checked) return;
            run.undoStatus = 'partial';
          }
          return await work();
        } finally { reviewOwners.delete(runId); refreshRunCardControls(runId); }
      }).catch(error => {
        if (error.code === 'review_busy') notify?.(tx('Another page is reviewing this run. Wait for it to finish.', '另一页面正在审阅本轮记录，请等待其完成。'));
        throw error;
      });
    }
    async function recoverInterruptedUndoStatuses(options = {}) {
      if (undoRecoveryTimer) { clearTimeout(undoRecoveryTimer); undoRecoveryTimer = null; }
      const generation = ++undoRecoveryGeneration;
      const captured = getState(), sessionId = captured.activeSessionId;
      const scope = JSON.stringify([getCurrentProjectId?.(), getAccountScopeId?.(), getRouteGeneration?.()]);
      const sameScope = () => JSON.stringify([getCurrentProjectId?.(), getAccountScopeId?.(), getRouteGeneration?.()]) === scope;
      const current = () => generation === undoRecoveryGeneration && sameScope()
        && getState() === captured && captured.activeSessionId === sessionId;
      const schedule = delay => {
        if (generation !== undoRecoveryGeneration || !sameScope()) return;
        if (undoRecoveryTimer) clearTimeout(undoRecoveryTimer);
        undoRecoveryTimer = setTimeout(() => {
          if (generation === undoRecoveryGeneration && sameScope())
            void recoverInterruptedUndoStatuses({ automatic: true }).catch(() => {});
        }, delay);
        undoRecoveryTimer.unref?.();
      };
      if (undoRecoveryView?.state !== captured || undoRecoveryView?.scope !== scope || undoRecoveryView?.sessionId !== sessionId) {
        undoRecoveryFailures.clear(); undoRecoveryView = { state: captured, scope, sessionId };
      }
      if (options.automatic !== true) undoRecoveryFailures.clear();
      let nextCheck = Infinity;
      const db = Modules.StorageDb;
      const runs = Array.from(new Set([...(captured.runs || []), ...(captured.sessions || []).flatMap(session => session.runs || [])]));
      for (const run of runs) {
        if (run.undoStatus !== 'running' || (undoRecoveryFailures.get(run.id) || 0) >= 3) continue;
        if (db?.sharedSessionsEnabled?.() === true) {
          let owner;
          try {
            owner = await db.hasSharedReviewOwner({ projectId: getRunProjectIdForWriteback(run), accountScopeId: getAccountScopeId(), runId: run.id });
            if (!owner || typeof owner.busy !== 'boolean') throw new Error('Undo recovery ownership is unavailable.');
          } catch (_error) {
            if (!current()) { schedule(50); return; }
            delete run.undoRecoveryCheckRequired; run.undoRecoveryUnavailable = true; refreshRunCardControls(run.id);
            const attempts = (undoRecoveryFailures.get(run.id) || 0) + 1; undoRecoveryFailures.set(run.id, attempts);
            if (attempts === 1) notify?.(tx('Undo recovery checks are temporarily unavailable. Other tasks remain available; keep the recovery files and retry after the connection recovers.',
              '撤销恢复检查暂不可用，其他任务仍可继续。请保留恢复材料，连接恢复后再检查。'));
            if (attempts < 3) nextCheck = Math.min(nextCheck, 5000 * attempts);
            continue;
          }
          if (!current()) { schedule(50); return; }
          undoRecoveryFailures.delete(run.id); delete run.undoRecoveryUnavailable;
          if (!owner.busy && run.undoOwnerProtocol !== 1) {
            run.undoRecoveryCheckRequired = true; refreshRunCardControls(run.id); continue;
          }
          if (owner.busy) { nextCheck = Math.min(nextCheck, owner.deadlineAt > Date.now() ? owner.deadlineAt - Date.now() + 50 : 5000); continue; }
        }
        // Recovery only restores an explicit action; Page work is never replayed.
        delete run.undoRecoveryCheckRequired; run.undoStatus = 'partial'; refreshRunCardControls(run.id);
      }
      if (nextCheck !== Infinity) schedule(Math.min(30000, Math.max(50, nextCheck)));
    }
    async function withLocalUndoLock(runId, work) {
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
        notify?.(error.code === 'review_state_not_persisted' ? tx('Undo recovery ownership could not be saved. No Undo was dispatched; keep this page open and inspect the files before retrying.',
          '撤销恢复归属未能保存，尚未派发撤销。请保留本页并核对文件后重试。') : error.message);
        throw error;
      } finally { trackedChangeInFlight.delete(runId); refreshRunCardControls(runId); }
    }
    const withUndoLock = (runId, work) => withSharedReviewOwnership(runId, () => withLocalUndoLock(runId, work));
    const undoRun = runId => withUndoLock(runId, () => executeUndo(runId));
    const acceptRun = runId => withSharedReviewOwnership(runId, () => executeAcceptRun(runId));
    const verifyManualReview = runId => withSharedReviewOwnership(runId, () => executeVerifyManualReview(runId));
    const undoRunTrackedChanges = (runId, run) => withUndoLock(runId, () => executeTrackedUndo(runId, run));

function undoOwner(run) {
    const captured = getState(), sessionId = captured.activeSessionId;
    const scope = [getCurrentProjectId?.(), getAccountScopeId?.(), getRouteGeneration?.()];
    return () => {
      reviewOwners.get(run.id)?.();
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
    const deadlineAt = await prepareUndoDispatch(runId);
    setRunUndoStatus(runId, 'running');
    appendRunRecordEvent(runId, {
      title: tr('undoNoTraceStarted'),
      status: 'running',
      detail: { [tr('detailWillUndo')]: formatOperationFiles(selectedOperations) }
    });

      await persistUndoOwnerMarker(runId); assertCurrent();
      const result = await callPageBridge('applyOperations', {
        operations: selectedOperations, deadlineAt, reviewOwnerToken: reviewOwners.get(runId)?.token,
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
    const deadlineAt = await prepareUndoDispatch(runId);
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
      await persistUndoOwnerMarker(runId); assertCurrent();
      const trackedUndoPostFilesAtDispatch = buildTrackedUndoPostFiles(textRun);
      result = hasTextUndo ? await callPageBridge('rejectTrackedChanges', {
        trackedChanges: textRun.undoTrackedChanges || [], deadlineAt, reviewOwnerToken: reviewOwners.get(runId)?.token,
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
            operations: fileUndoOperations, reviewOwnerToken: reviewOwners.get(runId)?.token, deadlineAt,
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
      reviewOwners.get(run.id)?.();
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

  async function executeVerifyManualReview(runId) {
    const run = findRunRecord(runId), proof = Modules.ManualReviewProof.normalize(run?.manualReviewProof);
    if (!proof || run.forkSnapshot || !['pending', 'needs_review'].includes(run.trackedChangeStatus)
      || trackedChangeInFlight.has(runId)) return;
    const owner = reviewOwner(run), signature = JSON.stringify(proof);
    if (proof.runProjectId !== owner.projectId || proof.accountScopeId !== owner.accountScopeId) return;
    trackedChangeInFlight.set(runId, 'accept'); refreshRunCardControls(runId);
    try {
      const deadlineAt = await prepareUndoDispatch(runId);
      const result = await callPageBridge('acceptTrackedChanges', { deadlineAt, reviewOwnerToken: reviewOwners.get(runId)?.token, verifyManualReview: true,
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

async function executeAcceptRun(runId) {
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
      const deadlineAt = await prepareUndoDispatch(runId);
      const result = await callPageBridge('acceptTrackedChanges', { deadlineAt, reviewOwnerToken: reviewOwners.get(runId)?.token,
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
    return { recoverInterruptedUndoStatuses, undoRun, undoRunTrackedChanges, acceptRun, applyLegacyUndoSettlement, openManualReviewFile, verifyManualReview };
  }
  return { create };
});
