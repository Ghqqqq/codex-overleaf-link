const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { extractFunction } = require('./_helpers/extractFunction');


test('composer discovers model options through the native codex.models endpoint', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  const i18n = fs.readFileSync(
    path.join(__dirname, '../extension/src/shared/i18n.js'),
    'utf8'
  );
  // v2.1.2: Provider Coordinator loads the session-bound catalog before the
  // model picker requests codex.models.
  const modelPicker = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/modelPicker.js'),
    'utf8'
  );

  assert.match(modelPicker, /let modelDiscovery\s*=\s*\{\s*status:\s*'fallback'/);
  assert.match(contentScript, /providerSettingsCoordinator\.syncSessionProvider\(\)\.catch/);
  assert.match(modelPicker, /async function loadModelOptions\(providerSelection\)/);
  assert.match(modelPicker, /method:\s*'codex\.models'/);
  assert.match(modelPicker, /params:\s*selection\s*\?\s*\{\s*providerSelection:\s*selection\s*\}\s*:\s*\{\}/);
  assert.match(modelPicker, /const modelCatalog = getModelCatalog\(\)/);
  assert.match(modelPicker, /modelCatalog\.FALLBACK_MODELS/);
  assert.match(modelPicker, /normalizeDiscoveredModels\(\{\s*models:\s*sourceModels,\s*selectedModel:\s*retainedSelectedModel\s*\}\)/);
  assert.match(modelPicker, /function renderModelOptions\(models,\s*selectedModel,\s*options\s*=\s*\{\}\)/);
  assert.match(modelPicker, /function renderSpeedOptions\(/);
  assert.match(modelPicker, /function renderModelConfigChoices\(/);
  assert.match(modelPicker, /data-speed/);
  assert.match(modelPicker, /model\.speedTiers/);
  assert.match(modelPicker, /document\.createElement\('option'\)/);
  assert.match(modelPicker, /document\.createElement\('button'\)/);
  assert.match(modelPicker, /option\.textContent\s*=\s*model\.label/);
  assert.match(modelPicker, /const sourceTitle = tr\('modelDisplayTitle'/);
  assert.match(modelPicker, /modelDisplay\.title = sourceTitle/);
  assert.match(i18n, /modelSourceFallback:\s*'fallback'/);
  assert.match(i18n, /modelSourceDiscovered:\s*'discovered'/);
  assert.match(i18n, /modelDisplayTitle:\s*'\{label\} - Model list: \{source\}'/);
});

test('composer preserves user model changes made while native discovery is pending', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/modelPicker.js'),
    'utf8'
  );
  const loadModelOptions = extractFunction(contentScript, 'loadModelOptions');
  const awaitIndex = loadModelOptions.indexOf('await sendBackgroundNative');
  const currentSelectionIndex = loadModelOptions.indexOf('const currentSelectedModel = resolveSelectedModel() || selectedModel');

  assert.notEqual(awaitIndex, -1, 'loadModelOptions should await native discovery');
  assert.notEqual(currentSelectionIndex, -1, 'loadModelOptions should re-read selection after discovery returns');
  assert.equal(awaitIndex < currentSelectionIndex, true, 'selection must be re-read after await');
  assert.match(loadModelOptions, /const retainedSelectedModel = retainSelectedModel\(sourceModels, currentSelectedModel\)/);
  assert.match(loadModelOptions, /normalizeDiscoveredModels\(\{\s*models:\s*sourceModels,\s*selectedModel:\s*retainedSelectedModel\s*\}\)/);
  assert.match(loadModelOptions, /renderModelOptions\(normalized\.models,\s*retainedSelectedModel,\s*\{\s*allowUnknownSelected:\s*false\s*\}\)/);
});

test('composer preserves a custom selected model before async discovery finishes', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  const applyStateToPanel = extractFunction(contentScript, 'applyStateToPanel');
  const readPanelInputs = extractFunction(contentScript, 'readPanelInputs');
  const readSelectedModelInput = extractFunction(contentScript, 'readSelectedModelInput');
  const renderIndex = applyStateToPanel.indexOf('renderModelOptions(getModelCatalog().FALLBACK_MODELS, state.model)');
  const assignIndex = applyStateToPanel.indexOf("panel.querySelector('[data-model]').value = state.model");

  assert.notEqual(renderIndex, -1, 'applyStateToPanel should render fallback/custom model options synchronously');
  assert.notEqual(assignIndex, -1, 'applyStateToPanel should still select state.model');
  assert.equal(renderIndex < assignIndex, true, 'custom option must exist before assigning state.model');
  assert.match(readPanelInputs, /model:\s*readSelectedModelInput\(\)/);
  assert.match(readSelectedModelInput, /modelSelect\?\.value\s*\|\|\s*state\?\.model\s*\|\|\s*''/);
});

test('composer sends through a form submit path with a guarded run handler', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  const composerPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/composerPanel.js'),
    'utf8'
  );

  assert.match(composerPanel, /<form class="codex-composer" data-composer-form>/);
  assert.match(composerPanel, /<button type="submit" data-run title="Send" aria-label="Send">↑<\/button>/);
  assert.match(composerPanel, /'submit'/);
  assert.match(composerPanel, /event\.preventDefault\(\);\s*instance\.callbacks\.onSubmit\?\.\(\);/);
  assert.match(composerPanel, /requestSubmit\?\.\(\)/);
  assert.match(contentScript, /onSubmit:\s*\(\) => safeRunTask\(\)/);
  assert.match(contentScript, /function safeRunTask\(\)/);
  assert.match(contentScript, /runTask\(\)\.catch/);
});

