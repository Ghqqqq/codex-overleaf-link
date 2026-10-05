'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { extractFunction } = require('./_helpers/extractFunction');
const { nativeRunControlFixture, deferred } = require('./_helpers/nativeRunControlFixture');
const Queue = require('../extension/src/shared/runInputQueue');
const Scheduler = require('../extension/src/content/runQueueScheduler');
const SensitivePreflight = require('../extension/src/content/sensitivePreflight');
const SensitiveScan = require('../extension/src/shared/sensitiveScan');
const Rules = require('../extension/src/shared/governanceRules');
const Compatibility = require('../extension/src/shared/compatibility');
const CompatibilityController = require('../extension/src/content/nativeCompatibilityController');
const source = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
const marker = '-----BEGIN PRIVATE KEY-----'; // Detector shape only; no credential.
async function fixture(t, { task = marker, rules = {}, approve = false, confirming, pingWait } = {}) {
  const native = nativeRunControlFixture(t), pending = native.start('run-original'); await native.entered;
  t.after(async () => { native.finish(); await pending; });
  const session = { id: 's', createdAt: 'one', pendingInputs: Queue.enqueue([], { text: task }, { randomUUID: () => 'q' }).queue };
  const log = { events: [], reports: [], prompts: [], sent: [] };
  const c = vm.createContext({ state: { activeSessionId: 's' }, currentRunView: { sessionId: 's', recordId: 'r',
    nativeRequestId: 'run-original', runProjectId: 'project-one', activeTurn: { threadId: 'thread-one', turnId: 'turn-one' } },
    cachedAccountScopeId: 'account-one', spaRouteGeneration: 0, runCancellationRequested: false,
    runCancellationController: new AbortController(), runInputCoordinator: null, runQueueScheduler: null,
    RunQueueScheduler: Scheduler, RunInputQueue: Queue, Modules: { SensitivePreflight }, SensitiveScan,
    normalizeGovernanceRules: Rules.normalizeGovernanceRules, getGovernanceRulesForCurrentProject: () => rules,
    getCurrentProjectId: () => 'project-one', getActiveSession: () => session, findSessionById: () => session,
    updateSessionById: (_id, update) => Object.assign(session, update), readPanelInputs() {}, panel: { querySelector: () => null },
    isTextSnapshotFile: () => true, runGuidanceController: { upsert() {}, remove() {} }, saveState: async () => {}, saveStateSoon() {},
    tr: key => key, tx: en => en, showPluginToast() {}, crypto: { randomUUID: () => 'unused' },
    appendRunEvent: e => log.events.push(e), appendCompletionReport: e => log.reports.push(e),
    showPluginConfirm: async input => { log.prompts.push(input); if (confirming) { confirming.entered.resolve(); await confirming.release.promise; } return approve; },
    sendBackgroundNative: async payload => { log.sent.push(payload); assert.equal(payload.method, 'codex.steer'); return native.handle({ id: 'guide-rpc', ...payload }); }
  });
  const channel = { async sendBackgroundNative(payload) {
    if (payload.method === 'bridge.ping') {
      if (pingWait) { pingWait.entered.resolve(); await pingWait.release.promise; }
      return native.handle({ id: 'ping-rpc', ...payload });
    }
    log.sent.push(payload); assert.equal(payload.method, 'codex.steer');
    return native.handle({ id: 'guide-rpc', ...payload });
  } };
  const declaration = source.match(/const NATIVE_COMPATIBILITY_GATED_METHODS = new Set\((\[[\s\S]*?\])\);/);
  c.nativeCompatibilityController = CompatibilityController.create({ compatibility: Compatibility,
    nativeChannel: channel, gatedMethods: new Set(vm.runInNewContext(declaration[1])),
    getExtensionCompatibilityMetadata: () => ({ version: Compatibility.BUILD_TARGET_VERSION }),
    getNativeCompatibilityClassification: value => value.classification, tx: en => en, tr: key => key,
    throwIfCancellationRequested() { if (c.runCancellationRequested) throw Object.assign(new Error('cancelled'), { code: 'codex_cancelled' }); }
  });
  c.sendBackgroundNative = payload => c.nativeCompatibilityController.sendBackgroundNative(payload);
  for (const name of ['runSensitivePreflight', 'initializeRunQueueScheduler']) vm.runInContext(extractFunction(source, name), c);
  c.initializeRunQueueScheduler(); return { c, session, log, native, guide: () => c.runInputCoordinator.guide('q') };
}
for (const spec of [
  { name: 'default secret block', task: marker, expected: 0 },
  { name: 'clean guidance', task: 'Explain this proof', expected: 1 },
  { name: 'scan disabled', task: marker, rules: { sensitiveCheckEnabled: false }, expected: 1 },
  { name: 'confirmation denied', task: marker, rules: { sensitiveConfirmAllowed: true }, approve: false, expected: 0 },
  { name: 'confirmation approved', task: marker, rules: { sensitiveConfirmAllowed: true }, approve: true, expected: 1 }
]) test('Guide runtime producer → preflight → Native control: ' + spec.name, async t => {
  const h = await fixture(t, spec); await h.guide();
  assert.equal(h.native.calls.steers.length, spec.expected); assert.equal(h.log.sent.length, spec.expected);
  assert.equal(h.log.reports.length, 0, 'blocked guidance must not finish the already-running task');
  if (!spec.expected) assert.equal(h.session.pendingInputs[0].status, 'queued');
  if (spec.rules?.sensitiveConfirmAllowed) assert.equal(h.log.prompts.length, 1);
  assert.equal(JSON.stringify(h.log.events).includes(marker), false, 'findings display only redacted previews');
});
for (const changed of ['cancel', 'account', 'project', 'turn', 'item']) test('Guide confirmation refuses changed ' + changed, async t => {
  const confirming = { entered: deferred(), release: deferred() };
  const h = await fixture(t, { rules: { sensitiveConfirmAllowed: true }, approve: true, confirming });
  const pending = h.guide();
  // A baseline without preflight never enters confirmation; observe the red
  // contract assertion without waiting on a promise that cannot occur.
  for (let n = 0; n < 20 && !h.log.prompts.length; n++) await new Promise(r => setImmediate(r));
  assert.equal(h.log.prompts.length, 1, 'Guide must reach the existing confirmation');
  if (changed === 'cancel') h.c.runCancellationRequested = true;
  if (changed === 'account') h.c.cachedAccountScopeId = 'other-account';
  if (changed === 'project') h.c.getCurrentProjectId = () => 'other-project';
  if (changed === 'turn') h.c.currentRunView.activeTurn.turnId = 'other-turn';
  if (changed === 'item') h.session.pendingInputs[0].text = 'changed while confirming';
  confirming.release.resolve(); await pending.catch(() => {});
  assert.equal(h.native.calls.steers.length, 0);
});

for (const change of ['cancel', 'signal', 'account', 'project', 'turn', 'session', 'run']) test('Guide actual compatibility wait refuses changed ' + change, async t => {
  const pingWait = { entered: deferred(), release: deferred() };
  const h = await fixture(t, { task: 'Safe guidance', pingWait });
  const pending = h.guide();
  await pingWait.entered.promise;
  if (change === 'cancel') h.c.runCancellationRequested = true;
  if (change === 'signal') h.c.runCancellationController.abort();
  if (change === 'account') h.c.cachedAccountScopeId = 'other-account';
  if (change === 'project') h.c.getCurrentProjectId = () => 'other-project';
  if (change === 'turn') h.c.currentRunView.activeTurn.turnId = 'other-turn';
  if (change === 'session') h.c.getActiveSession = () => ({ id: 'other-session' });
  if (change === 'run') h.c.currentRunView = { ...h.c.currentRunView };
  pingWait.release.resolve(); await pending.catch(() => {});
  assert.equal(h.native.calls.steers.length, 0); assert.equal(h.log.sent.length, 0);
  if (['cancel', 'signal', 'turn', 'session', 'run'].includes(change)) assert.equal(h.session.pendingInputs[0].status, 'queued');
});
