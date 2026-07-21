'use strict';

const { startChatCompletionsBridge } = require('./chatCompletionsBridge');
const { startAnthropicMessagesBridge } = require('./anthropicMessagesBridge');
const { startResponsesPassthroughBridge } = require('./responsesPassthroughBridge');
const { prepareProviderModelCatalog } = require('./providerModelCatalog');

const PROVIDER_CONFIG_ID = 'codex_overleaf_custom';
const PROVIDER_API_KEY_ENV = 'CODEX_OVERLEAF_PROVIDER_API_KEY';
const LOOPBACK_NO_PROXY_HOSTS = ['127.0.0.1', 'localhost', '::1'];

function createProviderLaunch({ profile, secret = '', modelId, wireApi, reasoningEffort = '', upstreamResponseMode = '' }) {
  const model = profile.models.find(item => item.id === modelId) || {};
  const requestedResponseMode = ['streaming', 'buffered'].includes(upstreamResponseMode)
    ? upstreamResponseMode
    : model.upstreamResponseMode || 'auto';
  const resolvedResponseMode = requestedResponseMode === 'auto'
    ? (model.resolvedUpstreamResponseMode || 'streaming')
    : requestedResponseMode;
  return Object.freeze({
    providerId: profile.id,
    providerRevision: profile.revision,
    providerName: profile.name,
    baseUrl: profile.baseUrl,
    modelId,
    wireApi,
    upstreamResponseMode: resolvedResponseMode === 'buffered' ? 'buffered' : 'streaming',
    requestTimeoutMs: profile.requestTimeoutMs,
    reasoningAdapter: profile.reasoningAdapter || 'auto',
    reasoningCapability: profile.reasoningCapability || 'auto',
    reasoningEffort,
    reasoningEfforts: model.reasoningEfforts?.length
      ? model.reasoningEfforts.slice()
      : reasoningEffort
        ? [reasoningEffort]
        : [],
    models: profile.models.map(item => ({ ...item })),
    contextWindow: model.contextWindow || profile.contextWindow,
    supportsParallelToolCalls: model.supportsParallelToolCalls ?? profile.supportsParallelToolCalls,
    supportsStreamOptions: Boolean(profile.supportsStreamOptions),
    inputModalities: model.inputModalities || profile.inputModalities,
    authMode: profile.authMode || 'bearer',
    apiKeyHeaderName: profile.apiKeyHeaderName || '',
    fullEndpoint: Boolean(profile.fullEndpoint),
    customHeaders: { ...(profile.customHeaders || {}) },
    queryParams: { ...(profile.queryParams || {}) },
    bodyOverrides: { ...(profile.bodyOverrides || {}) },
    anthropicVersion: profile.anthropicVersion || '2023-06-01',
    anthropicBeta: profile.anthropicBeta || '',
    anthropicThinkingMode: profile.anthropicThinkingMode || 'budget',
    anthropicPromptCaching: profile.anthropicPromptCaching === true,
    impersonateClaudeCode: profile.impersonateClaudeCode === true,
    maxOutputTokens: profile.maxOutputTokens || 65536,
    apiKey: secret
  });
}

async function prepareProviderLaunch(launch, { signal } = {}) {
  const catalog = prepareProviderModelCatalog(launch);
  if (!catalog.launch || !['responses', 'chat', 'anthropic'].includes(catalog.launch.wireApi)) {
    return { launch: catalog.launch, close: async () => catalog.close() };
  }
  try {
    const routedWireApi = catalog.launch.wireApi;
    const bridge = routedWireApi === 'anthropic'
      ? await startAnthropicMessagesBridge({ launch: catalog.launch, signal })
      : routedWireApi === 'chat'
        ? await startChatCompletionsBridge({ launch: catalog.launch, signal })
        : await startResponsesPassthroughBridge({ launch: catalog.launch, signal });
    return {
      launch: Object.freeze({
        ...catalog.launch,
        upstreamBaseUrl: catalog.launch.baseUrl,
        baseUrl: bridge.baseUrl,
        wireApi: 'responses',
        routedWireApi,
        apiKey: bridge.clientToken,
        authMode: 'bearer',
        apiKeyHeaderName: '',
        fullEndpoint: false,
        customHeaders: {},
        queryParams: {},
        bodyOverrides: {}
      }),
      close: async () => {
        await bridge.close();
        catalog.close();
      }
    };
  } catch (error) {
    catalog.close();
    throw error;
  }
}

