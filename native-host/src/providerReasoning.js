'use strict';

const REASONING_ADAPTERS = new Set([
  'auto',
  'none',
  'deepseek',
  'anthropic',
  'reasoning_effort',
  'openrouter',
  'enable_thinking',
  'thinking',
  'reasoning_split'
]);
const REASONING_CAPABILITIES = new Set(['auto', 'none', 'toggle', 'effort']);
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const DEEPSEEK_MAX_REASONING_OUTPUT_TOKENS = 65536;

function normalizeReasoningAdapter(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return REASONING_ADAPTERS.has(normalized) ? normalized : 'auto';
}

function normalizeReasoningCapability(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return REASONING_CAPABILITIES.has(normalized) ? normalized : 'auto';
}

function resolveReasoningAdapter(profile = {}, modelId = '') {
  const configured = normalizeReasoningAdapter(profile.reasoningAdapter);
  if (configured !== 'auto') {
    return configured;
  }
  const capability = normalizeReasoningCapability(profile.reasoningCapability);
  if (capability === 'none') {
    return 'none';
  }
  const detected = detectReasoningAdapter(profile, modelId);
  if (detected) {
    return detected;
  }
  if (capability === 'effort') {
    return 'reasoning_effort';
  }
  if (capability === 'toggle') {
    return 'enable_thinking';
  }
  return 'none';
}

function resolveReasoningCapability(profile = {}, modelId = '') {
  const configured = normalizeReasoningCapability(profile.reasoningCapability);
  if (configured !== 'auto') {
    return configured;
  }
  const adapter = resolveReasoningAdapter(profile, modelId);
  if (adapter === 'deepseek' || adapter === 'anthropic' || adapter === 'reasoning_effort' || adapter === 'openrouter') {
    return 'effort';
  }
  if (adapter === 'enable_thinking' || adapter === 'thinking' || adapter === 'reasoning_split') {
    return 'toggle';
  }
  return 'none';
}

function getSupportedReasoningEfforts(profile = {}, model = {}) {
  return getReasoningControl(profile, model).efforts;
}

function getReasoningControl(profile = {}, model = {}) {
  const explicit = Array.isArray(model.reasoningEfforts)
    ? model.reasoningEfforts.map(normalizeEffort).filter(Boolean)
    : [];
  const adapter = resolveReasoningAdapter(profile, model.id);
  const capability = resolveReasoningCapability(profile, model.id);
  if (adapter === 'none' || capability === 'none') {
    return { efforts: [], defaultEffort: '', presentation: 'none' };
  }
  if (explicit.length) {
    const efforts = Array.from(new Set(explicit));
    return {
      efforts,
      defaultEffort: efforts.includes('high') ? 'high' : efforts[0],
      presentation: adapter === 'deepseek' ? 'deepseek' : capability === 'toggle' ? 'toggle' : 'effort'
    };
  }
  if (adapter === 'deepseek') {
    return {
      efforts: ['none', 'high', 'xhigh'],
      defaultEffort: 'high',
      presentation: 'deepseek'
    };
  }
  if (adapter === 'openrouter') {
    return {
      efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'medium',
      presentation: 'effort'
    };
  }
  if (adapter === 'anthropic') {
    return {
      efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'medium',
      presentation: 'effort'
    };
  }
  if (capability === 'effort') {
    return {
      efforts: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'medium',
      presentation: 'effort'
    };
  }
  if (capability === 'toggle') {
    return {
      efforts: ['none', 'high'],
      defaultEffort: 'high',
      presentation: 'toggle'
    };
  }
  return { efforts: [], defaultEffort: '', presentation: 'none' };
}

