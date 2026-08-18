const assert = require('node:assert/strict');
const test = require('node:test');

const { applyPatches } = require('./helpers/patches');
const {
  computeTextPatches,
  computeLineAnchoredChangeGroups,
  computeGroupMetrics,
  computeTokenAnchoredPatches,
  classifyChangedGroup,
  splitParagraphs,
  splitSentences,
  hasOriginalMarkerLine,
  hasLaterRevisedMarkerLine,
  hasAnyAnnotatedMarker,
  countNonEmptyLines,
  countSentenceTerminators,
  computeSingleTextPatch,
  singleGroupPatch,
  computeParagraphPatches,
  computeSentencePatches,
  coalesceTokenPatches
} = require('../native-host/src/textPatch');

// Builds the `{group, tokenPatches, metrics}` triple the way the orchestration
// will: real token patches via `computeTokenAnchoredPatches`, real metrics via
// `computeGroupMetrics`. `classifyChangedGroup` is then called with all three.
function classifyGroup(group) {
  const tokenPatches = computeTokenAnchoredPatches(
    group.oldText,
    group.newText,
    group.oldStart
  );
  const metrics = computeGroupMetrics(group, tokenPatches);
  return classifyChangedGroup(group, tokenPatches, metrics);
}

test('computes a small insertion patch instead of a full-file replacement', () => {
  const patches = computeTextPatches('hello world\n', 'hello brave world\n');

  assert.deepEqual(patches, [
    {
      from: 6,
      to: 6,
      expected: '',
      insert: 'brave '
    }
  ]);
});

test('computes a local replacement patch with expected old text', () => {
  const patches = computeTextPatches('old title\nbody\n', 'new title\nbody\n');

  assert.deepEqual(patches, [
    {
      from: 0,
      to: 3,
      expected: 'old',
      insert: 'new'
    }
  ]);
});

test('returns no patches for identical content', () => {
  assert.deepEqual(computeTextPatches('same\n', 'same\n'), []);
});

test('keeps distant line edits as separate local patches', () => {
  const oldText = [
    'title: old\n',
    'unchanged line 1\n',
    'unchanged line 2\n',
    'ending: old\n'
  ].join('');
  const newText = [
    'title: new\n',
    'unchanged line 1\n',
    'unchanged line 2\n',
    'ending: new\n'
  ].join('');

  assert.deepEqual(computeTextPatches(oldText, newText), [
    { from: 7, to: 10, expected: 'old', insert: 'new' },
    { from: 53, to: 56, expected: 'old', insert: 'new' }
  ]);
});

test('keeps distant edits in long LaTeX files as separate patches', () => {
  const oldLines = Array.from({ length: 1205 }, (_, index) => `line ${index}\n`);
  const newLines = oldLines.slice();
  newLines[12] = 'line 12 with local proof fix\n';
  newLines[1110] = 'line 1110 with local reference fix\n';
  const oldText = oldLines.join('');
  const newText = newLines.join('');

  const patches = computeTextPatches(oldText, newText);

  assert.equal(patches.length, 2);
  assert.equal(applyPatches(oldText, patches), newText);
  assert.ok(patches.every(patch => patch.to - patch.from < 80));
});

test('produces one paragraph patch for a rewritten wrapped paragraph', () => {
  const oldText = [
    'As generalized models of restless multi-armed bandits, weakly\n',
    'coupled networked systems have garnered notable attention due\n',
    'to applications in fairness-aware multiple access schemes and\n',
    'sustainable distributed load balancing across data centers.\n',
    'In these systems, agents are networked in the sense that their\n',
    'actions are constrained by global constraints, while they are\n',
    'weakly coupled since individual rewards and costs depend solely\n',
    "on each agent's own states and actions.\n"
  ].join('');
  const newText = [
    'As a broad generalization of restless multi-armed bandit\n',
    'problems, weakly coupled networked systems have recently drawn\n',
    'considerable interest in fairness-aware multiple access designs\n',
    'and in sustainable distributed load balancing for data centers.\n',
    'Within such systems, the agents are networked because their\n',
    'available actions are bound together by shared global limits,\n',
    'and they are only weakly coupled because each reward and cost\n',
    "depends purely on a single agent's own state and chosen action.\n"
  ].join('');

  const patches = computeTextPatches(oldText, newText);

  assert.equal(patches.length, 1);
  assert.equal(applyPatches(oldText, patches), newText);
  assert.ok(patches[0].expected.length > 160);
  assert.ok(patches[0].insert.length > 160);
});

test('computeTextPatches keeps a small word fix as one small token patch', () => {
  const oldText = 'The system runs fast in practice.\n';
  const newText = 'The system runs faster in practice.\n';

  const patches = computeTextPatches(oldText, newText);

  assert.equal(patches.length, 1);
  assert.equal(applyPatches(oldText, patches), newText);
  assert.deepEqual(patches, [
    { from: 16, to: 20, expected: 'fast', insert: 'faster' }
  ]);
});

