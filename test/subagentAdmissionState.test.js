'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSubagentBroker, SUBAGENT_QUEUE_DIR } = require('../native-host/src/subagentBroker');

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture(t, limits = {}, { ignoreAbort = false } = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-admission-state-'));
  fs.mkdirSync(path.join(workspace, 'sections'));
  for (const file of ['main.tex', ...Array.from({ length: 8 }, (_, i) => `sections/ch${i}.tex`)]) {
    fs.writeFileSync(path.join(workspace, file), file);
  }
  const active = new Map(), starts = [], events = [];
  let stopFailureExpected = false;
  const broker = createSubagentBroker({
    workspacePath: workspace,
    limits: { maxWorkers: 3, maxJobsPerRun: 8, perWorkerTimeoutMs: 5000,
      brokerBudgetMs: 16000, pollIntervalMs: 60000, drainGraceMs: 20, ...limits },
    emit: (type, title, detail) => events.push({ type, detail }),
    runWorkerTask: ({ jobId, prompt, signal }) => new Promise((resolve, reject) => {
      starts.push({ jobId, prompt });
      active.set(jobId, () => resolve({ assistantMessage: `finished ${jobId}` }));
      if (!ignoreAbort) signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })
  });
  broker.start();
  t.after(async () => {
    try { await broker.stop({ drain: false }); }
    catch (error) { if (!stopFailureExpected) throw error; assert.equal(error.code, 'subagent_io_failed'); }
    finally { fs.rmSync(workspace, { recursive: true, force: true }); }
  });
  const root = path.join(workspace, SUBAGENT_QUEUE_DIR);
  function read(name) {
    const file = path.join(root, name);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  }
  return { broker, workspace, root, starts, events,
    expectStopFailure() { stopFailureExpected = true; },
    submit(id, files) {
      fs.writeFileSync(path.join(root, 'jobs', `${id}.json`), JSON.stringify({ id, task: 'Inspect the owned files.', files }));
    },
    result: id => read(`results/${id}.json`), handshake: () => read('broker.json'),
    async finish(id) { assert.ok(active.has(id)); active.get(id)(); await flush(); }
  };
}

test('broker handshake follows each active worker start and exit without granting adoption mid-wave', async t => {
  const h = fixture(t);
  assert.equal(h.handshake().activeWorkers, 0);
  h.submit('a', ['main.tex']); h.broker.pollOnce();
  assert.equal(h.handshake().activeWorkers, 1);
  assert.equal(h.handshake().adoptionToken, '');
  h.submit('b', ['sections/ch0.tex']); h.broker.pollOnce();
  assert.equal(h.handshake().activeWorkers, 2);
  await h.finish('a');
  assert.equal(h.handshake().activeWorkers, 1);
  assert.equal(h.handshake().adoptionToken, '');
  await h.finish('b');
  assert.equal(h.handshake().activeWorkers, 0);
  assert.match(h.handshake().adoptionToken, /^[a-f0-9]{48}$/);
  h.submit('c', ['main.tex']); h.broker.pollOnce();
  assert.equal(h.handshake().activeWorkers, 1);
  assert.equal(h.handshake().adoptionToken, '');
  await h.broker.stop({ drain: false });
  assert.equal(h.handshake().status, 'closed');
  assert.equal(h.handshake().activeWorkers, 0);
});

test('same-file jobs reserve sequential worker budgets at actual broker admission', async t => {
  const h = fixture(t);
  for (let i = 0; i < 4; i++) h.submit(`job-${i}`, ['main.tex']);
  h.broker.pollOnce();
  assert.equal(h.result('job-3')?.reason, 'insufficient_time');
  assert.deepEqual(h.starts.map(x => x.jobId), ['job-0']);
  for (let i = 0; i < 3; i++) {
    assert.equal(h.result(`job-${i}`), null);
    await h.finish(`job-${i}`);
  }
  assert.deepEqual(h.starts.map(x => x.jobId), ['job-0', 'job-1', 'job-2']);
});

test('disjoint jobs retain parallel admission capacity and the FIFO skip scheduler', async t => {
  const h = fixture(t);
  for (let i = 0; i < 8; i++) h.submit(`job-${i}`, [`sections/ch${i}.tex`]);
  h.broker.pollOnce();
  assert.equal(h.events.filter(x => x.type === 'codex.subagent.rejected').length, 0);
  assert.deepEqual(h.starts.map(x => x.jobId), ['job-0', 'job-1', 'job-2']);
  for (let i = 0; i < 8; i++) await h.finish(`job-${i}`);
  assert.equal(h.starts.length, 8);
});

test('conflicting queued jobs reserve time behind a running worker while disjoint work can still start', async t => {
  const h = fixture(t);
  h.submit('a', ['main.tex']); h.broker.pollOnce();
  for (const id of ['b', 'c', 'd']) h.submit(id, ['main.tex']);
  h.submit('e', ['sections/ch0.tex']); h.broker.pollOnce();
  assert.equal(h.result('d')?.reason, 'insufficient_time');
  assert.deepEqual(h.starts.map(x => x.jobId), ['a', 'e']);
  assert.equal(h.result('b'), null); assert.equal(h.result('c'), null);
});

