const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const test = require('node:test');

const {
  queryCodexModelsFromAppServer,
  resolveCodexModels
} = require('../native-host/src/codexModels');

function createAppServerSpawn({ pages = [], initializeError = null, closeEarly = false, stdinError = null } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit('close', 0));
      return true;
    };
    child.stdin = new Writable({
      write(chunk, encoding, callback) {
        if (stdinError) {
          callback(new Error(stdinError));
          return;
        }
        const messages = String(chunk).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
        for (const message of messages) {
          calls.push(message);
          if (message.method === 'initialize') {
            if (closeEarly) {
              queueMicrotask(() => child.emit('close', 1));
            } else if (initializeError) {
              queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: message.id, error: { message: initializeError } })}\n`));
            } else {
              queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`));
            }
          }
          if (message.method === 'model/list') {
            const pageIndex = message.params?.cursor ? Number(message.params.cursor) : 0;
            const page = pages[pageIndex] || { data: [], nextCursor: null };
            queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: message.id, result: page })}\n`));
          }
        }
        callback();
      }
    });
    const codexHome = options.env?.CODEX_HOME;
    spawn.lastCall = {
      command,
      args,
      options,
      child,
      calls,
      homeSnapshot: codexHome && fs.existsSync(codexHome)
        ? {
            files: fs.readdirSync(codexHome).sort(),
            config: fs.existsSync(path.join(codexHome, 'config.toml'))
              ? fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')
              : ''
          }
        : null
    };
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

test('queryCodexModelsFromAppServer initializes, paginates, and normalizes model metadata', async () => {
  const spawn = createAppServerSpawn({
    pages: [
      {
        data: [
          {
            id: 'gpt-5.6-sol',
            model: 'gpt-5.6-sol',
            displayName: 'GPT-5.6-Sol',
            hidden: false,
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: 'low' },
              { reasoningEffort: 'high' }
            ],
            defaultReasoningEffort: 'low',
            additionalSpeedTiers: ['fast'],
            defaultServiceTier: null
          },
          {
            id: 'hidden-helper',
            displayName: 'Hidden helper',
            hidden: true
          }
        ],
        nextCursor: '1'
      },
      {
        data: [
          {
            id: 'custom-model',
            displayName: 'Custom Model',
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: 'none' }],
            serviceTiers: [{ id: 'priority', name: 'Fast' }]
          }
        ],
        nextCursor: null
      }
    ]
  });

  const result = await queryCodexModelsFromAppServer({}, {
    CODEX_OVERLEAF_ENV_READY: '1',
    CODEX_OVERLEAF_CODEX_PATH: '/mock/codex',
    CODEX_HOME: '/tmp/plugin-codex-home'
  }, { spawn, prepareCodexHome: false, timeoutMs: 1000 });

  assert.equal(spawn.lastCall.command, '/mock/codex');
  assert.deepEqual(spawn.lastCall.args, ['app-server', '--listen', 'stdio://']);
  assert.equal(spawn.lastCall.options.env.CODEX_HOME, '/tmp/plugin-codex-home');
  assert.deepEqual(spawn.calls.map(message => message.method), [
    'initialize',
    'initialized',
    'model/list',
    'model/list'
  ]);
  assert.equal(spawn.calls[2].params.includeHidden, false);
  assert.deepEqual(result.models, [
    {
      id: 'gpt-5.6-sol',
      label: 'GPT-5.6-Sol',
      reasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'low',
      speedTiers: ['standard', 'fast'],
      defaultSpeedTier: 'standard'
    },
    {
      id: 'custom-model',
      label: 'Custom Model',
      reasoningEfforts: ['none'],
      defaultReasoningEffort: 'none',
      speedTiers: ['standard', 'fast'],
      defaultSpeedTier: 'standard'
    }
  ]);
  assert.equal(spawn.lastCall.child.killed, true);
});

test('model discovery builds a lightweight home without mutating the persistent plugin home', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-model-home-'));
  try {
    const userCodexHome = path.join(home, '.codex');
    fs.mkdirSync(userCodexHome, { recursive: true });
    fs.writeFileSync(path.join(userCodexHome, 'auth.json'), '{"token":"test"}\n', 'utf8');
    fs.writeFileSync(path.join(userCodexHome, 'config.toml'), 'model_catalog_json = "catalog.json"\n', 'utf8');
    fs.writeFileSync(path.join(userCodexHome, 'catalog.json'), '{"models":[]}\n', 'utf8');
    const spawn = createAppServerSpawn({
      pages: [{ data: [{ id: 'isolated-model', displayName: 'Isolated Model' }], nextCursor: null }]
    });

    const result = await queryCodexModelsFromAppServer({}, {
      HOME: home,
      CODEX_OVERLEAF_ENV_READY: '1',
      CODEX_OVERLEAF_CODEX_PATH: '/mock/codex'
    }, { spawn, timeoutMs: 1000 });
    const discoveryHome = spawn.lastCall.options.env.CODEX_HOME;
    const persistentPluginHome = path.join(home, '.codex-overleaf', 'codex-home');

    assert.equal(result.models[0].id, 'isolated-model');
    assert.notEqual(discoveryHome, persistentPluginHome);
    assert.equal(fs.existsSync(discoveryHome), false);
    assert.equal(fs.existsSync(persistentPluginHome), false);
    assert.equal(spawn.lastCall.homeSnapshot.files.includes('model_catalog.json'), true);
    assert.match(
      spawn.lastCall.homeSnapshot.config,
      /^model_catalog_json = "model_catalog\.json"$/m
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('resolveCodexModels returns static fallback models when app-server discovery fails', async () => {
  const spawn = createAppServerSpawn({ initializeError: 'model endpoint unavailable' });

  const result = await resolveCodexModels({}, {
    CODEX_OVERLEAF_ENV_READY: '1',
    CODEX_OVERLEAF_CODEX_PATH: '/mock/codex',
    CODEX_HOME: '/tmp/plugin-codex-home'
  }, { spawn, prepareCodexHome: false, timeoutMs: 1000 });

  assert.equal(result.source, 'fallback');
  assert.equal(result.errorCode, 'codex_model_list_request_failed');
  assert.match(result.errorMessage, /model endpoint unavailable/);
  assert.equal(result.models.some(model => model.id === 'gpt-5.5'), true);
});

test('resolveCodexModels falls back promptly when app-server exits before responding', async () => {
  const spawn = createAppServerSpawn({ closeEarly: true });

  const result = await resolveCodexModels({}, {
    CODEX_OVERLEAF_ENV_READY: '1',
    CODEX_OVERLEAF_CODEX_PATH: '/mock/codex',
    CODEX_HOME: '/tmp/plugin-codex-home'
  }, { spawn, prepareCodexHome: false, timeoutMs: 1000 });

  assert.equal(result.source, 'fallback');
  assert.match(result.errorMessage, /exited before model list completed/i);
});


test('model discovery removes its temporary home when Codex is unavailable', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-no-command-'));
  const before = new Set(
    fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('codex-overleaf-models-'))
  );
  try {
    const result = await resolveCodexModels({}, {
      HOME: home,
      CODEX_OVERLEAF_ENV_READY: '1',
      CODEX_OVERLEAF_CODEX_PATH: ''
    });
    const leaked = fs.readdirSync(os.tmpdir())
      .filter(name => name.startsWith('codex-overleaf-models-') && !before.has(name));

    assert.equal(result.source, 'fallback');
    assert.equal(result.errorCode, 'codex_not_found');
    assert.deepEqual(leaked, []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('resolveCodexModels handles app-server stdin errors without crashing the host', async () => {
  const spawn = createAppServerSpawn({ stdinError: 'broken pipe' });

  const result = await resolveCodexModels({}, {
    CODEX_OVERLEAF_ENV_READY: '1',
    CODEX_OVERLEAF_CODEX_PATH: '/mock/codex',
    CODEX_HOME: '/tmp/plugin-codex-home'
  }, { spawn, prepareCodexHome: false, timeoutMs: 1000 });

  assert.equal(result.source, 'fallback');
  assert.equal(result.errorCode, 'codex_model_list_write_failed');
  assert.match(result.errorMessage, /broken pipe/);
});