test('composer textarea sends on Enter while preserving Shift Enter and IME composition', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  const composerPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/composerPanel.js'),
    'utf8'
  );

  assert.match(composerPanel, /'keydown'/);
  assert.match(contentScript, /onTaskKeydown:\s*handleTaskInputKeydown/);
  assert.match(contentScript, /function handleTaskInputKeydown\(event\)/);
  assert.match(contentScript, /event\.key !== 'Enter'/);
  assert.match(contentScript, /event\.shiftKey/);
  assert.match(contentScript, /event\.isComposing/);
  assert.match(contentScript, /event\.preventDefault\(\);\s*panel\.querySelector\('\[data-composer-form\]'\)\?\.requestSubmit\(\);/);
  assert.doesNotMatch(contentScript, /event\.key === 'Enter' && \(event\.metaKey \|\| event\.ctrlKey\)/);
});

test('starting a run is not blocked by asynchronous state persistence', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  // v1.6.3: applySyncChangesToOverleaf moved to writebackOrchestrator.js, so
  // runTask's end delimiter is the next function still in contentRuntime.
  const runTaskBody = contentScript.match(/async function runTask\(\) \{[\s\S]*?\n  async function runSkillInstallerTask/)?.[0] || '';
  const beforeStartRun = runTaskBody.split(/currentRunView = startRunView\(/)[0] || '';

  assert.doesNotMatch(beforeStartRun, /await saveState\(\)/);
  assert.match(runTaskBody, /saveStateSoon\(\)/);
});

test('clicking the running spinner requests cancellation instead of being disabled', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  const composerPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/composerPanel.js'),
    'utf8'
  );
  const clickHandler = composerPanel.match(/querySelector\('\[data-run\]'\)[\s\S]*?form\?\.requestSubmit\?\.\(\);/)?.[0] || '';
  const setRunningBody = contentScript.match(/function setRunning\(running\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(clickHandler, /if \(instance\.callbacks\.isRunning\?\.\(\)\)/);
  assert.match(contentScript, /onCancel:\s*\(\) => cancelActiveRun\(\)/);
  assert.match(contentScript, /async function cancelActiveRun\(/);
  assert.match(contentScript, /method:\s*'codex\.cancel'/);
  assert.doesNotMatch(setRunningBody, /\[data-run\]'\)\.disabled = running/);
  assert.match(setRunningBody, /aria-label', running \? tr\('cancelRun'\) : tr\('send'\)/);
});

test('task failures after a user cancellation request render as interrupted', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );

  assert.match(contentScript, /if \(runCancellationRequested \|\| isRunCancellationError\(response\.error\)\)/);
  assert.match(contentScript, /if \(runCancellationRequested \|\| isRunCancellationError\(error\)\)/);
});

test('panel persistence uses hybrid IndexedDB storage with legacy fallback', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );

  assert.match(contentScript, /prepareStateForStorage/);
  // The chrome.storage.local quota fallback writes a COMPACT shape
  // (prepareCompactFallbackState) — not the full prepareStateForStorage(state).
  // The compact form strips task/sessions/runs and tags the blob with
  // __codexOverleafCompactFallback so the loader returns prefs-only instead
  // of re-persisting redacted '[task omitted]' markers as real session data
  // (the B4 data-loss fix). Assert the fallback writes the compact form and
  // that the compact builder strips the session payload.
  assert.match(contentScript, /chrome\.storage\.local\.set\(\{ \[storageKey\]: prepareCompactFallbackState\(state\) \}\)/);
  assert.match(contentScript, /function prepareCompactFallbackState/);
  assert.match(contentScript, /__codexOverleafCompactFallback: true/);
  // saveState() is wrapped in a .catch/.finally chain inside runQueuedSaveState
  // (the in-flight serialization fix). The chain may be single-line or split
  // across lines; either form is acceptable.
  assert.match(contentScript, /saveState\(\)\s*\.catch/);
  // Hybrid approach: prefs via Migration, sessions via StorageDb
  assert.match(contentScript, /Migration\.savePrefs\(prefs\)/);
  assert.match(contentScript, /StorageDb\.putRecords\('sessions', sessionRecords\)/);
  assert.match(contentScript, /StorageDb\.extractLightweightPrefs\(compactState, projectId\)/);
  assert.match(contentScript, /runs:\s*Array\.isArray\(session\.runs\)/);
  assert.match(contentScript, /history:\s*Array\.isArray\(session\.history\)/);
});

test('storage notice is not appended repeatedly during autosave', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  // saveState was widened in Fix A to accept an `options` argument with
  // projectIdOverride; tolerate either signature.
  const saveStateBody = contentScript.match(/async function saveState\([^)]*\) \{[\s\S]*?\n  function saveStateSoon/)?.[0] || '';
  const appendStorageNoticeBody = contentScript.match(/function appendStorageNoticeOnce\(key, text\) \{[\s\S]*?\n  function saveStateSoon/)?.[0] || '';
  const appendPlainLogBody = contentScript.match(/function appendPlainLog\(text\) \{[\s\S]*?\n  function updateProbeNotice/)?.[0] || '';
  const showPluginToastBody = contentScript.match(/function showPluginToast\(text, options = \{\}\) \{[\s\S]*?\n  function updateProbeNotice/)?.[0] || '';

  assert.match(contentScript, /storageNoticeKeys = new Set\(\)/);
  assert.match(contentScript, /function appendStorageNoticeOnce\(/);
  assert.match(saveStateBody, /appendStorageNoticeOnce\('save-failed'/);
  assert.doesNotMatch(appendStorageNoticeBody, /appendRunEvent\(\{/);
  assert.match(appendStorageNoticeBody, /showPluginToast/);
  assert.match(appendPlainLogBody, /showPluginToast/);
  assert.match(showPluginToastBody, /dataset\.repeatCount/);
});
