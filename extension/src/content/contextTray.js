(function initCodexOverleafContextTray(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/projectFiles'));
  } else {
    root.CodexOverleafModuleRegistry.define('ContextTray', ['ProjectFiles'], factory);
  }
})(typeof window !== 'undefined' ? window : globalThis, function contextTrayFactory(ProjectFiles) {
  'use strict';

  const DEFAULT_CONTEXT_EXACT_FILE_LIST_ZIP_TIMEOUT_MS = 30000;

  // Destructuring defaults handle the "dep omitted" case. Production callers
  // always pass real functions; tests that exercise partial wiring can rely
  // on undefined-only defaults to reach the noop. Passing `null` or a non-
  // function value is no longer silently coerced — that was an antipattern
  // (the typeof guards used to hide a missing wire-up by swapping in a noop).
  function createContextTrayController({
    root = (typeof window !== 'undefined' ? window : globalThis),
    document: documentDep = null,
    getPanel = () => null,
    getState = () => null,
    setState = () => {},
    saveState = null,
    saveStateSoon = () => {},
    updateActiveSession = defaultUpdateActiveSession,
    callPageBridge = () => Promise.resolve({ ok: false }),
    getCurrentProjectId = () => '',
    getLocationHref: getLocationHrefDep,
    tr = (key) => key,
    closeModelConfigPopover = () => {},
    closeDiagnosticsMenu = () => {},
    closeCustomInstructionsSettings = () => {},
    closeSlashMenu = () => {},
    projectFiles: projectFilesDep,
    exactFileListZipTimeoutMs: exactFileListZipTimeoutMsDep
  } = {}) {
    const document = documentDep
      || root.document
      || (typeof globalThis !== 'undefined' ? globalThis.document : null);
    const getLocationHref = getLocationHrefDep || (() => root.location?.href || '');
    const projectFiles = projectFilesDep || ProjectFiles;
    const exactFileListZipTimeoutMs = Number(exactFileListZipTimeoutMsDep) ||
      DEFAULT_CONTEXT_EXACT_FILE_LIST_ZIP_TIMEOUT_MS;

    let contextProject = null;
    let contextLoadId = 0;
    let contextExpandedFolders = new Set();
    let contextExactEnhancementAttempted = false;
    let contextSyncState = 'idle';
    let contextPrefetchTimer = null;
    let contextPrefetchIdleHandle = null;

    function cancelContextPrefetch() {
      if (contextPrefetchTimer !== null) {
        const clearTimer = typeof root.clearTimeout === 'function' ? root.clearTimeout.bind(root) : clearTimeout;
        clearTimer(contextPrefetchTimer);
        contextPrefetchTimer = null;
      }
      if (contextPrefetchIdleHandle !== null && typeof root.cancelIdleCallback === 'function') {
        root.cancelIdleCallback(contextPrefetchIdleHandle);
        contextPrefetchIdleHandle = null;
      }
    }

    function scheduleContextPrefetch(options = {}) {
      cancelContextPrefetch();
      const enabled = Object.prototype.hasOwnProperty.call(options, 'enabled')
        ? Boolean(options.enabled)
        : getState()?.preloadProjectContext !== false;
      const expectedProjectId = String(getCurrentProjectId() || '');
      if (!enabled || !expectedProjectId) {
        return;
      }
      const delayMs = Number.isFinite(Number(options.delayMs))
        ? Math.max(0, Number(options.delayMs))
        : 2500;
      const setTimer = typeof root.setTimeout === 'function' ? root.setTimeout.bind(root) : setTimeout;
      contextPrefetchTimer = setTimer(() => {
        contextPrefetchTimer = null;
        const currentProjectId = String(getCurrentProjectId() || '');
        if (getState()?.preloadProjectContext === false || document?.visibilityState === 'hidden') {
          return;
        }
        if (currentProjectId !== expectedProjectId) {
          scheduleContextPrefetch({ delayMs: 500 });
          return;
        }
        const run = () => {
          contextPrefetchIdleHandle = null;
          void loadContextFiles({ force: false, background: true });
        };
        if (typeof root.requestIdleCallback === 'function') {
          contextPrefetchIdleHandle = root.requestIdleCallback(run, { timeout: 2000 });
        } else {
          run();
        }
      }, delayMs);
      contextPrefetchTimer?.unref?.();
    }

    function installContextDismiss() {
      if (!document) {
        return;
      }
      document.addEventListener('change', event => {
        const target = event?.target;
        if (!target?.matches?.('[data-preload-project-context]')) {
          return;
        }
        const enabled = Boolean(target.checked);
        setState({ ...getState(), preloadProjectContext: enabled });
        saveStateSoon();
        if (enabled) {
          scheduleContextPrefetch({ enabled: true, delayMs: 0 });
        } else {
          cancelContextPrefetch();
        }
      }, true);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'hidden') {
          scheduleContextPrefetch();
        }
      });
      scheduleContextPrefetch();

      document.addEventListener('click', event => {
        if (isContextTrayClickTarget(event.target)) {
          return;
        }
        closeContextTray();
      }, true);
      document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') {
          return;
        }
        // Layered dismissal: if the slash menu is open above the tray, let
        // its own Escape handler close it first — one Escape, one layer.
        const slashMenu = getPanel()?.querySelector('[data-slash-menu]');
        if (slashMenu && !slashMenu.hidden) {
          return;
        }
        const tray = getPanel()?.querySelector('[data-context-tray]');
        if (tray && !tray.hidden) {
          closeContextTray();
        }
      }, true);
    }

    function isContextTrayClickTarget(target) {
      const panel = getPanel();
      const tray = panel?.querySelector('[data-context-tray]');
      const button = panel?.querySelector('[data-add-context]');
      return Boolean(
        (tray && tray.contains(target)) ||
        (button && button.contains(target))
      );
    }

    function toggleContextTray() {
      const panel = getPanel();
      const tray = panel?.querySelector('[data-context-tray]');
      const button = panel?.querySelector('[data-add-context]');
      if (!tray || !button) {
        return;
      }

      const open = tray.hidden;
      if (open) {
        closeModelConfigPopover();
        closeDiagnosticsMenu();
        closeCustomInstructionsSettings();
        closeSlashMenu();
      }
      tray.hidden = !open;
      button.dataset.active = open ? 'true' : 'false';
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      renderContextSelection();
      if (open) {
        loadContextFiles({ force: false });
      }
    }

    function closeContextTray() {
      const panel = getPanel();
      const tray = panel?.querySelector('[data-context-tray]');
      const button = panel?.querySelector('[data-add-context]');
      if (!tray || !button) {
        return;
      }
      tray.hidden = true;
      button.dataset.active = 'false';
      button.setAttribute('aria-expanded', 'false');
    }

    async function loadContextFiles(options = {}) {
      const list = getPanel()?.querySelector('[data-context-file-list]');
      if (!list) {
        return;
      }
      if (isContextFileListProject(contextProject) && !options.force) {
        renderContextFiles(contextProject);
        if (isExactContextFileListProject(contextProject)) {
          setContextSyncState('exact-ready');
        } else if (contextSyncState !== 'partial') {
          setContextSyncState('exact-loading');
          void enhanceContextFilesFromExactSnapshot({ loadId: contextLoadId });
        }
        return;
      }

      const loadId = ++contextLoadId;
      setContextSyncState('tree-loading');
      setContextStatus(tr('contextLoadingFiles'));
      list.textContent = '';

      try {
        const project = await requestContextFiles({ force: Boolean(options.force) });
        if (!project?.ok) {
          throw new Error(project?.error || project?.reason || tr('unknownReason'));
        }
        if (loadId !== contextLoadId) {
          return;
        }
        contextProject = project;
        setContextSyncState(isExactContextFileListProject(project) ? 'exact-ready' : 'exact-loading');
        renderContextFiles(project);
        if (!isExactContextFileListProject(project)) {
          void enhanceContextFilesFromExactSnapshot({
            force: Boolean(options.force),
            loadId
          });
        }
      } catch (error) {
        if (loadId !== contextLoadId) {
          return;
        }
        setContextSyncState('partial');
        setContextStatus(tr('contextReadFailed', { message: error.message }));
      }
    }

    async function requestContextFiles({ force = false } = {}) {
      const project = await callPageBridge('getProjectFileList', {
        force,
        preferExact: false
      });
      if (
        project?.ok
        && isContextFileListProject(project)
        && Array.isArray(project.files)
        && project.files.length
      ) {
        return project;
      }
      return requestExactContextFiles({ force });
    }

    async function requestExactContextFiles({ force = false } = {}) {
      return callPageBridge('getProjectFileList', {
        force,
        preferExact: true,
        exactOnly: true,
        includeBinaryFiles: true,
        includeContent: false,
        zipTimeoutMs: exactFileListZipTimeoutMs
      });
    }

    async function enhanceContextFilesFromExactSnapshot({ force = false, loadId = contextLoadId } = {}) {
      if (isExactContextFileListProject(contextProject)) {
        setContextSyncState('exact-ready');
        return;
      }
      if (contextExactEnhancementAttempted && !force) {
        return;
      }
      contextExactEnhancementAttempted = true;
      setContextSyncState('exact-loading');
      const expectedProjectId = String(contextProject?.id || getCurrentProjectId() || '');
      try {
        const project = await requestExactContextFiles({ force });
        if (
          loadId !== contextLoadId
          || expectedProjectId && String(project.id || '') !== expectedProjectId
        ) {
          return;
        }
        if (!isExactContextFileListProject(project)) {
          setContextSyncState('partial');
          return;
        }
        contextProject = project;
        setContextSyncState('exact-ready');
        renderContextFiles(project);
      } catch (_error) {
        // The page file tree remains usable when the optional exact ZIP list is unavailable.
        if (loadId === contextLoadId) {
          setContextSyncState('partial');
        }
      }
    }

    function isExactContextFileListProject(project) {
      return project?.ok && project?.capabilities?.method === 'overleaf-zip-file-list';
    }

    function isContextFileListProject(project) {
      const method = project?.capabilities?.method;
      return method === 'overleaf-zip-file-list' || method === 'overleaf-file-tree';
    }

    function normalizeContextFileListFromZipSnapshot(project) {
      const files = Array.isArray(project?.files) ? project.files : [];
      if (project?.capabilities?.method !== 'overleaf-zip' || !files.length) {
        return {
          ok: false,
          id: project?.id || getCurrentProjectId(),
          url: project?.url || getLocationHref(),
          activePath: project?.activePath || '',
          files: [],
          error: getZipSnapshotFailureReason(project),
          capabilities: {
            ...(project?.capabilities || {}),
            method: project?.capabilities?.method || 'overleaf-zip-file-list-unavailable',
            fullProjectSnapshot: false
          }
        };
      }

      return {
        ok: true,
        id: project.id || getCurrentProjectId(),
        url: project.url || getLocationHref(),
        activePath: project.activePath || '',
        files: files
          .map(file => normalizeContextFileFromZipSnapshot(file, project.activePath || ''))
          .filter(Boolean),
        capabilities: {
          ...(project.capabilities || {}),
          method: 'overleaf-zip-file-list',
          fullProjectSnapshot: true,
          note: 'Listed Overleaf project files from the exact source ZIP snapshot used by project-read diagnostics.'
        }
      };
    }

    function normalizeContextFileFromZipSnapshot(file, activePath) {
      const path = normalizeProjectPath(file?.path);
      if (!path) {
        return null;
      }
      const isText = isTextProjectPath(path);
      return {
        path,
        active: path === activePath,
        source: 'overleaf-zip',
        kind: isText ? 'text' : 'binary',
        selectable: isText
      };
    }

    function getZipSnapshotFailureReason(project) {
      const skipped = Array.isArray(project?.capabilities?.skipped) ? project.capabilities.skipped : [];
      const zipFailure = skipped.find(item => item?.path === 'project.zip' && item.reason);
      return project?.error
        || project?.reason
        || zipFailure?.reason
        || tr('unknownReason');
    }

    function renderContextFiles(project) {
      const list = getPanel()?.querySelector('[data-context-file-list]');
      if (!list) {
        return;
      }

      list.textContent = '';
      const contextFileProject = project || contextProject;
      const files = getContextProjectFiles(contextFileProject?.files || []);
      renderContextSelection();

      if (!files.length) {
        setContextStatus(tr('contextNoFiles'));
        return;
      }

      const selected = getActiveFocusFiles();
      setContextStatus(selected.length
        ? tr('contextSelectedFiles', { count: selected.length })
        : tr('contextDefaultWholeProject'));

      const tree = buildContextTree(files);
      for (const child of tree.children) {
        renderContextTreeNode(child, list, selected, 0);
      }
    }

    function getContextProjectFiles(files = []) {
      const seen = new Set();
      const result = [];
      for (const file of files) {
        if (!file?.path || seen.has(file.path)) {
          continue;
        }
        seen.add(file.path);
        result.push(file);
      }
      return result;
    }

    function buildContextTree(files = []) {
      const rootNode = { type: 'folder', name: '', path: '', children: [] };
      const folderByPath = new Map([['', rootNode]]);

      for (const file of files) {
        if (!file?.path) {
          continue;
        }
        const parts = file.path.split('/').filter(Boolean);
        if (!parts.length) {
          continue;
        }
        let parent = rootNode;
        let folderPath = '';
        for (const part of parts.slice(0, -1)) {
          folderPath = folderPath ? `${folderPath}/${part}` : part;
          let folder = folderByPath.get(folderPath);
          if (!folder) {
            folder = { type: 'folder', name: part, path: folderPath, children: [] };
            folderByPath.set(folderPath, folder);
            parent.children.push(folder);
          }
          parent = folder;
        }
        parent.children.push({
          type: 'file',
          name: parts[parts.length - 1],
          path: file.path,
          file
        });
      }

      sortContextTree(rootNode);
      return rootNode;
    }

    function sortContextTree(node) {
      node.children.sort((left, right) => {
        if (left.type !== right.type) {
          return left.type === 'folder' ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });
      for (const child of node.children) {
        if (child.type === 'folder') {
          sortContextTree(child);
        }
      }
    }

    function renderContextTreeNode(node, container, selected, depth) {
      if (!document) {
        return;
      }
      if (node.type === 'folder') {
        const folder = document.createElement('details');
        folder.className = 'codex-context-folder';
        folder.dataset.path = node.path;
        folder.open = contextExpandedFolders.has(node.path);
        folder.addEventListener('toggle', () => {
          if (folder.open) {
            contextExpandedFolders.add(node.path);
          } else {
            contextExpandedFolders.delete(node.path);
          }
        });

        const label = document.createElement('summary');
        label.className = 'codex-context-folder-name';
        label.style.paddingLeft = `${depth * 14 + 7}px`;
        label.textContent = node.name;

        const children = document.createElement('div');
        children.className = 'codex-context-folder-children';

        for (const child of node.children) {
          renderContextTreeNode(child, children, selected, depth + 1);
        }
        folder.append(label, children);
        container.append(folder);
        return;
      }

      const file = node.file;
      const selectable = file.selectable !== false;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'codex-context-file';
      button.dataset.path = file.path;
      button.dataset.selected = selectable && selected.includes(file.path) ? 'true' : 'false';
      button.dataset.selectable = selectable ? 'true' : 'false';
      button.disabled = !selectable;
      button.setAttribute('aria-pressed', selectable && selected.includes(file.path) ? 'true' : 'false');
      button.style.paddingLeft = `${depth * 14 + 7}px`;
      button.title = selectable ? file.path : tr('contextResourceTitle', { path: file.path });
      if (selectable) {
        button.addEventListener('click', () => selectFocusFile(file.path));
      }

      const name = document.createElement('span');
      name.className = 'codex-context-file-name';
      name.textContent = node.name;
      name.title = node.path || node.name;

      const meta = document.createElement('span');
      meta.className = 'codex-context-file-meta';
      meta.textContent = selectable
        ? (file.content ? `${String(file.content).length} chars` : file.source || '')
        : tr('resource');

      button.append(name, meta);
      container.append(button);
    }

    function renderContextSelection() {
      const panel = getPanel();
      const selection = panel?.querySelector('[data-context-selection]');
      const addButton = panel?.querySelector('[data-add-context]');
      if (!selection || !addButton || !document) {
        return;
      }

      selection.textContent = '';
      const selected = getActiveFocusFiles();
      addButton.dataset.hasFocus = selected.length ? 'true' : 'false';
      addButton.title = selected.length ? `@context: ${selected.map(path => `@file:${path}`).join(', ')}` : tr('addContext');

      const chip = document.createElement('div');
      chip.className = 'codex-context-chip';

      const dot = document.createElement('span');
      dot.className = 'codex-context-dot';
      dot.setAttribute('aria-hidden', 'true');

      const label = document.createElement('span');
      label.textContent = selected.length ? selected.map(path => `@file:${path}`).join(', ') : tr('contextWholeProjectChip');
      chip.append(dot, label);

      if (selected.length) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.dataset.contextClear = '';
        clear.title = tr('clearFiles');
        clear.setAttribute('aria-label', tr('clearFiles'));
        clear.textContent = '×';
        clear.addEventListener('click', clearFocusFile);
        chip.append(clear);
      }

      selection.append(chip);
      renderContextSummary();
    }

    function renderContextSummary() {
      const summary = getPanel()?.querySelector('[data-context-summary]');
      if (!summary || !document) {
        return;
      }

      const selected = getActiveFocusFiles();
      hideContextSummaryTooltip();
      summary.textContent = '';
      summary.hidden = selected.length === 0;
      if (!selected.length) {
        return;
      }

      const prefix = document.createElement('span');
      prefix.className = 'codex-context-summary-label';
      prefix.textContent = '@context';
      summary.append(prefix);

      for (const path of selected) {
        const chip = document.createElement('span');
        chip.className = 'codex-context-summary-chip';
        chip.title = path;
        chip.setAttribute('aria-label', path);
        chip.addEventListener('mouseenter', () => showContextSummaryTooltip(path, chip));
        chip.addEventListener('mouseleave', hideContextSummaryTooltip);
        chip.addEventListener('focusin', () => showContextSummaryTooltip(path, chip));
        chip.addEventListener('focusout', hideContextSummaryTooltip);
        const chipLabel = document.createElement('span');
        chipLabel.className = 'codex-context-summary-chip-label';
        chipLabel.textContent = path;
        chipLabel.title = path;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'codex-context-summary-remove';
        remove.setAttribute('data-context-summary-remove', '');
        remove.title = tr('removeContextFile', { path });
        remove.setAttribute('aria-label', tr('removeContextFile', { path }));
        remove.textContent = '×';
        remove.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          removeFocusFile(path);
        });
        chip.append(chipLabel, remove);
        summary.append(chip);
      }
    }

    function ensureContextSummaryTooltip() {
      const panel = getPanel();
      if (!panel || !document) {
        return null;
      }
      const existing = panel.querySelector('[data-context-summary-tooltip]');
      if (existing) {
        return existing;
      }
      const tooltip = document.createElement('div');
      tooltip.className = 'codex-context-summary-tooltip';
      tooltip.setAttribute('data-context-summary-tooltip', '');
      tooltip.hidden = true;
      panel.append(tooltip);
      return tooltip;
    }

    function showContextSummaryTooltip(path, anchor) {
      const panel = getPanel();
      const tooltip = ensureContextSummaryTooltip();
      if (!panel || !tooltip) {
        return;
      }
      tooltip.textContent = path;
      tooltip.hidden = false;
      tooltip.style.left = '8px';
      tooltip.style.right = '8px';
      const panelRect = typeof panel.getBoundingClientRect === 'function' ? panel.getBoundingClientRect() : null;
      const anchorRect = typeof anchor?.getBoundingClientRect === 'function' ? anchor.getBoundingClientRect() : null;
      if (!panelRect || !anchorRect) {
        tooltip.style.top = 'auto';
        tooltip.style.bottom = '80px';
        return;
      }
      const maxTop = Math.max(8, Number(panelRect.height || 0) - 48);
      let top = Number(anchorRect.top || 0) - Number(panelRect.top || 0) - 34;
      if (top < 8) {
        top = Number(anchorRect.bottom || 0) - Number(panelRect.top || 0) + 8;
      }
      tooltip.style.top = `${Math.min(Math.max(8, Math.round(top)), maxTop)}px`;
      tooltip.style.bottom = 'auto';
    }

    function hideContextSummaryTooltip() {
      const tooltip = getPanel()?.querySelector('[data-context-summary-tooltip]');
      if (tooltip) {
        tooltip.hidden = true;
      }
    }

    async function selectFocusFile(path) {
      if (typeof path !== 'string' || !path.trim()) {
        return;
      }
      const normalizedPath = path.trim();
      const currentFocusFiles = getActiveFocusFiles();
      const nextFocusFiles = currentFocusFiles.includes(normalizedPath)
        ? currentFocusFiles.filter(item => item !== normalizedPath)
        : [...currentFocusFiles, normalizedPath].slice(-5);
      await persistFocusFiles(nextFocusFiles);
      renderContextSelection();
      renderContextFiles(contextProject);
    }

    async function clearFocusFile() {
      await persistFocusFiles([]);
      renderContextSelection();
      renderContextFiles(contextProject);
    }

    async function removeFocusFile(path) {
      const normalizedPath = typeof path === 'string' ? path.trim() : '';
      if (!normalizedPath) {
        return;
      }
      const nextFocusFiles = getActiveFocusFiles().filter(item => item !== normalizedPath);
      await persistFocusFiles(nextFocusFiles);
      renderContextSelection();
      renderContextFiles(contextProject);
    }

    function getActiveFocusFiles() {
      const state = getState();
      return Array.isArray(state?.session?.focusFiles) ? state.session.focusFiles : [];
    }

    function sortContextFiles(files, activePath) {
      return files
        .filter(file => typeof file?.path === 'string' && file.path.trim())
        .sort((left, right) => {
          if (left.path === activePath) {
            return -1;
          }
          if (right.path === activePath) {
            return 1;
          }
          const leftRank = getContextFileRank(left.path);
          const rightRank = getContextFileRank(right.path);
          if (leftRank !== rightRank) {
            return leftRank - rightRank;
          }
          return left.path.localeCompare(right.path);
        });
    }

    function getContextFileRank(path) {
      if (/\.tex$/i.test(path)) {
        return 0;
      }
      if (/\.bib$/i.test(path)) {
        return 1;
      }
      return 2;
    }

    function setContextStatus(text) {
      const status = getPanel()?.querySelector('[data-context-status]');
      if (status) {
        status.textContent = text;
        status.dataset.customStatus = 'true';
      }
    }

    function setContextSyncState(state) {
      const indicator = getPanel()?.querySelector('[data-context-sync-status]');
      const copy = indicator?.querySelector('[data-context-sync-copy]');
      const stateKeys = {
        'tree-loading': 'contextSyncTreeLoading',
        'exact-loading': 'contextSyncExactLoading',
        'exact-ready': 'contextSyncExactReady',
        partial: 'contextSyncPartial'
      };
      contextSyncState = Object.prototype.hasOwnProperty.call(stateKeys, state) ? state : 'idle';
      if (!indicator) {
        return;
      }
      indicator.dataset.state = contextSyncState;
      const label = contextSyncState === 'idle' ? '' : tr(stateKeys[contextSyncState]);
      indicator.title = label;
      indicator.setAttribute('aria-label', label);
      if (copy) {
        copy.textContent = label;
      }
    }

    async function persistFocusFiles(focusFiles) {
      const nextState = updateActiveSession(getState(), {
        focusFiles
      });
      setState(nextState);
      if (saveState) {
        await saveState();
        return;
      }
      saveStateSoon();
    }

    function normalizeProjectPath(path) {
      if (typeof projectFiles?.normalizePath === 'function') {
        return projectFiles.normalizePath(path) || '';
      }
      return String(path || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
    }

    function isTextProjectPath(path) {
      if (typeof projectFiles?.isTextProjectPath === 'function') {
        return projectFiles.isTextProjectPath(path);
      }
      return /\.(?:tex|bib|cls|sty|bst|txt|md|rmd|ltx|tikz|csv|tsv|json|yaml|yml)$/i.test(path);
    }

    function resetContextProject() {
      contextProject = null;
      contextLoadId += 1;
      contextExactEnhancementAttempted = false;
      setContextSyncState('idle');
      scheduleContextPrefetch();
    }

    function getContextProject() {
      return contextProject;
    }

    return {
      installContextDismiss,
      scheduleContextPrefetch,
      cancelContextPrefetch,
      isContextTrayClickTarget,
      toggleContextTray,
      closeContextTray,
      loadContextFiles,
      requestContextFiles,
      requestExactContextFiles,
      enhanceContextFilesFromExactSnapshot,
      isExactContextFileListProject,
      isContextFileListProject,
      normalizeContextFileListFromZipSnapshot,
      normalizeContextFileFromZipSnapshot,
      getZipSnapshotFailureReason,
      renderContextFiles,
      getContextProjectFiles,
      buildContextTree,
      sortContextTree,
      renderContextTreeNode,
      renderContextSelection,
      renderContextSummary,
      selectFocusFile,
      clearFocusFile,
      removeFocusFile,
      getActiveFocusFiles,
      sortContextFiles,
      getContextFileRank,
      setContextStatus,
      setContextSyncState,
      resetContextProject,
      getContextProject
    };
  }

  function defaultUpdateActiveSession(state, patch = {}) {
    return {
      ...(state || {}),
      session: {
        ...((state && state.session) || {}),
        ...patch
      }
    };
  }

  return {
    createContextTrayController,
    _private: {
      DEFAULT_CONTEXT_EXACT_FILE_LIST_ZIP_TIMEOUT_MS
    }
  };
});
