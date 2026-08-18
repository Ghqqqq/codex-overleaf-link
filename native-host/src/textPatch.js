'use strict';


function computeTextPatches(oldText, newText) {
  if (oldText === newText) {
    return [];
  }

  const groups = computeLineAnchoredChangeGroups(oldText, newText);
  const naturalPatches = groups.flatMap(group => computeNaturalGroupPatches(group));
  if (isValidNaturalPatchSet(oldText, newText, naturalPatches)) {
    return naturalPatches;
  }

  // Semantic fallback stays scoped to the line-anchored windows. A budget
  // overflow must never turn sparse file-wide edits into one first-to-last
  // replacement.
  return groups.flatMap(singleGroupPatch);
}

function isValidNaturalPatchSet(oldText, newText, patches) {
  if (!Array.isArray(patches) || patches.length === 0) {
    return false;
  }

  const ordered = [...patches].sort((left, right) => left.from - right.from || left.to - right.to);
  let previousEnd = 0;
  for (const patch of ordered) {
    if (
      !patch
      || !Number.isInteger(patch.from)
      || !Number.isInteger(patch.to)
      || patch.from < previousEnd
      || patch.to < patch.from
      || oldText.slice(patch.from, patch.to) !== patch.expected
    ) {
      return false;
    }
    previousEnd = patch.to;
  }

  let applied = oldText;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const patch = ordered[index];
    applied = applied.slice(0, patch.from) + patch.insert + applied.slice(patch.to);
  }
  return applied === newText;
}



function computeNaturalGroupPatches(group) {
  const tokenPatches = computeTokenAnchoredPatches(
    group.oldText,
    group.newText,
    group.oldStart
  );
  const metrics = computeGroupMetrics(group, tokenPatches);
  const classification = classifyChangedGroup(group, tokenPatches, metrics);

  if (classification.type === 'annotated_block') {
    return singleGroupPatch(group);
  }
  if (classification.type === 'paragraph_rewrite') {
    const paragraphPatches = computeParagraphPatches(group);
    return paragraphPatches !== null
      ? paragraphPatches
      : singleGroupPatch(group);
  }
  if (classification.type === 'sentence_rewrite') {
    const sentencePatches = computeSentencePatches(group, tokenPatches);
    return sentencePatches !== null
      ? sentencePatches
      : coalesceTokenPatches(group, tokenPatches);
  }
  if (classification.type === 'small_edit') {
    return coalesceTokenPatches(group, tokenPatches);
  }

  return tokenPatches.length > 0
    ? coalesceTokenPatches(group, tokenPatches)
    : singleGroupPatch(group);
}

function computeSingleTextPatch(oldValue, newValue, offset = 0) {
  let prefixLength = 0;
  const sharedLength = Math.min(oldValue.length, newValue.length);
  while (prefixLength < sharedLength && oldValue[prefixLength] === newValue[prefixLength]) {
    prefixLength += 1;
  }

  let oldEnd = oldValue.length;
  let newEnd = newValue.length;
  while (
    oldEnd > prefixLength
    && newEnd > prefixLength
    && oldValue[oldEnd - 1] === newValue[newEnd - 1]
  ) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  return {
    from: offset + prefixLength,
    to: offset + oldEnd,
    expected: oldValue.slice(prefixLength, oldEnd),
    insert: newValue.slice(prefixLength, newEnd)
  };
}


function computeLineAnchoredChangeGroups(oldValue, newValue) {
  if (oldValue === newValue) {
    return [];
  }

  const oldParts = splitTextParts(oldValue);
  const newParts = splitTextParts(newValue);
  const oldOffsets = computeNaturalPartOffsets(oldParts);
  const groups = [];

  collectNaturalLineGroups({
    oldParts,
    newParts,
    oldOffsets,
    oldFrom: 0,
    oldTo: oldParts.length,
    newFrom: 0,
    newTo: newParts.length,
    groups,
    depth: 0
  });

  if (groups.length === 0) {
    groups.push({
      oldStart: 0,
      oldText: oldValue,
      newText: newValue
    });
  }
  return groups;
}

function computeNaturalPartOffsets(parts) {
  const offsets = new Array(parts.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < parts.length; index += 1) {
    offsets[index + 1] = offsets[index] + parts[index].length;
  }
  return offsets;
}

function pushNaturalLineGroup(state, oldFrom, oldTo, newFrom, newTo) {
  const oldText = state.oldParts.slice(oldFrom, oldTo).join('');
  const newText = state.newParts.slice(newFrom, newTo).join('');
  if (oldText === newText) {
    return;
  }
  state.groups.push({
    oldStart: state.oldOffsets[oldFrom],
    oldText,
    newText
  });
}

