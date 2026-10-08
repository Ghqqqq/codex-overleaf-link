'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createCodexLocalSkillIdentity: identity, isCodexOverleafSkillSource,
  listCodexLocalSkills, loadSelectedCodexLocalSkill } = require('../native-host/src/codexLocalSkills');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-local-skills-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), plugin = path.join(root, 'plugin');
  fs.mkdirSync(source);
  const script = path.join(root, 'server.cjs'), log = path.join(root, 'calls.jsonl');
  fs.writeFileSync(script, `const fs = require('node:fs'), readline = require('node:readline');
const log = entry => fs.appendFileSync(process.env.LOCAL_SKILLS_LOG, JSON.stringify(entry) + '\\n');
log({pid:process.pid,home:process.env.CODEX_HOME,cwd:process.cwd()});
process.on('SIGTERM', () => { if (process.env.LOCAL_SKILLS_MODE !== 'ignore-stop') process.exit(0); });
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const message = JSON.parse(line); log(message);
 if (message.method === 'initialize') send({id:message.id,result:{}});
 else if (message.method === 'skills/list') {
  const mode = process.env.LOCAL_SKILLS_MODE;
  if (mode === 'hang' || mode === 'ignore-stop') return;
  if (mode === 'exit') process.exit(7);
  if (mode === 'error') { process.stderr.write('SYNTHETIC_PRIVATE_CONFIG'); send({id:message.id,error:{message:'SYNTHETIC_PRIVATE_CONFIG'}}); return; }
  if (mode === 'overflow') { process.stdout.write('x'.repeat(5*1024*1024)); return; }
  if (mode === 'malformed') { send({id:message.id,result:{unexpected:[]}}); return; }
  send({id:message.id,result:JSON.parse(fs.readFileSync(process.env.LOCAL_SKILLS_LIST,'utf8'))});
 }
});\n`);
  const command = path.join(root, process.platform === 'win32' ? 'synthetic.cmd' : 'synthetic-codex');
  fs.writeFileSync(command, process.platform === 'win32'
    ? `@"${process.execPath}" "${script}" %*\r\n`
    : `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`, { mode: 0o755 });
  const listFile = path.join(root, 'list.json');
  const env = { HOME: root, USERPROFILE: root, TMPDIR: root, PATH: process.env.PATH,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}),
    CODEX_OVERLEAF_USER_CODEX_HOME: source, CODEX_OVERLEAF_CODEX_HOME: plugin,
    CODEX_OVERLEAF_CODEX_PATH: command, CODEX_OVERLEAF_ENV_READY: '1',
    LOCAL_SKILLS_LOG: log, LOCAL_SKILLS_LIST: listFile };
  const skill = (relative, name, extra = {}, content = `---\nname: ${name}\n---\nBody ${name}\n`) => {
    const location = path.join(root, relative, 'SKILL.md');
    fs.mkdirSync(path.dirname(location), { recursive: true }); fs.writeFileSync(location, content);
    return { name, path: location, scope: 'user', enabled: true, description: `Description ${name}`, ...extra };
  };
  const listing = (skills, errors = []) => fs.writeFileSync(listFile, JSON.stringify({ data: [{ skills, errors }] }));
  listing([]);
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { root, source, plugin, env, skill, listing, calls };
}

