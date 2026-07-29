(function initCodexOverleafModelPicker() {
  'use strict';

  // Model picker — the model/reasoning/speed catalog, discovery, selects, and
  // config popover carved out of contentRuntime.js (v1.4.8 structural-debt
  // phase 4). Code moved verbatim; runtime collaborators are factory-injected
  // and mutable runtime state is read through lazy getters. The model
  // discovery status lives here with the code that maintains it; the runtime
  // reads it for the diagnostics bundle via getModelDiscovery().
  function create(deps = {}) {
    const {
      tr,
      tx,
      getLocale,
      sendBackgroundNative,
      getProviderSelection,
      readSelectedSpeedInput,
      getRenderedModelEntries,
      persistPanelInputs,
      closeDiagnosticsMenu,
      closeCustomInstructionsSettings,
      closeContextTray,
      closeSlashMenu,
      getPanel,
      getState
    } = deps;
    const Support = deps.Support;
    const {
      formatCompactModelLabel,
      normalizeModelOptionId,
      normalizeReasoningEffortsForSelect,
      normalizeSpeedTiersForSelect,
      retainSelectedModel
    } = Support;

  let modelDiscovery = { status: 'fallback', source: 'fallback', fetchedAt: '' };
  let modelLoadGeneration = 0;

  function getModelDiscovery() {
    return modelDiscovery;
  }

  function toggleModelConfigPopover() {
    const popover = getPanel()?.querySelector('[data-model-config-popover]');
    const button = getPanel()?.querySelector('[data-model-config-toggle]');
    if (!popover || !button) {
      return;
    }

    const open = popover.hidden;
    if (open) {
      closeDiagnosticsMenu();
      closeContextTray();
      closeCustomInstructionsSettings();
      if (typeof closeSlashMenu === 'function') {
        closeSlashMenu();
      }
      renderModelConfigChoices();
    }
    popover.hidden = !open;
    button.dataset.active = open ? 'true' : 'false';
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function closeModelConfigPopover() {
    const popover = getPanel()?.querySelector('[data-model-config-popover]');
    const button = getPanel()?.querySelector('[data-model-config-toggle]');
    if (!popover || !button) {
      return;
    }
    popover.hidden = true;
    button.dataset.active = 'false';
    button.setAttribute('aria-expanded', 'false');
  }

  async function handleModelConfigChoiceClick(event) {
    const choice = event.target?.closest?.('[data-reasoning-choice], [data-model-choice], [data-speed-choice]');
    if (!choice || choice.disabled) {
      return;
    }
    event.preventDefault();

    const modelSelect = getPanel()?.querySelector('[data-model]');
    const reasoningSelect = getPanel()?.querySelector('[data-reasoning]');
    const speedSelect = getPanel()?.querySelector('[data-speed]');
    let changedInput = null;

    if (choice.dataset.reasoningChoice && reasoningSelect) {
      reasoningSelect.value = choice.dataset.reasoningChoice;
      changedInput = reasoningSelect;
    } else if (choice.dataset.modelChoice && modelSelect) {
      modelSelect.value = choice.dataset.modelChoice;
      changedInput = modelSelect;
      renderReasoningOptions(getRenderedModelEntries());
      renderSpeedOptions(getRenderedModelEntries());
    } else if (choice.dataset.speedChoice && speedSelect) {
      speedSelect.value = choice.dataset.speedChoice;
      changedInput = speedSelect;
    }

    renderModelConfigChoices();
    updateModelDisplay();
    await persistPanelInputs(changedInput ? { type: 'change', target: changedInput } : undefined);
  }
  async function loadModelOptions(providerSelection, options = {}) {
    const generation = ++modelLoadGeneration;
    const selection = providerSelection || getProviderSelection?.() || null;
    const selectedModel = resolveSelectedModel();
    const modelCatalog = getModelCatalog();
    const fallbackModels = modelCatalog.FALLBACK_MODELS;

    try {
      const response = await sendBackgroundNative({
        method: 'codex.models',
        params: selection ? { providerSelection: selection } : {}
      });
      if (generation !== modelLoadGeneration) {
        return { stale: true };
      }
      const responseProviderId = response?.result?.providerId || '';
      if (selection?.providerId && responseProviderId && responseProviderId !== selection.providerId) {
        return { stale: true };
      }
      if (selection?.providerId && selection.providerId !== 'builtin'
        && Number(response?.result?.providerRevision) !== Number(selection.providerRevision)) {
        return { stale: true };
      }
      const currentSelectedModel = resolveSelectedModel() || selectedModel;
      const hasDiscoveredModels = response?.ok
        && Array.isArray(response.result?.models)
        && response.result.models.length > 0;
      if (!hasDiscoveredModels && !Support.shouldUseBuiltInFallback(response)) {
        applyUnavailableModelOptions(response?.error);
        return { stale: false, error: response?.error || { code: 'provider_models_unavailable' } };
      }
      const sourceModels = hasDiscoveredModels ? response.result.models : fallbackModels;
      const retainedSelectedModel = retainSelectedModel(sourceModels, currentSelectedModel);
      const normalized = modelCatalog.normalizeDiscoveredModels({ models: sourceModels, selectedModel: retainedSelectedModel });
      if (normalized.usedFallback && response.result?.providerId && response.result.providerId !== 'builtin') {
        applyUnavailableModelOptions({ code: 'provider_model_catalog_invalid', message: 'The active provider returned no usable models.' });
        return {
          stale: false,
          error: { code: 'provider_model_catalog_invalid', message: 'The active provider returned no usable models.' }
        };
      }
      renderModelOptions(normalized.models, retainedSelectedModel, { allowUnknownSelected: false });
      modelDiscovery = {
        status: hasDiscoveredModels && !normalized.usedFallback ? 'discovered' : 'fallback',
        source: hasDiscoveredModels ? response.result?.source || 'unknown' : 'fallback',
        fetchedAt: hasDiscoveredModels ? response.result?.fetchedAt || '' : '',
        errorCode: hasDiscoveredModels ? '' : response?.error?.code || '',
        errorMessage: hasDiscoveredModels ? '' : response?.error?.message || '',
        providerId: responseProviderId || selection?.providerId || 'builtin',
        providerRevision: Number(response?.result?.providerRevision || selection?.providerRevision || 0)
      };
      updateModelDisplay();
      if (options.persist !== false) {
        await persistPanelInputs();
      }
      return {
        stale: false,
        providerId: modelDiscovery.providerId,
        selectedModel: resolveSelectedModel()
      };
    } catch (error) {
      if (generation !== modelLoadGeneration) {
        return { stale: true };
      }
      applyUnavailableModelOptions(error);
      return { stale: false, error };
    }
  }

  function applyUnavailableModelOptions(error) {
    const modelSelect = getPanel()?.querySelector('[data-model]');
    if (modelSelect) {
      modelSelect.textContent = '';
      const option = document.createElement('option');
      option.value = resolveSelectedModel();
      option.textContent = tx('Models unavailable', '模型不可用');
      option.disabled = true;
      modelSelect.append(option);
      modelSelect.value = '';
      modelSelect.disabled = true;
    }
    modelDiscovery = {
      status: 'unavailable',
      source: 'custom-provider',
      fetchedAt: '',
      errorCode: error?.code || '',
      errorMessage: error?.message || (error ? String(error) : '')
    };
    renderReasoningOptions([]);
    renderSpeedOptions([]);
    renderModelConfigChoices();
    updateModelDisplay();
  }

  function applyFallbackModelOptions(selectedModel, error) {
    const modelCatalog = getModelCatalog();
    const fallbackModels = modelCatalog.FALLBACK_MODELS;
    const sourceModels = fallbackModels;
    const retainedSelectedModel = retainSelectedModel(sourceModels, selectedModel);
    const normalized = modelCatalog.normalizeDiscoveredModels({ models: sourceModels, selectedModel: retainedSelectedModel });
    renderModelOptions(normalized.models, retainedSelectedModel);
    modelDiscovery = {
      status: 'fallback',
      source: 'fallback',
      fetchedAt: '',
      errorCode: error?.code || '',
      errorMessage: error?.message || (error ? String(error) : '')
    };
    updateModelDisplay();
  }

  function getModelCatalog() {
    return Support.getModelCatalog({ getPanel });
  }

  function renderModelOptions(models, selectedModel, options = {}) {
    const modelSelect = getPanel()?.querySelector('[data-model]');
    if (!modelSelect) {
      return;
    }

    const selectedId = normalizeModelOptionId(selectedModel);
    modelSelect.textContent = '';
    modelSelect.disabled = false;
    let renderedSelected = false;
    let firstModelId = '';

    for (const model of Array.isArray(models) ? models : []) {
      const id = normalizeModelOptionId(model?.id);
      if (!id) {
        continue;
      }
      if (!firstModelId) {
        firstModelId = id;
      }
      const option = document.createElement('option');
      option.value = id;
      option.textContent = model.label;
      option.dataset.reasoningEfforts = normalizeReasoningEffortsForSelect(model.reasoningEfforts).join(',');
      option.dataset.defaultReasoningEffort = model.defaultReasoningEffort || '';
      option.dataset.reasoningPresentation = model.reasoningPresentation || '';
      option.dataset.speedTiers = normalizeSpeedTiersForSelect(model.speedTiers).join(',');
      option.dataset.defaultSpeedTier = model.defaultSpeedTier || 'standard';
      if (model.unverified) {
        option.dataset.unverified = 'true';
      }
      modelSelect.append(option);
      if (id === selectedId) {
        renderedSelected = true;
      }
    }

    if (selectedId && !renderedSelected && options.allowUnknownSelected !== false) {
      const option = document.createElement('option');
      option.value = selectedId;
      option.textContent = `${selectedId} (custom)`;
      option.dataset.reasoningEfforts = '';
      option.dataset.defaultReasoningEffort = '';
      option.dataset.reasoningPresentation = 'none';
      option.dataset.speedTiers = 'standard';
      option.dataset.defaultSpeedTier = 'standard';
      option.dataset.unverified = 'true';
      modelSelect.append(option);
      renderedSelected = true;
    }

    if (selectedId && renderedSelected) {
      modelSelect.value = selectedId;
    } else if (firstModelId) {
      modelSelect.value = firstModelId;
    }
    renderReasoningOptions(models);
    renderSpeedOptions(models);
    renderModelConfigChoices();
    updateModelDisplay();
  }

  function renderSpeedOptions(models) {
    const speedSelect = getPanel()?.querySelector('[data-speed]');
    const modelSelect = getPanel()?.querySelector('[data-model]');
    if (!speedSelect || !modelSelect) {
      return;
    }

    const selectedModel = normalizeModelOptionId(modelSelect.value);
    const model = (Array.isArray(models) ? models : []).find(item => normalizeModelOptionId(item?.id) === selectedModel);
    const speedTiers = normalizeSpeedTiersForSelect(model?.speedTiers);
    const selectedSpeed = speedTiers.includes(getState()?.speedTier) ? getState().speedTier : (model?.defaultSpeedTier || 'standard');
    speedSelect.textContent = '';
    for (const tier of speedTiers) {
      const option = document.createElement('option');
      option.value = tier;
      option.textContent = formatSpeedTierLabel(tier);
      speedSelect.append(option);
    }
    speedSelect.value = speedTiers.includes(selectedSpeed) ? selectedSpeed : 'standard';
    speedSelect.disabled = speedTiers.length <= 1;
    speedSelect.title = speedSelect.disabled
      ? tx('Fast mode is not available for this model.', '当前模型不支持 Fast 模式。')
      : tx('Codex speed tier. Fast mode uses extra credits.', 'Codex 速度档；Fast 会消耗额外 credits。');
    renderModelConfigChoices();
  }

  function renderReasoningOptions(models) {
    const reasoningSelect = getPanel()?.querySelector('[data-reasoning]');
    const modelSelect = getPanel()?.querySelector('[data-model]');
    if (!reasoningSelect || !modelSelect) {
      return;
    }

    const selectedModel = normalizeModelOptionId(modelSelect.value);
    const model = (Array.isArray(models) ? models : []).find(item => normalizeModelOptionId(item?.id) === selectedModel);
    const presentation = model?.reasoningPresentation || 'effort';
    let efforts = normalizeReasoningEffortsForSelect(model?.reasoningEfforts);
    if (!efforts.length) {
      efforts = presentation === 'none' ? ['none'] : ['low', 'medium', 'high', 'xhigh'];
    }
    const current = reasoningSelect.value || getState()?.reasoningEffort || '';
    const fallback = efforts.includes(model?.defaultReasoningEffort)
      ? model.defaultReasoningEffort
      : efforts.includes('high') ? 'high' : efforts[0];

    reasoningSelect.textContent = '';
    for (const effort of efforts) {
      const option = document.createElement('option');
      option.value = effort;
      option.textContent = formatReasoningEffortLabel(effort, presentation);
      reasoningSelect.append(option);
    }
    reasoningSelect.value = efforts.includes(current) ? current : fallback;
    reasoningSelect.disabled = presentation === 'none';
    reasoningSelect.dataset.presentation = presentation;
  }

  function renderModelConfigChoices() {
    renderReasoningChoices();
    renderModelChoices();
    renderSpeedChoices();
    syncModelConfigChoices();
  }

  function renderReasoningChoices() {
    const list = getPanel()?.querySelector('[data-reasoning-choice-list]');
    const reasoningSelect = getPanel()?.querySelector('[data-reasoning]');
    if (!list || !reasoningSelect) {
      return;
    }
    list.textContent = '';
    const hidden = reasoningSelect.dataset.presentation === 'none';
    list.hidden = hidden;
    if (list.nextElementSibling?.classList?.contains('codex-model-config-divider')) {
      list.nextElementSibling.hidden = hidden;
    }
    for (const option of Array.from(reasoningSelect.options || [])) {
      list.append(createModelConfigChoice({
        value: option.value,
        label: option.textContent || formatReasoningEffortLabel(option.value, reasoningSelect.dataset.presentation),
        datasetName: 'reasoningChoice'
      }));
    }
  }

  function renderModelChoices() {
    const list = getPanel()?.querySelector('[data-model-choice-list]');
    const modelSelect = getPanel()?.querySelector('[data-model]');
    if (!list || !modelSelect) {
      return;
    }
    list.textContent = '';
    for (const option of Array.from(modelSelect.options || [])) {
      const choice = createModelConfigChoice({
        value: option.value,
        label: option.textContent || option.value,
        datasetName: 'modelChoice'
      });
      choice.title = option.textContent || option.value;
      list.append(choice);
    }
  }

  function renderSpeedChoices() {
    const list = getPanel()?.querySelector('[data-speed-choice-list]');
    const speedSelect = getPanel()?.querySelector('[data-speed]');
    if (!list || !speedSelect) {
      return;
    }
    list.textContent = '';
    for (const option of Array.from(speedSelect.options || [])) {
      const choice = createModelConfigChoice({
        value: option.value,
        label: formatSpeedTierLabel(option.value),
        datasetName: 'speedChoice'
      });
      choice.disabled = speedSelect.disabled && speedSelect.options.length <= 1;
      list.append(choice);
    }
  }

  function createModelConfigChoice({ value, label, datasetName }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'codex-model-config-choice';
    button.dataset[datasetName] = value;
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', 'false');

    const text = document.createElement('span');
    text.className = 'codex-model-config-choice-label';
    text.textContent = label;
    button.append(text);

    const check = document.createElement('span');
    check.className = 'codex-model-config-check';
    check.textContent = '✓';
    check.setAttribute('aria-hidden', 'true');
    button.append(check);
    return button;
  }

  function syncModelConfigChoices() {
    const selectedModel = getPanel()?.querySelector('[data-model]')?.value || '';
    const selectedReasoning = getPanel()?.querySelector('[data-reasoning]')?.value || '';
    const selectedSpeed = getPanel()?.querySelector('[data-speed]')?.value || 'standard';
    syncChoiceGroup('[data-model-choice]', selectedModel);
    syncChoiceGroup('[data-reasoning-choice]', selectedReasoning);
    syncChoiceGroup('[data-speed-choice]', selectedSpeed);
  }

  function syncChoiceGroup(selector, selectedValue) {
    for (const button of getPanel()?.querySelectorAll(selector) || []) {
      const value = button.dataset.modelChoice || button.dataset.reasoningChoice || button.dataset.speedChoice || '';
      const active = value === selectedValue;
      button.dataset.active = active ? 'true' : 'false';
      button.setAttribute('aria-checked', active ? 'true' : 'false');
    }
  }

  function formatSpeedTierLabel(tier) {
    return tier === 'fast' ? tx('Fast', '快速') : tx('Standard', '标准');
  }

  function formatReasoningEffortLabel(effort, presentation = '') {
    if (presentation === 'toggle') {
      return effort === 'none' ? tx('Off', '关闭') : tx('On', '开启');
    }
    if (presentation === 'deepseek') {
      if (effort === 'none') return tx('Off', '关闭');
      if (effort === 'xhigh') return 'Max';
    }
    const labels = getLocale() === 'zh'
      ? { none: '关闭', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '超高' }
      : { none: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh' };
    return labels[effort] || effort || '';
  }

  function resolveSelectedModel() {
    return getPanel()?.querySelector('[data-model]')?.value || getState()?.model || '';
  }

  function getModelDiscoverySourceLabel() {
    if (modelDiscovery.errorCode || modelDiscovery.errorMessage) {
      return modelDiscovery.status === 'fallback'
        ? `${tr('modelSourceFailed')} (${tr('modelSourceFallback')})`
        : tr('modelSourceFailed');
    }
    if (modelDiscovery.source === 'fallback') {
      return tr('modelSourceFallback');
    }
    if (modelDiscovery.source) {
      return modelDiscovery.source;
    }
    return modelDiscovery.status === 'discovered' ? tr('modelSourceDiscovered') : tr('modelSourceFallback');
  }

  function updateModelDisplay() {
    const modelSelect = getPanel()?.querySelector('[data-model]');
    const modelDisplay = getPanel()?.querySelector('[data-model-display]');
    const reasoningDisplay = getPanel()?.querySelector('[data-reasoning-display]');
    const speedIndicator = getPanel()?.querySelector('[data-speed-indicator]');
    const configButton = getPanel()?.querySelector('[data-model-config-toggle]');
    if (!modelSelect || !modelDisplay) {
      return;
    }
    const fullLabel = modelSelect.options[modelSelect.selectedIndex]?.textContent || modelSelect.value;
    modelDisplay.textContent = formatCompactModelLabel(fullLabel);
    const sourceTitle = tr('modelDisplayTitle', {
      label: fullLabel,
      source: getModelDiscoverySourceLabel()
    });
    modelDisplay.title = sourceTitle;
    if (reasoningDisplay) {
      const reasoningSelect = getPanel()?.querySelector('[data-reasoning]');
      const presentation = reasoningSelect?.dataset.presentation || '';
      reasoningDisplay.hidden = presentation === 'none';
      reasoningDisplay.textContent = presentation === 'none'
        ? ''
        : formatReasoningEffortLabel(reasoningSelect?.value || getState()?.reasoningEffort || '', presentation);
    }
    if (speedIndicator) {
      speedIndicator.hidden = readSelectedSpeedInput() !== 'fast';
    }
    if (configButton) {
      configButton.title = [
        sourceTitle,
        reasoningDisplay?.textContent ? `${tx('Reasoning', '推理')}: ${reasoningDisplay.textContent}` : '',
        readSelectedSpeedInput() === 'fast' ? tx('Fast mode', '快速模式') : tx('Standard speed', '标准速度')
      ].filter(Boolean).join(' · ');
    }
  }

    return {
      getModelDiscovery,
      toggleModelConfigPopover,
      closeModelConfigPopover,
      handleModelConfigChoiceClick,
      loadModelOptions,
      applyFallbackModelOptions,
      applyUnavailableModelOptions,
      getModelCatalog,
      renderModelOptions,
      renderReasoningOptions,
      renderSpeedOptions,
      renderModelConfigChoices,
      resolveSelectedModel,
      normalizeModelOptionId,
      updateModelDisplay
    };
  }

  window.CodexOverleafModelPicker = { create };
})();
