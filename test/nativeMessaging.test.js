'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAX_NATIVE_INPUT_MESSAGE_BYTES, MAX_NATIVE_OUTPUT_MESSAGE_BYTES,
  decodeFrames, encodeMessage
} = require('../native-host/src/nativeMessaging');
const { encodeOutputFrame } = require('../native-host/src/nativeTransportEnvelope');

test('Native framing preserves Unicode messages across complete and fragmented frames', () => {
  const first = { id: 'first', text: '正文🙂' }, second = { id: 'second', result: '' };
  const frame = encodeMessage(first), next = encodeMessage(second);
  assert.equal(frame.readUInt32LE(0), frame.length - 4);
  const read = decodeFrames(Buffer.concat([frame, next.subarray(0, 7)]));
  assert.deepEqual(read.messages, [first]);
  assert.deepEqual(decodeFrames(Buffer.concat([read.remainder, next.subarray(7)])).messages, [second]);
});

test('malformed and oversized frames fail before an invalid message reaches its consumer', () => {
  const payload = Buffer.from('not-json'), malformed = Buffer.alloc(4 + payload.length);
  malformed.writeUInt32LE(payload.length); payload.copy(malformed, 4);
  assert.throws(() => decodeFrames(malformed));
  const oversized = Buffer.alloc(4); oversized.writeUInt32LE(MAX_NATIVE_INPUT_MESSAGE_BYTES + 1);
  assert.throws(() => decodeFrames(oversized));
  assert.throws(() => encodeMessage({ value: 'x'.repeat(MAX_NATIVE_OUTPUT_MESSAGE_BYTES + 1) }));
});

test('an oversized response preserves request identity and reports failure in a receivable frame', () => {
  const frame = encodeOutputFrame({ id: 'request', ok: true,
    result: { payload: 'x'.repeat(MAX_NATIVE_OUTPUT_MESSAGE_BYTES + 1) } });
  assert.ok(frame.length <= MAX_NATIVE_OUTPUT_MESSAGE_BYTES + 4);
  const [response] = decodeFrames(frame).messages;
  assert.equal(response.id, 'request');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'native_response_too_large');
});