test('computeTextPatches keeps a short phrase replacement token-local', () => {
  const oldText = 'It achieves sublinear regret under mild assumptions.\n';
  const newText = 'It achieves logarithmic regret under mild assumptions.\n';

  const patches = computeTextPatches(oldText, newText);

  assert.equal(applyPatches(oldText, patches), newText);
  assert.equal(patches.length, 1);
  assert.ok(Math.max(patches[0].to - patches[0].from, patches[0].insert.length) < 40);
});

test('computeTextPatches keeps distant local edits as separate patches', () => {
  const oldLines = Array.from({ length: 40 }, (_, index) => `line ${index}\n`);
  const newLines = oldLines.slice();
  newLines[2] = 'line 2 with a local fix\n';
  newLines[34] = 'line 34 with a local fix\n';
  const oldText = oldLines.join('');
  const newText = newLines.join('');

  const patches = computeTextPatches(oldText, newText);

  assert.ok(patches.length >= 2, `expected separate patches, got ${patches.length}`);
  assert.equal(applyPatches(oldText, patches), newText);
});

test('computeTextPatches produces one block patch for an annotated rewrite', () => {
  const oldText = [
    'The proposed scheme is fast. The proposed scheme is also robust.\n'
  ].join('');
  const newText = [
    '% [original]\n',
    '% The proposed scheme is fast. The proposed scheme is also robust.\n',
    '\n',
    '% [revised]\n',
    'The proposed scheme is efficient. The proposed scheme is also resilient.\n'
  ].join('');

  const patches = computeTextPatches(oldText, newText);

  assert.equal(patches.length, 1);
  assert.equal(applyPatches(oldText, patches), newText);
  assert.ok(patches[0].insert.includes('% [original]'));
  assert.ok(patches[0].insert.includes('% [revised]'));
});

test('computeTextPatches produces one sentence patch for a single sentence rewrite', () => {
  const firstSentence =
    'The unchanged opening sentence introduces the topic and stays exactly as written here. ';
  const oldSecond =
    'The proposed algorithm achieves sublinear regret and bounded constraint violation under mild assumptions.';
  const newSecond =
    'The proposed method achieves logarithmic regret and tight constraint violation under standard assumptions.';
  const oldText = firstSentence + oldSecond + '\n';
  const newText = firstSentence + newSecond + '\n';

  const patches = computeTextPatches(oldText, newText);

  assert.equal(patches.length, 1);
  assert.equal(applyPatches(oldText, patches), newText);
  // The patch covers only the rewritten second sentence; the unchanged first
  // sentence must stay outside both expected and insert.
  assert.ok(!patches[0].expected.includes('unchanged opening sentence'));
  assert.ok(!patches[0].insert.includes('unchanged opening sentence'));
  assert.ok(patches[0].from >= firstSentence.length);
});

test('computeTextPatches emits one patch per changed paragraph across a blank-line boundary', () => {
  const firstPara = [
    'The first paragraph describes the model setup in detail.\n',
    'It spans two lines so the changed group is multi-line.\n'
  ].join('');
  const secondPara = [
    'The second paragraph describes the experiments in detail.\n',
    'It also spans two lines so each paragraph is its own group unit.\n'
  ].join('');
  const newFirstPara = [
    'The first paragraph now describes the revised model setup clearly.\n',
    'It still spans two lines so the changed group remains multi-line.\n'
  ].join('');
  const oldText = firstPara + '\n' + secondPara;
  const newText = newFirstPara + '\n' + secondPara;

  const patches = computeTextPatches(oldText, newText);

  assert.equal(patches.length, 1, 'only the changed paragraph should produce a patch');
  assert.equal(applyPatches(oldText, patches), newText);
  assert.ok(!patches[0].expected.includes('second paragraph'));
  assert.ok(!patches[0].insert.includes('second paragraph'));
});

test('computeTextPatches falls back to one group patch for an ambiguous multi-paragraph rewrite', () => {
  // No line is shared between old and new (every line, including blank-line
  // structure, differs), so line anchoring keeps the whole rewrite as one
  // contiguous changed group. Inside that group the old side is a single
  // paragraph while the new side has two, so paragraph pairing is ambiguous
  // and the builder must fall back to one group patch.
  const oldText = [
    'Original opening prose covering the model assumptions here.\n',
    'Original middle prose covering the convergence guarantee here.\n',
    'Original closing prose covering the experimental outcomes here.\n'
  ].join('');
  const newText = [
    'Revised opening prose now covering the relaxed assumptions.\n',
    '\n',
    'Revised closing prose now covering the experimental outcomes.\n'
  ].join('');

  const patches = computeTextPatches(oldText, newText);

  assert.equal(patches.length, 1);
  assert.equal(applyPatches(oldText, patches), newText);
});

test('computeTextPatches keeps a LaTeX command/reference phrase edit small', () => {
  const oldText = 'As shown in \\cref{thm:main}, the bound is tight.\n';
  const newText = 'As shown in \\cref{thm:primary}, the bound is tight.\n';

  const patches = computeTextPatches(oldText, newText);

  assert.equal(applyPatches(oldText, patches), newText);
  assert.equal(patches.length, 1);
  assert.ok(Math.max(patches[0].to - patches[0].from, patches[0].insert.length) < 40);
});

