(function initCodexOverleafRecentProjects() {
  'use strict';

  // Cross-project dashboard: account-scoped names, project rows and sessions.
  function create(deps = {}) {
    const {
      tr,
      tx,
      openCustomInstructionsSettings,
      enterProject,
      applyStateToPanel,
      getPanel,
      getCachedAccountScopeId,
      refreshAccountScopeId,
      showPluginConfirm,
      showPluginToast,
      sendBackgroundNative,
      PANEL_STATE_BASE_KEY,
      PROJECT_EDITOR_RESERVED_IDS,
      STATUS_BADGE_CLASS
    } = deps;
    const projectSessionCleanup = window.CodexOverleafProjectSessionCleanup.create({
      tr, getAccountScopeId: getCachedAccountScopeId, showPluginConfirm, showPluginToast,
      sendBackgroundNative, mutateProjectPanelState, renderRecentProjectsVariant
    });

  // chrome.storage.local cache key (spec §5.6.3). The cache is keyed by
  // accountScopeId so a second account on the same Chrome profile cannot
  // see another account's project names.
  const PROJECT_NAME_CACHE_STORAGE_KEY = 'projectNameCacheByAccount';
  // In-memory mirror of the cache so `lookupProjectName` can be synchronous
  // (the row renderer is sync). The async loader populates this on panel
  // mount and on each opportunistic enrichment call.
  let projectNameCacheMirror = {};

  function loadProjectNameCacheFromStorage() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(PROJECT_NAME_CACHE_STORAGE_KEY, function (items) {
          var stored = items && items[PROJECT_NAME_CACHE_STORAGE_KEY];
          if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
            projectNameCacheMirror = stored;
          }
          resolve(projectNameCacheMirror);
        });
      } catch (_error) {
        resolve(projectNameCacheMirror);
      }
    });
  }

  // v1.8.1: "Clear all history" must also drop the cached project names —
  // they can carry sensitive titles and live in chrome.storage.local, not in
  // the IndexedDB stores that clearAllStores wipes.
  async function resetProjectNameCache() {
    projectNameCacheMirror = {};
    try {
      await chrome.storage.local.remove(PROJECT_NAME_CACHE_STORAGE_KEY);
    } catch (_error) { /* storage unavailable — mirror is already empty */ }
  }

  function persistProjectNameCacheToStorage() {
    return new Promise(function (resolve) {
      try {
        var payload = {};
        payload[PROJECT_NAME_CACHE_STORAGE_KEY] = projectNameCacheMirror;
        chrome.storage.local.set(payload, function () {
          resolve();
        });
      } catch (_error) {
        resolve();
      }
    });
  }

  function lookupProjectName(projectId) {
    var accountScopeId = getCachedAccountScopeId();
    if (!accountScopeId) {
      return '';
    }
    var bucket = projectNameCacheMirror[accountScopeId];
    if (!bucket || typeof bucket !== 'object') {
      return '';
    }
    var name = bucket[projectId];
    return typeof name === 'string' && name ? name : '';
  }

  // Spec §5.6.4 — opportunistic enrichment from the project-list page DOM.
  // Best-effort: selectors here are pinned at user-test time against the
  // live Overleaf project-list page; if they fail we no-op so the cached
  // render survives. The two patterns the spec calls out are
  // `[data-project-id]` + `[data-project-name]` (semantic markers) and the
  // legacy `.project-list-table` row shape (anchor href = /project/<id> +
  // an adjacent text node).
  async function opportunisticEnrichmentFromDom() {
    var accountScopeId = getCachedAccountScopeId();
    if (!accountScopeId) {
      return;
    }
    try {
      var bucket = projectNameCacheMirror[accountScopeId] || {};
      var merged = false;
      // Primary selector: an element annotated with both data-project-id and
      // data-project-name. Mirrors the Overleaf "v1.x project-list-table" data
      // attributes when present. Selectors below are best-effort and are the
      // implementer-pinned attempt; falling through to the legacy anchor
      // selector keeps the enrichment alive across markup churn.
      var nodes = document.querySelectorAll('[data-project-id][data-project-name]');
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        var pid = node.getAttribute('data-project-id');
        var pname = node.getAttribute('data-project-name');
        if (isValidProjectId(pid) && typeof pname === 'string' && pname && bucket[pid] !== pname) {
          bucket[pid] = pname;
          merged = true;
        }
      }
      // Legacy fallback: project-list-table row with an anchor to /project/<id>
      // whose accessible text contains the project name. This is the path
      // that survives if Overleaf strips the data attributes.
      var anchors = document.querySelectorAll('a[href^="/project/"]');
      for (var j = 0; j < anchors.length; j++) {
        var anchor = anchors[j];
        var href = anchor.getAttribute('href') || '';
        var match = href.match(/^\/project\/([a-f0-9]{24})/);
        if (!match) continue;
        var anchorId = match[1];
        var text = (anchor.textContent || '').trim();
        if (text && bucket[anchorId] !== text && text.length <= 200) {
          bucket[anchorId] = text;
          merged = true;
        }
      }
      if (merged) {
        projectNameCacheMirror[accountScopeId] = bucket;
        await persistProjectNameCacheToStorage();
        // If the variant is currently visible, refresh row names in place.
        var visibleList = getPanel() && getPanel().querySelector('[data-recent-projects-list]');
        if (visibleList) {
          var rows = visibleList.querySelectorAll('[data-recent-projects-row]');
          for (var k = 0; k < rows.length; k++) {
            var row = rows[k];
            var rowPid = row.getAttribute('data-project-id');
            var nameEl = row.querySelector('.recent-projects-row-name');
            if (rowPid && nameEl) {
              var cached = lookupProjectName(rowPid);
              if (cached) {
                nameEl.textContent = cached;
              }
            }
          }
        }
      }
    } catch (_error) {
      // Selector / DOM enrichment failures are silent by design — the cached
      // render path keeps working. Cache invariants are unaffected.
    }
  }

  // Cache the project name for the currently-mounted project on per-project
  // entry. Called from `enterProject` so the cache fills naturally as the
  // user visits projects. Cheap, idempotent.
  function rememberCurrentProjectName(projectId) {
    if (!isValidProjectId(projectId)) {
      return;
    }
    var accountScopeId = getCachedAccountScopeId();
    if (!accountScopeId) {
      return;
    }
    var name = readCurrentProjectNameFromDom();
    if (!name) {
      return;
    }
    var bucket = projectNameCacheMirror[accountScopeId] || {};
    if (bucket[projectId] === name) {
      return;
    }
    bucket[projectId] = name;
    projectNameCacheMirror[accountScopeId] = bucket;
    persistProjectNameCacheToStorage().catch(function () { /* swallow */ });
  }

  function readCurrentProjectNameFromDom() {
    // Best-effort: try the editor title bar element, then document.title.
    // Both pinned at user-test time. Falsy return = quiet skip.
    try {
      var titleEl = document.querySelector('[data-project-name], .project-name');
      if (titleEl) {
        var text = (titleEl.textContent || '').trim();
        if (text) return text;
      }
    } catch (_error) { /* swallow */ }
    try {
      var docTitle = (document.title || '').trim();
      // Overleaf typically formats as "<Project Name> - Overleaf" or
      // "<Project Name> - Online LaTeX Editor"; strip the " - " suffix.
      if (docTitle) {
        var stripped = docTitle.replace(/\s*[-–]\s*Overleaf.*$/i, '').trim();
        if (stripped && stripped.toLowerCase() !== 'overleaf') {
          return stripped;
        }
      }
    } catch (_error) { /* swallow */ }
    return '';
  }

  // ISO timestamp → short human-readable relative time. Locale-agnostic in
  // the literal punctuation so the same renderer works in en + zh; the
  // numeric/word parts are bilingual.
  function formatRelativeTime(iso) {
    if (typeof iso !== 'string' || !iso) {
      return '';
    }
    var then = Date.parse(iso);
    if (!Number.isFinite(then)) {
      return '';
    }
    var now = Date.now();
    var diffMs = now - then;
    if (diffMs < 0) diffMs = 0;
    var sec = Math.round(diffMs / 1000);
    if (sec < 45) return tx('just now', '刚刚');
    var min = Math.round(sec / 60);
    if (min < 60) return tx(min + ' min ago', min + ' 分钟前');
    var hr = Math.round(min / 60);
    if (hr < 24) return tx(hr + ' hr ago', hr + ' 小时前');
    var day = Math.round(hr / 24);
    if (day < 30) return tx(day + ' day ago', day + ' 天前');
    var month = Math.round(day / 30);
    if (month < 12) return tx(month + ' mo ago', month + ' 个月前');
    var year = Math.round(month / 12);
    return tx(year + ' yr ago', year + ' 年前');
  }

  function textNode(text, className) {
    var el = document.createElement('span');
    if (className) {
      el.className = className;
    }
    el.textContent = text == null ? '' : String(text);
    return el;
  }

  function renderWelcomeHeader(stats) {
    var el = document.createElement('div');
    el.className = 'recent-projects-welcome';
    el.setAttribute('data-recent-projects-welcome', '');
    var title = document.createElement('div');
    title.className = 'recent-projects-welcome-title';
    title.textContent = tr('recentProjects_welcome');
    var subtitle = document.createElement('div');
    subtitle.className = 'recent-projects-welcome-subtitle';
    // v1.8.1: the most expensive spot on the first screen now carries a
    // glanceable summary instead of boilerplate once the rows are known.
    subtitle.textContent = stats && stats.projectCount
      ? tr('recentProjects_welcome_stats', { projects: stats.projectCount, sessions: stats.sessionTotal })
      : tr('recentProjects_welcome_subtitle');
    el.appendChild(title);
    el.appendChild(subtitle);
    return el;
  }

  function renderEmptyState() {
    var el = document.createElement('div');
    el.className = 'recent-projects-empty';
    el.setAttribute('data-recent-projects-empty', '');
    el.textContent = tr('recentProjects_empty');
    return el;
  }

  function renderDegradedState() {
    var el = document.createElement('div');
    el.className = 'recent-projects-degraded';
    el.setAttribute('data-recent-projects-degraded', '');
    // v1.8.1: the user IS signed in on /project — telling them to sign in
    // was a dead end. Explain the real condition and offer a retry.
    var hint = document.createElement('div');
    hint.textContent = tr('recentProjects_degraded_hint');
    el.appendChild(hint);
    var retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'recent-projects-show-all';
    retry.setAttribute('data-recent-projects-retry', '');
    retry.textContent = tr('recentProjects_retryScope');
    retry.addEventListener('click', function () {
      if (typeof refreshAccountScopeId === 'function') {
        Promise.resolve(refreshAccountScopeId())
          .then(function () { return renderRecentProjectsVariant(); })
          .catch(function () { /* stays degraded */ });
      } else {
        renderRecentProjectsVariant();
      }
    });
    el.appendChild(retry);
    return el;
  }

  // Spec §5.9 — settings entry, scope-aware. The "account" scope hides
  // project-only sections inside the settings page (governance, sensitive,
  // skills tied to projects, custom instructions, project diagnostics).
  function renderSettingsEntry(options) {
    var scope = options && options.scope === 'account' ? 'account' : 'project';
    var entry = document.createElement('button');
    entry.type = 'button';
    entry.className = 'recent-projects-settings-entry';
    entry.setAttribute('data-recent-projects-settings-entry', '');
    entry.setAttribute('data-settings-scope', scope);
    var label = document.createElement('span');
    label.className = 'recent-projects-settings-entry-label';
    label.textContent = tr('recentProjects_settings_entry');
    entry.appendChild(label);
    entry.addEventListener('click', function () {
      openSettingsInScope(scope);
    });
    return entry;
  }

  // Open the existing settings panel with the requested scope. For
  // scope === 'account' the project-only sections inside the settings panel
  // are hidden via a data attribute on the panel root (CSS / template
  // governs the actual display). For scope === 'project' the existing
  // behavior is unchanged.
  function openSettingsInScope(scope) {
    if (getPanel()) {
      // Single data attribute the settings template / CSS can read to hide
      // project-only blocks. Two values: 'account' (no project active) and
      // 'project' (per-project variant, existing behavior). Keeping this on
      // the panel root (not on the settings slot) lets the renderer choose
      // its scope before opening; it survives view-attribute changes.
      getPanel().dataset.settingsScope = scope;
    }
    openCustomInstructionsSettings();
  }

  // v1.8.1: a session record can be stuck at 'running' forever if the tab
  // closed / browser crashed mid-run and the project was never reopened in
  // the editor (which is what settles running -> interrupted). v1.8.3 also
  // treats old display-only 'pending' rows as stale: that preserves the stored
  // run state while avoiding a dashboard chip that looks actively in progress
  // days later.
  var ZOMBIE_RUNNING_MS = 30 * 60 * 1000;

  function settleDashboardRunStatus(status, lastTouchedIso) {
    if (status !== 'running' && status !== 'pending') {
      return status;
    }
    var touched = Date.parse(lastTouchedIso || '');
    if (!Number.isFinite(touched) || (Date.now() - touched) > ZOMBIE_RUNNING_MS) {
      return status === 'running' ? 'interrupted' : 'stale';
    }
    return status;
  }

  function renderStatusBadge(status) {
    var safeStatus = (typeof status === 'string' && STATUS_BADGE_CLASS[status])
      ? status
      : 'pending';
    var cls = STATUS_BADGE_CLASS[safeStatus];
    var el = document.createElement('span');
    el.className = 'recent-projects-row-badge ' + cls;
    el.setAttribute('data-status', safeStatus);
    el.textContent = tr('recentProjects_badge_' + safeStatus);
    return el;
  }

  function isValidProjectId(id) {
    return typeof id === 'string' && /^[a-f0-9]{24}$/.test(id) && !PROJECT_EDITOR_RESERVED_IDS.has(id);
  }

  function openProjectFromRow(projectId) {
    if (!isValidProjectId(projectId)) {
      return;
    }
    window.location.assign('https://www.overleaf.com/project/' + encodeURIComponent(projectId));
  }

  function renderRecentProjectRow(row) {
    var projectId = row && row.projectId;
    var valid = isValidProjectId(projectId);
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'recent-projects-row';
    el.setAttribute('data-recent-projects-row', '');
    el.setAttribute('data-project-id', projectId || '');
    if (!valid) {
      el.disabled = true;
      el.setAttribute('aria-disabled', 'true');
    }
    var name = lookupProjectName(projectId);
    if (!name) {
      name = isValidProjectId(projectId)
        ? tr('recentProjects_unnamed', { prefix: projectId.slice(0, 8) })
        : tr('recentProjects_row_projectLinkUnavailable');
    }
    var nameNode = textNode(name, 'recent-projects-row-name');
    nameNode.title = name;
    el.appendChild(nameNode);
    var rowTime = textNode(formatRelativeTime(row && row.lastActivityAt), 'recent-projects-row-time');
    rowTime.setAttribute('data-rel-time', String(row && row.lastActivityAt || ''));
    el.appendChild(rowTime);
    // v1.8.2: the session count lives in the row meta, matching its type
    // scale, instead of inflating the expand toggle.
    var sessionCount = Number(row && row.sessionCount) || 0;
    if (sessionCount > 1) {
      el.appendChild(textNode(tr('recentProjects_sessionsCount', { count: sessionCount }), 'recent-projects-row-sessions'));
    }
    el.appendChild(renderStatusBadge(settleDashboardRunStatus(row && row.primaryStatusBadge, row && row.lastActivityAt)));
    if (valid) {
      el.addEventListener('click', function () {
        openProjectFromRow(projectId);
      });
    } else {
      el.appendChild(textNode(tr('recentProjects_row_projectLinkUnavailable'), 'recent-projects-row-warning'));
    }
    if (!valid) {
      var deadWrap = document.createElement('div');
      deadWrap.className = 'recent-projects-row-wrap';
      var deadHead = document.createElement('div');
      deadHead.className = 'recent-projects-row-head';
      var cleanup = document.createElement('button');
      cleanup.type = 'button';
      cleanup.className = 'recent-projects-row-cleanup';
      cleanup.setAttribute('data-row-cleanup', '');
      cleanup.title = tr('recentProjects_cleanup');
      cleanup.setAttribute('aria-label', tr('recentProjects_cleanup'));
      cleanup.textContent = '×';
      cleanup.addEventListener('click', function () {
        cleanupDeadProjectEntry(projectId).catch(function () { /* swallow */ });
      });
      deadHead.appendChild(el);
      deadHead.appendChild(cleanup);
      deadWrap.appendChild(deadHead);
      return deadWrap;
    }
    var wrap = document.createElement('div');
    wrap.className = 'recent-projects-row-wrap';
    wrap.setAttribute('data-project-row-wrap', projectId);
    var expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'recent-projects-row-expand';
    expand.setAttribute('data-row-expand', '');
    expand.setAttribute('aria-expanded', 'false');
    // v1.8.1 a11y: tie the toggle to the container it reveals.
    var sessionsElId = 'codex-project-sessions-' + String(projectId || '').slice(0, 24);
    expand.setAttribute('aria-controls', sessionsElId);
    expand.title = tr('recentProjects_sessions_toggle');
    expand.setAttribute('aria-label', tr('recentProjects_sessions_toggle'));
    expand.textContent = tr('recentProjects_sessions_action');
    var head = document.createElement('div');
    head.className = 'recent-projects-row-head';
    var clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'recent-projects-row-clear';
    clear.setAttribute('data-project-clear', '');
    clear.title = tr('recentProjects_clearProject');
    clear.setAttribute('aria-label', tr('recentProjects_clearProject'));
    clear.textContent = '×';
    clear.addEventListener('click', function (event) {
      event.stopPropagation();
      projectSessionCleanup.clearProjectSessions(projectId, name).catch(function () { /* surfaced by the action */ });
    });
    head.appendChild(el);
    head.appendChild(expand);
    head.appendChild(clear);
    var sessionsEl = document.createElement('div');
    sessionsEl.className = 'recent-projects-sessions';
    sessionsEl.setAttribute('data-project-sessions', '');
    sessionsEl.id = sessionsElId;
    sessionsEl.setAttribute('role', 'region');
    sessionsEl.setAttribute('aria-label', tr('recentProjects_sessions_toggle'));
    sessionsEl.hidden = true;
    expand.addEventListener('click', function () {
      toggleProjectSessions(wrap, projectId);
    });
    wrap.appendChild(head);
    wrap.appendChild(sessionsEl);
    return wrap;
  }

  function toggleProjectSessions(wrap, projectId) {
    var sessionsEl = wrap.querySelector('[data-project-sessions]');
    var expand = wrap.querySelector('[data-row-expand]');
    if (!sessionsEl || !expand) {
      return;
    }
    var opening = sessionsEl.hidden;
    sessionsEl.hidden = !opening;
    expand.setAttribute('aria-expanded', opening ? 'true' : 'false');
    expand.textContent = tr(opening ? 'recentProjects_sessions_action_open' : 'recentProjects_sessions_action');
    wrap.setAttribute('data-expanded', opening ? 'true' : 'false');
    if (opening) {
      renderProjectSessions(sessionsEl, projectId).catch(function () { /* swallow */ });
    }
  }

  function sessionRecordDisplayTitle(record) {
    var SessionState = window.CodexOverleafSessionState;
    if (record && typeof record.title === 'string' && record.title.trim()) {
      return record.title.trim();
    }
    var derived = SessionState ? SessionState.deriveSessionTitle(record && record.runs, record && record.task) : '';
    return derived || tr('newSessionFallback');
  }

  async function loadProjectSessionRecords(projectId) {
    var StorageDb = window.CodexOverleafStorageDb;
    if (!StorageDb) {
      return [];
    }
    var records = await StorageDb.getAllByIndex('sessions', 'projectId', projectId);
    var Persistence = window.CodexOverleafSessionPersistence;
    var deletedIds = await Persistence.getDeletedSessionIds(projectId);
    var scope = getCachedAccountScopeId();
    return (records || [])
      .filter(function (record) { return Persistence.isVisibleRecord(record, deletedIds, scope); })
      .sort(function (a, b) {
        return String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''));
      });
  }

  async function renderProjectSessions(sessionsEl, projectId) {
    var StorageDb = window.CodexOverleafStorageDb;
    sessionsEl.innerHTML = '';
    var sessionsLoading = document.createElement('div');
    sessionsLoading.className = 'recent-projects-loading';
    sessionsLoading.textContent = tx('Loading sessions…', '正在加载会话…');
    sessionsEl.appendChild(sessionsLoading);
    var records = [];
    try {
      records = await loadProjectSessionRecords(projectId);
    } catch (_error) {
      records = [];
    }
    sessionsLoading.remove();
    if (!records.length) {
      sessionsEl.appendChild(textNode(tr('recentProjects_sessions_empty'), 'recent-projects-sessions-empty'));
      return;
    }
    for (var i = 0; i < records.length; i++) {
      sessionsEl.appendChild(renderProjectSessionRow(sessionsEl, projectId, records[i]));
    }
  }

  function renderProjectSessionRow(sessionsEl, projectId, record) {
    var StorageDb = window.CodexOverleafStorageDb;
    var running = Boolean(StorageDb)
      && settleDashboardRunStatus(StorageDb.derivePrimaryStatusBadge(record), record.updatedAt || record.lastActivityAt) === 'running';
    var row = document.createElement('div');
    row.className = 'recent-projects-session-row';
    row.setAttribute('data-project-session-row', record.id);
    if (running) {
      row.setAttribute('data-running', 'true');
    }
    var title = textNode(sessionRecordDisplayTitle(record), 'recent-projects-session-title');
    title.title = sessionRecordDisplayTitle(record);
    var time = textNode(formatRelativeTime(record.updatedAt || record.createdAt), 'recent-projects-session-time');
    time.setAttribute('data-rel-time', String(record.updatedAt || record.createdAt || ''));
    var rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'recent-projects-session-action';
    rename.setAttribute('data-session-rename-dash', '');
    rename.title = tr('renameSession');
    rename.setAttribute('aria-label', tr('renameSession'));
    rename.textContent = '✎';
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'recent-projects-session-action recent-projects-session-action--delete';
    del.setAttribute('data-session-delete-dash', '');
    del.title = tr('deleteSession');
    del.setAttribute('aria-label', tr('deleteSession'));
    del.textContent = '×';
    if (running) {
      // Recently-touched running sessions may genuinely be live in another
      // tab: keep rename locked, but let delete through a stronger confirm
      // instead of a permanent dead-end (fleet: zombie sessions were
      // undeletable from the very surface built to manage them).
      rename.disabled = true;
      del.title = tr('recentProjects_zombieRunningNote');
    }
    rename.addEventListener('click', function () {
      beginDashboardSessionRename(sessionsEl, projectId, record, row, title);
    });
    del.addEventListener('click', function () {
      deleteDashboardSession(sessionsEl, projectId, record).catch(function () { /* swallow */ });
    });
    row.appendChild(title);
    row.appendChild(time);
    row.appendChild(rename);
    row.appendChild(del);
    // v1.8.1 O2: session rows were click-dead. Clicking one now records it
    // as the project's active session (the pref the editor reads on load)
    // and opens the project straight into it.
    row.classList.add('recent-projects-session-row--linked');
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    var activate = function () {
      activateSessionAndOpenProject(projectId, record).catch(function () { /* navigation is best-effort */ });
    };
    row.addEventListener('click', function (event) {
      if (event.target.closest('button') || event.target.closest('input')) {
        return;
      }
      activate();
    });
    row.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        activate();
      }
    });
    return row;
  }

  async function activateSessionAndOpenProject(projectId, record) {
    var Migration = window.CodexOverleafStorageMigration;
    try {
      if (Migration && Migration.loadPrefs && Migration.savePrefs) {
        var accountScopeId = getCachedAccountScopeId();
        if (!accountScopeId) {
          throw new Error('Account scope is unavailable.');
        }
        var prefs = await Migration.loadPrefs(accountScopeId, projectId);
        prefs = prefs && typeof prefs === 'object' ? prefs : {};
        var map = prefs.activeSessionByProject && typeof prefs.activeSessionByProject === 'object'
          ? prefs.activeSessionByProject
          : {};
        map[projectId] = record.id;
        prefs.activeSessionByProject = map;
        await Migration.savePrefs(prefs, accountScopeId, projectId);
      }
    } catch (_error) { /* fall through: opening the project still works */ }
    openProjectFromRow(projectId);
  }

  // Remove every session record behind a dead (invalid-projectId) dashboard
  // entry. Matching is done over a full scan instead of the projectId index:
  // records with an undefined projectId are not indexed at all. The panel
  // panel-state blob is deliberately left alone — an empty projectId would
  // map getProjectStorageKey onto the global legacy key.
  async function cleanupDeadProjectEntry(projectId) {
    var StorageDb = window.CodexOverleafStorageDb;
    if (!StorageDb) {
      return;
    }
    var approved = await showPluginConfirm({
      title: tr('recentProjects_cleanup_title'),
      message: tr('recentProjects_cleanup_message'),
      confirmLabel: tr('recentProjects_cleanup_confirm'),
      cancelLabel: tr('confirmDefaultCancel'),
      destructive: true
    });
    if (!approved) {
      return;
    }
    var scope = getCachedAccountScopeId();
    var wanted = String(projectId || '');
    var all = [];
    try {
      all = await StorageDb.getAllSessions();
    } catch (_error) {
      all = [];
    }
    var records = (all || []).filter(function (record) {
      return record
        && (!scope || record.accountScopeId === scope)
        && String(record.projectId || '') === wanted;
    });
    var removed = 0;
    for (var i = 0; i < records.length; i++) {
      try {
        await StorageDb.deleteRecord('sessions', records[i].id);
        removed++;
      } catch (_error) { /* keep going */ }
      try {
        await sendBackgroundNative({
          method: 'codex.history.clearPlugin',
          params: {
            sessionId: records[i].id,
            threadId: records[i].codexThreadId || ''
          }
        });
      } catch (_error) { /* best effort: the records are already gone locally */ }
    }
    showPluginToast(tr('recentProjects_cleanup_done', { count: String(removed) }), { status: 'info' });
    await renderRecentProjectsVariant();
  }

  function projectPanelStateKey(projectId) {
    var StorageKeys = window.CodexOverleafStorageKeys;
    return StorageKeys.getProjectStorageKey(PANEL_STATE_BASE_KEY, 'https://www.overleaf.com/project/' + projectId);
  }

  // Apply `mutate(normalizedState) -> nextState` to the project's stored panel
  // state and write it back compacted — the same normalize/prepare pipeline
  // saveState uses, so opening the project later sees a coherent state.
  // NOTE: if the project is open in another tab, that tab's in-memory state
  // wins on its next save; the IndexedDB record mutation below still holds.
  async function mutateProjectPanelState(projectId, mutate) {
    var SessionState = window.CodexOverleafSessionState;
    var key = projectPanelStateKey(projectId);
    var stored = await chrome.storage.local.get(key);
    var blob = stored && stored[key];
    if (!blob || !SessionState) {
      return false;
    }
    var nextState = mutate(SessionState.normalizePanelState(blob));
    var payload = {};
    payload[key] = SessionState.prepareStateForStorage(nextState);
    await chrome.storage.local.set(payload);
    return true;
  }

  async function deleteDashboardSession(sessionsEl, projectId, record) {
    var StorageDb = window.CodexOverleafStorageDb;
    var SessionState = window.CodexOverleafSessionState;
    // v1.8.1 P1b: ANY record whose stored badge is 'running' gets the
    // stronger confirm — even one the 30-minute heuristic settled to
    // interrupted. Activity timestamps are only bumped once a minute during
    // a run, so the heuristic alone must never be the last line of defense
    // for deleting what could be a live Codex thread.
    var storedRunning = Boolean(StorageDb) && StorageDb.derivePrimaryStatusBadge(record) === 'running';
    var approved = await showPluginConfirm({
      title: tr('deleteSessionTitle'),
      message: [
        sessionRecordDisplayTitle(record),
        '',
        storedRunning ? tr('recentProjects_zombieDeleteConfirm') : tr('deleteSessionMessage')
      ].join('\n'),
      confirmLabel: tr('deleteSessionConfirm'),
      cancelLabel: tr('confirmDefaultCancel'),
      destructive: true
    });
    if (!approved) {
      return;
    }
    await window.CodexOverleafSessionPersistence.addTombstones(projectId, [record.id]);
    try {
      await mutateProjectPanelState(projectId, function (state) {
        return SessionState.deleteSession(state, record.id);
      });
    } catch (_error) { /* storage blob may be absent; record removal still proceeds */ }
    try {
      if (StorageDb) {
        await StorageDb.deleteRecord('sessions', record.id);
      }
    } catch (_error) { /* swallow */ }
    try {
      var response = await sendBackgroundNative({
        method: 'codex.history.clearPlugin',
        params: {
          sessionId: record.id,
          threadId: record.codexThreadId || ''
        }
      });
      if (!response || !response.ok) {
        showPluginToast(tr('deleteSessionHistoryFailedToast', { message: (response && response.error && response.error.message) || 'native host did not return success' }), { status: 'warning', sticky: true });
      } else if (response.result && response.result.skipped) {
        showPluginToast(tr('deleteSessionNoThreadToast'), { status: 'info' });
      } else {
        showPluginToast(tr('deleteSessionDoneToast'), { status: 'completed' });
      }
    } catch (error) {
      showPluginToast(tr('deleteSessionHistoryFailedToast', { message: error.message }), { status: 'warning', sticky: true });
    }
    // Re-render the whole variant so the row summary/badge reflect the
    // deletion, then restore this project's expanded session list.
    // v1.8.1: refresh the whole variant so the row's session count, badge,
    // summary and the welcome stats all stay fresh — but restore the scroll
    // position and this project's expanded list so the delete feels in-place.
    var rootForScroll = getPanel() && getPanel().querySelector('[data-recent-projects-root]');
    await renderRecentProjectsVariant({
      expandProjectId: projectId,
      restoreScrollTop: rootForScroll ? rootForScroll.scrollTop : undefined
    });
  }

  function beginDashboardSessionRename(sessionsEl, projectId, record, row, titleEl) {
    var SessionState = window.CodexOverleafSessionState;
    var StorageDb = window.CodexOverleafStorageDb;
    if (row.querySelector('input')) {
      return;
    }
    var seed = (record.titleSource === 'manual' && record.title) ? record.title : '';
    var input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 80;
    input.className = 'recent-projects-session-rename-input';
    input.value = seed;
    titleEl.hidden = true;
    row.insertBefore(input, titleEl);
    input.focus();
    input.select();
    var settled = false;
    var finish = function (commit) {
      if (settled) {
        return;
      }
      settled = true;
      var nextRaw = input.value;
      input.remove();
      titleEl.hidden = false;
      // Unchanged input is a cancel: never rewrites the title source.
      if (!commit || nextRaw.trim() === seed.trim()) {
        return;
      }
      commitDashboardSessionRename(sessionsEl, projectId, record, nextRaw).catch(function () { /* swallow */ });
    };
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', function () { finish(true); });
  }

  async function commitDashboardSessionRename(sessionsEl, projectId, record, rawTitle) {
    var SessionState = window.CodexOverleafSessionState;
    var StorageDb = window.CodexOverleafStorageDb;
    if (!SessionState) {
      return;
    }
    // Single source of truth for the ghost guard: the shared renameSession
    // helper decides manual vs auto exactly like the in-panel rename.
    var renamed = SessionState.renameSession(
      SessionState.normalizePanelState({ sessions: [record], activeSessionId: record.id }),
      record.id,
      rawTitle,
      { placeholderTitle: tr('newSessionFallback') }
    );
    var next = (renamed.sessions || []).find(function (session) { return session.id === record.id; });
    if (!next) {
      return;
    }
    try {
      await mutateProjectPanelState(projectId, function (state) {
        return SessionState.renameSession(state, record.id, rawTitle, { placeholderTitle: tr('newSessionFallback') });
      });
    } catch (_error) { /* blob may be absent; record update still proceeds */ }
    try {
      if (StorageDb) {
        await StorageDb.putRecord('sessions', StorageDb.buildSessionRecord(Object.assign({}, record, {
          title: next.title,
          titleSource: next.titleSource
        })));
      }
    } catch (_error) { /* swallow */ }
    await renderProjectSessions(sessionsEl, projectId);
  }

  function ensureRecentProjectsRoot() {
    if (!getPanel()) {
      return null;
    }
    var existing = getPanel().querySelector('[data-recent-projects-root]');
    if (existing) {
      return existing;
    }
    var rootEl = document.createElement('section');
    rootEl.className = 'recent-projects-root';
    rootEl.setAttribute('data-recent-projects-root', '');
    // Insert as a sibling of the existing per-project main / composer slots
    // so the variant lives inside the panel root (page-scoped) and the
    // existing data-view CSS rules can hide it when the per-project view is
    // active.
    getPanel().appendChild(rootEl);
    return rootEl;
  }

  // v1.8.1: synchronous dashboard shell for cold loads — flips the panel to
  // the recent-projects view and paints the header + loading line BEFORE the
  // async account-scope/IndexedDB work, so the per-project session UI never
  // flashes on /project.
  // v1.8.1: keep relative timestamps honest on a long-open dashboard tab.
  // Cheap text-only sweep — no re-render, no scroll reset.
  var relTimeTimer = null;
  function startRelativeTimeTicker() {
    if (relTimeTimer) {
      return;
    }
    relTimeTimer = setInterval(function () {
      if (document.visibilityState !== 'visible') {
        return;
      }
      var panelEl = getPanel();
      if (!panelEl || panelEl.dataset.view !== 'recent-projects') {
        return;
      }
      var nodes = panelEl.querySelectorAll('[data-rel-time]');
      for (var i = 0; i < nodes.length; i++) {
        var iso = nodes[i].getAttribute('data-rel-time');
        if (iso) {
          nodes[i].textContent = formatRelativeTime(iso);
        }
      }
    }, 60000);
  }

  function mountDashboardShell() {
    var panelEl = getPanel();
    if (!panelEl) {
      return;
    }
    panelEl.dataset.view = 'recent-projects';
    var rootEl = ensureRecentProjectsRoot();
    if (!rootEl || (rootEl.childNodes || []).length) {
      return;
    }
    rootEl.appendChild(renderWelcomeHeader());
    var loading = document.createElement('div');
    loading.className = 'recent-projects-loading';
    loading.textContent = tx('Loading projects\u2026', '正在加载项目…');
    rootEl.appendChild(loading);
  }

  async function renderRecentProjectsVariant(options) {
    if (!getPanel()) {
      return;
    }
    // Toggle panel into recent-projects mode. Page-scoped: never replaces
    // top-level page DOM. The existing data-view-driven CSS hides per-
    // project regions when the panel root carries this value.
    getPanel().dataset.view = 'recent-projects';
    startRelativeTimeTicker();
    var rootEl = ensureRecentProjectsRoot();
    if (!rootEl) {
      return;
    }
    rootEl.innerHTML = '';
    rootEl.appendChild(renderWelcomeHeader());

    var accountScopeId = (window.codexOverleafDeriveAccountScopeId || function () { return null; })();
    if (!accountScopeId) {
      rootEl.appendChild(renderDegradedState());
      rootEl.appendChild(renderSettingsEntry({ scope: 'account' }));
      opportunisticEnrichmentFromDom().catch(function () { /* swallow */ });
      return;
    }

    var listContainer = document.createElement('div');
    listContainer.className = 'recent-projects-list';
    listContainer.setAttribute('data-recent-projects-list', '');
    rootEl.appendChild(listContainer);

    // Slow IndexedDB reads must not render as "no projects": show a loading
    // line for the await window below (cleared before rows/empty render).
    var listLoading = document.createElement('div');
    listLoading.className = 'recent-projects-loading';
    listLoading.textContent = tx('Loading projects…', '正在加载项目…');
    listContainer.appendChild(listLoading);

    // Pre-warm the project-name cache mirror so the synchronous
    // `lookupProjectName` calls inside `renderRecentProjectRow` see the
    // latest data the first time the variant renders.
    try {
      await loadProjectNameCacheFromStorage();
    } catch (_error) { /* swallow; fall back to empty mirror */ }

    var rows = [];
    var showAll = Boolean(options && options.showAll);
    // Fetch one extra row beyond the fold so "show all" only renders when
    // there really is more than one page of projects.
    var pageLimit = 10;
    try {
      var StorageDb = window.CodexOverleafStorageDb;
      if (StorageDb) {
        var deletedSessionIdsByProject = await window.CodexOverleafSessionPersistence.loadTombstones();
        rows = await StorageDb.listRecentProjectsAcrossAccount({
          accountScopeId: accountScopeId,
          limit: showAll ? 500 : pageLimit + 1,
          deletedSessionIdsByProject: deletedSessionIdsByProject
        });
      }
    } catch (_error) {
      rows = [];
    }

    listLoading.remove();
    // v1.8.1 P2: a refresh must not clobber what the user had open — restore
    // every previously-expanded project and the scroll position.
    var restoreExpanded = Array.isArray(options && options.restoreExpanded) ? options.restoreExpanded : [];
    // v1.8.1 O1: fill the welcome subtitle with a real summary now that the
    // rows are known (header was painted before the async read).
    var welcomeSubtitle = rootEl.querySelector('.recent-projects-welcome-subtitle');
    if (welcomeSubtitle && rows && rows.length) {
      var sessionTotal = 0;
      for (var st = 0; st < rows.length; st++) {
        sessionTotal += Number(rows[st].sessionCount) || 1;
      }
      welcomeSubtitle.textContent = tr('recentProjects_welcome_stats', {
        projects: rows.length,
        sessions: sessionTotal
      });
    }
    var hasMore = !showAll && rows && rows.length > pageLimit;
    var visibleRows = hasMore ? rows.slice(0, pageLimit) : rows;
    if (!visibleRows || !visibleRows.length) {
      listContainer.appendChild(renderEmptyState());
    } else {
      for (var i = 0; i < visibleRows.length; i++) {
        listContainer.appendChild(renderRecentProjectRow(visibleRows[i]));
      }
    }
    if (hasMore) {
      var showAllButton = document.createElement('button');
      showAllButton.type = 'button';
      showAllButton.className = 'recent-projects-show-all';
      showAllButton.setAttribute('data-recent-projects-show-all', '');
      showAllButton.textContent = tx('Show all projects', '查看全部项目');
      showAllButton.addEventListener('click', function () {
        renderRecentProjectsVariant(Object.assign({}, options, { showAll: true }));
      });
      listContainer.appendChild(showAllButton);
    }
    rootEl.appendChild(renderSettingsEntry({ scope: 'account' }));
    var expandProjectId = options && options.expandProjectId;
    var toReopen = restoreExpanded.slice();
    if (expandProjectId && toReopen.indexOf(expandProjectId) === -1) {
      toReopen.push(expandProjectId);
    }
    for (var reopenIndex = 0; reopenIndex < toReopen.length; reopenIndex++) {
      var wrap = listContainer.querySelector('[data-project-row-wrap="' + toReopen[reopenIndex] + '"]');
      if (wrap) {
        toggleProjectSessions(wrap, toReopen[reopenIndex]);
      }
    }
    if (options && Number.isFinite(options.restoreScrollTop)) {
      rootEl.scrollTop = options.restoreScrollTop;
      var scrollerParent = rootEl.parentElement;
      if (scrollerParent && scrollerParent.scrollHeight > scrollerParent.clientHeight) {
        scrollerParent.scrollTop = options.restoreScrollTop;
      }
    }
    opportunisticEnrichmentFromDom().catch(function () { /* swallow */ });
  }

  function renderPerProjectVariant() {
    // Per-project mount: ensure the panel view attribute is back on the
    // session view and the variant root is detached so the per-project DOM
    // is the only thing visible. The existing applyStateToPanel path renders
    // the actual per-project UI; this function is the symmetric variant-
    // swap point for the SPA hook (spec §5.7.2 / acceptance §3).
    if (!getPanel()) {
      return;
    }
    if (getPanel().dataset.view === 'recent-projects') {
      getPanel().dataset.view = 'session';
    }
    getPanel().dataset.settingsScope = 'project';
    var existing = getPanel().querySelector('[data-recent-projects-root]');
    if (existing) {
      existing.remove();
    }
  }

    return {
      loadProjectNameCacheFromStorage,
      rememberCurrentProjectName,
      formatRelativeTime,
      textNode,
      renderStatusBadge,
      isValidProjectId,
      openProjectFromRow,
      renderRecentProjectRow,
      renderRecentProjectsVariant,
      mountDashboardShell,
      resetProjectNameCache,
      renderPerProjectVariant
    };
  }

  window.CodexOverleafRecentProjects = { create };
})();
