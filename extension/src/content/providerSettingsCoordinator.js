(function initCodexOverleafProviderSettingsCoordinator() {
  'use strict';

  function create(options = {}) {
    const Profiles = window.CodexOverleafProviderProfiles;
    const instance = {
      tx: options.tx || ((english) => english),
      sendBackgroundNative: options.sendBackgroundNative,
      getSettingsPanelInstance: options.getSettingsPanelInstance || (() => null),
      getSelectedModel: options.getSelectedModel || (() => ''),
      clearSelectedModel: options.clearSelectedModel || (() => {}),
      refreshModelOptions: options.refreshModelOptions || (() => {}),
      persistInputs: options.persistInputs || (() => {}),
      catalog: Profiles.normalizeCatalog({}),
      loaded: false,
      loadPromise: null,
      testOperationId: '',
      channel: null,
      dialog: null
    };
    instance.onProviderChanged = options.onProviderChanged
      || ((catalog, change) => reconcileProviderSelection(instance, catalog, change));
    instance.dialog = window.CodexOverleafProviderSettingsDialog.create({
      document: options.document || document,
      tx: instance.tx,
      callbacks: {
        onTest: context => testProvider(instance, context),
        onCancelTest: () => cancelProviderTest(instance),
        onSave: (context, action) => saveProvider(instance, context, action),
        onActivate: context => activateProvider(instance, context),
        onClearSecret: context => clearProviderSecret(instance, context),
        onDelete: context => deleteProvider(instance, context),
        onActivateBuiltin: () => activateBuiltin(instance)
      }
    });
    setupCrossTabRefresh(instance, options.window || window);
    return {
      open: () => open(instance),
      refreshSummary: () => refresh(instance),
      ensureLoaded: () => ensureLoaded(instance),
      getRunSelection: () => instance.loaded ? Profiles.buildRunSelection(instance.catalog) : null,
      getCatalog: () => instance.catalog,
      destroy: () => destroy(instance),
      _instance: instance
    };
  }

  async function open(instance) {
    instance.dialog.open(instance.catalog);
    instance.dialog.setBusy('loading', instance.tx('Loading providers…', '正在加载模型服务…'));
    try {
      await refresh(instance, { updateDialog: true });
      instance.dialog.setBusy('', '');
    } catch (_error) {
      // refresh() already projected the actionable failure into the dialog.
      // Keep the modal open so the user can close it or retry from Settings.
    }
  }

  async function refresh(instance, options = {}) {
    try {
      const result = await request(instance, 'codex.providers.list');
      return applyCatalog(instance, result, options);
    } catch (error) {
      updateSettingsSummary(instance, {
        summary: instance.tx('Provider settings unavailable', '模型服务设置不可用'),
        tone: 'failed'
      });
      if (options.updateDialog) {
        instance.dialog.setBusy('failed', formatError(instance, error));
      }
      throw error;
    }
  }

  async function ensureLoaded(instance) {
    if (instance.loaded) {
      return instance.catalog;
    }
    if (!instance.loadPromise) {
      instance.loadPromise = refresh(instance).finally(() => {
        instance.loadPromise = null;
      });
    }
    await instance.loadPromise;
    return instance.catalog;
  }

  async function reconcileProviderSelection(instance, catalog, change = {}) {
    if (!change.activeProviderChanged && !change.activeModelCatalogChanged) {
      return;
    }
    const previousModel = instance.getSelectedModel();
    const activeProvider = window.CodexOverleafProviderProfiles.getActiveProvider(catalog);
    const previousModelUnavailable = activeProvider.kind === 'custom'
      && previousModel
      && !activeProvider.models.some(model => model.id === previousModel);
    if (change.activeProviderChanged || previousModelUnavailable) {
      instance.clearSelectedModel();
    }
    await instance.refreshModelOptions();
    await instance.persistInputs();
  }

  async function testProvider(instance, context) {
    const operationId = crypto.randomUUID();
    instance.testOperationId = operationId;
    instance.dialog.setBusy('testing', instance.tx('Preparing compatibility test…', '正在准备兼容性测试…'));
    try {
      const result = await request(instance, 'codex.providers.test', {
        operationId,
        profileId: context.profileId,
        expectedRevision: context.expectedRevision,
        draft: context.draft,
        secretMutation: context.secretMutation,
        modelId: context.testModelId,
        totalBudgetMs: 120000
      }, event => {
        if (instance.testOperationId === operationId && event?.type === 'provider.test.progress') {
          instance.dialog.setTestProgress(event);
        }
      });
      if (instance.testOperationId !== operationId) {
        return;
      }
      instance.dialog.setBusy('', '');
      instance.dialog.setVerification(result);
    } catch (error) {
      if (instance.testOperationId !== operationId) {
        return;
      }
      instance.dialog.setBusy('failed', formatError(instance, error));
      instance.dialog.setVerificationFailure({
        modelId: context.testModelId,
        errorCode: error?.code || error?.details?.code || ''
      });
      instance.dialog.setStatus({ tone: 'failed', title: formatError(instance, error) });
    } finally {
      if (instance.testOperationId === operationId) {
        instance.testOperationId = '';
      }
    }
  }

  async function cancelProviderTest(instance) {
    const operationId = instance.testOperationId;
    instance.testOperationId = '';
    instance.dialog.setBusy('', '');
    if (!operationId) {
      return;
    }
    try {
      await request(instance, 'codex.providers.test.cancel', { operationId });
    } catch (_error) {
      // Closing the dialog remains immediate; the test process has its own timeout.
    }
  }

  async function saveProvider(instance, context, action = {}) {
    instance.dialog.setBusy('saving', instance.tx('Saving provider…', '正在保存模型服务…'));
    try {
      const result = await request(instance, 'codex.providers.upsert', {
        profileId: context.profileId,
        expectedRevision: context.expectedRevision,
        draft: context.draft,
        secretMutation: context.secretMutation,
        activate: action.activate === true,
        disclosureHost: context.disclosureHost,
        disclosureBaseUrl: context.disclosureBaseUrl,
        diagnostics: context.verifications
      });
      const previousCatalog = instance.catalog;
      const applied = applyCatalog(instance, result, {
        updateDialog: true,
        selectedId: result.savedProviderId
      });
      await notifyChanged(instance, applied.change);
      instance.dialog.setBusy('', '');
      const fellBackToBuiltin = previousCatalog.activeProviderId === result.savedProviderId
        && result.activeProviderId === 'builtin'
        && action.activate !== true;
      instance.dialog.setStatus({
        tone: fellBackToBuiltin ? 'warning' : 'success',
        title: fellBackToBuiltin
          ? instance.tx(
              'Provider saved. Its endpoint changed, so Built-in Codex is active until the new endpoint is approved.',
              '模型服务已保存。由于端点发生变化，确认新端点前将使用内置 Codex。'
            )
          : action.activate
          ? instance.tx('Provider saved and activated.', '模型服务已保存并启用。')
          : instance.tx('Provider saved.', '模型服务已保存。')
      });
    } catch (error) {
      instance.dialog.setBusy('failed', formatError(instance, error));
      instance.dialog.setStatus({ tone: 'failed', title: formatError(instance, error) });
    }
  }

  async function clearProviderSecret(instance, context) {
    instance.dialog.setBusy('saving', instance.tx('Removing stored API key…', '正在删除已存储的 API 密钥…'));
    try {
      const result = await request(instance, 'codex.providers.clear-secret', {
        providerId: context.profileId,
        expectedRevision: context.expectedRevision
      });
      const applied = applyCatalog(instance, result, {
        updateDialog: true,
        selectedId: context.profileId
      });
      await notifyChanged(instance, applied.change);
      instance.dialog.setBusy('', '');
      instance.dialog.setStatus({
        tone: 'success',
        title: result.activeProviderId === 'builtin'
          ? instance.tx('API key removed. Built-in Codex is now active.', 'API 密钥已删除，当前已切换到内置 Codex。')
          : instance.tx('Stored API key removed.', '已删除存储的 API 密钥。')
      });
    } catch (error) {
      instance.dialog.setBusy('failed', formatError(instance, error));
    }
  }

  async function deleteProvider(instance, context) {
    instance.dialog.setBusy('deleting', instance.tx('Deleting provider…', '正在删除模型服务…'));
    try {
      const result = await request(instance, 'codex.providers.delete', {
        providerId: context.profileId,
        expectedRevision: context.expectedRevision
      });
      const applied = applyCatalog(instance, result, { updateDialog: true });
      await notifyChanged(instance, applied.change);
      instance.dialog.setBusy('', '');
      instance.dialog.setStatus({ tone: 'success', title: instance.tx('Provider deleted.', '模型服务已删除。') });
    } catch (error) {
      instance.dialog.setBusy('failed', formatError(instance, error));
    }
  }

  async function activateProvider(instance, context) {
    instance.dialog.setBusy('saving', instance.tx('Activating provider…', '正在启用模型服务…'));
    try {
      const result = await request(instance, 'codex.providers.activate', {
        providerId: context.profileId,
        expectedRevision: context.expectedRevision,
        disclosureHost: context.disclosureHost,
        disclosureBaseUrl: context.disclosureBaseUrl
      });
      const applied = applyCatalog(instance, result, {
        updateDialog: true,
        selectedId: context.profileId
      });
      await notifyChanged(instance, applied.change);
      instance.dialog.setBusy('', '');
      instance.dialog.setStatus({
        tone: 'success',
        title: instance.tx('Provider activated.', '模型服务已启用。')
      });
    } catch (error) {
      instance.dialog.setBusy('failed', formatError(instance, error));
      instance.dialog.setStatus({ tone: 'failed', title: formatError(instance, error) });
    }
  }

  async function activateBuiltin(instance) {
    instance.dialog.setBusy('saving', instance.tx('Activating built-in Codex…', '正在启用内置 Codex…'));
    try {
      const result = await request(instance, 'codex.providers.activate', {
        providerId: 'builtin',
        expectedRevision: 0
      });
      const applied = applyCatalog(instance, result, { updateDialog: true, selectedId: 'builtin' });
      await notifyChanged(instance, applied.change);
      instance.dialog.setBusy('', '');
      instance.dialog.setStatus({ tone: 'success', title: instance.tx('Built-in Codex is active.', '已启用内置 Codex。') });
    } catch (error) {
      instance.dialog.setBusy('failed', formatError(instance, error));
    }
  }

  async function request(instance, method, params = {}, onEvent) {
    if (typeof instance.sendBackgroundNative !== 'function') {
      throw createClientError('native_unavailable', 'Native Host request channel is unavailable.');
    }
    const response = await instance.sendBackgroundNative({ method, params }, onEvent);
    if (!response?.ok) {
      const error = createClientError(
        response?.error?.code || 'provider_request_failed',
        response?.error?.message || 'Provider request failed.'
      );
      error.details = response?.error || {};
      throw error;
    }
    return response.result || {};
  }

  function applyCatalog(instance, result, options = {}) {
    const nextCatalog = window.CodexOverleafProviderProfiles.normalizeCatalog(result);
    if (instance.loaded && nextCatalog.storeRevision < instance.catalog.storeRevision) {
      return { applied: false, change: emptyCatalogChange() };
    }
    const previousCatalog = instance.catalog;
    instance.catalog = nextCatalog;
    instance.loaded = true;
    updateSettingsSummary(instance);
    if (options.updateDialog && instance.dialog.isOpen()) {
      if (options.source === 'cross-tab') {
        instance.dialog.offerCatalog(instance.catalog, options.selectedId);
      } else {
        instance.dialog.setCatalog(instance.catalog, options.selectedId);
      }
    }
    return { applied: true, change: describeCatalogChange(previousCatalog, nextCatalog) };
  }

  function updateSettingsSummary(instance, override = {}) {
    const active = window.CodexOverleafProviderProfiles.getActiveProvider(instance.catalog);
    const summary = override.summary || (active.kind === 'builtin'
      ? instance.tx('Built-in Codex is active', '当前使用内置 Codex')
      : `${active.name} · ${active.defaultModelId || instance.tx('No model', '未配置模型')} · ${instance.tx('Active', '使用中')}`);
    instance.getSettingsPanelInstance()?.setProviderSummary?.({
      summary,
      tone: override.tone || (active.kind === 'custom' && active.wireApiPreference === 'auto' && !active.resolvedWireApi ? 'warning' : 'ok')
    });
  }

  async function notifyChanged(instance, change = emptyCatalogChange()) {
    try {
      instance.channel?.postMessage?.({ type: 'provider-settings-changed', change, at: Date.now() });
    } catch (_error) {
      // Revision checks remain authoritative when BroadcastChannel is unavailable.
    }
    try {
      await instance.onProviderChanged(instance.catalog, change);
    } catch (_error) {
      // The authoritative catalog is already saved. A later refresh can retry
      // the local model projection without rolling back the provider change.
    }
  }

  function setupCrossTabRefresh(instance, targetWindow) {
    try {
      instance.channel = new targetWindow.BroadcastChannel('codex-overleaf-provider-settings-v1');
      instance.channel.addEventListener('message', event => {
        if (event.data?.type !== 'provider-settings-changed') {
          return;
        }
        refresh(instance, { updateDialog: instance.dialog.isOpen(), source: 'cross-tab' })
          .then(applied => applied.applied && instance.onProviderChanged(instance.catalog, applied.change))
          .catch(() => {});
      });
    } catch (_error) {
      instance.channel = null;
    }
  }

  function describeCatalogChange(previous, next) {
    const previousActive = window.CodexOverleafProviderProfiles.getActiveProvider(previous);
    const nextActive = window.CodexOverleafProviderProfiles.getActiveProvider(next);
    return {
      activeProviderChanged: previousActive.id !== nextActive.id,
      activeModelCatalogChanged: modelCatalogSignature(previousActive) !== modelCatalogSignature(nextActive)
    };
  }

  function modelCatalogSignature(provider = {}) {
    return JSON.stringify({
      id: provider.id || '',
      defaultModelId: provider.defaultModelId || '',
      reasoningAdapter: provider.reasoningAdapter || '',
      reasoningCapability: provider.reasoningCapability || '',
      models: (provider.models || []).map(model => ({
        id: model.id,
        label: model.label,
        reasoningEfforts: model.reasoningEfforts || []
      }))
    });
  }

  function emptyCatalogChange() {
    return { activeProviderChanged: false, activeModelCatalogChanged: false };
  }

  function formatError(instance, error) {
    const code = error?.code || error?.details?.code || '';
    const messages = {
      provider_auth_rejected: instance.tx('The provider rejected the API key.', '模型服务拒绝了 API 密钥。'),
      provider_model_not_found: instance.tx('The configured model was not found.', '未找到所配置的模型。'),
      provider_protocol_incompatible: instance.tx('The endpoint is incompatible with the selected API protocol.', '端点与所选 API 协议不兼容。'),
      provider_request_rejected: instance.tx('The provider rejected the probe request. Review the model and compatibility settings.', '模型服务拒绝了探测请求，请检查模型和兼容设置。'),
      provider_agent_tools_incompatible: instance.tx('The model answered, but it could not complete the Codex tool-call loop.', '模型能够回答，但无法完成 Codex 工具调用闭环。'),
      provider_stream_tool_parse_failed: instance.tx('Streaming tool calls were malformed. Test again with Auto or Buffered upstream responses.', '流式工具调用解析异常，请使用“自动”或“缓冲上游响应”后重新测试。'),
      provider_response_invalid: instance.tx('The provider completed without usable text or tool calls.', '模型服务结束了请求，但没有返回可用文本或工具调用。'),
      provider_configuration_invalid: instance.tx('Review the endpoint, authentication, headers, and compatibility settings.', '请检查端点、鉴权、请求头和兼容设置。'),
      provider_connection_timeout: instance.tx('The provider connection timed out.', '连接模型服务超时。'),
      provider_revision_conflict: instance.tx('This provider changed in another tab. Reload it and retry.', '此模型服务已在其他标签页发生变化，请刷新后重试。'),
      provider_protocol_negotiation_required: instance.tx('The Auto protocol could not be negotiated for this model.', '无法为此模型自动协商 API 协议。')
    };
    return messages[code] || error?.message || instance.tx('Provider operation failed.', '模型服务操作失败。');
  }

  function createClientError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function destroy(instance) {
    instance.channel?.close?.();
    instance.dialog?.destroy?.();
  }

  window.CodexOverleafProviderSettingsCoordinator = { create };
})();