function collectNaturalLineGroups(state) {
  let { oldFrom, oldTo, newFrom, newTo } = state;

  while (
    oldFrom < oldTo
    && newFrom < newTo
    && state.oldParts[oldFrom] === state.newParts[newFrom]
  ) {
    oldFrom += 1;
    newFrom += 1;
  }
  while (
    oldFrom < oldTo
    && newFrom < newTo
    && state.oldParts[oldTo - 1] === state.newParts[newTo - 1]
  ) {
    oldTo -= 1;
    newTo -= 1;
  }

  if (oldFrom === oldTo || newFrom === newTo) {
    pushNaturalLineGroup(state, oldFrom, oldTo, newFrom, newTo);
    return;
  }

  const oldCount = oldTo - oldFrom;
  const newCount = newTo - newFrom;
  const MAX_PARTS = 5000;
  const MAX_PRODUCT = 4_000_000;
  if (
    oldCount <= MAX_PARTS
    && newCount <= MAX_PARTS
    && oldCount * newCount <= MAX_PRODUCT
  ) {
    appendNaturalExactLineGroups(state, oldFrom, oldTo, newFrom, newTo);
    return;
  }

  let anchors = discoverNaturalLineAnchors(
    state.oldParts,
    state.newParts,
    oldFrom,
    oldTo,
    newFrom,
    newTo,
    4
  );
  if (anchors.length === 0) {
    anchors = discoverNaturalLineAnchors(
      state.oldParts,
      state.newParts,
      oldFrom,
      oldTo,
      newFrom,
      newTo,
      8
    );
  }

  if (anchors.length > 0 && state.depth < 10) {
    let oldCursor = oldFrom;
    let newCursor = newFrom;
    for (const anchor of anchors) {
      collectNaturalLineGroups({
        ...state,
        oldFrom: oldCursor,
        oldTo: anchor.oldIndex,
        newFrom: newCursor,
        newTo: anchor.newIndex,
        depth: state.depth + 1
      });
      oldCursor = anchor.oldIndex + 1;
      newCursor = anchor.newIndex + 1;
    }
    collectNaturalLineGroups({
      ...state,
      oldFrom: oldCursor,
      oldTo,
      newFrom: newCursor,
      newTo,
      depth: state.depth + 1
    });
    return;
  }

  if (
    oldCount === newCount
    && appendNaturalPositionalLineGroups(state, oldFrom, oldTo, newFrom, newTo)
  ) {
    return;
  }

  pushNaturalLineGroup(state, oldFrom, oldTo, newFrom, newTo);
}

function appendNaturalExactLineGroups(state, oldFrom, oldTo, newFrom, newTo) {
  const matches = computeNaturalLcsMatches(
    state.oldParts.slice(oldFrom, oldTo),
    state.newParts.slice(newFrom, newTo)
  );
  let oldCursor = oldFrom;
  let newCursor = newFrom;
  for (const match of matches) {
    const oldIndex = oldFrom + match.oldIndex;
    const newIndex = newFrom + match.newIndex;
    pushNaturalLineGroup(state, oldCursor, oldIndex, newCursor, newIndex);
    oldCursor = oldIndex + 1;
    newCursor = newIndex + 1;
  }
  pushNaturalLineGroup(state, oldCursor, oldTo, newCursor, newTo);
}

function computeNaturalLcsMatches(oldItems, newItems) {
  const oldCount = oldItems.length;
  const newCount = newItems.length;
  const width = newCount + 1;
  const table = new Uint32Array((oldCount + 1) * width);

  for (let oldIndex = oldCount - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newCount - 1; newIndex >= 0; newIndex -= 1) {
      const cell = oldIndex * width + newIndex;
      table[cell] = oldItems[oldIndex] === newItems[newIndex]
        ? table[(oldIndex + 1) * width + newIndex + 1] + 1
        : Math.max(
          table[(oldIndex + 1) * width + newIndex],
          table[oldIndex * width + newIndex + 1]
        );
    }
  }

  const matches = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldCount && newIndex < newCount) {
    if (oldItems[oldIndex] === newItems[newIndex]) {
      matches.push({ oldIndex, newIndex });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      table[(oldIndex + 1) * width + newIndex]
      >= table[oldIndex * width + newIndex + 1]
    ) {
      oldIndex += 1;
    } else {
      newIndex += 1;
    }
  }
  return matches;
}

function discoverNaturalLineAnchors(
  oldParts,
  newParts,
  oldFrom,
  oldTo,
  newFrom,
  newTo,
  occurrenceLimit
) {
  const oldOccurrences = collectNaturalOccurrences(oldParts, oldFrom, oldTo, 1);
  const newOccurrences = collectNaturalOccurrences(newParts, newFrom, newTo, 1);
  const candidates = [];

  for (const [signature, oldIndexes] of oldOccurrences) {
    const newIndexes = newOccurrences.get(signature);
    if (
      !newIndexes
      || oldIndexes.length > occurrenceLimit
      || newIndexes.length > occurrenceLimit
      || signature.trim() === ''
    ) {
      continue;
    }
    for (const oldIndex of oldIndexes) {
      for (const newIndex of newIndexes) {
        candidates.push({ oldIndex, newIndex });
      }
    }
  }
  return selectNaturalMonotonicAnchors(candidates, 1);
}

function collectNaturalOccurrences(items, from, to, span) {
  const occurrences = new Map();
  for (let index = from; index + span <= to; index += 1) {
    const signature = span === 1
      ? items[index]
      : JSON.stringify(items.slice(index, index + span));
    const indexes = occurrences.get(signature);
    if (indexes) {
      indexes.push(index);
    } else {
      occurrences.set(signature, [index]);
    }
  }
  return occurrences;
}

