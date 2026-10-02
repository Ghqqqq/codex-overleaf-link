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

    return Object.freeze({ configureResultActions, projectUndoAvailability, splitFlatCompletionReport, projectCompletionMeta, summarizeCompletionMeta });
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
    const undone = run.undoStatus === 'applied' || run.trackedChangeStatus === 'rejected';
    const rows = undone ? meta.filter(row => row?.key !== 'saveState') : meta;
    const inFlight = trackedChangeInFlight?.get(run.id);
    const tracked = isTrackedChangeLifecycleRun(run);
    const pendingCreatedUndo = tracked && run.trackedChangeStatus === 'needs_review' && run.undoOperations?.some(operation => operation?.undoCreatedFile?.v === 1);
    let undo;
    if (run.undoStatus === 'running' || inFlight === 'reject') {
      undo = tx('Undoing changes...', '正在撤销修改…');
    } else if (run.undoStatus === 'applied' || (tracked && run.trackedChangeStatus === 'rejected')) {
      undo = tx('This run\'s changes have been undone.', '本轮修改已撤销。');
    } else if (tracked && run.trackedChangeStatus === 'accepted') {
      undo = tx('Changes accepted; undo is no longer available.', '修改已接受，无法再撤销。');
    } else if (run.undoStatus === 'partial' || pendingCreatedUndo) {
      undo = hasUndoProgress(run)
        ? projectRunSettlement(run).canUndo
          ? tx(pendingCreatedUndo ? 'Some changes were undone; retry the remaining files.' : 'Some changes were undone; remaining changes can still be undone.', pendingCreatedUndo ? '已撤销部分修改，可重试剩余文件。' : '已撤销部分修改，剩余修改仍可撤销。')
          : tx('Some changes were undone.', '已撤销部分修改。')
        : projectRunSettlement(run).canUndo
          ? tx(pendingCreatedUndo ? 'Undo is incomplete; retry the remaining files.' : 'Undo is incomplete; remaining changes can still be undone.', pendingCreatedUndo ? '撤销未完成，可重试剩余文件。' : '撤销未完成，剩余修改仍可撤销。')
          : tx('Undo is incomplete.', '撤销未完成。');
    }
    if (!undo && !run.saveCheck && !run.saveConfirmedAt) return rows;
    return rows.map(row => row?.key === 'undo' && undo
      ? { ...row, label: tx('Undo', '撤销'), value: undo }
      : row?.key === 'saveState' && (run.saveCheck || run.saveConfirmedAt)
        ? { ...row, label: tx('Save', '保存'), value: run.saveCheck
          ? tx('Pending confirmation', '待确认') : tx('Saved', '已确认保存') }
        : row);
  }

  function hasUndoProgress(run) {
    const failures = run?.settlement?.failures || run?.settlementFacts?.failures || [];
    return (Array.isArray(run?.events) ? run.events : []).some(event => {
      if (!['completed', 'failed'].includes(event?.status) || event.streamRole || ['report', 'guidance', 'stream'].includes(event.kind)) return false;
      const count = String(event.title || '').match(/^(?:Undo result: (?:undone|rejected) (\d+) (?:item\(s\)|file\(s\)|tracked change\(s\)), skipped \d+(?: item\(s\))?|撤销结果：已(?:撤销|拒绝) (\d+) (?:项|条留痕|个文件)，跳过 \d+ (?:项|条))$/);
      if (!(Number(count?.[1] || count?.[2]) > 0)) return false;
      const detail = event.detail || {}, applied = detail.Undone || detail.Rejected || detail['已撤销'] || detail['已拒绝'];
      const skipped = detail.Skipped || detail['跳过'], path = item => item?.File || item?.['文件'];
      return Array.isArray(applied) && Array.isArray(skipped) && applied.some(item =>
        typeof path(item) === 'string' && path(item).trim() && !skipped.some(other => path(other) === path(item))
        && !(Array.isArray(failures) && failures.some(failure => failure?.code === 'undo_not_verified'
          && (!failure.file || failure.file === path(item)))));
    });
  }

  // Generic reasons say nothing beyond "no files were written", so they stay in
  // the details. Both locales match because a report keeps its original locale.
  const GENERIC_UNCHANGED_REASONS = new Set([
    'No file changes need to sync back to Overleaf.', '没有产生需要同步回 Overleaf 的文件改动。',
    'No approved file changes remain to sync back to Overleaf.', '没有剩余已确认的文件改动需要同步回 Overleaf。',
    'This run was Ask mode.', '这轮是只问不改。'
  ]);

  // One summary line for the meta rows: what was written, whether it can be
  // undone, and a pending save. The rows themselves stay behind the disclosure,
  // which opens by itself only when something needs the user's attention.
  function summarizeCompletionMeta(rows, run, { tx, failed = false, unconfirmed = false } = {}) {
    const find = key => String(rows.find(row => row?.key === key)?.value || '').trim();
    const counts = find('writeResult').match(/wrote (\d+) items?, skipped (\d+)|已写入 (\d+) 项，跳过 (\d+) 项/);
    const wrote = Number(counts?.[1] ?? counts?.[3] ?? 0), skipped = Number(counts?.[2] ?? counts?.[4] ?? 0);
    const reason = find('unchangedReason');
    const undone = run?.undoStatus === 'applied' || run?.trackedChangeStatus === 'rejected';
    const savePending = !undone && (Boolean(run?.saveCheck) || (!run?.saveConfirmedAt && /^(?:Pending|待确认)/.test(find('saveState'))));
    const pendingCreatedUndo = run?.trackedChangeStatus === 'needs_review'
      && run.undoOperations?.some(operation => operation?.undoCreatedFile?.v === 1);
    const facts = [];
    if (failed) facts.push({ key: 'write', tone: 'fail', text: unconfirmed ? tx('Write not confirmed', '写入结果未确认') : tx('Write incomplete', '写入未完成') });
    else if (wrote) facts.push({ key: 'write', text: tx(`Wrote ${wrote} item${wrote === 1 ? '' : 's'}`, `已写入 ${wrote} 项`) });
    else if (reason && !GENERIC_UNCHANGED_REASONS.has(reason)) facts.push({ key: 'write', text: tx('Not written: ', '未写入：') + reason.replace(/[.。]$/, '') });
    else facts.push({ key: 'write', text: tx('No files written', '未写入文件') });
    if (skipped) facts.push({ key: 'skip', tone: 'warn', text: tx(`${skipped} skipped`, `跳过 ${skipped} 项`) });
    const undoable = Number(find('undo').match(/(\d+)/)?.[1] || 0);
    const undo = run?.undoStatus === 'running' || /^(?:Undoing changes\.\.\.|正在撤销修改…)$/.test(find('undo')) ? tx('Undoing…', '正在撤销…')
      : run?.undoStatus === 'applied' || run?.trackedChangeStatus === 'rejected' ? tx('Changes undone', '已撤销本轮修改')
        : run?.trackedChangeStatus === 'accepted' ? tx('Changes accepted', '修改已接受')
          : pendingCreatedUndo || run?.undoStatus === 'partial'
            ? (hasUndoProgress(run) ? tx('Partly undone', '已撤销部分修改') : tx('Undo incomplete', '撤销未完成'))
            : undoable ? tx(`${undoable} undoable`, `可撤销 ${undoable} 项`)
              : failed ? '' : tx('Nothing to undo', '无可撤销写入');
    if (undo) facts.push({ key: 'undo', text: undo });
    if (savePending) facts.push({ key: 'save', tone: 'warn', text: tx('Save pending', '保存待确认') });
    const attention = failed || skipped > 0;
    const warnKeys = new Set([...(attention ? ['writeResult', 'nextStep'] : []), ...(savePending ? ['saveState'] : [])]);
    return { facts, open: attention, warnKeys };
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
