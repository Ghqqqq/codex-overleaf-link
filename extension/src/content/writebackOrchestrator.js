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
    const withheldOnly = unsupportedChanges.filter(change => ['subagent_unfinished_output', 'subagent_unauthorized_edit'].includes(change.reason));
    if (runMode !== 'ask' && !syncChanges.length && withheldOnly.length) {
      const skipped = withheldOnly.map(change => ({ operation: { type: 'create', path: change.path }, result: {
        ok: false, code: change.reason, changedDocument: false,
        reason: writebackController.formatUnsupportedLocalChangeReason(change, getLocale())
      } }));
      const applied = { ok: false, applied: [], skipped };
      appendCompletionReport({ conclusion: assistantMessage || tx('Some generated files still need review.', '部分生成文件仍需核对。'),
        status: 'failed', operations: [], applyResults: [applied], mode: runMode,
        nextStep: tx('The main agent must review and adopt the withheld files before syncing them.', '主代理需核对并接管未同步文件后再写回。') });
      return { summaryLine: tx('Generated files are awaiting review.', '生成文件待核对。'), hasSkippedOperations: true,
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
      appendCompletionReport({
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
    let additionalSkippedEntries = [];
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
      appendRunEvent({
        title: tx('Codex did not produce file changes that need to sync back to Overleaf.', 'Codex 没有产生需要同步回 Overleaf 的文件改动。'),
        status: 'completed'
      });
      appendCompletionReport({
        conclusion: assistantMessage || tx('Codex finished locally. There are no changes to sync back to Overleaf.', 'Codex 已完成本地处理，没有需要同步回 Overleaf 的改动。'),
        status: runMode === 'ask' ? tr('modeAsk') : 'completed',
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
        settlement: buildSettlement({
          operations: buildSyncApplyOperations(syncChanges, project),
          applyResult: {
            ok: additionalSkippedEntries.length === 0,
            applied: [],
            skipped: additionalSkippedEntries
          }
        }),
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
      appendRunEvent({
        title: tx('No approved file changes remain to sync back to Overleaf.', '没有剩余已确认的文件改动需要同步回 Overleaf。'),
        status: 'completed'
      });
      appendCompletionReport({
        conclusion: assistantMessage || tx('No approved changes were written back to Overleaf.', '没有已确认的改动写回 Overleaf。'),
        status: runMode === 'ask' ? tr('modeAsk') : 'completed',
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
        settlement: buildSettlement({
          operations: buildSyncApplyOperations(syncChanges, project),
          applyResult: {
            ok: additionalSkippedEntries.length === 0,
            applied: [],
            skipped: additionalSkippedEntries
          }
        }),
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
      appendCompletionReport({
        conclusion: tx(
          'No files were written: Track is enabled, but Codex could not verify Overleaf Reviewing/Track Changes.',
          '这轮没有写入：已开启“留痕”要求，但 Codex 没能确认 Overleaf 正在用 Reviewing/Track Changes。'
        ),
        status: 'failed',
        operations,
        applyResults: [blocked],
        mode: runMode,
        nextStep: tx(
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
    await stageWritebackRecovery?.(operations, saveTarget, runRequireReviewing);
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
    for (const change of unsupportedChanges.filter(item => ['subagent_unfinished_output', 'subagent_unauthorized_edit'].includes(item.reason))) {
      const reason = writebackController.formatUnsupportedLocalChangeReason(change, getLocale());
      applied.skipped.push({ operation: { type: 'create', path: change.path }, result: { ok: false,
        code: change.reason, reason, changedDocument: false, failure: { code: change.reason,
          stage: 'preflight', severity: 'blocked', retryable: false, terminalState: 'blocked', changedDocument: false,
          userMessage: reason, nextAction: 'The main agent must review the withheld file before syncing it.' } } });
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
    recordUndoFromApply(project, applied);
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
    const confirmation = appliedPaths.length
      ? await verifyPostWriteSaveState(applied, project, saveTarget)
      : { verification: { ok: false, state: 'not_checked', reason: 'No applied writeback operations were returned.' } };
    const saveVerification = confirmation.verification;
    await settleWritebackRecovery?.(applied, project, saveVerification, saveTarget);
    if (appliedPaths.length) {
      appendPostWriteSaveVerificationWarning(saveVerification, saveTarget);
      appendRunEvent({ kind: 'technical', title: 'Post-write save confirmation', status: 'info', detail: saveVerification });
    }
    // v1.7.5: the mirror refresh (zip snapshot + mirror.sync, often the
    // slowest post-write step) no longer blocks the completion report. The
    // pending promise is exposed so undoRun and the next runTask barrier on
    // it — a mirror.sync landing AFTER an undo would otherwise push the
    // pre-undo snapshot as the local baseline.
    const mirrorSettlementTarget = saveTarget;
    pendingMirrorRefresh = refreshProjectMirrorAfterWriteback(project, applied, saveVerification, { target: saveTarget, snapshot: confirmation.snapshot })
      .catch(async error => {
        appendRunRecordEvent(saveTarget.recordId, { kind: 'technical', title: 'Mirror refresh requires a fresh read', status: 'info', detail: { reason: error.message } });
        return invalidateWritebackMirror(saveTarget);
      })
      .then(state => {
        if (typeof onMirrorRefreshSettled !== 'function') return;
        return onMirrorRefreshSettled({
          recordId: mirrorSettlementTarget?.recordId || '',
          sessionId: mirrorSettlementTarget?.sessionId || '',
          runProjectId: mirrorSettlementTarget?.runProjectId || '',
          state: state || 'not-attempted'
        });
      })
      .finally(() => {
        pendingMirrorRefresh = null;
      });
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
        return buildPostWriteCompileSummary({ error });
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
      applied,
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

  async function invalidateWritebackMirror(target = {}) {
    let invalidated = false;
    try {
      if (target.runProjectId) {
        const response = await sendBackgroundNative({ method: 'mirror.invalidate', params: { projectId: target.runProjectId } });
        invalidated = response?.ok === true && response.result?.invalidated === true;
      }
    } catch (_error) { /* An unavailable host cannot acknowledge invalidation. */ }
    let pageInvalidated = getCurrentProjectId() !== target.runProjectId;
    if (!pageInvalidated) {
      resetContextProject();
      try {
        const response = await callPageBridge('invalidateProjectSnapshot', { invalidateFileList: true, runProjectId: target.runProjectId });
        pageInvalidated = response?.ok === true;
      } catch (_error) { /* Leave the failure visible if both caches cannot be fenced. */ }
    }
    if (invalidated && pageInvalidated) return 'not-attempted';
    const event = {
      title: tx('The local project cache could not be reset. Check the local connection before starting another task.',
        '本地项目缓存未能重置。请检查本地连接后再开始下一轮任务。'),
      status: 'warning'
    };
    if (target.recordId) appendRunRecordEvent(target.recordId, event);
    else appendRunEvent(event);
    return 'failed';
  }

  // v1.8.0: text-only writebacks confirm the mirror in place. The written
  // content ORIGINATED in the local workspace, so after a verified writeback
  // the workspace already equals Overleaf; only the baseline hashes and
  // freshness metadata are stale. mirror.confirmWriteback re-hashes the
  // written files without re-downloading the project. Anything unusual —
  // tree ops, binary writes, dirty mirror, an older native host without the
  // method — falls back to the full zip resync below.
  const MIRROR_CONFIRMABLE_OPERATION_TYPES = new Set(['edit']);

  async function tryConfirmMirrorWriteback(applied, runProjectId) {
    const entries = Array.isArray(applied?.applied) ? applied.applied : [];
    if (!entries.length) {
      return false;
    }
    const paths = [];
    for (const entry of entries) {
      const operation = entry?.operation || {};
      if (!MIRROR_CONFIRMABLE_OPERATION_TYPES.has(operation.type) || !operation.path) {
        return false;
      }
      paths.push(operation.path);
    }
    try {
      const response = await sendBackgroundNative({
        method: 'mirror.confirmWriteback',
        params: {
          projectId: runProjectId,
          paths: Array.from(new Set(paths))
        }
      });
      return response?.ok === true && response?.result?.ok === true;
    } catch (error) {
      return false;
    }
  }

  async function refreshProjectMirrorAfterWriteback(project = {}, applied = {}, saveVerification = {}, confirmation = {}) {
    const target = confirmation.target || {};
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
            triggerIfStale: false,
            maxAgeMs: 30000,
            waitForSaveMs: 0,
            runProjectId: options.runProjectId || getCurrentRunView()?.runProjectId || getCurrentProjectId()
          });
        } catch (_error) {
          logResult = null;
        }
        const compile = result.compile;
        if (compile?.status === 'success') {
          appendRunEvent({ title: tx('Compile succeeded.', '编译成功。'), status: 'completed',
            activity: activity('completed', [...(logResult?.errors || []), ...(logResult?.warnings || [])].slice(0, 5).map(CompileAdapter.formatCompileDiagnosticForSummary).join('\n')) });
        } else if (compile?.status === 'triggered') {
          appendRunEvent({ title: tx('Overleaf compile was triggered. The page will continue showing progress.', '已触发 Overleaf 编译；页面会继续显示编译进度。'), status: 'completed', activity: activity('triggered') });
        } else {
          appendRunEvent({ title: tx(`Compile finished with status: ${compile?.status || 'unknown'}`, `编译完成，状态：${compile?.status || '未知'}`), status: 'completed', activity: activity(compile?.status === 'failed' ? 'failed' : 'unknown') });
        }
        return buildPostWriteCompileSummary({ result, logResult });
      } else {
        const reason = result?.reason || tx('unknown reason', '未知原因');
        appendRunEvent({ title: tx(`Post-write compile did not succeed: ${reason}`, `写后编译未成功：${reason}`), status: 'failed', activity: activity('failed', reason) });
        return buildPostWriteCompileSummary({ result });
      }
    } catch (error) {
      appendRunEvent({ title: tx(`Post-write compile failed: ${error.message}`, `写后编译出错：${error.message}`), status: 'failed', activity: activity('failed', error.message) });
      return buildPostWriteCompileSummary({ error });
    }
  }

  function buildPostWriteCompileSummary(input = {}) {
    return compileAdapter.buildPostWriteCompileSummary(input);
  }

  // First structured per-operation failure among the skipped writeback
  // entries — the run-level failure the completion report promotes.
  function promoteWritebackSkippedFailure(applied) {
    for (const entry of getSkippedEntries(applied)) {
      const failure = entry?.result?.failure || entry?.failure;
      if (failure?.code) {
        if (!failure.file && entry?.path) {
          return { ...failure, file: entry.path };
        }
        return failure;
      }
    }
    return null;
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
    } else if (compileSummary.status === 'failed') {
      summary = tx(
        `Post-write compile check failed: ${compileSummary.reason || 'unknown reason'}`,
        `写后编译检查失败：${compileSummary.reason || '未知原因'}`
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
      getPendingMirrorRefresh: () => pendingMirrorRefresh
    };
  }

  window.CodexOverleafWritebackOrchestrator = { create };
})();
