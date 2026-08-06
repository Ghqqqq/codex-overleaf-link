const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resolveCodexModels } = require('../native-host/src/codexModels');

function withTempHome(callback) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-models-'));
  try {
    return callback(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('resolveCodexModels preserves distinct Codex max and ultra reasoning tiers', () => {
  withTempHome(home => {
    const codexHome = path.join(home, '.codex');
    writeJson(path.join(codexHome, 'models_cache.json'), {
      models: [{
        slug: 'gpt-test',
        display_name: 'GPT Test',
        default_reasoning_level: 'max',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' }]
      }]
    });

    const result = resolveCodexModels({}, { HOME: home });
    assert.deepEqual(result.models[0].reasoningEfforts, ['low', 'xhigh', 'max', 'ultra']);
    assert.equal(result.models[0].defaultReasoningEffort, 'max');
  });
});

test('resolveCodexModels reads the Codex models cache before fallback models', () => {
  withTempHome(home => {
    const codexHome = path.join(home, '.codex');
    writeJson(path.join(codexHome, 'models_cache.json'), {
      fetched_at: '2026-05-05T06:44:19.541424Z',
      client_version: '0.128.0',
      models: [
        {
          slug: 'gpt-local-first',
          display_name: 'GPT Local First',
          default_reasoning_level: 'high',
          supported_reasoning_levels: [
            { effort: 'low' },
            { effort: 'high' },
            { effort: 'xhigh' }
          ],
          additional_speed_tiers: ['fast'],
          visibility: 'list'
        },
        {
          slug: 'hidden-helper',
          display_name: 'Hidden Helper',
          visibility: 'hide'
        },
        {
          slug: 'gpt-local-first',
          display_name: 'Duplicate',
          visibility: 'list'
        }
      ]
    });

    const result = resolveCodexModels({}, { HOME: home });

    assert.equal(result.source, 'codex-cache');
    assert.equal(result.fetchedAt, '2026-05-05T06:44:19.541424Z');
    assert.equal(result.clientVersion, '0.128.0');
    assert.deepEqual(result.models, [
      {
        id: 'gpt-local-first',
        label: 'GPT Local First',
        reasoningEfforts: ['low', 'high', 'xhigh'],
        defaultReasoningEffort: 'high',
        speedTiers: ['standard', 'fast'],
        defaultSpeedTier: 'standard'
      }
    ]);
  });
});

test('resolveCodexModels prefers the explicit CODEX_HOME models cache', () => {
  withTempHome(home => {
    const userCodexHome = path.join(home, '.codex');
    const explicitCodexHome = path.join(home, 'custom-codex-home');
    writeJson(path.join(userCodexHome, 'models_cache.json'), {
      models: [{ slug: 'user-model', display_name: 'User Model', visibility: 'list' }]
    });
    writeJson(path.join(explicitCodexHome, 'models_cache.json'), {
      models: [{ id: 'explicit-model', label: 'Explicit Model' }]
    });

    const result = resolveCodexModels({}, {
      HOME: home,
      CODEX_HOME: explicitCodexHome
    });

    assert.equal(result.source, 'codex-cache');
    assert.deepEqual(result.models.map(model => model.id), ['explicit-model']);
  });
});

test('resolveCodexModels falls back when Codex caches are missing or unusable', () => {
  withTempHome(home => {
    const codexHome = path.join(home, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'models_cache.json'), '{not-json', 'utf8');

    const result = resolveCodexModels({}, { HOME: home });

    assert.equal(result.source, 'fallback');
    assert.equal(result.models.some(model => model.id === 'gpt-5.5'), true);
    assert.equal(result.models.every(model => Array.isArray(model.reasoningEfforts)), true);
    assert.equal(result.models.every(model => model.defaultReasoningEffort === 'medium'), true);
    assert.equal(result.models.every(model => Array.isArray(model.speedTiers)), true);
    assert.equal(result.models.every(model => model.defaultSpeedTier === 'standard'), true);
  });
});