test('physical skill IDs deduplicate aliases and distinguish same names; generated system IDs remain stable', t => {
  const f = fixture(t), a = f.skill('source/skills/a', 'same'), b = f.skill('source/skills/b', 'same');
  const alias = path.join(f.source, 'skills', 'alias');
  fs.symlinkSync(path.dirname(a.path), alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(identity(a), /^local-[a-f0-9]{64}$/);
  assert.notEqual(identity(a), identity(b));
  assert.equal(identity(a), identity({ ...a, path: path.join(alias, 'SKILL.md') }));
  assert.equal(identity({ name: 'builtin', scope: 'system', path: '/scope-one/SKILL.md' }), identity({ name: 'builtin', scope: 'system', path: '/scope-two/SKILL.md' }));
  assert.notEqual(identity(a), identity({ ...a, scope: 'system' }));
  assert.equal(identity({ name: 'invalid', path: '../../secret' }), '');
});

test('real metadata subprocess requests only discovery and returns safe native catalog metadata', async t => {
  const f = fixture(t);
  const regular = f.skill('source/skills/directory-name', 'frontmatter-name', { interface: { displayName: 'Display Name', shortDescription: 'Short preview' } });
  const nested = f.skill('source/skills/container/nested', 'nested', { enabled: false });
  const system = f.skill('scope-one/skills/.system/builtin', 'builtin', { scope: 'system' });
  const plugin = f.skill('source/plugins/cache/example/1.0/skills/example', 'plugin-name', { pluginId: 'example@test' });
  const duplicateName = f.skill('another-root/duplicate', regular.name);
  const overleaf = f.skill('.codex-overleaf/skills/owned', 'owned');
  const alias = path.join(f.source, 'skills', 'alias');
  fs.symlinkSync(path.dirname(regular.path), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const overleafAlias = path.join(f.source, 'skills', 'owned-alias');
  fs.symlinkSync(path.dirname(overleaf.path), overleafAlias, process.platform === 'win32' ? 'junction' : 'dir');
  f.listing([regular, nested, system, plugin, duplicateName, overleaf,
    { ...regular, path: path.join(alias, 'SKILL.md') }, { ...overleaf, path: path.join(overleafAlias, 'SKILL.md') }]);
  fs.writeFileSync(path.join(f.source, 'config.toml'), '# SYNTHETIC_SOURCE_CONFIG\nmodel = "synthetic"\n');
  const before = fs.readFileSync(path.join(f.source, 'config.toml'));
  const { skills, discoveryWarnings } = await listCodexLocalSkills({ env: f.env });
  assert.deepEqual(discoveryWarnings, []);
  assert.equal(skills.length, 5);
  assert.equal(skills.find(s => s.id === identity(regular)).title, 'Display Name');
  assert.equal(skills.find(s => s.name === 'nested').enabled, false);
  assert.equal(skills.find(s => s.name === 'plugin-name').sourceLabel, 'example@test');
  assert.equal(skills.find(s => s.name === 'builtin').sourceKind, 'system');
  assert.ok(skills.every(s => s.scope === 'codex-local' && s.removable === false && !('path' in s) && !('content' in s)));
  assert.equal(JSON.stringify(skills).includes(f.root), false);
  const calls = f.calls(), launch = calls[0];
  assert.notEqual(launch.home, f.source);
  assert.equal(fs.realpathSync(launch.cwd), fs.realpathSync(launch.home));
  assert.deepEqual(calls.filter(c => c.method).map(c => c.method), ['initialize', 'initialized', 'skills/list']);
  assert.deepEqual(calls.find(c => c.method === 'skills/list').params, { cwd: launch.home, cwds: [launch.home], forceReload: true, includeDisabled: true });
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'config.toml')), before);
  assert.equal(alive(launch.pid), false);
  assert.equal(isCodexOverleafSkillSource({ ...overleaf, path: path.join(overleafAlias, 'SKILL.md') }, f.env), true);
});

test('explicit invocation validates selection against freshly discovered identity and permits opt-in disabled sources', async t => {
  const f = fixture(t), normal = f.skill('source/skills/normal', 'normal'), disabled = f.skill('source/skills/disabled', 'disabled', { enabled: false });
  f.listing([normal, disabled]);
  let result = await loadSelectedCodexLocalSkill({ env: f.env, skillId: identity(normal) });
  assert.equal(result.skill.name, normal.name);
  assert.equal(result.skill.path, fs.realpathSync(normal.path));
  assert.match(result.skill.content, /Body normal/);
  result = await loadSelectedCodexLocalSkill({ env: f.env, skillId: identity(disabled) });
  assert.equal(result.skill, null); assert.equal(result.ignored[0].reason, 'codex_local_skill_disabled');
  result = await loadSelectedCodexLocalSkill({ env: f.env, skillId: identity(disabled), enabledCodexLocalSkillIds: [identity(disabled)] });
  assert.equal(result.skill.name, 'disabled');
  const before = f.calls().length;
  for (const options of [{ loadCodexLocalSkills: false }, { enabledCodexLocalSkillIds: [] }]) {
    result = await loadSelectedCodexLocalSkill({ env: f.env, skillId: identity(normal), ...options });
    assert.equal(result.skill, null); assert.equal(result.ignored.length, 1);
  }
  assert.equal(f.calls().length, before, 'closed settings do not start app-server');
  const removedId = identity(normal); f.listing([disabled]);
  result = await loadSelectedCodexLocalSkill({ env: f.env, skillId: removedId });
  assert.deepEqual(result.missing, [removedId]);
});

