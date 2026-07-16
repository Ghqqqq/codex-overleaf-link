'use strict';

const crypto = require('node:crypto');
const {
  activateProvider,
  clearProviderSecret,
  deleteProvider,
  listProviders,
  loadProviderState,
  recordProviderDiagnostic,
  resolveDraftSecret,
  upsertProvider
} = require('./providerStore');
const {
  computeConnectionFingerprint,
  computeDraftFingerprint,
  getEndpointHost,
  normalizeProviderDraft,
  providerError
} = require('./providerProfile');
const { sanitizeProviderMessage } = require('./providerRedaction');
const { createProviderLaunch } = require('./codexProviderLaunch');
const { runProviderConnectionTest } = require('./codexProviderTest');
const { getReasoningControl } = require('./providerReasoning');

const PROVIDER_METHODS = new Set([
  'codex.providers.list',
  'codex.providers.test',
  'codex.providers.test.cancel',
  'codex.providers.upsert',
  'codex.providers.activate',
  'codex.providers.clear-secret',
  'codex.providers.delete'
]);
const AUTO_PROTOCOL_FALLBACK_CODES = new Set([
  'provider_protocol_incompatible'
]);
const AUTO_RESPONSE_MODE_FALLBACK_CODES = new Set([
  'provider_agent_tools_incompatible',
  'provider_stream_tool_parse_failed'
]);
const activeTests = new Map();

function isProviderMethod(method) {
  return PROVIDER_METHODS.has(method);
}

async function handleProviderRequest(request, env = process.env, emit = () => {}) {
  try {
    const params = request.params || {};
    switch (request.method) {
      case 'codex.providers.list':
        return okResponse(request.id, listProviders(env));
      case 'codex.providers.upsert':
        return okResponse(request.id, upsertProvider(params, env));
      case 'codex.providers.activate':
        return okResponse(request.id, activateProvider(params, env));
      case 'codex.providers.clear-secret':
        return okResponse(request.id, clearProviderSecret(params, env));
      case 'codex.providers.delete':
        return okResponse(request.id, deleteProvider(params, env));
      case 'codex.providers.test.cancel':
        return okResponse(request.id, cancelProviderTest(params.operationId));
      case 'codex.providers.test':
        return okResponse(request.id, await testProvider(params, env, emit));
      default:
        throw providerError('method_not_found', `Unknown provider method: ${request.method}`);
    }
  } catch (error) {
    return providerErrorResponse(request.id, error);
  }
}

