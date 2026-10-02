(function initCodexOverleafTreeOperations(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafTreeOperations = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function treeOperationsFactory() {
  'use strict';

  const TEXT_PATH_EXTENSION_PATTERN = '(?:tex|bib|sty|cls|bst|bbx|cbx|lbx|cfg|def|clo|ist|txt|md|latex)';

  function create({
    window: windowDep,
    document: documentDep,
    normalizePath = fallbackNormalizeSafeProjectPath,
    readActiveEditorText = () => '',
    getActiveEditorIdentity = () => null,
    activeEditorIdentityChanged = () => false,
    getActiveFilePathFromEditorStore: readActiveFilePathFromEditorStore = () => ''
  } = {}) {
    const window = windowDep || (typeof globalThis !== 'undefined' ? globalThis : {});
    const document = documentDep || window.document || {};
    const normalizeSafeProjectPath = normalizePath;
    const NodeCtor = window.Node || (typeof Node !== 'undefined' ? Node : null);
    const EventTargetCtor = window.EventTarget || (typeof EventTarget !== 'undefined' ? EventTarget : null);
    let internalDocPathByIdCache = null;
    let internalDocPathByIdCacheTime = 0;
    let domProjectPathCache = null;
    let domProjectPathCacheTime = 0;
    let lastFileTreeSelection = null;

  function collectElements(selector, limit) {
    const result = [];
    const roots = collectSearchRoots();
    for (let rootIndex = 0; rootIndex < roots.length && result.length < limit; rootIndex += 1) {
      let nodes = [];
      try {
        nodes = Array.from(roots[rootIndex].querySelectorAll(selector));
      } catch (_error) {
        nodes = [];
      }
      for (const node of nodes) {
        result.push(node);
        if (result.length >= limit) {
          break;
        }
      }
    }
    return result;
  }

  function collectSearchRoots() {
    const roots = [];
    const seenRoots = new Set();
    const queue = [document];

    for (let index = 0; index < queue.length && roots.length < 80; index += 1) {
      const root = queue[index];
      if (!root || seenRoots.has(root)) {
        continue;
      }
      seenRoots.add(root);
      roots.push(root);

      let allNodes = [];
      try {
        allNodes = Array.from(root.querySelectorAll('*')).slice(0, 4000);
      } catch (_error) {
        allNodes = [];
      }

      for (const node of allNodes) {
        if (node.shadowRoot && !seenRoots.has(node.shadowRoot)) {
          queue.push(node.shadowRoot);
        }
        if (node.tagName === 'IFRAME') {
          try {
            if (node.contentDocument && !seenRoots.has(node.contentDocument)) {
              queue.push(node.contentDocument);
            }
          } catch (_error) {
            // Cross-origin frames cannot be inspected from the page context.
          }
        }
      }
    }

    return roots;
  }

  function uniqueNodes(nodes) {
    return Array.from(new Set(nodes));
  }

  function getProjectId() {
    const match = window.location.pathname.match(/\/project\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function readNativeTreePath(node) {
    const row = node?.closest?.('[role="treeitem"]');
    const root = document.querySelector?.('[data-testid="file-tree-list-root"]');
    if (!row || !root?.contains?.(row) || !row.querySelector?.('[data-file-type="doc"][data-file-id]')) return '';
    const parts = [row.getAttribute('aria-label')];
    let group = row.closest('[role="tree"]');
    const seen = new Set();
    while (group && group !== root) {
      if (seen.has(group)) return '';
      seen.add(group);
      const folder = group.previousElementSibling;
      if (folder?.getAttribute?.('role') !== 'treeitem' || !folder.querySelector?.('[data-file-type="folder"]')) return '';
      parts.unshift(folder.getAttribute('aria-label'));
      group = group.parentElement?.closest?.('[role="tree"]');
    }
    if (group !== root || parts.some(part => !part || /[/\\]/.test(part))) return '';
    return normalizeSafeProjectPath(parts.join('/'));
  }

  function getActiveFilePath() {
    const editorStorePath = getEditorStoreFilePath({ disambiguateBasename: true });
    if (editorStorePath && window.CodexOverleafProjectFiles.isTextProjectPath(editorStorePath) && !hasMultipleTextPathExtensions(editorStorePath)) {
      return editorStorePath;
    }

    const breadcrumbPath = readActiveFilePathFromEditorBreadcrumb();
    if (breadcrumbPath) {
      return breadcrumbPath;
    }

    const selectors = [
      '[aria-selected="true"][role="treeitem"]',
      '[aria-selected="true"][role="row"]',
      '.selected[role="treeitem"]',
      '.selected[role="row"]',
      '.file-tree .selected',
      '.project-tree .selected'
    ];

    const candidates = [];
    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll?.(selector) || []);
      for (const node of nodes) {
        const path = node ? readNativeTreePath(node) || readProjectPathFromNode(node) : '';
        if (isActiveFilePathCandidate(path, node)) {
          candidates.push({
            node,
            path,
            score: scoreActiveFilePathCandidate(path, node)
          });
        }
      }
    }

    if (candidates.length) {
      candidates.sort((left, right) => right.score - left.score);
      return candidates[0].path;
    }

    return '';
  }

  function getEditorStoreFilePath(options = {}) {
    return normalizeSafeProjectPath(readActiveFilePathFromEditorStore(options));
  }

  function scoreActiveFilePathCandidate(path, node) {
    let score = 0;
    const selected = getSettledRecentFileTreeSelection();
    if (selected?.path === path) {
      score += 1000;
    }
    if (node?.getAttribute?.('aria-selected') === 'true') {
      score += 100;
    }
    const className = normalizeDomText(node?.className || '');
    if (/\b(?:active|current|selected)\b/i.test(className)) {
      score += 50;
    }
    if (isVisibleNode(node)) {
      score += 10;
    }
    return score;
  }

  function getSettledRecentFileTreeSelection() {
    if (!lastFileTreeSelection?.path) {
      return null;
    }
    const elapsedMs = Date.now() - lastFileTreeSelection.time;
    if (elapsedMs < 0 || elapsedMs > 60000) {
      return null;
    }
    if (lastFileTreeSelection.editorIdentityBefore && activeEditorIdentityChanged(lastFileTreeSelection.editorIdentityBefore)) {
      return lastFileTreeSelection;
    }
    const beforeSignature = lastFileTreeSelection.editorTextSignatureBefore || '';
    if (beforeSignature && contentSignature(readActiveEditorText()) !== beforeSignature) {
      return lastFileTreeSelection;
    }
    return null;
  }

  function isVisibleNode(node) {
    if (!node) {
      return false;
    }
    if (typeof node.getClientRects === 'function' && node.getClientRects().length > 0) {
      return true;
    }
    return node.offsetParent != null;
  }

  async function openFileByPath(filePath, options = {}) {
    const normalizedPath = normalizeSafeProjectPath(filePath);
    if (!normalizedPath) {
      return {
        ok: false,
        reason: 'Invalid file path'
      };
    }

    if (options.force !== true && getActiveFilePath() === normalizedPath) {
      return {
        ok: true,
        method: 'already-active'
      };
    }

    const diagnostics = {
      path: normalizedPath,
      initialActivePath: getActiveFilePath(),
      initialDomNodeFound: false,
      ancestorFolders: [],
      postExpandDomNodeFound: false,
      domClickActivePath: '',
      managerMethods: []
    };

    let node = findFileTreeNode(normalizedPath, { invalidateCache: true });
    diagnostics.initialDomNodeFound = Boolean(node);
    if (!node && normalizedPath.includes('/')) {
      diagnostics.ancestorFolders = await ensureAncestorFoldersVisible(normalizedPath);
      node = findFileTreeNode(normalizedPath, { invalidateCache: true });
      diagnostics.postExpandDomNodeFound = Boolean(node);
    }
    if (node) {
      dispatchFileTreeOpenClick(node);
      await delay(250);
      const active = await waitForActiveFile(normalizedPath, options.activeWaitMs ?? 5000);
      diagnostics.domClickActivePath = getActiveFilePath();
      if (active) {
        return {
          ok: true,
          method: 'dom-click'
        };
      }
      // Overleaf can drop a click while the previous document is still
      // settling (e.g. right after a multi-file write). Re-resolve the row,
      // activate the row itself plus a keyboard Enter, and wait once more.
      const retryNode = findFileTreeNode(normalizedPath, { invalidateCache: true }) || node;
      dispatchActivationSequence(retryNode);
      dispatchKeyboardOpen(findFileTreeOpenClickTarget(retryNode) || retryNode);
      const retried = await waitForActiveFile(normalizedPath, options.retryWaitMs ?? 4000);
      diagnostics.domRetryActivePath = getActiveFilePath() || 'unknown';
      if (retried) {
        return {
          ok: true,
          method: 'dom-click-retry'
        };
      }
    }

    const manager = findFileTreeManager();
    const openMethods = ['openDoc', 'openFile', 'selectFile', 'selectEntity'];
    const openArgs = buildManagerOpenArgs(normalizedPath);

    for (const methodName of openMethods) {
      const method = manager?.[methodName];
      if (typeof method !== 'function') {
        continue;
      }

      for (const openArg of openArgs) {
        const methodDiagnostics = {
          method: methodName,
          argType: openArg.type,
          ok: false,
          activePath: ''
        };
        try {
          await method.call(manager, openArg.value);
          const active = await waitForActiveFile(normalizedPath, 5000);
          methodDiagnostics.ok = active;
          methodDiagnostics.activePath = getActiveFilePath();
          diagnostics.managerMethods.push(methodDiagnostics);
          if (active) {
            return {
              ok: true,
              method: `fileTreeManager.${methodName}:${openArg.type}`
            };
          }
        } catch (error) {
          methodDiagnostics.error = error?.message || String(error || '');
          methodDiagnostics.activePath = getActiveFilePath();
          diagnostics.managerMethods.push(methodDiagnostics);
        }
      }
    }

    return {
      ok: false,
      reason: `Could not open ${normalizedPath}; ${formatOpenDiagnostics(diagnostics)}`,
      diagnostics
    };
  }

  function buildManagerOpenArgs(filePath) {
    const normalizedPath = normalizeSafeProjectPath(filePath);
    const record = collectDocRecords({ includeWindowGlobals: true }).find(item => item.path === normalizedPath);
    const args = [
      { type: 'path', value: normalizedPath }
    ];
    if (record?.id) {
      args.unshift({ type: 'doc-id', value: record.id });
      args.push({ type: 'doc-record', value: { ...record } });
      args.push({ type: 'doc-record-with-path', value: { ...record, path: normalizedPath, name: normalizedPath.split('/').pop() || normalizedPath } });
    }
    return args;
  }

  function formatOpenDiagnostics(diagnostics = {}) {
    const folders = (diagnostics.ancestorFolders || [])
      .map(item => `${item.path}:found=${item.found ? 'yes' : 'no'},expanded=${item.expandedBefore ? 'yes' : 'no'},visible=${item.visibleAfter ? 'yes' : 'no'}`)
      .join('|') || 'none';
    const managers = (diagnostics.managerMethods || [])
      .map(item => `${item.method}/${item.argType}:ok=${item.ok ? 'yes' : 'no'},active=${item.activePath || 'unknown'}${item.error ? ',error=' + item.error : ''}`)
      .slice(0, 8)
      .join('|') || 'none';
    return `open diagnostics initial=${diagnostics.initialActivePath || 'unknown'}, initialNode=${diagnostics.initialDomNodeFound ? 'yes' : 'no'}, folders=${folders}, postExpandNode=${diagnostics.postExpandDomNodeFound ? 'yes' : 'no'}, domClickActive=${diagnostics.domClickActivePath || 'unknown'}, domRetryActive=${diagnostics.domRetryActivePath || 'none'}, manager=${managers}`;
  }

  function dispatchFileTreeOpenClick(node) {
    const path = readProjectPathFromNode(node);
    if (isActiveFilePathCandidate(path, node)) {
      recordFileTreeSelection(path, 'script');
    }
    const target = findFileTreeOpenClickTarget(node) || node;
    dispatchActivationSequence(target);
  }

  function dispatchActivationSequence(node) {
    if (!node) {
      return;
    }
    try {
      node.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    } catch (_error) {
      // Ignore scroll failures in synthetic DOM test harnesses.
    }
    try {
      node.focus?.({ preventScroll: true });
    } catch (_error) {
      try {
        node.focus?.();
      } catch (_nestedError) {
        // Ignore focus failures.
      }
    }
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
      try {
        node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      } catch (_error) {
        // Keep trying the rest of the activation sequence.
      }
    }
  }

  function dispatchKeyboardOpen(node) {
    for (const type of ['keydown', 'keyup']) {
      try {
        node?.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      } catch (_error) {
        // KeyboardEvent may be unavailable in synthetic harnesses.
      }
    }
  }

  function findFileTreeOpenClickTarget(node) {
    const selectors = [
      '.file-tree-entity-details',
      '.item-name',
      '.entity-name',
      '.file-tree-entity-button',
      '[role="button"]',
      'button'
    ];
    for (const selector of selectors) {
      let candidates = [];
      try {
        candidates = Array.from(node.querySelectorAll?.(selector) || []);
      } catch (_error) {
        candidates = [];
      }
      const candidate = candidates.find(item => !isFileTreeMenuControl(item));
      if (candidate) {
        return candidate;
      }
    }
    return node;
  }

  function isFileTreeMenuControl(node) {
    if (!node || typeof node.getAttribute !== 'function') {
      return false;
    }
    const role = node.getAttribute('role') || '';
    if (/^(?:treeitem|row)$/i.test(role)) {
      return false;
    }
    const signal = [
      node?.id || '',
      node?.className || '',
      node?.getAttribute?.('aria-label') || '',
      node?.getAttribute?.('title') || ''
    ].join(' ');
    if (/\b(?:menu|more_vert|action)\b/i.test(signal)) {
      return true;
    }
    const text = normalizeDomText(node.textContent || '');
    return /^(?:more_vert|menu|action menu)$/i.test(text);
  }

  function installFileTreeSelectionTracking() {
    const handlerKey = '__codexOverleafFileTreeSelectionHandler';
    if (typeof window.removeEventListener === 'function' && typeof window[handlerKey] === 'function') {
      window.removeEventListener('click', window[handlerKey], true);
    }
    const handler = event => {
      const path = readFileTreePathFromClickEvent(event);
      if (path) {
        recordFileTreeSelection(path, event?.isTrusted === true ? 'user' : 'script');
      }
    };
    window[handlerKey] = handler;
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('click', handler, true);
    }
  }

  function readFileTreePathFromClickEvent(event) {
    const pathNodes = typeof event?.composedPath === 'function'
      ? event.composedPath()
      : [];
    if (pathNodes.some(node => node?.id === 'codex-overleaf-panel')
      || event?.target?.closest?.('#codex-overleaf-panel')) return '';
    const insideTree = pathNodes.some(node => /(?:^|\s)(?:file-tree|project-tree|file-tree-list)(?:\s|$)/.test(String(node?.className || '')))
      || event?.target?.closest?.('.file-tree, .project-tree, .file-tree-list');
    if (!insideTree) return '';
    for (const node of pathNodes) {
      if (!node || typeof node.getAttribute !== 'function') {
        continue;
      }
      const path = readProjectPathFromNode(node);
      if (isActiveFilePathCandidate(path, node)) {
        return path;
      }
      if (isFileTreeMenuControl(node)) {
        return '';
      }
    }

    const targetNode = event?.target;
    const treeNode = targetNode?.closest?.('[role="treeitem"], [role="row"], .file-tree li, .project-tree li');
    if (treeNode && !isFileTreeMenuControl(targetNode)) {
      const path = readProjectPathFromNode(treeNode);
      if (isActiveFilePathCandidate(path, treeNode)) {
        return path;
      }
    }
    return '';
  }

  function recordFileTreeSelection(path, source) {
    const normalizedPath = normalizeSafeProjectPath(path);
    if (!window.CodexOverleafProjectFiles.isTextProjectPath(normalizedPath)) {
      return;
    }
    lastFileTreeSelection = {
      path: normalizedPath,
      source,
      time: Date.now(),
      editorIdentityBefore: getActiveEditorIdentity(),
      editorTextSignatureBefore: contentSignature(readActiveEditorText())
    };
  }

  function getRecentFileTreeSelectionPath() {
    return getSettledRecentFileTreeSelection()?.path || '';
  }

  function readActiveFilePathFromEditorBreadcrumb() {
    const roots = document.querySelectorAll?.(
      '.ol-cm-breadcrumbs, [data-testid="editor-breadcrumbs"], .editor-breadcrumbs'
    ) || [];
    for (const root of roots) {
      const path = readProjectPathFromBreadcrumbRoot(root);
      if (path) {
        return path;
      }
    }
    return '';
  }

  function readProjectPathFromBreadcrumbRoot(root) {
    const rawParts = Array.from(root.querySelectorAll?.('*') || [])
      .map(node => normalizeDomText(node.innerText || node.textContent || ''))
      .filter(Boolean);
    const parts = [];
    for (const part of rawParts) {
      if (isBreadcrumbIconText(part)) {
        continue;
      }
      if (parts[parts.length - 1] === part) {
        continue;
      }
      parts.push(part);
    }
    if (!parts.length) {
      return '';
    }
    for (let start = 0; start < parts.length; start += 1) {
      const candidate = normalizeSafeProjectPath(parts.slice(start).join('/'));
      if (window.CodexOverleafProjectFiles.isTextProjectPath(candidate) && !hasMultipleTextPathExtensions(candidate)) {
        return candidate;
      }
    }
    return '';
  }

  function isBreadcrumbIconText(text) {
    return /^(?:chevron_right|description|book_5|image|insert_drive_file|article|folder|expand_more|keyboard_arrow_down)$/i
      .test(String(text || '').trim());
  }

  function findFileTreeNode(filePath, options = {}) {
    const normalizedPath = normalizeSafeProjectPath(filePath);
    if (!normalizedPath) {
      return null;
    }
    if (normalizedPath.includes('/') && options.invalidateCache === true) {
      invalidateDomProjectPathCache();
    }
    const fileName = normalizedPath.split('/').pop();
    const allowBasenameFallback = !normalizedPath.includes('/');
    const basenameMatches = [];
    let firstPathMatch = null;
    const candidates = document.querySelectorAll('[role="treeitem"], [role="row"], .file-tree *, .project-tree *');
    for (const node of candidates) {
      const path = readProjectPathFromNode(node);
      const text = normalizeDomText(node.textContent || '');
      if (path === normalizedPath || text === normalizedPath) {
        const role = node.getAttribute?.('role') || '';
        if (/^(treeitem|row)$/i.test(role)) {
          return node;
        }
        if (!firstPathMatch) {
          firstPathMatch = node;
        }
      }
      if (allowBasenameFallback && (path === fileName || text === fileName)) {
        basenameMatches.push(node);
      }
    }
    if (firstPathMatch) {
      return firstPathMatch;
    }
    if (basenameMatches.length === 1) {
      return basenameMatches[0];
    }
    if (normalizedPath.includes('/')) {
      return findFileTreeNodeByDocId(normalizedPath, fileName);
    }
    return null;
  }

  function findFileTreeNodeByDocId(filePath, fileName) {
    const record = collectDocRecords({ includeWindowGlobals: true }).find(item => item.path === filePath);
    if (!record?.id) {
      return null;
    }
    const idSelectors = [
      `[data-entity-id="${record.id}"]`,
      `[data-doc-id="${record.id}"]`,
      `[data-file-id="${record.id}"]`,
      `[data-id="${record.id}"]`
    ];
    for (const selector of idSelectors) {
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(selector));
      } catch (_error) {
        continue;
      }
      for (const node of nodes) {
        const role = node.getAttribute?.('role') || '';
        if (/^(treeitem|row)$/i.test(role)) {
          return node;
        }
      }
      if (nodes.length) {
        return nodes[0];
      }
    }
    const allNodes = document.querySelectorAll('[role="treeitem"], [role="row"], .file-tree *, .project-tree *');
    for (const node of allNodes) {
      const nodeId = readDomDocId(node);
      if (nodeId === record.id) {
        return node;
      }
    }
    return null;
  }

  async function ensureAncestorFoldersVisible(filePath) {
    const parts = String(filePath || '').split('/').filter(Boolean);
    const diagnostics = [];
    if (parts.length < 2) {
      return diagnostics;
    }

    let folderPath = '';
    for (const folderName of parts.slice(0, -1)) {
      folderPath = folderPath ? `${folderPath}/${folderName}` : folderName;
      const folderNode = findFolderTreeNode(folderPath);
      const entry = {
        path: folderPath,
        found: Boolean(folderNode),
        expandedBefore: folderNode ? isFolderExpanded(folderNode) : false,
        visibleAfter: false
      };
      if (!folderNode || isFolderExpanded(folderNode)) {
        entry.visibleAfter = hasVisibleFolderDescendant(folderPath);
        diagnostics.push(entry);
        continue;
      }
      dispatchFolderExpandClick(folderNode);
      invalidateDomProjectPathCache();
      const visible = await waitForFolderVisible(folderPath, 2000);
      entry.visibleAfter = visible;
      if (!visible) {
        const refreshedFolderNode = findFolderTreeNode(folderPath) || folderNode;
        if (refreshedFolderNode && refreshedFolderNode !== folderNode) {
          dispatchFolderExpandClick(refreshedFolderNode);
        } else {
          dispatchActivationSequence(folderNode);
        }
        invalidateDomProjectPathCache();
        entry.visibleAfter = await waitForFolderVisible(folderPath, 2500);
      }
      diagnostics.push(entry);
    }
    return diagnostics;
  }

  function findFolderTreeNode(folderPath) {
    const normalizedPath = normalizeSafeProjectPath(folderPath);
    if (!normalizedPath || window.CodexOverleafProjectFiles.isTextProjectPath(normalizedPath)) {
      return null;
    }
    const folderName = normalizedPath.split('/').pop() || '';
    const matches = [];
    const candidates = document.querySelectorAll('[role="treeitem"], [role="row"], .file-tree li, .project-tree li');
    for (const node of candidates) {
      const name = readFolderNameFromNode(node);
      if (name !== folderName) {
        continue;
      }
      const inferredPath = inferFolderPathFromTreeAncestors(node, name) || name;
      if (inferredPath === normalizedPath) {
        return node;
      }
      if (name === folderName) {
        matches.push(node);
      }
    }
    return matches.length === 1 ? matches[0] : null;
  }

  function isFolderExpanded(node) {
    const expanded = node?.getAttribute?.('aria-expanded');
    if (expanded === 'true') {
      return true;
    }
    if (expanded === 'false') {
      return false;
    }
    const signal = normalizeDomText(node?.textContent || '');
    return /expand_more|folder_open/i.test(signal);
  }

  function dispatchFolderExpandClick(node) {
    const target = findFolderExpandClickTarget(node) || node;
    dispatchActivationSequence(target);
  }

  function findFolderExpandClickTarget(node) {
    const selectors = [
      '.file-tree-entity-button',
      '.item-name',
      '.entity-name',
      '[role="button"]',
      'button'
    ];
    for (const selector of selectors) {
      let candidates = [];
      try {
        candidates = Array.from(node.querySelectorAll?.(selector) || []);
      } catch (_error) {
        candidates = [];
      }
      const candidate = candidates.find(item => !isFileTreeMenuControl(item));
      if (candidate) {
        return candidate;
      }
    }
    return node;
  }

  async function waitForFolderVisible(folderPath, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const folderNode = findFolderTreeNode(folderPath);
      if (!folderNode || isFolderExpanded(folderNode) || hasVisibleFolderDescendant(folderPath)) {
        return true;
      }
      await delay(100);
    }
    return hasVisibleFolderDescendant(folderPath);
  }

  function hasVisibleFolderDescendant(folderPath) {
    const prefix = `${folderPath}/`;
    return collectDomProjectPaths().some(path => path.startsWith(prefix));
  }

  function projectPathExists(filePath) {
    if (!filePath) {
      return false;
    }
    const normalizedPath = normalizeSafeProjectPath(filePath);
    if (!normalizedPath) {
      return false;
    }
    if (getActiveFilePath() === normalizedPath) {
      return true;
    }
    if (findFileTreeNode(normalizedPath)) {
      return true;
    }
    return collectDocRecords().some(record => record.path === normalizedPath);
  }

  function collectProjectTextPaths(activePath) {
    const rawPaths = [
      activePath,
      ...collectDocRecords().map(record => record.path),
      ...collectInternalProjectPaths(),
      ...collectDomProjectPaths()
    ];
    return window.CodexOverleafProjectFiles.collectUniqueTextPaths(rawPaths, 80);
  }

  function collectDocRecords(options = {}) {
    const seen = new Set();
    const records = [];
    for (const record of [...collectInternalDocRecords(options), ...collectDomDocRecords()]) {
      if (!record?.id || !window.CodexOverleafProjectFiles.isTextProjectPath(record.path)) {
        continue;
      }
      const key = `${record.path}:${record.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      records.push(record);
      if (records.length >= 120) {
        break;
      }
    }
    return records;
  }

  function collectInternalDocRecords(options = {}) {
    const records = [];
    const seenObjects = new WeakSet();
    const seenRecords = new Set();
    const roots = collectInternalRoots(options);

    for (const root of roots) {
      walkInternalDocTree(root, '', 0);
      if (records.length >= 120) {
        break;
      }
    }

    return records;

    function walkInternalDocTree(value, folderPath, depth) {
      if (!value || depth > 7 || records.length >= 120 || typeof value !== 'object') {
        return;
      }
      if (isDomLikeObject(value) || seenObjects.has(value)) {
        return;
      }
      seenObjects.add(value);

      if (Array.isArray(value)) {
        for (const item of value.slice(0, 250)) {
          walkInternalDocTree(item, folderPath, depth + 1);
        }
        return;
      }

      const ownName = readObjectPathName(value);
      const ownId = readObjectDocId(value);
      const normalizedOwnName = normalizeSafeProjectPath(ownName);
      const ownPath = normalizedOwnName && normalizedOwnName.includes('/')
        ? normalizedOwnName
        : joinPath(folderPath, normalizedOwnName);

      if (ownId && window.CodexOverleafProjectFiles.isTextProjectPath(ownPath)) {
        const key = `${ownPath}:${ownId}`;
        if (!seenRecords.has(key)) {
          seenRecords.add(key);
          records.push({
            path: ownPath,
            id: ownId
          });
        }
      }

      const nextFolderPath = normalizedOwnName && !window.CodexOverleafProjectFiles.isTextProjectPath(normalizedOwnName)
        ? joinPath(folderPath, normalizedOwnName)
        : folderPath;

      for (const key of Object.keys(value).slice(0, 220)) {
        if (!/project|root|folder|folders|children|entities|entity|docs|doc|file|files|tree|scope|state|data|metadata|meta/i.test(key)) {
          continue;
        }
        let child;
        try {
          child = value[key];
        } catch (_error) {
          continue;
        }
        walkInternalDocTree(child, nextFolderPath, depth + 1);
      }
    }
  }

  function collectInternalRoots(options = {}) {
    const roots = [window._ide, window.Overleaf, window.overleaf, window.OL].filter(Boolean);
    if (options.includeWindowGlobals === false) {
      return uniqueNodes(roots);
    }
    for (const key of Object.keys(window).slice(0, 2500)) {
      if (!/ide|overleaf|sharelatex|project|root|folder|doc|file|entity|state|meta|bootstrap|ol/i.test(key)) {
        continue;
      }
      try {
        const value = window[key];
        if (value && typeof value === 'object') {
          roots.push(value);
        }
      } catch (_error) {
        // Ignore guarded globals.
      }
    }
    return uniqueNodes(roots);
  }

  function collectInternalRootKeys() {
    return Object.keys(window)
      .filter(key => /ide|overleaf|sharelatex|project|root|folder|doc|file|entity|state|meta|bootstrap|ol/i.test(key))
      .slice(0, 40);
  }

  function collectDomDocRecords() {
    const selectors = [
      '[role="treeitem"]',
      '[role="row"]',
      '.file-tree *',
      '.project-tree *',
      '[data-entity-id]',
      '[data-doc-id]',
      '[data-id]',
      '[data-file-id]'
    ];
    const nodes = uniqueNodes(selectors.flatMap(selector => Array.from(document.querySelectorAll(selector)).slice(0, 600)));
    const records = [];
    const seen = new Set();

    for (const node of nodes) {
      const path = readProjectPathFromNode(node);
      const id = readDomDocId(node);
      if (!path || !id) {
        continue;
      }
      const key = `${path}:${id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      records.push({
        path,
        id,
        source: 'dom'
      });
    }

    return records;
  }

  function readDomDocId(node) {
    let current = node;
    for (let depth = 0; current && depth < 5; depth += 1) {
      for (const attr of ['data-entity-id', 'data-doc-id', 'data-id', 'data-file-id', 'data-ol-id', 'id']) {
        const value = current.getAttribute?.(attr) || '';
        const match = value.match(/[a-f0-9]{24}/i);
        if (match) {
          return match[0];
        }
      }
      current = current.parentElement;
    }
    return '';
  }

  function readObjectPathName(value) {
    for (const key of ['path', 'pathname', 'filePath', 'name', 'fileName', 'displayName']) {
      const candidate = value?.[key];
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate;
      }
    }
    return '';
  }

  function readObjectDocId(value) {
    for (const key of ['_id', 'id', 'docId', 'doc_id', 'entityId']) {
      const candidate = value?.[key];
      if (typeof candidate === 'string' && /^[a-f0-9]{24}$/i.test(candidate)) {
        return candidate;
      }
    }
    return '';
  }

  function isDomLikeObject(value) {
    return value === window
      || value === document
      || (NodeCtor && value instanceof NodeCtor)
      || (EventTargetCtor && value instanceof EventTargetCtor && value.constructor?.name !== 'Object');
  }

  function joinPath(folderPath, name) {
    const cleanName = normalizeSafeProjectPath(name);
    const cleanFolder = normalizeSafeProjectPath(folderPath);
    if (!cleanName) {
      return cleanFolder;
    }
    return cleanFolder ? `${cleanFolder}/${cleanName}` : cleanName;
  }


  function collectInternalProjectPaths() {
    const paths = [];
    const roots = [window._ide, window.Overleaf, window.overleaf, window.OL].filter(Boolean);
    for (const root of roots) {
      collectPathLikeValues(root, paths, 0);
      if (paths.length >= 200) {
        break;
      }
    }
    return paths;
  }

  function collectPathLikeValues(value, paths, depth) {
    if (!value || depth > 3 || paths.length >= 200) {
      return;
    }

    if (typeof value === 'string') {
      if (window.CodexOverleafProjectFiles.isTextProjectPath(value)) {
        paths.push(value);
      }
      return;
    }

    if (typeof value !== 'object') {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value.slice(0, 80)) {
        collectPathLikeValues(item, paths, depth + 1);
      }
      return;
    }

    for (const key of Object.keys(value).slice(0, 100)) {
      const child = value[key];
      if (/path|name|file|doc/i.test(key)) {
        collectPathLikeValues(child, paths, depth + 1);
      } else if (child && typeof child === 'object' && /project|file|doc|root|entities|tree/i.test(key)) {
        collectPathLikeValues(child, paths, depth + 1);
      }
    }
  }

  function collectDomProjectPaths() {
    const selectors = [
      '[role="treeitem"]',
      '[role="row"]',
      '.file-tree li',
      '.file-tree [data-entity-id]',
      '.file-tree [data-testid]',
      '.project-tree li',
      '.project-tree [data-entity-id]'
    ];
    const candidates = [];
    for (const selector of selectors) {
      candidates.push(...Array.from(document.querySelectorAll(selector)).slice(0, 500));
    }

    return Array.from(new Set(candidates.map(node => readProjectPathFromNode(node)).filter(Boolean)));
  }

  function readProjectPathFromNode(node) {
    const explicitAttrPath = [
      node.getAttribute('data-path'),
      node.getAttribute('data-file-path')
    ].map(normalizeProjectPathCandidate).find(Boolean);
    if (explicitAttrPath) {
      if (explicitAttrPath.includes('/')) {
        return explicitAttrPath;
      }
      return resolveProjectPathFromDomDocId(node, explicitAttrPath)
        || inferPathFromTreeAncestors(node, explicitAttrPath)
        || (node.parentElement ? resolveProjectPathFromDomTree(node, explicitAttrPath) : '')
        || explicitAttrPath;
    }

    const attrPath = normalizeProjectPathCandidate(node.getAttribute('data-name'));
    if (attrPath) {
      if (!attrPath.includes('/')) {
        return inferPathFromTreeAncestors(node, attrPath)
          || resolveProjectPathFromDomDocId(node, attrPath)
          || resolveProjectPathFromDomTree(node, attrPath)
          || attrPath;
      }
      return attrPath;
    }

    const labelPath = [
      node.getAttribute('aria-label'),
      node.getAttribute('title')
    ].map(normalizeProjectPathCandidate).find(Boolean);
    if (labelPath) {
      if (!labelPath.includes('/')) {
        return inferPathFromTreeAncestors(node, labelPath)
          || resolveProjectPathFromDomDocId(node, labelPath)
          || resolveProjectPathFromDomTree(node, labelPath)
          || labelPath;
      }
      return labelPath;
    }

    const textPath = normalizeProjectPathCandidate(readFileTreeNodeText(node));
    if (!textPath) {
      const docIdPath = resolveProjectPathFromDomDocId(node);
      const domTreePath = resolveProjectPathFromDomTree(node);
      return docIdPath || domTreePath;
    }
    if (!textPath.includes('/')) {
      return inferPathFromTreeAncestors(node, textPath)
        || resolveProjectPathFromDomDocId(node, textPath)
        || resolveProjectPathFromDomTree(node, textPath)
        || textPath;
    }
    return textPath;
  }

  function isActiveFilePathCandidate(path, node) {
    if (!path || !window.CodexOverleafProjectFiles.isTextProjectPath(path)) {
      return false;
    }
    if (hasMultipleTextPathExtensions(path)) {
      return false;
    }
    if (isFolderTreeNode(node)) {
      return false;
    }
    const text = normalizeDomText(node?.textContent || '');
    return !hasMultipleTextPathExtensions(text);
  }

  function isFolderTreeNode(node) {
    const expanded = node?.getAttribute?.('aria-expanded');
    return (expanded === 'true' || expanded === 'false') && Boolean(readFolderNameFromNode(node));
  }

  function resolveProjectPathFromDomTree(node, pathHint = '') {
    const cache = getDomProjectPathCache();
    const normalizedHint = normalizeSafeProjectPath(pathHint);
    let current = node || null;
    for (let depth = 0; current && depth < 8; depth += 1) {
      const resolvedPath = cache.get(current) || '';
      if (resolvedPath && pathMatchesHint(resolvedPath, normalizedHint)) {
        return resolvedPath;
      }
      current = current.parentElement;
    }
    return '';
  }

  function pathMatchesHint(path, hint) {
    if (!hint) {
      return true;
    }
    if (hint.includes('/')) {
      return path === hint;
    }
    return (path.split('/').pop() || '') === hint;
  }

  function getDomProjectPathCache() {
    const now = Date.now();
    if (domProjectPathCache && now - domProjectPathCacheTime < 1000) {
      return domProjectPathCache;
    }

    const pathByNode = new WeakMap();
    const visited = new WeakSet();
    const roots = uniqueNodes([
      ...collectElements('.file-tree', 20),
      ...collectElements('.project-tree', 20),
      ...collectElements('.file-tree-inner', 20),
      ...collectElements('[role="tree"]', 40)
    ]);
    for (const root of roots) {
      walkDomProjectTree(root, '', 0, pathByNode, visited);
    }

    domProjectPathCache = pathByNode;
    domProjectPathCacheTime = now;
    return domProjectPathCache;
  }

  function walkDomProjectTree(node, folderPath, depth, pathByNode, visited) {
    if (!node || depth > 60 || visited.has(node)) {
      return;
    }
    visited.add(node);

    const filePath = readFilePathFromTreeNodeSelf(node, folderPath);
    const folderName = filePath ? '' : readFolderNameFromNode(node);
    const nextFolderPath = folderName ? joinPath(folderPath, folderName) : folderPath;
    if (filePath) {
      pathByNode.set(node, filePath);
    }

    const children = Array.from(node.children || []);
    let pendingSiblingFolderPath = '';
    for (const child of children) {
      const childFilePath = readFilePathFromTreeNodeSelf(child, nextFolderPath);
      const childFolderName = childFilePath ? '' : readFolderNameFromNode(child);
      const childIsNestedList = isNestedFolderListNode(child);
      const childFolderPath = childIsNestedList && pendingSiblingFolderPath
        ? pendingSiblingFolderPath
        : nextFolderPath;
      walkDomProjectTree(child, childFolderPath, depth + 1, pathByNode, visited);

      if (childFolderName) {
        pendingSiblingFolderPath = joinPath(nextFolderPath, childFolderName);
      } else if (!childIsNestedList && childFilePath) {
        pendingSiblingFolderPath = '';
      } else if (childIsNestedList && pendingSiblingFolderPath) {
        pendingSiblingFolderPath = '';
      }
    }
  }

  function isNestedFolderListNode(node) {
    const className = String(node?.className || '');
    const role = node?.getAttribute?.('role') || '';
    return /file-tree-folder-list/i.test(className)
      || (role === 'tree' && !/file-tree-list/i.test(className));
  }

  function readFilePathFromTreeNodeSelf(node, folderPath) {
    const candidates = [
      node.getAttribute?.('data-path'),
      node.getAttribute?.('data-file-path'),
      node.getAttribute?.('data-name'),
      node.getAttribute?.('aria-label'),
      node.getAttribute?.('title'),
      readFileTreeNodeText(node)
    ];
    for (const value of candidates) {
      const path = normalizeProjectPathCandidate(value);
      if (!path) {
        continue;
      }
      const resolvedPath = path.includes('/') ? path : joinPath(folderPath, path);
      if (window.CodexOverleafProjectFiles.isTextProjectPath(resolvedPath)) {
        return resolvedPath;
      }
    }
    return '';
  }

  function resolveProjectPathFromDomDocId(node, pathHint = '') {
    const id = readDomDocId(node);
    if (!id) {
      return '';
    }
    const resolvedPath = getInternalDocPathByIdMap().get(id) || '';
    if (!resolvedPath) {
      return '';
    }
    const normalizedHint = normalizeSafeProjectPath(pathHint);
    if (!normalizedHint) {
      return resolvedPath;
    }
    if (normalizedHint.includes('/')) {
      return resolvedPath === normalizedHint ? resolvedPath : '';
    }
    const resolvedName = resolvedPath.split('/').pop() || '';
    return resolvedName === normalizedHint ? resolvedPath : '';
  }

  function getInternalDocPathByIdMap() {
    const now = Date.now();
    if (internalDocPathByIdCache && now - internalDocPathByIdCacheTime < 1000) {
      return internalDocPathByIdCache;
    }

    const byId = new Map();
    const ambiguousIds = new Set();
    for (const record of collectInternalDocRecords({ includeWindowGlobals: false })) {
      if (!record?.id || !window.CodexOverleafProjectFiles.isTextProjectPath(record.path)) {
        continue;
      }
      const existingPath = byId.get(record.id);
      if (existingPath && existingPath !== record.path) {
        ambiguousIds.add(record.id);
        continue;
      }
      byId.set(record.id, record.path);
    }
    for (const id of ambiguousIds) {
      byId.delete(id);
    }
    internalDocPathByIdCache = byId;
    internalDocPathByIdCacheTime = now;
    return internalDocPathByIdCache;
  }

  function normalizeProjectPathCandidate(value) {
    const text = String(value || '').trim();
    if (!text || hasMultipleTextPathExtensions(text)) {
      return '';
    }
    const normalized = normalizeSafeProjectPath(text);
    return normalized && window.CodexOverleafProjectFiles.isTextProjectPath(normalized) ? normalized : '';
  }

  function normalizeDomText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function hasMultipleTextPathExtensions(value) {
    const text = normalizeDomText(value);
    const pattern = new RegExp(`\\.${TEXT_PATH_EXTENSION_PATTERN}`, 'gi');
    const matches = text.match(pattern) || [];
    if (matches.length > 1) {
      return true;
    }
    return false;
  }

  function readFileTreeNodeText(node) {
    // Icon ligatures can be valid filename prefixes; use the actual label.
    const names = Array.from(node.querySelectorAll?.('.item-name') || []);
    if (names.length > 1) return '';
    return names.length === 1 ? names[0].textContent || '' : node.textContent || '';
  }

  function inferPathFromTreeAncestors(node, fileName) {
    const folders = [];
    let current = node?.parentElement || null;
    for (let depth = 0; current && depth < 8; depth += 1) {
      const folderName = readFolderNameFromNode(current);
      if (folderName) {
        folders.unshift(folderName);
      }
      current = current.parentElement;
    }
    if (!folders.length) {
      return '';
    }
    const path = normalizeSafeProjectPath([...folders, fileName].join('/'));
    return window.CodexOverleafProjectFiles.isTextProjectPath(path) ? path : '';
  }

  function inferFolderPathFromTreeAncestors(node, folderName) {
    const folders = [];
    let current = node?.parentElement || null;
    for (let depth = 0; current && depth < 8; depth += 1) {
      const parentFolderName = readFolderNameFromNode(current);
      if (parentFolderName) {
        folders.unshift(parentFolderName);
      }
      current = current.parentElement;
    }
    const path = normalizeSafeProjectPath([...folders, folderName].join('/'));
    return path && !window.CodexOverleafProjectFiles.isTextProjectPath(path) ? path : '';
  }

  function invalidateDomProjectPathCache() {
    domProjectPathCache = null;
    domProjectPathCacheTime = 0;
  }

  function readFolderNameFromNode(node) {
    const candidates = [
      node.getAttribute?.('data-name'),
      node.getAttribute?.('aria-label'),
      node.getAttribute?.('title')
    ];
    for (const value of candidates) {
      const folderName = normalizeFolderName(value);
      if (folderName) {
        return folderName;
      }
    }
    return '';
  }

  function normalizeFolderName(value) {
    const text = normalizeDomText(value);
    if (!text || /[\\/]/.test(text) || window.CodexOverleafProjectFiles.isTextProjectPath(text)) {
      return '';
    }
    if (new RegExp(`\\.${TEXT_PATH_EXTENSION_PATTERN}\\b`, 'i').test(text)) {
      return '';
    }
    if (/^(?:description|article|book_5|insert_drive_file|draft|text_snippet|note|chevron_right|expand_more|folder_open|folder|expand|collapse|open|close|menu)\b/i.test(text)) {
      return '';
    }
    if (/(?:more_vert|action menu|Menu)$/i.test(text)) {
      return '';
    }
    if (!/^[\w .@+-]+$/.test(text) || text.length > 80) {
      return '';
    }
    return text;
  }

  async function waitForActiveFile(filePath, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (getActiveFilePath() === filePath) {
        return true;
      }
      await delay(100);
    }
    return getActiveFilePath() === filePath;
  }

  async function waitForActiveEditorText(filePath, timeoutMs, options = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastText = '';
    while (Date.now() < deadline) {
      const activeFileMatches = !filePath || getActiveFilePath() === filePath;
      const text = readActiveEditorText();
      lastText = text;
      const knownEmptyEditor = options.allowEmpty === true && typeof text === 'string' && /^(?:\r?\n)*$/.test(text)
        && Boolean(getActiveEditorIdentity());
      const textReady = options.requireEmpty === true ? knownEmptyEditor
        : knownEmptyEditor || window.CodexOverleafProjectFiles.isUsableProjectFileContent(text);
      const signatureChanged = !options.notSignature || contentSignature(text) !== options.notSignature;
      if (activeFileMatches && textReady && signatureChanged) {
        return {
          ok: true,
          text
        };
      }
      await delay(150);
    }
    return {
      ok: false,
      text: lastText,
      reason: `Editor content was not ready for ${filePath || 'active file'}; last length ${String(lastText || '').length}`
    };
  }

  function contentSignature(content) {
    const text = String(content || '');
    return `${text.length}:${text.slice(0, 120)}:${text.slice(-120)}`;
  }

  function findFileTreeManager() {
    const roots = [window._ide, window.Overleaf, window.overleaf, window.OL].filter(Boolean);
    for (const root of roots) {
      for (const key of Object.keys(root)) {
        if (/file.*tree|tree.*file|file.*manager|entity.*manager/i.test(key) && root[key] && typeof root[key] === 'object') {
          return root[key];
        }
      }
    }
    return window._ide?.fileTreeManager || window._ide?.fileTree || null;
  }

  function findHistoryObject() {
    const roots = [window._ide, window.Overleaf, window.overleaf, window.OL].filter(Boolean);
    for (const root of roots) {
      for (const key of Object.keys(root)) {
        if (/history/i.test(key) && root[key] && typeof root[key] === 'object') {
          return root[key];
        }
      }
    }
    return null;
  }

  function delay(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

    async function navigateToFile(filePath, options = {}) {
      const normalizedPath = normalizeSafeProjectPath(filePath);
      if (!normalizedPath) {
        return {
          loaded: false,
          editorReady: false,
          reason: 'Invalid file path'
        };
      }
      const opened = await openFileByPath(normalizedPath);
      if (!opened.ok) {
        return {
          loaded: false,
          editorReady: false,
          reason: opened.reason || 'Could not open file'
        };
      }
      const ready = await waitForActiveEditorText(normalizedPath, resolveTimeoutMs(options, 2500));
      return {
        loaded: true,
        editorReady: ready.ok === true,
        method: opened.method,
        reason: ready.ok ? '' : ready.reason
      };
    }

    async function createFile(filePath, content, options = {}) {
      return callFileTreeMutation({
        type: 'create',
        path: filePath,
        content
      }, options);
    }

    async function renameFile(fromPath, toPath, options = {}) {
      return callFileTreeMutation({
        type: 'rename',
        path: fromPath,
        to: toPath
      }, options);
    }

    async function deleteFile(filePath, options = {}) {
      return callFileTreeMutation({
        type: 'delete',
        path: filePath
      }, options);
    }

    async function callFileTreeMutation(rawOperation, options = {}) {
      const operation = {
        ...rawOperation,
        path: normalizeSafeProjectPath(rawOperation.path),
        to: rawOperation.to ? normalizeSafeProjectPath(rawOperation.to) : rawOperation.to
      };
      if (!operation.path || ((operation.type === 'rename' || operation.type === 'move') && !operation.to)) {
        return buildTreeContractResult(operation, false, 'Invalid file-tree path');
      }

      const manager = findFileTreeManager();
      for (const methodName of fileTreeMethodNames(operation.type)) {
        const method = manager?.[methodName];
        if (typeof method !== 'function') {
          continue;
        }
        try {
          if (operation.type === 'create') {
            await method.call(manager, operation.path, normalizeCreateFileContent(operation.path, operation.content));
          } else if (operation.type === 'rename' || operation.type === 'move') {
            await method.call(manager, operation.path, operation.to);
          } else if (operation.type === 'delete') {
            await method.call(manager, operation.path);
          }
          await delay(120);
          return buildTreeContractResult(operation, verifyTreeMutation(operation), '', 'fileTreeManager.' + methodName);
        } catch (_error) {
          // Try the next known Overleaf file-tree method.
        }
      }
      return buildTreeContractResult(operation, false, 'No supported Overleaf file-tree method was detected');
    }

    function normalizeCreateFileContent(filePath, content) {
      if (content instanceof Uint8Array) {
        const fileName = String(filePath || '').split('/').filter(Boolean).pop() || 'asset';
        if (typeof File === 'function') {
          return new File([content], fileName);
        }
        return new Blob([content]);
      }
      return String(content || '');
    }

    function verifyTreeMutation(operation) {
      if (operation.type === 'delete') {
        return !projectPathExists(operation.path);
      }
      if (operation.type === 'rename' || operation.type === 'move') {
        return Boolean(operation.to && projectPathExists(operation.to) && !projectPathExists(operation.path));
      }
      return projectPathExists(operation.path);
    }

    function buildTreeContractResult(operation, ok, reason = '', method = '') {
      if (operation.type === 'delete') {
        return {
          deleted: ok,
          reason: ok ? '' : reason,
          method
        };
      }
      if (operation.type === 'rename' || operation.type === 'move') {
        return {
          renamed: ok,
          reason: ok ? '' : reason,
          method
        };
      }
      return {
        created: ok,
        reason: ok ? '' : reason,
        method
      };
    }

    function fileTreeMethodNames(type) {
      return {
        create: ['createDoc', 'createFile', 'addDoc', 'addFile'],
        rename: ['renameEntity', 'renameFile', 'renameDoc'],
        move: ['moveEntity', 'moveFile', 'moveDoc'],
        delete: ['deleteEntity', 'deleteFile', 'deleteDoc', 'removeEntity']
      }[type] || [];
    }

    function resolveTimeoutMs(options = {}, fallback) {
      const value = Number(options.timeoutMs);
      return Number.isFinite(value) && value >= 0 ? value : fallback;
    }

    installFileTreeSelectionTracking();

    return {
      collectDocRecords,
      collectDomProjectPaths,
      collectInternalRootKeys,
      collectProjectTextPaths,
      contentSignature,
      invalidateDomProjectPathCache,
      createFile,
      deleteFile,
      fileTreeMethodNames,
      findFileTreeManager,
      findFileTreeNode,
      findHistoryObject,
      getActiveFilePath,
      getEditorStoreFilePath,
      getRecentFileTreeSelectionPath,
      getProjectId,
      navigateToFile,
      openFileByPath,
      projectPathExists,
      readProjectPathFromNode,
      renameFile,
      waitForActiveEditorText,
      waitForActiveFile
    };
  }

  function fallbackNormalizeSafeProjectPath(value) {
    const text = String(value || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '').trim();
    if (!text || text.split('/').some(part => !part || part === '.' || part === '..')) {
      return '';
    }
    return text;
  }

  return { create };
});
