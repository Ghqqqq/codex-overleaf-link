'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getHomeDir } = require('./nativeHostPlatform');

const BASELINE_FILE = 'baseline.json';
const MAX_BINARY_FILE_BYTES = 10 * 1024 * 1024;
const NATIVE_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const SAFE_INLINE_BINARY_CHANGE_BYTES = 512 * 1024;
const SAFE_NATIVE_RESPONSE_PAYLOAD_BYTES = NATIVE_OUTPUT_LIMIT_BYTES - (64 * 1024);
const TURN_ATTACHMENTS_DIR = '.codex-overleaf-attachments';
// Control plane for the parallel-subagents broker (v1.6). Lives inside the
// workspace so the sandboxed model can write jobs, but is excluded from the
// mirror scan so queue/result/log files can never enter Overleaf writeback.
const SUBAGENT_QUEUE_DIR = '.codex-overleaf-subagents';

function getProjectMirror(projectId, options = {}) {
  const rootDir = path.resolve(options.rootDir || getDefaultMirrorRoot(options));
  const projectKey = normalizeProjectKey(projectId);
  const projectRoot = path.join(rootDir, projectKey);
  return {
    projectKey,
    projectRoot,
    workspacePath: path.join(projectRoot, 'workspace'),
    metadataPath: path.join(projectRoot, 'metadata'),
    baselinePath: path.join(projectRoot, 'metadata', BASELINE_FILE)
  };
}

function getDefaultMirrorRoot(options = {}) {
  return path.join(getHomeDir(options), '.codex-overleaf', 'projects');
}

