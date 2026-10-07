'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Exact bytes from the published v2.5.0 Bootstrap. Unknown local modifications
// are never converted into a migration source simply because versions agree.
const BOOTSTRAP_MIGRATION_BASELINE = Object.freeze({
  "bootstrap/background.js": "5e15d208f07668f96cb94a84642d5fd9ad2dd921991bb3bd5bf67cc43037c87a",
  "bootstrap/popup.css": "0709a4b8aba5e59e95fd07afec4d29ba441bde46fae48863133a170ad12cbe58",
  "bootstrap/popup.html": "7cbcead701cb03a4006bbd682a744aeca30d613eb8315a194f2ba751b6fd9e55",
  "bootstrap/popup.js": "24f7171045ad7de9431d24e0e4a7d15237620f4217dd5e68772dbdf52b8ce4d8",
  "bootstrap/popupFallback.js": null,
  "bootstrap/runtimeContext.js": "ac04d9bb28308015ecfe296f152996521398dc0bb018416e34abe8424734a21b",
  "bootstrap/update.css": "43a0d4345f6f35a30c792a6fd67227776ec85ba710f89cae9c167b453de72342",
  "bootstrap/update.html": "7ce092eabcdf51564f994d8f72c474285f07777bd7a5a205eca8e5a0931964ab",
  "bootstrap/update.js": "ee67a23d89d435f05d3e4c1ec1f9c5a7f0bdcef4449e13be4d7acbbcf182413c",
  "bootstrap/updateStatus.js": "d2ad90e78c50367a5489bb6f5c27c7248112047aca9f05d2ad868ac3b5266b24"
});
const BOOTSTRAP_MIGRATION_FILES = Object.freeze(Object.keys(BOOTSTRAP_MIGRATION_BASELINE));
const BOOTSTRAP_MIGRATION_TARGET_VERSION = '2.5.1';
const BOOTSTRAP_MIGRATION_REVISION = '3.1';
const BOOTSTRAP_MIGRATION_IMPLEMENTATION_FILES = Object.freeze([
  'native-host/src/bootstrapMigrationContract.js',
  'native-host/src/bootstrapMigration.js',
  'native-host/src/bootstrapUpdate.js',
  'native-host/src/bootstrapUpdateWatchdog.js',
  'extension/src/backgroundBootstrapMigration.js'
]);
const BOOTSTRAP_MANIFEST_SHAPE_SHA256 = '85c2d3875196ff9b334b40bb115a42fe4b8cab4e9c37609fb65e8834284c8fbe';

function isBootstrapMigrationRelease(version) {
  return version === BOOTSTRAP_MIGRATION_TARGET_VERSION;
}

function buildBootstrapMigrationDescriptor({ packageRoot, version } = {}) {
  if (!isBootstrapMigrationRelease(version)) return null;
  assertBootstrapManifestShape(JSON.parse(fs.readFileSync(path.join(packageRoot,
    'extension/bootstrap/manifest.template.json'), 'utf8')), { version });
  const files = BOOTSTRAP_MIGRATION_FILES.map(relativePath => ({
    path: relativePath,
    sourceSha256: BOOTSTRAP_MIGRATION_BASELINE[relativePath],
    targetSha256: sha256(fs.readFileSync(path.join(packageRoot, 'extension', relativePath)))
  }));
  return validateBootstrapMigrationDescriptor({
    schemaVersion: 1,
    id: 'bootstrap-v3.1-from-2.5.0',
    bootstrapProtocol: 3,
    sourceVersions: ['2.5.0'],
    targetVersion: version,
    targetRevision: BOOTSTRAP_MIGRATION_REVISION,
    files
  }, { targetVersion: version });
}

function validateBootstrapMigrationDescriptor(descriptor, { targetVersion } = {}) {
  if (!descriptor || descriptor.schemaVersion !== 1 || descriptor.id !== 'bootstrap-v3.1-from-2.5.0'
    || descriptor.bootstrapProtocol !== 3 || descriptor.targetRevision !== BOOTSTRAP_MIGRATION_REVISION
    || descriptor.targetVersion !== BOOTSTRAP_MIGRATION_TARGET_VERSION
    || (targetVersion && descriptor.targetVersion !== targetVersion)
    || JSON.stringify(descriptor.sourceVersions) !== JSON.stringify(['2.5.0'])
    || !Array.isArray(descriptor.files) || descriptor.files.length !== BOOTSTRAP_MIGRATION_FILES.length) {
    throw new Error('Unsupported Bootstrap migration descriptor.');
  }
  const seen = new Set();
  for (const file of descriptor.files) {
    if (!file || !Object.hasOwn(BOOTSTRAP_MIGRATION_BASELINE, file.path) || seen.has(file.path)
      || file.sourceSha256 !== BOOTSTRAP_MIGRATION_BASELINE[file.path]
      || !/^[0-9a-f]{64}$/.test(file.targetSha256 || '')) {
      throw new Error('Bootstrap migration file identity is invalid.');
    }
    seen.add(file.path);
  }
  return descriptor;
}

function assertBootstrapManifestShape(manifest, { version } = {}) {
  if (!manifest || (version && manifest.version !== version)
    || sha256(Buffer.from(stableJson({ ...manifest, version: '<release-version>' }))) !== BOOTSTRAP_MANIFEST_SHAPE_SHA256) {
    throw new Error('Bootstrap migration cannot change the extension manifest shape or permissions.');
  }
  return manifest;
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

module.exports = {
  BOOTSTRAP_MIGRATION_BASELINE, BOOTSTRAP_MIGRATION_FILES, BOOTSTRAP_MIGRATION_TARGET_VERSION,
  BOOTSTRAP_MIGRATION_REVISION, isBootstrapMigrationRelease, buildBootstrapMigrationDescriptor,
  BOOTSTRAP_MIGRATION_IMPLEMENTATION_FILES, validateBootstrapMigrationDescriptor, assertBootstrapManifestShape
};
