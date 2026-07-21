(function initCodexOverleafUpdateNotice(root) {
  'use strict';

  let notice = null;
  let currentView = null;
  let mountedPanel = null;
  let actionInFlight = false;
  let listenerInstalled = false;
  let getLocale = () => '';
  let settingsRoot = null;
  let settingsActionInFlight = false;
  let restartWatchdog = null;
  let manualCommandCopied = false;
  const ACTIVE_UPDATE_STATES = new Set(['downloading', 'staged', 'waiting_for_idle', 'applying', 'awaiting_health']);
  const RESTART_WATCHDOG_MS = 30 * 1000;

  function mount(panelLike, options = {}) {
    if (typeof options.getLocale === 'function') {
      getLocale = options.getLocale;
    }
    const panel = panelLike?.panelEl || panelLike;
    if (!panel) return;
    if (mountedPanel === panel) {
      bindSettingsControls(panel);
      render();
      return;
    }
    mountedPanel = panel;
    bindSettingsControls(panel);
    notice?.remove();
    notice = document.createElement('section');
    notice.className = 'codex-update-notice';
    notice.hidden = true;
    notice.setAttribute('aria-label', tx('Stable update', '稳定版更新'));
    const header = panel.querySelector('[data-panel-header]');
    if (typeof header?.insertAdjacentElement === 'function') {
      header.insertAdjacentElement('afterend', notice);
    } else if (typeof header?.after === 'function') {
      header.after(notice);
    } else if (typeof panel.prepend === 'function') {
      panel.prepend(notice);
    } else {
      panel.append?.(notice);
    }
    notice.addEventListener('click', handleClick);

    if (!listenerInstalled) {
      listenerInstalled = true;
      chrome.runtime.onMessage.addListener(message => {
        if (message?.type !== 'codex-overleaf/consent-update-state') return;
        currentView = message.view;
        render();
      });
    }
    request('codex-overleaf/consent-update-get-state')
      .then(view => {
        currentView = view;
        render();
      })
      .catch(() => {});
  }

  async function handleClick(event) {
    const action = event.target?.closest?.('[data-update-notice-action]')?.dataset?.updateNoticeAction;
    if (!action || actionInFlight) return;
    if (action === 'copy-manual') {
      try {
        await navigator.clipboard.writeText(manualUpdateCommand(currentView?.state));
        manualCommandCopied = true;
        render();
        setTimeout(() => {
          manualCommandCopied = false;
          render();
        }, 1800);
      } catch (_error) {
        manualCommandCopied = false;
      }
      return;
    }
    actionInFlight = true;
    render();
    try {
      currentView = await request({
        install: 'codex-overleaf/consent-update-install',
        retry: 'codex-overleaf/consent-update-check',
        later: 'codex-overleaf/consent-update-later',
        dismiss: 'codex-overleaf/consent-update-dismiss'
      }[action]);
    } catch (error) {
      currentView = await reconcileAfterActionError(error, {
        action,
        fallbackMessage: tx('Update failed.', '更新失败。')
      });
    } finally {
      actionInFlight = false;
      render();
    }
  }

  async function request(type) {
    if (!type) throw new Error('Unknown update action.');
    const response = await chrome.runtime.sendMessage({ type });
    if (!response?.ok) {
      const error = new Error(response?.error?.message || tx('Update action failed.', '更新操作失败。'));
      error.code = response?.error?.code || 'update_failed';
      throw error;
    }
    return response.result;
  }

  async function reconcileAfterActionError(error, options = {}) {
    if (options.action === 'install' && isRuntimeRestartError(error)) {
      return buildRestartingView();
    }
    try {
      const authoritativeView = await request('codex-overleaf/consent-update-get-state');
      if (authoritativeView?.state) return authoritativeView;
    } catch (_stateError) {
      // The local fallback below is used only when the global coordinator is unavailable too.
    }
    return {
      ...(currentView || {}),
      state: {
        ...(currentView?.state || {}),
        state: 'failed',
        code: error?.code || 'update_failed',
        message: error?.message || options.fallbackMessage || tx('Update failed.', '更新失败。')
      },
      progress: { value: 0, determinate: true, phase: 'failed' },
      showPanel: true
    };
  }

  function isRuntimeRestartError(error) {
    return /extension context invalidated|message (?:port|channel) closed|receiving end does not exist|could not establish connection|disconnected port/i.test(
      String(error?.message || error || '')
    );
  }

  function buildRestartingView() {
    scheduleRestartWatchdog();
    return {
      ...(currentView || {}),
      state: {
        ...(currentView?.state || {}),
        state: 'awaiting_health',
        code: '',
        message: ''
      },
      progress: { value: 90, determinate: false, phase: 'awaiting_health' },
      showPanel: true
    };
  }

  function scheduleRestartWatchdog() {
    clearTimeout(restartWatchdog);
    restartWatchdog = setTimeout(async () => {
      try {
        const view = await request('codex-overleaf/consent-update-get-state');
        if (view?.state && !ACTIVE_UPDATE_STATES.has(view.state.state)) {
          currentView = view;
        } else {
          currentView = buildFailedView('update_recovery_timeout', tx(
            'The update did not finish restarting. Retry or use the manual recovery command.',
            '更新重启未能完成。请重试或使用手动恢复命令。'
          ));
        }
      } catch (_error) {
        currentView = buildFailedView('update_recovery_timeout', tx(
          'The update did not finish restarting. Retry or use the manual recovery command.',
          '更新重启未能完成。请重试或使用手动恢复命令。'
        ));
      }
      render();
    }, RESTART_WATCHDOG_MS);
  }

  function buildFailedView(code, message) {
    return {
      ...(currentView || {}),
      state: {
        ...(currentView?.state || {}),
        state: 'failed',
        code,
        message
      },
      progress: { value: 0, determinate: true, phase: 'failed' },
      showPanel: true
    };
  }

  function bindSettingsControls(panel) {
    settingsRoot = panel;
    const button = panel.querySelector?.('[data-check-updates]');
    if (button && button.dataset.updateSettingsBound !== 'true') {
      button.dataset.updateSettingsBound = 'true';
      button.addEventListener('click', handleSettingsAction);
    }
    renderSettings();
  }

  async function handleSettingsAction() {
    if (settingsActionInFlight) return;
    settingsActionInFlight = true;
    renderSettings();
    const stateName = currentView?.state?.state || 'idle';
    let requestedAction = 'check';
    try {
      if (stateName === 'update_available') {
        requestedAction = 'install';
        currentView = await request('codex-overleaf/consent-update-install');
      } else if (['failed', 'rolled_back'].includes(stateName)) {
        currentView = await request('codex-overleaf/consent-update-check');
      } else if (!ACTIVE_UPDATE_STATES.has(stateName)) {
        currentView = await request('codex-overleaf/consent-update-check');
      } else {
        return;
      }
    } catch (error) {
      currentView = await reconcileAfterActionError(error, {
        action: requestedAction,
        fallbackMessage: tx('Update check failed.', '更新检查失败。')
      });
    } finally {
      settingsActionInFlight = false;
      render();
    }
  }

  function render() {
    if (!currentView) return;
    renderSettings();
    if (!notice) return;
    if (!currentView.showPanel) {
      notice.hidden = true;
      notice.replaceChildren();
      return;
    }

    const focusedAction = document.activeElement?.dataset?.updateNoticeAction || '';
    const state = currentView.state || {};
    if (state.state !== 'awaiting_health') {
      clearTimeout(restartWatchdog);
      restartWatchdog = null;
    }
    const progress = currentView.progress || {};
    const copy = getCopy(state);
    notice.hidden = false;
    notice.dataset.state = state.state || 'idle';

    const body = document.createElement('div');
    body.className = 'codex-update-notice-body';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'codex-update-notice-eyebrow';
    eyebrow.textContent = copy.eyebrow;
    const title = document.createElement('strong');
    title.textContent = copy.title;
    const detail = document.createElement('span');
    detail.className = 'codex-update-notice-detail';
    detail.textContent = copy.detail;
    body.append(eyebrow, title, detail);

    if (state.state === 'failed') {
      const recovery = document.createElement('span');
      recovery.className = 'codex-update-notice-recovery';
      recovery.textContent = tx('Manual recovery:', '手动恢复：');
      const command = document.createElement('code');
      command.className = 'codex-update-notice-command';
      command.textContent = manualUpdateCommand(state);
      body.append(recovery, command);
    }

    if (!['update_available', 'failed', 'rolled_back'].includes(state.state)) {
      const bar = document.createElement('div');
      bar.className = 'codex-update-notice-progress' + (progress.determinate ? '' : ' is-indeterminate');
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      bar.setAttribute('aria-valuetext', copy.detail);
      if (progress.determinate) bar.setAttribute('aria-valuenow', String(progress.value || 0));
      const fill = document.createElement('span');
      fill.style.width = Math.max(0, Math.min(100, Number(progress.value || 0))) + '%';
      bar.append(fill);
      body.append(bar);
    }

    const actions = document.createElement('div');
    actions.className = 'codex-update-notice-actions';
    for (const action of visibleActions(state.state)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.updateNoticeAction = action.id;
      button.className = action.primary ? 'is-primary' : '';
      button.textContent = action.label;
      button.disabled = actionInFlight;
      actions.append(button);
    }
    notice.replaceChildren(body, actions);
    if (focusedAction) {
      notice.querySelector('[data-update-notice-action="' + focusedAction + '"]:not(:disabled)')?.focus();
    }
  }

  function renderSettings() {
    if (!settingsRoot) return;
    const summary = settingsRoot.querySelector?.('[data-update-settings-summary]');
    const status = settingsRoot.querySelector?.('[data-update-settings-state]');
    const button = settingsRoot.querySelector?.('[data-check-updates]');
    if (!summary || !status || !button) return;

    const state = currentView?.state || {};
    const stateName = state.state || 'idle';
    const manifestVersion = typeof chrome.runtime.getManifest === 'function'
      ? chrome.runtime.getManifest().version
      : '';
    const currentVersion = state.currentVersion || manifestVersion || '';
    const latestVersion = state.latestVersion || '';
    let summaryText = tx(
      `Current v${currentVersion}. Signed stable releases are checked automatically.`,
      `当前版本 v${currentVersion}。系统会自动检查签名稳定版本。`
    );
    let statusText = '';
    let buttonText = tx('Check for updates', '检查更新');

    if (stateName === 'checking') {
      statusText = tx('Checking the latest stable release…', '正在检查最新稳定版本…');
      buttonText = tx('Checking…', '检查中…');
    } else if (stateName === 'update_available') {
      summaryText = tx(`Stable v${latestVersion} is available.`, `稳定版本 v${latestVersion} 已可用。`);
      statusText = tx('Ready to download and verify.', '已可下载并验证。');
      buttonText = tx('Update now', '立即更新');
    } else if (ACTIVE_UPDATE_STATES.has(stateName)) {
      statusText = getCopy(state).detail;
      buttonText = tx('Update in progress', '更新进行中');
    } else if (stateName === 'failed' || stateName === 'rolled_back') {
      statusText = state.message || getCopy(state).detail;
      buttonText = tx('Retry', '重试');
    } else if (stateName === 'committed') {
      summaryText = tx(`Current v${currentVersion}. Update completed successfully.`, `当前版本 v${currentVersion}。更新已成功完成。`);
      statusText = tx('Both components passed the health check.', '两个组件均已通过健康检查。');
    }

    summary.textContent = summaryText;
    status.textContent = statusText;
    status.hidden = !statusText;
    button.textContent = buttonText;
    button.disabled = settingsActionInFlight || stateName === 'checking' || ACTIVE_UPDATE_STATES.has(stateName);
  }

  function visibleActions(state) {
    if (actionInFlight) return [];
    if (state === 'update_available') {
      return [
        { id: 'later', label: tx('Later', '稍后'), primary: false },
        { id: 'install', label: tx('Update now', '立即更新'), primary: true }
      ];
    }
    if (['staged', 'waiting_for_idle'].includes(state)) {
      return [{ id: 'later', label: tx('Later', '稍后'), primary: false }];
    }
    if (['failed', 'rolled_back'].includes(state)) {
      return [
        { id: 'copy-manual', label: manualCommandCopied ? tx('Copied', '已复制') : tx('Copy command', '复制命令'), primary: false },
        { id: 'retry', label: tx('Retry', '重试'), primary: true }
      ];
    }
    if (state === 'committed') {
      return [{ id: 'dismiss', label: tx('Done', '完成'), primary: true }];
    }
    return [];
  }

  function getCopy(state) {
    const target = state.latestVersion ? 'v' + state.latestVersion : '';
    const blocker = blockersCopy(state.blockers?.length ? state.blockers : [state.blocker]);
    return {
      update_available: {
        eyebrow: tx('Update available', '发现新版本'),
        title: target,
        detail: tx('Signed stable update for the extension and Native Host.', '扩展与 Native Host 的签名稳定更新。')
      },
      downloading: {
        eyebrow: tx('Updating Codex Overleaf Link', '正在更新 Codex Overleaf Link'),
        title: target,
        detail: tx('Downloading and verifying the coordinated update.', '正在下载并验证协调更新。')
      },
      staged: {
        eyebrow: tx('Update ready', '更新已就绪'),
        title: target,
        detail: tx('Verified and ready to install at a safe point.', '已完成验证，将在安全时机安装。')
      },
      waiting_for_idle: {
        eyebrow: tx('Waiting for a safe point', '正在等待安全时机'),
        title: target,
        detail: blocker
      },
      applying: {
        eyebrow: tx('Installing update', '正在安装更新'),
        title: target,
        detail: tx('Installing extension and Native Host.', '正在安装扩展与 Native Host。')
      },
      awaiting_health: {
        eyebrow: tx('Checking updated components', '正在检查更新后的组件'),
        title: target,
        detail: tx('Restarting and checking both components.', '正在重启并检查两个组件。')
      },
      committed: {
        eyebrow: tx('Update complete', '更新完成'),
        title: target,
        detail: tx('Both components passed health confirmation.', '两个组件均已通过健康检查。')
      },
      rolled_back: {
        eyebrow: tx('Previous version restored', '已恢复上一版本'),
        title: state.currentVersion ? 'v' + state.currentVersion : '',
        detail: tx('The replacement failed its health check.', '替换版本未通过健康检查。')
      },
      failed: {
        eyebrow: tx('Update could not continue', '更新无法继续'),
        title: target,
        detail: state.message || tx('Review the update details and retry.', '请查看更新详情后重试。')
      }
    }[state.state] || { eyebrow: '', title: '', detail: '' };
  }

  function manualUpdateCommand(state = {}) {
    const version = /^\d+\.\d+\.\d+$/.test(String(state.latestVersion || ''))
      ? state.latestVersion
      : 'latest';
    return `npm exec --yes codex-overleaf-link@${version} -- install-managed`;
  }

  function blockerCopy(value) {
    return {
      unsaved: tx('Overleaf has not confirmed that this document is saved.', 'Overleaf 尚未确认当前文档已保存。'),
      active_run: tx('A Codex task is still running.', 'Codex 任务仍在运行。'),
      run: tx('A Codex task is still running in an Overleaf tab.', '某个 Overleaf 标签页中的 Codex 任务仍在运行。'),
      cancelling: tx('Cancellation is still settling.', '取消操作仍在收尾。'),
      storage_write: tx('Extension state is still being saved.', '扩展状态仍在保存。'),
      storage: tx('Extension state is still being saved.', '扩展状态仍在保存。'),
      review_action: tx('Accept or Undo is still running.', '接受或撤销操作仍在进行。'),
      reviewAction: tx('Accept or Undo is still running.', '接受或撤销操作仍在进行。'),
      dialog_open: tx('A confirmation dialog is open.', '确认对话框仍处于打开状态。'),
      dialog: tx('A confirmation dialog is open.', '确认对话框仍处于打开状态。'),
      recent_user_activity: tx('Waiting briefly after the latest editor activity.', '正在等待最近一次编辑操作稳定下来。'),
      save_state_not_stable: tx('The saved state is being confirmed.', '正在确认稳定的已保存状态。'),
      save_state_unverified: tx('An Overleaf tab has not verified its saved state yet.', '某个 Overleaf 标签页尚未验证已保存状态。'),
      tab_probe_timeout: tx('An Overleaf tab did not answer the safety check. Reload that tab if this persists.', '某个 Overleaf 标签页未响应安全检查；若持续出现，请刷新该标签页。'),
      tab_probe_unavailable: tx('An Overleaf tab needs to be reloaded before it can join the safety check.', '某个 Overleaf 标签页需要刷新后才能参与安全检查。'),
      tab_unavailable: tx('An Overleaf tab is unavailable for the safety check.', '某个 Overleaf 标签页当前无法完成安全检查。'),
      idle_probe_failed: tx('The Overleaf safety check failed. Reload the affected tab and retry.', 'Overleaf 安全检查失败；请刷新受影响的标签页后重试。'),
      native_project_locked: tx('Native Host still holds a project lock.', 'Native Host 仍持有项目锁。'),
      native_run_active: tx('Native Host is still processing a task.', 'Native Host 仍在处理任务。'),
      busy: tx('A component is still busy.', '某个组件仍处于忙碌状态。')
    }[value] || tx('Waiting until every Overleaf tab is saved and idle.', '正在等待所有 Overleaf 标签页完成保存并进入空闲状态。');
  }

  function blockersCopy(values = []) {
    const messages = [...new Set(values.filter(Boolean).map(blockerCopy))];
    return messages.join(' ') || tx(
      'Waiting until every Overleaf tab is saved and idle.',
      '正在等待所有 Overleaf 标签页完成保存并进入空闲状态。'
    );
  }

  function tx(english, chinese) {
    const locale = String(getLocale() || document.documentElement?.lang || 'en');
    return /^zh\b/i.test(locale) ? chinese : english;
  }

  root.CodexOverleafUpdateNotice = Object.freeze({ mount });
})(window);
