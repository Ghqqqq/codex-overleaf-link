(function initCodexOverleafUpdateNotice(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/managedUpdateProjection'));
  } else {
    root.CodexOverleafModuleRegistry.define('UpdateNotice', ['ManagedUpdateProjection'], factory);
  }
})(typeof window !== 'undefined' ? window : globalThis, function updateNoticeFactory(UpdateProjection) {
  'use strict';

  let notice = null;
  let currentView = null;
  let mountedPanel = null;
  let actionInFlight = false;
  let cancellationInFlight = false;
  let actionSequence = 0;
  let listenerInstalled = false;
  let getLocale = () => '';
  let settingsRoot = null;
  let settingsActionInFlight = false;
  let restartWatchdog = null;
  let manualCommandCopied = false;
  const ACTIVE_UPDATE_STATES = new Set(UpdateProjection.activePhases('panel'));
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
    if (!action) return;
    if (action === 'release-notes') {
      const version = currentView?.state?.latestVersion || '';
      window.open('https://github.com/Ghqqqq/codex-overleaf-link/releases/tag/v' + version, '_blank', 'noopener');
      return;
    }
    if (action === 'copy-manual') {
      try {
        await navigator.clipboard.writeText(manualUpdateCommand(currentView?.state));
        manualCommandCopied = true;
        render();
        setTimeout(() => { manualCommandCopied = false; render(); }, 1800);
      } catch (_) { manualCommandCopied = false; }
      return;
    }
    return runUpdateAction(action);
  }

  async function runUpdateAction(action) {
    const cancelling = action === 'cancel' || action === 'later';
    if (cancellationInFlight || ((actionInFlight || settingsActionInFlight) && !cancelling)) return;
    const sequence = ++actionSequence;
    actionInFlight = true;
    settingsActionInFlight = true;
    cancellationInFlight = cancelling;
    render();
    try {
      const view = await request({
        check: 'codex-overleaf/consent-update-check',
        install: 'codex-overleaf/consent-update-install',
        retry: 'codex-overleaf/consent-update-check',
        later: 'codex-overleaf/consent-update-later',
        cancel: 'codex-overleaf/consent-update-cancel',
        recover: 'codex-overleaf/consent-update-recover',
        dismiss: 'codex-overleaf/consent-update-dismiss',
        reload: 'codex-overleaf/consent-update-reload'
      }[action]);
      if (sequence === actionSequence) currentView = view;
    } catch (error) {
      if (sequence === actionSequence) {
        const view = await reconcileAfterActionError(error, {
          action, fallbackMessage: tx('Update action failed.', '更新操作失败。')
        });
        if (sequence === actionSequence) currentView = view;
      }
    } finally {
      if (sequence === actionSequence) {
        actionInFlight = false;
        settingsActionInFlight = false;
        cancellationInFlight = false;
        render();
      }
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
        if (view?.state) {
          currentView = view;
          if (ACTIVE_UPDATE_STATES.has(view.state.state)) scheduleRestartWatchdog();
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

  function handleSettingsAction() {
    const state = currentView?.state || {};
    if (state.recoveryPending) return runUpdateAction('recover');
    if (state.cancelRequested || ['checking', 'downloading', 'staged', 'waiting_for_idle'].includes(state.state)) {
      return runUpdateAction('cancel');
    }
    if (['reload_required', 'reload_tabs_required'].includes(state.state)) return runUpdateAction('reload');
    if (state.state === 'update_available') return runUpdateAction('install');
    if (!ACTIVE_UPDATE_STATES.has(state.state)) return runUpdateAction('check');
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

    if (state.state === 'manual_install_required') {
      const steps = document.createElement('ol');
      steps.className = 'codex-update-notice-steps';
      for (const text of [
        tx('Run this once in a terminal:', '在终端运行一次：'),
        tx('Reload the extension in chrome://extensions, then refresh Overleaf.', '在 chrome://extensions 里重新加载扩展，再刷新 Overleaf。')
      ]) steps.append(Object.assign(document.createElement('li'), { textContent: text }));
      const command = document.createElement('code');
      command.className = 'codex-update-notice-command';
      command.textContent = manualUpdateCommand(state);
      steps.firstElementChild.append(command);
      const keep = document.createElement('span');
      keep.className = 'codex-update-notice-recovery';
      keep.textContent = tx('Sessions, settings, provider keys and project mirrors are kept.', '会话、设置、模型服务的密钥和项目镜像都会保留。');
      body.append(steps, keep);
    }

    if (state.state === 'failed' && !state.cancelRequested && !state.recoveryPending) {
      const recovery = document.createElement('span');
      recovery.className = 'codex-update-notice-recovery';
      recovery.textContent = tx('Manual recovery:', '手动恢复：');
      const command = document.createElement('code');
      command.className = 'codex-update-notice-command';
      command.textContent = manualUpdateCommand(state);
      body.append(recovery, command);
    }

    if (!['update_available', 'manual_install_required', 'failed', 'rolled_back', 'reload_required', 'reload_tabs_required'].includes(state.state)) {
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
      button.disabled = action.id === 'cancel'
        ? cancellationInFlight || (state.cancelRequested && !state.code)
        : actionInFlight || settingsActionInFlight;
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

    if (['reload_required', 'reload_tabs_required'].includes(stateName)) {
      summaryText = tx(`Installed v${latestVersion}; running extension v${currentVersion}.`, `已安装 v${latestVersion}；扩展当前运行 v${currentVersion}。`);
      statusText = getCopy(state).detail;
      buttonText = stateName === 'reload_required' ? tx('Reload extension', '重新加载扩展') : tx('Refresh Overleaf tabs', '刷新 Overleaf 标签页');
    } else if (stateName === 'checking') {
      statusText = tx('Checking the latest stable release…', '正在检查最新稳定版本…');
      buttonText = tx('Checking…', '检查中…');
    } else if (stateName === 'update_available') {
      summaryText = tx(`Stable v${latestVersion} is available.`, `稳定版本 v${latestVersion} 已可用。`);
      statusText = tx('Ready to download and verify.', '已可下载并验证。');
      buttonText = tx('Update now', '立即更新');
    } else if (stateName === 'manual_install_required') {
      summaryText = tx(`v${latestVersion} is available but needs a one-time reinstall.`, `v${latestVersion} 已发布，但需要重新安装一次。`);
      statusText = manualReasonText(state) || getCopy(state).detail;
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
    const cancellable = state.cancelRequested || ['checking', 'downloading', 'staged', 'waiting_for_idle'].includes(stateName);
    if (state.recoveryPending) {
      button.textContent = tx('Check recovery', '检查恢复状态');
      button.disabled = actionInFlight || settingsActionInFlight;
    } else if (cancellable) {
      button.textContent = state.cancelRequested && !state.code
        ? tx('Cancelling…', '正在取消…')
        : state.cancelRequested ? tx('Retry cancellation', '重试取消') : tx('Cancel update', '取消更新');
      button.disabled = cancellationInFlight || (state.cancelRequested && !state.code);
    } else {
      button.disabled = actionInFlight || settingsActionInFlight || ACTIVE_UPDATE_STATES.has(stateName);
    }
  }

  function visibleActions(state) {
    const value = currentView?.state || {};
    if (value.recoveryPending) return [{ id: 'recover', label: tx('Check recovery', '检查恢复状态'), primary: true }];
    if (value.cancelRequested || ['checking', 'downloading'].includes(state)) {
      return [{ id: 'cancel', label: value.cancelRequested
        ? value.code ? tx('Retry cancellation', '重试取消') : tx('Cancelling…', '正在取消…')
        : tx('Cancel update', '取消更新'), primary: false }];
    }
    if (actionInFlight && !['staged', 'waiting_for_idle'].includes(state)) return [];
    if (['reload_required', 'reload_tabs_required'].includes(state)) {
      return [{ id: 'reload', label: state === 'reload_required'
        ? tx('Reload extension', '重新加载扩展') : tx('Refresh Overleaf tabs', '刷新 Overleaf 标签页'), primary: true }];
    }
    if (state === 'update_available') {
      return [
        { id: 'later', label: tx('Later', '稍后'), primary: false },
        { id: 'install', label: tx('Update now', '立即更新'), primary: true }
      ];
    }
    if (['staged', 'waiting_for_idle'].includes(state)) {
      return [{ id: 'cancel', label: tx('Cancel update', '取消更新'), primary: false }];
    }
    if (state === 'manual_install_required') {
      return [
        { id: 'later', label: tx('Later', '稍后'), primary: false },
        { id: 'release-notes', label: tx('Release notes', '发布说明'), primary: false },
        { id: 'copy-manual', label: manualCommandCopied ? tx('Copied', '已复制') : tx('Copy command', '复制命令'), primary: true }
      ];
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
    if (state.cancelRequested) return {
      eyebrow: tx('Cancelling update', '正在取消更新'), title: target,
      detail: state.message || tx('Stopping this update and clearing its authorization.', '正在停止本次更新并清理更新授权。')
    };
    if (state.recoveryPending) return {
      eyebrow: tx('Checking update recovery', '正在确认更新恢复状态'), title: target,
      detail: state.message || tx('Waiting for the installed version to be confirmed.', '正在确认实际安装的版本。')
    };
    const blocker = blockersCopy(state.blockers?.length ? state.blockers : [state.blocker]);
    return {
      checking: { eyebrow: tx('Checking for updates', '正在检查更新'), title: target,
        detail: tx('Reading the latest signed release.', '正在读取最新签名版本。') },
      reload_required: {
        eyebrow: tx('Installed, awaiting reload', '已安装，等待加载'), title: target,
        detail: state.message || tx('The new files are installed. Reload the extension when Overleaf is saved and idle.', '新版文件已安装，请在 Overleaf 保存并空闲后重新加载扩展。')
      },
      reload_tabs_required: {
        eyebrow: tx('Updated runtime is ready', '新版运行组件已就绪'), title: target,
        detail: state.message || tx('Refresh the saved, idle Overleaf tabs to load the updated panel.', '刷新已保存且空闲的 Overleaf 标签页以加载新版面板。')
      },
      manual_install_required: {
        eyebrow: tx('Reinstall needed for this update', '这次更新需要重新安装'),
        title: target,
        detail: manualReasonText(state) || tx('This release changes what Chrome lets the extension do, so Update now cannot apply it.', '这一版改动了 Chrome 授予扩展的权限，无法通过“立即更新”完成。')
      },
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

  function manualReasonText(state = {}) {
    const reason = state.manualReason || {};
    return tx(reason.en || reason.zh || '', reason.zh || reason.en || '');
  }

  function tx(english, chinese) {
    const locale = String(getLocale() || document.documentElement?.lang || 'en');
    return /^zh\b/i.test(locale) ? chinese : english;
  }

  return Object.freeze({ mount });
});
