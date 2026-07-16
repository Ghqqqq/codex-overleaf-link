'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  computeConnectionFingerprint,
  computeDraftFingerprint,
  getEndpointHost,
  isResolvedWireApi,
  normalizeProviderDraft,
  normalizeSecret,
  providerError,
  sanitizeProfile
} = require('./providerProfile');

const SCHEMA_VERSION = 1;
const STORE_LOCK_TIMEOUT_MS = 2500;
const STORE_LOCK_STALE_MS = 30000;
const STORE_LOCK_RETRY_MS = 25;
const heldStoreLocks = new Set();

function listProviders(env = process.env) {
  return withProviderStoreLock(env, () => listProvidersUnlocked(env));
}

function upsertProvider(params = {}, env = process.env) {
  return withProviderStoreLock(env, () => upsertProviderUnlocked(params, env));
}

function activateProvider(params = {}, env = process.env) {
  return withProviderStoreLock(env, () => activateProviderUnlocked(params, env));
}

function deleteProvider(params = {}, env = process.env) {
  return withProviderStoreLock(env, () => deleteProviderUnlocked(params, env));
}

function clearProviderSecret(params = {}, env = process.env) {
  return withProviderStoreLock(env, () => clearProviderSecretUnlocked(params, env));
}

function recordProviderDiagnostic(params = {}, env = process.env) {
  return withProviderStoreLock(env, () => recordProviderDiagnosticUnlocked(params, env));
}

function resolveDraftSecret(params = {}, env = process.env) {
  return withProviderStoreLock(env, () => resolveDraftSecretUnlocked(params, env));
}

function loadProviderState(env = process.env) {
  return withProviderStoreLock(env, () => loadProviderStateUnlocked(env));
}

function listProvidersUnlocked(env = process.env) {
  const state = loadProviderState(env);
  return buildCatalog(state);
}

