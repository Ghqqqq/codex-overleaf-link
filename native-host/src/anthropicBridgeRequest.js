'use strict';

const crypto = require('node:crypto');

const THINKING_PREFIX = 'codex-overleaf-anthropic-thinking-v1:';
const DEFAULT_MAX_TOKENS = 32768;

function buildAnthropicRequest({ requestBody = {}, launch = {}, historyMessages = [] } = {}) {
  const toolContext = buildToolContext(requestBody.tools);
  const messages = clone(historyMessages);
  const systemParts = [];
  const instructions = text(requestBody.instructions);
  if (launch.impersonateClaudeCode) {
    systemParts.push("You are Claude Code, Anthropic's official command-line coding agent.");
  }
  if (meaningful(instructions)) systemParts.push(instructions.trim());
  appendResponsesInput(messages, systemParts, requestBody.input, toolContext);
  normalizeMessages(messages);
  if (!messages.length) {
    const error = new Error('Cannot convert an empty Codex request to Anthropic Messages.');
    error.code = 'provider_request_invalid';
    throw error;
  }

  const model = text(requestBody.model) || launch.modelId;
  const maxTokens = clampInteger(
    requestBody.max_output_tokens || launch.maxOutputTokens,
    256,
    200000,
    DEFAULT_MAX_TOKENS
  );
  const body = {
    ...(launch.bodyOverrides || {}),
    model,
    max_tokens: maxTokens,
    messages,
    stream: requestBody.stream !== false
  };
  if (systemParts.length) {
    body.system = launch.anthropicPromptCaching
      ? systemParts.map((value, index) => ({
          type: 'text',
          text: value,
          ...(index === systemParts.length - 1 ? { cache_control: { type: 'ephemeral' } } : {})
        }))
      : systemParts.join('\n\n');
  }
  if (toolContext.tools.length && requestBody.tool_choice !== 'none') body.tools = toolContext.tools;
  const toolChoice = convertToolChoice(requestBody.tool_choice, toolContext, launch);
  if (toolChoice) body.tool_choice = toolChoice;

  const thinkingEnabled = applyAnthropicThinking(body, requestBody, launch, maxTokens);
  if (!thinkingEnabled) {
    copyNumber(requestBody, body, 'temperature');
    copyNumber(requestBody, body, 'top_p');
  }
  if (launch.anthropicPromptCaching) markLatestUserCachePoint(messages);
  return { body, messages, toolContext };
}

function appendResponsesInput(messages, systemParts, input, toolContext) {
  if (typeof input === 'string') {
    if (meaningful(input)) pushBlock(messages, 'user', { type: 'text', text: input });
    return;
  }
  if (!Array.isArray(input)) return;
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'reasoning') {
      const block = decodeAnthropicThinkingBlock(item.encrypted_content);
      if (block) pushBlock(messages, 'assistant', block);
      continue;
    }
    if (item.type === 'function_call' || item.type === 'custom_tool_call' || item.type === 'tool_search_call') {
      const spec = findToolSpec(toolContext, item);
      const callId = text(item.call_id || item.id) || randomId('toolu');
      const inputValue = item.type === 'custom_tool_call'
        ? { input: text(item.input) }
        : parseObject(item.arguments);
      pushBlock(messages, 'assistant', {
        type: 'tool_use',
        id: callId,
        name: spec?.upstreamName || text(item.name) || 'tool',
        input: inputValue
      });
      continue;
    }
    if (['function_call_output', 'custom_tool_call_output', 'computer_call_output', 'tool_search_output'].includes(item.type)) {
      pushBlock(messages, 'user', {
        type: 'tool_result',
        tool_use_id: text(item.call_id || item.id),
        content: convertToolResultContent(item.output),
        ...(item.status === 'failed' ? { is_error: true } : {})
      });
      continue;
    }
    if (item.type === 'message' || item.role) {
      const role = normalizeRole(item.role);
      const blocks = convertContent(item.content);
      if (role === 'system') {
        for (const block of blocks) {
          if (block.type === 'text' && meaningful(block.text)) systemParts.push(block.text.trim());
        }
      } else {
        for (const block of blocks) pushBlock(messages, role, block);
      }
    }
  }
}

function buildToolContext(values) {
  const tools = [];
  const byUpstreamName = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    if (value?.type === 'namespace' && Array.isArray(value.tools)) {
      for (const child of value.tools) addTool(tools, byUpstreamName, child, text(value.name));
    } else {
      addTool(tools, byUpstreamName, value, '');
    }
  }
  return { tools, byUpstreamName };
}

