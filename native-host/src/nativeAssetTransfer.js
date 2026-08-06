'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { getProjectMirror } = require('./mirrorWorkspace');

const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const ASSET_CHUNK_BYTES = 192 * 1024;
const ASSET_TOKEN_TTL_MS = 15 * 60 * 1000;
const transfers = new Map();

function prepareBinaryAssetChanges({ projectId, rootDir, changes = [] } = {}) {
  const prepared = [];
  const unsupportedChanges = [];
  for (const change of changes) {
    if (change?.type !== 'binary-create' && change?.type !== 'overwrite-binary') {
      prepared.push(change);
      continue;
    }
    try {
      prepared.push(registerAssetChange({ projectId, rootDir, change }));
    } catch (error) {
      unsupportedChanges.push({
        type: 'unsupported-local-file',
        path: change?.path || '',
        reason: error.code || 'binary_asset_registration_failed',
        size: change?.size,
        attemptedChangeType: change?.type || 'binary-create'
      });
    }
  }
  return { changes: prepared, unsupportedChanges };
}

function registerAssetChange({ projectId, rootDir, change }) {
  cleanupExpiredTransfers();
  const mirror = getProjectMirror(projectId, { rootDir });
  const relativePath = normalizeProjectPath(change.assetSourcePath || change.path);
  const target = resolveSafeWorkspaceFile(mirror.workspacePath, relativePath);
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw codedError('binary_asset_source_invalid', 'Asset source is not a file.');
  if (stat.size > MAX_ASSET_BYTES) throw codedError('binary_file_too_large', 'Asset exceeds the 10 MiB writeback limit.');
  const sha256 = hashFile(target);
  if (change.sha256 && change.sha256 !== sha256) {
    throw codedError('binary_asset_source_changed', 'Asset changed before transfer registration.');
  }
  const token = crypto.randomUUID();
  const expiresAtMs = Date.now() + ASSET_TOKEN_TTL_MS;
  transfers.set(token, {
    token,
    path: relativePath,
    target,
    size: stat.size,
    sha256,
    expiresAtMs
  });
  const { contentBase64, assetSourcePath, ...safeChange } = change;
  return {
    ...safeChange,
    size: stat.size,
    assetRef: {
      token,
      path: relativePath,
      size: stat.size,
      sha256,
      mimeType: inferMimeType(relativePath),
      chunkSize: ASSET_CHUNK_BYTES,
      expiresAt: new Date(expiresAtMs).toISOString()
    }
  };
}

function readAssetChunk(params = {}) {
  cleanupExpiredTransfers();
  const transfer = getTransfer(params.token);
  const offset = Number(params.offset || 0);
  const requestedLength = Number(params.length || ASSET_CHUNK_BYTES);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > transfer.size) {
    throw codedError('asset_chunk_offset_invalid', 'Asset chunk offset is invalid.');
  }
  const length = Math.min(
    ASSET_CHUNK_BYTES,
    Number.isSafeInteger(requestedLength) && requestedLength > 0 ? requestedLength : ASSET_CHUNK_BYTES,
    transfer.size - offset
  );
  assertSourceStable(transfer);
  const handle = fs.openSync(transfer.target, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = length ? fs.readSync(handle, buffer, 0, length, offset) : 0;
    const nextOffset = offset + bytesRead;
    return {
      token: transfer.token,
      path: transfer.path,
      offset,
      nextOffset,
      size: transfer.size,
      sha256: transfer.sha256,
      contentBase64: buffer.subarray(0, bytesRead).toString('base64'),
      eof: nextOffset >= transfer.size
    };
  } finally {
    fs.closeSync(handle);
  }
}

function releaseAsset(params = {}) {
  return { released: transfers.delete(String(params.token || '')) };
}

function getTransfer(tokenValue) {
  const token = String(tokenValue || '');
  const transfer = transfers.get(token);
  if (!transfer) throw codedError('asset_token_invalid', 'Asset transfer token is invalid or expired.');
  if (transfer.expiresAtMs <= Date.now()) {
    transfers.delete(token);
    throw codedError('asset_token_expired', 'Asset transfer token expired.');
  }
  return transfer;
}

function assertSourceStable(transfer) {
  let stat;
  try { stat = fs.statSync(transfer.target); } catch (_error) {
    throw codedError('binary_asset_source_missing', 'Asset source disappeared during transfer.');
  }
  if (!stat.isFile() || stat.size !== transfer.size) {
    throw codedError('binary_asset_source_changed', 'Asset source changed during transfer.');
  }
}

function resolveSafeWorkspaceFile(workspacePath, relativePath) {
  const root = path.resolve(workspacePath);
  const target = path.resolve(root, relativePath);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw codedError('binary_asset_path_unsafe', 'Asset path escapes the project workspace.');
  }
  if (fs.lstatSync(target).isSymbolicLink()) {
    throw codedError('binary_asset_path_unsafe', 'Symbolic-link assets cannot be transferred.');
  }
  return target;
}

function normalizeProjectPath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw codedError('binary_asset_path_invalid', 'Asset path is not a safe project-relative path.');
  }
  return normalized;
}

function hashFile(target) {
  return crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
}

function inferMimeType(filePath) {
  return {
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.webp': 'image/webp', '.eps': 'application/postscript'
  }[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function cleanupExpiredTransfers() {
  const now = Date.now();
  for (const [token, transfer] of transfers) if (transfer.expiresAtMs <= now) transfers.delete(token);
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  ASSET_CHUNK_BYTES,
  ASSET_TOKEN_TTL_MS,
  MAX_ASSET_BYTES,
  prepareBinaryAssetChanges,
  readAssetChunk,
  releaseAsset
};
