'use strict';

const { cursorContextWindow } = require('./cursorContextWindows');

function createCursorEventAdapter({ emit, threadId, turnId, modelId } = {}) {
  const scope = {
    threadId: String(threadId || ''),
    turnId: String(turnId || '')
  };
  const state = {
    turnStarted: false,
    assistantSeq: 0,
    assistantItemId: '',
    assistantText: '',
    reasoningItemId: '',
    reasoningText: '',
    tools: new Map(),
    assistantParts: []
  };

  function ingest(raw) {
    const event = unwrapEvent(raw);
    if (!event) return;
    startTurn();
    const type = String(event.type || '');
    if (type === 'assistant' || type === 'text' || type === 'text-delta' || type === 'assistant-delta') {
      consumeAssistant(readEventText(event));
      return;
    }
    if (type === 'thinking' || type === 'thinking-delta') {
      consumeThinking(event);
      return;
    }
    if (type === 'tool_call' || type === 'tool-call' || type === 'tool') {
      consumeTool(event);
      return;
    }
    if (type === 'usage') {
      emitUsage(event.usage || event);
      return;
    }
    if (type === 'summary') {
      consumeSummary(event);
    }
  }

  function finish({ text, usage } = {}) {
    completeOpenReasoning();
    const finalText = String(text || '').trim() || state.assistantParts.join('');
    if (finalText) {
      const itemId = state.assistantItemId || nextAssistantItemId();
      emitSession('item/completed', {
        ...scope,
        item: { id: itemId, type: 'agentMessage', text: finalText, status: 'completed' }
      }, 'completed');
    }
    if (usage) emitUsage(usage);
    emitSession('turn/completed', {
      ...scope,
      turn: { id: scope.turnId, status: 'completed', items: [] }
    }, 'completed');
    return { assistantMessage: finalText };
  }

  function startTurn() {
    if (state.turnStarted) return;
    state.turnStarted = true;
    emitSession('turn/started', {
      thread: { id: scope.threadId },
      turn: { id: scope.turnId },
      ...scope
    });
  }

  function consumeAssistant(text) {
    completeOpenReasoning();
    const delta = appendText('assistant', text);
    if (!delta) return;
    if (!state.assistantItemId) state.assistantItemId = nextAssistantItemId();
    emitSession('item/agentMessage/delta', {
      ...scope,
      itemId: state.assistantItemId,
      delta
    });
  }

  function consumeThinking(event) {
    const delta = appendText('reasoning', readEventText(event));
    if (delta) {
      if (!state.reasoningItemId) state.reasoningItemId = nextReasoningItemId();
      emitSession('item/reasoning/summaryTextDelta', {
        ...scope,
        itemId: state.reasoningItemId,
        item: { id: state.reasoningItemId },
        delta
      });
    }
    if (Number.isFinite(Number(event?.thinking_duration_ms)) || event?.status === 'completed') {
      completeOpenReasoning(Number(event.thinking_duration_ms) || undefined);
    }
  }

  function consumeTool(event) {
    completeOpenReasoning();
    closeAssistantSegment();
    const callId = String(event.call_id || event.id || event.toolCallId || '').trim() || `tool-${state.tools.size + 1}`;
    const name = String(event.name || event.tool || event.toolName || 'tool');
    const status = String(event.status || '').toLowerCase();
    const previous = state.tools.get(callId) || { started: false, completed: false, name };
    const item = buildToolItem(callId, name, event, previous);
    if (!previous.started && (status === 'running' || status === '' || !previous.completed)) {
      previous.started = true;
      emitSession('item/started', { ...scope, item: { ...item, status: 'running' } });
    }
    if ((status === 'completed' || status === 'error' || status === 'failed') && !previous.completed) {
      previous.completed = true;
      emitSession('item/completed', {
        ...scope,
        item: {
          ...item,
          status: status === 'completed' ? 'completed' : 'failed'
        }
      }, status === 'completed' ? 'completed' : 'failed');
    }
    state.tools.set(callId, previous);
  }

  function consumeSummary(event) {
    const status = String(event.status || '').toLowerCase();
    const item = { id: `summary-${scope.turnId || 'current'}`, type: 'contextCompaction' };
    if (status === 'running' || !status) {
      emitSession('item/started', { ...scope, item: { ...item, status: 'running' } });
      return;
    }
    emitSession('item/completed', {
      ...scope,
      item: { ...item, status: status === 'error' ? 'failed' : 'completed' }
    }, status === 'error' ? 'failed' : 'completed');
  }

  function emitUsage(usage) {
    const last = normalizeUsage(usage);
    if (!last) return;
    emitSession('thread/tokenUsage/updated', {
      ...scope,
      tokenUsage: {
        last,
        modelContextWindow: cursorContextWindow(modelId) || undefined
      }
    }, 'completed');
  }

  function completeOpenReasoning(durationMs) {
    if (!state.reasoningItemId) return;
    emitSession('item/completed', {
      ...scope,
      item: {
        id: state.reasoningItemId,
        type: 'reasoning',
        status: 'completed',
        summary: state.reasoningText ? [state.reasoningText] : [],
        ...(Number.isFinite(durationMs) ? { durationMs } : {})
      }
    }, 'completed');
    state.reasoningItemId = '';
    state.reasoningText = '';
  }

  function closeAssistantSegment() {
    if (!state.assistantItemId) return;
    if (state.assistantText) state.assistantParts.push(state.assistantText);
    state.assistantItemId = '';
    state.assistantText = '';
  }

  function appendText(kind, incoming) {
    const text = String(incoming || '');
    if (!text) return '';
    const key = kind === 'reasoning' ? 'reasoningText' : 'assistantText';
    const previous = state[key] || '';
    if (text.startsWith(previous)) {
      const delta = text.slice(previous.length);
      state[key] = text;
      return delta;
    }
    state[key] = previous + text;
    return text;
  }

  function nextAssistantItemId() {
    state.assistantSeq += 1;
    return `agent-${state.assistantSeq}`;
  }

  function nextReasoningItemId() {
    return `reasoning-${state.assistantSeq + 1}`;
  }

  function emitSession(method, params, status = 'running') {
    if (typeof emit !== 'function') return;
    emit({
      type: 'codex.session.event',
      title: method,
      status,
      detail: { method, params },
      timestamp: new Date().toISOString()
    });
  }

  return { ingest, finish, startTurn };
}

function unwrapEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'sdk_message' && event.message) return event.message;
  return event;
}

function readEventText(event) {
  if (typeof event?.text === 'string') return event.text;
  if (typeof event?.delta === 'string') return event.delta;
  const blocks = event?.message?.content || event?.content || [];
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter(block => block?.type === 'text' || typeof block?.text === 'string')
    .map(block => block.text || '')
    .join('');
}

function buildToolItem(callId, name, event, previous) {
  const kind = classifyTool(name);
  const args = event?.args && typeof event.args === 'object' ? event.args : {};
  const result = event?.result;
  const output = readToolOutput(result);
  const pathValue = firstString(args.path, args.target_file, args.file_path, args.targetDirectory, args.target_directory);
  if (kind === 'shell') {
    return {
      id: callId,
      type: 'commandExecution',
      command: firstString(args.command, args.cmd, Array.isArray(args.command) ? args.command.join(' ') : ''),
      aggregatedOutput: output,
      exitCode: Number.isFinite(Number(result?.exitCode ?? result?.exit_code))
        ? Number(result.exitCode ?? result.exit_code)
        : (String(event.status || '').toLowerCase() === 'error' ? 1 : 0)
    };
  }
  if (kind === 'read' || kind === 'grep' || kind === 'ls') {
    const actionType = kind === 'grep' ? 'search' : kind === 'ls' ? 'listFiles' : 'read';
    return {
      id: callId,
      type: 'commandExecution',
      command: kind === 'grep'
        ? `rg ${firstString(args.pattern, args.query, '')}`
        : kind === 'ls' ? `ls ${pathValue}` : `cat ${pathValue}`,
      commandActions: [{
        type: actionType,
        path: pathValue,
        query: firstString(args.pattern, args.query)
      }],
      aggregatedOutput: output,
      exitCode: 0
    };
  }
  if (kind === 'edit') {
    return {
      id: callId,
      type: 'fileChange',
      changes: pathValue ? [{ path: pathValue }] : []
    };
  }
  if (kind === 'task') {
    return {
      id: callId,
      type: 'dynamicToolCall',
      tool: 'task',
      status: previous.completed ? 'completed' : 'running'
    };
  }
  return {
    id: callId,
    type: 'dynamicToolCall',
    tool: name,
    status: previous.completed ? 'completed' : 'running'
  };
}

function classifyTool(name) {
  const id = String(name || '').toLowerCase().replace(/[_-]/g, '');
  if (id === 'shell' || id.includes('shell')) return 'shell';
  if (id === 'read' || id === 'readfile') return 'read';
  if (id === 'grep' || id.includes('grep') || id === 'rg') return 'grep';
  if (id === 'glob') return 'grep';
  if (id === 'ls' || id === 'list' || id === 'listdir') return 'ls';
  if (['edit', 'write', 'strreplace', 'delete', 'applyagentdiff'].includes(id)) return 'edit';
  if (id === 'task') return 'task';
  return 'other';
}

function readToolOutput(result) {
  if (typeof result === 'string') return result.slice(0, 4000);
  if (!result || typeof result !== 'object') return '';
  if (typeof result.output === 'string') return result.output.slice(0, 4000);
  if (typeof result.content === 'string') return result.content.slice(0, 4000);
  try {
    return JSON.stringify(result).slice(0, 4000);
  } catch (_error) {
    return '';
  }
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = count(usage.inputTokens);
  const outputTokens = count(usage.outputTokens);
  const cachedInputTokens = count(usage.cacheReadTokens ?? usage.cachedInputTokens);
  const totalTokens = count(usage.totalTokens);
  const used = totalTokens !== null ? totalTokens
    : (inputTokens !== null || outputTokens !== null ? (inputTokens || 0) + (outputTokens || 0) : null);
  if (used === null) return null;
  return {
    totalTokens: used,
    inputTokens,
    outputTokens,
    cachedInputTokens
  };
}

function count(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
}

function firstString(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

module.exports = { createCursorEventAdapter };
