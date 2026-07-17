'use strict';

const path = require('node:path');

const DEFAULT_MIN_READ_COMMANDS = 6;
const DEFAULT_OVERLAP_RATIO = 0.85;
const DEFAULT_REDUNDANT_STREAK = 2;
const DEFAULT_POST_STEER_REDUNDANT_STREAK = 2;
const DEFAULT_MIN_RANGE_LINES = 20;

function buildReadProgressRules() {
  return [
    'Inspection progress rules:',
    '- Map relevant files or sections once, then read targeted, non-overlapping ranges.',
    '- Keep track of ranges already inspected. Re-read one only when a named unresolved question requires it.',
    '- If a broad tool result is truncated, continue with bounded chunks; do not restart from the beginning.',
    '- After the relevant evidence is covered, stop inspecting and complete the requested analysis or edit.',
    '- Avoid narrating repeated plans such as “I will keep reading”; report substantive findings instead.'
  ].join('\n');
}

function createReadProgressGuard(options = {}) {
  const settings = {
    minReadCommands: positiveInteger(options.minReadCommands, DEFAULT_MIN_READ_COMMANDS),
    overlapRatio: boundedRatio(options.overlapRatio, DEFAULT_OVERLAP_RATIO),
    redundantStreak: positiveInteger(options.redundantStreak, DEFAULT_REDUNDANT_STREAK),
    postSteerRedundantStreak: positiveInteger(
      options.postSteerRedundantStreak,
      DEFAULT_POST_STEER_REDUNDANT_STREAK
    ),
    minRangeLines: positiveInteger(options.minRangeLines, DEFAULT_MIN_RANGE_LINES),
    workspacePath: String(options.workspacePath || '')
  };
  const coverageByFile = new Map();
  const commandCounts = new Map();
  let readCount = 0;
  let redundantStreak = 0;
  let postSteerRedundantStreak = 0;
  let steerIssued = false;
  let abortIssued = false;

  return {
    observe(item) {
      if (abortIssued) return noAction();
      const inspection = extractReadInspection(item, settings.workspacePath);
      if (!inspection) {
        if (item?.type === 'commandExecution') {
          redundantStreak = 0;
          postSteerRedundantStreak = 0;
        }
        return noAction();
      }

      readCount += 1;
      const signatureCount = (commandCounts.get(inspection.signature) || 0) + 1;
      commandCounts.set(inspection.signature, signatureCount);
      let overlapRatio = 0;
      let redundant = signatureCount > 1;

      if (inspection.range) {
        const intervals = coverageByFile.get(inspection.fileKey) || [];
        const overlapLines = countOverlapLines(intervals, inspection.range.startLine, inspection.range.endLine);
        const rangeLines = inspection.range.endLine - inspection.range.startLine + 1;
        overlapRatio = rangeLines > 0 ? overlapLines / rangeLines : 0;
        if (rangeLines >= settings.minRangeLines && overlapRatio >= settings.overlapRatio) {
          redundant = true;
        }
        coverageByFile.set(
          inspection.fileKey,
          mergeInterval(intervals, inspection.range.startLine, inspection.range.endLine)
        );
      }

      if (redundant) {
        redundantStreak += 1;
      } else {
        redundantStreak = 0;
      }

      const evidence = buildEvidence({
        inspection,
        overlapRatio,
        readCount,
        redundantStreak
      });

      if (steerIssued) {
        postSteerRedundantStreak = redundant ? postSteerRedundantStreak + 1 : 0;
        if (postSteerRedundantStreak >= settings.postSteerRedundantStreak) {
          abortIssued = true;
          return { action: 'abort', evidence };
        }
        return noAction(evidence);
      }

      if (readCount >= settings.minReadCommands && redundantStreak >= settings.redundantStreak) {
        steerIssued = true;
        postSteerRedundantStreak = 0;
        return { action: 'steer', evidence };
      }
      return noAction(evidence);
    },

    snapshot() {
      return {
        readCount,
        redundantStreak,
        postSteerRedundantStreak,
        steerIssued,
        abortIssued
      };
    }
  };
}

function createReadProgressController({ input = {}, request, fail, getTurn, emitEvent = () => {} } = {}) {
  const guard = createReadProgressGuard({
    workspacePath: input.workspacePath,
    ...(input.readProgressGuardOptions || {})
  });
  let pendingSteer = null;
  let steerInFlight = false;

  return {
    observe(item) {
      const decision = guard.observe(item);
      if (decision.action === 'steer') {
        steer(decision);
      } else if (decision.action === 'abort') {
        emitEvent('codex.no_progress.aborted', 'Codex kept rereading inspected project content', {
          ...decision.evidence,
          guardAction: 'abort'
        }, 'failed');
        fail(createNoProgressError(decision.evidence));
        return false;
      }
      return true;
    },

    flush() {
      if (!pendingSteer) return;
      const decision = pendingSteer;
      pendingSteer = null;
      steer(decision);
    }
  };

  function steer(decision) {
    if (steerInFlight) return;
    const turn = getTurn?.() || {};
    if (!turn.threadId || !turn.turnId) {
      pendingSteer = decision;
      return;
    }
    steerInFlight = true;
    emitEvent('codex.no_progress.steered', 'Repeated file reads detected; asking Codex to synthesize', {
      ...decision.evidence,
      guardAction: 'steer'
    }, 'warning');
    request('turn/steer', {
      threadId: turn.threadId,
      expectedTurnId: turn.turnId,
      input: [{
        type: 'text',
        text: buildReadProgressSteerText(decision.evidence, input.mode),
        text_elements: []
      }]
    }).catch(error => {
      const progressError = createNoProgressError(decision.evidence);
      progressError.message += ` Automatic steering failed: ${String(error?.message || error).slice(0, 500)}`;
      fail(progressError);
    });
  }
}

