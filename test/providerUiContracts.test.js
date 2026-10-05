'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { providerHarness, Store, Runtime } = require('./_helpers/providerUiHarness');

for (const locale of ['en', 'zh']) {
  test(`077 clear key keeps project selection and accurately labels the Native default (${locale})`, async t => {
    const h = await providerHarness(t, { locale });
    await h.callbacks.onClearSecret(h.context('alpha'));
    assert.equal(Store.listProviders(h.env).activeProviderId, 'builtin');
    assert.equal(h.state().providerId, h.profiles.alpha.id);
    assert.equal(h.coordinator.getRunSelection().providerId, h.profiles.alpha.id);
    assert.match(h.statuses.at(-1).title, locale === 'en' ? /Native.*default.*Built-in|default.*Built-in/i : /Native.*默认.*内置/);
    assert.match(h.statuses.at(-1).title, locale === 'en' ? /project.*unchanged|project.*still/i : /项目.*保持|项目.*仍/);
  });
  test(`077 endpoint Save retains Custom binding without claiming project activation (${locale})`, async t => {
    const h = await providerHarness(t, { locale });
    await h.click('save', h.context('alpha', { baseUrl: 'https://new.example.invalid/v1' }));
    assert.equal(Store.listProviders(h.env).activeProviderId, 'builtin');
    assert.equal(h.coordinator.getRunSelection().providerId, h.profiles.alpha.id);
    assert.match(h.statuses.at(-1).title, locale === 'en' ? /Native.*default.*Built-in|default.*Built-in/i : /Native.*默认.*内置/);
    assert.match(h.statuses.at(-1).title, locale === 'en' ? /project.*unchanged|project.*still/i : /项目.*保持|项目.*仍/);
    assert.throws(() => Runtime.resolveRunProvider({ model: 'alpha-model', providerSelection: h.coordinator.getRunSelection() }, h.env),
      { code: 'provider_disclosure_required' });
  });
}

for (const action of ['save-use', 'use', 'activate-builtin', 'delete']) {
  test(`108 active run blocks ${action} before Native mutation and project/thread change`, async t => {
    const h = await providerHarness(t, { running: true });
    const target = action === 'delete' ? 'alpha' : 'beta';
    await h.click(action, h.context(target));
    assert.equal(h.calls.filter(c => c.method !== 'codex.providers.list').length, 0);
    assert.equal(h.state().providerId, h.profiles.alpha.id);
    assert.equal(h.state().sessions[0].codexThreadId, 'original-thread');
    assert.ok(h.busy.some(s => /running task/.test(s.message)) || h.toasts.some(s => /running task/.test(s[0])));
  });
}

test('108 final commit rejects late activation when a run begins during Native response', async t => {
  const h = await providerHarness(t);
  h.beforeRequest(req => { if (req.method === 'codex.providers.activate') h.running(true); });
  await h.click('use', h.context('beta'));
  assert.equal(h.state().providerId, h.profiles.alpha.id);
  assert.equal(h.state().sessions[0].codexThreadId, 'original-thread');
  assert.equal(h.busy.at(-1).state, 'failed');
  assert.doesNotMatch(h.statuses.at(-1)?.title || '', /^Provider activated/);
});

test('108 ordinary Save can persist configuration while active without resetting the project thread', async t => {
  const h = await providerHarness(t, { running: true });
  await h.click('save', h.context('alpha', { name: 'Updated alpha' }));
  assert.equal(Store.listProviders(h.env).providers.find(p => p.id === h.profiles.alpha.id).name, 'Updated alpha');
  assert.equal(h.state().sessions[0].codexThreadId, 'original-thread');
  assert.equal(h.state().providerRevision, h.profiles.alpha.revision);
});

test('108 Save and use and deleting current provider still work after the run finishes', async t => {
  const h = await providerHarness(t, { running: true }); h.running(false);
  await h.click('save-use', h.context('beta'));
  assert.equal(h.confirmations.length, 0, 'Save and use keeps its existing single-button intent');
  assert.equal(h.state().providerId, h.profiles.beta.id);
  assert.equal(h.state().sessions[0].codexThreadId, '');
  await h.click('delete', h.context('beta'));
  assert.equal(h.state().providerId, 'builtin');
  assert.equal(h.coordinator.getRunSelection().providerId, 'builtin');
});

