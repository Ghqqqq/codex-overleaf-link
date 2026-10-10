#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), '..');
const testDir = path.join(rootDir, 'test');
const TEST_FILE_TIMEOUT_MS = Number.parseInt(process.env.CODEX_OVERLEAF_TEST_FILE_TIMEOUT_MS || '600000', 10);
const DEFAULT_RELEASE_SCRIPTS_TEST_TIMEOUT_MS = process.platform === 'win32' ? 420000 : 120000;
const RELEASE_SCRIPTS_TEST_TIMEOUT_MS = Number.parseInt(
  process.env.CODEX_OVERLEAF_RELEASE_SCRIPTS_TEST_TIMEOUT_MS || String(DEFAULT_RELEASE_SCRIPTS_TEST_TIMEOUT_MS),
  10
);
const RELEASE_SCRIPTS_SUBTEST_TIMEOUT_MS = Number.parseInt(
  process.env.CODEX_OVERLEAF_RELEASE_SCRIPTS_SUBTEST_TIMEOUT_MS || '30000',
  10
);
const HIGH_PRIORITY_TEST_FILE_NAMES = new Set([
  'releaseScripts.test.js'
]);
const FAST_TEST_FILE_NAMES = new Set([
  'binaryAssetUploader.test.js',
  'contentBuildIdentity.test.js',
  'managedUpdateProjection.test.js',
  'modelSelectionRecovery.test.js',
  'nativeTransportEnvelope.test.js',
  'nativeTransportEnvelopeFallback.test.js',
  'referenceInventoryPersistence.test.js',
  'runExecutionSnapshot.test.js',
  'runTimelineStatus.test.js',
  'runTimelineUndoAvailability.test.js',
  'scopedPersistenceQueueOwnership.test.js',
  'sessionState.test.js',
  'staleGuard.test.js',
  'testRunnerSelection.test.js',
  'textPatch.test.js',
  'textFileCreator.test.js',
  'undoMirrorInvalidation.test.js',
  'undoOperations.test.js',
  'writeGuard.test.js'
]);