function selectNaturalMonotonicAnchors(candidates, span) {
  if (candidates.length === 0) {
    return [];
  }

  candidates.sort((left, right) => (
    left.oldIndex - right.oldIndex || right.newIndex - left.newIndex
  ));
  const tailValues = [];
  const tailCandidateIndexes = [];
  const predecessors = new Int32Array(candidates.length);
  predecessors.fill(-1);

  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = candidates[candidateIndex];
    let low = 0;
    let high = tailValues.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (tailValues[middle] < candidate.newIndex) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    if (low > 0) {
      predecessors[candidateIndex] = tailCandidateIndexes[low - 1];
    }
    tailValues[low] = candidate.newIndex;
    tailCandidateIndexes[low] = candidateIndex;
  }

  const selected = [];
  let cursor = tailCandidateIndexes[tailCandidateIndexes.length - 1];
  while (cursor >= 0) {
    selected.push(candidates[cursor]);
    cursor = predecessors[cursor];
  }
  selected.reverse();

  const nonOverlapping = [];
  let previousOldEnd = -1;
  let previousNewEnd = -1;
  for (const anchor of selected) {
    if (
      anchor.oldIndex >= previousOldEnd
      && anchor.newIndex >= previousNewEnd
    ) {
      nonOverlapping.push(anchor);
      previousOldEnd = anchor.oldIndex + span;
      previousNewEnd = anchor.newIndex + span;
    }
  }
  return nonOverlapping;
}

function appendNaturalPositionalLineGroups(state, oldFrom, oldTo, newFrom, newTo) {
  if (oldTo - oldFrom !== newTo - newFrom) {
    return false;
  }

  let changed = false;
  let lowSimilarityOldStart = -1;
  let lowSimilarityNewStart = -1;

  const flushLowSimilarityRun = (oldEnd, newEnd) => {
    if (lowSimilarityOldStart < 0) {
      return;
    }
    pushNaturalLineGroup(
      state,
      lowSimilarityOldStart,
      oldEnd,
      lowSimilarityNewStart,
      newEnd
    );
    lowSimilarityOldStart = -1;
    lowSimilarityNewStart = -1;
  };

  for (let offset = 0; offset < oldTo - oldFrom; offset += 1) {
    const oldIndex = oldFrom + offset;
    const newIndex = newFrom + offset;
    const oldLine = state.oldParts[oldIndex];
    const newLine = state.newParts[newIndex];

    if (oldLine === newLine) {
      flushLowSimilarityRun(oldIndex, newIndex);
      continue;
    }

    changed = true;
    if (computeNaturalLineSimilarity(oldLine, newLine) >= 0.55) {
      flushLowSimilarityRun(oldIndex, newIndex);
      pushNaturalLineGroup(state, oldIndex, oldIndex + 1, newIndex, newIndex + 1);
    } else if (lowSimilarityOldStart < 0) {
      lowSimilarityOldStart = oldIndex;
      lowSimilarityNewStart = newIndex;
    }
  }
  flushLowSimilarityRun(oldTo, newTo);
  return changed;
}