test('computeLineAnchoredChangeGroups returns no groups for identical content', () => {
  assert.deepEqual(computeLineAnchoredChangeGroups('same\n', 'same\n'), []);
});

test('computeLineAnchoredChangeGroups returns one group for a single one-line change', () => {
  const groups = computeLineAnchoredChangeGroups('old title\nbody\n', 'new title\nbody\n');

  assert.deepEqual(groups, [
    {
      oldStart: 0,
      oldText: 'old title\n',
      newText: 'new title\n'
    }
  ]);
});

test('computeLineAnchoredChangeGroups returns separate groups for far-apart edits', () => {
  const oldLines = Array.from({ length: 20 }, (_, index) => `line ${index}\n`);
  const newLines = oldLines.slice();
  newLines[0] = 'line 0 changed\n';
  newLines[19] = 'line 19 changed\n';
  const oldText = oldLines.join('');
  const newText = newLines.join('');

  const groups = computeLineAnchoredChangeGroups(oldText, newText);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], {
    oldStart: 0,
    oldText: 'line 0\n',
    newText: 'line 0 changed\n'
  });
  const lastOldStart = oldText.length - 'line 19\n'.length;
  assert.deepEqual(groups[1], {
    oldStart: lastOldStart,
    oldText: 'line 19\n',
    newText: 'line 19 changed\n'
  });
});

test('computeLineAnchoredChangeGroups preserves local windows when exact LCS limits are exceeded', () => {
  const oldLines = Array.from(
    { length: 2100 },
    (_, index) => 'line ' + index + ': stable unique content.\n'
  );
  const newLines = [...oldLines];
  newLines[10] = newLines[10].replace('stable', 'updated');
  newLines[2000] = newLines[2000].replace('stable', 'updated');

  const groups = computeLineAnchoredChangeGroups(
    oldLines.join(''),
    newLines.join('')
  );

  assert.equal(groups.length, 2);
  assert.ok(groups.every(group => group.oldText.length < 100));
});

test('countNonEmptyLines counts only lines with non-empty trimmed content', () => {
  assert.equal(countNonEmptyLines(''), 0);
  assert.equal(countNonEmptyLines('\n\n'), 0);
  assert.equal(countNonEmptyLines('   \n\t\n'), 0);
  assert.equal(countNonEmptyLines('one line'), 1);
  assert.equal(countNonEmptyLines('first\nsecond\nthird\n'), 3);
  assert.equal(countNonEmptyLines('first\n\n   \nsecond\n'), 2);
});

test('countSentenceTerminators counts ASCII and CJK sentence terminators', () => {
  assert.equal(countSentenceTerminators(''), 0);
  assert.equal(countSentenceTerminators('No terminators here'), 0);
  assert.equal(countSentenceTerminators('One sentence.'), 1);
  assert.equal(countSentenceTerminators('First. Second! Third?'), 3);
  assert.equal(countSentenceTerminators('CJK terminators。And？And！'), 3);
});

test('countSentenceTerminators does not count a dot inside a decimal number', () => {
  assert.equal(countSentenceTerminators('The value is 1.23 here'), 0);
  assert.equal(countSentenceTerminators('Pi is 3.14159 roughly.'), 1);
});

test('hasOriginalMarkerLine detects an [original] marker line', () => {
  assert.equal(hasOriginalMarkerLine('% [original]'), true);
  assert.equal(hasOriginalMarkerLine('  %  [original]  '), true);
  assert.equal(hasOriginalMarkerLine('intro\n% [original]\nbody'), true);
  assert.equal(hasOriginalMarkerLine('% [revised]'), false);
  assert.equal(hasOriginalMarkerLine('text with [original] inline'), false);
  assert.equal(hasOriginalMarkerLine('% [original] trailing words'), false);
});

test('hasLaterRevisedMarkerLine requires a revised marker after the original marker', () => {
  assert.equal(
    hasLaterRevisedMarkerLine('% [original]\nold\n\n% [revised]\nnew'),
    true
  );
  assert.equal(
    hasLaterRevisedMarkerLine('% [revised]\nnew\n\n% [original]\nold'),
    false
  );
  assert.equal(hasLaterRevisedMarkerLine('% [revised]\nnew'), false);
  assert.equal(hasLaterRevisedMarkerLine('% [original]\nold'), false);
});

test('hasAnyAnnotatedMarker detects either marker line', () => {
  assert.equal(hasAnyAnnotatedMarker('% [original]\nold'), true);
  assert.equal(hasAnyAnnotatedMarker('intro\n% [revised]\nnew'), true);
  assert.equal(hasAnyAnnotatedMarker('plain paragraph text'), false);
});

test('splitParagraphs returns ordered segments that reconstruct the input exactly', () => {
  const text = 'first paragraph\n\nsecond paragraph\n\n\nthird paragraph';
  const segments = splitParagraphs(text);

  assert.ok(segments.length >= 1);
  assert.equal(segments.map(segment => segment.text).join(''), text);
  for (const segment of segments) {
    assert.equal(text.slice(segment.start, segment.start + segment.text.length), segment.text);
  }
});

