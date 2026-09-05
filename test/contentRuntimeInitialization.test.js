const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const runtimeSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/content/contentRuntime.js'),
  'utf8'
);

test('initial account scope resolves before scoped state hydration begins', () => {
  const initStart = runtimeSource.indexOf('async function init()');
  const scopeRefresh = runtimeSource.indexOf('await refreshAccountScopeId()', initStart);
  const hydration = runtimeSource.indexOf('state = normalizePanelState(getGlobalPreferences().overlay(await loadStoredState()', initStart);
  const appearance = runtimeSource.indexOf('await getGlobalPreferences().initialize()', initStart);

  assert.ok(initStart >= 0, 'content runtime init must exist');
  assert.ok(scopeRefresh > initStart, 'init must await the account scope');
  assert.ok(hydration > scopeRefresh, 'state hydration must use the resolved account scope');
  assert.ok(appearance > initStart && appearance < hydration, 'global preferences must hydrate before the first project/dashboard view');
  assert.ok(runtimeSource.indexOf('let globalPreferencesController = null;') < runtimeSource.indexOf('init().catch'), 'preference controller state must be initialized before async startup enters it');
});

test('queued-input promotion runs inside the task settlement boundary', () => {
  const runTaskStart = runtimeSource.indexOf('async function runTask(options = {})');
  const settlementTry = runtimeSource.indexOf('try {', runTaskStart);
  const promotion = runtimeSource.indexOf('await runQueueScheduler?.markExecuting(', runTaskStart);
  const settlementFinally = runtimeSource.indexOf('} finally {', runTaskStart);

  assert.ok(runTaskStart >= 0, 'runTask must exist');
  assert.ok(settlementTry > runTaskStart, 'runTask must establish a settlement boundary');
  assert.ok(promotion > settlementTry, 'queue promotion must be covered by task cleanup');
  assert.ok(settlementFinally > promotion, 'queue promotion must settle through the same finally block');
});