function computeNaturalLineSimilarity(oldLine, newLine) {
  if (oldLine === newLine) {
    return 1;
  }
  const denominator = Math.max(oldLine.length, newLine.length, 1);
  let prefix = 0;
  while (
    prefix < oldLine.length
    && prefix < newLine.length
    && oldLine[prefix] === newLine[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLine.length - prefix
    && suffix < newLine.length - prefix
    && oldLine[oldLine.length - 1 - suffix] === newLine[newLine.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return (prefix + suffix) / denominator;
}


function computeTokenAnchoredPatches(oldValue, newValue, offset = 0) {
  if (oldValue === newValue) {
    return [];
  }

  const oldTokens = splitTextTokens(oldValue);
  const newTokens = splitTextTokens(newValue);
  const oldOffsets = computeNaturalTokenOffsets(oldTokens, oldValue.length);
  const newOffsets = computeNaturalTokenOffsets(newTokens, newValue.length);
  const patches = [];

  collectNaturalTokenPatches({
    oldValue,
    newValue,
    oldTokens,
    newTokens,
    oldTokenTexts: oldTokens.map(token => token.text),
    newTokenTexts: newTokens.map(token => token.text),
    oldOffsets,
    newOffsets,
    offset,
    patches,
    oldFrom: 0,
    oldTo: oldTokens.length,
    newFrom: 0,
    newTo: newTokens.length,
    depth: 0
  });

  return patches.sort((left, right) => left.from - right.from || left.to - right.to);
}


function computeNaturalTokenOffsets(tokens, textLength) {
  const offsets = new Array(tokens.length + 1);
  for (let index = 0; index < tokens.length; index += 1) {
    offsets[index] = tokens[index].start;
  }
  offsets[tokens.length] = textLength;
  return offsets;
}

function collectNaturalTokenPatches(state) {
  let { oldFrom, oldTo, newFrom, newTo } = state;

  while (
    oldFrom < oldTo
    && newFrom < newTo
    && state.oldTokenTexts[oldFrom] === state.newTokenTexts[newFrom]
  ) {
    oldFrom += 1;
    newFrom += 1;
  }
  while (
    oldFrom < oldTo
    && newFrom < newTo
    && state.oldTokenTexts[oldTo - 1] === state.newTokenTexts[newTo - 1]
  ) {
    oldTo -= 1;
    newTo -= 1;
  }

  if (oldFrom === oldTo || newFrom === newTo) {
    pushNaturalTokenPatch(state, oldFrom, oldTo, newFrom, newTo);
    return;
  }

  const oldCount = oldTo - oldFrom;
  const newCount = newTo - newFrom;
  const oldChars = state.oldOffsets[oldTo] - state.oldOffsets[oldFrom];
  const newChars = state.newOffsets[newTo] - state.newOffsets[newFrom];
  const MAX_GROUP_CHARS = 20_000;
  const MAX_TOKENS = 3000;
  const MAX_PRODUCT = 4_000_000;

  if (
    oldChars + newChars <= MAX_GROUP_CHARS
    && oldCount <= MAX_TOKENS
    && newCount <= MAX_TOKENS
    && oldCount * newCount <= MAX_PRODUCT
  ) {
    appendNaturalExactTokenPatches(state, oldFrom, oldTo, newFrom, newTo);
    return;
  }

  const anchors = discoverNaturalTokenAnchors(
    state.oldTokenTexts,
    state.newTokenTexts,
    oldFrom,
    oldTo,
    newFrom,
    newTo
  );
  if (anchors.length > 0 && state.depth < 8) {
    const ANCHOR_SPAN = 3;
    let oldCursor = oldFrom;
    let newCursor = newFrom;
    for (const anchor of anchors) {
      collectNaturalTokenPatches({
        ...state,
        oldFrom: oldCursor,
        oldTo: anchor.oldIndex,
        newFrom: newCursor,
        newTo: anchor.newIndex,
        depth: state.depth + 1
      });
      oldCursor = anchor.oldIndex + ANCHOR_SPAN;
      newCursor = anchor.newIndex + ANCHOR_SPAN;
    }
    collectNaturalTokenPatches({
      ...state,
      oldFrom: oldCursor,
      oldTo,
      newFrom: newCursor,
      newTo,
      depth: state.depth + 1
    });
    return;
  }

  pushNaturalTokenPatch(state, oldFrom, oldTo, newFrom, newTo);
}

function pushNaturalTokenPatch(state, oldFrom, oldTo, newFrom, newTo) {
  const oldStart = state.oldOffsets[oldFrom];
  const oldEnd = state.oldOffsets[oldTo];
  const newStart = state.newOffsets[newFrom];
  const newEnd = state.newOffsets[newTo];
  const expected = state.oldValue.slice(oldStart, oldEnd);
  const insert = state.newValue.slice(newStart, newEnd);
  if (expected === insert) {
    return;
  }
  state.patches.push({
    from: state.offset + oldStart,
    to: state.offset + oldEnd,
    expected,
    insert
  });
}

function appendNaturalExactTokenPatches(state, oldFrom, oldTo, newFrom, newTo) {
  const matches = computeNaturalLcsMatches(
    state.oldTokenTexts.slice(oldFrom, oldTo),
    state.newTokenTexts.slice(newFrom, newTo)
  );
  let oldCursor = oldFrom;
  let newCursor = newFrom;
  for (const match of matches) {
    const oldIndex = oldFrom + match.oldIndex;
    const newIndex = newFrom + match.newIndex;
    pushNaturalTokenPatch(state, oldCursor, oldIndex, newCursor, newIndex);
    oldCursor = oldIndex + 1;
    newCursor = newIndex + 1;
  }
  pushNaturalTokenPatch(state, oldCursor, oldTo, newCursor, newTo);
}

function discoverNaturalTokenAnchors(
  oldTokens,
  newTokens,
  oldFrom,
  oldTo,
  newFrom,
  newTo
) {
  const ANCHOR_SPAN = 3;
  const oldOccurrences = collectNaturalOccurrences(
    oldTokens,
    oldFrom,
    oldTo,
    ANCHOR_SPAN
  );
  const newOccurrences = collectNaturalOccurrences(
    newTokens,
    newFrom,
    newTo,
    ANCHOR_SPAN
  );
  const candidates = [];

  for (const [signature, oldIndexes] of oldOccurrences) {
    const newIndexes = newOccurrences.get(signature);
    if (
      !newIndexes
      || oldIndexes.length > 4
      || newIndexes.length > 4
    ) {
      continue;
    }
    for (const oldIndex of oldIndexes) {
      for (const newIndex of newIndexes) {
        candidates.push({ oldIndex, newIndex });
      }
    }
  }
  return selectNaturalMonotonicAnchors(candidates, ANCHOR_SPAN);
}

function splitTextTokens(text) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const start = index;
    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
      while (index < text.length && /\s/.test(text[index])) {
        index += 1;
      }
    } else if (char === '\\') {
      index += 1;
      if (index < text.length && /[A-Za-z@]/.test(text[index])) {
        while (index < text.length && /[A-Za-z@]/.test(text[index])) {
          index += 1;
        }
      } else if (index < text.length) {
        index += 1;
      }
    } else if (/[A-Za-z0-9_]/.test(char)) {
      index += 1;
      while (index < text.length && /[A-Za-z0-9_]/.test(text[index])) {
        index += 1;
      }
    } else {
      index += 1;
      while (
        index < text.length
        && !/\s/.test(text[index])
        && text[index] !== '\\'
        && !/[A-Za-z0-9_]/.test(text[index])
      ) {
        index += 1;
      }
    }
    tokens.push({
      text: text.slice(start, index),
      start,
      end: index
    });
  }
  return tokens;
}

