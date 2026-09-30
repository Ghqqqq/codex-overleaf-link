(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafTextCoordinates = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function resolveJumpToPositionRange(params, text, filePath) {
    if (params.line === undefined && params.column === undefined) {
      return {
        ok: true,
        from: params.from,
        to: params.to
      };
    }

    const lines = collectTextLineRanges(String(text || ''));
    const lineCount = lines.length;
    const lineNumber = Number(params.line);
    const lineMetadata = { lineCount };
    if (params.line !== undefined) {
      lineMetadata.line = Number.isInteger(lineNumber) ? lineNumber : params.line;
    }
    if (!Number.isInteger(lineNumber) || lineNumber < 1) {
      return jumpPositionOutOfRange('line_out_of_range', filePath, lineMetadata);
    }

    const line = lines[lineNumber - 1];
    if (!line) {
      return jumpPositionOutOfRange('line_out_of_range', filePath, {
        line: lineNumber,
        lineCount
      });
    }

    const lineLength = line.end - line.start;
    if (params.selectLine === true) {
      return {
        ok: true,
        from: line.start,
        to: line.end
      };
    }

    if (params.column !== undefined) {
      const columnNumber = Number(params.column);
      const maxColumn = lineLength + 1;
      if (!Number.isInteger(columnNumber) || columnNumber < 1 || columnNumber > maxColumn) {
        return jumpPositionOutOfRange('column_out_of_range', filePath, {
          line: lineNumber,
          column: Number.isInteger(columnNumber) ? columnNumber : params.column,
          lineLength
        });
      }
      const offset = line.start + columnNumber - 1;
      return {
        ok: true,
        from: offset,
        to: offset
      };
    }

    return {
      ok: true,
      from: line.start,
      to: line.start
    };
  }

  function jumpPositionOutOfRange(code, filePath, metadata = {}) {
    return {
      ok: false,
      code,
      reason: 'Requested jumpToPosition location is out of range',
      path: filePath,
      ...metadata
    };
  }

  function collectTextLineRanges(text) {
    const lines = [];
    let start = 0;

    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === '\r') {
        lines.push({ start, end: index });
        if (text[index + 1] === '\n') {
          index += 1;
        }
        start = index + 1;
      } else if (text[index] === '\n') {
        lines.push({ start, end: index });
        start = index + 1;
      }
    }

    lines.push({ start, end: text.length });
    return lines;
  }

  return { create: () => ({ resolveJumpToPositionRange }), resolveJumpToPositionRange, collectTextLineRanges };
});
