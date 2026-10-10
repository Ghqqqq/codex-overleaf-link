'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { queryWindowsNativeHostRegistration } = require('../native-host/src/nativeHostRegistration');

const target = {
  registryKey: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.codex.overleaf',
  manifestPath: 'C:\\Fixture Home\\native-hosts\\com.codex.overleaf.json'
};

test('registration query executes the configured command prefix before its read-only arguments', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-query-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'registry wrapper.cjs');
  fs.writeFileSync(script, [
    "const assert = require('node:assert/strict');",
    `const target = ${JSON.stringify(target)};`,
    "assert.deepEqual(process.argv.slice(2), ['prefix marker', 'query', target.registryKey, '/ve']);",
    "process.stdout.write(target.registryKey + '\\r\\n    (Default)    REG_SZ    ' + target.manifestPath + '\\r\\n');"
  ].join('\n'));
  const result = queryWindowsNativeHostRegistration(target, {
    env: { CODEX_OVERLEAF_REG_EXE: process.execPath, CODEX_OVERLEAF_REG_EXE_ARGS_JSON: JSON.stringify([script, 'prefix marker']) }
  });
  assert.deepEqual(result, { verified: true, status: 'verified', registeredManifestPath: target.manifestPath });
});

test('default registration query keeps exact key, bounded execution and no shell', () => {
  let calls = 0;
  const result = queryWindowsNativeHostRegistration(target, { env: {}, spawnSync(command, args, options) {
    calls++;
    assert.equal(command, 'reg.exe');
    assert.deepEqual(args, ['query', target.registryKey, '/ve']);
    assert.equal(options.shell, undefined);
    assert.equal(options.timeout, 3000);
    assert.equal(options.maxBuffer, 64 * 1024);
    return { status: 0, stdout: '    (Default)    REG_SZ    C:\\Other\\manifest.json\r\n' };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { verified: false, status: 'mismatch', registeredManifestPath: 'C:\\Other\\manifest.json' });
});

test('invalid registry command prefixes stay unavailable without starting an alternate command', () => {
  for (const prefix of ['not json', '{}', 'null', '[42]', '["valid",{}]']) {
    let called = false;
    const result = queryWindowsNativeHostRegistration(target, {
      env: { CODEX_OVERLEAF_REG_EXE_ARGS_JSON: prefix },
      spawnSync() { called = true; return { status: 0, stdout: '' }; }
    });
    assert.deepEqual(result, { verified: false, status: 'unavailable' });
    assert.equal(called, false, prefix);
  }
});

test('prefix support never promotes missing, ambiguous, relative or failed query evidence', () => {
  const outputs = [
    { status: 1, stdout: '' },
    { status: 0, stdout: '' },
    { status: 0, stdout: '    (Default)    REG_SZ    relative.json\n' },
    { status: 0, stdout: `    (Default)    REG_SZ    ${target.manifestPath}\n    Other    REG_SZ    ${target.manifestPath}\n` },
    { status: 0, error: new Error('spawn failed'), stdout: `    (Default)    REG_SZ    ${target.manifestPath}\n` }
  ];
  for (const output of outputs) {
    assert.deepEqual(queryWindowsNativeHostRegistration(target, {
      env: { CODEX_OVERLEAF_REG_EXE_ARGS_JSON: '["wrapper"]' },
      spawnSync: () => output
    }), { verified: false, status: 'unavailable' });
  }
});