async function syncOverleafToMirror({ projectId, project, rootDir }) {
  const mirror = getProjectMirror(projectId, { rootDir });
  const normalized = normalizeProjectFilesDetailed(project?.files || []);
  const files = normalized.files;
  const skippedFiles = normalized.skippedFiles;
  const nextPaths = new Set(files.map(file => file.path));
  const previous = readBaseline(mirror.baselinePath);
  const fullProjectSnapshot = project?.capabilities?.fullProjectSnapshot !== false;

  const mirrorRoot = path.dirname(mirror.projectRoot);
  assertSafeMirrorPathBeforeCreate(mirror.workspacePath, mirrorRoot);
  assertSafeMirrorPathBeforeCreate(mirror.metadataPath, mirrorRoot);
  fs.mkdirSync(mirror.workspacePath, { recursive: true });
  fs.mkdirSync(mirror.metadataPath, { recursive: true });
  assertSafeMirrorPathBeforeCreate(mirror.workspacePath, mirrorRoot);
  assertSafeMirrorPathBeforeCreate(mirror.metadataPath, mirrorRoot);

  if (fullProjectSnapshot) {
    for (const filePath of listWorkspaceFiles(mirror.workspacePath)) {
      if (nextPaths.has(filePath)) {
        continue;
      }
      const target = resolveWorkspacePath(mirror.workspacePath, filePath);
      if (fs.existsSync(target)) {
        assertSafeWorkspaceTarget(mirror.workspacePath, target, filePath);
        fs.rmSync(target, { force: true });
        removeEmptyParents(path.dirname(target), mirror.workspacePath);
      }
    }
  }

  let writtenCount = 0;
  const previousByPath = new Map((previous.files || []).map(f => [f.path, f]));

  for (const file of files) {
    const target = resolveWorkspacePath(mirror.workspacePath, file.path);
    assertSafeWorkspaceTarget(mirror.workspacePath, target, file.path);
    const prev = previousByPath.get(file.path);
    const nextHash = hashProjectFile(file);
    if (prev && prev.hash === nextHash && workspaceFileMatchesBaseline(target, prev)) {
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeProjectFile(target, file);
    writtenCount++;
  }

  const now = new Date().toISOString();
  const nextBaselineFiles = fullProjectSnapshot
    ? files.map(file => buildBaselineFile(file))
    : mergePartialBaselineFiles(previous.files || [], files);

  writeBaseline(mirror.baselinePath, {
    ...previous,
    projectKey: mirror.projectKey,
    capturedAt: fullProjectSnapshot ? now : (previous.capturedAt || ''),
    lastFullSyncAt: fullProjectSnapshot ? now : previous.lastFullSyncAt,
    lastPartialSyncAt: fullProjectSnapshot ? previous.lastPartialSyncAt : now,
    lastSyncSource: fullProjectSnapshot ? (project?.capabilities?.method || 'snapshot') : previous.lastSyncSource,
    lastFileCount: files.length,
    dirty: fullProjectSnapshot ? false : previous.dirty === true,
    dirtyReason: fullProjectSnapshot ? '' : previous.dirtyReason || '',
    dirtyAt: fullProjectSnapshot ? '' : previous.dirtyAt || '',
    files: nextBaselineFiles
  });

  return {
    ...mirror,
    fileCount: files.length,
    writtenCount,
    skippedFiles,
    partialSnapshot: !fullProjectSnapshot
  };
}

async function collectMirrorChanges({ projectId, rootDir }) {
  return (await collectMirrorChangesDetailed({ projectId, rootDir })).changes;
}

async function collectMirrorChangesDetailed({ projectId, rootDir }) {
  const mirror = getProjectMirror(projectId, { rootDir });
  const baseline = readBaseline(mirror.baselinePath);
  const baselineByPath = new Map((baseline.files || []).map(file => [file.path, file]));
  const currentPaths = listWorkspaceFiles(mirror.workspacePath);
  const currentByPath = new Map();
  const unsupportedChanges = [];

  for (const filePath of currentPaths) {
    const previous = baselineByPath.get(filePath);
    const target = resolveWorkspacePath(mirror.workspacePath, filePath);
    const stat = fs.statSync(target);
    if (isGeneratedArtifactPath(filePath, baselineByPath)) {
      if (!previous || !workspaceFileMatchesBaseline(target, previous)) {
        unsupportedChanges.push({
          type: 'unsupported-local-file',
          path: filePath,
          reason: 'generated_artifact',
          size: stat.size
        });
      }
      continue;
    }
    if (isSupportedBinaryAssetPath(filePath)) {
      if (stat.size > MAX_BINARY_FILE_BYTES) {
        unsupportedChanges.push({
          type: 'unsupported-local-file',
          path: filePath,
          reason: 'binary_file_too_large',
          size: stat.size,
          previousExists: Boolean(previous),
          previousKind: previous?.kind || ''
        });
        continue;
      }
      if (previous?.kind === 'binary') {
        const bytes = fs.readFileSync(target);
        if (hashBytes(bytes) === previous.hash) {
          continue;
        }
        currentByPath.set(filePath, {
          binary: true,
          sha256: hashBytes(bytes),
          size: stat.size,
          previous
        });
        continue;
      }
      if (!previous) {
        const bytes = fs.readFileSync(target);
        currentByPath.set(filePath, {
          binary: true,
          sha256: hashBytes(bytes),
          size: stat.size,
          previous
        });
        continue;
      }
    }
    if (previous?.kind === 'binary') {
      unsupportedChanges.push({
        type: 'unsupported-local-file',
        path: filePath,
        reason: 'unsupported_non_text_file',
        size: stat.size,
        previousExists: true,
        previousKind: 'binary',
        previousSize: previous.size
      });
      continue;
    }
    if (!previous && !isTextMirrorPath(filePath)) {
      unsupportedChanges.push({
        type: 'unsupported-local-file',
        path: filePath,
        reason: 'unsupported_non_text_file',
        size: stat.size
      });
      continue;
    }
    const content = fs.readFileSync(target, 'utf8');
    currentByPath.set(filePath, content);
  }

  const changes = [];
  for (const [filePath, contentOrBinary] of currentByPath) {
    const previous = baselineByPath.get(filePath);
    if (contentOrBinary && typeof contentOrBinary === 'object' && contentOrBinary.binary === true) {
      changes.push({
        type: previous ? 'overwrite-binary' : 'binary-create',
        path: filePath,
        assetSourcePath: filePath,
        sha256: contentOrBinary.sha256,
        previousExists: Boolean(previous),
        previousKind: previous?.kind || '',
        previousSize: previous?.size,
        size: contentOrBinary.size
      });
      continue;
    }
    const content = contentOrBinary;
    if (!previous || previous.content !== content) {
      changes.push({
        type: 'write',
        path: filePath,
        content,
        previousContent: previous?.content || '',
        previousExists: Boolean(previous)
      });
    }
  }

  for (const [filePath, previous] of baselineByPath) {
    if (previous.kind === 'binary') {
      if (!currentByPath.has(filePath) && !currentPaths.includes(filePath)) {
        unsupportedChanges.push({
          type: 'unsupported-local-file',
          path: filePath,
          reason: 'binary_delete_unsupported',
          previousExists: true,
          previousKind: 'binary',
          previousSize: previous.size
        });
      }
      continue;
    }
    if (!currentByPath.has(filePath)) {
      changes.push({
        type: 'delete',
        path: filePath,
        previousContent: previous.content || '',
        previousExists: true
      });
    }
  }

  const budgeted = enforceNativeResponsePayloadBudget({
    changes,
    unsupportedChanges,
    mirror
  });

  return {
    changes: budgeted.changes.sort(compareSyncChanges),
    unsupportedChanges: budgeted.unsupportedChanges.sort((left, right) => left.path.localeCompare(right.path))
  };
}

function enforceNativeResponsePayloadBudget({ changes, unsupportedChanges, mirror }) {
  const nextChanges = [...changes];
  const nextUnsupportedChanges = [...unsupportedChanges];
  while (
    estimateNativeResponsePayloadBytes(nextChanges, nextUnsupportedChanges, mirror) > SAFE_NATIVE_RESPONSE_PAYLOAD_BYTES
  ) {
    const index = findLargestInlineBinaryChangeIndex(nextChanges);
    if (index < 0) {
      break;
    }
    const [change] = nextChanges.splice(index, 1);
    nextUnsupportedChanges.push(buildOversizedBinaryPayloadChange({
      filePath: change.path,
      size: change.size,
      previousExists: change.previousExists === true,
      previousKind: change.previousKind || '',
      previousSize: change.previousSize,
      attemptedChangeType: change.type,
      aggregateBudgetExceeded: true
    }));
  }
  return {
    changes: nextChanges,
    unsupportedChanges: nextUnsupportedChanges
  };
}

function estimateNativeResponsePayloadBytes(changes, unsupportedChanges, mirror = {}) {
  return Buffer.byteLength(JSON.stringify({
    status: 'completed',
    projectId: mirror.projectKey || '',
    workspacePath: mirror.workspacePath || '',
    assistantMessage: '',
    threadId: '',
    syncChanges: changes,
    unsupportedChanges
  }), 'utf8');
}

function findLargestInlineBinaryChangeIndex(changes) {
  let largestIndex = -1;
  let largestSize = -1;
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    if (
      (change?.type !== 'binary-create' && change?.type !== 'overwrite-binary')
      || typeof change.contentBase64 !== 'string'
    ) {
      continue;
    }
    const size = Number.isFinite(Number(change.size)) ? Number(change.size) : estimateBase64Size(change.contentBase64);
    if (size > largestSize) {
      largestSize = size;
      largestIndex = index;
    }
  }
  return largestIndex;
}

