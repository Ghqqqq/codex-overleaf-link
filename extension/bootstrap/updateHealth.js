(function initCodexOverleafUpdateHealth(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafUpdateHealth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function updateHealthFactory() {
  'use strict';

  function pruneClosedTabIds(pendingTabIds, openTabs) {
    if (!(pendingTabIds instanceof Set)) return pendingTabIds;
    const openIds = new Set(
      (Array.isArray(openTabs) ? openTabs : [])
        .map(tab => tab && tab.id)
        .filter(Number.isInteger)
    );
    for (const tabId of pendingTabIds) {
      if (!openIds.has(tabId)) pendingTabIds.delete(tabId);
    }
    return pendingTabIds;
  }

  return Object.freeze({ pruneClosedTabIds });
});
