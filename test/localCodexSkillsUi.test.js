'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { extractFunction } = require('./_helpers/extractFunction');
const { harness, deferred } = require('./_helpers/runSubmissionHarness');
const { createLocalSkillsPanelController } = require('../extension/src/content/localSkillsPanel');
const I18n = require('../extension/src/shared/i18n');
const runtime = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
function node(tag = 'div') {
  let text = '';
  return { tag, children: [], dataset: {}, listeners: {}, className: '',
    set textContent(value) { text = value; this.children = []; }, get textContent() { return text; },
    append(...items) { this.children.push(...items); }, addEventListener(type, fn) { this.listeners[type] = fn; },
    setAttribute(name, value) { this[name] = value; }, closest() { return null; },
    querySelector(selector) { return this.children.find(c => selector.startsWith('.') && c.className === selector.slice(1)) || null; }
  };
}
function panelHarness({ skills = [{ id: 'local-a', title: 'Same title', sourceKind: 'user', enabled: false }], enabled = true } = {}) {
  const localList = node(), overleafList = node(), settings = { loadCodexLocalSkills: enabled, loadCodexOverleafSkills: true };
  let state = { codexOverleafSkills: [{ id: 'a', title: 'Same title', removable: false }] }, locale = 'en';
  const calls = [];
  const panel = { querySelector: selector => ({ '[data-codex-local-skill-list]': localList, '[data-local-skill-list]': overleafList })[selector] || null };
  const controller = createLocalSkillsPanelController({ document: { createElement: node }, getPanel: () => panel,
    getState: () => state, setState: next => { state = next; }, getSkillLoadingSettings: () => settings,
    getCodexLocalSkills: () => skills, setCodexLocalSkillEnabled: (id, value) => calls.push({ id, value }),
    tr: (key, values) => I18n.t(locale, key, values), tx: (en, zh) => locale === 'zh' ? zh : en });
  return { controller, localList, overleafList, calls, settings, setLocale: value => { locale = value; } };
}

test('local and Overleaf names coexist, with source defaults, a local switch, and no local remove action', () => {
  const h = panelHarness(); h.controller.renderLocalSkillList();
  const row = h.localList.children[0], overleaf = h.overleafList.children[0];
  assert.equal(row.dataset.scope, 'codex-local'); assert.equal(overleaf.dataset.scope, 'codex-overleaf');
  const toggle = row.children.find(n => n.tag === 'input');
  assert.equal(toggle.checked, false, 'source disabled stays off until explicitly selected');
  assert.equal(row.children.some(n => n.tag === 'button'), false);
  toggle.listeners.change({ target: { checked: true } });
  assert.deepEqual(h.calls, [{ id: 'local-a', value: true }]);
});

test('local master off keeps individual choices and disables only local controls', () => {
  const h = panelHarness({ enabled: false, skills: [{ id: 'local-a', title: 'A', enabled: true }] });
  h.controller.renderLocalSkillList();
  const row = h.localList.children.find(n => n.dataset.scope === 'codex-local');
  const toggle = row.children.find(n => n.tag === 'input');
  assert.equal(toggle.checked, true); assert.equal(toggle.disabled, true);
  assert.equal(h.overleafList.children[0].children.find(n => n.tag === 'input').disabled, undefined);
});

test('local source labels follow locale while source-provided names remain intact', () => {
  const h = panelHarness(); h.controller.renderLocalSkillList();
  const copy = h.localList.children[0].children[0];
  assert.equal(copy.children[1].textContent, 'Local Codex');
  h.setLocale('zh'); h.controller.refreshLocale();
  assert.equal(copy.children[0].textContent, 'Same title'); assert.equal(copy.children[1].textContent, 'Codex 本地');
});

