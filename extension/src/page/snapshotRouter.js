(function initCodexOverleafSnapshotRouter(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafSnapshotRouter = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function snapshotRouterFactory() {
  'use strict';

  const ZIP_FETCH_TIMEOUT_MS = 30000;
  const MAX_BINARY_FILE_BYTES = 10 * 1024 * 1024;
  const MAX_BINARY_TOTAL_BYTES = 80 * 1024 * 1024;

  function create(deps = {}) {
    const window = deps.window || (typeof globalThis !== 'undefined' ? globalThis : {});
    const treeOperations = deps.treeOperations || {};
    const normalizeSafeProjectPath = typeof deps.normalizePath === 'function'
      ? deps.normalizePath
      : fallbackNormalizeSafeProjectPath;
    const readActiveEditorText = typeof deps.readActiveEditorText === 'function'
      ? deps.readActiveEditorText
      : () => '';
    let invalidatedAt = 0;
    let preferredZipEndpoint = '';
    const writebackReads = new Set();

    function getProjectId() {
      return treeOperations.getProjectId?.() || null;
    }

    function getActiveFilePath() {
      return treeOperations.getActiveFilePath?.() || '';
    }

    function getPassiveActiveFilePath() {
      const path = treeOperations.getEditorStoreFilePath?.({ passive: true }) || '';
      return normalizeSafeProjectPath(path);
    }

    function collectDocRecords(options = {}) {
      return treeOperations.collectDocRecords?.(options) || [];
    }

    function collectDomProjectPaths() {
      return treeOperations.collectDomProjectPaths?.() || [];
    }

    function collectProjectTextPaths(activePath) {
      return treeOperations.collectProjectTextPaths?.(activePath) || [];
    }

    function openFileByPath(filePath) {
      return treeOperations.openFileByPath?.(filePath) || Promise.resolve({ ok: false, reason: 'Tree operations are unavailable' });
    }

    function waitForActiveFile(filePath, timeoutMs) {
      return treeOperations.waitForActiveFile?.(filePath, timeoutMs) || Promise.resolve(false);
    }

    function waitForActiveEditorText(filePath, timeoutMs, options = {}) {
      return treeOperations.waitForActiveEditorText?.(filePath, timeoutMs, options)
        || Promise.resolve({ ok: false, text: '', reason: 'Tree operations are unavailable' });
    }

    function contentSignature(content) {
      const fallback = String(content || '');
      return treeOperations.contentSignature?.(content) || (fallback.length + ':' + fallback.slice(0, 120));
    }

  async function buildProjectFileList(params = {}) {
    const activePath = getActiveFilePath();
    const internalDocRecords = collectDocRecords({ includeWindowGlobals: false });
    const docRecordByPath = new Map(internalDocRecords.map(record => [record.path, record]));
    if (params.preferExact !== false) {
      const zipSnapshot = await fetchProjectZipSnapshot({
        ...params,
        includeBinaryFiles: true,
        includeContent: false
      });
      if (zipSnapshot.ok && zipSnapshot.files.length) {
        const paths = collectUniqueProjectPaths(zipSnapshot.files.map(file => file.path), 1000);
        const zipFileByPath = buildProjectFileEntryLookup(zipSnapshot.files);
        return {
          ok: true,
          id: getProjectId(),
          url: window.location.href,
          activePath,
          files: paths.map(path => {
            const isText = window.CodexOverleafProjectFiles.isTextProjectPath(path);
            return {
              path,
              active: path === activePath,
              source: 'overleaf-zip',
              kind: isText ? 'text' : 'binary',
              selectable: isText,
              ...buildFileSizeMetadata(zipFileByPath.get(path))
            };
          }),
          capabilities: {
            fullProjectSnapshot: true,
            method: 'overleaf-zip-file-list',
            skipped: [],
            diagnostics: {
              zipEndpoint: zipSnapshot.endpoint,
              zipTiming: zipSnapshot.diagnostics,
              docRecordCount: internalDocRecords.length,
              docRecords: internalDocRecords.slice(0, 8)
            },
            note: 'Listed Overleaf project files from the exact source ZIP file tree.'
          }
        };
      }
      if (params.exactOnly === true || params.requireExact === true) {
        return {
          ok: false,
          id: getProjectId(),
          url: window.location.href,
          activePath,
          files: [],
          reason: zipSnapshot.reason || 'Overleaf source ZIP was unavailable',
          capabilities: {
            fullProjectSnapshot: false,
            method: 'overleaf-zip-file-list-unavailable',
            skipped: [{
              path: 'project.zip',
              reason: zipSnapshot.reason || 'Overleaf source ZIP was unavailable'
            }],
            diagnostics: {
              zipTiming: zipSnapshot.diagnostics,
              docRecordCount: internalDocRecords.length,
              docRecords: internalDocRecords.slice(0, 8)
            },
            note: 'The exact Overleaf source ZIP file tree was required, so the page file tree fallback was not used.'
          }
        };
      }
    }

    const paths = collectProjectFileListPaths(activePath, internalDocRecords);
    return {
      ok: true,
      id: getProjectId(),
      url: window.location.href,
      activePath,
      files: paths.map(path => ({
        path,
        active: path === activePath,
        source: docRecordByPath.has(path) ? 'overleaf-doc-record' : path === activePath ? 'active-file' : 'page-file-list'
      })),
      capabilities: {
        fullProjectSnapshot: false,
        method: 'overleaf-file-tree',
        skipped: [],
        diagnostics: {
          docRecordCount: internalDocRecords.length,
          docRecords: internalDocRecords.slice(0, 8)
        },
        note: 'Listed Overleaf project text files from page state without downloading the source ZIP.'
      }
    };
  }

  function collectProjectFileListPaths(activePath, docRecords = []) {
    const domPaths = collectDomProjectPaths();
    const domPathSet = new Set(domPaths);
    const docPaths = docRecords
      .map(record => record.path)
      .filter(path => window.CodexOverleafProjectFiles.isTextProjectPath(path));
    const activePaths = domPathSet.has(activePath) ? [activePath] : [];
    return window.CodexOverleafProjectFiles.collectUniqueTextPaths([
      ...activePaths,
      ...domPaths,
      ...docPaths
    ], 160);
  }

  function collectUniqueProjectPaths(paths, limit = 1000) {
    const seen = new Set();
    const result = [];
    for (const rawPath of paths || []) {
      const path = normalizeSafeProjectPath(rawPath);
      if (!isSafeProjectPath(path) || seen.has(path)) {
        continue;
      }
      seen.add(path);
      result.push(path);
      if (result.length >= limit) {
        break;
      }
    }
    return result;
  }

  function buildProjectFileEntryLookup(files = []) {
    const entries = new Map();
    for (const file of files || []) {
      const path = normalizeSafeProjectPath(file?.path);
      if (!isSafeProjectPath(path) || entries.has(path)) {
        continue;
      }
      entries.set(path, file);
    }
    return entries;
  }

  function buildFileSizeMetadata(file = {}) {
    const size = Number(file?.size ?? file?.byteLength);
    return Number.isFinite(size) && size >= 0 ? { size } : {};
  }

  function isSafeProjectPath(path) {
    return Boolean(path && normalizeSafeProjectPath(path) === path && !path.endsWith('/'));
  }

  async function buildProjectSnapshot(params = {}) {
    if (params.zipOnly || params.serverOnly === true) {
      return buildZipOnlyProjectSnapshot(params);
    }

    const activePath = getActiveFilePath();
    const internalDocRecords = collectDocRecords();
    const docRecordByPath = new Map(internalDocRecords.map(record => [record.path, record]));
    let lightweightSnapshot = null;

    if (params.preferLightweight) {
      lightweightSnapshot = await buildPageProjectSnapshot({
        params,
        activePath,
        internalDocRecords,
        docRecordByPath,
        zipSnapshot: null,
        lightweightOnly: true
      });
      if (
        params.allowZipFallback === false
        || lightweightSnapshot.files.length && (!params.requireFullProject || lightweightSnapshot.capabilities.fullProjectSnapshot)
      ) {
        return lightweightSnapshot;
      }
    }

    const zipSnapshot = await fetchProjectZipSnapshot(params);
    if (zipSnapshot.ok && zipSnapshot.files.length) {
      const mergedFiles = mergeSnapshotFiles(
        zipSnapshot.files,
        filterZipSnapshotOverlayFiles(zipSnapshot.files, lightweightSnapshot?.files || [])
      );
      const files = filterRequestedSnapshotFiles(mergedFiles, params, activePath);
      const requestedPathsComplete = params.restrictToRequestedPathsOnly === true
        ? isCompleteProjectSnapshot(files, getRequestedSnapshotPaths(params, activePath))
        : true;
      return {
        id: getProjectId(),
        url: window.location.href,
        activePath,
        files,
        capabilities: {
          fullProjectSnapshot: params.restrictToRequestedPathsOnly === true ? false : true,
          requestedPathsComplete,
          method: 'overleaf-zip',
          skipped: zipSnapshot.skipped || [],
          diagnostics: {
            zipEndpoint: zipSnapshot.endpoint,
            zipTiming: zipSnapshot.diagnostics,
            docRecordCount: internalDocRecords.length,
            docRecords: internalDocRecords.slice(0, 8)
          },
          note: 'Captured project text files from Overleaf source ZIP using the current browser session.'
        }
      };
    }

    if (params.allowEditorNavigation === false) {
      return buildPageProjectSnapshot({
        params,
        activePath,
        internalDocRecords,
        docRecordByPath,
        zipSnapshot,
        lightweightOnly: true
      });
    }

    return buildPageProjectSnapshot({
      params,
      activePath,
      internalDocRecords,
      docRecordByPath,
      zipSnapshot,
      lightweightOnly: false
    });
  }

  async function buildPageProjectSnapshot({
    params = {},
    activePath,
    internalDocRecords,
    docRecordByPath,
    zipSnapshot,
    lightweightOnly
  }) {
    const snapshotActivePath = params.allowEditorNavigation === false
      ? getActiveFilePath()
      : activePath;
    const requestedPaths = [
      snapshotActivePath,
      ...(Array.isArray(params.focusFiles) ? params.focusFiles : [])
    ];
    const projectPaths = window.CodexOverleafProjectFiles.collectUniqueTextPaths(
      params.restrictToRequestedPathsOnly === true
        ? requestedPaths
        : [
          ...requestedPaths,
          ...collectProjectTextPaths(snapshotActivePath)
        ],
      80
    );
    const files = [];
    const skipped = [];
    if (zipSnapshot && !zipSnapshot.ok) {
      skipped.push({
        path: 'project.zip',
        reason: zipSnapshot.reason
      });
    }
    let previousSignature = '';

    for (const filePath of projectPaths) {
      if (filePath === snapshotActivePath) {
        const ready = await waitForActiveEditorText(filePath, 5000);
        if (!ready.ok) {
          skipped.push({
            path: filePath,
            reason: ready.reason
          });
          continue;
        }
        files.push({
          path: filePath,
          content: ready.text,
          source: 'active-editor'
        });
        previousSignature = contentSignature(ready.text);
        continue;
      }

      const docRecord = docRecordByPath.get(filePath);
      if (docRecord) {
        const fetched = await fetchOverleafDocContent(docRecord);
        if (fetched.ok) {
          files.push({
            path: filePath,
            content: fetched.content,
            source: fetched.method
          });
          previousSignature = contentSignature(fetched.content);
          continue;
        }
        skipped.push({
          path: filePath,
          reason: fetched.reason
        });
      }

      if (!canOpenInactiveFileForSnapshot(filePath, params, lightweightOnly, docRecord)) {
        skipped.push({
          path: filePath,
          reason: 'Lightweight snapshot skipped opening inactive files'
        });
        continue;
      }

      const opened = await openFileByPath(filePath);
      if (!opened.ok) {
        skipped.push({
          path: filePath,
          reason: opened.reason || 'open failed'
        });
        continue;
      }

      await waitForActiveFile(filePath, 5000);
      const ready = await waitForActiveEditorText(filePath, 7000, {
        notSignature: previousSignature
      });
      if (!ready.ok) {
        skipped.push({
          path: filePath,
          reason: ready.reason
        });
        continue;
      }
      files.push({
        path: filePath,
        content: ready.text,
        source: opened.method || 'file-tree-open'
      });
      previousSignature = contentSignature(ready.text);
    }

    if (params.allowEditorNavigation !== false && activePath && getActiveFilePath() !== activePath) {
      await openFileByPath(activePath);
      await waitForActiveFile(activePath, 5000);
      await waitForActiveEditorText(activePath, 5000);
    }

    if (snapshotActivePath && !files.length && (!lightweightOnly || params.allowZipFallback === false)) {
      files.push({
        path: snapshotActivePath,
        content: readActiveEditorText(),
        source: 'active-editor'
      });
    }

    const requestedPathsComplete = isCompleteProjectSnapshot(files, projectPaths);
    return {
      id: getProjectId(),
      url: window.location.href,
      activePath: snapshotActivePath,
      files,
      capabilities: {
        fullProjectSnapshot: params.restrictToRequestedPathsOnly === true ? false : requestedPathsComplete,
        requestedPathsComplete,
        method: resolvePageSnapshotMethod(files, lightweightOnly),
        skipped,
        diagnostics: {
          docRecordCount: internalDocRecords.length,
          docRecords: internalDocRecords.slice(0, 8)
        },
        note: lightweightOnly
          ? 'Captured current Overleaf text from page/editor state without downloading the source ZIP.'
          : (files.length > 1
            ? 'Captured text project files from Overleaf document data, with editor fallback when needed.'
            : 'Only the active editor was captured; no additional visible text files were detected.')
      }
    };
  }

  async function buildZipOnlyProjectSnapshot(params = {}) {
    const activePath = getPassiveActiveFilePath();
    const activeText = params.serverOnly === true ? '' : activePath ? readActiveEditorText() : '';

    const zipSnapshot = await fetchProjectZipSnapshot(params);
    if (zipSnapshot.ok && zipSnapshot.files.length) {
      const activeOverlay = params.serverOnly === true ? [] : buildActiveEditorOverlay(activePath, activeText, {
        allowedPaths: zipSnapshot.files.map(file => file.path)
      });
      const files = filterRequestedSnapshotFiles(
        mergeSnapshotFiles(zipSnapshot.files, activeOverlay),
        params,
        activePath
      );
      const requestedPathsComplete = params.restrictToRequestedPathsOnly === true
        ? isCompleteProjectSnapshot(files, getRequestedSnapshotPaths(params, activePath))
        : true;
      return {
        id: getProjectId(),
        url: window.location.href,
        activePath,
        files,
        capabilities: {
          fullProjectSnapshot: params.restrictToRequestedPathsOnly === true ? false : true,
          requestedPathsComplete,
          method: 'overleaf-zip',
          skipped: zipSnapshot.skipped || [],
          diagnostics: {
            zipEndpoint: zipSnapshot.endpoint,
            zipTiming: zipSnapshot.diagnostics,
            docRecordCount: 0,
            docRecords: []
          },
          note: 'Captured project files from Overleaf source ZIP without inspecting or opening the file tree.'
        }
      };
    }

    return {
      id: getProjectId(),
      url: window.location.href,
      activePath,
      files: params.serverOnly === true ? [] : buildActiveEditorOverlay(activePath, activeText),
      capabilities: {
        fullProjectSnapshot: false,
        method: params.serverOnly === true ? 'overleaf-zip-unavailable'
          : activePath && window.CodexOverleafProjectFiles.isUsableProjectFileContent(activeText)
          ? 'active-editor-zip-only-fallback'
          : 'zip-only-fallback-empty',
        skipped: [{
          path: 'project.zip',
          reason: zipSnapshot.reason
        }],
        diagnostics: {
          docRecordCount: 0,
          docRecords: []
        },
        note: params.serverOnly === true
          ? 'The server snapshot was unavailable; editor content was not used as save evidence.'
          : 'Only the current editor was read because the Overleaf source ZIP was unavailable; no file tree navigation was attempted.'
      }
    };
  }

  function filterZipSnapshotOverlayFiles(zipFiles = [], overlayFiles = []) {
    const zipPaths = new Set((zipFiles || []).map(file => file.path).filter(Boolean));
    return (overlayFiles || []).filter(file => file?.source !== 'active-editor' || zipPaths.has(file.path));
  }

  function getRequestedSnapshotPaths(params = {}, activePath = '') {
    return window.CodexOverleafProjectFiles.collectUniqueTextPaths([
      activePath,
      ...(Array.isArray(params.focusFiles) ? params.focusFiles : [])
    ], 80);
  }

  function filterRequestedSnapshotFiles(files = [], params = {}, activePath = '') {
    if (params.restrictToRequestedPathsOnly !== true) {
      return files;
    }
    const requestedSet = new Set(getRequestedSnapshotPaths(params, activePath));
    return (files || []).filter(file => requestedSet.has(file?.path));
  }

  function buildActiveEditorOverlay(activePath, activeText, options = {}) {
    if (!activePath || !window.CodexOverleafProjectFiles.isUsableProjectFileContent(activeText)) {
      return [];
    }
    if (Array.isArray(options.allowedPaths) && !options.allowedPaths.includes(activePath)) {
      return [];
    }
    return [{
      path: activePath,
      content: activeText,
      source: 'active-editor',
      kind: 'text'
    }];
  }

  function mergeSnapshotFiles(primaryFiles = [], overrideFiles = []) {
    const filesByPath = new Map((primaryFiles || []).map(file => [file.path, { ...file }]));
    for (const file of overrideFiles || []) {
      if (!file?.path || file.kind === 'binary' || typeof file.content !== 'string') {
        continue;
      }
      if (!window.CodexOverleafProjectFiles.isUsableProjectFileContent(file.content)) {
        continue;
      }
      filesByPath.set(file.path, {
        ...(filesByPath.get(file.path) || {}),
        ...file,
        kind: 'text'
      });
    }
    return Array.from(filesByPath.values());
  }

  function resolvePageSnapshotMethod(files, lightweightOnly) {
    if (files.some(file => /^overleaf-doc-fetch/.test(file.source))) {
      return lightweightOnly ? 'overleaf-doc-fetch-lightweight' : 'overleaf-doc-fetch';
    }
    if (files.length > 1) {
      return lightweightOnly ? 'page-text-files-lightweight' : 'open-file-tree-text-files';
    }
    return lightweightOnly ? 'active-editor-lightweight' : 'active-editor';
  }

  function isFocusSnapshotPath(filePath, params = {}) {
    return Array.isArray(params.focusFiles) && params.focusFiles.includes(filePath);
  }

  function canOpenInactiveFileForSnapshot(filePath, params = {}, lightweightOnly, docRecord) {
    if (!lightweightOnly) {
      return true;
    }
    if (docRecord) {
      return true;
    }
    return params.allowEditorNavigation === true && isFocusSnapshotPath(filePath, params);
  }

  function isCompleteProjectSnapshot(files, projectPaths) {
    if (!Array.isArray(projectPaths) || !projectPaths.length) {
      return false;
    }
    const capturedPaths = new Set((files || []).map(file => file.path));
    return projectPaths.every(filePath => capturedPaths.has(filePath));
  }

  async function fetchOverleafDocContent(record) {
    if (!record?.id || !record.path) {
      return {
        ok: false,
        reason: 'Missing Overleaf doc id'
      };
    }

    const projectId = getProjectId();
    if (!projectId) {
      return {
        ok: false,
        reason: 'Missing Overleaf project id'
      };
    }

    try {
      const response = await fetch(`${window.location.origin}/project/${encodeURIComponent(projectId)}/doc/${encodeURIComponent(record.id)}`, {
        credentials: 'include',
        headers: {
          accept: 'application/json'
        }
      });
      if (!response.ok) {
        return {
          ok: false,
          reason: `Overleaf doc fetch returned ${response.status}`
        };
      }
      const payload = await response.json();
      const content = readDocPayloadContent(payload);
      if (!window.CodexOverleafProjectFiles.isUsableProjectFileContent(content)) {
        return {
          ok: false,
          reason: 'Overleaf doc fetch returned empty/loading content'
        };
      }
      return {
        ok: true,
        content,
        method: 'overleaf-doc-fetch'
      };
    } catch (error) {
      return {
        ok: false,
        reason: `Overleaf doc fetch failed: ${error.message}`
      };
    }
  }

  async function fetchProjectZipSnapshot(params = {}, reference = null) {
    // Cross-project reads use a separate internal argument. Normal snapshot
    // RPC parameters cannot change the active project's snapshot identity.
    const projectId = reference ? String(reference.projectId || '') : getProjectId();
    if (reference && !/^[a-f0-9]{24}$/i.test(projectId)) {
      return { ok: false, reason: 'Reference project identity is invalid' };
    }
    if (!projectId) {
      return {
        ok: false,
        reason: 'Missing Overleaf project id'
      };
    }
    const timeoutMs = normalizeZipFetchTimeout(params.zipTimeoutMs);

    const endpoints = [
      `${window.location.origin}/project/${encodeURIComponent(projectId)}/download/zip`,
      `${window.location.origin}/download/project/${encodeURIComponent(projectId)}`
    ].map(endpoint => params.serverOnly === true
      ? endpoint + '?codex_save_check=' + encodeURIComponent(String(params.saveCheckId || Date.now()).slice(0, 80))
      : endpoint);
    const orderedEndpoints = preferredZipEndpoint && endpoints.includes(preferredZipEndpoint)
      ? [preferredZipEndpoint, ...endpoints.filter(endpoint => endpoint !== preferredZipEndpoint)]
      : endpoints;

    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    const errors = [];
    const attempts = [];
    for (const endpoint of orderedEndpoints) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        errors.push(`Overleaf ZIP download exhausted its ${timeoutMs}ms total timeout budget`);
        break;
      }
      const attemptStartedAt = Date.now();
      try {
        const { response, contentType, buffer, timing } = await fetchZipEndpoint(endpoint, remainingMs,
          reference?.signal || params.signal, !reference && (params.writebackVerification === true || params.serverOnly === true));
        if (reference?.signal?.aborted) throw new Error('Reference reading was cancelled');
        if (!response.ok) {
          attempts.push({
            endpoint,
            status: response.status,
            elapsedMs: Date.now() - attemptStartedAt
          });
          errors.push(`${endpoint} returned ${response.status}`);
          continue;
        }
        const extractStartedAt = Date.now();
        const extracted = await extractFilesFromZip(buffer, {
          includeBinaryFiles: Boolean(params.includeBinaryFiles),
          includeContent: params.includeContent !== false
        });
        const extractMs = Date.now() - extractStartedAt;
        const files = extracted.files || [];
        if (!files.length) {
          attempts.push({
            endpoint,
            status: response.status,
            elapsedMs: Date.now() - attemptStartedAt,
            downloadMs: timing.totalMs,
            extractMs
          });
          errors.push(`${endpoint} returned no text files (${contentType || 'unknown content type'})`);
          continue;
        }
        preferredZipEndpoint = endpoint;
        attempts.push({
          endpoint,
          status: response.status,
          elapsedMs: Date.now() - attemptStartedAt,
          timeToHeadersMs: timing.timeToHeadersMs,
          downloadMs: timing.totalMs,
          extractMs,
          bytes: buffer?.byteLength || 0
        });
        return {
          ok: true,
          endpoint,
          skipped: extracted.skipped || [],
          files: files.map(file => ({
            ...file,
            source: 'overleaf-zip'
          })),
          diagnostics: {
            totalMs: Date.now() - startedAt,
            timeoutBudgetMs: timeoutMs,
            attempts
          }
        };
      } catch (error) {
        attempts.push({
          endpoint,
            error: error.message,
            ...(error.timing || {}),
          elapsedMs: Date.now() - attemptStartedAt
        });
        errors.push(`${endpoint} failed: ${error.message}`);
        if (reference?.signal?.aborted) break;
        if (error?.code === 'zip_timeout') {
          errors.push(`Overleaf ZIP download exhausted its ${timeoutMs}ms total timeout budget`);
          break;
        }
      }
    }

    return {
      ok: false,
      reason: errors.join('; ') || 'Overleaf source ZIP was unavailable',
      diagnostics: {
        totalMs: Date.now() - startedAt,
        timeoutBudgetMs: timeoutMs,
        attempts
      }
    };
  }

  function fetchZipEndpoint(endpoint, timeoutMs, parentSignal, writeback = false) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (writeback && controller) writebackReads.add(controller);
    const started = Date.now(), observedTiming = {};
    const abort = () => controller?.abort();
    if (controller && parentSignal) {
      if (parentSignal.aborted) controller.abort();
      else parentSignal.addEventListener('abort', abort, { once: true });
    }
    const request = (async () => {
      const startedAt = Date.now();
      const response = await fetch(endpoint, {
        credentials: 'include',
        headers: {
          accept: 'application/zip,application/octet-stream,*/*'
        },
        ...(controller ? { signal: controller.signal } : {})
      });
      const headersAt = Date.now();
      observedTiming.timeToHeadersMs = headersAt - started;
      observedTiming.status = response.status;
      const contentType = response.headers.get('content-type') || '';
      const buffer = response.ok ? await response.arrayBuffer() : null;
      return {
        response,
        contentType,
        buffer,
        timing: {
          timeToHeadersMs: headersAt - startedAt,
          totalMs: Date.now() - startedAt
        }
      };
    })();

    return withTimeout(request, timeoutMs, () => {
      controller?.abort();
    }, `Overleaf ZIP download timed out after ${timeoutMs}ms`).catch(error => {
      error.timing = { ...observedTiming, downloadMs: Date.now() - started };
      throw error;
    }).finally(() => {
      if (controller) writebackReads.delete(controller);
      parentSignal?.removeEventListener?.('abort', abort);
    });
  }

  function withTimeout(promise, timeoutMs, onTimeout, message) {
    let timeoutId = null;
    const timeout = new Promise((_resolve, reject) => {
      timeoutId = window.setTimeout(() => {
        const timeoutError = new Error(message);
        timeoutError.code = 'zip_timeout';
        reject(timeoutError);
        try {
          onTimeout?.();
        } catch (_error) {}
      }, timeoutMs);
    });

    return Promise.race([promise, timeout])
      .finally(() => {
        if (timeoutId) {
          window.clearTimeout(timeoutId);
        }
      });
  }

  function normalizeZipFetchTimeout(value) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 100) {
      return Math.min(parsed, 30000);
    }
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return ZIP_FETCH_TIMEOUT_MS;
  }

  async function extractFilesFromZip(buffer, options = {}) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const eocdOffset = findEndOfCentralDirectory(view);
    if (eocdOffset < 0) {
      throw new Error('ZIP end-of-central-directory record was not found');
    }

    const entryCount = view.getUint16(eocdOffset + 10, true);
    const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
    const decoder = new TextDecoder('utf-8');
    const files = [];
    const skipped = [];
    let binaryBytes = 0;
    let offset = centralDirectoryOffset;

    for (let index = 0; index < entryCount; index += 1) {
      if (view.getUint32(offset, true) !== 0x02014b50) {
        throw new Error('Invalid ZIP central-directory header');
      }

      const compressionMethod = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const fileNameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localHeaderOffset = view.getUint32(offset + 42, true);
      const rawName = bytes.slice(offset + 46, offset + 46 + fileNameLength);
      const path = normalizeSafeProjectPath(decoder.decode(rawName));
      const isText = window.CodexOverleafProjectFiles.isTextProjectPath(path);
      const shouldInclude = path && !path.endsWith('/') && (isText || options.includeBinaryFiles);

      if (shouldInclude) {
        const file = { path, size: uncompressedSize };
        if (options.includeContent !== false && (isText || options.includeBinaryFiles)) {
          if (!isText) {
            if (uncompressedSize > MAX_BINARY_FILE_BYTES) {
              skipped.push({
                path,
                reason: 'binary_file_too_large',
                size: uncompressedSize
              });
              offset += 46 + fileNameLength + extraLength + commentLength;
              continue;
            }
            if (binaryBytes + uncompressedSize > MAX_BINARY_TOTAL_BYTES) {
              skipped.push({
                path,
                reason: 'binary_project_too_large',
                size: uncompressedSize
              });
              offset += 46 + fileNameLength + extraLength + commentLength;
              continue;
            }
            binaryBytes += uncompressedSize;
          }
          const contentBytes = await readZipEntryBytes(view, bytes, localHeaderOffset, compressedSize, compressionMethod);
          if (isText) {
            file.content = decoder.decode(contentBytes);
          } else {
            file.contentBase64 = uint8ArrayToBase64(contentBytes);
            file.size = contentBytes.byteLength;
          }
        }
        files.push({
          ...file,
          kind: isText ? 'text' : 'binary'
        });
      }

      offset += 46 + fileNameLength + extraLength + commentLength;
    }

    return { files, skipped };
  }

  function uint8ArrayToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return window.btoa(binary);
  }

  function findEndOfCentralDirectory(view) {
    const minOffset = Math.max(0, view.byteLength - 0xffff - 22);
    for (let offset = view.byteLength - 22; offset >= minOffset; offset -= 1) {
      if (view.getUint32(offset, true) === 0x06054b50) {
        return offset;
      }
    }
    return -1;
  }

  async function readZipEntryBytes(view, bytes, localHeaderOffset, compressedSize, compressionMethod) {
    if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
      throw new Error('Invalid ZIP local-file header');
    }
    const localFileNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    const compressed = bytes.slice(dataOffset, dataOffset + compressedSize);

    if (compressionMethod === 0) {
      return compressed;
    }
    if (compressionMethod === 8) {
      return inflateRaw(compressed);
    }
    throw new Error(`Unsupported ZIP compression method ${compressionMethod}`);
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('Browser does not support DecompressionStream');
    }

    const errors = [];
    for (const format of ['deflate-raw', 'deflate']) {
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
        const response = new Response(stream);
        return new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        errors.push(`${format}: ${error.message}`);
      }
    }
    throw new Error(`Could not inflate ZIP entry (${errors.join('; ')})`);
  }

  function readDocPayloadContent(payload) {
    const candidates = [
      payload?.lines,
      payload?.doc?.lines,
      payload?.document?.lines,
      payload?.content,
      payload?.doc?.content,
      payload?.document?.content
    ];

    for (const candidate of candidates) {
      if (Array.isArray(candidate) && candidate.every(line => typeof line === 'string')) {
        return candidate.join('\n');
      }
      if (typeof candidate === 'string') {
        return candidate;
      }
    }

    return '';
  }

    async function assembleSnapshot(options = {}) {
      const timeoutMs = Number(options.timeoutMs);
      const params = Number.isFinite(timeoutMs) && timeoutMs >= 0
        ? { ...options, zipTimeoutMs: timeoutMs }
        : options;
      const snapshot = await buildProjectSnapshot(params);
      return {
        ...snapshot,
        source: snapshot?.capabilities?.method || '',
        timestamp: Date.now()
      };
    }

    async function readFileTree(options = {}) {
      const timeoutMs = Number(options.timeoutMs);
      const result = await buildProjectFileList({
        ...options,
        ...(Number.isFinite(timeoutMs) && timeoutMs >= 0 ? { zipTimeoutMs: timeoutMs } : {})
      });
      if (!result.ok) {
        throw new Error(result.reason || 'Could not read Overleaf project file tree');
      }
      return (result.files || []).map(file => ({
        path: file.path,
        type: file.kind || (file.selectable === false ? 'binary' : 'text'),
        size: file.size
      }));
    }

    function invalidateCache() {
      invalidatedAt = Date.now();
    }

    function getInvalidatedAt() {
      return invalidatedAt;
    }

    return {
      assembleSnapshot,
      buildProjectFileList,
      buildProjectSnapshot,
      fetchProjectZipSnapshot,
      getInvalidatedAt,
      getRequestedSnapshotPaths,
      invalidateCache,
      cancelWritebackReads() { for (const controller of writebackReads) controller.abort(); },
      readFileTree
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
