'use strict';

const crypto = require('node:crypto');

const UPDATE_REPOSITORY = 'Ghqqqq/codex-overleaf-link';
const UPDATE_CHANNEL = 'stable';
const UPDATE_MANIFEST_SCHEMA = 2;
const BOOTSTRAP_PROTOCOL = 2;
const TRUSTED_UPDATE_KEYS = Object.freeze({
  'release-2026-01': [
    '-----BEGIN PUBLIC KEY-----',
    'MCowBQYDK2VwAyEAhqNKNHdRuggyqyMz2knkMgNYgoUZS6FEjQlnYWgyDFA=',
    '-----END PUBLIC KEY-----',
    ''
  ].join('\n')
});

function verifySignedReleaseManifest(manifestBytes, signatureBytes, options = {}) {
  const rawManifest = toBoundedBuffer(manifestBytes, 256 * 1024, 'update_manifest_too_large');
  const rawSignature = toBoundedBuffer(signatureBytes, 16 * 1024, 'update_signature_too_large');
  const envelope = parseJsonObject(rawSignature, 'update_signature_invalid');
  if (envelope.algorithm !== 'Ed25519') {
    throw updateError('update_signature_algorithm_unsupported', 'Update signature algorithm must be Ed25519.');
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(String(envelope.keyId || ''))) {
    throw updateError('update_signature_key_invalid', 'Update signature key id is invalid.');
  }

  const keys = options.publicKeys || TRUSTED_UPDATE_KEYS;
  const publicKey = keys[envelope.keyId];
  if (!publicKey) {
    throw updateError('update_signature_key_unknown', 'Update signature key is not trusted.');
  }

  let signature;
  try {
    signature = Buffer.from(String(envelope.signature || ''), 'base64');
  } catch (_error) {
    throw updateError('update_signature_invalid', 'Update signature encoding is invalid.');
  }
  if (signature.length !== 64 || !crypto.verify(null, rawManifest, publicKey, signature)) {
    throw updateError('update_signature_invalid', 'Update manifest signature verification failed.');
  }

  const manifest = parseJsonObject(rawManifest, 'update_manifest_invalid');
  validateReleaseManifest(manifest, options);
  return manifest;
}

function validateReleaseManifest(manifest, options = {}) {
  const repository = options.repository || UPDATE_REPOSITORY;
  const channel = options.channel || UPDATE_CHANNEL;
  const bootstrapProtocol = Number(options.bootstrapProtocol || BOOTSTRAP_PROTOCOL);
  if (manifest.schemaVersion !== UPDATE_MANIFEST_SCHEMA) {
    throw updateError('update_manifest_schema_unsupported', 'Update manifest schema is not supported.');
  }
  if (manifest.repository !== repository || manifest.channel !== channel) {
    throw updateError('update_manifest_origin_mismatch', 'Update manifest repository or channel does not match this installation.');
  }
  const version = parseSemver(manifest.version);
  const expectedTag = options.tag || 'v' + manifest.version;
  if (!version || manifest.tag !== expectedTag) {
    throw updateError('update_manifest_version_invalid', 'Update manifest version or tag is invalid.');
  }
  if (!Number.isInteger(manifest.bootstrapProtocol) || manifest.bootstrapProtocol !== bootstrapProtocol) {
    throw updateError('update_bootstrap_upgrade_required', 'This release requires a different Bootstrap protocol.');
  }
  if (!/^[0-9a-f]{40}$/.test(String(manifest.gitCommit || ''))) {
    throw updateError('update_manifest_commit_invalid', 'Update manifest commit is invalid.');
  }
  if (!Number.isFinite(Date.parse(String(manifest.createdAt || '')))) {
    throw updateError('update_manifest_timestamp_invalid', 'Update manifest timestamp is invalid.');
  }
  const bundle = manifest.updateBundle;
  const expectedName = 'codex-overleaf-update-v' + manifest.version + '.tar.gz';
  if (!bundle || bundle.name !== expectedName) {
    throw updateError('update_bundle_name_invalid', 'Update bundle name does not match the release version.');
  }
  if (!Number.isSafeInteger(bundle.size) || bundle.size <= 0 || bundle.size > 32 * 1024 * 1024) {
    throw updateError('update_bundle_size_invalid', 'Update bundle size is outside the supported limit.');
  }
  if (!/^[0-9a-f]{64}$/.test(String(bundle.sha256 || ''))) {
    throw updateError('update_bundle_hash_invalid', 'Update bundle hash is invalid.');
  }
  if (!Array.isArray(manifest.artifacts)) {
    throw updateError('update_manifest_artifacts_invalid', 'Update manifest artifacts must be an array.');
  }
  return manifest;
}

function parseSemver(value) {
  const match = String(value || '').match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!match) {
    return null;
  }
  return match.slice(1).map(Number);
}

function compareSemver(left, right) {
  const a = Array.isArray(left) ? left : parseSemver(left);
  const b = Array.isArray(right) ? right : parseSemver(right);
  if (!a || !b) {
    throw updateError('update_version_invalid', 'A stable semantic version was expected.');
  }
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] < b[index] ? -1 : 1;
    }
  }
  return 0;
}

function isNewerStableVersion(candidate, current) {
  return compareSemver(candidate, current) > 0;
}

function parseJsonObject(bytes, code) {
  let value;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (_error) {
    throw updateError(code, 'Signed update metadata is not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw updateError(code, 'Signed update metadata must be an object.');
  }
  return value;
}

function toBoundedBuffer(value, limit, code) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || '');
  if (!buffer.length || buffer.length > limit) {
    throw updateError(code, 'Signed update metadata exceeds its size limit.');
  }
  return buffer;
}

function updateError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

module.exports = {
  BOOTSTRAP_PROTOCOL,
  TRUSTED_UPDATE_KEYS,
  UPDATE_CHANNEL,
  UPDATE_MANIFEST_SCHEMA,
  UPDATE_REPOSITORY,
  compareSemver,
  isNewerStableVersion,
  parseSemver,
  updateError,
  validateReleaseManifest,
  verifySignedReleaseManifest
};
