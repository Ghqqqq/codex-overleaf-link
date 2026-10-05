'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createSubagentBroker, SUBAGENT_QUEUE_DIR } = require('../native-host/src/subagentBroker');

async function withBroker(options, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-callback-test-'));
  fs.writeFileSync(path.join(root, 'main.tex'), 'Original\n');
  const broker = createSubagentBroker({ workspacePath: root, env: {}, limits: {
    maxWorkers: 1, perWorkerTimeoutMs: 1000, brokerBudgetMs: 10000, pollIntervalMs: 5, drainGraceMs: 20
  }, ...options });
  try {
    broker.start();
    for (const id of ['active', 'queued']) fs.writeFileSync(path.join(root, SUBAGENT_QUEUE_DIR, 'jobs', `${id}.json`),
      JSON.stringify({ id, task: 'Synthetic task', files: ['main.tex'] }));
    broker.pollOnce();
    await body(broker, root);
  } finally { await broker.stop({ drain: false }).catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
}

function scenario(mode, kind, count, parentOutcome = 'completed') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-io-test-'));
  try {
    const child = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/subagent-io-probe.cjs'),
      mode, kind, String(count), root, parentOutcome], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
      env: { PATH: path.dirname(process.execPath), ...(process.platform === 'win32'
        ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}) }
    });
    assert.equal(child.error, undefined, 'isolated child must terminate within five seconds');
    const line = child.stdout.split('\n').find(value => value.startsWith('OBSERVATION '));
    assert.ok(line, `child evidence missing: exit=${child.status}; stderr=${child.stderr}`);
    const observation = JSON.parse(line.slice('OBSERVATION '.length));
    assert.equal(observation.harnessError, undefined);
    assert.equal(child.status, 0, `broker error must not terminate Native Host: ${JSON.stringify(observation.unhandled)} ${child.stderr}`);
    return observation;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('natural worker completion persists a completed result and leaves its valid edit available', () => {
  const value = scenario('natural', 'none', 0);
  assert.equal(value.receipt.status, 'completed');
  assert.equal(value.stopError, undefined);
  assert.deepEqual(value.blockedPaths, []);
  assert.deepEqual(value.unhandled, []);
  assert.equal(value.state.pollTimers, 0);
});

for (const kind of ['write', 'rename']) {
  test(`single ${kind} failure retains the failed receipt fallback and quarantines edits`, () => {
    const value = scenario('natural', kind, 1);
    assert.equal(value.faults.length, 1);
    assert.equal(value.receipt.status, 'failed');
    assert.equal(value.stopError, undefined, 'successfully persisted fallback remains recoverable');
    assert.deepEqual(value.blockedPaths, ['main.tex']);
    assert.deepEqual(value.unhandled, []);
  });

  test(`persistent natural-completion ${kind} EIO is reported after cleanup without unhandled rejection`, () => {
    const value = scenario('natural', kind, 2);
    assert.equal(value.faults.length, 2);
    assert.equal(value.stopError.code, 'subagent_io_failed');
    assert.equal(value.stopError.causeCode, 'EIO');
    assert.deepEqual(value.blockedPaths, ['main.tex']);
    assert.deepEqual(value.unhandled, []);
    assert.equal(value.state.activeWorkers, false);
    assert.equal(value.state.pollTimers, 0);
    assert.equal(value.state.brokerStatus, 'closed');
    assert.ok(value.events.some(event => event.type === 'codex.subagent.failed'), 'failure remains visible even if no receipt was persisted');
  });
  test(`persistent ${kind} EIO stops queued admission before worker finally fills slots`, () => {
    const value = scenario('natural', kind, 2, 'queued');
    assert.equal(value.afterNatural.audit.jobs.find(job => job.id === 'zz-queued').status, 'queued');
    assert.equal(value.state.audit.jobs.find(job => job.id === 'zz-queued').status, 'cancelled');
    assert.deepEqual(value.events.filter(event => event.type === 'codex.subagent.started').map(event => event.detail.jobId), ['aa-active']);
    assert.equal(value.stopError.code, 'subagent_io_failed');
  });
}

