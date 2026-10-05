'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');
const { fixture, params, model, scope, Style } = require('./_helpers/writingStyleFixture');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { const end = Date.now() + 5000; while (!fn()) { if (Date.now() > end) throw new Error('Fixture wait timeout'); await wait(10); } }
function child(t, root, mode) {
  const process = spawn(global.process.execPath, [path.join(__dirname, 'fixtures/writing-style-concurrency.cjs'), root, mode], { env: { PATH: global.process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; process.stderr.on('data', x => { stderr += x; }); process.stdout.resume();
  t.after(() => { if (process.exitCode === null) process.kill('SIGTERM'); });
  const done = new Promise((resolve, reject) => process.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || 'child exited ' + code))));
  done.catch(() => {}); // Preserve cleanup if an assertion fails before awaiting the child.
  return { process, done };
}
for (const fault of ['config', 'rename', 'write']) test('initialization cleanup owns its staging and config temp: ' + fault, async t => {
  const h = fixture(t); Style.set({ ...scope, enabled: false }, h.env);
  if (fault === 'config') fs.writeFileSync(h.configPath, '{broken');
  const rename = fs.renameSync, write = fs.writeFileSync; let injected = false, calls = 0;
  if (fault === 'rename') fs.renameSync = function (from, to) { if (!injected && to === h.configPath) { injected = true; throw Object.assign(new Error('synthetic rename failure'), { code: 'EIO' }); } return rename.apply(this, arguments); };
  if (fault === 'write') fs.writeFileSync = function (file, text, options) { if (!injected && (typeof file === 'number' || String(file).startsWith(h.configPath + '.'))) { injected = true; write(file, String(text).slice(0, 20), options); throw Object.assign(new Error('synthetic partial write'), { code: 'ENOSPC' }); } return write.apply(this, arguments); };
  try { await assert.rejects(h.build(params(), input => { calls++; return model(input); })); }
  finally { fs.renameSync = rename; fs.writeFileSync = write; }
  assert.equal(calls, 0);
  assert.deepEqual(fs.readdirSync(h.scopeRoot).filter(x => x.startsWith('.build-') || x.endsWith('.tmp') || x.startsWith('.config-lock')), []);
});
test('failed execution cleans staging while unconfirmed process stop preserves it', async t => {
  const h = fixture(t);
  for (const code of ['synthetic_failed', 'codex_process_stop_unconfirmed']) {
    await assert.rejects(h.build(params(), () => { throw Object.assign(new Error(code), { code }); }), { code });
    const builds = fs.readdirSync(h.scopeRoot).filter(x => x.startsWith('.build-'));
    assert.equal(builds.length, code === 'synthetic_failed' ? 0 : 1);
  }
});
test('disabled corrupt manifest does not block metadata or ordinary capture; enabled and preview reject', async t => {
  const h = fixture(t), built = await h.build();
  const manifest = path.join(h.scopeRoot, 'versions', built.writingStyle.snapshot.version, 'manifest.json');
  fs.chmodSync(manifest, 0o600); fs.writeFileSync(manifest, '{broken');
  const disabled = Style.set({ ...scope, enabled: false }, h.env);
  assert.equal(disabled.enabled, false); assert.equal(disabled.ready, false); assert.equal(disabled.snapshot, null);
  const Controller = require('../extension/src/content/writingStyleSettings');
  const ctl = Controller.create({ tx: en => en, getScope: () => scope,
    request: async ({ method, params }) => { try { return { ok: true, result: Style[method.endsWith('get') ? 'get' : 'set'](params, h.env) }; } catch (error) { return { ok: false, error: { message: error.message } }; } } });
  await ctl.ensureLoaded(true); assert.equal(ctl.capture(), null);
  assert.throws(() => Style.set({ ...scope, enabled: true }, h.env));
  assert.throws(() => Style.get({ ...scope, includePreview: true }, h.env));
  assert.match(Style.forRun(null, scope, h.env), /No project writing-style/);
});
test('publish validates the same asset limits as forRun and keeps an existing consumable version', async t => {
  const h = fixture(t), before = await h.build(), snapshot = before.writingStyle.snapshot;
  assert.match(Style.forRun(snapshot, scope, h.env), /Active project writing skill/);
  await assert.rejects(h.build(params(true)), { code: 'writing_style_changed' });
  assert.equal(h.read().version, snapshot.version);
  assert.deepEqual(fs.readdirSync(path.join(h.scopeRoot, 'versions')), [snapshot.version]);
  assert.match(Style.forRun(snapshot, scope, h.env), /Active project writing skill/);
});
for (const mode of ['model', 'publish']) test('independent process disabling during ' + mode + ' retains the successful preference', async t => {
  const h = fixture(t); await h.build();
  const build = child(t, h.root, mode);
  await until(() => fs.existsSync(path.join(h.root, mode + '.ready')));
  const disable = child(t, h.root, 'disable');
  await until(() => fs.existsSync(path.join(h.root, 'disable.started')));
  if (mode === 'model') await disable.done;
  else { await wait(100); assert.equal(fs.existsSync(path.join(h.root, 'disable.done')), false, 'preference must wait for a publication critical section'); }
  fs.writeFileSync(path.join(h.root, mode + '.release'), 'release');
  await Promise.all([build.done, disable.done]);
  assert.equal(h.read().enabled, false);
  assert.equal(h.read().building, null);
});
test('a cancelled build clears only its initialized state and staging', async t => {
  const h = fixture(t), before = await h.build(), signal = AbortSignal.abort(Object.assign(new Error('cancelled'), { code: 'codex_cancelled' }));
  await assert.rejects(Style.build({ params: params(), env: h.env, signal, execute: async () => assert.fail('cancelled build reached model') }), { code: 'codex_cancelled' });
  assert.equal(h.read().version, before.writingStyle.snapshot.version); assert.equal(h.read().building, null);
  assert.deepEqual(fs.readdirSync(h.scopeRoot).filter(x => x.startsWith('.build-') || x.startsWith('.config-lock')), []);
});
for (const failure of [false, true]) test('superseded old build does not clear the new owner: ' + (failure ? 'failure' : 'success'), async t => {
  const h = fixture(t); let releaseA, releaseB, inputA, inputB;
  const old = h.build(params(), input => { inputA = input; return new Promise(resolve => { releaseA = resolve; }); });
  old.catch(() => {});
  await until(() => releaseA);
  const current = h.build(params(), input => { inputB = input; return new Promise(resolve => { releaseB = resolve; }); });
  await until(() => releaseB); const owner = h.read().building.id;
  releaseA(failure ? { assistantMessage: JSON.stringify({ insufficientEvidence: 'Synthetic evidence is insufficient.' }) } : model(inputA));
  await assert.rejects(old, { code: failure ? 'writing_style_insufficient_evidence' : 'writing_style_build_superseded' });
  assert.equal(h.read().building.id, owner);
  releaseB(model(inputB)); await current; assert.equal(h.read().version, owner); assert.equal(h.read().building, null);
});
test('dead process config lock can be reclaimed without leaving acquisition temp', t => {
  const h = fixture(t); Style.set({ ...scope, enabled: false }, h.env);
  const dead = require('node:child_process').spawnSync(process.execPath, ['-e', ''], { env: { PATH: process.env.PATH } }).pid;
  assert.throws(() => process.kill(dead, 0), { code: 'ESRCH' });
  const lock = path.join(h.scopeRoot, '.config-lock'); fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, dead + '-' + require('node:crypto').randomUUID() + '.owner'), '');
  assert.equal(Style.set({ ...scope, enabled: false }, h.env).enabled, false);
  assert.deepEqual(fs.readdirSync(h.scopeRoot).filter(x => x.startsWith('.config-lock')), []);
});
test('live config lock times out without deleting the owner or own temp leaking', t => {
  const h = fixture(t); Style.set({ ...scope, enabled: false }, h.env);
  const lock = path.join(h.scopeRoot, '.config-lock'), owner = process.pid + '-' + require('node:crypto').randomUUID() + '.owner';
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, owner), '');
  assert.throws(() => Style.set({ ...scope, enabled: false }, h.env), { code: 'writing_style_busy' });
  assert.deepEqual(fs.readdirSync(lock), [owner]);
  assert.deepEqual(fs.readdirSync(h.scopeRoot).filter(x => x.startsWith('.config-lock-')), []);
});
test('temp collisions are never removed as if owned by the current write', t => {
  const h = fixture(t); fs.mkdirSync(h.scopeRoot, { recursive: true });
  const store = require('../native-host/src/writingStyleStore'), crypto = require('node:crypto'), uuid = crypto.randomUUID;
  const id = uuid(), otherTemp = h.configPath + '.' + id + '.tmp';
  fs.writeFileSync(otherTemp, 'other writer'); crypto.randomUUID = () => id;
  try { assert.throws(() => store.writeJson(h.configPath, {}), { code: 'EEXIST' }); }
  finally { crypto.randomUUID = uuid; }
  assert.equal(fs.readFileSync(otherTemp, 'utf8'), 'other writer');
});
test('permission failure renaming an unowned lock target returns without spinning', async t => {
  const h = fixture(t), denied = child(t, h.root, 'lock-rename-denied');
  let timer;
  try {
    await Promise.race([denied.done, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Lock rename fault hung the Native process')), 2500); })]);
  } finally { clearTimeout(timer); }
  assert.deepEqual(fs.readdirSync(h.scopeRoot).filter(x => x.startsWith('.config-lock')), []);
});
