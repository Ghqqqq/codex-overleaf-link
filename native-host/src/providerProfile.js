'use strict';

const crypto = require('node:crypto');
const {
  normalizeReasoningAdapter,
  normalizeReasoningCapability
} = require('./providerReasoning');

const ALLOWED_WIRE_APIS = new Set(['auto', 'responses', 'chat', 'anthropic']);
const ALLOWED_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const ALLOWED_UPSTREAM_RESPONSE_MODES = new Set(['auto', 'streaming', 'buffered']);
const ALLOWED_AUTH_MODES = new Set(['bearer', 'x-api-key', 'api-key', 'custom', 'none']);
const ALLOWED_INPUT_MODALITIES = new Set(['text', 'image']);
const DEFAULT_CONTEXT_WINDOW = 262144;
const UNSAFE_CLI_VALUE = /[\0\r\n"&|<>^%!`]/;

function normalizeProviderDraft(value = {}) {
  const name = normalizeRequiredText(value.name, 'provider_name_invalid', 'Provider name is required.', 64);
  assertCliSafe(name, 'provider_name_invalid', 'Provider name contains unsupported command characters.');
  const baseUrl = normalizeBaseUrl(value.baseUrl);
  const wireApiPreference = normalizeWireApi(value.wireApiPreference, true);
  const models = normalizeModels(value.models);
  if (!models.length) {
    throw providerError('provider_model_not_configured', 'At least one model ID is required.');
  }
  const defaultModelId = normalizeRequiredText(
    value.defaultModelId,
    'provider_model_not_configured',
    'A default model ID is required.',
    200
  );
  assertCliSafe(defaultModelId, 'provider_model_not_configured', 'Default model ID contains unsupported command characters.');
  if (!models.some(model => model.id === defaultModelId)) {
    throw providerError('provider_model_not_configured', 'The default model must be present in the provider model list.');
  }
  const requestTimeoutMs = normalizeTimeout(value.requestTimeoutMs);
  const reasoningAdapter = normalizeReasoningAdapter(value.reasoningAdapter);
  const reasoningCapability = normalizeReasoningCapability(value.reasoningCapability);
  const authMode = normalizeEnum(value.authMode, ALLOWED_AUTH_MODES, 'bearer');
  const apiKeyHeaderName = normalizeHeaderName(value.apiKeyHeaderName);
  if (authMode === 'custom' && !apiKeyHeaderName) {
    throw providerError('provider_configuration_invalid', 'Custom API-key authentication requires a header name.');
  }
  return {
    name,
    baseUrl,
    wireApiPreference,
    models,
    defaultModelId,
    requestTimeoutMs,
    reasoningAdapter,
    reasoningCapability,
    authMode,
    apiKeyHeaderName,
    fullEndpoint: value.fullEndpoint === true,
    customHeaders: normalizeStringRecord(value.customHeaders, 'Custom headers', { rejectCredentials: true }),
    queryParams: normalizeStringRecord(value.queryParams, 'Query parameters', { rejectCredentials: true }),
    bodyOverrides: normalizeBodyOverrides(value.bodyOverrides),
    contextWindow: normalizeContextWindow(value.contextWindow),
    supportsParallelToolCalls: value.supportsParallelToolCalls === true,
    supportsStreamOptions: value.supportsStreamOptions === true,
    inputModalities: normalizeInputModalities(value.inputModalities),
    anthropicVersion: normalizeOptionalText(value.anthropicVersion, 64) || '2023-06-01',
    anthropicBeta: normalizeOptionalText(value.anthropicBeta, 512),
    anthropicThinkingMode: normalizeAnthropicThinkingMode(value.anthropicThinkingMode),
    anthropicPromptCaching: value.anthropicPromptCaching === true,
    impersonateClaudeCode: value.impersonateClaudeCode === true,
    maxOutputTokens: normalizeMaxOutputTokens(value.maxOutputTokens)
  };
}

function normalizeModels(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const seen = new Set();
  const result = [];
  for (const value of values.slice(0, 32)) {
    const id = normalizeText(typeof value === 'string' ? value : value?.id);
    if (!id || id.length > 200 || seen.has(id)) {
      continue;
    }
    assertCliSafe(id, 'provider_model_not_configured', `Model ID ${id} contains unsupported command characters.`);
    seen.add(id);
    const label = normalizeText(value?.label) || id;
    const reasoningEfforts = Array.isArray(value?.reasoningEfforts)
      ? value.reasoningEfforts.map(normalizeText).filter(effort => ALLOWED_REASONING_EFFORTS.has(effort))
      : [];
    result.push({
      id,
      label: label.slice(0, 200),
      reasoningEfforts: Array.from(new Set(reasoningEfforts)),
      upstreamResponseMode: normalizeUpstreamResponseMode(value?.upstreamResponseMode, true),
      resolvedUpstreamResponseMode: normalizeUpstreamResponseMode(value?.resolvedUpstreamResponseMode, false),
      contextWindow: normalizeContextWindow(value?.contextWindow),
      supportsParallelToolCalls: value?.supportsParallelToolCalls === true,
      inputModalities: normalizeInputModalities(value?.inputModalities),
      baseInstructions: normalizeOptionalText(value?.baseInstructions, 8000)
    });
  }
  return result;
}

function normalizeBaseUrl(value) {
  const text = normalizeRequiredText(value, 'provider_base_url_invalid', 'Base URL is required.', 2048);
  let parsed;
  try {
    parsed = new URL(text);
  } catch (_error) {
    throw providerError('provider_base_url_invalid', 'Base URL is not a valid URL.');
  }
  if (parsed.username || parsed.password) {
    throw providerError('provider_base_url_invalid', 'Base URL cannot contain credentials.');
  }
  if (parsed.search || parsed.hash) {
    throw providerError('provider_base_url_invalid', 'Base URL cannot contain a query string or fragment.');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) {
    throw providerError('provider_base_url_insecure', 'HTTPS is required except for loopback endpoints.');
  }
  const pathname = parsed.pathname.replace(/\/+$/, '');
  const normalized = `${parsed.origin}${pathname === '/' ? '' : pathname}`;
  assertCliSafe(normalized, 'provider_base_url_invalid', 'Base URL contains unsupported command characters.');
  return normalized;
}

function normalizeWireApi(value, allowAuto = false) {
  const normalized = normalizeText(value).toLowerCase();
  if (ALLOWED_WIRE_APIS.has(normalized) && (allowAuto || normalized !== 'auto')) {
    return normalized;
  }
  if (allowAuto && !normalized) {
    return 'auto';
  }
  throw providerError('provider_protocol_incompatible', 'API protocol must be Auto, Responses, Chat Completions, or Anthropic Messages.');
}

function isResolvedWireApi(value) {
  return ALLOWED_WIRE_APIS.has(String(value || '').trim().toLowerCase())
    && String(value || '').trim().toLowerCase() !== 'auto';
}

function normalizeSecret(value) {
  if (value === undefined || value === null || value === '') {
    return '';
  }
  const text = String(value);
  if (text.length > 8192 || /[\0\r\n]/.test(text)) {
    throw providerError('provider_secret_invalid', 'API key contains unsupported characters or exceeds the size limit.');
  }
  return text;
}

function computeDraftFingerprint(draft, secret) {
  const normalized = normalizeProviderDraft(draft);
  const fingerprintDraft = {
    ...normalized,
    models: normalized.models.map(({ resolvedUpstreamResponseMode: _resolvedMode, ...model }) => model)
  };
  const secretDigest = crypto.createHash('sha256').update(normalizeSecret(secret)).digest('hex');
  return crypto.createHash('sha256').update(JSON.stringify({ normalized: fingerprintDraft, secretDigest })).digest('hex');
}

function computeConnectionFingerprint(draft, secret, modelId) {
  const normalized = normalizeProviderDraft(draft);
  const selectedModelId = normalizeText(modelId) || normalized.defaultModelId;
  const selectedModel = normalized.models.find(model => model.id === selectedModelId);
  if (!selectedModel) {
    throw providerError('provider_model_not_configured', 'The selected model is not configured for this provider.');
  }
  const { resolvedUpstreamResponseMode: _resolvedMode, ...model } = selectedModel;
  const connection = {
    baseUrl: normalized.baseUrl,
    wireApiPreference: normalized.wireApiPreference,
    model,
    requestTimeoutMs: normalized.requestTimeoutMs,
    reasoningAdapter: normalized.reasoningAdapter,
    reasoningCapability: normalized.reasoningCapability,
    authMode: normalized.authMode,
    apiKeyHeaderName: normalized.apiKeyHeaderName,
    fullEndpoint: normalized.fullEndpoint,
    customHeaders: normalized.customHeaders,
    queryParams: normalized.queryParams,
    bodyOverrides: normalized.bodyOverrides,
    supportsParallelToolCalls: normalized.supportsParallelToolCalls,
    supportsStreamOptions: normalized.supportsStreamOptions,
    anthropicVersion: normalized.anthropicVersion,
    anthropicBeta: normalized.anthropicBeta,
    anthropicThinkingMode: normalized.anthropicThinkingMode,
    anthropicPromptCaching: normalized.anthropicPromptCaching,
    impersonateClaudeCode: normalized.impersonateClaudeCode,
    maxOutputTokens: normalized.maxOutputTokens
  };
  const secretDigest = crypto.createHash('sha256').update(normalizeSecret(secret)).digest('hex');
  return crypto.createHash('sha256').update(JSON.stringify({ connection, secretDigest })).digest('hex');
}

function getEndpointHost(baseUrl) {
  try {
    return new URL(baseUrl).hostname;
  } catch (_error) {
    return '';
  }
}

function sanitizeProfile(profile, hasSecret) {
  return {
    id: profile.id,
    kind: 'custom',
    revision: profile.revision,
    name: profile.name,
    baseUrl: profile.baseUrl,
    wireApiPreference: profile.wireApiPreference,
    resolvedWireApi: profile.resolvedWireApi || '',
    models: profile.models.map(model => ({ ...model, reasoningEfforts: model.reasoningEfforts.slice() })),
    defaultModelId: profile.defaultModelId,
    requestTimeoutMs: profile.requestTimeoutMs,
    reasoningAdapter: profile.reasoningAdapter || 'auto',
    reasoningCapability: profile.reasoningCapability || 'auto',
    authMode: profile.authMode || 'bearer',
    apiKeyHeaderName: profile.apiKeyHeaderName || '',
    fullEndpoint: profile.fullEndpoint === true,
    customHeaders: { ...(profile.customHeaders || {}) },
    queryParams: { ...(profile.queryParams || {}) },
    bodyOverrides: { ...(profile.bodyOverrides || {}) },
    contextWindow: normalizeContextWindow(profile.contextWindow),
    supportsParallelToolCalls: profile.supportsParallelToolCalls === true,
    supportsStreamOptions: profile.supportsStreamOptions === true,
    inputModalities: normalizeInputModalities(profile.inputModalities),
    anthropicVersion: profile.anthropicVersion || '2023-06-01',
    anthropicBeta: profile.anthropicBeta || '',
    anthropicThinkingMode: normalizeAnthropicThinkingMode(profile.anthropicThinkingMode),
    anthropicPromptCaching: profile.anthropicPromptCaching === true,
    impersonateClaudeCode: profile.impersonateClaudeCode === true,
    maxOutputTokens: normalizeMaxOutputTokens(profile.maxOutputTokens),
    hasSecret: Boolean(hasSecret),
    secretUpdatedAt: profile.secretUpdatedAt || 0,
    endpointDisclosureHost: profile.endpointDisclosureHost || '',
    endpointDisclosureBaseUrl: profile.endpointDisclosureBaseUrl || '',
    endpointDisclosureAcceptedAt: profile.endpointDisclosureAcceptedAt || 0,
    modelDiagnostics: Object.fromEntries(Object.entries(profile.modelDiagnostics || {}).map(([modelId, diagnostic]) => [
      modelId,
      {
        modelId,
        status: diagnostic?.status === 'failed' ? 'failed' : 'tested',
        at: diagnostic?.at || 0,
        wireApi: diagnostic?.wireApi || '',
        upstreamResponseMode: normalizeUpstreamResponseMode(diagnostic?.upstreamResponseMode, false),
        durationMs: diagnostic?.durationMs || 0,
        errorCode: diagnostic?.errorCode || ''
      }
    ])),
    lastVerified: profile.lastVerified
      ? {
          revision: profile.lastVerified.revision,
          at: profile.lastVerified.at,
          modelId: profile.lastVerified.modelId,
          wireApi: profile.lastVerified.wireApi,
          upstreamResponseMode: normalizeUpstreamResponseMode(profile.lastVerified.upstreamResponseMode, false)
        }
      : null,
    createdAt: profile.createdAt || 0,
    updatedAt: profile.updatedAt || 0
  };
}

function normalizeTimeout(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 30000;
  }
  return Math.min(120000, Math.max(5000, Math.floor(number)));
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = normalizeText(value).toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function normalizeHeaderName(value) {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(normalized)) {
    throw providerError('provider_configuration_invalid', 'Custom API-key header name is invalid.');
  }
  return normalized;
}

