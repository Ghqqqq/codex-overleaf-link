const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { extractFunction } = require('./_helpers/extractFunction');


test('project snapshot action lives in the diagnostics menu instead of the header actions', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  const diagnosticsPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/diagnosticsPanel.js'),
    'utf8'
  );
  const panelSource = `${contentScript}\n${diagnosticsPanel}`;
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );

  const settingsPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/settingsPanel.js'),
    'utf8'
  );
  // v1.4.5: the check runners + result formatters were carved out of
  // contentRuntime into the diagnostics controller module.
  const diagnosticsController = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/diagnosticsController.js'),
    'utf8'
  );

  assert.equal(panelSource.includes('data-snapshot'), false);
  assert.match(panelSource, /data-diagnostics-menu/);
  assert.match(panelSource, /data-diagnostics-native-env/);
  assert.match(panelSource, /data-diagnostics-page-state/);
  assert.match(panelSource, /data-diagnostics-snapshot/);
  assert.match(panelSource, /data-diagnostics-ot/);
  assert.match(panelSource, /data-diagnostics-result/);
  // v1.4.3: the menu is pure diagnostics — Run all + a health dot on the
  // trigger; the OT toggle and language switch moved to Settings.
  assert.match(panelSource, /data-diagnostics-run-all/);
  assert.match(panelSource, /data-diagnostics-health-dot/);
  assert.doesNotMatch(panelSource, /data-language-toggle/);
  assert.doesNotMatch(panelSource, /Switch to Chinese/);
  assert.match(panelSource, /Use when Codex cannot run, write, or read files/);
  assert.match(panelSource, /Check Local Connection/);
  assert.match(panelSource, /Check Overleaf Write Access/);
  assert.match(panelSource, /Check Project Read/);
  assert.match(panelSource, /Check OT Mirror/);
  assert.doesNotMatch(panelSource, /Check Experimental OT Mirror/);
  // OT keeps its persisted control key while its visible label is promoted.
  // v1.7.5: the dual hidden-checkbox + button control became a single visible
  // switch (the checkbox itself); the confirm-before-enable click interceptor
  // binds to it directly.
  assert.match(settingsPanel, /data-experimental-ot\b/);
  assert.doesNotMatch(settingsPanel, /data-experimental-ot-toggle/);
  assert.match(settingsPanel, /<span data-i18n="experimentalOtMenuTitle">OT Mirror<\/span>/);
  assert.match(settingsPanel, /data-language-select/);
  assert.match(contentScript, /function applyLocaleToPanel\(/);
  assert.match(diagnosticsController, /function inspectNativeEnvironment\(/);
  assert.match(diagnosticsController, /function inspectOtWarmMirrorDiagnostics\(/);
  assert.match(diagnosticsController, /function formatOtDiagnosticsResult\(/);
  assert.match(diagnosticsController, /function formatNativeEnvironmentResult\(/);
  assert.match(contentScript, /function toggleDiagnosticsMenu\(/);
  assert.match(contentScript, /function closeDiagnosticsMenu\(/);
  assert.match(contentScript, /function showDiagnosticsResult\(/);
  assert.match(diagnosticsController, /function inspectProjectSnapshot\(/);
  assert.match(diagnosticsController, /allowEditorNavigation:\s*false/);
  assert.match(css, /\.codex-diagnostics-menu/);
  assert.match(css, /\.codex-diagnostics-result/);
  assert.match(css, /\.codex-diagnostics-technical/);
});

test('diagnostics render in a floating result panel instead of the task transcript', () => {
  const diagnosticsController = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/diagnosticsController.js'),
    'utf8'
  );
  const nativeBody = extractFunction(diagnosticsController, 'inspectNativeEnvironment');
  const pageBody = extractFunction(diagnosticsController, 'inspectPageStateDiagnostics');
  const snapshotBody = extractFunction(diagnosticsController, 'inspectProjectSnapshot');

  assert.doesNotMatch(nativeBody, /appendLog\(/);
  assert.doesNotMatch(pageBody, /appendLog\(/);
  assert.doesNotMatch(snapshotBody, /appendLog\(/);
  assert.match(nativeBody, /showDiagnosticsLoading\(tr\('diagnosticsNativeTitle'\)/);
  assert.match(pageBody, /showDiagnosticsLoading\(tr\('diagnosticsPageTitle'\)/);
  assert.match(snapshotBody, /showDiagnosticsLoading\(tr\('diagnosticsSnapshotTitle'\)/);
  // Each check builds its structured result via its formatter and renders it
  // through showDiagnosticsResult (the collectOnly path returns it for Run all).
  assert.match(nativeBody, /formatNativeEnvironmentResult/);
  assert.match(pageBody, /formatPageStateDiagnosticsResult/);
  assert.match(snapshotBody, /formatProjectSnapshotDiagnosticsResult/);
  assert.match(nativeBody, /showDiagnosticsResult\(/);
});

test('diagnostics menu exports a content-redacted audit bundle', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  const diagnosticsPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/diagnosticsPanel.js'),
    'utf8'
  );
  const panelSource = `${contentScript}\n${diagnosticsPanel}`;
  const i18n = fs.readFileSync(
    path.join(__dirname, '../extension/src/shared/i18n.js'),
    'utf8'
  );

  assert.match(panelSource, /data-diagnostics-export/);
  assert.match(contentScript, /diagnosticsExporter\.exportDiagnosticsBundle/);
  const exportSource = fs.readFileSync(path.join(__dirname, '../extension/src/content/diagnosticsExport.js'), 'utf8');
  assert.match(exportSource, /AuditRecords\.buildDiagnosticBundle/);
  assert.match(exportSource, /getRecentAuditLogsForCurrentProject/);
  assert.match(exportSource, /getNativeDiagnosticsSummaryForBundle/);
  assert.match(exportSource, /platform:\s*nativeDiagnostics\.platform/);
  assert.match(exportSource, /nativeEnvironment:\s*nativeDiagnostics\.nativeEnvironment/);
  assert.match(exportSource, /URL\.createObjectURL/);
  assert.match(exportSource, /download = `codex-overleaf-diagnostics-/);
  assert.match(exportSource, /excludeContent:\s*true/);
  assert.doesNotMatch(exportSource.match(/function exportDiagnosticsBundle[\s\S]*?\n  function /)?.[0] || '', /content:\s*project/);
  assert.match(i18n, /diagnosticsExportTitle/);
  assert.match(i18n, /diagnosticsExportSubtitle/);
});

test('experimental OT diagnostics read metadata without draining project content', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  const diagnosticsPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/diagnosticsPanel.js'),
    'utf8'
  );
  const diagnosticsController = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/diagnosticsController.js'),
    'utf8'
  );
  const menuBody = diagnosticsPanel.match(/function bindStaticActions\(instance\) \{[\s\S]*?\n  \}/)?.[0] || '';
  const inspectBody = extractFunction(diagnosticsController, 'inspectOtWarmMirrorDiagnostics');
  const formatBody = diagnosticsController.match(/function formatOtDiagnosticsResult\(\{ otStatus, mirrorStatus \}\) \{[\s\S]*?\n  function /)?.[0] || '';
  const technicalBody = diagnosticsController.match(/function formatOtDiagnosticsTechnicalDetails\(metadata = \{\}\) \{[\s\S]*?\n  function formatOtChannelCandidates/)?.[0] || '';

  assert.match(menuBody, /\[data-diagnostics-ot\]/);
  assert.match(menuBody, /onOtDiagnostics/);
  assert.match(inspectBody, /showDiagnosticsLoading\(tr\('diagnosticsOtTitle'\)/);
  assert.match(inspectBody, /callPageBridge\('getOtStatus'/);
  assert.match(inspectBody, /getMirrorFreshness\(\)/);
  assert.doesNotMatch(inspectBody, /drainOtEvents/);
  // The metadata result is built from formatOtDiagnosticsResult and rendered
  // (or returned for Run all via collectOnly).
  assert.match(inspectBody, /formatOtDiagnosticsResult\(\{ otStatus, mirrorStatus \}\)/);
  assert.match(inspectBody, /showDiagnosticsResult\(result\)/);
  assert.match(inspectBody, /status:\s*'warning'/);
  assert.doesNotMatch(inspectBody, /'warnings:'/);
  assert.doesNotMatch(inspectBody, /warnings\.map/);
  assert.doesNotMatch(inspectBody, /technical:\s*\[[\s\S]*warnings/);
  assert.match(formatBody, /isExperimentalOtEnabled\(\)/);
  assert.match(formatBody, /formatOtStatusLabel/);
  assert.match(formatBody, /lastOtPatchAt/);
  assert.match(formatBody, /queuedEventCount/);
  assert.match(formatBody, /channelCandidates/);
  assert.match(formatBody, /diagnosticsOtSummaryEnabled/);
  assert.match(formatBody, /diagnosticsOtSummaryDisabled/);
  assert.match(formatBody, /const focusFiles = getActiveFocusFiles\(\)/);
  assert.match(formatBody, /otWarmMirrorController\?\.canUseOtWarmStart\?\.\(\{\s*enabled,\s*focusFiles,\s*mirrorStatus\s*\}\)/);
  assert.match(formatBody, /otWarmStart\?\.ok !== true/);
  assert.doesNotMatch(formatBody, /otFreshFileCount <= 0/);
  assert.match(technicalBody, /`strategy:/);
  assert.match(technicalBody, /`queuedEventCount:/);
  assert.match(technicalBody, /`lastEventAt:/);
  assert.match(technicalBody, /`lastOtPatchAt:/);
  assert.match(technicalBody, /`lastOtErrorCode:/);
  assert.match(technicalBody, /`lastErrorCode:/);
  assert.match(technicalBody, /`channelCandidates:/);
  assert.doesNotMatch(technicalBody, /`enabled:/);
  assert.doesNotMatch(technicalBody, /`fallback:/);
  assert.doesNotMatch(technicalBody, /`status:/);
  assert.doesNotMatch(technicalBody, /`state:/);
  assert.doesNotMatch(technicalBody, /`running:/);
  assert.doesNotMatch(technicalBody, /`activePath:/);
  assert.doesNotMatch(technicalBody, /`mirrorExists:/);
  assert.doesNotMatch(technicalBody, /`mirrorAgeMs:/);
  assert.doesNotMatch(technicalBody, /`otFreshFileCount:/);
  assert.doesNotMatch(technicalBody, /`otStaleFileCount:/);
  assert.doesNotMatch(technicalBody, /focusFiles/);
  assert.doesNotMatch(formatBody, /nextContent/);
  assert.doesNotMatch(formatBody, /previousContent/);
  assert.doesNotMatch(formatBody, /\bops\b/);
  assert.doesNotMatch(formatBody, /JSON\.stringify\((otStatus|mirrorStatus)/);
});

test('OT diagnostics i18n is available in English and Chinese without experimental labels', () => {
  const I18n = require('../extension/src/shared/i18n');
  const keys = [
    'diagnosticsOtTitle',
    'diagnosticsOtSubtitle',
    'diagnosticsOtSummaryEnabled',
    'diagnosticsOtSummaryDisabled',
    'diagnosticsOtNextStep',
    'experimentalOtMenuTitle',
    'experimentalOtMenuSubtitle',
    'experimentalOtConfirmTitle',
    'experimentalOtConfirmMessage',
    'experimentalOtConfirmEnable',
    'experimentalOtEnabledToast',
    'otStatus',
    'otFreshFiles',
    'otFallback',
    'yes',
    'no'
  ];

  for (const key of keys) {
    assert.notEqual(I18n.t('en', key), key, `missing English i18n key ${key}`);
    assert.notEqual(I18n.t('zh', key), key, `missing Chinese i18n key ${key}`);
  }

  assert.equal(I18n.t('en', 'experimentalOtMenuTitle'), 'OT Mirror');
  assert.equal(I18n.t('zh', 'experimentalOtMenuTitle'), 'OT Mirror');
  assert.equal(I18n.t('en', 'experimentalOtConfirmEnable'), 'Turn on');
  assert.equal(I18n.t('zh', 'experimentalOtConfirmEnable'), '开启');
  assert.doesNotMatch(I18n.t('en', 'experimentalOtConfirmMessage'), /[\u4e00-\u9fff]/);
  assert.doesNotMatch(I18n.t('zh', 'experimentalOtConfirmMessage'), /Experimental: tracks/);
  for (const locale of ['en', 'zh']) {
    for (const key of ['experimentalOtMenuTitle', 'diagnosticsOtSummaryEnabled', 'diagnosticsOtSummaryDisabled']) {
      assert.doesNotMatch(I18n.t(locale, key), /experimental|实验性/i);
    }
    for (const key of [
      'experimentalOtMenuTitle',
      'experimentalOtMenuSubtitle',
      'experimentalOtConfirmTitle',
      'experimentalOtConfirmMessage',
      'experimentalOtConfirmEnable',
      'experimentalOtEnabledToast'
    ]) {
      assert.doesNotMatch(I18n.t(locale, key), /\s\/\s/, `${locale}.${key} should not inline both locales`);
    }
  }
});

test('diagnostic summaries use natural language while raw details stay collapsed', () => {
  const diagnosticsController = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/diagnosticsController.js'),
    'utf8'
  );
  const diagnosticsPanel = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/diagnosticsPanel.js'),
    'utf8'
  );

  assert.match(diagnosticsController, /Codex 已连接，本机 LaTeX 工具可用/);
  assert.match(diagnosticsController, /插件没有连上本机服务/);
  assert.match(diagnosticsController, /当前 Overleaf 文件可以读取和写入/);
  assert.match(diagnosticsController, /插件没有确认当前编辑器可以写入/);
  assert.match(diagnosticsController, /插件已读到完整 Overleaf 项目/);
  assert.match(diagnosticsController, /没有读到完整的 Overleaf 项目/);
  assert.match(diagnosticsPanel, /<summary data-i18n="technicalDetails">Technical Details<\/summary>/);
});

test('diagnostic result stays bounded by the sidebar and viewport', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '../extension/styles/panel.css'),
    'utf8'
  );
  const resultBlock = css.match(/#codex-overleaf-panel \.codex-diagnostics-result\s*\{[\s\S]*?\n\}/)?.[0] || '';

  assert.match(resultBlock, /position:\s*fixed/);
  assert.match(resultBlock, /top:\s*44px/);
  assert.match(resultBlock, /right:\s*12px/);
  assert.match(resultBlock, /width:\s*min\(400px,\s*calc\(var\(--codex-overleaf-panel-width\) - 24px\),\s*calc\(100vw - 24px\)\)/);
  assert.match(resultBlock, /overflow:\s*hidden/);
  assert.doesNotMatch(resultBlock, /position:\s*absolute/);
});

test('panel native diagnostics sends compatibility metadata and evaluates mismatches before environment details', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  const diagnosticsController = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/diagnosticsController.js'),
    'utf8'
  );
  const inspectBody = extractFunction(diagnosticsController, 'inspectNativeEnvironment');
  const formatBody = extractFunction(diagnosticsController, 'formatNativeEnvironmentResult');

  assert.match(contentScript, /CodexOverleafCompatibility/);
  assert.match(inspectBody, /CodexOverleafCompatibility\.buildBridgePingParams/);
  assert.doesNotMatch(inspectBody, /method:\s*'bridge\.ping',\s*params:\s*\{\s*\}/);
  assert.match(formatBody, /CodexOverleafCompatibility\.evaluateNativeCompatibility/);
  assert.ok(
    formatBody.indexOf('evaluateNativeCompatibility') < formatBody.indexOf('const environment'),
    'native compatibility must be evaluated before formatting Codex/LaTeX environment details'
  );
  assert.match(diagnosticsController, /native_too_old/);
  assert.match(diagnosticsController, /protocol_unsupported/);
  assert.match(diagnosticsController, /extension_too_old/);
  assert.match(diagnosticsController, /installCommand:\s*compatibility\.installCommand/);
  assert.match(diagnosticsController, /Native Host Update Required/);
  assert.match(diagnosticsController, /Protocol Mismatch/);
});
