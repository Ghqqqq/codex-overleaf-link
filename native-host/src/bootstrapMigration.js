'use strict';

// This module owns only files and their recovery record. The caller must verify
// the signed release, bind its authorization and hold the update mutation lock.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateBootstrapMigrationDescriptor } = require('./bootstrapMigrationContract');

const RECORD_SCHEMA = 1;
const TRANSACTION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function prepareBootstrapMigration(options, hooks = {}) {
  const descriptor = clone(options.descriptor);
  validateBootstrapMigrationDescriptor(descriptor, { targetVersion: options.targetVersion });
  if (!descriptor.sourceVersions.includes(options.sourceVersion)) fail('source_version_mismatch');
  const transactionId = validTransaction(options.transactionId);
  const backupRoot = absoluteRoot(options.backupRoot);
  const extensionRoot = absoluteRoot(options.extensionRoot);
  const payloadRoot = absoluteRoot(options.payloadRoot);
  if (overlaps(backupRoot, extensionRoot) || overlaps(backupRoot, payloadRoot)
      || overlaps(extensionRoot, payloadRoot)) fail('roots_overlap');
  ensureDirectory(backupRoot);
  const recordRoot = path.join(backupRoot, transactionId);
  ensureChildDirectory(backupRoot, transactionId);
  const journalPath = path.join(recordRoot, 'state.json');
  const identity = { transactionId, sourceVersion: options.sourceVersion,
    targetVersion: options.targetVersion, extensionRoot, payloadRoot,
    descriptorSha256: hash(JSON.stringify(descriptor)) };
  if (readFileInfo(journalPath)) {
    const saved = loadBootstrapMigration({ backupRoot, transactionId });
    if (Object.entries(identity).some(([key, value]) => saved[key] !== value)) fail('transaction_mismatch');
    return saved;
  }

  // Verify the entire source and target before writing any recovery material.
  const files = descriptor.files.map(file => {
    const source = readRootFile(extensionRoot, file.path);
    if (source?.sha256 !== file.sourceSha256 && !(source === null && file.sourceSha256 === null)) fail('source_mismatch', file.path);
    const target = readRootFile(payloadRoot, file.path);
    if (!target || target.sha256 !== file.targetSha256) fail('payload_mismatch', file.path);
    return { ...file, sourceMode: source?.mode ?? null, targetMode: source?.mode ?? target.mode };
  });
  ensureChildDirectory(recordRoot, 'files');
  for (const file of files) {
    if (file.sourceSha256 === null) continue;
    const source = readRootFile(extensionRoot, file.path);
    if (!source || source.sha256 !== file.sourceSha256 || source.mode !== file.sourceMode) fail('source_mismatch', file.path);
    const target = childFile(recordRoot, 'files/' + file.path, true);
    atomicWrite(target, source.bytes, 0o600, hooks, 'backup');
  }
  const record = { schemaVersion: RECORD_SCHEMA, ...identity, descriptor,
    migrationId: descriptor.id, backupRoot, recordRoot, journalPath, files,
    sourceDigest: digest(files, 'sourceSha256'), targetDigest: digest(files, 'targetSha256'),
    state: 'prepared', pending: null, completed: [], createdAt: new Date().toISOString() };
  writeRecord(record, hooks);
  return publicPlan(record);
}

function loadBootstrapMigration({ backupRoot, transactionId }) {
  backupRoot = absoluteRoot(backupRoot);
  transactionId = validTransaction(transactionId);
  const recordRoot = childFile(backupRoot, transactionId);
  const journalPath = childFile(recordRoot, 'state.json');
  const info = readFileInfo(journalPath);
  if (!info) fail('record_missing');
  let record;
  try { record = JSON.parse(info.bytes.toString('utf8')); } catch (_) { fail('record_invalid'); }
  if (!record || record.schemaVersion !== RECORD_SCHEMA || record.transactionId !== transactionId
      || record.backupRoot !== backupRoot || record.recordRoot !== recordRoot || record.journalPath !== journalPath) fail('record_invalid');
  validateBootstrapMigrationDescriptor(record.descriptor, { targetVersion: record.targetVersion });
  if (!record.descriptor.sourceVersions.includes(record.sourceVersion)
      || record.migrationId !== record.descriptor.id
      || record.descriptorSha256 !== hash(JSON.stringify(record.descriptor))
      || !Array.isArray(record.files) || record.files.length !== record.descriptor.files.length
      || !['prepared', 'applying', 'applied', 'restoring', 'restored'].includes(record.state)
      || !Array.isArray(record.completed)) fail('record_invalid');
  const extensionRoot = absoluteRoot(record.extensionRoot);
  const payloadRoot = absoluteRoot(record.payloadRoot);
  if (overlaps(backupRoot, extensionRoot) || overlaps(backupRoot, payloadRoot)
      || overlaps(extensionRoot, payloadRoot)) fail('roots_overlap');
  for (let index = 0; index < record.files.length; index++) {
    const file = record.files[index];
    const expected = record.descriptor.files[index];
    if (['path', 'sourceSha256', 'targetSha256'].some(key => file[key] !== expected[key])
        || !validMode(file.targetMode) || (file.sourceSha256 === null ? file.sourceMode !== null : !validMode(file.sourceMode))) fail('record_invalid');
  }
  if (record.sourceDigest !== digest(record.files, 'sourceSha256')
      || record.targetDigest !== digest(record.files, 'targetSha256')) fail('record_invalid');
  return publicPlan(record);
}

