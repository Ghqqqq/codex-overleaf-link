const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { extractFunction } = require('./_helpers/extractFunction');

const runtimeSource = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
const pageBridgeSource = fs.readFileSync(path.join(__dirname, '../extension/src/pageBridge.js'), 'utf8');
const modelPickerSource = fs.readFileSync(path.join(__dirname, '../extension/src/content/modelPicker.js'), 'utf8');
const panelRendererSource = fs.readFileSync(path.join(__dirname, '../extension/src/content/panelRenderer.js'), 'utf8');
const panelCssSource = fs.readFileSync(path.join(__dirname, '../extension/styles/panel.css'), 'utf8');

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

test('reasoning options prefer the persisted effort over a rebuilt select default', () => {
  const renderReasoningOptions = extractFunction(modelPickerSource, 'renderReasoningOptions');
  const persisted = renderReasoningOptions.indexOf("getState()?.reasoningEffort");
  const domDefault = renderReasoningOptions.indexOf('reasoningSelect.value');
  assert.notEqual(persisted, -1);
  assert.notEqual(domDefault, -1);
  assert.equal(persisted < domDefault, true);
});

test('edge launcher appears only for a closed panel and never mounts into Overleaf toolbar internals', () => {
  const setVisible = extractFunction(panelRendererSource, 'setVisible');
  const setLauncherVisible = extractFunction(panelRendererSource, 'setLauncherVisible');
  assert.match(setVisible, /launcherEl\.hidden\s*=\s*Boolean\(visible\)\s*\|\|\s*launcherEl\.dataset\.enabled\s*===\s*'false'/);
  assert.match(setLauncherVisible, /instance\.panelEl\?\.classList\?\.contains\('is-open'\)\s*===\s*true/);
  assert.match(panelRendererSource, /data-close-panel/);
  assert.doesNotMatch(panelRendererSource, /layout-dropdown-btn/);
});

test('provider headings retain the dialog theme foreground in light and dark modes', () => {
  assert.match(panelCssSource, /\.codex-provider-dialog-head h2,\s*\.codex-provider-detail h3\s*\{[^}]*color:\s*inherit;/);
  assert.match(panelCssSource, /#codex-overleaf-panel\[data-theme="light"\]\s*~\s*#codex-overleaf-launcher/);
});
