(function initCodexOverleafOtWarmMirror() {
  'use strict';

  // Experimental OT warm-mirror glue carved out of contentRuntime.js (v1.4.9
  // structural-debt phase 5): the per-project enable toggle flow, the
  // poll/flush timers and patch queue, mirror prefetch, warm-start
  // resolution, and the OT status display. Code moved verbatim; runtime
  // collaborators are factory-injected and mutable runtime state is read
  // through lazy getters (panel state writes go back through setState). The
  // OT/prefetch view state below moved here with the code that owns it; the
  // runtime reads it through the exported accessors and clears it on project
  // navigation via clearMirrorPrefetchTimer()/releaseOtWarmMirrorProject().
  function create(deps = {}) {
    const {
      otWarmMirrorController,
      runController,
      mirrorHealth,
      projectFiles
    } = deps;
    const {
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
      getPanel,
      getState,
      setState,
      getCurrentRunView,
      RUN_SNAPSHOT_ZIP_TIMEOUT_MS
    } = deps;

  let currentOtStatus = 'off';
  let otSyncRequestId = 0;
  let otWarmMirrorProjectId = '';
  let lastExperimentalOtProjectId = '';
  let otWarmMirrorState = {
    projectId: '',
    pollTimer: null,
    flushTimer: null,
    flushing: false,
    patchQueue: [],
    lastStatus: 'off',
    lastPatchAt: 0,
    lastErrorCode: ''
  };
  let mirrorPrefetchState = {
    inFlight: null,
    lastSuccessAt: 0,
    lastErrorAt: 0,
    lastError: null,
    timer: null,
    projectId: ''
  };

  function getCurrentOtStatus() {
    return currentOtStatus;
  }

  function getOtWarmMirrorState() {
    return otWarmMirrorState;
  }

  function getLastExperimentalOtProjectId() {
    return lastExperimentalOtProjectId;
  }

  // Clear the mirror-prefetch retry timer (called by the runtime when leaving
  // a project, so a stale timer can't fire against the next project).
  function clearMirrorPrefetchTimer() {
    if (mirrorPrefetchState && mirrorPrefetchState.timer) {
      window.clearTimeout(mirrorPrefetchState.timer);
      mirrorPrefetchState.timer = null;
    }
  }

  // Reset the OT warm-mirror project binding when navigating away, so a stale
  // projectId can't trick the canPollOtWarmMirror check after navigation.
  function releaseOtWarmMirrorProject(prevProjectId) {
    if (otWarmMirrorProjectId === prevProjectId) {
      otWarmMirrorProjectId = '';
    }
    if (otWarmMirrorState && otWarmMirrorState.projectId === prevProjectId) {
      otWarmMirrorState.projectId = '';
    }
  }

  function isExperimentalOtEnabled() {
    const projectId = getCurrentProjectId();
    return isExperimentalOtEnabledForProject(projectId);
  }

  function isExperimentalOtEnabledForProject(projectId) {
    return getState()?.experimentalOtByProject?.[projectId] === true;
  }

  function setExperimentalOtEnabled(enabled) {
    const projectId = getCurrentProjectId();
    setExperimentalOtEnabledForProject(projectId, enabled);
  }

  function setExperimentalOtEnabledForProject(projectId, enabled) {
    if (!projectId) {
      return;
    }
    setState({
      ...getState(),
      experimentalOtByProject: {
        ...normalizeExperimentalOtByProject(getState()?.experimentalOtByProject),
        [projectId]: enabled === true
      }
    });
  }

  function normalizeExperimentalOtByProject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    const normalized = {};
    for (const key of Object.keys(value)) {
      if (key) {
        normalized[key] = value[key] === true;
      }
    }
    return normalized;
  }

  function syncExperimentalOtToggleForProject(projectId = getCurrentProjectId()) {
    lastExperimentalOtProjectId = projectId;
    const enabled = isExperimentalOtEnabledForProject(projectId);
    const experimentalOtCheckbox = getPanel()?.querySelector('[data-experimental-ot]');
    if (experimentalOtCheckbox) {
      experimentalOtCheckbox.checked = enabled;
    }
    updateExperimentalOtToggleControl(enabled);
    updateOtStatusDisplay(enabled
      ? (currentOtStatus === 'off' ? 'starting' : currentOtStatus)
      : 'off');
    return enabled;
  }

  async function handleExperimentalOtToggleClick(event) {
    // The handler is bound to the visible checkbox: by the time click fires,
    // pre-click activation has ALREADY flipped .checked — that flipped value
    // is the user's intended target. preventDefault then rolls the visual
    // state back (synchronously, when dispatch completes), and the confirm
    // flow applies the target only after approval.
    const clicked = event?.currentTarget || event?.target;
    const targetEnabled = clicked && typeof clicked.checked === 'boolean' ? clicked.checked : undefined;
    event.preventDefault();
    await toggleExperimentalOtCheckbox(targetEnabled);
  }

  async function handleExperimentalOtToggleKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    await toggleExperimentalOtCheckbox();
  }

  async function toggleExperimentalOtCheckbox(targetEnabled) {
    const checkbox = getPanel()?.querySelector('[data-experimental-ot]');
    if (!checkbox) {
      return;
    }
    // Explicit target from the click interceptor wins; the keyboard/legacy
    // path (no argument, un-flipped checkbox) falls back to inversion.
    const nextEnabled = typeof targetEnabled === 'boolean' ? targetEnabled : !checkbox.checked;
    if (nextEnabled) {
      closeDiagnosticsMenu();
      const approved = await showPluginConfirm({
        title: tr('experimentalOtConfirmTitle'),
        message: tr('experimentalOtConfirmMessage'),
        confirmLabel: tr('experimentalOtConfirmEnable'),
        cancelLabel: tr('confirmDefaultCancel')
      });
      if (!approved) {
        return;
      }
    } else {
      closeDiagnosticsMenu();
    }
    checkbox.checked = nextEnabled;
    handleExperimentalOtToggleChange({ currentTarget: checkbox });
    if (nextEnabled) {
      showPluginToast(tr('experimentalOtEnabledToast'), { status: 'info' });
    }
  }

  function handleExperimentalOtToggleChange(event) {
    const checkbox = event?.currentTarget || getPanel()?.querySelector('[data-experimental-ot]');
    if (!checkbox) {
      return;
    }
    const projectId = getCurrentProjectId();
    lastExperimentalOtProjectId = projectId;
    setExperimentalOtEnabledForProject(projectId, checkbox.checked);
    updateExperimentalOtToggleControl(checkbox.checked);
    // Per-card saved feedback, same contract as every other settings card.
    const savedBadge = getPanel()?.querySelector('details[data-set-group="experimental"] [data-set-saved]');
    if (savedBadge) {
      savedBadge.hidden = false;
      if (savedBadge._savedFlashTimer) {
        clearTimeout(savedBadge._savedFlashTimer);
      }
      savedBadge._savedFlashTimer = setTimeout(() => {
        savedBadge.hidden = true;
      }, 1600);
    }
    updateOtStatusDisplay(checkbox.checked ? (currentOtStatus === 'off' ? 'starting' : currentOtStatus) : 'off');
    syncOtWarmMirrorController().catch(error => {
      updateOtStatusDisplay('unavailable');
      appendPlainLog(tx(`Experimental OT warm mirror unavailable: ${error.message}`, `实验性 OT 预热镜像不可用：${error.message}`));
    });
    saveStateSoon();
  }

  function updateExperimentalOtToggleControl(enabled) {
    // The visible switch (the checkbox itself) is the single control; keep it
    // in sync for programmatic changes, then refresh the status line.
    const checkbox = getPanel()?.querySelector('[data-experimental-ot]');
    if (checkbox) {
      checkbox.checked = enabled === true;
    }
    updateExperimentalOtMenuStatus();
  }

  async function syncOtWarmMirrorController() {
    const projectId = getCurrentProjectId();
    const requestId = ++otSyncRequestId;
    const enabled = isExperimentalOtEnabledForProject(projectId);
    otWarmMirrorProjectId = projectId;
    ensureOtWarmMirrorStateProject(projectId);
    if (enabled) {
      const pause = otWarmMirrorController?.shouldPauseOtWarmMirror?.({ running: Boolean(getCurrentRunView()) }) || { pause: false };
      if (pause.pause) {
        clearOtEventPolling({ clearPatchQueue: true });
        otWarmMirrorState.lastErrorCode = pause.reason || 'paused';
        updateOtStatusDisplay('stale');
        return { ok: true, skipped: true, reason: pause.reason || 'paused' };
      }
      updateOtStatusDisplay('starting');
    } else {
      clearOtEventPolling({ clearPatchQueue: true });
    }
    const response = enabled
      ? await callPageBridge('startOtObserver', { projectId })
      : await callPageBridge('stopOtObserver', {});
    if (!isCurrentOtSync(requestId, projectId) || getCurrentProjectId() !== projectId) {
      if (enabled) {
        await handleStaleOtStartResponse(projectId, requestId);
      }
      return response;
    }
    if (!enabled) {
      if (!isSuccessfulOtBridgeResponse(response)) {
        updateOtStatusDisplay('unavailable');
        return response;
      }
      updateOtStatusDisplay('off');
      return response;
    }
    const status = readOtBridgeStatus(response);
    if (!isSuccessfulOtBridgeResponse(response) || status === 'unavailable') {
      handleFailedOtStart(projectId, requestId);
      return response;
    }
    const pauseAfterStart = otWarmMirrorController?.shouldPauseOtWarmMirror?.({ running: Boolean(getCurrentRunView()) }) || { pause: false };
    if (pauseAfterStart.pause) {
      await pauseOtWarmMirror(pauseAfterStart.reason || 'paused');
      return response;
    }
    updateOtStatusDisplay(status);
    scheduleOtEventPolling(projectId, { immediate: true });
    return response;
  }

  function isCurrentOtSync(requestId, projectId) {
    return requestId === otSyncRequestId && projectId === otWarmMirrorProjectId;
  }

  function isSuccessfulOtBridgeResponse(response) {
    return Boolean(response) && response.ok !== false;
  }

  async function handleStaleOtStartResponse(projectId, requestId) {
    if (isCurrentOtSync(requestId, projectId) && getCurrentProjectId() === projectId) {
      return;
    }
    clearOtEventPolling({ clearPatchQueue: true });
    await callPageBridge('stopOtObserver', {});
    if (isExperimentalOtEnabled()) {
      await syncOtWarmMirrorController();
    }
  }

  function handleFailedOtStart(projectId, requestId) {
    if (!isCurrentOtSync(requestId, projectId) || getCurrentProjectId() !== projectId) {
      return;
    }
    clearOtEventPolling({ clearPatchQueue: true });
    setExperimentalOtEnabledForProject(projectId, false);
    const experimentalOtCheckbox = getPanel()?.querySelector('[data-experimental-ot]');
    if (experimentalOtCheckbox) {
      experimentalOtCheckbox.checked = false;
    }
    updateOtStatusDisplay('unavailable');
    saveStateSoon();
  }

  function readOtBridgeStatus(response) {
    if (!response || response.ok === false) {
      return 'unavailable';
    }
    return response.getState() || response.status || response.result?.getState() || response.result?.status || 'unavailable';
  }

  function ensureOtWarmMirrorStateProject(projectId) {
    if (!projectId || otWarmMirrorState.projectId === projectId) {
      return;
    }
    clearOtEventPolling({ clearPatchQueue: true });
    otWarmMirrorState.projectId = projectId;
    otWarmMirrorState.lastPatchAt = 0;
    otWarmMirrorState.lastErrorCode = '';
    otWarmMirrorState.lastStatus = currentOtStatus;
  }

  function clearOtEventPolling(options = {}) {
    if (otWarmMirrorState.pollTimer) {
      window.clearTimeout(otWarmMirrorState.pollTimer);
      otWarmMirrorState.pollTimer = null;
    }
    if (otWarmMirrorState.flushTimer) {
      window.clearTimeout(otWarmMirrorState.flushTimer);
      otWarmMirrorState.flushTimer = null;
    }
    if (options.clearPatchQueue !== false) {
      otWarmMirrorState.patchQueue = [];
    }
  }

  function scheduleOtEventPolling(projectId = getCurrentProjectId(), options = {}) {
    if (!canPollOtWarmMirror(projectId)) {
      return;
    }
    ensureOtWarmMirrorStateProject(projectId);
    if (otWarmMirrorState.pollTimer) {
      window.clearTimeout(otWarmMirrorState.pollTimer);
    }
    const delayMs = options.immediate
      ? 0
      : Math.max(0, Number(otWarmMirrorController?.OT_POLL_INTERVAL_MS) || 1000);
    otWarmMirrorState.pollTimer = window.setTimeout(() => {
      otWarmMirrorState.pollTimer = null;
      pollOtEvents(projectId).catch(error => {
        otWarmMirrorState.lastErrorCode = error?.code || error?.message || 'ot_poll_failed';
        updateOtStatusDisplay('unavailable');
      });
    }, delayMs);
  }

  function canPollOtWarmMirror(projectId) {
    return Boolean(projectId
      && otWarmMirrorController?.shouldPauseOtWarmMirror
      && otWarmMirrorController?.buildPatchFilesRequest
      && isExperimentalOtEnabledForProject(projectId)
      && otWarmMirrorProjectId === projectId
      && getCurrentProjectId() === projectId);
  }

  async function pollOtEvents(projectId = otWarmMirrorState.projectId || getCurrentProjectId()) {
    if (!canPollOtWarmMirror(projectId)) {
      clearOtEventPolling({ clearPatchQueue: true });
      return { ok: false, skipped: true, reason: 'not_current_project' };
    }

    const pause = otWarmMirrorController.shouldPauseOtWarmMirror({ running: Boolean(getCurrentRunView()) });
    if (pause.pause) {
      otWarmMirrorState.lastErrorCode = pause.reason || 'paused';
      updateOtStatusDisplay('stale');
      clearOtEventPolling({ clearPatchQueue: false });
      return { ok: false, skipped: true, reason: pause.reason || 'paused' };
    }

    try {
      const statusResponse = await callPageBridge('getOtStatus', { projectId });
      if (!canPollOtWarmMirror(projectId)) {
        return { ok: false, skipped: true, reason: 'project_changed' };
      }
      if (!isSuccessfulOtBridgeResponse(statusResponse)) {
        otWarmMirrorState.lastErrorCode = readOtBridgeErrorCode(statusResponse, 'get_ot_status_failed');
        updateOtStatusDisplay('unavailable');
        return statusResponse;
      }
      const status = readOtBridgeStatus(statusResponse);
      if (status) {
        updateOtStatusDisplay(status);
      }

      const drainResponse = await callPageBridge('drainOtEvents', { projectId });
      if (!canPollOtWarmMirror(projectId)) {
        return { ok: false, skipped: true, reason: 'project_changed' };
      }
      if (!isSuccessfulOtBridgeResponse(drainResponse)) {
        otWarmMirrorState.lastErrorCode = readOtBridgeErrorCode(drainResponse, 'drain_ot_events_failed');
        updateOtStatusDisplay('unavailable');
        return drainResponse;
      }
      const events = readOtBridgeEvents(drainResponse);
      if (events.length) {
        queueOtPatchEvents(events, projectId);
      }
      return drainResponse;
    } catch (error) {
      otWarmMirrorState.lastErrorCode = error?.code || error?.message || 'ot_poll_failed';
      updateOtStatusDisplay('unavailable');
      return { ok: false, error };
    } finally {
      if (canPollOtWarmMirror(projectId) && !getCurrentRunView()) {
        scheduleOtEventPolling(projectId);
      }
    }
  }

  function readOtBridgeEvents(response) {
    if (Array.isArray(response)) {
      return response;
    }
    if (Array.isArray(response?.events)) {
      return response.events;
    }
    if (Array.isArray(response?.result?.events)) {
      return response.result.events;
    }
    return [];
  }

  function readOtBridgeErrorCode(response, fallback) {
    const value = response?.lastErrorCode
      || response?.reason
      || response?.error?.code
      || response?.error
      || fallback;
    return typeof value === 'string' ? value : fallback;
  }

  function queueOtPatchEvents(events, projectId = getCurrentProjectId()) {
    if (!Array.isArray(events) || !events.length || !canPollOtWarmMirror(projectId)) {
      return;
    }
    ensureOtWarmMirrorStateProject(projectId);
    otWarmMirrorState.patchQueue.push(...events);
    scheduleOtPatchFlush(projectId);
  }

  function scheduleOtPatchFlush(projectId = otWarmMirrorState.projectId || getCurrentProjectId(), options = {}) {
    if (!canPollOtWarmMirror(projectId) || !otWarmMirrorState.patchQueue.length) {
      return;
    }
    if (otWarmMirrorState.flushTimer) {
      window.clearTimeout(otWarmMirrorState.flushTimer);
    }
    const delayMs = options.immediate
      ? 0
      : Math.max(0, Number(otWarmMirrorController?.OT_PATCH_DEBOUNCE_MS) || 500);
    otWarmMirrorState.flushTimer = window.setTimeout(() => {
      otWarmMirrorState.flushTimer = null;
      flushOtPatchBatch(projectId).catch(error => {
        otWarmMirrorState.lastErrorCode = error?.code || error?.message || 'ot_patch_failed';
        updateOtStatusDisplay('inconsistent');
      });
    }, delayMs);
  }

  async function flushOtPatchBatch(projectId = otWarmMirrorState.projectId || getCurrentProjectId()) {
    if (otWarmMirrorState.flushing) {
      return { ok: false, skipped: true, reason: 'ot_patch_in_flight' };
    }
    if (!canPollOtWarmMirror(projectId)) {
      clearOtEventPolling({ clearPatchQueue: true });
      return { ok: false, skipped: true, reason: 'not_current_project' };
    }

    const pause = otWarmMirrorController.shouldPauseOtWarmMirror({ running: Boolean(getCurrentRunView()) });
    if (pause.pause) {
      otWarmMirrorState.lastErrorCode = pause.reason || 'paused';
      updateOtStatusDisplay('stale');
      clearOtEventPolling({ clearPatchQueue: false });
      return { ok: false, skipped: true, reason: pause.reason || 'paused' };
    }

    const maxBatch = Math.max(1, Number(otWarmMirrorController?.OT_MAX_PATCH_BATCH) || 25);
    const batch = otWarmMirrorState.patchQueue.splice(0, maxBatch);
    if (!batch.length) {
      return { ok: true, skipped: true, reason: 'empty_batch' };
    }

    otWarmMirrorState.flushing = true;
    try {
      const request = {
        ...otWarmMirrorController.buildPatchFilesRequest({ projectId, events: batch }),
        method: 'mirror.patchFiles'
      };
      if (!Array.isArray(request.params?.files) || request.params.files.length === 0) {
        return { ok: true, skipped: true, reason: 'empty_filtered_batch' };
      }
      if (!canPollOtWarmMirror(projectId)) {
        return { ok: false, skipped: true, reason: 'project_changed' };
      }

      const response = await sendBackgroundNative(request);
      if (!response?.ok) {
        otWarmMirrorState.lastErrorCode = response?.error?.code || response?.error?.message || 'mirror_patch_failed';
        updateOtStatusDisplay('inconsistent');
        return response;
      }

      const result = response.result || {};
      const skippedFiles = Array.isArray(result?.skippedFiles) ? result.skippedFiles : [];
      const skippedCount = Number.isFinite(Number(result?.skippedCount))
        ? Number(result.skippedCount)
        : skippedFiles.length;
      if (skippedFiles.length || skippedCount > 0) {
        otWarmMirrorState.lastErrorCode = 'mirror_patch_skipped';
        updateOtStatusDisplay('inconsistent');
        return response;
      }
      const appliedFiles = Array.isArray(result?.appliedFiles) ? result.appliedFiles : null;
      const appliedCount = Number.isFinite(Number(result?.appliedCount))
        ? Number(result.appliedCount)
        : NaN;
      if (!appliedFiles || !Number.isFinite(appliedCount) || appliedCount <= 0 || appliedFiles.length !== appliedCount) {
        otWarmMirrorState.lastErrorCode = 'mirror_patch_invalid_result';
        updateOtStatusDisplay('inconsistent');
        return response;
      }

      otWarmMirrorState.lastPatchAt = Date.now();
      otWarmMirrorState.lastErrorCode = '';
      if (canPollOtWarmMirror(projectId)) {
        updateOtStatusDisplay('observing');
      }
      return response;
    } catch (error) {
      otWarmMirrorState.lastErrorCode = error?.code || error?.message || 'mirror_patch_failed';
      updateOtStatusDisplay('inconsistent');
      return { ok: false, error };
    } finally {
      otWarmMirrorState.flushing = false;
      if (otWarmMirrorState.patchQueue.length && canPollOtWarmMirror(projectId) && !getCurrentRunView()) {
        scheduleOtPatchFlush(projectId, { immediate: true });
      }
    }
  }

  async function pauseOtWarmMirror(reason = 'pause') {
    const projectId = getCurrentProjectId();
    clearOtEventPolling({ clearPatchQueue: true });
    if (!isExperimentalOtEnabledForProject(projectId)) {
      return { ok: true, skipped: true, reason: 'disabled' };
    }
    ensureOtWarmMirrorStateProject(projectId);
    otWarmMirrorState.lastErrorCode = reason;
    updateOtStatusDisplay('stale');
    try {
      const response = await callPageBridge('stopOtObserver', { projectId, reason });
      if (!isSuccessfulOtBridgeResponse(response)) {
        otWarmMirrorState.lastErrorCode = readOtBridgeErrorCode(response, 'pause_ot_observer_failed');
        updateOtStatusDisplay('unavailable');
      }
      return response;
    } catch (error) {
      otWarmMirrorState.lastErrorCode = error?.code || error?.message || 'pause_ot_observer_failed';
      updateOtStatusDisplay('unavailable');
      return { ok: false, error };
    }
  }

  async function resumeOtWarmMirror(reason = 'resume') {
    const projectId = getCurrentProjectId();
    if (!isExperimentalOtEnabledForProject(projectId)) {
      return { ok: true, skipped: true, reason: 'disabled' };
    }
    try {
      return await syncOtWarmMirrorController({ reason });
    } catch (error) {
      otWarmMirrorState.lastErrorCode = error?.code || error?.message || 'resume_ot_observer_failed';
      updateOtStatusDisplay('unavailable');
      return { ok: false, error };
    }
  }

  function updateOtStatusDisplay(status = currentOtStatus) {
    const normalized = normalizeOtStatus(status);
    currentOtStatus = normalized;
    otWarmMirrorState.lastStatus = normalized;
    const statusElement = getPanel()?.querySelector('[data-ot-status]');
    if (statusElement) {
      const label = formatOtStatusLabel(normalized);
      statusElement.textContent = formatOtToggleStatusText(label);
      statusElement.dataset.otStatus = normalized;
      statusElement.title = formatOtToggleStatusText(label);
    }
    updateExperimentalOtMenuStatus();
    updateProbeStatusOtSuffix();
  }

  function formatOtStatusLabel(status) {
    const labels = {
      off: 'otStatusOff',
      starting: 'otStatusStarting',
      observing: 'otStatusObserving',
      unavailable: 'otStatusUnavailable',
      stale: 'otStatusStale',
      inconsistent: 'otStatusInconsistent'
    };
    return tr(labels[normalizeOtStatus(status)] || 'otStatusUnavailable');
  }

  function formatOtToggleStatusText(label) {
    return `OT: ${label}`;
  }

  function updateExperimentalOtMenuStatus() {
    const statusElement = getPanel()?.querySelector('[data-experimental-ot-menu-status]');
    if (!statusElement) {
      return;
    }
    statusElement.textContent = formatOtToggleStatusText(formatOtStatusLabel(currentOtStatus));
  }

  function normalizeOtStatus(status) {
    const value = typeof status === 'string' ? status : '';
    return ['off', 'starting', 'observing', 'unavailable', 'stale', 'inconsistent'].includes(value)
      ? value
      : 'unavailable';
  }

  function scheduleMirrorPrefetch(options = {}) {
    syncMirrorPrefetchStateForProject();
    if (!mirrorHealth?.shouldStartPrefetch) {
      return;
    }
    const delayMs = Math.max(0, Number(options.delayMs) || 0);
    if (mirrorPrefetchState.timer) {
      window.clearTimeout(mirrorPrefetchState.timer);
      mirrorPrefetchState.timer = null;
    }
    mirrorPrefetchState.timer = window.setTimeout(() => {
      mirrorPrefetchState.timer = null;
      syncMirrorPrefetch({ reason: options.reason || 'deferred' }).catch(error => {
        mirrorPrefetchState.lastErrorAt = Date.now();
        mirrorPrefetchState.lastError = error?.message || String(error);
      });
    }, delayMs);
  }

  function isExpectedPrefetchSkip(errorOrResponse) {
    const code = errorOrResponse?.error?.code || errorOrResponse?.code || '';
    const message = errorOrResponse?.error?.message || errorOrResponse?.message || String(errorOrResponse || '');
    return code === 'project_locked'
      || code === 'project_changed'
      || /project_locked|project changed|project_changed|navigation/i.test(message);
  }

  async function syncMirrorPrefetch(options = {}) {
    syncMirrorPrefetchStateForProject();
    const projectId = getCurrentProjectId();
    const now = Date.now();
    const readiness = mirrorHealth?.shouldStartPrefetch?.({
      ...mirrorPrefetchState,
      busy: Boolean(getCurrentRunView()),
      now
    }) || { ok: false, reason: 'unavailable' };
    if (!readiness.ok) {
      return { ok: false, skipped: true, reason: readiness.reason };
    }

    mirrorPrefetchState.projectId = projectId;
    mirrorPrefetchState.lastAttemptAt = now;
    const inFlight = (async () => {
      const project = sanitizeRunProjectSnapshot(await callPageBridge('getProjectSnapshot', {
        force: false,
        maxAgeMs: 30000,
        preferLightweight: false,
        allowZipFallback: true,
        allowEditorNavigation: false,
        requireFullProject: true,
        includeBinaryFiles: true,
        zipOnly: true,
        zipTimeoutMs: RUN_SNAPSHOT_ZIP_TIMEOUT_MS
      }));
      if (getCurrentProjectId() !== projectId) {
        return { ok: false, skipped: true, reason: 'project_changed' };
      }
      if (project?.capabilities?.fullProjectSnapshot !== true) {
        return { ok: false, skipped: true, reason: 'not_full_project' };
      }
      const response = await sendBackgroundNative({
        method: 'mirror.sync',
        params: {
          projectId,
          project,
          reason: options.reason || 'prefetch'
        }
      });
      if (!response?.ok) {
        if (isExpectedPrefetchSkip(response)) {
          return { ok: false, skipped: true, reason: response?.error?.code || 'expected_busy' };
        }
        throw new Error(response?.error?.message || 'mirror.sync failed');
      }
      if (getCurrentProjectId() !== projectId) {
        return { ok: false, skipped: true, reason: 'project_changed' };
      }
      mirrorPrefetchState.lastSuccessAt = Date.now();
      mirrorPrefetchState.lastError = null;
      return { ok: true };
    })();

    mirrorPrefetchState.inFlight = inFlight;
    try {
      return await inFlight;
    } catch (error) {
      if (isExpectedPrefetchSkip(error)) {
        return { ok: false, skipped: true, reason: error?.code || error?.message || 'expected_busy' };
      }
      mirrorPrefetchState.lastErrorAt = Date.now();
      mirrorPrefetchState.lastError = error?.message || String(error);
      return { ok: false, error };
    } finally {
      if (mirrorPrefetchState.inFlight === inFlight) {
        mirrorPrefetchState.inFlight = null;
      }
    }
  }

  async function settleMirrorPrefetchBeforeRun() {
    syncMirrorPrefetchStateForProject();
    if (mirrorPrefetchState.timer) {
      window.clearTimeout(mirrorPrefetchState.timer);
      mirrorPrefetchState.timer = null;
    }
    if (!mirrorPrefetchState.inFlight) {
      return;
    }
    try {
      await mirrorPrefetchState.inFlight;
    } catch (error) {
      if (!isExpectedPrefetchSkip(error)) {
        mirrorPrefetchState.lastErrorAt = Date.now();
        mirrorPrefetchState.lastError = error?.message || String(error);
      }
    }
  }

  function isMirrorReusable(mirrorStatus) {
    const health = mirrorHealth?.classifyMirrorHealth?.(mirrorStatus) || { reusable: false };
    return health.reusable === true;
  }

  async function resolveWarmRunStart(taskContext = {}) {
    const focusFiles = taskContext.focusFiles || [];
    const mode = taskContext.mode || getState()?.mode;
    const mirrorStatus = await getMirrorFreshness();
    const otWarmStart = otWarmMirrorController.canUseOtWarmStart({
      enabled: isExperimentalOtEnabled(),
      focusFiles,
      mirrorStatus
    });
    if (otWarmStart.ok) {
      return {
        useExistingMirror: true,
        warmStart: true,
        otWarmStart: true,
        reason: 'ot_focus_fresh',
        mirrorStatus,
        focusFiles: otWarmStart.focusFiles,
        project: {
          capabilities: {
            fullProjectSnapshot: false,
            method: 'ot-warm-mirror'
          },
          files: []
        }
      };
    }
    if (!mirrorStatus?.exists || !isMirrorReusable(mirrorStatus)) {
      return { useExistingMirror: false, reason: 'mirror_not_fresh', mirrorStatus };
    }

    let overlayProject = null;
    try {
      overlayProject = await callPageBridge('getProjectSnapshot', {
        force: true,
        maxAgeMs: 0,
        preferLightweight: true,
        allowZipFallback: false,
        allowEditorNavigation: false,
        restrictToRequestedPathsOnly: true,
        requireFullProject: false,
        includeBinaryFiles: false,
        focusFiles
      });
    } catch (error) {
      return { useExistingMirror: false, reason: 'overlay_probe_failed', mirrorStatus };
    }
    const fileOverlays = buildSnapshotFileOverlays(overlayProject, focusFiles);
    if (!fileOverlays.length) {
      return { useExistingMirror: false, reason: 'missing_current_overlay', mirrorStatus };
    }
    if (focusFiles.length && !focusFiles.every(path => {
      const normalized = normalizeSnapshotPath(path);
      return fileOverlays.some(file => normalizeSnapshotPath(file.path) === normalized);
    })) {
      return { useExistingMirror: false, reason: 'missing_focus_overlay', mirrorStatus };
    }

    return {
      useExistingMirror: true,
      warmStart: true,
      reason: mode === 'ask' ? 'warm_whole_project_ask' : 'warm_whole_project',
      mirrorStatus,
      fileOverlays,
      project: overlayProject
    };
  }

  async function prepareMirrorStaleRetry({ project = {}, focusFiles = [] } = {}) {
    throwIfRunCancellationRequested();
    appendLog(formatProjectSnapshotUserLog(project));
    const snapshotWarnings = getProjectSnapshotWarnings(project);
    const focusedPartialSnapshot = runController.canUseFocusedPartialSnapshot({
      project,
      snapshotWarnings,
      focusFiles,
      isUsableProjectFileContent: projectFiles.isUsableProjectFileContent
    });
    if (snapshotWarnings.blocking.length && !focusedPartialSnapshot) {
      for (const warning of snapshotWarnings.blocking) {
        appendLog(tx(`Cannot continue: ${formatProjectSnapshotWarning(warning)}`, `无法继续：${formatProjectSnapshotWarning(warning)}`));
      }
      appendCompletionReport({
        conclusion: tr('warmMirrorStaleBlockedConclusion'),
        status: 'blocked',
        operations: [],
        applyResults: [],
        nextStep: tr('warmMirrorStaleBlockedNextStep')
      });
      finishRunView(tr('warmMirrorStaleBlockedTitle'), 'failed');
      return { ok: false };
    }
    if (focusedPartialSnapshot) {
      appendRunEvent({
        title: tx(
          `Only selected context files were read: ${focusFiles.join(', ')}. This retry will read and write only these files.`,
          `只读到你选择的上下文文件：${focusFiles.join(', ')}；本次重试将只基于这些文件运行和写回。`
        ),
        status: 'completed'
      });
    }
    return {
      ok: true,
      project,
      restrictToFocusFiles: runController.shouldRestrictWritebackToFocus({ focusFiles, focusedPartialSnapshot })
    };
  }

  function syncMirrorPrefetchStateForProject() {
    const projectId = getCurrentProjectId();
    const projectChanged = Boolean(mirrorPrefetchState.projectId && mirrorPrefetchState.projectId !== projectId);
    syncCustomInstructionsEditorForProject(projectId, { force: projectChanged });
    syncOtWarmMirrorStateForProject();
    if (!mirrorPrefetchState.projectId || !projectChanged) {
      return;
    }
    if (mirrorPrefetchState.timer) {
      window.clearTimeout(mirrorPrefetchState.timer);
    }
    mirrorPrefetchState = {
      inFlight: mirrorPrefetchState.inFlight,
      lastSuccessAt: 0,
      lastErrorAt: 0,
      lastError: null,
      timer: null,
      projectId
    };
  }

  function syncOtWarmMirrorStateForProject() {
    const projectId = getCurrentProjectId();
    syncExperimentalOtToggleForProject(projectId);
    if (!otWarmMirrorProjectId) {
      otWarmMirrorProjectId = projectId;
      return;
    }
    if (otWarmMirrorProjectId === projectId) {
      return;
    }
    clearOtEventPolling({ clearPatchQueue: true });
    otWarmMirrorProjectId = projectId;
    otSyncRequestId++;
    callPageBridge('stopOtObserver', {}).then(response => {
      if (!isSuccessfulOtBridgeResponse(response)) {
        updateOtStatusDisplay('unavailable');
      }
      return syncOtWarmMirrorController();
    }).catch(error => {
      updateOtStatusDisplay('unavailable');
      appendPlainLog(tx(`Experimental OT warm mirror unavailable: ${error.message}`, `实验性 OT 预热镜像不可用：${error.message}`));
    });
  }

    return {
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
    };
  }

  window.CodexOverleafOtWarmMirror = { create };
})();
