'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const SensitiveScan = require('../extension/src/shared/sensitiveScan');
const { harness, project, CLEAN, MARKER } = require('./_helpers/runRetryHarness');

function observe(name, h) { console.log('OBSERVATION ' + JSON.stringify({ name, ...h.snapshot() })); }
function isControlledSubmissionRefusal(value) {
  // A future scope/owner guard may reject safely. Unexpected execution errors
  // and missing fixture dependencies must never count as such a rejection.
  const message = String(value?.message || value || '');
  return /(?:active\s+)?(?:project|account|session|submission|draft|composer)\b[\s\S]{0,80}\b(?:changed|superseded|stale|cancelled|canceled|no longer)/i.test(message);
}
function fixtureHealthy(h, allowControlledRefusal = false) {
  const errors = h.io.errors;
  assert.equal(errors.some(value => /not defined|is not a function|Cannot read|fixture_network_forbidden|unexpected_session_native_IO/.test(value)), false,
    'fixture dependency failure: ' + errors.join('; '));
  if (!allowControlledRefusal) assert.deepEqual(errors, []);
  else for (const error of errors) assert.equal(h.io.requests.length === 0 && isControlledSubmissionRefusal(error), true,
    'only an explicit submission scope/owner refusal before Native dispatch is allowed: ' + error);
}
async function complete(promise, h, name, allowControlledRefusal = false) {
  const outcome = await promise.then(() => ({ ok: true }), error => ({ ok: false, message: error.message,
    controlledRefusal: allowControlledRefusal && h.io.requests.length === 0 && isControlledSubmissionRefusal(error) }));
  await Promise.resolve(); fixtureHealthy(h, allowControlledRefusal);
  if (!outcome.ok) assert.equal(outcome.controlledRefusal, true, 'unexpected submission rejection: ' + outcome.message);
  if (name) observe(name, h); return outcome;
}

// Core runtime declarations above are mechanically extracted from current source.
// Only DOM, persistence, Page snapshot and Native boundary I/O are synthetic.
// Neither scanner nor snapshot availability guards are replaced.
assert.equal(SensitiveScan.scanSensitiveInputs({ files: project(CLEAN + MARKER).files }).some(f => f.detectorId === 'private-key'), true);

async function run(name, options = {}) {
  const h = harness(options); await complete(h.start(), h, name);
  assert.equal(h.io.pageCalls.length, 1, 'real non-OT warm-start must obtain one overlay snapshot');
  assert.equal(h.io.pageCalls[0].params.allowZipFallback, false);
  return h;
}
function assertInitialScan(h, marker) {
  assert.equal(h.io.scans.length >= 1, true);
  assert.equal(h.io.scans[0].projectContainsMarker, marker);
  assert.equal(h.io.scans[0].useExistingMirror, true);
  assert.equal(h.io.mirrorScans, 1);
}

test('CONTROL clean stale retry passes real snapshot guard and dispatches refreshed project', { timeout: 3000 }, async () => {
  const h = await run('clean-stale-retry'); assertInitialScan(h, false);
  assert.equal(h.io.requests.length, 2); assert.equal(h.io.requests[0].useExistingMirror, true);
  assert.equal(h.io.requests[0].otWarmStart, undefined); assert.equal(h.io.requests[1].useExistingMirror, undefined);
  assert.equal(h.io.requests[1].project.files[0].content, CLEAN);
  assert.equal(h.io.retryGuards[0].ok, true); assert.equal(h.snapshot().runStatus, 'completed');
});

test('CONTROL initial detected content is blocked by default before any codex.run', { timeout: 3000 }, async () => {
  const h = await run('first-detected-default-block', { initialProject: project(CLEAN + MARKER) }); assertInitialScan(h, true);
  assert.equal(h.io.requests.length, 0); assert.equal(h.io.prompts.length, 0); assert.equal(h.snapshot().runStatus, 'failed');
  assert.equal(h.io.scans[0].outcome.blocked, true);
});

for (const approve of [false, true]) test(`CONTROL initial detected content confirmation ${approve ? 'approval' : 'denial'} controls dispatch`, { timeout: 3000 }, async () => {
  const h = await run('first-detected-confirm-' + approve, { initialProject: project(CLEAN + MARKER), rules: { sensitiveConfirmAllowed: true }, approve, stale: false });
  assertInitialScan(h, true); assert.equal(h.io.prompts.length, 1); assert.equal(h.io.requests.length, approve ? 1 : 0);
  assert.equal(h.io.scans[0].outcome.blocked, !approve);
  assert.equal(h.io.prompts[0].message.includes(MARKER), false, 'confirmation uses redacted detector preview');
});

for (const retryProject of [ { id: 'project-one', files: [], capabilities: { fullProjectSnapshot: false } }, project('short unreadable sample') ]) test(`CONTROL unavailable retry snapshot (${retryProject.files.length ? 'short' : 'empty'}) is blocked before second dispatch`, { timeout: 3000 }, async () => {
  const h = await run('unavailable-retry-' + retryProject.files.length, { retryProject }); assertInitialScan(h, false);
  assert.equal(h.io.requests.length, 1); assert.equal(h.io.retryGuards[0].ok, false); assert.equal(h.snapshot().runStatus, 'failed');
});

