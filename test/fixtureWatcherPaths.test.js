'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

for (const fixture of ['codex-terminal-app-server.cjs', 'codex-process-settlement/app-server.cjs', 'native-disconnect-settlement/app-server.cjs']) {
  test(`${fixture} watches the native directory identity and retains its completion event`, { timeout: 10000 }, async t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-watch-'));
    const target = path.join(temporary, 'actual-directory');
    const alias = path.join(temporary, 'directory-alias');
    fs.mkdirSync(target);
    fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const workspace = path.join(alias, 'workspace');
    const results = path.join(workspace, '.codex-overleaf-subagents/results');
    fs.mkdirSync(results, { recursive: true });
    fs.mkdirSync(path.join(workspace, '.codex-overleaf-subagents/jobs'));
    const watchers = [];
    t.after(() => {
      for (const watcher of watchers) watcher.close();
      fs.rmSync(temporary, { recursive: true, force: true });
    });
    const terminal = fixture === 'codex-terminal-app-server.cjs';
    const expectedDirectory = terminal ? results : alias;
    const canonical = fs.realpathSync.native(expectedDirectory);
    assert.notEqual(expectedDirectory, canonical, 'the fixture must exercise a real directory alias');
    let onLine;
    let finish;
    const completed = new Promise(resolve => { finish = resolve; });
    const watchedFs = { ...fs, watch(directory, listener) {
      assert.equal(directory, canonical, 'libuv must receive the native path, without a parent directory alias');
      const watcher = fs.watch(directory, listener);
      watchers.push(watcher);
      return watcher;
    } };
    const peerProcess = {
      pid: process.pid,
      env: {
        CODEX_TEST_TERMINAL_ROOT: alias, CODEX_TEST_TERMINAL_MODE: 'broker',
        CODEX_TEST_TERMINAL_FIELDS: '{"status":"completed"}',
        CODEX_TEST_EXIT_ROOT: alias, CODEX_TEST_EXIT_MODE: 'normal-success',
        CODEX_TEST_DISCONNECT_ROOT: alias, CODEX_TEST_DISCONNECT_MODE: 'cooperative-disconnect'
      },
      stdin: { on() {} },
      stdout: { write(line) {
        const event = JSON.parse(line);
        if (event.method === 'turn/completed') finish(event.params.turn.status);
      } },
      on() {},
      exit(code) { finish(code); }
    };
    const filename = path.join(__dirname, 'fixtures', fixture);
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      require(id) {
        if (id === 'node:fs') return watchedFs;
        if (id === 'node:path') return path;
        if (id === 'node:readline') return { createInterface: () => ({ on(event, listener) {
          assert.equal(event, 'line'); onLine = listener;
        } }) };
        throw new Error(`Unexpected fixture dependency: ${id}`);
      },
      process: peerProcess,
      setTimeout: () => 1,
      clearTimeout() {}
    }, { filename });
    if (terminal) {
      onLine(JSON.stringify({ id: 1, method: 'thread/start', params: { cwd: workspace } }));
      onLine(JSON.stringify({ id: 2, method: 'turn/start', params: { input: 'SYNTHETIC_TERMINAL_PARENT' } }));
      fs.writeFileSync(path.join(results, 'terminal-worker.json'), '{"status":"completed"}');
    } else {
      fs.writeFileSync(path.join(alias, 'shutdown.json'), '{}');
    }
    assert.equal(await completed, terminal ? 'completed' : 0);
    assert.equal(watchers.length, 1, 'completion still uses the real event watcher');
  });
}