async function testProvider(params, env, emit = () => {}, externalSignal = null) {
  const operationId = String(params.operationId || '');
  if (!operationId) {
    throw providerError('invalid_request', 'Provider test requires an operation id.');
  }
  const draft = normalizeProviderDraft(params.draft || {});
  const modelId = String(params.modelId || draft.defaultModelId).trim();
  if (!draft.models.some(model => model.id === modelId)) {
    throw providerError('provider_model_not_configured', 'The selected model is not configured for this provider.');
  }
  const secret = resolveDraftSecret(params, env);
  const fingerprint = computeConnectionFingerprint(draft, secret, modelId);
  const controller = new AbortController();
  const totalBudgetMs = Math.min(120000, Math.max(15000, Number(params.totalBudgetMs) || 120000));
  let budgetExpired = false;
  const budgetTimer = setTimeout(() => {
    budgetExpired = true;
    controller.abort();
  }, totalBudgetMs);
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true });
  activeTests.get(operationId)?.abort?.();
  activeTests.set(operationId, controller);
  const protocols = draft.wireApiPreference === 'auto'
    ? ['responses', 'chat', 'anthropic']
    : [draft.wireApiPreference];
  try {
    let lastError;
    const attempts = protocols.flatMap(wireApi => {
      const model = draft.models.find(item => item.id === modelId) || {};
      const requestedMode = model.upstreamResponseMode || 'auto';
      return wireApi === 'chat' && requestedMode === 'auto'
        ? [{ wireApi, upstreamResponseMode: 'streaming' }, { wireApi, upstreamResponseMode: 'buffered' }]
        : [{ wireApi, upstreamResponseMode: requestedMode === 'buffered' ? 'buffered' : 'streaming' }];
    });
    let attemptNumber = 0;
    for (const wireApi of protocols) {
      const model = draft.models.find(item => item.id === modelId) || {};
      const requestedMode = model.upstreamResponseMode || 'auto';
      const responseModes = wireApi === 'chat' && requestedMode === 'auto'
        ? ['streaming', 'buffered']
        : [requestedMode === 'buffered' ? 'buffered' : 'streaming'];
      let protocolError;
      for (let index = 0; index < responseModes.length; index += 1) {
        const upstreamResponseMode = responseModes[index];
        attemptNumber += 1;
        emitProviderTestProgress(emit, {
          operationId,
          modelId,
          wireApi,
          upstreamResponseMode,
          attempt: attemptNumber,
          totalAttempts: attempts.length
        });
        const launch = createProviderLaunch({
          profile: { id: params.profileId || 'draft', revision: params.expectedRevision || 0, ...draft },
          secret,
          modelId,
          wireApi,
          upstreamResponseMode
        });
        try {
          const result = await runProviderConnectionTest({ launch, env, signal: controller.signal });
          const verification = {
            ok: true,
            operationId,
            draftFingerprint: fingerprint,
            connectionFingerprint: fingerprint,
            resolvedWireApi: wireApi,
            resolvedUpstreamResponseMode: upstreamResponseMode,
            testedModelId: modelId,
            modelId,
            durationMs: result.durationMs,
            capabilities: {
              ...(result.capabilities || { text: true, agentTools: true }),
              upstreamStreaming: upstreamResponseMode === 'streaming'
            }
          };
          if (params.profileId) {
            recordProviderDiagnostic({
              profileId: params.profileId,
              expectedRevision: params.expectedRevision,
              modelId,
              connectionFingerprint: fingerprint,
              wireApi,
              upstreamResponseMode,
              durationMs: result.durationMs
            }, env);
          }
          return verification;
        } catch (error) {
          protocolError = error;
          const canTryBuffered = responseModes[index + 1] === 'buffered'
            && AUTO_RESPONSE_MODE_FALLBACK_CODES.has(error.code);
          if (!canTryBuffered) break;
        }
      }
      lastError = protocolError;
      const canTryNextProtocol = draft.wireApiPreference === 'auto'
        && wireApi !== protocols[protocols.length - 1]
        && AUTO_PROTOCOL_FALLBACK_CODES.has(protocolError?.code);
      if (!canTryNextProtocol) throw protocolError;
    }
    throw lastError || providerError('provider_protocol_incompatible', 'No compatible provider protocol was found.');
  } catch (error) {
    if (budgetExpired) {
      error = providerError('provider_connection_timeout', 'The provider compatibility test exceeded its total time budget.');
    }
    error.message = sanitizeProviderMessage(error?.message, [secret]);
    throw error;
  } finally {
    clearTimeout(budgetTimer);
    externalSignal?.removeEventListener?.('abort', onExternalAbort);
    if (activeTests.get(operationId) === controller) {
      activeTests.delete(operationId);
    }
  }
}

function emitProviderTestProgress(emit, detail) {
  emit({
    type: 'provider.test.progress',
    title: `Testing ${detail.modelId}: ${detail.wireApi} · ${detail.upstreamResponseMode} (${detail.attempt}/${detail.totalAttempts})`,
    status: 'running',
    detail,
    timestamp: new Date().toISOString()
  });
}

function cancelProviderTest(operationId) {
  const id = String(operationId || '');
  const controller = activeTests.get(id);
  if (!controller) {
    return { cancelled: false };
  }
  controller.abort();
  activeTests.delete(id);
  return { cancelled: true };
}

function resolveProviderModels(params = {}, env = process.env, resolveBuiltInModels) {
  const state = loadProviderState(env);
  if (state.public.activeProviderId === 'builtin') {
    return resolveBuiltInModels(params, env);
  }
  const profile = state.public.profiles.find(item => item.id === state.public.activeProviderId);
  if (!profile) {
    throw providerError('provider_not_found', 'The active provider no longer exists.');
  }
  return {
    providerId: profile.id,
    providerRevision: profile.revision,
    providerName: profile.name,
    models: profile.models.map(model => {
      const reasoning = getReasoningControl(profile, model);
      return {
        id: model.id,
        label: model.label || model.id,
        reasoningEfforts: reasoning.efforts,
        defaultReasoningEffort: reasoning.defaultEffort,
        reasoningPresentation: reasoning.presentation,
        speedTiers: ['standard'],
        defaultSpeedTier: 'standard'
      };
    }),
    source: 'custom-provider',
    fetchedAt: new Date().toISOString()
  };
}

