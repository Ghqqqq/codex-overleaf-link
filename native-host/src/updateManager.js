'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  compareSemver,
  isNewerStableVersion,
  parseSemver,
  updateError,
  verifySignedReleaseManifest
} = require('./updateTrust');
const { extractVerifiedUpdateBundle } = require('./updateArchive');

const GITHUB_LATEST_URL = 'https://github.com/Ghqqqq/codex-overleaf-link/releases/latest';
const GITHUB_RELEASE_DOWNLOAD_ROOT = 'https://github.com/Ghqqqq/codex-overleaf-link/releases/download';
const EXTENSION_MARKER = '.codex-overleaf-managed-extension.json';
const NATIVE_MARKER = '.codex-overleaf-managed-native.json';
const JOURNAL_FILE = 'transaction.json';
const CANDIDATE_FILE = 'candidate.json';
const COOLDOWN_FILE = 'cooldowns.json';
const AUTHORIZATION_FILE = 'authorization.json';
const MUTATION_LOCK_FILE = 'mutation.lock';
const AUTHORIZATION_TTL_MS = 2 * 60 * 60 * 1000;
const MUTATION_LOCK_WAIT_MS = 10 * 1000;
const MUTATION_LOCK_STALE_MS = 15 * 60 * 1000;
const ACTIVATION_DELAY_MS = 125;
const CONSENT_MIGRATION_TARGET_VERSION = '1.9.4';
const UPDATE_METHODS = new Set([
  'update.status',
  'update.check',
  'update.authorize',
  'update.stage',
  'update.canApply',
  'update.apply',
  'update.activate',
  'update.confirm',
  'update.rollback',
  'update.revoke'
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
    const context = getManagedContext(options);
    if (!context.managed) {
      throw updateError('update_not_managed', 'Run install-managed once to enable coordinated automatic updates.');
    }
    if (LAYOUT_GATED_METHODS.has(request.method)) {
      assertManagedLayout(context);
    }
    switch (request.method) {
      case 'update.status':
        return okResponse(request.id, await withUpdateMutex(context, () => recoverAndReadStatus(context)));
      case 'update.check':
        return okResponse(request.id, await withUpdateMutex(context, () => checkForUpdate(context, request.params || {}, options)));
      case 'update.authorize':
        return okResponse(request.id, await withUpdateMutex(context, () => authorizeUpdate(context, request.params || {})));
      case 'update.stage':
        return okResponse(request.id, await withUpdateMutex(context, () => stageCandidate(context, options)));
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
      case 'update.revoke':
        return okResponse(request.id, await withUpdateMutex(context, () => revokeUpdate(context, request.params || {})));
      default:
        throw updateError('unknown_update_method', 'Unknown managed update method.');
    }
  } catch (error) {
    return errorResponse(request.id, safeErrorCode(error), safeErrorMessage(error));
  }
}

