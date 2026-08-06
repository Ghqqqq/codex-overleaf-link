const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FALLBACK_MODELS,
  normalizeDiscoveredModels
} = require('../extension/src/shared/models');

const FALLBACK_IDS = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.2'
];

test('fallback model ids keep the v0.1.1 UI order', () => {
  assert.deepEqual(FALLBACK_MODELS.map(model => model.id), FALLBACK_IDS);
  assert.deepEqual(FALLBACK_MODELS.map(model => model.label), [
    'GPT-5.5',
    'GPT-5.4',
    'GPT-5.4 Mini',
    'GPT-5.3 Codex',
    'GPT-5.3 Codex Spark',
    'GPT-5.2'
  ]);
});

test('fallback normalization returns a copy that callers cannot use to mutate the global fallback', () => {
  const first = normalizeDiscoveredModels({ models: [] });
  first.models[0].id = 'mutated';
  first.models.push({ id: 'new-model', label: 'New Model' });

  const second = normalizeDiscoveredModels({ models: [] });

  assert.equal(first.usedFallback, true);
  assert.equal(second.usedFallback, true);
  assert.deepEqual(second.models.map(model => model.id), FALLBACK_IDS);
  assert.deepEqual(FALLBACK_MODELS.map(model => model.id), FALLBACK_IDS);
});

test('normalize preserves selected custom models as unverified', () => {
  const result = normalizeDiscoveredModels({
    models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
    selectedModel: '  custom-model  '
  });

  assert.equal(result.usedFallback, false);
  assert.deepEqual(result.models, [
    {
      id: 'gpt-5.5',
      label: 'GPT-5.5',
      reasoningEfforts: [],
      reasoningPresentation: '',
      speedTiers: ['standard']
    },
    {
      id: 'custom-model',
      label: 'custom-model (custom)',
      unverified: true
    }
  ]);
});

test('normalize trims ids, dedupes by id, and keeps reasoning metadata', () => {
  const result = normalizeDiscoveredModels({
    models: [
      {
        id: '  gpt-5.5  ',
        label: ' Latest ',
        defaultReasoningEffort: 'high',
        reasoningEfforts: ['medium', 'high'],
        speedTiers: ['standard', 'fast'],
        defaultSpeedTier: 'standard'
      },
      {
        id: 'gpt-5.5',
        label: 'Duplicate',
        defaultReasoningEffort: 'xhigh',
        reasoningEfforts: ['xhigh']
      },
      {
        id: 'gpt-5.4-mini',
        reasoningEfforts: 'high'
      },
      {
        id: '   ',
        label: 'Empty'
      },
      null
    ],
    selectedModel: 'gpt-5.5'
  });

  assert.equal(result.usedFallback, false);
  assert.deepEqual(result.models, [
    {
      id: 'gpt-5.5',
      label: ' Latest ',
      defaultReasoningEffort: 'high',
      reasoningEfforts: ['medium', 'high'],
      reasoningPresentation: '',
      speedTiers: ['standard', 'fast'],
      defaultSpeedTier: 'standard'
    },
    {
      id: 'gpt-5.4-mini',
      label: 'gpt-5.4-mini',
      reasoningEfforts: [],
      reasoningPresentation: '',
      speedTiers: ['standard']
    }
  ]);
});

test('normalize preserves distinct Codex max and ultra reasoning tiers', () => {
  const result = normalizeDiscoveredModels({
    models: [{
      id: 'gpt-max-default',
      label: 'GPT Max Default',
      defaultReasoningEffort: 'max',
      reasoningEfforts: ['low', 'xhigh', 'max', 'ultra']
    }]
  });

  assert.deepEqual(result.models[0].reasoningEfforts, ['low', 'xhigh', 'max', 'ultra']);
  assert.equal(result.models[0].defaultReasoningEffort, 'max');
});
