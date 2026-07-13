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

  let modelDiscovery = { status: 'fallback', source: 'fallback', fetchedAt: '' };

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

    if (choice.dataset.reasoningChoice && reasoningSelect) {
      reasoningSelect.value = choice.dataset.reasoningChoice;
    } else if (choice.dataset.modelChoice && modelSelect) {
      modelSelect.value = choice.dataset.modelChoice;
      renderSpeedOptions(getRenderedModelEntries());
    } else if (choice.dataset.speedChoice && speedSelect) {
      speedSelect.value = choice.dataset.speedChoice;
    }

    renderModelConfigChoices();
    updateModelDisplay();
    await persistPanelInputs();
  }
  async function loadModelOptions() {
    const selectedModel = resolveSelectedModel();
    const modelCatalog = getModelCatalog();
    const fallbackModels = modelCatalog.FALLBACK_MODELS;

    try {
      const response = await sendBackgroundNative({
        method: 'codex.models',
        params: {}
      });
      const currentSelectedModel = resolveSelectedModel() || selectedModel;
      const hasDiscoveredModels = response?.ok
        && Array.isArray(response.result?.models)
        && response.result.models.length > 0;
      const sourceModels = hasDiscoveredModels ? response.result.models : fallbackModels;
      const normalized = modelCatalog.normalizeDiscoveredModels({ models: sourceModels, selectedModel: currentSelectedModel });
      const usedHostFallback = response?.result?.source === 'fallback';
      renderModelOptions(normalized.models, currentSelectedModel);
      modelDiscovery = {
        status: hasDiscoveredModels && !normalized.usedFallback && !usedHostFallback ? 'discovered' : 'fallback',
        source: hasDiscoveredModels ? response.result?.source || 'unknown' : 'fallback',
        fetchedAt: hasDiscoveredModels ? response.result?.fetchedAt || '' : '',
        errorCode: usedHostFallback ? response.result?.errorCode || '' : (hasDiscoveredModels ? '' : response?.error?.code || ''),
        errorMessage: usedHostFallback ? response.result?.errorMessage || '' : (hasDiscoveredModels ? '' : response?.error?.message || '')
      };
      updateModelDisplay();
    } catch (error) {
      applyFallbackModelOptions(resolveSelectedModel() || selectedModel, error);
    }
  }

  function applyFallbackModelOptions(selectedModel, error) {
    const modelCatalog = getModelCatalog();
    const fallbackModels = modelCatalog.FALLBACK_MODELS;
    const sourceModels = fallbackModels;
    const normalized = modelCatalog.normalizeDiscoveredModels({ models: sourceModels, selectedModel });
    renderModelOptions(normalized.models, selectedModel);
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
    const shared = window.CodexOverleafModels;
    if (Array.isArray(shared?.FALLBACK_MODELS) && typeof shared?.normalizeDiscoveredModels === 'function') {
      return shared;
    }

    return {
      FALLBACK_MODELS: buildDomModelCatalogFallback(),
      normalizeDiscoveredModels: normalizeDiscoveredModelsFallback
    };
  }

  function buildDomModelCatalogFallback() {
    const modelSelect = getPanel()?.querySelector('[data-model]');
    const domModels = Array.from(modelSelect?.options || [])
      .map(option => ({
        id: normalizeModelOptionId(option.value),
        label: option.textContent || option.value
      }))
      .filter(model => model.id);

    return domModels.length ? domModels : [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
      { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
      { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
      { id: 'gpt-5.2', label: 'GPT-5.2' }
    ];
  }

  function normalizeDiscoveredModelsFallback({ models, selectedModel } = {}) {
    const normalized = normalizeModelCatalogEntries(models);
    const usedFallback = normalized.length === 0;
    const resultModels = usedFallback ? buildDomModelCatalogFallback().map(model => ({ ...model })) : normalized;
    const selectedId = normalizeModelOptionId(selectedModel);

    if (selectedId && !resultModels.some(model => model.id === selectedId)) {
      resultModels.push({
        id: selectedId,
        label: `${selectedId} (custom)`,
        unverified: true
      });
    }

    return {
      models: resultModels,
      usedFallback
    };
  }

  function normalizeModelCatalogEntries(models) {
    if (!Array.isArray(models)) {
      return [];
    }

    const seen = new Set();
    const result = [];

    for (const model of models) {
      const id = normalizeModelOptionId(typeof model === 'string' ? model : model?.id);
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      const normalized = {
        id,
        label: typeof model?.label === 'string' && model.label.length > 0 ? model.label : id,
        reasoningEfforts: Array.isArray(model?.reasoningEfforts) ? model.reasoningEfforts.slice() : [],
        speedTiers: normalizeSpeedTiersForSelect(model?.speedTiers)
      };
      if (Object.prototype.hasOwnProperty.call(Object(model), 'defaultReasoningEffort')) {
        normalized.defaultReasoningEffort = model.defaultReasoningEffort;
      }
      if (Object.prototype.hasOwnProperty.call(Object(model), 'defaultSpeedTier')) {
        normalized.defaultSpeedTier = model.defaultSpeedTier;
      }
      result.push(normalized);
    }

    return result;
  }

  function renderModelOptions(models, selectedModel) {
    const modelSelect = getPanel()?.querySelector('[data-model]');
    if (!modelSelect) {
      return;
    }

    const selectedId = normalizeModelOptionId(selectedModel);
    modelSelect.textContent = '';
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

    if (selectedId && !renderedSelected) {
      const option = document.createElement('option');
      option.value = selectedId;
      option.textContent = `${selectedId} (custom)`;
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
    for (const option of Array.from(reasoningSelect.options || [])) {
      list.append(createModelConfigChoice({
        value: option.value,
        label: formatReasoningEffortLabel(option.value),
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

  function normalizeSpeedTiersForSelect(speedTiers) {
    const tiers = Array.isArray(speedTiers)
      ? speedTiers.map(tier => normalizeModelOptionId(tier)).filter(Boolean)
      : ['standard'];
    return tiers.includes('standard') ? tiers : ['standard', ...tiers];
  }

  function formatSpeedTierLabel(tier) {
    return tier === 'fast' ? tx('Fast', '快速') : tx('Standard', '标准');
  }

  function formatReasoningEffortLabel(effort) {
    const labels = getLocale() === 'zh'
      ? { low: '低', medium: '中', high: '高', xhigh: '超高' }
      : { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh' };
    return labels[effort] || effort || '';
  }

  function formatCompactModelLabel(label) {
    return String(label || '').replace(/^gpt[-\s]*/i, '');
  }

  function resolveSelectedModel() {
    return getPanel()?.querySelector('[data-model]')?.value || getState()?.model || '';
  }

  function normalizeModelOptionId(id) {
    return typeof id === 'string' ? id.trim() : '';
  }

  function getModelDiscoverySourceLabel() {
    if (modelDiscovery.errorCode || modelDiscovery.errorMessage) {
      return `${tr('modelSourceFailed')} (${tr('modelSourceFallback')})`;
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
      reasoningDisplay.textContent = formatReasoningEffortLabel(getPanel()?.querySelector('[data-reasoning]')?.value || getState()?.reasoningEffort || '');
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
      getModelCatalog,
      renderModelOptions,
      renderSpeedOptions,
      renderModelConfigChoices,
      resolveSelectedModel,
      normalizeModelOptionId,
      updateModelDisplay
    };
  }

  window.CodexOverleafModelPicker = { create };
})();
