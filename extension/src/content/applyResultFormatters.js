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
    const normalize = FailureReasons.normalizeWritebackFailure || FailureReasons.normalizeFailureReason;
    const failure = normalize(item?.result, item?.operation || {}, { locale: getLocale() });
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
    return (FailureReasons.selectPrimaryWritebackFailure || FailureReasons.selectPrimaryFailure)(failures);
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
    const catalogReason = formatCatalogFailureReason(result, filePath);
    if (catalogReason) return withDebug(catalogReason);
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

  function formatCatalogFailureReason(result, path) {
    if (!FailureReasons?.formatFailureReasonForDisplay) return '';
    // Compact historical settlements can omit canonical validation fields.
    // Their display is still recoverable without re-normalizing stored facts.
    const failure = result.failure && typeof result.failure === 'object'
      ? { ...result.failure, file: result.failure.file || result.file || path }
      : FailureReasons.normalizeFailureReason(result, { path: result.file || path });
    const display = FailureReasons.formatFailureReasonForDisplay(failure, getLocale(), failureReasonI18nLookup);
    return display.localized ? display.message : '';
  }

  function formatBridgeResultReason(result = {}, fallbackPath = '') {
    const path = result.file || result.path || fallbackPath || '';
    return formatCatalogFailureReason(result, path)
      || localizeVisibleReason(result.reason || result.error || result.code || tr('unknownReason'));
  }

  const runtimeOwnedReasonPairs = [
  ['The selected provider no longer exists.', '所选模型服务已不存在。'],
  ['The selected provider has no usable revision.', '所选模型服务没有可用的配置版本。'],
  ['The selected provider revision was not captured for this run.', '本轮任务未记录所选模型服务的配置版本。'],
  ['The selected provider changed after this run was submitted.', '本轮任务提交后，所选模型服务的配置已发生变化。'],
  ['The captured selection is invalid. Attach it again.', '已记录的选区无效，请重新添加。'],
  ['Provider revision must be a finite non-negative integer.', '模型服务配置版本必须是有效的非负整数。'],
  ['A stable matching Overleaf account is required for shared history.', '共享历史需要稳定且匹配的 Overleaf 账号。'],
  ['The background storage connection was lost.', '后台存储连接已断开。'],
  ['Shared history is unavailable. Reload the extension and this page.', '共享历史不可用，请重新加载扩展和当前页面。'],
  ['The shared history lock disconnected.', '共享历史的存储锁连接已断开。'],
  ['Another page is saving history. Retry after it finishes.', '其他页面正在保存历史，请待保存完成后重试。'],
  ['The shared history lock was lost before completion.', '操作完成前，共享历史的存储锁已丢失。'],
  ['A stable account scope is required for durable persistence.', '持久保存需要稳定的账号范围。'],
  ['A cross-realm browser lock is required for durable persistence.', '持久保存需要能够跨页面协调的浏览器锁。'],
  ['Shared session storage is unavailable.', '共享会话存储不可用。'],
  ['Native host request failed.', '本地主机请求失败。'],
  ['Native host disconnected', '本地主机连接已断开。']
];

  function localizeVisibleReason(reason) {
    const text = String(reason || '').trim();
    for (const [en, zh] of runtimeOwnedReasonPairs) {
      if (text === en || text === zh) return tx(en, zh);
    }
    const scoped = /^(?:Scoped persistence failed: |限定范围的持久保存失败：)(invalid_commit|stale_view|revision_conflict|queue_revision_conflict|invalid_queue_mutation|queue_claim_conflict)$/.exec(text);
    if (scoped) return tx(`Scoped persistence failed: ${scoped[1]}`, `限定范围的持久保存失败：${scoped[1]}`);
    const localized = FailureReasons?.localizeFailureMessage?.(text, getLocale(), failureReasonI18nLookup);
    if (localized && localized !== text) return localized;
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