function withUpdateMutex(context, action) {
  const guardedAction = () => withUpdateFileLock(context, action);
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
  const expired = !owner || Number(owner.expiresAt || 0) <= Date.now();
  const abandoned = Number.isInteger(Number(owner?.pid)) && !isProcessAlive(Number(owner.pid));
  if (!expired && !abandoned) return false;
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

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function checkForUpdate(context, params = {}, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw updateError('update_network_unavailable', 'This Node runtime cannot check GitHub Releases.');
  }
  const currentVersion = normalizeCurrentVersion(params.currentVersion, context);
  const headers = {
    Accept: 'text/html,application/xhtml+xml',
    'User-Agent': 'codex-overleaf-link-updater'
  };
  if (params.etag && typeof params.etag === 'string' && params.etag.length < 300) {
    headers['If-None-Match'] = params.etag;
  }
  const releaseResponse = await fetchWithTimeout(fetchImpl, GITHUB_LATEST_URL, {
    headers,
    method: 'HEAD',
    redirect: 'follow'
  }, 12000);
  if (releaseResponse.status === 304) {
    const candidate = readJsonSafe(path.join(context.updatesRoot, CANDIDATE_FILE), null);
    if (candidate?.manifestBase64 && candidate?.signatureBase64) {
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
    return { managed: true, available: false, reason: 'cooldown', currentVersion, latestVersion, etag: releaseResponse.headers.get('etag') || '' };
  }

  const manifestBytes = await fetchReleaseAsset(
    fetchImpl,
    buildReleaseAssetUrl(releaseTag, 'release-manifest.json'),
    256 * 1024
  );
  const signatureBytes = await fetchReleaseAsset(
    fetchImpl,
    buildReleaseAssetUrl(releaseTag, 'release-manifest.sig'),
    16 * 1024
  );
  const manifest = verifySignedReleaseManifest(manifestBytes, signatureBytes);
  if (manifest.version !== latestVersion || manifest.tag !== releaseTag) {
    throw updateError('update_release_manifest_mismatch', 'GitHub release tag does not match the signed update manifest.');
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
  if (existingJournal && ['activation_pending', 'applying', 'awaiting_health'].includes(existingJournal.state)) {
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
    const fetchImpl = options.fetch || globalThis.fetch;
    const bundleBytes = await fetchReleaseAsset(fetchImpl, candidate.bundleUrl, manifest.updateBundle.size + 1);
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
  if (!current || current.id !== pending.id || ['awaiting_health', 'rolled_back'].includes(current.state)) return;
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
  writeJournal(context, {
    ...journal,
    state: 'committed',
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
  const journal = readJournal(context);
  if (!journal || !['applying', 'awaiting_health', 'committed'].includes(journal.state)) {
    throw updateError('update_rollback_unavailable', 'No applied update is available for rollback.');
  }
  rollbackFiles(context, journal);
  const cooldowns = readJsonSafe(path.join(context.updatesRoot, COOLDOWN_FILE), {});
  cooldowns[journal.targetVersion] = {
    until: Date.now() + 24 * 60 * 60 * 1000,
    reasonCode: normalizeReasonCode(params.reasonCode)
  };
  atomicWriteJson(path.join(context.updatesRoot, COOLDOWN_FILE), cooldowns);
  writeJournal(context, {
    ...journal,
    state: 'rolled_back',
    reasonCode: normalizeReasonCode(params.reasonCode),
    rolledBackAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    previousManifest: undefined
  });
  settleAuthorization(context, journal.authorizationId, 'revoked');
  cleanupStage(journal.stageRoot);
  cleanupOrphanStageRoots(context.updatesRoot);
  return { version: journal.sourceVersion, state: 'rolled_back' };
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
      ['activation_pending', 'applying', 'awaiting_health', 'committed'].includes(journal.state)) {
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

function rollbackFiles(context, journal) {
  const runtime = path.join(context.extensionRoot, 'runtime');
  const previousRuntime = path.join(context.extensionRoot, 'slots', 'previous', 'runtime');
  if (fs.existsSync(previousRuntime)) {
    fs.rmSync(runtime, { recursive: true, force: true });
    fs.renameSync(previousRuntime, runtime);
    fs.rmSync(path.dirname(previousRuntime), { recursive: true, force: true });
  }
  if (journal.previousManifest) {
    atomicWriteText(path.join(context.extensionRoot, 'manifest.json'), journal.previousManifest);
  }
  if (parseSemver(journal.sourceVersion)) {
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

function recoverAndReadStatus(context) {
  let journal = readJournal(context);
  if (journal?.state === 'activation_pending') {
    journal = { ...journal, state: 'staged', reasonCode: 'update_activation_interrupted', updatedAt: new Date().toISOString() };
    writeJournal(context, journal);
  }
  if (journal?.state === 'applying') {
    rollbackFiles(context, journal);
    journal = { ...journal, state: 'rolled_back', reasonCode: 'update_interrupted', updatedAt: new Date().toISOString() };
    writeJournal(context, journal);
    settleAuthorization(context, journal.authorizationId, 'revoked');
  }
  if (journal?.state === 'rolled_back') {
    pruneNativeVersions(context.nativeRoot, new Set([
      readVersionPointer(context.nativeRoot, 'active-version'),
      readVersionPointer(context.nativeRoot, 'previous-version')
    ]));
  }
  return {
    managed: true,
    activeVersion: readVersionPointer(context.nativeRoot, 'active-version'),
    previousVersion: readVersionPointer(context.nativeRoot, 'previous-version'),
    transaction: journal ? publicTransaction(journal) : null,
    authorization: publicAuthorization(readAuthorization(context))
  };
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
  return marker?.managedBy === 'codex-overleaf-link' && marker?.kind === kind && marker?.bootstrapProtocol === 2;
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

async function fetchReleaseAsset(fetchImpl, url, limit) {
  const parsed = new URL(String(url || ''));
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || !parsed.pathname.startsWith('/Ghqqqq/codex-overleaf-link/releases/download/')) {
    throw updateError('update_asset_url_forbidden', 'Release asset URL is outside the trusted repository.');
  }
  const response = await fetchWithTimeout(fetchImpl, parsed.href, { redirect: 'follow' }, 20000);
  if (!response.ok) throw updateError('update_asset_http_error', 'Release asset download failed with HTTP ' + response.status + '.');
  const finalUrl = new URL(response.url || parsed.href);
  if (finalUrl.protocol !== 'https:' || !RELEASE_ASSET_HOSTS.has(finalUrl.hostname)) {
    throw updateError('update_asset_redirect_forbidden', 'Release asset redirected to an untrusted host.');
  }
  return readResponseBytes(response, limit);
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    throw updateError('update_network_failed', 'Update network request failed.', { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseBytes(response, limit) {
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared > limit) throw updateError('update_download_limit', 'Update response exceeds its size limit.');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > limit) throw updateError('update_download_limit', 'Update response exceeds its size limit.');
  return buffer;
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
    createdAt: journal.createdAt,
    activationRequestedAt: journal.activationRequestedAt,
    appliedAt: journal.appliedAt,
    confirmedAt: journal.confirmedAt,
    rolledBackAt: journal.rolledBackAt,
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
  const temp = target + '.tmp-' + process.pid + '-' + Date.now();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temp, value, { mode: 0o600 });
  fs.renameSync(temp, target);
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
  applyStagedUpdate,
  assertManagedLayout,
  authorizeUpdate,
  checkForUpdate,
  cleanupOrphanStageRoots,
  confirmUpdate,
  getApplyGate,
  getManagedContext,
  handleUpdateRequest,
  isUpdateMethod,
  revokeUpdate,
  rollbackUpdate,
  scheduleStagedActivation,
  stageCandidate,
  syncManagedMarkerVersions
};
