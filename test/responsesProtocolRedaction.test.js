'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'responses-redaction-'));
const debugLog = require('../native-host/src/debugLog');
const originalLogDebug = debugLog.logDebug;
debugLog.logDebug = (event, detail) => originalLogDebug(event, detail, {
  homeDir: temporaryRoot, platform: process.platform, env: {}
});
const { startResponsesPassthroughBridge } = require('../native-host/src/responsesPassthroughBridge');
debugLog.logDebug = originalLogDebug;
after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

const SECRET = 'SYNTHETIC_RESPONSES_TEST_ONLY_27e9_NOT_A_REAL_CREDENTIAL';
const MESSAGE = `合成错误 (${SECRET})。`;

function frame(payload, event = payload.type, ending = '\n') {
  return `${event ? `event: ${event}${ending}` : ''}data: ${JSON.stringify(payload)}${ending}${ending}`;
}

async function withBridge(t, { body, stream = false, status = 200, send, route = 'responses' }, consume) {
  const received = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      received.push({ authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
      res.writeHead(status, {
        'content-type': stream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8'
      });
      if (send) send(res);
      else res.end(body);
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    upstream.close(resolve);
    upstream.closeAllConnections?.();
  }));
  const bridge = await startResponsesPassthroughBridge({ launch: {
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: SECRET,
    providerName: 'Synthetic loopback test', modelId: 'synthetic-model', authMode: 'bearer'
  } });
  t.after(() => bridge.close());
  const response = await fetch(`${bridge.baseUrl}/${route}`, {
    method: 'POST', headers: {
      authorization: `Bearer ${bridge.clientToken}`, 'content-type': 'application/json'
    },
    body: JSON.stringify({ model: 'synthetic-model', stream, input: 'Synthetic input' }),
    signal: AbortSignal.timeout(5000)
  });
  const actual = consume ? await consume(response) : await response.text();
  assert.equal(received.length, 1);
  assert.equal(received[0].authorization, `Bearer ${SECRET}`);
  assert.equal(received[0].body.stream, stream);
  return { actual, status: response.status, contentType: response.headers.get('content-type') };
}

function assertRedacted(value) {
  assert.equal(JSON.stringify(value).includes(SECRET), false);
  assert.ok(JSON.stringify(value).includes('[redacted]'));
}

for (const stream of [false, true]) {
  test(`HTTP 200 ${stream ? 'SSE' : 'JSON'} failed response redacts diagnostic fields`, async t => {
    const response = { id: 'response-failed', status: 'failed', output: [],
      error: { code: 'test_rejection', message: MESSAGE, details: [{ cause: MESSAGE }] } };
    const payload = stream ? { type: 'response.failed', sequence_number: 7, response } : response;
    const result = await withBridge(t, { stream, body: stream ? frame(payload) : JSON.stringify(payload) });
    assert.equal(result.status, 200);
    assertRedacted(result.actual);
    assert.ok(result.actual.includes('test_rejection'));
    assert.ok(result.actual.includes('response-failed'));
  });

  test(`successful ${stream ? 'SSE' : 'JSON'} text and tool arguments preserve literal credential-shaped content`, async t => {
    const response = { id: 'response-ok', status: 'completed', output: [
      { type: 'message', content: [{ type: 'output_text', text: `合成成功文本 ${SECRET} token=literal` }] },
      { type: 'function_call', name: 'synthetic', arguments: JSON.stringify({ error: SECRET, token: 'literal' }) }
    ] };
    const payload = stream ? { type: 'response.completed', response } : response;
    const body = stream ? `: keepalive\r\n\r\n${frame(payload, payload.type, '\r\n')}data: [DONE]\r\n\r\n` : JSON.stringify(payload);
    const { actual } = await withBridge(t, { stream, body });
    assert.equal(actual, body);
  });
}

test('HTTP 200 JSON error and nested failed envelopes redact diagnostics without touching partial output', async t => {
  const shapes = [
    { error: { message: MESSAGE, nested: { reasons: [MESSAGE] } } },
    { type: 'error', code: 'synthetic_error', message: MESSAGE, param: MESSAGE },
    { response: { status: 'failed', message: MESSAGE, details: { text: MESSAGE } } }
  ];
  for (const payload of shapes) {
    const { actual } = await withBridge(t, { body: JSON.stringify(payload) });
    assertRedacted(JSON.parse(actual));
  }
  const payload = { status: 'failed', error: { message: MESSAGE }, output: [{ type: 'message', text: SECRET }] };
  const { actual } = await withBridge(t, { body: JSON.stringify(payload) });
  const parsed = JSON.parse(actual);
  assertRedacted(parsed.error);
  assert.deepEqual(parsed.output, payload.output);
});

