#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  SAFE_INLINE_BINARY_CHANGE_BYTES,
  collectMirrorChangesDetailed,
  getMirrorStatus,
  getProjectMirror,
  syncOverleafToMirror
} = require('../native-host/src/mirrorWorkspace');
const {
  MAX_NATIVE_OUTPUT_MESSAGE_BYTES,
  encodeMessage
} = require('../native-host/src/nativeMessaging');
const { computeLineDiff } = require('../native-host/src/diffEngine');
const { computeTextPatches } = require('../native-host/src/textPatch');

const DEFAULT_TEXT_FILE_COUNT = 250;
const LONG_TEX_FILE_COUNT = 10;
const LONG_TEX_TARGET_BYTES = 1024 * 1024;
const OVERSIZED_SKIPPED_BINARY_BYTES = 11 * 1024 * 1024;
const REPEATED_STATE_SESSION_COUNT = 12;
const REPEATED_STATE_RUNS_PER_SESSION = 10;
const REPEATED_STATE_EVENTS_PER_RUN = 120;
const MIRROR_SYNC_SAMPLE_COUNT = 3;
const DEFAULT_MAX_SNAPSHOT_MS = 5000;
const DEFAULT_MAX_SYNC_MS = 3000;
const DEFAULT_MAX_STATUS_MS = 500;
const DEFAULT_MAX_COLLECT_MS = 2500;
const DEFAULT_MAX_DIFF_PATCH_MS = 1000;
const DEFAULT_MAX_CONTEXT_TRAY_MS = 500;
const DEFAULT_MAX_STORAGE_PREPARE_MS = 500;
const REQUIRED_METRIC_KEYS = [
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
];