function resolveRunProvider(params = {}, env = process.env) {
  const state = loadProviderState(env);
  const selection = params.providerSelection;
  const activeProviderId = state.public.activeProviderId || 'builtin';
  if (selection?.providerId && selection.providerId !== activeProviderId) {
    throw providerError('provider_revision_conflict', 'The active provider changed in another tab. Refresh and retry.');
  }
  if (activeProviderId === 'builtin') {
    return {
      modelId: params.model || '',
      reasoningEffort: params.reasoningEffort || '',
      providerLaunch: null,
      providerSelection: { providerId: 'builtin', providerRevision: 0 }
    };
  }
  const profile = state.public.profiles.find(item => item.id === activeProviderId);
  if (!profile) {
    throw providerError('provider_not_found', 'The active provider no longer exists.');
  }
  if (!selection?.providerId) {
    throw providerError('provider_selection_unavailable', 'The active provider has not been confirmed by this Overleaf tab. Wait for Provider settings to load and retry.');
  }
  if (Number(selection.providerRevision) !== profile.revision) {
    throw providerError('provider_revision_conflict', 'The active provider changed in another tab. Refresh and retry.');
  }
  const endpointHost = getEndpointHost(profile.baseUrl);
  if (profile.endpointDisclosureHost !== endpointHost || profile.endpointDisclosureBaseUrl !== profile.baseUrl) {
    throw providerError('provider_disclosure_required', 'Confirm the current provider endpoint before sending project content.');
  }
  const modelId = String(params.model || profile.defaultModelId).trim();
  const model = profile.models.find(item => item.id === modelId);
  if (!model) {
    throw providerError('provider_model_not_configured', 'The selected model is not configured for the active provider.');
  }
  const secret = state.secrets.secrets[profile.id] || '';
  const connectionFingerprint = computeConnectionFingerprint(profile, secret, modelId);
  const diagnostic = profile.modelDiagnostics?.[modelId];
  const validDiagnostic = diagnostic?.connectionFingerprint === connectionFingerprint
    && ['responses', 'chat', 'anthropic'].includes(diagnostic.wireApi);
  const wireApi = profile.wireApiPreference === 'auto'
    ? (validDiagnostic ? diagnostic.wireApi : '')
    : profile.wireApiPreference;
  if (!wireApi) {
    throw providerError('provider_protocol_negotiation_required', 'The Auto provider needs a one-time compatibility negotiation for this model.');
  }
  const reasoning = getReasoningControl(profile, model);
  const supportedReasoningEfforts = reasoning.efforts;
  const reasoningEffort = supportedReasoningEfforts.includes(params.reasoningEffort)
    ? params.reasoningEffort
    : reasoning.defaultEffort;
  return {
    modelId,
    reasoningEffort,
    providerLaunch: createProviderLaunch({
      profile,
      secret,
      modelId,
      wireApi,
      reasoningEffort,
      upstreamResponseMode: validDiagnostic ? diagnostic.upstreamResponseMode : ''
    }),
    providerSelection: { providerId: profile.id, providerRevision: profile.revision }
  };
}

async function resolveRunProviderForRun(params = {}, env = process.env, options = {}) {
  try {
    return resolveRunProvider(params, env);
  } catch (error) {
    if (error?.code !== 'provider_protocol_negotiation_required') {
      throw error;
    }
  }
  const state = loadProviderState(env);
  const profile = state.public.profiles.find(item => item.id === state.public.activeProviderId);
  if (!profile) {
    throw providerError('provider_not_found', 'The active provider no longer exists.');
  }
  const modelId = String(params.model || profile.defaultModelId).trim();
  options.emit?.({
    type: 'provider.auto-negotiation.started',
    title: `Detecting a compatible API route for ${modelId}.`,
    status: 'running',
    detail: { providerId: profile.id, modelId },
    timestamp: new Date().toISOString()
  });
  await testProvider({
    operationId: `run-${crypto.randomUUID()}`,
    profileId: profile.id,
    expectedRevision: profile.revision,
    draft: profile,
    secretMutation: { kind: 'unchanged' },
    modelId,
    totalBudgetMs: 120000
  }, env, options.emit, options.signal);
  return resolveRunProvider(params, env);
}

function providerErrorResponse(id, error) {
  const code = error?.code || 'provider_operation_failed';
  return {
    id,
    ok: false,
    error: {
      code,
      message: `[${code}] ${sanitizeProviderMessage(error?.message || 'Provider operation failed.')}`
    }
  };
}

function okResponse(id, result) {
  return { id, ok: true, result };
}

module.exports = {
  handleProviderRequest,
  isProviderMethod,
  providerErrorResponse,
  resolveProviderModels,
  resolveRunProvider,
  resolveRunProviderForRun
};