test('SSE event:error with multiline data, CRLF and UTF-8 chunk boundaries is safely reconstructed', async t => {
  const body = `id: synthetic-event\r\nevent: error\r\n: keep comment\r\ndata: {"code":"synthetic_error",\r\ndata: "message":${JSON.stringify(MESSAGE)}}\r\n\r\n`;
  const bytes = Buffer.from(body);
  const { actual } = await withBridge(t, { stream: true, send(res) {
    let position = 0;
    const next = () => {
      if (position === bytes.length) return res.end();
      res.write(bytes.subarray(position, ++position));
      setImmediate(next);
    };
    next();
  } });
  assertRedacted(actual);
  assert.ok(actual.includes('id: synthetic-event\r\n'));
  assert.ok(actual.includes(': keep comment\r\n'));
  const payload = JSON.parse(actual.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5)).join('\n'));
  assert.equal(payload.message, '合成错误 ([redacted])。');
});

test('SSE lone CR framing, nested errors and final frame without delimiter are redacted', async t => {
  const payload = { type: 'response.failed', response: { status: 'failed', error: { details: { message: MESSAGE } } } };
  for (const body of [frame(payload, payload.type, '\r'), frame(payload).trimEnd()]) {
    const { actual } = await withBridge(t, { stream: true, body });
    assertRedacted(actual);
  }
});

test('SSE failures discard superseded duplicate diagnostic values when re-encoding', async t => {
  const body = `event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"message":${JSON.stringify(MESSAGE)},"message":"safe diagnostic"}}}\n\n`;
  const { actual } = await withBridge(t, { stream: true, body });
  assert.equal(actual.includes(SECRET), false);
  assert.ok(actual.includes('safe diagnostic'));
});

test('malformed or truncated SSE errors never escape as raw protocol bytes', async t => {
  for (const body of [
    `event: response.failed\ndata: {"message":${JSON.stringify(MESSAGE)}\n\n`,
    `event: error\ndata: ${MESSAGE}\n\n`,
    `data: {"type":"response.failed","error":${JSON.stringify(MESSAGE)}`,
    `event: error\ndata: ${JSON.stringify(MESSAGE)}\n\n`
  ]) {
    const { actual } = await withBridge(t, { stream: true, body });
    assert.equal(actual.includes(SECRET), false);
    assert.ok(actual.includes('provider_response_invalid'));
    assert.ok(actual.includes('response.failed'));
  }
});

test('oversized SSE event fails before any of its uninspected data is forwarded', async t => {
  const body = `event: error\ndata: {"message":${JSON.stringify(MESSAGE)},"detail":"${'x'.repeat(8 * 1024 * 1024)}"}\n\n`;
  const { actual } = await withBridge(t, { stream: true, body });
  assert.equal(actual.includes(SECRET), false);
  assert.ok(actual.length < 2000);
  assert.ok(actual.includes('response.failed'));
});

test('SSE forwards complete success events before upstream completion', async t => {
  const first = frame({ type: 'response.output_text.delta', delta: '实时文本' });
  const last = frame({ type: 'response.completed', response: { id: 'synthetic-done', status: 'completed', output: [] } });
  let finish;
  const { actual } = await withBridge(t, { stream: true, send(res) {
    finish = () => res.end(last);
    res.write(first);
  } }, async response => {
    const reader = response.body.getReader();
    const initial = await reader.read();
    assert.equal(Buffer.from(initial.value).toString(), first);
    finish();
    let result = Buffer.from(initial.value).toString();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += Buffer.from(value).toString();
    }
    return result;
  });
  assert.equal(actual, first + last);
});

test('non-2xx errors remain redacted and successful compact payload remains opaque', async t => {
  const error = await withBridge(t, { status: 422, body: JSON.stringify({ error: { message: MESSAGE } }) });
  assert.equal(error.status, 422);
  assertRedacted(error.actual);
  const body = JSON.stringify({ id: 'compact-id', output: [{ type: 'compaction', encrypted_content: SECRET }] });
  const compact = await withBridge(t, { body, route: 'responses/compact' });
  assert.equal(compact.actual, body);
});

