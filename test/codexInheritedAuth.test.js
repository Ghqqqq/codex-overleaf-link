'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { preparePluginCodexHome } = require('../native-host/src/codexHome');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-inherited-auth-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const source = path.join(home, 'source'), plugin = path.join(home, 'plugin');
  fs.mkdirSync(source); fs.mkdirSync(plugin);
  const env = { HOME: home, CODEX_OVERLEAF_USER_CODEX_HOME: source, CODEX_OVERLEAF_CODEX_HOME: plugin };
  const auth = path.join(source, 'auth.json'), copy = path.join(plugin, 'auth.json');
  return { source, plugin, auth, copy, env, prepare: () => preparePluginCodexHome(env, { loadCodexLocalSkills: false, loadCodexOverleafSkills: false }) };
}

test('removing the source removes only the auth last inherited into the plugin home', t => {
  const f = fixture(t);
  fs.writeFileSync(f.auth, '{"OPENAI_API_KEY":"SYNTHETIC_A"}');
  f.prepare();
  assert.equal(fs.readFileSync(f.copy, 'utf8'), fs.readFileSync(f.auth, 'utf8'));
  fs.rmSync(f.auth);
  f.prepare();
  assert.equal(fs.existsSync(f.copy), false);
  f.prepare();
  assert.equal(fs.existsSync(f.copy), false);
  fs.writeFileSync(f.auth, '{"OPENAI_API_KEY":"SYNTHETIC_B"}');
  f.prepare();
  assert.equal(fs.readFileSync(f.copy, 'utf8'), fs.readFileSync(f.auth, 'utf8'));
});

test('a plugin auth changed after inheritance is retained when the source disappears', t => {
  const f = fixture(t);
  fs.writeFileSync(f.auth, '{"OPENAI_API_KEY":"SYNTHETIC_A"}'); f.prepare();
  fs.writeFileSync(f.copy, '{"OPENAI_API_KEY":"SYNTHETIC_INDEPENDENT"}'); fs.rmSync(f.auth);
  f.prepare();
  assert.equal(fs.readFileSync(f.copy, 'utf8'), '{"OPENAI_API_KEY":"SYNTHETIC_INDEPENDENT"}');
});

test('unattributed legacy plugin auth and same-home auth are not deleted', t => {
  const f = fixture(t);
  fs.writeFileSync(f.copy, '{"OPENAI_API_KEY":"SYNTHETIC_LEGACY"}');
  f.prepare();
  assert.equal(fs.readFileSync(f.copy, 'utf8'), '{"OPENAI_API_KEY":"SYNTHETIC_LEGACY"}');
  fs.writeFileSync(f.auth, '{"OPENAI_API_KEY":"SYNTHETIC_SHARED"}');
  preparePluginCodexHome({ ...f.env, CODEX_OVERLEAF_CODEX_HOME: f.source });
  assert.equal(fs.readFileSync(f.auth, 'utf8'), '{"OPENAI_API_KEY":"SYNTHETIC_SHARED"}');
});

test('changing the authentication source does not delete another source\'s old copy', t => {
  const f = fixture(t);
  fs.writeFileSync(f.auth, '{"OPENAI_API_KEY":"SYNTHETIC_A"}'); f.prepare();
  const other = path.join(f.source, 'other'); fs.mkdirSync(other);
  preparePluginCodexHome({ ...f.env, CODEX_OVERLEAF_USER_CODEX_HOME: other });
  assert.equal(fs.readFileSync(f.copy, 'utf8'), '{"OPENAI_API_KEY":"SYNTHETIC_A"}');
});

for (const timing of ['before-detach', 'after-detach']) {
  test('an independent login racing inherited-auth removal survives ' + timing, t => {
    const f = fixture(t), independent = '{"OPENAI_API_KEY":"SYNTHETIC_INDEPENDENT"}';
    fs.writeFileSync(f.auth, '{"OPENAI_API_KEY":"SYNTHETIC_A"}'); f.prepare(); fs.rmSync(f.auth);
    const rename = fs.renameSync; let replaced = false;
    fs.renameSync = function(source, destination) {
      if (String(source) !== f.copy) return rename.apply(this, arguments);
      if (timing === 'before-detach') fs.writeFileSync(f.copy, independent);
      const result = rename.apply(this, arguments);
      if (timing === 'after-detach') fs.writeFileSync(f.copy, independent);
      replaced = true; return result;
    };
    try { f.prepare(); } finally { fs.renameSync = rename; }
    assert.equal(replaced, true);
    assert.equal(fs.readFileSync(f.copy, 'utf8'), independent);
  });
}

