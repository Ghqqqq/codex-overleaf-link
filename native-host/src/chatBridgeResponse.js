'use strict';

const crypto = require('node:crypto');
const { requiresReasoningContentReplay } = require('./providerReasoning');

function convertChatResponse(chat = {}, context = {}) {
  const choice = Array.isArray(chat.choices) ? chat.choices[0] || {} : {};
  const message = choice.message || {};
  assertNoLeakedToolControlTokens(message);
  const split = splitReasoning(message.content, extractReasoning(message));
  const output = [];
  if (split.reasoning) output.push(buildReasoningItem(split.reasoning));
  if (split.content) output.push(buildMessageItem(split.content));
  const legacyCall = message.function_call
    ? [{ id: randomId('call'), type: 'function', function: message.function_call }]
    : [];
  const toolCalls = normalizeToolCalls([...(message.tool_calls || []), ...legacyCall], context.toolKinds);
  output.push(...toolCalls.map(call => call.item));
  if (!output.length) {
    throw responseError('The provider completed without usable text, reasoning, or tool calls.');
  }
  const terminal = mapChatFinishReason(choice.finish_reason);
  const response = buildResponseEnvelope({
    id: responseId(chat.id),
    createdAt: Number(chat.created) || nowSeconds(),
    model: chat.model || context.model,
    output,
    usage: normalizeUsage(chat.usage),
    requestBody: context.requestBody,
    ...terminal
  });
  return {
    response,
    assistantMessage: buildAssistantMessage(split, toolCalls, context.launch),
    providerFinishReason: normalizeText(choice.finish_reason)
  };
}

async function streamChatResponse({
  upstream,
  res,
  context = {},
  onComplete = () => {},
  onActivity = () => {},
  recoverInterrupted = () => ''
} = {}) {
  const state = createStreamState(context);
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
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = findSseBoundary(buffer);
      while (boundary) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const data = parseSseData(block);
        if (data === '[DONE]') {
          done = true;
          break;
        }
        if (data) {
          assertNoLeakedToolControlTokens(data);
          processChatChunk(state, res, parseJson(data));
          // Several OpenAI-compatible gateways emit a terminal
          // finish_reason but keep the SSE connection open and omit [DONE].
          // The finish_reason is the protocol terminal signal; waiting for the
          // socket to close turns a completed answer into a transport timeout.
          if (state.finishReason) {
            done = true;
            break;
          }
        }
        boundary = findSseBoundary(buffer);
      }
      if (done) break;
    }
  } catch (error) {
    interruptedReason = normalizeText(recoverInterrupted(error));
    const hasRecoverablePartialOutput = interruptedReason
      && (state.reasoning || state.message)
      && state.tools.size === 0;
    if (!hasRecoverablePartialOutput) throw error;
  }
  if (!done && !interruptedReason) {
    buffer += decoder.decode();
    const data = parseSseData(buffer);
    if (data && data !== '[DONE]') {
      assertNoLeakedToolControlTokens(data);
      processChatChunk(state, res, parseJson(data));
    }
  }
  const completed = completeStream(state, res, interruptedReason);
  onComplete(completed);
  res.end();
  return completed.response;
}

function writeConvertedResponseAsSse(res, converted, context = {}, onComplete = () => {}) {
  const state = { sequence: 0 };
  beginSse(res);
  const pending = {
    ...converted.response,
    status: 'in_progress',
    incomplete_details: null,
    output: [],
    usage: null
  };
  emit(state, res, 'response.created', { response: pending });
  emit(state, res, 'response.in_progress', { response: pending });
  converted.response.output.forEach((item, outputIndex) => emitWholeItem(state, res, item, outputIndex));
  emit(
    state,
    res,
    converted.response.status === 'incomplete' ? 'response.incomplete' : 'response.completed',
    { response: converted.response }
  );
  onComplete(converted);
  res.end();
}

