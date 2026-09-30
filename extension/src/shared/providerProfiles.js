(function initCodexOverleafProviderProfiles(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafProviderProfiles = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function providerProfilesFactory() {
  'use strict';

  const BUILTIN_PROVIDER_ID = 'builtin';

  const PROVIDER_CONNECTIONS = {
    kimi: {
      anthropic: { baseUrl: 'https://api.moonshot.cn/anthropic', wireApiPreference: 'anthropic', authMode: 'bearer', reasoningAdapter: 'anthropic' },
      chat: { baseUrl: 'https://api.moonshot.cn/v1', wireApiPreference: 'chat', authMode: 'bearer', reasoningAdapter: 'auto' }
    },
    glm: {
      anthropic: { baseUrl: 'https://open.bigmodel.cn/api/anthropic', wireApiPreference: 'anthropic', authMode: 'bearer', reasoningAdapter: 'anthropic' },
      chat: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', wireApiPreference: 'chat', authMode: 'bearer', reasoningAdapter: 'auto' }
    },
    deepseek: {
      anthropic: { baseUrl: 'https://api.deepseek.com/anthropic', wireApiPreference: 'anthropic', authMode: 'x-api-key', reasoningAdapter: 'anthropic' },
      chat: { baseUrl: 'https://api.deepseek.com', wireApiPreference: 'chat', authMode: 'bearer', reasoningAdapter: 'deepseek' }
    }
  };

  // Shortcuts select a protocol-specific connection, never an active provider.
  const PROVIDER_PRESETS = [
    { id: 'custom', name: 'Custom connection', short: '+', baseUrl: '', wireApiPreference: 'auto' },
    { id: 'openai-compatible', name: 'OpenAI-compatible API', short: 'API', baseUrl: '', wireApiPreference: 'auto' },
    { id: 'anthropic-compatible', name: 'Anthropic-compatible API', short: 'API', baseUrl: '', wireApiPreference: 'anthropic', authMode: 'x-api-key', reasoningAdapter: 'anthropic' },
    { id: 'kimi', name: 'Kimi', short: 'K', ...PROVIDER_CONNECTIONS.kimi.anthropic },
    { id: 'glm', name: 'GLM', short: 'G', ...PROVIDER_CONNECTIONS.glm.anthropic },
    { id: 'deepseek', name: 'DeepSeek', short: 'D', ...PROVIDER_CONNECTIONS.deepseek.anthropic }
  ];
  const MODEL_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

  function getPresetConnectionInfo(baseUrl) {
    const normalized = normalizeText(baseUrl).replace(/\/+$/, '');
    for (const [id, variants] of Object.entries(PROVIDER_CONNECTIONS)) {
      for (const connection of Object.values(variants)) {
        if (normalized === connection.baseUrl) return { id, connection: { ...connection } };
      }
    }
    return null;
  }

  function getPresetConnection(id, protocol) {
    const variants = Object.prototype.hasOwnProperty.call(PROVIDER_CONNECTIONS, id)
      ? PROVIDER_CONNECTIONS[id] : null;
    const connection = variants && Object.prototype.hasOwnProperty.call(variants, protocol)
      ? variants[protocol] : null;
    return connection ? { ...connection } : null;
  }

  function getProviderPresets() {
    return PROVIDER_PRESETS.map(preset => ({ ...preset }));
  }

  function buildPresetDraft(id) {
    const preset = PROVIDER_PRESETS.find(item => item.id === id) || PROVIDER_PRESETS[0];
    const { id: _id, short: _short, ...connection } = preset;
    return { ...buildEmptyDraft(), ...connection,
      name: preset.id === 'custom' ? 'Custom provider' : preset.name };
  }

  function updateDraftModel(draft, originalId, patch) {
    const models = Array.isArray(draft.models) ? draft.models : [];
    const existing = models.find(model => model.id === originalId);
    const fail = (message, field) => { throw Object.assign(new Error(message), { field }); };
    const id = normalizeText(patch.id);
    if (!id || id.length > 200 || /[\0\r\n"&|<>^%!\x60]/.test(id))
      fail('Enter a valid model ID (up to 200 characters).', 'id');
    if (models.some(model => model.id === id && model.id !== originalId))
      fail('This model ID is already configured.', 'id');
    if (!existing && models.length >= 32) fail('A provider can contain up to 32 models.', 'id');
    const contextWindow = Number(patch.contextWindow);
    if (!Number.isSafeInteger(contextWindow) || contextWindow < 8192 || contextWindow > 4000000)
      fail('Context window must be an integer between 8192 and 4000000.', 'contextWindow');
    const maxOutputTokens = patch.maxOutputTokens === '' || patch.maxOutputTokens == null
      ? null : Number(patch.maxOutputTokens);
    if (maxOutputTokens !== null && (!Number.isSafeInteger(maxOutputTokens)
      || maxOutputTokens < 256 || maxOutputTokens > 65536 || maxOutputTokens >= contextWindow))
      fail('Output limit must be between 256 and 65536 and smaller than the context window.', 'maxOutputTokens');
    const model = { ...existing, id, label: normalizeText(patch.label).slice(0, 200) || id,
      contextWindow, maxOutputTokens,
      inputModalities: normalizeInputModalities(patch.inputModalities),
      supportsParallelToolCalls: patch.supportsParallelToolCalls === true,
      upstreamResponseMode: normalizeUpstreamResponseMode(patch.upstreamResponseMode, true),
      reasoningEfforts: MODEL_EFFORTS.filter(effort => patch.reasoningEfforts?.includes(effort)),
      reasoningAdapter: patch.reasoningAdapter ? normalizeReasoningAdapter(patch.reasoningAdapter) : '',
      reasoningCapability: patch.reasoningCapability ? normalizeReasoningCapability(patch.reasoningCapability)
        : patch.reasoningEfforts?.length ? 'effort' : '',
      baseInstructions: normalizeText(patch.baseInstructions).slice(0, 8000)
    };
    model.resolvedUpstreamResponseMode = model.upstreamResponseMode === existing?.upstreamResponseMode
      ? existing.resolvedUpstreamResponseMode || '' : '';
    return { ...draft,
      models: existing ? models.map(item => item.id === originalId ? model : item) : [...models, model],
      defaultModelId: !draft.defaultModelId || draft.defaultModelId === originalId ? id : draft.defaultModelId
    };
  }

  function removeDraftModel(draft, id) {
    const models = (draft.models || []).filter(model => model.id !== id);
    return { ...draft, models, defaultModelId: draft.defaultModelId === id
      ? models[0]?.id || '' : draft.defaultModelId };
  }


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
      maxOutputTokens: normalizeMaxOutputTokens(value.maxOutputTokens),
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
        maxOutputTokens: value?.maxOutputTokens == null ? null : Math.min(65536, Math.max(256, normalizeInteger(value.maxOutputTokens))),
        reasoningAdapter: value?.reasoningAdapter ? normalizeReasoningAdapter(value.reasoningAdapter) : '',
        reasoningCapability: value?.reasoningCapability ? normalizeReasoningCapability(value.reasoningCapability) : '',
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
      maxOutputTokens: 65536,
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

  function getProviderById(catalog = {}, providerId = '') {
    const normalized = normalizeCatalog(catalog);
    const requestedId = normalizeText(providerId) || normalized.activeProviderId || BUILTIN_PROVIDER_ID;
    if (requestedId === BUILTIN_PROVIDER_ID) {
      return normalized.providers.find(provider => provider.id === BUILTIN_PROVIDER_ID)
        || buildBuiltinProvider();
    }
    return normalized.providers.find(provider => provider.id === requestedId) || null;
  }

  function buildRunSelection(catalog = {}, providerId = '') {
    const normalized = normalizeCatalog(catalog);
    const requestedId = normalizeText(providerId) || normalized.activeProviderId || BUILTIN_PROVIDER_ID;
    const provider = getProviderById(normalized, requestedId);
    return {
      providerId: requestedId,
      providerRevision: provider?.revision || 0
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

  function normalizeMaxOutputTokens(value) {
    const number = normalizeInteger(value);
    if (!number || number === 8192 || number === 32768) return 65536;
    return Math.min(65536, Math.max(256, number));
  }

  return {
    BUILTIN_PROVIDER_ID,
    MODEL_EFFORTS,
    getProviderPresets,
    getPresetConnectionInfo,
    getPresetConnection,
    buildPresetDraft,
    updateDraftModel,
    removeDraftModel,
    buildBuiltinProvider,
    buildEmptyDraft,
    buildRunSelection,
    getActiveProvider,
    getProviderById,
    normalizeCatalog,
    normalizeProvider
  };
});
