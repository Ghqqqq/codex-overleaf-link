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
      STATUS_BADGE_CLASS,
      ProjectSessionCleanup, SessionPersistence, SessionState, StorageDb, StorageKeys, StorageMigration
    } = deps;
    const projectSessionCleanup = ProjectSessionCleanup.create({
      tr, getAccountScopeId: getCachedAccountScopeId, showPluginConfirm, showPluginToast,
      sendBackgroundNative, mutateProjectPanelState, renderRecentProjectsVariant,
      SessionState, StorageDb, StorageMigration
    });

  // chrome.storage.local cache key (spec §5.6.3). The cache is keyed by
  // accountScopeId so a second account on the same Chrome profile cannot
  // see another account's project names.
  const PROJECT_NAME_CACHE_STORAGE_KEY = 'projectNameCacheByAccount';
  // In-memory mirror of the cache so `lookupProjectName` can be synchronous
  // (the row renderer is sync). The async loader populates this on panel
  // mount and on each opportunistic enrichment call.
  let projectNameCacheMirror = {};
  let dashboardRenderGeneration = 0;

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
          var rows = visibleList.querySelectorAll('[data-project-id]');
          for (var k = 0; k < rows.length; k++) {
            var row = rows[k];
            var rowPid = row.getAttribute('data-project-id');
            var nameEl = row.querySelector('.recent-projects-row-name');
            if (rowPid && nameEl) {
              var cached = lookupProjectName(rowPid);
              if (cached) {
                nameEl.textContent = cached;
                nameEl.title = cached;
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
    if (day < 30) return tx(day + (day === 1 ? ' day ago' : ' days ago'), day + ' 天前');
    var month = Math.round(day / 30);
    if (month < 12) return tx(month + ' mo ago', month + ' 个月前');
    var year = Math.round(month / 12);
    return tx(year + ' yr ago', year + ' 年前');
  }

  function createViewElement(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function createViewButton(label, onClick, attribute, className) {
    var button = createViewElement('button', className, label);
    button.type = 'button';
    if (attribute) button.setAttribute(attribute, '');
    if (onClick) button.addEventListener('click', onClick);
    return button;
  }

  function textNode(text, className) {
    return createViewElement('span', className, text == null ? '' : String(text));
  }

  function renderWelcomeHeader() {
    var el = createViewElement('div', 'recent-projects-welcome');
    el.setAttribute('data-recent-projects-welcome', '');
    el.appendChild(textNode('CODEX', 'recent-projects-eyebrow'));
    el.appendChild(textNode(tr('recentProjects_welcome'), 'recent-projects-welcome-title'));
    el.appendChild(textNode(tr('recentProjects_welcome_subtitle'), 'recent-projects-welcome-subtitle'));
    return el;
  }

  function renderEmptyState() {
    var el = createViewElement('div', 'recent-projects-empty', tr('recentProjects_empty'));
    el.setAttribute('data-recent-projects-empty', '');
    return el;
  }

  function renderDegradedState() {
    var el = createViewElement('div', 'recent-projects-degraded');
    el.setAttribute('data-recent-projects-degraded', '');
    // v1.8.1: the user IS signed in on /project — telling them to sign in
    // was a dead end. Explain the real condition and offer a retry.
    var hint = createViewElement('div', '', tr('recentProjects_degraded_hint'));
    el.appendChild(hint);
    var retry = createViewButton(tr('recentProjects_retryScope'), function () {
      if (typeof refreshAccountScopeId === 'function') {
        Promise.resolve(refreshAccountScopeId())
          .then(function () { return renderRecentProjectsVariant(); })
          .catch(function () { /* stays degraded */ });
      } else {
        renderRecentProjectsVariant();
      }
    }, 'data-recent-projects-retry', 'recent-projects-show-all');
    el.appendChild(retry);
    return el;
  }

  // Spec §5.9 — settings entry, scope-aware. The "account" scope hides
  // project-only sections inside the settings page (governance, sensitive,
  // skills tied to projects, custom instructions, project diagnostics).
  function renderSettingsEntry(options) {
    var scope = options && options.scope === 'account' ? 'account' : 'project';
    var entry = createViewButton(undefined, function () {
      openSettingsInScope(scope);
    }, 'data-recent-projects-settings-entry', 'recent-projects-settings-entry');
    entry.setAttribute('data-settings-scope', scope);
    entry.appendChild(textNode(tr('recentProjects_settings_entry'), 'recent-projects-settings-entry-label'));
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
    var el = textNode(tr('recentProjects_badge_' + safeStatus), 'recent-projects-row-badge ' + cls);
    el.setAttribute('data-status', safeStatus);
    return el;
  }

  function isValidProjectId(id) {
    return typeof id === 'string' && /^[a-f0-9]{24}$/.test(id) && !PROJECT_EDITOR_RESERVED_IDS.has(id);
  }

  function openProjectFromRow(projectId) {
    if (!isValidProjectId(projectId)) {
      return;
    }
    var origin = 'https://www.overleaf.com';
    try {
      var current = new URL(window.location.href);
      if (current.protocol === 'https:' && !current.port
        && ['overleaf.com', 'www.overleaf.com', 'cn.overleaf.com'].includes(current.hostname)) {
        origin = current.origin;
      }
    } catch (_error) { /* Non-page callers retain the canonical fallback. */ }
    window.location.assign(origin + '/project/' + encodeURIComponent(projectId));
  }

  function renderActionsMenu(buttons) {
    var menu = createViewElement('details', 'recent-projects-menu');
    var trigger = createViewElement('summary', '', '\u22ef');
    trigger.title = tr('recentProjects_more');
    trigger.setAttribute('aria-label', tr('recentProjects_more'));
    var actions = document.createElement('div');
    actions.setAttribute('data-recent-menu-actions', '');
    buttons.forEach(function (button) { actions.appendChild(button); });
    actions.addEventListener('click', function (event) {
      if (event.target.closest('button')) {
        menu.open = false;
        trigger.focus();
      }
    }, true);
    menu.appendChild(trigger);
    menu.appendChild(actions);
    menu.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        menu.open = false;
        trigger.focus();
      }
    });
    menu.addEventListener('focusout', function (event) {
      if (event.relatedTarget && !menu.contains(event.relatedTarget)) menu.open = false;
    });
    return menu;
  }

  function conversationActivity(record) {
    return String(record && (record.lastActivityAt || record.updatedAt || record.createdAt) || '');
  }

  function conversationHasContent(record) {
    return ['runs', 'history', 'pendingInputs'].some(function (key) {
      return Array.isArray(record[key]) && record[key].length > 0;
    }) || ['task', 'safeTaskSummary', 'codexThreadId'].some(function (key) {
      return typeof record[key] === 'string' && Boolean(record[key].trim());
    }) || (record.titleSource === 'manual' && typeof record.title === 'string' && Boolean(record.title.trim()));
  }

  function conversationStatus(record) {
    if (!StorageDb || !Array.isArray(record.runs) || !record.runs.length) return '';
    return settleDashboardRunStatus(StorageDb.derivePrimaryStatusBadge(record), conversationActivity(record));
  }

  function projectDisplayName(projectId) {
    return lookupProjectName(projectId) || (isValidProjectId(projectId)
      ? tr('recentProjects_unnamed', { prefix: projectId.slice(0, 8) })
      : tr('recentProjects_row_projectLinkUnavailable'));
  }

  async function loadDashboardConversations(scope) {
    if (!scope || !StorageDb) throw new Error('Conversation storage is unavailable.');
    var results = await Promise.all([StorageDb.getAllSessions(), SessionPersistence.loadTombstones()]);
    var records = results[0];
    var deletedByProject = results[1] || {};
    if (!Array.isArray(records)) throw new Error('Conversation history could not be read.');
    return records.filter(function (record) {
      if (!record || typeof record.id !== 'string' || !record.id || record.accountScopeUnavailable === true) return false;
      var deletedIds = Object.prototype.hasOwnProperty.call(deletedByProject, record.projectId)
        ? deletedByProject[record.projectId] : [];
      return SessionPersistence.isVisibleRecord(record, Array.isArray(deletedIds) ? deletedIds : [], scope);
    }).sort(function (a, b) {
      var aTime = Date.parse(conversationActivity(a)) || 0;
      var bTime = Date.parse(conversationActivity(b)) || 0;
      return bTime - aTime || String(a.id).localeCompare(String(b.id));
    });
  }

  function dashboardViewOptions() {
    var root = getPanel() && getPanel().querySelector('[data-recent-projects-root]');
    var drafts = root && root.querySelector('[data-unstarted-conversations]');
    return {
      accountScopeId: root && root.dataset.accountScopeId || '',
      projectFilter: root && root.dataset.projectFilter || '',
      showAll: Boolean(root && root.dataset.showAll === 'true'),
      draftsOpen: Boolean(drafts && drafts.open),
      restoreScrollTop: root ? root.scrollTop : 0
    };
  }

  async function refreshDashboardView() {
    var panelEl = getPanel();
    if (panelEl && panelEl.dataset.view === 'recent-projects') {
      await renderRecentProjectsVariant(dashboardViewOptions());
    }
  }

  async function openDashboardConversation(projectId, record, row) {
    var scope = record.accountScopeId;
    var panelEl = getPanel();
    if (!scope || scope !== getCachedAccountScopeId() || !isValidProjectId(projectId)
      || !panelEl || panelEl.dataset.view !== 'recent-projects' || row.getAttribute('aria-busy') === 'true') return;
    row.setAttribute('aria-busy', 'true');
    var resume = row.querySelector('[data-session-resume]');
    if (resume) resume.disabled = true;
    try {
      var records = await loadProjectSessionRecords(projectId);
      if (scope !== getCachedAccountScopeId() || panelEl !== getPanel()
        || panelEl.dataset.view !== 'recent-projects' || row.isConnected === false) return;
      var selected = records.find(function (candidate) { return candidate.id === record.id; });
      if (!selected) {
        await refreshDashboardView();
        showPluginToast(tr('recentProjects_conversationGone'), { status: 'warning' });
        return;
      }
      await activateSessionAndOpenProject(projectId, selected);
    } catch (_error) {
      if (scope === getCachedAccountScopeId() && row.isConnected !== false) {
        showPluginToast(tr('recentProjects_continueFailed'), { status: 'warning' });
      }
    } finally {
      row.removeAttribute('aria-busy');
      if (resume) resume.disabled = false;
    }
  }

  // Kept as a compatibility entry point and as the recovery path for invalid project links.
  function renderRecentProjectRow(row) {
    var projectId = row && row.projectId;
    var valid = isValidProjectId(projectId);
    var wrap = createViewElement('div', 'recent-projects-row-wrap recent-projects-unavailable-row');
    wrap.setAttribute('data-project-id', projectId || '');
    var link = createViewButton(undefined, null, 'data-recent-projects-row', 'recent-projects-row');
    link.setAttribute('data-project-id', projectId || '');
    link.disabled = !valid;
    link.appendChild(textNode(projectDisplayName(projectId), 'recent-projects-row-name'));
    if (valid) link.addEventListener('click', function () { openProjectFromRow(projectId); });
    var cleanup = createViewButton(tr(valid ? 'recentProjects_clearProject' : 'recentProjects_cleanup'), function () {
      if (valid) projectSessionCleanup.clearProjectSessions(projectId, projectDisplayName(projectId)).catch(function () {});
      else cleanupDeadProjectEntry(projectId).catch(function () {});
    }, valid ? 'data-project-clear' : 'data-row-cleanup');
    wrap.appendChild(link);
    wrap.appendChild(renderActionsMenu([cleanup]));
    return wrap;
  }

  function sessionRecordDisplayTitle(record) {
    if (record && typeof record.title === 'string' && record.title.trim()) {
      return record.title.trim();
    }
    var derived = SessionState ? SessionState.deriveSessionTitle(record && record.runs, record && record.task) : '';
    return derived || tr('newSessionFallback');
  }

  async function loadProjectSessionRecords(projectId) {
    if (!StorageDb) {
      return [];
    }
    var records = await StorageDb.getAllByIndex('sessions', 'projectId', projectId);
    var Persistence = SessionPersistence;
    var deletedIds = await Persistence.getDeletedSessionIds(projectId);
    var scope = getCachedAccountScopeId();
    return (records || [])
      .filter(function (record) { return Persistence.isVisibleRecord(record, deletedIds, scope); })
      .sort(function (a, b) {
        return String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''));
      });
  }

  function renderProjectSessionRow(sessionsEl, projectId, record, options) {
    var featured = Boolean(options && options.featured);
    var running = Boolean(StorageDb)
      && settleDashboardRunStatus(StorageDb.derivePrimaryStatusBadge(record), record.updatedAt || record.lastActivityAt) === 'running';
    var row = createViewElement('div', 'recent-projects-session-row' + (featured ? ' recent-projects-focus' : ''));
    row.setAttribute('data-project-session-row', record.id);
    row.setAttribute('data-project-id', projectId);
    if (running) row.setAttribute('data-running', 'true');
    var title = textNode(sessionRecordDisplayTitle(record), 'recent-projects-session-title');
    title.title = title.textContent;
    var copy = createViewElement('div', 'recent-projects-session-copy');
    var meta = createViewElement('div', 'recent-projects-session-meta');
    var project = textNode(projectDisplayName(projectId), 'recent-projects-row-name');
    project.title = project.textContent;
    meta.appendChild(project);
    var time = textNode(formatRelativeTime(conversationActivity(record)), 'recent-projects-session-time');
    time.setAttribute('data-rel-time', conversationActivity(record));
    time.title = conversationActivity(record);
    var status = conversationStatus(record);
    var footer = featured ? createViewElement('div', 'recent-projects-focus-footer') : null;
    if (featured) {
      meta.insertBefore(textNode(tr('recentProjects_focusEyebrow'), 'recent-projects-focus-eyebrow'), project);
      copy.appendChild(meta);
      copy.appendChild(title);
      footer.appendChild(status ? renderStatusBadge(status)
        : textNode(tr('recentProjects_savedDraft'), 'recent-projects-row-badge'));
    } else {
      copy.appendChild(title);
      copy.appendChild(meta);
      if (['failed', 'needs_review', 'interrupted', 'stale', 'needs_review_after_navigation', 'abandoned_after_navigation'].indexOf(status) !== -1) {
        var attention = textNode(tr('recentProjects_attention'), 'recent-projects-session-attention');
        attention.title = tr('recentProjects_badge_' + status);
        meta.appendChild(attention);
      }
    }
    meta.appendChild(time);
    row.appendChild(copy);

    var rename = createViewButton(tr('renameSession'), function () {
      beginDashboardSessionRename(sessionsEl, projectId, record, row, title);
    }, 'data-session-rename-dash');
    rename.title = rename.textContent;
    rename.setAttribute('aria-label', rename.textContent);
    if (running) rename.disabled = true;
    var del = createViewButton(tr('deleteSession'), function () {
      deleteDashboardSession(sessionsEl, projectId, record).catch(function () {});
    }, 'data-session-delete-dash');
    del.title = running ? tr('recentProjects_zombieRunningNote') : del.textContent;
    del.setAttribute('aria-label', del.textContent);
    var projectConversations = createViewButton(tr('recentProjects_projectConversations'), function () {
      renderRecentProjectsVariant({ projectFilter: projectId, showAll: true, restoreScrollTop: 0 }).catch(function () {});
    }, 'data-project-conversations');
    var openProject = createViewButton(tr('recentProjects_openProject'), function () { openProjectFromRow(projectId); });
    var clear = createViewButton(tr('recentProjects_clearProject'), function () {
      projectSessionCleanup.clearProjectSessions(projectId, projectDisplayName(projectId)).catch(function () {});
    }, 'data-project-clear');
    row.appendChild(renderActionsMenu([rename, del, projectConversations, openProject, clear]));

    var activate = function () { openDashboardConversation(projectId, record, row).catch(function () {}); };
    if (featured) {
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', tr('recentProjects_focusEyebrow'));
      var resume = createViewButton(tr('recentProjects_continue'), activate, 'data-session-resume', 'recent-projects-continue');
      resume.title = tr('recentProjects_continueHint');
      footer.appendChild(resume);
      row.appendChild(footer);
    } else {
      row.classList.add('recent-projects-session-row--linked');
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.addEventListener('click', function (event) {
        if (!event.target.closest('button, input, details')) activate();
      });
      row.addEventListener('keydown', function (event) {
        if (event.target === row && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          activate();
        }
      });
    }
    return row;
  }

  async function activateSessionAndOpenProject(projectId, record) {
    var Migration = StorageMigration;
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
    return StorageKeys.getProjectStorageKey(PANEL_STATE_BASE_KEY, 'https://www.overleaf.com/project/' + projectId);
  }

  // Apply `mutate(normalizedState) -> nextState` to the project's stored panel
  // state and write it back compacted — the same normalize/prepare pipeline
  // saveState uses, so opening the project later sees a coherent state.
  // NOTE: if the project is open in another tab, that tab's in-memory state
  // wins on its next save; the IndexedDB record mutation below still holds.
  async function mutateProjectPanelState(projectId, mutate) {
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
    await SessionPersistence.addTombstones(projectId, [record.id]);
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
    await refreshDashboardView();
  }

  function beginDashboardSessionRename(sessionsEl, projectId, record, row, titleEl) {
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
    titleEl.parentElement.insertBefore(input, titleEl);
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
    await refreshDashboardView();
  }

  function ensureRecentProjectsRoot() {
    if (!getPanel()) {
      return null;
    }
    var existing = getPanel().querySelector('[data-recent-projects-root]');
    if (existing) {
      return existing;
    }
    var rootEl = createViewElement('section', 'recent-projects-root');
    rootEl.setAttribute('data-recent-projects-root', '');
    rootEl.addEventListener('click', function (event) {
      rootEl.querySelectorAll('.recent-projects-menu[open]').forEach(function (menu) {
        if (!menu.contains(event.target)) menu.open = false;
      });
    });
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
    var loading = createViewElement('div', 'recent-projects-loading', tx('Loading projects\u2026', '正在加载项目…'));
    rootEl.appendChild(loading);
  }

  async function renderRecentProjectsVariant(options) {
    var panelEl = getPanel();
    var editorMatch = String(window.location && window.location.pathname || '').match(/^\/project\/([a-f0-9]{24})(?:\/|$)/);
    if (!panelEl || (editorMatch && isValidProjectId(editorMatch[1]))) return;
    var previous = dashboardViewOptions();
    options = Object.assign({}, previous, options || {});
    var generation = ++dashboardRenderGeneration;
    panelEl.dataset.view = 'recent-projects';
    startRelativeTimeTicker();
    var rootEl = ensureRecentProjectsRoot();
    if (!rootEl) return;
    var accountScopeId = (window.codexOverleafDeriveAccountScopeId || function () { return null; })();
    if (previous.accountScopeId !== accountScopeId) {
      options.projectFilter = '';
      options.showAll = options.draftsOpen = false;
    }
    var projectFilter = isValidProjectId(options.projectFilter) ? options.projectFilter : '';
    rootEl.dataset.accountScopeId = accountScopeId || '';
    rootEl.dataset.projectFilter = projectFilter;
    rootEl.dataset.showAll = options.showAll ? 'true' : 'false';
    rootEl.innerHTML = '';
    rootEl.appendChild(renderWelcomeHeader());
    if (!accountScopeId) {
      rootEl.appendChild(renderDegradedState());
      rootEl.appendChild(renderSettingsEntry({ scope: 'account' }));
      return;
    }
    if (projectFilter) {
      var filterBar = createViewElement('div', 'recent-projects-filter');
      var back = createViewButton(tr('recentProjects_allProjects'), function () {
        renderRecentProjectsVariant({ projectFilter: '', showAll: false, restoreScrollTop: 0 }).catch(function () {});
      });
      filterBar.appendChild(back);
      var filterName = textNode(projectDisplayName(projectFilter));
      filterName.title = filterName.textContent;
      filterBar.appendChild(filterName);
      rootEl.appendChild(filterBar);
    }
    var listContainer = createViewElement('div', 'recent-projects-list');
    listContainer.setAttribute('data-recent-projects-list', '');
    rootEl.appendChild(listContainer);
    var loading = textNode(tr('recentProjects_loadingHistory'), 'recent-projects-loading');
    listContainer.appendChild(loading);
    function stillCurrent() {
      return generation === dashboardRenderGeneration && getPanel() === panelEl
        && panelEl.dataset.view === 'recent-projects' && rootEl.isConnected !== false
        && getCachedAccountScopeId() === accountScopeId;
    }
    var records;
    try {
      await loadProjectNameCacheFromStorage();
      records = await loadDashboardConversations(accountScopeId);
    } catch (_error) {
      if (!stillCurrent()) return;
      loading.textContent = tr('recentProjects_loadFailed');
      var retry = createViewButton(tr('recentProjects_retryScope'), function () {
        renderRecentProjectsVariant(options).catch(function () {});
      }, null, 'recent-projects-show-all');
      listContainer.appendChild(retry);
      rootEl.appendChild(renderSettingsEntry({ scope: 'account' }));
      return;
    }
    if (!stillCurrent()) return;
    loading.remove();
    var validRecords = records.filter(function (record) {
      return isValidProjectId(record.projectId) && (!projectFilter || record.projectId === projectFilter);
    });
    var started = validRecords.filter(conversationHasContent);
    var unstarted = validRecords.filter(function (record) { return !conversationHasContent(record); });
    if (started.length) {
      listContainer.appendChild(renderProjectSessionRow(listContainer, started[0].projectId, started[0], { featured: true }));
      if (started.length > 1) {
        var heading = createViewElement('div', 'recent-projects-history-heading');
        heading.appendChild(textNode(tr('recentProjects_historyHeading')));
        heading.appendChild(textNode(tr('recentProjects_historyHint')));
        listContainer.appendChild(heading);
        var historyList = createViewElement('div', 'recent-projects-history-list');
        var history = options.showAll ? started.slice(1) : started.slice(1, 10);
        history.forEach(function (record) {
          historyList.appendChild(renderProjectSessionRow(historyList, record.projectId, record));
        });
        listContainer.appendChild(historyList);
        if (!options.showAll && started.length > 10) {
          var more = createViewButton(tr('recentProjects_showAllConversations', { count: started.length }), function () {
            renderRecentProjectsVariant({ showAll: true }).catch(function () {});
          }, 'data-recent-projects-show-all', 'recent-projects-show-all');
          listContainer.appendChild(more);
        }
      }
    } else {
      var empty = renderEmptyState();
      if (unstarted.length) empty.textContent = tr('recentProjects_noStarted');
      listContainer.appendChild(empty);
    }
    if (unstarted.length) {
      var drafts = createViewElement('details', 'recent-projects-drafts');
      drafts.setAttribute('data-unstarted-conversations', '');
      var summary = createViewElement('summary', '', tr('recentProjects_unstarted', { count: unstarted.length }));
      drafts.appendChild(summary);
      var draftsBuilt = false;
      function populateDrafts() {
        if (draftsBuilt || !stillCurrent()) return;
        draftsBuilt = true;
        drafts.appendChild(textNode(tr('recentProjects_unstartedHint'), 'recent-projects-drafts-hint'));
        unstarted.forEach(function (record) {
          drafts.appendChild(renderProjectSessionRow(drafts, record.projectId, record));
        });
      }
      drafts.addEventListener('toggle', function () { if (drafts.open) populateDrafts(); });
      listContainer.appendChild(drafts);
      if (options.draftsOpen) { drafts.open = true; populateDrafts(); }
    }
    if (!projectFilter) {
      var invalid = records.filter(function (record) { return !isValidProjectId(record.projectId); });
      var invalidIds = new Set();
      if (invalid.length) listContainer.appendChild(textNode(tr('recentProjects_unavailableRecords'), 'recent-projects-history-heading'));
      invalid.forEach(function (record) {
        var id = String(record.projectId || '');
        if (!invalidIds.has(id)) {
          invalidIds.add(id);
          listContainer.appendChild(renderRecentProjectRow({ projectId: record.projectId }));
        }
      });
    }
    rootEl.appendChild(renderSettingsEntry({ scope: 'account' }));
    if (Number.isFinite(options.restoreScrollTop)) rootEl.scrollTop = options.restoreScrollTop;
    opportunisticEnrichmentFromDom().catch(function () {});
  }

  function renderPerProjectVariant() {
    dashboardRenderGeneration++;
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
      readCurrentProjectNameFromDom,
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
