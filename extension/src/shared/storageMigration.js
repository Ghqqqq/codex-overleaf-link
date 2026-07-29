(function initStorageMigration(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./storageDb'));
  } else {
    root.CodexOverleafModuleRegistry.define('StorageMigration', ['StorageDb'], factory);
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function storageMigrationFactory(StorageDb) {
  'use strict';

  var PREFS_KEY = 'codexOverleafPrefs';
  var SESSION_TOMBSTONES_KEY = 'codexOverleafSessionTombstones';
  var SESSION_TOMBSTONE_ENTRY_PREFIX = 'codexOverleafSessionTombstone:v2:';
  var MAX_DELETED_SESSION_IDS_PER_PROJECT = 100;
  var CUSTOM_INSTRUCTIONS_MAX_CHARS = 12000;
  var PROJECT_PREF_KEY_MAX_CHARS = 160;
  var PROJECT_SCOPED_PREF_MAPS = [
    'activeSessionByProject',
    'experimentalOtByProject',
    'customInstructionsByProject',
    'governanceRulesByProject',
    'selectedLocalSkillIdsByProject'
  ];
  var projectPreferenceLockTails = {};

  function buildScopedProjectPreferenceKey(accountScopeId, projectId) {
    var account = compactScopePart(accountScopeId);
    var project = compactScopePart(projectId);
    return account && project ? 'account:' + account + ':project:' + project : '';
  }

  function compactScopePart(value) {
    var text = normalizeTextField(value, PROJECT_PREF_KEY_MAX_CHARS);
    if (!text) {
      return '';
    }
    var encoded = encodeURIComponent(text);
    if (encoded.length <= 64) {
      return encoded;
    }
    return encoded.slice(0, 48) + '-' + hashText(encoded);
  }

  function hashText(value) {
    var hash = 2166136261;
    for (var i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function withProjectPreferenceLock(projectId, work) {
    var lockName = 'codex-overleaf-project-prefs:' + compactScopePart(projectId);
    var lockManager = typeof navigator !== 'undefined' && navigator && navigator.locks;
    if (lockManager && typeof lockManager.request === 'function') {
      return lockManager.request(lockName, work);
    }
    var previous = projectPreferenceLockTails[lockName] || Promise.resolve();
    var current = previous.then(work, work);
    projectPreferenceLockTails[lockName] = current;
    return current.finally(function () {
      if (projectPreferenceLockTails[lockName] === current) {
        delete projectPreferenceLockTails[lockName];
      }
    });
  }

  function copyPreferenceValue(value) {
    if (!value || typeof value !== 'object') {
      return value;
    }
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_error) {
      return value;
    }
  }

  function claimLegacyProjectPreferences(prefs, accountScopeId, projectId) {
    var scopedKey = buildScopedProjectPreferenceKey(accountScopeId, projectId);
    var next = normalizePrefs(prefs);
    var changed = false;
    PROJECT_SCOPED_PREF_MAPS.forEach(function (mapName) {
      var source = next[mapName] && typeof next[mapName] === 'object'
        ? Object.assign({}, next[mapName])
        : {};
      if (Object.prototype.hasOwnProperty.call(source, projectId)) {
        if (!Object.prototype.hasOwnProperty.call(source, scopedKey)) {
          source[scopedKey] = copyPreferenceValue(source[projectId]);
        }
        delete source[projectId];
        changed = true;
      }
      next[mapName] = source;
    });
    return { prefs: next, changed: changed };
  }

  function buildProjectPreferenceView(prefs, accountScopeId, projectId) {
    var source = normalizePrefs(prefs);
    var scopedKey = buildScopedProjectPreferenceKey(accountScopeId, projectId);
    var view = Object.assign({}, source);
    PROJECT_SCOPED_PREF_MAPS.forEach(function (mapName) {
      var sourceMap = source[mapName] && typeof source[mapName] === 'object'
        ? source[mapName]
        : {};
      var projectMap = {};
      if (Object.prototype.hasOwnProperty.call(sourceMap, scopedKey)) {
        projectMap[projectId] = copyPreferenceValue(sourceMap[scopedKey]);
      }
      view[mapName] = projectMap;
    });
    return normalizePrefs(view);
  }

  function mergeScopedProjectPreferences(existingPrefs, incomingPrefs, accountScopeId, projectId) {
    var existing = normalizePrefs(existingPrefs);
    var incoming = normalizePrefs(incomingPrefs);
    var scopedKey = buildScopedProjectPreferenceKey(accountScopeId, projectId);
    var next = Object.assign({}, existing, incoming);
    PROJECT_SCOPED_PREF_MAPS.forEach(function (mapName) {
      var storedMap = existing[mapName] && typeof existing[mapName] === 'object'
        ? Object.assign({}, existing[mapName])
        : {};
      var incomingMap = incoming[mapName] && typeof incoming[mapName] === 'object'
        ? incoming[mapName]
        : {};
      if (Object.prototype.hasOwnProperty.call(incomingMap, projectId)) {
        storedMap[scopedKey] = copyPreferenceValue(incomingMap[projectId]);
      }
      delete storedMap[projectId];
      next[mapName] = storedMap;
    });
    return normalizePrefs(next);
  }

  function runMigrationIfNeeded(projectId, legacyStorageKey, accountScopeId) {
    projectId = normalizeProjectPrefKey(projectId);
    var normalizedAccountScopeId = normalizeTextField(accountScopeId, PROJECT_PREF_KEY_MAX_CHARS);
    if (!normalizedAccountScopeId || !projectId) {
      return Promise.resolve({
        prefs: normalizePrefs({}),
        sessions: [],
        activeSessionId: '',
        migrated: false,
        reason: 'account_scope_unavailable'
      });
    }
    return withProjectPreferenceLock(projectId, function () {
      return chrome.storage.local.get(null).then(function (stored) {
        var claimed = claimLegacyProjectPreferences(
          stored[PREFS_KEY] || {},
          normalizedAccountScopeId,
          projectId
        );
        var storedPrefs = claimed.prefs;
        var persistClaim = claimed.changed
          ? chrome.storage.local.set({ [PREFS_KEY]: storedPrefs })
          : Promise.resolve();
        return persistClaim.then(function () {
          var prefs = buildProjectPreferenceView(
            storedPrefs,
            normalizedAccountScopeId,
            projectId
          );
          var tombstones = collectSessionTombstones(stored);
          var deletedSessionIds = getDeletedSessionIds(tombstones, projectId);
          var schemaVersion = prefs.storageSchemaVersion || 0;

          if (schemaVersion >= StorageDb.TARGET_SCHEMA_VERSION) {
            var activeSessionByProject = prefs.activeSessionByProject || {};
            var activeSessionId = activeSessionByProject[projectId] || '';
            if (typeof StorageDb.claimSessionsForAccount !== 'function') {
              return Promise.reject(Object.assign(
                new Error('Atomic legacy-session claiming is unavailable.'),
                { code: 'scoped_claim_unavailable' }
              ));
            }
            return StorageDb.claimSessionsForAccount(
              projectId,
              normalizedAccountScopeId,
              deletedSessionIds
            ).then(function (visibleSessions) {
              var visibleActiveSessionId = visibleSessions.some(function (session) {
                return session && session.id === activeSessionId;
              })
                ? activeSessionId
                : visibleSessions.length
                  ? visibleSessions[visibleSessions.length - 1].id
                  : '';
              return {
                prefs: prefs,
                sessions: visibleSessions,
                activeSessionId: visibleActiveSessionId,
                migrated: false
              };
            });
          }

          // Migration v0 → v1
          var legacyBlob = stored[legacyStorageKey] || {};
          var legacySessions = Array.isArray(legacyBlob.sessions) ? legacyBlob.sessions : [];
          var migratedSessions = [];

          for (var i = 0; i < legacySessions.length; i++) {
            var legacy = legacySessions[i];
            if (!legacy || !legacy.id) { continue; }
            if (deletedSessionIds.indexOf(legacy.id) !== -1) { continue; }
            var record = StorageDb.buildSessionRecord(
              buildLegacySessionRecordInput(projectId, legacyBlob, legacy, normalizedAccountScopeId)
            );
            migratedSessions.push(record);
          }

          var putPromise = migratedSessions.length
            ? StorageDb.putRecords('sessions', migratedSessions)
            : Promise.resolve([]);

          return putPromise.then(function () {
            var newPrefs = StorageDb.extractLightweightPrefs(legacyBlob, projectId);
            newPrefs.activeSessionByProject = StorageDb.buildActiveSessionByProject(
              {},
              projectId,
              legacyBlob.activeSessionId || (migratedSessions.length ? migratedSessions[migratedSessions.length - 1].id : '')
            );
            var mergedPrefs = mergeScopedProjectPreferences(
              storedPrefs,
              newPrefs,
              normalizedAccountScopeId,
              projectId
            );
            var prefsView = buildProjectPreferenceView(
              mergedPrefs,
              normalizedAccountScopeId,
              projectId
            );

            return chrome.storage.local.set({ [PREFS_KEY]: mergedPrefs }).then(function () {
              return chrome.storage.local.remove(legacyStorageKey).catch(function () {});
            }).then(function () {
              return {
                prefs: prefsView,
                sessions: migratedSessions,
                activeSessionId: prefsView.activeSessionByProject[projectId] || '',
                migrated: true
              };
            });
          });
        });
      });
    });
  }

  function buildLegacySessionRecordInput(projectId, legacyBlob, legacy, accountScopeId) {
    return {
      id: legacy.id,
      projectId: projectId,
      accountScopeId: accountScopeId,
      title: legacy.title || '',
      titleSource: legacy.titleSource === 'manual' ? 'manual' : 'auto',
      codexThreadId: '',
      status: 'active',
      focusFiles: Array.isArray(legacy.focusFiles) ? legacy.focusFiles : [],
      history: Array.isArray(legacy.history) ? legacy.history : [],
      runs: Array.isArray(legacy.runs) ? legacy.runs : [],
      task: typeof legacy.task === 'string' ? legacy.task : '',
      mode: typeof legacy.mode === 'string' ? legacy.mode : legacyBlob.mode || '',
      providerId: typeof legacy.providerId === 'string' && legacy.providerId ? legacy.providerId : 'builtin',
      model: typeof legacy.model === 'string' ? legacy.model : legacyBlob.model || '',
      reasoningEffort: typeof legacy.reasoningEffort === 'string' ? legacy.reasoningEffort : legacyBlob.reasoningEffort || '',
      speedTier: typeof legacy.speedTier === 'string' ? legacy.speedTier : legacyBlob.speedTier || '',
      requireReviewing: legacy.requireReviewing !== false && legacyBlob.requireReviewing !== false,
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt
    };
  }

  function savePrefs(prefs, accountScopeId, projectId) {
    var account = normalizeTextField(accountScopeId, PROJECT_PREF_KEY_MAX_CHARS);
    var project = normalizeProjectPrefKey(projectId);
    if (!account && !project) {
      return chrome.storage.local.set({ [PREFS_KEY]: normalizePrefs(prefs) });
    }
    if (!account || !project) {
      return Promise.reject(Object.assign(
        new Error('Scoped project preferences require account and project identity.'),
        { code: 'account_scope_unavailable' }
      ));
    }
    return withProjectPreferenceLock(project, function () {
      return chrome.storage.local.get([PREFS_KEY]).then(function (stored) {
        var claimed = claimLegacyProjectPreferences(stored[PREFS_KEY] || {}, account, project);
        var next = mergeScopedProjectPreferences(claimed.prefs, prefs, account, project);
        return chrome.storage.local.set({ [PREFS_KEY]: next });
      });
    });
  }

  function loadPrefs(accountScopeId, projectId) {
    var account = normalizeTextField(accountScopeId, PROJECT_PREF_KEY_MAX_CHARS);
    var project = normalizeProjectPrefKey(projectId);
    if (!account && !project) {
      return chrome.storage.local.get([PREFS_KEY]).then(function (stored) {
        return normalizePrefs(stored[PREFS_KEY] || {});
      });
    }
    if (!account || !project) {
      return Promise.reject(Object.assign(
        new Error('Scoped project preferences require account and project identity.'),
        { code: 'account_scope_unavailable' }
      ));
    }
    return withProjectPreferenceLock(project, function () {
      return chrome.storage.local.get([PREFS_KEY]).then(function (stored) {
        var claimed = claimLegacyProjectPreferences(stored[PREFS_KEY] || {}, account, project);
        var persisted = claimed.changed
          ? chrome.storage.local.set({ [PREFS_KEY]: claimed.prefs })
          : Promise.resolve();
        return persisted.then(function () {
          return buildProjectPreferenceView(claimed.prefs, account, project);
        });
      });
    });
  }

  function normalizeDeletedSessionIdsByProject(value) {
    var result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return result;
    }
    Object.keys(value).forEach(function (rawProjectId) {
      var projectId = normalizeProjectPrefKey(rawProjectId);
      if (!projectId || !Array.isArray(value[rawProjectId])) {
        return;
      }
      var seen = {};
      var ids = value[rawProjectId].map(function (id) {
        return normalizeTextField(id, PROJECT_PREF_KEY_MAX_CHARS);
      }).filter(function (id) {
        if (!id || seen[id]) { return false; }
        seen[id] = true;
        return true;
      }).slice(-MAX_DELETED_SESSION_IDS_PER_PROJECT);
      if (ids.length) {
        result[projectId] = ids;
      }
    });
    return result;
  }

  function getDeletedSessionIds(tombstones, projectId) {
    var normalized = normalizeDeletedSessionIdsByProject(tombstones);
    var key = normalizeProjectPrefKey(projectId);
    return key && Array.isArray(normalized[key]) ? normalized[key].slice() : [];
  }

  function loadSessionTombstones() {
    return chrome.storage.local.get(null).then(function (stored) {
      return collectSessionTombstones(stored);
    });
  }

  function addSessionTombstones(projectId, sessionIds) {
    var key = normalizeProjectPrefKey(projectId);
    if (!key) {
      return loadSessionTombstones();
    }
    var incoming = (Array.isArray(sessionIds) ? sessionIds : [])
      .map(function (id) { return normalizeTextField(id, PROJECT_PREF_KEY_MAX_CHARS); })
      .filter(Boolean);
    if (!incoming.length) {
      return loadSessionTombstones();
    }
    var deletedAt = new Date().toISOString();
    var payload = {};
    incoming.forEach(function (sessionId) {
      payload[buildSessionTombstoneEntryKey(key, sessionId)] = {
        projectId: key,
        sessionId: sessionId,
        deletedAt: deletedAt
      };
    });
    return chrome.storage.local.set(payload)
      .then(function () { return pruneSessionTombstoneEntries(key); })
      .then(loadSessionTombstones);
  }

  function collectSessionTombstones(stored) {
    var tombstones = normalizeDeletedSessionIdsByProject(
      stored && stored[SESSION_TOMBSTONES_KEY] || {}
    );
    Object.keys(stored || {}).forEach(function (storageKey) {
      if (storageKey.indexOf(SESSION_TOMBSTONE_ENTRY_PREFIX) !== 0) {
        return;
      }
      var entry = stored[storageKey];
      var projectId = normalizeProjectPrefKey(entry && entry.projectId);
      var sessionId = normalizeTextField(entry && entry.sessionId, PROJECT_PREF_KEY_MAX_CHARS);
      if (!projectId || !sessionId) {
        return;
      }
      tombstones[projectId] = (tombstones[projectId] || [])
        .filter(function (id) { return id !== sessionId; })
        .concat(sessionId)
        .slice(-MAX_DELETED_SESSION_IDS_PER_PROJECT);
    });
    return normalizeDeletedSessionIdsByProject(tombstones);
  }

  function buildSessionTombstoneEntryKey(projectId, sessionId) {
    return SESSION_TOMBSTONE_ENTRY_PREFIX +
      encodeURIComponent(projectId) + ':' +
      encodeURIComponent(sessionId);
  }

  function pruneSessionTombstoneEntries(projectId) {
    return chrome.storage.local.get(null).then(function (stored) {
      var entries = Object.keys(stored || {}).filter(function (storageKey) {
        var entry = stored[storageKey];
        return storageKey.indexOf(SESSION_TOMBSTONE_ENTRY_PREFIX) === 0 &&
          normalizeProjectPrefKey(entry && entry.projectId) === projectId;
      }).sort(function (leftKey, rightKey) {
        var left = String(stored[leftKey] && stored[leftKey].deletedAt || '');
        var right = String(stored[rightKey] && stored[rightKey].deletedAt || '');
        return left === right ? leftKey.localeCompare(rightKey) : left.localeCompare(right);
      });
      var obsolete = entries.slice(0, Math.max(0, entries.length - MAX_DELETED_SESSION_IDS_PER_PROJECT));
      return obsolete.length ? chrome.storage.local.remove(obsolete) : undefined;
    });
  }

  function normalizePrefs(prefs) {
    var source = prefs && typeof prefs === 'object' ? prefs : {};
    return Object.assign({}, source, {
      experimentalOtByProject: normalizeBooleanMap(source.experimentalOtByProject),
      customInstructionsByProject: normalizeStringMap(source.customInstructionsByProject)
    });
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

  function normalizeProjectPrefKey(value) {
    var key = typeof value === 'string' ? value.trim() : '';
    if (!key) {
      return '';
    }
    return normalizeTextField(key, PROJECT_PREF_KEY_MAX_CHARS);
  }

  function normalizeTextField(value, maxChars) {
    var text = typeof value === 'string' ? value : '';
    if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
      return text;
    }
    return text.slice(0, Math.max(0, maxChars - 1)) + '…';
  }

  return {
    PREFS_KEY: PREFS_KEY,
    SESSION_TOMBSTONES_KEY: SESSION_TOMBSTONES_KEY,
    buildScopedProjectPreferenceKey: buildScopedProjectPreferenceKey,
    runMigrationIfNeeded: runMigrationIfNeeded,
    savePrefs: savePrefs,
    loadPrefs: loadPrefs,
    loadSessionTombstones: loadSessionTombstones,
    addSessionTombstones: addSessionTombstones,
    getDeletedSessionIds: getDeletedSessionIds,
    normalizeDeletedSessionIdsByProject: normalizeDeletedSessionIdsByProject
  };
});
