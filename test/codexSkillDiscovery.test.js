'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { buildCodexHomeEnv } = require('../native-host/src/codexHome');
const { applyCodexSkillIsolation } = require('../native-host/src/codexSkillIsolation');

test('disabled plugin aliases are excluded while same-name local skills and enabled plugin skills remain', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-skill-discovery-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const source = path.join(home, 'source'), root = path.join(home, '.codex-overleaf', 'skills');
  for (const p of [path.join(source, 'skills', 'disabled'), path.join(root, 'disabled'), path.join(root, 'enabled')]) { fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(path.join(p, 'SKILL.md'), 'Synthetic'); }
  // The local disabled symlink gives the provider a second discovery route to
  // exactly the disabled plugin source, while a distinct same-name file stays.
  fs.symlinkSync(path.join(root, 'disabled'), path.join(source, 'skills', 'plugin-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const env = buildCodexHomeEnv({ HOME: home, CODEX_OVERLEAF_USER_CODEX_HOME: source }, { isolateRuntimeHome: true, loadCodexLocalSkills: true, enabledCodexOverleafSkillIds: ['enabled'] });
  assert.equal(fs.existsSync(path.join(env.CODEX_HOME, 'skills', 'enabled', 'SKILL.md')), true);
  const listing = [
    { name: 'disabled', path: path.join(root, 'disabled', 'SKILL.md'), enabled: true },
    { name: 'alias', path: path.join(source, 'skills', 'plugin-alias', 'SKILL.md'), enabled: true },
    { name: 'disabled', path: path.join(source, 'skills', 'disabled', 'SKILL.md'), enabled: true },
    { name: 'enabled', path: path.join(root, 'enabled', 'SKILL.md'), enabled: true }
  ];
  const writes = [];
  await applyCodexSkillIsolation({ input: { loadCodexLocalSkills: true, enabledCodexOverleafSkillIds: ['enabled'] }, childEnv: env,
    request: async (method, params) => method === 'skills/list' ? { data: [{ skills: listing }] } : (writes.push(params), {}) });
  assert.deepEqual(writes.map(x => x.path), listing.slice(0, 2).map(x => x.path));
  assert.ok(writes.every(x => x.enabled === false));
});

test('missing enabled IDs keep compatibility; explicit empty IDs disable every plugin item', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-skill-empty-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const skill = path.join(home, '.codex-overleaf', 'skills', 'synthetic', 'SKILL.md'); fs.mkdirSync(path.dirname(skill), { recursive: true }); fs.writeFileSync(skill, 'Synthetic');
  for (const enabled of [undefined, []]) {
    const writes = [];
    await applyCodexSkillIsolation({ input: { loadCodexLocalSkills: true, enabledCodexOverleafSkillIds: enabled }, childEnv: { HOME: home },
      request: async (method, params) => method === 'skills/list' ? { data: [{ skills: [{ name: 'synthetic', path: skill, enabled: true }] }] } : (writes.push(params), {}) });
    assert.equal(writes.length, enabled ? 1 : 0);
  }
});
