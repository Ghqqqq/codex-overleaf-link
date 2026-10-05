'use strict';
const { test, after } = require('node:test');
const { assert, SECRET, payload, json, server, bridge, cleanup } = require('./_helpers/providerBoundaryHarness');
after(cleanup);

for (const protocol of ['chat', 'anthropic']) {
  for (const mode of ['unknown', 'matching', 'absent']) test(`${protocol} fallback respects ${mode} response identity`, async t => {
    const upstream = await server(t, (req, res, entry, count) => json(res, payload(protocol, {
      partial: count === 1, text: count === 1 ? 'ONLY_A_OUTPUT' : 'ONLY_B_OUTPUT', id: 'result-' + count
    })));
    const client = await bridge(t, protocol, upstream);
    const a = await client.post({ input: 'ONLY_A_INPUT' }); assert.equal(a.status, 200);
    const b = await client.post({ input: 'ONLY_B_INPUT', ...(mode === 'unknown' ? { previous_response_id: 'unrelated-id' }
      : mode === 'matching' ? { previous_response_id: a.body.id } : {}) });
    assert.equal(b.status, 200);
    assert.equal(upstream.received.at(-1).raw.includes('ONLY_A_OUTPUT'), mode !== 'unknown');
    assert.equal(upstream.received.at(-1).raw.includes('ONLY_B_INPUT'), true);
  });
  test(`${protocol} exhausted A attempts cannot reject explicitly unrelated B while A remains limited`, async t => {
    const upstream = await server(t, (req, res, entry, count) => json(res, payload(protocol, { partial: true, text: 'A_PARTIAL', id: 'result-' + count })));
    const client = await bridge(t, protocol, upstream);
    let previous;
    const allowed = protocol === 'chat' ? 3 : 2;
    for (let i = 0; i < allowed; i++) {
      const next = await client.post({ input: 'A_INPUT', ...(previous ? { previous_response_id: previous } : {}) });
      assert.equal(next.status, 200); previous = next.body.id;
    }
    const stopped = await client.post({ input: 'A_CONTINUE', previous_response_id: previous });
    assert.equal(stopped.status, 502); assert.equal(stopped.body.error.code, 'provider_reasoning_continuation_exhausted');
    const before = upstream.received.length;
    const b = await client.post({ input: 'INDEPENDENT_B', previous_response_id: 'unknown-B' });
    assert.equal(b.status, 200);
    assert.equal(upstream.received.length, before + 1);
    assert.equal(upstream.received.at(-1).raw.includes('A_PARTIAL'), false);
    const oldA = await client.post({ input: 'A_STILL_LIMITED', previous_response_id: previous });
    assert.equal(oldA.status, 502); assert.equal(upstream.received.length, before + 1);
  });
}

