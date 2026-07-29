const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const runtimeSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/content/contentRuntime.js'),
  'utf8'
);

test('missing account scope cannot fall back to legacy durable session storage', () => {
  assert.match(
    runtimeSource,
    /code: 'scoped_persistence_unavailable'/
  );
  assert.doesNotMatch(
    runtimeSource,
    /chrome\.storage\.local\.set\(\{ \[storageKey\]: prepareCompactFallbackState\(state\) \}\)/
  );
});
