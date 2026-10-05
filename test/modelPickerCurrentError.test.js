'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { modelPicker } = require('./_helpers/providerUiHarness');
const state = () => ({ providerId: 'custom', providerRevision: 4, model: 'kept-model', reasoningEffort: 'none', speedTier: 'standard' });
const success = revision => ({ ok: true, result: { providerId: 'custom', providerRevision: revision,
  models: [{ id: 'new-model', label: 'New model', reasoningEfforts: [], speedTiers: ['standard'] }] } });

test('102 current Custom error without result shows unavailable and retains its precise cause', async () => {
  const error = { code: 'provider_revision_conflict', message: 'The saved provider revision changed.' };
  const h = modelPicker(state(), async () => ({ ok: false, error }));
  const result = await h.api.loadModelOptions();
  assert.equal(result.stale, false);
  assert.equal(result.error.code, error.code);
  assert.equal(h.api.getModelDiscovery().status, 'unavailable');
  assert.equal(h.api.getModelDiscovery().errorMessage, error.message);
  assert.equal(h.controls['[data-model]'].disabled, true);
  assert.equal(h.controls['[data-model]'].options[0].textContent, 'Models unavailable');
});

test('102 an older failing generation cannot erase a newer valid catalog', async () => {
  let release, first = true;
  const h = modelPicker(state(), () => first ? (first = false, new Promise(r => { release = r; })) : Promise.resolve(success(4)));
  const old = h.api.loadModelOptions(); await h.api.loadModelOptions();
  release({ ok: false, error: { code: 'old_failure', message: 'Late old error' } });
  assert.equal((await old).stale, true);
  assert.equal(h.api.getModelDiscovery().status, 'discovered');
  assert.equal(h.controls['[data-model]'].value, 'new-model');
});

test('102 a successful result with wrong revision remains stale and preserves existing controls', async () => {
  const h = modelPicker(state(), async () => success(3));
  assert.equal((await h.api.loadModelOptions()).stale, true);
  assert.equal(h.controls['[data-model]'].value, 'kept-model');
  assert.equal(h.controls['[data-model]'].disabled, false);
});