export async function runBenchmark(options = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-overleaf-large-project-'));
  const projectIdPrefix = `benchmark-${process.pid}-${Date.now()}`;
  let projectId = '';
  const oversizedPath = 'figures/native-limit-large.pdf';
  const syncState = {
    repeatedSessionCount: 0,
    partialSnapshot: false,
    oversizedSkippedBinaryCount: 0
  };
  let fixtureMeasurement;
  let snapshotPayloadMeasurement;
  let snapshotParseMeasurement;
  let syncMeasurement;
  let statusMeasurement;
  let collectMeasurement;
  let stateMeasurement;
  let contextTrayMeasurement;
  let storageMeasurement;
  let diffMeasurement;
  let patchMeasurement;
  let compactStorageBytes = 0;
  let mirrorBaselineJsonBytes = 0;
  let mirrorHashedBytes = 0;
  let nativeOutputBytes = 0;
  let collected = { changes: [], unsupportedChanges: [] };
  let mirrorSyncSamplesMs = [];

  try {
    fixtureMeasurement = await measureAsync(() => createLargeProjectFixture({
      textFileCount: options.textFileCount || options.fileCount
    }));
    const fixture = fixtureMeasurement.value;
    snapshotPayloadMeasurement = await measureAsync(() => JSON.stringify({
      files: fixture.files
    }));
    snapshotParseMeasurement = await measureAsync(() => JSON.parse(snapshotPayloadMeasurement.value));
    contextTrayMeasurement = await measureAsync(() => renderContextTrayFixture(snapshotParseMeasurement.value.files));

    stateMeasurement = await measureAsync(() => createRepeatedSessionStateFixture());
    const repeatedState = summarizeRepeatedSessionStateFixture(stateMeasurement.value);
    storageMeasurement = await measureAsync(() => prepareStorageStateFixture(stateMeasurement.value));
    compactStorageBytes = Buffer.byteLength(JSON.stringify(compactStorageStateFixture(storageMeasurement.value)), 'utf8');

    const diffPreviousContent = buildRegularTexDocument('diff-before');
    const diffNextContent = `${diffPreviousContent}\n% benchmark diff measurement\n`;
    diffMeasurement = await measureAsync(() => computeLineDiff(diffPreviousContent, diffNextContent));
    patchMeasurement = await measureAsync(() => computeTextPatches(diffPreviousContent, diffNextContent));

    const syncSamples = [];
    for (let sampleIndex = 0; sampleIndex < MIRROR_SYNC_SAMPLE_COUNT; sampleIndex += 1) {
      const sampleProjectId = `${projectIdPrefix}-sync-${sampleIndex + 1}`;
      const measurement = await measureAsync(() => runMirrorSyncScenario({
        projectId: sampleProjectId,
        rootDir,
        fixture
      }));
      syncSamples.push({ ...measurement, projectId: sampleProjectId });
    }
    syncMeasurement = selectMedianMeasurement(syncSamples);
    mirrorSyncSamplesMs = syncSamples.map(sample => roundMetric(sample.ms));
    projectId = syncMeasurement.projectId;
    syncState.repeatedSessionCount = 2;
    syncState.partialSnapshot = syncSamples.every(sample => sample.value.partial.partialSnapshot === true);
    syncState.oversizedSkippedBinaryCount = Math.max(...syncSamples.flatMap(sample => [
      sample.value.first.skippedFiles?.length || 0,
      sample.value.second.skippedFiles?.length || 0
    ]));

    statusMeasurement = await measureAsync(() => getMirrorStatus(projectId, { rootDir }));

    const mirror = getProjectMirror(projectId, { rootDir });
    mirrorBaselineJsonBytes = await readFileBytes(mirror.baselinePath);
    mirrorHashedBytes = await computeBaselineHashedBytes(mirror.baselinePath);
    await mutateSyntheticWorkspace(mirror.workspacePath, oversizedPath, fixture.editableTextPath);

    collectMeasurement = await measureAsync(async () => collectMirrorChangesDetailed({
      projectId,
      rootDir
    }));
    collected = collectMeasurement.value;

    const nativeResponse = {
      status: 'completed',
      projectId,
      syncChanges: collected.changes,
      unsupportedChanges: collected.unsupportedChanges
    };
    nativeOutputBytes = Buffer.byteLength(JSON.stringify(nativeResponse), 'utf8');
    try {
      encodeMessage(nativeResponse);
    } catch (_error) {
      // The hard invariant below records the frame-size failure in the report.
    }

    const report = {
      version: 1,
      createdAt: new Date().toISOString(),
      fixture: {
        fileCount: fixture.files.length,
        textFileCount: fixture.textFileCount,
        textBytes: fixture.textBytes,
        binaryBytes: fixture.binaryBytes,
        longTexFileCount: fixture.longTexFileCount,
        longTexBytesMin: fixture.longTexBytesMin,
        longTexBytesMax: fixture.longTexBytesMax,
        nestedMaxDepth: fixture.nestedMaxDepth,
        binaryTypes: fixture.binaryTypes,
        oversizedSkippedBinaryCount: Math.max(
          fixture.oversizedSkippedBinaryCount,
          syncState.oversizedSkippedBinaryCount
        ),
        repeatedSessionCount: syncState.repeatedSessionCount,
        stateFixtures: {
          repeatedFullSync: syncState.repeatedSessionCount >= 2,
          partialSnapshot: syncState.partialSnapshot,
          mirrorStatusChecked: Boolean(statusMeasurement.value),
          oversizedSkippedBinary: Math.max(
            fixture.oversizedSkippedBinaryCount,
            syncState.oversizedSkippedBinaryCount
          ) > 0,
          repeatedState: repeatedState.sessionCount === REPEATED_STATE_SESSION_COUNT
        },
        repeatedState: {
          sessionCount: repeatedState.sessionCount,
          runsPerSession: repeatedState.runsPerSession,
          eventsPerRun: repeatedState.eventsPerRun,
          totalRunCount: repeatedState.totalRunCount,
          totalEventCount: repeatedState.totalEventCount
        },
        repeatedStateBytes: repeatedState.bytes,
        mirrorSyncSamplesMs
      },
      metrics: {
        'snapshot.total_ms': roundMetric(
          fixtureMeasurement.ms + snapshotPayloadMeasurement.ms + snapshotParseMeasurement.ms
        ),
        'snapshot.zip_parse_ms': roundMetric(snapshotParseMeasurement.ms),
        'snapshot.file_count': fixture.files.length,
        'snapshot.text_bytes': fixture.textBytes,
        'snapshot.binary_bytes': fixture.binaryBytes,
        'snapshot.payload_json_bytes': Buffer.byteLength(snapshotPayloadMeasurement.value, 'utf8'),
        'mirror.sync_ms': roundMetric(syncMeasurement.ms),
        'mirror.status_ms': roundMetric(statusMeasurement.ms),
        'mirror.collect_ms': roundMetric(collectMeasurement.ms),
        'mirror.baseline_json_bytes': mirrorBaselineJsonBytes,
        'mirror.hashed_bytes': mirrorHashedBytes,
        'state.generate_ms': roundMetric(stateMeasurement.ms),
        'native.output_frame_bytes': nativeOutputBytes,
        'diff.compute_ms': roundMetric(diffMeasurement.ms),
        'patch.compute_ms': roundMetric(patchMeasurement.ms),
        'context_tray.render_ms': roundMetric(contextTrayMeasurement.ms),
        'storage.prepare_ms': roundMetric(storageMeasurement.ms),
        'storage.compact_bytes': compactStorageBytes
      },
      warnings: [],
      failures: []
    };

    addHardInvariantFindings(report, {
      collected,
      nativeOutputBytes,
      oversizedPath
    });
    addTimingFindings(report, options);
    report.failures.push(...validateReportSchema(report));

    return report;
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

async function runMirrorSyncScenario({ projectId, rootDir, fixture }) {
  const first = await syncOverleafToMirror({
    projectId,
    rootDir,
    project: {
      capabilities: { fullProjectSnapshot: true, method: 'synthetic-benchmark' },
      files: fixture.files
    }
  });
  const second = await syncOverleafToMirror({
    projectId,
    rootDir,
    project: {
      capabilities: { fullProjectSnapshot: true, method: 'synthetic-benchmark-repeat' },
      files: fixture.files
    }
  });
  const partial = await syncOverleafToMirror({
    projectId,
    rootDir,
    project: {
      capabilities: { fullProjectSnapshot: false, method: 'synthetic-benchmark-partial' },
      files: [{ path: fixture.editableTextPath, content: fixture.partialOverlayContent }]
    }
  });
  return { first, second, partial };
}

function selectMedianMeasurement(measurements) {
  const ordered = [...measurements].sort((left, right) => left.ms - right.ms);
  return ordered[Math.floor(ordered.length / 2)];
}

export function createLargeProjectFixture(options = {}) {
  const textFileCount = Math.max(DEFAULT_TEXT_FILE_COUNT, Number(options.textFileCount || options.fileCount) || DEFAULT_TEXT_FILE_COUNT);
  const files = [];
  const binaryTypes = new Set();
  const longTexBytes = [];
  let textBytes = 0;
  let binaryBytes = 0;
  let nestedMaxDepth = 0;

  const mainContent = [
    '\\documentclass{article}',
    '\\usepackage{graphicx}',
    '\\begin{document}',
    '\\input{chapters/chapter-01/sections/deep/long-01}',
    '\\input{sections/group-01/topic-01/section-001}',
    '\\includegraphics{figures/raster/small.png}',
    '\\includegraphics{figures/vector/small.svg}',
    '\\end{document}',
    ''
  ].join('\n');
  addTextFile('main.tex', mainContent);

  const longTexCount = Math.min(LONG_TEX_FILE_COUNT, textFileCount - 1);
  for (let index = 1; index <= longTexCount; index += 1) {
    const id = String(index).padStart(3, '0');
    addTextFile(
      `chapters/chapter-${String(index).padStart(2, '0')}/sections/deep/long-${String(index).padStart(2, '0')}.tex`,
      buildLongTexDocument(id, LONG_TEX_TARGET_BYTES),
      true
    );
  }

  const regularTextCount = textFileCount - 1 - longTexCount;
  let editableTextPath = '';
  for (let index = 1; index <= regularTextCount; index += 1) {
    const id = String(index).padStart(3, '0');
    const group = String((index % 12) + 1).padStart(2, '0');
    const topic = String((index % 7) + 1).padStart(2, '0');
    const filePath = `sections/group-${group}/topic-${topic}/section-${id}.tex`;
    if (!editableTextPath) {
      editableTextPath = filePath;
    }
    addTextFile(filePath, buildRegularTexDocument(id));
  }

  addBinaryFile('figures/raster/small.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  addBinaryFile('figures/pdf/supplement.pdf', Buffer.from('%PDF-1.7 synthetic benchmark asset\n', 'utf8'));
  addBinaryFile('figures/vector/small.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><path d="M0 0h2v2H0z"/></svg>\n', 'utf8'));

  const oversizedSkippedPath = 'figures/oversized/skipped.pdf';
  files.push({
    path: oversizedSkippedPath,
    kind: 'binary',
    size: OVERSIZED_SKIPPED_BINARY_BYTES,
    contentBase64: Buffer.from('oversized-skipped-binary-placeholder').toString('base64')
  });
  nestedMaxDepth = Math.max(nestedMaxDepth, getPathDepth(oversizedSkippedPath));

  return {
    files,
    textFileCount,
    textBytes,
    binaryBytes,
    longTexFileCount: longTexBytes.length,
    longTexBytesMin: Math.min(...longTexBytes),
    longTexBytesMax: Math.max(...longTexBytes),
    nestedMaxDepth,
    binaryTypes: Array.from(binaryTypes).sort(),
    oversizedSkippedBinaryCount: 1,
    editableTextPath,
    partialOverlayContent: buildRegularTexDocument('partial-overlay')
  };

  function addTextFile(filePath, content, longTex = false) {
    files.push({ path: filePath, content });
    const size = Buffer.byteLength(content, 'utf8');
    textBytes += size;
    nestedMaxDepth = Math.max(nestedMaxDepth, getPathDepth(filePath));
    if (longTex) {
      longTexBytes.push(size);
    }
  }

  function addBinaryFile(filePath, bytes) {
    files.push({
      path: filePath,
      kind: 'binary',
      size: bytes.length,
      contentBase64: bytes.toString('base64')
    });
    binaryBytes += bytes.length;
    binaryTypes.add(getExtension(filePath));
    nestedMaxDepth = Math.max(nestedMaxDepth, getPathDepth(filePath));
  }
}

export function createRepeatedSessionStateFixture(options = {}) {
  const sessionCount = Number(options.sessionCount) || REPEATED_STATE_SESSION_COUNT;
  const runsPerSession = Number(options.runsPerSession) || REPEATED_STATE_RUNS_PER_SESSION;
  const eventsPerRun = Number(options.eventsPerRun) || REPEATED_STATE_EVENTS_PER_RUN;
  const sessions = [];
  for (let sessionIndex = 0; sessionIndex < sessionCount; sessionIndex += 1) {
    const runs = [];
    for (let runIndex = 0; runIndex < runsPerSession; runIndex += 1) {
      const events = [];
      for (let eventIndex = 0; eventIndex < eventsPerRun; eventIndex += 1) {
        events.push({
          id: `s${sessionIndex}-r${runIndex}-e${eventIndex}`,
          type: eventIndex % 5 === 0 ? 'overleaf.sync.progress' : 'codex.run.event',
          status: eventIndex === eventsPerRun - 1 ? 'completed' : 'running',
          index: eventIndex
        });
      }
      runs.push({
        id: `s${sessionIndex}-r${runIndex}`,
        mode: runIndex % 2 === 0 ? 'auto' : 'confirm',
        events
      });
    }
    sessions.push({
      id: `session-${sessionIndex}`,
      projectId: `benchmark-project-${sessionIndex}`,
      runs
    });
  }
  return { sessions };
}

function summarizeRepeatedSessionStateFixture(stateFixture) {
  const sessions = Array.isArray(stateFixture?.sessions) ? stateFixture.sessions : [];
  const totalRunCount = sessions.reduce((sum, session) => sum + (Array.isArray(session.runs) ? session.runs.length : 0), 0);
  const totalEventCount = sessions.reduce((sessionSum, session) => {
    const runs = Array.isArray(session.runs) ? session.runs : [];
    return sessionSum + runs.reduce((runSum, run) => runSum + (Array.isArray(run.events) ? run.events.length : 0), 0);
  }, 0);
  const firstRuns = Array.isArray(sessions[0]?.runs) ? sessions[0].runs : [];
  const firstEvents = Array.isArray(firstRuns[0]?.events) ? firstRuns[0].events : [];
  return {
    sessionCount: sessions.length,
    runsPerSession: firstRuns.length,
    eventsPerRun: firstEvents.length,
    totalRunCount,
    totalEventCount,
    bytes: Buffer.byteLength(JSON.stringify(stateFixture), 'utf8')
  };
}

export function parseArgs(argv, env = process.env) {
  const parsed = {
    strict: isStrictEnv(env),
    gate: false,
    output: '',
    maxSnapshotMs: DEFAULT_MAX_SNAPSHOT_MS,
    maxSyncMs: DEFAULT_MAX_SYNC_MS,
    maxStatusMs: DEFAULT_MAX_STATUS_MS,
    maxCollectMs: DEFAULT_MAX_COLLECT_MS,
    maxDiffPatchMs: DEFAULT_MAX_DIFF_PATCH_MS,
    maxContextTrayMs: DEFAULT_MAX_CONTEXT_TRAY_MS,
    maxStoragePrepareMs: DEFAULT_MAX_STORAGE_PREPARE_MS
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--strict') {
      parsed.strict = true;
    } else if (arg === '--gate') {
      parsed.gate = true;
      parsed.strict = true;
    } else if (arg === '--output') {
      parsed.output = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--max-snapshot-ms') {
      parsed.maxSnapshotMs = parseNumberOption(requireValue(argv, index, arg), arg);
      index += 1;
    } else if (arg === '--max-sync-ms') {
      parsed.maxSyncMs = parseNumberOption(requireValue(argv, index, arg), arg);
      index += 1;
    } else if (arg === '--max-status-ms') {
      parsed.maxStatusMs = parseNumberOption(requireValue(argv, index, arg), arg);
      index += 1;
    } else if (arg === '--max-collect-ms') {
      parsed.maxCollectMs = parseNumberOption(requireValue(argv, index, arg), arg);
      index += 1;
    } else if (arg === '--max-diff-patch-ms') {
      parsed.maxDiffPatchMs = parseNumberOption(requireValue(argv, index, arg), arg);
      index += 1;
    } else if (arg === '--max-context-tray-ms') {
      parsed.maxContextTrayMs = parseNumberOption(requireValue(argv, index, arg), arg);
      index += 1;
    } else if (arg === '--max-storage-prepare-ms') {
      parsed.maxStoragePrepareMs = parseNumberOption(requireValue(argv, index, arg), arg);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return parsed;
}

async function mutateSyntheticWorkspace(workspacePath, oversizedPath, editableTextPath) {
  await fs.appendFile(
    path.join(workspacePath, editableTextPath),
    '\n% benchmark local text edit\n',
    'utf8'
  );
  await fs.mkdir(path.join(workspacePath, 'figures'), { recursive: true });
  await fs.writeFile(path.join(workspacePath, 'figures', 'benchmark-small.png'), Buffer.from([1, 3, 3, 7]));
  await fs.writeFile(
    path.join(workspacePath, oversizedPath),
    Buffer.alloc(SAFE_INLINE_BINARY_CHANGE_BYTES + 1024, 9)
  );
}

function renderContextTrayFixture(files = []) {
  const root = { name: '', type: 'folder', children: new Map() };
  for (const file of files) {
    const parts = String(file?.path || '').split('/').filter(Boolean);
    let node = root;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const leaf = index === parts.length - 1;
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          type: leaf ? 'file' : 'folder',
          children: new Map()
        });
      }
      node = node.children.get(part);
    }
  }
  return serializeContextNode(root);
}

