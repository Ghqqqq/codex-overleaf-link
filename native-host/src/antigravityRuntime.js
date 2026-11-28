'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fileURLToPath } = require('node:url');
const { isDeepStrictEqual } = require('node:util');
const { version: PACKAGE_VERSION } = require('../../package.json');
const { AntigravityAcpClient } = require('./antigravityAcpClient');
const { runOwnedNativeHelper } = require('./nativeHelperLifecycle');
const { getHomeDir } = require('./nativeHostPlatform');
const { resolveAntigravityExecutable } = require('./nativeEnvironment');
const { sanitizeProviderMessage } = require('./providerRedaction');
const { isContextLimitError } = require('./providerContextError');
const {
  createCodexIdleWatchdog,
  createOptionalTimeout,
  getAbortReason,
  parseOptionalPositiveInteger,
  stopCodexAppServer,
  throwIfAborted
} = require('./codexSessionTiming');

const ANTIGRAVITY_PROVIDER_ID = 'antigravity';
const ANTIGRAVITY_PROVIDER_NAME = 'Antigravity';
const ANTIGRAVITY_THREAD_PREFIX = 'agy:';
const ANTIGRAVITY_DEFAULT_MODEL = 'gemini-4-neon';
const ANTIGRAVITY_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const ANTIGRAVITY_STATUS_TIMEOUT_MS = 20000;
const ANTIGRAVITY_VERSION_PROBE_TIMEOUT_MS = 2000;
const ANTIGRAVITY_CANCEL_GRACE_MS = 1500;
const MAX_PERMISSION_CONTINUATIONS = 2;
const MAX_TURN_TEXT_BYTES = 1024 * 1024;
const MAX_TRACKED_TOOLS = 256;
const MAX_TOOL_INPUT_BYTES = 64 * 1024;
const MAX_TOOL_LOCATIONS = 64;
const MAX_TOOL_OUTPUT_CHARS = 4096;
const EFFORT_ORDER = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

const WRITE_TOOL_KINDS = new Set(['edit', 'delete', 'move']);
const FORBIDDEN_WORKSPACE_DIRS = new Set([
  '.codex-overleaf-attachments',
  '.codex-overleaf-subagents',
  '.git'
]);
const PATH_FIELD_KEYS = new Set([
  'path', 'paths', 'absolutepath', 'relativepath',
  'target', 'targets', 'targetfile', 'targetpath',
  'file', 'files', 'filepath', 'filepaths', 'filename', 'filenames',
  'src', 'source', 'sources', 'sourcepath', 'sourcefile',
  'dst', 'dest', 'destination', 'destinations', 'destpath', 'destinationpath', 'destfile',
  'oldpath', 'newpath', 'oldfile', 'newfile',
  'from', 'to', 'origin',
  'directory', 'directories', 'directorypath', 'dir', 'dirs', 'dirpath', 'folder', 'folders',
  'searchpath', 'searchdirectory', 'outputpath', 'inputpath', 'outputfile', 'inputfile',
  'uri', 'uris', 'location', 'locations'
]);
const PATH_FIELD_TOKENS = new Set([
  'path', 'paths', 'filepath', 'filepaths', 'file', 'files', 'filename', 'filenames',
  'dir', 'dirs', 'directory', 'directories', 'folder', 'folders',
  'dest', 'destination', 'dst', 'src', 'uri', 'uris'
]);
const CWD_FIELD_KEYS = new Set(['cwd', 'cwds', 'workingdirectory', 'workdir', 'currentworkingdirectory']);
const COMMAND_FIELD_KEYS = new Set(['commandline', 'command', 'cmd', 'script', 'shellcommand']);

const PASSTHROUGH_MAPPED_CODES = new Set([
  'antigravity_not_found',
  'antigravity_unsupported_operation',
  'antigravity_mode_unavailable',
  'antigravity_models_unavailable',
  'antigravity_protocol_unsupported',
  'antigravity_session_invalid',
  'provider_model_not_found',
  'provider_model_not_configured',
  'thread_resume_failed'
]);

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function isAntigravityThreadId(value) {
  const trimmed = String(value || '').trim();
  return trimmed.startsWith(ANTIGRAVITY_THREAD_PREFIX) && trimmed.length > ANTIGRAVITY_THREAD_PREFIX.length;
}

function stripAntigravityThreadPrefix(value) {
  const trimmed = String(value || '').trim();
  return isAntigravityThreadId(trimmed) ? trimmed.slice(ANTIGRAVITY_THREAD_PREFIX.length).trim() : '';
}

function formatAntigravityThreadId(sessionId) {
  const clean = String(sessionId || '').trim();
  return clean ? `${ANTIGRAVITY_THREAD_PREFIX}${clean}` : '';
}

function resolveAntigravityGeminiDir(env = process.env) {
  const explicit = String(env.CODEX_OVERLEAF_ANTIGRAVITY_HOME || '').trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.resolve(getHomeDir({ env }), '.codex-overleaf', 'antigravity', 'gemini');
}

function extractRpcDataText(rpcData) {
  if (!rpcData) return '';
  if (typeof rpcData === 'string') return rpcData;
  if (typeof rpcData !== 'object') return '';
  return [
    rpcData.code,
    rpcData.reason,
    rpcData.status,
    rpcData.error,
    rpcData.message,
    rpcData.details
  ]
    .filter(part => typeof part === 'string' && part.trim())
    .join(' ');
}

function isAntigravityAuthError(error) {
  if (!error) return false;
  if (error.code === 'antigravity_auth_required') return true;
  const rpcData = error.rpcData ?? error.data;
  if (rpcData && typeof rpcData === 'object') {
    if (rpcData.authRequired === true) return true;
    if (Array.isArray(rpcData.authMethods) && rpcData.authMethods.length > 0) return true;
  }
  const message = String(error.message || '');
  const combined = `${message} ${extractRpcDataText(rpcData)}`.trim();
  if (!combined) return false;
  const looksLikeSessionLookupError = /\bsession\b/i.test(combined)
    && /\b(?:not found|unknown|invalid|missing|expired)\b/i.test(combined)
    && !/auth(?:entication)?|unauthenticated|sign[- ]in|login|oauth/i.test(combined);
  if (looksLikeSessionLookupError) {
    return false;
  }
  return /authentication required|auth(?:entication)?[_\s-]?required|not signed in|sign[- ]in required|login required|unauthenticated|oauth[_\s-]?(?:required|expired|invalid)|invalid[_\s-]credentials/i.test(combined);
}

function isAntigravityRateLimitError(error) {
  if (!error) return false;
  if (error.code === 'antigravity_rate_limited') return true;
  const rpcData = error.rpcData ?? error.data;
  const numericStatus = Number(rpcData?.status ?? rpcData?.httpStatus ?? rpcData?.statusCode ?? error.status);
  if (numericStatus === 429) return true;
  const combined = `${String(error.message || '')} ${extractRpcDataText(rpcData)}`.trim();
  if (!combined) return false;
  return /\b(?:resource_exhausted|rate[_\s-]?limit(?:ed|[_\s-]?exceeded)?|too[_\s-]?many[_\s-]?requests|quota[_\s-]?exceeded|insufficient[_\s-]?quota)\b/i.test(combined)
    || /(?:rate|quota)\s+limit/i.test(combined)
    || /\b429\b[\s\S]{0,80}\b(?:rate|quota|exhausted|too many)\b/i.test(combined);
}

function mapAntigravityError(error, fallbackCode = 'antigravity_failed') {
  if (!error) return codedError(fallbackCode, 'Antigravity request failed.');
  if (error.code === 'codex_cancelled' || error.code === 'codex_process_stop_unconfirmed') {
    return error;
  }
  const safeMessage = sanitizeProviderMessage(error.message || 'Antigravity request failed.');
  const rpcData = error.rpcData ?? error.data;
  if (isContextLimitError(error) || isContextLimitError(rpcData)) {
    return codedError(
      'codex_context_limit',
      sanitizeProviderMessage(error.message || 'Antigravity context window limit exceeded.'),
      { cause: error }
    );
  }
  if (isAntigravityRateLimitError(error)) {
    return codedError(
      'antigravity_rate_limited',
      sanitizeProviderMessage(error.message || 'Antigravity rate limit or quota exceeded. Wait briefly and retry.'),
      { cause: error }
    );
  }
  if (isAntigravityAuthError(error)) {
    return codedError(
      'antigravity_auth_required',
      'Antigravity authentication is required. Sign in with Google in Provider settings and retry.',
      { cause: error }
    );
  }
  if (PASSTHROUGH_MAPPED_CODES.has(error.code)) {
    return codedError(error.code, safeMessage, { cause: error });
  }
  const targetCode = error.code && error.code !== 'ACP_RPC_ERROR' ? error.code : fallbackCode;
  return codedError(targetCode, safeMessage, { cause: error });
}

function normalizeTier(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!name && !id) return null;
  return { name, id };
}

function buildVersionProbeSpawnSpec(executable, env = process.env) {
  const platform = env.CODEX_OVERLEAF_PLATFORM || process.platform;
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(String(executable || ''))) {
    const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.windir || env.WINDIR;
    const comspec = systemRoot && path.win32.isAbsolute(systemRoot)
      ? path.win32.join(systemRoot, 'System32', 'cmd.exe')
      : (env.ComSpec || 'cmd.exe');
    const quoteCmd = value => `"${String(value).replace(/"/g, '""')}"`;
    return {
      command: comspec,
      args: ['/d', '/s', '/c', `"${quoteCmd(executable)} --version"`],
      windowsVerbatimArguments: true
    };
  }
  return {
    command: executable,
    args: ['--version'],
    windowsVerbatimArguments: false
  };
}

function shouldSkipCliVersionProbe(error, signal) {
  if (signal?.aborted) return true;
  const code = error?.code;
  return code === 'antigravity_not_found'
    || code === 'ACP_SPAWN_FAILED'
    || code === 'ACP_REQUEST_TIMEOUT'
    || code === 'codex_cancelled';
}

async function probeAntigravityCliVersion(executable, env = process.env, { signal = null, timeoutMs = ANTIGRAVITY_VERSION_PROBE_TIMEOUT_MS } = {}) {
  if (!executable || signal?.aborted) return null;
  const spec = buildVersionProbeSpawnSpec(executable, env);
  const processGroup = process.platform !== 'win32';
  let child;
  try {
    child = spawn(spec.command, spec.args, {
      env,
      shell: false,
      detached: processGroup,
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (_error) {
    return null;
  }

  let output = '';
  const appendChunk = chunk => {
    if (output.length < 16 * 1024) {
      output += String(chunk || '').slice(0, 16 * 1024 - output.length);
    }
  };
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', appendChunk);
  child.stderr?.on('data', appendChunk);

  let timedOut = false;
  let timer = null;
  const onAbort = () => {
    timedOut = true;
    void stopCodexAppServer(child, { processGroup, terminateTimeoutMs: 200, forceTimeoutMs: 500 }).catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const completed = await Promise.race([
      new Promise(resolve => {
        child.once('error', () => resolve(false));
        child.once('close', () => resolve(true));
      }),
      new Promise(resolve => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(false);
        }, timeoutMs);
      })
    ]);
    if (!completed || timedOut || signal?.aborted) {
      await stopCodexAppServer(child, { processGroup, terminateTimeoutMs: 200, forceTimeoutMs: 500 }).catch(() => {});
      return null;
    }
    const match = output.trim().match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
    return match ? match[1] : null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function initializeAcpClient(client, signal, timeoutMs) {
  const result = await client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: {
      name: 'codex-overleaf-link',
      title: 'Codex Overleaf Link',
      version: PACKAGE_VERSION
    }
  }, { signal, ...(timeoutMs ? { timeoutMs } : {}) });
  if (result?.protocolVersion !== 1) {
    throw codedError(
      'antigravity_protocol_unsupported',
      `Antigravity negotiated unsupported ACP protocol version ${String(result?.protocolVersion ?? 'unknown')}.`
    );
  }
  return result;
}

