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
