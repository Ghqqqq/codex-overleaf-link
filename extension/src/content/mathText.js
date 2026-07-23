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
      const value = source.slice(start + delimiter.open.length, closeStart);
      const end = closeStart + delimiter.close.length;
      if (!isValidMathValue(value, delimiter) || overlapsCodeRange(start, end, codeRanges)) {
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
    return previous !== '$' && next !== '$' && next !== '' && !/\s/.test(next);
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
        && (previous === '$' || next === '$' || /\s/.test(previous));
      if (!isEscaped(source, index) && !isInsideRange(index, codeRanges) && !invalidSingleDollar) {
        return index;
      }
      searchFrom = index + delimiter.close.length;
    }
    return -1;
  }

  function isValidMathValue(value, delimiter) {
    const source = String(value || '');
    if (!source.trim()) {
      return false;
    }
    return delimiter.display || !/[\r\n]/.test(source);
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
        katex: options.katex || root.katex
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
        output: 'htmlAndMathml'
      });
      node.dataset.mathRendered = 'true';
      return node;
    } catch (_error) {
      node.classList.add('run-math--fallback');
      node.dataset.mathRendered = 'false';
      node.textContent = segment.raw;
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
    buildMathNodes,
    createMathNode,
    matchMathAt,
    normalizeMathForRendering,
    parseMathSegments
  };
  root.CodexOverleafMathText = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