function buildProviderConfigArgs(launch) {
  if (!launch) {
    return [];
  }
  const values = [
    ['model', launch.modelId],
    ['model_provider', PROVIDER_CONFIG_ID],
    [`model_providers.${PROVIDER_CONFIG_ID}.name`, launch.providerName],
    [`model_providers.${PROVIDER_CONFIG_ID}.base_url`, launch.baseUrl],
    [`model_providers.${PROVIDER_CONFIG_ID}.wire_api`, launch.wireApi]
  ];
  if (launch.apiKey && (launch.authMode || 'bearer') === 'bearer') {
    values.push([`model_providers.${PROVIDER_CONFIG_ID}.env_key`, PROVIDER_API_KEY_ENV]);
  }
  const args = [];
  for (const [key, value] of values) {
    args.push('-c', `${key}=${encodeTomlString(value)}`);
  }
  args.push('-c', `model_providers.${PROVIDER_CONFIG_ID}.requires_openai_auth=false`);
  if (launch.modelCatalogPath) {
    args.push('-c', `model_catalog_json=${encodeTomlString(launch.modelCatalogPath)}`);
  }
  if (Object.keys(launch.customHeaders || {}).length) {
    args.push('-c', `model_providers.${PROVIDER_CONFIG_ID}.http_headers=${encodeTomlTable(launch.customHeaders)}`);
  }
  if (Object.keys(launch.queryParams || {}).length) {
    args.push('-c', `model_providers.${PROVIDER_CONFIG_ID}.query_params=${encodeTomlTable(launch.queryParams)}`);
  }
  const authHeader = resolveAuthHeader(launch);
  if (launch.apiKey && authHeader) {
    args.push('-c', `model_providers.${PROVIDER_CONFIG_ID}.env_http_headers=${encodeTomlTable({
      [authHeader]: PROVIDER_API_KEY_ENV
    })}`);
  }
  return args;
}

function applyProviderEnvironment(env, launch) {
  const result = { ...(env || process.env) };
  delete result[PROVIDER_API_KEY_ENV];
  if (launch?.apiKey) {
    result[PROVIDER_API_KEY_ENV] = launch.apiKey;
  }
  if (isLoopbackBaseUrl(launch?.baseUrl)) {
    const noProxy = mergeNoProxyValues(result.NO_PROXY, result.no_proxy, LOOPBACK_NO_PROXY_HOSTS);
    result.NO_PROXY = noProxy;
    result.no_proxy = noProxy;
  }
  return result;
}

function isLoopbackBaseUrl(value) {
  try {
    const hostname = new URL(String(value || '')).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return LOOPBACK_NO_PROXY_HOSTS.includes(hostname);
  } catch (_error) {
    return false;
  }
}

function mergeNoProxyValues(...values) {
  const entries = [];
  const seen = new Set();
  for (const value of values.flat()) {
    for (const entry of String(value || '').split(',')) {
      const normalized = entry.trim();
      const key = normalized.toLowerCase();
      if (!normalized || seen.has(key)) continue;
      seen.add(key);
      entries.push(normalized);
    }
  }
  return entries.includes('*') ? '*' : entries.join(',');
}

function buildProviderSnapshot(launch) {
  if (!launch) {
    return {
      providerId: 'builtin',
      providerRevision: 0,
      providerName: 'Built-in Codex',
      providerKind: 'builtin'
    };
  }
  return {
    providerId: launch.providerId,
    providerRevision: launch.providerRevision,
    providerName: launch.providerName,
    providerKind: 'custom',
    modelId: launch.modelId,
    wireApi: launch.routedWireApi || launch.wireApi,
    upstreamResponseMode: launch.upstreamResponseMode || 'streaming',
    requestTimeoutMs: launch.requestTimeoutMs
  };
}

function encodeTomlString(value) {
  return JSON.stringify(String(value ?? ''));
}

function encodeTomlTable(value) {
  return `{${Object.entries(value || {}).map(([key, item]) => (
    `${encodeTomlString(key)}=${encodeTomlString(item)}`
  )).join(',')}}`;
}

function resolveAuthHeader(launch) {
  if (!launch || launch.authMode === 'none' || (launch.authMode || 'bearer') === 'bearer') return '';
  if (launch.authMode === 'x-api-key') return 'x-api-key';
  if (launch.authMode === 'api-key') return 'api-key';
  return launch.apiKeyHeaderName || '';
}

module.exports = {
  PROVIDER_API_KEY_ENV,
  applyProviderEnvironment,
  buildProviderConfigArgs,
  buildProviderSnapshot,
  createProviderLaunch,
  prepareProviderLaunch
};
