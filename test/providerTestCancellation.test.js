'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const cp = require('node:child_process');
const launches = [], originalSpawn = cp.spawn;
// Observe, then execute unchanged: cancellation must prevent reaching this boundary.
cp.spawn = (...args) => { launches.push(args[0]); return originalSpawn(...args); };
test.after(() => { cp.spawn = originalSpawn; });
require('../native-host/src/debugLog').logDebug = () => {};
const Runtime = require('../native-host/src/providerRuntime');
const { runProviderConnectionTest } = require('../native-host/src/codexProviderTest');
const { createProviderLaunch } = require('../native-host/src/codexProviderLaunch');
const { normalizeProviderDraft } = require('../native-host/src/providerProfile');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-cancel-regression-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'synthetic-exec.cjs');
  fs.writeFileSync(script, "const fs=require('node:fs');const next=fs.readFileSync('provider-step-one.txt','utf8').trim();process.stdout.write(fs.readFileSync(next,'utf8'));\n");
  const command = path.join(root, process.platform === 'win32' ? 'synthetic-exec.cmd' : 'synthetic-exec');
  fs.writeFileSync(command, process.platform === 'win32'
    ? `@"${process.execPath}" "${script}" %*\r\n`
    : `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`, { mode: 0o755 });
  const env = { HOME: root, USERPROFILE: root,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}),
    CODEX_OVERLEAF_CODEX_PATH: command, CODEX_OVERLEAF_PROVIDER_STORE_DIR: path.join(root, 'store') };
  const draft = normalizeProviderDraft({ name: 'Synthetic', baseUrl: 'http://127.0.0.1:1/v1', wireApiPreference: 'responses', models: [{ id: 'synthetic' }], defaultModelId: 'synthetic', requestTimeoutMs: 5000 });
  return { root, env, draft, request: { id: 'test', method: 'codex.providers.test', params: { operationId: 'cancel-regression', draft, secretMutation: { kind: 'replace', value: 'SYNTHETIC_ONLY' } } } };
}
for (const cancel of [true, false]) test('provider test ' + (cancel ? 'cancellation during real bridge listen prevents dispatch' : 'normal bridge preparation still executes and closes'), async t => {
  const f = fixture(t), listen = http.Server.prototype.listen, servers = [];
  let cancelled, closed = 0;
  t.mock.method(http.Server.prototype, 'listen', function(...args) {
    servers.push(this); this.once('close', () => closed++);
    const callback = args.at(-1);
    args[args.length - 1] = async () => {
      if (cancel) cancelled = await Runtime.handleProviderRequest({ id: 'cancel', method: 'codex.providers.test.cancel', params: { operationId: f.request.params.operationId } }, f.env);
      callback();
    };
    return listen.apply(this, args);
  });
  const before = launches.length;
  const result = await Runtime.handleProviderRequest(f.request, f.env);
  await new Promise(r => setImmediate(r));
  assert.ok(servers.length > 0); assert.ok(servers.every(server => !server.listening)); assert.equal(closed, servers.length);
  if (cancel) { assert.equal(cancelled.result.cancelled, true); assert.equal(result.ok, false); assert.equal(result.error.code, 'provider_test_cancelled'); assert.equal(launches.length, before); }
  else { assert.equal(result.ok, true); assert.equal(launches.length, before + 1); }
});
test('already aborted connection test performs no preparation or child dispatch', async t => {
  const f = fixture(t), controller = new AbortController();controller.abort();
  const launch = createProviderLaunch({ profile: f.draft, secret: 'SYNTHETIC_ONLY', modelId: 'synthetic', wireApi: 'responses' });
  const before = launches.length; let prepared = 0;
  const listen = http.Server.prototype.listen;
  t.mock.method(http.Server.prototype, 'listen', function(...args) { prepared++; return listen.apply(this, args); });
  await assert.rejects(runProviderConnectionTest({ launch, env: f.env, signal: controller.signal }), error => error.code === 'provider_test_cancelled');
  assert.equal(prepared, 0); assert.equal(launches.length, before);
});

test('already aborted Auto provider resolution cannot start its compatibility helper', async t => {
  const f = fixture(t), store = require('../native-host/src/providerStore');
  const saved = store.upsertProvider({ draft: { ...f.draft, wireApiPreference: 'auto' }, secretMutation: { kind: 'replace', value: 'SYNTHETIC_ONLY' }, activate: true, disclosureHost: '127.0.0.1', disclosureBaseUrl: f.draft.baseUrl }, f.env);
  const profile = store.listProviders(f.env).providers.find(p => p.id === saved.savedProviderId);
  const controller = new AbortController();controller.abort();const before = launches.length;
  await assert.rejects(Runtime.resolveRunProviderForRun({ providerSelection: { providerId: profile.id, providerRevision: profile.revision }, model: 'synthetic' }, f.env, { signal: controller.signal }), error => error.code === 'provider_test_cancelled');
  assert.equal(launches.length, before);
});