function applyBootstrapMigration(plan, hooks = {}) {
  const record = reloadPlan(plan);
  if (record.state === 'restoring' || record.state === 'restored') fail('already_restoring');
  verifyKnownFiles(record);
  verifyBackups(record);
  for (const file of record.files) {
    const target = readRootFile(record.payloadRoot, file.path);
    if (!target || target.sha256 !== file.targetSha256) fail('payload_mismatch', file.path);
  }
  if (record.state === 'applied') return verifyBootstrapMigration(record, { expected: 'target' });
  record.state = 'applying';
  writeRecord(record, hooks);
  for (const file of writeOrder(record.files)) {
    record.pending = file.path;
    writeRecord(record, hooks);
    const current = readRootFile(record.extensionRoot, file.path);
    if (!matchesKnown(current, file)) fail('source_mismatch', file.path);
    if (current?.sha256 !== file.targetSha256 || current.mode !== file.targetMode) {
      const target = readRootFile(record.payloadRoot, file.path);
      if (!target || target.sha256 !== file.targetSha256) fail('payload_mismatch', file.path);
      atomicWrite(childFile(record.extensionRoot, file.path, true), target.bytes, file.targetMode, hooks, 'apply');
    }
    verifyFile(record.extensionRoot, file, 'target');
    if (!record.completed.includes(file.path)) record.completed.push(file.path);
    record.pending = null;
    writeRecord(record, hooks);
  }
  record.state = 'applied';
  writeRecord(record, hooks);
  return verifyBootstrapMigration(record, { expected: 'target' });
}

function restoreBootstrapMigration(plan, hooks = {}) {
  const record = reloadPlan(plan);
  verifyKnownFiles(record);
  verifyBackups(record);
  if (record.state === 'restored') return verifyBootstrapMigration(record, { expected: 'source' });
  record.state = 'restoring';
  writeRecord(record, hooks);
  // Reverse dependencies: restore HTML/entry users before removing new files.
  for (const file of writeOrder(record.files).reverse()) {
    record.pending = file.path;
    writeRecord(record, hooks);
    const current = readRootFile(record.extensionRoot, file.path);
    if (!matchesKnown(current, file)) fail('source_mismatch', file.path);
    const target = childFile(record.extensionRoot, file.path);
    if (file.sourceSha256 === null) {
      if (current) {
        fs.unlinkSync(target);
        syncDirectory(path.dirname(target));
        step(hooks, 'restore:removed', target);
      }
    } else if (current?.sha256 !== file.sourceSha256 || current.mode !== file.sourceMode) {
      const backup = readRootFile(record.recordRoot, 'files/' + file.path);
      if (!backup || backup.sha256 !== file.sourceSha256) fail('backup_mismatch', file.path);
      atomicWrite(target, backup.bytes, file.sourceMode, hooks, 'restore');
    }
    verifyFile(record.extensionRoot, file, 'source');
    record.completed = record.completed.filter(value => value !== file.path);
    record.pending = null;
    writeRecord(record, hooks);
  }
  record.state = 'restored';
  writeRecord(record, hooks);
  return verifyBootstrapMigration(record, { expected: 'source' });
}

function verifyBootstrapMigration(plan, { expected = 'target' } = {}) {
  if (!['source', 'target'].includes(expected)) fail('expectation_invalid');
  const record = reloadPlan(plan);
  for (const file of record.files) verifyFile(record.extensionRoot, file, expected);
  return { transactionId: record.transactionId, migrationId: record.migrationId,
    state: record.state, digest: expected === 'target' ? record.targetDigest : record.sourceDigest,
    targetRevision: record.descriptor.targetRevision, expected };
}

function readBootstrapMigrationState(plan) { return reloadPlan(plan); }

function reloadPlan(plan) {
  if (!plan || typeof plan !== 'object') fail('record_invalid');
  const saved = loadBootstrapMigration(plan);
  for (const key of ['descriptorSha256', 'extensionRoot', 'payloadRoot', 'sourceVersion', 'targetVersion']) {
    if (plan[key] !== saved[key]) fail('transaction_mismatch');
  }
  return saved;
}

function verifyKnownFiles(record) {
  for (const file of record.files) {
    if (!matchesKnown(readRootFile(record.extensionRoot, file.path), file)) fail('source_mismatch', file.path);
  }
}

