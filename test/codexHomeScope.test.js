'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');
const { buildCodexHomeEnv, clearPluginCodexHistory } = require('../native-host/src/codexHome');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-scope-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const source = path.join(home, 'source'), canonical = path.join(home, 'canonical'), skills = path.join(home, '.codex-overleaf', 'skills');
  fs.mkdirSync(source); fs.mkdirSync(canonical); fs.mkdirSync(skills, { recursive: true });
  for (const id of ['alpha', 'beta']) { fs.mkdirSync(path.join(skills, id)); fs.writeFileSync(path.join(skills, id, 'SKILL.md'), '# ' + id); }
  const env = { HOME: home, CODEX_OVERLEAF_USER_CODEX_HOME: source, CODEX_OVERLEAF_CODEX_HOME: canonical };
  const prepare = options => buildCodexHomeEnv(env, { isolateRuntimeHome: true, loadCodexLocalSkills: false, ...options });
  return { home, source, canonical, skills, env, prepare };
}

test('different skill scopes preserve active paths and the installer persistent target', t => {
  const f = fixture(t);
  const active = f.prepare({ enabledCodexOverleafSkillIds: ['alpha'] });
  const skill = path.join(active.CODEX_HOME, 'skills', 'alpha', 'SKILL.md');
  assert.equal(fs.readFileSync(skill, 'utf8'), '# alpha');
  const disabled = f.prepare({ loadCodexOverleafSkills: false });
  assert.notEqual(disabled.CODEX_HOME, active.CODEX_HOME);
  assert.equal(fs.readFileSync(skill, 'utf8'), '# alpha');
  assert.equal(fs.existsSync(path.join(active.CODEX_HOME, 'skills', 'beta')), false);
  const installer = f.prepare({ installCodexOverleafSkillsTarget: true });
  f.prepare({ enabledCodexOverleafSkillIds: [] });
  const installed = path.join(installer.CODEX_HOME, 'skills', 'late-installed');
  fs.mkdirSync(installed); fs.writeFileSync(path.join(installed, 'SKILL.md'), '# persistent');
  assert.equal(fs.readFileSync(path.join(f.skills, 'late-installed', 'SKILL.md'), 'utf8'), '# persistent');
  f.prepare({ enabledCodexOverleafSkillIds: ['alpha', 'late-installed'] });
  assert.equal(fs.readFileSync(skill, 'utf8'), '# alpha');
  assert.equal(fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8'), '# persistent');
});

test('scope identity is ordered, reusable, and workers retain the canonical base', t => {
  const f = fixture(t);
  const a = f.prepare({ enabledCodexOverleafSkillIds: ['beta', 'alpha', 'alpha'] });
  const sentinel = path.join(a.CODEX_HOME, 'skills', 'keep-inode'); fs.writeFileSync(sentinel, 'unchanged');
  const b = f.prepare({ enabledCodexOverleafSkillIds: ['alpha', 'beta'] });
  assert.equal(a.CODEX_HOME, b.CODEX_HOME); assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
  const worker = buildCodexHomeEnv(a, { isolateRuntimeHome: true, enabledCodexOverleafSkillIds: ['alpha', 'beta'], disableCodexOverleafSkillIds: ['alpha'], loadCodexLocalSkills: false });
  assert.equal(worker.CODEX_OVERLEAF_CODEX_HOME, f.canonical);
  assert.equal(path.dirname(worker.CODEX_HOME), path.dirname(a.CODEX_HOME));
  assert.equal(fs.existsSync(path.join(worker.CODEX_HOME, 'skills', 'alpha')), false);
});

test('scopes share only plugin history and preserve explicit sqlite configuration', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, 'config.toml'), 'sqlite_home="../selected-synthetic-db"\nmodel="synthetic"\n');
  fs.mkdirSync(path.join(f.source, 'sessions')); fs.writeFileSync(path.join(f.source, 'sessions', 'user'), 'KEEP');
  const a = f.prepare({ enabledCodexOverleafSkillIds: ['alpha'] });
  const b = f.prepare({ enabledCodexOverleafSkillIds: ['beta'] });
  assert.equal(a.CODEX_SQLITE_HOME, f.canonical);
  assert.ok(fs.readFileSync(path.join(a.CODEX_HOME, 'config.toml'), 'utf8').includes(JSON.stringify(path.resolve(f.canonical, '../selected-synthetic-db'))));
  fs.writeFileSync(path.join(a.CODEX_HOME, 'sessions', 'thread.jsonl'), 'SYNTHETIC_HISTORY');
  assert.equal(fs.readFileSync(path.join(b.CODEX_HOME, 'sessions', 'thread.jsonl'), 'utf8'), 'SYNTHETIC_HISTORY');
  clearPluginCodexHistory({ scope: 'all' }, a);
  assert.equal(fs.existsSync(path.join(b.CODEX_HOME, 'sessions', 'thread.jsonl')), false);
  assert.equal(fs.readFileSync(path.join(f.source, 'sessions', 'user'), 'utf8'), 'KEEP');
});

