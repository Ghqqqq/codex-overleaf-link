(function localizePopupFallback() {
  'use strict';

  const preferenceKeys = ['codexOverleafGlobalPrefsV1', 'codexOverleafPrefs'];
  let revision = 0;

  async function refreshFallback() {
    const requestRevision = ++revision;
    let preferences = {};
    try {
      const stored = await chrome.storage.local.get(preferenceKeys);
      preferences = stored.codexOverleafGlobalPrefsV1?.values || stored.codexOverleafPrefs || {};
    } catch (_) { /* A missing language preference uses the product default. */ }
    if (requestRevision !== revision) return;
    const shell = document.querySelector('[data-bootstrap-shell]');
    const message = shell?.querySelector('p');
    // The healthy runtime replaces this shell. Late preference reads must
    // never change the runtime's content or its current language.
    if (!message) return;
    const chinese = preferences.locale === 'zh';
    document.documentElement.lang = chinese ? 'zh-CN' : 'en';
    message.textContent = chinese
      ? 'Codex Overleaf Link 无法加载运行组件。请重新运行安装程序，再重新加载扩展。'
      : 'Codex Overleaf Link could not load its runtime. Rerun the installer, then reload the extension.';
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && preferenceKeys.some(key => changes[key])) refreshFallback();
  });
  refreshFallback();
})();