function extractReadInspection(item = {}, workspacePath = '') {
  if (item.type !== 'commandExecution') return null;
  const command = String(item.command || '').trim();
  if (!command) return null;
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  const readAction = actions.find(action => action?.type === 'read');
  if (!readAction && !looksLikeReadCommand(command)) return null;

  const bounded = extractBoundedRange(command);
  const rawPath = bounded?.path || readAction?.path || '';
  const fileKey = normalizeFileKey(rawPath, workspacePath);
  const displayPath = safeDisplayPath(fileKey, workspacePath) || path.basename(fileKey) || 'project file';
  const range = bounded
    ? { startLine: bounded.startLine, endLine: bounded.endLine }
    : null;
  return {
    fileKey: fileKey || displayPath,
    displayPath,
    range,
    signature: normalizeCommandSignature(command, workspacePath)
  };
}

function extractBoundedRange(command) {
  const source = String(command || '');
  const sedMatch = source.match(/\bsed\s+(?:-[A-Za-z]+\s+)*["']?(\d+)\s*,\s*(\d+)p["']?(?:\s+((?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s;&|]+)))?/i);
  if (sedMatch) {
    return normalizeRangeMatch(sedMatch[1], sedMatch[2], sedMatch[3]);
  }
  const headMatch = source.match(/\bhead\s+(?:(?:-n|--lines)\s+|--lines=)(\d+)\s+((?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s;&|]+))/i);
  if (headMatch) {
    return normalizeRangeMatch(1, headMatch[1], headMatch[2]);
  }
  return null;
}

function normalizeRangeMatch(startValue, endValue, pathValue) {
  const startLine = Number(startValue);
  const endLine = Number(endValue);
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
    return null;
  }
  return {
    startLine,
    endLine,
    path: unquoteShellWord(pathValue)
  };
}

function looksLikeReadCommand(command) {
  return /^\s*(?:cat|head|tail|sed|nl)\b/i.test(command)
    || /(?:^|[;&|]\s*)(?:cat|head|tail|sed|nl)\b/i.test(command);
}

function normalizeFileKey(value, workspacePath) {
  const source = unquoteShellWord(value);
  if (!source) return '';
  if (path.isAbsolute(source)) return path.normalize(source);
  return path.resolve(workspacePath || '.', source);
}

function safeDisplayPath(fileKey, workspacePath) {
  if (!fileKey) return '';
  if (workspacePath) {
    const relative = path.relative(path.resolve(workspacePath), path.resolve(fileKey));
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      return relative.replace(/\\/g, '/');
    }
    if (!relative) return path.basename(fileKey);
  }
  return path.basename(fileKey);
}

function normalizeCommandSignature(command, workspacePath) {
  let value = String(command || '').replace(/\s+/g, ' ').trim();
  if (workspacePath) {
    value = value.split(path.resolve(workspacePath)).join('<workspace>');
  }
  return value;
}

function countOverlapLines(intervals, startLine, endLine) {
  let overlap = 0;
  for (const interval of intervals) {
    const start = Math.max(startLine, interval.startLine);
    const end = Math.min(endLine, interval.endLine);
    if (end >= start) overlap += end - start + 1;
  }
  return overlap;
}

function mergeInterval(intervals, startLine, endLine) {
  const result = [];
  let next = { startLine, endLine };
  let inserted = false;
  for (const interval of intervals) {
    if (interval.endLine + 1 < next.startLine) {
      result.push(interval);
      continue;
    }
    if (next.endLine + 1 < interval.startLine) {
      if (!inserted) {
        result.push(next);
        inserted = true;
      }
      result.push(interval);
      continue;
    }
    next = {
      startLine: Math.min(next.startLine, interval.startLine),
      endLine: Math.max(next.endLine, interval.endLine)
    };
  }
  if (!inserted) result.push(next);
  return result;
}

function buildEvidence({ inspection, overlapRatio, readCount, redundantStreak }) {
  return {
    file: inspection.displayPath,
    startLine: inspection.range?.startLine || null,
    endLine: inspection.range?.endLine || null,
    overlapRatio: Number(overlapRatio.toFixed(3)),
    readCount,
    redundantStreak
  };
}

function buildReadProgressSteerText(evidence = {}, mode = 'ask') {
  const location = evidence.startLine && evidence.endLine
    ? `${evidence.file}:${evidence.startLine}-${evidence.endLine}`
    : evidence.file;
  const overlap = Math.round(Number(evidence.overlapRatio || 0) * 100);
  const action = mode === 'ask'
    ? 'Produce the final analysis now, with concrete findings and explicit uncertainty where needed.'
    : 'Proceed with the requested edit using the evidence already gathered, then report the result.';
  return [
    `Runtime progress check: the latest read of ${location || 'a project file'} overlapped already inspected content by ${overlap}%.`,
    'Stop issuing inspection commands and do not reread covered ranges.',
    action,
    'Do not mention this progress check in the user-facing answer.'
  ].join(' ');
}

function createNoProgressError(evidence = {}) {
  const file = evidence.file || 'project files';
  const error = new Error(
    `Codex continued rereading already inspected ranges in ${file} after an automatic progress correction. ` +
    'The run was stopped to prevent an unbounded tool loop. Retry with a narrower @file or section scope.'
  );
  error.code = 'codex_no_usable_result';
  return error;
}

function unquoteShellWord(value) {
  const text = String(value || '').trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedRatio(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

function noAction(evidence = null) {
  return { action: 'none', evidence };
}

module.exports = {
  buildReadProgressRules,
  buildReadProgressSteerText,
  createNoProgressError,
  createReadProgressController,
  createReadProgressGuard,
  extractBoundedRange,
  extractReadInspection
};
