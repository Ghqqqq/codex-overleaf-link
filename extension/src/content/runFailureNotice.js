(function initRunFailureNotice(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/failureReasons'));
  } else {
    root.CodexOverleafModuleRegistry.define('RunFailureNotice', ['FailureReasons'], factory);
  }
})(typeof window !== 'undefined' ? window : globalThis, function runFailureNoticeFactory(FailureReasons) {
  'use strict';

  const REVIEW_CODES = new Set(['write_timeout', 'partial_write_needs_review']);
  const CANCEL_CODES = new Set(['cancelled', 'user_cancelled', 'codex_cancelled']);
  const SNAPSHOT_UNDO_CODES = new Set(['snapshot_undo_current_mismatch', 'snapshot_undo_open_failed', 'snapshot_undo_unavailable']);
  const LOCALIZED_FAILURE_CODES = new Set([...SNAPSHOT_UNDO_CODES, 'tracked_change_not_found', 'file_tree_controls_unavailable']);

  // These exact Page templates survived old settlement compaction after the
  // original machine code was dropped. This compatibility view is never used
  // for recovery permissions, classification or persistence.
  function snapshotUndoDisplayFailure(failure) {
    if (failure?.code !== 'unknown_legacy_failure'
      || LOCALIZED_FAILURE_CODES.has(failure?.evidence?.originalCode)) return failure;
    const message = String(failure.userMessage || '');
    if (message === 'The saved checkpoint is unavailable for this undo.') {
      return { ...failure, code: 'snapshot_undo_unavailable' };
    }
    if (message === '没有在 Overleaf 页面里找到这轮写入对应的留痕记录；Codex 没有用文本补丁伪撤销。') {
      return { ...failure, code: 'tracked_change_not_found' };
    }
    const templates = [
      ['snapshot_undo_current_mismatch', /^(.+) 当前内容或文档身份与本轮撤销检查点不一致；Codex 保留恢复材料并停止撤销。$/],
      ['snapshot_undo_current_mismatch', /^(.+) 当前内容已经不是本轮写入后的内容；为避免覆盖你的后续修改，Codex 不执行快照撤销。$/],
      ['snapshot_undo_open_failed', /^无法打开 (.+) 来执行快照撤销。$/]
    ];
    for (const [code, pattern] of templates) {
      const match = pattern.exec(message);
      if (match && safeProjectPath(match[1]) === match[1]) {
        return { ...failure, code, file: failure.file || match[1] };
      }
    }
    return failure;
  }

  // Old attempts remain in the stored audit trail; a resolved undo must not
  // advertise them as a current failure in the transcript or its summary.
  function projectResolvedUndo(run) {
    if (!run || (run.undoStatus !== 'applied' && run.trackedChangeStatus !== 'rejected')
      || !Array.isArray(run.events)) return run;
    const events = run.events.filter(event => {
      if (event?.status !== 'failed' || event.streamRole
        || ['report', 'guidance', 'stream'].includes(event.kind)) return true;
      return !/^(?:Undo result:\s*(?:undone|rejected)\s+\d+\s+(?:item\(s\)|file\(s\)|tracked change\(s\)),\s*skipped\s+\d+(?:\s+item\(s\))?|撤销结果[：:]\s*已(?:撤销|拒绝)\s*\d+\s*(?:项|条留痕|个文件)，\s*跳过\s*\d+\s*(?:项|条))$/.test(String(event.title || '').trim());
    });
    return events.length === run.events.length ? run : { ...run, events };
  }

  function create({ tr, projectRunSettlement, sanitizeText = value => value,
    document: documentRef = globalThis.document } = {}) {
    const notices = new WeakMap();

    function append(report, event = {}, run = {}) {
      const projection = typeof projectRunSettlement === 'function' && run
        ? projectRunSettlement(run) : null;
      const failure = projection?.primaryFailure || event.failure;
      if (report.dataset.status === 'cancelled' || CANCEL_CODES.has(failure?.code)) return;
      const facts = run?.settlement || run?.settlementFacts || {};
      const unconfirmed = projection?.requiresWriteReview === true || REVIEW_CODES.has(failure?.code)
        || facts.documentEffect === 'possibly-changed'
        || (facts.evidence?.applied === 'unknown' && facts.evidence?.settled === 'needs-review');
      const partial = facts.evidence?.applied === 'partial' || run?.partialWriteback === true;
      if (!failure && !unconfirmed && !partial && report.dataset.status !== 'failed') return;

      const notice = documentRef.createElement('aside');
      notice.className = 'run-feedback';
      notice.dataset.tone = unconfirmed || partial || failure?.terminalState === 'degraded'
        || failure?.terminalState === 'needs_review' ? 'warning' : 'error';
      notice.setAttribute('role', 'note');
      const heading = documentRef.createElement('strong');
      heading.className = 'run-feedback__title';
      heading.textContent = tr(unconfirmed ? 'runFeedbackUnconfirmedTitle'
        : partial ? 'runFeedbackPartialTitle' : 'runFeedbackFailedTitle');
      const message = documentRef.createElement('p');
      const file = safeProjectPath(failure?.file);
      // Persisted messages may have been produced in another language. Render
      // known machine codes through the current panel locale at display time;
      // unknown diagnostics retain their original text and evidence.
      const displayFailure = snapshotUndoDisplayFailure(failure);
      const displayFile = safeProjectPath(displayFailure?.file);
      const localizedCode = LOCALIZED_FAILURE_CODES.has(displayFailure?.code)
        || (displayFailure?.code === 'unknown_legacy_failure' && LOCALIZED_FAILURE_CODES.has(displayFailure?.evidence?.originalCode));
      const localized = localizedCode && FailureReasons?.localizeFailureReason?.({ ...displayFailure, file: displayFile }, undefined, key => {
        const value = tr(key);
        return value && value !== key ? value : undefined;
      });
      const detail = localized?.userMessage || (typeof failure?.userMessage === 'string' ? failure.userMessage : '');
      message.textContent = sanitizeText([displayFile, detail].filter(Boolean).join(': ').slice(0, 1000))
        || tr('runFeedbackGeneric');
      notice.append(heading, message);
      if (unconfirmed) {
        const warning = documentRef.createElement('p');
        warning.textContent = tr('runFeedbackUnconfirmed');
        notice.append(warning);
      }
      notices.set(report, { notice, unconfirmed, failure, file });
      report.append(notice);
    }

    function formatMetaValue(report, row) {
      if (!notices.get(report)?.unconfirmed) return row.value;
      const key = String(row.key || '').toLowerCase().replace(/[^a-z]/g, '');
      const label = String(row.label || '').trim().toLowerCase();
      if (key === 'writeresult' || key === 'next'
        || ['write result', 'next', '\u5199\u5165\u7ed3\u679c', '\u4e0b\u4e00\u6b65'].includes(label)) {
        return tr('runFeedbackUnconfirmedResult');
      }
      return row.value;
    }

    function getRecoveryContext(report) {
      const info = notices.get(report);
      return { target: info?.notice || report, failure: info?.failure, unconfirmed: info?.unconfirmed === true, file: info?.file || '' };
    }

    function prepareRecovery(report, { openFile } = {}) {
      const info = getRecoveryContext(report);
      const target = info.target;
      if (!info.unconfirmed) return { target, handled: false, failure: info.failure };
      const canOpen = Boolean(info.file && typeof openFile === 'function');
      const button = documentRef.createElement('button');
      button.type = 'button';
      button.className = 'run-final-answer__recovery-action';
      button.dataset.recoveryFor = info.failure?.code || 'write_unconfirmed';
      button.textContent = tr(canOpen ? 'runFeedbackReviewFile' : 'runFeedbackReviewDetails', { file: info.file });
      button.addEventListener('click', event => {
        event.stopPropagation();
        if (canOpen) {
          openFile(info.file);
          return;
        }
        const process = report.closest?.('[data-run-id]')?.querySelector?.('[data-run-process]');
        if (process) {
          process.open = true;
          process.scrollIntoView?.({ block: 'nearest' });
        } else {
          button.disabled = true;
          button.title = tr('runFeedbackDetailsUnavailable');
        }
      });
      target.append(button);
      return { target, handled: true, failure: info.failure };
    }

    return Object.freeze({ append, formatMetaValue, getRecoveryContext, prepareRecovery });
  }

  function safeProjectPath(value) {
    if (typeof value !== 'string') return '';
    const path = value.replace(/\\/g, '/');
    return path && !path.startsWith('/') && !/^[A-Za-z]:/.test(path)
      && !path.split('/').includes('..') ? path.slice(0, 300) : '';
  }

  return Object.freeze({ create, projectResolvedUndo });
});
