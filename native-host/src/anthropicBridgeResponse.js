'use strict';

const crypto = require('node:crypto');
const { encodeAnthropicThinkingBlock } = require('./anthropicBridgeRequest');

function convertAnthropicResponse(message = {}, context = {}) {
  if (message.type === 'error' || message.error) {
    const source = message.error || message;
    throw responseError(source.message || 'Anthropic returned an error envelope.', 'provider_upstream_error');
  }
  const responseIdValue = responseId(message.id);
  const output = [];
  const blocks = Array.isArray(message.content) ? message.content : [];
  let pendingText = [];
  const flushText = () => {
    if (!pendingText.length) return;
    output.push(messageItem(pendingText.join(''), responseIdValue));
    pendingText = [];
  };
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      pendingText.push(block.text);
    } else if (block?.type === 'tool_use') {
      flushText();
      output.push(toolItem(block, context.toolContext));
    } else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
      flushText();
      output.push(reasoningItem(block));
    }
  }
  flushText();
  if (!output.length) throw responseError('Anthropic completed without usable output.');
  const terminal = mapStopReason(message.stop_reason);
  return {
    response: responseEnvelope({
      id: responseIdValue,
      model: message.model || context.model,
      output,
      usage: normalizeUsage(message.usage),
      requestBody: context.requestBody,
      ...terminal
    }),
    assistantBlocks: clone(blocks)
  };
}

async function streamAnthropicResponse({
  upstream,
  res,
  context = {},
  onComplete = () => {},
  onActivity = () => {},
  recoverInterrupted = () => ''
} = {}) {
  const state = createState(context);
  beginSse(res);
  emit(state, res, 'response.created', { response: streamEnvelope(state, 'in_progress') });
  emit(state, res, 'response.in_progress', { response: streamEnvelope(state, 'in_progress') });
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  let interruptedReason = '';
  try {
    for await (const chunk of upstream.body || []) {
      onActivity();
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      let boundary = findBoundary(buffer);
      while (boundary) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const event = parseEvent(block);
        if (event.data) processEvent(state, res, event.type, parseJson(event.data));
        if (state.sawMessageStop || state.stopReason) {
          done = true;
          break;
        }
        boundary = findBoundary(buffer);
      }
      if (done) break;
    }
  } catch (error) {
    interruptedReason = String(recoverInterrupted(error) || '');
    if (!interruptedReason || !hasRecoverablePartialOutput(state)) throw error;
  }
  if (!done && !interruptedReason && hasRecoverablePartialOutput(state)) {
    interruptedReason = 'stream_ended';
  }
  if (!done && !interruptedReason) {
    buffer += decoder.decode();
    if (buffer.trim()) {
      const event = parseEvent(buffer);
      if (event.data) processEvent(state, res, event.type, parseJson(event.data));
    }
  }
  const converted = completeStream(state, res, interruptedReason);
  onComplete(converted);
  res.end();
  return converted;
}

function processEvent(state, res, eventType, value) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'error' || value.error) {
    throw responseError(value.error?.message || 'Anthropic stream returned an error.', 'provider_upstream_error');
  }
  const type = value.type || eventType;
  if (type === 'message_start') {
    const message = value.message || {};
    state.model = message.model || state.model;
    state.usage = normalizeUsage(message.usage);
    return;
  }
  if (type === 'content_block_start') {
    openBlock(state, res, Number(value.index) || 0, value.content_block || {});
    return;
  }
  if (type === 'content_block_delta') {
    appendBlockDelta(state, res, Number(value.index) || 0, value.delta || {});
    return;
  }
  if (type === 'content_block_stop') {
    closeBlock(state, res, Number(value.index) || 0);
    return;
  }
  if (type === 'message_delta') {
    state.stopReason = value.delta?.stop_reason || state.stopReason;
    state.usage = mergeUsage(state.usage, value.usage);
    return;
  }
  if (type === 'message_stop') state.sawMessageStop = true;
}

