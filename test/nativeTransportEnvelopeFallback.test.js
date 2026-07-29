const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_NATIVE_OUTPUT_MESSAGE_BYTES,
  decodeInputFrames,
  encodeOutputFrame
} = require('../native-host/src/nativeTransportEnvelope');

test('oversized request ids cannot escape the native response fallback', () => {
  const frame = encodeOutputFrame({
    id: 'request-'.repeat(MAX_NATIVE_OUTPUT_MESSAGE_BYTES),
    ok: true,
    result: { value: 'ok' }
  });
  const decoded = decodeInputFrames(frame).messages[0];

  assert.ok(frame.length <= MAX_NATIVE_OUTPUT_MESSAGE_BYTES + 4);
  assert.equal(decoded.ok, false);
  assert.equal(decoded.error.code, 'native_response_too_large');
  assert.ok(decoded.id.length <= 160);
});
