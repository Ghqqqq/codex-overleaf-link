'use strict';

function computeLineDiff(oldText, newText, contextLines = 3, locale = 'en') {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  if (oldLines.join('\n') === newLines.join('\n')) {
    return [];
  }

  const MAX_LINES = 5000;
  const MAX_DIFF_PRODUCT = 4000000;

  if (oldLines.length > MAX_LINES || newLines.length > MAX_LINES || oldLines.length * newLines.length > MAX_DIFF_PRODUCT) {
    return buildTruncatedResult(oldLines.length, newLines.length, locale);
  }

  const edits = myersDiff(oldLines, newLines);
  if (edits === null) {
    return buildTruncatedResult(oldLines.length, newLines.length, locale);
  }

  return buildHunks(oldLines, newLines, edits, contextLines);
}

function buildTruncatedResult(oldCount, newCount, locale = 'en') {
  return [{
    startA: 1,
    startB: 1,
    truncated: true,
    lines: [{
      type: 'context',
      text: locale === 'zh'
        ? `文件改动较大（${oldCount} → ${newCount} 行），请在 Overleaf 中查看完整差异。`
        : `Large file change (${oldCount} → ${newCount} lines). Review the full diff in Overleaf.`
    }]
  }];
}

function splitLines(text) {
  const lines = String(text || '').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function myersDiff(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;
  const max = n + m;

  if (max === 0) {
    return [];
  }

  const vSize = 2 * max + 1;
  let v = new Array(vSize).fill(0);
  const trace = [];

  const MAX_EDIT_DISTANCE = 1500;

  for (let d = 0; d <= max; d++) {
    if (d > MAX_EDIT_DISTANCE) {
      return null;
    }
    trace.push([...v]);
    const newV = [...v];
    for (let k = -d; k <= d; k += 2) {
      const kIndex = k + max;
      let x;
      if (k === -d || (k !== d && v[kIndex - 1] < v[kIndex + 1])) {
        x = v[kIndex + 1];
      } else {
        x = v[kIndex - 1] + 1;
      }
      let y = x - k;

      while (x < n && y < m && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }

      newV[kIndex] = x;

      if (x >= n && y >= m) {
        trace[d] = newV;
        return backtrack(trace, oldLines, newLines, d, max);
      }
    }
    v = newV;
  }

  return buildFallbackEdits(oldLines, newLines);
}

function backtrack(trace, oldLines, newLines, finalD, max) {
  const edits = [];
  let x = oldLines.length;
  let y = newLines.length;

  for (let d = finalD; d >= 0; d--) {
    const k = x - y;

    let prevK, prevX, prevY;
    if (d === 0) {
      prevX = 0;
      prevY = 0;
    } else {
      const prevVState = trace[d];
      if (k === -d || (k !== d && prevVState[k - 1 + max] < prevVState[k + 1 + max])) {
        prevK = k + 1;
      } else {
        prevK = k - 1;
      }
      prevX = prevVState[prevK + max];
      prevY = prevX - prevK;
    }

    // Snake: diagonal moves after the edit
    const midX = d > 0 ? (prevK < k ? prevX + 1 : prevX) : 0;
    const midY = d > 0 ? (prevK > k ? prevY + 1 : prevY) : 0;

    while (x > midX && y > midY) {
      x--;
      y--;
      edits.unshift({ type: 'equal', oldIndex: x, newIndex: y });
    }

    // The edit move itself
    if (d > 0) {
      if (prevK < k) {
        // Moved right: deletion
        x--;
        edits.unshift({ type: 'remove', oldIndex: x });
      } else {
        // Moved down: insertion
        y--;
        edits.unshift({ type: 'add', newIndex: y });
      }
    }
  }

  // Initial diagonal at d=0
  while (x > 0 && y > 0) {
    x--;
    y--;
    edits.unshift({ type: 'equal', oldIndex: x, newIndex: y });
  }

  return edits;
}

function buildFallbackEdits(oldLines, newLines) {
  const edits = [];
  for (let i = 0; i < oldLines.length; i++) {
    edits.push({ type: 'remove', oldIndex: i });
  }
  for (let i = 0; i < newLines.length; i++) {
    edits.push({ type: 'add', newIndex: i });
  }
  return edits;
}

function buildHunks(oldLines, newLines, edits, contextLines) {
  const changes = edits.filter(e => e.type !== 'equal');
  if (!changes.length) {
    return [];
  }

  const changeIndices = [];
  for (let i = 0; i < edits.length; i++) {
    if (edits[i].type !== 'equal') {
      changeIndices.push(i);
    }
  }

  const groups = [];
  let currentGroup = [changeIndices[0]];

  for (let i = 1; i < changeIndices.length; i++) {
    const gap = changeIndices[i] - changeIndices[i - 1] - 1;
    if (gap <= contextLines * 2) {
      currentGroup.push(changeIndices[i]);
    } else {
      groups.push(currentGroup);
      currentGroup = [changeIndices[i]];
    }
  }
  groups.push(currentGroup);

  const hunks = [];
  for (const group of groups) {
    const firstIdx = Math.max(0, group[0] - contextLines);
    const lastIdx = Math.min(edits.length - 1, group[group.length - 1] + contextLines);
    const hunkEdits = edits.slice(firstIdx, lastIdx + 1);

    const lines = [];
    let startA = -1;
    let startB = -1;

    for (const edit of hunkEdits) {
      if (edit.type === 'equal') {
        if (startA === -1) {
          startA = edit.oldIndex;
          startB = edit.newIndex;
        }
        lines.push({ type: 'context', text: oldLines[edit.oldIndex] });
      } else if (edit.type === 'remove') {
        if (startA === -1) {
          startA = edit.oldIndex;
          startB = findNewIndex(edits, firstIdx, edit.oldIndex);
        }
        lines.push({ type: 'remove', text: oldLines[edit.oldIndex] });
      } else if (edit.type === 'add') {
        if (startA === -1) {
          startA = findOldIndex(edits, firstIdx, edit.newIndex);
          startB = edit.newIndex;
        }
        lines.push({ type: 'add', text: newLines[edit.newIndex] });
      }
    }

    hunks.push({
      startA: startA >= 0 ? startA + 1 : 1,
      startB: startB >= 0 ? startB + 1 : 1,
      lines
    });
  }

  return hunks;
}

function findNewIndex(edits, startFrom, oldIndex) {
  for (let i = startFrom; i < edits.length; i++) {
    if (edits[i].newIndex !== undefined) {
      return edits[i].newIndex;
    }
  }
  return 0;
}

function findOldIndex(edits, startFrom, newIndex) {
  for (let i = startFrom; i < edits.length; i++) {
    if (edits[i].oldIndex !== undefined) {
      return edits[i].oldIndex;
    }
  }
  return 0;
}

module.exports = { computeLineDiff };
