const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');

test('package scripts expose the local managed-update rehearsal', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  );

  assert.equal(
    pkg.scripts['verify:update-hop:local'],
    'node scripts/verify-update-hop.mjs --local-test-key',
  );
  assert.equal(
    pkg.scripts['rehearse:update-hop'],
    'npm run build:release && npm run verify:update-hop:local',
  );
});

test('pull-request CI rehearses the update hop once on Ubuntu', () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, '.github/workflows/test.yml'),
    'utf8',
  );

  assert.match(
    workflow,
    /- name: Rehearse previous-stable managed update hop\s+if: matrix\.os == 'ubuntu-latest'\s+run: npm run rehearse:update-hop/,
  );
  assert.equal(
    (workflow.match(/run: npm run rehearse:update-hop/g) || []).length,
    1,
  );
});
