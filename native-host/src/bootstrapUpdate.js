'use strict';

// Coordination for the one compatible 2.5.0 -> 2.5.1 Bootstrap revision.
// All mutations run under updateManager's existing cross-process lock.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const Files = require('./bootstrapMigration');
const Contract = require('./bootstrapMigrationContract');
const { updateError } = require('./updateTrust');

const BOOTSTRAP_DEADLINE_MS = 120000;
const MAX_AUTOMATIC_ROLLBACK_ATTEMPTS = 3;
const BOOTSTRAP_STATES = new Set(['bootstrap_pending', 'bootstrap_rolling_back']);
const backupRoot = context => path.join(context.updatesRoot, 'bootstrap-migrations');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function migrationHint(context, journal) {
  if (!journal || !['awaiting_health', ...BOOTSTRAP_STATES].includes(journal.state)) return null;
  if (journal.bootstrapMigration) return journal.bootstrapMigration;
  if (journal.sourceVersion !== '2.5.0' || journal.targetVersion !== '2.5.1') return null;
  // This exact release pair requires migration even when discovery data was
  // lost. Missing evidence must not downgrade an update into a false success.
  return { phase: 'pending', targetRevision: '3.1' };
}

function bindBootstrapMigration(context, journal, deps) {
  if (journal?.state !== 'awaiting_health' || journal.bootstrapMigration || !migrationHint(context, journal)) return journal;
  const candidate = readJson(path.join(context.updatesRoot, 'candidate.json'));
  let verificationError = '';
  try { deps.assertAuthorization(journal); verifiedDescriptor(journal, candidate, deps); }
  catch (error) { verificationError = error.code || 'update_bootstrap_manifest_mismatch'; }
  const next = { ...journal, state: 'bootstrap_pending', bootstrapMigration: {
    phase: 'pending', targetRevision: '3.1', reloadCount: 0, verificationError,
    manifestBase64: candidate?.manifestBase64 || '', signatureBase64: candidate?.signatureBase64 || ''
  }, updatedAt: new Date().toISOString() };
  deps.writeJournal(next);
  return next;
}

function verifiedDescriptor(journal, evidence, deps) {
  const bytes = Buffer.from(evidence?.manifestBase64 || '', 'base64');
  if (!journal.manifestSha256 || hash(bytes) !== journal.manifestSha256) {
    throw updateError('update_bootstrap_manifest_mismatch', 'Bootstrap migration does not match the applied release.');
  }
  const manifest = deps.verifyManifest(bytes, Buffer.from(evidence?.signatureBase64 || '', 'base64'));
  if (manifest.version !== journal.targetVersion || manifest.updateBundle?.sha256 !== journal.bundleSha256
    || manifest.updateBundle?.size !== journal.bundleSize) {
    throw updateError('update_bootstrap_manifest_mismatch', 'Bootstrap migration does not match the update archive.');
  }
  const descriptor = Contract.validateBootstrapMigrationDescriptor(manifest.bootstrapMigration, { targetVersion: journal.targetVersion });
  if (!descriptor.sourceVersions.includes(journal.sourceVersion)) {
    throw updateError('update_bootstrap_source_version_mismatch', 'This installation has no compatible Bootstrap migration.');
  }
  return descriptor;
}

function payloadRootFor(context, journal) {
  return path.join(context.nativeRoot, 'versions', journal.targetVersion, 'native-host', 'bootstrap-payload');
}

function loadPlan(context, journal) {
  const root = backupRoot(context);
  if (!fs.existsSync(path.join(root, journal.id, 'state.json'))) return null;
  const plan = Files.loadBootstrapMigration({ backupRoot: root, transactionId: journal.id });
  if (plan.extensionRoot !== context.extensionRoot || plan.payloadRoot !== payloadRootFor(context, journal)
    || plan.sourceVersion !== journal.sourceVersion || plan.targetVersion !== journal.targetVersion) {
    throw updateError('update_bootstrap_transaction_mismatch', 'Bootstrap recovery belongs to a different installation.');
  }
  return plan;
}

