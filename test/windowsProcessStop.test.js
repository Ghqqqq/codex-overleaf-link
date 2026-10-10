'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function timingWithEnvironment(env, execFile) {
  const filename = path.resolve(__dirname, '../native-host/src/codexSessionTiming.js');
  const actualRequire = createRequire(filename), module = { exports: {} };
  vm.runInNewContext('(function(require,module,exports,process){' + fs.readFileSync(filename, 'utf8') + '\n})',
    { setTimeout, clearTimeout })(name => name === 'node:child_process' ? { execFile } : actualRequire(name),
    module, module.exports, { env, platform: 'win32', kill() {} });
  return module.exports;
}

test('Windows process-tree stop finds the system tool with a restricted PATH', async t => {
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR']) {
    await t.test(key, async () => {
      const child = { pid: 4321, exitCode: null, signalCode: null };
      const expected = 'C:\\Windows\\System32\\taskkill.exe';
      const calls = [];
      const timing = timingWithEnvironment({ PATH: 'C:\\fixture-only', [key]: 'C:\\Windows' }, (command, args, options, callback) => {
        calls.push({ command, args: Array.from(args), options });
        if (command !== expected) return callback(Object.assign(new Error('tool is absent from PATH'), { code: 'ENOENT' }));
        child.exitCode = 1;
        callback(null);
      });
      await timing.stopCodexAppServer(child, { forceTimeoutMs: 0 });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, expected);
      assert.deepEqual(calls[0].args, ['/pid', '4321', '/t', '/f']);
      assert.equal(calls[0].options.windowsHide, true);
    });
  }
});

test('missing or relative Windows system roots retain command lookup without creating a relative tool path', async t => {
  for (const env of [{}, { SystemRoot: 'relative-windows' }]) {
    await t.test(JSON.stringify(env), async () => {
      const child = { pid: 4321, exitCode: null, signalCode: null };
      const timing = timingWithEnvironment(env, (command, args, options, callback) => {
        assert.equal(command, 'taskkill');
        child.exitCode = 1; callback(null);
      });
      await timing.stopCodexAppServer(child, { forceTimeoutMs: 0 });
    });
  }
});

test('Windows tool failure or missing child exit evidence still rejects stop confirmation', async t => {
  for (const failure of [null, 'EACCES']) {
    await t.test(String(failure), async () => {
      const child = { pid: 4321, exitCode: null, signalCode: null };
      const timing = timingWithEnvironment({ SystemRoot: 'C:\\Windows' }, (_command, _args, _options, callback) =>
        callback(failure ? Object.assign(new Error('access denied'), { code: failure }) : null));
      await assert.rejects(timing.stopCodexAppServer(child, { forceTimeoutMs: 0 }), { code: 'codex_process_stop_unconfirmed' });
    });
  }
});