test('splitParagraphs keeps a single segment when there is no blank line', () => {
  const text = 'one paragraph\nwith two lines';
  const segments = splitParagraphs(text);

  assert.equal(segments.map(segment => segment.text).join(''), text);
  assert.equal(segments[0].start, 0);
});

test('splitParagraphs reconstructs input with leading and trailing blank lines', () => {
  const text = '\n\nmiddle paragraph\n\n';
  const segments = splitParagraphs(text);

  assert.equal(segments.map(segment => segment.text).join(''), text);
  for (const segment of segments) {
    assert.equal(text.slice(segment.start, segment.start + segment.text.length), segment.text);
  }
});

function assertSpansPartition(text, spans) {
  assert.ok(Array.isArray(spans));
  assert.ok(spans.length >= 1);
  assert.equal(spans.map(span => span.text).join(''), text);
  let cursor = 0;
  for (const span of spans) {
    assert.equal(span.start, cursor);
    assert.equal(span.end, span.start + span.text.length);
    assert.equal(span.text, text.slice(span.start, span.end));
    cursor = span.end;
  }
  assert.equal(cursor, text.length);
}

test('splitSentences splits two plain sentences ending in a period and a bang', () => {
  const text = 'First sentence. Second sentence!';
  const spans = splitSentences(text);

  assertSpansPartition(text, spans);
  assert.equal(spans.length, 2);
  assert.equal(spans[0].text, 'First sentence. ');
  assert.equal(spans[1].text, 'Second sentence!');
  assert.equal(spans[0].start, 0);
  assert.equal(spans[0].end, 16);
  assert.equal(spans[1].start, 16);
  assert.equal(spans[1].end, 32);
});

test('splitSentences splits CJK sentences ending in fullwidth terminators', () => {
  const text = '第一句话。第二个句子？';
  const spans = splitSentences(text);

  assertSpansPartition(text, spans);
  assert.equal(spans.length, 2);
  assert.equal(spans[0].text, '第一句话。');
  assert.equal(spans[1].text, '第二个句子？');
});

test('splitSentences does not split inside a decimal number', () => {
  const text = 'The value is 1.23 here.';
  const spans = splitSentences(text);

  assertSpansPartition(text, spans);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].text, text);
});

test('splitSentences does not split inside a URL', () => {
  const text = 'See https://a.b/c for details.';
  const spans = splitSentences(text);

  assertSpansPartition(text, spans);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].text, text);
});

test('splitSentences treats a terminator before a LaTeX command as a boundary', () => {
  const text = 'done.\\section{Next}';
  const spans = splitSentences(text);

  assertSpansPartition(text, spans);
  assert.equal(spans.length, 2);
  assert.equal(spans[0].text, 'done.');
  assert.equal(spans[1].text, '\\section{Next}');
});

test('splitSentences returns one span when there is no confident boundary', () => {
  const text = 'a rewrite fragment with no terminator at all';
  const spans = splitSentences(text);

  assertSpansPartition(text, spans);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].text, text);
});

test('computeGroupMetrics reports counts and char spans for a group with token patches', () => {
  const group = {
    oldStart: 5,
    oldText: 'First sentence. Second sentence.',
    newText: 'First sentence rewritten. Second sentence here. Third one.'
  };
  const tokenPatches = [
    { from: 5, to: 10, expected: 'First', insert: 'Initial' },
    { from: 20, to: 20, expected: '', insert: ' added words' }
  ];

  const metrics = computeGroupMetrics(group, tokenPatches);

  assert.deepEqual(metrics, {
    oldNonEmptyLineCount: 1,
    newNonEmptyLineCount: 1,
    maxNonEmptyLineCount: 1,
    changedSpanChars: Math.max(group.oldText.length, group.newText.length),
    tokenPatchCount: 2,
    totalTokenChangedChars: Math.max(5, 'Initial'.length) + Math.max(0, ' added words'.length),
    oldSentenceTerminatorCount: 2,
    newSentenceTerminatorCount: 3
  });
});

test('computeGroupMetrics reports null token fields when tokenPatches is null', () => {
  const group = {
    oldStart: 0,
    oldText: 'line one\nline two\nline three',
    newText: 'line one changed\nline two\nline three\nline four'
  };

  const metrics = computeGroupMetrics(group, null);

  assert.equal(metrics.tokenPatchCount, null);
  assert.equal(metrics.totalTokenChangedChars, null);
  assert.equal(metrics.oldNonEmptyLineCount, 3);
  assert.equal(metrics.newNonEmptyLineCount, 4);
  assert.equal(metrics.maxNonEmptyLineCount, 4);
  assert.equal(metrics.changedSpanChars, Math.max(group.oldText.length, group.newText.length));
});

test('classifyChangedGroup classifies an annotated rewrite block as annotated_block', () => {
  const newText = [
    '% [original]\n',
    '% old paragraph sentence one. old paragraph sentence two.\n',
    '\n',
    '% [revised]\n',
    'new paragraph sentence one. new paragraph sentence two.\n'
  ].join('');
  const group = {
    oldStart: 0,
    oldText: 'old paragraph sentence one. old paragraph sentence two.\n',
    newText
  };

  assert.deepEqual(classifyGroup(group), { type: 'annotated_block' });
});

