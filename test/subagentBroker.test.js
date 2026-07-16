const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createSubagentBroker, SUBAGENT_QUEUE_DIR } = require('../native-host/src/subagentBroker');

const TINY = { maxWorkers: 2, maxJobsPerRun: 4, perWorkerTimeoutMs: 120, brokerBudgetMs: 5000, pollIntervalMs: 5, drainGraceMs: 40 };

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-broker-'));
  fs.mkdirSync(path.join(dir, 'sections'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'main.tex'), 'main');
  fs.writeFileSync(path.join(dir, 'sections', 'ch1.tex'), 'one');
  fs.writeFileSync(path.join(dir, 'sections', 'ch2.tex'), 'two');
  return dir;
}

function queue(dir) {
  return path.join(dir, SUBAGENT_QUEUE_DIR);
}

function writeJob(dir, job) {
  const jobsDir = path.join(queue(dir), 'jobs');
  const tmp = path.join(jobsDir, `.tmp-${job.id || 'x'}`);
  fs.writeFileSync(tmp, typeof job === 'string' ? job : JSON.stringify(job));
  fs.renameSync(tmp, path.join(jobsDir, `${job.id || 'raw'}.json`));
}

function readResult(dir, id) {
  const file = path.join(queue(dir), 'results', `${id}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

async function waitFor(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

function abortableWorker(impl) {
  return ({ jobId, prompt, signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason || new Error('aborted')), { once: true });
    Promise.resolve(impl({ jobId, prompt, signal })).then(resolve, reject);
  });
}

test('broker start writes a ready handshake and clears stale queues', async () => {
  const dir = makeWorkspace();
  fs.mkdirSync(path.join(queue(dir), 'results'), { recursive: true });
  fs.writeFileSync(path.join(queue(dir), 'results', 'stale.json'), '{}');
  const broker = createSubagentBroker({ workspacePath: dir, runWorkerTask: async () => ({}), limits: TINY });
  broker.start();
  const handshake = JSON.parse(fs.readFileSync(path.join(queue(dir), 'broker.json'), 'utf8'));
  assert.equal(handshake.status, 'ready');
  assert.equal(handshake.protocolVersion, 1);
  assert.equal(handshake.maxWorkers, TINY.maxWorkers);
  assert.equal(fs.existsSync(path.join(queue(dir), 'results', 'stale.json')), false, 'stale results cleared');
  await broker.stop();
  assert.equal(JSON.parse(fs.readFileSync(path.join(queue(dir), 'broker.json'), 'utf8')).status, 'closed');
});

test('accepted job runs, edits its owned file, and lands a completed result', async () => {
  const dir = makeWorkspace();
  const events = [];
  const prompts = [];
  const broker = createSubagentBroker({
    workspacePath: dir,
    emit: (type, title, detail, status) => events.push({ type, title, status }),
    runWorkerTask: abortableWorker(async ({ jobId, prompt }) => {
      prompts.push(prompt);
      fs.writeFileSync(path.join(dir, 'sections', 'ch1.tex'), 'polished one');
      return { assistantMessage: `done ${jobId}`, tokensUsed: 12 };
    }),
    limits: TINY
  });
  broker.start();
  writeJob(dir, { id: 'ch1', title: 'Polish chapter 1', task: 'polish it', files: ['sections/ch1.tex'], readOnlyContext: ['main.tex'] });
  await waitFor(() => readResult(dir, 'ch1')?.status === 'completed');
  const result = readResult(dir, 'ch1');
  assert.equal(result.summary, 'done ch1');
  assert.deepEqual(result.changedFiles, ['sections/ch1.tex']);
  assert.match(fs.readFileSync(path.join(queue(dir), 'results', 'ch1.last-message.md'), 'utf8'), /done ch1/);
  // worker prompt carries the ownership envelope
  assert.match(prompts[0], /modify ONLY these files: sections\/ch1\.tex/);
  assert.match(prompts[0], /must not modify them: main\.tex/);
  assert.match(prompts[0], /Inside \.codex-overleaf-subagents\/ you may touch ONLY the slice files listed above/);
  assert.deepEqual(events.map(e => e.type), ['codex.subagent.queued', 'codex.subagent.started', 'codex.subagent.completed']);
  // no torn temp files left behind
  assert.equal(fs.readdirSync(path.join(queue(dir), 'results')).filter(n => n.startsWith('.tmp-')).length, 0);
  await broker.stop();
});

test('validation rejects bad ids, garbage json, unsafe paths, missing files, conflicts, and over-cap jobs', async () => {
  const dir = makeWorkspace();
  const broker = createSubagentBroker({
    workspacePath: dir,
    runWorkerTask: abortableWorker(() => new Promise(() => {})),
    limits: { ...TINY, maxWorkers: 1, maxJobsPerRun: 2, perWorkerTimeoutMs: 1000, brokerBudgetMs: 60000 }
  });
  broker.start();
  fs.writeFileSync(path.join(queue(dir), 'jobs', 'raw.json'), 'not json');
  writeJob(dir, { id: 'BAD ID', task: 't', files: ['main.tex'] });
  writeJob(dir, { id: 'esc', task: 't', files: ['../outside.tex'] });
  writeJob(dir, { id: 'ghost', task: 't', files: ['nope.tex'] });
  writeJob(dir, { id: 'aa-ok', task: 't', files: ['sections/ch1.tex'] });
  writeJob(dir, { id: 'ok-b', task: 't', files: ['sections/ch2.tex'] });
  writeJob(dir, { id: 'zz-over', task: 't', files: ['main.tex'] });
  await waitFor(() => readResult(dir, 'zz-over'));
  assert.equal(readResult(dir, 'raw').reason, 'invalid_json');
  assert.equal(readResult(dir, 'BAD ID')?.reason ?? 'invalid_id', 'invalid_id');
  assert.equal(readResult(dir, 'esc').reason, 'unsafe_path');
  assert.equal(readResult(dir, 'ghost').reason, 'missing_file');
  assert.equal(readResult(dir, 'zz-over').reason, 'too_many_jobs');
  await broker.stop({ drain: false });
});

test('wave-aware admission rejects jobs that cannot fit the broker budget', async () => {
  const dir = makeWorkspace();
  const broker = createSubagentBroker({
    workspacePath: dir,
    runWorkerTask: abortableWorker(() => new Promise(() => {})),
    limits: { ...TINY, maxWorkers: 1, maxJobsPerRun: 8, perWorkerTimeoutMs: 2000, brokerBudgetMs: 3999 }
  });
  broker.start();
  try {
    writeJob(dir, { id: 'first', task: 't', files: ['sections/ch1.tex'] });
    writeJob(dir, { id: 'second', task: 't', files: ['sections/ch2.tex'] });
    await waitFor(() => readResult(dir, 'second'));
    // Leave enough intake headroom for Windows CI while preserving the wave
    // boundary: one 2000ms wave fits, two 2000ms waves exceed 3999ms.
    assert.equal(readResult(dir, 'first'), null);
    assert.equal(readResult(dir, 'second').reason, 'insufficient_time');
  } finally {
    await broker.stop({ drain: false });
  }
});

test('concurrency stays under maxWorkers across waves', async () => {
  const dir = makeWorkspace();
  let active = 0;
  let peak = 0;
  const broker = createSubagentBroker({
    workspacePath: dir,
    runWorkerTask: abortableWorker(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 25));
      active -= 1;
      return { assistantMessage: 'ok' };
    }),
    limits: { ...TINY, maxWorkers: 2, perWorkerTimeoutMs: 5000, brokerBudgetMs: 60000 }
  });
  broker.start();
  writeJob(dir, { id: 'a', task: 't', files: ['sections/ch1.tex'] });
  writeJob(dir, { id: 'b', task: 't', files: ['sections/ch2.tex'] });
  writeJob(dir, { id: 'c', task: 't', files: ['main.tex'] });
  await waitFor(() => ['a', 'b', 'c'].every(id => readResult(dir, id)?.status === 'completed'));
  assert.equal(peak, 2, 'never more than maxWorkers concurrent');
  await broker.stop();
});

test('a chatty-but-never-completing worker is killed at the wall-clock deadline', async () => {
  const dir = makeWorkspace();
  const broker = createSubagentBroker({
    workspacePath: dir,
    // emits forever, never resolves — only the broker deadline can stop it
    runWorkerTask: abortableWorker(() => new Promise(() => {
      setInterval(() => {}, 5).unref();
    })),
    limits: { ...TINY, perWorkerTimeoutMs: 60 }
  });
  broker.start();
  writeJob(dir, { id: 'stuck', task: 't', files: ['sections/ch1.tex'] });
  await waitFor(() => readResult(dir, 'stuck'));
  assert.equal(readResult(dir, 'stuck').status, 'timeout');
  await broker.stop({ drain: false });
});

test('parent cancel aborts workers, cancels queued jobs, and marks the mirror dirty exactly once', async () => {
  const dir = makeWorkspace();
  const controller = new AbortController();
  let dirtyCalls = 0;
  const broker = createSubagentBroker({
    workspacePath: dir,
    signal: controller.signal,
    onMirrorDirty: () => { dirtyCalls += 1; },
    runWorkerTask: abortableWorker(() => new Promise(() => {})),
    limits: { ...TINY, maxWorkers: 1, perWorkerTimeoutMs: 5000, brokerBudgetMs: 60000 }
  });
  broker.start();
  writeJob(dir, { id: 'run-a', task: 't', files: ['sections/ch1.tex'] });
  writeJob(dir, { id: 'wait-b', task: 't', files: ['sections/ch2.tex'] });
  await waitFor(() => broker.hasActiveWorkers());
  controller.abort(new Error('user cancelled'));
  await waitFor(() => readResult(dir, 'run-a') && readResult(dir, 'wait-b'));
  assert.equal(readResult(dir, 'run-a').status, 'cancelled');
  assert.equal(readResult(dir, 'wait-b').status, 'cancelled');
  assert.equal(dirtyCalls, 1, 'markMirrorDirty hook fires once');
  assert.equal(JSON.parse(fs.readFileSync(path.join(queue(dir), 'broker.json'), 'utf8')).status, 'closed');
});

test('stop({drain}) gives workers a grace window then aborts the stragglers', async () => {
  const dir = makeWorkspace();
  const broker = createSubagentBroker({
    workspacePath: dir,
    runWorkerTask: abortableWorker(async ({ jobId }) => {
      if (jobId === 'quick') {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { assistantMessage: 'quick done' };
      }
      return new Promise(() => {});
    }),
    limits: { ...TINY, perWorkerTimeoutMs: 5000, brokerBudgetMs: 60000, drainGraceMs: 40 }
  });
  broker.start();
  writeJob(dir, { id: 'quick', task: 't', files: ['sections/ch1.tex'] });
  writeJob(dir, { id: 'slow', task: 't', files: ['sections/ch2.tex'] });
  await waitFor(() => broker.hasActiveWorkers());
  await broker.stop({ drain: true });
  assert.equal(readResult(dir, 'quick').status, 'completed');
  assert.equal(readResult(dir, 'slow').status, 'cancelled');
});

test('unowned changes during a wave become wave-level violations with suspects', async () => {
  const dir = makeWorkspace();
  const events = [];
  const broker = createSubagentBroker({
    workspacePath: dir,
    emit: (type, title, detail) => events.push({ type, detail }),
    runWorkerTask: abortableWorker(async ({ jobId }) => {
      fs.writeFileSync(path.join(dir, 'sections', 'ch1.tex'), 'mine');
      // rogue edit: a file NO job owns
      fs.writeFileSync(path.join(dir, 'main.tex'), 'rogue edit');
      return { assistantMessage: `done ${jobId}` };
    }),
    limits: TINY
  });
  broker.start();
  writeJob(dir, { id: 'ch1', title: 'ch1', task: 't', files: ['sections/ch1.tex'] });
  await waitFor(() => readResult(dir, 'ch1')?.status === 'completed');
  await waitFor(() => broker.getViolationPaths().has('main.tex'));
  const violation = broker.getAuditSummary().violations[0];
  assert.equal(violation.path, 'main.tex');
  assert.deepEqual(violation.suspects, ['ch1', 'parent'], 'wave-level attribution: suspects, not a named actor');
  assert.ok(events.some(e => e.type === 'codex.subagent.violation'));
  await broker.stop();
});

test('same-file jobs are serialized: admitted, never concurrent, both complete', async () => {
  const dir = makeWorkspace();
  let activeOnCh1 = 0;
  let peakOnCh1 = 0;
  const order = [];
  const broker = createSubagentBroker({
    workspacePath: dir,
    runWorkerTask: abortableWorker(async ({ jobId }) => {
      order.push(jobId);
      activeOnCh1 += 1;
      peakOnCh1 = Math.max(peakOnCh1, activeOnCh1);
      await new Promise(resolve => setTimeout(resolve, 25));
      activeOnCh1 -= 1;
      return { assistantMessage: `done ${jobId}` };
    }),
    limits: { ...TINY, maxWorkers: 3, perWorkerTimeoutMs: 5000, brokerBudgetMs: 60000 }
  });
  broker.start();
  writeJob(dir, { id: 'sec-a', title: 'Section A', task: 'polish ONLY section A of ch1', files: ['sections/ch1.tex'] });
  writeJob(dir, { id: 'sec-b', title: 'Section B', task: 'polish ONLY section B of ch1', files: ['sections/ch1.tex'] });
  await waitFor(() => readResult(dir, 'sec-a')?.status === 'completed' && readResult(dir, 'sec-b')?.status === 'completed');
  assert.equal(peakOnCh1, 1, 'same-file jobs must never overlap in time');
  assert.deepEqual(order, ['sec-a', 'sec-b'], 'FIFO order preserved for the contended file');
  await broker.stop();
});

test('an overlapping job waits while disjoint jobs still run in parallel', async () => {
  const dir = makeWorkspace();
  const running = new Set();
  let sawParallelDisjoint = false;
  const broker = createSubagentBroker({
    workspacePath: dir,
    runWorkerTask: abortableWorker(async ({ jobId }) => {
      running.add(jobId);
      if (running.has('a-ch1') && running.has('b-ch2')) {
        sawParallelDisjoint = true;
      }
      assert.equal(running.has('c-ch1-again') && running.has('a-ch1'), false, 'overlap must serialize');
      await new Promise(resolve => setTimeout(resolve, 30));
      running.delete(jobId);
      return { assistantMessage: 'ok' };
    }),
    limits: { ...TINY, maxWorkers: 3, perWorkerTimeoutMs: 5000, brokerBudgetMs: 60000 }
  });
  broker.start();
  writeJob(dir, { id: 'a-ch1', task: 't', files: ['sections/ch1.tex'] });
  writeJob(dir, { id: 'b-ch2', task: 't', files: ['sections/ch2.tex'] });
  writeJob(dir, { id: 'c-ch1-again', task: 't', files: ['sections/ch1.tex'] });
  await waitFor(() => ['a-ch1', 'b-ch2', 'c-ch1-again'].every(id => readResult(dir, id)?.status === 'completed'));
  assert.equal(sawParallelDisjoint, true, 'disjoint files still parallelize');
  await broker.stop();
});

test('single-file fan-out: jobs may own slice files in the work/ scratch zone', async () => {
  const dir = makeWorkspace();
  const events = [];
  const broker = createSubagentBroker({
    workspacePath: dir,
    emit: (type) => events.push(type),
    runWorkerTask: abortableWorker(async ({ prompt }) => {
      fs.writeFileSync(path.join(queue(dir), 'work', 'sec2.tex'), 'polished slice');
      return { assistantMessage: `prompt saw: ${prompt.includes('.codex-overleaf-subagents/work/sec2.tex')}` };
    }),
    limits: TINY
  });
  broker.start();
  // the lead scatters a slice into the broker-provisioned work/ zone...
  fs.writeFileSync(path.join(queue(dir), 'work', 'sec2.tex'), 'original section two text');
  // ...and a job that owns ONLY that slice
  writeJob(dir, { id: 'sec2', title: 'Polish section 2', task: 'polish the slice in place', files: ['.codex-overleaf-subagents/work/sec2.tex'], readOnlyContext: ['main.tex'] });
  await waitFor(() => readResult(dir, 'sec2')?.status === 'completed');
  const result = readResult(dir, 'sec2');
  assert.deepEqual(result.changedFiles, ['.codex-overleaf-subagents/work/sec2.tex']);
  assert.match(result.summary, /prompt saw: true/);
  // a mid-wave scratch write is NOT a violation: the queue zone never syncs
  assert.equal(broker.getViolationPaths().size, 0);
  await broker.stop();
});

test('queue control-plane paths are never ownable (only work/ slices are)', async () => {
  const dir = makeWorkspace();
  const broker = createSubagentBroker({
    workspacePath: dir,
    runWorkerTask: abortableWorker(async () => ({ assistantMessage: 'ok' })),
    limits: TINY
  });
  broker.start();
  writeJob(dir, { id: 'steal-jobs', task: 't', files: ['.codex-overleaf-subagents/jobs/x.json'] });
  writeJob(dir, { id: 'steal-broker', task: 't', files: ['.codex-overleaf-subagents/broker.json'] });
  writeJob(dir, { id: 'steal-results', task: 't', files: ['.codex-overleaf-subagents/results/r.json'] });
  await waitFor(() => readResult(dir, 'steal-jobs') && readResult(dir, 'steal-broker') && readResult(dir, 'steal-results'));
  assert.equal(readResult(dir, 'steal-jobs').reason, 'unsafe_path');
  assert.equal(readResult(dir, 'steal-broker').reason, 'unsafe_path');
  assert.equal(readResult(dir, 'steal-results').reason, 'unsafe_path');
  await broker.stop({ drain: false });
});

test('a worker that throws lands a failed result and emits codex.subagent.failed', async () => {
  const dir = makeWorkspace();
  const events = [];
  const broker = createSubagentBroker({
    workspacePath: dir,
    emit: (type) => events.push(type),
    runWorkerTask: abortableWorker(async () => { throw new Error('worker boom'); }),
    limits: { ...TINY, perWorkerTimeoutMs: 5000, brokerBudgetMs: 60000 }
  });
  broker.start();
  writeJob(dir, { id: 'boom', task: 't', files: ['sections/ch1.tex'] });
  await waitFor(() => readResult(dir, 'boom'));
  assert.equal(readResult(dir, 'boom').status, 'failed');
  assert.match(readResult(dir, 'boom').reason, /worker boom/);
  assert.ok(events.includes('codex.subagent.failed'), 'failed event emitted');
  await broker.stop({ drain: false });
});

test('validation rejects oversized, taskless, and fileless jobs', async () => {
  const dir = makeWorkspace();
  const broker = createSubagentBroker({
    workspacePath: dir,
    runWorkerTask: abortableWorker(async () => ({ assistantMessage: 'x' })),
    limits: { ...TINY, maxJobsPerRun: 8, perWorkerTimeoutMs: 1000, brokerBudgetMs: 60000 }
  });
  broker.start();
  // >32KB raw file → rejected before parse
  fs.writeFileSync(path.join(queue(dir), 'jobs', 'toobig.json'), JSON.stringify({ id: 'toobig', task: 'x'.repeat(40000), files: ['main.tex'] }));
  writeJob(dir, { id: 'notask', files: ['main.tex'] });
  writeJob(dir, { id: 'nofiles', task: 't' });
  await waitFor(() => readResult(dir, 'toobig') && readResult(dir, 'notask') && readResult(dir, 'nofiles'));
  assert.equal(readResult(dir, 'toobig').reason, 'job_too_large');
  assert.equal(readResult(dir, 'notask').reason, 'missing_task');
  assert.equal(readResult(dir, 'nofiles').reason, 'missing_files');
  await broker.stop({ drain: false });
});

test('a duplicate job id is rejected, keeping the first occurrence only', async () => {
  const dir = makeWorkspace();
  const broker = createSubagentBroker({
    workspacePath: dir,
    runWorkerTask: abortableWorker(() => new Promise(() => {})),
    limits: { ...TINY, maxWorkers: 1, perWorkerTimeoutMs: 5000, brokerBudgetMs: 60000 }
  });
  broker.start();
  // distinct filenames, same internal id → the second is a duplicate
  fs.writeFileSync(path.join(queue(dir), 'jobs', 'aa-dup.json'), JSON.stringify({ id: 'dup', task: 't', files: ['sections/ch1.tex'] }));
  fs.writeFileSync(path.join(queue(dir), 'jobs', 'bb-dup.json'), JSON.stringify({ id: 'dup', task: 't', files: ['sections/ch2.tex'] }));
  await waitFor(() => readResult(dir, 'dup')?.reason === 'duplicate_id');
  assert.equal(readResult(dir, 'dup').reason, 'duplicate_id');
  await broker.stop({ drain: false });
});

test("a timed-out worker's partial edits are withheld from writeback", async () => {
  const dir = makeWorkspace();
  const broker = createSubagentBroker({
    workspacePath: dir,
    runWorkerTask: abortableWorker(async () => {
      // leave a half-written file on disk, then hang until the deadline aborts us
      fs.writeFileSync(path.join(dir, 'sections', 'ch1.tex'), 'half-written, never finished');
      return new Promise(() => {});
    }),
    limits: { ...TINY, perWorkerTimeoutMs: 50 }
  });
  broker.start();
  writeJob(dir, { id: 'ch1', task: 'polish', files: ['sections/ch1.tex'] });
  await waitFor(() => readResult(dir, 'ch1')?.status === 'timeout');
  assert.deepEqual(readResult(dir, 'ch1').changedFiles, ['sections/ch1.tex']);
  assert.equal(broker.getViolationPaths().has('sections/ch1.tex'), true, 'partial edit withheld like a violation');
  await broker.stop({ drain: false });
});

test('stop() settles still-queued jobs as cancelled so a poll loop never hangs', async () => {
  const dir = makeWorkspace();
  const broker = createSubagentBroker({
    workspacePath: dir,
    // all jobs own ONE file -> serialized; with one running the rest stay queued
    runWorkerTask: abortableWorker(() => new Promise(() => {})),
    limits: { ...TINY, maxWorkers: 3, perWorkerTimeoutMs: 5000, brokerBudgetMs: 60000 }
  });
  broker.start();
  writeJob(dir, { id: 'q1', task: 't', files: ['sections/ch1.tex'] });
  writeJob(dir, { id: 'q2', task: 't', files: ['sections/ch1.tex'] });
  writeJob(dir, { id: 'q3', task: 't', files: ['sections/ch1.tex'] });
  await waitFor(() => broker.hasActiveWorkers());
  await broker.stop({ drain: false });
  assert.equal(readResult(dir, 'q2').status, 'cancelled');
  assert.equal(readResult(dir, 'q3').status, 'cancelled');
  assert.match(readResult(dir, 'q2').reason, /before this subagent started/);
});

test('audit summary captures jobs, statuses, and violations without task text', async () => {
  const dir = makeWorkspace();
  const broker = createSubagentBroker({
    workspacePath: dir,
    runWorkerTask: abortableWorker(async () => ({ assistantMessage: 'ok' })),
    limits: TINY
  });
  broker.start();
  writeJob(dir, { id: 'ch1', title: 'Polish ch1', task: 'SECRET TASK TEXT', files: ['sections/ch1.tex'] });
  await waitFor(() => readResult(dir, 'ch1')?.status === 'completed');
  await broker.stop();
  const summary = broker.getAuditSummary();
  assert.equal(summary.jobs[0].id, 'ch1');
  assert.equal(summary.jobs[0].status, 'completed');
  assert.equal(JSON.stringify(summary).includes('SECRET TASK TEXT'), false);
});