function openBlock(state, res, index, block) {
  if (state.blocks.has(index)) return;
  if (block.type === 'text') {
    const item = { id: randomId('msg'), type: 'message', status: 'in_progress', role: 'assistant', content: [] };
    const initialText = block.text || '';
    const entry = { type: 'text', item, outputIndex: reserve(state, item), text: '', original: { type: 'text', text: '' } };
    state.blocks.set(index, entry);
    emit(state, res, 'response.output_item.added', { output_index: entry.outputIndex, item });
    emit(state, res, 'response.content_part.added', {
      item_id: item.id,
      output_index: entry.outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] }
    });
    if (initialText) appendBlockDelta(state, res, index, { type: 'text_delta', text: initialText });
  } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
    const item = { id: randomId('rs'), type: 'reasoning', status: 'in_progress', summary: [] };
    const entry = {
      type: block.type,
      item,
      outputIndex: reserve(state, item),
      thinking: block.thinking || '',
      signature: block.signature || '',
      data: block.data || ''
    };
    state.blocks.set(index, entry);
    emit(state, res, 'response.output_item.added', { output_index: entry.outputIndex, item });
    emit(state, res, 'response.reasoning_summary_part.added', {
      item_id: item.id,
      output_index: entry.outputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: '' }
    });
  } else if (block.type === 'tool_use') {
    const spec = resolveToolSpec(state.context.toolContext, block.name);
    const kind = spec?.kind === 'custom' ? 'custom' : 'function';
    const callId = block.id || randomId('call');
    const name = spec?.name || block.name || 'tool';
    const item = kind === 'custom'
      ? { id: randomId('ct'), type: 'custom_tool_call', status: 'in_progress', call_id: callId, name, input: '' }
      : { id: randomId('fc'), type: 'function_call', status: 'in_progress', call_id: callId, name, arguments: '' };
    if (spec?.namespace) item.namespace = spec.namespace;
    const initial = block.input && Object.keys(block.input).length ? JSON.stringify(block.input) : '';
    const entry = { type: 'tool_use', item, outputIndex: reserve(state, item), kind, spec, callId, upstreamName: block.name, arguments: initial };
    state.blocks.set(index, entry);
    emit(state, res, 'response.output_item.added', { output_index: entry.outputIndex, item });
  }
}

function appendBlockDelta(state, res, index, delta) {
  let entry = state.blocks.get(index);
  if (!entry) {
    const inferred = delta.type === 'text_delta'
      ? { type: 'text', text: '' }
      : delta.type === 'thinking_delta' || delta.type === 'signature_delta'
        ? { type: 'thinking', thinking: '' }
        : { type: 'tool_use', id: randomId('call'), name: 'tool', input: {} };
    openBlock(state, res, index, inferred);
    entry = state.blocks.get(index);
  }
  if (delta.type === 'text_delta') {
    const value = String(delta.text || '');
    entry.text += value;
    emit(state, res, 'response.output_text.delta', { item_id: entry.item.id, output_index: entry.outputIndex, content_index: 0, delta: value, logprobs: [] });
  } else if (delta.type === 'thinking_delta') {
    const value = String(delta.thinking || '');
    entry.thinking += value;
    emit(state, res, 'response.reasoning_summary_text.delta', { item_id: entry.item.id, output_index: entry.outputIndex, summary_index: 0, delta: value });
  } else if (delta.type === 'signature_delta') {
    entry.signature += String(delta.signature || '');
  } else if (delta.type === 'input_json_delta') {
    const value = String(delta.partial_json || '');
    entry.arguments += value;
    if (entry.kind === 'function') {
      emit(state, res, 'response.function_call_arguments.delta', { item_id: entry.item.id, output_index: entry.outputIndex, delta: value });
    }
  }
}