for (const parentOutcome of ['completed', 'failed', 'cancelled']) {
  test(`parent ${parentOutcome} closes running/queued work normally before Native returns`, () => {
    const value = scenario('stop', 'none', 0, parentOutcome);
    assert.equal(value.afterNative.workerAborted, true);
    assert.equal(value.afterNative.activeWorkers, false);
    assert.equal(value.afterNative.pollTimers, 0);
    assert.equal(value.afterNative.brokerStatus, 'closed');
    assert.equal(value.afterDeadline.queuedReceipt.status, 'cancelled');
    assert.deepEqual(value.afterNative.nativeWork, { projectLocks: 0, processStopBarriers: 0, runControllers: 0, activeTurnControls: 0 });
    assert.equal(value.nativeResponse.ok, parentOutcome === 'completed');
    if (parentOutcome === 'cancelled') assert.equal(value.nativeResponse.error.code, 'codex_cancelled');
    assert.deepEqual(value.blockedPaths, ['main.tex']);
  });
  for (const kind of ['write', 'rename']) {
    test(`parent ${parentOutcome} queued ${kind} EIO cannot bypass abort/close or release worker edits`, () => {
      const value = scenario('stop', kind, 1, parentOutcome);
      const after = value.afterNative;
      assert.equal(value.faults.length, 1);
      assert.equal(value.nativeResponse.ok, false);
      assert.equal(value.nativeResponse.error.code, 'codex_run_failed', 'I/O failure must stay explicit even during cancellation');
      assert.equal(after.workerAborted, true);
      assert.equal(after.activeWorkers, false);
      assert.equal(after.pollTimers, 0);
      assert.equal(after.workerDeadlineTimers, 0);
      assert.equal(after.brokerStatus, 'closed');
      assert.deepEqual(after.nativeWork, { projectLocks: 0, processStopBarriers: 0, runControllers: 0, activeTurnControls: 0 });
      assert.equal(value.repeatedStopError.code, 'subagent_io_failed');
      assert.deepEqual(value.blockedPaths, ['main.tex']);
      assert.equal(value.afterDeadline.runningReceipt.status, 'cancelled');
    });
  }
}

for (const dirtyThrows of [false, true]) {
  test(`throwing telemetry and ${dirtyThrows ? 'throwing' : 'normal'} dirty callback cannot bypass cancellation cleanup`, async () => {
    const parent = new AbortController();
    let workerSignal, dirtyCalls = 0;
    await withBroker({ signal: parent.signal,
      emit() { throw new Error('Synthetic observer failure'); },
      onMirrorDirty() { dirtyCalls += 1; if (dirtyThrows) throw new Error('Synthetic dirty failure'); },
      runWorkerTask: ({ signal }) => {
        workerSignal = signal;
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
    }, async (broker, root) => {
      parent.abort();
      if (dirtyThrows) {
        await assert.rejects(broker.stop(), { code: 'subagent_io_failed' });
        await assert.rejects(broker.stop(), { code: 'subagent_io_failed' });
      } else await broker.stop();
      assert.equal(workerSignal.aborted, true);
      assert.equal(broker.hasActiveWorkers(), false);
      assert.equal(dirtyCalls, 1);
      const queue = path.join(root, SUBAGENT_QUEUE_DIR);
      assert.equal(JSON.parse(fs.readFileSync(path.join(queue, 'broker.json'), 'utf8')).status, 'closed');
      assert.equal(JSON.parse(fs.readFileSync(path.join(queue, 'results/queued.json'), 'utf8')).status, 'cancelled');
    });
  });
}

test('late worker success after abort remains cancelled and its edits stay quarantined', async () => {
  let finish, workerSignal;
  await withBroker({ runWorkerTask: ({ signal }) => {
    workerSignal = signal;
    return new Promise(resolve => { finish = resolve; });
  } }, async (broker, root) => {
    fs.writeFileSync(path.join(root, 'main.tex'), 'Partial edit\n');
    await broker.stop({ drain: false });
    assert.equal(workerSignal.aborted, true);
    assert.deepEqual([...broker.getViolationPaths()], ['main.tex'], 'unsettled aborted worker output cannot be collected');
    finish({ assistantMessage: 'Late synthetic completion' });
    await new Promise(resolve => setImmediate(resolve));
    const receipt = JSON.parse(fs.readFileSync(path.join(root, SUBAGENT_QUEUE_DIR, 'results/active.json'), 'utf8'));
    assert.equal(receipt.status, 'cancelled');
    assert.deepEqual([...broker.getViolationPaths()], ['main.tex']);
  });
});

test('stop reentry from telemetry and concurrent callers performs one cleanup', async () => {
  let captured, reentry, drainEvents = 0, queuedEvents = 0;
  await withBroker({
    emit(type, title, detail) {
      if (type === 'codex.subagent.failed' && detail.jobId === 'queued') {
        queuedEvents += 1;
        reentry = captured.stop({ drain: false });
      }
      if (type === 'codex.subagent.drained') drainEvents += 1;
    },
    runWorkerTask: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })
  }, async broker => {
    captured = broker;
    await Promise.all([broker.stop({ drain: false }), broker.stop()]);
    await reentry;
    assert.equal(queuedEvents, 1);
    assert.equal(drainEvents, 1);
    assert.equal(broker.hasActiveWorkers(), false);
  });
});
