const assert = require('node:assert/strict');
const test = require('node:test');

const NativeCompatibilityController = require(
  '../extension/src/content/nativeCompatibilityController'
);

test('native compatibility controller stops a gated request cancelled during ping', async () => {
  let sent = false;
  let cancelled = false;
  const nativeChannel = {
    async sendBackgroundNative(payload) {
      if (payload.method === 'bridge.ping') {
        cancelled = true;
        return { ok: true };
      }
      sent = true;
      return { ok: true };
    },
    async sendNative() {
      sent = true;
      return { ok: true };
    }
  };
  const controller = NativeCompatibilityController.create({
    compatibility: {
      buildBridgePingParams: () => ({}),
      evaluateNativeCompatibility: () => ({ status: 'ok' }),
      isNativeMethodAllowed: () => true
    },
    nativeChannel,
    gatedMethods: new Set(['codex.run']),
    getExtensionCompatibilityMetadata: () => ({}),
    throwIfCancellationRequested() {
      if (cancelled) {
        const error = new Error('Codex run was cancelled by the user');
        error.code = 'codex_cancelled';
        throw error;
      }
    },
    tr: key => key,
    tx: value => value
  });
  await assert.rejects(
    controller.sendNative({ method: 'codex.run', params: { task: 'write' } }),
    error => error?.code === 'codex_cancelled'
  );
  assert.equal(sent, false);
});

test('native compatibility controller attaches evidence only to gated methods', async () => {
  const sent = [];
  const nativeChannel = {
    async sendBackgroundNative(payload) {
      if (payload.method === 'bridge.ping') return { ok: true };
      sent.push(payload);
      return { ok: true };
    },
    async sendNative(payload) {
      sent.push(payload);
      return { ok: true };
    }
  };
  const compatibility = { status: 'ok', currentNativeVersion: '2.2.1' };
  const controller = NativeCompatibilityController.create({
    compatibility: {
      buildBridgePingParams: () => ({}),
      evaluateNativeCompatibility: () => compatibility,
      isNativeMethodAllowed: () => true
    },
    nativeChannel,
    gatedMethods: new Set(['codex.run']),
    getExtensionCompatibilityMetadata: () => ({}),
    tr: key => key,
    tx: value => value
  });
  await controller.sendNative({ method: 'codex.run', params: { task: 'write' } });
  await controller.sendBackgroundNative({ method: 'native.read', params: {} });
  assert.equal(sent[0].params.nativeCompatibility, compatibility);
  assert.equal(sent[1].params.nativeCompatibility, undefined);
});

test('current tracked request still receives compatibility rejection and its notification', async () => {
  const events = []; let guardCalls = 0;
  const controller = NativeCompatibilityController.create({
    nativeChannel: { sendBackgroundNative: async () => ({ ok: true }) },
    gatedMethods: new Set(['codex.run']),
    fallbackNativeCompatibility: () => ({ status: 'native_too_old' }),
    getNativeCompatibilityClassification: value => value.status,
    getCurrentRunView: () => ({ recordId: 'live-run' }),
    appendRunEvent: event => events.push(event), tr: key => key, tx: value => value
  });
  const gate = await controller.ensureForMethod('codex.run', { assertCurrent: () => { guardCalls++; } });
  assert.equal(guardCalls, 1); assert.equal(gate.ok, false);
  assert.equal(gate.response.error.code, 'native_update_required');
  assert.equal(events.length, 1); assert.equal(events[0].title, 'nativeCompatibilityBlockedNativeTooOld');
});
