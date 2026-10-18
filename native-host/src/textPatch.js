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



// Builds the natural patches for one line-anchored change group.
//
// Annotated `% [original]` / `% [revised]` blocks are always replaced as one
// unit. Every other group goes through sentence alignment
// (`computeSentenceAlignedPatches`): unchanged sentences are skipped and each
// changed sentence is patched on its own.
function computeNaturalGroupPatches(group) {
  if (hasAnyAnnotatedMarker(group.oldText) || hasAnyAnnotatedMarker(group.newText)) {
    return singleGroupPatch(group);
  }
  return computeSentenceAlignedPatches(group);
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

// Characters that form a word for boundary alignment: the word class of
// `splitTextTokens` plus `\`, so a LaTeX command name stays attached to its
// backslash. CJK characters are deliberately excluded: they have no word
// boundaries, and widening across them would swallow whole clauses.
function isWordBoundaryChar(char) {
  return char === '\\' || isWordTokenChar(char);
}

// Like `computeSingleTextPatch`, but neither patch boundary may fall inside a
// word. The common-prefix / common-suffix trim can land mid-word in either the
// old or the new text (`" performs"` → `"s perform"`); such a cut is widened
// outward to the enclosing word boundaries, with the widened characters copied
// into both `expected` and `insert`, so the written bytes are unchanged and
// the tracked change reads as whole words.
function computeWordAlignedTextPatch(oldValue, newValue, offset = 0) {
  const patch = computeSingleTextPatch(oldValue, newValue, offset);
  let from = patch.from - offset;
  let to = patch.to - offset;
  // Offset in `newValue` where the shared suffix begins; it moves with `to`.
  let newTo = from + patch.insert.length;

  // The prefix is shared, so `newValue[index] === oldValue[index]` for every
  // index below the original cut; checking both sides only matters at the cut.
  while (
    from > 0
    && isWordBoundaryChar(oldValue[from - 1])
    && (isWordBoundaryChar(oldValue[from]) || isWordBoundaryChar(newValue[from]))
  ) {
    from -= 1;
  }
  while (
    to < oldValue.length
    && isWordBoundaryChar(oldValue[to])
    && (isWordBoundaryChar(oldValue[to - 1]) || isWordBoundaryChar(newValue[newTo - 1]))
  ) {
    to += 1;
    newTo += 1;
  }

  if (from === patch.from - offset && to === patch.to - offset) {
    return patch;
  }
  const prefix = oldValue.slice(from, patch.from - offset);
  const suffix = oldValue.slice(patch.to - offset, to);
  return {
    from: offset + from,
    to: offset + to,
    expected: oldValue.slice(from, to),
    insert: prefix + patch.insert + suffix
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

// Scripts without word boundaries: each character is its own token so an
// edit inside a Chinese or Japanese sentence stays local instead of covering
// the whole run between two spaces.
const CJK_TOKEN_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// Letters, digits, and `_` of any script except the CJK scripts above.
function isWordTokenChar(char) {
  return char !== undefined
    && /[\p{L}\p{N}_]/u.test(char)
    && !CJK_TOKEN_CHAR.test(char);
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
    } else if (CJK_TOKEN_CHAR.test(char)) {
      index += 1;
    } else if (isWordTokenChar(char)) {
      index += 1;
      while (index < text.length && isWordTokenChar(text[index])) {
        index += 1;
      }
    } else {
      index += 1;
      while (
        index < text.length
        && !/\s/.test(text[index])
        && text[index] !== '\\'
        && !isWordTokenChar(text[index])
        && !CJK_TOKEN_CHAR.test(text[index])
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

function hasAnyAnnotatedMarker(text) {
  return String(text ?? '')
    .split('\n')
    .some(line => (
      /^\s*%\s*\[original\]\s*$/.test(line) || /^\s*%\s*\[revised\]\s*$/.test(line)
    ));
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


function singleGroupPatch(group) {
  return [computeWordAlignedTextPatch(group.oldText, group.newText, group.oldStart)];
}

// Sentence alignment: the layer between line windows and token patches.
//
// A changed group is split into sentence spans on both sides
// (`splitSentences`, which partitions the text exactly). An LCS over the span
// texts keeps every unchanged sentence as an anchor. Inside each run between
// anchors, old and new sentences are paired by similarity
// (`pairSentencesBySimilarity`); every pair is patched by
// `computeSentencePairPatches`, sentences left without a partner on one side
// are inserted or deleted whole, and leftovers on both sides (a sentence that
// was split, merged, or rewritten beyond recognition) are patched as one run.
//
// Finally `mergeSemanticNeighbourPatches` joins adjacent results that are
// separated only by short whitespace / punctuation, so two rewritten
// neighbouring sentences surface as one tracked change.
//
// A group with one side empty (lines inserted or deleted) is a single patch.
// A group whose sentence count product exceeds the LCS budget is patched as
// one sentence pair instead.
const MAX_SENTENCE_ALIGN_PRODUCT = 4_000_000;

// Largest old×new sentence count of a run for which pairwise similarities are
// computed. Larger runs are patched as a single pair.
const MAX_SENTENCE_PAIRING_PRODUCT = 400;

// Fraction of a sentence that must have changed before the sentence is
// replaced as a whole instead of being patched word by word. Measured with
// trimmed edit sizes (`computeTrimmedChangeSize`), so `model` → `models`
// counts as one character, not six.
const SENTENCE_REWRITE_RATIO = 0.5;

// A sentence is also replaced as a whole when its edits are scattered: at
// least `SENTENCE_REWRITE_MIN_SITES` separate patches remain after
// coalescing and together they change at least
// `SENTENCE_REWRITE_SCATTERED_RATIO` of the sentence. Many word swaps spread
// over one sentence read as a retyped sentence, not as separate corrections;
// a handful of typo fixes (tiny mass) or a few word swaps stay word-level.
// Calibrated on a 37-word sentence: 6 swaps (21%) stay word-level, 9 swaps
// (30%) replace the sentence.
const SENTENCE_REWRITE_MIN_SITES = 3;
const SENTENCE_REWRITE_SCATTERED_RATIO = 0.25;

// Minimum similarity for two sentences to be treated as the same sentence
// edited: a sentence that changed by less than the rewrite threshold is still
// recognisably the same sentence.
const SENTENCE_PAIR_MIN_SIMILARITY = 1 - SENTENCE_REWRITE_RATIO;

function computeSentenceAlignedPatches(group) {
  if (group.oldText.length === 0 || group.newText.length === 0) {
    return singleGroupPatch(group);
  }

  const oldSpans = splitSentences(group.oldText);
  const newSpans = splitSentences(group.newText);
  if (oldSpans.length * newSpans.length > MAX_SENTENCE_ALIGN_PRODUCT) {
    return computeSentencePairPatches(group);
  }

  const matches = computeNaturalLcsMatches(
    oldSpans.map(span => span.text),
    newSpans.map(span => span.text)
  );
  const patches = [];
  let oldCursor = 0;
  let newCursor = 0;

  const appendRun = (oldTo, newTo) => {
    if (oldCursor === oldTo && newCursor === newTo) {
      return;
    }
    patches.push(...computeSentenceRunPatches(
      group,
      oldSpans,
      newSpans,
      oldCursor,
      oldTo,
      newCursor,
      newTo
    ));
  };

  for (const match of matches) {
    appendRun(match.oldIndex, match.newIndex);
    oldCursor = match.oldIndex + 1;
    newCursor = match.newIndex + 1;
  }
  appendRun(oldSpans.length, newSpans.length);

  return mergeSemanticNeighbourPatches(group, patches);
}

function resolveSpanBoundary(spans, index, textLength) {
  return index < spans.length ? spans[index].start : textLength;
}

// The sub-group covering old spans `[oldFrom, oldTo)` and new spans
// `[newFrom, newTo)`, with an absolute `oldStart`.
function resolveSentenceRun(group, oldSpans, newSpans, oldFrom, oldTo, newFrom, newTo) {
  const oldStart = resolveSpanBoundary(oldSpans, oldFrom, group.oldText.length);
  const oldEnd = resolveSpanBoundary(oldSpans, oldTo, group.oldText.length);
  const newStart = resolveSpanBoundary(newSpans, newFrom, group.newText.length);
  const newEnd = resolveSpanBoundary(newSpans, newTo, group.newText.length);
  return {
    oldStart: group.oldStart + oldStart,
    oldText: group.oldText.slice(oldStart, oldEnd),
    newText: group.newText.slice(newStart, newEnd)
  };
}

// Patches a run of sentences that has no exact anchor inside it.
function computeSentenceRunPatches(
  group,
  oldSpans,
  newSpans,
  oldFrom,
  oldTo,
  newFrom,
  newTo
) {
  const run = resolveSentenceRun(group, oldSpans, newSpans, oldFrom, oldTo, newFrom, newTo);
  if (run.oldText === run.newText) {
    return [];
  }
  if (oldFrom === oldTo || newFrom === newTo) {
    // Whole sentences inserted or deleted.
    return singleGroupPatch(run);
  }
  if ((oldTo - oldFrom) * (newTo - newFrom) > MAX_SENTENCE_PAIRING_PRODUCT) {
    return computeSentencePairPatches(run);
  }

  // Segments partition the run in order: paired sentences and the leftovers
  // between them (one-sided = inserted/deleted sentences, two-sided =
  // sentences with no recognisable partner).
  const pairs = pairSentencesBySimilarity(oldSpans, newSpans, oldFrom, oldTo, newFrom, newTo);
  const segments = [];
  let oldCursor = oldFrom;
  let newCursor = newFrom;
  const pushLeftover = (oldEnd, newEnd) => {
    if (oldCursor !== oldEnd || newCursor !== newEnd) {
      segments.push({ oldFrom: oldCursor, oldTo: oldEnd, newFrom: newCursor, newTo: newEnd, paired: false });
    }
  };
  for (const pair of pairs) {
    pushLeftover(pair.oldIndex, pair.newIndex);
    segments.push({
      oldFrom: pair.oldIndex,
      oldTo: pair.oldIndex + 1,
      newFrom: pair.newIndex,
      newTo: pair.newIndex + 1,
      paired: true
    });
    oldCursor = pair.oldIndex + 1;
    newCursor = pair.newIndex + 1;
  }
  pushLeftover(oldTo, newTo);
  absorbSplitSentences(group, oldSpans, newSpans, segments);

  const patches = [];
  for (const segment of segments) {
    const segmentRun = resolveSentenceRun(
      group,
      oldSpans,
      newSpans,
      segment.oldFrom,
      segment.oldTo,
      segment.newFrom,
      segment.newTo
    );
    if (segmentRun.oldText === segmentRun.newText) {
      continue;
    }
    if (segment.oldFrom === segment.oldTo || segment.newFrom === segment.newTo) {
      patches.push(...singleGroupPatch(segmentRun));
    } else {
      patches.push(...computeSentencePairPatches(segmentRun));
    }
  }
  return patches;
}

// A sentence that was split in two, or two sentences merged into one, shows
// up as a pair next to a one-sided leftover. Such a leftover is absorbed into
// a neighbouring pair when the combined pair still clears
// `SENTENCE_PAIR_MIN_SIMILARITY`, i.e. still reads as the same sentence with
// a local edit; when both neighbours qualify, the one that explains the
// leftover with fewer changed characters wins. Genuine insertions and
// deletions fail the similarity test and stay separate. Mutates `segments`.
function absorbSplitSentences(group, oldSpans, newSpans, segments) {
  const isOneSided = segment => segment.oldFrom === segment.oldTo || segment.newFrom === segment.newTo;
  // Change mass of the pair that would result from merging `first` and
  // `second`, or `null` when that pair would no longer read as one sentence.
  const combinedCost = (first, second) => {
    const run = resolveSentenceRun(
      group,
      oldSpans,
      newSpans,
      first.oldFrom,
      second.oldTo,
      first.newFrom,
      second.newTo
    );
    const changeMass = computeSentenceChangeMass(run.oldText, run.newText);
    const similarity = 1 - Math.min(
      1,
      changeMass / Math.max(run.oldText.length, run.newText.length, 1)
    );
    return similarity >= SENTENCE_PAIR_MIN_SIMILARITY ? changeMass : null;
  };

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!isOneSided(segment)) {
      continue;
    }
    const previous = segments[index - 1];
    const next = segments[index + 1];
    const previousCost = previous?.paired ? combinedCost(previous, segment) : null;
    const nextCost = next?.paired ? combinedCost(segment, next) : null;
    if (previousCost === null && nextCost === null) {
      continue;
    }
    if (nextCost !== null && (previousCost === null || nextCost <= previousCost)) {
      next.oldFrom = segment.oldFrom;
      next.newFrom = segment.newFrom;
    } else {
      previous.oldTo = segment.oldTo;
      previous.newTo = segment.newTo;
    }
    segments.splice(index, 1);
    index -= 1;
  }
}

// Summed trimmed size of the token patches between two texts: how many
// characters actually have to change to turn one into the other.
function computeSentenceChangeMass(oldText, newText) {
  if (oldText === newText) {
    return 0;
  }
  return computeTokenAnchoredPatches(oldText, newText, 0).reduce(
    (sum, patch) => sum + computeTrimmedChangeSize(patch),
    0
  );
}

// `1 - changeMass / length`. Identical sentences score 1.
function computeSentenceSimilarity(oldText, newText) {
  const changeMass = computeSentenceChangeMass(oldText, newText);
  return 1 - Math.min(1, changeMass / Math.max(oldText.length, newText.length, 1));
}

// Monotonic pairing of old spans `[oldFrom, oldTo)` with new spans
// `[newFrom, newTo)` that maximises the summed similarity of the pairs, only
// allowing pairs at or above `SENTENCE_PAIR_MIN_SIMILARITY`. Returns
// `[{oldIndex, newIndex}]` in ascending order.
function pairSentencesBySimilarity(oldSpans, newSpans, oldFrom, oldTo, newFrom, newTo) {
  const oldCount = oldTo - oldFrom;
  const newCount = newTo - newFrom;
  const threshold = SENTENCE_PAIR_MIN_SIMILARITY;
  const similarity = new Float64Array(oldCount * newCount);
  for (let i = 0; i < oldCount; i += 1) {
    for (let j = 0; j < newCount; j += 1) {
      similarity[i * newCount + j] = computeSentenceSimilarity(
        oldSpans[oldFrom + i].text,
        newSpans[newFrom + j].text
      );
    }
  }

  const width = newCount + 1;
  const score = new Float64Array((oldCount + 1) * width);
  for (let i = 1; i <= oldCount; i += 1) {
    for (let j = 1; j <= newCount; j += 1) {
      let best = Math.max(score[(i - 1) * width + j], score[i * width + j - 1]);
      const pairScore = similarity[(i - 1) * newCount + (j - 1)];
      if (pairScore >= threshold) {
        best = Math.max(best, score[(i - 1) * width + (j - 1)] + pairScore);
      }
      score[i * width + j] = best;
    }
  }

  const pairs = [];
  let i = oldCount;
  let j = newCount;
  while (i > 0 && j > 0) {
    const cell = score[i * width + j];
    const pairScore = similarity[(i - 1) * newCount + (j - 1)];
    if (
      pairScore >= threshold
      && cell === score[(i - 1) * width + (j - 1)] + pairScore
    ) {
      pairs.push({ oldIndex: oldFrom + i - 1, newIndex: newFrom + j - 1 });
      i -= 1;
      j -= 1;
    } else if (cell === score[(i - 1) * width + j]) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return pairs.reverse();
}

// Patches one old/new sentence pair. Token patches are computed inside the
// pair and coalesced; the pair becomes a single word-aligned replacement (a
// human would have retyped the sentence) when the trimmed change mass reaches
// `SENTENCE_REWRITE_RATIO` of the sentence, or when the edits are scattered
// over `SENTENCE_REWRITE_MIN_SITES` or more sites that together reach
// `SENTENCE_REWRITE_SCATTERED_RATIO`. Otherwise the coalesced token patches
// are returned.
function computeSentencePairPatches(pair) {
  const tokenPatches = computeTokenAnchoredPatches(
    pair.oldText,
    pair.newText,
    pair.oldStart
  );
  if (tokenPatches.length === 0) {
    return singleGroupPatch(pair);
  }

  const changeMass = tokenPatches.reduce(
    (sum, patch) => sum + computeTrimmedChangeSize(patch),
    0
  );
  const changeRatio = changeMass / Math.max(pair.oldText.length, pair.newText.length, 1);
  if (changeRatio >= SENTENCE_REWRITE_RATIO) {
    return singleGroupPatch(pair);
  }

  const coalesced = coalesceTokenPatches(pair, tokenPatches);
  if (
    coalesced.length >= SENTENCE_REWRITE_MIN_SITES
    && changeRatio >= SENTENCE_REWRITE_SCATTERED_RATIO
  ) {
    return singleGroupPatch(pair);
  }
  return coalesced;
}

// Size of the part of a patch that actually differs, after trimming the
// common prefix and suffix of `expected` / `insert`.
function computeTrimmedChangeSize(patch) {
  const trimmed = computeSingleTextPatch(patch.expected, patch.insert);
  return Math.max(trimmed.expected.length, trimmed.insert.length);
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
    if (!/[\p{L}\p{N}]/u.test(text)) {
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
//
// The run-based pass is followed by `mergeSemanticNeighbourPatches`, which
// joins any two remaining neighbours whose unchanged gap is pure whitespace /
// punctuation and no longer than either edit, so one continuous rewrite
// surfaces as a single tracked change.

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
  return mergeSemanticNeighbourPatches(group, result);
}

// Semantic neighbour merge, using the diff-match-patch `diff_cleanupSemantic`
// criterion: an unchanged stretch that is shorter than the edits on both sides
// of it is noise, not an anchor. Two neighbouring patches (sorted by `from`)
// are merged when the original text between them is at most 40 chars made
// only of whitespace and punctuation (no letters, digits, or line breaks) and
// is no longer than the smaller of the two edits, where an edit's size is
// `max(expected.length, insert.length)`. The gap is kept verbatim in both
// `expected` and `insert`, so the bytes written do not change. Merging chains:
// the merged patch is compared with the next neighbour. Gaps that contain a
// line break never merge, preserving the line-window split.
function mergeSemanticNeighbourPatches(group, patches) {
  if (!Array.isArray(patches) || patches.length <= 1) {
    return patches;
  }

  const merged = [patches[0]];
  for (let index = 1; index < patches.length; index += 1) {
    const previous = merged[merged.length - 1];
    const current = patches[index];
    if (current.from < previous.to) {
      merged.push(current);
      continue;
    }
    const gap = group.oldText.slice(
      previous.to - group.oldStart,
      current.from - group.oldStart
    );
    if (isSemanticNoiseGap(gap, previous, current)) {
      merged[merged.length - 1] = mergeTokenPatchRun(group, [previous, current]);
    } else {
      merged.push(current);
    }
  }
  return merged;
}

// Largest trimmed edit that still counts as a "small" edit for the sentence
// boundary rule below: a word or two, not a rewritten clause.
const SMALL_EDIT_CHARS = 24;

function isSemanticNoiseGap(gap, previous, current) {
  if (gap.length > 40 || /[\r\n]/.test(gap)) {
    return false;
  }
  if (!/^[\s\p{P}\p{S}]*$/u.test(gap)) {
    return false;
  }
  const previousSize = Math.max(previous.expected.length, previous.insert.length);
  const currentSize = Math.max(current.expected.length, current.insert.length);
  if (gap.length > Math.min(previousSize, currentSize)) {
    return false;
  }
  // The last word of one sentence and the first word of the next are two
  // edits, not one; only rewrites large enough to be whole clauses merge
  // across a sentence boundary.
  if (
    isSentenceBoundaryGap(gap)
    && Math.min(computeTrimmedChangeSize(previous), computeTrimmedChangeSize(current)) <= SMALL_EDIT_CHARS
  ) {
    return false;
  }
  return true;
}

// True when the unchanged text between two patches ends a sentence: a CJK
// terminator anywhere, or an ASCII terminator followed by whitespace (so the
// `.` inside `91.2` does not count).
function isSentenceBoundaryGap(gap) {
  return /[。？！]/.test(gap) || /[.?!]\s/.test(gap);
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
  computeWordAlignedTextPatch,
  computeSentenceAlignedPatches,
  computeSentencePairPatches,
  computeTrimmedChangeSize,
  computeLineAnchoredChangeGroups,
  computeTokenAnchoredPatches,
  splitSentences,
  hasAnyAnnotatedMarker,
  singleGroupPatch,
  coalesceTokenPatches
};
