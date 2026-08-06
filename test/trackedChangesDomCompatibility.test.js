const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const lifecycleSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/page/trackedChangesLifecycle.js'),
  'utf8'
);

test('tracked-change discovery includes current Overleaf editor and review-panel markers', () => {
  assert.match(lifecycleSource, /['"]\.ol-cm-change['"]/);
  assert.match(lifecycleSource, /['"]\.review-panel-entry-change['"]/);
});
