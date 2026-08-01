(function initCodexOverleafMathText(root) {
  'use strict';

  const DELIMITERS = Object.freeze([
    Object.freeze({ open: '$$', close: '$$', display: true, singleDollar: false }),
    Object.freeze({ open: '\\[', close: '\\]', display: true, singleDollar: false }),
    Object.freeze({ open: '\\(', close: '\\)', display: false, singleDollar: false }),
    Object.freeze({ open: '$', close: '$', display: false, singleDollar: true })
  ]);
  const LONG_INLINE_MATH_CHARS = 120;
  const COMPLEX_INLINE_MATH_CHARS = 80;
  const MAX_PROJECT_MACRO_SOURCES = 12;
  const MAX_PROJECT_MACRO_SOURCE_CHARS = 256 * 1024;
  const MAX_PROJECT_MACROS = 64;
  const MAX_MACRO_EXPANSION_CHARS = 512;
  const DEFAULT_MATH_MACROS = Object.freeze({
    '\\E': '\\mathbb{E}',
    '\\Var': '\\operatorname{Var}',
    '\\Cov': '\\operatorname{Cov}',
    '\\R': '\\mathbb{R}',
    '\\N': '\\mathbb{N}',
    '\\Z': '\\mathbb{Z}'
  });
  const UNSAFE_MACRO_PATTERN = /\\(?:href|url|includegraphics|input|include|write|openout|read|html\w*|class|style|data|def|gdef|edef|xdef|newcommand|renewcommand|providecommand|DeclareMathOperator)\b/i;

  function parseMathSegments(value) {
    const source = String(value || '');
    if (!source) {
      return [];
    }
    const codeRanges = collectInlineCodeRanges(source);
    const segments = [];
    let cursor = 0;
    while (cursor < source.length) {
      const match = findNextMath(source, cursor, codeRanges);
      if (!match) {
        segments.push({ type: 'text', value: source.slice(cursor) });
        break;
      }
      if (match.start > cursor) {
        segments.push({ type: 'text', value: source.slice(cursor, match.start) });
      }
      segments.push({
        type: 'math',
        value: match.value,
        raw: source.slice(match.start, match.end),
        display: match.display
      });
      cursor = match.end;
    }
    return segments;
  }

  function findNextMath(source, fromIndex, codeRanges) {
    let best = null;
    for (const delimiter of DELIMITERS) {
      const match = findNextDelimitedMath(source, fromIndex, delimiter, codeRanges);
      if (!match) {
        continue;
      }
      if (!best || match.start < best.start
        || (match.start === best.start && delimiter.open.length > best.delimiter.open.length)) {
        best = { ...match, delimiter };
      }
    }
    return best;
  }

  function findNextDelimitedMath(source, fromIndex, delimiter, codeRanges) {
    let searchFrom = fromIndex;
    while (searchFrom < source.length) {
      const start = source.indexOf(delimiter.open, searchFrom);
      if (start < 0) {
        return null;
      }
      if (!isValidOpening(source, start, delimiter, codeRanges)) {
        searchFrom = start + delimiter.open.length;
        continue;
      }
      const closeStart = findClosingDelimiter(
        source,
        start + delimiter.open.length,
        delimiter,
        codeRanges
      );
      if (closeStart < 0) {
        searchFrom = start + delimiter.open.length;
        continue;
      }
      const rawValue = source.slice(start + delimiter.open.length, closeStart);
      const value = rawValue.trim();
      const end = closeStart + delimiter.close.length;
      if (!isValidMathValue(rawValue, delimiter) || overlapsCodeRange(start, end, codeRanges)) {
        searchFrom = start + delimiter.open.length;
        continue;
      }
      return { start, end, value, display: delimiter.display };
    }
    return null;
  }

  function isValidOpening(source, index, delimiter, codeRanges) {
    if (isEscaped(source, index) || isInsideRange(index, codeRanges)) {
      return false;
    }
    if (!delimiter.singleDollar) {
      return true;
    }
    const previous = source[index - 1] || '';
    const next = source[index + 1] || '';
    return previous !== '$' && next !== '$' && next !== '';
  }

  function findClosingDelimiter(source, fromIndex, delimiter, codeRanges) {
    let searchFrom = fromIndex;
    while (searchFrom < source.length) {
      const index = source.indexOf(delimiter.close, searchFrom);
      if (index < 0) {
        return -1;
      }
      const previous = source[index - 1] || '';
      const next = source[index + delimiter.close.length] || '';
      const invalidSingleDollar = delimiter.singleDollar
        && (previous === '$' || next === '$');
      if (!isEscaped(source, index) && !isInsideRange(index, codeRanges) && !invalidSingleDollar) {
        return index;
      }
      searchFrom = index + delimiter.close.length;
    }
    return -1;
  }

  function isValidMathValue(value, delimiter) {
    const source = String(value || '');
    const trimmed = source.trim();
    if (!trimmed) {
      return false;
    }
    if (!delimiter.display && /[\r\n]/.test(source)) {
      return false;
    }
    if (!delimiter.singleDollar || (!/^\s/.test(source) && !/\s$/.test(source))) {
      return true;
    }
    return looksLikeWhitespaceWrappedMath(trimmed);
  }

  function looksLikeWhitespaceWrappedMath(value) {
    const source = String(value || '').trim();
    return /\\[A-Za-z]+/.test(source)
      || /[_^=<>+\-*/()[\]{}|]/.test(source)
      || /^[A-Za-z](?:_[A-Za-z0-9{}]+|\^[A-Za-z0-9{}]+)?$/.test(source);
  }

  function collectInlineCodeRanges(source) {
    const ranges = [];
    let index = 0;
    while (index < source.length) {
      if (source[index] !== '`' || isEscaped(source, index)) {
        index++;
        continue;
      }
      let runLength = 1;
      while (source[index + runLength] === '`') {
        runLength++;
      }
      const marker = '`'.repeat(runLength);
      const closeStart = source.indexOf(marker, index + runLength);
      if (closeStart < 0) {
        index += runLength;
        continue;
      }
      ranges.push([index, closeStart + runLength]);
      index = closeStart + runLength;
    }
    return ranges;
  }

  function isEscaped(source, index) {
    let slashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor--) {
      slashCount++;
    }
    return slashCount % 2 === 1;
  }

  function isInsideRange(index, ranges) {
    return ranges.some(([start, end]) => index >= start && index < end);
  }

  function overlapsCodeRange(start, end, ranges) {
    return ranges.some(([rangeStart, rangeEnd]) => rangeStart < end && rangeEnd > start);
  }

  function buildMathNodes(value, options = {}) {
    const documentRef = options.document || root.document;
    const renderText = typeof options.renderText === 'function'
      ? options.renderText
      : text => [documentRef.createTextNode(text)];
    const nodes = [];
    for (const segment of parseMathSegments(value)) {
      if (segment.type === 'text') {
        if (segment.value) {
          nodes.push(...toNodeArray(renderText(segment.value)));
        }
        continue;
      }
      nodes.push(createMathNode(segment, {
        document: documentRef,
        katex: options.katex || root.katex,
        macros: options.macros || buildMathMacros(options.projectSources)
      }));
    }
    return nodes;
  }

  function createMathNode(segment, options = {}) {
    const documentRef = options.document || root.document;
    const node = documentRef.createElement('span');
    const source = normalizeMathForRendering(segment.value);
    const display = segment.display || shouldPromoteInlineMath(source);
    node.className = `run-math ${display ? 'run-math--display' : 'run-math--inline'}`;
    node.dataset.mathDisplay = display ? 'block' : 'inline';
    if (display && !segment.display) {
      node.classList.add('run-math--promoted');
    }
    try {
      if (typeof options.katex?.render !== 'function') {
        throw new Error('KaTeX is unavailable');
      }
      options.katex.render(source, node, {
        displayMode: display,
        throwOnError: true,
        trust: false,
        strict: 'warn',
        maxExpand: 200,
        maxSize: 20,
        macros: options.macros || buildMathMacros(),
        output: 'htmlAndMathml'
      });
      node.dataset.mathRendered = 'true';
      return node;
    } catch (_error) {
      node.classList.add('run-math--fallback');
      node.dataset.mathRendered = 'false';
      node.textContent = source;
      return node;
    }
  }

  function normalizeMathForRendering(value) {
    return String(value || '')
      .replace(/\r\n?/g, '\n')
      .replace(/(\S)\s+\|\s+(\S)/g, '$1 \\mid $2');
  }

  function shouldPromoteInlineMath(value) {
    const source = String(value || '').trim();
    if (source.length >= LONG_INLINE_MATH_CHARS) {
      return true;
    }
    if (source.length < COMPLEX_INLINE_MATH_CHARS) {
      return false;
    }
    return /(?:=|\\(?:le|ge|approx|sim|to|Rightarrow|Longrightarrow)\b|\\begin\{(?:aligned|gathered|split|array)\}|\\\\)/.test(source);
  }

  function parseStandaloneMath(value) {
    const source = String(value || '').trim();
    if (!source) {
      return null;
    }
    const segments = parseMathSegments(source);
    if (segments.length !== 1 || segments[0].type !== 'math' || segments[0].raw !== source) {
      return null;
    }
    return segments[0];
  }

  function buildMathMacros(projectSources = []) {
    const macros = { ...DEFAULT_MATH_MACROS };
    let remainingChars = MAX_PROJECT_MACRO_SOURCE_CHARS;
    let projectMacroCount = 0;
    for (const sourceRecord of Array.isArray(projectSources)
      ? projectSources.slice(0, MAX_PROJECT_MACRO_SOURCES)
      : []) {
      if (projectMacroCount >= MAX_PROJECT_MACROS || remainingChars <= 0) {
        break;
      }
      const path = String(sourceRecord?.path || '');
      if (!/\.(?:tex|sty|cls|ltx)$/i.test(path)) {
        continue;
      }
      const source = stripLatexComments(
        String(sourceRecord?.content || '').slice(0, remainingChars)
      );
      remainingChars -= source.length;
      const pattern = /\\(newcommand|renewcommand|providecommand|DeclareMathOperator)(\*)?/g;
      let match;
      while ((match = pattern.exec(source)) !== null && projectMacroCount < MAX_PROJECT_MACROS) {
        let cursor = skipWhitespace(source, pattern.lastIndex);
        const nameGroup = readBracedGroup(source, cursor);
        if (!nameGroup) {
          continue;
        }
        const macroName = nameGroup.value.trim();
        cursor = skipWhitespace(source, nameGroup.end);
        if (source[cursor] === '[') {
          continue;
        }
        const expansionGroup = readBracedGroup(source, cursor);
        if (!expansionGroup) {
          continue;
        }
        let expansion = expansionGroup.value.trim();
        if (match[1] === 'DeclareMathOperator') {
          expansion = `\\operatorname${match[2] ? '*' : ''}{${expansion}}`;
        }
        if (!isSafeMacroDefinition(macroName, expansion)) {
          continue;
        }
        macros[macroName] = expansion;
        projectMacroCount++;
        pattern.lastIndex = expansionGroup.end;
      }
    }
    return macros;
  }

  function readBracedGroup(source, start) {
    if (source[start] !== '{') {
      return null;
    }
    let depth = 0;
    for (let index = start; index < source.length; index++) {
      if (source[index] === '{' && !isEscaped(source, index)) {
        depth++;
      } else if (source[index] === '}' && !isEscaped(source, index)) {
        depth--;
        if (depth === 0) {
          return {
            value: source.slice(start + 1, index),
            end: index + 1
          };
        }
      }
    }
    return null;
  }

  function skipWhitespace(source, start) {
    let index = start;
    while (index < source.length && /\s/.test(source[index])) {
      index++;
    }
    return index;
  }

  function stripLatexComments(source) {
    return String(source || '').split(/\r?\n/).map(line => {
      for (let index = 0; index < line.length; index++) {
        if (line[index] === '%' && !isEscaped(line, index)) {
          return line.slice(0, index);
        }
      }
      return line;
    }).join('\n');
  }

  function isSafeMacroDefinition(name, expansion) {
    const macroName = String(name || '');
    const body = String(expansion || '');
    return /^\\[A-Za-z@]+$/.test(macroName)
      && body.length > 0
      && body.length <= MAX_MACRO_EXPANSION_CHARS
      && !body.includes('#')
      && !body.includes(macroName)
      && !UNSAFE_MACRO_PATTERN.test(macroName)
      && !UNSAFE_MACRO_PATTERN.test(body);
  }

  function toNodeArray(value) {
    if (Array.isArray(value)) {
      return value;
    }
    if (value === undefined || value === null) {
      return [];
    }
    return [value];
  }

  function matchMathAt(value, index = 0) {
    const source = String(value || '');
    const start = Number.isSafeInteger(index) ? index : 0;
    if (start < 0 || start >= source.length || (source[start] !== '$' && source[start] !== '\\')) {
      return null;
    }
    const segment = parseMathSegments(source.slice(start))[0];
    if (!segment || segment.type !== 'math' || !segment.raw) {
      return null;
    }
    return {
      start,
      end: start + segment.raw.length,
      raw: segment.raw,
      value: segment.value,
      display: Boolean(segment.display)
    };
  }

  const api = {
    buildMathMacros,
    buildMathNodes,
    createMathNode,
    matchMathAt,
    normalizeMathForRendering,
    parseMathSegments,
    parseStandaloneMath
  };
  root.CodexOverleafMathText = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
