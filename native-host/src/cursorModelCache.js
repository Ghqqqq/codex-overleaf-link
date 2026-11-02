'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FILE_NAME = 'cursor-model-cache.json';

function cachePath(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, '.codex-overleaf', FILE_NAME);
}

function readCursorModelCache(env = process.env) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(env), 'utf8'));
    const models = Array.isArray(parsed?.models) ? parsed.models.map(normalizeModel).filter(Boolean) : [];
    return {
      models,
      fetchedAt: typeof parsed?.fetchedAt === 'string' ? parsed.fetchedAt : '',
      customized: parsed?.customized === true
    };
  } catch (_error) {
    return { models: [], fetchedAt: '', customized: false };
  }
}

function writeCursorModelCache(models, env = process.env, options = {}) {
  const filePath = cachePath(env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const body = {
    fetchedAt: new Date().toISOString(),
    customized: options.customized === true,
    models: models.map(normalizeModel).filter(Boolean)
  };
  fs.writeFileSync(filePath, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
  return body;
}

function mergeCursorModels(discovered, env = process.env) {
  const cache = readCursorModelCache(env);
  const previous = new Map(cache.models.map(model => [model.id, model.enabled]));
  const models = [];
  const seen = new Set();
  let index = 0;
  for (const model of discovered || []) {
    const normalized = normalizeModel(model);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    const enabled = cache.customized && previous.has(normalized.id)
      ? previous.get(normalized.id)
      : index < 5;
    index += 1;
    models.push({ ...normalized, enabled });
  }
  return writeCursorModelCache(models, env, { customized: cache.customized });
}

function setAllCursorModelsEnabled(enabled, env = process.env) {
  const cache = readCursorModelCache(env);
  return writeCursorModelCache(cache.models.map(model => ({ ...model, enabled: enabled === true })), env, { customized: true });
}

function setCursorModelEnabled(params = {}, env = process.env) {
  const id = clean(params.id);
  const cache = readCursorModelCache(env);
  const models = cache.models.map(model => model.id === id ? { ...model, enabled: params.enabled === true } : model);
  return writeCursorModelCache(models, env, { customized: true });
}

function enabledCursorModels(env = process.env) {
  const cache = readCursorModelCache(env);
  const models = cache.models.filter(model => model.enabled);
  return {
    providerId: 'builtin',
    providerRevision: 0,
    providerName: 'Cursor',
    source: 'cursor-cache',
    fetchedAt: cache.fetchedAt,
    defaultModelId: models[0]?.id || '',
    models: models.map(model => ({
      id: model.id,
      label: model.label,
      reasoningEfforts: model.reasoningEfforts,
      reasoningPresentation: model.reasoningPresentation,
      defaultReasoningEffort: model.defaultReasoningEffort,
      speedTiers: model.speedTiers,
      defaultSpeedTier: model.defaultSpeedTier
    }))
  };
}

function normalizeModel(model) {
  const id = clean(model?.id || model);
  if (!id || id === 'auto') return null;
  const reasoningEfforts = Array.isArray(model?.reasoningEfforts)
    ? model.reasoningEfforts.map(value => clean(value).toLowerCase()).filter(Boolean)
    : [];
  const speedTiers = Array.isArray(model?.speedTiers)
    ? model.speedTiers.map(value => clean(value).toLowerCase()).filter(Boolean)
    : ['standard'];
  return {
    id: id.slice(0, 80),
    label: clean(model?.label || model?.displayName || model?.name || id).slice(0, 80) || id.slice(0, 80),
    enabled: model?.enabled !== false,
    capabilitiesKnown: model?.capabilitiesKnown === true,
    reasoningParamId: clean(model?.reasoningParamId).slice(0, 80),
    reasoningEfforts,
    reasoningPresentation: reasoningEfforts.length ? 'effort' : 'none',
    defaultReasoningEffort: clean(model?.defaultReasoningEffort).toLowerCase().slice(0, 20),
    fastParamId: clean(model?.fastParamId).slice(0, 80),
    maxModeWhenFast: model?.maxModeWhenFast === true,
    speedTiers: speedTiers.length ? speedTiers : ['standard'],
    defaultSpeedTier: speedTiers.includes('standard') ? 'standard' : (speedTiers[0] || 'standard'),
    contextWindow: Number.isFinite(Number(model?.contextWindow)) && Number(model.contextWindow) > 0
      ? Number(model.contextWindow)
      : null
  };
}

function cursorCatalogNeedsCapabilityRefresh(env = process.env) {
  const cache = readCursorModelCache(env);
  return cache.models.some(model => model.capabilitiesKnown !== true);
}

function findCachedCursorModel(modelId, env = process.env) {
  const id = clean(modelId);
  if (!id) return null;
  return readCursorModelCache(env).models.find(model => model.id === id) || null;
}

function clean(value) {
  return String(value || '').trim();
}

module.exports = {
  cursorCatalogNeedsCapabilityRefresh,
  enabledCursorModels,
  findCachedCursorModel,
  mergeCursorModels,
  readCursorModelCache,
  setAllCursorModelsEnabled,
  setCursorModelEnabled
};
