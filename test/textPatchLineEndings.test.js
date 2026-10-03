const assert = require('node:assert/strict');
const test = require('node:test');
const { computeTextPatches } = require('../native-host/src/textPatch');
const StaleGuard = require('../extension/src/shared/staleGuard');
const WritebackController = require('../extension/src/content/writebackController');

const represent = (text, ending) => text.replace(/\r\n/g, '\n').replace(/\n/g, ending);

function prepare(base, target, current) {
  const project = { files: [{ path: 'main.tex', content: base }] };
  const patches = computeTextPatches(base, target);
  const [operation] = WritebackController.buildSyncApplyOperations([
    { type: 'write', path: 'main.tex', previousContent: base, content: target, patches }
  ], project);
  const originals = JSON.stringify(operation);
  const lookup = StaleGuard.buildBaseFileLookup(project.files);
  const freshness = StaleGuard.checkOperationFreshness(operation, current, lookup);
  const result = StaleGuard.prepareOperationPatches(operation, current, lookup);
  assert.equal(JSON.stringify(operation), originals, 'conversion must not mutate Native patches');
  if (result.ok && result.sourceContent !== undefined) {
    assert.equal(result.sourceContent, target, 'the next source baseline must preserve the exact Native target');
  }
  return { patches, operation, freshness, result };
}

function apply(current, result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  for (const patch of result.patches.slice().reverse()) {
    assert.equal(current.slice(patch.from, patch.to), patch.expected);
    current = current.slice(0, patch.from) + patch.insert + current.slice(patch.to);
  }
  return current;
}

for (const [baseName, baseEnding] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  for (const [editorName, editorEnding] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    for (const [kind, before, after] of [
      ['zero-width insertion', 'first\nalpha beta gamma', 'first\nalpha NEW beta gamma'],
      ['replacement', 'first\nalpha beta gamma', 'first\nalpha delta gamma'],
      ['multiple edits', 'heading\nalpha beta\nkeep this\nend omega', 'heading\nalpha delta\nkeep this\nend NEW omega'],
      ['newline insertion', 'heading\nalpha beta\nend', 'heading\nalpha\nNEW beta\nend'],
      ['newline deletion', 'heading\nalpha beta\nend', 'heading\nalpha beta end'],
      ['UTF-16 surrogate pairs', '😀 heading\nalpha 😀 beta\nend', '😀 heading\nalpha 😀 NEW beta\nend']
    ]) test(`patch line endings ${baseName}/${editorName}: ${kind}`, () => {
      const base = represent(before, baseEnding), current = represent(before, editorEnding);
      const { freshness, result } = prepare(base, represent(after, baseEnding), current);
      assert.equal(freshness.ok, true);
      assert.equal(apply(current, result), represent(after, editorEnding));
    });

    test(`patch line endings ${baseName}/${editorName}: preserve unrelated collaborator change`, () => {
      const before = 'heading\nalpha old\nfooter';
      const after = before.replace('old', 'new');
      const current = represent(before + ' from collaborator', editorEnding);
      const { freshness, result } = prepare(represent(before, baseEnding), represent(after, baseEnding), current);
      assert.deepEqual(freshness, { ok: true, reconciled: true, strategy: 'patch-range' });
      assert.equal(apply(current, result), represent(after + ' from collaborator', editorEnding));
    });

    test(`patch line endings ${baseName}/${editorName}: reject overlapping collaborator change`, () => {
      const before = 'heading\nalpha old\nfooter';
      const current = represent(before.replace('old', 'bad'), editorEnding);
      const { freshness } = prepare(represent(before, baseEnding), represent(before.replace('old', 'new'), baseEnding), current);
      assert.equal(freshness.ok, false);
      assert.equal(freshness.code, 'stale_patch_range');
    });
  }
}

test('patch line endings preserve intentional raw newline changes when editor matches baseline', () => {
  for (const [base, target] of [['a\nb', 'a\r\nb'], ['a\r\nb', 'a\nb']]) {
    const { result } = prepare(base, target, base);
    assert.equal(apply(base, result), target);
  }
});

test('patch line endings preserve intentional raw newline changes with unrelated edits', () => {
  for (const [base, target] of [['a\nb\nend', 'a\r\nb\nend'], ['a\r\nb\r\nend', 'a\nb\r\nend']]) {
    const current = base + ' from collaborator';
    const { result, freshness } = prepare(base, target, current);
    assert.equal(freshness.ok, true);
    assert.equal(apply(current, result), target + ' from collaborator');
  }
});