async function closeProbeSessionIfSupported(client, initResult, sessionId) {
  if (!client || !sessionId) return;
  if (!initResult?.agentCapabilities?.sessionCapabilities?.close) return;
  try {
    await client.request('session/close', { sessionId }, { timeoutMs: 2000 });
  } catch (_error) {
    // Best-effort probe session cleanup before closing transport.
  }
}

function withTempProbeDir(callback) {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-agy-probe-'));
  return Promise.resolve()
    .then(() => callback(probeDir))
    .finally(() => {
      try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch (_error) {}
    });
}

async function getAntigravityStatus(_params = {}, env = process.env) {
  const executable = resolveAntigravityExecutable(env);
  if (!executable) {
    return {
      installed: false,
      executable: null,
      version: null,
      signedIn: null,
      tier: null,
      error: {
        code: 'antigravity_not_found',
        message: 'Antigravity CLI (`agy`) was not found.'
      }
    };
  }

  const geminiDir = resolveAntigravityGeminiDir(env);
  const timeoutMs = parseOptionalPositiveInteger(env.CODEX_OVERLEAF_ANTIGRAVITY_STATUS_TIMEOUT_MS) || ANTIGRAVITY_STATUS_TIMEOUT_MS;
  return runOwnedNativeHelper(signal => withTempProbeDir(async probeDir => {
    let client = null;
    let version = null;
    try {
      client = new AntigravityAcpClient(executable, {
        cwd: probeDir,
        geminiDir,
        env,
        timeoutMs
      });
      const initResult = await initializeAcpClient(client, signal, timeoutMs);
      version = (typeof initResult?.agentInfo?.version === 'string' && initResult.agentInfo.version.trim())
        || await probeAntigravityCliVersion(executable, env, { signal })
        || null;
      const sessionResult = await client.request('session/new', {
        cwd: probeDir,
        mcpServers: []
      }, { signal, timeoutMs });
      const tier = normalizeTier(sessionResult?._meta?.antigravity?.tier);
      await closeProbeSessionIfSupported(client, initResult, sessionResult?.sessionId);
      return {
        installed: true,
        executable,
        version,
        signedIn: true,
        tier,
        error: null
      };
    } catch (error) {
      if (!version && !shouldSkipCliVersionProbe(error, signal)) {
        version = await probeAntigravityCliVersion(executable, env, { signal });
      }
      if (isAntigravityAuthError(error)) {
        return {
          installed: true,
          executable,
          version,
          signedIn: false,
          tier: null,
          error: {
            code: 'antigravity_auth_required',
            message: 'Sign in with Google to use Antigravity.'
          }
        };
      }
      return {
        installed: true,
        executable,
        version,
        signedIn: null,
        tier: null,
        error: {
          code: error?.code === 'antigravity_not_found' ? 'antigravity_not_found' : 'antigravity_status_failed',
          message: sanitizeProviderMessage(error?.message || 'Could not check Antigravity status.')
        }
      };
    } finally {
      if (client) {
        await client.close().catch(() => {});
      }
    }
  }));
}

async function loginAntigravity(_params = {}, env = process.env) {
  const executable = resolveAntigravityExecutable(env);
  if (!executable) {
    return {
      installed: false,
      executable: null,
      version: null,
      signedIn: null,
      tier: null,
      error: {
        code: 'antigravity_not_found',
        message: 'Antigravity CLI (`agy`) was not found.'
      }
    };
  }

  const geminiDir = resolveAntigravityGeminiDir(env);
  const loginTimeoutMs = parseOptionalPositiveInteger(env.CODEX_OVERLEAF_ANTIGRAVITY_LOGIN_TIMEOUT_MS) || ANTIGRAVITY_LOGIN_TIMEOUT_MS;
  const statusTimeoutMs = parseOptionalPositiveInteger(env.CODEX_OVERLEAF_ANTIGRAVITY_STATUS_TIMEOUT_MS) || ANTIGRAVITY_STATUS_TIMEOUT_MS;
  return runOwnedNativeHelper(signal => withTempProbeDir(async probeDir => {
    let client = null;
    let version = null;
    try {
      client = new AntigravityAcpClient(executable, {
        cwd: probeDir,
        geminiDir,
        env,
        timeoutMs: statusTimeoutMs
      });
      const initResult = await initializeAcpClient(client, signal, statusTimeoutMs);
      version = (typeof initResult?.agentInfo?.version === 'string' && initResult.agentInfo.version.trim())
        || await probeAntigravityCliVersion(executable, env, { signal })
        || null;
      const authResult = await client.request('authenticate', {
        methodId: 'oauth-personal'
      }, { signal, timeoutMs: loginTimeoutMs });
      let tier = normalizeTier(authResult?._meta?.antigravity?.tier);
      let warning = null;
      try {
        const sessionResult = await client.request('session/new', {
          cwd: probeDir,
          mcpServers: []
        }, { signal, timeoutMs: statusTimeoutMs });
        if (!tier) {
          tier = normalizeTier(sessionResult?._meta?.antigravity?.tier);
        }
        await closeProbeSessionIfSupported(client, initResult, sessionResult?.sessionId);
      } catch (probeError) {
        if (signal?.aborted) throw getAbortReason(signal);
        if (isAntigravityAuthError(probeError)) {
          throw probeError;
        }
        warning = {
          code: probeError?.code === 'ACP_REQUEST_TIMEOUT'
            ? 'antigravity_probe_timeout'
            : 'antigravity_probe_failed',
          message: sanitizeProviderMessage(
            probeError?.message || 'Signed in, but post-login session verification did not complete.'
          )
        };
      }
      return {
        installed: true,
        executable,
        version,
        signedIn: true,
        tier,
        error: null,
        ...(warning ? { warning } : {})
      };
    } catch (error) {
      if (!version && !shouldSkipCliVersionProbe(error, signal)) {
        version = await probeAntigravityCliVersion(executable, env, { signal });
      }
      const code = isAntigravityAuthError(error)
        ? 'antigravity_auth_required'
        : error?.code === 'ACP_REQUEST_TIMEOUT'
          ? 'antigravity_login_timeout'
          : 'antigravity_login_failed';
      return {
        installed: true,
        executable,
        version,
        signedIn: false,
        tier: null,
        error: {
          code,
          message: sanitizeProviderMessage(error?.message || 'Antigravity Google sign-in did not complete.')
        }
      };
    } finally {
      if (client) {
        await client.close().catch(() => {});
      }
    }
  }));
}

function isGeminiBaseModelId(modelId) {
  const id = String(modelId || '').trim();
  return id.startsWith('gemini-') && !/orchestrator/i.test(id);
}

function stripModelEffortSuffix(modelId) {
  const clean = String(modelId || '').trim();
  const match = clean.match(/^(gemini-[a-z0-9.-]+?)-(minimal|low|medium|high|xhigh|max)$/i);
  return match ? match[1] : clean;
}

function flattenSelectValues(option) {
  if (!Array.isArray(option?.options)) return [];
  return option.options
    .flatMap(entry => Array.isArray(entry?.options) ? entry.options : [entry])
    .filter(entry => entry && typeof entry.value === 'string' && entry.value.trim());
}

function findConfigOption(configOptions, kind) {
  const options = Array.isArray(configOptions)
    ? configOptions.filter(opt => opt && (opt.type === 'select' || Array.isArray(opt.options) || typeof opt.currentValue === 'string'))
    : [];
  if (kind === 'model') {
    return options.find(opt => opt.category === 'model' || opt.id === 'model') || null;
  }
  if (kind === 'thought_level') {
    return options.find(opt => opt.category === 'thought_level'
      || ['thought_level', 'thinking_level', 'thinkingLevel', 'reasoning_effort'].includes(opt.id)) || null;
  }
  if (kind === 'mode') {
    return options.find(opt => opt.category === 'mode' || opt.id === 'mode') || null;
  }
  return null;
}