for (const protocol of ['responses', 'chat', 'anthropic']) {
  for (const authMode of ['bearer', 'x-api-key', 'api-key', 'custom']) test(`${protocol} ${authMode} cannot follow a credential-bearing cross-origin redirect`, async t => {
    const target = await server(t, (req, res) => json(res, payload(protocol)));
    const upstream = await server(t, (req, res) => { res.writeHead(307, { location: target.baseUrl + '/redirected' }); res.end(); });
    const client = await bridge(t, protocol, upstream, { authMode, apiKeyHeaderName: 'x-private-fixture' });
    const result = await client.post();
    assert.equal(target.received.length, 0, 'neither endpoint credential nor body may be sent to the unconfigured origin');
    assert.equal(result.status, 502); assert.equal(result.body.error.code, 'provider_upstream_error');
    assert.equal(result.text.includes(SECRET), false);
  });
  for (const code of [301, 302, 303, 307, 308]) test(`${protocol} same-origin ${code} keeps Fetch method and body semantics`, async t => {
    const upstream = await server(t, (req, res) => {
      if (req.url === '/final') return json(res, payload(protocol));
      res.writeHead(code, { location: '/final' }); res.end();
    });
    const client = await bridge(t, protocol, upstream, { authMode: 'x-api-key' });
    const result = await client.post(); assert.equal(result.status, 200);
    assert.equal(upstream.received.length, 2);
    const final = upstream.received.at(-1), keepsBody = code === 307 || code === 308;
    assert.equal(final.headers['x-api-key'], SECRET);
    assert.equal(final.method, keepsBody ? 'POST' : 'GET');
    assert.equal(Boolean(final.raw), keepsBody);
  });
  test(`${protocol} same-origin hop cannot conceal a later cross-origin credential redirect`, async t => {
    const target = await server(t, (req, res) => json(res, payload(protocol)));
    const upstream = await server(t, (req, res) => { res.writeHead(308, { location: req.url === '/second' ? target.baseUrl : '/second' }); res.end(); });
    const client = await bridge(t, protocol, upstream, { authMode: 'custom', apiKeyHeaderName: 'x-fixture-key' });
    const result = await client.post();
    assert.equal(target.received.length, 0); assert.equal(upstream.received.length, 2); assert.equal(result.status, 502);
  });
  test(`${protocol} no-auth cross-origin redirect retains existing support`, async t => {
    const target = await server(t, (req, res) => json(res, payload(protocol)));
    const upstream = await server(t, (req, res) => { res.writeHead(308, { location: target.baseUrl }); res.end(); });
    const client = await bridge(t, protocol, upstream, { authMode: 'none' });
    assert.equal((await client.post()).status, 200);
    assert.equal(target.received.length, 1);
    assert.equal(target.received[0].headers.authorization, undefined);
  });
  for (const header of ['Authorization', 'X-Api-Key', 'X-Custom-Auth']) test(`${protocol} raw launch ${header} is also confined on redirects`, async t => {
    const target = await server(t, (req, res) => json(res, payload(protocol)));
    const upstream = await server(t, (req, res) => { res.writeHead(307, { location: target.baseUrl }); res.end(); });
    // Explicit lower-boundary defense: credential headers are normally rejected
    // by Store normalization; no claim that this raw shape is a normal UI input.
    const client = await bridge(t, protocol, upstream, { authMode: 'none' }, {
      apiKey: '', apiKeyHeaderName: header, customHeaders: { [header]: SECRET }
    });
    assert.equal((await client.post()).status, 502);
    assert.equal(target.received.length, 0);
  });
  test(`${protocol} redirect loops remain bounded and errors omit sensitive location text`, async t => {
    const upstream = await server(t, (req, res) => {
      res.writeHead(307, { location: '/loop?synthetic=' + SECRET }); res.end();
    });
    const client = await bridge(t, protocol, upstream, { authMode: 'x-api-key' });
    const result = await client.post();
    assert.equal(result.status, 502); assert.equal(result.body.error.code, 'provider_upstream_error');
    assert.equal(upstream.received.length, 21, 'preserve the existing Fetch limit of 20 followed redirects');
    assert.equal(result.text.includes(SECRET), false);
  });
}

test('Responses compact uses the same credential origin boundary', async t => {
  const target = await server(t, (req, res) => json(res, { id: 'compact', object: 'response.compaction', output: [] }));
  const upstream = await server(t, (req, res) => { res.writeHead(308, { location: target.baseUrl }); res.end(); });
  const client = await bridge(t, 'responses', upstream, { authMode: 'api-key' });
  const result = await client.post({}, 'responses/compact');
  assert.equal(result.status, 502); assert.equal(target.received.length, 0);
});

for (const effort of ['high', 'xhigh', 'max']) test(`DeepSeek ${effort} keeps the explicit configured output maximum`, async t => {
  const upstream = await server(t, (req, res) => json(res, payload('chat')));
  const client = await bridge(t, 'chat', upstream, { reasoningAdapter: 'deepseek', reasoningCapability: 'effort', reasoningEffort: effort });
  assert.equal(client.profile.maxOutputTokens, 4096); assert.equal(client.launch.maxOutputTokens, 4096);
  assert.equal((await client.post()).status, 200);
  assert.equal(upstream.received[0].body.max_tokens, 4096);
});
for (const maximum of [1024, 1025, 4096, 64000, 65536]) for (const mode of ['budget', 'adaptive']) {
  test(`Anthropic ${mode} budget correction preserves maximum ${maximum}`, async t => {
    const upstream = await server(t, (req, res, entry, count) => count === 1
      ? json(res, { error: { message: 'thinking budget_tokens is incompatible ' + SECRET } }, 400)
      : json(res, payload('anthropic')));
    const client = await bridge(t, 'anthropic', upstream, { maxOutputTokens: maximum,
      reasoningAdapter: 'anthropic', reasoningCapability: 'effort', reasoningEffort: 'high', anthropicThinkingMode: mode });
    const result = await client.post();
    assert.ok(upstream.received.every(entry => entry.body.max_tokens <= maximum));
    if (maximum < 64000) {
      assert.equal(upstream.received.length, 1); assert.equal(result.status, 400);
      assert.equal(result.body.error.code, 'provider_upstream_error');
    } else {
      assert.equal(upstream.received.length, 2); assert.equal(result.status, 200);
      assert.equal(upstream.received[1].body.max_tokens, maximum);
      assert.equal(upstream.received[1].body.thinking.budget_tokens, 32000);
    }
    assert.equal(result.text.includes(SECRET), false);
  });
}
