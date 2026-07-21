(function initCodexOverleafRunGuidanceView() {
  'use strict';

  const LEGACY_GUIDANCE_TITLES = new Set([
    'Follow-up guidance was delivered to the active Codex turn.',
    '\u540e\u7eed\u5f15\u5bfc\u5df2\u53d1\u9001\u5230\u5f53\u524d Codex turn\u3002'
  ]);

  function getGuidanceText(event = {}) {
    const detailText = typeof event.detail === 'string' ? event.detail.trim() : '';
    if (event.kind === 'guidance') {
      return detailText || String(event.title || '').trim();
    }
    return detailText && LEGACY_GUIDANCE_TITLES.has(String(event.title || ''))
      ? detailText
      : '';
  }

  function renderGuidanceMessage(event, guidanceText, tx) {
    const row = document.createElement('div');
    row.className = 'run-guidance-message run-user-message';
    row.dataset.kind = 'guidance';
    row.dataset.status = event.status || 'completed';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', tx('Follow-up guidance', '\u540e\u7eed\u5f15\u5bfc'));

    const marker = document.createElement('span');
    marker.className = 'run-guidance-marker';
    marker.setAttribute('aria-hidden', 'true');
    marker.textContent = '\u21b3';

    const text = document.createElement('div');
    text.className = 'run-guidance-text';
    text.textContent = guidanceText;

    row.append(marker, text);
    return row;
  }

  window.CodexOverleafRunGuidanceView = {
    getGuidanceText,
    renderGuidanceMessage
  };
})();