function closeBlock(state, res, index) {
  const entry = state.blocks.get(index);
  if (!entry || entry.closed) return;
  entry.closed = true;
  if (entry.type === 'text') {
    const part = { type: 'output_text', text: entry.text, annotations: [] };
    entry.item.status = 'completed';
    entry.item.content = [part];
    emit(state, res, 'response.output_text.done', { item_id: entry.item.id, output_index: entry.outputIndex, content_index: 0, text: entry.text, logprobs: [] });
    emit(state, res, 'response.content_part.done', { item_id: entry.item.id, output_index: entry.outputIndex, content_index: 0, part });
    state.assistantBlocks[index] = { type: 'text', text: entry.text };
  } else if (entry.type === 'thinking' || entry.type === 'redacted_thinking') {
    const block = entry.type === 'redacted_thinking'
      ? { type: 'redacted_thinking', data: entry.data }
      : { type: 'thinking', thinking: entry.thinking, signature: entry.signature };
    entry.item.status = 'completed';
    entry.item.summary = entry.thinking ? [{ type: 'summary_text', text: entry.thinking }] : [];
    entry.item.encrypted_content = encodeAnthropicThinkingBlock(block);
    emit(state, res, 'response.reasoning_summary_text.done', { item_id: entry.item.id, output_index: entry.outputIndex, summary_index: 0, text: entry.thinking || '' });
    emit(state, res, 'response.reasoning_summary_part.done', { item_id: entry.item.id, output_index: entry.outputIndex, summary_index: 0, part: entry.item.summary[0] || { type: 'summary_text', text: '' } });
    state.assistantBlocks[index] = block;
  } else {
    entry.item.status = 'completed';
    const args = canonicalArguments(entry.arguments);
    if (entry.kind === 'custom') {
      entry.item.input = unwrapCustomInput(args);
      emit(state, res, 'response.custom_tool_call_input.done', { item_id: entry.item.id, output_index: entry.outputIndex, input: entry.item.input });
    } else {
      entry.item.arguments = args;
      emit(state, res, 'response.function_call_arguments.done', { item_id: entry.item.id, output_index: entry.outputIndex, arguments: args });
    }
    state.assistantBlocks[index] = { type: 'tool_use', id: entry.callId, name: entry.upstreamName, input: parseObject(args) };
  }
  emit(state, res, 'response.output_item.done', { output_index: entry.outputIndex, item: entry.item });
  state.items[entry.outputIndex] = entry.item;
}

function completeStream(state, res, interruptedReason = '') {
  for (const index of Array.from(state.blocks.keys()).sort((a, b) => a - b)) closeBlock(state, res, index);
  if (!state.items.filter(Boolean).length) throw responseError('Anthropic stream ended without usable output.');
  const terminal = interruptedReason
    ? { status: 'incomplete', incompleteReason: 'max_output_tokens' }
    : mapStopReason(state.stopReason);
  const response = responseEnvelope({
    id: state.id,
    model: state.model,
    output: state.items.filter(Boolean),
    usage: state.usage,
    requestBody: state.context.requestBody,
    ...terminal
  });
  emit(state, res, terminal.status === 'incomplete' ? 'response.incomplete' : 'response.completed', { response });
  return { response, assistantBlocks: state.assistantBlocks.filter(Boolean) };
}

function hasRecoverablePartialOutput(state) {
  const entries = Array.from(state.blocks.values());
  if (entries.some(entry => entry?.type === 'tool_use')) return false;
  return entries.some(entry => (
    (entry?.type === 'text' && entry.text)
    || ((entry?.type === 'thinking' || entry?.type === 'redacted_thinking') && (entry.thinking || entry.data))
  ));
}

function toolItem(block, toolContext) {
  const spec = resolveToolSpec(toolContext, block.name);
  const kind = spec?.kind === 'custom' ? 'custom' : 'function';
  const name = spec?.name || block.name || 'tool';
  const callId = block.id || randomId('call');
  const args = canonicalArguments(JSON.stringify(block.input || {}));
  const item = kind === 'custom'
    ? { id: randomId('ct'), type: 'custom_tool_call', status: 'completed', call_id: callId, name, input: unwrapCustomInput(args) }
    : { id: randomId('fc'), type: 'function_call', status: 'completed', call_id: callId, name, arguments: args };
  if (spec?.namespace) item.namespace = spec.namespace;
  return item;
}

function reasoningItem(block) {
  const thinking = block.type === 'thinking' ? String(block.thinking || '') : '';
  return {
    id: randomId('rs'),
    type: 'reasoning',
    status: 'completed',
    summary: thinking ? [{ type: 'summary_text', text: thinking }] : [],
    encrypted_content: encodeAnthropicThinkingBlock(block)
  };
}