function splitTextParts(text) {
  return String(text || '').match(/[^\n]*\n|[^\n]+/g) || [];
}

function computePartEdits(oldParts, newParts) {
  const n = oldParts.length;
  const m = newParts.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = oldParts[i] === newParts[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const edits = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldParts[i] === newParts[j]) {
      edits.push({ type: 'equal', oldIndex: i, newIndex: j });
      i += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      edits.push({ type: 'remove', oldIndex: i });
      i += 1;
      continue;
    } else {
      edits.push({ type: 'add', newIndex: j });
    }
    j += 1;
  }
  while (i < n) {
    edits.push({ type: 'remove', oldIndex: i });
    i += 1;
  }
  while (j < m) {
    edits.push({ type: 'add', newIndex: j });
    j += 1;
  }
  return edits;
}

function countNonEmptyLines(text) {
  const value = String(text ?? '');
  let count = 0;
  for (const line of value.split('\n')) {
    if (line.trim() !== '') {
      count += 1;
    }
  }
  return count;
}

function countSentenceTerminators(text) {
  const value = String(text ?? '');
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '。' || char === '？' || char === '！') {
      count += 1;
      continue;
    }
    if (char === '.' || char === '?' || char === '!') {
      if (
        char === '.'
        && /[0-9]/.test(value[index - 1] || '')
        && /[0-9]/.test(value[index + 1] || '')
      ) {
        // Decimal point inside a number such as `1.23` is not a boundary.
        continue;
      }
      count += 1;
    }
  }
  return count;
}

function hasOriginalMarkerLine(text) {
  return String(text ?? '')
    .split('\n')
    .some(line => /^\s*%\s*\[original\]\s*$/.test(line));
}

function hasLaterRevisedMarkerLine(text) {
  const lines = String(text ?? '').split('\n');
  const originalIndex = lines.findIndex(line => /^\s*%\s*\[original\]\s*$/.test(line));
  if (originalIndex === -1) {
    return false;
  }
  return lines.some((line, index) => (
    index > originalIndex && /^\s*%\s*\[revised\]\s*$/.test(line)
  ));
}

function hasAnyAnnotatedMarker(text) {
  return String(text ?? '')
    .split('\n')
    .some(line => (
      /^\s*%\s*\[original\]\s*$/.test(line) || /^\s*%\s*\[revised\]\s*$/.test(line)
    ));
}

function splitParagraphs(text) {
  const value = String(text ?? '');
  const separator = /\n\s*\n/g;
  const segments = [];
  let lastIndex = 0;
  let match = separator.exec(value);

  while (match) {
    segments.push({ text: value.slice(lastIndex, match.index), start: lastIndex });
    segments.push({ text: match[0], start: match.index });
    lastIndex = match.index + match[0].length;
    match = separator.exec(value);
  }
  segments.push({ text: value.slice(lastIndex), start: lastIndex });

  return segments;
}

// Lowercase abbreviations whose trailing `.` is conservatively NOT a sentence
// boundary. The word ending in the dot is matched case-insensitively, so this
// also covers `Fig.`, `Eq.`, `No.`, etc.
const NON_TERMINAL_ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'cf', 'vs', 'etc', 'al', 'fig', 'figs', 'eq', 'eqs', 'sec',
  'secs', 'thm', 'lem', 'def', 'prop', 'cor', 'ref', 'no', 'vol', 'pp',
  'ch', 'app', 'resp', 'approx', 'mr', 'ms', 'mrs', 'dr', 'prof', 'st'
]);

function isLatexCommandStart(text, index) {
  return text[index] === '\\' && /[A-Za-z@]/.test(text[index + 1] || '');
}

// True when the contiguous non-whitespace run containing `index` looks like a
// URL (has a scheme such as `https://`, or starts with `www.`). A `.` inside
// such a run is never a confident sentence boundary.
function isInsideUrl(text, index) {
  let runStart = index;
  while (runStart > 0 && !/\s/.test(text[runStart - 1])) {
    runStart -= 1;
  }
  let runEnd = index;
  while (runEnd < text.length && !/\s/.test(text[runEnd])) {
    runEnd += 1;
  }
  const run = text.slice(runStart, runEnd);
  return /:\/\//.test(run) || /^www\./i.test(run);
}

// True when the `.` at `index` completes a known abbreviation such as `e.g.`
// or `Fig.` rather than ending a sentence.
function completesAbbreviation(text, index) {
  let wordStart = index;
  while (wordStart > 0 && /[A-Za-z.]/.test(text[wordStart - 1])) {
    wordStart -= 1;
  }
  const word = text.slice(wordStart, index).toLowerCase();
  return word.length > 0 && NON_TERMINAL_ABBREVIATIONS.has(word);
}

