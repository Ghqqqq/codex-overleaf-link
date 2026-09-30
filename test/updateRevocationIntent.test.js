const assert = require('node:assert/strict');
const test = require('node:test');

const Revocation = require('../extension/src/shared/updateRevocationIntent');
const UpdateConsent = require('../extension/src/shared/updateConsent');
const { createCoordinatorHarness, UPDATE_KEY, CONSENT_KEY } = require('./helpers/updateCoordinatorHarness');

test('revocation intent survives consent normalization and completes both stores together', () => {
  const state = {
    state: 'staged',
    latestVersion: '2.3.0',
    transactionId: 'transaction-1',
    stagedAt: 100
  };
  const consent = {
    authorizedVersion: '2.3.0',
    authorizationId: 'authorization-1',
    authorizedAt: 50
  };
  const pending = Revocation.begin(consent, state, 200);
  const normalized = UpdateConsent.normalizeConsentState(pending);

  assert.equal(Revocation.hasPending(normalized), true);
  assert.equal(normalized.revokingAuthorizationId, 'authorization-1');
  assert.equal(normalized.revokingTransactionId, 'transaction-1');

  const completed = Revocation.complete(state, normalized, {
    now: 300,
    snoozeMs: 1000,
    postponeUntil: Number.MAX_SAFE_INTEGER
  });
  assert.equal(completed.updateState.state, 'update_available');
  assert.equal(completed.updateState.transactionId, '');
  assert.equal(completed.consentState.snoozedVersion, '2.3.0');
  assert.equal(completed.consentState.snoozedUntil, 1300);
  assert.equal(completed.consentState.authorizationId, '');
  assert.equal(Revocation.hasPending(completed.consentState), false);
});

test('new authorization identity is durably recorded as a revocation intent', () => {
  const pending = Revocation.prepareAuthorization(
    { authorizationId: 'older-authorization' },
    'new-authorization',
    '2.3.0',
    200
  );

  assert.equal(pending.revokingAuthorizationId, 'new-authorization');
  assert.equal(pending.revokingVersion, '2.3.0');
  assert.equal(pending.revokingTransactionId, '');
  assert.equal(pending.revokingAt, 200);
});

function seedAuthorizedUpdate(h) {
  h.seed({ state: 'staged', currentVersion: '2.4.1', latestVersion: '2.4.2',
    operationId: 'operation-1', transactionId: 'transaction-1', stagedAt: Date.now() },
  { authorizedVersion: '2.4.2', authorizationId: 'authorization-1', authorizedAt: Date.now() });
}

test('update coordinator persists cancellation intent before native cancel and revoke', async () => {
  const h = await createCoordinatorHarness();
  seedAuthorizedUpdate(h);
  const result = await h.send('codex-overleaf/consent-update-later');
  assert.equal(result.ok, true);
  const native = h.events.filter(event => event.type === 'native' && ['update.cancel', 'update.revoke'].includes(event.method));
  assert.deepEqual(native.map(event => event.method), ['update.cancel', 'update.revoke']);
  for (const event of native) {
    assert.equal(event.state[UPDATE_KEY].cancelRequested, true);
    assert.equal(event.state[CONSENT_KEY].revokingAuthorizationId, 'authorization-1');
    assert.equal(event.state[CONSENT_KEY].authorizationId, 'authorization-1');
  }
  assert.equal(h.data[UPDATE_KEY].state, 'update_available');
  assert.equal(h.data[UPDATE_KEY].cancelRequested, false);
  assert.equal(h.data[CONSENT_KEY].authorizationId, '');
  assert.equal(Revocation.hasPending(h.data[CONSENT_KEY]), false);
});

test('a failed intent save prevents native cancellation and preserves authorization', async () => {
  const h = await createCoordinatorHarness();
  seedAuthorizedUpdate(h);
  h.failWrites();
  const result = await h.send('codex-overleaf/consent-update-later');
  assert.equal(result.ok, false);
  assert.equal(h.events.some(event => event.type === 'native' && ['update.cancel', 'update.revoke'].includes(event.method)), false);
  assert.equal(h.data[CONSENT_KEY].authorizationId, 'authorization-1');
});

test('unconfirmed revocation retains its durable intent and can recover', async () => {
  let failRevoke = true;
  const h = await createCoordinatorHarness({ onNative(request) {
    if (request.method === 'update.revoke' && failRevoke) return { ok: false, error: { code: 'fixture_revoke_failed', message: 'offline' } };
  } });
  seedAuthorizedUpdate(h);
  const failed = await h.send('codex-overleaf/consent-update-later');
  assert.equal(failed.ok, false);
  assert.equal(h.data[UPDATE_KEY].cancelRequested, true);
  assert.equal(Revocation.hasPending(h.data[CONSENT_KEY]), true);
  failRevoke = false;
  const recovered = await h.send('codex-overleaf/consent-update-recover');
  assert.equal(recovered.ok, true);
  assert.equal(h.data[UPDATE_KEY].cancelRequested, false);
  assert.equal(Revocation.hasPending(h.data[CONSENT_KEY]), false);
});

test('failed install authorization is durably revocable and clears only after native acknowledgement', async () => {
  for (const failRevoke of [false, true]) {
    const h = await createCoordinatorHarness({ onNative(request) {
      if (request.method === 'update.authorize') return { ok: false, error: { code: 'fixture_authorize_failed', message: 'authorization failure' } };
      if (request.method === 'update.revoke' && failRevoke) return { ok: false, error: { code: 'fixture_revoke_failed', message: 'offline' } };
    } });
    h.seed({ state: 'update_available', currentVersion: '2.4.1', latestVersion: '2.4.2', lastCheckedAt: Date.now() });
    const result = await h.send('codex-overleaf/consent-update-install');
    assert.equal(result.ok, false);
    const authorize = h.events.find(event => event.type === 'native' && event.method === 'update.authorize');
    const revoke = h.events.find(event => event.type === 'native' && event.method === 'update.revoke');
    assert.ok(authorize);
    assert.ok(revoke);
    const authorizationId = authorize.params.authorizationId;
    assert.equal(authorize.state[CONSENT_KEY].revokingAuthorizationId, authorizationId);
    assert.equal(revoke.state[CONSENT_KEY].revokingAuthorizationId, authorizationId);
    assert.equal(revoke.state[CONSENT_KEY].authorizationId, authorizationId);
    assert.equal(Revocation.hasPending(h.data[CONSENT_KEY]), failRevoke);
    assert.equal(h.data[CONSENT_KEY].authorizationId, failRevoke ? authorizationId : '');
  }
});