function slashHarness() {
  const context = { tr: key => I18n.t('en', key), getSkillLoadingSettings: () => ({ loadCodexLocalSkills: true, loadCodexOverleafSkills: true }),
    slashCodexOverleafSkills: [{ id: 'same', title: 'Same title' }], isCodexOverleafSkillEnabled: () => true,
    getCodexLocalSkillsCatalog: () => [{ id: 'local-a', title: 'Same title' }, { id: 'local-b', title: 'Hidden' }],
    isCodexLocalSkillEnabled: id => id !== 'local-b' };
  vm.createContext(context);
  for (const name of ['isSafeSkillId', 'getSlashCommands', 'normalizeComposerSkillInvocation']) vm.runInContext(extractFunction(runtime, name), context);
  return context;
}
test('slash menu uses source identities and hides disabled local skills', () => {
  const h = slashHarness(), commands = h.getSlashCommands();
  assert.deepEqual(plain(commands.map(c => c.id)), ['install-skill', 'skill:same', 'local-skill:local-a']);
  assert.equal(commands[1].title, commands[2].title); assert.notEqual(commands[1].subtitle, commands[2].subtitle);
  h.getSkillLoadingSettings = () => ({ loadCodexLocalSkills: false, loadCodexOverleafSkills: true });
  assert.equal(h.getSlashCommands().some(c => c.scope === 'codex-local'), false);
});
test('local skill-installer identity never normalizes to the built-in installer', () => {
  const h = slashHarness();
  assert.deepEqual(plain(h.normalizeComposerSkillInvocation({ id: 'skill-installer', title: 'Local installer', scope: 'codex-local' })),
    { id: 'skill-installer', title: 'Local installer', scope: 'codex-local' });
  assert.deepEqual(plain(h.normalizeComposerSkillInvocation({ id: 'skill-installer', title: 'Installer' })), { id: 'skill-installer', title: 'Installer' });
});

function catalogHarness() {
  const response = deferred(); let project = 'a', count = 0;
  const context = { codexLocalSkillsCatalog: null, codexLocalSkillsWarnings: [], codexLocalSkillsCatalogScope: '', codexLocalSkillsCatalogRequest: null,
    cachedAccountScopeId: 'account', spaRouteGeneration: 1, getCurrentProjectId: () => project,
    getSkillLoadingSettings: () => ({ loadCodexLocalSkills: true }), tx: en => en,
    updateSkillsEntrySummary() {}, updateSlashMenuForTaskInput() {},
    sendBackgroundNative: req => { count++; assert.equal(req.params.scope, 'codex-local'); return response.promise; } };
  vm.createContext(context);
  for (const name of ['isSafeSkillId', 'getCodexLocalSkillsCatalogScope', 'getCodexLocalSkillsCatalog', 'getCodexLocalSkillWarnings', 'primeCodexLocalSkillsCatalog']) vm.runInContext(extractFunction(runtime, name), context);
  return { context, resolve: response.resolve, count: () => count, changeProject: () => { project = 'b'; } };
}
test('local catalog shares an in-flight read and accepts an empty directory', async () => {
  const h = catalogHarness();
  const a = h.context.primeCodexLocalSkillsCatalog(), b = h.context.primeCodexLocalSkillsCatalog();
  assert.equal(h.count(), 1); h.resolve({ ok: true, result: { skills: [] } });
  assert.deepEqual(plain(await a), []); assert.deepEqual(plain(await b), []);
  assert.deepEqual(plain(h.context.getCodexLocalSkillsCatalog()), []);
});
test('late local catalog cannot populate a different page scope', async () => {
  const h = catalogHarness(), request = h.context.primeCodexLocalSkillsCatalog(); h.changeProject();
  h.resolve({ ok: true, result: { skills: [{ id: 'local-a' }] } });
  await assert.rejects(request, /project changed/); assert.equal(h.context.getCodexLocalSkillsCatalog(), null);
});
test('local catalog failure stays a failure and does not leak raw Native language', async () => {
  const h = catalogHarness(), request = h.context.primeCodexLocalSkillsCatalog();
  h.resolve({ ok: false, error: { message: '原始中文错误' } });
  await assert.rejects(request, /Could not load local Codex skills/); assert.equal(h.context.getCodexLocalSkillsCatalog(), null);
});

