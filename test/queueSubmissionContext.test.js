'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const { harness } = require('./_helpers/runSubmissionHarness');
const { extractFunction } = require('./_helpers/extractFunction');
const RunQueueScheduler = require('../extension/src/content/runQueueScheduler');
const Queue = require('../extension/src/shared/runInputQueue');
const SessionState = require('../extension/src/shared/sessionState');
const StorageDb = require('../extension/src/shared/storageDb');
const runtime = fs.readFileSync(path.join(root, 'extension/src/content/contentRuntime.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const QTEXT = 'Queued request: explain the introduction';
const DRAFT = 'Unsent unrelated next request';
const ORIGINAL_INSTRUCTIONS = 'Preserve the queued request terminology.';
const LATER_INSTRUCTIONS = 'Unrelated next-request instructions.';
const ATTACHMENT = { name: 'next-draft-only.txt', mimeType: 'text/plain', size: 25,
  contentBase64: Buffer.from('NEXT_DRAFT_ATTACHMENT_024').toString('base64') };
// Real queue/session/snapshot/runtime functions are combined across the enqueue,
// persisted record builder, restoration and Native-request boundaries. DOM,
// durable storage, installed-skill inventory and Native/model I/O are adapters.
function setup(block = '') {
  const h = harness(block);
  const extra = { attachments: [], instructions: ORIGINAL_INSTRUCTIONS,
    invocation: null, settings: { loadCodexLocalSkills: false, loadCodexOverleafSkills: false }, enabledIds: [] };
  const c = h.context;
  const queueMutations = [];
  const runs = [];
  c.getComposerAttachmentsForRun = () => clone(extra.attachments);
  c.getCustomInstructionsForCurrentProject = () => extra.instructions;
  // Skill getters and slash selection functions are production functions below.
  c.getSkillLoadingSettings = () => clone(extra.settings);
  c.getEnabledCodexOverleafSkillIds = () => [...extra.enabledIds];
  vm.runInContext(fs.readFileSync(path.join(root, 'extension/src/content/composerAttachments.js'), 'utf8'), c);
  const snapshotController = c.window.CodexOverleafComposerAttachments.createComposerAttachmentController({ getPanel: () => null });
  c.createRunAttachmentSnapshots = attachments => snapshotController.createRunAttachmentSnapshots(attachments);
  vm.runInContext(fs.readFileSync(path.join(root, 'extension/src/content/diagnosticsPanel.js'), 'utf8'), c);
  c.DiagnosticsPanel = c.window.CodexOverleafDiagnosticsPanel;
  c.getRunProjectSnapshot = async () => ({ id: 'project-one', files: [{ path: 'main.tex',
    content: 'Synthetic introduction material for a safe local composition test. '.repeat(5) }],
    capabilities: { fullProjectSnapshot: true } });
  c.renderedSlashCommands = new Map();
  c.slashCodexOverleafSkills = [{ id: 'later-skill-024', title: 'Later draft skill' }]; // synthetic installed catalog
  c.isCodexOverleafSkillEnabled = id => extra.enabledIds.includes(id);
  c.RunQueueScheduler = RunQueueScheduler;
  c.RunInputQueue = Queue;
  c.runInputCoordinator = null;
  c.isProjectEditorRoute = location => /^\/project\//.test(location.pathname);
  c.runGuidanceController.upsert = () => {};
  c.runGuidanceController.remove = () => {};
  c.saveState = async options => { queueMutations.push(clone(options || {})); h.io.saved.push(clone(c.state)); };
  c.saveStateSoon = (...args) => queueMutations.push({ soon: true, arguments: clone(args) });
  // The base fixture has no queue container; production render returns at the
  // ordinary no-container guard. No queue operation depends on this DOM seam.
  for (const name of ['initializeRunQueueScheduler', 'queueComposerInput', 'renderPendingInputs', 'runSkillInstallerTask',
    'getSlashTrigger', 'getSlashCommands', 'selectSlashCommand', 'clearSlashTriggerFromTaskInput', 'closeSlashMenu',
    'activateSkillInstallerComposerContext', 'activateCodexOverleafSkillComposerContext',
    'getComposerSkillInvocationForRun', 'normalizeComposerSkillInvocation', 'isSafeSkillId',
    'getProjectSnapshotWarnings', 'isTextSnapshotFile', 'uniqueContentSignatures']) {
    vm.runInContext(extractFunction(runtime, name), c);
  }
  const realRun = c.runTask;
  c.runTask = options => { const promise = realRun(options); runs.push(promise); return promise; };
  c.initializeRunQueueScheduler();
  return { h, c, extra, queueMutations, runs };
}
function enqueue(f) {
  f.h.type(QTEXT);
  f.c.currentRunView = { recordId: 'holder-024', sessionId: 'A', runProjectId: 'project-one' };
  f.c.queueComposerInput();
  const session = f.c.findSessionById('A');
  assert.equal(session.pendingInputs.length, 1, 'real coordinator enqueues');
  assert.equal(session.pendingInputs[0].text, QTEXT);
  assert.equal(f.h.controls.get('[data-task]').value, '', 'real enqueue clears submitted text');
  assert.equal(f.h.io.requests.length, 0, 'queued task has not dispatched');
  const item = clone(session.pendingInputs[0]);
  f.c.currentRunView = null;
  return item;
}
function pauseAtRecoveryBoundary(f) {
  // Mirrors the production recovery callback's pauseAll call. Journal/DB
  // hydration is deliberately the input seam; a real browser reload is not claimed.
  f.c.updateSessionById('A', { pendingInputs: Queue.pauseAll(f.c.findSessionById('A').pendingInputs, 'interrupted') });
  assert.equal(f.c.currentRunView, null);
  assert.equal(f.c.findSessionById('A').pendingInputs[0].status, 'paused');
  assert.equal(f.c.runQueueScheduler.scheduleOne('A'), false, 'paused queue cannot auto-start');
}
function selectIdleSkill(f, command) {
  assert.equal(f.c.currentRunView, null, 'slash skill selection requires idle UI');
  f.h.type('/');
  assert.ok(f.c.getSlashTrigger(), 'actual UI trigger allows selection while queue is paused');
  const available = f.c.getSlashCommands().find(item => item.kind === command.kind
    && (!command.skillId || item.skillId === command.skillId));
  assert.ok(available, 'actual slash command construction exposes requested command');
  f.c.renderedSlashCommands.set(available.id, available); // menu DOM rendering seam
  f.c.selectSlashCommand(available.id);
  assert.equal(f.c.getComposerSkillInvocationForRun().id, command.skillId || 'skill-installer');
  f.h.type(DRAFT);
}
async function promote(f, resume = false) {
  if (resume) f.c.runInputCoordinator.resume();
  else assert.equal(f.c.runQueueScheduler.scheduleOne('A'), true);
  // Wait for the production Promise-based scheduler to claim/save/promote.
  for (let i = 0; i < 100 && f.runs.length === 0; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.runs.length, 1, 'real scheduler invokes runTask exactly once');
  await f.runs[0];
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.h.io.errors, [], 'no missing dependencies or swallowed runtime errors');
  assert.equal(f.h.io.requests.length, 1, 'production sendTrackedCodexRun reaches intercepted Native transport once');
  assert.equal(f.c.findSessionById('A').pendingInputs.length, 0, 'real markExecuting removes promoted queue item');
  assert.equal(f.c.findSessionById('A').runs[0].status, 'completed');
  assert.ok(f.queueMutations.some(m => m.queueMutation?.type === 'claim'));
  assert.ok(f.queueMutations.some(m => m.queueMutation?.type === 'remove'));
  return f.h.io.requests[0];
}

test('queued submission without later changes preserves ordinary behavior', async () => {
  const f = setup(); enqueue(f); const request = await promote(f);
  assert.equal(request.task, QTEXT); assert.equal(request.customInstructions, ORIGINAL_INSTRUCTIONS);
  assert.equal(request.attachments, undefined); assert.equal(request.skillInvocation, undefined);
  assert.equal(request.skipMirrorSync, undefined); assert.ok(request.project);
});
test('attachments already present are refused by the enqueue guard', () => {
  const f = setup(); f.extra.attachments = [ATTACHMENT]; f.h.type(QTEXT);
  f.c.currentRunView = { recordId: 'holder-024', sessionId: 'A' }; f.c.queueComposerInput();
  assert.equal(f.c.findSessionById('A').pendingInputs.length, 0);
  assert.equal(f.h.controls.get('[data-task]').value, QTEXT); assert.equal(f.h.io.requests.length, 0);
});
test('queued submission never borrows a later unsent draft attachment', async () => {
  const f = setup(); enqueue(f); f.h.type(DRAFT); f.extra.attachments = [ATTACHMENT];
  const request = await promote(f);
  assert.equal(request.task, QTEXT); assert.equal(request.attachments, undefined);
  assert.equal(f.h.controls.get('[data-task]').value, DRAFT);
  assert.equal(f.extra.attachments[0].name, ATTACHMENT.name);
});
test('paused queued submission keeps its original extra inputs after idle skill changes and Resume', async () => {
  const f = setup(); enqueue(f); pauseAtRecoveryBoundary(f);
  f.extra.instructions = LATER_INSTRUCTIONS;
  f.extra.settings = { loadCodexLocalSkills: true, loadCodexOverleafSkills: true };
  f.extra.enabledIds = ['later-skill-024'];
  selectIdleSkill(f, { kind: 'codex-overleaf-skill', skillId: 'later-skill-024' });
  f.h.controls.get('[data-mode]').value = 'auto'; f.h.controls.get('[data-model]').value = 'later-model';
  const request = await promote(f, true);
  assert.equal(request.task, QTEXT); assert.equal(request.mode, 'ask'); assert.equal(request.model, 'fixture-model');
  assert.equal(request.customInstructions, ORIGINAL_INSTRUCTIONS); assert.equal(request.skillInvocation, undefined);
  assert.equal(request.loadCodexLocalSkills, false); assert.equal(request.loadCodexOverleafSkills, false);
  assert.deepEqual(request.enabledCodexOverleafSkillIds, []);
  assert.equal(f.h.controls.get('[data-task]').value, DRAFT);
});
test('later idle installer selection cannot redirect a previously ordinary queued task', async () => {
  const f = setup(); enqueue(f); pauseAtRecoveryBoundary(f);
  selectIdleSkill(f, { kind: 'installer' });
  const request = await promote(f, true);
  assert.equal(request.task, QTEXT); assert.equal(request.skillInvocation, undefined);
  assert.equal(request.skipMirrorSync, undefined); assert.ok(request.project);
  assert.equal(f.h.io.events.some(e => e.title === 'Starting the Codex skill installer.'), false);
  assert.equal(f.h.controls.get('[data-task]').value, DRAFT);
});
test('an explicitly submitted skill survives real storage compaction, restoration, claim and dispatch', async () => {
  const f = setup();
  f.extra.settings = { loadCodexLocalSkills: true, loadCodexOverleafSkills: true };
  f.extra.enabledIds = ['later-skill-024'];
  selectIdleSkill(f, { kind: 'codex-overleaf-skill', skillId: 'later-skill-024' });
  enqueue(f);
  const persisted = StorageDb.buildSessionRecord({ ...f.c.findSessionById('A'), projectId: 'project-one', accountScopeId: 'account-one' });
  const compactState = SessionState.prepareStateForStorage({ ...f.c.state, sessions: [persisted] });
  f.c.state = SessionState.normalizePanelState(JSON.parse(JSON.stringify(compactState)), { restoreRunningRuns: true });
  pauseAtRecoveryBoundary(f);
  f.extra.instructions = LATER_INSTRUCTIONS; f.extra.settings = { loadCodexLocalSkills: false, loadCodexOverleafSkills: false };
  f.extra.enabledIds = []; f.c.composerSkillInvocation = null; f.h.type(DRAFT);
  const request = await promote(f, true);
  assert.equal(request.task, QTEXT); assert.equal(request.customInstructions, ORIGINAL_INSTRUCTIONS);
  assert.equal(request.skillInvocation?.id, 'later-skill-024');
  assert.equal(request.loadCodexLocalSkills, true); assert.equal(request.loadCodexOverleafSkills, true);
  assert.deepEqual(request.enabledCodexOverleafSkillIds, ['later-skill-024']);
});
test('an explicitly queued installer invocation is retained when the composer later clears it', async () => {
  const f = setup(); selectIdleSkill(f, { kind: 'installer' }); enqueue(f);
  f.c.composerSkillInvocation = null; f.h.type(DRAFT);
  const request = await promote(f);
  assert.equal(request.skillInvocation?.id, 'skill-installer'); assert.equal(request.skipMirrorSync, true);
  assert.equal(request.task, QTEXT); assert.equal(request.project, undefined);
});
test('legacy queues without captured extras use empty safe defaults and never inherit current inputs', async () => {
  const f = setup(); const item = enqueue(f);
  delete item.payload.submissionContext;
  f.c.updateSessionById('A', { pendingInputs: [item] });
  pauseAtRecoveryBoundary(f); selectIdleSkill(f, { kind: 'installer' });
  f.extra.attachments = [ATTACHMENT]; f.extra.instructions = LATER_INSTRUCTIONS;
  f.extra.settings = { loadCodexLocalSkills: true, loadCodexOverleafSkills: true };
  const request = await promote(f, true);
  assert.equal(request.attachments, undefined); assert.equal(request.skillInvocation, undefined);
  assert.equal(request.customInstructions, undefined); assert.equal(request.skipMirrorSync, undefined);
  assert.equal(request.loadCodexLocalSkills, false); assert.equal(request.loadCodexOverleafSkills, false);
  assert.deepEqual(request.enabledCodexOverleafSkillIds, []);
});
test('queue-time extra inputs stay fixed across the promotion mirror wait', async () => {
  const f = setup('mirror'); enqueue(f); f.h.type(DRAFT);
  f.extra.attachments = [ATTACHMENT]; f.extra.instructions = 'PROMOTION_TIME_INPUT';
  const pending = promote(f); await f.h.barrier.entered;
  f.extra.attachments = []; f.extra.instructions = 'AFTER_PROMOTION_INPUT'; f.h.barrier.release();
  const request = await pending;
  assert.equal(request.task, QTEXT); assert.equal(request.attachments, undefined);
  assert.equal(request.customInstructions, ORIGINAL_INSTRUCTIONS);
});
test('queue context is bounded, drops unknown fields and follows storage redaction', () => {
  const f = setup(); f.extra.instructions = 'long '.repeat(4000); enqueue(f);
  const input = f.c.findSessionById('A').pendingInputs[0];
  const ctx = input.payload.submissionContext;
  assert.ok(ctx); assert.ok(ctx.customInstructions.length <= 12000);
  ctx.providerCredentials = { token: 'sensitive credential' };
  ctx.attachments = [ATTACHMENT]; ctx.skillLoadingSettings.password = 'sensitive credential';
  const normalized = Queue.normalizeQueue([input])[0];
  assert.equal(normalized.payload.submissionContext.providerCredentials, undefined);
  assert.equal(normalized.payload.submissionContext.attachments, undefined);
  assert.equal(normalized.payload.submissionContext.skillLoadingSettings.password, undefined);
  normalized.payload.submissionContext.customInstructions = 'api_key=sk-fixturesyntheticlongkeyvalue';
  const persisted = StorageDb.buildSessionRecord({ ...f.c.findSessionById('A'), pendingInputs: [normalized], projectId: 'project-one' });
  assert.doesNotMatch(JSON.stringify(persisted.pendingInputs), /sk-fixturesyntheticlongkeyvalue/);
});

test('queueing preserves every enabled skill within the existing queue byte budget', async () => {
  const f = setup(); f.extra.settings = { loadCodexLocalSkills: true, loadCodexOverleafSkills: true };
  f.extra.enabledIds = [...Array.from({ length: 110 }, (_, index) => `enabled-skill-${index}`), 'later-skill-024'];
  selectIdleSkill(f, { kind: 'codex-overleaf-skill', skillId: 'later-skill-024' });
  enqueue(f); f.extra.enabledIds = []; f.c.composerSkillInvocation = null;
  const request = await promote(f);
  assert.equal(request.skillInvocation?.id, 'later-skill-024');
  assert.equal(request.enabledCodexOverleafSkillIds.length, 111);
  assert.ok(request.enabledCodexOverleafSkillIds.includes('later-skill-024'));
});
