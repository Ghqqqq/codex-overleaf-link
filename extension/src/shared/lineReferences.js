(function initLineReferences(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafLineReferences = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function lineReferencesFactory() {
  'use strict';

  const VALID_PARSE_MODES = new Set([
    'plain-text-token',
    'markdown-link-label',
    'markdown-link-target'
  ]);
  const TEXT_EXTENSION_PATTERN = '(?:tex|bib|sty|cls|bst|bbx|cbx|lbx|cfg|def|clo|ist|txt|md|latex)';
  const CJK_PUNCTUATION = '、，；。！？：';
  const REFERENCE_PREFIX_PATTERN = `(^|[\\s\\[({\"',;${CJK_PUNCTUATION}])`;
  const PATH_PATTERN = `([^\\s\\[\\](){}<>"'\`,;${CJK_PUNCTUATION}]+?\\.${TEXT_EXTENSION_PATTERN})`;
  // Unix top-level set kept in sync with the canonical pathRedaction.js
  // UNIX_TOPLEVELS list; widening only ever redacts more, never changes
  // non-path text.
  const BARE_LOCAL_PATH_PATTERN = /(?:file:\/\/\/?[^\s)\]]+|[A-Za-z]:[\\/][^\s)\]]+|\/(?:Users|home|root|private|var|tmp|Volumes|etc|opt|usr|srv|mnt|media)\/[^\s)\]]+|[^\s)\]]*[\\/]\.codex-overleaf[\\/]projects[\\/][^\s)\]]+)/gi;

  function parseLineReferencesFromText({ text, mode }) {
    return collectLineReferences(text, mode).map(toPublicReference);
  }

  function resolveProjectReference({ rawPath, projectFiles }) {
    const normalizedRawPath = normalizeReferencePath(rawPath);
    if (!normalizedRawPath || hasUnsafePathSegments(normalizedRawPath)) {
      return null;
    }

    const textFiles = collectTextProjectFiles(projectFiles);
    const exactMatch = textFiles.find(file => file.normalizedPath === normalizedRawPath);
    if (exactMatch) {
      return buildResolvedReference(exactMatch, 'exact');
    }

    const suffixMatches = textFiles.filter(file => normalizedRawPath.endsWith(`/${file.normalizedPath}`));
    if (suffixMatches.length === 1) {
      return buildResolvedReference(suffixMatches[0], 'suffix');
    }

    const rawBasename = getBasename(normalizedRawPath);
    const basenameMatches = textFiles.filter(file => getBasename(file.normalizedPath) === rawBasename);
    if (basenameMatches.length === 1) {
      return buildResolvedReference(basenameMatches[0], 'basename');
    }

    return null;
  }

  function sanitizeLocalReferences(text, { projectFiles, context } = {}) {
    if (typeof text !== 'string' || !text) {
      return '';
    }

    let sanitized = replaceMarkdownLinks(text, (_rawMarkdown, label, target) => {
      const sanitizedLabel = sanitizeLocalReferenceText(label, {
        projectFiles,
        placeholderBrackets: false
      });
      const trimmedTarget = String(target || '').trim();
      if (/^https?:\/\//i.test(trimmedTarget)) {
        return `[${sanitizedLabel}](${target})`;
      }
      if (containsLocalTarget(trimmedTarget)) {
        return `[${sanitizedLabel}]`;
      }
      const sanitizedTarget = sanitizeLocalReferenceText(target, {
        projectFiles,
        placeholderBrackets: false
      });
      return `[${sanitizedLabel}](${sanitizedTarget})`;
    });

    sanitized = sanitizeLocalReferenceText(sanitized, {
      projectFiles,
      placeholderBrackets: true
    });

    return sanitized;
  }

  function replaceMarkdownLinks(text, replacer) {
    const source = String(text || '');
    let output = '';
    let cursor = 0;

    for (let index = 0; index < source.length; index += 1) {
      if (source[index] !== '[') {
        continue;
      }
      const closeLabel = source.indexOf(']', index + 1);
      if (closeLabel === -1 || source[closeLabel + 1] !== '(') {
        continue;
      }
      const targetStart = closeLabel + 2;
      const targetEnd = findMarkdownTargetEnd(source, targetStart);
      if (targetEnd === -1) {
        continue;
      }
      output += source.slice(cursor, index);
      output += replacer(
        source.slice(index, targetEnd + 1),
        source.slice(index + 1, closeLabel),
        unescapeMarkdownTarget(source.slice(targetStart, targetEnd))
      );
      cursor = targetEnd + 1;
      index = targetEnd;
    }

    return output + source.slice(cursor);
  }

  function findMarkdownTargetEnd(text, start) {
    let depth = 0;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === '(') {
        depth += 1;
        continue;
      }
      if (char === ')') {
        if (depth === 0) {
          return index;
        }
        depth -= 1;
      }
    }
    return -1;
  }

  function unescapeMarkdownTarget(value) {
    return String(value || '').replace(/\\([()\\])/g, '$1');
  }

  function isLocalPathLike(value) {
    if (typeof value !== 'string') {
      return false;
    }

    const rawValue = value.trim();
    if (!rawValue || /^https?:\/\//i.test(rawValue)) {
      return false;
    }

    const normalizedPath = normalizeReferencePath(rawValue);
    return /^file:\/\//i.test(rawValue)
      || /^[A-Za-z]:[\\/]/.test(rawValue)
      || rawValue.startsWith('/')
      || rawValue.includes('.codex-overleaf/projects')
      || rawValue.includes('.codex-overleaf\\projects')
      || normalizedPath.includes('/.codex-overleaf/projects/')
      || /^Users\/[^/]+\//.test(normalizedPath)
      || /^home\/[^/]+\//.test(normalizedPath);
  }

  function normalizeReferencePath(value) {
    if (typeof value !== 'string') {
      return '';
    }

    let normalized = value.trim();
    if (!normalized) {
      return '';
    }

    normalized = stripReferenceQueryAndHash(normalized);

    if (/^file:\/\//i.test(normalized)) {
      normalized = normalized.replace(/^file:\/\/\/?/i, '/');
    }

    try {
      normalized = decodeURI(normalized);
    } catch (_error) {
      return '';
    }

    normalized = normalized
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .trim();

    let previous;
    do {
      previous = normalized;
      normalized = normalized
        .replace(/^@+/, '')
        .replace(/^\/+/, '')
        .replace(/^\.\//, '');
    } while (normalized !== previous);

    return normalized;
  }

  function collectLineReferences(text, mode) {
    if (!VALID_PARSE_MODES.has(mode) || typeof text !== 'string' || !text) {
      return [];
    }

    const refs = [];
    if (mode === 'markdown-link-target') {
      collectMarkdownTargetReferences(text, mode, refs);
    }
    collectColonReferences(text, mode, refs);
    collectLineWordReferences(text, mode, refs);
    collectChineseLineReferences(text, mode, refs);

    return refs
      .filter(ref => !shouldSkipReference(ref))
      .sort((left, right) => left.index - right.index || right.rawText.length - left.rawText.length)
      .reduce((deduped, ref) => {
        if (deduped.some(existing => rangesOverlap(existing, ref))) {
          return deduped;
        }
        deduped.push(ref);
        return deduped;
      }, []);
  }

  function collectMarkdownTargetReferences(text, mode, refs) {
    const normalizedText = stripReferenceQueryAndHash(String(text || '').trim());
    const match = normalizedText.match(new RegExp(`^(.+?\\.${TEXT_EXTENSION_PATTERN}):(\\d+)(?:[-–](\\d+)|:(\\d+))?$`, 'i'));
    if (!match) {
      return;
    }
    const span = parseLineSpan(match[2], match[3]);
    const column = match[4] ? parsePositiveInteger(match[4]) : null;
    if (!span || (match[4] && !column)) {
      return;
    }
    refs.push({
      rawText: text,
      displayText: text,
      rawPath: match[1],
      ...span,
      column,
      source: mode,
      index: 0
    });
  }

  function collectColonReferences(text, mode, refs) {
    // Range/column suffixes are mutually exclusive; malformed spans must not
    // backtrack into a shorter reference, including decimal/exponent endpoints.
    const pattern = new RegExp(`${REFERENCE_PREFIX_PATTERN}${PATH_PATTERN}:(\\d+)(?:[-–](\\d+)(?!\\.\\d|e[+-]?\\d)|:(\\d+))?(?![-–:\\d]|(?:\\.\\d+)?(?:e[+-]?\\d+)?[-–])`, 'gi');
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const span = parseLineSpan(match[3], match[4]);
      const column = match[5] ? parsePositiveInteger(match[5]) : null;
      if (!span || (match[5] && !column)) {
        continue;
      }
      const prefixLength = match[1].length;
      const rawText = match[0].slice(prefixLength);
      refs.push({
        rawText,
        displayText: rawText,
        rawPath: match[2],
        ...span,
        column,
        source: mode,
        index: match.index + prefixLength
      });
    }
  }

  function collectLineWordReferences(text, mode, refs) {
    const pattern = new RegExp(`${REFERENCE_PREFIX_PATTERN}${PATH_PATTERN}\\s+line(?:s(?=\\s+\\d+[-–]))?\\s+(\\d+)(?:[-–](\\d+)(?!\\.\\d|e[+-]?\\d))?(?![-–:\\d]|(?:\\.\\d+)?(?:e[+-]?\\d+)?[-–])`, 'gi');
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const span = parseLineSpan(match[3], match[4]);
      if (!span) {
        continue;
      }
      const prefixLength = match[1].length;
      const rawText = match[0].slice(prefixLength);
      refs.push({
        rawText,
        displayText: `${match[2]}:${span.line}${span.endLine ? `–${span.endLine}` : ''}`,
        rawPath: match[2],
        ...span,
        column: null,
        source: mode,
        index: match.index + prefixLength
      });
    }
  }

  function collectChineseLineReferences(text, mode, refs) {
    const pattern = new RegExp(`${REFERENCE_PREFIX_PATTERN}${PATH_PATTERN}\\s+第\\s*(\\d+)(?:\\s*[-–至]\\s*(\\d+))?\\s*行`, 'gi');
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const span = parseLineSpan(match[3], match[4]);
      if (!span) {
        continue;
      }
      const prefixLength = match[1].length;
      const rawText = match[0].slice(prefixLength);
      refs.push({
        rawText,
        displayText: `${match[2]}:${span.line}${span.endLine ? `–${span.endLine}` : ''}`,
        rawPath: match[2],
        ...span,
        column: null,
        source: mode,
        index: match.index + prefixLength
      });
    }
  }

  function sanitizeLocalReferenceText(text, { projectFiles, placeholderBrackets }) {
    let sanitized = replaceLineReferences(String(text || ''), {
      projectFiles,
      placeholderBrackets
    });
    sanitized = replaceBareLocalPaths(sanitized, {
      projectFiles,
      placeholderBrackets
    });
    return sanitized;
  }

  function replaceLineReferences(text, { projectFiles, placeholderBrackets }) {
    const refs = collectLineReferences(text, 'plain-text-token')
      .filter(ref => isLocalPathLike(ref.rawPath))
      .sort((left, right) => right.index - left.index);
    let sanitized = text;
    for (const ref of refs) {
      const replacement = formatReferenceReplacement(ref, {
        projectFiles,
        placeholderBrackets
      });
      sanitized = `${sanitized.slice(0, ref.index)}${replacement}${sanitized.slice(ref.index + ref.rawText.length)}`;
    }
    return sanitized;
  }

  function replaceBareLocalPaths(text, { projectFiles, placeholderBrackets }) {
    return text.replace(BARE_LOCAL_PATH_PATTERN, (rawPath, offset, fullText) => {
      if (/^[A-Za-z]:[\\/]/.test(rawPath) && offset > 0 && /[A-Za-z]/.test(fullText[offset - 1])) {
        return rawPath;
      }
      const { value, trailing } = splitTrailingPunctuation(rawPath);
      const resolved = resolveProjectReference({ rawPath: value, projectFiles });
      if (resolved) {
        return `${resolved.path}${trailing}`;
      }
      return `${formatLocalPathPlaceholder(null, placeholderBrackets)}${trailing}`;
    });
  }

  function formatReferenceReplacement(ref, { projectFiles, placeholderBrackets }) {
    const resolved = resolveProjectReference({
      rawPath: ref.rawPath,
      projectFiles
    });
    if (resolved) {
      return `${resolved.path}:${ref.line}${ref.endLine ? `-${ref.endLine}` : ref.column ? `:${ref.column}` : ''}`;
    }
    return formatLocalPathPlaceholder(ref.line, placeholderBrackets, ref.endLine);
  }

  function formatLocalPathPlaceholder(line, includeBrackets, endLine) {
    const value = line ? `local path:${line}${endLine ? `-${endLine}` : ''}` : 'local path';
    return includeBrackets ? `[${value}]` : value;
  }

  function containsLocalTarget(target) {
    if (!target) {
      return false;
    }
    if (isLocalPathLike(target)) {
      return true;
    }
    return collectLineReferences(target, 'markdown-link-target')
      .some(ref => isLocalPathLike(ref.rawPath));
  }

  function stripReferenceQueryAndHash(value) {
    return String(value || '').replace(/([:.]\d+(?:[-–]\d+|:\d+)?)(?:[?#].*)$/, '$1');
  }

  function collectTextProjectFiles(projectFiles) {
    if (!Array.isArray(projectFiles)) {
      return [];
    }

    const result = [];
    for (const file of projectFiles) {
      if (!file || file.kind !== 'text' || typeof file.path !== 'string') {
        continue;
      }

      const normalizedPath = normalizeReferencePath(file.path);
      if (!normalizedPath || hasUnsafePathSegments(normalizedPath)) {
        continue;
      }

      result.push({
        entry: file,
        path: normalizedPath,
        normalizedPath
      });
    }
    return result;
  }

  function buildResolvedReference(file, resolution) {
    return {
      path: file.path,
      file: file.entry,
      normalizedPath: file.normalizedPath,
      resolution
    };
  }

  function shouldSkipReference(ref) {
    const rawPath = String(ref.rawPath || '');
    return /^https?:\/\//i.test(rawPath)
      || isEmailLikePath(rawPath);
  }

  function isEmailLikePath(rawPath) {
    return /^[^@\s/\\]+@[^@\s/\\]+$/.test(rawPath);
  }

  function hasUnsafePathSegments(path) {
    return normalizeReferencePath(path)
      .split('/')
      .some(segment => segment === '.' || segment === '..');
  }

  function rangesOverlap(left, right) {
    const leftEnd = left.index + left.rawText.length;
    const rightEnd = right.index + right.rawText.length;
    return left.index < rightEnd && right.index < leftEnd;
  }

  function parsePositiveInteger(value) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      return null;
    }
    return parsed;
  }

  function parseLineSpan(rawLine, rawEndLine) {
    const line = parsePositiveInteger(rawLine);
    const endLine = rawEndLine === undefined ? null : parsePositiveInteger(rawEndLine);
    if (!line || (rawEndLine !== undefined && (!endLine || endLine < line))) {
      return null;
    }
    return { line, ...(endLine > line ? { endLine } : {}) };
  }

  function getBasename(path) {
    const parts = String(path || '').split('/');
    return parts[parts.length - 1] || '';
  }

  function splitTrailingPunctuation(value) {
    const match = String(value || '').match(/^(.*?)([.,;!?、，；。！？：]+)$/);
    if (!match) {
      return { value, trailing: '' };
    }
    return {
      value: match[1],
      trailing: match[2]
    };
  }

  function toPublicReference(ref) {
    return {
      rawText: ref.rawText,
      displayText: ref.displayText,
      rawPath: ref.rawPath,
      line: ref.line,
      ...(ref.endLine ? { endLine: ref.endLine } : {}),
      column: ref.column,
      source: ref.source
    };
  }

  return {
    isLocalPathLike,
    normalizeReferencePath,
    parseLineReferencesFromText,
    resolveProjectReference,
    sanitizeLocalReferences
  };
});
