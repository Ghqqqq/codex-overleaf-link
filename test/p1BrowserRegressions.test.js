const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { extractFunction } = require('./_helpers/extractFunction');

const runtimeSource = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
const pageBridgeSource = fs.readFileSync(path.join(__dirname, '../extension/src/pageBridge.js'), 'utf8');

test('line-reference navigation re-resolves the active editor after Overleaf settles', () => {
  const jumpToPosition = extractFunction(pageBridgeSource, 'jumpToPosition');
  const firstFocus = jumpToPosition.indexOf('editorAdapter.focusActiveEditorRange');
  const settlementDelay = jumpToPosition.indexOf('await delay(120)', firstFocus + 1);
  const settledFocus = jumpToPosition.indexOf('editorAdapter.focusActiveEditorRange', firstFocus + 1);
  assert.notEqual(firstFocus, -1);
  assert.notEqual(settlementDelay, -1);
  assert.notEqual(settledFocus, -1);
  assert.equal(firstFocus < settlementDelay && settlementDelay < settledFocus, true);
});

test('Fast choice reaches state before capability rendering can project the old tier', () => {
  const persistPanelInputs = extractFunction(runtimeSource, 'persistPanelInputs');
  const capture = persistPanelInputs.indexOf("state.speedTier = event.target.value || 'standard'");
  const rerender = persistPanelInputs.indexOf('renderSpeedOptions(getRenderedModelEntries())');
  assert.notEqual(capture, -1);
  assert.notEqual(rerender, -1);
  assert.equal(capture < rerender, true);
});
