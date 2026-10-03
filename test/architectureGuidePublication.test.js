const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

function declaredGuides() {
  return fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8')
    .split(/\r?\n/)
    .filter(line => /^!\/docs\/architecture\/[^/*]+\.md$/.test(line))
    .map(line => line.slice(2))
    .sort();
}

async function releaseVerifier() {
  return import(pathToFileURL(path.join(repoRoot, 'scripts/verify-release.mjs')).href);
}

test('source hygiene accepts the explicitly declared architecture guides', async () => {
  const guides = declaredGuides();
  assert.ok(guides.length > 0);
  const { collectSourceVerificationErrors } = await releaseVerifier();

  assert.deepEqual(collectSourceVerificationErrors({
    rootDir: repoRoot,
    trackedFiles: ['AGENTS.md', ...guides]
  }), []);
});

test('source hygiene keeps private documents and review records forbidden', async () => {
  const { collectForbiddenTrackedPathErrors } = await releaseVerifier();
  const forbidden = [
    'docs/notes.md',
    'docs/agents/project-feature-guide.md',
    'docs/architecture/private-notes.md',
    'docs/architecture/review.md',
    'docs/architecture/coverage-audit.md',
    'docs/architecture/red-team-review.md',
    'docs/architecture/navigation-acceptance.md',
    'docs/architecture/evidence-and-drift.md',
    'docs/architecture/README.md.bak',
    'docs/architecture/private/README.md',
    '.local-handoff/architecture-reviews/review.md',
    '.local/notes.md',
    'native-host/src/private-notes.md',
    'credentials.key'
  ];
  const errors = collectForbiddenTrackedPathErrors(repoRoot, forbidden);

  assert.equal(errors.length, forbidden.length);
  for (const file of forbidden) {
    assert.ok(errors.some(error => error.endsWith(file)), file);
  }
  assert.equal(collectForbiddenTrackedPathErrors(repoRoot, [
    '.local-handoff\\review.md', 'docs\\architecture\\private-notes.md'
  ]).length, 2);
});

test('guide allowlist stays aligned with Git declarations and path normalization', async () => {
  const guides = declaredGuides();
  const { PUBLIC_ARCHITECTURE_GUIDE_PATHS, collectForbiddenTrackedPathErrors } = await releaseVerifier();

  assert.deepEqual([...PUBLIC_ARCHITECTURE_GUIDE_PATHS].sort(), guides);
  for (const file of guides) {
    assert.ok(fs.statSync(path.join(repoRoot, file)).isFile(), file);
  }
  assert.deepEqual(collectForbiddenTrackedPathErrors(repoRoot,
    guides.flatMap(file => ['./' + file, file.replace(/\//g, '\\')])
  ), []);
});

test('public Git guides remain excluded from npm packages', async () => {
  const guides = declaredGuides();
  const { findForbiddenNpmPackagePaths, readExpectedManifest } = await import(
    pathToFileURL(path.join(repoRoot, 'scripts/verify-npm-package.mjs')).href
  );

  assert.deepEqual(findForbiddenNpmPackagePaths(guides),
    guides.map(file => 'package/' + file).sort());
  assert.equal(readExpectedManifest().some(file => file.startsWith('package/docs/')), false);
});