function formatModelLabel(modelId, rawName) {
  const cleanName = String(rawName || '').trim();
  if (cleanName) return cleanName;
  return String(modelId || '')
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function buildAntigravityModelCatalog(sessionResult = {}, observedConfigOptions = []) {
  const configOptions = Array.isArray(sessionResult?.configOptions) && sessionResult.configOptions.length
    ? sessionResult.configOptions
    : observedConfigOptions;
  const modelOption = findConfigOption(configOptions, 'model');
  const thoughtOption = findConfigOption(configOptions, 'thought_level');
  const availableModels = Array.isArray(sessionResult?.models?.availableModels)
    ? sessionResult.models.availableModels
    : [];

  const baseEntries = new Map();
  for (const choice of flattenSelectValues(modelOption)) {
    const id = choice.value.trim();
    if (!isGeminiBaseModelId(id)) continue;
    baseEntries.set(id, {
      id,
      label: formatModelLabel(id, choice.name),
      efforts: new Set()
    });
  }

  for (const variant of availableModels) {
    const variantId = String(variant?.modelId || variant?.id || '').trim();
    if (!variantId.startsWith('gemini-') || /orchestrator/i.test(variantId)) continue;

    let matchedBase = null;
    let matchedEffort = '';
    for (const baseId of baseEntries.keys()) {
      if (variantId === baseId) {
        matchedBase = baseId;
        break;
      }
      if (variantId.startsWith(`${baseId}-`)) {
        const suffix = variantId.slice(baseId.length + 1).toLowerCase();
        if (EFFORT_ORDER.includes(suffix)) {
          matchedBase = baseId;
          matchedEffort = suffix;
          break;
        }
      }
    }

    if (!matchedBase && !modelOption) {
      const suffixMatch = variantId.match(/^(gemini-[a-z0-9.-]+?)-(minimal|low|medium|high|xhigh|max)$/i);
      const baseId = suffixMatch ? suffixMatch[1] : variantId;
      if (isGeminiBaseModelId(baseId)) {
        matchedBase = baseId;
        matchedEffort = suffixMatch ? suffixMatch[2].toLowerCase() : '';
        if (!baseEntries.has(baseId)) {
          const strippedName = String(variant?.name || '').replace(/\s*\((?:minimal|low|medium|high|xhigh|max)\)\s*$/i, '').trim();
          baseEntries.set(baseId, {
            id: baseId,
            label: formatModelLabel(baseId, strippedName),
            efforts: new Set()
          });
        }
      }
    }

    if (matchedBase && matchedEffort) {
      baseEntries.get(matchedBase).efforts.add(matchedEffort);
    }
  }

  const currentBase = isGeminiBaseModelId(modelOption?.currentValue) ? modelOption.currentValue.trim() : '';
  if (currentBase && baseEntries.has(currentBase) && baseEntries.get(currentBase).efforts.size === 0 && thoughtOption) {
    for (const item of flattenSelectValues(thoughtOption)) {
      const normalized = item.value.trim().toLowerCase();
      if (EFFORT_ORDER.includes(normalized)) {
        baseEntries.get(currentBase).efforts.add(normalized);
      }
    }
  }

  const models = Array.from(baseEntries.values()).map(entry => {
    const reasoningEfforts = EFFORT_ORDER.filter(effort => entry.efforts.has(effort));
    const defaultReasoningEffort = reasoningEfforts.includes('high')
      ? 'high'
      : reasoningEfforts.includes('medium')
        ? 'medium'
        : (reasoningEfforts[0] || '');
    return {
      id: entry.id,
      label: entry.label,
      reasoningEfforts,
      defaultReasoningEffort,
      reasoningPresentation: reasoningEfforts.length ? 'effort' : 'none',
      speedTiers: ['standard'],
      defaultSpeedTier: 'standard'
    };
  });

  if (!models.length) {
    throw codedError('antigravity_models_unavailable', 'Antigravity did not advertise any Gemini models for this account.');
  }

  const defaultModelId = models.some(model => model.id === ANTIGRAVITY_DEFAULT_MODEL)
    ? ANTIGRAVITY_DEFAULT_MODEL
    : models.some(model => model.id === currentBase)
      ? currentBase
      : models[0].id;

  return {
    providerId: ANTIGRAVITY_PROVIDER_ID,
    providerRevision: 0,
    providerName: ANTIGRAVITY_PROVIDER_NAME,
    source: 'antigravity',
    defaultModelId,
    models,
    fetchedAt: new Date().toISOString()
  };
}

async function resolveAntigravityModels(_params = {}, env = process.env) {
  const executable = resolveAntigravityExecutable(env);
  if (!executable) {
    throw codedError('antigravity_not_found', 'Antigravity CLI (`agy`) was not found.');
  }
  const geminiDir = resolveAntigravityGeminiDir(env);
  const timeoutMs = parseOptionalPositiveInteger(env.CODEX_OVERLEAF_ANTIGRAVITY_STATUS_TIMEOUT_MS) || ANTIGRAVITY_STATUS_TIMEOUT_MS;

  return runOwnedNativeHelper(signal => withTempProbeDir(async probeDir => {
    let client = null;
    let observedConfigOptions = [];
    try {
      client = new AntigravityAcpClient(executable, {
        cwd: probeDir,
        geminiDir,
        env,
        timeoutMs,
        onNotification: message => {
          if (message.method === 'session/update'
            && message.params?.update?.sessionUpdate === 'config_option_update'
            && Array.isArray(message.params.update.configOptions)) {
            observedConfigOptions = message.params.update.configOptions;
          }
        }
      });
      const initResult = await initializeAcpClient(client, signal, timeoutMs);
      const sessionResult = await client.request('session/new', {
        cwd: probeDir,
        mcpServers: []
      }, { signal, timeoutMs });
      const catalog = buildAntigravityModelCatalog(sessionResult, observedConfigOptions);
      await closeProbeSessionIfSupported(client, initResult, sessionResult?.sessionId);
      return catalog;
    } catch (error) {
      throw mapAntigravityError(error, 'antigravity_models_failed');
    } finally {
      if (client) {
        await client.close().catch(() => {});
      }
    }
  }));
}

function normalizeFieldKey(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isEditSearchStringField(rawKey, parentObj, toolKind) {
  if (toolKind !== 'edit' || rawKey !== 'Target' || !parentObj || typeof parentObj !== 'object') {
    return false;
  }
  return typeof parentObj.Path === 'string' && typeof parentObj.Replacement === 'string';
}

function isPathLikeKey(rawKey) {
  const normalized = normalizeFieldKey(rawKey);
  if (!normalized || CWD_FIELD_KEYS.has(normalized) || COMMAND_FIELD_KEYS.has(normalized)) {
    return false;
  }
  if (PATH_FIELD_KEYS.has(normalized)) {
    return true;
  }
  const tokens = String(rawKey || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return tokens.some(token => PATH_FIELD_TOKENS.has(token));
}

function hasParentTraversalSegment(text) {
  return String(text || '').split(/[\\/]+/).includes('..');
}

function parseCandidatePathString(rawValue, env = process.env) {
  if (typeof rawValue !== 'string') return null;
  if (rawValue.includes('\0') || rawValue.includes('\r') || rawValue.includes('\n')) return null;
  const text = rawValue.trim();
  if (!text) return null;
  if (text.includes('$') || text.includes('%')) return null;

  let expanded = text;
  if (/^file:/i.test(text)) {
    try {
      expanded = fileURLToPath(new URL(text));
    } catch (_error) {
      return null;
    }
  } else if (text.startsWith('~')) {
    if (!text.startsWith('~/')) {
      return null;
    }
    const subPath = text.slice(2);
    if (hasParentTraversalSegment(subPath)) {
      return null;
    }
    expanded = path.join(getHomeDir({ env }), subPath);
  } else if (/^[A-Za-z]:(?![\\/])/.test(text)) {
    return null;
  }

  if (!expanded
    || expanded.includes('\0')
    || expanded.includes('\r')
    || expanded.includes('\n')
    || expanded.includes('$')
    || expanded.includes('%')
    || /^[A-Za-z]:(?![\\/])/.test(expanded)
    || hasParentTraversalSegment(expanded)) {
    return null;
  }
  return expanded;
}

function collectToolPolicyInputs(value, collected, depth = 0, key = '', toolKind = '') {
  if (depth > 6) {
    collected.overflow = true;
    return;
  }
  if (value === null || value === undefined) return;

  const normalized = normalizeFieldKey(key);
  const isCwd = CWD_FIELD_KEYS.has(normalized);
  const isCmd = COMMAND_FIELD_KEYS.has(normalized);
  const isPath = isPathLikeKey(key);

  if (typeof value === 'string') {
    if (isCwd) {
      if (!value.trim()) collected.invalidInput = true;
      else collected.cwds.push(value);
    } else if (isCmd) {
      if (!value.trim()) collected.invalidInput = true;
      else collected.commands.push(value);
    } else if (isPath) {
      if (!value.trim()) collected.invalidInput = true;
      else collected.paths.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) {
      collected.overflow = true;
      return;
    }
    for (const item of value) {
      collectToolPolicyInputs(item, collected, depth + 1, key, toolKind);
    }
    return;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length > 256) {
      collected.overflow = true;
      return;
    }
    for (const [childKey, childValue] of entries) {
      if (isEditSearchStringField(childKey, value, toolKind)) {
        continue;
      }
      collectToolPolicyInputs(childValue, collected, depth + 1, childKey, toolKind);
    }
    return;
  }
  if (isCwd || isCmd || (isPath && normalized !== 'location' && normalized !== 'locations')) {
    collected.invalidInput = true;
  }
}

function resolveExistingAncestorRealPath(targetPath) {
  let current = path.resolve(targetPath);
  const suffix = [];
  for (let depth = 0; depth < 128; depth += 1) {
    let stat = null;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        const parent = path.dirname(current);
        if (parent === current) return null;
        suffix.push(path.basename(current));
        current = parent;
        continue;
      }
      return null;
    }
    if (stat.isSymbolicLink()) {
      try {
        const real = fs.realpathSync.native(current);
        return suffix.length ? path.join(real, ...suffix.reverse()) : real;
      } catch (_error) {
        return null;
      }
    }
    try {
      const real = fs.realpathSync.native(current);
      return suffix.length ? path.join(real, ...suffix.reverse()) : real;
    } catch (_error) {
      return null;
    }
  }
  return null;
}

function evaluateMirrorWorkspacePath(rawPath, workspacePath, { allowWorkspaceRoot = false, forbidInternalDirs = false, baseDir = null, env = process.env } = {}) {
  if (!workspacePath) {
    return { ok: false, reason: 'missing_workspace' };
  }
  let workspaceReal;
  try {
    workspaceReal = fs.realpathSync.native(path.resolve(workspacePath));
  } catch (_error) {
    return { ok: false, reason: 'workspace_unavailable' };
  }
  const parsed = parseCandidatePathString(rawPath, env);
  if (!parsed) {
    return { ok: false, reason: 'invalid_path' };
  }
  const anchor = baseDir || workspaceReal;
  const candidate = path.resolve(anchor, parsed);
  const resolved = resolveExistingAncestorRealPath(candidate);
  if (!resolved) {
    return { ok: false, reason: 'unresolvable_path' };
  }

  const compareLeft = process.platform === 'win32' ? workspaceReal.toLowerCase() : workspaceReal;
  const compareRight = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const relative = path.relative(compareLeft, compareRight);
  if (relative === '') {
    return allowWorkspaceRoot
      ? { ok: true, resolvedPath: resolved, relativePath: '' }
      : { ok: false, reason: 'workspace_root_mutation_forbidden' };
  }
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { ok: false, reason: 'outside_mirror_workspace' };
  }
  if (forbidInternalDirs) {
    const firstSegment = relative.split(/[\\/]/)[0].toLowerCase();
    if (FORBIDDEN_WORKSPACE_DIRS.has(firstSegment)) {
      return { ok: false, reason: 'reserved_workspace_directory' };
    }
  }
  return { ok: true, resolvedPath: resolved, relativePath: relative.replace(/\\/g, '/') };
}

function evaluateWritingStyleBundlePath(rawPath, writingStyleRoot, env = process.env) {
  if (!writingStyleRoot || typeof writingStyleRoot !== 'string') {
    return { ok: false, reason: 'no_writing_style_root' };
  }
  const parsed = parseCandidatePathString(rawPath, env);
  if (!parsed) {
    return { ok: false, reason: 'invalid_path' };
  }
  if (!path.isAbsolute(parsed)) {
    return { ok: false, reason: 'writing_style_relative_forbidden' };
  }

  const rootLexical = path.resolve(writingStyleRoot);
  let rootStat;
  let rootReal;
  try {
    rootStat = fs.lstatSync(rootLexical);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { ok: false, reason: 'writing_style_root_invalid' };
    }
    rootReal = fs.realpathSync.native(rootLexical);
  } catch (_error) {
    return { ok: false, reason: 'writing_style_root_unavailable' };
  }

  const candidate = path.resolve(parsed);
  const normalizeCmp = value => (process.platform === 'win32' ? value.toLowerCase() : value);
  const relLexical = path.relative(normalizeCmp(rootLexical), normalizeCmp(candidate));
  const relReal = path.relative(normalizeCmp(rootReal), normalizeCmp(candidate));
  const isContained = rel => rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));

  let relativeInside = null;
  if (isContained(relLexical)) {
    relativeInside = path.relative(rootLexical, candidate);
  } else if (isContained(relReal)) {
    relativeInside = path.relative(rootReal, candidate);
  } else {
    return { ok: false, reason: 'outside_writing_style_bundle' };
  }

  let cursor = rootReal;
  const parts = relativeInside ? relativeInside.split(/[\\/]+/).filter(Boolean) : [];
  try {
    for (const part of parts) {
      cursor = path.join(cursor, part);
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        return { ok: false, reason: 'writing_style_symlink_forbidden' };
      }
    }
    const targetReal = fs.realpathSync.native(cursor);
    const verifiedRel = path.relative(normalizeCmp(rootReal), normalizeCmp(targetReal));
    if (!isContained(verifiedRel)) {
      return { ok: false, reason: 'outside_writing_style_bundle' };
    }
    return { ok: true, resolvedPath: targetReal };
  } catch (_error) {
    return { ok: false, reason: 'writing_style_asset_unavailable' };
  }
}

function canonicalizePathSetForAgreement(paths, workspacePath, env) {
  const result = new Set();
  const anchor = workspacePath ? path.resolve(workspacePath) : process.cwd();
  for (const raw of paths) {
    const parsed = parseCandidatePathString(raw, env);
    if (!parsed) return null;
    const resolved = path.resolve(anchor, parsed);
    result.add(process.platform === 'win32' ? resolved.toLowerCase() : resolved);
  }
  return result;
}

function selectPermissionOutcome(allowed, options = []) {
  const choices = Array.isArray(options) ? options : [];
  const allowOption = choices.find(opt => opt?.kind === 'allow_once' && typeof opt.optionId === 'string' && opt.optionId);
  const rejectOption = choices.find(opt => opt?.kind === 'reject_once' && typeof opt.optionId === 'string' && opt.optionId);
  if (allowed && allowOption) {
    return {
      allowed: true,
      response: { outcome: { outcome: 'selected', optionId: allowOption.optionId } }
    };
  }
  if (rejectOption) {
    return {
      allowed: false,
      response: { outcome: { outcome: 'selected', optionId: rejectOption.optionId } }
    };
  }
  return {
    allowed: false,
    response: { outcome: { outcome: 'cancelled' } }
  };
}

function evaluateCandidateAcrossWorkspaceAndCwd(candidate, workspacePath, effectiveBaseDir, { allowWorkspaceRoot, forbidInternalDirs, env }) {
  const rootVerdict = evaluateMirrorWorkspacePath(candidate, workspacePath, {
    allowWorkspaceRoot,
    forbidInternalDirs,
    baseDir: null,
    env
  });
  if (!rootVerdict.ok) {
    return rootVerdict;
  }
  if (effectiveBaseDir) {
    const cwdVerdict = evaluateMirrorWorkspacePath(candidate, workspacePath, {
      allowWorkspaceRoot,
      forbidInternalDirs,
      baseDir: effectiveBaseDir,
      env
    });
    if (!cwdVerdict.ok) {
      return cwdVerdict;
    }
  }
  return rootVerdict;
}

