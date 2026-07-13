'use strict';

const { spawn: defaultSpawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const packageJson = require('../../package.json');
const { FALLBACK_MODELS } = require('../../extension/src/shared/models');
const { resolveCodexCommand, shouldUseShellForCommand } = require('./codexCommand');
const { copyCodexConfigurationSnapshot, getUserCodexHome } = require('./codexHome');

const DEFAULT_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh']);
const DEFAULT_SPEED_TIERS = Object.freeze(['standard']);
const DEFAULT_MODEL_LIST_TIMEOUT_MS = 5000;
const MODEL_LIST_PAGE_SIZE = 100;
const MAX_MODEL_LIST_PAGES = 100;
const MAX_STDERR_BYTES = 16 * 1024;

async function resolveCodexModels(params = {}, env = process.env, options = {}) {
  try {
    const result = await queryCodexModelsFromAppServer(params, env, options);
    if (!result.models.length) {
      throw new Error('Codex app-server returned an empty model list');
    }
    return result;
  } catch (error) {
    return {
      models: buildFallbackModels(),
      source: 'fallback',
      fetchedAt: new Date().toISOString(),
      errorCode: error?.code || 'codex_model_list_failed',
      errorMessage: error?.message || String(error)
    };
  }
}

function queryCodexModelsFromAppServer(params = {}, env = process.env, options = {}) {
  const prepared = options.prepareCodexHome === false
    ? { env: { ...env }, cleanup: () => {} }
    : prepareModelDiscoveryEnv(params, env);
  const childEnv = prepared.env;
  const codexCommand = resolveCodexCommand(childEnv);
  if (!codexCommand) {
    prepared.cleanup();
    return Promise.reject(createModelListError(
      'codex_not_found',
      'Codex CLI was not found. Install Codex or make sure the `codex` command is available in your login shell.'
    ));
  }

  const spawn = options.spawn || defaultSpawn;
  const timeoutMs = normalizePositiveInteger(
    options.timeoutMs ?? childEnv.CODEX_OVERLEAF_MODEL_LIST_TIMEOUT_MS,
    DEFAULT_MODEL_LIST_TIMEOUT_MS
  );

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(codexCommand, ['app-server', '--listen', 'stdio://'], {
        env: childEnv,
        shell: shouldUseShellForCommand(codexCommand, childEnv),
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      prepared.cleanup();
      reject(createModelListError('codex_model_list_spawn_failed', error.message || String(error)));
      return;
    }

    const pending = new Map();
    let nextId = 1;
    let stdoutBuffer = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      fail(createModelListError(
        'codex_model_list_timeout',
        `Codex app-server did not return a model list within ${timeoutMs}ms`
      ));
    }, timeoutMs);
    timer.unref?.();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) {
          handleMessage(line);
        }
      }
    });
    child.stderr.on('data', chunk => {
      stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
    });
    child.stdin.on('error', error => {
      fail(createModelListError('codex_model_list_write_failed', error.message || String(error)));
    });
    child.on('error', error => {
      fail(createModelListError('codex_model_list_spawn_failed', error.message || String(error)));
    });
    child.on('close', code => {
      if (!settled) {
        const detail = stderr.trim();
        fail(createModelListError(
          'codex_model_list_exited',
          detail || `Codex app-server exited before model list completed with code ${code}`
        ));
      }
    });

    start().catch(fail);

    async function start() {
      await request('initialize', {
        clientInfo: {
          name: 'codex-overleaf-link',
          version: packageJson.version
        },
        capabilities: null
      });
      notify('initialized', {});

      const rawModels = [];
      const seenCursors = new Set();
      let cursor = null;
      for (let page = 0; page < MAX_MODEL_LIST_PAGES; page += 1) {
        const response = await request('model/list', {
          limit: MODEL_LIST_PAGE_SIZE,
          cursor,
          includeHidden: false
        });
        if (Array.isArray(response?.data)) {
          rawModels.push(...response.data);
        }
        const nextCursor = getString(response?.nextCursor);
        if (!nextCursor) {
          succeed(rawModels);
          return;
        }
        if (seenCursors.has(nextCursor)) {
          throw createModelListError('codex_model_list_pagination_loop', 'Codex app-server repeated a model list cursor');
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      throw createModelListError('codex_model_list_page_limit', 'Codex app-server model list exceeded the page limit');
    }

    function request(method, requestParams) {
      const id = nextId++;
      return new Promise((resolveRequest, rejectRequest) => {
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        writeMessage({ id, method, params: requestParams });
      });
    }

    function notify(method, notifyParams) {
      writeMessage({ method, params: notifyParams });
    }

    function writeMessage(message) {
      if (settled) {
        return;
      }
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        fail(createModelListError('codex_model_list_write_failed', error.message || String(error)));
      }
    }

    function handleMessage(line) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(message, 'id')) {
        return;
      }
      const pendingRequest = pending.get(message.id);
      if (!pendingRequest) {
        return;
      }
      pending.delete(message.id);
      if (message.error) {
        pendingRequest.reject(createModelListError(
          'codex_model_list_request_failed',
          message.error.message || JSON.stringify(message.error)
        ));
        return;
      }
      pendingRequest.resolve(message.result);
    }

    function succeed(rawModels) {
      const models = normalizeAppServerModels(rawModels);
      settled = true;
      cleanup();
      resolve({
        models,
        source: 'codex-app-server',
        fetchedAt: new Date().toISOString()
      });
    }

    function fail(error) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      for (const pendingRequest of pending.values()) {
        pendingRequest.reject(error);
      }
      pending.clear();
      reject(error);
    }

    function cleanup() {
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {
        // The stream may already be closed.
      }
      try {
        child.kill();
      } catch {
        // The process may already have exited.
      }
      prepared.cleanup();
    }
  });
}

