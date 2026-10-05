'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { updateError } = require('./updateTrust');
const { MUTATION_LOCK_STALE_MS, removeStaleUpdateFileLock } = require('./updateManager');

// A full install changes one Native version and a small fixed set of files.
// Retain just those destinations until registration and journal settlement
// succeed; this is in-process compensation, not crash recovery for the disk.
function createInstallRestorePoint({ nativeRoot, version, files }) {
  const rootWasAbsent = !fs.existsSync(nativeRoot);
  let existed = false;
  const backup = path.join(path.dirname(nativeRoot), '.native.rollback-' + crypto.randomUUID());
  const target = path.join(nativeRoot, 'versions', version);
  let targetExisted = false;
  let snapshots = [];
  let lock = null;
  let restored = false;
  try {
    lock = acquireInstallLock(nativeRoot);
    existed = fs.existsSync(path.join(nativeRoot, '.codex-overleaf-managed-native.json'));
    if (!existed && (fs.readdirSync(nativeRoot).some(name => name !== 'updates')
      || fs.readdirSync(path.join(nativeRoot, 'updates')).some(name => name !== 'mutation.lock'))) {
      throw new Error('Refusing to replace an unmarked managed native root: ' + nativeRoot);
    }
    targetExisted = fs.existsSync(target);
    snapshots = files.map(filename => {
      try {
        const stat = fs.statSync(filename);
        return { filename, bytes: fs.readFileSync(filename), mode: stat.mode & 0o777 };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return { filename, bytes: null };
      }
    });
    if (targetExisted) fs.cpSync(target, backup, { recursive: true });
  } catch (error) {
    if (lock) releaseInstallLock(lock);
    fs.rmSync(backup, { recursive: true, force: true });
    if (rootWasAbsent) {
      // Only remove directories still empty after our failed initialization;
      // never remove another creator's lock, marker or runtime files.
      try { fs.rmdirSync(path.join(nativeRoot, 'updates')); fs.rmdirSync(nativeRoot); } catch (_) { /* retained */ }
    }
    throw error;
  }
  return {
    nativeExisted: existed,
    restore() {
      assertInstallLock(lock);
      const errors = [];
      const attempt = action => { try { action(); } catch (error) { errors.push(error); } };
      attempt(() => {
        fs.rmSync(target, { recursive: true, force: true });
        if (targetExisted) fs.renameSync(backup, target);
      });
      for (const snapshot of snapshots) attempt(() => {
        if (snapshot.bytes === null) fs.rmSync(snapshot.filename, { force: true });
        else {
          fs.mkdirSync(path.dirname(snapshot.filename), { recursive: true });
          fs.writeFileSync(snapshot.filename, snapshot.bytes, { mode: snapshot.mode });
          fs.chmodSync(snapshot.filename, snapshot.mode);
        }
      });
      if (errors.length) throw updateError('managed_install_restore_failed',
        'Managed installation failed and the previous installation could not be fully restored.', { cause: errors[0] });
      restored = true;
    },
    finish() {
      let removeEmptyRoot = false;
      try {
        fs.rmSync(backup, { recursive: true, force: true });
        if (restored && !existed) {
          assertInstallLock(lock);
          // The root was created by this install. Keep its mutation lock while
          // removing our remaining staging/directories, including after all
          // filesystem and browser-registration compensation has completed.
          for (const name of fs.readdirSync(nativeRoot)) {
            if (name !== 'updates') fs.rmSync(path.join(nativeRoot, name), { recursive: true, force: true });
          }
          for (const name of fs.readdirSync(path.join(nativeRoot, 'updates'))) {
            if (name !== 'mutation.lock') fs.rmSync(path.join(nativeRoot, 'updates', name), { recursive: true, force: true });
          }
          removeEmptyRoot = true;
        }
      }
      finally { if (lock) releaseInstallLock(lock); }
      if (removeEmptyRoot) {
        // After release another installer may own these paths. Empty-only
        // removal cannot delete its new lock, metadata, runtime or bridge.
        for (const directory of [path.join(nativeRoot, 'updates'), nativeRoot]) {
          try { fs.rmdirSync(directory); }
          catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
        }
      }
    },
    release() { if (lock) releaseInstallLock(lock); }
  };
}

function assertInstallLock(lock) {
  let owner;
  try { owner = JSON.parse(fs.readFileSync(lock.filename, 'utf8')); } catch (_) { /* unknown */ }
  if (owner?.token !== lock?.token) {
    throw updateError('managed_install_restore_failed', 'The installation no longer owns its recovery lock.');
  }
}

function acquireInstallLock(nativeRoot) {
  const filename = path.join(nativeRoot, 'updates', 'mutation.lock');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = fs.openSync(filename, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ token, pid: process.pid, operationId: '',
        createdAt: Date.now(), expiresAt: Date.now() + MUTATION_LOCK_STALE_MS }));
      fs.closeSync(descriptor);
      return { filename, token };
    } catch (error) {
      if (descriptor !== undefined) { fs.closeSync(descriptor); fs.rmSync(filename, { force: true }); throw error; }
      if (error.code !== 'EEXIST') throw error;
      if (!removeStaleUpdateFileLock(filename)) {
        throw updateError('update_busy', 'A managed update is in progress. Retry installation after it settles.');
      }
    }
  }
  throw updateError('update_busy', 'A managed update is in progress. Retry installation after it settles.');
}

function releaseInstallLock(lock) {
  try {
    if (JSON.parse(fs.readFileSync(lock.filename, 'utf8')).token === lock.token) fs.rmSync(lock.filename);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

module.exports = { createInstallRestorePoint };
