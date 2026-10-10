(function initCodexOverleafRunGuidanceController() {
  'use strict';

  function create(deps = {}) {
    // Unacknowledged input is a page-local projection. Only confirmed delivery
    // joins record.events; the durable queue owns refresh/recovery before that.
    const pending = new Map();
    let lastTimestamp = 0;
    const keyOf = target => JSON.stringify([target.sessionId, target.recordId, target.guidanceId]);
    const sameScope = scope => !scope || ['accountScopeId', 'projectId', 'generation'].every(key => scope[key] === deps.getScope?.()?.[key]);
    function ownedRecord(target) {
      if (!target.sessionId || !target.recordId) return null;
      if (target.sessionCreatedAt !== undefined && deps.getSessionCreatedAt
        && deps.getSessionCreatedAt(target.sessionId) !== target.sessionCreatedAt) return null;
      return deps.findRunRecord?.(target.recordId, target.sessionId) || null;
    }
    function nextTimestamp() {
      lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
      return new Date(lastTimestamp).toISOString();
    }
    function getPending(run) {
      return [...pending.values()].filter(token => token.target.recordId === run?.id
        && (!deps.getActiveSessionId || token.target.sessionId === deps.getActiveSessionId())
        && sameScope(token.scope) && ownedRecord(token.target)).map(token => token.event);
    }
    function refresh(target) {
      const record = ownedRecord(target);
      if (!record) return null;
      const view = deps.getCurrentRunView?.();
      const root = deps.getRunRoot?.(target) || (view?.recordId === target.recordId
        && view?.sessionId === target.sessionId ? view.root : null);
      const container = root?.querySelector('[data-run-guidance]');
      deps.RunGuidanceView?.reconcileGuidance(container,
        (record.events || []).concat(getPending(record)), deps.tx, { active: record.status === 'running' });
      return container;
    }
    function refreshSettled(target) {
      try { refresh(target); } catch (error) { deps.onPresentationError?.(error); }
    }
    function preview(text, target = {}) {
      const title = String(text || '').trim();
      if (!title || !target.guidanceId || !ownedRecord(target)) return null;
      const token = { target: { ...target }, scope: deps.getScope?.(), event: { title, status: 'steering', kind: 'guidance',
        guidanceId: target.guidanceId, timestamp: nextTimestamp(), guidancePending: true } };
      pending.set(keyOf(target), token);
      try {
        const container = refresh(target);
        const row = container?.querySelector?.(`[data-guidance-id="${deps.cssEscape?.(target.guidanceId) || target.guidanceId}"]`);
        if (row) deps.revealGuidance?.(row);
        deps.bumpUnreadIfDetached?.();
      } catch (error) {
        if (pending.get(keyOf(target)) === token) pending.delete(keyOf(target));
        try { refresh(target); } catch { /* preserve the original presentation error */ }
        throw error;
      }
      return token;
    }
    function clearPreview(token) {
      if (!token || pending.get(keyOf(token.target)) !== token) return;
      pending.delete(keyOf(token.target));
      if (sameScope(token.scope)) refreshSettled(token.target);
    }
    function upsert(text, target = {}) {
      const record = ownedRecord(target);
      const guidanceId = String(target.guidanceId || '').trim();
      if (!record || !guidanceId) return null;
      const existing = (record.events || []).find(entry => entry.kind === 'guidance' && entry.guidanceId === guidanceId);
      const event = { title: String(text || '').trim(), status: target.status || 'completed', kind: 'guidance', guidanceId,
        timestamp: existing?.timestamp || target.timestamp || pending.get(keyOf(target))?.event.timestamp || nextTimestamp() };
      if (existing) Object.assign(existing, event);
      else record.events = [...(record.events || []), event].slice(-(deps.maxRunEvents || 300));
      // A late ACK still belongs to the captured run, even if another run is
      // now active. The coordinator saves it together with queue removal.
      deps.onRecordChanged?.(target);
      refreshSettled(target);
      return existing || event;
    }
    function remove(guidanceId, target = {}) {
      const record = ownedRecord(target);
      if (!record || !guidanceId) return false;
      const before = (record.events || []).length;
      record.events = (record.events || []).filter(event => event.guidanceId !== guidanceId);
      refreshSettled(target);
      return record.events.length !== before;
    }

    function settleView(view) {
      const guidance = view?.guidance || view?.root?.querySelector('[data-run-guidance]');
      if (!guidance || !view?.events) return;
      view.guidance = guidance;
      for (const row of view.events.querySelectorAll('[data-kind="guidance"]')) guidance.append(row);
    }

    function appendToView(event, view) {
      const text = deps.RunGuidanceView?.getGuidanceText(event);
      if (!text) return false;
      const root = view.root || view.events?.closest('[data-run-id]');
      const guidance = view.guidance || root?.querySelector('[data-run-guidance]');
      const target = guidance || view.events;
      if (!target) return false;
      view.guidance = guidance;
      const rendered = deps.renderRunEvent(event);
      const existing = event.guidanceId
        ? root?.querySelector(`[data-guidance-id="${deps.cssEscape(event.guidanceId)}"]`)
        : null;
      if (existing) existing.replaceWith(rendered);
      else target.append(rendered);
      deps.bumpUnreadIfDetached?.();
      return true;
    }

    return { preview, clearPreview, getPending, upsert, remove, settleView, appendToView };
  }

  window.CodexOverleafRunGuidanceController = { create };
})();
