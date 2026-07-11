(function initCodexOverleafUpdateNotice(root) {
  'use strict';

  let notice = null;
  let currentView = null;
  let mountedPanel = null;
  let actionInFlight = false;
  let completionTimer = null;
  let listenerInstalled = false;
  let getLocale = () => '';

  function mount(panelLike, options = {}) {
    if (typeof options.getLocale === 'function') {
      getLocale = options.getLocale;
    }
    const panel = panelLike?.panelEl || panelLike;
    if (!panel) return;
    if (mountedPanel === panel) {
      render();
      return;
    }
    mountedPanel = panel;
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
    actionInFlight = true;
    render();
    try {
      currentView = await request({
        install: 'codex-overleaf/consent-update-install',
        later: 'codex-overleaf/consent-update-later',
        retry: 'codex-overleaf/consent-update-check'
      }[action]);
    } catch (error) {
      currentView = {
        ...(currentView || {}),
        state: {
          ...(currentView?.state || {}),
          state: 'failed',
          code: error?.code || 'update_failed',
          message: error?.message || tx('Update failed.', '更新失败。')
        },
        progress: { value: 0, determinate: true, phase: 'failed' },
        showPanel: true
      };
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

  function render() {
    if (!notice || !currentView) return;
    clearTimeout(completionTimer);
    if (!currentView.showPanel) {
      notice.hidden = true;
      notice.replaceChildren();
      return;
    }

    const focusedAction = document.activeElement?.dataset?.updateNoticeAction || '';
    const state = currentView.state || {};
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
    if (state.state === 'committed') {
      completionTimer = setTimeout(() => {
        if (notice?.dataset.state === 'committed') notice.hidden = true;
      }, 5000);
    }
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
      return [{ id: 'retry', label: tx('Retry', '重试'), primary: true }];
    }
    return [];
  }

  function getCopy(state) {
    const target = state.latestVersion ? 'v' + state.latestVersion : '';
    const blocker = blockerCopy(state.blocker);
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

  function blockerCopy(value) {
    return {
      unsaved: tx('Overleaf has not confirmed that this document is saved.', 'Overleaf 尚未确认当前文档已保存。'),
      active_run: tx('A Codex task is still running.', 'Codex 任务仍在运行。'),
      cancelling: tx('Cancellation is still settling.', '取消操作仍在收尾。'),
      storage_write: tx('Extension state is still being saved.', '扩展状态仍在保存。'),
      review_action: tx('Accept or Undo is still running.', '接受或撤销操作仍在进行。'),
      dialog_open: tx('A confirmation dialog is open.', '确认对话框仍处于打开状态。'),
      native_project_locked: tx('Native Host still holds a project lock.', 'Native Host 仍持有项目锁。'),
      native_run_active: tx('Native Host is still processing a task.', 'Native Host 仍在处理任务。')
    }[value] || tx('Waiting until every Overleaf tab is saved and idle.', '正在等待所有 Overleaf 标签页完成保存并进入空闲状态。');
  }

  function tx(english, chinese) {
    const locale = String(getLocale() || document.documentElement?.lang || 'en');
    return /^zh\b/i.test(locale) ? chinese : english;
  }

  root.CodexOverleafUpdateNotice = Object.freeze({ mount });
})(window);
