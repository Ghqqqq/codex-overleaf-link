(function initCodexOverleafActiveTurnControl(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafActiveTurnControl = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function activeTurnControlFactory() {
  'use strict';

  // Startup has an owner before a Native request exists. This identity is only
  // for ownership probes; nativeRequestId remains reserved for the actual RPC.
  function getStartupRequestId(sessionId, runId) {
    return `startup:${encodeURIComponent(sessionId)}:${encodeURIComponent(runId)}`;
  }

  function create(options = {}) {
    const runtime = options.chrome?.runtime;
    let port = null;
    let binding = null;
    let reconnectTimer = null;
    let destroyed = false;
    let bindingWaiter = null;
    let bindingSequence = 0;
    let recoveryTimer = null;
    let recoveryGeneration = 0;
    const inventoryRetries = new Map();

    function connect() {
      if (destroyed || port || typeof runtime?.connect !== 'function') {
        return;
      }
      try {
        const nextPort = runtime.connect({ name: 'codex-overleaf/run-owner' });
        port = nextPort;
        nextPort.onMessage?.addListener?.(message => {
          if (port !== nextPort || message?.type !== 'bound' || !bindingWaiter || !binding) return;
          if (['requestId', 'projectKey', 'clientRunId', 'sessionId'].every(key => message[key] === binding[key])
            && message.browserOnly === true && message.ownerToken === binding.ownerToken) bindingWaiter(message.ok !== false);
        });
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
      bindingWaiter?.(false);
      binding = {
        requestId: String(value.requestId || ''),
        projectKey: String(value.projectKey || ''),
        clientRunId: String(value.clientRunId || ''),
        sessionId: String(value.sessionId || ''),
        ...(value.browserOnly === true ? { browserOnly: true, ownerToken: String(value.ownerToken || `browser-${++bindingSequence}`) } : {})
      };
      connect();
      postBinding('bind', binding);
    }

    async function bindBrowserRun(value) {
      bind({ ...value, browserOnly: true });
      if (destroyed || !port) return false;
      return new Promise(resolve => {
        const timeout = setTimeout(() => complete(false), 5000);
        const complete = ok => {
          clearTimeout(timeout);
          if (bindingWaiter === complete) bindingWaiter = null;
          resolve(ok);
        };
        bindingWaiter = complete;
        postBinding('bind', binding);
      });
    }

    function release(requestId, ownerToken) {
      if (!binding || (requestId && binding.requestId !== requestId)
        || (ownerToken && ownerToken !== binding.ownerToken)) {
        return;
      }
      bindingWaiter?.(false);
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

    async function knownJournals(requestIds, owners = [], onRetry) {
      if (typeof runtime?.sendMessage !== 'function') return null;
      const known = new Set();
      for (let offset = 0; offset < requestIds.length; offset += 64) {
        const ids = requestIds.slice(offset, offset + 64);
        const response = await runtime.sendMessage({ type: 'codex-overleaf/run-journal/known',
          requestIds: ids, owners: owners.slice(offset, offset + 64) });
        // An older background cannot rule out browser-only owners.
        const needsStartupInventory = owners.slice(offset, offset + 64).some(owner => owner.preDispatch === true);
        if (!response?.ok || !Array.isArray(response.known) || response.ownersChecked !== true
          || (needsStartupInventory && response.preDispatchChecked !== true)) {
          if (Number.isFinite(response?.retryAfterMs) && response.retryAfterMs > 0) onRetry?.(response.retryAfterMs);
          return null;
        }
        for (const id of response.known) if (ids.includes(id)) known.add(id);
      }
      return known;
    }

    // Native journals and live browser-only owners are separate evidence. A
    // missing journal alone cannot establish that another page stopped retrying.
    async function recoverOrphanedRuns(projectKey, options, result, isCurrent) {
      const now = Date.now(), candidates = [];
      let recheckAfterMs = Infinity;
      const sessions = () => options.listSessions?.() || [];
      const requestIdFor = (session, record) => record.nativeRequestId || getStartupRequestId(session.id, record.id);
      const eligible = (session, record) => record.status === 'running' && session.id && record.id
        && !options.isLiveRun?.(record, session)
        && (!session.projectId || session.projectId === projectKey)
        && (!options.accountScopeId || !session.accountScopeId || session.accountScopeId === options.accountScopeId)
        && (!record.runProjectId || record.runProjectId === projectKey);
      for (const session of sessions()) {
        for (const record of session.runs || []) {
          if (!eligible(session, record)) continue;
          const started = Date.parse(record.startedAt);
          if (!Number.isFinite(started)) continue;
          const remaining = started + (options.orphanGraceMs ?? 60000) - now;
          if (remaining > 0) { recheckAfterMs = Math.min(recheckAfterMs, remaining); continue; }
          candidates.push({ session, record, requestId: requestIdFor(session, record) });
        }
      }
      result.recheckAfterMs = Number.isFinite(recheckAfterMs) ? recheckAfterMs : null;
      if (!candidates.length) return;
      const known = await knownJournals(candidates.map(item => item.requestId), candidates.map(({ session, record, requestId }) => ({
        requestId, projectKey, clientRunId: record.id, sessionId: session.id,
        ...(!record.nativeRequestId ? { preDispatch: true } : {})
      })), delay => {
        const key = `${options.accountScopeId || ''}:${projectKey}`;
        const attempts = inventoryRetries.get(key) || 0;
        if (attempts >= 3) return;
        inventoryRetries.set(key, attempts + 1);
        result.recheckAfterMs = Math.min(result.recheckAfterMs ?? Infinity, delay);
      }).catch(() => null);
      if (!known || !isCurrent()) return;
      inventoryRetries.delete(`${options.accountScopeId || ''}:${projectKey}`);
      for (const { session, record, requestId } of candidates) {
        const currentSession = sessions().find(value => value.id === session.id);
        // State normalization can replace run objects while inventory is pending.
        if (!currentSession?.runs?.includes(record) || !eligible(currentSession, record)
          || requestIdFor(currentSession, record) !== requestId || known.has(requestId)) continue;
        if (!record.runProjectId) record.runProjectId = projectKey;
        options.normalizeInterruptedRun?.(record);
        record.status = 'interrupted';
        record.interruptedDraft = { requestId, threadId: currentSession.codexThreadId || '',
          turnId: record.codexTurnId || '', lastEventSeq: record.nativeEventSeq || 0, reason: 'extension_reloaded' };
        options.pauseSessionQueue?.(currentSession, 'page_reload');
        result.changed = true;
        result.recoveredRuns.push({ sessionId: currentSession.id, runId: record.id,
          projectId: projectKey, accountScopeId: options.accountScopeId });
      }
    }

    function cancelRecovery() {
      recoveryGeneration++;
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
    }

    async function recoverJournals(options = {}) {
      cancelRecovery();
      const generation = recoveryGeneration;
      const isCurrent = () => !destroyed && generation === recoveryGeneration && options.isCurrent?.() !== false;
      const projectKey = String(options.projectKey || '');
      if (!projectKey) {
        return { changed: false, acknowledgeIds: [] };
      }
      const journals = await listJournals(projectKey).catch(() => []);
      if (!isCurrent()) return { changed: false, acknowledgeIds: [], recoveredRuns: [] };
      let changed = false;
      const acknowledgeIds = [];
      const recoveredRuns = [];
      for (const journal of journals) {
        if (!journal?.terminal && !journal?.ownerLost) {
          continue;
        }
        // Native completion can precede the owner's writeback and durable
        // session save. A passive shared-history reader must not settle it.
        if (options.requireOwnerLost === true && journal.ownerLost !== true) {
          continue;
        }
        const session = options.findSession?.(journal.sessionId);
        if (!session || (session.projectId && session.projectId !== projectKey)
          || (options.accountScopeId && session.accountScopeId && session.accountScopeId !== options.accountScopeId)) {
          continue;
        }
        let record = (session.runs || []).find(run => run.id === journal.clientRunId);
        if (!record && journal.clientRunId) {
          record = options.createInterruptedRun?.(journal, projectKey);
          if (record) {
            session.runs = [...(session.runs || []), record].slice(-20);
          }
        }
        if (!record || options.isLiveRun?.(record, session)) {
          continue;
        }
        if (record.runProjectId && record.runProjectId !== projectKey) continue;
        if (!record.runProjectId) record.runProjectId = projectKey;
        if (journal.operation === 'compact') {
          record.operation = 'compact';
          if (!record.codexThreadId) record.codexThreadId = String(journal.threadId || '');
          if (session.contextUsage?.threadId === record.codexThreadId
            && Date.parse(session.contextUsage.observedAt || '') < Date.parse(record.startedAt || '')) {
            session.contextUsage = null;
          }
        }
        if (record.status === 'running') {
          options.normalizeInterruptedRun?.(record);
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
            record.codexThreadId = String(raw.detail?.threadId || record.codexThreadId || '');
            record.codexTurnId = String(raw.detail?.turnId || record.codexTurnId || '');
            record.nativeEventSeq = sequence;
            continue;
          }
          // Non-display state (for example context usage) must also recover
          // from the journal, after the owning thread/turn has been bound.
          options.onRawEvent?.(raw, { record, session, sequence, journal });
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
        acknowledgeIds.push(journal.requestId);
        recoveredRuns.push({ sessionId: session.id, runId: record.id,
          projectId: projectKey, accountScopeId: options.accountScopeId });
      }
      const result = { changed, acknowledgeIds, recoveredRuns };
      await recoverOrphanedRuns(projectKey, options, result, isCurrent);
      if (isCurrent() && result.recheckAfterMs !== null && typeof options.onRecheck === 'function') {
        recoveryTimer = setTimeout(() => {
          recoveryTimer = null;
          if (isCurrent()) Promise.resolve(options.onRecheck()).catch(() => {});
        }, Math.min(result.recheckAfterMs, 2147483647));
      }
      return result;
    }

    function destroy() {
      destroyed = true;
      cancelRecovery();
      bindingWaiter?.(false);
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
    return { acknowledge, bind, bindBrowserRun, cancelRecovery, destroy, getOwner: () => binding ? { ...binding } : null,
      knownJournals, listJournals, recoverJournals, release };
  }

  function createInterruptedRun(journal, projectKey, statusText) {
    return { id: journal.clientRunId, task: journal.task || 'interrupted task', mode: journal.mode || 'ask',
      ...(journal.operation === 'compact' ? { operation: 'compact', codexThreadId: String(journal.threadId || '') } : {}),
      model: journal.model || '', status: 'interrupted', statusText, runProjectId: projectKey,
      startedAt: journal.createdAt || new Date().toISOString(), finishedAt: journal.updatedAt || new Date().toISOString(),
      events: [], attachments: [], undoOperations: [], undoTrackedChanges: [], undoExpectedFiles: [] };
  }

  function mapRecoveredEvent(raw, journal, options) {
    const activity = options.mapActivity(raw);
    if (!activity?.visible || activity.kind === 'technical') return null;
    return { kind: activity.kind || 'activity', title: options.sanitizeText(activity.title) || 'Event',
      status: activity.status || 'running', detail: options.sanitizeValue(activity.detail),
      timestamp: raw.timestamp || journal.updatedAt || new Date().toISOString(),
      streamKey: options.sanitizeText(activity.streamKey), streamRole: options.sanitizeText(activity.streamRole),
      appendText: options.sanitizeText(activity.appendText), replaceText: activity.replaceText };
  }

  return { create, createInterruptedRun, mapRecoveredEvent, getStartupRequestId };
});
