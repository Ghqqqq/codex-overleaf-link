(function initPopup() {
  'use strict';

  const CodexOverleafCompatibility = window.CodexOverleafCompatibility;
  const DEFAULT_INSTALL_COMMAND = CodexOverleafCompatibility?.buildInstallCommand?.(
    undefined,
    undefined,
    getCurrentExtensionId()
  ) || 'curl -fsSL https://raw.githubusercontent.com/Ghqqqq/codex-overleaf-link/main/install.sh | bash -s -- --extension-id <chrome-extension-id>';
  const button = document.getElementById('open-panel');
  const status = document.getElementById('status');
  const compatStatusIcon = document.getElementById('compat-status-icon');
  const versionPair = document.getElementById('version-pair');
  const nativeInstall = document.getElementById('native-install');
  const installCommand = document.getElementById('install-command');
  const copyInstallCommand = document.getElementById('copy-install-command');
  let activeOverleafTab = null;
  let currentInstallCommand = DEFAULT_INSTALL_COMMAND;

  installCommand.textContent = currentInstallCommand;
  button.textContent = 'Show Codex button in Overleaf';
  setVersionStatus({
    status: 'native_missing',
    classification: 'incompatible',
    extensionVersion: getExtensionCompatibilityMetadata().version
  });

  button.addEventListener('click', async () => {
    const tab = activeOverleafTab || await getActiveOverleafProjectTab();
    if (!tab?.id) {
      status.textContent = 'Open an Overleaf project tab first.';
      return;
    }

    await chrome.tabs.sendMessage(tab.id, { type: 'codex-overleaf/toggle-launcher' });
    window.close();
  });

  copyInstallCommand.addEventListener('click', async () => {
    await navigator.clipboard.writeText(currentInstallCommand);
    copyInstallCommand.textContent = 'Copied';
    setTimeout(() => {
      copyInstallCommand.textContent = 'Copy install command';
    }, 1400);
  });

  initPopupState();
  scheduleConsentUpdateUi();

  async function initPopupState() {
    await checkNativeHost();
    await refreshPanelButtonState();
  }

  async function refreshPanelButtonState() {
    const tab = await getActiveOverleafProjectTab();
    activeOverleafTab = tab;
    if (!tab?.id) {
      button.textContent = 'Show Codex button in Overleaf';
      return;
    }

    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'codex-overleaf/get-panel-state' });
      const visible = response?.launcherVisible !== false;
      button.textContent = visible ? 'Hide Codex edge button' : 'Show Codex edge button';
      status.textContent = visible
        ? 'The edge button appears whenever the Codex panel is closed.'
        : 'The Codex edge button is hidden in Overleaf.';
    } catch (_error) {
      button.textContent = 'Show Codex button in Overleaf';
      status.textContent = 'Refresh the Overleaf tab, then show the Codex button.';
    }
  }

  async function getActiveOverleafProjectTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id && isOverleafProjectUrl(tab.url) ? tab : null;
  }

  function isOverleafProjectUrl(url) {
    return /^https:\/\/(www\.)?overleaf\.com\/project\//.test(String(url || ''));
  }

  async function checkNativeHost() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'codex-overleaf/native-request',
        payload: {
          id: crypto.randomUUID(),
          method: 'bridge.ping',
          params: CodexOverleafCompatibility?.buildBridgePingParams?.(getExtensionCompatibilityMetadata()) || {}
        }
      });
      const compatibility = evaluateNativeCompatibility(response);
      setVersionStatus(compatibility);
      if (getCompatibilityClassification(compatibility) === 'compatible') {
        nativeInstall.hidden = true;
        status.textContent = 'Native host connected. Open an Overleaf project tab to use Codex.';
        return;
      }
      showNativeInstallGuide(compatibility);
    } catch (_error) {
      const compatibility = {
        status: 'native_missing',
        classification: 'incompatible',
        installCommand: DEFAULT_INSTALL_COMMAND,
        updateCommand: DEFAULT_INSTALL_COMMAND,
        extensionVersion: getExtensionCompatibilityMetadata().version
      };
      setVersionStatus(compatibility);
      showNativeInstallGuide(compatibility);
    }
  }

  function showNativeInstallGuide(compatibility = {}) {
    nativeInstall.hidden = false;
    currentInstallCommand = getCompatibilityUpdateCommand(compatibility);
    installCommand.textContent = currentInstallCommand;
    status.textContent = getNativeStatusMessage(compatibility.status, getCompatibilityClassification(compatibility));
  }

  function evaluateNativeCompatibility(response) {
    if (CodexOverleafCompatibility?.evaluateNativeCompatibility) {
      return CodexOverleafCompatibility.evaluateNativeCompatibility(response, getExtensionCompatibilityMetadata());
    }
    return response?.ok
      ? {
          status: 'ok',
          classification: 'compatible',
          native: response.result,
          nativeVersion: response.result?.version,
          currentNativeVersion: response.result?.version,
          installCommand: DEFAULT_INSTALL_COMMAND,
          updateCommand: DEFAULT_INSTALL_COMMAND,
          extensionVersion: getExtensionCompatibilityMetadata().version
        }
      : {
          status: 'native_missing',
          classification: 'incompatible',
          native: response,
          installCommand: DEFAULT_INSTALL_COMMAND,
          updateCommand: DEFAULT_INSTALL_COMMAND,
          extensionVersion: getExtensionCompatibilityMetadata().version
        };
  }

  function setVersionStatus(compatibility = {}) {
    const classification = getCompatibilityClassification(compatibility);
    const extensionVersion = compatibility.extensionVersion || getExtensionCompatibilityMetadata().version;
    const nativeVersion = compatibility.currentNativeVersion || compatibility.nativeVersion || compatibility.native?.version;
    versionPair.textContent = `Extension ${formatVersion(extensionVersion)} / Native ${formatVersion(nativeVersion)}`;
    compatStatusIcon.textContent = getStatusIconText(classification);
    compatStatusIcon.className = `status-icon ${classification}`;
    compatStatusIcon.title = getCompatibilityStatusTitle(classification);
    if (compatStatusIcon.dataset) {
      compatStatusIcon.dataset.status = classification;
    }
    compatStatusIcon.setAttribute?.('aria-label', compatStatusIcon.title);
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

  function getCompatibilityClassification(compatibility = {}) {
    const classification = compatibility.classification || compatibility.status;
    switch (classification) {
      case 'compatible':
      case 'update-available':
      case 'incompatible':
        return classification;
      case 'ok':
        return 'compatible';
      default:
        return 'incompatible';
    }
  }

  function getCompatibilityUpdateCommand(compatibility = {}) {
    return CodexOverleafCompatibility?.buildInstallCommand?.(
      compatibility.recommendedVersion || CodexOverleafCompatibility.BUILD_TARGET_VERSION,
      compatibility.native?.platform || compatibility.platform,
      getCurrentExtensionId()
    ) || compatibility.updateCommand || compatibility.installCommand || DEFAULT_INSTALL_COMMAND;
  }

  function getStatusIconText(classification) {
    switch (classification) {
      case 'compatible':
        return '';
      case 'update-available':
        return '';
      default:
        return '';
    }
  }

  function getCompatibilityStatusTitle(classification) {
    switch (classification) {
      case 'compatible':
        return 'Native host compatible';
      case 'update-available':
        return 'Native host update available';
      default:
        return 'Native host incompatible';
    }
  }

  function formatVersion(version) {
    const value = String(version || '').trim();
    if (!value) {
      return 'unknown';
    }
    return value.startsWith('v') ? value : `v${value}`;
  }

  function getNativeStatusMessage(statusValue, classification) {
    if (classification === 'update-available') {
      return 'Native host update available. Run the update command, then reload the extension.';
    }
    switch (statusValue) {
      case 'native_too_old':
        return 'Native host update required. Run the install command, then reload the extension.';
      case 'protocol_unsupported':
        return 'Native host protocol mismatch. Update the native host and extension together.';
      case 'extension_too_old':
        return 'Extension update required. Update the Chrome extension before running Codex.';
      case 'native_unhealthy':
        return 'Native host connected, but local Codex is not ready. Check the panel diagnostics.';
      case 'native_missing':
        return 'Install the local native host before running Codex.';
      default:
        return 'Native host is not compatible. Update the native host, then reload the extension.';
    }
  }

  function scheduleConsentUpdateUi() {
    const start = () => {
      if (typeof document.querySelector !== 'function') return;
      document.querySelector('.updates')?.remove();
      document.body?.classList?.remove('consent-update-focus');
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      Promise.resolve().then(start);
    }
  }

  function ensureUpdateSection() {
    let section = document.querySelector('.updates');
    if (!section) {
      section = document.createElement('section');
      section.className = 'updates';
      section.setAttribute('aria-label', 'Stable updates');
      (nativeInstall || status).insertAdjacentElement('afterend', section);
    }
    section.classList.add('consent-updates');
    section.replaceChildren();
    return section;
  }

function openUpdateCenter(action = '') {
  const url = new URL(chrome.runtime.getURL('bootstrap/update.html'));
  if (action) url.searchParams.set('action', action);
  const opened = window.open(
    url.href,
    'codex-overleaf-update-center',
    'popup,width=420,height=540,resizable=yes,scrollbars=yes'
  );
  if (opened) {
    opened.focus();
    return;
  }
  window.location.assign(url.href);
}

async function sendConsentAction(action) {
  if (action === 'install' || action === 'retry' || action === 'center') {
    openUpdateCenter(action === 'center' ? '' : action);
    action = 'get';
  }
  const type = {
      get: 'codex-overleaf/consent-update-get-state',
      check: 'codex-overleaf/consent-update-check',
      install: 'codex-overleaf/consent-update-install',
      later: 'codex-overleaf/consent-update-later',
      dismiss: 'codex-overleaf/consent-update-dismiss',
      retry: 'codex-overleaf/consent-update-check'
    }[action];
    const response = await chrome.runtime.sendMessage({ type });
    if (!response?.ok) {
      const error = new Error(response?.error?.message || 'Update action failed.');
      error.code = response?.error?.code || 'update_failed';
      throw error;
    }
    return response.result;
  }

  function failedUpdateView(view, error) {
    return {
      ...(view || {}),
      state: {
        ...(view?.state || {}),
        state: 'failed',
        code: error?.code || 'update_failed',
        message: error?.message || 'Update failed.'
      },
      progress: { value: 0, determinate: true, phase: 'failed' },
      actions: { retry: true }
    };
  }

  function renderUpdateSection(section, view = {}, options = {}) {
    const focusedAction = document.activeElement?.dataset?.updateAction || '';
    const state = view?.state || { state: 'idle' };
    const progress = view?.progress || { value: 0, determinate: true, phase: 'idle' };
    const copy = getUpdateCopy(state, view);
    const stateName = state.state || 'idle';
    const focusMode = Boolean(
      options.busyAction === 'install' ||
      view.execution ||
      ['committed', 'rolled_back', 'failed'].includes(stateName)
    );
    section.classList.toggle('is-quiet', stateName === 'idle');
    section.classList.toggle('is-offer', stateName === 'update_available');
    section.classList.toggle('is-focus', focusMode);
    section.classList.toggle('is-result', ['committed', 'rolled_back', 'failed'].includes(stateName));
    document.body.classList.toggle('consent-update-focus', focusMode);
    const card = document.createElement('div');
    card.className = 'consent-update-card state-' + stateName;

    const head = document.createElement('div');
    head.className = 'consent-update-head';
    const title = document.createElement('strong');
    title.textContent = copy.title;
    const version = document.createElement('span');
    version.textContent = copy.version;
    head.append(title, version);

    const route = document.createElement('div');
    route.className = 'consent-update-route';
    const currentVersion = state.currentVersion ? 'v' + state.currentVersion : '';
    const latestVersion = state.latestVersion ? 'v' + state.latestVersion : '';
    route.textContent = currentVersion && latestVersion && currentVersion !== latestVersion
      ? currentVersion + ' → ' + latestVersion
      : latestVersion || currentVersion;

    const detail = document.createElement('p');
    detail.className = 'consent-update-detail';
    detail.textContent = copy.detail;

    const progressEl = document.createElement('div');
    progressEl.className = 'consent-update-progress' + (progress.determinate ? '' : ' is-indeterminate');
    progressEl.setAttribute('role', 'progressbar');
    progressEl.setAttribute('aria-label', copy.phase);
    progressEl.setAttribute('aria-valuemin', '0');
    progressEl.setAttribute('aria-valuemax', '100');
    progressEl.setAttribute('aria-valuetext', copy.phase);
    if (progress.determinate) progressEl.setAttribute('aria-valuenow', String(progress.value || 0));
    const progressFill = document.createElement('span');
    progressFill.style.width = Math.max(0, Math.min(100, Number(progress.value || 0))) + '%';
    progressEl.append(progressFill);

    const phase = document.createElement('div');
    phase.className = 'consent-update-phase';
    phase.textContent = copy.phase;
    const showPhaseText = Boolean(copy.phase && copy.phase !== copy.detail);
    const steps = createUpdateSteps(stateName);
    const footnote = createUpdateFootnote(stateName);

    const actions = document.createElement('div');
    actions.className = 'consent-update-actions';
    for (const action of getVisibleActions(view, options.busyAction)) {
      const actionButton = document.createElement('button');
      actionButton.type = 'button';
      actionButton.dataset.updateAction = action.id;
      actionButton.className = action.primary ? 'update-primary' : 'update-secondary';
      actionButton.textContent = action.label;
      actionButton.disabled = Boolean(options.busyAction) || action.disabled;
      actions.append(actionButton);
    }

    const live = document.createElement('div');
    live.className = 'consent-update-live';
    live.setAttribute('aria-live', 'polite');
    live.textContent = ['committed', 'rolled_back', 'failed'].includes(state.state) ? copy.phase : '';

    card.append(head);
    if ((focusMode || stateName === 'update_available') && route.textContent) card.append(route);
    card.append(detail);
    if (!['idle', 'update_available'].includes(state.state) || options.busyAction === 'check') {
      card.append(progressEl);
      if (showPhaseText) card.append(phase);
    }
    if (steps) card.append(steps);
    if (footnote) card.append(footnote);
    card.append(actions, live);
    if (state.state === 'failed' && (state.code || state.message)) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = utx('Technical details', '技术详情');
      const code = document.createElement('code');
      code.textContent = [state.code, state.message].filter(Boolean).join(': ');
      details.append(summary, code);
      card.append(details);
    }
    section.replaceChildren(card);
    if (focusedAction) {
      section.querySelector('[data-update-action="' + focusedAction + '"]:not(:disabled)')?.focus();
    }
  }

  function createUpdateSteps(state) {
    const activeIndex = {
      downloading: 0,
      staged: 1,
      waiting_for_idle: 1,
      applying: 2,
      awaiting_health: 2,
      committed: 3,
      rolled_back: 2
    }[state];
    if (!Number.isInteger(activeIndex)) return null;
    const labels = [
      utx('Download and verify', '下载并验证'),
      utx('Wait for a safe point', '等待安全时机'),
      utx('Restart and health check', '重启并健康检查')
    ];
    const list = document.createElement('ol');
    list.className = 'consent-update-steps';
    labels.forEach((label, index) => {
      const item = document.createElement('li');
      const status = state === 'committed'
        ? 'done'
        : state === 'rolled_back' && index === 2
          ? 'error'
          : index < activeIndex
            ? 'done'
            : index === activeIndex
              ? 'active'
              : 'pending';
      item.className = 'is-' + status;
      const marker = document.createElement('span');
      marker.className = 'consent-update-step-marker';
      marker.textContent = String(index + 1);
      const text = document.createElement('span');
      text.textContent = label;
      item.append(marker, text);
      list.append(item);
    });
    return list;
  }

  function createUpdateFootnote(state) {
    if (!['downloading', 'staged', 'waiting_for_idle', 'applying', 'awaiting_health'].includes(state)) return null;
    const note = document.createElement('p');
    note.className = 'consent-update-footnote';
    note.textContent = ['applying', 'awaiting_health'].includes(state)
      ? utx('This popup may close briefly while the extension restarts.', '扩展重启时此窗口可能会短暂关闭。')
      : utx('You can close this popup. The update continues in the background.', '可以关闭此窗口，更新会在后台继续。');
    return note;
  }

  function getVisibleActions(view = {}, busyAction = '') {
    const state = view.state?.state || 'idle';
    if (busyAction) {
      return [{ id: busyAction, label: getBusyLabel(busyAction), primary: true, disabled: true }];
    }
    if (state === 'update_available') {
      return [
        { id: 'later', label: utx('Later', '稍后提醒'), primary: false },
        { id: 'install', label: utx('Update now', '立即更新'), primary: true }
      ];
    }
    if (['staged', 'waiting_for_idle'].includes(state)) {
      return [{ id: 'later', label: utx('Later', '稍后提醒'), primary: false }];
    }
    if (['downloading', 'applying', 'awaiting_health', 'checking'].includes(state)) return [];
    if (state === 'committed') {
      return [{ id: 'dismiss', label: utx('Done', '完成'), primary: true }];
    }
    if (['failed', 'rolled_back'].includes(state)) {
      return [{ id: 'retry', label: utx('Retry', '重试'), primary: true }];
    }
    return [{ id: 'check', label: utx('Check latest', '检查更新'), primary: false }];
  }

  function getBusyLabel(action) {
    return {
      check: utx('Checking...', '正在检查...'),
      retry: utx('Checking...', '正在检查...'),
      install: utx('Starting update...', '正在启动更新...'),
      later: utx('Saving...', '正在保存...')
      , dismiss: utx('Closing...', '正在关闭...')
    }[action] || utx('Working...', '处理中...');
  }

  function getUpdateCopy(state, view) {
    const current = state.currentVersion ? 'v' + state.currentVersion : '';
    const latest = state.latestVersion ? 'v' + state.latestVersion : '';
    const blocker = formatBlocker(state.blocker);
    const map = {
      idle: [utx('Updates', '更新'), utx('Up to date', '已是最新版'), utx('Signed stable channel.', '签名稳定版通道。')],
      checking: [utx('Checking for updates', '正在检查更新'), '', utx('Checking the latest signed stable release', '正在检查最新签名稳定版本')],
      update_available: [utx('Update available', '发现新版本'), latest, view.snoozed ? utx('Reminder paused. Update remains ready here.', '提醒已暂停，仍可随时从这里更新。') : utx('Signed stable update for the extension and Native Host.', '扩展与 Native Host 的签名稳定更新。')],
      downloading: [utx('Downloading update', '正在下载更新'), latest, utx('Downloading and verifying the coordinated update', '正在下载并验证协调更新')],
      staged: [utx('Update ready', '更新已就绪'), latest, utx('Verified and ready to install at a safe point.', '已完成验证，将在安全时机安装。')],
      waiting_for_idle: [utx('Waiting for a safe point', '正在等待安全时机'), latest, blocker],
      applying: [utx('Installing update', '正在安装更新'), latest, utx('Installing extension and Native Host', '正在安装扩展与 Native Host')],
      awaiting_health: [utx('Checking updated components', '正在检查更新后的组件'), latest, utx('Restarting and checking both components', '正在重启并检查两个组件')],
      committed: [utx('Update complete', '更新完成'), latest || current, utx('Extension and Native Host are healthy.', '扩展与 Native Host 均运行正常。')],
      rolled_back: [utx('Previous version restored', '已恢复上一版本'), current, utx('Health check failed, so the previous coordinated pair was restored.', '健康检查失败，已恢复上一组协调版本。')],
      failed: [utx('Update could not continue', '更新无法继续'), latest, state.message || utx('Check the details and retry.', '请查看详情后重试。')]
    };
    const value = map[state.state] || map.idle;
    return { title: value[0], version: value[1], detail: value[2], phase: value[2] };
  }

  function formatBlocker(blocker) {
    const labels = {
      unsaved: utx('Overleaf has not confirmed that this document is saved.', 'Overleaf 尚未确认当前文档已保存。'),
      active_run: utx('A Codex task is still running.', 'Codex 任务仍在运行。'),
      cancelling: utx('Cancellation is still settling.', '取消操作仍在收尾。'),
      storage_write: utx('Extension state is still being saved.', '扩展状态仍在保存。'),
      review_action: utx('Accept or Undo is still running.', '接受或撤销操作仍在进行。'),
      dialog_open: utx('A confirmation dialog is open.', '确认对话框仍处于打开状态。'),
      native_project_locked: utx('Native Host still holds a project lock.', 'Native Host 仍持有项目锁。'),
      native_run_active: utx('Native Host is still processing a task.', 'Native Host 仍在处理任务。')
    };
    return labels[blocker] || utx('Waiting until every Overleaf tab is saved and idle.', '正在等待所有 Overleaf 标签页完成保存并进入空闲状态。');
  }

  function utx(english, chinese) {
    const locale = document.documentElement?.lang || 'en';
    return /^zh\b/i.test(locale) ? chinese : english;
  }

  function injectConsentUpdateStyles() {
    if (document.getElementById('codex-overleaf-consent-update-styles')) return;
    const style = document.createElement('style');
    style.id = 'codex-overleaf-consent-update-styles';
    style.textContent = [
      'html { overflow:hidden; background:#171918; }',
      'body { width:344px; padding:16px; background:#171918; color:#eceeec; font-family:"Avenir Next","Segoe UI",sans-serif; }',
      'h1 { font-size:16px; letter-spacing:-.01em; }',
      '.version-status { color:#a8ada9; }',
      '.status-icon { min-width:10px; min-height:10px; width:10px; height:10px; box-shadow:0 0 0 3px rgba(255,255,255,.04); }',
      '.status-icon.compatible { background:#7fd58a; } .status-icon.update-available { background:#d7b96e; } .status-icon.incompatible { background:#d87972; }',
      '#open-panel { border-color:#39403c; background:#242825; color:#dfe4df; font-weight:600; }',
      '#status { color:#9ba19c; font-size:12px; }',
      '.consent-updates { margin-top:14px; padding-top:13px; border-top:1px solid #303431; }',
      '.consent-update-card { padding-top:1px; }',
      '.consent-update-head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; }',
      '.consent-update-head strong { font-size:13px; color:#f0f2f0; } .consent-update-head span { color:#85d99a; font-size:11px; font-weight:700; }',
      '.consent-update-detail,.consent-update-phase { color:#a9aea9; font-size:12px; line-height:1.45; }',
      '.consent-update-progress { position:relative; height:4px; margin:12px 0 8px; overflow:hidden; border-radius:999px; background:#2c312e; }',
      '.consent-update-progress span { display:block; height:100%; border-radius:inherit; background:#4f9ee8; transition:width .25s ease; }',
      '.consent-update-progress.is-indeterminate span { width:42% !important; animation:consent-progress 1.25s ease-in-out infinite; }',
      '.consent-update-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:12px; }',
      '.consent-update-actions button { width:auto; min-width:92px; margin:0; padding:7px 12px; font-weight:650; }',
      '.consent-update-actions .update-primary { border-color:#4a91d7; background:#3578bd; }',
      '.consent-update-actions .update-secondary { border-color:#3c433f; background:transparent; color:#d5dad6; }',
      '.consent-update-actions button:focus-visible { outline:2px solid #79b8f2; outline-offset:2px; }',
      '.consent-update-live { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }',
      '.consent-update-card details { margin-top:10px; color:#a9aea9; font-size:11px; } .consent-update-card details code { background:#202320; color:#c9ceca; }',
      'body .consent-updates { margin-top:16px; padding:13px 0 0; border:0; border-top:1px solid #303733; border-radius:0; background:transparent; }',
      'body .consent-update-card { border:0; padding:0; background:transparent; box-shadow:none; }',
      'body .consent-updates.is-quiet .consent-update-card { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:6px 12px; }',
      'body .consent-updates.is-quiet .consent-update-detail { display:none; }',
      'body .consent-updates.is-quiet .consent-update-actions { grid-column:2; grid-row:1; margin:0; }',
      'body .consent-updates.is-quiet .consent-update-actions button { width:auto; min-width:0; padding:5px 9px; border-color:transparent; background:transparent; color:#aeb7b1; }',
      'body .consent-updates.is-offer, body .consent-updates.is-focus { padding-top:0; border-top:0; }',
      'body .consent-updates.is-offer .consent-update-card { padding:15px; border:1px solid #34433b; border-radius:12px; background:linear-gradient(145deg,#202622,#1b201d); box-shadow:0 12px 32px rgba(0,0,0,.16); }',
      'body.consent-update-focus { width:340px; min-height:340px; padding:20px; }',
      'body.consent-update-focus > .version-status, body.consent-update-focus > #open-panel, body.consent-update-focus > #status, body.consent-update-focus > .install { display:none !important; }',
      'body.consent-update-focus > h1 { margin-bottom:18px; }',
      'body.consent-update-focus .consent-updates { margin-top:0; padding:0; border:0; }',
      'body.consent-update-focus .consent-update-card { min-height:274px; padding:18px; border:1px solid #35443d; border-radius:14px; background:radial-gradient(circle at 95% 0,rgba(79,158,232,.12),transparent 42%),linear-gradient(150deg,#202522,#1a1e1c); box-shadow:0 18px 42px rgba(0,0,0,.24); }',
      '.consent-update-route { margin:9px 0 0; color:#d9e6dd; font:600 13px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:-.02em; }',
      '.consent-update-steps { display:grid; gap:10px; margin:16px 0 0; padding:0; list-style:none; }',
      '.consent-update-steps li { display:grid; grid-template-columns:24px minmax(0,1fr); align-items:center; gap:9px; color:#8f9892; font-size:12px; }',
      '.consent-update-step-marker { display:inline-flex; width:22px; height:22px; align-items:center; justify-content:center; border:1px solid #3a413d; border-radius:999px; color:#89918c; font:700 10px/1 ui-monospace,monospace; }',
      '.consent-update-steps li.is-done { color:#aeb9b2; }',
      '.consent-update-steps li.is-done .consent-update-step-marker { border-color:#42694f; color:#8bd79e; background:#21392a; }',
      '.consent-update-steps li.is-active { color:#edf2ef; }',
      '.consent-update-steps li.is-active .consent-update-step-marker { border-color:#68a8e2; color:#eef7ff; background:#2d669a; box-shadow:0 0 0 3px rgba(98,168,232,.12); }',
      '.consent-update-steps li.is-error .consent-update-step-marker { border-color:#9d554f; color:#ffd9d5; background:#542b28; }',
      '.consent-update-footnote { margin:15px 0 0; padding-top:12px; border-top:1px solid #303733; color:#929b95; font-size:11px; }',
      'body .consent-updates.is-result .consent-update-progress { margin-top:18px; }',
      'body .consent-updates.is-focus .consent-update-actions { margin-top:18px; }',
      '@keyframes consent-progress { 0% { transform:translateX(-110%); } 100% { transform:translateX(240%); } }',
      '@media (prefers-reduced-motion:reduce) { .consent-update-progress.is-indeterminate span { animation:none; width:65% !important; } }'
    ].join('\n');
    document.head.append(style);
  }
})();
