'use strict';

// Isolated synthetic peer. No external Codex, account, editor, or user log.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const repo = path.resolve(__dirname, '../..');
const [mode, faultKind, faultCountText, root, parentOutcome = 'completed'] = process.argv.slice(2);
const faultCountLimit = Number(faultCountText);
const original = {
  writeFileSync: fs.writeFileSync, renameSync: fs.renameSync,
  setTimeout, clearTimeout, setInterval, clearInterval
};
const observation = { mode, faultKind, faultCountLimit, parentOutcome, faults: [], unhandled: [], events: [] };
let broker, workerSignal, resultsDir, faultEnabled = true;
const intervals = new Set(), deadlines = new Set();
const limits = { maxWorkers: 1, maxJobsPerRun: 3, perWorkerTimeoutMs: 180,
  brokerBudgetMs: 5000, pollIntervalMs: 10, drainGraceMs: 20 };
global.setInterval = (callback, ms, ...args) => {
  const id = original.setInterval(callback, ms, ...args); intervals.add(id); return id;
};
global.clearInterval = id => { intervals.delete(id); return original.clearInterval(id); };
global.setTimeout = (callback, ms, ...args) => {
  let id;
  id = original.setTimeout((...values) => { deadlines.delete(id); callback(...values); }, ms, ...args);
  if (ms === limits.perWorkerTimeoutMs) deadlines.add(id);
  return id;
};
global.clearTimeout = id => { deadlines.delete(id); return original.clearTimeout(id); };
const wait = ms => new Promise(resolve => original.setTimeout(resolve, ms));
function snapshot() {
  const file = resultsDir && path.join(path.dirname(resultsDir), 'broker.json');
  return {
    activeWorkers: broker?.hasActiveWorkers() || false,
    workerAborted: workerSignal?.aborted || false,
    workerAbortReason: workerSignal?.reason?.message || null,
    pollTimers: intervals.size, workerDeadlineTimers: deadlines.size,
    brokerStatus: file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).status : null,
    audit: broker?.getAuditSummary()
  };
}
function output(kind) {
  fs.writeSync(1, `OBSERVATION ${JSON.stringify({ ...observation, kind, state: snapshot() })}\n`);
}
function fault(pathname, text, kind) {
  if (!faultEnabled || faultKind !== kind || observation.faults.length >= faultCountLimit || !resultsDir) return;
  if (typeof pathname !== 'string' || path.dirname(pathname) !== resultsDir) return;
  let jobId;
  if (kind === 'write') {
    try { jobId = JSON.parse(String(text)).id; } catch { return; }
  } else jobId = path.basename(pathname, '.json');
  if (jobId !== (mode === 'natural' ? 'aa-active' : 'zz-queued')) return;
  const error = Object.assign(new Error(`SYNTHETIC_RESULTS_${kind.toUpperCase()}_EIO`), { code: 'EIO' });
  observation.faults.push({ kind, jobId, code: error.code });
  throw error;
}
fs.writeFileSync = function (file, text, ...args) {
  fault(file, text, 'write'); return original.writeFileSync.call(fs, file, text, ...args);
};
fs.renameSync = function (source, target, ...args) {
  fault(target, null, 'rename'); return original.renameSync.call(fs, source, target, ...args);
};
function enqueue(workspace, id, file) {
  fs.writeFileSync(path.join(workspace, '.codex-overleaf-subagents/jobs', id + '.json'),
    JSON.stringify({ id, task: 'Synthetic isolated task', files: [file] }));
}
function readReceipt(id) {
  const file = path.join(resultsDir, id + '.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}
function installActualIndexHandlers() {
  const indexPath = path.join(repo, 'native-host/src/index.js');
  const indexRequire = createRequire(indexPath);
  const source = fs.readFileSync(indexPath, 'utf8');
  // Execute the unchanged full entry source. Only unrelated discovery, request
  // dispatch and log sinks are substituted; actual process handlers/exit remain.
  const sandboxRequire = name => {
    if (name === './debugLog') return { logDebug(event, detail) {
      if (event === 'process.unhandled_rejection') {
        observation.unhandled.push({ event, message: detail.message }); output('native-fatal');
      }
    } };
    if (name === './nativeEnvironment') return {
      buildNativeRuntimeEnv: () => ({}), summarizeNativeEnvironment: () => ({ isolatedProbe: true })
    };
    if (name === './taskRunner') return { handleRequest() { throw new Error('unused request dispatcher'); } };
    if (name === './taskRunnerRuntime') return { abortAllActiveOperations() {}, quarantineActiveOperations: () => [], getActiveNativeWorkState: () => ({}) };
    if (name === './updateManager') return { isUpdateMethod: () => false, handleUpdateRequest() { throw new Error('unused updater'); } };
    return indexRequire(name);
  };
  vm.runInNewContext(source, {
    require: sandboxRequire, module: { exports: {} }, exports: {}, Buffer, process,
    setTimeout: global.setTimeout, clearTimeout: global.clearTimeout,
    __filename: indexPath, __dirname: path.dirname(indexPath)
  }, { filename: indexPath });
}
async function natural() {
  installActualIndexHandlers();
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'main.tex'), 'Synthetic original\n');
  const { createSubagentBroker } = require(path.join(repo, 'native-host/src/subagentBroker'));
  let complete;
  broker = createSubagentBroker({ workspacePath: workspace, limits, env: {},
    emit: (type, title, detail, status) => observation.events.push({ type, detail, status }),
    runWorkerTask: ({ signal }) => { workerSignal = signal; return new Promise(resolve => { complete = resolve; }); }
  });
  broker.start(); resultsDir = path.join(workspace, '.codex-overleaf-subagents/results');
  enqueue(workspace, 'aa-active', 'main.tex');
  if (parentOutcome === 'queued') enqueue(workspace, 'zz-queued', 'main.tex');
  broker.pollOnce();
  observation.before = snapshot();
  fs.writeFileSync(path.join(workspace, 'main.tex'), 'Synthetic worker edit\n');
  complete({ assistantMessage: 'Synthetic completed worker', threadId: 'synthetic-thread' });
  await wait(40);
  observation.receipt = readReceipt('aa-active');
  observation.afterNatural = snapshot();
  try { await broker.stop({ drain: false }); } catch (error) {
    observation.stopError = { code: error.code, message: error.message, causeCode: error.cause?.code };
  }
  observation.blockedPaths = [...broker.getViolationPaths()]; output('completed');
  process.exit(0);
}
async function stopped() {
  // Load actual runtime/runner/broker. Adapt only local I/O faults, limits,
  // discovery/logging, and the injected model executor (no model process).
  const debugLog = require(path.join(repo, 'native-host/src/debugLog'));
  debugLog.logDebug = () => {};
  const nativeEnv = require(path.join(repo, 'native-host/src/nativeEnvironment'));
  nativeEnv.refreshCodexRuntimeEnv = env => env;
  const brokerModule = require(path.join(repo, 'native-host/src/subagentBroker'));
  const createActualBroker = brokerModule.createSubagentBroker;
  brokerModule.createSubagentBroker = options => {
    broker = createActualBroker({ ...options, limits }); return broker;
  };
  const session = require(path.join(repo, 'native-host/src/codexSessionRunner'));
  const actualRunCodexSession = session.runCodexSession;
  let runtime;
  async function executeCodex(input) {
    if (input.userTask.startsWith('subagent:')) {
      workerSignal = input.signal;
      fs.writeFileSync(path.join(input.workspacePath, 'main.tex'), 'Synthetic partial worker edit\n');
      return new Promise((resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
      });
    }
    resultsDir = path.join(input.workspacePath, '.codex-overleaf-subagents/results');
    input.onControlReady?.({ interrupt() {} });
    enqueue(input.workspacePath, 'aa-active', 'main.tex');
    enqueue(input.workspacePath, 'zz-queued', 'second.tex');
    broker.pollOnce();
    observation.before = { ...snapshot(), nativeWork: runtime.getActiveNativeWorkState() };
    if (parentOutcome === 'cancelled') {
      await runtime.handleRequest({ id: 'cancel-request', method: 'codex.cancel', params: { requestId: 'synthetic-request' } }, env);
      throw input.signal.reason;
    }
    if (parentOutcome === 'failed') throw Object.assign(new Error('SYNTHETIC_PARENT_FAILURE'), { code: 'synthetic_parent_failure' });
    return { assistantMessage: 'Synthetic parent finished', threadId: 'synthetic-parent' };
  }
  session.runCodexSession = input => actualRunCodexSession({ ...input, executeCodex });
  runtime = require(path.join(repo, 'native-host/src/taskRunnerRuntime'));
  const env = {
    CODEX_OVERLEAF_USER_CODEX_HOME: path.join(root, 'user-codex-home'),
    CODEX_OVERLEAF_CODEX_HOME: path.join(root, 'plugin-codex-home'),
    CODEX_HOME: path.join(root, 'user-codex-home'),
    CODEX_OVERLEAF_ENV_READY: '1', CODEX_OVERLEAF_CODEX_PATH: 'synthetic-not-executed',
    CODEX_OVERLEAF_PROVIDER_STORE_DIR: path.join(root, 'provider-store'),
    CODEX_OVERLEAF_MIRROR_ROOT: path.join(root, 'mirrors'),
    CODEX_OVERLEAF_WRITING_STYLE_ROOT: path.join(root, 'writing-styles'),
    CODEX_OVERLEAF_SKILLS_ROOT: path.join(root, 'skills')
  };
  const projectId = 'synthetic-stop-project';
  observation.nativeResponse = await runtime.handleRequest({ id: 'synthetic-request', method: 'codex.run', params: {
    projectId, task: 'Synthetic parent', mode: 'auto', writingStyle: null,
    loadCodexLocalSkills: false, loadCodexOverleafSkills: true,
    enabledCodexOverleafSkillIds: ['parallel-subagents'],
    project: { capabilities: { fullProjectSnapshot: true }, files: [
      { path: 'main.tex', content: 'Synthetic original\n' },
      { path: 'second.tex', content: 'Second synthetic\n' }
    ] }
  } }, env, event => observation.events.push(event));
  const barrier = require(path.join(repo, 'native-host/src/processStopBarrier'));
  observation.afterNative = { ...snapshot(), nativeWork: runtime.getActiveNativeWorkState(),
    stopBarrier: barrier.isBlocked(projectId, env.CODEX_OVERLEAF_MIRROR_ROOT) };
  // The deadline is a retained protection; do not mistake the failed stop for
  // permanent immortality. Await it separately to observe the actual boundary.
  await wait(230);
  observation.afterDeadline = { ...snapshot(), runningReceipt: readReceipt('aa-active'), queuedReceipt: readReceipt('zz-queued') };
  faultEnabled = false;
  try { await broker.stop({ drain: false }); } catch (error) {
    observation.repeatedStopError = { code: error.code, message: error.message, causeCode: error.cause?.code };
  }
  observation.blockedPaths = [...broker.getViolationPaths()];
  observation.afterCleanup = snapshot();
  output('completed');
  process.exit(0);
}
(mode === 'natural' ? natural() : stopped()).catch(error => {
  observation.harnessError = { message: error.message, stack: error.stack };
  output('harness-error'); process.exit(2);
});
