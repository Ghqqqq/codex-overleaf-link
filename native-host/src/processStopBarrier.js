'use strict';

// A stop acknowledgement is not proof of process exit. This quarantine survives
// Native Host restarts and only permits work after positive exit evidence.
const fs = require('node:fs');
const path = require('node:path');
const { getProjectMirror, getDefaultMirrorRoot } = require('./mirrorWorkspace');
const pending = new Map();

function location(projectId, rootDir) {
  const mirror = getProjectMirror(projectId, { rootDir });
  return path.join(path.dirname(mirror.workspacePath), '.codex-stop-barrier.json');
}

function load(file) {
  let records = [];
  try {
    if (fs.statSync(file).size > 65536) throw new Error('Oversized stop barrier');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(value) || value.length > 64) throw new Error('Invalid stop barrier');
    records = value.map(record => record && typeof record === 'object' ? record : { unknown: true });
  } catch (error) {
    if (error.code !== 'ENOENT') records = [{ unknown: true }];
  }
  // Other Hosts can publish a barrier while this Host is already alive. Keep
  // in-memory callbacks and failed writes, but never cache an empty disk read.
  const key = ({ isStopped, ...record }) => JSON.stringify(record);
  const merged = new Map(records.map(record => [key(record), record]));
  for (const record of pending.get(file) || []) {
    if (typeof record.isStopped === 'function' || record.persistenceFailed) merged.set(key(record), record);
  }
  records = Array.from(merged.values());
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
  const entry = {
    processId: error.processId, processGroup: error.processGroup === true,
    platform: process.platform, createdAt: new Date().toISOString(),
    isStopped: error.isStopped
  };
  records.push(entry);
  try { persist(file, records); }
  catch (failure) {
    Object.defineProperty(entry, 'persistenceFailed', { value: true });
    error.stopBarrierPersistenceError = failure.message;
  }
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

// Update safety observes the existing project quarantine. It neither searches
// unrelated OS processes nor mutates a project's recovery records.
function getBlockedProjectCount(rootDir, options = {}) {
  const root = path.resolve(rootDir || getDefaultMirrorRoot(options));
  const files = new Set();
  let unknown = 0;
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) files.add(path.join(root, entry.name, '.codex-stop-barrier.json'));
      else if (entry.isSymbolicLink()) unknown += 1;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') unknown += 1;
  }
  // Include failed persistence owned by this Host, even if its directory was
  // never created. A disk inventory alone cannot release that quarantine.
  for (const file of pending.keys()) {
    if (path.dirname(path.dirname(file)) === root) files.add(file);
  }
  for (const file of files) {
    if (load(file).some(value => !stopped(value))) unknown += 1;
  }
  return unknown;
}

module.exports = { record, isBlocked, getBlockedProjectCount };