function addTool(tools, byUpstreamName, value, namespace) {
  const originalName = text(value?.name || value?.function?.name)
    || (value?.type === 'tool_search' ? 'tool_search' : '');
  if (!originalName) return;
  const kind = value.type === 'custom'
    ? 'custom'
    : value.type === 'tool_search'
      ? 'tool_search'
      : 'function';
  const upstreamName = uniqueToolName(namespace, originalName, byUpstreamName);
  const inputSchema = kind === 'custom'
    ? {
        type: 'object',
        properties: { input: { type: 'string' } },
        required: ['input'],
        additionalProperties: false
      }
    : kind === 'tool_search'
      ? {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false
        }
      : normalizeSchema(value.parameters || value.function?.parameters);
  const spec = { kind, name: originalName, namespace, upstreamName };
  byUpstreamName.set(upstreamName, spec);
  tools.push({
    name: upstreamName,
    description: text(value.description || value.function?.description) || `Codex tool ${originalName}`,
    input_schema: inputSchema
  });
}

function findToolSpec(context, item) {
  const name = text(item?.name || item?.function?.name);
  const namespace = text(item?.namespace);
  for (const spec of context.byUpstreamName.values()) {
    if (spec.name === name && (!namespace || namespace === spec.namespace)) return spec;
  }
  return null;
}

function convertToolChoice(value, context, launch) {
  const disableParallel = !launch.supportsParallelToolCalls;
  if (!value || value === 'auto') return { type: 'auto', disable_parallel_tool_use: disableParallel };
  if (value === 'required') return { type: 'any', disable_parallel_tool_use: disableParallel };
  if (value === 'none') return null;
  const spec = findToolSpec(context, value);
  const name = spec?.upstreamName || text(value?.name || value?.function?.name);
  return name ? { type: 'tool', name, disable_parallel_tool_use: disableParallel } : null;
}

function applyAnthropicThinking(body, requestBody, launch, maxTokens) {
  const effort = text(requestBody?.reasoning?.effort || launch.reasoningEffort).toLowerCase();
  if (!effort || ['none', 'off', 'disabled'].includes(effort) || launch.anthropicThinkingMode === 'none') {
    return false;
  }
  const mode = launch.anthropicThinkingMode === 'adaptive' ? 'adaptive' : 'budget';
  if (mode === 'adaptive') {
    body.thinking = { type: 'adaptive' };
    body.output_config = { effort: effort === 'xhigh' ? 'max' : effort === 'minimal' ? 'low' : effort };
    return true;
  }
  const requested = {
    minimal: 2048,
    low: 2048,
    medium: 8192,
    high: 16384,
    xhigh: 24576,
    max: 24576
  }[effort];
  if (!requested) return false;
  const budget = Math.min(requested, Math.floor(maxTokens / 2), maxTokens - 1);
  if (budget < 1024) return false;
  body.thinking = { type: 'enabled', budget_tokens: budget };
  return true;
}

function rectifyAnthropicRequestForRetry(body, errorText) {
  const message = String(errorText || '').toLowerCase();
  if (/signature|redacted_thinking|expected.+thinking|thinking.+(invalid|illegal)/i.test(message)) {
    let changed = false;
    for (const item of body.messages || []) {
      if (!Array.isArray(item.content)) continue;
      const filtered = item.content.filter(block => !['thinking', 'redacted_thinking'].includes(block?.type));
      if (filtered.length !== item.content.length) changed = true;
      item.content = filtered;
    }
    if (body.thinking) changed = true;
    delete body.thinking;
    delete body.output_config;
    normalizeMessages(body.messages || []);
    return changed;
  }
  if (/budget_tokens|thinking budget|must be less than max_tokens|at least 1024/i.test(message)) {
    body.thinking = { type: 'enabled', budget_tokens: 32000 };
    body.max_tokens = Math.max(Number(body.max_tokens) || 0, 64000);
    delete body.output_config;
    return true;
  }
  return false;
}

function normalizeMessages(messages) {
  for (const message of messages) {
    message.content = (Array.isArray(message.content) ? message.content : [])
      .filter(block => block && (
        block.type !== 'text' || meaningful(block.text)
      ));
  }
  const toolUseIds = new Set();
  for (const message of messages) {
    for (const block of message.content || []) {
      if (block.type === 'tool_use' && block.id) toolUseIds.add(block.id);
    }
  }
  for (const message of messages) {
    message.content = (message.content || []).filter(block => (
      block.type !== 'tool_result' || toolUseIds.has(block.tool_use_id)
    ));
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!messages[index].content.length) messages.splice(index, 1);
  }
  mergeAdjacentMessages(messages);
  if (messages[0]?.role === 'assistant') {
    messages.unshift({ role: 'user', content: [{ type: 'text', text: 'Continue the task.' }] });
  }
}

function mergeAdjacentMessages(messages) {
  for (let index = 1; index < messages.length;) {
    if (messages[index - 1].role === messages[index].role) {
      messages[index - 1].content.push(...messages[index].content);
      messages.splice(index, 1);
    } else {
      index += 1;
    }
  }
}

