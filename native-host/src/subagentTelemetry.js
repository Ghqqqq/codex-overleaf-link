'use strict';

// Observation only: never resumes a thread, starts a turn or settles a run.
const CHILD_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/;
const MAX_CHILDREN = 16;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const EVIDENCE = { history: 1, agent: 2, turn: 3 };

function publicText(value, limit = 4096) {
  return String(value ?? '')
    .replace(/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}/g, '[REDACTED_SECRET]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED_SECRET]')
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password|authorization)\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[REDACTED_SECRET]')
    .slice(0, limit);
}

function fields(value, names, limit = 4096) {
  const result = {};
  for (const name of names) {
    const item = value?.[name];
    if (typeof item === 'string') result[name] = publicText(item, limit);
    else if (typeof item === 'number' && Number.isFinite(item) || typeof item === 'boolean') result[name] = item;
  }
  return result;
}

function compactEvent(event) {
  if (!event || !['codex.session.event', 'codex.command.started', 'codex.command.completed',
    'codex.agent.message', 'codex.agent.result', 'codex.turn.bound'].includes(event.type)) return null;
  const source = event.detail || {};
  const detail = fields(source, ['method', 'threadId', 'turnId', 'itemId', 'phase', 'code', 'exitCode', 'durationMs']);
  Object.assign(detail, fields(source, ['command', 'output', 'text'], 12000));
  if (Array.isArray(source.commandActions)) detail.commandActions = source.commandActions.slice(0, 12)
    .map(action => fields(action, ['type', 'path', 'query', 'name'], 400));
  if (source.params) {
    const p = source.params;
    // Private reasoning and raw server request payloads never enter this lane.
    if (/reasoning|textDelta|outputDelta/.test(source.method || '') && source.method !== 'item/agentMessage/delta') return null;
    const params = fields(p, ['threadId', 'turnId', 'itemId', 'phase', 'message', 'warning'], 1000);
    if (typeof p.delta === 'string') params.delta = publicText(p.delta, 12000);
    if (p.thread) params.thread = fields(p.thread, ['id', 'model'], 160);
    if (p.turn) {
      params.turn = fields(p.turn, ['id', 'status'], 160);
      if (p.turn.error) params.turn.error = fields(p.turn.error, ['message'], 1200);
    }
    if (p.error) params.error = fields(p.error, ['message'], 1200);
    if (Array.isArray(p.plan)) params.plan = p.plan.slice(0, 16).map(step => fields(step, ['step', 'status'], 600));
    const changes = input => (Array.isArray(input) ? input : []).slice(0, 12).map(change => ({
      ...fields(change, ['path'], 320),
      kind: publicText(typeof change?.kind === 'object' ? change.kind.type : change?.kind, 32),
      diff: publicText(change?.diff, 1800)
    }));
    if (Array.isArray(p.changes)) params.changes = changes(p.changes);
    if (p.item) {
      const item = p.item;
      if (item.type === 'reasoning') return null;
      params.item = {
        ...fields(item, ['id', 'type', 'status', 'phase', 'tool', 'server', 'exitCode', 'durationMs', 'success'], 400),
        ...fields(item, ['command'], 1000),
        ...fields(item, ['text'], 24000),
        ...fields(item, ['aggregatedOutput'], 1600)
      };
      if (Array.isArray(item.commandActions)) params.item.commandActions = item.commandActions.slice(0, 12)
        .map(action => fields(action, ['type', 'path', 'query', 'name'], 400));
      if (Array.isArray(item.changes)) params.item.changes = changes(item.changes);
      if (item.error) params.item.error = fields(item.error, ['message'], 1200);
    }
    detail.params = params;
  }
  return {
    type: event.type, title: publicText(event.title, 24000),
    status: publicText(event.status, 32),
    timestamp: publicText(event.timestamp || new Date().toISOString(), 64), detail
  };
}

