'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');
const SessionState = require('../extension/src/shared/sessionState');
const controllerSource = fs.readFileSync(path.join(__dirname, '../extension/src/content/panelMaintenance.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

function existingState() {
  let session = SessionState.createSession({
    task: 'unfinished draft', codexThreadId: 'thread_previous', mode: 'auto',
    focusFiles: ['main.tex'],
    selectionContext: { projectId: 'project_a', path: 'main.tex', from: 0, to: 3,
      text: 'old', documentHash: 'a'.repeat(64) },
    pendingInputs: [{ id: 'pending_previous', text: 'old queued task', status: 'paused' }],
    runs: [{ id: 'run_previous', task: 'previous task', status: 'completed',
      undoOperations: [{ type: 'edit', path: 'main.tex', replaceAll: 'before' }] }]
  });
  session = SessionState.recordSessionResult(session, { task: 'previous task', result: 'previous summary' });
  return SessionState.normalizePanelState({
    sessions: [session], activeSessionId: session.id,
    composerAttachments: [{ id: 'attachment_previous', name: 'notes.txt', mimeType: 'text/plain',
      size: 3, kind: 'file', contentBase64: 'b2xk' }],
    providerId: 'custom-provider', model: 'custom-model', reasoningEffort: 'medium', speedTier: 'fast',
    locale: 'zh', theme: 'light', panelWidth: 520, autoRecompile: false,
    customInstructionsByProject: { project_a: 'keep instructions' },
    governanceRulesByProject: { project_a: { readonlyPatterns: ['refs.bib'] } },
    loadCodexLocalSkills: false, codexOverleafSkillEnabled: { retained_skill: true }
  });
}

function harness(initial = existingState(), options = {}) {
  let state = clone(initial);
  let running = options.running || null;
  const calls = { confirm: 0, clear: 0, resetNames: 0, clearComposer: 0, saves: [], render: [], toasts: [], focus: 0 };
  const composer = { attachments: clone(initial.composerAttachments || []), skill: 'old-skill', retryRunId: 'run_previous' };
  const context = { window: {}, setTimeout, clearTimeout, Date: options.Date || Date };
  vm.runInNewContext(controllerSource, context);
  const controller = context.window.CodexOverleafPanelMaintenance.create({
    tx: en => en,
    showPluginToast: message => calls.toasts.push(message),
    showPluginConfirm: async () => {
      calls.confirm += 1;
      if (options.startRunDuringConfirm) running = { runProjectId: 'project_a' };
      return options.confirm !== false;
    },
    getCurrentRunView: () => running,
    getState: () => state, setState: value => { state = value; },
    normalizePanelState: options.normalizePanelState || SessionState.normalizePanelState,
    StorageDb: { async clearAllStores() {
      calls.clear += 1;
      if (options.clearError) throw new Error('storage clear failed');
    } },
    resetProjectNameCache: async () => {
      calls.resetNames += 1;
      if (options.cacheError) throw new Error('name cache unavailable');
    },
    // The composition root owns the live attachment/skill/retry controller;
    // this substitute verifies the clear handler invokes it before persisting.
    clearHistoryComposer: () => {
      calls.clearComposer += 1;
      assert.notEqual(state.activeSessionId, initial.activeSessionId);
      composer.attachments = []; composer.skill = null; composer.retryRunId = null;
    },
    saveState: async saveOptions => {
      calls.saves.push({ options: clone(saveOptions || {}), state: clone(state), composer: clone(composer) });
      if (options.saveError) throw new Error('fresh session persistence failed');
      return options.unconfirmedSave ? undefined : true;
    },
    applyStateToPanel: () => calls.render.push(clone(state)),
    ChangeHistoryView: { create: () => ({ invalidate() {}, load() {}, filter() {} }) },
    getSettingsPanelInstance: () => null,
    getPanel: () => ({ querySelector: selector => selector === '[data-task]' ? { focus: () => { calls.focus += 1; } } : null }),
    getCurrentProjectId: () => 'project_a', getAccountScopeId: () => 'account_a'
  });
  return { get state() { return state; }, composer, calls, clear: controller.clearAllHistoryWithConfirm };
}

function assertCleanState(state, oldId) {
  state = clone(state);
  assert.notEqual(state.activeSessionId, oldId);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.session.id, state.activeSessionId);
  assert.equal(state.session.codexThreadId, '');
  assert.equal(state.task, '');
  assert.deepEqual(state.session.history, []);
  assert.deepEqual(state.runs, []);
  assert.deepEqual(state.sessions[0].pendingInputs, []);
  assert.deepEqual(state.focusFiles, []);
  assert.equal(state.selectionContext, null);
  assert.deepEqual(state.composerAttachments, []);
}

test('confirmed clear replaces the modern session mirror and every old composer input with a fresh blank session', async () => {
  const before = existingState();
  assert.equal(before.session.id, before.sessions[0].id);
  assert.equal(before.sessions[0].pendingInputs.length, 1);
  const h = harness(before); await h.clear();
  assertCleanState(h.state, before.activeSessionId);
  assert.equal(h.calls.clearComposer, 1);
  assert.equal(h.calls.clear, 1); assert.equal(h.calls.resetNames, 1);
  assert.equal(h.calls.saves.length, 1);
  assert.deepEqual(h.calls.saves[0].options, { requireDurable: true });
  assertCleanState(h.calls.saves[0].state, before.activeSessionId);
  assert.deepEqual(h.calls.saves[0].composer, { attachments: [], skill: null, retryRunId: null });
  for (const key of ['providerId', 'model', 'reasoningEffort', 'speedTier', 'locale', 'theme', 'panelWidth',
    'autoRecompile', 'mode', 'requireReviewing', 'customInstructionsByProject', 'governanceRulesByProject',
    'loadCodexLocalSkills', 'codexOverleafSkillEnabled']) assert.deepEqual(h.state[key], before[key], key);
  assert.equal(h.calls.render.length, 1); assert.equal(h.calls.focus, 1);
  assert.match(h.calls.toasts.at(-1), /^Local history cleared\. Overleaf files are unchanged\.$/);
  const reload = SessionState.normalizePanelState(h.calls.saves[0].state);
  assertCleanState(reload, before.activeSessionId);
});

test('clearing a clean state remains clean', async () => {
  const before = SessionState.normalizePanelState({}); const h = harness(before);
  await h.clear(); assertCleanState(h.state, before.activeSessionId);
});

test('a fresh session created in the clear-marker millisecond has a strictly newer creation time', async () => {
  const clearedAt = Date.parse('2026-10-04T12:00:00.000Z');
  class FrozenDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clearedAt])); }
    static now() { return clearedAt; }
  }
  const filename = path.join(__dirname, '../extension/src/shared/sessionState.js');
  const sharedContext = { module: { exports: {} }, require: createRequire(filename), Date: FrozenDate };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sharedContext, { filename });
  const before = existingState();
  const h = harness(before, { Date: FrozenDate, normalizePanelState: sharedContext.module.exports.normalizePanelState });
  await h.clear();
  const createdAt = Date.parse(h.calls.saves[0].state.sessions[0].createdAt);
  // backgroundSharedSessions.writeMany rejects records created at/before its
  // account clear marker. No arbitrary sleep or broad future timestamp is needed.
  assert.equal(createdAt, clearedAt + 1);
});