test('compact HTTP 200 protocol errors use the same diagnostic redaction', async t => {
  for (const payload of [
    { error: { code: 'synthetic_compact_error', message: MESSAGE } },
    { status: 'failed', message: MESSAGE, error: { details: [MESSAGE] } },
    { type: 'error', response: { error: { message: MESSAGE } } }
  ]) {
    const result = await withBridge(t, { body: JSON.stringify(payload), route: 'responses/compact' });
    assert.equal(result.status, 200);
    assertRedacted(result.actual);
  }
});

test('compact success preserves whitespace, encrypted output, HTTP status and content type', async t => {
  const body = `  { "id": "synthetic-compact", "output": [{"type":"compaction","encrypted_content":${JSON.stringify(SECRET)}}] }\n`;
  const result = await withBridge(t, { body, status: 201, route: 'responses/compact' });
  assert.equal(result.actual, body);
  assert.equal(result.status, 201);
  assert.equal(result.contentType, 'application/json; charset=utf-8');
});

test('compact malformed JSON fails without echoing uninspected diagnostics', async t => {
  const result = await withBridge(t, { body: `{"error":{"message":${JSON.stringify(MESSAGE)}`, route: 'responses/compact' });
  assert.equal(result.status, 502);
  assert.equal(result.actual.includes(SECRET), false);
  assert.equal(JSON.parse(result.actual).error.code, 'provider_response_invalid');
});

test('ordinary malformed Responses JSON returns a fixed diagnostic without credential fragments', async t => {
  const fragment = SECRET.slice(0, 20);
  const result = await withBridge(t, { body: `{invalid ${fragment}}` });
  assert.equal(result.status, 502);
  assert.equal(result.actual.includes(fragment), false);
  assert.deepEqual(JSON.parse(result.actual).error, {
    type: 'provider_error', code: 'provider_response_invalid',
    message: 'The provider returned an invalid Responses JSON response.'
  });
});

test('compact accepts a 32 MiB JSON response and rejects a response one byte over budget', async t => {
  const limit = 32 * 1024 * 1024;
  const prefix = '{"output":[{"type":"compaction","encrypted_content":"';
  const suffix = '"}]}';
  const body = prefix + 'x'.repeat(limit - prefix.length - suffix.length) + suffix;
  const success = await withBridge(t, { body, route: 'responses/compact' });
  assert.equal(success.status, 200);
  assert.equal(success.actual, body);
  const failed = await withBridge(t, { body: body + ' ', route: 'responses/compact' });
  assert.equal(failed.status, 502);
  assert.ok(failed.actual.length < 2000);
  assert.equal(JSON.parse(failed.actual).error.code, 'provider_response_too_large');
});

for (const mode of ['SSE', 'compact', 'JSON']) {
  test(`${mode} duplicate keys cannot hide earlier protocol diagnostics`, async t => {
    const stream = mode === 'SSE';
    const route = mode === 'compact' ? 'responses/compact' : 'responses';
    const message = JSON.stringify(MESSAGE);
    const bodies = [
      `{"status":"completed","error":{"message":${message}},"error":null,"output":[]}`,
      `{"status":"completed","error":{"message":${message}},"\\u0065rror":null,"output":[]}`,
      `{"status":"failed","message":${message},"status":"completed","output":[]}`,
      `{"response":{"status":"failed","error":{"message":${message}}},"response":{"status":"completed","output":[]}}`,
      `{"response":{"status":"failed","message":${message},"status":"completed","output":[]}}`
    ];
    for (const body of bodies) {
      const result = await withBridge(t, {
        stream, route,
        body: stream ? `event: response.completed\ndata: ${body}\n\n` : body
      });
      assert.equal(result.status, 200);
      assert.equal(result.actual.includes(SECRET), false);
      assert.ok(result.actual.includes('completed'));
    }
    const response = {
      status: 'completed', output: [{ type: 'message', text: `"error":${SECRET}, "error": null` },
        { type: 'function_call', arguments: '{"error":"a","error":"b"}' }]
    };
    const body = JSON.stringify(response, null, mode === 'compact' ? 2 : undefined);
    const wire = stream ? `data: ${JSON.stringify(response)}\n\n` : body;
    const control = await withBridge(t, { stream, route, body: wire });
    assert.equal(control.actual, wire);
  });
}