function decideAntigravityPermission({
  mode = 'ask',
  workspacePath = '',
  writingStyleRoot = null,
  toolCall = {},
  options = [],
  env = process.env,
  isAllowedCommand = null
} = {}) {
  const isAllowed = typeof isAllowedCommand === 'function' ? isAllowedCommand : evaluateAntigravityCommand;
  const normalizedMode = mode === 'auto' ? 'auto' : 'ask';
  const kind = typeof toolCall?.kind === 'string' ? toolCall.kind.trim() : '';
  const reject = reason => ({
    ...selectPermissionOutcome(false, options),
    decision: 'decline',
    kind: kind || 'unknown',
    reason
  });
  const allow = reason => {
    const selected = selectPermissionOutcome(true, options);
    return {
      ...selected,
      decision: selected.allowed ? 'accept' : 'decline',
      kind: kind || 'unknown',
      reason: selected.allowed ? reason : 'missing_allow_option'
    };
  };

  if (!toolCall || typeof toolCall !== 'object') {
    return reject('invalid_tool_call');
  }
  if (toolCall.inputOverflow) {
    return reject('tool_arguments_too_large');
  }

  const hasRawInput = Object.prototype.hasOwnProperty.call(toolCall, 'rawInput') && toolCall.rawInput !== undefined;
  const hasArgs = Object.prototype.hasOwnProperty.call(toolCall, 'args') && toolCall.args !== undefined;
  if (hasRawInput && hasArgs && !isDeepStrictEqual(toolCall.rawInput, toolCall.args)) {
    return reject('conflicting_tool_arguments');
  }

  const rawCollected = { paths: [], cwds: [], commands: [], overflow: false, invalidInput: false };
  if (hasRawInput) {
    if (typeof toolCall.rawInput === 'string') {
      if (kind === 'execute') rawCollected.commands.push(toolCall.rawInput);
      else rawCollected.invalidInput = true;
    } else if (typeof toolCall.rawInput === 'object' && toolCall.rawInput !== null && !Array.isArray(toolCall.rawInput)) {
      collectToolPolicyInputs(toolCall.rawInput, rawCollected, 0, '', kind);
    } else {
      rawCollected.invalidInput = true;
    }
  }

  const argsCollected = { paths: [], cwds: [], commands: [], overflow: false, invalidInput: false };
  if (hasArgs) {
    if (typeof toolCall.args === 'string') {
      if (kind === 'execute') argsCollected.commands.push(toolCall.args);
      else argsCollected.invalidInput = true;
    } else if (typeof toolCall.args === 'object' && toolCall.args !== null && !Array.isArray(toolCall.args)) {
      collectToolPolicyInputs(toolCall.args, argsCollected, 0, '', kind);
    } else {
      argsCollected.invalidInput = true;
    }
  }

  if (rawCollected.overflow || argsCollected.overflow) {
    return reject('tool_arguments_too_large');
  }
  if (rawCollected.invalidInput || argsCollected.invalidInput) {
    return reject('invalid_tool_arguments');
  }

  const locationPaths = [];
  if (toolCall.locations !== undefined) {
    if (!Array.isArray(toolCall.locations)) return reject('invalid_locations');
    for (const loc of toolCall.locations) {
      if (typeof loc?.path !== 'string' || !loc.path.trim()) return reject('invalid_location_path');
      locationPaths.push(loc.path);
    }
  }
  const diffPaths = [];
  if (Array.isArray(toolCall.content)) {
    for (const block of toolCall.content) {
      if (block?.type === 'diff') {
        if (typeof block.path !== 'string' || !block.path.trim()) return reject('invalid_diff_path');
        diffPaths.push(block.path);
      }
    }
  }

  const isPathTool = WRITE_TOOL_KINDS.has(kind) || kind === 'read';
  if (isPathTool) {
    if (hasRawInput && Object.keys(toolCall.rawInput).length > 0 && rawCollected.paths.length === 0) {
      return reject('missing_target_path');
    }
    if (hasArgs) {
      if (argsCollected.paths.length === 0) {
        return reject('missing_target_path');
      }
      if (!hasRawInput && locationPaths.length > 0) {
        const argsSet = canonicalizePathSetForAgreement(argsCollected.paths, workspacePath, env);
        const locSet = canonicalizePathSetForAgreement(locationPaths, workspacePath, env);
        if (!argsSet || !locSet || argsSet.size !== locSet.size || [...argsSet].some(item => !locSet.has(item))) {
          return reject('conflicting_tool_locations');
        }
      }
    }
  } else if (!hasRawInput && hasArgs && locationPaths.length > 0) {
    return reject('conflicting_tool_locations');
  }

  const allPaths = [
    ...rawCollected.paths,
    ...argsCollected.paths,
    ...locationPaths,
    ...diffPaths
  ];
  const allCwds = [...rawCollected.cwds, ...argsCollected.cwds];
  const allCommands = [...rawCollected.commands, ...argsCollected.commands];

  const resolvedCwds = new Set();
  for (const rawCwd of allCwds) {
    const cwdCheck = evaluateMirrorWorkspacePath(rawCwd, workspacePath, {
      allowWorkspaceRoot: true,
      forbidInternalDirs: true,
      baseDir: null,
      env
    });
    if (!cwdCheck.ok) {
      return reject(`cwd_${cwdCheck.reason}`);
    }
    resolvedCwds.add(cwdCheck.resolvedPath);
  }
  if (resolvedCwds.size > 1) {
    return reject('multiple_cwds_forbidden');
  }
  const effectiveBaseDir = resolvedCwds.size === 1 ? [...resolvedCwds][0] : null;

  if (WRITE_TOOL_KINDS.has(kind)) {
    if (normalizedMode !== 'auto') {
      return reject('ask_mode_read_only');
    }
    const uniquePaths = [...new Set(allPaths)];
    if (!uniquePaths.length) {
      return reject('missing_target_path');
    }
    for (const candidate of uniquePaths) {
      const verdict = evaluateCandidateAcrossWorkspaceAndCwd(candidate, workspacePath, effectiveBaseDir, {
        allowWorkspaceRoot: false,
        forbidInternalDirs: true,
        env
      });
      if (!verdict.ok) {
        return reject(verdict.reason);
      }
    }
    return allow('auto_mirror_write_allowed');
  }

  if (kind === 'execute') {
    for (const candidate of [...locationPaths, ...diffPaths]) {
      const verdict = evaluateCandidateAcrossWorkspaceAndCwd(candidate, workspacePath, effectiveBaseDir, {
        allowWorkspaceRoot: true,
        forbidInternalDirs: false,
        env
      });
      if (!verdict.ok) {
        return reject(verdict.reason);
      }
    }
    const rawObj = hasRawInput && typeof toolCall.rawInput === 'object' && toolCall.rawInput ? toolCall.rawInput : {};
    const argsObj = hasArgs && typeof toolCall.args === 'object' && toolCall.args ? toolCall.args : {};
    const primaryCommand = typeof rawObj.CommandLine === 'string'
      ? rawObj.CommandLine
      : typeof rawObj.command === 'string'
        ? rawObj.command
        : typeof toolCall.rawInput === 'string'
          ? toolCall.rawInput
          : typeof argsObj.CommandLine === 'string'
            ? argsObj.CommandLine
            : typeof argsObj.command === 'string'
              ? argsObj.command
              : typeof toolCall.args === 'string'
                ? toolCall.args
                : (allCommands[0] || '');
    if (!primaryCommand.trim()) {
      return reject('missing_command_line');
    }
    const distinctCommands = [...new Set([primaryCommand, ...allCommands].map(cmd => String(cmd || '').trim()).filter(Boolean))];
    if (distinctCommands.length !== 1) {
      return reject('conflicting_command_fields');
    }
    const verdict = isAllowed(distinctCommands[0], workspacePath, effectiveBaseDir, env, { writingStyleRoot });
    if (!verdict.ok) {
      return reject(verdict.reason);
    }
    return allow('read_only_command_allowed');
  }

  if (kind === 'read') {
    const uniquePaths = [...new Set(allPaths)];
    if (!uniquePaths.length) {
      return reject('missing_read_path');
    }
    for (const candidate of uniquePaths) {
      if (writingStyleRoot && evaluateWritingStyleBundlePath(candidate, writingStyleRoot, env).ok) {
        continue;
      }
      const verdict = evaluateCandidateAcrossWorkspaceAndCwd(candidate, workspacePath, effectiveBaseDir, {
        allowWorkspaceRoot: true,
        forbidInternalDirs: false,
        env
      });
      if (!verdict.ok) {
        return reject(verdict.reason);
      }
    }
    return allow('mirror_read_allowed');
  }

  return reject('unsupported_permission_kind');
}

// agy runs approved command lines through a shell with no OS sandbox, so the
// Codex allowlist (which relies on the Codex sandbox) is not reused here. Only
// plain read-only inspection programs are permitted in both modes: no shells,
// compilers or programs with output-file options, no path-qualified
// executables, no shell syntax, and every path-like argument must stay inside
// the run's mirror workspace (or the verified writing-style bundle root).
const ANTIGRAVITY_READ_ONLY_COMMANDS = new Set([
  'rg', 'grep', 'cat', 'head', 'tail', 'nl', 'ls', 'wc', 'cut', 'find',
  'basename', 'dirname', 'realpath', 'stat', 'kpsewhich', 'lacheck'
]);

