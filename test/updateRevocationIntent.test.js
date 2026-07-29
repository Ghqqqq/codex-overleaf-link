const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Revocation = require('../extension/src/shared/updateRevocationIntent');
const UpdateConsent = require('../extension/src/shared/updateConsent');

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

test('update coordinator records revocation intent before the native side effect', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../extension/src/backgroundUpdateCoordinator.js'),
    'utf8'
  );
  const postpone = source.match(
    /async function postponeUpdate\(\) \{[\s\S]*?\n  \}(?=\n\n  async function)/
  )?.[0] || '';

  assert.ok(postpone.indexOf('setConsentState') < postpone.indexOf("'update.revoke'"));
  assert.match(postpone, /setUpdateAndConsentState/);
  assert.match(source, /reconcilePendingRevocation/);
});

test('install failure persists revocation intent and clears authorization only after confirmed revoke', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../extension/src/backgroundUpdateCoordinator.js'),
    'utf8'
  );
  const install = source.match(
    /async function installUpdate\(\) \{[\s\S]*?\n  \}(?=\n\n  async function)/
  )?.[0] || '';
  const catchBody = install.slice(install.indexOf('} catch (error) {'));

  assert.ok(
    install.indexOf('setConsentState(authorizationIntent)') <
      install.indexOf("requestNative('update.authorize'"),
    'the new authorization id must be durable before the native side effect'
  );
  assert.match(install, /setConsentState\(revocation\.clear\(\{/);
  assert.match(catchBody, /revocation\.prepareAuthorization/);
  assert.doesNotMatch(catchBody, /bestEffortRevoke/);
  assert.ok(
    catchBody.indexOf('setConsentState(pendingConsent)') <
      catchBody.indexOf("requestNative('update.revoke'"),
    'revocation intent must be durable before the native revoke'
  );
  assert.ok(
    catchBody.indexOf("requestNative('update.revoke'") <
      catchBody.indexOf("authorizationId: ''"),
    'authorization can be cleared only after native revoke succeeds'
  );
});
