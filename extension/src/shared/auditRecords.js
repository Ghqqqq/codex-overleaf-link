(function initAuditRecords(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafAuditRecords = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function auditRecordsFactory() {
  'use strict';

  const MAX_SUMMARY_CHARS = 240;
  const REDACTED_SECRET = '[REDACTED_SECRET]';
  const SECRET_REDACTION_PATTERNS = [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\b(?:sk|pk)-[A-Za-z0-9][A-Za-z0-9_-]{7,}\b/g,
    /\b(?:api[_-]?key|token|password|passwd|secret)\b\s*[:=]\s*["']?[^"'\s,;]+["']?/gi
  ];
  const CONTENT_LIKE_KEY_PATTERN = /^(stdout|stderr|output|commandOutput|raw|compileLog|diff|fullDiff|content|fileBody|text|body|message|prompt|task)$/i;

  function buildAuditDraftRecord(input = {}) {
    const now = new Date().toISOString();
    return {
      id: input.id || generateId('aud'),
      projectId: redactSecretLikeText(stringField(input.projectId)),
      sessionId: redactSecretLikeText(stringField(input.sessionId)),
      turnId: redactSecretLikeText(stringField(input.turnId)),
      createdAt: redactSecretLikeText(stringField(input.createdAt)) || now,
      completedAt: '',
      mode: redactSecretLikeText(stringField(input.mode)),
      providerId: redactSecretLikeText(stringField(input.providerId)) || 'builtin',
      providerName: redactSecretLikeText(stringField(input.providerName)),
      providerRevision: finiteNumber(input.providerRevision) || 0,
      providerEndpointHost: redactSecretLikeText(stringField(input.providerEndpointHost)),
      model: redactSecretLikeText(stringField(input.model)),
      reasoningEffort: redactSecretLikeText(stringField(input.reasoningEffort)),
      speedTier: redactSecretLikeText(stringField(input.speedTier)),
      promptSummary: summarizePrompt(input.promptSummary || input.task || input.prompt),
      focusFiles: normalizePathList(input.focusFiles),
      selectedSkillIds: normalizeStringList(input.selectedSkillIds),
      sensitiveFindings: normalizeSensitiveFindings(input.sensitiveFindings),
      changedFiles: [],
      diffSummary: normalizeDiffSummary(input.diffSummary),
      blockedFiles: [],
      appliedFiles: [],
      skippedFiles: [],
      resultStatus: 'draft',
      saveVerification: normalizeObjectSummary(input.saveVerification)
    };
  }

  function buildAuditFinalRecord(input = {}) {
    const draft = input.draft && typeof input.draft === 'object' ? input.draft : {};
    return Object.assign({}, draft, {
      completedAt: stringField(input.completedAt) || new Date().toISOString(),
      changedFiles: normalizeFileSummaries(input.changedFiles),
      diffSummary: normalizeDiffSummary(input.diffSummary),
      blockedFiles: normalizeFileSummaries(input.blockedFiles),
      appliedFiles: normalizeFileSummaries(input.appliedFiles),
      skippedFiles: normalizeFileSummaries(input.skippedFiles),
      resultStatus: redactSecretLikeText(stringField(input.resultStatus)) || 'completed',
      saveVerification: normalizeObjectSummary(input.saveVerification)
    });
  }

  function buildDiagnosticBundle(input = {}) {
    return {
      createdAt: new Date().toISOString(),
      compatibility: summarizeCompatibility(input.compatibility),
      platform: summarizePlatform(input.platform),
      nativeEnvironment: summarizeNativeEnvironment(input.nativeEnvironment),
      mirror: summarizeMirror(input.mirror),
      auditLogs: summarizeAuditLogList(input.auditLogs),
      run: summarizeRun(input.run),
      governance: summarizeGovernance(input.governance),
      projectIdHash: hashString(stringField(input.projectId))
    };
  }

  function normalizeAuditLogRecord(input = {}) {
    return {
      id: redactSecretLikeText(stringField(input.id)) || generateId('aud'),
      projectId: redactSecretLikeText(stringField(input.projectId)),
      sessionId: redactSecretLikeText(stringField(input.sessionId)),
      turnId: redactSecretLikeText(stringField(input.turnId)),
      createdAt: redactSecretLikeText(stringField(input.createdAt)) || new Date().toISOString(),
      completedAt: redactSecretLikeText(stringField(input.completedAt)),
      mode: redactSecretLikeText(stringField(input.mode)),
      providerId: redactSecretLikeText(stringField(input.providerId)) || 'builtin',
      providerName: redactSecretLikeText(stringField(input.providerName)),
      providerRevision: finiteNumber(input.providerRevision) || 0,
      providerEndpointHost: redactSecretLikeText(stringField(input.providerEndpointHost)),
      model: redactSecretLikeText(stringField(input.model)),
      reasoningEffort: redactSecretLikeText(stringField(input.reasoningEffort)),
      speedTier: redactSecretLikeText(stringField(input.speedTier)),
      promptSummary: summarizePrompt(input.promptSummary),
      focusFiles: normalizePathList(input.focusFiles),
      selectedSkillIds: normalizeStringList(input.selectedSkillIds),
      sensitiveFindings: normalizeSensitiveFindings(input.sensitiveFindings),
      changedFiles: normalizeFileSummaries(input.changedFiles),
      diffSummary: normalizeDiffSummary(input.diffSummary),
      blockedFiles: normalizeFileSummaries(input.blockedFiles),
      appliedFiles: normalizeFileSummaries(input.appliedFiles),
      skippedFiles: normalizeFileSummaries(input.skippedFiles),
      resultStatus: redactSecretLikeText(stringField(input.resultStatus)) || 'draft',
      saveVerification: normalizeObjectSummary(input.saveVerification)
    };
  }

  function normalizeSensitiveFindings(findings) {
    return (Array.isArray(findings) ? findings : []).map(finding => ({
      detectorId: redactSecretLikeText(stringField(finding.detectorId)),
      path: normalizePath(finding.path),
      source: redactSecretLikeText(stringField(finding.source)),
      preview: summarizePrompt(finding.preview)
    })).map(removeEmptyFields);
  }

  function normalizeFileSummaries(files) {
    return (Array.isArray(files) ? files : []).map(file => {
      if (typeof file === 'string') {
        return { path: normalizePath(file) };
      }
      return removeEmptyFields({
        path: normalizePath(file && file.path),
        destinationPath: normalizePath(file && file.destinationPath),
        type: redactSecretLikeText(stringField(file && file.type)),
        reason: redactSecretLikeText(stringField(file && file.reason)),
        status: redactSecretLikeText(stringField(file && file.status)),
        size: Number.isFinite(Number(file && file.size)) ? Number(file.size) : undefined
      });
    });
  }

  function normalizeDiffSummary(summary = {}) {
    const result = {};
    for (const key of ['filesChanged', 'additions', 'deletions', 'binaryFilesChanged']) {
      if (Object.prototype.hasOwnProperty.call(summary, key)) {
        result[key] = nonNegativeInteger(summary[key]);
      }
    }
    return result;
  }

  function normalizeObjectSummary(value) {
    if (!value || typeof value !== 'object') {
      return null;
    }
    return summarizeVerificationObject(value);
  }

  function normalizeAuditLogList(records) {
    return (Array.isArray(records) ? records : []).map(normalizeAuditLogRecord);
  }

  function summarizeCompatibility(compatibility = {}) {
    const native = compatibility && typeof compatibility.native === 'object' ? compatibility.native : {};
    return removeEmptySummaryFields({
      status: redactSecretLikeText(stringField(compatibility.status)),
      extensionVersion: redactSecretLikeText(stringField(compatibility.extensionVersion)),
      extension: removeEmptySummaryFields({
        version: redactSecretLikeText(stringField(compatibility.extension && compatibility.extension.version)),
        protocolVersion: finiteNumber(compatibility.extension && compatibility.extension.protocolVersion)
      }),
      native: removeEmptySummaryFields({
        status: redactSecretLikeText(stringField(native.status)),
        version: redactSecretLikeText(stringField(native.version)),
        protocolVersion: finiteNumber(native.protocolVersion),
        minExtensionVersion: redactSecretLikeText(stringField(native.minExtensionVersion)),
        supportedProtocol: summarizeProtocol(native.supportedProtocol)
      }),
      modelDiscovery: summarizeStatusObject(compatibility.modelDiscovery)
    });
  }

  function summarizeProtocol(protocol) {
    if (!protocol || typeof protocol !== 'object') {
      return undefined;
    }
    return removeEmptySummaryFields({
      min: finiteNumber(protocol.min),
      max: finiteNumber(protocol.max)
    });
  }

  function summarizePlatform(platform = {}) {
    return removeEmptySummaryFields({
      status: redactSecretLikeText(stringField(platform.status)),
      errorCode: redactSecretLikeText(stringField(platform.errorCode)),
      host: redactSecretLikeText(stringField(platform.host)),
      platform: redactSecretLikeText(stringField(platform.platform)),
      os: redactSecretLikeText(stringField(platform.os)),
      arch: redactSecretLikeText(stringField(platform.arch)),
      version: redactSecretLikeText(stringField(platform.version)),
      protocolVersion: finiteNumber(platform.protocolVersion)
    });
  }

  function summarizeNativeEnvironment(environment = {}) {
    return removeEmptySummaryFields({
      status: redactSecretLikeText(stringField(environment.status)),
      errorCode: redactSecretLikeText(stringField(environment.errorCode)),
      codex: summarizeCodexTool(environment.codex),
      latex: summarizeLatexTools(environment.latex),
      pathPreviewCount: Array.isArray(environment.pathPreview) ? environment.pathPreview.length : undefined
    });
  }

  function summarizeCodexTool(codex = {}) {
    if (!codex || typeof codex !== 'object') {
      return undefined;
    }
    return removeEmptySummaryFields({
      ok: typeof codex.ok === 'boolean' ? codex.ok : undefined,
      pathPresent: typeof codex.path === 'string' && codex.path.trim().length > 0,
      version: redactSecretLikeText(stringField(codex.version)),
      errorCode: redactSecretLikeText(stringField(codex.errorCode)),
      errorCategory: categorizeError(codex.errorCode || codex.message || codex.error)
    });
  }

  function summarizeLatexTools(latex = {}) {
    if (!latex || typeof latex !== 'object') {
      return undefined;
    }
    const available = normalizeToolList(latex.available);
    const missing = normalizeToolList(latex.missing);
    const tools = summarizeToolAvailability(latex.tools);
    return removeEmptySummaryFields({
      ok: typeof latex.ok === 'boolean' ? latex.ok : undefined,
      available,
      missing,
      availableCount: available.length || undefined,
      missingCount: missing.length || undefined,
      tools,
      errorCode: redactSecretLikeText(stringField(latex.errorCode)),
      errorCategory: categorizeError(latex.errorCode || latex.message || latex.error)
    });
  }

  function summarizeToolAvailability(tools) {
    if (!tools || typeof tools !== 'object' || Array.isArray(tools)) {
      return undefined;
    }
    const result = {};
    for (const name of Object.keys(tools).sort()) {
      const tool = normalizeToolName(name);
      if (tool) {
        result[tool] = Boolean(tools[name]);
      }
    }
    return removeEmptySummaryFields(result);
  }

  function summarizeMirror(mirror = {}) {
    const files = Array.isArray(mirror.files) ? mirror.files : [];
    const skippedFiles = Array.isArray(mirror.skippedFiles) ? mirror.skippedFiles : [];
    return removeEmptySummaryFields({
      status: redactSecretLikeText(stringField(mirror.status)),
      rootStatus: redactSecretLikeText(stringField(mirror.rootStatus)),
      fileCount: files.length || finiteNumber(mirror.fileCount),
      skippedCount: skippedFiles.length || finiteNumber(mirror.skippedCount),
      byteCount: finiteNumber(mirror.byteCount) || sumFileBytes(files),
      skippedByteCount: finiteNumber(mirror.skippedByteCount) || sumFileBytes(skippedFiles),
      binaryFileCount: countBinaryFiles(files),
      errorCode: redactSecretLikeText(stringField(mirror.errorCode)),
      errorCategory: categorizeError(mirror.errorCode || mirror.message || mirror.error)
    });
  }

  function summarizeRun(run = {}) {
    return removeEmptySummaryFields({
      id: redactSecretLikeText(stringField(run.id)),
      status: redactSecretLikeText(stringField(run.status)),
      errorCode: redactSecretLikeText(stringField(run.errorCode)),
      errorCategory: categorizeError(run.errorCode || run.message || run.error),
      events: (Array.isArray(run.events) ? run.events : []).map(event => removeEmptyFields({
        titlePreview: summarizeRedactedPreview(event.title),
        status: redactSecretLikeText(stringField(event.status)),
        errorCode: redactSecretLikeText(stringField(event.errorCode)),
        errorCategory: categorizeError(event.errorCode || event.message || event.error),
        kind: redactSecretLikeText(stringField(event.kind))
      }))
    });
  }

  function summarizeGovernance(rules = {}) {
    return {
      readonlyPatternCount: Array.isArray(rules.readonlyPatterns) ? rules.readonlyPatterns.length : 0,
      writablePatternCount: Array.isArray(rules.writablePatterns) ? rules.writablePatterns.length : 0,
      sensitiveCheckEnabled: rules.sensitiveCheckEnabled === true,
      sensitiveConfirmAllowed: rules.sensitiveConfirmAllowed === true
    };
  }

  function summarizeAuditLogList(records) {
    return (Array.isArray(records) ? records : []).map(summarizeAuditLogRecord);
  }

  function summarizeAuditLogRecord(input = {}) {
    const record = normalizeAuditLogRecord(input);
    const changedFiles = Array.isArray(record.changedFiles) ? record.changedFiles : [];
    const blockedFiles = Array.isArray(record.blockedFiles) ? record.blockedFiles : [];
    const appliedFiles = Array.isArray(record.appliedFiles) ? record.appliedFiles : [];
    const skippedFiles = Array.isArray(record.skippedFiles) ? record.skippedFiles : [];
    return removeEmptySummaryFields({
      id: record.id,
      sessionId: record.sessionId,
      turnId: record.turnId,
      createdAt: record.createdAt,
      completedAt: record.completedAt,
      mode: record.mode,
      model: record.model,
      reasoningEffort: record.reasoningEffort,
      speedTier: record.speedTier,
      promptPreview: summarizeRedactedPreview(input.promptSummary || input.task || input.prompt),
      focusFileCount: Array.isArray(record.focusFiles) ? record.focusFiles.length : 0,
      selectedSkillCount: Array.isArray(record.selectedSkillIds) ? record.selectedSkillIds.length : 0,
      sensitiveFindingCount: Array.isArray(record.sensitiveFindings) ? record.sensitiveFindings.length : 0,
      changedFileCount: changedFiles.length,
      changedByteCount: sumFileBytes(changedFiles),
      blockedFileCount: blockedFiles.length,
      appliedFileCount: appliedFiles.length,
      skippedFileCount: skippedFiles.length,
      skippedByteCount: sumFileBytes(skippedFiles),
      diffSummary: record.diffSummary,
      resultStatus: record.resultStatus,
      saveVerification: summarizeStatusObject(input.saveVerification)
    });
  }

  function redactContent(value) {
    if (Array.isArray(value)) {
      return value.map(redactContent);
    }
    if (typeof value === 'string') {
      return redactSecretLikeText(value);
    }
    if (!value || typeof value !== 'object') {
      return value;
    }

    const result = {};
    for (const key of Object.keys(value)) {
      if (isContentKey(key)) {
        continue;
      }
      result[key] = redactContent(value[key]);
    }
    return result;
  }

  function isContentKey(key) {
    return CONTENT_LIKE_KEY_PATTERN.test(key);
  }

  function normalizePathList(paths) {
    return normalizeStringList(paths).map(normalizePath);
  }

  function normalizePath(value) {
    return redactSecretLikeText(stringField(value)).replace(/\\/g, '/').replace(/^\/+/, '');
  }

  function normalizeStringList(values) {
    const seen = new Set();
    const result = [];
    for (const value of Array.isArray(values) ? values : []) {
      const text = redactSecretLikeText(stringField(value)).trim();
      if (!text || seen.has(text)) {
        continue;
      }
      seen.add(text);
      result.push(text);
    }
    return result;
  }

  function summarizePrompt(value) {
    const text = redactSecretLikeText(stringField(value)).replace(/\s+/g, ' ').trim();
    if (!text) {
      return '';
    }
    return `[prompt omitted; chars=${text.length}; hash=${hashString(text)}]`;
  }

  function summarizeStatusObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    return removeEmptySummaryFields({
      state: redactSecretLikeText(stringField(value.state)),
      status: redactSecretLikeText(stringField(value.status)),
      ok: typeof value.ok === 'boolean' ? value.ok : undefined,
      errorCode: redactSecretLikeText(stringField(value.errorCode || value.code)),
      errorCategory: redactSecretLikeText(stringField(value.errorCategory)) ||
        categorizeError(value.errorCode || value.code || value.message || value.error)
    });
  }

  function summarizeVerificationObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const summary = {
      state: redactSecretLikeText(stringField(value.state)),
      status: redactSecretLikeText(stringField(value.status)),
      ok: typeof value.ok === 'boolean' ? value.ok : undefined,
      errorCode: redactSecretLikeText(stringField(value.errorCode || value.code)),
      errorCategory: categorizeError(value.errorCode || value.code || value.reason || value.message || value.error)
    };
    if (value.diagnostics && typeof value.diagnostics === 'object' && !Array.isArray(value.diagnostics)) {
      summary.diagnostics = summarizeStatusObject(value.diagnostics);
    }
    return removeEmptySummaryFields(summary);
  }

  function summarizeRedactedPreview(value) {
    const text = stringField(value);
    if (!text) {
      return undefined;
    }
    return {
      redacted: true,
      chars: text.length,
      hash: hashString(text)
    };
  }

  function normalizeToolList(values) {
    const seen = new Set();
    const result = [];
    for (const value of Array.isArray(values) ? values : []) {
      const name = normalizeToolName(value);
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      result.push(name);
    }
    return result;
  }

  function normalizeToolName(value) {
    const text = redactSecretLikeText(stringField(value)).replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
    return text.replace(/[^a-zA-Z0-9_.+-]/g, '').slice(0, 48);
  }

  function sumFileBytes(files) {
    let total = 0;
    for (const file of Array.isArray(files) ? files : []) {
      const explicitSize = finiteNumber(file && (file.size ?? file.byteLength ?? file.bytes));
      if (explicitSize !== undefined) {
        total += explicitSize;
      } else if (typeof file?.content === 'string') {
        total += file.content.length;
      }
    }
    return total || undefined;
  }

  function countBinaryFiles(files) {
    let count = 0;
    for (const file of Array.isArray(files) ? files : []) {
      if (file?.binary === true || file?.type === 'binary' || file?.kind === 'binary') {
        count += 1;
      }
    }
    return count || undefined;
  }

  function categorizeError(value) {
    const text = redactSecretLikeText(stringField(value)).toLowerCase();
    if (!text) {
      return undefined;
    }
    if (/timeout|timed out|etimedout/.test(text)) {
      return 'timeout';
    }
    if (/permission|denied|eacces|eperm/.test(text)) {
      return 'permission';
    }
    if (/not found|missing|enoent|unavailable/.test(text)) {
      return 'missing';
    }
    if (/quota|too large|limit/.test(text)) {
      return 'quota';
    }
    return 'error';
  }

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined;
  }

  function redactSecretLikeText(value) {
    let redacted = stringField(value);
    for (const pattern of SECRET_REDACTION_PATTERNS) {
      pattern.lastIndex = 0;
      redacted = redacted.replace(pattern, REDACTED_SECRET);
    }
    return redacted;
  }

  function stringField(value) {
    return typeof value === 'string' ? value : '';
  }

  function nonNegativeInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  }

  function removeEmptyFields(value) {
    const result = {};
    for (const key of Object.keys(value)) {
      if (value[key] !== undefined && value[key] !== '') {
        result[key] = value[key];
      }
    }
    return result;
  }

  function removeEmptySummaryFields(value) {
    const result = {};
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (item === undefined || item === '' || item === null) {
        continue;
      }
      if (Array.isArray(item) && item.length === 0) {
        continue;
      }
      if (
        item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        Object.keys(item).length === 0
      ) {
        continue;
      }
      result[key] = item;
    }
    return result;
  }

  function hashString(value) {
    let hash = 2166136261;
    const text = String(value || '');
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function generateId(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  return {
    buildAuditDraftRecord,
    buildAuditFinalRecord,
    buildDiagnosticBundle,
    normalizeAuditLogRecord,
    normalizeSensitiveFindings,
    normalizeFileSummaries,
    normalizeDiffSummary,
    redactContent,
    hashString
  };
});