test('patch line endings preserve controller sorting of unordered Native patches', () => {
  const base = 'heading\r\nalpha old\r\nend old';
  const current = base.replace(/\r\n/g, '\n');
  const project = { files: [{ path: 'main.tex', content: base }] };
  const patches = [base.lastIndexOf('old'), base.indexOf('old')].map(from => ({ from, to: from + 3, expected: 'old', insert: 'new' }));
  const [operation] = WritebackController.buildSyncApplyOperations([{ type: 'write', path: 'main.tex', patches }], project);
  const result = StaleGuard.prepareOperationPatches(operation, current, StaleGuard.buildBaseFileLookup(project.files));
  assert.equal(apply(current, result), 'heading\nalpha new\nend new');
});

test('patch line endings keep rejecting an insertion that invalidates a replacement at the same offset', () => {
  const base = 'a\r\nbc', current = 'a\nbc';
  const patches = [
    { from: 3, to: 3, expected: '', insert: 'X' },
    { from: 3, to: 4, expected: 'b', insert: 'Y' }
  ];
  const project = { files: [{ path: 'main.tex', content: base }] };
  const [operation] = WritebackController.buildSyncApplyOperations([{ type: 'write', path: 'main.tex', patches }], project);
  const result = StaleGuard.prepareOperationPatches(operation, current, StaleGuard.buildBaseFileLookup(project.files));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'stale_patch');
});

test('patch line endings preserve the original stable application order for same-offset insertions', () => {
  const base = 'a\r\nbc', current = 'a\nbc';
  const operation = { type: 'edit', path: 'main.tex', patches: [
    { from: 3, to: 3, expected: '', insert: 'X' },
    { from: 3, to: 3, expected: '', insert: 'Y' }
  ] };
  const result = StaleGuard.prepareOperationPatches(operation, current,
    StaleGuard.buildBaseFileLookup([{ path: 'main.tex', content: base }]));
  assert.equal(apply(current, result), 'a\nYXbc');
});

test('patch line endings preserve the logical target for deterministic varied edit windows', () => {
  let seed = 123456789;
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  const alphabet = ['alpha ', 'beta', '\n', '\n\n', '😀', '尾部'];
  for (let index = 0; index < 150; index += 1) {
    const before = 'start\n' + Array.from({ length: 8 }, () => alphabet[random(alphabet.length)]).join('') + '\nend';
    const from = random(before.length + 1), to = from + random(before.length - from + 1);
    const after = before.slice(0, from) + alphabet[random(alphabet.length)] + before.slice(to);
    for (const [baseEnding, editorEnding] of [['\r\n', '\n'], ['\n', '\r\n']]) {
      const current = represent(before, editorEnding);
      const { result } = prepare(represent(before, baseEnding), represent(after, baseEnding), current);
      assert.equal(apply(current, result), represent(after, editorEnding), `case ${index}`);
    }
  }
});

test('patch line endings map a patch that splits the baseline CRLF pair', () => {
  const { result } = prepare('a\r\nb', 'a\rX\nb', 'a\nb');
  assert.equal(apply('a\nb', result), 'a\rX\nb');
});

test('patch line endings preserve adjacent untouched newlines in a mixed editor document', () => {
  const base = 'a\r\n\r\nb', target = 'a\r\nX\r\nb', current = 'a\n\r\nb';
  const { result } = prepare(base, target, current);
  assert.equal(apply(current, result), 'a\nX\r\nb');
  assert.deepEqual(result.patches, [{ from: 2, to: 2, expected: '', insert: 'X' }]);
});

test('patch line endings include CR insertion/deletion adjacent to LF in the mapping window', () => {
  for (const [base, target, current] of [
    ['a\nb', 'a\r\nb', 'a\r\nb'],
    ['a\r\nb', 'a\nb', 'a\nb']
  ]) {
    const { result } = prepare(base, target, current);
    assert.equal(apply(current, result), current);
  }
});

test('patch line endings retain the raw baseline after successful update and move', () => {
  const lookup = StaleGuard.buildBaseFileLookup([{ path: 'main.tex', content: 'a\r\nb' }]);
  assert.equal(lookup.get('main.tex'), 'a\r\nb');
  StaleGuard.updateExpectedFileContent(lookup, 'main.tex', 'a\r\nc');
  StaleGuard.moveExpectedFile(lookup, 'main.tex', 'new.tex');
  assert.equal(lookup.get('new.tex'), 'a\r\nc');
  assert.equal(lookup.has('main.tex'), false);
});
