(function initCodexOverleafContentRuntime(root) {
  'use strict';
  function init(dependencies) {
  'use strict';

  dependencies = dependencies || {};
  const Modules = dependencies.modules;
  if (!Modules || typeof Modules !== 'object') {
    throw Object.assign(new Error('Codex Overleaf content runtime requires validated dependencies.'), {
      code: 'content_dependency_registry_required'
    });
  }

  const RUNTIME_INSTALLED_FLAG = '__codexOverleafContentRuntimeInstalled';
  const RUNTIME_STATE_KEY = '__codexOverleafContentRuntimeState';
  if (root[RUNTIME_INSTALLED_FLAG]) {
    return root[RUNTIME_STATE_KEY] || { ok: true, alreadyInstalled: true };
  }
  if (root.document?.getElementById?.('codex-overleaf-panel')) {
    const result = {
      ok: false,
      initFailed: true,
      alreadyInstalled: true,
      errorCode: 'stale-panel-before-runtime-init'
    };
    root[RUNTIME_INSTALLED_FLAG] = true;
    root[RUNTIME_STATE_KEY] = result;
    return result;
  }

  const PANEL_ID = 'codex-overleaf-panel';
  const LEGACY_STORAGE_KEY = 'codexOverleafPanelState';
  const RUN_PROJECT_SYNC_MAX_AGE_MS = 30000;
  const RUN_SNAPSHOT_ZIP_TIMEOUT_MS = 30000;
  const STREAM_RENDER_FLUSH_MS = 80;
  const REVIEWING_CONFIRM_TIMEOUT_MS = 120000;
  const STREAM_SAVE_DELAY_MS = 1000;
  const MAX_RUN_EVENTS = 300;
  const MAX_SAFE_UNDO_REPLACEALL_CHARS = 2000;
  const ONBOARDING_TIP_STORAGE_KEY = 'codexOverleafOnboardingTipShown';
  const NATIVE_COMPATIBILITY_GATED_METHODS = new Set([
    'mirror.status',
    'codex.models',
    'codex.run',
    'codex.steer',
    'codex.providers.list',
    'codex.providers.test',
    'codex.providers.test.cancel',
    'codex.providers.upsert',
    'codex.providers.activate',
    'codex.providers.clear-secret',
    'codex.providers.delete',
    'task.run',
    'mirror.sync',
    'mirror.patchFiles', 'mirror.confirmWriteback', 'mirror.invalidate',
    'mirror.scanSensitive',
    'codex.history.clearPlugin',
    'skills.list',
    'skills.install',
    'skills.remove',
    'writing-style.get',
    'writing-style.set',
    'codex.thread.fork',
    'asset.readChunk',
    'asset.release'
  ]);
  const PageRpcContract = Modules.PageRpcContract;
  const PANEL_DEFAULT_WIDTH = 380;
  const PANEL_MIN_WIDTH = 340;
  const PANEL_MAX_WIDTH = 760;
  const PAGE_MIN_WIDTH = 520;
  const CodexOverleafCompatibility = Modules.Compatibility;
  const MANAGED_INSTALLATION = chrome.runtime.getManifest?.()?.background?.service_worker === 'bootstrap/background.js'
    || root.__CODEX_OVERLEAF_RUNTIME_PREFIX__ === 'runtime/';
  const INSTALL_COMMAND = MANAGED_INSTALLATION ? '' : CodexOverleafCompatibility?.buildInstallCommand?.(
    undefined,
    undefined,
    getCurrentExtensionId()
  ) || 'curl -fsSL https://raw.githubusercontent.com/Ghqqqq/codex-overleaf-link/main/install.sh | bash -s -- --extension-id <chrome-extension-id>';
  const pageBridgeClient = Modules.PageBridgeClient.create({
    root,
    window,
    document,
    chromeApi: chrome,
    crypto,
    contract: PageRpcContract,
    compatibility: CodexOverleafCompatibility,
    isCancellationRequested: () => runCancellationRequested
  });
  pageBridgeClient.start();
  const {
    createSession,
    deleteSession,
    deriveSessionTitle,
    getActiveSession,
    isDisplayableSession,
    normalizePanelState,
    prepareStateForStorage,
    recordSessionResult,
    selectVisibleSessionsForList,
    setActiveSession,
    updateActiveSession,
    updateActiveSessionDraft
  } = Modules.SessionState;
  const LineReferences = Modules.LineReferences;
  const { getProjectStorageKey } = Modules.StorageKeys;
  const { HIGH_RISK_TYPES, buildChangeSummaryLine, hasSkippedApplyOperations } = Modules.Summary;
  const {
    buildExpectedFilesAfterOperations,
    buildSnapshotRestoreUndo,
    buildCreatedFileUndoCheckpoint,
    buildUndoCheckpoint
  } = Modules.UndoOperations;
  const { buildHumanCompletionReport, mapAgentEventToActivity, stripEmptyHtmlCommentPlaceholders,
    translateRawError } = Modules.AgentTranscript;
  const i18n = Modules.I18n;
  const nativeChannel = Modules.NativeChannel.create({
    chrome,
    crypto
  });
  const writebackController = Modules.WritebackController;
  const ReviewHunks = Modules.ReviewHunks;
  const DiffReviewPanel = Modules.DiffReviewPanel;
  const ContextTray = Modules.ContextTray;
  const LocalSkillsPanel = Modules.LocalSkillsPanel;
  const runController = Modules.RunController;
  const RunInputQueue = Modules.RunInputQueue;
  const RunQueueScheduler = Modules.RunQueueScheduler;
  const ActiveTurnControl = Modules.ActiveTurnControl;
  const PendingInputView = Modules.PendingInputView;
  const mirrorHealth = Modules.MirrorHealth;
  const otWarmMirrorController = Modules.OtWarmMirrorController;
  const PanelRenderer = Modules.PanelRenderer;
  const SessionPanel = Modules.SessionPanel;
  const SettingsPanel = Modules.SettingsPanel;
  const DiagnosticsPanel = Modules.DiagnosticsPanel;
  const ComposerPanel = Modules.ComposerPanel;
  const GovernanceRules = Modules.GovernanceRules;
  const SensitiveScan = Modules.SensitiveScan;
  const AuditRecords = Modules.AuditRecords;
  const FailureReasons = Modules.FailureReasons;
  const RunExecutionSnapshot = Modules.RunExecutionSnapshot;
  const WritebackSettlement = Modules.WritebackSettlement;

  // Module composition (hoisted-safe zone). These wiring blocks MUST run
  // before any controller below consumes their destructured exports by
  // value (v1.5.1 regression fix: the v1.4.6-v1.5.0 carves left them after
  // the controller creations, so init() died in the TDZ and the panel never
  // mounted). Function declarations hoist; mutable state is passed as lazy
  // getters; the four shared consts above the wiring are passed by value.
  // The three stable trackedChangeStatus values are `pending`, `accepted`, and
  // `rejected`; `accepted` and `rejected` are terminal. Kept in sync with
  // sessionState.js. A run is in the tracked-change lifecycle when it carries
  // one of these values or still holds tracked-change refs.

  // The UI-local in-flight lock for tracked-change accept/reject. Never written
  // to trackedChangeStatus and never persisted — it lives only on the controller.
  const trackedChangeInFlight = new Map();

  // Reserved sub-routes under /project that are NOT project editor URLs.
  // The 24-hex regex already excludes them, but this is a belt-and-suspenders
  // guard in case Overleaf ever introduces non-ObjectId sub-routes that bypass
  // the regex.
  const PROJECT_EDITOR_RESERVED_IDS = new Set(['new', 'upload', 'import']);

  // Status-badge palette is governed by spec §5.10 — ten values mapped to
  // CSS classes that reuse the per-project run-card palette tokens.
  const STATUS_BADGE_CLASS = {
    pending: 'badge-pending',
    accepted: 'badge-accepted',
    rejected: 'badge-rejected',
    needs_review: 'badge-needs-review',
    running: 'badge-running',
    completed: 'badge-completed',
    failed: 'badge-failed',
    background_completed: 'badge-background-completed',
    needs_review_after_navigation: 'badge-needs-review-after-navigation',
    abandoned_after_navigation: 'badge-abandoned-after-navigation',
    interrupted: 'badge-interrupted',
    stale: 'badge-stale'
  };

  // Carved modules (v1.4.5 structural-debt phase 1). Factory-injected with the
  // runtime collaborators they need; the destructured consts keep every
  // existing call site unchanged. Function declarations hoist, so passing them
  // here is safe; mutable state is handed over as lazy getters.
  const markdownText = Modules.MarkdownText.create({
    LineReferences: Modules.LineReferences,
    MathText: Modules.MathText,
    tx,
    callPageBridge,
    getCurrentProjectId,
    getCurrentProjectReferenceFiles,
    getCurrentProjectMathSources,
    showPluginToast,
    recordRenderingDiagnostic: detail => appendTechnicalEvent({ type: 'rendering.diagnostic', detail })
  });
  const {
    renderMarkdownInlineText,
    renderMarkdownBlockText,
    sanitizeAssistantVisibleText,
    sanitizeAssistantVisibleValue,
    buildMarkdownInlineNodes,
    normalizeReferencePathForRuntime,
    hasUnsafeRuntimePathSegments
  } = markdownText;

  const projectSettingsCoordinator = Modules.ProjectSettingsCoordinator.create({
    CodexOverleafTheme: Modules.Theme,
    GovernanceRules,
    SettingsPanel,
    closeContextTray: () => closeContextTray(),
    closeDiagnosticsMenu: () => closeDiagnosticsMenu(),
    closeDiagnosticsResult: () => closeDiagnosticsResult(),
    closeModelConfigPopover: () => closeModelConfigPopover(),
    closeSlashMenu: () => closeSlashMenu(),
    getCurrentProjectId: () => getCurrentProjectId(),
    getLocalSkillsPanel: () => localSkillsPanel,
    getCodexLocalSkills: () => getCodexLocalSkillsCatalog(),
    onSkillsChange: () => updateSlashMenuForTaskInput(),
    getLocale: () => getLocale(),
    getPanel: () => panel,
    getPanelRendererInstance: () => panelRendererInstance,
    getSettingsPanelInstance: () => settingsPanelInstance,
    getState: () => state,
    isProjectEditorRoute,
    refreshStorageUsageSummary: () => refreshStorageUsageSummary(),
    renderAuditHistoryPanel: () => renderAuditHistoryPanel(),
    renderRecentProjectsVariant: (...args) => renderRecentProjectsVariant(...args),
    saveStateSoon: delay => saveStateSoon(delay),
    updateGlobalPreferences: patch => getGlobalPreferences().update(patch),
    setState: next => { state = next; },
    tr,
    tx,
    window
  });
  const {
    applyPanelTheme,
    clearProjectSettingsStatus,
    closeCustomInstructionsSettings,
    closeSkillsView,
    getCodexOverleafSkillEnabled,
    getCodexLocalSkillEnabled,
    isCodexLocalSkillEnabled,
    setCodexLocalSkillEnabled,
    getCustomInstructionsForCurrentProject,
    getGovernanceRulesForCurrentProject,
    getSkillLoadingSettings,
    getThemePreference,
    isCodexOverleafSkillEnabled,
    normalizeCustomInstructionsByProject,
    normalizeGovernanceRules,
    normalizeGovernanceRulesByProject,
    normalizeProjectPreferenceKey,
    openCustomInstructionsSettings,
    openSkillsView,
    readGovernanceRulesFromSettings,
    readSkillLoadingSettingsFromSettings,
    refreshLocalSkills,
    renderLocalSkillList,
    setCodexOverleafSkillEnabled,
    setCustomInstructionsForProject,
    setGovernanceRulesForCurrentProject,
    setProjectSettingsStatus,
    setSkillLoadingSettings,
    syncCustomInstructionsEditorForProject,
    syncProjectSettingsEditorForProject,
    toggleCustomInstructionsSettings,
    updateSkillsEntrySummary
  } = projectSettingsCoordinator;

  const otWarmMirror = Modules.OtWarmMirror.create({
    otWarmMirrorController,
    runController,
    mirrorHealth,
    projectFiles: Modules.ProjectFiles,
    tr,
    tx,
    closeDiagnosticsMenu,
    syncCustomInstructionsEditorForProject,
    throwIfRunCancellationRequested,
    showPluginConfirm,
    showPluginToast,
    getCurrentProjectId,
    updateProbeStatusOtSuffix,
    sanitizeRunProjectSnapshot,
    getMirrorFreshness,
    buildSnapshotFileOverlays,
    normalizeSnapshotPath,
    formatProjectSnapshotUserLog,
    formatProjectSnapshotWarning,
    getProjectSnapshotWarnings,
    sendBackgroundNative,
    callPageBridge,
    saveStateSoon,
    finishRunView,
    appendRunEvent,
    appendCompletionReport,
    appendLog,
    appendPlainLog,
    getPanel: () => panel,
    getState: () => state,
    setState: next => { state = next; },
    getCurrentRunView: () => currentRunView,
    RUN_SNAPSHOT_ZIP_TIMEOUT_MS
  });
  const {
    getCurrentOtStatus,
    getOtWarmMirrorState,
    getLastExperimentalOtProjectId,
    clearMirrorPrefetchTimer,
    releaseOtWarmMirrorProject,
    isExperimentalOtEnabled,
    setExperimentalOtEnabledForProject,
    normalizeExperimentalOtByProject,
    syncExperimentalOtToggleForProject,
    handleExperimentalOtToggleClick,
    handleExperimentalOtToggleKeydown,
    handleExperimentalOtToggleChange,
    syncOtWarmMirrorController,
    readOtBridgeStatus,
    clearOtEventPolling,
    canPollOtWarmMirror,
    pauseOtWarmMirror,
    resumeOtWarmMirror,
    updateOtStatusDisplay,
    formatOtStatusLabel,
    updateExperimentalOtMenuStatus,
    normalizeOtStatus,
    scheduleMirrorPrefetch,
    settleMirrorPrefetchBeforeRun,
    resolveWarmRunStart,
    prepareMirrorStaleRetry
  } = otWarmMirror;

  const diagnosticsController = Modules.DiagnosticsController.create({
    Compatibility: Modules.Compatibility,
    tr,
    tx,
    getExtensionCompatibilityMetadata,
    showDiagnosticsLoading,
    showDiagnosticsResult,
    setDiagnosticsHealth,
    sendBackgroundNative,
    callPageBridge,
    getState: () => state,
    getCurrentOtStatus,
    getOtWarmMirrorState,
    otWarmMirrorController,
    getActiveFocusFiles,
    getCurrentProjectId,
    getScope: () => ({ accountScopeId: cachedAccountScopeId, projectId: getCurrentProjectId(), generation: spaRouteGeneration }),
    isExperimentalOtEnabled,
    readOtBridgeStatus,
    formatOtStatusLabel,
    normalizeOtStatus,
    formatProbeStatusBar,
    getProbeRunReadiness,
    getMirrorFreshness,
    formatProjectSnapshotLog,
    formatProjectSnapshotWarning,
    getProjectSnapshotWarnings,
    isTextSnapshotFile,
    INSTALL_COMMAND,
    RUN_SNAPSHOT_ZIP_TIMEOUT_MS
  });
  const {
    runAllDiagnostics,
    inspectProjectSnapshot,
    inspectNativeEnvironment,
    inspectPageStateDiagnostics,
    inspectOtWarmMirrorDiagnostics,
    fallbackNativeCompatibility,
    getNativeCompatibilityClassification,
    isNativeCompatibilityCompatible
  } = diagnosticsController;

  // Panel maintenance — carved to panelMaintenance.js in v1.8.0 (phase 8):
  // recovery-action handlers, change-history read path, history & storage
  // card, aggressive-compaction notice. Instantiated BEFORE runTimelineView,
  // whose deps reference the recovery handlers.
  const panelMaintenance = Modules.PanelMaintenance.create({
    StorageDb: Modules.StorageDb,
    ChangeHistoryView: Modules.ChangeHistoryView,
    getAccountScopeId: () => cachedAccountScopeId || '',
    sanitizeText: sanitizeAssistantVisibleText,
    tx,
    showPluginToast: (...args) => showPluginToast(...args),
    showPluginConfirm: (...args) => showPluginConfirm(...args),
    callPageBridge: (...args) => callPageBridge(...args),
    getCurrentProjectId: () => getCurrentProjectId(),
    saveState: (...args) => saveState(...args),
    saveStateSoon: () => saveStateSoon(),
    autosizeTaskTextarea: () => autosizeTaskTextarea(),
    syncComposerSendAvailability: () => syncComposerSendAvailability(),
    applyStateToPanel: () => applyStateToPanel(),
    normalizePanelState,
    openCustomInstructionsSettings: () => openCustomInstructionsSettings(),
    onHistoryRowJump: record => jumpToHistoryRun(record),
    resetProjectNameCache: () => recentProjects.resetProjectNameCache(),
    clearHistoryComposer: () => {
      pendingRetryReplacement = null;
      clearTaskComposer();
      persistComposerAttachmentsToState();
    },
    getPanel: () => panel,
    getState: () => state,
    setState: next => {
      if (next.activeSessionId !== state?.activeSessionId) composerDraftEditedHere = false;
      state = next;
    },
    getCurrentRunView: () => currentRunView,
    getSettingsPanelInstance: () => settingsPanelInstance,
    prepareRetryReplacement: (run, task) => prepareRetryReplacement(run, task)
  });
  const {
    showUndoFileSelection,
    openChangeHistory,
    renderAuditHistoryPanel,
    applyAuditHistoryFilter,
    refreshStorageUsageSummary,
    clearAllHistoryWithConfirm,
    notifyAggressiveCompactionOnce,
    refillComposerForRetry,
    openProjectFileForFailure,
    openStorageSettings
  } = panelMaintenance;

  const sessionForkController = Modules.SessionForkController.create({
    SessionState: Modules.SessionState,
    getState: () => state,
    setState: next => {
      if (next.activeSessionId !== state?.activeSessionId) composerDraftEditedHere = false;
      state = next;
    },
    getScope: () => ({ accountScopeId: cachedAccountScopeId, projectId: getCurrentProjectId(), generation: spaRouteGeneration }),
    sendBackgroundNative, saveState,
    getEnabledCodexLocalSkillIds: () => getEnabledCodexLocalSkillIds(),
    captureLocalSkillIdsForFork: async preferences => {
      if (preferences.loadCodexLocalSkills === false) return [];
      const choices = { ...preferences.codexLocalSkillEnabled };
      const skills = await primeCodexLocalSkillsCatalog({ required: true });
      return skills.filter(skill => Object.hasOwn(choices, skill.id) ? choices[skill.id] !== false : skill.enabled !== false).map(skill => skill.id);
    },
    applyStateToPanel,
    showPluginToast,
    tr
  });
  const runResultActions = Modules.RunResultActions.create({
    tr,
    forkRunFromNode: sessionForkController.forkRunFromNode
  });
  const runTimelineView = Modules.RunTimelineView.create({
    RunActivitySummary: Modules.RunActivitySummary,
    RunPresence: Modules.RunPresence,
    PanelIcons: Modules.PanelIcons,
    // recentProjects is composed below; the empty state only reads it after startup.
    getProjectName: () => { try { return recentProjects.readCurrentProjectNameFromDom(); } catch { return ''; } },
    RunActivityModel: Modules.RunActivityModel,
    SubagentActivityView: Modules.SubagentActivityView,
    RunGuidanceView: Modules.RunGuidanceView,
    getPendingGuidance: run => runGuidanceController.getPending(run),
    RunResultActions: runResultActions,
    RunScrollLayout: Modules.RunScrollLayout,
    RunFailureNotice: Modules.RunFailureNotice,
    I18n: i18n,
    FailureReasons,
    projectContextLimitEvent: event => Modules.AgentTranscript.projectContextLimitEvent(event, getLocale()),
    localizeVisibleReason: value => localizeVisibleReason(value),
    localizeCompileReason: value => Modules.CompileAdapter.localizeCompileReason(value, getLocale()),
    tr,
    tx,
    getLocale,
    formatElapsed,
    findRunRecord,
    forceCancelStuckTaskForCurrentProject,
    formatEventDetail,
    formatEventTime,
    renderAttachmentPreviewList,
    renderSentSelection: Modules.SelectionContextView.renderSent,
    formatModeLabel,
    undoRun,
    acceptRun,
    getRunUndoCount,
    cssEscape,
    renderMarkdownInlineText,
    renderMarkdownBlockText,
    decorateCompletionReport: (container, options) => Modules.MarkdownDomRenderer.decorateCompletionReport(container,
      { ...options, formatOperationType }),
    sanitizeAssistantVisibleText,
    sanitizeAssistantVisibleValue,
    buildMarkdownInlineNodes,
    getPanel: () => panel,
    getState: () => state,
    getCurrentRunView: () => currentRunView,
    refillComposerForRetry,
    canEditRun: run => runController.isRetryReplacementEligible(run, WritebackSettlement.projectRunSettlement(run)),
    retryWriteback: retryRunWriteback,
    getCurrentProjectId,
    getAccountScopeId: () => cachedAccountScopeId,
    showNativeSetupGuidance: () => showNativeUpdateGuidanceModal({}),
    openProjectFileForFailure,
    openStorageSettings,
    trackedChangeInFlight,
    projectRunSettlement: run => WritebackSettlement.projectRunSettlement(run)
  });
  const {
    resetAutoFollow,
    bindLogAutoFollow,
    bumpUnreadIfDetached,
    scrollLogToBottom,
    collapseRunProcess,
    startRunElapsedTick,
    stopRunElapsedTick,
    formatProcessedSummary,
    renderRunHistory,
    renderRunCard,
    getRunStatusText,
    renderRunEvent,
    upsertStreamEvent,
    renderCompletionReport,
    isTrackedChangeLifecycleRun,
    configureEditButton,
    configureWritebackButton,
    configureUndoButton,
    configureAcceptButton
  } = runTimelineView;

  const sessionManager = Modules.SessionManager.create({
    SessionPanel: Modules.SessionPanel,
    SessionState: Modules.SessionState,
    SessionMenuView: Modules.SessionMenuView,
    PanelIcons: Modules.PanelIcons,
    tr,
    showPluginConfirm,
    showPluginToast,
    sendBackgroundNative,
    saveState,
    saveStateSoon,
    readPanelInputs,
    flushComposerDraft: () => flushComposerDraft({ requireDurable: true }),
    setSessionTransition: pending => {
      if (pending) {
        closeSlashMenu();
        contextUsageView?.close();
      }
      const ready = composerPanelInstance?.setSessionTransition(pending);
      syncComposerSendAvailability();
      if (!pending && deferredSessionStart) {
        const deferred = deferredSessionStart;
        deferredSessionStart = null;
        if (deferred.scope === getComposerDraftScope()) runQueueScheduler?.scheduleOne(deferred.sessionId);
      }
      return ready;
    },
    getDraftScope: getComposerDraftScope,
    applyStateToPanel, syncSessionProvider: () => providerSettingsCoordinator.syncSessionProvider(),
    getPanel: () => panel,
    getState: () => state,
    setState: next => {
      if (next.activeSessionId !== state?.activeSessionId) composerDraftEditedHere = false;
      state = next;
    },
    getSessionPanelInstance: () => sessionPanelInstance,
    formatSessionTime
  });
  const {
    closeSessionMenu,
    applySessionLabel,
    bindActiveSessionHeader,
    startNewSession,
    switchSession,
    deleteSessionWithConfirm,
    renderSessionList,
    commitSessionRename,
    getRunningSessionIds,
    isSessionRunning,
    findSessionById,
    replaceSessionInState,
    updateSessionById
  } = sessionManager;

  const applyResultFormatters = Modules.ApplyResultFormatters.create({
    i18n: Modules.I18n,
    FailureReasons: Modules.FailureReasons,
    getLocale,
    tr,
    tx,
    getAppliedEntries,
    getSkippedEntries,
    appendRunEvent
  });
  const {
    appendApplyResult,
    failureReasonI18nLookup,
    formatApplyResultReason,
    formatBridgeResultReason,
    localizeVisibleReason,
    formatOperationType,
    formatOperationFiles
  } = applyResultFormatters;

  const runSettlementPersistence = Modules.RunSettlementPersistence.create({
    writebackSettlement: WritebackSettlement,
    getCurrentRunView: () => currentRunView,
    findRunRecord,
    getCurrentProjectId,
    saveStateSoon
  });

  // v1.6.3 structural-debt phase 6: the sync-writeback orchestration
  // (applySyncChangesToOverleaf + post-write verify/mirror/compile pipeline)
  // lives in writebackOrchestrator.js. Every dep below is either a hoisted
  // function declaration, an already-initialized const above, or a lazy
  // accessor thunk — safe in the top-of-init() wiring zone.
  const selectionContextView = Modules.SelectionContextView.create({
    getPanel: () => panel,
    getState: () => state,
    getProjectId: getCurrentProjectId,
    openComposer: () => ensurePanelOpen(),
    setSelection: (value, options = {}) => {
      if (options.edit && panel?.querySelector('[data-task]')) readPanelInputs();
      state = updateActiveSession(state, {
        selectionContext: value,
        ...(options.edit ? { mode: 'auto' } : {})
      });
      syncProbeStatus();
      if (options.edit && panel) {
        const modeInput = panel.querySelector('[data-mode]');
        if (modeInput) modeInput.value = 'auto';
        syncModeControls();
      }
      saveStateSoon();
    },
    callPageBridge, tx, toast: showPluginToast
  });
  selectionContextView.start();
  const writingStyleSettings = Modules.WritingStyleSettings.create({
    tx,
    getScope: () => {
      const projectId = getCurrentProjectId();
      return cachedAccountScopeId && projectId ? { accountScopeId: cachedAccountScopeId, projectId } : null;
    },
    request: sendBackgroundNative,
    getReferenceSnapshot: async (projectId, requestId) => {
      const result = await callPageBridge('getReferenceProjectSnapshot', { projectId, requestId });
      if (!result?.ok) throw Object.assign(new Error(result?.error || result?.reason || tx(
        'The reference project could not be read.', '参考项目未能读取。')), { code: result?.code });
      return result;
    },
    cancelReferenceRead: async requestId => {
      const result = await callPageBridge('cancelReferenceRead', { requestId });
      if (!result?.ok) throw new Error(result?.error || tx('The reference read could not be cancelled.', '参考资料读取未能取消。'));
      return result;
    },
    isRunning: () => Boolean(currentRunView),
    listProjects: async () => {
      const result = await callPageBridge('listReferenceProjects', {});
      if (!result?.ok) throw new Error(result?.error || tx(
        'The Overleaf project directory could not be loaded.', 'Overleaf 项目目录未能加载。'));
      return result.projects;
    },
    getModelSettings: async () => {
      await providerSettingsCoordinator.ensureLoaded();
      if (panel?.querySelector('[data-task]')) readPanelInputs();
      return {
        model: state.model,
        reasoningEffort: state.reasoningEffort,
        speedTier: state.speedTier,
        providerSelection: providerSettingsCoordinator.getRunSelection(state.providerId || 'builtin'),
        locale: getLocale()
      };
    },
    preflightProjectReferences: ({ project, assertCurrent }) => {
      assertCurrent();
      return Modules.SensitivePreflight.create({
        SensitiveScan, normalizeGovernanceRules, isTextSnapshotFile, getCurrentProjectId,
        appendRunEvent: () => {}, appendCompletionReport: () => {},
        showPluginConfirm, tr, tx
      }).run({ task: '', project, rules: getGovernanceRulesForCurrentProject(), assertCurrent });
    },
    startBuild: async params => {
      const gate = await nativeCompatibilityController.ensureForMethod('codex.run');
      if (!gate.ok) throw new Error(gate.response?.error?.message || 'Native host update required.');
      const id = crypto.randomUUID();
      const promise = nativeChannel.sendBackgroundNative(nativeCompatibilityController.attachEvidence({
        id, method: 'codex.run', params
      }, gate.compatibility));
      return { id, promise };
    }
  });
  const assetTransferBroker = Modules.AssetTransferBroker.create({ callPageBridge, sendBackgroundNative });
  const { partitionUnsafeProjectPathOperations, normalizeOperationProjectPaths, getInvalidOperationProjectPath,
    evaluateGovernedOperations, buildGovernanceSkippedApplyResult, filterSyncChangesByOperations, mergeApplyResultSkipped,
    confirmBinaryOperations, buildAuditSummaryFromApply, summarizeOperationForAudit } = Modules.WritebackPlan.create({
    tx, tr, normalizeSafeProjectPath, GovernanceRules, getGovernanceRulesForCurrentProject,
    showPluginConfirm, formatOperationFiles, getAppliedEntries, getSkippedEntries
  });
  const writebackOrchestrator = Modules.WritebackOrchestrator.create({
    tr,
    tx,
    getLocale,
    appendRunEvent,
    appendChangeSummary,
    appendCompletionReport,
    appendOperationsPreview,
    appendPartialWritebackWarning,
    appendApplyResult,
    renderReadOnlyDiffReview,
    showPluginConfirm,
    callPageBridge,
    sendBackgroundNative,
    getCurrentProjectId,
    resetContextProject,
    sanitizeRunProjectSnapshot,
    getAssistantAnswerForCurrentRun,
    cleanFinalAnswer,
    recordUndoFromApply,
    getSkippedEntries,
    getAppliedOperationPaths,
    hasApplyResultEntries,
    getAppliedSyncChanges,
    mergeApplyResultSkipped,
    hasSkippedApplyOperations,
    formatWritebackSkippedNextStep,
    formatOperationFiles,
    summarizeOperationForAudit,
    buildAuditSummaryFromApply,
    buildSyncApplyOperations,
    partitionUnsafeProjectPathOperations,
    evaluateGovernedOperations,
    buildGovernanceSkippedApplyResult,
    buildReviewingBlockedApplyResult,
    ensureReviewingBeforeWrite,
    confirmBinaryOperations,
    filterSyncChangesByOperations,
    writebackController,
    assetTransferBroker,
    stageWritebackRecovery,
    settleWritebackRecovery,
    writebackSettlement: WritebackSettlement,
    compileAdapter: Modules.CompileAdapter,
    RUN_SNAPSHOT_ZIP_TIMEOUT_MS,
    getState: () => state,
    getCurrentRunView: () => currentRunView,
    appendRunRecordEvent,
    onMirrorRefreshSettled: runSettlementPersistence.settleMirrorRefresh
  });
  const {
    applySyncChangesToOverleaf,
    resolveCompileLogContext,
    getPendingMirrorRefresh
  } = writebackOrchestrator;

  // Cross-tab awareness (v1.7.5, coarse): warn when another tab starts a run
  // on the same project. Same-origin channel; payloads carry only ids.
  let crossTabRunChannel = null;
  try {
    crossTabRunChannel = new BroadcastChannel('codex-overleaf-runs');
    crossTabRunChannel.addEventListener('message', event => {
      const data = event?.data;
      if (!data || data.type !== 'run-started') {
        return;
      }
      if (data.projectId && data.projectId === getCurrentProjectId()) {
        showPluginToast(tx(
          'Another tab just started a Codex run on this project \u2014 avoid running here at the same time.',
          '另一个标签页刚在本项目启动了 Codex 任务——请避免同时在这里运行。'
        ));
      }
      // Dashboard tabs re-render on any cross-tab run signal so badges and
      // recency stay honest (v1.8.1).
      refreshDashboardSoon();
    });
  } catch (error) {
    // BroadcastChannel unavailable — cross-tab hints stay off.
  }
  function announceCrossTabRunStart() {
    try {
      crossTabRunChannel?.postMessage({ type: 'run-started', projectId: getCurrentProjectId(), at: Date.now() });
    } catch (error) {
      // Channel closed mid-navigation; the hint is best-effort.
    }
  }

  const modelPicker = Modules.ModelPicker.create({
    Support: Modules.ModelPickerSupport,
    tr,
    tx,
    getLocale,
    sendBackgroundNative, getProviderSelection: () => providerSettingsCoordinator.getRunSelection(state?.providerId)
      || { providerId: state?.providerId || 'builtin', providerRevision: 0 },
    readSelectedSpeedInput,
    getRenderedModelEntries,
    onSelectionRendered: renderContextUsage,
    persistPanelInputs,
    closeDiagnosticsMenu,
    closeCustomInstructionsSettings,
    closeContextTray,
    closeSlashMenu,
    getPanel: () => panel,
    getState: () => state
  });
  const {
    getModelDiscovery,
    toggleModelConfigPopover,
    closeModelConfigPopover,
    handleModelConfigChoiceClick,
    loadModelOptions,
    applyFallbackModelOptions,
    getModelCatalog,
    renderModelOptions,
    renderReasoningOptions,
    renderSpeedOptions,
    renderModelConfigChoices,
    resolveSelectedModel,
    normalizeModelOptionId,
    updateModelDisplay
  } = modelPicker;

  const projectProviderSelection = Modules.ProjectProviderSelection.create({
    tx, tr, getRunningSessionIds, showToast: showPluginToast, showConfirm: showPluginConfirm,
    getState: () => state, setState: next => { state = next; }, getPanel: () => panel,
    readSelectedModel: readSelectedModelInput, readSelectedSpeed: readSelectedSpeedInput,
    getRunSelection: providerId => providerSettingsCoordinator.getRunSelection(providerId),
    normalizeState: normalizePanelState, applyStateToPanel
  });

  const providerSettingsCoordinator = Modules.ProviderSettingsCoordinator.create({
    ProviderProfiles: Modules.ProviderProfiles,
    ProviderSettingsDialog: Modules.ProviderSettingsDialog,
    hasCurrentProject: () => Boolean(getCurrentProjectId()),
    tx,
    sendBackgroundNative,
    document,
    window,
    getSettingsPanelInstance: () => settingsPanelInstance,
    getSelectedModel: () => state?.model || '', getSelectedProviderId: () => state?.providerId || 'builtin',
    getSelectedProviderRevision: () => state?.providerRevision,
    setSelectedProviderId: projectProviderSelection.commit,
    confirmProviderSwitch: projectProviderSelection.confirmSwitch,
    assertProviderSwitchAllowed: projectProviderSelection.assertSwitchAllowed,
    refreshModelOptions: loadModelOptions, persistInputs: persistPanelInputs
  });
  // v1.8.1 D3: the dashboard was a one-shot render — another tab finishing a
  // run, clearing history or creating sessions never showed up. Refresh it
  // (debounced) when the tab regains visibility or a cross-tab run signal
  // arrives while the dashboard view is active.
  let dashboardRefreshTimer = null;
  function refreshDashboardSoon() {
    if (panel?.dataset.view !== 'recent-projects') {
      return;
    }
    clearTimeout(dashboardRefreshTimer);
    dashboardRefreshTimer = setTimeout(() => {
      if (panel?.dataset.view !== 'recent-projects') {
        return;
      }
      // Never clobber an in-progress inline rename (fleet P2) — retry later.
      if (panel.querySelector('.recent-projects-session-rename-input')) {
        refreshDashboardSoon();
        return;
      }
      // Preserve what the user has open: expanded projects + scroll.
      const expanded = Array.from(panel.querySelectorAll('[data-project-row-wrap][data-expanded="true"]'))
        .map(wrap => wrap.getAttribute('data-project-row-wrap'))
        .filter(Boolean);
      const rootEl = panel.querySelector('[data-recent-projects-root]');
      recentProjects.renderRecentProjectsVariant({
        restoreExpanded: expanded,
        restoreScrollTop: rootEl ? rootEl.scrollTop : undefined
      }).catch(() => { /* keep last render */ });
    }, 400);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshDashboardSoon();
    } else {
      flushComposerDraftOnLeave();
    }
  });
  window.addEventListener('pagehide', flushComposerDraftOnLeave);

  const recentProjects = Modules.RecentProjects.create({
    ProjectSessionCleanup: Modules.ProjectSessionCleanup,
    SessionPersistence: Modules.SessionPersistence,
    SessionState: Modules.SessionState,
    StorageDb: Modules.StorageDb,
    StorageKeys: Modules.StorageKeys,
    StorageMigration: Modules.StorageMigration,
    tr,
    tx,
    openCustomInstructionsSettings,
    enterProject,
    applyStateToPanel,
    getPanel: () => panel,
    getCachedAccountScopeId: () => cachedAccountScopeId,
    refreshAccountScopeId: () => refreshAccountScopeId(),
    showPluginConfirm,
    showPluginToast,
    sendBackgroundNative,
    PANEL_STATE_BASE_KEY: LEGACY_STORAGE_KEY,
    PROJECT_EDITOR_RESERVED_IDS,
    STATUS_BADGE_CLASS
  });
  const {
    loadProjectNameCacheFromStorage,
    rememberCurrentProjectName,
    formatRelativeTime,
    textNode,
    renderStatusBadge,
    isValidProjectId,
    openProjectFromRow,
    renderRecentProjectRow,
    renderRecentProjectsVariant,
    renderPerProjectVariant
  } = recentProjects;
  const MAX_COMPOSER_ATTACHMENT_BYTES = 12 * 1024 * 1024;
  const MAX_COMPOSER_ATTACHMENT_TOTAL_BYTES = 32 * 1024 * 1024;
  const MAX_COMPOSER_ATTACHMENTS = 8;
  const MAX_ATTACHMENT_PREVIEW_DATA_URL_CHARS = 768 * 1024;
  const composerAttachmentController = Modules.ComposerAttachments.createComposerAttachmentController({
    getPanel: () => panel,
    icons: Modules.PanelIcons,
    tr,
    tx,
    appendPlainLog,
    onChange: () => getComposerDraftPersistence().changed(),
    limits: {
      maxAttachmentBytes: MAX_COMPOSER_ATTACHMENT_BYTES,
      maxAttachmentTotalBytes: MAX_COMPOSER_ATTACHMENT_TOTAL_BYTES,
      maxAttachments: MAX_COMPOSER_ATTACHMENTS,
      maxPreviewDataUrlChars: MAX_ATTACHMENT_PREVIEW_DATA_URL_CHARS
    }
  });
  const diffReviewPanel = DiffReviewPanel.createDiffReviewPanelController({
    root: window,
    document,
    reviewHunks: ReviewHunks,
    tr,
    callPageBridge,
    getCurrentProjectId: () => getCurrentProjectId(),
    getRunEvents: () => currentRunView?.events,
    appendRunEvent,
    scrollLogToBottom,
    renderWrittenChanges: changes => Modules.WrittenChangesView.render(changes, { document, tx }),
    onRejectedHunks: summaries => {
      if (currentRunView && Array.isArray(summaries) && summaries.length) {
        currentRunView.rejectedHunks = summaries;
      }
    }
  });
  const contextTrayController = ContextTray.createContextTrayController({
    root: window,
    icons: Modules.PanelIcons,
    document,
    getPanel: () => panel,
    getState: () => state,
    setState: nextState => {
      state = nextState;
      // Paint focus changes before ContextTray waits for durable persistence.
      syncProbeStatus();
    },
    saveState,
    saveStateSoon,
    onProjectFilesReady: refreshHistoricalProjectReferences,
    updateActiveSession,
    callPageBridge,
    getCurrentProjectId,
    tr,
    tx,
    closeModelConfigPopover,
    closeDiagnosticsMenu,
    closeCustomInstructionsSettings,
    closeSlashMenu,
    projectFiles: Modules.ProjectFiles
  });
  const localSkillsPanel = LocalSkillsPanel.createLocalSkillsPanelController({
    root: window,
    document,
    getPanel: () => panel,
    getState: () => state,
    setState: nextState => {
      state = nextState;
    },
    saveState,
    sendBackgroundNative,
    getCurrentProjectId,
    getScope: () => getCodexLocalSkillsCatalogScope(),
    getSkillLoadingSettings,
    isCodexOverleafSkillEnabled,
    setCodexOverleafSkillEnabled,
    isCodexLocalSkillEnabled,
    setCodexLocalSkillEnabled,
    getCodexLocalSkills: () => getCodexLocalSkillsCatalog(),
    getCodexLocalSkillWarnings: () => getCodexLocalSkillWarnings(),
    refreshCodexLocalSkills: options => primeCodexLocalSkillsCatalog(options),
    setProjectSettingsStatus,
    tr,
    tx,
    getComposerSkillInvocation: () => composerSkillInvocation,
    normalizeComposerSkillInvocation,
    clearComposerSkillInvocation,
    setSlashCodexOverleafSkills: skills => {
      slashCodexOverleafSkills = Array.isArray(skills) ? skills : [];
      slashCodexOverleafSkillsLoaded = true;
      // The settings-entry "N enabled" summary reads from state.codexOverleafSkills
      // which refreshLocalSkills() just populated; without this call the summary
      // stays at the stale "0 enabled" computed before the async list resolved.
      updateSkillsEntrySummary();
    },
    clearSlashCodexOverleafSkills: () => {
      slashCodexOverleafSkills = [];
      slashCodexOverleafSkillsLoaded = false;
      updateSkillsEntrySummary();
    }
  });

  let panel = null;
  let probeStatusSnapshot = null;
  let panelRendererInstance = null;
  let sessionPanelInstance = null;
  let settingsPanelInstance = null;
  let diagnosticsPanelInstance = null;
  let composerPanelInstance = null;
  let contextUsageView = null;
  let state = null;
  let storageKey = LEGACY_STORAGE_KEY;
  let globalPreferencesController = null;
  let currentRunView = null;
  let runSubmissionPending = false;
  let pendingRetryReplacement = null;
  let runQueueScheduler = null;
  let deferredSessionStart = null;
  let runInputCoordinator = null;
  const activeTurnControl = ActiveTurnControl.create({ chrome });
  let saveStateTimer = null;
  const DRAFT_SAVE_DELAY_MS = 800;
  const DRAFT_SAVE_MAX_WAIT_MS = 4000;
  let draftSaveTimer = null;
  let pendingDraftSave = null;
  // Two-phase saveState scheduling. `saveStateInFlight` flips to true while
  // an async saveState() is actually writing; `saveStateRunAfterFlight` is
  // set when a fresh saveStateSoon() fires during the in-flight phase. When
  // the in-flight save finishes, the trailing flag triggers ONE more save
  // so the final disk snapshot reflects the latest state. Without this,
  // a debounce timer cleared mid-write would let an older snapshot
  // (captured at the start of the in-flight save) be the last writer.
  let saveStateInFlight = false;
  let saveStateRunAfterFlight = false;
  let saveStateInFlightPromise = null;
  let pendingSaveStateOptions = null;
  let streamRenderTimer = null;
  let pendingStreamRenderEvents = new Map();
  let storageNoticeKeys = new Set();
  let composerSkillInvocation = null;
  let composerDraftRevision = 0;
  // Page-local provenance only; the draft itself stays shared per conversation.
  let composerDraftEditedHere = false;
  let slashCodexOverleafSkills = [];
  let slashCodexOverleafSkillsLoaded = false;
  let slashCodexOverleafSkillsLoading = false;
  let renderedSlashCommands = new Map();
  let runCancellationRequested = false;
  let runCancellationController = null;
  let pluginConfirmController = null;
  let scopedPersistenceCoordinator = null;
  const nativeCompatibilityController = Modules.NativeCompatibilityController.create({
    compatibility: CodexOverleafCompatibility,
    nativeChannel,
    gatedMethods: NATIVE_COMPATIBILITY_GATED_METHODS,
    getExtensionCompatibilityMetadata,
    fallbackNativeCompatibility,
    getNativeCompatibilityClassification,
    installCommand: INSTALL_COMMAND,
    throwIfCancellationRequested: throwIfRunCancellationRequested,
    getCurrentRunView: () => currentRunView,
    appendRunEvent,
    showPluginToast,
    getPanel: () => panel,
    ensurePanelOpen,
    getIconUrl: () => chrome.runtime.getURL('assets/icons/codex-overleaf-dialog-icon.png'),
    getPanelRendererInstance: () => panelRendererInstance,
    setBadge: (...args) => PanelRenderer.setBadge(...args),
    setDiagnosticsHealth,
    getState: () => state,
    localStorage: root.localStorage,
    document,
    navigator,
    chromeApi: chrome,
    onboardingTipStorageKey: ONBOARDING_TIP_STORAGE_KEY,
    setTimeout: (...args) => root.setTimeout(...args),
    tr,
    tx
  });
  const updateIdleClient = Modules.UpdateIdle?.create({
    document,
    getBusyState: () => ({
      run: Boolean(currentRunView),
      cancelling: runCancellationRequested,
      storage: saveStateInFlight || Boolean(saveStateTimer) || Boolean(pendingDraftSave),
      reviewAction: trackedChangeInFlight.size > 0,
      dialog: Boolean(pluginConfirmController?.isOpen())
    }),
    checkSaved: () => callPageBridge('waitForSaveState', { deadlineMs: 1500, pollIntervalMs: 100, requirePositiveSignal: true, allowQuietEditorFallback: true, quietFallbackMs: 1000 }),
    onApplyingChange: applying => { if (panel) panel.dataset.updating = applying ? 'true' : 'false'; },
    showToast: (...args) => showPluginToast(...args),
    getStateMessage: state => ({
      staged: tx('A verified update is ready and will install when Overleaf is idle.', '更新已验证，将在 Overleaf 空闲时自动安装。'),
      applying: tx('Updating Codex Overleaf Link now.', '正在更新 Codex Overleaf Link。'),
      committed: tx('Codex Overleaf Link was updated successfully.', 'Codex Overleaf Link 已成功更新。'),
      rolled_back: tx('The update failed its health check, so the previous version was restored.', '更新未通过健康检查，已自动恢复上一版本。')
    }[state] || '')
  });
  const diagnosticsExporter = Modules.DiagnosticsExport.create({
    root, window, document, Blob, URL, TextEncoder, AuditRecords, StorageDb: Modules.StorageDb,
    CodexOverleafCompatibility, getState: () => state, getCurrentRunView: () => currentRunView,
    getAccountScopeId: () => cachedAccountScopeId || '',
    getCurrentProjectId, findRunRecord, getMirrorFreshness, getExtensionCompatibilityMetadata,
    getModelDiscovery, getGovernanceRulesForCurrentProject, sendBackgroundNative,
    fallbackNativeCompatibility, isNativeCompatibilityCompatible, getNativeCompatibilityClassification,
    callPageBridge, showPluginToast, tr, RUN_SNAPSHOT_ZIP_TIMEOUT_MS
  });

  root[RUNTIME_INSTALLED_FLAG] = true;
  root[RUNTIME_STATE_KEY] = { ok: true, alreadyInstalled: false };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'codex-overleaf/runtime-health-probe') {
      sendResponse?.({
        ok: true, runOwnerProtocol: 2, runOwners: [activeTurnControl.getOwner()].filter(Boolean),
        version: CodexOverleafCompatibility?.BUILD_TARGET_VERSION || chrome.runtime.getManifest().version
      });
      return false;
    }
    if (updateIdleClient?.handleMessage(message, sendResponse)) {
      return true;
    }
    if (message?.type === 'codex-overleaf/open-panel') {
      ensurePanelOpen();
      sendResponse?.(getPanelStateResponse());
      return;
    }
    if (message?.type === 'codex-overleaf/get-panel-state') {
      sendResponse?.(getPanelStateResponse());
      return;
    }
    if (message?.type === 'codex-overleaf/toggle-launcher') {
      const visible = !PanelRenderer.isLauncherVisible(panelRendererInstance);
      PanelRenderer.setLauncherVisible(panelRendererInstance, visible, { persist: true });
      sendResponse?.(getPanelStateResponse());
      return;
    }
    if (message?.type === 'codex-overleaf/toggle-panel') {
      if (isPanelOpen()) {
        closePanel();
      } else {
        ensurePanelOpen();
      }
      sendResponse?.(getPanelStateResponse());
      return;
    }
    if (nativeChannel.handleBackgroundNativeEvent(message)) {
      return;
    }
    if (nativeChannel.shouldHandleNativeEvent(message)) {
      appendNativeEvent(message.event, message.journalSeq);
    }
  });

  diagnosticsExporter.exposeSmokeHelper();
  init().catch(error => {
    root[RUNTIME_STATE_KEY] = {
      ok: false,
      initFailed: true,
      alreadyInstalled: true,
      errorCode: 'async-init-failed',
      message: error?.message || String(error)
    };
    throw error;
  });

  function normalizeLoadedPanelState(input) {
    // Shared history may belong to a live run in another tab. Loading it is
    // read-only; only an owner-lost journal may mark that run interrupted.
    return normalizePanelState(getGlobalPreferences().overlay(input), {
      restoreRunningRuns: Modules.StorageDb.sharedSessionsEnabled?.() !== true, recoverSettledRuns: true
    });
  }

  async function init() {
    await getGlobalPreferences().initialize();
    await refreshAccountScopeId();
    storageKey = getProjectStorageKey(LEGACY_STORAGE_KEY, window.location.href);
    state = normalizeLoadedPanelState(await loadStoredState());
    composerDraftEditedHere = false;
    await getRunReviewController().recoverInterruptedUndoStatuses();
    initializeRunQueueScheduler();
    recoverInterruptedRunJournals()
      .then(() => applyStateToPanel())
      .catch(() => {});
    setTimeout(() => {
      recoverInterruptedRunJournals()
        .then(() => applyStateToPanel())
        .catch(() => {});
    }, 900);
    ensurePanelOpen();
    Modules.UpdateNotice?.mount?.(panel?.panelEl || panel, {
      getLocale: () => state?.locale || 'en'
    });
    // v1.8.1: on a non-editor route the panel must NEVER first paint the
    // per-project session UI (composer + probe line) and then swap — mount
    // the dashboard shell synchronously; the account-scope resolution below
    // fills the list in place.
    if (!isProjectEditorRoute(window.location)) {
      recentProjects.mountDashboardShell();
    }
    applyStateToPanel();
    getGlobalPreferences().refreshView();
    // Welcome-panel + write-guard: seed the lifecycle
    // module-locals from the current URL, install the SPA route hook so
    // future Overleaf navigations swap variants, and warm the account-scope
    // cache so the very first saveState sees a non-null scope when the
    // account chrome is already present.
    if (isProjectEditorRoute(window.location)) {
      activeProjectId = window.location.pathname.match(/^\/project\/([^/?#]+)/)[1];
    }
    lastSpaPathname = window.location.pathname;
    installSpaRouteHook();
    // Spec §5.6.3: warm the project-name cache mirror up front so the very
    // first Recent-projects render has names instead of `Project · <prefix>`.
    loadProjectNameCacheFromStorage().catch(() => { /* swallow */ });
    refreshAccountScopeId()
      .then(() => {
        // Welcome-panel + write-guard: if the user
        // landed on a non-project URL (e.g. /project), swap immediately into
        // the Recent-projects variant. Per-project mounts continue to render
        // through the existing applyStateToPanel path.
        if (!isProjectEditorRoute(window.location)) {
          renderRecentProjectsVariant().catch(() => { /* swallow */ });
        }
      })
      .catch(() => { /* fail-closed inside refreshAccountScopeId */ });
    providerSettingsCoordinator.syncSessionProvider().catch(() => {});
    syncOtWarmMirrorController().catch(error => {
      updateOtStatusDisplay('unavailable');
      appendPlainLog(tx(`Failed to sync OT warm mirror: ${error.message}`, `同步 OT 预热镜像失败：${error.message}`));
    });
    await refreshProbe({ quiet: true });
  }

  function getLocale() {
    return i18n?.normalizeLocale?.(state?.locale) || 'en';
  }

  function tr(key, params) {
    return i18n?.t?.(getLocale(), key, params) || key;
  }

  function tx(en, zh) {
    return getLocale() === 'zh' ? zh : en;
  }

  function getExtensionCompatibilityMetadata() {
    return {
      version: CodexOverleafCompatibility?.BUILD_TARGET_VERSION ||
        chrome.runtime.getManifest?.().version ||
        '',
      extensionId: getCurrentExtensionId(),
      installIdentity: { managed: MANAGED_INSTALLATION }
    };
  }

  function getCurrentExtensionId() {
    return typeof chrome === 'object' && chrome?.runtime?.id
      ? chrome.runtime.id
      : '';
  }





  function listSeparator() {
    return getLocale() === 'zh' ? '、' : ', ';
  }

  function ensurePanelOpen() {
    if (!panel) {
      panelRendererInstance = PanelRenderer.create({
        container: document.documentElement,
        defaultWidth: PANEL_DEFAULT_WIDTH,
        minWidth: PANEL_MIN_WIDTH,
        maxWidth: PANEL_MAX_WIDTH,
        pageMinWidth: PAGE_MIN_WIDTH,
        initialWidth: state?.panelWidth || PANEL_DEFAULT_WIDTH,
        chromeApi: chrome,
        launcherLabel: tx('Show or hide Codex panel', '显示或隐藏 Codex 边栏'),
        callbacks: {
          onLauncherToggle: () => ensurePanelOpen(),
          onClosePanel: () => closePanel(),
          onNewSession: () => startNewSession(),
          onChangeHistory: () => openChangeHistory(),
          onSettingsClick: () => toggleCustomInstructionsSettings(),
          onWidthChange: (width, options = {}) => {
            if (state) {
              state.panelWidth = width;
            }
            if (options.persist !== false) {
              saveStateSoon();
            }
          }
        }
      });
      panel = panelRendererInstance.panelEl;
      bindActiveSessionHeader();
      refreshNativeCompatibilityBadge();
      scheduleFirstUseOnboardingTip();

      diagnosticsPanelInstance = DiagnosticsPanel.create({
        container: panelRendererInstance.diagnosticsSlot,
        i18n: { tr },
        icons: Modules.PanelIcons,
        callbacks: {
          onRefresh: () => refreshProbe({ userInitiated: true }),
          onBeforeOpen: () => {
            closeModelConfigPopover();
            closeContextTray();
            closeCustomInstructionsSettings();
          },
          onRunAll: () => {
            closeDiagnosticsMenu();
            runAllDiagnostics();
          },
          onNativeEnvironment: () => {
            closeDiagnosticsMenu();
            inspectNativeEnvironment();
          },
          onPageState: () => {
            closeDiagnosticsMenu();
            inspectPageStateDiagnostics();
          },
          onSnapshot: () => {
            closeDiagnosticsMenu();
            inspectProjectSnapshot();
          },
          onOtDiagnostics: () => {
            closeDiagnosticsMenu();
            inspectOtWarmMirrorDiagnostics();
          },
          onExport: () => {
            closeDiagnosticsMenu();
            exportDiagnosticsBundle().catch(error => showPluginToast(tx(`Diagnostics export failed: ${error.message}`, `导出诊断信息失败：${error.message}`), { status: 'failed' }));
          }
        }
      });

      settingsPanelInstance = SettingsPanel.create({
        container: panelRendererInstance.settingsSlot,
        projectId: getCurrentProjectId(),
        i18n: { tr },
        button: panel.querySelector('[data-custom-instructions-settings]'),
        getProjectName: () => { try { return recentProjects.readCurrentProjectNameFromDom(); } catch { return ''; } },
        callbacks: {
          onBack: () => closeCustomInstructionsSettings(),
          onInputChange: event => persistPanelInputs(event),
          onSkillsOpen: () => openSkillsView(),
          onSkillsBack: () => closeSkillsView(),
          onProvidersOpen: () => providerSettingsCoordinator.open(),
          onClearAllHistory: () => clearAllHistoryWithConfirm(),
          onHistoryOpen: () => renderAuditHistoryPanel(),
          onStorageOpen: () => refreshStorageUsageSummary(),
          onHistoryFilter: () => applyAuditHistoryFilter(),
          // Experimental OT mirror: a single visible switch whose click is
          // intercepted so the confirm-before-enable flow still runs.
          onOtToggleClick: handleExperimentalOtToggleClick
        }
      });
      writingStyleSettings.mount(panel);
      providerSettingsCoordinator.refreshSummary().catch(() => {});

      sessionPanelInstance = SessionPanel.create({
        container: panelRendererInstance.sessionSlot,
        sessions: state?.sessions || [],
        activeSessionId: state?.activeSessionId || null,
        i18n: { tr },
        callbacks: {
          onSelect: sessionId => switchSession(sessionId),
          onRename: (sessionId, title) => commitSessionRename(sessionId, title),
          onDelete: sessionId => deleteSessionWithConfirm(sessionId)
        },
        deriveSessionTitle,
        isDisplayableSession,
        selectVisibleSessionsForList,
        isSessionRunning,
        formatSessionTime,
        maxVisible: 3,
        pinnedSessionIds: getRunningSessionIds()
      });

      composerPanelInstance = ComposerPanel.create({
        container: panelRendererInstance.composerSlot,
        i18n: { tr },
        icons: Modules.PanelIcons,
        attachmentController: composerAttachmentController,
        callbacks: {
          onSubmit: () => safeRunTask(),
          getTaskScope: getComposerDraftScope,
          getTaskValue: () => state.task,
          isRunning: () => Boolean(currentRunView),
          onCancel: () => cancelActiveRun(),
          onPaste: handleComposerPaste,
          onDragOver: handleComposerDragOver,
          onDragLeave: handleComposerDragLeave,
          onDrop: handleComposerDrop,
          onTaskKeydown: handleTaskInputKeydown,
          onTaskInput: handleTaskInput,
          onSlashMenuClick: handleSlashMenuClick,
          onMenuLayoutChange: updateSlashMenuLayout,
          onClearSkillInvocation: clearComposerSkillInvocation,
          onAddContext: toggleContextTray,
          onAttachClick: () => panel.querySelector('[data-attach-input]')?.click(),
          onAttachInput: handleAttachInputChange,
          onContextRefresh: () => loadContextFiles({ force: true }),
          onModelConfigToggle: () => { contextUsageView?.close(); toggleModelConfigPopover(); },
          onModelConfigChoiceClick: event => {
            handleModelConfigChoiceClick(event).catch(error => {
              appendPlainLog(tx(`Failed to update model settings: ${error.message}`, `更新模型设置失败：${error.message}`));
            });
          },
          onModeChoice: mode => {
            selectMode(mode).catch(error => appendPlainLog(tr('modeSwitchFailedToast', { message: error.message })));
          },
          onInputChange: event => persistPanelInputs(event)
        }
      });

      contextUsageView = Modules.ContextUsageView.create({
        getPanel: () => panel, getLocale, tr,
        onOpen: () => {
          closeModelConfigPopover();
          closeContextTray();
          closeSlashMenu();
        },
        getCompactAvailability,
        level: Modules.ContextUsage.level,
        onCompact: () => safeRunTask({ operation: 'compact' })
      });
      renderContextUsage();
      installContextDismiss();
      installModelConfigDismiss();
      bindLogAutoFollow();
      renderSessionList();
      renderRunHistory();
      renderContextSelection();
      scheduleMirrorPrefetch({ reason: 'cold-start', delayMs: 2500 });
      primeCodexOverleafSkillsCatalog().catch(() => { /* non-blocking */ });
      primeCodexLocalSkillsCatalog().catch(() => { /* retry through settings, slash, or submission */ });
    }

    PanelRenderer.setVisible(panel, true);
  }

  // Panel prefetch and first submission share the same official catalog read.
  // A required read fails through the existing task-start error presentation.
  let codexOverleafSkillsCatalogPromise = null;
  async function primeCodexOverleafSkillsCatalog({ required = false } = {}) {
    if (Array.isArray(state?.codexOverleafSkills) && state.codexOverleafSkills.length) {
      return state.codexOverleafSkills;
    }
    if (!required && getSkillLoadingSettings().loadCodexOverleafSkills === false) return [];
    if (!codexOverleafSkillsCatalogPromise) {
      codexOverleafSkillsCatalogPromise = sendBackgroundNative({
        method: 'skills.list', params: { scope: 'codex-overleaf' }
      }).then(response => {
        const skills = Array.isArray(response?.result?.skills) ? response.result.skills : [];
        if (!response?.ok || !skills.length) throw new Error(tx(
          'Could not load Codex Overleaf skills. Try again.', '无法加载 Codex Overleaf 技能，请重试。'));
        state = { ...state, codexOverleafSkills: skills };
        saveStateSoon();
        return skills;
      }).finally(() => { codexOverleafSkillsCatalogPromise = null; });
    }
    return codexOverleafSkillsCatalogPromise;
  }

  // Local metadata stays in memory. A stale page/account read cannot become the
  // next page's selected catalog, and an empty successful directory is valid.
  let codexLocalSkillsCatalog = null;
  let codexLocalSkillsWarnings = [];
  let codexLocalSkillsCatalogScope = '';
  let codexLocalSkillsCatalogRequest = null;
  function getCodexLocalSkillsCatalogScope() {
    return [cachedAccountScopeId, getCurrentProjectId(), spaRouteGeneration].join(':');
  }

  function getCodexLocalSkillsCatalog() {
    return codexLocalSkillsCatalogScope === getCodexLocalSkillsCatalogScope() ? codexLocalSkillsCatalog : null;
  }

  function getCodexLocalSkillWarnings() {
    return codexLocalSkillsCatalogScope === getCodexLocalSkillsCatalogScope() ? codexLocalSkillsWarnings : [];
  }

  async function primeCodexLocalSkillsCatalog({ required = false, force = false } = {}) {
    const scope = getCodexLocalSkillsCatalogScope();
    if (!required && !force && getSkillLoadingSettings().loadCodexLocalSkills === false) return [];
    if (!force && codexLocalSkillsCatalogScope === scope && Array.isArray(codexLocalSkillsCatalog)) return codexLocalSkillsCatalog;
    if (codexLocalSkillsCatalogRequest?.scope === scope) return codexLocalSkillsCatalogRequest.promise;
    const request = { scope, promise: null };
    request.promise = sendBackgroundNative({ method: 'skills.list', params: { scope: 'codex-local' } }).then(response => {
      if (!response?.ok || !Array.isArray(response.result?.skills)) throw new Error(tx(
        'Could not load local Codex skills. Try again.', '无法加载 Codex 本地技能，请重试。'));
      if (scope !== getCodexLocalSkillsCatalogScope()) throw new Error(tx(
        'The active project changed while loading skills. Try again.', '加载技能时活动项目已改变，请重试。'));
      const seen = new Set();
      const skills = response.result.skills.filter(skill => {
        const id = String(skill?.id || '');
        if (!isSafeSkillId(id) || seen.has(id)) return false;
        seen.add(id); return true;
      });
      codexLocalSkillsCatalog = skills;
      codexLocalSkillsWarnings = (Array.isArray(response.result.discoveryWarnings) ? response.result.discoveryWarnings : [])
        .filter(warning => warning?.code === 'codex_local_skills_skipped' && Number.isSafeInteger(warning.count) && warning.count > 0)
        .map(warning => ({ code: warning.code, count: warning.count }));
      codexLocalSkillsCatalogScope = scope;
      updateSkillsEntrySummary();
      updateSlashMenuForTaskInput();
      return skills;
    }).catch(() => {
      if (scope !== getCodexLocalSkillsCatalogScope()) throw new Error(tx(
        'The active project changed while loading skills. Try again.', '加载技能时活动项目已改变，请重试。'));
      throw new Error(tx('Could not load local Codex skills. Try again.', '无法加载 Codex 本地技能，请重试。'));
    }).finally(() => {
      if (codexLocalSkillsCatalogRequest === request) codexLocalSkillsCatalogRequest = null;
    });
    codexLocalSkillsCatalogRequest = request;
    return request.promise;
  }

  function closePanel() {
    PanelRenderer.setVisible(panel, false);
  }

  function isPanelOpen() {
    return panel?.classList.contains('is-open') === true;
  }

  function getPanelStateResponse() {
    return {
      ok: true,
      open: isPanelOpen(),
      launcherVisible: PanelRenderer.isLauncherVisible(panelRendererInstance)
    };
  }

  function toggleDiagnosticsMenu() {
    DiagnosticsPanel.toggleMenu(diagnosticsPanelInstance);
  }

  function closeDiagnosticsMenu() {
    DiagnosticsPanel.closeMenu(diagnosticsPanelInstance);
  }

  function handleComposerPaste(event) {
    composerAttachmentController.handlePaste(event);
  }

  function handleComposerDragOver(event) {
    composerAttachmentController.handleDragOver(event);
  }

  function handleComposerDragLeave(event) {
    composerAttachmentController.handleDragLeave(event);
  }

  function handleComposerDrop(event) {
    composerAttachmentController.handleDrop(event);
  }

  async function addComposerAttachmentFiles(files) {
    return composerAttachmentController.addFiles(files);
  }

  function handleAttachInputChange(event) {
    const input = event?.target;
    const files = input?.files ? [...input.files] : [];
    if (files.length) {
      Promise.resolve(composerAttachmentController.addFiles(files)).catch(error => {
        appendPlainLog(tx(`Could not attach files: ${error.message}`, `附件添加失败：${error.message}`));
      });
    }
    if (input) {
      input.value = '';
    }
  }

  function getComposerAttachmentsForRun() {
    return composerAttachmentController.getAttachmentsForRun();
  }

  function createRunAttachmentSnapshots(attachments = []) {
    return composerAttachmentController.createRunAttachmentSnapshots(attachments);
  }

  function renderComposerAttachments() {
    composerAttachmentController.renderComposerAttachments();
  }

  function renderAttachmentPreviewList(attachments = [], container, options = {}) {
    return composerAttachmentController.renderAttachmentPreviewList(attachments, container, options);
  }
  function applyLocaleToPanel() {
    if (!panel) {
      return;
    }

    panel.querySelectorAll('[data-i18n]').forEach(element => {
      element.textContent = tr(element.dataset.i18n);
    });
    panel.querySelectorAll('[data-i18n-aria-label]').forEach(element => {
      element.setAttribute('aria-label', tr(element.dataset.i18nAriaLabel));
    });
    panelRendererInstance?.setLocale?.({ launcher: tx('Show or hide Codex panel', '显示或隐藏 Codex 边栏'), close: tx('Close Codex panel', '关闭 Codex 边栏') });

    setElementTitleAndAria('[data-panel-resize-handle]', tr('resizePanel'), tr('resizePanel'));
    setRefreshProbeLoading(panel?.querySelector('[data-refresh]')?.dataset.loading === 'true');
    // State-dependent tooltip: re-derive from the dot's current health so a
    // locale/session refresh doesn't clobber it back to the generic label.
    setDiagnosticsHealth(panel.querySelector('[data-diagnostics-health-dot]')?.dataset.health || 'unknown');
    // Guardrail notes carry locale-resolved text; re-render them so a visible
    // governance warning follows a language switch.
    settingsPanelInstance?.refreshNotes?.();
    setElementTitleAndAria('[data-diagnostics-result-close]', tr('close'), tr('closeDiagnostics'));
    setElementTitleAndAria('[data-new-session]', tr('newSessionTooltip'), tr('newSession'));
    setElementTitleAndAria('[data-custom-instructions-settings]', tr('projectSettings'), tr('projectSettings'));
    setElementTitleAndAria('[data-settings-back]', tr('settingsBack'), tr('settingsBack'));
    setElementTitleAndAria('[data-skills-back]', tr('settingsBack'), tr('settingsBack'));
    setElementTitleAndAria('[data-add-context]', tr('addContext'), tr('addContext'));
    setElementTitleAndAria('[data-attach-file]', tr('attachFiles'), tr('attachFiles'));
    setElementTitleAndAria('[data-context-refresh]', tr('refreshFileList'), tr('refreshFileList'));
    setElementTitleAndAria('[data-reasoning]', tr('reasoningLabel'), tr('reasoningLabel'));
    setElementTitleAndAria('[data-speed]', tr('speedLabel'), tr('speedLabel'));
    syncComposerSendAvailability();
    setElementTitleAndAria('[data-stop-run]', tr('cancelRun'), tr('cancelRun'));

    const actions = panel.querySelector('.codex-vscode-head-actions');
    if (actions) {
      actions.setAttribute('aria-label', tr('codexActions'));
    }
    const task = panel.querySelector('[data-task]');
    if (task) {
      task.placeholder = tr('placeholder');
    }
    const customInstructionsInput = panel.querySelector('[data-custom-instructions-input]');
    if (customInstructionsInput) {
      customInstructionsInput.placeholder = tr('customInstructionsPlaceholder');
      customInstructionsInput.setAttribute('aria-label', tr('personalizationConfig'));
    }
    const modeSwitch = panel.querySelector('.codex-mode-switch');
    if (modeSwitch) {
      modeSwitch.setAttribute('aria-label', tr('writeMode'));
    }
    const modeSelect = panel.querySelector('[data-mode]');
    if (modeSelect) {
      modeSelect.setAttribute('aria-label', tr('mode'));
      for (const option of modeSelect.options) {
        option.textContent = formatModeLabel(option.value);
      }
    }
    for (const button of panel.querySelectorAll('[data-mode-choice]')) {
      const mode = button.dataset.modeChoice;
      button.textContent = formatModeLabel(mode);
      button.title = tr(`mode${capitalizeModeKey(mode)}Title`);
    }
    const reviewToggle = panel.querySelector('.codex-review-toggle');
    if (reviewToggle) {
      syncReviewingTooltip();
    }
    const recompileToggle = panel.querySelector('.codex-recompile-toggle');
    if (recompileToggle) {
      recompileToggle.title = tr('autoCompileTitle');
    }
    const otCheckbox = panel.querySelector('[data-experimental-ot]');
    if (otCheckbox) {
      otCheckbox.title = tr('experimentalOtWarmMirrorTitle');
      otCheckbox.setAttribute('aria-label', tr('experimentalOtWarmMirror'));
    }
    const contextStatus = panel.querySelector('[data-context-status]');
    if (contextStatus && !contextStatus.dataset.customStatus) {
      contextStatus.textContent = tr('contextStatus');
    }
    // Re-render rather than patch text: the first div is the animated mark.
    if (arguments[0]?.reprojectDynamic !== false) runTimelineView.refreshLocale?.();

    syncModeControls();
    updateOtStatusDisplay();
    updateExperimentalOtMenuStatus();
    renderModelConfigChoices();
    updateModelDisplay();
    // The header switcher's title and accessible name carry localized text too.
    applySessionLabel();
    renderSessionList();
    renderContextUsage();
    if (panel.querySelector('[data-slash-menu]')?.hidden === false) updateSlashMenuForTaskInput();
    renderContextSelection();
    renderContextSummary();
    renderPendingInputs();
    renderComposerAttachments();
    renderComposerSkillInvocation();
    writingStyleSettings.sync();
    updateSkillsEntrySummary();
    localSkillsPanel.refreshLocale?.();
    providerSettingsCoordinator.renderSummary();
    providerSettingsCoordinator.refreshLocale?.();
    settingsPanelInstance?.refreshLocale?.();
    Modules.UpdateNotice?.refreshLocale?.();
    DiagnosticsPanel.refreshLocale?.(diagnosticsPanelInstance, diagnosticsController.refreshLocale?.());
    if (!panel.querySelector('[data-context-tray]')?.hidden) renderContextFiles();
    if (settingsPanelInstance?.container?.querySelector('[data-storage-card]')?.open) refreshStorageUsageSummary();
  }

  function setElementTitleAndAria(selector, title, ariaLabel) {
    const element = panel?.querySelector(selector);
    if (!element) {
      return;
    }
    element.title = title;
    element.setAttribute('aria-label', ariaLabel || title);
  }

  function capitalizeModeKey(mode) {
    if (mode === 'ask') {
      return 'Ask';
    }
    if (mode === 'auto') {
      return 'Auto';
    }
    return '';
  }

  function installDiagnosticsDismiss() {}

  function closeDiagnosticsResult() { DiagnosticsPanel.closeResult(diagnosticsPanelInstance); }

  function showDiagnosticsLoading(title, subtitle = tr('diagnosticsLoading')) { DiagnosticsPanel.showLoading(diagnosticsPanelInstance, title, subtitle); }

  function showDiagnosticsResult(result = {}) { DiagnosticsPanel.showResult(diagnosticsPanelInstance, result); }

  function setDiagnosticsHealth(health) { DiagnosticsPanel.updateStatus(diagnosticsPanelInstance, { health }); }

  function installContextDismiss() {
    return contextTrayController.installContextDismiss();
  }

  function installModelConfigDismiss() {
    document.addEventListener('click', event => {
      const config = panel?.querySelector('[data-model-config]');
      if (!config || config.contains(event.target)) {
        return;
      }
      closeModelConfigPopover();
    }, true);
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') {
        return;
      }
      const popover = panel?.querySelector('[data-model-config-popover]');
      if (popover && !popover.hidden) {
        closeModelConfigPopover();
      }
    }, true);
  }






  function exportDiagnosticsBundle() {
    return diagnosticsExporter.exportDiagnosticsBundle();
  }

  function isContextTrayClickTarget(target) {
    return contextTrayController.isContextTrayClickTarget(target);
  }

  function toggleContextTray() {
    return contextTrayController.toggleContextTray();
  }

  function closeContextTray() {
    return contextTrayController.closeContextTray();
  }

  async function loadContextFiles(options = {}) {
    return contextTrayController.loadContextFiles(options);
  }

  async function requestExactContextFiles({ force = false } = {}) {
    return contextTrayController.requestExactContextFiles({ force });
  }

  function isExactContextFileListProject(project) {
    return contextTrayController.isExactContextFileListProject(project);
  }

  function isContextFileListProject(project) {
    return contextTrayController.isContextFileListProject(project);
  }

  function normalizeContextFileListFromZipSnapshot(project) {
    return contextTrayController.normalizeContextFileListFromZipSnapshot(project);
  }

  function normalizeContextFileFromZipSnapshot(file, activePath) {
    return contextTrayController.normalizeContextFileFromZipSnapshot(file, activePath);
  }

  function getZipSnapshotFailureReason(project) {
    return contextTrayController.getZipSnapshotFailureReason(project);
  }

  function renderContextFiles(project) {
    return contextTrayController.renderContextFiles(project);
  }

  function getContextProjectFiles(files = []) {
    return contextTrayController.getContextProjectFiles(files);
  }

  function buildContextTree(files = []) {
    return contextTrayController.buildContextTree(files);
  }

  function sortContextTree(node) {
    return contextTrayController.sortContextTree(node);
  }

  function renderContextTreeNode(node, container, selected, depth) {
    return contextTrayController.renderContextTreeNode(node, container, selected, depth);
  }

  function renderContextSelection() {
    return contextTrayController.renderContextSelection();
  }

  function renderContextSummary() {
    return contextTrayController.renderContextSummary();
  }

  async function selectFocusFile(path) {
    return contextTrayController.selectFocusFile(path);
  }

  async function clearFocusFile() {
    return contextTrayController.clearFocusFile();
  }

  function getActiveFocusFiles() {
    return contextTrayController.getActiveFocusFiles();
  }

  function sortContextFiles(files, activePath) {
    return contextTrayController.sortContextFiles(files, activePath);
  }

  function getContextFileRank(path) {
    return contextTrayController.getContextFileRank(path);
  }

  function setContextStatus(text) {
    return contextTrayController.setContextStatus(text);
  }

  function resetContextProject() { return contextTrayController.resetContextProject(); }

  async function runTask(options = {}) {
    // Capture the click before any preparation can yield to another draft/session.
    readPanelInputs();
    const queuedInput = options.queuedInput || null;
    const compact = !queuedInput && options.operation === 'compact';
    const task = compact ? '/compact' : String(queuedInput?.text || state.task || '').trim();
    if (!task) {
      appendLog(tx('Enter a task first.', '请先输入任务。'));
      return;
    }
    const submittedSessionId = state.activeSessionId;
    const submittedSession = runController.captureSessionContext(state);
    const submittedThreadId = getActiveSession(state)?.codexThreadId || '';
    if (compact && !submittedThreadId) {
      showPluginToast(tr('compactNoThread'), { status: 'info' });
      return;
    }
    const submittedDraft = state.task;
    const submittedRetryReplacement = pendingRetryReplacement;
    const submittedWritingStyleScope = { accountScopeId: cachedAccountScopeId, projectId: getCurrentProjectId() };
    const submittedPanelState = {
      mode: compact ? 'ask' : state.mode,
      providerId: state.providerId,
      model: state.model,
      reasoningEffort: state.reasoningEffort,
      speedTier: state.speedTier,
      autoRecompile: state.autoRecompile !== false,
      requireReviewing: state.requireReviewing === true,
      focusFiles: compact ? [] : getActiveFocusFiles(),
      selectionContext: compact ? null : selectionContextView.capture()
    };
    const queuedContext = queuedInput
      ? RunInputQueue.normalizeSubmissionContext(queuedInput.payload?.submissionContext) : null;
    const submittedCustomInstructions = queuedContext ? queuedContext.customInstructions : getCustomInstructionsForCurrentProject();
    const submittedSkillLoadingSettings = queuedContext ? queuedContext.skillLoadingSettings : getSkillLoadingSettings();
    const submittedAttachments = queuedInput || compact ? [] : getComposerAttachmentsForRun();
    const submittedSkillInvocation = compact ? null : queuedContext ? queuedContext.skillInvocation : getComposerSkillInvocationForRun();
    let submittedEnabledSkillIds = queuedContext ? queuedContext.enabledCodexOverleafSkillIds : getEnabledCodexOverleafSkillIds();
    const submittedSkillEnabled = { ...state.codexOverleafSkillEnabled };
    const submittedLocalSkillEnabled = { ...state.codexLocalSkillEnabled };
    const submittedSelectionRevision = selectionContextView.getRevision?.();
    let submittedEnabledLocalSkillIds = queuedContext ? queuedContext.enabledCodexLocalSkillIds : compact ? getEnabledCodexLocalSkillIds() : [];
    // Capture submission first; a save must not adopt text typed while it waits.
    if (!queuedInput) await flushComposerDraft({ requireDurable: true });
    if (!compact && !queuedInput && submittedSkillLoadingSettings.loadCodexLocalSkills !== false) {
      const localSkills = await primeCodexLocalSkillsCatalog({ required: true, force: submittedSkillInvocation?.scope === 'codex-local' });
      submittedEnabledLocalSkillIds = localSkills.filter(skill => Object.hasOwn(submittedLocalSkillEnabled, skill.id)
        ? submittedLocalSkillEnabled[skill.id] !== false : skill.enabled !== false).map(skill => skill.id);
    }
    if (!queuedInput && submittedSkillInvocation?.scope === 'codex-local'
      && (submittedSkillLoadingSettings.loadCodexLocalSkills === false || !submittedEnabledLocalSkillIds.includes(submittedSkillInvocation.id))) {
      throw new Error(tx('The selected local Codex skill is unavailable or disabled. Select an enabled skill and try again.',
        '所选 Codex 本地技能不可用或已关闭，请选择已启用的技能后重试。'));
    }
    if (!compact && !queuedInput && submittedSkillLoadingSettings.loadCodexOverleafSkills !== false) {
      const skills = await primeCodexOverleafSkillsCatalog({ required: true });
      submittedEnabledSkillIds = skills.map(skill => String(skill?.id || '').trim())
        .filter(id => id && submittedSkillEnabled[id] !== false);
    }
    // Keep the previous mirror's completion events on its own run.
    const pendingMirror = getPendingMirrorRefresh?.();
    if (pendingMirror) await pendingMirror.catch(() => {});
    await providerSettingsCoordinator.ensureLoaded();
    if (!queuedInput && !compact) await writingStyleSettings.ensureLoaded(true);
    if (submittedWritingStyleScope.accountScopeId !== cachedAccountScopeId
      || submittedWritingStyleScope.projectId !== getCurrentProjectId()) {
      throw new Error(tx('The active project changed before submission. Submit the task again.',
        '提交前活动项目已改变，请重新提交任务。'));
    }
    if (!findSessionById(submittedSessionId) || currentRunView
      || (compact && findSessionById(submittedSessionId)?.codexThreadId !== submittedThreadId)) {
      throw new Error(tx('The submitted session changed before submission. Submit the task again.',
        '提交所属会话已改变，请重新提交任务。'));
    }
    submittedPanelState.writingStyle = queuedInput || compact ? null : writingStyleSettings.capture();
    let executionSnapshot = queuedInput
      ? RunExecutionSnapshot.resolveForExecution(
        RunExecutionSnapshot.fromQueuePayload(queuedInput.payload),
        { catalog: providerSettingsCoordinator.getCatalog() }
      )
      : captureCurrentExecutionSnapshot(submittedPanelState);
    // Freeze submitted run identity before the panel can change during the run.
    const submittedMode = executionSnapshot.mode;
    let submittedRequireReviewing = executionSnapshot.requireReviewing === true;
    const replaceRunId = queuedInput || compact ? '' : runController.resolveRetryReplacement({
      candidate: submittedRetryReplacement,
      activeSessionId: submittedSessionId,
      runs: findSessionById(submittedSessionId)?.runs,
      projectRunSettlement: run => WritebackSettlement.projectRunSettlement(run)
    });

    runCancellationRequested = false;
    runCancellationController = new AbortController();
    setRunning(true);
    const runSessionId = submittedSessionId;
    let runAuditDraft = null;
    let localSkillRestorePoint = null;
    try {
      currentRunView = startRunView({
        sessionId: submittedSessionId,
        sessionContext: submittedSession,
        codexThreadId: submittedThreadId,
        operation: compact ? 'compact' : undefined,
        task,
        mode: submittedMode,
        model: executionSnapshot.model,
        reasoningEffort: executionSnapshot.reasoningEffort,
        speedTier: executionSnapshot.speedTier,
        executionSnapshot,
        attachments: submittedAttachments,
        skillInvocation: submittedSkillInvocation,
        queueItemId: queuedInput?.id || '',
        replaceRunId
      });
      // Preparation can await project/audit work before a Native request exists.
      // Give other pages a live owner to check throughout that interval.
      const bound = await awaitRunStep(activeTurnControl.bindBrowserRun({
        requestId: ActiveTurnControl.getStartupRequestId(runSessionId, currentRunView.recordId),
        projectKey: currentRunView.runProjectId, clientRunId: currentRunView.recordId,
        sessionId: runSessionId, ownerToken: crypto.randomUUID()
      }));
      throwIfRunCancellationRequested();
      if (!bound) throw new Error(tx('Could not start the task. Reload the page and try again.',
        '无法启动任务，请刷新页面后重试。'));
      renderContextUsage();
      if (!queuedInput && !compact && pendingRetryReplacement === submittedRetryReplacement) pendingRetryReplacement = null;
      if (compact) {
        announceCrossTabRunStart();
        // Only the slash-command text is consumed; a draft kept while compacting from the popover stays.
        if (options.consumeCompactDraft === true && state.activeSessionId === submittedSessionId
          && /^\/[^\s/]*$/.test(String(submittedDraft || '').trim())
          && panel?.querySelector('[data-task]')?.value === submittedDraft) {
          panel.querySelector('[data-task]').value = '';
          updateSessionById(submittedSessionId, { task: '' });
          recordSubmittedDraftConsumption(submittedSessionId, submittedDraft);
          composerDraftEditedHere = false;
          composerDraftRevision += 1;
          autosizeTaskTextarea();
          closeSlashMenu();
          syncComposerSendAvailability(true);
        }
        appendRunEvent({ title: tr('contextUsageCompacting'), status: 'running',
          activity: { v: 1, kind: 'lifecycle', state: 'running', target: 'context_compaction' } });
        renderContextUsage();
        const response = await awaitRunStep(sendTrackedCodexRun({
          operation: 'compact', task: '/compact', mode: 'ask',
          projectId: currentRunView.runProjectId, accountScopeId: currentRunView.runAccountScopeId,
          clientRunId: currentRunView.recordId, clientSessionId: runSessionId,
          threadId: submittedThreadId, model: executionSnapshot.model,
          reasoningEffort: executionSnapshot.reasoningEffort, speedTier: executionSnapshot.speedTier,
          providerSelection: RunExecutionSnapshot.toProviderSelection(executionSnapshot),
          locale: getLocale(), ...submittedSkillLoadingSettings,
          enabledCodexOverleafSkillIds: submittedEnabledSkillIds,
          enabledCodexLocalSkillIds: submittedEnabledLocalSkillIds
        }));
        if (!response?.ok) throw Object.assign(new Error(response?.error?.message || 'Compaction failed'), response?.error);
        if (response.result?.operation !== 'compact' || response.result?.status !== 'completed'
          || response.result?.threadId !== submittedThreadId) {
          throw Object.assign(new Error('Compaction completion was not confirmed'), { code: 'codex_compact_unconfirmed' });
        }
        throwIfRunCancellationRequested();
        appendCompletionReport({ conclusion: tr('compactCompleted'), conclusionKey: 'context_compacted',
          status: 'completed', mode: 'ask', operations: [], applyResults: [] });
        await finishRunView(tr('compactCompleted'), 'completed');
        return;
      }
      if (queuedInput?.id) {
        await runQueueScheduler?.markExecuting(runSessionId, queuedInput.id, currentRunView.recordId);
      }
      runAuditDraft = await awaitRunStep(createAuditDraftForRun({
        task,
        sessionId: runSessionId,
        mode: submittedMode,
        focusFiles: executionSnapshot.focusFiles,
        executionSnapshot
      }));
      if (submittedWritingStyleScope.accountScopeId !== cachedAccountScopeId
        || submittedWritingStyleScope.projectId !== getCurrentProjectId()) {
        throw Object.assign(createRunCancellationError(), {
          message: 'The active project or account changed before dispatch.'
        });
      }
      announceCrossTabRunStart();
      // Binary attachments belong to this submitted turn. The run record has
      // already captured their snapshots, so clear them from the composer
      // together with the submitted text. Persistent @context remains intact.
      const submittedComposerCleared = !queuedInput && clearTaskComposer({ keepAttachments: false, submission: {
        ...submittedWritingStyleScope,
        sessionId: submittedSessionId, task: submittedDraft, attachments: submittedAttachments,
        skillInvocation: submittedSkillInvocation, selectionContext: submittedPanelState.selectionContext,
        selectionRevision: submittedSelectionRevision
      } });
      if (submittedComposerCleared && submittedSkillInvocation?.scope === 'codex-local'
        && state.activeSessionId === submittedSessionId && !panel?.querySelector('[data-task]')?.value
        && !getComposerAttachmentsForRun().length && !composerAttachmentController.getAttachmentByteUsage?.().pending
        && !getComposerSkillInvocationForRun() && !selectionContextView.capture()) {
        localSkillRestorePoint = { draftRevision: composerDraftRevision,
          attachmentRevision: composerAttachmentController.getRevision?.(), selectionRevision: selectionContextView.getRevision?.() };
      }
      syncComposerSendAvailability(true);
      appendRunEvent({
        title: submittedSkillInvocation?.id === 'skill-installer' && !submittedSkillInvocation.scope
          ? tx('I will use the Codex skill installer for this request.', '我会用 Codex skill installer 处理这个请求。')
          : tx('I will first understand your request, then inspect the relevant Overleaf files.', '我会先理解你的请求，再检查相关 Overleaf 文件。'),
        status: 'running',
        detail: {
          [tr('mode')]: formatModeLabel(submittedMode),
          [tx('Model', '模型')]: executionSnapshot.model,
          [tx('Reasoning effort', '推理强度')]: executionSnapshot.reasoningEffort,
          [tx('Speed', '速度')]: executionSnapshot.speedTier,
          [tx('Track required', '要求留痕')]: submittedRequireReviewing ? tx('yes', '是') : tx('no', '否'),
          [tx('Skill', '技能')]: submittedSkillInvocation?.title || tr('noneValue'),
          [tx('Attachments', '附件')]: submittedAttachments.map(attachment => attachment.name).join(listSeparator()) || tr('noneValue'),
          '@context': formatContextItems(executionSnapshot.focusFiles)
        }
      });
      if (submittedSkillInvocation?.id === 'skill-installer' && !submittedSkillInvocation.scope) {
        await awaitRunStep(runSkillInstallerTask({
          task,
          runSessionId,
          runAuditDraft,
          submittedMode,
          submittedCustomInstructions,
          submittedSkillLoadingSettings,
          submittedEnabledLocalSkillIds,
          submittedEnabledSkillIds,
          submittedAttachments,
          submittedSkillInvocation,
          executionSnapshot
        }));
        return;
      }
      appendRunEvent({
        // @context prioritizes these files; complete project runs may still update related files.
        title: tx(
          `This run will prioritize: ${formatContextItems(executionSnapshot.focusFiles)} (persists across turns; clear via ＋)`,
          `本轮将优先处理：${formatContextItems(executionSnapshot.focusFiles)}（跨轮保留，可在 ＋ 中清除）`
        ),
        status: 'completed'
      });

      await awaitRunStep(pauseOtWarmMirror('run-start'));
      const writeSafety = await awaitRunStep(preflightWriteSafety({
        mode: submittedMode,
        requireReviewing: submittedRequireReviewing,
        onUntracked: async choice => {
          submittedRequireReviewing = false;
          // Keep the effective policy identical in dispatch, recovery and Undo consumers.
          const view = currentRunView;
          const record = findRunRecord(view.recordId, view.sessionId);
          executionSnapshot = RunExecutionSnapshot.applyUntrackedDecision(view, record, choice);
          if (choice === 'disable') {
            updateSessionById(view.sessionId, { requireReviewing: false });
            if (state.activeSessionId === view.sessionId) {
              state.requireReviewing = false;
              panel.querySelector('[data-require-reviewing]').checked = false;
            }
          }
          appendRunEvent({ title: tr('reviewingUnavailableRunUntracked'), status: 'completed',
            technicalDetail: { code: 'reviewing_unavailable', submittedRequireReviewing: true,
              effectiveRequireReviewing: false, choice } });
          saveStateSoon(0);
          syncProbeStatus();
          runAuditDraft = await finalizeAuditDraftPartial(runAuditDraft, {
            requireReviewing: false, trackingDecision: choice
          });
          await flushQueuedSaveState({ requireDurable: true });
        }
      }));
      if (!writeSafety.ok) {
        await finalizeAuditRecord(runAuditDraft, {
          resultStatus: 'blocked',
          blockedFiles: [{ path: 'write-preflight', reason: writeSafety.reason || 'write_safety' }]
        });
        return;
      }

      let focusFiles = [...executionSnapshot.focusFiles];
      const warmStart = await awaitRunStep(resolveWarmRunStart({ focusFiles, mode: submittedMode }));
      let project = warmStart.project || null;
      let useExistingMirror = warmStart.useExistingMirror;
      let fileOverlays = warmStart.fileOverlays || null;
      let otWarmStart = warmStart.otWarmStart === true;
      if (!useExistingMirror) {
        appendRunEvent({
          title: tx('Syncing the Overleaf project to the local Codex workspace.', '正在同步 Overleaf 项目到本地 Codex workspace。'),
          status: 'running'
        });
        project = await awaitRunStep(getRunProjectSnapshot());
      }
      throwIfRunCancellationRequested();
      if (!useExistingMirror) {
        appendLog(formatProjectSnapshotUserLog(project));
      }
      persistCurrentProjectReferenceFiles(project);
      const snapshotWarnings = useExistingMirror
        ? { blocking: [], nonBlocking: [] }
        : getProjectSnapshotWarnings(project);
      const warmMirrorReuse = useExistingMirror
        ? warmStart
        : await awaitRunStep(resolveWarmMirrorReuse(project, {
          snapshotWarnings,
          focusFiles,
          mode: submittedMode
        }));
      const focusedPartialSnapshot = runController.canUseFocusedPartialSnapshot({
        project,
        snapshotWarnings,
        focusFiles,
        focusFilesAreLiteral: true,
        isUsableProjectFileContent: Modules.ProjectFiles.isUsableProjectFileContent
      });
      let restrictToFocusFiles = runController.shouldRestrictWritebackToFocus({ focusFiles, focusedPartialSnapshot });
      if (snapshotWarnings.blocking.length && !warmMirrorReuse.useExistingMirror && !focusedPartialSnapshot) {
        for (const warning of snapshotWarnings.blocking) {
          appendLog(tx(`Cannot continue: ${formatProjectSnapshotWarning(warning)}`, `无法继续：${formatProjectSnapshotWarning(warning)}`));
        }
        // Structured FailureReason §9.0: the initial project snapshot fetch
        // produced a payload that failed every usable-source check. Emit the
        // canonical `project_snapshot_unavailable` so downstream renderers
        // (run-card + final-report) get the same data the page-side emitters
        // produce for navigation/preflight codes.
        const snapshotFailure = buildContentFailure('project_snapshot_unavailable', null, {
          evidence: {
            fetchFailed: true,
            blocking: snapshotWarnings.blocking.slice(0, 8),
            fileCount: (project?.files || []).length
          }
        });
        appendCompletionReport({ conclusionKey: 'full_project_unread',
          conclusion: tx('This run did not continue: the full Overleaf project was not read.', '这轮没有继续：没有读到完整的 Overleaf 项目内容。'),
          status: 'blocked',
          operations: [],
          applyResults: [],
          nextStep: tx('Reload the Overleaf project or reopen the .tex file you want to process, then retry.', '请刷新 Overleaf 项目或重新打开要处理的 .tex 文件后再试。'),
          failure: snapshotFailure
        });
        await finalizeAuditRecord(runAuditDraft, {
          resultStatus: 'blocked',
          skippedFiles: [],
          blockedFiles: snapshotWarnings.blocking.map(reason => ({ path: 'project', reason }))
        });
        await finishRunView(tx('Blocked: full project was not read', '已阻止：没有读到完整项目'), 'failed');
        return;
      }

      if (warmMirrorReuse.useExistingMirror) {
        useExistingMirror = true;
        fileOverlays = warmMirrorReuse.fileOverlays;
        otWarmStart = warmMirrorReuse.otWarmStart === true;
        if (warmMirrorReuse.otWarmStart) {
          if (Array.isArray(warmMirrorReuse.focusFiles) && warmMirrorReuse.focusFiles.length) {
            focusFiles = warmMirrorReuse.focusFiles;
          }
        }
        restrictToFocusFiles = runController.shouldRestrictWritebackToFocus({ focusFiles, focusedPartialSnapshot: warmMirrorReuse.partialSnapshot, otWarmStart });
        appendRunEvent({
          title: warmMirrorReuse.warmStart
            ? tr('warmMirrorReuseTitle')
            : warmMirrorReuse.partialSnapshot
            ? tr('warmMirrorPartialOverlayTitle')
            : tr('warmMirrorFocusOverlayTitle'),
          status: 'completed'
        });
      } else if (focusedPartialSnapshot) {
        appendRunEvent({
          title: tx(
            `Only selected context files were read: ${focusFiles.join(', ')}. This run will read and write only these files.`,
            `只读到你选择的上下文文件：${focusFiles.join(', ')}；本轮将只基于这些文件运行和写回。`
          ),
          status: 'completed'
        });
      } else {
        for (const warning of snapshotWarnings.nonBlocking) {
          appendLog(tx(`Note: ${formatProjectSnapshotWarning(warning)}`, `提示：${formatProjectSnapshotWarning(warning)}`));
        }
      }

      const codexThreadId = submittedThreadId;

      // Resolve @compile-log if mentioned in task
      let compileLogContext = null;
      if (/(^|[^\w])@compile-log\b/i.test(task)) {
        appendRunEvent({ title: tx('Fetching compile log (@compile-log).', '正在获取编译日志 (@compile-log)。'), status: 'running' });
        compileLogContext = await awaitRunStep(resolveCompileLogContext());
        if (compileLogContext.available) {
          appendRunEvent({
            title: tx(
              `Compile log fetched (${(compileLogContext.errors || []).length} errors, ${(compileLogContext.warnings || []).length} warnings).`,
              `编译日志已获取（${(compileLogContext.errors || []).length} 个错误，${(compileLogContext.warnings || []).length} 个警告）。`
            ),
            status: 'completed'
          });
        } else {
          // Structured FailureReason §9.0: `@compile-log` was named in the
          // task but the page-side resolver could not produce it. Surface a
          // `selected_context_unresolved` failure (warning, retryable) so the
          // primary-failure selector can describe what was missing without
          // blocking the rest of the run.
          const contextFailure = buildContentFailure('selected_context_unresolved', null, {
            evidence: {
              contextTarget: '@compile-log',
              reason: compileLogContext.reason || ''
            }
          });
          appendRunEvent({
            title: tx(`Compile log unavailable: ${Modules.CompileAdapter.localizeCompileReason(compileLogContext.reason, getLocale())}`, `编译日志不可用：${Modules.CompileAdapter.localizeCompileReason(compileLogContext.reason, getLocale())}`),
            status: 'failed',
            failure: contextFailure
          });
        }
      }

      let sensitiveFindings = await awaitRunStep(runSensitivePreflight({
        task,
        project,
        rules: getGovernanceRulesForCurrentProject(),
        useExistingMirror
      }));
      if (sensitiveFindings.blocked) {
        await finalizeAuditRecord(runAuditDraft, {
          resultStatus: 'blocked_sensitive',
          sensitiveFindings: sensitiveFindings.findings,
          blockedFiles: sensitiveFindings.findings.map(finding => ({
            path: finding.path || finding.source || 'task',
            reason: finding.detectorId || 'sensitive'
          }))
        });
        await finishRunView(tx('Blocked: sensitive content review required', '已阻止：需要处理敏感内容'), 'failed');
        return;
      }
      if (sensitiveFindings.findings.length) {
        runAuditDraft = await updateAuditSensitiveFindings(runAuditDraft, sensitiveFindings.findings);
      }

      await awaitRunStep(settleMirrorPrefetchBeforeRun());
      await awaitRunStep(providerSettingsCoordinator.ensureLoaded());
      appendRunEvent({ title: tx('Local Codex session is starting.', '本地 Codex session 开始运行。'), status: 'running' });
      let response = await awaitRunStep(sendTrackedCodexRun(buildCodexRunParams({
          task,
          project,
          useExistingMirror,
          fileOverlays,
          focusFiles,
          otWarmStart,
          restrictToFocusFiles,
          codexThreadId,
          compileLogContext,
          customInstructions: submittedCustomInstructions,
          skillLoadingSettings: submittedSkillLoadingSettings,
          enabledCodexOverleafSkillIds: submittedEnabledSkillIds,
          enabledCodexLocalSkillIds: submittedEnabledLocalSkillIds,
          attachments: submittedAttachments,
          skillInvocation: submittedSkillInvocation,
          submittedMode
        })));

      // A stale mirror or contradictory editor overlay requires a fresh read.
      if (!response.ok && ['mirror_stale', 'document_identity_mismatch'].includes(response.error?.code) && useExistingMirror) {
        appendRunEvent({ title: tr('warmMirrorStaleRetryTitle'), status: 'running' });
        const staleRetry = await awaitRunStep(prepareMirrorStaleRetry({
          project: await awaitRunStep(getRunProjectSnapshot()),
          focusFiles
        }));
        if (!staleRetry.ok) {
          return;
        }
        project = staleRetry.project;
        persistCurrentProjectReferenceFiles(project);
        useExistingMirror = false;
        fileOverlays = null;
        otWarmStart = false;
        restrictToFocusFiles = staleRetry.restrictToFocusFiles;
        const retryFindings = await awaitRunStep(runSensitivePreflight({
          task, project, rules: getGovernanceRulesForCurrentProject(), useExistingMirror: false
        }));
        if (retryFindings.blocked) {
          await finalizeAuditRecord(runAuditDraft, {
            resultStatus: 'blocked_sensitive', sensitiveFindings: retryFindings.findings,
            blockedFiles: retryFindings.findings.map(finding => ({
              path: finding.path || finding.source || 'task', reason: finding.detectorId || 'sensitive'
            }))
          });
          await finishRunView(tx('Blocked: sensitive content review required', '已阻止：需要处理敏感内容'), 'failed');
          return;
        }
        if (retryFindings.findings.length) {
          sensitiveFindings = {
            blocked: false, findings: [...sensitiveFindings.findings, ...retryFindings.findings]
          };
          runAuditDraft = await updateAuditSensitiveFindings(runAuditDraft, sensitiveFindings.findings);
        }
        response = await awaitRunStep(sendTrackedCodexRun(buildCodexRunParams({
            task,
            project,
            useExistingMirror: false,
            fileOverlays: null,
            focusFiles,
            otWarmStart,
            restrictToFocusFiles,
            codexThreadId,
            compileLogContext,
            customInstructions: submittedCustomInstructions,
            skillLoadingSettings: submittedSkillLoadingSettings,
            enabledCodexOverleafSkillIds: submittedEnabledSkillIds,
            enabledCodexLocalSkillIds: submittedEnabledLocalSkillIds,
            attachments: submittedAttachments,
            skillInvocation: submittedSkillInvocation,
            submittedMode
          })));
      }

      if (!response.ok && response.error?.code === 'thread_resume_failed') {
        const userChoice = await showThreadResumeFailedPrompt();
        if (userChoice === 'new') {
          updateSessionById(runSessionId, { codexThreadId: '' });
          renderContextUsage();
          const StorageDb = Modules.StorageDb;
          // A live session goes through the ordinary writer. An envelope
          // conflict there must not abort the run that is choosing a new thread.
          if (findSessionById(runSessionId)) {
            saveStateSoon();
          } else if (StorageDb) {
            const record = await StorageDb.getRecord('sessions', runSessionId, { adopt: false });
            if (record) {
              record.codexThreadId = '';
              await StorageDb.putRecord('sessions', record, { adopt: false });
            }
          }
          appendRunEvent({ title: tx('Creating a new Codex conversation thread.', '正在新建 Codex 会话线程。'), status: 'running' });
          response = await sendTrackedCodexRun(buildCodexRunParams({
              task,
              project,
              useExistingMirror,
              fileOverlays,
              focusFiles,
              otWarmStart,
              restrictToFocusFiles,
              codexThreadId: '',
              compileLogContext,
              customInstructions: submittedCustomInstructions,
              skillLoadingSettings: submittedSkillLoadingSettings,
              enabledCodexOverleafSkillIds: submittedEnabledSkillIds,
              enabledCodexLocalSkillIds: submittedEnabledLocalSkillIds,
              attachments: submittedAttachments,
              skillInvocation: submittedSkillInvocation,
              submittedMode
            }));
        } else {
          appendRunEvent({ title: tx('Cancelled: user chose not to create a new thread.', '已取消：用户选择不新建线程。'), status: 'info',
            activity: { v: 1, kind: 'lifecycle', state: 'cancelled', target: 'cancelled' } });
          await finalizeAuditRecord(runAuditDraft, { resultStatus: 'cancelled' });
          await finishRunView(tx('Cancelled', '已取消'), 'cancelled');
          return;
        }
      }

      if (!response.ok) {
        if (runCancellationRequested || isRunCancellationError(response.error)) {
          appendRunCancelledReport();
          await finishRunView(tx('Cancelled', '已取消'), 'cancelled');
          void finalizeAuditRecord(runAuditDraft, { resultStatus: 'cancelled' });
          return;
        }
        if (response.error?.code === 'codex_local_skill_unavailable' && localSkillRestorePoint) {
          restoreRejectedLocalSkillSubmission({ ...submittedWritingStyleScope, sessionId: submittedSessionId,
            task: submittedDraft, attachments: submittedAttachments, skillInvocation: submittedSkillInvocation,
            selectionContext: submittedPanelState.selectionContext }, localSkillRestorePoint);
        }
        const translated = translateRawError(response.error.message, { mode: submittedMode, locale: getLocale(), code: response.error?.code });
        // Structured FailureReason (§9.7): split bridge-availability from
        // Codex-side errors. `native_connection_failed` / `native_unavailable`
        // / `native_update_required` indicate the bridge itself is missing,
        // so emit `native_bridge_unavailable` (blocked, retryable). Recognized
        // Codex failures retain their specific cause; only unmatched errors
        // fall back to `codex_no_usable_result` (error, retryable).
        // Map native/codex failures onto their SPECIFIC catalog codes — the
        // timeout/not-found/output-limit entries (and their bilingual next
        // steps) existed but were never emitted, so everything collapsed into
        // "no usable result" and pointed users at the wrong recovery.
        const runErrorMessage = String(response.error?.message || '');
        const codexRunFailure = translated.failureCode === 'codex_context_limit'
          ? buildContentFailure('codex_context_limit', { path: 'codex.run' }, {
            technicalMessage: runErrorMessage,
            evidence: { errorCode: response.error?.code || '' }
          })
          : response.error?.code === 'codex_local_skill_unavailable'
          ? buildContentFailure('codex_local_skill_unavailable', { path: 'codex.run' }, { technicalMessage: runErrorMessage })
          : translated.failureCode === 'codex_local_skills_failed'
            ? buildContentFailure('codex_local_skills_failed', { path: 'codex.run' }, { technicalMessage: runErrorMessage })
          : response.error?.code === 'native_execution_interrupted'
          ? buildContentFailure('native_request_failed', { path: 'codex.run' }, {
            // The host IS installed — the request was interrupted mid-flight.
            // Telling this user to reinstall would be a misdiagnosis.
            technicalMessage: runErrorMessage,
            evidence: { errorCode: response.error?.code || '', interrupted: true }
          })
          : isNativeBridgeUnavailableError(response.error)
            ? buildContentFailure('native_bridge_unavailable', { path: 'codex.run' }, {
              technicalMessage: runErrorMessage,
              evidence: {
                handshakeFailed: true,
                errorCode: response.error?.code || ''
              }
            })
          : response.error?.code === 'project_locked'
            ? buildContentFailure('codex_project_locked', { path: 'codex.run' }, {
              technicalMessage: runErrorMessage,
              evidence: {
                errorCode: response.error?.code || ''
              }
            })
          : /Codex CLI was not found/i.test(runErrorMessage)
            ? buildContentFailure('codex_not_found', { path: 'codex.run' }, {
              technicalMessage: runErrorMessage,
              evidence: { errorCode: response.error?.code || '' }
            })
          : /idle watchdog/i.test(runErrorMessage)
            ? buildContentFailure('codex_timeout', { path: 'codex.run' }, {
              technicalMessage: runErrorMessage,
              evidence: { errorCode: response.error?.code || '' }
            })
          : /output limit exceeded/i.test(runErrorMessage)
            ? buildContentFailure('codex_output_limit', { path: 'codex.run' }, {
              technicalMessage: runErrorMessage,
              evidence: { errorCode: response.error?.code || '' }
            })
          : buildContentFailure('codex_no_usable_result', { path: 'codex.run' }, {
            technicalMessage: runErrorMessage,
            evidence: {
              hasFinalReport: false,
              errorCode: response.error?.code || ''
            }
        });
        appendRunEvent({
          title: translated.conclusion,
          status: response.error?.code === 'project_locked' ? 'blocked' : 'failed',
          technicalDetail: response.error,
          failure: codexRunFailure
        });
        appendTechnicalEvent({
          type: 'native.error',
          title: 'Native bridge error',
          status: response.error?.code === 'project_locked' ? 'blocked' : 'failed',
          detail: response.error
        });
        appendCompletionReport({
          conclusion: translated.conclusion, conclusionKey: translated.conclusionKey,
          status: response.error?.code === 'project_locked' ? 'blocked' : 'failed',
          operations: [],
          applyResults: [],
          nextStep: translated.nextStep,
          errorMessage: response.error.message,
          mode: submittedMode,
          failure: codexRunFailure
        });
        await finalizeAuditRecord(runAuditDraft, {
          resultStatus: 'failed',
          sensitiveFindings: sensitiveFindings.findings,
          blockedFiles: [{ path: 'codex.run', reason: response.error?.code || response.error?.message || 'native_error' }]
        });
        await finishRunView(response.error?.code === 'project_locked'
          ? tx('Codex task already running', 'Codex 任务正在运行')
          : tx('Local Codex error', '本地 Codex 错误'), 'failed');
        return;
      }

      throwIfRunCancellationRequested();
      const assistantMessage = response.result.assistantMessage || getAssistantAnswerForCurrentRun();
      const syncChanges = response.result.syncChanges || [];
      // Structured FailureReason §9.7: the bridge returned ok, but the Codex
      // payload is empty of both visible content and any actionable sync
      // operation. Emit `codex_no_usable_result` (error, retryable) so the
      // run-card / final-report renderers can surface a canonical reason.
      if (!hasUsableCodexResult({ assistantMessage, syncChanges, result: response.result })) {
        const emptyFailure = buildContentFailure('codex_no_usable_result', { path: 'codex.run' }, {
          evidence: {
            hasFinalReport: Boolean(assistantMessage),
            syncChangeCount: Array.isArray(syncChanges) ? syncChanges.length : 0,
            hadUnsupportedChanges: Array.isArray(response.result?.unsupportedChanges)
              ? response.result.unsupportedChanges.length > 0
              : false
          }
        });
        const emptyResultConclusion = tx(
          'Codex completed, but it produced no assistant response and no local file changes.',
          'Codex 已完成，但没有产生助手回复，也没有产生本地文件改动。'
        );
        const emptyResultNextStep = tx(
          'Retry with an explicit target such as @file:main.tex and the exact section to edit; if this repeats, open Technical Details.',
          '请带上明确目标重试，例如 @file:main.tex 和具体要修改的小节；如果重复出现，请打开 Technical Details。'
        );
        appendRunEvent({
          title: emptyResultConclusion,
          status: 'failed',
          failure: emptyFailure
        });
        appendCompletionReport({ conclusionKey: 'empty_result',
          conclusion: emptyResultConclusion,
          status: 'failed',
          operations: [],
          applyResults: [],
          nextStep: emptyResultNextStep,
          mode: submittedMode,
          failure: emptyFailure
        });
        await finalizeAuditRecord(runAuditDraft, {
          resultStatus: 'failed',
          sensitiveFindings: sensitiveFindings.findings,
          blockedFiles: [{ path: 'codex.run', reason: 'codex_no_usable_result' }]
        });
        await finishRunView(tx('Local Codex returned nothing usable', '本地 Codex 没有返回可用结果'), 'failed');
        return;
      }
      const writebackProject = useExistingMirror
        ? mergeProjectWithSyncChangeBaseFiles(project, syncChanges)
        : project;
      const syncOutcome = await applySyncChangesToOverleaf(syncChanges, writebackProject, {
        assistantMessage,
        unsupportedChanges: response.result.unsupportedChanges || [],
        mode: submittedMode,
        requireReviewing: submittedRequireReviewing,
        autoRecompile: executionSnapshot.autoRecompile
      });
      runSettlementPersistence.applyToCurrentRun(syncOutcome.settlement);
      if (runCancellationRequested) {
        throw createRunCancellationError();
      }
      await finalizeAuditRecord(runAuditDraft, {
        ...(syncOutcome.audit || {}),
        sensitiveFindings: sensitiveFindings.findings,
        resultStatus: syncOutcome.hasSkippedOperations ? 'completed_with_skips' : 'completed'
      });

      await finishRunView(
        syncOutcome.hasSkippedOperations ? tx('Sync completed with skipped items', '同步完成但有跳过项') : tx('Sync completed', '同步完成'),
        syncOutcome.hasSkippedOperations ? 'failed' : 'completed'
      );
      // Welcome-panel + write-guard:
      // post-navigation run settlement. If the user navigated away from
      // run.runProjectId before this run finished, override the run.status
      // with one of background_completed / needs_review_after_navigation /
      // abandoned_after_navigation and persist to the ORIGINAL project's
      // session record (NOT activeProjectId). The completed record is found
      // by the runProjectId-captured `currentRunView.recordId` /
      // `currentRunView.sessionId` pair.
      try {
        // After navigation, the in-memory state may have been rebound to
        // the new project's storage key (via `reloadProjectRunHistory`), so
        // `findRunRecord` can return null. Fall back to a minimal
        // descriptor built from `currentRunView` — `settleRunAfterNavigation`
        // only reads `run.runProjectId` for classification, and
        // `persistPostNavigationRunStatus` re-fetches the canonical record
        // by `currentRunView.sessionId` through StorageDb on the
        // navigation-divergent path.
        const finishedRunRecord = currentRunView
          ? (findRunRecord(currentRunView.recordId, currentRunView.sessionId) || {
            id: currentRunView.recordId,
            runProjectId: currentRunView.runProjectId
          })
          : null;
        if (finishedRunRecord) {
          // Spec §5.7.1: pass the full syncOutcome — including
          // hasSkippedOperations and the raw `applied` — so the settlement
          // can catch early-return branches and unrecognized skip codes.
          const postNavigationStatus = settleRunAfterNavigation(finishedRunRecord, syncOutcome);
          if (postNavigationStatus) {
            await persistPostNavigationRunStatus(
              finishedRunRecord,
              postNavigationStatus,
              syncOutcome.settlement
            );
          }
        }
      } catch (_settlementError) {
        // Settlement failures must never crash the run-completion path.
      }
      try {
        const runSessionForHistory = findSessionById(runSessionId) || getActiveSession(state);
        const rawAssistantMessage = assistantMessage;
        const rawSyncOutcome = syncOutcome;
        const rawSyncChanges = syncChanges;
        {
          const assistantMessage = sanitizeAssistantVisibleText(rawAssistantMessage);
          const syncOutcome = sanitizeAssistantVisibleValue(rawSyncOutcome);
          const syncChanges = sanitizeAssistantVisibleValue(rawSyncChanges);
          const updatedSession = recordSessionResult(runSessionForHistory, {
            task: sanitizeAssistantVisibleText(task),
            result: buildSessionHistoryResult({
              assistantMessage,
              syncOutcome,
              syncChanges
            })
          });
          replaceSessionInState(updatedSession);
        }

        const returnedThreadId = response.result?.threadId || '';
        if (returnedThreadId && returnedThreadId !== codexThreadId) {
          updateSessionById(runSessionId, { codexThreadId: returnedThreadId });
          const StorageDb = Modules.StorageDb;
          // The live session is saved below with its latest draft. Writing an
          // older DB snapshot here can give stale text a newer timestamp.
          if (StorageDb && !findSessionById(runSessionId)) {
            const record = await StorageDb.getRecord('sessions', runSessionId, { adopt: false });
            if (record) {
              record.codexThreadId = returnedThreadId;
              record.updatedAt = new Date().toISOString();
              await StorageDb.putRecord('sessions', record, { adopt: false });
            }
          }
        }

        await saveState();
        applyStateToPanel({ preserveScroll: true });
      } catch (persistenceError) {
        appendRunEvent({
          title: tx('Codex result was generated, but saving local session history failed.', 'Codex 结果已生成，但保存本地会话记录失败。'),
          status: 'failed',
          detail: {
            [tx('Impact', '影响')]: tx('This answer is already visible. After reloading, this run may not appear in session history.', '本轮回答已经显示；刷新页面后，这轮可能不会出现在历史 session 里。')
          },
          technicalDetail: {
            message: persistenceError.message
          }
        });
      }
    } catch (error) {
      if (runCancellationRequested || isRunCancellationError(error)) {
        if (currentRunView?.reviewingUnavailablePreflight) {
          appendCompletionReport({ conclusionKey: 'launch_not_started',
            conclusion: tx('This task did not start: Codex did not run and no files were written.', '这轮任务没有开始：Codex 没有运行，也没有写入文件。'),
            status: 'blocked', operations: [], applyResults: [],
            failure: buildContentFailure('reviewing_unavailable', {}, {
              changedDocument: false, evidence: { declinedChoice: true }
            }),
            nextStep: tr('failureReason_reviewing_unavailable_cancelled_next') });
        } else {
          runSettlementPersistence.applyToCurrentRun(error.writebackOutcome?.settlement);
          appendRunCancelledReport(error.writebackOutcome);
        }
        await finishRunView(tx('Cancelled', '已取消'), 'cancelled');
        void finalizeAuditRecord(runAuditDraft, { resultStatus: 'cancelled' });
        return;
      }
      if (compact) {
        const key = error.code === 'codex_compact_unsupported' ? 'compactUnsupported'
          : ['project_locked', 'codex_compact_thread_busy'].includes(error.code) ? 'compactBusy' : 'compactFailed';
        const contextLimit = FailureReasons.isContextLimitError(error.message, error.code)
          ? translateRawError(error.message, { locale: getLocale(), code: error.code }) : null;
        const failure = contextLimit ? buildContentFailure('codex_context_limit', { path: 'codex.run' }, {
          technicalMessage: error.message, evidence: { errorCode: error.code || '' }
        }) : undefined;
        const conclusion = contextLimit?.conclusion || tr(key);
        appendRunEvent({ title: conclusion, status: 'failed', failure,
          technicalDetail: { code: error.code || '', message: error.message } });
        appendCompletionReport({ conclusion, conclusionKey: contextLimit?.conclusionKey || (key === 'compactUnsupported'
          ? 'compact_unsupported' : key === 'compactBusy' ? 'compact_busy' : 'compact_failed'),
          nextStep: contextLimit?.nextStep, failure,
          status: 'failed', mode: 'ask', operations: [], applyResults: [] });
        await finishRunView(conclusion, 'failed');
        return;
      }
      // codexReturned: assistantMessage arrived on the stream before the
      // exception escaped, so Codex's answer is preserved in the conversation
      // — the fallback conclusion must reflect that instead of saying
      // 'local Codex returned no usable result'.
      const codexReturned = Boolean(getAssistantAnswerForCurrentRun());
      const translated = translateRawError(error.message, { mode: submittedMode, locale: getLocale(), code: error.code, codexReturned });
      // When translateRawError maps the raw error to a FailureReason code,
      // attach the structured failure to the run-event and completion-report
      // so the run record carries machine-readable failure data alongside
      // the user-visible text.
      const translatedFailure = translated.failureCode
        ? buildContentFailure(translated.failureCode, { path: 'task' }, {
            technicalMessage: error.message,
            evidence: { errorMessage: error.message }
          })
        : null;
      appendRunEvent({
        title: translated.conclusion,
        status: 'failed',
        technicalDetail: {
          message: error.message
        },
        failure: translatedFailure
      });
      appendTechnicalEvent({
        type: 'task.exception',
        title: 'Task exception',
        status: 'failed',
        detail: {
          message: error.message
        }
      });
      appendCompletionReport({
        conclusion: translated.conclusion, conclusionKey: translated.conclusionKey,
        status: 'failed',
        operations: [],
        applyResults: [],
        nextStep: translated.nextStep,
        errorMessage: error.message,
        mode: submittedMode,
        failure: translatedFailure
      });
      await finalizeAuditRecord(runAuditDraft, {
        resultStatus: 'failed',
        blockedFiles: [{ path: 'task', reason: error.message }]
      });
      await finishRunView(tx('Task failed', '任务失败'), 'failed');
      // A failed initial card render must still leave a visible terminal record.
      if (currentRunView?.sessionId === state.activeSessionId && !getCurrentRunViewForRender()) {
        renderRunHistory({ preserveScroll: true });
      }
    } finally {
      const settledView = currentRunView;
      const settledRecord = settledView ? findRunRecord(settledView.recordId, settledView.sessionId) : null;
      const settlement = {
        sessionId: settledView?.sessionId || '',
        status: settledView?.terminalStatus || settledRecord?.status || 'failed',
        queueItemId: settledView?.queueItemId || '',
        requestId: settledView?.nativeRequestId || '',
        continueQueue: runCancellationRequested
      };
      setRunning(false);
      nativeChannel.clearActiveRequest();
      stopRunElapsedTick();
      await flushQueuedSaveState().catch(() => {});
      // The card is already settled. Retain the owner while Native stops so
      // neither ordinary promotion nor a deferred session start races its lock.
      if (settlement.continueQueue) {
        settlement.continueQueue = await waitForCancelledNativeRun(settledView);
      }
      currentRunView = null;
      runCancellationRequested = false;
      runCancellationController = null;
      activeTurnControl.release(settlement.requestId);
      if (isExperimentalOtEnabled()) {
        try { await resumeOtWarmMirror('run-settled'); }
        catch (_error) { updateOtStatusDisplay('unavailable'); }
      }
      if (settlement.requestId) {
        activeTurnControl.acknowledge(settlement.requestId).catch(() => {});
      }
      runQueueScheduler?.afterSettlement(settlement).catch(() => {});
    }
  }

  async function runSkillInstallerTask({
    task,
    runSessionId,
    runAuditDraft,
    submittedMode,
    submittedCustomInstructions,
    submittedSkillLoadingSettings,
    submittedEnabledLocalSkillIds,
    submittedEnabledSkillIds,
    submittedAttachments,
    submittedSkillInvocation,
    executionSnapshot
  }) {
    appendRunEvent({
      title: tx('Starting the Codex skill installer.', '正在启动 Codex skill installer。'),
      status: 'running'
    });
    const codexThreadId = currentRunView?.codexThreadId || '';
    const params = {
      projectId: getCurrentProjectId(),
      mode: submittedMode,
      task,
      model: executionSnapshot.model,
      reasoningEffort: executionSnapshot.reasoningEffort,
      speedTier: executionSnapshot.speedTier,
      session: currentRunView?.sessionContext,
      locale: getLocale(),
      clientRunId: currentRunView?.recordId || '',
      clientSessionId: runSessionId,
      accountScopeId: currentRunView?.runAccountScopeId || '',
      threadId: codexThreadId || undefined,
      customInstructions: submittedCustomInstructions || undefined,
      loadCodexLocalSkills: submittedSkillLoadingSettings?.loadCodexLocalSkills !== false,
      loadCodexOverleafSkills: submittedSkillLoadingSettings?.loadCodexOverleafSkills !== false,
      enabledCodexLocalSkillIds: submittedEnabledLocalSkillIds,
      enabledCodexOverleafSkillIds: submittedEnabledSkillIds,
      attachments: submittedAttachments.length ? submittedAttachments : undefined,
      skillInvocation: submittedSkillInvocation,
      focusFiles: [],
      skipMirrorSync: true
    };

    const response = await sendTrackedCodexRun(params);

    if (!response.ok) {
      if (runCancellationRequested || isRunCancellationError(response.error)) {
        appendRunCancelledReport();
        await finalizeAuditRecord(runAuditDraft, { resultStatus: 'cancelled' });
        await finishRunView(tx('Cancelled', '已取消'), 'cancelled');
        return;
      }
      const translated = translateRawError(response.error.message, { mode: submittedMode, locale: getLocale() });
      // Attach the structured FailureReason from the regex → catalog mapping
      // (when translateRawError surfaces one) so the skill-installer failure
      // path carries the same machine-readable shape the run-card consumes.
      const translatedFailure = translated.failureCode
        ? buildContentFailure(translated.failureCode, { path: 'skill.install' }, {
            technicalMessage: response.error.message,
            evidence: { errorCode: response.error?.code || '' }
          })
        : null;
      appendRunEvent({
        title: translated.conclusion,
        status: 'failed',
        technicalDetail: response.error,
        failure: translatedFailure
      });
      appendCompletionReport({
        conclusion: translated.conclusion, conclusionKey: translated.conclusionKey,
        status: 'failed',
        operations: [],
        applyResults: [],
        nextStep: translated.nextStep,
        errorMessage: response.error.message,
        mode: submittedMode,
        failure: translatedFailure
      });
      await finalizeAuditRecord(runAuditDraft, {
        resultStatus: 'failed',
        blockedFiles: [{ path: 'skill-installer', reason: response.error?.code || response.error?.message || 'native_error' }]
      });
      await finishRunView(tx('Skill installer failed', 'Skill installer 失败'), 'failed');
      return;
    }

    const assistantMessage = response.result?.assistantMessage || getAssistantAnswerForCurrentRun();
    appendCompletionReport({ conclusionKey: !assistantMessage ? 'skill_installer_completed' : undefined,
      conclusion: assistantMessage || tx('Skill installer completed.', 'Skill installer 已完成。'),
      status: 'completed',
      operations: [],
      applyResults: [],
      nextStep: tx('Restart Codex Overleaf or start a new run if the installed skill is not visible immediately.', '如果新安装的 skill 没有立刻出现，请重启 Codex Overleaf 或开始新一轮运行。'),
      mode: submittedMode
    });
    await finalizeAuditRecord(runAuditDraft, { resultStatus: 'completed' });
    await finishRunView(tx('Skill installer completed', 'Skill installer 已完成'), 'completed');

    const runSessionForHistory = findSessionById(runSessionId) || getActiveSession(state);
    const rawAssistantMessage = assistantMessage;
    const rawSyncOutcome = { summaryLine: 'skill installer completed' };
    const rawSyncChanges = [];
    {
      const assistantMessage = sanitizeAssistantVisibleText(rawAssistantMessage);
      const syncOutcome = sanitizeAssistantVisibleValue(rawSyncOutcome);
      const syncChanges = sanitizeAssistantVisibleValue(rawSyncChanges);
      const updatedSession = recordSessionResult(runSessionForHistory, {
        task: sanitizeAssistantVisibleText(task),
        result: buildSessionHistoryResult({
          assistantMessage,
          syncOutcome,
          syncChanges
        })
      });
      replaceSessionInState(updatedSession);
    }

    const returnedThreadId = response.result?.threadId || '';
    if (returnedThreadId && returnedThreadId !== codexThreadId) {
      updateSessionById(runSessionId, { codexThreadId: returnedThreadId });
      const StorageDb = Modules.StorageDb;
      // The installer already finished; a later envelope conflict only delays this save.
      if (findSessionById(runSessionId)) {
        saveStateSoon();
      } else if (StorageDb) {
        const record = await StorageDb.getRecord('sessions', runSessionId, { adopt: false });
        if (record) {
          record.codexThreadId = returnedThreadId;
          await StorageDb.putRecord('sessions', record, { adopt: false });
        }
      }
    }
  }

  async function preflightWriteSafety(options = {}) {
    const mode = options.mode || state.mode;
    const requireReviewing = typeof options.requireReviewing === 'boolean'
      ? options.requireReviewing
      : state?.requireReviewing === true;
    if (mode === 'ask') {
      return { ok: true, skipped: true };
    }
    appendRunEvent({
      title: requireReviewing
        ? tx('Checking Overleaf Reviewing/Track Changes before starting.', '正在确认 Overleaf 留痕状态。')
        : tx('Checking Overleaf Editing mode before starting.', '正在确认 Overleaf Editing 模式。'),
      status: 'running'
    });

    const owner = currentRunView;
    const signal = runCancellationController?.signal;
    const isCurrent = () => owner === currentRunView && !signal?.aborted && !runCancellationRequested
      && owner?.runProjectId === getCurrentProjectId() && owner?.runAccountScopeId === cachedAccountScopeId;
    const assertCurrent = () => { if (!isCurrent()) throw createRunCancellationError(); };
    assertCurrent();
    if (requireReviewing) {
      // Another tab may have observed this project's capability since hydration.
      const prefs = await Modules.StorageMigration.loadPrefs(owner.runAccountScopeId, owner.runProjectId);
      assertCurrent();
      const incoming = prefs?.reviewingAvailabilityByProject?.[owner.runProjectId];
      const current = projectSettingsCoordinator.getReviewingAvailability();
      if (incoming && (!current || incoming.observedAt > current.observedAt
        || (incoming.observedAt === current.observedAt && incoming.status === 'available'))) {
        state = { ...state, reviewingAvailabilityByProject: {
          ...state.reviewingAvailabilityByProject, [owner.runProjectId]: incoming
        } };
        syncProbeStatus();
      }
    }
    let result = await Modules.Reviewing.resolveWritePolicy({ requireReviewing,
      knownUnavailable: isReviewingKnownUnavailable() }, {
      assertCurrent,
      ensureMode: async required => {
        try {
          return await callPageBridge(required ? 'ensureReviewing' : 'ensureEditing', {
            waitMs: 1800, runProjectId: owner.runProjectId
          });
        } catch (error) {
          assertCurrent();
          return { ok: false, code: error?.code, reason: error?.message, reviewing: null };
        }
      },
      observe: async (status, evidence) => {
        projectSettingsCoordinator.observeReviewingAvailability(status, evidence);
        syncProbeStatus();
        // Publish a detected paywall before waiting for the user's decision.
        if (status === 'unavailable') await flushQueuedSaveState({ requireDurable: true });
        assertCurrent();
      },
      choose: () => {
        owner.reviewingUnavailablePreflight = true;
        return showPluginConfirm({
          title: tr('reviewingUnavailableTitle'),
          message: tr('reviewingUnavailableChoiceMessage'),
          choices: [
            { value: 'continue', label: tr('reviewingUnavailableContinue') },
            { value: 'disable', label: tr('reviewingUnavailableDisable'), secondary: true },
            { value: 'cancel', label: tr('confirmDefaultCancel') }
          ],
          signal, isCurrent, timeoutMs: REVIEWING_CONFIRM_TIMEOUT_MS
        });
      },
      applyUntracked: choice => { assertCurrent(); return options.onUntracked(choice); }
    });
    if (result.ok) owner.reviewingUnavailablePreflight = false;
    const effectiveRequireReviewing = result.requireReviewing ?? requireReviewing;

    if (result?.ok) {
      appendRunEvent({
        title: effectiveRequireReviewing
          ? (result.activated
            ? tx('Overleaf Reviewing/Track Changes is now on. Starting the task.', '已开启 Overleaf 留痕，开始处理任务。')
            : tx('Overleaf Reviewing/Track Changes is already on. Starting the task.', 'Overleaf 留痕已经开启，开始处理任务。'))
          : (result.activated
            ? tx('Switched to Overleaf Editing. Starting the task.', '已切到 Overleaf Editing，开始处理任务。')
            : tx('Overleaf is already in Editing mode. Starting the task.', 'Overleaf 已在 Editing 模式，开始处理任务。')),
        status: 'completed'
      });
      return result;
    }

    const unavailable = result?.code === 'reviewing_unavailable';
    if (unavailable && !result.failure) result.failure = buildContentFailure('reviewing_unavailable', {}, {
      changedDocument: false, evidence: result.evidence
    });
    const reason = unavailable ? tr('failureReason_reviewing_unavailable_user') : localizeVisibleReason(result?.reason || (effectiveRequireReviewing
      ? tx('Overleaf did not return track changes status', 'Overleaf 没有返回留痕状态')
      : tx('Overleaf did not return Editing mode status', 'Overleaf 没有返回 Editing 模式状态')));
    // Affirmative choices retain trackingDecision even if the Editing check fails.
    const declinedReviewingChoice = owner.reviewingUnavailablePreflight === true && !result.trackingDecision;
    const reportFailure = unavailable && declinedReviewingChoice
      ? buildContentFailure('reviewing_unavailable', {}, {
        ...result.failure, changedDocument: false,
        evidence: { ...result.failure?.evidence, declinedChoice: true }
      }) : result?.failure;
    const nextStep = unavailable ? tr(declinedReviewingChoice
      ? 'failureReason_reviewing_unavailable_cancelled_next'
      : 'failureReason_reviewing_unavailable_next') : effectiveRequireReviewing
      ? tx(
        'You may not have permission, or this Overleaf page did not expose the Reviewing switch. Switch to Reviewing manually and retry, or turn off Track before writing.',
        '你可能没有权限，或 Overleaf 当前页面没有暴露切换入口。可以手动切到 Reviewing 后重试，或关闭“留痕”再运行。'
      )
      : tx(
        'You may not have permission, or this Overleaf page did not expose the Editing switch. Switch to Editing manually and retry.',
        '你可能没有权限，或 Overleaf 当前页面没有暴露切换入口。请在 Overleaf 手动切到 Editing 后重试。'
      );
    appendRunEvent({
      title: effectiveRequireReviewing
        ? tx('Task not started: could not enable Overleaf Reviewing/Track Changes.', '任务未开始：无法开启 Overleaf 留痕。')
        : tx('Task not started: could not switch to Overleaf Editing.', '任务未开始：无法切换到 Overleaf Editing。'),
      status: 'failed',
      detail: {
        [tr('detailReason')]: reason,
        [tr('detailNext')]: nextStep
      },
      technicalDetail: {
        reason, code: result?.code, evidence: result?.evidence, failure: result?.failure,
        reviewing: result?.reviewing || null
      }
    });
    appendCompletionReport({ conclusionKey: 'launch_not_started',
      conclusion: tx('This task did not start: Codex did not run and no files were written.', '这轮任务没有开始：Codex 没有运行，也没有写入文件。'),
      status: 'blocked',
      operations: [],
      applyResults: [],
      nextStep,
      reason: result?.code, failure: reportFailure
    });
    const finishTitle = effectiveRequireReviewing
      ? tx('Not started: could not enable Track Changes', '未开始：无法开启留痕')
      : tx('Not started: could not switch to Editing', '未开始：无法切换到 Editing');
    await finishRunView(finishTitle, 'failed');
    return {
      ...result, ok: false,
      reason: result?.code || reason,
      reviewing: result?.reviewing || null
    };
  }

  function buildSessionHistoryResult({ assistantMessage = '', syncOutcome = {}, syncChanges = [] } = {}) {
    return runController.buildSessionHistoryResult({ assistantMessage, syncOutcome, syncChanges, locale: getLocale() });
  }

  function truncateSessionHistoryText(value, maxLength) {
    return runController.truncateSessionHistoryText(value, maxLength);
  }

  function safeRunTask(options = {}) {
    if (sessionManager.isTransitioning()) return;
    if (updateIdleClient?.isApplying()) {
      showPluginToast(tx('An update is being applied. Codex will be available again after reload.', '正在应用更新，重新加载后即可继续使用 Codex。'), { status: 'info' });
      return;
    }
    const submittedCompactCommand = options.operation !== 'compact'
      && panel?.querySelector('[data-task]')?.value.trim() === '/compact';
    const compact = options.operation === 'compact' || submittedCompactCommand;
    if (compact && (currentRunView || runSubmissionPending)) {
      showPluginToast(tr('compactBusy'), { status: 'info' });
      return;
    }
    if (currentRunView) {
      return queueComposerInput();
    }
    if (runSubmissionPending) return;
    runSubmissionPending = true;
    runTask(compact ? { operation: 'compact', consumeCompactDraft: options.consumeCompactDraft === true || submittedCompactCommand } : {}).catch(error => {
      if (!currentRunView) {
        setRunning(false);
        nativeChannel.clearActiveRequest();
        stopRunElapsedTick();
        runCancellationController = null;
      }
      console.error('[codex-overleaf] failed to start task', error);
      appendPlainLog(tx(`Could not start Codex task: ${localizeVisibleReason(error.message)}`, `无法启动 Codex 任务：${localizeVisibleReason(error.message)}`));
    }).finally(() => { runSubmissionPending = false; });
  }

  const runGuidanceController = Modules.RunGuidanceController.create({
    findRunRecord, getCurrentRunView: () => getCurrentRunViewForRender(),
    getActiveSessionId: () => state?.activeSessionId,
    getScope: () => ({ accountScopeId: cachedAccountScopeId, projectId: getCurrentProjectId(), generation: spaRouteGeneration }),
    getSessionCreatedAt: sessionId => findSessionById(sessionId)?.createdAt,
    getRunRoot: target => target.sessionId === state?.activeSessionId
      ? panel?.querySelector(`[data-run-id="${cssEscape(target.recordId)}"]`) : null,
    onRecordChanged: target => updateSessionById(target.sessionId, {}),
    onPresentationError: error => console.warn('[codex-overleaf] guidance presentation failed', error),
    RunGuidanceView: Modules.RunGuidanceView, tx, maxRunEvents: MAX_RUN_EVENTS,
    revealGuidance: row => runTimelineView.revealGuidance(row),
    renderRunEvent, cssEscape, bumpUnreadIfDetached
  });

  function initializeRunQueueScheduler() {
    runInputCoordinator = RunQueueScheduler.createCoordinator({
      getSession: sessionId => findSessionById(sessionId),
      getActiveSession: () => getActiveSession(state),
      setQueue: (sessionId, pendingInputs) => updateSessionById(sessionId, { pendingInputs }),
      getCurrentRun: () => currentRunView,
      canStart: canStartQueuedSession,
      readInputs: readPanelInputs,
      getTask: () => panel?.querySelector('[data-task]')?.value || '',
      hasAttachments: () => getComposerAttachmentsForRun().length > 0,
      capturePayload: () => ({
        ...RunExecutionSnapshot.toQueuePayload(captureCurrentExecutionSnapshot()),
        submissionContext: RunInputQueue.normalizeSubmissionContext({
          customInstructions: getCustomInstructionsForCurrentProject(),
          skillLoadingSettings: getSkillLoadingSettings(),
          skillInvocation: getComposerSkillInvocationForRun(),
          enabledCodexOverleafSkillIds: getEnabledCodexOverleafSkillIds(),
          enabledCodexLocalSkillIds: getEnabledCodexLocalSkillIds()
        })
      }),
      prepareClaim: () => providerSettingsCoordinator.ensureLoaded(),
      resolveExecutionSnapshot: snapshot => RunExecutionSnapshot.resolveForExecution(snapshot, {
        catalog: providerSettingsCoordinator.getCatalog()
      }),
      clearTask: () => {
        panel.querySelector('[data-task]').value = '';
        composerDraftEditedHere = false;
        selectionContextView.clear();
        updateSessionById(state.activeSessionId, { task: '' });
        autosizeTaskTextarea();
        syncComposerSendAvailability();
      },
      applyQueuedInput: async item => {
        RunExecutionSnapshot.resolveForExecution(
          RunExecutionSnapshot.fromQueuePayload(item.payload),
          { catalog: providerSettingsCoordinator.getCatalog() }
        );
        // Promotion uses its captured snapshot; this line still describes the current draft.
        syncProbeStatus();
      },
      run: item => runTask({ queuedInput: item }),
      getGuideScope: () => ({ projectId: getCurrentProjectId(), accountScopeId: cachedAccountScopeId, generation: spaRouteGeneration }),
      isGuideCancelled: () => runCancellationRequested || runCancellationController?.signal?.aborted === true,
      preflightGuide: ({ task, assertCurrent }) => runSensitivePreflight({
        task, project: { files: [] }, rules: getGovernanceRulesForCurrentProject(),
        guidance: true, useExistingMirror: false, assertCurrent
      }),
      sendSteer: (params, context) => nativeCompatibilityController.sendBackgroundNative({ method: 'codex.steer', params }, context),
      getContainer: () => panel?.querySelector('[data-pending-inputs]'),
      createView: options => PendingInputView.create(options),
      appendEvent: (title, status) => appendRunEvent({ title, status }),
      previewGuidance: runGuidanceController.preview,
      clearGuidancePreview: runGuidanceController.clearPreview,
      appendGuidance: runGuidanceController.upsert,
      removeGuidance: runGuidanceController.remove,
      toast: (message, status) => showPluginToast(message, { status }),
      tr,
      save: persistenceOptions => saveState(persistenceOptions),
      saveSoon: persistenceOptions => saveStateSoon(120, persistenceOptions),
      randomUUID: () => crypto.randomUUID()
    });
    runQueueScheduler = runInputCoordinator.scheduler;
  }

  function captureCurrentExecutionSnapshot(submitted = {}) {
    const requestedProviderId = submitted.providerId || state?.providerId || 'builtin';
    const selection = providerSettingsCoordinator.getRunSelection(requestedProviderId);
    const providerId = selection?.providerId || requestedProviderId;
    const selectedContext = Object.prototype.hasOwnProperty.call(submitted, 'selectionContext')
      ? submitted.selectionContext : selectionContextView.capture();
    const selectedPaths = submitted.focusFiles ?? getActiveFocusFiles();
    return RunExecutionSnapshot.capture({
      mode: submitted.mode ?? state?.mode,
      providerId,
      providerRevision: selection?.providerRevision,
      model: submitted.model ?? state?.model,
      reasoningEffort: submitted.reasoningEffort ?? state?.reasoningEffort,
      speedTier: submitted.speedTier ?? state?.speedTier,
      autoRecompile: submitted.autoRecompile ?? state?.autoRecompile !== false,
      requireReviewing: submitted.requireReviewing ?? state?.requireReviewing === true,
      focusFiles: selectedContext?.mode === 'edit' && selectedPaths.length
        ? [...new Set([...selectedPaths, selectedContext.path])] : selectedPaths,
      selectionContext: selectedContext,
      writingStyle: Object.prototype.hasOwnProperty.call(submitted, 'writingStyle')
        ? submitted.writingStyle : writingStyleSettings.capture()
    }, {
      source: 'submitted',
      requireProviderRevision: providerId !== 'builtin'
    });
  }

  function canStartQueuedSession(sessionId) {
    if (state?.activeSessionId !== sessionId || !isProjectEditorRoute(window.location)) return false;
    if (sessionManager.isTransitioning()) {
      deferredSessionStart = { sessionId, scope: getComposerDraftScope() };
      return 'session_transition';
    }
    return true;
  }

  function queueComposerInput() {
    if (sessionManager.isTransitioning()) return;
    if (getSkillLoadingSettings().loadCodexLocalSkills !== false && !Array.isArray(getCodexLocalSkillsCatalog())) {
      primeCodexLocalSkillsCatalog({ required: true }).catch(() => {});
      showPluginToast(tx('Local Codex skills are still loading. Try submitting again when loading finishes.',
        'Codex 本地技能仍在加载，请在加载完成后重新提交。'), { status: 'info' });
      return;
    }
    const invocation = getComposerSkillInvocationForRun();
    if (invocation?.scope === 'codex-local' && !getEnabledCodexLocalSkillIds()?.includes(invocation.id)) {
      showPluginToast(tx('The selected local Codex skill is unavailable or disabled. Select an enabled skill and try again.',
        '所选 Codex 本地技能不可用或已关闭，请选择已启用的技能后重试。'), { status: 'failed' });
      return;
    }
    return runInputCoordinator?.queueComposerInput();
  }

  function renderPendingInputs() {
    return runInputCoordinator?.render();
  }

  async function cancelActiveRun() {
    if (!currentRunView || runCancellationRequested) {
      return;
    }
    runCancellationRequested = true;
    runCancellationController?.abort();
    panel.dataset.cancelling = 'true';
    setRunning(true);
    appendRunEvent({
      title: tx('Cancelling the current Codex task.', '正在中断当前 Codex 任务。'),
      status: 'running'
    });

    // Fire both cancel signals in parallel:
    //   - codex.cancel (native): aborts the Codex CLI if it's still running.
    //   - cancelActiveWrite (page): bumps the page-bridge sequence so the
    //     in-flight writebackRouter loop aborts remaining ops with
    //     codex_cancelled instead of grinding through the rest of the queue.
    // Without the page-side signal, a cancel during writeback waits up to
    // the applyOperations content-side timeout (30s) before the run settles.
    const activeRequestId = currentRunView.nativeRequestId;
    const projectKey = currentRunView?.runProjectId || getCurrentProjectId() || '';

    const cancelTargets = [];
    if (activeRequestId != null && activeRequestId !== '') {
      cancelTargets.push(sendBackgroundNative({
        method: 'codex.cancel',
        params: {
          requestId: activeRequestId,
          projectKey: projectKey || undefined
        }
      }));
    } else {
      // Preparation has no Native run to cancel; the local signal prevents dispatch.
      cancelTargets.push(Promise.resolve(null));
    }
    // The page-side cancel is best-effort — it only matters if a writeback
    // is currently in flight. Swallow errors / unavailable bridge so the
    // native cancel still completes even if the page side is unreachable.
    cancelTargets.push(callPageBridge('cancelActiveWrite', {}).catch(() => ({ ok: false })));

    Promise.allSettled(cancelTargets).then((results) => {
      const nativeResult = results[0];
      const nativeResponse = nativeResult?.status === 'fulfilled' ? nativeResult.value : null;
      if (nativeResponse && !nativeResponse.ok) {
        const message = localizeVisibleReason(nativeResponse?.error?.message || tx('native host did not respond', 'native host 没有响应'));
        appendRunEvent({
          title: tx(`Cancel request was not delivered: ${message}`, `中断请求没有送达：${message}`),
          status: 'failed'
        });
      } else if (nativeResult?.status === 'rejected') {
        appendRunEvent({
          title: tx('Cancel request was not delivered: native host request failed', '中断请求没有送达：native host 请求失败'),
          detail: nativeResult.reason?.message || '',
          status: 'failed'
        });
      }
    });
  }

  function cancelActivePageBridgeRequests() {
    pageBridgeClient.cancelActiveRequests();
  }

  // Recovery path for the case where a previous Codex run leaked the
  // project lock (idle watchdog should normally catch this, but a stuck run
  // from a pre-watchdog binary, or a process bug, could still strand the
  // lock). Sends codex.cancel with `force: true` so the native host
  // unconditionally drops the lock entry when no controller is registered.
  // Surfaced from the completion-report when a codex_project_locked
  // failure is rendered.
  async function forceCancelStuckTaskForCurrentProject() {
    const projectKey = currentRunView?.runProjectId || getCurrentProjectId() || '';
    if (!projectKey) {
      appendPlainLog(tx(
        'Could not force-release: no Overleaf project id available from the current URL.',
        '无法强制释放：当前 URL 没有可解析的 Overleaf 项目 ID。'
      ));
      return { ok: false, reason: 'no_project_key' };
    }
    const response = await sendBackgroundNative({
      method: 'codex.cancel',
      params: {
        projectKey,
        force: true
      }
    });
    appendPlainLog(Modules.RunRecoveryActions.formatForceCancelOutcome(response, tx));
    if (response?.ok !== true && response?.error?.message) appendPlainLog(localizeVisibleReason(response.error.message));
    return response;
  }

  function throwIfRunCancellationRequested() {
    if (runCancellationRequested) throw createRunCancellationError();
  }

  function createRunCancellationError() {
    const error = Object.assign(new Error('Codex run was cancelled by the user'), {
      code: 'codex_cancelled', cancelled: true
    });
    return error;
  }

  function awaitRunStep(value) {
    const signal = runCancellationController?.signal;
    if (!signal) return Promise.resolve(value);
    if (signal.aborted || runCancellationRequested) return Promise.reject(createRunCancellationError());
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback, result) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        callback(result);
      };
      const onAbort = () => settle(reject, createRunCancellationError());
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(value).then(result => settle(resolve, result), error => settle(reject, error));
    });
  }

  async function waitForCancelledNativeRun(runView) {
    const pending = runView?.pendingNativeRun;
    if (!pending) return true;
    const CANCELLED_NATIVE_SETTLEMENT_TIMEOUT_MS = 20000;
    let timer;
    try {
      return await Promise.race([
        pending.then(() => true, () => true),
        new Promise(resolve => {
          timer = setTimeout(() => resolve(false), CANCELLED_NATIVE_SETTLEMENT_TIMEOUT_MS);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function isRunCancellationError(error = {}) {
    return error.code === 'codex_cancelled' || /cancelled by the user|was cancelled/i.test(error.message || '');
  }

  // Detects the bridge-availability subset of native errors (§9.7
  // `native_bridge_unavailable`). The canonical codes are stable; we also
  // pattern-match a final "host disconnected" text-shape because the
  // background bridge wraps Chrome's lastError verbatim.
  function isNativeBridgeUnavailableError(error) {
    if (!error || typeof error !== 'object') return false;
    const code = typeof error.code === 'string' ? error.code : '';
    if (code === 'native_connection_failed') return true;
    if (code === 'native_unavailable') return true;
    if (code === 'native_update_required') return true;
    if (code === 'native_missing') return true;
    // native_execution_interrupted deliberately NOT here: the host is
    // installed and reachable — that error means one in-flight request was
    // cut (host restart, crash mid-run). It maps to native_request_failed
    // with retry semantics, not to "reinstall the bridge".
    const message = typeof error.message === 'string' ? error.message : '';
    return /native host disconnected|specified native messaging host not found|not registered/i.test(message);
  }

  // Detects whether the Codex run result is "usable" in the §9.7
  // `codex_no_usable_result` sense: there must be at least one of
  // (assistantMessage with text, sync changes the runtime can apply, or an
  // explicit unsupportedChanges payload describing what Codex tried to do).
  function hasUsableCodexResult({ assistantMessage, syncChanges, result }) {
    if (typeof assistantMessage === 'string' && assistantMessage.trim().length > 0) {
      return true;
    }
    if (Array.isArray(syncChanges) && syncChanges.length > 0) {
      return true;
    }
    const unsupported = result && Array.isArray(result.unsupportedChanges) ? result.unsupportedChanges : [];
    if (unsupported.length > 0) {
      return true;
    }
    return false;
  }

  async function showThreadResumeFailedPrompt() {
    const confirmed = await showPluginConfirm({
      title: tr('threadResumeFailedTitle'),
      message: tr('threadResumeFailedMessage'),
      confirmLabel: tr('threadResumeNew'),
      cancelLabel: tr('confirmDefaultCancel')
    });
    return confirmed ? 'new' : 'cancel';
  }

  async function showPluginConfirm(options = {}) {
    if (!pluginConfirmController) {
      pluginConfirmController = PanelRenderer.createConfirmController({
        getPanel: () => panel,
        ensurePanelOpen,
        getIconUrl: () => chrome.runtime.getURL('assets/icons/codex-overleaf-dialog-icon.png'),
        tr
      });
    }
    return pluginConfirmController.show(options);
  }

  function getEnabledCodexOverleafSkillIds() {
    const skills = Array.isArray(state?.codexOverleafSkills) ? state.codexOverleafSkills : [];
    // Return the array of skills that are enabled (absent from map or explicitly true).
    return skills
      .map(skill => String(skill?.id || '').trim())
      .filter(id => id && isCodexOverleafSkillEnabled(id));
  }

  function getEnabledCodexLocalSkillIds() {
    if (getSkillLoadingSettings().loadCodexLocalSkills === false) return [];
    const skills = getCodexLocalSkillsCatalog();
    return Array.isArray(skills) ? skills.filter(skill => isCodexLocalSkillEnabled(skill.id, skill)).map(skill => skill.id) : undefined;
  }

  function buildCodexRunParams({
    task,
    project,
    useExistingMirror,
    fileOverlays,
    focusFiles,
    otWarmStart,
    restrictToFocusFiles,
    codexThreadId,
    compileLogContext,
    customInstructions,
    skillLoadingSettings,
    enabledCodexOverleafSkillIds,
    enabledCodexLocalSkillIds,
    attachments,
    skillInvocation,
    submittedMode
  } = {}) {
    const executionSnapshot = currentRunView?.executionSnapshot || captureCurrentExecutionSnapshot();
    const submittedState = RunExecutionSnapshot.applyToState({
      ...state, session: currentRunView?.sessionContext || state.session
    }, executionSnapshot);
    const params = runController.buildCodexRunParams({
      currentProjectId: getCurrentProjectId(),
      state: submittedState,
      locale: getLocale(),
      task,
      project,
      useExistingMirror,
      fileOverlays,
      focusFiles,
      otWarmStart,
      restrictToFocusFiles,
      codexThreadId,
      customInstructions: customInstructions === undefined
        ? getCustomInstructionsForCurrentProject()
        : customInstructions,
      skillLoadingSettings: skillLoadingSettings === undefined
        ? (typeof getSkillLoadingSettings === 'function'
          ? getSkillLoadingSettings()
          : { loadCodexLocalSkills: true, loadCodexOverleafSkills: true })
        : skillLoadingSettings,
      enabledCodexOverleafSkillIds: enabledCodexOverleafSkillIds === undefined
        ? getEnabledCodexOverleafSkillIds() : enabledCodexOverleafSkillIds,
      enabledCodexLocalSkillIds,
      attachments,
      skillInvocation,
      compileLogContext,
      submittedMode
    });
    return {
      ...params,
      clientRunId: currentRunView?.recordId || '',
      clientSessionId: currentRunView?.sessionId || '',
      providerSelection: RunExecutionSnapshot.toProviderSelection(executionSnapshot),
      selectionContext: executionSnapshot.selectionContext || null,
      accountScopeId: currentRunView?.runAccountScopeId || cachedAccountScopeId || '',
      writingStyle: executionSnapshot.writingStyle || null
    };
  }

  async function sendTrackedCodexRun(params) {
    const owner = currentRunView;
    const signal = runCancellationController?.signal;
    const assertCurrent = () => {
      if (signal?.aborted || (owner && owner !== currentRunView)) throw createRunCancellationError();
      throwIfRunCancellationRequested();
      if (owner && (owner.runProjectId !== getCurrentProjectId()
        || owner.runAccountScopeId !== cachedAccountScopeId)) {
        throw Object.assign(createRunCancellationError(), {
          message: 'The active project or account changed before dispatch.'
        });
      }
    };
    const compatibilityGate = await nativeCompatibilityController.ensureForMethod('codex.run', { assertCurrent });
    assertCurrent();
    if (!compatibilityGate.ok) {
      return compatibilityGate.response;
    }
    if (params.operation === 'compact' && compatibilityGate.compatibility?.native?.capabilities?.threadCompact !== true) {
      return { ok: false, error: { code: 'codex_compact_unsupported', message: 'This Native host does not support context compaction.' } };
    }
    const tracked = nativeChannel.sendNativeTracked(nativeCompatibilityController.attachEvidence({
      method: 'codex.run',
      params
    }, compatibilityGate.compatibility));
    if (owner) {
      owner.nativeRequestId = tracked.id;
      // Keep the actual response separate from awaitRunStep's local abort race.
      owner.pendingNativeRun = tracked.promise;
      const record = findRunRecord(owner.recordId, owner.sessionId);
      if (record) {
        record.nativeRequestId = tracked.id;
      }
      activeTurnControl.bind({
        requestId: tracked.id,
        projectKey: owner.runProjectId,
        clientRunId: owner.recordId,
        sessionId: owner.sessionId
      });
      saveStateSoon();
    }
    return tracked.promise.finally(() => {
      if (owner?.pendingNativeRun === tracked.promise) {
        owner.pendingNativeRun = null;
      }
      if (currentRunView?.nativeRequestId === tracked.id) {
        currentRunView.activeTurn = null;
        renderPendingInputs();
      }
    });
  }

  async function recoverInterruptedRunJournals() {
    const projectKey = getCurrentProjectId(), accountScopeId = cachedAccountScopeId;
    const generation = spaRouteGeneration;
    const isCurrent = () => generation === spaRouteGeneration
      && projectKey === getCurrentProjectId() && accountScopeId === cachedAccountScopeId;
    const recovery = await activeTurnControl.recoverJournals({
      projectKey,
      accountScopeId,
      isCurrent,
      onRecheck: async () => {
        if (!isCurrent()) return;
        await recoverInterruptedRunJournals();
        if (isCurrent()) applyStateToPanel();
      },
      requireOwnerLost: Modules.StorageDb.sharedSessionsEnabled?.() === true,
      normalizeInterruptedRun: record => Object.assign(record, Modules.SessionState.normalizeRuns([record], {
        restoreRunningRuns: true,
        locale: getLocale()
      })[0]),
      findSession: findSessionById,
      listSessions: () => state?.sessions || [],
      isLiveRun: (record, session) => currentRunView?.recordId === record.id
        && currentRunView.sessionId === session.id && currentRunView.runProjectId === projectKey,
      getActiveSession: () => getActiveSession(state),
      createInterruptedRun: journal => ActiveTurnControl.createInterruptedRun(journal, projectKey, tr('restoredRunStoppedStatus')),
      onRawEvent: (raw, { record, session, sequence }) => storeContextUsage(raw, record, session, sequence),
      mapEvent: (raw, journal) => ActiveTurnControl.mapRecoveredEvent(raw, journal, {
        mapActivity: value => mapAgentEventToActivity(value, { locale: getLocale() }),
        sanitizeText: sanitizeAssistantVisibleText, sanitizeValue: sanitizeAssistantVisibleValue
      }),
      upsertStream: upsertRunStreamRecordEvent,
      pauseSessionQueue: (session, reason) => {
        session.pendingInputs = RunInputQueue.pauseAll(session.pendingInputs || [], reason);
      },
      maxEvents: MAX_RUN_EVENTS
    });
    if (!isCurrent()) return;
    if (recovery.changed) {
      if (await saveState({ recoveryRuns: recovery.recoveredRuns }) !== true || !isCurrent()) return;
      for (const requestId of recovery.acknowledgeIds) {
        await activeTurnControl.acknowledge(requestId).catch(() => false);
      }
    }
  }

  async function createAuditDraftForRun(input = {}) {
    const StorageDb = Modules.StorageDb;
    if (!StorageDb || !AuditRecords) {
      return null;
    }
    // Audit follows the captured run owner even if the visible page changes.
    // Missing owner identity must never be filled with a later account.
    const accountScopeId = currentRunView ? currentRunView.runAccountScopeId : cachedAccountScopeId;
    const projectId = currentRunView ? currentRunView.runProjectId : getCurrentProjectId();
    if (!accountScopeId || !projectId) return null;
    const executionSnapshot = input.executionSnapshot
      || currentRunView?.executionSnapshot
      || captureCurrentExecutionSnapshot();
    const draft = AuditRecords.buildAuditDraftRecord({
      accountScopeId,
      projectId,
      sessionId: input.sessionId || '',
      turnId: currentRunView?.recordId || '',
      mode: input.mode || executionSnapshot.mode,
      requireReviewing: executionSnapshot.requireReviewing,
      ...providerSettingsCoordinator.getProviderSnapshot(executionSnapshot.providerId),
      providerRevision: executionSnapshot.providerRevision,
      model: executionSnapshot.model,
      reasoningEffort: executionSnapshot.reasoningEffort,
      speedTier: executionSnapshot.speedTier,
      task: input.task || '',
      focusFiles: input.focusFiles || [],
      selectedSkillIds: input.selectedSkillIds || []
    });
    const record = StorageDb.buildAuditLogRecord
      ? StorageDb.buildAuditLogRecord(draft)
      : draft;
    return StorageDb.putRecord('auditLogs', record).then(() => record).catch(() => null);
  }

  async function updateAuditSensitiveFindings(draft, findings = []) {
    if (!draft) {
      return draft;
    }
    return finalizeAuditDraftPartial(draft, {
      sensitiveFindings: findings,
      resultStatus: draft.resultStatus || 'draft'
    });
  }

  async function finalizeAuditDraftPartial(draft, updates = {}) {
    const StorageDb = Modules.StorageDb;
    if (!StorageDb || !draft) {
      return draft;
    }
    const record = StorageDb.buildAuditLogRecord
      ? StorageDb.buildAuditLogRecord({ ...draft, ...updates, id: draft.id,
        accountScopeId: draft.accountScopeId, projectId: draft.projectId,
        completedAt: updates.completedAt || draft.completedAt || '' })
      : { ...draft, ...updates, id: draft.id, accountScopeId: draft.accountScopeId, projectId: draft.projectId };
    return StorageDb.putRecord('auditLogs', record).then(() => record).catch(() => draft);
  }

  async function finalizeAuditRecord(draft, updates = {}) {
    const StorageDb = Modules.StorageDb;
    if (!StorageDb || !AuditRecords || !draft) {
      return null;
    }
    const final = AuditRecords.buildAuditFinalRecord({
      draft: {
        ...draft,
        selectedSkillIds: updates.selectedSkillIds || draft.selectedSkillIds || [],
        sensitiveFindings: updates.sensitiveFindings || draft.sensitiveFindings || []
      },
      changedFiles: updates.changedFiles || [],
      ['diffSummary']: updates['diffSummary'] || {},
      blockedFiles: updates.blockedFiles || [],
      appliedFiles: updates.appliedFiles || [],
      skippedFiles: updates.skippedFiles || [],
      resultStatus: updates.resultStatus || 'completed',
      saveVerification: updates.saveVerification || null
    });
    const record = StorageDb.buildAuditLogRecord
      ? StorageDb.buildAuditLogRecord(final)
      : final;
    return StorageDb.putRecord('auditLogs', record).catch(() => null);
  }

  async function runSensitivePreflight(options) {
    return Modules.SensitivePreflight.create({
      SensitiveScan, normalizeGovernanceRules, isTextSnapshotFile, sendBackgroundNative,
      getCurrentProjectId, appendRunEvent, appendCompletionReport, showPluginConfirm, tr, tx
    }).run(options);
  }

  function appendRunCancelledReport(writebackOutcome = {}) {
    const hasQueuedFollowUp = (getActiveSession(state)?.pendingInputs || [])
      .some(item => item?.status === 'queued');
    appendRunEvent({
      title: tx('Current Codex task was cancelled.', '已中断当前 Codex 任务。'),
      status: 'info',
      activity: { v: 1, kind: 'lifecycle', state: 'cancelled', target: 'cancelled' }
    });
    appendCompletionReport({ conclusionKey: 'cancelled',
      conclusion: tx('This run was cancelled. It did not continue syncing or writing to Overleaf.', '这轮已中断，没有继续同步或写入 Overleaf。'),
      status: 'cancelled',
      operations: writebackOutcome.operations || [],
      applyResults: writebackOutcome.applied ? [writebackOutcome.applied] : [],
      saveVerification: writebackOutcome.saveVerification,
      nextStep: hasQueuedFollowUp
        ? tx('The first queued follow-up will start next.', '接下来会自动启动队首的后续任务。')
        : tx('Edit the task and run again.', '可以修改任务后重新运行。')
    });
  }

  function autosizeTaskTextarea() {
    const task = panel?.querySelector('[data-task]');
    if (!task) {
      return;
    }
    task.style.height = 'auto';
    task.style.height = `${Math.min(task.scrollHeight, 160)}px`;
  }

  function syncComposerSendAvailability(runningOverride) {
    const runButton = panel?.querySelector('[data-run]');
    if (!runButton) {
      return;
    }
    const hasInput = Boolean(String(panel?.querySelector('[data-task]')?.value || '').trim());
    const running = typeof runningOverride === 'boolean'
      ? runningOverride
      : Boolean(currentRunView);
    const transitioning = sessionManager.isTransitioning();
    const action = running && (!hasInput || transitioning) ? 'cancel' : 'send';
    const label = action === 'cancel'
      ? tr('cancelRun')
      : running
        ? tr('queueNextInput')
        : tr('send');
    runButton.dataset.action = action;
    runButton.disabled = action === 'cancel'
      ? runCancellationRequested
      : !hasInput || transitioning;
    runButton.title = label;
    runButton.setAttribute('aria-label', label);
    if (currentRunView?.writebackRetry && hasInput && action !== 'cancel') runButton.disabled = true;
  }

  function handleTaskInputKeydown(event) {
    if (sessionManager.isTransitioning()) {
      if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) event.preventDefault();
      return;
    }
    if (handleSlashMenuKeydown(event)) {
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) {
      return;
    }
    event.preventDefault();
    panel.querySelector('[data-composer-form]')?.requestSubmit();
  }

  function handleTaskInput() {
    composerDraftRevision += 1;
    autosizeTaskTextarea();
    syncComposerSendAvailability();
    renderPendingInputs();
    scheduleMirrorPrefetch({
      reason: 'composer-input',
      delayMs: mirrorHealth?.PREFETCH_DEBOUNCE_MS || 1200
    });
    updateSlashMenuForTaskInput();
    refreshCodexOverleafSkillsForSlashMenu().catch(() => {
      // The slash menu still works with the built-in install command when native skill listing fails.
    });
  }

  function getSlashCommands() {
    const commands = [
      { id: 'compact', kind: 'compact', group: 'commands', title: tr('slashCompactTitle'), slug: '/compact',
        subtitle: tr('slashCompactSubtitle') },
      {
        id: 'install-skill',
        kind: 'installer',
        group: 'commands',
        title: tr('slashInstallSkillTitle'),
        subtitle: tr('slashInstallSkillSubtitle')
      }
    ];
    const settings = getSkillLoadingSettings();
    for (const skill of settings.loadCodexOverleafSkills === false ? [] : slashCodexOverleafSkills) {
      const id = String(skill?.id || '').trim();
      if (!isSafeSkillId(id)) {
        continue;
      }
      // Only list enabled skills in the slash menu
      if (!isCodexOverleafSkillEnabled(id)) {
        continue;
      }
      const title = id === 'reviewer-response' ? tx('Reviewer response', '审稿回复')
        : String(skill?.title || skill?.name || id).trim().slice(0, 80) || id;
      commands.push({
        id: `skill:${id}`,
        kind: 'codex-overleaf-skill',
        group: 'overleaf',
        scope: 'codex-overleaf',
        skillId: id,
        title,
        subtitle: tr('slashUseOverleafSkillSubtitle')
      });
    }
    const localSkills = settings.loadCodexLocalSkills === false ? [] : (getCodexLocalSkillsCatalog() || []);
    for (const skill of localSkills) {
      if (!isSafeSkillId(skill.id) || !isCodexLocalSkillEnabled(skill.id, skill)) continue;
      const sameName = localSkills.filter(other => String(other.title || other.name || other.id) === String(skill.title || skill.name || skill.id)).length > 1;
      // Source and duplicate hints lead so a truncated preview cannot hide them.
      commands.push({ id: `local-skill:${skill.id}`, kind: 'codex-local-skill', group: 'local', scope: 'codex-local', skillId: skill.id,
        title: String(skill.title || skill.name || skill.id).trim().slice(0, 80),
        searchName: String(skill.name || ''),
        subtitle: [skill.sourceKind === 'plugin' && skill.sourceLabel ? skill.sourceLabel : '',
          sameName ? skill.sourceHint || skill.id.slice(-8) : '',
          String(skill.preview || '').trim() || tr('slashUseLocalSkillSubtitle')].filter(Boolean).join(' · ') });
    }
    return commands;
  }

  async function refreshCodexOverleafSkillsForSlashMenu() {
    if (getSlashTrigger() && getSkillLoadingSettings().loadCodexLocalSkills !== false) {
      primeCodexLocalSkillsCatalog().catch(() => {
        showPluginToast(tx('Could not load local Codex skills. Try again.', '无法加载 Codex 本地技能，请重试。'), { status: 'failed' });
      });
    }
    if (slashCodexOverleafSkillsLoaded || slashCodexOverleafSkillsLoading) {
      return;
    }
    if (!getSlashTrigger() || getSkillLoadingSettings().loadCodexOverleafSkills === false) {
      return;
    }
    slashCodexOverleafSkillsLoading = true;
    try {
      const response = await sendBackgroundNative({
        method: 'skills.list',
        params: { scope: 'codex-overleaf' }
      });
      if (response?.ok) {
        slashCodexOverleafSkills = Array.isArray(response.result?.skills) ? response.result.skills : [];
        slashCodexOverleafSkillsLoaded = true;
        updateSlashMenuForTaskInput();
      }
    } finally {
      slashCodexOverleafSkillsLoading = false;
    }
  }

  function updateSlashMenuForTaskInput() {
    const menu = panel?.querySelector('[data-slash-menu]');
    if (!menu) {
      return;
    }
    const trigger = getSlashTrigger();
    if (trigger) {
      const query = trigger.query.toLowerCase();
      const commands = getSlashCommands().filter(command => {
        return !query
          || command.title.toLowerCase().includes(query)
          || command.id.toLowerCase().includes(query)
          || String(command.searchName || '').toLowerCase().includes(query);
      });
      renderSlashMenu(commands, { query });
      return;
    }
    const atTrigger = getAtFileTrigger();
    if (atTrigger) {
      renderAtFileMenu(atTrigger);
      return;
    }
    closeSlashMenu();
  }

  // @ file autocomplete (v1.7): typing @ anywhere in the task opens an inline
  // file picker driven by the context tray's project file list. Selecting a
  // file inserts the @path token AND selects it as a focus file — typed
  // tokens other than @compile-log are cosmetic; the focus selection is what
  // actually attaches the file to the run.
  function getAtFileTrigger() {
    const input = panel?.querySelector('[data-task]');
    if (!input || currentRunView) {
      return null;
    }
    const cursor = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
    const before = input.value.slice(0, cursor);
    // The @ may follow anything that cannot be an email local-part or a
    // mid-word marker (word chars, dot, hyphen, another @) — this keeps
    // emails inert while CJK text directly before @ still triggers
    // (\w is ASCII-only, so 你好@ works without a space).
    const match = /(^|[^\w@.\-])@([^\s@]*)$/.exec(before);
    if (!match) {
      return null;
    }
    const query = match[2] || '';
    return {
      query,
      start: cursor - query.length - 1,
      end: cursor
    };
  }

  function renderAtFileMenu(trigger) {
    const menu = panel?.querySelector('[data-slash-menu]');
    if (!menu) {
      return;
    }
    const query = trigger.query.toLowerCase();
    const files = contextTrayController.getContextProjectFiles(
      contextTrayController.getContextProject()?.files || []
    ).filter(file => file.selectable !== false && file.kind !== 'binary');
    if (!files.length) {
      ensureContextFilesForAtMenu();
    }
    const entries = [];
    if ('@compile-log'.includes(query) || 'compile-log'.includes(query)) {
      entries.push({
        // Namespaced apart from file ids: a project file literally named
        // 'compile-log' must not collide in the rendered-commands map.
        id: 'at-builtin:compile-log',
        kind: 'at-file',
        insertText: '@compile-log',
        title: '@compile-log',
        subtitle: tr('atMenuCompileLogSubtitle')
      });
    }
    const ranked = files
      .map(file => String(file.path || ''))
      .filter(path => path && path.toLowerCase().includes(query))
      .sort((left, right) => {
        const rankDelta = contextTrayController.getContextFileRank(left) - contextTrayController.getContextFileRank(right);
        return rankDelta !== 0 ? rankDelta : left.localeCompare(right);
      })
      .slice(0, 8);
    for (const path of ranked) {
      const separator = path.lastIndexOf('/');
      entries.push({
        id: `at:${path}`,
        kind: 'at-file',
        path,
        insertText: `@${path}`,
        title: separator === -1 ? path : path.slice(separator + 1),
        subtitle: separator === -1 ? tr('atMenuFileSubtitle') : path
      });
    }
    if (!entries.length) {
      const menu = panel?.querySelector('[data-slash-menu]');
      if (!files.length && atMenuFilesLoad === 'pending' && menu) {
        // Inert placeholder (no button): Enter still submits, clicks are
        // no-ops, and the next keystroke re-renders naturally.
        menu.textContent = '';
        const loading = document.createElement('div');
        loading.className = 'codex-slash-menu-note';
        loading.textContent = tr('atMenuLoading');
        menu.append(loading);
        menu.hidden = false;
        return;
      }
      closeSlashMenu();
      return;
    }
    renderSlashMenu(entries, { query });
  }

  // Lazy one-shot load: the tray's file list is usually warm (panel open
  // prefetches), but a cold first @ must trigger a load and re-render once
  // the list lands — only if the @ trigger is still active by then.
  let atMenuFilesLoad = 'idle';
  function ensureContextFilesForAtMenu() {
    if (atMenuFilesLoad !== 'idle') {
      return;
    }
    atMenuFilesLoad = 'pending';
    // loadContextFiles never rejects (it settles errors internally), so
    // completion always lands in then(); 'done' with an empty list simply
    // renders no menu — a later tray load repopulates the same source.
    Promise.resolve(loadContextFiles({})).then(() => {
      atMenuFilesLoad = 'done';
      const menu = panel?.querySelector('[data-slash-menu]');
      const input = panel?.querySelector('[data-task]');
      // Re-render only an ACTIVE menu for a focused input — never re-open a
      // menu the user dismissed or walked away from.
      if (menu && !menu.hidden && document.activeElement === input && getAtFileTrigger()) {
        updateSlashMenuForTaskInput();
      }
    });
  }

  function applyAtFileSelection(command) {
    const input = panel?.querySelector('[data-task]');
    const trigger = getAtFileTrigger();
    closeSlashMenu();
    if (!input || !trigger) {
      // The menu was stale (caret moved / trigger gone): do nothing — a
      // token-less silent attachment would be invisible state.
      input?.focus?.();
      return;
    }
    if (input && trigger) {
      const token = String(command.insertText || `@${command.path || ''}`);
      input.value = `${input.value.slice(0, trigger.start)}${token} ${input.value.slice(trigger.end)}`;
      const caret = trigger.start + token.length + 1;
      input.setSelectionRange?.(caret, caret);
      state = { ...state, task: input.value };
      autosizeTaskTextarea();
      syncComposerSendAvailability();
      saveStateSoon();
    }
    // Selection is what attaches the file; selectFocusFile toggles, so guard
    // against deselecting an already-focused file.
    const focusFiles = contextTrayController.getActiveFocusFiles();
    if (command.path && !focusFiles.includes(command.path)) {
      if (focusFiles.length >= 5) {
        // The tray caps focus files at 5 by evicting the oldest — say so,
        // or the evicted file's @token silently lies in the task text.
        appendPlainLog(tx(
          `Focus limit is 5 files — "${focusFiles[0]}" was replaced. Remove its @ mention if you no longer want it referenced.`,
          `重点文件上限 5 个——已替换「${focusFiles[0]}」。若不再需要，请删除文本中它的 @ 引用。`
        ));
      }
      Promise.resolve(contextTrayController.selectFocusFile(command.path)).catch(() => {});
    }
    input?.focus?.();
  }

  function getSlashTrigger() {
    const input = panel?.querySelector('[data-task]');
    if (!input || currentRunView) {
      return null;
    }
    const cursor = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
    const before = input.value.slice(0, cursor);
    const after = input.value.slice(cursor);
    const match = /^\/([^\s/]*)$/.exec(before);
    if (!match || after.trim()) {
      return null;
    }
    return {
      query: match[1] || '',
      start: 0,
      end: cursor
    };
  }

  const SLASH_MENU_GROUPS = { commands: 'slashGroupCommands', overleaf: 'slashGroupOverleafSkills', local: 'slashGroupLocalSkills' };
  const SLASH_MENU_ICONS = { compact: 'compact', installer: 'install', 'codex-overleaf-skill': 'book', 'codex-local-skill': 'terminal' };

  function appendHighlightedText(node, value, query) {
    const text = String(value || '');
    const at = query ? text.toLowerCase().indexOf(query) : -1;
    if (at < 0) {
      node.append(text);
      return;
    }
    const mark = document.createElement('mark');
    mark.textContent = text.slice(at, at + query.length);
    node.append(text.slice(0, at), mark, text.slice(at + query.length));
  }

  function renderSlashMenu(commands = [], { query = '' } = {}) {
    const menu = panel?.querySelector('[data-slash-menu]');
    if (!menu) {
      return;
    }
    menu.textContent = '';
    if (!commands.length) {
      menu.hidden = true;
      return;
    }
    const usage = commands.some(command => command.kind === 'compact') ? getContextUsageDisplay().usage : null;
    const percent = usage?.contextWindow > 0 ? usage.usedTokens / usage.contextWindow * 100 : null;
    let group = '';
    commands.forEach((command, index) => {
      if (command.group && command.group !== group) {
        group = command.group;
        const label = document.createElement('div');
        label.className = 'codex-slash-menu-group';
        label.textContent = tr(SLASH_MENU_GROUPS[group]);
        menu.append(label);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.slashCommand = command.id;
      button.dataset.slashCommandKind = command.kind || '';
      if (command.skillId) {
        button.dataset.slashSkillId = command.skillId;
      }
      if (command.scope) {
        button.dataset.slashSkillScope = command.scope;
      }
      button.dataset.active = index === 0 ? 'true' : 'false';
      const icon = document.createElement('span');
      icon.className = 'codex-slash-menu-icon';
      icon.innerHTML = Modules.PanelIcons.svg(SLASH_MENU_ICONS[command.kind] || 'file');
      const text = document.createElement('span');
      text.className = 'codex-slash-menu-text';
      const title = document.createElement('span');
      title.className = 'codex-slash-menu-title';
      appendHighlightedText(title, command.title, query);
      if (command.slug) {
        const slug = document.createElement('code');
        appendHighlightedText(slug, command.slug, query);
        title.append(slug);
      }
      const subtitle = document.createElement('small');
      subtitle.textContent = command.subtitle;
      subtitle.title = command.subtitle;
      text.append(title, subtitle);
      button.append(icon, text);
      if (command.kind === 'compact' && percent !== null) {
        const meta = document.createElement('span');
        meta.className = 'codex-slash-menu-meta';
        meta.dataset.level = Modules.ContextUsage.level(percent);
        meta.title = tr('contextUsageTitle');
        meta.textContent = new Intl.NumberFormat(getLocale() === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: 0 }).format(percent) + '%';
        button.append(meta);
      }
      menu.append(button);
    });
    const foot = document.createElement('div');
    foot.className = 'codex-slash-menu-foot';
    foot.dataset.slashMenuFoot = '';
    for (const [keys, label] of [[['↑', '↓'], 'slashKeyMove'], [['Enter'], 'slashKeyRun'], [['Esc'], 'slashKeyClose']]) {
      const hint = document.createElement('span');
      for (const key of keys) hint.append(Object.assign(document.createElement('kbd'), { textContent: key }));
      hint.append(tr(label));
      foot.append(hint);
    }
    menu.append(foot);
    renderedSlashCommands = new Map(commands.map(command => [command.id, command]));
    menu.dataset.activeIndex = '0';
    menu.hidden = false;
    menu.scrollTop = 0;
    updateSlashMenuLayout();
  }

  function updateSlashMenuLayout() {
    const menu = panel?.querySelector('[data-slash-menu]');
    const composer = panel?.querySelector('[data-composer-form]');
    if (!menu || menu.hidden || !composer) return;
    const visibleTop = Math.max(0, root.visualViewport?.offsetTop || 0, panel.getBoundingClientRect().top);
    const available = Math.max(0, Math.floor(composer.getBoundingClientRect().top - visibleTop - 12));
    menu.style.setProperty('--codex-slash-menu-space', `${available}px`);
  }

  function handleSlashMenuClick(event) {
    const button = event.target?.closest?.('[data-slash-command]');
    if (!button) {
      return;
    }
    event.preventDefault();
    selectSlashCommand(button.dataset.slashCommand);
  }

  function handleSlashMenuKeydown(event) {
    // Never fight the IME: a composition-commit Enter (keyCode 229 /
    // isComposing) must reach the editor, not select a menu entry.
    if (event.isComposing || event.keyCode === 229) {
      return false;
    }
    const menu = panel?.querySelector('[data-slash-menu]');
    if (!menu || menu.hidden) {
      return false;
    }
    const buttons = Array.from(menu.querySelectorAll('[data-slash-command]'));
    if (!buttons.length) {
      closeSlashMenu();
      return false;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSlashMenu();
      return true;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const current = Number(menu.dataset.activeIndex || 0);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = (current + delta + buttons.length) % buttons.length;
      setSlashMenuActiveIndex(next);
      return true;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const active = buttons[Number(menu.dataset.activeIndex || 0)] || buttons[0];
      selectSlashCommand(active.dataset.slashCommand);
      return true;
    }
    return false;
  }

  function setSlashMenuActiveIndex(index) {
    const menu = panel?.querySelector('[data-slash-menu]');
    if (!menu) {
      return;
    }
    const buttons = Array.from(menu.querySelectorAll('[data-slash-command]'));
    menu.dataset.activeIndex = String(index);
    buttons.forEach((button, buttonIndex) => {
      button.dataset.active = buttonIndex === index ? 'true' : 'false';
    });
    const active = buttons[index];
    if (!active || !menu.clientHeight) return;
    // Wrapping to the first item also reveals its group label.
    if (index === 0) {
      menu.scrollTop = 0;
      return;
    }
    const viewport = menu.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    const top = viewport.top + menu.clientTop;
    // The sticky key-hint footer covers the bottom of the scroll area.
    const bottom = top + menu.clientHeight - (menu.querySelector('[data-slash-menu-foot]')?.offsetHeight || 0);
    // Scroll only this popup; scrollIntoView may move the chat or editor too.
    if (item.height > menu.clientHeight || item.top < top) {
      menu.scrollTop += item.top - top;
    } else if (item.bottom > bottom) {
      menu.scrollTop += item.bottom - bottom;
    }
  }

  function selectSlashCommand(commandId) {
    if (sessionManager.isTransitioning()) return;
    const command = renderedSlashCommands.get(commandId);
    if (!command) {
      closeSlashMenu();
      return;
    }
    if (command.kind === 'at-loading') {
      return;
    }
    if (command.kind === 'at-file') {
      applyAtFileSelection(command);
      return;
    }
    if (command.kind === 'compact') {
      closeSlashMenu();
      safeRunTask({ operation: 'compact', consumeCompactDraft: true });
      return;
    }
    clearSlashTriggerFromTaskInput();
    closeSlashMenu();
    if (command.kind === 'installer') {
      activateSkillInstallerComposerContext();
      return;
    }
    if (command.kind === 'codex-overleaf-skill' || command.kind === 'codex-local-skill') {
      activateCodexOverleafSkillComposerContext(command);
    }
  }

  function clearSlashTriggerFromTaskInput() {
    const input = panel?.querySelector('[data-task]');
    const trigger = getSlashTrigger();
    if (!input || !trigger) {
      return;
    }
    input.value = `${input.value.slice(0, trigger.start)}${input.value.slice(trigger.end)}`;
    state = { ...state, task: input.value };
    autosizeTaskTextarea();
    syncComposerSendAvailability();
  }

  function closeSlashMenu() {
    const menu = panel?.querySelector('[data-slash-menu]');
    if (!menu) {
      return;
    }
    menu.hidden = true;
    menu.dataset.activeIndex = '0';
  }

  function activateSkillInstallerComposerContext() {
    composerDraftRevision += 1;
    composerSkillInvocation = {
      id: 'skill-installer',
      title: tr('skillInstallerComposerLabel')
    };
    renderComposerSkillInvocation();
    const input = panel?.querySelector('[data-task]');
    input?.focus?.();
  }

  function activateCodexOverleafSkillComposerContext(command) {
    composerDraftRevision += 1;
    const id = String(command?.skillId || '').trim();
    if (!isSafeSkillId(id)) {
      return;
    }
    composerSkillInvocation = {
      id,
      title: String(command?.title || id).trim().slice(0, 80) || id,
      scope: command.scope === 'codex-local' ? 'codex-local' : 'codex-overleaf'
    };
    renderComposerSkillInvocation();
    const input = panel?.querySelector('[data-task]');
    input?.focus?.();
  }

  function clearComposerSkillInvocation() {
    composerDraftRevision += 1;
    composerSkillInvocation = null;
    renderComposerSkillInvocation();
    panel?.querySelector('[data-task]')?.focus?.();
  }

  function getComposerSkillInvocationForRun() {
    const normalized = normalizeComposerSkillInvocation(composerSkillInvocation);
    if (!normalized) {
      return null;
    }
    if (normalized.id === 'skill-installer' && !normalized.scope) {
      return {
        id: 'skill-installer',
        title: tr('skillInstallerComposerLabel')
      };
    }
    return normalized;
  }

  function normalizeComposerSkillInvocation(value) {
    const id = String(value?.id || '').trim();
    if (!isSafeSkillId(id)) {
      return null;
    }
    const title = String(value?.title || id).trim().slice(0, 80) || id;
    if (id === 'skill-installer' && (!value?.scope || value.scope === 'builtin')) return { id, title };
    if (!['codex-overleaf', 'codex-local'].includes(value?.scope)) return null;
    return { id, title, scope: value.scope };
  }

  function isSafeSkillId(id) {
    return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(String(id || ''))
      && !String(id || '').includes('..');
  }

  function renderComposerSkillInvocation() {
    const context = panel?.querySelector('[data-composer-skill-context]');
    if (!context) {
      return;
    }
    const active = getComposerSkillInvocationForRun();
    context.hidden = !active;
    const label = context.querySelector('[data-composer-skill-label]');
    if (label) {
      label.textContent = active?.title || '';
    }
    const clear = context.querySelector('[data-composer-skill-clear]');
    if (clear) {
      const clearLabel = active?.id === 'skill-installer' && !active.scope
        ? tr('skillInstallerComposerClear')
        : tr('composerSkillClear');
      clear.title = clearLabel;
      clear.setAttribute('aria-label', clearLabel);
    }
  }

  function createDiffReviewElement(syncChanges, options = {}) {
    return diffReviewPanel.createDiffReviewElement(syncChanges, options);
  }

  function renderReadOnlyDiffReview(syncChanges, title = tr('diffWrittenChangesTitle')) {
    return diffReviewPanel.renderReadOnlyDiffReview(syncChanges, title);
  }

  function getAppliedOperationPaths(applied = {}) {
    if (!Array.isArray(applied?.applied)) {
      return [];
    }
    return writebackController.getAppliedOperationPaths(applied || {});
  }

  function hasApplyResultEntries(applied = {}) {
    const appliedEntries = getAppliedEntries(applied);
    const skippedEntries = getSkippedEntries(applied);
    return Boolean(appliedEntries.length || skippedEntries.length);
  }

  function getAppliedEntries(applied = {}) {
    return Array.isArray(applied?.applied) ? applied.applied : [];
  }

  function getSkippedEntries(applied = {}) {
    return Array.isArray(applied?.skipped) ? applied.skipped : [];
  }

  function buildSyncApplyOperations(syncChanges = [], project = {}) {
    return writebackController.buildSyncApplyOperations(syncChanges, project);
  }

  function normalizeSafeProjectPath(value) {
    if (Modules.ProjectFiles?.normalizeSafeProjectPath) {
      return Modules.ProjectFiles.normalizeSafeProjectPath(value);
    }
    return String(value || '')
      .replace(/\s+/g, ' ')
      .replace(/\\/g, '/')
      .trim()
      .replace(/^\/+/, '');
  }


  function getSyncChangePatches(change = {}) {
    return writebackController.getSyncChangePatches(change);
  }

  function normalizeTextPatches(patches) {
    return writebackController.normalizeTextPatches(patches);
  }

  function computeSingleTextPatch(oldText, newText) {
    return writebackController.computeSingleTextPatch(oldText, newText);
  }

  function getAppliedSyncChanges(syncChanges = [], applied = {}) {
    return writebackController.getAppliedSyncChanges(syncChanges, applied);
  }

  function getCurrentProjectId() {
    return extractProjectIdFromLocation(window.location);
  }

  // -------------------------------------------------------------------------
  // Welcome-panel + write-guard: SPA route lifecycle,
  // account scope derivation, post-navigation run settlement. See
  // docs/superpowers/specs/2026-05-24-project-list-welcome-panel-design.md
  // §5.1 (trigger), §5.2 (account scope, fail-closed), §5.7 (lifecycle).
  // -------------------------------------------------------------------------


  // Spec §5.1. URL predicate is the only signal that selects the variant —
  // no short-timeout DOM downgrade.
  function extractProjectIdFromLocation(url) {
    const pathname = (url && typeof url.pathname === 'string') ? url.pathname : '';
    const match = pathname.match(/^\/project\/([^/?#]+)(?:\/.*)?$/);
    if (!match) {
      return '';
    }
    const id = match[1];
    if (PROJECT_EDITOR_RESERVED_IDS.has(id)) {
      return '';
    }
    return /^[a-f0-9]{24}$/.test(id) ? id : '';
  }

  function isProjectEditorRoute(url) {
    return Boolean(extractProjectIdFromLocation(url));
  }

  // Spec §5.2. Stable, unique identifiers ONLY. The display name is NEVER
  // used as a fallback — display names are not unique, and using one would
  // silently leak across accounts that share a display name. The fallback
  // path returns null and the panel renders the degraded variant.
  //
  // NOTE: display name is not a fallback. (privacy floor; do not weaken)
  async function deriveAccountScopeId() {
    try {
      const metaEmail = document.querySelector('meta[name="ol-user-email"], meta[name="user-email"]');
      const email = metaEmail && metaEmail.getAttribute('content');
      if (typeof email === 'string' && email.includes('@')) {
        return await hashScope(email.toLowerCase());
      }
    } catch (_metaError) {
      // Selector may throw if document is partially constructed; fall through.
    }
    try {
      const menuEmail = document.querySelector('[data-user-email], [data-account-email]');
      const value = menuEmail && (
        menuEmail.getAttribute('data-user-email')
        || menuEmail.getAttribute('data-account-email')
      );
      if (typeof value === 'string' && value.includes('@')) {
        return await hashScope(value.toLowerCase());
      }
    } catch (_menuError) {
      // Same defensive swallow as above.
    }
    // No stable identifier observable → fail-closed. Display name is never
    // used as a fallback.
    return null;
  }

  async function hashScope(input) {
    // SHA-256, first 16 hex chars. crypto.subtle is available in content
    // scripts on https://www.overleaf.com (secure context).
    const enc = new TextEncoder().encode(input);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    const bytes = new Uint8Array(buf);
    let hex = '';
    for (let i = 0; i < 8; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  }

  // Module-local cache for the synchronous shim consumed by T3's
  // storageDb.resolveAccountScopeId. Recomputed on initial mount and on
  // every SPA route change.
  let cachedAccountScopeId = null;
  async function refreshAccountScopeId() {
    try {
      cachedAccountScopeId = await deriveAccountScopeId();
    } catch (_error) {
      cachedAccountScopeId = null;
    }
    return cachedAccountScopeId;
  }
  // T3 injection point: storageDb reads through this getter on every
  // saveState. Returning null puts the record in degraded mode and excludes
  // it from cross-project queries (spec §5.2 storage rules).
  window.codexOverleafDeriveAccountScopeId = () => cachedAccountScopeId;
  var sharedSessionViewSync = Modules.SharedSessionViewSync.install({
    Bridge: Modules.SharedSessionBridge, StorageDb: Modules.StorageDb,
    getScope: () => ({ accountScopeId: cachedAccountScopeId, projectId: getCurrentProjectId(), generation: spaRouteGeneration }),
    getState: () => state, setState: next => { state = next; },
    // An in-flight Accept/Undo keeps its view until it settles; refresh applies afterwards.
    isBusy: () => Boolean(pendingDraftSave || readLiveRunViewForSaveStateGuard() || trackedChangeInFlight.size
      || runReviewController?.hasActiveReview?.() || document.querySelector('dialog[open]')),
    hasLocalDraft: current => Boolean(current.task) && composerDraftEditedHere,
    normalize: normalizePanelState,
    render: () => {
      applyStateToPanel();
      composerDraftEditedHere = false;
    },
    notice: error => appendStorageNoticeOnce('shared-history-refresh', tx(
      `Could not refresh shared history: ${error.message}`,
      `共享会话历史刷新失败：${error.message}`
    ))
  });

  // -----------------------------------------------------------------------
  // SPA route change lifecycle (spec §5.7).
  // -----------------------------------------------------------------------

  // `activeProjectId` is the module-local mutable variable for the editor the
  // user is *currently looking at*. It is NOT a substitute for the immutable
  // per-run `runProjectId` (spec §5.0) — writeback / accept / undo dispatches
  // still attach the run's captured id, not this one. The whole point of
  // `runProjectId` is that it survives navigation; `activeProjectId` does not.
  let activeProjectId = null;
  let lastSpaPathname = '';
  let spaRouteGeneration = 0;

  function cancelPendingWritebacks(prevProjectId) {
    // The codebase does not maintain a separate pending-writeback queue;
    // writebacks dispatch synchronously inside `runCodexTask`. The equivalent
    // "cancel" surface is therefore (a) request cancellation of any active
    // Codex run associated with the previous project so its in-flight
    // writeback loop exits early and (b) clear the inflight tracked-change
    // accept/undo map so a navigation-time race can't leave a button stuck.
    // Page-side dispatches that are already in flight when the user leaves
    // are governed by the §5.0 fail-closed guard — they emit
    // aborted_project_changed or editor_project_id_unavailable, which feeds
    // `settleRunAfterNavigation`.
    if (currentRunView && currentRunView.runProjectId === prevProjectId) {
      // Mark cancellation requested; do NOT await the codex.cancel native
      // round-trip here — the lifecycle hook must return promptly. The
      // background completion path eventually settles the run via
      // `settleRunAfterNavigation` regardless of whether the cancel reached
      // the native host.
      cancelActiveRun().catch(() => { /* swallow; settlement handles it */ });
    }
    if (trackedChangeInFlight instanceof Map) {
      trackedChangeInFlight.clear();
    }
  }

  function pauseProjectObservers(prevProjectId) {
    // Stop the OT warm-mirror poll/flush timers that are bound to the
    // previous project id. The mirror prefetch timer is a `setTimeout`
    // handle on `mirrorPrefetchState.timer`; clear it.
    try {
      clearOtEventPolling({ clearPatchQueue: true });
    } catch (_error) { /* swallow */ }
    try {
      clearMirrorPrefetchTimer();
    } catch (_error) { /* swallow */ }
    releaseOtWarmMirrorProject(prevProjectId);
  }

  function bindProjectObservers(newProjectId) {
    // Re-bind project-specific observers fresh against the new id. The
    // existing OT warm-mirror controller already initialises itself on
    // panel mount via `syncOtWarmMirrorController`; calling it here gives
    // the new project a clean start.
    syncOtWarmMirrorController().catch(_error => {
      // Mirror init failures are non-fatal — the badge surfaces the
      // unavailable state and the user can retry from diagnostics.
    });
  }

  function getScopedPersistenceCoordinator() {
    if (scopedPersistenceCoordinator) return scopedPersistenceCoordinator;
    scopedPersistenceCoordinator = Modules.ScopedPersistenceCoordinator?.createController({
      Transaction: Modules.ScopedPersistenceTransaction,
      chromeApi: chrome,
      sessionStorage: window.sessionStorage,
      getAccountScopeId: () => window.codexOverleafDeriveAccountScopeId?.() || ''
    });
    return scopedPersistenceCoordinator;
  }

  function getGlobalPreferences() {
    if (!globalPreferencesController) globalPreferencesController = Modules.GlobalPreferencesController.create({
      chromeApi: chrome, getState: () => state, setState: next => { state = next; }, getPanel: () => panel,
      applyTheme: applyPanelTheme, applyLocale: () => { applyLocaleToPanel(); refreshDashboardSoon(); },
      onPreloadChange: enabled => contextTrayController.scheduleContextPrefetch({ enabled }),
      onSkillsChange: () => { renderLocalSkillList(); updateSkillsEntrySummary(); updateSlashMenuForTaskInput(); },
      onError: error => showPluginToast(tx(
        `Global settings could not be saved or loaded: ${error.message}. Please retry.`,
        `全局设置未能保存或读取：${error.message}。请重试。`), { status: 'failed', sticky: true })
    });
    return globalPreferencesController;
  }

  async function reloadProjectRunHistory(newProjectId) {
    // Rebind the storage key to the new project and reload the panel state
    // from chrome.storage.local so the per-project session list reflects
    // the project the user just navigated into.
    try {
      storageKey = getProjectStorageKey(LEGACY_STORAGE_KEY, window.location.href);
      const reloaded = await loadStoredState();
      state = normalizeLoadedPanelState(reloaded);
      composerDraftEditedHere = false;
      await getRunReviewController().recoverInterruptedUndoStatuses();
      applyStateToPanel();
    } catch (_error) {
      // Reload failures fall back to the in-memory state; the next saveState
      // surfaces a structured failure via the existing quota / storage path.
    }
  }

  function disableComposer() {
    // JS-level guard against run dispatch in the no-project window. The
    // visible swap is T5's responsibility; here we just flip the disabled
    // attribute so the keyboard / submit path no-ops.
    if (!panel) {
      return;
    }
    const submit = panel.querySelector('[data-composer-submit]');
    if (submit) {
      submit.disabled = true;
    }
    const textarea = panel.querySelector('[data-composer-input]');
    if (textarea) {
      textarea.disabled = true;
    }
    panel.dataset.composerDisabled = 'true';
  }

  function enableComposer() {
    if (!panel) {
      return;
    }
    const submit = panel.querySelector('[data-composer-submit]');
    if (submit) {
      submit.disabled = false;
    }
    const textarea = panel.querySelector('[data-composer-input]');
    if (textarea) {
      textarea.disabled = false;
    }
    panel.dataset.composerDisabled = 'false';
  }

  // -----------------------------------------------------------------------
  // Recent-projects variant — Welcome panel rendering (spec §5.3-§5.6, §5.8).
  // -----------------------------------------------------------------------
  //
  // The variant is *page-scoped*: it mounts inside the existing panel root
  // (the same `<aside>` panel created by PanelRenderer), it never replaces
  // any top-level page DOM. It runs whenever `isProjectEditorRoute(url)` is
  // false. Per spec, switching between per-project and Recent-projects must
  // not trigger a full re-mount.
  //
  // Mount strategy: the existing panel template defines an empty `data-main`
  // section. The variant injects a sibling element with
  // `data-recent-projects-root` and toggles the panel via
  // `data-view="recent-projects"` so per-project DOM (composer, run log,
  // session list) is hidden while the variant is visible.
  //


  function leaveActiveProject(newId) {
    const prevId = activeProjectId;
    activeProjectId = newId; // null for non-project URLs (spec §5.7.1)
    if (prevId !== newId) composerDraftEditedHere = false;
    getComposerDraftPersistence().syncScope();
    if (!prevId || prevId === newId) {
      return;
    }
    cancelPendingWritebacks(prevId);
    pauseProjectObservers(prevId);
    disableComposer();
  }

  function enterProject(id) {
    activeProjectId = id;
    bindProjectObservers(id);
    // reloadProjectRunHistory is async but the lifecycle hook does not
    // await it — subsequent renders pick up the rebound state.
    reloadProjectRunHistory(id).catch(() => { /* swallow */ });
    enableComposer();
    // Spec §5.6.3: opportunistically warm the project-name cache on every
    // per-project mount so the Recent-projects variant can render rich
    // names instead of `Project · <prefix>` next time the user returns to
    // the project-list page. Best-effort, fire-and-forget.
    try {
      rememberCurrentProjectName(id);
    } catch (_error) { /* swallow */ }
  }

  async function onSpaRouteChange() {
    // Snapshot the departing draft before hydration replaces state. The detached
    // writer retains its original account/project and never reads the new view's attachments.
    if (pendingDraftSave?.projectId === activeProjectId
      && pendingDraftSave?.accountScopeId === cachedAccountScopeId) {
      void saveState({ draftScope: pendingDraftSave });
    }
    resetDraftSave();
    const generation = ++spaRouteGeneration;
    activeTurnControl.cancelRecovery();
    const url = new URL(window.location.href);
    const pathname = url.pathname;
    const previousProjectId = activeProjectId;
    const previousAccountScopeId = cachedAccountScopeId;
    const nextProjectId = isProjectEditorRoute(url)
      ? url.pathname.match(/^\/project\/([^/?#]+)/)[1]
      : null;
    if (nextProjectId !== activeProjectId) {
      leaveActiveProject(nextProjectId);
    }
    // Recompute the account scope on every route change (spec §5.2 per-
    // project derivation: account menu is global chrome and should be
    // readable on per-project URLs too).
    await refreshAccountScopeId();
    getComposerDraftPersistence().syncScope();
    if (generation !== spaRouteGeneration || pathname !== window.location.pathname) {
      return;
    }
    if (isProjectEditorRoute(url)) {
      if (
        nextProjectId !== previousProjectId
        || cachedAccountScopeId !== previousAccountScopeId
      ) {
        enterProject(nextProjectId);
      }
      renderPerProjectVariant();
    } else {
      // Variant render is async (it awaits the IndexedDB query); the hook
      // does not await — subsequent renders pick up the rebound state.
      renderRecentProjectsVariant().catch(() => { /* swallow */ });
    }
  }

  // Hook the existing SPA navigation surface. Overleaf is a SPA: it mutates
  // window.location via History API calls without firing `popstate` for
  // pushState. To catch both back/forward and in-app navigation, monkey-
  // patch history.pushState / replaceState in addition to listening for
  // `popstate`. The patched wrappers are idempotent under the runtime's
  // install flag.
  function installSpaRouteHook() {
    if (root.__codexOverleafSpaRouteHookInstalled) {
      return;
    }
    root.__codexOverleafSpaRouteHookInstalled = true;
    const fire = () => {
      const next = window.location.pathname;
      if (next === lastSpaPathname) {
        return;
      }
      lastSpaPathname = next;
      onSpaRouteChange().catch(() => {
        // Route-hook failures must never crash the page.
      });
    };
    const wrap = name => {
      const original = window.history[name];
      if (!(original instanceof Function)) {
        return;
      }
      window.history[name] = function patched() {
        const result = original.apply(this, arguments);
        // Defer the route-change dispatch so the DOM has settled.
        window.setTimeout(fire, 0);
        return result;
      };
    };
    wrap('pushState');
    wrap('replaceState');
    window.addEventListener('popstate', () => window.setTimeout(fire, 0));
    lastSpaPathname = window.location.pathname;
  }

  function settleRunAfterNavigation(run, runResult) {
    return WritebackSettlement.settlePostNavigation({
      run,
      runResult,
      navigation: { occurred: activeProjectId !== run.runProjectId }
    });
  }

  function collectRunResultSkipped(syncOutcome) {
    return WritebackSettlement.collectRunResultSkipped(syncOutcome);
  }

  // Persist the post-navigation status to the run's original
  // runProjectId's session record. Used by run-completion callers.
  //
  // Two paths:
  //   1. Same project (or activeProjectId aligned): the in-memory
  //      `state.sessions` still contains the run record; mutate the field
  //      and let `saveStateSoon()` persist on the normal path.
  //   2. Different project: the in-memory state may already have been
  //      rebound to the new project's storage key (via
  //      `reloadProjectRunHistory`), so the in-memory mutation would not
  //      reach the right record. Go directly through StorageDb to update
  //      the original project's session record by id.
  async function persistPostNavigationRunStatus(run, postNavigationStatus, settlementResult) {
    if (!run || !postNavigationStatus) {
      return { ok: false, reason: 'invalid_post_navigation_settlement' };
    }
    const postNavigationStatusText = getPostNavigationRunStatusText(postNavigationStatus);
    Object.assign(run, WritebackSettlement.applySettlementTransition(
      run,
      WritebackSettlement.transitionPostNavigationStatus({
        status: postNavigationStatus,
        statusText: postNavigationStatusText,
        finishedAt: run.finishedAt || new Date().toISOString()
      })
    ));
    if (
      currentRunView
      && currentRunView.runProjectId === activeProjectId
      && currentRunView.runAccountScopeId === cachedAccountScopeId
    ) {
      // Same project still active — the run record is reachable through the
      // normal state and the regular save path will persist it.
      saveStateSoon();
      return { ok: true, lane: 'active_project' };
    }
    // Different project. Update the original session's run record directly.
    try {
      const sessionId = currentRunView ? currentRunView.sessionId : '';
      if (!sessionId) {
        throw Object.assign(new Error('Post-navigation settlement has no original session identity.'), {
          code: 'post_navigation_settlement_persistence_failed',
          reason: 'session_scope_unavailable'
        });
      }
      const persistence = Modules.PostNavigationSettlementPersistence;
      if (!persistence || typeof persistence.persistRequired !== 'function') {
        throw Object.assign(new Error('Post-navigation settlement persistence is unavailable.'), {
          code: 'post_navigation_settlement_persistence_failed',
          reason: 'persistence_module_unavailable'
        });
      }
      return await persistence.persistRequired({
        StorageDb: Modules.StorageDb,
        PersistenceCoordinator: getScopedPersistenceCoordinator(),
        WritebackSettlement,
        projectId: currentRunView?.runProjectId || '',
        accountScopeId: currentRunView?.runAccountScopeId || '',
        sessionId,
        runId: run.id,
        status: postNavigationStatus,
        statusText: postNavigationStatusText,
        finishedAt: run.finishedAt,
        settlementResult
      });
    } catch (error) {
      const reason = String(error?.reason || error?.code || 'unknown_failure');
      run.postNavigationPersistenceFailure = {
        code: 'post_navigation_settlement_persistence_failed',
        reason,
        at: new Date().toISOString()
      };
      appendPlainLog(tx(
        `Could not persist the completed run to its original project (${reason}). Reopen that project to recover the interrupted record.`,
        `无法将已完成运行保存到原项目（${reason}）。请重新打开该项目以恢复中断记录。`
      ));
      return {
        ok: false,
        reason
      };
    }
  }

  function getPostNavigationRunStatusText(status) {
    if (status === 'background_completed') {
      return tx('Completed in background', '已在后台完成');
    }
    if (status === 'needs_review_after_navigation') {
      return tx('Needs review after navigation', '切换项目后需核对');
    }
    if (status === 'abandoned_after_navigation') {
      return tx('Abandoned after navigation', '切换项目后已中止');
    }
    return getRunStatusText({ status });
  }

  // Expose internals for testing surfaces (panel smoke helper + T5).
  // No production callers rely on this object yet; it exists so tests can
  // reach the helpers without having to bootstrap the entire runtime.
  root.__codexOverleafLifecycle = {
    isProjectEditorRoute,
    deriveAccountScopeId,
    refreshAccountScopeId,
    settleRunAfterNavigation,
    getActiveProjectId: () => activeProjectId,
    getCachedAccountScopeId: () => cachedAccountScopeId,
    // T5 surfaces: variant renderer + helpers. Tests drive
    // `renderRecentProjectsVariant` against a stubbed `panel` and
    // `Modules.StorageDb` to assert layout / row behavior.
    renderRecentProjectsVariant,
    renderRecentProjectRow,
    renderStatusBadge,
    isValidProjectId,
    openProjectFromRow,
    formatRelativeTime,
    STATUS_BADGE_CLASS
  };


  async function handleTaskResult(mode, result, project) {
    const notes = result.notes?.trim() || '';
    if (notes) {
      appendRunEvent({
        title: tx('Codex Summary', 'Codex 总结'),
        status: 'completed',
        detail: notes
      });
    }
    appendSummary(result.summary);

    if (mode === 'ask') {
      appendRunEvent({
        title: tr('undoNoWritesTitle'),
        status: 'completed'
      });
      const summaryLine = appendChangeSummary({
        notes,
        operations: [],
        status: tr('modeAsk')
      });
      appendCompletionReport({ conclusionKey: !notes ? 'ask_inspected' : undefined,
        conclusion: notes || tx('This run only inspected and explained; no files were written.', '这轮只做了检查和说明，没有写入文件。'),
        status: tr('modeAsk'),
        notes,
        userReport: result.userReport,
        mode,
        operations: [],
        applyResults: [],
        nextStep: tx('Continue the conversation, or switch to Auto to let Codex edit files.', '可以继续追问，或切换到自动写入后让 Codex 修改文件。')
      });
      return { status: tr('modeAsk'), summaryLine };
    }

    if (result.status === 'delete_plan_required') {
      const operations = result.operations || [];
      const applyResults = [];
      appendOperationsPreview(operations, tx('Preparing to write non-delete changes first', '准备先写入非删除修改'));
      const applied = await applyTaskOperations(project, operations);
      applyResults.push(applied);
      appendApplyResult(applied);
      await recordUndoFromApply(project, applied);
      const approved = await showPluginConfirm({
        title: tx('Confirm delete plan?', '确认删除计划？'),
        message: formatDeletePlan(result.deletePlan || []),
        confirmLabel: tx('Confirm deletes', '确认删除'),
        cancelLabel: tx('Keep non-delete changes', '保留非删除修改'),
        destructive: true
      });
      if (approved) {
        const pendingOperations = result.pendingOperations || [];
        appendOperationsPreview(pendingOperations, tx('Deletes confirmed; preparing to write', '用户已确认删除，准备写入'));
        const deleteApplied = await applyTaskOperations(project, pendingOperations, { allowHighRisk: true });
        applyResults.push(deleteApplied);
        appendApplyResult(deleteApplied);
        await recordUndoFromApply(project, deleteApplied);
        appendLog(tx('Deleted files after confirmation.', '已按确认删除文件。'));
        const summaryLine = appendChangeSummary({
          notes,
          operations: [...operations, ...pendingOperations],
          applyResults,
          status: 'applied with delete plan'
        });
        appendCompletionReport({ conclusionKey: !notes ? 'delete_handled' : undefined,
          conclusion: notes || tx('Changes were written, and delete items were handled after your confirmation.', '已写入修改，并按你的确认处理删除项。'),
          status: 'applied with delete plan',
          notes,
          userReport: result.userReport,
          mode,
          operations: [...operations, ...pendingOperations],
          applyResults
        });
        return {
          status: 'applied with delete plan',
          summaryLine,
          hasSkippedOperations: hasSkippedApplyOperations(applyResults)
        };
      }
      appendLog(tx('Deletes cancelled; non-delete changes were kept.', '已取消删除；非删除修改已保留。'));
      const summaryLine = appendChangeSummary({
        notes,
        operations,
        applyResults,
        status: 'applied without deletes',
        deletePlanRejected: true
      });
      appendCompletionReport({ conclusionKey: 'delete_rejected',
        conclusion: tx('Non-delete changes were kept; delete items were not written.', '已保留非删除修改；删除项没有写入。'),
        status: 'applied without deletes',
        notes,
        userReport: result.userReport,
        mode,
        operations,
        applyResults,
        deletePlanRejected: true,
        nextStep: tx('If files still need to be deleted, rerun and confirm deletion separately.', '如果仍需要删除文件，请重新运行并单独确认删除。')
      });
      return {
        status: 'applied without deletes',
        summaryLine,
        hasSkippedOperations: hasSkippedApplyOperations(applyResults)
      };
    }

    const operations = result.operations || [];
    appendOperationsPreview(operations, tx('Preparing to write', '准备写入'));
    const applied = await applyTaskOperations(project, operations);
    appendApplyResult(applied);
    await recordUndoFromApply(project, applied);
    appendLog(mode === 'auto' ? tx('Auto write task completed.', '自动写入任务完成。') : tx('Task completed.', '任务完成。'));
    const summaryLine = appendChangeSummary({
      notes,
      operations,
      applyResults: [applied],
      status: result.status || 'completed'
    });
    appendCompletionReport({ conclusionKey: !notes ? 'run_complete' : undefined,
      conclusion: notes || tx('This run is complete.', '这轮任务已完成。'),
      status: result.status || 'completed',
      notes,
      userReport: result.userReport,
      mode,
      operations,
      applyResults: [applied]
    });
    return {
      status: result.status || 'completed',
      summaryLine,
      hasSkippedOperations: hasSkippedApplyOperations([applied])
    };
  }

  async function applyTaskOperations(project, operations, options = {}) {
    const target = currentRunView;
    const runRequireReviewing = typeof options.requireReviewing === 'boolean'
      ? options.requireReviewing
      : state.requireReviewing === true;
    const partitioned = partitionOperationsForApply(operations, options);
    if (!partitioned.safe.length) {
      appendRunEvent({
        title: tr('undoNoWritesTitle'),
        status: 'completed'
      });
    }
    const reviewing = await ensureReviewingBeforeWrite(partitioned.safe, { requireReviewing: runRequireReviewing });
    if (!reviewing.ok) {
      return buildReviewingBlockedApplyResult(partitioned.safe, reviewing, partitioned.skipped);
    }
    if (partitioned.safe.length) await stageWritebackRecovery(partitioned.safe, target, runRequireReviewing, project);
    if (partitioned.safe.length) {
      appendRunEvent({
        title: tx('Saved a recoverable version before this run writes.', '已保存本轮写入前的可恢复版本。'),
        status: 'completed',
        detail: {
          [tx('Files to write', '将写入的文件')]: formatOperationFiles(partitioned.safe)
        }
      });
    }

    const applied = partitioned.safe.length
      ? await callPageBridge('applyOperations', {
        operations: partitioned.safe,
        baseFiles: project?.files || [],
        requireReviewing: runRequireReviewing,
        requireEditing: !runRequireReviewing,
        // Welcome-panel + write-guard:
        runProjectId: target?.runProjectId || ''
      })
      : { ok: true, applied: [], skipped: [] };

    return {
      ...applied,
      ok: applied.ok && partitioned.skipped.length === 0,
      skipped: [
        ...getSkippedEntries(applied),
        ...partitioned.skipped
      ]
    };
  }

  async function ensureReviewingBeforeWrite(operations = [], options = {}) {
    const requireReviewing = typeof options.requireReviewing === 'boolean'
      ? options.requireReviewing
      : state?.requireReviewing === true;
    if (!operations.length) {
      return { ok: true, skipped: true };
    }
    const method = requireReviewing ? 'ensureReviewing' : 'ensureEditing';

    appendRunEvent({
      title: requireReviewing
        ? tx('Verifying Overleaf Reviewing/Track Changes before writing.', '正在确认 Overleaf 已开启 Reviewing/Track Changes。')
        : tx('Verifying Overleaf Editing mode before writing.', '正在确认 Overleaf 已切到 Editing 模式。'),
      status: 'running'
    });
    // Thread runProjectId so the page-side dispatcher gates the toggle. Same
    // intent as the pre-flight check above: do not flip Track Changes /
    // Editing in a different project than the run is bound to.
    const owner = currentRunView;
    const result = await callPageBridge(method, {
      waitMs: 1800,
      runProjectId: currentRunView?.runProjectId || ''
    });
    throwIfRunCancellationRequested();
    if (owner && (owner !== currentRunView || owner.runProjectId !== getCurrentProjectId()
      || owner.runAccountScopeId !== cachedAccountScopeId)) throw createRunCancellationError();
    if (requireReviewing && (result?.ok || result?.code === 'reviewing_unavailable')) {
      projectSettingsCoordinator.observeReviewingAvailability(result.ok ? 'available' : 'unavailable',
        result.ok ? 'reviewing_confirmed' : 'upgrade_modal');
      syncProbeStatus();
    }
    if (result?.ok) {
      appendRunEvent({
        title: requireReviewing
          ? (result.activated
            ? tx('Switched to Overleaf Reviewing/Track Changes. Upcoming writes will be tracked.', '已切到 Overleaf Reviewing/Track Changes，接下来写入会留痕。')
            : tx('Overleaf Reviewing/Track Changes is on. Upcoming writes will be tracked.', '已确认 Overleaf Reviewing/Track Changes 正在开启，接下来写入会留痕。'))
          : (result.activated
            ? tx('Switched to Overleaf Editing mode. Upcoming writes will not use Track Changes.', '已切到 Overleaf Editing 模式，接下来写入不会使用 Track Changes。')
            : tx('Overleaf Editing mode is on. Upcoming writes will not use Track Changes.', '已确认 Overleaf Editing 模式开启，接下来写入不会使用 Track Changes。')),
        status: 'completed'
      });
      return result;
    }

    appendRunEvent({
      title: requireReviewing
        ? tx('Write blocked: Codex could not verify Overleaf Reviewing/Track Changes.', '已阻止写入：Codex 没能确认 Overleaf 正在用 Reviewing/Track Changes。')
        : tx('Write blocked: Codex could not verify Overleaf Editing mode.', '已阻止写入：Codex 没能确认 Overleaf 正在用 Editing 模式。'),
      status: 'failed',
      detail: {
        [tr('detailReason')]: localizeVisibleReason(result?.reason || (requireReviewing
          ? tx('Overleaf did not return track changes status', 'Overleaf 没有返回留痕状态')
          : tx('Overleaf did not return Editing mode status', 'Overleaf 没有返回 Editing 模式状态'))),
        [tx('Status', '状态')]: result?.reviewing?.status || 'unknown'
      }
    });
    return {
      ok: false,
      code: result?.code || (requireReviewing ? 'reviewing_not_enabled' : 'editing_not_confirmed'),
      reason: result?.reason || (requireReviewing ? 'Reviewing/Track Changes was not enabled' : 'Editing mode was not confirmed'),
      reviewing: result?.reviewing || null,
      evidence: result?.evidence, failure: result?.failure,
      requireReviewing
    };
  }

  function buildReviewingBlockedApplyResult(operations = [], reviewing = {}, extraSkipped = []) {
    const blockedByEditing = reviewing?.code === 'editing_not_confirmed' || reviewing?.requireReviewing === false;
    return {
      ok: false,
      applied: [],
      skipped: [
        ...(operations || []).map(operation => ({
          operation,
          result: {
            ok: false,
            code: reviewing?.code || (blockedByEditing ? 'editing_not_confirmed' : 'reviewing_not_enabled'),
            evidence: reviewing?.evidence, failure: reviewing?.failure,
            reason: reviewing?.code === 'reviewing_unavailable' ? tr('failureReason_reviewing_unavailable_user') : blockedByEditing
              ? tx(
                'Track is off, but Overleaf Editing mode was not verified before writing. Codex did not write this file.',
                '已关闭“留痕”，但写入前没有确认 Overleaf 正在用 Editing 模式。Codex 没有写入这个文件。'
              )
              : tx(
                'Track is enabled, but Overleaf Reviewing/Track Changes was not verified before writing. Codex did not write this file.',
                '已开启“留痕”要求，但写入前没有确认 Overleaf 正在用 Reviewing/Track Changes。Codex 没有写入这个文件。'
              )
          }
        })),
        ...(extraSkipped || [])
      ],
      reviewing
    };
  }

  function partitionOperationsForApply(operations, options = {}) {
    if (options.allowHighRisk) {
      return partitionUnsafeProjectPathOperations(operations || []);
    }

    const safe = [];
    const skipped = [];
    for (const operation of operations || []) {
      const normalized = normalizeOperationProjectPaths(operation);
      const invalidPath = getInvalidOperationProjectPath(normalized);
      if (invalidPath) {
        skipped.push({
          operation: normalized,
          result: {
            ok: false,
            code: 'invalid_project_path',
            reason: tx(`Invalid ${invalidPath}. Codex did not write this file.`, `路径无效：${invalidPath}。Codex 没有写入这个文件。`)
          }
        });
      } else if (HIGH_RISK_TYPES.includes(normalized?.type)) {
        skipped.push({
          operation: normalized,
          result: {
            ok: false,
            reason: 'High-risk operation requires explicit approval before application'
          }
        });
      } else {
        safe.push(normalized);
      }
    }

    return { safe, skipped };
  }

  async function refreshProbe(options = {}) {
    const projectId = getCurrentProjectId();
    const accountScopeId = cachedAccountScopeId;
    const userInitiated = options.userInitiated === true;
    if (userInitiated) {
      setRefreshProbeLoading(true);
      const status = panel?.querySelector('[data-probe-status]');
      if (status) {
        renderProbeStatusMessage(status, tr('refreshProbeLoading'));
        status.dataset.refreshing = 'true';
      }
    }

    try {
      const probe = await callPageBridge('probe', {
        manualOverride: state?.requireReviewing === false
      });
      if (projectId !== getCurrentProjectId()) return null;
      if (accountScopeId !== cachedAccountScopeId) return null;
      if (probe.capabilities?.reviewing?.confirmed === true) {
        projectSettingsCoordinator.observeReviewingAvailability('available', 'reviewing_confirmed');
      }
      probeStatusSnapshot = { projectId, probe, userInitiated };
      const status = panel?.querySelector('[data-probe-status]');
      if (status) {
        renderProbeStatusLine(status, probe, { refreshed: userInitiated });
        status.dataset.refreshing = 'false';
      }
      if (!options.quiet && !userInitiated) {
        appendProbeUserStatus(probe);
      } else {
        updateExistingProbeNotice(probe);
      }
      return probe;
    } catch (error) {
      if (!userInitiated) {
        throw error;
      }
      if (projectId !== getCurrentProjectId()) return null;
      probeStatusSnapshot = { projectId, failed: true };
      const status = panel?.querySelector('[data-probe-status]');
      if (status) {
        renderProbeStatusMessage(status, tr('refreshProbeFailed'), 'warn');
        status.dataset.refreshing = 'false';
      }
      console.warn('[codex-overleaf] refresh probe failed', error);
      return null;
    } finally {
      if (userInitiated) {
        setRefreshProbeLoading(false);
      }
    }
  }

  function setRefreshProbeLoading(loading) {
    const button = panel?.querySelector('[data-refresh]');
    if (!button) {
      return;
    }
    button.dataset.loading = loading ? 'true' : 'false';
    button.disabled = Boolean(loading);
    button.setAttribute('aria-busy', loading ? 'true' : 'false');
    setElementTitleAndAria('[data-refresh]', tr(loading ? 'refreshProbeLoading' : 'refreshProbe'),
      tr(loading ? 'refreshProbeLoading' : 'refreshProbeTitle'));
  }

  function syncProbeStatus(mode = state?.mode) {
    const status = panel?.querySelector('[data-probe-status]');
    if (!status) return;
    if (status.dataset.refreshing === 'true') {
      renderProbeStatusMessage(status, tr('refreshProbeLoading'));
      return;
    }
    if (probeStatusSnapshot?.projectId !== getCurrentProjectId()) return;
    const { failed, probe, userInitiated } = probeStatusSnapshot;
    if (failed) renderProbeStatusMessage(status, tr('refreshProbeFailed'), 'warn');
    else renderProbeStatusLine(status, probe, { refreshed: userInitiated });
    if (!failed) updateExistingProbeNotice(probe, mode);
  }

  // Keep the read scope visible; a known Track limitation adds its own warning segment.
  function getProbeScope(probe) {
    const selection = selectionContextView.capture();
    const focusFiles = getActiveFocusFiles();
    // Match submission priority: an edit selection, then explicit focus files,
    // then reference context, ahead of the editor's implicit current-file hint.
    if (selection?.mode === 'edit') return { icon: 'file', key: 'probeScopeSelection' };
    if (focusFiles.some(file => /\.tex$/i.test(file))) return { icon: 'file', key: 'probeScopeFiles' };
    if (focusFiles.length || selection) return { icon: 'attach', key: 'probeScopeContext' };
    if (getProbeRunReadiness(probe).editorOk) return { icon: 'file', key: 'probeScopeCurrentFile' };
    return { icon: 'folder', key: 'probeScopeProject' };
  }

  function isReviewingKnownUnavailable() {
    return Modules.Reviewing.knownUnavailable(projectSettingsCoordinator.getReviewingAvailability());
  }

  function syncReviewingTooltip() {
    const toggle = panel?.querySelector('[data-require-reviewing]');
    const title = tr(isReviewingKnownUnavailable() ? 'reviewingUnavailableTooltip' : 'requireReviewingTitle');
    if (toggle) toggle.title = title;
    const label = toggle?.closest('.codex-review-toggle');
    if (label) label.title = title;
  }

  function renderProbeStatusLine(status, probe, options = {}) {
    const scope = getProbeScope(probe);
    const parts = [];
    if (options.refreshed) parts.push(tr('refreshProbeDone', { status: '' }).trim());
    const label = document.createElement('span');
    label.className = 'codex-probe-scope';
    label.innerHTML = Modules.PanelIcons?.svg?.(scope.icon) || ''; // Static, repository-owned icon path.
    label.append(tr(scope.key));
    parts.push(label);
    if (isExperimentalOtEnabled()) {
      const separator = document.createElement('span');
      separator.className = 'codex-probe-sep';
      separator.textContent = '·';
      parts.push(separator, 'OT ' + formatOtStatusLabel(getCurrentOtStatus()));
    }
    if (state.requireReviewing && isReviewingKnownUnavailable()) {
      const warning = document.createElement('span');
      warning.dataset.tone = 'warn';
      warning.textContent = ' · ' + tr('reviewingUnavailableStatus');
      parts.push(warning);
    }
    syncReviewingTooltip();
    status.replaceChildren(...parts);
    delete status.dataset.tone;
  }

  function renderProbeStatusMessage(status, text, tone = '') {
    status.replaceChildren(text);
    if (tone) status.dataset.tone = tone;
    else delete status.dataset.tone;
  }

  function formatProbeStatusBar(probe, mode = state?.mode) {
    const readiness = getProbeRunReadiness(probe);
    const reviewingOk = readiness.reviewingOk;
    const editorWritable = readiness.editorWritable;

    if (mode === 'ask') {
      return appendOtStatusToProbeStatus(`${formatModeLabel('ask')} · ${readiness.contextLabel}`);
    }
    if (reviewingOk) {
      const status = editorWritable
        ? `${tr('canRun')} · ${readiness.contextLabel}`
        : `${formatModeLabel(mode)} · ${tr('validatingEditor')}`;
      return appendOtStatusToProbeStatus(status);
    }
    if (readiness.contextReady) {
      return appendOtStatusToProbeStatus(tr('needsReviewing'));
    }
    return appendOtStatusToProbeStatus(tr('needsReviewingAndFile'));
  }

  function appendOtStatusToProbeStatus(status) {
    const base = String(status || '');
    if (!isExperimentalOtEnabled()) {
      return base;
    }
    return `${base} · OT ${formatOtStatusLabel(getCurrentOtStatus())}`;
  }

  function updateProbeStatusOtSuffix() {
    const status = panel?.querySelector('[data-probe-status]');
    if (!status || status.dataset.refreshing === 'true') {
      return;
    }
    syncProbeStatus();
  }

  function getProbeRunReadiness(probe) {
    const editorOk = probe.editor?.ok === true;
    const focusFiles = getActiveFocusFiles();
    const hasFocus = focusFiles.length > 0;
    const hasTexFocus = focusFiles.some(file => /\.tex$/i.test(file));
    const contextLabel = editorOk
      ? tr('currentFileContext')
      : hasTexFocus
        ? tr('fileContext')
        : hasFocus
          ? tr('contextContext')
          : tr('wholeProjectContext');
    return {
      reviewingOk: probe.reviewing?.ok === true,
      editorOk,
      editorWritable: probe.capabilities?.editor?.write !== false,
      contextReady: true,
      contextLabel
    };
  }

  function formatModeLabel(mode) {
    if (mode === 'ask') {
      return tr('modeAsk');
    }
    if (mode === 'auto') {
      return tr('modeAuto');
    }
    return mode || tr('unknownMode');
  }

  function formatRunStatusText(status) {
    const value = String(status || '');
    const labels = {
      completed: tx('Completed', '已完成'),
      rejected: tx('Cancelled', '已取消'),
      'applied with delete plan': tx('Applied with confirmed deletes', '已应用并删除确认项'),
      'applied without deletes': tx('Applied without deletes', '已应用非删除修改'),
      '只问不改': tr('modeAsk')
    };
    return labels[value] || value || tx('Completed', '已完成');
  }

  function formatContextItems(focusFiles = []) {
    const fileItems = (focusFiles || []).map(path => `@file:${path}`);
    return fileItems.length
      ? fileItems.join(', ')
      : tx(
        '@whole-project (default); choose files or add @compile-log',
        '@whole-project（默认）；可选择文件或添加 @compile-log'
      );
  }

  function appendProbeUserStatus(probe) {
    const { ready, message } = formatProbeUserNotice(probe);
    if (!currentRunView) {
      updateProbeNotice(ready ? '' : message);
      return;
    }
    appendLog(message);
  }

  function updateExistingProbeNotice(probe, mode = state?.mode) {
    if (currentRunView || !panel?.querySelector('[data-probe-notice]')) {
      return;
    }
    const { ready, message } = formatProbeUserNotice(probe, mode);
    updateProbeNotice(ready ? '' : message);
  }

  function formatProbeUserNotice(probe, mode = state?.mode) {
    const readiness = getProbeRunReadiness(probe);
    const reviewingOk = readiness.reviewingOk;
    const editorOk = readiness.editorOk;
    const manualOverride = probe.reviewing?.status === 'manual-override';
    const editorWriteBlocked = probe.capabilities?.editor?.write === false;

    if (mode === 'ask') {
      return {
        ready: true,
        message: tx(
          `Ready: current mode is Ask. Codex ${readiness.contextLabel} and will not write to Overleaf.`,
          `可以运行：当前是“只问不改”，Codex ${readiness.contextLabel}，不会写入 Overleaf。`
        )
      };
    }

    if (reviewingOk && editorOk && editorWriteBlocked) {
      return {
        ready: true,
        message: tx(
          `Ready: ${formatModeLabel(mode)} is selected. This page has not exposed a writable editor yet; Codex will reopen and verify the target file when writing. If writeback fails, reload Overleaf and retry.`,
          `可以运行：已选择“${formatModeLabel(mode)}”。当前页面暂时没有暴露可写编辑器，写入时会重新打开目标文件并验证；如果写回失败，再刷新 Overleaf 页面后重试。`
        )
      };
    }

    if (reviewingOk) {
      return {
        ready: true,
        message: manualOverride
          ? tx(
            `Ready: Codex writes without tracked changes and ${readiness.contextLabel}.`,
            `可以运行：Codex 写入时不使用留痕，并且${readiness.contextLabel}。`
          )
          : tx(
            `Ready: Codex verified Overleaf Reviewing/Track Changes is on and ${readiness.contextLabel}.`,
            `可以运行：Codex 已确认 Overleaf Reviewing/Track Changes 已开启，并且${readiness.contextLabel}。`
          )
      };
    }

    // ensureReviewingBeforeWrite switches Overleaf to Reviewing before the first
    // write and blocks the write only if that cannot be confirmed.
    return {
      ready: true,
      message: tx(
        `Ready: Codex ${readiness.contextLabel} and will switch Overleaf to Reviewing/Track Changes before writing.`,
        `可以运行：Codex ${readiness.contextLabel}，写入前会把 Overleaf 切到 Reviewing/Track Changes。`
      )
    };
  }

  async function getRunProjectSnapshot() {
    const project = await callPageBridge('getProjectSnapshot', {
      force: true,
      maxAgeMs: 0,
      preferLightweight: true,
      allowZipFallback: true,
      allowEditorNavigation: false,
        requireFullProject: true,
        includeBinaryFiles: true,
        zipOnly: true,
      zipTimeoutMs: RUN_SNAPSHOT_ZIP_TIMEOUT_MS,
      focusFiles: getActiveFocusFiles()
    });
    const sanitizedProject = sanitizeRunProjectSnapshot(project);
    if (sanitizedProject?.capabilities?.fullProjectSnapshot || sanitizedProject?.capabilities?.pathIdentityComplete === false) {
      return sanitizedProject;
    }
    const pageStateProject = await callPageBridge('getProjectSnapshot', {
      force: true,
      maxAgeMs: 0,
      preferLightweight: true,
      allowZipFallback: false,
      allowEditorNavigation: false,
      requireFullProject: true,
      includeBinaryFiles: false,
      focusFiles: getActiveFocusFiles()
    });
    const sanitizedPageStateProject = sanitizeRunProjectSnapshot(pageStateProject);
    if (sanitizedPageStateProject?.capabilities?.fullProjectSnapshot) {
      return sanitizedPageStateProject;
    }
    return sanitizedProject;
  }

  function sanitizeRunProjectSnapshot(project) {
    if (!project || typeof project !== 'object') return project;
    const normalize = Modules.ProjectFiles.normalizeSafeProjectPath;
    const files = Array.isArray(project.files) ? project.files : [];
    const counts = new Map();
    for (const file of files) {
      const path = normalize(file?.path);
      if (path) counts.set(path, (counts.get(path) || 0) + 1);
    }
    const skipped = [];
    const safeFiles = files.filter(file => {
      const path = normalize(file?.path);
      if (path && counts.get(path) === 1) return true;
      skipped.push({ path: typeof file?.path === 'string' ? file.path : '',
        reason: path ? 'snapshot_path_duplicate' : 'snapshot_path_invalid' });
      return false;
    });
    const activePath = normalize(project.activePath || '');
    const activePathKnown = activePath && safeFiles.some(file => file.path === activePath);
    const rejectActive = Boolean(project.activePath && !activePathKnown);
    if (!skipped.length && !rejectActive) return project;
    return {
      ...project,
      activePath: rejectActive ? '' : project.activePath,
      files: safeFiles.map(file => rejectActive && file?.active ? { ...file, active: false } : file),
      capabilities: {
        ...(project.capabilities || {}),
        ...(skipped.length ? { fullProjectSnapshot: false, contentComplete: false, pathIdentityComplete: false,
          skipped: [...(project.capabilities?.skipped || []), ...skipped] } : {}),
        diagnostics: {
          ...(project.capabilities?.diagnostics || {}),
          ...(rejectActive ? { rejectedActivePath: project.activePath } : {})
        }
      }
    };
  }

  // --- Warm Mirror Controller ---

  async function getMirrorFreshness() {
    try {
      const response = await sendBackgroundNative({
        method: 'mirror.status',
        params: { projectId: getCurrentProjectId() }
      });
      if (response?.ok) {
        return response.result;
      }
    } catch (error) { /* fall through */ }
    return null;
  }

  async function resolveWarmMirrorReuse(project = {}, options = {}) {
    const snapshotWarnings = options.snapshotWarnings || { blocking: [] };
    const focusFiles = options.focusFiles || [];
    const mode = options.mode || state.mode;
    const partialSnapshot = Boolean(
      snapshotWarnings.blocking?.some(warning => /Full project snapshot was not captured/i.test(warning))
    );

    if (!partialSnapshot && (mode === 'ask' || !focusFiles.length)) {
      return { useExistingMirror: false };
    }

    const fileOverlays = buildSnapshotFileOverlays(project, focusFiles, { partialSnapshot });
    if (partialSnapshot && !fileOverlays.length) {
      return { useExistingMirror: false, reason: 'missing_overlay' };
    }
    if (focusFiles.length && !focusFiles.every(path => {
      const normalized = normalizeSnapshotPath(path);
      return fileOverlays.some(file => normalizeSnapshotPath(file.path) === normalized);
    })) {
      return { useExistingMirror: false, reason: 'missing_focus_overlay' };
    }

    const mirrorStatus = await getMirrorFreshness();
    const mirrorHealth = Modules.MirrorHealth.classifyMirrorHealth(mirrorStatus);
    if (!mirrorStatus?.exists || !mirrorHealth.reusable) {
      return { useExistingMirror: false, reason: 'mirror_not_fresh', mirrorStatus };
    }

    return {
      useExistingMirror: true,
      fileOverlays,
      mirrorStatus,
      mirrorHealth,
      partialSnapshot
    };
  }

  function buildSnapshotFileOverlays(project = {}, focusFiles = [], options = {}) {
    const textFiles = (project.files || []).filter(isTextSnapshotFile);
    const focusSet = new Set((focusFiles || []).map(normalizeSnapshotPath).filter(Boolean));
    const activePath = normalizeSnapshotPath(project.activePath || '');
    const candidates = textFiles.filter(file => {
      const normalizedPath = normalizeSnapshotPath(file.path);
      if (focusFiles.length) {
        return focusSet.has(normalizedPath) || normalizedPath === activePath || file.active;
      }
      return normalizedPath === activePath || file.active || options.partialSnapshot;
    });
    const seen = new Set();
    return candidates
      .filter(file =>
        typeof file.content === 'string' &&
        Modules.ProjectFiles.isUsableProjectFileContent(file.content) &&
        file.path &&
        !seen.has(file.path) &&
        seen.add(file.path)
      )
      .map(file => ({
        path: file.path,
        content: file.content
      }));
  }

  function normalizeSnapshotPath(path) {
    // Snapshot/overlay/focus arrays already carry canonical names from file chips.
    return Modules.ProjectFiles.normalizeSafeProjectPath(path);
  }

  function mergeProjectWithSyncChangeBaseFiles(project = {}, syncChanges = []) {
    const filesByPath = new Map((project.files || []).map(file => [file.path, { ...file }]));
    for (const change of syncChanges || []) {
      if (!change?.path || filesByPath.has(change.path) || !syncChangeHasPreviousFile(change)) {
        continue;
      }
      filesByPath.set(change.path, {
        path: change.path,
        kind: 'text',
        content: change.previousContent,
        source: 'mirror-baseline'
      });
    }

    return {
      ...project,
      files: Array.from(filesByPath.values())
    };
  }

  function syncChangeHasPreviousFile(change = {}) {
    if (change.previousExists === true || change.baselineExists === true) {
      return true;
    }
    if (change.previousExists === false || change.baselineExists === false) {
      return false;
    }
    return typeof change.previousContent === 'string' && change.previousContent.length > 0;
  }

  // --- End Warm Mirror Controller ---

  function formatProjectSnapshotLog(project) {
    const files = project.files || [];
    const skipped = project.capabilities?.skipped || [];
    const mode = project.capabilities?.fullProjectSnapshot ? 'project' : 'active file';
    const fileNames = files.slice(0, 5)
      .map(file => `${file.path}:${formatProjectSnapshotFileSize(file)}/${file.source || 'unknown'}`)
      .join(', ');
    const suffix = files.length > 5 ? `, +${files.length - 5} more` : '';
    const skippedText = skipped.length
      ? `; skipped ${skipped.slice(0, 3).map(item => `${item.path || 'unknown'} (${item.reason || 'no reason'})`).join(', ')}${skipped.length > 3 ? `, +${skipped.length - 3} more` : ''}`
      : '';
    const method = project.capabilities?.method ? ` via ${project.capabilities.method}` : '';
    const docRecords = project.capabilities?.diagnostics?.docRecordCount;
    const docRecordText = Number.isInteger(docRecords) ? `; doc records ${docRecords}` : '';
    return `Snapshot: ${files.length} ${mode} file(s)${method}, chars/source ${fileNames}${suffix}${skippedText}${docRecordText}.`;
  }

  function formatProjectSnapshotUserLog(project) {
    return DiagnosticsPanel.formatProjectSnapshotUserLog(project, { tx, getFocusFiles: getActiveFocusFiles });
  }

  function formatProjectSnapshotFileSize(file) {
    return DiagnosticsPanel.formatProjectSnapshotFileSize(file);
  }

  function formatProjectSnapshotWarning(warning) {
    return DiagnosticsPanel.formatProjectSnapshotWarning(warning, tx);
  }

  function appendEditorDiagnostics(editorDiagnostics, projectDiagnostics) {
    DiagnosticsPanel.appendEditorDiagnostics(editorDiagnostics, projectDiagnostics, appendLog);
  }

  function appendProjectWarnings(project) {
    DiagnosticsPanel.appendProjectWarnings(project, { getWarnings: getProjectSnapshotWarnings, appendLog });
  }

  function getProjectSnapshotWarnings(project) {
    const files = project?.files || [];
    const skipped = project?.capabilities?.skipped || [];
    const textFiles = files.filter(isTextSnapshotFile);
    const blocking = [];
    const nonBlocking = [];

    if (!files.length) {
      blocking.push('No source files were captured.');
      return { blocking, nonBlocking };
    }

    if (!textFiles.length) {
      blocking.push('No source files were captured.');
      return { blocking, nonBlocking };
    }

    if (project?.capabilities?.fullProjectSnapshot === false) {
      blocking.push('Full project snapshot was not captured.');
    }

    const unusable = textFiles.filter(file => !Modules.ProjectFiles.isUsableProjectFileContent(file.content));
    if (unusable.length === textFiles.length) {
      blocking.push('Captured file contents are empty or still loading.');
    } else if (unusable.length) {
      nonBlocking.push(`${unusable.length} file(s) have empty/loading content.`);
    }

    const shortFiles = textFiles.filter(file => String(file.content || '').trim().length < 80);
    if (shortFiles.length === textFiles.length) {
      blocking.push('Every captured file is suspiciously short; Overleaf editor content was not read correctly.');
    } else if (shortFiles.length) {
      nonBlocking.push(`${shortFiles.length} captured file(s) are shorter than 80 characters.`);
    }

    if (textFiles.length > 1 && uniqueContentSignatures(textFiles).length <= 1) {
      blocking.push('Multiple paths have identical captured content; file switching likely failed.');
    }

    if (skipped.length) {
      nonBlocking.push(`${skipped.length} project file(s) were skipped.`);
    }

    return { blocking, nonBlocking };
  }

  function isTextSnapshotFile(file) {
    return DiagnosticsPanel.isTextSnapshotFile(file);
  }

  function uniqueContentSignatures(files) {
    return DiagnosticsPanel.uniqueContentSignatures(files);
  }

  function appendReviewingDiagnostics(diagnostics) {
    DiagnosticsPanel.appendReviewingDiagnostics(diagnostics, { appendLog, tx });
  }

  function sendNative(payload) {
    return nativeCompatibilityController.sendNative(payload);
  }

  function sendBackgroundNative(payload) {
    return nativeCompatibilityController.sendBackgroundNative(payload);
  }

  async function refreshNativeCompatibilityBadge() {
    return nativeCompatibilityController.refreshBadge();
  }

  function showNativeUpdateGuidanceModal(compatibility = {}) {
    return nativeCompatibilityController.showUpdateGuidance(compatibility);
  }

  function scheduleFirstUseOnboardingTip() {
    nativeCompatibilityController.scheduleFirstUseOnboardingTip();
  }

  async function callPageBridge(method, params) {
    if (method === 'applyOperations' && params?.reviewingPolicy === 'no-trace-undo') {
      return Modules.AssetTransferBroker.create({ callPageBridge: (name, input) => pageBridgeClient.call(name, input), sendBackgroundNative }).applyOperations(params);
    }
    return pageBridgeClient.call(method, params);
  }

  function getPageBridgeTimeoutMs(method) {
    return pageBridgeClient.resolveTimeoutMs(method);
  }

  async function loadStoredState() {
    const projectId = getCurrentProjectId();
    const persistenceCoordinator = getScopedPersistenceCoordinator();
    const hydrationView = projectId && persistenceCoordinator
      ? await persistenceCoordinator.beginHydration(projectId)
      : null;
    const hydrationAccountScopeId = hydrationView?.accountScopeId || cachedAccountScopeId || '';
    const loaded = await loadStoredStateForProject(hydrationAccountScopeId);
    if (
      hydrationView
      && persistenceCoordinator
      && !persistenceCoordinator.isCurrent(hydrationView)
    ) {
      throw Object.assign(new Error('Scoped hydration was superseded.'), {
        code: 'stale_hydration'
      });
    }
    return loaded;
  }

  function buildScopedFallbackStorageKey(baseKey, accountScopeId) {
    const account = typeof accountScopeId === 'string' ? accountScopeId.trim() : '';
    if (!account) {
      throw Object.assign(new Error('Scoped fallback storage requires an account identity.'), {
        code: 'account_scope_unavailable'
      });
    }
    return `${baseKey}:account:${encodeURIComponent(account)}`;
  }

  function isScopedPersistenceIdentityFailure(error) {
    return [
      'account_scope_unavailable',
      'scoped_claim_unavailable',
      'stale_hydration',
      'stale_view'
    ].includes(error?.code);
  }

  async function loadStoredStateForProject(accountScopeId = cachedAccountScopeId || '') {
    try {
      const StorageDb = Modules.StorageDb;
      const Migration = Modules.StorageMigration;
      const projectId = getCurrentProjectId();
      const legacyKey = storageKey;

      const { prefs, sessions, activeSessionId } = await Migration.runMigrationIfNeeded(
        projectId,
        legacyKey,
        accountScopeId
      );
      const composerAttachments = await loadComposerAttachmentsForProject(accountScopeId, projectId);

      return {
        composerAttachments,
        model: prefs.model || '', providerId: prefs.providerId || 'builtin',
        reasoningEffort: prefs.reasoningEffort || '',
        speedTier: prefs.speedTier || '',
        mode: prefs.mode || '',
        locale: prefs.locale || '',
        theme: ['dark', 'light', 'auto'].includes(prefs.theme) ? prefs.theme : 'dark',
        requireReviewing: prefs.requireReviewing !== false,
        autoRecompile: prefs.autoRecompile !== false,
        loadCodexLocalSkills: prefs.loadCodexLocalSkills !== false,
        loadCodexOverleafSkills: prefs.loadCodexOverleafSkills !== false,
        codexOverleafSkillEnabled: prefs.codexOverleafSkillEnabled || {},
        codexLocalSkillEnabled: prefs.codexLocalSkillEnabled || {},
        experimentalOtByProject: prefs.experimentalOtByProject || {},
        customInstructionsByProject: prefs.customInstructionsByProject || {},
        reviewingAvailabilityByProject: prefs.reviewingAvailabilityByProject || {},
        governanceRulesByProject: normalizeGovernanceRulesByProject(prefs.governanceRulesByProject),
        panelWidth: prefs.panelWidth || PANEL_DEFAULT_WIDTH,
        sessions: sessions.map(session => ({
          id: session.id,
          accountScopeId: session.accountScopeId || accountScopeId,
          title: session.title || '',
          titleSource: session.titleSource || 'auto',
          focusFiles: session.focusFiles || [], selectionContext: session.selectionContext?.projectId === projectId ? session.selectionContext : null,
          projectReferenceFiles: session.projectReferenceFiles || [],
          codexThreadId: session.codexThreadId || '',
          contextUsage: session.contextUsage || null,
          forkedFromSessionId: session.forkedFromSessionId || '',
          forkedFromRunId: session.forkedFromRunId || '',
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          runs: Array.isArray(session.runs) ? session.runs : [],
          history: Array.isArray(session.history) ? session.history : [],
          task: typeof session.task === 'string' ? session.task : '',
          pendingInputs: Array.isArray(session.pendingInputs) ? session.pendingInputs : [],
          mode: session.mode || prefs.mode || 'ask', providerId: session.providerId || 'builtin',
          model: session.model || prefs.model || 'gpt-5.4',
          reasoningEffort: session.reasoningEffort || prefs.reasoningEffort || 'high',
          speedTier: session.speedTier || prefs.speedTier || 'standard',
          requireReviewing: typeof session.requireReviewing === 'boolean'
            ? session.requireReviewing
            : prefs.requireReviewing !== false
        })),
        activeSessionId: activeSessionId,
        runs: []
      };
    } catch (error) {
      if (!accountScopeId || isScopedPersistenceIdentityFailure(error)) {
        throw error;
      }
      const fallbackKey = buildScopedFallbackStorageKey(storageKey, accountScopeId);
      const stored = await chrome.storage.local.get([fallbackKey]);
      const fallback = stored[fallbackKey] || {};
      if (
        fallback?.__codexOverleafCompactFallback === true
        && fallback.__codexOverleafFallbackAccountScopeId === accountScopeId
      ) {
        return {
          mode: fallback.mode || '', providerId: fallback.providerId || 'builtin',
          model: fallback.model || '',
          reasoningEffort: fallback.reasoningEffort || '',
          speedTier: fallback.speedTier || '',
          locale: fallback.locale || '',
          theme: ['dark', 'light', 'auto'].includes(fallback.theme) ? fallback.theme : 'dark',
          requireReviewing: fallback.requireReviewing !== false,
          autoOpen: fallback.autoOpen !== false,
          loadCodexLocalSkills: fallback.loadCodexLocalSkills !== false,
          loadCodexOverleafSkills: fallback.loadCodexOverleafSkills !== false,
          codexOverleafSkillEnabled: fallback.codexOverleafSkillEnabled || {},
          codexLocalSkillEnabled: fallback.codexLocalSkillEnabled || {},
          experimentalOtByProject: fallback.experimentalOtByProject || {},
          customInstructionsByProject: fallback.customInstructionsByProject || {},
          reviewingAvailabilityByProject: fallback.reviewingAvailabilityByProject || {},
          governanceRulesByProject: normalizeGovernanceRulesByProject(fallback.governanceRulesByProject),
          panelWidth: fallback.panelWidth || PANEL_DEFAULT_WIDTH,
          sessions: [],
          activeSessionId: '',
          runs: []
        };
      }
      throw error;
    }
  }

  // Welcome-panel + write-guard: defensive accessor.
  // Some legacy test harnesses inline `saveState` without re-declaring the
  // module-local `currentRunView`. ReferenceError would otherwise crash the
  // function before its try/catch could run. Production callers always have
  // `currentRunView` in scope (declared near the top of contentRuntime), so
  // this is a no-op there.
  function readLiveRunViewForSaveStateGuard() {
    try {
      return currentRunView;
    } catch (_referenceError) {
      return null;
    }
  }

  async function saveState(options) {
    const endSharedSave = typeof sharedSessionViewSync !== 'undefined'
      ? sharedSessionViewSync?.beginSave() : null;
    try {
      const StorageDb = Modules.StorageDb;
      const Migration = Modules.StorageMigration;
      // Settlement owns a run after navigation away from its project. Ordinary
      // view saves must not write that run into the current route's project.
      // An explicit override is reserved for callers that own a detached scope.
      const projectIdOverride = options?.draftScope?.projectId || (options && typeof options.projectIdOverride === 'string'
        ? options.projectIdOverride : '');
      const urlProjectId = getCurrentProjectId();
      const projectId = projectIdOverride || urlProjectId;
      if (!projectId) {
        if (options?.requireDurable || options?.reviewRunIds?.length) throw new Error('Persistence lost its project.'); return;
      }
      // Read currentRunView through a defensive accessor so historical test
      // harnesses that inline `saveState` without re-declaring the module-
      // local `currentRunView` still execute the happy path unchanged.
      const liveRunView = readLiveRunViewForSaveStateGuard();
      if (!projectIdOverride && liveRunView && liveRunView.runProjectId
        && liveRunView.runProjectId !== urlProjectId) {
        appendPlainLog(tx(
          'Skipped saveState: run is in flight on a different project than the current URL; settlement owns persistence.',
          '已跳过 saveState：本次运行所属项目与当前 URL 不一致，写回由 settlement 负责。'
        ));
        if (options?.requireDurable || options?.reviewRunIds?.length) throw new Error('Persistence project changed.'); return;
      }
      const savedDraft = !projectIdOverride && pendingDraftSave?.scope === getComposerDraftScope()
        ? pendingDraftSave : null;
      const compactState = prepareStateForStorage(state, { onAggressive: notifyAggressiveCompactionOnce });
      compactState.autoRecompile = state.autoRecompile;
      compactState.loadCodexLocalSkills = state.loadCodexLocalSkills !== false;
      compactState.loadCodexOverleafSkills = state.loadCodexOverleafSkills !== false;
      compactState.codexOverleafSkillEnabled = getCodexOverleafSkillEnabled();
      compactState.codexLocalSkillEnabled = getCodexLocalSkillEnabled();
      compactState.experimentalOtByProject = state.experimentalOtByProject;
      compactState.customInstructionsByProject = state.customInstructionsByProject;
      compactState.reviewingAvailabilityByProject = state.reviewingAvailabilityByProject;
      compactState.governanceRulesByProject = state.governanceRulesByProject;
      const stateSnapshot = typeof structuredClone === 'function'
        ? structuredClone(state)
        : JSON.parse(JSON.stringify(state));
      // Keep consumption provenance on the live run owner across ordinary
      // session normalization; it is not a composer edit or a queued input.
      const consumedSession = liveRunView?.draftConsumption && liveRunView.runProjectId === projectId
        && liveRunView.runAccountScopeId === cachedAccountScopeId
        ? stateSnapshot.sessions?.find(session => session.id === liveRunView.sessionId) : null;
      if (consumedSession?.task === '') consumedSession.draftConsumption = { ...liveRunView.draftConsumption };
      const compactStateSnapshot = typeof structuredClone === 'function'
        ? structuredClone(compactState)
        : JSON.parse(JSON.stringify(compactState));

      const retentionScope = { accountScopeId: typeof cachedAccountScopeId === 'string' ? cachedAccountScopeId : '', projectId, generation: typeof spaRouteGeneration === 'number' ? spaRouteGeneration : null };
      let written;
      const persistScopedState = async persistenceContext => {
        written = await Modules.ScopedPersistenceCoordinator.persistPanelState({
        state: stateSnapshot,
        compactState: compactStateSnapshot,
        projectId,
        deletedSessionIds: options?.deletedSessionIds, reviewRunIds: options?.reviewRunIds, recoveryRuns: options?.recoveryRuns,
        Migration,
        StorageDb,
        SessionPersistence: Modules.SessionPersistence,
        normalizeExperimentalOtByProject,
        normalizeGovernanceRulesByProject,
        normalizeCustomInstructionsByProject,
        persistenceContext
        });
        if (!options?.draftScope) {
          await getComposerDraftPersistence().save({ accountScopeId: persistenceContext.scope.accountScopeId, projectId });
        }
      };

      const persistenceCoordinator = getScopedPersistenceCoordinator();
      if (!persistenceCoordinator) {
        throw Object.assign(new Error('Scoped persistence coordinator is unavailable.'), {
          code: 'scoped_persistence_unavailable'
        });
      } else {
        const commitOptions = {
            detached: Boolean(projectIdOverride),
            rebase: true,
            queueMutation: options?.queueMutation,
            queueMutations: options?.queueMutations,
            sessionTombstones: options?.deletedSessionIds
        };
        const committed = options?.draftScope
          ? await persistenceCoordinator.commitDetached(projectId, options.draftScope.accountScopeId, commitOptions, persistScopedState)
          : await persistenceCoordinator.commit(projectId, commitOptions, persistScopedState);
        if (!committed.ok && (
          options?.requireDurable || options?.reviewRunIds?.length || options?.recoveryRuns?.length || options?.queueMutation
          || options?.queueMutations?.length
          || committed.reason !== 'stale_view'
        )) {
          throw Object.assign(new Error(`Scoped persistence failed: ${committed.reason}`), {
            code: committed.reason
          });
        }
        if (committed.ok) {
          if (savedDraft && pendingDraftSave === savedDraft) {
            const capturedTask = stateSnapshot.sessions.find(item => item.id === stateSnapshot.activeSessionId)?.task;
            const storedTask = StorageDb.buildSessionRecord({ task: capturedTask }).task;
            if (!(written || []).some(session => session.id === stateSnapshot.activeSessionId && session.task === storedTask)) {
              throw Object.assign(new Error(tx('The latest draft could not be saved. It is still available in this page.',
                '最新草稿未能保存，内容仍保留在当前页面。')), { code: 'draft_state_not_persisted' });
            }
            // A newer input revision keeps its own timer, even if this save finishes later.
            resetDraftSave();
          }
          const retentionUpdates = StorageDb.projectRetentionUpdates?.({ liveState: state, capturedState: stateSnapshot, written,
            capturedScope: retentionScope, currentScope: { accountScopeId: typeof cachedAccountScopeId === 'string' ? cachedAccountScopeId : '',
              projectId: getCurrentProjectId(), generation: typeof spaRouteGeneration === 'number' ? spaRouteGeneration : null } }) || [];
          for (const update of retentionUpdates) for (const run of [...(state.runs || []), ...(state.sessions || []).flatMap(session => session.runs || [])]) {
            if (run.id !== update.runId) continue;
            if (update.retention) run.recoveryRetention = update.retention; else delete run.recoveryRetention;
          }
          if (retentionUpdates.some(update => update.retention)) appendStorageNoticeOnce('undo-retention', tx(
            'Some recovery evidence was not retained durably. After reloading, check Overleaf history or Review.',
            '部分恢复材料未持久保留；刷新后请核对 Overleaf 历史或审阅。'));
        }
        if (options?.requireDurable || options?.recoveryRuns?.length) return true;
      }
    } catch (error) {
      if (options?.requireDurable) throw error;
      // A departing draft must never fall back using the destination page's state/scope.
      if (options?.draftScope) return;
      if (error?.code === 'recovery_scope_changed') return;
      if (
        error?.code === 'account_scope_unavailable' &&
        !options?.reviewRunIds?.length && !options?.queueMutation &&
        !(Array.isArray(options?.queueMutations) && options.queueMutations.length)
      ) {
        return;
      }
      if (options?.reviewRunIds?.length || options?.queueMutation || options?.queueMutations?.length) {
        throw error;
      }
      let fallbackError = null;
      try {
        const accountScopeId = cachedAccountScopeId || '';
        const fallbackKey = buildScopedFallbackStorageKey(storageKey, accountScopeId);
        await chrome.storage.local.set({
          [fallbackKey]: {
            ...prepareCompactFallbackState(state),
            __codexOverleafFallbackAccountScopeId: accountScopeId
          }
        });
      } catch (caughtFallbackError) {
        fallbackError = caughtFallbackError;
      }
      if (isStorageQuotaError(error)) {
        emitStorageQuotaFailure(error, fallbackError);
      }
      if (typeof appendStorageNoticeOnce === 'function') {
        appendStorageNoticeOnce('save-failed', tx(`Failed to save session state: ${localizeVisibleReason(error.message)}`, `保存会话状态失败：${localizeVisibleReason(error.message)}`));
      } else {
        throw error;
      }
    } finally {
      endSharedSave?.();
    }
  }

  function prepareCompactFallbackState(inputState) {
    const compact = prepareStateForStorage(inputState);
    return {
      ...compact,
      __codexOverleafCompactFallback: true,
      composerAttachments: [],
      task: '',
      session: null,
      sessions: [],
      runs: [],
      activeSessionId: ''
    };
  }

  // Tracks whether we have already emitted a `storage_quota_exceeded` failure
  // for the current page session. The toast layer already de-dupes via
  // `storageNoticeKeys`; mirror that so the structured failure is emitted
  // once per session rather than once per `saveState` failure.
  let storageQuotaFailureEmitted = false;

  // Emit a structured `storage_quota_exceeded` failure for the current run
  // view (if any). Falls back to a plain-log line when no run view exists so
  // the failure does not vanish during background timer-driven saves.
  function emitStorageQuotaFailure(primaryError, fallbackError) {
    if (storageQuotaFailureEmitted) {
      return;
    }
    storageQuotaFailureEmitted = true;
    const failure = buildContentFailure('storage_quota_exceeded', null, {
      technicalMessage: (primaryError && primaryError.message) || String(primaryError || ''),
      evidence: {
        quotaExceeded: true,
        primaryErrorCode: primaryError && primaryError.name,
        fallbackErrorCode: fallbackError && fallbackError.name
      }
    });
    if (currentRunView?.events) {
      appendRunEvent({
        title: tx('Local session history is too large; some state could not be saved.', '本地会话记录过大，部分状态未能保存。'),
        status: 'failed',
        failure
      });
    } else {
      appendPlainLog(tx(
        `Storage quota exceeded: ${primaryError?.message || ''}`,
        `存储配额超限：${primaryError?.message || ''}`
      ));
    }
  }

  function appendStorageNoticeOnce(key, text) {
    if (storageNoticeKeys.has(key)) {
      return;
    }
    storageNoticeKeys.add(key);
    showPluginToast(text, { status: 'warning', sticky: true });
  }

  function saveStateSoon(delayMs = 120, persistenceOptions = null) {
    pendingSaveStateOptions = mergeSaveStateOptions(pendingSaveStateOptions, persistenceOptions);
    // If a saveState() is already in flight, do NOT start a parallel one.
    // Mark the trailing flag so the in-flight save's completion callback
    // schedules another one — that way the final disk snapshot reflects
    // the latest state. Without this, a saveStateSoon() during an in-flight
    // save would either (a) start a parallel save whose stale snapshot
    // could overwrite the in-flight save's terminal data, or (b) be lost
    // because the debounce timer was cleared by another caller.
    if (saveStateInFlight) {
      saveStateRunAfterFlight = true;
      return;
    }
    if (saveStateTimer) {
      clearTimeout(saveStateTimer);
    }
    saveStateTimer = setTimeout(() => {
      saveStateTimer = null;
      runQueuedSaveState();
    }, delayMs);
  }

  function getComposerDraftScope() {
    return JSON.stringify([cachedAccountScopeId, getCurrentProjectId(), spaRouteGeneration, state.activeSessionId]);
  }

  function resetDraftSave() {
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
    pendingDraftSave = null;
  }

  function captureComposerDraft() {
    const input = panel?.querySelector('[data-task]');
    if (!input || !state.activeSessionId) return;
    const next = updateActiveSessionDraft(state, input.value);
    if (next === state) return;
    if (next.task !== state.task) {
      composerDraftEditedHere = true;
      if (currentRunView?.sessionId === state.activeSessionId) delete currentRunView.draftConsumption;
    }
    state = next;
    const now = Date.now(), scope = getComposerDraftScope();
    pendingDraftSave = {
      scope,
      projectId: getCurrentProjectId(),
      accountScopeId: cachedAccountScopeId,
      firstAt: pendingDraftSave?.scope === scope ? pendingDraftSave.firstAt : now
    };
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    const delay = Math.max(0, Math.min(DRAFT_SAVE_DELAY_MS, pendingDraftSave.firstAt + DRAFT_SAVE_MAX_WAIT_MS - now));
    draftSaveTimer = setTimeout(() => {
      draftSaveTimer = null;
      if (pendingDraftSave?.scope !== getComposerDraftScope()) { resetDraftSave(); return; }
      pendingDraftSave.firstAt = Date.now();
      // Join the existing writer immediately; never reset its timer on every key.
      saveStateSoon(0);
    }, delay);
  }

  async function flushComposerDraft({ requireDurable = false } = {}) {
    if (!pendingDraftSave) return;
    const scope = getComposerDraftScope();
    if (pendingDraftSave.scope !== scope) { resetDraftSave(); return; }
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
    pendingDraftSave.firstAt = Date.now();
    await flushQueuedSaveState(requireDurable ? { requireDurable: true } : null);
    if (requireDurable && scope !== getComposerDraftScope()) {
      throw new Error(tx('The active session changed while saving the draft. Try again.',
        '保存草稿时活动会话已改变，请重试。'));
    }
  }

  function flushComposerDraftOnLeave() {
    // Lifecycle events cannot await completion; periodic saves remain the primary protection.
    flushComposerDraft().catch(error => appendStorageNoticeOnce('save-failed', tx(
      `Failed to save session state: ${localizeVisibleReason(error.message)}`,
      `保存会话状态失败：${localizeVisibleReason(error.message)}`)));
  }

  function runQueuedSaveState() {
    if (saveStateInFlightPromise) {
      saveStateRunAfterFlight = true;
      return saveStateInFlightPromise;
    }
    saveStateInFlight = true;
    saveStateRunAfterFlight = false;
    const persistenceOptions = pendingSaveStateOptions;
    pendingSaveStateOptions = null;
    const runPromise = saveState(persistenceOptions)
      .catch(error => {
        if (isStorageQuotaError(error)) {
          // Structured FailureReason §9.8: timer-driven saveState raised a
          // quota error. saveState's own catch path already covers the
          // primary failure; this branch fires when the rethrow surfaces
          // here (e.g. fallback chrome.storage.local.set rethrew).
          emitStorageQuotaFailure(error, null);
        }
        if (persistenceOptions?.requireDurable || persistenceOptions?.reviewRunIds?.length) throw error;
        appendPlainLog(tx(`Failed to save session state: ${formatStateSaveError(error)}`, `保存会话状态失败：${formatStateSaveError(error)}`));
      })
      .finally(() => {
        if (saveStateInFlightPromise === runPromise) {
          saveStateInFlightPromise = null;
        }
        saveStateInFlight = false;
        if (saveStateRunAfterFlight) {
          // A saveStateSoon() landed during the in-flight phase. Flush it
          // now so the final disk snapshot reflects the latest state.
          saveStateRunAfterFlight = false;
          saveStateSoon(0);
        }
      });
    saveStateInFlightPromise = runPromise;
    return runPromise;
  }

  async function flushQueuedSaveState(persistenceOptions = null) {
    pendingSaveStateOptions = mergeSaveStateOptions(pendingSaveStateOptions, persistenceOptions);
    let persistLatestSnapshot = true;
    while (persistLatestSnapshot) {
      if (saveStateTimer) {
        clearTimeout(saveStateTimer);
        saveStateTimer = null;
      }
      if (saveStateInFlightPromise) {
        await saveStateInFlightPromise;
        if (saveStateTimer) {
          clearTimeout(saveStateTimer);
          saveStateTimer = null;
        }
      }

      saveStateRunAfterFlight = false;
      await runQueuedSaveState();
      persistLatestSnapshot = Boolean(
        saveStateTimer
        || saveStateRunAfterFlight
        || pendingSaveStateOptions
      );
    }
  }

  function mergeSaveStateOptions(current, incoming) {
    if (!incoming) return current;
    const queueMutations = [
      ...(current?.queueMutations || (current?.queueMutation ? [current.queueMutation] : [])),
      ...(incoming?.queueMutations || (incoming?.queueMutation ? [incoming.queueMutation] : []))
    ];
    return {
      ...(current || {}),
      ...incoming,
      queueMutation: undefined,
      reviewRunIds: Array.from(new Set([...(current?.reviewRunIds || []), ...(incoming?.reviewRunIds || [])])),
      queueMutations,
      deletedSessionIds: Array.from(new Set([
        ...(current?.deletedSessionIds || []),
        ...(incoming?.deletedSessionIds || [])
      ]))
    };
  }

  function scheduleRunStateSave(kind) {
    saveStateSoon(kind === 'stream' ? STREAM_SAVE_DELAY_MS : 120);
  }

  function isStorageQuotaError(error) {
    return /quota|kQuotaBytes|QUOTA_BYTES/i.test(String(error?.message || error || ''));
  }

  function formatStateSaveError(error) {
    if (isStorageQuotaError(error)) {
      return tx('Local session history is too large. Delete some old tasks and retry.', '本地会话记录太大，请删除一些旧任务后重试。');
    }
    return localizeVisibleReason(error?.message || String(error));
  }

  async function persistPanelInputs(event) {
    const globalWrite = getGlobalPreferences().handleInput(event);
    if (globalWrite) return globalWrite;
    // Draft edits retain run/event identity. Composition updates also capture the
    // current text; compositionend captures its committed value if no final input fires.
    if (event?.target?.matches?.('[data-task]')) {
      captureComposerDraft();
      if (event.type === 'change') await flushComposerDraft();
      return;
    }
    if (event?.target?.matches?.('[data-speed]')) {
      // Capability rendering consults state.speedTier. Capture the user's
      // choice before rebuilding the select, otherwise the rebuild projects
      // the previous tier back into the DOM and makes Fast appear inert.
      state.speedTier = event.target.value || 'standard';
      renderReasoningOptions(getRenderedModelEntries());
    }
    renderSpeedOptions(getRenderedModelEntries());
    readPanelInputs();
    // Only a user re-enabling Track requests another capability check. The
    // preceding input event and programmatic session renders must not reset it.
    if (event?.type === 'change' && event.isTrusted === true
      && event.target?.matches?.('[data-require-reviewing]') && event.target.checked
      && isReviewingKnownUnavailable()) {
      projectSettingsCoordinator.observeReviewingAvailability('unknown', 'user_retry');
      syncReviewingTooltip();
      syncProbeStatus();
    }
    renderModelConfigChoices();
    updateModelDisplay();
    renderContextUsage();
    // Save feedback is per-card now (settingsPanel flashSaved); the global
    // header chip and its Saving/Saved lifecycle are gone.
    await saveState();
    syncModeControls();
    applySessionLabel();
    renderSessionList();
  }

  function getRenderedModelEntries() {
    return Modules.ModelPickerSupport.getRenderedModelEntries(panel);
  }

  async function selectMode(mode) {
    if (!['ask', 'auto'].includes(mode)) {
      return;
    }
    const modeSelect = panel?.querySelector('[data-mode]');
    if (!modeSelect) {
      return;
    }
    modeSelect.value = mode;
    syncModeControls();
    await persistPanelInputs();
    await refreshProbe({ quiet: true });
  }

  function syncModeControls() {
    const currentMode = panel?.querySelector('[data-mode]')?.value || state?.mode || 'ask';
    panel?.querySelectorAll('[data-mode-choice]').forEach(button => {
      const active = button.dataset.modeChoice === currentMode;
      button.dataset.active = active ? 'true' : 'false';
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    syncProbeStatus(currentMode);
  }

  function readPanelInputs() {
    const projectId = getCurrentProjectId();
    if (getLastExperimentalOtProjectId() !== projectId) {
      syncExperimentalOtToggleForProject(projectId);
    }
    persistComposerAttachmentsToState();
    const model = readSelectedModelInput();
    const reasoningEffort = panel.querySelector('[data-reasoning]').value;
    const speedTier = readSelectedSpeedInput();
    state = updateActiveSession(state, {
      mode: panel.querySelector('[data-mode]').value,
      task: panel.querySelector('[data-task]').value,
      requireReviewing: panel.querySelector('[data-require-reviewing]').checked
    });
    state.providerId = state.providerId || 'builtin';
    state.model = model;
    state.reasoningEffort = reasoningEffort;
    state.speedTier = speedTier;
    if (state.session) {
      state.session.providerId = state.providerId;
    }
    state.autoRecompile = panel.querySelector('[data-auto-recompile]')?.checked !== false;
    const experimentalOtCheckbox = panel.querySelector('[data-experimental-ot]');
    if (experimentalOtCheckbox) {
      setExperimentalOtEnabledForProject(projectId, experimentalOtCheckbox.checked);
    }
    // The settings surface spans two screens: the settings screen and the
    // skills sub-page. The Codex Overleaf master toggle lives on the skills
    // screen, so both views must persist the settings inputs.
    if (panel?.dataset?.view === 'settings' || panel?.dataset?.view === 'skills') {
      const customInstructionsInput = panel?.querySelector('[data-custom-instructions-input]');
      if (customInstructionsInput) {
        setCustomInstructionsForProject(projectId, customInstructionsInput.value);
      }
      setGovernanceRulesForCurrentProject(readGovernanceRulesFromSettings());
      // Global controls are handled as field patches by getGlobalPreferences;
      // unrelated session autosaves must not read stale settings controls.
    }
  }

  function readSelectedModelInput() {
    const modelSelect = panel?.querySelector('[data-model]');
    return modelSelect?.value || state?.model || '';
  }

  function readSelectedSpeedInput() {
    const speedSelect = panel?.querySelector('[data-speed]');
    return speedSelect?.value || state?.speedTier || 'standard';
  }

  let composerDraftPersistence = null;
  let lastRunActivityBumpMs = 0;

  function getComposerDraftPersistence() {
    if (!composerDraftPersistence) composerDraftPersistence = Modules.ComposerAttachmentDraft.createController({
      getScope: () => ({ accountScopeId: cachedAccountScopeId, projectId: getCurrentProjectId() }),
      getAttachments: () => composerAttachmentController.serializePersistableAttachments(),
      setAttachments: value => { state.composerAttachments = value; },
      clear: () => composerAttachmentController.clear({ notify: false }),
      restore: value => composerAttachmentController.restorePersistedAttachments(value),
      read: scope => Modules.StorageDb.readComposerAttachmentDraft(scope),
      write: (scope, value) => Modules.StorageDb.writeComposerAttachmentDraft(scope, value),
      scheduleSave: () => saveStateSoon()
    });
    return composerDraftPersistence;
  }

  async function loadComposerAttachmentsForProject(accountScopeId, projectId) {
    if (!accountScopeId || !projectId) return [];
    try {
      return await getComposerDraftPersistence().load({ accountScopeId, projectId });
    } catch (error) {
      if (error?.code === 'stale_hydration' || error?.code === 'account_scope_unavailable') throw error;
      appendPlainLog(tx('Saved attachments could not be restored. Reattach the files before sending.',
        '已保存的附件无法恢复，请在发送前重新添加文件。'));
      return [];
    }
  }

  function persistComposerAttachmentsToState() {
    if (typeof composerAttachmentController?.serializePersistableAttachments === 'function') {
      state.composerAttachments = composerAttachmentController.serializePersistableAttachments();
    }
  }

  function clearTaskComposer({ keepAttachments = false, submission = null } = {}) {
    const taskInput = panel?.querySelector('[data-task]');
    if (submission) {
      if (submission.projectId !== getCurrentProjectId()
        || submission.accountScopeId !== cachedAccountScopeId) return false;
      if (findSessionById(submission.sessionId)?.task !== submission.task) return false;
      if (state.activeSessionId !== submission.sessionId) {
        updateSessionById(submission.sessionId, { task: '' });
        recordSubmittedDraftConsumption(submission.sessionId, submission.task);
        saveStateSoon();
        return false;
      }
      if (composerAttachmentController.getAttachmentByteUsage?.().pending > 0
        || selectionContextView.getRevision?.() !== submission.selectionRevision) return false;
      if (!runController.isSubmittedComposerUnchanged(submission, {
        task: taskInput?.value, attachments: getComposerAttachmentsForRun(),
        skillInvocation: getComposerSkillInvocationForRun(), selectionContext: selectionContextView.capture()
      })) return false;
    }
    if (taskInput) {
      taskInput.value = '';
    }
    composerDraftEditedHere = false;
    autosizeTaskTextarea();
    if (!keepAttachments) {
      composerAttachmentController.clear();
    }
    composerSkillInvocation = null;
    renderComposerSkillInvocation();
    selectionContextView.clear();
    state = updateActiveSession(state, { task: '' });
    if (submission) recordSubmittedDraftConsumption(submission.sessionId, submission.task);
    else if (currentRunView?.sessionId === state.activeSessionId) delete currentRunView.draftConsumption;
    saveStateSoon();
    return true;
  }

  function recordSubmittedDraftConsumption(sessionId, task) {
    if (task && currentRunView?.sessionId === sessionId
      && currentRunView.runProjectId === getCurrentProjectId()
      && currentRunView.runAccountScopeId === cachedAccountScopeId) {
      currentRunView.draftConsumption = { runId: currentRunView.recordId, task };
    }
  }

  function restoreRejectedLocalSkillSubmission(submission, checkpoint) {
    const input = panel?.querySelector('[data-task]');
    if (!checkpoint || !input || submission.accountScopeId !== cachedAccountScopeId
      || submission.projectId !== getCurrentProjectId() || submission.sessionId !== state.activeSessionId
      || !findSessionById(submission.sessionId) || input.value || state.task
      || composerDraftRevision !== checkpoint.draftRevision
      || getComposerAttachmentsForRun().length || composerAttachmentController.getAttachmentByteUsage?.().pending
      || composerAttachmentController.getRevision?.() !== checkpoint.attachmentRevision
      || selectionContextView.getRevision?.() !== checkpoint.selectionRevision
      || selectionContextView.capture() || getComposerSkillInvocationForRun()) return false;
    if (!composerAttachmentController.restoreSubmittedAttachments?.(submission.attachments, checkpoint.attachmentRevision)) return false;
    composerDraftRevision += 1;
    composerSkillInvocation = submission.skillInvocation;
    input.value = submission.task;
    state = updateActiveSession(state, { task: submission.task, selectionContext: submission.selectionContext });
    renderComposerSkillInvocation();
    selectionContextView.render();
    syncProbeStatus();
    autosizeTaskTextarea();
    syncComposerSendAvailability();
    saveStateSoon();
    return true;
  }

  function applyStateToPanel(options = {}) {
    if (pendingDraftSave && pendingDraftSave.scope !== getComposerDraftScope()) resetDraftSave();
    contextUsageView?.close();
    selectionContextView.render();
    writingStyleSettings.sync();
    applyPanelTheme(getThemePreference());
    if ((state.providerId || 'builtin') === 'builtin' && !modelSelectHasOption(state.model)) {
      renderModelOptions(getModelCatalog().FALLBACK_MODELS, state.model, {
        provisionalSelected: getModelDiscovery().provisional === true
      });
    }
    panel.querySelector('[data-model]').value = state.model;
    const renderedModels = getRenderedModelEntries();
    renderReasoningOptions(renderedModels);
    const reasoningSelect = panel.querySelector('[data-reasoning]');
    if (Array.from(reasoningSelect?.options || []).some(option => option.value === state.reasoningEffort)) {
      reasoningSelect.value = state.reasoningEffort;
    }
    renderSpeedOptions(renderedModels);
    panel.querySelector('[data-speed]').value = state.speedTier;
    panel.querySelector('[data-mode]').value = state.mode;
    panel.querySelector('[data-task]').value = state.task;
    // Programmatic value changes fire no input event: re-sync the autogrow
    // height and the empty-task send disable (session switch / init restore).
    autosizeTaskTextarea();
    syncComposerSendAvailability();
    panel.querySelector('[data-require-reviewing]').checked = state.requireReviewing;
    syncReviewingTooltip();
    const recompileCheckbox = panel?.querySelector('[data-auto-recompile]');
    if (recompileCheckbox) {
      recompileCheckbox.checked = state.autoRecompile !== false;
    }
    syncExperimentalOtToggleForProject();
    syncCustomInstructionsEditorForProject();
    if (typeof syncProjectSettingsEditorForProject === 'function') {
      syncProjectSettingsEditorForProject();
    }
    applyPanelWidth(state.panelWidth || PANEL_DEFAULT_WIDTH, { persist: false });
    renderModelConfigChoices();
    updateModelDisplay();
    syncModeControls();
    applySessionLabel();
    renderSessionList();
    renderRunHistory(options);
    renderPendingInputs();
    getTrackedChangeCaptureController().schedule();
    renderContextSelection();
    renderContextSummary();
    getComposerDraftPersistence().hydrate(state.composerAttachments);
    renderComposerAttachments();
    renderComposerSkillInvocation();
    applyLocaleToPanel({ reprojectDynamic: false });
    if (!panel.querySelector('[data-context-tray]')?.hidden) {
      renderContextFiles();
    }
  }

  function modelSelectHasOption(modelId) {
    const selectedId = normalizeModelOptionId(modelId);
    if (!selectedId) {
      return true;
    }
    const modelSelect = panel?.querySelector('[data-model]');
    return Array.from(modelSelect?.options || []).some(option => option.value === selectedId);
  }


  function setRunning(running) {
    syncComposerSendAvailability(running);
    panel.querySelector('[data-new-session]').disabled = false;
    panel.querySelector('[data-diagnostics-snapshot]').disabled = running;
    if (running) {
      closeDiagnosticsMenu();
    }
    panel.dataset.running = running ? 'true' : 'false';
    panel.dataset.cancelling = running && runCancellationRequested ? 'true' : 'false';
    panel.querySelectorAll('[data-run-id]').forEach(root => {
      const record = findRunRecord(root.dataset.runId);
      if (record) configureEditButton(root, record, { running });
      if (record) configureWritebackButton(root, record, { running });
    });
    renderPendingInputs();
    renderContextUsage();
  }

  function renderContextUsage() {
    if (!contextUsageView || !state) return;
    contextUsageView.setState(getContextUsageDisplay());
  }

  function getContextUsageDisplay() {
    const session = getActiveSession(state);
    const run = currentRunView?.sessionId === session?.id
      ? findRunRecord(currentRunView.recordId, currentRunView.sessionId) : null;
    const selection = providerSettingsCoordinator.getRunSelection(state.providerId);
    const runningSelection = run?.status === 'running' && run.model === state.model
      && (run.providerId || 'builtin') === (state.providerId || 'builtin');
    const scope = {
      threadId: session?.codexThreadId || '',
      providerId: state.providerId || 'builtin',
      providerRevision: runningSelection ? Number(run.providerRevision || 0)
        : selection?.providerRevision ?? ((state.providerId || 'builtin') === 'builtin' ? 0 : null),
      model: state.model || ''
    };
    // The composer can select the next turn's model while this turn runs.
    // Only show statistics produced by the selected model and provider.
    const matchesRun = run && run.model === scope.model
      && (run.providerId || 'builtin') === scope.providerId
      && Number(run.providerRevision || 0) === scope.providerRevision;
    // Starting another turn must not revive statistics from before an automatic
    // compaction. Retain the watermark across this thread's saved normal runs.
    const compactedAt = (session?.runs || []).reduce((latest, candidate) => candidate && !candidate.forkSnapshot
      && candidate.operation !== 'compact' && scope.threadId && candidate.codexThreadId === scope.threadId
      ? Math.max(latest, Modules.RunActivityModel.getCompactedAt(candidate)) : latest, 0);
    const { usage, pending, compacted } = Modules.ContextUsage.status(session, { ...scope, compactedAt });
    const compacting = Boolean(matchesRun && Modules.RunActivityModel.project(run).compacting);
    return { usage, pending, compacted, compacting, compactingKind: compacting ? (run.operation === 'compact' ? 'manual' : 'auto') : '' };
  }

  function getCompactAvailability() {
    if (sessionManager.isTransitioning() || updateIdleClient?.isApplying() || currentRunView || runSubmissionPending) return { ok: false, reason: 'compactBusy' };
    if (!getActiveSession(state)?.codexThreadId) return { ok: false, reason: 'compactNoThread' };
    return { ok: true };
  }

  function prepareRetryReplacement(run, task) {
    const sessionId = state?.activeSessionId || '';
    const source = findRunRecord(run?.id, sessionId);
    const eligible = source && !source.forkSnapshot
      && (!source.runProjectId || source.runProjectId === getCurrentProjectId())
      && runController.isRetryReplacementEligible(
      source,
      WritebackSettlement.projectRunSettlement(source)
    );
    const returnToDraft = eligible && !currentRunView
      && ['cancelled', 'rejected'].includes(source.status);
    const draft = { task: typeof task === 'string' ? task : String(run?.task || '') };
    if (returnToDraft) {
      const snapshot = source.executionSnapshot || {};
      const mode = snapshot.mode || source.mode;
      draft.runs = (state.runs || []).filter(item => item.id !== source.id);
      draft.mode = ['ask', 'auto'].includes(mode) ? mode : state.mode;
      draft.focusFiles = Array.isArray(snapshot.focusFiles) ? snapshot.focusFiles : state.focusFiles;
      draft.selectionContext = snapshot.selectionContext || null;
    }
    // Persist the composer through its session owner, not only the top-level alias.
    state = updateActiveSession(state, draft);
    pendingRetryReplacement = eligible && !returnToDraft ? { sessionId, runId: source.id } : null;
    if (returnToDraft) applyStateToPanel({ preserveScroll: true });
    return Boolean(eligible);
  }

  function startRunView({
    sessionId = state.activeSessionId,
    sessionContext = runController.captureSessionContext(state),
    codexThreadId = '',
    operation,
    task,
    mode,
    model,
    reasoningEffort,
    speedTier,
    queueItemId = '',
    replaceRunId = '',
    executionSnapshot = null
  }) {
    let attachments = [];
    if (Array.isArray(arguments[0]?.attachments)) {
      attachments = arguments[0].attachments;
    }
    resetAutoFollow();
    const record = {
      id: createRunId(),
      ...(operation === 'compact' ? { operation } : {}),
      task,
      mode,
      ...providerSettingsCoordinator.getProviderSnapshot(executionSnapshot?.providerId || state?.providerId),
      providerRevision: executionSnapshot?.providerRevision || '',
      model,
      reasoningEffort,
      speedTier,
      status: 'running',
      statusText: tr('processing', { elapsed: '' }).trim(),
      startedAt: new Date().toISOString(),
      finishedAt: '',
      attachments: createRunAttachmentSnapshots(attachments),
      events: [],
      undoOperations: [],
      undoTrackedChanges: [],
      undoExpectedFiles: [],
      undoStatus: '',
      queueItemId,
      nativeRequestId: '', codexThreadId: '',
      codexTurnId: '',
      nativeEventSeq: 0,
      executionSnapshot: executionSnapshot
        ? RunExecutionSnapshot.cloneSnapshot(executionSnapshot)
        : undefined,
      // Writeback/Accept/Undo carry this immutable project identity to Page.
      runProjectId: getCurrentProjectId() || '',
      runAccountScopeId: cachedAccountScopeId || ''
    };
    const active = findSessionById(sessionId);
    const titlePatch = operation !== 'compact' && active?.titleSource !== 'manual'
      ? {
        title: deriveSessionTitle([], task),
        titleSource: 'auto'
      }
      : {};
    // Establish the in-memory owner before publishing or rendering the record.
    // If presentation throws, runTask still has the identity needed to settle it.
    const view = currentRunView = {
      operation, sessionId, sessionContext, codexThreadId, recordId: record.id,
      runProjectId: record.runProjectId, runAccountScopeId: record.runAccountScopeId,
      executionSnapshot: record.executionSnapshot, startedAt: Date.now(), queueItemId,
      nativeRequestId: '', activeTurn: null
    };
    updateSessionById(sessionId, {
      runs: runController.replaceRunForRetry(active?.runs, replaceRunId, record),
      ...titlePatch
    });
    saveStateSoon(replaceRunId ? 0 : 120);

    const log = panel.querySelector('[data-log]');
    const root = renderRunCard(record);
    Object.assign(view, {
      root,
      runProcess: root.querySelector('[data-run-process]'),
      processLabel: root.querySelector('[data-run-process-summary]'),
      events: root.querySelector('[data-run-events]'),
      report: root.querySelector('[data-run-report]'),
      status: root.querySelector('[data-run-status]'),
      // Seed references before warm-mirror resolution produces its snapshot.
      projectFiles: getCurrentProjectReferenceFiles()
    });
    if (state.activeSessionId === sessionId) {
      removeEmptyRunsMessage(log);
      if (replaceRunId) log.querySelector(`[data-run-id="${cssEscape(replaceRunId)}"]`)?.remove();
      log.append(root);
      scrollLogToBottom({ force: true });
    }
    startRunElapsedTick();
    renderSessionList();
    applySessionLabel();

    return view;
  }

  function touchSessionForTerminalRun(sessionId, finishedAt) {
    const session = Array.isArray(state.sessions)
      ? state.sessions.find(item => item?.id === sessionId)
      : null;
    if (!session) return '';
    const previousUpdatedAt = Date.parse(session.updatedAt || '') || 0;
    const requestedUpdatedAt = Date.parse(finishedAt || '') || Date.now();
    const updatedAt = new Date(Math.max(requestedUpdatedAt, previousUpdatedAt + 1)).toISOString();
    session.updatedAt = updatedAt;
    session.lastActivityAt = updatedAt;
    return updatedAt;
  }

  async function finishRunView(text, status) {
    if (!currentRunView) {
      return;
    }
    stopRunElapsedTick();
    const safeText = sanitizeAssistantVisibleText(text);
    const record = findRunRecord(currentRunView.recordId, currentRunView.sessionId);
    flushPendingStreamRenders();
    const statusText = formatProcessedSummary(status, Date.now() - currentRunView.startedAt);
    if (record) {
      record.status = status;
      record.statusText = statusText;
      record.finishedAt = new Date().toISOString();
      touchSessionForTerminalRun(currentRunView.sessionId, record.finishedAt);
      currentRunView.terminalStatus = status;
      runGuidanceController.settleView(currentRunView);
      // Welcome-panel + write-guard:
      // when the user navigated away mid-run, the URL-derived projectId now
      // belongs to a different project (or /project). Routing this finish
      // through `saveStateSoon` -> `saveState` would persist the original
      // project's in-memory sessions to the WRONG projectId key. The
      // post-navigation `persistPostNavigationRunStatus` path (T4) is the
      // only allowed persistence path here; it writes directly to the
      // original project's IDB record by sessionId.
      const navigationDivergent = currentRunView.runProjectId
        && activeProjectId !== currentRunView.runProjectId;
      if (!navigationDivergent) {
        // A terminal badge is a durability promise: once the user can see
        // Done/Failed/Cancelled, an immediate reload must hydrate that same
        // terminal state. Drain any older running snapshot and persist the
        // latest record before exposing the terminal UI.
        await flushQueuedSaveState().catch(() => {});
      }
      renderSessionList();
    }
    const visibleView = getCurrentRunViewForRender();
    if (visibleView) {
      visibleView.root.dataset.status = status;
      visibleView.root.title = [
        safeText,
        record?.mode ? `${tr('mode')}: ${formatModeLabel(record.mode)}` : '',
        record?.model,
        record?.reasoningEffort,
        record?.speedTier
      ].filter(Boolean).join(' · ');
      collapseRunProcess(visibleView, statusText);
    }
    renderContextUsage();
  }


  function appendNativeEvent(event, journalSeq = 0) {
    if (!event) {
      return;
    }

    if (event.type === 'codex.turn.bound') {
      bindActiveTurn(event.detail || {}, journalSeq);
      return;
    }

    const owner = currentRunView && findRunRecord(currentRunView.recordId, currentRunView.sessionId);
    if (storeContextUsage(event, owner, findSessionById(currentRunView?.sessionId), journalSeq)) {
      scheduleRunStateSave('stream');
      renderContextUsage();
      return;
    }
    if (owner && Modules.SubagentActivityModel.ingest(owner, event, {
      locale: getLocale(), sanitize: sanitizeAssistantVisibleText, nativeEventSeq: journalSeq
    })) {
      owner.nativeEventSeq = Math.max(Number(owner.nativeEventSeq || 0), Number(journalSeq || 0));
      scheduleRunStateSave('stream');
      const visible = getCurrentRunViewForRender();
      if (visible) runTimelineView.refreshActivitySummary?.(visible);
      return;
    }

    const activity = mapAgentEventToActivity(event, { locale: getLocale() });
    if (!activity?.visible || activity.kind === 'technical') {
      return;
    }

    appendRunEvent({
      kind: activity.kind || 'activity',
      subagent: activity.subagent === true ? true : undefined,
      title: activity.title,
      status: activity.status || 'running',
      detail: activity.detail,
      technicalDetail: activity.technicalDetail,
      streamKey: activity.streamKey,
      streamRole: activity.streamRole,
      appendText: activity.appendText,
      replaceText: activity.replaceText,
      nativeEventSeq: journalSeq
    });
    if (activity.kind !== 'stream') renderContextUsage();
  }

  function storeContextUsage(event, record, session, sequence) {
    if (!record) return false;
    const usage = Modules.ContextUsage.fromEvent(event, {
      ...record, providerRevision: Number(record.providerRevision || 0), eventSeq: sequence
    });
    if (!usage || !Modules.ContextUsage.isNewer(usage, record.contextUsage)) return false;
    record.contextUsage = usage;
    record.nativeEventSeq = Math.max(Number(record.nativeEventSeq || 0), Number(sequence || 0));
    if (session?.codexThreadId === usage.threadId
      && Modules.ContextUsage.isNewer(usage, session.contextUsage)) session.contextUsage = usage;
    return true;
  }

  function bindActiveTurn(detail = {}, journalSeq = 0) {
    if (!currentRunView) {
      return;
    }
    const threadId = String(detail.threadId || '');
    const turnId = String(detail.turnId || '');
    currentRunView.activeTurn = currentRunView.operation === 'compact' ? null : { threadId, turnId };
    const record = findRunRecord(currentRunView.recordId, currentRunView.sessionId);
    if (record) {
      record.codexThreadId = threadId; record.codexTurnId = turnId;
      if (record.operation === 'compact') {
        const session = findSessionById(currentRunView.sessionId);
        if (session?.contextUsage?.threadId === threadId
          && Date.parse(session.contextUsage.observedAt) < Date.parse(record.startedAt)) {
          session.contextUsage = null;
        }
      }
      record.nativeEventSeq = Math.max(Number(record.nativeEventSeq || 0), Number(journalSeq || 0));
    }
    if (threadId) {
      updateSessionById(currentRunView.sessionId, { codexThreadId: threadId });
    }
    renderPendingInputs();
    renderContextUsage();
    saveState().catch(() => {});
  }

  function appendTechnicalEvent(event) {
    void event;
  }

  function normalizeRawAgentEvent(event) {
    return {
      type: event?.type || 'unknown',
      title: event?.title || '',
      status: event?.status || '',
      timestamp: event?.timestamp || '',
      detail: event?.detail || {}
    };
  }

  function appendRunEvent(input = {}) {
    const { title, status = 'info', detail, timestamp } = input;
    const safeTitle = sanitizeAssistantVisibleText(title) || 'Event';
    if (!currentRunView) {
      appendPlainLog(safeTitle);
      return;
    }

    const event = {
      title: safeTitle,
      status: sanitizeAssistantVisibleText(status) || 'info',
      detail: sanitizeAssistantVisibleValue(detail),
      timestamp: timestamp || new Date().toISOString(),
      kind: input.kind || 'activity',
      subagent: input.subagent === true ? true : undefined,
      technicalDetail: sanitizeAssistantVisibleValue(input.technicalDetail),
      activity: Modules.RunActivityModel.capture(input, sanitizeAssistantVisibleText),
      guidanceId: sanitizeAssistantVisibleText(input.guidanceId),
      streamKey: sanitizeAssistantVisibleText(input.streamKey),
      streamRole: sanitizeAssistantVisibleText(input.streamRole),
      streamPhase: sanitizeAssistantVisibleText(input.streamPhase),
      appendText: typeof input.appendText === 'string' ? sanitizeAssistantVisibleText(input.appendText) : input.appendText,
      replaceText: input.replaceText,
      // Structured FailureReason (§7) attached to the event when the caller
      // emits a content-side failure. Sanitized like other user-visible
      // payloads so it stays JSON-safe through the run-record persistence
      // path. Downstream renderers (and tests) can read `event.failure`.
      failure: input.failure ? sanitizeAssistantVisibleValue(input.failure) : undefined,
      // Structured completion-report payload (conclusion + body + meta rows)
      // for the report-kind render path. Sanitized so it survives storage
      // round-trips; the renderer falls back to `detail` text when absent
      // (legacy / recovered-history events).
      detailStructured: input.detailStructured ? sanitizeAssistantVisibleValue(input.detailStructured) : undefined,
      // Post-write compile errors (strings, capped) ride on the report event
      // so the renderer can offer a one-click "fix compile errors" retry.
      compileErrors: Array.isArray(input.compileErrors) && input.compileErrors.length
        ? input.compileErrors.slice(0, 5).map(item => sanitizeAssistantVisibleText(String(item))).filter(Boolean)
        : undefined,
      // Hunks the user rejected during review ({path, summary}, capped) so
      // the report can offer "redo the rejected changes".
      rejectedHunks: Array.isArray(input.rejectedHunks) && input.rejectedHunks.length
        ? input.rejectedHunks.slice(0, 10).map(item => ({
            path: sanitizeAssistantVisibleText(String(item?.path || '')),
            summary: sanitizeAssistantVisibleText(String(item?.summary || ''))
          })).filter(item => item.path)
        : undefined
    };
    // Keep the activity timestamp current without retaining a run reference
    // across session normalization, which replaces run and event objects.
    const nowMs = Date.now();
    if (nowMs - lastRunActivityBumpMs > 60000
      && findRunRecord(currentRunView.recordId, currentRunView.sessionId)) {
      lastRunActivityBumpMs = nowMs;
      state = updateActiveSession(state, {});
    }
    const record = findRunRecord(currentRunView.recordId, currentRunView.sessionId);
    let renderedEvent = event;
    if (record) {
      if (Number.isFinite(Number(input.nativeEventSeq))) {
        record.nativeEventSeq = Math.max(Number(record.nativeEventSeq || 0), Number(input.nativeEventSeq || 0));
      }
      renderedEvent = event.kind === 'stream'
        ? upsertRunStreamRecordEvent(record, event)
        : event;
      if (event.kind !== 'stream') {
        record.events = [...(record.events || []), event].slice(-MAX_RUN_EVENTS);
      }
      scheduleRunStateSave(event.kind);
    }

    const visibleView = getCurrentRunViewForRender();
    if (visibleView) {
      if (event.kind === 'stream') {
        scheduleStreamEventRender(renderedEvent);
      } else {
        flushPendingStreamRenders();
        appendRunEventToView(visibleView, renderedEvent);
        scrollLogToBottom();
      }
    }
  }

  function scheduleStreamEventRender(event) {
    const streamKey = event.streamKey || event.streamRole || 'codex-stream';
    pendingStreamRenderEvents.set(streamKey, { ...event });
    if (streamRenderTimer) {
      return;
    }
    streamRenderTimer = setTimeout(flushPendingStreamRenders, STREAM_RENDER_FLUSH_MS);
  }

  function flushPendingStreamRenders() {
    if (streamRenderTimer) {
      clearTimeout(streamRenderTimer);
      streamRenderTimer = null;
    }
    if (!pendingStreamRenderEvents.size) {
      return;
    }
    const events = Array.from(pendingStreamRenderEvents.values());
    pendingStreamRenderEvents.clear();
    const visibleView = getCurrentRunViewForRender();
    if (!visibleView) {
      return;
    }
    for (const event of events) {
      appendRunEventToView(visibleView, event);
    }
    scrollLogToBottom();
  }

  function getCurrentRunViewForRender() {
    if (!currentRunView || currentRunView.sessionId !== state.activeSessionId) {
      return null;
    }
    if (currentRunView.root?.isConnected) {
      return currentRunView;
    }
    const root = panel?.querySelector(`[data-run-id="${cssEscape(currentRunView.recordId)}"]`);
    if (!root) {
      return null;
    }
    currentRunView.root = root;
    currentRunView.runProcess = root.querySelector('[data-run-process]');
    currentRunView.processLabel = root.querySelector('[data-run-process-summary]');
    currentRunView.guidance = root.querySelector('[data-run-guidance]');
    currentRunView.events = root.querySelector('[data-run-events]');
    currentRunView.report = root.querySelector('[data-run-report]');
    currentRunView.status = root.querySelector('[data-run-status]');
    return currentRunView;
  }

  function appendRunEventToView(view, event) {
    const projected = event.kind !== 'stream' && runTimelineView.refreshActivitySummary?.(view, event);
    if (event.kind === 'report') {
      view.report.hidden = false;
      const record = view?.recordId ? findRunRecord(view.recordId, view.sessionId) : null;
      view.report.replaceChildren(renderCompletionReport(event, record));
      bumpUnreadIfDetached();
      return;
    }
    if (event.kind === 'technical') {
      return;
    }
    if (projected) { bumpUnreadIfDetached(); return; }
    if (runGuidanceController.appendToView(event, view)) return;
    if (event.kind === 'stream') {
      // Stream deltas update an existing line in place — they must not inflate
      // the unread-step counter.
      upsertStreamEvent(view, event);
      return;
    }
    runTimelineView.appendActivityDetail(view, renderRunEvent(event), event);
    bumpUnreadIfDetached();
  }

  function upsertRunStreamRecordEvent(record, event) {
    const streamKey = event.streamKey || event.streamRole || 'codex-stream';
    const events = Array.isArray(record.events) ? record.events : [];
    const existing = [...events].reverse().find(item => item.kind === 'stream' && item.streamKey === streamKey);
    if (existing) {
      const nextTitle = sanitizeAssistantVisibleText(event.title);
      const nextRole = sanitizeAssistantVisibleText(event.streamRole) || existing.streamRole;
      if (event.streamPhase) existing.streamPhase = event.streamPhase;
      const combinedTitle = event.replaceText
        ? nextTitle
        : sanitizeAssistantVisibleText(appendStreamText(existing.title, nextTitle));
      existing.title = nextRole === 'reasoning' ? stripEmptyHtmlCommentPlaceholders(combinedTitle) : combinedTitle;
      existing.status = sanitizeAssistantVisibleText(event.status) || existing.status || 'running';
      existing.timestamp = event.timestamp || existing.timestamp;
      existing.streamRole = nextRole;
      return existing;
    }

    const streamRole = sanitizeAssistantVisibleText(event.streamRole);
    const title = sanitizeAssistantVisibleText(event.title);
    const next = {
      ...event,
      streamKey,
      streamRole,
      title: streamRole === 'reasoning' ? stripEmptyHtmlCommentPlaceholders(title) : title
    };
    delete next.appendText;
    delete next.replaceText;
    record.events = [...events, next].slice(-MAX_RUN_EVENTS);
    return next;
  }

  function appendStreamText(current, delta) {
    const left = String(current || '');
    const right = String(delta || '');
    if (!left) {
      return right;
    }
    if (!right) {
      return left;
    }
    return `${left}${right}`;
  }

  function getAssistantAnswerForCurrentRun() {
    const record = currentRunView?.recordId ? findRunRecord(currentRunView.recordId, currentRunView.sessionId) : null;
    const events = Array.isArray(record?.events) ? record.events : [];
    const answers = events
      .filter(event =>
        event.kind === 'stream' &&
        event.streamRole === 'assistant' &&
        cleanFinalAnswer(event.title)
      )
      .map(event => cleanFinalAnswer(event.title))
      .filter(Boolean);
    return dedupeTextValues(answers).join('\n\n');
  }

  function cleanFinalAnswer(value) {
    return String(value || '').trim();
  }

  function dedupeTextValues(values = []) {
    return values.filter((value, index) => values.indexOf(value) === index);
  }


  function applyPanelWidth(width, options = {}) {
    const nextWidth = PanelRenderer.setWidth(panelRendererInstance, width, { notify: false });
    if (state) {
      state.panelWidth = nextWidth;
    }
    if (options.persist !== false) {
      saveStateSoon();
    }
    return nextWidth;
  }

  function getCurrentProjectMathSources() {
    const sources = [];
    const seen = new Set();
    let remainingChars = 256 * 1024;
    const add = item => {
      if (!item || typeof item !== 'object' || typeof item.content !== 'string') return;
      const path = normalizeReferencePathForRuntime(item.path || item.filePath || '');
      if (!path || seen.has(path) || hasUnsafeRuntimePathSegments(path)
        || !/\.(?:tex|sty|cls|ltx)$/i.test(path) || remainingChars <= 0) return;
      const content = item.content.slice(0, Math.min(64 * 1024, remainingChars));
      remainingChars -= content.length;
      seen.add(path);
      sources.push({ path, content });
    };
    for (const collection of [
      currentRunView?.projectFiles,
      currentRunView?.files,
      currentRunView?.project?.files,
      currentRunView?.snapshot?.files,
      currentRunView?.projectSnapshot?.files,
      currentRunView?.contextFiles,
      state?.projectFiles,
      state?.files,
      state?.project?.files,
      state?.snapshot?.files,
      state?.projectSnapshot?.files,
      state?.contextFiles
    ]) {
      if (Array.isArray(collection)) collection.forEach(add);
    }
    return sources;
  }

  function getCurrentProjectReferenceFiles() {
    const files = [];
    const seen = new Set();
    const addFile = (item, textPathOnly = false) => {
      if (typeof item === 'string') {
        addReferenceFile({ path: item, kind: 'text' });
        return;
      }
      if (!item || typeof item !== 'object') {
        return;
      }
      const path = typeof item.path === 'string'
        ? item.path
        : (typeof item.filePath === 'string' ? item.filePath : '');
      if (!path) {
        return;
      }
      const isBinary = item.kind === 'binary'
        || item.type === 'binary'
        || item.binary === true
        || item.isBinary === true;
      const kind = isBinary
        ? 'binary'
        : (item.kind === 'text' || textPathOnly || typeof item.content === 'string' || !Object.prototype.hasOwnProperty.call(item, 'content')
          ? 'text'
          : 'binary');
      addReferenceFile({ path, kind });
    };
    const addReferenceFile = file => {
      const normalizedPath = normalizeReferencePathForRuntime(file.path);
      if (!normalizedPath || seen.has(normalizedPath) || hasUnsafeRuntimePathSegments(normalizedPath)) {
        return;
      }
      seen.add(normalizedPath);
      files.push({
        path: normalizedPath,
        kind: file.kind === 'binary' ? 'binary' : 'text'
      });
    };
    const addFiles = value => {
      if (Array.isArray(value)) {
        value.forEach(item => addFile(item));
      }
    };
    const addTextPaths = value => {
      if (Array.isArray(value)) {
        value.forEach(item => addFile(item, true));
      }
    };

    const activeSession = typeof getActiveSession === 'function' ? getActiveSession(state) : null;
    addFiles(currentRunView?.projectFiles);
    addFiles(activeSession?.projectReferenceFiles);
    // ContextTray owns the exact, background-prefetched project file list.
    // Warm-mirror runs intentionally carry only the active/focused overlay, so
    // omitting this inventory makes valid references to every other project
    // file render as plain text.
    addFiles(contextTrayController?.getContextProject?.()?.files);
    addFiles(currentRunView?.files);
    addFiles(currentRunView?.project?.files);
    addFiles(currentRunView?.snapshot?.files);
    addFiles(currentRunView?.projectSnapshot?.files);
    addFiles(currentRunView?.contextFiles);
    addFiles(state?.projectFiles);
    addFiles(state?.files);
    addFiles(state?.project?.files);
    addFiles(state?.snapshot?.files);
    addFiles(state?.projectSnapshot?.files);
    addFiles(state?.contextFiles);
    addTextPaths(state?.focusFiles);
    addTextPaths(state?.session?.focusFiles);
    addTextPaths(activeSession?.focusFiles);
    for (const session of Array.isArray(state?.sessions) ? state.sessions : []) {
      addFiles(session?.projectReferenceFiles);
      addTextPaths(session?.focusFiles);
    }
    return files;
  }

  function refreshHistoricalProjectReferences(project) {
    if (!project?.id || String(project.id) !== getCurrentProjectId()) return;
    state = updateActiveSession(state, { projectReferenceFiles: captureProjectReferenceFiles(project) });
    saveStateSoon();
    if (!currentRunView && !trackedChangeInFlight.size) renderRunHistory({ preserveScroll: true });
  }

  function persistCurrentProjectReferenceFiles(project) {
    const projectFiles = captureProjectReferenceFiles(project);
    if (currentRunView) {
      currentRunView.projectFiles = projectFiles;
    }
    if (getActiveSession(state)) {
      state = updateActiveSession(state, { projectReferenceFiles: projectFiles });
      saveStateSoon();
    }
    return projectFiles;
  }

  function captureProjectReferenceFiles(project) {
    const result = [];
    const seen = new Set();
    const files = Array.isArray(project?.files) ? project.files : [];
    for (const file of files) {
      const path = normalizeReferencePathForRuntime(file?.path);
      if (!path || seen.has(path) || hasUnsafeRuntimePathSegments(path)) {
        continue;
      }
      seen.add(path);
      const isBinary = file?.kind === 'binary'
        || file?.type === 'binary'
        || file?.binary === true
        || file?.isBinary === true;
      result.push({
        path,
        kind: isBinary ? 'binary' : 'text'
      });
    }
    return result;
  }


  function isUndoResultEffectivelyApplied(run, result) {
    return WritebackSettlement.isUndoResultEffectivelyApplied(
      run,
      result,
      buildNoTraceUndoRestore(run).operations
    );
  }

  let runReviewController = null;
  function getRunReviewController() {
    if (!runReviewController) runReviewController = Modules.RunReviewController.create({
      Modules, WritebackSettlement, trackedChangeInFlight, findRunRecord,
      getRunUndoCount, isTrackedChangeLifecycleRun, getPendingMirrorRefresh, hasTrackedEditorUndo, buildNoTraceUndoRestore,
      findUnsafeFullFileUndoOperation, showUndoFileSelection, showPluginConfirm, tr,
      truncateRunTitle, formatOperationFiles, formatTrackedChangeFiles, formatTrackedUndoFiles,
      getPageBridgeTimeoutMs, callPageBridge, setRunUndoStatus, appendRunRecordEvent, getRunProjectIdForWriteback,
      isUndoResultEffectivelyApplied, writebackOrchestrator, appendUndoReviewingPolicyEvent, formatOperationType,
      formatApplyResultReason, buildTrackedUndoPostFiles, getTrackedChangeCaptureController, buildContentFailure,
      applyTrackedChangeSettlement, refreshRunCardControls, formatBridgeResultReason, advanceRunUndoProgress,
      saveStateSoon, flushQueuedSaveState,
      getState: () => state, getCurrentProjectId, getAccountScopeId: () => cachedAccountScopeId,
      getRouteGeneration: () => spaRouteGeneration, tx, notify: message => showPluginToast(message, { status: 'warning', sticky: true })
    });
    return runReviewController;
  }

  async function undoRun(runId) {
    return getRunReviewController().undoRun(runId);
  }

  async function undoRunTrackedChanges(runId, run) {
    return getRunReviewController().undoRunTrackedChanges(runId, run);
  }

  async function acceptRun(runId) {
    return getRunReviewController().acceptRun(runId);
  }

  function getRunProjectIdForWriteback(run) {
    return typeof run?.runProjectId === 'string' && run.runProjectId
      ? run.runProjectId
      : '';
  }

  function buildContentFailure(code, operation, overrides) {
    return WritebackSettlement.buildContentFailure(
      code,
      operation,
      overrides,
      FailureReasons
    );
  }

  async function applyTrackedChangeSettlement(runId, kind, result, options = {}) {
    const record = findRunRecord(runId);
    const run = kind === 'reject' ? advanceRunUndoProgress(record, result) : record;
    const settlement = WritebackSettlement.settleTrackedChangeLifecycle({
      kind,
      run,
      result,
      failureReasons: FailureReasons
    });
    if (settlement.decision === 'blocked'
      && !(kind === 'reject' && (run !== record || record?.undoOperations?.some(Modules.UndoOperations.isFileUndoOperation)))) {
      return;
    }
    await Modules.ScopedPersistenceCoordinator.applyReviewTransition({
      getState: () => state, runId, transition: WritebackSettlement.applySettlementTransition(run, settlement),
      persist: flushQueuedSaveState, assertCurrent: options.assertCurrent, SessionState: Modules.SessionState
    });
  }


  function advanceRunUndoProgress(run, result) {
    getDirectoryCleanupRecovery().capture({ recordId: run.id, sessionId: state.activeSessionId,
      runProjectId: run.runProjectId, runAccountScopeId: run.runAccountScopeId }, result);
    const postFiles = buildTrackedUndoPostFiles(run);
    return Modules.UndoOperations.advanceUndoCheckpoint(run, result, file =>
      WritebackSettlement.isUndoVerifiedContentMatching({ undoExpectedFiles: [file] }, result, { postFiles })
    );
  }
  function getRunUndoCount(run) {
    if (!run) {
      return 0;
    }
    run = Modules.UndoOperations.withAvailableUndo(run);
    const trackedEditorUndoCount = hasTrackedEditorUndo(run) ? 1 : 0;
    if (trackedEditorUndoCount) {
      return trackedEditorUndoCount + Modules.UndoOperations.getFileUndoOperations(run).length;
    }
    return Modules.UndoOperations.prepareRunUndo(run).undoOperations.length
      + (run.undoTrackedChanges?.length || 0);
  }

  function recoveryOwner(target) {
    if (!target.runProjectId || target.runProjectId !== getCurrentProjectId() || !cachedAccountScopeId) {
      throw new Error('Writeback recovery lost its project or account identity.');
    }
    return { projectId: target.runProjectId, accountScopeId: cachedAccountScopeId,
      sessionId: target.sessionId, runId: target.recordId, createdAt: new Date().toISOString() };
  }

  let directoryCleanupRecovery = null;
  function getDirectoryCleanupRecovery() {
    return directoryCleanupRecovery || (directoryCleanupRecovery = Modules.DirectoryCleanupRecovery.create({
      getProjectId: getCurrentProjectId, getAccountScopeId: () => cachedAccountScopeId,
      getRouteGeneration: () => spaRouteGeneration, findRunRecord, refresh: refreshRunCardControls,
      onOmitted: (runId, code) => appendRunRecordEvent(runId, { kind: 'technical', status: 'warning',
        title: tx('Some folder observations exceeded the storage limit; existing observations were kept.',
          '部分文件夹观测记录超过存储上限，已有记录已保留。'), detail: { code } })
    }));
  }
  async function stageWritebackRecovery(operations, target, requireReviewing) {
    const owner = recoveryOwner(target), generation = spaRouteGeneration, view = currentRunView;
    const assertCurrent = () => {
      const record = findRunRecord(target.recordId, target.sessionId);
      if (owner.projectId !== getCurrentProjectId() || owner.accountScopeId !== cachedAccountScopeId
        || generation !== spaRouteGeneration || view !== currentRunView || !view
        || view.recordId !== owner.runId || view.sessionId !== owner.sessionId
        || (target.runAccountScopeId && target.runAccountScopeId !== owner.accountScopeId)
        || !record || record.forkSnapshot || record.runProjectId !== owner.projectId) {
        throw new Error('The project, account or writeback run changed before dispatch.');
      }
      return record;
    };
    const record = assertCurrent();
    const creates = operations.filter(op => op.type === 'create' && typeof op.content === 'string');
    record.retryRequireReviewing = requireReviewing === true;
    if (!creates.length) return;
    const candidate = Modules.WritebackIntent.normalize({ ...owner, id: crypto.randomUUID(),
      operations: creates, baseFiles: [], requireReviewing });
    const safe = Modules.SessionState.pickWritebackRecovery({ ...record, retryWriteback: candidate }).retryWriteback;
    if (safe) record.retryWriteback = safe; else delete record.retryWriteback;
    await flushQueuedSaveState();
    assertCurrent();
  }

  async function settleWritebackRecovery(applied, project, verification, target, requireReviewing) {
    const record = findRunRecord(target.recordId, target.sessionId);
    if (!record) return;
    // retryRequireReviewing is in-memory only; a renormalized run copy loses it.
    const retryReviewing = typeof requireReviewing === 'boolean' ? requireReviewing
      : typeof record.retryRequireReviewing === 'boolean' ? record.retryRequireReviewing
        : record.executionSnapshot?.requireReviewing === true;
    const owner = recoveryOwner(target);
    const skippedPaths = new Set((applied.skipped || []).map(entry => entry.operation?.path));
    const creates = (record.retryWriteback?.operations || []).filter(op => skippedPaths.has(op.path));
    // Untouched edits (never opened / rejected) and deletes whose server check failed are safe to replay.
    const edits = (applied.skipped || []).filter(({ operation: op, result }) => result?.failure?.changedDocument === false && ((op?.type === 'edit'
      && (result.failure.stage === 'navigation' || result.failure.code === 'write_operation_failed')) || (op?.type === 'delete' && result.failure.code === 'source_zip_unavailable'))).map(entry => entry.operation);
    const base = { ...(record.retryWriteback || { ...owner, id: crypto.randomUUID() }), requireReviewing: retryReviewing,
      baseFiles: project?.files || [], requestId: applied.receiptUnconfirmed ? applied.requestId || '' : '' };
    // An oversized edit pre-image must not cost the create retries (the intent has a 300 KiB ceiling).
    const safeRetry = [[...creates, ...edits], creates].filter(ops => ops.length).map(ops => Modules.SessionState
      .pickWritebackRecovery({ ...record, retryWriteback: Modules.WritebackIntent.normalize({ ...base, operations: ops }) }).retryWriteback).find(Boolean);
    if (safeRetry) record.retryWriteback = safeRetry; else delete record.retryWriteback;
    delete record.retryRequireReviewing;
    const next = await writebackController.buildSaveCheck(applied, project, owner);
    const files = new Map((record.saveCheck?.files || []).map(file => [file.path, file]));
    for (const file of next?.files || []) {
      if (verification.state === 'verified_saved') files.delete(file.path);
      else files.set(file.path, file);
    }
    if (files.size) record.saveCheck = Modules.WritebackIntent.normalizeSaveCheck({ ...owner, files: [...files.values()] });
    else {
      delete record.saveCheck;
      if (verification.state === 'verified_saved') record.saveConfirmedAt = new Date().toISOString();
    }
    await flushQueuedSaveState();
  }

  async function retryRunWriteback(runId) {
    if (currentRunView || trackedChangeInFlight.size) return;
    const session = getActiveSession(state);
    const record = (session?.runs || []).find(run => run.id === runId);
    const intent = Modules.WritebackIntent.normalize(record?.retryWriteback);
    const check = Modules.WritebackIntent.normalizeSaveCheck(record?.saveCheck);
    const owner = intent || check;
    if (!record || record.forkSnapshot || !owner || owner.projectId !== getCurrentProjectId()
      || owner.accountScopeId !== cachedAccountScopeId || owner.sessionId !== session.id
      || owner.runId !== record.id || record.undoStatus === 'applied' || record.trackedChangeStatus === 'rejected') return;
    const originalStatus = record.status;
    const retryAutoRecompile = typeof record.executionSnapshot?.autoRecompile === 'boolean'
      ? record.executionSnapshot.autoRecompile : undefined;
    // State is renormalized during the awaits below (probes, session sync), which
    // replaces run objects; always write through the current copy.
    const live = () => findRunRecord(runId, session.id) || record;
    let finished = false;
    runCancellationRequested = false;
    runCancellationController = new AbortController();
    const generation = spaRouteGeneration;
    const requestId = record.nativeRequestId || `writeback:${owner.sessionId}:${runId}`;
    const ownerToken = crypto.randomUUID();
    const retryView = { recordId: runId, sessionId: session.id, runProjectId: owner.projectId,
      runAccountScopeId: owner.accountScopeId, executionSnapshot: record.executionSnapshot,
      startedAt: Date.now(), writebackRetry: true };
    currentRunView = retryView;
    setRunning(true);
    const assertOwner = () => {
      if (runCancellationRequested || currentRunView !== retryView) {
        throw Object.assign(new Error('Save checking was cancelled.'), { code: 'codex_cancelled' });
      }
      if (generation !== spaRouteGeneration || owner.projectId !== getCurrentProjectId() || owner.accountScopeId !== cachedAccountScopeId) {
        throw Object.assign(new Error('The project or account changed.'), { code: 'aborted_project_changed' });
      }
    };
    try {
      const bound = await activeTurnControl.bindBrowserRun({ requestId, projectKey: owner.projectId,
        clientRunId: runId, sessionId: session.id, ownerToken });
      assertOwner();
      if (!bound) throw new Error(tx('Could not start sync. Reload the page and try again.', '无法开始同步，请刷新页面后重试。'));
      // Publish running only after another page can observe this browser owner.
      live().status = 'running';
      live().retryingWriteback = true;
      renderRunHistory({ preserveScroll: true });
      const root = panel.querySelector(`[data-run-id="${cssEscape(runId)}"]`);
      Object.assign(retryView, { root, events: root?.querySelector('[data-run-events]'),
        report: root?.querySelector('[data-run-report]'), status: root?.querySelector('[data-run-status]'),
        runProcess: root?.querySelector('[data-run-process]'), processLabel: root?.querySelector('[data-run-process-summary]') });
      if (intent?.requestId) {
        const receipt = await callPageBridge('getWritebackReceipt', { requestId: intent.requestId, runProjectId: owner.projectId });
        if (receipt?.state === 'running') throw new Error(tx('The previous upload is still finishing. Try again shortly.', '上一轮上传仍在收尾，请稍后再试。'));
      }
      if (intent?.operations.length) {
        // Edits replay against the run's original base files, so the stale guard still refuses changed documents.
        const result = await applySyncChangesToOverleaf(intent.operations.map(op => op.type === 'edit'
          ? { type: 'write', path: op.path, patches: op.patches, content: op.replaceAll } : op.type === 'delete' ? { type: 'delete', path: op.path } : { ...op, type: 'create' }),
          // The submitted snapshot owns the write mode; older intents may carry a lost value.
          { id: owner.projectId, files: intent.baseFiles }, { mode: 'auto', requireReviewing: typeof record.executionSnapshot?.requireReviewing === 'boolean'
            ? record.executionSnapshot.requireReviewing : intent.requireReviewing,
            autoRecompile: retryAutoRecompile,
            retryCreates: true, assistantMessageKey: 'retry_sync', assistantMessage: tx('Retried the remaining file transfers for this task.', '已重试本轮未完成的文件同步。') });
        assertOwner();
        if (result.settlement?.facts) live().settlement = WritebackSettlement.mergeRetrySettlement(live().settlement, result.settlement.facts); // Keep files outside the retry.
        await finishRunView(result.hasSkippedOperations ? tx('Sync incomplete', '同步未完成') : tx('Synced', '已同步'),
          result.hasSkippedOperations ? 'failed' : 'completed');
        finished = true;
      } else if (check) {
        const result = await writebackController.confirmSaveCheck(check, { assertCurrent: assertOwner,
          readSnapshot: params => callPageBridge('getProjectSnapshot', { ...params, runProjectId: owner.projectId }) });
        assertOwner();
        const current = live();
        if (result.ok) {
          delete current.saveCheck;
          current.saveConfirmedAt = new Date().toISOString();
          if (current.settlement) current.settlement.evidence = { ...current.settlement.evidence, saved: 'verified' };
        }
        showPluginToast(result.ok ? tx('Saved content confirmed.', '已确认文件保存。')
          : tx('Saved content is still unconfirmed. No file was uploaded again.', '保存状态仍待确认，本次没有重复上传文件。'));
      }
      await flushQueuedSaveState();
    } catch (error) {
      showPluginToast(error.message || String(error));
    } finally {
      // Only finishRunView settles a new terminal status; every other exit
      // returns the card to the status it had before the retry.
      if (currentRunView !== retryView) {
        activeTurnControl.release(requestId, ownerToken);
        return;
      }
      for (const copy of new Set([record, live()])) {
        delete copy.retryingWriteback;
        if (!finished && copy.status === 'running') copy.status = originalStatus;
      }
      saveStateSoon();
      await flushQueuedSaveState().catch(() => {});
      activeTurnControl.release(requestId, ownerToken);
      if (currentRunView !== retryView) return;
      currentRunView = null;
      runCancellationRequested = false;
      runCancellationController = null;
      setRunning(false);
      saveStateSoon();
      renderRunHistory({ preserveScroll: true });
    }
  }

  function appendUndoReviewingPolicyEvent(runId, reviewingPolicy) {
    if (!reviewingPolicy || reviewingPolicy.policy !== 'no-trace-undo') {
      return;
    }
    if (reviewingPolicy.disabled && reviewingPolicy.leftEditing) {
      appendRunRecordEvent(runId, {
        title: tr('undoSwitchedEditing'),
        status: 'completed'
      });
      return;
    }
    if (reviewingPolicy.disabled && !reviewingPolicy.restored) {
      appendRunRecordEvent(runId, {
        title: tr('undoReviewingRestoreUnverified'),
        status: 'failed',
        detail: {
          [tr('detailNext')]: tr('undoReviewingRestoreNext')
        }
      });
    }
  }

  function buildNoTraceUndoRestoreOperations(run) {
    return buildNoTraceUndoRestore(run).operations;
  }

  function buildNoTraceUndoRestore(run) {
    return buildSnapshotRestoreUndo({
      undoOperations: Array.isArray(run?.undoOperations) ? run.undoOperations : [],
      undoBaseFiles: Array.isArray(run?.undoBaseFiles) ? run.undoBaseFiles : [],
      undoExpectedFiles: Array.isArray(run?.undoExpectedFiles) ? run.undoExpectedFiles : []
    });
  }

  function hasNoTraceSnapshotUndo(run) {
    return buildNoTraceUndoRestore(run).snapshotRestore;
  }

  function findUnsafeFullFileUndoOperation(operations = [], options = {}) {
    if (options.allowSnapshotRestore === true) {
      return null;
    }
    return (operations || []).find(operation => {
      if (!operation || operation.type !== 'edit') {
        return false;
      }
      if (Array.isArray(operation.patches) && operation.patches.length) {
        return false;
      }
      return typeof operation.replaceAll === 'string'
        && operation.replaceAll.length > MAX_SAFE_UNDO_REPLACEALL_CHARS;
    }) || null;
  }

  // Carries the writeback's authoritative, verified post-write content onto an
  // edit operation so later post-state derivations (e.g. tracked-undo
  // postFiles) use it directly instead of re-applying patches against a
  // possibly-divergent base. This keeps wide paragraph patches safe: their
  // whole-paragraph `expected` would otherwise silently fail to re-apply.
  function attachVerifiedContentToOperation(operation, result) {
    return WritebackSettlement.attachVerifiedContentToOperation(operation, result);
  }

  let trackedChangeCaptureController = null;
  function getTrackedChangeCaptureController() {
    return trackedChangeCaptureController ||= Modules.TrackedChangeCaptureController.create({
      getRuns: () => (state.sessions || []).flatMap(session => session.runs || []),
      getProjectId: () => window.location.pathname.match(/^\/project\/([^/]+)/)?.[1] || '',
      buildExpectedFilesAfterOperations, normalizeTrackedChanges: normalizeApplyTrackedChanges, callPageBridge,
      persist: () => flushQueuedSaveState({ preserveRunActionPayload: true }),
      refresh: run => refreshRunCardControls(run.id),
      notify: (run, kind, detail) => appendRunRecordEvent(run.id, {
        title: {
          pending: tx('Files written; confirming tracked changes.', '文件已写入，正在确认留痕记录。'),
          observed: tx('Tracked changes confirmed; Accept is available.', '留痕记录已确认，可以接受改动。'),
          needs_review: tx('Tracked changes could not be safely attributed. Review them in Overleaf; Undo is preserved.', '留痕归属尚未确认，请在 Overleaf 审阅；原有撤销能力已保留。')
        }[kind], status: 'info', detail
      }),
      onError: error => appendPlainLog(tx('Tracked-change confirmation unavailable: ', '留痕确认暂不可用：') + error.message)
    });
  }

  async function recordUndoFromApply(project, applyResult) {
    const directoryRecovery = Modules.DirectoryCleanupRecovery ? getDirectoryCleanupRecovery() : null;
    directoryRecovery?.capture(currentRunView, applyResult);
    const appliedEntries = getAppliedEntries(applyResult).filter(entry => entry.result?.idempotent !== true);
    if (!currentRunView?.recordId || !appliedEntries.length) {
      return;
    }
    const appliedOperations = appliedEntries
      .map(item => attachVerifiedContentToOperation(item.operation, item.result))
      .filter(Boolean);
    const skippedEntries = getSkippedEntries(applyResult);
    const trackedChanges = normalizeApplyTrackedChanges(applyResult?.trackedChanges || []);
    const record = findRunRecord(currentRunView.recordId, currentRunView.sessionId);
    if (!record) {
      return;
    }

    let combinedAppliedOperations = [
      ...(Array.isArray(record.appliedOperations) ? record.appliedOperations : []),
      ...appliedOperations
    ];
    const checkpoint = buildUndoCheckpoint(project, combinedAppliedOperations);
    combinedAppliedOperations = checkpoint.appliedOperations;
    record.appliedOperations = combinedAppliedOperations;
    if (checkpoint.undoUnavailable.length) {
      appendRunEvent({ title: tr('failureReason_snapshot_undo_unavailable_user'), status: 'warning',
        detail: checkpoint.undoUnavailable.map(item => ({ [tr('detailFile')]: item.path,
          [tr('detailReason')]: item.code, [tr('detailNext')]: tr('failureReason_snapshot_undo_unavailable_next') })) });
    }
    const createdCheckpoint = buildCreatedFileUndoCheckpoint(project, combinedAppliedOperations, record);

    if ((currentRunView?.executionSnapshot?.requireReviewing ?? state.requireReviewing) === true) {
      const combinedTrackedChanges = normalizeApplyTrackedChanges([
        ...(Array.isArray(record.undoTrackedChanges) ? record.undoTrackedChanges : []),
        ...trackedChanges
      ]);
      record.undoOperations = createdCheckpoint.undoOperations;
      record.undoBaseFiles = createdCheckpoint.undoBaseFiles;
      record.undoTrackedChanges = combinedTrackedChanges;
      record.undoExpectedFiles = selectExpectedFilesForTrackedUndo(
        project,
        combinedAppliedOperations,
        combinedTrackedChanges,
        record.undoExpectedFiles
      );
      record.undoOperations = Modules.UndoOperations.getFileUndoOperations(record);
      record.undoStatus = '';
      record.partialWriteback = skippedEntries.length > 0;
      // Recording tracked-change refs enters the run into the tracked-change
      // lifecycle as `pending`. A run that records no refs stays a legacy-undo
      // run (native editor undo / no identifiable tracked changes).
      if (combinedTrackedChanges.length) {
        record.trackedChangeStatus = 'pending';
      }
      getTrackedChangeCaptureController().record(record, applyResult?.trackedChangeCaptures);
      refreshRunCardControls(record.id);
      if (combinedTrackedChanges.length) {
        appendRunEvent({
          title: tr('undoCheckpointTracked', { count: combinedTrackedChanges.length }),
          status: 'completed',
          detail: combinedTrackedChanges.map(change => ({
            [tr('detailFile')]: change.path,
            [tr('detailRecord')]: change.label || change.id || change.key
          }))
        });
      } else if (hasTrackedEditorUndo(record)) {
        appendRunEvent({
          title: tr('undoCheckpointNative', { files: formatTrackedUndoFiles(record) }),
          status: 'completed',
          detail: {
            [tr('detailMethod')]: tr('undoCheckpointNativeMethod')
          }
        });
      } else if (record.undoOperations.length) {
        appendRunEvent({
          title: tr('undoCheckpointPlain', { count: record.undoOperations.length }),
          status: 'completed'
        });
      } else {
        appendRunEvent({
          title: tr('undoCheckpointMissing'),
          status: 'failed',
          detail: {
            [tr('detailReason')]: tr('undoCheckpointMissingReason'),
            [tr('detailNext')]: tr('undoCheckpointMissingNext')
          }
        });
      }
      return;
    }

    const createdPaths = new Set(createdCheckpoint.undoOperations.map(operation => operation.path));
    checkpoint.undoOperations = [
      ...checkpoint.undoOperations.filter(operation => !createdPaths.has(operation.path)),
      ...createdCheckpoint.undoOperations
    ];
    checkpoint.undoBaseFiles = [
      ...checkpoint.undoBaseFiles.filter(file => !createdPaths.has(file.path)),
      ...createdCheckpoint.undoBaseFiles
    ];
    if (!checkpoint.undoOperations.length && !checkpoint.undoUnavailable.length) return;
    record.undoOperations = checkpoint.undoOperations;
    record.undoBaseFiles = checkpoint.undoBaseFiles;
    record.undoTrackedChanges = [];
    record.undoExpectedFiles = selectExpectedFilesForTrackedUndo(
      project,
      combinedAppliedOperations,
      [],
      record.undoExpectedFiles
    );
    record.undoStatus = '';
    record.partialWriteback = skippedEntries.length > 0;
    refreshRunCardControls(record.id);
    if (!checkpoint.undoOperations.length) return;
    appendRunEvent({
      title: tr('undoCheckpointPlain', { count: record.undoOperations.length }),
      status: 'completed',
      detail: checkpoint.undoOperations.map(operation => ({
        [tr('detailAction')]: formatOperationType(operation.type),
        [tr('detailFile')]: operation.path,
        [tr('detailTarget')]: operation.to,
        [tr('detailReason')]: operation.reason
      }))
    });
  }

  function normalizeApplyTrackedChanges(changes = []) {
    return WritebackSettlement.normalizeApplyTrackedChanges(changes);
  }

  function selectExpectedFilesForTrackedUndo(project, operations = [], trackedChanges = [], previousExpectedFiles = []) {
    return WritebackSettlement.selectExpectedFilesForTrackedUndo(project, operations, trackedChanges, previousExpectedFiles);
  }

  function buildTrackedUndoPostFiles(run) {
    return getTrackedChangeCaptureController().buildPostFiles(run);
  }

  function hasTrackedEditorUndo(run) {
    return buildTrackedUndoPostFiles(run).length > 0;
  }

  function formatTrackedUndoFiles(run) {
    const files = buildTrackedUndoPostFiles(run).map(file => file.path).filter(Boolean);
    return files.join(', ') || formatTrackedChangeFiles(run?.undoTrackedChanges || []);
  }

  function formatTrackedChangeFiles(changes = []) {
    const files = [];
    const seen = new Set();
    for (const change of changes || []) {
      const path = change?.path || tr('unknownFile');
      if (!seen.has(path)) {
        seen.add(path);
        files.push(path);
      }
    }
    return files.join(', ') || tx('this run\'s tracked changes', '本轮留痕改动');
  }

  function appendRunRecordEvent(runId, event) {
    const record = findRunRecord(runId);
    if (!record) {
      return;
    }
    const normalized = {
      title: event.title || 'Event',
      status: event.status || 'info',
      detail: event.detail,
      timestamp: event.timestamp || new Date().toISOString(),
      kind: event.kind || 'activity',
      technicalDetail: event.technicalDetail,
      activity: Modules.RunActivityModel.capture(event, sanitizeAssistantVisibleText),
      guidanceId: sanitizeAssistantVisibleText(event.guidanceId)
    };
    if (event.failure) normalized.failure = sanitizeAssistantVisibleValue(event.failure);
    if (event.detailStructured) normalized.detailStructured = sanitizeAssistantVisibleValue(event.detailStructured);
    record.events = [...(record.events || []), normalized].slice(-MAX_RUN_EVENTS);
    saveStateSoon();

    const root = panel?.querySelector(`[data-run-id="${cssEscape(runId)}"]`);
    const view = {
      events: root?.querySelector('[data-run-events]'),
      report: root?.querySelector('[data-run-report]')
    };
    if (view.events) {
      appendRunEventToView(view, normalized);
      scrollLogToBottom();
    }
  }

  function setRunUndoStatus(runId, undoStatus) {
    const run = findRunRecord(runId);
    if (!run) {
      return;
    }
    run.undoStatus = undoStatus;
    saveStateSoon();
    refreshRunCardControls(runId);
  }

  async function applyLegacyUndoSettlement(runId, undoStatus, result) {
    return getRunReviewController().applyLegacyUndoSettlement(runId, undoStatus, result);
  }

  function refreshRunCardControls(runId) {
    const run = findRunRecord(runId), root = panel?.querySelector(`[data-run-id="${cssEscape(runId)}"]`);
    if (!run || !root) {
      return;
    }
    if (runTimelineView.refreshResolvedUndo?.(runId)) return;
    configureAcceptButton(root, run);
    configureUndoButton(root, run);
    const reportEvent = (run.events || []).filter(event => event.kind === 'report').pop();
    const report = root.querySelector('[data-run-report]');
    if (reportEvent && report) {
      report.replaceChildren(renderCompletionReport(reportEvent, run));
      report.hidden = false;
    }
  }

  function findRunRecord(runId, sessionId = '') {
    if (!runId) {
      return null;
    }
    if (sessionId) {
      const session = findSessionById(sessionId);
      return (session?.runs || []).find(run => run.id === runId) || null;
    }
    return (state.runs || []).find(run => run.id === runId)
      || (state.sessions || []).flatMap(session => session.runs || []).find(run => run.id === runId)
      || null;
  }


  function createRunId() {
    return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function truncateRunTitle(text) {
    const value = String(text || 'Untitled run');
    return value.length > 58 ? `${value.slice(0, 58)}...` : value;
  }

  function truncateInline(text, maxLength = 80) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
  }

  function removeEmptyRunsMessage(log) {
    const empty = log?.querySelector('.empty-runs');
    if (empty) {
      empty.remove();
    }
  }

  function cssEscape(value) {
    if (window.CSS?.escape) {
      return window.CSS.escape(value);
    }
    return String(value).replace(/"/g, '\\"');
  }

  function appendSummary(summary) {
    if (!summary) {
      appendRunEvent({
        title: tx('No files were changed in this run.', '本轮未修改文件。'),
        status: 'completed'
      });
      return;
    }

    const total = Object.values(summary.counts || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
    if (!total) {
      appendRunEvent({
        title: tx('No files were changed in this run.', '本轮未修改文件。'),
        status: 'completed',
        detail: {
          [tx('Note', '说明')]: tx('Codex did not propose changes that need to be written to Overleaf.', 'Codex 没有提出需要写入 Overleaf 的修改。')
        }
      });
      return;
    }

    appendRunEvent({
      title: tx(`Preparing to modify ${summary.affectedFiles?.length || 0} file(s).`, `准备修改 ${summary.affectedFiles?.length || 0} 个文件。`),
      status: 'completed',
      detail: {
        [tx('Affected files', '会影响的文件')]: summary.affectedFiles?.length ? summary.affectedFiles : tr('noneValue'),
        [tr('operationEdit')]: summary.counts?.edit || 0,
        [tr('operationCreate')]: summary.counts?.create || 0,
        [tr('operationRename')]: summary.counts?.rename || 0,
        [tr('operationMove')]: summary.counts?.move || 0,
        [tr('operationDelete')]: summary.counts?.delete || 0,
        [tx('Deletes requiring separate confirmation', '需要单独确认的删除')]: summary.deletePlan?.length ? summary.deletePlan : tr('noneValue')
      }
    });
  }

  function appendPlannedChangeSummary(summary, title) {
    if (!summary) {
      appendRunEvent({
        title: tx(`${title}: no files need changes`, `${title}：没有文件需要修改`),
        status: 'completed'
      });
      return;
    }
    const files = summary.affectedFiles || [];
    appendRunEvent({
      title: files.length
        ? tx(`${title}: ${files.join(', ')}`, `${title}：${files.join(', ')}`)
        : tx(`${title}: no files need changes`, `${title}：没有文件需要修改`),
      status: 'completed',
      detail: {
        [tr('operationEdit')]: summary.counts?.edit || 0,
        [tr('operationCreate')]: summary.counts?.create || 0,
        [tr('operationDelete')]: summary.counts?.delete || 0
      }
    });
  }

  function appendChangeSummary(input) {
    const line = buildChangeSummaryLine(input);
    appendRunEvent({
      title: line,
      status: 'completed',
      detail: {
        status: input.status,
        notes: input.notes || '',
        deletePlanRejected: Boolean(input.deletePlanRejected)
      }
    });
    return line;
  }


  // v1.8.0 C1: a change-history row jumps to the run it describes —
  // switch to its session if needed, then scroll + flash the run card.
  async function jumpToHistoryRun(record = {}) {
    if (!cachedAccountScopeId || record.accountScopeId !== cachedAccountScopeId
      || record.projectId !== getCurrentProjectId()) {
      showPluginToast(tx('The project or account changed. Reopen file history and try again.', '项目或账号已变化，请重新打开文件修改记录。'));
      return;
    }
    closeCustomInstructionsSettings();
    if (record.sessionId && record.sessionId !== state.activeSessionId) {
      const target = (state.sessions || []).find(session => session.id === record.sessionId);
      if (!target) {
        showPluginToast(tx('That session is no longer stored (history keeps the last 20).', '该会话已不在存储中（历史仅保留最近 20 个会话）。'));
        return;
      }
      await switchSession(record.sessionId);
      if (state.activeSessionId !== record.sessionId) {
        return;
      }
    }
    const card = panel?.querySelector(`[data-run-id="${cssEscape(record.turnId || '')}"]`);
    if (!card) {
      showPluginToast(tx('That run is no longer in the timeline (runs keep the last 20).', '该轮已不在时间线中（仅保留最近 20 轮）。'));
      return;
    }
    card.scrollIntoView({ block: 'start' });
    card.classList.add('run-card--flash');
    setTimeout(() => card.classList.remove('run-card--flash'), 1600);
  }

  function appendCompletionReport(input = {}) {
    const operations = input.operations || [];
    const applyResults = input.applyResults || [];
    const record = currentRunView?.recordId ? findRunRecord(currentRunView.recordId, currentRunView.sessionId) : null;
    const settlementProjection = WritebackSettlement.projectRunSettlement(record || {});
    const undoCount = settlementProjection.canUndo ? getRunUndoCount(record) : 0;
    const report = buildHumanCompletionReport({
      ...input,
      locale: getLocale(),
      operations,
      applyResults,
      undoCount,
      settlementProjection,
      failure: input.failure || settlementProjection.primaryFailure || undefined,
      includeWriteResult: true
    });

    appendRunEvent({
      kind: 'report',
      title: report.title,
      status: report.status,
      detail: report.text,
      // Structured shape — conclusion vs system-meta fields — so the renderer
      // can demote the meta block visually (separator + muted color). The
      // legacy `detail` text stays attached for storage / transcripts / the
      // fallback render path used when reloading older persisted events.
      detailStructured: report.structured || null,
      // The structured failure must ride on the report event itself —
      // appendRecoveryActionForFailure reads event.failure.code to decide
      // which recovery button to render. (Fixed in v1.7.5: callers passed
      // input.failure since v1.6.2 but it was never forwarded, so recovery
      // buttons on completion reports could never appear.)
      failure: input.failure || settlementProjection.primaryFailure || undefined,
      compileErrors: input.compileErrors || undefined,
      rejectedHunks: input.rejectedHunks || currentRunView?.rejectedHunks || undefined
    });
  }

  function formatCompletionWork(operations, input) {
    if (input.deletePlanRejected) {
      return tx('Non-delete changes were kept; delete items were cancelled.', '已保留非删除修改，删除项已取消。');
    }
    if (!operations?.length) {
      return tx('No files were changed in this run.', '本轮未修改文件。');
    }
    return groupOperationsByFile(operations)
      .map(group => `${group.path}: ${group.operations.map(operation => formatOperationType(operation.type)).join(listSeparator())}`)
      .join(getLocale() === 'zh' ? '；' : '; ');
  }

  function formatCompletionNextStep(input, skippedCount) {
    if (skippedCount) {
      const primaryNext = derivePrimaryFailureNextStep(input);
      if (primaryNext) return primaryNext;
      return tx('Expand the write result, review the skipped reasons, then retry after fixing them.', '请展开写入结果查看跳过原因，处理后可以重试。');
    }
    if (input.status === 'cancelled' || input.status === 'rejected') {
      return tx('Adjust the task description and run again.', '可以调整任务描述后重新运行。');
    }
    if (input.status === 'blocked' || input.status === 'failed') {
      return tx('Fix the reason above, then retry.', '请处理上面的原因后重试。');
    }
    return tx('Continue the conversation or run the next task.', '可以继续追问，或运行下一项任务。');
  }

  /**
   * Walk the input apply results, collect FailureReason records, and return
   * the localized nextAction of the primary (severity + tie-breaker) failure.
   * Returns '' when no usable structured failure is available — the caller
   * then falls back to the generic next-step copy.
   */
  function derivePrimaryFailureNextStep(input) {
    if (!FailureReasons || !FailureReasons.selectPrimaryFailure || !FailureReasons.normalizeFailureReason) return '';
    const applyResults = Array.isArray(input?.applyResults) ? input.applyResults : [];
    const failures = [];
    for (const result of applyResults) {
      for (const item of getSkippedEntries(result)) {
        const failure = FailureReasons.normalizeFailureReason(item?.result, item?.operation || {}, { locale: getLocale() });
        if (failure && failure.code) failures.push(failure);
      }
    }
    const primary = FailureReasons.selectPrimaryFailure(failures);
    if (!primary) return '';
    const localized = FailureReasons.localizeFailureReason
      ? FailureReasons.localizeFailureReason(primary, getLocale(), failureReasonI18nLookup)
      : { nextAction: primary.nextAction };
    return localized.nextAction || primary.nextAction || '';
  }

  function collectAffectedFiles(operations = [], summary, applyResults = []) {
    const files = [];
    const seen = new Set();
    const add = path => {
      if (!path || seen.has(path)) {
        return;
      }
      seen.add(path);
      files.push(path);
    };
    for (const path of summary?.affectedFiles || []) {
      add(path);
    }
    for (const operation of operations || []) {
      add(operation?.path || operation?.from || operation?.to);
    }
    for (const result of applyResults || []) {
      for (const item of [...getAppliedEntries(result), ...getSkippedEntries(result)]) {
        add(item?.operation?.path || item?.operation?.from || item?.operation?.to);
      }
    }
    return files;
  }

  function appendOperationsPreview(operations, title) {
    if (!operations?.length) {
      appendRunEvent({
        title: tx(`${title}: no files changed in this run`, `${title}：本轮未修改文件`),
        status: 'completed'
      });
      return;
    }

    const groups = groupOperationsByFile(operations);
    appendRunEvent({
      title: tx(`${title}: ${groups.length} file(s)`, `${title}：${groups.length} 个文件`),
      status: 'completed',
      detail: groups.map(group => ({
        [tr('detailFile')]: group.path,
        [tx('Changes', '修改')]: group.operations.map(formatFileChangePreview)
      }))
    });
  }

  function groupOperationsByFile(operations = []) {
    const groups = [];
    const byPath = new Map();
    for (const operation of operations || []) {
      const path = operation?.path || operation?.from || operation?.to || tr('unknownFile');
      if (!byPath.has(path)) {
        byPath.set(path, { path, operations: [] });
        groups.push(byPath.get(path));
      }
      byPath.get(path).operations.push(operation);
    }
    return groups;
  }

  function formatFileChangePreview(operation) {
    const parts = [formatOperationType(operation?.type)];
    const reason = formatOperationReason(operation);
    if (reason) {
      parts.push(tx(`reason: ${reason}`, `原因：${reason}`));
    }
    if (operation?.type === 'edit') {
      if (Array.isArray(operation.patches) && operation.patches.length) {
        parts.push(tx(`local edit in ${operation.patches.length} place(s)`, `局部修改 ${operation.patches.length} 处`));
      } else if (operation.find || operation.replace) {
        parts.push(tx(
          `replace "${truncateInline(operation.find || '')}" with "${truncateInline(operation.replace || '')}"`,
          `把「${truncateInline(operation.find || '')}」改为「${truncateInline(operation.replace || '')}」`
        ));
      } else if (operation.replaceAll) {
        parts.push(tx(`full-text replacement, ${String(operation.replaceAll).length} chars`, `全文替换为 ${String(operation.replaceAll).length} 字符`));
      }
    }
    if (operation?.to) {
      parts.push(tx(`target: ${operation.to}`, `目标：${operation.to}`));
    }
    return parts.join(getLocale() === 'zh' ? '；' : '; ');
  }

  function formatOperationReason(operation) {
    const key = operation?.reasonKey || '';
    const count = Number(operation?.reasonParams?.count || 0);
    if (key === 'localWorkspaceDelete') {
      return tx('Local Codex workspace deleted this file.', '本地 Codex workspace 删除了这个文件。');
    }
    if (key === 'localWorkspacePatch') {
      return tx(
        `Synced ${count || 0} local Codex workspace edit${Number(count) === 1 ? '' : 's'}.`,
        `同步本地 Codex workspace 中的局部文件改动（${count || 0} 处）。`
      );
    }
    if (key === 'localWorkspaceContent') {
      return tx('Synced file content from the local Codex workspace.', '同步本地 Codex workspace 中的文件内容。');
    }
    if (key === 'localWorkspaceCreate') {
      return tx('Synced a new file from the local Codex workspace.', '同步本地 Codex workspace 中的新文件。');
    }
    return localizeVisibleReason(operation?.reason || '');
  }

  function appendPartialWritebackWarning(result) {
    const applied = getAppliedEntries(result);
    const skipped = getSkippedEntries(result);
    if (!applied.length && !skipped.length) {
      return;
    }
    const record = currentRunView?.recordId ? findRunRecord(currentRunView.recordId, currentRunView.sessionId) : null;
    const undoAvailable = getRunUndoCount(record) > 0;
    appendRunEvent({
      title: applied.length
        ? tx(
          `Partial writeback completed: ${applied.length} item(s) were written to Overleaf, ${skipped.length} item(s) were not written.`,
          `部分写入已完成：${applied.length} 项已经进入 Overleaf，${skipped.length} 项没有写入。`
        )
        : tx(
          `Writeback skipped: ${skipped.length} item(s) were not written to Overleaf.`,
          `写入被跳过：${skipped.length} 项没有写入 Overleaf。`
        ),
      status: 'failed',
      detail: {
        [tx('Recovery', '恢复操作')]: undoAvailable
          ? tx('Use this run\'s "Undo written parts" button to roll back the changes already written to Overleaf.', '点击本轮的“撤销已写入部分”按钮，可以先回退已经进入 Overleaf 的改动。')
          : tx('No automatic undo is available for this run. Review the file list below manually.', '本轮没有可自动撤销的写入；请按下面的文件列表手动检查。')
        ,
        [tx('Written; can be rolled back with Undo written parts', '已经写入，可点“撤销已写入部分”回退')]: applied.map(item => ({
          [tr('detailAction')]: formatOperationType(item.operation?.type),
          [tr('detailFile')]: item.operation?.path || item.operation?.to || tr('unknownFile')
        })),
        [tx('Not written; fix and retry', '没有写入，需要处理后重试')]: skipped.map(item => ({
          [tr('detailAction')]: formatOperationType(item.operation?.type),
          [tr('detailFile')]: item.operation?.path || item.operation?.to || tr('unknownFile'),
          [tr('detailReason')]: formatApplyResultReason(item)
        }))
      }
    });
  }

  function formatWritebackSkippedNextStep(result = {}) {
    const appliedCount = getAppliedEntries(result).length;
    if (appliedCount > 0) {
      return tx('Review the skipped reasons. You can use "Undo written parts" to roll back what already reached Overleaf, then fix conflicts and retry.', '请查看跳过原因。已写入的部分可以点击“撤销已写入部分”回退，处理冲突后再重试。');
    }
    return tx('Nothing was written in this run. Review the skipped reasons, fix them, and retry.', '这轮没有任何内容写入。请查看跳过原因，处理后重试。');
  }


  function appendLog(text) {
    if (currentRunView) {
      appendRunEvent({ title: text, status: 'info' });
      return;
    }
    appendPlainLog(text);
  }

  function appendPlainLog(text) {
    showPluginToast(text, { status: 'info' });
  }

  function showPluginToast(text, options = {}) {
    const region = panel?.querySelector('[data-toast-region]');
    if (!region) {
      return;
    }
    const value = String(text || '').trim();
    if (!value) {
      return;
    }

    const groupKey = String(options.groupKey || '');
    const grouped = groupKey && Array.from(region.children).find(item => item.dataset.groupKey === groupKey);
    if (grouped) {
      updateToastGroup(grouped);
      return;
    }
    const last = region.lastElementChild;
    if (!groupKey && !last?.dataset.groupKey && last?.classList?.contains('codex-toast') && last.dataset.baseText === value) {
      const repeatCount = Number(last.dataset.repeatCount || '1') + 1;
      last.dataset.repeatCount = String(repeatCount);
      const textNode = last.querySelector('[data-toast-text]');
      if (textNode) {
        textNode.textContent = `${value}${tr('repeatCountSuffix', { count: repeatCount })}`;
      }
      return;
    }

    const item = document.createElement('div');
    item.className = 'codex-toast';
    item.dataset.baseText = value;
    item.dataset.repeatCount = '1';
    item.dataset.status = options.status || 'info';

    const body = document.createElement('div');
    body.className = 'codex-toast-body';
    if (options.title) {
      const title = document.createElement('div');
      title.className = 'codex-toast-title';
      title.textContent = options.title;
      body.append(title);
    }
    const textNode = document.createElement('div');
    textNode.dataset.toastText = 'true';
    textNode.textContent = value;
    body.append(textNode);
    if (groupKey) {
      item.dataset.groupKey = groupKey;
      const details = document.createElement('details');
      details.className = 'codex-toast-group';
      const summary = document.createElement('summary');
      const list = document.createElement('ul');
      list.dataset.toastGroupItems = 'true';
      details.append(summary, list);
      body.append(details);
    }
    item.append(body);
    if (groupKey) updateToastGroup(item);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'codex-toast-close';
    close.setAttribute('aria-label', tr('dismissNotification'));
    close.innerHTML = Modules.PanelIcons.svg('close', 'codex-close-glyph');
    close.addEventListener('click', () => item.remove());
    item.append(close);

    region.append(item);
    while (region.children.length > 3) {
      region.firstElementChild?.remove();
    }

    if (!options.sticky) {
      setTimeout(() => {
        item.remove();
      }, 5200);
    }

    function updateToastGroup(toast) {
      const list = toast.querySelector('[data-toast-group-items]');
      const value = String(options.groupItem || '').trim();
      if (value && !Array.from(list.children).some(item => item.textContent === value)) {
        const item = document.createElement('li');
        const code = document.createElement('code');
        code.textContent = value;
        item.append(code);
        list.append(item);
      }
      toast.querySelector('.codex-toast-group summary').textContent =
        options.groupSummary?.(list.children.length) || String(list.children.length);
    }
  }

  function updateProbeNotice(text) {
    const log = panel?.querySelector('[data-log]');
    if (!log) {
      return;
    }

    const existing = log.querySelector('[data-probe-notice]');
    if (!text) {
      existing?.remove();
      return;
    }

    const item = existing || document.createElement('div');
    item.className = 'log-line';
    item.dataset.probeNotice = 'true';
    item.textContent = text;
    if (!existing) {
      log.append(item);
    }
    scrollLogToBottom();
  }

  function formatEventDetail(detail) {
    const safeDetail = sanitizeAssistantVisibleValue(detail);
    if (typeof safeDetail === 'string') {
      return safeDetail;
    }
    if (Array.isArray(safeDetail)) {
      return safeDetail.map(item => typeof item === 'string' ? item : JSON.stringify(item, null, 2)).join('\n');
    }
    if (typeof safeDetail === 'object') {
      return Object.entries(safeDetail)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}: ${formatDetailValue(value)}`)
        .join('\n') || JSON.stringify(safeDetail, null, 2);
    }
    return String(safeDetail);
  }

  function formatDetailValue(value) {
    if (Array.isArray(value)) {
      if (!value.length) {
        return 'none';
      }
      return value.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join(', ');
    }
    if (typeof value === 'object' && value !== null) {
      return JSON.stringify(value, null, 2);
    }
    return String(value);
  }

  function formatEventTime(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatSessionTime(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) {
      return tx('just now', '刚刚');
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return tx(`${minutes} min`, `${minutes} 分钟`);
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return tx(`${hours}h`, `${hours} 小时`);
    }
    return tx(`${Math.floor(hours / 24)}d`, `${Math.floor(hours / 24)} 天`);
  }

  function formatElapsed(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) {
      return `${seconds}s`;
    }
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }

  function humanizeEventType(type) {
    return String(type || 'event')
      .split(/[._-]+/)
      .filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  function formatSummary(title, summary) {
    const counts = summary?.counts || {};
    const files = summary?.affectedFiles || [];
    return [
      title,
      '',
      `Edit: ${counts.edit || 0}`,
      `Create: ${counts.create || 0}`,
      `Rename: ${counts.rename || 0}`,
      `Move: ${counts.move || 0}`,
      `Delete: ${counts.delete || 0}`,
      '',
      files.length ? `Affected files:\n${files.join('\n')}` : 'Affected files: none'
    ].join('\n');
  }

  function formatDeletePlan(deletePlan) {
    if (!deletePlan.length) {
      return 'No files are proposed for deletion.';
    }

    return [
      `Codex proposes deleting ${deletePlan.length} item(s):`,
      '',
      ...deletePlan.map(item => `${item.path}\nReason: ${item.reason || 'No reason provided'}`),
      '',
      'Approve all deletions?'
    ].join('\n');
  }

  }

  root.CodexOverleafContentRuntime = { init };
})(typeof window !== 'undefined' ? window : globalThis);