function buildOversizedBinaryPayloadChange({
  filePath,
  size,
  previous,
  previousExists,
  previousKind,
  previousSize,
  attemptedChangeType,
  aggregateBudgetExceeded = false
}) {
  const resolvedPreviousExists = typeof previousExists === 'boolean' ? previousExists : Boolean(previous);
  const resolvedAttemptedChangeType = attemptedChangeType || (resolvedPreviousExists ? 'overwrite-binary' : 'binary-create');
  const guidancePrefix = aggregateBudgetExceeded
    ? `The ${resolvedAttemptedChangeType} payload would exceed the native messaging response budget when combined with other changes.`
    : `The ${resolvedAttemptedChangeType} payload is too large for native messaging.`;
  return {
    type: 'unsupported-local-file',
    path: filePath,
    reason: 'binary_payload_exceeds_native_message_limit',
    size,
    attemptedChangeType: resolvedAttemptedChangeType,
    previousExists: resolvedPreviousExists,
    previousKind: previousKind ?? previous?.kind ?? '',
    previousSize: previousSize ?? previous?.size,
    limit: SAFE_INLINE_BINARY_CHANGE_BYTES,
    aggregateLimit: SAFE_NATIVE_RESPONSE_PAYLOAD_BYTES,
    nativeOutputLimit: NATIVE_OUTPUT_LIMIT_BYTES,
    guidance: `${guidancePrefix} Update ${filePath} in Overleaf directly or reduce it below ${SAFE_INLINE_BINARY_CHANGE_BYTES} bytes.`
  };
}

function normalizeProjectFiles(files) {
  return normalizeProjectFilesDetailed(files).files;
}

function normalizeProjectFilesDetailed(files) {
  const normalized = [];
  const skippedFiles = [];
  for (const file of files) {
    const result = normalizeProjectFile(file);
    if (result?.file) {
      normalized.push(result.file);
    } else if (result?.skipped) {
      skippedFiles.push(result.skipped);
    }
  }
  return {
    files: normalized,
    skippedFiles
  };
}

function normalizeProjectFile(file) {
  if (!file || typeof file.path !== 'string') {
    return null;
  }
  const normalizedPath = normalizeRelativePath(file.path);
  if (typeof file.content === 'string') {
    return {
      file: {
        path: normalizedPath,
        kind: 'text',
        content: file.content
      }
    };
  }
  if (typeof file.contentBase64 === 'string') {
    const size = Number.isFinite(Number(file.size)) ? Number(file.size) : estimateBase64Size(file.contentBase64);
    if (size > MAX_BINARY_FILE_BYTES) {
      return {
        skipped: {
          path: normalizedPath,
          kind: 'binary',
          size,
          reason: 'binary_file_too_large'
        }
      };
    }
    return {
      file: {
        path: normalizedPath,
        kind: 'binary',
        contentBase64: file.contentBase64,
        size
      }
    };
  }
  return null;
}

function estimateBase64Size(value) {
  const clean = String(value || '').replace(/\s+/g, '');
  if (!clean) {
    return 0;
  }
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(clean.length * 3 / 4) - padding);
}

