const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  computeConnectionFingerprint,
  computeDraftFingerprint,
  normalizeProviderDraft
} = require('../native-host/src/providerProfile');
const {
  PROVIDER_API_KEY_ENV,
  applyProviderEnvironment
} = require('../native-host/src/codexProviderLaunch');
const { sanitizeProviderMessage } = require('../native-host/src/providerRedaction');
const { getReasoningControl, resolveReasoningAdapter } = require('../native-host/src/providerReasoning');
const { buildProviderModelCatalogData } = require('../native-host/src/providerModelCatalog');
const { buildChatRequest } = require('../native-host/src/chatBridgeRequest');
const {
  convertChatResponse,
  streamChatResponse,
  writeConvertedResponseAsSse
} = require('../native-host/src/chatBridgeResponse');
const { buildChatCompletionsUrl, buildUpstreamHeaders } = require('../native-host/src/chatCompletionsBridge');
const { resolveRunProvider } = require('../native-host/src/providerRuntime');
const { classifyProviderFailure } = require('../native-host/src/codexProviderTest');
const { classifyResponsesRoute } = require('../native-host/src/providerBridgeRoutes');
const {
  getProviderStorePaths,
  activateProvider,
  clearProviderSecret,
  listProviders,
  loadProviderState,
  upsertProvider
} = require('../native-host/src/providerStore');
const ModelPickerSupport = require('../extension/src/content/modelPickerSupport');
const ProviderProfiles = require('../extension/src/shared/providerProfiles');

