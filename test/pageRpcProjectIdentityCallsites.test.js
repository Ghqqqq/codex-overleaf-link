const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function callWindows(source, method) {
  const needle = `callPageBridge('${method}'`;
  const windows = [];
  let from = 0;
  while (true) {
    const index = source.indexOf(needle, from);
    if (index < 0) return windows;
    windows.push(source.slice(index, index + 460));
    from = index + needle.length;
  }
}

test('every navigation and compile callsite sends an authoritative project id', () => {
  const cases = [
    ['extension/src/content/writebackOrchestrator.js', 'triggerCompile'],
    ['extension/src/content/writebackOrchestrator.js', 'getCompileLog'],
    ['extension/src/content/markdownText.js', 'jumpToPosition'],
    ['extension/src/content/panelMaintenance.js', 'jumpToPosition'],
    ['extension/src/content/diffReviewPanel.js', 'jumpToPosition']
  ];

  for (const [file, method] of cases) {
    const windows = callWindows(read(file), method);
    assert.ok(windows.length > 0, `${file} should call ${method}`);
    for (const source of windows) {
      assert.match(source, /runProjectId(?:\s*:|\s*[,}])/, `${file} ${method}`);
    }
  }
});
