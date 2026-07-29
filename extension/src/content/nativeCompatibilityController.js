(function initCodexOverleafNativeCompatibilityController(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafNativeCompatibilityController = api;
})(typeof window !== 'undefined' ? window : globalThis, function nativeCompatibilityControllerFactory() {
  'use strict';

  function create(options = {}) {
    const Compatibility = options.compatibility;
    const nativeChannel = options.nativeChannel;
    const gatedMethods = options.gatedMethods || new Set();
    const tx = options.tx;
    const tr = options.tr;

    function sendNative(payload) {
      return dispatch(payload, 'sendNative');
    }

    function sendBackgroundNative(payload) {
      return dispatch(payload, 'sendBackgroundNative');
    }

    async function dispatch(payload, channelMethod) {
      const compatibilityGate = await ensureForMethod(payload?.method);
      if (!compatibilityGate.ok) return compatibilityGate.response;
      if (gatedMethods.has(payload?.method)) options.throwIfCancellationRequested?.();
      return nativeChannel[channelMethod](
        attachEvidence(payload, compatibilityGate.compatibility)
      );
    }

    async function ensureForMethod(method) {
      const metadata = options.getExtensionCompatibilityMetadata?.() || {};
      const params = Compatibility?.buildBridgePingParams
        ? Compatibility.buildBridgePingParams(metadata)
        : {};
      const response = await nativeChannel.sendBackgroundNative({
        method: 'bridge.ping',
        params
      });
      const compatibility = Compatibility?.evaluateNativeCompatibility
        ? Compatibility.evaluateNativeCompatibility(response, metadata)
        : options.fallbackNativeCompatibility(response);
      const allowed = !gatedMethods.has(method) ||
        (Compatibility?.isNativeMethodAllowed
          ? Compatibility.isNativeMethodAllowed(method, compatibility)
          : compatibility.status === 'ok');
      if (allowed) return { ok: true, compatibility };

      const message = formatBlockedMessage(method, compatibility);
      const installCommand = options.installCommand;
      const error = {
        code: 'native_update_required',
        message,
        status: compatibility.status || 'unknown_native',
        classification: options.getNativeCompatibilityClassification(compatibility),
        installCommand: compatibility.installCommand || installCommand,
        updateCommand: compatibility.updateCommand || compatibility.installCommand || installCommand,
        currentNativeVersion: compatibility.currentNativeVersion
          || compatibility.nativeVersion
          || compatibility.native?.version
          || '',
        requiredVersion: compatibility.requiredVersion || Compatibility?.BUILD_TARGET_VERSION || '',
        releaseUrl: compatibility.releaseUrl || ''
      };
      notifyBlocked(error, compatibility);
      return { ok: false, compatibility, response: { ok: false, error } };
    }

    function attachEvidence(payload = {}, compatibility) {
      if (!compatibility || !gatedMethods.has(payload?.method)) return payload;
      return {
        ...payload,
        params: {
          ...(payload.params || {}),
          nativeCompatibility: compatibility
        }
      };
    }

    function notifyBlocked(error, compatibility = {}) {
      const message = error?.message || String(error || '');
      if (options.getCurrentRunView?.()) {
        options.appendRunEvent?.({ title: message, status: 'failed' });
        showUpdateGuidance(compatibility);
        return;
      }
      showUpdateGuidance(compatibility);
      options.showPluginToast?.(message, { status: 'failed', sticky: true });
    }

    async function refreshBadge() {
      const renderer = options.getPanelRendererInstance?.();
      if (!renderer?.headerEl || !Compatibility?.evaluateNativeCompatibility) return;
      try {
        const metadata = options.getExtensionCompatibilityMetadata?.() || {};
        const params = Compatibility.buildBridgePingParams
          ? Compatibility.buildBridgePingParams(metadata)
          : {};
        const response = await sendBackgroundNative({ method: 'bridge.ping', params });
        const compatibility = Compatibility.evaluateNativeCompatibility(response, metadata);
        const classification = options.getNativeCompatibilityClassification(compatibility);
        if (classification === 'compatible') {
          options.setBadge?.(renderer.headerEl, { type: 'none' });
          options.setDiagnosticsHealth?.('ok');
          try {
            options.localStorage?.setItem('codexOverleafNativeEverOk', 'true');
          } catch (_storageError) {}
          return;
        }
        options.setDiagnosticsHealth?.(classification === 'update-available' ? 'warn' : 'fail');
        options.setBadge?.(renderer.headerEl, {
          type: 'update',
          tooltip: tx('Native host update available', 'Native host 可更新'),
          onClick: () => showUpdateGuidance(compatibility)
        });
        if (!compatibility?.native?.version) maybePromptFirstRunSetup();
      } catch (_error) {
        options.setDiagnosticsHealth?.('fail');
        options.setBadge?.(renderer.headerEl, {
          type: 'update',
          tooltip: tx(
            'Native host is not responding — click for setup steps',
            'Native host 未响应——点击查看安装步骤'
          ),
          onClick: () => showUpdateGuidance(options.fallbackNativeCompatibility({ ok: false }))
        });
        maybePromptFirstRunSetup();
      }
    }

    function maybePromptFirstRunSetup() {
      const storage = options.localStorage;
      try {
        if (!storage || storage.getItem('codexOverleafSetupPromptShown') === 'true') return;
        if (storage.getItem('codexOverleafNativeEverOk') === 'true') return;
        storage.setItem('codexOverleafSetupPromptShown', 'true');
      } catch (_storageError) {
        return;
      }
      showUpdateGuidance(options.fallbackNativeCompatibility({ ok: false }));
    }

    function showUpdateGuidance(compatibility = {}) {
      let panel = options.getPanel?.();
      if (!panel) {
        options.ensurePanelOpen?.();
        panel = options.getPanel?.();
      }
      if (!panel) return;
      panel.querySelector('[data-native-update-guidance]')?.remove();
      const native = compatibility.native || {};
      const extensionVersion = compatibility.extensionVersion || Compatibility?.BUILD_TARGET_VERSION || '';
      const nativeVersion = compatibility.currentNativeVersion
        || compatibility.nativeVersion
        || native.version
        || tx('missing', '未安装');
      const command = compatibility.updateCommand
        || compatibility.installCommand
        || options.installCommand;
      const releaseUrl = compatibility.releaseUrl || '';
      const overlay = options.document.createElement('div');
      overlay.className = 'codex-plugin-confirm';
      overlay.dataset.nativeUpdateGuidance = 'true';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      const nativeMissing = !native.version;
      overlay.setAttribute(
        'aria-label',
        nativeMissing
          ? tx('Set up the native host', '安装 Native host')
          : tx('Native host update available', 'Native host 可更新')
      );
      const card = options.document.createElement('section');
      card.className = 'codex-plugin-confirm-card';
      const title = options.document.createElement('div');
      title.className = 'codex-plugin-confirm-title';
      title.textContent = nativeMissing
        ? tx('One step left: install the native host', '还差一步：安装 Native host')
        : tx('Native host update available', 'Native host 可更新');
      const body = options.document.createElement('div');
      body.className = 'codex-plugin-confirm-body';
      body.textContent = [
        nativeMissing
          ? tx(
            `Extension v${extensionVersion} is ready; Codex still needs its local bridge to read and edit this project.`,
            `扩展 v${extensionVersion} 已就绪；Codex 还需要本地桥接程序才能读写这个项目。`
          )
          : tx(
            `Extension v${extensionVersion} / Native v${nativeVersion}`,
            `扩展 v${extensionVersion} / Native v${nativeVersion}`
          ),
        tx(
          'Run the platform-specific command below, reload the extension, then refresh Overleaf.',
          '运行下面的平台命令，重新加载扩展，然后刷新 Overleaf。'
        )
      ].join('\n\n');
      const commandCode = options.document.createElement('code');
      commandCode.textContent = command;
      Object.assign(commandCode.style, {
        display: 'block',
        whiteSpace: 'pre-wrap',
        marginTop: '0.75rem'
      });
      body.append(commandCode);
      if (releaseUrl) {
        const link = options.document.createElement('a');
        link.href = releaseUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = tx('Open GitHub Release', '打开 GitHub Release');
        Object.assign(link.style, { display: 'block', marginTop: '0.75rem' });
        body.append(link);
      }
      const actions = options.document.createElement('div');
      actions.className = 'codex-plugin-confirm-actions';
      const copy = options.document.createElement('button');
      copy.type = 'button';
      copy.className = 'codex-plugin-confirm-confirm';
      copy.textContent = tx('Copy command', '复制命令');
      copy.addEventListener('click', async () => {
        await options.navigator.clipboard.writeText(command);
        copy.textContent = tx('Copied', '已复制');
      });
      const close = options.document.createElement('button');
      close.type = 'button';
      close.className = 'codex-plugin-confirm-cancel';
      close.textContent = tx('Close', '关闭');
      close.addEventListener('click', () => overlay.remove());
      actions.append(close, copy);
      card.append(title, body, actions);
      overlay.append(card);
      overlay.addEventListener('click', event => {
        if (event.target === overlay) overlay.remove();
      });
      panel.append(overlay);
      copy.focus();
    }

    function scheduleFirstUseOnboardingTip() {
      options.setTimeout(() => {
        maybeShowFirstUseOnboardingTip().catch(() => {});
      }, 250);
    }

    async function maybeShowFirstUseOnboardingTip() {
      const panel = options.getPanel?.();
      if (!panel || (options.getState?.()?.sessions || []).length > 0) return;
      const key = options.onboardingTipStorageKey;
      const stored = await options.chromeApi.storage.local.get([key]);
      if (stored?.[key]) return;
      const modeSelect = panel.querySelector('[data-mode]');
      if (!modeSelect) return;
      const tip = options.document.createElement('div');
      tip.className = 'codex-onboarding-tip';
      tip.dataset.onboardingTip = 'true';
      tip.setAttribute('role', 'status');
      tip.textContent = tx(
        'Tip: Start with Ask mode to explore safely. Switch to Suggest to review edits before applying.',
        '提示：先用 Ask 模式安全探索；需要修改时切换到 Suggest，应用前可先审阅。'
      );
      Object.assign(tip.style, {
        position: 'absolute',
        zIndex: '2147483647',
        maxWidth: '280px'
      });
      panel.append(tip);
      const panelRect = panel.getBoundingClientRect();
      const modeRect = modeSelect.getBoundingClientRect();
      tip.style.left = `${Math.max(12, modeRect.left - panelRect.left)}px`;
      tip.style.bottom = `${Math.max(72, panelRect.bottom - modeRect.top + 8)}px`;
      const dismiss = () => {
        tip.remove();
        options.chromeApi.storage.local.set({ [key]: true }).catch?.(() => {});
        panel.removeEventListener('click', dismiss, true);
        panel.removeEventListener('keydown', dismiss, true);
      };
      panel.addEventListener('click', dismiss, true);
      panel.addEventListener('keydown', dismiss, true);
      options.setTimeout(dismiss, 8000);
    }

    function formatBlockedMessage(method, compatibility = {}) {
      const params = { method: method || 'native request' };
      switch (compatibility.status || 'unknown_native') {
        case 'native_too_old':
          return tr('nativeCompatibilityBlockedNativeTooOld', params);
        case 'extension_too_old':
          return tr('nativeCompatibilityBlockedExtensionTooOld', params);
        case 'protocol_unsupported':
          return tr('nativeCompatibilityBlockedProtocol', params);
        case 'native_unhealthy':
          return tr('nativeCompatibilityBlockedUnhealthy', params);
        case 'native_missing':
          return tr('nativeCompatibilityBlockedMissing', params);
        default:
          return tr('nativeCompatibilityBlockedGeneric', params);
      }
    }

    return Object.freeze({
      attachEvidence,
      ensureForMethod,
      refreshBadge,
      scheduleFirstUseOnboardingTip,
      sendBackgroundNative,
      sendNative,
      showUpdateGuidance
    });
  }

  return Object.freeze({ create });
});
