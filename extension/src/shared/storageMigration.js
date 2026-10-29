(function initStorageMigration(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./storageDb'));
  } else {
    root.CodexOverleafModuleRegistry.define('StorageMigration', ['StorageDb'], factory);
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function storageMigrationFactory(StorageDb) {
  'use strict';

  var PREFS_KEY = 'codexOverleafPrefs';
  var LEGACY_MIGRATION_PREFIX = 'codexOverleafLegacyPanelMigration:';
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
    'reviewingAvailabilityByProject',
    'selectedLocalSkillIdsByProject'
  ];
  var projectPreferenceLockTails = {};
  var projectPreferenceBaselines = new Map();
  var projectPreferenceIntents = new Map();
  var projectPreferenceBaselineVersions = new WeakMap();

  function getProjectPreferenceBaseline(accountScopeId, projectId) {
    var key = buildScopedProjectPreferenceKey(accountScopeId, projectId);
    var baseline = copyPreferenceValue(projectPreferenceBaselines.get(key));
    var intents = projectPreferenceIntents.get(key);
    if (baseline && intents) projectPreferenceBaselineVersions.set(baseline, {
      owner: intents, versions: Object.assign({}, intents.acknowledged)
    });
    return baseline;
  }

  function adoptProjectPreferenceBaseline(prefs, accountScopeId, projectId) {
    var key = buildScopedProjectPreferenceKey(accountScopeId, projectId);
    if (key) {
      projectPreferenceBaselines.set(key, copyPreferenceValue(prefs));
      projectPreferenceIntents.set(key, { revision: 0, fields: {}, acknowledged: {} });
    }
  }

  function captureProjectPreferenceWrite(input) {
    var projectId = input.projectId;
    var key = buildScopedProjectPreferenceKey(input.accountScopeId, projectId);
    if (!key) return null;
    var intents = projectPreferenceIntents.get(key);
    if (!intents) {
      intents = { revision: 0, fields: {}, acknowledged: {} };
      projectPreferenceIntents.set(key, intents);
    }
    function values(prefs) {
      return {
        experimentalOtByProject: input.normalizeExperimentalOtByProject(prefs.experimentalOtByProject)[projectId] === true,
        reviewingAvailabilityByProject: prefs.reviewingAvailabilityByProject?.[projectId],
        governanceRulesByProject: input.normalizeGovernanceRulesByProject({
          [projectId]: prefs.governanceRulesByProject?.[projectId] || {}
        })[projectId],
        customInstructionsByProject: input.normalizeCustomInstructionsByProject({
          [projectId]: prefs.customInstructionsByProject?.[projectId] || ''
        })[projectId]
      };
    }
    var baseline = input.baseline || getProjectPreferenceBaseline(input.accountScopeId, projectId);
    var captured = projectPreferenceBaselineVersions.get(baseline);
    var versions = captured?.owner === intents ? captured.versions : {};
    var previous = values(baseline || {});
    var current = values(input.state);
    var token = { key: key, owner: intents, projectId: projectId, fields: {}, versions: {}, written: [] };
    for (var name of Object.keys(current)) {
      var latest = intents.fields[name];
      // A pending or later local intent supersedes the older captured read.
      // Peer adoption alone does not turn an unchanged queued snapshot into an edit.
      var reference = latest && latest.revision > (versions[name] || 0) ? latest.value : previous[name];
      if (JSON.stringify(current[name]) !== JSON.stringify(reference)) {
        latest = { revision: ++intents.revision, value: copyPreferenceValue(current[name]), dirty: true };
        intents.fields[name] = latest;
      }
      token.fields[name] = latest && JSON.stringify(current[name]) === JSON.stringify(latest.value) ? latest : null;
      token.versions[name] = latest?.revision || 0;
    }
    return token;
  }

  function projectPreferencePatch(token, accountScopeId, projectId) {
    if (token.key !== buildScopedProjectPreferenceKey(accountScopeId, projectId)) {
      throw Object.assign(new Error('Scoped project preferences require account and project identity.'), {
        code: 'account_scope_unavailable'
      });
    }
    var current = projectPreferenceIntents.get(token.key) === token.owner;
    var patch = {};
    token.written = [];
    for (var name of Object.keys(token.fields)) {
      var intent = token.fields[name];
      var changed = current && intent?.dirty && token.owner.fields[name] === intent;
      patch[name] = changed ? { [token.projectId]: copyPreferenceValue(intent.value) } : {};
      if (changed) token.written.push(name);
    }
    return patch;
  }

  function completeProjectPreferenceWrite(token, prefs) {
    if (projectPreferenceIntents.get(token.key) !== token.owner) return [];
    for (var name of token.written) {
      var intent = token.fields[name];
      intent.dirty = false;
      token.owner.acknowledged[name] = Math.max(token.owner.acknowledged[name] || 0, intent.revision);
    }
    projectPreferenceBaselines.set(token.key, copyPreferenceValue(prefs));
    return Object.keys(token.fields).filter(function (name) {
      var latest = token.owner.fields[name];
      return (latest?.revision || 0) === token.versions[name] && !latest?.dirty;
    });
  }

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
    if (StorageDb.sharedSessionsEnabled?.()) {
      return StorageDb.withSharedLock('preferences', { projectId: projectId }, work);
    }
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
        const previous = storedMap[scopedKey], observation = incomingMap[projectId];
        if (mapName !== 'reviewingAvailabilityByProject'
          || !(Number(previous?.observedAt) > Number(observation?.observedAt)
            || (previous?.observedAt === observation?.observedAt && previous?.status === 'available'))) {
          storedMap[scopedKey] = copyPreferenceValue(observation);
        }
      }
      delete storedMap[projectId];
      next[mapName] = storedMap;
    });
    return normalizePrefs(next);
  }

  function runMigrationIfNeeded(projectId, legacyStorageKey, accountScopeId) {
    projectId = normalizeProjectPrefKey(projectId);
    var account = normalizeTextField(accountScopeId, PROJECT_PREF_KEY_MAX_CHARS);
    if (!account || !projectId) return Promise.resolve({ prefs: normalizePrefs({}), sessions: [],
      activeSessionId: '', migrated: false, reason: 'account_scope_unavailable' });
    return withProjectPreferenceLock(projectId, async function () {
      var stored = await chrome.storage.local.get(null);
      var claimed = claimLegacyProjectPreferences(stored[PREFS_KEY] || {}, account, projectId);
      var storedPrefs = claimed.prefs;
      if (claimed.changed) await chrome.storage.local.set({ [PREFS_KEY]: storedPrefs });
      var prefs = buildProjectPreferenceView(storedPrefs, account, projectId);
      var deleted = getDeletedSessionIds(collectSessionTombstones(stored), projectId);
      var markerKey = LEGACY_MIGRATION_PREFIX + encodeURIComponent(String(legacyStorageKey || ''));
      var marker = stored[markerKey];
      var legacyBlob = stored[legacyStorageKey];
      var hasLegacy = Boolean(legacyBlob && typeof legacyBlob === 'object' && !Array.isArray(legacyBlob));
      var schemaCurrent = (prefs.storageSchemaVersion || 0) >= StorageDb.TARGET_SCHEMA_VERSION;
      if (marker && (marker.projectId !== projectId || marker.sourceKey !== legacyStorageKey || !marker.accountScopeId)) {
        throw Object.assign(new Error('The legacy history source has a conflicting migration identity.'), { code: 'legacy_migration_scope_conflict' });
      }
      if (typeof StorageDb.claimSessionsForAccount !== 'function') {
        throw Object.assign(new Error('Atomic legacy-session claiming is unavailable.'), { code: 'scoped_claim_unavailable' });
      }
      var visible = await StorageDb.claimSessionsForAccount(projectId, account, deleted);
      function result(currentPrefs, sessions, migrated) {
        var wanted = currentPrefs.activeSessionByProject?.[projectId] || '';
        adoptProjectPreferenceBaseline(currentPrefs, account, projectId);
        return { prefs: currentPrefs, sessions: sessions,
          activeSessionId: sessions.some(session => session.id === wanted) ? wanted : sessions.at(-1)?.id || '',
          migrated: migrated };
      }
      if ((schemaCurrent && !hasLegacy) || marker?.complete || (marker && marker.accountScopeId !== account)) {
        return result(prefs, visible, false);
      }
      legacyBlob = hasLegacy ? legacyBlob : {};
      var legacySessions = Array.isArray(legacyBlob.sessions) ? legacyBlob.sessions : [];
      var owners = new Set([legacyBlob.accountScopeId, legacyBlob.__codexOverleafFallbackAccountScopeId,
        ...legacySessions.map(session => session?.accountScopeId)].filter(value => typeof value === 'string' && value));
      if ([...owners].some(owner => owner !== account)) return result(prefs, visible, false);
      // The shared preferences lock serializes this source claim across accounts.
      // Keep it after a write failure; only its owner can finish the import.
      if (hasLegacy && !marker) {
        marker = { sourceKey: legacyStorageKey, projectId: projectId, accountScopeId: account, complete: false };
        await chrome.storage.local.set({ [markerKey]: marker });
      }
      var existingIds = new Set(visible.map(session => session.id));
      var incoming = legacySessions.filter(session => session?.id && !deleted.includes(session.id) && !existingIds.has(session.id))
        .map(session => StorageDb.buildSessionRecord(buildLegacySessionRecordInput(projectId, legacyBlob, session, account)));
      var written = incoming.length ? await StorageDb.putRecords('sessions', incoming) : [];
      if (incoming.length && (!Array.isArray(written) || incoming.some(session => !written.some(record =>
        record.id === session.id && record.accountScopeId === account && record.projectId === projectId)))) {
        throw Object.assign(new Error('Legacy history was not confirmed in the main session store.'), { code: 'legacy_migration_not_persisted' });
      }
      var sessions = [...visible, ...written];
      var newPrefs = StorageDb.extractLightweightPrefs(legacyBlob, projectId);
      if (schemaCurrent) {
        // A later project's import must not reset current global preferences.
        var legacyPrefs = newPrefs;
        newPrefs = Object.assign({}, legacyPrefs, prefs);
        PROJECT_SCOPED_PREF_MAPS.forEach(function (name) {
          newPrefs[name] = Object.assign({}, legacyPrefs[name] || {}, prefs[name] || {});
        });
      }
      var currentActive = prefs.activeSessionByProject?.[projectId];
      var activeId = sessions.some(session => session.id === currentActive) ? currentActive
        : legacyBlob.activeSessionId || sessions.at(-1)?.id || '';
      newPrefs.activeSessionByProject = StorageDb.buildActiveSessionByProject({}, projectId, activeId);
      var mergedPrefs = mergeScopedProjectPreferences(storedPrefs, newPrefs, account, projectId);
      await chrome.storage.local.set({ [PREFS_KEY]: mergedPrefs });
      // Completion is per source and owner, independent of the global schema.
      // A failed cleanup cannot replay old content or transfer it to another account.
      if (hasLegacy) await chrome.storage.local.set({ [markerKey]: { ...marker, complete: true } });
      await chrome.storage.local.remove(legacyStorageKey).catch(function () {});
      return result(buildProjectPreferenceView(mergedPrefs, account, projectId), sessions, true);
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
        return chrome.storage.local.set({ [PREFS_KEY]: next }).then(function () {
          return buildProjectPreferenceView(next, account, project);
        });
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
    getProjectPreferenceBaseline: getProjectPreferenceBaseline,
    adoptProjectPreferenceBaseline: adoptProjectPreferenceBaseline,
    captureProjectPreferenceWrite: captureProjectPreferenceWrite,
    projectPreferencePatch: projectPreferencePatch,
    completeProjectPreferenceWrite: completeProjectPreferenceWrite,
    loadSessionTombstones: loadSessionTombstones,
    addSessionTombstones: addSessionTombstones,
    getDeletedSessionIds: getDeletedSessionIds,
    normalizeDeletedSessionIdsByProject: normalizeDeletedSessionIdsByProject
  };
});
