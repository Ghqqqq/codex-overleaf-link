(function initStorageDb(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./storageRunActions'), require('./runInputQueue'),
      require('./settlementFacts'), require('./storageSessionClaims'));
  } else {
    root.CodexOverleafModuleRegistry.define('StorageDb', [
      'StorageRunActions',
      'RunInputQueue',
      'SettlementFacts',
      'StorageSessionClaims'
    ], factory);
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function storageDbFactory(StorageRunActions, RunInputQueue, SettlementFacts, StorageSessionClaims) {
  'use strict';
  if (!StorageRunActions?.compactRunsForStorage || !StorageRunActions?.compactRunActionPayload || !StorageRunActions?.compactProviderSnapshot || !StorageRunActions?.compactStructuredEventValue || !StorageRunActions?.hashString || !RunInputQueue?.compactForStorage || !SettlementFacts?.compactSettlementFacts || !StorageSessionClaims?.createSessionClaimer) {
    throw new Error('Codex Overleaf storage run-action helpers are unavailable.');
  }
  // IndexedDB versions are monotonic; v2.0 RC profiles have already opened v3.
  // Lowering it hides otherwise-intact session history behind fallback state.
  var TARGET_SCHEMA_VERSION = 3;
  var DB_NAME = 'codex-overleaf';
  var CUSTOM_INSTRUCTIONS_MAX_CHARS = 12000;
  var PROJECT_PREF_KEY_MAX_CHARS = 160;
  var LEGACY_DEFAULT_SESSION_TITLE = 'New task';
  var REDACTED_SECRET = '[REDACTED_SECRET]';
  var SESSION_STORAGE_LIMITS = {
    maxHistory: 10,
    maxRunsPerSession: 20,
    maxEventsPerRun: 300,
    maxAttachmentsPerRun: 8,
    sessionTitleChars: 80,
    taskChars: 12000,
    historyTaskChars: 300,
    historyResultChars: 1800,
    eventTitleChars: 128 * 1024,
    statusTextChars: 800,
    detailChars: 3000,
    reportDetailChars: 64000,
    pathChars: 240
  };
  var VALID_EVENT_STATUSES = {
    info: true,
    running: true,
    completed: true,
    failed: true,
    warning: true,
    blocked: true,
    skipped: true,
    pending: true
  };
  var VALID_TRACKED_CHANGE_STATUSES = {
    pending: true,
    accepted: true,
    rejected: true,
    needs_review: true
  };
  var SECRET_REDACTION_PATTERNS = [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\b(?:sk|pk)-[A-Za-z0-9][A-Za-z0-9_-]{7,}\b/g,
    /\b(?:api[_-]?key|token|password|passwd|secret)\b\s*[:=]\s*["']?[^"'\s,;]+["']?/gi
  ];

  var STORES = {
    sessions: {
      keyPath: 'id',
      indexes: {
        projectId: { keyPath: 'projectId', unique: false },
        updatedAt: { keyPath: 'updatedAt', unique: false }
      }
    },
    turns: {
      keyPath: 'id',
      indexes: {
        sessionId: { keyPath: 'sessionId', unique: false },
        createdAt: { keyPath: 'createdAt', unique: false }
      }
    },
    events: {
      keyPath: 'id',
      indexes: {
        turnId: { keyPath: 'turnId', unique: false },
        index: { keyPath: 'index', unique: false }
      }
    },
    artifacts: {
      keyPath: 'id',
      indexes: {
        turnId: { keyPath: 'turnId', unique: false },
        type: { keyPath: 'type', unique: false }
      }
    },
    auditLogs: {
      keyPath: 'id',
      indexes: {
        projectId: { keyPath: 'projectId', unique: false },
        createdAt: { keyPath: 'createdAt', unique: false }
      }
    }
  };

  // --- Database operations ---

  function openDb() {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, TARGET_SCHEMA_VERSION);
      request.onupgradeneeded = function (event) {
        var db = event.target.result;
        var storeNames = Object.keys(STORES);
        for (var i = 0; i < storeNames.length; i++) {
          var storeName = storeNames[i];
          var storeConfig = STORES[storeName];
          if (!db.objectStoreNames.contains(storeName)) {
            var objectStore = db.createObjectStore(storeName, { keyPath: storeConfig.keyPath });
            var indexNames = Object.keys(storeConfig.indexes);
            for (var j = 0; j < indexNames.length; j++) {
              var indexName = indexNames[j];
              var indexConfig = storeConfig.indexes[indexName];
              objectStore.createIndex(indexName, indexConfig.keyPath, { unique: indexConfig.unique });
            }
          }
        }
      };
      request.onsuccess = function (event) {
        resolve(event.target.result);
      };
      request.onerror = function (event) {
        reject(event.target.error);
      };
    });
  }
  var claimSessionsForAccount = StorageSessionClaims.createSessionClaimer(openDb, function () { return IDBKeyRange; });

  function putRecord(storeName, record) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, 'readwrite');
        var store = tx.objectStore(storeName);
        var request = store.put(record);
        request.onsuccess = function () { resolve(record); };
        request.onerror = function (event) { reject(event.target.error); };
      });
    });
  }

  function putRecords(storeName, records) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, 'readwrite');
        var store = tx.objectStore(storeName);
        for (var i = 0; i < records.length; i++) {
          store.put(records[i]);
        }
        tx.oncomplete = function () { resolve(records); };
        tx.onerror = function (event) { reject(event.target.error); };
      });
    });
  }

  function getRecord(storeName, key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, 'readonly');
        var store = tx.objectStore(storeName);
        var request = store.get(key);
        request.onsuccess = function (event) { resolve(event.target.result || null); };
        request.onerror = function (event) { reject(event.target.error); };
      });
    });
  }

  function getAllByIndex(storeName, indexName, value) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, 'readonly');
        var store = tx.objectStore(storeName);
        var index = store.index(indexName);
        var request = index.getAll(IDBKeyRange.only(value));
        request.onsuccess = function (event) { resolve(event.target.result || []); };
        request.onerror = function (event) { reject(event.target.error); };
      });
    });
  }

  function deleteRecord(storeName, key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, 'readwrite');
        var store = tx.objectStore(storeName);
        var request = store.delete(key);
        request.onsuccess = function () { resolve(); };
        request.onerror = function (event) { reject(event.target.error); };
      });
    });
  }

  function deleteByIndex(storeName, indexName, value) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, 'readwrite');
        var store = tx.objectStore(storeName);
        var index = store.index(indexName);
        var request = index.openCursor(IDBKeyRange.only(value));
        request.onsuccess = function (event) {
          var cursor = event.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function (event) { reject(event.target.error); };
      });
    });
  }

  function clearStore(storeName) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, 'readwrite');
        var store = tx.objectStore(storeName);
        var request = store.clear();
        request.onsuccess = function () { resolve(); };
        request.onerror = function (event) { reject(event.target.error); };
      });
    });
  }

  function clearAllStores() {
    return openDb().then(function (db) {
      var storeNames = Object.keys(STORES);
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeNames, 'readwrite');
        for (var i = 0; i < storeNames.length; i++) {
          tx.objectStore(storeNames[i]).clear();
        }
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function (event) { reject(event.target.error); };
      });
    });
  }

  // --- Record builders ---

  function buildSessionRecord(input, options) {
    options = options || {};
    var now = new Date().toISOString();
    var titleSource = input.titleSource === 'manual' ? 'manual' : 'auto';
    var updatedAt = typeof input.updatedAt === 'string' ? input.updatedAt : now;
    // Welcome-panel + write-guard: persist the four
    // Recent-projects fields on every session record so the cross-project
    // query (`listRecentProjectsAcrossAccount`) can filter / sort / render
    // without touching the raw `task` text.
    //
    // `accountScopeId` is derived via the page-side injection point — T4
    // installs the real implementation on `window.codexOverleafDeriveAccountScopeId`.
    // For T3 the fallback is `() => null`; records persisted with a null scope
    // surface `accountScopeUnavailable: true` and are filtered out of the
    // cross-project query (spec §5.2 degraded mode).
    var safeTaskSummary = typeof input.safeTaskSummary === 'string'
      ? input.safeTaskSummary
      : deriveSafeTaskSummaryFromInput(input);
    var accountScopeId = resolveAccountScopeId(input);
    var accountScopeUnavailable = typeof input.accountScopeUnavailable === 'boolean'
      ? input.accountScopeUnavailable
      : !accountScopeId;
    var lastActivityAt = typeof input.lastActivityAt === 'string' && input.lastActivityAt
      ? input.lastActivityAt
      : updatedAt;
    return {
      id: input.id || generateId('ses'),
      projectId: input.projectId || '',
      title: normalizeSessionTitleForStorage(input.title, titleSource),
      titleSource: titleSource,
      codexThreadId: typeof input.codexThreadId === 'string' ? input.codexThreadId : '',
      status: typeof input.status === 'string' && input.status ? input.status : 'active',
      focusFiles: normalizePathList(input.focusFiles),
      pendingInputs: RunInputQueue.compactForStorage(input.pendingInputs, {
        normalizeField: normalizeTextField,
        normalizeDisplay: normalizeDisplayTextForStorage,
        normalizePaths: normalizePathList
      }),
      history: compactHistoryForStorage(input.history),
      runs: compactRunsForStorage(input.runs, options),
      task: normalizeDisplayTextForStorage(input.task, SESSION_STORAGE_LIMITS.taskChars),
      mode: normalizeCurrentMode(input.mode), providerId: typeof input.providerId === 'string' && input.providerId ? input.providerId : 'builtin',
      model: typeof input.model === 'string' ? input.model : '',
      reasoningEffort: typeof input.reasoningEffort === 'string' ? input.reasoningEffort : '',
      speedTier: typeof input.speedTier === 'string' ? input.speedTier : '',
      requireReviewing: input.requireReviewing !== false,
      createdAt: typeof input.createdAt === 'string' ? input.createdAt : now,
      updatedAt: updatedAt,
      lastActivityAt: lastActivityAt,
      accountScopeId: accountScopeId,
      accountScopeUnavailable: accountScopeUnavailable,
      safeTaskSummary: safeTaskSummary
    };
  }

  function resolveAccountScopeId(input) {
    if (input && typeof input.accountScopeId === 'string' && input.accountScopeId) {
      return input.accountScopeId;
    }
    var globalScope = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null);
    var derive = globalScope && globalScope.window && globalScope.window.codexOverleafDeriveAccountScopeId;
    if (!(derive instanceof Function)) {
      // No injection installed (T3 fallback): tests + early page-load reads
      // both land here. Returning `null` puts the session in degraded mode
      // and excludes it from the cross-project query.
      return null;
    }
    try {
      var value = derive();
      return typeof value === 'string' && value ? value : null;
    } catch (_error) {
      return null;
    }
  }

  function deriveSafeTaskSummaryFromInput(input) {
    var SessionState = loadSessionState();
    if (!SessionState || !(SessionState.computeSafeTaskSummary instanceof Function)) {
      return '';
    }
    var task = typeof input.task === 'string' && input.task ? input.task : '';
    if (!task && Array.isArray(input.runs) && input.runs.length) {
      var firstRun = input.runs[0];
      if (firstRun && typeof firstRun.task === 'string') {
        task = firstRun.task;
      }
    }
    return SessionState.computeSafeTaskSummary(task);
  }

  // Module-local lazy require of the sibling sessionState module. CommonJS
  // resolves once; subsequent calls hit the require cache. We avoid an import
  // at the top of the file so the module surface remains friendly to the
  // page-side IIFE wrapper (no `require` available in that context — the page
  // build uses the global `CodexOverleafSessionState` via the IIFE branch).
  var _sessionStateCache = null;
  function loadSessionState() {
    if (_sessionStateCache !== null) {
      return _sessionStateCache || null;
    }
    var globalScope = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null);
    if (globalScope && globalScope.CodexOverleafSessionState) {
      _sessionStateCache = globalScope.CodexOverleafSessionState;
      return _sessionStateCache;
    }
    if (typeof require === 'function') {
      try {
        _sessionStateCache = require('./sessionState');
        return _sessionStateCache;
      } catch (_error) {
        _sessionStateCache = false;
        return null;
      }
    }
    _sessionStateCache = false;
    return null;
  }

  function buildTurnRecord(input) {
    var now = new Date().toISOString();
    return {
      id: input.id || generateId('turn'),
      sessionId: input.sessionId || '',
      task: summarizeTextForStorage(input.task, 'turn task'),
      mode: typeof input.mode === 'string' ? input.mode : '',
      model: typeof input.model === 'string' ? input.model : '',
      reasoningEffort: typeof input.reasoningEffort === 'string' ? input.reasoningEffort : '',
      speedTier: typeof input.speedTier === 'string' ? input.speedTier : '',
      createdAt: typeof input.createdAt === 'string' ? input.createdAt : now,
      completedAt: typeof input.completedAt === 'string' ? input.completedAt : '',
      finalSummary: summarizeTextForStorage(input.finalSummary, 'turn summary')
    };
  }

  function buildEventRecord(input) {
    var now = new Date().toISOString();
    return {
      id: input.id || generateId('evt'),
      turnId: input.turnId || '',
      index: typeof input.index === 'number' ? input.index : 0,
      kind: typeof input.kind === 'string' ? input.kind : '',
      text: summarizeTextForStorage(input.text, 'event text'),
      detail: compactDetailForStorage(input.detail, SESSION_STORAGE_LIMITS.detailChars) ?? null,
      createdAt: typeof input.createdAt === 'string' ? input.createdAt : now
    };
  }

  function buildArtifactRecord(input) {
    var now = new Date().toISOString();
    return {
      id: input.id || generateId('art'),
      turnId: input.turnId || '',
      type: typeof input.type === 'string' ? input.type : '',
      path: normalizePath(input.path, SESSION_STORAGE_LIMITS.pathChars),
      payload: compactDetailForStorage(input.payload, SESSION_STORAGE_LIMITS.detailChars) ?? null,
      createdAt: typeof input.createdAt === 'string' ? input.createdAt : now
    };
  }

  function buildAuditLogRecord(input) {
    var now = new Date().toISOString();
    return {
      id: input.id || generateId('aud'),
      projectId: typeof input.projectId === 'string' ? input.projectId : '',
      sessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
      turnId: typeof input.turnId === 'string' ? input.turnId : '',
      createdAt: typeof input.createdAt === 'string' ? input.createdAt : now,
      completedAt: typeof input.completedAt === 'string' ? input.completedAt : '',
      mode: typeof input.mode === 'string' ? input.mode : '', ...StorageRunActions.compactProviderSnapshot(input),
      model: typeof input.model === 'string' ? input.model : '',
      reasoningEffort: typeof input.reasoningEffort === 'string' ? input.reasoningEffort : '',
      speedTier: typeof input.speedTier === 'string' ? input.speedTier : '',
      promptSummary: summarizeTextForStorage(input.promptSummary, 'audit prompt'),
      focusFiles: normalizeStringList(input.focusFiles),
      selectedSkillIds: normalizeStringList(input.selectedSkillIds),
      sensitiveFindings: normalizeSensitiveFindings(input.sensitiveFindings),
      changedFiles: normalizeFileSummaries(input.changedFiles),
      diffSummary: normalizeDiffSummary(input.diffSummary),
      blockedFiles: normalizeFileSummaries(input.blockedFiles),
      appliedFiles: normalizeFileSummaries(input.appliedFiles),
      skippedFiles: normalizeFileSummaries(input.skippedFiles),
      resultStatus: typeof input.resultStatus === 'string' && input.resultStatus ? input.resultStatus : 'draft',
      saveVerification: input.saveVerification && typeof input.saveVerification === 'object'
        ? summarizeVerificationObject(input.saveVerification)
        : null
    };
  }

  // --- Helpers ---

  function normalizeCurrentMode(mode) {
    return mode === 'auto' ? 'auto' : 'ask';
  }

  function extractLightweightPrefs(state, projectId) {
    var prefs = {
      storageSchemaVersion: TARGET_SCHEMA_VERSION, providerId: typeof state.providerId === 'string' && state.providerId ? state.providerId : 'builtin',
      model: typeof state.model === 'string' ? state.model : '',
      reasoningEffort: typeof state.reasoningEffort === 'string' ? state.reasoningEffort : '',
      speedTier: typeof state.speedTier === 'string' ? state.speedTier : '',
      mode: normalizeCurrentMode(state.mode),
      locale: typeof state.locale === 'string' ? state.locale : '',
      requireReviewing: state.requireReviewing !== false,
      autoRecompile: state.autoRecompile !== false,
      loadCodexLocalSkills: state.loadCodexLocalSkills !== false,
      loadCodexOverleafSkills: state.loadCodexOverleafSkills !== false,
      panelWidth: Number.isFinite(Number(state.panelWidth)) ? Math.round(Number(state.panelWidth)) : 0,
      activeSessionByProject: state.activeSessionByProject || {},
      experimentalOtByProject: normalizeBooleanMap(state.experimentalOtByProject),
      customInstructionsByProject: normalizeStringMap(state.customInstructionsByProject),
      governanceRulesByProject: normalizeGovernanceRulesMap(state.governanceRulesByProject),
      selectedLocalSkillIdsByProject: normalizeStringListMap(state.selectedLocalSkillIdsByProject),
      codexOverleafSkillEnabled: normalizeCodexOverleafSkillEnabledMap(state.codexOverleafSkillEnabled)
    };
    return prefs;
  }

  function normalizeCodexOverleafSkillEnabledMap(value) {
    var result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return result;
    }
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (typeof key !== 'string' || !key) {
        continue;
      }
      if (typeof value[key] !== 'boolean') {
        continue;
      }
      result[key] = value[key];
    }
    return result;
  }

  function normalizeBooleanMap(value) {
    var result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return result;
    }
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (!key) {
        continue;
      }
      result[key] = value[key] === true;
    }
    return result;
  }

  function normalizeStringMap(value) {
    var result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return result;
    }
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      var rawKey = keys[i];
      var key = normalizeProjectPrefKey(rawKey);
      if (!key) {
        continue;
      }
      result[key] = typeof value[rawKey] === 'string'
        ? normalizeTextField(value[rawKey], CUSTOM_INSTRUCTIONS_MAX_CHARS)
        : '';
    }
    return result;
  }

  function normalizeStringListMap(value) {
    var result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return result;
    }
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      var rawKey = keys[i];
      var key = normalizeProjectPrefKey(rawKey);
      if (!key) {
        continue;
      }
      result[key] = normalizeStringList(value[rawKey]);
    }
    return result;
  }

  function normalizeGovernanceRulesMap(value) {
    var result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return result;
    }
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      var rawKey = keys[i];
      var key = normalizeProjectPrefKey(rawKey);
      if (!key) {
        continue;
      }
      var rules = value[rawKey] && typeof value[rawKey] === 'object' && !Array.isArray(value[rawKey])
        ? value[rawKey]
        : {};
      result[key] = {
        readonlyPatterns: normalizePatternList(rules.readonlyPatterns),
        writablePatterns: normalizePatternList(rules.writablePatterns),
        sensitiveCheckEnabled: rules.sensitiveCheckEnabled !== false,
        sensitiveConfirmAllowed: rules.sensitiveConfirmAllowed === true
      };
    }
    return result;
  }

  function normalizePatternList(value) {
    return normalizeStringList(value).map(function (pattern) {
      return pattern.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
    }).filter(Boolean);
  }

  function normalizeStringList(values) {
    var result = [];
    var seen = {};
    if (!Array.isArray(values)) {
      return result;
    }
    for (var i = 0; i < values.length; i++) {
      var text = typeof values[i] === 'string' ? values[i].trim() : '';
      if (!text || seen[text]) {
        continue;
      }
      seen[text] = true;
      result.push(text);
    }
    return result;
  }

  function normalizeSensitiveFindings(findings) {
    var result = [];
    if (!Array.isArray(findings)) {
      return result;
    }
    for (var i = 0; i < findings.length; i++) {
      var finding = findings[i] || {};
      result.push(removeEmptyFields({
        detectorId: typeof finding.detectorId === 'string' ? finding.detectorId : '',
        path: typeof finding.path === 'string' ? finding.path : '',
        source: typeof finding.source === 'string' ? finding.source : '',
        preview: summarizeTextForStorage(finding.preview, 'sensitive preview')
      }));
    }
    return result;
  }

  function summarizeVerificationObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    var summary = {
      state: normalizeTextField(value.state, 80),
      status: normalizeTextField(value.status, 80),
      ok: typeof value.ok === 'boolean' ? value.ok : undefined,
      errorCode: normalizeTextField(value.errorCode || value.code, 120),
      errorCategory: categorizeError(value.errorCode || value.code || value.reason || value.message || value.error)
    };
    if (value.diagnostics && typeof value.diagnostics === 'object' && !Array.isArray(value.diagnostics)) {
      summary.diagnostics = summarizeStatusObject(value.diagnostics);
    }
    return removeEmptySummaryFields(summary);
  }

  function summarizeStatusObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    return removeEmptySummaryFields({
      state: normalizeTextField(value.state, 80),
      status: normalizeTextField(value.status, 80),
      ok: typeof value.ok === 'boolean' ? value.ok : undefined,
      errorCode: normalizeTextField(value.errorCode || value.code, 120),
      errorCategory: categorizeError(value.errorCode || value.code || value.message || value.error)
    });
  }

  function normalizeSessionTitleForStorage(value, titleSource) {
    var title = typeof value === 'string' ? value.trim() : '';
    if (titleSource === 'manual') {
      return normalizeTextField(title === LEGACY_DEFAULT_SESSION_TITLE ? '' : title, SESSION_STORAGE_LIMITS.sessionTitleChars);
    }
    return normalizeTextField(title === LEGACY_DEFAULT_SESSION_TITLE ? '' : title, SESSION_STORAGE_LIMITS.sessionTitleChars);
  }

  function compactHistoryForStorage(history) {
    return (Array.isArray(history) ? history : [])
      .slice(-SESSION_STORAGE_LIMITS.maxHistory)
      .map(function (entry) {
        return {
          task: normalizeDisplayTextForStorage(entry && entry.task, SESSION_STORAGE_LIMITS.historyTaskChars),
          result: normalizeDisplayTextForStorage(entry && entry.result, SESSION_STORAGE_LIMITS.historyResultChars),
          at: typeof (entry && entry.at) === 'string' ? redactSecretLikeText(entry.at) : ''
        };
      });
  }

  function compactRunsForStorage(runs, options) {
    return StorageRunActions.compactRunsForStorage(
      runs,
      options,
      SESSION_STORAGE_LIMITS.maxRunsPerSession,
      compactRunForStorage
    );
  }

  function compactRunForStorage(run, keepActionPayload) {
    var actionPayload = StorageRunActions.compactRunActionPayload(run, keepActionPayload);
    var compact = {
      id: run.id,
      task: normalizeDisplayTextForStorage(run.task || 'untitled task', SESSION_STORAGE_LIMITS.taskChars),
      mode: typeof run.mode === 'string' ? redactSecretLikeText(run.mode) : '', ...StorageRunActions.compactProviderSnapshot(run),
      model: normalizeTextField(run.model, 80),
      reasoningEffort: typeof run.reasoningEffort === 'string' ? redactSecretLikeText(run.reasoningEffort) : '',
      speedTier: typeof run.speedTier === 'string' ? redactSecretLikeText(run.speedTier) : '',
      status: normalizeRunStatus(run.status),
      statusText: normalizeDisplayTextForStorage(run.statusText, SESSION_STORAGE_LIMITS.statusTextChars),
      runProjectId: normalizeProjectPrefKey(run.runProjectId),
      startedAt: typeof run.startedAt === 'string' ? redactSecretLikeText(run.startedAt) : '',
      finishedAt: typeof run.finishedAt === 'string' ? redactSecretLikeText(run.finishedAt) : '',
      events: compactRunEventsForStorage(run.events),
      attachments: compactRunAttachmentsForStorage(run.attachments),
      appliedOperations: actionPayload.appliedOperations,
      undoOperations: actionPayload.undoOperations,
      undoBaseFiles: actionPayload.undoBaseFiles,
      undoTrackedChanges: actionPayload.undoTrackedChanges,
      undoExpectedFiles: actionPayload.undoExpectedFiles,
      undoStatus: normalizeDisplayTextForStorage(run.undoStatus, SESSION_STORAGE_LIMITS.statusTextChars),
      nativeRequestId: normalizeTextField(run.nativeRequestId, 160),
      codexTurnId: normalizeTextField(run.codexTurnId, 160),
      nativeEventSeq: Number.isFinite(Number(run.nativeEventSeq)) ? Number(run.nativeEventSeq) : 0,
      queueItemId: normalizeTextField(run.queueItemId, 160)
    };
    if (run.interruptedDraft && typeof run.interruptedDraft === 'object') {
      compact.interruptedDraft = {
        requestId: normalizeTextField(run.interruptedDraft.requestId, 160),
        threadId: normalizeTextField(run.interruptedDraft.threadId, 160),
        turnId: normalizeTextField(run.interruptedDraft.turnId, 160),
        lastEventSeq: Number.isFinite(Number(run.interruptedDraft.lastEventSeq))
          ? Number(run.interruptedDraft.lastEventSeq)
          : 0,
        reason: normalizeTextField(run.interruptedDraft.reason, 80)
      };
    }
    if (VALID_TRACKED_CHANGE_STATUSES[run.trackedChangeStatus] === true) {
      compact.trackedChangeStatus = run.trackedChangeStatus;
    }
    var settlement = run.settlement && typeof run.settlement === 'object'
      ? run.settlement
      : run.settlementFacts;
    if (settlement && typeof settlement === 'object') {
      compact.settlement = compactStructuredEventValueForStorage(SettlementFacts.compactSettlementFacts(settlement), 0);
    }
    return compact;
  }

  function compactRunEventsForStorage(events) {
    return (Array.isArray(events) ? events : [])
      .filter(function (event) { return event && typeof event.title === 'string'; })
      .slice(-SESSION_STORAGE_LIMITS.maxEventsPerRun)
      .map(function (event) {
        var compact = {
          title: normalizeDisplayTextForStorage(event.title, SESSION_STORAGE_LIMITS.eventTitleChars) || 'Event',
          status: normalizeEventStatus(event.status),
          timestamp: typeof event.timestamp === 'string' ? redactSecretLikeText(event.timestamp) : '',
          kind: typeof event.kind === 'string' ? redactSecretLikeText(event.kind) : 'activity',
          streamKey: typeof event.streamKey === 'string' ? redactSecretLikeText(event.streamKey) : '',
          streamRole: typeof event.streamRole === 'string' ? redactSecretLikeText(event.streamRole) : ''
        };
        if (event.subagent === true) {
          compact.subagent = true;
        }
        var detail = compactDisplayDetailForStorage(event.detail, getEventDetailLimit(event));
        if (detail !== undefined) {
          compact.detail = detail;
        }
        // Preserve the structured completion-report payload + structured
        // failure with their object shape intact (the generic detail
        // compactor would redact unknown objects to a {redacted,hash}
        // summary). Without this the report re-renders flat on reload —
        // Write result / Undo / Next no longer demote into the muted meta
        // block — and the recovery action button disappears.
        if (event.detailStructured) {
          compact.detailStructured = compactStructuredEventValueForStorage(event.detailStructured, 0);
        }
        if (event.failure) {
          compact.failure = compactStructuredEventValueForStorage(event.failure, 0);
        }
        return compact;
      });
  }

  // Deep-copies a known-safe structured event value (the completion-report
  // {conclusion, body, meta[]} payload, or a FailureReason object) preserving
  // its shape while redacting + truncating every string field. Bounded depth +
  // breadth so a pathological value can't blow up the stored record.
  function compactStructuredEventValueForStorage(value, depth) {
    return StorageRunActions.compactStructuredEventValue(value, {
      normalizeString: function (text) {
        return normalizeDisplayTextForStorage(text, SESSION_STORAGE_LIMITS.reportDetailChars);
      }
    }, depth);
  }

  function getEventDetailLimit(event) {
    return event && event.kind === 'report'
      ? SESSION_STORAGE_LIMITS.reportDetailChars
      : SESSION_STORAGE_LIMITS.detailChars;
  }

  function compactDetailForStorage(detail, maxChars) {
    if (detail === undefined) {
      return undefined;
    }
    if (typeof detail === 'string') {
      return summarizeTextForStorage(detail, 'detail');
    }
    if (detail === null || typeof detail === 'number' || typeof detail === 'boolean') {
      return detail;
    }
    return summarizeStructuredValueForStorage(detail, maxChars);
  }

  function compactDisplayDetailForStorage(detail, maxChars) {
    if (detail === undefined) {
      return undefined;
    }
    if (typeof detail === 'string') {
      return normalizeDisplayTextForStorage(detail, maxChars);
    }
    if (detail === null || typeof detail === 'number' || typeof detail === 'boolean') {
      return detail;
    }
    return summarizeStructuredValueForStorage(detail, maxChars);
  }

  function normalizeDisplayTextForStorage(value, maxChars) {
    return normalizeTextField(value, maxChars);
  }

  function summarizeStructuredValueForStorage(value, maxChars) {
    if (isStructuredStorageSummary(value)) {
      return normalizeStructuredStorageSummary(value);
    }
    var serialized = safeJsonStringify(value);
    var summary = {
      redacted: true,
      type: Array.isArray(value) ? 'array' : 'object',
      chars: serialized.length,
      hash: hashString(serialized)
    };
    var paths = collectPathMetadata(value, maxChars);
    if (paths.items.length) {
      summary.paths = paths.items;
      summary.pathCount = paths.count;
    }
    return summary;
  }

  function normalizeStructuredStorageSummary(value) {
    var result = {
      redacted: true,
      type: value.type === 'array' ? 'array' : 'object',
      chars: nonNegativeInteger(value.chars),
      hash: /^[a-f0-9]{8}$/.test(String(value.hash || '')) ? value.hash : hashString('')
    };
    var paths = normalizePathList(value.paths).slice(0, 5);
    if (paths.length) {
      result.paths = paths;
      result.pathCount = nonNegativeInteger(value.pathCount) || paths.length;
    }
    return result;
  }

  function collectPathMetadata(value, maxChars, state) {
    state = state || { seen: {}, items: [], count: 0 };
    if (!value || typeof value !== 'object') {
      return state;
    }
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        collectPathMetadata(value[i], maxChars, state);
      }
      return state;
    }
    var keys = Object.keys(value);
    for (var j = 0; j < keys.length; j++) {
      var key = keys[j];
      var item = value[key];
      if (/(^|[A-Z_])path$/i.test(key) && typeof item === 'string') {
        var path = normalizePath(item, Math.min(maxChars || SESSION_STORAGE_LIMITS.pathChars, SESSION_STORAGE_LIMITS.pathChars));
        if (path) {
          state.count += 1;
          if (!state.seen[path] && state.items.length < 5) {
            state.seen[path] = true;
            state.items.push(path);
          }
        }
      } else {
        collectPathMetadata(item, maxChars, state);
      }
    }
    return state;
  }

  function compactRunAttachmentsForStorage(attachments) {
    var result = [];
    var items = Array.isArray(attachments) ? attachments : [];
    for (var i = 0; i < items.length; i++) {
      var attachment = items[i] || {};
      var name = normalizeAttachmentName(attachment.name);
      if (!name) {
        continue;
      }
      var mimeType = normalizeTextField(attachment.mimeType, 120);
      var size = Number(attachment.size);
      var kind = attachment.kind === 'image' || /^image\//i.test(mimeType) ? 'image' : 'file';
      result.push({
        name: name,
        mimeType: mimeType,
        size: Number.isFinite(size) && size >= 0 ? Math.round(size) : 0,
        kind: kind
      });
      if (result.length >= SESSION_STORAGE_LIMITS.maxAttachmentsPerRun) {
        break;
      }
    }
    return result;
  }

  function normalizeAttachmentName(value) {
    return normalizeTextField(String(value || '')
      .replace(/\0/g, '')
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .pop() || '', 180);
  }

  function normalizePathList(values) {
    var result = [];
    var seen = {};
    if (!Array.isArray(values)) {
      return result;
    }
    for (var i = 0; i < values.length; i++) {
      var path = normalizePath(values[i], SESSION_STORAGE_LIMITS.pathChars);
      if (!path || seen[path]) {
        continue;
      }
      seen[path] = true;
      result.push(path);
    }
    return result;
  }

  function normalizePath(value, maxChars) {
    return normalizeTextField(String(value || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+/g, '/')
      .trim(), maxChars || SESSION_STORAGE_LIMITS.pathChars);
  }

  function normalizeRunStatus(status) {
    // Welcome-panel + write-guard: the run-status
    // enum gained three post-navigation values. The storage normalizer must
    // accept them so a settled run round-trips intact through `buildSessionRecord`.
    // Unknown legacy values fall through to `completed` (the historical default).
    return [
      'pending',
      'running',
      'completed',
      'failed',
      'background_completed',
      'needs_review_after_navigation',
      'abandoned_after_navigation',
      // v1.8.1: reload-orphaned runs settle to 'interrupted' (v1.7.6); the
      // storage round-trip must not rewrite them to a false 'completed'.
      'interrupted'
    ].indexOf(status) !== -1 ? status : 'completed';
  }

  function normalizeEventStatus(status) {
    return VALID_EVENT_STATUSES[status] ? status : 'info';
  }

  function normalizeFileSummaries(files) {
    var result = [];
    if (!Array.isArray(files)) {
      return result;
    }
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (typeof file === 'string') {
        result.push({ path: file });
        continue;
      }
      file = file || {};
      result.push(removeEmptyFields({
        path: typeof file.path === 'string' ? file.path : '',
        destinationPath: typeof file.destinationPath === 'string' ? file.destinationPath : '',
        type: typeof file.type === 'string' ? file.type : '',
        reason: typeof file.reason === 'string' ? file.reason : '',
        status: typeof file.status === 'string' ? file.status : '',
        size: Number.isFinite(Number(file.size)) ? Number(file.size) : undefined
      }));
    }
    return result;
  }

  function normalizeDiffSummary(summary) {
    summary = summary && typeof summary === 'object' ? summary : {};
    return {
      filesChanged: nonNegativeInteger(summary.filesChanged),
      additions: nonNegativeInteger(summary.additions),
      deletions: nonNegativeInteger(summary.deletions),
      binaryFilesChanged: nonNegativeInteger(summary.binaryFilesChanged)
    };
  }

  function normalizeProjectPrefKey(value) {
    var key = typeof value === 'string' ? value.trim() : '';
    if (!key) {
      return '';
    }
    return normalizeTextField(key, PROJECT_PREF_KEY_MAX_CHARS);
  }

  function summarizeTextForStorage(value, label) {
    if (typeof value !== 'string' || !value.trim()) {
      return '';
    }
    var text = redactSecretLikeText(value);
    if (isOmittedStorageSummary(text)) {
      return text;
    }
    return '[' + label + ' omitted; chars=' + text.length + '; hash=' + hashString(text) + ']';
  }

  function isOmittedStorageSummary(value) {
    return /^\[[^\]]+ omitted; chars=\d+; hash=[a-f0-9]{8}\]$/.test(String(value || '').trim());
  }

  function isStructuredStorageSummary(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value)
      && value.redacted === true
      && (value.type === 'array' || value.type === 'object')
      && Number.isFinite(Number(value.chars))
      && /^[a-f0-9]{8}$/.test(String(value.hash || '')));
  }

  function redactSecretLikeText(value) {
    if (typeof value !== 'string') {
      return '';
    }
    var redacted = value;
    for (var i = 0; i < SECRET_REDACTION_PATTERNS.length; i++) {
      var pattern = SECRET_REDACTION_PATTERNS[i];
      pattern.lastIndex = 0;
      redacted = redacted.replace(pattern, REDACTED_SECRET);
    }
    return redacted;
  }

  function normalizeTextField(value, maxChars) {
    var text = sanitizeAssistantVisibleText(value);
    if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
      return text;
    }
    return text.slice(0, Math.max(0, maxChars - 1)) + '…';
  }

  function sanitizeAssistantVisibleText(value) {
    if (typeof value !== 'string' || !value) {
      return '';
    }
    var text = redactSecretLikeText(value);
    if (!mightContainLocalReferenceText(text)) {
      return text;
    }
    return sanitizeLocalReferencesForStorage(text);
  }

  function mightContainLocalReferenceText(value) {
    return /(?:file:\/\/\/?|[A-Za-z]:[\\/]|\/(?:Users|home|root|private|var|tmp|Volumes|etc|opt|usr|srv|mnt|media)\/|[\\/]\.codex-overleaf[\\/]projects[\\/]|\.codex-overleaf[\\/]projects[\\/])/i.test(String(value || ''));
  }

  function sanitizeLocalReferencesForStorage(value) {
    return String(value || '')
      .replace(/\[([^\]]*)\]\(([^)]*)\)/g, function (_raw, label, target) {
        var safeLabel = sanitizeBareLocalPaths(label, false);
        var trimmedTarget = String(target || '').trim();
        if (/^https?:\/\//i.test(trimmedTarget)) {
          return '[' + safeLabel + '](' + sanitizeHttpTarget(trimmedTarget) + ')';
        }
        if (mightContainLocalReferenceText(trimmedTarget)) {
          return '[' + safeLabel + ']';
        }
        return '[' + safeLabel + '](' + sanitizeBareLocalPaths(trimmedTarget, false) + ')';
      })
      .replace(/(?:file:\/\/\/?[^\s)\]]+|[A-Za-z]:[\\/][^\s)\]]+|\/(?:Users|home|root|private|var|tmp|Volumes|etc|opt|usr|srv|mnt|media)\/[^\s)\]]+|[^\s)\]]*[\\/]\.codex-overleaf[\\/]projects[\\/][^\s)\]]+)/gi, function (rawPath) {
        return formatLocalPathPlaceholder(rawPath, true);
      });
  }

  function sanitizeBareLocalPaths(value, includeBrackets) {
    return String(value || '').replace(/(?:file:\/\/\/?[^\s)\]]+|[A-Za-z]:[\\/][^\s)\]]+|\/(?:Users|home|root|private|var|tmp|Volumes|etc|opt|usr|srv|mnt|media)\/[^\s)\]]+|[^\s)\]]*[\\/]\.codex-overleaf[\\/]projects[\\/][^\s)\]]+)/gi, function (rawPath) {
      return formatLocalPathPlaceholder(rawPath, includeBrackets);
    });
  }

  function sanitizeHttpTarget(value) {
    try {
      var parsed = new URL(value);
      if (mightContainLocalReferenceText(parsed.href)) {
        parsed.search = '';
        parsed.hash = '';
      }
      return parsed.href;
    } catch (_error) {
      return '';
    }
  }

  function formatLocalPathPlaceholder(rawPath, includeBrackets) {
    var lineMatch = String(rawPath || '').match(/:(\d+)(?::\d+)?(?:[.,;!?])?$/);
    var value = lineMatch ? 'local path:' + lineMatch[1] : 'local path';
    return includeBrackets ? '[' + value + ']' : value;
  }

  function nonNegativeInteger(value) {
    var number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  }

  function categorizeError(value) {
    var text = redactSecretLikeText(typeof value === 'string' ? value : '').toLowerCase();
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

  function removeEmptySummaryFields(value) {
    var result = {};
    var keys = Object.keys(value || {});
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var item = value[key];
      if (item === undefined || item === '' || item === null) {
        continue;
      }
      if (Array.isArray(item) && item.length === 0) {
        continue;
      }
      if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 0) {
        continue;
      }
      result[key] = item;
    }
    return result;
  }

  function removeEmptyFields(value) {
    var result = {};
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (value[key] !== undefined && value[key] !== '') {
        result[key] = value[key];
      }
    }
    return result;
  }

  // Welcome-panel + write-guard: the Recent-projects
  // dashboard variant calls `listRecentProjectsAcrossAccount` to get the
  // sorted, deduped, capped list of projects in the current account scope.
  //
  // Contract (spec §5.6.1):
  //   Input:  { accountScopeId: string, limit?: number = 10 }
  //   Output: Array<{ projectId, lastActivityAt, safeTaskSummary, primaryStatusBadge }>
  //
  // Fail-closed: if `accountScopeId` is falsy, returns `[]`. This is the
  // privacy floor — degraded mode must never leak across accounts.
  //
  // Implementation: full scan of the sessions store, group by `projectId`,
  // keep the row with the largest `lastActivityAt`, sort desc, cap at
  // `limit`. Full scan is acceptable for v1 given the small session count
  // (max ~12 per project × small number of projects). A future index on
  // `accountScopeId + lastActivityAt` is possible without a contract change.
  function listRecentProjectsAcrossAccount(options) {
    var accountScopeId = options && options.accountScopeId;
    var limit = options && Number.isFinite(options.limit) ? options.limit : 10;
    if (!accountScopeId) {
      return Promise.resolve([]);
    }
    return getAllSessions().then(function (all) {
      return filterRecentProjectsAcrossAccount(all, {
        accountScopeId: accountScopeId,
        limit: limit,
        deletedSessionIdsByProject: options && options.deletedSessionIdsByProject
      });
    });
  }

  // Pure helper extracted from `listRecentProjectsAcrossAccount` so the
  // filtering / dedupe / sort / cap behavior can be tested without an
  // IndexedDB stub. Same contract as the async wrapper; takes the raw session
  // records as an array instead of opening the database.
  function filterRecentProjectsAcrossAccount(sessions, options) {
    var accountScopeId = options && options.accountScopeId;
    var limit = options && Number.isFinite(options.limit) ? options.limit : 10;
    var deletedSessionIdsByProject = options && options.deletedSessionIdsByProject;
    if (!accountScopeId) {
      return [];
    }
    var byProject = {}; // projectId → session
    var sessionCounts = {}; // projectId → number of sessions
    var all = Array.isArray(sessions) ? sessions : [];
    for (var i = 0; i < all.length; i++) {
      var s = all[i];
      if (!s) continue;
      if (s.accountScopeId !== accountScopeId) continue;
      if (deletedSessionIdsByProject && Array.isArray(deletedSessionIdsByProject[s.projectId])
        && deletedSessionIdsByProject[s.projectId].indexOf(s.id) !== -1) continue;
      if (typeof s.lastActivityAt !== 'string' || !s.lastActivityAt) continue;
      if (!isValidOverleafProjectId(s.projectId)) continue;
      var prev = byProject[s.projectId];
      if (!prev || prev.lastActivityAt < s.lastActivityAt) {
        byProject[s.projectId] = s;
      }
      // v1.8.1: the per-project session count was computed here and thrown
      // away — keep it so dashboard rows can show how much work lives in a
      // project without a second scan.
      sessionCounts[s.projectId] = (sessionCounts[s.projectId] || 0) + 1;
    }
    var survivors = [];
    var keys = Object.keys(byProject);
    for (var j = 0; j < keys.length; j++) {
      survivors.push(byProject[keys[j]]);
    }
    survivors.sort(function (a, b) {
      return b.lastActivityAt.localeCompare(a.lastActivityAt);
    });
    var rows = [];
    for (var k = 0; k < survivors.length && k < limit; k++) {
      var session = survivors[k];
      rows.push({
        projectId: session.projectId,
        lastActivityAt: session.lastActivityAt,
        safeTaskSummary: typeof session.safeTaskSummary === 'string' ? session.safeTaskSummary : '',
        primaryStatusBadge: derivePrimaryStatusBadge(session),
        sessionCount: sessionCounts[session.projectId] || 1
      });
    }
    return rows;
  }

  function isValidOverleafProjectId(value) {
    return typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
  }

  // Per spec §5.10:
  //   1. trackedChangeStatus if set (pending/accepted/rejected/needs_review)
  //   2. else run status (running/completed/failed/background_completed/
  //                       needs_review_after_navigation/abandoned_after_navigation)
  //   3. fallback `pending`.
  function derivePrimaryStatusBadge(session) {
    var runs = session && Array.isArray(session.runs) ? session.runs : [];
    if (!runs.length) return 'pending';
    var latestRun = runs[runs.length - 1];
    if (!latestRun) return 'pending';
    if (typeof latestRun.trackedChangeStatus === 'string' && latestRun.trackedChangeStatus) {
      return latestRun.trackedChangeStatus;
    }
    if (typeof latestRun.status === 'string' && latestRun.status) {
      return latestRun.status;
    }
    return 'pending';
  }

  // Full scan of the sessions store, used by the cross-project query above.
  // We deliberately do not go through `getAllByIndex` because the existing
  // session indexes are keyed by `projectId` / `updatedAt` — neither matches
  // the account-scope filter. A direct `getAll` over the whole store is the
  // simplest correct read.
  function getAllSessions() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('sessions', 'readonly');
        var store = tx.objectStore('sessions');
        var request = store.getAll();
        request.onsuccess = function (event) { resolve(event.target.result || []); };
        request.onerror = function (event) { reject(event.target.error); };
      });
    });
  }

  function buildActiveSessionByProject(existing, projectId, sessionId) {
    var result = {};
    if (existing && typeof existing === 'object') {
      var keys = Object.keys(existing);
      for (var i = 0; i < keys.length; i++) {
        result[keys[i]] = existing[keys[i]];
      }
    }
    if (typeof projectId === 'string' && projectId) {
      result[projectId] = sessionId || '';
    }
    return result;
  }

  function createEventBuffer(turnId, flushIntervalMs, maxBatchSize) {
    if (flushIntervalMs === undefined) { flushIntervalMs = 500; }
    if (maxBatchSize === undefined) { maxBatchSize = 20; }

    var buffer = [];
    var timer = null;

    function scheduleFlush() {
      if (timer !== null) { return; }
      timer = setTimeout(function () {
        timer = null;
        flush();
      }, flushIntervalMs);
    }

    function flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (buffer.length === 0) { return Promise.resolve([]); }
      var batch = buffer.splice(0);
      return putRecords('events', batch);
    }

    function add(event) {
      var record = buildEventRecord(Object.assign({}, event, { turnId: turnId }));
      buffer.push(record);
      if (buffer.length >= maxBatchSize) {
        flush();
      } else {
        scheduleFlush();
      }
      return record;
    }

    return { add: add, flush: flush };
  }

  // --- Utilities ---
  function generateId(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }
  function safeJsonStringify(value) {
    try {
      return JSON.stringify(value) || '';
    } catch (_error) {
      return '[unserializable]';
    }
  }
  var hashString = StorageRunActions.hashString;

  return {
    TARGET_SCHEMA_VERSION: TARGET_SCHEMA_VERSION,
    DB_NAME: DB_NAME,
    STORES: STORES,
    openDb: openDb,
    putRecord: putRecord,
    putRecords: putRecords,
    getRecord: getRecord,
    getAllByIndex: getAllByIndex,
    claimSessionsForAccount: claimSessionsForAccount,
    deleteRecord: deleteRecord,
    deleteByIndex: deleteByIndex,
    clearStore: clearStore,
    clearAllStores: clearAllStores,
    buildSessionRecord: buildSessionRecord,
    buildTurnRecord: buildTurnRecord,
    buildEventRecord: buildEventRecord,
    buildArtifactRecord: buildArtifactRecord,
    buildAuditLogRecord: buildAuditLogRecord,
    extractLightweightPrefs: extractLightweightPrefs,
    buildActiveSessionByProject: buildActiveSessionByProject,
    createEventBuffer: createEventBuffer,
    listRecentProjectsAcrossAccount: listRecentProjectsAcrossAccount,
    filterRecentProjectsAcrossAccount: filterRecentProjectsAcrossAccount,
    derivePrimaryStatusBadge: derivePrimaryStatusBadge,
    getAllSessions: getAllSessions
  };
});
