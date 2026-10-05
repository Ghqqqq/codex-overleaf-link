(function initCodexOverleafUpdateStatus(root) {
  'use strict';

  const BLOCKER_MESSAGES = Object.freeze({
    run: 'A Codex run is still active.',
    cancelling: 'A Codex cancellation is still settling.',
    storage: 'Extension state is still being saved.',
    reviewAction: 'An Accept or Undo action is still running.',
    dialog: 'A confirmation dialog is still open.',
    save_state_unverified: 'Overleaf has not confirmed that the document is saved.',
    recent_user_activity: 'Recent editor activity must be idle for 30 seconds.',
    save_state_not_stable: 'The saved state must remain stable for 3 seconds.',
    idle_probe_failed: 'The Overleaf idle check failed.',
    tab_unavailable: 'An Overleaf tab is unavailable.',
    tab_probe_timeout: 'An Overleaf tab did not answer the idle check in time.',
    tab_probe_unavailable: 'Reload an Overleaf tab so the updater can verify that it is idle.',
    tab_not_idle: 'An Overleaf tab is still busy.',
    native_project_locked: 'The native host still holds a project lock.',
    native_run_active: 'The native host is still processing a Codex run.',
    native_process_stop_unconfirmed: 'A previous Codex process has not yet confirmed its exit.',
    native_gate_unavailable: 'The native host could not report whether it is idle.',
    native_not_idle: 'The native host is still busy.',
    busy: 'An update safety check is still busy.'
  });

  function normalizeBlockers(values = []) {
    const result = [];
    const seen = new Set();
    const visit = value => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const code = String(value || '').trim();
      if (!code || seen.has(code)) return;
      seen.add(code);
      result.push(code);
    };
    visit(values);
    return result;
  }

  function collectBlockers(probes = [], nativeGate = null) {
    const blockers = [];
    for (const probe of probes || []) {
      if (probe?.idle === true) continue;
      if (Array.isArray(probe?.blockers) && probe.blockers.length) {
        blockers.push(probe.blockers);
      } else {
        blockers.push('tab_not_idle');
      }
    }
    if (!nativeGate?.ok) {
      blockers.push(nativeGate?.error?.code || 'native_gate_unavailable');
    } else if (nativeGate.result?.idle !== true) {
      blockers.push(nativeGate.result?.blockers?.length ? nativeGate.result.blockers : 'native_not_idle');
    }
    return normalizeBlockers(blockers);
  }

  function describeBlocker(code) {
    const normalized = String(code || '').trim();
    if (!normalized) return '';
    return BLOCKER_MESSAGES[normalized]
      || `Update is waiting on: ${normalized.replaceAll('_', ' ')}.`;
  }

  function formatBlockers(blockers = []) {
    return normalizeBlockers(blockers).map(describeBlocker).filter(Boolean).join(' ');
  }

  root.CodexOverleafUpdateStatus = Object.freeze({
    BLOCKER_MESSAGES,
    collectBlockers,
    describeBlocker,
    formatBlockers,
    normalizeBlockers
  });
})(typeof window !== 'undefined' ? window : globalThis);