test('cleanup cannot remove provenance published by a concurrent inheritance', t => {
  const f = fixture(t), { copyInheritedAuth } = require('../native-host/src/codexInheritedAuth');
  const a = '{"OPENAI_API_KEY":"SYNTHETIC_A"}', b = '{"OPENAI_API_KEY":"SYNTHETIC_B"}';
  fs.writeFileSync(f.auth, a); f.prepare(); fs.rmSync(f.auth);
  const remove = fs.rmSync; let raced = false;
  fs.rmSync = function(file, ...args) {
    if (!raced && String(file).startsWith(f.copy + '.preserved-')) {
      raced = true; fs.writeFileSync(f.auth, b); copyInheritedAuth(f.auth, f.copy); fs.rmSync(f.auth);
    }
    return remove.call(this, file, ...args);
  };
  try { f.prepare(); } finally { fs.rmSync = remove; }
  assert.equal(raced, true); assert.equal(fs.readFileSync(f.copy, 'utf8'), b);
  f.prepare(); assert.equal(fs.existsSync(f.copy), false);
});

test('an inherited-auth cleanup I/O failure stops preparation and preserves source evidence', t => {
  const f = fixture(t); fs.writeFileSync(f.auth, '{"OPENAI_API_KEY":"SYNTHETIC_A"}'); f.prepare(); fs.rmSync(f.auth);
  const rename = fs.renameSync;
  fs.renameSync = function(source) {
    if (String(source) === f.copy) throw Object.assign(new Error('Synthetic cleanup refusal'), { code: 'EACCES' });
    return rename.apply(this, arguments);
  };
  try { assert.throws(() => f.prepare(), /Synthetic cleanup refusal/); } finally { fs.renameSync = rename; }
  assert.equal(fs.existsSync(f.copy), true);
  f.prepare(); assert.equal(fs.existsSync(f.copy), false);
});

test('independent auth is not moved just to restore it on a filesystem without hard links', t => {
  const f = fixture(t); fs.writeFileSync(f.auth, '{"OPENAI_API_KEY":"SYNTHETIC_A"}'); f.prepare(); fs.rmSync(f.auth);
  fs.writeFileSync(f.copy, '{"OPENAI_API_KEY":"SYNTHETIC_INDEPENDENT"}');
  const link = fs.linkSync;
  fs.linkSync = () => { throw Object.assign(new Error('Synthetic unsupported link'), { code: 'ENOTSUP' }); };
  try { f.prepare(); } finally { fs.linkSync = link; }
  assert.equal(fs.readFileSync(f.copy, 'utf8'), '{"OPENAI_API_KEY":"SYNTHETIC_INDEPENDENT"}');
});

test('a racing independent auth that cannot be restored prevents a silent unauthenticated start', t => {
  const f = fixture(t); fs.writeFileSync(f.auth, '{"OPENAI_API_KEY":"SYNTHETIC_A"}'); f.prepare(); fs.rmSync(f.auth);
  const rename = fs.renameSync, link = fs.linkSync;
  fs.renameSync = function(source) { if (String(source) === f.copy) fs.writeFileSync(f.copy, '{"OPENAI_API_KEY":"SYNTHETIC_INDEPENDENT"}'); return rename.apply(this, arguments); };
  fs.linkSync = () => { throw Object.assign(new Error('Synthetic restore failure'), { code: 'ENOTSUP' }); };
  try { assert.throws(() => f.prepare(), /Synthetic restore failure/); } finally { fs.renameSync = rename; fs.linkSync = link; }
  const preserved = fs.readdirSync(f.plugin).filter(x => x.startsWith('auth.json.preserved-'));
  assert.equal(preserved.length, 1);
  assert.equal(fs.readFileSync(path.join(f.plugin, preserved[0]), 'utf8'), '{"OPENAI_API_KEY":"SYNTHETIC_INDEPENDENT"}');
});
