const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const Transaction = require('../extension/src/shared/scopedPersistenceTransaction');
const SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../extension/src/content/scopedPersistenceCoordinator.js'),
  'utf8'
);

function loadModule() {
  const window = {};
  vm.runInNewContext(SOURCE, { window, globalThis: window, console });
  return window.CodexOverleafScopedPersistenceCoordinator;
}

test('scoped persistence keeps the hydrated account scope for later commits', async () => {
  let currentAccountScopeId = null;
  let actionCalls = 0;
  let committedScope = null;
  const controller = loadModule().createController({
    Transaction,
    sessionStorage: {},
    getAccountScopeId: () => currentAccountScopeId
  });

  await controller.beginHydration('project-scope-freeze');
  currentAccountScopeId = 'account-hash-after-dom-ready';
  const result = await controller.commit('project-scope-freeze', {}, async context => {
    actionCalls += 1;
    committedScope = context.scope;
    return 'saved';
  });

  assert.equal(result.ok, true);
  assert.equal(result.value, 'saved');
  assert.equal(actionCalls, 1);
  assert.deepEqual(committedScope, {
    accountScopeId: 'account-hash-after-dom-ready',
    projectId: 'project-scope-freeze'
  });
});
