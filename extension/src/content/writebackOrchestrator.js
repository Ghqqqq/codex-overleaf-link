(function initCodexOverleafWritebackOrchestrator() {
  'use strict';

  // Writeback orchestration carved out of contentRuntime.js (v1.6.3
  // structural-debt phase 6): the sync-writeback pipeline
  // (applySyncChangesToOverleaf), post-write save verification, mirror
  // refresh, auto recompile, and the compile/unsupported-change summary
  // helpers. Code moved verbatim; the only rewrites are the mutable runtime
  // bindings (state -> getState(), currentRunView -> getCurrentRunView()).
  //
  // Shape note: unlike the earlier carves, the functions live at the IIFE
  // top level (same 2-space indentation as before the move) with
  // collaborators injected into module-scoped bindings by create(). This
  // keeps the source-contract tests (which match exact indentation spans)
  // intact.

  let tr;
  let tx;
  let getLocale;
  let appendRunEvent;
  let appendRunRecordEvent;
  // In-flight background mirror refresh (v1.7.5) — see the writeback path.
  let pendingMirrorRefresh = null;
  const mirrorSettlementOwners = new Map();
  const mirrorReuseFences = new Map();
  const CANCELLED_MIRROR_INVALIDATION_TIMEOUT_MS = 20000;
  let appendChangeSummary;
  let appendCompletionReport;
  let appendOperationsPreview;
  let appendPartialWritebackWarning;
  let appendApplyResult;
  let renderReadOnlyDiffReview;
  let showPluginConfirm;
  let callPageBridge;
  let sendBackgroundNative;
  let getCurrentProjectId;
  let resetContextProject;
  let sanitizeRunProjectSnapshot;
  let getAssistantAnswerForCurrentRun;
  let cleanFinalAnswer;
  let recordUndoFromApply;
  let getSkippedEntries;
  let getAppliedOperationPaths;
  let hasApplyResultEntries;
  let getAppliedSyncChanges;
  let mergeApplyResultSkipped;
  let hasSkippedApplyOperations;
  let formatWritebackSkippedNextStep;
  let formatOperationFiles;
  let summarizeOperationForAudit;
  let buildAuditSummaryFromApply;
  let buildSyncApplyOperations;
  let partitionUnsafeProjectPathOperations;
  let evaluateGovernedOperations;
  let buildGovernanceSkippedApplyResult;
  let buildReviewingBlockedApplyResult;
  let ensureReviewingBeforeWrite;
  let confirmBinaryOperations;
  let compileAdapter;
  let filterSyncChangesByOperations;
  let writebackController;
  let RUN_SNAPSHOT_ZIP_TIMEOUT_MS;
  let getState;
  let getCurrentRunView;
  let onMirrorRefreshSettled;
  let writebackSettlement;
  let injectedWritebackSettlement;
  let assetTransferBroker;
  let stageWritebackRecovery;
  let settleWritebackRecovery;

  function buildSettlement(input = {}) {
    return writebackSettlement?.settle instanceof Function
      ? writebackSettlement.settle(input)
      : null;
  }

  function getMirrorReuseFence(projectId) {
    return mirrorReuseFences.get(projectId) || null;
  }

  async function settleFullMirrorSync(projectId, project, fence, response, options = {}) {
    if (!fence || getMirrorReuseFence(projectId) !== fence || response?.ok !== true
      || project?.capabilities?.fullProjectSnapshot !== true
      || project.capabilities.contentComplete === false || project.capabilities.skipped?.length) return false;
    try {
      options.assertCurrent?.();
      const status = await (options.sendNative || sendBackgroundNative)({ method: 'mirror.status', params: { projectId } });
      options.assertCurrent?.();
      if (getCurrentProjectId() !== projectId || getMirrorReuseFence(projectId) !== fence
        || status?.ok !== true || status.result?.exists !== true || status.result.dirty === true) return false;
      mirrorReuseFences.delete(projectId);
      return true;
    } catch (_error) {
      options.assertCurrent?.();
      return false;
    }
  }

  async function syncFencedMirror(projectId, project, options = {}) {
    const fence = options.fence;
    if (!fence || getMirrorReuseFence(projectId) !== fence || fence.syncAttempted
      || project?.id !== projectId || project.capabilities?.fullProjectSnapshot !== true
      || project.capabilities.contentComplete === false || project.capabilities.skipped?.length) return false;
    options.assertCurrent();
    // Only the next full-read path adds a sync; a failed attempt keeps reuse
    // fenced without adding another request on every subsequent run.
    fence.syncAttempted = true;
    try {
      const response = await options.sendNative({ method: 'mirror.sync', params: { projectId, project } });
      options.assertCurrent();
      return await settleFullMirrorSync(projectId, project, fence, response, options);
    } catch (_error) {
      options.assertCurrent();
      return false;
    }
  }

  function trackWritebackMirror(work, target, onSettled) {
    const key = JSON.stringify([target.runProjectId, target.sessionId, target.recordId]);
    const owner = {};
    mirrorSettlementOwners.set(key, owner);
    const refresh = Promise.resolve(work).then(async state => {
      if (mirrorSettlementOwners.get(key) !== owner) return state;
      onSettled?.(state);
      await onMirrorRefreshSettled?.({ ...target, state: state || 'not-attempted' });
      return state;
    }).finally(() => {
      if (mirrorSettlementOwners.get(key) === owner) mirrorSettlementOwners.delete(key);
    });
    // Keep earlier work in the barrier even if this attempt finishes first or
    // fails. Only the latest composed barrier may clear the shared slot.
    const pending = Promise.allSettled([pendingMirrorRefresh, refresh]).then(([, result]) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    }).finally(() => {
      if (pendingMirrorRefresh === pending) pendingMirrorRefresh = null;
    });
    pendingMirrorRefresh = pending;
    return pending;
  }

  function invalidateMirrorAfterUndo(runId, projectId, result = {}) {
    if (!projectId || (result?.changedDocument !== true && !result?.applied?.length)) return Promise.resolve('not-attempted');
    const pending = Promise.resolve(pendingMirrorRefresh).catch(() => {}).then(async () => {
      const response = await sendBackgroundNative({ method: 'mirror.invalidate', params: { projectId } });
      if (!response?.ok || response.result?.invalidated !== true) {
        throw new Error(response?.error?.message || 'Native host did not confirm mirror invalidation.');
      }
      if (getCurrentProjectId() === projectId) {
        resetContextProject();
        await callPageBridge('invalidateProjectSnapshot', { invalidateFileList: true });
      }
      return 'invalidated';
    }).catch(error => {
      appendRunRecordEvent?.(runId, {
        status: 'warning',
        title: tx(
          `Overleaf undo finished, but local mirror invalidation failed: ${error.message}. Refresh this project or reconnect the native host before running again.`,
          `Overleaf 撤销已完成，但本地镜像失效处理失败：${error.message}。请刷新项目或重新连接 Native Host 后再运行。`
        )
      });
      return 'failed';
    }).finally(() => {
      if (pendingMirrorRefresh === pending) pendingMirrorRefresh = null;
    });
    pendingMirrorRefresh = pending;
    return pending;
  }

  function selectionViolationNextStep() {
    return tx('Select the intended region again and request only changes within it. Valid written parts can be undone.',
      '请重新选择目标范围，仅请求修改该范围。已写入的合法部分可撤销。');
  }

  function buildWithheldEntry(change) {
    const reason = writebackController.formatUnsupportedLocalChangeReason(change, getLocale());
    const nextAction = change.reason === 'selection_scope_violation' ? selectionViolationNextStep()
      : tx('The main agent must review the withheld file before syncing it.', '主代理需核对未同步文件后再写回。');
    return { operation: { type: 'create', path: change.path }, result: { ok: false,
      code: change.reason, reason, changedDocument: false, failure: { code: change.reason,
        stage: 'preflight', severity: 'blocked', retryable: false, terminalState: 'blocked', changedDocument: false,
        userMessage: reason, nextAction } } };
  }

  async function applySyncChangesToOverleaf(syncChanges = [], project = {}, options = {}) {
    const activeRun = getCurrentRunView?.();
    const saveTarget = { runProjectId: activeRun?.runProjectId || '', recordId: activeRun?.recordId || '', sessionId: activeRun?.sessionId || '' };
    const runMode = options.mode || getState().mode;
    const runRequireReviewing = typeof options.requireReviewing === 'boolean'
      ? options.requireReviewing
      : getState().requireReviewing === true;
    const assistantMessage = cleanFinalAnswer(options.assistantMessage || getAssistantAnswerForCurrentRun());
    const unsupportedChanges = Array.isArray(options.unsupportedChanges) ? options.unsupportedChanges : [];
    appendUnsupportedLocalChanges(unsupportedChanges);
    const withheldOnly = unsupportedChanges.filter(change => ['subagent_unfinished_output', 'subagent_unauthorized_edit', 'selection_scope_violation'].includes(change.reason));
    if (runMode !== 'ask' && !syncChanges.length && withheldOnly.length) {
      const skipped = withheldOnly.map(buildWithheldEntry);
      const hasSelectionViolation = withheldOnly.some(change => change.reason === 'selection_scope_violation');
      const applied = { ok: false, applied: [], skipped };
      appendCompletionReport({ conclusionKey: options.assistantMessageKey || (!assistantMessage ? 'withheld_changes' : undefined), conclusion: assistantMessage || tx('Some generated changes were blocked.', '部分生成的改动已被阻止。'),
        status: 'failed', operations: [], applyResults: [applied], mode: runMode,
        nextStep: hasSelectionViolation
          ? selectionViolationNextStep()
          : tx('The main agent must review and adopt the withheld files before syncing them.', '主代理需核对并接管未同步文件后再写回。') });
      return { summaryLine: hasSelectionViolation
          ? tx('Changes outside the selection were blocked.', '选区外改动已被阻止。')
          : tx('Generated files are awaiting review.', '生成文件待核对。'), hasSkippedOperations: true,
        applied, settlement: buildSettlement({ operations: [], applyResult: applied }),
        audit: buildAuditSummaryFromApply({ operations: [], applyResults: [applied], resultStatus: 'completed_with_skips' }) };
    }

    // Guard on the immutable submitted mode, not the mutable panel state.
    if (options.mode === 'ask' && ((syncChanges || []).length || unsupportedChanges.length)) {
      appendRunEvent({
        title: tx(
          'Ask mode ignored local file changes. Overleaf was not modified.',
          'Ask 模式已忽略本地文件改动；Overleaf 未被修改。'
        ),
        status: 'warning'
      });
      appendCompletionReport({ conclusionKey: options.assistantMessageKey || (!assistantMessage ? 'ask_ignored_changes' : undefined),
        conclusion: assistantMessage || tx(
          'Codex finished in Ask mode. Any local file changes were ignored and were not synced to Overleaf.',
          'Codex 已在 Ask 模式完成；本地文件改动已忽略，未同步到 Overleaf。'
        ),
        status: tr('modeAsk'),
        operations: [],
        applyResults: [],
        mode: runMode,
        nextStep: tx(
          'Switch to Auto only when you want Codex to edit files.',
          '只有希望 Codex 修改文件时，才需要切换到自动写入。'
        )
      });
      return {
        summaryLine: assistantMessage || tx('Ask mode completed without Overleaf changes', 'Ask 模式已完成，未修改 Overleaf'),
        hasSkippedOperations: false,
        settlement: buildSettlement({
          operations: [],
          applyResult: { ok: true, applied: [], skipped: [] }
        }),
        audit: buildAuditSummaryFromApply({
          operations: [],
          resultStatus: 'ask_ignored_local_changes',
          blockedFiles: [
            ...(syncChanges || []).map(change => ({ path: change.path, type: change.type, reason: 'ask_mode' })),
            ...unsupportedChanges.map(change => ({ path: change.path, type: change.type || 'unsupported', reason: change.reason || 'ask_mode' }))
          ]
        })
      };
    }
    let operations = buildSyncApplyOperations(syncChanges, project);
    let visibleSyncChanges = syncChanges || [];
    // A previous Native build can still report inferred metadata moves.
    // Forward sync never promotes them to a new file or a new capability.
    let additionalSkippedEntries = operations.filter(operation => operation.type === 'move').map(operation => ({
      operation,
      result: { ok: false, code: 'file_tree_controls_unavailable', changedDocument: false,
        reason: tx('Automatic file moves are unavailable. Handle the path change in Overleaf before retrying.',
          '暂不支持自动移动文件，请先在 Overleaf 中处理路径变化后再重试。') }
    }));
    operations = operations.filter(operation => operation.type !== 'move');
    if (additionalSkippedEntries.length) visibleSyncChanges = filterSyncChangesByOperations(syncChanges, operations);
    let skippedFilesForAudit = additionalSkippedEntries;
    let appliedFilesForAudit = [];
    const pathSafety = partitionUnsafeProjectPathOperations(operations);
    if (pathSafety.skipped.length) {
      additionalSkippedEntries.push(...pathSafety.skipped);
      operations = pathSafety.safe;
      visibleSyncChanges = filterSyncChangesByOperations(syncChanges, operations);
    }
    const governed = evaluateGovernedOperations(operations);
    if (governed.blocked.length) {
      const governanceSkipped = buildGovernanceSkippedApplyResult(governed.blocked);
      additionalSkippedEntries.push(...getSkippedEntries(governanceSkipped));
      appendApplyResult(governanceSkipped);
      appendRunEvent({
        title: tx(
          `Project governance blocked ${governed.blocked.length} write(s) before review.`,
          `项目治理规则在审核前阻止了 ${governed.blocked.length} 项写入。`
        ),
        status: 'failed'
      });
      operations = governed.allowed;
      visibleSyncChanges = filterSyncChangesByOperations(syncChanges, operations);
    }
    if (!operations.length) {
      const blockedSettlement = buildSettlement({
        operations: buildSyncApplyOperations(syncChanges, project),
        applyResult: { ok: additionalSkippedEntries.length === 0, applied: [], skipped: additionalSkippedEntries }
      });
      const blockedFailure = blockedSettlement
        ? writebackSettlement.projectRunSettlement({ settlement: blockedSettlement.facts }).primaryFailure : undefined;
      appendRunEvent({
        title: tx('Codex did not produce file changes that need to sync back to Overleaf.', 'Codex 没有产生需要同步回 Overleaf 的文件改动。'),
        status: 'completed'
      });
      const blockedConclusion = assistantMessage
        ? `${assistantMessage}\n\n${tx('Sync note: no changes were written to Overleaf; every change was blocked before writing.', '同步提示：没有向 Overleaf 写入任何改动；所有改动都在写入前被拦下。')}`
        : tx('No changes were written to Overleaf; every change was blocked before writing.', '没有向 Overleaf 写入任何改动；所有改动都在写入前被拦下。');
      appendCompletionReport({ conclusionKey: additionalSkippedEntries.length ? undefined
        : options.assistantMessageKey || (!assistantMessage ? 'no_sync_changes' : undefined),
        conclusion: additionalSkippedEntries.length ? blockedConclusion
          : assistantMessage || tx('Codex finished locally. There are no changes to sync back to Overleaf.', 'Codex 已完成本地处理，没有需要同步回 Overleaf 的改动。'),
        conclusionSource: additionalSkippedEntries.length ? { origin: 'product', key: 'writeback',
          outcome: 'blocked_sync', prefixLength: assistantMessage.length } : undefined,
        status: additionalSkippedEntries.length ? 'failed' : runMode === 'ask' ? tr('modeAsk') : 'completed',
        failure: blockedFailure,
        operations: [],
        applyResults: additionalSkippedEntries.length ? [{ ok: false, applied: [], skipped: additionalSkippedEntries }] : [],
        unchangedReason: additionalSkippedEntries.find(item => item?.result?.reason)?.result.reason
          || (assistantMessage ? tx('No file changes need to sync back to Overleaf.', '没有产生需要同步回 Overleaf 的文件改动。') : formatUnsupportedLocalChangeSummary(unsupportedChanges)),
        mode: runMode,
        nextStep: additionalSkippedEntries.length ? formatWritebackSkippedNextStep({ ok: false, applied: [], skipped: additionalSkippedEntries }) : tx('You can continue the conversation, or adjust @context and run again.', '可以继续追问，或调整 @context 后重新运行。')
      });
      return {
        summaryLine: assistantMessage || tx('No changes to sync', '没有需要同步的改动'),
        hasSkippedOperations: additionalSkippedEntries.length > 0,
        settlement: blockedSettlement,
        audit: buildAuditSummaryFromApply({
          operations: buildSyncApplyOperations(syncChanges, project),
          applyResults: additionalSkippedEntries.length ? [{ ok: false, applied: [], skipped: additionalSkippedEntries }] : [],
          blockedFiles: additionalSkippedEntries.map(item => summarizeOperationForAudit(item.operation, item.result, 'blocked')),
          resultStatus: additionalSkippedEntries.length ? 'blocked' : 'completed'
        })
      };
    }

    const deleteOperations = operations.filter(operation => operation.type === 'delete');
    if (deleteOperations.length) {
      const approved = await showPluginConfirm({
        title: tr('deleteFilePromptTitle'),
        message: tr('deleteFilePromptMessage', { files: formatOperationFiles(deleteOperations) }),
        confirmLabel: tr('deleteFileConfirm'),
        cancelLabel: tr('deleteFileCancel'),
        destructive: true
      });
      if (!approved) {
        additionalSkippedEntries.push(...deleteOperations.map(operation => ({
          operation,
          result: {
            ok: false,
            code: 'delete_confirmation_rejected',
            reason: tx('Delete requires explicit confirmation and was skipped.', '删除需要显式确认，已跳过。')
          }
        })));
        operations = operations.filter(operation => operation.type !== 'delete');
      }
    }

    if (operations.some(operation => operation.type === 'binary-create' || operation.type === 'overwrite-binary')) {
      appendRunEvent({
        title: tx('Generated binary asset writeback requires explicit confirmation.', '生成的二进制资源写回需要显式确认。'),
        status: 'running'
      });
    }
    const binaryDecision = await confirmBinaryOperations(operations);
    operations = binaryDecision.operations;
    additionalSkippedEntries.push(...binaryDecision.skipped);

    if (!operations.length) {
      const approvalSettlement = buildSettlement({
        operations: buildSyncApplyOperations(syncChanges, project),
        applyResult: { ok: additionalSkippedEntries.length === 0, applied: [], skipped: additionalSkippedEntries }
      });
      const approvalFailure = approvalSettlement
        ? writebackSettlement.projectRunSettlement({ settlement: approvalSettlement.facts }).primaryFailure : undefined;
      appendRunEvent({
        title: tx('No approved file changes remain to sync back to Overleaf.', '没有剩余已确认的文件改动需要同步回 Overleaf。'),
        status: 'completed'
      });
      appendCompletionReport({ conclusionKey: options.assistantMessageKey || (!assistantMessage ? 'no_approved_changes' : undefined),
        conclusion: assistantMessage || tx('No approved changes were written back to Overleaf.', '没有已确认的改动写回 Overleaf。'),
        status: additionalSkippedEntries.length ? 'failed' : runMode === 'ask' ? tr('modeAsk') : 'completed',
        failure: approvalFailure,
        operations: [],
        applyResults: additionalSkippedEntries.length ? [{ ok: false, applied: [], skipped: additionalSkippedEntries }] : [],
        unchangedReason: additionalSkippedEntries.find(item => item?.result?.reason)?.result.reason
          || tx('No approved file changes remain to sync back to Overleaf.', '没有剩余已确认的文件改动需要同步回 Overleaf。'),
        mode: runMode,
        nextStep: additionalSkippedEntries.length ? formatWritebackSkippedNextStep({ ok: false, applied: [], skipped: additionalSkippedEntries }) : tx('You can continue the conversation, or adjust @context and run again.', '可以继续追问，或调整 @context 后重新运行。')
      });
      return {
        summaryLine: tx('No changes applied', '没有应用改动'),
        hasSkippedOperations: additionalSkippedEntries.length > 0,
        settlement: approvalSettlement,
        audit: buildAuditSummaryFromApply({
          operations: buildSyncApplyOperations(syncChanges, project),
          applyResults: additionalSkippedEntries.length ? [{ ok: false, applied: [], skipped: additionalSkippedEntries }] : [],
          blockedFiles: additionalSkippedEntries
            .filter(item => item.result?.code === 'governance_blocked')
            .map(item => summarizeOperationForAudit(item.operation, item.result, 'blocked')),
          resultStatus: additionalSkippedEntries.length ? 'completed_with_skips' : 'completed'
        })
      };
    }

    appendOperationsPreview(operations, tx('Sync local Codex changes to Overleaf', '同步本地 Codex 改动到 Overleaf'));
    const reviewing = await ensureReviewingBeforeWrite(operations, { requireReviewing: runRequireReviewing });
    if (!reviewing.ok) {
      const blocked = buildReviewingBlockedApplyResult(operations, reviewing);
      appendApplyResult(blocked);
      appendCompletionReport({ conclusionKey: 'reviewing_unavailable',
        conclusion: reviewing.code === 'reviewing_unavailable' ? tr('failureReason_reviewing_unavailable_user') : tx(
          'No files were written: Track is enabled, but Codex could not verify Overleaf Reviewing/Track Changes.',
          '这轮没有写入：已开启“留痕”要求，但 Codex 没能确认 Overleaf 正在用 Reviewing/Track Changes。'
        ),
        status: 'failed',
        operations,
        applyResults: [blocked],
        mode: runMode,
        nextStep: reviewing.code === 'reviewing_unavailable' ? tr('failureReason_reviewing_unavailable_next') : tx(
          'Switch Overleaf to Reviewing/Track Changes manually and rerun, or turn off Track before writing.',
          '请在 Overleaf 手动切到 Reviewing/Track Changes 后重新运行，或关闭“留痕”再写入。'
        )
      });
      return {
        summaryLine: tx(
          'Write blocked: Overleaf Reviewing/Track Changes was not verified',
          '已阻止写入：未确认 Overleaf Reviewing/Track Changes'
        ),
        hasSkippedOperations: true,
        settlement: buildSettlement({ operations, applyResult: blocked }),
        audit: buildAuditSummaryFromApply({
          operations,
          applyResults: [blocked],
          blockedFiles: additionalSkippedEntries
            .filter(item => item.result?.code === 'governance_blocked')
            .map(item => summarizeOperationForAudit(item.operation, item.result, 'blocked')),
          resultStatus: 'blocked'
        })
      };
    }
    const writebackActivityId = 'overleaf-writeback:' + Date.now().toString(36);
    appendRunEvent({
      title: tx('Syncing approved changes to Overleaf.', '正在将已批准的改动同步到 Overleaf。'),
      status: 'running',
      activity: { v: 1, kind: 'sync', id: writebackActivityId, state: 'running', paths: operations.map(operation => operation.path).filter(Boolean) }
    });
    await stageWritebackRecovery?.(operations, saveTarget, runRequireReviewing, project);
    const applied = operations.length
      ? mergeApplyResultSkipped(await assetTransferBroker.applyOperations({
        operations,
        baseFiles: project?.files || [],
        requireReviewing: runRequireReviewing,
        requireEditing: !runRequireReviewing,
        // Welcome-panel + write-guard:
        // immutable per-run project id, checked by the page-side guard
        // against `_ide.project._id` before any mutation.
        runProjectId: getCurrentRunView()?.runProjectId || '',
        retryCreates: options.retryCreates === true
      }), additionalSkippedEntries)
      : mergeApplyResultSkipped({ ok: true, applied: [], skipped: [] }, additionalSkippedEntries);
    const hasConfirmedApplyResult = hasApplyResultEntries(applied);
    for (const change of unsupportedChanges.filter(item => ['subagent_unfinished_output', 'subagent_unauthorized_edit', 'selection_scope_violation'].includes(item.reason))) {
      applied.skipped.push(buildWithheldEntry(change));
      applied.ok = false;
    }
    // Record the apply result + undo checkpoint IMMEDIATELY, before any
    // cancellable verify/mirror awaits below. A user-cancel during the
    // post-write save-verify or mirror refresh throws codex_cancelled; if undo
    // recording sat after those awaits (as it used to), a cancel skipped it and
    // left the user no "Undo written parts" button for changes that already
    // landed in Overleaf. The manual-confirm path already records undo right
    // after its write — match that ordering here (v1.6.2).
    appendApplyResult(applied);
    await recordUndoFromApply(project, applied);
    const skippedEntries = getSkippedEntries(applied);
    if (skippedEntries.length) {
      appendPartialWritebackWarning(applied);
    }
    if (runMode === 'auto') {
      renderReadOnlyDiffReview(getAppliedSyncChanges(syncChanges, applied));
    }
    const appliedPaths = getAppliedOperationPaths(applied);
    appendRunEvent({
      title: tx('Overleaf writeback returned its result.', 'Overleaf 写回已返回结果。'),
      status: !hasConfirmedApplyResult || skippedEntries.length ? 'warning' : 'completed',
      activity: { v: 1, kind: 'sync', id: writebackActivityId,
        state: !hasConfirmedApplyResult || skippedEntries.length ? 'warning' : 'completed',
        paths: operations.map(operation => operation.path).filter(Boolean),
        written: appliedPaths.length, skipped: skippedEntries.length }
    });
    // Only probe save-state + refresh the mirror when real writes landed. A
    // zero-write run (every operation skipped) has nothing to save-verify, so
    // skip the ~5s probe and its misleading "could not verify saved" warning
    // (v1.6.2).
    let confirmation;
    try {
      confirmation = appliedPaths.length
        ? await verifyPostWriteSaveState(applied, project, saveTarget)
        : { verification: { ok: false, state: 'not_checked', reason: 'No applied writeback operations were returned.' } };
    } catch (error) {
      if (!appliedPaths.length || (error?.code !== 'codex_cancelled' && error?.name !== 'AbortError')) throw error;
      const saveVerification = { ok: false, state: 'unknown_timeout', signal: 'unavailable',
        reason: 'Save confirmation was cancelled.', recoveryReason: 'codex_cancelled', attempts: [] };
      // Cancellation cannot erase the returned writes or the recovery needed to
      // check their save state. Carry the same evidence into the cancelled report.
      error.writebackOutcome = { operations, applied, saveVerification,
        settlement: buildSettlement({ operations, applyResult: applied, saveVerification, mirror: { state: 'unknown' } }) };
      // Fence the Page cache now; bound the Native wait so an unanswered
      // invalidation cannot strand the next run or recovery behind the barrier.
      trackWritebackMirror(invalidateWritebackMirror(saveTarget, {
        pageFirst: true, nativeTimeoutMs: CANCELLED_MIRROR_INVALIDATION_TIMEOUT_MS
      }), saveTarget,
        state => {
          error.writebackOutcome.settlement = buildSettlement({ operations, applyResult: applied, saveVerification, mirror: { state } });
        });
      try {
        await settleWritebackRecovery?.(applied, project, saveVerification, saveTarget, runRequireReviewing);
      } catch (recoveryError) {
        appendRunRecordEvent?.(saveTarget.recordId, { kind: 'technical', status: 'warning',
          title: tx('Writeback recovery persistence failed', '写回恢复信息保存失败'), detail: { reason: recoveryError.message } });
      }
      throw error;
    }
    const saveVerification = confirmation.verification;
    await settleWritebackRecovery?.(applied, project, saveVerification, saveTarget, runRequireReviewing);
    if (appliedPaths.length) {
      appendPostWriteSaveVerificationWarning(saveVerification, saveTarget);
      appendRunEvent({ kind: 'technical', title: 'Post-write save confirmation', status: 'info', detail: saveVerification });
    }
    // v1.7.5: the mirror refresh (zip snapshot + mirror.sync, often the
    // slowest post-write step) no longer blocks the completion report. The
    // pending promise is exposed so undoRun and the next runTask barrier on
    // it — a mirror.sync landing AFTER an undo would otherwise push the
    // pre-undo snapshot as the local baseline.
    trackWritebackMirror(refreshProjectMirrorAfterWriteback(project, applied, saveVerification, { target: saveTarget, snapshot: confirmation.snapshot })
      .catch(async error => {
        appendRunRecordEvent(saveTarget.recordId, { kind: 'technical', title: 'Mirror refresh requires a fresh read', status: 'info', detail: { reason: error.message } });
        return invalidateWritebackMirror(saveTarget);
      }), saveTarget);
    const compileSummary = appliedPaths.length
      ? await autoRecompileAfterWriteback(appliedPaths, saveVerification, {
        autoRecompile: options.autoRecompile,
        mode: runMode,
        runProjectId: saveTarget.runProjectId
      }).catch(error => {
        appendRunEvent({
          title: tx(`Post-write compile failed: ${error.message}`, `写后编译出错：${error.message}`),
          status: 'failed'
        });
        return compileAdapter.buildPostWriteCompileSummary({ error });
      })
      : null;
    const hasSkippedApplyResult = skippedEntries.length > 0;
    const writebackIncomplete = !hasConfirmedApplyResult || hasSkippedApplyResult;
    const summaryLine = appendChangeSummary({
      notes: hasConfirmedApplyResult
        ? tx('Local Codex changes were synced back to Overleaf.', '本地 Codex 改动已同步回 Overleaf。')
        : tx('Local Codex changes were sent to Overleaf, but Codex could not confirm the write result.', '本地 Codex 改动已发送到 Overleaf，但 Codex 没能确认写入结果。'),
      operations,
      applyResults: [applied],
      status: writebackIncomplete ? 'writeback incomplete' : 'synced from local Codex workspace'
    });
    const syncedConclusion = assistantMessage || tx('Local Codex changes were synced back to Overleaf.', '本地 Codex 改动已同步回 Overleaf。');
    const partialSyncConclusion = assistantMessage
      ? `${assistantMessage}\n\n${tx('Sync note: local Codex changes were sent to Overleaf, but some items were skipped.', '同步提示：本地 Codex 改动已尝试写回 Overleaf，但有部分项目被跳过。')}`
      : tx('Local Codex changes were sent to Overleaf, but some items were skipped.', '本地 Codex 改动已尝试同步回 Overleaf，但有部分项目被跳过。');
    const unconfirmedSyncConclusion = assistantMessage
      ? `${assistantMessage}\n\n${tx('Writeback note: Codex could not confirm any Overleaf write result entries, so local mirror refresh and auto compile were skipped.', '写入提示：Codex 没能确认任何 Overleaf 写入结果条目，因此已跳过本地 mirror 刷新和自动编译。')}`
      : tx('Codex tried to write local changes to Overleaf, but the write result did not confirm any applied or skipped entries.', 'Codex 已尝试把本地改动写入 Overleaf，但写入结果没有确认任何已写入或已跳过条目。');
    const writebackConclusion = !hasConfirmedApplyResult
      ? unconfirmedSyncConclusion
      : hasSkippedApplyResult
        ? partialSyncConclusion
        : syncedConclusion;
    const writebackNextStep = !hasConfirmedApplyResult
      ? tx('Check Overleaf manually before running again. Local mirror refresh and auto compile were skipped.', '再次运行前请先手动检查 Overleaf。本地 mirror 刷新和自动编译已跳过。')
      : hasSkippedApplyResult
        ? formatWritebackSkippedNextStep(applied)
        : tx('Review the synced file in Overleaf.', '请在 Overleaf 中查看同步后的文件。');
    appendCompletionReport({
      conclusion: appendCompileSummaryToConclusion(writebackConclusion, compileSummary),
      conclusionSource: { origin: 'product', key: 'writeback',
        outcome: !hasConfirmedApplyResult ? 'unconfirmed_sync' : hasSkippedApplyResult ? 'partial_sync' : 'synced',
        prefixLength: assistantMessage.length, prefixKey: options.assistantMessageKey, hasCompile: Boolean(compileSummary), compileStatus: compileSummary?.status || '',
        compileReason: compileAdapter.localizeCompileReason(compileSummary?.reason || '', getLocale()), errors: compileSummary?.errors?.slice(0, 3) || [], errorCount: compileSummary?.errors?.length || 0, warningCount: compileSummary?.warnings?.length || 0 },
      status: writebackIncomplete ? 'failed' : 'completed',
      operations,
      applyResults: [applied],
      mode: runMode,
      nextStep: writebackNextStep,
      // Structured compile errors give the report a one-click fix action.
      compileErrors: compileSummary?.status === 'failed' && Array.isArray(compileSummary.errors)
        ? compileSummary.errors
        : undefined,
      saveVerification,
      // Promote the primary per-operation skip failure to the run level when
      // the writeback failed outright: target-file and write-stage codes only
      // ever exist inside applied.skipped[], and without this promotion the
      // recovery registry's "Open <file>" / "Edit & resend" branches are
      // unreachable for them (fleet finding, v1.7.5).
      failure: writebackIncomplete ? promoteWritebackSkippedFailure(applied) : undefined
    });

    return {
      summaryLine,
      hasSkippedOperations: writebackIncomplete || hasSkippedApplyOperations([applied]),
      // Welcome-panel + write-guard: expose the raw applied
      // result so the post-navigation settlement (spec §5.7.1) can classify
      // the run by inspecting the `applied.skipped` entries' failure codes.
      // Existing call sites that only read `summaryLine` / `hasSkippedOperations`
      // / `audit` are unaffected.
      operations,
      applied,
      saveVerification,
      settlement: buildSettlement({
        operations,
        applyResult: applied,
        saveVerification,
        mirror: {
          state: appliedPaths.length && saveVerification?.state === 'verified_saved'
            ? 'pending'
            : 'not_started'
        },
        compile: compileSummary
      }),
      audit: buildAuditSummaryFromApply({
        operations,
        applyResults: [applied],
        blockedFiles: additionalSkippedEntries
          .filter(item => item.result?.code === 'governance_blocked')
          .map(item => summarizeOperationForAudit(item.operation, item.result, 'blocked')),
        resultStatus: writebackIncomplete ? 'completed_with_skips' : 'completed',
        saveVerification
      })
    };
  }

  async function verifyPostWriteSaveState(applied, project, target = {}) {
    return writebackController.confirmPostWriteSave({
      applied, project, runProjectId: target.runProjectId,
      assertCurrent() {
        if (!target.runProjectId || getCurrentProjectId() !== target.runProjectId) {
          throw Object.assign(new Error('The Overleaf project changed during save confirmation.'), { code: 'aborted_project_changed', changedDocument: true });
        }
        if (target.recordId && getCurrentRunView()?.recordId !== target.recordId) {
          throw Object.assign(new Error('The run stopped during save confirmation.'), { code: 'codex_cancelled', changedDocument: true });
        }
      },
      readSaveState: params => callPageBridge('waitForSaveState', { ...params, runProjectId: target.runProjectId }),
      readSnapshot: params => callPageBridge('getProjectSnapshot', { ...params, runProjectId: target.runProjectId })
    });
  }

  function appendPostWriteSaveVerificationWarning(saveVerification = {}, target = {}) {
    if (saveVerification.state === 'verified_saved') return;
    // Missing confirmation is represented once in the report, with a check action.
    if (saveVerification.signal !== 'offline') return;
    const title = saveVerification.signal === 'offline'
      ? tx('Overleaf is offline. Keep this page open and reconnect so the changes can be saved.',
        'Overleaf 当前离线。请保持页面开启，恢复连接后等待改动保存。')
      : tx('Saving these changes is not yet confirmed. Keep this page open and check Overleaf’s save and connection status.',
        '尚未确认本次改动已保存。请保持页面开启，检查 Overleaf 的保存和连接状态。');
    if (target.recordId) appendRunRecordEvent(target.recordId, { title, status: 'warning' });
    else appendRunEvent({ title, status: 'warning' });
  }

  async function invalidateWritebackMirror(target = {}, options = {}) {
    const invalidatePage = async () => {
      if (getCurrentProjectId() !== target.runProjectId) return true;
      try {
        resetContextProject();
        const response = await callPageBridge('invalidateProjectSnapshot', { invalidateFileList: true, runProjectId: target.runProjectId });
        return response?.ok === true;
      } catch (_error) { return false; }
    };
    const pageInvalidation = options.pageFirst === true ? invalidatePage() : null;
    let invalidated = false;
    let timer;
    try {
      if (target.runProjectId) {
        const pending = sendBackgroundNative({ method: 'mirror.invalidate', params: { projectId: target.runProjectId } });
        // A rejection after the bound has nobody left to observe it.
        pending.catch(() => {});
        const response = options.nativeTimeoutMs
          ? await Promise.race([
            pending,
            new Promise(resolve => {
              timer = setTimeout(() => resolve(null), options.nativeTimeoutMs);
            })
          ])
          : await pending;
        invalidated = response?.ok === true && response.result?.invalidated === true;
      }
    } catch (_error) { /* An unavailable host cannot acknowledge invalidation. */ }
    finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const pageInvalidated = await (pageInvalidation || invalidatePage());
    if (invalidated && pageInvalidated) return 'not-attempted';
    if (target.runProjectId) mirrorReuseFences.set(target.runProjectId, { syncAttempted: false });
    const event = {
      title: tx('The local project cache could not be reset. Check the local connection before starting another task.',
        '本地项目缓存未能重置。请检查本地连接后再开始下一轮任务。'),
      status: 'warning'
    };
    if (target.recordId) appendRunRecordEvent(target.recordId, event);
    else appendRunEvent(event);
    return 'failed';
  }

  // Text-only confirmation requires the page's verified post-image digest.
  // Local files can change after writeback; Native must match those digests
  // before advancing its baseline. Missing evidence and non-text/tree writes
  // retain the authoritative ZIP fallback below.

  async function tryConfirmMirrorWriteback(applied, runProjectId) {
    try {
      if (!runProjectId || getCurrentProjectId() !== runProjectId) return false;
      const proof = await writebackController.buildMirrorWritebackConfirmation?.(applied);
      if (!proof || getCurrentProjectId() !== runProjectId) return false;
      const response = await sendBackgroundNative({
        method: 'mirror.confirmWriteback',
        params: {
          projectId: runProjectId,
          ...proof
        }
      });
      const confirmations = Array.isArray(response?.result?.confirmed) ? response.result.confirmed : [];
      const confirmed = new Map(confirmations.map(file => [file?.path, file?.hash]));
      return getCurrentProjectId() === runProjectId && response?.ok === true && response?.result?.ok === true
        && confirmations.length === proof.expectedFiles.length
        && confirmed.size === proof.expectedFiles.length
        && proof.expectedFiles.every(file => confirmed.get(file.path) === file.sha256);
    } catch (error) {
      return false;
    }
  }

  async function refreshProjectMirrorAfterWriteback(project = {}, applied = {}, saveVerification = {}, confirmation = {}) {
    const target = confirmation.target || {};
    const mirrorFence = getMirrorReuseFence(target.runProjectId);
    if (saveVerification?.state !== 'verified_saved') {
      return invalidateWritebackMirror(target);
    }
    if (!Array.isArray(applied?.applied) || !applied.applied.length) {
      return 'not-attempted';
    }

    if (!confirmation.snapshot && await tryConfirmMirrorWriteback(applied, target.runProjectId)) {
      appendRunEvent({
        title: tx(
          'Local Codex workspace confirmed in place (no project re-download needed). The next run starts from the latest content.',
          '本地 Codex workspace 已就地确认（无需重新下载项目），下一轮将从最新内容开始。'
        ),
        status: 'completed'
      });
      return 'complete';
    }

    appendRunEvent({
      title: tx('Checking latest Overleaf content and refreshing the local Codex workspace.', '正在确认 Overleaf 最新内容，并刷新本地 Codex workspace。'),
      status: 'running'
    });

    if (!target.runProjectId || getCurrentProjectId() !== target.runProjectId) return invalidateWritebackMirror(target);
    if (!confirmation.snapshot) await callPageBridge('invalidateProjectSnapshot', {
      runProjectId: target.runProjectId,
      invalidateFileList: true
    });
    const freshProject = confirmation.snapshot || sanitizeRunProjectSnapshot(await callPageBridge('getProjectSnapshot', {
      runProjectId: target.runProjectId,
      force: true,
      maxAgeMs: 0,
      preferLightweight: true,
      allowZipFallback: true,
      allowEditorNavigation: false,
      requireFullProject: true,
      includeBinaryFiles: true,
      zipOnly: true,
      zipTimeoutMs: RUN_SNAPSHOT_ZIP_TIMEOUT_MS,
      focusFiles: getAppliedOperationPaths(applied)
    }));
    if (getCurrentProjectId() !== target.runProjectId || freshProject?.id !== target.runProjectId
      || !freshProject?.files?.length || freshProject?.capabilities?.fullProjectSnapshot === false
      || freshProject?.capabilities?.skipped?.length) {
      return invalidateWritebackMirror(target);
    }

    const syncedProject = confirmation.snapshot || mergeVerifiedAppliedFiles(freshProject, project, applied);
    resetContextProject();
    const response = await sendBackgroundNative({
      method: 'mirror.sync',
      params: {
        projectId: target.runProjectId,
        project: syncedProject
      }
    });
    if (response?.ok) {
      await settleFullMirrorSync(target.runProjectId, syncedProject, mirrorFence, response);
      appendRunEvent({
        title: tx('Local Codex workspace refreshed. The next run will start from the latest Overleaf content.', '已刷新本地 Codex workspace，下一轮会从最新 Overleaf 内容开始。'),
        status: 'completed'
      });
      return 'complete';
    }

    return invalidateWritebackMirror(target);
  }

  function mergeVerifiedAppliedFiles(freshProject = {}, originalProject = {}, applied = {}) {
    return writebackController.mergeVerifiedAppliedFiles(freshProject, originalProject, applied);
  }

  function appendUnsupportedLocalChanges(changes = []) {
    if (!changes.length) {
      return;
    }
    appendRunEvent({
      title: formatUnsupportedLocalChangeSummary(changes),
      status: 'completed'
    });
  }

  function formatUnsupportedLocalChangeSummary(changes = []) {
    return writebackController.formatUnsupportedLocalChangeSummary(changes, getLocale());
  }

  const serverProvenSave = verification => ['overleaf-zip', 'server-receipts'].includes(verification?.source);

  async function autoRecompileAfterWriteback(writtenPaths = [], saveVerification = {}, options = {}) {
    if (options.autoRecompile === false
      || (options.autoRecompile === undefined && getState().autoRecompile === false)) return null;
    if ((options.mode || getState().mode) === 'ask') return null;

    const CompileAdapter = compileAdapter;
    if (!CompileAdapter) return null;

    const hasCompilableFile = writtenPaths.some(filePath => CompileAdapter.isCompilableFile(filePath));
    if (!hasCompilableFile) return null;

    const compileActivityId = 'overleaf-compile:' + Date.now().toString(36);
    const activity = (state, output = '') => ({ v: 1, kind: 'compile', id: compileActivityId, state, target: 'Overleaf', output });
    appendRunEvent({
      activity: activity('running'),
      title: saveVerification?.state !== 'verified_saved'
        ? tx(
          'Post-write compile: Overleaf save was not verified, but Auto Compile is on. Triggering Overleaf Recompile and letting Overleaf wait for the latest save.',
          '正在写后编译：尚未确认 Overleaf 已保存，但已开启自动编译；将触发 Overleaf Recompile，并由 Overleaf 等待最新保存。'
        )
        : tx(
          'Post-write compile: LaTeX files were written, triggering Overleaf Recompile.',
          '正在写后编译：已写入 LaTeX 文件，正在触发 Overleaf Recompile。'
        ),
      status: 'running'
    });

    try {
      const result = await callPageBridge('triggerCompile', {
        preferUiClick: true,
        // Server-side proof (ZIP or save receipts) already settles the save; don't also demand the UI indicator.
        waitForSaveMs: serverProvenSave(saveVerification) ? 0 : 5000,
        requireVerifiedSave: saveVerification?.state === 'verified_saved' && !serverProvenSave(saveVerification),
        runProjectId: options.runProjectId || getCurrentRunView()?.runProjectId || getCurrentProjectId()
      });
      if (result?.ok) {
        let logResult = null;
        try {
          logResult = await callPageBridge('getCompileLog', {
            captureId: result.compile?.captureId,
            triggerIfStale: false,
            maxAgeMs: 30000,
            waitForSaveMs: 0,
            runProjectId: options.runProjectId || getCurrentRunView()?.runProjectId || getCurrentProjectId()
          });
        } catch (error) {
          logResult = { ok: false, reason: error.message || 'compile_log_fetch_failed' };
        }
        const compile = compileAdapter.buildPostWriteCompileSummary({ result, logResult });
        compile.errors = compile.errors.map(value => CompileAdapter.localizeCompileReason(value, getLocale()));
        if (compile?.status === 'success') {
          appendRunEvent({ title: tx('Compile succeeded.', '编译成功。'), status: 'completed',
            activity: activity('completed', [...(logResult?.errors || []), ...(logResult?.warnings || [])].slice(0, 5).map(CompileAdapter.formatCompileDiagnosticForSummary).join('\n')) });
        } else if (compile?.status === 'triggered') {
          appendRunEvent({ title: tx('Overleaf compile was triggered. The page will continue showing progress.', '已触发 Overleaf 编译；页面会继续显示编译进度。'), status: 'completed', activity: activity('triggered', compile.reason) });
        } else {
          appendRunEvent({ title: compile.status === 'unconfirmed' ? tr('runCompileUnconfirmed')
            : tx(`Compile finished with status: ${compile.status}`, `编译完成，状态：${compile.status}`),
            status: 'completed', activity: activity(compile.status === 'failed' ? 'failed' : 'unknown', compile.errors.join('\n') || compile.reason) });
        }
        return compile;
      } else {
        const reason = CompileAdapter.localizeCompileReason(result?.reason, getLocale()) || tx('unknown reason', '未知原因');
        appendRunEvent({ title: tx(`Post-write compile did not succeed: ${reason}`, `写后编译未成功：${reason}`), status: 'failed', activity: activity('failed', reason) });
        return compileAdapter.buildPostWriteCompileSummary({ result });
      }
    } catch (error) {
      const reason = CompileAdapter.localizeCompileReason(error.message, getLocale());
      appendRunEvent({ title: tx(`Post-write compile failed: ${reason}`, `写后编译出错：${reason}`), status: 'failed', activity: activity('failed', reason) });
      return compileAdapter.buildPostWriteCompileSummary({ error });
    }
  }

  // Use the same normalized failure selection as settlement and its UI, while
  // preserving the selected producer's full evidence on the historical report.
  function promoteWritebackSkippedFailure(applied) {
    const failures = writebackSettlement.collectFailuresFromResult(applied);
    return writebackSettlement.selectPrimaryFailure(failures);
  }

  function appendCompileSummaryToConclusion(conclusion, compileSummary) {
    if (!compileSummary) {
      return conclusion;
    }
    const errors = compileSummary.errors || [];
    const warnings = compileSummary.warnings || [];
    let summary;
    if (errors.length) {
      summary = tx(
        `Post-write compile check: ${errors.length} remaining error(s): ${errors.slice(0, 3).join('; ')}`,
        `写后编译检查：仍有 ${errors.length} 个错误：${errors.slice(0, 3).join('；')}`
      );
    } else if (compileSummary.status === 'success') {
      summary = warnings.length
        ? tx(
          `Post-write compile check succeeded with ${warnings.length} warning(s).`,
          `写后编译检查已通过，但仍有 ${warnings.length} 个警告。`
        )
        : tx('Post-write compile check succeeded with no reported errors.', '写后编译检查已通过，未发现错误。');
    } else if (compileSummary.status === 'triggered') {
      summary = warnings.length
        ? tx(
          `Post-write compile was triggered; latest log shows ${warnings.length} warning(s).`,
          `已触发写后编译；最新日志显示 ${warnings.length} 个警告。`
        )
        : tx('Post-write compile was triggered; Overleaf may still be updating the result.', '已触发写后编译；Overleaf 可能仍在更新结果。');
    } else if (compileSummary.status === 'unconfirmed') {
      summary = tr('runCompileUnconfirmed');
    } else if (compileSummary.status === 'failed') {
      const reason = compileAdapter.localizeCompileReason(compileSummary.reason, getLocale());
      summary = tx(
        `Post-write compile check failed: ${reason || 'unknown reason'}`,
        `写后编译检查失败：${reason || '未知原因'}`
      );
    } else {
      summary = tx(
        `Post-write compile finished with status: ${compileSummary.status || 'unknown'}.`,
        `写后编译完成，状态：${compileSummary.status || '未知'}。`
      );
    }
    return [conclusion, '', summary].filter(Boolean).join('\n');
  }


  async function resolveCompileLogContext() {
    try {
      const result = await callPageBridge('getCompileLog', {
        triggerIfStale: true,
        maxAgeMs: 30000,
        waitForSaveMs: 5000,
        runProjectId: getCurrentRunView()?.runProjectId || getCurrentProjectId()
      });

      if (!result?.ok) {
        return { type: 'compile-log', available: false, reason: result?.reason || 'Could not get compile log' };
      }

      return {
        type: 'compile-log',
        available: true,
        log: result.log,
        errors: result.errors || [],
        warnings: result.warnings || [],
        compiledAt: result.compiledAt,
        fresh: result.fresh
      };
    } catch (error) {
      return { type: 'compile-log', available: false, reason: error.message };
    }
  }

  function create(deps = {}) {
    ({
      tr,
      tx,
      getLocale,
      appendRunEvent,
      appendRunRecordEvent,
      appendChangeSummary,
      appendCompletionReport,
      appendOperationsPreview,
      appendPartialWritebackWarning,
      appendApplyResult,
      renderReadOnlyDiffReview,
      showPluginConfirm,
      callPageBridge,
      sendBackgroundNative,
      getCurrentProjectId,
      resetContextProject,
      sanitizeRunProjectSnapshot,
      getAssistantAnswerForCurrentRun,
      cleanFinalAnswer,
      recordUndoFromApply,
      getSkippedEntries,
      getAppliedOperationPaths,
      hasApplyResultEntries,
      getAppliedSyncChanges,
      mergeApplyResultSkipped,
      hasSkippedApplyOperations,
      formatWritebackSkippedNextStep,
      formatOperationFiles,
      summarizeOperationForAudit,
      buildAuditSummaryFromApply,
      buildSyncApplyOperations,
      partitionUnsafeProjectPathOperations,
      evaluateGovernedOperations,
      buildGovernanceSkippedApplyResult,
      buildReviewingBlockedApplyResult,
      ensureReviewingBeforeWrite,
      confirmBinaryOperations,
      filterSyncChangesByOperations,
      writebackController,
      RUN_SNAPSHOT_ZIP_TIMEOUT_MS,
      getState,
      getCurrentRunView,
    } = deps);
    assetTransferBroker = deps.assetTransferBroker;
    stageWritebackRecovery = deps.stageWritebackRecovery;
    settleWritebackRecovery = deps.settleWritebackRecovery;
    onMirrorRefreshSettled = deps.onMirrorRefreshSettled;
    writebackSettlement = deps.writebackSettlement;
    compileAdapter = deps.compileAdapter;
    return {
      applySyncChangesToOverleaf,
      resolveCompileLogContext,
      invalidateMirrorAfterUndo,
      getMirrorReuseFence,
      syncFencedMirror,
      getPendingMirrorRefresh: () => pendingMirrorRefresh
    };
  }

  window.CodexOverleafWritebackOrchestrator = { create };
})();
