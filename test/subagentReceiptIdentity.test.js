'use strict';

// Read-only filesystem-boundary diagnosis. Production code runs against an
// in-memory filesystem; no production write reaches the operating system.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');
const repo = path.resolve(__dirname, '..');

function memoryFilesystem() {
  const files = new Map();
  const directories = new Set(['/virtual']);
  const renames = [];
  const normalize = value => path.resolve(String(value));
  const api = {
    mkdirSync(value) {
      let cursor = normalize(value);
      while (!directories.has(cursor)) {
        directories.add(cursor);
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
      }
    },
    rmSync(value) {
      const target = normalize(value);
      for (const key of files.keys()) if (key === target || key.startsWith(target + path.sep)) files.delete(key);
      for (const key of directories) if (key === target || key.startsWith(target + path.sep)) directories.delete(key);
    },
    existsSync(value) {
      const key = normalize(value);
      return files.has(key) || directories.has(key);
    },
    readdirSync(value) {
      const target = normalize(value);
      return [...new Set([...files.keys(), ...directories].filter(key => key !== target && path.dirname(key) === target).map(key => path.basename(key)))];
    },
    statSync(value) {
      const key = normalize(value);
      if (!files.has(key)) throw Object.assign(new Error('memory ENOENT'), { code: 'ENOENT' });
      return { size: Buffer.byteLength(files.get(key)), isFile: () => true, isDirectory: () => false };
    },
    readFileSync(value, encoding) {
      const key = normalize(value);
      if (!files.has(key)) throw Object.assign(new Error('memory ENOENT'), { code: 'ENOENT' });
      return encoding ? files.get(key) : Buffer.from(files.get(key));
    },
    writeFileSync(value, content) {
      const key = normalize(value);
      assert.ok(directories.has(path.dirname(key)), 'virtual parent must exist');
      files.set(key, String(content));
    },
    renameSync(from, to) {
      const source = normalize(from), target = normalize(to);
      assert.ok(files.has(source), 'virtual rename source exists');
      assert.ok(directories.has(path.dirname(target)), 'virtual rename parent exists');
      const content = files.get(source);
      renames.push({ target, content });
      files.set(target, content);
      files.delete(source);
    }
  };
  return { api, files, renames };
}

function loadFactory(file, memory, context, overrides = {}) {
  const module = { exports: {} };
  const realRequire = createRequire(file);
  const source = fs.readFileSync(file, 'utf8');
  const requireForVm = id => {
    if (id === 'node:fs') return memory.api;
    if (Object.hasOwn(overrides, id)) return overrides[id];
    return realRequire(id);
  };
  const wrapper = vm.runInContext('(function(require,module,exports,__filename,__dirname){\n' + source + '\n})', context, { filename: file });
  wrapper(requireForVm, module, module.exports, file, path.dirname(file));
  return module.exports;
}

async function rejectionResult(id, { filename = 'input.json', rawPayload } = {}) {
  const memory = memoryFilesystem();
  const ticks = new Set();
  const context = vm.createContext({
    Buffer, console, AbortController,
    process: { env: {} },
    setInterval(fn) { ticks.add(fn); return fn; },
    clearInterval(fn) { ticks.delete(fn); },
    setTimeout() { throw new Error('No worker timeout should be scheduled for rejected jobs'); },
    clearTimeout() {}
  });
  const workspaceModule = loadFactory(path.join(repo, 'native-host/src/subagentWorkspace.js'), memory, context);
  const brokerModule = loadFactory(path.join(repo, 'native-host/src/subagentBroker.js'), memory, context, {
    './subagentWorkspace': workspaceModule
  });
  const workspace = '/virtual/project';
  const queue = path.join(workspace, brokerModule.SUBAGENT_QUEUE_DIR);
  const results = path.join(queue, 'results');
  let workerCalls = 0;
  const events = [];
  const broker = brokerModule.createSubagentBroker({
    workspacePath: workspace,
    runWorkerTask: async () => { workerCalls++; throw new Error('Rejected job must not start'); },
    emit: (...args) => events.push(args),
    env: {}
  });
  broker.start();
  try {
    // The queue filename is constant and safe; only the JSON identifier varies.
    memory.api.writeFileSync(path.join(queue, 'jobs', filename), rawPayload ?? JSON.stringify({ id, task: '', files: [] }));
    for (const tick of ticks) tick();
    const resultWrites = memory.renames.map(entry => ({ ...entry, value: JSON.parse(entry.content) })).filter(entry => entry.value.status === 'rejected');
    assert.equal(resultWrites.length, 1, 'real broker must reach rejection writer');
    assert.equal(workerCalls, 0);
    assert.ok(events.some(event => event[0] === 'codex.subagent.rejected'));
    const entry = resultWrites[0];
    const relativeTarget = path.relative(results, entry.target);
    const confined = !path.isAbsolute(relativeTarget) && relativeTarget !== '..' && !relativeTarget.startsWith('..' + path.sep);
    const evidence = { identifier: id, receiptId: entry.value.id, reason: entry.value.reason, relativeTarget, confined, workerCalls };
    return evidence;
  } finally {
    await broker.stop({ drain: false });
    assert.equal(ticks.size, 0, 'virtual polling cleaned up');
  }
}

test('safe IDs preserve ordinary rejection receipt lookup', async () => {
  const result = await rejectionResult('safe-id');
  assert.equal(result.reason, 'missing_task');
  assert.equal(result.receiptId, 'safe-id');
  assert.equal(result.relativeTarget, 'safe-id.json');
  assert.equal(result.confined, true);
});

test('invalid job identifiers use a safe queue-filename identity for rejection', async t => {
  for (const id of ['../receipt', '../../receipt', 'BAD ID', '..\\receipt', 'x'.repeat(33), '', null]) {
    await t.test(JSON.stringify(id), async () => {
      const result = await rejectionResult(id);
      assert.equal(result.reason, 'invalid_id');
      assert.equal(result.confined, true, 'rejected ID must not select a destination outside results');
      assert.equal(result.receiptId, 'input', 'invalid identifiers must use the safe queue filename');
      assert.equal(result.relativeTarget, 'input.json');
    });
  }
});

test('malformed jobs with unsafe queue filenames retain a safe rejection receipt', async t => {
  for (const filename of ['BAD NAME.json', '.json', 'x'.repeat(40) + '.json']) {
    await t.test(filename, async () => {
      const result = await rejectionResult(undefined, { filename, rawPayload: 'malformed JSON' });
      assert.equal(result.reason, 'invalid_json');
      assert.equal(result.confined, true);
      assert.match(result.receiptId, /^[a-z0-9-]{1,32}$/);
      assert.equal(result.relativeTarget, result.receiptId + '.json');
    });
  }
});

test('malformed JSON with a safe filename retains the expected receipt identity', async () => {
  const result = await rejectionResult(undefined, { filename: 'known-job.json', rawPayload: 'malformed JSON' });
  assert.equal(result.receiptId, 'known-job');
  assert.equal(result.reason, 'invalid_json');
});