test('real submission captures local choices before catalog await and passes explicit invocation', async () => {
  const h = harness(), response = deferred();
  h.context.getSkillLoadingSettings = () => ({ loadCodexLocalSkills: true, loadCodexOverleafSkills: false });
  h.context.state.codexLocalSkillEnabled = { 'local-b': false };
  h.context.getComposerSkillInvocationForRun = () => ({ id: 'local-a', title: 'A', scope: 'codex-local' });
  h.context.primeCodexLocalSkillsCatalog = () => response.promise;
  const run = h.start(); h.context.state.codexLocalSkillEnabled = { 'local-a': false, 'local-b': true };
  response.resolve([{ id: 'local-a', enabled: true }, { id: 'local-b', enabled: true }, { id: 'local-c', enabled: false }]);
  await run;
  assert.deepEqual(h.io.requests[0].enabledCodexLocalSkillIds, ['local-a']);
  assert.deepEqual(h.io.requests[0].skillInvocation, { id: 'local-a', title: 'A', scope: 'codex-local' });
});
for (const skills of [[], [{ id: 'local-a', enabled: false }]]) {
  test('unavailable or disabled explicit local selection retains the composer and prevents dispatch: ' + skills.length, async () => {
    const h = harness();
    h.context.getSkillLoadingSettings = () => ({ loadCodexLocalSkills: true, loadCodexOverleafSkills: false });
    h.context.getComposerSkillInvocationForRun = () => ({ id: 'local-a', title: 'A', scope: 'codex-local' });
    h.context.primeCodexLocalSkillsCatalog = async () => skills;
    await assert.rejects(h.start(), /unavailable or disabled/); await flush();
    assert.equal(h.io.requests.length, 0); assert.equal(h.controls.get('[data-task]').value, 'task from A');
  });
}

test('slash canonical local name remains searchable when its display name has spaces', () => {
  const h = slashHarness();
  h.getCodexLocalSkillsCatalog = () => [{ id: 'local-abcdef', name: 'openai-docs', title: 'OpenAI Docs' }];
  h.getSlashTrigger = () => ({ query: 'openai-docs' });
  h.panel = { querySelector: () => ({}) }; let rendered;
  h.renderSlashMenu = value => { rendered = value; };
  vm.runInContext(extractFunction(runtime, 'updateSlashMenuForTaskInput'), h);
  h.updateSlashMenuForTaskInput();
  assert.equal(rendered.length, 1); assert.equal(rendered[0].skillId, 'local-abcdef');
});

function attachmentController() {
  const context = { window: {}, console, setTimeout, clearTimeout };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/src/content/composerAttachments.js'), 'utf8'), context);
  return context.window.CodexOverleafComposerAttachments.createComposerAttachmentController({ getPanel: () => null });
}
function recoveryHarness() {
  const attachments = attachmentController();
  const large = { name: 'large.txt', mimeType: 'text/plain', size: 2 * 1024 * 1024, kind: 'file', contentBase64: Buffer.alloc(2 * 1024 * 1024, 'a').toString('base64') };
  const input = { value: '' };
  const context = { panel: { querySelector: () => input }, cachedAccountScopeId: 'account', getCurrentProjectId: () => 'project',
    state: { activeSessionId: 'A', task: '' }, composerDraftRevision: 1, composerSkillInvocation: null,
    findSessionById: () => ({ id: 'A' }), composerAttachmentController: attachments,
    getComposerAttachmentsForRun: () => attachments.getAttachmentsForRun(), getComposerSkillInvocationForRun: () => context.composerSkillInvocation,
    selectionContextView: { getRevision: () => 1, capture: () => null, render() {} },
    updateActiveSession: (state, values) => ({ ...state, ...values }), renderComposerSkillInvocation() {}, autosizeTaskTextarea() {},
    syncComposerSendAvailability() {}, saveStateSoon() {} };
  vm.createContext(context); vm.runInContext(extractFunction(runtime, 'restoreRejectedLocalSkillSubmission'), context);
  const checkpoint = { draftRevision: 1, attachmentRevision: attachments.getRevision(), selectionRevision: 1 };
  const submission = { accountScopeId: 'account', projectId: 'project', sessionId: 'A', task: 'Original request',
    attachments: Array.from({ length: 4 }, (_, i) => ({ ...large, name: 'large-' + i + '.txt' })),
    skillInvocation: { id: 'local-a', title: 'A', scope: 'codex-local' }, selectionContext: { path: 'main.tex', text: 'selected' } };
  return { context, input, attachments, checkpoint, submission };
}

