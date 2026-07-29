const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../extension/src/content/contentRuntime.js'),
  'utf8'
);

test('legacy fallback storage is replaced by an account-scoped fallback key', () => {
  assert.match(SOURCE, /buildScopedFallbackStorageKey/);
  assert.doesNotMatch(
    SOURCE,
    /const keys = storageKey === LEGACY_STORAGE_KEY[\s\S]*?\[storageKey, LEGACY_STORAGE_KEY\]/
  );
  assert.match(SOURCE, /__codexOverleafFallbackAccountScopeId/);
});
