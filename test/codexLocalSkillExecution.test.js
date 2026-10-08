'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildCodexHomeEnv } = require('../native-host/src/codexHome');
const { applyCodexSkillIsolation } = require('../native-host/src/codexSkillIsolation');
const { createCodexLocalSkillIdentity: identity } = require('../native-host/src/codexLocalSkills');
const { runCodexSession, buildCodexSettings } = require('../native-host/src/codexSessionRunner');
const { handleRequest } = require('../native-host/src/taskRunnerRuntime');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-local-execution-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), canonical = path.join(root, 'plugin');
  fs.mkdirSync(source);
  const env = { HOME: root, USERPROFILE: root, PATH: process.env.PATH,
    CODEX_OVERLEAF_USER_CODEX_HOME: source, CODEX_OVERLEAF_CODEX_HOME: canonical };
  const skill = (relative, name, extra = {}) => {
    const file = path.join(root, relative, 'SKILL.md'); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\nname: ${name}\n---\nUse LOCAL_SKILL_EVIDENCE for this task.\n`);
    return { name, path: file, scope: 'user', enabled: true, ...extra };
  };
  return { root, source, canonical, env, skill };
}

test('local allowlist selects by source identity, enables explicit disabled items, and leaves plugin policy separate', async t => {
  const f = fixture(t), one = f.skill('source/skills/one', 'same'), two = f.skill('source/skills/two', 'same', { enabled: false });
  const system = f.skill('generated/skills/.system/helper', 'same', { scope: 'system' });
  const plugin = f.skill('.codex-overleaf/skills/overleaf', 'same');
  const writes = [];
  await applyCodexSkillIsolation({ input: { enabledCodexLocalSkillIds: [identity(two)], enabledCodexOverleafSkillIds: ['overleaf'] }, childEnv: f.env,
    request: async (method, params) => method === 'skills/list' ? { data: [{ skills: [one, two, system, plugin] }] } : (writes.push(params), {}) });
  assert.deepEqual(writes, [{ path: one.path, enabled: false }, { path: two.path, enabled: true }, { path: system.path, enabled: false }]);
  const closed = [];
  await applyCodexSkillIsolation({ input: { enabledCodexLocalSkillIds: [], loadCodexLocalSkills: false }, childEnv: f.env,
    request: async (method, params) => method === 'skills/list' ? { data: [{ skills: [one, system, plugin] }] } : (closed.push(params), {}) });
  assert.deepEqual(closed.map(p => p.path), [one.path, system.path]);
});

test('local selections isolate scope and same-home configuration while preserving linked and same-name sources', t => {
  const f = fixture(t), one = f.skill('source/skills/same', 'same');
  f.skill('.codex-overleaf/skills/same', 'same');
  fs.symlinkSync(path.dirname(one.path), path.join(f.source, 'skills', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(f.source, 'config.toml'), '# unchanged source\n');
  const params = { isolateRuntimeHome: true, enabledCodexLocalSkillIds: [identity(one)] };
  const active = buildCodexHomeEnv(f.env, params), disabled = buildCodexHomeEnv(f.env, { ...params, enabledCodexLocalSkillIds: [] });
  assert.notEqual(active.CODEX_HOME, disabled.CODEX_HOME);
  assert.equal(fs.realpathSync(path.join(active.CODEX_HOME, 'skills', 'linked', 'SKILL.md')), fs.realpathSync(one.path));
  const alias = fs.readdirSync(path.join(active.CODEX_HOME, 'skills')).find(name => name.startsWith('same.codex-local-'));
  assert.ok(alias); assert.equal(fs.realpathSync(path.join(active.CODEX_HOME, 'skills', alias, 'SKILL.md')), fs.realpathSync(one.path));
  assert.equal(fs.readFileSync(path.join(f.source, 'config.toml'), 'utf8'), '# unchanged source\n');
  const shared = buildCodexHomeEnv({ ...f.env, CODEX_OVERLEAF_CODEX_HOME: f.source }, params);
  assert.notEqual(shared.CODEX_HOME, f.source);
  assert.equal(shared.CODEX_OVERLEAF_USER_CODEX_HOME, f.source);
  assert.ok(shared.CODEX_HOME.startsWith(`${f.source}-overleaf-runtime${path.sep}`));
  assert.equal(fs.readFileSync(path.join(f.source, 'config.toml'), 'utf8'), '# unchanged source\n');
  const linkedHome = path.join(f.root, 'source-alias'); fs.symlinkSync(f.source, linkedHome, process.platform === 'win32' ? 'junction' : 'dir');
  assert.notEqual(buildCodexHomeEnv({ ...f.env, CODEX_OVERLEAF_CODEX_HOME: linkedHome }, params).CODEX_HOME, linkedHome);
});

test('worker recursion exclusion disables the plugin source while preserving the same-name chosen local skill', async t => {
  const f = fixture(t), local = f.skill('source/skills/parallel-subagents', 'parallel-subagents');
  const plugin = f.skill('.codex-overleaf/skills/parallel-subagents', 'parallel-subagents');
  const writes = [];
  await applyCodexSkillIsolation({ input: { enabledCodexLocalSkillIds: [identity(local)],
    enabledCodexOverleafSkillIds: ['parallel-subagents'], disableCodexOverleafSkillIds: ['parallel-subagents'] }, childEnv: f.env,
  request: async (method, params) => method === 'skills/list' ? { data: [{ skills: [local, plugin] }] } : (writes.push(params), {}) });
  assert.deepEqual(writes, [{ path: plugin.path, enabled: false }]);
});

test('local isolation rejects malformed discovery before applying any per-skill configuration', async () => {
  const writes = [];
  await assert.rejects(applyCodexSkillIsolation({ input: { enabledCodexLocalSkillIds: [] },
    request: async (method, params) => method === 'skills/list'
      ? { data: [{ skills: [], errors: 'malformed' }] } : (writes.push(params), {}) }),
  { code: 'codex_local_skill_unavailable' });
  assert.deepEqual(writes, []);
});

test('Native catalog dispatch and selected local skill reach the normal runner with resources and selection intact', async t => {
  const f = fixture(t), skill = f.skill('source/skills/local-installer', 'skill-installer');
  const script = path.join(f.root, 'catalog.cjs');
  fs.writeFileSync(script, `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='skills/list'?{data:[{skills:${JSON.stringify([skill])}}]}:{}})+'\\n');});`);
  const command = path.join(f.root, process.platform === 'win32' ? 'catalog.cmd' : 'catalog');
  fs.writeFileSync(command, process.platform === 'win32' ? `@"${process.execPath}" "${script}" %*\r\n`
    : `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`, { mode: 0o755 });
  const env = { ...f.env, CODEX_OVERLEAF_CODEX_PATH: command,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}) };
  const listing = await handleRequest({ id: 'catalog', method: 'skills.list', params: { scope: 'codex-local' } }, env);
  assert.equal(listing.ok, true); assert.equal(listing.result.skills[0].id, identity(skill));
  assert.equal('path' in listing.result.skills[0], false);
  for (const method of ['skills.install', 'skills.remove']) {
    const result = await handleRequest({ id: method, method,
      params: { scope: 'codex-local', projectId: 'local-skill-test', skillId: 'original', content: 'Unrequested' } }, env);
    assert.equal(result.ok, false, 'local catalog is read-only even when a project id is supplied');
  }
  let received;
  const ids = [identity(skill)], invocation = { id: ids[0], title: skill.name, scope: 'codex-local' };
  await runCodexSession({ env, rootDir: path.join(f.root, 'mirrors'), params: {
    projectId: 'local-skill-test', mode: 'ask', task: 'Use the chosen skill.',
    enabledCodexLocalSkillIds: ids, skillInvocation: invocation,
    project: { files: [{ path: 'main.tex', content: 'Source text' }] }
  }, executeCodex: async input => { received = input; return { assistantMessage: 'Observed.', threadId: 'local-skill-thread' }; } });
  assert.deepEqual(received.enabledCodexLocalSkillIds, ids);
  assert.deepEqual(received.skillInvocation, invocation);
  assert.equal(received.sandboxMode, 'read-only'); assert.equal(received.installCodexOverleafSkillsTarget, false);
  assert.match(received.task, /Selected local Codex SKILL\.md:/);
  assert.match(received.task, /LOCAL_SKILL_EVIDENCE/);
  assert.ok(received.task.includes(fs.realpathSync(skill.path)));
  assert.equal(buildCodexSettings({ mode: 'ask', skillInvocation: { id: 'skill-installer', scope: 'codex-local' } }).sandboxMode, 'read-only');
  assert.equal(buildCodexSettings({ mode: 'ask', skillInvocation: { id: 'skill-installer', scope: 'builtin' } }).sandboxMode, 'workspace-write');
  fs.rmSync(skill.path);
  for (const enabled of [ids, []]) {
    let executed = false;
    await assert.rejects(runCodexSession({ env, rootDir: path.join(f.root, 'mirrors'), params: {
      projectId: 'local-skill-test', mode: 'ask', task: 'Use the chosen skill.',
      enabledCodexLocalSkillIds: enabled, skillInvocation: invocation,
      project: { files: [{ path: 'main.tex', content: 'Source text' }] }
    }, executeCodex: async () => { executed = true; } }), { code: 'codex_local_skill_unavailable' });
    assert.equal(executed, false, 'stale explicit selection must not launch an ordinary unskilled run');
  }
  fs.writeFileSync(script, `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id)process.stdout.write(JSON.stringify(m.method==='skills/list'?{id:m.id,error:{message:'synthetic failure'}}:{id:m.id,result:{}})+'\\n');});`);
  await assert.rejects(runCodexSession({ env, rootDir: path.join(f.root, 'mirrors'), params: {
    projectId: 'local-skill-test', mode: 'ask', task: 'Use the chosen skill.',
    enabledCodexLocalSkillIds: ids, skillInvocation: invocation,
    project: { files: [{ path: 'main.tex', content: 'Source text' }] }
  }, executeCodex: async () => { assert.fail('discovery failure must not launch the model'); } }),
  error => error.code === 'codex_local_skill_unavailable' && error.cause?.code === 'codex_local_skills_failed');
});
