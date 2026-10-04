'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { harness, answerConfirmation, waitFor, clone, A, B, SA, SB, PROJECT } = require('./_helpers/accountHistoryHarness');

function unchanged(h, before) {
  assert.deepEqual(h.records(A), [SA]); assert.deepEqual(h.records(B), [SB]);
  assert.deepEqual(h.local.data[h.legacyKey], before);
  assert.deepEqual(h.shared.values('tombstones'), []);
  assert.equal(Object.keys(h.local.data).some(key => key.startsWith('codexOverleafSessionTombstone')), false);
  assert.equal(h.nativeCalls.length, 0);
}

test('unknown initial account renders no cleanup action', async () => {
  const h = await harness(''); await h.render();
  assert.equal(h.panel.querySelector('[data-project-clear]'), null);
  assert.ok(h.panel.querySelector('[data-recent-projects-degraded]'));
});

test('stable account confirms and deletes only its project history through the real shared backend', async () => {
  const h = await harness(); await h.render();
  await h.button().click(); await answerConfirmation(h, true); await h.cleanup;
  assert.deepEqual(h.records(A), []); assert.deepEqual(h.records(B), [SB]);
  assert.equal(h.shared.values('tombstones').some(row => row.accountScopeId === A && row.id === SA), true);
  const request = h.messages.find(message => message.method === 'delete');
  assert.equal(request.scope.accountScopeId, A); assert.equal(request.scope.projectId, PROJECT);
  assert.equal(h.nativeCalls[0].params.sessionId, SA);
  assert.match(h.toasts.at(-1).message, /Deleted 1 session/);
});

test('cancel leaves shared history, compatibility tombstones and legacy state unchanged', async () => {
  const h = await harness(); const before = clone(h.local.data[h.legacyKey]); await h.render();
  await h.button().click(); await answerConfirmation(h, false); await h.cleanup;
  unchanged(h, before);
});

for (const scope of ['', B]) {
  test(`a stale A action after account ${scope ? 'switch' : 'loss'} never selects the new account records`, async () => {
    const h = await harness(); const before = clone(h.local.data[h.legacyKey]); await h.render();
    const button = h.button(); h.scope = scope; await button.click();
    // Baseline code may reach confirmation; resolve it so the regression checks
    // the actual destination records rather than leaving an in-flight handler.
    let settled = false; h.cleanup.finally(() => { settled = true; }).catch(() => {});
    await waitFor(() => settled || h.confirmations.length, 'refusal or confirmation');
    if (h.confirmations.length) await answerConfirmation(h, true);
    await h.cleanup;
    assert.equal(h.confirmations.length, 0);
    unchanged(h, before); assert.match(h.toasts.at(-1).message, /[Aa]ccount/);
  });

  test(`account ${scope ? 'switch' : 'loss'} during confirmation prevents all cleanup side effects`, async () => {
    const h = await harness(); const before = clone(h.local.data[h.legacyKey]); await h.render();
    await h.button().click(); await waitFor(() => h.confirmations.length, 'confirmation');
    h.scope = scope; await h.render();
    await answerConfirmation(h, true); await h.cleanup;
    unchanged(h, before); assert.match(h.toasts.at(-1).message, /[Aa]ccount/);
    h.scope = A; await h.render();
    assert.ok(h.button(), 'the original shared conversation remains visible');
  });
}

test('scope changing while legacy state is read stops its write and all later deletion/Native requests', async () => {
  const h = await harness(); const before = clone(h.local.data[h.legacyKey]); await h.render();
  h.afterLegacyRead = () => { h.scope = B; };
  await h.button().click(); await answerConfirmation(h, true); await h.cleanup;
  assert.deepEqual(h.records(A), [SA]); assert.deepEqual(h.records(B), [SB]);
  assert.deepEqual(h.local.data[h.legacyKey], before);
  assert.equal(h.messages.some(message => message.method === 'delete'), false);
  assert.equal(h.nativeCalls.length, 0);
  assert.match(h.toasts.at(-1).message, /[Aa]ccount/);
});

