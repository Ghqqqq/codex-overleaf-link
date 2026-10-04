(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexOverleafModuleRegistry.define('RunCompletionMeta', [], factory);
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

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
    const rows = (undone ? meta.filter(row => row?.key !== 'saveState') : meta)
      .filter(row => row?.key !== 'recoveryRetention' && row?.key !== 'directoryObservation');
    const pending = run.pendingDirectoryCleanup;
    if (!run.forkSnapshot && pending?.v === 1 && pending.runId === run.id
      && pending.projectId === run.runProjectId && pending.projectId === options.projectId
      && pending.accountScopeId && pending.accountScopeId === options.accountScopeId) {
      const paths = [...new Set((Array.isArray(pending.directories) ? pending.directories : []).filter(item => item?.projectId === pending.projectId
        && typeof item.path === 'string' && item.path && !/^[\\/]|^[A-Za-z]:|[\u0000-\u001f\u007f]/.test(item.path)
        && !item.path.replace(/\\/g, '/').split('/').some(part => !part || part === '.' || part === '..')).map(item => item.path))];
      if (paths.length) rows.push({ key: 'directoryObservation', label: tx('Folders', '文件夹'),
        value: tx('The run recorded these folders at completion; their current status has not been rechecked: ',
          '本轮结束时记录了以下文件夹，当前状态尚未重新核验：') + paths.join(', ') });
    }
    const retentionOmitted = hasOmittedRecoveryRetention(run);
    const inFlight = trackedChangeInFlight?.get(run.id);
    const tracked = isTrackedChangeLifecycleRun(run);
    const pendingFileUndo = tracked && run.trackedChangeStatus === 'needs_review' && run.undoOperations?.some(operation => operation?.undoCreatedFile?.v === 1 || operation?.type === 'create');
    let undo;
    if (run.undoStatus === 'running' || inFlight === 'reject') {
      undo = tx('Undoing changes...', '正在撤销修改…');
    } else if (run.undoStatus === 'applied' || (tracked && run.trackedChangeStatus === 'rejected')) {
      undo = tx('This run\'s changes have been undone.', '本轮修改已撤销。');
    } else if (tracked && run.trackedChangeStatus === 'accepted') {
      undo = tx('Changes accepted; undo is no longer available.', '修改已接受，无法再撤销。');
    } else if (run.undoStatus === 'partial' || pendingFileUndo) {
      undo = hasUndoProgress(run)
        ? projectRunSettlement(run).canUndo
          ? tx(pendingFileUndo ? 'Some changes were undone; retry the remaining files.' : 'Some changes were undone; remaining changes can still be undone.', pendingFileUndo ? '已撤销部分修改，可重试剩余文件。' : '已撤销部分修改，剩余修改仍可撤销。')
          : tx('Some changes were undone.', '已撤销部分修改。')
        : projectRunSettlement(run).canUndo
          ? tx(pendingFileUndo ? 'Undo is incomplete; retry the remaining files.' : 'Undo is incomplete; remaining changes can still be undone.', pendingFileUndo ? '撤销未完成，可重试剩余文件。' : '撤销未完成，剩余修改仍可撤销。')
          : tx('Undo is incomplete.', '撤销未完成。');
    }
    if (!undo && !run.saveCheck && !run.saveConfirmedAt && !retentionOmitted) return rows;
    const projected = rows.map(row => row?.key === 'undo' && undo
      ? { ...row, label: tx('Undo', '撤销'), value: undo }
      : row?.key === 'saveState' && (run.saveCheck || run.saveConfirmedAt)
        ? { ...row, label: tx('Save', '保存'), value: run.saveCheck
          ? tx('Pending confirmation', '待确认') : tx('Saved', '已确认保存') }
        : row);
    if (retentionOmitted) {
      const budget = ['run-budget', 'session-budget'].includes(run.recoveryRetention.reason);
      const directory = run.recoveryRetention.directoryCleanup === true ? tx(
        'Recorded folder observations were not retained; their current status is unknown.',
        '文件夹历史观测记录未保留，当前状态未核验。') : '';
      const recovery = budget
        ? tx('Persistent recovery data was not retained: local recovery budget exceeded. After reload, use Overleaf history to recover.',
          '持久恢复材料未保留：超过本地恢复预算，刷新后请使用 Overleaf 历史恢复。')
        : tx('Persistent recovery data was not retained. After reload, use Overleaf history to recover.',
          '持久恢复材料未保留，刷新后请使用 Overleaf 历史恢复。');
      projected.push({ key: 'recoveryRetention', label: tx('Recovery data', '恢复材料'),
        value: directory && (run.recoveryRetention.coreRetained === true || undone || run.trackedChangeStatus === 'accepted')
          ? directory : [recovery, directory].filter(Boolean).join(' ') });
    }
    return projected;
  }

  function hasOmittedRecoveryRetention(run) {
    return run?.recoveryRetention?.state === 'omitted' && (run.recoveryRetention.directoryCleanup === true
      || (run.undoStatus !== 'applied' && !['accepted', 'rejected'].includes(run.trackedChangeStatus)));
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
    const retentionOmitted = hasOmittedRecoveryRetention(run);
    const savePending = !undone && (Boolean(run?.saveCheck) || (!run?.saveConfirmedAt && /^(?:Pending|待确认)/.test(find('saveState'))));
    const pendingFileUndo = run?.trackedChangeStatus === 'needs_review'
      && run.undoOperations?.some(operation => operation?.undoCreatedFile?.v === 1 || operation?.type === 'create');
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
          : pendingFileUndo || run?.undoStatus === 'partial'
            ? (hasUndoProgress(run) ? tx('Partly undone', '已撤销部分修改') : tx('Undo incomplete', '撤销未完成'))
            : undoable ? tx(`${undoable} undoable`, `可撤销 ${undoable} 项`)
              : failed || retentionOmitted ? '' : tx('Nothing to undo', '无可撤销写入');
    if (undo) facts.push({ key: 'undo', text: undo });
    if (retentionOmitted) facts.push({ key: 'recoveryRetention', tone: 'warn',
      text: run.recoveryRetention.coreRetained === true
        ? tx('Folder observations not retained after reload', '刷新后文件夹观测记录未保留')
        : tx('Recovery data not retained after reload', '刷新后恢复材料未保留') });
    if (savePending) facts.push({ key: 'save', tone: 'warn', text: tx('Save pending', '保存待确认') });
    const attention = failed || skipped > 0 || retentionOmitted;
    const warnKeys = new Set([...(failed || skipped > 0 ? ['writeResult', 'nextStep'] : []),
      ...(retentionOmitted ? ['recoveryRetention'] : []), ...(savePending ? ['saveState'] : [])]);
    return { facts, open: attention, warnKeys };
  }

  return { splitFlatCompletionReport, projectCompletionMeta, summarizeCompletionMeta };
});
