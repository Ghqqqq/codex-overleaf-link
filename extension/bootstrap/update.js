(() => {
  'use strict';

  const MESSAGE_TYPES = Object.freeze({
    get: 'codex-overleaf/consent-update-get-state',
    check: 'codex-overleaf/consent-update-check',
    install: 'codex-overleaf/consent-update-install',
    later: 'codex-overleaf/consent-update-later',
    retry: 'codex-overleaf/consent-update-check'
  });
  const ACTIVE_PHASES = new Set([
    'checking',
    'downloading',
    'staged',
    'waiting',
    'waiting_for_idle',
    'waiting_for_safe_point',
    'applying',
    'awaiting_health',
    'awaiting_health_check',
    'health_checking'
  ]);

  const elements = {
    badge: document.getElementById('status-badge'),
    title: document.getElementById('update-title'),
    route: document.getElementById('version-route'),
    detail: document.getElementById('update-detail'),
    progressTrack: document.getElementById('progress-track'),
    progressFill: document.getElementById('progress-fill'),
    stages: Array.from(document.querySelectorAll('#update-stages > li')),
    note: document.getElementById('persistence-note'),
    details: document.getElementById('technical-details'),
    technicalMessage: document.getElementById('technical-message'),
    actions: document.getElementById('update-actions')
  };

  let currentView = {};
  let pollTimer = null;
  let refreshTimer = null;
  let actionPending = false;

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function unwrapResponse(response) {
    const root = asObject(response) || {};
    if (root.ok === false) {
      const error = new Error(root.error?.message || root.message || 'Update action failed.');
      error.code = root.error?.code || root.code || 'update_failed';
      throw error;
    }
    const candidates = [
      root.view,
      root.result?.view,
      root.result,
      root.updateConsent,
      root.updateState,
      root.state
    ];
    return candidates.find(asObject) || root;
  }

  async function request(action) {
    const type = MESSAGE_TYPES[action];
    if (!type) throw new Error(`Unsupported update action: ${action}`);
    return unwrapResponse(await chrome.runtime.sendMessage({ type }));
  }

  function phaseOf(view) {
    const value = view.phase || view.status || view.state || view.lifecycle || 'idle';
    return typeof value === 'string' ? value.toLowerCase().replace(/[- ]+/g, '_') : 'idle';
  }

  function versionOf(view, candidates, fallback = '') {
    for (const key of candidates) {
      const value = view[key];
      if (typeof value === 'string' && value.trim()) return value.trim().replace(/^v/i, '');
    }
    return fallback;
  }

  function presentationFor(view) {
    const phase = phaseOf(view);
    const presentations = {
      idle: ['Stable updates', 'Automatically checks signed stable releases.', 'Ready', 'neutral'],
      up_to_date: ['Everything is up to date', 'Extension and Native Host are on the latest stable release.', 'Up to date', 'success'],
      checking: ['Checking for updates', 'Reading the latest signed stable release.', 'Checking', 'active'],
      update_available: ['A stable update is ready', 'Review the target version, then update when convenient.', 'Available', 'success'],
      downloading: ['Downloading the signed release', 'The package is being fetched and verified before any files change.', 'Downloading', 'active'],
      staged: ['Update verified', 'The signed package is ready and waiting for a safe installation point.', 'Verified', 'active'],
      waiting: ['Waiting for a safe point', 'Active Overleaf work will finish before the runtime changes.', 'Waiting', 'warning'],
      waiting_for_idle: ['Waiting for a safe point', 'Active Overleaf work will finish before the runtime changes.', 'Waiting', 'warning'],
      waiting_for_safe_point: ['Waiting for a safe point', 'Active Overleaf work will finish before the runtime changes.', 'Waiting', 'warning'],
      applying: ['Installing the update', 'Extension and Native Host are being switched as one managed unit.', 'Installing', 'active'],
      awaiting_health: ['Verifying the installation', 'The updated components are restarting and reconnecting.', 'Verifying', 'active'],
      awaiting_health_check: ['Verifying the installation', 'The updated components are restarting and reconnecting.', 'Verifying', 'active'],
      health_checking: ['Verifying the installation', 'The updated components are restarting and reconnecting.', 'Verifying', 'active'],
      committed: ['Update complete', 'Extension and Native Host passed the post-update health check.', 'Complete', 'success'],
      failed: ['Update could not continue', 'No further update steps will run until the failure is retried.', 'Needs attention', 'error'],
      rolled_back: ['Previous version restored', 'The health check failed, so the managed update was rolled back safely.', 'Rolled back', 'warning'],
      deferred: ['Update paused', 'The available update will remain ready for a later installation.', 'Later', 'neutral']
    };
    const [title, detail, badge, tone] = presentations[phase] || presentations.idle;
    return { phase, title, detail, badge, tone };
  }

  function progressFor(view, phase) {
    const raw = asObject(view.progress)?.percent ?? view.progressPercent ?? view.progress;
    if (Number.isFinite(Number(raw))) {
      const numeric = Number(raw);
      return Math.max(0, Math.min(100, numeric <= 1 ? numeric * 100 : numeric));
    }
    const fallback = {
      checking: 8,
      update_available: 0,
      downloading: 25,
      staged: 48,
      waiting: 55,
      waiting_for_idle: 55,
      waiting_for_safe_point: 55,
      applying: 75,
      awaiting_health: 90,
      awaiting_health_check: 90,
      health_checking: 90,
      committed: 100,
      rolled_back: 100
    };
    return fallback[phase] ?? 0;
  }

  function activeStageFor(phase) {
    if (['downloading'].includes(phase)) return 0;
    if (['staged', 'waiting', 'waiting_for_idle', 'waiting_for_safe_point'].includes(phase)) return 1;
    if (['applying', 'awaiting_health', 'awaiting_health_check', 'health_checking'].includes(phase)) return 2;
    if (phase === 'committed') return 3;
    return -1;
  }

  function errorStageFor(view, phase) {
    if (!['failed', 'rolled_back'].includes(phase)) return -1;
    const stage = String(view.failureStage || view.error?.stage || '').toLowerCase();
    if (/download|verify|signature|manifest/.test(stage)) return 0;
    if (/idle|safe|wait/.test(stage)) return 1;
    return 2;
  }

  function technicalText(view) {
    const value = view.technicalDetail || view.error?.technicalDetail || view.error?.message || view.error || view.message;
    if (!value) return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function actionDefinitions(phase) {
    if (phase === 'update_available') {
      return [
        { id: 'later', label: 'Later', kind: 'quiet' },
        { id: 'install', label: 'Update now', kind: 'primary' }
      ];
    }
    if (['failed', 'rolled_back'].includes(phase)) {
      return [
        { id: 'close', label: 'Close', kind: 'quiet' },
        { id: 'retry', label: 'Retry', kind: 'primary' }
      ];
    }
    if (phase === 'committed') {
      return [{ id: 'close', label: 'Done', kind: 'primary' }];
    }
    if (ACTIVE_PHASES.has(phase)) {
      return [{ id: 'close', label: 'Close window', kind: 'quiet' }];
    }
    return [{ id: 'close', label: 'Close', kind: 'quiet' }];
  }

  function renderActions(phase) {
    elements.actions.replaceChildren(...actionDefinitions(phase).map(action => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.action = action.id;
      button.dataset.kind = action.kind;
      button.textContent = action.label;
      button.disabled = actionPending;
      return button;
    }));
  }

  function render(view) {
    currentView = asObject(view) || {};
    const presentation = presentationFor(currentView);
    const installed = versionOf(currentView, ['currentVersion', 'installedVersion', 'extensionVersion'], chrome.runtime.getManifest().version);
    const target = versionOf(currentView, ['latestVersion', 'targetVersion', 'availableVersion'], 'latest stable');
    const hasTarget = target && target !== 'latest stable' && target !== installed;
    elements.route.textContent = hasTarget ? `v${installed}  →  v${target}` : `Installed v${installed}`;
    elements.title.textContent = presentation.title;
    elements.detail.textContent = typeof currentView.detail === 'string' && currentView.detail.trim()
      ? currentView.detail.trim()
      : presentation.detail;
    elements.badge.textContent = presentation.badge;
    elements.badge.dataset.tone = presentation.tone;

    const progress = progressFor(currentView, presentation.phase);
    const showProgress = ACTIVE_PHASES.has(presentation.phase) || ['committed', 'rolled_back'].includes(presentation.phase);
    elements.progressTrack.hidden = !showProgress;
    elements.progressTrack.dataset.indeterminate = presentation.phase === 'checking' ? 'true' : 'false';
    elements.progressTrack.setAttribute('aria-valuenow', String(Math.round(progress)));
    elements.progressFill.style.width = `${progress}%`;

    const activeStage = activeStageFor(presentation.phase);
    const errorStage = errorStageFor(currentView, presentation.phase);
    elements.stages.forEach((stage, index) => {
      let state = 'pending';
      if (index < activeStage || activeStage === 3) state = 'done';
      if (index === activeStage) state = 'active';
      if (index === errorStage) state = 'error';
      stage.dataset.state = state;
      const marker = stage.querySelector('.stage-marker');
      marker.textContent = state === 'done' ? '✓' : String(index + 1);
    });

    const restarting = ['applying', 'awaiting_health', 'awaiting_health_check', 'health_checking'].includes(presentation.phase);
    elements.note.textContent = restarting
      ? 'The extension may restart briefly. This window will reconnect and restore the saved progress.'
      : 'This window can stay open while work continues elsewhere. Progress is saved automatically.';

    const technical = technicalText(currentView);
    elements.details.hidden = !technical || !['failed', 'rolled_back'].includes(presentation.phase);
    elements.technicalMessage.textContent = technical;
    renderActions(presentation.phase);
    schedulePolling(presentation.phase);
  }

  function renderReconnecting() {
    elements.title.textContent = 'Reconnecting after restart';
    elements.detail.textContent = 'The saved update state will return when the extension is available again.';
    elements.badge.textContent = 'Reconnecting';
    elements.badge.dataset.tone = 'active';
    elements.progressTrack.hidden = false;
    elements.progressTrack.dataset.indeterminate = 'true';
    elements.actions.replaceChildren();
  }

  function renderLocalFailure(error) {
    render({
      ...currentView,
      phase: 'failed',
      detail: error?.message || 'Update action failed.',
      technicalDetail: `${error?.code || 'update_failed'}: ${error?.message || 'Update action failed.'}`
    });
  }

  function isTransientContextError(error) {
    return /context invalidated|receiving end does not exist|message port closed|could not establish connection/i.test(String(error?.message || error));
  }

  async function refresh() {
    try {
      render(await request('get'));
    } catch (error) {
      if (isTransientContextError(error)) {
        renderReconnecting();
        window.setTimeout(() => window.location.reload(), 900);
        return;
      }
      renderLocalFailure(error);
    }
  }

  function scheduleRefresh() {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(refresh, 80);
  }

  function schedulePolling(phase) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
    if (!ACTIVE_PHASES.has(phase)) return;
    pollTimer = window.setTimeout(async () => {
      await refresh();
    }, 1100);
  }

  async function runAction(action) {
    if (actionPending) return;
    if (action === 'close') {
      window.close();
      return;
    }
    actionPending = true;
    renderActions(phaseOf(currentView));
    try {
      render(await request(action));
      if (action === 'later') window.close();
    } catch (error) {
      if (isTransientContextError(error)) {
        renderReconnecting();
        window.setTimeout(() => window.location.reload(), 900);
      } else {
        renderLocalFailure(error);
      }
    } finally {
      actionPending = false;
      if (document.visibilityState !== 'unloaded') renderActions(phaseOf(currentView));
    }
  }

  elements.actions.addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    if (button) runAction(button.dataset.action);
  });

  try {
    chrome.storage.onChanged.addListener((_changes, areaName) => {
      if (areaName === 'local') scheduleRefresh();
    });
  } catch {
    renderReconnecting();
  }

  const requestedAction = new URLSearchParams(window.location.search).get('action');
  window.history.replaceState(null, '', window.location.pathname);
  refresh().then(() => {
    if (requestedAction && ['install', 'retry'].includes(requestedAction)) runAction(requestedAction);
  });
})();