function applyReasoningControl(chatBody, responsesRequest = {}, launch = {}) {
  // The panel selection is the user's explicit per-run choice. Codex may put
  // its own model default in the Responses request, so launch must win when
  // it is present (including the meaningful `none` value).
  const requested = resolveRequestedReasoningEffort(responsesRequest, launch);
  if (!requested) {
    return;
  }
  const adapter = resolveReasoningAdapter(launch, chatBody.model || launch.modelId);
  const enabled = requested !== 'none';
  if (adapter === 'deepseek') {
    chatBody.thinking = { type: enabled ? 'enabled' : 'disabled' };
    if (enabled) {
      chatBody.reasoning_effort = requested === 'xhigh' ? 'max' : 'high';
    }
  } else if (adapter === 'reasoning_effort') {
    if (enabled) {
      chatBody.reasoning_effort = clampEffort(requested, false);
    }
  } else if (adapter === 'openrouter') {
    chatBody.reasoning = { effort: clampEffort(requested, true) };
  } else if (adapter === 'enable_thinking') {
    chatBody.enable_thinking = enabled;
  } else if (adapter === 'thinking') {
    chatBody.thinking = { type: enabled ? 'enabled' : 'disabled' };
  } else if (adapter === 'reasoning_split') {
    chatBody.reasoning_split = enabled;
  }
}

function resolveRequestedReasoningEffort(responsesRequest = {}, launch = {}) {
  return normalizeEffort(launch.reasoningEffort)
    || normalizeEffort(responsesRequest?.reasoning?.effort);
}

function resolveReasoningMaxOutputTokens(value, responsesRequest = {}, launch = {}, modelId = '') {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return value;
  }
  const normalized = Math.max(1, Math.floor(number));
  const effort = resolveRequestedReasoningEffort(responsesRequest, launch);
  const adapter = resolveReasoningAdapter(launch, modelId || launch.modelId);
  return adapter === 'deepseek' && effort === 'xhigh'
    ? Math.max(normalized, DEEPSEEK_MAX_REASONING_OUTPUT_TOKENS)
    : normalized;
}

function requiresReasoningContentReplay(launch = {}, modelId = '') {
  return resolveReasoningAdapter(launch, modelId) === 'deepseek';
}

function supportsToolChoice(launch = {}, modelId = '') {
  return resolveReasoningAdapter(launch, modelId) !== 'deepseek';
}

function detectReasoningAdapter(profile = {}, modelId = '') {
  if (profile.wireApiPreference === 'anthropic' || profile.wireApi === 'anthropic' || profile.routedWireApi === 'anthropic') {
    return 'anthropic';
  }
  const host = normalizeHost(profile.baseUrl);
  if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) {
    return 'openrouter';
  }
  if (host === 'api.deepseek.com' || host.endsWith('.deepseek.com')) {
    return 'deepseek';
  }
  if (host === 'api.anthropic.com' || host.endsWith('.anthropic.com')) {
    return 'anthropic';
  }
  if (host.includes('dashscope') || host.includes('bailian')) {
    return 'enable_thinking';
  }
  if (host.includes('bigmodel') || host.includes('zhipu')) {
    return 'thinking';
  }
  const identity = `${profile.providerName || profile.name || ''} ${modelId || profile.modelId || ''}`.toLowerCase();
  if (/\bdeepseek(?:[-_\s]|$)/.test(identity)) return 'deepseek';
  return /\b(?:anthropic|claude)(?:[-_\s]|$)/.test(identity) ? 'anthropic' : '';
}

function normalizeHost(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase();
  } catch (_error) {
    return '';
  }
}

function normalizeEffort(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return REASONING_EFFORTS.has(normalized) ? normalized : '';
}

function clampEffort(effort, preserveXhigh) {
  if (effort === 'minimal') return 'low';
  if (effort === 'xhigh') return preserveXhigh ? 'xhigh' : 'high';
  return effort;
}

module.exports = {
  applyReasoningControl,
  getReasoningControl,
  getSupportedReasoningEfforts,
  normalizeReasoningAdapter,
  normalizeReasoningCapability,
  requiresReasoningContentReplay,
  resolveReasoningAdapter,
  resolveReasoningCapability,
  resolveReasoningMaxOutputTokens,
  supportsToolChoice
};
