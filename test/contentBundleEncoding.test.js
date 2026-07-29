const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const bundlePath = path.join(
  repoRoot,
  'extension',
  'src',
  'content',
  'generated',
  'content.bundle.js'
);

test('content bundle has no raw Unicode noncharacters rejected by Chrome', () => {
  const build = spawnSync(process.execPath, ['scripts/build-content-bundle.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });

  assert.equal(
    build.status,
    0,
    `content bundle build failed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`
  );

  const bundle = fs.readFileSync(bundlePath, 'utf8');
  const unsafe = [];
  for (let offset = 0; offset < bundle.length;) {
    const codePoint = bundle.codePointAt(offset);
    if (
      (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
      (codePoint & 0xffff) === 0xfffe ||
      (codePoint & 0xffff) === 0xffff
    ) {
      unsafe.push({ offset, codePoint });
    }
    offset += codePoint > 0xffff ? 2 : 1;
  }

  assert.deepEqual(
    unsafe,
    [],
    'Chrome can reject raw Unicode noncharacters as invalid UTF-8'
  );
});
