(function initCodexOverleafWritebackRouter(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafWritebackRouter = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function writebackRouterFactory() {
  'use strict';

  function create(deps = {}) {
    const window = deps.window || (typeof globalThis !== 'undefined' ? globalThis : {});
    const treeOperations = deps.treeOperations || {};
    const compileBridge = deps.compileBridge || { markSourceEdited() {} };
    const projectSnapshotBridge = deps.projectSnapshotBridge || {};
    const normalizeSafeProjectPath = deps.normalizeSafeProjectPath || fallbackNormalizeSafeProjectPath;
    const writebackOpenSettleMs = Number.isFinite(Number(deps.writebackOpenSettleMs))
      ? Math.max(0, Number(deps.writebackOpenSettleMs))
      : 1200;
    const diagnosticsRevision = String(deps.diagnosticsRevision || '');
    // Cross-world cancel signal reader. Returns the current page-bridge
    // sequence number, which monotonically increments when content-side
    // calls pageBridge.cancelActiveWrite. applyOperationsCore captures the
    // baseline at start and re-reads between ops; any bump means the user
    // cancelled and the remaining ops should be skipped with codex_cancelled.
    const readWriteCancellationSequence = typeof deps.readWriteCancellationSequence === 'function'
      ? deps.readWriteCancellationSequence
      : () => 0;

    function invalidProjectPathResult(label = 'path') {
      return deps.invalidProjectPathResult?.(label) || {
        ok: false,
        code: 'invalid_project_path',
        reason: 'Invalid ' + label + '.'
      };
    }

    function ensureReviewing(params = {}) {
      return deps.ensureReviewing?.(params) || Promise.resolve({ ok: false, reason: 'Reviewing controls are unavailable.' });
    }

    function ensureEditing(params = {}) {
      return deps.ensureEditing?.(params) || Promise.resolve({ ok: false, reason: 'Editing controls are unavailable.' });
    }

    function getReviewingState(params = {}) {
      return deps.getReviewingState?.(params) || { reviewing: { ok: false }, signals: {} };
    }

    function isEditingConfirmedForNoTraceUndo(state = {}) {
      return deps.isEditingConfirmedForNoTraceUndo?.(state) === true;
    }

    // Authoritative "is Reviewing / Track Changes positively ON" check, wired to
    // the page bridge's aria-aware isReviewingConfirmedForWrite. Unlike a bare
    // reviewing.ok read this does not treat a control merely *labelled*
    // "Reviewing" (with no active aria) as proof that Track Changes is on, so it
    // is the correct strict gate for the Accept replay's Editing-mode switch.
    function isReviewingConfirmedForWrite(state = {}) {
      return deps.isReviewingConfirmedForWrite?.(state) === true;
    }

    function setReviewingEnabled(enabled, params = {}) {
      return deps.setReviewingEnabled?.(enabled, params) || Promise.resolve({ ok: false, enabled });
    }

    function summarizeReviewingToggleResult(result = {}) {
      return deps.summarizeReviewingToggleResult?.(result) || {
        ok: result.ok === true,
        changed: result.changed === true,
        enabled: result.enabled === true,
        code: result.code || '',
        reason: result.reason || ''
      };
    }

    function getActiveFilePath() {
      return treeOperations.getActiveFilePath?.() || '';
    }

    function getActiveEditorIdentity() {
      return deps.getActiveEditorIdentity?.() ?? null;
    }

    function activeEditorIdentityChanged(previous) {
      // When no detector is wired (test/early-init), assume identity changed
      // so callers re-run their per-op editor checks rather than silently
      // reusing stale state.
      return deps.activeEditorIdentityChanged
        ? deps.activeEditorIdentityChanged(previous)
        : true;
    }

    function openFileByPath(filePath, options = {}) {
      return treeOperations.openFileByPath?.(filePath, options) || Promise.resolve({ ok: false, reason: 'Tree operations are unavailable' });
    }

    function projectPathExists(filePath) {
      return treeOperations.projectPathExists?.(filePath) === true;
    }

    // Distinct from `projectPathExists` (which boolean-collapses an
    // unavailable implementation): returns true only when the underlying
    // treeOperations actually exposes a projectPathExists hook. Used by
    // emit sites that only want to fire target_file_not_found when we have
    // a real path-existence check — older test harnesses do not stub the
    // hook, and treating "no hook" as "path missing" would break them.
    function hasProjectPathExistsHook() {
      return treeOperations.projectPathExists instanceof Function;
    }

    function findFileTreeManager() {
      return treeOperations.findFileTreeManager?.() || null;
    }

    function readActiveEditorText() {
      return deps.readActiveEditorText?.() || '';
    }

    function waitForActiveEditorText(filePath, timeoutMs, options = {}) {
      if (treeOperations.waitForActiveEditorText) {
        return treeOperations.waitForActiveEditorText(filePath, timeoutMs, options);
      }
      return Promise.resolve({
        ok: true,
        path: filePath || getActiveFilePath(),
        text: readActiveEditorText()
      });
    }

    function contentSignature(content) {
      if (treeOperations.contentSignature) {
        return treeOperations.contentSignature(content);
      }
      const text = String(content ?? '');
      return `${text.length}:${text.slice(0, 80)}:${text.slice(-80)}`;
    }

    function contentFingerprint(content) {
      const text = String(content ?? '');
      let hash = 2166136261;
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      return {
        length: text.length,
        normalizedLength: normalizeEditorTextForComparison(text).length,
        hash: hash.toString(16).padStart(8, '0'),
        blank: text.trim().length === 0
      };
    }

    function replaceActiveEditorText(text) {
      return deps.replaceActiveEditorText?.(text) || { ok: false, reason: 'Editor adapter is unavailable' };
    }

    function replaceActiveEditorPatches(patches, nextContent) {
      return deps.replaceActiveEditorPatches?.(patches, nextContent) || { ok: false, reason: 'Editor adapter is unavailable' };
    }

    function collectElements(selector, limit) {
      return deps.collectElements?.(selector, limit) || [];
    }

    function uniqueNodes(nodes) {
      return deps.uniqueNodes?.(nodes) || Array.from(new Set(nodes || []));
    }

    function readNodeSignalText(node) {
      return deps.readNodeSignalText?.(node) || '';
    }

    function isInsideCodexPanel(node) {
      return deps.isInsideCodexPanel?.(node) === true;
    }

    function normalizeReviewingSignalText(value) {
      return deps.normalizeReviewingSignalText?.(value) || String(value || '').replace(/\s+/g, ' ').trim();
    }

    function clickNode(node) {
      if (deps.clickNode) {
        deps.clickNode(node);
        return;
      }
      if (node?.click) {
        node.click();
        return;
      }
      node?.dispatchEvent?.(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }

    function delay(ms) {
      if (deps.delay) {
        return deps.delay(ms);
      }
      return new Promise(resolve => window.setTimeout(resolve, ms));
    }

    function compact(value, limit) {
      if (deps.compact) {
        return deps.compact(value, limit);
      }
      const text = String(value || '').replace(/\s+/g, ' ').trim();
      return text.length > limit ? text.slice(0, limit - 3) + '...' : text;
    }

    function buildWritebackDebug(stage, operation, baseFileLookup, currentText, extra = {}) {
      const filePath = normalizeSafeProjectPath(operation?.path || '');
      const baseKnown = Boolean(baseFileLookup && filePath && baseFileLookup.has(filePath));
      const baseContent = baseKnown ? baseFileLookup.get(filePath) : '';
      return {
        stage,
        revision: diagnosticsRevision,
        operationPath: filePath,
        operationType: operation?.type || '',
        activePath: getActiveFilePath(),
        current: contentFingerprint(currentText),
        baseKnown,
        base: baseKnown ? contentFingerprint(baseContent) : null,
        ...extra
      };
    }

    function attachWritebackDebug(result, stage, operation, baseFileLookup, currentText, extra = {}) {
      if (!result || typeof result !== 'object') {
        return result;
      }
      return {
        ...result,
        debug: buildWritebackDebug(stage, operation, baseFileLookup, currentText, extra)
      };
    }

    // Inline mirror of the page-side subset of the FailureReason §9 catalog used by
    // T4 emit sites. Keeping it inline avoids an extra script-load dependency for
    // the page-injected bundle; the catalog itself is duplicated in
    // shared/failureReasons.js (FAILURE_CODE_CATALOG) — keep in sync when adding
    // codes. Each entry mirrors stage / severity / defaultRetryable /
    // fallbackUserMessage / fallbackNextAction.
    const PAGE_FAILURE_CATALOG = {
      target_file_not_found: {
        stage: 'navigation', severity: 'blocked', defaultRetryable: true,
        fallbackUserMessage: 'Codex could not find the target file in this Overleaf project.',
        fallbackNextAction: 'Check the file name/path in Overleaf and retry.'
      },
      target_file_open_failed: {
        stage: 'navigation', severity: 'blocked', defaultRetryable: true,
        fallbackUserMessage: 'Codex could not open the target file in Overleaf.',
        fallbackNextAction: 'Expand the folder or manually open the file, then retry.'
      },
      target_file_not_active: {
        stage: 'navigation', severity: 'blocked', defaultRetryable: true,
        fallbackUserMessage: 'Codex tried to write the target file, but another file was active at write time.',
        fallbackNextAction: 'Open the target file in Overleaf, then retry this run.'
      },
      target_editor_not_ready: {
        stage: 'navigation', severity: 'blocked', defaultRetryable: true,
        fallbackUserMessage: 'Target file is active but the editor was not ready before timeout.',
        fallbackNextAction: 'Wait for Overleaf to finish loading, then retry.'
      },
      stale_source_changed: {
        stage: 'preflight', severity: 'blocked', defaultRetryable: true,
        fallbackUserMessage: 'The file changed while Codex was working.',
        fallbackNextAction: 'Review the current file, then rerun the task.'
      },
      patch_anchor_not_found: {
        stage: 'preflight', severity: 'blocked', defaultRetryable: true,
        fallbackUserMessage: 'The edit anchor no longer matches current Overleaf content.',
        fallbackNextAction: 'Rerun the task against the current document.'
      },
      write_observed_mismatch: {
        stage: 'verify', severity: 'error', defaultRetryable: false,
        fallbackUserMessage: 'Codex attempted to write, but the content read back from Overleaf did not match the approved change.',
        fallbackNextAction: 'Open Technical Details and compare expected vs observed.'
      },
      editing_not_confirmed: {
        stage: 'reviewing', severity: 'blocked', defaultRetryable: true,
        fallbackUserMessage: 'Editing mode could not be proven stable.',
        fallbackNextAction: 'Do not write; check the mode selector and retry.'
      },
      tracked_changes_remain: {
        stage: 'reviewing', severity: 'warning', defaultRetryable: true,
        fallbackUserMessage: 'Accept/reject operation finished but tracked changes remain.',
        fallbackNextAction: 'Open Overleaf Reviewing and inspect remaining changes.'
      }
    };

    // Build a structured FailureReason record (§7) for emit at the page layer.
    // `overrides` merges into the entry: callers supply `file` / `activeFile` /
    // `userMessage` / `evidence` / `changedDocument` / `terminalState` etc.
    function buildPageFailure(code, overrides) {
      const entry = PAGE_FAILURE_CATALOG[code];
      if (!entry) {
        return null;
      }
      const merged = overrides || {};
      const failure = {
        code,
        stage: entry.stage,
        severity: entry.severity,
        userMessage: merged.userMessage || entry.fallbackUserMessage,
        retryable: merged.retryable === undefined ? entry.defaultRetryable : merged.retryable === true,
        nextAction: merged.nextAction || entry.fallbackNextAction
      };
      if (merged.file !== undefined) failure.file = merged.file;
      if (merged.activeFile !== undefined) failure.activeFile = merged.activeFile;
      if (merged.operationType !== undefined) failure.operationType = merged.operationType;
      if (merged.changedDocument !== undefined) failure.changedDocument = merged.changedDocument === true;
      if (merged.terminalState !== undefined) failure.terminalState = merged.terminalState;
      if (merged.technicalMessage !== undefined) failure.technicalMessage = merged.technicalMessage;
      if (merged.evidence !== undefined) failure.evidence = merged.evidence;
      return failure;
    }

    function normalizeTextPatches(patches, length) {
      if (deps.normalizeTextPatches) {
        return deps.normalizeTextPatches(patches, length);
      }
      const normalized = [];
      let previousTo = 0;
      for (const rawPatch of patches || []) {
        const from = Number(rawPatch?.from);
        const to = Number(rawPatch?.to);
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > length) {
          return {
            ok: false,
            code: 'invalid_patch',
            reason: 'Codex generated an invalid patch range.'
          };
        }
        if (from < previousTo) {
          return {
            ok: false,
            code: 'invalid_patch',
            reason: 'Codex generated overlapping patch ranges.'
          };
        }
        previousTo = to;
        normalized.push({
          from,
          to,
          expected: String(rawPatch.expected ?? ''),
          insert: String(rawPatch.insert ?? '')
        });
      }
      return {
        ok: true,
        patches: normalized
      };
    }

  async function applyOperations(operations, options = {}) {
    if (options.reviewingPolicy === 'no-trace-undo') {
      return applyOperationsWithNoTraceUndo(operations, options);
    }
    const hasOperations = (operations || []).length > 0;
    const trackReviewingChanges = options.requireReviewing === true && hasOperations;
    let reviewingPolicy = null;
    if (options.requireReviewing === true && hasOperations) {
      const reviewing = await ensureReviewing({ waitMs: 1800 });
      if (!reviewing.ok) {
        return buildReviewingRequiredBlockedResult(operations, reviewing);
      }
    } else if (options.requireEditing === true && hasOperations) {
      const editing = await ensureEditing({ waitMs: 1800 });
      if (!editing.ok) {
        return buildEditingRequiredBlockedResult(operations, editing);
      }
      reviewingPolicy = {
        policy: 'editing-write',
        disabled: editing.activated === true,
        leftEditing: true,
        reason: editing.activated ? 'switched_to_editing_before_write' : 'editing_already_confirmed',
        disable: summarizeReviewingToggleResult({
          ok: true,
          changed: editing.activated === true,
          enabled: false,
          reason: editing.activated ? 'Switched to Editing before untracked write.' : 'Editing already confirmed before untracked write.'
        })
      };
    }
    const result = await applyOperationsCore(operations, {
      ...options,
      trackReviewingChanges
    });
    return reviewingPolicy
      ? {
        ...result,
        reviewingPolicy
      }
      : result;
  }

  async function applyOperationsWithNoTraceUndo(operations, options = {}) {
    const initial = getReviewingState({});
    if (isEditingConfirmedForNoTraceUndo(initial)) {
      const result = await applyOperationsCore(operations, options);
      return {
        ...result,
        reviewingPolicy: {
          policy: 'no-trace-undo',
          disabled: false,
          restored: false,
          reason: 'editing_already_confirmed'
        }
      };
    }

    const disabled = await setReviewingEnabled(false, { waitMs: 1800 });
    if (!disabled.ok) {
      return buildNoTraceUndoBlockedResult(operations, disabled);
    }

    let result;
    let applyError = null;
    try {
      result = await applyOperationsCore(operations, options);
    } catch (error) {
      applyError = error;
    }
    if (applyError) {
      throw applyError;
    }

    return {
      ...result,
      reviewingPolicy: {
        policy: 'no-trace-undo',
        disabled: true,
        restored: false,
        leftEditing: true,
        reason: 'left_editing_after_undo',
        disable: summarizeReviewingToggleResult(disabled)
      }
    };
  }

  async function applyOperationsCore(operations, options = {}) {
    const applied = [];
    const skipped = [];
    const trackedChanges = [];
    const safeBaseFiles = normalizeBaseFilesForSafety(options.baseFiles);
    const baseFileLookup = window.CodexOverleafStaleGuard?.buildBaseFileLookup(safeBaseFiles);
    const baseBinaryFileLookup = buildBaseBinaryFileLookup(safeBaseFiles);
    // Mid-run project-change guard. The pageBridge wrapper already ran the
    // writeGuard once at entry, but each per-op step here can take 0.5-5s
    // (openFileByPath, waitForActiveEditorText, save-state verification),
    // so a multi-op write can span 10-30 seconds total. If the user SPA-
    // navigates to a different project mid-flight, the remaining operations
    // would land in the wrong project. Re-check the editor project before
    // each op and short-circuit the rest of the queue when it diverges.
    const runProjectId = typeof options.runProjectId === 'string' ? options.runProjectId : '';
    const writeGuardSurface = window.CodexOverleafWriteGuard?.create({
      window,
      document: window.document,
      treeOperations
    });
    // Cross-world cancel baseline. The user clicks cancel during writeback →
    // content-side calls pageBridge.cancelActiveWrite → the sequence number
    // bumps. Two layers of responsiveness:
    //   1. Between-ops check — short-circuits the next iteration so the
    //      remaining ops never start.
    //   2. Race the in-flight op against a cancellation poller (50ms
    //      interval) so a click DURING a slow op (e.g. inside a 5s
    //      waitForActiveFile poll) is observed within ~50ms instead of
    //      having to wait out the op's internal timeout. The op promise
    //      keeps running in the page world after the race resolves — its
    //      eventual result is ignored. This is "user-perceived instant
    //      cancel": the spinner stops, the run settles to cancelled, and
    //      any DOM mutation already in flight on the op cannot be undone
    //      from here anyway.
    const cancelBaselineSequence = readWriteCancellationSequence();
    const cancelledSkipResult = {
      ok: false,
      code: 'codex_cancelled',
      reason: 'The Codex run was cancelled by the user while the writeback was in flight; remaining operations were not applied.',
      failure: {
        code: 'codex_run_cancelled',
        stage: 'write',
        severity: 'info',
        userMessage: 'The Codex run was cancelled by the user during writeback; remaining file operations were skipped.',
        nextAction: 'Start a new run if you want to apply these changes.',
        retryable: true,
        terminalState: 'cancelled',
        changedDocument: false
      }
    };
    const cancelledInFlightResult = {
      ...cancelledSkipResult,
      reason: 'The Codex run was cancelled while an Overleaf write operation was already in flight. The editor may have changed; review the current file before starting a new run.',
      failure: {
        ...cancelledSkipResult.failure,
        severity: 'warning',
        userMessage: 'The Codex run was cancelled during an in-flight write. The editor may already contain part of that write.',
        nextAction: 'Review the current Overleaf file before starting a new run.',
        changedDocument: true
      }
    };
    // 50ms-poller racer using recursive setTimeout. setInterval is NOT
    // exposed in the test VM context that hosts pageBridge (only setTimeout /
    // clearTimeout are wired), so this implementation must avoid it. Each
    // tick re-schedules itself only while the racer has not resolved;
    // dispose() flips a flag so any tick that fires after dispose is a no-op.
    // Resolves the first time the cancellation sequence bumps past baseline.
    function createCancellationRacer() {
      let resolved = false;
      let resolveFn;
      const promise = new Promise(resolve => { resolveFn = resolve; });
      let timer = null;
      function tick() {
        if (resolved) return;
        if (readWriteCancellationSequence() !== cancelBaselineSequence) {
          resolved = true;
          resolveFn();
          return;
        }
        timer = window.setTimeout(tick, 50);
      }
      timer = window.setTimeout(tick, 50);
      return {
        promise,
        dispose() {
          resolved = true;
          if (timer) window.clearTimeout(timer);
        }
      };
    }
    const CANCELLED_RACE_SENTINEL = Symbol('writebackRouter.cancelled');
    async function raceOpAgainstCancellation(opPromise) {
      // Once an editor operation starts, preserve its actual result and undo
      // metadata. The loop's pre-operation cancellation check stops the tail.
      return await opPromise;
    }

    for (const rawOperation of operations) {
      // Cross-world cancel check. Cheap (synchronous read of a counter),
      // runs before the writeGuard re-check so a click-cancel that arrived
      // during the previous op's await microtasks short-circuits before we
      // burn time on guard / open-file work for the next op.
      if (readWriteCancellationSequence() !== cancelBaselineSequence) {
        skipped.push({ operation: normalizeOperationPaths(rawOperation), result: cancelledSkipResult });
        const remainingForCancel = operations.slice(operations.indexOf(rawOperation) + 1);
        for (const tailOperation of remainingForCancel) {
          skipped.push({ operation: normalizeOperationPaths(tailOperation), result: cancelledSkipResult });
        }
        break;
      }
      // Per-op re-check: if a runProjectId was supplied and the page-side
      // guard is available, verify the editor still shows the same project
      // before committing the next write. Mismatch → push aborted_project_changed
      // for THIS op and every remaining op in the queue, then return.
      if (runProjectId && writeGuardSurface) {
        const guardBlock = await writeGuardSurface.runWriteGuard({ runProjectId });
        if (guardBlock) {
          // First push the guard's structured skip for the current op so the
          // caller can attribute the abort to a real operation path, then
          // pad the remaining ops with the same failure shape.
          const guardFailure = guardBlock.skipped[0].result;
          skipped.push({ operation: normalizeOperationPaths(rawOperation), result: guardFailure });
          const remaining = operations.slice(operations.indexOf(rawOperation) + 1);
          for (const tailOperation of remaining) {
            skipped.push({ operation: normalizeOperationPaths(tailOperation), result: guardFailure });
          }
          break;
        }
      }
      const operation = normalizeOperationPaths(rawOperation);
      const pathSafety = validateOperationProjectPaths(operation);
      if (!pathSafety.ok) {
        skipped.push({ operation, result: pathSafety });
        continue;
      }
      let raceResult;
      if (operation.type === 'edit') {
        raceResult = await raceOpAgainstCancellation(applyEditOperation(operation, {
          baseFileLookup,
          trackReviewingChanges: options.trackReviewingChanges === true
        }));
      } else if (['binary-create', 'overwrite-binary'].includes(operation.type)) {
        raceResult = await raceOpAgainstCancellation(applyBinaryAssetOperation(operation, { baseFileLookup, baseBinaryFileLookup }));
      } else if (['create', 'rename', 'move', 'delete'].includes(operation.type)) {
        raceResult = await raceOpAgainstCancellation(applyFileTreeOperation(operation, { baseFileLookup }));
      } else {
        skipped.push({
          operation,
          result: {
            ok: false,
            reason: `Unsupported operation type: ${operation.type}`
          }
        });
        continue;
      }
      // Cancellation race winner: skip current op + the rest of the queue.
      // The op promise above keeps running in background; its eventual
      // result is discarded. The user perceives instant cancel because we
      // settle the loop here instead of waiting for the op to finish.
      if (raceResult === CANCELLED_RACE_SENTINEL) {
        skipped.push({ operation, result: cancelledInFlightResult });
        const remainingAfterCancel = operations.slice(operations.indexOf(rawOperation) + 1);
        for (const tailOperation of remainingAfterCancel) {
          skipped.push({ operation: normalizeOperationPaths(tailOperation), result: cancelledSkipResult });
        }
        break;
      }
      const result = raceResult;
      if (operation.type === 'edit' && result.ok && Array.isArray(result.trackedChanges)) {
        trackedChanges.push(...result.trackedChanges);
      }
      (result.ok ? applied : skipped).push({ operation, result });
    }

    if (applied.length > 0) {
      compileBridge.markSourceEdited();
    }

    return {
      ok: skipped.length === 0,
      applied,
      skipped,
      trackedChanges: mergeTrackedChangeRefs(trackedChanges)
    };
  }

























  async function applyEditOperation(operation, options = {}) {
    const currentPath = getActiveFilePath();
    const editorReady = await ensureEditorReadyForOperation(operation, options.baseFileLookup, currentPath);
    if (!editorReady.ok) {
      return editorReady;
    }

    const trackReviewingChanges = options.trackReviewingChanges === true;
    const forbidTrackedChanges = options.forbidTrackedChanges === true;
    const observeTrackedChanges = trackReviewingChanges || forbidTrackedChanges;
    const operationPaths = collectOperationPaths([operation]);
    const trackedBefore = observeTrackedChanges
      ? collectTrackedChangeRefsForPaths(operationPaths)
      : [];
    let current = editorReady.text;
    let freshness = window.CodexOverleafStaleGuard?.checkOperationFreshness(
      operation,
      current,
      options.baseFileLookup
    ) || { ok: true };
    if (!freshness.ok) {
      const ready = await waitForFreshEditorTextForOperation(operation, options.baseFileLookup, 1500);
      if (!ready.ok) {
        const decorated = attachWritebackDebug(freshness, 'stale_guard', operation, options.baseFileLookup, current, {
          initialActivePath: currentPath,
          editorReadyDebug: editorReady.debug || null,
          waitFresh: ready
        });
        // §9.2: legacy stale_snapshot / stale_patch_range / missing_base_file
        // map to canonical preflight failure codes. The structured failure
        // attaches the per-emit-site evidence so the run card / final report
        // can render with file context without round-tripping through the
        // normalizer's legacy mapping.
        const staleCode = freshness.code === 'missing_base_file'
          ? 'missing_base_file'
          : freshness.code === 'stale_patch_range'
            ? 'patch_anchor_not_found'
            : 'stale_source_changed';
        if (staleCode === 'stale_source_changed' || staleCode === 'patch_anchor_not_found') {
          decorated.failure = buildPageFailure(staleCode, {
            file: operation?.path || '',
            operationType: operation?.type || 'edit',
            changedDocument: false,
            userMessage: staleCode === 'stale_source_changed'
              ? `${operation?.path || 'The target file'} changed while Codex was working, so Codex did not overwrite it.`
              : `${operation?.path || 'The target file'} no longer contains the text Codex expected to edit, so Codex did not overwrite it.`,
            technicalMessage: freshness.reason || '',
            evidence: {
              originalCode: freshness.code || '',
              baselineMatched: false,
              writeStarted: false
            }
          });
        }
        return decorated;
      }
      current = ready.text;
      freshness = { ok: true };
    }

    let nextContent = null;
    if (Array.isArray(operation.patches) && operation.patches.length) {
      const patched = applyTextPatches(current, operation.patches);
      if (!patched.ok) {
        const decorated = attachWritebackDebug(patched, 'apply_text_patches', operation, options.baseFileLookup, current, {
          initialActivePath: currentPath,
          editorReadyDebug: editorReady.debug || null
        });
        // §9.2: stale_patch (a patch `expected` slice did not match the
        // current document) is the canonical patch_anchor_not_found case.
        // invalid_patch (range out of bounds / overlapping) also belongs to
        // patch_anchor_not_found per §9.2: the anchor cannot be aligned to
        // current content.
        if (patched.code === 'stale_patch' || patched.code === 'invalid_patch') {
          decorated.failure = buildPageFailure('patch_anchor_not_found', {
            file: operation?.path || '',
            operationType: operation?.type || 'edit',
            changedDocument: false,
            userMessage: `Codex's edit anchors no longer match ${operation?.path || 'the current document'}, so Codex did not overwrite it.`,
            technicalMessage: patched.reason || '',
            evidence: {
              originalCode: patched.code || '',
              writeStarted: false
            }
          });
        }
        return decorated;
      }
      nextContent = patched.text;
    } else if (typeof operation.replaceAll === 'string') {
      nextContent = operation.replaceAll;
    } else if (typeof operation.find === 'string' && typeof operation.replace === 'string') {
      if (!current.includes(operation.find)) {
        return {
          ok: false,
          reason: 'Find text was not present in the active editor'
        };
      }
      nextContent = current.split(operation.find).join(operation.replace);
    } else {
      return {
        ok: false,
        reason: 'Edit operation must provide patches, replaceAll, or find/replace fields'
      };
    }

    const result = Array.isArray(operation.patches) && operation.patches.length
      ? replaceActiveEditorPatches(operation.patches, nextContent)
      : replaceActiveEditorText(nextContent);
    if (!result.ok) {
      return result;
    }

    const verified = await verifyActiveEditorText(nextContent, operation.path);
    if (!verified.ok) {
      const decorated = attachWritebackDebug(verified, 'write_verification', operation, options.baseFileLookup, readActiveEditorText(), {
        initialActivePath: currentPath,
        editorReadyDebug: editorReady.debug || null
      });
      // §9.3 write_observed_mismatch: the write call landed but the readback
      // does not match. changedDocument:true — the editor state moved, just
      // not as Codex expected.
      decorated.failure = buildPageFailure('write_observed_mismatch', {
        file: operation?.path || '',
        operationType: operation?.type || 'edit',
        changedDocument: true,
        userMessage: `${operation?.path || 'The target file'} did not read back the content Codex wrote; the document state may differ from what was approved.`,
        technicalMessage: verified.reason || '',
        evidence: {
          originalCode: verified.code || '',
          expectedLength: verified.expectedLength,
          actualLength: verified.actualLength,
          writeStarted: true
        }
      });
      return decorated;
    }
    const trackedChanges = [];
    if (observeTrackedChanges) {
      // Overleaf renders review markers asynchronously after the editor text
      // has already changed. A single 120 ms snapshot intermittently missed
      // those markers, leaving a Reviewing write with Undo but no Accept.
      // Poll both paths: normal Reviewing writes get a shorter capture window,
      // while Accept replay keeps the longer safety window used to prove that
      // it did not create fresh tracked changes.
      const trackedDiff = await waitForTrackedChangeDiff(trackedBefore, operationPaths, {
        waitMs: forbidTrackedChanges ? 3600 : 1800,
        intervalMs: 180
      });
      trackedChanges.push(...trackedDiff.trackedChanges);
      if (forbidTrackedChanges && trackedChanges.length > 0) {
        return {
          ok: false,
          code: 'accept_replay_created_tracked_changes',
          reason: 'Accept All replay wrote the expected text, but Overleaf created fresh tracked changes during the replay. Codex tried to roll back this replay and left the run pending instead of marking it accepted.',
          // §9.4 tracked_changes_remain: warning severity, needs_review terminal
          // state. The replay wrote (changedDocument:true), but Overleaf left
          // tracked-change nodes behind, so Accept cannot be proven clean.
          failure: buildPageFailure('tracked_changes_remain', {
            file: operation?.path || '',
            operationType: operation?.type || 'edit',
            changedDocument: true,
            terminalState: 'needs_review',
            userMessage: `${operation?.path || 'The target file'} still has tracked changes after the Accept All replay, so the run could not be marked accepted.`,
            evidence: {
              originalCode: 'accept_replay_created_tracked_changes',
              trackedChangeCount: trackedChanges.length,
              writeStarted: true
            }
          }),
          verified: true,
          verifiedContent: nextContent,
          trackedChanges: mergeTrackedChangeRefs(trackedChanges)
        };
      }
    }
    window.CodexOverleafStaleGuard?.updateExpectedFileContent(
      options.baseFileLookup,
      operation.path,
      nextContent
    );
    return {
      ...result,
      verified: true,
      verifiedContent: nextContent,
      trackedChanges: mergeTrackedChangeRefs(trackedChanges)
    };
  }


  async function verifyActiveEditorText(expected, filePath, waitMs = 1000) {
    const deadline = Date.now() + waitMs;
    let actual = readActiveEditorText();
    while (actual !== expected && Date.now() < deadline) {
      await delay(50);
      actual = readActiveEditorText();
    }
    if (actual === expected) {
      return {
        ok: true
      };
    }
    return {
      ok: false,
      code: 'write_verification_failed',
      reason: `${filePath || '当前文件'} 写入后读回内容和 Codex 预期不一致，已停止把这次操作标记为成功。请刷新 Overleaf 后重试。`,
      expectedLength: String(expected || '').length,
      actualLength: String(actual || '').length
    };
  }

  async function ensureEditorReadyForOperation(operation, baseFileLookup, initialActivePath) {
    if (!operation?.path) {
      return {
        ok: true,
        text: readActiveEditorText()
      };
    }
    const filePath = normalizeSafeProjectPath(operation.path);
    if (!filePath) {
      return invalidProjectPathResult('operation path');
    }

    const currentText = readActiveEditorText();
    const previousEditorIdentity = getActiveEditorIdentity();
    const previousSignature = contentSignature(currentText);

    const opened = await openFileByPath(filePath, { force: initialActivePath === filePath });
    if (!opened.ok) {
      // A collapsed folder can make a real nested file temporarily invisible
      // to projectPathExists(). openFileByPath() owns the side-effecting
      // expand-and-open attempt, so only classify the path as missing after
      // that attempt has failed and the path still cannot be observed.
      const pathMissing = operation?.type === 'edit'
        && hasProjectPathExistsHook()
        && !projectPathExists(filePath);
      const resultCode = pathMissing ? 'path_not_found' : 'file_open_failed';
      const failureCode = pathMissing ? 'target_file_not_found' : 'target_file_open_failed';
      const reasonText = pathMissing
        ? `Cannot edit ${filePath}; the path was not found after Overleaf tried to open it.`
        : `Cannot edit ${filePath}; active file is ${initialActivePath || 'unknown'}; ${opened.reason}`;
      return {
        ok: false,
        code: resultCode,
        debug: buildWritebackDebug(pathMissing ? 'open_file_path_not_found' : 'open_file_failed', operation, baseFileLookup, currentText, {
          initialActivePath,
          opened
        }),
        reason: reasonText,
        failure: buildPageFailure(failureCode, {
          file: filePath,
          activeFile: initialActivePath || '',
          operationType: operation?.type || 'edit',
          changedDocument: false,
          userMessage: pathMissing
            ? `Codex could not find ${filePath} in this Overleaf project.`
            : `Codex could not open ${filePath} in Overleaf.`,
          technicalMessage: opened.reason || '',
          evidence: {
            originalCode: resultCode,
            initialActivePath: initialActivePath || '',
            openMethod: opened.method || '',
            openAttempted: true,
            writeStarted: false
          }
        })
      };
    }

    return waitForEditorContentForPath(filePath, previousEditorIdentity, baseFileLookup, 9000, {
      initialActivePath,
      previousSignature,
      forceSettledOpen: true,
      openedMethod: opened.method || ''
    });
  }

  async function waitForEditorContentForPath(filePath, previousEditorIdentity, baseFileLookup, timeoutMs, options = {}) {
    const deadline = Date.now() + timeoutMs;
    const startedAt = Date.now();
    const minSettleMs = options.forceSettledOpen ? writebackOpenSettleMs : 0;
    let lastText = readActiveEditorText();
    let lastActivePath = getActiveFilePath();
    while (Date.now() < deadline) {
      lastActivePath = getActiveFilePath();
      lastText = readActiveEditorText();
      const activeFileMatches = lastActivePath === filePath;
      const identityChanged = Boolean(previousEditorIdentity) && activeEditorIdentityChanged(previousEditorIdentity);
      const baseComparison = compareEditorTextToBase(filePath, lastText, baseFileLookup);
      const baseMatches = baseComparison.matches;
      const settledLongEnough = Date.now() - startedAt >= minSettleMs;
      const contentChangedFromPrevious = !options.previousSignature
        || contentSignature(lastText) !== options.previousSignature;
      // Switch confirmation must not depend on any single fragile signal
      // (v1.6: identity comparison proved unreliable against newer Overleaf
      // view lifecycles, which made every write to a non-active file time
      // out as target_editor_not_ready). Acceptors, strongest first:
      //   1. editor identity visibly changed (fast path when it works);
      //   2. the editor shows EXACTLY the target file's expected base —
      //      the strongest possible proof the right document is loaded;
      //   3. same-file reopen settled with unchanged content;
      //   4. base UNKNOWN only: the content moved off the previous document
      //      and the settle window elapsed. When the base IS known, content
      //      must match it (acceptor 2) — a weakly-anchored patch (e.g. an
      //      insert into an empty file, expected:'') would otherwise anchor
      //      trivially into a wrong-but-different document.
      const switchConfirmed = identityChanged
        || baseMatches
        || (options.initialActivePath === filePath
          && options.previousSignature
          && contentSignature(lastText) === options.previousSignature
          && settledLongEnough)
        || (!baseComparison.known && contentChangedFromPrevious && settledLongEnough);
      const contentNoLongerLooksLikePreviousDocument = contentChangedFromPrevious
        || baseMatches
        || options.initialActivePath === filePath;
      if (activeFileMatches && switchConfirmed && settledLongEnough && contentNoLongerLooksLikePreviousDocument) {
        return {
          ok: true,
          text: lastText
        };
      }
      await delay(100);
    }
    // §9.1: if the active file ended up on a different document, this is
    // target_file_not_active; if the file did become active but the editor
    // document never settled, this is target_editor_not_ready.
    const activeMismatched = Boolean(lastActivePath) && lastActivePath !== filePath;
    const canonicalCode = activeMismatched ? 'target_file_not_active' : 'target_editor_not_ready';
    return {
      ok: false,
      code: 'editor_document_not_switched',
      reason: `Cannot edit ${filePath}; Overleaf selected ${lastActivePath || 'unknown file'} but the editor document did not load the target file. Codex did not write to avoid editing the wrong file.`,
      lastActivePath,
      lastLength: String(lastText || '').length,
      debug: buildWritebackDebug('editor_document_not_switched', { type: 'edit', path: filePath }, baseFileLookup, lastText, {
        initialActivePath: options.initialActivePath || '',
        lastActivePath,
        previous: options.previousSignature || '',
        currentSignature: contentSignature(lastText),
        openedMethod: options.openedMethod || '',
        elapsedMs: Date.now() - startedAt
      }),
      failure: buildPageFailure(canonicalCode, {
        file: filePath,
        activeFile: lastActivePath || '',
        operationType: 'edit',
        changedDocument: false,
        userMessage: activeMismatched
          ? `Codex tried to write ${filePath}, but ${lastActivePath || 'a different file'} was active at write time.`
          : `${filePath} became active in Overleaf, but the editor was not ready before timeout.`,
        evidence: {
          initialActivePath: options.initialActivePath || '',
          lastActivePath: lastActivePath || '',
          openedMethod: options.openedMethod || '',
          elapsedMs: Date.now() - startedAt,
          writeStarted: false
        }
      })
    };
  }

  async function waitForEditorDocumentForPath(filePath, previousEditorIdentity, timeoutMs, options = {}) {
    const deadline = Date.now() + timeoutMs;
    const startedAt = Date.now();
    const minSettleMs = options.forceSettledOpen ? writebackOpenSettleMs : 0;
    let lastText = readActiveEditorText();
    let lastActivePath = getActiveFilePath();
    while (Date.now() < deadline) {
      lastActivePath = getActiveFilePath();
      lastText = readActiveEditorText();
      const activeFileMatches = lastActivePath === filePath;
      const identityChanged = Boolean(previousEditorIdentity) && activeEditorIdentityChanged(previousEditorIdentity);
      const settledLongEnough = Date.now() - startedAt >= minSettleMs;
      const sameFileReopenSettled = options.initialActivePath === filePath && settledLongEnough;
      if (activeFileMatches && settledLongEnough && (identityChanged || sameFileReopenSettled)) {
        return {
          ok: true,
          text: lastText
        };
      }
      await delay(100);
    }
    return {
      ok: false,
      code: 'editor_document_not_switched',
      reason: `Cannot verify ${filePath}; Overleaf selected ${lastActivePath || 'unknown file'} but the editor document did not confirm the target file.`,
      lastActivePath,
      lastLength: String(lastText || '').length
    };
  }

  function editorContentMatchesBase(filePath, content, baseFileLookup) {
    return compareEditorTextToBase(filePath, content, baseFileLookup).matches;
  }

  function compareEditorTextToBase(filePath, content, baseFileLookup) {
    const normalizedPath = normalizeSafeProjectPath(filePath);
    const current = normalizeEditorTextForComparison(content);
    if (!baseFileLookup || !normalizedPath || !baseFileLookup.has(normalizedPath)) {
      return {
        known: false,
        hasContent: false,
        matches: false,
        baseLength: null,
        currentLength: current.length
      };
    }
    const base = normalizeEditorTextForComparison(baseFileLookup.get(normalizedPath));
    const matches = current === base;
    if (!matches && base.trim().length > 0) {
      console.warn('[codex-overleaf] editorContentMatchesBase MISMATCH', filePath,
        'base.length:', base.length, 'current.length:', current.length,
        'base[0..80]:', JSON.stringify(base.slice(0, 80)),
        'current[0..80]:', JSON.stringify(current.slice(0, 80)));
    }
    return {
      known: true,
      hasContent: base.trim().length > 0,
      matches,
      baseLength: base.length,
      currentLength: current.length
    };
  }

  function hasBaseFileContent(filePath, baseFileLookup) {
    if (!baseFileLookup || !filePath || !baseFileLookup.has(filePath)) {
      return false;
    }
    const content = baseFileLookup.get(filePath);
    return typeof content === 'string' && content.trim().length > 0;
  }

  function normalizeEditorTextForComparison(value) {
    const normalized = String(value ?? '').replace(/\r\n/g, '\n');
    return normalized.trim().length === 0 ? '' : normalized;
  }

  async function waitForFreshEditorTextForOperation(operation, baseFileLookup, waitMs = 1500) {
    const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
    while (Date.now() < deadline) {
      if (operation?.path && getActiveFilePath() !== operation.path) {
        await delay(60);
        continue;
      }
      const text = readActiveEditorText();
      const freshness = window.CodexOverleafStaleGuard?.checkOperationFreshness(
        operation,
        text,
        baseFileLookup
      ) || { ok: true };
      if (freshness.ok) {
        return {
          ok: true,
          text
        };
      }
      await delay(60);
    }
    return {
      ok: false
    };
  }

  function applyTextPatches(text, patches) {
    const normalized = normalizeTextPatches(patches, text.length);
    if (!normalized.ok) {
      return normalized;
    }

    let next = text;
    for (const patch of normalized.patches.slice().sort((left, right) => right.from - left.from)) {
      if (next.slice(patch.from, patch.to) !== patch.expected) {
        return {
          ok: false,
          code: 'stale_patch',
          reason: '这处内容已经和 Codex 读取时不同，所以没有写入。请重新运行，让 Codex 先读取你的最新 Overleaf 内容。'
        };
      }
      next = next.slice(0, patch.from) + patch.insert + next.slice(patch.to);
    }
    return {
      ok: true,
      text: next,
      patches: normalized.patches
    };
  }


  async function applyBinaryAssetOperation(operation, options = {}) {
    const freshness = await checkBinaryAssetFreshness(operation, options);
    if (!freshness.ok) {
      return freshness;
    }

    const bytes = decodeBase64Bytes(operation.contentBase64);
    if (!bytes.ok) {
      return bytes;
    }

    const manager = findFileTreeManager();
    const file = createAssetFile(operation.path, bytes.bytes);
    const methodNames = ['uploadFile', 'uploadAsset', 'createBinaryFile', 'createFile', 'addFile'];
    for (const methodName of methodNames) {
      const method = manager?.[methodName];
      if (typeof method !== 'function') {
        continue;
      }
      try {
        if (operation.type === 'overwrite-binary' && projectPathExists(operation.path)) {
          await method.call(manager, operation.path, file, { overwrite: true });
        } else {
          await method.call(manager, operation.path, file);
        }
        await delay(120);
        if (!projectPathExists(operation.path)) {
          return {
            ok: false,
            code: 'binary_asset_verification_failed',
            reason: `${operation.path} did not appear in the Overleaf file tree after binary asset upload.`
          };
        }
        return {
          ok: true,
          method: `fileTreeManager.${methodName}`,
          verified: true,
          binaryAsset: true
        };
      } catch (_error) {
        // Try the next known Overleaf file upload method.
      }
    }

    return {
      ok: false,
      code: 'binary_asset_write_unsupported',
      reason: 'No supported Overleaf binary asset upload method was detected. The asset was not written.'
    };
  }

  async function checkBinaryAssetFreshness(operation, options = {}) {
    const baseFileLookup = options.baseFileLookup;
    const baseBinaryFileLookup = options.baseBinaryFileLookup;
    if (!operation?.path) {
      return {
        ok: false,
        code: 'missing_operation_path',
        reason: 'Cannot safely write a binary asset without a target path.'
      };
    }
    if (operation.type === 'binary-create' && projectPathExists(operation.path)) {
      return {
        ok: false,
        code: 'path_created_since_snapshot',
        reason: `${operation.path} already exists in Overleaf. Codex did not overwrite it as a new asset.`
      };
    }
    if (operation.type === 'overwrite-binary' && baseFileLookup && !baseFileLookup.has(operation.path)) {
      return {
        ok: false,
        code: 'missing_base_file',
        reason: `${operation.path} was not present in the run baseline. Codex did not overwrite it.`
      };
    }
    if (operation.type === 'overwrite-binary' && !projectPathExists(operation.path)) {
      return {
        ok: false,
        code: 'missing_current_binary_asset',
        reason: `${operation.path} no longer exists in Overleaf. Codex did not overwrite it.`
      };
    }
    if (operation.type === 'overwrite-binary') {
      const baseBinaryFile = baseBinaryFileLookup?.get(operation.path);
      if (!baseBinaryFile) {
        return {
          ok: false,
          code: 'missing_binary_base_content',
          reason: `${operation.path} did not have binary baseline content. Codex did not overwrite it.`
        };
      }
      const currentBinaryFile = await getCurrentBinaryAssetFile(operation.path);
      if (!currentBinaryFile.ok) {
        return currentBinaryFile;
      }
      if (!binaryAssetMatchesBaseline(baseBinaryFile, currentBinaryFile.file)) {
        return {
          ok: false,
          code: 'stale_binary_asset',
          reason: `${operation.path} changed in Overleaf after the baseline. Codex did not overwrite it.`
        };
      }
    }
    return { ok: true };
  }

  function buildBaseBinaryFileLookup(files) {
    if (!Array.isArray(files) || !files.length) {
      return null;
    }
    const lookup = new Map();
    for (const file of files) {
      if (!file?.path || typeof file.contentBase64 !== 'string') {
        continue;
      }
      const filePath = normalizeSafeProjectPath(file.path);
      if (!filePath) {
        continue;
      }
      lookup.set(filePath, {
        contentBase64: normalizeBase64(file.contentBase64),
        size: Number.isFinite(Number(file.size)) ? Number(file.size) : null
      });
    }
    return lookup.size ? lookup : null;
  }

  async function getCurrentBinaryAssetFile(filePath) {
    try {
      const project = await projectSnapshotBridge.getProjectSnapshot({
        zipOnly: true,
        includeBinaryFiles: true,
        force: true,
        maxAgeMs: 0
      });
      const normalizedPath = normalizeSafeProjectPath(filePath);
      const file = (project?.files || []).find(item =>
        normalizeSafeProjectPath(item?.path) === normalizedPath
      );
      if (!file || typeof file.contentBase64 !== 'string') {
        return {
          ok: false,
          code: 'current_binary_asset_unavailable',
          reason: `${filePath} could not be verified from a fresh Overleaf ZIP snapshot. Codex did not overwrite it.`
        };
      }
      return { ok: true, file };
    } catch (error) {
      return {
        ok: false,
        code: 'current_binary_asset_unavailable',
        reason: `${filePath} could not be verified before overwrite: ${error.message}`
      };
    }
  }

  function binaryAssetMatchesBaseline(baseFile, currentFile) {
    if (!baseFile || !currentFile) {
      return false;
    }
    const baseContent = normalizeBase64(baseFile.contentBase64);
    const currentContent = normalizeBase64(currentFile.contentBase64);
    if (!baseContent || baseContent !== currentContent) {
      return false;
    }
    const currentSize = Number.isFinite(Number(currentFile.size)) ? Number(currentFile.size) : null;
    return baseFile.size == null || currentSize == null || baseFile.size === currentSize;
  }

  function normalizeBase64(value) {
    return String(value || '').replace(/\s+/g, '');
  }

  function decodeBase64Bytes(contentBase64) {
    try {
      const binary = window.atob(String(contentBase64 || ''));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return { ok: true, bytes };
    } catch (_error) {
      return {
        ok: false,
        code: 'invalid_binary_asset_content',
        reason: 'Binary asset content was not valid base64.'
      };
    }
  }

  function createAssetFile(filePath, bytes) {
    const name = String(filePath || '').split('/').filter(Boolean).pop() || 'asset';
    const type = inferAssetMimeType(filePath);
    if (typeof File === 'function') {
      return new File([bytes], name, { type });
    }
    return new Blob([bytes], { type });
  }

  function inferAssetMimeType(filePath) {
    const normalized = String(filePath || '').toLowerCase();
    if (normalized.endsWith('.pdf')) {
      return 'application/pdf';
    }
    if (normalized.endsWith('.png')) {
      return 'image/png';
    }
    if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) {
      return 'image/jpeg';
    }
    if (normalized.endsWith('.svg')) {
      return 'image/svg+xml';
    }
    return 'application/octet-stream';
  }

  async function applyFileTreeOperation(operation, options = {}) {
    const freshness = await checkFileTreeOperationFreshness(operation, options.baseFileLookup);
    if (!freshness.ok) {
      return freshness;
    }

    const manager = findFileTreeManager();
    const methodNames = fileTreeMethodNames(operation.type);

    for (const methodName of methodNames) {
      const method = manager?.[methodName];
      if (typeof method !== 'function') {
        continue;
      }

      let mutationAttempted = false;
      try {
        mutationAttempted = true;
        if (operation.type === 'create') {
          await method.call(manager, operation.path, operation.content || '');
        } else if (operation.type === 'rename' || operation.type === 'move') {
          await method.call(manager, operation.path, operation.to);
        } else if (operation.type === 'delete') {
          await method.call(manager, operation.path);
        }
        const verified = await verifyFileTreeOperation(operation);
        if (!verified.ok) {
          return verified;
        }
        recordFileTreeOperationSuccess(operation, options.baseFileLookup);
        return {
          ok: true,
          method: `fileTreeManager.${methodName}`,
          verified: true
        };
      } catch (error) {
        if (mutationAttempted) {
          return {
            ok: false,
            code: 'file_tree_operation_unverified',
            reason: `Overleaf file-tree method ${methodName} did not complete cleanly after it was invoked. Codex stopped instead of trying another method that could stack a second partial change.`,
            method: `fileTreeManager.${methodName}`,
            error: error?.message || String(error || '')
          };
        }
        // Try the next known method name.
      }
    }

    return {
      ok: false,
      reason: 'No supported Overleaf file-tree method was detected'
    };
  }

  async function verifyFileTreeOperation(operation) {
    await delay(120);
    const sourcePath = operation.path;
    const targetPath = operation.to;

    if (operation.type === 'create') {
      if (!projectPathExists(sourcePath)) {
        return fileTreeVerificationFailed(operation, `${sourcePath} 没有出现在 Overleaf 文件树中。`);
      }
      if (typeof operation.content === 'string' && window.CodexOverleafProjectFiles.isTextProjectPath(sourcePath)) {
        const opened = await openFileByPath(sourcePath);
        if (!opened.ok) {
          return fileTreeVerificationFailed(operation, `${sourcePath} 创建后无法打开验证内容。`);
        }
        const verified = await verifyActiveEditorText(operation.content, sourcePath, 600);
        if (!verified.ok) {
          return fileTreeVerificationFailed(operation, `${sourcePath} 创建后内容没有和 Codex 预期一致。`);
        }
      }
      return { ok: true };
    }

    if (operation.type === 'delete') {
      return projectPathExists(sourcePath)
        ? fileTreeVerificationFailed(operation, `${sourcePath} 仍然存在。`)
        : { ok: true };
    }

    if (operation.type === 'rename' || operation.type === 'move') {
      if (!targetPath || !projectPathExists(targetPath)) {
        return fileTreeVerificationFailed(operation, `${targetPath || '目标路径'} 没有出现在 Overleaf 文件树中。`);
      }
      if (projectPathExists(sourcePath)) {
        return fileTreeVerificationFailed(operation, `${sourcePath} 仍然存在。`);
      }
      return { ok: true };
    }

    return { ok: true };
  }

  function fileTreeVerificationFailed(operation, reason) {
    return {
      ok: false,
      code: 'file_tree_verification_failed',
      reason: `Overleaf 文件树操作没有被确认：${reason} Codex 已停止把这次操作标记为成功。`,
      operationType: operation?.type || '',
      path: operation?.path || '',
      to: operation?.to || ''
    };
  }

  async function checkFileTreeOperationFreshness(operation, baseFileLookup) {
    if (!baseFileLookup) {
      return { ok: true };
    }

    if (!operation.path) {
      return {
        ok: false,
        code: 'missing_operation_path',
        reason: `Cannot safely ${operation.type || 'modify'} a file without a target path.`
      };
    }

    if (operation.type === 'create') {
      if (baseFileLookup.has(operation.path)) {
        return {
          ok: false,
          code: 'path_exists_in_snapshot',
          reason: `${operation.path} 在任务开始前已经存在。Codex 没有覆盖它；请改用修改文件或换一个文件名。`
        };
      }
      if (projectPathExists(operation.path)) {
        return {
          ok: false,
          code: 'path_created_since_snapshot',
          reason: `${operation.path} 在任务执行期间被你或协作者新建了，Codex 没有覆盖它。请查看差异后重试。`
        };
      }
      return { ok: true };
    }

    if (!baseFileLookup.has(operation.path)) {
      return {
        ok: false,
        code: 'missing_base_file',
        reason: `${operation.path} 在任务开始时没有被 Codex 读到。Codex 没有覆盖它；请刷新项目内容后重试。`
      };
    }

    const current = await readCurrentTextFileForFreshness(operation.path);
    if (!current.ok) {
      return current;
    }

    const freshness = window.CodexOverleafStaleGuard?.checkOperationFreshness(
      { type: 'edit', path: operation.path },
      current.text,
      baseFileLookup
    ) || { ok: true };
    if (!freshness.ok) {
      return freshness;
    }

    if ((operation.type === 'rename' || operation.type === 'move') && operation.to) {
      if (baseFileLookup.has(operation.to) || projectPathExists(operation.to)) {
        return {
          ok: false,
          code: 'destination_exists',
          reason: `Cannot safely ${operation.type} ${operation.path} to ${operation.to} because the destination already exists.`
        };
      }
    }

    return { ok: true };
  }

  async function readCurrentTextFileForFreshness(filePath) {
    const normalizedPath = normalizeSafeProjectPath(filePath);
    if (!normalizedPath) {
      return invalidProjectPathResult('freshness path');
    }
    const currentPath = getActiveFilePath();
    const previousEditorIdentity = getActiveEditorIdentity();
    const opened = await openFileByPath(normalizedPath, { force: true });
    if (!opened.ok) {
      return {
        ok: false,
        code: 'cannot_verify_current_file',
        reason: `Cannot safely verify ${normalizedPath}; ${opened.reason || 'open failed'}. Re-run Codex on a fresh snapshot.`
      };
    }
    const ready = await waitForEditorDocumentForPath(normalizedPath, previousEditorIdentity, 9000, {
      initialActivePath: currentPath,
      forceSettledOpen: true
    });
    if (!ready.ok) {
      return {
        ...ready,
        code: 'cannot_verify_current_file'
      };
    }

    return {
      ok: true,
      text: ready.text
    };
  }

  function recordFileTreeOperationSuccess(operation, baseFileLookup) {
    if (!baseFileLookup) {
      return;
    }

    if (operation.type === 'create') {
      window.CodexOverleafStaleGuard?.updateExpectedFileContent(
        baseFileLookup,
        operation.path,
        operation.content || ''
      );
    } else if (operation.type === 'delete') {
      window.CodexOverleafStaleGuard?.removeExpectedFile(baseFileLookup, operation.path);
    } else if (operation.type === 'rename' || operation.type === 'move') {
      window.CodexOverleafStaleGuard?.moveExpectedFile(baseFileLookup, operation.path, operation.to);
    }
  }

  function fileTreeMethodNames(type) {
    return {
      create: ['createDoc', 'createFile', 'addDoc', 'addFile'],
      rename: ['renameEntity', 'renameFile', 'renameDoc'],
      move: ['moveEntity', 'moveFile', 'moveDoc'],
      delete: ['deleteEntity', 'deleteFile', 'deleteDoc', 'removeEntity']
    }[type] || [];
  }

  function normalizeOperationPaths(operation) {
    if (!operation || typeof operation !== 'object') {
      return operation;
    }
    const normalized = {
      ...operation,
      path: typeof operation.path === 'string'
        ? normalizeSafeProjectPath(operation.path)
        : operation.path,
      to: typeof operation.to === 'string'
        ? normalizeSafeProjectPath(operation.to)
        : operation.to
    };
    if (typeof operation.path === 'string' && !normalized.path) {
      normalized.invalidProjectPath = true;
    }
    if (typeof operation.to === 'string' && !normalized.to) {
      normalized.invalidProjectDestinationPath = true;
    }
    return normalized;
  }

  function validateOperationProjectPaths(operation) {
    if (!operation || typeof operation !== 'object') {
      return { ok: true };
    }
    if (operation.invalidProjectPath || (requiresOperationPath(operation) && !operation.path)) {
      return invalidProjectPathResult('operation path');
    }
    if (operation.invalidProjectDestinationPath || (requiresOperationDestinationPath(operation) && !operation.to)) {
      return invalidProjectPathResult('operation destination path');
    }
    return { ok: true };
  }

  function requiresOperationPath(operation) {
    return ['edit', 'create', 'delete', 'rename', 'move', 'binary-create', 'overwrite-binary'].includes(operation.type);
  }

  function requiresOperationDestinationPath(operation) {
    return operation.type === 'rename' || operation.type === 'move';
  }

  function normalizeBaseFilesForSafety(files) {
    if (!Array.isArray(files)) {
      return files;
    }
    return files
      .map(file => {
        if (!file || typeof file.path !== 'string') {
          return null;
        }
        const filePath = normalizeSafeProjectPath(file.path);
        return filePath ? { ...file, path: filePath } : null;
      })
      .filter(Boolean);
  }

  function collectOperationPaths(operations = []) {
    const paths = new Set();
    for (const rawOperation of operations || []) {
      const operation = normalizeOperationPaths(rawOperation);
      for (const value of [operation?.path, operation?.to]) {
        if (typeof value === 'string' && value) {
          paths.add(value);
        }
      }
    }
    return Array.from(paths);
  }






  function normalizeTrackedChangeRefs(refs = []) {
    const seen = new Set();
    const normalized = [];
    for (const ref of refs || []) {
      if (!ref || typeof ref !== 'object') {
        continue;
      }
      const key = typeof ref.key === 'string' ? ref.key : '';
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      const hasPath = typeof ref.path === 'string';
      const hasExplicitPath = hasPath && ref.path.trim() !== '';
      const path = hasPath ? normalizeSafeProjectPath(ref.path) : '';
      normalized.push({
        key,
        id: typeof ref.id === 'string' ? ref.id : '',
        path,
        invalidProjectPath: hasExplicitPath && !path,
        label: compact(String(ref.label || ''), 180)
      });
    }
    return normalized;
  }


  function mergeTrackedChangeRefs(refs = []) {
    return normalizeTrackedChangeRefs(refs);
  }







  function isEditorUndoControl(node) {
    if (!node || isInsideCodexPanel(node) || node.disabled) {
      return false;
    }
    if (/^(true|disabled)$/i.test(node.getAttribute?.('aria-disabled') || '')) {
      return false;
    }
    const signal = normalizeReviewingSignalText(readNodeSignalText(node));
    if (/\b(?:redo|重做)\b/i.test(signal)) {
      return false;
    }
    return /\bundo\b|撤销/i.test(signal);
  }


    async function applyOperationsForBridge(operationsOrOptions, options = {}) {
      if (Array.isArray(operationsOrOptions)) {
        // Welcome-panel + write-guard: defense-in-depth
        // also runs on the array-shaped entry. T2 only guarded the
        // payload-object branch; if any future caller goes straight to the
        // array entry without `options.runProjectId`, the router would have
        // silently dispatched. Mirror the same `editor_project_id_unavailable`
        // failure shape the payload branch and the page-side guard already
        // emit.
        const writeGuardBlock = checkWritebackRunProjectId(options);
        if (writeGuardBlock) return writeGuardBlock;
        return applyOperations(operationsOrOptions, options);
      }
      const payload = operationsOrOptions || {};
      // Welcome-panel + write-guard: defense-in-depth.
      // The pageBridge wrapper already runs the runProjectId guard, but a
      // future caller could reach the router directly. A missing or empty
      // `runProjectId` on the payload-shaped call blocks the write with the
      // same `editor_project_id_unavailable` shape the page-side guard uses.
      const writeGuardBlock = checkWritebackRunProjectId(payload);
      if (writeGuardBlock) return writeGuardBlock;
      return applyOperations(payload.operations || [], payload);
    }

    function checkWritebackRunProjectId(params) {
      const runProjectId = params && typeof params.runProjectId === 'string' ? params.runProjectId : '';
      if (runProjectId) return null;
      // operation: {} (not null) — batch-level guard fired before any per-op
      // dispatch; matches the abortDispatchResult shape in pageBridge.js and
      // avoids crashing downstream audit / transcript code that reads
      // operation.path without a null guard.
      return {
        ok: false,
        applied: [],
        skipped: [{
          operation: {},
          result: {
            ok: false,
            code: 'editor_project_id_unavailable',
            reason: 'Writeback request did not carry runProjectId.',
            failure: {
              code: 'editor_project_id_unavailable',
              stage: 'write',
              severity: 'blocked',
              userMessage: 'Codex could not confirm which Overleaf project the editor is showing, so it did not write.',
              nextAction: 'Refresh Overleaf and retry; if it persists, reload the extension.',
              retryable: true,
              terminalState: 'blocked',
              changedDocument: false,
              evidence: { runProjectId: null }
            }
          }
        }]
      };
    }

    async function verifySaveState(paths = [], timeoutMs = 5000) {
      const result = deps.waitForSaveState
        ? await deps.waitForSaveState({ deadlineMs: timeoutMs })
        : { ok: false, state: 'unavailable' };
      const verified = result.ok === true && result.state === 'verified_saved';
      return {
        verified,
        unverifiedPaths: verified ? [] : (paths || [])
      };
    }

  function buildNoTraceUndoBlockedResult(operations, disabled) {
    return {
      ok: false,
      applied: [],
      skipped: (operations || []).map(rawOperation => ({
        operation: normalizeOperationPaths(rawOperation),
        result: {
          ok: false,
          code: disabled?.code || 'reviewing_disable_failed',
          reason: disabled?.reason || '无法确认 Overleaf Reviewing/Track Changes 已关闭；为避免撤销也留下新的留痕，Codex 没有执行撤销。'
        }
      })),
      reviewingPolicy: {
        policy: 'no-trace-undo',
        disabled: false,
        restored: false,
        disable: summarizeReviewingToggleResult(disabled)
      }
    };
  }

  function buildReviewingRequiredBlockedResult(operations, reviewing) {
    return {
      ok: false,
      applied: [],
      skipped: (operations || []).map(rawOperation => ({
        operation: normalizeOperationPaths(rawOperation),
        result: {
          ok: false,
          code: reviewing?.code || 'reviewing_not_enabled',
          reason: reviewing?.reason || 'Overleaf Reviewing/Track Changes was not confirmed before writing. Codex did not change this file.',
          reviewing: reviewing?.reviewing || null
        }
      })),
      reviewing
    };
  }

  function buildEditingRequiredBlockedResult(operations, editing) {
    return {
      ok: false,
      applied: [],
      skipped: (operations || []).map(rawOperation => ({
        operation: normalizeOperationPaths(rawOperation),
        result: {
          ok: false,
          code: editing?.code || 'editing_not_confirmed',
          reason: editing?.reason || 'Overleaf Editing mode was not confirmed before writing. Codex did not change this file.',
          reviewing: editing?.reviewing || null
        }
      })),
      reviewing: editing
    };
  }

    // Tracked-changes lifecycle — carved to trackedChangesLifecycle.js in
    // v1.8.0 (structural-debt phase 7, #117). Loaded just before this file
    // in the manifest's page-script list; the Node test path requires it.
    const trackedChangesLifecycleModule = (typeof window !== 'undefined' && window.CodexOverleafTrackedChangesLifecycle)
      || (typeof module === 'object' && module.exports ? require('./trackedChangesLifecycle.js') : null)
      || (typeof globalThis !== 'undefined' ? globalThis.CodexOverleafTrackedChangesLifecycle : null);
    const {
      acceptTrackedChanges,
      rejectTrackedChanges,
      collectTrackedChangeRefsForPaths,
      waitForTrackedChangeDiff
    } = trackedChangesLifecycleModule.create({
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
    });

    return {
      applyOperations: applyOperationsForBridge,
      rejectTrackedChanges,
      acceptTrackedChanges,
      verifySaveState
    };
  }

  function fallbackNormalizeSafeProjectPath(value) {
    const text = String(value || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '').trim();
    if (!text || text.split('/').some(part => !part || part === '.' || part === '..')) {
      return '';
    }
    return text;
  }

  return { create };
});
