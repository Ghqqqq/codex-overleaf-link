'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const Compatibility = require('../extension/src/shared/compatibility');
const Controller = require('../extension/src/content/nativeCompatibilityController');
const { background, memoryStorage, flush } = require('./_helpers/backgroundJournalHarness');
const methods = ['writing-style.get', 'writing-style.set', 'codex.thread.fork', 'asset.readChunk', 'asset.release'];
const runtime = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
function productionGate() { const match = runtime.match(/const NATIVE_COMPATIBILITY_GATED_METHODS = new Set\((\[[\s\S]*?\])\);/); assert.ok(match); return new Set(vm.runInNewContext(match[1])); }
function ping(compatible) { return { ok: true, result: { version: Compatibility.BUILD_TARGET_VERSION,
  protocolVersion: compatible ? 2 : 999, supportedProtocol: compatible ? { min: 1, max: 2 } : { min: 999, max: 999 },
  capabilities: Object.fromEntries(Compatibility.REQUIRED_CAPABILITIES.map(x => [x, true])),
  environment: { codex: { ok: true } }, minExtensionVersion: '1.0.0' } }; }
function fixture(t, compatible) {
  const bg = background(memoryStorage()), posted = []; t.after(() => bg.timer.clear());
  async function dispatch(payload) {
    const response = bg.send({ type: 'codex-overleaf/native-request', payload }); await flush();
    for (const port of bg.ports) for (const message of port.messages) if (!posted.includes(message)) {
      posted.push(message); port.emit({ id: message.id, ok: true, result: { synthetic: true } });
    }
    return response;
  }
  const controller = Controller.create({ compatibility: Compatibility, gatedMethods: productionGate(),
    nativeChannel: { sendBackgroundNative: p => p.method === 'bridge.ping' ? Promise.resolve(ping(compatible)) : dispatch(p) },
    getExtensionCompatibilityMetadata: () => ({ version: Compatibility.BUILD_TARGET_VERSION }),
    getNativeCompatibilityClassification: c => c.classification, tx: en => en, tr: key => key,
    getPanel: () => null, showPluginToast() {} });
  return { bg, posted, dispatch, controller };
}
for (const method of methods) {
  test('production Content gate blocks incompatible Host for ' + method, async t => {
    const h = fixture(t, false), result = await h.controller.sendBackgroundNative({ method, params: {} });
    assert.equal(result.ok, false); assert.equal(result.error.code, 'native_update_required'); assert.equal(h.posted.length, 0);
  });
  test('production Background gate requires evidence for ' + method, async t => {
    const h = fixture(t, true), result = await h.dispatch({ method, params: {} });
    assert.equal(result.ok, false); assert.equal(result.error.code, 'native_update_required'); assert.equal(h.posted.length, 0);
  });
  test('compatible producer reaches existing Background method for ' + method, async t => {
    const h = fixture(t, true), result = await h.controller.sendBackgroundNative({ method, params: {} });
    assert.equal(result.ok, true); assert.equal(h.posted.length, 1); assert.equal(h.posted[0].method, method);
    assert.equal(h.posted[0].params.nativeCompatibility, undefined, 'background strips evidence before native transport');
  });
}
test('five-method repair retains the cancel exception and unknown-method policy', async t => {
  const h = fixture(t, false);
  const cancel = await h.controller.sendBackgroundNative({ method: 'codex.cancel', params: {} });
  assert.equal(cancel.ok, true); assert.equal(cancel.result.sent, true);
  const unknown = await h.dispatch({ method: 'fixture.future-method', params: {} }); assert.equal(unknown.ok, true);
  assert.equal(productionGate().has('codex.cancel'), false);
});