test('CONTROL clean focused partial retry keeps the existing scope restriction', { timeout: 3000 }, async () => {
  const h = await run('partial-focused', { retryProject: project(CLEAN, false), focusFiles: ['main.tex'] });
  assert.equal(h.io.requests.length, 2); assert.equal(h.io.requests[1].restrictToFocusFiles, true);
  assert.equal(h.io.retryGuards[0].ok, true);
});

test('CONTROL partial retry without focus remains blocked', { timeout: 3000 }, async () => {
  const h = await run('partial-no-focus', { retryProject: project(CLEAN, false) });
  assert.equal(h.io.requests.length, 1); assert.equal(h.io.retryGuards[0].ok, false);
});

test('CONTROL explicitly disabled sensitive checks allow the refreshed synthetic marker', { timeout: 3000 }, async () => {
  const h = await run('scan-disabled', { retryProject: project(CLEAN + MARKER), rules: { sensitiveCheckEnabled: false } });
  assert.equal(h.io.requests.length, 2); assert.equal(h.io.mirrorScans, 0); assert.equal(h.io.prompts.length, 0);
  assert.equal(h.io.requests[1].project.files[0].content.includes(MARKER), true);
});

test('CONTRACT default policy must block refreshed detected content before a second codex.run', { timeout: 3000 }, async () => {
  const h = await run('retry-new-marker-default', { retryProject: project(CLEAN + MARKER) }); assertInitialScan(h, false);
  assert.equal(h.io.retryGuards[0].ok, true, 'usable snapshot prerequisite is satisfied');
  assert.equal(h.io.requests.slice(1).every(p => p.project.files[0].content.includes(MARKER)), true);
  assert.equal(h.io.requests.length, 1, 'default sensitive policy must be reapplied to replacement snapshot before second Native dispatch');
});

for (const approve of [false, true]) test(`CONTRACT new retry detection must request confirmation; ${approve ? 'approval' : 'denial'} controls second dispatch`, { timeout: 3000 }, async () => {
  const h = await run('retry-new-marker-confirm-' + approve, { retryProject: project(CLEAN + MARKER), rules: { sensitiveConfirmAllowed: true }, approve });
  assertInitialScan(h, false); assert.equal(h.io.retryGuards[0].ok, true);
  assert.equal(h.io.prompts.length, 1, 'newly detected content requires a fresh explicit confirmation');
  assert.equal(h.io.requests.length, approve ? 2 : 1);
});


test('CONTRACT focused partial snapshot retry must also reapply default detection policy', { timeout: 3000 }, async () => {
  const h = await run('retry-focused-new-marker-default', { retryProject: project(CLEAN + MARKER, false), focusFiles: ['main.tex'] });
  assertInitialScan(h, false); assert.equal(h.io.retryGuards[0].ok, true);
  assert.equal(h.io.retryGuards[0].restrictToFocusFiles, true);
  assert.equal(h.io.requests.length, 1, 'focus scope restriction does not replace new-content sensitive detection');
});

for (const change of ['cancel', 'project', 'account', 'session']) test(`retry confirmation preserves ${change} boundary before Native dispatch`, async () => {
  const h = harness({ retryProject: project(CLEAN + MARKER), rules: { sensitiveConfirmAllowed: true }, approve: true, block: 'confirm' });
  const promise = h.start(); await h.barrier.entered;
  if (change === 'cancel') { h.context.runCancellationRequested = true; h.context.runCancellationController.abort(); }
  if (change === 'project') h.changeProject();
  if (change === 'account') h.changeAccount();
  if (change === 'session') await h.switchToB();
  h.barrier.release(); await complete(promise, h);
  assert.equal(h.io.requests.length, change === 'session' ? 2 : 1);
  if (change === 'session') {
    assert.equal(h.io.requests[1].clientSessionId, 'A');
    assert.equal(h.io.requests[1].session.id, 'A');
    assert.equal(h.io.requests[1].threadId, 'thread-A');
    assert.equal(h.controls.get('[data-task]').value, 'new B draft');
  } else assert.equal(h.snapshot().runStatus, 'cancelled');
});

test('retry default block persists redacted findings in audit settlement', async () => {
  const h = await run('retry-audit', { retryProject: project(CLEAN + MARKER) });
  const audit = h.io.audits.find(a => a.resultStatus === 'blocked_sensitive');
  assert.ok(audit); assert.equal(audit.sensitiveFindings[0].detectorId, 'private-key');
  assert.equal(audit.blockedFiles[0].path, 'main.tex');
  assert.equal(JSON.stringify(audit).includes(MARKER), false);
});

test('approved retry findings survive the real final audit builder', async () => {
  const h = await run('retry-approved-audit', { retryProject: project(CLEAN + MARKER), rules: { sensitiveConfirmAllowed: true }, approve: true });
  const audit = h.io.audits.findLast(a => a.resultStatus === 'completed');
  assert.ok(audit); assert.equal(audit.sensitiveFindings.some(f => f.detectorId === 'private-key'), true);
  assert.equal(JSON.stringify(audit).includes(MARKER), false);
});
