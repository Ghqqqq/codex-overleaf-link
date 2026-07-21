(function initCodexOverleafActiveTurnControl(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafActiveTurnControl = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function activeTurnControlFactory() {
  'use strict';

  function create(options = {}) {
    const runtime = options.chrome?.runtime;
    let port = null;
    let binding = null;
    let reconnectTimer = null;
    let destroyed = false;

    function connect() {
      if (destroyed || port || typeof runtime?.connect !== 'function') {
        return;
      }
      try {
        const nextPort = runtime.connect({ name: 'codex-overleaf/run-owner' });
        port = nextPort;
        nextPort.onDisconnect?.addListener?.(() => {
          if (port === nextPort) {
            port = null;
          }
          if (!destroyed) {
            reconnectTimer = setTimeout(connect, 50);
          }
        });
        if (binding) {
          postBinding('bind', binding);
        }
      } catch (_error) {
        port = null;
      }
    }

    function postBinding(type, value) {
      try {
        port?.postMessage?.({ type, ...value });
      } catch (_error) {
        port = null;
      }
    }

    function bind(value = {}) {
      binding = {
        requestId: String(value.requestId || ''),
        projectKey: String(value.projectKey || ''),
        clientRunId: String(value.clientRunId || ''),
        sessionId: String(value.sessionId || '')
      };
      connect();
      postBinding('bind', binding);
    }

    function release(requestId) {
      if (!binding || (requestId && binding.requestId !== requestId)) {
        return;
      }
      postBinding('release', binding);
      binding = null;
    }

    async function listJournals(projectKey) {
      if (typeof runtime?.sendMessage !== 'function') {
        return [];
      }
      const response = await runtime.sendMessage({
        type: 'codex-overleaf/run-journal/list',
        projectKey: String(projectKey || '')
      });
      return response?.ok && Array.isArray(response.journals) ? response.journals : [];
    }

    async function acknowledge(requestId) {
      if (!requestId || typeof runtime?.sendMessage !== 'function') {
        return false;
      }
      const response = await runtime.sendMessage({
        type: 'codex-overleaf/run-journal/ack',
        requestId
      });
      return response?.ok === true;
    }

    async function recoverJournals(options = {}) {
      const projectKey = String(options.projectKey || '');
      if (!projectKey) {
        return false;
      }
      const journals = await listJournals(projectKey).catch(() => []);
      let changed = false;
      for (const journal of journals) {
        const session = options.findSession?.(journal.sessionId) || options.getActiveSession?.();
        if (!session) {
          continue;
        }
        let record = (session.runs || []).find(run => run.id === journal.clientRunId);
        if (!record && journal.clientRunId) {
          record = options.createInterruptedRun?.(journal, projectKey);
          if (record) {
            session.runs = [...(session.runs || []), record].slice(-20);
          }
        }
        if (!record) {
          continue;
        }
        const reloadReports = (record.events || []).filter(event => event?.failure?.source === 'panel_reload');
        record.events = (record.events || []).filter(event => event?.failure?.source !== 'panel_reload');
        const lastSequence = Number(record.nativeEventSeq || 0);
        for (const entry of Array.isArray(journal.events) ? journal.events : []) {
          const sequence = Number(entry?.sequence || 0);
          if (sequence <= lastSequence) {
            continue;
          }
          const raw = entry?.event || {};
          if (raw.type === 'codex.turn.bound') {
            session.codexThreadId = String(raw.detail?.threadId || session.codexThreadId || '');
            record.codexTurnId = String(raw.detail?.turnId || record.codexTurnId || '');
            record.nativeEventSeq = sequence;
            continue;
          }
          const recovered = options.mapEvent?.(raw, journal);
          if (recovered) {
            if (recovered.kind === 'stream') {
              options.upsertStream?.(record, recovered);
            } else {
              record.events = [...(record.events || []), recovered].slice(-(options.maxEvents || 300));
            }
          }
          record.nativeEventSeq = sequence;
        }
        if (reloadReports.length) {
          record.events = [...(record.events || []), ...reloadReports].slice(-(options.maxEvents || 300));
        }
        if (record.status === 'running' || record.status === 'interrupted') {
          record.status = 'interrupted';
          record.finishedAt = journal.updatedAt || new Date().toISOString();
          record.interruptedDraft = {
            requestId: journal.requestId,
            threadId: session.codexThreadId || '',
            turnId: record.codexTurnId || '',
            lastEventSeq: record.nativeEventSeq || 0,
            reason: journal.ownerLost ? 'page_owner_lost' : 'page_reload'
          };
        }
        options.pauseSessionQueue?.(session, 'page_reload');
        changed = true;
        if (journal.terminal) {
          acknowledge(journal.requestId).catch(() => {});
        }
      }
      return changed;
    }

    function destroy() {
      destroyed = true;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      try {
        port?.disconnect?.();
      } catch (_error) {
        // Best effort.
      }
      port = null;
      binding = null;
    }

    connect();
    return { acknowledge, bind, destroy, listJournals, recoverJournals, release };
  }

  return { create };
});
