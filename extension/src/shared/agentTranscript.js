(function initAgentTranscript(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory({
      getFailureReasons: function getFailureReasonsCjs() { return require('./failureReasons.js'); },
      getI18n: function getI18nCjs() { return require('./i18n.js'); }
    });
  } else {
    root.CodexOverleafModuleRegistry.define('AgentTranscript', [
      'FailureReasons',
      'I18n'
    ], function createAgentTranscript(FailureReasons, I18n) {
      return factory({
        getFailureReasons: function getFailureReasonsWindow() { return FailureReasons; },
        getI18n: function getI18nWindow() { return I18n; }
      });
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function agentTranscriptFactory(deps) {
  'use strict';

  const getFailureReasonsModule = (deps && deps.getFailureReasons) instanceof Function
    ? deps.getFailureReasons
    : function noFailureReasons() { return null; };
  const getI18nModule = (deps && deps.getI18n) instanceof Function
    ? deps.getI18n
    : function noI18n() { return null; };

  const TECHNICAL_EVENT_PATTERNS = [
    /^agent\.command\./,
    /^native\.task\./,
    /^codex\.prompt\./,
    /^codex\.stdout\./,
    /^codex\.item\./,
    /^codex\.turn\./
  ];

  const OPERATION_LABELS = {
    zh: {
      edit: '编辑',
      create: '新建',
      rename: '重命名',
      move: '移动',
      delete: '删除'
    },
    en: {
      edit: 'edit',
      create: 'create',
      rename: 'rename',
      move: 'move',
      delete: 'delete'
    }
  };

  function normalizeLocale(options = {}) {
    return options?.locale === 'zh' ? 'zh' : 'en';
  }

  function textFor(locale, zh, en) {
    return locale === 'en' ? en : zh;
  }

  function mapAgentEventToActivity(event = {}, options = {}) {
    const locale = normalizeLocale(options);
    const type = String(event.type || '');

    if (isContextCompactionEvent(event)) {
      return formatContextCompactionCheckpoint(event, locale);
    }

    if (type === 'overleaf.sync.started') {
      const fileCount = Number(event.detail?.fileCount) || 0;
      return {
        kind: 'activity',
        visible: true,
        title: fileCount
          ? textFor(locale, `正在同步 Overleaf 项目到本地 Codex workspace：${fileCount} 个文本文件。`, `Syncing the Overleaf project into the local Codex workspace: ${fileCount} text files.`)
          : textFor(locale, '正在同步 Overleaf 项目到本地 Codex workspace。', 'Syncing the Overleaf project into the local Codex workspace.'),
        status: 'running',
        technicalDetail: normalizeRawEvent(event)
      };
    }

    if (type === 'overleaf.sync.completed') {
      const fileCount = Number(event.detail?.fileCount) || 0;
      return {
        kind: 'activity',
        visible: true,
        title: fileCount
          ? textFor(locale, `已同步 ${fileCount} 个文本文件，本地 Codex 将直接处理这份 workspace。`, `Synced ${fileCount} text files. Local Codex will work from this workspace.`)
          : textFor(locale, '已同步 Overleaf 项目，本地 Codex 将直接处理这份 workspace。', 'Synced the Overleaf project. Local Codex will work from this workspace.'),
        status: 'completed',
        technicalDetail: normalizeRawEvent(event)
      };
    }

    if (type === 'overleaf.sync.changes') {
      const files = normalizeStringList(event.detail?.files);
      const changedCount = Number(event.detail?.changedCount) || files.length;
      return {
        kind: 'activity',
        visible: true,
        title: changedCount
          ? textFor(locale, `Codex 本地改动已收集：${formatFilesInline(files, locale)}。`, `Collected local Codex changes: ${formatFilesInline(files, locale)}.`)
          : textFor(locale, 'Codex 没有产生需要同步回 Overleaf 的文件改动。', 'Codex did not produce file changes to sync back to Overleaf.'),
        status: 'completed',
        technicalDetail: normalizeRawEvent(event)
      };
    }

    if (type === 'codex.session.event' || type === 'codex.session.request') {
      return mapCodexSessionEvent(event, locale);
    }

    if (type === 'agent.snapshot.preparing') {
      const fileCount = Number(event.detail?.fileCount) || 0;
      const totalChars = Number(event.detail?.totalChars) || 0;
      return {
        kind: 'activity',
        visible: true,
        title: fileCount
          ? textFor(locale, `正在同步 Overleaf 项目到本地上下文：${fileCount} 个文本文件，约 ${formatCompactNumber(totalChars)} 字符。`, `Syncing the Overleaf project into local context: ${fileCount} text files, about ${formatCompactNumber(totalChars)} characters.`)
          : textFor(locale, '正在同步 Overleaf 项目到本地上下文。', 'Syncing the Overleaf project into local context.'),
        status: 'running',
        technicalDetail: normalizeRawEvent(event)
      };
    }

    if (type === 'agent.snapshot.ready') {
      const fileCount = Number(event.detail?.fileCount) || 0;
      return {
        kind: 'activity',
        visible: true,
        title: fileCount
          ? textFor(locale, `已同步 ${fileCount} 个文本文件，Codex 将基于这份内容继续分析。`, `Synced ${fileCount} text files. Codex will continue from this content.`)
          : textFor(locale, '已同步 Overleaf 项目内容，Codex 将基于这份内容继续分析。', 'Synced the Overleaf project. Codex will continue from this content.'),
        status: 'completed',
        technicalDetail: normalizeRawEvent(event)
      };
    }

    if (type.indexOf('codex.subagent.') === 0) {
      return mapSubagentEvent(event, type, locale);
    }

    if (type === 'codex.exec.started') {
      return {
        kind: 'activity',
        visible: true,
        title: textFor(locale, '本地 Codex 已开始处理这轮任务。', 'Local Codex started this task.'),
        status: 'running',
        technicalDetail: normalizeRawEvent(event)
      };
    }

    if (type === 'codex.exec.completed') {
      const failed = event.status === 'failed' || Number(event.detail?.code) !== 0;
      return {
        kind: 'activity',
        visible: true,
        title: failed ? textFor(locale, '本地 Codex 没有正常完成。', 'Local Codex did not finish normally.') : textFor(locale, '本地 Codex 已完成分析。', 'Local Codex finished analysis.'),
        status: failed ? 'failed' : 'completed',
        technicalDetail: normalizeRawEvent(event)
      };
    }

    if (type === 'codex.command.started' || type === 'codex.command.completed') {
      return summarizeCommandActivity(event, locale);
    }

    if (type === 'codex.agent.message') {
      const title = cleanVisibleText(event.detail?.text || event.title || '');
      if (!title || looksTechnical(title)) {
        return technicalOnly(event, locale);
      }
      return {
        kind: 'activity',
        visible: true,
        title,
        status: event.status === 'failed' ? 'failed' : 'completed',
        technicalDetail: normalizeRawEvent(event)
      };
    }

    if (type === 'codex.agent.result') {
      return {
        kind: 'activity',
        visible: true,
        title: textFor(locale, 'Codex 已整理出本轮结果，正在生成报告。', 'Codex prepared this task result and is generating the report.'),
        status: 'completed',
        technicalDetail: normalizeRawEvent(event)
      };
    }

    if (isTechnicalEventType(type)) {
      return technicalOnly(event, locale);
    }

    const title = cleanVisibleText(event.title || '');
    if (!title || looksTechnical(title)) {
      return technicalOnly(event, locale);
    }

    return {
      kind: 'activity',
      visible: true,
      title,
      status: event.status || 'running',
      technicalDetail: normalizeRawEvent(event)
    };
  }

  // Parallel-subagents lifecycle (v1.6): one human-readable line per state
  // change; worker raw output never streams here (it lives in the queue's
  // result files), so these lines plus the collapsed technical detail are the
  // whole timeline footprint of a fan-out.
  function mapSubagentEvent(event, type, locale) {
    const detail = event.detail || {};
    const label = String(event.title || detail.jobId || '').slice(0, 80);
    const base = {
      kind: 'activity',
      visible: true,
      // Timeline renderers indent/badge subagent rows so parallel workers
      // read as a distinct track instead of flat interleaved lines.
      subagent: true,
      technicalDetail: normalizeRawEvent(event)
    };
    if (type === 'codex.subagent.queued') {
      return { ...base, status: 'running', title: textFor(locale, `↳ 子代理「${label}」已排队。`, `↳ Subagent "${label}" queued.`) };
    }
    if (type === 'codex.subagent.started') {
      const active = Number(detail.activeWorkers) || 0;
      const max = Number(detail.maxWorkers) || 0;
      const slots = active && max ? `${active}/${max}` : '';
      return {
        ...base,
        status: 'running',
        title: slots
          ? textFor(locale, `↳ 子代理「${label}」开始（${slots} 并行）。`, `↳ Subagent "${label}" started (${slots} parallel).`)
          : textFor(locale, `↳ 子代理「${label}」开始。`, `↳ Subagent "${label}" started.`)
      };
    }
    if (type === 'codex.subagent.completed') {
      const seconds = Math.round((Number(detail.durationMs) || 0) / 1000);
      return {
        ...base,
        status: 'completed',
        title: seconds
          ? textFor(locale, `↳ 子代理「${label}」完成（${seconds}s）。`, `↳ Subagent "${label}" completed (${seconds}s).`)
          : textFor(locale, `↳ 子代理「${label}」完成。`, `↳ Subagent "${label}" completed.`)
      };
    }
    if (type === 'codex.subagent.failed') {
      const status = String(detail.status || 'failed');
      const reason = String(detail.reason || '').slice(0, 120);
      const zhStatus = status === 'timeout' ? '超时' : status === 'cancelled' ? '被取消' : '失败';
      const enStatus = status === 'timeout' ? 'timed out' : status === 'cancelled' ? 'was cancelled' : 'failed';
      return {
        ...base,
        status: 'warning',
        title: reason
          ? textFor(locale, `↳ 子代理「${label}」${zhStatus}：${reason}`, `↳ Subagent "${label}" ${enStatus}: ${reason}`)
          : textFor(locale, `↳ 子代理「${label}」${zhStatus}。`, `↳ Subagent "${label}" ${enStatus}.`)
      };
    }
    if (type === 'codex.subagent.rejected') {
      const reason = String(detail.reason || 'rejected');
      return {
        ...base,
        status: 'warning',
        title: textFor(locale, `↳ 子代理任务「${label}」被拒绝（${reason}）。`, `↳ Subagent job "${label}" was rejected (${reason}).`)
      };
    }
    if (type === 'codex.subagent.violation') {
      return {
        ...base,
        status: 'warning',
        title: textFor(locale, `⚠ 子代理改动了未分配给它的文件 ${label}，该改动已丢弃、未写回 Overleaf。如果该文件确实需要修改，请重新运行。`, `⚠ A subagent edited ${label}, which it was not assigned; that change was discarded and not written to Overleaf. Re-run if that file should be edited.`)
      };
    }
    if (type === 'codex.subagent.drained') {
      return {
        ...base,
        status: 'completed',
        title: textFor(locale, '↳ 子代理已全部完成。', '↳ All subagents finished.')
      };
    }
    return { ...base, status: event.status || 'running', title: label };
  }

  function mapCodexSessionEvent(event, locale) {
    const method = String(event.detail?.method || event.title || '');
    const params = event.detail?.params || {};

    if (isContextCompactionEvent(event)) {
      return formatContextCompactionCheckpoint(event, locale);
    }

    if (event.type === 'codex.session.request') {
      return {
        kind: 'activity',
        visible: true,
        title: formatCodexApprovalRequest(method, locale),
        status: 'running',
        technicalDetail: normalizeRawEvent(event)
      };
    }

    if (method === 'thread/started') {
      return {
        kind: 'activity',
        visible: true,
        title: textFor(locale, '本地 Codex session 已创建。', 'Local Codex session created.'),
        status: 'completed',
        technicalDetail: normalizeRawEvent(event)
      };
    }
    if (method === 'turn/started') {
      return {
        kind: 'activity',
        visible: true,
        title: textFor(locale, 'Codex 开始处理这轮请求。', 'Codex started processing this request.'),
        status: 'running',
        technicalDetail: normalizeRawEvent(event)
      };
    }
    if (method === 'turn/completed') {
      return {
        kind: 'activity',
        visible: true,
        title: textFor(locale, 'Codex 完成本地处理，正在准备同步改动。', 'Codex finished local processing and is preparing to sync changes.'),
        status: 'completed',
        technicalDetail: normalizeRawEvent(event)
      };
    }
    if (method === 'turn/plan/updated') {
      return {
        kind: 'activity',
        visible: true,
        title: formatPlanUpdateTitle(params, locale),
        status: 'running',
        detail: formatPlanUpdateDetail(params, locale),
        technicalDetail: normalizeRawEvent(event)
      };
    }
    if (method === 'turn/diff/updated') {
      const changedFiles = extractDiffFileCount(params.diff);
      return {
        kind: 'activity',
        visible: true,
        title: changedFiles
          ? textFor(locale, `Codex 更新了本地文件差异：${changedFiles} 个文件。`, `Codex updated local file diffs: ${changedFiles} file(s).`)
          : textFor(locale, 'Codex 更新了本地文件差异。', 'Codex updated local file diffs.'),
        status: 'running',
        technicalDetail: normalizeRawEvent(event)
      };
    }
    if (method === 'item/started' || method === 'item/completed') {
      return mapThreadItemEvent(params.item, method === 'item/started', event, locale);
    }
    if (method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta') {
      const title = cleanStreamDeltaText(
        params.delta || '',
        method === 'item/reasoning/summaryTextDelta'
      );
      if (!title.length) {
        return technicalOnly(event, locale);
      }
      return {
        kind: 'stream',
        visible: true,
        title,
        status: 'running',
        streamKey: getCodexStreamKey(method, params),
        streamRole: method === 'item/agentMessage/delta' ? 'assistant' : 'reasoning',
        appendText: true
      };
    }
    if (method === 'item/reasoning/summaryPartAdded') {
      return technicalOnly(event, locale);
    }
    if (method === 'item/reasoning/textDelta') {
      return technicalOnly(event, locale);
    }
    if (method === 'item/fileChange/patchUpdated') {
      const files = getPatchChangeFiles(params.changes);
      return {
        kind: 'activity',
        visible: true,
        title: files.length
          ? textFor(locale, `Codex 正在修改本地文件：${formatFilesInline(files, locale)}。`, `Codex is editing local files: ${formatFilesInline(files, locale)}.`)
          : textFor(locale, 'Codex 正在修改本地文件。', 'Codex is editing local files.'),
        status: 'running',
        technicalDetail: normalizeRawEvent(event)
      };
    }
    if (method === 'item/fileChange/outputDelta') {
      return {
        kind: 'activity',
        visible: true,
        title: textFor(locale, 'Codex 正在写入本地文件。', 'Codex is writing local files.'),
        status: 'running',
        technicalDetail: normalizeRawEvent(event)
      };
    }
    if (method === 'model/rerouted') {
      return {
        kind: 'activity',
        visible: true,
        title: textFor(locale, 'Codex 已切换到可用模型继续运行。', 'Codex switched to an available model and continued.'),
        status: 'running',
        technicalDetail: normalizeRawEvent(event)
      };
    }
    if (method === 'warning' || method === 'guardianWarning' || method === 'configWarning') {
      const title = cleanVisibleText(params.message || params.warning || '');
      return {
        kind: 'activity',
        visible: true,
        title: title || textFor(locale, 'Codex 返回了一条运行提示。', 'Codex returned a runtime notice.'),
        status: 'running',
        technicalDetail: normalizeRawEvent(event)
      };
    }

    return technicalOnly(event, locale);
  }

  function isContextCompactionEvent(event = {}) {
    const type = String(event.type || '');
    const method = String(event.detail?.method || event.title || '');
    const label = `${type} ${method}`;
    return /(compact|compaction|compacted)/i.test(label)
      && /(context|thread|turn|conversation|codex)/i.test(label);
  }

  function formatContextCompactionCheckpoint(event = {}, locale = 'en') {
    const method = String(event.detail?.method || event.title || '');
    const running = event.status === 'running' || /(started|starting|begin|prepar)/i.test(method);
    return {
      kind: 'checkpoint',
      visible: true,
      title: running
        ? textFor(locale, '正在压缩上下文，Codex 会继续处理。', 'Compacting context; Codex will continue.')
        : textFor(locale, '上下文已压缩，Codex 继续处理。', 'Context compacted; Codex continued.'),
      status: running ? 'running' : 'completed',
      technicalDetail: normalizeRawEvent(event)
    };
  }

  function mapThreadItemEvent(item = {}, started, event, locale) {
    const status = started ? 'running' : (item.status === 'failed' ? 'failed' : 'completed');
    if (item.type === 'agentMessage') {
      const title = cleanVisibleText(item.text || '');
      if (title) {
        return {
          kind: 'stream',
          visible: true,
          title,
          status,
          streamKey: getItemStreamKey('agent', item),
          streamRole: 'assistant',
          replaceText: true
        };
      }
    }
    if (item.type === 'reasoning') {
      const summary = stripEmptyHtmlCommentPlaceholders(normalizeStringList(item.summary).at(-1));
      if (!started && summary) {
        return {
          kind: 'stream',
          visible: true,
          title: summary,
          status,
          streamKey: getItemStreamKey('reasoning', item),
          streamRole: 'reasoning',
          replaceText: true
        };
      }
      return {
        kind: 'activity',
        visible: true,
        title: started ? textFor(locale, 'Codex 正在分析。', 'Codex is analyzing.') : textFor(locale, 'Codex 完成了一段分析。', 'Codex completed an analysis step.'),
        status,
        technicalDetail: normalizeRawEvent(event)
      };
    }
    if (item.type === 'plan') {
      const title = cleanVisibleText(item.text || '');
      return {
        kind: 'activity',
        visible: true,
        title: title || textFor(locale, 'Codex 更新了计划。', 'Codex updated its plan.'),
        status,
        technicalDetail: normalizeRawEvent(event)
      };
    }
    if (item.type === 'commandExecution') {
      return summarizeCommandActivity({
        type: started ? 'codex.command.started' : 'codex.command.completed',
        status,
        detail: {
          command: item.command,
          output: item.aggregatedOutput,
          exitCode: item.exitCode
        }
      }, locale);
    }
    if (item.type === 'fileChange') {
      const files = getPatchChangeFiles(item.changes);
      return {
        kind: 'activity',
        visible: true,
        title: files.length
          ? (started
            ? textFor(locale, `Codex 正在修改本地文件：${formatFilesInline(files, locale)}。`, `Codex is editing local files: ${formatFilesInline(files, locale)}.`)
            : textFor(locale, `Codex 已修改本地文件：${formatFilesInline(files, locale)}。`, `Codex edited local files: ${formatFilesInline(files, locale)}.`))
          : (started
            ? textFor(locale, 'Codex 正在修改本地文件。', 'Codex is editing local files.')
            : textFor(locale, 'Codex 已完成本地文件修改。', 'Codex finished local file edits.')),
        status,
        technicalDetail: normalizeRawEvent(event)
      };
    }
    if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
      return {
        kind: 'activity',
        visible: true,
        title: started
          ? textFor(locale, `正在使用工具：${cleanVisibleText(item.tool || '本地工具')}。`, `Using tool: ${cleanVisibleText(item.tool || 'local tool')}.`)
          : textFor(locale, `已使用工具：${cleanVisibleText(item.tool || '本地工具')}。`, `Used tool: ${cleanVisibleText(item.tool || 'local tool')}.`),
        status,
        technicalDetail: normalizeRawEvent(event)
      };
    }

    return technicalOnly(event, locale);
  }

  function formatCodexApprovalRequest(method, locale) {
    if (/fileChange\/requestApproval/.test(method)) {
      return textFor(locale, 'Codex 请求写入本地文件，正在按当前模式处理。', 'Codex requested local file writes; handling according to the current mode.');
    }
    if (/commandExecution\/requestApproval/.test(method)) {
      return textFor(locale, 'Codex 请求运行本地命令，正在按当前模式处理。', 'Codex requested a local command; handling according to the current mode.');
    }
    return textFor(locale, 'Codex 请求继续操作，正在按当前模式处理。', 'Codex requested to continue; handling according to the current mode.');
  }

  function getCodexStreamKey(method, params = {}) {
    const itemId = cleanVisibleText(params.itemId || params.item?.id || '');
    if (method === 'item/agentMessage/delta') {
      return `agent:${itemId || 'current'}`;
    }
    if (method === 'item/reasoning/summaryTextDelta') {
      return `reasoning:${itemId || 'current'}`;
    }
    return `${method}:${itemId || 'current'}`;
  }

  function getItemStreamKey(prefix, item = {}) {
    const itemId = cleanVisibleText(item.id || item.itemId || '');
    return `${prefix}:${itemId || 'current'}`;
  }

  function formatPlanUpdateTitle(params = {}, locale = 'en') {
    const steps = Array.isArray(params.plan) ? params.plan : [];
    const active = steps.find(step => step.status === 'in_progress') || steps.find(step => step.status === 'pending');
    const text = cleanVisibleText(active?.step || params.explanation || '');
    return text
      ? textFor(locale, `Codex 计划更新：${text}`, `Codex plan update: ${text}`)
      : textFor(locale, 'Codex 更新了执行计划。', 'Codex updated its plan.');
  }

  function formatPlanUpdateDetail(params = {}, locale = 'en') {
    const steps = Array.isArray(params.plan) ? params.plan : [];
    if (!steps.length) {
      return undefined;
    }
    const labels = locale === 'en'
      ? { pending: 'pending', in_progress: 'in progress', completed: 'completed' }
      : { pending: '待处理', in_progress: '进行中', completed: '已完成' };
    return {
      [textFor(locale, '计划', 'Plan')]: steps
        .map(step => `${labels[step.status] || step.status || '状态'}：${cleanVisibleText(step.step || '')}`)
        .filter(Boolean)
        .join('\n')
    };
  }

  function translateProviderError(text, locale) {
    const rules = [
      {
        pattern: /provider_revision_conflict|active provider changed|provider changed in another tab/i,
        conclusionZh: '这轮没有启动：模型服务配置已在另一个标签页发生变化。',
        conclusionEn: 'This run did not start: the model provider configuration changed in another tab.',
        nextZh: '请刷新模型服务配置，然后重新运行任务。',
        nextEn: 'Refresh the provider configuration, then run the task again.',
        code: 'provider_revision_conflict'
      },
      {
        pattern: /provider_auth_rejected|rejected the API key|denied access for this credential/i,
        conclusionZh: '这轮没有继续：第三方模型服务拒绝了当前 API 密钥。',
        conclusionEn: 'This run did not continue: the third-party provider rejected the current API key.',
        nextZh: '请在 Settings 的模型服务配置中替换 API 密钥并测试连接。',
        nextEn: 'Replace the API key in Model Providers and run Test connection.',
        code: 'provider_auth_rejected'
      },
      {
        pattern: /provider_model_not_found|configured model was not found/i,
        conclusionZh: '这轮没有继续：第三方模型服务中找不到所选模型。',
        conclusionEn: 'This run did not continue: the selected model was not found by the third-party provider.',
        nextZh: '请检查模型 ID，测试连接后重试。',
        nextEn: 'Check the model ID, test the connection, and retry.',
        code: 'provider_model_not_found'
      },
      {
        pattern: /provider_model_not_configured|selected model is not configured|at least one model ID is required/i,
        conclusionZh: '这轮没有启动：当前模型没有配置在启用的模型服务中。',
        conclusionEn: 'This run did not start: the current model is not configured for the active provider.',
        nextZh: '请打开模型服务配置，添加或选择一个可用模型。',
        nextEn: 'Open Model Providers and add or select an available model.',
        code: 'provider_model_not_configured'
      },
      {
        pattern: /provider_protocol_unverified|test connection before (activating|using)/i,
        conclusionZh: '这轮没有启动：自动 API 协议尚未完成验证。',
        conclusionEn: 'This run did not start: the automatic API protocol has not been verified.',
        nextZh: '请在模型服务配置中运行“测试连接”，保存后重试。',
        nextEn: 'Run Test connection in Model Providers, save, and retry.',
        code: 'provider_protocol_unverified'
      },
      {
        pattern: /provider_protocol_incompatible|incompatible with this API protocol/i,
        conclusionZh: '这轮没有继续：端点与所选 API 协议不兼容。',
        conclusionEn: 'This run did not continue: the endpoint is incompatible with the selected API protocol.',
        nextZh: '请切换 Responses 或 Chat Completions，或使用自动检测重新测试。',
        nextEn: 'Switch between Responses and Chat Completions, or test again with Auto detection.',
        code: 'provider_protocol_incompatible'
      },
      {
        pattern: /provider_rate_limited|rate limit was reached/i,
        conclusionZh: '这轮没有完成：第三方模型服务触发了限流。',
        conclusionEn: 'This run did not finish: the third-party provider rate limit was reached.',
        nextZh: '请等待限流窗口恢复后重试。',
        nextEn: 'Wait for the provider rate-limit window to recover, then retry.',
        code: 'provider_rate_limited'
      },
      {
        pattern: /provider_connection_timeout|provider connection.*timed out/i,
        conclusionZh: '这轮没有完成：连接第三方模型服务超时。',
        conclusionEn: 'This run did not finish: the third-party provider connection timed out.',
        nextZh: '请检查端点和网络，或提高模型服务的请求超时后重试。',
        nextEn: 'Check the endpoint and network, or increase the provider timeout before retrying.',
        code: 'provider_connection_timeout'
      },
      {
        pattern: /provider_dns_failed|hostname could not be resolved/i,
        conclusionZh: '这轮没有启动：无法解析第三方模型服务的主机名。',
        conclusionEn: 'This run did not start: the third-party provider hostname could not be resolved.',
        nextZh: '请检查 Base URL 和本机 DNS 后重试。',
        nextEn: 'Check the Base URL and local DNS, then retry.',
        code: 'provider_dns_failed'
      },
      {
        pattern: /provider_tls_failed|TLS verification failed/i,
        conclusionZh: '这轮没有启动：第三方模型服务的 TLS 验证失败。',
        conclusionEn: 'This run did not start: TLS verification failed for the third-party provider.',
        nextZh: '请检查端点证书和 Base URL，修复后重试。',
        nextEn: 'Check the endpoint certificate and Base URL, then retry.',
        code: 'provider_tls_failed'
      },
      {
        pattern: /provider_not_found|active provider no longer exists/i,
        conclusionZh: '这轮没有启动：启用的模型服务已经不存在。',
        conclusionEn: 'This run did not start: the active model provider no longer exists.',
        nextZh: '请在 Settings 中选择内置 Codex 或另一个模型服务。',
        nextEn: 'Select Built-in Codex or another provider in Settings.',
        code: 'provider_not_found'
      },
      {
        pattern: /provider_store_corrupt|provider stores are out of sync|provider store.*invalid/i,
        conclusionZh: '这轮没有启动：本地模型服务配置存储已损坏或不同步。',
        conclusionEn: 'This run did not start: the local provider configuration store is corrupt or out of sync.',
        nextZh: '请打开技术详情，修复或重建本地模型服务配置。',
        nextEn: 'Open Technical Details and repair or rebuild the local provider configuration.',
        code: 'provider_store_corrupt'
      },
      {
        pattern: /provider_store_unavailable|provider settings could not be saved/i,
        conclusionZh: '模型服务操作失败：Native Host 无法访问本地配置存储。',
        conclusionEn: 'The provider operation failed: the Native Host could not access local provider storage.',
        nextZh: '请检查本地目录权限和 Native Host 状态后重试。',
        nextEn: 'Check local directory permissions and Native Host status, then retry.',
        code: 'provider_store_unavailable'
      },
      {
        pattern: /provider_response_invalid|provider connection test failed/i,
        conclusionZh: '这轮没有继续：第三方模型服务返回了不兼容或无效的响应。',
        conclusionEn: 'This run did not continue: the third-party provider returned an incompatible or invalid response.',
        nextZh: '请测试连接并确认服务兼容所选 API 协议。',
        nextEn: 'Test the connection and confirm that the endpoint supports the selected API protocol.',
        code: 'provider_response_invalid'
      }
    ];
    const rule = rules.find(candidate => candidate.pattern.test(text));
    if (!rule) {
      return null;
    }
    return {
      conclusion: textFor(locale, rule.conclusionZh, rule.conclusionEn),
      nextStep: textFor(locale, rule.nextZh, rule.nextEn),
      failureCode: rule.code
    };
  }

  function translateRawError(message, context = {}) {
    const locale = normalizeLocale(context);
    const text = String(message || '');
    // Each branch returns the user-visible {conclusion, nextStep} pair and,
    // when the error maps to a structured FailureReason code in the v1.3.8
    // catalog, the `failureCode`. Callers that emit a content-side failure
    // event can attach the catalog code so the run record carries structured
    // failure data alongside the human-readable text. The string text is kept
    // verbatim because it has mode-aware nuance (e.g. "No files were written"
    // vs "This run did not start") the catalog's fallback strings don't capture.
    const providerError = translateProviderError(text, locale);
    if (providerError) {
      return providerError;
    }
    if (/Mode must be "confirm" or "auto"/i.test(text)) {
      return {
        conclusion: textFor(locale, '这轮没有写入：当前是“只问不改”，但这个任务需要写入权限。', 'No files were written: this task needs write access, but the current mode is Ask.'),
        nextStep: textFor(locale, '请切换到“建议修改”或“自动写入”后重新运行。', 'Switch to Suggest or Auto and run the task again.'),
        failureCode: null  // no direct catalog match — preflight / governance
      };
    }
    if (/Agent returned invalid JSON/i.test(text)) {
      return {
        conclusion: textFor(locale, '这轮没有写入：Codex 已结束，但本地桥接器没有读到可用结果。', 'No files were written: Codex finished, but the local bridge did not receive a usable result.'),
        nextStep: textFor(locale, '请重新运行一次；如果再次失败，请打开技术详情查看本地 Codex 输出。', 'Run it again. If it fails again, open Technical Details to inspect local Codex output.'),
        failureCode: 'codex_result_parse_failed'
      };
    }
    if (/Could not parse Codex output/i.test(text)) {
      return {
        conclusion: textFor(locale, '这轮没有写入：Codex 返回的结果格式不完整。', 'No files were written: Codex returned an incomplete result format.'),
        nextStep: textFor(locale, '请重新运行一次；如果再次失败，请打开技术详情查看原始输出。', 'Run it again. If it fails again, open Technical Details to inspect the raw output.'),
        failureCode: 'codex_result_parse_failed'
      };
    }
    if (/timed out/i.test(text)) {
      return {
        conclusion: textFor(locale, '这轮没有写入：本地 Codex 长时间没有完成。', 'No files were written: local Codex took too long to finish.'),
        nextStep: textFor(locale, '请检查本机 Codex 是否仍在运行；如果没有进展，可以中断后缩小 @context 再重试。', 'Check whether local Codex is still running. If there is no progress, cancel and retry with smaller @context.'),
        failureCode: 'codex_timeout'
      };
    }
    if (/output limit exceeded/i.test(text)) {
      return {
        conclusion: textFor(locale, '这轮没有写入：本地 Codex 输出过长，桥接器停止读取。', 'No files were written: local Codex output was too large, so the bridge stopped reading.'),
        nextStep: textFor(locale, '请缩小 @context 后重试，或在技术详情中查看输出限制。', 'Retry with smaller @context, or open Technical Details to inspect the output limit.'),
        failureCode: 'codex_output_limit'
      };
    }
    if (/codex_not_found|Codex CLI was not found|ENOENT/i.test(text)) {
      return {
        conclusion: textFor(locale, '这轮没有启动：本机没有找到 Codex CLI。', 'This run did not start: Codex CLI was not found locally.'),
        nextStep: textFor(locale, '请确认终端里可以运行 `codex`，然后重新安装 native host 或刷新扩展后重试。', 'Confirm `codex` works in Terminal, then reinstall the native host or reload the extension.'),
        failureCode: 'codex_not_found'
      };
    }
    if (/project_locked|currently in use by codex\.run/i.test(text)) {
      return {
        conclusion: textFor(locale,
          '这轮没有启动：同一个 Overleaf 项目里已经有一轮 Codex 任务正在运行。',
          'This run did not start: another Codex task is already running for this Overleaf project.'),
        nextStep: textFor(locale,
          '请等待当前任务完成，或先取消当前任务后再重试。',
          'Wait for the current task to finish, or cancel it before retrying.'),
        failureCode: 'codex_project_locked'
      };
    }
    if (/unsupported[_ ]parameter/i.test(text) && /reasoning\.summary|summary/i.test(text)) {
      return {
        conclusion: textFor(locale, '这轮没有继续：当前 Codex 模型不支持插件请求的推理摘要参数。', 'This run did not continue: the selected Codex model does not support the requested reasoning summary parameter.'),
        nextStep: textFor(locale, '请刷新扩展并重新运行；插件会按模型能力自动去掉不兼容参数。', 'Reload the extension and run again; the plugin will omit incompatible parameters based on model capability.'),
        failureCode: 'native_protocol_incompatible'
      };
    }
    if (/quota|kQuotaBytes|QUOTA_BYTES/i.test(text)) {
      return {
        conclusion: textFor(locale, 'Codex 结果已经生成，但本地会话记录超出 Chrome 存储配额。', 'Codex produced a result, but local session history exceeded Chrome storage quota.'),
        nextStep: textFor(locale, '请删除一些旧 session，或刷新扩展后重试；这不是论文分析本身失败。', 'Delete older sessions or reload the extension and retry. The paper analysis itself did not fail.'),
        failureCode: 'storage_quota_exceeded'
      };
    }
    if (/checkpoint/i.test(text)) {
      return {
        conclusion: textFor(locale, '这轮没有自动写入：Codex 没有拿到可恢复版本。', 'This run did not auto-write: Codex did not get a recoverable version.'),
        nextStep: textFor(locale, '请切换到“建议修改”，或确认 Overleaf Reviewing 已开启后再用“自动写入”。', 'Switch to Suggest, or confirm Overleaf Reviewing is enabled before using Auto.'),
        failureCode: null  // no current catalog code; preflight reviewing issue
      };
    }
    if (/changed while Codex was working|任务执行期间被你或协作者改过/i.test(text)) {
      return {
        conclusion: textFor(locale, '这轮没有覆盖文件：任务执行期间文件被你或协作者改过。', 'No file was overwritten: a file changed while Codex was working.'),
        nextStep: textFor(locale, '请先确认 Overleaf 当前内容，再重新运行任务。', 'Review the current Overleaf content, then run the task again.'),
        failureCode: 'stale_source_changed'
      };
    }

    // When the caller signals Codex DID produce an answer (assistantMessage
    // arrived on the stream) but an unrelated exception still escaped to the
    // outer catch — the original 'no usable result' copy is wrong-by-design
    // because the user can see Codex's answer in chat. Surface the real
    // shape: Codex returned, post-processing failed, the answer is preserved.
    if (context.codexReturned) {
      return {
        conclusion: textFor(locale,
          'Codex 已经返回了结果，但本地处理这一轮时出错了。',
          'Codex returned a result, but local post-processing of this run failed.'),
        nextStep: textFor(locale,
          '请打开技术详情查看错误。Codex 的回答仍保留在会话中。',
          'Open Technical Details to inspect the error. Codex\'s answer is preserved in the conversation.'),
        failureCode: null  // post-processing path; the real error already attached its own structured failure
      };
    }
    return {
      conclusion: context.mode === 'ask'
        ? textFor(locale, '这轮只问不改没有完成：本地 Codex 没有正常完成，因此没有生成最终说明。', 'This Ask run did not complete: local Codex did not finish normally, so no final answer was generated.')
        : textFor(locale, '这轮任务失败：本地 Codex 没有返回可用结果，未确认任何写入。', 'This task failed: local Codex returned no usable result, so no writes were confirmed.'),
      nextStep: textFor(locale, '请查看技术详情，处理本地 Codex 错误后重试。', 'Open Technical Details, resolve the local Codex error, and retry.'),
      failureCode: 'codex_no_usable_result'
    };
  }

  function buildHumanCompletionReport(input = {}) {
    const locale = normalizeLocale(input);
    const applyResults = normalizeApplyResults(input.applyResults);
    const appliedCount = countApplyResultEntries(applyResults, 'applied');
    const skippedCount = countApplyResultEntries(applyResults, 'skipped');
    const translatedError = input.errorMessage ? translateRawError(input.errorMessage, { mode: input.mode, locale }) : null;
    const userReport = normalizeUserReport(input.userReport);
    const report = userReport || buildFallbackReport(input, {
      appliedCount,
      skippedCount,
      translatedError
    }, locale);

    if (!report.writeResult && (applyResults.length || input.includeWriteResult)) {
      report.writeResult = formatWriteResult(appliedCount, skippedCount, locale);
    }
    if (!report.undo && input.undoCount !== undefined) {
      report.undo = input.undoCount
        ? textFor(locale, `可撤销本轮 ${input.undoCount} 项写入`, `this run has ${input.undoCount} reversible write${Number(input.undoCount) === 1 ? '' : 's'}`)
        : textFor(locale, '本轮没有可撤销的写入', 'this run has no reversible writes');
    }

    const failed = input.status === 'failed' || input.status === 'blocked';
    return {
      title: textFor(locale, '本轮完成报告', 'Task report'),
      status: failed ? 'failed' : 'completed',
      text: formatHumanReport(report, locale),
      structured: buildStructuredHumanReport(report, locale)
    };
  }

  /**
   * Thin wrapper that renders just the fallback final-report text for a
   * writeback `apply` payload. Used by tests and by callers that only need the
   * skipped-block formatting without the full completion-report envelope.
   * @param {{ apply: { applied?: any[], skipped?: any[] }, locale?: string, includeWriteResult?: boolean, status?: string }} input
   * @returns {string}
   */
  function formatFallbackFinalReport(input = {}) {
    const locale = normalizeLocale(input);
    const apply = (input && input.apply) || {};
    const report = buildHumanCompletionReport({
      locale,
      status: input.status || 'failed',
      operations: [],
      applyResults: [apply],
      includeWriteResult: input.includeWriteResult !== false,
      undoCount: 0
    });
    return report.text;
  }

  /**
   * Splits the human report into a conclusion (the human-language outcome),
   * a body of list-style content sections (checked / findings / planned /
   * changes / skipped), and a meta block of run-metadata key/value rows
   * (unchanged reason, write result, undo, next). The renderer uses this to
   * visually demote the meta block — it is system info about the run, not
   * part of Codex's answer. `formatHumanReport` retains the legacy flat-text
   * shape for transcripts, storage fallback, and existing assertions.
   */
  function buildStructuredHumanReport(report = {}, locale = 'en') {
    const conclusion = cleanVisibleMarkdownText(report.conclusion || '');

    const bodySections = [];
    addListSection(bodySections, textFor(locale, '检查范围', 'Checked'), report.checked, locale);
    addListSection(bodySections, textFor(locale, '发现', 'Findings'), report.findings, locale);
    addListSection(bodySections, textFor(locale, '计划修改', 'Planned changes'), report.plannedChanges, locale);
    addListSection(bodySections, textFor(locale, '修改', 'Changes'), report.appliedChanges, locale);
    addStructuredListSection(bodySections, textFor(locale, '跳过原因', 'Skipped'), report.skippedChanges, locale);

    const meta = [];
    const unchangedReason = localizeVisibleReason(report.unchangedReason || '', locale);
    if (unchangedReason) {
      meta.push({
        key: 'unchangedReason',
        label: textFor(locale, '未修改原因', 'Why nothing changed'),
        value: unchangedReason
      });
    }
    const writeResult = cleanVisibleText(report.writeResult || '');
    if (writeResult) {
      meta.push({
        key: 'writeResult',
        label: textFor(locale, '写入结果', 'Write result'),
        value: writeResult
      });
    }
    const undo = cleanVisibleText(report.undo || '');
    if (undo) {
      meta.push({
        key: 'undo',
        label: textFor(locale, '可撤销', 'Undo'),
        value: undo
      });
    }
    const nextStep = cleanVisibleText(report.nextStep || '');
    if (nextStep) {
      meta.push({
        key: 'nextStep',
        label: textFor(locale, '下一步', 'Next'),
        value: nextStep
      });
    }

    return { conclusion, body: bodySections.join('\n\n'), meta };
  }

  function formatHumanReport(report = {}, locale = 'en') {
    const sections = [];
    const conclusion = cleanVisibleMarkdownText(report.conclusion || '');
    if (conclusion) {
      sections.push(textFor(locale, `结论：${conclusion}`, `Conclusion: ${conclusion}`));
    }
    addListSection(sections, textFor(locale, '检查范围', 'Checked'), report.checked, locale);
    addListSection(sections, textFor(locale, '发现', 'Findings'), report.findings, locale);
    addListSection(sections, textFor(locale, '计划修改', 'Planned changes'), report.plannedChanges, locale);
    addListSection(sections, textFor(locale, '修改', 'Changes'), report.appliedChanges, locale);
    const unchangedReason = localizeVisibleReason(report.unchangedReason || '', locale);
    if (unchangedReason) {
      sections.push(textFor(locale, `未修改原因：${unchangedReason}`, `Why nothing changed: ${unchangedReason}`));
    }
    const writeResult = cleanVisibleText(report.writeResult || '');
    if (writeResult) {
      sections.push(textFor(locale, `写入结果：${writeResult}`, `Write result: ${writeResult}`));
    }
    addStructuredListSection(sections, textFor(locale, '跳过原因', 'Skipped'), report.skippedChanges, locale);
    const undo = cleanVisibleText(report.undo || '');
    if (undo) {
      sections.push(textFor(locale, `可撤销：${undo}`, `Undo: ${undo}`));
    }
    const nextStep = cleanVisibleText(report.nextStep || '');
    if (nextStep) {
      sections.push(textFor(locale, `下一步：${nextStep}`, `Next: ${nextStep}`));
    }
    return sections.join('\n\n');
  }

  function buildFallbackReport(input, counts, locale = 'en') {
    const operations = Array.isArray(input.operations) ? input.operations : [];
    const appliedOperations = collectAppliedOperations(input.applyResults);
    const affectedFiles = collectAffectedFiles(operations, input.summary, input.applyResults);
    const noWrites = operations.length === 0 && appliedOperations.length === 0;
    const conclusion = counts.translatedError?.conclusion
      || input.conclusion
      || input.notes
      || (noWrites
        ? textFor(locale, '这轮任务已完成，没有写入 Overleaf 文件。', 'This task completed without writing Overleaf files.')
        : textFor(locale, '这轮任务已完成。', 'This task completed.'));

    return {
      conclusion,
      checked: normalizeStringList(input.checked || input.userReport?.checked),
      findings: normalizeStringList(input.findings),
      plannedChanges: counts.appliedCount ? [] : operations.map(operation => formatOperationLine(operation, locale)),
      appliedChanges: appliedOperations.map(operation => formatOperationLine(operation, locale)),
      skippedChanges: collectSkippedOperations(input.applyResults).map(item => formatSkippedOperationLine(item, locale)),
      unchangedReason: input.unchangedReason || (noWrites ? inferUnchangedReason(input, locale) : ''),
      writeResult: input.writeResult || (counts.appliedCount || counts.skippedCount
        ? formatWriteResult(counts.appliedCount, counts.skippedCount, locale)
        : ''),
      undo: input.undo,
      nextStep: input.nextStep
        || counts.translatedError?.nextStep
        || formatPrimaryFailureNextStep(input.applyResults, locale)
        || formatFallbackNextStep(input, counts.skippedCount, affectedFiles, locale)
    };
  }

  /**
   * Derive the run-level next-step from the highest-priority skipped failure
   * via `selectPrimaryFailure`. Returns '' when no usable primary failure
   * exists, so callers can fall through to the generic copy.
   */
  function formatPrimaryFailureNextStep(applyResults, locale) {
    const failureReasons = getFailureReasonsModule();
    if (!failureReasons || !failureReasons.selectPrimaryFailure || !failureReasons.normalizeFailureReason) {
      return '';
    }
    const skipped = collectSkippedOperations(applyResults);
    if (!skipped.length) {
      return '';
    }
    const failures = skipped.map(item =>
      failureReasons.normalizeFailureReason(item.result, item.operation || {}, { locale })
    ).filter(Boolean);
    const primary = failureReasons.selectPrimaryFailure(failures);
    if (!primary) return '';
    const localized = failureReasons.localizeFailureReason(primary, locale, failureI18nLookup(locale));
    return localized.nextAction || primary.nextAction || '';
  }

  function formatWriteResult(appliedCount, skippedCount, locale = 'en') {
    return textFor(
      locale,
      `已写入 ${appliedCount} 项，跳过 ${skippedCount} 项`,
      `wrote ${appliedCount} item${Number(appliedCount) === 1 ? '' : 's'}, skipped ${skippedCount} item${Number(skippedCount) === 1 ? '' : 's'}`
    );
  }

  function inferUnchangedReason(input, locale = 'en') {
    if (input.mode === 'ask' || input.status === '只问不改') {
      return textFor(locale, '这轮是只问不改。', 'This run was Ask mode.');
    }
    if (input.status === 'rejected') {
      return textFor(locale, '你取消了这轮修改。', 'You cancelled this change.');
    }
    return '';
  }

  function formatFallbackNextStep(input, skippedCount, affectedFiles, locale = 'en') {
    if (skippedCount) {
      return textFor(locale, '请查看本轮报告中的跳过项，处理后可以重试。', 'Review the skipped items in this report, then retry after resolving them.');
    }
    if (input.status === 'blocked' || input.status === 'failed') {
      return textFor(locale, '请处理上面的原因后重试。', 'Resolve the issue above, then retry.');
    }
    if (!affectedFiles.length) {
      return textFor(locale, '可以继续追问，或加入更多 @context 后再检查。', 'You can continue asking, or add more @context and run another check.');
    }
    return textFor(locale, '请在 Overleaf 中查看这些文件的留痕修改。', 'Review these tracked changes in Overleaf.');
  }

  function normalizeUserReport(report) {
    if (!report || typeof report !== 'object') {
      return null;
    }
    return {
      conclusion: cleanVisibleMarkdownText(report.conclusion || ''),
      checked: normalizeStringList(report.checked),
      findings: normalizeStringList(report.findings),
      plannedChanges: normalizeStringList(report.plannedChanges),
      appliedChanges: normalizeStringList(report.appliedChanges),
      skippedChanges: normalizeStringList(report.skippedChanges),
      unchangedReason: cleanVisibleText(report.unchangedReason || ''),
      nextStep: cleanVisibleText(report.nextStep || '')
    };
  }

  function technicalOnly(event, locale = 'en') {
    return {
      kind: 'technical',
      visible: false,
      title: textFor(locale, '技术详情', 'Technical details'),
      status: event?.status || 'info',
      detail: normalizeRawEvent(event)
    };
  }

  function normalizeRawEvent(event = {}) {
    return {
      type: event.type || 'unknown',
      title: event.title || '',
      status: event.status || '',
      timestamp: event.timestamp || '',
      detail: event.detail || {}
    };
  }

  function isTechnicalEventType(type) {
    return TECHNICAL_EVENT_PATTERNS.some(pattern => pattern.test(type));
  }

  function summarizeCommandActivity(event, locale = 'en') {
    const type = String(event.type || '');
    const command = String(event.detail?.command || '');
    const output = String(event.detail?.output || '');
    const commandKind = classifyCommand(command);
    const running = type === 'codex.command.started';
    const failed = event.status === 'failed' || Number(event.detail?.exitCode) > 0;

    if (running) {
      return {
        kind: 'activity',
        visible: true,
        title: formatCommandStartedTitle(commandKind, command, locale),
        status: 'running',
        detail: formatCommandPublicDetail(commandKind, command, locale),
        technicalDetail: normalizeRawEvent(event)
      };
    }

    return {
      kind: 'activity',
      visible: true,
      title: formatCommandCompletedTitle(commandKind, output, failed, locale),
      status: failed ? 'failed' : 'completed',
      detail: formatCommandPublicDetail(commandKind, command, locale),
      technicalDetail: normalizeRawEvent(event)
    };
  }

  function classifyCommand(command) {
    const text = String(command || '').trim();
    if (/^(rg|grep)\b/i.test(text) || /\b(rg|grep)\b/i.test(text)) {
      return 'search';
    }
    if (/^(cat|sed|nl|head|tail|awk)\b/i.test(text)) {
      return 'read';
    }
    if (/\b(latexmk|pdflatex|xelatex|lualatex|bibtex|biber)\b/i.test(text)) {
      return 'compile';
    }
    if (/^(ls|find)\b/i.test(text)) {
      return 'list';
    }
    return 'check';
  }

  function formatCommandStartedTitle(kind, command, locale = 'en') {
    if (kind === 'search') {
      const query = extractSearchQuery(command);
      return query ? textFor(locale, `正在搜索项目内容：${query}`, `Searching project content: ${query}`) : textFor(locale, '正在搜索项目内容。', 'Searching project content.');
    }
    if (kind === 'read') {
      return textFor(locale, '正在读取相关文件内容。', 'Reading related file content.');
    }
    if (kind === 'compile') {
      return textFor(locale, '正在运行 LaTeX 相关检查。', 'Running LaTeX-related checks.');
    }
    if (kind === 'list') {
      return textFor(locale, '正在查看项目文件结构。', 'Inspecting project file structure.');
    }
    return textFor(locale, '正在执行一次本地检查。', 'Running a local check.');
  }

  function formatCommandCompletedTitle(kind, output, failed, locale = 'en') {
    if (failed) {
      if (kind === 'search') {
        return textFor(locale, '搜索没有正常完成。', 'Search did not finish normally.');
      }
      if (kind === 'compile') {
        return textFor(locale, 'LaTeX 检查没有正常完成。', 'LaTeX check did not finish normally.');
      }
      return textFor(locale, '本地检查没有正常完成。', 'Local check did not finish normally.');
    }

    if (kind === 'search') {
      const count = countMeaningfulLines(output);
      return count ? textFor(locale, `搜索完成，找到 ${count} 条相关线索。`, `Search complete: found ${count} relevant line(s).`) : textFor(locale, '搜索完成，没有找到明显相关线索。', 'Search complete: no clearly relevant lines found.');
    }
    if (kind === 'read') {
      return textFor(locale, '相关文件内容已读取。', 'Related file content has been read.');
    }
    if (kind === 'compile') {
      return textFor(locale, 'LaTeX 相关检查已完成。', 'LaTeX-related checks completed.');
    }
    if (kind === 'list') {
      return textFor(locale, '项目文件结构已查看。', 'Project file structure inspected.');
    }
    return textFor(locale, '本地检查已完成。', 'Local check completed.');
  }

  function formatCommandPublicDetail(kind, command, locale = 'en') {
    if (kind !== 'search') {
      return undefined;
    }
    const query = extractSearchQuery(command);
    return query ? { [textFor(locale, '搜索目标', 'Search target')]: query } : undefined;
  }

  function extractSearchQuery(command) {
    const text = String(command || '').trim();
    const match = text.match(/\b(?:rg|grep)\s+(?:-[^\s]+\s+)*(['"]?)([^'"\s][^'"]*?)\1(?:\s|$)/i);
    if (!match) {
      return '';
    }
    return cleanVisibleText(match[2])
      .replace(/[\\{}]/g, '')
      .slice(0, 40);
  }

  function countMeaningfulLines(output) {
    return String(output || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .length;
  }

  function extractDiffFileCount(diff) {
    const files = new Set();
    for (const line of String(diff || '').split(/\r?\n/)) {
      const match = line.match(/^diff --git a\/(.+?) b\//);
      if (match?.[1]) {
        files.add(match[1]);
      }
    }
    return files.size;
  }

  function getPatchChangeFiles(changes = []) {
    const files = [];
    const seen = new Set();
    for (const change of Array.isArray(changes) ? changes : []) {
      const filePath = cleanVisibleText(change?.path || '');
      if (filePath && !seen.has(filePath)) {
        seen.add(filePath);
        files.push(filePath);
      }
    }
    return files;
  }

  function formatFilesInline(files = [], locale = 'en') {
    const values = normalizeStringList(files);
    if (!values.length) {
      return textFor(locale, '没有文件', 'no files');
    }
    if (values.length <= 3) {
      return values.join(locale === 'en' ? ', ' : '、');
    }
    return textFor(
      locale,
      `${values.slice(0, 3).join('、')} 等 ${values.length} 个文件`,
      `${values.slice(0, 3).join(', ')} and ${values.length - 3} more`
    );
  }

  function formatCompactNumber(value) {
    const number = Number(value) || 0;
    if (number >= 1000000) {
      return `${Math.round(number / 100000) / 10}M`;
    }
    if (number >= 1000) {
      return `${Math.round(number / 100) / 10}k`;
    }
    return String(number);
  }

  function looksTechnical(text) {
    const value = String(text || '').trim();
    return /^(\{|\[)/.test(value)
      || /stdout|stderr|schema|JSON|exit[_ ]?code|CODEX_OVERLEAF_EVENT/i.test(value)
      || /^(codex|agent|native)\.[a-z0-9_.-]+/i.test(value)
      || /^[a-z]+(?:\/[a-zA-Z0-9]+)+/.test(value);
  }

  function cleanVisibleText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function cleanStreamDeltaText(text, stripReasoningPlaceholders = false) {
    const normalized = String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/\u00a0/g, ' ');
    return stripReasoningPlaceholders
      ? stripEmptyHtmlCommentPlaceholders(normalized)
      : normalized;
  }

  function stripEmptyHtmlCommentPlaceholders(text) {
    return String(text || '')
      .replace(/<!--[\t \r\n]*-->/g, '')
      .replace(/(^|\n)[\t ]*<!--[\t ]*$/g, '$1')
      .replace(/(^|\n)[\t ]*-->[\t ]*$/g, '$1');
  }

  function cleanVisibleMarkdownText(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[^\S\n]+/g, ' ')
      .split('\n')
      .map(line => line.trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function addListSection(sections, label, values, locale = 'en') {
    const items = normalizeStringList(values);
    if (!items.length) {
      return;
    }
    sections.push(`${label}${locale === 'en' ? ':' : '：'}\n${items.map(item => `- ${item}`).join('\n')}`);
  }

  /**
   * Same as `addListSection` but preserves item-internal newlines so that
   * structured FailureReason blocks (Reason/Stage/Code/Next) survive into the
   * rendered report. Per-item first line gets the `- ` bullet; subsequent
   * lines pass through verbatim (the formatter already indents them).
   */
  function addStructuredListSection(sections, label, values, locale = 'en') {
    const items = normalizeMultilineStringList(values);
    if (!items.length) {
      return;
    }
    sections.push(`${label}${locale === 'en' ? ':' : '：'}\n${items.map(item => `- ${item}`).join('\n')}`);
  }

  function normalizeMultilineStringList(value) {
    const values = Array.isArray(value) ? value : (value ? [value] : []);
    return values
      .map(item => cleanVisibleMarkdownText(item))
      .filter(Boolean);
  }

  function normalizeStringList(value) {
    const values = Array.isArray(value) ? value : (value ? [value] : []);
    return values
      .map(item => cleanVisibleText(item))
      .filter(Boolean);
  }

  function normalizeApplyResults(applyResults) {
    if (!applyResults) {
      return [];
    }
    return Array.isArray(applyResults) ? applyResults.filter(Boolean) : [applyResults];
  }

  function getApplyResultEntries(result, key) {
    const entries = result?.[key];
    return Array.isArray(entries) ? entries : [];
  }

  function countApplyResultEntries(applyResults, key) {
    return normalizeApplyResults(applyResults)
      .reduce((sum, result) => sum + getApplyResultEntries(result, key).length, 0);
  }

  function collectAppliedOperations(applyResults) {
    const operations = [];
    for (const result of normalizeApplyResults(applyResults)) {
      for (const item of getApplyResultEntries(result, 'applied')) {
        if (item?.operation) {
          operations.push(item.operation);
        }
      }
    }
    return operations;
  }

  function collectSkippedOperations(applyResults) {
    const operations = [];
    for (const result of normalizeApplyResults(applyResults)) {
      for (const item of getApplyResultEntries(result, 'skipped')) {
        if (item?.operation) {
          operations.push({
            operation: item.operation,
            result: item.result || {}
          });
        }
      }
    }
    return operations;
  }

  function collectAffectedFiles(operations = [], summary, applyResults = []) {
    const files = [];
    const seen = new Set();
    const add = filePath => {
      if (!filePath || seen.has(filePath)) {
        return;
      }
      seen.add(filePath);
      files.push(filePath);
    };
    for (const filePath of summary?.affectedFiles || []) {
      add(filePath);
    }
    for (const operation of operations || []) {
      add(operation?.path || operation?.from || operation?.to);
    }
    for (const result of normalizeApplyResults(applyResults)) {
      const entries = [
        ...getApplyResultEntries(result, 'applied'),
        ...getApplyResultEntries(result, 'skipped')
      ];
      for (const item of entries) {
        add(item?.operation?.path || item?.operation?.from || item?.operation?.to);
      }
    }
    return files;
  }

  function formatOperationLine(operation, locale = 'en') {
    const labels = OPERATION_LABELS[locale] || OPERATION_LABELS.zh;
    const label = labels[operation?.type] || operation?.type || textFor(locale, '处理', 'process');
    const filePath = operation?.path || operation?.from || operation?.to || textFor(locale, '未知文件', 'unknown file');
    const reason = formatOperationReason(operation, locale);
    return locale === 'en'
      ? (reason ? `${filePath}: ${label} (${reason})` : `${filePath}: ${label}`)
      : (reason ? `${filePath}：${label}（${reason}）` : `${filePath}：${label}`);
  }

  function formatOperationReason(operation, locale = 'en') {
    const key = operation?.reasonKey || '';
    const count = Number(operation?.reasonParams?.count || 0);
    if (key === 'localWorkspaceDelete') {
      return textFor(locale, '本地 Codex workspace 删除了这个文件。', 'Local Codex workspace deleted this file.');
    }
    if (key === 'localWorkspacePatch') {
      return textFor(
        locale,
        `同步本地 Codex workspace 中的局部文件改动（${count || 0} 处）。`,
        `Synced ${count || 0} local Codex workspace edit${Number(count) === 1 ? '' : 's'}.`
      );
    }
    if (key === 'localWorkspaceContent') {
      return textFor(locale, '同步本地 Codex workspace 中的文件内容。', 'Synced file content from the local Codex workspace.');
    }
    if (key === 'localWorkspaceCreate') {
      return textFor(locale, '同步本地 Codex workspace 中的新文件。', 'Synced a new file from the local Codex workspace.');
    }
    return localizeVisibleReason(operation?.reason || '', locale);
  }

  function formatSkippedOperationLine(item, locale = 'en') {
    const operation = item?.operation || {};
    const labels = OPERATION_LABELS[locale] || OPERATION_LABELS.zh;
    const label = labels[operation.type] || operation.type || textFor(locale, '处理', 'process');
    const result = item?.result || {};
    const filePath = operation.path || operation.from || operation.to || (
      result?.failure?.stage === 'write' || result?.code === 'editor_project_id_unavailable' || result?.code === 'aborted_project_changed'
        ? textFor(locale, '写入流程', 'writeback process')
        : textFor(locale, '未知文件', 'unknown file')
    );
    const headerLine = locale === 'en'
      ? `${filePath}: ${label} was not written`
      : `${filePath}：${label}没有写入`;
    const block = formatFailureBlockForResult(result, operation, locale);
    if (block) {
      return `${headerLine}\n${block}`;
    }
    // Last-resort fallback: legacy parenthesized form, only when neither
    // a structured failure nor the normalizer surfaces a usable record.
    const legacyReason = formatSkippedReason(result, operation, locale);
    return locale === 'en'
      ? `${headerLine} (${legacyReason})`
      : `${headerLine}（${legacyReason}）`;
  }

  /**
   * Render a `FailureReason` (already localized) as a four-line indented block:
   *   <indent>Reason: <userMessage>
   *   <indent>Stage: <stage>
   *   <indent>Code: <code>
   *   <indent>Next: <nextAction>   (only when present)
   * The `Next` line is omitted when the failure has no `nextAction`.
   * @param {{ userMessage: string, stage: string, code: string, nextAction?: string }} failure
   * @param {string} locale - 'en' or 'zh'.
   * @param {string} [indent='  '] - String prefix applied to every line.
   * @returns {string}
   */
  function formatFailureBlock(failure, locale, indent) {
    const pad = indent === undefined ? '  ' : indent;
    const i18nModule = getI18nModule();
    const headingKey = label => (
      i18nModule && i18nModule.t ? i18nModule.t(locale, label) : null
    ) || defaultSectionHeading(label, locale);
    const sectionHeading = headingKey('failureReason_section_heading');
    const sectionStage = headingKey('failureReason_section_stage');
    const sectionCode = headingKey('failureReason_section_code');
    const sectionNext = headingKey('failureReason_section_next');
    const lines = [];
    lines.push(`${pad}${sectionHeading}: ${failure.userMessage || ''}`);
    lines.push(`${pad}${sectionStage}: ${failure.stage || ''}`);
    lines.push(`${pad}${sectionCode}: ${failure.code || ''}`);
    if (failure.nextAction) {
      lines.push(`${pad}${sectionNext}: ${failure.nextAction}`);
    }
    return lines.join('\n');
  }

  function defaultSectionHeading(key, locale) {
    const en = {
      failureReason_section_heading: 'Reason',
      failureReason_section_stage: 'Stage',
      failureReason_section_code: 'Code',
      failureReason_section_next: 'Next'
    };
    const zh = {
      failureReason_section_heading: '原因',
      failureReason_section_stage: '阶段',
      failureReason_section_code: '代码',
      failureReason_section_next: '下一步'
    };
    const dict = locale === 'zh' ? zh : en;
    return dict[key] || key;
  }

  /**
   * Build the localized FailureReason block for a skipped writeback item.
   * Returns '' when the failureReasons module is unavailable, which makes
   * callers fall back to the legacy parenthesized form.
   */
  function formatFailureBlockForResult(result, operation, locale) {
    const failureReasons = getFailureReasonsModule();
    if (!failureReasons || !failureReasons.normalizeFailureReason) {
      return '';
    }
    const failure = failureReasons.normalizeFailureReason(result, operation || {}, { locale });
    if (!failure || !failure.code) {
      return '';
    }
    const localized = failureReasons.localizeFailureReason(failure, locale, failureI18nLookup(locale));
    const rendered = Object.assign({}, failure, {
      userMessage: localized.userMessage || failure.userMessage,
      nextAction: localized.nextAction || failure.nextAction
    });
    return formatFailureBlock(rendered, locale, '  ');
  }

  function failureI18nLookup(locale) {
    return function lookup(key) {
      const i18nModule = getI18nModule();
      if (!i18nModule || !i18nModule.t) return undefined;
      const localized = i18nModule.t(locale, key);
      // i18n.t returns the key itself on miss; treat that as miss so the
      // catalog fallback wins for codes without bespoke localization.
      return localized && localized !== key ? localized : undefined;
    };
  }

  function formatSkippedReason(result = {}, operation = {}, locale = 'en') {
    const key = result.reasonKey || '';
    const code = result.code || '';
    const filePath = result.reasonParams?.filePath || operation?.path || operation?.from || operation?.to || '';
    const withDebug = reason => appendSkippedReasonDebug(reason, result);
    if (key === 'missingBaseFile' || code === 'missing_base_file') {
      const target = filePath || textFor(locale, '这个文件', 'this file');
      return withDebug(textFor(
        locale,
        `${target} 在任务开始时没有被 Codex 读到。Codex 没有覆盖它；请刷新项目内容后重试。`,
        `${target} was not read when the task started. Codex did not overwrite it; refresh the project content and retry.`
      ));
    }
    if (key === 'staleSnapshot' || code === 'stale_snapshot') {
      const target = filePath || textFor(locale, '这个文件', 'this file');
      return withDebug(textFor(
        locale,
        `${target} 在任务执行期间被你或协作者改过，Codex 没有覆盖它。请查看差异后重试。`,
        `${target} changed while Codex was working, so Codex did not overwrite it. Review the diff and retry.`
      ));
    }
    if (key === 'stalePatchLocation') {
      return withDebug(textFor(
        locale,
        'Codex 要修改的位置已经无法和当前 Overleaf 内容对齐，所以没有写入。请重新运行任务。',
        'The edit location no longer matches the current Overleaf content, so nothing was written. Rerun the task.'
      ));
    }
    if (key === 'stalePatchConflict' || code === 'stale_patch_range') {
      return withDebug(textFor(
        locale,
        'Codex 要修改的具体位置已经被你或协作者改过，所以没有覆盖它。请查看差异后重试。',
        'The exact edit location was changed by you or a collaborator, so Codex did not overwrite it. Review the diff and retry.'
      ));
    }
    if (code === 'stale_patch') {
      return withDebug(textFor(
        locale,
        '这处内容已经和 Codex 读取时不同，所以没有写入。请重新运行，让 Codex 先读取你的最新 Overleaf 内容。',
        'This exact text changed since Codex read it, so nothing was written. Rerun after Codex reads the latest Overleaf content.'
      ));
    }
    if (code === 'invalid_patch') {
      return withDebug(textFor(
        locale,
        'Codex 生成的局部写入范围无效，所以没有写入。',
        'Codex produced an invalid local edit range, so nothing was written.'
      ));
    }
    if (code === 'write_verification_failed') {
      return withDebug(textFor(
        locale,
        '写入后读回内容和 Codex 预期不一致，已停止把这次操作标记为成功。请刷新 Overleaf 后重试。',
        'After writing, the editor content did not match Codex\'s expected result, so the write was not marked successful. Reload Overleaf and retry.'
      ));
    }
    if (code === 'file_tree_verification_failed') {
      return textFor(
        locale,
        'Overleaf 文件树操作没有被确认，Codex 已停止把这次操作标记为成功。',
        'Overleaf did not confirm the file-tree operation, so Codex did not mark it successful.'
      );
    }
    if (code === 'path_exists_in_snapshot') {
      const target = filePath || textFor(locale, '这个文件', 'this file');
      return textFor(
        locale,
        `${target} 在任务开始前已经存在。Codex 没有覆盖它；请改用修改文件或换一个文件名。`,
        `${target} already existed when the task started. Codex did not overwrite it; edit the file instead or choose another filename.`
      );
    }
    if (code === 'path_created_since_snapshot') {
      const target = filePath || textFor(locale, '这个文件', 'this file');
      return textFor(
        locale,
        `${target} 在任务执行期间被你或协作者新建了，Codex 没有覆盖它。请查看差异后重试。`,
        `${target} was created by you or a collaborator while Codex was working, so Codex did not overwrite it. Review the diff and retry.`
      );
    }
    return withDebug(localizeVisibleReason(result.reason || result.error || result.code || textFor(locale, '未知原因', 'unknown reason'), locale));
  }

  function appendSkippedReasonDebug(reason, result = {}) {
    const debug = result.debug || result.diagnostics;
    const text = formatSkippedReasonDebug(debug);
    return text ? `${reason} [debug: ${text}]` : reason;
  }

  function formatSkippedReasonDebug(debug) {
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

  function localizeVisibleReason(reason, locale = 'en') {
    const text = cleanVisibleText(reason || '');
    if (!text || locale !== 'en') {
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
    if (text.includes('Codex 在本地生成了这些文件，但插件没有同步回 Overleaf')) {
      return text
        .replace('Codex 在本地生成了这些文件，但插件没有同步回 Overleaf：', 'Codex generated these local files, but the extension did not sync them back to Overleaf:')
        .replace(/：LaTeX 构建产物，默认不写回。/g, ': LaTeX build artifact; not written back by default.')
        .replace(/：非文本文件，暂不支持自动写回。/g, ': Non-text file; automatic writeback is not supported yet.')
        .replace(/：当前类型暂不支持自动写回。/g, ': This file type is not supported for automatic writeback yet.');
    }
    return text;
  }

  return {
    buildHumanCompletionReport,
    buildStructuredHumanReport,
    formatFallbackFinalReport,
    formatFailureBlock,
    formatHumanReport,
    mapAgentEventToActivity,
    stripEmptyHtmlCommentPlaceholders,
    translateRawError
  };
});