function upsertProviderUnlocked(params = {}, env = process.env) {
  const state = loadProviderState(env);
  const now = Date.now();
  const requestedId = normalizeId(params.profileId);
  const existing = requestedId ? state.public.profiles.find(profile => profile.id === requestedId) : null;
  const expectedRevision = normalizeRevision(params.expectedRevision);
  if (existing && existing.revision !== expectedRevision) {
    throw providerError('provider_revision_conflict', 'Provider changed in another tab. Reload it and retry.');
  }
  if (!existing && requestedId && expectedRevision !== 0) {
    throw providerError('provider_not_found', 'Provider no longer exists.');
  }
  const id = existing?.id || crypto.randomUUID();
  const draft = normalizeProviderDraft(params.draft || {});
  const currentSecret = state.secrets.secrets[id] || '';
  const secret = applySecretMutation(currentSecret, params.secretMutation);
  const providedDiagnostics = normalizeProvidedDiagnostics(params);
  const modelDiagnostics = {};
  for (const model of draft.models) {
    const connectionFingerprint = computeConnectionFingerprint(draft, secret, model.id);
    const provided = providedDiagnostics.get(model.id);
    const previous = existing?.modelDiagnostics?.[model.id];
    if (provided?.connectionFingerprint === connectionFingerprint && isResolvedWireApi(provided.wireApi)) {
      modelDiagnostics[model.id] = buildStoredDiagnostic(provided, connectionFingerprint, now);
    } else if (previous?.connectionFingerprint === connectionFingerprint && isResolvedWireApi(previous.wireApi)) {
      modelDiagnostics[model.id] = { ...previous };
    }
  }
  const defaultDiagnostic = modelDiagnostics[draft.defaultModelId];
  const resolvedWireApi = draft.wireApiPreference === 'auto'
    ? defaultDiagnostic?.wireApi || ''
    : draft.wireApiPreference;
  const models = draft.models.map(model => {
    const diagnostic = modelDiagnostics[model.id];
    return {
      ...model,
      resolvedUpstreamResponseMode: diagnostic?.upstreamResponseMode || ''
    };
  });
  const endpointHost = getEndpointHost(draft.baseUrl);
  const destinationUnchanged = Boolean(existing && existing.baseUrl === draft.baseUrl);
  let endpointDisclosureHost = destinationUnchanged && existing?.endpointDisclosureHost === endpointHost
    ? existing.endpointDisclosureHost
    : '';
  let endpointDisclosureBaseUrl = destinationUnchanged && existing?.endpointDisclosureBaseUrl === draft.baseUrl
    ? existing.endpointDisclosureBaseUrl
    : '';
  let endpointDisclosureAcceptedAt = endpointDisclosureHost && endpointDisclosureBaseUrl
    ? existing?.endpointDisclosureAcceptedAt || now
    : 0;
  if (params.activate === true) {
    assertCanActivate({
      profile: { ...draft, resolvedWireApi },
      disclosureHost: params.disclosureHost,
      disclosureBaseUrl: params.disclosureBaseUrl,
      endpointHost
    });
    endpointDisclosureHost = endpointHost;
    endpointDisclosureBaseUrl = draft.baseUrl;
    endpointDisclosureAcceptedAt = now;
  }
  const revision = (existing?.revision || 0) + 1;
  const secretMutationKind = params.secretMutation?.kind || 'unchanged';
  const secretUpdatedAt = secret
    ? (secretMutationKind === 'replace' ? now : existing?.secretUpdatedAt || 0)
    : 0;
  const profile = {
    id,
    revision,
    ...draft,
    models,
    resolvedWireApi,
    endpointDisclosureHost,
    endpointDisclosureBaseUrl,
    endpointDisclosureAcceptedAt,
    secretUpdatedAt,
    modelDiagnostics,
    lastVerified: defaultDiagnostic
      ? {
          revision,
          at: defaultDiagnostic.at,
          modelId: draft.defaultModelId,
          wireApi: defaultDiagnostic.wireApi,
          upstreamResponseMode: defaultDiagnostic.upstreamResponseMode,
          draftFingerprint: defaultDiagnostic.connectionFingerprint
        }
      : null,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  const profiles = existing
    ? state.public.profiles.map(item => item.id === id ? profile : item)
    : [...state.public.profiles, profile];
  const secrets = { ...state.secrets.secrets };
  if (secret) {
    secrets[id] = secret;
  } else {
    delete secrets[id];
  }
  commitProviderState(state, {
    public: {
      ...state.public,
      activeProviderId: params.activate === true
        ? id
        : state.public.activeProviderId === id && endpointDisclosureBaseUrl !== draft.baseUrl
          ? 'builtin'
          : state.public.activeProviderId,
      profiles
    },
    secrets: { ...state.secrets, secrets }
  });
  const next = loadProviderState(env);
  return { ...buildCatalog(next), savedProviderId: id };
}

function activateProviderUnlocked(params = {}, env = process.env) {
  const state = loadProviderState(env);
  const providerId = normalizeId(params.providerId) || 'builtin';
  if (providerId === 'builtin') {
    commitProviderState(state, {
      public: { ...state.public, activeProviderId: 'builtin' },
      secrets: state.secrets
    });
    return buildCatalog(loadProviderState(env));
  }
  const profile = state.public.profiles.find(item => item.id === providerId);
  if (!profile) {
    throw providerError('provider_not_found', 'Provider no longer exists.');
  }
  if (profile.revision !== normalizeRevision(params.expectedRevision)) {
    throw providerError('provider_revision_conflict', 'Provider changed in another tab. Reload it and retry.');
  }
  const endpointHost = getEndpointHost(profile.baseUrl);
  assertCanActivate({
    profile,
    disclosureHost: params.disclosureHost,
    disclosureBaseUrl: params.disclosureBaseUrl,
    endpointHost
  });
  const nextProfile = {
    ...profile,
    revision: profile.revision + 1,
    lastVerified: profile.lastVerified
      ? { ...profile.lastVerified, revision: profile.revision + 1 }
      : null,
    endpointDisclosureHost: endpointHost,
    endpointDisclosureBaseUrl: profile.baseUrl,
    endpointDisclosureAcceptedAt: Date.now(),
    updatedAt: Date.now()
  };
  commitProviderState(state, {
    public: {
      ...state.public,
      activeProviderId: providerId,
      profiles: state.public.profiles.map(item => item.id === providerId ? nextProfile : item)
    },
    secrets: state.secrets
  });
  return buildCatalog(loadProviderState(env));
}

function clearProviderSecretUnlocked(params = {}, env = process.env) {
  const state = loadProviderState(env);
  const providerId = normalizeId(params.providerId);
  const profile = state.public.profiles.find(item => item.id === providerId);
  if (!profile) {
    throw providerError('provider_not_found', 'Provider no longer exists.');
  }
  if (profile.revision !== normalizeRevision(params.expectedRevision)) {
    throw providerError('provider_revision_conflict', 'Provider changed in another tab. Reload it and retry.');
  }
  const nextRevision = profile.revision + 1;
  const nextProfile = {
    ...profile,
    revision: nextRevision,
    resolvedWireApi: profile.wireApiPreference === 'auto' ? '' : profile.wireApiPreference,
    models: profile.models.map(model => ({ ...model, resolvedUpstreamResponseMode: '' })),
    modelDiagnostics: {},
    lastVerified: null,
    secretUpdatedAt: 0,
    updatedAt: Date.now()
  };
  const secrets = { ...state.secrets.secrets };
  delete secrets[providerId];
  commitProviderState(state, {
    public: {
      ...state.public,
      activeProviderId: state.public.activeProviderId === providerId ? 'builtin' : state.public.activeProviderId,
      profiles: state.public.profiles.map(item => item.id === providerId ? nextProfile : item)
    },
    secrets: { ...state.secrets, secrets }
  });
  return buildCatalog(loadProviderState(env));
}

function recordProviderDiagnosticUnlocked(params = {}, env = process.env) {
  const state = loadProviderState(env);
  const providerId = normalizeId(params.profileId);
  const profile = state.public.profiles.find(item => item.id === providerId);
  if (!profile || profile.revision !== normalizeRevision(params.expectedRevision)) {
    return { recorded: false };
  }
  const modelId = String(params.modelId || '').trim();
  const secret = state.secrets.secrets[providerId] || '';
  const connectionFingerprint = computeConnectionFingerprint(profile, secret, modelId);
  if (connectionFingerprint !== String(params.connectionFingerprint || '') || !isResolvedWireApi(params.wireApi)) {
    return { recorded: false };
  }
  const now = Date.now();
  const diagnostic = buildStoredDiagnostic(params, connectionFingerprint, now);
  const modelDiagnostics = {
    ...(profile.modelDiagnostics || {}),
    [modelId]: diagnostic
  };
  const nextProfile = {
    ...profile,
    resolvedWireApi: profile.wireApiPreference === 'auto' && modelId === profile.defaultModelId
      ? diagnostic.wireApi
      : profile.resolvedWireApi,
    models: profile.models.map(model => model.id === modelId
      ? { ...model, resolvedUpstreamResponseMode: diagnostic.upstreamResponseMode }
      : model),
    modelDiagnostics,
    lastVerified: modelId === profile.defaultModelId
      ? {
          revision: profile.revision,
          at: diagnostic.at,
          modelId,
          wireApi: diagnostic.wireApi,
          upstreamResponseMode: diagnostic.upstreamResponseMode,
          draftFingerprint: connectionFingerprint
        }
      : profile.lastVerified,
    updatedAt: now
  };
  commitProviderState(state, {
    public: {
      ...state.public,
      profiles: state.public.profiles.map(item => item.id === providerId ? nextProfile : item)
    },
    secrets: state.secrets
  });
  return { recorded: true };
}

function deleteProviderUnlocked(params = {}, env = process.env) {
  const state = loadProviderState(env);
  const providerId = normalizeId(params.providerId);
  if (!providerId || providerId === 'builtin') {
    throw providerError('provider_not_found', 'Built-in Codex cannot be deleted.');
  }
  const profile = state.public.profiles.find(item => item.id === providerId);
  if (!profile) {
    throw providerError('provider_not_found', 'Provider no longer exists.');
  }
  if (profile.revision !== normalizeRevision(params.expectedRevision)) {
    throw providerError('provider_revision_conflict', 'Provider changed in another tab. Reload it and retry.');
  }
  const secrets = { ...state.secrets.secrets };
  delete secrets[providerId];
  commitProviderState(state, {
    public: {
      ...state.public,
      activeProviderId: state.public.activeProviderId === providerId ? 'builtin' : state.public.activeProviderId,
      profiles: state.public.profiles.filter(item => item.id !== providerId)
    },
    secrets: { ...state.secrets, secrets }
  });
  return buildCatalog(loadProviderState(env));
}

function resolveDraftSecretUnlocked(params = {}, env = process.env) {
  const state = loadProviderState(env);
  const id = normalizeId(params.profileId);
  const existing = id ? state.public.profiles.find(profile => profile.id === id) : null;
  if (existing && existing.revision !== normalizeRevision(params.expectedRevision)) {
    throw providerError('provider_revision_conflict', 'Provider changed in another tab. Reload it and retry.');
  }
  return applySecretMutation(id ? state.secrets.secrets[id] || '' : '', params.secretMutation);
}

function loadProviderStateUnlocked(env = process.env) {
  const paths = getProviderStorePaths(env);
  ensurePrivateDirectory(paths.root);
  recoverInterruptedTransaction(paths);
  const publicStore = readJson(paths.publicFile, defaultPublicStore());
  const secretStore = readJson(paths.secretFile, defaultSecretStore());
  if (publicStore.storeRevision !== secretStore.storeRevision) {
    throw providerError('provider_store_corrupt', 'Provider profile and secret stores are out of sync.');
  }
  const profiles = Array.isArray(publicStore.profiles)
    ? publicStore.profiles.map(normalizeStoredProfile)
    : [];
  return {
    paths,
    public: {
      schemaVersion: SCHEMA_VERSION,
      storeRevision: normalizeRevision(publicStore.storeRevision),
      activeProviderId: normalizeId(publicStore.activeProviderId) || 'builtin',
      profiles
    },
    secrets: {
      schemaVersion: SCHEMA_VERSION,
      storeRevision: normalizeRevision(secretStore.storeRevision),
      secrets: normalizeSecretMap(secretStore.secrets)
    }
  };
}

function commitProviderState(previous, next) {
  const revision = previous.public.storeRevision + 1;
  const nextPublic = { ...next.public, schemaVersion: SCHEMA_VERSION, storeRevision: revision };
  const nextSecrets = { ...next.secrets, schemaVersion: SCHEMA_VERSION, storeRevision: revision };
  const journal = {
    schemaVersion: SCHEMA_VERSION,
    nextRevision: revision,
    previousPublic: previous.public,
    previousSecrets: previous.secrets
  };
  atomicWriteJson(previous.paths.transactionFile, journal);
  try {
    atomicWriteJson(previous.paths.secretFile, nextSecrets);
    atomicWriteJson(previous.paths.publicFile, nextPublic);
    fs.rmSync(previous.paths.transactionFile, { force: true });
  } catch (error) {
    try {
      atomicWriteJson(previous.paths.secretFile, previous.secrets);
      atomicWriteJson(previous.paths.publicFile, previous.public);
      fs.rmSync(previous.paths.transactionFile, { force: true });
    } catch (_restoreError) {
      // The journal remains the recovery source on the next Native Host start.
    }
    throw providerError('provider_store_unavailable', 'Provider settings could not be saved.', { cause: error });
  }
}

function recoverInterruptedTransaction(paths) {
  if (!fs.existsSync(paths.transactionFile)) {
    return;
  }
  const journal = readJson(paths.transactionFile, null);
  if (!journal?.previousPublic || !journal?.previousSecrets) {
    throw providerError('provider_store_corrupt', 'Provider transaction journal is invalid.');
  }
  const currentPublic = readJson(paths.publicFile, defaultPublicStore());
  const currentSecrets = readJson(paths.secretFile, defaultSecretStore());
  if (currentPublic.storeRevision === journal.nextRevision && currentSecrets.storeRevision === journal.nextRevision) {
    fs.rmSync(paths.transactionFile, { force: true });
    return;
  }
  atomicWriteJson(paths.secretFile, journal.previousSecrets);
  atomicWriteJson(paths.publicFile, journal.previousPublic);
  fs.rmSync(paths.transactionFile, { force: true });
}

function buildCatalog(state) {
  const providers = [
    {
      id: 'builtin',
      kind: 'builtin',
      revision: 0,
      name: 'Built-in Codex',
      editable: false,
      deletable: false,
      models: [],
      hasSecret: false
    },
    ...state.public.profiles.map(profile => sanitizeProfile(profile, Boolean(state.secrets.secrets[profile.id])))
  ];
  const activeProviderId = providers.some(provider => provider.id === state.public.activeProviderId)
    ? state.public.activeProviderId
    : 'builtin';
  return {
    activeProviderId,
    providers,
    storeRevision: state.public.storeRevision
  };
}

function assertCanActivate({ profile, disclosureHost, disclosureBaseUrl, endpointHost }) {
  if (!endpointHost
    || endpointHost !== String(disclosureHost || '').trim()
    || profile.baseUrl !== String(disclosureBaseUrl || '').trim()) {
    throw providerError('provider_disclosure_required', 'Confirm the provider endpoint before activation.');
  }
}

function normalizeProvidedDiagnostics(params = {}) {
  const result = new Map();
  const values = Array.isArray(params.diagnostics) ? params.diagnostics : [];
  for (const value of values) {
    const modelId = String(value?.modelId || value?.testedModelId || '').trim();
    if (modelId) {
      result.set(modelId, {
        ...value,
        connectionFingerprint: String(value.connectionFingerprint || value.draftFingerprint || '')
      });
    }
  }
  if (params.verifiedDraftFingerprint && params.draft?.defaultModelId) {
    result.set(String(params.draft.defaultModelId), {
      modelId: String(params.draft.defaultModelId),
      connectionFingerprint: String(params.verifiedDraftFingerprint),
      wireApi: params.verifiedWireApi,
      upstreamResponseMode: params.verifiedUpstreamResponseMode
    });
  }
  return result;
}

function buildStoredDiagnostic(value, connectionFingerprint, now) {
  const upstreamResponseMode = String(value?.upstreamResponseMode || value?.resolvedUpstreamResponseMode || '').toLowerCase();
  return {
    status: 'tested',
    at: normalizeRevision(value?.at) || now,
    wireApi: String(value?.wireApi || value?.resolvedWireApi || '').toLowerCase(),
    upstreamResponseMode: upstreamResponseMode === 'buffered' ? 'buffered' : 'streaming',
    durationMs: normalizeRevision(value?.durationMs),
    connectionFingerprint
  };
}

function applySecretMutation(currentSecret, mutation = {}) {
  const kind = mutation?.kind || 'unchanged';
  if (kind === 'unchanged') {
    return currentSecret;
  }
  if (kind === 'clear') {
    return '';
  }
  if (kind === 'replace') {
    return normalizeSecret(mutation.value);
  }
  throw providerError('provider_secret_invalid', 'Unknown API key mutation.');
}

function normalizeStoredProfile(value) {
  if (!value || typeof value !== 'object' || !normalizeId(value.id)) {
    throw providerError('provider_store_corrupt', 'Provider store contains an invalid profile.');
  }
  const normalized = normalizeProviderDraft(value);
  return {
    id: normalizeId(value.id),
    revision: Math.max(1, normalizeRevision(value.revision)),
    ...normalized,
    resolvedWireApi: isResolvedWireApi(value.resolvedWireApi) ? value.resolvedWireApi : '',
    endpointDisclosureHost: String(value.endpointDisclosureHost || ''),
    endpointDisclosureBaseUrl: String(value.endpointDisclosureBaseUrl || ''),
    endpointDisclosureAcceptedAt: normalizeRevision(value.endpointDisclosureAcceptedAt),
    secretUpdatedAt: normalizeRevision(value.secretUpdatedAt),
    modelDiagnostics: normalizeStoredDiagnostics(value.modelDiagnostics),
    lastVerified: value.lastVerified && typeof value.lastVerified === 'object' ? { ...value.lastVerified } : null,
    createdAt: normalizeRevision(value.createdAt),
    updatedAt: normalizeRevision(value.updatedAt)
  };
}

function normalizeStoredDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const result = {};
  for (const [modelId, diagnostic] of Object.entries(value).slice(0, 32)) {
    if (!modelId || !diagnostic || typeof diagnostic !== 'object') continue;
    result[modelId] = {
      status: diagnostic.status === 'failed' ? 'failed' : 'tested',
      at: normalizeRevision(diagnostic.at),
      wireApi: isResolvedWireApi(diagnostic.wireApi) ? String(diagnostic.wireApi).toLowerCase() : '',
      upstreamResponseMode: diagnostic.upstreamResponseMode === 'buffered' ? 'buffered' : 'streaming',
      durationMs: normalizeRevision(diagnostic.durationMs),
      errorCode: String(diagnostic.errorCode || ''),
      connectionFingerprint: String(diagnostic.connectionFingerprint || '')
    };
  }
  return result;
}

function normalizeSecretMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const result = {};
  for (const [id, secret] of Object.entries(value)) {
    const normalizedId = normalizeId(id);
    if (normalizedId) {
      result[normalizedId] = normalizeSecret(secret);
    }
  }
  return result;
}

function getProviderStorePaths(env = process.env) {
  const root = path.resolve(env.CODEX_OVERLEAF_PROVIDER_STORE_DIR || path.join(os.homedir(), '.codex-overleaf'));
  return {
    root,
    publicFile: path.join(root, 'providers.json'),
    secretFile: path.join(root, 'provider-secrets.json'),
    transactionFile: path.join(root, 'provider-transaction.json'),
    lockFile: path.join(root, 'provider-store.lock')
  };
}

function withProviderStoreLock(env, callback) {
  const paths = getProviderStorePaths(env);
  ensurePrivateDirectory(paths.root);
  if (heldStoreLocks.has(paths.lockFile)) {
    return callback();
  }
  const lock = acquireProviderStoreLock(paths.lockFile);
  heldStoreLocks.add(paths.lockFile);
  try {
    return callback();
  } finally {
    heldStoreLocks.delete(paths.lockFile);
    releaseProviderStoreLock(paths.lockFile, lock);
  }
}

function acquireProviderStoreLock(lockFile) {
  const deadline = Date.now() + STORE_LOCK_TIMEOUT_MS;
  const token = `${process.pid}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`;
  while (true) {
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeFileSync(fd, token, 'utf8');
      fs.fsyncSync(fd);
      return { fd, token };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw providerError('provider_store_unavailable', 'Provider settings could not be locked.', { cause: error });
      }
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > STORE_LOCK_STALE_MS) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue;
      }
      if (Date.now() >= deadline) {
        throw providerError('provider_store_busy', 'Provider settings are being updated by another Native Host. Retry shortly.');
      }
      sleepSync(STORE_LOCK_RETRY_MS);
    }
  }
}

