(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafReferenceProjects = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
  const MAX_PROJECT_BYTES = 4 * 1024 * 1024;
  const validId = value => /^[a-f0-9]{24}$/i.test(value);

  function failure(code, message) { return Object.assign(new Error(message), { code }); }

  function parseCatalog(doc) {
    const element = doc.querySelector('meta[name="ol-prefetchedProjectsBlob"]')
      || doc.querySelector('meta[name="ol-projects"]');
    if (!element) throw failure('reference_catalog_unavailable',
      'Overleaf did not return its project directory. Check that this account is signed in, then retry.');
    let data;
    try { data = JSON.parse(element.getAttribute('content') || ''); }
    catch (_) { throw failure('reference_catalog_invalid', 'Overleaf returned an unreadable project directory. Retry loading projects.'); }
    const rows = Array.isArray(data) ? data : data?.projects;
    if (!Array.isArray(rows)) throw failure('reference_catalog_invalid', 'Overleaf returned an invalid project directory.');
    const total = Array.isArray(data) ? rows.length : Number(data.totalSize);
    if (Number.isFinite(total) && total > rows.length) {
      throw failure('reference_catalog_incomplete', 'Overleaf returned only part of the project directory. Refresh Overleaf and retry loading projects.');
    }
    const result = new Map();
    for (const row of rows) {
      if (row?.trashed === true) continue;
      const projectId = String(row?.id || row?._id || '');
      if (!validId(projectId) || typeof row?.name !== 'string') {
        throw failure('reference_catalog_invalid', 'A project entry could not be read. Retry loading the directory.');
      }
      result.set(projectId, {
        projectId, name: row.name.slice(0, 300),
        archived: row.archived === true,
        shared: row.accessLevel !== 'owner',
        readOnly: ['readOnly', 'read-only', 'read'].includes(row.accessLevel),
        lastUpdated: typeof row.lastUpdated === 'string' ? row.lastUpdated : ''
      });
    }
    return [...result.values()].sort((a, b) =>
      (Date.parse(b.lastUpdated) || 0) - (Date.parse(a.lastUpdated) || 0) || a.name.localeCompare(b.name));
  }

  function create(deps = {}) {
    const pageWindow = deps.window || window;
    const fetchImpl = deps.fetch || pageWindow.fetch.bind(pageWindow);
    const reads = new Map();

    async function catalogText(response) {
      if (Number(response.headers.get('content-length')) > MAX_CATALOG_BYTES) {
        throw failure('reference_catalog_too_large', 'The Overleaf project directory is too large to load.');
      }
      if (!response.body?.getReader) {
        const text = await response.text();
        if (new TextEncoder().encode(text).byteLength > MAX_CATALOG_BYTES) {
          throw failure('reference_catalog_too_large', 'The Overleaf project directory is too large to load.');
        }
        return text;
      }
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let bytes = 0, text = '';
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_CATALOG_BYTES) {
            await reader.cancel();
            throw failure('reference_catalog_too_large', 'The Overleaf project directory is too large to load.');
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        return text + decoder.decode();
      } finally { reader.releaseLock(); }
    }

    async function listProjects() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetchImpl(new URL('/project', pageWindow.location.origin).href, {
          credentials: 'include', cache: 'no-store', headers: { accept: 'text/html' },
          signal: controller.signal
        });
        if (!response.ok) throw failure('reference_catalog_http', 'Overleaf could not load projects (HTTP ' + response.status + '). Retry loading projects.');
        if (response.url && new URL(response.url).origin !== pageWindow.location.origin) {
          throw failure('reference_catalog_login', 'Sign in to Overleaf on this domain, then retry loading projects.');
        }
        const text = await catalogText(response);
        const parser = new pageWindow.DOMParser();
        const projects = parseCatalog(parser.parseFromString(text, 'text/html'));
        return { ok: true, projects, total: projects.length, capturedAt: new Date().toISOString() };
      } catch (error) {
        return { ok: false, code: error.code || 'reference_catalog_failed',
          error: controller.signal.aborted ? 'Loading Overleaf projects timed out. Retry loading projects.' : error.message };
      } finally { clearTimeout(timer); }
    }

    async function readProject(params = {}) {
      const projectId = String(params.projectId || '');
      const requestId = String(params.requestId || '');
      if (!validId(projectId) || !requestId || requestId.length > 160) {
        return { ok: false, code: 'reference_project_invalid', error: 'Reference project identity is invalid.' };
      }
      if (reads.has(requestId)) return { ok: false, code: 'reference_read_busy', error: 'This reference read is already running.' };
      const controller = new AbortController();
      reads.set(requestId, controller);
      try {
        const snapshot = await deps.snapshotRouter.fetchProjectZipSnapshot({
          includeBinaryFiles: false, includeContent: true, zipTimeoutMs: 30000
        }, { projectId, signal: controller.signal });
        if (controller.signal.aborted) throw failure('reference_read_cancelled', 'Reference reading was cancelled.');
        if (!snapshot?.ok) throw failure('reference_project_unavailable', snapshot?.reason || 'The reference project could not be read.');
        const files = (snapshot.files || []).filter(file => /\.tex$/i.test(file.path || ''));
        if (!files.length) throw failure('reference_project_empty', 'This project contains no readable TeX files.');
        if (files.length > 1000 || files.some(file => typeof file.content !== 'string')) {
          throw failure('reference_project_incomplete', 'The reference project could not be read completely.');
        }
        const skipped = snapshot.skipped || [];
        if (skipped.some(file => /\.tex$/i.test(typeof file === 'string' ? file : file?.path || ''))) {
          throw failure('reference_project_incomplete', 'Some TeX files in the reference project could not be read.');
        }
        const encoder = new TextEncoder();
        const size = files.reduce((sum, file) => sum + encoder.encode(file.content).byteLength, 0);
        if (size > MAX_PROJECT_BYTES) throw failure('reference_project_too_large', 'Reference project text exceeds 4 MiB. Add a representative PDF instead.');
        return {
          ok: true, projectId, capturedAt: new Date().toISOString(),
          files: files.map(file => ({ path: file.path, content: file.content, kind: 'text' })),
          capabilities: { referenceTextComplete: true, method: 'overleaf-reference-zip' }
        };
      } catch (error) {
        return { ok: false, code: error.code || 'reference_project_failed', error: error.message };
      } finally { reads.delete(requestId); }
    }

    function cancelRead(params = {}) {
      const requestId = String(params.requestId || '');
      const controller = reads.get(requestId);
      if (controller) controller.abort();
      return { ok: true, cancelled: Boolean(controller) };
    }

    return { listProjects, readProject, cancelRead };
  }
  return { create, parseCatalog };
});