for (const item of [
  { name: 'declined confirmation', options: { confirm: false }, confirm: 1, clear: 0 },
  { name: 'an active run', options: { running: { runProjectId: 'project_a' } }, confirm: 0, clear: 0 },
  { name: 'a run started while confirmation was open', options: { startRunDuringConfirm: true }, confirm: 1, clear: 0 },
  { name: 'failed store deletion', options: { clearError: true }, confirm: 1, clear: 1 }
]) {
  test(`${item.name} preserves the current state and composer`, async () => {
    const before = existingState(); const h = harness(before, item.options); const composer = clone(h.composer);
    await h.clear();
    assert.deepEqual(clone(h.state), clone(before)); assert.deepEqual(h.composer, composer);
    assert.equal(h.calls.confirm, item.confirm); assert.equal(h.calls.clear, item.clear);
    assert.equal(h.calls.clearComposer, 0); assert.equal(h.calls.saves.length, 0);
    assert.equal(h.calls.render.length, 0);
    assert.equal(h.calls.toasts.some(text => /^Local history cleared\./.test(text)), false);
  });
}

test('a project-name cache failure after deletion still clears stale in-memory history and reports the incomplete cleanup', async () => {
  const before = existingState(); const h = harness(before, { cacheError: true });
  await h.clear(); assertCleanState(h.state, before.activeSessionId);
  assert.equal(h.calls.render.length, 1);
  assert.equal(h.calls.saves.length, 1);
  assert.match(h.calls.toasts.at(-1), /name cache unavailable/);
  assert.doesNotMatch(h.calls.toasts.at(-1), /^Local history cleared\. Overleaf files are unchanged\.$/);
});

for (const item of [
  { name: 'a rejected save', options: { saveError: true }, expected: /fresh session persistence failed/ },
  { name: 'a save without durable confirmation', options: { unconfirmedSave: true }, expected: /not confirmed/ }
]) {
  test(`${item.name} keeps the cleared memory visible and avoids a complete-success toast`, async () => {
    const before = existingState(); const h = harness(before, item.options);
    await h.clear(); assertCleanState(h.state, before.activeSessionId);
    assert.equal(h.calls.render.length, 1); assert.equal(h.calls.focus, 1);
    assert.match(h.calls.toasts.at(-1), item.expected);
    assert.doesNotMatch(h.calls.toasts.at(-1), /^Local history cleared\. Overleaf files are unchanged\.$/);
  });
}