// True when the ASCII terminator `.` `?` `!` at `index` is a confident
// sentence boundary: it must be followed by whitespace, end-of-string, or a
// LaTeX command boundary, and must not sit inside a decimal number, a URL, or
// a known abbreviation.
function isConfidentAsciiBoundary(text, index) {
  const next = text[index + 1];
  const followedByBoundary = next === undefined
    || /\s/.test(next)
    || isLatexCommandStart(text, index + 1);
  if (!followedByBoundary) {
    return false;
  }
  if (text[index] === '.') {
    const prev = text[index - 1];
    if (/[0-9]/.test(prev || '') && /[0-9]/.test(next || '')) {
      // Decimal point inside a number such as `1.23`.
      return false;
    }
    if (isInsideUrl(text, index)) {
      return false;
    }
    if (completesAbbreviation(text, index)) {
      return false;
    }
  }
  return true;
}

// Splits `text` into ordered sentence spans `[{text, start, end}]` that
// partition the input exactly (concatenated they equal `text`). Each span
// includes its trailing terminator and the whitespace up to the next
// sentence. Conservative: when no confident boundary is found the whole input
// is returned as a single span.
function splitSentences(text) {
  const value = String(text ?? '');
  if (value.length === 0) {
    return [{ text: '', start: 0, end: 0 }];
  }

  const spans = [];
  let spanStart = 0;
  let index = 0;

  while (index < value.length) {
    const char = value[index];
    let isBoundary = false;

    if (char === '。' || char === '？' || char === '！') {
      // CJK terminators are unambiguous: they never appear in decimals, URLs,
      // or LaTeX command names, so they always end a sentence.
      isBoundary = true;
    } else if (char === '.' || char === '?' || char === '!') {
      isBoundary = isConfidentAsciiBoundary(value, index);
    }

    if (isBoundary) {
      // Absorb trailing whitespace up to the next sentence into this span.
      let spanEnd = index + 1;
      while (spanEnd < value.length && /\s/.test(value[spanEnd])) {
        spanEnd += 1;
      }
      if (spanEnd < value.length) {
        spans.push({
          text: value.slice(spanStart, spanEnd),
          start: spanStart,
          end: spanEnd
        });
        spanStart = spanEnd;
        index = spanEnd;
        continue;
      }
    }

    index += 1;
  }

  spans.push({
    text: value.slice(spanStart),
    start: spanStart,
    end: value.length
  });

  return spans;
}



function computeGroupMetrics(group, tokenPatches) {
  const oldNonEmptyLineCount = countNonEmptyLines(group.oldText);
  const newNonEmptyLineCount = countNonEmptyLines(group.newText);
  return {
    oldNonEmptyLineCount,
    newNonEmptyLineCount,
    maxNonEmptyLineCount: Math.max(oldNonEmptyLineCount, newNonEmptyLineCount),
    changedSpanChars: Math.max(group.oldText.length, group.newText.length),
    tokenPatchCount: Array.isArray(tokenPatches) ? tokenPatches.length : null,
    totalTokenChangedChars: Array.isArray(tokenPatches)
      ? tokenPatches.reduce(
        (sum, patch) => sum + Math.max(patch.expected.length, patch.insert.length),
        0
      )
      : null,
    oldSentenceTerminatorCount: countSentenceTerminators(group.oldText),
    newSentenceTerminatorCount: countSentenceTerminators(group.newText)
  };
}

function resolveTokenPatchSentenceSpan(group, tokenPatches) {
  const empty = {
    fitsOneSpan: false,
    spanChars: 0,
    spanTokenCount: 0,
    spanStart: 0,
    spanEnd: 0
  };
  if (tokenPatches === null || tokenPatches.length === 0) {
    return empty;
  }

  const sentenceSpans = splitSentences(group.oldText);
  let containingSpan = null;

  for (const span of sentenceSpans) {
    const containsEveryPatch = tokenPatches.every(patch => {
      const relativeFrom = patch.from - group.oldStart;
      const relativeTo = patch.to - group.oldStart;
      return relativeFrom >= span.start && relativeTo <= span.end;
    });
    if (!containsEveryPatch) {
      continue;
    }
    if (containingSpan !== null) {
      // More than one span contains every patch (possible for a zero-length
      // patch sitting on a span boundary). Not a confident single sentence.
      return empty;
    }
    containingSpan = span;
  }

  if (containingSpan === null) {
    return empty;
  }
  return {
    fitsOneSpan: true,
    spanChars: containingSpan.text.length,
    spanTokenCount: splitTextTokens(containingSpan.text).length,
    spanStart: containingSpan.start,
    spanEnd: containingSpan.end
  };
}

// Classifies a changed group into a natural review granularity. Pure function.
//
// `group` is `{oldStart, oldText, newText}`; `tokenPatches` is the array from
// `computeTokenAnchoredPatches(group.oldText, group.newText, group.oldStart)`
// or `null`; `metrics` is the object from `computeGroupMetrics(group,
// tokenPatches)`.
//
// Returns `{type}` where `type` is one of `annotated_block`,
// `paragraph_rewrite`, `sentence_rewrite`, `small_edit`, `fallback`. The
// predicates are evaluated in first-match order: annotated_block →
// paragraph_rewrite → sentence_rewrite → small_edit → fallback. When
// `tokenPatches === null`, every token-dependent predicate is false, so the
// only reachable results are `annotated_block`, `paragraph_rewrite` (via the
// line-count or sentence-terminator branch), and `fallback`.