function tokenizeAntigravityCommand(commandLine) {
  const tokens = [];
  let current = '';
  let quote = '';
  let started = false;
  for (const char of commandLine) {
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (quote) return null;
  if (started) tokens.push(current);
  return tokens;
}

function isCommandArgPathLike(value) {
  return value.includes('/')
    || value.includes('\\')
    || value.startsWith('~')
    || value.includes('..')
    || value.includes('%')
    || /^[A-Za-z]:/.test(value)
    || /^file:/i.test(value);
}

function evaluateAntigravityCommand(commandLine, workspacePath, baseDir = null, env = process.env, { writingStyleRoot = null } = {}) {
  const text = String(commandLine || '');
  // Control operators, redirection, expansion/substitution (including zsh
  // `=(...)` and `${...}`), escapes and history expansion are rejected
  // anywhere, even inside quotes.
  if (/[\r\n&;|<>`$\\!]|=\(/.test(text)) {
    return { ok: false, reason: 'command_shell_operator_forbidden' };
  }
  const tokens = tokenizeAntigravityCommand(text.trim());
  if (!tokens || !tokens.length) {
    return { ok: false, reason: 'command_unparseable' };
  }
  const executable = tokens[0];
  if (!/^[a-z][a-z0-9._-]*$/.test(executable) || !ANTIGRAVITY_READ_ONLY_COMMANDS.has(executable)) {
    return { ok: false, reason: 'command_outside_read_only_allowlist' };
  }
  const args = tokens.slice(1);
  if (executable === 'rg' && args.some(arg => /^--(?:pre|search-zip|hostname-bin)(?:=|$)/.test(arg)
    || /^-[A-Za-z]*z/.test(arg))) {
    return { ok: false, reason: 'command_argument_forbidden' };
  }
  if (executable === 'tail' && args.some(arg => /^-[A-Za-z0-9]*[fF]/.test(arg) || /^--follow(?:=|$)/.test(arg))) {
    return { ok: false, reason: 'command_argument_forbidden' };
  }
  if (executable === 'find' && args.some(arg => /^--?(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)(?:=|$)/i.test(arg))) {
    return { ok: false, reason: 'command_argument_forbidden' };
  }
  for (const arg of args) {
    if (arg.startsWith('-') && !arg.includes('=') && /[\/\\~]/.test(arg)) {
      return { ok: false, reason: 'command_argument_forbidden' };
    }
    const value = arg.startsWith('-') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
    if (!value || !isCommandArgPathLike(value)) {
      continue;
    }
    if (writingStyleRoot && evaluateWritingStyleBundlePath(value, writingStyleRoot, env).ok) {
      continue;
    }
    const verdict = evaluateCandidateAcrossWorkspaceAndCwd(value, workspacePath, baseDir, {
      allowWorkspaceRoot: true,
      forbidInternalDirs: false,
      env
    });
    if (!verdict.ok) {
      return { ok: false, reason: `command_path_${verdict.reason}` };
    }
  }
  return { ok: true, reason: 'read_only_command_allowed' };
}

function mapApprovalMethodForEvent(kind) {
  if (WRITE_TOOL_KINDS.has(kind)) return 'item/fileChange/requestApproval';
  if (kind === 'execute') return 'item/commandExecution/requestApproval';
  return 'session/request_permission';
}

function toWorkspaceDisplayPath(rawPath, workspacePath) {
  const check = evaluateMirrorWorkspacePath(rawPath, workspacePath, { allowWorkspaceRoot: true });
  if (check.ok) {
    return check.relativePath || '.';
  }
  return path.basename(String(rawPath || '')) || String(rawPath || '');
}

function inferImageMimeType(attachment = {}) {
  const rawMime = String(attachment.mimeType || '').trim().toLowerCase();
  if (rawMime === 'image/jpg') return 'image/jpeg';
  if (/^image\/(?:png|jpeg|webp|gif)$/.test(rawMime)) return rawMime;
  const ext = path.extname(String(attachment.name || attachment.path || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return '';
}

function extractToolCommandLine(toolCall = {}) {
  if (!toolCall || typeof toolCall !== 'object') return '';
  const hasRaw = Object.prototype.hasOwnProperty.call(toolCall, 'rawInput') && toolCall.rawInput !== undefined;
  const hasArgs = Object.prototype.hasOwnProperty.call(toolCall, 'args') && toolCall.args !== undefined;
  const rawObj = hasRaw && typeof toolCall.rawInput === 'object' && toolCall.rawInput && !Array.isArray(toolCall.rawInput)
    ? toolCall.rawInput
    : {};
  const argsObj = hasArgs && typeof toolCall.args === 'object' && toolCall.args && !Array.isArray(toolCall.args)
    ? toolCall.args
    : {};
  if (typeof rawObj.CommandLine === 'string') return rawObj.CommandLine;
  if (typeof rawObj.command === 'string') return rawObj.command;
  if (typeof toolCall.rawInput === 'string') return toolCall.rawInput;
  if (typeof argsObj.CommandLine === 'string') return argsObj.CommandLine;
  if (typeof argsObj.command === 'string') return argsObj.command;
  if (typeof toolCall.args === 'string') return toolCall.args;
  return '';
}

function extractSafeCommandExecutable(commandLine) {
  const text = String(commandLine || '').trim();
  if (!text) return '';
  const tokens = tokenizeAntigravityCommand(text);
  const rawFirst = tokens && tokens.length
    ? tokens[0]
    : text.split(/[\s&;|<>`()]+/)[0].replace(/^['"]+|['"]+$/g, '');
  if (!rawFirst || rawFirst === '.' || rawFirst === '..') return '';
  return /^[A-Za-z0-9._-]+$/.test(rawFirst) ? rawFirst.slice(0, 64) : '';
}

function sanitizeCommandPreviewForPrompt(commandLine, workspacePath, env = process.env) {
  const collapsed = String(commandLine || '').replace(/[\r\n]+/g, ' ; ').replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  const parts = collapsed.split(' ').map(token => {
    const core = token.replace(/^['"`(]+|['"`),;]+$/g, '');
    if (!core || !isCommandArgPathLike(core)) {
      return token;
    }
    const verdict = evaluateMirrorWorkspacePath(core, workspacePath, {
      allowWorkspaceRoot: true,
      forbidInternalDirs: false,
      env
    });
    if (!verdict.ok) {
      return '<outside-workspace-path>';
    }
    if (path.isAbsolute(core)) {
      return verdict.relativePath || '.';
    }
    return token;
  });
  return parts.join(' ').slice(0, 160);
}

function collectSafeWorkspaceRelativePaths(toolCall = {}, workspacePath = '', env = process.env) {
  if (!toolCall || typeof toolCall !== 'object' || !workspacePath) return [];
  const collected = { paths: [], cwds: [], commands: [], overflow: false, invalidInput: false };
  const kind = typeof toolCall.kind === 'string' ? toolCall.kind.trim() : '';
  if (toolCall.rawInput && typeof toolCall.rawInput === 'object' && !Array.isArray(toolCall.rawInput)) {
    collectToolPolicyInputs(toolCall.rawInput, collected, 0, '', kind);
  }
  if (toolCall.args && typeof toolCall.args === 'object' && !Array.isArray(toolCall.args)) {
    collectToolPolicyInputs(toolCall.args, collected, 0, '', kind);
  }
  const candidates = [
    ...collected.paths,
    ...(Array.isArray(toolCall.locations) ? toolCall.locations.map(loc => loc?.path).filter(Boolean) : []),
    ...(Array.isArray(toolCall.content) ? toolCall.content.filter(b => b?.type === 'diff').map(b => b.path).filter(Boolean) : [])
  ];
  const safe = [];
  const seen = new Set();
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const verdict = evaluateMirrorWorkspacePath(raw, workspacePath, {
      allowWorkspaceRoot: true,
      forbidInternalDirs: false,
      env
    });
    if (!verdict.ok) continue;
    const rel = verdict.relativePath || '.';
    if (!seen.has(rel)) {
      seen.add(rel);
      safe.push(rel);
    }
    if (safe.length >= 3) break;
  }
  return safe;
}

function isOutsideWorkspacePermissionReason(reason) {
  const code = String(reason || '');
  return code === 'outside_mirror_workspace'
    || code === 'invalid_path'
    || code === 'unresolvable_path'
    || code === 'outside_writing_style_bundle'
    || code === 'no_writing_style_root'
    || code.startsWith('writing_style_')
    || code.startsWith('command_path_')
    || code === 'cwd_outside_mirror_workspace'
    || code === 'cwd_invalid_path'
    || code === 'cwd_unresolvable_path';
}

function describeDeclinedPermissionForPrompt(decision = {}, toolCall = {}, workspacePath = '', env = process.env) {
  const kind = String(decision.kind || toolCall?.kind || 'unknown');
  const reason = String(decision.reason || '');
  const commandLine = kind === 'execute' ? extractToolCommandLine(toolCall) : '';
  const commandName = kind === 'execute' ? extractSafeCommandExecutable(commandLine) : '';
  const safePaths = kind !== 'execute' ? collectSafeWorkspaceRelativePaths(toolCall, workspacePath, env) : [];

  let target;
  if (kind === 'execute') {
    const preview = sanitizeCommandPreviewForPrompt(commandLine, workspacePath, env);
    target = preview ? `shell command \`${preview}\`` : 'shell command';
  } else if (WRITE_TOOL_KINDS.has(kind)) {
    const label = kind === 'delete' ? 'file delete' : kind === 'move' ? 'file move' : 'file edit';
    target = safePaths.length ? `${label} on \`${safePaths.join(', ')}\`` : label;
  } else if (kind === 'read') {
    target = safePaths.length ? `file read on \`${safePaths.join(', ')}\`` : 'file read';
  } else {
    const safeKind = /^[A-Za-z0-9._-]+$/.test(kind) ? kind : 'tool';
    target = `tool request \`${safeKind}\``;
  }

  let plainReason;
  if (reason === 'command_outside_read_only_allowlist') {
    plainReason = commandName
      ? `command \`${commandName}\` is not in the read-only list`
      : 'command not in the read-only list';
  } else if (reason === 'command_shell_operator_forbidden') {
    plainReason = 'shell operators not allowed (no pipes, redirection, chaining, or substitution)';
  } else if (reason === 'command_argument_forbidden') {
    plainReason = commandName
      ? `write, exec, or follow flags are not allowed for \`${commandName}\``
      : 'write, exec, or follow flags are not allowed in read-only commands';
  } else if (reason === 'ask_mode_read_only') {
    plainReason = 'edits not allowed in Ask mode';
  } else if (isOutsideWorkspacePermissionReason(reason)) {
    plainReason = 'path outside the project workspace';
  } else if (reason === 'reserved_workspace_directory'
    || reason === 'cwd_reserved_workspace_directory'
    || reason === 'workspace_root_mutation_forbidden') {
    plainReason = 'protected workspace directory cannot be modified';
  } else if (reason === 'unsupported_permission_kind') {
    plainReason = 'tool kind is not allowed by the plugin policy';
  } else {
    plainReason = 'request could not be verified under the workspace permission policy';
  }

  return { target, plainReason, reason };
}

function buildAntigravityContinuationPrompt(declinedItems = [], mode = 'ask') {
  const isAuto = mode === 'auto';
  const lines = [];
  const seen = new Set();
  for (const item of declinedItems) {
    const line = `- ${item.target}: ${item.plainReason}.`;
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
    if (lines.length >= 8) break;
  }
  const blockedSection = lines.length === 1
    ? `[Overleaf plugin] Your previous request (${lines[0].slice(2, -1)}) was blocked by the plugin's permission policy.`
    : [
        "[Overleaf plugin] The following requests in your previous step were blocked by the plugin's permission policy:",
        ...lines
      ].join('\n');
  const continueInstruction = isAuto
    ? 'Continue the original task now and provide your answer (if edits are needed, edit files inside this workspace with your built-in file tools).'
    : 'Continue the original task now and answer without editing any files.';
  return [
    blockedSection,
    'Reading, listing, and searching files inside this workspace with your built-in tools is allowed and needs no approval.',
    lines.length === 1 ? 'Do not retry that blocked request.' : 'Do not retry the blocked requests.',
    continueInstruction
  ].join(' ');
}

function buildAntigravityPolicyNote() {
  const allowedCommands = Array.from(ANTIGRAVITY_READ_ONLY_COMMANDS).join(', ');
  return [
    'Antigravity local tool and command policy:',
    '- Prefer your built-in file read, list, and search tools to explore the project; they need no approval inside this workspace.',
    `- Shell commands are limited to single read-only inspection tools (${allowedCommands}) on paths inside the workspace, with no pipes, redirection, chaining, or substitution, and no write/exec flags (such as find -exec or -delete).`,
    '- File edits are allowed only inside the workspace in Auto mode, and not at all in Ask mode.'
  ].join('\n');
}

function buildPromptBlocks(input = {}, initResult = {}) {
  const taskText = String(input.task || '');
  const developerBlock = [
    String(input.developerInstructions || '').trim(),
    buildAntigravityPolicyNote()
  ].filter(Boolean).join('\n\n');
  const fullText = `<developer_instructions>\n${developerBlock}\n</developer_instructions>\n\n${taskText}`;
  const blocks = [{ type: 'text', text: fullText }];

  if (initResult?.agentCapabilities?.promptCapabilities?.image === false) {
    return blocks;
  }

  const candidates = Array.isArray(input.turnAttachments) && input.turnAttachments.length
    ? input.turnAttachments
    : (Array.isArray(input.attachments) ? input.attachments : []);
  for (const item of candidates) {
    const mimeType = inferImageMimeType(item);
    if (!mimeType) continue;
    let base64 = '';
    if (typeof item?.contentBase64 === 'string' && item.contentBase64.trim()) {
      base64 = item.contentBase64.replace(/\s+/g, '');
    } else if (typeof item?.data === 'string' && item.data.trim()) {
      base64 = item.data.replace(/\s+/g, '');
    } else if (typeof item?.path === 'string' && input.workspacePath) {
      const verdict = evaluateMirrorWorkspacePath(item.path, input.workspacePath, { allowWorkspaceRoot: false });
      if (verdict.ok && fs.existsSync(verdict.resolvedPath)) {
        base64 = fs.readFileSync(verdict.resolvedPath).toString('base64');
      }
    }
    if (base64) {
      blocks.push({ type: 'image', mimeType, data: base64 });
    }
  }
  return blocks;
}

function captureSessionConfigMetadata(configState, payload) {
  if (!payload || typeof payload !== 'object') return;
  if (Array.isArray(payload.configOptions)) {
    configState.options = payload.configOptions;
  }
  if (typeof payload.modes?.currentModeId === 'string') {
    configState.currentModeId = payload.modes.currentModeId.trim();
  }
  if (typeof payload.models?.currentModelId === 'string') {
    configState.currentModelId = payload.models.currentModelId.trim();
  }
}

async function applyExplicitSessionConfig(client, sessionId, configState, input, signal) {
  const setOption = async (configId, value) => {
    const result = await client.request('session/set_config_option', {
      sessionId,
      configId,
      value
    }, { signal });
    captureSessionConfigMetadata(configState, result);
    return result;
  };

  // 1. Always set mode `default` explicitly so every edit/execute goes through Native permission gate.
  const modeOption = findConfigOption(configState.options, 'mode');
  const modeConfigId = modeOption?.id || 'mode';
  if (modeOption) {
    const modeValues = flattenSelectValues(modeOption);
    if (modeValues.length && !modeValues.some(entry => entry.value === 'default')) {
      throw codedError('antigravity_mode_unavailable', 'Antigravity did not advertise the required `default` permission mode.');
    }
  }
  await setOption(modeConfigId, 'default');

  // 2. Explicitly select Gemini model before selecting per-model thought level.
  const modelOption = findConfigOption(configState.options, 'model');
  const rawRequestedModel = String(input.model || '').trim();
  if (rawRequestedModel && !isGeminiBaseModelId(rawRequestedModel)) {
    throw codedError('provider_model_not_configured', `Antigravity supports only Gemini models (gemini-*); received "${rawRequestedModel}".`);
  }
  let targetModel = rawRequestedModel || ANTIGRAVITY_DEFAULT_MODEL;
  if (modelOption) {
    const geminiChoices = flattenSelectValues(modelOption).filter(entry => isGeminiBaseModelId(entry.value));
    if (!geminiChoices.length) {
      throw codedError('antigravity_models_unavailable', 'Antigravity did not advertise any Gemini models.');
    }
    const match = geminiChoices.find(entry => entry.value === targetModel);
    if (!match) {
      if (rawRequestedModel) {
        throw codedError('provider_model_not_found', `Model "${targetModel}" is not available in Antigravity.`);
      }
      targetModel = geminiChoices[0].value;
    } else {
      targetModel = match.value;
    }
    await setOption(modelOption.id || 'model', targetModel);
  } else {
    await setOption('model', targetModel);
  }

  // 3. Explicitly select thought_level after model update refreshes valid options.
  const thoughtOption = findConfigOption(configState.options, 'thought_level');
  const requestedEffort = String(input.reasoningEffort || '').trim().toLowerCase();
  if (thoughtOption) {
    const effortChoices = flattenSelectValues(thoughtOption);
    if (effortChoices.length) {
      const matched = requestedEffort
        ? effortChoices.find(entry => entry.value.toLowerCase() === requestedEffort
          || String(entry.name || '').toLowerCase() === requestedEffort)
        : null;
      const fallback = (thoughtOption.currentValue && effortChoices.find(entry => entry.value === thoughtOption.currentValue))
        || effortChoices.find(entry => entry.value.toLowerCase() === 'high')
        || effortChoices.find(entry => entry.value.toLowerCase() === 'medium')
        || effortChoices[0];
      const targetEffort = (matched || fallback)?.value;
      if (targetEffort) {
        await setOption(thoughtOption.id || 'thought_level', targetEffort);
      }
    }
  } else if (requestedEffort) {
    await setOption('thought_level', requestedEffort);
  }

  // 4. Verify returned configOptions / session state confirmed mode === 'default' and Gemini base model.
  const confirmedModeOption = findConfigOption(configState.options, 'mode');
  const confirmedMode = typeof confirmedModeOption?.currentValue === 'string'
    ? confirmedModeOption.currentValue.trim()
    : String(configState.currentModeId || '').trim();
  if (confirmedMode !== 'default') {
    throw codedError(
      'antigravity_mode_unavailable',
      `Antigravity did not confirm permission mode "default" (current: "${confirmedMode || 'unconfirmed'}").`
    );
  }

  const confirmedModelOption = findConfigOption(configState.options, 'model');
  const confirmedBaseModel = typeof confirmedModelOption?.currentValue === 'string' && confirmedModelOption.currentValue.trim()
    ? confirmedModelOption.currentValue.trim()
    : stripModelEffortSuffix(configState.currentModelId);
  if (!isGeminiBaseModelId(confirmedBaseModel)) {
    throw codedError(
      'provider_model_not_configured',
      `Antigravity did not confirm a Gemini base model (current: "${confirmedBaseModel || 'unconfirmed'}").`
    );
  }
  if (confirmedBaseModel !== targetModel) {
    throw codedError(
      'provider_model_not_found',
      `Antigravity did not activate requested Gemini model "${targetModel}" (current: "${confirmedBaseModel}").`
    );
  }

  return { model: confirmedBaseModel };
}

function truncateStringToUtf8Bytes(text, maxBytes) {
  if (maxBytes <= 0 || !text) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let result = '';
  let used = 0;
  for (const codePoint of text) {
    const bytes = Buffer.byteLength(codePoint, 'utf8');
    if (used + bytes > maxBytes) break;
    result += codePoint;
    used += bytes;
  }
  return result;
}

function retainBoundedToolInput(value) {
  if (value === undefined) return { present: false, value: undefined, overflow: false };
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === 'string' && Buffer.byteLength(serialized, 'utf8') > MAX_TOOL_INPUT_BYTES) {
      return { present: true, value: undefined, overflow: true };
    }
    return { present: true, value, overflow: false };
  } catch (_error) {
    return { present: true, value: undefined, overflow: true };
  }
}

function compactToolOutput(rawOutput) {
  if (rawOutput === undefined || rawOutput === null) return undefined;
  if (typeof rawOutput === 'string') {
    return rawOutput.slice(0, MAX_TOOL_OUTPUT_CHARS);
  }
  if (typeof rawOutput === 'object') {
    const text = typeof rawOutput.stdout === 'string'
      ? rawOutput.stdout
      : typeof rawOutput.output === 'string'
        ? rawOutput.output
        : typeof rawOutput.text === 'string'
          ? rawOutput.text
          : '';
    const exitCode = Number.isInteger(rawOutput.exitCode)
      ? rawOutput.exitCode
      : Number.isInteger(rawOutput.exit_code)
        ? rawOutput.exit_code
        : undefined;
    return {
      ...(text ? { output: text.slice(0, MAX_TOOL_OUTPUT_CHARS) } : {}),
      ...(exitCode !== undefined ? { exitCode } : {})
    };
  }
  return undefined;
}

function isEmptyPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
}

function mergeBoundedToolRecord(previous = {}, incoming = {}) {
  const next = {
    toolCallId: String(incoming.toolCallId || previous.toolCallId || ''),
    kind: typeof incoming.kind === 'string' && incoming.kind.trim()
      ? incoming.kind.trim()
      : (previous.kind || ''),
    title: typeof incoming.title === 'string'
      ? incoming.title.slice(0, 256)
      : (previous.title || ''),
    name: typeof incoming.name === 'string'
      ? incoming.name.slice(0, 160)
      : (previous.name || ''),
    status: typeof incoming.status === 'string'
      ? incoming.status
      : (previous.status || ''),
    permissionDenied: Boolean(previous.permissionDenied || incoming.permissionDenied),
    inputOverflow: Boolean(previous.inputOverflow || incoming.inputOverflow),
    locations: Array.isArray(previous.locations) ? [...previous.locations] : [],
    content: Array.isArray(previous.content) ? [...previous.content] : [],
    ...(previous.rawOutput !== undefined ? { rawOutput: previous.rawOutput } : {})
  };

  for (const field of ['rawInput', 'args']) {
    if (Object.prototype.hasOwnProperty.call(incoming, field) && incoming[field] !== undefined) {
      const bounded = retainBoundedToolInput(incoming[field]);
      if (bounded.overflow) {
        next.inputOverflow = true;
      } else if (Object.prototype.hasOwnProperty.call(previous, field)
        && previous[field] !== undefined
        && !isEmptyPlainObject(previous[field])
        && !isDeepStrictEqual(previous[field], bounded.value)) {
        // Preserve conflicting input evidence so decideAntigravityPermission fails closed.
        next.inputOverflow = true;
      } else {
        next[field] = bounded.value;
      }
    } else if (Object.prototype.hasOwnProperty.call(previous, field) && previous[field] !== undefined) {
      next[field] = previous[field];
    }
  }

  if (incoming.locations !== undefined) {
    if (!Array.isArray(incoming.locations)) {
      next.locations = incoming.locations;
    } else {
      const combined = [...next.locations, ...incoming.locations];
      if (combined.length > MAX_TOOL_LOCATIONS) {
        next.inputOverflow = true;
        next.locations = combined.slice(0, MAX_TOOL_LOCATIONS);
      } else {
        next.locations = combined;
      }
    }
  }

  if (Array.isArray(incoming.content)) {
    const incomingDiffs = incoming.content
      .filter(block => block?.type === 'diff')
      .map(block => ({
        type: 'diff',
        path: block.path,
        oldText: block.oldText === null ? null : ''
      }));
    const combinedDiffs = [...next.content, ...incomingDiffs];
    if (combinedDiffs.length > MAX_TOOL_LOCATIONS) {
      next.inputOverflow = true;
      next.content = combinedDiffs.slice(0, MAX_TOOL_LOCATIONS);
    } else {
      next.content = combinedDiffs;
    }
  }

  if (Object.prototype.hasOwnProperty.call(incoming, 'rawOutput')) {
    next.rawOutput = compactToolOutput(incoming.rawOutput);
  }

  return next;
}

function trackBoundedToolEntry(tools, toolCallId, entry) {
  if (!tools.has(toolCallId) && tools.size >= MAX_TRACKED_TOOLS) {
    let victimKey = null;
    for (const [key, candidate] of tools.entries()) {
      if (candidate.completedEmitted) {
        victimKey = key;
        break;
      }
    }
    if (victimKey === null) {
      victimKey = tools.keys().next().value;
    }
    if (victimKey !== undefined) {
      tools.delete(victimKey);
    }
  }
  tools.set(toolCallId, entry);
}

function buildToolSessionItem(tool, workspacePath) {
  const declined = Boolean(tool.permissionDenied);
  const terminal = ['completed', 'failed', 'cancelled'].includes(tool.status);
  const failed = tool.status === 'failed';
  if (tool.kind === 'execute') {
    const rawInput = tool.rawInput && typeof tool.rawInput === 'object' ? tool.rawInput : {};
    const argsObj = tool.args && typeof tool.args === 'object' ? tool.args : {};
    const command = String(
      rawInput.CommandLine
      || rawInput.command
      || argsObj.CommandLine
      || argsObj.command
      || tool.title
      || 'command'
    ).slice(0, 500);
    const rawOutput = tool.rawOutput;
    const output = typeof rawOutput === 'string'
      ? rawOutput
      : typeof rawOutput?.stdout === 'string'
        ? rawOutput.stdout
        : typeof rawOutput?.output === 'string'
          ? rawOutput.output
          : typeof rawOutput?.text === 'string'
            ? rawOutput.text
            : '';
    const exitCode = Number.isInteger(rawOutput?.exitCode)
      ? rawOutput.exitCode
      : Number.isInteger(rawOutput?.exit_code)
        ? rawOutput.exit_code
        : undefined;
    return {
      id: tool.toolCallId,
      type: 'commandExecution',
      command,
      status: declined ? 'declined' : failed ? 'failed' : (terminal ? 'completed' : 'inProgress'),
      aggregatedOutput: output,
      ...(exitCode !== undefined ? { exitCode } : {})
    };
  }

  const diffs = Array.isArray(tool.content)
    ? tool.content.filter(block => block?.type === 'diff' && typeof block.path === 'string' && block.path)
    : [];
  if (WRITE_TOOL_KINDS.has(tool.kind) || diffs.length) {
    const rawPaths = diffs.length
      ? diffs.map(diff => diff.path)
      : (Array.isArray(tool.locations) ? tool.locations.map(loc => loc?.path).filter(Boolean) : []);
    const uniquePaths = [...new Set(rawPaths)];
    const changes = uniquePaths.map(filePath => {
      const diff = diffs.find(entry => entry.path === filePath);
      const displayPath = toWorkspaceDisplayPath(filePath, workspacePath);
      const kind = tool.kind === 'delete'
        ? 'delete'
        : tool.kind === 'move'
          ? 'move'
          : diff?.oldText === null
            ? 'add'
            : 'update';
      return { path: displayPath, kind };
    });
    return {
      id: tool.toolCallId,
      type: 'fileChange',
      status: declined ? 'declined' : failed ? 'failed' : (terminal ? 'completed' : 'inProgress'),
      changes
    };
  }

  const labelSource = String(tool.title || tool.name || tool.kind || 'Antigravity tool');
  return {
    id: tool.toolCallId,
    type: 'dynamicToolCall',
    tool: labelSource.slice(0, 160),
    status: declined ? 'declined' : failed ? 'failed' : (terminal ? 'completed' : 'inProgress')
  };
}

function safeNonNegativeInt(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function runAntigravitySession(input = {}) {
  throwIfAborted(input.signal);
  if (input.operation === 'compact') {
    throw codedError('antigravity_unsupported_operation', 'Context compaction is not supported for Antigravity sessions.');
  }
  if (input.installCodexOverleafSkillsTarget === true) {
    throw codedError('antigravity_unsupported_operation', 'Skill installation is not supported for Antigravity sessions.');
  }

  const env = input.env || process.env;
  const executable = resolveAntigravityExecutable(env);
  if (!executable) {
    throw codedError('antigravity_not_found', 'Antigravity CLI (`agy`) was not found.');
  }
  const geminiDir = resolveAntigravityGeminiDir(env);
  const workspacePath = path.resolve(input.workspacePath || process.cwd());
  const writingStyleRoot = typeof input.writingStyleRoot === 'string' && input.writingStyleRoot.trim()
    ? path.resolve(input.writingStyleRoot)
    : null;
  const emit = typeof input.emit === 'function' ? input.emit : () => {};

  const emitEvent = (type, title, detail = {}, status = 'running') => {
    emit({
      type,
      title,
      status,
      detail,
      timestamp: new Date().toISOString()
    });
  };
  const emitSessionEvent = (method, params = {}, status = 'running', title = method) => {
    emitEvent('codex.session.event', title, { method, params }, status);
  };

  let client = null;
  let activeSessionId = '';
  let activeThreadId = '';
  let activeTurnId = '';
  let promptSubmitted = false;
  let turnActive = false;
  let cancelRequested = false;
  let timedOutError = null;
  let resolveCancelWait = null;
  const cancelGraceExpired = new Promise(resolve => { resolveCancelWait = resolve; });
  let cancelGraceTimer = null;
  const setupAbortController = new AbortController();

  const configState = { options: [], currentModeId: '', currentModelId: '' };
  const tools = new Map();
  let promptCycle = 0;
  let declinedInCycle = [];
  let messageSeq = 0;
  let thoughtSeq = 0;
  let openThought = null;
  const messagesByKey = new Map();
  let totalMessageBytes = 0;
  let totalThoughtBytes = 0;
  let lastUsageWindow = null;
  let lastUsageUsed = null;

  const finalizeOpenThought = () => {
    if (!openThought) return;
    const finished = openThought;
    openThought = null;
    emitSessionEvent('item/completed', {
      threadId: activeThreadId,
      turnId: activeTurnId,
      item: {
        id: finished.id,
        type: 'reasoning',
        summary: [finished.text],
        status: 'completed'
      }
    }, 'completed');
  };

  const finalizeAllMessages = () => {
    for (const entry of messagesByKey.values()) {
      if (entry.completedEmitted) continue;
      entry.completedEmitted = true;
      emitSessionEvent('item/completed', {
        threadId: activeThreadId,
        turnId: activeTurnId,
        item: {
          id: entry.id,
          type: 'agentMessage',
          text: entry.text,
          status: 'completed'
        }
      }, 'completed');
    }
  };

  const requestTurnCancel = abortReason => {
    if (!setupAbortController.signal.aborted) {
      setupAbortController.abort(abortReason || timedOutError || getAbortReason(input.signal));
    }
    if (cancelRequested) return;
    cancelRequested = true;
    if (promptSubmitted && activeSessionId && client) {
      try {
        client.cancelPendingPermissions(activeSessionId);
        client.notify('session/cancel', { sessionId: activeSessionId });
      } catch (_error) {}
      cancelGraceTimer = setTimeout(() => resolveCancelWait({ cancelGraceTimeout: true }), ANTIGRAVITY_CANCEL_GRACE_MS);
    } else {
      resolveCancelWait({ cancelGraceTimeout: true });
    }
  };

  const assertSetupActive = () => {
    if (timedOutError) {
      throw timedOutError;
    }
    throwIfAborted(input.signal);
    if (cancelRequested || setupAbortController.signal.aborted) {
      if (setupAbortController.signal.reason instanceof Error) {
        throw setupAbortController.signal.reason;
      }
      throw getAbortReason(input.signal);
    }
  };

  const onAbort = () => {
    requestTurnCancel(getAbortReason(input.signal));
  };
  input.signal?.addEventListener('abort', onAbort, { once: true });

  const timeout = createOptionalTimeout(env.CODEX_OVERLEAF_CODEX_TIMEOUT_MS, timeoutMs => {
    timedOutError = new Error(`Antigravity ACP did not complete within configured timeout (${timeoutMs}ms)`);
    requestTurnCancel(timedOutError);
  });
  const idleTimeoutMs = parseOptionalPositiveInteger(env.CODEX_OVERLEAF_CODEX_IDLE_TIMEOUT_MS) || 600000;
  const idleWatchdog = createCodexIdleWatchdog(idleTimeoutMs, ms => {
    timedOutError = new Error(`Antigravity ACP produced no events for ${ms}ms (idle watchdog); the run was aborted to release the project lock.`);
    requestTurnCancel(timedOutError);
  });

  try {
    assertSetupActive();
    client = new AntigravityAcpClient(executable, {
      cwd: workspacePath,
      geminiDir,
      env,
      onProcessStarted: input.onProcessStarted,
      onActivity: () => idleWatchdog.reset(),
      onRequest: async message => {
        if (message.method !== 'session/request_permission') {
          throw Object.assign(new Error('Method not found'), { rpcCode: -32601 });
        }
        const params = message.params || {};
        if (!turnActive || cancelRequested || params.sessionId !== activeSessionId) {
          return selectPermissionOutcome(false, params.options).response;
        }
        const partial = params.toolCall && typeof params.toolCall === 'object' ? params.toolCall : {};
        const toolCallId = typeof partial.toolCallId === 'string' && partial.toolCallId
          ? partial.toolCallId
          : '';
        const cached = toolCallId ? tools.get(toolCallId) : null;
        const mergedToolCall = cached
          ? mergeBoundedToolRecord(cached.tool, partial)
          : mergeBoundedToolRecord({}, partial);

        const effectiveToolCall = partial && typeof partial === 'object'
          ? {
              ...mergedToolCall,
              ...(Object.prototype.hasOwnProperty.call(partial, 'rawInput') ? { rawInput: partial.rawInput } : {}),
              ...(Object.prototype.hasOwnProperty.call(partial, 'args') ? { args: partial.args } : {})
            }
          : partial;

        const decision = decideAntigravityPermission({
          mode: input.mode,
          workspacePath,
          writingStyleRoot,
          toolCall: effectiveToolCall,
          options: params.options,
          env
        });

        const commandName = decision.kind === 'execute'
          ? extractSafeCommandExecutable(extractToolCommandLine(effectiveToolCall))
          : '';

        if (!decision.allowed) {
          declinedInCycle.push(describeDeclinedPermissionForPrompt(decision, effectiveToolCall, workspacePath, env));
          const declinedId = toolCallId || `declined-tool-${tools.size + 1}`;
          const entry = cached || { tool: {}, startedEmitted: false, completedEmitted: false };
          entry.tool = mergeBoundedToolRecord(entry.tool, {
            ...mergedToolCall,
            toolCallId: declinedId,
            kind: decision.kind !== 'unknown' ? decision.kind : mergedToolCall.kind,
            permissionDenied: true
          });
          trackBoundedToolEntry(tools, declinedId, entry);
          finalizeOpenThought();
          const declinedItem = buildToolSessionItem(entry.tool, workspacePath);
          if (!entry.startedEmitted) {
            entry.startedEmitted = true;
            emitSessionEvent('item/started', {
              threadId: activeThreadId,
              turnId: activeTurnId,
              item: { ...declinedItem, status: 'inProgress' }
            }, 'running');
          }
          if (!entry.completedEmitted) {
            entry.completedEmitted = true;
            emitSessionEvent('item/completed', {
              threadId: activeThreadId,
              turnId: activeTurnId,
              item: declinedItem
            }, 'skipped');
          }
        }

        const eventMethod = mapApprovalMethodForEvent(decision.kind);
        emitEvent('codex.session.request', eventMethod, {
          method: eventMethod,
          acpMethod: 'session/request_permission',
          decision: decision.decision,
          kind: decision.kind,
          reason: decision.reason,
          ...(commandName ? { commandName } : {}),
          toolCallId: String(mergedToolCall?.toolCallId || ''),
          params: {
            kind: decision.kind,
            title: String(mergedToolCall?.title || '').slice(0, 200)
          }
        }, 'running');

        return decision.response;
      },
      onNotification: message => {
        if (message.method !== 'session/update') return;
        const params = message.params || {};
        const update = params.update;
        if (!update || typeof update.sessionUpdate !== 'string') return;
        if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
          if (!activeSessionId || params.sessionId === activeSessionId) {
            configState.options = update.configOptions;
          }
          return;
        }
        if (!turnActive || params.sessionId !== activeSessionId) return;

        switch (update.sessionUpdate) {
          case 'agent_thought_chunk': {
            const rawDelta = update.content?.type === 'text' && typeof update.content.text === 'string'
              ? update.content.text
              : '';
            if (!rawDelta) break;
            const remaining = MAX_TURN_TEXT_BYTES - totalThoughtBytes;
            if (remaining <= 0) break;
            const delta = truncateStringToUtf8Bytes(rawDelta, remaining);
            if (!delta) break;
            totalThoughtBytes += Buffer.byteLength(delta, 'utf8');
            if (!openThought) {
              thoughtSeq += 1;
              openThought = { id: `thought-${thoughtSeq}`, text: '' };
              emitSessionEvent('item/started', {
                threadId: activeThreadId,
                turnId: activeTurnId,
                item: { id: openThought.id, type: 'reasoning', summary: [] }
              }, 'running');
            }
            openThought.text += delta;
            emitSessionEvent('item/reasoning/summaryTextDelta', {
              threadId: activeThreadId,
              turnId: activeTurnId,
              itemId: openThought.id,
              delta
            }, 'running');
            break;
          }
          case 'agent_message_chunk': {
            const rawDelta = update.content?.type === 'text' && typeof update.content.text === 'string'
              ? update.content.text
              : '';
            if (!rawDelta) break;
            finalizeOpenThought();
            const remaining = MAX_TURN_TEXT_BYTES - totalMessageBytes;
            if (remaining <= 0) break;
            const delta = truncateStringToUtf8Bytes(rawDelta, remaining);
            if (!delta) break;
            totalMessageBytes += Buffer.byteLength(delta, 'utf8');

            const rawMessageKey = typeof update.messageId === 'string' && update.messageId.trim()
              ? update.messageId.trim()
              : '__default__';
            const messageKey = `${promptCycle}:${rawMessageKey}`;
            let entry = messagesByKey.get(messageKey);
            if (!entry) {
              messageSeq += 1;
              entry = {
                id: `msg-${messageSeq}`,
                key: messageKey,
                text: '',
                completedEmitted: false
              };
              messagesByKey.set(messageKey, entry);
              emitSessionEvent('item/started', {
                threadId: activeThreadId,
                turnId: activeTurnId,
                item: { id: entry.id, type: 'agentMessage', text: '' }
              }, 'running');
            }
            entry.text += delta;
            emitSessionEvent('item/agentMessage/delta', {
              threadId: activeThreadId,
              turnId: activeTurnId,
              itemId: entry.id,
              delta
            }, 'running');
            break;
          }
          case 'tool_call':
          case 'tool_call_update': {
            if (typeof update.toolCallId !== 'string' || !update.toolCallId) break;
            finalizeOpenThought();
            const existing = tools.get(update.toolCallId) || { tool: {}, startedEmitted: false, completedEmitted: false };
            existing.tool = mergeBoundedToolRecord(existing.tool, update);
            trackBoundedToolEntry(tools, update.toolCallId, existing);
            const item = buildToolSessionItem(existing.tool, workspacePath);
            const isTerminal = ['completed', 'failed', 'cancelled'].includes(existing.tool.status);
            if (!existing.startedEmitted) {
              existing.startedEmitted = true;
              emitSessionEvent('item/started', {
                threadId: activeThreadId,
                turnId: activeTurnId,
                item: { ...item, status: 'inProgress' }
              }, 'running');
            }
            if ((isTerminal || existing.tool.permissionDenied) && !existing.completedEmitted) {
              existing.completedEmitted = true;
              const outerStatus = existing.tool.permissionDenied
                ? 'skipped'
                : existing.tool.status === 'failed'
                  ? 'failed'
                  : 'completed';
              emitSessionEvent('item/completed', {
                threadId: activeThreadId,
                turnId: activeTurnId,
                item
              }, outerStatus);
            }
            break;
          }
          case 'plan': {
            const entries = Array.isArray(update.entries) ? update.entries.slice(0, 64) : [];
            emitSessionEvent('turn/plan/updated', {
              threadId: activeThreadId,
              turnId: activeTurnId,
              plan: entries.map(entry => ({
                step: String(entry?.content || entry?.step || '').slice(0, 500),
                status: entry?.status === 'in_progress'
                  ? 'in_progress'
                  : entry?.status === 'completed'
                    ? 'completed'
                    : 'pending'
              }))
            }, 'running');
            break;
          }
          case 'usage_update': {
            const used = safeNonNegativeInt(update.used);
            const size = safeNonNegativeInt(update.size);
            if (size !== null && size > 0) lastUsageWindow = size;
            if (used !== null) {
              lastUsageUsed = used;
              emitSessionEvent('thread/tokenUsage/updated', {
                threadId: activeThreadId,
                turnId: activeTurnId,
                tokenUsage: {
                  last: { totalTokens: used },
                  modelContextWindow: lastUsageWindow
                }
              }, 'running');
            }
            break;
          }
          default:
            break;
        }
      }
    });

    const initResult = await initializeAcpClient(client, setupAbortController.signal);
    assertSetupActive();
    const rawThreadId = String(input.threadId || '').trim();
    const resumeSessionId = stripAntigravityThreadPrefix(rawThreadId);

    if (rawThreadId && !resumeSessionId) {
      emitEvent(
        'antigravity.thread.fresh',
        'Started a new Antigravity session because the previous conversation belonged to Codex.',
        { previousThreadId: rawThreadId },
        'warning'
      );
    }

    if (resumeSessionId) {
      try {
        const resumeResult = await client.request('session/resume', {
          sessionId: resumeSessionId,
          cwd: workspacePath,
          mcpServers: []
        }, {
          signal: setupAbortController.signal,
          onResponse: res => captureSessionConfigMetadata(configState, res)
        });
        activeSessionId = String(resumeResult?.sessionId || resumeSessionId).trim();
      } catch (resumeError) {
        assertSetupActive();
        if (isAntigravityAuthError(resumeError)) {
          throw mapAntigravityError(resumeError);
        }
        throw codedError(
          'thread_resume_failed',
          sanitizeProviderMessage(resumeError?.message || 'Antigravity session/resume failed.'),
          { cause: resumeError }
        );
      }
    } else {
      const newSessionResult = await client.request('session/new', {
        cwd: workspacePath,
        mcpServers: []
      }, {
        signal: setupAbortController.signal,
        onResponse: res => {
          if (typeof res?.sessionId === 'string' && res.sessionId.trim()) {
            activeSessionId = res.sessionId.trim();
          }
          captureSessionConfigMetadata(configState, res);
        }
      });
      activeSessionId = activeSessionId || String(newSessionResult?.sessionId || '').trim();
      if (!activeSessionId) {
        throw codedError('antigravity_session_invalid', 'Antigravity did not return a session id.');
      }
    }

    assertSetupActive();
    activeThreadId = formatAntigravityThreadId(activeSessionId);
    await applyExplicitSessionConfig(client, activeSessionId, configState, input, setupAbortController.signal);
    assertSetupActive();

    activeTurnId = `agy-turn-${crypto.randomUUID()}`;
    const control = Object.freeze({
      providerId: ANTIGRAVITY_PROVIDER_ID,
      threadId: activeThreadId,
      turnId: activeTurnId,
      steer: () => Promise.reject(codedError(
        'antigravity_unsupported_operation',
        'In-turn steering is not supported for Antigravity runs.'
      )),
      interrupt: () => {
        requestTurnCancel();
        return Promise.resolve({ interrupted: true });
      }
    });
    assertSetupActive();
    input.onControlReady?.(control);
    assertSetupActive();

    emitEvent('codex.turn.bound', 'Antigravity turn started', {
      threadId: activeThreadId,
      turnId: activeTurnId
    }, 'running');
    emitSessionEvent('turn/started', {
      threadId: activeThreadId,
      turnId: activeTurnId,
      turn: { id: activeTurnId, status: 'inProgress' }
    }, 'running');

    let currentPromptBlocks = buildPromptBlocks(input, initResult);
    assertSetupActive();

    const emitPromptUsageIfPresent = rawUsage => {
      if (!rawUsage || typeof rawUsage !== 'object') return;
      let inputTokens = safeNonNegativeInt(rawUsage.inputTokens);
      const cachedRead = safeNonNegativeInt(rawUsage.cachedReadTokens);
      const cachedWrite = safeNonNegativeInt(rawUsage.cachedWriteTokens);
      const outputTokens = safeNonNegativeInt(rawUsage.outputTokens);
      const totalTokens = safeNonNegativeInt(rawUsage.totalTokens);
      if (inputTokens !== null) {
        if (cachedRead !== null) inputTokens += cachedRead;
        if (cachedWrite !== null) inputTokens += cachedWrite;
      }
      const usedTokens = lastUsageUsed !== null
        ? lastUsageUsed
        : (totalTokens !== null ? totalTokens : inputTokens);
      if (usedTokens !== null) {
        emitSessionEvent('thread/tokenUsage/updated', {
          threadId: activeThreadId,
          turnId: activeTurnId,
          tokenUsage: {
            last: {
              totalTokens: usedTokens,
              ...(inputTokens !== null ? { inputTokens } : {}),
              ...(outputTokens !== null ? { outputTokens } : {}),
              ...(cachedRead !== null && inputTokens !== null && cachedRead <= inputTokens ? { cachedInputTokens: cachedRead } : {})
            },
            modelContextWindow: lastUsageWindow
          }
        }, 'running');
      }
    };

    const assertContinuationActive = () => {
      if (timedOutError) {
        throw timedOutError;
      }
      if (cancelRequested || input.signal?.aborted) {
        throw getAbortReason(input.signal);
      }
    };

    let continuationCount = 0;
    while (true) {
      assertContinuationActive();
      declinedInCycle = [];
      lastUsageUsed = null;
      turnActive = true;
      promptSubmitted = true;

      const promptPromise = client.request('session/prompt', {
        sessionId: activeSessionId,
        prompt: currentPromptBlocks
      }, { timeoutMs: 0 });
      const promptOutcome = promptPromise.then(result => ({ result }), error => ({ error }));
      const outcome = await Promise.race([promptOutcome, cancelGraceExpired]);
      turnActive = false;

      if (timedOutError) {
        throw timedOutError;
      }
      if (outcome.cancelGraceTimeout || cancelRequested || input.signal?.aborted) {
        throw getAbortReason(input.signal);
      }
      if (outcome.error) {
        throw mapAntigravityError(outcome.error, 'codex_turn_failed');
      }

      const promptResult = outcome.result || {};
      const stopReason = String(promptResult.stopReason || '');
      finalizeOpenThought();
      finalizeAllMessages();

      if (stopReason === 'cancelled') {
        emitSessionEvent('turn/completed', {
          threadId: activeThreadId,
          turnId: activeTurnId,
          turn: { id: activeTurnId, status: 'interrupted', error: null }
        }, 'cancelled');
        throw codedError('codex_cancelled', 'Codex run was cancelled by the user');
      }
      if (stopReason !== 'end_turn') {
        const turnFailure = codedError(
          'codex_turn_failed',
          `Antigravity turn ended with stop reason "${sanitizeProviderMessage(stopReason || 'unknown')}".`
        );
        emitSessionEvent('turn/completed', {
          threadId: activeThreadId,
          turnId: activeTurnId,
          turn: { id: activeTurnId, status: 'failed', error: { message: turnFailure.message } }
        }, 'failed');
        throw turnFailure;
      }

      emitPromptUsageIfPresent(promptResult.usage);

      if (declinedInCycle.length === 0 || continuationCount >= MAX_PERMISSION_CONTINUATIONS) {
        break;
      }

      assertContinuationActive();
      const declinedSnapshot = declinedInCycle;
      continuationCount += 1;
      promptCycle += 1;
      const continuationText = buildAntigravityContinuationPrompt(declinedSnapshot, input.mode);
      emitEvent(
        'antigravity.turn.continued',
        'A request was blocked; Antigravity was told why and continued.',
        {
          threadId: activeThreadId,
          turnId: activeTurnId,
          continuation: continuationCount,
          maxContinuations: MAX_PERMISSION_CONTINUATIONS,
          blockedCount: declinedSnapshot.length,
          reasons: [...new Set(declinedSnapshot.map(item => item.reason).filter(Boolean))]
        },
        'warning'
      );
      assertContinuationActive();
      currentPromptBlocks = [{ type: 'text', text: continuationText }];
    }

    emitSessionEvent('turn/completed', {
      threadId: activeThreadId,
      turnId: activeTurnId,
      turn: { id: activeTurnId, status: 'completed', error: null }
    }, 'completed');

    await client.close();
    client = null;

    const assistantMessage = Array.from(messagesByKey.values())
      .map(entry => String(entry.text || '').trim())
      .filter(Boolean)
      .at(-1) || '';

    return {
      assistantMessage,
      threadId: activeThreadId
    };
  } catch (rawError) {
    const mapped = mapAntigravityError(rawError);
    if (client) {
      try {
        await client.close({ reason: mapped });
      } catch (stopError) {
        throw stopError;
      }
      client = null;
    }
    throw mapped;
  } finally {
    turnActive = false;
    clearTimeout(cancelGraceTimer);
    timeout.cancel();
    idleWatchdog.cancel();
    input.signal?.removeEventListener('abort', onAbort);
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

module.exports = {
  ANTIGRAVITY_DEFAULT_MODEL,
  ANTIGRAVITY_PROVIDER_ID,
  ANTIGRAVITY_PROVIDER_NAME,
  ANTIGRAVITY_THREAD_PREFIX,
  buildAntigravityModelCatalog,
  decideAntigravityPermission,
  evaluateAntigravityCommand,
  evaluateMirrorWorkspacePath,
  evaluateWritingStyleBundlePath,
  formatAntigravityThreadId,
  getAntigravityStatus,
  isAntigravityAuthError,
  isAntigravityRateLimitError,
  isAntigravityThreadId,
  loginAntigravity,
  mapAntigravityError,
  probeAntigravityCliVersion,
  resolveAntigravityGeminiDir,
  resolveAntigravityModels,
  runAntigravitySession,
  selectPermissionOutcome,
  stripAntigravityThreadPrefix
};