function parseJsonObject(value, label) {
  if (value === undefined || value === null || value === '') return {};
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (_error) {
      throw providerError('provider_configuration_invalid', `${label} must be valid JSON.`);
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw providerError('provider_configuration_invalid', `${label} must be a JSON object.`);
  }
  return parsed;
}

function normalizeStringRecord(value, label, options = {}) {
  const parsed = parseJsonObject(value, label);
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(parsed)) {
    const key = normalizeText(rawKey);
    const item = String(rawValue ?? '');
    if (!key || /[\0\r\n]/.test(key) || /[\0\r\n]/.test(item)) {
      throw providerError('provider_configuration_invalid', `${label} contains an invalid key or value.`);
    }
    if (options.rejectCredentials && isCredentialLikeKey(key)) {
      throw providerError(
        'provider_configuration_invalid',
        `${label} cannot contain credentials. Use the API-key authentication control instead.`
      );
    }
    result[key] = item;
  }
  return result;
}

function normalizeBodyOverrides(value) {
  const parsed = parseJsonObject(value, 'Request body overrides');
  for (const blocked of ['model', 'messages', 'tools', 'stream', 'system', 'max_tokens', 'input', 'instructions']) {
    if (Object.prototype.hasOwnProperty.call(parsed, blocked)) {
      throw providerError('provider_configuration_invalid', `Request body overrides cannot replace ${blocked}.`);
    }
  }
  if (JSON.stringify(parsed).length > 16384) {
    throw providerError('provider_configuration_invalid', 'Request body overrides are too large.');
  }
  const credentialPath = findCredentialField(parsed);
  if (credentialPath) {
    throw providerError(
      'provider_configuration_invalid',
      `Request body overrides cannot contain credential field ${credentialPath}. Use the API-key authentication control instead.`
    );
  }
  return parsed;
}