function serializeContextNode(node) {
  const children = Array.from(node.children.values())
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === 'folder' ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    })
    .map(serializeContextNode);
  return {
    name: node.name,
    type: node.type,
    children
  };
}

function prepareStorageStateFixture(stateFixture) {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    sessions: stateFixture.sessions
  };
}

function compactStorageStateFixture(preparedState) {
  return {
    version: preparedState.version,
    updatedAt: preparedState.updatedAt,
    sessions: preparedState.sessions.map(session => ({
      id: session.id,
      projectId: session.projectId,
      runs: session.runs.slice(-2).map(run => ({
        id: run.id,
        mode: run.mode,
        events: run.events.slice(-5).map(event => ({
          id: event.id,
          type: event.type,
          status: event.status,
          index: event.index
        }))
      }))
    }))
  };
}

async function readFileBytes(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

async function computeBaselineHashedBytes(baselinePath) {
  try {
    const baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
    return (baseline.files || []).reduce((sum, file) => {
      if (file.kind === 'binary') {
        return sum + (Number.isFinite(Number(file.size)) ? Number(file.size) : 0);
      }
      return sum + Buffer.byteLength(String(file.content || ''), 'utf8');
    }, 0);
  } catch {
    return 0;
  }
}

function buildLongTexDocument(label, targetBytes) {
  const header = [
    `\\section{Long Synthetic Section ${label}}`,
    'This file intentionally sits around one MiB for large-project benchmark coverage.',
    ''
  ].join('\n');
  const line = `Synthetic paragraph ${label}: alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu.\n`;
  const footer = '\n';
  const remainingBytes = Math.max(0, targetBytes - Buffer.byteLength(header, 'utf8') - Buffer.byteLength(footer, 'utf8'));
  const repeatCount = Math.ceil(remainingBytes / Buffer.byteLength(line, 'utf8'));
  return `${header}${line.repeat(repeatCount)}${footer}`;
}

function buildRegularTexDocument(label) {
  return [
    `\\section{Synthetic Section ${label}}`,
    'This file is part of a synthetic Overleaf project for mirror performance baselines.',
    `State marker ${label}: alpha beta gamma delta epsilon.`,
    ''
  ].join('\n');
}

function getPathDepth(filePath) {
  return String(filePath || '').split('/').filter(Boolean).length - 1;
}

function getExtension(filePath) {
  return path.extname(String(filePath || '')).replace(/^\./, '').toLowerCase();
}

async function measureAsync(fn) {
  const startedAt = performance.now();
  const value = await fn();
  return {
    value,
    ms: performance.now() - startedAt
  };
}

function addHardInvariantFindings(report, context) {
  if (context.nativeOutputBytes > MAX_NATIVE_OUTPUT_MESSAGE_BYTES) {
    report.failures.push({
      code: 'native_output_frame_exceeds_limit',
      metric: 'native.output_frame_bytes',
      value: context.nativeOutputBytes,
      limit: MAX_NATIVE_OUTPUT_MESSAGE_BYTES
    });
  }

  const oversizedInlineChange = (context.collected.changes || []).find(change =>
    change.path === context.oversizedPath && typeof change.contentBase64 === 'string'
  );
  if (oversizedInlineChange) {
    report.failures.push({
      code: 'oversized_binary_response_inlined',
      path: context.oversizedPath,
      type: oversizedInlineChange.type,
      size: oversizedInlineChange.size
    });
  }

  const oversizedUnsupported = (context.collected.unsupportedChanges || []).find(change =>
    change.path === context.oversizedPath
      && change.reason === 'binary_payload_exceeds_native_message_limit'
  );
  if (!oversizedUnsupported) {
    report.failures.push({
      code: 'oversized_binary_response_not_degraded',
      path: context.oversizedPath,
      limit: SAFE_INLINE_BINARY_CHANGE_BYTES
    });
  }
}

function addTimingFindings(report, options) {
  const thresholds = [
    { metric: 'snapshot.total_ms', value: report.metrics['snapshot.total_ms'], limit: Number(options.maxSnapshotMs ?? DEFAULT_MAX_SNAPSHOT_MS) },
    { metric: 'mirror.sync_ms', value: report.metrics['mirror.sync_ms'], limit: Number(options.maxSyncMs ?? DEFAULT_MAX_SYNC_MS) },
    { metric: 'mirror.status_ms', value: report.metrics['mirror.status_ms'], limit: Number(options.maxStatusMs ?? DEFAULT_MAX_STATUS_MS) },
    { metric: 'mirror.collect_ms', value: report.metrics['mirror.collect_ms'], limit: Number(options.maxCollectMs ?? DEFAULT_MAX_COLLECT_MS) },
    {
      metric: 'diff.compute_ms + patch.compute_ms',
      value: roundMetric(Number(report.metrics['diff.compute_ms']) + Number(report.metrics['patch.compute_ms'])),
      limit: Number(options.maxDiffPatchMs ?? DEFAULT_MAX_DIFF_PATCH_MS)
    },
    { metric: 'context_tray.render_ms', value: report.metrics['context_tray.render_ms'], limit: Number(options.maxContextTrayMs ?? DEFAULT_MAX_CONTEXT_TRAY_MS) },
    { metric: 'storage.prepare_ms', value: report.metrics['storage.prepare_ms'], limit: Number(options.maxStoragePrepareMs ?? DEFAULT_MAX_STORAGE_PREPARE_MS) }
  ];
  for (const threshold of thresholds) {
    const { metric, value, limit } = threshold;
    if (!Number.isFinite(limit) || !Number.isFinite(value) || value <= limit) {
      continue;
    }
    const finding = {
      code: 'timing_threshold_exceeded',
      metric,
      value,
      limit
    };
    if (options.strict) {
      report.failures.push(finding);
    } else {
      report.warnings.push(finding);
    }
  }
}

function validateReportSchema(report) {
  const failures = [];
  if (report.version !== 1) {
    failures.push({ code: 'benchmark_schema_missing_field', field: 'version' });
  }
  if (!report.createdAt || Number.isNaN(new Date(report.createdAt).getTime())) {
    failures.push({ code: 'benchmark_schema_missing_field', field: 'createdAt' });
  }
  for (const field of ['fileCount', 'textBytes', 'binaryBytes']) {
    if (!Number.isFinite(Number(report.fixture?.[field]))) {
      failures.push({ code: 'benchmark_schema_missing_field', field: `fixture.${field}` });
    }
  }
  for (const field of [
    'textFileCount',
    'longTexFileCount',
    'longTexBytesMin',
    'longTexBytesMax',
    'nestedMaxDepth',
    'oversizedSkippedBinaryCount',
    'repeatedSessionCount'
  ]) {
    if (!Number.isFinite(Number(report.fixture?.[field]))) {
      failures.push({ code: 'benchmark_schema_missing_field', field: `fixture.${field}` });
    }
  }
  if (!Array.isArray(report.fixture?.binaryTypes)) {
    failures.push({ code: 'benchmark_schema_missing_field', field: 'fixture.binaryTypes' });
  }
  if (!report.fixture?.stateFixtures || typeof report.fixture.stateFixtures !== 'object') {
    failures.push({ code: 'benchmark_schema_missing_field', field: 'fixture.stateFixtures' });
  }
  if (!report.fixture?.repeatedState || typeof report.fixture.repeatedState !== 'object') {
    failures.push({ code: 'benchmark_schema_missing_field', field: 'fixture.repeatedState' });
  } else {
    for (const field of ['sessionCount', 'runsPerSession', 'eventsPerRun', 'totalRunCount', 'totalEventCount']) {
      if (!Number.isFinite(Number(report.fixture.repeatedState[field]))) {
        failures.push({ code: 'benchmark_schema_missing_field', field: `fixture.repeatedState.${field}` });
      }
    }
  }
  if (!Number.isFinite(Number(report.fixture?.repeatedStateBytes))) {
    failures.push({ code: 'benchmark_schema_missing_field', field: 'fixture.repeatedStateBytes' });
  }
  for (const key of REQUIRED_METRIC_KEYS) {
    if (!Number.isFinite(Number(report.metrics?.[key]))) {
      failures.push({ code: 'benchmark_schema_missing_field', field: `metrics.${key}` });
    }
  }
  if (!Array.isArray(report.warnings)) {
    failures.push({ code: 'benchmark_schema_missing_field', field: 'warnings' });
  }
  if (!Array.isArray(report.failures)) {
    failures.push({ code: 'benchmark_schema_missing_field', field: 'failures' });
  }
  return failures;
}

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function parseNumberOption(value, option) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`${option} requires a numeric value.`);
  }
  return numeric;
}

