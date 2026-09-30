(function initCodexOverleafRunResultActions(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafRunResultActions = api;
})(typeof window !== 'undefined' ? window : globalThis, function runResultActionsFactory() {
  'use strict';

  function create(deps = {}) {
    const {
      tr,
      getLocale,
      forkRunFromNode,
      document: documentRef = globalThis.document,
      navigator: navigatorRef = globalThis.navigator
    } = deps;

    function configureResultActions(root, run) {
      const actions = root.querySelector('.run-result-actions');
      const reports = root.querySelectorAll('.run-completion-report');
      const report = reports[reports.length - 1];
      if (!actions || !report) return;
      report.append(actions);
      actions.hidden = false;
      configureCopyButton(root);
      configureForkButton(root, run);
      configureCompletedTime(actions, run);
    }

    function configureForkButton(root, run) {
      const existing = root.querySelector('[data-run-fork]');
      const button = existing.cloneNode(true);
      existing.replaceWith(button);
      const available = run.forkSnapshot !== true
        && run.status !== 'running'
        && Boolean(run.codexTurnId)
        && typeof forkRunFromNode === 'function';
      button.hidden = false;
      button.disabled = !available;
      button.title = tr(available ? 'forkRunTitle' : 'forkRunUnavailable');
      button.setAttribute('aria-label', button.title);
      button.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 10h3.5c3.5 0 4.2-4 7.5-4h2m-2.5-2.5L16 6l-2.5 2.5M6.5 10c3.5 0 4.2 4 7.5 4h2m-2.5-2.5L16 14l-2.5 2.5"/></svg>';
      if (!available) return;
      button.addEventListener('click', async event => {
        event.stopPropagation();
        button.disabled = true;
        button.classList.add('is-running');
        try {
          await forkRunFromNode(run.id);
        } catch (_error) {
          button.disabled = false;
          button.classList.remove('is-running');
        }
      });
    }

    function configureCompletedTime(actions, run) {
      const target = actions.querySelector('[data-run-completed-time]');
      const finishedAt = String(run.finishedAt || '').trim();
      const date = finishedAt ? new Date(finishedAt) : null;
      if (!target || !date || !Number.isFinite(date.getTime())) return;
      target.hidden = false;
      target.textContent = new Intl.DateTimeFormat(getLocale(), {
        hour: '2-digit',
        minute: '2-digit'
      }).format(date);
      target.title = date.toLocaleString(getLocale());
    }

    function configureCopyButton(root) {
      const existing = root.querySelector('[data-run-copy]');
      const button = existing.cloneNode(true);
      existing.replaceWith(button);
      const finalAnswer = root.querySelector('.run-completion-report .run-final-answer');
      const copyText = String(finalAnswer?.innerText || finalAnswer?.textContent || '').trim();
      button.hidden = false;
      button.disabled = !copyText;
      button.title = tr('copyConclusionTitle');
      button.setAttribute('aria-label', button.title);
      button.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6.5" y="6.5" width="9" height="9" rx="2"/><path d="M13.5 6.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6.5a2 2 0 0 0 2 2h1.5"/></svg>';
      if (!copyText) return;
      button.addEventListener('click', async event => {
        event.stopPropagation();
        try {
          await writeClipboardText(copyText);
          button.title = tr('copyConclusionDone');
        } catch (_error) {
          button.title = tr('copyConclusionFailed');
        }
        button.setAttribute('aria-label', button.title);
      });
    }

    async function writeClipboardText(text) {
      if (navigatorRef?.clipboard?.writeText) {
        await navigatorRef.clipboard.writeText(text);
        return;
      }
      const textarea = documentRef.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      documentRef.body.append(textarea);
      textarea.select();
      const copied = documentRef.execCommand('copy');
      textarea.remove();
      if (!copied) throw new Error('clipboard_copy_failed');
    }

    return Object.freeze({ configureResultActions, projectUndoAvailability, splitFlatCompletionReport, projectCompletionMeta });
  }


  const FLAT_REPORT_STATUS_SECTIONS = [
    { key: 'saveState', prefixes: ['Save:', '保存：'], en: 'Save', zh: '保存' },
    { key: 'unchangedReason', prefixes: ['Why nothing changed:', '未修改原因：'], en: 'Why nothing changed', zh: '未修改原因' },
    { key: 'writeResult', prefixes: ['Write result:', '写入结果：'], en: 'Write result', zh: '写入结果' },
    { key: 'undo', prefixes: ['Undo:', '可撤销：'], en: 'Undo', zh: '可撤销' },
    { key: 'nextStep', prefixes: ['Next:', '下一步：'], en: 'Next', zh: '下一步' }
  ];

  function splitFlatCompletionReport(text, tx = value => value) {
    const raw = typeof text === 'string' ? text : '';
    if (!raw.trim()) return { body: raw, meta: [] };
    const bodySections = [], meta = [];
    for (const section of raw.split(/\n{2,}/)) {
      const trimmed = section.trim();
      if (!trimmed) continue;
      const entry = trimmed.includes('\n') ? null
        : FLAT_REPORT_STATUS_SECTIONS.find(item => item.prefixes.some(prefix => trimmed.startsWith(prefix)));
      if (entry) {
        const prefix = entry.prefixes.find(value => trimmed.startsWith(value));
        const value = trimmed.slice(prefix.length).trim();
        if (value) {
          meta.push({ key: entry.key, label: tx(entry.en, entry.zh), value });
          continue;
        }
      }
      bodySections.push(trimmed);
    }
    return { body: bodySections.join('\n\n'), meta };
  }

  function projectCompletionMeta(meta, run, options) {
    const { tx, trackedChangeInFlight, isTrackedChangeLifecycleRun, projectRunSettlement } = options;
    if (!Array.isArray(meta) || !run) return meta;
    const inFlight = trackedChangeInFlight?.get(run.id);
    const tracked = isTrackedChangeLifecycleRun(run);
    let undo;
    if (run.undoStatus === 'running' || inFlight === 'reject') {
      undo = tx('Undoing changes...', '正在撤销修改…');
    } else if (run.undoStatus === 'applied' || (tracked && run.trackedChangeStatus === 'rejected')) {
      undo = tx('This run\'s changes have been undone.', '本轮修改已撤销。');
    } else if (tracked && run.trackedChangeStatus === 'accepted') {
      undo = tx('Changes accepted; undo is no longer available.', '修改已接受，无法再撤销。');
    } else if (tracked && run.trackedChangeStatus === 'needs_review'
      && run.undoOperations?.some(operation => operation?.undoCreatedFile?.v === 1)) {
      undo = tx('Undo is incomplete; retry the remaining files.', '撤销未完成，可重试剩余文件。');
    } else if (run.undoStatus === 'partial') {
      undo = projectRunSettlement(run).canUndo
        ? tx('Some changes were undone; remaining changes can still be undone.', '已撤销部分修改，剩余修改仍可撤销。')
        : tx('Some changes were undone.', '已撤销部分修改。');
    }
    if (!undo && !run.saveCheck && !run.saveConfirmedAt) return meta;
    return meta.map(row => row?.key === 'undo' && undo
      ? { ...row, label: tx('Undo', '撤销'), value: undo }
      : row?.key === 'saveState' && (run.saveCheck || run.saveConfirmedAt)
        ? { ...row, label: tx('Save', '保存'), value: run.saveCheck
          ? tx('Pending confirmation', '待确认') : tx('Saved', '已确认保存') }
        : row);
  }

  function projectUndoAvailability(run, projectRunSettlement) {
    const payload = run.recoveryPayload && typeof run.recoveryPayload === 'object'
      ? run.recoveryPayload : run;
    if (!Array.isArray(payload.appliedOperations)) return projectRunSettlement(run);
    // Forward creation/asset writes alone do not provide a rollback. Filter them only for
    // display; preserve the canonical settlement and every real recovery field.
    const appliedOperations = payload.appliedOperations.filter(operation =>
      operation?.type !== 'create' && operation?.type !== 'binary-create' && operation?.type !== 'overwrite-binary');
    if (appliedOperations.length === payload.appliedOperations.length) return projectRunSettlement(run);
    return projectRunSettlement({
      ...run,
      recoveryPayload: { ...payload, appliedOperations }
    });
  }

  return Object.freeze({ create });
});