test('auth sync reaches reused scopes without erasing unattributed canonical auth', t => {
  const f = fixture(t); const auth = path.join(f.source, 'auth.json');
  fs.writeFileSync(auth, '{"OPENAI_API_KEY":"SYNTHETIC_A"}');
  const a = f.prepare({ enabledCodexOverleafSkillIds: ['alpha'] });
  assert.equal(fs.readFileSync(path.join(a.CODEX_HOME, 'auth.json'), 'utf8'), fs.readFileSync(auth, 'utf8'));
  fs.rmSync(auth); f.prepare({ enabledCodexOverleafSkillIds: ['alpha'] });
  assert.equal(fs.existsSync(path.join(a.CODEX_HOME, 'auth.json')), false);
  fs.writeFileSync(path.join(f.canonical, 'auth.json'), '{"OPENAI_API_KEY":"SYNTHETIC_INDEPENDENT"}');
  const b = f.prepare({ enabledCodexOverleafSkillIds: ['beta'] });
  assert.equal(fs.readFileSync(path.join(b.CODEX_HOME, 'auth.json'), 'utf8'), '{"OPENAI_API_KEY":"SYNTHETIC_INDEPENDENT"}');
});

test('explicit same-home bypasses scope and preserves its sqlite setting', t => {
  const f = fixture(t); const content = 'sqlite_home="synthetic-independent"\n'; fs.writeFileSync(path.join(f.source, 'config.toml'), content);
  const env = buildCodexHomeEnv({ ...f.env, CODEX_OVERLEAF_CODEX_HOME: f.source }, { isolateRuntimeHome: true, enabledCodexOverleafSkillIds: [] });
  assert.equal(env.CODEX_HOME, f.source); assert.equal(fs.readFileSync(path.join(f.source, 'config.toml'), 'utf8'), content);
});

test('source deletion during scope publication removes the new known inherited copy', t => {
  const f = fixture(t), auth = path.join(f.source, 'auth.json');
  fs.writeFileSync(auth, '{"OPENAI_API_KEY":"SYNTHETIC_A"}');
  const rename = fs.renameSync; let removed = false;
  fs.renameSync = function(source, target) {
    const result = rename.apply(this, arguments);
    if (path.basename(String(source)).startsWith('.prepare-') && !removed) { fs.rmSync(auth); removed = true; }
    return result;
  };
  let scope;
  try { scope = f.prepare({ enabledCodexOverleafSkillIds: ['alpha'] }); } finally { fs.renameSync = rename; }
  assert.equal(removed, true);
  assert.equal(fs.existsSync(path.join(f.canonical, 'auth.json')), false);
  assert.equal(fs.existsSync(path.join(scope.CODEX_HOME, 'auth.json')), false);
  const same = f.prepare({ enabledCodexOverleafSkillIds: ['alpha'] });
  assert.equal(same.CODEX_HOME, scope.CODEX_HOME);
  assert.equal(fs.existsSync(path.join(same.CODEX_HOME, 'auth.json')), false);
});

test('existing canonical home retains the original private permissions contract', t => {
  const f = fixture(t); fs.chmodSync(f.canonical, 0o755); f.prepare({});
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.canonical).mode & 0o777, 0o700);
});

for (const change of ['replace', 'remove', 'create-after-missing', 'create-after-empty']) {
  test('scope identity and published config use one captured source snapshot: ' + change, t => {
    const f = fixture(t), file = path.join(f.source, 'config.toml');
    const initial = change.startsWith('create-') ? '' : 'model="captured-A"\n';
    if (change !== 'create-after-missing') fs.writeFileSync(file, initial);
    const read = fs.readFileSync; let changed = false;
    fs.readFileSync = function(current) {
      if (String(current) !== file || changed) return read.apply(this, arguments);
      try { return read.apply(this, arguments); }
      finally { changed = true; if (change === 'remove') fs.rmSync(file); else fs.writeFileSync(file, 'model="later-B"\n'); }
    };
    let first;
    try { first = f.prepare({ enabledCodexOverleafSkillIds: [] }); } finally { fs.readFileSync = read; }
    assert.equal(changed, true);
    assert.equal(fs.readFileSync(path.join(first.CODEX_HOME, 'config.toml'), 'utf8'), initial);
    fs.writeFileSync(file, initial);
    const next = f.prepare({ enabledCodexOverleafSkillIds: [] });
    assert.equal(next.CODEX_HOME, first.CODEX_HOME);
    assert.equal(fs.readFileSync(path.join(next.CODEX_HOME, 'config.toml'), 'utf8'), initial);
  });
}

test('concurrent processes publish one complete scope without rebuilding the winner', async t => {
  const f = fixture(t);
  const modulePath = require.resolve('../native-host/src/codexHome');
  const script = `const fs=require('node:fs'),path=require('node:path');const {buildCodexHomeEnv}=require(${JSON.stringify(modulePath)});const env=buildCodexHomeEnv(JSON.parse(process.argv[1]),{isolateRuntimeHome:true,loadCodexLocalSkills:false,enabledCodexOverleafSkillIds:['alpha']});process.stdout.write(JSON.stringify({home:env.CODEX_HOME,skill:fs.readFileSync(path.join(env.CODEX_HOME,'skills','alpha','SKILL.md'),'utf8'),config:fs.readFileSync(path.join(env.CODEX_HOME,'config.toml'),'utf8')}));`;
  const output = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, JSON.stringify(f.env)], { env: { HOME: f.home, PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('close', code => code ? reject(new Error(stderr)) : resolve(JSON.parse(stdout)));
  })));
  assert.equal(new Set(output.map(x => x.home)).size, 1);
  assert.ok(output.every(x => x.skill === '# alpha'));
  assert.deepEqual(fs.readdirSync(path.join(f.canonical, 'runtime-homes')), [path.basename(output[0].home)]);
});
