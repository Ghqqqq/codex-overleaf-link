const assert = require('node:assert/strict');
const test = require('node:test');

const { computeLineDiff } = require('../native-host/src/diffEngine');

test('returns empty hunks for identical content', () => {
  const hunks = computeLineDiff('hello\nworld\n', 'hello\nworld\n');
  assert.deepEqual(hunks, []);
});

test('detects single line addition', () => {
  const hunks = computeLineDiff('a\nb\n', 'a\nb\nc\n');
  assert.equal(hunks.length, 1);
  const lines = hunks[0].lines;
  assert.ok(lines.some(l => l.type === 'add' && l.text === 'c'));
  assert.ok(lines.some(l => l.type === 'context' && l.text === 'b'));
});

test('detects single line removal', () => {
  const hunks = computeLineDiff('a\nb\nc\n', 'a\nc\n');
  assert.equal(hunks.length, 1);
  const lines = hunks[0].lines;
  assert.ok(lines.some(l => l.type === 'remove' && l.text === 'b'));
});

test('detects replacement (remove + add)', () => {
  const hunks = computeLineDiff('old title\nbody\n', 'new title\nbody\n');
  assert.equal(hunks.length, 1);
  const lines = hunks[0].lines;
  assert.ok(lines.some(l => l.type === 'remove' && l.text === 'old title'));
  assert.ok(lines.some(l => l.type === 'add' && l.text === 'new title'));
});

test('provides context lines around changes', () => {
  const old = 'a\nb\nc\nd\ne\nf\ng\n';
  const next = 'a\nb\nc\nD\ne\nf\ng\n';
  const hunks = computeLineDiff(old, next, 2);
  assert.equal(hunks.length, 1);
  const contextLines = hunks[0].lines.filter(l => l.type === 'context');
  assert.ok(contextLines.some(l => l.text === 'b'));
  assert.ok(contextLines.some(l => l.text === 'c'));
  assert.ok(contextLines.some(l => l.text === 'e'));
  assert.ok(contextLines.some(l => l.text === 'f'));
});

test('handles multiple separate hunks', () => {
  const old = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n';
  const next = 'a\nB\nc\nd\ne\nf\ng\nH\ni\nj\n';
  const hunks = computeLineDiff(old, next, 1);
  assert.equal(hunks.length, 2);
});

test('handles empty old content (all additions)', () => {
  const hunks = computeLineDiff('', 'new\ncontent\n');
  assert.equal(hunks.length, 1);
  assert.ok(hunks[0].lines.every(l => l.type === 'add'));
});

test('handles empty new content (all removals)', () => {
  const hunks = computeLineDiff('old\ncontent\n', '');
  assert.equal(hunks.length, 1);
  assert.ok(hunks[0].lines.every(l => l.type === 'remove'));
});

test('returns fallback hunk for files exceeding line threshold', () => {
  const oldLines = Array.from({ length: 6000 }, (_, i) => `line ${i}`).join('\n');
  const newLines = Array.from({ length: 6000 }, (_, i) => `modified ${i}`).join('\n');
  const hunks = computeLineDiff(oldLines, newLines);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].truncated, true);
  assert.ok(hunks[0].lines.length <= 1);
  assert.ok(hunks[0].lines[0].type === 'context');
  assert.match(hunks[0].lines[0].text, /Large file change/);
});

test('returns fallback hunk when edit distance would be too large', () => {
  const oldLines = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join('\n');
  const newLines = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join('\n');
  const hunks = computeLineDiff(oldLines, newLines, 3, 'zh');
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].truncated, true);
  assert.match(hunks[0].lines[0].text, /改动较大/);
});

test('still computes diff for moderately sized files', () => {
  const oldLines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const newLines = Array.from({ length: 200 }, (_, i) => i === 100 ? 'CHANGED' : `line ${i}`).join('\n');
  const hunks = computeLineDiff(oldLines, newLines);
  assert.ok(hunks.length >= 1);
  assert.equal(hunks[0].truncated, undefined);
  assert.ok(hunks[0].lines.some(l => l.type === 'add' && l.text === 'CHANGED'));
});