test('classifyChangedGroup keeps annotated_block precedence over paragraph thresholds', () => {
  // This group also satisfies paragraph thresholds (>= 3 non-empty lines and
  // >= 2 sentence terminators on each side), but the markers must win.
  const oldText = [
    'old line one with first sentence. and a second sentence here.\n',
    'old line two continues the prose.\n',
    'old line three closes the prose.\n'
  ].join('');
  const newText = [
    '% [original]\n',
    '% old line one with first sentence. and a second sentence here.\n',
    '% old line two continues the prose.\n',
    '% old line three closes the prose.\n',
    '\n',
    '% [revised]\n',
    'new line one with first sentence. and a second sentence here.\n',
    'new line two continues the prose.\n',
    'new line three closes the prose.\n'
  ].join('');
  const group = { oldStart: 0, oldText, newText };
  const metrics = computeGroupMetrics(
    group,
    computeTokenAnchoredPatches(group.oldText, group.newText, group.oldStart)
  );

  // Sanity check: the paragraph predicate would otherwise fire.
  assert.ok(metrics.maxNonEmptyLineCount >= 3);
  assert.deepEqual(classifyGroup(group), { type: 'annotated_block' });
});

test('classifyChangedGroup keeps sparse repeated edits across multiple lines as small_edit', () => {
  const oldText = [
    'old first line of the paragraph body.\n',
    'old second line of the paragraph body.\n',
    'old third line of the paragraph body.\n'
  ].join('');
  const newText = [
    'new first line of the paragraph body.\n',
    'new second line of the paragraph body.\n',
    'new third line of the paragraph body.\n'
  ].join('');
  const group = { oldStart: 0, oldText, newText };

  assert.deepEqual(classifyGroup(group), { type: 'small_edit' });
});

test('classifyChangedGroup classifies a dense single-line token rewrite as paragraph_rewrite', () => {
  // One non-empty line with no sentence terminators, but many scattered token
  // patches over a wide (>= 160 char) span: isDenseTokenRewrite alone must
  // push this to paragraph_rewrite.
  const oldText =
    'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega aa bb cc dd ee ff gg hh ii jj kk ll mm here';
  const newText =
    'alpha BETA gamma DELTA epsilon ZETA eta THETA iota KAPPA lambda MU nu XI omicron PI rho SIGMA tau UPSILON phi CHI psi OMEGA aa BB cc DD ee FF gg HH ii JJ kk LL mm here';
  const group = { oldStart: 0, oldText, newText };
  const tokenPatches = computeTokenAnchoredPatches(group.oldText, group.newText, group.oldStart);
  const metrics = computeGroupMetrics(group, tokenPatches);

  // Sanity check: confirm the dense-token preconditions hold and that the
  // line-count / sentence-terminator paragraph branches do NOT.
  assert.ok(tokenPatches !== null);
  assert.ok(metrics.tokenPatchCount >= 6);
  assert.ok(metrics.changedSpanChars >= 160);
  assert.ok(metrics.maxNonEmptyLineCount <= 2);
  assert.ok(metrics.tokenPatchCount / Math.max(1, metrics.maxNonEmptyLineCount) >= 2);
  assert.ok(metrics.newSentenceTerminatorCount < 2);
  assert.deepEqual(classifyChangedGroup(group, tokenPatches, metrics), {
    type: 'paragraph_rewrite'
  });
});

test('classifyChangedGroup classifies a medium single-sentence rewrite as sentence_rewrite', () => {
  // One sentence on one line, >= 3 token patches all inside it, span >= 80 chars,
  // and only one sentence terminator so the paragraph branch does not fire.
  const oldText =
    'The proposed algorithm achieves sublinear regret and bounded constraint violation under mild assumptions.';
  const newText =
    'The proposed method achieves logarithmic regret and tight constraint violation under standard assumptions.';
  const group = { oldStart: 0, oldText, newText };
  const tokenPatches = computeTokenAnchoredPatches(group.oldText, group.newText, group.oldStart);
  const metrics = computeGroupMetrics(group, tokenPatches);

  // Sanity check: confirm sentence-rewrite preconditions.
  assert.ok(tokenPatches !== null);
  assert.ok(metrics.tokenPatchCount >= 3);
  assert.ok(metrics.maxNonEmptyLineCount <= 2);
  assert.deepEqual(classifyChangedGroup(group, tokenPatches, metrics), {
    type: 'sentence_rewrite'
  });
});

test('classifyChangedGroup classifies a one-or-two token-patch change as small_edit', () => {
  const oldText = 'The system runs fast in practice.\n';
  const newText = 'The system runs faster in practice.\n';
  const group = { oldStart: 0, oldText, newText };
  const tokenPatches = computeTokenAnchoredPatches(group.oldText, group.newText, group.oldStart);
  const metrics = computeGroupMetrics(group, tokenPatches);

  // Sanity check: this is a single token patch.
  assert.ok(tokenPatches !== null);
  assert.ok(metrics.tokenPatchCount <= 2);
  assert.deepEqual(classifyChangedGroup(group, tokenPatches, metrics), {
    type: 'small_edit'
  });
});

