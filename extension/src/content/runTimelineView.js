(function initCodexOverleafRunTimelineView() {
  'use strict';

  const RunGuidanceView = window.CodexOverleafRunGuidanceView;
  // Run-timeline view — the timeline render pipeline carved out of
  // contentRuntime.js (v1.4.6 structural-debt phase 2): the scroll engine +
  // jump-to-latest button, the live-elapsed tick and collapsed-header summary,
  // run-card / stream-event / activity rendering, the completion report, and
  // the run-card Undo/Accept controls. Code moved verbatim (original
  // indentation kept); runtime collaborators are factory-injected and mutable
  // runtime state (panel, panel state, the live run view) is read through lazy
  // getters. The view-local scroll/timer state below moved here with the code
  // that owns it.
  function create(deps = {}) {
    const {
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
      stripEmptyHtmlCommentPlaceholders = value => value,
      buildMarkdownInlineNodes,
      getPanel,
      getState,
      getCurrentRunView,
      refillComposerForRetry,
      showNativeSetupGuidance,
      openProjectFileForFailure,
      openStorageSettings,
      trackedChangeInFlight
    } = deps;

  let logAutoFollow = true;
  let userScrollIntentUntil = 0;
  // Scroll engine: a single rAF coalesces a burst of scroll requests into one
  // write per frame (streaming can fire ~25/sec); `scrollLogPendingForce`
  // survives that coalesce so a forced scroll is never lost. `unreadSinceDetach`
  // drives the floating "jump to latest" button's counter.
  let scrollLogRafId = 0;
  let scrollLogPendingForce = false;
  let jumpToLatestButton = null;
  let unreadSinceDetach = 0;
  // Live-elapsed tick for the sticky run-process header. Without it the header
  // reads a static "Processing…" and the user can't tell a working run from a
  // hung one — the single highest-value streaming signal per competitor UX.
  let runElapsedTimer = null;

  // Re-arm auto-follow (called by the runtime when a new run starts, so the
  // log snaps back to following the live stream).
  function resetAutoFollow() {
    logAutoFollow = true;
    userScrollIntentUntil = 0;
  }

  function bindLogAutoFollow() {
    const scroller = getLogScrollContainer();
    if (!scroller || scroller.dataset.autoFollowBound === 'true') {
      return;
    }
    scroller.dataset.autoFollowBound = 'true';
    scroller.addEventListener('wheel', markUserScrollIntent, { passive: true });
    scroller.addEventListener('touchmove', markUserScrollIntent, { passive: true });
    scroller.addEventListener('pointerdown', markUserScrollIntent, { passive: true });
    scroller.addEventListener('keydown', event => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
        markUserScrollIntent();
      }
    });
    scroller.addEventListener('scroll', () => {
      if (Date.now() <= userScrollIntentUntil) {
        logAutoFollow = isLogNearBottom(scroller);
      } else if (isLogNearBottom(scroller)) {
        logAutoFollow = true;
      }
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

  function markUserScrollIntent() {
    userScrollIntentUntil = Date.now() + 1200;
  }

  function isLogNearBottom(log) {
    if (!log) {
      return true;
    }
    return log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  }

  function scrollLogToBottom(options = {}) {
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
    } else if (!(logAutoFollow || isLogNearBottom(scroller))) {
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
      if (scrollLogPendingForce || logAutoFollow || isLogNearBottom(el)) {
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
  function setLogScrollPosition(scroller) {
    scroller.scrollTop = scroller.scrollHeight;
  }
  function collapseRunProcess(view, statusText) {
    const runProcess = view?.runProcess || view?.root?.querySelector('[data-run-process]');
    if (runProcess) {
      runProcess.open = false;
    }
    const statusEl = view?.status || view?.root?.querySelector('[data-run-status]');
    if (statusEl) {
      // Append the step count to the collapsed header ("Processed 18s · 6 steps")
      // so the user sees how much work the run did without expanding it.
      const stepCount = countRunActivitySteps(view);
      statusEl.textContent = stepCount > 0
        ? `${statusText} · ${tx(`${stepCount} steps`, `${stepCount} 步`)}`
        : statusText;
    }
  }

  function countRunActivitySteps(view) {
    const record = view?.recordId ? findRunRecord(view.recordId, view.sessionId) : null;
    if (!Array.isArray(record?.events)) {
      return 0;
    }
    return record.events.filter(event => (event.kind || 'activity') === 'activity').length;
  }

  // The sticky run-process header shows a live "Processing… {elapsed}" while a
  // run is in flight so the user can distinguish a working run from a hung one.
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

  function formatProcessedSummary(status, elapsedMs) {
    const elapsed = formatElapsed(elapsedMs);
    if (status === 'failed') {
      return tr('processedFailed', { elapsed });
    }
    if (status === 'running') {
      return tr('processing', { elapsed });
    }
    return tr('processed', { elapsed });
  }
  function renderRunHistory() {
    const log = getPanel()?.querySelector('[data-log]');
    if (!log) {
      return;
    }
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
      empty.append(icon, label, hint);
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
    scrollLogToBottom({ force: true });
  }

  function renderRunCard(run) {
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
        <div class="run-prompt" data-run-task></div>
        <div class="run-guidance-list" data-run-guidance></div>
        <div class="run-turn-meta">
          <button type="button" data-run-accept hidden title="Accept this run's tracked changes in Overleaf">Accept changes</button>
          <button type="button" data-run-undo hidden title="Undo this run's writes to Overleaf">Undo</button>
        </div>
        <details class="run-process" data-run-process>
          <summary data-run-process-summary>
            <span class="run-status" data-run-status></span>
            <span class="run-scan" aria-hidden="true"></span>
          </summary>
        </details>
        <div class="run-activity-list" data-run-events></div>
        <div class="run-report" data-run-report aria-live="polite" hidden></div>
      </div>
    `;

    renderAttachmentPreviewList(run.attachments, root.querySelector('[data-run-attachments]'), { readonly: true });
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
    const guidanceTarget = run.status === 'running' ? events : guidance;
    const renderedGuidanceIds = new Set();
    const completedLegacyGuidance = new Set((run.events || [])
      .filter(event => event.kind === 'guidance' && !event.guidanceId && event.status === 'completed')
      .map(event => event.title));
    for (const event of run.events || []) {
      if (event.kind === 'report') {
        report.hidden = false;
        report.replaceChildren(renderCompletionReport(event, run));
      } else if (event.kind === 'technical') {
        continue;
      } else if (RunGuidanceView.getGuidanceText(event)) {
        if (event.guidanceId && renderedGuidanceIds.has(event.guidanceId)) {
          continue;
        }
        if (!event.guidanceId && event.status === 'queued' && completedLegacyGuidance.has(event.title)) {
          continue;
        }
        if (event.guidanceId) {
          renderedGuidanceIds.add(event.guidanceId);
        }
        guidanceTarget.append(renderRunEvent(event));
      } else if (event.kind === 'stream') {
        upsertStreamEvent({ events }, event);
      } else {
        events.append(renderRunEvent(event));
      }
    }

    configureAcceptButton(root, run);
    configureUndoButton(root, run);
    return root;
  }

  function getRunStatusText(run = {}) {
    if (run.statusText) {
      return run.statusText;
    }
    if (run.status === 'running') {
      return tr('processing', { elapsed: '' }).trim();
    }
    if (run.startedAt && run.finishedAt) {
      return formatProcessedSummary(run.status || 'completed', new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime());
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
    view.events.append(renderStreamEvent({ ...event, streamKey }));
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
    const streamRole = sanitizeAssistantVisibleText(event.streamRole);
    const title = sanitizeAssistantVisibleText(event.title);
    return {
      ...event,
      title: streamRole === 'reasoning'
        ? stripEmptyHtmlCommentPlaceholders(title)
        : title,
      status: sanitizeAssistantVisibleText(event.status),
      detail: sanitizeAssistantVisibleValue(event.detail),
      technicalDetail: sanitizeAssistantVisibleValue(event.technicalDetail),
      streamKey: sanitizeAssistantVisibleText(event.streamKey),
      streamRole
    };
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

  function hasNonEmptyDetail(value) {
    if (value === undefined || value === null || value === '') {
      return false;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    if (typeof value === 'object') {
      return Object.keys(value).length > 0;
    }
    return true;
  }

  function renderTechnicalEvent(event) {
    const block = document.createElement('section');
    block.className = 'run-technical-event';
    block.dataset.status = event.status || 'info';

    const title = document.createElement('div');
    title.className = 'run-technical-event-title';
    title.textContent = event.title || tr('technicalDetails');

    const body = document.createElement('pre');
    body.textContent = formatEventDetail(buildTechnicalEventDetail(event));
    block.append(title, body);
    return block;
  }

  function buildTechnicalEventDetail(event) {
    if (event?.kind === 'technical') {
      return event.detail || {};
    }

    const detail = {
      [tx('Step', '步骤')]: event?.title || '',
      [tx('Status', '状态')]: event?.status || ''
    };
    if (event?.timestamp) {
      detail[tx('Time', '时间')] = formatEventTime(event.timestamp);
    }
    if (hasNonEmptyDetail(event?.detail)) {
      detail[tx('Content', '内容')] = event.detail;
    }
    if (hasNonEmptyDetail(event?.technicalDetail)) {
      detail[tx('Raw event', '原始事件')] = event.technicalDetail;
    }
    return detail;
  }

  function buildActivityTooltip(event) {
    return [
      event?.title || '',
      event?.timestamp ? formatEventTime(event.timestamp) : ''
    ].filter(Boolean).join('\n');
  }

  // The trailing status sections emitted by formatHumanReport (agentTranscript):
  // run metadata, not part of Codex's answer. Each entry matches the bilingual
  // "Label: value" line so the flat-text fallback can split them out of the
  // body and demote them into the same muted meta block the structured render
  // uses. Order mirrors the structured meta order.
  const FLAT_REPORT_STATUS_SECTIONS = [
    { key: 'unchangedReason', prefixes: ['Why nothing changed:', '未修改原因：'], en: 'Why nothing changed', zh: '未修改原因' },
    { key: 'writeResult', prefixes: ['Write result:', '写入结果：'], en: 'Write result', zh: '写入结果' },
    { key: 'undo', prefixes: ['Undo:', '可撤销：'], en: 'Undo', zh: '可撤销' },
    { key: 'nextStep', prefixes: ['Next:', '下一步：'], en: 'Next', zh: '下一步' }
  ];

  // Splits a flat completion-report string (formatHumanReport output) into the
  // answer body and the demoted meta rows. Only single-line sections whose head
  // matches a known status label are demoted, so a multi-paragraph conclusion
  // that happens to contain "Next: …" prose stays in the body.
  function splitFlatCompletionReport(text) {
    const raw = typeof text === 'string' ? text : '';
    if (!raw.trim()) {
      return { body: raw, meta: [] };
    }
    const bodySections = [];
    const meta = [];
    for (const section of raw.split(/\n{2,}/)) {
      const trimmed = section.trim();
      if (!trimmed) continue;
      const entry = trimmed.includes('\n')
        ? null
        : FLAT_REPORT_STATUS_SECTIONS.find(item => item.prefixes.some(prefix => trimmed.startsWith(prefix)));
      if (entry) {
        const prefix = entry.prefixes.find(p => trimmed.startsWith(p));
        const value = trimmed.slice(prefix.length).trim();
        if (value) {
          meta.push({ key: entry.key, label: tx(entry.en, entry.zh), value });
          continue;
        }
      }
      bodySections.push(trimmed);
    }
    return { body: bodySections.join('\n\n'), meta };
  }

  // Renders the demoted run-metadata block (Why nothing changed / Write result /
  // Undo / Next) beneath the answer. Shared by the structured and flat-fallback
  // render paths so both demote identically.
  function appendCompletionMetaBlock(report, meta) {
    if (!Array.isArray(meta) || !meta.length) {
      return;
    }
    const metaBlock = document.createElement('dl');
    metaBlock.className = 'run-final-answer__meta';
    for (const row of meta) {
      if (!row || !row.label || !row.value) continue;
      const dt = document.createElement('dt');
      dt.className = 'run-final-answer__meta-label';
      dt.textContent = row.label;
      if (row.key) dt.dataset.metaKey = row.key;
      const dd = document.createElement('dd');
      dd.className = 'run-final-answer__meta-value';
      dd.textContent = row.value;
      metaBlock.append(dt, dd);
    }
    if (metaBlock.children.length) {
      report.append(metaBlock);
    }
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
        mainSections.push(formatConclusionMarkdown(structured.conclusion));
      }
      if (structured.body) {
        mainSections.push(structured.body);
      }
      if (mainSections.length) {
        renderMarkdownBlockText(main, mainSections.join('\n\n'));
        report.append(main);
      }

      appendCompletionMetaBlock(report, structured.meta);
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
    renderMarkdownBlockText(body, split.body || flatText);
    report.append(body);
    appendCompileFix(report);
    appendRejectedRedo(report);
    appendCompletionMetaBlock(report, split.meta);
    appendRecoveryActionForFailure(report, event, run);
    return report;
  }

  function formatConclusionMarkdown(value) {
    const conclusion = String(value || '');
    const label = getLocale() === 'zh' ? '结论：' : 'Conclusion:';
    return hasLeadingMarkdownBlock(conclusion)
      ? `${label}\n${conclusion}`
      : `${label} ${conclusion}`;
  }

  function hasLeadingMarkdownBlock(value) {
    const firstLine = String(value || '').trimStart().split(/\r?\n/, 1)[0];
    return /^(?:#{1,6}\s+\S|```|~~~|(?:[-+*]|\d+[.)])\s+\S|\*\*[^*]+\*\*:?\s*$)/.test(firstLine);
  }

  // For failure codes that have an actionable recovery path the user can
  // invoke directly from the run card, append a button inside the completion
  // report. Today's only consumer is codex_project_locked → "Force-release
  // the stuck task" (covers the page-refresh-then-locked-out scenario where
  // the normal cancel button is hidden because currentRunView is null).
  // Recovery-action registry: failure codes whose "next step" is executable
  // from the panel get a button, not prose. One primary action per failure.
  const RETRYABLE_FAILURE_CODES = new Set([
    'native_request_failed', 'codex_timeout', 'codex_no_usable_result',
    'codex_output_limit', 'stale_source_changed', 'patch_anchor_not_found',
    'target_editor_not_ready', 'write_timeout', 'partial_write_needs_review',
    'write_operation_failed'
  ]);
  const NATIVE_SETUP_FAILURE_CODES = new Set([
    'native_bridge_unavailable', 'native_protocol_incompatible'
  ]);
  const OPEN_FILE_FAILURE_CODES = new Set([
    'target_file_not_active', 'target_file_open_failed', 'target_file_not_found'
  ]);
  const STORAGE_FAILURE_CODES = new Set([
    'storage_quota_exceeded', 'run_state_persist_failed'
  ]);
  // A missing `codex` binary is fixed in the terminal, not the panel — the
  // action opens the README troubleshooting section (PATH / login checks).
  const CODEX_INSTALL_FAILURE_CODES = new Set(['codex_not_found']);
  const CODEX_CLI_TROUBLESHOOTING_URL = 'https://github.com/Ghqqqq/codex-overleaf-link#faq-and-troubleshooting';

  function buildRecoveryButton(failureCode, label, title) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'run-final-answer__recovery-action';
    button.dataset.recoveryFor = failureCode;
    button.textContent = label;
    if (title) {
      button.title = title;
    }
    return button;
  }

  function appendRecoveryActionForFailure(report, event, run) {
    const failureCode = event?.failure?.code || '';
    if (RETRYABLE_FAILURE_CODES.has(failureCode) && typeof refillComposerForRetry === 'function') {
      const retry = buildRecoveryButton(failureCode,
        tx('Edit & resend', '编辑后重发'),
        tx('Put this run\u2019s task back into the composer so you can adjust and resend it.', '把本轮任务填回输入框，修改后可直接重发。'));
      retry.addEventListener('click', clickEvent => {
        clickEvent.stopPropagation();
        refillComposerForRetry(run || null);
      });
      report.append(retry);
      return;
    }
    if (NATIVE_SETUP_FAILURE_CODES.has(failureCode) && typeof showNativeSetupGuidance === 'function') {
      const fix = buildRecoveryButton(failureCode,
        tx('Fix the native host', '修复 native host'),
        tx('Opens the install/update guidance with the copyable command.', '打开安装/更新指引（含可复制命令）。'));
      fix.addEventListener('click', clickEvent => {
        clickEvent.stopPropagation();
        showNativeSetupGuidance();
      });
      report.append(fix);
      return;
    }
    if (OPEN_FILE_FAILURE_CODES.has(failureCode) && event?.failure?.file && typeof openProjectFileForFailure === 'function') {
      const open = buildRecoveryButton(failureCode,
        tx(`Open ${event.failure.file} in Overleaf`, `在 Overleaf 打开 ${event.failure.file}`), '');
      open.addEventListener('click', clickEvent => {
        clickEvent.stopPropagation();
        openProjectFileForFailure(event.failure.file);
      });
      report.append(open);
      return;
    }
    if (STORAGE_FAILURE_CODES.has(failureCode) && typeof openStorageSettings === 'function') {
      const clean = buildRecoveryButton(failureCode,
        tx('Open history & storage cleanup', '打开历史与存储清理'), '');
      clean.addEventListener('click', clickEvent => {
        clickEvent.stopPropagation();
        openStorageSettings();
      });
      report.append(clean);
      return;
    }
    if (CODEX_INSTALL_FAILURE_CODES.has(failureCode)) {
      const guide = buildRecoveryButton(failureCode,
        tx('Codex CLI troubleshooting guide', '查看 Codex CLI 排查指引'),
        tx('Opens the README section on fixing a missing `codex` command (PATH / login).', '打开 README 中「找不到 codex 命令」的排查说明（PATH／登录）。'));
      guide.addEventListener('click', clickEvent => {
        clickEvent.stopPropagation();
        window.open(CODEX_CLI_TROUBLESHOOTING_URL, '_blank', 'noopener');
      });
      report.append(guide);
      return;
    }
    if (failureCode !== 'codex_project_locked') return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'run-final-answer__recovery-action';
    button.dataset.recoveryFor = failureCode;
    button.textContent = tx('Force-release the stuck task', '强制释放卡住的任务');
    button.title = tx(
      'Sends a force-cancel to the native host that drops the project lock so a new run can start. Use this when refreshing the tab did not free the project.',
      '向 native host 发送强制取消请求，释放当前 Overleaf 项目的占用，让新的任务可以启动。刷新页面没用时使用。'
    );
    button.addEventListener('click', event => {
      event.stopPropagation();
      button.disabled = true;
      button.textContent = tx('Releasing…', '正在释放…');
      forceCancelStuckTaskForCurrentProject().then(result => {
        if (result?.ok) {
          button.textContent = tx('Force-released — you can retry the run.', '已释放，可以重试本轮任务。');
          return;
        }
        // The helper resolves (never throws) with a non-ok result when the
        // request was not delivered. Report the real outcome instead of a
        // blanket success, and re-enable the button so the user can retry.
        button.disabled = false;
        button.textContent = tx('Release failed — refresh the tab, then try again.', '释放失败，请刷新页面后重试。');
      }).catch(() => {
        button.disabled = false;
        button.textContent = tx('Release failed — refresh the tab, then try again.', '释放失败，请刷新页面后重试。');
      });
    });
    report.append(button);
  }

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

  function configureUndoButton(root, run) {
    const existing = root.querySelector('[data-run-undo]');
    const button = existing.cloneNode(true);
    existing.replaceWith(button);

    if (isTrackedChangeLifecycleRun(run)) {
      configureLifecycleUndoButton(button, run);
      return;
    }

    const undoCount = getRunUndoCount(run);
    if (!undoCount && run.undoStatus !== 'applied') {
      button.hidden = true;
      return;
    }

    button.hidden = false;
    button.disabled = run.undoStatus === 'running' || run.undoStatus === 'applied';
    button.textContent = run.undoStatus === 'applied'
      ? tr('undoApplied')
      : (run.partialWriteback ? tr('undoPartialRun') : tr('undoRun'));
    button.title = run.undoStatus === 'applied'
      ? tr('undoAppliedTitle')
      : (run.partialWriteback ? tr('undoPartialRunTitle') : tr('undoRunTitle'));
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
    // §7 settlement matrix: needs_review keeps BOTH controls visible AND
    // actionable. Branch placed before the terminal branches so a
    // needs_review run is never treated as terminal.
    if (status === 'needs_review') {
      const inFlight = trackedChangeInFlight.get(run.id);
      button.hidden = false;
      button.disabled = inFlight === 'reject' || inFlight === 'accept';
      button.textContent = tr('undoRun');
      button.title = tr('undoRunTitle');
      button.addEventListener('click', event => {
        event.stopPropagation();
        undoRun(run.id);
      });
      return;
    }
    if (status === 'rejected') {
      button.hidden = false;
      button.disabled = true;
      button.textContent = tr('undoApplied');
      button.title = tr('undoAppliedTitle');
      return;
    }
    if (status === 'accepted') {
      // The run was accepted — terminal. Undo stays visible but greyed so the
      // card shows both controls disabled, never removed.
      button.hidden = false;
      button.disabled = true;
      button.textContent = tr('undoRun');
      button.title = tr('undoRunTitle');
      return;
    }
    if (status !== 'pending') {
      button.hidden = true;
      return;
    }
    const inFlight = trackedChangeInFlight.get(run.id);
    button.hidden = false;
    button.disabled = inFlight === 'reject' || inFlight === 'accept';
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

    if (!isTrackedChangeLifecycleRun(run)) {
      button.hidden = true;
      return;
    }

    const status = run.trackedChangeStatus || '';
    // §7 settlement matrix: needs_review keeps BOTH controls visible AND
    // actionable. It remains an internal retryable proof state, while the
    // primary button label stays in the same executable state as `pending`.
    if (status === 'needs_review') {
      const inFlight = trackedChangeInFlight.get(run.id);
      button.hidden = false;
      button.disabled = inFlight === 'accept' || inFlight === 'reject';
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
    if (status === 'accepted') {
      button.hidden = false;
      button.disabled = true;
      button.textContent = tr('runAcceptTrackedDone');
      button.title = tr('runAcceptTrackedDoneTitle');
      return;
    }
    if (status === 'rejected') {
      // The run was rejected — terminal. Accept All stays visible but greyed so
      // the card shows both controls disabled, never removed.
      button.hidden = false;
      button.disabled = true;
      button.textContent = tr('runAcceptTracked');
      button.title = tr('runAcceptTrackedTitle');
      return;
    }
    if (status !== 'pending') {
      button.hidden = true;
      return;
    }

    const inFlight = trackedChangeInFlight.get(run.id);
    button.hidden = false;
    button.disabled = inFlight === 'accept' || inFlight === 'reject';
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
    if (!log || !existing || !run) {
      return;
    }
    existing.replaceWith(renderRunCard(run));
  }

    return {
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
    };
  }

  window.CodexOverleafRunTimelineView = { create };
})();