function isStrictEnv(env = {}) {
  return /^(?:1|true|yes)$/i.test(String(env.CODEX_OVERLEAF_PERF_STRICT || '').trim());
}

function roundMetric(value) {
  return Math.round(value * 1000) / 1000;
}

function printHelp() {
  console.log([
    'Usage:',
    '  node scripts/benchmark-large-project.mjs --output /tmp/codex-overleaf-perf.json',
    '  node scripts/benchmark-large-project.mjs --gate --output /tmp/codex-overleaf-perf.json',
    '  node scripts/benchmark-large-project.mjs --strict --output /tmp/codex-overleaf-perf.json',
    '',
    'Options:',
    '  --output <path>                  Write benchmark JSON to this path',
    '  --gate                           Enable v1.0 synthetic regression gate mode',
    '  --strict                         Treat timing threshold misses as failures',
    '  CODEX_OVERLEAF_PERF_STRICT=1 also enables strict timing failures.',
    '  --max-snapshot-ms <ms>           Snapshot timing threshold, default 5000',
    '  --max-sync-ms <ms>               Sync timing threshold, default 3000',
    '  --max-status-ms <ms>             Status timing threshold, default 500',
    '  --max-collect-ms <ms>            Change collection timing threshold, default 2500',
    '  --max-diff-patch-ms <ms>         Diff plus patch timing threshold, default 1000',
    '  --max-context-tray-ms <ms>       Context tray timing threshold, default 500',
    '  --max-storage-prepare-ms <ms>    Storage preparation timing threshold, default 500'
  ].join('\n'));
}

async function main() {
  const options = parseArgs(process.argv.slice(2), process.env);
  if (options.help) {
    printHelp();
    return;
  }

  const report = await runBenchmark(options);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    await fs.mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
    await fs.writeFile(options.output, json, 'utf8');
  } else {
    process.stdout.write(json);
  }
  if (report.failures.length) {
    console.error(JSON.stringify({
      message: 'Synthetic large-project regression gate failed.',
      platform: process.platform,
      failures: report.failures,
      warnings: report.warnings,
      metrics: report.metrics
    }, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