function matchesKnown(current, file) {
  if (current === null) return file.sourceSha256 === null;
  return (current.sha256 === file.sourceSha256 && current.mode === file.sourceMode)
    || (current.sha256 === file.targetSha256 && current.mode === file.targetMode);
}

function verifyBackups(record) {
  for (const file of record.files) {
    if (file.sourceSha256 === null) continue;
    const backup = readRootFile(record.recordRoot, 'files/' + file.path);
    if (!backup || backup.sha256 !== file.sourceSha256) fail('backup_mismatch', file.path);
  }
}

function verifyFile(root, file, expected) {
  const current = readRootFile(root, file.path);
  const expectedHash = file[expected + 'Sha256'];
  if (expectedHash === null ? current !== null : !current || current.sha256 !== expectedHash
      || current.mode !== file[expected + 'Mode']) fail(expected + '_mismatch', file.path);
}

function writeOrder(files) {
  const rank = file => file.sourceSha256 === null ? 0 : file.path === 'bootstrap/background.js' ? 3
    : file.path.endsWith('.html') ? 2 : 1;
  return [...files].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
}

function writeRecord(record, hooks) {
  record.updatedAt = new Date().toISOString();
  atomicWrite(record.journalPath, JSON.stringify(record, null, 2) + '\n', 0o600, hooks, 'journal');
}

function atomicWrite(target, bytes, mode, hooks, phase) {
  try { if (!fs.lstatSync(target).isFile()) fail('path_unsafe'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = target + '.migration-' + crypto.randomBytes(8).toString('hex') + '.tmp';
  const fd = fs.openSync(temporary, 'wx', mode);
  try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  step(hooks, phase + ':temporary', target);
  fs.renameSync(temporary, target);
  syncDirectory(path.dirname(target));
  step(hooks, phase + ':replaced', target);
}

function syncDirectory(directory) {
  let fd;
  try { fd = fs.openSync(directory, 'r'); fs.fsyncSync(fd); }
  catch (error) {
    // Windows does not expose POSIX directory fsync through Node. File contents
    // are flushed before rename on all platforms; directory durability is OS-dependent.
    if (process.platform !== 'win32' || !['EPERM', 'EISDIR', 'EINVAL', 'EBADF', 'EACCES'].includes(error.code)) throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function childFile(root, relative, createParents = false) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')
      || path.isAbsolute(relative)) fail('path_unsafe');
  assertDirectory(root);
  const parts = relative.split('/');
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    if (createParents && !fs.existsSync(parent)) { fs.mkdirSync(parent, { mode: 0o700 }); syncDirectory(path.dirname(parent)); }
    assertDirectory(parent);
  }
  const target = path.join(root, ...parts);
  try { if (fs.lstatSync(target).isSymbolicLink()) fail('path_unsafe'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return target;
}

function readRootFile(root, relative) { return readFileInfo(childFile(root, relative)); }

function readFileInfo(target) {
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) fail('path_unsafe', target);
  const bytes = fs.readFileSync(target);
  return { bytes, sha256: hash(bytes), mode: stat.mode & 0o777 };
}

function ensureDirectory(root) {
  if (!fs.existsSync(root)) {
    ensureDirectory(path.dirname(root));
    fs.mkdirSync(root, { mode: 0o700 });
    syncDirectory(path.dirname(root));
  }
  assertDirectory(root);
}
function ensureChildDirectory(root, relative) {
  const directory = childFile(root, relative, true);
  if (!fs.existsSync(directory)) { fs.mkdirSync(directory, { mode: 0o700 }); syncDirectory(path.dirname(directory)); }
  assertDirectory(directory);
  return directory;
}
function assertDirectory(value) { if (!fs.lstatSync(value).isDirectory() || fs.lstatSync(value).isSymbolicLink()) fail('path_unsafe'); }
function absoluteRoot(value) { if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) fail('path_unsafe'); return value; }
function validTransaction(value) { if (typeof value !== 'string' || !TRANSACTION_ID.test(value) || value === '.' || value === '..') fail('transaction_invalid'); return value; }
function overlaps(a, b) { return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep); }
function validMode(value) { return Number.isInteger(value) && value >= 0 && value <= 0o777; }
function digest(files, key) { return hash(JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path)).map(file => [file.path, file[key]]))); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function publicPlan(record) { return clone(record); }
function step(hooks, phase, target) { if (typeof hooks.onStep === 'function') hooks.onStep({ phase, path: target }); }
function fail(reason, file) { const error = new Error('Bootstrap migration ' + reason.replaceAll('_', ' ') + (file ? ': ' + file : '.')); error.code = 'update_bootstrap_' + reason; throw error; }

module.exports = { prepareBootstrapMigration, loadBootstrapMigration, applyBootstrapMigration,
  restoreBootstrapMigration, verifyBootstrapMigration, readBootstrapMigrationState };