test('classifyChangedGroup classifies a short multi-token change under thresholds as small_edit', () => {
  // More than two token patches, but they are spread across two sentences of
  // the old text (so they do not fall inside one confident sentence span) and
  // the total changed chars stay well under 80 on a single line. This must
  // reach small_edit via the totalTokenChangedChars branch, not sentence_rewrite.
  const oldText = 'Use Eq (3) here. Then Fig (4) applies.\n';
  const newText = 'Use Eq (7) here, then Fig (8) applies\n';
  const group = { oldStart: 0, oldText, newText };
  const tokenPatches = computeTokenAnchoredPatches(group.oldText, group.newText, group.oldStart);
  const metrics = computeGroupMetrics(group, tokenPatches);

  // Sanity check: more than 2 token patches, small total changed chars, one
  // line, and the new side has < 2 terminators so paragraph_rewrite stays off.
  assert.ok(tokenPatches !== null);
  assert.ok(metrics.tokenPatchCount >= 3);
  assert.ok(metrics.totalTokenChangedChars < 80);
  assert.ok(metrics.maxNonEmptyLineCount <= 2);
  assert.ok(metrics.newSentenceTerminatorCount < 2);
  assert.deepEqual(classifyChangedGroup(group, tokenPatches, metrics), {
    type: 'small_edit'
  });
});

test('classifyChangedGroup classifies a null-tokenPatches multi-line group as paragraph_rewrite', () => {
  const group = {
    oldStart: 0,
    oldText: 'old line one\nold line two\nold line three',
    newText: 'new line one\nnew line two\nnew line three'
  };
  const metrics = computeGroupMetrics(group, null);

  // Sanity check: token-independent paragraph branch via line count.
  assert.equal(metrics.maxNonEmptyLineCount, 3);
  assert.deepEqual(classifyChangedGroup(group, null, metrics), {
    type: 'paragraph_rewrite'
  });
});

test('classifyChangedGroup falls back when tokenPatches is null and the group is tiny', () => {
  const group = {
    oldStart: 0,
    oldText: 'short old',
    newText: 'short new'
  };
  const metrics = computeGroupMetrics(group, null);

  // Sanity check: no markers, < 3 lines, < 2 terminators per side.
  assert.ok(metrics.maxNonEmptyLineCount < 3);
  assert.deepEqual(classifyChangedGroup(group, null, metrics), { type: 'fallback' });
});

// Asserts the core builder contract for a `group` and the patches a builder
// returned for it: every patch carries absolute file offsets, `expected`
// equals the original-text slice `[from,to)` of the full text, and applying
// the patches reproduces `group.newText`. The full original text is
// reconstructed as a prefix/suffix sandwich around `group.oldText` so the
// absolute offsets are exercised exactly as they would be in production.
function assertGroupPatchInvariant(group, patches) {
  assert.ok(Array.isArray(patches));
  const prefix = 'X'.repeat(group.oldStart);
  const suffix = '\nZ trailing unchanged text\n';
  const fullOld = prefix + group.oldText + suffix;
  for (const patch of patches) {
    assert.ok(patch.from >= group.oldStart, `from ${patch.from} below group start`);
    assert.ok(
      patch.to <= group.oldStart + group.oldText.length,
      `to ${patch.to} beyond group end`
    );
    assert.equal(
      fullOld.slice(patch.from, patch.to),
      patch.expected,
      'expected must equal the original full-text slice'
    );
  }
  const fullNew = applyPatches(fullOld, patches);
  assert.equal(
    fullNew,
    prefix + group.newText + suffix,
    'applying the patches must reproduce group.newText in place'
  );
}

test('singleGroupPatch returns one patch satisfying the apply invariant', () => {
  const group = {
    oldStart: 17,
    oldText: 'the quick brown fox jumps',
    newText: 'the quick red fox leaps'
  };

  const patches = singleGroupPatch(group);

  assert.equal(patches.length, 1);
  assert.deepEqual(
    patches[0],
    computeSingleTextPatch(group.oldText, group.newText, group.oldStart)
  );
  assertGroupPatchInvariant(group, patches);
});

test('computeParagraphPatches returns one patch for a single-paragraph group', () => {
  const group = {
    oldStart: 9,
    oldText: 'A single paragraph with one sentence here.',
    newText: 'A single paragraph with a rewritten sentence here.'
  };

  const patches = computeParagraphPatches(group);

  assert.ok(patches !== null);
  assert.equal(patches.length, 1);
  assertGroupPatchInvariant(group, patches);
});

