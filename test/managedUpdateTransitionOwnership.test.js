const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

test('both managed update writers validate command transitions through the shared projection', () => {
  const bootstrap = fs.readFileSync(
    path.join(ROOT, 'extension', 'bootstrap', 'background.js'),
    'utf8',
  );
  const coordinator = fs.readFileSync(
    path.join(ROOT, 'extension', 'src', 'backgroundUpdateCoordinator.js'),
    'utf8',
  );

  assert.match(bootstrap, /CodexOverleafManagedUpdateProjection\.transitionCommand/);
  assert.match(coordinator, /projection\.transitionCommand/);
  assert.match(bootstrap, /options\.observed === true/);
  assert.match(coordinator, /options\.observed === true/);
  assert.match(coordinator, /next = transition\(previous, candidate/);
  assert.doesNotMatch(coordinator, /PHASE_TIMEOUT_MS/);
});
