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
    if (action === 'restore-previous' && !window.confirm(restorePreviousConfirmText())) return;
    return runUpdateAction(action);
  }

  function restorePreviousLabel() {
    const version = currentView?.restorePrevious?.version || '';
    return version ? tx(`Restore v${version}`, `恢复到 v${version}`) : tx('Restore previous version', '恢复到上一版本');
  }

  function restorePreviousConfirmText() {
    return tx('Restore the previous version? The extension reloads, and saved, idle Overleaf tabs are refreshed. Sessions, settings and provider keys are kept.',
      '恢复到上一版本？扩展会重新加载，已保存且空闲的 Overleaf 标签页会被刷新。会话、设置和模型服务的密钥都会保留。');
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
        reload: 'codex-overleaf/consent-update-reload',
        'restore-previous': 'codex-overleaf/consent-update-rollback'
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
    const restore = panel.querySelector?.('[data-restore-previous-version]');
    if (restore && restore.dataset.updateSettingsBound !== 'true') {
      restore.dataset.updateSettingsBound = 'true';
      restore.addEventListener('click', () => {
        if (window.confirm(restorePreviousConfirmText())) void runUpdateAction('restore-previous');
      });
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
    notice.setAttribute('aria-label', tx('Stable update', '稳定版更新'));
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

    if (stateName === 'idle' && state.code === 'update_skipped_after_rollback') {
      statusText = tx(
        `v${latestVersion} is skipped because you restored the previous version. Check for updates to install it again.`,
        `你已恢复到上一版本，自动更新会跳过 v${latestVersion}。点“检查更新”可以重新安装。`
      );
    } else if (stateName === 'idle' && state.code === 'update_cooldown') {
      const until = Number(state.cooldownUntil || 0);
      const time = until > 0 && Number.isFinite(until) ? new Date(until).toLocaleString(getLocale() || undefined) : '';
      statusText = tx(
        `Update v${latestVersion} is paused after a failed installation. ${time ? `Check again after ${time}.` : 'Check again after its cooldown ends.'}`,
        `v${latestVersion} 安装失败后已暂停更新。${time ? `请在 ${time} 后再次检查。` : '请在冷却期结束后再次检查。'}`
      );
    } else if (['reload_required', 'reload_tabs_required'].includes(stateName)) {
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
      statusText = formatUpdateMessage(state) || getCopy(state).detail;
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
    const restore = settingsRoot.querySelector?.('[data-restore-previous-version]');
    if (restore) {
      restore.hidden = !currentView?.actions?.restorePrevious;
      restore.textContent = restorePreviousLabel();
      restore.disabled = actionInFlight || settingsActionInFlight;
    }
  }

  function visibleActions(state) {
    const value = currentView?.state || {};
    const restore = currentView?.actions?.restorePrevious
      ? [{ id: 'restore-previous', label: restorePreviousLabel(), primary: false }] : [];
    if (value.recoveryPending) return [...restore, { id: 'recover', label: tx('Check recovery', '检查恢复状态'), primary: true }];
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
      return [...restore, { id: 'dismiss', label: tx('Done', '完成'), primary: true }];
    }
    return [];
  }

  function getCopy(state) {
    const target = state.latestVersion ? 'v' + state.latestVersion : '';
    if (state.cancelRequested) return {
      eyebrow: tx('Cancelling update', '正在取消更新'), title: target,
      detail: formatUpdateMessage(state) || tx('Stopping this update and clearing its authorization.', '正在停止本次更新并清理更新授权。')
    };
    if (state.recoveryPending) return {
      eyebrow: tx('Checking update recovery', '正在确认更新恢复状态'), title: target,
      detail: formatUpdateMessage(state) || tx('Waiting for the installed version to be confirmed.', '正在确认实际安装的版本。')
    };
    const blocker = blockersCopy(state.blockers?.length ? state.blockers : [state.blocker]);
    return {
      checking: { eyebrow: tx('Checking for updates', '正在检查更新'), title: target,
        detail: tx('Reading the latest signed release.', '正在读取最新签名版本。') },
      reload_required: {
        eyebrow: tx('Installed, awaiting reload', '已安装，等待加载'), title: target,
        detail: formatUpdateMessage(state) || tx('The new files are installed. Reload the extension when Overleaf is saved and idle.', '新版文件已安装，请在 Overleaf 保存并空闲后重新加载扩展。')
      },
      reload_tabs_required: {
        eyebrow: tx('Updated runtime is ready', '新版运行组件已就绪'), title: target,
        detail: formatUpdateMessage(state) || tx('Refresh the saved, idle Overleaf tabs to load the updated panel.', '刷新已保存且空闲的 Overleaf 标签页以加载新版面板。')
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
        detail: state.code === 'update_user_rollback'
          ? tx('You restored the previous version. Automatic updates skip the version you left.', '你已恢复到上一版本，自动更新会跳过刚才退出的版本。')
          : tx('The replacement failed its health check.', '替换版本未通过健康检查。')
      },
      failed: {
        eyebrow: tx('Update could not continue', '更新无法继续'),
        title: target,
        detail: formatUpdateMessage(state) || tx('Review the update details and retry.', '请查看更新详情后重试。')
      }
    }[state.state] || { eyebrow: '', title: '', detail: '' };
  }

  function manualUpdateCommand(state = {}) {
    const version = /^\d+\.\d+\.\d+$/.test(String(state.latestVersion || ''))
      ? state.latestVersion
      : 'latest';
    return `npm exec --yes codex-overleaf-link@${version} -- install-managed`;
  }

  function formatUpdateMessage(state = {}) {
    const code = state.code || '';
    const messages = {
      update_phase_timeout: ['The update timed out and its download was stopped. Retry when the connection is available.', '更新超时，下载已停止。连接恢复后请重试。'],
      update_not_applied: ['The update was stopped before installation. Retry when ready.', '更新已在安装前停止，可准备就绪后重试。'],
      update_recovery_pending: ['The update result is being checked. Recovery has not been confirmed.', '正在确认更新结果，恢复状态尚未确认。'],
      update_rolled_back: ['The previous version has been restored.', '已恢复上一版本。'],
      update_user_rollback: ['You restored the previous version.', '你已恢复到上一版本。'],
      update_not_managed: ['Run install-managed once to enable coordinated automatic updates.', '请先运行一次 install-managed，以启用扩展与本机服务的协调更新。'],
      update_native_busy: ['Native Host is still processing a Codex task.', 'Native Host 仍在处理 Codex 任务。'],
      update_revoke_too_late: ['The update is already being installed. Wait for its result.', '更新已进入安装，请等待结果。'],
      update_cancel_unconfirmed: ['Update cancellation is unconfirmed. Check recovery before retrying.', '尚未确认更新已取消，请先检查恢复状态。'],
      update_apply_unconfirmed: ['Update installation is unconfirmed. Check recovery before retrying.', '尚未确认更新安装结果，请先检查恢复状态。'],
      update_rollback_unconfirmed: ['Restoring the previous version is unconfirmed. Check recovery before retrying.', '尚未确认旧版本已恢复，请先检查恢复状态。'],
      update_reload_unavailable: ['No verified installed update is awaiting reload.', '当前没有已验证且等待重载的更新。'],
      update_network_cancelled: ['The update download was cancelled.', '更新下载已取消。'],
      update_apply_failed: ['The update could not be installed. Check recovery and retry.', '无法安装更新，请检查恢复状态后重试。']
    };
    if (messages[code]) return tx(...messages[code]);
    if (['update_health_failed', 'update_request_failed', 'update_failed'].includes(code)) return tx('The updated components could not be confirmed. Check recovery before retrying.', '尚未确认更新后的组件正常，请先检查恢复状态。');
    if (['update_bootstrap_health_timeout', 'update_bootstrap_reload_failed'].includes(code)) return tx('The updated startup components did not finish restarting and confirming. Check recovery before retrying.', '更新后的启动组件未能完成重启和确认，请先检查恢复状态。');
    if (['update_bootstrap_source_mismatch', 'update_bootstrap_source_version_mismatch'].includes(code)) return tx('The installed startup files do not match a supported update source. Restore the previous version in Settings, or reinstall once.', '已安装的启动文件与支持的升级来源不一致。请在设置中恢复到上一版本，或重新安装一次。');
    if (['update_bootstrap_record_missing', 'update_bootstrap_record_invalid', 'update_bootstrap_backup_mismatch', 'update_bootstrap_already_restoring'].includes(code)) return tx('The startup recovery material could not be confirmed. The update result remains unconfirmed.', '尚未确认启动组件的恢复材料有效，更新结果仍待确认。');
    if (['update_bootstrap_confirmation_pending', 'update_bootstrap_native_restart_required'].includes(code)) return tx('Waiting for the updated startup components and Native Host to finish restarting and confirming.', '正在等待更新后的启动组件和本机服务完成重启及确认。');
    if (code === 'update_bootstrap_monitor_unavailable') return tx('The update recovery monitor could not start. Check recovery before retrying.', '更新恢复监护程序未能启动，请先检查恢复状态。');
    if (['update_bootstrap_transaction_mismatch', 'update_bootstrap_transaction_invalid'].includes(code)) return tx('The startup update transaction could not be matched. Check recovery before retrying.', '未能匹配启动组件的更新事务，请先检查恢复状态。');
    if (code.startsWith('update_bootstrap_')) return tx('The startup update package or installed files could not be verified. Check recovery before retrying.', '无法验证启动组件更新包或已安装文件，请先检查恢复状态。');
    if (['update_reload_required', 'update_reload_busy'].includes(code)) {
      const match = /^Reload is waiting for Overleaf to be saved and idle \(([^)]+)\)\.$/.exec(state.message || '');
      if (match) return blockersCopy(match[1].split(', '));
    }
    if (['update_check_timeout', 'update_activation_timeout', 'update_status_timeout'].includes(code)) return tx('The update operation timed out. Check recovery or retry when the connection is available.', '更新操作超时，请检查恢复状态，或在连接恢复后重试。');
    if (['update_candidate_missing', 'update_candidate_stale', 'update_not_staged', 'update_staged_archive_invalid', 'update_recovery_superseded'].includes(code)) return tx('No current verified update is ready. Check for updates again.', '当前没有已验证且可安装的更新，请重新检查更新。');
    if (['update_authorization_in_progress', 'update_transaction_in_progress', 'update_transaction_locked'].includes(code)) return tx('Another update operation is in progress. Wait for it to finish.', '另一项更新操作正在进行，请等待其完成。');
    if (['update_authorization_invalid', 'update_consent_required', 'update_consent_mismatch', 'update_transaction_mismatch', 'update_transaction_state_changed'].includes(code)) return tx('The update authorization or transaction changed. Check for updates and authorize the current candidate again.', '更新授权或事务已变化，请重新检查更新并确认当前候选版本。');
    if (['update_archive_checksum_invalid', 'update_archive_compressed_limit', 'update_archive_duplicate_path', 'update_archive_file_count_limit', 'update_archive_file_limit', 'update_archive_invalid', 'update_archive_path_forbidden', 'update_archive_path_too_long', 'update_archive_required_file_missing', 'update_archive_total_limit', 'update_archive_truncated', 'update_archive_type_forbidden', 'update_staging_not_empty', 'update_operation_invalid', 'update_bundle_hash_invalid', 'update_bundle_name_invalid', 'update_bundle_size_invalid', 'update_manifest_artifacts_invalid', 'update_manifest_commit_invalid', 'update_manifest_invalid', 'update_manifest_manual_install_invalid', 'update_manifest_origin_mismatch', 'update_manifest_protocol_invalid', 'update_manifest_schema_unsupported', 'update_manifest_timestamp_invalid', 'update_manifest_too_large', 'update_manifest_version_invalid', 'update_signature_algorithm_unsupported', 'update_signature_invalid', 'update_signature_key_invalid', 'update_signature_key_unknown', 'update_signature_too_large', 'update_version_invalid'].includes(code)) return tx('The signed update or archive could not be verified. Check the release details and retry.', '无法验证更新签名或压缩包，请检查发布详情后重试。');
    if (['update_github_http_error', 'update_github_response_invalid', 'update_asset_missing', 'update_asset_url_forbidden', 'update_release_asset_invalid', 'update_release_manifest_mismatch', 'update_bundle_size_mismatch', 'update_bundle_hash_mismatch', 'update_native_version_mismatch', 'update_extension_version_mismatch', 'update_runtime_manifest_invalid', 'update_runtime_asset_missing', 'update_bootstrap_manifest_invalid', 'update_managed_layout_invalid', 'update_marker_invalid', 'update_current_version_invalid', 'update_health_version_mismatch', 'update_confirmation_unexpected', 'update_rollback_unavailable'].includes(code)) return tx('The update or installed files could not be verified. Check the update details and repair or retry.', '无法验证更新或已安装文件，请检查更新详情后修复或重试。');
    return state.message || '';
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
      native_process_stop_unconfirmed: tx('A previous Codex process has not yet confirmed its exit.', '前一次 Codex 进程尚未确认退出。'),
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
    if (state.code === 'prerelease_promotion_requires_manual_update') {
      return tx('The installed release candidate has the same version number as the stable release. Reinstall to use the stable release.',
        '已安装的候选版与稳定版使用相同版本号。请重新安装以使用稳定版。');
    }
    if (state.code === 'update_bootstrap_source_mismatch') {
      return tx('The installed startup files differ from the published release this update starts from, for example after a release candidate or local build. Reinstall once to continue.',
        '已安装的启动文件与这次更新所基于的正式版不一致（例如装过候选版或本地构建）。重新安装一次即可继续。');
    }
    const reason = state.manualReason || {};
    return tx(reason.en || reason.zh || '', reason.zh || reason.en || '');
  }

  function tx(english, chinese) {
    const locale = String(getLocale() || document.documentElement?.lang || 'en');
    return /^zh\b/i.test(locale) ? chinese : english;
  }

  return Object.freeze({ mount, refreshLocale: render });
});