test('computeParagraphPatches emits one patch per changed paragraph with an unchanged separator', () => {
  const oldFirst = 'First paragraph original line.';
  const secondPara = 'Second paragraph stays exactly the same.';
  const separator = '\n\n';
  const newFirst = 'First paragraph rewritten line entirely.';
  const group = {
    oldStart: 40,
    oldText: oldFirst + separator + secondPara,
    newText: newFirst + separator + secondPara
  };

  const patches = computeParagraphPatches(group);

  assert.ok(patches !== null);
  assert.equal(patches.length, 1, 'only the changed paragraph should produce a patch');
  // The patch must stay entirely inside the first paragraph: at or after its
  // absolute start, and not past its end into the separator or second
  // paragraph. The unchanged second paragraph must not appear in the patch.
  assert.ok(patches[0].from >= group.oldStart);
  assert.ok(patches[0].to <= group.oldStart + oldFirst.length);
  assert.ok(!patches[0].expected.includes(secondPara));
  assert.ok(!patches[0].insert.includes(secondPara));
  assertGroupPatchInvariant(group, patches);
});

test('computeParagraphPatches returns null when separator structure is mismatched', () => {
  // Old text has one blank-line separator; new text has two. Pairing is
  // ambiguous, so the builder must defer to the caller.
  const group = {
    oldStart: 0,
    oldText: 'Para one.\n\nPara two.',
    newText: 'Para one.\n\nPara two.\n\nPara three.'
  };

  assert.equal(computeParagraphPatches(group), null);
});

test('computeSentencePatches builds one patch spanning only the rewritten sentence', () => {
  // Two sentences; only the second (>= 80 chars) is rewritten, with several
  // token-level changes inside it. The first sentence must stay untouched.
  const firstSentence =
    'The unchanged opening sentence introduces the topic and stays exactly as written here. ';
  const oldSecond =
    'The proposed algorithm achieves sublinear regret and bounded constraint violation under mild assumptions.';
  const newSecond =
    'The proposed method achieves logarithmic regret and tight constraint violation under standard assumptions.';
  const group = {
    oldStart: 23,
    oldText: firstSentence + oldSecond,
    newText: firstSentence + newSecond
  };
  const tokenPatches = computeTokenAnchoredPatches(
    group.oldText,
    group.newText,
    group.oldStart
  );
  assert.ok(tokenPatches !== null && tokenPatches.length >= 3);

  const patches = computeSentencePatches(group, tokenPatches);

  assert.ok(patches !== null);
  assert.equal(patches.length, 1);
  // The neighbouring (first) sentence must not leak into expected/insert.
  assert.ok(!patches[0].expected.includes('unchanged opening sentence'));
  assert.ok(!patches[0].insert.includes('unchanged opening sentence'));
  // The patch must lie entirely within the second sentence: it starts at or
  // after the second sentence's absolute boundary and never reaches back into
  // the unchanged first sentence.
  assert.ok(patches[0].from >= group.oldStart + firstSentence.length);
  assertGroupPatchInvariant(group, patches);
});

test('computeSentencePatches returns null when token patches straddle two sentences', () => {
  // One token change in each of two sentences: no single span contains all of
  // them, so the builder cannot confidently pick one sentence.
  const group = {
    oldStart: 0,
    oldText: 'First sentence has alpha word. Second sentence has beta word.',
    newText: 'First sentence has gamma word. Second sentence has delta word.'
  };
  const tokenPatches = computeTokenAnchoredPatches(
    group.oldText,
    group.newText,
    group.oldStart
  );

  assert.equal(computeSentencePatches(group, tokenPatches), null);
});

test('coalesceTokenPatches merges close token patches in one sentence with filler gaps', () => {
  // Three token changes inside one sentence, separated by short
  // function-word / whitespace gaps (each <= 40 chars). They must merge.
  const oldText =
    'We change alpha and the beta and a gamma inside this one long sentence here.';
  const newText =
    'We change ALPHA and the BETA and a GAMMA inside this one long sentence here.';
  const group = { oldStart: 31, oldText, newText };
  const tokenPatches = computeTokenAnchoredPatches(
    group.oldText,
    group.newText,
    group.oldStart
  );
  assert.ok(tokenPatches !== null && tokenPatches.length >= 3);

  const coalesced = coalesceTokenPatches(group, tokenPatches);

  assert.ok(
    coalesced.length < tokenPatches.length,
    `expected fewer than ${tokenPatches.length} patches, got ${coalesced.length}`
  );
  assertGroupPatchInvariant(group, coalesced);
});

test('coalesceTokenPatches leaves far-apart token patches unchanged', () => {
  // Two token changes separated by a long unchanged run (> 40 chars). They
  // must not merge; the token patches are returned as-is.
  const oldText =
    'Replace alpha here, then a very long stretch of completely unchanged words follows before we replace omega there.';
  const newText =
    'Replace ALPHA here, then a very long stretch of completely unchanged words follows before we replace OMEGA there.';
  const group = { oldStart: 4, oldText, newText };
  const tokenPatches = computeTokenAnchoredPatches(
    group.oldText,
    group.newText,
    group.oldStart
  );
  assert.ok(tokenPatches !== null);

  const coalesced = coalesceTokenPatches(group, tokenPatches);

  assert.deepEqual(coalesced, tokenPatches);
  assertGroupPatchInvariant(group, coalesced);
});

