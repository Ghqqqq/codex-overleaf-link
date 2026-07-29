(function initCodexOverleafApplyResultFormatters() {
  'use strict';

  // Apply-result / failure-reason formatters carved out of contentRuntime.js
  // (v1.4.7 structural-debt phase 3): the skipped-detail renderer and the
  // bilingual apply/bridge reason formatters. Code moved verbatim; the few
  // runtime collaborators are factory-injected.
  function create(deps = {}) {
    const {
      i18n,
      FailureReasons,
      getLocale,
      tr,
      tx,
      getAppliedEntries,
      getSkippedEntries,
      appendRunEvent
    } = deps;

  function appendApplyResult(result) {
    if (!result) {
      return;
    }
    const appliedEntries = getAppliedEntries(result);
    const skippedEntries = getSkippedEntries(result);
    const applied = appliedEntries.length;
    const skipped = skippedEntries.length;
    const skippedFailures = skippedEntries
      .map(item => normalizeSkippedFailure(item))
      .filter(Boolean);
    const primaryFailure = pickPrimarySkippedFailure(skippedFailures);
    const detail = {
      [tx('Written', '已写入')]: appliedEntries.map(item => ({
        [tr('detailAction')]: formatOperationType(item.operation?.type),
        [tr('detailFile')]: item.operation?.path,
        [tx('Status', '状态')]: item.result?.status
      })),
      [tr('detailSkipped')]: skippedEntries.map(item => buildSkippedDetail(item))
    };
    if (primaryFailure && primaryFailure.nextAction) {
      detail[tr('detailNext')] = primaryFailure.nextAction;
    }
    appendRunEvent({
      title: tx(`Write result: wrote ${applied} item(s), skipped ${skipped}`, `写入结果：已写入 ${applied} 项，跳过 ${skipped} 项`),
      status: skipped ? 'failed' : 'completed',
      detail
    });
  }

  /**
   * Build the per-skipped-entry detail block surfaced in the run-card expand
   * view. Includes the canonical FailureReason fields (Reason/Stage/Code/Next)
   * when the normalizer can produce a usable record, falling back to the
   * legacy parenthesized reason otherwise.
   */
  function buildSkippedDetail(item) {
    const operation = item?.operation || {};
    const base = {
      [tr('detailAction')]: formatOperationType(operation.type),
      [tr('detailFile')]: operation.path,
      [tr('detailReason')]: formatApplyResultReason(item)
    };
    const failure = normalizeSkippedFailure(item);
    if (failure) {
      base[tx('Stage', '阶段')] = failure.stage;
      base[tx('Code', '代码')] = failure.code;
      if (failure.nextAction) {
        base[tr('detailNext')] = failure.nextAction;
      }
    }
    // Always surface the writeback debug payload (signatures, active paths,
    // open diagnostics) on skipped rows — without it a navigation-stage skip
    // is undiagnosable from the UI (v1.6 lesson).
    const debugText = formatApplyResultDebug(item?.result?.debug || item?.result?.diagnostics);
    if (debugText) {
      base[tx('Debug', '调试')] = debugText;
    }
    return base;
  }

  /**
   * Normalize a skipped writeback item into a localized FailureReason. Returns
   * null when the FailureReasons module is unavailable so callers fall back to
   * legacy rendering.
   */
  function normalizeSkippedFailure(item) {
    if (!FailureReasons || !FailureReasons.normalizeFailureReason) return null;
    const failure = FailureReasons.normalizeFailureReason(item?.result, item?.operation || {}, { locale: getLocale() });
    if (!failure || !failure.code) return null;
    const localized = FailureReasons.localizeFailureReason
      ? FailureReasons.localizeFailureReason(failure, getLocale(), failureReasonI18nLookup)
      : { userMessage: failure.userMessage, nextAction: failure.nextAction };
    return Object.assign({}, failure, {
      userMessage: localized.userMessage || failure.userMessage,
      nextAction: localized.nextAction || failure.nextAction
    });
  }

  function pickPrimarySkippedFailure(failures) {
    if (!FailureReasons || !FailureReasons.selectPrimaryFailure) return null;
    return FailureReasons.selectPrimaryFailure(failures);
  }

  function failureReasonI18nLookup(key) {
    if (!i18n || !i18n.t) return undefined;
    const localized = i18n.t(getLocale(), key);
    // i18n.t returns the key itself on miss; treat that as a miss so the
    // catalog fallback wins for codes without bespoke localization.
    return localized && localized !== key ? localized : undefined;
  }

  /**
   * Compact one-liner for toasts, collapsed run-card rows, and single-line
   * debug logs: `<code>: <userMessage truncated to one line>`. Returns ''
   * when the failure or its userMessage is missing.
   * @param {{ code?: string, userMessage?: string } | null} failure
   * @param {number} [maxLength=140]
   * @returns {string}
   */
  function formatFailureReasonOneLiner(failure, maxLength) {
    if (!failure || !failure.code || !failure.userMessage) return '';
    const limit = Number.isFinite(maxLength) ? Math.max(40, Math.floor(maxLength)) : 140;
    const flat = String(failure.userMessage).replace(/\s+/g, ' ').trim();
    const codePrefix = `${failure.code}: `;
    const remaining = Math.max(20, limit - codePrefix.length);
    const truncated = flat.length > remaining ? `${flat.slice(0, remaining - 1).trimEnd()}…` : flat;
    return `${codePrefix}${truncated}`;
  }

  function formatApplyResultReason(item = {}) {
    const result = item.result || {};
    const operation = item.operation || {};
    const key = result.reasonKey || '';
    const code = result.code || '';
    const filePath = result.reasonParams?.filePath || operation.path || operation.from || operation.to || '';
    const withDebug = reason => appendApplyResultDebug(reason, result);
    if (key === 'missingBaseFile' || code === 'missing_base_file') {
      const target = filePath || tx('this file', '这个文件');
      return withDebug(tx(
        `${target} was not read when the task started. Codex did not overwrite it; refresh the project content and retry.`,
        `${target} 在任务开始时没有被 Codex 读到。Codex 没有覆盖它；请刷新项目内容后重试。`
      ));
    }
    if (key === 'staleSnapshot' || code === 'stale_snapshot') {
      const target = filePath || tx('this file', '这个文件');
      return withDebug(tx(
        `${target} changed while Codex was working, so Codex did not overwrite it. Review the diff and retry.`,
        `${target} 在任务执行期间被你或协作者改过，Codex 没有覆盖它。请查看差异后重试。`
      ));
    }
    if (key === 'stalePatchLocation') {
      return withDebug(tx(
        'The edit location no longer matches the current Overleaf content, so nothing was written. Rerun the task.',
        'Codex 要修改的位置已经无法和当前 Overleaf 内容对齐，所以没有写入。请重新运行任务。'
      ));
    }
    if (key === 'stalePatchConflict' || code === 'stale_patch_range') {
      return withDebug(tx(
        'The exact edit location was changed by you or a collaborator, so Codex did not overwrite it. Review the diff and retry.',
        'Codex 要修改的具体位置已经被你或协作者改过，所以没有覆盖它。请查看差异后重试。'
      ));
    }
    if (code === 'stale_patch') {
      return withDebug(tx(
        'This exact text changed since Codex read it, so nothing was written. Rerun after Codex reads the latest Overleaf content.',
        '这处内容已经和 Codex 读取时不同，所以没有写入。请重新运行，让 Codex 先读取你的最新 Overleaf 内容。'
      ));
    }
    if (code === 'invalid_patch') {
      return withDebug(tx(
        'Codex produced an invalid local edit range, so nothing was written.',
        'Codex 生成的局部写入范围无效，所以没有写入。'
      ));
    }
    if (code === 'write_verification_failed') {
      return withDebug(tx(
        'After writing, the editor content did not match Codex\'s expected result, so the write was not marked successful. Reload Overleaf and retry.',
        '写入后读回内容和 Codex 预期不一致，已停止把这次操作标记为成功。请刷新 Overleaf 后重试。'
      ));
    }
    if (code === 'file_tree_verification_failed') {
      return tx(
        'Overleaf did not confirm the file-tree operation, so Codex did not mark it successful.',
        'Overleaf 文件树操作没有被确认，Codex 已停止把这次操作标记为成功。'
      );
    }
    if (code === 'path_exists_in_snapshot') {
      const target = filePath || tx('this file', '这个文件');
      return tx(
        `${target} already existed when the task started. Codex did not overwrite it; edit the file instead or choose another filename.`,
        `${target} 在任务开始前已经存在。Codex 没有覆盖它；请改用修改文件或换一个文件名。`
      );
    }
    if (code === 'path_created_since_snapshot') {
      const target = filePath || tx('this file', '这个文件');
      return tx(
        `${target} was created by you or a collaborator while Codex was working, so Codex did not overwrite it. Review the diff and retry.`,
        `${target} 在任务执行期间被你或协作者新建了，Codex 没有覆盖它。请查看差异后重试。`
      );
    }
    return withDebug(localizeVisibleReason(result.reason || result.error || result.code || tr('unknownReason')));
  }

  function appendApplyResultDebug(reason, result = {}) {
    const debug = result.debug || result.diagnostics;
    const text = formatApplyResultDebug(debug);
    return text ? `${reason} [debug: ${text}]` : reason;
  }

  function formatApplyResultDebug(debug) {
    if (!debug || typeof debug !== 'object') {
      return '';
    }
    const parts = [];
    const add = (key, value) => {
      if (value === undefined || value === null || value === '') {
        return;
      }
      parts.push(`${key}=${String(value)}`);
    };
    add('stage', debug.stage);
    add('rev', debug.revision);
    add('op', debug.operationPath);
    add('active', debug.activePath);
    add('initial', debug.initialActivePath);
    add('last', debug.lastActivePath);
    add('currentLen', debug.current?.length);
    add('currentNorm', debug.current?.normalizedLength);
    add('currentHash', debug.current?.hash);
    add('baseKnown', debug.baseKnown);
    add('baseLen', debug.base?.length);
    add('baseNorm', debug.base?.normalizedLength);
    add('baseHash', debug.base?.hash);
    add('elapsed', debug.elapsedMs);
    add('opened', debug.openedMethod);
    return parts.join(', ');
  }

  function formatBridgeResultReason(result = {}, fallbackPath = '') {
    const code = result.code || '';
    const path = result.path || fallbackPath || '';
    if (getLocale() !== 'en') {
      return localizeVisibleReason(result.reason || result.error || result.code || tr('unknownReason'));
    }
    if (code === 'missing_tracked_changes') {
      return 'No matching Overleaf tracked-change records were found for this run, so Codex did not undo with text patches.';
    }
    if (code === 'tracked_change_file_open_failed') {
      return path
        ? `Could not open ${path} to find this run's tracked changes. Handle them manually in the Overleaf review tools.`
        : 'Could not open the file to find this run\'s tracked changes. Handle them manually in the Overleaf review tools.';
    }
    if (code === 'tracked_change_not_found') {
      return 'No matching tracked changes were found on the Overleaf page for this run.';
    }
    if (code === 'tracked_change_reject_control_not_found') {
      return path
        ? `Some tracked changes in ${path} remain, but the matching Reject button was not found. Reject them manually in Overleaf.`
        : 'Some tracked changes remain, but the matching Reject button was not found. Reject them manually in Overleaf.';
    }
    if (code === 'tracked_change_reject_not_confirmed') {
      return 'Codex clicked Reject, but Overleaf still shows this tracked change. Reject it manually in the Overleaf review panel.';
    }
    if (code === 'tracked_change_accept_control_not_found') {
      return path
        ? `Some tracked changes in ${path} remain, but the matching Accept button was not found. Accept them manually in Overleaf.`
        : 'Some tracked changes remain, but the matching Accept button was not found. Accept them manually in Overleaf.';
    }
    if (code === 'tracked_change_accept_not_confirmed') {
      return 'Codex clicked Accept, but Overleaf still shows this tracked change. Accept it manually in the Overleaf review panel.';
    }
    if (code === 'tracked_change_editor_undo_open_failed') {
      return path ? `Could not open ${path} for Overleaf native undo.` : 'Could not open the file for Overleaf native undo.';
    }
    if (code === 'tracked_change_editor_undo_current_mismatch') {
      return path
        ? `${path} no longer matches this run's written content, so Codex did not use Overleaf native undo.`
        : 'The current content no longer matches this run\'s written content, so Codex did not use Overleaf native undo.';
    }
    if (code === 'editor_undo_control_not_found') {
      return path
        ? `Could not find Overleaf's editor Undo button to undo this run in ${path}.`
        : 'Could not find Overleaf\'s editor Undo button to undo this run.';
    }
    if (code === 'editor_undo_no_progress') {
      return path
        ? `Codex clicked Overleaf Undo, but ${path} did not change.`
        : 'Codex clicked Overleaf Undo, but the file did not change.';
    }
    if (code === 'editor_undo_max_iterations') {
      return path
        ? `${path} did not return to its pre-run content after repeated Overleaf native undo steps. Codex stopped to avoid undoing other edits.`
        : 'The file did not return to its pre-run content after repeated Overleaf native undo steps. Codex stopped to avoid undoing other edits.';
    }
    if (code === 'tracked_change_undo_max_iterations') {
      return path
        ? `${path} still has tracked changes left. Codex stopped to avoid rejecting unrelated edits.`
        : 'Tracked changes are still left. Codex stopped to avoid rejecting unrelated edits.';
    }
    if (code === 'tracked_change_undo_verify_open_failed') {
      return path
        ? `Could not open ${path} after undo to verify content. Reload Overleaf and check manually.`
        : 'Could not open the file after undo to verify content. Reload Overleaf and check manually.';
    }
    if (code === 'tracked_change_undo_verify_failed') {
      return path
        ? `${path} did not return to its pre-run content after rejecting tracked changes. Check this run's changes in the Overleaf review panel.`
        : 'The file did not return to its pre-run content after rejecting tracked changes. Check this run\'s changes in the Overleaf review panel.';
    }
    return localizeVisibleReason(result.reason || result.error || result.code || tr('unknownReason'));
  }

  function localizeVisibleReason(reason) {
    const text = String(reason || '').trim();
    if (!text || getLocale() !== 'en') {
      return text;
    }
    let match = text.match(/^(.+?) 在任务开始时没有被 Codex 读到。Codex 没有覆盖它；请刷新项目内容后重试。$/);
    if (match) {
      return `${match[1]} was not read when the task started. Codex did not overwrite it; refresh the project content and retry.`;
    }
    match = text.match(/^(.+?) 在任务执行期间被你或协作者改过，Codex 没有覆盖它。请查看差异后重试。$/);
    if (match) {
      return `${match[1]} changed while Codex was working, so Codex did not overwrite it. Review the diff and retry.`;
    }
    if (text.includes('Codex 要修改的位置已经无法和当前 Overleaf 内容对齐')) {
      return 'The edit location no longer matches the current Overleaf content, so nothing was written. Rerun the task.';
    }
    if (text.includes('Codex 要修改的具体位置已经被你或协作者改过')) {
      return 'The exact edit location was changed by you or a collaborator, so Codex did not overwrite it. Review the diff and retry.';
    }
    const patchMatch = text.match(/^同步本地 Codex workspace 中的局部文件改动（(\d+) 处）。$/);
    if (patchMatch) {
      const count = Number(patchMatch[1]) || 0;
      return `Synced ${count} local Codex workspace edit${count === 1 ? '' : 's'}.`;
    }
    if (text === '本地 Codex workspace 删除了这个文件。') {
      return 'Local Codex workspace deleted this file.';
    }
    if (text === '同步本地 Codex workspace 中的文件内容。') {
      return 'Synced file content from the local Codex workspace.';
    }
    if (text === '同步本地 Codex workspace 中的新文件。') {
      return 'Synced a new file from the local Codex workspace.';
    }
    return text;
  }

  function formatOperationType(type) {
    const labels = {
      edit: tr('operationEdit'),
      create: tr('operationCreate'),
      rename: tr('operationRename'),
      move: tr('operationMove'),
      delete: tr('operationDelete')
    };
    return labels[type] || type || tr('operationUnknown');
  }

  function formatOperationFiles(operations = []) {
    const files = [];
    const seen = new Set();
    for (const operation of operations || []) {
      const path = operation?.path || operation?.from || operation?.to;
      if (!path || seen.has(path)) {
        continue;
      }
      seen.add(path);
      files.push(path);
    }
    return files.length ? files.join(', ') : tr('noneValue');
  }

    return {
      appendApplyResult,
      failureReasonI18nLookup,
      formatApplyResultReason,
      formatBridgeResultReason,
      localizeVisibleReason,
      formatOperationType,
      formatOperationFiles
    };
  }

  window.CodexOverleafApplyResultFormatters = { create };
})();