function writeProjectFile(target, file) {
  if (file.kind === 'binary') {
    fs.writeFileSync(target, decodeBase64File(file.contentBase64));
    return;
  }
  fs.writeFileSync(target, file.content, 'utf8');
}

function buildBaselineFile(file) {
  const baseline = {
    path: file.path,
    kind: file.kind,
    hash: hashProjectFile(file)
  };
  if (file.kind === 'binary') {
    baseline.size = file.size;
  } else {
    baseline.content = file.content;
  }
  return baseline;
}

function workspaceFileMatchesBaseline(target, baselineFile = {}) {
  if (!fs.existsSync(target)) {
    return false;
  }
  if (baselineFile.kind === 'binary') {
    return hashBytes(fs.readFileSync(target)) === baselineFile.hash;
  }
  return hashText(fs.readFileSync(target, 'utf8')) === baselineFile.hash;
}

function mergePartialBaselineFiles(previousFiles, overlayFiles) {
  const filesByPath = new Map((previousFiles || []).map(file => [file.path, file]));
  for (const file of overlayFiles || []) {
    filesByPath.set(file.path, buildBaselineFile(file));
  }
  return Array.from(filesByPath.values()).sort((left, right) => left.path.localeCompare(right.path));
}

function mergePatchedBaselineFiles(previousFiles, patchedFilesByPath) {
  const filesByPath = new Map((previousFiles || []).map(file => [file.path, file]));
  for (const [filePath, file] of patchedFilesByPath) {
    filesByPath.set(filePath, file);
  }
  return Array.from(filesByPath.values()).sort((left, right) => left.path.localeCompare(right.path));
}

function hashProjectFile(file) {
  return hashBytes(getProjectFileBytes(file));
}

function getProjectFileBytes(file) {
  if (file.kind === 'binary') {
    return decodeBase64File(file.contentBase64);
  }
  return Buffer.from(String(file.content || ''), 'utf8');
}

function decodeBase64File(contentBase64) {
  return Buffer.from(String(contentBase64 || ''), 'base64');
}

function normalizeProjectKey(projectId) {
  const raw = String(projectId || '').trim();
  const fromProjectUrl = raw.match(/\/project\/([^/?#]+)/)?.[1];
  const candidate = fromProjectUrl || raw.split(/[/?#]/).filter(Boolean).pop() || 'unknown-project';
  const safe = candidate.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  if (safe) {
    return safe.slice(0, 80);
  }
  return hashText(raw || 'unknown-project').slice(0, 16);
}

function normalizeRelativePath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some(part => part === '..' || part === '.')) {
    throw new Error(`Unsafe project path: ${filePath}`);
  }
  return normalized;
}

function resolveWorkspacePath(workspacePath, filePath) {
  const relative = normalizeRelativePath(filePath);
  const target = path.resolve(workspacePath, relative);
  const root = path.resolve(workspacePath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Unsafe project path: ${filePath}`);
  }
  return target;
}

function listWorkspaceFiles(workspacePath) {
  if (!fs.existsSync(workspacePath)) {
    return [];
  }
  const files = [];
  walk(workspacePath, '');
  return files.sort();

  function walk(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.DS_Store' || entry.name === TURN_ATTACHMENTS_DIR || entry.name === SUBAGENT_QUEUE_DIR) {
        continue;
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Unsafe mirror symlink: ${relative}`);
      }
      if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.isFile()) {
        files.push(normalizeRelativePath(relative));
      }
    }
  }
}

function readBaseline(baselinePath) {
  try {
    return JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch {
    return { files: [] };
  }
}

function writeBaseline(baselinePath, baseline) {
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), 'utf8');
}