test('keeps sparse edits local in very large files', () => {
  for (const lineCount of [2100, 6000]) {
    const oldLines = Array.from(
      { length: lineCount },
      (_, index) => `Line ${index + 1}: stable project prose with a unique anchor.\n`
    );
    const newLines = [...oldLines];
    newLines[9] = newLines[9].replace('stable', 'carefully revised');
    newLines[lineCount - 101] = newLines[lineCount - 101].replace(
      'project prose',
      'project argument'
    );

    const oldText = oldLines.join('');
    const newText = newLines.join('');
    const patches = computeTextPatches(oldText, newText);

    assert.equal(applyNaturalPatchRegressionResult(oldText, patches), newText);
    assert.ok(patches.length >= 2);
    assert.ok(patches.every(patch => patch.expected.length < 500));
    assert.ok(
      patches.every(patch => !patch.expected.includes(`Line ${Math.floor(lineCount / 2)}:`))
    );
  }
});

test('keeps consecutive local LaTeX command edits as local patches', () => {
  const oldText = [
    '\\section{Related Work}\n',
    'First result follows \\cite{alpha} under the standard assumptions.\n',
    'Second result follows \\cite{beta} under the same assumptions.\n',
    'Third result follows \\cite{gamma} under a weaker assumption.\n',
    '\\section{Discussion}\n'
  ].join('');
  const newText = oldText.replaceAll('\\cite{', '\\parencite{');

  const patches = computeTextPatches(oldText, newText);
  assert.equal(applyNaturalPatchRegressionResult(oldText, patches), newText);
  assert.ok(patches.length >= 3);
  assert.ok(patches.every(patch => patch.expected.length < 80));
});

test('keeps a long run of repeated local edits bounded', () => {
  const oldLines = Array.from(
    { length: 240 },
    (_, index) => `Claim ${index + 1}: evidence uses \\cite{source-${index + 1}}.\n`
  );
  const newLines = [...oldLines];
  for (let index = 60; index < 180; index += 1) {
    newLines[index] = newLines[index].replace('\\cite{', '\\textcite{');
  }

  const oldText = oldLines.join('');
  const newText = newLines.join('');
  const patches = computeTextPatches(oldText, newText);

  assert.equal(applyNaturalPatchRegressionResult(oldText, patches), newText);
  assert.ok(patches.length >= 100);
  assert.ok(patches.every(patch => patch.expected.length < 100));
});

test('treats a long unchanged token gap as a hard patch boundary', () => {
  const middle = Array.from(
    { length: 120 },
    (_, index) => ` stable-token-${index}`
  ).join('');
  const oldText = `prefix old-word${middle} suffix old-tail`;
  const newText = `prefix new-word${middle} suffix new-tail`;
  const patches = computeTextPatches(oldText, newText);

  assert.equal(applyNaturalPatchRegressionResult(oldText, patches), newText);
  assert.ok(patches.length >= 2);
  assert.ok(patches.every(patch => !patch.expected.includes('stable-token-60')));
});

test('keeps 200 sparse edits in a 10000-line file within the performance budget', () => {
  const oldLines = Array.from(
    { length: 10_000 },
    (_, index) => `Row ${index + 1}: stable unique text for natural diff anchoring.\n`
  );
  const newLines = [...oldLines];
  for (let index = 0; index < 200; index += 1) {
    const lineIndex = 20 + index * 47;
    newLines[lineIndex] = newLines[lineIndex].replace('stable', 'updated');
  }

  const oldText = oldLines.join('');
  const newText = newLines.join('');
  const startedAt = Date.now();
  const patches = computeTextPatches(oldText, newText);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(applyNaturalPatchRegressionResult(oldText, patches), newText);
  assert.ok(patches.length >= 180);
  assert.ok(elapsedMs < 2000, `natural diff took ${elapsedMs}ms`);
});

test('preserves patch invariants across deterministic mixed edits', () => {
  let seed = 0x2f3a3;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  for (let caseIndex = 0; caseIndex < 24; caseIndex += 1) {
    const oldLines = Array.from(
      { length: 180 },
      (_, index) => `Case ${caseIndex} line ${index}: stable text ${index % 11}.\n`
    );
    const newLines = [...oldLines];
    for (let editIndex = 0; editIndex < 18; editIndex += 1) {
      const lineIndex = Math.floor(random() * newLines.length);
      newLines[lineIndex] = newLines[lineIndex].replace(
        'stable',
        `revised-${caseIndex}-${editIndex}`
      );
    }
    if (caseIndex % 3 === 0) {
      newLines.splice(30, 0, `Case ${caseIndex} inserted line.\n`);
    }
    if (caseIndex % 4 === 0) {
      newLines.splice(120, 1);
    }

    const oldText = oldLines.join('');
    const newText = newLines.join('');
    const patches = computeTextPatches(oldText, newText);
    assert.equal(applyNaturalPatchRegressionResult(oldText, patches), newText);
  }
});

function applyNaturalPatchRegressionResult(text, patches) {
  const ordered = [...patches].sort(
    (left, right) => right.from - left.from || right.to - left.to
  );
  let result = text;
  for (const patch of ordered) {
    assert.equal(result.slice(patch.from, patch.to), patch.expected);
    result = result.slice(0, patch.from) + patch.insert + result.slice(patch.to);
  }
  return result;
}
