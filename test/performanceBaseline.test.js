const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  MAX_NATIVE_OUTPUT_MESSAGE_BYTES
} = require('../native-host/src/nativeMessaging');

const repoRoot = path.resolve(__dirname, '..');

test('large project benchmark writes required JSON metrics within native frame budget', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-perf-test-'));
  const outputPath = path.join(tempDir, 'metrics.json');
  try {
    const result = runBenchmark(['--output', outputPath]);
    assert.equal(result.status, 0, formatProcessFailure(result));

    const report = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(report.version, 1);
    assert.doesNotThrow(() => new Date(report.createdAt).toISOString());
    assert.equal(report.fixture.textFileCount >= 250, true);
    assert.equal(report.fixture.longTexFileCount >= 10, true);
    assert.equal(report.fixture.longTexBytesMin >= 1024 * 1024, true);
    assert.equal(report.fixture.longTexBytesMax <= 1200 * 1024, true);
    assert.equal(report.fixture.nestedMaxDepth >= 3, true);
    assert.deepEqual(new Set(report.fixture.binaryTypes), new Set(['pdf', 'png', 'svg']));
    assert.equal(report.fixture.oversizedSkippedBinaryCount >= 1, true);
    assert.equal(report.fixture.repeatedSessionCount >= 2, true);
    assert.deepEqual(report.fixture.stateFixtures, {
      repeatedFullSync: true,
      partialSnapshot: true,
      mirrorStatusChecked: true,
      oversizedSkippedBinary: true,
      repeatedState: true
    });
    assert.deepEqual(report.fixture.repeatedState, {
      sessionCount: 12,
      runsPerSession: 10,
      eventsPerRun: 120,
      totalRunCount: 120,
      totalEventCount: 14400
    });
    assert.equal(report.fixture.repeatedStateBytes > 0, true);
    assert.equal(report.fixture.mirrorSyncSamplesMs.length, 3);
    const orderedSyncSamples = [...report.fixture.mirrorSyncSamplesMs].sort((left, right) => left - right);
    assert.equal(report.metrics['mirror.sync_ms'], orderedSyncSamples[1]);
    assert.equal(report.fixture.fileCount >= report.fixture.textFileCount + 3, true);
    assert.equal(report.fixture.textBytes > 0, true);
    assert.equal(report.fixture.binaryBytes > 0, true);
    assert.equal(report.metrics['snapshot.file_count'], report.fixture.fileCount);
    assert.equal(report.metrics['snapshot.text_bytes'], report.fixture.textBytes);
    assert.equal(report.metrics['snapshot.binary_bytes'], report.fixture.binaryBytes);
    assert.deepEqual(report.failures, []);
    assert.equal(Array.isArray(report.warnings), true);

    for (const key of [
      'snapshot.total_ms',
      'snapshot.zip_parse_ms',
      'snapshot.file_count',
      'snapshot.text_bytes',
      'snapshot.binary_bytes',
      'snapshot.payload_json_bytes',
      'mirror.sync_ms',
      'mirror.status_ms',
      'mirror.collect_ms',
      'mirror.baseline_json_bytes',
      'mirror.hashed_bytes',
      'state.generate_ms',
      'native.output_frame_bytes',
      'diff.compute_ms',
      'patch.compute_ms',
      'context_tray.render_ms',
      'storage.prepare_ms',
      'storage.compact_bytes'
    ]) {
      assert.equal(typeof report.metrics[key], 'number', `${key} must be numeric`);
      assert.equal(Number.isFinite(report.metrics[key]), true, `${key} must be finite`);
      assert.equal(report.metrics[key] >= 0, true, `${key} must be non-negative`);
    }
    assert.equal(report.metrics['native.output_frame_bytes'] <= MAX_NATIVE_OUTPUT_MESSAGE_BYTES, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('large project benchmark timing thresholds fail only in strict mode', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-perf-test-'));
  try {
    const softOutputPath = path.join(tempDir, 'soft.json');
    const softResult = runBenchmark(['--max-sync-ms', '-1', '--output', softOutputPath]);
    assert.equal(softResult.status, 0, formatProcessFailure(softResult));
    const softReport = JSON.parse(fs.readFileSync(softOutputPath, 'utf8'));
    assert.equal(softReport.failures.length, 0);
    assert.equal(softReport.warnings.some(warning => warning.code === 'timing_threshold_exceeded'), true);

    const strictOutputPath = path.join(tempDir, 'strict.json');
    const strictResult = runBenchmark(['--strict', '--max-sync-ms', '-1', '--output', strictOutputPath]);
    assert.notEqual(strictResult.status, 0);
    assert.match(strictResult.stderr, /Synthetic large-project regression gate failed/);
    assert.match(strictResult.stderr, /timing_threshold_exceeded/);
    assert.match(strictResult.stderr, /mirror\.sync_ms/);
    const strictReport = JSON.parse(fs.readFileSync(strictOutputPath, 'utf8'));
    assert.equal(strictReport.failures.some(failure => failure.code === 'timing_threshold_exceeded'), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('large project benchmark honors CODEX_OVERLEAF_PERF_STRICT env strict mode', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-perf-test-'));
  try {
    const outputPath = path.join(tempDir, 'env-strict.json');
    const result = runBenchmark(['--max-sync-ms', '-1', '--output', outputPath], {
      env: { CODEX_OVERLEAF_PERF_STRICT: '1' }
    });
    assert.notEqual(result.status, 0);
    const report = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(report.failures.some(failure => failure.code === 'timing_threshold_exceeded'), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function runBenchmark(args, options = {}) {
  return spawnSync(process.execPath, ['scripts/benchmark-large-project.mjs', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8'
  });
}

function formatProcessFailure(result) {
  return [
    `status=${result.status}`,
    result.stdout ? `stdout:\n${result.stdout}` : '',
    result.stderr ? `stderr:\n${result.stderr}` : ''
  ].filter(Boolean).join('\n');
}