test('rejected local-skill submission restores full in-memory attachments beyond durable draft limits', () => {
  const h = recoveryHarness();
  assert.equal(h.context.restoreRejectedLocalSkillSubmission(h.submission, h.checkpoint), true);
  assert.equal(h.input.value, 'Original request'); assert.equal(h.context.composerSkillInvocation.id, 'local-a');
  assert.equal(h.attachments.getAttachmentsForRun().length, 4);
  assert.equal(h.attachments.getAttachmentsForRun()[0].contentBase64, h.submission.attachments[0].contentBase64);
  assert.equal(h.context.state.selectionContext.text, 'selected');
});
for (const field of ['text', 'draftRevision', 'attachmentRevision', 'pendingAttachment', 'selection', 'skill', 'session', 'project']) {
  test('local-skill rejection keeps a later composer change: ' + field, () => {
    const h = recoveryHarness(), c = h.context;
    if (field === 'text') h.input.value = 'Later task';
    if (field === 'draftRevision') c.composerDraftRevision++;
    if (field === 'attachmentRevision') h.attachments.clear();
    if (field === 'pendingAttachment') c.composerAttachmentController = { getAttachmentByteUsage: () => ({ pending: 1 }) };
    if (field === 'selection') c.selectionContextView.getRevision = () => 2;
    if (field === 'skill') c.composerSkillInvocation = { id: 'local-new', scope: 'codex-local' };
    if (field === 'session') c.state.activeSessionId = 'B';
    if (field === 'project') c.getCurrentProjectId = () => 'different';
    assert.equal(c.restoreRejectedLocalSkillSubmission(h.submission, h.checkpoint), false);
    assert.equal(h.attachments.getAttachmentsForRun().length, 0);
    assert.notEqual(h.input.value, 'Original request');
  });
}

for (const laterDraft of [false, true, 'cleared-before-submit']) {
  test('real runTask restores only its unchanged composer after Native local-skill rejection: ' + laterDraft, async () => {
    const h = harness(laterDraft === 'cleared-before-submit' ? 'audit' : ''), response = deferred(), attachments = attachmentController(); let selectionRevision = 0;
    const attachment = { name: 'large-submission.txt', mimeType: 'text/plain', size: 2 * 1024 * 1024,
      kind: 'file', contentBase64: Buffer.alloc(2 * 1024 * 1024, 'b').toString('base64') };
    assert.equal(attachments.restoreSubmittedAttachments([attachment], attachments.getRevision()), true);
    Object.assign(h.context, {
      composerAttachmentController: attachments,
      getComposerAttachmentsForRun: () => attachments.getAttachmentsForRun(),
      getSkillLoadingSettings: () => ({ loadCodexLocalSkills: true, loadCodexOverleafSkills: false }),
      composerSkillInvocation: { id: 'local-a', title: 'A', scope: 'codex-local' },
      getComposerSkillInvocationForRun: () => h.context.composerSkillInvocation,
      primeCodexLocalSkillsCatalog: async () => [{ id: 'local-a', enabled: true }],
      selectionContextView: { capture: () => null, clear: () => { selectionRevision++; }, getRevision: () => selectionRevision, render() {} },
      buildContentFailure: code => ({ code, severity: 'blocked' })
    });
    vm.runInContext(extractFunction(runtime, 'restoreRejectedLocalSkillSubmission'), h.context);
    h.context.nativeChannel.sendNativeTracked = request => {
      h.io.requests.push(plain(request.params)); return { id: 'local-rejection-request', promise: response.promise };
    };
    const run = h.start();
    if (laterDraft === 'cleared-before-submit') {
      await h.barrier.entered;
      h.type(''); h.context.composerSkillInvocation = null; attachments.clear();
      h.barrier.release();
    }
    for (let i = 0; i < 20 && !h.io.requests.length; i++) await flush();
    assert.equal(h.io.requests.length, 1); assert.equal(h.controls.get('[data-task]').value, '');
    assert.equal(attachments.getAttachmentsForRun().length, 0);
    if (laterDraft === true) { h.type('Later task'); h.context.composerDraftRevision++; }
    response.resolve({ ok: false, error: { code: 'codex_local_skill_unavailable', message: 'Selected local Codex skill is unavailable.' } });
    await run;
    assert.equal(h.controls.get('[data-task]').value, laterDraft === true ? 'Later task' : laterDraft === 'cleared-before-submit' ? '' : 'task from A');
    assert.equal(attachments.getAttachmentsForRun().length, laterDraft ? 0 : 1);
    if (!laterDraft) assert.equal(attachments.getAttachmentsForRun()[0].contentBase64, attachment.contentBase64);
  });
}

