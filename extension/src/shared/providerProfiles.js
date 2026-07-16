(function initCodexOverleafProviderProfiles(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafProviderProfiles = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function providerProfilesFactory() {
  'use strict';

  const BUILTIN_PROVIDER_ID = 'builtin';

  function normalizeCatalog(value = {}) {
    const providers = Array.isArray(value.providers)
      ? value.providers.map(normalizeProvider).filter(Boolean)
      : [];
    if (!providers.some(provider => provider.id === BUILTIN_PROVIDER_ID)) {
      providers.unshift(buildBuiltinProvider());
    }
    const requestedActiveId = normalizeText(value.activeProviderId);
    const activeProviderId = providers.some(provider => provider.id === requestedActiveId)
      ? requestedActiveId
      : BUILTIN_PROVIDER_ID;
    return {
      activeProviderId,
      providers,
      storeRevision: normalizeInteger(value.storeRevision)
    };
  }

  function normalizeProvider(value) {
    if (!value || typeof value !== 'object') {
      return null;
    }
    const id = normalizeText(value.id);
    if (!id) {
      return null;
    }
    if (id === BUILTIN_PROVIDER_ID || value.kind === 'builtin') {
      return buildBuiltinProvider();
    }
    const models = normalizeModels(value.models);
    const defaultModelId = normalizeText(value.defaultModelId) || models[0]?.id || '';
    return {
      id,
      kind: 'custom',
      revision: normalizeInteger(value.revision),
      name: normalizeText(value.name) || 'Custom provider',
      baseUrl: normalizeText(value.baseUrl),
      wireApiPreference: normalizeWireApi(value.wireApiPreference, true),
      resolvedWireApi: normalizeWireApi(value.resolvedWireApi, false),
      models,
      defaultModelId,
      requestTimeoutMs: normalizeInteger(value.requestTimeoutMs) || 30000,
      reasoningAdapter: normalizeReasoningAdapter(value.reasoningAdapter),
      reasoningCapability: normalizeReasoningCapability(value.reasoningCapability),
      authMode: normalizeAuthMode(value.authMode),
      apiKeyHeaderName: normalizeText(value.apiKeyHeaderName),
      fullEndpoint: value.fullEndpoint === true,
      customHeaders: normalizeRecord(value.customHeaders),
      queryParams: normalizeRecord(value.queryParams),
      bodyOverrides: normalizeRecord(value.bodyOverrides),
      contextWindow: normalizeInteger(value.contextWindow) || 262144,
      supportsParallelToolCalls: value.supportsParallelToolCalls === true,
      supportsStreamOptions: value.supportsStreamOptions === true,
      inputModalities: normalizeInputModalities(value.inputModalities),
      anthropicVersion: normalizeText(value.anthropicVersion) || '2023-06-01',
      anthropicBeta: normalizeText(value.anthropicBeta),
      anthropicThinkingMode: normalizeAnthropicThinkingMode(value.anthropicThinkingMode),
      anthropicPromptCaching: value.anthropicPromptCaching === true,
      impersonateClaudeCode: value.impersonateClaudeCode === true,
      maxOutputTokens: normalizeInteger(value.maxOutputTokens) || 8192,
      hasSecret: value.hasSecret === true,
      secretUpdatedAt: normalizeInteger(value.secretUpdatedAt),
      endpointDisclosureHost: normalizeText(value.endpointDisclosureHost),
      endpointDisclosureBaseUrl: normalizeText(value.endpointDisclosureBaseUrl),
      endpointDisclosureAcceptedAt: normalizeInteger(value.endpointDisclosureAcceptedAt),
      modelDiagnostics: normalizeModelDiagnostics(value.modelDiagnostics),
      lastVerified: value.lastVerified && typeof value.lastVerified === 'object'
        ? {
            revision: normalizeInteger(value.lastVerified.revision),
            at: normalizeInteger(value.lastVerified.at),
            modelId: normalizeText(value.lastVerified.modelId),
            wireApi: normalizeWireApi(value.lastVerified.wireApi, false),
            upstreamResponseMode: normalizeUpstreamResponseMode(value.lastVerified.upstreamResponseMode, false)
          }
        : null,
      createdAt: normalizeInteger(value.createdAt),
      updatedAt: normalizeInteger(value.updatedAt)
    };
  }

  function normalizeModels(models) {
    if (!Array.isArray(models)) {
      return [];
    }
    const seen = new Set();
    const result = [];
    for (const value of models) {
      const id = normalizeText(typeof value === 'string' ? value : value?.id);
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      result.push({
        id,
        label: normalizeText(value?.label) || id,
        reasoningEfforts: Array.isArray(value?.reasoningEfforts)
          ? value.reasoningEfforts.map(normalizeText).filter(Boolean)
          : [],
        upstreamResponseMode: normalizeUpstreamResponseMode(value?.upstreamResponseMode, true),
        resolvedUpstreamResponseMode: normalizeUpstreamResponseMode(value?.resolvedUpstreamResponseMode, false),
        contextWindow: normalizeInteger(value?.contextWindow) || 262144,
        supportsParallelToolCalls: value?.supportsParallelToolCalls === true,
        inputModalities: normalizeInputModalities(value?.inputModalities),
        baseInstructions: normalizeText(value?.baseInstructions)
      });
    }
    return result;
  }

  function buildBuiltinProvider() {
    return {
      id: BUILTIN_PROVIDER_ID,
      kind: 'builtin',
      revision: 0,
      name: 'Built-in Codex',
      editable: false,
      deletable: false,
      models: []
    };
  }

  function buildEmptyDraft() {
    return {
      id: '',
      kind: 'custom',
      revision: 0,
      name: 'Custom provider',
      baseUrl: '',
      wireApiPreference: 'auto',
      resolvedWireApi: '',
      models: [],
      defaultModelId: '',
      requestTimeoutMs: 30000,
      reasoningAdapter: 'auto',
      reasoningCapability: 'auto',
      authMode: 'bearer',
      apiKeyHeaderName: '',
      fullEndpoint: false,
      customHeaders: {},
      queryParams: {},
      bodyOverrides: {},
      contextWindow: 262144,
      supportsParallelToolCalls: false,
      supportsStreamOptions: false,
      inputModalities: ['text'],
      anthropicVersion: '2023-06-01',
      anthropicBeta: '',
      anthropicThinkingMode: 'budget',
      anthropicPromptCaching: false,
      impersonateClaudeCode: false,
      maxOutputTokens: 8192,
      hasSecret: false,
      secretUpdatedAt: 0,
      endpointDisclosureHost: '',
      endpointDisclosureBaseUrl: '',
      modelDiagnostics: {},
      lastVerified: null
    };
  }

  function getActiveProvider(catalog = {}) {
    const normalized = normalizeCatalog(catalog);
    return normalized.providers.find(provider => provider.id === normalized.activeProviderId)
      || buildBuiltinProvider();
  }

  function buildRunSelection(catalog = {}) {
    const active = getActiveProvider(catalog);
    return {
      providerId: active.id,
      providerRevision: active.revision || 0
    };
  }

  function normalizeWireApi(value, allowAuto) {
    const normalized = normalizeText(value).toLowerCase();
    if (normalized === 'responses' || normalized === 'chat' || normalized === 'anthropic') {
      return normalized;
    }
    return allowAuto ? 'auto' : '';
  }

  function normalizeReasoningAdapter(value) {
    const normalized = normalizeText(value).toLowerCase();
    return ['auto', 'none', 'deepseek', 'anthropic', 'reasoning_effort', 'openrouter', 'enable_thinking', 'thinking', 'reasoning_split'].includes(normalized)
      ? normalized
      : 'auto';
  }

  function normalizeReasoningCapability(value) {
    const normalized = normalizeText(value).toLowerCase();
    return ['auto', 'none', 'toggle', 'effort'].includes(normalized) ? normalized : 'auto';
  }

  function normalizeUpstreamResponseMode(value, allowAuto) {
    const normalized = normalizeText(value).toLowerCase();
    if (normalized === 'streaming' || normalized === 'buffered' || (allowAuto && normalized === 'auto')) {
      return normalized;
    }
    return allowAuto ? 'auto' : '';
  }

  function normalizeAuthMode(value) {
    const normalized = normalizeText(value).toLowerCase();
    return ['bearer', 'x-api-key', 'api-key', 'custom', 'none'].includes(normalized)
      ? normalized
      : 'bearer';
  }

  function normalizeRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  }

  function normalizeModelDiagnostics(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    const result = {};
    for (const [rawModelId, rawDiagnostic] of Object.entries(value).slice(0, 32)) {
      const modelId = normalizeText(rawModelId);
      if (!modelId || !rawDiagnostic || typeof rawDiagnostic !== 'object') {
        continue;
      }
      const status = normalizeText(rawDiagnostic.status).toLowerCase();
      result[modelId] = {
        modelId,
        status: status === 'failed' ? 'failed' : 'tested',
        at: normalizeInteger(rawDiagnostic.at),
        wireApi: normalizeWireApi(rawDiagnostic.wireApi, false),
        upstreamResponseMode: normalizeUpstreamResponseMode(rawDiagnostic.upstreamResponseMode, false),
        durationMs: normalizeInteger(rawDiagnostic.durationMs),
        errorCode: normalizeText(rawDiagnostic.errorCode)
      };
    }
    return result;
  }

  function normalizeInputModalities(value) {
    const values = Array.isArray(value) ? value : ['text'];
    const result = Array.from(new Set(values.map(normalizeText).filter(item => item === 'text' || item === 'image')));
    return result.includes('text') ? result : ['text', ...result];
  }

  function normalizeAnthropicThinkingMode(value) {
    const normalized = normalizeText(value).toLowerCase();
    return ['budget', 'adaptive', 'none'].includes(normalized) ? normalized : 'budget';
  }

  function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function normalizeInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
  }

  return {
    BUILTIN_PROVIDER_ID,
    buildBuiltinProvider,
    buildEmptyDraft,
    buildRunSelection,
    getActiveProvider,
    normalizeCatalog,
    normalizeProvider
  };
});