// Metadata has a narrower exposure policy than already-compacted tool events.
function metadataText(value, limit) {
  if (typeof value !== 'string') return '';
  return publicText(value, 16384)
    .replace(/(["'\x60])(?:file:\/\/|~\/|\/(?!\/)|[a-zA-Z]:[\\/]|\\\\)[\s\S]*?\1/g, '$1[local path]$1')
    .replace(/\bfile:\/\/[^\s<>"'\x60]+/gi, '[local path]')
    .replace(/(^|[\s([{"'=,:])(?:[a-zA-Z]:[\\/]|\\\\)[^\s<>"'\x60)\]}]+/g, '$1[local path]')
    .replace(/(^|[\s([{"'=,:])(?:~\/|\/(?!\/))[^\s<>"'\x60)\]}]*/g, '$1[local path]')
    .slice(0, limit);
}

function agentTitle(id, item) {
  // agentPath is a logical namespace only for this exact, single-name shape.
  // Never turn an arbitrary filesystem path into a display name.
  const match = typeof item.agentPath === 'string'
    && /^\/root\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,79})$/.exec(item.agentPath);
  if (match) {
    const name = match[1].replace(/[_-]+/g, ' ').trim();
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  const role = metadataText(item.agentRole, 120).trim();
  return role && !role.includes('[local path]') ? role : 'Agent ' + id.slice(0, 8);
}

function taskText(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || /^gAAAA[A-Za-z0-9_-]{20,}={0,2}$/.test(text)
    || /^<(?:environment_context|user_instructions|developer_instructions|system_instructions|permissions|collaboration_mode)\b/i.test(text)
    || /^Same Codex Overleaf session context:/.test(text)
    || /^Message Type:\s*NEW_TASK\b/.test(text)) return '';
  return metadataText(text, 4096);
}

function taskFromItems(items) {
  for (const item of items.slice(0, 100)) {
    if (item?.type !== 'userMessage' || !Array.isArray(item.content)
      || item.content.some(part => part?.type === 'encrypted_content')) continue;
    const text = item.content.filter(part => part?.type === 'text')
      .map(part => taskText(part.text)).filter(Boolean).join('\n').slice(0, 4096);
    if (text) return text;
  }
  return '';
}

function createNativeSubagentObserver({ emit, request, getRoot, ownsParent, isStopped }) {
  const children = new Map();
  let closed = false;
  const active = () => !closed && !isStopped();
  function publish(child, event, extra = {}) {
    if (!active()) return;
    emit({
      type: event ? 'codex.subagent.event' : 'codex.subagent.observed',
      title: child.title, timestamp: new Date().toISOString(), status: child.status,
      detail: {
        source: 'codex', threadId: child.id, parentThreadId: child.parentThreadId,
        title: child.title, task: child.task, status: child.status,
        sequence: ++child.sequence, ...extra,
        ...(event ? { event: compactEvent(event) } : {})
      }
    });
  }
  function status(value) {
    return ({ pendingInit: 'pending', running: 'running', completed: 'completed',
      errored: 'failed', interrupted: 'cancelled', notFound: 'unknown' })[value];
  }
  function setStatus(child, next, evidence) {
    if (!next) return false;
    if (TERMINAL.has(child.status)) {
      if (!TERMINAL.has(next) || evidence < child.statusEvidence
        || next !== child.status && evidence === child.statusEvidence) return false;
    }
    const changed = child.status !== next;
    child.status = next;
    if (TERMINAL.has(next)) child.statusEvidence = evidence;
    return changed;
  }
  function rememberTask(child, items) {
    if (child.task) return false;
    const text = taskFromItems(items);
    if (!text) return false;
    child.task = text;
    return true;
  }
  function register(id, item) {
    if (typeof id !== 'string' || !CHILD_ID.test(id) || id === getRoot().threadId) return null;
    let child = children.get(id);
    if (!child) {
      if (children.size >= MAX_CHILDREN) return null;
      child = { id, title: agentTitle(id, item),
        task: taskText(item.prompt), parentThreadId: getRoot().threadId,
        status: 'pending', statusEvidence: 0, turnId: '', generation: 0, retiredTurns: new Set(),
        interruptionObserved: false, sequence: 0, items: new Map(), activities: new Set(), lastRead: -Infinity };
      children.set(id, child);
    } else {
      if (child.title === 'Agent ' + id.slice(0, 8)) child.title = agentTitle(id, item);
      if (!child.task) child.task = taskText(item.prompt);
    }
    return child;
  }
  function duplicateActivity(child, item) {
    if (typeof item.id !== 'string' || !item.id) return false;
    // The same lifecycle item can arrive as both item/started and item/completed.
    // Its kind, not the outer notification method, identifies the child activity.
    const key = JSON.stringify([item.id.slice(0, 160), item.kind]);
    if (child.activities.has(key)) return true;
    child.activities.add(key);
    if (child.activities.size > 100) child.activities.delete(child.activities.values().next().value);
    return false;
  }
  function snapshot(child, terminal = false) {
    if (!active() || child.readDisabled) return;
    if (child.reading) { child.readAgain ||= terminal; return; }
    if (!terminal && Date.now() - child.lastRead < 2000) return;
    child.reading = true; child.lastRead = Date.now();
    const generation = child.generation, interruptionObserved = child.interruptionObserved;
    // Read only on real lifecycle/activity notifications. Polling would keep
    // the parent's idle watchdog alive and change execution semantics.
    Promise.resolve().then(() => active()
      ? request('thread/read', { threadId: child.id, includeTurns: true }) : null)
      .then(result => {
        if (!active() || child.generation !== generation || result?.thread?.id !== child.id
          || result.thread.parentThreadId && result.thread.parentThreadId !== child.parentThreadId) return;
        const turns = Array.isArray(result.thread.turns) ? result.thread.turns : [];
        const turn = turns.at(-1);
        // A fork can include its parent's context; do not replay that as work
        // produced by this child.
        if (!turn?.id || turn.id === getRoot().turnId
          || child.turnId && child.turnId !== turn.id) return;
        child.historyTurnId = turn.id;
        const items = Array.isArray(turn.items) ? turn.items : [];
        // Recover real child input before compactEvent drops user content.
        // A fork's parent context and encrypted delegation are not task text.
        if (rememberTask(child, items)) publish(child, null);
        for (const item of items.slice(-100)) {
          const event = compactEvent({
            type: 'codex.session.event', status: item.status === 'inProgress' ? 'running' : 'completed',
            detail: {
              method: item.status === 'inProgress' ? 'item/started' : 'item/completed',
              params: { threadId: child.id, turnId: turn.id, item }
            }
          });
          if (!event) continue;
          const signature = JSON.stringify(event.detail);
          const key = turn.id + ':' + item.id;
          if (child.items.get(key) === signature) continue;
          child.items.set(key, signature);
          if (child.items.size > 100) child.items.delete(child.items.keys().next().value);
          publish(child, event, { historyClipped: items.length > 100 });
        }
        if (['completed', 'failed', 'interrupted'].includes(turn.status)) {
          // A persisted, still-active turn can look interrupted. Require an
          // explicit interruption observation before trusting that snapshot.
          const next = turn.status === 'interrupted'
            ? (interruptionObserved ? 'cancelled' : undefined) : turn.status;
          if (setStatus(child, next, EVIDENCE.history)) publish(child, null);
        }
      }).catch(() => {
        if (!active() || child.generation !== generation) return;
        // Older app servers may lack this capability. Keep observed records;
        // reading history must never interrupt or resume the parent or child.
        child.readDisabled = true;
        publish(child, null, { historyUnavailable: true });
      }).finally(() => {
        child.reading = false;
        if (child.readAgain) { child.readAgain = false; snapshot(child, true); }
      });
  }
  function observe(message) {
    if (!active()) return false;
    const p = message.params || {};
    const threadId = p.threadId || p.thread?.id;
    const known = children.get(threadId);
    if (known) {
      const turnId = p.turnId || p.turn?.id || '';
      if (message.method === 'turn/started') {
        if (!turnId || known.retiredTurns.has(turnId)
          || (known.turnId === turnId || !known.turnId && known.historyTurnId === turnId)
            && TERMINAL.has(known.status)) return true;
        if (known.turnId !== turnId) {
          if (known.turnId) known.retiredTurns.add(known.turnId);
          if (known.retiredTurns.size > 100) known.retiredTurns.delete(known.retiredTurns.values().next().value);
          known.turnId = turnId;
          known.generation += 1;
          known.statusEvidence = 0;
          known.interruptionObserved = false;
        }
        known.status = 'running';
      } else if (turnId && known.turnId && turnId !== known.turnId) {
        return true;
      } else if (turnId) {
        known.turnId = turnId;
      }
      if (message.method === 'turn/completed') {
        const next = p.turn?.status === 'interrupted' ? 'cancelled'
          : ['completed', 'failed'].includes(p.turn?.status) ? p.turn.status : undefined;
        const changed = setStatus(known, next, EVIDENCE.turn);
        // Do not forward rejected terminal evidence: the frontend also reads
        // params.turn.status and must not reapply a weaker/conflicting outcome.
        if (next && !changed && next !== known.status) return true;
      }
      if (turnId && turnId !== getRoot().turnId && rememberTask(known, [p.item])) publish(known, null);
      const event = compactEvent({ type: 'codex.session.event', title: message.method,
        detail: { method: message.method, params: p }, status: /completed/.test(message.method) ? 'completed' : 'running' });
      if (event) publish(known, event);
      return true; // Child errors/completions cannot settle the parent.
    }
    if (!ownsParent(p)) return false;
    const item = p.item || {};
    if (item.type === 'subAgentActivity') {
      if (!['started', 'interacted', 'interrupted', 'completed'].includes(item.kind)) return false;
      const child = register(item.agentThreadId, item);
      if (!child || duplicateActivity(child, item)) return false;
      if (item.kind === 'started' && ['pending', 'unknown'].includes(child.status)) child.status = 'running';
      if (item.kind === 'interrupted') child.interruptionObserved = true;
      publish(child, null);
      // A lifecycle completion wakes the final read; it does not establish
      // success. Only the child's own turn/status evidence can do that.
      snapshot(child, item.kind === 'completed' || item.kind === 'interrupted');
      return false;
    }
    if (item.type !== 'collabAgentToolCall') return false;
    const states = item.agentsStates && typeof item.agentsStates === 'object' ? item.agentsStates : {};
    const ids = [...new Set([...(Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []), ...Object.keys(states)])];
    for (const id of ids.slice(0, MAX_CHILDREN)) {
      const child = register(id, item);
      if (!child) continue;
      const next = status(states[id]?.status);
      setStatus(child, next, EVIDENCE.agent);
      const terminal = ['completed', 'failed', 'cancelled'].includes(child.status);
      publish(child, null, { summary: next === child.status && TERMINAL.has(next)
        ? publicText(states[id]?.message, 24000) : '' });
      snapshot(child, terminal);
    }
    return false;
  }
  return { observe, close() { closed = true; children.clear(); } };
}

module.exports = { publicText, compactEvent, createNativeSubagentObserver };
