(function initRunFailureNotice(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/failureReasons'), require('../shared/agentBrand'));
  } else {
    root.CodexOverleafModuleRegistry.define('RunFailureNotice', ['FailureReasons', 'AgentBrand'], factory);
  }
})(typeof window !== 'undefined' ? window : globalThis, function runFailureNoticeFactory(FailureReasons, AgentBrand) {
  'use strict';

  const REVIEW_CODES = new Set(['write_timeout', 'partial_write_needs_review']);
  const CANCEL_CODES = new Set(['cancelled', 'user_cancelled', 'codex_cancelled']);
  function brandIdForRun(run) {
    const providerId = run?.executionSnapshot?.providerId || run?.providerId;
    if (providerId) return AgentBrand?.brandIdForProvider?.(providerId) || (providerId === 'antigravity' ? 'antigravity' : 'codex');
    return String(run?.codexThreadId || '').trim().startsWith('agy:') ? 'antigravity' : 'codex';
  }
  function interpolate(template, params) {
    if (!params || typeof params !== 'object') return template;
    let out = template;
    for (const name of Object.keys(params)) {
      const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`\\{${escaped}\\}`, 'g'), () => String(params[name]));
    }
    return out;
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

  function create({ tr, I18n, getLocale, projectRunSettlement, sanitizeText = value => value,
    document: documentRef = globalThis.document } = {}) {
    const notices = new WeakMap();
    const trForBrand = (brand, key, params) => {
      if (I18n?.t) {
        const template = I18n.t(getLocale?.() || 'en', key);
        const branded = AgentBrand?.brandText ? AgentBrand.brandText(template, brand) : template;
        return interpolate(branded, params);
      }
      const text = tr(key, params);
      return brand === 'antigravity' && AgentBrand?.brandText ? AgentBrand.brandText(text, brand) : text;
    };

    function append(report, event = {}, run = {}, outcomeTarget = null) {
      const brand = brandIdForRun(run);
      const runTr = (key, params) => trForBrand(brand, key, params);
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

      // A quiet outcome replaces the notice's presentation, not its recovery
      // selection or precedence. Keep the same context for prepareRecovery.
      if (outcomeTarget) {
        notices.set(report, { notice: outcomeTarget, unconfirmed, failure, file: safeProjectPath(failure?.file), brand });
        return;
      }

      const notice = documentRef.createElement('aside');
      notice.className = 'run-feedback';
      notice.dataset.tone = unconfirmed || partial || failure?.terminalState === 'degraded'
        || failure?.terminalState === 'needs_review' ? 'warning' : 'error';
      notice.setAttribute('role', 'note');
      const heading = documentRef.createElement('strong');
      heading.className = 'run-feedback__title';
      heading.textContent = runTr(unconfirmed ? 'runFeedbackUnconfirmedTitle'
        : partial ? 'runFeedbackPartialTitle' : 'runFeedbackFailedTitle');
      const message = documentRef.createElement('p');
      const file = safeProjectPath(failure?.file);
      // Localization is a display projection. Recovery keeps the original
      // failure and its trusted file, even when historical text yields a path.
      const display = FailureReasons?.formatFailureReasonForDisplay?.(failure, getLocale?.(), key => {
        const value = runTr(key);
        return value && value !== key ? value : undefined;
      });
      message.textContent = sanitizeText((display?.message || [file, failure?.userMessage].filter(Boolean).join(': ')).slice(0, 1000))
        || runTr('runFeedbackGeneric');
      notice.append(heading, message);
      if (unconfirmed) {
        const warning = documentRef.createElement('p');
        warning.textContent = runTr('runFeedbackUnconfirmed');
        notice.append(warning);
      }
      notices.set(report, { notice, unconfirmed, failure, file, brand });
      report.append(notice);
    }

    function formatMetaValue(report, row) {
      const info = notices.get(report);
      if (!info?.unconfirmed) return row.value;
      const key = String(row.key || '').toLowerCase().replace(/[^a-z]/g, '');
      const label = String(row.label || '').trim().toLowerCase();
      if (key === 'writeresult' || key === 'next'
        || ['write result', 'next', '\u5199\u5165\u7ed3\u679c', '\u4e0b\u4e00\u6b65'].includes(label)) {
        return trForBrand(info.brand || 'codex', 'runFeedbackUnconfirmedResult');
      }
      return row.value;
    }

    function getRecoveryContext(report) {
      const info = notices.get(report);
      return { target: info?.notice || report, failure: info?.failure, unconfirmed: info?.unconfirmed === true, file: info?.file || '', brand: info?.brand || 'codex' };
    }

    function prepareRecovery(report, { openFile } = {}) {
      const info = getRecoveryContext(report);
      const runTr = (key, params) => trForBrand(info.brand || 'codex', key, params);
      const target = info.target;
      if (!info.unconfirmed) return { target, handled: false, failure: info.failure };
      const canOpen = Boolean(info.file && typeof openFile === 'function');
      const button = documentRef.createElement('button');
      button.type = 'button';
      button.className = 'run-final-answer__recovery-action';
      button.dataset.recoveryFor = info.failure?.code || 'write_unconfirmed';
      button.textContent = runTr(canOpen ? 'runFeedbackReviewFile' : 'runFeedbackReviewDetails', { file: info.file });
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
          button.title = runTr('runFeedbackDetailsUnavailable');
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