function messageItem(value, id) {
  return { id: `${id}_msg_${crypto.randomUUID().slice(0, 8)}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: value, annotations: [] }] };
}

function responseEnvelope({ id, model, output, usage, requestBody = {}, status, incompleteReason }) {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    error: null,
    incomplete_details: incompleteReason ? { reason: incompleteReason } : null,
    instructions: null,
    model,
    output,
    parallel_tool_calls: requestBody.parallel_tool_calls !== false,
    previous_response_id: requestBody.previous_response_id || null,
    reasoning: requestBody.reasoning || null,
    store: false,
    temperature: requestBody.temperature ?? null,
    tool_choice: requestBody.tool_choice || 'auto',
    tools: Array.isArray(requestBody.tools) ? requestBody.tools : [],
    top_p: requestBody.top_p ?? null,
    usage
  };
}

function mapStopReason(value) {
  if (value === 'max_tokens' || value === 'model_context_window_exceeded') return { status: 'incomplete', incompleteReason: 'max_output_tokens' };
  if (value === 'refusal') return { status: 'incomplete', incompleteReason: 'content_filter' };
  return { status: 'completed', incompleteReason: null };
}

function normalizeUsage(value = {}) {
  const fresh = positive(value.input_tokens);
  const cached = positive(value.cache_read_input_tokens);
  const created = positive(value.cache_creation_input_tokens);
  const output = positive(value.output_tokens);
  const result = {
    input_tokens: fresh + cached + created,
    input_tokens_details: { cached_tokens: cached, cache_write_tokens: created },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: positive(value.output_tokens_details?.thinking_tokens) },
    total_tokens: fresh + cached + created + output
  };
  return result;
}

function mergeUsage(current, next = {}) {
  const cached = positive(current.input_tokens_details?.cached_tokens);
  const created = positive(current.input_tokens_details?.cache_write_tokens);
  const merged = {
    input_tokens: Math.max(0, positive(current.input_tokens) - cached - created),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: created,
    output_tokens: next.output_tokens ?? current.output_tokens,
    output_tokens_details: next.output_tokens_details
  };
  return normalizeUsage(merged);
}

function createState(context) {
  return {
    id: responseId(''),
    model: context.model || context.launch?.modelId || '',
    context,
    items: [],
    blocks: new Map(),
    assistantBlocks: [],
    usage: normalizeUsage(),
    stopReason: '',
    sawMessageStop: false,
    sequence: 0
  };
}

function streamEnvelope(state, status) {
  return responseEnvelope({
    id: state.id,
    model: state.model,
    output: status === 'completed' ? state.items.filter(Boolean) : [],
    usage: status === 'completed' ? state.usage : null,
    requestBody: state.context.requestBody,
    status,
    incompleteReason: null
  });
}

function resolveToolSpec(context, upstreamName) {
  return context?.byUpstreamName?.get?.(upstreamName) || null;
}

function reserve(state, item) {
  const index = state.items.length;
  state.items.push(item);
  return index;
}

function canonicalArguments(value) {
  try { return JSON.stringify(JSON.parse(value || '{}')); } catch (_error) { return '{}'; }
}

function unwrapCustomInput(value) {
  const parsed = parseObject(value);
  return typeof parsed.input === 'string' ? parsed.input : value;
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function emit(state, res, type, payload) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: state.sequence++, ...payload })}\n\n`);
}

function beginSse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
}

function findBoundary(value) {
  const match = /\r?\n\r?\n/.exec(value);
  return match ? { index: match.index, length: match[0].length } : null;
}

function parseEvent(block) {
  const lines = String(block || '').split(/\r?\n/);
  const type = lines.find(line => line.startsWith('event:'))?.slice(6).trim() || '';
  const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim();
  return { type, data };
}

function parseJson(value) {
  try { return JSON.parse(value); } catch (_error) { return null; }
}

function responseId(value) {
  const suffix = String(value || '').replace(/[^A-Za-z0-9_-]/g, '').slice(-48) || crypto.randomUUID().replaceAll('-', '');
  return suffix.startsWith('resp_') ? suffix : `resp_${suffix}`;
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function clone(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch (_error) { return []; }
}

function responseError(message, code = 'provider_response_invalid') {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  convertAnthropicResponse,
  streamAnthropicResponse
};