function findCredentialField(value, path = []) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findCredentialField(value[index], [...path, String(index)]);
      if (found) return found;
    }
    return '';
  }
  if (!value || typeof value !== 'object') return '';
  for (const [key, item] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (isCredentialLikeKey(key)) return nextPath.join('.');
    const found = findCredentialField(item, nextPath);
    if (found) return found;
  }
  return '';
}

function isCredentialLikeKey(value) {
  const key = String(value || '').trim();
  if (!key) return false;
  if (/^(?:prompt[-_.]?cache[-_.]?key|idempotency[-_.]?key|cache[-_.]?key)$/i.test(key)) {
    return false;
  }
  if (/^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|credential|credentials|token|key|signature|sig)$/i.test(key)) {
    return true;
  }
  return /(?:^|[-_.])(?:api[-_]?key|access[-_]?token|auth[-_]?token|bearer[-_]?token|client[-_]?secret|secret[-_]?key|private[-_]?key|access[-_]?key(?:[-_]?id)?|token|secret|password|passwd|credential|credentials|cookie|signature)(?:$|[-_.])/i.test(key);
}

function normalizeContextWindow(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_CONTEXT_WINDOW;
  return Math.min(4000000, Math.max(8192, Math.floor(number)));
}

function normalizeInputModalities(value) {
  const values = Array.isArray(value) ? value : normalizeText(value).split(',');
  const normalized = values
    .map(item => normalizeText(item).toLowerCase())
    .filter(item => ALLOWED_INPUT_MODALITIES.has(item));
  const result = Array.from(new Set(normalized));
  return result.includes('text') ? result : ['text', ...result];
}