function classifyChangedGroup(group, tokenPatches, metrics) {
  if (hasAnyAnnotatedMarker(group.oldText) || hasAnyAnnotatedMarker(group.newText)) {
    return { type: 'annotated_block' };
  }

  const hasTokenPatches = Array.isArray(tokenPatches) && tokenPatches.length > 0;
  const maxTokenPatchChars = hasTokenPatches
    ? tokenPatches.reduce(
      (maximum, patch) => Math.max(
        maximum,
        patch.expected.length,
        patch.insert.length
      ),
      0
    )
    : null;
  const editDensity = hasTokenPatches
    ? metrics.totalTokenChangedChars / Math.max(1, metrics.changedSpanChars)
    : null;
  const sentenceSpan = hasTokenPatches
    ? resolveTokenPatchSentenceSpan(group, tokenPatches)
    : null;
  const sentenceEditDensity = sentenceSpan?.fitsOneSpan
    ? metrics.totalTokenChangedChars / Math.max(1, sentenceSpan.spanChars)
    : null;

  const isDenseTokenRewrite = hasTokenPatches
    && metrics.tokenPatchCount >= 6
    && metrics.changedSpanChars >= 160
    && editDensity >= 0.20
    && metrics.tokenPatchCount / Math.max(1, metrics.maxNonEmptyLineCount) >= 2;
  if (isDenseTokenRewrite) {
    return { type: 'paragraph_rewrite' };
  }

  // A dense rewrite wholly contained in one confident sentence stays a
  // sentence patch even when the surrounding line contains unchanged prose.
  if (
    hasTokenPatches
    && metrics.tokenPatchCount >= 3
    && sentenceSpan.fitsOneSpan
    && sentenceSpan.spanChars >= 80
    && sentenceEditDensity >= 0.20
  ) {
    return { type: 'sentence_rewrite' };
  }

  // A collection of bounded, low-density edits stays local regardless of the
  // file size, line count, or number of repeated replacements.
  if (
    hasTokenPatches
    && maxTokenPatchChars <= 96
    && editDensity < 0.20
  ) {
    return { type: 'small_edit' };
  }

  if (metrics.maxNonEmptyLineCount >= 3) {
    return { type: 'paragraph_rewrite' };
  }
  if (
    metrics.oldSentenceTerminatorCount >= 2
    && metrics.newSentenceTerminatorCount >= 2
    && !sentenceSpan?.fitsOneSpan
  ) {
    return { type: 'paragraph_rewrite' };
  }

  if (
    hasTokenPatches
    && metrics.tokenPatchCount >= 3
    && sentenceSpan.fitsOneSpan
    && sentenceSpan.spanChars >= 80
  ) {
    return { type: 'sentence_rewrite' };
  }

  if (
    hasTokenPatches
    && (
      metrics.tokenPatchCount <= 2
      || metrics.totalTokenChangedChars < 80
    )
  ) {
    return { type: 'small_edit' };
  }

  return { type: 'fallback' };
}

function singleGroupPatch(group) {
  return [computeSingleTextPatch(group.oldText, group.newText, group.oldStart)];
}

// Builds paragraph-level patches for a changed group (spec §4).
//
// Segments `group.oldText` and `group.newText` with `splitParagraphs`, which
// yields alternating [content, separator, content, ...] segments. When both
// sides share the SAME separator structure (same segment count and identical
// separator segments) the content paragraphs are paired positionally and one
// patch is emitted per changed pair, with `from`/`to` as absolute offsets
// (`group.oldStart` + the old paragraph segment's start). A single-paragraph
// group is the degenerate case of this rule: one pair, one patch.
//
// Returns `null` when pairing is ambiguous (separator counts differ or a
// separator segment changed), so the caller can fall back to a group patch.
function computeParagraphPatches(group) {
  const oldSegments = splitParagraphs(group.oldText);
  const newSegments = splitParagraphs(group.newText);

  if (oldSegments.length !== newSegments.length) {
    return null;
  }
  // splitParagraphs always yields an odd count: content at even indices,
  // blank-line separators at odd indices. Every separator must be unchanged
  // for positional pairing of the content paragraphs to be sound.
  for (let index = 1; index < oldSegments.length; index += 2) {
    if (oldSegments[index].text !== newSegments[index].text) {
      return null;
    }
  }

  const patches = [];
  for (let index = 0; index < oldSegments.length; index += 2) {
    const oldParagraph = oldSegments[index];
    const newParagraph = newSegments[index];
    if (oldParagraph.text === newParagraph.text) {
      continue;
    }
    patches.push(computeSingleTextPatch(
      oldParagraph.text,
      newParagraph.text,
      group.oldStart + oldParagraph.start
    ));
  }
  return patches;
}

