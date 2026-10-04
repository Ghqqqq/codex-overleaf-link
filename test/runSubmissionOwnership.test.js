'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const { extractFunction } = require(path.join(root, 'test/_helpers/extractFunction'));
const SessionState = require(path.join(root, 'extension/src/shared/sessionState'));
const RunExecutionSnapshot = require(path.join(root, 'extension/src/shared/runExecutionSnapshot'));
const runController = require(path.join(root, 'extension/src/content/runController'));
const WritebackSettlement = require(path.join(root, 'extension/src/shared/writebackSettlement'));
const ProjectFiles = require(path.join(root, 'extension/src/shared/projectFiles'));
const runtime = fs.readFileSync(path.join(root, 'extension/src/content/contentRuntime.js'), 'utf8');
const sessionManagerSource = fs.readFileSync(path.join(root, 'extension/src/content/sessionManager.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const no = () => {};
const networkForbidden = async () => { throw new Error('fixture_network_forbidden'); };
const { harness, deferred } = require('./_helpers/runSubmissionHarness');
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
function correctOriginalSubmission(h) {
  return h.io.requests.length === 0 || h.io.requests.every(p => p.task === 'task from A' && p.clientSessionId === 'A' && p.threadId === 'thread-A');
}

test('CONTROL normal safeRunTask submits task A to session/thread A', { timeout: 3000 }, async () => {
  const h = harness(); const outcome = await complete(h.start(), h, 'normal'); assert.equal(outcome.ok, true);
  assert.equal(h.io.requests.length, 1); assert.equal(correctOriginalSubmission(h), true);
  assert.equal(h.context.state.sessions.find(s => s.id === 'A').runs[0].status, 'completed');
  assert.equal(h.context.state.sessions.find(s => s.id === 'B').task, 'original B draft');
});
for (const kind of ['project','account']) test(`CONTROL ${kind} changes while provider prepares safely rejects submission`, { timeout: 3000 }, async () => {
  const h = harness('provider'), promise = h.start(); await h.barrier.entered;
  kind === 'project' ? h.changeProject() : h.changeAccount(); h.barrier.release();
  const outcome = await complete(promise, h, `${kind}-guard`, true);
  assert.equal(outcome.ok, false); assert.match(outcome.message, /active project changed/i); assert.equal(h.io.requests.length, 0);
  assert.equal(h.controls.get('[data-task]').value, 'task from A');
});
test('CONTROL after run creation and composer clear, session switch keeps explicit run/thread ownership and B draft', { timeout: 3000 }, async () => {
  const h = harness('snapshot'), promise = h.start(); await h.barrier.entered;
  assert.equal(h.context.currentRunView.sessionId, 'A'); await h.switchToB(); h.barrier.release();
  await complete(promise, h, 'established-run-switch'); assert.equal(correctOriginalSubmission(h), true);
  assert.equal(h.io.requests.length, 1); assert.equal(h.context.state.sessions.find(s => s.id === 'B').task, 'new B draft');
  assert.equal(h.controls.get('[data-task]').value, 'new B draft'); assert.equal(h.io.prompts.length, 1);
});
for (const block of ['provider','style','mirror']) test(`CONTRACT ${block} preparation cannot reassign original submission or erase later B draft`, { timeout: 3000 }, async () => {
  const h = harness(block), promise = h.start(); await h.barrier.entered; await h.switchToB(); h.barrier.release();
  await complete(promise, h, `${block}-switch`, true);
  assert.equal(correctOriginalSubmission(h) && h.context.state.sessions.find(s => s.id === 'B').task === 'new B draft'
    && h.controls.get('[data-task]').value === 'new B draft', true,
    'The click must remain bound to A or safely reject; B draft must remain untouched.');
});
test('CONTRACT pending mirror cannot replace clicked A task with a newer draft in the same session', { timeout: 3000 }, async () => {
  const h = harness('mirror'), promise = h.start(); await h.barrier.entered; h.type('new A draft'); h.barrier.release();
  await complete(promise, h, 'mirror-edit-draft', true);
  assert.equal(correctOriginalSubmission(h) && h.controls.get('[data-task]').value === 'new A draft', true,
    'The submitted task must stay fixed or be rejected, while later composer text survives.');
});
test('CONTRACT audit preparation cannot clear a later B draft after run A has been established', { timeout: 3000 }, async () => {
  const h = harness('audit'), promise = h.start(); await h.barrier.entered;
  assert.equal(h.context.currentRunView.sessionId, 'A'); await h.switchToB(); h.barrier.release();
  await complete(promise, h, 'audit-switch', true); assert.equal(correctOriginalSubmission(h), true);
  assert.equal(h.io.prompts.length, 1, 'real SessionManager requested confirmation and fixture user approved leaving the running A session');
  assert.equal(h.context.state.sessions.find(s => s.id === 'B').task, 'new B draft');
  assert.equal(h.controls.get('[data-task]').value, 'new B draft');
});

test('CONTRACT established A run cannot inject B session history into its real Native prompt', { timeout: 3000 }, async () => {
  const h = harness('snapshot');
  const markerA = 'SYNTHETIC_A_HISTORY_030', markerB = 'SYNTHETIC_B_HISTORY_030';
  h.manager.updateSessionById('A', { history: [{ task: markerA, result: 'A fixture response', at: '2026-10-03T00:00:00.000Z' }] });
  h.manager.updateSessionById('B', { history: [{ task: markerB, result: 'B fixture response', at: '2026-10-03T00:00:00.000Z' }] });
  const promise = h.start(); await h.barrier.entered;
  assert.equal(h.context.currentRunView.sessionId, 'A'); await h.switchToB(); h.barrier.release();
  await complete(promise, h, null, true);
  assert.equal(correctOriginalSubmission(h), true, 'existing explicit session/thread guard must still hold');
  assert.equal(h.io.prompts.length, 1, 'leaving running A was explicitly confirmed by the fixture user');
  assert.equal(h.context.state.sessions.find(s => s.id === 'B').task, 'new B draft');
  const request = h.io.requests[0];
  const { buildCodexTurnPrompt } = require(path.join(root, 'native-host/src/codexPromptAssembly'));
  const prompt = request ? buildCodexTurnPrompt({ params: request }) : null;
  h.io.promptEvidence = { safeRejected: !request,
    sessionLine: prompt?.systemPrompt.match(/^Session id: .*$/m)?.[0] || '',
    containsAHistory: Boolean(prompt?.systemPrompt.includes(markerA)),
    containsBHistory: Boolean(prompt?.systemPrompt.includes(markerB)), userPrompt: prompt?.userPrompt || '' };
  observe('established-run-prompt-context', h);
  assert.equal(!request || (h.io.promptEvidence.sessionLine === 'Session id: A'
    && h.io.promptEvidence.containsAHistory && !h.io.promptEvidence.containsBHistory), true,
    'Native prompt context must retain session A and its history, or reject safely; explicit thread A alone is insufficient.');
});

for (const block of ['provider', 'style', 'audit']) test(`later same-session draft survives ${block} preparation`, async () => {
  const h = harness(block), promise = h.start(); await h.barrier.entered;
  h.type('later draft in A'); h.barrier.release(); await complete(promise, h);
  assert.equal(h.io.requests.length, 1); assert.equal(correctOriginalSubmission(h), true);
  assert.equal(h.controls.get('[data-task]').value, 'later draft in A');
  assert.equal(h.context.state.sessions.find(s => s.id === 'A').task, 'later draft in A');
});

test('later attachment, skill and selection edits are retained while the original submission is dispatched', async () => {
  const h = harness('audit');
  let attachments = [{ name: 'old.txt', contentBase64: 'b2xk', mimeType: 'text/plain', size: 3 }];
  let skill = { id: 'synthetic-skill', title: 'Original skill', scope: 'codex-overleaf' };
  let selection = null;
  h.context.getComposerAttachmentsForRun = () => clone(attachments);
  h.context.getComposerSkillInvocationForRun = () => clone(skill);
  h.context.selectionContextView.capture = () => selection;
  const promise = h.start(); await h.barrier.entered;
  attachments = [{ name: 'new.txt', contentBase64: 'bmV3', mimeType: 'text/plain', size: 3 }];
  skill = { id: 'later-skill', title: 'Later skill' };
  selection = { path: 'main.tex', text: 'later selected content' };
  h.barrier.release(); await complete(promise, h);
  assert.equal(h.io.requests[0].attachments[0].name, 'old.txt');
  assert.equal(h.io.requests[0].skillInvocation.id, 'synthetic-skill');
  assert.equal(h.io.cleared.length, 0);
  assert.equal(h.controls.get('[data-task]').value, 'task from A');
});

test('deleted submission owner is rejected without assigning the run to another session', async () => {
  const h = harness('provider'), promise = h.start(); await h.barrier.entered;
  await h.switchToB(); h.context.state.sessions = h.context.state.sessions.filter(s => s.id !== 'A');
  h.barrier.release(); const result = await complete(promise, h, null, true);
  assert.equal(result.ok, false); assert.equal(h.io.requests.length, 0);
  assert.equal(h.controls.get('[data-task]').value, 'new B draft');
});

test('repeated clicks during preparation create one run and leave later text available', async () => {
  const h = harness('provider'), promise = h.start(); await h.barrier.entered;
  h.type('later unsubmitted text'); h.context.safeRunTask();
  h.barrier.release(); await complete(promise, h);
  assert.equal(h.io.requests.length, 1); assert.equal(correctOriginalSubmission(h), true);
  assert.equal(h.context.state.sessions.find(s => s.id === 'A').runs.length, 1);
  assert.equal(h.controls.get('[data-task]').value, 'later unsubmitted text');
});

test('thread identity stays at submission while mutable session state changes during preparation', async () => {
  const h = harness('provider'), promise = h.start(); await h.barrier.entered;
  h.manager.updateSessionById('A', { codexThreadId: 'later-thread' });
  h.barrier.release(); await complete(promise, h);
  assert.equal(h.io.requests[0].threadId, 'thread-A');
  assert.equal(h.io.requests[0].session.codexThreadId, 'thread-A');
});

test('queue promotion retains the current composer draft', async () => {
  const h = harness();
  const queuedInput = { id: 'queued-A', text: 'queued task', payload: RunExecutionSnapshot.toQueuePayload(h.context.captureCurrentExecutionSnapshot()) };
  await complete(h.context.runTask({ queuedInput }), h);
  assert.equal(h.io.requests[0].task, 'queued task');
  assert.equal(h.controls.get('[data-task]').value, 'task from A');
  assert.equal(h.io.cleared.length, 0);
});

test('a later attachment still reading survives submitted-composer cleanup', async () => {
  const h = harness('audit'); let finishRead;
  h.context.FileReader = class {
    readAsDataURL() { finishRead = () => { this.result = 'data:text/plain;base64,bGF0ZXI='; this.onload(); }; }
  };
  vm.runInContext(fs.readFileSync(path.join(root, 'extension/src/content/composerAttachments.js'), 'utf8'), h.context);
  const controller = h.context.window.CodexOverleafComposerAttachments.createComposerAttachmentController({ getPanel: () => null });
  h.context.composerAttachmentController = controller;
  h.context.getComposerAttachmentsForRun = () => controller.getAttachmentsForRun();
  const promise = h.start(); await h.barrier.entered;
  const pending = controller.addFiles([{ name: 'later.txt', type: 'text/plain', size: 5 }]);
  assert.equal(controller.getAttachmentByteUsage().pending, 5);
  h.barrier.release(); await complete(promise, h); finishRead(); await pending;
  assert.equal(h.io.requests[0].attachments, undefined);
  assert.equal(controller.getAttachmentsForRun()[0]?.name, 'later.txt');
});

test('a later selection still waiting for Page survives submitted-composer cleanup', async () => {
  const h = harness('audit'); const pending = deferred();
  const selection = { projectId: 'project-one', path: 'main.tex', from: 0, to: 5, text: 'later', documentHash: 'a'.repeat(64) };
  const SelectionContextView = require(path.join(root, 'extension/src/content/selectionContextView'));
  const controller = SelectionContextView.create({ getState: () => h.context.state,
    getProjectId: () => 'project-one', getPanel: () => null,
    callPageBridge: () => pending.promise,
    setSelection: value => { h.context.state = SessionState.updateActiveSession(h.context.state, { selectionContext: value }); }
  });
  h.context.selectionContextView = controller;
  const promise = h.start(); await h.barrier.entered;
  const attachment = controller.attach();
  h.barrier.release(); await complete(promise, h);
  pending.resolve({ ok: true, selection }); await attachment;
  assert.equal(h.io.requests[0].selectionContext, null);
  assert.equal(controller.capture()?.text, 'later');
});

for (const change of ['project', 'account']) for (const draft of ['task from A', 'new scope draft']) test(`${change} changing during audit preserves ${draft} and cannot dispatch the old run`, async () => {
  const h = harness('audit'), promise = h.start(); await h.barrier.entered;
  if (change === 'project') h.changeProject(); else h.changeAccount();
  h.type(draft); h.barrier.release(); await complete(promise, h);
  assert.equal(h.io.requests.length, 0); assert.equal(h.controls.get('[data-task]').value, draft);
  assert.equal(h.io.cleared.length, 0);
});

test('late compatibility result from a cancelled run cannot dispatch or bind into the next run', async () => {
  const h = harness('native'), oldGate = deferred(), gateEntered = deferred();
  let gateCalls = 0;
  h.context.nativeCompatibilityController.ensureForMethod = () => {
    if (++gateCalls === 1) { gateEntered.resolve(); return oldGate.promise; }
    return Promise.resolve({ ok: true, compatibility: {} });
  };
  const oldRun = h.start(); await gateEntered.promise;
  const oldId = h.context.currentRunView.recordId;
  h.context.runCancellationRequested = true; h.context.runCancellationController.abort();
  await complete(oldRun, h); await Promise.resolve();
  h.type('next run task'); const nextRun = h.start(); await h.barrier.entered;
  const nextId = h.context.currentRunView.recordId;
  assert.notEqual(nextId, oldId); assert.equal(h.io.requests.length, 1);
  oldGate.resolve({ ok: true, compatibility: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.io.requests.length, 1, 'cancelled request must never reach Native after a later run begins');
  assert.equal(h.io.binds.length, 1); assert.equal(h.io.binds[0].clientRunId, nextId);
  h.barrier.release(); await complete(nextRun, h);
  assert.equal(h.io.requests[0].clientRunId, nextId);
});

test('skill-installer early branch keeps submitted session context through a visible-session switch', async () => {
  const h = harness('audit');
  vm.runInContext(extractFunction(runtime, 'runSkillInstallerTask'), h.context);
  h.context.getComposerSkillInvocationForRun = () => ({ id: 'skill-installer', title: 'Synthetic installer' });
  const promise = h.start(); await h.barrier.entered; await h.switchToB();
  h.barrier.release(); await complete(promise, h);
  assert.equal(h.io.requests.length, 1); assert.equal(h.io.requests[0].session.id, 'A');
  assert.equal(h.io.requests[0].threadId, 'thread-A'); assert.equal(h.io.requests[0].skipMirrorSync, true);
  assert.equal(h.io.requests[0].clientSessionId, 'A'); assert.equal(h.io.binds[0].clientRunId, h.io.requests[0].clientRunId);
  assert.equal(h.controls.get('[data-task]').value, 'new B draft');
});

for (const gateStatus of ['ok', 'native_too_old']) test(`skill-installer late ${gateStatus} compatibility result cannot affect a later ordinary run`, async () => {
  const h = harness('native'), oldGate = deferred(), entered = deferred();
  vm.runInContext(extractFunction(runtime, 'runSkillInstallerTask'), h.context);
  vm.runInContext(extractFunction(runtime, 'sendNative'), h.context);
  let skill = { id: 'skill-installer', title: 'Synthetic installer' }, pingCount = 0;
  h.context.getComposerSkillInvocationForRun = () => skill;
  const NativeCompatibilityController = require(path.join(root, 'extension/src/content/nativeCompatibilityController'));
  h.context.nativeChannel.sendBackgroundNative = () => {
    if (++pingCount === 1) { entered.resolve(); return oldGate.promise; }
    return Promise.resolve({ ok: true });
  };
  h.context.nativeChannel.sendNative = request => h.context.nativeChannel.sendNativeTracked(request).promise;
  h.context.nativeCompatibilityController = NativeCompatibilityController.create({
    nativeChannel: h.context.nativeChannel, gatedMethods: new Set(['codex.run']),
    fallbackNativeCompatibility: response => ({ status: response.compatibilityStatus || 'ok' }),
    getNativeCompatibilityClassification: value => value.status,
    getCurrentRunView: () => h.context.currentRunView, appendRunEvent: h.context.appendRunEvent,
    throwIfCancellationRequested: () => h.context.throwIfRunCancellationRequested(),
    tx: h.context.tx, tr: h.context.tr
  });
  const oldRun = h.start(); await entered.promise;
  h.context.runCancellationRequested = true; h.context.runCancellationController.abort();
  await complete(oldRun, h); await Promise.resolve();
  skill = null; h.type('ordinary next task'); const nextRun = h.start(); await h.barrier.entered;
  const nextId = h.context.currentRunView.recordId;
  oldGate.resolve({ ok: true, compatibilityStatus: gateStatus }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.io.events.some(event => event.title === 'nativeCompatibilityBlockedNativeTooOld'), false, 'stale compatibility must not append failure to the new run');
  assert.equal(h.context.currentRunView.recordId, nextId);
  assert.equal(h.io.requests.length, 1, 'installer old gate must not create a second Native request');
  assert.equal(h.io.binds.length, 1); assert.equal(h.io.binds[0].clientRunId, nextId);
  h.barrier.release(); await complete(nextRun, h);
});
