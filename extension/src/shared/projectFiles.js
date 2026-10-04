(function initProjectFiles(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafProjectFiles = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function projectFilesFactory() {
  'use strict';

  const TEXT_EXTENSIONS = new Set([
    '.tex',
    '.bib',
    '.sty',
    '.cls',
    '.bst',
    '.bbx',
    '.cbx',
    '.lbx',
    '.cfg',
    '.def',
    '.clo',
    '.ist',
    '.txt',
    '.md',
    '.latex'
  ]);

  const BINARY_EXTENSIONS = new Set([
    '.pdf',
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.svg',
    '.eps',
    '.zip',
    '.gz',
    '.tar',
    '.doc',
    '.docx',
    '.ppt',
    '.pptx',
    '.xls',
    '.xlsx'
  ]);
  const MAX_SAFE_PROJECT_PATH_LENGTH = 2048;

  function isTextProjectPath(path) {
    const normalized = normalizeSafeProjectPath(path);
    if (!normalized) {
      return false;
    }

    const extension = getExtension(normalized);
    if (BINARY_EXTENSIONS.has(extension)) {
      return false;
    }
    return TEXT_EXTENSIONS.has(extension);
  }

  function collectUniqueTextPaths(paths, limit = 80) {
    const seen = new Set();
    const result = [];
    for (const path of paths || []) {
      const normalized = normalizeSafeProjectPath(path);
      if (!isTextProjectPath(normalized) || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      result.push(normalized);
      if (result.length >= limit) {
        break;
      }
    }
    return result;
  }

  function normalizePath(path) {
    return String(path || '')
      .replace(/\s+/g, ' ')
      .replace(/\\/g, '/')
      .trim()
      .replace(/^\/+/, '');
  }

  // Project metadata, ZIP names and operation paths are already literal names.
  // Decoding here would alias e.g. "a%20b.tex" with "a b.tex".
  function normalizeSafeProjectPath(value) {
    if (typeof value !== 'string' || !value || value.length > MAX_SAFE_PROJECT_PATH_LENGTH || value.trim() !== value
      || hasControlCharacter(value) || value.startsWith('/') || value.includes('\\')
      || hasWindowsDrivePrefix(value)) return '';
    return value.split('/').some(segment => !segment || segment === '.' || segment === '..') ? '' : value;
  }

  // Use only at an explicitly URL-encoded input boundary. Return one decoding,
  // while conservatively checking nested encodings for traversal/separators.
  function normalizeUrlEncodedProjectPath(value) {
    if (typeof value !== 'string' || hasEncodedSeparator(value)) return '';
    let decoded;
    try { decoded = decodeURIComponent(value); } catch (_error) { return ''; }
    const result = normalizeSafeProjectPath(decoded);
    if (!result) return '';
    for (let index = 0; index < 3; index += 1) {
      if (hasEncodedSeparator(decoded) || !normalizeSafeProjectPath(decoded)) return '';
      let next;
      try { next = decodeURIComponent(decoded); } catch (_error) { break; }
      if (next === decoded) break;
      decoded = next;
    }
    return hasEncodedSeparator(decoded) || !normalizeSafeProjectPath(decoded) ? '' : result;
  }

  function assertSafeProjectPath(value, label = 'path') {
    const normalized = normalizeSafeProjectPath(value);
    if (!normalized) {
      throw new Error(`Invalid ${label}`);
    }
    return normalized;
  }

  function hasControlCharacter(value) {
    return /[\u0000-\u001f\u007f]/.test(String(value || ''));
  }

  function hasEncodedSeparator(value) {
    return /%(?:2f|5c)/i.test(String(value || ''));
  }

  function hasWindowsDrivePrefix(value) {
    return /^[A-Za-z]:/.test(String(value || ''));
  }

  function getExtension(path) {
    const fileName = path.split('/').pop() || '';
    const dotIndex = fileName.lastIndexOf('.');
    return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : '';
  }

  function isUsableProjectFileContent(content) {
    const text = String(content || '').trim();
    if (!text) {
      return false;
    }
    return !/^(loading|loading\.{3}|loading…)$/i.test(text);
  }

  return {
    MAX_SAFE_PROJECT_PATH_LENGTH,
    assertSafeProjectPath,
    collectUniqueTextPaths,
    isUsableProjectFileContent,
    isTextProjectPath,
    normalizePath,
    normalizeSafeProjectPath,
    normalizeUrlEncodedProjectPath
  };
});