function prepareModelDiscoveryEnv(params = {}, env = process.env) {
  const userHome = getUserCodexHome(env);
  const discoveryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-models-'));
  try {
    copyCodexConfigurationSnapshot({
      userHome,
      targetHome: discoveryHome,
      loadCodexLocalSkills: params.loadCodexLocalSkills !== false
    });
  } catch (error) {
    fs.rmSync(discoveryHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    throw error;
  }
  return {
    env: {
      ...env,
      CODEX_HOME: discoveryHome,
      CODEX_OVERLEAF_CODEX_HOME: discoveryHome,
      CODEX_OVERLEAF_USER_CODEX_HOME: userHome
    },
    cleanup() {
      try {
        fs.rmSync(discoveryHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // Best effort after bounded retries, mainly for delayed Windows handle release.
      }
    }
  };
}

function chmodIfPossible(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Best effort for filesystems without POSIX permissions.
  }
}

function normalizeAppServerModels(rawModels) {
  const models = [];
  const seen = new Set();
  for (const rawModel of Array.isArray(rawModels) ? rawModels : []) {
    if (!rawModel || typeof rawModel !== 'object' || rawModel.hidden === true) {
      continue;
    }
    const id = getString(rawModel.id) || getString(rawModel.model);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const reasoningEfforts = normalizeReasoningEfforts(rawModel.supportedReasoningEfforts);
    const speedTiers = normalizeAppServerSpeedTiers(rawModel);
    models.push(buildModelEntry({
      id,
      label: getString(rawModel.displayName) || id,
      reasoningEfforts,
      defaultReasoningEffort: getString(rawModel.defaultReasoningEffort) || reasoningEfforts[0] || 'medium',
      speedTiers,
      defaultSpeedTier: normalizeDefaultSpeedTier(rawModel, speedTiers)
    }));
  }
  return models;
}

function normalizeAppServerSpeedTiers(rawModel) {
  const tiers = normalizeSpeedTiers(rawModel.additionalSpeedTiers);
  for (const serviceTier of Array.isArray(rawModel.serviceTiers) ? rawModel.serviceTiers : []) {
    const id = getString(serviceTier?.id);
    const name = getString(serviceTier?.name);
    if ((id === 'fast' || id === 'priority' || /^fast$/i.test(name)) && !tiers.includes('fast')) {
      tiers.push('fast');
    }
  }
  return tiers;
}

function normalizeDefaultSpeedTier(rawModel, speedTiers) {
  const defaultTier = getString(rawModel.defaultServiceTier?.id || rawModel.defaultServiceTier);
  return speedTiers.includes('fast') && (defaultTier === 'fast' || defaultTier === 'priority')
    ? 'fast'
    : 'standard';
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
  const normalizedSpeedTiers = normalizeSpeedTiers(speedTiers);
  return {
    id,
    label,
    reasoningEfforts: normalizedEfforts.length ? normalizedEfforts : DEFAULT_REASONING_EFFORTS.slice(),
    defaultReasoningEffort: getString(defaultReasoningEffort) || 'medium',
    speedTiers: normalizedSpeedTiers.length ? normalizedSpeedTiers : DEFAULT_SPEED_TIERS.slice(),
    defaultSpeedTier: getString(defaultSpeedTier) || 'standard'
  };
}

function normalizeReasoningEfforts(rawEfforts) {
  if (!Array.isArray(rawEfforts)) {
    return [];
  }
  const result = [];
  for (const rawEffort of rawEfforts) {
    const effort = getString(
      typeof rawEffort === 'string'
        ? rawEffort
        : rawEffort?.reasoningEffort || rawEffort?.effort
    );
    if (effort && !result.includes(effort)) {
      result.push(effort);
    }
  }
  return result;
}

function normalizeSpeedTiers(rawTiers) {
  const tiers = ['standard'];
  if (!Array.isArray(rawTiers)) {
    return tiers;
  }
  for (const rawTier of rawTiers) {
    const tier = getString(typeof rawTier === 'string' ? rawTier : rawTier?.id || rawTier?.name);
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

function createModelListError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function getString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

module.exports = {
  normalizeAppServerModels,
  queryCodexModelsFromAppServer,
  resolveCodexModels
};
