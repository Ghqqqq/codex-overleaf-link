(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./runRecoveryActions'));
  else root.CodexOverleafModuleRegistry.define('RunTimelineView', ['RunRecoveryActions'], factory);
})(typeof window !== 'undefined' ? window : globalThis, function (RunRecoveryActions) {
  'use strict';


  // Owns scroll, cards, reports and mature run actions. The optional activity
  // presenter projects stored events without taking ownership of settlement.
  function create(deps = {}) {
    const {
      RunActivitySummary,
      RunPresence,
      PanelIcons,
      RunActivityModel,
      SubagentActivityView,
      RunGuidanceView,
      getPendingGuidance = () => [],
      RunResultActions,
      RunScrollLayout,
      RunFailureNotice,
      I18n,
      FailureReasons,
      projectContextLimitEvent = value => value,
      localizeVisibleReason = value => value,
      localizeCompileReason = value => value,
      tr,
      tx,
      getLocale,
      formatElapsed,
      findRunRecord,
      forceCancelStuckTaskForCurrentProject,
      formatEventDetail,
      formatEventTime,
      renderAttachmentPreviewList,
      renderSentSelection,
      formatModeLabel,
      undoRun,
      acceptRun,
      getRunUndoCount,
      cssEscape,
      renderMarkdownInlineText,
      renderMarkdownBlockText,
      decorateCompletionReport,
      sanitizeAssistantVisibleText,
      sanitizeAssistantVisibleValue,
      stripEmptyHtmlCommentPlaceholders = value => value,
      buildMarkdownInlineNodes,
      getPanel,
      getState,
      getCurrentRunView,
      refillComposerForRetry,
      canEditRun,
      retryWriteback,
      showNativeSetupGuidance,
      openProjectFileForFailure,
      openStorageSettings,
      trackedChangeInFlight,
      projectRunSettlement,
      getCurrentProjectId,
      getAccountScopeId,
      getProjectName
    } = deps;

  let logAutoFollow = true;
  let userScrollIntentUntil = 0;
  let userScrollExtent = '';
  // Scroll engine: a single rAF coalesces a burst of scroll requests into one
  // write per frame (streaming can fire ~25/sec); `scrollLogPendingForce`
  // survives that coalesce so a forced scroll is never lost. `unreadSinceDetach`
  // drives the floating "jump to latest" button's counter.
  let scrollLogRafId = 0;
  let scrollLogPendingForce = false;
  let pendingGuidanceReveal = null;
  let jumpToLatestButton = null;
  let unreadSinceDetach = 0;
  // Elapsed time belongs to the run; tool rows retain their own lifecycle.
  let runElapsedTimer = null;
  const scrollLayout = RunScrollLayout?.create({
    getScroller: getLogScrollContainer,
    isFollowing: () => logAutoFollow,
    onLayoutChange: scroller => logAutoFollow ? scrollLogToBottom() : updateJumpToLatestButton(scroller)
  });
  const failureNotice = RunFailureNotice?.create({ tr, projectRunSettlement, sanitizeText: sanitizeAssistantVisibleText });
  const { buildRecoveryButton, appendRecoveryActionForFailure } = RunRecoveryActions.create({
    document: typeof document === 'undefined' ? undefined : document,
    window: typeof window === 'undefined' ? undefined : window,
    tx, failureNotice, refillComposerForRetry, openProjectFileForFailure, showNativeSetupGuidance,
    openStorageSettings, forceCancelStuckTaskForCurrentProject
  });
  const presence = RunPresence?.create({ tx, getLocale, formatElapsed });
  const displayRun = run => RunFailureNotice?.projectResolvedUndo?.(run) || run;
  const displayLocalizedRun = run => {
    const displayed = displayRun(run);
    return displayed ? { ...displayed, events: (displayed.events || []).map(sanitizeRunEventForRender) } : displayed;
  };
  const activitySummary = RunActivitySummary?.create({ RunActivityModel, RunGuidanceView, getPendingGuidance, SubagentActivityView, PanelIcons, tx, findRunRecord: (...args) => displayLocalizedRun(findRunRecord(...args)), getPanel, cssEscape,
    projectReviewResultEvent: sanitizeRunEventForRender,
    formatReviewResultFailure,
    formatEventTime, formatElapsed, renderMarkdownBlockText, renderRunEvent, formatEventDetail,
    presence, classifyStatus: classifyRunPresence, getProjectId: () => getCurrentProjectId?.() || '',
    summarizeCommand: RunPresence?.commandSummary,
    isGuidance: event => Boolean(RunGuidanceView.getGuidanceText(event)), sanitizeAssistantVisibleText });

  // Re-arm auto-follow (called by the runtime when a new run starts, so the
  // log snaps back to following the live stream).
  function resetAutoFollow() {
    logAutoFollow = true;
    userScrollIntentUntil = 0;
    pendingGuidanceReveal = null;
  }

  function bindLogAutoFollow() {
    const scroller = getLogScrollContainer();
    scrollLayout?.bind(scroller);
    if (!scroller || scroller.dataset.autoFollowBound === 'true') {
      return;
    }
    scroller.dataset.autoFollowBound = 'true';
    scroller.addEventListener('wheel', markUserScrollIntent, { passive: true });
    scroller.addEventListener('touchmove', markUserScrollIntent, { passive: true });
    scroller.addEventListener('pointerdown', markUserScrollIntent, { passive: true });
    scroller.addEventListener('keydown', event => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
        markUserScrollIntent(event);
      }
    });
    scroller.addEventListener('scroll', () => {
      if (Date.now() <= userScrollIntentUntil && userScrollExtent === `${scroller.scrollHeight}:${scroller.clientHeight}`) {
        logAutoFollow = isLogNearBottom(scroller);
      }
      scrollLayout?.captureAnchor();
      // Reveal / hide the floating "jump to latest" button the instant the
      // user detaches from or re-reaches the bottom.
      updateJumpToLatestButton(scroller);
    }, { passive: true });
  }

  // Floating "↓ latest" affordance. Lives in the non-scrolling thread section
  // (sibling layer above the scroll container) so it stays pinned while the
  // user reads backscroll. Shown only while detached from the bottom.
  function ensureJumpToLatestButton() {
    if (jumpToLatestButton && jumpToLatestButton.isConnected) {
      return jumpToLatestButton;
    }
    const scroller = getLogScrollContainer();
    const host = scroller?.closest?.('.codex-thread-section') || scroller?.parentElement;
    if (!host) {
      return null;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tl-jump-latest';
    button.hidden = true;
    button.addEventListener('click', event => {
      event.stopPropagation();
      unreadSinceDetach = 0;
      scrollLogToBottom({ force: true });
    });
    host.append(button);
    jumpToLatestButton = button;
    return button;
  }

  function updateJumpToLatestButton(scroller) {
    const el = scroller || getLogScrollContainer();
    if (!el) {
      return;
    }
    if (el.dataset) el.dataset.logAutoFollow = logAutoFollow ? 'true' : 'false';
    const button = ensureJumpToLatestButton();
    if (!button) {
      return;
    }
    if (isLogNearBottom(el)) {
      unreadSinceDetach = 0;
      button.hidden = true;
      return;
    }
    button.hidden = false;
    button.textContent = unreadSinceDetach > 0
      ? tx(`↓ Latest · ${unreadSinceDetach}`, `↓ 最新 · ${unreadSinceDetach}`)
      : tx('↓ Latest', '↓ 最新');
    button.setAttribute('aria-label', unreadSinceDetach > 0
      ? tx(`Jump to latest, ${unreadSinceDetach} new steps`, `跳到最新，${unreadSinceDetach} 个新步骤`)
      : tx('Jump to latest', '跳到最新'));
  }

  // Called by the event-append path so the unread counter only counts discrete
  // steps (activity / report) while the user is scrolled up — streaming deltas
  // that update an existing line in place do not inflate the count.
  function bumpUnreadIfDetached() {
    const el = getLogScrollContainer();
    if (el && !isLogNearBottom(el)) {
      unreadSinceDetach += 1;
    }
  }

  function getLogScrollContainer() {
    return getPanel()?.querySelector('[data-log]') || getPanel()?.querySelector('[data-main]');
  }

  function markUserScrollIntent(event) {
    const scroller = getLogScrollContainer();
    if (!scroller || (event?.type === 'pointerdown' && event.target !== scroller)) return;
    if (event?.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    userScrollIntentUntil = Date.now() + 1200;
    userScrollExtent = `${scroller.scrollHeight}:${scroller.clientHeight}`;
    if ((event?.type === 'wheel' && event.deltaY < 0) || ['ArrowUp', 'PageUp', 'Home'].includes(event?.key)) {
      logAutoFollow = false;
      scrollLogPendingForce = false;
      pendingGuidanceReveal = null;
    }
  }

  function isLogNearBottom(log) {
    if (!log) {
      return true;
    }
    return log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  }

  function scrollLogToBottom(options = {}) {
    if (activitySummary?.isSubagentViewOpen?.()) return;
    const scroller = getLogScrollContainer();
    if (!scroller) {
      return;
    }
    const force = options.force === true;
    if (force) {
      // A forced scroll (user submitted a run, clicked "jump to latest", etc.)
      // re-arms auto-follow and clears any stale user-scroll intent.
      logAutoFollow = true;
      userScrollIntentUntil = 0;
      unreadSinceDetach = 0;
      scrollLogPendingForce = true;
      pendingGuidanceReveal = null;
    } else if (!logAutoFollow) {
      // The user has scrolled up: do not yank them. Just keep the jump button
      // state current.
      updateJumpToLatestButton(scroller);
      return;
    }

    const writeNow = () => {
      const el = getLogScrollContainer();
      if (!el) {
        return;
      }
      // Re-check intent AT PAINT TIME: a user who flicked up between schedule
      // and paint must not be snapped back down (closes the one-frame fight).
      if (scrollLogPendingForce || logAutoFollow) {
        setLogScrollPosition(el);
      }
      scrollLogPendingForce = false;
      updateJumpToLatestButton(el);
    };

    if (typeof window.requestAnimationFrame !== 'function') {
      writeNow();
      return;
    }
    // Coalesce a burst into one write per frame (no more double reflow).
    if (scrollLogRafId) {
      return;
    }
    scrollLogRafId = window.requestAnimationFrame(() => {
      scrollLogRafId = 0;
      writeNow();
    });
  }
  function revealGuidance(row) {
    if (!logAutoFollow || activitySummary?.isSubagentViewOpen?.() || !getLogScrollContainer()?.contains?.(row)) return false;
    pendingGuidanceReveal = row;
    scrollLogToBottom();
    return true;
  }
  function setLogScrollPosition(scroller) {
    const reveal = pendingGuidanceReveal;
    pendingGuidanceReveal = null;
    const result = reveal && scrollLayout?.revealGuidance(reveal);
    if (result) {
      logAutoFollow = result.following;
      if (!logAutoFollow) scrollLayout.captureAnchor(true);
      return;
    }
    scroller.scrollTop = scroller.scrollHeight;
  }
  function collapseRunProcess(view, statusText) {
    if (activitySummary) { activitySummary.settle(view, statusText); return; }
    const runProcess = view?.runProcess || view?.root?.querySelector('[data-run-process]');
    if (runProcess) {
      runProcess.open = false;
    }
    const statusEl = view?.status || view?.root?.querySelector('[data-run-status]');
    if (statusEl) {
      // Append the step count to the collapsed header ("Processed 18s · 6 steps")
      // so the user sees how much work the run did without expanding it.
      const record = view?.recordId ? findRunRecord(view.recordId, view.sessionId) : null;
      const stepCount = (record?.events || []).filter(event => (event.kind || 'activity') === 'activity').length;
      statusEl.textContent = stepCount > 0
        ? `${statusText} · ${tx(`${stepCount} steps`, `${stepCount} 步`)}`
        : statusText;
    }
  }

  // Keep elapsed labels live without creating new activity records.
  function startRunElapsedTick() {
    stopRunElapsedTick();
    if (typeof window.setInterval !== 'function') {
      return;
    }
    runElapsedTimer = window.setInterval(() => {
      if (!getCurrentRunView()) {
        stopRunElapsedTick();
        return;
      }
      if (activitySummary?.update(getCurrentRunView()) && presence) return;
      const statusEl = getCurrentRunView().status
        || getCurrentRunView().root?.querySelector('[data-run-status]');
      if (statusEl) {
        statusEl.textContent = tr('processing', {
          elapsed: formatElapsed(Date.now() - getCurrentRunView().startedAt)
        });
      }
    }, 1000);
  }

  function stopRunElapsedTick() {
    if (runElapsedTimer && typeof window.clearInterval === 'function') {
      window.clearInterval(runElapsedTimer);
    }
    runElapsedTimer = null;
  }

  function classifyRunPresence(run = {}) {
    if (run.retryingWriteback) return 'plain';
    if (run.status === 'completed') return 'done';
    if (run.status === 'cancelled' || run.status === 'rejected') return 'stopped';
    return run.status === 'failed' || run.status === 'abandoned_after_navigation' ? 'failed' : 'plain';
  }

  function formatProcessedSummary(status, elapsedMs) {
    const elapsed = formatElapsed(elapsedMs);
    if (status === 'failed') {
      return tr('processedFailed', { elapsed });
    }
    if (status === 'rejected' || status === 'cancelled') {
      return tr('processedCancelled', { elapsed });
    }
    if (status === 'running') {
      return tr('processing', { elapsed });
    }
    return tr('processed', { elapsed });
  }
  function renderRunHistory(options = {}) {
    activitySummary?.closeSubagentView?.();
    const log = getPanel()?.querySelector('[data-log]');
    if (!log) {
      return;
    }
    const reading = options.preserveScroll === true && !logAutoFollow
      ? scrollLayout?.snapshot() || { scrollTop: log.scrollTop } : null;
    log.replaceChildren();
    if (!getState().runs?.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-runs';
      const icon = document.createElement('img');
      icon.className = 'codex-empty-icon';
      icon.alt = '';
      icon.setAttribute('aria-hidden', 'true');
      icon.src = chrome.runtime.getURL('assets/icons/codex-overleaf-icon.png');
      const label = document.createElement('div');
      label.textContent = tr('emptyRunLabel');
      const hint = document.createElement('div');
      hint.className = 'empty-runs-hint';
      hint.textContent = tr('emptyRunsHint');
      label.className = 'empty-runs-title';
      empty.append(icon, label, hint);
      if (presence) {
        icon.remove();
        presence.decorateEmpty(empty, { projectName: getProjectName?.() || '' });
      }
      log.append(empty);
      return;
    }
    const runs = getState().runs;
    if (runs.length >= 20) {
      const truncated = document.createElement('div');
      truncated.className = 'run-history-truncated';
      truncated.textContent = tr('runsTruncatedNote');
      log.append(truncated);
    }
    for (const run of runs) {
      log.append(renderRunCard(run));
    }
    if (reading) { log.scrollTop = reading.scrollTop; scrollLayout?.restore(reading); updateJumpToLatestButton(log); }
    else scrollLogToBottom({ force: true });
  }

  function renderRunCard(run) {
    run = displayLocalizedRun(run);
    const root = document.createElement('section');
    root.className = 'transcript-turn run-card';
    root.dataset.status = run.status || 'completed';
    root.dataset.runId = run.id;
    root.title = [
      `${tr('mode')}: ${formatModeLabel(run.mode)}`,
      run.model,
      run.reasoningEffort,
      run.speedTier,
      run.startedAt ? formatEventTime(run.startedAt) : ''
    ].filter(Boolean).join(' · ');
    root.innerHTML = `
      <div class="transcript-turn-main">
        <div class="run-attachments codex-attachment-preview-list" data-run-attachments hidden></div>
        <div class="run-selection" data-run-selection hidden></div>
        <div class="run-prompt" data-run-task></div>
        <div class="run-guidance-list" data-run-guidance></div>
        <div class="run-turn-meta">
          <button type="button" data-run-accept hidden title="Accept this run's tracked changes in Overleaf">Accept changes</button>
          <button type="button" data-run-undo hidden title="Undo this run's writes to Overleaf">Undo</button>
          <button type="button" class="run-copy-action run-edit-action" data-run-edit hidden></button>
          <button type="button" class="run-copy-action run-sync-action" data-run-sync-retry hidden></button>
        </div>
        <details class="run-process" data-run-process>
          <summary data-run-process-summary>
            <span class="run-status" data-run-status></span>
            <span class="run-scan" aria-hidden="true"></span>
          </summary>
        </details>
        <div class="run-activity-list" data-run-events></div>
        <div class="run-result-actions" hidden>
          <button type="button" class="run-copy-action" data-run-copy hidden></button>
          <button type="button" class="run-fork-action" data-run-fork hidden></button>
          <span class="run-completed-time" data-run-completed-time hidden></span>
        </div>
        <div class="run-report" data-run-report aria-live="polite" hidden></div>
      </div>
    `;

    renderAttachmentPreviewList(run.attachments, root.querySelector('[data-run-attachments]'), { readonly: true });
    renderSentSelection?.(root.querySelector('[data-run-selection]'), run.executionSnapshot?.selectionContext, { document, tx });
    const runTask = root.querySelector('[data-run-task]');
    runTask.classList.add('run-user-message');
    runTask.textContent = run.task || '';
    root.querySelector('[data-run-status]').textContent = getRunStatusText(run);
    const process = root.querySelector('[data-run-process]');
    process.open = run.status === 'running';

    const guidance = root.querySelector('[data-run-guidance]');
    const events = root.querySelector('[data-run-events]');
    const eventListId = `codex-run-events-${String(run.id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    events.id = eventListId;
    root.querySelector('[data-run-process-summary]')?.setAttribute('aria-controls', eventListId);
    const report = root.querySelector('[data-run-report]');
    if ((run.events || []).length >= 300) {
      const truncated = document.createElement('div');
      truncated.className = 'run-history-truncated';
      truncated.textContent = tr('eventsTruncatedNote');
      events.append(truncated);
    }
    if (!activitySummary) RunGuidanceView.reconcileGuidance?.(guidance, (run.events || []).concat(getPendingGuidance(run)), tx, { active: run.status === 'running' });
    for (const event of run.events || []) {
      if (event.kind === 'report') {
        report.hidden = false;
        report.replaceChildren(renderCompletionReport(event, run));
      } else if (activitySummary || event.kind === 'technical') {
        continue;
      } else if (RunGuidanceView.getGuidanceText(event)) {
        continue;
      } else if (event.kind === 'stream') {
        upsertStreamEvent({ events }, event);
      } else {
        appendActivityDetail({ events }, renderRunEvent(event), event);
      }
    }

    RunResultActions.configureResultActions(root, run);
    configureAcceptButton(root, run);
    configureUndoButton(root, run);
    configureEditButton(root, run);
    configureWritebackButton(root, run);
    activitySummary?.mount(root, run);
    return root;
  }

  function getRunStatusText(run = {}) {
    if (run.retryingWriteback) return tx('Checking file sync', '正在检查文件同步');
    if (['Stopped tracking after a page refresh', '页面刷新后已停止跟踪'].includes(run.statusText)) return tr('restoredRunStoppedStatus');
    const knownStatus = /^(?:Done|Failed|Cancelled|Running|已处理|处理失败|已取消|处理中)(?:\s+[\d.]+(?:ms|s|m|h|秒|分钟)(?:\s+[\d.]+(?:ms|s|m|h|秒|分钟))*)?$/.test(run.statusText || '');
    if (knownStatus) {
      const elapsed = String(run.statusText).replace(/^(?:Done|Failed|Cancelled|Running|已处理|处理失败|已取消|处理中)\s*/, '');
      const key = run.status === 'running' ? 'processing' : run.status === 'failed' ? 'processedFailed'
        : ['rejected', 'cancelled'].includes(run.status) ? 'processedCancelled' : 'processed';
      return tr(key, { elapsed }).trim();
    }
    if (run.statusText) {
      return run.statusText;
    }
    if (run.status === 'running') {
      return tr('processing', { elapsed: '' }).trim();
    }
    if (run.startedAt && run.finishedAt) {
      return formatProcessedSummary(run.status || 'completed', new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime());
    }
    if (run.status === 'rejected' || run.status === 'cancelled') {
      return tx('Cancelled', '已取消');
    }
    return run.status === 'failed' ? tx('Failed', '处理失败') : tx('Done', '已处理');
  }

  function renderRunEvent(event) {
    const normalized = sanitizeRunEventForRender(event);
    const guidanceText = RunGuidanceView.getGuidanceText(normalized);
    return guidanceText
      ? RunGuidanceView.renderGuidanceMessage(normalized, guidanceText, tx)
      : renderActivityLine(normalized);
  }

  function upsertStreamEvent(view, event) {
    if (!view?.events) {
      return;
    }
    if (activitySummary?.update(view, event)) return;
    const streamKey = event.streamKey || event.streamRole || 'codex-stream';
    const selector = `[data-stream-key="${cssEscape(streamKey)}"]`;
    const existing = view.events.querySelector(selector);
    if (existing) {
      existing.dataset.status = event.status || 'running';
      existing.dataset.streamRole = event.streamRole || '';
      const text = existing.querySelector('[data-stream-text]');
      if (text) {
        if (event.streamRole === 'assistant') {
          renderMarkdownBlockText(text, event.title || '', { streaming: event.status === 'running' });
        } else {
          renderMarkdownInlineText(text, event.title || '');
        }
      }
      return;
    }
    appendActivityDetail(view, renderStreamEvent({ ...event, streamKey }), event);
  }

  function appendActivityDetail(view, row, event) {
    if (activitySummary) activitySummary.appendDetail(view, row, event);
    else view.events.append(row);
  }

  function renderStreamEvent(input) {
    const event = sanitizeRunEventForRender(input);
    const row = document.createElement('div');
    row.className = 'run-stream';
    row.dataset.status = event.status || 'running';
    row.dataset.streamKey = event.streamKey || event.streamRole || 'codex-stream';
    row.dataset.streamRole = event.streamRole || '';

    const text = document.createElement('div');
    text.className = 'run-stream-text';
    text.dataset.streamText = '';
    if (event.streamRole === 'assistant') {
      renderMarkdownBlockText(text, event.title || '', { streaming: event.status === 'running' });
    } else {
      renderMarkdownInlineText(text, event.title || '');
    }

    row.append(text);
    return row;
  }

  function sanitizeRunEventForRender(event = {}) {
    event = projectContextLimitEvent(event);
    const streamRole = sanitizeAssistantVisibleText(event.streamRole);
    const title = sanitizeAssistantVisibleText(event.title);
    const activity = !streamRole && (!event.kind || event.kind === 'activity') && !event.guidanceId;
    const localized = activity ? localizeProductActivity(title, sanitizeAssistantVisibleValue(event.detail)) : null;
    return {
      ...event,
      ...(activity && event.activity?.kind === 'compile' ? { activity: { ...event.activity, output: localizeCompileReason(event.activity.output) } } : {}),
      title: streamRole === 'reasoning'
        ? stripEmptyHtmlCommentPlaceholders(title)
        : localized?.title || title,
      status: sanitizeAssistantVisibleText(event.status),
      detail: localized?.detail ?? sanitizeAssistantVisibleValue(event.detail),
      technicalDetail: sanitizeAssistantVisibleValue(event.technicalDetail),
      streamKey: sanitizeAssistantVisibleText(event.streamKey),
      streamRole
    };
  }

  function localizeProductActivity(title, detail) {
    let known = false, nextTitle = title;
    const keys = ['undoUnsafeFullFileTitle', 'undoNoTraceTitle', 'undoFileSelectTitle', 'undoNoTraceStarted', 'undoTrackedTitle', 'undoNativeTitle', 'undoTrackedStarted', 'undoNativeStarted', 'undoSwitchedEditing', 'undoReviewingRestoreUnverified', 'runAcceptTrackedStarted', 'runAcceptTrackedFailed', 'undoResult', 'undoTrackedResult', 'undoNativeResult', 'runAcceptTrackedResult'];
    if (I18n?.t) outer: for (const key of keys) for (const locale of ['en', 'zh']) {
      const template = I18n.t(locale, key, { applied: '__APPLIED__', skipped: '__SKIPPED__' });
      const pattern = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('__APPLIED__', '(\\d+)').replace('__SKIPPED__', '(\\d+)');
      const match = new RegExp('^' + pattern + '$').exec(title);
      if (match) { known = true; nextTitle = tr(key, { applied: match[1], skipped: match[2] }); break outer; }
    }
    let countedTitle;
    const writeResult = /^(?:Write result: wrote (\d+) item\(s\), skipped (\d+)|写入结果：已写入 (\d+) 项，跳过 (\d+) 项)$/.exec(title);
    const governance = /^(?:Project governance blocked (\d+) write\(s\) before review\.|项目治理规则在审核前阻止了 (\d+) 项写入。)$/.exec(title);
    if (writeResult) {
      const applied = writeResult[1] ?? writeResult[3], skipped = writeResult[2] ?? writeResult[4];
      countedTitle = tx(`Write result: wrote ${applied} item(s), skipped ${skipped}`, `写入结果：已写入 ${applied} 项，跳过 ${skipped} 项`);
    } else if (governance) {
      const count = governance[1] ?? governance[2];
      countedTitle = tx(`Project governance blocked ${count} write(s) before review.`, `项目治理规则在审核前阻止了 ${count} 项写入。`);
    }
    const labels = ['detailAccepted', 'detailRejected', 'detailUndone', 'detailSkipped', 'detailFile', 'detailRecord', 'detailReason'];
    const project = (value, reason = false) => {
      if (typeof value === 'string') return reason ? localizeVisibleReason(value) : value;
      if (Array.isArray(value)) return value.map(item => project(item, reason));
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).map(([key, child]) => {
        const label = labels.find(id => ['en', 'zh'].some(locale => I18n?.t?.(locale, id) === key));
        return [label ? tr(label) : key, project(child, label === 'detailReason')];
      }));
    };
    return { title: countedTitle || (known ? nextTitle : localizeCompileReason(localizeVisibleReason(title))),
      detail: typeof detail === 'string' ? localizeVisibleReason(detail) : known ? project(detail) : detail };
  }
  function formatReviewResultFailure(failure) {
    if (failure?.code === 'unknown_legacy_failure' && (!failure.evidence?.originalCode || failure.evidence.originalCode === 'unknown_legacy_failure')
      && ['Unknown reason', '未知原因'].includes(failure.userMessage)) {
      failure = { ...failure, userMessage: tr('unknownReason') };
    }
    return FailureReasons?.formatFailureReasonForDisplay(failure, getLocale?.(), key => { const value = tr(key, failure?.file ? undefined : { file: tr('unknownFile'), activeFile: tr('unknownFile') }); return value && value !== key ? value : undefined; });
  }
  function renderActivityLine(input) {
    const event = sanitizeRunEventForRender(input);
    const row = document.createElement('div');
    row.className = 'run-activity';
    row.dataset.status = event.status || 'info';
    row.dataset.kind = event.kind || 'activity';
    if (event.subagent === true) {
      row.dataset.subagent = 'true';
    }
    row.title = sanitizeAssistantVisibleText(buildActivityTooltip(event));

    const marker = document.createElement('span');
    marker.className = 'run-activity-dot';
    marker.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'run-activity-title';
    label.append(...buildMarkdownInlineNodes(event.title || 'Event'));

    const time = document.createElement('time');
    time.className = 'run-activity-time';
    time.textContent = event.timestamp ? formatEventTime(event.timestamp) : '';

    row.append(marker, label, time);
    return row;
  }




  function buildActivityTooltip(event) {
    return [
      event?.title || '',
      event?.timestamp ? formatEventTime(event.timestamp) : ''
    ].filter(Boolean).join('\n');
  }

  // The result presenter owns parsing and current lifecycle metadata.
  const splitFlatCompletionReport = text => RunResultActions.splitFlatCompletionReport(text, tx);
  const projectCompletionMeta = (meta, run) => RunResultActions.projectCompletionMeta(meta, run, {
    tx, getLocale, tr, trackedChangeInFlight, isTrackedChangeLifecycleRun, projectRunSettlement,
    projectId: getCurrentProjectId?.(), accountScopeId: getAccountScopeId?.()
  });

  // The user's own open/closed choice per run survives card re-renders.
  const metaOpenChoices = new Map();

  // Renders the run-metadata rows (Why nothing changed / Write result / Undo /
  // Next) behind a one-line summary beneath the answer. Shared by the
  // structured and flat-fallback render paths so both demote identically.
  function appendCompletionMetaBlock(report, meta, run) {
    if (!Array.isArray(meta) || !meta.length) {
      return;
    }
    const rows = projectCompletionMeta(meta, run).filter(row => row?.label && row.value)
      .map(row => ({ ...row, shown: failureNotice?.formatMetaValue(report, row) ?? row.value }));
    if (!rows.length) return;
    const summary = RunResultActions.summarizeCompletionMeta(rows, run, {
      tx, failed: report.dataset.status === 'failed', unconfirmed: rows.some(row => row.shown !== row.value)
    });
    const metaBlock = document.createElement('dl');
    metaBlock.className = 'run-final-answer__meta';
    metaBlock.id = `codex-run-meta-${String(run?.id || 'report').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    for (const row of rows) {
      const dt = document.createElement('dt');
      dt.className = 'run-final-answer__meta-label';
      dt.textContent = row.label;
      if (row.key) dt.dataset.metaKey = row.key;
      const dd = document.createElement('dd');
      dd.className = 'run-final-answer__meta-value';
      dd.textContent = row.shown;
      if (summary.warnKeys.has(row.key)) dt.dataset.tone = dd.dataset.tone = 'warn';
      metaBlock.append(dt, dd);
    }
    const facts = document.createElement('div');
    facts.className = 'run-final-answer__facts';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'run-final-answer__facts-sum';
    toggle.setAttribute('aria-controls', metaBlock.id);
    summary.facts.forEach((fact, index) => {
      if (index) toggle.append(Object.assign(document.createElement('span'), { className: 'run-final-answer__facts-sep', textContent: '·' }));
      const item = Object.assign(document.createElement('span'), { className: 'run-final-answer__fact', textContent: fact.text });
      if (fact.tone) item.dataset.tone = fact.tone;
      item.dataset.fact = fact.key;
      toggle.append(item);
    });
    const more = Object.assign(document.createElement('span'), { className: 'run-final-answer__facts-more' });
    toggle.append(Object.assign(document.createElement('span'), { className: 'run-final-answer__facts-sep', textContent: '·' }), more);
    const setOpen = open => {
      facts.dataset.open = String(open);
      metaBlock.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      more.innerHTML = `${open ? tx('Hide', '收起') : tx('Details', '详情')}<svg class="codex-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m6 4 4 4-4 4"/></svg>`;
    };
    setOpen(metaOpenChoices.get(run?.id) ?? summary.open);
    toggle.addEventListener('click', event => {
      event.stopPropagation();
      const open = facts.dataset.open !== 'true';
      if (run?.id) metaOpenChoices.set(run.id, open);
      setOpen(open);
    });
    facts.append(toggle, metaBlock);
    report.append(facts);
  }

  function renderCompletionReport(input, run) {
    const event = sanitizeRunEventForRender(input);
    const report = document.createElement('section');
    report.className = 'run-completion-report';
    report.dataset.status = event.status || 'completed';
    // Compile errors captured post-write get a one-click fix loop: the
    // structured error list rides on the report event (compileErrors).
    const appendCompileFix = target => {
      const compileErrors = Array.isArray(event.compileErrors) ? event.compileErrors.filter(Boolean) : [];
      if (!compileErrors.length || typeof refillComposerForRetry !== 'function') {
        return;
      }
      const fix = buildRecoveryButton('compile_errors',
        tx(`Fix ${compileErrors.length} compile error(s)`, `修复 ${compileErrors.length} 个编译错误`),
        tx('Prefills a task with @compile-log and the captured errors.', '自动组一条带 @compile-log 和错误列表的任务。'));
      fix.addEventListener('click', clickEvent => {
        clickEvent.stopPropagation();
        const lines = compileErrors.slice(0, 5).map(item => `- ${item}`).join('\n');
        refillComposerForRetry(null, tx(
          `@compile-log Fix these LaTeX compile errors:\n${lines}`,
          `@compile-log 请修复以下 LaTeX 编译错误：\n${lines}`
        ));
      });
      target.append(fix);
    };
    // Rejected-hunk redo: quote what was dropped during review back into the
    // composer so the next turn can try a different approach.
    const appendRejectedRedo = target => {
      const rejectedHunks = Array.isArray(event.rejectedHunks) ? event.rejectedHunks.filter(item => item?.path) : [];
      if (!rejectedHunks.length || typeof refillComposerForRetry !== 'function') {
        return;
      }
      const redo = buildRecoveryButton('rejected_hunks',
        tx(`Redo ${rejectedHunks.length} rejected change(s) differently`, `换种方式重做 ${rejectedHunks.length} 处被拒改动`),
        tx('Prefills a task quoting each rejected change so Codex can try another approach.', '自动组一条任务，引用每处被拒的改动，让 Codex 换一种实现。'));
      redo.addEventListener('click', clickEvent => {
        clickEvent.stopPropagation();
        const lines = rejectedHunks.map(item => `- ${item.path}${item.summary ? ` (${item.summary})` : ''}`).join('\n');
        refillComposerForRetry(null, tx(
          `I rejected these proposed changes in review. Please take a different approach for:\n${lines}`,
          `以下改动在评审中被我拒绝了，请换一种方式重新实现：\n${lines}`
        ));
      });
      target.append(redo);
    };

    // Structured path: conclusion + body render as the Codex answer; meta
    // rows (Why nothing changed / Write result / Undo / Next) render as a
    // visually demoted block beneath, with a separator and muted color so
    // they read as run metadata rather than part of the answer.
    const structured = event.detailStructured;
    const hasStructured = structured
      && (structured.conclusion || structured.body || (Array.isArray(structured.meta) && structured.meta.length));
    if (hasStructured) {
      const main = document.createElement('div');
      main.className = 'run-final-answer';
      const mainSections = [];
      if (structured.conclusion) {
        mainSections.push(RunResultActions.projectCompletionConclusion?.(event, run, tx('en', 'zh'), { localizeCompileReason }) ?? String(structured.conclusion));
      }
      if (structured.body) {
        mainSections.push(RunResultActions.projectCompletionBody?.(structured.body, tx) ?? structured.body);
      }
      if (mainSections.length) {
        renderMarkdownBlockText(main, mainSections.join('\n\n'));
        decorateCompletionReport(main, { tx });
        report.append(main);
      }

      failureNotice?.append(report, event, run);
      appendCompletionMetaBlock(report, structured.meta, run);
      appendCompileFix(report);
      appendRejectedRedo(report);
      appendRecoveryActionForFailure(report, event, run);
      return report;
    }

    // Legacy fallback: events persisted before structured payloads were added
    // (and the recovered-history shape that uses `detail: { '结论': result }`).
    // Even without a structured payload, split the trailing status sections out
    // of the flat text so Write result / Undo / Next demote into the muted meta
    // block instead of reading as part of the answer.
    const flatText = formatEventDetail(event.detail || {});
    const split = splitFlatCompletionReport(flatText);
    const body = document.createElement('div');
    body.className = 'run-final-answer';
    renderMarkdownBlockText(body, RunResultActions.projectCompletionConclusion?.(event, run, tx('en', 'zh'),
      { flat: true, text: split.body || flatText, localizeCompileReason }) ?? (split.body || flatText));
    decorateCompletionReport(body, { tx });
    report.append(body);
    appendCompileFix(report);
    appendRejectedRedo(report);
    failureNotice?.append(report, event, run);
    appendCompletionMetaBlock(report, split.meta, run);
    appendRecoveryActionForFailure(report, event, run);
    return report;
  }

  // For failure codes that have an actionable recovery path the user can
  // invoke directly from the run card, append a button inside the completion
  // report. Today's only consumer is codex_project_locked → "Force-release
  // the stuck task" (covers the page-refresh-then-locked-out scenario where
  // the normal cancel button is hidden because currentRunView is null).
  // Recovery-action registry: failure codes whose "next step" is executable
  // from the panel get a button, not prose. One primary action per failure.
  // A run belongs to the tracked-change lifecycle iff trackedChangeStatus is set
  // or it still has tracked-change refs. Every other run is a legacy-undo run.
  function isTrackedChangeLifecycleRun(run) {
    if (!run) {
      return false;
    }
    if (typeof run.trackedChangeStatus === 'string' && run.trackedChangeStatus) {
      return true;
    }
    return Array.isArray(run.undoTrackedChanges) && run.undoTrackedChanges.length > 0;
  }

  function configureEditButton(root, run, options = {}) {
    const existing = root.querySelector('[data-run-edit]');
    if (!existing) return;
    const button = existing.cloneNode(true);
    existing.replaceWith(button);
    const available = ['cancelled', 'rejected'].includes(run?.status)
      && Boolean(String(run?.task || '').trim())
      && typeof canEditRun === 'function' && canEditRun(run)
      && typeof refillComposerForRetry === 'function';
    button.hidden = !available;
    if (!available) return;
    button.disabled = typeof options.running === 'boolean'
      ? options.running : Boolean(getCurrentRunView?.());
    button.title = tx('Edit & resend', '编辑后重发');
    button.setAttribute('aria-label', button.title);
    button.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12.8 3.2 4 4M3.5 16.5l4.2-.9 9-9a1.7 1.7 0 0 0 0-2.4l-.9-.9a1.7 1.7 0 0 0-2.4 0l-9 9z"/></svg>';
    button.addEventListener('click', event => {
      event.stopPropagation();
      if (getCurrentRunView?.()) return;
      refillComposerForRetry(run);
    });
  }

  function configureWritebackButton(root, run, options = {}) {
    const existing = root.querySelector('[data-run-sync-retry]');
    if (!existing) return;
    const button = existing.cloneNode(true);
    existing.replaceWith(button);
    const count = run?.retryWriteback?.operations?.length || 0;
    const available = !run?.forkSnapshot && (count || run?.saveCheck?.files?.length)
      && run.undoStatus !== 'applied' && run.trackedChangeStatus !== 'rejected' && typeof retryWriteback === 'function';
    button.hidden = !available;
    if (!available) return;
    button.disabled = typeof options.running === 'boolean' ? options.running : Boolean(getCurrentRunView?.());
    button.title = count ? tx('Retry sync (' + count + ' files)', '重试同步（' + count + ' 个文件）')
      : tx('Check save status', '检查保存状态');
    button.setAttribute('aria-label', button.title);
    button.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16.5 7A7 7 0 0 0 4 5L2 7m0-4v4h4M3.5 13A7 7 0 0 0 16 15l2-2m0 4v-4h-4"/></svg>';
    button.addEventListener('click', event => { event.stopPropagation(); if (!getCurrentRunView?.()) void retryWriteback(run.id); });
  }

  function configureUndoButton(root, run) {
    const existing = root.querySelector('[data-run-undo]');
    const button = existing.cloneNode(true);
    existing.replaceWith(button);

    if (run.forkSnapshot === true) {
      button.hidden = true;
      return;
    }

    if (isTrackedChangeLifecycleRun(run)) {
      configureLifecycleUndoButton(button, run);
      return;
    }

    const projection = RunResultActions.projectUndoAvailability(run, projectRunSettlement);
    if (!projection.canUndo && run.undoStatus !== 'applied') {
      button.hidden = true;
      return;
    }

    button.hidden = false;
    const inFlight = trackedChangeInFlight?.get(run.id) === 'reject';
    const applied = run.undoStatus === 'applied' && !inFlight;
    button.disabled = inFlight || (run.undoStatus === 'running' && !run.undoRecoveryCheckRequired) || run.undoStatus === 'applied';
    button.textContent = applied
      ? tr('undoApplied')
      : (run.partialWriteback ? tr('undoPartialRun') : tr('undoRun'));
    button.title = applied
      ? tr('undoAppliedTitle')
      : (run.partialWriteback ? tr('undoPartialRunTitle') : tr('undoRunTitle'));
    if (run.undoRecoveryUnavailable) button.title = tx('Undo recovery checks are unavailable. Reload this page after the connection recovers.', '撤销恢复检查暂不可用，请在连接恢复后重新加载此页面。');
    button.addEventListener('click', event => {
      event.stopPropagation();
      undoRun(run.id);
    });
  }

  // Renders the Undo button for a tracked-change-lifecycle run from
  // trackedChangeStatus. At a terminal status both buttons stay visible but
  // disabled: `rejected` shows the disabled "Undone" label, `accepted` keeps
  // Undo present but greyed. `pending` is actionable. `needs_review` is an
  // internal retryable proof state, but the primary UI still renders it as the
  // same executable state as `pending`.
  function configureLifecycleUndoButton(button, run) {
    const status = run.trackedChangeStatus || '';
    const inFlight = trackedChangeInFlight.get(run.id);
    const projection = projectRunSettlement(run);
    // §7 settlement matrix: needs_review keeps BOTH controls visible AND
    // actionable. Branch placed before the terminal branches so a
    // needs_review run is never treated as terminal.
    if (status === 'needs_review') {
      button.hidden = false;
      button.disabled = !projection.canUndo || inFlight === 'reject' || inFlight === 'accept';
      button.textContent = tr('undoRun');
      button.title = tr('undoRunTitle');
      button.addEventListener('click', event => {
        event.stopPropagation();
        undoRun(run.id);
      });
      return;
    }
    if (status === 'rejected' && !inFlight) {
      button.hidden = false;
      button.disabled = true;
      button.textContent = tr('undoApplied');
      button.title = tr('undoAppliedTitle');
      return;
    }
    if (status === 'accepted' && !inFlight) {
      // The run was accepted — terminal. Undo stays visible but greyed so the
      // card shows both controls disabled, never removed.
      button.hidden = false;
      button.disabled = true;
      button.textContent = tr('undoRun');
      button.title = tr('undoRunTitle');
      return;
    }
    if (status !== 'pending' && !inFlight) {
      button.hidden = true;
      return;
    }
    button.hidden = false;
    button.disabled = !projection.canUndo || inFlight === 'reject' || inFlight === 'accept';
    button.textContent = tr('undoRun');
    button.title = tr('undoRunTitle');
    button.addEventListener('click', event => {
      event.stopPropagation();
      undoRun(run.id);
    });
  }

  // The blue Accept All control. For legacy-undo runs it stays hidden — Accept
  // All only exists in the tracked-change lifecycle. Mirrors configureUndoButton's
  // clone-and-replace pattern, rendering from trackedChangeStatus.
  function configureAcceptButton(root, run) {
    // A re-render can fire mid-confirm, while wireAcceptInlineConfirm's
    // Confirm/Cancel pair is showing. Those are separate siblings, not the
    // [data-run-accept] node this rebuilds, so drop any stale pair first to
    // start every render from a clean state.
    for (const stale of root.querySelectorAll('[data-run-accept-confirm], [data-run-accept-cancel]')) {
      stale.remove();
    }

    const existing = root.querySelector('[data-run-accept]');
    const button = existing.cloneNode(true);
    existing.replaceWith(button);

    if (run.forkSnapshot === true) {
      button.hidden = true;
      return;
    }

    if (!isTrackedChangeLifecycleRun(run)) {
      const captures = run.undoStatus !== 'applied' && Array.isArray(run.trackedChangeCaptures) ? run.trackedChangeCaptures.filter(c => c && c.state !== 'observed') : [];
      button.hidden = !captures.length; button.disabled = true;
      button.textContent = tr('runAcceptTracked');
      button.title = captures.length ? tx('Tracked-change ownership is unconfirmed. Check the reasons below.', '本轮留痕归属尚未确认，请先核对下方原因。')
        + '\n' + captures.map(c => c.path + ': ' + (c.reason || c.state) + (c.diagnostics?.sourceReason ? ' / ' + c.diagnostics.sourceReason : '')).join('\n') : tr('runAcceptTrackedTitle');
      return;
    }

    const status = run.trackedChangeStatus || '';
    const inFlight = trackedChangeInFlight.get(run.id);
    const projection = projectRunSettlement(run);
    // §7 settlement matrix: needs_review keeps BOTH controls visible AND
    // actionable. It remains an internal retryable proof state, while the
    // primary button label stays in the same executable state as `pending`.
    if (status === 'needs_review') {
      button.hidden = false;
      button.disabled = !projection.canAccept || inFlight === 'accept' || inFlight === 'reject';
      if (inFlight === 'accept') {
        button.textContent = tr('runAcceptTrackedConfirming');
        button.title = tr('runAcceptTrackedConfirming');
        return;
      }
      button.textContent = tr('runAcceptTracked');
      button.title = tr('runAcceptTrackedTitle');
      wireAcceptInlineConfirm(button, run.id);
      return;
    }
    if (status === 'accepted' && !inFlight) {
      button.hidden = false;
      button.disabled = true;
      button.textContent = tr('runAcceptTrackedDone');
      button.title = tr('runAcceptTrackedDoneTitle');
      return;
    }
    if (status === 'rejected' && !inFlight) {
      // The run was rejected — terminal. Accept All stays visible but greyed so
      // the card shows both controls disabled, never removed.
      button.hidden = false;
      button.disabled = true;
      button.textContent = tr('runAcceptTracked');
      button.title = tr('runAcceptTrackedTitle');
      return;
    }
    if (status !== 'pending' && !inFlight) {
      button.hidden = true;
      return;
    }

    button.hidden = false;
    button.disabled = !projection.canAccept || inFlight === 'accept' || inFlight === 'reject';
    if (inFlight === 'accept') {
      button.textContent = tr('runAcceptTrackedConfirming');
      button.title = tr('runAcceptTrackedConfirming');
      return;
    }
    button.textContent = tr('runAcceptTracked');
    button.title = tr('runAcceptTrackedTitle');
    wireAcceptInlineConfirm(button, run.id);
  }

  // The inline confirm flow: the first click swaps Accept All for an inline
  // "Confirm accept / Cancel" pair; the accept dispatches only on Confirm.
  function wireAcceptInlineConfirm(button, runId) {
    button.addEventListener('click', event => {
      event.stopPropagation();
      const meta = button.parentElement;
      if (!meta) {
        return;
      }
      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.dataset.runAcceptConfirm = '';
      confirmBtn.textContent = tr('runAcceptTrackedConfirm');
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.dataset.runAcceptCancel = '';
      cancelBtn.textContent = tr('runAcceptTrackedCancel');

      button.hidden = true;
      meta.insertBefore(confirmBtn, button);
      meta.insertBefore(cancelBtn, button);

      cancelBtn.addEventListener('click', cancelEvent => {
        cancelEvent.stopPropagation();
        confirmBtn.remove();
        cancelBtn.remove();
        button.hidden = false;
      });
      confirmBtn.addEventListener('click', confirmEvent => {
        confirmEvent.stopPropagation();
        confirmBtn.disabled = true;
        cancelBtn.disabled = true;
        acceptRun(runId);
      });
    });
  }

  function refreshRunCard(runId) {
    const log = getPanel()?.querySelector('[data-log]');
    const existing = log?.querySelector(`[data-run-id="${cssEscape(runId)}"]`);
    const run = findRunRecord(runId);
    if (!log || !existing || !run || displayRun(run) === run) {
      return false;
    }
    const reading = scrollLayout?.snapshot(), open = existing.querySelector('[data-run-process]')?.open;
    const next = renderRunCard(run);
    const process = next.querySelector('[data-run-process]');
    if (process && typeof open === 'boolean') process.open = open;
    existing.replaceWith(next);
    if (reading) scrollLayout?.restore(reading);
    return true;
  }

  function refreshLocale() {
    const log = getPanel()?.querySelector('[data-log]');
    if (!log) return;
    if (!getState().runs?.length) { renderRunHistory({ preserveScroll: true }); return; }
    const reading = scrollLayout?.snapshot() || { scrollTop: log.scrollTop };
    for (const run of getState().runs) {
      const existing = log.querySelector(`[data-run-id="${cssEscape(run.id)}"]`);
      if (!existing) continue;
      const current = getCurrentRunView();
      if (current?.root === existing) {
        // Streaming owners retain their DOM references and buffered model text.
        const status = existing.querySelector('[data-run-status]');
        if (status) status.textContent = getRunStatusText(run);
        configureAcceptButton(existing, run); configureUndoButton(existing, run);
        configureEditButton(existing, run); configureWritebackButton(existing, run);
        RunResultActions.configureResultActions(existing, run);
        const reportEvent = (run.events || []).filter(event => event.kind === 'report').at(-1);
        const report = current.report || existing.querySelector('[data-run-report]');
        if (reportEvent && report) report.replaceChildren(renderCompletionReport(reportEvent, displayLocalizedRun(run)));
        activitySummary?.update(current);
        if (!activitySummary) RunGuidanceView.reconcileGuidance?.(existing.querySelector('[data-run-guidance]'),
          (run.events || []).concat(getPendingGuidance(run)), tx, { active: run.status === 'running' });
        continue;
      }
      const open = existing.querySelector('[data-run-process]')?.open;
      const next = renderRunCard(run);
      const process = next.querySelector('[data-run-process]');
      if (process && typeof open === 'boolean') process.open = open;
      existing.replaceWith(next);
    }
    log.scrollTop = reading.scrollTop;
    scrollLayout?.restore(reading);
    updateJumpToLatestButton(log);
  }

    return {
      refreshLocale,
      refreshResolvedUndo: refreshRunCard,
      refreshActivitySummary: activitySummary?.update,
      appendActivityDetail,
      resetAutoFollow,
      bindLogAutoFollow,
      bumpUnreadIfDetached,
      scrollLogToBottom,
      revealGuidance,
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
    };
  }

  return { create };
});
