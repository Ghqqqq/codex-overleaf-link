'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-boundaries-'));
const debug = require('../../native-host/src/debugLog');
const originalLog = debug.logDebug;
debug.logDebug = (event, detail) => originalLog(event, detail, { homeDir: root, env: {}, platform: process.platform });
const starts = {
  chat: require('../../native-host/src/chatCompletionsBridge').startChatCompletionsBridge,
  anthropic: require('../../native-host/src/anthropicMessagesBridge').startAnthropicMessagesBridge,
  responses: require('../../native-host/src/responsesPassthroughBridge').startResponsesPassthroughBridge
};
debug.logDebug = originalLog;
const Store = require('../../native-host/src/providerStore');
const { createProviderLaunch } = require('../../native-host/src/codexProviderLaunch');
const SECRET = 'SYNTHETIC_BOUNDARY_CREDENTIAL_NOT_REAL';
function payload(protocol, { partial = false, text = 'SAFE_RESULT', id = 'fixture-result' } = {}) {
  if (protocol === 'chat') return { id, choices: [{ message: { role: 'assistant', content: text }, finish_reason: partial ? 'length' : 'stop' }], usage: {} };
  if (protocol === 'anthropic') return { id, type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: partial ? 'max_tokens' : 'end_turn', usage: {} };
  return { id, object: 'response', model: 'synthetic-model', status: partial ? 'incomplete' : 'completed', output: [{ id: 'msg', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], usage: {} };
}
function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
}
async function server(t, handler) {
  const received = [];
  const instance = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', value => chunks.push(value));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const entry = { raw, body: raw ? JSON.parse(raw) : {}, method: req.method, url: req.url, headers: req.headers };
      received.push(entry);
      Promise.resolve(handler(req, res, entry, received.length)).catch(error => res.destroy(error));
    });
  });
  await new Promise((resolve, reject) => { instance.once('error', reject); instance.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { instance.close(resolve); instance.closeAllConnections(); }));
  return { received, instance, baseUrl: `http://127.0.0.1:${instance.address().port}/v1` };
}
async function bridge(t, protocol, upstream, overrides = {}, launchOverrides = {}, signal) {
  const directory = fs.mkdtempSync(path.join(root, 'store-'));
  const env = { CODEX_OVERLEAF_PROVIDER_STORE_DIR: directory };
  const draft = { name: 'Synthetic boundary provider', baseUrl: upstream.baseUrl, wireApiPreference: protocol,
    models: [{ id: 'synthetic-model', upstreamResponseMode: 'buffered' }], defaultModelId: 'synthetic-model',
    maxOutputTokens: 4096, reasoningAdapter: 'none', reasoningCapability: 'none', ...overrides };
  const saved = Store.upsertProvider({ draft, activate: true, disclosureHost: '127.0.0.1', disclosureBaseUrl: draft.baseUrl,
    secretMutation: { kind: 'replace', value: SECRET } }, env);
  const profile = Store.listProviders(env).providers.find(item => item.id === saved.savedProviderId);
  const launch = { ...createProviderLaunch({ profile, secret: SECRET, modelId: 'synthetic-model', wireApi: protocol,
    reasoningEffort: overrides.reasoningEffort || '' }), ...launchOverrides };
  const value = await starts[protocol]({ launch, signal });
  t.after(async () => { await value.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { ...value, profile, launch, async post(body = {}, route = 'responses', signal = AbortSignal.timeout(5000)) {
    const response = await fetch(`${value.baseUrl}/${route}`, { method: 'POST', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${value.clientToken}` },
      body: JSON.stringify({ input: 'SAFE_INPUT', model: 'synthetic-model', stream: false, ...body }) });
    const text = await response.text(); let parsed; try { parsed = JSON.parse(text); } catch {}
    return { status: response.status, text, body: parsed };
  } };
}
function cleanup() { fs.rmSync(root, { recursive: true, force: true }); }
module.exports = { assert, fs, root, starts, SECRET, payload, json, server, bridge, cleanup };
