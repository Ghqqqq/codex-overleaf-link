(function initRunFailureNotice(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafModuleRegistry.define('RunFailureNotice', [], factory);
  }
})(typeof window !== 'undefined' ? window : globalThis, function runFailureNoticeFactory() {
  'use strict';

  const REVIEW_CODES = new Set(['write_timeout', 'partial_write_needs_review']);
  const CANCEL_CODES = new Set(['cancelled', 'user_cancelled', 'codex_cancelled']);

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
      const unconfirmed = REVIEW_CODES.has(failure?.code)
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
      const detail = typeof failure?.userMessage === 'string' ? failure.userMessage : '';
      const file = safeProjectPath(failure?.file);
      message.textContent = sanitizeText([file, detail].filter(Boolean).join(': ').slice(0, 1000))
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

    function prepareRecovery(report, { openFile } = {}) {
      const info = notices.get(report);
      const target = info?.notice || report;
      if (!info?.unconfirmed) return { target, handled: false };
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
      return { target, handled: true };
    }

    return Object.freeze({ append, formatMetaValue, prepareRecovery });
  }

  function safeProjectPath(value) {
    if (typeof value !== 'string') return '';
    const path = value.replace(/\\/g, '/');
    return path && !path.startsWith('/') && !/^[A-Za-z]:/.test(path)
      && !path.split('/').includes('..') ? path.slice(0, 300) : '';
  }

  return Object.freeze({ create, projectResolvedUndo });
});
