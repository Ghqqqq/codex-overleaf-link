const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Identity = require('../extension/src/shared/nativeRequestIdentity');

test('native request identity preserves bounded ids and generates missing ids', () => {
  assert.deepEqual(Identity.resolve('request-1'), { ok: true, id: 'request-1' });
  assert.deepEqual(
    Identity.resolve('', () => 'generated-id'),
    { ok: true, id: 'generated-id' }
  );
});

test('native request identity rejects ids that cannot round-trip through fallback envelopes', () => {
  const result = Identity.resolve('x'.repeat(Identity.MAX_REQUEST_ID_CHARS + 1));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'native_request_id_invalid');
});

test('background validates native request identity before registering pending work', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../extension/src/background.js'),
    'utf8'
  );
  const requestBody = source.match(
    /function sendNativeRequest\(payload, sender, options = \{\}\) \{[\s\S]*?\n  \}(?=\n\n  async function)/
  )?.[0] || '';
  assert.ok(requestBody.indexOf('NativeRequestIdentity.resolve') >= 0);
  assert.ok(requestBody.indexOf('NativeRequestIdentity.resolve') < requestBody.indexOf('pending.set'));
});
