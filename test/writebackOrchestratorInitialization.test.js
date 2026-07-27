const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '../extension/src/content/writebackOrchestrator.js'),
  'utf8'
);

test('writeback orchestrator initializes injected settlement dependencies in strict mode', () => {
  const windowObject = {};
  new Function('window', source)(windowObject);

  const onMirrorRefreshSettled = () => {};
  const writebackSettlement = {};
  let orchestrator;

  assert.doesNotThrow(() => {
    orchestrator = windowObject.CodexOverleafWritebackOrchestrator.create({
      onMirrorRefreshSettled,
      writebackSettlement
    });
  });
  assert.equal(typeof orchestrator.applySyncChangesToOverleaf, 'function');
  assert.equal(typeof orchestrator.resolveCompileLogContext, 'function');
});
