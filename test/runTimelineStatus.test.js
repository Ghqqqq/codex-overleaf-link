const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const timelineSource = fs.readFileSync(
  path.join(root, 'extension', 'src', 'content', 'runTimelineView.js'),
  'utf8'
);
const i18nSource = fs.readFileSync(
  path.join(root, 'extension', 'src', 'shared', 'i18n.js'),
  'utf8'
);

test('cancelled runs use a dedicated elapsed terminal label', () => {
  assert.match(
    timelineSource,
    /status === 'rejected' \|\| status === 'cancelled'[\s\S]*?processedCancelled/
  );
  assert.match(i18nSource, /processedCancelled:\s*'Cancelled \{elapsed\}'/);
  assert.match(i18nSource, /processedCancelled:\s*'已取消 \{elapsed\}'/);
});