test('dot aliases share one broker ownership identity and serialize the same physical file', async t => {
  const h = fixture(t);
  h.submit('a', ['sections/ch0.tex']);
  h.submit('b', ['./sections/./ch0.tex']);
  h.submit('c', ['sections/ch1.tex']);
  h.broker.pollOnce();
  assert.deepEqual(h.starts.map(x => x.jobId), ['a', 'c']);
  await h.finish('a');
  assert.deepEqual(h.starts.map(x => x.jobId), ['a', 'c', 'b']);
  assert.match(h.starts.at(-1).prompt, /modify ONLY these files: sections\/ch0\.tex\./);
  await h.finish('b');
  assert.deepEqual(h.result('b').changedFiles, []);
});

test('dot aliases cannot declare broker control files, while legitimate scratch ownership remains supported', async t => {
  const h = fixture(t);
  fs.writeFileSync(path.join(h.root, 'work', 'slice.tex'), 'slice');
  h.submit('control', ['././.codex-overleaf-subagents/./broker.json']);
  h.submit('scratch', ['./.codex-overleaf-subagents/./work/./slice.tex']);
  h.submit('parent', ['sections/../main.tex']);
  h.submit('empty', ['sections//ch0.tex']);
  h.broker.pollOnce();
  for (const id of ['control', 'parent', 'empty']) assert.equal(h.result(id)?.reason, 'unsafe_path', id);
  assert.deepEqual(h.starts.map(x => x.jobId), ['scratch']);
  assert.match(h.starts[0].prompt, /modify ONLY these files: \.codex-overleaf-subagents\/work\/slice\.tex\./);
});

test('admission counts canonical aliases as serial work in the same-file budget', t => {
  const h = fixture(t);
  const names = ['main.tex', './main.tex', '././main.tex', './././main.tex'];
  names.forEach((name, i) => h.submit(`job-${i}`, [name]));
  h.broker.pollOnce();
  assert.equal(h.result('job-3')?.reason, 'insufficient_time');
  assert.deepEqual(h.starts.map(x => x.jobId), ['job-0']);
});

test('late settlement refreshes the active count without reopening a closed broker or granting adoption', async t => {
  const h = fixture(t, { drainGraceMs: 1 }, { ignoreAbort: true });
  h.submit('a', ['main.tex']); h.submit('b', ['sections/ch0.tex']); h.broker.pollOnce();
  try {
    await h.broker.stop({ drain: false });
    assert.equal(h.handshake().status, 'closed'); assert.equal(h.handshake().activeWorkers, 2);
    await h.finish('a');
    assert.equal(h.handshake().status, 'closed'); assert.equal(h.handshake().activeWorkers, 1);
    await h.finish('b');
    assert.equal(h.handshake().status, 'closed'); assert.equal(h.handshake().activeWorkers, 0);
    assert.equal(h.handshake().adoptionToken, '');
    assert.equal(h.result('a').status, 'cancelled'); assert.equal(h.result('b').status, 'cancelled');
  } finally { await h.finish('a'); await h.finish('b'); }
});

test('handshake I/O failure after worker registration still stops and reports the owned worker', async t => {
  const h = fixture(t), rename = fs.renameSync;
  h.expectStopFailure();
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === path.join(h.root, 'broker.json') && h.broker.hasActiveWorkers()) {
      throw Object.assign(new Error('Synthetic handshake write failure'), { code: 'EIO' });
    }
    return rename(source, target);
  });
  h.submit('a', ['main.tex']); h.submit('b', ['sections/ch0.tex']); h.broker.pollOnce();
  assert.deepEqual(h.starts.map(x => x.jobId), ['a']);
  await assert.rejects(h.broker.stop({ drain: false }), { code: 'subagent_io_failed' });
  assert.equal(h.broker.hasActiveWorkers(), false);
  assert.equal(h.result('a').status, 'cancelled');
  assert.equal(h.result('b').status, 'cancelled');
  assert.equal(h.handshake().status, 'closed');
});

test('asynchronous completion order rechecks remaining admission budget before starting a queued job', async t => {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  const h = fixture(t, { maxWorkers: 2, perWorkerTimeoutMs: 10000, brokerBudgetMs: 40000 });
  const files = [['d'], ['d', 'e'], ['a', 'c'], ['b', 'e'], ['c'], ['c', 'd'], ['a', 'd']];
  for (const file of ['a', 'b', 'c', 'd', 'e']) fs.writeFileSync(path.join(h.workspace, file), file);
  files.forEach((paths, i) => h.submit(`job-${i}`, paths));
  h.broker.pollOnce();
  assert.equal(h.events.filter(x => x.type === 'codex.subagent.rejected').length, 0);
  // FIFO-skip needs four synchronized waves, yet this legal completion order
  // would start the last job at 31 seconds with only nine seconds remaining.
  for (const [id, elapsed] of [[2, 1000], [0, 6000], [3, 11000], [4, 16000], [1, 21000], [5, 31000]]) {
    now = 100000 + elapsed;
    await h.finish(`job-${id}`);
  }
  assert.deepEqual(h.starts.map(x => x.jobId), ['job-0', 'job-2', 'job-3', 'job-4', 'job-1', 'job-5']);
  assert.equal(h.result('job-6')?.reason, 'insufficient_time');
  assert.equal(h.broker.hasActiveWorkers(), false);
});
