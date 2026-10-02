(function initCodexOverleafLegacyGlobalRegistry(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CodexOverleafLegacyGlobalRegistry = api;
  }
})(typeof window !== 'undefined' ? window : globalThis, function legacyGlobalRegistryFactory() {
  'use strict';

  const REQUIRED_MODULES = Object.freeze([
    'ActiveTurnControl',
    'AgentTranscript',
    'ApplyResultFormatters',
    'AssetTransferBroker',
    'AuditRecords',
    'SelectionContext',
    'SelectionContextView',
    'WritebackIntent',
    'ChangeHistoryModel',
    'ChangeHistoryView',
    'Compatibility',
    'ComposerAttachments',
    'ComposerPanel',
    'ContentRuntime',
    'ContextTray',
    'DiagnosticsController',
    'DiagnosticsExport',
    'DiagnosticsPanel',
    'DiffReviewPanel',
    'FailureReasons',
    'GovernanceRules',
    'GlobalPreferences',
    'GlobalPreferencesController',
    'I18n',
    'LineReferences',
    'LocalSkillsPanel',
    'MarkdownText',
    'MirrorHealth',
    'ModelPicker',
    'NativeChannel',
    'NativeCompatibilityController',
    'OtWarmMirror',
    'OtWarmMirrorController',
    'PageBridgeClient',
    'PageRpcContract',
    'PanelMaintenance',
    'PanelRenderer',
    'PendingInputView',
    'PostNavigationSettlementPersistence',
    'ProjectFiles',
    'ProjectProviderSelection',
    'ProjectSettingsCoordinator',
    'ProviderSettingsCoordinator',
    'RecentProjects',
    'ReviewHunks',
    'RunActivitySummary',
    'RunPresence',
    'RunActivityModel',
    'RunController',
    'RunExecutionSnapshot',
    'RunGuidanceController',
    'RunInputQueue',
    'RunQueueScheduler',
    'RunResultActions',
    'RunScrollLayout',
    'RunFailureNotice',
    'RunSettlementPersistence',
    'RunTimelineView',
    'ScopedPersistenceCoordinator',
    'ScopedPersistenceTransaction',
    'SensitiveScan',
    'SessionManager',
    'SessionForkController',
    'SessionPanel',
    'SessionPersistence',
    'SessionState',
    'SettingsPanel',
    'SharedSessionBridge',
    'SharedSessionViewSync',
    'StorageDb',
    'StorageKeys',
    'StorageMigration',
    'SubagentActivityModel',
    'SubagentActivityView',
    'Summary',
    'Theme',
    'TrackedChangeCaptureController',
    'UndoOperations',
    'UpdateIdle',
    'UpdateNotice',
    'WritebackController',
    'WritebackIntent',
    'WritebackOrchestrator',
    'WritebackPlan',
    'WritebackSettlement',
    'WritingStyle',
    'WritingStyleSettings',
    'WrittenChangesView'
  ]);

  const SUPPORT_MODULES = Object.freeze([
    'CompileAdapter',
    'MarkdownDomRenderer',
    'MathText',
    'ModelPickerSupport',
    'ProjectSessionCleanup',
    'ProviderProfiles',
    'ProviderSettingsDialog',
    'RunGuidanceView',
    'SessionMenuView'
  ]);

  function create(root) {
    if (!root || typeof root !== 'object') {
      throw new TypeError('Codex Overleaf content startup requires a browser global.');
    }
    const modules = {};
    const missing = [];
    for (const name of [...REQUIRED_MODULES, ...SUPPORT_MODULES]) {
      const value = root[`CodexOverleaf${name}`];
      if (!value) {
        missing.push(`CodexOverleaf${name}`);
      } else {
        modules[name] = value;
      }
    }
    if (missing.length) {
      const error = new Error(`Codex Overleaf content dependencies are missing: ${missing.join(', ')}`);
      error.code = 'content_dependency_missing';
      error.missing = missing;
      throw error;
    }
    const vendor = Object.freeze({
      katex: root.katex || null,
      markdownit: root.markdownit || null
    });
    return Object.freeze({
      root,
      chromeApi: root.chrome,
      document: root.document,
      modules: Object.freeze(modules),
      vendor
    });
  }

  return Object.freeze({
    create,
    requiredModules: REQUIRED_MODULES,
    supportModules: SUPPORT_MODULES
  });
});
