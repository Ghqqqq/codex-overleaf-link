(function initCodexOverleafModelPickerSupport(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/models'));
  } else {
    root.CodexOverleafModuleRegistry.define('ModelPickerSupport', ['Models'], factory);
  }
})(typeof window !== 'undefined' ? window : globalThis, function modelPickerSupportFactory(Models) {
  'use strict';

  function normalizeModelOptionId(id) {
    return typeof id === 'string' ? id.trim() : '';
  }

  function normalizeSpeedTiersForSelect(speedTiers) {
    const tiers = Array.isArray(speedTiers)
      ? speedTiers.map(tier => normalizeModelOptionId(tier)).filter(Boolean)
      : ['standard'];
    return tiers.includes('standard') ? tiers : ['standard', ...tiers];
  }

  function speedChoiceVisible(speedTiers) {
    return normalizeSpeedTiersForSelect(speedTiers).length > 1;
  }

  function normalizeReasoningEffortsForSelect(efforts) {
    const allowed = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    return Array.from(new Set((Array.isArray(efforts) ? efforts : [])
      .map(effort => normalizeModelOptionId(effort))
      .filter(effort => allowed.has(effort))));
  }

  function formatCompactModelLabel(label) {
    return String(label || '').replace(/^gpt[-\s]*/i, '');
  }

  function retainSelectedModel(models, selectedModel, options = {}) {
    const selectedId = normalizeModelOptionId(selectedModel);
    if (!selectedId) return '';
    if (options.preserveUnavailable === true) return selectedId;
    return (Array.isArray(models) ? models : []).some(model => (
      normalizeModelOptionId(typeof model === 'string' ? model : model?.id) === selectedId
    )) ? selectedId : '';
  }

  // A fallback or missing catalog entry cannot revoke an explicit selection.
  // Keep its saved controls provisional until real capability data arrives.
  function preserveSelectedCapabilities(models, selectedModel, preferences = {}, provisional = false) {
    const selectedId = normalizeModelOptionId(selectedModel);
    const saved = preferences || {};
    return (Array.isArray(models) ? models : []).map(model => {
      if (model.id !== selectedId || (!provisional && !model.unverified)) return model;
      const reasoningEfforts = normalizeReasoningEffortsForSelect([
        ...(model.reasoningEfforts || []), saved.reasoningEffort
      ]);
      const speedTiers = normalizeSpeedTiersForSelect(model.speedTiers);
      const speed = ['standard', 'fast'].includes(saved.speedTier) ? saved.speedTier : '';
      if (speed && !speedTiers.includes(speed)) speedTiers.push(speed);
      return {
        ...model, unverified: true, reasoningEfforts, speedTiers,
        defaultReasoningEffort: reasoningEfforts.includes(saved.reasoningEffort)
          ? saved.reasoningEffort : model.defaultReasoningEffort,
        defaultSpeedTier: speed || model.defaultSpeedTier || 'standard'
      };
    });
  }

  function getRenderedModelEntries(panel) {
    return Array.from(panel?.querySelector('[data-model]')?.options || []).map(option => ({
      id: option.value,
      label: option.textContent,
      reasoningEfforts: (option.dataset.reasoningEfforts || '').split(',').filter(Boolean),
      defaultReasoningEffort: option.dataset.defaultReasoningEffort || '',
      reasoningPresentation: option.dataset.reasoningPresentation || '',
      speedTiers: (option.dataset.speedTiers || 'standard').split(',').filter(Boolean),
      defaultSpeedTier: option.dataset.defaultSpeedTier || 'standard'
    }));
  }

  function shouldUseBuiltInFallback(response) {
    const providerId = normalizeModelOptionId(response?.result?.providerId);
    return response?.ok === true && (!providerId || providerId === 'builtin');
  }

  function getModelCatalog({ getPanel } = {}) {
    const shared = Models;
    if (Array.isArray(shared?.FALLBACK_MODELS) && typeof shared?.normalizeDiscoveredModels === 'function') {
      return shared;
    }
    return {
      FALLBACK_MODELS: buildDomModelCatalogFallback(getPanel),
      normalizeDiscoveredModels: input => normalizeDiscoveredModelsFallback(input, getPanel)
    };
  }

  function buildDomModelCatalogFallback(getPanel) {
    const modelSelect = getPanel?.()?.querySelector('[data-model]');
    const domModels = Array.from(modelSelect?.options || [])
      .map(option => ({ id: normalizeModelOptionId(option.value), label: option.textContent || option.value }))
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

  function normalizeDiscoveredModelsFallback({ models, selectedModel } = {}, getPanel) {
    const normalized = normalizeModelCatalogEntries(models);
    const usedFallback = normalized.length === 0;
    const resultModels = usedFallback
      ? buildDomModelCatalogFallback(getPanel).map(model => ({ ...model }))
      : normalized;
    const selectedId = normalizeModelOptionId(selectedModel);
    if (selectedId && !resultModels.some(model => model.id === selectedId)) {
      resultModels.push({ id: selectedId, label: `${selectedId} (custom)`, unverified: true });
    }
    return { models: resultModels, usedFallback };
  }

  function normalizeModelCatalogEntries(models) {
    if (!Array.isArray(models)) return [];
    const seen = new Set();
    const result = [];
    for (const model of models) {
      const id = normalizeModelOptionId(typeof model === 'string' ? model : model?.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const normalized = {
        id,
        label: typeof model?.label === 'string' && model.label.length > 0 ? model.label : id,
        reasoningEfforts: normalizeReasoningEffortsForSelect(model?.reasoningEfforts),
        reasoningPresentation: typeof model?.reasoningPresentation === 'string' ? model.reasoningPresentation : '',
        speedTiers: normalizeSpeedTiersForSelect(model?.speedTiers)
      };
      if (Object.prototype.hasOwnProperty.call(Object(model), 'defaultReasoningEffort')) {
        normalized.defaultReasoningEffort = normalizeModelOptionId(model.defaultReasoningEffort);
      }
      if (Object.prototype.hasOwnProperty.call(Object(model), 'defaultSpeedTier')) {
        normalized.defaultSpeedTier = model.defaultSpeedTier;
      }
      result.push(normalized);
    }
    return result;
  }

  const api = {
    formatCompactModelLabel,
    getModelCatalog,
    normalizeModelOptionId,
    normalizeReasoningEffortsForSelect,
    normalizeSpeedTiersForSelect,
    speedChoiceVisible,
    retainSelectedModel,
    preserveSelectedCapabilities,
    getRenderedModelEntries,
    shouldUseBuiltInFallback
  };
  return api;
});
