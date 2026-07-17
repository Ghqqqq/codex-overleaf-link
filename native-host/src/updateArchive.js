'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { updateError } = require('./updateTrust');

const DEFAULT_LIMITS = Object.freeze({
  maxCompressedBytes: 32 * 1024 * 1024,
  maxDecompressedBytes: 96 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxFiles: 600
});

function extractVerifiedUpdateBundle(options = {}) {
  const archivePath = path.resolve(String(options.archivePath || ''));
  const destinationRoot = path.resolve(String(options.destinationRoot || ''));
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const stat = fs.statSync(archivePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > limits.maxCompressedBytes) {
    throw updateError('update_archive_compressed_limit', 'Compressed update bundle exceeds its size limit.');
  }
  assertFreshDestination(destinationRoot);

  let tar;
  try {
    tar = zlib.gunzipSync(fs.readFileSync(archivePath), {
      maxOutputLength: limits.maxDecompressedBytes
    });
  } catch (error) {
    throw updateError('update_archive_invalid', 'Update bundle could not be decompressed.', { cause: error });
  }

  const files = [];
  let entryCount = 0;
  let totalBytes = 0;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every(byte => byte === 0)) {
      break;
    }
    verifyTarChecksum(header);
    const entryPath = parseTarPath(header);
    const type = String.fromCharCode(header[156] || 48);
    const size = parseTarNumber(header.subarray(124, 136));
    if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxFileBytes) {
      throw updateError('update_archive_file_limit', 'Update bundle contains an oversized file.');
    }
    if (!isAllowedUpdatePath(entryPath)) {
      throw updateError('update_archive_path_forbidden', 'Update bundle contains a path outside the runtime allowlist.');
    }
    if (type !== '0' && type !== '\0' && type !== '5') {
      throw updateError('update_archive_type_forbidden', 'Update bundle contains a link or unsupported filesystem entry.');
    }
    if (type === '5' && size !== 0) {
      throw updateError('update_archive_invalid', 'Update bundle directory entry has content.');
    }
    const paddedSize = Math.ceil(size / 512) * 512;
    if (offset + paddedSize > tar.length) {
      throw updateError('update_archive_truncated', 'Update bundle is truncated.');
    }
    if (entryCount >= limits.maxFiles) {
      throw updateError('update_archive_file_count_limit', 'Update bundle contains too many files.');
    }
    entryCount += 1;

    const target = safeArchiveTarget(destinationRoot, entryPath);
    if (type === '5') {
      fs.mkdirSync(target, { recursive: true, mode: 0o755 });
    } else {
      if (files.includes(entryPath)) {
        throw updateError('update_archive_duplicate_path', 'Update bundle contains a duplicate file path.');
      }
      totalBytes += size;
      if (totalBytes > limits.maxDecompressedBytes) {
        throw updateError('update_archive_total_limit', 'Update bundle content exceeds its total size limit.');
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, tar.subarray(offset, offset + size), { mode: parseSafeMode(header) });
      files.push(entryPath);
    }
    offset += paddedSize;
  }

  for (const required of ['extension-runtime/runtime-manifest.json', 'native-runtime/package.json', 'native-runtime/native-host/src/index.js']) {
    if (!files.includes(required)) {
      throw updateError('update_archive_required_file_missing', 'Update bundle is missing ' + required + '.');
    }
  }
  return { files: files.sort(), totalBytes };
}

function createUpdateBundleArchive(options = {}) {
  const outputPath = path.resolve(String(options.outputPath || ''));
  const entries = Array.isArray(options.entries) ? options.entries.slice() : [];
  const seen = new Set();
  const chunks = [];
  for (const entry of entries.sort((left, right) => left.archivePath.localeCompare(right.archivePath))) {
    const archivePath = normalizeArchivePath(entry.archivePath);
    if (!isAllowedUpdatePath(archivePath) || seen.has(archivePath)) {
      throw updateError('update_archive_path_forbidden', 'Invalid or duplicate update bundle path: ' + archivePath);
    }
    seen.add(archivePath);
    const content = fs.readFileSync(entry.sourcePath);
    const mode = Number(entry.mode || fs.statSync(entry.sourcePath).mode) & 0o777;
    chunks.push(createTarHeader(archivePath, content.length, mode || 0o644));
    chunks.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) {
      chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, zlib.gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 }));
  return { outputPath, files: [...seen].sort() };
}

