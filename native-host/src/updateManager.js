'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  BOOTSTRAP_PROTOCOL,
  compareSemver,
  isNewerStableVersion,
  parseSemver,
  updateError,
  verifySignedReleaseManifest
} = require('./updateTrust');
const { extractVerifiedUpdateBundle } = require('./updateArchive');
const { requestRelease } = require('./releaseTransport');
const updateNetwork = require('./updateNetworkControl');
const { readManagedRuntimeEvidence, sameRuntimeEvidence } = require('./managedRuntimeEvidence');
const BootstrapUpdate = require('./bootstrapUpdate');
const RUNNING_VERSION = require('../../package.json').version;

const GITHUB_LATEST_URL = 'https://github.com/Ghqqqq/codex-overleaf-link/releases/latest';
const GITHUB_RELEASE_DOWNLOAD_ROOT = 'https://github.com/Ghqqqq/codex-overleaf-link/releases/download';
const EXTENSION_MARKER = '.codex-overleaf-managed-extension.json';
const NATIVE_MARKER = '.codex-overleaf-managed-native.json';
const JOURNAL_FILE = 'transaction.json';
const CANDIDATE_FILE = 'candidate.json';
const MANUAL_CANDIDATE_FILE = 'manual-candidate.json';
const COOLDOWN_FILE = 'cooldowns.json';
const AUTHORIZATION_FILE = 'authorization.json';
const MUTATION_LOCK_FILE = 'mutation.lock';
const AUTHORIZATION_TTL_MS = 2 * 60 * 60 * 1000;
const MUTATION_LOCK_WAIT_MS = 10 * 1000;
const MUTATION_LOCK_STALE_MS = 15 * 60 * 1000;
const ACTIVATION_DELAY_MS = 125;
const APPLYING_TRANSACTION_STATES = new Set(['activation_pending', 'applying', 'awaiting_health',
  ...BootstrapUpdate.BOOTSTRAP_STATES]);
const CONSENT_MIGRATION_TARGET_VERSION = '1.9.4';
const UPDATE_METHODS = new Set([
  'update.status',
  'update.bootstrap',
  'update.check',
  'update.authorize',
  'update.stage',
  'update.canApply',
  'update.apply',
  'update.activate',
  'update.confirm',
  'update.rollback',
  'update.revoke',
  'update.cancel'
]);
const LAYOUT_GATED_METHODS = new Set([
  'update.check',
  'update.authorize',
  'update.stage',
  'update.apply',
  'update.activate',
  'update.confirm'
]);
const RELEASE_ASSET_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
]);
let updateMutationTail = Promise.resolve();

function isUpdateMethod(method) {
  return UPDATE_METHODS.has(method);
}

async function handleUpdateRequest(request, options = {}) {
  if (!request || !isUpdateMethod(request.method)) {
    return errorResponse(request?.id, 'unknown_update_method', 'Unknown managed update method.');
  }
  try {
    const context = { ...getManagedContext(options), operationId: request.params?.operationId || '' };
    if (!context.managed) {
      throw updateError('update_not_managed', 'Run install-managed once to enable coordinated automatic updates.');
    }
    if (LAYOUT_GATED_METHODS.has(request.method)) {
      assertManagedLayout(context);
    }
    switch (request.method) {
      case 'update.status':
        return okResponse(request.id, readStatusWithoutWaiting(context, request.params || {}));
      case 'update.bootstrap':
        return okResponse(request.id, await withUpdateMutex(context, () => {
          const gate = getApplyGate(options);
          if (!gate.idle) throw updateError('update_native_busy', 'Native host is still processing a Codex task.');
          return BootstrapUpdate.advanceBootstrapMigration(context, readJournal(context),
            request.params || {}, bootstrapDependencies(context), options.bootstrapMigration || {});
        }));
      case 'update.check':
        return okResponse(request.id, await runNetworkUpdate(context, request, options,
          networkOptions => checkForUpdate(context, request.params || {}, networkOptions)));
      case 'update.authorize':
        return okResponse(request.id, await withUpdateMutex(context, () => authorizeUpdate(context, request.params || {})));
      case 'update.stage':
        return okResponse(request.id, await runNetworkUpdate(context, request, options,
          networkOptions => stageCandidate(context, networkOptions)));
      case 'update.canApply':
        return okResponse(request.id, getApplyGate(options));
      case 'update.apply':
        return okResponse(request.id, await withUpdateMutex(context, () => applyStagedUpdate(context, request.params || {}, options)));
      case 'update.activate':
        return okResponse(request.id, await withUpdateMutex(context, () => scheduleStagedActivation(context, request.params || {}, options)));
      case 'update.confirm':
        return okResponse(request.id, await withUpdateMutex(context, () => confirmUpdate(context, request.params || {})));
      case 'update.rollback':
        return okResponse(request.id, await withUpdateMutex(context, () => rollbackUpdate(context, request.params || {})));
      case 'update.cancel':
        return okResponse(request.id, await cancelNetworkUpdate(context, request.params || {}));
      case 'update.revoke': {
        const authorization = readAuthorization(context);
        const params = request.params || {};
        if (authorization?.id === params.authorizationId && authorization.targetVersion === params.targetVersion) {
          const operationId = params.operationId || updateNetwork.readLock(context)?.operationId;
          if (operationId) await cancelNetworkUpdate(context, { ...params, operationId });
        }
        return okResponse(request.id, await withUpdateMutex({ ...context, operationId: '' },
          () => revokeUpdate(context, params)));
      }
      default:
        throw updateError('unknown_update_method', 'Unknown managed update method.');
    }
  } catch (error) {
    const code = safeErrorCode(error);
    return errorResponse(request.id, request.method === 'update.bootstrap' && code === 'update_internal_error'
      ? 'update_bootstrap_failed' : code, safeErrorMessage(error));
  }
}

async function runNetworkUpdate(context, request, options, action) {
  const operationId = context.operationId || (isUuid(request.id) ? request.id : crypto.randomUUID());
  const owned = { ...context, operationId };
  return updateNetwork.run(owned, operationId, signal => withUpdateMutex(owned, () => {
    signal.throwIfAborted();
    return action({ ...options, network: { ...options.network, signal } });
  }), options.network?.signal);
}

async function cancelNetworkUpdate(context, params) {
  const journal = readJournal(context);
  if (journal && (APPLYING_TRANSACTION_STATES.has(journal.state) || journal.sourceActivationPending)) {
    throw updateError('update_revoke_too_late', 'The update is already being installed.');
  }
  return updateNetwork.cancel(context, params.operationId);
}

function withUpdateMutex(context, action) {
  const guardedAction = () => {
    updateNetwork.assertActive(context, context.operationId);
    return withUpdateFileLock(context, () => {
      updateNetwork.assertActive(context, context.operationId);
      return action();
    });
  };
  const result = updateMutationTail.then(guardedAction, guardedAction);
  updateMutationTail = result.catch(() => {});
  return result;
}

async function withUpdateFileLock(context, action) {
  const lock = await acquireUpdateFileLock(context);
  try {
    return await action();
  } finally {
    releaseUpdateFileLock(lock);
  }
}

async function acquireUpdateFileLock(context) {
  const lockPath = path.join(context.updatesRoot, MUTATION_LOCK_FILE);
  const deadline = Date.now() + MUTATION_LOCK_WAIT_MS;
  const token = crypto.randomUUID();
  while (Date.now() <= deadline) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, JSON.stringify({
          token,
          pid: process.pid,
          operationId: context.operationId || '',
          createdAt: Date.now(),
          expiresAt: Date.now() + MUTATION_LOCK_STALE_MS
        }) + '\n');
      } finally {
        fs.closeSync(descriptor);
      }
      return { lockPath, token };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (removeStaleUpdateFileLock(lockPath)) continue;
      await delay(75);
    }
  }
  throw updateError('update_transaction_locked', 'Another Native Host process is already changing the managed update state.');
}

function removeStaleUpdateFileLock(lockPath) {
  const owner = readJsonSafe(lockPath, null);
  const pid = Number(owner?.pid);
  if (Number.isInteger(pid) && pid > 0) {
    // Expiry is not exit evidence. A slow filesystem must not let another
    // process steal a live install/apply lock.
    if (isProcessAlive(pid)) return false;
  } else {
    // The creator may be between exclusive open and writing its owner record.
    try { if (Date.now() - fs.statSync(lockPath).mtimeMs < MUTATION_LOCK_STALE_MS) return false; }
    catch (_error) { return false; }
  }
  try {
    fs.rmSync(lockPath, { force: true });
    return true;
  } catch (_error) {
    return false;
  }
}

