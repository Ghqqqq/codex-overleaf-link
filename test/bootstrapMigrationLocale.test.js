'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractFunction } = require('./_helpers/extractFunction');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const notice = read('extension/src/content/updateNotice.js');
const popup = read('extension/src/popup.js');
const native = ['bootstrapUpdate', 'bootstrapMigration', 'bootstrapMigrationContract', 'updateManager']
  .map(name => read(`native-host/src/${name}.js`)).join('\n');
const codes = [...new Set([
  ...[...native.matchAll(/['"](update_bootstrap_[a-z_]+)['"]/g)].map(match => match[1]),
  ...[...read('native-host/src/bootstrapMigration.js').matchAll(/fail\('([a-z_]+)'/g)]
    .map(match => 'update_bootstrap_' + match[1]),
  'update_bootstrap_source_mismatch', 'update_bootstrap_target_mismatch',
  'update_bootstrap_future_owned_reason', 'update_health_failed', 'update_request_failed', 'update_failed', 'update_recovery_pending'
])];

for (const locale of ['en', 'zh']) test(`all migration-owned failures follow ${locale} in existing panel and popup copy`, () => {
  const tx = (english, chinese) => locale === 'zh' ? chinese : english;
  const context = vm.createContext({ tx, utx: tx, blockersCopy: () => '', formatBlocker: () => '' });
  vm.runInContext(extractFunction(notice, 'formatUpdateMessage'), context);
  vm.runInContext(extractFunction(popup, 'formatUpdateFailure'), context);
  vm.runInContext(extractFunction(popup, 'getUpdateCopy'), context);
  assert.ok(codes.includes('update_bootstrap_monitor_unavailable') && codes.includes('update_bootstrap_path_unsafe'),
    'Native static codes and generated filesystem reasons are included');
  for (const code of codes) {
    const state = { state: 'failed', code, message: 'Raw native internal diagnostic 原始证据' };
    const panelText = context.formatUpdateMessage(state);
    const popupText = context.getUpdateCopy(state, {}).detail;
    assert.equal(panelText, popupText, code);
    assert.notEqual(panelText, state.message, code);
    if (locale === 'zh') assert.match(panelText, /\p{Script=Han}/u, code);
    else assert.doesNotMatch(panelText, /\p{Script=Han}/u, code);
    assert.equal(state.message, 'Raw native internal diagnostic 原始证据', 'stored diagnostics remain unchanged');
  }
  assert.doesNotMatch(context.formatUpdateMessage({ code: 'update_recovery_pending' }), /cancel|取消/i);
  assert.match(popup, /code\.textContent = \[state\.code, formatUpdateFailure\(state\)\]/,
    'popup technical details use the same owned-language projection');
});

test('new Bootstrap recovery validates migration proof while retaining ordinary rollback compatibility', () => {
  const context = vm.createContext({});
  vm.runInContext(extractFunction(read('extension/bootstrap/background.js'), 'isRollbackReadback'), context);
  const transaction = { id: 'fixture', sourceVersion: '2.5.0' };
  const pair = { extensionVersion: '2.5.0', nativeVersion: '2.5.0',
    extensionSha256: 'a'.repeat(64), nativeSha256: 'b'.repeat(64) };
  const response = { ok: true, result: { transaction: { ...transaction, state: 'rolled_back' },
    activeVersion: '2.5.0', installedAligned: true, restoredPair: { ...pair } } };
  assert.equal(context.isRollbackReadback(response, transaction, pair), true);
  const migratedPair = { ...pair, bootstrapSha256: 'c'.repeat(64) };
  assert.equal(context.isRollbackReadback(response, transaction, migratedPair), false);
  response.result.restoredPair.bootstrapSha256 = 'd'.repeat(64);
  assert.equal(context.isRollbackReadback(response, transaction, migratedPair), false);
  response.result.restoredPair.bootstrapSha256 = migratedPair.bootstrapSha256;
  assert.equal(context.isRollbackReadback(response, transaction, migratedPair), true);
  delete response.result.restoredPair.bootstrapSha256;
  assert.equal(context.isRollbackReadback(response, { ...transaction, bootstrapRevision: '3.1' }), false);
});
