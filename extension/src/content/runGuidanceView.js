(function initCodexOverleafRunGuidanceView() {
  'use strict';

  const LEGACY_GUIDANCE_TITLES = new Set([
    'Follow-up guidance was delivered to the active Codex turn.',
    '\u540e\u7eed\u5f15\u5bfc\u5df2\u53d1\u9001\u5230\u5f53\u524d Codex turn\u3002'
  ]);

  const GUIDANCE_DELIVERY_PREFIX = /^(?:Guidance delivered|Follow-up guidance delivered|引导已发送|后续引导已发送)\s*[:：]\s*/i;

  function normalizeGuidanceText(value) {
    return String(value || '').trim().replace(GUIDANCE_DELIVERY_PREFIX, '').trim();
  }

  function getGuidanceText(event = {}) {
    const detailText = typeof event.detail === 'string' ? event.detail.trim() : '';
    if (event.kind === 'guidance') {
      return normalizeGuidanceText(detailText || event.title);
    }
    return detailText && LEGACY_GUIDANCE_TITLES.has(String(event.title || ''))
      ? normalizeGuidanceText(detailText)
      : '';
  }

  function renderGuidanceMessage(event, guidanceText, tx) {
    const row = document.createElement('div');
    row.className = 'run-guidance-message run-user-message';
    row.dataset.kind = 'guidance';
    row.setAttribute('role', 'group');
    const text = document.createElement('div');
    text.className = 'run-guidance-text';
    const label = document.createElement('div');
    label.className = 'run-guidance-label';
    row.append(text, label);
    updateGuidanceMessage(row, event, guidanceText, tx);
    return row;
  }

  function updateGuidanceMessage(row, event, guidanceText, tx, { active = true } = {}) {
    row.dataset.status = event.status || 'completed';
    if (event.guidanceId) row.dataset.guidanceId = event.guidanceId;
    row.dataset.guidanceTimestamp = event.timestamp || '';
    const label = tx('Follow-up guidance', '补充指令');
    const sending = (active || event.guidancePending === true) && ['queued', 'steering'].includes(event.status);
    const text = row.querySelector('.run-guidance-text');
    if (text.textContent !== guidanceText) text.textContent = guidanceText;
    const status = row.querySelector('.run-guidance-label');
    const statusText = label + (sending ? tx(' · Sending…', ' · 发送中…') : '');
    if (status.textContent !== statusText) status.textContent = statusText;
    row.setAttribute('aria-label', statusText);
  }

  // Stored events and the controller's in-flight projection share a container.
  // Confirmation updates the same row; removed previews leave no stale bubble.
  function reconcileGuidance(container, events, tx, options = {}) {
    if (!container) return;
    const completedLegacy = new Set(events.filter(event => !event.guidanceId && event.status === 'completed')
      .map(getGuidanceText).filter(Boolean));
    const entries = new Map();
    for (const [index, event] of events.entries()) {
      const text = getGuidanceText(event);
      if (!text || (!event.guidanceId && event.status === 'queued' && completedLegacy.has(text))) continue;
      const key = event.guidanceId ? 'id:' + event.guidanceId : 'legacy:' + index;
      const previous = entries.get(key);
      if (previous && event.guidancePending === true && previous.event.guidancePending !== true) continue;
      entries.set(key, { key, event: previous ? { ...event, timestamp: previous.event.timestamp || event.timestamp } : event, text });
    }
    const existing = new Map();
    for (const row of [...container.children]) {
      const key = row.dataset.guidanceId ? 'id:' + row.dataset.guidanceId : row.dataset.guidanceKey;
      if (!key || existing.has(key)) { row.remove(); continue; }
      existing.set(key, row);
    }
    for (const [key, row] of existing) if (!entries.has(key)) row.remove();
    const known = [...entries.values()].filter(entry => Number.isFinite(Date.parse(entry.event.timestamp)))
      .sort((a, b) => Date.parse(a.event.timestamp) - Date.parse(b.event.timestamp));
    let datedIndex = 0;
    // Keep legacy rows without timestamps in their event-order slots.
    const ordered = [...entries.values()].map(entry => Number.isFinite(Date.parse(entry.event.timestamp)) ? known[datedIndex++] : entry);
    let cursor = container.firstChild;
    for (const entry of ordered) {
      const row = existing.get(entry.key) || renderGuidanceMessage(entry.event, entry.text, tx);
      row.dataset.guidanceKey = entry.key;
      if (entry.event.guidancePending === true) row.dataset.guidancePending = 'true';
      else delete row.dataset.guidancePending;
      updateGuidanceMessage(row, entry.event, entry.text, tx, options);
      if (row !== cursor) container.insertBefore(row, cursor);
      cursor = row.nextSibling;
    }
  }

  window.CodexOverleafRunGuidanceView = {
    getGuidanceText,
    renderGuidanceMessage,
    reconcileGuidance
  };
})();
