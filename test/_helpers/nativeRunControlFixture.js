'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function nativeRunControlFixture(t) {
  const filename = path.resolve(__dirname, '../../native-host/src/taskRunnerRuntime.js');
  const nativeRequire = createRequire(filename), module = { exports: {} };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'col-run-control-'));
  const entered = deferred(), finish = deferred(), calls = { runs: 0, steers: [], signal: null };
  const dependencies = {
    './debugLog': { ...nativeRequire('./debugLog'), logDebug() {} },
    './nativeEnvironment': { ...nativeRequire('./nativeEnvironment'), refreshCodexRuntimeEnv: env => env },
    './providerRuntime': { ...nativeRequire('./providerRuntime'), resolveRunProviderForRun: async () => ({ modelId: 'synthetic', reasoningEffort: 'low' }) },
    './codexSessionRunner': { async runCodexSession(options) {
      calls.runs++; calls.signal = options.signal;
      options.onControlReady({ threadId: 'thread-one', turnId: 'turn-one', async steer(input) { calls.steers.push(input); } });
      entered.resolve(); await finish.promise; options.signal.throwIfAborted();
      return { syncChanges: [], assistantMessage: 'synthetic completed' };
    } }
  };
  vm.runInThisContext('(function(require,module,exports){' + fs.readFileSync(filename, 'utf8') + '\n})', { filename })(
    name => dependencies[name] || nativeRequire(name), module, module.exports);
  const env = { CODEX_OVERLEAF_ENV_READY: '1', CODEX_OVERLEAF_CODEX_PATH: process.execPath,
    CODEX_OVERLEAF_MIRROR_ROOT: directory, CODEX_OVERLEAF_PROVIDER_STORE_DIR: path.join(directory, 'providers') };
  const handle = request => module.exports.handleRequest(request, env);
  const start = id => handle({ id, method: 'codex.run', params: { projectId: 'project-one', mode: 'ask', task: 'synthetic fixture',
    project: { id: 'project-one', files: [{ path: 'main.tex', content: 'synthetic' }], capabilities: { fullProjectSnapshot: true } } } });
  t.after(() => { finish.resolve(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { handle, start, calls, entered: entered.promise, finish: finish.resolve };
}
module.exports = { nativeRunControlFixture, deferred };
