'use strict';
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractFunction } = require('./_helpers/extractFunction');
const { createLocalSkillsPanelController } = require('../extension/src/content/localSkillsPanel');
const runtime = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
function composer(value) {
  const chip = { hidden: false, querySelector: () => ({ setAttribute() {} }) };
  const panel = { querySelector: s => s === '[data-composer-skill-context]' ? chip : { focus() {} } };
  const api = Function('panel', 'initial', `let composerSkillInvocation = initial; const tr = k => k;\n` +
    ['isSafeSkillId', 'normalizeComposerSkillInvocation', 'getComposerSkillInvocationForRun', 'renderComposerSkillInvocation', 'clearComposerSkillInvocation']
      .map(n => extractFunction(runtime, n)).join('\n') +
    '\nreturn {normalizeComposerSkillInvocation, clearComposerSkillInvocation, get:()=>composerSkillInvocation, set:v=>{composerSkillInvocation=v;}, renderComposerSkillInvocation};')(panel, value);
  api.renderComposerSkillInvocation(); return { api, chip };
}
for (const [label, value, cleared] of [
  ['matching production shape', { id: 'sample', title: 'Sample', scope: 'codex-overleaf' }, true],
  ['different skill', { id: 'other', title: 'Other', scope: 'codex-overleaf' }, false],
  ['installer', { id: 'skill-installer', title: 'Installer' }, false]
]) {
  test(`090 successful removal updates only ${label}`, async () => {
    const c = composer(value); const calls = [];
    const controller = createLocalSkillsPanelController({
      ...c.api, getComposerSkillInvocation: c.api.get,
      sendBackgroundNative: async req => { calls.push(req); return { ok: true, result: { skills: [] } }; }
    });
    await controller.removeCodexOverleafSkill('sample');
    assert.equal(c.api.get() === null, cleared);
    assert.equal(c.chip.hidden, cleared);
    assert.deepEqual(calls.map(c=>c.method), ['skills.remove', 'skills.list']);
  });
}

test('090 failed deletion preserves the selected skill and chip', async () => {
  const c = composer({ id: 'sample', scope: 'codex-overleaf' });
  const controller = createLocalSkillsPanelController({ ...c.api, getComposerSkillInvocation: c.api.get,
    sendBackgroundNative: async () => ({ ok: false, error: { message: 'Synthetic deletion failure' } }) });
  await assert.rejects(controller.removeCodexOverleafSkill('sample'), /Synthetic deletion failure/);
  assert.equal(c.api.get().id, 'sample'); assert.equal(c.chip.hidden, false);
});

test('090 later composer selection is retained during asynchronous deletion', async () => {
  const c = composer({ id: 'sample', scope: 'codex-overleaf' }); let release;
  const controller = createLocalSkillsPanelController({ ...c.api, getComposerSkillInvocation: c.api.get,
    sendBackgroundNative: req => req.method === 'skills.remove' ? new Promise(r=>{release=r;}) : Promise.resolve({ok:true,result:{skills:[]}}) });
  const pending = controller.removeCodexOverleafSkill('sample');
  c.api.set({ id: 'other', scope: 'codex-overleaf' }); release({ok:true}); await pending;
  assert.equal(c.api.get().id, 'other'); assert.equal(c.chip.hidden, false);
});

test('090 real skill removal/list and composer rendering agree after deletion', async t => {
  const os = require('node:os');
  const Skills = require('../native-host/src/localSkills');
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'removed-skill-ui-'));
  const env = { HOME: testHome, USERPROFILE: testHome };
  const skillsRoot = path.join(testHome, '.codex-overleaf', 'skills');
  t.after(() => fs.rmSync(testHome, { recursive: true, force: true }));
  const skill = Skills.installCodexOverleafSkill({ skillId: 'sample', content: '# Sample\nSynthetic test skill.\n', env, skillsRoot });
  const c = composer(skill); let state = { codexOverleafSkills: [skill] };
  const controller = createLocalSkillsPanelController({ ...c.api, getComposerSkillInvocation: c.api.get,
    getState: () => state, setState: next => { state = next; },
    sendBackgroundNative: async req => ({ ok: true, result: req.method === 'skills.remove'
      ? Skills.removeCodexOverleafSkill({ skillId: req.params.id, env, skillsRoot })
      : Skills.listCodexOverleafSkills({ env, skillsRoot }) }) });
  await controller.removeCodexOverleafSkill('sample');
  assert.equal(c.api.get(), null); assert.equal(c.chip.hidden, true);
  assert.equal(state.codexOverleafSkills.length, 0);
  assert.equal(fs.existsSync(path.join(skillsRoot, 'sample')), false);
  assert.deepEqual(Skills.loadSelectedCodexOverleafSkill({ skillId: 'sample', env, skillsRoot }).missing, ['sample']);
});