export function selectTestFiles(allFiles, args = []) {
  const requested = [];
  let fast = false;
  let listOnly = false;
  for (const arg of args) {
    if (arg === '--fast') fast = true;
    else if (arg === '--list') listOnly = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown test option: ${arg}`);
    else requested.push(arg.replace(/\\/g, '/'));
  }
  if (fast && requested.length) throw new Error('Choose --fast or explicit test files, not both.');
  const names = fast ? [...FAST_TEST_FILE_NAMES] : requested;
  const selected = new Set(names.map(name => name.startsWith('test/') ? name : `test/${name}`));
  const known = new Set(allFiles);
  for (const name of selected) {
    if (!known.has(name)) throw new Error(`Unknown or missing test file: ${name}`);
  }
  const files = selected.size ? allFiles.filter(file => selected.has(file)) : [...allFiles];
  if (!files.length) throw new Error('No test files selected.');
  return { files, listOnly, mode: fast ? 'fast' : requested.length ? 'focused' : 'full' };
}

export function formatTimingSummary({ mode, results, totalFiles, elapsedMs }) {
  const passed = results.filter(result => result.status === 0 && !result.timedOut && !result.error).length;
  const lines = [`[run-tests] ${mode}: ${results.length}/${totalFiles} files executed, ${passed} passed, ${elapsedMs}ms elapsed.`];
  for (const result of [...results].sort((left, right) => right.elapsedMs - left.elapsedMs).slice(0, 5)) {
    lines.push(`[run-tests] slowest: ${result.testFile} ${result.elapsedMs}ms`);
  }
  return lines.join('\n');
}

async function main() {
  const allFiles = fs.readdirSync(testDir)
  .filter((fileName) => fileName.endsWith('.test.js'))
  .sort()
  .map((fileName) => path.posix.join('test', fileName))
  .sort((left, right) => getTestFilePriority(left) - getTestFilePriority(right) || left.localeCompare(right));
  let selection;
  try {
    selection = selectTestFiles(allFiles, process.argv.slice(2));
  } catch (error) {
    console.error(`[run-tests] ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const { files: testFiles, mode } = selection;
  if (selection.listOnly) {
    console.error(`[run-tests] Listing ${mode} selection; no tests executed.`);
    console.log(testFiles.join('\n'));
    return;
  }
  if (mode !== 'full') {
    console.error(`[run-tests] ${mode.toUpperCase()} SUBSET: ${testFiles.length}/${allFiles.length} files. This does not replace full release validation.`);
  }
  const useTestIsolationNone = supportsNodeOption('--test-isolation=none');
  const results = [];
  const suiteStartedAt = Date.now();
  const printSummary = () => console.error(formatTimingSummary({
    mode, results, totalFiles: testFiles.length, elapsedMs: Date.now() - suiteStartedAt
  }));
  for (const testFile of testFiles) {
  const startedAt = Date.now();
  const nodeArgs = getNodeTestArgs(testFile, useTestIsolationNone);
  const timeoutMs = getTestFileTimeoutMs(testFile);
  console.error(`[run-tests] starting ${testFile} (${nodeArgs.join(' ')}, timeout=${timeoutMs}ms)`);
  const result = await runNodeTestFile({ testFile, nodeArgs, timeoutMs });
  results.push({ testFile, elapsedMs: Date.now() - startedAt, ...result });

  if (result.error) {
    printSummary();
    throw result.error;
  }

  if (result.timedOut) {
    console.error(`Test file timed out after ${timeoutMs}ms: ${testFile}`);
    printSummary();
    process.exit(1);
  }

  if (result.status !== 0) {
    printSummary();
    process.exit(result.status ?? 1);
  }

  console.error(`[run-tests] passed ${testFile} in ${Date.now() - startedAt}ms`);
  }
  printSummary();
}

async function runNodeTestFile({ testFile, nodeArgs, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, nodeArgs, {
      cwd: rootDir,
      stdio: 'inherit',
      detached: process.platform !== 'win32'
    });
    let timedOut = false;
    let forceExitTimer = null;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      console.error(`[run-tests] timeout reached for ${testFile}; killing test process tree pid=${child.pid}`);
      killProcessTree(child);
      forceExitTimer = setTimeout(() => {
        console.error(`[run-tests] ${testFile} did not exit after kill; forcing runner exit`);
        process.exit(1);
      }, 5000);
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timeoutTimer);
      clearTimeout(forceExitTimer);
      resolve({ status: null, signal: null, timedOut, error });
    });
    child.on('close', (status, signal) => {
      clearTimeout(timeoutTimer);
      clearTimeout(forceExitTimer);
      resolve({ status, signal, timedOut, error: null });
    });
  });
}

function killProcessTree(child) {
  if (!child.pid) {
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Nothing else to do; the force-exit timer will fail the runner.
    }
  }
}

function getTestFilePriority(testFile) {
  return HIGH_PRIORITY_TEST_FILE_NAMES.has(path.basename(testFile)) ? 0 : 1;
}

function getTestFileTimeoutMs(testFile) {
  if (path.basename(testFile) === 'releaseScripts.test.js') {
    return RELEASE_SCRIPTS_TEST_TIMEOUT_MS;
  }
  return TEST_FILE_TIMEOUT_MS;
}

function getNodeTestArgs(testFile, useTestIsolationNone) {
  const args = ['--test', '--test-concurrency=1'];
  if (useTestIsolationNone) {
    // run-tests.mjs already gives every test file its own subprocess. Keeping
    // Node's inner per-file isolation process adds a second lifecycle boundary;
    // on hosted macOS it can keep the file wrapper alive after releaseScripts
    // finishes, which makes CI look hung until the outer timeout kills it.
    args.push('--test-isolation=none');
  }
  if (path.basename(testFile) === 'releaseScripts.test.js') {
    args.push(`--test-timeout=${RELEASE_SCRIPTS_SUBTEST_TIMEOUT_MS}`);
  }
  args.push(testFile);
  return args;
}

function supportsNodeOption(option) {
  const result = spawnSync(process.execPath, [option, '--version'], {
    encoding: 'utf8',
    stdio: 'ignore'
  });
  return result.status === 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  await main();
}
