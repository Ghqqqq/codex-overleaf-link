(function installUpdateSafetyReceiver(root) {
  'use strict';
  if (root.__codexOverleafUpdateSafetyReceiverInstalled) return;
  let binding, idle, inFlight = false;
  const blocked = () => ({ idle: false, saved: false, blockers: ['tab_probe_unavailable'] });
  function install(next, dependencies) {
    if (!next?.transactionId || !next.token || next.url !== location.href) return { ok: false };
    if (binding) {
      if (binding.transactionId !== next.transactionId || binding.targetVersion !== next.targetVersion
        || binding.documentId !== next.documentId || binding.url !== next.url || inFlight) return { ok: false };
      binding = Object.freeze({ ...next });
      return { ok: true, url: location.href };
    }
    binding = Object.freeze({ ...next });
    const pageWrites = new Set();
    const visible = node => !node.hidden && node.getAttribute('aria-hidden') !== 'true' && node.getClientRects().length > 0;
    const { UpdateIdle, PageRpcContract } = dependencies;
    idle = UpdateIdle.create({ document, includePanelActivity: true,
      getBusyState: () => ({ reviewAction: pageWrites.size > 0
          || [...document.querySelectorAll('#codex-overleaf-panel [data-run-accept-confirm], #codex-overleaf-panel button:disabled')]
            .some(node => visible(node) && (node.hasAttribute('data-run-accept-confirm') || /Accepting|接受中/.test(node.textContent)
              || (node.hasAttribute('data-run-undo') && !/Undone|已撤销/.test(node.textContent)
                && !/Accepted|已接受/.test(node.closest('[data-run-id]')?.querySelector('[data-run-accept]')?.textContent || '')))),
        run: document.querySelector('#codex-overleaf-panel')?.dataset.running === 'true',
        cancelling: document.querySelector('#codex-overleaf-panel')?.dataset.cancelling === 'true',
        dialog: [...document.querySelectorAll('[role="dialog"], dialog[open]')].some(visible) }),
      checkSaved: async () => {
        const response = await chrome.runtime.sendMessage({ type: 'codex-overleaf/migration-save-probe', ...binding,
          nonce: activeNonce });
        return response?.ok && response.nonce === activeNonce ? response.result : { ok: false, state: 'unavailable' };
      } });
    root.addEventListener('message', event => {
      if (event.source !== root || event.origin !== location.origin || typeof event.data?.id !== 'string') return;
      const data = event.data;
      const mutation = PageRpcContract.getMethod(data.method)?.mutation;
      if (data.source === 'codex-overleaf/content' && ['document', 'page_state', 'navigation'].includes(mutation)) {
        pageWrites.add(data.id); idle.noteActivity();
      } else if (data.source === 'codex-overleaf/page' && pageWrites.delete(data.id)) idle.noteActivity();
    });
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (message?.type !== 'codex-overleaf/migration-idle-probe') return undefined;
      if (sender?.id !== chrome.runtime.id || sender.tab || message.token !== binding.token
        || message.transactionId !== binding.transactionId || typeof message.nonce !== 'string'
        || !message.nonce || location.href !== binding.url || inFlight) { respond(blocked()); return false; }
      inFlight = true;
      activeNonce = message.nonce;
      idle.buildIdleProbe().then(result => respond(location.href === binding.url ? {
        ...result, transactionId: binding.transactionId, token: binding.token, nonce: message.nonce,
        url: location.href, targetVersion: binding.targetVersion, safetyOnly: true
      } : blocked())).catch(() => respond(blocked())).finally(() => { inFlight = false; activeNonce = ''; });
      return true;
    });
    return { ok: true, url: location.href };
  }
  let activeNonce = '';
  root.CodexOverleafUpdateSafetyReceiver = Object.freeze({ install });
  root.__codexOverleafUpdateSafetyReceiverInstalled = true;
})(globalThis);