function processChatChunk(state, res, chunk) {
  if (!chunk || typeof chunk !== 'object') return;
  if (chunk.error) throw new Error(normalizeText(chunk.error.message) || 'Upstream provider returned an error.');
  if (chunk.id && !state.upstreamId) {
    state.upstreamId = chunk.id;
  }
  if (chunk.model) state.model = chunk.model;
  if (chunk.usage) state.usage = normalizeUsage(chunk.usage);
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  if (!choice) return;
  if (choice.finish_reason) state.finishReason = String(choice.finish_reason);
  const delta = choice.delta || choice.message || {};
  const reasoning = extractReasoning(delta);
  if (reasoning) appendReasoning(state, res, reasoning);
  const content = normalizeStreamContent(delta.content);
  if (content) appendMessage(state, res, content);
  for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
    appendToolCall(state, res, call);
  }
  if (delta.function_call) {
    appendToolCall(state, res, { index: 0, function: delta.function_call });
  }
}

function appendReasoning(state, res, delta) {
  if (!state.reasoning) {
    const item = { id: randomId('rs'), type: 'reasoning', status: 'in_progress', summary: [] };
    state.reasoning = { item, outputIndex: reserveItem(state, item), text: '' };
    emit(state, res, 'response.output_item.added', { output_index: state.reasoning.outputIndex, item });
    emit(state, res, 'response.reasoning_summary_part.added', {
      item_id: item.id,
      output_index: state.reasoning.outputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: '' }
    });
  }
  state.reasoning.text += delta;
  emit(state, res, 'response.reasoning_summary_text.delta', {
    item_id: state.reasoning.item.id,
    output_index: state.reasoning.outputIndex,
    summary_index: 0,
    delta
  });
}

function appendMessage(state, res, delta) {
  if (!state.message) {
    const item = { id: randomId('msg'), type: 'message', status: 'in_progress', role: 'assistant', content: [] };
    state.message = { item, outputIndex: reserveItem(state, item), text: '' };
    emit(state, res, 'response.output_item.added', { output_index: state.message.outputIndex, item });
    emit(state, res, 'response.content_part.added', {
      item_id: item.id,
      output_index: state.message.outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] }
    });
  }
  state.message.text += delta;
  emit(state, res, 'response.output_text.delta', {
    item_id: state.message.item.id,
    output_index: state.message.outputIndex,
    content_index: 0,
    delta,
    logprobs: []
  });
}

function appendToolCall(state, res, delta) {
  const index = Number.isInteger(delta.index) ? delta.index : state.tools.size;
  let tool = state.tools.get(index);
  if (!tool) {
    tool = { index, callId: '', name: '', arguments: '', emittedArguments: 0, opened: false, kind: 'function' };
    state.tools.set(index, tool);
  }
  if (delta.id) tool.callId = String(delta.id);
  if (delta.function?.name) tool.name += String(delta.function.name);
  if (delta.function?.arguments) tool.arguments += String(delta.function.arguments);
  if (!tool.opened && tool.callId && tool.name) openTool(state, res, tool);
  if (tool.opened && tool.kind === 'function' && tool.arguments.length > tool.emittedArguments) {
    const argumentDelta = tool.arguments.slice(tool.emittedArguments);
    tool.emittedArguments = tool.arguments.length;
    emit(state, res, 'response.function_call_arguments.delta', {
      item_id: tool.item.id,
      output_index: tool.outputIndex,
      delta: argumentDelta
    });
  }
}

function openTool(state, res, tool) {
  tool.callId ||= randomId('call');
  tool.name ||= 'tool';
  const spec = state.context.toolKinds?.get(tool.name);
  tool.chatName = tool.name;
  tool.name = typeof spec === 'object' ? spec.name || tool.name : tool.name;
  tool.namespace = typeof spec === 'object' ? spec.namespace || '' : '';
  tool.kind = (typeof spec === 'object' ? spec.kind : spec) === 'custom' ? 'custom' : 'function';
  tool.item = tool.kind === 'custom'
    ? { id: randomId('ct'), type: 'custom_tool_call', status: 'in_progress', call_id: tool.callId, name: tool.name, input: '' }
    : { id: randomId('fc'), type: 'function_call', status: 'in_progress', call_id: tool.callId, name: tool.name, arguments: '' };
  if (tool.namespace) tool.item.namespace = tool.namespace;
  tool.outputIndex = reserveItem(state, tool.item);
  tool.opened = true;
  emit(state, res, 'response.output_item.added', { output_index: tool.outputIndex, item: tool.item });
}

