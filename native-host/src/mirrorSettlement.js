'use strict';

const { computeLineDiff } = require('./diffEngine');
const { collectMirrorChangesDetailed, markMirrorDirty } = require('./mirrorWorkspace');
const { prepareBinaryAssetChanges } = require('./nativeAssetTransfer');
const { reduceTaskResult } = require('./nativeTransportEnvelope');
const { filterSelectionChanges } = require('./selectionScope');
const { normalizeSafeProjectPath } = require('../../extension/src/shared/projectFiles');
const { computeTextPatches } = require('./textPatch');
const { throwIfAborted } = require('./codexSessionTiming');

async function settleMirrorEdits({
  params = {},
  mirror,
  rootDir,
  projectId,
  runnerResult = {},
  emit,
  signal,
  selectionScope = null,
  subagentBroker = null
} = {}) {
  const collected = await collectMirrorChangesDetailed({ projectId, rootDir });
  const selectionChanges = filterSelectionChanges(collected.changes || [], selectionScope);
  const filteredChanges = filterSyncChangesForFocus({
    changes: selectionChanges.changes,
    focusFiles: params.focusFiles || params.session?.focusFiles,
    focusFilesAreLiteral: params.focusFilesAreLiteral === true,
    restrictToFocusFiles: params.restrictToFocusFiles
  });
  let rawSyncChanges = filteredChanges.changes;
  const unsupportedChanges = [
    ...(collected.unsupportedChanges || []),
    ...selectionChanges.unsupportedChanges,
    ...filteredChanges.unsupportedChanges
  ];
  const subagentViolationPaths = subagentBroker ? subagentBroker.getViolationPaths() : null;
  if (subagentViolationPaths && subagentViolationPaths.size) {
    const violatedPath = change => [change.path, change.to].find(file => file && subagentViolationPaths.has(file));
    const blocked = rawSyncChanges.filter(change => violatedPath(change));
    rawSyncChanges = rawSyncChanges.filter(change => !violatedPath(change));
    for (const change of blocked) {
      unsupportedChanges.push({
        type: 'unsupported-local-file',
        path: change.path,
        reason: subagentBroker.getBlockedReason(violatedPath(change))
      });
    }
  }
  if (rawSyncChanges.length || unsupportedChanges.length) {
    markMirrorDirty({
      projectId,
      rootDir,
      reason: params.mode === 'ask'
        ? 'ask_mode_local_changes'
        : (params.agentEngine === 'cursor' ? 'cursor_run_local_changes' : 'codex_run_local_changes')
    });
  }
  throwIfAborted(signal);

  const assistantMessage = cleanAssistantMessage(runnerResult.assistantMessage);
  const threadId = runnerResult.threadId || '';
  const cursorAgentId = runnerResult.cursorAgentId || '';
  if (params.mode === 'ask') {
    emitEvent(emit, 'overleaf.sync.changes', 'Ask mode finished without Overleaf writeback', {
      changedCount: 0,
      files: [],
      unsupportedCount: 0,
      unsupportedFiles: [],
      ignoredChangedCount: rawSyncChanges.length,
      ignoredUnsupportedCount: unsupportedChanges.length
    }, rawSyncChanges.length || unsupportedChanges.length ? 'warning' : 'completed');
    return reduceTaskResult({
      status: 'completed',
      projectId: mirror.projectKey,
      workspacePath: mirror.workspacePath,
      assistantMessage,
      threadId,
      cursorAgentId,
      syncChanges: [],
      unsupportedChanges: []
    });
  }

  const preparedAssets = prepareBinaryAssetChanges({ projectId, rootDir, changes: rawSyncChanges });
  rawSyncChanges = preparedAssets.changes;
  unsupportedChanges.push(...preparedAssets.unsupportedChanges);
  const syncChanges = rawSyncChanges.map(change => {
    if (change.type === 'write' && typeof change.previousContent === 'string') {
      return {
        ...change,
        diff: computeLineDiff(change.previousContent, change.content, 3, params.locale === 'zh' ? 'zh' : 'en'),
        patches: computeTextPatches(change.previousContent, change.content)
      };
    }
    return change;
  });
  const response = reduceTaskResult({
    status: 'completed',
    projectId: mirror.projectKey,
    workspacePath: mirror.workspacePath,
    assistantMessage,
    threadId,
    cursorAgentId,
    syncChanges,
    unsupportedChanges
  });
  emitEvent(emit, 'overleaf.sync.changes', params.agentEngine === 'cursor'
    ? 'Local Cursor changes collected for Overleaf sync'
    : 'Local Codex changes collected for Overleaf sync', {
    changedCount: response.syncChanges.length,
    files: response.syncChanges.map(change => change.path),
    unsupportedCount: response.unsupportedChanges.length,
    unsupportedFiles: response.unsupportedChanges.map(change => change.path)
  }, response.unsupportedChanges.length ? 'warning' : 'completed');
  return response;
}

function filterSyncChangesForFocus({ changes = [], focusFiles = [], restrictToFocusFiles = false, focusFilesAreLiteral = false } = {}) {
  if (!restrictToFocusFiles) {
    return { changes, unsupportedChanges: [] };
  }
  const focusSet = new Set(normalizeFocusFiles(focusFiles, focusFilesAreLiteral === true));
  if (!focusSet.size && focusFilesAreLiteral !== true) {
    return { changes, unsupportedChanges: [] };
  }

  const accepted = [];
  const rejected = [];
  for (const change of changes || []) {
    if (focusSet.has(normalizeSafeProjectPath(change?.path))
      && (!change?.to || focusSet.has(normalizeSafeProjectPath(change.to)))) {
      accepted.push(change);
    } else if (change?.path) {
      rejected.push({
        type: 'ignored-local-change',
        path: change.path,
        reason: 'out_of_focus_partial_snapshot'
      });
    }
  }
  return { changes: accepted, unsupportedChanges: rejected };
}

function normalizeFocusFiles(value, literal = false) {
  const seen = new Set();
  const files = [];
  for (const item of Array.isArray(value) ? value : []) {
    const filePath = literal ? normalizeSafeProjectPath(item) : normalizeProjectPath(item);
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    files.push(filePath);
    if (files.length >= 8) break;
  }
  return files;
}

function normalizeProjectPath(value) {
  return String(value || '')
    .replace(/^@file:/i, '')
    .replace(/\\/g, '/')
    .trim()
    .replace(/^\/+/, '');
}

function cleanAssistantMessage(value) {
  return String(value || '').trim();
}

function emitEvent(emit, type, title, detail = {}, status = 'running') {
  if (typeof emit !== 'function') return;
  emit({ type, title, status, detail, timestamp: new Date().toISOString() });
}

module.exports = {
  filterSyncChangesForFocus,
  settleMirrorEdits
};
