'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseSemver, updateError } = require('./updateTrust');

function readManagedRuntimeEvidence(context, version, runtimeRoot = path.join(context.extensionRoot, 'runtime')) {
  try {
    if (!parseSemver(version)) throw new Error('Invalid source version');
    const compatibility = fs.readFileSync(path.join(runtimeRoot, 'src/shared/compatibility.js'), 'utf8');
    const declared = compatibility.match(/BUILD_TARGET_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1];
    if (declared !== version) throw new Error('Extension source version mismatch');
    const manifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'runtime-manifest.json'), 'utf8'));
    const assets = [...(Array.isArray(manifest.js) ? manifest.js : []), ...(Array.isArray(manifest.css) ? manifest.css : [])];
    if (!assets.length) throw new Error('Missing runtime assets');
    for (const asset of assets) {
      if (typeof asset !== 'string' || asset.startsWith('/') || asset.includes('\\')
        || asset.split('/').some(part => !part || part === '.' || part === '..')
        || !fs.statSync(path.join(runtimeRoot, asset)).isFile()) throw new Error('Invalid runtime asset');
    }
    const nativeRoot = path.join(context.nativeRoot, 'versions', version);
    if (JSON.parse(fs.readFileSync(path.join(nativeRoot, 'package.json'), 'utf8')).version !== version
      || !fs.statSync(path.join(nativeRoot, 'native-host/src/index.js')).isFile()) throw new Error('Native source unavailable');
    return { extensionVersion: declared, nativeVersion: version,
      extensionSha256: hashTree(runtimeRoot), nativeSha256: hashTree(nativeRoot) };
  } catch (cause) {
    throw updateError('update_rollback_source_unavailable',
      'The source runtime files could not be verified. Run install-managed to restore the matched installation.', { cause });
  }
}

function hashTree(root) {
  const hash = crypto.createHash('sha256');
  function visit(directory, prefix) {
    // Native processes can start under different LANG/ICU defaults. Evidence
    // ordering must be a fixed code-unit order, never locale collation.
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const filename = path.join(directory, entry.name), relative = prefix + entry.name;
      if (entry.isDirectory()) visit(filename, relative + '/');
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(filename);
        hash.update(JSON.stringify([relative, bytes.length])); hash.update(bytes);
      } else throw new Error('Runtime entry is not a regular file or directory');
    }
  }
  visit(root, '');
  return hash.digest('hex');
}

function sameRuntimeEvidence(left, right) {
  return Boolean(left && right && ['extensionVersion', 'nativeVersion', 'extensionSha256', 'nativeSha256']
    .every(key => left[key] && left[key] === right[key]));
}

module.exports = { readManagedRuntimeEvidence, sameRuntimeEvidence };
