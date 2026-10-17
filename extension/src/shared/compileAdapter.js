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
    if (!response || typeof response !== 'object') return { ok: false, reason: 'Invalid compile response: not an object' };
    if (!Array.isArray(response.outputFiles)) return { ok: false, status: response.status, reason: 'Invalid compile response: outputFiles is not an array' };
    const logFile = response.outputFiles.find(file => /(^|\/)output\.log$/.test(file?.path || '')) || response.outputFiles.find(function (file) {
      if (!file) return false;
      if (file.type === 'log') return true;
      if (typeof file.path === 'string' && file.path.endsWith('.log')) return true;
      return false;
    });
    if (!logFile) return { ok: false, status: response.status, reason: 'No log file found in compile output' };
    var logUrl = typeof logFile.url === 'string' ? logFile.url : null;
    if (!logUrl) return { ok: false, status: response.status, reason: 'Log file has no URL' };
    return {
      ok: true,
      status: response.status,
      fromCache: response.fromCache === true,
      logUrl: logUrl,
      logPath: logFile.path || null,
      build: logFile.build || null,
      pdfDownloadDomain: normalizePdfDownloadDomain(response.pdfDownloadDomain),
      clsiServerId: typeof response.clsiServerId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(response.clsiServerId)
        ? response.clsiServerId : null
    };
  }

  function normalizePdfDownloadDomain(value) {
    if (typeof value !== 'string' || !/^https:\/\/[^\s\\]+$/i.test(value)) return null;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash ? value : null;
    } catch (_error) {
      return null;
    }
  }

  function extractErrorBlocks(lines) {
    var blocks = [];
    var i = 0;

    while (i < lines.length && blocks.length < 20) {
      var line = lines[i];
      if (isLogErrorLine(line) || /^l\.\d+/.test(line)) {
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
    if (!log || typeof log !== 'string') return '';

    if (new Blob([log]).size <= MAX_LOG_BYTES) return log;

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
    if (!log || typeof log !== 'object') return false;
    if (log.sourceChangeTimestamp == null) return false;

    return log.sourceChangeTimestamp >= lastKnownSourceEditTimestamp;
  }

  function isCompilableFile(filePath) {
    if (!filePath || typeof filePath !== 'string') return false;

    var lastDot = filePath.lastIndexOf('.');
    if (lastDot === -1) return false;

    var ext = filePath.slice(lastDot).toLowerCase();
    return COMPILABLE_EXTENSIONS.has(ext);
  }

  function isLogErrorLine(line) {
    // TeX's -file-line-error output (used by Overleaf) has no leading '!'.
    return line.startsWith('!') || /^Runaway argument/.test(line)
      || (/^(?:\.{0,2}\/|[A-Za-z]:[\\/])?.+?:\d+:\s+\S/.test(line) && !/\bWarning\b/i.test(line));
  }

  function parseLogErrors(logContent) {
    var result = { errors: [], warnings: [] };

    if (!logContent || typeof logContent !== 'string') {
      return result;
    }

    var lines = logContent.split('\n');

    // Retain the bounded error list; consumers limit displayed snippets separately.
    for (var i = 0; i < lines.length && result.errors.length < 50; i++) {
      if (isLogErrorLine(lines[i])) {
        var errorLines = [lines[i]];
        for (var j = 1; j <= 3 && (i + j) < lines.length; j++) {
          if (!lines[i + j].trim() || isLogErrorLine(lines[i + j])) break;
          errorLines.push(lines[i + j]);
        }
        result.errors.push(errorLines.join('\n'));
      }
    }

    // Count only the warning forms Overleaf's own log parser reports, so
    // informational lines such as "Package: infwarerr … info/warning/error
    // messages" are not shown as warnings.
    for (var k = 0; k < lines.length && result.warnings.length < 50; k++) {
      if (/^LaTeX(?:3| Font)? Warning: /.test(lines[k]) || /^(?:Package|Class|Module) \b.+\b Warning:/.test(lines[k])) {
        result.warnings.push(lines[k]);
      }
    }

    return result;
  }

  function buildPostWriteCompileSummary({ result = null, logResult = null, error = null } = {}) {
    const captured = result?.ok === true && result.resultCaptured === true
      && Number.isSafeInteger(result.compile?.captureId) && result.compile.captureId > 0;
    const logAvailable = captured && logResult?.ok === true && logResult.fresh === true
      && result.compile?.captureId === logResult.captureId;
    const errors = logAvailable && Array.isArray(logResult.errors)
      ? logResult.errors.map(formatCompileDiagnosticForSummary)
      : [];
    const warnings = logAvailable && Array.isArray(logResult.warnings)
      ? logResult.warnings.slice(0, 5).map(formatCompileDiagnosticForSummary)
      : [];
    const compilerFailed = captured && logResult?.fresh !== false
      && ['failed', 'failure', 'error', 'timedout', 'timeout'].includes(result.compile?.status);
    if (compilerFailed && !errors.length) errors.push('Post-write compile failed.');
    const failed = compilerFailed || errors.length > 0;
    const success = captured && result.compile?.ok === true && result.compile.status === 'success'
      && result.compile.fromCache !== true && logAvailable;
    const status = failed ? 'failed' : success ? 'success' : result?.ok && !captured ? 'triggered' : 'unconfirmed';
    let reason = error ? error?.message || 'Post-write compile failed.'
      : !result?.ok ? result?.reason || 'Post-write compile did not succeed.' : result.reason || '';
    if (status === 'unconfirmed' || status === 'triggered') {
      // Technical evidence belongs in the existing activity output, not the outcome label.
      reason ||= logResult?.reason || (!captured ? 'compile_capture_missing'
        : result.compile?.reason || (result.compile.fromCache ? 'compile_response_from_cache'
          : logResult?.captureId !== result.compile.captureId ? 'compile_log_capture_mismatch'
            : logResult?.fresh === false ? 'compile_log_stale' : 'compile_result_unconfirmed'));
    }
    return {
      status,
      reason,
      errors,
      warnings,
      logAvailable
    };
  }

  function formatCompileDiagnosticForSummary(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > 180 ? `${text.slice(0, 179)}...` : text;
  }

  // Page/adapter-owned explanations and activity labels are display copy. TeX logs and unknown
  // upstream diagnostics stay literal; callers retain the original evidence.
  function localizeCompileReason(value, locale = 'en', depth = 0) {
    const text = String(value || '');
    const zh = /^zh(?:\b|[-_])/i.test(String(locale));
    const messages = [
      ['Compile succeeded.', '编译成功。'],
      ['Overleaf compile was triggered. The page will continue showing progress.', '已触发 Overleaf 编译；页面会继续显示编译进度。'],
      ['Fetching compile log (@compile-log).', '正在获取编译日志 (@compile-log)。'],
      ['Overleaf save state was not verified.', '尚未确认 Overleaf 已保存。'],
      ['No Overleaf Recompile button or compile request template is available.', '没有可用的 Overleaf 重新编译按钮或编译请求模板。'],
      ['Stored compile request template expired. Please click Overleaf Recompile once, then retry.', '已保存的编译请求模板已过期。请先点击一次 Overleaf 重新编译，再重试。'],
      ['CompileAdapter not available', '编译适配器不可用'],
      ['CompileAdapter not loaded', '编译适配器未加载'],
      ['Overleaf save-state checker is unavailable.', 'Overleaf 保存状态检查器不可用。'],
      ['No compile log URL available', '没有可用的编译日志地址'],
      ['Clicked Overleaf Recompile, but no compile result was captured.', '已点击 Overleaf 重新编译，但未获取到编译结果。'],
      ['Invalid compile response: not an object', '编译响应无效：结果不是对象'],
      ['Invalid compile response: outputFiles is not an array', '编译响应无效：outputFiles 不是数组'],
      ['No log file found in compile output', '编译输出中未找到日志文件'],
      ['Log file has no URL', '日志文件没有可用地址'],
      ['Post-write compile failed.', '写后编译失败。'],
      ['Post-write compile did not succeed.', '写后编译未成功。'],
      ['Overleaf save state has not been checked yet.', '尚未检查 Overleaf 保存状态。'],
      ['Overleaf save state is unavailable.', 'Overleaf 保存状态不可用。'],
      ['Overleaf is offline; saving cannot be confirmed.', 'Overleaf 当前离线，无法确认保存。'],
      ['Overleaf document is unavailable for save-state detection.', 'Overleaf 文档不可用，无法检测保存状态。'],
      ['Overleaf save indicator reports changes are not saved.', 'Overleaf 保存指示器显示修改尚未保存。'],
      ['Overleaf is still saving or syncing changes.', 'Overleaf 仍在保存或同步修改。'],
      ['Overleaf save indicator was present, but did not verify that all changes are saved.', '已找到 Overleaf 保存指示器，但未能确认全部修改已保存。'],
      ['Overleaf save indicator was not found.', '未找到 Overleaf 保存指示器。']
    ];
    for (const [en, chinese] of messages) {
      if (text === en || text === chinese) return zh ? chinese : en;
    }
    for (const [en, chinese] of [
      ['Compile request failed with status ', '编译请求失败，状态码为 '],
      ['Failed to fetch compile log: ', '获取编译日志失败，状态码为 ']
    ]) {
      const prefix = text.startsWith(en) ? en : text.startsWith(chinese) ? chinese : '';
      if (prefix && /^\d{3}$/.test(text.slice(prefix.length))) return (zh ? chinese : en) + text.slice(prefix.length);
    }
    if (depth < 4) for (const [en, chinese] of [
      ['Post-write compile did not succeed: ', '写后编译未成功：'],
      ['Post-write compile failed: ', '写后编译出错：'],
      ['Compile log unavailable: ', '编译日志不可用：'],
      ['Compile request error: ', '编译请求出错：'],
      ['Overleaf save-state checker failed: ', 'Overleaf 保存状态检查失败：'],
      ['Could not check Overleaf save state: ', '无法检查 Overleaf 保存状态：'],
      ['Could not get fresh compile: ', '无法获取最新编译结果：'],
      ['Log fetch error: ', '获取日志出错：'],
      ['Timed out waiting for Overleaf to finish saving changes.', '等待 Overleaf 完成保存超时。'],
      ['Timed out waiting for a verified Overleaf save state.', '等待确认 Overleaf 保存状态超时。']
    ]) {
      const prefix = text.startsWith(en) ? en : text.startsWith(chinese) ? chinese : '';
      if (prefix) {
        const rest = text.slice(prefix.length);
        if (prefix === en && en.endsWith('.') && rest && !rest.startsWith(' ')) continue;
        const suffix = localizeCompileReason(prefix === en && en.endsWith('.') ? rest.slice(1) : rest, locale, depth + 1);
        return (zh ? chinese : en) + (!zh && suffix && en.endsWith('.') ? ' ' : '') + suffix;
      }
    }
    return text;
  }
  return {
    buildPostWriteCompileSummary,
    formatCompileDiagnosticForSummary,
    localizeCompileReason,
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
