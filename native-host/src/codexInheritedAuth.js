'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MARKER = '.codex-overleaf-auth-source.json';

function fingerprint(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function copyInheritedAuth(source, target) {
  const contents = fs.readFileSync(source);
  const authTemporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(authTemporary, contents, { mode: 0o600 });
    fs.renameSync(authTemporary, target);
  } finally {
    fs.rmSync(authTemporary, { force: true });
  }
  const marker = path.join(path.dirname(target), MARKER);
  const temporary = `${marker}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, source: path.resolve(source), digest: fingerprint(contents) }), { mode: 0o600 });
    fs.renameSync(temporary, marker);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// Source absence alone cannot identify independent or old, unattributed auth.
// Delete only the unchanged bytes that this home preparation actually copied.
function removeMissingInheritedAuth(source, target) {
  const marker = path.join(path.dirname(target), MARKER);
  const ownedMarker = `${marker}.claimed-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  try { fs.renameSync(marker, ownedMarker); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  let provenance;
  try { provenance = JSON.parse(fs.readFileSync(ownedMarker, 'utf8')); }
  catch (error) { restoreExclusive(ownedMarker, marker); throw error; }
  if (provenance?.version !== 1 || provenance.source !== path.resolve(source)) {
    restoreExclusive(ownedMarker, marker); return;
  }
  // Independent auth that already differs requires no file move at all.
  let contents;
  try { contents = fs.readFileSync(target); }
  catch (error) {
    if (error.code === 'ENOENT') { fs.rmSync(ownedMarker, { force: true }); return; }
    restoreExclusive(ownedMarker, marker); throw error;
  }
  if (fingerprint(contents) !== provenance.digest) {
    fs.rmSync(ownedMarker, { force: true }); return;
  }
  const detached = `${target}.preserved-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  try { fs.renameSync(target, detached); }
  catch (error) {
    restoreExclusive(ownedMarker, marker);
    if (error.code === 'ENOENT') return;
    throw error;
  }
  let inherited;
  try {
    inherited = fs.lstatSync(detached).isFile() && fingerprint(fs.readFileSync(detached)) === provenance.digest;
  } catch (error) {
    restoreExclusive(detached, target); restoreExclusive(ownedMarker, marker); throw error;
  }
  if (inherited) {
    // A concurrent login may already have published a new auth and marker.
    // Only these atomically claimed files belong to this cleanup operation.
    fs.rmSync(detached, { force: true });
  } else {
    restoreExclusive(detached, target);
  }
  fs.rmSync(ownedMarker, { force: true });
}

function restoreExclusive(detached, target) {
  try {
    fs.linkSync(detached, target);
    fs.rmSync(detached, { force: true });
  } catch (error) {
    if (error.code === 'EEXIST' && fs.existsSync(target)) return;
    // A nonmatching credential remains in the private preserved file. Starting
    // without restoring it would silently change the selected authentication.
    throw error;
  }
}

module.exports = { AUTH_SOURCE_MARKER: MARKER, copyInheritedAuth, removeMissingInheritedAuth };