function completeStream(state, res, interruptedReason = '') {
  if (!state.reasoning && !state.message && state.tools.size === 0) {
    throw responseError(`The provider stream ended without usable output${state.finishReason ? ` (${state.finishReason})` : ''}.`);
  }
  if (state.reasoning) completeReasoning(state, res);
  if (state.message) completeMessage(state, res);
  const tools = Array.from(state.tools.values()).sort((a, b) => a.index - b.index);
  for (const tool of tools) completeTool(state, res, tool);
  const terminal = interruptedReason
    ? { status: 'incomplete', incompleteReason: 'max_output_tokens' }
    : mapChatFinishReason(state.finishReason);
  const response = streamEnvelope(state, terminal.status, terminal.incompleteReason);
  emit(
    state,
    res,
    terminal.status === 'incomplete' ? 'response.incomplete' : 'response.completed',
    { response }
  );
  const split = {
    content: state.message?.text || '',
    reasoning: state.reasoning?.text || ''
  };
  return {
    response,
    assistantMessage: buildAssistantMessage(split, tools.map(tool => ({
      callId: tool.callId,
      name: tool.name,
      chatName: tool.chatName,
      arguments: tool.arguments,
      kind: tool.kind,
      item: tool.item
    })), state.context.launch),
    providerFinishReason: interruptedReason
      ? `bridge_${interruptedReason}`
      : normalizeText(state.finishReason)
  };
}

function completeReasoning(state, res) {
  const { item, outputIndex, text } = state.reasoning;
  item.status = 'completed';
  item.summary = [{ type: 'summary_text', text }];
  emit(state, res, 'response.reasoning_summary_text.done', { item_id: item.id, output_index: outputIndex, summary_index: 0, text });
  emit(state, res, 'response.reasoning_summary_part.done', { item_id: item.id, output_index: outputIndex, summary_index: 0, part: item.summary[0] });
  emit(state, res, 'response.output_item.done', { output_index: outputIndex, item });
  state.items[outputIndex] = item;
}

function completeMessage(state, res) {
  const { item, outputIndex, text } = state.message;
  const part = { type: 'output_text', text, annotations: [] };
  item.status = 'completed';
  item.content = [part];
  emit(state, res, 'response.output_text.done', { item_id: item.id, output_index: outputIndex, content_index: 0, text, logprobs: [] });
  emit(state, res, 'response.content_part.done', { item_id: item.id, output_index: outputIndex, content_index: 0, part });
  emit(state, res, 'response.output_item.done', { output_index: outputIndex, item });
  state.items[outputIndex] = item;
}

function completeTool(state, res, tool) {
  if (!tool.opened) openTool(state, res, tool);
  tool.item.status = 'completed';
  if (tool.kind === 'custom') {
    const input = unwrapCustomArguments(tool.arguments);
    tool.item.input = input;
    if (input) emit(state, res, 'response.custom_tool_call_input.delta', { item_id: tool.item.id, output_index: tool.outputIndex, delta: input });
    emit(state, res, 'response.custom_tool_call_input.done', { item_id: tool.item.id, output_index: tool.outputIndex, input });
  } else {
    tool.item.arguments = tool.arguments || '{}';
    emit(state, res, 'response.function_call_arguments.done', {
      item_id: tool.item.id,
      output_index: tool.outputIndex,
      arguments: tool.item.arguments
    });
  }
  emit(state, res, 'response.output_item.done', { output_index: tool.outputIndex, item: tool.item });
  state.items[tool.outputIndex] = tool.item;
}

