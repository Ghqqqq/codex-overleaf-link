'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-tool-completion-'));
const debugLog = require('../native-host/src/debugLog');
const originalLogDebug = debugLog.logDebug;
debugLog.logDebug = (event, detail) => originalLogDebug(event, detail, {
  homeDir: temporaryHome, platform: process.platform, env: {}
});
let starters;
try {
  starters = {
    chat: require('../native-host/src/chatCompletionsBridge').startChatCompletionsBridge,
    anthropic: require('../native-host/src/anthropicMessagesBridge').startAnthropicMessagesBridge
  };
} finally {
  debugLog.logDebug = originalLogDebug;
}
after(() => fs.rmSync(temporaryHome, { recursive: true, force: true }));

const partialArguments = '{"target":"UNFINISHED_SYNTHETIC_VALUE';
const completeArguments = '{"target":"safe-fixture"}';
const functionTool = { type: 'function', name: 'inspect_fixture', parameters: {
  type: 'object', properties: { target: { type: 'string' } }, additionalProperties: false
} };
const customTool = { type: 'custom', name: 'emit_fixture', description: 'Synthetic declaration; no executable handler exists.' };

function frame(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function responseFrames(protocol, body, options) {
  const args = options.arguments || [completeArguments];
  const tools = options.textOnly ? [] : body.tools || [];
  const calls = tools.map((tool, index) => ({
    name: protocol === 'chat' ? tool.function.name : tool.name,
    args: args[index] ?? completeArguments,
    id: `synthetic-call-${index}`
  }));
  if (protocol === 'chat') {
    const frames = [];
    if (options.text) frames.push(frame({ choices: [{ index: 0, delta: { content: options.text } }] }));
    for (const [index, call] of calls.entries()) {
      frames.push(frame({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id,
        type: 'function', function: { name: call.name, arguments: call.args } }] } }] }));
    }
    if (options.termination === 'terminal') frames.push(frame({ choices: [{ index: 0, delta: {},
      finish_reason: calls.length ? 'tool_calls' : 'stop' }] }));
    return frames.join('');
  }
  const frames = [frame({ type: 'message_start', message: { id: 'synthetic-anthropic', model: 'synthetic-model', usage: { input_tokens: 1 } } })];
  let index = 0;
  if (options.text) {
    frames.push(frame({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }),
      frame({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: options.text } }));
    if (options.termination === 'terminal') frames.push(frame({ type: 'content_block_stop', index }));
    index += 1;
  }
  for (const call of calls) {
    frames.push(frame({ type: 'content_block_start', index,
      content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } }));
    if (call.args) frames.push(frame({ type: 'content_block_delta', index,
      delta: { type: 'input_json_delta', partial_json: call.args } }));
    if (['terminal', 'block-stop'].includes(options.termination)) frames.push(frame({ type: 'content_block_stop', index }));
    index += 1;
  }
  if (options.termination === 'terminal') frames.push(frame({ type: 'message_delta',
    delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } }));
  return frames.join('');
}

function parseEvents(body) {
  return body.split(/\r?\n\r?\n/).filter(Boolean).map(block => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    return data ? JSON.parse(data) : null;
  }).filter(Boolean);
}

