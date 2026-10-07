(function localizePopupFallback() {
  'use strict';

  const preferenceKeys = ['codexOverleafGlobalPrefsV1', 'codexOverleafPrefs'];
  let revision = 0;
  let recoveryReloaded = false;

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

  // This independent extension page can still start when the worker/runtime
  // cannot. Native decides whether a persisted migration needs recovery; the
  // popup never guesses a transaction or sends an unbound rollback request.
  document.addEventListener?.('DOMContentLoaded', () => {
    setTimeout(() => {
      if (!document.querySelector('[data-bootstrap-shell]') || !chrome.runtime?.sendNativeMessage) return;
      chrome.runtime.sendNativeMessage('com.codex.overleaf', {
        id: crypto.randomUUID(), method: 'update.status', params: { bootstrapRecovery: true }
      }, response => {
        if (chrome.runtime.lastError || recoveryReloaded || !document.querySelector('[data-bootstrap-shell]')) return;
        const status = response?.ok ? response.result : null;
        const transaction = status?.transaction;
        const pair = status?.restoredPair;
        if (!transaction?.id || transaction.state !== 'rolled_back' || !transaction.sourceVersion
          || status.activeVersion !== transaction.sourceVersion || status.installedAligned !== true
          || pair?.extensionVersion !== transaction.sourceVersion || pair?.nativeVersion !== transaction.sourceVersion
          || !['extensionSha256', 'nativeSha256', 'bootstrapSha256'].every(key => /^[0-9a-f]{64}$/.test(pair[key] || ''))) return;
        recoveryReloaded = true;
        chrome.runtime.reload();
      });
    }, 250);
  }, { once: true });
})();
