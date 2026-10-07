(function installBackgroundUpdateSafety(root) {
  'use strict';
  const blocked = () => ({ idle: false, saved: false, blockers: ['tab_probe_unavailable'] });
  function create(options) {
    const bindings = new Map();
    const tabsKey = 'codex-overleaf-managed-update-tabs-v1';
    const guardKey = 'codex-overleaf-managed-update-guarded-tabs-v1';
    async function ownerMatches(binding) {
      if (!options.isExecutionLocked()) return false;
      const response = await options.request({ id: crypto.randomUUID(), method: 'update.status',
        params: { bootstrapRevision: String(root.__CODEX_OVERLEAF_BOOTSTRAP_REVISION__ || '') } });
      const tx = response?.ok && response.result?.transaction;
      return tx?.id === binding.transactionId && tx.targetVersion === binding.targetVersion
        && tx.sourceVersion === binding.sourceVersion && tx.state === binding.expectedState;
    }
    async function snapshot(tabId, documentId) {
      const results = await chrome.scripting.executeScript({ target: documentId ? { tabId, documentIds: [documentId] }
        : { tabId, frameIds: [0] }, world: 'ISOLATED', func: () => ({ url: location.href }) });
      const item = results?.length === 1 && results[0];
      return item?.frameId === 0 && item.documentId && typeof item.result?.url === 'string'
        ? { documentId: item.documentId, url: item.result.url } : null;
    }
    async function saveProbe(message, sender) {
      const binding = bindings.get(sender?.tab?.id);
      if (!binding || sender.id !== chrome.runtime.id || sender.frameId !== 0 || sender.documentId !== binding.documentId
        || sender.url !== binding.url || message.token !== binding.token || message.transactionId !== binding.transactionId
        || message.nonce !== binding.nonce || !await ownerMatches(binding)) return { ok: false };
      const before = await snapshot(binding.tabId, binding.documentId);
      if (before?.url !== binding.url) return { ok: false };
      const results = await chrome.scripting.executeScript({ target: { tabId: binding.tabId, documentIds: [binding.documentId] },
        world: 'MAIN', func: url => globalThis.CodexOverleafUpdateSafetyProbe?.probe(url), args: [binding.url] });
      const after = await snapshot(binding.tabId, binding.documentId);
      if (after?.url !== binding.url || message.nonce !== binding.nonce || !await ownerMatches(binding)
        || results?.length !== 1 || results[0].documentId !== binding.documentId || results[0].frameId !== 0) return { ok: false };
      return { ok: true, nonce: message.nonce, result: results[0].result };
    }
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (message?.type !== 'codex-overleaf/migration-save-probe') return undefined;
      saveProbe(message, sender).then(respond).catch(() => respond({ ok: false }));
      return true;
    });
    async function probe(tab, owner) {
      try {
        const current = await snapshot(tab.id);
        if (!current || current.url !== tab.url) return blocked();
        let binding = bindings.get(tab.id);
        if (binding && (binding.documentId !== current.documentId || binding.url !== current.url
          || binding.transactionId !== owner.transactionId)) return blocked();
        if (!binding) {
          binding = { ...owner, ...current, tabId: tab.id, token: crypto.randomUUID(), nonce: '' };
          if (!await ownerMatches(binding)) return blocked();
          bindings.set(tab.id, binding);
        }
        binding.expectedState = owner.expectedState;
        if (!binding.installed) {
          const target = { tabId: tab.id, documentIds: [binding.documentId] };
          await chrome.scripting.executeScript({ target, world: 'MAIN',
            files: ['runtime/src/page/saveState.js', 'runtime/src/page/updateSafetyProbe.js'] });
          await chrome.scripting.executeScript({ target, world: 'ISOLATED',
            files: ['runtime/src/shared/pageRpcContract.js', 'runtime/src/content/updateIdle.js', 'runtime/src/content/updateSafetyReceiver.js'] });
          const installed = await chrome.scripting.executeScript({ target, world: 'ISOLATED',
            func: value => globalThis.CodexOverleafUpdateSafetyReceiver?.install(value, {
              UpdateIdle: globalThis.CodexOverleafUpdateIdle, PageRpcContract: globalThis.CodexOverleafPageRpcContract
            }), args: [binding] });
          if (installed?.length !== 1 || installed[0].documentId !== binding.documentId
            || installed[0].result?.ok !== true || installed[0].result.url !== binding.url) return blocked();
          binding.installed = true;
        }
        if (!await ownerMatches(binding)) return blocked();
        binding.nonce = crypto.randomUUID();
        const nonce = binding.nonce;
        let timer;
        const response = await Promise.race([
          chrome.tabs.sendMessage(tab.id, { type: 'codex-overleaf/migration-idle-probe', ...binding },
            { documentId: binding.documentId }),
          new Promise(resolve => { timer = setTimeout(() => resolve(null), 3500); })
        ]).finally(() => clearTimeout(timer));
        const after = await snapshot(tab.id, binding.documentId);
        if (!response?.safetyOnly || response.token !== binding.token || response.transactionId !== binding.transactionId
          || response.targetVersion !== binding.targetVersion || response.nonce !== nonce || response.url !== binding.url
          || after?.url !== binding.url || !await ownerMatches(binding)) return blocked();
        return response;
      } catch (_) { return blocked(); }
    }
    async function protectReloadTabs(transaction) {
      const owner = { transactionId: transaction.id, sourceVersion: transaction.sourceVersion,
        targetVersion: transaction.targetVersion, expectedState: 'bootstrap_pending' };
      if (!await ownerMatches(owner)) return false;
      const stored = await chrome.storage.local.get([tabsKey, guardKey]);
      if (stored[guardKey]?.transactionId === transaction.id && !stored[tabsKey]?.length) return true;
      if (stored[guardKey]?.state === 'guarded' && stored[guardKey].transactionId !== transaction.id) {
        const open = new Set((await chrome.tabs.query({})).map(tab => tab.id));
        for (const entry of stored[guardKey].entries || []) {
          if (!open.has(entry.tabId)) continue;
          const current = await snapshot(entry.tabId).catch(() => null);
          if (!entry.documentId || !current || current.documentId === entry.documentId) return false;
        }
      }
      const entries = await Promise.all((stored[tabsKey] || []).map(async tabId => ({ tabId,
        ...await snapshot(tabId).catch(() => null) })));
      const guard = { transactionId: transaction.id, sourceVersion: transaction.sourceVersion,
        targetVersion: transaction.targetVersion, state: 'guarded', entries };
      const current = await chrome.storage.local.get([tabsKey, guardKey]);
      if (JSON.stringify(current) !== JSON.stringify(stored) || !await ownerMatches(owner)) return false;
      await chrome.storage.local.set({ [guardKey]: guard, [tabsKey]: [] });
      const readback = await chrome.storage.local.get([tabsKey, guardKey]);
      return JSON.stringify(readback[guardKey]) === JSON.stringify(guard) && readback[tabsKey]?.length === 0;
    }
    async function releaseReloadTabs(transaction, expectedState = 'bootstrap_pending') {
      const owner = { transactionId: transaction.id, sourceVersion: transaction.sourceVersion,
        targetVersion: transaction.targetVersion, expectedState };
      if (!await ownerMatches(owner)) return false;
      const stored = await chrome.storage.local.get([tabsKey, guardKey]);
      const guard = stored[guardKey];
      if (guard?.transactionId !== transaction.id || guard.state !== 'guarded' || stored[tabsKey]?.length) return false;
      const open = new Set((await chrome.tabs.query({})).map(tab => tab.id));
      const ids = [];
      for (const entry of guard.entries) {
        if (!open.has(entry.tabId)) continue;
        if (!entry.documentId || !entry.url) return false;
        const current = await snapshot(entry.tabId, entry.documentId).catch(() => null);
        if (current?.documentId !== entry.documentId || current?.url !== entry.url) return false;
        ids.push(entry.tabId);
      }
      const again = await chrome.storage.local.get([tabsKey, guardKey]);
      if (JSON.stringify(again[guardKey]) !== JSON.stringify(guard) || again[tabsKey]?.length || !await ownerMatches(owner)) return false;
      await chrome.storage.local.set({ [tabsKey]: ids, [guardKey]: { ...guard, state: 'ready' } });
      return true;
    }
    async function revalidate(tabs, owner) {
      if (!await ownerMatches(owner)) return false;
      for (const tab of tabs) {
        const binding = bindings.get(tab.id);
        if (!binding || binding.transactionId !== owner.transactionId) continue;
        if ((await probe(tab, owner)).idle !== true) return false;
      }
      return ownerMatches(owner);
    }
    async function hasReplacedReloadDocument(transaction) {
      const owner = { transactionId: transaction.id, sourceVersion: transaction.sourceVersion,
        targetVersion: transaction.targetVersion, expectedState: 'rolled_back' };
      if (!await ownerMatches(owner)) return false;
      const stored = await chrome.storage.local.get([tabsKey, guardKey]);
      const guard = stored[guardKey];
      if (guard?.transactionId !== transaction.id || guard.state !== 'guarded' || stored[tabsKey]?.length) return false;
      const open = new Set((await chrome.tabs.query({})).map(tab => tab.id));
      for (const entry of guard.entries) {
        if (!open.has(entry.tabId) || !entry.documentId) continue;
        const current = await snapshot(entry.tabId).catch(() => null);
        if (current && current.documentId !== entry.documentId) {
          const again = await chrome.storage.local.get([tabsKey, guardKey]);
          return JSON.stringify(again) === JSON.stringify(stored) && await ownerMatches(owner);
        }
      }
      return false;
    }
    return Object.freeze({ probe, protectReloadTabs, releaseReloadTabs, revalidate, hasReplacedReloadDocument });
  }
  root.CodexOverleafBackgroundUpdateSafety = Object.freeze({ create });
})(globalThis);