function normalizeOptionalText(value, maxLength) {
  const text = normalizeText(value);
  return text ? text.slice(0, maxLength) : '';
}

function normalizeAnthropicThinkingMode(value) {
  const normalized = normalizeText(value).toLowerCase();
  return ['budget', 'adaptive', 'none'].includes(normalized) ? normalized : 'budget';
}

function normalizeUpstreamResponseMode(value, allowAuto) {
  const normalized = normalizeText(value).toLowerCase();
  if (ALLOWED_UPSTREAM_RESPONSE_MODES.has(normalized) && (allowAuto || normalized !== 'auto')) {
    return normalized;
  }
  return allowAuto ? 'auto' : '';
}

function normalizeMaxOutputTokens(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 8192 || number === 32768) return 65536;
  return Math.min(65536, Math.max(256, Math.floor(number)));
}

function normalizeRequiredText(value, code, message, maxLength) {
  const text = normalizeText(value);
  if (!text || text.length > maxLength || /[\0\r\n]/.test(text)) {
    throw providerError(code, message);
  }
  return text;
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function assertCliSafe(value, code, message) {
  if (UNSAFE_CLI_VALUE.test(value)) {
    throw providerError(code, message);
  }
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function providerError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

module.exports = {
  computeConnectionFingerprint,
  computeDraftFingerprint,
  getEndpointHost,
  isResolvedWireApi,
  normalizeProviderDraft,
  normalizeSecret,
  normalizeWireApi,
  providerError,
  sanitizeProfile
};
