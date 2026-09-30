'use strict';

// A stop acknowledgement is not proof of process exit. This quarantine survives
// Native Host restarts and only permits work after positive exit evidence.
const fs = require('node:fs');
const path = require('node:path');
const { getProjectMirror } = require('./mirrorWorkspace');
const pending = new Map();

function location(projectId, rootDir) {
  const mirror = getProjectMirror(projectId, { rootDir });
  return path.join(path.dirname(mirror.workspacePath), '.codex-stop-barrier.json');
}

function load(file) {
  if (pending.has(file)) return pending.get(file);
  let records = [];
  try {
    if (fs.statSync(file).size > 65536) throw new Error('Oversized stop barrier');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(value) || value.length > 64) throw new Error('Invalid stop barrier');
    records = value;
  } catch (error) {
    if (error.code !== 'ENOENT') records = [{ unknown: true }];
  }
  pending.set(file, records);
  return records;
}

function persist(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.tmp';
  const fd = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(records.map(({ isStopped, ...record }) => record)));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}

function stopped(record) {
  if (typeof record.isStopped === 'function') {
    try { return record.isStopped() === true; } catch (_) { return false; }
  }
  // Recovered POSIX process-group identities can be checked without signalling
  // or killing anything. Unknown/Windows trees remain quarantined.
  if (record.processGroup !== true || record.platform !== process.platform
    || !Number.isInteger(record.processId) || record.processId <= 0) return false;
  try { process.kill(-record.processId, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

function record(projectId, rootDir, error) {
  const file = location(projectId, rootDir);
  const records = load(file);
  records.push({
    processId: error.processId, processGroup: error.processGroup === true,
    platform: process.platform, createdAt: new Date().toISOString(),
    isStopped: error.isStopped
  });
  try { persist(file, records); }
  catch (failure) { error.stopBarrierPersistenceError = failure.message; }
}

function isBlocked(projectId, rootDir) {
  const file = location(projectId, rootDir);
  const records = load(file);
  if (!records.length) return false;
  const remaining = records.filter(value => !stopped(value));
  if (remaining.length !== records.length) {
    try {
      persist(file, remaining);
      pending.set(file, remaining);
    } catch (_) { return true; }
  }
  return remaining.length > 0;
}

module.exports = { record, isBlocked };

