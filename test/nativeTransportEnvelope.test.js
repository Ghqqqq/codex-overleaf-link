const assert = require('node:assert/strict');
const test = require('node:test');

const { decodeFrames } = require('../native-host/src/nativeMessaging');
const {
  MAX_NATIVE_OUTPUT_MESSAGE_BYTES,
  encodeOutputFrame,
  estimateBase64DecodedBytes,
  getRequestQuotaViolation,
  measureJsonBytes,
  reduceTaskResult
} = require('../native-host/src/nativeTransportEnvelope');

test('native transport envelope owns quota admission with the stable violation shape', () => {
  const violation = getRequestQuotaViolation({
    id: 'oversize-skill',
    method: 'skills.install',
    params: { content: 'x'.repeat((64 * 1024) + 1) }
  });

  assert.deepEqual(violation, {
    field: 'content',
    limit: 64 * 1024,
    actual: (64 * 1024) + 1,
    reason: 'skill content is too large'
  });
  assert.equal(estimateBase64DecodedBytes('YWJjZA=='), 4);
});

test('native transport envelope reduces successful task results below the output budget', () => {
  const reduced = reduceTaskResult({
    assistantMessage: 'x'.repeat(MAX_NATIVE_OUTPUT_MESSAGE_BYTES),
    syncChanges: [],
    unsupportedChanges: []
  });
  const frame = encodeOutputFrame({ id: 'result', ok: true, result: reduced });

  assert.ok(frame.length <= MAX_NATIVE_OUTPUT_MESSAGE_BYTES + 4);
});

test('native transport envelope emits a structured error for oversized ordinary responses', () => {
  const frame = encodeOutputFrame({
    id: 'oversize-result',
    ok: true,
    result: { payload: 'x'.repeat(MAX_NATIVE_OUTPUT_MESSAGE_BYTES + 1) }
  });
  const decoded = decodeFrames(frame).messages[0];

  assert.equal(decoded.id, 'oversize-result');
  assert.equal(decoded.ok, false);
  assert.equal(decoded.error.code, 'native_response_too_large');
  assert.equal(decoded.error.originalOk, true);
});

test('native transport envelope measures JSON without throwing on circular diagnostics', () => {
  const value = {};
  value.self = value;

  assert.equal(measureJsonBytes(value), 0);
});

test('native transport envelope rejects request ids that exceed the response identity budget', () => {
  const violation = getRequestQuotaViolation({
    id: 'x'.repeat(161),
    method: 'bridge.ping',
    params: {}
  });

  assert.deepEqual(violation, {
    field: 'id',
    limit: 160,
    actual: 161,
    reason: 'request id is too large'
  });
});