function emitWholeItem(state, res, item, outputIndex) {
  const pending = { ...item, status: 'in_progress' };
  if (item.type === 'message') pending.content = [];
  if (item.type === 'reasoning') pending.summary = [];
  if (item.type === 'function_call') pending.arguments = '';
  if (item.type === 'custom_tool_call') pending.input = '';
  emit(state, res, 'response.output_item.added', { output_index: outputIndex, item: pending });
  if (item.type === 'message') {
    const part = item.content?.[0] || { type: 'output_text', text: '', annotations: [] };
    emit(state, res, 'response.content_part.added', { item_id: item.id, output_index: outputIndex, content_index: 0, part: { ...part, text: '' } });
    if (part.text) emit(state, res, 'response.output_text.delta', { item_id: item.id, output_index: outputIndex, content_index: 0, delta: part.text, logprobs: [] });
    emit(state, res, 'response.output_text.done', { item_id: item.id, output_index: outputIndex, content_index: 0, text: part.text || '', logprobs: [] });
    emit(state, res, 'response.content_part.done', { item_id: item.id, output_index: outputIndex, content_index: 0, part });
  } else if (item.type === 'function_call') {
    if (item.arguments) emit(state, res, 'response.function_call_arguments.delta', { item_id: item.id, output_index: outputIndex, delta: item.arguments });
    emit(state, res, 'response.function_call_arguments.done', { item_id: item.id, output_index: outputIndex, arguments: item.arguments || '{}' });
  } else if (item.type === 'custom_tool_call') {
    if (item.input) emit(state, res, 'response.custom_tool_call_input.delta', { item_id: item.id, output_index: outputIndex, delta: item.input });
    emit(state, res, 'response.custom_tool_call_input.done', { item_id: item.id, output_index: outputIndex, input: item.input || '' });
  }
  emit(state, res, 'response.output_item.done', { output_index: outputIndex, item });
}

function createStreamState(context) {
  return {
    id: responseId(''),
    upstreamId: '',
    createdAt: nowSeconds(),
    model: context.model || context.launch?.modelId || '',
    context,
    items: [],
    tools: new Map(),
    reasoning: null,
    message: null,
    usage: normalizeUsage(),
    sequence: 0
    ,finishReason: ''
  };
}

function streamEnvelope(state, status, incompleteReason = null) {
  const terminal = status === 'completed' || status === 'incomplete';
  return buildResponseEnvelope({
    id: state.id,
    createdAt: state.createdAt,
    model: state.model,
    output: terminal ? state.items.filter(Boolean) : [],
    status,
    usage: terminal ? state.usage : null,
    requestBody: state.context.requestBody,
    incompleteReason
  });
}

function buildResponseEnvelope({
  id,
  createdAt,
  model,
  output,
  status,
  usage,
  requestBody = {},
  incompleteReason = null
}) {
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status,
    error: null,
    incomplete_details: incompleteReason ? { reason: incompleteReason } : null,
    instructions: null,
    model,
    output: Array.isArray(output) ? output : [],
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

function buildReasoningItem(text) {
  return { id: randomId('rs'), type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text }] };
}

function buildMessageItem(text) {
  return {
    id: randomId('msg'),
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }]
  };
}

function normalizeToolCalls(values, toolKinds) {
  return (Array.isArray(values) ? values : []).map(value => {
    const name = normalizeText(value?.function?.name) || 'tool';
    const callId = normalizeText(value?.id) || randomId('call');
    const argumentsText = normalizeText(value?.function?.arguments) || '{}';
    const spec = toolKinds?.get(name);
    const kind = (typeof spec === 'object' ? spec.kind : spec) === 'custom' ? 'custom' : 'function';
    const originalName = typeof spec === 'object' ? spec.name || name : name;
    const namespace = typeof spec === 'object' ? spec.namespace || '' : '';
    const item = kind === 'custom'
      ? { id: randomId('ct'), type: 'custom_tool_call', status: 'completed', call_id: callId, name: originalName, input: unwrapCustomArguments(argumentsText) }
      : { id: randomId('fc'), type: 'function_call', status: 'completed', call_id: callId, name: originalName, arguments: argumentsText };
    if (namespace) item.namespace = namespace;
    return { callId, name: originalName, chatName: name, namespace, arguments: argumentsText, kind, item };
  });
}

function buildAssistantMessage(split, toolCalls, launch) {
  const replayRequired = toolCalls.length > 0 && requiresReasoningContentReplay(launch, launch?.modelId);
  const assistant = { role: 'assistant', content: split.content || (replayRequired ? '' : null) };
  if (toolCalls.length) {
    assistant.tool_calls = toolCalls.map(call => ({
      id: call.callId,
      type: 'function',
      function: { name: call.chatName || call.name, arguments: call.arguments || '{}' }
    }));
  }
  const replayReasoning = split.reasoning || (replayRequired ? ' ' : '');
  if (replayReasoning) assistant.reasoning_content = replayReasoning;
  return assistant;
}

