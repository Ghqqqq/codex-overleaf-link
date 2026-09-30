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
      prepareRetryReplacement,
      StorageDb
    } = deps;

  // Read-only projection over scoped audit/session records. Prompt redaction
  // remains owned by the audit writer; this view never persists task text.
  const historyView = deps.ChangeHistoryView.create({
    tx, StorageDb, getState, getCurrentProjectId, getSettingsPanelInstance,
    getAccountScopeId: deps.getAccountScopeId,
    sanitizeText: deps.sanitizeText,
    onHistoryRowJump
  });
  function renderAuditHistoryPanel() { return historyView.load(); }
  function applyAuditHistoryFilter() { historyView.filter(); }

  // --- History & storage (v1.7.5): usage summary + clear-all in Settings ---
  let storageUsageRequestId = 0;
  function refreshStorageUsageSummary() {
    const host = getSettingsPanelInstance()?.container;
    const node = host?.querySelector('[data-storage-usage]');
    if (!node) return;
    const estimateNode = host.querySelector('[data-storage-estimate]') || node;
    const requestId = ++storageUsageRequestId;
    const projectId = getCurrentProjectId?.();
    const accountScopeId = deps.getAccountScopeId?.();
    const settingsScope = getPanel?.()?.dataset?.settingsScope;
    const isCurrent = () => requestId === storageUsageRequestId
      && projectId === getCurrentProjectId?.()
      && accountScopeId === deps.getAccountScopeId?.()
      && settingsScope === getPanel?.()?.dataset?.settingsScope
      && getSettingsPanelInstance()?.container?.querySelector('[data-storage-usage]') === node;
    const current = getState();
    const sessions = Array.isArray(current?.sessions) ? current.sessions : [];
    const runIds = new Set(sessions.flatMap(session => session.id === current.activeSessionId
      ? current.runs || [] : session.runs || []).map(run => run?.id).filter(Boolean));
    const counts = settingsScope === 'account'
      ? tx('Saved history across projects in this browser', '当前浏览器中跨项目保存的历史')
      : tx(sessions.length + ' loaded conversations · ' + runIds.size + ' runs in this project',
        '本项目已加载 ' + sessions.length + ' 个对话 · ' + runIds.size + ' 轮运行');
    node.removeAttribute?.('data-i18n');
    node.textContent = counts;
    estimateNode.removeAttribute?.('data-i18n');
    if (estimateNode !== node) estimateNode.textContent = tx('Estimating site storage…', '正在估算站点占用…');
    const showEstimate = value => {
      if (isCurrent()) estimateNode.textContent = estimateNode === node ? counts + ' · ' + value : value;
    };
    let timer;
    const estimate = Promise.resolve().then(() => navigator.storage?.estimate?.());
    const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000); });
    return Promise.race([estimate, deadline]).then(info => {
      if (!isCurrent()) return;
      const usage = info?.usage;
      if (!Number.isFinite(usage) || usage < 0) {
        showEstimate(tx('Site storage estimate unavailable; saved history is still accessible.', '暂无法估算站点容量，仍可查看已保存的历史。'));
        return;
      }
      const mb = usage / (1024 * 1024);
      const size = usage === 0 ? '0 KB' : mb >= 1 ? mb.toFixed(1) + ' MB' : Math.max(1, Math.round(usage / 1024)) + ' KB';
      showEstimate(tx('Site total ~' + size + ' (includes Overleaf data; not extension-only usage).',
        '本站点总占用约 ' + size + '，包含 Overleaf 数据，并非插件单独占用。'));
    }).catch(() => showEstimate(tx('Site storage estimate unavailable.', '暂无法估算站点容量。')))
      .finally(() => clearTimeout(timer));
  }

  async function clearAllHistoryWithConfirm() {
    if (getCurrentRunView()) {
      showPluginToast(tx('A run is in progress — wait for it to finish (or cancel it) before clearing history.', '有任务正在运行——请先等它结束（或取消）再清空历史。'));
      return;
    }
    const confirmed = await showPluginConfirm({
      title: tx('Clear local history?', '清理本地历史？'),
      message: tx(
        'This permanently removes saved conversations, run and change records, undo information, and recent-project entries for ALL projects in this browser. Overleaf project files will not be deleted or reverted. Project settings and rules are kept. Removed history cannot be recovered.',
        '将永久清理当前浏览器中所有项目的对话、运行与修改记录、撤销信息及最近项目条目。Overleaf 项目文件不会被删除或还原，项目设置与规则会保留。清理后的历史无法恢复。'
      ),
      confirmLabel: tx('Clear local history', '清理本地历史'),
      destructive: true
    });
    if (!confirmed) {
      return;
    }
    try {
      await StorageDb?.clearAllStores?.();
      historyView.invalidate();
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
    void renderAuditHistoryPanel();
    showPluginToast(tx('Local history cleared. Overleaf files are unchanged.', '本地历史已清理，Overleaf 文件保持不变。'));
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
    prepareRetryReplacement?.(run || null, task);
    input.value = task;
    getState().task = task;
    autosizeTaskTextarea();
    syncComposerSendAvailability();
    saveStateSoon(0);
    input.focus({ preventScroll: true });
    input.scrollIntoView?.({ block: 'nearest' });
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
