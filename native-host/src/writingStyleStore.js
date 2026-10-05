'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function writeJson(file, value) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  let created = false;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    created = true;
    try { fs.writeFileSync(fd, JSON.stringify(value)); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally {
    if (created) fs.rmSync(temp, { force: true });
  }
}

function withConfigLock(scope, action) {
  const lock = path.join(scope.root, '.config-lock');
  const owner = process.pid + '-' + crypto.randomUUID() + '.owner';
  const pending = path.join(scope.root, '.config-lock-' + owner);
  let acquired = false, prepared = false;
  try {
    // Publish a nonempty directory atomically, so a reaper can only remove an
    // empty old lock; it cannot remove a replacement owner's marker.
    fs.mkdirSync(pending, { mode: 0o700 });
    prepared = true;
    fs.writeFileSync(path.join(pending, owner), '', { mode: 0o600 });
    const deadline = Date.now() + 2000;
    while (!acquired) {
      try { fs.renameSync(pending, lock); acquired = true; }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        const stat = fs.lstatSync(lock, { throwIfNoEntry: false });
        if (!stat && ['EPERM', 'EACCES'].includes(error.code)) throw error;
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw error;
        if (stat) reapDeadOwner(lock);
        if (Date.now() >= deadline) throw Object.assign(new Error('Writing-style settings are being updated by another Native Host. Retry shortly.'), { code: 'writing_style_busy' });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    return action();
  } finally {
    if (acquired) removeOwner(lock, owner);
    if (prepared) fs.rmSync(pending, { recursive: true, force: true });
  }
}

function reapDeadOwner(lock) {
  let entries;
  try { entries = fs.readdirSync(lock); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!entries.length) { removeEmptyLock(lock); return; }
  if (entries.length !== 1) return;
  const match = /^([1-9]\d*)-[a-f0-9-]{36}\.owner$/.exec(entries[0]);
  if (!match || !Number.isSafeInteger(Number(match[1]))) return;
  try { process.kill(Number(match[1]), 0); }
  catch (error) { if (error.code === 'ESRCH') removeOwner(lock, entries[0]); }
}

function removeOwner(lock, owner) {
  try { fs.unlinkSync(path.join(lock, owner)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  removeEmptyLock(lock);
}

function removeEmptyLock(lock) {
  try { fs.rmdirSync(lock); }
  catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
}

module.exports = { writeJson, withConfigLock };