// Builds a single sentence-level patch for a `sentence_rewrite` group (spec
// §5). Every token patch lies inside one confident sentence span `[a,b)` of
// `group.oldText`. Because all token changes are inside that span, the regions
// `group.oldText.slice(0,a)` and `group.oldText.slice(b)` are unchanged, so
// `group.newText` is `prefix + <new sentence> + suffix` with the same prefix
// and suffix; `<new sentence>` is derived by stripping them.
//
// Returns `[patch]` whose `from`/`to` cover only that old sentence span
// (absolute offsets), or `null` when the single span cannot be identified or
// the unchanged prefix/suffix do not actually match (defensive).
function computeSentencePatches(group, tokenPatches) {
  const span = resolveTokenPatchSentenceSpan(group, tokenPatches);
  if (!span.fitsOneSpan) {
    return null;
  }

  const { spanStart, spanEnd } = span;
  const oldPrefix = group.oldText.slice(0, spanStart);
  const oldSuffix = group.oldText.slice(spanEnd);
  const oldSentence = group.oldText.slice(spanStart, spanEnd);

  // The regions outside the sentence span must be byte-identical between old
  // and new text; otherwise a change leaked outside the span and a single
  // sentence patch would be wrong.
  if (
    !group.newText.startsWith(oldPrefix)
    || !group.newText.endsWith(oldSuffix)
    || group.newText.length < oldPrefix.length + oldSuffix.length
  ) {
    return null;
  }

  const newSentence = group.newText.slice(
    oldPrefix.length,
    group.newText.length - oldSuffix.length
  );
  return [computeSingleTextPatch(
    oldSentence,
    newSentence,
    group.oldStart + spanStart
  )];
}

// Short function words whose presence inside a coalescing gap does not block a
// merge. Combined with pure punctuation and whitespace, these define a gap
// that is "mostly" connective filler (spec §7).
const COALESCE_FILLER_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'so', 'yet', 'of', 'to', 'in',
  'on', 'at', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'for', 'with',
  'that', 'this', 'it', 'its', 'we', 'our'
]);

// True when the gap text between two token patches is short connective filler:
// only whitespace, punctuation, and short function words. An empty gap counts
// as filler.
function isCoalesceFillerGap(gap) {
  if (gap.length > 40) {
    return false;
  }
  for (const token of splitTextTokens(gap)) {
    const text = token.text;
    if (/^\s+$/.test(text)) {
      continue;
    }
    if (!/[A-Za-z0-9]/.test(text)) {
      // Pure punctuation / symbols.
      continue;
    }
    if (COALESCE_FILLER_WORDS.has(text.toLowerCase())) {
      continue;
    }
    return false;
  }
  return true;
}

// Conservative safety-net coalescing of token patches (spec §7). Adjacent
// token patches are merged when they lie in the same sentence span of
// `group.oldText`, the gap between them is at most 40 chars of whitespace /
// punctuation / short function words, and that sentence span contains at
// least 3 token patches. A merged patch spans `[firstFrom, lastTo)` with
// `expected` the original slice and `insert` the merged inserts interleaved
// with the unchanged gap text. When nothing qualifies the token patches are
// returned unchanged. Absolute offsets are preserved throughout.

function coalesceTokenPatches(group, tokenPatches) {
  if (!Array.isArray(tokenPatches) || tokenPatches.length <= 1) {
    return Array.isArray(tokenPatches) && tokenPatches.length > 0
      ? tokenPatches
      : singleGroupPatch(group);
  }

  const ordered = [...tokenPatches].sort(
    (left, right) => left.from - right.from || left.to - right.to
  );
  const result = [];
  let run = [ordered[0]];

  const flushRun = () => {
    if (run.length >= 3 && computeNaturalPatchRunDensity(group, run) >= 0.35) {
      result.push(mergeTokenPatchRun(group, run));
    } else {
      result.push(...run);
    }
    run = [];
  };

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = run[run.length - 1];
    const current = ordered[index];
    const gapStart = Math.max(0, previous.to - group.oldStart);
    const gapEnd = Math.max(gapStart, current.from - group.oldStart);
    const gap = group.oldText.slice(gapStart, gapEnd);
    const canJoin = gap.length <= 40
      && !/\n\s*\n/.test(gap)
      && isCoalesceFillerGap(gap);

    if (canJoin) {
      run.push(current);
    } else {
      flushRun();
      run = [current];
    }
  }
  flushRun();
  return result;
}

function computeNaturalPatchRunDensity(group, run) {
  const first = run[0];
  const last = run[run.length - 1];
  const oldSpan = Math.max(1, last.to - first.from);
  const changedChars = run.reduce(
    (sum, patch) => sum + Math.max(patch.expected.length, patch.insert.length),
    0
  );
  return Math.min(1, changedChars / oldSpan);
}

function mergeTokenPatchRun(group, run) {
  const first = run[0];
  const last = run[run.length - 1];
  let expected = first.expected;
  let insert = first.insert;

  for (let index = 1; index < run.length; index += 1) {
    const prev = run[index - 1];
    const current = run[index];
    const gap = group.oldText.slice(
      prev.to - group.oldStart,
      current.from - group.oldStart
    );
    expected += gap + current.expected;
    insert += gap + current.insert;
  }

  return {
    from: first.from,
    to: last.to,
    expected,
    insert
  };
}

module.exports = {
  computeTextPatches,
  computeSingleTextPatch,
  computeLineAnchoredChangeGroups,
  computeTokenAnchoredPatches,
  computeGroupMetrics,
  classifyChangedGroup,
  splitParagraphs,
  splitSentences,
  hasOriginalMarkerLine,
  hasLaterRevisedMarkerLine,
  hasAnyAnnotatedMarker,
  countNonEmptyLines,
  countSentenceTerminators,
  singleGroupPatch,
  computeParagraphPatches,
  computeSentencePatches,
  coalesceTokenPatches
};
