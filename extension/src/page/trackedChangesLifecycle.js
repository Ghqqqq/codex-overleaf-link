(function initCodexOverleafTrackedChangesLifecycle(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafTrackedChangesLifecycle = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function trackedChangesLifecycleFactory() {
  'use strict';

  // Tracked-changes lifecycle — carved out of writebackRouter.js in v1.8.0
  // (structural-debt phase 7, #117): the accept/reject flows, the
  // accept-replay + editor-undo recovery machinery, the reviewing/editing
  // blocked-result builders, and the DOM collectors for Overleaf's
  // tracked-change widgets. Code moved verbatim (original indentation kept);
  // page-side collaborators are factory-injected by writebackRouter, which
  // remains the only consumer and the owner of applyOperations itself.
  function create(deps = {}) {
    const {
      window,
      checkWritebackRunProjectId,
      buildNoTraceUndoBlockedResult,
      buildReviewingRequiredBlockedResult,
      buildEditingRequiredBlockedResult,
      compileBridge,
      applyOperationsCore,
      clickNode,
      compact,
      invalidProjectPathResult,
      isEditingConfirmedForNoTraceUndo,
      isReviewingConfirmedForWrite,
      uniqueNodes,
      normalizeTrackedChangeRefs,
      applyOperationsWithNoTraceUndo,
      applyTextPatches,
      buildPageFailure,
      delay,
      getActiveFilePath,
      getReviewingState,
      isEditorUndoControl,
      isInsideCodexPanel,
      normalizeOperationPaths,
      normalizeReviewingSignalText,
      normalizeSafeProjectPath,
      openFileByPath,
      readActiveEditorText,
      readNodeSignalText,
      setReviewingEnabled,
      summarizeReviewingToggleResult,
      verifyActiveEditorText,
      collectElements,
    } = deps;

  async function rejectTrackedChanges(params = {}) {
    // Welcome-panel + write-guard: defense-in-depth.
    // The pageBridge wrapper already runs the runProjectId guard, but a
    // future caller could reach the router directly. A missing or empty
    // `runProjectId` blocks the reject with the same shape the page-side
    // guard uses. Existing tests that target individual reject behaviors set
    // `runProjectId` on params; tests that intentionally omit it land here.
    const writeGuardBlock = checkWritebackRunProjectId(params);
    if (writeGuardBlock) return writeGuardBlock;
    const trackedChanges = normalizeTrackedChangeRefs(params.trackedChanges || []);
    const expectedFiles = Array.isArray(params.expectedFiles) ? params.expectedFiles : [];
    const postFiles = Array.isArray(params.postFiles) ? params.postFiles : [];
    const applied = [];
    const skipped = [];
    const appliedPaths = new Set();
    const invalidTrackedChange = trackedChanges.find(trackedChange => trackedChange.invalidProjectPath);
    if (invalidTrackedChange) {
      return {
        ok: false,
        applied,
        skipped: [{
          trackedChange: invalidTrackedChange,
          result: invalidProjectPathResult('tracked-change path')
        }]
      };
    }

    const editorUndo = await rejectTrackedChangesViaEditorUndo(expectedFiles, postFiles, applied);
    if (editorUndo.ok) {
      if (applied.length > 0) {
        compileBridge.markSourceEdited();
      }
      return {
        ok: true,
        applied,
        skipped
      };
    }
    const snapshotUndo = await restoreExpectedFilesWithNoTraceUndo(expectedFiles, postFiles, {
      runProjectId: params.runProjectId
    });
    if (snapshotUndo.attempted) {
      applied.push(...snapshotUndo.applied);
      skipped.push(...snapshotUndo.skipped);
      if (applied.length > 0) {
        compileBridge.markSourceEdited();
      }
      return {
        ok: skipped.length === 0,
        applied,
        skipped
      };
    }
    if (editorUndo.attempted) {
      skipped.push({
        trackedChange: null,
        result: editorUndo
      });
      if (applied.length > 0) {
        compileBridge.markSourceEdited();
      }
      return {
        ok: false,
        applied,
        skipped
      };
    }

    if (!trackedChanges.length) {
      return {
        ok: false,
        applied,
        skipped: [{
          trackedChange: null,
          result: {
            ok: false,
            code: 'missing_tracked_changes',
            reason: '这轮写入没有可识别的 Overleaf 留痕记录；为避免制造新的红线，Codex 没有执行文本补丁撤销。'
          }
        }]
      };
    }

    for (const trackedChange of orderTrackedChangesForReviewAction(trackedChanges)) {
      if (trackedChange.path && getActiveFilePath() !== trackedChange.path) {
        const opened = await openFileByPath(trackedChange.path);
        if (!opened.ok) {
          if (expectedFiles.length || trackedChange.path) {
            continue;
          }
          skipped.push({
            trackedChange,
            result: {
              ok: false,
              code: 'tracked_change_file_open_failed',
              reason: `无法打开 ${trackedChange.path} 来查找这轮写入的留痕记录；Codex 没有用文本补丁伪撤销。`
            }
          });
          continue;
        }
      }

      let node = findTrackedChangeNode(trackedChange);
      let actualTrackedChange = trackedChange;
      if (!node && trackedChange.path && appliedPaths.has(trackedChange.path)) {
        node = findNextTrackedChangeNodeForPath(trackedChange.path);
        if (node) {
          actualTrackedChange = trackedChangeRefFromNode(node, trackedChange.path);
        }
      }
      if (!node) {
        if (expectedFiles.length || trackedChange.path) {
          continue;
        }
        skipped.push({
          trackedChange,
          result: {
            ok: false,
            code: 'tracked_change_not_found',
            reason: '没有在 Overleaf 页面里找到这轮写入对应的留痕记录；Codex 没有用文本补丁伪撤销。'
          }
        });
        continue;
      }

      const rejectControl = findRejectControlForTrackedChangeNode(node);
      if (!rejectControl) {
        if (expectedFiles.length || trackedChange.path) {
          continue;
        }
        skipped.push({
          trackedChange,
          result: {
            ok: false,
            code: 'tracked_change_reject_control_not_found',
            reason: '找到了这轮写入的留痕记录，但没有找到对应的 Reject/拒绝按钮；Codex 没有用文本补丁伪撤销。'
          }
        });
        continue;
      }

      clickNode(rejectControl);
      await delay(180);

      if (findTrackedChangeNode(trackedChange)) {
        if (expectedFiles.length || trackedChange.path) {
          continue;
        }
        skipped.push({
          trackedChange,
          result: {
            ok: false,
            code: 'tracked_change_reject_not_confirmed',
            reason: 'Codex 点击了 Reject/拒绝，但 Overleaf 页面仍显示这条留痕记录；请在 Overleaf 审阅面板手动拒绝。'
          }
        });
        continue;
      }

      applied.push({
        trackedChange: actualTrackedChange,
        result: {
          ok: true,
          method: 'overleaf-review-reject'
        }
      });
      if (actualTrackedChange.path) {
        appliedPaths.add(actualTrackedChange.path);
      }
    }

    if (expectedFiles.length) {
      const completion = await rejectRemainingTrackedChangesForExpectedFiles(expectedFiles, applied);
      if (!completion.ok) {
        skipped.push({
          trackedChange: null,
          result: completion
        });
      }
    } else {
      const completion = await rejectRemainingTrackedChangesForTrackedPaths(trackedChanges, applied);
      if (!completion.ok) {
        skipped.push({
          trackedChange: null,
          result: completion
        });
      }
    }

    if (applied.length > 0) {
      compileBridge.markSourceEdited();
    }

    return {
      ok: skipped.length === 0,
      applied,
      skipped
    };
  }

  // Accept All — instead of hunting Overleaf's per-change Accept controls (which
  // is unreliable in real browser use), reuse two proven-reliable mechanisms:
  //
  //   1. Editor-undo the run's tracked writeback back to its pre-write content
  //      (the reject path's primary mechanism), which makes every one of the
  //      run's tracked changes vanish.
  //   2. Switch Overleaf to Editing mode (Track Changes OFF) and re-apply the
  //      run's post-write content as a plain, untracked edit.
  //
  // Net result: the run's new content lands as permanent, untracked text — the
  // run is decisively accepted, with no DOM-control hunting.
  //
  // If the editor-undo cannot reach the pre-write state (content drifted — e.g.
  // the user edited after the run), this bails WITHOUT re-writing so it never
  // makes the document worse, mirroring Undo's safety stance.
  async function acceptTrackedChanges(params = {}) {
    // Welcome-panel + write-guard: defense-in-depth.
    // The pageBridge wrapper already runs the runProjectId guard, but a
    // future caller could reach the router directly. A missing or empty
    // `runProjectId` blocks the accept with the same shape the page-side
    // guard uses.
    const writeGuardBlock = checkWritebackRunProjectId(params);
    if (writeGuardBlock) return writeGuardBlock;
    const expectedFiles = Array.isArray(params.expectedFiles) ? params.expectedFiles : [];
    const postFiles = Array.isArray(params.postFiles) ? params.postFiles : [];
    const applied = [];
    const skipped = [];
    // diagnostics: a per-step trace returned to the caller so the run card can
    // surface exactly what happened on each Accept All step. Each entry is
    // `{ step, info }`; the content runtime translates `step` via i18n.
    const diagnostics = [];
    const pushDiagnostic = (step, info) => {
      diagnostics.push({ step, info: info || {} });
    };

    const expectedByPath = new Map(expectedFiles
      .filter(file => file?.path && typeof file.content === 'string')
      .map(file => [normalizeSafeProjectPath(file.path), file.content])
      .filter(([path]) => path));
    const postByPath = new Map(postFiles
      .filter(file => file?.path && typeof file.content === 'string')
      .map(file => [normalizeSafeProjectPath(file.path), file.content])
      .filter(([path]) => path));
    let snapshotContextRebased = false;
    const paths = Array.from(expectedByPath.keys()).filter(path => postByPath.has(path));
    if (!paths.length) {
      return {
        ok: false,
        applied,
        skipped: [{
          trackedChange: null,
          result: {
            ok: false,
            code: 'accept_missing_run_content',
            reason: '这轮写入没有可识别的写入前/写入后内容；Codex 没有把留痕改动接受为永久文本。'
          }
        }],
        diagnostics
      };
    }

    // Step 1: editor-undo the run's tracked writeback back to its pre-write
    // content, removing every tracked change. This reuses the exact mechanism
    // the reject path relies on (its primary path).
    const appliedBeforeUndo = applied.length;
    const editorUndo = await rejectTrackedChangesViaEditorUndo(expectedFiles, postFiles, applied);
    let undoReady = editorUndo.ok === true;
    let snapshotUndo = null;
    // A page refresh preserves the run checkpoint but clears CodeMirror's
    // in-memory undo history. When the native editor undo made no progress,
    // reuse Undo's guarded snapshot path: it first verifies that every file is
    // still exactly at this run's post-write content, then restores the
    // persisted pre-write content with Track Changes disabled. The normal
    // Accept replay below can then apply the post-write patch untracked.
    if (!undoReady && applied.length === appliedBeforeUndo) {
      snapshotUndo = await restoreExpectedFilesWithNoTraceUndo(expectedFiles, postFiles, {
        runProjectId: params.runProjectId
      });
      if (snapshotUndo.ok) {
        applied.push(...snapshotUndo.applied);
        for (const file of snapshotUndo.rebasedExpectedFiles || []) {
          expectedByPath.set(file.path, file.content);
        }
        for (const file of snapshotUndo.rebasedPostFiles || []) {
          if (postByPath.get(file.path) !== file.content) {
            snapshotContextRebased = true;
          }
          postByPath.set(file.path, file.content);
        }
        undoReady = true;
      }
    }
    pushDiagnostic('editorUndo', {
      ok: undoReady,
      attempted: editorUndo.attempted === true,
      code: editorUndo.code || '',
      reason: editorUndo.reason || '',
      pathsProcessed: applied.length - appliedBeforeUndo,
      snapshotFallbackAttempted: snapshotUndo?.attempted === true,
      snapshotFallbackOk: snapshotUndo?.ok === true,
      snapshotFallbackApplied: snapshotUndo?.applied?.length || 0,
      snapshotFallbackSkipped: snapshotUndo?.skipped?.length || 0
    });
    if (!undoReady) {
      // Drift or a partial editor undo still bails. The snapshot fallback is
      // allowed only when editor undo made no progress, and its own post-state
      // verification prevents overwriting edits made after this run.
      const snapshotFailure = snapshotUndo?.skipped?.[0]?.result;
      return {
        ok: false,
        applied: snapshotUndo?.applied || [],
        skipped: snapshotUndo?.skipped?.length
          ? snapshotUndo.skipped
          : [{
            trackedChange: null,
            result: snapshotFailure || (editorUndo.attempted || editorUndo.code
              ? editorUndo
              : {
                ok: false,
                code: 'accept_editor_undo_unavailable',
                reason: '没有可执行的 Overleaf 原生撤销或安全快照回滚来清掉本轮留痕；Codex 没有接受这轮改动。'
              })
          }],
        diagnostics
      };
    }

    // Step 2: switch to Editing mode (Track Changes OFF) so the replay lands as
    // plain, untracked text.
    //
    // ensureEditing() short-circuits on isEditingConfirmedForNoTraceUndo, whose
    // "already Editing" detection is negation-based and false-positives while
    // Track Changes is actually ON (e.g. the Reviewing mode shows only as a
    // dropdown-trigger label with no active aria attribute, so reviewing is not
    // positively confirmed and a stray "Editing" menu option is read as the
    // current mode). Trusting that short-circuit replays the run while tracked.
    //
    // So do not trust the short-circuit here: read the reviewing state
    // explicitly, and if Reviewing/Track Changes is on — or Editing is not
    // positively confirmed OFF — force the toggle via setReviewingEnabled(false)
    // rather than ensureEditing's lenient path.
    const modeBefore = getReviewingState({});
    pushDiagnostic('modeBefore', summarizeReviewingStateForDiagnostics(modeBefore));
    const editingSwitch = await forceEditingForAcceptReplay();
    pushDiagnostic('forceEditing', {
      ok: editingSwitch.ok === true,
      activated: editingSwitch.activated === true,
      code: editingSwitch.code || '',
      reason: editingSwitch.reason || ''
    });
    if (!editingSwitch.ok) {
      // The undo already reverted the writeback; without a *confirmed* Editing
      // mode the replay would itself be tracked. Bail rather than re-introduce
      // tracked changes. The structured failure from forceEditingForAcceptReplay
      // (editing_not_confirmed, changedDocument:true) is preserved verbatim.
      return {
        ok: false,
        applied: [],
        skipped: [{
          trackedChange: null,
          result: {
            ok: false,
            code: editingSwitch.code || 'accept_editing_not_confirmed',
            reason: editingSwitch.reason || '无法确认 Overleaf 已切换到 Editing 模式；Codex 没有把本轮改动重写为永久文本。',
            failure: editingSwitch.failure || buildPageFailure('editing_not_confirmed', {
              changedDocument: true,
              userMessage: 'Codex could not confirm Editing mode for the untracked Accept replay, so the run was not finalized.',
              evidence: {
                originalCode: editingSwitch.code || 'accept_editing_not_confirmed',
                writeStarted: false
              }
            })
          }
        }],
        diagnostics
      };
    }
    // Tracks whether THIS flow toggled Reviewing off (either initially via
    // forceEditingForAcceptReplay, or later inside the per-op re-confirm loop).
    // The final restore only fires if this flow owned the toggle.
    let weToggledOff = editingSwitch.activated === true;
    const stableAfterSwitch = await waitForStableEditingForAcceptReplay({
      waitMs: 2400,
      intervalMs: 160
    });
    if (!stableAfterSwitch.ok) {
      return {
        ok: false,
        applied: [],
        skipped: [{
          trackedChange: null,
          result: stableAfterSwitch
        }],
        diagnostics
      };
    }

    // Step 3: re-apply each file's changed fragments as a plain edit. With
    // tracking off these land as permanent, untracked text. The replay must
    // write only the minimal changed fragments via the `patches` path of
    // applyOperationsCore — never a whole-file replaceAll, which would clobber
    // any unrelated content and produce one giant tracked change if anything
    // about the mode switch were imperfect.
    const operationsResult = buildAcceptReplayOperations(
      paths,
      expectedByPath,
      postByPath,
      snapshotContextRebased ? [] : params.appliedOperations
    );
    if (!operationsResult.ok) {
      if (weToggledOff) {
        await setReviewingEnabled(true, { waitMs: 1800 });
      }
      return {
        ok: false,
        applied: [],
        skipped: [{
          trackedChange: null,
          result: operationsResult
        }],
        diagnostics
      };
    }
    const operations = operationsResult.operations;
    // Per-op replay loop with sticky-Editing re-confirm and a short stable
    // window before every actual CodeMirror write.
    //
    // Bug C: even after forceEditingForAcceptReplay confirmed Editing once,
    // Overleaf has been observed flipping back to Reviewing between the
    // confirm and the next CodeMirror write (Overleaf-side override, per-user
    // "Track Changes for me" setting, or a positive-confirm false-positive
    // window). The fix: re-verify Editing immediately BEFORE every single
    // operation, and if Reviewing has slipped back on, force the toggle off
    // again and positively re-confirm before writing. If Editing still cannot
    // be positively confirmed after the re-toggle, bail the rest of the loop
    // so we never land a tracked write.
    let bailedReason = null;
    for (const operation of operations) {
      const opPath = operation?.path || '';
      const preState = getReviewingState({});
      const reviewingOnBefore = isReviewingConfirmedForWrite(preState);
      const editingConfirmedBefore = isEditingPositivelyConfirmed(preState);
      let reToggled = false;
      let reToggleResult = null;

      if (reviewingOnBefore || !editingConfirmedBefore) {
        reToggled = true;
        reToggleResult = await setReviewingEnabled(false, { waitMs: 1800 });
        if (reToggleResult.ok) {
          weToggledOff = true;
        }
      }

      const postToggleState = reToggled ? getReviewingState({}) : preState;
      const editingConfirmedAfter = reToggled
        ? isEditingPositivelyConfirmed(postToggleState)
        : editingConfirmedBefore;

      pushDiagnostic('replayStart', {
        path: opPath,
        isReviewingPositivelyOn: reviewingOnBefore,
        isEditingPositivelyConfirmed: editingConfirmedBefore,
        reToggled,
        reToggleOk: reToggleResult ? reToggleResult.ok === true : null,
        reToggleCode: reToggleResult?.code || '',
        editingConfirmedAfterReToggle: editingConfirmedAfter
      });

      if (!editingConfirmedAfter) {
        // Bail the rest of the loop with the existing bail semantics — never
        // land a tracked write because Editing slipped.
        const bailResult = {
          ok: false,
          code: reToggleResult?.code || 'accept_editing_not_confirmed',
          reason: reToggleResult?.reason
            || '本次操作前未能确认 Overleaf 处于 Editing 模式；为避免重写又留下留痕，Codex 没有继续重放本轮剩余改动。',
          failure: buildPageFailure('editing_not_confirmed', {
            file: opPath || '',
            operationType: 'accept-replay',
            changedDocument: true,
            userMessage: `Codex could not re-confirm Editing mode before replaying ${opPath || 'the next file'}; Codex stopped to avoid landing a tracked write.`,
            evidence: {
              originalCode: reToggleResult?.code || 'accept_editing_not_confirmed',
              reToggled,
              writeStarted: false
            }
          })
        };
        skipped.push({
          trackedChange: {
            key: `accept-replay:${opPath}`,
            id: '',
            path: opPath,
            label: 'Accept All (untracked replay)'
          },
          result: bailResult
        });
        pushDiagnostic('replayDone', {
          path: opPath,
          ok: false,
          bailed: true,
          code: bailResult.code,
          reason: bailResult.reason
        });
        bailedReason = bailResult;
        break;
      }

      const stableBeforeReplay = await waitForStableEditingForAcceptReplay({
        waitMs: reToggled ? 2400 : 1400,
        intervalMs: 160
      });
      if (!stableBeforeReplay.ok) {
        skipped.push({
          trackedChange: {
            key: `accept-replay:${opPath}`,
            id: '',
            path: opPath,
            label: 'Accept All (untracked replay)'
          },
          result: stableBeforeReplay
        });
        pushDiagnostic('replayDone', {
          path: opPath,
          ok: false,
          bailed: true,
          code: stableBeforeReplay.code,
          reason: stableBeforeReplay.reason
        });
        bailedReason = stableBeforeReplay;
        break;
      }

      const opReplay = await applyOperationsCore([operation], {
        baseFiles: [{
          path: opPath,
          content: expectedByPath.get(normalizeSafeProjectPath(opPath))
        }],
        forbidTrackedChanges: true
      });
      for (const item of opReplay.applied || []) {
        applied.push({
          trackedChange: {
            key: `accept-replay:${item.operation?.path || ''}`,
            id: '',
            path: item.operation?.path || '',
            label: 'Accept All (untracked replay)'
          },
          result: {
            ...item.result,
            method: 'overleaf-accept-untracked-replay'
          }
        });
      }
      for (const item of opReplay.skipped || []) {
        skipped.push({
          trackedChange: {
            key: `accept-replay:${item.operation?.path || ''}`,
            id: '',
            path: item.operation?.path || '',
            label: 'Accept All (untracked replay)'
          },
          result: item.result
        });
      }
      const opAppliedEntry = (opReplay.applied || [])[0];
      const opSkippedEntry = (opReplay.skipped || [])[0];
      const opResult = opAppliedEntry?.result || opSkippedEntry?.result || {};
      if (opResult.code === 'accept_replay_created_tracked_changes') {
        opResult.rollback = await rollbackAcceptReplayTrackedWrite(opPath, expectedByPath, postByPath);
      }
      pushDiagnostic('replayDone', {
        path: opPath,
        ok: opAppliedEntry ? true : false,
        verified: opResult.verified === true,
        verifiedContentLength: typeof opResult.verifiedContent === 'string'
          ? opResult.verifiedContent.length
          : null,
        trackedChangesDetected: Array.isArray(opResult.trackedChanges) ? opResult.trackedChanges.length : 0,
        rollbackOk: opResult.rollback ? opResult.rollback.ok === true : null,
        code: opResult.code || '',
        reason: opResult.reason || ''
      });
      if (!opReplay.ok) {
        bailedReason = opResult;
        break;
      }
    }

    // Step 4 intentionally does NOT restore Reviewing. Accept replay is a
    // no-trace write transaction: restoring Track Changes immediately after the
    // CodeMirror dispatch can race with Overleaf's collaboration/reviewing
    // settlement and cause the replay itself to land as fresh tracked changes.
    // Leave the editor in Editing after a successful replay; the user can turn
    // Reviewing back on manually after Overleaf has saved the accepted text.
    if (weToggledOff) {
      pushDiagnostic('restoreReviewing', {
        ok: true,
        skipped: true,
        enabled: false,
        reason: 'Accept All left Overleaf in Editing mode to avoid re-tracking the accepted replay.'
      });
    }

    if (applied.length > 0) {
      compileBridge.markSourceEdited();
    }

    return {
      ok: skipped.length === 0 && !bailedReason,
      applied,
      skipped,
      diagnostics
    };
  }

  // Summarizes a reviewing state for the per-step diagnostics. Surfaces
  // exactly the bits the user needs to diagnose a sticky-Editing slip: the
  // reviewing detector's verdict (ok/status/source), a compact controls
  // summary, and the two strict gates (isReviewingPositivelyOn /
  // isEditingPositivelyConfirmed). Self-contained — the run card can render
  // this verbatim without re-reading any page state.
  function summarizeReviewingStateForDiagnostics(state = {}) {
    const reviewing = state.reviewing || {};
    const controls = (state.signals?.controls || []).slice(0, 6).map(control => {
      const text = [control?.text, control?.innerText, control?.ariaLabel, control?.title]
        .map(value => String(value || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' | ');
      return {
        text: text.length > 80 ? text.slice(0, 77) + '...' : text,
        ariaPressed: control?.ariaPressed || '',
        ariaSelected: control?.ariaSelected || '',
        ariaCurrent: control?.ariaCurrent || ''
      };
    });
    return {
      reviewingOk: reviewing.ok === true,
      reviewingStatus: reviewing.status || '',
      reviewingSource: reviewing.source || '',
      controlsCount: (state.signals?.controls || []).length,
      controls,
      isReviewingPositivelyOn: isReviewingConfirmedForWrite(state),
      isEditingPositivelyConfirmed: isEditingPositivelyConfirmed(state)
    };
  }

  // Track Changes is positively confirmed OFF only when Editing is positively
  // detected AND Reviewing is NOT positively confirmed on. This is the strict
  // gate the Accept replay needs: it must never replay while tracked, so
  // anything short of a positive "Editing on / Reviewing off" is rejected.
  function isEditingPositivelyConfirmed(state = {}) {
    return isEditingConfirmedForNoTraceUndo(state) && !isReviewingConfirmedForWrite(state);
  }

  async function waitForStableEditingForAcceptReplay(options = {}) {
    const waitMs = Number.isFinite(Number(options.waitMs)) ? Number(options.waitMs) : 2000;
    const intervalMs = Number.isFinite(Number(options.intervalMs)) ? Number(options.intervalMs) : 160;
    const deadline = Date.now() + Math.max(0, waitMs);
    let samples = 0;
    let lastState = getReviewingState({});
    while (Date.now() <= deadline) {
      lastState = getReviewingState({});
      samples += 1;
      if (!isEditingPositivelyConfirmed(lastState)) {
        return {
          ok: false,
          code: 'accept_editing_not_stable',
          reason: 'Overleaf Editing mode did not remain stable long enough for an untracked Accept All replay; Codex did not replay this write.',
          samples,
          waitMs,
          reviewing: summarizeReviewingStateForDiagnostics(lastState)
        };
      }
      await delay(intervalMs);
    }
    return {
      ok: true,
      samples,
      waitMs
    };
  }

  async function rollbackAcceptReplayTrackedWrite(path, expectedByPath, postByPath) {
    const normalizedPath = normalizeSafeProjectPath(path);
    const expectedContent = expectedByPath.get(normalizedPath);
    const postContent = postByPath.get(normalizedPath);
    if (!normalizedPath || typeof expectedContent !== 'string' || typeof postContent !== 'string') {
      return {
        ok: false,
        code: 'accept_replay_rollback_missing_content',
        reason: 'Accept All detected fresh tracked changes, but could not roll back because the pre/post content was unavailable.'
      };
    }
    const rollbackApplied = [];
    const rollback = await rejectTrackedChangesViaEditorUndo(
      [{ path: normalizedPath, content: expectedContent }],
      [{ path: normalizedPath, content: postContent }],
      rollbackApplied
    );
    return {
      ok: rollback.ok === true,
      attempted: rollback.attempted === true,
      code: rollback.code || '',
      reason: rollback.reason || '',
      applied: rollbackApplied.length
    };
  }

  // Robustly switch Overleaf to Editing (Track Changes OFF) for the Accept
  // replay.
  //
  // Bug B root cause: the accept flow used ensureEditing, which short-circuits
  // on isEditingConfirmedForNoTraceUndo. That detector is negation-based — it
  // returns true whenever Reviewing is not *positively* confirmed-for-write
  // (which requires an active aria attribute the real Overleaf reviewing
  // control does not always carry) AND a control loosely matches an Editing
  // pattern. So while Track Changes was actually ON, it false-positived
  // "already Editing", ensureEditing returned activated:false without toggling,
  // and the replay landed as tracked changes.
  //
  // The fix here does NOT trust that lenient short-circuit: it reads the
  // reviewing state explicitly and treats Editing as confirmed only when it is
  // *positively* confirmed (Editing detected AND Reviewing not confirmed on).
  // Whenever that strict gate is not met it forces setReviewingEnabled(false),
  // then positively re-confirms Editing before returning ok; if it still cannot
  // confirm Editing it returns not-ok so the caller bails instead of replaying
  // while tracked.
  async function forceEditingForAcceptReplay() {
    const initial = getReviewingState({});
    if (isEditingPositivelyConfirmed(initial)) {
      // Positively confirmed already in Editing — no toggle needed.
      return { ok: true, activated: false };
    }

    // Reviewing is on, or Editing is not positively confirmed off. Force the
    // toggle rather than trusting ensureEditing's lenient detection.
    const switched = await setReviewingEnabled(false, { waitMs: 1800 });
    if (!switched.ok) {
      // §9.4 editing_not_confirmed: the document is at pre-write state after
      // the editor-undo succeeded; the mode toggle failed. The Accept replay
      // was rolled back so the user-visible doc state has moved from the
      // post-write tracked state back to pre-write — set changedDocument:true
      // per the design spec's "is there text the user might want to inspect"
      // contract for accept-side failures after a rollback.
      return {
        ok: false,
        code: switched.code || 'accept_editing_not_confirmed',
        reason: switched.reason || '无法确认 Overleaf 已切换到 Editing 模式；Codex 没有把本轮改动重写为永久文本。',
        failure: buildPageFailure('editing_not_confirmed', {
          changedDocument: true,
          userMessage: 'Codex could not switch Overleaf to Editing mode for the untracked Accept replay, so the run was not finalized.',
          technicalMessage: switched.reason || '',
          evidence: {
            originalCode: switched.code || 'accept_editing_not_confirmed',
            toggleAttempted: true,
            writeStarted: false
          }
        })
      };
    }

    // Positively confirm Track Changes is now off before replaying. If the
    // post-toggle state does not positively confirm Editing, bail — do not
    // replay while potentially still tracked.
    const after = getReviewingState({});
    if (!isEditingPositivelyConfirmed(after)) {
      return {
        ok: false,
        code: 'accept_editing_not_confirmed',
        reason: '切换后仍未能确认 Overleaf 处于 Editing 模式；为避免重写又留下留痕，Codex 没有重放本轮改动。',
        failure: buildPageFailure('editing_not_confirmed', {
          changedDocument: true,
          userMessage: 'Codex toggled Overleaf to Editing, but the post-toggle state did not positively confirm Editing — Codex did not replay the run.',
          evidence: {
            originalCode: 'accept_editing_not_confirmed',
            toggleAttempted: true,
            writeStarted: false
          }
        })
      };
    }

    return { ok: true, activated: true };
  }

  // Builds the minimal replay operations for Accept All. The replay must write
  // only the changed fragments, never a whole-file replaceAll.
  //
  // Preferred source: the run's own original forward writeback operations
  // (carrying their `patches`). After the editor-undo the document is back at
  // the pre-write content, so those patches' `expected` slices match and
  // re-apply cleanly.
  //
  // Fallback: when a path has no usable original patch operation, compute a
  // minimal pre->post diff (trim the common prefix/suffix to a single targeted
  // {from,to,insert} patch).
  function buildAcceptReplayOperations(paths, expectedByPath, postByPath, appliedOperations) {
    const patchesByPath = collectAppliedEditPatchesByPath(appliedOperations);
    const operations = [];
    for (const path of paths) {
      const preContent = expectedByPath.get(path);
      const postContent = postByPath.get(path);
      if (typeof preContent !== 'string' || typeof postContent !== 'string') {
        return {
          ok: false,
          code: 'accept_missing_run_content',
          reason: `${path} 缺少写入前/写入后内容；Codex 没有重放本轮改动。`
        };
      }

      // Preferred: re-apply the run's original forward patches verbatim.
      const originalPatches = patchesByPath.get(path);
      if (originalPatches && originalPatches.length && patchesApplyCleanly(preContent, originalPatches)) {
        operations.push({
          type: 'edit',
          path,
          patches: originalPatches,
          reason: 'Accept tracked edit (replay untracked)'
        });
        continue;
      }

      // Fallback: minimal pre->post diff trimmed to a single targeted patch.
      const diffPatch = buildMinimalDiffPatch(preContent, postContent);
      if (!diffPatch) {
        // pre === post: nothing to replay for this file.
        continue;
      }
      operations.push({
        type: 'edit',
        path,
        patches: [diffPatch],
        reason: 'Accept tracked edit (replay untracked)'
      });
    }
    return { ok: true, operations };
  }

  // Collects the per-path `patches` arrays from the run's applied edit
  // operations. Only edit operations that actually carried `patches` are
  // usable; whole-file replaceAll / verifiedContent operations are skipped so
  // the replay never falls back to a whole-file write.
  function collectAppliedEditPatchesByPath(appliedOperations) {
    const patchesByPath = new Map();
    for (const rawOperation of Array.isArray(appliedOperations) ? appliedOperations : []) {
      if (!rawOperation || rawOperation.type !== 'edit') {
        continue;
      }
      const path = typeof rawOperation.path === 'string'
        ? normalizeSafeProjectPath(rawOperation.path)
        : '';
      if (!path || !Array.isArray(rawOperation.patches) || !rawOperation.patches.length) {
        continue;
      }
      const normalized = rawOperation.patches.map(patch => ({
        from: Number(patch?.from),
        to: Number(patch?.to),
        expected: String(patch?.expected ?? ''),
        insert: String(patch?.insert ?? '')
      }));
      const existing = patchesByPath.get(path) || [];
      patchesByPath.set(path, existing.concat(normalized));
    }
    return patchesByPath;
  }

  // Confirms a patch set re-applies cleanly against the given (pre-write) text:
  // every patch range is valid and its `expected` slice matches.
  function patchesApplyCleanly(text, patches) {
    const applied = applyTextPatches(text, patches);
    return applied.ok === true;
  }

  // Computes a single targeted {from,to,insert} patch describing the pre->post
  // change by trimming the common prefix and suffix. Returns null when the two
  // strings are identical.
  function buildMinimalDiffPatch(preContent, postContent) {
    if (preContent === postContent) {
      return null;
    }
    const preLen = preContent.length;
    const postLen = postContent.length;
    let prefix = 0;
    const maxPrefix = Math.min(preLen, postLen);
    while (prefix < maxPrefix && preContent[prefix] === postContent[prefix]) {
      prefix += 1;
    }
    let suffix = 0;
    const maxSuffix = Math.min(preLen, postLen) - prefix;
    while (
      suffix < maxSuffix
      && preContent[preLen - 1 - suffix] === postContent[postLen - 1 - suffix]
    ) {
      suffix += 1;
    }
    const from = prefix;
    const to = preLen - suffix;
    return {
      from,
      to,
      expected: preContent.slice(from, to),
      insert: postContent.slice(from, postLen - suffix)
    };
  }

  async function rejectTrackedChangesViaEditorUndo(expectedFiles, postFiles, applied) {
    const expectedByPath = new Map((expectedFiles || [])
      .filter(file => file?.path && typeof file.content === 'string')
      .map(file => [normalizeSafeProjectPath(file.path), file.content])
      .filter(([path]) => path));
    const postByPath = new Map((postFiles || [])
      .filter(file => file?.path && typeof file.content === 'string')
      .map(file => [normalizeSafeProjectPath(file.path), file.content])
      .filter(([path]) => path));
    const paths = Array.from(expectedByPath.keys()).filter(path => postByPath.has(path));
    if (!paths.length) {
      return { ok: false, attempted: false };
    }

    for (const path of paths) {
      if (path && getActiveFilePath() !== path) {
        const opened = await openFileByPath(path);
        if (!opened.ok) {
          return {
            ok: false,
            attempted: false,
            code: 'tracked_change_editor_undo_open_failed',
            reason: `无法打开 ${path} 来执行 Overleaf 原生撤销。`
          };
        }
      }

      const postContent = postByPath.get(path);
      const postReady = await waitForActiveEditorExpectedText(path, postContent, 2500);
      if (!postReady.ok) {
        return {
          ok: false,
          attempted: false,
          code: 'tracked_change_editor_undo_current_mismatch',
          reason: `${path} 当前内容已经不是本轮写入后的内容；为避免撤掉你的后续修改，Codex 不使用 Overleaf 原生撤销。`
        };
      }

      const result = await undoEditorHistoryUntilContent(expectedByPath.get(path), path);
      if (!result.ok) {
        return result;
      }
      applied.push({
        trackedChange: {
          path,
          key: `editor-undo:${path}`,
          id: '',
          label: `Overleaf editor undo (${result.clicks} step${result.clicks === 1 ? '' : 's'})`
        },
        result: {
          ok: true,
          method: 'overleaf-editor-undo',
          undoClicks: result.clicks,
          // undoEditorHistoryUntilContent returns ok only after the active
          // editor exactly matches this run's pre-write checkpoint. Preserve
          // that proof for the content-side lifecycle settlement.
          verified: true,
          verifiedContent: expectedByPath.get(path)
        }
      });
    }

    return { ok: true, attempted: true };
  }

  async function restoreExpectedFilesWithNoTraceUndo(expectedFiles, postFiles, options = {}) {
    const expectedByPath = new Map((expectedFiles || [])
      .filter(file => file?.path && typeof file.content === 'string')
      .map(file => [normalizeSafeProjectPath(file.path), file.content])
      .filter(([path]) => path));
    const postByPath = new Map((postFiles || [])
      .filter(file => file?.path && typeof file.content === 'string')
      .map(file => [normalizeSafeProjectPath(file.path), file.content])
      .filter(([path]) => path));
    const paths = Array.from(expectedByPath.keys()).filter(path => postByPath.has(path));
    const rebasedExpectedByPath = new Map();
    const rebasedPostByPath = new Map();
    if (!paths.length) {
      return {
        ok: false,
        attempted: false,
        applied: [],
        skipped: [],
        rebasedExpectedFiles: [],
        rebasedPostFiles: []
      };
    }

    for (const path of paths) {
      if (path && getActiveFilePath() !== path) {
        const opened = await openFileByPath(path);
        if (!opened.ok) {
          return {
            ok: false,
            attempted: false,
            applied: [],
            skipped: [],
            code: 'snapshot_undo_open_failed',
            reason: `无法打开 ${path} 来执行快照撤销。`
          };
        }
      }
      const ready = await waitForActiveEditorCheckpoint(
        path,
        expectedByPath.get(path),
        postByPath.get(path),
        1500
      );
      if (!ready.ok) {
        return {
          ok: false,
          attempted: false,
          applied: [],
          skipped: [],
          rebasedExpectedFiles: [],
          rebasedPostFiles: [],
          code: 'snapshot_undo_current_mismatch',
          reason: `${path} 当前内容已经不是本轮写入后的内容；为避免覆盖你的后续修改，Codex 不执行快照撤销。`
        };
      }
      rebasedExpectedByPath.set(path, ready.expectedContent);
      rebasedPostByPath.set(path, ready.postContent);
    }

    const operations = paths.map(path => ({
      type: 'edit',
      path,
      replaceAll: rebasedExpectedByPath.get(path),
      reason: 'Undo tracked edit'
    }));
    const result = await applyOperationsWithNoTraceUndo(operations, {
      baseFiles: paths.map(path => ({
        path,
        content: rebasedPostByPath.get(path)
      })),
      runProjectId: typeof options.runProjectId === 'string' ? options.runProjectId : ''
    });
    const toTrackedResult = item => ({
      trackedChange: {
        key: `snapshot-undo:${item.operation?.path || ''}`,
        id: '',
        path: item.operation?.path || '',
        label: 'No-trace snapshot undo'
      },
      result: item.result
    });
    return {
      ok: !(result.skipped || []).length,
      attempted: true,
      applied: (result.applied || []).map(toTrackedResult),
      skipped: (result.skipped || []).map(toTrackedResult),
      rebasedExpectedFiles: paths.map(path => ({
        path,
        content: rebasedExpectedByPath.get(path)
      })),
      rebasedPostFiles: paths.map(path => ({
        path,
        content: rebasedPostByPath.get(path)
      }))
    };
  }

  async function waitForActiveEditorCheckpoint(filePath, expectedContent, postContent, timeoutMs) {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    let actual = readActiveEditorText();
    while (Date.now() < deadline) {
      const activeFileMatches = !filePath || getActiveFilePath() === filePath;
      actual = readActiveEditorText();
      if (activeFileMatches) {
        const rebased = rebaseCheckpointPair(actual, expectedContent, postContent);
        if (rebased.ok) {
          return rebased;
        }
      }
      await delay(60);
    }
    return {
      ok: false,
      text: actual
    };
  }

  function rebaseCheckpointPair(actualContent, expectedContent, postContent) {
    const actual = String(actualContent ?? '');
    const expected = String(expectedContent ?? '');
    const post = String(postContent ?? '');
    if (actual === post) {
      return {
        ok: true,
        expectedContent: expected,
        postContent: post,
        prefixLength: 0,
        suffixLength: 0
      };
    }
    if (!post) {
      return { ok: false };
    }
    const matchIndex = actual.indexOf(post);
    if (matchIndex < 0 || actual.indexOf(post, matchIndex + 1) >= 0) {
      return { ok: false };
    }
    const prefix = actual.slice(0, matchIndex);
    const suffix = actual.slice(matchIndex + post.length);
    return {
      ok: true,
      expectedContent: prefix + expected + suffix,
      postContent: actual,
      prefixLength: prefix.length,
      suffixLength: suffix.length
    };
  }

  async function waitForActiveEditorExpectedText(filePath, expectedContent, timeoutMs) {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    let actual = readActiveEditorText();
    while (Date.now() < deadline) {
      const activeFileMatches = !filePath || getActiveFilePath() === filePath;
      actual = readActiveEditorText();
      if (activeFileMatches && actual === expectedContent) {
        return {
          ok: true,
          text: actual
        };
      }
      await delay(60);
    }
    actual = readActiveEditorText();
    return {
      ok: false,
      text: actual,
      activePath: getActiveFilePath()
    };
  }

  async function undoEditorHistoryUntilContent(expectedContent, path) {
    const maxClicks = 200;
    for (let clicks = 0; clicks <= maxClicks; clicks += 1) {
      if (readActiveEditorText() === expectedContent) {
        return {
          ok: true,
          attempted: clicks > 0,
          clicks
        };
      }
      if (clicks === maxClicks) {
        break;
      }

      const undoControl = findEditorUndoControl();
      if (!undoControl) {
        return {
          ok: false,
          attempted: clicks > 0,
          code: 'editor_undo_control_not_found',
          reason: `没有找到 Overleaf 编辑器自己的 Undo/撤销按钮，无法一次性撤销 ${path} 的本轮留痕。`
        };
      }

      const beforeText = readActiveEditorText();
      clickNode(undoControl);
      await waitForEditorTextProgress(beforeText, expectedContent, 1000);
      if (readActiveEditorText() === beforeText) {
        return {
          ok: false,
          attempted: clicks > 0,
          code: 'editor_undo_no_progress',
          reason: `Codex 点击了 Overleaf Undo/撤销，但 ${path} 内容没有变化。`
        };
      }
    }

    return {
      ok: false,
      attempted: true,
      code: 'editor_undo_max_iterations',
      reason: `${path} 经过多次 Overleaf 原生撤销后仍未回到本轮写入前内容，已停止以避免撤销其它修改。`
    };
  }

  async function waitForEditorTextProgress(beforeText, expectedContent, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const current = readActiveEditorText();
      if (current !== beforeText || current === expectedContent) {
        return true;
      }
      await delay(60);
    }
    return false;
  }

  async function rejectRemainingTrackedChangesForExpectedFiles(expectedFiles, applied) {
    for (const file of expectedFiles || []) {
      if (!file?.path || typeof file.content !== 'string') {
        continue;
      }
      const result = await rejectRemainingTrackedChangesForExpectedFile(file, applied);
      if (!result.ok) {
        return result;
      }
    }
    return { ok: true };
  }

  async function rejectRemainingTrackedChangesForTrackedPaths(trackedChanges, applied) {
    const paths = Array.from(new Set((trackedChanges || [])
      .map(change => normalizeSafeProjectPath(change?.path || ''))
      .filter(Boolean)));
    if (!paths.length) {
      const activePath = normalizeSafeProjectPath(getActiveFilePath());
      if (!activePath || !applied.length) {
        return { ok: true };
      }
      paths.push(activePath);
    }

    for (const path of paths) {
      const result = await rejectRemainingTrackedChangesForPath(path, applied);
      if (!result.ok) {
        return result;
      }
    }
    return { ok: true };
  }

  async function rejectRemainingTrackedChangesForPath(path, applied) {
    if (path && getActiveFilePath() !== path) {
      const opened = await openFileByPath(path);
      if (!opened.ok) {
        return {
          ok: false,
          code: 'tracked_change_file_open_failed',
          reason: `无法打开 ${path} 来继续拒绝这轮留痕记录；请在 Overleaf 审阅面板手动处理。`
        };
      }
    }

    const appliedCountBefore = applied.length;
    const maxAttempts = 200;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const node = findLastTrackedChangeNodeForPath(path);
      if (!node) {
        if (applied.length > appliedCountBefore) {
          return { ok: true };
        }
        return {
          ok: false,
          code: 'tracked_change_not_found',
          reason: '没有在 Overleaf 页面里找到这轮写入对应的留痕记录；Codex 没有用文本补丁伪撤销。'
        };
      }

      const rejectControl = findRejectControlForTrackedChangeNode(node);
      if (!rejectControl) {
        return {
          ok: false,
          code: 'tracked_change_reject_control_not_found',
          reason: `还有 ${path || '当前文件'} 的留痕记录未处理，但没有找到对应的 Reject/拒绝按钮；请在 Overleaf 审阅面板手动拒绝。`
        };
      }

      const trackedChange = trackedChangeRefFromNode(node, path);
      const beforeText = readActiveEditorText();
      clickNode(rejectControl);
      await waitForTrackedChangeRejectProgress(trackedChange, path, beforeText, 1200);
      applied.push({
        trackedChange,
        result: {
          ok: true,
          method: 'overleaf-review-reject-sweep'
        }
      });
    }

    return {
      ok: false,
      code: 'tracked_change_undo_max_iterations',
      reason: `${path || '当前文件'} 仍有未完成的留痕记录；Codex 已停止以避免误拒绝其它改动。`,
      failure: buildPageFailure('tracked_changes_remain', {
        file: path || '',
        operationType: 'reject',
        changedDocument: true,
        terminalState: 'needs_review',
        userMessage: `${path || 'The target file'} still has tracked changes after the reject sweep, so Codex stopped to avoid mis-rejecting other edits.`,
        evidence: {
          originalCode: 'tracked_change_undo_max_iterations',
          maxAttemptsReached: true,
          writeStarted: true
        }
      })
    };
  }

  async function rejectRemainingTrackedChangesForExpectedFile(file, applied) {
    const opened = await openFileByPath(file.path);
    if (!opened.ok) {
      return {
        ok: false,
        code: 'tracked_change_undo_verify_open_failed',
        reason: `撤销后无法打开 ${file.path} 验证内容；请刷新 Overleaf 后检查。`
      };
    }

    const appliedCountBefore = applied.length;
    const maxAttempts = 200;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const node = findLastTrackedChangeNodeForPath(file.path);
      if (!node) {
        const verified = await verifyActiveEditorText(file.content, file.path, 800);
        if (verified.ok) {
          return { ok: true };
        }
        const rejectedAnyForFile = applied.length > appliedCountBefore;
        return {
          ...verified,
          code: rejectedAnyForFile ? 'tracked_change_undo_verify_failed' : 'tracked_change_not_found',
          reason: rejectedAnyForFile
            ? `${file.path} 拒绝留痕后内容没有回到写入前状态；请在 Overleaf 审阅面板检查这轮修改。`
            : '没有在 Overleaf 页面里找到这轮写入对应的留痕记录；Codex 没有用文本补丁伪撤销。'
        };
      }

      const rejectControl = findRejectControlForTrackedChangeNode(node);
      if (!rejectControl) {
        return {
          ok: false,
          code: 'tracked_change_reject_control_not_found',
          reason: `还有 ${file.path} 的留痕记录未处理，但没有找到对应的 Reject/拒绝按钮；请在 Overleaf 审阅面板手动拒绝。`
        };
      }

      const trackedChange = trackedChangeRefFromNode(node, file.path);
      const beforeText = readActiveEditorText();
      clickNode(rejectControl);
      await waitForTrackedChangeRejectProgress(trackedChange, file.path, beforeText, 1200);
      applied.push({
        trackedChange,
        result: {
          ok: true,
          method: 'overleaf-review-reject-sweep'
        }
      });
    }

    return {
      ok: false,
      code: 'tracked_change_undo_max_iterations',
      reason: `${file.path} 仍有未完成的留痕记录；Codex 已停止以避免误拒绝其它改动。`,
      failure: buildPageFailure('tracked_changes_remain', {
        file: file.path || '',
        operationType: 'reject',
        changedDocument: true,
        terminalState: 'needs_review',
        userMessage: `${file.path || 'The target file'} still has tracked changes after the per-expected-file reject sweep, so Codex stopped to avoid mis-rejecting other edits.`,
        evidence: {
          originalCode: 'tracked_change_undo_max_iterations',
          maxAttemptsReached: true,
          writeStarted: true
        }
      })
    };
  }

  async function waitForTrackedChangeRejectProgress(trackedChange, path, beforeText, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const currentText = readActiveEditorText();
      if (currentText !== beforeText) {
        return true;
      }
      if (trackedChange?.key && !findTrackedChangeNode({ ...trackedChange, path })) {
        return true;
      }
      await delay(80);
    }
    return false;
  }




  function diffTrackedChangeRefs(before = [], after = []) {
    const beforeKeys = new Set((before || []).map(ref => ref.key).filter(Boolean));
    const seen = new Set();
    const added = [];
    for (const ref of after || []) {
      if (!ref?.key || beforeKeys.has(ref.key) || seen.has(ref.key)) {
        continue;
      }
      seen.add(ref.key);
      added.push(ref);
    }
    return added;
  }

  async function waitForTrackedChangeDiff(trackedBefore, paths, options = {}) {
    const waitMs = Number.isFinite(Number(options.waitMs)) ? Number(options.waitMs) : 3000;
    const intervalMs = Number.isFinite(Number(options.intervalMs)) ? Number(options.intervalMs) : 180;
    const deadline = Date.now() + Math.max(0, waitMs);
    let latest = [];
    while (Date.now() <= deadline) {
      const trackedAfter = collectTrackedChangeRefsForPaths(paths);
      latest = diffTrackedChangeRefs(trackedBefore, trackedAfter);
      if (latest.length > 0) {
        return {
          ok: true,
          trackedChanges: latest,
          waitMs
        };
      }
      await delay(intervalMs);
    }
    return {
      ok: true,
      trackedChanges: latest,
      waitMs
    };
  }

  function collectTrackedChangeRefsForPaths(paths = []) {
    const pathSet = new Set((paths || []).filter(Boolean));
    const activePath = getActiveFilePath();
    return collectTrackedChangeNodes()
      .map(node => trackedChangeRefFromNode(node, activePath))
      .filter(ref => ref.key)
      .filter(ref => !pathSet.size || !ref.path || pathSet.has(ref.path));
  }

  function collectTrackedChangeNodes() {
    const selector = [
      '[data-change-id]',
      '[data-review-id]',
      '[data-track-change-id]',
      '[data-ol-change-id]',
      '[data-path][class*="change" i]',
      '[class*="track-change" i]',
      '[class*="review-change" i]',
      '[class*="suggest" i]',
      '[aria-label*="change" i]',
      '[title*="change" i]'
    ].join(',');
    return uniqueNodes([
      ...collectElements(selector, 1200),
      ...collectElements('*', 3500).filter(isTrackedChangeNode)
    ]).filter(isTrackedChangeNode);
  }

  function isTrackedChangeNode(node) {
    if (!node || isInsideCodexPanel(node)) {
      return false;
    }
    const signal = normalizeReviewingSignalText(readNodeSignalText(node));
    const tag = (node.tagName || '').toLowerCase();
    if (tag === 'button' && /\b(?:accept|reject|decline|discard|批准|接受|拒绝|丢弃)\b/i.test(signal)) {
      return false;
    }
    if (readTrackedChangeId(node)) {
      return true;
    }
    return /\b(?:tracked change|track change|review change|suggestion|insert(?:ion)?|delet(?:e|ion)|change)\b/i.test(signal)
      || /留痕|建议|插入|删除|更改|修改/.test(signal);
  }

  function trackedChangeRefFromNode(node, fallbackPath = '') {
    const id = readTrackedChangeId(node);
    const key = id ? `id:${id}` : `sig:${compact(readNodeSignalText(node), 180)}`;
    const path = normalizeSafeProjectPath(
      node.getAttribute?.('data-path')
      || node.getAttribute?.('data-file-path')
      || node.getAttribute?.('data-doc-path')
      || fallbackPath
      || ''
    );
    return {
      key,
      id,
      path,
      label: compact(readNodeSignalText(node), 180)
    };
  }

  function readTrackedChangeId(node) {
    for (const attribute of [
      'data-change-id',
      'data-review-id',
      'data-track-change-id',
      'data-ol-change-id',
      'data-id',
      'id'
    ]) {
      const value = node.getAttribute?.(attribute) || '';
      if (value && /\b(?:change|review|track|suggest)|\d|[a-f0-9-]{8,}/i.test(value)) {
        return String(value);
      }
    }
    return '';
  }

  function orderTrackedChangesForReviewAction(refs = []) {
    return (refs || []).slice().reverse();
  }

  function findTrackedChangeNode(ref = {}) {
    const targetKey = ref.key || '';
    if (!targetKey || ref.invalidProjectPath) {
      return null;
    }
    return collectTrackedChangeNodes()
      .find(node => trackedChangeRefFromNode(node, ref.path || getActiveFilePath()).key === targetKey)
      || null;
  }

  function findNextTrackedChangeNodeForPath(path) {
    const nodes = findTrackedChangeNodesForPath(path);
    return nodes[0] || null;
  }

  function findLastTrackedChangeNodeForPath(path) {
    const nodes = findTrackedChangeNodesForPath(path);
    return nodes[nodes.length - 1] || null;
  }

  function findTrackedChangeNodesForPath(path) {
    const targetPath = normalizeSafeProjectPath(path || getActiveFilePath());
    return collectTrackedChangeNodes()
      .filter(node => {
        const ref = trackedChangeRefFromNode(node, targetPath);
        return !targetPath || !ref.path || ref.path === targetPath;
      })
  }

  function findRejectControlForTrackedChangeNode(node) {
    const scopes = [];
    let current = node;
    for (let index = 0; current && index < 6; index += 1) {
      scopes.push(current);
      current = current.parentElement;
    }

    for (const scope of scopes) {
      const candidates = scope.querySelectorAll
        ? Array.from(scope.querySelectorAll('button,[role="button"],[aria-label],[title]'))
        : [];
      const reject = candidates.find(isRejectTrackedChangeControl);
      if (reject) {
        return reject;
      }
    }
    return isRejectTrackedChangeControl(node) ? node : null;
  }

  function findEditorUndoControl() {
    return collectElements('button,[role="button"],[aria-label],[title]', 1200)
      .find(isEditorUndoControl)
      || null;
  }

  function isRejectTrackedChangeControl(node) {
    if (!node || node.disabled) {
      return false;
    }
    if (/^(true|disabled)$/i.test(node.getAttribute?.('aria-disabled') || '')) {
      return false;
    }
    const signal = normalizeReviewingSignalText(readNodeSignalText(node));
    if (/\b(?:accept|approve|apply|resolve|接受|批准|应用)\b/i.test(signal)) {
      return false;
    }
    return /\b(?:reject|decline|discard|revert|拒绝|丢弃|还原)\b/i.test(signal);
  }
    return {
      acceptTrackedChanges,
      rejectTrackedChanges,
      collectTrackedChangeRefsForPaths,
      waitForTrackedChangeDiff
    };
  }

  return { create };
});
