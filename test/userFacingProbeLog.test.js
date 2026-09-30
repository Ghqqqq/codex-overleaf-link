const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { extractFunction } = require('./_helpers/extractFunction');

const vm = require('node:vm');
const I18n = require('../extension/src/shared/i18n');
const probeRuntimeSource = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');

function probeProjection() {
  const notices = [];
  const context = { state: { mode: 'auto' }, currentRunView: null,
    tr: key => I18n.t('en', key), tx: english => english,
    getActiveFocusFiles: () => [], isExperimentalOtEnabled: () => false,
    getCurrentOtStatus: () => 'ready', formatOtStatusLabel: value => value,
    panel: { querySelector: () => ({}) }, updateProbeNotice: value => notices.push(value)
  };
  vm.createContext(context);
  for (const name of ['getProbeRunReadiness', 'formatModeLabel', 'appendOtStatusToProbeStatus',
    'formatProbeStatusBar', 'formatProbeUserNotice', 'isProbeReadyForCurrentMode', 'updateExistingProbeNotice']) {
    vm.runInContext(extractFunction(probeRuntimeSource, name), context);
  }
  return { context, notices };
}


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
  const { context: h } = probeProjection();
  const probe = { editor: { ok: true }, reviewing: { ok: true }, capabilities: { editor: { write: false } } };
  const status = h.formatProbeStatusBar(probe);
  assert.ok(status.includes(I18n.t('en', 'modeAuto')));
  assert.ok(status.includes(I18n.t('en', 'validatingEditor')));
  assert.doesNotMatch(status, /analysis.only/i);
});

test('ask mode probe copy does not mention write verification or Reviewing requirements', () => {
  const { context: h } = probeProjection();
  const probe = { editor: { ok: false }, reviewing: { ok: false } };
  const status = h.formatProbeStatusBar(probe, 'ask');
  const notice = h.formatProbeUserNotice(probe, 'ask');
  assert.ok(status.startsWith(I18n.t('en', 'modeAsk')));
  assert.equal(notice.ready, true);
  assert.match(notice.message, /will not write to Overleaf/);
  assert.doesNotMatch(status + notice.message, /Reviewing|verify.*writ/i);
});

test('probe status line shows OT state only when the experimental mirror is enabled', () => {
  const { context: h } = probeProjection();
  const probe = { editor: { ok: false } };
  assert.doesNotMatch(h.formatProbeStatusBar(probe, 'ask'), /OT ready/);
  h.isExperimentalOtEnabled = () => true;
  assert.match(h.formatProbeStatusBar(probe, 'ask'), /OT ready$/);
});

test('probe footer readiness follows current mode instead of requiring Reviewing for ask mode', () => {
  const { context: h } = probeProjection();
  const probe = { editor: { ok: false }, reviewing: { ok: false } };
  assert.equal(h.isProbeReadyForCurrentMode(probe, 'ask'), true);
  assert.equal(h.isProbeReadyForCurrentMode(probe, 'auto'), false);
  assert.equal(h.isProbeReadyForCurrentMode({ ...probe, reviewing: { ok: true } }, 'auto'), true);
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
  const { context: h, notices } = probeProjection();
  const probe = { editor: { ok: false }, reviewing: { ok: false } };
  h.updateExistingProbeNotice(probe, 'auto');
  assert.ok(notices.at(-1));
  h.updateExistingProbeNotice(probe, 'ask');
  assert.equal(notices.at(-1), '');
  h.currentRunView = { id: 'active' };
  h.updateExistingProbeNotice(probe, 'auto');
  assert.equal(notices.length, 2);
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
