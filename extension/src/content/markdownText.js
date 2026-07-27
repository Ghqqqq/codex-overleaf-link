(function initCodexOverleafMarkdownText() {
  'use strict';

  const LineReferences = window.CodexOverleafLineReferences;

  // Markdown / assistant-text rendering — block + inline markdown, the
  // assistant-visible sanitizers, and line-reference resolution/buttons carved
  // out of contentRuntime.js (v1.4.5 structural-debt phase 1). The code below
  // moved verbatim (original indentation kept); the four runtime collaborators
  // are factory-injected so behavior is unchanged.
  function create(deps = {}) {
    const {
      tx,
      callPageBridge, getCurrentProjectId,
      getCurrentProjectReferenceFiles,
      showPluginToast
    } = deps;

  function renderMarkdownInlineText(target, value) {
    target.replaceChildren(...buildMarkdownInlineNodes(value));
  }

  function sanitizeAssistantVisibleText(value) {
    if (typeof value !== 'string' || !value) {
      return '';
    }
    if (LineReferences?.sanitizeLocalReferences) {
      try {
        return LineReferences.sanitizeLocalReferences(value, {
          projectFiles: getCurrentProjectReferenceFiles(),
          context: 'render'
        });
      } catch (_error) {
        return fallbackSanitizeLocalReferences(value);
      }
    }
    return fallbackSanitizeLocalReferences(value);
  }

  function sanitizeAssistantVisibleValue(value, depth = 0) {
    if (typeof value === 'string') {
      return sanitizeAssistantVisibleText(value);
    }
    if (value === undefined || value === null || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (depth > 12) {
      return '[redacted nested value]';
    }
    if (Array.isArray(value)) {
      return value.map(item => sanitizeAssistantVisibleValue(item, depth + 1));
    }
    if (typeof value === 'object') {
      const result = {};
      for (const key of Object.keys(value)) {
        const safeKey = sanitizeAssistantVisibleText(key) || key;
        result[safeKey] = sanitizeAssistantVisibleValue(value[key], depth + 1);
      }
      return result;
    }
    return value;
  }

  function buildMarkdownInlineNodes(value) {
    const source = String(value || '');
    const mathText = typeof window !== 'undefined'
      ? window.CodexOverleafMathText
      : null;
    if (!mathText?.buildMathNodes) {
      return buildMarkdownInlineNodesWithoutMath(source);
    }
    return mathText.buildMathNodes(source, {
      document,
      katex: window.katex,
      renderText: buildMarkdownInlineNodesWithoutMath
    });
  }

  function buildMarkdownInlineNodesWithoutMath(value) {
    const source = String(value || '');
    const nodes = [];
    let index = 0;

    while (index < source.length) {
      const next = findNextInlineMarkdown(source, index);
      if (!next) {
        nodes.push(...buildLineReferenceInlineNodes(source.slice(index)));
        break;
      }

      if (next.start > index) {
        nodes.push(...buildLineReferenceInlineNodes(source.slice(index, next.start)));
      }

      if (next.type === 'strong') {
        const strong = document.createElement('strong');
        strong.append(...buildMarkdownInlineNodes(next.text));
        nodes.push(strong);
      } else if (next.type === 'code') {
        nodes.push(...buildInlineCodeNodes(next.text));
      } else if (next.type === 'link') {
        nodes.push(...buildMarkdownLinkNodes(next.text, next.href));
      }

      index = next.end;
    }

    return nodes;
  }

  function buildInlineCodeNodes(value) {
    const source = String(value || '');
    const trimmed = source.trim();
    const refs = trimmed ? parseRuntimeLineReferences(trimmed, 'plain-text-token') : [];
    const ref = refs.length === 1 && refs[0]?.rawText === trimmed ? refs[0] : null;
    if (ref && !isRuntimeLocalPathLike(ref.rawPath)) {
      const resolved = resolveRuntimeLineReference(ref);
      if (resolved) {
        return [createLineReferenceButton(resolved)];
      }
    }
    const code = document.createElement('code');
    code.textContent = sanitizeAssistantVisibleText(source);
    return [code];
  }

  function buildLineReferenceInlineNodes(value) {
    const source = String(value || '');
    if (!source) {
      return [];
    }
    const refs = parseRuntimeLineReferences(source, 'plain-text-token');
    if (!refs.length) {
      return [document.createTextNode(sanitizeAssistantVisibleText(source))];
    }
    const nodes = [];
    let cursor = 0;
    for (const ref of refs) {
      const rawText = String(ref.rawText || '');
      if (!rawText) {
        continue;
      }
      const start = source.indexOf(rawText, cursor);
      if (start < cursor) {
        continue;
      }
      appendSanitizedTextNode(nodes, source.slice(cursor, start));
      const resolved = resolveRuntimeLineReference(ref);
      if (resolved) {
        nodes.push(createLineReferenceButton(resolved));
      } else {
        appendSanitizedTextNode(nodes, rawText);
      }
      cursor = start + rawText.length;
    }
    appendSanitizedTextNode(nodes, source.slice(cursor));
    return nodes;
  }

  function buildMarkdownLinkNodes(text, href) {
    const target = String(href || '').trim();
    if (isHttpMarkdownHref(target)) {
      const link = document.createElement('a');
      link.href = formatMarkdownHref(target);
      link.textContent = formatHttpMarkdownLinkLabel(text);
      link.title = link.href;
      link.target = '_blank';
      link.rel = 'noreferrer';
      return [link];
    }

    const resolved = resolveMarkdownLineReference(text, target);
    if (resolved) {
      return [createLineReferenceButton(resolved)];
    }

    return [document.createTextNode(sanitizeAssistantVisibleText(text))];
  }

  function formatHttpMarkdownLinkLabel(text) {
    const label = sanitizeAssistantVisibleText(text).trim();
    return label || 'link';
  }

  function appendSanitizedTextNode(nodes, value) {
    const text = sanitizeAssistantVisibleText(value);
    if (text) {
      nodes.push(document.createTextNode(text));
    }
  }

  function resolveMarkdownLineReference(text, href) {
    const candidates = [
      { value: href, mode: 'markdown-link-target' },
      { value: text, mode: 'markdown-link-label' }
    ];
    for (const candidate of candidates) {
      for (const ref of parseRuntimeLineReferences(candidate.value, candidate.mode)) {
        const resolved = resolveRuntimeLineReference(ref);
        if (resolved) {
          return resolved;
        }
      }
    }
    return null;
  }

  function isRuntimeLocalPathLike(value) {
    if (LineReferences?.isLocalPathLike) {
      try {
        return LineReferences.isLocalPathLike(value);
      } catch (_error) {
        return true;
      }
    }
    return fallbackLooksLikeLocalPath(value);
  }

  function parseRuntimeLineReferences(text, mode) {
    if (!LineReferences?.parseLineReferencesFromText) {
      return [];
    }
    try {
      return LineReferences.parseLineReferencesFromText({ text: String(text || ''), mode }) || [];
    } catch (_error) {
      return [];
    }
  }

  function resolveRuntimeLineReference(ref) {
    if (!LineReferences?.resolveProjectReference) {
      return null;
    }
    const line = Number(ref?.line);
    const column = ref?.column === null || ref?.column === undefined || ref?.column === ''
      ? null
      : Number(ref.column);
    if (!Number.isSafeInteger(line) || line < 1 || (column !== null && (!Number.isSafeInteger(column) || column < 1))) {
      return null;
    }
    let resolved;
    try {
      resolved = LineReferences.resolveProjectReference({
        rawPath: ref.rawPath,
        projectFiles: getCurrentProjectReferenceFiles()
      });
    } catch (_error) {
      return null;
    }
    if (!resolved?.path || resolved.file?.kind === 'binary') {
      return null;
    }
    return {
      path: resolved.path,
      line,
      column
    };
  }

  function createLineReferenceButton(reference) {
    const button = document.createElement('button');
    button.className = 'codex-line-reference';
    button.type = 'button';
    button.textContent = formatLineReferenceText(reference);
    button.dataset.path = reference.path;
    button.dataset.line = String(reference.line);
    if (reference.column) {
      button.dataset.column = String(reference.column);
    }
    const ariaLabel = reference.column
      ? `Open ${reference.path} line ${reference.line} column ${reference.column}`
      : `Open ${reference.path} line ${reference.line}`;
    button.setAttribute('aria-label', ariaLabel);
    button.title = ariaLabel;
    button.addEventListener('click', async event => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      const params = {
        path: reference.path,
        line: reference.line,
        selectLine: !reference.column
      };
      if (reference.column) {
        params.column = reference.column;
        params.selectLine = false;
      }
      button.disabled = true;
      button.dataset.status = 'pending';
      try {
        const result = await callPageBridge('jumpToPosition', { ...params, runProjectId: getCurrentProjectId?.() || '' });
        if (result?.ok === false) {
          button.dataset.status = 'failed';
          button.title = tx('Could not open that referenced line.', '无法打开引用的行。');
          showPluginToast?.(tx('Could not open that referenced line.', '无法打开引用的行。'), {
            status: 'warning'
          });
          return;
        }
        delete button.dataset.status;
        button.title = ariaLabel;
      } catch (_error) {
        button.dataset.status = 'failed';
        button.title = tx('Could not open that referenced line.', '无法打开引用的行。');
        showPluginToast?.(tx('Could not open that referenced line.', '无法打开引用的行。'), {
          status: 'warning'
        });
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }

  function formatLineReferenceText(reference) {
    return `${reference.path}:${reference.line}${reference.column ? `:${reference.column}` : ''}`;
  }

  function normalizeReferencePathForRuntime(value) {
    if (LineReferences?.normalizeReferencePath) {
      return LineReferences.normalizeReferencePath(value);
    }
    return String(value || '')
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^\/+/, '')
      .replace(/^\.\//, '')
      .trim();
  }

  function hasUnsafeRuntimePathSegments(path) {
    return normalizeReferencePathForRuntime(path)
      .split('/')
      .some(segment => segment === '.' || segment === '..');
  }

  function isHttpMarkdownHref(href) {
    try {
      const parsed = new URL(String(href || '').trim());
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (_error) {
      return false;
    }
  }

  function containsLocalPathText(value) {
    return /(?:file:\/\/\/?|[A-Za-z]:[\\/]|\/(?:Users|home|private|var|tmp)\/|[\\/]\.codex-overleaf[\\/]projects[\\/])/i.test(String(value || ''));
  }

  function fallbackSanitizeLocalReferences(value) {
    return String(value || '')
      .replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_raw, label, target) => {
        const safeLabel = fallbackSanitizeBareLocalPaths(label);
        return /^https?:\/\//i.test(String(target || '').trim())
          ? `[${safeLabel}](${target})`
          : `[${safeLabel}]`;
      })
      .replace(/(?:file:\/\/\/?[^\s)\]]+|[A-Za-z]:[\\/][^\s)\]]+|\/(?:Users|home|private|var|tmp)\/[^\s)\]]+|[^\s)\]]*[\\/]\.codex-overleaf[\\/]projects[\\/][^\s)\]]+)/gi, rawPath => {
        const line = String(rawPath || '').match(/:(\d+)(?::\d+)?(?:[.,;!?])?$/)?.[1];
        return line ? `[local path:${line}]` : '[local path]';
      });
  }

  function fallbackSanitizeBareLocalPaths(value) {
    return String(value || '').replace(/(?:file:\/\/\/?[^\s)\]]+|[A-Za-z]:[\\/][^\s)\]]+|\/(?:Users|home|private|var|tmp)\/[^\s)\]]+|[^\s)\]]*[\\/]\.codex-overleaf[\\/]projects[\\/][^\s)\]]+)/gi, rawPath => {
      const line = String(rawPath || '').match(/:(\d+)(?::\d+)?(?:[.,;!?])?$/)?.[1];
      return line ? `[local path:${line}]` : '[local path]';
    });
  }

  function findNextInlineMarkdown(source, index) {
    const candidates = [
      findStrongMarkdown(source, index),
      findCodeMarkdown(source, index),
      findLinkMarkdown(source, index)
    ].filter(Boolean);
    candidates.sort((left, right) => left.start - right.start);
    return candidates[0] || null;
  }

  function findStrongMarkdown(source, index) {
    const start = source.indexOf('**', index);
    if (start === -1) {
      return null;
    }
    const end = source.indexOf('**', start + 2);
    if (end === -1) {
      return null;
    }
    return {
      type: 'strong',
      start,
      end: end + 2,
      text: source.slice(start + 2, end)
    };
  }

  function findCodeMarkdown(source, index) {
    const start = source.indexOf('`', index);
    if (start === -1) {
      return null;
    }
    const end = source.indexOf('`', start + 1);
    if (end === -1) {
      return null;
    }
    return {
      type: 'code',
      start,
      end: end + 1,
      text: source.slice(start + 1, end)
    };
  }

  function findLinkMarkdown(source, index) {
    const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
    linkPattern.lastIndex = index;
    const match = linkPattern.exec(source);
    if (!match) {
      return null;
    }
    return {
      type: 'link',
      start: match.index,
      end: match.index + match[0].length,
      text: match[1],
      href: match[2]
    };
  }

  function formatMarkdownLinkLabel(text, href) {
    const source = String(text || '');
    const target = String(href || '');
    const resolved = resolveMarkdownLineReference(source, target);
    if (resolved) {
      return formatLineReferenceText(resolved);
    }
    const workspaceMatch = target.match(/\/workspace\/([^:)]+)(?::(\d+))?/);
    if (workspaceMatch) {
      const fileLabel = sanitizeAssistantVisibleText(workspaceMatch[1]);
      const line = workspaceMatch[2];
      return line ? `workspace/${fileLabel}:${line}` : `workspace/${fileLabel}`;
    }
    return sanitizeAssistantVisibleText(source || target);
  }

  function formatMarkdownHref(href) {
    const target = String(href || '').trim();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      return '#';
    }
    try {
      const parsed = new URL(target);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        if (containsLocalPathText(parsed.href)) {
          parsed.search = '';
          parsed.hash = '';
        }
        return parsed.href;
      }
    } catch (_error) {
      // Fall through to inert link for malformed URLs.
    }
    return '#';
  }

  const renderingDiagnosticKeys = new Set();

  function renderMarkdownBlockText(target, value, renderOptions = {}) {
    const rawSource = String(value || '').trim();
    if (!rawSource) {
      target.replaceChildren();
      return;
    }

    if (!renderOptions.streaming) {
      const runtimeRoot = typeof window !== 'undefined' ? window : globalThis;
      const domRenderer = runtimeRoot.CodexOverleafMarkdownDomRenderer;
      try {
        if (!domRenderer?.renderMarkdown || typeof runtimeRoot.markdownit !== 'function') {
          const dependencyError = new Error('The vendored Markdown DOM renderer is unavailable.');
          dependencyError.code = 'markdown_dom_dependency_missing';
          throw dependencyError;
        }
        domRenderer.renderMarkdown(target, rawSource, {
          document,
          markdownIt: runtimeRoot.markdownit,
          mathText: runtimeRoot.CodexOverleafMathText,
          renderTextNodes: text => buildMarkdownInlineNodes(text),
          renderLinkNodes: (label, href) => {
            const safeLabel = String(label || '');
            const target = String(href || '').trim();
            if (!/^https?:\/\//i.test(target) && !resolveMarkdownLineReference(safeLabel, target)) return buildMarkdownInlineNodes(safeLabel);
            return buildMarkdownInlineNodes(
              `[${safeLabel.replace(/]/g, '\\]')}](${target.replace(/\)/g, '\\)')})`
            );
          },
          renderCodeNodes: text => buildMarkdownInlineNodes(`\`${String(text || '').replace(/`/g, '\\`')}\``),
          sanitizeText: sanitizeAssistantVisibleText,
          createMathNode: segment => runtimeRoot.CodexOverleafMathText.createMathNode(segment, {
            document, katex: runtimeRoot.katex,
            renderText: text => buildMarkdownInlineNodes(text)
          }),
          recordDiagnostic: recordRenderingDiagnostic
        });
        return;
      } catch (error) {
        recordRenderingDiagnostic({
          code: error?.code || 'markdown_dom_fallback',
          detail: String(error?.message || 'Markdown DOM rendering failed.')
        });
      }
    }

    const source = normalizeInlineOrderedLists(rawSource);
    target.replaceChildren();
    const lines = source.split(/\r?\n/);
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index++;
        continue;
      }

      if (isMarkdownFenceLine(line)) {
        const codeLines = [];
        index++;
        while (index < lines.length && !isMarkdownFenceLine(lines[index])) {
          codeLines.push(lines[index]);
          index++;
        }
        if (index < lines.length && isMarkdownFenceLine(lines[index])) {
          index++;
        }
        const pre = document.createElement('pre');
        pre.className = 'run-code-block';
        const code = document.createElement('code');
        code.textContent = sanitizeAssistantVisibleText(codeLines.join('\n'));
        pre.append(code);
        target.append(pre);
        continue;
      }

      if (isMarkdownHeadingLine(line)) {
        const heading = document.createElement('p');
        heading.className = 'run-final-heading';
        heading.append(...buildMarkdownInlineNodes(line.replace(/^\s*#{1,6}\s+/, '').trim()));
        target.append(heading);
        index++;
        continue;
      }

      if (isMarkdownListLine(line)) {
        const ordered = isMarkdownOrderedListLine(line);
        const list = ordered ? document.createElement('ol') : document.createElement('ul');
        while (index < lines.length && isSameMarkdownListKind(lines[index], ordered)) {
          const item = document.createElement('li');
          item.append(...buildMarkdownInlineNodes(stripMarkdownListMarker(lines[index])));
          list.append(item);
          index++;
        }
        target.append(list);
        continue;
      }

      const paragraphLines = [];
      while (
        index < lines.length &&
        lines[index].trim() &&
        !isMarkdownListLine(lines[index]) &&
        !isMarkdownHeadingLine(lines[index]) &&
        !isMarkdownFenceLine(lines[index])
      ) {
        paragraphLines.push(lines[index].trim());
        index++;
      }

      appendMarkdownParagraphFlow(target, paragraphLines.join(' '));
    }
  }

  function recordRenderingDiagnostic(diagnostic = {}) {
    const code = String(diagnostic.code || 'markdown_rendering_diagnostic');
    const detail = String(diagnostic.detail || '').slice(0, 240);
    const key = `${code}:${detail}`;
    if (renderingDiagnosticKeys.has(key)) {
      return;
    }
    renderingDiagnosticKeys.add(key);
    if (typeof options.recordRenderingDiagnostic === 'function') options.recordRenderingDiagnostic({ code, detail });
  }

  function appendMarkdownParagraphFlow(target, value) {
    const nodes = buildMarkdownInlineNodes(value);
    let paragraph = null;
    let paragraphHasContent = false;
    const flushParagraph = () => {
      if (paragraph && paragraphHasContent) {
        target.append(paragraph);
      }
      paragraph = null;
      paragraphHasContent = false;
    };

    for (const node of nodes) {
      if (node?.dataset?.mathDisplay === 'block') {
        flushParagraph();
        target.append(node);
        continue;
      }
      if (!paragraph) {
        paragraph = document.createElement('p');
      }
      paragraph.append(node);
      paragraphHasContent = true;
    }
    flushParagraph();
  }

  function isMarkdownFenceLine(line) {
    return /^\s*```/.test(String(line || ''));
  }

  function isMarkdownListLine(line) {
    return isMarkdownUnorderedListLine(line) || isMarkdownOrderedListLine(line);
  }

  function isMarkdownUnorderedListLine(line) {
    return /^\s*-\s+/.test(line);
  }

  function isMarkdownOrderedListLine(line) {
    return /^\s*\d+\.\s+/.test(line);
  }

  function isSameMarkdownListKind(line, ordered) {
    return ordered ? isMarkdownOrderedListLine(line) : isMarkdownUnorderedListLine(line);
  }

  function stripMarkdownListMarker(line) {
    return String(line || '').replace(/^\s*(?:-\s+|\d+\.\s+)/, '');
  }

  function normalizeInlineOrderedLists(source) {
    return String(source || '').split(/\r?\n/).map(line => {
      if (isMarkdownListLine(line) || !/\s1\.\s+\S/.test(line) || !/\s2\.\s+\S/.test(line)) {
        return line;
      }

      const markers = [];
      const pattern = /(^|\s)(\d{1,2})\.\s+(?=\S)/g;
      let match;
      while ((match = pattern.exec(line)) !== null) {
        markers.push({
          number: Number(match[2]),
          start: match.index + match[1].length
        });
      }
      if (markers.length < 2 || markers[0].number !== 1) {
        return line;
      }
      for (let index = 1; index < markers.length; index++) {
        if (markers[index].number !== markers[index - 1].number + 1) {
          return line;
        }
      }

      const parts = [];
      const prefix = line.slice(0, markers[0].start).trim();
      if (prefix) {
        parts.push(prefix);
      }
      for (let index = 0; index < markers.length; index++) {
        const start = markers[index].start;
        const end = index + 1 < markers.length ? markers[index + 1].start : line.length;
        parts.push(line.slice(start, end).trim());
      }
      return parts.join('\n');
    }).join('\n');
  }

  function isMarkdownHeadingLine(line) {
    return /^\s*(#{1,6}\s+\S.*|\*\*[^*]+\*\*:?\s*)$/.test(line);
  }


    return {
      renderMarkdownInlineText,
      renderMarkdownBlockText,
      sanitizeAssistantVisibleText,
      sanitizeAssistantVisibleValue,
      buildMarkdownInlineNodes,
      normalizeReferencePathForRuntime,
      hasUnsafeRuntimePathSegments
    };
  }

  window.CodexOverleafMarkdownText = { create };
})();