function releaseUpdateFileLock(lock) {
  if (!lock?.lockPath || !lock.token) return;
  const owner = readJsonSafe(lock.lockPath, null);
  if (owner?.token === lock.token) fs.rmSync(lock.lockPath, { force: true });
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function bootstrapDependencies(context) {
  return {
    runningVersion: RUNNING_VERSION,
    verifyManifest: verifySignedReleaseManifest,
    verifyArchive: verifyStagedArchive,
    writeJournal: value => writeJournal(context, value),
    assertAuthorization(journal) {
      const authorization = requireAuthorization(context, journal.targetVersion, ['bound'], { activeVersion: journal.sourceVersion });
      if (authorization.id !== journal.authorizationId || authorization.transactionId !== journal.id) {
        throw updateError('update_consent_mismatch', 'Bootstrap update does not match the authorized transaction.');
      }
    }
  };
}

async function recoverBootstrapTransaction(options, transactionId, token) {
  const context = getManagedContext(options);
  if (!context.managed) throw updateError('update_not_managed', 'Managed installation markers are unavailable.');
  return withUpdateMutex(context, () => {
    const journal = readJournal(context);
    if (journal?.id !== transactionId || journal.bootstrapMigration?.watchdogToken !== token) return { state: 'obsolete' };
    if (journal.sourceActivationPending && journal.state === 'rolled_back') {
      finishSourceActivation(context, journal);
      return { state: 'rolled_back', version: journal.sourceVersion };
    }
    if (!BootstrapUpdate.bootstrapExpired(journal)) return { state: journal.state };
    return rollbackUpdate(context, { transactionId, expectedState: journal.state, reasonCode: 'update_bootstrap_health_timeout' });
  });
}

function assertBootstrapBusinessAvailable(request, options = {}) {
  if (isUpdateMethod(request?.method) || ['bridge.ping', 'codex.cancel'].includes(request?.method)) return;
  const context = getManagedContext(options);
  if (!context.managed) return;
  const journal = readJournal(context);
  if (BootstrapUpdate.migrationHint(context, journal) || journal?.sourceActivationPending) {
    throw updateError('update_applying', 'The managed update is still restoring or loading its startup files.');
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function checkForUpdate(context, params = {}, options = {}) {
  const fetchImpl = options.fetch;
  const network = { ...options.network, deadlineAt: Date.now() + 40000 };
  const currentVersion = normalizeCurrentVersion(params.currentVersion, context);
  const authorized = readAuthorizedCandidate(context, currentVersion);
  if (authorized) return authorized;
  const headers = {
    Accept: 'text/html,application/xhtml+xml',
    'User-Agent': 'codex-overleaf-link-updater'
  };
  if (params.etag && typeof params.etag === 'string' && params.etag.length < 300) {
    headers['If-None-Match'] = params.etag;
  }
  const releaseResponse = await requestRelease(GITHUB_LATEST_URL, {
    ...network, fetch: fetchImpl, stage: 'version_check',
    headers,
    method: 'HEAD',
    allowedHosts: new Set(['github.com']),
    httpErrorCode: 'update_github_http_error'
  });
  if (releaseResponse.status === 304) {
    const candidate = readJsonSafe(path.join(context.updatesRoot, CANDIDATE_FILE), null);
    if (candidate?.manifestBase64 && candidate?.signatureBase64
      && params.etag && candidate.etag === params.etag && candidate.currentVersion === currentVersion) {
      try {
        const manifest = verifySignedReleaseManifest(
          Buffer.from(candidate.manifestBase64, 'base64'),
          Buffer.from(candidate.signatureBase64, 'base64')
        );
        if (isNewerStableVersion(manifest.version, currentVersion)) {
          return {
            managed: true,
            available: true,
            currentVersion,
            latestVersion: manifest.version,
            etag: params.etag || candidate.etag || '',
            cached: true
          };
        }
      } catch (_error) {
        // Invalid cached candidates are treated as cache misses.
      }
    }
    const manual = readManualCandidate(context, currentVersion, params.etag);
    if (manual) return { ...manual, etag: params.etag || manual.etag || '', cached: true };
    return { managed: true, available: false, reason: 'not_modified', currentVersion, etag: params.etag || '' };
  }
  if (!releaseResponse.ok) {
    throw updateError('update_github_http_error', 'GitHub update check failed with HTTP ' + releaseResponse.status + '.');
  }
  const releaseTag = parseStableReleaseTag(releaseResponse.url);
  if (!releaseTag) {
    throw updateError('update_github_response_invalid', 'GitHub latest release did not resolve to a stable semantic-version tag.');
  }
  const latestVersion = releaseTag.slice(1);
  // A successful latest response replaces the previous discovery result,
  // including when a release was withdrawn or is now in cooldown.
  fs.rmSync(path.join(context.updatesRoot, MANUAL_CANDIDATE_FILE), { force: true });
  fs.rmSync(path.join(context.updatesRoot, CANDIDATE_FILE), { force: true });
  if (!isNewerStableVersion(latestVersion, currentVersion)) {
    const activeMarker = readJsonSafe(path.join(context.extensionRoot, EXTENSION_MARKER), null);
    const equalVersionPrerelease = compareSemver(latestVersion, currentVersion) === 0
      && activeMarker?.releaseChannel === 'prerelease';
    return {
      managed: true,
      available: false,
      reason: equalVersionPrerelease
        ? 'prerelease_promotion_requires_manual_update'
        : (compareSemver(latestVersion, currentVersion) === 0 ? 'up_to_date' : 'downgrade_rejected'),
      currentVersion,
      latestVersion,
      etag: releaseResponse.headers.get('etag') || ''
    };
  }
  const cooldowns = readJsonSafe(path.join(context.updatesRoot, COOLDOWN_FILE), {});
  if (Number(cooldowns[latestVersion]?.until || 0) > Date.now()) {
    return { managed: true, available: false, reason: 'cooldown', currentVersion, latestVersion,
      cooldownUntil: Number(cooldowns[latestVersion].until), etag: releaseResponse.headers.get('etag') || '' };
  }

  const manifestBytes = await fetchReleaseAsset(
    fetchImpl,
    buildReleaseAssetUrl(releaseTag, 'release-manifest.json'),
    256 * 1024, { ...network, stage: 'release_manifest' }
  );
  const signatureBytes = await fetchReleaseAsset(
    fetchImpl,
    buildReleaseAssetUrl(releaseTag, 'release-manifest.sig'),
    16 * 1024, { ...network, stage: 'release_signature' }
  );
  const manifest = verifySignedReleaseManifest(manifestBytes, signatureBytes, { allowBootstrapMismatch: true });
  if (manifest.version !== latestVersion || manifest.tag !== releaseTag) {
    throw updateError('update_release_manifest_mismatch', 'GitHub release tag does not match the signed update manifest.');
  }
  if (manifest.bootstrapProtocol !== BOOTSTRAP_PROTOCOL) {
    // Never staged: only a reinstall can replace the Bootstrap shell. The user
    // gets the target version and the signed reason instead of a bare error.
    const manual = {
      managed: true,
      available: false,
      reason: 'manual_install_required',
      currentVersion,
      latestVersion,
      installedBootstrapProtocol: BOOTSTRAP_PROTOCOL,
      requiredBootstrapProtocol: manifest.bootstrapProtocol,
      manualInstall: manifest.manualInstall?.reason ? { reason: manifest.manualInstall.reason } : {},
      etag: releaseResponse.headers.get('etag') || ''
    };
    atomicWriteJson(path.join(context.updatesRoot, MANUAL_CANDIDATE_FILE), {
      ...manual,
      checkedAt: new Date().toISOString(),
      manifestBase64: manifestBytes.toString('base64'),
      signatureBase64: signatureBytes.toString('base64')
    });
    return manual;
  }
  const candidate = {
    checkedAt: new Date().toISOString(),
    currentVersion,
    latestVersion,
    etag: releaseResponse.headers.get('etag') || '',
    manifestBase64: manifestBytes.toString('base64'),
    signatureBase64: signatureBytes.toString('base64'),
    bundleUrl: buildReleaseAssetUrl(releaseTag, manifest.updateBundle.name)
  };
  atomicWriteJson(path.join(context.updatesRoot, CANDIDATE_FILE), candidate);
  return { managed: true, available: true, currentVersion, latestVersion, etag: candidate.etag };
}

function readManualCandidate(context, currentVersion, etag) {
  const manual = readJsonSafe(path.join(context.updatesRoot, MANUAL_CANDIDATE_FILE), null);
  if (!etag || manual?.etag !== etag || manual.currentVersion !== currentVersion
    || !manual.manifestBase64 || !manual.signatureBase64) return null;
  try {
    const manifest = verifySignedReleaseManifest(
      Buffer.from(manual.manifestBase64, 'base64'),
      Buffer.from(manual.signatureBase64, 'base64'),
      { allowBootstrapMismatch: true }
    );
    if (!isNewerStableVersion(manifest.version, currentVersion)
      || manifest.bootstrapProtocol === BOOTSTRAP_PROTOCOL) return null;
    return {
      managed: true, available: false, reason: 'manual_install_required',
      currentVersion, latestVersion: manifest.version,
      installedBootstrapProtocol: BOOTSTRAP_PROTOCOL,
      requiredBootstrapProtocol: manifest.bootstrapProtocol,
      manualInstall: manifest.manualInstall?.reason ? { reason: manifest.manualInstall.reason } : {},
      etag
    };
  } catch (_error) {
    return null;
  }
}

function readAuthorizedCandidate(context, currentVersion) {
  const authorization = readAuthorization(context);
  if (!authorization || !['authorized', 'bound'].includes(authorization.state)) return null;
  const candidate = readJsonSafe(path.join(context.updatesRoot, CANDIDATE_FILE), null);
  if (!candidate) throw updateError('update_candidate_missing', 'The authorized update candidate is missing.');
  const manifest = verifySignedReleaseManifest(
    Buffer.from(candidate.manifestBase64 || '', 'base64'),
    Buffer.from(candidate.signatureBase64 || '', 'base64')
  );
  if (candidate.latestVersion !== manifest.version || authorization.targetVersion !== manifest.version ||
      authorization.sourceVersion !== currentVersion || !isNewerStableVersion(manifest.version, currentVersion)) {
    throw updateError('update_consent_mismatch', 'The signed candidate no longer matches the authorized update.');
  }
  requireAuthorization(context, manifest.version, ['authorized', 'bound']);
  return { managed: true, available: true, currentVersion, latestVersion: manifest.version,
    etag: candidate.etag || '', cached: true, authorized: true };
}

function parseStableReleaseTag(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return '';
    const match = url.pathname.match(/^\/Ghqqqq\/codex-overleaf-link\/releases\/tag\/(v\d+\.\d+\.\d+)\/?$/i);
    return match?.[1] || '';
  } catch (_error) {
    return '';
  }
}

function buildReleaseAssetUrl(tag, assetName) {
  if (!/^v\d+\.\d+\.\d+$/.test(String(tag || '')) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(String(assetName || ''))) {
    throw updateError('update_release_asset_invalid', 'Stable release asset metadata is invalid.');
  }
  return GITHUB_RELEASE_DOWNLOAD_ROOT + '/' + tag + '/' + encodeURIComponent(assetName);
}

function authorizeUpdate(context, params = {}) {
  const activeJournal = readJournal(context);
  if (BootstrapUpdate.migrationHint(context, activeJournal) || activeJournal?.sourceActivationPending) {
    throw updateError('update_transaction_in_progress', 'The current Bootstrap update must finish before authorizing another update.');
  }
  const authorizationId = String(params.authorizationId || '');
  const targetVersion = String(params.targetVersion || '');
  const requestedCurrentVersion = String(params.currentVersion || '');
  if (!isUuid(authorizationId)) {
    throw updateError('update_authorization_invalid', 'Update authorization id is invalid.');
  }
  const candidate = readJsonSafe(path.join(context.updatesRoot, CANDIDATE_FILE), null);
  if (!candidate) {
    throw updateError('update_candidate_missing', 'Check for an update before authorizing it.');
  }
  const manifest = verifySignedReleaseManifest(
    Buffer.from(candidate.manifestBase64 || '', 'base64'),
    Buffer.from(candidate.signatureBase64 || '', 'base64')
  );
  const activeVersion = readVersionPointer(context.nativeRoot, 'active-version');
  if (requestedCurrentVersion !== activeVersion ||
      targetVersion !== candidate.latestVersion ||
      targetVersion !== manifest.version ||
      !isNewerStableVersion(targetVersion, activeVersion)) {
    throw updateError('update_consent_mismatch', 'Update authorization does not match the active signed candidate.');
  }
  const existing = readAuthorization(context);
  if (existing?.id === authorizationId &&
      existing.targetVersion === targetVersion &&
      ['authorized', 'bound'].includes(existing.state) &&
      (!existing.expiresAt || Date.parse(existing.expiresAt) > Date.now())) {
    return publicAuthorization(existing);
  }
  if (existing && ['authorized', 'bound'].includes(existing.state)) {
    throw updateError('update_authorization_in_progress', 'Another update authorization is already active.');
  }
  const grantedAt = new Date();
  const authorization = {
    schemaVersion: 1,
    id: authorizationId,
    targetVersion,
    sourceVersion: activeVersion,
    state: 'authorized',
    grantedAt: grantedAt.toISOString(),
    expiresAt: new Date(grantedAt.getTime() + AUTHORIZATION_TTL_MS).toISOString(),
    transactionId: ''
  };
  writeAuthorization(context, authorization);
  return publicAuthorization(authorization);
}

async function stageCandidate(context, options = {}) {
  const activeJournal = readJournal(context);
  if (BootstrapUpdate.migrationHint(context, activeJournal) || activeJournal?.sourceActivationPending) {
    throw updateError('update_transaction_in_progress', 'The current Bootstrap update must finish before staging another update.');
  }
  const candidate = readJsonSafe(path.join(context.updatesRoot, CANDIDATE_FILE), null);
  if (!candidate) {
    throw updateError('update_candidate_missing', 'Check for an update before staging it.');
  }
  const manifestBytes = Buffer.from(candidate.manifestBase64 || '', 'base64');
  const signatureBytes = Buffer.from(candidate.signatureBase64 || '', 'base64');
  const manifest = verifySignedReleaseManifest(manifestBytes, signatureBytes);
  const activeVersion = readVersionPointer(context.nativeRoot, 'active-version');
  if (!isNewerStableVersion(manifest.version, activeVersion)) {
    throw updateError('update_candidate_stale', 'The staged update is no longer newer than the active version.');
  }
  const authorization = requireAuthorization(context, manifest.version, ['authorized', 'bound']);
  const existingJournal = readJournal(context);
  if (existingJournal?.state === 'staged' && existingJournal.targetVersion === manifest.version) {
    if (existingJournal.authorizationId !== authorization.id ||
        (authorization.transactionId && authorization.transactionId !== existingJournal.id)) {
      throw updateError('update_consent_mismatch', 'Staged transaction does not match the active authorization.');
    }
    try {
      verifyStagedArchive(existingJournal);
      verifyStagedPair(existingJournal.payloadRoot, manifest.version);
      bindAuthorization(context, authorization, existingJournal.id);
      return {
        transactionId: existingJournal.id,
        targetVersion: existingJournal.targetVersion,
        state: existingJournal.state,
        reused: true
      };
    } catch (error) {
      cleanupStage(existingJournal.stageRoot);
      removeJournal(context);
      settleAuthorization(context, authorization.id, 'revoked');
      throw updateError(
        safeErrorCode(error) || 'update_staged_payload_invalid',
        'The previously staged update is no longer valid. Choose Update now to download it again.',
        { cause: error }
      );
    }
  }
  if (existingJournal && APPLYING_TRANSACTION_STATES.has(existingJournal.state)) {
    throw updateError('update_transaction_in_progress', 'A managed update transaction is already being applied.');
  }
  if (authorization.state === 'bound') {
    throw updateError('update_consent_mismatch', 'Bound authorization has no reusable staged transaction.');
  }
  const transactionId = crypto.randomUUID();
  const stageRoot = path.join(context.updatesRoot, 'staging-' + transactionId);
  fs.mkdirSync(stageRoot, { recursive: true, mode: 0o700 });
  try {
    const archivePath = path.join(stageRoot, manifest.updateBundle.name);
    const bundleBytes = await fetchReleaseAsset(options.fetch, candidate.bundleUrl, manifest.updateBundle.size + 1,
      { ...options.network, totalTimeoutMs: 300000, timeoutMs: 30000,
        idleTimeoutMs: 30000, stage: 'update_bundle' });
    options.network?.signal?.throwIfAborted();
    const currentAuthorization = requireAuthorization(context, manifest.version, ['authorized', 'bound']);
    if (currentAuthorization.id !== authorization.id) {
      throw updateError('update_consent_mismatch', 'The update authorization changed while downloading.');
    }
    if (bundleBytes.length !== manifest.updateBundle.size) {
      throw updateError('update_bundle_size_mismatch', 'Downloaded update bundle size does not match the signed manifest.');
    }
    const hash = crypto.createHash('sha256').update(bundleBytes).digest('hex');
    if (hash !== manifest.updateBundle.sha256) {
      throw updateError('update_bundle_hash_mismatch', 'Downloaded update bundle hash does not match the signed manifest.');
    }
    fs.writeFileSync(archivePath, bundleBytes, { mode: 0o600 });
    const payloadRoot = path.join(stageRoot, 'payload');
    extractVerifiedUpdateBundle({ archivePath, destinationRoot: payloadRoot });
    verifyStagedPair(payloadRoot, manifest.version);
    const journal = {
      id: transactionId,
      authorizationId: authorization.id,
      state: 'staged',
      sourceVersion: activeVersion,
      sourcePreviousVersion: readVersionPointer(context.nativeRoot, 'previous-version'),
      targetVersion: manifest.version,
      stageRoot,
      payloadRoot,
      archivePath,
      bundleSize: manifest.updateBundle.size,
      bundleSha256: manifest.updateBundle.sha256,
      manifestSha256: crypto.createHash('sha256').update(manifestBytes).digest('hex'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    writeJournal(context, journal);
    bindAuthorization(context, authorization, transactionId);
    cleanupOrphanStageRoots(context.updatesRoot, [stageRoot]);
    return { transactionId, targetVersion: manifest.version, state: journal.state };
  } catch (error) {
    cleanupStage(stageRoot);
    const journal = readJournal(context);
    if (journal?.id === transactionId) removeJournal(context);
    settleAuthorization(context, authorization.id, 'revoked');
    throw error;
  }
}

function getApplyGate(options = {}) {
  const state = typeof options.getWorkState === 'function'
    ? options.getWorkState()
    : { projectLocks: 0, runControllers: 0 };
  const blockers = [];
  if (Number(state.projectLocks || 0) > 0) blockers.push('native_project_locked');
  if (Number(state.runControllers || 0) > 0) blockers.push('native_run_active');
  if (Number(state.processStopBarriers || 0) > 0) blockers.push('native_process_stop_unconfirmed');
  return { idle: blockers.length === 0, blockers, workState: state };
}

function scheduleStagedActivation(context, params = {}, options = {}) {
  const gate = getApplyGate(options);
  if (!gate.idle) {
    throw updateError('update_native_busy', 'Native host is still processing a Codex task.');
  }
  assertManagedLayout(context);
  const journal = readJournal(context);
  if (!journal || journal.state !== 'staged') {
    throw updateError('update_not_staged', 'No verified update is ready to activate.');
  }
  if (params.transactionId && params.transactionId !== journal.id) {
    throw updateError('update_transaction_mismatch', 'Update transaction id does not match the staged update.');
  }
  const authorization = requireAuthorization(context, journal.targetVersion, ['bound']);
  if (journal.authorizationId !== authorization.id || authorization.transactionId !== journal.id) {
    throw updateError('update_consent_mismatch', 'Activation transaction does not match the bound authorization.');
  }
  const pending = {
    ...journal,
    state: 'activation_pending',
    activationRequestedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  writeJournal(context, pending);
  setTimeout(() => {
    void withUpdateMutex(context, () => applyStagedUpdate(context, {
      transactionId: pending.id
    }, {
      ...options,
      allowActivationPending: true
    })).catch(error => recordScheduledActivationFailure(context, pending, error));
  }, ACTIVATION_DELAY_MS);
  return {
    transactionId: pending.id,
    targetVersion: pending.targetVersion,
    state: pending.state
  };
}

function recordScheduledActivationFailure(context, pending, error) {
  const current = readJournal(context);
  if (!current || current.id !== pending.id || ['awaiting_health', 'rolled_back', 'committed',
    ...BootstrapUpdate.BOOTSTRAP_STATES].includes(current.state)) return;
  writeJournal(context, {
    ...current,
    state: 'rolled_back',
    reasonCode: safeErrorCode(error),
    rolledBackAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  settleAuthorization(context, pending.authorizationId, 'revoked');
}

function applyStagedUpdate(context, params = {}, options = {}) {
  const gate = getApplyGate(options);
  if (!gate.idle) {
    throw updateError('update_native_busy', 'Native host is still processing a Codex task.');
  }
  assertManagedLayout(context);
  const journal = readJournal(context);
  const allowedStates = options.allowActivationPending ? ['activation_pending'] : ['staged'];
  if (!journal || !allowedStates.includes(journal.state)) {
    throw updateError('update_not_staged', 'No verified update is ready to apply.');
  }
  if (params.transactionId && params.transactionId !== journal.id) {
    throw updateError('update_transaction_mismatch', 'Update transaction id does not match the staged update.');
  }
  const authorization = requireAuthorization(context, journal.targetVersion, ['bound']);
  if (journal.authorizationId !== authorization.id || authorization.transactionId !== journal.id) {
    throw updateError('update_consent_mismatch', 'Apply transaction does not match the bound authorization.');
  }
  const verifiedPayloadRoot = path.join(journal.stageRoot, 'payload-apply');
  try {
    verifyStagedArchive(journal);
    fs.rmSync(verifiedPayloadRoot, { recursive: true, force: true });
    extractVerifiedUpdateBundle({
      archivePath: journal.archivePath,
      destinationRoot: verifiedPayloadRoot
    });
    verifyStagedPair(verifiedPayloadRoot, journal.targetVersion);
  } catch (error) {
    cleanupStage(journal.stageRoot);
    writeJournal(context, {
      ...journal,
      state: 'rolled_back',
      reasonCode: safeErrorCode(error) || 'update_staged_payload_invalid',
      rolledBackAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    settleAuthorization(context, journal.authorizationId, 'revoked');
    throw error;
  }
  assertManagedMarkers(context);
  const extensionRuntime = path.join(context.extensionRoot, 'runtime');
  const previousRuntime = path.join(context.extensionRoot, 'slots', 'previous', 'runtime');
  const stagedExtension = path.join(verifiedPayloadRoot, 'extension-runtime');
  const stagedNative = path.join(verifiedPayloadRoot, 'native-runtime');
  const targetNative = path.join(context.nativeRoot, 'versions', journal.targetVersion);
  const manifestPath = path.join(context.extensionRoot, 'manifest.json');
  const previousManifest = fs.readFileSync(manifestPath, 'utf8');
  writeJournal(context, {
    ...journal,
    payloadRoot: verifiedPayloadRoot,
    state: 'applying',
    previousManifest,
    updatedAt: new Date().toISOString()
  });

  try {
    fs.rmSync(path.dirname(previousRuntime), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(previousRuntime), { recursive: true });
    fs.renameSync(extensionRuntime, previousRuntime);
    fs.renameSync(stagedExtension, extensionRuntime);
    fs.rmSync(targetNative, { recursive: true, force: true });
    fs.renameSync(stagedNative, targetNative);
    atomicWriteText(path.join(context.nativeRoot, 'previous-version'), journal.sourceVersion + '\n');
    atomicWriteText(path.join(context.nativeRoot, 'active-version'), journal.targetVersion + '\n');
    rewriteManagedManifestVersion(manifestPath, journal.targetVersion);
    syncManagedMarkerVersions(context, journal.targetVersion);
  } catch (error) {
    rollbackFiles(context, { ...journal, previousManifest });
    writeJournal(context, {
      ...journal,
      previousManifest,
      state: 'rolled_back',
      reasonCode: 'update_apply_failed',
      rolledBackAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    settleAuthorization(context, journal.authorizationId, 'revoked');
    throw updateError('update_apply_failed', 'Managed update could not be applied atomically.', { cause: error });
  }
  const awaiting = {
    ...journal,
    payloadRoot: verifiedPayloadRoot,
    previousManifest,
    state: 'awaiting_health',
    appliedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  writeJournal(context, awaiting);
  return { transactionId: journal.id, targetVersion: journal.targetVersion, state: awaiting.state };
}

function confirmUpdate(context, params = {}) {
  const journal = readJournal(context);
  if (!journal || journal.state !== 'awaiting_health') {
    throw updateError('update_confirmation_unexpected', 'No update is waiting for health confirmation.');
  }
  if (params.transactionId !== journal.id || params.extensionVersion !== journal.targetVersion || params.nativeVersion !== journal.targetVersion) {
    throw updateError('update_health_version_mismatch', 'Extension and native host did not confirm the same target version.');
  }
  BootstrapUpdate.assertBootstrapConfirmation(context, journal, params);
  if (!isLegacyInboundConsentMigration(journal)) {
    const authorization = requireAuthorization(context, journal.targetVersion, ['bound'], {
      activeVersion: journal.sourceVersion
    });
    if (journal.authorizationId !== authorization.id || authorization.transactionId !== journal.id) {
      throw updateError('update_consent_mismatch', 'Health confirmation does not match the bound authorization.');
    }
  }
  const manifest = readJsonSafe(path.join(context.extensionRoot, 'manifest.json'), null);
  if (readVersionPointer(context.nativeRoot, 'active-version') !== journal.targetVersion || manifest?.version !== journal.targetVersion) {
    throw updateError('update_health_version_mismatch', 'Managed files do not match the confirmed target version.');
  }
  let committedEvidence;
  try { committedEvidence = readManagedRuntimeEvidence(context, journal.targetVersion); }
  catch (cause) {
    throw updateError('update_health_failed', 'The installed runtime files did not pass the update health check.', { cause });
  }
  writeJournal(context, {
    ...journal,
    state: 'committed',
    committedEvidence,
    confirmedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  settleAuthorization(context, journal.authorizationId, 'consumed');
  pruneNativeVersions(context.nativeRoot, new Set([journal.targetVersion, journal.sourceVersion]));
  cleanupStage(journal.stageRoot);
  cleanupOrphanStageRoots(context.updatesRoot);
  return { version: journal.targetVersion, state: 'committed' };
}

function rollbackUpdate(context, params = {}) {
  let journal = readJournal(context);
  if (params.transactionId && journal?.id !== params.transactionId) {
    throw updateError('update_transaction_mismatch', 'Rollback transaction identity changed.');
  }
  if (params.expectedState && journal?.state !== params.expectedState) {
    throw updateError('update_transaction_state_changed', 'The update state changed before rollback.');
  }
  journal = BootstrapUpdate.bindBootstrapMigration(context, journal, bootstrapDependencies(context));
  if (!journal || !['applying', 'awaiting_health', 'committed', 'bootstrap_pending', 'bootstrap_rolling_back'].includes(journal.state)) {
    throw updateError('update_rollback_unavailable', 'No applied update is available for rollback.');
  }
  if (journal.bootstrapMigration && !params.transactionId && journal.bootstrapMigration.phase !== 'pending') {
    throw updateError('update_transaction_mismatch', 'Bootstrap rollback must identify its update transaction.');
  }
  const migration = Boolean(journal.bootstrapMigration);
  if (migration) writeJournal(context, { ...journal, state: 'bootstrap_rolling_back' });
  const rollbackEvidence = rollbackFiles(context, journal, { deferSourceActivation: migration });
  const cooldowns = readJsonSafe(path.join(context.updatesRoot, COOLDOWN_FILE), {});
  cooldowns[journal.targetVersion] = {
    until: Date.now() + 24 * 60 * 60 * 1000,
    reasonCode: normalizeReasonCode(params.reasonCode)
  };
  atomicWriteJson(path.join(context.updatesRoot, COOLDOWN_FILE), cooldowns);
  const restoredJournal = {
    ...journal,
    state: 'rolled_back',
    reasonCode: normalizeReasonCode(params.reasonCode),
    rolledBackAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    previousManifest: undefined,
    rollbackEvidence,
    ...(migration ? { bootstrapMigration: { ...journal.bootstrapMigration, phase: 'restored',
      sourceUnchanged: rollbackEvidence.bootstrapSourceUnchanged === true },
      sourceActivationPending: true } : {})
  };
  writeJournal(context, restoredJournal);
  // The old launcher must not select a source process that cannot understand
  // our recovery record until every file and the durable terminal record exist.
  if (migration) {
    settleAuthorization(context, journal.authorizationId, 'revoked');
    atomicWriteText(path.join(context.nativeRoot, 'active-version'), journal.sourceVersion + '\n');
    writeJournal(context, { ...restoredJournal, sourceActivationPending: false });
  }
  settleAuthorization(context, journal.authorizationId, 'revoked');
  cleanupStage(journal.stageRoot);
  cleanupOrphanStageRoots(context.updatesRoot);
  return { transactionId: journal.id, version: journal.sourceVersion, state: 'rolled_back', restoredPair: rollbackEvidence };
}

function revokeUpdate(context, params = {}) {
  const authorizationId = String(params.authorizationId || '');
  const targetVersion = String(params.targetVersion || '');
  const transactionId = String(params.transactionId || '');
  if (!isUuid(authorizationId) || !parseSemver(targetVersion)) {
    throw updateError('update_authorization_invalid', 'Update revocation parameters are invalid.');
  }
  const journal = readJournal(context);
  if (journal?.targetVersion === targetVersion &&
      (APPLYING_TRANSACTION_STATES.has(journal.state) || journal.state === 'committed' || journal.sourceActivationPending)) {
    throw updateError('update_revoke_too_late', 'The update is already being applied.');
  }
  const authorization = readAuthorization(context);
  if (!authorization) {
    if (!journal || journal.targetVersion !== targetVersion) {
      return { state: 'already_revoked', targetVersion };
    }
    if (journal.authorizationId !== authorizationId) {
      throw updateError('update_consent_mismatch', 'Revocation does not match the staged transaction.');
    }
  } else if (authorization.id !== authorizationId || authorization.targetVersion !== targetVersion) {
    throw updateError('update_consent_mismatch', 'Revocation does not match the active authorization.');
  }
  if (transactionId && journal?.id !== transactionId) {
    throw updateError('update_transaction_mismatch', 'Revocation transaction id does not match the staged update.');
  }
  if (authorization) {
    writeAuthorization(context, { ...authorization, state: 'revoked', revokedAt: new Date().toISOString() });
  }
  if (journal?.state === 'staged') {
    cleanupStage(journal.stageRoot);
    removeJournal(context);
  }
  cleanupOrphanStageRoots(context.updatesRoot);
  fs.rmSync(path.join(context.updatesRoot, AUTHORIZATION_FILE), { force: true });
  return { state: 'revoked', targetVersion };
}

function rollbackFiles(context, journal, options = {}) {
  const runtime = path.join(context.extensionRoot, 'runtime');
  const previousRuntime = path.join(context.extensionRoot, 'slots', 'previous', 'runtime');
  // An early interrupted apply may still have the source in the current slot.
  // A missing previous slot is recoverable only when these actual bytes match
  // the source pair; the source manifest and markers alone are insufficient.
  const source = readManagedRuntimeEvidence(context, journal.sourceVersion,
    fs.existsSync(previousRuntime) ? previousRuntime : runtime);
  if (journal.bootstrapMigration) BootstrapUpdate.restoreBootstrap(context, journal);
  if (fs.existsSync(previousRuntime)) {
    fs.rmSync(runtime, { recursive: true, force: true });
    fs.renameSync(previousRuntime, runtime);
    fs.rmSync(path.dirname(previousRuntime), { recursive: true, force: true });
  }
  if (journal.previousManifest) {
    atomicWriteText(path.join(context.extensionRoot, 'manifest.json'), journal.previousManifest);
  }
  if (parseSemver(journal.sourceVersion) && !options.deferSourceActivation) {
    atomicWriteText(path.join(context.nativeRoot, 'active-version'), journal.sourceVersion + '\n');
  }
  const sourcePrevious = parseSemver(journal.sourcePreviousVersion) ? journal.sourcePreviousVersion : '';
  if (sourcePrevious && fs.existsSync(path.join(context.nativeRoot, 'versions', sourcePrevious))) {
    atomicWriteText(path.join(context.nativeRoot, 'previous-version'), sourcePrevious + '\n');
  } else {
    fs.rmSync(path.join(context.nativeRoot, 'previous-version'), { force: true });
  }
  if (parseSemver(journal.sourceVersion)) {
    syncManagedMarkerVersions(context, journal.sourceVersion);
  }
  const restored = readManagedRuntimeEvidence(context, journal.sourceVersion);
  if (!sameRuntimeEvidence(source, restored)) {
    throw updateError('update_rollback_unconfirmed', 'The source runtime readback did not match the restored files.');
  }
  if (journal.bootstrapMigration) {
    const bootstrap = BootstrapUpdate.bootstrapEvidence(context, journal, 'source');
    if (bootstrap) {
      restored.bootstrapSha256 = bootstrap.digest;
      if (bootstrap.unmodified) restored.bootstrapSourceUnchanged = true;
    }
  }
  return restored;
}

function syncManagedMarkerVersions(context, version) {
  rewriteManagedMarkerVersion(context.extensionRoot, EXTENSION_MARKER, 'extension', version);
  rewriteManagedMarkerVersion(context.nativeRoot, NATIVE_MARKER, 'native', version);
}

function rewriteManagedMarkerVersion(root, filename, kind, version) {
  const markerPath = path.join(root, filename);
  const marker = readJsonSafe(markerPath, null);
  if (!isManagedMarker(marker, kind)) {
    throw updateError('update_marker_invalid', `The managed ${kind} marker is missing or invalid.`);
  }
  atomicWriteJson(markerPath, {
    ...marker,
    version,
    updatedAt: new Date().toISOString()
  });
}

function cleanupOrphanStageRoots(updatesRoot, retainedRoots = []) {
  const resolvedRoot = path.resolve(String(updatesRoot || ''));
  if (!resolvedRoot || resolvedRoot === path.parse(resolvedRoot).root) return;
  const retained = new Set((retainedRoots || []).map(value => path.resolve(String(value || ''))));
  let entries;
  try {
    entries = fs.readdirSync(resolvedRoot, { withFileTypes: true });
  } catch (_error) {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^staging-[0-9a-f-]{36}$/i.test(entry.name)) continue;
    const candidate = path.join(resolvedRoot, entry.name);
    if (retained.has(path.resolve(candidate))) continue;
    fs.rmSync(candidate, { recursive: true, force: true });
  }
}

function recoverAndReadStatus(context, params = {}) {
  let journal = readJournal(context);
  if (journal?.sourceActivationPending && journal.state === 'rolled_back') {
    journal = finishSourceActivation(context, journal);
  }
  const alignedVersion = readAlignedManagedVersion(context);
  journal = supersedeObsoleteJournal(context, journal, alignedVersion);
  if (journal?.state === 'activation_pending') {
    journal = { ...journal, state: 'staged', reasonCode: 'update_activation_interrupted', updatedAt: new Date().toISOString() };
    writeJournal(context, journal);
  }
  if (journal?.state === 'applying') {
    const rollbackEvidence = rollbackFiles(context, journal);
    journal = { ...journal, rollbackEvidence, state: 'rolled_back', reasonCode: 'update_interrupted', updatedAt: new Date().toISOString() };
    writeJournal(context, journal);
    settleAuthorization(context, journal.authorizationId, 'revoked');
  }
  journal = BootstrapUpdate.bindBootstrapMigration(context, journal, bootstrapDependencies(context));
  if (BootstrapUpdate.bootstrapExpired(journal, { recoveryRequested: params.bootstrapRecovery === true, context })) {
    rollbackUpdate(context, { transactionId: journal.id, expectedState: journal.state, reasonCode: 'update_bootstrap_health_timeout' });
    journal = readJournal(context);
  }
  if (journal?.state === 'rolled_back' || journal?.state === 'superseded') {
    if (journal.state === 'superseded') cleanupStage(journal.stageRoot);
    pruneNativeVersions(context.nativeRoot, new Set([
      readVersionPointer(context.nativeRoot, 'active-version'),
      readVersionPointer(context.nativeRoot, 'previous-version')
    ]));
  }
  if (journal?.state === 'committed' && journal.committedEvidence && alignedVersion === journal.targetVersion) {
    const observed = readManagedRuntimeEvidence(context, journal.targetVersion);
    if (sameRuntimeEvidence(journal.committedEvidence, observed)) {
      if (journal.bootstrapMigration) BootstrapUpdate.assertBootstrapConfirmation(context, journal,
        { bootstrapRevision: journal.bootstrapMigration.targetRevision });
      const authorization = readAuthorization(context);
      if (['bound', 'consumed'].includes(authorization?.state) && authorization.id === journal.authorizationId
        && authorization.transactionId === journal.id && authorization.sourceVersion === journal.sourceVersion
        && authorization.targetVersion === journal.targetVersion) {
        settleAuthorization(context, journal.authorizationId, 'consumed');
      }
      cleanupStage(journal.stageRoot);
    }
  }
  return currentStatus(context, journal);
}

function finishSourceActivation(context, journal) {
  const actual = readManagedRuntimeEvidence(context, journal.sourceVersion);
  if (!sameRuntimeEvidence(actual, journal.rollbackEvidence)) {
    throw updateError('update_rollback_unconfirmed', 'The recovered source files changed before activation.');
  }
  BootstrapUpdate.bootstrapEvidence(context, journal, 'source');
  settleAuthorization(context, journal.authorizationId, 'revoked');
  atomicWriteText(path.join(context.nativeRoot, 'active-version'), journal.sourceVersion + '\n');
  const finished = { ...journal, sourceActivationPending: false };
  writeJournal(context, finished);
  cleanupStage(journal.stageRoot);
  return finished;
}

// Called by the full installer while holding the same mutation lock, only
// after both runtime trees and browser registration have succeeded.
function settleReinstalledUpdate(context, version, expected) {
  if (!expected?.id || !parseSemver(expected.sourceVersion) || !parseSemver(expected.targetVersion)
    || compareSemver(version, expected.targetVersion) < 0
    || compareSemver(version, expected.sourceVersion) <= 0) return;
  const journal = readJournal(context);
  if (!journal || ['id', 'state', 'sourceVersion', 'targetVersion'].some(key => journal[key] !== expected[key])) {
    throw updateError('update_transaction_mismatch', 'The update transaction changed during full installation.');
  }
  if (assertManagedLayout(context) !== version) {
    throw updateError('update_managed_layout_invalid', 'Full installation did not produce the requested pair.');
  }
  const reinstalledPair = readManagedRuntimeEvidence(context, version);
  const timestamp = new Date().toISOString();
  writeJournal(context, {
    ...journal, state: 'superseded', supersededFromState: journal.state,
    supersededByVersion: version, supersededAt: timestamp,
    updatedAt: timestamp, reasonCode: 'update_reinstalled', reinstalledPair
  });
  const authorization = readAuthorization(context);
  if (authorization?.state === 'bound' && authorization.id === journal.authorizationId
    && authorization.transactionId === journal.id && authorization.sourceVersion === journal.sourceVersion
    && authorization.targetVersion === journal.targetVersion) {
    settleAuthorization(context, authorization.id, 'revoked');
  }
}

function currentStatus(context, journal = readJournal(context)) {
  let restoredPair = null;
  let reinstalledPair = null;
  if (journal?.state === 'rolled_back') {
    try {
      const observed = readManagedRuntimeEvidence(context, journal.sourceVersion);
      if (!journal.rollbackEvidence || sameRuntimeEvidence(journal.rollbackEvidence, observed)) {
        if (journal.bootstrapMigration) {
          const bootstrap = BootstrapUpdate.bootstrapEvidence(context, journal, 'source');
          if (bootstrap) observed.bootstrapSha256 = bootstrap.digest;
          if (journal.rollbackEvidence?.bootstrapSha256 !== observed.bootstrapSha256) throw new Error('Bootstrap restoration changed.');
        }
        restoredPair = observed;
      }
    } catch (_) { /* Missing or changed bytes cannot confirm a recovered pair. */ }
  }
  if (journal?.state === 'superseded' && journal.reasonCode === 'update_reinstalled' && journal.reinstalledPair) {
    try {
      const observed = readManagedRuntimeEvidence(context, journal.supersededByVersion);
      if (sameRuntimeEvidence(journal.reinstalledPair, observed)) reinstalledPair = observed;
    } catch (_) { /* A reinstall receipt cannot authenticate later changed files. */ }
  }
  return {
    managed: true,
    activeVersion: readVersionPointer(context.nativeRoot, 'active-version'),
    runtimeVersion: context.env?.CODEX_OVERLEAF_ACTIVE_VERSION || RUNNING_VERSION,
    installedAligned: Boolean(readAlignedManagedVersion(context)),
    previousVersion: readVersionPointer(context.nativeRoot, 'previous-version'),
    transaction: journal ? { ...publicTransaction(journal),
      ...(journal.state === 'awaiting_health' && BootstrapUpdate.migrationHint(context, journal)
        && journal.bootstrapMigration?.phase !== 'loaded' ? { state: 'bootstrap_pending' } : {}) } : null,
    authorization: publicAuthorization(readAuthorization(context)),
    restoredPair,
    reinstalledPair
  };
}

function readStatusWithoutWaiting(context, params = {}) {
  const lockPath = path.join(context.updatesRoot, MUTATION_LOCK_FILE);
  const token = crypto.randomUUID();
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = readJsonSafe(lockPath, null);
    if (Number.isInteger(owner?.pid) && !isProcessAlive(owner.pid) && removeStaleUpdateFileLock(lockPath)) {
      return readStatusWithoutWaiting(context, params);
    }
    // A live mutation owns recovery; report an atomic-file snapshot without
    // queueing behind its network transfer or changing its journal.
    return currentStatus(context);
  }
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ token, pid: process.pid,
      createdAt: Date.now(), expiresAt: Date.now() + MUTATION_LOCK_STALE_MS }));
    return recoverAndReadStatus(context, params);
  } finally {
    fs.closeSync(descriptor);
    releaseUpdateFileLock({ lockPath, token });
  }
}

function readAlignedManagedVersion(context) {
  try {
    return assertManagedLayout(context);
  } catch (_error) {
    return '';
  }
}

function supersedeObsoleteJournal(context, journal, activeVersion) {
  if (!journal || !parseSemver(activeVersion) ||
      !parseSemver(journal.sourceVersion) || !parseSemver(journal.targetVersion) ||
      compareSemver(activeVersion, journal.sourceVersion) <= 0 ||
      compareSemver(activeVersion, journal.targetVersion) <= 0) {
    return journal;
  }
  // A previous runtime may already have retired the journal without settling
  // its bound authorization. Never consume an authorization owned elsewhere.
  const authorization = readAuthorization(context);
  if (authorization?.state === 'bound' && journal.authorizationId
      && authorization.id === journal.authorizationId && authorization.transactionId === journal.id
      && authorization.sourceVersion === journal.sourceVersion && authorization.targetVersion === journal.targetVersion) {
    settleAuthorization(context, authorization.id, 'revoked');
  }
  if (journal.state === 'superseded') return journal;
  const timestamp = new Date().toISOString();
  const superseded = {
    ...journal,
    state: 'superseded',
    supersededFromState: journal.state,
    supersededByVersion: activeVersion,
    supersededAt: timestamp,
    updatedAt: timestamp
  };
  writeJournal(context, superseded);
  cleanupStage(journal.stageRoot);
  cleanupOrphanStageRoots(context.updatesRoot);
  return superseded;
}

function pruneNativeVersions(nativeRoot, retainedVersions) {
  const versionsRoot = path.join(nativeRoot, 'versions');
  let entries = [];
  try {
    entries = fs.readdirSync(versionsRoot, { withFileTypes: true });
  } catch (_error) {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && parseSemver(entry.name) && !retainedVersions.has(entry.name)) {
      fs.rmSync(path.join(versionsRoot, entry.name), { recursive: true, force: true });
    }
  }
}

function getManagedContext(options = {}) {
  const env = options.env || process.env;
  const nativeRoot = path.resolve(options.nativeRoot || env.CODEX_OVERLEAF_MANAGED_NATIVE_ROOT || '');
  const extensionRoot = path.resolve(options.extensionRoot || env.CODEX_OVERLEAF_MANAGED_EXTENSION_ROOT || '');
  const managed = env.CODEX_OVERLEAF_MANAGED === '1'
    && Boolean(nativeRoot)
    && Boolean(extensionRoot)
    && isManagedMarker(readJsonSafe(path.join(nativeRoot, NATIVE_MARKER), null), 'native')
    && isManagedMarker(readJsonSafe(path.join(extensionRoot, EXTENSION_MARKER), null), 'extension');
  const updatesRoot = managed ? path.join(nativeRoot, 'updates') : '';
  if (managed) fs.mkdirSync(updatesRoot, { recursive: true, mode: 0o700 });
  return { env, managed, nativeRoot, extensionRoot, updatesRoot };
}

function assertManagedMarkers(context) {
  if (!context.managed) throw updateError('update_not_managed', 'Managed installation markers are missing.');
}

function assertManagedLayout(context) {
  assertManagedMarkers(context);
  const activeVersion = readVersionPointer(context.nativeRoot, 'active-version');
  const nativeMarker = readJsonSafe(path.join(context.nativeRoot, NATIVE_MARKER), null);
  const extensionMarker = readJsonSafe(path.join(context.extensionRoot, EXTENSION_MARKER), null);
  const manifest = readJsonSafe(path.join(context.extensionRoot, 'manifest.json'), null);
  const requiredFiles = [
    path.join(context.extensionRoot, 'bootstrap', 'background.js'),
    path.join(context.extensionRoot, 'runtime', 'runtime-manifest.json')
  ];
  const valid = Boolean(
    parseSemver(activeVersion) &&
    nativeMarker?.version === activeVersion &&
    extensionMarker?.version === activeVersion &&
    manifest?.version === activeVersion &&
    manifest?.manifest_version === 3 &&
    manifest?.background?.service_worker === 'bootstrap/background.js' &&
    requiredFiles.every(filePath => fs.existsSync(filePath) && fs.statSync(filePath).isFile())
  );
  if (!valid) {
    throw updateError(
      'update_managed_layout_invalid',
      'Managed extension files do not match the active Native Host. Run install-managed for the latest stable version, then reload the Chrome extension and Overleaf.'
    );
  }
  return activeVersion;
}

function isManagedMarker(marker, kind) {
  return marker?.managedBy === 'codex-overleaf-link' && marker?.kind === kind && marker?.bootstrapProtocol === BOOTSTRAP_PROTOCOL;
}

function verifyStagedPair(payloadRoot, targetVersion) {
  const nativePackage = readJsonSafe(path.join(payloadRoot, 'native-runtime', 'package.json'), null);
  if (nativePackage?.version !== targetVersion) {
    throw updateError('update_native_version_mismatch', 'Staged native runtime version does not match the signed release.');
  }
  const compatibilityPath = path.join(payloadRoot, 'extension-runtime', 'src', 'shared', 'compatibility.js');
  const compatibility = fs.readFileSync(compatibilityPath, 'utf8');
  const match = compatibility.match(/BUILD_TARGET_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (match?.[1] !== targetVersion) {
    throw updateError('update_extension_version_mismatch', 'Staged extension runtime version does not match the signed release.');
  }
  const extensionRuntimeRoot = path.join(payloadRoot, 'extension-runtime');
  const runtimeManifest = readJsonSafe(path.join(extensionRuntimeRoot, 'runtime-manifest.json'), null);
  const runtimeFiles = [
    ...(Array.isArray(runtimeManifest?.js) ? runtimeManifest.js : []),
    ...(Array.isArray(runtimeManifest?.css) ? runtimeManifest.css : [])
  ];
  if (!runtimeFiles.length) {
    throw updateError('update_runtime_manifest_invalid', 'Staged runtime manifest does not declare any runtime files.');
  }
  for (const relativePath of runtimeFiles) {
    const normalized = String(relativePath || '').replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') ||
        normalized.split('/').some(part => !part || part === '.' || part === '..')) {
      throw updateError('update_runtime_manifest_invalid', 'Staged runtime manifest contains an invalid file path.');
    }
    const filePath = path.resolve(extensionRuntimeRoot, ...normalized.split('/'));
    const relative = path.relative(extensionRuntimeRoot, filePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) ||
        !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw updateError('update_runtime_asset_missing', 'Staged runtime manifest references a missing file: ' + normalized);
    }
  }
}

function verifyStagedArchive(journal) {
  if (!journal?.archivePath || !Number.isSafeInteger(journal.bundleSize) ||
      !/^[0-9a-f]{64}$/.test(String(journal.bundleSha256 || ''))) {
    throw updateError('update_staged_archive_invalid', 'Staged update archive metadata is incomplete. Download the update again.');
  }
  const bytes = fs.readFileSync(journal.archivePath);
  if (bytes.length !== journal.bundleSize) {
    throw updateError('update_bundle_size_mismatch', 'Staged update bundle size changed after verification.');
  }
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (hash !== journal.bundleSha256) {
    throw updateError('update_bundle_hash_mismatch', 'Staged update bundle changed after verification.');
  }
}

function normalizeCurrentVersion(value, context) {
  const requested = String(value || '');
  const active = readVersionPointer(context.nativeRoot, 'active-version');
  if (parseSemver(requested) && requested === active) return requested;
  if (parseSemver(active)) return active;
  throw updateError('update_current_version_invalid', 'Managed installation has no valid active version.');
}

function readVersionPointer(root, name) {
  try {
    const value = fs.readFileSync(path.join(root, name), 'utf8').trim();
    return parseSemver(value) ? value : '';
  } catch (_error) {
    return '';
  }
}

function rewriteManagedManifestVersion(manifestPath, version) {
  const manifest = readJsonSafe(manifestPath, null);
  if (!manifest || manifest.manifest_version !== 3 || !manifest.background?.service_worker?.startsWith('bootstrap/')) {
    throw updateError('update_bootstrap_manifest_invalid', 'Managed Bootstrap manifest cannot be rewritten safely.');
  }
  manifest.version = version;
  atomicWriteText(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

async function fetchReleaseAsset(fetchImpl, url, limit, network = {}) {
  const parsed = new URL(String(url || ''));
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || !parsed.pathname.startsWith('/Ghqqqq/codex-overleaf-link/releases/download/')) {
    throw updateError('update_asset_url_forbidden', 'Release asset URL is outside the trusted repository.');
  }
  const response = await requestRelease(parsed.href, {
    timeoutMs: 20000, ...network, fetch: fetchImpl, limit, allowedHosts: RELEASE_ASSET_HOSTS
  });
  return response.bytes;
}

function findReleaseAsset(assets, name) {
  const matches = assets.filter(asset => asset?.name === name && typeof asset.browser_download_url === 'string');
  if (matches.length !== 1) throw updateError('update_asset_missing', 'Release must contain exactly one ' + name + ' asset.');
  return matches[0];
}

function publicTransaction(journal) {
  return {
    id: journal.id,
    state: journal.state,
    sourceVersion: journal.sourceVersion,
    targetVersion: journal.targetVersion,
    ...(journal.bootstrapMigration ? { bootstrapRevision: journal.bootstrapMigration.targetRevision } : {}),
    createdAt: journal.createdAt,
    activationRequestedAt: journal.activationRequestedAt,
    appliedAt: journal.appliedAt,
    confirmedAt: journal.confirmedAt,
    rolledBackAt: journal.rolledBackAt,
    supersededAt: journal.supersededAt,
    supersededByVersion: journal.supersededByVersion,
    supersededFromState: journal.supersededFromState,
    reasonCode: journal.reasonCode || ''
  };
}

function publicAuthorization(authorization) {
  if (!authorization) return null;
  return {
    state: authorization.state,
    targetVersion: authorization.targetVersion,
    sourceVersion: authorization.sourceVersion,
    transactionId: authorization.transactionId || '',
    grantedAt: authorization.grantedAt,
    expiresAt: authorization.expiresAt
  };
}

function readJournal(context) {
  return readJsonSafe(path.join(context.updatesRoot, JOURNAL_FILE), null);
}

function writeJournal(context, journal) {
  atomicWriteJson(path.join(context.updatesRoot, JOURNAL_FILE), journal);
}

function removeJournal(context) {
  fs.rmSync(path.join(context.updatesRoot, JOURNAL_FILE), { force: true });
}

function readAuthorization(context) {
  return readJsonSafe(path.join(context.updatesRoot, AUTHORIZATION_FILE), null);
}

function writeAuthorization(context, authorization) {
  atomicWriteJson(path.join(context.updatesRoot, AUTHORIZATION_FILE), authorization);
}

function requireAuthorization(context, targetVersion, allowedStates, options = {}) {
  const authorization = readAuthorization(context);
  if (!authorization) {
    throw updateError('update_consent_required', 'Choose Update now before downloading or installing this update.');
  }
  const expectedActiveVersion = options.activeVersion || readVersionPointer(context.nativeRoot, 'active-version');
  if (authorization.targetVersion !== targetVersion || authorization.sourceVersion !== expectedActiveVersion) {
    throw updateError('update_consent_mismatch', 'Update authorization does not match this source and target version.');
  }
  if (!allowedStates.includes(authorization.state)) {
    throw updateError('update_consent_required', 'Update authorization is not active.');
  }
  if (authorization.state === 'authorized' &&
      (!authorization.expiresAt || Date.parse(authorization.expiresAt) <= Date.now())) {
    settleAuthorization(context, authorization.id, 'revoked');
    throw updateError('update_consent_required', 'Update authorization expired. Choose Update now again.');
  }
  return authorization;
}

function bindAuthorization(context, authorization, transactionId) {
  const bound = {
    ...authorization,
    state: 'bound',
    transactionId,
    boundAt: authorization.boundAt || new Date().toISOString()
  };
  writeAuthorization(context, bound);
  return bound;
}

function settleAuthorization(context, authorizationId, state) {
  const authorization = readAuthorization(context);
  if (!authorization || (authorizationId && authorization.id !== authorizationId)) return;
  writeAuthorization(context, {
    ...authorization,
    state,
    settledAt: new Date().toISOString()
  });
  fs.rmSync(path.join(context.updatesRoot, AUTHORIZATION_FILE), { force: true });
}

function atomicWriteJson(target, value) {
  atomicWriteText(target, JSON.stringify(value, null, 2) + '\n');
}

function atomicWriteText(target, value) {
  const temp = target + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let descriptor = fs.openSync(temp, 'wx', 0o600);
  try {
    // Windows requires a writable handle for FlushFileBuffers (Node fsync).
    fs.writeFileSync(descriptor, value);
    fs.fsyncSync(descriptor);
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  fs.renameSync(temp, target);
  descriptor = undefined;
  try {
    descriptor = fs.openSync(path.dirname(target), 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EISDIR', 'EINVAL', 'EBADF', 'EACCES'].includes(error.code)) throw error;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function readJsonSafe(target, fallback) {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (_error) {
    return fallback;
  }
}

function cleanupStage(stageRoot) {
  if (stageRoot && path.basename(stageRoot).startsWith('staging-')) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

function normalizeReasonCode(value) {
  return /^[a-z0-9_]{1,80}$/.test(String(value || '')) ? String(value) : 'update_health_failed';
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function isLegacyInboundConsentMigration(journal) {
  return Boolean(
    journal &&
    !journal.authorizationId &&
    journal.state === 'awaiting_health' &&
    journal.targetVersion === CONSENT_MIGRATION_TARGET_VERSION &&
    parseSemver(journal.sourceVersion) &&
    compareSemver(journal.sourceVersion, CONSENT_MIGRATION_TARGET_VERSION) < 0
  );
}

function safeErrorCode(error) {
  return /^[a-z0-9_]{1,80}$/.test(String(error?.code || '')) ? error.code : 'update_internal_error';
}

function safeErrorMessage(error) {
  return String(error?.message || 'Managed update failed.').replace(/(?:file:\/\/)?(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/)[^\s]*/g, '[local path]').slice(0, 500);
}

function okResponse(id, result) {
  return { id, ok: true, result };
}

function errorResponse(id, code, message) {
  return { id, ok: false, error: { code, message } };
}

module.exports = {
  GITHUB_LATEST_URL,
  MUTATION_LOCK_STALE_MS,
  applyStagedUpdate,
  assertManagedLayout,
  assertBootstrapBusinessAvailable,
  authorizeUpdate,
  checkForUpdate,
  cleanupOrphanStageRoots,
  confirmUpdate,
  getApplyGate,
  getManagedContext,
  handleUpdateRequest,
  isUpdateMethod,
  revokeUpdate,
  removeStaleUpdateFileLock,
  recoverBootstrapTransaction,
  rollbackUpdate,
  scheduleStagedActivation,
  settleReinstalledUpdate,
  stageCandidate,
  syncManagedMarkerVersions
};
