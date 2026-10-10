'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const runner = import(pathToFileURL(path.join(__dirname, '../scripts/run-tests.mjs')).href);
const files = ['test/releaseScripts.test.js', 'test/binaryAssetUploader.test.js', 'test/textPatch.test.js'];

test('default test selection includes every discovered file in release-priority order', async () => {
  const { selectTestFiles } = await runner;
  assert.deepEqual(selectTestFiles(files), { files, mode: 'full', listOnly: false });
});

test('focused tests accept known paths or basenames, deduplicate, and preserve runner order', async () => {
  const { selectTestFiles } = await runner;
  assert.deepEqual(selectTestFiles(files, ['textPatch.test.js', 'test\\binaryAssetUploader.test.js', 'test/textPatch.test.js']), {
    files: files.slice(1), mode: 'focused', listOnly: false
  });
});

test('the CLI lists and executes a selected file using the real platform inventory', () => {
  const script = path.resolve(__dirname, '../scripts/run-tests.mjs');
  const cwd = path.resolve(__dirname, '..');
  const listed = spawnSync(process.execPath, [script, '--list', 'test\\textPatch.test.js'], { cwd, encoding: 'utf8', timeout: 10000 });
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout.trim(), 'test/textPatch.test.js');
  const executed = spawnSync(process.execPath, [script, 'test/textPatch.test.js'], { cwd, encoding: 'utf8', timeout: 10000 });
  assert.equal(executed.status, 0, executed.stdout + executed.stderr);
  assert.match(executed.stderr, /focused: 1\/1 files executed, 1 passed/);
});

test('test-list mode reports its scope without changing the selected files', async () => {
  const { selectTestFiles } = await runner;
  assert.deepEqual(selectTestFiles(files, ['--list']), { files, mode: 'full', listOnly: true });
  assert.equal(selectTestFiles(files, ['--list', 'textPatch.test.js']).mode, 'focused');
});

test('unknown options, missing paths, traversal, globs and empty discovery fail closed', async () => {
  const { selectTestFiles } = await runner;
  for (const args of [['--unknown'], ['typo.test.js'], ['../test/textPatch.test.js'], ['test/*.test.js']]) {
    assert.throws(() => selectTestFiles(files, args), /Unknown/);
  }
  assert.throws(() => selectTestFiles([], []), /No test files/);
  assert.throws(() => selectTestFiles(files, ['--fast', 'textPatch.test.js']), /not both/);
});

test('fast checks are an explicit subset and cannot silently lose a renamed critical test', async () => {
  const { selectTestFiles } = await runner;
  const all = fs.readdirSync(__dirname).filter(name => name.endsWith('.test.js')).sort().map(name => `test/${name}`);
  const selected = selectTestFiles(all, ['--fast', '--list']);
  assert.equal(selected.mode, 'fast');
  assert.equal(selected.listOnly, true);
  assert.ok(selected.files.length < all.length);
  for (const name of ['textPatch', 'undoOperations', 'staleGuard', 'modelSelectionRecovery', 'runTimelineUndoAvailability']) {
    assert.ok(selected.files.includes(`test/${name}.test.js`), name);
  }
  assert.ok(!selected.files.includes('test/releaseScripts.test.js'));
  assert.throws(() => selectTestFiles(all.filter(file => file !== selected.files[0]), ['--fast']), /missing test file/);
});

test('timing summary retains failures and partial execution without mutating results', async () => {
  const { formatTimingSummary } = await runner;
  const results = [
    { testFile: 'test/fast.test.js', elapsedMs: 5, status: 0 },
    { testFile: 'test/slow.test.js', elapsedMs: 50, status: 0, timedOut: true }
  ];
  const before = JSON.stringify(results);
  const summary = formatTimingSummary({ mode: 'full', results, totalFiles: 4, elapsedMs: 55 });
  assert.match(summary, /2\/4 files executed, 1 passed/);
  assert.ok(summary.indexOf('slow.test.js') < summary.indexOf('fast.test.js'));
  assert.equal(JSON.stringify(results), before);
});