function createTarHeader(entryPath, size, mode) {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitTarPath(entryPath);
  writeTarString(header, 0, 100, name);
  writeTarNumber(header, 100, 8, mode);
  writeTarNumber(header, 108, 8, 0);
  writeTarNumber(header, 116, 8, 0);
  writeTarNumber(header, 124, 12, size);
  writeTarNumber(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeTarString(header, 257, 6, 'ustar');
  writeTarString(header, 263, 2, '00');
  writeTarString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, '0') + '\0 ';
  header.write(checksumText, 148, 8, 'ascii');
  return header;
}

function verifyTarChecksum(header) {
  const expected = parseTarNumber(header.subarray(148, 156));
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  const actual = copy.reduce((sum, byte) => sum + byte, 0);
  if (expected !== actual) {
    throw updateError('update_archive_checksum_invalid', 'Update bundle tar header checksum is invalid.');
  }
}

function parseTarPath(header) {
  const name = parseTarString(header.subarray(0, 100));
  const prefix = parseTarString(header.subarray(345, 500));
  return normalizeArchivePath(prefix ? prefix + '/' + name : name);
}

function normalizeArchivePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw updateError('update_archive_path_forbidden', 'Update bundle contains an absolute or empty path.');
  }
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw updateError('update_archive_path_forbidden', 'Update bundle contains path traversal.');
  }
  return parts.join('/');
}

function isAllowedUpdatePath(value) {
  let entryPath;
  try {
    entryPath = normalizeArchivePath(value);
  } catch (_error) {
    return false;
  }
  return entryPath === 'extension-runtime/runtime-manifest.json'
    || /^extension-runtime\/src\/.+/.test(entryPath)
    || /^extension-runtime\/styles\/.+/.test(entryPath)
    || /^extension-runtime\/vendor\/katex\/(?:LICENSE|VERSION|katex\.min\.(?:css|js)|fonts\/[A-Za-z0-9_.-]+\.(?:ttf|woff2?))$/.test(entryPath)
    || entryPath === 'native-runtime/package.json'
    || /^native-runtime\/native-host\/src\/.+/.test(entryPath)
    || /^native-runtime\/extension\/src\/shared\/.+/.test(entryPath)
    || /^native-runtime\/scripts\/(?:codex-json-agent|install-native-host|uninstall-native-host)\.mjs$/.test(entryPath);
}

function safeArchiveTarget(root, entryPath) {
  const target = path.resolve(root, ...entryPath.split('/'));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw updateError('update_archive_path_forbidden', 'Update bundle path escapes the staging directory.');
  }
  return target;
}

function assertFreshDestination(root) {
  if (fs.existsSync(root)) {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.readdirSync(root).length) {
      throw updateError('update_staging_not_empty', 'Update staging directory must be a fresh empty directory.');
    }
    return;
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
}

function parseTarString(buffer) {
  const zero = buffer.indexOf(0);
  return buffer.subarray(0, zero === -1 ? buffer.length : zero).toString('utf8').trim();
}

function parseTarNumber(buffer) {
  const value = parseTarString(buffer).replace(/\s/g, '');
  return value ? Number.parseInt(value, 8) : 0;
}

function parseSafeMode(header) {
  const mode = parseTarNumber(header.subarray(100, 108)) & 0o777;
  return mode & 0o111 ? 0o755 : 0o644;
}

function writeTarString(buffer, offset, length, value) {
  const content = Buffer.from(String(value || ''), 'utf8');
  if (content.length > length) {
    throw updateError('update_archive_path_too_long', 'Update bundle path is too long for ustar.');
  }
  content.copy(buffer, offset);
}

function writeTarNumber(buffer, offset, length, value) {
  const text = Number(value).toString(8).padStart(length - 1, '0') + '\0';
  buffer.write(text, offset, length, 'ascii');
}

function splitTarPath(entryPath) {
  if (Buffer.byteLength(entryPath) <= 100) {
    return { name: entryPath, prefix: '' };
  }
  for (let index = entryPath.lastIndexOf('/'); index > 0; index = entryPath.lastIndexOf('/', index - 1)) {
    const prefix = entryPath.slice(0, index);
    const name = entryPath.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw updateError('update_archive_path_too_long', 'Update bundle path is too long for ustar.');
}

module.exports = {
  DEFAULT_LIMITS,
  createUpdateBundleArchive,
  extractVerifiedUpdateBundle,
  isAllowedUpdatePath,
  normalizeArchivePath
};
