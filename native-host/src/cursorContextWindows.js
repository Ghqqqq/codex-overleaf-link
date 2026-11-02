'use strict';

// Prefix table, longest match first. Unknown model ids omit a window size.
const CURSOR_CONTEXT_WINDOWS = Object.freeze([
  ['gpt-4.1', 1047576],
  ['gemini-3', 1048576],
  ['gemini-2.5', 1048576],
  ['gemini-2', 1048576],
  ['claude-3.7', 200000],
  ['claude-3.5', 200000],
  ['claude-opus', 200000],
  ['claude-sonnet', 200000],
  ['claude-4', 200000],
  ['claude-3', 200000],
  ['composer', 200000],
  ['grok-4', 256000],
  ['gpt-5', 256000],
  ['gpt-4o', 128000],
  ['kimi', 256000],
  ['o4-mini', 200000],
  ['o3-mini', 200000],
  ['o4', 200000],
  ['o3', 200000]
]);

function cursorContextWindow(modelId) {
  const id = String(modelId || '').trim().toLowerCase();
  if (!id || id === 'auto' || id === 'cursor-pending') return null;
  for (const [prefix, size] of CURSOR_CONTEXT_WINDOWS) {
    if (id === prefix || id.startsWith(`${prefix}-`) || id.startsWith(prefix)) return size;
  }
  return null;
}

const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function parameterValueId(value) {
  return String(value?.value || value || '').trim().toLowerCase();
}

function deriveCursorModelCapabilities(model = {}) {
  const parameters = Array.isArray(model.parameters) ? model.parameters : [];
  const variants = Array.isArray(model.variants) ? model.variants : [];
  const effortParam = parameters.find(parameter => {
    const id = String(parameter?.id || '');
    const name = String(parameter?.displayName || '');
    return /reason|think|effort/i.test(id) || /reason|think|effort/i.test(name);
  });
  const reasoningEfforts = [];
  for (const value of effortParam?.values || []) {
    const id = parameterValueId(value);
    if (REASONING_EFFORTS.has(id) && !reasoningEfforts.includes(id)) reasoningEfforts.push(id);
  }
  const defaultVariant = variants.find(variant => variant?.isDefault === true);
  const defaultEffort = parameterValueId(
    (defaultVariant?.params || []).find(param => param?.id === effortParam?.id)
  );
  const fastParam = parameters.find(parameter => String(parameter?.id || '') === 'fast');
  const hasFast = (fastParam?.values || []).some(value => parameterValueId(value) === 'true');
  const fastVariants = variants.filter(variant => (variant?.params || []).some(
    param => param?.id === 'fast' && String(param?.value) === 'true'
  ));
  const maxModeWhenFast = hasFast
    && fastVariants.length > 0
    && fastVariants.every(variant => variant?.isMaxMode === true);
  const defaultFast = (defaultVariant?.params || []).some(
    param => param?.id === 'fast' && String(param?.value) === 'true'
  );
  return {
    capabilitiesKnown: true,
    reasoningParamId: effortParam?.id ? String(effortParam.id).slice(0, 80) : '',
    reasoningEfforts,
    reasoningPresentation: reasoningEfforts.length ? 'effort' : 'none',
    defaultReasoningEffort: reasoningEfforts.includes(defaultEffort)
      ? defaultEffort
      : (reasoningEfforts.includes('high') ? 'high' : (reasoningEfforts[0] || '')),
    fastParamId: hasFast ? 'fast' : '',
    maxModeWhenFast,
    speedTiers: hasFast || variants.some(variant => variant?.isMaxMode === true)
      ? ['standard', 'fast']
      : ['standard'],
    defaultSpeedTier: hasFast && defaultFast ? 'fast' : 'standard',
    contextWindow: cursorContextWindow(model.id)
  };
}

module.exports = {
  CURSOR_CONTEXT_WINDOWS,
  cursorContextWindow,
  deriveCursorModelCapabilities
};