test('partial local catalog retains valid choices with only a stable skipped count', async () => {
  const h = catalogHarness(), request = h.context.primeCodexLocalSkillsCatalog();
  h.resolve({ ok: true, result: { skills: [{ id: 'local-a' }], discoveryWarnings: [{ code: 'codex_local_skills_skipped', count: 2 }] } });
  assert.deepEqual(plain(await request), [{ id: 'local-a' }]);
  assert.deepEqual(plain(h.context.getCodexLocalSkillWarnings()), [{ code: 'codex_local_skills_skipped', count: 2 }]);
});

test('same-name local skills display their readable source hints', () => {
  const h = panelHarness({ skills: [
    { id: 'local-a', title: 'Same title', sourceKind: 'local', sourceHint: 'skills/personal' },
    { id: 'local-b', title: 'Same title', sourceKind: 'local', sourceHint: 'skills/team' }
  ] });
  h.controller.renderLocalSkillList();
  assert.equal(h.localList.children[0].children[0].children[1].textContent, 'Local Codex · skills/personal');
  assert.equal(h.localList.children[1].children[0].children[1].textContent, 'Local Codex · skills/team');
});

for (const locale of ['en', 'zh']) {
  test('local skill failures and Native events follow ' + locale + ' through real user-facing mappings', () => {
    const Transcript = require('../extension/src/shared/agentTranscript');
    const Reasons = require('../extension/src/shared/failureReasons');
    for (const code of ['codex_local_skill_unavailable', 'codex_local_skills_timeout', 'codex_local_skills_invalid_response']) {
      const result = Transcript.translateRawError('原始错误 / Raw diagnostic', { code, locale });
      assert.equal(result.failureCode, code === 'codex_local_skill_unavailable' ? code : 'codex_local_skills_failed');
      assert.equal(/[\u3400-\u9fff]/.test(result.conclusion), locale === 'zh');
      assert.doesNotMatch(result.conclusion, /原始错误|Raw diagnostic/);
      const failure = Reasons.normalizeFailureReason({ code: result.failureCode });
      const display = Reasons.localizeFailureReason(failure, locale, key => I18n.t(locale, key));
      assert.equal(/[\u3400-\u9fff]/.test(display.userMessage), locale === 'zh');
      assert.equal(/[\u3400-\u9fff]/.test(display.nextAction), locale === 'zh');
    }
    for (const type of ['codex.local_skills.missing', 'codex.local_skill_invocation.ignored']) {
      const event = Transcript.mapAgentEventToActivity({ type, title: 'Raw English title' }, { locale });
      assert.equal(/[\u3400-\u9fff]/.test(event.title), locale === 'zh');
      assert.doesNotMatch(event.title, /Raw English/);
    }
  });
}

test('a rejected Native catalog promise is localized before reaching the settings error', async () => {
  const h = catalogHarness();
  h.context.sendBackgroundNative = async () => { throw new Error('原始中文异常'); };
  await assert.rejects(h.context.primeCodexLocalSkillsCatalog(), /Could not load local Codex skills/);
});

test('local directory still renders if the independent Overleaf directory fails first', async () => {
  const local = node(), overleaf = node(), response = deferred(); let skills = null;
  const controller = createLocalSkillsPanelController({ document: { createElement: node },
    getPanel: () => ({ querySelector: selector => selector === '[data-codex-local-skill-list]' ? local : overleaf }),
    getCodexLocalSkills: () => skills,
    refreshCodexLocalSkills: async () => { skills = await response.promise; },
    sendBackgroundNative: async () => ({ ok: false }), tr: key => I18n.t('en', key) });
  await assert.rejects(controller.refreshLocalSkills(), /Codex Overleaf skills/);
  response.resolve([{ id: 'local-a', title: 'Available local' }]); await flush();
  assert.equal(local.children[0].dataset.scope, 'codex-local');
});
