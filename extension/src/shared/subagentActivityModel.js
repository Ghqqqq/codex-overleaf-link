(function initSubagentActivityModel(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./agentTranscript'), require('./runActivityModel'));
  } else root.CodexOverleafModuleRegistry.define('SubagentActivityModel', ['AgentTranscript', 'RunActivityModel'], factory);
})(typeof globalThis !== 'undefined' ? globalThis : window, function subagentActivityModelFactory(Transcript, Activity) {
  'use strict';
  const MAX_AGENTS = 16, MAX_EVENTS = 100, MAX_CHARS = 48000;
  const STATES = new Set(['pending', 'running', 'completed', 'failed', 'cancelled', 'unknown']);
  const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
  const string = value => typeof value === 'string' ? value : '';
  function clean(value, sanitize = string, limit = 24000) {
    return string(sanitize(string(value))).slice(0, limit);
  }
  function trim(agent) {
    if (agent.events.length > MAX_EVENTS) { agent.events = agent.events.slice(-MAX_EVENTS); agent.clipped = true; }
    while (agent.events.length > 1 && JSON.stringify(agent.events).length > MAX_CHARS) {
      agent.events.shift(); agent.clipped = true;
    }
    return agent;
  }
  function normalize(agents, sanitize = string) {
    const seen = new Set();
    return (Array.isArray(agents) ? agents : []).slice(0, MAX_AGENTS).filter(agent => {
      if (!agent || !['broker', 'codex'].includes(agent.source)) return false;
      const id = agent.source === 'broker' ? agent.jobId : agent.threadId;
      if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(id)) return false;
      const key = agent.source + ':' + id;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).map(agent => trim({
      v: 1, source: agent.source, key: agent.source + ':' + (agent.source === 'broker' ? agent.jobId : agent.threadId),
      jobId: clean(agent.jobId, sanitize, 160), threadId: clean(agent.threadId, sanitize, 160),
      parentThreadId: clean(agent.parentThreadId, sanitize, 160),
      title: clean(agent.title, sanitize, 160), task: clean(agent.task, sanitize, 4096),
      model: clean(agent.model, sanitize, 160), reasoningEffort: clean(agent.reasoningEffort, sanitize, 32),
      status: STATES.has(agent.status) ? agent.status : 'unknown',
      startedAt: clean(agent.startedAt, sanitize, 64), updatedAt: clean(agent.updatedAt, sanitize, 64),
      finishedAt: clean(agent.finishedAt, sanitize, 64),
      lastSequence: Number.isSafeInteger(agent.lastSequence) ? agent.lastSequence : 0,
      nativeEventSeq: Number.isSafeInteger(agent.nativeEventSeq) ? agent.nativeEventSeq : 0,
      clipped: agent.clipped === true, historyUnavailable: agent.historyUnavailable === true,
      events: (Array.isArray(agent.events) ? agent.events : []).filter(event => event && typeof event.title === 'string')
        .slice(-MAX_EVENTS).map(event => ({
          title: clean(event.title, sanitize), status: clean(event.status, sanitize, 32),
          timestamp: clean(event.timestamp, sanitize, 64),
          kind: event.kind === 'stream' ? 'stream' : 'activity',
          streamKey: clean(event.streamKey, sanitize, 600), streamRole: event.streamRole === 'assistant' ? 'assistant' : '',
          streamPhase: Activity.normalizePhase(event.streamPhase),
          activity: Activity.normalize(event.activity, sanitize)
        }))
    }));
  }
  function effectiveStatus(agent, run) {
    if (TERMINAL.has(agent.status) || agent.status === 'unknown' || run.status === 'running') return agent.status;
    return ['cancelled', 'rejected'].includes(run.status) ? 'cancelled' : 'unknown';
  }
  function terminalTime(agent, run) {
    const terminal = [agent.finishedAt, run.status === 'running' ? '' : run.finishedAt]
      .map(value => Date.parse(value || '')).find(Number.isFinite);
    const evidence = [agent.startedAt, agent.updatedAt, ...(agent.events || []).map(event => event.timestamp)];
    if (run.status !== 'running') evidence.push(run.startedAt, run.updatedAt, ...(run.events || []).map(event => event.timestamp));
    return terminal ?? Math.max(...evidence.map(value => Date.parse(value || '')).filter(Number.isFinite));
  }
  function elapsedMs(agent, run, now = Date.now()) {
    const start = Date.parse(agent.startedAt || '');
    const live = run.status === 'running' && ['pending', 'running'].includes(effectiveStatus(agent, run));
    return Number.isFinite(start) ? Math.max(0, (live ? now : terminalTime(agent, run)) - start) : null;
  }
  function append(agent, input, sanitize) {
    const event = {
      title: clean(input.title, sanitize), status: input.status || 'running',
      timestamp: input.timestamp || new Date().toISOString(),
      kind: input.kind === 'stream' ? 'stream' : 'activity',
      streamKey: input.streamKey || '', streamRole: input.streamRole || '',
      streamPhase: Activity.normalizePhase(input.streamPhase),
      activity: Activity.normalize(input.activity, sanitize)
    };
    if (!event.title) return;
    const key = event.kind === 'stream' ? 'stream:' + event.streamKey : event.activity?.id;
    const previous = key && agent.events.find(old => (old.kind === 'stream' ? 'stream:' + old.streamKey : old.activity?.id) === key);
    if (previous) {
      if (previous.status === 'completed' && event.status === 'running' && input.appendText) return;
      const fullText = input.appendText ? previous.title + event.title : event.title;
      if (fullText.length > 24000) agent.clipped = true;
      const activity = previous.activity && event.activity ? { ...previous.activity, ...event.activity,
        command: event.activity.command || previous.activity.command,
        output: event.activity.output || previous.activity.output,
        paths: event.activity.paths?.length ? event.activity.paths : previous.activity.paths,
        files: event.activity.files?.length ? event.activity.files : previous.activity.files } : event.activity || previous.activity;
      Object.assign(previous, event, { title: fullText.slice(0, 24000), activity });
    } else agent.events.push(event);
    trim(agent);
  }
  function addAnswer(agent, answer, timestamp, sanitize) {
    if (!answer) return;
    const last = agent.events.filter(event => event.kind === 'stream' && event.streamRole === 'assistant').at(-1);
    const safe = clean(answer, sanitize);
    if (last?.title.trim() === safe.trim()) { last.status = 'completed'; return; }
    append(agent, { kind: 'stream', streamRole: 'assistant', streamPhase: 'final_answer',
      streamKey: last?.streamPhase === 'final_answer' ? last.streamKey : 'answer:' + agent.key,
      title: safe, status: 'completed', timestamp }, sanitize);
  }
  function ingest(run, raw, options = {}) {
    const type = string(raw?.type), detail = raw?.detail || {};
    if (type === 'codex.subagent.drained') return true;
    if (!['codex.subagent.queued', 'codex.subagent.started', 'codex.subagent.completed',
      'codex.subagent.failed', 'codex.subagent.rejected', 'codex.subagent.event', 'codex.subagent.observed'].includes(type)) return false;
    const source = detail.source === 'codex' ? 'codex' : 'broker';
    const id = source === 'broker' ? string(detail.jobId || detail.id) : string(detail.threadId);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(id)) return true;
    const sanitize = options.sanitize || string, key = source + ':' + id;
    const agents = run.subagents || (run.subagents = []);
    let agent = agents.find(item => item.key === key);
    if (!agent) {
      if (agents.length >= MAX_AGENTS) return true;
      agent = { v: 1, source, key, jobId: source === 'broker' ? id : '', threadId: source === 'codex' ? id : '',
        title: id, task: '', status: 'pending', events: [], nativeEventSeq: 0, lastSequence: 0 };
      agents.push(agent);
    }
    const seq = Number(options.nativeEventSeq) || 0;
    if (seq > 0 && seq <= (agent.nativeEventSeq || 0)) return true;
    const sequence = Number(detail.sequence) || 0;
    if (sequence > 0 && sequence <= (agent.lastSequence || 0)) return true;
    agent.nativeEventSeq = Math.max(agent.nativeEventSeq || 0, seq);
    agent.lastSequence = Math.max(agent.lastSequence || 0, sequence);
    const timestamp = string(raw.timestamp) || new Date().toISOString(), at = Date.parse(string(raw.timestamp));
    const wasTerminal = TERMINAL.has(agent.status), previousEnd = terminalTime(agent, run);
    if (Number.isFinite(at) && at < Date.parse(agent.startedAt || '')) return true;
    agent.updatedAt = timestamp;
    for (const field of ['title', 'task', 'threadId', 'parentThreadId', 'model', 'reasoningEffort']) {
      const value = detail[field] || (field === 'title' ? raw.title : '');
      if (typeof value === 'string' && value) agent[field] = clean(value, sanitize, field === 'task' ? 4096 : 160);
    }
    agent.clipped ||= detail.historyClipped === true;
    agent.historyUnavailable ||= detail.historyUnavailable === true;
    let next = type.endsWith('.queued') ? 'pending' : type.endsWith('.started') ? 'running'
      : type.endsWith('.completed') ? 'completed' : type.endsWith('.rejected') ? 'failed'
        : type.endsWith('.failed') ? (detail.status === 'cancelled' ? 'cancelled' : 'failed') : detail.status;
    const inner = type === 'codex.subagent.event' ? detail.event : null;
    const method = inner?.detail?.method, params = inner?.detail?.params || {};
    if (method === 'turn/started') next = 'running';
    if (method === 'turn/completed' && source === 'codex') next = params.turn?.status === 'interrupted' ? 'cancelled' : params.turn?.status;
    const reopening = wasTerminal && method === 'turn/started';
    if (STATES.has(next) && (!wasTerminal || TERMINAL.has(next) || reopening)) agent.status = next;
    if (reopening) { agent.startedAt = timestamp; agent.finishedAt = ''; }
    if (agent.status === 'running' && !agent.startedAt) agent.startedAt = timestamp;
    if (TERMINAL.has(agent.status) || run.status !== 'running') {
      // Late snapshots describe the same stopped interval; only a new turn resets it.
      const end = wasTerminal || run.status !== 'running' || !Number.isFinite(at) ? previousEnd : at;
      if (Number.isFinite(end)) agent.finishedAt = new Date(end).toISOString();
    }
    if (inner) {
      const boundThread = inner.detail?.threadId || params.threadId || params.thread?.id;
      if (boundThread) agent.threadId = clean(boundThread, sanitize, 160);
      if (params.thread?.model) agent.model = clean(params.thread.model, sanitize, 160);
      const mapped = Transcript.mapAgentEventToActivity(inner, { locale: options.locale });
      const activity = Activity.capture({ ...mapped, technicalDetail: mapped?.technicalDetail || inner }, sanitize);
      if (mapped?.visible && mapped.kind !== 'technical' && (!mapped.streamRole || mapped.streamRole === 'assistant')) {
        const itemId = params.item?.id || params.itemId || inner.detail?.itemId;
        const turnId = params.turnId || inner.detail?.turnId || '';
        append(agent, { ...mapped, timestamp, activity,
          streamKey: mapped.kind === 'stream' ? turnId + ':' + (itemId || mapped.streamKey || 'assistant') : '' }, sanitize);
      }
    }
    if (TERMINAL.has(agent.status)) {
      for (const event of agent.events) if (event.kind === 'stream' && event.status === 'running') event.status = 'completed';
      addAnswer(agent, detail.summary, timestamp, sanitize);
      if (detail.reason) append(agent, { title: clean(detail.reason, sanitize, 1200), status: 'warning', timestamp,
        activity: { kind: 'notice', id: key + ':failure', state: agent.status === 'failed' ? 'failed' : 'warning' } }, sanitize);
    }
    return true;
  }
  return { normalize, ingest, effectiveStatus, elapsedMs };
});
