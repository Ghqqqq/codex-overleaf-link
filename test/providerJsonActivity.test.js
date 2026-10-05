'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const { test, after } = require('node:test');
const lifecyclePath = require.resolve('../native-host/src/providerStreamLifecycle');
const lifecycle = { exports: {} }, expired = [];
// Execute the production lifecycle unchanged, replacing only its timer clock
// speed. The real HTTP body reads, aborts, duration resolvers and guards remain.
vm.runInNewContext(fs.readFileSync(lifecyclePath, 'utf8'), {
  module: lifecycle, exports: lifecycle.exports, TypeError, Number, String, Math,
  setTimeout: (callback, ms) => setTimeout(() => { expired.push(ms); callback(); }, ms / 500), clearTimeout
}, { filename: lifecyclePath });
require.cache[lifecyclePath] = { id: lifecyclePath, filename: lifecyclePath, loaded: true, exports: lifecycle.exports };
const { assert, SECRET, payload, json, server, bridge, cleanup } = require('./_helpers/providerBoundaryHarness');
after(cleanup);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function chunked(t, protocol, { silent = false, duration = 360, status = 200, invalid = false } = {}) {
  const sends = [], closes = [];
  let startBody;
  const started = new Promise(resolve => { startBody = resolve; });
  const value = status === 200 ? payload(protocol, { text: '完整甲😀尾' }) : { error: { message: 'Unrelated rejection ' + SECRET } };
  const text = invalid ? '{"error":"' + SECRET + '" invalid' : JSON.stringify(value);
  const bytes = Buffer.from(text), emoji = bytes.indexOf(Buffer.from('😀'));
  const split = emoji >= 0 ? emoji + 1 : Math.min(10, bytes.length - 1);
  const upstream = await server(t, async (req, res) => {
    res.on('close', () => closes.push(Date.now()));
    res.writeHead(status, { 'content-type': 'application/json' }); res.flushHeaders();
    const began = Date.now();
    for (let elapsed = 0; elapsed < duration; elapsed += 40) {
      if (elapsed) await sleep(40);
      if (res.destroyed) return;
      if (!silent) {
        const part = elapsed === 0 ? bytes.subarray(0, split) : elapsed === 40 ? bytes.subarray(split, bytes.length - 1) : Buffer.from(' ');
        res.write(part); sends.push(Date.now() - began);
      }
      startBody();
    }
    await sleep(40);
    if (!res.destroyed) res.end(silent ? bytes : bytes.subarray(bytes.length - 1));
  });
  return { upstream, sends, closes, started };
}

for (const protocol of ['chat', 'anthropic', 'responses']) {
  for (const stream of [false, true]) test(`${protocol} ordinary JSON reports each UTF-8 chunk for client stream=${stream}`, async t => {
    const h = await chunked(t, protocol);
    const client = await bridge(t, protocol, h.upstream);
    const before = expired.length;
    const result = await client.post({ stream });
    assert.equal(result.status, 200);
    assert.ok(result.text.includes('完整甲😀尾'));
    assert.equal(result.text.includes('\uFFFD'), false);
    assert.ok(h.sends.at(-1) > 240, 'body remains active beyond the ordinary idle duration');
    assert.deepEqual(expired.slice(before), []);
  });
  test(`${protocol} truly silent JSON still reaches the idle timeout`, async t => {
    const h = await chunked(t, protocol, { silent: true });
    const client = await bridge(t, protocol, h.upstream);
    const before = expired.length, result = await client.post();
    assert.equal(result.status, 504); assert.equal(result.body.error.code, 'provider_connection_timeout');
    assert.deepEqual(expired.slice(before), [120000]);
  });
  test(`${protocol} active JSON still obeys the independent total deadline`, async t => {
    const h = await chunked(t, protocol, { duration: 720 });
    // Direct launch control for the existing total owner; the public profile
    // does not currently expose this override.
    const client = await bridge(t, protocol, h.upstream, {}, { totalRequestTimeoutMs: 240000 });
    const before = expired.length, result = await client.post();
    assert.equal(result.status, 504); assert.equal(result.body.error.code, 'provider_connection_timeout');
    assert.deepEqual(expired.slice(before), [240000]);
  });
  test(`${protocol} client cancellation closes an active JSON upstream`, async t => {
    const h = await chunked(t, protocol, { duration: 720 });
    const client = await bridge(t, protocol, h.upstream), controller = new AbortController();
    const pending = client.post({}, 'responses', controller.signal);
    await h.started; controller.abort();
    await assert.rejects(pending);
    for (let i = 0; i < 50 && !h.closes.length; i++) await sleep(10);
    assert.equal(h.closes.length, 1);
  });
  test(`${protocol} active HTTP error JSON keeps its rejection and redacts the credential`, async t => {
    const h = await chunked(t, protocol, { status: 400 });
    const client = await bridge(t, protocol, h.upstream);
    const result = await client.post();
    assert.equal(result.status, 400); assert.equal(result.body.error.code, 'provider_upstream_error');
    assert.equal(result.text.includes(SECRET), false);
  });
  test(`${protocol} malformed ordinary JSON returns a safe error`, async t => {
    const upstream = await server(t, (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"text":"' + SECRET + '" broken'); });
    const client = await bridge(t, protocol, upstream);
    const result = await client.post();
    assert.equal(result.status, 502);
    assert.ok(['provider_response_invalid', 'provider_bridge_failed'].includes(result.body.error.code));
    assert.equal(result.text.includes(SECRET), false);
  });
}

test('Responses compact retains its existing per-chunk activity reader', async t => {
  const h = await chunked(t, 'responses');
  const client = await bridge(t, 'responses', h.upstream);
  const result = await client.post({}, 'responses/compact');
  assert.equal(result.status, 200); assert.ok(result.text.includes('完整甲😀尾'));
});
