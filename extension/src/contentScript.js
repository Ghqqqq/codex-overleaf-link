(function initContentScript() {
  'use strict';

  if (!window.CodexOverleafContentRuntime || typeof window.CodexOverleafContentRuntime.init !== 'function') {
    throw new Error('Codex Overleaf content runtime did not load.');
  }
  const registry = window.CodexOverleafLegacyGlobalRegistry;
  if (!registry || typeof registry.create !== 'function') {
    throw new Error('Codex Overleaf dependency registry did not load.');
  }
  window.CodexOverleafContentRuntime.init(registry.create(window));
})();
