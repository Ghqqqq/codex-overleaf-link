const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_NATIVE_BUFFER_BYTES,
  MAX_NATIVE_INPUT_MESSAGE_BYTES,
  MAX_NATIVE_OUTPUT_MESSAGE_BYTES,
  decodeFrames,
  encodeMessage
} = require('../native-host/src/nativeMessaging');

test('encodes JSON messages with a 32-bit little-endian length prefix', () => {
  const frame = encodeMessage({ ok: true, value: 'hello' });
  const payload = frame.subarray(4);

  assert.equal(frame.readUInt32LE(0), payload.length);
  assert.deepEqual(JSON.parse(payload.toString('utf8')), { ok: true, value: 'hello' });
});

test('decodes complete frames and preserves a trailing partial frame', () => {
  const first = encodeMessage({ id: 'one' });
  const second = encodeMessage({ id: 'two' });
  const partial = second.subarray(0, 7);

  const decoded = decodeFrames(Buffer.concat([first, partial]));

  assert.deepEqual(decoded.messages, [{ id: 'one' }]);
  assert.deepEqual(decoded.remainder, partial);
});

test('throws a clear error when a decoded frame is not JSON', () => {
  const payload = Buffer.from('not-json', 'utf8');
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);

  assert.throws(() => decodeFrames(frame), /Invalid JSON/);
});

test('decodes inbound native messages larger than the 1MB outbound Chrome limit', () => {
  const largeText = 'x'.repeat(MAX_NATIVE_OUTPUT_MESSAGE_BYTES + 1024);
  const payload = Buffer.from(JSON.stringify({ id: 'large-inbound', params: { largeText } }), 'utf8');
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);

  const decoded = decodeFrames(frame);

  assert.equal(decoded.messages[0].id, 'large-inbound');
  assert.equal(decoded.messages[0].params.largeText.length, largeText.length);
});

test('rejects inbound native message frames larger than the allowed input size', () => {
  const frame = Buffer.alloc(4);
  frame.writeUInt32LE(MAX_NATIVE_INPUT_MESSAGE_BYTES + 1, 0);

  assert.throws(
    () => decodeFrames(frame),
    /Native message frame is too large/
  );
});

test('rejects outbound native messages larger than Chrome can receive', () => {
  assert.throws(
    () => encodeMessage({ ok: true, value: 'x'.repeat(MAX_NATIVE_OUTPUT_MESSAGE_BYTES + 1) }),
    /Native message frame is too large/
  );
});

test('rejects accumulated native input buffers larger than the allowed size', () => {
  const buffer = Buffer.alloc(MAX_NATIVE_BUFFER_BYTES + 1);
  buffer.writeUInt32LE(MAX_NATIVE_OUTPUT_MESSAGE_BYTES, 0);

  assert.throws(
    () => decodeFrames(buffer),
    /Native message buffer is too large/
  );
});

test('writeResponse degrades oversize frames instead of crashing the host (B1)', () => {
  const { encodeOutputFrame } = require('../native-host/src/nativeTransportEnvelope');
  const frame = encodeOutputFrame({
    id: 'oversize-event',
    ok: true,
    event: {
      type: 'codex.output',
      title: 'Large event',
      detail: { text: 'x'.repeat(MAX_NATIVE_OUTPUT_MESSAGE_BYTES + 1) }
    }
  });
  const decoded = decodeFrames(frame).messages[0];

  assert.equal(decoded.id, 'oversize-event');
  assert.equal(decoded.ok, true);
  assert.equal(decoded.event.detail.code, 'native_event_truncated');
  assert.equal(decoded.event.detail.originalType, 'codex.output');
});