function removeEmptyParents(startDir, stopDir) {
  let current = startDir;
  const stop = path.resolve(stopDir);
  while (current.startsWith(stop) && current !== stop) {
    try {
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

function compareSyncChanges(left, right) {
  if (left.type !== right.type) {
    return left.type === 'write' ? -1 : 1;
  }
  return left.path.localeCompare(right.path);
}

function isGeneratedArtifactPath(filePath, baselineByPath) {
  const normalized = normalizeRelativePath(filePath).toLowerCase();
  const basename = path.posix.basename(normalized);
  if (basename === '.latexmkrc') {
    return false;
  }
  if (/^(?:\.|__latexindent_temp)/.test(basename)) {
    return true;
  }
  if (/\.pdf$/i.test(normalized)) {
    return !normalized.includes('/') && hasMatchingRootSourceFile(normalized, baselineByPath);
  }
  return /\.(aux|bbl|bcf|blg|brf|fdb_latexmk|fls|lof|log|lot|out|run\.xml|synctex(?:\.gz)?|toc|xdv)$/i.test(normalized);
}

function hasMatchingRootSourceFile(normalizedPdfPath, baselineByPath) {
  if (!baselineByPath || typeof baselineByPath.has !== 'function') {
    return true;
  }
  const stem = normalizedPdfPath.replace(/\.pdf$/i, '');
  const sourcePath = `${stem}.tex`;
  const hasMatchingSource = baselineByPath.has(sourcePath)
    || Array.from(baselineByPath.keys()).some(filePath =>
      normalizeRelativePath(filePath).toLowerCase() === sourcePath
    );
  return hasMatchingSource || stem === 'main' || stem === 'output';
}

function isSupportedBinaryAssetPath(filePath) {
  return /\.(?:pdf|png|jpe?g|svg)$/i.test(normalizeRelativePath(filePath));
}

function isTextMirrorPath(filePath) {
  const normalized = normalizeRelativePath(filePath).toLowerCase();
  const basename = path.posix.basename(normalized);
  if (basename === '.latexmkrc') {
    return true;
  }
  return /\.(tex|bib|bst|cls|sty|clo|cfg|def|bbx|cbx|lbx|ist|tikz|pgf|asy|txt|md|csv|tsv|dat|json|ya?ml|py|r|m|sh)$/i.test(normalized);
}

function hashText(text) {
  return hashBytes(Buffer.from(String(text || ''), 'utf8'));
}

function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function getMirrorStatus(projectId, options = {}) {
  const mirror = getProjectMirror(projectId, options);
  const baseline = readBaseline(mirror.baselinePath);
  if (!baseline.lastFullSyncAt) {
    return {
      exists: false,
      projectKey: mirror.projectKey,
      fileCount: 0,
      ageMs: Infinity,
      baselineCapturedAt: baseline.capturedAt || '',
      lastFullSyncAt: '',
      lastPartialSyncAt: baseline.lastPartialSyncAt || '',
      lastSyncSource: baseline.lastSyncSource || '',
      lastFileCount: Number.isFinite(Number(baseline.lastFileCount)) ? Number(baseline.lastFileCount) : (baseline.files || []).length,
      dirty: baseline.dirty === true,
      dirtyReason: baseline.dirtyReason || '',
      workspacePath: mirror.workspacePath,
      ...buildOtStatusFields(baseline, false)
    };
  }
  if (baseline.dirty === true) {
    return {
      exists: false,
      projectKey: mirror.projectKey,
      fileCount: 0,
      ageMs: Infinity,
      baselineCapturedAt: baseline.capturedAt || baseline.lastFullSyncAt || '',
      lastFullSyncAt: '',
      lastPartialSyncAt: baseline.lastPartialSyncAt || '',
      lastSyncSource: baseline.lastSyncSource || '',
      lastFileCount: Number.isFinite(Number(baseline.lastFileCount)) ? Number(baseline.lastFileCount) : (baseline.files || []).length,
      dirty: true,
      dirtyReason: baseline.dirtyReason || 'dirty_mirror',
      workspacePath: mirror.workspacePath,
      ...buildOtStatusFields(baseline, false)
    };
  }
  const lastFullSyncAt = baseline.lastFullSyncAt;
  const lastFullSyncTime = new Date(lastFullSyncAt).getTime();
  if (!Number.isFinite(lastFullSyncTime)) {
    return {
      exists: false,
      projectKey: mirror.projectKey,
      fileCount: 0,
      ageMs: Infinity,
      baselineCapturedAt: lastFullSyncAt,
      lastFullSyncAt: '',
      lastPartialSyncAt: baseline.lastPartialSyncAt || '',
      lastSyncSource: baseline.lastSyncSource || '',
      lastFileCount: Number.isFinite(Number(baseline.lastFileCount)) ? Number(baseline.lastFileCount) : (baseline.files || []).length,
      dirty: false,
      dirtyReason: '',
      workspacePath: mirror.workspacePath,
      ...buildOtStatusFields(baseline, false)
    };
  }
  const integrity = verifyWorkspaceMatchesBaseline(mirror.workspacePath, baseline.files || []);
  if (!integrity.ok) {
    return {
      exists: false,
      projectKey: mirror.projectKey,
      fileCount: 0,
      ageMs: Infinity,
      baselineCapturedAt: lastFullSyncAt,
      lastFullSyncAt: '',
      lastPartialSyncAt: baseline.lastPartialSyncAt || '',
      lastSyncSource: baseline.lastSyncSource || '',
      lastFileCount: Number.isFinite(Number(baseline.lastFileCount)) ? Number(baseline.lastFileCount) : (baseline.files || []).length,
      dirty: true,
      dirtyReason: integrity.reason,
      dirtyPath: integrity.path || '',
      workspacePath: mirror.workspacePath,
      ...buildOtStatusFields(baseline, false)
    };
  }
  const ageMs = Date.now() - lastFullSyncTime;
  return {
    exists: true,
    projectKey: mirror.projectKey,
    fileCount: (baseline.files || []).length,
    ageMs: Math.max(0, ageMs),
    baselineCapturedAt: lastFullSyncAt,
    lastFullSyncAt,
    lastPartialSyncAt: baseline.lastPartialSyncAt || '',
    lastSyncSource: baseline.lastSyncSource || '',
    lastFileCount: Number.isFinite(Number(baseline.lastFileCount)) ? Number(baseline.lastFileCount) : (baseline.files || []).length,
    dirty: false,
    dirtyReason: '',
    workspacePath: mirror.workspacePath,
    ...buildOtStatusFields(baseline, true)
  };
}

function buildOtStatusFields(baseline = {}, trusted) {
  const metadata = {
    lastOtPatchAt: baseline.lastOtPatchAt || '',
    lastOtErrorCode: baseline.lastOtErrorCode || ''
  };
  if (!trusted) {
    return {
      ...metadata,
      otFreshFileCount: 0,
      otStaleFileCount: 0,
      otFreshFiles: []
    };
  }
  const textFiles = (baseline.files || []).filter(file => file?.kind === 'text');
  const freshFiles = textFiles
    .filter(file => file.freshness?.source === 'ot' && file.freshness?.state === 'fresh')
    .map(file => ({
      path: file.path,
      source: file.freshness.source,
      state: file.freshness.state,
      lastFullSyncAt: file.freshness.lastFullSyncAt || '',
      lastPatchAt: file.freshness.lastPatchAt || '',
      observedVersion: file.freshness.observedVersion ?? null
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    ...metadata,
    otFreshFileCount: freshFiles.length,
    otStaleFileCount: textFiles.length - freshFiles.length,
    otFreshFiles: freshFiles
  };
}

async function applyFileOverlays({ projectId, overlays, rootDir }) {
  const mirror = getProjectMirror(projectId, { rootDir });
  const baseline = readBaseline(mirror.baselinePath);
  const filesByPath = new Map((baseline.files || []).map(f => [f.path, f]));

  for (const overlay of overlays || []) {
    if (!overlay?.path || typeof overlay.content !== 'string') {
      continue;
    }
    const normalizedPath = normalizeRelativePath(overlay.path);
    const target = resolveWorkspacePath(mirror.workspacePath, normalizedPath);
    assertSafeWorkspaceTarget(mirror.workspacePath, target, normalizedPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, overlay.content, 'utf8');

    filesByPath.set(normalizedPath, {
      path: normalizedPath,
      kind: 'text',
      hash: overlay.hash || hashText(overlay.content),
      content: overlay.content
    });
  }

  // Write baseline preserving lastFullSyncAt unchanged
  writeBaseline(mirror.baselinePath, {
    ...baseline,
    files: Array.from(filesByPath.values())
  });
}

// v1.8.0: after a VERIFIED writeback, the workspace already holds the exact
// content that landed in Overleaf (the writeback reads from this workspace).
// Instead of re-downloading the whole project only to rewrite what we just
// uploaded, re-hash the written workspace files in place and refresh the
// baseline freshness metadata. Any doubt -> ok:false, and the caller falls
// back to a full syncOverleafToMirror.
async function confirmWritebackFiles({ projectId, paths, rootDir }) {
  const mirror = getProjectMirror(projectId, { rootDir });
  const baseline = readBaseline(mirror.baselinePath);
  if (!baseline.lastFullSyncAt) {
    return { ok: false, reason: 'no_baseline' };
  }
  if (baseline.dirty === true) {
    return { ok: false, reason: 'dirty_mirror' };
  }
  const filesByPath = new Map((baseline.files || []).map(file => [file.path, file]));
  const confirmed = [];
  for (const rawPath of Array.isArray(paths) ? paths : []) {
    const normalizedPath = normalizeRelativePath(rawPath);
    const baselineFile = filesByPath.get(normalizedPath);
    if (!baselineFile) {
      return { ok: false, reason: 'missing_baseline_file', path: normalizedPath };
    }
    if (baselineFile.kind !== 'text') {
      return { ok: false, reason: 'not_text', path: normalizedPath };
    }
    let target;
    try {
      target = resolveWorkspacePath(mirror.workspacePath, normalizedPath);
    } catch (error) {
      return { ok: false, reason: 'unsafe_path', path: normalizedPath };
    }
    if (!isSafeWorkspaceWriteTarget(mirror.workspacePath, target)) {
      return { ok: false, reason: 'unsafe_path', path: normalizedPath };
    }
    let content;
    try {
      content = fs.readFileSync(target, 'utf8');
    } catch (error) {
      return { ok: false, reason: 'workspace_read_failed', path: normalizedPath };
    }
    const hash = hashText(content);
    filesByPath.set(normalizedPath, { ...baselineFile, hash, content });
    confirmed.push({ path: normalizedPath, hash });
  }
  if (!confirmed.length) {
    return { ok: false, reason: 'no_paths' };
  }
  const now = new Date().toISOString();
  writeBaseline(mirror.baselinePath, {
    ...baseline,
    lastFullSyncAt: now,
    lastSyncSource: 'writeback-confirm',
    files: Array.from(filesByPath.values())
  });
  return { ok: true, confirmed, lastFullSyncAt: now };
}

async function patchMirrorFiles({ projectId, files, rootDir, source = 'ot' }) {
  const mirror = getProjectMirror(projectId, { rootDir });
  const baseline = readBaseline(mirror.baselinePath);
  const baselineByPath = new Map((baseline.files || []).map(file => [file.path, file]));
  const patchedFilesByPath = new Map();
  const appliedFiles = [];
  const skippedFiles = [];
  const patchSource = typeof source === 'string' && source ? source : 'ot';
  let lastOtPatchAt = baseline.lastOtPatchAt || '';
  let lastOtErrorCode = '';
  let patchBatchAt = '';

  for (const patch of Array.isArray(files) ? files : []) {
    const normalized = normalizePatchPath(patch, mirror.workspacePath);
    if (!normalized.ok) {
      skippedFiles.push({ path: normalized.path, reason: 'unsafe_path' });
      lastOtErrorCode = 'unsafe_path';
      continue;
    }

    const baselineFile = baselineByPath.get(normalized.path);
    if (!baselineFile) {
      skippedFiles.push({ path: normalized.path, reason: 'missing_baseline' });
      lastOtErrorCode = 'missing_baseline';
      continue;
    }
    if (baselineFile.kind !== 'text') {
      skippedFiles.push({ path: normalized.path, reason: 'not_text' });
      lastOtErrorCode = 'not_text';
      continue;
    }
    if (typeof patch?.nextContent !== 'string') {
      skippedFiles.push({ path: normalized.path, reason: 'missing_content' });
      lastOtErrorCode = 'missing_content';
      continue;
    }
    if (typeof patch.baseHash !== 'string' || !patch.baseHash) {
      skippedFiles.push({ path: normalized.path, reason: 'missing_base_hash' });
      lastOtErrorCode = 'missing_base_hash';
      continue;
    }
    const nextHash = hashText(patch.nextContent);
    if (patch.baseHash !== baselineFile.hash) {
      if (nextHash === baselineFile.hash) {
        if (baseline.dirty === true) {
          skippedFiles.push({ path: normalized.path, reason: 'dirty_mirror' });
          lastOtErrorCode = 'dirty_mirror';
          continue;
        }
        if (!isSafeWorkspaceWriteTarget(mirror.workspacePath, normalized.target)) {
          skippedFiles.push({ path: normalized.path, reason: 'unsafe_path' });
          lastOtErrorCode = 'unsafe_path';
          continue;
        }
        if (!workspaceFileMatchesBaseline(normalized.target, baselineFile)) {
          skippedFiles.push({ path: normalized.path, reason: 'workspace_mismatch' });
          lastOtErrorCode = 'workspace_mismatch';
          continue;
        }
        appliedFiles.push({
          path: normalized.path,
          hash: baselineFile.hash,
          observedVersion: patch.observedVersion ?? null,
          idempotent: true
        });
        continue;
      }
      skippedFiles.push({ path: normalized.path, reason: 'base_hash_mismatch' });
      lastOtErrorCode = 'base_hash_mismatch';
      continue;
    }
    if (baseline.dirty === true) {
      skippedFiles.push({ path: normalized.path, reason: 'dirty_mirror' });
      lastOtErrorCode = 'dirty_mirror';
      continue;
    }
    if (!isSafeWorkspaceWriteTarget(mirror.workspacePath, normalized.target)) {
      skippedFiles.push({ path: normalized.path, reason: 'unsafe_path' });
      lastOtErrorCode = 'unsafe_path';
      continue;
    }
    if (!workspaceFileMatchesBaseline(normalized.target, baselineFile)) {
      skippedFiles.push({ path: normalized.path, reason: 'workspace_mismatch' });
      lastOtErrorCode = 'workspace_mismatch';
      continue;
    }

    patchBatchAt ||= new Date().toISOString();
    lastOtPatchAt = patchBatchAt;
    fs.writeFileSync(normalized.target, patch.nextContent, 'utf8');

    const nextBaselineFile = {
      ...baselineFile,
      path: normalized.path,
      kind: 'text',
      hash: nextHash,
      content: patch.nextContent,
      freshness: {
        source: patchSource,
        state: 'fresh',
        lastFullSyncAt: baseline.lastFullSyncAt || '',
        lastPatchAt: patchBatchAt,
        observedVersion: patch.observedVersion ?? null
      }
    };
    patchedFilesByPath.set(normalized.path, nextBaselineFile);
    baselineByPath.set(normalized.path, nextBaselineFile);
    appliedFiles.push({
      path: normalized.path,
      hash: nextHash,
      observedVersion: patch.observedVersion ?? null
    });
  }

  if (appliedFiles.length || skippedFiles.length) {
    writeBaseline(mirror.baselinePath, {
      ...baseline,
      lastOtPatchAt,
      lastOtErrorCode,
      files: mergePatchedBaselineFiles(baseline.files || [], patchedFilesByPath)
    });
  }

  return {
    ...mirror,
    appliedCount: appliedFiles.length,
    skippedCount: skippedFiles.length,
    appliedFiles,
    skippedFiles
  };
}

function normalizePatchPath(patch, workspacePath) {
  const rawPath = typeof patch?.path === 'string' ? patch.path : '';
  try {
    const normalizedPath = normalizeRelativePath(rawPath);
    return {
      ok: true,
      path: normalizedPath,
      target: resolveWorkspacePath(workspacePath, normalizedPath)
    };
  } catch {
    return { ok: false, path: rawPath };
  }
}

function isSafeWorkspaceWriteTarget(workspacePath, target) {
  const root = path.resolve(workspacePath);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget === root || !resolvedTarget.startsWith(root + path.sep)) {
    return false;
  }
  try {
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return false;
    }
    const rootRealPath = fs.realpathSync(root);
    let current = root;
    const parts = path.relative(root, resolvedTarget).split(path.sep).filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      let stat;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          break;
        }
        return false;
      }
      if (stat.isSymbolicLink()) {
        return false;
      }
      if (index < parts.length - 1 && !stat.isDirectory()) {
        return false;
      }
      if (index === parts.length - 1 && !stat.isFile()) {
        return false;
      }
      const realPath = fs.realpathSync(current);
      if (realPath !== rootRealPath && !realPath.startsWith(rootRealPath + path.sep)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function assertSafeWorkspaceTarget(workspacePath, target, filePath = '') {
  if (!isSafeWorkspaceWriteTarget(workspacePath, target)) {
    throw new Error(`Unsafe mirror path: ${filePath || target}`);
  }
}

function assertSafeMirrorPathBeforeCreate(target, boundary) {
  const root = path.resolve(boundary);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget === root || !resolvedTarget.startsWith(root + path.sep)) {
    throw new Error(`Unsafe mirror root path: ${target}`);
  }
  let current = root;
  const parts = path.relative(root, resolvedTarget).split(path.sep).filter(Boolean);
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) {
      current = path.join(current, parts[index]);
    }
    if (!fs.existsSync(current)) {
      continue;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) {
      throw new Error(`Unsafe mirror root path: ${current}`);
    }
  }
}

function markMirrorDirty({ projectId, rootDir, reason = 'dirty_mirror' }) {
  const mirror = getProjectMirror(projectId, { rootDir });
  const baseline = readBaseline(mirror.baselinePath);
  writeBaseline(mirror.baselinePath, {
    ...baseline,
    projectKey: mirror.projectKey,
    dirty: true,
    dirtyReason: reason,
    dirtyAt: new Date().toISOString()
  });
}

function verifyWorkspaceMatchesBaseline(workspacePath, baselineFiles = []) {
  const baselinePaths = new Set();
  for (const file of baselineFiles || []) {
    if (!file?.path) {
      continue;
    }
    baselinePaths.add(file.path);
    const target = resolveWorkspacePath(workspacePath, file.path);
    if (!fs.existsSync(target)) {
      return { ok: false, reason: 'workspace_mismatch', path: file.path };
    }
    if (!isSafeWorkspaceWriteTarget(workspacePath, target)) {
      return { ok: false, reason: 'unsafe_path', path: file.path };
    }
    if (file.kind === 'binary') {
      if (hashBytes(fs.readFileSync(target)) !== file.hash) {
        return { ok: false, reason: 'workspace_mismatch', path: file.path };
      }
      continue;
    }
    const content = fs.readFileSync(target, 'utf8');
    if (hashText(content) !== file.hash) {
      return { ok: false, reason: 'workspace_mismatch', path: file.path };
    }
  }
  for (const filePath of listWorkspaceFiles(workspacePath)) {
    if (baselinePaths.has(filePath)) {
      continue;
    }
    if (isTextMirrorPath(filePath) && !isGeneratedArtifactPath(filePath)) {
      return { ok: false, reason: 'workspace_extra_file', path: filePath };
    }
  }
  return { ok: true };
}

module.exports = {
  SUBAGENT_QUEUE_DIR,
  NATIVE_OUTPUT_LIMIT_BYTES,
  SAFE_INLINE_BINARY_CHANGE_BYTES,
  SAFE_NATIVE_RESPONSE_PAYLOAD_BYTES,
  applyFileOverlays,
  confirmWritebackFiles,
  collectMirrorChangesDetailed,
  collectMirrorChanges,
  getDefaultMirrorRoot,
  getMirrorStatus,
  getProjectMirror,
  markMirrorDirty,
  patchMirrorFiles,
  syncOverleafToMirror
};
