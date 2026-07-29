(function initGovernanceRules(root, factory) {
  if (typeof module === 'object' && module.exports) {
    let projectFiles = null;
    try {
      projectFiles = require('./projectFiles');
    } catch (_error) {
      projectFiles = null;
    }
    module.exports = factory(projectFiles);
  } else {
    root.CodexOverleafModuleRegistry.define('GovernanceRules', ['ProjectFiles'], factory);
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function governanceRulesFactory(projectFiles) {
  'use strict';

  const WRITE_OPERATION_TYPES = new Set([
    'edit',
    'create',
    'delete',
    'rename',
    'move',
    'binary-create',
    'overwrite-binary'
  ]);

  function normalizeGovernanceRules(rules = {}) {
    return {
      readonlyPatterns: normalizePatternList(rules.readonlyPatterns),
      writablePatterns: normalizePatternList(rules.writablePatterns),
      sensitiveCheckEnabled: rules.sensitiveCheckEnabled !== false,
      sensitiveConfirmAllowed: rules.sensitiveConfirmAllowed === true
    };
  }

  function normalizePatternList(patterns) {
    if (!Array.isArray(patterns)) {
      return [];
    }

    const result = [];
    const seen = new Set();
    for (const pattern of patterns) {
      if (typeof pattern !== 'string') {
        continue;
      }
      const normalized = normalizeProjectPath(pattern);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      result.push(normalized);
    }
    return result;
  }

  function evaluateGovernedOperations(operations, rules = {}) {
    const normalizedRules = normalizeGovernanceRules(rules);
    const allowed = [];
    const blocked = [];

    for (const operation of Array.isArray(operations) ? operations : []) {
      const normalizedOperation = normalizeOperation(operation);
      if (!isWriteOperation(normalizedOperation.type)) {
        allowed.push(normalizedOperation);
        continue;
      }

      const invalidPath = getInvalidOperationProjectPath(normalizedOperation);
      if (invalidPath) {
        blocked.push({ operation: normalizedOperation, reason: 'invalid_project_path', path: invalidPath });
        continue;
      }

      const paths = getOperationPaths(normalizedOperation);
      const readonlyPath = paths.find(path => matchesAnyPattern(path, normalizedRules.readonlyPatterns));
      if (readonlyPath) {
        blocked.push({ operation: normalizedOperation, reason: 'readonly', path: readonlyPath });
        continue;
      }

      if (
        normalizedRules.writablePatterns.length > 0 &&
        paths.some(path => !matchesAnyPattern(path, normalizedRules.writablePatterns))
      ) {
        blocked.push({ operation: normalizedOperation, reason: 'writable_allowlist' });
        continue;
      }

      allowed.push(normalizedOperation);
    }

    return { allowed, blocked, rules: normalizedRules };
  }

  function normalizeOperation(operation = {}) {
    const result = Object.assign({}, operation);
    result.type = typeof operation.type === 'string' ? operation.type : '';
    result.path = normalizeSafeOperationPath(operation.path);
    if (operation.path !== undefined && String(operation.path || '').trim() && !result.path) {
      result.invalidProjectPath = true;
    }
    if (operation.destinationPath !== undefined) {
      result.destinationPath = normalizeSafeOperationPath(operation.destinationPath);
      if (String(operation.destinationPath || '').trim() && !result.destinationPath) {
        result.invalidProjectDestinationPath = true;
      }
    }
    if (operation.destPath !== undefined && !result.destinationPath) {
      result.destinationPath = normalizeSafeOperationPath(operation.destPath);
      if (String(operation.destPath || '').trim() && !result.destinationPath) {
        result.invalidProjectDestinationPath = true;
      }
    }
    if (operation.to !== undefined && !result.destinationPath) {
      result.destinationPath = normalizeSafeOperationPath(operation.to);
      if (String(operation.to || '').trim() && !result.destinationPath) {
        result.invalidProjectDestinationPath = true;
      }
    }
    return result;
  }

  function getInvalidOperationProjectPath(operation = {}) {
    if (operation.invalidProjectPath || !operation.path) {
      return 'operation path';
    }
    if ((operation.type === 'rename' || operation.type === 'move')
      && (operation.invalidProjectDestinationPath || !operation.destinationPath)) {
      return 'operation destination path';
    }
    return '';
  }

  function getOperationPaths(operation) {
    const paths = [];
    if (operation.path) {
      paths.push(operation.path);
    }
    if ((operation.type === 'rename' || operation.type === 'move') && operation.destinationPath) {
      paths.push(operation.destinationPath);
    }
    return paths;
  }

  function isWriteOperation(type) {
    return WRITE_OPERATION_TYPES.has(type);
  }

  function matchesAnyPattern(path, patterns) {
    return patterns.some(pattern => matchesGovernancePattern(path, pattern));
  }

  function matchesGovernancePattern(path, pattern) {
    const normalizedPath = normalizeProjectPath(path);
    const normalizedPattern = normalizeProjectPath(pattern);
    if (!normalizedPath || !normalizedPattern) {
      return false;
    }
    const regex = new RegExp('^' + globToRegex(normalizedPattern) + '$');
    return regex.test(normalizedPath);
  }

  function globToRegex(pattern) {
    let regex = '';
    for (let i = 0; i < pattern.length; i++) {
      const char = pattern[i];
      if (char === '*') {
        if (pattern[i + 1] === '*') {
          regex += '.*';
          i++;
        } else {
          regex += '[^/]*';
        }
        continue;
      }
      if (char === '?') {
        regex += '[^/]';
        continue;
      }
      regex += escapeRegex(char);
    }
    return regex;
  }

  function escapeRegex(value) {
    return String(value).replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }

  function normalizeProjectPath(path) {
    return String(path || '')
      .replace(/\s+/g, ' ')
      .replace(/\\/g, '/')
      .trim()
      .replace(/^\/+/, '')
      .replace(/\/+/g, '/');
  }

  function normalizeSafeOperationPath(path) {
    if (projectFiles && typeof projectFiles.normalizeSafeProjectPath === 'function') {
      return projectFiles.normalizeSafeProjectPath(path);
    }
    return normalizeSafeProjectPathFallback(path);
  }

  function normalizeSafeProjectPathFallback(value) {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) {
      return '';
    }
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith('/') || trimmed.includes('\\') || /^[A-Za-z]:/.test(trimmed)) {
      return '';
    }
    let decoded = trimmed;
    for (let index = 0; index < 3; index += 1) {
      if (/%(?:2f|5c)/i.test(decoded)) {
        return '';
      }
      let next;
      try {
        next = decodeURIComponent(decoded);
      } catch (_error) {
        return '';
      }
      if (next === decoded) {
        break;
      }
      decoded = next;
    }
    if (/[\u0000-\u001f\u007f]/.test(decoded)
      || decoded.startsWith('/')
      || decoded.includes('\\')
      || /^[A-Za-z]:/.test(decoded)) {
      return '';
    }
    const normalized = decoded.replace(/\/+/g, '/').trim();
    if (!normalized) {
      return '';
    }
    const segments = normalized.split('/');
    return segments.some(segment => !segment || segment === '.' || segment === '..')
      ? ''
      : normalized;
  }

  return {
    WRITE_OPERATION_TYPES,
    normalizeGovernanceRules,
    normalizeProjectPath,
    matchesGovernancePattern,
    evaluateGovernedOperations
  };
});