function splitReasoning(contentValue, reasoningValue) {
  let content = normalizeStreamContent(contentValue);
  let reasoning = normalizeText(reasoningValue);
  if (!reasoning) {
    const match = content.match(/^\s*<think>([\s\S]*?)<\/think>\s*/i);
    if (match) {
      reasoning = match[1];
      content = content.slice(match[0].length);
    }
  }
  return { content, reasoning };
}

function extractReasoning(message = {}) {
  const direct = message.reasoning_content ?? message.reasoning ?? message.thinking;
  if (typeof direct === 'string') return direct;
  if (direct && typeof direct === 'object') {
    const text = normalizeText(direct.text || direct.content || direct.summary);
    if (text) return text;
  }
  return (Array.isArray(message.reasoning_details) ? message.reasoning_details : [])
    .map(item => typeof item === 'string' ? item : normalizeText(item?.text || item?.content || item?.summary))
    .filter(Boolean)
    .join('\n');
}

function mapChatFinishReason(value) {
  const reason = normalizeText(value).trim().toLowerCase();
  if (['length', 'max_tokens', 'max_output_tokens', 'model_context_window_exceeded'].includes(reason)) {
    return { status: 'incomplete', incompleteReason: 'max_output_tokens' };
  }
  if (['content_filter', 'content-filter', 'refusal', 'safety'].includes(reason)) {
    return { status: 'incomplete', incompleteReason: 'content_filter' };
  }
  if (['insufficient_system_resource', 'insufficient-system-resource', 'resource_exhausted'].includes(reason)) {
    // The Responses API has no portable provider-resource incomplete reason.
    // Treat the partial generation like an output truncation so Codex can
    // continue it through the bounded history-anchor path.
    return { status: 'incomplete', incompleteReason: 'max_output_tokens' };
  }
  return { status: 'completed', incompleteReason: null };
}

function responseError(message) {
  const error = new Error(message);
  error.code = 'provider_response_invalid';
  return error;
}

function assertNoLeakedToolControlTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || {});
  if (!/<\|tool_call_(?:begin|argument_begin|end)\|>/i.test(text)) return;
  const error = new Error('The provider leaked unparsed tool-call control tokens while streaming. Use buffered upstream responses for this model.');
  error.code = 'provider_stream_tool_parse_failed';
  throw error;
}

function normalizeUsage(value = {}) {
  const input = positiveInteger(value.prompt_tokens ?? value.input_tokens);
  const output = positiveInteger(value.completion_tokens ?? value.output_tokens);
  const cached = positiveInteger(value.prompt_tokens_details?.cached_tokens ?? value.input_tokens_details?.cached_tokens);
  const reasoning = positiveInteger(value.completion_tokens_details?.reasoning_tokens ?? value.output_tokens_details?.reasoning_tokens);
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: positiveInteger(value.total_tokens) || input + output
  };
}

function normalizeStreamContent(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(part => normalizeText(part?.text || part?.content)).join('');
}

function unwrapCustomArguments(value) {
  const text = normalizeText(value);
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.input === 'string' ? parsed.input : text;
  } catch (_error) {
    return text;
  }
}

function reserveItem(state, item) {
  const index = state.items.length;
  state.items.push(item);
  return index;
}

function emit(state, res, type, payload) {
  const data = { type, sequence_number: state.sequence++, ...payload };
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function beginSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  });
}

function findSseBoundary(value) {
  const match = /\r?\n\r?\n/.exec(value);
  return match ? { index: match.index, length: match[0].length } : null;
}

function parseSseData(block) {
  return String(block || '').split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
    .trim();
}

function parseJson(value) {
  try { return JSON.parse(value); } catch (_error) { return null; }
}

function responseId(value) {
  const suffix = normalizeText(value).replace(/[^A-Za-z0-9_-]/g, '').slice(-48) || crypto.randomUUID().replaceAll('-', '');
  return `resp_${suffix}`;
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function normalizeText(value) {
  return typeof value === 'string' ? value : '';
}

module.exports = {
  convertChatResponse,
  streamChatResponse,
  writeConvertedResponseAsSse
};
