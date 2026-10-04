'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const Plan = require('../extension/src/content/writebackPlan');
const Governance = require('../extension/src/shared/governanceRules');
const Files = require('../extension/src/shared/projectFiles');
function plan(approve) {
  const prompts = [];
  const deps = { tx: en => en, tr: key => key, normalizeSafeProjectPath: Files.normalizeSafeProjectPath,
    GovernanceRules: Governance, getGovernanceRulesForCurrentProject: () => ({}),
    showPluginConfirm: async value => { prompts.push(value); return approve; },
    formatOperationFiles: operations => operations.map(operation => operation.path).join(', '),
    getAppliedEntries: value => value?.applied || [], getSkippedEntries: value => value?.skipped || [] };
  return { deps, prompts, api: Plan.create(deps) };
}
test('ordinary text create/delete operations do not acquire an asset confirmation', async () => {
  const h = plan(false), operations = [{ type: 'create', path: 'new.tex', content: 'new' }, { type: 'delete', path: 'old.tex' }];
  const decision = await h.api.confirmBinaryOperations(operations);
  assert.deepEqual(decision.operations, operations); assert.deepEqual(decision.skipped, []); assert.equal(h.prompts.length, 0);
});
test('declining the existing binary confirmation withholds assets while retaining text operations', async () => {
  const h = plan(false), operations = [{ type: 'create', path: 'new.tex', content: 'new' },
    { type: 'binary-create', path: 'new.png' }, { type: 'overwrite-binary', path: 'existing.png' }];
  const decision = await h.api.confirmBinaryOperations(operations);
  assert.deepEqual(decision.operations, [operations[0]]); assert.equal(decision.skipped.length, 2);
  assert.equal(h.prompts.length, 1); assert.equal(h.prompts[0].title, 'binaryAssetConfirmTitle');
  assert.equal(decision.skipped.every(entry => entry.result.code === 'binary_confirmation_rejected'), true);
});
test('approving the existing binary confirmation retains every operation', async () => {
  const h = plan(true), operations = [{ type: 'binary-create', path: 'new.png' }, { type: 'delete', path: 'old.tex' }];
  const decision = await h.api.confirmBinaryOperations(operations);
  assert.deepEqual(decision.operations, operations); assert.deepEqual(decision.skipped, []);
  assert.equal(h.prompts[0].title, 'binaryAssetConfirmTitle');
});