function pushBlock(messages, role, block) {
  if (!block) return;
  let message = messages[messages.length - 1];
  if (!message || message.role !== role) {
    message = { role, content: [] };
    messages.push(message);
  }
  if (role === 'user' && block.type === 'tool_result') {
    const firstNonResult = message.content.findIndex(item => item.type !== 'tool_result');
    if (firstNonResult >= 0) message.content.splice(firstNonResult, 0, block);
    else message.content.push(block);
  } else {
    message.content.push(block);
  }
}

function convertContent(value) {
  if (typeof value === 'string') return meaningful(value) ? [{ type: 'text', text: value }] : [];
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const part of value) {
    if (!part || typeof part !== 'object') continue;
    if (['input_text', 'output_text', 'text'].includes(part.type)) {
      if (meaningful(part.text)) result.push({ type: 'text', text: part.text });
    } else if (part.type === 'input_image' || part.type === 'image_url') {
      const image = convertImage(part.image_url?.url || part.image_url || part.url);
      if (image) result.push(image);
    } else if (part.type === 'input_file' || part.type === 'document') {
      const document = convertDocument(part);
      if (document) result.push(document);
    }
  }
  return result;
}

function convertToolResultContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const blocks = convertContent(value);
    return blocks.length ? blocks : json(value);
  }
  return json(value);
}

function convertImage(value) {
  const url = text(value);
  const dataMatch = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
  if (dataMatch) {
    return { type: 'image', source: { type: 'base64', media_type: dataMatch[1], data: dataMatch[2].replace(/\s/g, '') } };
  }
  if (/^https?:\/\//i.test(url)) return { type: 'image', source: { type: 'url', url } };
  return null;
}

function convertDocument(part) {
  const value = text(part.file_data || part.file_url || part.url || part.source?.url);
  const dataMatch = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(value);
  let source;
  if (dataMatch) {
    source = { type: 'base64', media_type: dataMatch[1], data: dataMatch[2].replace(/\s/g, '') };
  } else if (/^https?:\/\//i.test(value)) {
    source = { type: 'url', url: value };
  } else if (part.source?.type === 'base64' && part.source.data) {
    source = {
      type: 'base64',
      media_type: part.source.media_type || part.media_type || 'application/pdf',
      data: part.source.data
    };
  }
  if (!source) return null;
  return {
    type: 'document',
    source,
    ...(part.filename || part.title ? { title: part.filename || part.title } : {})
  };
}

function markLatestUserCachePoint(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== 'user' || !messages[index].content.length) continue;
    messages[index].content[messages[index].content.length - 1].cache_control = { type: 'ephemeral' };
    return;
  }
}

function encodeAnthropicThinkingBlock(block) {
  if (!block || !['thinking', 'redacted_thinking'].includes(block.type)) return '';
  return `${THINKING_PREFIX}${Buffer.from(JSON.stringify(block)).toString('base64url')}`;
}

function decodeAnthropicThinkingBlock(value) {
  const encoded = text(value);
  if (!encoded.startsWith(THINKING_PREFIX)) return null;
  try {
    const block = JSON.parse(Buffer.from(encoded.slice(THINKING_PREFIX.length), 'base64url').toString('utf8'));
    return ['thinking', 'redacted_thinking'].includes(block?.type) ? block : null;
  } catch (_error) {
    return null;
  }
}

function uniqueToolName(namespace, name, existing) {
  const raw = [namespace, name].filter(Boolean).join('__').replace(/[^A-Za-z0-9_-]/g, '_');
  const base = raw.length <= 64
    ? raw
    : `${raw.slice(0, 51)}_${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12)}`;
  if (!existing.has(base)) return base;
  return `${base.slice(0, 55)}_${crypto.createHash('sha256').update(`${namespace}\0${name}`).digest('hex').slice(0, 8)}`;
}

function normalizeSchema(value) {
  return value && typeof value === 'object'
    ? value
    : { type: 'object', properties: {}, additionalProperties: true };
}

function normalizeRole(value) {
  const role = text(value).toLowerCase();
  if (role === 'assistant') return 'assistant';
  if (role === 'system' || role === 'developer') return 'system';
  return 'user';
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(text(value) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function clone(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch (_error) { return []; }
}

function json(value) {
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value); } catch (_error) { return String(value); }
}

function copyNumber(source, target, key) {
  const value = Number(source?.[key]);
  if (Number.isFinite(value)) target[key] = value;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
}

function meaningful(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

module.exports = {
  buildAnthropicRequest,
  decodeAnthropicThinkingBlock,
  encodeAnthropicThinkingBlock,
  rectifyAnthropicRequestForRetry
};
