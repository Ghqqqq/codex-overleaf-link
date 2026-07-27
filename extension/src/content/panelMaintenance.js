(function initCodexOverleafPanelMaintenance() {
  'use strict';

  // Panel maintenance — carved out of contentRuntime.js in v1.8.0
  // (structural-debt phase 8): the recovery-action handlers injected into the
  // run timeline (retry refill / open file / open storage settings), the
  // change-history read path, the history & storage settings card, and the
  // aggressive-compaction notice. Code moved with mutable runtime state
  // (panel, state, currentRunView, settingsPanelInstance) rewritten to the
  // injected getter/setter accessors, matching the earlier carves.
  function create(deps = {}) {
    const {
      tx,
      showPluginToast,
      showPluginConfirm,
      callPageBridge,
      getCurrentProjectId,
      saveState,
      saveStateSoon,
      autosizeTaskTextarea,
      syncComposerSendAvailability,
      applyStateToPanel,
      normalizePanelState,
      openCustomInstructionsSettings,
      onHistoryRowJump,
      resetProjectNameCache,
      getPanel,
      getState,
      setState,
      getCurrentRunView,
      getSettingsPanelInstance,
    } = deps;

  // --- Change history (v1.7.5): the audit log finally gets a read path. ---
  // Loaded lazily when the Settings card is expanded; newest 50 project runs.
  let auditHistoryRecords = [];

  async function renderAuditHistoryPanel() {
    const container = getSettingsPanelInstance()?.container;
    const list = container?.querySelector('[data-history-list]');
    if (!list) {
      return;
    }
    const filterInput = container.querySelector('[data-history-filter]');
    if (filterInput && !filterInput.placeholder) {
      filterInput.placeholder = tx('Filter by file or task\u2026', '按文件名或任务过滤…');
    }
    list.textContent = tx('Loading\u2026', '正在加载…');
    let records = [];
    try {
      const StorageDb = window.CodexOverleafStorageDb;
      records = StorageDb?.getAllByIndex
        ? await StorageDb.getAllByIndex('auditLogs', 'projectId', getCurrentProjectId())
        : [];
    } catch (error) {
      list.textContent = tx(`Could not load change history: ${error.message}`, `无法加载变更历史：${error.message}`);
      return;
    }
    auditHistoryRecords = (records || [])
      .sort((a, b) => String(b?.createdAt || '').localeCompare(String(a?.createdAt || '')))
      .slice(0, 50);
    applyAuditHistoryFilter();
  }

  function applyAuditHistoryFilter() {
    const container = getSettingsPanelInstance()?.container;
    const list = container?.querySelector('[data-history-list]');
    if (!list) {
      return;
    }
    const query = String(container.querySelector('[data-history-filter]')?.value || '').trim().toLowerCase();
    const filePaths = record => []
      .concat(record?.appliedFiles || [], record?.changedFiles || [])
      .map(file => (file && typeof file === 'object') ? file.path : file)
      .filter(Boolean);
    const rows = auditHistoryRecords.filter(record => {
      if (!query) {
        return true;
      }
      return [record?.promptSummary || '', ...filePaths(record)].join(' ').toLowerCase().includes(query);
    });
    list.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'codex-history-empty';
      empty.textContent = query
        ? tx('No recorded changes match this filter.', '没有匹配该过滤条件的变更记录。')
        : tx('No recorded changes for this project yet.', '本项目还没有已记录的变更。');
      list.append(empty);
      return;
    }
    for (const record of rows) {
      const row = document.createElement('div');
      row.className = 'codex-history-row';
      row.dataset.resultStatus = record.resultStatus || '';
      const when = document.createElement('div');
      when.className = 'codex-history-when';
      when.textContent = record.createdAt ? new Date(record.createdAt).toLocaleString() : '';
      const task = document.createElement('div');
      task.className = 'codex-history-task';
      task.textContent = record.promptSummary || '';
      task.title = record.promptSummary || '';
      const files = document.createElement('div');
      files.className = 'codex-history-files';
      const applied = (record.appliedFiles || [])
        .map(file => (file && typeof file === 'object') ? file.path : file)
        .filter(Boolean);
      files.textContent = applied.length
        ? applied.join(' \u00b7 ')
        : tx('No files were written.', '未写入文件。');
      row.append(when, task, files);
      // v1.8.0: rows jump to the run they describe (turnId === run.id).
      if (record.sessionId && record.turnId && typeof onHistoryRowJump === 'function') {
        row.classList.add('codex-history-row--linked');
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        const jump = () => onHistoryRowJump(record);
        row.addEventListener('click', jump);
        row.addEventListener('keydown', keyEvent => {
          if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
            keyEvent.preventDefault();
            jump();
          }
        });
      }
      list.append(row);
    }
  }

  // --- History & storage (v1.7.5): usage summary + clear-all in Settings ---
  function refreshStorageUsageSummary() {
    const node = getSettingsPanelInstance()?.container?.querySelector('[data-storage-usage]');
    if (!node) {
      return;
    }
    const sessionCount = Array.isArray(getState()?.sessions) ? getState().sessions.length : 0;
    const runCount = Array.isArray(getState()?.runs) ? getState().runs.length : 0;
    const counts = tx(
      `${sessionCount} session(s) · ${runCount} recent run(s) kept`,
      `${sessionCount} 个会话 · 保留最近 ${runCount} 轮运行`
    );
    node.textContent = counts;
    const estimate = navigator.storage?.estimate?.();
    if (estimate?.then) {
      estimate.then(info => {
        const usage = Number(info?.usage);
        if (Number.isFinite(usage) && usage >= 0) {
          const mb = usage / (1024 * 1024);
          const size = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(usage / 1024))} KB`;
          node.textContent = tx(`${counts} · ~${size} used on this site`, `${counts} · 本站点约占用 ${size}`);
        }
      }).catch(() => { /* estimate unsupported — counts alone are fine */ });
    }
  }

  async function clearAllHistoryWithConfirm() {
    if (getCurrentRunView()) {
      showPluginToast(tx('A run is in progress — wait for it to finish (or cancel it) before clearing history.', '有任务正在运行——请先等它结束（或取消）再清空历史。'));
      return;
    }
    const confirmed = await showPluginConfirm({
      title: tx('Clear all history?', '清空全部历史？'),
      message: tx(
        'This permanently deletes every stored session, run and audit record for ALL projects — including the dashboard project list and cached project names. Project settings and rules are kept. This cannot be undone.',
        '将永久删除所有项目的全部会话、运行与审计记录——包括仪表盘的项目列表与缓存的项目名。项目设置与规则会保留。此操作不可撤销。'
      ),
      confirmLabel: tx('Delete everything', '全部删除'),
      destructive: true
    });
    if (!confirmed) {
      return;
    }
    try {
      await window.CodexOverleafStorageDb?.clearAllStores?.();
      // v1.8.1: the dashboard's project-name cache lives in
      // chrome.storage.local, outside the IndexedDB stores — clear it too so
      // no (potentially sensitive) project titles outlive the wipe.
      await resetProjectNameCache?.();
    } catch (error) {
      showPluginToast(tx(`Could not clear history: ${error.message}`, `清空历史失败：${error.message}`));
      return;
    }
    // Reset the in-getPanel() getState() to match the emptied store and re-render
    // EXPLICITLY. startNewSession() is unusable here: its empty-session reuse
    // guard matches the fresh session that normalization mints and returns
    // before applyStateToPanel(), leaving the deleted cards on screen.
    setState(normalizePanelState({ ...getState(), sessions: [], runs: [], activeSessionId: '' }));
    await saveState();
    applyStateToPanel();
    refreshStorageUsageSummary();
    showPluginToast(tx('All history cleared.', '已清空全部历史。'));
    getPanel()?.querySelector('[data-task]')?.focus();
  }

  // One toast per page load: aggressive compaction silently halves history
  // limits; the user deserves to know trimming is happening and where to act.
  let aggressiveCompactionNoticeShown = false;
  function notifyAggressiveCompactionOnce() {
    if (aggressiveCompactionNoticeShown) {
      return;
    }
    aggressiveCompactionNoticeShown = true;
    showPluginToast(tx(
      'Storage is tight: older history is being trimmed harder so saving keeps working. You can clear old history in Settings.',
      '存储空间紧张：正在更积极地精简较旧历史以保证保存成功。可在设置的「历史与存储」中清理。'
    ));
  }

  // --- Recovery-action handlers (v1.7.5) — injected into runTimelineView ---
  // Retry deliberately refills the composer instead of re-running directly:
  // the failed task usually needs a tweak before it is worth resending.
  function refillComposerForRetry(run, textOverride) {
    const input = getPanel()?.querySelector('[data-task]');
    const task = typeof textOverride === 'string' && textOverride.trim()
      ? textOverride
      : String(run?.task || '');
    if (!input || !task.trim()) {
      showPluginToast(tx('Nothing to refill: the original task text is unavailable.', '无法回填：原任务文本不可用。'));
      return;
    }
    input.value = task;
    getState().task = task;
    autosizeTaskTextarea();
    syncComposerSendAvailability();
    saveStateSoon();
    input.focus();
    try {
      input.setSelectionRange(task.length, task.length);
    } catch (error) {
      // Non-text inputs throw; cursor placement is best-effort.
    }
    if (Array.isArray(run?.attachments) && run.attachments.length) {
      showPluginToast(tx('Task refilled. Attachments are not restored — re-add them via ＋.', '任务已回填。附件不会自动恢复，请在 ＋ 中重新添加。'));
    } else {
      showPluginToast(tx('Task refilled — edit and resend.', '任务已回填，修改后可直接重发。'));
    }
  }

  // jumpToPosition opens the file via the page-side editor bridge; 0..0 lands
  // at the top without selecting anything.
  async function openProjectFileForFailure(path) {
    const target = String(path || '').trim();
    if (!target) {
      return;
    }
    try {
      await callPageBridge('jumpToPosition', {
        path: target,
        from: 0,
        to: 0,
        runProjectId: getCurrentProjectId()
      });
    } catch (error) {
      showPluginToast(tx(`Could not open ${target}: ${error.message}`, `无法打开 ${target}：${error.message}`));
    }
  }

  // Per-file undo selection (v1.8.0 C3). A destructive-confirm variant with
  // one checkbox per written file, all checked by default. Resolves with the
  // selected paths, or null on cancel. Re-undoing an already-undone file is
  // safe: the page-side base-content check skips it, so the modal never has
  // to track which files a previous partial undo already restored.
  function showUndoFileSelection({ title, task, confirmLabel, cancelLabel, selectAllLabel, paths }) {
    const host = getPanel();
    if (!host || !Array.isArray(paths) || !paths.length) {
      return Promise.resolve(null);
    }
    return new Promise(resolve => {
      host.querySelector('[data-undo-file-select]')?.remove();
      const overlay = document.createElement('div');
      overlay.className = 'codex-plugin-confirm codex-undo-file-select';
      overlay.setAttribute('data-undo-file-select', '');
      const box = document.createElement('div');
      box.className = 'codex-plugin-confirm-card';
      const heading = document.createElement('div');
      heading.className = 'codex-plugin-confirm-title';
      heading.textContent = title;
      const taskLine = document.createElement('div');
      taskLine.className = 'codex-plugin-confirm-body';
      taskLine.textContent = task || '';
      const list = document.createElement('div');
      list.className = 'codex-undo-file-list';
      const boxes = [];
      const allToggle = document.createElement('label');
      const allInput = document.createElement('input');
      allInput.type = 'checkbox';
      allInput.checked = true;
      allToggle.append(allInput, document.createTextNode(` ${selectAllLabel}`));
      allToggle.className = 'codex-undo-file-item codex-undo-file-item--all';
      allInput.addEventListener('change', () => {
        for (const input of boxes) {
          input.checked = allInput.checked;
        }
      });
      list.append(allToggle);
      for (const path of paths) {
        const item = document.createElement('label');
        item.className = 'codex-undo-file-item';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = true;
        input.value = path;
        input.addEventListener('change', () => {
          allInput.checked = boxes.every(box => box.checked);
        });
        boxes.push(input);
        item.append(input, document.createTextNode(` ${path}`));
        list.append(item);
      }
      const actions = document.createElement('div');
      actions.className = 'codex-plugin-confirm-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = cancelLabel;
      const confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.className = 'codex-plugin-confirm-confirm';
      confirm.dataset.destructive = 'true';
      confirm.textContent = confirmLabel;
      const finish = value => {
        overlay.remove();
        resolve(value);
      };
      cancel.addEventListener('click', () => finish(null));
      confirm.addEventListener('click', () => {
        const selected = boxes.filter(input => input.checked).map(input => input.value);
        finish(selected.length ? selected : null);
      });
      actions.append(cancel, confirm);
      box.append(heading, taskLine, list, actions);
      overlay.append(box);
      host.append(overlay);
      cancel.focus();
    });
  }

  // Change history first-class entry (v1.8.0): callers jump straight to the
  // Settings history card, expanded and loaded.
  function openChangeHistory() {
    openCustomInstructionsSettings();
    const card = getSettingsPanelInstance()?.container?.querySelector('[data-history-card]');
    if (card) {
      if (!card.open) {
        card.open = true;
      }
      renderAuditHistoryPanel();
      card.scrollIntoView({ block: 'start' });
    }
  }

  function openStorageSettings() {
    openCustomInstructionsSettings();
    const card = getPanel()?.querySelector('[data-storage-card]');
    if (card) {
      card.open = true;
      card.scrollIntoView({ block: 'center' });
    }
  }
    return {
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
    };
  }

  window.CodexOverleafPanelMaintenance = { create };
})();
