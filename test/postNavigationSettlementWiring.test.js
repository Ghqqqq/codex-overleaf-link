const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const runtimeSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/content/contentRuntime.js'),
  'utf8'
);

test('run views freeze the account scope used by post-navigation settlement', () => {
  assert.match(runtimeSource, /runAccountScopeId:\s*cachedAccountScopeId\s*\|\|\s*''/);
  assert.match(runtimeSource, /runAccountScopeId:\s*record\.runAccountScopeId/);
});

test('post-navigation settlement uses detached scoped persistence for the original run', () => {
  assert.match(
    runtimeSource,
    /PersistenceCoordinator:\s*getScopedPersistenceCoordinator\(\)[\s\S]{0,180}projectId:\s*currentRunView\?\.runProjectId[\s\S]{0,120}accountScopeId:\s*currentRunView\?\.runAccountScopeId/
  );
  assert.match(
    runtimeSource,
    /currentRunView\.runProjectId === activeProjectId[\s\S]{0,120}currentRunView\.runAccountScopeId === cachedAccountScopeId/
  );
  assert.match(runtimeSource, /PostNavigationSettlementPersistence[\s\S]{0,240}persistRequired\(/);
  assert.match(runtimeSource, /postNavigationPersistenceFailure\s*=\s*\{/);
});
