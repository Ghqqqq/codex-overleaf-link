'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FALLBACK_MODELS } = require('../../extension/src/shared/models');
const {
  getPluginCodexHome,
  getUserCodexHome
} = require('./codexHome');

const DEFAULT_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh']);
const DEFAULT_SPEED_TIERS = Object.freeze(['standard']);

function resolveCodexModels(params = {}, env = process.env) {
  const cacheResult = resolveModelsFromCodexCache(params, env);
  if (cacheResult) {
    return cacheResult;
  }

  return {
    models: buildFallbackModels(),
    source: 'fallback',
    fetchedAt: new Date().toISOString()
  };
}

function resolveModelsFromCodexCache(params, env) {
  for (const cachePath of getModelsCacheCandidates(params, env)) {
    const parsed = readModelsCache(cachePath);
    if (!parsed) {
      continue;
    }
    const models = normalizeCacheModels(parsed.value);
    if (!models.length) {
      continue;
    }
    return {
      models,
      source: 'codex-cache',
      fetchedAt: getString(parsed.value?.fetched_at) || getString(parsed.value?.fetchedAt) || new Date().toISOString(),
      clientVersion: getString(parsed.value?.client_version) || getString(parsed.value?.clientVersion) || ''
    };
  }
  return null;
}

function getModelsCacheCandidates(params = {}, env = process.env) {
  const candidates = [];
  const addHome = home => {
    if (!home || typeof home !== 'string') {
      return;
    }
    candidates.push(path.join(path.resolve(home), 'models_cache.json'));
  };

  void params;
  addHome(env.CODEX_HOME);
  addHome(env.CODEX_OVERLEAF_USER_CODEX_HOME);
  addHome(getUserCodexHome({ ...env, CODEX_HOME: '' }));
  addHome(env.CODEX_OVERLEAF_CODEX_HOME);
  addHome(getPluginCodexHome(env));

  const seen = new Set();
  return candidates.filter(cachePath => {
    const normalized = path.resolve(cachePath);
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

function readModelsCache(cachePath) {
  try {
    const stat = fs.statSync(cachePath);
    if (!stat.isFile()) {
      return null;
    }
    return {
      cachePath,
      value: JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    };
  } catch {
    return null;
  }
}

function normalizeCacheModels(cache) {
  const rawModels = getRawModels(cache);
  if (!rawModels.length) {
    return [];
  }

  const models = [];
  const seen = new Set();
  for (const rawModel of rawModels) {
    const model = normalizeCacheModel(rawModel);
    if (!model || seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

function getRawModels(cache) {
  if (Array.isArray(cache)) {
    return cache;
  }
  if (!cache || typeof cache !== 'object') {
    return [];
  }
  if (Array.isArray(cache.models)) {
    return cache.models;
  }
  if (Array.isArray(cache.data)) {
    return cache.data;
  }
  return [];
}

function normalizeCacheModel(rawModel) {
  if (typeof rawModel === 'string') {
    const id = rawModel.trim();
    return id ? buildModelEntry({ id, label: id }) : null;
  }
  if (!rawModel || typeof rawModel !== 'object' || rawModel.visibility === 'hide') {
    return null;
  }

  const id = getString(rawModel.slug)
    || getString(rawModel.id)
    || getString(rawModel.model)
    || getString(rawModel.name);
  if (!id) {
    return null;
  }

  const label = getString(rawModel.display_name)
    || getString(rawModel.displayName)
    || getString(rawModel.label)
    || getString(rawModel.name)
    || id;
  const reasoningEfforts = normalizeReasoningEfforts(
    rawModel.supported_reasoning_levels
      || rawModel.supportedReasoningLevels
      || rawModel.reasoning_efforts
      || rawModel.reasoningEfforts
  );
  const defaultReasoningEffort = getString(rawModel.default_reasoning_level)
    || getString(rawModel.defaultReasoningLevel)
    || getString(rawModel.default_reasoning_effort)
    || getString(rawModel.defaultReasoningEffort);
  const speedTiers = normalizeSpeedTiers(
    rawModel.additional_speed_tiers
      || rawModel.additionalSpeedTiers
      || rawModel.speed_tiers
      || rawModel.speedTiers
  );
  const defaultSpeedTier = getString(rawModel.default_speed_tier)
    || getString(rawModel.defaultSpeedTier);

  return buildModelEntry({
    id,
    label,
    reasoningEfforts,
    defaultReasoningEffort,
    speedTiers,
    defaultSpeedTier
  });
}

function buildModelEntry({
  id,
  label,
  reasoningEfforts = DEFAULT_REASONING_EFFORTS,
  defaultReasoningEffort = 'medium',
  speedTiers = DEFAULT_SPEED_TIERS,
  defaultSpeedTier = 'standard'
}) {
  const normalizedEfforts = normalizeReasoningEfforts(reasoningEfforts);
  const normalizedDefault = normalizeReasoningEffort(defaultReasoningEffort) || 'medium';
  const normalizedSpeedTiers = normalizeSpeedTiers(speedTiers);
  const normalizedDefaultSpeedTier = getString(defaultSpeedTier) || 'standard';
  return {
    id,
    label,
    reasoningEfforts: normalizedEfforts.length ? normalizedEfforts : DEFAULT_REASONING_EFFORTS.slice(),
    defaultReasoningEffort: normalizedDefault,
    speedTiers: normalizedSpeedTiers.length ? normalizedSpeedTiers : DEFAULT_SPEED_TIERS.slice(),
    defaultSpeedTier: normalizedDefaultSpeedTier
  };
}

function normalizeReasoningEfforts(rawEfforts) {
  if (!Array.isArray(rawEfforts)) {
    return [];
  }

  const seen = new Set();
  const result = [];
  for (const rawEffort of rawEfforts) {
    const effort = normalizeReasoningEffort(typeof rawEffort === 'string' ? rawEffort : rawEffort?.effort);
    if (!effort || seen.has(effort)) {
      continue;
    }
    seen.add(effort);
    result.push(effort);
  }
  return result;
}

function normalizeReasoningEffort(rawEffort) {
  return getString(rawEffort);
}

function normalizeSpeedTiers(rawTiers) {
  const tiers = ['standard'];
  if (!Array.isArray(rawTiers)) {
    return tiers;
  }

  for (const rawTier of rawTiers) {
    const tier = getString(typeof rawTier === 'string' ? rawTier : rawTier?.tier || rawTier?.id || rawTier?.name);
    if (tier && tier !== 'standard' && !tiers.includes(tier)) {
      tiers.push(tier);
    }
  }
  return tiers;
}

function buildFallbackModels() {
  return FALLBACK_MODELS.map(model => buildModelEntry({
    id: model.id,
    label: model.label,
    reasoningEfforts: DEFAULT_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium',
    speedTiers: DEFAULT_SPEED_TIERS,
    defaultSpeedTier: 'standard'
  }));
}

function getString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

module.exports = {
  resolveCodexModels
};