async function advanceBootstrapMigration(context, journal, params, deps, options = {}) {
  if (!journal || !migrationHint(context, journal)) return { state: 'not_required' };
  if (params.transactionId !== journal.id) throw updateError('update_transaction_mismatch', 'Bootstrap update transaction changed.');
  journal = bindBootstrapMigration(context, journal, deps);
  if (journal.state !== 'bootstrap_pending') {
    throw updateError('update_transaction_state_changed', 'Bootstrap migration is no longer waiting to continue.');
  }
  if (deps.runningVersion !== journal.targetVersion) {
    throw updateError('update_bootstrap_native_restart_required', 'The target Native Host must start before updating Bootstrap.');
  }
  deps.assertAuthorization(journal);
  const descriptor = verifiedDescriptor(journal, journal.bootstrapMigration, deps);
  const payloadRoot = payloadRootFor(context, journal);
  Contract.assertBootstrapManifestShape(JSON.parse(fs.readFileSync(path.join(context.extensionRoot, 'manifest.json'), 'utf8')),
    { version: journal.targetVersion });
  Contract.assertBootstrapManifestShape(JSON.parse(fs.readFileSync(path.join(payloadRoot, 'manifest.template.json'), 'utf8')),
    { version: journal.targetVersion });
  // A syntax failure must be found before changing the only background entry.
  for (const file of descriptor.files) {
    const bytes = fs.readFileSync(path.join(payloadRoot, file.path));
    if (hash(bytes) !== file.targetSha256) throw updateError('update_bootstrap_payload_mismatch', 'Bootstrap payload changed after verification.');
    if (file.path.endsWith('.js')) new vm.Script(bytes.toString('utf8'), { filename: file.path });
  }
  deps.verifyArchive(journal);
  let plan = loadPlan(context, journal);
  if (!plan) plan = Files.prepareBootstrapMigration({
    descriptor, payloadRoot, extensionRoot: context.extensionRoot, backupRoot: backupRoot(context),
    transactionId: journal.id, sourceVersion: journal.sourceVersion, targetVersion: journal.targetVersion
  });
  if (plan.descriptorSha256 !== hash(JSON.stringify(descriptor))) {
    throw updateError('update_bootstrap_manifest_mismatch', 'Bootstrap recovery material does not match the signed release.');
  }
  let migration = { ...journal.bootstrapMigration, phase: plan.state === 'applied' ? 'applied' : 'prepared',
    targetDigest: plan.targetDigest, sourceDigest: plan.sourceDigest,
    deadline: journal.bootstrapMigration.deadline || Date.now() + BOOTSTRAP_DEADLINE_MS };
  if (Date.now() >= migration.deadline) throw updateError('update_bootstrap_health_timeout', 'Bootstrap update did not finish within its health window.');
  journal = { ...journal, bootstrapMigration: migration };
  deps.writeJournal(journal);
  // A new connection always establishes a new monitor handshake. PID reuse
  // alone can never authorize writing the only browser background entry.
  {
    const token = crypto.randomUUID();
    migration = { ...migration, watchdogToken: token, watchdogPid: null };
    journal = { ...journal, bootstrapMigration: migration };
    deps.writeJournal(journal);
    const pid = await (options.startWatchdog || startWatchdog)(context, journal, token);
    migration = { ...migration, watchdogPid: pid };
    journal = { ...journal, bootstrapMigration: migration };
    deps.writeJournal(journal);
  }
  Files.applyBootstrapMigration(plan, options.fileHooks);
  const observed = Files.verifyBootstrapMigration(plan);
  migration = { ...migration, phase: 'applied', targetDigest: observed.digest };
  if (params.bootstrapRevision === descriptor.targetRevision) {
    migration = { ...migration, phase: 'loaded', loadedAt: new Date().toISOString() };
    deps.writeJournal({ ...journal, state: 'awaiting_health', bootstrapMigration: migration });
    return { state: 'awaiting_health', transactionId: journal.id, targetVersion: journal.targetVersion,
      bootstrapRevision: descriptor.targetRevision };
  }
  if (migration.reloadCount >= 2) throw updateError('update_bootstrap_reload_failed', 'The new Bootstrap did not load after extension restart.');
  migration.reloadCount += 1;
  deps.writeJournal({ ...journal, bootstrapMigration: migration });
  return { state: 'reload_required', transactionId: journal.id, targetVersion: journal.targetVersion,
    bootstrapRevision: descriptor.targetRevision };
}

function assertBootstrapConfirmation(context, journal, params) {
  if (!journal.bootstrapMigration) {
    if (migrationHint(context, journal)) throw updateError('update_bootstrap_confirmation_pending', 'Bootstrap migration is still pending.');
    return;
  }
  if (journal.bootstrapMigration.phase !== 'loaded' || params.bootstrapRevision !== journal.bootstrapMigration.targetRevision) {
    throw updateError('update_bootstrap_confirmation_pending', 'The loaded Bootstrap did not confirm the target revision.');
  }
  const plan = loadPlan(context, journal);
  if (!plan || Files.verifyBootstrapMigration(plan).digest !== journal.bootstrapMigration.targetDigest) {
    throw updateError('update_bootstrap_target_mismatch', 'The confirmed Bootstrap bytes no longer match the target.');
  }
}

function restoreBootstrap(context, journal) {
  const plan = loadPlan(context, journal);
  if (!plan) {
    if (journal.bootstrapMigration && journal.bootstrapMigration.phase !== 'pending') {
      throw updateError('update_bootstrap_record_missing', 'Bootstrap recovery material is missing.');
    }
    if (journal.bootstrapMigration) return untouchedBootstrap(context, journal);
  }
  return plan ? Files.restoreBootstrapMigration(plan) : null;
}

function bootstrapEvidence(context, journal, expected) {
  const plan = loadPlan(context, journal);
  if (!plan && journal.bootstrapMigration) {
    if (expected !== 'source' || !(journal.bootstrapMigration.phase === 'pending'
      || journal.bootstrapMigration.phase === 'restored' && journal.bootstrapMigration.sourceUnchanged === true)) {
      throw updateError('update_bootstrap_record_missing', 'Bootstrap recovery material is missing.');
    }
    return untouchedBootstrap(context, journal);
  }
  return plan ? Files.verifyBootstrapMigration(plan, { expected }) : null;
}

