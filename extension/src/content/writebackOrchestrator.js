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
  // In-flight background mirror refresh (v1.7.5) — see the writeback path.
  let pendingMirrorRefresh = null;
  let appendChangeSummary;
  let appendCompletionReport;
  let appendOperationsPreview;
  let appendPartialWritebackWarning;
  let appendApplyResult;
  let renderDiffReview;
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

  function buildSettlement(input = {}) {
    return writebackSettlement?.settle instanceof Function
      ? writebackSettlement.settle(input)
      : null;
  }

  async function applySyncChangesToOverleaf(syncChanges = [], project = {}, options = {}) {
    const runMode = options.mode || getState().mode;
    const runRequireReviewing = typeof options.requireReviewing === 'boolean'
      ? options.requireReviewing
      : getState().requireReviewing === true;
    const assistantMessage = cleanFinalAnswer(options.assistantMessage || getAssistantAnswerForCurrentRun());
    const unsupportedChanges = Array.isArray(options.unsupportedChanges) ? options.unsupportedChanges : [];
    appendUnsupportedLocalChanges(unsupportedChanges);
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
          'Switch to Suggest or Auto only when you want Codex to edit files.',
          '只有希望 Codex 修改文件时，才需要切换到建议修改或自动写入。'
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

    if (runMode === 'confirm') {
      appendRunEvent({
        title: tx(
          `Local Codex produced ${operations.length} change(s). Review the diff before applying.`,
          `本地 Codex 产生了 ${operations.length} 项改动，请查看差异后确认。`
        ),
        status: 'running'
      });
      const accepted = await renderDiffReview(visibleSyncChanges);
      if (!accepted.length) {
        appendRunEvent({
          title: tx('Sync cancelled: Overleaf was not modified.', '已取消同步：Overleaf 没有被修改。'),
          status: 'completed'
        });
        appendCompletionReport({
          conclusion: tx('You cancelled syncing. Local Codex changes were not written back to Overleaf.', '你取消了同步，本地 Codex 改动没有写回 Overleaf。'),
          status: 'rejected',
          operations: [],
          applyResults: [],
          mode: runMode,
          nextStep: tx('Run the task again, or switch to Auto if you want changes synced directly.', '可以重新运行任务，或切换到自动写入后再同步。')
        });
        return {
          summaryLine: tx('Sync cancelled', '已取消同步'),
          hasSkippedOperations: additionalSkippedEntries.length > 0,
          settlement: buildSettlement({
            operations,
            applyResult: { ok: false, applied: [], skipped: additionalSkippedEntries }
          }),
          audit: buildAuditSummaryFromApply({
            operations,
            applyResults: additionalSkippedEntries.length ? [{ ok: false, applied: [], skipped: additionalSkippedEntries }] : [],
            blockedFiles: additionalSkippedEntries.map(item => summarizeOperationForAudit(item.operation, item.result, 'blocked')),
            resultStatus: 'rejected'
          })
        };
      }
      operations = buildSyncApplyOperations(accepted, project);
      const acceptedPathSafety = partitionUnsafeProjectPathOperations(operations);
      if (acceptedPathSafety.skipped.length) {
        additionalSkippedEntries.push(...acceptedPathSafety.skipped);
        operations = acceptedPathSafety.safe;
      }
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
    const applied = operations.length
      ? mergeApplyResultSkipped(await callPageBridge('applyOperations', {
        operations,
        baseFiles: project?.files || [],
        requireReviewing: runRequireReviewing,
        requireEditing: !runRequireReviewing,
        // Welcome-panel + write-guard:
        // immutable per-run project id, checked by the page-side guard
        // against `_ide.project._id` before any mutation.
        runProjectId: getCurrentRunView()?.runProjectId || ''
      }), additionalSkippedEntries)
      : mergeApplyResultSkipped({ ok: true, applied: [], skipped: [] }, additionalSkippedEntries);
    const hasConfirmedApplyResult = hasApplyResultEntries(applied);
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
    // Only probe save-state + refresh the mirror when real writes landed. A
    // zero-write run (every operation skipped) has nothing to save-verify, so
    // skip the ~5s probe and its misleading "could not verify saved" warning
    // (v1.6.2).
    const saveVerification = appliedPaths.length
      ? await verifyPostWriteSaveState()
      : {
        ok: false,
        state: 'not_checked',
        reason: 'No applied writeback operations were returned.'
      };
    if (appliedPaths.length) {
      appendPostWriteSaveVerificationWarning(saveVerification);
    }
    // v1.7.5: the mirror refresh (zip snapshot + mirror.sync, often the
    // slowest post-write step) no longer blocks the completion report. The
    // pending promise is exposed so undoRun and the next runTask barrier on
    // it — a mirror.sync landing AFTER an undo would otherwise push the
    // pre-undo snapshot as the local baseline.
    const mirrorSettlementTarget = getCurrentRunView?.();
    pendingMirrorRefresh = refreshProjectMirrorAfterWriteback(project, applied, saveVerification)
      .catch(error => {
        appendRunEvent({
          title: tx(
            `Overleaf was written, but the background workspace refresh failed: ${error.message}. The next run will reread the project.`,
            `Overleaf 已写入，但后台刷新本地 workspace 失败：${error.message}。下一轮会重新读取项目。`
          ),
          status: 'failed'
        });
        return 'failed';
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
        mode: runMode
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

  async function verifyPostWriteSaveState() {
    try {
      const result = await callPageBridge('waitForSaveState', {
        deadlineMs: 5000,
        requirePositiveSignal: true
      });
      if (result?.state === 'verified_saved') {
        return {
          ...result,
          ok: true,
          state: 'verified_saved'
        };
      }
      if (result?.ok === true && !result?.state) {
        return {
          ...result,
          ok: false,
          state: 'verified_quiet'
        };
      }
      if (result?.state === 'unknown_timeout' || result?.state === 'unavailable') {
        return {
          ...result,
          ok: false
        };
      }
      return {
        ...result,
        ok: false,
        state: 'unknown_timeout'
      };
    } catch (error) {
      return {
        ok: false,
        state: 'unavailable',
        reason: error.message
      };
    }
  }

  function appendPostWriteSaveVerificationWarning(saveVerification = {}) {
    if (saveVerification?.state === 'verified_saved') {
      return;
    }
    appendRunEvent({
      title: tx(
        'Files were written or attempted in Overleaf, but Codex could not verify that Overleaf saved them. Local mirror refresh was skipped.',
        '文件已写入或尝试写入 Overleaf，但 Codex 未能确认 Overleaf 已保存；已跳过本地 mirror 刷新。'
      ),
      status: 'warning'
    });
  }

  // v1.8.0: text-only writebacks confirm the mirror in place. The written
  // content ORIGINATED in the local workspace, so after a verified writeback
  // the workspace already equals Overleaf; only the baseline hashes and
  // freshness metadata are stale. mirror.confirmWriteback re-hashes the
  // written files without re-downloading the project. Anything unusual —
  // tree ops, binary writes, dirty mirror, an older native host without the
  // method — falls back to the full zip resync below.
  const MIRROR_CONFIRMABLE_OPERATION_TYPES = new Set(['edit']);

  async function tryConfirmMirrorWriteback(applied) {
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
          projectId: getCurrentProjectId(),
          paths: Array.from(new Set(paths))
        }
      });
      return response?.ok === true && response?.result?.ok === true;
    } catch (error) {
      return false;
    }
  }

  async function refreshProjectMirrorAfterWriteback(project = {}, applied = {}, saveVerification = {}) {
    if (saveVerification?.state !== 'verified_saved') {
      return 'not-attempted';
    }
    if (!Array.isArray(applied?.applied) || !applied.applied.length) {
      return 'not-attempted';
    }

    if (await tryConfirmMirrorWriteback(applied)) {
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

    await callPageBridge('invalidateProjectSnapshot', {
      invalidateFileList: true
    });
    const freshProject = sanitizeRunProjectSnapshot(await callPageBridge('getProjectSnapshot', {
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
    if (!freshProject?.files?.length || freshProject?.capabilities?.fullProjectSnapshot === false) {
      appendRunEvent({
        title: tx(
          'Overleaf was written, but the full project was not read. The local Codex workspace baseline was not refreshed; the next run will reread it.',
          'Overleaf 已写入，但没有读到完整项目；暂不刷新本地 Codex workspace baseline，下一轮会重新读取。'
        ),
        status: 'failed'
      });
      return 'failed';
    }

    const syncedProject = mergeVerifiedAppliedFiles(freshProject, project, applied);
    resetContextProject();
    const response = await sendBackgroundNative({
      method: 'mirror.sync',
      params: {
        projectId: getCurrentProjectId(),
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

    const message = response?.error?.message || tx('native host did not respond', 'native host 没有响应');
    appendRunEvent({
      title: tx(
        `Overleaf was written, but refreshing the local workspace failed: ${message}`,
        `Overleaf 已写入，但刷新本地 workspace 失败：${message}`
      ),
      status: 'failed'
    });
    return 'failed';
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

  async function autoRecompileAfterWriteback(writtenPaths = [], saveVerification = {}, options = {}) {
    if (options.autoRecompile === false
      || (options.autoRecompile === undefined && getState().autoRecompile === false)) return null;
    if ((options.mode || getState().mode) === 'ask') return null;

    const CompileAdapter = compileAdapter;
    if (!CompileAdapter) return null;

    const hasCompilableFile = writtenPaths.some(filePath => CompileAdapter.isCompilableFile(filePath));
    if (!hasCompilableFile) return null;

    appendRunEvent({
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
        waitForSaveMs: 5000,
        requireVerifiedSave: saveVerification?.state === 'verified_saved',
        runProjectId: getCurrentRunView()?.runProjectId || getCurrentProjectId()
      });
      if (result?.ok) {
        let logResult = null;
        try {
          logResult = await callPageBridge('getCompileLog', {
            triggerIfStale: false,
            maxAgeMs: 30000,
            waitForSaveMs: 0,
            runProjectId: getCurrentRunView()?.runProjectId || getCurrentProjectId()
          });
        } catch (_error) {
          logResult = null;
        }
        const compile = result.compile;
        if (compile?.status === 'success') {
          appendRunEvent({ title: tx('Compile succeeded.', '编译成功。'), status: 'completed' });
        } else if (compile?.status === 'triggered') {
          appendRunEvent({ title: tx('Overleaf compile was triggered. The page will continue showing progress.', '已触发 Overleaf 编译；页面会继续显示编译进度。'), status: 'completed' });
        } else {
          appendRunEvent({ title: tx(`Compile finished with status: ${compile?.status || 'unknown'}`, `编译完成，状态：${compile?.status || '未知'}`), status: 'completed' });
        }
        return buildPostWriteCompileSummary({ result, logResult });
      } else {
        const reason = result?.reason || tx('unknown reason', '未知原因');
        appendRunEvent({ title: tx(`Post-write compile did not succeed: ${reason}`, `写后编译未成功：${reason}`), status: 'failed' });
        return buildPostWriteCompileSummary({ result });
      }
    } catch (error) {
      appendRunEvent({ title: tx(`Post-write compile failed: ${error.message}`, `写后编译出错：${error.message}`), status: 'failed' });
      return buildPostWriteCompileSummary({ error });
    }
  }

  function buildPostWriteCompileSummary({ result = null, logResult = null, error = null } = {}) {
    const logAvailable = logResult?.ok === true;
    const errors = logAvailable && Array.isArray(logResult.errors)
      ? logResult.errors.slice(0, 5).map(formatCompileDiagnosticForSummary)
      : [];
    const warnings = logAvailable && Array.isArray(logResult.warnings)
      ? logResult.warnings.slice(0, 5).map(formatCompileDiagnosticForSummary)
      : [];
    if (error) {
      return {
        status: 'failed',
        reason: error?.message || 'Post-write compile failed.',
        errors,
        warnings,
        logAvailable
      };
    }
    if (!result?.ok) {
      return {
        status: 'failed',
        reason: result?.reason || 'Post-write compile did not succeed.',
        errors,
        warnings,
        logAvailable
      };
    }
    return {
      status: result.compile?.status || 'triggered',
      reason: result.reason || '',
      errors,
      warnings,
      logAvailable
    };
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

  function formatCompileDiagnosticForSummary(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > 180 ? `${text.slice(0, 179)}...` : text;
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
      appendChangeSummary,
      appendCompletionReport,
      appendOperationsPreview,
      appendPartialWritebackWarning,
      appendApplyResult,
      renderDiffReview,
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
    onMirrorRefreshSettled = deps.onMirrorRefreshSettled;
    writebackSettlement = deps.writebackSettlement;
    compileAdapter = deps.compileAdapter;
    return {
      applySyncChangesToOverleaf,
      resolveCompileLogContext,
      getPendingMirrorRefresh: () => pendingMirrorRefresh
    };
  }

  window.CodexOverleafWritebackOrchestrator = { create };
})();