function withProviderStore(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-provider-'));
  const env = { ...process.env, CODEX_OVERLEAF_PROVIDER_STORE_DIR: root };
  try {
    return callback(env);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function makeDraft(overrides = {}) {
  return {
    name: 'Example Provider',
    baseUrl: 'https://api.example.com/v1',
    wireApiPreference: 'responses',
    models: [{ id: 'example-model', label: 'Example Model', reasoningEfforts: [] }],
    defaultModelId: 'example-model',
    requestTimeoutMs: 30000,
    reasoningAdapter: 'none',
    reasoningCapability: 'none',
    ...overrides
  };
}

function makeSseCollector() {
  let body = '';
  return {
    writableEnded: false,
    writeHead() {},
    write(value) {
      body += String(value || '');
      return true;
    },
    end(value = '') {
      body += String(value || '');
      this.writableEnded = true;
    },
    get body() {
      return body;
    }
  };
}

function saveVerifiedProvider(env, draft, options = {}) {
  const secret = options.secret || 'sk-test-secret';
  return upsertProvider({
    profileId: options.profileId,
    expectedRevision: options.expectedRevision || 0,
    draft,
    secretMutation: options.profileId
      ? { kind: 'unchanged' }
      : { kind: 'replace', value: secret },
    verifiedDraftFingerprint: computeConnectionFingerprint(draft, secret, draft.defaultModelId),
    verifiedWireApi: options.verifiedWireApi || 'responses',
    activate: options.activate === true,
    disclosureHost: options.activate === true ? new URL(draft.baseUrl).hostname : '',
    disclosureBaseUrl: options.activate === true ? draft.baseUrl : ''
  }, env);
}

function loadProviderDialogContract() {
  const source = fs.readFileSync(path.join(__dirname, '../extension/src/content/providerSettingsDialog.js'), 'utf8');
  const context = { window: {} };
  vm.runInNewContext(source, context);
  return context.window.CodexOverleafProviderSettingsDialog;
}

test('custom runs require the provider revision displayed by the current tab', () => {
  withProviderStore(env => {
    const catalog = saveVerifiedProvider(env, makeDraft(), { activate: true });
    const profile = catalog.providers.find(provider => provider.id === catalog.activeProviderId);
    assert.throws(
      () => resolveRunProvider({ model: 'example-model' }, env),
      error => error?.code === 'provider_selection_unavailable'
    );
    const resolved = resolveRunProvider({
      model: 'example-model',
      providerSelection: { providerId: profile.id, providerRevision: profile.revision }
    }, env);
    assert.equal(resolved.providerSelection.providerId, profile.id);
    assert.equal(resolved.providerSelection.providerRevision, profile.revision);
  });
});

test('changing the active provider destination deactivates it and clears disclosure', () => {
  withProviderStore(env => {
    const initial = saveVerifiedProvider(env, makeDraft(), { activate: true });
    const profile = initial.providers.find(provider => provider.id === initial.activeProviderId);
    const changedDraft = makeDraft({ baseUrl: 'https://other.example.com/v1' });
    const updated = saveVerifiedProvider(env, changedDraft, {
      profileId: profile.id,
      expectedRevision: profile.revision
    });
    const changed = updated.providers.find(provider => provider.id === profile.id);
    assert.equal(updated.activeProviderId, 'builtin');
    assert.equal(changed.endpointDisclosureHost, '');
    assert.equal(changed.endpointDisclosureBaseUrl, '');
  });
});

test('providers can be saved and activated without a prior compatibility test', () => {
  withProviderStore(env => {
    const draft = makeDraft({ wireApiPreference: 'auto' });
    const saved = upsertProvider({
      draft,
      secretMutation: { kind: 'replace', value: 'sk-untested' }
    }, env);
    const provider = saved.providers.find(item => item.kind === 'custom');
    assert.equal(provider.lastVerified, null);
    const active = activateProvider({
      providerId: provider.id,
      expectedRevision: provider.revision,
      disclosureHost: 'api.example.com',
      disclosureBaseUrl: draft.baseUrl
    }, env);
    assert.equal(active.activeProviderId, provider.id);
  });
});

test('stored API keys can be cleared without testing and active providers fail safe to builtin', () => {
  withProviderStore(env => {
    const initial = saveVerifiedProvider(env, makeDraft(), { activate: true });
    const provider = initial.providers.find(item => item.id === initial.activeProviderId);
    const cleared = clearProviderSecret({
      providerId: provider.id,
      expectedRevision: provider.revision
    }, env);
    const updated = cleared.providers.find(item => item.id === provider.id);
    assert.equal(cleared.activeProviderId, 'builtin');
    assert.equal(updated.hasSecret, false);
    assert.deepEqual(updated.modelDiagnostics, {});
  });
});

test('provider state recovers a stale inter-process lock and keeps stores aligned', () => {
  withProviderStore(env => {
    const paths = getProviderStorePaths(env);
    fs.mkdirSync(paths.root, { recursive: true });
    fs.writeFileSync(paths.lockFile, 'stale-owner', { mode: 0o600 });
    const stale = new Date(Date.now() - 60000);
    fs.utimesSync(paths.lockFile, stale, stale);
    assert.equal(listProviders(env).activeProviderId, 'builtin');
    const state = loadProviderState(env);
    assert.equal(state.public.storeRevision, state.secrets.storeRevision);
    assert.equal(fs.existsSync(paths.lockFile), false);
  });
});

test('three saved providers can activate the third profile without another upsert', () => {
  withProviderStore(env => {
    let catalog;
    for (let index = 1; index <= 3; index += 1) {
      catalog = saveVerifiedProvider(env, makeDraft({
        name: `Provider ${index}`,
        baseUrl: `https://api${index}.example.com/v1`,
        models: [{ id: `model-${index}`, label: `Model ${index}`, reasoningEfforts: [] }],
        defaultModelId: `model-${index}`
      }));
    }
    const third = catalog.providers.find(provider => provider.name === 'Provider 3');
    const activated = activateProvider({
      providerId: third.id,
      expectedRevision: third.revision,
      disclosureHost: 'api3.example.com',
      disclosureBaseUrl: 'https://api3.example.com/v1'
    }, env);
    assert.equal(activated.activeProviderId, third.id);
    assert.equal(activated.providers.filter(provider => provider.kind === 'custom').length, 3);
    const active = activated.providers.find(provider => provider.id === third.id);
    assert.equal(active.revision, third.revision + 1);
    assert.equal(active.lastVerified.revision, active.revision);
  });
});

test('provider footer separates saved activation from draft save actions', () => {
  const { getFooterActionState } = loadProviderDialogContract();
  const newDraft = getFooterActionState({ isNew: true, canSave: true });
  assert.equal(newDraft.showSave, true);
  assert.equal(newDraft.showSaveAndUse, true);
  assert.equal(newDraft.showUse, false);

  const savedInactive = getFooterActionState({ canActivate: true });
  assert.equal(savedInactive.showSave, false);
  assert.equal(savedInactive.showSaveAndUse, false);
  assert.equal(savedInactive.showUse, true);
  assert.equal(savedInactive.useEnabled, true);

  const dirtyInactive = getFooterActionState({ dirty: true, canSave: false });
  assert.equal(dirtyInactive.showSave, true);
  assert.equal(dirtyInactive.showSaveAndUse, true);
  assert.equal(dirtyInactive.showUse, false);
  assert.equal(dirtyInactive.saveEnabled, false);

  const active = getFooterActionState({ active: true, canActivate: true });
  assert.equal(active.showUse, false);
  assert.equal(active.showSaveAndUse, false);

  const dirtyActive = getFooterActionState({ active: true, dirty: true, canSave: false });
  assert.equal(dirtyActive.showSave, true);
  assert.equal(dirtyActive.showSaveAndUse, false);
  assert.equal(dirtyActive.showUse, false);
  assert.equal(dirtyActive.saveEnabled, false);
});

test('editing a saved provider refreshes the footer on the first dirty transition', () => {
  const dialogSource = fs.readFileSync(path.join(__dirname, '../extension/src/content/providerSettingsDialog.js'), 'utf8');
  assert.match(
    dialogSource,
    /function markDirty\(instance, options = \{\}\)\s*\{[\s\S]*?const footerNeedsRefresh = instance\.dirty !== true;[\s\S]*?if \(options\.invalidateVerification !== false\)\s*\{[\s\S]*?invalidateVerification\(instance, true\);[\s\S]*?if \(footerNeedsRefresh\)\s*\{[\s\S]*?renderFooter\(instance\);[\s\S]*?applyBusyState\(instance\);/
  );
});

test('provider rows stay inside the sidebar and expose clipped names', () => {
  const dialogSource = fs.readFileSync(path.join(__dirname, '../extension/src/content/providerSettingsDialog.js'), 'utf8');
  const panelCss = fs.readFileSync(path.join(__dirname, '../extension/styles/panel.css'), 'utf8');
  assert.match(dialogSource, /codex-provider-row-main" title="\$\{escapeAttr\(provider\.name\)\}"/);
  assert.match(panelCss, /\.codex-provider-row,[\s\S]*?box-sizing:\s*border-box;[\s\S]*?max-width:\s*100%;[\s\S]*?overflow:\s*hidden;/);
  assert.match(panelCss, /\.codex-provider-row-main\s*\{[^}]*width:\s*100%;[^}]*text-overflow:\s*ellipsis;/);
});

test('provider errors redact the exact API key even when it is unlabelled', () => {
  const secret = 'sk-exact-private-value';
  const sanitized = sanitizeProviderMessage(`upstream echoed ${secret} and Bearer ${secret}`, [secret]);
  assert.doesNotMatch(sanitized, /sk-exact-private-value/);
  assert.match(sanitized, /\[redacted\]/);
});

test('advanced provider fields reject credentials before they enter the public profile', () => {
  assert.throws(
    () => normalizeProviderDraft(makeDraft({ customHeaders: { 'x-goog-api-key': 'secret' } })),
    error => error?.code === 'provider_configuration_invalid'
  );
  assert.throws(
    () => normalizeProviderDraft(makeDraft({ queryParams: { access_token: 'secret' } })),
    error => error?.code === 'provider_configuration_invalid'
  );
  assert.throws(
    () => normalizeProviderDraft(makeDraft({ bodyOverrides: { vendor: { client_secret: 'secret' } } })),
    error => error?.code === 'provider_configuration_invalid'
  );
  assert.throws(
    () => normalizeProviderDraft(makeDraft({ customHeaders: { 'x-vendor-token': 'secret' } })),
    error => error?.code === 'provider_configuration_invalid'
  );
  const safe = normalizeProviderDraft(makeDraft({
    customHeaders: { 'anthropic-version': '2023-06-01' },
    queryParams: { 'api-version': '2026-01-01' },
    bodyOverrides: { temperature: 0, prompt_cache_key: 'cache-route' }
  }));
  assert.equal(safe.customHeaders['anthropic-version'], '2023-06-01');
  assert.equal(safe.bodyOverrides.prompt_cache_key, 'cache-route');
});

test('Auto protocol fallback distinguishes endpoint mismatch from request rejection', () => {
  assert.equal(classifyProviderFailure('HTTP 404: route not found', 1).code, 'provider_protocol_incompatible');
  assert.equal(classifyProviderFailure('HTTP 400: max_tokens must be below 8192', 1).code, 'provider_request_rejected');
  assert.equal(classifyProviderFailure('HTTP 422: unknown field reasoning', 1).code, 'provider_request_rejected');
  assert.equal(classifyProviderFailure('HTTP 404: model example-model not found', 1).code, 'provider_model_not_found');
});

test('Auto providers persist a verified Anthropic Messages route', () => {
  withProviderStore(env => {
    const catalog = saveVerifiedProvider(env, makeDraft({ wireApiPreference: 'auto' }), {
      activate: true,
      verifiedWireApi: 'anthropic'
    });
    const profile = catalog.providers.find(provider => provider.id === catalog.activeProviderId);
    assert.equal(profile.resolvedWireApi, 'anthropic');
    assert.equal(profile.lastVerified.wireApi, 'anthropic');
  });
});

test('unknown custom-model context keeps the 256K product default', () => {
  const normalized = normalizeProviderDraft(makeDraft());
  assert.equal(normalized.contextWindow, 262144);
  assert.equal(normalized.models[0].contextWindow, 262144);
  const catalog = buildProviderModelCatalogData({ modelId: 'vendor-model' });
  assert.equal(catalog.models[0].context_window, 262144);
});

test('custom providers migrate the legacy 8K output budget to the 32K default', () => {
  assert.equal(normalizeProviderDraft(makeDraft()).maxOutputTokens, 65536);
  assert.equal(normalizeProviderDraft(makeDraft({ maxOutputTokens: 8192 })).maxOutputTokens, 65536);
  assert.equal(normalizeProviderDraft(makeDraft({ maxOutputTokens: 65536 })).maxOutputTokens, 65536);
  assert.equal(ProviderProfiles.buildEmptyDraft().maxOutputTokens, 65536);
  assert.equal(ProviderProfiles.normalizeProvider({
    id: 'legacy-provider',
    kind: 'custom',
    models: [{ id: 'legacy-model' }],
    maxOutputTokens: 8192
  }).maxOutputTokens, 65536);
  assert.equal(ProviderProfiles.normalizeProvider({
    id: 'custom-provider',
    kind: 'custom',
    models: [{ id: 'custom-model' }],
    maxOutputTokens: 65536
  }).maxOutputTokens, 65536);
});

test('local protocol bridges accept Responses Compact aliases', () => {
  assert.equal(classifyResponsesRoute('POST', '/v1/responses'), 'responses');
  assert.equal(classifyResponsesRoute('POST', '/v1/responses/compact'), 'compact');
  assert.equal(classifyResponsesRoute('POST', '/codex/v1/responses/compact/'), 'compact');
  assert.equal(classifyResponsesRoute('GET', '/v1/responses/compact'), '');
});

test('DeepSeek endpoints automatically expose the supported reasoning controls', () => {
  const inferred = {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    reasoningAdapter: 'auto',
    reasoningCapability: 'auto'
  };
  assert.equal(resolveReasoningAdapter(inferred, 'deepseek-reasoner'), 'deepseek');
  assert.deepEqual(getReasoningControl(inferred, {
    id: 'deepseek-reasoner',
    reasoningEfforts: ['high', 'xhigh']
  }), { efforts: ['high', 'xhigh'], defaultEffort: 'high', presentation: 'deepseek' });
  assert.equal(resolveReasoningAdapter({ ...inferred, reasoningAdapter: 'deepseek' }, 'deepseek-reasoner'), 'deepseek');
});

test('local chat bridge bypasses system proxies without discarding existing rules', () => {
  const source = {
    HTTP_PROXY: 'http://proxy.example:8080',
    NO_PROXY: 'api.example.com,localhost',
    no_proxy: 'internal.example,127.0.0.1',
    [PROVIDER_API_KEY_ENV]: 'stale-token'
  };
  const result = applyProviderEnvironment(source, {
    baseUrl: 'http://127.0.0.1:43123/v1',
    apiKey: 'bridge-token'
  });
  const bypasses = new Set(result.NO_PROXY.split(','));

  assert.equal(result.HTTP_PROXY, source.HTTP_PROXY);
  assert.equal(result.no_proxy, result.NO_PROXY);
  assert.equal(result[PROVIDER_API_KEY_ENV], 'bridge-token');
  assert.deepEqual(bypasses, new Set([
    'api.example.com',
    'localhost',
    'internal.example',
    '127.0.0.1',
    '::1'
  ]));
  assert.equal(source.NO_PROXY, 'api.example.com,localhost');
  assert.equal(source.no_proxy, 'internal.example,127.0.0.1');
});

test('remote Responses providers keep the caller proxy environment unchanged', () => {
  const source = { NO_PROXY: 'api.example.com', no_proxy: 'internal.example' };
  const result = applyProviderEnvironment(source, {
    baseUrl: 'https://api.example.com/v1',
    apiKey: ''
  });

  assert.equal(result.NO_PROXY, source.NO_PROXY);
  assert.equal(result.no_proxy, source.no_proxy);
});

test('model discovery fallback is limited to confirmed Built-in Codex catalogs', () => {
  assert.equal(ModelPickerSupport.shouldUseBuiltInFallback({ ok: true, result: { models: [] } }), true);
  assert.equal(ModelPickerSupport.shouldUseBuiltInFallback({
    ok: true,
    result: { providerId: 'custom-one', models: [] }
  }), false);
  assert.equal(ModelPickerSupport.shouldUseBuiltInFallback({
    ok: false,
    error: { code: 'provider_not_found' }
  }), false);
});

test('custom models use the portable shell-only Codex catalog', () => {
  const catalog = buildProviderModelCatalogData({
    modelId: 'vendor-model',
    models: [{
      id: 'vendor-model',
      label: 'Vendor model',
      reasoningEfforts: ['none', 'high'],
      contextWindow: 131072,
      inputModalities: ['text']
    }]
  });
  assert.equal(catalog.models[0].slug, 'vendor-model');
  assert.equal(catalog.models[0].shell_type, 'shell_command');
  assert.equal(catalog.models[0].supports_search_tool, false);
  assert.deepEqual(catalog.models[0].experimental_supported_tools, []);
  assert.equal(catalog.models[0].context_window, 131072);
});

test('chat compatibility keeps optional request fields capability-gated', () => {
  const translated = buildChatRequest({
    requestBody: {
      model: 'vendor-model',
      input: 'Inspect the project.',
      stream: true,
      parallel_tool_calls: true,
      tools: [{ type: 'custom', name: 'shell', description: 'Run a shell command.' }]
    },
    launch: { modelId: 'vendor-model', bodyOverrides: { enable_thinking: true } }
  });
  assert.equal(translated.body.enable_thinking, true);
  assert.equal('stream_options' in translated.body, false);
  assert.equal('parallel_tool_calls' in translated.body, false);
  assert.equal(translated.body.tools[0].function.name, 'shell');
});

test('chat compatibility applies the configured provider output budget consistently', () => {
  const fallback = buildChatRequest({
    requestBody: { model: 'vendor-model', input: 'Inspect the project.' },
    launch: { modelId: 'vendor-model', maxOutputTokens: 65536 }
  });
  assert.equal(fallback.body.max_tokens, 65536);

  const explicit = buildChatRequest({
    requestBody: {
      model: 'vendor-model',
      input: 'Inspect the project.',
      max_output_tokens: 4096
    },
    launch: { modelId: 'vendor-model', maxOutputTokens: 65536 }
  });
  assert.equal(explicit.body.max_tokens, 65536);
});

test('chat compatibility preserves length-limited terminal semantics', async () => {
  const converted = convertChatResponse({
    id: 'chat-limited',
    model: 'vendor-model',
    choices: [{
      finish_reason: 'length',
      message: { reasoning_content: 'The reasoning reached the provider output limit.' }
    }]
  }, {
    model: 'vendor-model',
    requestBody: {},
    launch: { modelId: 'vendor-model' }
  });
  assert.equal(converted.response.status, 'incomplete');
  assert.deepEqual(converted.response.incomplete_details, { reason: 'max_output_tokens' });

  const bufferedSse = makeSseCollector();
  writeConvertedResponseAsSse(bufferedSse, converted);
  assert.match(bufferedSse.body, /event: response\.incomplete/);
  assert.doesNotMatch(bufferedSse.body, /event: response\.completed/);

  const streamingSse = makeSseCollector();
  const upstream = {
    body: (async function* stream() {
      yield Buffer.from('data: {"id":"chat-stream","choices":[{"delta":{"reasoning_content":"Still checking."},"finish_reason":"length"}]}\n\n');
      yield Buffer.from('data: [DONE]\n\n');
    }())
  };
  const streamed = await streamChatResponse({
    upstream,
    res: streamingSse,
    context: { model: 'vendor-model', requestBody: {}, launch: { modelId: 'vendor-model' } }
  });
  assert.equal(streamed.status, 'incomplete');
  assert.deepEqual(streamed.incomplete_details, { reason: 'max_output_tokens' });
  assert.match(streamingSse.body, /event: response\.incomplete/);
  assert.doesNotMatch(streamingSse.body, /event: response\.completed/);
});

test('chat compatibility restores namespaced tools and structured reasoning', () => {
  const request = buildChatRequest({
    requestBody: {
      model: 'vendor-model',
      input: 'Use the tool.',
      stream: false,
      tools: [{
        type: 'namespace',
        name: 'workspace',
        tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }]
      }]
    },
    launch: { modelId: 'vendor-model' }
  });
  const chatName = request.body.tools[0].function.name;
  const converted = convertChatResponse({
    id: 'chat-one',
    model: 'vendor-model',
    choices: [{ message: {
      reasoning_details: [{ text: 'Need the file.' }],
      tool_calls: [{ id: 'call-one', function: { name: chatName, arguments: '{"path":"main.tex"}' } }]
    }}]
  }, {
    model: 'vendor-model',
    requestBody: {},
    toolKinds: request.toolKinds,
    launch: { modelId: 'vendor-model' }
  });
  assert.equal(converted.response.output[0].type, 'reasoning');
  assert.equal(converted.response.output[1].name, 'read_file');
  assert.equal(converted.response.output[1].namespace, 'workspace');
});

test('chat endpoint and authentication support provider-specific routing', () => {
  const launch = {
    baseUrl: 'https://provider.example/custom/chat',
    fullEndpoint: true,
    queryParams: { apiVersion: '2026-01-01' },
    authMode: 'x-api-key',
    apiKey: 'secret',
    customHeaders: { 'anthropic-version': '2023-06-01' }
  };
  assert.equal(
    buildChatCompletionsUrl(launch.baseUrl, launch),
    'https://provider.example/custom/chat?apiVersion=2026-01-01'
  );
  const headers = buildUpstreamHeaders(launch);
  assert.equal(headers['x-api-key'], 'secret');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers.authorization, undefined);
});
