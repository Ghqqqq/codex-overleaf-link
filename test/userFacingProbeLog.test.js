const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { extractFunction } = require('./_helpers/extractFunction');

test('normal state refresh writes user-facing status instead of raw probe diagnostics', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  const i18n = fs.readFileSync(
    path.join(__dirname, '../extension/src/shared/i18n.js'),
    'utf8'
  );
  const refreshProbeBody = contentScript.match(/async function refreshProbe\(options = \{\}\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(refreshProbeBody, /appendProbeUserStatus\(probe\)/);
  assert.doesNotMatch(refreshProbeBody, /appendEditorDiagnostics/);
  assert.doesNotMatch(refreshProbeBody, /appendReviewingDiagnostics/);
  assert.doesNotMatch(refreshProbeBody, /State:/);
  assert.match(contentScript, /function formatProbeStatusBar\(/);
  assert.match(contentScript, /function appendProbeUserStatus\(/);
  assert.match(contentScript, /还不能安全写入/);
});

test('manual refresh gives visible feedback without appending task transcript messages', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  const i18n = fs.readFileSync(
    path.join(__dirname, '../extension/src/shared/i18n.js'),
    'utf8'
  );
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );
  const refreshProbeBody = contentScript.match(/async function refreshProbe\(options = \{\}\) \{[\s\S]*?\n  function formatProbeStatusBar/)?.[0] || '';

  assert.match(contentScript, /onRefresh:\s*\(\) => refreshProbe\(\{\s*userInitiated:\s*true\s*\}\)/);
  assert.match(refreshProbeBody, /const userInitiated = options\.userInitiated === true/);
  assert.match(refreshProbeBody, /tr\('refreshProbeLoading'\)/);
  assert.match(refreshProbeBody, /tr\('refreshProbeDone', \{ status: formatProbeStatusBar\(probe\) \}\)/);
  assert.match(refreshProbeBody, /tr\('refreshProbeFailed'\)/);
  assert.match(i18n, /正在重新检测当前文件、写入权限和留痕状态/);
  assert.match(refreshProbeBody, /setRefreshProbeLoading\(true\)/);
  assert.match(refreshProbeBody, /setRefreshProbeLoading\(false\)/);
  assert.match(refreshProbeBody, /!userInitiated/);
  assert.match(contentScript, /function setRefreshProbeLoading\(loading\)/);
  assert.match(css, /\[data-refresh\]\[data-loading="true"\]/);
  assert.match(css, /codex-refresh-spin/);
});

test('initial panel probe only updates footer status and does not leave a stale empty-state notice', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  const initBody = contentScript.match(/async function init\(\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(initBody, /refreshProbe\(\{\s*quiet:\s*true\s*\}\)/);
  assert.doesNotMatch(initBody, /await refreshProbe\(\)/);
});

test('probe status copy describes the next user action without internal editor wording', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  const i18n = fs.readFileSync(
    path.join(__dirname, '../extension/src/shared/i18n.js'),
    'utf8'
  );

  assert.match(i18n, /wholeProjectContext:\s*'将读取整个项目'/);
  assert.match(i18n, /fileContext:\s*'已选择 @file 上下文'/);
  assert.doesNotMatch(contentScript, /需要打开一个 \.tex 文件/);
  assert.doesNotMatch(contentScript, /Codex 没读到当前文件/);
  assert.doesNotMatch(contentScript, /左侧文件列表点开要处理的 \.tex 文件/);
  assert.doesNotMatch(contentScript, /状态部分可用/);
  assert.doesNotMatch(contentScript, /识别当前编辑器/);
  assert.doesNotMatch(contentScript, /已连接编辑器/);
  assert.doesNotMatch(contentScript, /未识别编辑器/);
});

test('probe status copy surfaces page capability downgrade without raw diagnostics', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );

  assert.match(contentScript, /editorWriteBlocked = probe\.capabilities\?\.editor\?\.write === false/);
  assert.match(contentScript, /写入时会重新打开目标文件并验证/);
  assert.doesNotMatch(contentScript, /fileTreeManager\./);
});

test('write modes are not mislabeled as analysis-only when editor writability probe is stale', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );

  assert.doesNotMatch(contentScript, /只能分析 · 当前编辑器不可写/);
  assert.match(contentScript, /formatModeLabel\(state\?\.mode\)/);
  assert.match(contentScript, /tr\('validatingEditor'\)/);
});

test('ask mode probe copy does not mention write verification or Reviewing requirements', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  const statusBody = contentScript.match(/function formatProbeStatusBar\(probe\) \{[\s\S]*?\n  \}/)?.[0] || '';
  const noticeBody = contentScript.match(/function formatProbeUserNotice\(probe\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(statusBody, /state\?\.mode === 'ask'/);
  assert.match(statusBody, /\$\{formatModeLabel\('ask'\)\} · \$\{readiness\.contextLabel\}/);
  assert.match(noticeBody, /state\?\.mode === 'ask'/);
  assert.match(noticeBody, /不会写入 Overleaf/);
});

test('probe status line shows OT state only when the experimental mirror is enabled', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  const statusBody = contentScript.match(/function formatProbeStatusBar\(probe\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(contentScript, /function appendOtStatusToProbeStatus\(/);
  assert.match(statusBody, /appendOtStatusToProbeStatus\(/);
  assert.match(contentScript, /isExperimentalOtEnabled\(\)/);
  // v1.4.9: the OT status lives in otWarmMirror.js; the probe suffix reads it
  // through the exported getter.
  assert.match(contentScript, /formatOtStatusLabel\(getCurrentOtStatus\(\)\)/);
  assert.match(contentScript, /OT \$\{formatOtStatusLabel\(getCurrentOtStatus\(\)\)\}/);
});

test('probe footer readiness follows current mode instead of requiring Reviewing for ask mode', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  const refreshProbeBody = contentScript.match(/async function refreshProbe\(options = \{\}\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(contentScript, /function isProbeReadyForCurrentMode\(probe\)/);
  assert.match(refreshProbeBody, /isProbeReadyForCurrentMode\(probe\)/);
  assert.doesNotMatch(refreshProbeBody, /getProbeRunReadiness\(probe\)\.reviewingOk \? 'true' : 'false'/);
});

test('mode switching refreshes the probe footer immediately', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  const selectModeBody = contentScript.match(/async function selectMode\(mode\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(selectModeBody, /refreshProbe\(\{\s*quiet:\s*true\s*\}\)/);
});

test('probe notice is replaced instead of leaving stale readiness messages in the task log', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );

  assert.match(contentScript, /function updateProbeNotice\(/);
  assert.match(contentScript, /querySelector\('\[data-probe-notice\]'\)/);
  assert.match(contentScript, /item\.dataset\.probeNotice = 'true'/);
  assert.match(contentScript, /updateProbeNotice\(ready \? '' : message\)/);
});

test('quiet probe refresh updates an existing notice so the main task area cannot contradict the footer', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  const refreshProbeBody = contentScript.match(/async function refreshProbe\(options = \{\}\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(refreshProbeBody, /updateExistingProbeNotice\(probe\)/);
  assert.match(contentScript, /function updateExistingProbeNotice\(probe\)/);
});

test('normal task flow logs a user-facing project read summary', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  const runTaskBody = extractFunction(contentScript, 'runTask');
  const diagnosticsPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/diagnosticsPanel.js'),
    'utf8'
  );

  assert.match(runTaskBody, /appendLog\(formatProjectSnapshotUserLog\(project\)\)/);
  assert.match(contentScript, /function formatProjectSnapshotUserLog\(/);
  assert.match(diagnosticsPanel, /已读取 Overleaf 项目/);
});