function releaseProviderStoreLock(lockFile, lock) {
  try {
    fs.closeSync(lock.fd);
  } catch (_error) {}
  try {
    if (fs.readFileSync(lockFile, 'utf8') === lock.token) {
      fs.rmSync(lockFile, { force: true });
    }
  } catch (_error) {}
}

function sleepSync(durationMs) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, durationMs);
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch (_error) {
    // Windows and restricted filesystems may not expose POSIX chmod semantics.
  }
}

function atomicWriteJson(target, value) {
  const temp = `${target}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(temp, 0o600);
  } catch (_error) {}
  fs.renameSync(temp, target);
}

function readJson(target, fallback) {
  if (!fs.existsSync(target)) {
    return fallback;
  }
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size > 1024 * 1024) {
      throw new Error('invalid provider store file');
    }
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    throw providerError('provider_store_corrupt', `Provider store ${path.basename(target)} is invalid.`, { cause: error });
  }
}

function defaultPublicStore() {
  return { schemaVersion: SCHEMA_VERSION, storeRevision: 0, activeProviderId: 'builtin', profiles: [] };
}

function defaultSecretStore() {
  return { schemaVersion: SCHEMA_VERSION, storeRevision: 0, secrets: {} };
}

function normalizeId(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9_-]{1,80}$/.test(text) ? text : '';
}

function normalizeRevision(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

module.exports = {
  activateProvider,
  clearProviderSecret,
  deleteProvider,
  getProviderStorePaths,
  listProviders,
  loadProviderState,
  recordProviderDiagnostic,
  resolveDraftSecret,
  upsertProvider
};