test('account A to B to A while confirmation is open invalidates the captured dashboard generation', async () => {
  const h = await harness(); const before = clone(h.local.data[h.legacyKey]); await h.render();
  await h.button().click(); await waitFor(() => h.confirmations.length, 'confirmation');
  h.scope = B; await h.render(); h.scope = A; await h.render();
  await answerConfirmation(h, true); await h.cleanup;
  unchanged(h, before); assert.match(h.toasts.at(-1).message, /[Aa]ccount|view/);
});

test('a project run started during confirmation blocks the cleanup before any mutation', async () => {
  const h = await harness(); const before = clone(h.local.data[h.legacyKey]); await h.render();
  await h.button().click(); await waitFor(() => h.confirmations.length, 'confirmation');
  const original = h.shared.values('sessions').find(row => row.accountScopeId === A);
  const record = { ...original.record, id: 'new-running-session', updatedAt: new Date().toISOString(),
    runs: [{ id: 'running-now', status: 'running', startedAt: new Date().toISOString() }] };
  h.shared.seed('sessions', { ...original, id: record.id, record });
  await answerConfirmation(h, true); await h.cleanup;
  assert.deepEqual(h.records(A), [SA, record.id]); assert.deepEqual(h.records(B), [SB]);
  assert.deepEqual(h.local.data[h.legacyKey], before); assert.deepEqual(h.shared.values('tombstones'), []);
  assert.equal(h.nativeCalls.length, 0); assert.match(h.toasts.at(-1).message, /running|progress/i);
});

test('a new non-running conversation during confirmation is retained while approved sessions are deleted', async () => {
  const h = await harness(); await h.render();
  await h.button().click(); await waitFor(() => h.confirmations.length, 'confirmation');
  const original = h.shared.values('sessions').find(row => row.accountScopeId === A);
  const record = { ...original.record, id: 'new-unsent-session', task: 'new draft', codexThreadId: '', runs: [] };
  h.shared.seed('sessions', { ...original, id: record.id, record });
  await answerConfirmation(h, true); await h.cleanup;
  assert.deepEqual(h.records(A), [record.id]); assert.deepEqual(h.records(B), [SB]);
  assert.equal(h.shared.values('tombstones').some(row => row.id === record.id), false);
  assert.deepEqual(h.nativeCalls.map(call => call.params.sessionId), [SA]);
  assert.match(h.toasts.at(-1).message, /Deleted 1 session/);
});

test('shared deletion rejects mismatched explicit account/project and preserves both account rows', async () => {
  const h = await harness(B);
  await assert.rejects(h.storage.deleteRecord('sessions', SA, { accountScopeId: A, projectId: PROJECT }), error => error.code === 'account_scope_unavailable');
  assert.deepEqual(h.records(A), [SA]); assert.deepEqual(h.records(B), [SB]);
  assert.deepEqual(h.shared.values('tombstones'), []);
  h.scope = A;
  await assert.rejects(h.storage.deleteRecord('sessions', SA, { accountScopeId: A, projectId: 'd'.repeat(24) }),
    error => error.code === 'shared_store_transaction_failed');
  assert.deepEqual(h.records(A), [SA]); assert.deepEqual(h.shared.values('tombstones'), []);
});

test('backend still rejects unauthorized sender and deletion without its live lock', async () => {
  const h = await harness();
  await assert.rejects(h.service.handle({ method: 'delete', scope: { accountScopeId: A }, id: SA }, { ...h.sender, url: 'https://example.invalid/project' }), error => error.code === 'forbidden_sender');
  await assert.rejects(h.service.handle({ method: 'delete', scope: { accountScopeId: A }, id: SA }, h.sender), error => error.code === 'storage_lock_lost');
  assert.deepEqual(h.records(A), [SA]);
});
