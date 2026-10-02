(function initCompileAdapter(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafCompileAdapter = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function compileAdapterFactory() {
  'use strict';

  const MAX_LOG_BYTES = 32 * 1024;
  const COMPILABLE_EXTENSIONS = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.bbx', '.cbx']);

  function parseCompileResponse(response) {
    if (!response || typeof response !== 'object') {
      return { ok: false, reason: 'Invalid compile response: not an object' };
    }

    if (!Array.isArray(response.outputFiles)) {
      return { ok: false, reason: 'Invalid compile response: outputFiles is not an array' };
    }

    const logFile = response.outputFiles.find(function (file) {
      if (!file) return false;
      if (file.type === 'log') return true;
      if (typeof file.path === 'string' && file.path.endsWith('.log')) return true;
      return false;
    });

    if (!logFile) {
      return { ok: false, reason: 'No log file found in compile output' };
    }

    var logUrl = logFile.url || null;
    if (!logUrl) {
      return { ok: false, reason: 'Log file has no URL' };
    }

    return {
      ok: true,
      status: response.status,
      logUrl: logUrl,
      logPath: logFile.path || null
    };
  }

  function extractErrorBlocks(lines) {
    var blocks = [];
    var i = 0;

    while (i < lines.length && blocks.length < 20) {
      var line = lines[i];
      if (line.startsWith('!') || /^l\.\d+/.test(line)) {
        var block = [];
        // Collect surrounding context: go back up to 2 lines for pre-context
        var start = Math.max(0, i - 2);
        for (var j = start; j < i; j++) {
          block.push(lines[j]);
        }
        // Collect from the error line forward until blank line or capital letter line
        while (i < lines.length) {
          block.push(lines[i]);
          i++;
          if (i < lines.length) {
            var next = lines[i];
            if (next.trim() === '') {
              block.push(next);
              i++;
              break;
            }
            if (/^[A-Z]/.test(next) && !next.startsWith('!') && !/^l\.\d+/.test(next)) {
              break;
            }
          }
        }
        blocks.push(block.join('\n'));
      } else {
        i++;
      }
    }

    return blocks;
  }

  function truncateLogForContext(log) {
    if (!log || typeof log !== 'string') {
      return '';
    }

    if (new Blob([log]).size <= MAX_LOG_BYTES) {
      return log;
    }

    var lines = log.split('\n');
    var errorBlocks = extractErrorBlocks(lines);
    var tail = lines.slice(-200).join('\n');

    var separator = '\n\n--- [truncated] ---\n\n';
    var combined = errorBlocks.join('\n\n') + separator + tail;

    // Check if combined fits
    if (new Blob([combined]).size <= MAX_LOG_BYTES) {
      return combined;
    }

    // Slice to 90% of MAX_LOG_BYTES in characters as a final fallback
    var maxChars = Math.floor(MAX_LOG_BYTES * 0.9);
    return combined.slice(0, maxChars);
  }

  function isCompileLogFresh(log, lastKnownSourceEditTimestamp) {
    if (!log || typeof log !== 'object') {
      return false;
    }

    if (log.sourceChangeTimestamp == null) {
      return false;
    }

    return log.sourceChangeTimestamp >= lastKnownSourceEditTimestamp;
  }

  function isCompilableFile(filePath) {
    if (!filePath || typeof filePath !== 'string') {
      return false;
    }

    var lastDot = filePath.lastIndexOf('.');
    if (lastDot === -1) {
      return false;
    }

    var ext = filePath.slice(lastDot).toLowerCase();
    return COMPILABLE_EXTENSIONS.has(ext);
  }

  function parseLogErrors(logContent) {
    var result = { errors: [], warnings: [] };

    if (!logContent || typeof logContent !== 'string') {
      return result;
    }

    var lines = logContent.split('\n');

    // Extract errors: lines starting with '!' plus up to 3 following context lines
    for (var i = 0; i < lines.length && result.errors.length < 50; i++) {
      if (lines[i].startsWith('!')) {
        var errorLines = [lines[i]];
        for (var j = 1; j <= 3 && (i + j) < lines.length; j++) {
          errorLines.push(lines[i + j]);
        }
        result.errors.push(errorLines.join('\n'));
      }
    }

    // Extract warnings: lines matching /Warning/i that don't start with whitespace
    for (var k = 0; k < lines.length && result.warnings.length < 50; k++) {
      if (/Warning/i.test(lines[k]) && !/^\s/.test(lines[k])) {
        result.warnings.push(lines[k]);
      }
    }

    return result;
  }

  function buildPostWriteCompileSummary({ result = null, logResult = null, error = null } = {}) {
    const logAvailable = logResult?.ok === true;
    const errors = logAvailable && Array.isArray(logResult.errors)
      ? logResult.errors.slice(0, 5).map(formatCompileDiagnosticForSummary)
      : [];
    const warnings = logAvailable && Array.isArray(logResult.warnings)
      ? logResult.warnings.slice(0, 5).map(formatCompileDiagnosticForSummary)
      : [];
    if (error) {
      return {
        status: 'failed',
        reason: error?.message || 'Post-write compile failed.',
        errors,
        warnings,
        logAvailable
      };
    }
    if (!result?.ok) {
      return {
        status: 'failed',
        reason: result?.reason || 'Post-write compile did not succeed.',
        errors,
        warnings,
        logAvailable
      };
    }
    return {
      status: result.compile?.status || 'triggered',
      reason: result.reason || '',
      errors,
      warnings,
      logAvailable
    };
  }

  function formatCompileDiagnosticForSummary(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > 180 ? `${text.slice(0, 179)}...` : text;
  }

  return {
    buildPostWriteCompileSummary,
    formatCompileDiagnosticForSummary,
    COMPILABLE_EXTENSIONS,
    MAX_LOG_BYTES,
    extractErrorBlocks,
    isCompilableFile,
    isCompileLogFresh,
    parseCompileResponse,
    parseLogErrors,
    truncateLogForContext
  };
});
