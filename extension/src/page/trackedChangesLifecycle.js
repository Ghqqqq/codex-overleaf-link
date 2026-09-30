(function initCodexOverleafTrackedChangesLifecycle(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./trackedChangeReplay'));
  } else {
    root.CodexOverleafTrackedChangesLifecycle = factory(root.CodexOverleafTrackedChangeReplay);
  }
})(typeof window !== 'undefined' ? window : globalThis, function trackedChangesLifecycleFactory(Replay) {
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
    const { buildAcceptReplayOperations, rebaseCheckpointPair } = Replay.create({
      normalizeSafeProjectPath, applyTextPatches
    });

  function nativeReviewBlocked(path, code, applied = [], requestStarted = false) {
    const reason = requestStarted
      ? 'The native review request could not be fully verified; some target changes may already be accepted. No text replay was attempted. Check Overleaf Review before retrying.'
      : 'The native tracked-change scope could not be safely isolated. No review mutation was attempted. Use Overleaf Review to handle the changes individually.';
    return { ok: false, applied, skipped: [{ trackedChange: { path }, result: {
      ok: false, code, reason, failure: {
        ...buildPageFailure('tracked_changes_remain', { file: path, operationType: 'review',
          changedDocument: requestStarted, userMessage: reason,
          evidence: { originalCode: code, writeStarted: requestStarted, acceptedCount: applied.length } }),
        // Preserve recovery instead of applying Accept's legacy partial-success policy.
        severity: 'blocked', terminalState: 'blocked'
      }
    } }] };
  }

  async function waitForNativeReview(path, refs, untracked = false) {
    const prepare = () => untracked ? prepareUntrackedUndo(path) : prepareTrackedChangeReview(path, refs);
    for (let attempt = 0; attempt < 16; attempt++) {
      const scope = prepare();
      if (scope.ok) return scope;
      await delay(150);
    }
    return prepare();
  }

  async function prepareNativeReview(params, allowUntrackedUndo = false) {
    const refs = normalizeTrackedChangeRefs(params.trackedChanges || []);
    // A configured browser adapter fails closed even while its ledger is loading.
    // Legacy adapter callers without native integration retain their original path.
    if (typeof deps.getCodeMirrorEditorView !== 'function'
      && !refs.some(ref => ref.key.startsWith('native:'))) return null;
    const untracked = allowUntrackedUndo && params.untrackedUndo === true && !refs.length;
    if (untracked) {
      const keys = files => Array.isArray(files) && files.length && files.every(file =>
        normalizeSafeProjectPath(file?.path) && typeof file.content === 'string')
        ? files.map(file => normalizeSafeProjectPath(file.path)).sort() : [];
      const before = keys(params.expectedFiles), after = keys(params.postFiles);
      if (!before.length || new Set(before).size !== before.length || JSON.stringify(before) !== JSON.stringify(after))
        return nativeReviewBlocked('', 'native_untracked_undo_checkpoint_unavailable');
    }
    const checkpoints = [...(Array.isArray(params.expectedFiles) ? params.expectedFiles : []),
      ...(Array.isArray(params.postFiles) ? params.postFiles : [])];
    const paths = [...new Set([...refs.map(ref => ref.path),
      ...checkpoints.map(file => normalizeSafeProjectPath(file?.path))])];
    if ((!refs.length && !untracked) || refs.some(ref => ref.invalidProjectPath || !ref.path) || paths.some(path => !path))
      return nativeReviewBlocked('', 'native_review_identity_unavailable');
    const files = [], deadline = Date.now() + 90000;
    for (const path of paths) {
      if (Date.now() >= deadline || checkWritebackRunProjectId(params))
        return nativeReviewBlocked(path, 'native_review_context_changed');
      if (getActiveFilePath() !== path && !(await openFileByPath(path)).ok)
        return nativeReviewBlocked(path, 'native_review_file_unavailable');
      const scope = await waitForNativeReview(path, refs, untracked);
      if (!scope.ok) return nativeReviewBlocked(path, scope.reason || 'native_review_unavailable');
      if (scope.merged) {
        const before = (params.expectedFiles || []).filter(file => file.path === path);
        const post = (params.postFiles || []).filter(file => file.path === path);
        if (scope.merged.runProjectId !== params.runProjectId || before.length !== 1 || post.length !== 1
          || before[0].content !== scope.merged.preContent || post[0].content !== scope.merged.postContent)
          return nativeReviewBlocked(path, 'native_merged_review_checkpoint_mismatch');
      }
      files.push({ path, nativeDocId: scope.nativeDocId, scope });
    }
    return { ok: true, files, refs, deadline };
  }

  function mergedReviewContextMatches(params, file, content) {
    const projectId = typeof deps.getProjectId === 'function' ? deps.getProjectId()
      : /\/project\/([^/?#]+)/.exec(window?.location?.pathname || '')?.[1];
    return Boolean(params.runProjectId && projectId === params.runProjectId
      && !checkWritebackRunProjectId(params) && getActiveFilePath() === file.path
      && readActiveEditorText() === content);
  }

  async function reviewMergedInsertion(params, file, action) {
    const path = file.path, accepting = action === 'accept';
    let scope = prepareTrackedChangeReview(path, file.scope.targets);
    if (!scope.ok || !scope.merged || scope.nativeDocId !== file.nativeDocId
      || !mergedReviewContextMatches(params, file, scope.merged.postContent))
      return nativeReviewBlocked(path, 'native_merged_review_scope_changed');
    const before = (params.expectedFiles || []).filter(item => item.path === path);
    const post = (params.postFiles || []).filter(item => item.path === path);
    if (before.length !== 1 || post.length !== 1
      || before[0].content !== scope.merged.preContent || post[0].content !== scope.merged.postContent)
      return nativeReviewBlocked(path, 'native_merged_review_checkpoint_mismatch');
    const view = deps.getCodeMirrorEditorView?.();
    if (typeof view?.dispatch !== 'function' || view.state?.doc?.toString() !== post[0].content)
      return nativeReviewBlocked(path, 'native_merged_review_editor_unavailable');

    const editing = await forceEditingForAcceptReplay();
    if (!editing.ok) return nativeReviewBlocked(path, 'native_merged_review_editing_unavailable');
    let attempted = false;
    try {
      const stable = await waitForStableEditingForAcceptReplay({ waitMs: 1400, intervalMs: 160 });
      scope = prepareTrackedChangeReview(path, file.scope.targets);
      if (!stable.ok || !scope.ok || !scope.merged || scope.nativeDocId !== file.nativeDocId
        || !mergedReviewContextMatches(params, file, post[0].content)
        || deps.getCodeMirrorEditorView?.() !== view || view.state.doc.toString() !== post[0].content)
        return nativeReviewBlocked(path, 'native_merged_review_scope_changed');

      // A same-text replacement is deliberate: plain Editing removes tracking
      // only from these exact inserted slices, without a transient text rollback.
      // Never send a merged parent's ID to the whole-change Accept endpoint.
      const changes = scope.merged.ranges.map(range => ({
        from: range.start, to: range.end,
        insert: accepting ? post[0].content.slice(range.start, range.end) : ''
      }));
      const expectedText = accepting ? post[0].content : before[0].content;
      const expectedKeys = accepting ? scope.merged.preservedKeys : scope.merged.beforeKeys;
      attempted = true;
      view.dispatch({ changes });
      compileBridge.markSourceEdited();

      const until = Math.min(file.deadline || Date.now() + 8000, Date.now() + 8000);
      let matchingSince = null;
      while (Date.now() <= until) {
        if (!mergedReviewContextMatches(params, file, expectedText))
          return nativeReviewBlocked(path, 'native_merged_review_content_or_context_changed', [], true);
        const after = prepareTrackedChangeCapture(path);
        const matches = after.ready && after.source === 'native' && after.nativeDocId === file.nativeDocId
          && JSON.stringify(after.refs.map(ref => ref.key).sort()) === JSON.stringify(expectedKeys);
        if (matches) {
          if (matchingSince === null) matchingSince = Date.now();
          if (Date.now() - matchingSince >= 500) {
            return { ok: true, verified: true, applied: scope.targets.map(trackedChange => ({
              trackedChange, result: { ok: true, verified: true, verifiedContent: expectedText,
                method: accepting ? 'overleaf-accept-untracked-replay' : 'overleaf-merged-insertion-undo',
                preservedTrackedChanges: true }
            })), skipped: [] };
          }
        } else matchingSince = null;
        await delay(150);
      }
      return nativeReviewBlocked(path, 'native_merged_review_not_verified', [], true);
    } catch (_error) {
      return nativeReviewBlocked(path, 'native_merged_review_interrupted', [], attempted);
    } finally {
      // Match the existing no-trace Accept policy: do not re-enable tracking
      // while an untracked operation can still be awaiting its server flush.
      if (!attempted && editing.activated) await setReviewingEnabled(true, { waitMs: 1800 });
    }
  }

  async function rejectPlanWithMergedInsertions(params, plan) {
    const mixed = plan.files.find(file => !file.scope.merged && file.scope.unrelated.length);
    if (mixed) return nativeReviewBlocked(mixed.path, 'native_reject_mixed_changes');
    const applied = [];
    for (const file of plan.files) {
      if (Date.now() >= plan.deadline || checkWritebackRunProjectId(params))
        return nativeReviewBlocked(file.path, 'native_review_context_changed', applied, applied.length > 0);
      if (getActiveFilePath() !== file.path && !(await openFileByPath(file.path)).ok)
        return nativeReviewBlocked(file.path, 'native_review_file_unavailable', applied, applied.length > 0);
      const scoped = { ...params,
        trackedChanges: plan.refs.filter(ref => ref.path === file.path),
        expectedFiles: (params.expectedFiles || []).filter(item => item.path === file.path),
        postFiles: (params.postFiles || []).filter(item => item.path === file.path)
      };
      const result = file.scope.merged
        ? await reviewMergedInsertion(scoped, { ...file, deadline: plan.deadline }, 'reject')
        : await rejectTrackedChanges(scoped);
      applied.push(...(result.applied || []));
      if (!result.ok) return { ...result, applied };
    }
    return { ok: true, applied, skipped: [] };
  }

  async function acceptNativeReview(params, plan) {
    const applied = [];
    let token = window?.document?.querySelector?.('meta[name="ol-csrfToken"]')?.getAttribute('content');
    try { token = JSON.parse(token); } catch (_error) { /* Older pages expose plain text. */ }
    if (typeof token !== 'string' || !token || token.length > 4096
      || typeof window?.fetch !== 'function' || typeof window?.AbortController !== 'function')
      return nativeReviewBlocked('', 'native_accept_transport_unavailable');
    // History-OT uses snapshot-range operations, not the classic ID endpoint.
    // An unsupported engine must never fall through to text undo/replay.
    const unsupported = plan.files.find(file => !file.scope.acceptByIdSupported);
    if (unsupported) return nativeReviewBlocked(unsupported.path, 'native_accept_protocol_unsupported');
    for (const file of plan.files) {
      const path = file.path;
      if (Date.now() >= plan.deadline || checkWritebackRunProjectId(params))
        return nativeReviewBlocked(path, 'native_review_context_changed', applied, applied.length > 0);
      if (getActiveFilePath() !== path && !(await openFileByPath(path)).ok)
        return nativeReviewBlocked(path, 'native_review_file_unavailable', applied, applied.length > 0);
      if (file.scope.merged) {
        const result = await reviewMergedInsertion(params, { ...file, deadline: plan.deadline }, 'accept');
        applied.push(...(result.applied || []));
        if (!result.ok) return { ...result, applied };
        continue;
      }
      await waitForNativeReview(path, plan.refs);
      const scope = prepareTrackedChangeReview(path, plan.refs), text = readActiveEditorText();
      if (!scope.ok || !scope.acceptByIdSupported || scope.nativeDocId !== file.nativeDocId
        || typeof text !== 'string' || Date.now() >= plan.deadline || checkWritebackRunProjectId(params))
        return nativeReviewBlocked(path, 'native_review_scope_changed', applied, applied.length > 0);
      const preserved = JSON.stringify(scope.unrelated.map(ref => ref.key).sort()), ids = new Set(scope.ids);
      const controller = new window.AbortController();
      const timer = window.setTimeout(() => controller.abort(), Math.min(12000, Math.max(1, plan.deadline - Date.now())));
      try {
        // Same ID-scoped endpoint and CSRF header used by Overleaf's RangesProvider.
        const response = await window.fetch('/project/' + encodeURIComponent(params.runProjectId)
          + '/doc/' + encodeURIComponent(scope.nativeDocId) + '/changes/accept', {
          method: 'POST', credentials: 'same-origin', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Csrf-Token': token },
          body: JSON.stringify({ change_ids: scope.ids })
        });
        if (!response.ok) return nativeReviewBlocked(path, 'native_accept_http_' + response.status, applied, true);
      } catch (_error) {
        return nativeReviewBlocked(path, 'native_accept_request_unconfirmed', applied, true);
      } finally { window.clearTimeout(timer); }
      let verified = false;
      const until = Math.min(plan.deadline, Date.now() + 8000);
      while (Date.now() < until) {
        if (checkWritebackRunProjectId(params) || getActiveFilePath() !== path || readActiveEditorText() !== text)
          return nativeReviewBlocked(path, 'native_accept_content_or_context_changed', applied, true);
        const after = prepareTrackedChangeCapture(path);
        if (after.source === 'native' && after.ready && after.nativeDocId === scope.nativeDocId) {
          if (JSON.stringify(after.refs.filter(ref => !ids.has(ref.id)).map(ref => ref.key).sort()) !== preserved)
            return nativeReviewBlocked(path, 'native_accept_unrelated_changes_changed', applied, true);
          if (!after.refs.some(ref => ids.has(ref.id))) { verified = true; break; }
        }
        await delay(150);
      }
      if (!verified) return nativeReviewBlocked(path, 'native_accept_not_verified', applied, true);
      applied.push(...scope.targets.map(trackedChange => ({ trackedChange,
        result: { ok: true, method: 'overleaf-native-accept', verified: true } })));
    }
    return { ok: true, verified: true, applied, skipped: [] };
  }

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

    const nativeReview = await prepareNativeReview(params, true);
    if (nativeReview && !nativeReview.ok) return nativeReview;
    if (nativeReview?.files.some(file => file.scope.merged))
      return rejectPlanWithMergedInsertions(params, nativeReview);
    const mixedFile = nativeReview?.files.find(file => file.scope.unrelated.length);
    if (mixedFile) return nativeReviewBlocked(mixedFile.path, 'native_reject_mixed_changes');
    if (params.untrackedUndo === true && !trackedChanges.length) {
      if (!nativeReview) return nativeReviewBlocked('', 'native_review_unavailable');
      // An ordinary write has no owned editor-history entry. Restore its
      // checkpoint directly; global Undo may belong to an earlier user edit.
      const restored = await restoreExpectedFilesWithNoTraceUndo(expectedFiles, postFiles, {
        runProjectId: params.runProjectId
      });
      if (restored.applied.length) compileBridge.markSourceEdited();
      return { ...restored, ok: restored.attempted && restored.ok,
        skipped: restored.attempted ? restored.skipped : [{ trackedChange: null, result: {
          ok: false, code: restored.code || 'snapshot_undo_unavailable',
          reason: restored.reason || 'The saved checkpoint is unavailable for this undo.'
        } }] };
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

  // Native-ledger browsers accept exact IDs without changing document text.
  // The original undo/replay flow remains only for legacy adapter callers.
  async function acceptTrackedChanges(params = {}) {
    // Welcome-panel + write-guard: defense-in-depth.
    // The pageBridge wrapper already runs the runProjectId guard, but a
    // future caller could reach the router directly. A missing or empty
    // `runProjectId` blocks the accept with the same shape the page-side
    // guard uses.
    const writeGuardBlock = checkWritebackRunProjectId(params);
    if (writeGuardBlock) return writeGuardBlock;
    const nativeReview = await prepareNativeReview(params);
    if (nativeReview) return nativeReview.ok ? acceptNativeReview(params, nativeReview) : nativeReview;
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

    // Legacy replay requires positively confirmed Editing. The strict
    // detector and its rationale are kept in forceEditingForAcceptReplay.
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
      const postContent = postByPath.get(path);
      const activePathMatches = getActiveFilePath() === path;
      const activeContentMatches = readActiveEditorText() === postContent;
      // Overleaf can update the selected tree path before CodeMirror swaps its
      // document. In that state getActiveFilePath() already names `path`, while
      // readActiveEditorText() still belongs to the previously viewed file.
      // Force-reopen the target whenever either identity signal disagrees.
      if (path && (!activePathMatches || !activeContentMatches)) {
        const opened = await openFileByPath(path, { force: true });
        if (!opened.ok) {
          return {
            ok: false,
            attempted: false,
            code: 'tracked_change_editor_undo_open_failed',
            reason: `无法打开 ${path} 来执行 Overleaf 原生撤销。`
          };
        }
      }

      const postReady = await waitForActiveEditorExpectedText(path, postContent, 9000);
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
    const undoRebaseProofs = new Map();
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
      if (ready.prefixLength || ready.suffixLength) {
        undoRebaseProofs.set(path, { version: 1, path, beforeUndoContent: ready.postContent });
      }
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
      result: item.result?.ok !== false && item.result?.verified === true
        && undoRebaseProofs.has(item.operation?.path)
        && item.result.verifiedContent === rebasedExpectedByPath.get(item.operation?.path)
        ? { ...item.result, undoRebaseProof: undoRebaseProofs.get(item.operation.path) }
        : item.result
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




  const captureModule = window?.CodexOverleafTrackedChangeCapture
    || (typeof module === 'object' && module.exports ? require('./trackedChangeCapture.js') : null);
  const { collectTrackedChangeNodes, trackedChangeRefFromNode, collectTrackedChangeRefsForPaths,
    waitForTrackedChangeDiff, prepareTrackedChangeCapture, prepareTrackedChangeReview, prepareUntrackedUndo, getTrackedChangeCaptureStatus,
    captureTrackedWrite, reconcileTrackedChangeCapture } = captureModule.create(deps);

  function orderTrackedChangesForReviewAction(refs = []) {
    return (refs || []).slice().reverse();
  }

  function findTrackedChangeNode(ref = {}) {
    const targetKey = ref.key || '';
    if (!targetKey || ref.invalidProjectPath) {
      return null;
    }
    return collectTrackedChangeNodes()
      .find(node => trackedChangeRefFromNode(node, ref.path || getActiveFilePath()).key === targetKey
        || (targetKey.startsWith('sig:') && 'sig:' + compact(readNodeSignalText(node), 180) === targetKey))
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
      rejectTrackedChanges: async params => {
        const result = await rejectTrackedChanges(params);
        return deps.confirmReviewWriteback ? deps.confirmReviewWriteback(params, result) : result;
      },
      collectTrackedChangeRefsForPaths,
      prepareTrackedChangeCapture, getTrackedChangeCaptureStatus,
      captureTrackedWrite,
      reconcileTrackedChangeCapture,
      waitForTrackedChangeDiff
    };
  }

  return { create };
});