async function exercise(t, protocol, options = {}) {
  let upstreamResponse;
  const received = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      received.push(body);
      upstreamResponse = res;
      if (options.buffered) {
        res.writeHead(200, { 'content-type': 'application/json' });
        const payload = protocol === 'anthropic' ? {
          id: 'synthetic-anthropic', type: 'message', role: 'assistant', stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'synthetic-call', name: body.tools[0].name,
            input: JSON.parse(options.arguments[0]) }]
        } : { id: 'synthetic-chat', choices: [{ finish_reason: 'tool_calls', message: {
          tool_calls: [{ id: 'synthetic-call', type: 'function', function: {
            name: body.tools[0].function.name, arguments: options.arguments[0]
          } }]
        } }] };
        res.end(JSON.stringify(payload));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write(responseFrames(protocol, body, options));
      // Reset only after the real bridge has parsed and forwarded a delta.
      if (options.termination !== 'reset') res.end();
    });
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  let bridge;
  t.after(async () => {
    if (bridge) await bridge.close();
    await new Promise(resolve => {
      upstream.close(resolve);
      upstream.closeAllConnections?.();
    });
  });
  bridge = await starters[protocol]({ launch: {
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
    apiKey: 'SYNTHETIC_TOOL_TEST_ONLY', authMode: 'bearer', providerName: 'Synthetic loopback',
    modelId: 'synthetic-model', reasoningAdapter: 'none', reasoningCapability: 'none',
    maxOutputTokens: 1024, supportsParallelToolCalls: true
  } });
  const response = await fetch(`${bridge.baseUrl}/responses`, {
    method: 'POST', headers: { authorization: `Bearer ${bridge.clientToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'synthetic-model', stream: options.stream !== false,
      input: 'Inspect only a described synthetic fixture.', tools: options.tools || [functionTool], parallel_tool_calls: true }),
    signal: AbortSignal.timeout(5000)
  });
  let body = '';
  let destroyed = false;
  for await (const chunk of response.body) {
    body += Buffer.from(chunk).toString('utf8');
    const trigger = options.textOnly ? 'response.output_text.delta' : 'response.function_call_arguments.delta';
    if (options.termination === 'reset' && !destroyed && body.includes(trigger)) {
      destroyed = true;
      upstreamResponse.destroy();
    }
  }
  assert.equal(received.length, 1);
  assert.equal(received[0].stream, options.stream !== false);
  if (options.termination === 'reset') assert.equal(destroyed, true);
  const isSse = response.headers.get('content-type')?.includes('text/event-stream');
  const events = isSse ? parseEvents(body) : [];
  return { status: response.status, body, events, json: isSse ? null : JSON.parse(body),
    terminal: events.filter(event => /^response\.(completed|failed|incomplete)$/.test(event.type)).at(-1),
    doneTools: events.filter(event => event.type === 'response.output_item.done'
      && ['function_call', 'custom_tool_call'].includes(event.item?.type)).map(event => event.item) };
}

function assertRejectedTool(result) {
  assert.equal(result.terminal?.type, 'response.failed');
  assert.equal(result.terminal.response.error.code, 'provider_response_invalid');
  assert.deepEqual(result.doneTools, []);
  assert.equal(result.events.some(event => /(?:function_call_arguments|custom_tool_call_input)\.done$/.test(event.type)), false);
  assert.equal(result.terminal.response.error.message.includes('UNFINISHED_SYNTHETIC_VALUE'), false);
}

for (const protocol of ['chat', 'anthropic']) {
  for (const termination of ['eof', 'terminal']) {
    for (const kind of ['function', 'custom']) {
      test(`${protocol} rejects incomplete ${kind} arguments at ${termination}`, { timeout: 10000 }, async t => {
        const result = await exercise(t, protocol, { termination, arguments: [partialArguments],
          tools: [kind === 'custom' ? customTool : functionTool] });
        assertRejectedTool(result);
      });
    }
  }
  for (const kind of ['function', 'custom']) {
    test(`${protocol} keeps complete ${kind} arguments at EOF without a terminal marker`, { timeout: 10000 }, async t => {
      const args = kind === 'custom' ? '{"input":"synthetic input"}' : completeArguments;
      const result = await exercise(t, protocol, { termination: 'eof', arguments: [args], tools: [kind === 'custom' ? customTool : functionTool] });
      assert.equal(result.terminal.type, 'response.completed');
      assert.equal(result.doneTools.length, 1);
      assert.equal(result.doneTools[0].status, 'completed');
      assert.equal(kind === 'custom' ? result.doneTools[0].input : result.doneTools[0].arguments,
        kind === 'custom' ? 'synthetic input' : completeArguments);
    });
  }
  test(`${protocol} preserves no-argument, parallel, namespaced and custom calls`, { timeout: 10000 }, async t => {
    const result = await exercise(t, protocol, { termination: 'terminal', text: 'A safe explanation.',
      arguments: ['', '{"input":""}', completeArguments, '{"input":"synthetic input"}'],
      tools: [functionTool, customTool, { type: 'namespace', name: 'fixture', tools: [functionTool, customTool] }] });
    assert.equal(result.terminal.type, 'response.completed');
    assert.deepEqual(result.doneTools.map(item => ({ type: item.type, name: item.name, namespace: item.namespace || '',
      value: item.type === 'custom_tool_call' ? item.input : item.arguments })), [
      { type: 'function_call', name: 'inspect_fixture', namespace: '', value: '{}' },
      { type: 'custom_tool_call', name: 'emit_fixture', namespace: '', value: '' },
      { type: 'function_call', name: 'inspect_fixture', namespace: 'fixture', value: completeArguments },
      { type: 'custom_tool_call', name: 'emit_fixture', namespace: 'fixture', value: 'synthetic input' }
    ]);
    assert.equal(result.events.filter(event => event.type === 'response.output_text.delta').map(event => event.delta).join(''), 'A safe explanation.');
  });
  test(`${protocol} preserves a successful text-only stream`, { timeout: 10000 }, async t => {
    const result = await exercise(t, protocol, { termination: 'terminal', textOnly: true, text: 'Safe text.' });
    assert.equal(result.terminal.type, 'response.completed');
    assert.deepEqual(result.doneTools, []);
  });
  test(`${protocol} keeps the partial-tool transport interruption guard`, { timeout: 10000 }, async t => {
    const result = await exercise(t, protocol, { termination: 'reset', arguments: [partialArguments] });
    assert.equal(result.terminal.type, 'response.failed');
    assert.deepEqual(result.doneTools, []);
    assert.equal(result.events.some(event => event.type === 'response.function_call_arguments.done'), false);
  });
  test(`${protocol} keeps recoverable text transport interruptions incomplete`, { timeout: 10000 }, async t => {
    const result = await exercise(t, protocol, { termination: 'reset', textOnly: true, text: 'Partial safe text.' });
    assert.equal(result.terminal.type, 'response.incomplete');
    assert.equal(result.terminal.response.incomplete_details.reason, 'transport_interrupted');
    assert.deepEqual(result.doneTools, []);
  });
}

for (const kind of ['function', 'custom']) {
  test(`Anthropic validates ${kind} arguments at content_block_stop`, { timeout: 10000 }, async t => {
    assertRejectedTool(await exercise(t, 'anthropic', { termination: 'block-stop',
      arguments: [partialArguments], tools: [kind === 'custom' ? customTool : functionTool] }));
  });
  test(`Chat validates buffered ${kind} arguments before emitting completed SSE`, { timeout: 10000 }, async t => {
    const result = await exercise(t, 'chat', { buffered: true, arguments: [partialArguments],
      tools: [kind === 'custom' ? customTool : functionTool] });
    assert.equal(result.status, 502);
    assert.equal(result.json.error.code, 'provider_response_invalid');
    assert.deepEqual(result.events, []);
  });
}

for (const protocol of ['chat', 'anthropic']) {
  test(`${protocol} returns a complete tool JSON response to a non-streaming client`, { timeout: 10000 }, async t => {
    const result = await exercise(t, protocol, { stream: false, buffered: true, arguments: [completeArguments] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.events, []);
    assert.equal(result.json.status, 'completed');
    assert.equal(result.json.output.length, 1);
    assert.equal(result.json.output[0].type, 'function_call');
    assert.equal(result.json.output[0].status, 'completed');
    assert.equal(result.json.output[0].name, 'inspect_fixture');
    assert.equal(result.json.output[0].arguments, completeArguments);
  });
}

test('Chat rejects incomplete tool arguments for a non-streaming client without reflecting parameters', { timeout: 10000 }, async t => {
  const result = await exercise(t, 'chat', { stream: false, buffered: true, arguments: [partialArguments] });
  assert.equal(result.status, 502);
  assert.deepEqual(result.events, []);
  assert.equal(result.json.error.code, 'provider_response_invalid');
  assert.equal(result.json.error.message, 'The provider returned incomplete or invalid JSON tool arguments.');
  assert.equal(result.body.includes('UNFINISHED_SYNTHETIC_VALUE'), false);
  assert.equal(result.json.output, undefined);
});
