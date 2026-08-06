(function initCodexOverleafPageBridgeClient(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafPageBridgeClient = api;
})(typeof window !== 'undefined' ? window : globalThis, function pageBridgeClientFactory() {
  'use strict';

  const PAGE_WORLD_SCRIPTS = Object.freeze([
    ['src/shared/reviewing.js', 'codex-overleaf-reviewing-script'],
    ['src/shared/projectFiles.js', 'codex-overleaf-project-files-script'],
    ['src/shared/compatibility.js', 'codex-overleaf-compatibility-page-script'],
    ['src/shared/pageRpcContract.js', 'codex-overleaf-page-rpc-contract-script'],
    ['src/shared/staleGuard.js', 'codex-overleaf-stale-guard-script'],
    ['src/shared/compileAdapter.js', 'codex-overleaf-compile-adapter-script'],
    ['src/shared/sensitiveScan.js', 'codex-overleaf-sensitive-scan-script'],
    ['src/shared/auditRecords.js', 'codex-overleaf-audit-records-script'],
    ['src/page/saveState.js', 'codex-overleaf-save-state-script', true],
    ['src/page/overleafCapabilities.js', 'codex-overleaf-capabilities-script'],
    ['src/page/compileBridge.js', 'codex-overleaf-compile-bridge-script'],
    ['src/page/overleafEditor.js', 'codex-overleaf-editor-script'],
    ['src/page/overleafProjectSnapshot.js', 'codex-overleaf-project-snapshot-script'],
    ['src/page/pageBridgeCapability.js', 'codex-overleaf-page-bridge-capability-script'],
    ['src/page/treeOperations.js', 'codex-overleaf-tree-operations-script', true],
    ['src/page/binaryAssetUploader.js', 'codex-overleaf-binary-asset-uploader-script', true],
    ['src/page/snapshotRouter.js', 'codex-overleaf-snapshot-router-script'],
    ['src/page/writeGuard.js', 'codex-overleaf-write-guard-script', true],
    ['src/page/trackedChangesLifecycle.js', 'codex-overleaf-tracked-changes-lifecycle-script', true],
    ['src/page/writebackRouter.js', 'codex-overleaf-writeback-router-script', true],
    ['src/pageBridge.js', 'codex-overleaf-page-bridge-script', true]
  ]);
  const OPTIONAL_OT_SCRIPTS = Object.freeze([
    ['src/shared/otText.js', 'codex-overleaf-ot-text-script'],
    ['src/page/overleafRealtimeObserver.js', 'codex-overleaf-realtime-observer-script']
  ]);

  function create(options = {}) {
    const windowRef = options.window || globalThis.window;
    const documentRef = options.document || windowRef?.document;
    const chromeApi = options.chromeApi || globalThis.chrome;
    const cryptoImpl = options.crypto || globalThis.crypto;
    const runtimeRoot = options.root || windowRef;
    const Contract = options.contract;
    const Compatibility = options.compatibility;
    const timeoutOverrides = { ...(options.timeoutOverrides || {}) };
    const revision = Contract.REVISION;
    const capability = createCapability(cryptoImpl);
    const activeCancellationHandlers = new Map();
    let readyPromise = null;

    function start() {
      if (!readyPromise) readyPromise = injectPageBridge();
      return readyPromise;
    }

    async function call(method, params) {
      try {
        await start();
      } catch (error) {
        return { ok: false, error: `Page bridge unavailable: ${error.message}` };
      }
      return send(method, params, Contract.resolveDispatchPolicy(method, timeoutOverrides));
    }

    function send(method, params, policy = {}) {
      const id = cryptoImpl.randomUUID();
      return new Promise((resolve, reject) => {
        const timeoutMs = Number.isFinite(Number(policy.timeoutMs))
          ? Number(policy.timeoutMs)
          : Contract.resolveTimeoutMs(method, timeoutOverrides);
        const cancellable = policy.cancellation === 'content_abort';
        let settled = false;
        let timeout = null;
        function cleanup() {
          if (timeout !== null) windowRef.clearTimeout(timeout);
          windowRef.removeEventListener('message', onMessage);
          if (cancellable) activeCancellationHandlers.delete(id);
        }
        function resolveOnce(value) {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        }
        function rejectOnce(error) {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        }
        function cancelRequest() {
          const error = new Error('Codex run was cancelled by the user');
          error.code = 'codex_cancelled';
          error.cancelled = true;
          rejectOnce(error);
        }
        timeout = windowRef.setTimeout(() => {
          resolveOnce({ ok: false, error: 'Page bridge timed out' });
        }, timeoutMs);
        function onMessage(event) {
          if (event.source !== windowRef
            || event.origin !== windowRef.location.origin
            || event.data?.source !== 'codex-overleaf/page'
            || event.data?.pageBridgeVersion !== Compatibility?.BUILD_TARGET_VERSION
            || event.data?.pageBridgeRevision !== revision
            || event.data.id !== id) {
            return;
          }
          resolveOnce(event.data.result);
        }
        if (cancellable) {
          activeCancellationHandlers.set(id, cancelRequest);
          if (options.isCancellationRequested?.()) windowRef.queueMicrotask(cancelRequest);
        }
        windowRef.addEventListener('message', onMessage);
        // Every low-level request remains one attempt. Higher layers must opt
        // into replay so a document mutation is never duplicated implicitly.
        windowRef.postMessage({
          source: 'codex-overleaf/content',
          id,
          method,
          params,
          capability
        }, windowRef.location.origin);
      });
    }

    function cancelActiveRequests() {
      const handlers = Array.from(activeCancellationHandlers.values());
      activeCancellationHandlers.clear();
      handlers.forEach(cancel => cancel());
    }

    function resolveTimeoutMs(method) {
      return Contract.resolveTimeoutMs(method, timeoutOverrides);
    }

    async function injectPageBridge() {
      const splitAt = PAGE_WORLD_SCRIPTS.findIndex(([src]) =>
        src === 'src/page/pageBridgeCapability.js'
      );
      for (const [src, id, force] of PAGE_WORLD_SCRIPTS.slice(0, splitAt)) {
        await injectScriptOnce(src, id, { force });
      }
      await injectOptionalOtDependencies();
      for (const [src, id, force] of PAGE_WORLD_SCRIPTS.slice(splitAt)) {
        await injectScriptOnce(src, id, { force });
      }
      await initializeCapability();
    }

    async function injectOptionalOtDependencies() {
      try {
        for (const [src, id] of OPTIONAL_OT_SCRIPTS) await injectScriptOnce(src, id);
      } catch (_error) {
        // The page bridge keeps its read-only unavailable fallback.
      }
    }

    function injectScriptOnce(src, id, injectOptions = {}) {
      return new Promise((resolve, reject) => {
        const existing = documentRef.getElementById(id);
        if (existing && injectOptions.force !== true) {
          resolve();
          return;
        }
        existing?.remove?.();
        const script = documentRef.createElement('script');
        const timeout = windowRef.setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out loading ${src}`));
        }, 8000);
        function cleanup() {
          windowRef.clearTimeout(timeout);
          script.onload = null;
          script.onerror = null;
          script.remove();
        }
        script.id = id;
        const runtimePrefix = String(runtimeRoot.__CODEX_OVERLEAF_RUNTIME_PREFIX__ || '');
        script.src = chromeApi.runtime.getURL(runtimePrefix + src);
        script.onload = () => {
          cleanup();
          resolve();
        };
        script.onerror = () => {
          cleanup();
          reject(new Error(`Failed to load ${src}`));
        };
        (documentRef.head || documentRef.documentElement).append(script);
      });
    }

    async function initializeCapability() {
      const result = await send(
        'initializeCapability',
        {},
        Contract.resolveDispatchPolicy('initializeCapability', timeoutOverrides)
      );
      if (!result?.ok) {
        throw new Error(result?.error || result?.reason || 'Page bridge capability initialization failed');
      }
    }

    return Object.freeze({
      call,
      cancelActiveRequests,
      resolveTimeoutMs,
      send,
      start
    });
  }

  function createCapability(cryptoImpl) {
    if (cryptoImpl?.randomUUID) return cryptoImpl.randomUUID();
    const bytes = new Uint8Array(24);
    cryptoImpl.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  return Object.freeze({
    OPTIONAL_OT_SCRIPTS,
    PAGE_WORLD_SCRIPTS,
    create
  });
});
