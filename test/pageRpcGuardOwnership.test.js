const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const PAGE_BRIDGE_SOURCE = fs.readFileSync(
  path.join(ROOT, 'extension', 'src', 'pageBridge.js'),
  'utf8',
);

test('page RPC project identity guards are owned by the shared contract dispatcher', () => {
  const handlersStart = PAGE_BRIDGE_SOURCE.indexOf('const pageRpcHandlers = {');
  const dispatchStart = PAGE_BRIDGE_SOURCE.indexOf('async function dispatch(method, params)');

  assert.ok(handlersStart >= 0, 'page bridge handler catalog should exist');
  assert.ok(dispatchStart > handlersStart, 'page bridge dispatcher should follow handlers');

  const handlersSource = PAGE_BRIDGE_SOURCE.slice(handlersStart, dispatchStart);
  const dispatcherSource = PAGE_BRIDGE_SOURCE.slice(dispatchStart);

  assert.doesNotMatch(
    handlersSource,
    /runWriteGuard|dispatchOptionalGuarded|dispatchGuarded/,
    'individual handlers must not duplicate project identity policy',
  );
  assert.match(dispatcherSource, /pageRpcContract\.getMethod\(method\)/);
  assert.match(dispatcherSource, /contract\.projectIdentity === 'required'/);
  assert.match(dispatcherSource, /contract\.projectIdentity === 'optional'/);
  assert.match(dispatcherSource, /writeGuard\.runWriteGuard\(params\)/);
});