// Without a file plan this transaction never wrote Bootstrap, so recovery only
// leaves it in place. Published source bytes keep the baseline digest; any other
// installed bytes (an earlier release candidate or local build) are recorded as
// observed. Later reads compare the same digest, so changes still block.
function untouchedBootstrap(context, journal) {
  let knownSource = true;
  const entries = Object.entries(Contract.BOOTSTRAP_MIGRATION_BASELINE).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([relative, expected]) => {
      const actual = readBootstrapFileHash(context, relative);
      if (actual !== expected) knownSource = false;
      return [relative, actual];
    });
  return { transactionId: journal.id, migrationId: 'bootstrap-v3.1-from-2.5.0',
    state: 'restored', expected: 'source', digest: hash(JSON.stringify(entries)), unmodified: true, knownSource };
}

function readBootstrapFileHash(context, relative) {
  const filename = path.join(context.extensionRoot, relative);
  if (!fs.existsSync(filename)) return null;
  if (!fs.lstatSync(filename).isFile()) {
    throw updateError('update_bootstrap_source_mismatch', 'Bootstrap source bytes cannot be confirmed.');
  }
  return hash(fs.readFileSync(filename));
}

// Runs before staging and in the update check. A signed migration starts only
// from the exact source bytes it names; other installations need a full
// reinstall instead of a transaction that cannot finish. This reads only the
// descriptor's file list, so later migration contracts use the same check.
function assertMigrationSource(context, manifest, sourceVersion) {
  const descriptor = manifest?.bootstrapMigration;
  if (!descriptor || !Array.isArray(descriptor.sourceVersions) || !descriptor.sourceVersions.includes(sourceVersion)
    || !Array.isArray(descriptor.files)) return;
  for (const file of descriptor.files) {
    const relative = String(file?.path || '');
    if (!/^bootstrap\/[A-Za-z0-9._-]+$/.test(relative)) {
      throw updateError('update_bootstrap_manifest_mismatch', 'Bootstrap migration file identity is invalid.');
    }
    if (readBootstrapFileHash(context, relative) !== (file.sourceSha256 ?? null)) {
      throw updateError('update_bootstrap_source_mismatch',
        'The installed startup files do not match the published source of this update.');
    }
  }
}

function bootstrapExpired(journal, { recoveryRequested = false, context } = {}) {
  const migration = journal?.bootstrapMigration;
  if (!migration || !['bootstrap_pending', 'bootstrap_rolling_back', 'awaiting_health'].includes(journal.state)) return false;
  // Automatic retries are bounded; an explicit update.rollback still runs.
  if (journal.state === 'bootstrap_rolling_back') {
    return Number(journal.rollbackFailure?.attempts || 0) < MAX_AUTOMATIC_ROLLBACK_ATTEMPTS;
  }
  return (migration.deadline && Date.now() >= migration.deadline)
    || (recoveryRequested && migration.phase !== 'pending' && !watchdogAlive(migration, context, journal));
}

function watchdogAlive(migration, context, journal) {
  if (!Number.isInteger(migration?.watchdogPid) || migration.watchdogPid < 1) return false;
  const heartbeat = context && journal && readJson(path.join(backupRoot(context), journal.id, 'watchdog.json'));
  if (!heartbeat || heartbeat.token !== migration.watchdogToken || heartbeat.pid !== migration.watchdogPid
    || heartbeat.transactionId !== journal.id || Date.now() - heartbeat.at > 2500 || heartbeat.at > Date.now() + 1000) return false;
  try { process.kill(migration.watchdogPid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function startWatchdog(context, journal, token) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'bootstrapUpdateWatchdog.js'),
      context.nativeRoot, context.extensionRoot, journal.id, token], {
      env: { ...context.env }, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    const timer = setTimeout(() => fail(new Error('Bootstrap recovery monitor did not become ready.')), 5000);
    let settled = false;
    function fail(error) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { child.kill(); } catch (_) { /* A failed child may already be gone. */ }
      reject(Object.assign(error, { code: 'update_bootstrap_monitor_unavailable' }));
    }
    child.on('error', fail);
    child.on('exit', () => { if (!settled) fail(new Error('Bootstrap recovery monitor exited before readiness.')); });
    child.on('message', message => {
      if (settled || message?.type !== 'ready' || message.token !== token || message.pid !== child.pid) return;
      settled = true; clearTimeout(timer); child.disconnect(); child.unref(); resolve(child.pid);
    });
  });
}

function readJson(filename) { try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch (_) { return null; } }

module.exports = { BOOTSTRAP_DEADLINE_MS, BOOTSTRAP_STATES, MAX_AUTOMATIC_ROLLBACK_ATTEMPTS, migrationHint,
  bindBootstrapMigration, advanceBootstrapMigration, assertBootstrapConfirmation, assertMigrationSource,
  restoreBootstrap, bootstrapEvidence, bootstrapExpired, watchdogAlive };