test('108 direct same-id revision commit cannot bypass the running policy', async t => {
  const h = await providerHarness(t, { running: true });
  const ctx = h.context('alpha');
  Store.upsertProvider({ ...ctx, draft: { ...ctx.draft, name: 'Next revision' } }, h.env);
  h.coordinator._instance.catalog = require('../extension/src/shared/providerProfiles').normalizeCatalog(Store.listProviders(h.env));
  assert.throws(() => h.selection.commit(ctx.profileId, 'alpha-model'), /running task/);
  assert.equal(h.state().sessions[0].codexThreadId, 'original-thread');
  assert.equal(h.state().providerRevision, h.profiles.alpha.revision);
});

for (const action of ['save-use', 'use']) {
  test(`108 ${action} keeps original model controls if a run starts during catalog I/O`, async t => {
    const h = await providerHarness(t);
    h.beforeModels(req => { if (req.params.providerSelection.providerId === h.profiles.beta.id) h.running(true); });
    await h.click(action, h.context('beta'));
    assert.equal(h.state().providerId, h.profiles.alpha.id);
    assert.equal(h.picker.controls['[data-model]'].value, 'alpha-model');
    assert.equal(h.picker.controls['[data-model]'].disabled, false);
    assert.equal(h.state().sessions[0].codexThreadId, 'original-thread');
    assert.equal(h.busy.at(-1).state, 'failed');
  });
}

test('108 deleting another provider while running leaves project selection and thread intact', async t => {
  const h = await providerHarness(t, { running: true });
  await h.click('delete', h.context('beta'));
  assert.equal(Store.listProviders(h.env).providers.some(p => p.id === h.profiles.beta.id), false);
  assert.equal(h.state().providerId, h.profiles.alpha.id);
  assert.equal(h.state().sessions[0].codexThreadId, 'original-thread');
  assert.equal(h.statuses.at(-1).title, 'Provider deleted.');
});

test('108 blocked switch keeps the existing localized status surface', async t => {
  const h = await providerHarness(t, { running: true, locale: 'zh' });
  await h.click('save-use', h.context('beta'));
  assert.match(h.statuses.at(-1).title, /等待正在运行的任务结束/);
  assert.doesNotMatch(h.statuses.at(-1).title, /Wait for/);
});

test('102 real coordinator propagates the current model error without generic stale replacement', async t => {
  const h = await providerHarness(t);
  Store.deleteProvider({ providerId: h.profiles.beta.id, expectedRevision: h.profiles.beta.revision }, h.env);
  await h.click('use', { profileId: h.profiles.beta.id, expectedRevision: h.profiles.beta.revision });
  assert.equal(h.busy.at(-1).state, 'failed');
  assert.match(h.busy.at(-1).message, /no longer exists/i);
  assert.doesNotMatch(h.busy.at(-1).message, /catalog could not be loaded/i);
  assert.equal(h.state().providerId, h.profiles.alpha.id);
});

for (const runStarts of [false, true]) {
  test(`108 existing Use confirmation ${runStarts ? 'rechecks a newly started run' : 'can still be cancelled'} without mutation`, async t => {
    const h = await providerHarness(t);
    h.confirm(() => { if (runStarts) h.running(true); return runStarts; });
    await h.click('use', h.context('beta'));
    assert.equal(h.confirmations.length, 1);
    assert.equal(h.calls.filter(c => c.method !== 'codex.providers.list').length, 0);
    assert.equal(h.state().providerId, h.profiles.alpha.id);
    assert.equal(h.state().sessions[0].codexThreadId, 'original-thread');
  });
}

test('108 active run still permits refreshing the unchanged project provider catalog', async t => {
  const h = await providerHarness(t, { running: true });
  await h.coordinator.syncSessionProvider();
  assert.equal(h.calls.filter(c => c.method === 'codex.models').length, 1);
  assert.equal(h.state().providerId, h.profiles.alpha.id);
  assert.equal(h.state().providerRevision, h.profiles.alpha.revision);
  assert.equal(h.state().sessions[0].codexThreadId, 'original-thread');
  assert.equal(h.picker.controls['[data-model]'].disabled, false);
});

test('108 a saved revision deferred by an active run binds on the next idle session refresh', async t => {
  const h = await providerHarness(t, { running: true });
  await h.click('save', h.context('alpha', { name: 'Deferred alpha' }));
  assert.equal(h.state().sessions[0].codexThreadId, 'original-thread');
  const saved = Store.listProviders(h.env).providers.find(p => p.id === h.profiles.alpha.id);
  await assert.rejects(h.coordinator.syncSessionProvider(), { code: 'provider_switch_running' });
  assert.equal(h.state().sessions[0].codexThreadId, 'original-thread');
  h.running(false);
  await h.coordinator.syncSessionProvider();
  assert.equal(h.state().providerRevision, saved.revision);
  assert.equal(h.state().sessions[0].codexThreadId, '');
});