test('duplicate source metadata receives real relative directory hints after physical alias deduplication', async t => {
  const f = fixture(t), display = { interface: { displayName: 'Same Display Name' } };
  const first = f.skill('source/skills/group-a/shared', 'same-source-name', display);
  const second = f.skill('source/skills/group-b/shared', 'same-source-name', display);
  const unique = f.skill('source/skills/unique', 'unique');
  const alias = path.join(f.source, 'skills', 'same-alias');
  fs.symlinkSync(path.dirname(first.path), alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.listing([first, second, unique, { ...first, path: path.join(alias, 'SKILL.md') }]);
  const catalog = await listCodexLocalSkills({ env: f.env });
  assert.equal(catalog.skills.length, 3);
  assert.equal(catalog.skills.find(skill => skill.id === identity(first)).sourceHint, 'skills/group-a/shared');
  assert.equal(catalog.skills.find(skill => skill.id === identity(second)).sourceHint, 'skills/group-b/shared');
  assert.equal(catalog.skills.find(skill => skill.name === 'unique').sourceHint, undefined);
  assert.equal(JSON.stringify(catalog).includes(f.root), false);
  assert.ok(catalog.skills.filter(skill => skill.name === first.name).every(skill => skill.title === 'Same Display Name'));
});

test('same-name plugin versions and generated system skills expose readable source hints without absolute homes', async t => {
  const f = fixture(t);
  const first = f.skill('source/plugins/cache/example/1.0/skills/shared', 'shared');
  const second = f.skill('source/plugins/cache/example/2.0/skills/shared', 'shared');
  const system = f.skill('generated/skills/.system/shared', 'shared', { scope: 'system' });
  f.listing([first, second, system]);
  const { skills } = await listCodexLocalSkills({ env: f.env });
  assert.deepEqual(skills.map(skill => skill.sourceHint).sort(), ['.system/shared', 'plugins/example/1.0/skills/shared', 'plugins/example/2.0/skills/shared']);
  assert.equal(JSON.stringify(skills).includes(f.root), false);
});

test('plugin origin is recognized from returned user-scope files under a symlinked source plugins root', async t => {
  const f = fixture(t);
  const prefixed = f.skill('plugin-store/cache/tables/1.0/skills/tables', 'tables:build');
  const plain = f.skill('plugin-store/cache/example/1.0/skills/example', 'plain-name');
  const user = f.skill('source/skills/ordinary', 'ordinary');
  fs.symlinkSync(path.join(f.root, 'plugin-store'), path.join(f.source, 'plugins'), process.platform === 'win32' ? 'junction' : 'dir');
  f.listing([prefixed, plain, user]);
  const { skills } = await listCodexLocalSkills({ env: f.env });
  assert.equal(skills.find(skill => skill.name === prefixed.name).sourceKind, 'plugin');
  assert.equal(skills.find(skill => skill.name === prefixed.name).sourceLabel, 'tables');
  assert.equal(skills.find(skill => skill.name === plain.name).sourceKind, 'plugin');
  assert.equal(skills.find(skill => skill.name === plain.name).sourceLabel, '');
  assert.equal(skills.find(skill => skill.name === user.name).sourceKind, 'user');
  assert.equal(JSON.stringify(skills).includes(f.root), false);
});

test('catalog discovery isolates an explicitly shared user and plugin home without changing source configuration', async t => {
  const f = fixture(t), item = f.skill('source/skills/normal', 'normal');
  const config = '# Source configuration remains owned by the user.\nmodel = "synthetic"\n';
  fs.writeFileSync(path.join(f.source, 'config.toml'), config);
  f.listing([item]);
  const before = fs.readdirSync(f.source).sort();
  const { skills } = await listCodexLocalSkills({ env: { ...f.env, CODEX_OVERLEAF_CODEX_HOME: f.source } });
  assert.equal(skills.length, 1);
  assert.ok(f.calls()[0].home.startsWith(f.source + '-overleaf-runtime' + path.sep));
  assert.deepEqual(fs.readdirSync(f.source).sort(), before);
  assert.equal(fs.readFileSync(path.join(f.source, 'config.toml'), 'utf8'), config);
});

test('invocation accepts empty text and rejects oversized, binary, and invalid UTF-8 skills', async t => {
  const f = fixture(t);
  for (const [name, bytes, valid] of [['empty', '', true], ['oversize', 'x'.repeat(65537), false], ['binary', Buffer.from([0]), false], ['invalid-utf8', Buffer.from([0xc3, 0x28]), false]]) {
    const item = f.skill(`source/skills/${name}`, name, {}, bytes); f.listing([item]);
    const result = await loadSelectedCodexLocalSkill({ env: f.env, skillId: identity(item) });
    assert.equal(Boolean(result.skill), valid, name);
    if (valid) assert.equal(result.skill.content, '');
    else assert.deepEqual(result.missing, [identity(item)]);
  }
});

for (const hasSkills of [false, true]) {
  test(`catalog with ${hasSkills ? 'some' : 'no'} valid skills preserves availability and reports safe skipped counts`, async t => {
    const f = fixture(t), item = f.skill('source/skills/normal', 'normal');
    f.listing(hasSkills ? [item] : [], [{ path: path.join(f.source, 'private-skill'), message: 'SYNTHETIC_PRIVATE_DISCOVERY_ERROR' }]);
    const result = await listCodexLocalSkills({ env: f.env });
    assert.equal(result.skills.length, hasSkills ? 1 : 0);
    assert.deepEqual(result.discoveryWarnings, [{ code: 'codex_local_skills_skipped', count: 1 }]);
    assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE_DISCOVERY_ERROR'), false);
    assert.equal(JSON.stringify(result).includes(f.source), false);
    const selected = await loadSelectedCodexLocalSkill({ env: f.env, skillId: identity(item) });
    if (hasSkills) assert.equal(selected.skill.id, identity(item));
    else assert.deepEqual(selected.missing, [identity(item)]);
    assert.ok(f.calls().filter(call => call.pid).every(call => !alive(call.pid)));
    assert.equal(f.calls().some(call => call.method === 'skills/config/write'), false);
  });
}

test('catalog sums warnings across discovery groups and selected missing IDs remain unavailable', async t => {
  const f = fixture(t), item = f.skill('source/skills/normal', 'normal');
  fs.writeFileSync(f.env.LOCAL_SKILLS_LIST, JSON.stringify({ data: [
    { skills: [item], errors: [{ message: 'first-private-error' }] },
    { skills: [], errors: [{ message: 'second-private-error' }, { message: 'third-private-error' }] }
  ] }));
  const result = await listCodexLocalSkills({ env: f.env });
  assert.equal(result.skills.length, 1);
  assert.deepEqual(result.discoveryWarnings, [{ code: 'codex_local_skills_skipped', count: 3 }]);
  const missingId = 'local-' + '0'.repeat(64);
  const selected = await loadSelectedCodexLocalSkill({ env: f.env, skillId: missingId });
  assert.deepEqual(selected, { skill: null, missing: [missingId], ignored: [] });
});

test('malformed catalog skills and errors fields still reject discovery', async t => {
  const f = fixture(t);
  for (const [skills, errors] of [[{}, []], [[], {}]]) {
    f.listing(skills, errors);
    await assert.rejects(listCodexLocalSkills({ env: f.env }), { code: 'codex_local_skills_invalid_response' });
  }
});

for (const [mode, code] of [['error', 'codex_local_skills_failed'], ['exit', 'codex_local_skills_failed'], ['malformed', 'codex_local_skills_invalid_response'], ['overflow', 'codex_local_skills_output_limit'], ['ignore-stop', 'codex_local_skills_timeout']]) {
  test(`metadata ${mode} fails without leaking diagnostics and confirms child exit`, async t => {
    const f = fixture(t);
    await assert.rejects(listCodexLocalSkills({ env: { ...f.env, LOCAL_SKILLS_MODE: mode }, timeoutMs: mode === 'ignore-stop' ? 1500 : 3000 }), error => {
      assert.equal(error.code, code); assert.equal(error.message.includes('SYNTHETIC_PRIVATE_CONFIG'), false); return true;
    });
    const pid = f.calls()[0]?.pid;
    assert.ok(pid); assert.equal(alive(pid), false);
  });
}

test('cancellation stops the owned metadata process and already cancelled requests do not spawn', async t => {
  const f = fixture(t), controller = new AbortController();
  const pending = listCodexLocalSkills({ env: { ...f.env, LOCAL_SKILLS_MODE: 'hang' }, signal: controller.signal });
  const deadline = Date.now() + 3000;
  while (!f.calls().some(c => c.method === 'skills/list')) { assert.ok(Date.now() < deadline); await delay(10); }
  const reason = Object.assign(new Error('cancelled fixture'), { code: 'fixture_cancelled' });
  controller.abort(reason);
  await assert.rejects(pending, { code: 'fixture_cancelled' });
  assert.equal(alive(f.calls()[0].pid), false);
  const before = f.calls().length;
  await assert.rejects(listCodexLocalSkills({ env: f.env, signal: controller.signal }), { code: 'fixture_cancelled' });
  assert.equal(f.calls().length, before);
});

test('an unavailable Codex executable yields a bounded error', async t => {
  const f = fixture(t);
  await assert.rejects(listCodexLocalSkills({ env: { ...f.env, CODEX_OVERLEAF_CODEX_PATH: path.join(f.root, 'missing-executable') } }), { code: 'codex_not_found' });
  assert.equal(f.calls().length, 0);
});

function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
