(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../shared/failureReasons'), require('../shared/i18n'), require('../shared/agentTranscript'));
  else root.CodexOverleafModuleRegistry.define('RunCompletionMeta', ['FailureReasons', 'I18n', 'AgentTranscript'], factory);
})(typeof window !== 'undefined' ? window : globalThis, function (FailureReasons, I18n, AgentTranscript) {
  'use strict';

  function projectCompletionConclusion(event, run, locale = 'en', options = {}) {
    const structured = event?.detailStructured;
    const raw = options.flat ? options.text : String(structured?.conclusion || '');
    if (structured?.conclusionSource) {
      if (structured.conclusionSource.key !== 'writeback'
        && !['en', 'zh'].some(language => AgentTranscript.projectProductConclusion(structured.conclusionSource, language) === raw)) return raw;
      return AgentTranscript.projectProductConclusion(structured.conclusionSource, locale, options.localizeCompileReason, raw) ?? raw;
    }
    // Legacy cancellation has a unique adjacent producer-owned lifecycle event.
    // Text alone, status alone, and a user's/model's matching answer confer no identity.
    const events = Array.isArray(run?.events) ? run.events : [];
    const matches = events.map((item, index) => ({ item, index })).filter(({ item }) => item.kind === 'report'
      && (structured ? item.detailStructured === structured : item.detail === event.detail));
    const previous = matches.length === 1 ? events[matches[0].index - 1] : null;
    if (run?.status !== 'cancelled' || event.kind !== 'report' || event.status !== 'completed'
      || !['Task report', '本轮完成报告'].includes(event.title)
      || previous?.activity?.kind !== 'lifecycle' || previous.activity.state !== 'cancelled'
      || previous.activity.target !== 'cancelled' || previous.streamRole || previous.guidanceId
      || !['Current Codex task was cancelled.', '已中断当前 Codex 任务。'].includes(previous.title)) return raw;
    const source = { origin: 'product', key: 'cancelled' };
    const en = AgentTranscript.projectProductConclusion(source, 'en'), zh = AgentTranscript.projectProductConclusion(source, 'zh');
    const known = options.flat ? [`Conclusion: ${en}`, `结论：${zh}`] : [en, zh];
    if (!known.includes(raw)) return raw;
    const projected = AgentTranscript.projectProductConclusion(source, locale);
    return options.flat ? (locale === 'zh' ? `结论：${projected}` : `Conclusion: ${projected}`) : projected;
  }

  const FLAT_REPORT_STATUS_SECTIONS = [
    { key: 'saveState', prefixes: ['Save:', '保存：'], en: 'Save', zh: '保存' },
    { key: 'unchangedReason', prefixes: ['Why nothing changed:', '未修改原因：'], en: 'Why nothing changed', zh: '未修改原因' },
    { key: 'writeResult', prefixes: ['Write result:', '写入结果：'], en: 'Write result', zh: '写入结果' },
    { key: 'undo', prefixes: ['Undo:', '可撤销：'], en: 'Undo', zh: '可撤销' },
    { key: 'nextStep', prefixes: ['Next:', '下一步：'], en: 'Next', zh: '下一步' }
  ];

  // Reports persist the language used when the run finished. Re-project only
  // product-owned metadata; model conclusions and custom reasons stay intact.
  const META_COPY = {
    unchangedReason: [
      ['This run was Ask mode.', '这轮是只问不改。'],
      ['You cancelled this change.', '你取消了这轮修改。'],
      ['No file changes need to sync back to Overleaf.', '没有产生需要同步回 Overleaf 的文件改动。'],
      ['No approved file changes remain to sync back to Overleaf.', '没有剩余已确认的文件改动需要同步回 Overleaf。']
    ],
    undo: [['this run has no reversible writes', '本轮没有可撤销的写入']],
    saveState: [['Saved', '已确认保存'],
      ['Pending confirmation; check save status', '待确认，可检查保存状态']],
    nextStep: [
      ['Review the skipped items in this report, then retry after resolving them.', '请查看本轮报告中的跳过项，处理后可以重试。'],
      ['Nothing was written in this run. Review the skipped reasons, fix them, and retry.', '这轮没有任何内容写入。请查看跳过原因，处理后重试。'],
      ['Review the skipped reasons. You can use "Undo written parts" to roll back what already reached Overleaf, then fix conflicts and retry.', '请查看跳过原因。已写入的部分可以点击“撤销已写入部分”回退，处理冲突后再重试。'],
      ['Resolve the issue above, then retry.', '请处理上面的原因后重试。'],
      ['You can continue asking, or add more @context and run another check.', '可以继续追问，或加入更多 @context 后再检查。'],
      ['Review these tracked changes in Overleaf.', '请在 Overleaf 中查看这些文件的留痕修改。'],
      ['You can continue the conversation, or adjust @context and run again.', '可以继续追问，或调整 @context 后重新运行。'],
      ['The first queued follow-up will start next.', '接下来会自动启动队首的后续任务。'],
      ['Edit the task and run again.', '可以修改任务后重新运行。'],
      ['Continue the conversation, or switch to Auto to let Codex edit files.', '可以继续追问，或切换到自动写入后让 Codex 修改文件。'],
      ['Switch to Auto only when you want Codex to edit files.', '只有希望 Codex 修改文件时，才需要切换到自动写入。'],
      ['Review the synced file in Overleaf.', '请在 Overleaf 中查看同步后的文件。'],
      ['Check Overleaf manually before running again. Local mirror refresh and auto compile were skipped.', '再次运行前请先手动检查 Overleaf。本地 mirror 刷新和自动编译已跳过。'],
      ['Switch Overleaf to Reviewing/Track Changes manually and rerun, or turn off Track before writing.', '请在 Overleaf 手动切到 Reviewing/Track Changes 后重新运行，或关闭“留痕”再写入。'],
      ['The main agent must review and adopt the withheld files before syncing them.', '主代理需核对并接管未同步文件后再写回。'],
      ['Select the intended region again and request only changes within it. Valid written parts can be undone.', '请重新选择目标范围，仅请求修改该范围。已写入的合法部分可撤销。'],
      ['Reload the Overleaf project or reopen the .tex file you want to process, then retry.', '请刷新 Overleaf 项目或重新打开要处理的 .tex 文件后再试。'],
      ['Retry with an explicit target such as @file:main.tex and the exact section to edit; if this repeats, open Technical Details.', '请带上明确目标重试，例如 @file:main.tex 和具体要修改的小节；如果重复出现，请打开 Technical Details。'],
      ['Restart Codex Overleaf or start a new run if the installed skill is not visible immediately.', '如果新安装的 skill 没有立刻出现，请重启 Codex Overleaf 或开始新一轮运行。'],
      ['If files still need to be deleted, rerun and confirm deletion separately.', '如果仍需要删除文件，请重新运行并单独确认删除。'],
      ['Expand the write result, review the skipped reasons, then retry after fixing them.', '请展开写入结果查看跳过原因，处理后可以重试。'],
      ['Adjust the task description and run again.', '可以调整任务描述后重新运行。'],
      ['Continue the conversation or run the next task.', '可以继续追问，或运行下一项任务。']
    ]
  };

  let errorNextSteps;
  const errorNextStepTemplates = [];
  function localizeErrorNextStep(value, tx) {
    if (!errorNextSteps) {
      errorNextSteps = new Map();
      const add = pair => {
        if (!pair.every(text => typeof text === 'string' && text)) return;
        if (pair.every(text => text.includes('{file}'))) {
          for (const template of pair) {
            const parts = template.split('{file}');
            if (parts.length === 2) errorNextStepTemplates.push({ pair,
              pattern: new RegExp('^' + parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('([^\\r\\n]*?)') + '$') });
          }
        }
        for (const text of pair) if (!errorNextSteps.has(text)) errorNextSteps.set(text, pair);
      };
      // Reuse the producer's own bilingual copy rather than maintain another
      // translation catalog. Only exact, known next-step prose is accepted.
      for (const key of Object.keys(I18n?.MESSAGES?.en || {})) {
        if (/^failureReason_.+_next$/.test(key)) add([I18n.MESSAGES.en[key], I18n.MESSAGES.zh[key]]);
      }
      const catalog = FailureReasons?.FAILURE_CODE_CATALOG || {};
      for (const [code, entry] of Object.entries(catalog)) {
        const key = `failureReason_${code}_next`;
        const pair = [I18n?.MESSAGES?.en?.[key], I18n?.MESSAGES?.zh?.[key]];
        if (entry.fallbackNextAction && pair.every(Boolean)) errorNextSteps.set(entry.fallbackNextAction, pair);
      }
      const legacyInputs = ['Mode must be "ask" or "auto"', 'Agent returned invalid JSON',
        'Could not parse Codex output', 'timed out', 'output limit exceeded',
        'unsupported_parameter reasoning.summary', 'quota', 'checkpoint', 'changed while Codex was working'];
      if (AgentTranscript?.translateRawError) {
        for (const message of [...Object.keys(catalog), ...legacyInputs]) {
          add(['en', 'zh'].map(locale => AgentTranscript.translateRawError(message, { locale }).nextStep));
        }
        add(['en', 'zh'].map(locale => AgentTranscript.translateRawError('', { locale, codexReturned: true }).nextStep));
      }
    }
    const pair = errorNextSteps.get(value);
    if (pair) return tx(...pair);
    for (const entry of errorNextStepTemplates) {
      const match = entry.pattern.exec(String(value || ''));
      if (match) return tx(...entry.pair).replace('{file}', () => match[1]);
    }
    return value;
  }

  function localizeMetaRow(row, options) {
    if (!row || typeof row !== 'object') return row;
    const entry = FLAT_REPORT_STATUS_SECTIONS.find(item => item.key === row.key);
    if (!entry) return row;
    const { tx } = options;
    let value = row.value;
    const pair = (META_COPY[row.key] || []).find(values => values.includes(value));
    if (pair) value = tx(...pair);
    if (row.key === 'nextStep') value = localizeErrorNextStep(value, tx);
    if (row.key === 'writeResult') {
      const counts = /^(?:已写入 (\d+) 项，跳过 (\d+) 项|wrote (\d+) items?, skipped (\d+) items?)$/.exec(String(value || ''));
      if (counts) {
        const written = Number(counts[1] ?? counts[3]), skipped = Number(counts[2] ?? counts[4]);
        value = tx(`wrote ${written} item${written === 1 ? '' : 's'}, skipped ${skipped} item${skipped === 1 ? '' : 's'}`,
          `已写入 ${written} 项，跳过 ${skipped} 项`);
      }
    }
    if (row.key === 'undo') {
      const count = /^(?:可撤销本轮 (\d+) 项写入|this run has (\d+) reversible writes?)$/.exec(String(value || ''));
      if (count) {
        const n = Number(count[1] ?? count[2]);
        value = tx(`this run has ${n} reversible write${n === 1 ? '' : 's'}`, `可撤销本轮 ${n} 项写入`);
      }
    }
    if (['nextStep', 'unchangedReason'].includes(row.key) && options.getLocale && options.tr) {
      value = FailureReasons?.localizeFailureMessage?.(value, options.getLocale(), key => {
        const translated = options.tr(key);
        return translated === key ? undefined : translated;
      }) ?? value;
    }
    return { ...row, label: tx(entry.en, entry.zh), value };
  }

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

  function projectCompletionBody(body, tx = value => value) {
    if (typeof body !== 'string' || !body) return body;
    const sections = [['Checked', '检查范围'], ['Findings', '发现'], ['Planned changes', '计划修改'],
      ['Changes', '修改'], ['Skipped', '跳过原因']];
    let rest = body, previous = -1, language;
    const projected = [];
    while (rest) {
      let found;
      for (let index = previous + 1; index < sections.length && !found; index++) {
        for (const locale of [0, 1]) {
          const prefix = sections[index][locale] + (locale ? '：\n' : ':\n');
          if ((language === undefined || locale === language) && rest.startsWith(prefix)) {
            found = { index, locale, prefix }; break;
          }
        }
      }
      if (!found) return body;
      language = found.locale;
      previous = found.index;
      rest = rest.slice(found.prefix.length);
      const heading = tx(sections[previous][0] + ':', sections[previous][1] + '：');
      // Skipped may contain arbitrary model/error prose. Only a complete,
      // exact product-owned governance block can be re-projected.
      if (previous === sections.length - 1) {
        if (!/^- [^\r\n]+/.test(rest)) return body;
        projected.push(heading + '\n' + projectGovernanceSkippedBody(rest, tx));
        return projected.join('\n\n');
      }
      const boundary = rest.indexOf('\n\n');
      const items = boundary < 0 ? rest : rest.slice(0, boundary);
      if (!/^- [^\r\n]+(?:\n- [^\r\n]+)*$/.test(items)) return body;
      projected.push(heading + '\n' + items);
      if (boundary < 0) return projected.join('\n\n');
      rest = rest.slice(boundary + 2);
      if (!rest) return body;
    }
    return body;
  }

  function projectGovernanceSkippedBody(body, tx) {
    const locale = tx('en', 'zh');
    const lookup = key => I18n.t(locale, key);
    const operationLabels = { edit: '编辑', create: '新建', delete: '删除', move: '移动', rename: '重命名' };
    const pattern = /(^|\n)- ([^\r\n]+?)(?:: (edit|create|delete|move|rename|binary-create|overwrite-binary) was not written|：(编辑|新建|删除|移动|重命名|binary-create|overwrite-binary)没有写入)\n([ \t]*)(?:Reason|原因): ([^\r\n]+)\n\5(?:Stage|阶段): (?:unknown|preflight)\n\5(?:Code|代码): (unknown_legacy_failure|governance_blocked|governance_readonly|governance_writable_allowlist)\n\5(?:Next|下一步): ([^\r\n]+)(?=\n- |$)/g;
    return body.replace(pattern, (block, prefix, file, enOperation, zhOperation, indent, message, code, next) => {
      const display = FailureReasons.formatFailureReasonForDisplay({ code: 'unknown_legacy_failure', userMessage: message }, locale, lookup);
      if (!['governance_blocked', 'governance_readonly', 'governance_writable_allowlist'].includes(display.code)) return block;
      if (code !== 'unknown_legacy_failure' && code !== 'governance_blocked' && code !== display.code) return block;
      const nextKeys = [display.code, 'unknown_legacy_failure'].flatMap(value => [
        FailureReasons.FAILURE_CODE_CATALOG[value]?.fallbackNextAction,
        I18n.t('en', `failureReason_${value}_next`), I18n.t('zh', `failureReason_${value}_next`)
      ]);
      if (!nextKeys.includes(next)) return block;
      const operation = enOperation || Object.keys(operationLabels).find(key => operationLabels[key] === zhOperation) || zhOperation;
      const header = tx(`${file}: ${operation} was not written`, `${file}：${operationLabels[operation] || operation}没有写入`);
      const failure = { code: display.code, stage: 'preflight', userMessage: display.userMessage, nextAction: display.nextAction };
      return `${prefix}- ${header}\n${AgentTranscript.formatFailureBlock(failure, locale, indent)}`;
    });
  }

  function projectCompletionMeta(meta, run, options) {
    const { tx, trackedChangeInFlight, isTrackedChangeLifecycleRun, projectRunSettlement } = options;
    if (!Array.isArray(meta) || !run) return meta;
    const undone = run.undoStatus === 'applied' || run.trackedChangeStatus === 'rejected';
    const rows = (undone ? meta.filter(row => row?.key !== 'saveState') : meta).map(row => localizeMetaRow(row, options))
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

  return { splitFlatCompletionReport, projectCompletionConclusion, projectCompletionBody, projectCompletionMeta, summarizeCompletionMeta };
});
