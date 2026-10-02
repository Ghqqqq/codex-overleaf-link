(function initRunActivityModel(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexOverleafModuleRegistry.define('RunActivityModel', [], factory);
})(typeof globalThis !== 'undefined' ? globalThis : window, function runActivityModelFactory() {
  'use strict';

  // Project event facts. Cancellation recognition is also shared by history recovery.
  const KINDS = new Set(['explore', 'command', 'edit', 'tool', 'sync', 'compile', 'notice', 'plan', 'agent', 'lifecycle', 'message']);
  const STATES = new Set(['running', 'pending', 'completed', 'failed', 'warning', 'cancelled', 'skipped', 'triggered', 'unknown', 'info']);
  const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'skipped', 'warning', 'triggered', 'unknown']);
  const NOTICE_SOURCES = new Set(['warning', 'guardianWarning', 'configWarning']);
  const MAX_FILES = 12;
  const text = value => typeof value === 'string' ? value : '';
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const phase = value => ['commentary', 'final_answer'].includes(value) ? value : '';

  function normalize(value, sanitize = text) {
    if (!value || !KINDS.has(value.kind)) return undefined;
    const clip = (input, limit) => text(sanitize(text(input))).slice(0, limit);
    const paths = Array.isArray(value.paths) ? value.paths : [];
    const files = Array.isArray(value.files) ? value.files : [];
    const normalizedPaths = [...new Set(paths.map(path => clip(path, 320)).filter(Boolean))].slice(0, MAX_FILES);
    const normalizedFiles = files.slice(0, MAX_FILES).filter(file => file && typeof file.path === 'string').map(file => ({
      path: clip(file.path, 320),
      operation: ['add', 'delete', 'update', 'move'].includes(file.operation) ? file.operation : 'update',
      added: count(file.added),
      removed: count(file.removed),
      preview: clip(file.preview, 1800),
      clipped: file.clipped === true || text(file.preview).length > 1800
    }));
    return {
      v: 1, kind: value.kind, messagePhase: phase(value.messagePhase), id: clip(value.id, 600), scope: clip(value.scope, 400),
      state: STATES.has(value.state) ? value.state : 'info',
      action: ['read', 'search', 'list'].includes(value.action) ? value.action : '',
      target: clip(value.target, 320), command: clip(value.command, 400),
      output: clip(value.output, 1200), paths: normalizedPaths, files: normalizedFiles,
      durationMs: count(value.durationMs), exitCode: Number.isSafeInteger(value.exitCode) ? value.exitCode : undefined,
      written: count(value.written), skipped: count(value.skipped),
      resolvedBy: clip(value.resolvedBy, 600),
      noticeSource: NOTICE_SOURCES.has(value.noticeSource) ? value.noticeSource : '',
      clipped: value.clipped === true || paths.length > MAX_FILES || files.length > MAX_FILES
        || text(value.command).length > 400 || text(value.output).length > 1200
    };
  }

  function changeSummary(change) {
    if (!change || typeof change.path !== 'string') return null;
    const diff = text(change.diff);
    const lines = diff.split(/\r?\n/);
    const isDiff = lines.some(line => line.startsWith('@@') || line.startsWith('diff --git')
      || line.startsWith('+++ ') || line.startsWith('--- '));
    const selected = lines.filter(line => line.startsWith('@@') || line.startsWith('+') || line.startsWith('-'));
    return {
      path: change.path,
      operation: typeof change.kind === 'string' ? change.kind : change.kind?.type,
      added: isDiff ? lines.filter(line => line.startsWith('+') && !line.startsWith('+++ ')).length : undefined,
      removed: isDiff ? lines.filter(line => line.startsWith('-') && !line.startsWith('--- ')).length : undefined,
      preview: (isDiff ? selected : lines).slice(0, 24).join('\n'),
      clipped: (isDiff ? selected : lines).length > 24
    };
  }

  // Start-up steps before the model's first response. Plugin titles are matched in both locales so
  // persisted history (which drops technicalDetail) still classifies; `written` carries a file count.
  const SETUP_TITLES = [
    ['editing', /^(?:Checking Overleaf (?:Editing mode|Reviewing\/Track Changes) before starting\.|正在确认 Overleaf (?:Editing 模式|留痕状态)。)$/],
    ['editing', /(?:Starting the task\.|开始处理任务。)$/],
    ['read', /^(?:Syncing the Overleaf project to the local Codex workspace\.|正在同步 Overleaf 项目到本地 Codex workspace。)$/],
    ['read', /^(?:Read Overleaf project: (\d+) text file|已读取 Overleaf 项目：(\d+) 个文本文件)/],
    ['warm', /^(?:Using the warmed local workspace|使用已预热的本地 workspace)/],
    ['workspace', /^(?:Syncing the Overleaf project into the local Codex workspace(?:: (\d+))?|正在同步 Overleaf 项目到本地 Codex workspace：(\d+)|Synced (\d+) text files\.|已同步 (\d+) 个文本文件)/],
    ['codex', /^(?:Local Codex session is starting\.|本地 Codex session 开始运行。)$/],
    ['codex', /^Using Codex CLI ([^;\s]+?)(?:;|\.?$)/],
    ['hidden', /^Disabled non-Overleaf Codex skills/]
  ];
  function captureSetup(event, type, detail, sanitize) {
    const title = text(event.title).trim();
    let step = type.startsWith('overleaf.sync.') && type !== 'overleaf.sync.changes' ? 'workspace'
      : type === 'codex.runtime.selected' ? 'codex' : type === 'codex.skill_isolation.applied' ? 'hidden' : '';
    let match = null;
    if (!step) for (const [name, pattern] of SETUP_TITLES) if ((match = pattern.exec(title))) { step = name; break; }
    if (!step) return undefined;
    const fileCount = Number(detail.fileCount) || Number(match?.slice(1).find(Boolean)) || undefined;
    const version = text(detail.version) || (step === 'codex' && match?.[1]) || '';
    return normalize({ kind: 'lifecycle', target: 'setup.' + step, state: event.status === 'running' ? 'running' : 'completed',
      written: Number.isSafeInteger(fileCount) ? fileCount : undefined, output: version }, sanitize);
  }

  function capture(event = {}, sanitize = text) {
    if (event.activity?.v === 1) return normalize(event.activity, sanitize);
    if (event.kind === 'report' || event.kind === 'guidance' || event.kind === 'stream') return undefined;
    const raw = event.technicalDetail || (event.kind === 'technical' ? event.detail : null) || {};
    const detail = raw.detail || {};
    const setup = event.kind === 'activity' || !event.kind ? captureSetup(event, text(raw.type), detail, sanitize) : undefined;
    if (setup) return setup;
    const params = detail.params || {};
    const item = params.item || {};
    const type = text(raw.type);
    const method = text(detail.method);
    const thread = text(params.threadId || detail.threadId);
    const turn = text(params.turnId || detail.turnId);
    const itemId = text(item.id || params.itemId || detail.itemId);
    const scope = JSON.stringify([thread, turn]);
    const id = itemId ? JSON.stringify([thread, turn, itemId]) : '';
    const base = { id, scope, state: event.status };
    if (NOTICE_SOURCES.has(method)) {
      return normalize({ ...base, kind: 'notice', noticeSource: method,
        output: text(params.details), state: event.status === 'failed' ? 'failed' : 'warning' }, sanitize);
    }
    if (item.type === 'commandExecution' || type.startsWith('codex.command.')) {
      const actions = Array.isArray(item.commandActions || detail.commandActions)
        ? (item.commandActions || detail.commandActions) : [];
      const exploring = actions.length > 0 && actions.every(action => ['read', 'search', 'listFiles'].includes(action?.type));
      const first = actions[0] || {};
      const output = text(item.aggregatedOutput || detail.output);
      return normalize({
        ...base, kind: exploring ? 'explore' : 'command',
        action: first.type === 'listFiles' ? 'list' : first.type,
        paths: actions.map(action => text(action.path)).filter(Boolean),
        target: first.path || first.query || first.name,
        command: item.command || detail.command,
        output: output.split(/\r?\n/).slice(-8).join('\n').slice(-1200),
        clipped: output.length > 1200 || output.split(/\r?\n/).length > 8,
        exitCode: item.exitCode ?? detail.exitCode,
        durationMs: item.durationMs ?? detail.durationMs,
        state: method === 'item/completed' || type.endsWith('.completed')
          ? (item.status === 'failed' || event.status === 'failed' || Number(item.exitCode ?? detail.exitCode) > 0 ? 'failed' : 'completed')
          : 'running'
      }, sanitize);
    }
    if (item.type === 'fileChange' || method === 'item/fileChange/patchUpdated') {
      const changes = Array.isArray(item.changes || params.changes) ? (item.changes || params.changes) : [];
      const files = changes.map(changeSummary).filter(Boolean);
      return normalize({
        ...base, kind: 'edit', files, paths: files.map(file => file.path),
        state: method === 'item/completed'
          ? (item.status === 'failed' ? 'failed' : item.status === 'declined' ? 'skipped' : 'completed') : 'running'
      }, sanitize);
    }
    if (['mcpToolCall', 'dynamicToolCall'].includes(item.type)) {
      return normalize({ ...base, kind: 'tool', target: item.tool || item.server,
        durationMs: item.durationMs, state: method === 'item/completed'
          ? (item.status === 'failed' || item.success === false || item.error ? 'failed' : 'completed') : 'running' }, sanitize);
    }
    if (method === 'turn/plan/updated' || item.type === 'plan') {
      const plan = Array.isArray(params.plan) ? params.plan : [];
      return normalize({ ...base, kind: 'plan', id: id || scope + ':plan',
        output: plan.map(step => text(step.status) + ': ' + text(step.step)).join('\n'),
        state: method === 'item/completed' || (plan.length && plan.every(step => step.status === 'completed')) ? 'completed' : 'info' }, sanitize);
    }
    if (event.subagent || type.startsWith('codex.subagent.')) {
      return normalize({ ...base, kind: 'agent', id: id || text(detail.jobId),
        target: detail.label || detail.jobId }, sanitize);
    }
    if (method === 'turn/completed' || type === 'codex.agent.result') {
      return normalize({ ...base, kind: 'lifecycle', target: 'local_completed' }, sanitize);
    }
    if (method === 'turn/started' || item.type === 'reasoning') {
      return normalize({ ...base, kind: 'lifecycle', target: 'working' }, sanitize);
    }
    if (type === 'codex.agent.message') return normalize({ ...base, kind: 'message', messagePhase: detail.phase }, sanitize);
    if (type === 'codex.session.request') {
      // Some requests are resolved automatically. A log must not invent an approval gate.
      return normalize({ ...base, kind: 'notice', state: 'info' }, sanitize);
    }
    if (event.failure || ['failed', 'warning', 'blocked'].includes(event.status)) {
      return normalize({ ...base, kind: 'notice', state: event.status === 'failed' ? 'failed' : 'warning' }, sanitize);
    }
    return undefined;
  }

  function eventKey(event, index) {
    return text(event.guidanceId || event.streamKey) || text(event.timestamp) + ':' + index;
  }

  function isAssistantMessage(event) {
    return event?.kind === 'stream' && event.streamRole === 'assistant'
      || event?.activity?.kind === 'message' || event?.technicalDetail?.type === 'codex.agent.message';
  }

  function isRoutineCancellationEvent(event) {
    if (!event || event.failure || (event.kind && event.kind !== 'activity')
      || event.streamRole || event.technicalDetail) return false;
    const meta = event.activity;
    if (meta?.v === 1 && meta.kind === 'lifecycle')
      return meta.state === 'cancelled' && meta.target === 'cancelled';
    if (meta && (meta.kind !== 'notice' || meta.id || meta.noticeSource)) return false;
    // Exact plugin acknowledgements only: assistant prose and tool failures
    // must never change the terminal state of a saved run.
    return ['Current Codex task was cancelled.', '已中断当前 Codex 任务。',
      'Cancelled: user chose not to create a new thread.', '已取消：用户选择不新建线程。']
      .includes(text(event.title).trim());
  }

  function isDiagnosticNotice(event, meta) {
    if (isRoutineCancellationEvent(event)) return true;
    if (meta?.kind !== 'notice' || event.failure || meta.state === 'failed'
      || meta.noticeSource === 'guardianWarning') return false;
    // Native advisory messages are not requests for user intervention. Fatal
    // errors, writeback outcomes and safety warnings keep their own channels.
    if (['warning', 'configWarning'].includes(meta.noticeSource)) return true;
    // Old compacted records no longer have the native method. Only migrate
    // known advisory copy; never guess that an unknown warning is harmless.
    const title = text(event.title).trim();
    return title === 'Codex returned a runtime notice.'
      || title === 'Codex 返回了一条运行提示。'
      || /^Codex is ignoring \d+ unrecognized configuration settings?\b/i.test(title);
  }

  function needsUserAttention(row) {
    const meta = row.meta;
    if (!['failed', 'warning'].includes(meta?.state) && !(row.kind === 'sync' && meta?.skipped > 0)) return false;
    if (row.event.failure) return true;
    if (['notice', 'sync', 'compile'].includes(row.kind)) return true;
    if (row.kind === 'agent') return meta.state === 'warning';
    // A failed local compilation affects the deliverable even if edits synced.
    // Other tool attempts remain inspectable without becoming task warnings.
    return row.kind === 'command'
      && /(?:^|[\/\s"';&|])(?:latexmk|pdflatex|xelatex|lualatex|bibtex|biber)(?=\s|["']|$)/i.test(meta.command);
  }

  function project(run = {}, incoming, options = {}) {
    const saved = Array.isArray(run.events) ? run.events : [];
    const events = incoming && !saved.includes(incoming) ? saved.concat(incoming) : saved;
    const ordered = [];
    const diagnostics = [];
    const diagnosticNotices = new Set();
    const byId = new Map();
    const report = events.filter(event => event?.kind === 'report').at(-1);
    const finalText = text(report?.detailStructured?.conclusion
      || report?.detail?.Conclusion || report?.detail?.['结论']).trim();
    let lastAssistant = -1;
    events.forEach((event, index) => {
      if (isAssistantMessage(event)) lastAssistant = index;
    });
    let stage = 'preparing';
    let clipped = false;
    let previousAt = '';
    // Start-up rows until the first thought, message or tool step: a running row is updated in place by its finish.
    const setup = { steps: [], done: false, firstWorkAt: '' };
    const startWork = event => {
      if (setup.done) return;
      setup.done = true;
      setup.firstWorkAt = text(event.timestamp);
      for (const entry of setup.steps) if (entry.state === 'running') Object.assign(entry, { state: 'completed', endAt: setup.firstWorkAt || entry.at });
    };
    const addSetupStep = (step, event, meta) => {
      if (setup.done || step === 'hidden') return;
      if (step === 'note') {
        // Snapshot advisories ("Note: 1 file(s) have empty/loading content.") attach to the project read.
        const owner = setup.steps.findLast(entry => entry.step === 'read') || setup.steps.at(-1);
        if (owner) (owner.notes ||= []).push(text(event.title).trim().replace(/^(?:Note: |提示：)/, ''));
        return;
      }
      const last = setup.steps.at(-1);
      const state = meta?.state || (event.status === 'running' ? 'running' : 'completed');
      const at = text(event.timestamp);
      // A finished step closes any step still running before it (start-up is sequential).
      for (const entry of setup.steps) if (entry.state === 'running' && entry.step !== step) Object.assign(entry, { state: 'completed', endAt: at });
      const entry = { step, state, at, endAt: state === 'running' ? '' : at, count: meta?.written, version: meta?.output || '',
        reviewing: /Reviewing|留痕/.test(text(event.title)) };
      if (last && last.step === step && last.state === 'running') {
        Object.assign(last, { ...entry, at: last.at, count: entry.count ?? last.count, version: entry.version || last.version });
      } else setup.steps.push(entry);
    };
    events.forEach((event, index) => {
      if (!event || event.kind === 'report') return;
      const key = eventKey(event, index);
      // A stream event keeps only its latest timestamp; the event before it marks when it began.
      const startedAt = previousAt || text(event.timestamp);
      previousAt = text(event.timestamp) || previousAt;
      if (event.kind === 'guidance' || event.guidanceId || options.isGuidance?.(event)) {
        const id = 'guidance:' + key;
        const existing = byId.get(id);
        if (existing) existing.event = event;
        else { const row = { key: id, kind: 'guidance', event }; ordered.push(row); byId.set(id, row); }
        return;
      }
      if (event.kind === 'stream' && event.streamRole === 'reasoning' && text(event.title).trim()) {
        startWork(event);
        ordered.push({ key: 'thought:' + key, kind: 'thought', event, startedAt });
        stage = 'working';
        return;
      }
      if (event.kind === 'stream' && event.streamRole !== 'assistant') { diagnostics.push({ key, event }); return; }
      if (isAssistantMessage(event)) {
        const body = text(event.title).trim();
        const alreadyFinal = report && (phase(event.streamPhase || event.activity?.messagePhase) === 'final_answer'
          || (index === lastAssistant && body && finalText
            && (finalText === body || finalText.startsWith(body + '\n') || finalText.startsWith(body + ' '))));
        if (!body || alreadyFinal) return;
        startWork(event);
        ordered.push({ key: 'message:' + key, kind: 'message', event });
        stage = 'working';
        return;
      }
      const meta = event.activity?.v === 1 ? event.activity : capture(event);
      clipped ||= meta?.clipped === true;
      if (isDiagnosticNotice(event, meta)) {
        const noticeKey = JSON.stringify([meta?.noticeSource || '', event.title]);
        if (!diagnosticNotices.has(noticeKey)) diagnostics.push({ key, event });
        diagnosticNotices.add(noticeKey);
        return;
      }
      if (meta?.kind === 'lifecycle' && meta.target.startsWith('setup.')) {
        addSetupStep(meta.target.slice(6), event, meta);
        diagnostics.push({ key, event });
        return;
      }
      if (meta?.kind === 'lifecycle' && meta.target === 'working' && !setup.steps.some(entry => entry.step === 'waiting')) {
        addSetupStep('waiting', event, { state: 'running' });
      } else if (!meta && /^(?:Note: |提示：)/.test(text(event.title))) addSetupStep('note', event);
      if (!meta || meta.kind === 'lifecycle' || event.kind === 'technical') {
        diagnostics.push({ key, event });
        if (meta?.kind === 'lifecycle') stage = meta.target;
        return;
      }
      const identity = meta.id ? 'item:' + meta.scope + ':' + meta.id : 'event:' + key;
      const previous = byId.get(identity);
      if (previous) {
        // Delayed start packets cannot regress an authoritative terminal item.
        if (!(TERMINAL.has(previous.meta.state) && ['running', 'pending'].includes(meta.state))) {
          previous.meta = { ...previous.meta, ...meta,
            paths: meta.paths?.length ? meta.paths : previous.meta.paths,
            files: meta.files?.length ? meta.files : previous.meta.files,
            output: meta.output || previous.meta.output,
            command: meta.command || previous.meta.command };
          previous.event = event;
        }
      } else {
        if (meta.kind !== 'notice') startWork(event);
        const row = { key: identity, kind: meta.kind, meta, event, startedAt: event.timestamp };
        byId.set(identity, row);
        ordered.push(row);
      }
      stage = meta.kind === 'sync' || meta.kind === 'compile' ? meta.kind : 'working';
    });
    const blocks = [];
    const notices = [];
    const files = new Set();
    for (const row of ordered) {
      const meta = row.meta;
      if (row.kind === 'edit' && meta.state === 'completed') for (const path of meta.paths || []) files.add(path);
      const resolved = meta?.resolvedBy
        && byId.get('item:' + meta.scope + ':' + meta.resolvedBy)?.meta.state === 'completed';
      if (!resolved && needsUserAttention(row)) notices.push(row);
      if (row.kind === 'explore') {
        const prior = blocks.at(-1);
        if (prior?.kind === 'exploreGroup' && prior.scope === meta.scope) prior.items.push(row);
        else blocks.push({ key: 'explore:' + row.key, kind: 'exploreGroup', scope: meta.scope, items: [row] });
      } else if (row.kind === 'edit' && meta.files?.length) {
        for (const file of meta.files) blocks.push({ ...row, key: row.key + ':file:' + file.path, file });
      } else blocks.push(row);
    }
    const legacy = diagnostics.some(({ event }) => event.kind !== 'technical' && !event.technicalDetail && !event.activity);
    if (stage === 'local_completed') startWork({});
    return { blocks, diagnostics, notices, stage, setup, fileCount: files.size, clipped, hasReport: Boolean(report), legacy };
  }

  return { normalize, capture, project, normalizePhase: phase, isRoutineCancellationEvent };
});
