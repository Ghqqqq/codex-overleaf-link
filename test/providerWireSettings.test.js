'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-wire-settings-'));
const debugLog = require('../native-host/src/debugLog');
const originalLogDebug = debugLog.logDebug;
debugLog.logDebug = (event, detail) => originalLogDebug(event, detail, {
  homeDir: temporaryRoot, platform: process.platform, env: {}
});
let starters;
try {
  starters = {
    responses: require('../native-host/src/responsesPassthroughBridge').startResponsesPassthroughBridge,
    anthropic: require('../native-host/src/anthropicMessagesBridge').startAnthropicMessagesBridge
  };
} finally {
  debugLog.logDebug = originalLogDebug;
}
const Profiles = require('../extension/src/shared/providerProfiles');
const { normalizeProviderDraft } = require('../native-host/src/providerProfile');
const { upsertProvider, listProviders, clearProviderSecret, getProviderStorePaths, loadProviderState } = require('../native-host/src/providerStore');
const { createProviderLaunch } = require('../native-host/src/codexProviderLaunch');
const SECRET = 'SYNTHETIC_WIRE_SETTINGS_KEY_NOT_A_REAL_CREDENTIAL';
after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

function draft(overrides = {}) {
  return { name: 'Synthetic provider', baseUrl: 'http://127.0.0.1:1/v1', wireApiPreference: 'responses',
    models: [{ id: 'synthetic-model', upstreamResponseMode: 'buffered' }], defaultModelId: 'synthetic-model',
    reasoningAdapter: 'none', reasoningCapability: 'none', ...overrides };
}
function store(t) {
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'store-'));
  const env = { CODEX_OVERLEAF_PROVIDER_STORE_DIR: root };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return env;
}
function save(env, value, options = {}) {
  const catalog = upsertProvider({ draft: value, secretMutation: { kind: 'replace', value: SECRET }, ...options }, env);
  return catalog.providers.find(item => item.id === catalog.savedProviderId);
}
function parseEvents(text) {
  return text.split(/\r?\n\r?\n/).map(block => block.split(/\r?\n/)
    .filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n'))
    .filter(value => value && value !== '[DONE]').map(value => JSON.parse(value));
}
function responseBody(protocol, status = 'completed') {
  if (protocol === 'anthropic') return { id: 'synthetic-message', type: 'message', role: 'assistant', model: 'synthetic-model',
    content: [{ type: 'text', text: 'Synthetic answer' },
      { type: 'tool_use', id: 'synthetic-call', name: 'inspect_fixture', input: { value: 'safe' } }],
    stop_reason: 'tool_use', usage: { input_tokens: 2, output_tokens: 3 } };
  return { id: 'synthetic-response', object: 'response', status, model: 'synthetic-model',
    output: [{ id: 'synthetic-text', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Synthetic answer', annotations: [] },
        { type: 'output_text', text: 'Second part', annotations: [] }] },
    { id: 'synthetic-function', type: 'function_call', status: 'completed', call_id: 'synthetic-call',
      name: 'inspect_fixture', arguments: '{"value":"safe"}' },
    { id: 'synthetic-reasoning', type: 'reasoning', encrypted_content: 'opaque-fixture',
      summary: [{ type: 'summary_text', text: 'Synthetic summary' }] }],
    usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    ...(status === 'failed' ? { error: { code: 'synthetic_rejected', message: 'Synthetic failure ' + SECRET } } : {}),
    ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}) };
}
async function bridgeFixture(t, protocol, { value = {}, payload, upstreamStatus = 200, onRequest, signal } = {}) {
  const received = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push({ body, headers: req.headers, url: req.url });
      if (onRequest) return onRequest(req, res, body);
      res.writeHead(upstreamStatus, { 'content-type': 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload || responseBody(protocol)));
    });
  });
  await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections?.(); }));
  const env = store(t);
  const profile = save(env, draft({ ...value, baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, wireApiPreference: protocol }));
  const launch = createProviderLaunch({ profile, secret: SECRET, modelId: 'synthetic-model', wireApi: protocol });
  const bridge = await starters[protocol]({ launch, signal });
  t.after(() => bridge.close());
  const request = async (body = {}, route = 'responses', fetchSignal = AbortSignal.timeout(5000)) => {
    const response = await fetch(`${bridge.baseUrl}/${route}`, { method: 'POST',
      headers: { authorization: `Bearer ${bridge.clientToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'synthetic-model', input: 'Synthetic input', stream: true,
        tools: [{ type: 'function', name: 'inspect_fixture', parameters: { type: 'object' } }], ...body }), signal: fetchSignal });
    return { status: response.status, type: response.headers.get('content-type'), text: await response.text() };
  };
  return { request, received, launch, bridge };
}

for (const budget of [8192, 32768]) {
  test(`explicit ${budget} survives draft, Store reload, catalog and model fallback`, t => {
    const env = store(t);
    assert.equal(normalizeProviderDraft(draft({ maxOutputTokens: budget })).maxOutputTokens, budget);
    const saved = save(env, draft({ maxOutputTokens: budget }));
    assert.equal(saved.maxOutputTokens, budget);
    assert.equal(JSON.parse(fs.readFileSync(getProviderStorePaths(env).publicFile, 'utf8')).profiles[0].outputBudgetVersion, 1);
    const listed = listProviders(env).providers.find(item => item.id === saved.id);
    const projected = Profiles.normalizeCatalog({ providers: [listed] }).providers.find(item => item.id === saved.id);
    assert.equal(projected.maxOutputTokens, budget);
    const launch = createProviderLaunch({ profile: projected, modelId: 'synthetic-model', wireApi: 'responses' });
    assert.equal(launch.maxOutputTokens, budget);
    const updated = save(env, draft({ maxOutputTokens: budget }), { profileId: saved.id, expectedRevision: saved.revision });
    assert.equal(listProviders(env).providers.find(item => item.id === updated.id).maxOutputTokens, budget);
  });
  test(`unmarked legacy ${budget} retains migration and can be explicitly saved back`, t => {
    const env = store(t), original = save(env, draft({ maxOutputTokens: 4096 }));
    const file = getProviderStorePaths(env).publicFile;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.profiles[0].maxOutputTokens = budget;
    delete raw.profiles[0].outputBudgetVersion;
    fs.writeFileSync(file, JSON.stringify(raw));
    const legacy = listProviders(env).providers.find(item => item.id === original.id);
    assert.equal(legacy.maxOutputTokens, 65536);
    assert.equal(loadProviderState(env).stored.public.profiles[0].maxOutputTokens, budget);
    clearProviderSecret({ providerId: original.id, expectedRevision: legacy.revision }, env);
    const afterClear = loadProviderState(env);
    assert.equal(afterClear.stored.public.profiles[0].maxOutputTokens, budget);
    assert.equal(afterClear.stored.public.profiles[0].outputBudgetVersion, undefined);
    assert.equal(afterClear.public.profiles[0].maxOutputTokens, 65536);
    const explicit = save(env, draft({ maxOutputTokens: budget }), { profileId: original.id, expectedRevision: afterClear.public.profiles[0].revision });
    assert.equal(explicit.maxOutputTokens, budget);
    assert.equal(listProviders(env).providers.find(item => item.id === original.id).maxOutputTokens, budget);
  });
}

for (const protocol of ['responses', 'anthropic']) {
  for (const stream of [true, false]) {
    test(`${protocol} configured buffered sends JSON request and serves ${stream ? 'SSE' : 'JSON'} client`, async t => {
      const fixture = await bridgeFixture(t, protocol);
      const response = await fixture.request({ stream });
      assert.equal(fixture.received[0].body.stream, false);
      assert.equal(response.status, 200);
      const events = stream ? parseEvents(response.text) : [];
      assert.match(response.type, stream ? /text\/event-stream/ : /application\/json/);
      const terminal = stream ? events.find(event => event.type === 'response.completed')?.response : JSON.parse(response.text);
      assert.ok(terminal);
      assert.equal(terminal.status, 'completed');
      const tool = terminal.output.find(item => item.type === 'function_call');
      assert.equal(tool.call_id, 'synthetic-call');
      assert.deepEqual(JSON.parse(tool.arguments), { value: 'safe' });
      if (protocol === 'responses') {
        assert.deepEqual(terminal, responseBody(protocol));
        if (stream) {
          assert.equal(events.filter(item => item.type === 'response.output_text.delta').map(item => item.delta).join(''), 'Synthetic answerSecond part');
          assert.equal(events.find(item => item.type === 'response.output_item.done' && item.item.type === 'reasoning').item.encrypted_content, 'opaque-fixture');
        }
      }
    });
  }
}

test('Responses applies saved vendor overrides while retaining caller core fields and output budget', async t => {
  const fixture = await bridgeFixture(t, 'responses', { value: { maxOutputTokens: 4096,
    bodyOverrides: { vendor_options: { fixture: true }, temperature: 0.2, max_output_tokens: 256 } } });
  await fixture.request({ stream: false, previous_response_id: 'caller-response', max_output_tokens: 1024, temperature: 0.7 });
  const body = fixture.received[0].body;
  assert.deepEqual(body.vendor_options, { fixture: true });
  assert.equal(body.temperature, 0.7);
  assert.equal(body.max_output_tokens, 4096);
  assert.equal(body.previous_response_id, 'caller-response');
  assert.equal(body.input, 'Synthetic input');
  assert.equal(body.model, 'synthetic-model');
  assert.equal(body.tools[0].name, 'inspect_fixture');
  assert.equal(body.stream, false);
});

for (const status of ['failed', 'incomplete']) {
  test(`Responses buffered preserves ${status} and redacts only diagnostics`, async t => {
    const payload = responseBody('responses', status);
    payload.output[0].content[0].text = 'Literal output ' + SECRET;
    const fixture = await bridgeFixture(t, 'responses', { payload });
    const result = await fixture.request();
    const events = parseEvents(result.text);
    assert.equal(events.some(event => event.type === 'response.completed'), false);
    const terminal = events.find(event => event.type === `response.${status}`)?.response;
    assert.ok(terminal);
    assert.equal(terminal.status, status);
    assert.equal(terminal.output[0].content[0].text, 'Literal output ' + SECRET);
    if (status === 'failed') {
      assert.equal(terminal.error.message.includes(SECRET), false);
      assert.match(terminal.error.message, /\[redacted\]/);
    }
  });
}

test('Responses buffered malformed JSON returns fixed safe error', async t => {
  const fixture = await bridgeFixture(t, 'responses', { payload: '{"error":"' + SECRET });
  const result = await fixture.request();
  assert.equal(result.status, 502);
  assert.equal(result.text.includes(SECRET), false);
  assert.match(result.text, /provider_response_invalid/);
});

test('existing core and credential body overrides remain rejected', () => {
  for (const key of ['model', 'messages', 'tools', 'stream', 'system', 'max_tokens', 'input', 'instructions']) {
    assert.throws(() => normalizeProviderDraft(draft({ bodyOverrides: { [key]: 'blocked' } })), error => error.code === 'provider_configuration_invalid');
  }
  assert.throws(() => normalizeProviderDraft(draft({ bodyOverrides: { vendor_options: { api_key: SECRET } } })), error => error.code === 'provider_configuration_invalid');
});

for (const protocol of ['responses', 'anthropic']) {
  for (const mode of ['auto', 'streaming']) {
    test(`${protocol} ${mode} preserves upstream streaming`, async t => {
      const fixture = await bridgeFixture(t, protocol, {
        value: { models: [{ id: 'synthetic-model', upstreamResponseMode: mode }] },
        onRequest(req, res) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const frames = protocol === 'responses'
            ? [{ type: 'response.completed', response: responseBody('responses') }]
            : [{ type: 'message_start', message: { id: 'synthetic-message', model: 'synthetic-model', usage: { input_tokens: 1 } } },
              { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Synthetic streaming' } },
              { type: 'content_block_stop', index: 0 },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }];
          res.end(frames.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''));
        }
      });
      const result = await fixture.request();
      assert.equal(fixture.received[0].body.stream, true);
      assert.equal(result.status, 200);
      assert.ok(parseEvents(result.text).some(event => event.type === 'response.completed'));
    });
  }
  test(`${protocol} buffered client cancellation closes the pending upstream`, async t => {
    let began, closed;
    const requestBegan = new Promise(resolve => { began = resolve; });
    const upstreamClosed = new Promise(resolve => { closed = resolve; });
    const fixture = await bridgeFixture(t, protocol, { onRequest(req, res) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
      res.on('close', closed);
      began();
    } });
    const controller = new AbortController();
    const pending = fixture.request({}, 'responses', controller.signal);
    const rejected = assert.rejects(pending, error => error.name === 'AbortError');
    await requestBegan;
    controller.abort();
    await rejected;
    let timer;
    try {
      await Promise.race([upstreamClosed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('The cancelled bridge kept its upstream open')), 1000);
      })]);
    } finally { clearTimeout(timer); }
    assert.equal(fixture.received[0].body.stream, false);
  });
}

test('Responses overrides cannot introduce a previous response lineage and compact preserves caller shape', async t => {
  const fixture = await bridgeFixture(t, 'responses', { value: {
    bodyOverrides: { vendor_options: { fixture: true }, previous_response_id: 'injected-lineage' }
  } });
  await fixture.request({ stream: false });
  assert.equal('previous_response_id' in fixture.received[0].body, false);
  const compact = await fixture.request({ stream: undefined, max_output_tokens: undefined }, 'responses/compact');
  assert.deepEqual(fixture.received[1].body.vendor_options, { fixture: true });
  assert.equal('previous_response_id' in fixture.received[1].body, false);
  assert.equal('stream' in fixture.received[1].body, false);
  assert.equal('max_output_tokens' in fixture.received[1].body, false);
  assert.equal(compact.text, JSON.stringify(responseBody('responses')));
});

test('Responses buffered duplicate-key and bare errors cannot expose diagnostic credentials', async t => {
  for (const payload of [
    `{"error":{"message":"${SECRET}"},"error":null,"status":"completed","output":[]}`,
    { error: { code: 'synthetic_error', message: SECRET } }
  ]) {
    const fixture = await bridgeFixture(t, 'responses', { payload });
    const result = await fixture.request();
    assert.equal(result.text.includes(SECRET), false);
    assert.equal(result.status, 200);
    assert.ok(parseEvents(result.text).length);
  }
});

test('Responses buffered does not mark a nonterminal JSON result completed', async t => {
  const fixture = await bridgeFixture(t, 'responses', { payload: responseBody('responses', 'in_progress') });
  const result = await fixture.request();
  assert.equal(result.status, 502);
  assert.match(result.text, /provider_response_invalid/);
  assert.equal(result.text.includes('response.completed'), false);
});

test('explicit provider budget keeps model override and ordinary default behavior', t => {
  const env = store(t);
  const profile = save(env, draft({ maxOutputTokens: 8192, models: [
    { id: 'synthetic-model', maxOutputTokens: 4096 }, { id: 'inherited-model', maxOutputTokens: null }
  ] }));
  assert.equal(createProviderLaunch({ profile, modelId: 'synthetic-model', wireApi: 'responses' }).maxOutputTokens, 4096);
  assert.equal(createProviderLaunch({ profile, modelId: 'inherited-model', wireApi: 'responses' }).maxOutputTokens, 8192);
  assert.equal(normalizeProviderDraft(draft()).maxOutputTokens, 65536);
  const projected = Profiles.normalizeProvider({ id: 'projected', ...draft({ maxOutputTokens: 32768 }), outputBudgetVersion: 1 });
  assert.equal(projected.maxOutputTokens, 32768);
  assert.equal(Profiles.normalizeProvider(projected).maxOutputTokens, 32768);
});

for (const budget of [8192, 32768]) {
  test(`production dialog captures explicit ${budget} and Store catalog keeps it`, t => {
    const { extractFunction } = require('./_helpers/extractFunction');
    const source = fs.readFileSync(path.join(__dirname, '../extension/src/content/providerSettingsDialog.js'), 'utf8');
    const provider = draft();
    const readContext = Function('getSelectedProvider', 'getSelectedTestModelId', 'getEndpointHost',
      extractFunction(source, 'readContext') + '; return readContext;')(
      () => provider, () => provider.defaultModelId, url => new URL(url).hostname);
    const fields = { name: provider.name, baseUrl: provider.baseUrl, wireApiPreference: provider.wireApiPreference,
      maxOutputTokens: String(budget) };
    const context = readContext({ draft: provider, verifications: {}, secretAction: 'unchanged',
      root: { querySelector(selector) {
        const name = selector.match(/data-provider-field="([^"]+)"/)?.[1];
        return Object.hasOwn(fields, name) ? { value: fields[name] } : null;
      } } });
    assert.equal(context.draft.maxOutputTokens, budget);
    assert.equal(context.draft.outputBudgetVersion, 1);
    const env = store(t), profile = save(env, context.draft);
    assert.equal(Profiles.normalizeCatalog(listProviders(env)).providers.find(item => item.id === profile.id).maxOutputTokens, budget);
  });
}

test('Responses buffered emits all reasoning, refusal and custom-tool contents with original identities', async t => {
  const payload = responseBody('responses');
  payload.output[0].content.push({ type: 'refusal', refusal: 'Synthetic refusal' });
  payload.output[2].summary.push({ type: 'summary_text', text: 'Second summary' });
  payload.output.push({ id: 'synthetic-custom', type: 'custom_tool_call', status: 'completed',
    call_id: 'synthetic-custom-call', name: 'fixture_editor', input: 'Synthetic custom input' });
  const fixture = await bridgeFixture(t, 'responses', { payload });
  const events = parseEvents((await fixture.request()).text);
  for (const [type, value, index] of [
    ['response.reasoning_summary_text.delta', 'Synthetic summary', 0],
    ['response.reasoning_summary_text.delta', 'Second summary', 1],
    ['response.refusal.delta', 'Synthetic refusal', 2],
    ['response.custom_tool_call_input.delta', 'Synthetic custom input', undefined]
  ]) {
    const event = events.find(item => item.type === type && item.delta === value);
    assert.ok(event, type + ': ' + value);
    if (index !== undefined) assert.equal(event.summary_index ?? event.content_index, index);
  }
  assert.deepEqual(events.find(item => item.type === 'response.completed').response, payload);
  const custom = events.find(item => item.type === 'response.output_item.done' && item.item.id === 'synthetic-custom').item;
  assert.equal(custom.call_id, 'synthetic-custom-call');
  assert.equal(events.find(item => item.type === 'response.refusal.done').refusal, 'Synthetic refusal');
});

test('Responses buffered retains the existing per-event SSE size limit', async t => {
  const payload = responseBody('responses');
  payload.output[0].content[0].text = 'SYNTHETIC_LARGE_OUTPUT_' + 'x'.repeat(8 * 1024 * 1024);
  const fixture = await bridgeFixture(t, 'responses', { payload });
  const result = await fixture.request();
  const events = parseEvents(result.text);
  assert.equal(events.some(item => item.type === 'response.completed'), false);
  assert.equal(result.text.includes('SYNTHETIC_LARGE_OUTPUT_'), false);
  assert.ok(events.some(item => item.type === 'response.failed'));
});
