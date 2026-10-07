(function initCodexOverleafUpdateIdle(root) {
  'use strict';

  function create(options = {}) {
    let lastUserActivityAt = Date.now();
    let stableSavedSince = 0;
    let applying = false;
    let saveIdentity;
    const documentRef = options.document || root.document;
    const noteActivity = event => {
      if (!options.includePanelActivity && event?.target?.closest?.('#codex-overleaf-panel')) return;
      lastUserActivityAt = Date.now();
      stableSavedSince = 0;
    };
    for (const eventName of ['input', 'keydown', 'pointerdown']) {
      documentRef?.addEventListener?.(eventName, noteActivity, true);
    }

    function handleMessage(message, sendResponse) {
      if (message?.type === 'codex-overleaf/update-idle-probe') {
        buildIdleProbe().then(sendResponse).catch(() => sendResponse({ idle: false, saved: false, blockers: ['idle_probe_failed'] }));
        return true;
      }
      if (message?.type === 'codex-overleaf/update-state') {
        const state = String(message.state || '');
        applying = state === 'applying' || state === 'awaiting_health' || state === 'rolling_back';
        options.onApplyingChange?.(applying);
        const copy = options.getStateMessage?.(state);
        if (copy) options.showToast?.(copy, { status: state === 'rolled_back' ? 'warning' : 'info', sticky: applying });
        sendResponse?.({ ok: true });
        return false;
      }
      return false;
    }

    async function buildIdleProbe() {
      const busy = options.getBusyState?.() || {};
      const blockers = Object.entries(busy).filter(([_key, value]) => Boolean(value)).map(([key]) => key);
      let saveResult;
      try {
        saveResult = await options.checkSaved?.();
      } catch (_error) {
        saveResult = { ok: false, state: 'unavailable' };
      }
      const saved = saveResult?.ok === true && ['verified_saved', 'verified_quiet'].includes(saveResult?.state);
      if (saveResult?.identity !== saveIdentity) { stableSavedSince = 0; saveIdentity = saveResult?.identity; }
      if (saved) {
        stableSavedSince = stableSavedSince || Date.now();
      } else {
        stableSavedSince = 0;
        blockers.push('save_state_unverified');
      }
      const now = Date.now();
      if (now - lastUserActivityAt < 30000) blockers.push('recent_user_activity');
      if (!stableSavedSince || now - stableSavedSince < 3000) blockers.push('save_state_not_stable');
      return {
        idle: blockers.length === 0,
        saved,
        lastUserActivityAt,
        stableSavedSince,
        blockers: [...new Set(blockers)]
      };
    }

    return {
      buildIdleProbe,
      noteActivity,
      handleMessage,
      isApplying: () => applying
    };
  }

  root.CodexOverleafUpdateIdle = Object.freeze({ create });
})(typeof window !== 'undefined' ? window : globalThis);
