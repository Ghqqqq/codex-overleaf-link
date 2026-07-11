(function initCodexOverleafContentRuntime(root) {
  'use strict';

  function init() {
  'use strict';

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
  const SNAPSHOT_PAGE_BRIDGE_TIMEOUT_MS = 70000;
  const COMPILE_PAGE_BRIDGE_TIMEOUT_MS = 75000;
  const CONTEXT_FILE_LIST_PAGE_BRIDGE_TIMEOUT_MS = 35000;
  const STREAM_RENDER_FLUSH_MS = 80;
  const STREAM_SAVE_DELAY_MS = 1000;
  const MAX_RUN_EVENTS = 300;
  const MAX_SAFE_UNDO_REPLACEALL_CHARS = 2000;
  const ONBOARDING_TIP_STORAGE_KEY = 'codexOverleafOnboardingTipShown';
  const NATIVE_COMPATIBILITY_GATED_METHODS = new Set([
    'mirror.status',
    'codex.models',
    'codex.run',
    'task.run',
    'task.confirm',
    'mirror.sync',
    'mirror.patchFiles',
    'mirror.confirmWriteback',
    'mirror.scanSensitive',
    'codex.history.clearPlugin',
    'skills.list',
    'skills.install',
    'skills.remove'
  ]);
  const CANCELLABLE_PAGE_BRIDGE_METHODS = new Set([
    'applyOperations',
    'acceptTrackedChanges',
    'rejectTrackedChanges'
  ]);
  const activePageBridgeCancellationHandlers = new Map();
  const PANEL_DEFAULT_WIDTH = 380;
  const PANEL_MIN_WIDTH = 340;
  const PANEL_MAX_WIDTH = 760;
  const PAGE_MIN_WIDTH = 520;
  const CodexOverleafCompatibility = window.CodexOverleafCompatibility;
  const INSTALL_COMMAND = CodexOverleafCompatibility?.buildInstallCommand?.(
    undefined,
    undefined,
    getCurrentExtensionId()
  ) || 'curl -fsSL https://raw.githubusercontent.com/Ghqqqq/codex-overleaf-link/main/install.sh | bash -s -- --extension-id <chrome-extension-id>';
  const PAGE_BRIDGE_SCRIPT_REVISION = '2026-05-21-editor-readiness-v10';
  const PAGE_BRIDGE_CAPABILITY = createPageBridgeCapability();
  const pageBridgeReady = injectPageBridge();
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
    updateActiveSession
  } = window.CodexOverleafSessionState;
  const LineReferences = window.CodexOverleafLineReferences;
  const { getProjectStorageKey } = window.CodexOverleafStorageKeys;
  const { HIGH_RISK_TYPES, buildChangeSummaryLine, hasSkippedApplyOperations } = window.CodexOverleafSummary;
  const {
    buildExpectedFilesAfterOperations,
    buildSnapshotRestoreUndo,
    buildUndoCheckpoint
  } = window.CodexOverleafUndoOperations;
  const { buildHumanCompletionReport, mapAgentEventToActivity, stripEmptyHtmlCommentPlaceholders,
    translateRawError } = window.CodexOverleafAgentTranscript;
  const i18n = window.CodexOverleafI18n;
  const nativeChannel = window.CodexOverleafNativeChannel.create({
    chrome,
    crypto
  });
  const writebackController = window.CodexOverleafWritebackController;
  const ReviewHunks = window.CodexOverleafReviewHunks;
  const DiffReviewPanel = window.CodexOverleafDiffReviewPanel;
  const ContextTray = window.CodexOverleafContextTray;
  const LocalSkillsPanel = window.CodexOverleafLocalSkillsPanel;
  const runController = window.CodexOverleafRunController;
  const mirrorHealth = window.CodexOverleafMirrorHealth;
  const otWarmMirrorController = window.CodexOverleafOtWarmMirrorController;
  const PanelRenderer = window.CodexOverleafPanelRenderer;
  const SessionPanel = window.CodexOverleafSessionPanel;
  const SettingsPanel = window.CodexOverleafSettingsPanel;
  const DiagnosticsPanel = window.CodexOverleafDiagnosticsPanel;
  const ComposerPanel = window.CodexOverleafComposerPanel;
  const GovernanceRules = window.CodexOverleafGovernanceRules;
  const SensitiveScan = window.CodexOverleafSensitiveScan;
  const AuditRecords = window.CodexOverleafAuditRecords;
  const FailureReasons = window.CodexOverleafFailureReasons;

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
  const TERMINAL_TRACKED_CHANGE_STATUS = new Set(['accepted', 'rejected']);

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
  const markdownText = window.CodexOverleafMarkdownText.create({
    tx,
    callPageBridge,
    getCurrentProjectReferenceFiles,
    showPluginToast
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

  const otWarmMirror = window.CodexOverleafOtWarmMirror.create({
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

  const diagnosticsController = window.CodexOverleafDiagnosticsController.create({
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
  const panelMaintenance = window.CodexOverleafPanelMaintenance.create({
    tx,
    showPluginToast: (...args) => showPluginToast(...args),
    showPluginConfirm: (...args) => showPluginConfirm(...args),
    callPageBridge: (...args) => callPageBridge(...args),
    getCurrentProjectId: () => getCurrentProjectId(),
    saveState: (...args) => saveState(...args),
    saveStateSoon: () => saveStateSoon(),
    autosizeTaskTextarea: () => autosizeTaskTextarea(),
    applyStateToPanel: () => applyStateToPanel(),
    normalizePanelState,
    openCustomInstructionsSettings: () => openCustomInstructionsSettings(),
    onHistoryRowJump: record => jumpToHistoryRun(record),
    resetProjectNameCache: () => recentProjects.resetProjectNameCache(),
    getPanel: () => panel,
    getState: () => state,
    setState: next => { state = next; },
    getCurrentRunView: () => currentRunView,
    getSettingsPanelInstance: () => settingsPanelInstance
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

  const runTimelineView = window.CodexOverleafRunTimelineView.create({
    tr,
    tx,
    getLocale,
    formatElapsed,
    findRunRecord,
    forceCancelStuckTaskForCurrentProject,
    formatEventDetail,
    formatEventTime,
    renderAttachmentPreviewList,
    formatModeLabel,
    undoRun,
    acceptRun,
    getRunUndoCount,
    cssEscape,
    renderMarkdownInlineText,
    renderMarkdownBlockText,
    sanitizeAssistantVisibleText,
    sanitizeAssistantVisibleValue,
    buildMarkdownInlineNodes,
    getPanel: () => panel,
    getState: () => state,
    getCurrentRunView: () => currentRunView,
    refillComposerForRetry,
    showNativeSetupGuidance: () => showNativeUpdateGuidanceModal({}),
    openProjectFileForFailure,
    openStorageSettings,
    trackedChangeInFlight
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
    configureUndoButton,
    configureAcceptButton
  } = runTimelineView;

  const sessionManager = window.CodexOverleafSessionManager.create({
    tr,
    showPluginConfirm,
    showPluginToast,
    sendBackgroundNative,
    saveState,
    saveStateSoon,
    readPanelInputs,
    applyStateToPanel,
    getPanel: () => panel,
    getState: () => state,
    setState: next => { state = next; },
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

  const applyResultFormatters = window.CodexOverleafApplyResultFormatters.create({
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

  // v1.6.3 structural-debt phase 6: the sync-writeback orchestration
  // (applySyncChangesToOverleaf + post-write verify/mirror/compile pipeline)
  // lives in writebackOrchestrator.js. Every dep below is either a hoisted
  // function declaration, an already-initialized const above, or a lazy
  // accessor thunk — safe in the top-of-init() wiring zone.
  const writebackOrchestrator = window.CodexOverleafWritebackOrchestrator.create({
    tr,
    tx,
    getLocale,
    appendRunEvent,
    appendChangeSummary,
    appendCompletionReport,
    appendOperationsPreview,
    appendPartialWritebackWarning,
    appendApplyResult,
    renderDiffReview,
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
    RUN_SNAPSHOT_ZIP_TIMEOUT_MS,
    getState: () => state,
    getCurrentRunView: () => currentRunView
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

  const modelPicker = window.CodexOverleafModelPicker.create({
    tr,
    tx,
    getLocale,
    sendBackgroundNative,
    readSelectedSpeedInput,
    getRenderedModelEntries,
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
    renderSpeedOptions,
    renderModelConfigChoices,
    resolveSelectedModel,
    normalizeModelOptionId,
    updateModelDisplay
  } = modelPicker;

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
      if (panel.querySelector('.recent-projects-sessions input')) {
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
    }
  });

  const recentProjects = window.CodexOverleafRecentProjects.create({
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
  const composerAttachmentController = window.CodexOverleafComposerAttachments.createComposerAttachmentController({
    getPanel: () => panel,
    tr,
    tx,
    appendPlainLog,
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
    getRunEvents: () => currentRunView?.events,
    appendRunEvent,
    scrollLogToBottom,
    onRejectedHunks: summaries => {
      if (currentRunView && Array.isArray(summaries) && summaries.length) {
        currentRunView.rejectedHunks = summaries;
      }
    }
  });
  const contextTrayController = ContextTray.createContextTrayController({
    root: window,
    document,
    getPanel: () => panel,
    getState: () => state,
    setState: nextState => {
      state = nextState;
    },
    saveState,
    saveStateSoon,
    updateActiveSession,
    callPageBridge,
    getCurrentProjectId,
    tr,
    tx,
    closeModelConfigPopover,
    closeDiagnosticsMenu,
    closeCustomInstructionsSettings,
    closeSlashMenu,
    projectFiles: window.CodexOverleafProjectFiles
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
    getSkillLoadingSettings,
    isCodexOverleafSkillEnabled,
    setCodexOverleafSkillEnabled,
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
  let panelRendererInstance = null;
  let sessionPanelInstance = null;
  let settingsPanelInstance = null;
  let diagnosticsPanelInstance = null;
  let composerPanelInstance = null;
  let state = null;
  let storageKey = LEGACY_STORAGE_KEY;
  let currentRunView = null;
  let saveStateTimer = null;
  // Two-phase saveState scheduling. `saveStateInFlight` flips to true while
  // an async saveState() is actually writing; `saveStateRunAfterFlight` is
  // set when a fresh saveStateSoon() fires during the in-flight phase. When
  // the in-flight save finishes, the trailing flag triggers ONE more save
  // so the final disk snapshot reflects the latest state. Without this,
  // a debounce timer cleared mid-write would let an older snapshot
  // (captured at the start of the in-flight save) be the last writer.
  let saveStateInFlight = false;
  let saveStateRunAfterFlight = false;
  let streamRenderTimer = null;
  let pendingStreamRenderEvents = new Map();
  let storageNoticeKeys = new Set();
  let composerSkillInvocation = null;
  let slashCodexOverleafSkills = [];
  let slashCodexOverleafSkillsLoaded = false;
  let slashCodexOverleafSkillsLoading = false;
  let renderedSlashCommands = new Map();
  let customInstructionsEditorProjectId = '';
  let customInstructionsEditorValue = '';
  let runCancellationRequested = false;
  let activePluginConfirmResolve = null;
  const updateIdleClient = root.CodexOverleafUpdateIdle?.create({
    document,
    getBusyState: () => ({
      run: Boolean(currentRunView),
      cancelling: runCancellationRequested,
      storage: saveStateInFlight || Boolean(saveStateTimer),
      reviewAction: trackedChangeInFlight.size > 0,
      dialog: Boolean(activePluginConfirmResolve)
    }),
    checkSaved: () => callPageBridge('waitForSaveState', { deadlineMs: 0, pollIntervalMs: 1 }),
    onApplyingChange: applying => { if (panel) panel.dataset.updating = applying ? 'true' : 'false'; },
    showToast: (...args) => showPluginToast(...args),
    getStateMessage: state => ({
      staged: tx('A verified update is ready and will install when Overleaf is idle.', '更新已验证，将在 Overleaf 空闲时自动安装。'),
      applying: tx('Updating Codex Overleaf Link now.', '正在更新 Codex Overleaf Link。'),
      committed: tx('Codex Overleaf Link was updated successfully.', 'Codex Overleaf Link 已成功更新。'),
      rolled_back: tx('The update failed its health check, so the previous version was restored.', '更新未通过健康检查，已自动恢复上一版本。')
    }[state] || '')
  });
  root[RUNTIME_INSTALLED_FLAG] = true;
  root[RUNTIME_STATE_KEY] = { ok: true, alreadyInstalled: false };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'codex-overleaf/runtime-health-probe') {
      sendResponse?.({
        ok: true,
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
    if (message?.type === 'codex-overleaf/toggle-panel') {
      if (isPanelOpen()) {
        closePanel();
      } else {
        ensurePanelOpen();
      }
      sendResponse?.(getPanelStateResponse());
      return;
    }
    if (nativeChannel.shouldHandleNativeEvent(message)) {
      appendNativeEvent(message.event);
    }
  });

  exposeSmokeHelper();
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

  async function init() {
    storageKey = getProjectStorageKey(LEGACY_STORAGE_KEY, window.location.href);
    state = normalizePanelState(await loadStoredState(), { restoreRunningRuns: true });
    ensurePanelOpen();
    root.CodexOverleafUpdateNotice?.mount?.(panel?.panelEl || panel, {
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
    loadModelOptions().catch(error => {
      applyFallbackModelOptions(resolveSelectedModel(), error);
    });
    syncOtWarmMirrorController().catch(error => {
      updateOtStatusDisplay('unavailable');
      appendPlainLog(tx(`Failed to sync experimental OT warm mirror: ${error.message}`, `同步实验性 OT 预热镜像失败：${error.message}`));
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
      extensionId: getCurrentExtensionId()
    };
  }

  function getCurrentExtensionId() {
    return typeof chrome === 'object' && chrome?.runtime?.id
      ? chrome.runtime.id
      : '';
  }

  function exposeSmokeHelper() {
    const helper = Object.freeze({
      probeNative: smokeProbeNative,
      probeProject: smokeProbeProject,
      getProjectSnapshotMetrics: smokeProbeProject
    });
    try {
      Object.defineProperty(globalThis, 'CodexOverleafSmoke', {
        configurable: true,
        enumerable: false,
        value: helper
      });
    } catch (_error) {
      globalThis.CodexOverleafSmoke = helper;
    }
  }

  async function smokeProbeNative() {
    try {
      const params = CodexOverleafCompatibility?.buildBridgePingParams
        ? CodexOverleafCompatibility.buildBridgePingParams(getExtensionCompatibilityMetadata())
        : {};
      const response = await sendBackgroundNative({ method: 'bridge.ping', params });
      const compatibility = CodexOverleafCompatibility?.evaluateNativeCompatibility
        ? CodexOverleafCompatibility.evaluateNativeCompatibility(response, getExtensionCompatibilityMetadata())
        : fallbackNativeCompatibility(response);
      return {
        supported: true,
        ok: response?.ok === true && isNativeCompatibilityCompatible(compatibility),
        status: compatibility?.status || (response?.ok ? 'ok' : 'native_missing'),
        classification: getNativeCompatibilityClassification(compatibility),
        errorCode: response?.error?.code || compatibility?.status || '',
        nativeCompatibility: summarizeSmokeNativeCompatibility(compatibility, response)
      };
    } catch (_error) {
      return {
        supported: true,
        ok: false,
        status: 'native_probe_failed',
        errorCode: 'native_probe_failed'
      };
    }
  }

  async function smokeProbeProject(options = {}) {
    try {
      const project = await callPageBridge('getProjectSnapshot', {
        force: Boolean(options.force),
        preferLightweight: true,
        allowZipFallback: true,
        allowEditorNavigation: false,
        requireFullProject: false,
        includeBinaryFiles: true,
        includeContent: false,
        zipTimeoutMs: RUN_SNAPSHOT_ZIP_TIMEOUT_MS
      });
      const files = Array.isArray(project?.files) ? project.files : [];
      const skipped = Array.isArray(project?.capabilities?.skipped) ? project.capabilities.skipped : [];
      const bytes = summarizeSmokeProjectBytes(files);
      const ok = project?.ok !== false && files.length > 0;
      return {
        supported: true,
        ok,
        status: ok ? 'ok' : 'project_snapshot_unavailable',
        errorCode: ok ? '' : project?.code || 'project_snapshot_unavailable',
        counts: {
          files: files.length,
          skipped: skipped.length
        },
        bytes,
        method: project?.capabilities?.method || ''
      };
    } catch (_error) {
      return {
        supported: true,
        ok: false,
        status: 'project_probe_failed',
        errorCode: 'project_probe_failed',
        counts: {
          files: 0,
          skipped: 0
        },
        bytes: {
          text: 0,
          binary: 0
        }
      };
    }
  }

  function summarizeSmokeNativeCompatibility(compatibility = {}, response = {}) {
    const native = compatibility?.native || response?.result || {};
    return {
      status: compatibility?.status || (response?.ok ? 'ok' : 'native_missing'),
      classification: getNativeCompatibilityClassification(compatibility),
      nativeVersion: compatibility?.nativeVersion || native.version || '',
      version: compatibility?.version || native.version || '',
      minimumNativeVersion: compatibility?.minimumNativeVersion || compatibility?.minNativeVersion || '',
      protocolVersion: compatibility?.protocolVersion || native.protocolVersion || '',
      supportedProtocol: compatibility?.supportedProtocol || native.supportedProtocol || ''
    };
  }

  function summarizeSmokeProjectBytes(files = []) {
    return files.reduce((bytes, file) => {
      let size = Number(file?.size || file?.byteLength || 0);
      if ((!Number.isFinite(size) || size <= 0) && typeof file?.content === 'string') {
        size = new TextEncoder().encode(file.content).byteLength;
      }
      if (!Number.isFinite(size) || size <= 0) {
        return bytes;
      }
      if (file?.kind === 'binary') {
        bytes.binary += size;
      } else {
        bytes.text += size;
      }
      return bytes;
    }, {
      text: 0,
      binary: 0
    });
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
        callbacks: {
          onRefresh: () => refreshProbe({ userInitiated: true }),
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
        callbacks: {
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
        callbacks: {
          onBack: () => closeCustomInstructionsSettings(),
          onInputChange: () => persistPanelInputs(),
          onSkillsOpen: () => openSkillsView(),
          onSkillsBack: () => closeSkillsView(),
          onClearAllHistory: () => clearAllHistoryWithConfirm(),
          onHistoryOpen: () => renderAuditHistoryPanel(),
          onHistoryFilter: () => applyAuditHistoryFilter(),
          // Experimental OT mirror: a single visible switch whose click is
          // intercepted so the confirm-before-enable flow still runs.
          onOtToggleClick: handleExperimentalOtToggleClick
        }
      });

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
        attachmentController: composerAttachmentController,
        callbacks: {
          onSubmit: () => safeRunTask(),
          isRunning: () => Boolean(currentRunView),
          onCancel: () => cancelActiveRun(),
          onPaste: handleComposerPaste,
          onDragOver: handleComposerDragOver,
          onDragLeave: handleComposerDragLeave,
          onDrop: handleComposerDrop,
          onTaskKeydown: handleTaskInputKeydown,
          onTaskInput: handleTaskInput,
          onSlashMenuClick: handleSlashMenuClick,
          onClearSkillInvocation: clearComposerSkillInvocation,
          onAddContext: toggleContextTray,
          onAttachClick: () => panel.querySelector('[data-attach-input]')?.click(),
          onAttachInput: handleAttachInputChange,
          onContextRefresh: () => loadContextFiles({ force: true }),
          onModelConfigToggle: () => toggleModelConfigPopover(),
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

      installContextDismiss();
      installModelConfigDismiss();
      bindLogAutoFollow();
      renderSessionList();
      renderRunHistory();
      renderContextSelection();
      scheduleMirrorPrefetch({ reason: 'cold-start', delayMs: 2500 });
      primeCodexOverleafSkillsCatalog().catch(() => { /* non-blocking */ });
    }

    PanelRenderer.setVisible(panel, true);
  }

  // One-shot catalog prime: the parallel-subagents broker gate reads
  // state.codexOverleafSkills at run time. The catalog persists once filled
  // (v1.6.1), but states saved by older builds have it stripped — without
  // this prime, the gate stays silently off until the user happens to open
  // the Skills page. Fire-and-forget on panel open; only fetches when the
  // catalog is empty.
  async function primeCodexOverleafSkillsCatalog() {
    if (Array.isArray(state?.codexOverleafSkills) && state.codexOverleafSkills.length) {
      return;
    }
    if (getSkillLoadingSettings().loadCodexOverleafSkills === false) {
      return;
    }
    const response = await sendBackgroundNative({
      method: 'skills.list',
      params: { scope: 'codex-overleaf' }
    });
    const skills = Array.isArray(response?.result?.skills) ? response.result.skills : [];
    if (!response?.ok || !skills.length) {
      return;
    }
    state = { ...state, codexOverleafSkills: skills };
    saveStateSoon();
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
      open: isPanelOpen()
    };
  }

  function toggleDiagnosticsMenu() {
    DiagnosticsPanel.toggleMenu(diagnosticsPanelInstance);
  }

  function closeDiagnosticsMenu() {
    DiagnosticsPanel.closeMenu(diagnosticsPanelInstance);
  }

  function normalizeCustomInstructionsByProject(value) {
    const result = {};
    const textMaxChars = 12000;
    const keyMaxChars = 160;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return result;
    }
    for (const rawKey of Object.keys(value)) {
      const key = typeof rawKey === 'string' ? rawKey.trim() : '';
      if (!key) {
        continue;
      }
      const normalizedKey = key.length <= keyMaxChars ? key : key.slice(0, keyMaxChars - 1) + '…';
      const rawText = typeof value[rawKey] === 'string' ? value[rawKey] : '';
      result[normalizedKey] = rawText.length <= textMaxChars
        ? rawText
        : rawText.slice(0, textMaxChars - 1) + '…';
    }
    return result;
  }

  function getCustomInstructionsForCurrentProject() {
    const projectId = getCurrentProjectId();
    const normalizedProject = normalizeCustomInstructionsByProject({ [projectId]: '' });
    const normalizedProjectId = Object.keys(normalizedProject)[0] || '';
    if (!normalizedProjectId) {
      return '';
    }
    return normalizeCustomInstructionsByProject(state?.customInstructionsByProject)[normalizedProjectId] || '';
  }

  function setCustomInstructionsForProject(projectId, value) {
    const normalizedProject = normalizeCustomInstructionsByProject({ [projectId]: value });
    const normalizedProjectId = Object.keys(normalizedProject)[0] || '';
    if (!normalizedProjectId) {
      return;
    }
    state = {
      ...state,
      customInstructionsByProject: {
        ...normalizeCustomInstructionsByProject(state?.customInstructionsByProject),
        [normalizedProjectId]: normalizedProject[normalizedProjectId]
      }
    };
  }


  function openCustomInstructionsSettings() {
    if (!settingsPanelInstance) {
      return;
    }
    closeDiagnosticsMenu();
    closeDiagnosticsResult();
    closeModelConfigPopover();
    closeContextTray();
    if (typeof closeSlashMenu === 'function') {
      closeSlashMenu();
    }
    clearProjectSettingsStatus();
    syncCustomInstructionsEditorForProject(getCurrentProjectId(), { force: true });
    syncProjectSettingsEditorForProject();
    panelRendererInstance?.setView?.('settings');
    SettingsPanel.show(settingsPanelInstance);
    refreshStorageUsageSummary();
    // A history card left expanded re-loads on every settings open; the
    // toggle listener only fires on the closed->open transition.
    if (settingsPanelInstance?.container?.querySelector('[data-history-card]')?.open) {
      renderAuditHistoryPanel();
    }
    if (typeof refreshLocalSkills === 'function') {
      refreshLocalSkills().catch(error => setProjectSettingsStatus(tx(`Could not list local skills: ${error.message}`, `无法列出本地技能：${error.message}`), 'failed'));
    }
  }

  function toggleCustomInstructionsSettings() {
    if (SettingsPanel.isVisible(settingsPanelInstance)) {
      closeCustomInstructionsSettings();
      return;
    }
    openCustomInstructionsSettings();
  }

  function closeCustomInstructionsSettings() {
    SettingsPanel.hide(settingsPanelInstance);
    // Back from settings must return to the variant that matches the current
    // route, not unconditionally to the per-project session view. On a
    // non-project URL (e.g. /project, /project/, account / billing) the
    // session view is meaningless and shows an empty per-project conversation
    // UI; the user expects to return to the Recent-projects variant they
    // came from. Mirror the SPA route hook's variant dispatch.
    if (isProjectEditorRoute(window.location)) {
      panelRendererInstance?.setView?.('session');
    } else {
      renderRecentProjectsVariant().catch(() => { /* swallow */ });
    }
  }

  // Skills sub-page: reached from the settings screen's Codex Overleaf skills
  // entry row. Its in-memory view-state is the panel root's data-view="skills".
  function openSkillsView() {
    if (!settingsPanelInstance) {
      return;
    }
    panelRendererInstance?.setView?.('skills');
    refreshLocalSkills().catch(error => setProjectSettingsStatus(tx(`Could not list local skills: ${error.message}`, `无法列出本地技能：${error.message}`), 'failed'));
  }

  function closeSkillsView() {
    // The skills screen's back button returns to the settings screen.
    panelRendererInstance?.setView?.('settings');
  }

  function updateSkillsEntrySummary() {
    if (!settingsPanelInstance) {
      return;
    }
    const summary = getSkillLoadingSettings().loadCodexOverleafSkills === false
      ? tr('codexOverleafSkillsSummaryOff')
      : tr('codexOverleafSkillsSummaryCount', { count: countEnabledCodexOverleafSkills() });
    SettingsPanel.setSkillsSummary(settingsPanelInstance, summary);
  }

  function countEnabledCodexOverleafSkills() {
    const skills = Array.isArray(state?.codexOverleafSkills) ? state.codexOverleafSkills : [];
    return skills.reduce((total, skill) => {
      const id = String(skill?.id || '').trim();
      return id && isCodexOverleafSkillEnabled(id) ? total + 1 : total;
    }, 0);
  }

  function syncCustomInstructionsEditorForProject(projectId = getCurrentProjectId(), options) {
    const syncOptions = options || {};
    const input = panel?.querySelector('[data-custom-instructions-input]');
    if (!input) {
      return;
    }
    const normalizedProject = normalizeCustomInstructionsByProject({ [projectId]: '' });
    const normalizedProjectId = Object.keys(normalizedProject)[0] || '';
    const storedValue = normalizedProjectId
      ? normalizeCustomInstructionsByProject(state?.customInstructionsByProject)[normalizedProjectId] || ''
      : '';
    input.placeholder = tr('customInstructionsPlaceholder');
    const editorIsOpen = panel?.dataset?.view === 'settings' || panel?.dataset?.view === 'skills';
    const editorIsDirty = normalizedProjectId
      && customInstructionsEditorProjectId === normalizedProjectId
      && input.value !== customInstructionsEditorValue;
    if (!syncOptions.force && editorIsOpen && editorIsDirty) {
      return;
    }
    input.value = storedValue;
    customInstructionsEditorProjectId = normalizedProjectId;
    customInstructionsEditorValue = storedValue;
  }

  function normalizeGovernanceRulesByProject(value) {
    const result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return result;
    }
    for (const rawKey of Object.keys(value)) {
      const key = normalizeProjectPreferenceKey(rawKey);
      if (!key) {
        continue;
      }
      result[key] = normalizeGovernanceRules(value[rawKey]);
    }
    return result;
  }

  function normalizeSelectedLocalSkillIdsByProject(value) {
    const result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return result;
    }
    for (const rawKey of Object.keys(value)) {
      const key = normalizeProjectPreferenceKey(rawKey);
      if (!key) {
        continue;
      }
      result[key] = normalizeSelectedLocalSkillIds(value[rawKey]);
    }
    return result;
  }

  function normalizeProjectPreferenceKey(value) {
    const text = String(value || '').trim();
    return text.length <= 160 ? text : text.slice(0, 159) + '…';
  }

  function normalizeGovernanceRules(value = {}) {
    if (GovernanceRules?.normalizeGovernanceRules) {
      return GovernanceRules.normalizeGovernanceRules(value);
    }
    return {
      readonlyPatterns: normalizePatternTextList(value.readonlyPatterns),
      writablePatterns: normalizePatternTextList(value.writablePatterns),
      sensitiveCheckEnabled: value.sensitiveCheckEnabled !== false,
      sensitiveConfirmAllowed: value.sensitiveConfirmAllowed === true
    };
  }

  function normalizePatternTextList(value) {
    if (Array.isArray(value)) {
      return value.map(item => String(item || '').trim()).filter(Boolean);
    }
    return String(value || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  }

  function getGovernanceRulesForCurrentProject() {
    const projectId = normalizeProjectPreferenceKey(getCurrentProjectId());
    return normalizeGovernanceRulesByProject(state?.governanceRulesByProject)[projectId] || normalizeGovernanceRules({});
  }

  function setGovernanceRulesForCurrentProject(rules) {
    const projectId = normalizeProjectPreferenceKey(getCurrentProjectId());
    if (!projectId) {
      return;
    }
    state = {
      ...state,
      governanceRulesByProject: {
        ...normalizeGovernanceRulesByProject(state?.governanceRulesByProject),
        [projectId]: normalizeGovernanceRules(rules)
      }
    };
  }

  // Theme: a global preference (dark / light / auto) applied to the panel root
  // via themeController. 'auto' resolves through prefers-color-scheme; the
  // disposer detaches the OS-change listener when switching away from auto.
  let themeAutoDisposer = null;
  function getThemePreference() {
    return CodexOverleafTheme.normalizeThemePreference(state?.theme);
  }
  function applyPanelTheme(preference) {
    const normalized = CodexOverleafTheme.normalizeThemePreference(preference);
    CodexOverleafTheme.applyTheme(normalized, panel);
    if (themeAutoDisposer) {
      themeAutoDisposer();
      themeAutoDisposer = null;
    }
    themeAutoDisposer = CodexOverleafTheme.watchAuto(normalized, panel);
  }

  function getSkillLoadingSettings() {
    return {
      loadCodexLocalSkills: state?.loadCodexLocalSkills !== false,
      loadCodexOverleafSkills: state?.loadCodexOverleafSkills !== false
    };
  }

  function setSkillLoadingSettings(settings = {}) {
    state = {
      ...state,
      loadCodexLocalSkills: settings.loadCodexLocalSkills !== false,
      loadCodexOverleafSkills: settings.loadCodexOverleafSkills !== false
    };
  }

  function getCodexOverleafSkillEnabled() {
    const map = state?.codexOverleafSkillEnabled;
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  }

  function isCodexOverleafSkillEnabled(skillId) {
    const map = getCodexOverleafSkillEnabled();
    if (!Object.prototype.hasOwnProperty.call(map, skillId)) {
      return true; // absent means enabled (default true)
    }
    return map[skillId] !== false;
  }

  function setCodexOverleafSkillEnabled(skillId, enabled) {
    const map = getCodexOverleafSkillEnabled();
    state = {
      ...state,
      codexOverleafSkillEnabled: {
        ...map,
        [skillId]: Boolean(enabled)
      }
    };
    saveStateSoon();
    renderLocalSkillList();
  }

  function readSkillLoadingSettingsFromSettings() {
    return SettingsPanel.readState(settingsPanelInstance).skillToggles;
  }

  function readGovernanceRulesFromSettings() {
    return normalizeGovernanceRules(SettingsPanel.readState(settingsPanelInstance).governanceRules);
  }

  function syncProjectSettingsEditorForProject() {
    SettingsPanel.loadState(settingsPanelInstance, {
      governanceRules: getGovernanceRulesForCurrentProject(),
      skillToggles: getSkillLoadingSettings(),
      theme: getThemePreference(),
      language: getLocale()
    });
    renderLocalSkillList();
  }

  function setProjectSettingsStatus(text, status = 'info') {
    SettingsPanel.setStatus(settingsPanelInstance, text, status);
  }

  function clearProjectSettingsStatus() {
    SettingsPanel.clearStatus(settingsPanelInstance);
  }

  async function refreshLocalSkills() {
    return localSkillsPanel.refreshLocalSkills();
  }

  function renderLocalSkillList() {
    localSkillsPanel.renderLocalSkillList();
    // Keep the settings-screen entry-row summary in sync with the skill list:
    // it reflects the enabled-skill count (or "Off" when the master is off).
    updateSkillsEntrySummary();
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

    setElementTitleAndAria('[data-panel-resize-handle]', tr('resizePanel'), tr('resizePanel'));
    setElementTitleAndAria('[data-refresh]', tr('refreshProbe'), tr('refreshProbe'));
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
    setElementTitleAndAria('[data-run]', currentRunView ? tr('cancelRun') : tr('send'), currentRunView ? tr('cancelRun') : tr('send'));

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
      reviewToggle.title = tr('requireReviewingTitle');
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
    const emptyRunLabel = panel.querySelector('.empty-runs div');
    if (emptyRunLabel) {
      emptyRunLabel.textContent = tr('emptyRunLabel');
    }

    syncModeControls();
    updateOtStatusDisplay();
    updateExperimentalOtMenuStatus();
    renderModelConfigChoices();
    updateModelDisplay();
    renderSessionList();
    renderContextSelection();
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
    if (mode === 'confirm') {
      return 'Confirm';
    }
    if (mode === 'auto') {
      return 'Auto';
    }
    return '';
  }

  function installDiagnosticsDismiss() {
    // DiagnosticsPanel installs its outside-click dismiss listener during create().
  }

  function closeDiagnosticsResult() {
    DiagnosticsPanel.closeResult(diagnosticsPanelInstance);
  }

  function showDiagnosticsLoading(title, subtitle = tr('diagnosticsLoading')) {
    DiagnosticsPanel.showLoading(diagnosticsPanelInstance, title, subtitle);
  }

  function showDiagnosticsResult(result = {}) {
    DiagnosticsPanel.showResult(diagnosticsPanelInstance, result);
  }

  // Push an overall health bucket (ok / warn / fail / unknown) to the
  // diagnostics trigger's status dot.
  function setDiagnosticsHealth(health) {
    DiagnosticsPanel.updateStatus(diagnosticsPanelInstance, { health });
  }

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


  async function exportDiagnosticsBundle() {
    if (!AuditRecords?.buildDiagnosticBundle) {
      throw new Error('Audit diagnostics helper is unavailable');
    }
    const [auditLogs, mirror, nativeDiagnostics] = await Promise.all([
      getRecentAuditLogsForCurrentProject(),
      getMirrorFreshness().catch(error => ({ status: 'unavailable', errorCode: error.message })),
      getNativeDiagnosticsSummaryForBundle()
    ]);
    const bundle = AuditRecords.buildDiagnosticBundle({
      excludeContent: true,
      compatibility: {
        extension: getExtensionCompatibilityMetadata(),
        modelDiscovery: getModelDiscovery()
      },
      platform: nativeDiagnostics.platform,
      nativeEnvironment: nativeDiagnostics.nativeEnvironment,
      mirror,
      auditLogs,
      run: currentRunView ? {
        id: currentRunView.recordId || '',
        status: 'running'
      } : {},
      governance: getGovernanceRulesForCurrentProject(),
      projectId: getCurrentProjectId()
    });
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `codex-overleaf-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showPluginToast(tr('diagnosticsExportDone'), { status: 'completed' });
  }

  async function getNativeDiagnosticsSummaryForBundle() {
    try {
      const params = CodexOverleafCompatibility?.buildBridgePingParams
        ? CodexOverleafCompatibility.buildBridgePingParams(getExtensionCompatibilityMetadata())
        : {};
      const response = await sendBackgroundNative({ method: 'bridge.ping', params });
      if (!response?.ok) {
        const errorCode = response?.error?.code || 'native_unavailable';
        return {
          platform: { status: 'unavailable', errorCode },
          nativeEnvironment: { status: 'unavailable', errorCode }
        };
      }
      return {
        platform: {
          host: response.result?.host || '',
          platform: response.result?.platform || '',
          version: response.result?.version || '',
          protocolVersion: response.result?.protocolVersion || ''
        },
        nativeEnvironment: response.result?.environment || {}
      };
    } catch (error) {
      const errorCode = error?.message || 'native_unavailable';
      return {
        platform: { status: 'unavailable', errorCode },
        nativeEnvironment: { status: 'unavailable', errorCode }
      };
    }
  }

  async function getRecentAuditLogsForCurrentProject(limit = 12) {
    const StorageDb = window.CodexOverleafStorageDb;
    if (!StorageDb?.getAllByIndex) {
      return [];
    }
    const records = await StorageDb.getAllByIndex('auditLogs', 'projectId', getCurrentProjectId());
    return (records || [])
      .slice()
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
      .slice(0, limit);
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

  function resetContextProject() {
    return contextTrayController.resetContextProject();
  }

  async function runTask() {
    // Barrier on a still-flying background mirror refresh from the previous
    // turn (v1.7.5) BEFORE startRunView creates the new run view: the mirror's
    // wrap-up events must land in the run that produced them, not the new
    // one, and mirror.sync landing mid-run would swap the local baseline
    // under Codex.
    const pendingMirror = getPendingMirrorRefresh?.();
    if (pendingMirror) {
      await pendingMirror.catch(() => {});
    }
    readPanelInputs();
    // Freeze submitted run identity before the panel can change during the run.
    const submittedMode = state.mode;
    const submittedRequireReviewing = state.requireReviewing === true;
    const submittedCustomInstructions = getCustomInstructionsForCurrentProject();
    const submittedSkillLoadingSettings = getSkillLoadingSettings();
    const submittedAttachments = getComposerAttachmentsForRun();
    const submittedSkillInvocation = getComposerSkillInvocationForRun();

    const task = state.task.trim();
    if (!task) {
      appendLog(tx('Enter a task first.', '请先输入任务。'));
      return;
    }

    runCancellationRequested = false;
    setRunning(true);
    currentRunView = startRunView({
      task,
      mode: submittedMode,
      model: state.model,
      reasoningEffort: state.reasoningEffort,
      speedTier: state.speedTier,
      attachments: submittedAttachments,
      skillInvocation: submittedSkillInvocation
    });
    const runSessionId = currentRunView.sessionId;
    let runAuditDraft = await createAuditDraftForRun({
      task,
      sessionId: runSessionId,
      mode: submittedMode,
      focusFiles: getActiveFocusFiles()
    });
    announceCrossTabRunStart();
    // Keep attachments across turns (v1.7.5): screenshots and files usually
    // anchor several follow-up questions. The tray keeps them visible and
    // hand-removable; only the task text resets after submit.
    clearTaskComposer({ keepAttachments: true });
    appendRunEvent({
      title: submittedSkillInvocation?.id === 'skill-installer'
        ? tx('I will use the Codex skill installer for this request.', '我会用 Codex skill installer 处理这个请求。')
        : tx('I will first understand your request, then inspect the relevant Overleaf files.', '我会先理解你的请求，再检查相关 Overleaf 文件。'),
      status: 'running',
      detail: {
        [tr('mode')]: formatModeLabel(submittedMode),
        [tx('Model', '模型')]: state.model,
        [tx('Reasoning effort', '推理强度')]: state.reasoningEffort,
        [tx('Speed', '速度')]: state.speedTier,
        [tx('Track required', '要求留痕')]: submittedRequireReviewing ? tx('yes', '是') : tx('no', '否'),
        [tx('Skill', '技能')]: submittedSkillInvocation?.title || tr('noneValue'),
        [tx('Attachments', '附件')]: submittedAttachments.map(attachment => attachment.name).join(listSeparator()) || tr('noneValue'),
        '@context': formatContextItems(getActiveFocusFiles())
      }
    });
    try {
      if (submittedSkillInvocation?.id === 'skill-installer') {
        await runSkillInstallerTask({
          task,
          runSessionId,
          runAuditDraft,
          submittedMode,
          submittedCustomInstructions,
          submittedSkillLoadingSettings,
          submittedAttachments,
          submittedSkillInvocation
        });
        return;
      }
      appendRunEvent({
        // Wording must match behavior: a non-empty focus selection RESTRICTS
        // reads and writes to these files (shouldRestrictWritebackToFocus),
        // it does not merely "prioritize" them. The selection persists across
        // turns until cleared via the ＋ tray.
        title: tx(
          `This run reads and writes ONLY: ${formatContextItems(getActiveFocusFiles())} (persists across turns; clear via ＋)`,
          `本轮仅读写：${formatContextItems(getActiveFocusFiles())}（跨轮保留，可在 ＋ 中清除）`
        ),
        status: 'completed'
      });

      await pauseOtWarmMirror('run-start');
      const writeSafety = await preflightWriteSafety({
        mode: submittedMode,
        requireReviewing: submittedRequireReviewing
      });
      if (!writeSafety.ok) {
        await finalizeAuditRecord(runAuditDraft, {
          resultStatus: 'blocked',
          blockedFiles: [{ path: 'write-preflight', reason: writeSafety.reason || 'write_safety' }]
        });
        return;
      }

      let focusFiles = getActiveFocusFiles();
      const warmStart = await resolveWarmRunStart({ focusFiles, mode: submittedMode });
      let project = warmStart.project || null;
      let useExistingMirror = warmStart.useExistingMirror;
      let fileOverlays = warmStart.fileOverlays || null;
      let otWarmStart = warmStart.otWarmStart === true;
      if (!useExistingMirror) {
        appendRunEvent({
          title: tx('Syncing the Overleaf project to the local Codex workspace.', '正在同步 Overleaf 项目到本地 Codex workspace。'),
          status: 'running'
        });
        project = await getRunProjectSnapshot();
      }
      throwIfRunCancellationRequested();
      if (!useExistingMirror) {
        appendLog(formatProjectSnapshotUserLog(project));
      }
      currentRunView.projectFiles = captureProjectReferenceFiles(project);
      const snapshotWarnings = useExistingMirror
        ? { blocking: [], nonBlocking: [] }
        : getProjectSnapshotWarnings(project);
      const warmMirrorReuse = useExistingMirror
        ? warmStart
        : await resolveWarmMirrorReuse(project, {
          snapshotWarnings,
          focusFiles,
          mode: submittedMode
        });
      const focusedPartialSnapshot = runController.canUseFocusedPartialSnapshot({
        project,
        snapshotWarnings,
        focusFiles,
        isUsableProjectFileContent: window.CodexOverleafProjectFiles.isUsableProjectFileContent
      });
      let restrictToFocusFiles = runController.shouldRestrictWritebackToFocus({ focusFiles });
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
        appendCompletionReport({
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
        finishRunView(tx('Blocked: full project was not read', '已阻止：没有读到完整项目'), 'failed');
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
          restrictToFocusFiles = true;
        }
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

      const activeSession = findSessionById(runSessionId) || getActiveSession(state);
      const codexThreadId = activeSession?.codexThreadId || '';

      // Resolve @compile-log if mentioned in task
      let compileLogContext = null;
      if (/(^|[^\w])@compile-log\b/i.test(task)) {
        appendRunEvent({ title: tx('Fetching compile log (@compile-log).', '正在获取编译日志 (@compile-log)。'), status: 'running' });
        compileLogContext = await resolveCompileLogContext();
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
            title: tx(`Compile log unavailable: ${compileLogContext.reason}`, `编译日志不可用：${compileLogContext.reason}`),
            status: 'failed',
            failure: contextFailure
          });
        }
      }

      const sensitiveFindings = await runSensitivePreflight({
        task,
        project,
        rules: getGovernanceRulesForCurrentProject(),
        useExistingMirror
      });
      if (sensitiveFindings.blocked) {
        await finalizeAuditRecord(runAuditDraft, {
          resultStatus: 'blocked_sensitive',
          sensitiveFindings: sensitiveFindings.findings,
          blockedFiles: sensitiveFindings.findings.map(finding => ({
            path: finding.path || finding.source || 'task',
            reason: finding.detectorId || 'sensitive'
          }))
        });
        finishRunView(tx('Blocked: sensitive content review required', '已阻止：需要处理敏感内容'), 'failed');
        return;
      }
      if (sensitiveFindings.findings.length) {
        runAuditDraft = await updateAuditSensitiveFindings(runAuditDraft, sensitiveFindings.findings);
      }

      await settleMirrorPrefetchBeforeRun();
      appendRunEvent({ title: tx('Local Codex session is starting.', '本地 Codex session 开始运行。'), status: 'running' });
      let response = await sendNative({
        method: 'codex.run',
        params: buildCodexRunParams({
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
          attachments: submittedAttachments,
          skillInvocation: submittedSkillInvocation,
          submittedMode
        })
      });

      // Handle mirror_stale error by retrying with full sync
      if (!response.ok && response.error?.code === 'mirror_stale' && useExistingMirror) {
        appendRunEvent({ title: tr('warmMirrorStaleRetryTitle'), status: 'running' });
        const staleRetry = await prepareMirrorStaleRetry({
          project: await getRunProjectSnapshot(),
          focusFiles
        });
        if (!staleRetry.ok) {
          return;
        }
        project = staleRetry.project;
        currentRunView.projectFiles = captureProjectReferenceFiles(project);
        useExistingMirror = false;
        fileOverlays = null;
        otWarmStart = false;
        restrictToFocusFiles = staleRetry.restrictToFocusFiles;
        response = await sendNative({
          method: 'codex.run',
          params: buildCodexRunParams({
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
            attachments: submittedAttachments,
            skillInvocation: submittedSkillInvocation,
            submittedMode
          })
        });
      }

      if (!response.ok && response.error?.code === 'thread_resume_failed') {
        const userChoice = await showThreadResumeFailedPrompt();
        if (userChoice === 'new') {
          updateSessionById(runSessionId, { codexThreadId: '' });
          const StorageDb = window.CodexOverleafStorageDb;
          if (StorageDb) {
            const record = await StorageDb.getRecord('sessions', runSessionId);
            if (record) {
              record.codexThreadId = '';
              await StorageDb.putRecord('sessions', record);
            }
          }
          appendRunEvent({ title: tx('Creating a new Codex conversation thread.', '正在新建 Codex 会话线程。'), status: 'running' });
          response = await sendNative({
            method: 'codex.run',
            params: buildCodexRunParams({
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
              attachments: submittedAttachments,
              skillInvocation: submittedSkillInvocation,
              submittedMode
            })
          });
        } else {
          appendRunEvent({ title: tx('Cancelled: user chose not to create a new thread.', '已取消：用户选择不新建线程。'), status: 'rejected' });
          await finalizeAuditRecord(runAuditDraft, { resultStatus: 'rejected' });
          finishRunView(tx('Cancelled', '已取消'), 'rejected');
          return;
        }
      }

      if (!response.ok) {
        if (runCancellationRequested || isRunCancellationError(response.error)) {
          appendRunCancelledReport();
          await finalizeAuditRecord(runAuditDraft, { resultStatus: 'cancelled' });
          finishRunView(tx('Cancelled', '已中断'), 'rejected');
          return;
        }
        const translated = translateRawError(response.error.message, { mode: submittedMode, locale: getLocale() });
        // Structured FailureReason (§9.7): split bridge-availability from
        // Codex-side errors. `native_connection_failed` / `native_unavailable`
        // / `native_update_required` indicate the bridge itself is missing,
        // so emit `native_bridge_unavailable` (blocked, retryable). All other
        // native errors are treated as a Codex-side surface error and emit
        // `codex_no_usable_result` (error, retryable).
        // Map native/codex failures onto their SPECIFIC catalog codes — the
        // timeout/not-found/output-limit entries (and their bilingual next
        // steps) existed but were never emitted, so everything collapsed into
        // "no usable result" and pointed users at the wrong recovery.
        const runErrorMessage = String(response.error?.message || '');
        const codexRunFailure = response.error?.code === 'native_execution_interrupted'
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
          conclusion: translated.conclusion,
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
        finishRunView(response.error?.code === 'project_locked'
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
        appendCompletionReport({
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
        finishRunView(tx('Local Codex returned nothing usable', '本地 Codex 没有返回可用结果'), 'failed');
        return;
      }
      const writebackProject = useExistingMirror
        ? mergeProjectWithSyncChangeBaseFiles(project, syncChanges)
        : project;
      const syncOutcome = await applySyncChangesToOverleaf(syncChanges, writebackProject, {
        assistantMessage,
        unsupportedChanges: response.result.unsupportedChanges || [],
        mode: submittedMode,
        requireReviewing: submittedRequireReviewing
      });
      await finalizeAuditRecord(runAuditDraft, {
        ...(syncOutcome.audit || {}),
        sensitiveFindings: sensitiveFindings.findings,
        resultStatus: syncOutcome.hasSkippedOperations ? 'completed_with_skips' : 'completed'
      });

      finishRunView(
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
            persistPostNavigationRunStatus(finishedRunRecord, postNavigationStatus);
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
          const StorageDb = window.CodexOverleafStorageDb;
          if (StorageDb) {
            const record = await StorageDb.getRecord('sessions', runSessionId);
            if (record) {
              record.codexThreadId = returnedThreadId;
              record.updatedAt = new Date().toISOString();
              await StorageDb.putRecord('sessions', record);
            }
          }
        }

        await saveState();
        applyStateToPanel();
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
        appendRunCancelledReport();
        await finalizeAuditRecord(runAuditDraft, { resultStatus: 'cancelled' });
        finishRunView(tx('Cancelled', '已中断'), 'rejected');
        return;
      }
      // codexReturned: assistantMessage arrived on the stream before the
      // exception escaped, so Codex's answer is preserved in the conversation
      // — the fallback conclusion must reflect that instead of saying
      // 'local Codex returned no usable result'.
      const codexReturned = Boolean(getAssistantAnswerForCurrentRun());
      const translated = translateRawError(error.message, { mode: submittedMode, locale: getLocale(), codexReturned });
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
        conclusion: translated.conclusion,
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
      finishRunView(tx('Task failed', '任务失败'), 'failed');
    } finally {
      setRunning(false);
      nativeChannel.clearActiveRequest();
      stopRunElapsedTick();
      currentRunView = null;
      runCancellationRequested = false;
      if (isExperimentalOtEnabled()) {
        await resumeOtWarmMirror('run-settled');
      }
      saveStateSoon();
    }
  }

  async function runSkillInstallerTask({
    task,
    runSessionId,
    runAuditDraft,
    submittedMode,
    submittedCustomInstructions,
    submittedSkillLoadingSettings,
    submittedAttachments,
    submittedSkillInvocation
  }) {
    appendRunEvent({
      title: tx('Starting the Codex skill installer.', '正在启动 Codex skill installer。'),
      status: 'running'
    });
    const activeSession = findSessionById(runSessionId) || getActiveSession(state);
    const codexThreadId = activeSession?.codexThreadId || '';
    const params = {
      projectId: getCurrentProjectId(),
      mode: submittedMode,
      task,
      model: state.model,
      reasoningEffort: state.reasoningEffort,
      speedTier: state.speedTier,
      session: state.session,
      threadId: codexThreadId || undefined,
      customInstructions: submittedCustomInstructions || undefined,
      loadCodexLocalSkills: submittedSkillLoadingSettings?.loadCodexLocalSkills !== false,
      loadCodexOverleafSkills: submittedSkillLoadingSettings?.loadCodexOverleafSkills !== false,
      attachments: submittedAttachments.length ? submittedAttachments : undefined,
      skillInvocation: submittedSkillInvocation,
      focusFiles: [],
      skipMirrorSync: true
    };

    const response = await sendNative({
      method: 'codex.run',
      params
    });

    if (!response.ok) {
      if (runCancellationRequested || isRunCancellationError(response.error)) {
        appendRunCancelledReport();
        await finalizeAuditRecord(runAuditDraft, { resultStatus: 'cancelled' });
        finishRunView(tx('Cancelled', '已中断'), 'rejected');
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
        conclusion: translated.conclusion,
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
      finishRunView(tx('Skill installer failed', 'Skill installer 失败'), 'failed');
      return;
    }

    const assistantMessage = response.result?.assistantMessage || getAssistantAnswerForCurrentRun();
    appendCompletionReport({
      conclusion: assistantMessage || tx('Skill installer completed.', 'Skill installer 已完成。'),
      status: 'completed',
      operations: [],
      applyResults: [],
      nextStep: tx('Restart Codex Overleaf or start a new run if the installed skill is not visible immediately.', '如果新安装的 skill 没有立刻出现，请重启 Codex Overleaf 或开始新一轮运行。'),
      mode: submittedMode
    });
    await finalizeAuditRecord(runAuditDraft, { resultStatus: 'completed' });
    finishRunView(tx('Skill installer completed', 'Skill installer 已完成'), 'completed');

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
      const StorageDb = window.CodexOverleafStorageDb;
      if (StorageDb) {
        const record = await StorageDb.getRecord('sessions', runSessionId);
        if (record) {
          record.codexThreadId = returnedThreadId;
          await StorageDb.putRecord('sessions', record);
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
    const method = requireReviewing ? 'ensureReviewing' : 'ensureEditing';

    appendRunEvent({
      title: requireReviewing
        ? tx('Checking Overleaf Reviewing/Track Changes before starting.', '正在确认 Overleaf 留痕状态。')
        : tx('Checking Overleaf Editing mode before starting.', '正在确认 Overleaf Editing 模式。'),
      status: 'running'
    });

    let result = null;
    try {
      // Thread runProjectId through so the page-bridge dispatcher applies the
      // writeGuard. Without it, a mid-flight SPA navigation could leave the
      // pre-flight ensureReviewing/Editing toggle landing in the wrong
      // project — Track Changes flipped on/off in a project the user did
      // not intend to write to.
      result = await callPageBridge(method, {
        waitMs: 1800,
        runProjectId: currentRunView?.runProjectId || ''
      });
    } catch (error) {
      result = {
        ok: false,
        reason: error?.message || (requireReviewing
          ? tx('Overleaf did not return track changes status', 'Overleaf 没有返回留痕状态')
          : tx('Overleaf did not return Editing mode status', 'Overleaf 没有返回 Editing 模式状态')),
        reviewing: null
      };
    }

    if (result?.ok) {
      appendRunEvent({
        title: requireReviewing
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

    const reason = localizeVisibleReason(result?.reason || (requireReviewing
      ? tx('Overleaf did not return track changes status', 'Overleaf 没有返回留痕状态')
      : tx('Overleaf did not return Editing mode status', 'Overleaf 没有返回 Editing 模式状态')));
    const nextStep = requireReviewing
      ? tx(
        'You may not have permission, or this Overleaf page did not expose the Reviewing switch. Switch to Reviewing manually and retry, or turn off Track before writing.',
        '你可能没有权限，或 Overleaf 当前页面没有暴露切换入口。可以手动切到 Reviewing 后重试，或关闭“留痕”再运行。'
      )
      : tx(
        'You may not have permission, or this Overleaf page did not expose the Editing switch. Switch to Editing manually and retry.',
        '你可能没有权限，或 Overleaf 当前页面没有暴露切换入口。请在 Overleaf 手动切到 Editing 后重试。'
      );
    appendRunEvent({
      title: requireReviewing
        ? tx('Task not started: could not enable Overleaf Reviewing/Track Changes.', '任务未开始：无法开启 Overleaf 留痕。')
        : tx('Task not started: could not switch to Overleaf Editing.', '任务未开始：无法切换到 Overleaf Editing。'),
      status: 'failed',
      detail: {
        [tr('detailReason')]: reason,
        [tr('detailNext')]: nextStep
      },
      technicalDetail: {
        reason,
        reviewing: result?.reviewing || null
      }
    });
    appendCompletionReport({
      conclusion: tx('This task did not start: Codex did not run and no files were written.', '这轮任务没有开始：Codex 没有运行，也没有写入文件。'),
      status: 'blocked',
      operations: [],
      applyResults: [],
      nextStep
    });
    const finishTitle = requireReviewing
      ? tx('Not started: could not enable Track Changes', '未开始：无法开启留痕')
      : tx('Not started: could not switch to Editing', '未开始：无法切换到 Editing');
    finishRunView(finishTitle, 'failed');
    return {
      ok: false,
      reason,
      reviewing: result?.reviewing || null
    };
  }

  function buildSessionHistoryResult({ assistantMessage = '', syncOutcome = {}, syncChanges = [] } = {}) {
    return runController.buildSessionHistoryResult({ assistantMessage, syncOutcome, syncChanges, locale: getLocale() });
  }

  function truncateSessionHistoryText(value, maxLength) {
    return runController.truncateSessionHistoryText(value, maxLength);
  }

  function safeRunTask() {
    if (updateIdleClient?.isApplying()) {
      showPluginToast(tx('An update is being applied. Codex will be available again after reload.', '正在应用更新，重新加载后即可继续使用 Codex。'), { status: 'info' });
      return;
    }
    if (currentRunView) {
      return;
    }
    runTask().catch(error => {
      setRunning(false);
      nativeChannel.clearActiveRequest();
      stopRunElapsedTick();
      currentRunView = null;
      console.error('[codex-overleaf] failed to start task', error);
      appendPlainLog(tx(`Could not start Codex task: ${error.message}`, `无法启动 Codex 任务：${error.message}`));
    });
  }

  async function cancelActiveRun() {
    if (!currentRunView || runCancellationRequested) {
      return;
    }
    runCancellationRequested = true;
    cancelActivePageBridgeRequests();
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
    const activeRequestId = nativeChannel.getActiveRequestId();
    const projectKey = currentRunView?.runProjectId || getCurrentProjectId() || '';

    const cancelTargets = [];
    if (activeRequestId || projectKey) {
      cancelTargets.push(sendBackgroundNative({
        method: 'codex.cancel',
        params: {
          requestId: activeRequestId || undefined,
          projectKey: projectKey || undefined
        }
      }));
    }
    // The page-side cancel is best-effort — it only matters if a writeback
    // is currently in flight. Swallow errors / unavailable bridge so the
    // native cancel still completes even if the page side is unreachable.
    cancelTargets.push(callPageBridge('cancelActiveWrite', {}).catch(() => ({ ok: false })));

    Promise.allSettled(cancelTargets).then((results) => {
      const nativeResult = results[0];
      const nativeResponse = nativeResult?.status === 'fulfilled' ? nativeResult.value : null;
      if (nativeResponse && !nativeResponse.ok) {
        const message = nativeResponse?.error?.message || tx('native host did not respond', 'native host 没有响应');
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
    const handlers = Array.from(activePageBridgeCancellationHandlers.values());
    activePageBridgeCancellationHandlers.clear();
    for (const cancel of handlers) {
      cancel();
    }
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
    if (response?.ok) {
      const result = response.result || response;
      const released = result.lockReleased === true || result.cancelled === true;
      appendPlainLog(released
        ? tx(
          `Force-released the stuck Codex run for project ${projectKey}. You can retry now.`,
          `已强制释放项目 ${projectKey} 的 Codex 占用，可以重试了。`
        )
        : tx(
          `No stuck run was found for project ${projectKey}.`,
          `没有发现项目 ${projectKey} 上的卡住任务。`
        ));
      return response;
    }
    const message = response?.error?.message || tx('native host did not respond', 'native host 没有响应');
    appendPlainLog(tx(
      `Force-release request was not delivered: ${message}`,
      `强制释放请求没有送达：${message}`
    ));
    return response;
  }

  function throwIfRunCancellationRequested() {
    if (!runCancellationRequested) {
      return;
    }
    const error = new Error('Codex run was cancelled by the user');
    error.code = 'codex_cancelled';
    throw error;
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

  async function showPluginConfirm({
    title = tr('confirmDefaultTitle'),
    message = '',
    confirmLabel = tr('confirmDefaultConfirm'),
    cancelLabel = tr('confirmDefaultCancel'),
    destructive = false
  } = {}) {
    if (!panel) {
      ensurePanelOpen();
    }

    if (activePluginConfirmResolve) {
      activePluginConfirmResolve(false);
      activePluginConfirmResolve = null;
    }

    return new Promise(resolve => {
      let settled = false;
      const overlay = document.createElement('div');
      overlay.className = 'codex-plugin-confirm';
      overlay.setAttribute('data-plugin-confirm', 'true');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', title);

      const card = document.createElement('section');
      card.className = 'codex-plugin-confirm-card';

      const head = document.createElement('div');
      head.className = 'codex-plugin-confirm-head';
      const icon = document.createElement('img');
      icon.className = 'codex-plugin-confirm-icon';
      icon.alt = '';
      icon.setAttribute('aria-hidden', 'true');
      icon.src = chrome.runtime.getURL('assets/icons/codex-overleaf-dialog-icon.png');
      const titleWrap = document.createElement('div');
      const brand = document.createElement('div');
      brand.className = 'codex-plugin-confirm-brand';
      brand.textContent = tr('confirmBrand');
      const titleEl = document.createElement('div');
      titleEl.className = 'codex-plugin-confirm-title';
      titleEl.textContent = title;
      titleWrap.append(brand, titleEl);
      head.append(icon, titleWrap);

      const body = document.createElement('div');
      body.className = 'codex-plugin-confirm-body';
      body.textContent = String(message || '');

      const actions = document.createElement('div');
      actions.className = 'codex-plugin-confirm-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'codex-plugin-confirm-cancel';
      cancel.textContent = cancelLabel;
      const confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.className = 'codex-plugin-confirm-confirm';
      if (destructive) {
        confirm.dataset.destructive = 'true';
      }
      confirm.textContent = confirmLabel;
      actions.append(cancel, confirm);
      card.append(head, body, actions);
      overlay.append(card);
      panel.append(overlay);

      const cleanup = value => {
        if (settled) {
          return;
        }
        settled = true;
        activePluginConfirmResolve = null;
        document.removeEventListener('keydown', onKeydown, true);
        overlay.remove();
        resolve(value);
      };
      activePluginConfirmResolve = cleanup;
      const onKeydown = event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cleanup(false);
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          // Destructive dialogs never treat a bare Enter as consent — the
          // user must deliberately reach the (red) confirm button. Enter on
          // a focused button still activates it via the click handler.
          if (!destructive && event.target !== cancel) {
            cleanup(true);
          } else if (event.target === cancel) {
            cleanup(false);
          } else if (event.target === confirm) {
            cleanup(true);
          }
          return;
        }
        if (event.key === 'Tab') {
          // aria-modal contract: keep Tab cycling inside the two-button card
          // instead of drifting onto the Overleaf page behind the overlay.
          event.preventDefault();
          const next = event.target === cancel ? confirm : cancel;
          next.focus();
        }
      };

      overlay.addEventListener('click', event => {
        if (event.target === overlay) {
          cleanup(false);
        }
      });
      cancel.addEventListener('click', () => cleanup(false));
      confirm.addEventListener('click', () => cleanup(true));
      document.addEventListener('keydown', onKeydown, true);
      // Destructive dialogs open on the SAFE button so a stray keystroke
      // cannot delete anything; benign confirms keep the fast path.
      (destructive ? cancel : confirm).focus();
    });
  }

  function getEnabledCodexOverleafSkillIds() {
    const skills = Array.isArray(state?.codexOverleafSkills) ? state.codexOverleafSkills : [];
    // Return the array of skills that are enabled (absent from map or explicitly true).
    return skills
      .map(skill => String(skill?.id || '').trim())
      .filter(id => id && isCodexOverleafSkillEnabled(id));
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
    attachments,
    skillInvocation,
    submittedMode
  } = {}) {
    return runController.buildCodexRunParams({
      currentProjectId: getCurrentProjectId(),
      state,
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
      enabledCodexOverleafSkillIds: getEnabledCodexOverleafSkillIds(),
      attachments,
      skillInvocation,
      compileLogContext,
      submittedMode
    });
  }

  async function createAuditDraftForRun(input = {}) {
    const StorageDb = window.CodexOverleafStorageDb;
    if (!StorageDb || !AuditRecords) {
      return null;
    }
    const draft = AuditRecords.buildAuditDraftRecord({
      projectId: getCurrentProjectId(),
      sessionId: input.sessionId || '',
      turnId: currentRunView?.recordId || '',
      mode: input.mode || state?.mode || '',
      model: state?.model || '',
      reasoningEffort: state?.reasoningEffort || '',
      speedTier: state?.speedTier || '',
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
    const StorageDb = window.CodexOverleafStorageDb;
    if (!StorageDb || !draft) {
      return draft;
    }
    const record = StorageDb.buildAuditLogRecord
      ? StorageDb.buildAuditLogRecord({ ...draft, ...updates, id: draft.id, completedAt: updates.completedAt || draft.completedAt || '' })
      : { ...draft, ...updates };
    return StorageDb.putRecord('auditLogs', record).then(() => record).catch(() => draft);
  }

  async function finalizeAuditRecord(draft, updates = {}) {
    const StorageDb = window.CodexOverleafStorageDb;
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
    options = options || {};
    const { task, project, rules, useExistingMirror = false } = options;
    const normalizedRules = normalizeGovernanceRules(rules);
    if (normalizedRules.sensitiveCheckEnabled === false) {
      return { blocked: false, findings: [] };
    }
    if (!SensitiveScan?.scanSensitiveInputs && !useExistingMirror) {
      return { blocked: false, findings: [] };
    }
    let findings = SensitiveScan?.scanSensitiveInputs
      ? SensitiveScan.scanSensitiveInputs({
        task,
        files: (project?.files || []).filter(isTextSnapshotFile)
      })
      : [];
    if (useExistingMirror) {
      findings = dedupeSensitiveFindings([
        ...findings,
        ...await scanNativeMirrorSensitiveFindings()
      ]);
    }
    if (!findings.length) {
      return { blocked: false, findings: [] };
    }
    appendRunEvent({
      title: tx(
        `Sensitive content check found ${findings.length} item(s).`,
        `敏感内容检查发现 ${findings.length} 项。`
      ),
      status: 'failed',
      detail: findings.slice(0, 8).map(finding => ({
        [tr('detailFile')]: finding.path || finding.source || 'task',
        [tr('detailReason')]: finding.detectorId,
        [tx('Preview', '预览')]: finding.preview || '[REDACTED]'
      }))
    });
    if (normalizedRules.sensitiveConfirmAllowed === true) {
      const approved = await showPluginConfirm({
        title: tr('sensitiveConfirmTitle'),
        message: formatSensitiveConfirmMessage(findings),
        confirmLabel: tr('sensitiveConfirmRun'),
        cancelLabel: tr('confirmDefaultCancel'),
        destructive: true
      });
      return { blocked: !approved, findings };
    }
    appendCompletionReport({
      conclusion: tx(
        'This run was blocked before Codex received project context because sensitive content was detected.',
        '检测到敏感内容，本轮已在向 Codex 发送项目上下文前阻止。'
      ),
      status: 'blocked',
      operations: [],
      applyResults: [],
      nextStep: tx(
        'Remove the sensitive content, narrow @context, or enable explicit sensitive confirmation in Project Settings.',
        '请移除敏感内容、缩小 @context，或在项目设置里允许敏感内容显式确认。'
      )
    });
    return { blocked: true, findings };
  }

  function formatSensitiveConfirmMessage(findings = []) {
    const visible = findings.slice(0, 8).map(finding => {
      const path = finding.path || finding.source || 'task';
      return `${path}: ${finding.detectorId || 'sensitive'} (${finding.preview || '[REDACTED]'})`;
    });
    return [
      tr('sensitiveConfirmMessage'),
      '',
      ...visible,
      findings.length > visible.length ? tx(`${findings.length - visible.length} more finding(s).`, `另有 ${findings.length - visible.length} 项。`) : ''
    ].filter(Boolean).join('\n');
  }

  async function scanNativeMirrorSensitiveFindings() {
    try {
      const response = await sendBackgroundNative({
        method: 'mirror.scanSensitive',
        params: { projectId: getCurrentProjectId() }
      });
      if (response?.ok) {
        return Array.isArray(response.result?.findings) ? response.result.findings : [];
      }
      return [{
        detectorId: 'mirror-sensitive-scan-unavailable',
        source: 'local-mirror',
        preview: response?.error?.message || 'Could not scan the local mirror before Codex runs.'
      }];
    } catch (error) {
      return [{
        detectorId: 'mirror-sensitive-scan-unavailable',
        source: 'local-mirror',
        preview: error?.message || 'Could not scan the local mirror before Codex runs.'
      }];
    }
  }

  function dedupeSensitiveFindings(findings = []) {
    const seen = new Set();
    const deduped = [];
    for (const finding of findings || []) {
      const key = [
        finding?.detectorId || '',
        finding?.source || '',
        finding?.path || '',
        finding?.preview || ''
      ].join('\u0000');
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(finding);
    }
    return deduped;
  }

  function appendRunCancelledReport() {
    appendRunEvent({
      title: tx('Current Codex task was cancelled.', '已中断当前 Codex 任务。'),
      status: 'failed'
    });
    appendCompletionReport({
      conclusion: tx('This run was cancelled. It did not continue syncing or writing to Overleaf.', '这轮已中断，没有继续同步或写入 Overleaf。'),
      status: 'rejected',
      operations: [],
      applyResults: [],
      nextStep: tx('Edit the task and run again.', '可以修改任务后重新运行。')
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

  function syncComposerSendAvailability() {
    const runButton = panel?.querySelector('[data-run]');
    if (!runButton) {
      return;
    }
    // While a run is active the button is Cancel and must stay clickable.
    if (currentRunView) {
      runButton.disabled = false;
      return;
    }
    runButton.disabled = !String(panel?.querySelector('[data-task]')?.value || '').trim();
  }

  function handleTaskInputKeydown(event) {
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
    autosizeTaskTextarea();
    syncComposerSendAvailability();
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
      {
        id: 'install-skill',
        kind: 'installer',
        title: tr('slashInstallSkillTitle'),
        subtitle: tr('slashInstallSkillSubtitle')
      }
    ];
    if (getSkillLoadingSettings().loadCodexOverleafSkills === false) {
      return commands;
    }
    for (const skill of slashCodexOverleafSkills) {
      const id = String(skill?.id || '').trim();
      if (!isSafeSkillId(id)) {
        continue;
      }
      // Only list enabled skills in the slash menu
      if (!isCodexOverleafSkillEnabled(id)) {
        continue;
      }
      const title = String(skill?.title || skill?.name || id).trim().slice(0, 80) || id;
      commands.push({
        id: `skill:${id}`,
        kind: 'codex-overleaf-skill',
        scope: 'codex-overleaf',
        skillId: id,
        title,
        subtitle: tr('slashUseSkillSubtitle')
      });
    }
    return commands;
  }

  async function refreshCodexOverleafSkillsForSlashMenu() {
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
          || command.id.toLowerCase().includes(query);
      });
      renderSlashMenu(commands);
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
    renderSlashMenu(entries);
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

  function renderSlashMenu(commands = []) {
    const menu = panel?.querySelector('[data-slash-menu]');
    if (!menu) {
      return;
    }
    menu.textContent = '';
    if (!commands.length) {
      menu.hidden = true;
      return;
    }
    commands.forEach((command, index) => {
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
      const title = document.createElement('span');
      title.textContent = command.title;
      const subtitle = document.createElement('small');
      subtitle.textContent = command.subtitle;
      button.append(title, subtitle);
      menu.append(button);
    });
    renderedSlashCommands = new Map(commands.map(command => [command.id, command]));
    menu.dataset.activeIndex = '0';
    menu.hidden = false;
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
  }

  function selectSlashCommand(commandId) {
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
    clearSlashTriggerFromTaskInput();
    closeSlashMenu();
    if (command.kind === 'installer') {
      activateSkillInstallerComposerContext();
      return;
    }
    if (command.kind === 'codex-overleaf-skill') {
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
    composerSkillInvocation = {
      id: 'skill-installer',
      title: tr('skillInstallerComposerLabel')
    };
    renderComposerSkillInvocation();
    const input = panel?.querySelector('[data-task]');
    input?.focus?.();
  }

  function activateCodexOverleafSkillComposerContext(command) {
    const id = String(command?.skillId || '').trim();
    if (!isSafeSkillId(id)) {
      return;
    }
    composerSkillInvocation = {
      id,
      title: String(command?.title || id).trim().slice(0, 80) || id,
      scope: 'codex-overleaf'
    };
    renderComposerSkillInvocation();
    const input = panel?.querySelector('[data-task]');
    input?.focus?.();
  }

  function clearComposerSkillInvocation() {
    composerSkillInvocation = null;
    renderComposerSkillInvocation();
    panel?.querySelector('[data-task]')?.focus?.();
  }

  function getComposerSkillInvocationForRun() {
    const normalized = normalizeComposerSkillInvocation(composerSkillInvocation);
    if (!normalized) {
      return null;
    }
    if (normalized.id === 'skill-installer') {
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
    if (id === 'skill-installer') {
      return { id, title };
    }
    if (value?.scope !== 'codex-overleaf') {
      return null;
    }
    return { id, title, scope: 'codex-overleaf' };
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
      const clearLabel = active?.id === 'skill-installer'
        ? tr('skillInstallerComposerClear')
        : tr('composerSkillClear');
      clear.title = clearLabel;
      clear.setAttribute('aria-label', clearLabel);
    }
  }

  function createDiffReviewElement(syncChanges, options = {}) {
    return diffReviewPanel.createDiffReviewElement(syncChanges, options);
  }

  function renderDiffReview(syncChanges) {
    return diffReviewPanel.renderDiffReview(syncChanges);
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

  function partitionUnsafeProjectPathOperations(operations = []) {
    const safe = [];
    const skipped = [];
    for (const operation of operations || []) {
      const normalized = normalizeOperationProjectPaths(operation);
      const invalid = getInvalidOperationProjectPath(normalized);
      if (invalid) {
        skipped.push({
          operation: normalized,
          result: {
            ok: false,
            code: 'invalid_project_path',
            reason: tx(`Invalid ${invalid}. Codex did not write this file.`, `路径无效：${invalid}。Codex 没有写入这个文件。`)
          }
        });
        continue;
      }
      safe.push(normalized);
    }
    return { safe, skipped };
  }

  function normalizeOperationProjectPaths(operation = {}) {
    if (!operation || typeof operation !== 'object') {
      return operation;
    }
    const normalized = { ...operation };
    if (typeof operation.path === 'string') {
      normalized.path = normalizeSafeProjectPath(operation.path);
      if (!normalized.path) {
        normalized.invalidProjectPath = true;
      }
    }
    if (typeof operation.to === 'string') {
      normalized.to = normalizeSafeProjectPath(operation.to);
      if (!normalized.to) {
        normalized.invalidProjectDestinationPath = true;
      }
    }
    if (typeof operation.destinationPath === 'string') {
      normalized.destinationPath = normalizeSafeProjectPath(operation.destinationPath);
      if (!normalized.destinationPath) {
        normalized.invalidProjectDestinationPath = true;
      }
    }
    return normalized;
  }

  function getInvalidOperationProjectPath(operation = {}) {
    if (operation.invalidProjectPath || (requiresOperationPath(operation) && !operation.path)) {
      return 'operation path';
    }
    if (operation.invalidProjectDestinationPath || (requiresOperationDestinationPath(operation) && !(operation.to || operation.destinationPath))) {
      return 'operation destination path';
    }
    return '';
  }

  function requiresOperationPath(operation = {}) {
    return ['edit', 'create', 'delete', 'rename', 'move', 'binary-create', 'overwrite-binary'].includes(operation.type);
  }

  function requiresOperationDestinationPath(operation = {}) {
    return operation.type === 'rename' || operation.type === 'move';
  }

  function normalizeSafeProjectPath(value) {
    if (window.CodexOverleafProjectFiles?.normalizeSafeProjectPath) {
      return window.CodexOverleafProjectFiles.normalizeSafeProjectPath(value);
    }
    return String(value || '')
      .replace(/\s+/g, ' ')
      .replace(/\\/g, '/')
      .trim()
      .replace(/^\/+/, '');
  }

  function evaluateGovernedOperations(operations = []) {
    if (!GovernanceRules?.evaluateGovernedOperations) {
      return { allowed: operations || [], blocked: [], rules: getGovernanceRulesForCurrentProject() };
    }
    return GovernanceRules.evaluateGovernedOperations(operations, getGovernanceRulesForCurrentProject());
  }

  function buildGovernanceSkippedApplyResult(blockedItems = []) {
    return {
      ok: blockedItems.length === 0,
      applied: [],
      skipped: (blockedItems || []).map(item => ({
        operation: item.operation,
        result: {
          ok: false,
          code: 'governance_blocked',
          reason: formatGovernanceBlockedReason(item),
          reasonKey: item.reason || 'governance_blocked'
        }
      }))
    };
  }

  function formatGovernanceBlockedReason(item = {}) {
    if (item.reason === 'readonly') {
      return tx(
        'Project governance marked this path read-only, so Codex did not write it.',
        '项目治理规则将此路径标记为只读，因此 Codex 没有写入。'
      );
    }
    if (item.reason === 'writable_allowlist') {
      return tx(
        'Project governance allows writes only to configured writable patterns, and this path is outside that allowlist.',
        '项目治理规则只允许写入配置的可写路径，此路径不在允许范围内。'
      );
    }
    return tx('Project governance blocked this write.', '项目治理规则阻止了此写入。');
  }

  function filterSyncChangesByOperations(syncChanges = [], operations = []) {
    const allowedPaths = new Set((operations || []).map(operation => operation.path).filter(Boolean));
    return (syncChanges || []).filter(change => allowedPaths.has(change?.path));
  }

  function mergeApplyResultSkipped(result = {}, skipped = []) {
    if (!skipped.length) {
      return result;
    }
    return {
      ...(result || {}),
      ok: false,
      applied: Array.isArray(result?.applied) ? result.applied : [],
      skipped: [
        ...getSkippedEntries(result),
        ...skipped
      ]
    };
  }

  async function confirmBinaryOperations(operations = []) {
    const binaryOperations = (operations || []).filter(operation => operation.type === 'binary-create' || operation.type === 'overwrite-binary');
    if (!binaryOperations.length) {
      return { operations, skipped: [] };
    }
    const approved = await showPluginConfirm({
      title: tr('binaryAssetConfirmTitle'),
      message: tr('binaryAssetConfirmMessage', { files: formatOperationFiles(binaryOperations) }),
      confirmLabel: tr('binaryAssetConfirm'),
      cancelLabel: tr('binaryAssetCancel'),
      destructive: true
    });
    if (approved) {
      return { operations, skipped: [] };
    }
    return {
      operations: operations.filter(operation => operation.type !== 'binary-create' && operation.type !== 'overwrite-binary'),
      skipped: binaryOperations.map(operation => ({
        operation,
        result: {
          ok: false,
          code: 'binary_confirmation_rejected',
          reason: tx('Binary asset writeback requires explicit confirmation and was skipped.', '二进制资源写回需要显式确认，已跳过。')
        }
      }))
    };
  }

  function buildAuditDiffSummary(operations = []) {
    const changedFiles = new Set();
    let binaryFilesChanged = 0;
    for (const operation of operations || []) {
      if (operation?.path) {
        changedFiles.add(operation.path);
      }
      if (operation?.type === 'binary-create' || operation?.type === 'overwrite-binary') {
        binaryFilesChanged++;
      }
    }
    return {
      filesChanged: changedFiles.size,
      additions: 0,
      deletions: 0,
      binaryFilesChanged
    };
  }

  function buildAuditSummaryFromApply({ operations = [], applyResults = [], blockedFiles = [], resultStatus = 'completed', saveVerification = null } = {}) {
    const appliedFiles = [];
    const skippedFiles = [];
    for (const result of applyResults || []) {
      for (const item of getAppliedEntries(result)) {
        appliedFiles.push(summarizeOperationForAudit(item.operation, item.result, 'applied'));
      }
      for (const item of getSkippedEntries(result)) {
        skippedFiles.push(summarizeOperationForAudit(item.operation, item.result, 'skipped'));
      }
    }
    return {
      changedFiles: (operations || []).map(operation => summarizeOperationForAudit(operation, {}, 'changed')),
      ['diffSummary']: buildAuditDiffSummary(operations),
      blockedFiles,
      appliedFiles,
      skippedFiles,
      resultStatus,
      saveVerification
    };
  }

  // Tolerates `operation` and `result` being null in addition to undefined.
  // Default-parameter values fire only for `undefined`, but the v1.3.8
  // write-guard (pageBridge.runWriteGuard / writebackRouter.checkWritebackRunProjectId)
  // emits batch-level skips with `operation: null` — there is no specific
  // op to attribute the block to. Without this normalization the audit pass
  // crashed with "Cannot read properties of null (reading 'path')", the
  // outer-catch swallowed the partial-sync conclusion, and the user saw the
  // misleading "local Codex returned no usable result" fallback.
  function summarizeOperationForAudit(operation, result, status = '') {
    const op = operation || {};
    const res = result || {};
    return {
      path: op.path || op.from || op.to || '',
      destinationPath: op.destinationPath || op.to || '',
      type: op.type || '',
      reason: res.reasonKey || res.code || res.reason || op.reasonKey || op.reason || '',
      status,
      size: op.size
    };
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

  async function reloadProjectRunHistory(newProjectId) {
    // Rebind the storage key to the new project and reload the panel state
    // from chrome.storage.local so the per-project session list reflects
    // the project the user just navigated into.
    try {
      storageKey = getProjectStorageKey(LEGACY_STORAGE_KEY, window.location.href);
      const reloaded = await loadStoredState();
      state = normalizePanelState(reloaded, { restoreRunningRuns: true });
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

  function onSpaRouteChange() {
    const url = window.location;
    // Recompute the account scope on every route change (spec §5.2 per-
    // project derivation: account menu is global chrome and should be
    // readable on per-project URLs too).
    refreshAccountScopeId().catch(() => { /* fail-closed handled inside */ });
    if (isProjectEditorRoute(url)) {
      const newId = url.pathname.match(/^\/project\/([^/?#]+)/)[1];
      if (newId !== activeProjectId) {
        leaveActiveProject(newId);
        enterProject(newId);
      }
      renderPerProjectVariant();
    } else {
      leaveActiveProject(null);
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
      try {
        onSpaRouteChange();
      } catch (_error) {
        // Route-hook failures must never crash the page.
      }
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

  // -----------------------------------------------------------------------
  // Post-navigation run settlement (spec §5.7.1 + plan Step 6).
  // -----------------------------------------------------------------------
  //
  // When a Codex run completes after the user navigated away from
  // run.runProjectId, classify the outcome and persist the run on the
  // ORIGINAL project's record (NOT activeProjectId — that's the whole
  // point of the T2 immutability contract).
  function settleRunAfterNavigation(run, runResult) {
    if (activeProjectId === run.runProjectId) {
      // User is still on the project — normal settlement path; the caller
      // continues unchanged.
      return null;
    }
    // Welcome-panel + write-guard:
    // accept the full `syncOutcome` (not just a pre-flattened skipped list).
    // The previous shape — only `{ skipped: [...] }` from
    // `collectRunResultSkipped` — silently classified runs as
    // `background_completed` when (a) the skipped entries' codes were
    // outside a small allow-list (e.g. delete_confirmation_rejected,
    // governance_blocked, binary_confirmation_rejected) or (b) the
    // syncOutcome was an early-return branch with
    // `hasSkippedOperations === true` but no `applied` (which flattens to
    // an empty skipped list).
    //
    // Spec §5.7.1 classification:
    //   1. Any skipped entry with failure.code IN
    //      { 'aborted_project_changed', 'editor_project_id_unavailable' }
    //         → 'abandoned_after_navigation'.
    //   2. Else if syncOutcome.hasSkippedOperations === true OR any skipped
    //      entry exists (code-bearing or not)
    //         → 'needs_review_after_navigation'.
    //      (Spec defense-in-depth: when in doubt, claim needs_review rather
    //      than background_completed.)
    //   3. Else if at least one applied write AND no skipped/needs_review/
    //      failed entries AND post-write verification was clean
    //         → 'background_completed'.
    //   4. Else (no skipped, no applied) — true no-op run (e.g. Ask-mode
    //      where there was nothing to write) → 'background_completed'.
    const skipped = collectRunResultSkipped(runResult);
    const wasGuardAborted = skipped.some(entry => {
      const code = entry && entry.result && entry.result.code;
      return code === 'aborted_project_changed' || code === 'editor_project_id_unavailable';
    });
    if (wasGuardAborted) {
      return 'abandoned_after_navigation';
    }
    const hasSkippedOperations = runResult && runResult.hasSkippedOperations === true;
    if (hasSkippedOperations || skipped.length > 0) {
      // Rule 2: ANY skipped entry — code-bearing or not — and/or the
      // outcome flag — yields needs_review_after_navigation. This is the
      // defense-in-depth net for skip codes outside the recognized list
      // (delete_confirmation_rejected, governance_blocked,
      // binary_confirmation_rejected, etc.) and for early-return branches
      // where `applied` is absent but `hasSkippedOperations` is true.
      return 'needs_review_after_navigation';
    }
    // Rule 3 / 4: no skipped, no failed. Either at least one clean applied
    // write (post-write verification implicitly clean because rule 2
    // already caught write_observed_mismatch / accept_not_verified /
    // undo_not_verified / tracked_changes_remain via their skipped-entry
    // form), OR a true no-op run with nothing to write. Both classify as
    // background_completed per spec §5.7.1 rule 4.
    return 'background_completed';
  }

  // Flatten the `applied.skipped` arrays from a syncOutcome into the
  // shape `settleRunAfterNavigation` expects: `{ skipped: [{ result: { code } }] }`.
  // Accepts both shapes:
  //   1. The full syncOutcome from `applySyncChangesToOverleaf` — reads
  //      `syncOutcome.applied.skipped`.
  //   2. A pre-flattened shape `{ skipped: [...] }` — used by tests and by
  //      historical call sites.
  // Spec §5.7.1: settleRunAfterNavigation now consumes the full
  // syncOutcome directly, but this helper remains useful for the
  // applied-array path AND keeps the legacy test surface intact.
  function collectRunResultSkipped(syncOutcome) {
    if (!syncOutcome) {
      return [];
    }
    const skipped = [];
    const applied = syncOutcome.applied;
    if (applied && Array.isArray(applied.skipped)) {
      for (const entry of applied.skipped) {
        if (entry) {
          skipped.push(entry);
        }
      }
    }
    if (Array.isArray(syncOutcome.skipped)) {
      for (const entry of syncOutcome.skipped) {
        if (entry) {
          skipped.push(entry);
        }
      }
    }
    return skipped;
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
  async function persistPostNavigationRunStatus(run, postNavigationStatus) {
    if (!run || !postNavigationStatus) {
      return;
    }
    const postNavigationStatusText = getPostNavigationRunStatusText(postNavigationStatus);
    run.status = postNavigationStatus;
    run.statusText = postNavigationStatusText;
    run.finishedAt = run.finishedAt || new Date().toISOString();
    if (currentRunView && currentRunView.runProjectId === activeProjectId) {
      // Same project still active — the run record is reachable through the
      // normal state and the regular save path will persist it.
      saveStateSoon();
      return;
    }
    // Different project. Update the original session's run record directly.
    try {
      const StorageDb = window.CodexOverleafStorageDb;
      if (!StorageDb) {
        return;
      }
      const sessionId = currentRunView ? currentRunView.sessionId : '';
      if (!sessionId) {
        return;
      }
      const record = await StorageDb.getRecord('sessions', sessionId);
      if (!record) {
        return;
      }
      const runs = Array.isArray(record.runs) ? record.runs : [];
      const targetRun = runs.find(item => item && item.id === run.id);
      if (!targetRun) {
        return;
      }
      targetRun.status = postNavigationStatus;
      targetRun.statusText = postNavigationStatusText;
      targetRun.finishedAt = run.finishedAt;
      record.lastActivityAt = new Date().toISOString();
      record.updatedAt = record.lastActivityAt;
      await StorageDb.putRecord('sessions', record);
    } catch (_error) {
      // Settlement persistence is best-effort. The original project's
      // existing record still holds the run; the worst-case is that the
      // dashboard badge does not show the post-navigation reclassification
      // for this one run.
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
    // `window.CodexOverleafStorageDb` to assert layout / row behavior.
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
      appendCompletionReport({
        conclusion: notes || tx('This run only inspected and explained; no files were written.', '这轮只做了检查和说明，没有写入文件。'),
        status: tr('modeAsk'),
        notes,
        userReport: result.userReport,
        mode,
        operations: [],
        applyResults: [],
        nextStep: tx('Continue the conversation, or switch to Suggest/Auto to let Codex edit files.', '可以继续追问，或切换到建议修改/自动写入后让 Codex 修改文件。')
      });
      return { status: tr('modeAsk'), summaryLine };
    }

    if (result.status === 'requires_task_confirmation') {
      appendPlannedChangeSummary(result.summary, tx('Preparing changes', '准备修改'));
      const approved = await showPluginConfirm({
        title: tx('Apply these changes?', '应用这些修改？'),
        message: formatSummary(tx('Change Summary', '修改摘要'), result.summary),
        confirmLabel: tx('Apply changes', '应用修改'),
        cancelLabel: tr('confirmDefaultCancel')
      });
      if (!approved) {
        appendLog(tx('Cancelled: Codex did not write any files.', '已取消：Codex 没有写入任何文件。'));
        const summaryLine = appendChangeSummary({ notes, summary: result.summary, status: 'rejected' });
        appendCompletionReport({
          conclusion: tx('You cancelled this change. Codex did not write files.', '你取消了这轮修改，Codex 没有写入文件。'),
          status: 'rejected',
          notes,
          summary: result.summary,
          userReport: result.userReport,
          mode,
          operations: [],
          applyResults: [],
          nextStep: tx('Adjust the task and run again, or switch to Ask first so Codex can explain the plan.', '可以调整任务描述后重新运行，或切到只问不改先让 Codex 解释方案。')
        });
        return { status: 'rejected', summaryLine };
      }
      const confirmed = result.planId
        ? await sendNative({ method: 'task.confirm', params: { planId: result.planId } })
        : { ok: true, result: { operations: result.operations || [] } };
      if (!confirmed.ok) {
        appendLog(`Confirm failed: ${confirmed.error.message}`);
        const summaryLine = appendChangeSummary({ notes, operations: [], status: 'confirm failed' });
        appendCompletionReport({
          conclusion: tx('No writable changes were returned after confirmation.', '确认后没有拿到可写入的修改。'),
          status: 'confirm failed',
          notes,
          userReport: result.userReport,
          mode,
          operations: [],
          applyResults: [],
          nextStep: confirmed.error.message
        });
        return { status: 'confirm failed', summaryLine };
      }
      const operations = confirmed.result.operations || [];
      appendOperationsPreview(operations, tx('Confirmed; preparing to write', '用户已确认，准备写入'));
      const applied = await applyTaskOperations(project, operations, { allowHighRisk: true });
      appendApplyResult(applied);
      recordUndoFromApply(project, applied);
      const summaryLine = appendChangeSummary({
        notes,
        operations,
        applyResults: [applied],
        status: 'confirmed and applied'
      });
      appendCompletionReport({
        conclusion: notes || tx('Changes were written after your confirmation.', '已按你的确认写入修改。'),
        status: 'confirmed and applied',
        notes,
        userReport: result.userReport,
        mode,
        operations,
        applyResults: [applied]
      });
      return {
        status: 'confirmed and applied',
        summaryLine,
        hasSkippedOperations: hasSkippedApplyOperations([applied])
      };
    }

    if (result.status === 'delete_plan_required') {
      const operations = result.operations || [];
      const applyResults = [];
      appendOperationsPreview(operations, tx('Preparing to write non-delete changes first', '准备先写入非删除修改'));
      const applied = await applyTaskOperations(project, operations);
      applyResults.push(applied);
      appendApplyResult(applied);
      recordUndoFromApply(project, applied);
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
        recordUndoFromApply(project, deleteApplied);
        appendLog(tx('Deleted files after confirmation.', '已按确认删除文件。'));
        const summaryLine = appendChangeSummary({
          notes,
          operations: [...operations, ...pendingOperations],
          applyResults,
          status: 'applied with delete plan'
        });
        appendCompletionReport({
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
      appendCompletionReport({
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
    const applied = await applyTaskOperations(project, operations, { allowHighRisk: mode === 'confirm' });
    appendApplyResult(applied);
    recordUndoFromApply(project, applied);
    appendLog(mode === 'auto' ? tx('Auto write task completed.', '自动写入任务完成。') : tx('Task completed.', '任务完成。'));
    const summaryLine = appendChangeSummary({
      notes,
      operations,
      applyResults: [applied],
      status: result.status || 'completed'
    });
    appendCompletionReport({
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
    const runRequireReviewing = typeof options.requireReviewing === 'boolean'
      ? options.requireReviewing
      : state.requireReviewing === true;
    const partitioned = partitionOperationsForApply(operations, options);
    if (!partitioned.safe.length) {
      appendRunEvent({
        title: tr('undoNoWritesTitle'),
        status: 'completed'
      });
    } else {
      appendRunEvent({
        title: tx('Saved a recoverable version before this run writes.', '已保存本轮写入前的可恢复版本。'),
        status: 'completed',
        detail: {
          [tx('Files to write', '将写入的文件')]: formatOperationFiles(partitioned.safe)
        }
      });
    }
    const reviewing = await ensureReviewingBeforeWrite(partitioned.safe, { requireReviewing: runRequireReviewing });
    if (!reviewing.ok) {
      return buildReviewingBlockedApplyResult(partitioned.safe, reviewing, partitioned.skipped);
    }
    const applied = partitioned.safe.length
      ? await callPageBridge('applyOperations', {
        operations: partitioned.safe,
        baseFiles: project?.files || [],
        requireReviewing: runRequireReviewing,
        requireEditing: !runRequireReviewing,
        // Welcome-panel + write-guard:
        runProjectId: currentRunView?.runProjectId || ''
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
    const result = await callPageBridge(method, {
      waitMs: 1800,
      runProjectId: currentRunView?.runProjectId || ''
    });
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
            code: blockedByEditing ? 'editing_not_confirmed' : 'reviewing_not_enabled',
            reason: blockedByEditing
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
    const userInitiated = options.userInitiated === true;
    if (userInitiated) {
      setRefreshProbeLoading(true);
      const status = panel?.querySelector('[data-probe-status]');
      if (status) {
        status.textContent = tr('refreshProbeLoading');
        status.dataset.ok = 'false';
        status.dataset.refreshing = 'true';
      }
    }

    try {
      const probe = await callPageBridge('probe', {
        manualOverride: state?.requireReviewing === false
      });
      const status = panel?.querySelector('[data-probe-status]');
      if (status) {
        status.textContent = userInitiated
          ? tr('refreshProbeDone', { status: formatProbeStatusBar(probe) })
          : formatProbeStatusBar(probe);
        status.dataset.ok = isProbeReadyForCurrentMode(probe) ? 'true' : 'false';
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
      const status = panel?.querySelector('[data-probe-status]');
      if (status) {
        status.textContent = tr('refreshProbeFailed');
        status.dataset.ok = 'false';
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
  }

  function formatProbeStatusBar(probe) {
    const readiness = getProbeRunReadiness(probe);
    const reviewingOk = readiness.reviewingOk;
    const editorWritable = readiness.editorWritable;

    if (state?.mode === 'ask') {
      return appendOtStatusToProbeStatus(`${formatModeLabel('ask')} · ${readiness.contextLabel}`);
    }
    if (reviewingOk) {
      const status = editorWritable
        ? `${tr('canRun')} · ${readiness.contextLabel}`
        : `${formatModeLabel(state?.mode)} · ${tr('validatingEditor')}`;
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
    const text = String(status.textContent || '');
    if (!text) {
      return;
    }
    const base = text.split(' · OT ')[0];
    status.textContent = appendOtStatusToProbeStatus(base);
  }

  function isProbeReadyForCurrentMode(probe) {
    const readiness = getProbeRunReadiness(probe);
    return state?.mode === 'ask' || readiness.reviewingOk;
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
    if (mode === 'confirm') {
      return tr('modeConfirm');
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
      'confirm failed': tx('Confirmation failed', '确认失败'),
      'confirmed and applied': tx('Suggested changes applied', '已应用建议修改'),
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
        '@whole-project (default); add @file, @compile-log, or @current-section',
        '@whole-project（默认）；可添加 @file、@compile-log、@current-section'
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

  function updateExistingProbeNotice(probe) {
    if (currentRunView || !panel?.querySelector('[data-probe-notice]')) {
      return;
    }
    const { ready, message } = formatProbeUserNotice(probe);
    updateProbeNotice(ready ? '' : message);
  }

  function formatProbeUserNotice(probe) {
    const readiness = getProbeRunReadiness(probe);
    const reviewingOk = readiness.reviewingOk;
    const editorOk = readiness.editorOk;
    const manualOverride = probe.reviewing?.status === 'manual-override';
    const editorWriteBlocked = probe.capabilities?.editor?.write === false;

    if (state?.mode === 'ask') {
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
          `Ready: ${formatModeLabel(state?.mode)} is selected. This page has not exposed a writable editor yet; Codex will reopen and verify the target file when writing. If writeback fails, reload Overleaf and retry.`,
          `可以运行：已选择“${formatModeLabel(state?.mode)}”。当前页面暂时没有暴露可写编辑器，写入时会重新打开目标文件并验证；如果写回失败，再刷新 Overleaf 页面后重试。`
        )
      };
    }

    if (reviewingOk) {
      return {
        ready: true,
        message: manualOverride
          ? tx(
            `Ready: you confirmed Overleaf Track Changes is on. Codex ${readiness.contextLabel}.`,
            `可以运行：你已确认 Overleaf 已开启留痕，Codex ${readiness.contextLabel}。`
          )
          : tx(
            `Ready: Codex verified Overleaf Reviewing/Track Changes is on and ${readiness.contextLabel}.`,
            `可以运行：Codex 已确认 Overleaf Reviewing/Track Changes 已开启，并且${readiness.contextLabel}。`
          )
      };
    }

    if (readiness.contextReady) {
      return {
        ready: false,
        message: tx(
          `Not safe to write yet: Codex ${readiness.contextLabel}, but Overleaf Reviewing/Track Changes was not verified. Turn on Reviewing first, or disable Track below.`,
          `还不能安全写入：Codex ${readiness.contextLabel}，但没有确认 Overleaf 已开启 Reviewing/Track Changes。请先打开 Reviewing，或关闭下方的安全检查。`
        )
      };
    }

    return {
      ready: false,
      message: tx(
        'Not safe to write yet: turn on Overleaf Reviewing/Track Changes first. Codex will read the whole project at run time; you can also use @file to focus on specific files.',
        '还不能安全写入：请先在 Overleaf 打开 Reviewing/Track Changes；Codex 会在运行时读取整个项目，也可以用 @file 指定重点文件。'
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
    if (sanitizedProject?.capabilities?.fullProjectSnapshot) {
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
    if (!project || typeof project !== 'object') {
      return project;
    }
    const activePath = normalizeSnapshotPath(project.activePath || '');
    const files = Array.isArray(project.files) ? project.files : [];
    const filePathSet = new Set(files.map(file => normalizeSnapshotPath(file?.path || '')).filter(Boolean));
    const activePathKnown = activePath && filePathSet.has(activePath);
    if (!activePath || activePathKnown) {
      return project;
    }
    return {
      ...project,
      activePath: '',
      files: files.map(file => file?.active ? { ...file, active: false } : file),
      capabilities: {
        ...(project.capabilities || {}),
        diagnostics: {
          ...(project.capabilities?.diagnostics || {}),
          rejectedActivePath: project.activePath
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
    const mirrorHealth = window.CodexOverleafMirrorHealth.classifyMirrorHealth(mirrorStatus);
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
        window.CodexOverleafProjectFiles.isUsableProjectFileContent(file.content) &&
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
    return String(path || '')
      .replace(/^@file:/i, '')
      .replace(/\\/g, '/')
      .trim()
      .replace(/^\/+/, '');
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
    const files = project?.files || [];
    if (!files.length) {
      return tx(
        'No Overleaf project files were read yet. Make sure the project has loaded, or open a .tex file in Overleaf and retry.',
        '还没有读到 Overleaf 项目文件。请确认项目已加载完成，或在 Overleaf 点开一个 .tex 文件后重试。'
      );
    }

    const textCount = files.filter(isTextSnapshotFile).length;
    const binaryCount = files.length - textCount;
    const resourceText = binaryCount ? tx(`, ${binaryCount} asset file(s)`, `，${binaryCount} 个资源文件`) : '';
    const activePath = project.activePath ? tx(`, current file: ${project.activePath}`, `，当前文件：${project.activePath}`) : '';
    const focusFiles = getActiveFocusFiles();
    const focusText = focusFiles.length ? tx(`, focus: ${focusFiles.join(', ')}`, `，优先处理：${focusFiles.join(', ')}`) : '';
    return tx(
      `Read Overleaf project: ${textCount} text file(s)${resourceText}${activePath}${focusText}.`,
      `已读取 Overleaf 项目：${textCount} 个文本文件${resourceText}${activePath}${focusText}。`
    );
  }

  function formatProjectSnapshotFileSize(file) {
    if (isTextSnapshotFile(file)) {
      return `${String(file.content || '').length} chars`;
    }
    if (Number.isFinite(Number(file?.size))) {
      return `${Number(file.size)} bytes`;
    }
    return file?.contentBase64 ? `${String(file.contentBase64).length} base64` : 'binary';
  }

  function formatProjectSnapshotWarning(warning) {
    if (/No source files were captured/i.test(warning)) {
      return tx('No project source files were read. Make sure Overleaf has loaded, or open a .tex file and retry.', '没有读取到项目源文件。请确认 Overleaf 页面加载完成，或点开一个 .tex 文件后重试。');
    }
    if (/Full project snapshot was not captured/i.test(warning)) {
      return tx('The full Overleaf project was not read. To avoid refreshing the local workspace from an incomplete snapshot, reload Overleaf or retry later.', '没有读到完整的 Overleaf 项目。为了避免本地 workspace 用残缺快照覆盖项目，请刷新 Overleaf 或稍后重试。');
    }
    if (/empty or still loading/i.test(warning)) {
      return tx('Some file content is still loading. Wait for Overleaf to finish loading, then retry.', '读取到的文件内容还在加载中。请等 Overleaf 加载完成后重试。');
    }
    if (/suspiciously short|shorter than 80 characters/i.test(warning)) {
      return tx('Some file content is very short and may not have fully loaded. Results may be incomplete.', '部分文件内容很短，可能还没完全加载。结果可能不完整。');
    }
    if (/identical captured content/i.test(warning)) {
      return tx('Several files appear to have identical captured content, so Overleaf file switching may have failed. Reload and retry.', '多个文件内容看起来相同，Overleaf 文件切换可能没有成功。请刷新页面后重试。');
    }
    if (/were skipped/i.test(warning)) {
      return tx('Some project files were skipped, usually images, PDFs, or unreadable files.', '有些项目文件被跳过，通常是图片、PDF 或无法读取的文件。');
    }
    return warning;
  }

  function appendEditorDiagnostics(editorDiagnostics, projectDiagnostics) {
    if (editorDiagnostics) {
      const active = editorDiagnostics.active;
      appendLog(`Editor probe: active ${active?.tag || 'none'} ${active?.ariaLabel || active?.className || ''} len=${active?.valueLength || 0}; textareas=${editorDiagnostics.textareaCount || 0}; editables=${editorDiagnostics.editableCount || 0}; iframes=${editorDiagnostics.iframeCount || 0}.`);
      if (editorDiagnostics.documentStats) {
        const stats = editorDiagnostics.documentStats;
        appendLog(`DOM stats: elements=${stats.elementCount || 0}; textareas=${stats.textareaCount || 0}; cm=${stats.cmCount || 0}; role textbox=${stats.roleTextboxCount || 0}.`);
      }
      if (editorDiagnostics.unstableStore) {
        const store = editorDiagnostics.unstableStore;
        const readable = (store.readable || [])
          .map(item => `${item.path}:${item.present ? item.type : 'missing'}`)
          .join(', ');
        appendLog(`Overleaf store: ${store.present ? 'present' : 'missing'}${readable ? `; ${readable}` : ''}.`);
      }
      if (editorDiagnostics.codeMirrorView) {
        const view = editorDiagnostics.codeMirrorView;
        appendLog(`CodeMirror view: docLength=${view.docLength || 0}; dispatch=${Boolean(view.hasDispatch)}; source=${view.source || 'unknown'}.`);
      }
      if (editorDiagnostics.globals) {
        const globals = editorDiagnostics.globals;
        appendLog(`Overleaf globals: overleaf=${globals.overleaf || 'missing'}; Overleaf=${globals.Overleaf || 'missing'}; _ide=${globals._ide || 'missing'}.`);
      }
      for (const item of [...(editorDiagnostics.textareas || []), ...(editorDiagnostics.editables || [])].slice(0, 3)) {
        appendLog(`Editor candidate: ${item.tag || 'node'} ${item.ariaLabel || item.className || item.id || ''} len=${item.valueLength || 0}.`);
      }
    }
    if (projectDiagnostics) {
      const records = projectDiagnostics.docRecords || [];
      appendLog(`Project probe: doc records=${projectDiagnostics.docRecordCount || 0}; roots=${(projectDiagnostics.internalRootKeys || []).slice(0, 6).join(', ') || 'none'}.`);
      for (const record of records.slice(0, 4)) {
        appendLog(`Doc record: ${record.path} id=${record.id} source=${record.source || 'internal'}.`);
      }
    }
  }

  function appendProjectWarnings(project) {
    const warnings = getProjectSnapshotWarnings(project);
    for (const warning of warnings.blocking) {
      appendLog(`Snapshot blocked: ${warning}`);
    }
    for (const warning of warnings.nonBlocking) {
      appendLog(`Snapshot warning: ${warning}`);
    }
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

    const unusable = textFiles.filter(file => !window.CodexOverleafProjectFiles.isUsableProjectFileContent(file.content));
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
    return Boolean(file && file.kind !== 'binary' && typeof file.content === 'string');
  }

  function uniqueContentSignatures(files) {
    const signatures = files.map(file => {
      const content = String(file.content || '');
      return `${content.length}:${content.slice(0, 120)}:${content.slice(-120)}`;
    });
    return Array.from(new Set(signatures));
  }

  function appendReviewingDiagnostics(diagnostics) {
    if (!diagnostics) {
      appendLog(tx('Probe diagnostics unavailable.', '诊断探针不可用。'));
      return;
    }

    appendLog(`Probe saw ${diagnostics.controlCount || 0} controls; body Reviewing=${Boolean(diagnostics.bodyTextHasReviewing)}, text Reviewing=${Boolean(diagnostics.textContentHasReviewing)}.`);
    const controls = diagnostics.reviewLikeControls || [];
    if (!controls.length) {
      appendLog('Probe did not see review/track/suggest controls in the page DOM.');
      return;
    }

    for (const control of controls.slice(0, 4)) {
      const label = [
        control.text,
        control.ariaLabel && `aria:${control.ariaLabel}`,
        control.title && `title:${control.title}`,
        control.dataTestId && `test:${control.dataTestId}`,
        control.id && `id:${control.id}`
      ].filter(Boolean).join(' | ');
      appendLog(`Review-like ${control.tag || 'node'}: ${label || control.htmlSnippet || '(no label)'}`);
    }
  }

  function sendNative(payload) {
    return (async () => {
      const compatibilityGate = await ensureNativeCompatibilityForMethod(payload?.method);
      if (!compatibilityGate.ok) {
        return compatibilityGate.response;
      }
      throwIfCancelledBeforeNativeDispatch(payload?.method);
      return nativeChannel.sendNative(attachNativeCompatibilityEvidence(payload, compatibilityGate.compatibility));
    })();
  }

  function sendBackgroundNative(payload) {
    return (async () => {
      const compatibilityGate = await ensureNativeCompatibilityForMethod(payload?.method);
      if (!compatibilityGate.ok) {
        return compatibilityGate.response;
      }
      throwIfCancelledBeforeNativeDispatch(payload?.method);
      return nativeChannel.sendBackgroundNative(attachNativeCompatibilityEvidence(payload, compatibilityGate.compatibility));
    })();
  }

  function throwIfCancelledBeforeNativeDispatch(method) {
    if (NATIVE_COMPATIBILITY_GATED_METHODS.has(method)) {
      throwIfRunCancellationRequested();
    }
  }

  async function ensureNativeCompatibilityForMethod(method) {
    const params = CodexOverleafCompatibility?.buildBridgePingParams
      ? CodexOverleafCompatibility.buildBridgePingParams(getExtensionCompatibilityMetadata())
      : {};
    const response = await nativeChannel.sendBackgroundNative({
      method: 'bridge.ping',
      params
    });
    const compatibility = CodexOverleafCompatibility?.evaluateNativeCompatibility
      ? CodexOverleafCompatibility.evaluateNativeCompatibility(response, getExtensionCompatibilityMetadata())
      : fallbackNativeCompatibility(response);
    const allowed = !NATIVE_COMPATIBILITY_GATED_METHODS.has(method) ||
      (CodexOverleafCompatibility?.isNativeMethodAllowed
        ? CodexOverleafCompatibility.isNativeMethodAllowed(method, compatibility)
        : compatibility.status === 'ok');
    if (allowed) {
      return { ok: true, compatibility };
    }

    const message = formatNativeCompatibilityBlockedMessage(method, compatibility);
    const error = {
      code: 'native_update_required',
      message,
      status: compatibility.status || 'unknown_native',
      classification: getNativeCompatibilityClassification(compatibility),
      installCommand: compatibility.installCommand || INSTALL_COMMAND,
      updateCommand: compatibility.updateCommand || compatibility.installCommand || INSTALL_COMMAND,
      currentNativeVersion: compatibility.currentNativeVersion || compatibility.nativeVersion || compatibility.native?.version || '',
      requiredVersion: compatibility.requiredVersion || CodexOverleafCompatibility?.BUILD_TARGET_VERSION || '',
      releaseUrl: compatibility.releaseUrl || ''
    };
    notifyNativeCompatibilityBlocked(error, compatibility);
    return {
      ok: false,
      compatibility,
      response: {
        ok: false,
        error
      }
    };
  }

  function attachNativeCompatibilityEvidence(payload = {}, compatibility) {
    if (!compatibility || !NATIVE_COMPATIBILITY_GATED_METHODS.has(payload?.method)) {
      return payload;
    }
    return {
      ...payload,
      params: {
        ...(payload.params || {}),
        nativeCompatibility: compatibility
      }
    };
  }

  function notifyNativeCompatibilityBlocked(error, compatibility = {}) {
    const message = error?.message || String(error || '');
    if (currentRunView) {
      appendRunEvent({
        title: message,
        status: 'failed'
      });
      showNativeUpdateGuidanceModal(compatibility);
    } else {
      showNativeUpdateGuidanceModal(compatibility);
      showPluginToast(message, { status: 'failed', sticky: true });
    }
  }

  async function refreshNativeCompatibilityBadge() {
    if (!panelRendererInstance?.headerEl || !CodexOverleafCompatibility?.evaluateNativeCompatibility) {
      return;
    }
    try {
      const params = CodexOverleafCompatibility.buildBridgePingParams
        ? CodexOverleafCompatibility.buildBridgePingParams(getExtensionCompatibilityMetadata())
        : {};
      const response = await sendBackgroundNative({ method: 'bridge.ping', params });
      const compatibility = CodexOverleafCompatibility.evaluateNativeCompatibility(response, getExtensionCompatibilityMetadata());
      const classification = getNativeCompatibilityClassification(compatibility);
      if (classification === 'compatible') {
        PanelRenderer.setBadge(panelRendererInstance.headerEl, { type: 'none' });
        setDiagnosticsHealth('ok');
        try {
          window.localStorage.setItem('codexOverleafNativeEverOk', 'true');
        } catch (_storageError) { /* private mode etc.; the wizard just stays eligible */ }
        return;
      }
      // update-available reads as attention; anything else (incompatible /
      // unsupported) reads as a hard problem on the diagnostics dot.
      setDiagnosticsHealth(classification === 'update-available' ? 'warn' : 'fail');
      PanelRenderer.setBadge(panelRendererInstance.headerEl, {
        type: 'update',
        tooltip: tx('Native host update available', 'Native host 可更新'),
        onClick: () => showNativeUpdateGuidanceModal(compatibility)
      });
      // A never-installed host does NOT throw: background resolves
      // {ok:false, native_connection_failed} and classification lands here.
      if (!compatibility?.native?.version) {
        maybePromptFirstRunSetup();
      }
    } catch (_error) {
      setDiagnosticsHealth('fail');
      // No ping response at all means the native host is missing or not
      // running — telling a never-installed user an "update" exists is
      // misleading; point them at setup instead.
      PanelRenderer.setBadge(panelRendererInstance.headerEl, {
        type: 'update',
        tooltip: tx('Native host is not responding — click for setup steps', 'Native host 未响应——点击查看安装步骤'),
        onClick: () => showNativeUpdateGuidanceModal(fallbackNativeCompatibility({ ok: false }))
      });
      maybePromptFirstRunSetup();
    }
  }

  // First-run wizard (v1.7): the native host is the one hard prerequisite,
  // and pre-1.7 its absence was a 9px red dot. Auto-open the install guidance
  // ONCE per browser profile; the flag is set before showing so a dismissal
  // is respected forever (no nag loop).
  function maybePromptFirstRunSetup() {
    let storage = null;
    try {
      storage = window.localStorage;
      if (!storage || storage.getItem('codexOverleafSetupPromptShown') === 'true') {
        return;
      }
      // A profile that ever completed a successful ping is an installed user
      // having a transient outage, not a first run — never auto-modal them.
      if (storage.getItem('codexOverleafNativeEverOk') === 'true') {
        return;
      }
      storage.setItem('codexOverleafSetupPromptShown', 'true');
    } catch (_storageError) {
      return;
    }
    showNativeUpdateGuidanceModal(fallbackNativeCompatibility({ ok: false }));
  }

  function showNativeUpdateGuidanceModal(compatibility = {}) {
    if (!panel) {
      ensurePanelOpen();
    }
    const existing = panel.querySelector('[data-native-update-guidance]');
    existing?.remove();

    const native = compatibility.native || {};
    const extensionVersion = compatibility.extensionVersion || CodexOverleafCompatibility?.BUILD_TARGET_VERSION || '';
    const nativeVersion = compatibility.currentNativeVersion || compatibility.nativeVersion || native.version || tx('missing', '未安装');
    const command = compatibility.updateCommand || compatibility.installCommand || INSTALL_COMMAND;
    const releaseUrl = compatibility.releaseUrl || '';

    const overlay = document.createElement('div');
    overlay.className = 'codex-plugin-confirm';
    overlay.dataset.nativeUpdateGuidance = 'true';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const nativeMissing = !native.version;
    overlay.setAttribute('aria-label', nativeMissing
      ? tx('Set up the native host', '安装 Native host')
      : tx('Native host update available', 'Native host 可更新'));

    const card = document.createElement('section');
    card.className = 'codex-plugin-confirm-card';

    const title = document.createElement('div');
    title.className = 'codex-plugin-confirm-title';
    title.textContent = nativeMissing
      ? tx('One step left: install the native host', '还差一步：安装 Native host')
      : tx('Native host update available', 'Native host 可更新');

    const body = document.createElement('div');
    body.className = 'codex-plugin-confirm-body';
    body.textContent = [
      nativeMissing
        ? tx(`Extension v${extensionVersion} is ready; Codex still needs its local bridge to read and edit this project.`, `扩展 v${extensionVersion} 已就绪；Codex 还需要本地桥接程序才能读写这个项目。`)
        : tx(`Extension v${extensionVersion} / Native v${nativeVersion}`, `扩展 v${extensionVersion} / Native v${nativeVersion}`),
      tx('Run the platform-specific command below, reload the extension, then refresh Overleaf.', '运行下面的平台命令，重新加载扩展，然后刷新 Overleaf。')
    ].join('\n\n');

    const commandCode = document.createElement('code');
    commandCode.textContent = command;
    commandCode.style.display = 'block';
    commandCode.style.whiteSpace = 'pre-wrap';
    commandCode.style.marginTop = '0.75rem';
    body.append(commandCode);

    if (releaseUrl) {
      const link = document.createElement('a');
      link.href = releaseUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = tx('Open GitHub Release', '打开 GitHub Release');
      link.style.display = 'block';
      link.style.marginTop = '0.75rem';
      body.append(link);
    }

    const actions = document.createElement('div');
    actions.className = 'codex-plugin-confirm-actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'codex-plugin-confirm-confirm';
    copy.textContent = tx('Copy command', '复制命令');
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(command);
      copy.textContent = tx('Copied', '已复制');
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'codex-plugin-confirm-cancel';
    close.textContent = tx('Close', '关闭');
    close.addEventListener('click', () => overlay.remove());
    actions.append(close, copy);

    card.append(title, body, actions);
    overlay.append(card);
    overlay.addEventListener('click', event => {
      if (event.target === overlay) {
        overlay.remove();
      }
    });
    panel.append(overlay);
    copy.focus();
  }

  function scheduleFirstUseOnboardingTip() {
    setTimeout(() => {
      maybeShowFirstUseOnboardingTip().catch(() => {});
    }, 250);
  }

  async function maybeShowFirstUseOnboardingTip() {
    if (!panel || (state?.sessions || []).length > 0) {
      return;
    }
    const stored = await chrome.storage.local.get([ONBOARDING_TIP_STORAGE_KEY]);
    if (stored?.[ONBOARDING_TIP_STORAGE_KEY]) {
      return;
    }
    const modeSelect = panel.querySelector('[data-mode]');
    if (!modeSelect) {
      return;
    }
    const tip = document.createElement('div');
    tip.className = 'codex-onboarding-tip';
    tip.dataset.onboardingTip = 'true';
    tip.setAttribute('role', 'status');
    tip.textContent = tx(
      'Tip: Start with Ask mode to explore safely. Switch to Suggest to review edits before applying.',
      '提示：先用 Ask 模式安全探索；需要修改时切到 Suggest，应用前可先审阅。'
    );
    Object.assign(tip.style, {
      position: 'absolute',
      zIndex: '2147483647',
      maxWidth: '280px'
    });
    panel.append(tip);
    const panelRect = panel.getBoundingClientRect();
    const modeRect = modeSelect.getBoundingClientRect();
    tip.style.left = `${Math.max(12, modeRect.left - panelRect.left)}px`;
    tip.style.bottom = `${Math.max(72, panelRect.bottom - modeRect.top + 8)}px`;

    const dismiss = () => {
      tip.remove();
      chrome.storage.local.set({ [ONBOARDING_TIP_STORAGE_KEY]: true }).catch?.(() => {});
      panel.removeEventListener('click', dismiss, true);
      panel.removeEventListener('keydown', dismiss, true);
    };
    panel.addEventListener('click', dismiss, true);
    panel.addEventListener('keydown', dismiss, true);
    setTimeout(dismiss, 8000);
  }

  function formatNativeCompatibilityBlockedMessage(method, compatibility = {}) {
    const statusValue = compatibility.status || 'unknown_native';
    const params = { method: method || 'native request' };
    switch (statusValue) {
      case 'native_too_old':
        return tr('nativeCompatibilityBlockedNativeTooOld', params);
      case 'extension_too_old':
        return tr('nativeCompatibilityBlockedExtensionTooOld', params);
      case 'protocol_unsupported':
        return tr('nativeCompatibilityBlockedProtocol', params);
      case 'native_unhealthy':
        return tr('nativeCompatibilityBlockedUnhealthy', params);
      case 'native_missing':
        return tr('nativeCompatibilityBlockedMissing', params);
      default:
        return tr('nativeCompatibilityBlockedGeneric', params);
    }
  }

  async function callPageBridge(method, params) {
    try {
      await pageBridgeReady;
    } catch (error) {
      return {
        ok: false,
        error: `Page bridge unavailable: ${error.message}`
      };
    }
    const timeoutMs = getPageBridgeTimeoutMs(method);
    return sendPageBridgeRequest(method, params, {
      timeoutMs
    });
  }

  function sendPageBridgeRequest(method, params, options = {}) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 8000;
      const cancellable = CANCELLABLE_PAGE_BRIDGE_METHODS.has(method);
      let settled = false;
      let timeout = null;

      function cleanup() {
        if (timeout !== null) {
          window.clearTimeout(timeout);
        }
        window.removeEventListener('message', onMessage);
        if (cancellable) {
          activePageBridgeCancellationHandlers.delete(id);
        }
      }

      function resolveOnce(value) {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      }

      function rejectOnce(error) {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      }

      function cancelRequest() {
        const error = new Error('Codex run was cancelled by the user');
        error.code = 'codex_cancelled';
        error.cancelled = true;
        rejectOnce(error);
      }

      timeout = window.setTimeout(() => {
        resolveOnce({ ok: false, error: 'Page bridge timed out' });
      }, timeoutMs);

      function onMessage(event) {
        if (event.source !== window
          || event.origin !== window.location.origin
          || event.data?.source !== 'codex-overleaf/page'
          || event.data?.pageBridgeVersion !== CodexOverleafCompatibility?.BUILD_TARGET_VERSION
          || event.data?.pageBridgeRevision !== PAGE_BRIDGE_SCRIPT_REVISION
          || event.data.id !== id) {
          return;
        }
        resolveOnce(event.data.result);
      }

      if (cancellable) {
        activePageBridgeCancellationHandlers.set(id, cancelRequest);
        if (runCancellationRequested) {
          window.queueMicrotask(cancelRequest);
        }
      }

      window.addEventListener('message', onMessage);
      // This capability narrows accidental/spoofed page-bridge calls. It is not
      // a secret from malicious same-page Overleaf scripts because postMessage
      // traffic is page-visible.
      window.postMessage({
        source: 'codex-overleaf/content',
        id,
        method,
        params,
        capability: PAGE_BRIDGE_CAPABILITY
      }, window.location.origin);
    });
  }

  function getPageBridgeTimeoutMs(method) {
    if (method === 'getProjectSnapshot') {
      return SNAPSHOT_PAGE_BRIDGE_TIMEOUT_MS;
    }
    if (method === 'getProjectFileList') {
      return CONTEXT_FILE_LIST_PAGE_BRIDGE_TIMEOUT_MS;
    }
    if (method === 'triggerCompile' || method === 'getCompileLog') {
      return COMPILE_PAGE_BRIDGE_TIMEOUT_MS;
    }
    if (method === 'rejectTrackedChanges' || method === 'acceptTrackedChanges') {
      return 120000;
    }
    if (method === 'applyOperations') {
      // Each per-op step inside writebackRouter.applyOperationsCore can wait
      // up to 5s for openFileByPath (treeOperations.js:230, :259) plus up to
      // 5s for waitForActiveEditorText plus reviewing/save-state polling.
      // A multi-op write on a freshly-loaded Overleaf editor can run 15-30s
      // in the wild. The pre-fix default of 8000ms timed out mid-write and
      // left the page-side promise running uncontrolled — a 'zombie' write
      // could still land after the content-side reported failure. 30s is a
      // sane upper bound that covers the realistic slow path without
      // letting a genuinely hung dispatch tie up the UI indefinitely.
      return 30000;
    }
    return 8000;
  }

  async function injectPageBridge() {
    await injectScriptOnce('src/shared/reviewing.js', 'codex-overleaf-reviewing-script');
    await injectScriptOnce('src/shared/projectFiles.js', 'codex-overleaf-project-files-script');
    await injectScriptOnce('src/shared/compatibility.js', 'codex-overleaf-compatibility-page-script');
    await injectScriptOnce('src/shared/staleGuard.js', 'codex-overleaf-stale-guard-script');
    await injectScriptOnce('src/shared/compileAdapter.js', 'codex-overleaf-compile-adapter-script');
    await injectScriptOnce('src/shared/governanceRules.js', 'codex-overleaf-governance-rules-script');
    await injectScriptOnce('src/shared/sensitiveScan.js', 'codex-overleaf-sensitive-scan-script');
    await injectScriptOnce('src/shared/auditRecords.js', 'codex-overleaf-audit-records-script');
    await injectScriptOnce('src/page/overleafCapabilities.js', 'codex-overleaf-capabilities-script');
    await injectScriptOnce('src/page/compileBridge.js', 'codex-overleaf-compile-bridge-script');
    await injectScriptOnce('src/page/overleafEditor.js', 'codex-overleaf-editor-script');
    await injectScriptOnce('src/page/overleafProjectSnapshot.js', 'codex-overleaf-project-snapshot-script');
    await injectOptionalOtDependencies();
    await injectScriptOnce('src/page/pageBridgeCapability.js', 'codex-overleaf-page-bridge-capability-script');
    await injectScriptOnce('src/page/treeOperations.js', 'codex-overleaf-tree-operations-script', { force: true });
    await injectScriptOnce('src/page/snapshotRouter.js', 'codex-overleaf-snapshot-router-script');
    await injectScriptOnce('src/page/writeGuard.js', 'codex-overleaf-write-guard-script', { force: true });
    // Phase 7 (v1.8.0): the tracked-changes lifecycle must be defined in the
    // page world BEFORE writebackRouter.create() dereferences it — the vm
    // test harnesses inject it manually, so only this list proves it loads.
    await injectScriptOnce('src/page/trackedChangesLifecycle.js', 'codex-overleaf-tracked-changes-lifecycle-script', { force: true });
    await injectScriptOnce('src/page/writebackRouter.js', 'codex-overleaf-writeback-router-script', { force: true });
    await injectScriptOnce('src/pageBridge.js', 'codex-overleaf-page-bridge-script', { force: true });
    await initializePageBridgeCapability();
  }

  async function injectOptionalOtDependencies() {
    try {
      await injectScriptOnce('src/shared/otText.js', 'codex-overleaf-ot-text-script');
      await injectScriptOnce('src/page/overleafRealtimeObserver.js', 'codex-overleaf-realtime-observer-script');
    } catch (_error) {
      // The page bridge has a read-only unavailable fallback for these optional OT helpers.
    }
  }

  function injectScriptOnce(src, id, options = {}) {
    return new Promise((resolve, reject) => {
      const existing = document.getElementById(id);
      if (existing && options.force !== true) {
        resolve();
        return;
      }
      existing?.remove?.();
      const script = document.createElement('script');
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out loading ${src}`));
      }, 8000);
      function cleanup() {
        window.clearTimeout(timeout);
        script.onload = null;
        script.onerror = null;
        script.remove();
      }
      script.id = id;
      const runtimePrefix = String(root.__CODEX_OVERLEAF_RUNTIME_PREFIX__ || '');
      script.src = chrome.runtime.getURL(runtimePrefix + src);
      script.onload = () => {
        cleanup();
        resolve();
      };
      script.onerror = () => {
        cleanup();
        reject(new Error(`Failed to load ${src}`));
      };
      (document.head || document.documentElement).append(script);
    });
  }

  async function initializePageBridgeCapability() {
    const result = await sendPageBridgeRequest('initializeCapability', {}, {
      timeoutMs: 8000
    });
    if (!result?.ok) {
      throw new Error(result?.error || result?.reason || 'Page bridge capability initialization failed');
    }
  }

  function createPageBridgeCapability() {
    if (crypto?.randomUUID) {
      return crypto.randomUUID();
    }
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function loadStoredState() {
    try {
      const StorageDb = window.CodexOverleafStorageDb;
      const Migration = window.CodexOverleafStorageMigration;
      const projectId = getCurrentProjectId();
      const legacyKey = storageKey;

      const { prefs, sessions, activeSessionId } = await Migration.runMigrationIfNeeded(projectId, legacyKey);

      return {
        model: prefs.model || '',
        reasoningEffort: prefs.reasoningEffort || '',
        speedTier: prefs.speedTier || '',
        mode: prefs.mode || '',
        locale: prefs.locale || '',
        requireReviewing: prefs.requireReviewing !== false,
        autoRecompile: prefs.autoRecompile !== false,
        loadCodexLocalSkills: prefs.loadCodexLocalSkills !== false,
        loadCodexOverleafSkills: prefs.loadCodexOverleafSkills !== false,
        codexOverleafSkillEnabled: prefs.codexOverleafSkillEnabled || {},
        experimentalOtByProject: prefs.experimentalOtByProject || {},
        customInstructionsByProject: prefs.customInstructionsByProject || {},
        governanceRulesByProject: normalizeGovernanceRulesByProject(prefs.governanceRulesByProject),
        panelWidth: prefs.panelWidth || PANEL_DEFAULT_WIDTH,
        sessions: sessions.map(session => ({
          id: session.id,
          title: session.title || '',
          titleSource: session.titleSource || 'auto',
          focusFiles: session.focusFiles || [],
          codexThreadId: session.codexThreadId || '',
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          runs: Array.isArray(session.runs) ? session.runs : [],
          history: Array.isArray(session.history) ? session.history : [],
          task: typeof session.task === 'string' ? session.task : '',
          mode: session.mode || prefs.mode || 'confirm',
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
      // Fallback to legacy loading if IndexedDB fails
      const keys = storageKey === LEGACY_STORAGE_KEY
        ? [LEGACY_STORAGE_KEY]
        : [storageKey, LEGACY_STORAGE_KEY];
      const stored = await chrome.storage.local.get(keys);
      const fallback = stored[storageKey] || stored[LEGACY_STORAGE_KEY] || {};
      if (fallback?.__codexOverleafCompactFallback === true) {
        return {
          mode: fallback.mode || '',
          model: fallback.model || '',
          reasoningEffort: fallback.reasoningEffort || '',
          speedTier: fallback.speedTier || '',
          locale: fallback.locale || '',
          requireReviewing: fallback.requireReviewing !== false,
          autoOpen: fallback.autoOpen !== false,
          loadCodexLocalSkills: fallback.loadCodexLocalSkills !== false,
          loadCodexOverleafSkills: fallback.loadCodexOverleafSkills !== false,
          codexOverleafSkillEnabled: fallback.codexOverleafSkillEnabled || {},
          experimentalOtByProject: fallback.experimentalOtByProject || {},
          customInstructionsByProject: fallback.customInstructionsByProject || {},
          governanceRulesByProject: normalizeGovernanceRulesByProject(fallback.governanceRulesByProject),
          panelWidth: fallback.panelWidth || PANEL_DEFAULT_WIDTH,
          sessions: [],
          activeSessionId: '',
          runs: []
        };
      }
      return fallback;
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
    try {
      const StorageDb = window.CodexOverleafStorageDb;
      const Migration = window.CodexOverleafStorageMigration;
      // Welcome-panel + write-guard:
      // post-navigation persistence gate. The normal URL-derived projectId
      // belongs to the route the user is *currently looking at*. When a run
      // is in flight on a different project (mid-run SPA navigation), saving
      // under that URL-derived id would pollute another project's Recent-
      // projects entry and surface bogus disabled rows. Two safety lanes:
      //   1. `options.projectIdOverride` lets a caller that legitimately
      //      needs to persist to a non-active project supply the projectId
      //      explicitly (the only such caller today is the post-navigation
      //      settlement path in `persistPostNavigationRunStatus`, which goes
      //      directly through StorageDb — but the override is in place so
      //      future callers do not have to monkey-patch around saveState).
      //   2. When no override is set AND a navigation-divergent run is in
      //      flight (currentRunView.runProjectId !== URL-derived id), log a
      //      warning and skip persistence. The settlement path owns that
      //      run's persistence; routing through saveState would write to the
      //      WRONG projectId record.
      const projectIdOverride = options && typeof options.projectIdOverride === 'string'
        ? options.projectIdOverride
        : '';
      const urlProjectId = getCurrentProjectId();
      const projectId = projectIdOverride || urlProjectId;
      if (!projectId) {
        return;
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
        return;
      }
      const compactState = prepareStateForStorage(state, { onAggressive: notifyAggressiveCompactionOnce });
      compactState.autoRecompile = state.autoRecompile;
      compactState.loadCodexLocalSkills = state.loadCodexLocalSkills !== false;
      compactState.loadCodexOverleafSkills = state.loadCodexOverleafSkills !== false;
      compactState.codexOverleafSkillEnabled = getCodexOverleafSkillEnabled();
      compactState.experimentalOtByProject = state.experimentalOtByProject;
      compactState.customInstructionsByProject = state.customInstructionsByProject;
      compactState.governanceRulesByProject = state.governanceRulesByProject;

      // Save lightweight prefs to chrome.storage.local
      const latestPrefs = typeof Migration.loadPrefs === 'function'
        ? await Migration.loadPrefs()
        : {};
      const prefsFromState = StorageDb.extractLightweightPrefs(compactState, projectId);
      const prefs = {
        ...(latestPrefs && typeof latestPrefs === 'object' ? latestPrefs : {}),
        ...prefsFromState
      };
      prefs.activeSessionByProject = StorageDb.buildActiveSessionByProject(
        latestPrefs?.activeSessionByProject || {},
        projectId,
        compactState.activeSessionId || state.activeSessionId || ''
      );
      prefs.experimentalOtByProject = {
        ...(latestPrefs?.experimentalOtByProject || {}),
        [projectId]: normalizeExperimentalOtByProject(state?.experimentalOtByProject)[projectId] === true
      };
      const normalizedGovernanceByProject = typeof normalizeGovernanceRulesByProject === 'function'
        ? normalizeGovernanceRulesByProject(state?.governanceRulesByProject)
        : (state?.governanceRulesByProject || {});
      prefs.governanceRulesByProject = {
        ...(latestPrefs?.governanceRulesByProject || {}),
        ...normalizedGovernanceByProject
      };
      const normalizedCustomProject = normalizeCustomInstructionsByProject({ [projectId]: '' });
      const normalizedCustomProjectId = Object.keys(normalizedCustomProject)[0] || '';
      const currentCustomInstructions = normalizeCustomInstructionsByProject(state?.customInstructionsByProject);
      prefs.customInstructionsByProject = {
        ...(latestPrefs?.customInstructionsByProject || {})
      };
      if (normalizedCustomProjectId) {
        prefs.customInstructionsByProject[normalizedCustomProjectId] =
          Object.prototype.hasOwnProperty.call(currentCustomInstructions, normalizedCustomProjectId)
            ? currentCustomInstructions[normalizedCustomProjectId]
            : '';
      }
      await Migration.savePrefs(prefs);

      // Save all displayable session state to IndexedDB. The panel history lives here;
      // chrome.storage.local only keeps small pointers/preferences.
      const sessionRecords = (state.sessions || []).map(session => (
        StorageDb.buildSessionRecord({
          ...session,
          projectId,
          title: session.title || '',
          titleSource: session.titleSource || 'auto',
          codexThreadId: session.codexThreadId || '',
          status: 'active',
          focusFiles: Array.isArray(session.focusFiles) ? session.focusFiles : [],
          createdAt: session.createdAt,
          updatedAt: session.updatedAt
        })
      ));
      if (sessionRecords.length) {
        await StorageDb.putRecords('sessions', sessionRecords);
      }
      const keepSessionIds = new Set(sessionRecords.map(record => record.id));
      const existingSessions = await StorageDb.getAllByIndex('sessions', 'projectId', projectId);
      await Promise.all(existingSessions
        .filter(session => session?.id && !keepSessionIds.has(session.id))
        .map(session => StorageDb.deleteRecord('sessions', session.id)));
    } catch (error) {
      // Fallback: try legacy save
      try {
        await chrome.storage.local.set({ [storageKey]: prepareCompactFallbackState(state) });
      } catch (fallbackError) {
        // Structured FailureReason §9.8: persistence raised a quota error.
        // Surface a `storage_quota_exceeded` failure (warning, retryable)
        // alongside the legacy toast notice so downstream renderers and tests
        // can detect the quota-specific class. The structured emit fires for
        // both the original `error` (primary IndexedDB write) and the
        // `fallbackError` (chrome.storage.local fallback).
        const quotaHit = isStorageQuotaError(error) || isStorageQuotaError(fallbackError);
        if (quotaHit) {
          emitStorageQuotaFailure(error, fallbackError);
        }
        if (typeof appendStorageNoticeOnce === 'function') {
          appendStorageNoticeOnce('save-failed', tx(`Failed to save session state: ${error.message}`, `保存会话状态失败：${error.message}`));
        } else {
          throw fallbackError;
        }
      }
    }
  }


  function prepareCompactFallbackState(inputState) {
    const compact = prepareStateForStorage(inputState);
    return {
      ...compact,
      __codexOverleafCompactFallback: true,
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

  function saveStateSoon(delayMs = 120) {
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

  function runQueuedSaveState() {
    saveStateInFlight = true;
    saveStateRunAfterFlight = false;
    saveState()
      .catch(error => {
        if (isStorageQuotaError(error)) {
          // Structured FailureReason §9.8: timer-driven saveState raised a
          // quota error. saveState's own catch path already covers the
          // primary failure; this branch fires when the rethrow surfaces
          // here (e.g. fallback chrome.storage.local.set rethrew).
          emitStorageQuotaFailure(error, null);
        }
        appendPlainLog(tx(`Failed to save session state: ${formatStateSaveError(error)}`, `保存会话状态失败：${formatStateSaveError(error)}`));
      })
      .finally(() => {
        saveStateInFlight = false;
        if (saveStateRunAfterFlight) {
          // A saveStateSoon() landed during the in-flight phase. Flush it
          // now so the final disk snapshot reflects the latest state.
          saveStateRunAfterFlight = false;
          saveStateSoon(0);
        }
      });
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
    return error?.message || String(error);
  }

  async function persistPanelInputs(event) {
    // Typing in the task box is the hottest write path: a full saveState per
    // keystroke serializes every session/run/event and rewrites IndexedDB, so
    // panels get slower as history grows. Drafts take the debounced saver;
    // committed control changes keep the immediate full save below.
    if (event?.type === 'input' && event?.target?.matches?.('[data-task]')) {
      readPanelInputs();
      saveStateSoon();
      return;
    }
    readPanelInputs();
    renderSpeedOptions(getRenderedModelEntries());
    renderModelConfigChoices();
    updateModelDisplay();
    // Save feedback is per-card now (settingsPanel flashSaved); the global
    // header chip and its Saving/Saved lifecycle are gone.
    await saveState();
    syncModeControls();
    applySessionLabel();
    renderSessionList();
  }

  function getRenderedModelEntries() {
    return Array.from(panel?.querySelector('[data-model]')?.options || []).map(option => ({
      id: option.value,
      label: option.textContent,
      speedTiers: (option.dataset.speedTiers || 'standard').split(',').filter(Boolean),
      defaultSpeedTier: option.dataset.defaultSpeedTier || 'standard'
    }));
  }

  async function selectMode(mode) {
    if (!['ask', 'confirm', 'auto'].includes(mode)) {
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
  }

  function readPanelInputs() {
    const projectId = getCurrentProjectId();
    if (getLastExperimentalOtProjectId() !== projectId) {
      syncExperimentalOtToggleForProject(projectId);
    }
    persistComposerAttachmentsToState();
    state = updateActiveSession(state, {
      model: readSelectedModelInput(),
      reasoningEffort: panel.querySelector('[data-reasoning]').value,
      speedTier: readSelectedSpeedInput(),
      mode: panel.querySelector('[data-mode]').value,
      task: panel.querySelector('[data-task]').value,
      requireReviewing: panel.querySelector('[data-require-reviewing]').checked
    });
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
      const newSettings = readSkillLoadingSettingsFromSettings();
      const prevOverleafSkills = getSkillLoadingSettings().loadCodexOverleafSkills;
      setSkillLoadingSettings(newSettings);
      // Theme is a global preference; read it from the settings select (which
      // lives inside the panel, like the other settings inputs), persist it on
      // state, and apply immediately. applyPanelTheme normalizes the value.
      const themePref = panel?.querySelector('[data-theme-select]')?.value || 'dark';
      if (state) {
        state.theme = themePref;
      }
      applyPanelTheme(themePref);
      // Language is a global UI preference (moved here from the diagnostics
      // menu); re-translate the panel when it changes.
      const languagePref = panel?.querySelector('[data-language-select]')?.value;
      if (languagePref && state && languagePref !== getLocale()) {
        state.locale = i18n?.normalizeLocale?.(languagePref) || languagePref;
        applyLocaleToPanel();
      }
      // Re-render skill list when master toggle changes so per-skill toggles update their disabled state.
      if (prevOverleafSkills !== getSkillLoadingSettings().loadCodexOverleafSkills) {
        renderLocalSkillList();
      }
      updateSkillsEntrySummary();
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


  let composerAttachmentsRestoredOnce = false;
  let lastRunActivityBumpMs = 0;

  function persistComposerAttachmentsToState() {
    if (typeof composerAttachmentController?.serializePersistableAttachments === 'function') {
      state.composerAttachments = composerAttachmentController.serializePersistableAttachments();
    }
  }

  function clearTaskComposer({ keepAttachments = false } = {}) {
    const taskInput = panel?.querySelector('[data-task]');
    if (taskInput) {
      taskInput.value = '';
    }
    autosizeTaskTextarea();
    if (!keepAttachments) {
      composerAttachmentController.clear();
    }
    composerSkillInvocation = null;
    renderComposerSkillInvocation();
    state = updateActiveSession(state, { task: '' });
    saveStateSoon();
  }

  function applyStateToPanel() {
    applyPanelTheme(getThemePreference());
    if (!modelSelectHasOption(state.model)) {
      renderModelOptions(getModelCatalog().FALLBACK_MODELS, state.model);
    }
    panel.querySelector('[data-model]').value = state.model;
    panel.querySelector('[data-reasoning]').value = state.reasoningEffort;
    renderSpeedOptions(Array.from(panel.querySelector('[data-model]')?.options || []).map(option => ({
      id: option.value,
      label: option.textContent,
      speedTiers: (option.dataset.speedTiers || 'standard').split(',').filter(Boolean),
      defaultSpeedTier: option.dataset.defaultSpeedTier || 'standard'
    })));
    panel.querySelector('[data-speed]').value = state.speedTier;
    panel.querySelector('[data-mode]').value = state.mode;
    panel.querySelector('[data-task]').value = state.task;
    // Programmatic value changes fire no input event: re-sync the autogrow
    // height and the empty-task send disable (session switch / init restore).
    autosizeTaskTextarea();
    syncComposerSendAvailability();
    panel.querySelector('[data-require-reviewing]').checked = state.requireReviewing;
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
    renderRunHistory();
    renderContextSelection();
    renderContextSummary();
    // v1.8.0 C4: refresh recovery — small attachments persisted in state are
    // restored into the (empty) tray ONCE per page load, before the render
    // below. Re-running the gate on later renders would resurrect files the
    // user explicitly removed (fleet P2).
    if (!composerAttachmentsRestoredOnce
      && Array.isArray(state.composerAttachments) && state.composerAttachments.length
      && !composerAttachmentController.getAttachmentsForRun?.().length
      && typeof composerAttachmentController.restorePersistedAttachments === 'function') {
      composerAttachmentController.restorePersistedAttachments(state.composerAttachments);
    }
    composerAttachmentsRestoredOnce = true;
    renderComposerAttachments();
    renderComposerSkillInvocation();
    applyLocaleToPanel();
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
    const runButton = panel.querySelector('[data-run]');
    // Running -> the button is Cancel and must never be disabled; idle -> it
    // is Send and disables on an empty composer (feedback instead of no-op).
    runButton.disabled = running ? false : !String(panel.querySelector('[data-task]')?.value || '').trim();
    runButton.title = running ? tr('cancelRun') : tr('send');
    runButton.setAttribute('aria-label', running ? tr('cancelRun') : tr('send'));
    panel.querySelector('[data-new-session]').disabled = false;
    panel.querySelector('[data-diagnostics-snapshot]').disabled = running;
    if (running) {
      closeDiagnosticsMenu();
    }
    panel.dataset.running = running ? 'true' : 'false';
    panel.dataset.cancelling = running && runCancellationRequested ? 'true' : 'false';
  }

  function startRunView({ task, mode, model, reasoningEffort, speedTier }) {
    let attachments = [];
    if (Array.isArray(arguments[0]?.attachments)) {
      attachments = arguments[0].attachments;
    }
    resetAutoFollow();
    const record = {
      id: createRunId(),
      task,
      mode,
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
      // Welcome-panel + write-guard:
      // Immutable per-run capture of the project this run was submitted
      // against. Every writeback / accept / undo dispatch attaches this id
      // to its page-bridge params so the page-side guard can verify the run
      // is still acting on the same project before mutating the editor. No
      // language-level enforcement — the field is treated as immutable by
      // convention and never reassigned anywhere downstream.
      runProjectId: getCurrentProjectId() || ''
    };
    const active = getActiveSession(state);
    const titlePatch = active?.titleSource !== 'manual'
      ? {
        title: deriveSessionTitle([], task),
        titleSource: 'auto'
      }
      : {};
    state = updateActiveSession(state, {
      runs: [...(state.runs || []), record].slice(-20),
      ...titlePatch
    });
    saveStateSoon();

    const log = panel.querySelector('[data-log]');
    removeEmptyRunsMessage(log);
    const root = renderRunCard(record);
    log.append(root);
    scrollLogToBottom({ force: true });
    startRunElapsedTick();
    renderSessionList();
    applySessionLabel();

    return {
      sessionId: state.activeSessionId,
      recordId: record.id,
      // Mirror the immutable runProjectId on the view so writeback /
      // accept / undo dispatches don't need to re-look up the record.
      runProjectId: record.runProjectId,
      root,
      runProcess: root.querySelector('[data-run-process]'),
      processLabel: root.querySelector('[data-run-process-summary]'),
      events: root.querySelector('[data-run-events]'),
      report: root.querySelector('[data-run-report]'),
      status: root.querySelector('[data-run-status]'),
      projectFiles: captureProjectReferenceFiles(arguments[0]?.project),
      startedAt: Date.now()
    };
  }

  function finishRunView(text, status) {
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
        saveStateSoon();
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
  }


  function appendNativeEvent(event) {
    if (!event) {
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
      replaceText: activity.replaceText
    });
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
    if (!currentRunView?.events) {
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
      streamKey: sanitizeAssistantVisibleText(input.streamKey),
      streamRole: sanitizeAssistantVisibleText(input.streamRole),
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
    const record = findRunRecord(currentRunView.recordId, currentRunView.sessionId);
    let renderedEvent = event;
    if (record) {
      // v1.8.1: keep the session's activity timestamp honest DURING a run —
      // it was pinned to run start, so the dashboard's 30-minute zombie
      // heuristic mislabeled any long live run as interrupted (fleet P1).
      // Throttled to once a minute; updateActiveSession stamps updatedAt.
      const nowMs = Date.now();
      if (nowMs - lastRunActivityBumpMs > 60000) {
        lastRunActivityBumpMs = nowMs;
        state = updateActiveSession(state, {});
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
    currentRunView.events = root.querySelector('[data-run-events]');
    currentRunView.report = root.querySelector('[data-run-report]');
    currentRunView.status = root.querySelector('[data-run-status]');
    return currentRunView;
  }

  function appendRunEventToView(view, event) {
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
    if (event.kind === 'stream') {
      // Stream deltas update an existing line in place — they must not inflate
      // the unread-step counter.
      upsertStreamEvent(view, event);
      return;
    }
    view.events.append(renderRunEvent(event));
    bumpUnreadIfDetached();
  }

  function upsertRunStreamRecordEvent(record, event) {
    const streamKey = event.streamKey || event.streamRole || 'codex-stream';
    const events = Array.isArray(record.events) ? record.events : [];
    const existing = [...events].reverse().find(item => item.kind === 'stream' && item.streamKey === streamKey);
    if (existing) {
      const nextTitle = sanitizeAssistantVisibleText(event.title);
      const nextRole = sanitizeAssistantVisibleText(event.streamRole) || existing.streamRole;
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

    addFiles(currentRunView?.projectFiles);
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
    const activeSession = typeof getActiveSession === 'function' ? getActiveSession(state) : null;
    addTextPaths(activeSession?.focusFiles);
    for (const session of Array.isArray(state?.sessions) ? state.sessions : []) {
      addTextPaths(session?.focusFiles);
    }
    return files;
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
    if (!result?.skipped?.length) {
      return true;
    }
    const expectedByPath = new Map((run?.undoExpectedFiles || [])
      .filter(file => file?.path && typeof file.content === 'string')
      .map(file => [file.path, file.content]));
    if (!expectedByPath.size) {
      return false;
    }
    const undoRestore = buildNoTraceUndoRestore(run);
    const editPaths = Array.from(new Set((undoRestore.operations || [])
      .filter(operation => (
        operation?.type === 'edit'
        && operation.path
        && expectedByPath.has(operation.path)
      ))
      .map(operation => operation.path)));
    if (!editPaths.length) {
      return false;
    }
    return editPaths.every(path => (result.applied || []).some(item => (
      item?.operation?.type === 'edit'
      && item.operation.path === path
      && item?.result?.verifiedContent === expectedByPath.get(path)
    )));
  }

  async function undoRun(runId) {
    const run = findRunRecord(runId);
    if (!getRunUndoCount(run) || run.undoStatus === 'applied') {
      return;
    }
    // Wait out any background mirror refresh before undoing (v1.7.5): a
    // mirror.sync finishing after the undo would push the pre-undo snapshot
    // as the local baseline and resurrect the undone content next run.
    const pendingMirror = getPendingMirrorRefresh?.();
    if (pendingMirror) {
      await pendingMirror.catch(() => {});
    }

    if ((Array.isArray(run.undoTrackedChanges) && run.undoTrackedChanges.length) || hasTrackedEditorUndo(run)) {
      await undoRunTrackedChanges(runId, run);
      return;
    }

    const undoRestore = buildNoTraceUndoRestore(run);
    const undoOperations = undoRestore.operations;
    const unsafeFullFileUndo = findUnsafeFullFileUndoOperation(undoOperations, {
      allowSnapshotRestore: undoRestore.snapshotRestore
    });
    if (unsafeFullFileUndo) {
      appendRunRecordEvent(runId, {
        title: tr('undoUnsafeFullFileTitle'),
        status: 'failed',
        detail: {
          [tr('detailFile')]: unsafeFullFileUndo.path,
          [tr('detailReason')]: tr('undoUnsafeFullFileReason')
        }
      });
      return;
    }

    // v1.8.0 C3: multi-file undos confirm through a per-file selection —
    // undoing a subset leaves undoStatus 'partial' and the button usable;
    // re-undoing an already-restored file is skipped by the base check.
    const undoPaths = Array.from(new Set(undoOperations.map(operation => operation?.path).filter(Boolean)));
    let selectedOperations = undoOperations;
    if (undoPaths.length > 1 && typeof showUndoFileSelection === 'function') {
      const selectedPaths = await showUndoFileSelection({
        title: tr('undoFileSelectTitle'),
        task: truncateRunTitle(run.task),
        confirmLabel: tr('undoFileSelectConfirm'),
        cancelLabel: tr('confirmDefaultCancel'),
        selectAllLabel: tr('undoFileSelectAll'),
        paths: undoPaths
      });
      if (!selectedPaths) {
        return;
      }
      const selectedSet = new Set(selectedPaths);
      selectedOperations = undoOperations.filter(operation => selectedSet.has(operation?.path));
    } else {
      const approved = await showPluginConfirm({
        title: tr('undoNoTraceTitle'),
        message: [
          truncateRunTitle(run.task),
          '',
          tr('undoNoTraceMessage', { files: formatOperationFiles(undoOperations) })
        ].join('\n'),
        confirmLabel: tr('undoConfirm'),
        cancelLabel: tr('confirmDefaultCancel'),
        destructive: true
      });
      if (!approved) {
        return;
      }
    }

    setRunUndoStatus(runId, 'running');
    appendRunRecordEvent(runId, {
      title: tr('undoNoTraceStarted'),
      status: 'running',
      detail: { [tr('detailWillUndo')]: formatOperationFiles(selectedOperations) }
    });

      const result = await callPageBridge('applyOperations', {
        operations: selectedOperations,
        baseFiles: run.undoBaseFiles || [],
        reviewingPolicy: 'no-trace-undo',
        // Welcome-panel + write-guard:
        // route the undo through the same project-ID guard. The undo is
        // bound to the run's original project, not the editor's active one.
        runProjectId: getRunProjectIdForWriteback(run)
      });
      const undoApplied = isUndoResultEffectivelyApplied(run, result);
      appendUndoReviewingPolicyEvent(runId, result.reviewingPolicy);
      appendRunRecordEvent(runId, {
        title: tr('undoResult', { applied: result.applied?.length || 0, skipped: result.skipped?.length || 0 }),
        status: undoApplied ? 'completed' : result.skipped?.length ? 'failed' : 'completed',
        detail: {
          [tr('detailUndone')]: (result.applied || []).map(item => ({
            [tr('detailAction')]: formatOperationType(item.operation?.type),
            [tr('detailFile')]: item.operation?.path
        })),
        [tr('detailSkipped')]: (result.skipped || []).map(item => ({
          [tr('detailAction')]: formatOperationType(item.operation?.type),
          [tr('detailFile')]: item.operation?.path,
            [tr('detailReason')]: formatApplyResultReason(item)
          }))
        }
      });
      // A subset undo never closes the ledger: unselected files can still
      // be undone later, so the run stays 'partial' and the button usable.
      const fullSelection = selectedOperations.length === undoOperations.length;
      setRunUndoStatus(runId, undoApplied && fullSelection ? 'applied' : 'partial');
  }

  async function undoRunTrackedChanges(runId, run) {
    const trackedUndo = Array.isArray(run.undoTrackedChanges) && run.undoTrackedChanges.length > 0;
    const approved = await showPluginConfirm({
      title: trackedUndo ? tr('undoTrackedTitle') : tr('undoNativeTitle'),
      message: [
        truncateRunTitle(run.task),
        '',
        trackedUndo
          ? tr('undoTrackedMessage', { files: formatTrackedChangeFiles(run.undoTrackedChanges) })
          : tr('undoNativeMessage', { files: formatTrackedUndoFiles(run) })
      ].join('\n'),
      confirmLabel: trackedUndo ? tr('undoTrackedConfirm') : tr('undoConfirm'),
      cancelLabel: tr('confirmDefaultCancel'),
      destructive: true
    });
    if (!approved) {
      return;
    }

    // Tracked-change-lifecycle runs (those holding tracked-change refs) reach a
    // decisive terminal `rejected` once the reject returns. The UI-local
    // in-flight lock disables the button; it is never persisted.
    const lifecycleReject = trackedUndo && isTrackedChangeLifecycleRun(run);
    if (lifecycleReject) {
      trackedChangeInFlight.set(runId, 'reject');
      refreshRunCardControls(runId);
    } else {
      setRunUndoStatus(runId, 'running');
    }
    appendRunRecordEvent(runId, {
      title: trackedUndo ? tr('undoTrackedStarted') : tr('undoNativeStarted'),
      status: 'running',
      detail: { [tr('detailWillUndo')]: trackedUndo ? formatTrackedChangeFiles(run.undoTrackedChanges) : formatTrackedUndoFiles(run) }
    });

    let result;
    try {
      result = await callPageBridge('rejectTrackedChanges', {
        trackedChanges: run.undoTrackedChanges || [],
        expectedFiles: run.undoExpectedFiles || [],
        postFiles: buildTrackedUndoPostFiles(run),
        // Welcome-panel + write-guard:
        // bind the reject to the run's original project. If the user has
        // navigated away the page-side guard refuses with
        // `aborted_project_changed` and the document is left untouched.
        runProjectId: getRunProjectIdForWriteback(run)
      });
    } finally {
      if (lifecycleReject) {
        trackedChangeInFlight.delete(runId);
      }
    }
    appendRunRecordEvent(runId, {
      title: trackedUndo
        ? tr('undoTrackedResult', { applied: result.applied?.length || 0, skipped: result.skipped?.length || 0 })
        : tr('undoNativeResult', { applied: result.applied?.length || 0, skipped: result.skipped?.length || 0 }),
      status: result.skipped?.length ? 'failed' : 'completed',
      detail: {
        [trackedUndo ? tr('detailRejected') : tr('detailUndone')]: (result.applied || []).map(item => ({
          [tr('detailFile')]: item.trackedChange?.path || tr('unknownFile'),
          [tr('detailRecord')]: item.trackedChange?.label || item.trackedChange?.id || item.trackedChange?.key
        })),
        [tr('detailSkipped')]: (result.skipped || []).map(item => ({
          [tr('detailFile')]: item.trackedChange?.path || tr('unknownFile'),
          [tr('detailRecord')]: item.trackedChange?.label || item.trackedChange?.id || item.trackedChange?.key || '',
          [tr('detailReason')]: formatBridgeResultReason(item.result, item.trackedChange?.path)
        }))
      }
    });
    if (lifecycleReject) {
      // Structured FailureReason §9.5: post-undo proof step. If the page op
      // reported ok-ish (no skipped items) but the per-path verifiedContent
      // does not match this run's expected pre-write content, synthesize an
      // `undo_not_verified` failure (warning, retryable, needs_review,
      // changedDocument:true) and attach it to the result so the §7
      // settlement matrix routes the run to `needs_review`.
      attachUndoNotVerifiedFailure(run, result);
      // §7 settlement matrix: only land in terminal `rejected` when post-action
      // proof is sufficient. If any per-op failure marks `needs_review` (or
      // matches a known unverified code), settle as `needs_review` so both
      // Accept and Undo stay actionable and the user can reconcile.
      applyRejectSettlement(runId, result);
      return;
    }
    setRunUndoStatus(runId, result.skipped?.length ? 'partial' : 'applied');
  }

  // Post-undo proof step (§9.5). Called only on lifecycle reject paths after
  // the page bridge has returned. We only synthesize an `undo_not_verified`
  // failure when:
  //   - The page op did not already emit a needs_review-class failure (the
  //     settlement matrix would have caught it).
  //   - The reject result has no skipped items (otherwise the existing
  //     skipped failures drive settlement).
  //   - At least one expected pre-run path has no matching `applied` entry
  //     whose `verifiedContent` equals the expected content. (Note: we do
  //     NOT delegate to `isUndoResultEffectivelyApplied` because that helper
  //     short-circuits to true on `skipped.length === 0` — the §9.5 contract
  //     requires real per-path verifiedContent proof.)
  // The synthesized failure is appended to `result.skipped` as a synthetic
  // proof entry so `collectFailuresFromResult` picks it up.
  function attachUndoNotVerifiedFailure(run, result) {
    if (!result || typeof result !== 'object') return;
    if (result.ok === false) return;
    if (Array.isArray(result.skipped) && result.skipped.length > 0) return;
    const expectedFiles = Array.isArray(run?.undoExpectedFiles) ? run.undoExpectedFiles : [];
    if (!expectedFiles.length) return;
    if (isUndoVerifiedContentMatching(run, result)) return;
    const firstPath = expectedFiles.find(entry => entry && typeof entry.path === 'string')?.path || '';
    const failure = buildContentFailure('undo_not_verified', { path: firstPath, type: 'undo' }, {
      changedDocument: true,
      terminalState: 'needs_review',
      evidence: {
        undoApplied: true,
        verified: false,
        expectedFileCount: expectedFiles.length
      }
    });
    const synthetic = {
      operation: { path: firstPath, type: 'undo' },
      result: {
        ok: false,
        code: 'undo_not_verified',
        reason: failure.userMessage,
        failure
      }
    };
    if (!Array.isArray(result.skipped)) {
      result.skipped = [];
    }
    result.skipped.push(synthetic);
    result.ok = false;
  }

  // Per-path verifiedContent match for the §9.5 proof step. Returns true
  // only when every expected pre-run path has a matching `applied` entry
  // whose `result.verifiedContent` equals the expected content. Empty
  // expected files map → true (nothing to prove).
  function isUndoVerifiedContentMatching(run, result) {
    const expectedByPath = new Map((run?.undoExpectedFiles || [])
      .filter(file => file && typeof file.path === 'string' && typeof file.content === 'string')
      .map(file => [file.path, file.content]));
    if (!expectedByPath.size) return true;
    const applied = Array.isArray(result.applied) ? result.applied : [];
    for (const [path, expected] of expectedByPath.entries()) {
      const matched = applied.some(entry => {
        if (!entry || !entry.operation) return false;
        if (entry.operation.path !== path) return false;
        if (entry.operation.type !== 'edit') return false;
        if (entry.result && entry.result.ok === false) return false;
        return entry.result && entry.result.verifiedContent === expected;
      });
      if (!matched) return false;
    }
    return true;
  }

  async function acceptRun(runId) {
    const run = findRunRecord(runId);
    if (!run || !isTrackedChangeLifecycleRun(run)) {
      return;
    }
    const status = run.trackedChangeStatus || '';
    // pending and needs_review are both actionable per §7: needs_review means
    // the prior attempt could not prove a clean post-action state, and the
    // user is supposed to be able to retry after inspecting Overleaf.
    if (status !== 'pending' && status !== 'needs_review') {
      return;
    }
    if (!Array.isArray(run.undoTrackedChanges) || !run.undoTrackedChanges.length) {
      return;
    }
    if (trackedChangeInFlight.get(runId)) {
      return;
    }

    // UI-local in-flight lock: disables the acting button with progress. Never
    // written to trackedChangeStatus, never persisted.
    trackedChangeInFlight.set(runId, 'accept');
    refreshRunCardControls(runId);
    appendRunRecordEvent(runId, {
      title: tr('runAcceptTrackedStarted'),
      status: 'running',
      detail: { [tr('detailAccepted')]: formatTrackedChangeFiles(run.undoTrackedChanges) }
    });

    let result;
    try {
      result = await callPageBridge('acceptTrackedChanges', {
        trackedChanges: run.undoTrackedChanges || [],
        expectedFiles: run.undoExpectedFiles || [],
        postFiles: buildTrackedUndoPostFiles(run),
        // The run's own forward writeback operations. The Accept replay
        // re-applies these exact patches so it writes only the changed
        // fragments, never a whole-file overwrite.
        appliedOperations: Array.isArray(run.appliedOperations) ? run.appliedOperations : [],
        // Welcome-panel + write-guard:
        // bind the accept replay to the run's original project. If the user
        // has navigated to a different project the page-side guard refuses
        // with `aborted_project_changed` before any mutation.
        runProjectId: getRunProjectIdForWriteback(run)
      });
    } finally {
      trackedChangeInFlight.delete(runId);
    }
    // Surface every page-layer step as its own run-card event row so the user
    // can copy-paste the full Accept trace if the sticky-Editing reconfirm
    // ever still cannot keep the replay untracked. Each entry is
    // self-contained — the diagnostic info inline carries the reviewing
    // detector verdict, the strict gate booleans, and per-op
    // re-toggle/verify outcomes so no extra page-state query is needed.
    appendAcceptDiagnosticEvents(runId, Array.isArray(result.diagnostics) ? result.diagnostics : []);
    appendRunRecordEvent(runId, {
      title: tr('runAcceptTrackedResult', { applied: result.applied?.length || 0, skipped: result.skipped?.length || 0 }),
      status: result.skipped?.length ? 'failed' : 'completed',
      detail: {
        [tr('detailAccepted')]: (result.applied || []).map(item => ({
          [tr('detailFile')]: item.trackedChange?.path || tr('unknownFile'),
          [tr('detailRecord')]: item.trackedChange?.label || item.trackedChange?.id || item.trackedChange?.key
        })),
        [tr('detailSkipped')]: (result.skipped || []).map(item => ({
          [tr('detailFile')]: item.trackedChange?.path || tr('unknownFile'),
          [tr('detailRecord')]: item.trackedChange?.label || item.trackedChange?.id || item.trackedChange?.key || '',
          [tr('detailReason')]: formatBridgeResultReason(item.result, item.trackedChange?.path)
        }))
      }
    });
    // Accept All is editor-undo + untracked replay. If the editor-undo could not
    // reach the pre-write state (content drifted), the page layer bails without
    // re-writing and returns not-ok. The run then stays `pending` so the user
    // can retry — it does NOT go to a decisive terminal status.
    if (result.ok === false) {
      appendRunRecordEvent(runId, {
        title: tr('runAcceptTrackedFailed'),
        status: 'failed',
        detail: {
          [tr('detailReason')]: tr('runAcceptTrackedFailedReason')
        }
      });
      refreshRunCardControls(runId);
      return;
    }
    // Structured FailureReason §9.6: post-accept proof step. If the page op
    // returned ok but cannot prove a clean post-accept state (no skipped
    // items, no remaining tracked-change refs proven, and the post-files
    // content of at least one path is missing or mismatched), synthesize an
    // `accept_not_verified` failure (warning, retryable, needs_review,
    // changedDocument:true) and attach it so the §7 settlement matrix routes
    // the run to `needs_review` rather than terminal `accepted`.
    attachAcceptNotVerifiedFailure(run, result);
    // §7 settlement matrix: only land in terminal `accepted` when post-action
    // proof is sufficient. If any per-op failure marks `needs_review` (or
    // matches a known unverified code), settle as `needs_review` so both
    // Accept and Undo stay actionable and the user can reconcile.
    applyAcceptSettlement(runId, result);
  }

  // Fail-closed when the run record carries no runProjectId of its own.
  //
  // Older persisted runs (pre-v1.3.8) and restored-from-history runs may have
  // an empty runProjectId. Returning the editor's current projectId as a
  // fallback would let the page-side write-guard pass when the user happens
  // to be in the project they originally ran the task on — but the run
  // itself has NO authoritative binding, so we can't actually prove it.
  // Returning '' triggers the runProjectId-missing branch of writeGuard /
  // checkWritebackRunProjectId, which surfaces editor_project_id_unavailable
  // with the canonical 'Refresh Overleaf and retry' next-step text.
  function getRunProjectIdForWriteback(run) {
    return typeof run?.runProjectId === 'string' && run.runProjectId
      ? run.runProjectId
      : '';
  }

  // Post-accept proof step (§9.6). Called only on lifecycle accept paths
  // after the page bridge has returned. We only synthesize an
  // `accept_not_verified` failure when:
  //   - The page op did not already emit a needs_review-class failure (the
  //     settlement matrix would have caught it).
  //   - The accept result has no skipped items (otherwise the existing
  //     skipped failures drive settlement).
  //   - The page bridge did not confirm clean post-accept state — either no
  //     `verified` flag, or the per-path applied items do not show the
  //     trackedChange was confirmed cleared.
  // The synthesized failure is appended to `result.skipped` as a synthetic
  // proof entry so `collectFailuresFromResult` picks it up.
  function attachAcceptNotVerifiedFailure(run, result) {
    if (!result || typeof result !== 'object') return;
    if (result.ok === false) return;
    if (Array.isArray(result.skipped) && result.skipped.length > 0) return;
    if (isAcceptResultEffectivelyVerified(run, result)) return;
    const expectedFiles = Array.isArray(run?.undoExpectedFiles) ? run.undoExpectedFiles : [];
    const firstPath = expectedFiles.find(entry => entry && typeof entry.path === 'string')?.path
      || (run?.undoTrackedChanges || []).find(change => change && typeof change.path === 'string')?.path
      || '';
    const failure = buildContentFailure('accept_not_verified', { path: firstPath, type: 'accept' }, {
      changedDocument: true,
      terminalState: 'needs_review',
      evidence: {
        acceptApplied: true,
        verified: false,
        expectedFileCount: expectedFiles.length,
        trackedChangeCount: Array.isArray(run?.undoTrackedChanges) ? run.undoTrackedChanges.length : 0
      }
    });
    const synthetic = {
      operation: { path: firstPath, type: 'accept' },
      result: {
        ok: false,
        code: 'accept_not_verified',
        reason: failure.userMessage,
        failure
      }
    };
    if (!Array.isArray(result.skipped)) {
      result.skipped = [];
    }
    result.skipped.push(synthetic);
    result.ok = false;
  }

  // Mirrors `isUndoResultEffectivelyApplied` for the accept side. Returns
  // true when the page-bridge result carries proof that the run's tracked
  // changes are gone: each tracked-change ref has a matching `applied` entry
  // whose `result.verifiedContent` equals the run's known post-write content
  // for that path. Returns false when proof is missing or contradicted —
  // §9.6 `accept_not_verified`. Falls back to true when there are no
  // expected files (defensive: the page bridge already returned ok, and
  // there is nothing to verify against).
  function isAcceptResultEffectivelyVerified(run, result) {
    if (!result || typeof result !== 'object') return true;
    const expectedFiles = Array.isArray(run?.undoExpectedFiles) ? run.undoExpectedFiles : [];
    if (!expectedFiles.length) return true;
    if (result.verified === true) return true;
    const trackedChanges = Array.isArray(run?.undoTrackedChanges) ? run.undoTrackedChanges : [];
    if (!trackedChanges.length) return true;
    const applied = Array.isArray(result.applied) ? result.applied : [];
    if (!applied.length) return false;
    // Every tracked-change ref must show up in `applied` with a result
    // carrying ok:true. If any tracked change does not appear as applied,
    // proof is missing.
    return trackedChanges.every(change => {
      const key = change && (change.key || change.id || change.label);
      if (!key) return false;
      return applied.some(entry => {
        const ref = entry && entry.trackedChange;
        if (!ref) return false;
        const refKey = ref.key || ref.id || ref.label;
        if (refKey !== key) return false;
        if (entry.result && entry.result.ok === false) return false;
        return true;
      });
    });
  }

  // Translates the page bridge's Accept All `diagnostics` array into one
  // run-card event row per step. Each entry is `{ step, info }`; the step
  // names map 1:1 to the runAcceptTrackedStep* i18n keys. We render `info`
  // as the event detail so the user can copy-paste the full trace without
  // any extra page-state query.
  function appendAcceptDiagnosticEvents(runId, diagnostics) {
    for (const entry of diagnostics || []) {
      const step = entry && entry.step;
      const info = (entry && entry.info) || {};
      const titleKey = ACCEPT_DIAGNOSTIC_TITLE_KEYS[step];
      if (!titleKey) {
        continue;
      }
      const title = titleKey === 'runAcceptTrackedStepReplayStart' || titleKey === 'runAcceptTrackedStepReplayDone'
        ? tr(titleKey, { path: info.path || tr('unknownFile') })
        : tr(titleKey);
      const status = acceptDiagnosticStatus(step, info);
      appendRunRecordEvent(runId, {
        title,
        kind: 'activity',
        status,
        detail: info
      });
    }
  }

  // Maps each diagnostic step name to its i18n title key. Kept out of the
  // function body so any future step rename surfaces as a missing entry.
  const ACCEPT_DIAGNOSTIC_TITLE_KEYS = {
    editorUndo: 'runAcceptTrackedStepEditorUndo',
    modeBefore: 'runAcceptTrackedStepModeBefore',
    forceEditing: 'runAcceptTrackedStepForceEditing',
    replayStart: 'runAcceptTrackedStepReplayStart',
    replayDone: 'runAcceptTrackedStepReplayDone',
    restoreReviewing: 'runAcceptTrackedStepRestoreReviewing'
  };

  function acceptDiagnosticStatus(step, info) {
    if (step === 'modeBefore' || step === 'replayStart') {
      // Pre-state reads: never a failure, only context.
      return 'info';
    }
    if (step === 'editorUndo' || step === 'forceEditing' || step === 'restoreReviewing') {
      return info && info.ok === true ? 'info' : 'failed';
    }
    if (step === 'replayDone') {
      return info && info.ok === true ? 'info' : 'failed';
    }
    return 'info';
  }

  // Drives a tracked-change-lifecycle run to a decisive terminal status when
  // post-action proof is sufficient. Called by `applyAcceptSettlement` /
  // `applyRejectSettlement` only after the §7 settlement matrix has cleared
  // the run: if the page-layer returned per-op failures that imply unverified
  // post-action state, the settlement helper routes to `needs_review` instead,
  // and this helper is never called. The heavy payload is emptied here so
  // stale refs never re-enter retention.
  function applyTerminalTrackedChangeStatus(runId, status) {
    const run = findRunRecord(runId);
    if (!run || !TERMINAL_TRACKED_CHANGE_STATUS.has(status)) {
      return;
    }
    run.trackedChangeStatus = status;
    run.undoTrackedChanges = [];
    run.undoExpectedFiles = [];
    saveStateSoon();
    refreshRunCardControls(runId);
  }

  // Inline mirror of the content-side subset of the FailureReason §9 catalog
  // used by T5 emit sites. Mirrors the page-side `PAGE_FAILURE_CATALOG` in
  // `extension/src/page/writebackRouter.js` so neither runtime has to depend on
  // load order with `shared/failureReasons.js`. Each entry mirrors stage /
  // severity / defaultRetryable / fallbackUserMessage / fallbackNextAction
  // from `FAILURE_CODE_CATALOG`; keep in sync when adding codes.
  const CONTENT_FAILURE_CATALOG = {
    project_snapshot_unavailable: {
      stage: 'context', severity: 'error', defaultRetryable: true,
      fallbackUserMessage: 'Codex could not read the Overleaf project snapshot.',
      fallbackNextAction: 'Refresh Overleaf, then rerun the task.'
    },
    selected_context_unresolved: {
      stage: 'context', severity: 'warning', defaultRetryable: true,
      fallbackUserMessage: 'Codex could not resolve the requested selection or context.',
      fallbackNextAction: 'Select the target again or specify the file/section explicitly.'
    },
    codex_no_usable_result: {
      stage: 'codex', severity: 'error', defaultRetryable: true,
      fallbackUserMessage: 'Local Codex returned no usable final report or operations.',
      fallbackNextAction: 'Open Technical Details and resolve the local Codex error.'
    },
    codex_project_locked: {
      stage: 'codex', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'Another Codex task is already running for this Overleaf project.',
      fallbackNextAction: 'Wait for the active task to finish, or cancel it before retrying.'
    },
    storage_quota_exceeded: {
      stage: 'storage', severity: 'warning', defaultRetryable: true,
      fallbackUserMessage: 'Browser storage quota was exceeded.',
      fallbackNextAction: 'Clear old run history or reduce attachments.'
    },
    native_bridge_unavailable: {
      stage: 'native', severity: 'blocked', defaultRetryable: true,
      fallbackUserMessage: 'Extension cannot connect to the Codex native host.',
      fallbackNextAction: 'Run install-native or reload the extension.'
    },
    undo_not_verified: {
      stage: 'undo', severity: 'warning', defaultRetryable: true,
      fallbackUserMessage: 'Undo ran, but Codex could not prove the file returned to pre-run content.',
      fallbackNextAction: 'Inspect the file manually before continuing.'
    },
    accept_not_verified: {
      stage: 'accept', severity: 'warning', defaultRetryable: true,
      fallbackUserMessage: 'Accept appeared to run but Codex could not prove final content/state.',
      fallbackNextAction: 'Inspect Overleaf Reviewing before continuing.'
    }
  };

  // Build a structured FailureReason record (§7) for emit at the content
  // runtime layer. `overrides` merges into the entry: callers supply `file` /
  // `activeFile` / `userMessage` / `evidence` / `changedDocument` /
  // `terminalState` etc. The `op` argument is the operation context that
  // augments `file` / `operationType` when not explicitly overridden.
  function buildContentFailure(code, op, overrides) {
    // The local catalog holds content-runtime-specific codes; every other
    // code (codex_not_found, codex_timeout, codex_output_limit,
    // stale_source_changed, native_protocol_incompatible, ...) resolves
    // through the shared §9 catalog. Without this fallback the function
    // returned null for every shared-only code, so completion reports
    // carried no structured failure and the recovery-action registry never
    // fired for them (v1.7.6 fleet P1).
    const entry = CONTENT_FAILURE_CATALOG[code] || FailureReasons?.FAILURE_CODE_CATALOG?.[code];
    if (!entry) {
      return null;
    }
    const merged = overrides || {};
    const opCtx = op || {};
    const failure = {
      code,
      stage: entry.stage,
      severity: entry.severity,
      userMessage: merged.userMessage || entry.fallbackUserMessage,
      retryable: merged.retryable === undefined ? entry.defaultRetryable : merged.retryable === true,
      nextAction: merged.nextAction || entry.fallbackNextAction
    };
    const file = merged.file !== undefined ? merged.file : opCtx.path;
    if (file) failure.file = file;
    const operationType = merged.operationType !== undefined ? merged.operationType : opCtx.type;
    if (operationType) failure.operationType = operationType;
    if (merged.activeFile !== undefined) failure.activeFile = merged.activeFile;
    if (merged.changedDocument !== undefined) failure.changedDocument = merged.changedDocument === true;
    if (merged.terminalState !== undefined) failure.terminalState = merged.terminalState;
    if (merged.technicalMessage !== undefined) failure.technicalMessage = merged.technicalMessage;
    if (merged.evidence !== undefined) failure.evidence = merged.evidence;
    return failure;
  }

  // Accept / Undo has a two-state user lifecycle: actionable before the page
  // action, terminal after a successful page action. Warning-class verification
  // evidence can still be recorded in technical details, but it must not keep
  // the primary buttons actionable after Overleaf accepted the operation.

  // Codes that imply post-Accept proof is missing or contradicted. A page-side
  // emitter (T4) is expected to fill these in; render-time normalization from
  // the FailureReasons module repairs legacy `{ ok: false, code, reason }`
  // shapes into the same structured failure record so this matrix works
  // uniformly across both shapes.
  const ACCEPT_NEEDS_REVIEW_CODES = new Set([
    'tracked_changes_remain',
    'accept_not_verified',
    'tracked_changes_created_unexpectedly',
    'accept_replay_created_tracked_changes',
    'write_observed_mismatch'
  ]);

  const REJECT_NEEDS_REVIEW_CODES = new Set([
    'undo_not_verified',
    'undo_operation_failed',
    'undo_reviewing_restore_unverified',
    'tracked_change_nodes_not_identified',
    'tracked_changes_remain',
    'write_observed_mismatch'
  ]);

  // Walks the page-layer result's applied/skipped lists, normalizing each
  // item's `result` (whether structured `failure` or legacy `code` + `reason`)
  // into a `FailureReason` record. Used by `applyAcceptSettlement` /
  // `applyRejectSettlement` to decide between `accepted`/`rejected`,
  // `needs_review`, and "stay pending" (blocked).
  function collectFailuresFromResult(result) {
    const failures = [];
    if (!result || typeof result !== 'object') {
      return failures;
    }
    if (FailureReasons && FailureReasons.normalizeFailureReason instanceof Function) {
      for (const entry of Array.isArray(result.skipped) ? result.skipped : []) {
        const inner = (entry && entry.result) || entry;
        if (!inner || inner.ok === true) continue;
        const operation = (entry && entry.operation) || (entry && entry.trackedChange ? { path: entry.trackedChange.path } : undefined);
        failures.push(FailureReasons.normalizeFailureReason(inner, operation));
      }
      for (const entry of Array.isArray(result.applied) ? result.applied : []) {
        const inner = entry && entry.result;
        if (!inner || inner.ok !== false) continue;
        const operation = (entry && entry.operation) || (entry && entry.trackedChange ? { path: entry.trackedChange.path } : undefined);
        failures.push(FailureReasons.normalizeFailureReason(inner, operation));
      }
    } else {
      // Defensive fallback: the FailureReasons module should be present in
      // production (loaded by the content script bundle) but tests that strip
      // it out should still see the legacy code-only path treated as a
      // generic non-blocking failure.
      for (const entry of Array.isArray(result.skipped) ? result.skipped : []) {
        const inner = (entry && entry.result) || entry;
        if (inner && inner.ok !== true) {
          failures.push({
            code: (inner && typeof inner.code === 'string' ? inner.code : '') || 'unknown_legacy_failure',
            severity: 'error'
          });
        }
      }
    }
    return failures;
  }

  // Run-card settlement for Accept changes. Three branches:
  //   1. The primary failure is `blocked` (e.g. preflight / navigation refused
  //      to touch Overleaf) — stay pending so the user can retry without the
  //      card claiming terminal accepted.
  //   2. Any successful page-side accept work — settle as terminal `accepted`.
  //   3. Otherwise, unverified/no-op failures can remain retryable.
  function applyAcceptSettlement(runId, result) {
    const failures = collectFailuresFromResult(result);
    const primary = FailureReasons && FailureReasons.selectPrimaryFailure instanceof Function
      ? FailureReasons.selectPrimaryFailure(failures)
      : (failures[0] || null);
    if (primary && primary.terminalState === 'blocked') {
      // Stay pending — page bridge declined the operation before any document
      // change. The preceding result event already showed the user the reason.
      refreshRunCardControls(runId);
      return;
    }
    if (isSuccessfulTrackedChangeSettlement(result)) {
      applyTerminalTrackedChangeStatus(runId, 'accepted');
      return;
    }
    const needsReview = failures.some(failure =>
      failure.terminalState === 'needs_review' ||
      ACCEPT_NEEDS_REVIEW_CODES.has(failure.code)
    );
    if (needsReview) {
      applyNeedsReviewTrackedChangeStatus(runId);
      return;
    }
    applyTerminalTrackedChangeStatus(runId, 'accepted');
  }

  // Same three-branch shape as `applyAcceptSettlement`, using the undo-side
  // unverified-proof codes only when no successful reject/undo work happened.
  function applyRejectSettlement(runId, result) {
    const failures = collectFailuresFromResult(result);
    const primary = FailureReasons && FailureReasons.selectPrimaryFailure instanceof Function
      ? FailureReasons.selectPrimaryFailure(failures)
      : (failures[0] || null);
    if (primary && primary.terminalState === 'blocked') {
      refreshRunCardControls(runId);
      return;
    }
    if (isSuccessfulTrackedChangeSettlement(result)) {
      applyTerminalTrackedChangeStatus(runId, 'rejected');
      return;
    }
    const needsReview = failures.some(failure =>
      failure.terminalState === 'needs_review' ||
      REJECT_NEEDS_REVIEW_CODES.has(failure.code)
    );
    if (needsReview) {
      applyNeedsReviewTrackedChangeStatus(runId);
      return;
    }
    applyTerminalTrackedChangeStatus(runId, 'rejected');
  }

  function isSuccessfulTrackedChangeSettlement(result) {
    if (!result || typeof result !== 'object') {
      return false;
    }
    if (result.ok === true) {
      return true;
    }
    if (!Array.isArray(result.applied)) {
      return false;
    }
    return result.applied.some(entry => {
      const inner = entry && (entry.result || entry);
      return !inner || inner.ok !== false;
    });
  }

  // Sets `needs_review` on a run without emptying refs — the user is supposed
  // to retry Accept or Undo after inspecting Overleaf, so the heavy payload
  // (tracked-change refs + expected files) must survive.
  function applyNeedsReviewTrackedChangeStatus(runId) {
    const run = findRunRecord(runId);
    if (!run) {
      return;
    }
    run.trackedChangeStatus = 'needs_review';
    saveStateSoon();
    refreshRunCardControls(runId);
  }

  function getRunUndoCount(run) {
    if (!run) {
      return 0;
    }
    const trackedEditorUndoCount = hasTrackedEditorUndo(run) ? 1 : 0;
    if (trackedEditorUndoCount) {
      return trackedEditorUndoCount;
    }
    return (run.undoOperations?.length || 0)
      + (run.undoTrackedChanges?.length || 0);
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
    if (!operation || typeof operation !== 'object') {
      return operation;
    }
    if (operation.type === 'edit' && typeof result?.verifiedContent === 'string') {
      return { ...operation, verifiedContent: result.verifiedContent };
    }
    return operation;
  }

  function recordUndoFromApply(project, applyResult) {
    const appliedEntries = getAppliedEntries(applyResult);
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

    const combinedAppliedOperations = [
      ...(Array.isArray(record.appliedOperations) ? record.appliedOperations : []),
      ...appliedOperations
    ];
    record.appliedOperations = combinedAppliedOperations;

    if (state.requireReviewing === true) {
      const combinedTrackedChanges = mergeTrackedChanges([
        ...(Array.isArray(record.undoTrackedChanges) ? record.undoTrackedChanges : []),
        ...trackedChanges
      ]);
      record.undoOperations = [];
      record.undoBaseFiles = [];
      record.undoTrackedChanges = combinedTrackedChanges;
      record.undoExpectedFiles = selectExpectedFilesForTrackedUndo(project, combinedAppliedOperations, combinedTrackedChanges);
      record.undoStatus = '';
      record.partialWriteback = skippedEntries.length > 0;
      // Recording tracked-change refs enters the run into the tracked-change
      // lifecycle as `pending`. A run that records no refs stays a legacy-undo
      // run (native editor undo / no identifiable tracked changes).
      if (combinedTrackedChanges.length) {
        record.trackedChangeStatus = 'pending';
      }
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

    const checkpoint = buildUndoCheckpoint(project, combinedAppliedOperations);
    if (!checkpoint.undoOperations.length) {
      return;
    }

    record.undoOperations = checkpoint.undoOperations;
    record.undoBaseFiles = checkpoint.undoBaseFiles;
    record.undoTrackedChanges = [];
    record.undoExpectedFiles = selectExpectedFilesForTrackedUndo(project, combinedAppliedOperations, []);
    record.undoStatus = '';
    record.partialWriteback = skippedEntries.length > 0;
    refreshRunCardControls(record.id);
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
    const seen = new Set();
    const normalized = [];
    for (const change of changes || []) {
      const key = typeof change?.key === 'string' ? change.key : '';
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      normalized.push({
        key,
        id: typeof change.id === 'string' ? change.id : '',
        path: typeof change.path === 'string' ? change.path : '',
        label: typeof change.label === 'string' ? change.label : ''
      });
    }
    return normalized;
  }

  function mergeTrackedChanges(changes = []) {
    return normalizeApplyTrackedChanges(changes);
  }

  function selectExpectedFilesForTrackedUndo(project, operations = [], trackedChanges = []) {
    const paths = new Set();
    for (const change of trackedChanges || []) {
      if (change.path) {
        paths.add(change.path);
      }
    }
    for (const operation of operations || []) {
      if (operation?.path) {
        paths.add(operation.path);
      }
      if (operation?.to) {
        paths.add(operation.to);
      }
    }
    return (project?.files || [])
      .filter(file => paths.has(file.path) && typeof file.content === 'string')
      .map(file => ({
        path: file.path,
        content: file.content
      }));
  }

  function buildTrackedUndoPostFiles(run) {
    const expectedFiles = Array.isArray(run?.undoExpectedFiles) ? run.undoExpectedFiles : [];
    const appliedOperations = Array.isArray(run?.appliedOperations) ? run.appliedOperations : [];
    if (!expectedFiles.length || !appliedOperations.length) {
      return [];
    }

    const postFilesByPath = buildExpectedFilesAfterOperations(
      { files: expectedFiles },
      appliedOperations
    );
    const expectedPaths = new Set(expectedFiles.map(file => file?.path).filter(Boolean));
    return Array.from(postFilesByPath.entries())
      .filter(([path, content]) => expectedPaths.has(path) && typeof content === 'string')
      .map(([path, content]) => ({
        path,
        content
      }));
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
      technicalDetail: event.technicalDetail
    };
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

  function refreshRunCardControls(runId) {
    const run = findRunRecord(runId);
    const root = panel?.querySelector(`[data-run-id="${cssEscape(runId)}"]`);
    if (!run || !root) {
      return;
    }
    configureAcceptButton(root, run);
    configureUndoButton(root, run);
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
    const undoCount = getRunUndoCount(record);
    const report = buildHumanCompletionReport({
      ...input,
      locale: getLocale(),
      operations,
      applyResults,
      undoCount,
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
      failure: input.failure || undefined,
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
    if (input.status === 'rejected') {
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

    const last = region.lastElementChild;
    if (last?.classList?.contains('codex-toast') && last.dataset.baseText === value) {
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
    body.dataset.toastText = 'true';
    body.textContent = value;
    item.append(body);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'codex-toast-close';
    close.setAttribute('aria-label', tr('dismissNotification'));
    close.textContent = '×';
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
