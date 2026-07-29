(function initCodexOverleafRunGuidanceController() {
  'use strict';

  function create(deps = {}) {
    function upsert(text, target = {}) {
      const record = deps.findRunRecord?.(target.recordId, target.sessionId);
      const guidanceId = String(target.guidanceId || '').trim();
      if (!record || !guidanceId) return null;
      const event = {
        title: String(text || '').trim(),
        status: target.status || 'queued',
        kind: 'guidance',
        guidanceId,
        timestamp: new Date().toISOString()
      };
      const existing = (record.events || []).find(entry => entry.guidanceId === guidanceId);
      if (!existing) {
        deps.appendRunEvent?.(event, record);
        return event;
      }
      Object.assign(existing, event, { timestamp: existing.timestamp || event.timestamp });
      const view = deps.getCurrentRunView?.();
      if (view?.recordId === target.recordId) {
        view.root?.querySelector(`[data-guidance-id="${deps.cssEscape(guidanceId)}"]`)
          ?.replaceWith(deps.renderRunEvent(existing));
      }
      return existing;
    }

    function remove(guidanceId, target = {}) {
      const record = deps.findRunRecord?.(target.recordId, target.sessionId);
      if (!record || !guidanceId) return false;
      const before = (record.events || []).length;
      record.events = (record.events || []).filter(event => event.guidanceId !== guidanceId);
      const view = deps.getCurrentRunView?.();
      if (view?.recordId === target.recordId) {
        view.root?.querySelector(`[data-guidance-id="${deps.cssEscape(guidanceId)}"]`)?.remove();
      }
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
      const guidance = view.guidance || view.root?.querySelector('[data-run-guidance]');
      const target = view.terminalStatus ? guidance : view.events;
      if (!target) return false;
      view.guidance = guidance;
      const rendered = deps.renderRunEvent(event);
      const existing = event.guidanceId
        ? view.root?.querySelector(`[data-guidance-id="${deps.cssEscape(event.guidanceId)}"]`)
        : null;
      if (existing) existing.replaceWith(rendered);
      else target.append(rendered);
      deps.bumpUnreadIfDetached?.();
      return true;
    }

    return { upsert, remove, settleView, appendToView };
  }

  window.CodexOverleafRunGuidanceController = { create };
})();
