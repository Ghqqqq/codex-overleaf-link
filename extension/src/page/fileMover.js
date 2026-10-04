(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexOverleafFileMover = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function create(deps = {}) {
    const { window, document, treeOperations, snapshotRouter, textFileCreator } = deps;
    const normalizePath = deps.normalizeSafeProjectPath || window.CodexOverleafProjectFiles?.normalizeSafeProjectPath;
    const delay = deps.delay || (ms => new Promise(resolve => window.setTimeout(resolve, ms)));
    const error = (code, message) => Object.assign(new Error(message), { code });
    const parent = path => path.split('/').slice(0, -1).join('/');
    const basename = path => path.split('/').pop();
    const join = (folder, name) => [folder, name].filter(Boolean).join('/');
    function entities() {
      treeOperations.invalidateDomProjectPathCache?.();
      const root = document.querySelector('[data-testid="file-tree-list-root"], .file-tree-list[role="tree"]');
      const unique = new Map();
      for (const row of root?.querySelectorAll?.('[role="treeitem"]') || []) {
        const entity = row.querySelector?.(':scope > .entity[data-file-id]')
          || row.querySelector?.('[data-file-type][data-file-id]');
        const id = entity?.dataset?.fileId || entity?.getAttribute?.('data-file-id');
        const type = entity?.dataset?.fileType || entity?.getAttribute?.('data-file-type');
        const path = normalizePath?.(treeOperations.readProjectPathFromNode?.(row));
        if (id && path && ['doc', 'file', 'folder'].includes(type)) unique.set(type + ':' + id + ':' + path, { id, path, type });
      }
      return [...unique.values()];
    }
    function at(path, type) {
      const found = entities().filter(entry => entry.path === path && (!type || entry.type === type));
      return found.length === 1 ? found[0] : null;
    }
    function folderId(path, projectId) {
      if (path) return at(path, 'folder')?.id || '';
      for (const root of [window._ide, window.Overleaf, window.overleaf, window.OL]) {
        const project = root?.project;
        if ((project?._id || project?.id) !== projectId) continue;
        const folder = Array.isArray(project.rootFolder) ? project.rootFolder[0] : project.rootFolder;
        if (folder?._id || folder?.id) return folder._id || folder.id;
      }
      return '';
    }
    async function digest(file, kind) {
      let bytes;
      if (kind === 'text' && typeof file?.content === 'string') bytes = new TextEncoder().encode(file.content);
      else if (kind === 'binary' && typeof file?.contentBase64 === 'string') {
        bytes = Uint8Array.from((window.atob || globalThis.atob)(file.contentBase64), char => char.charCodeAt(0));
      } else throw error('file_move_source_unavailable', 'The source contents could not be verified.');
      const hash = await (window.crypto || globalThis.crypto).subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
    function csrfToken() {
      const meta = document.querySelector('meta[name="ol-csrfToken"], meta[name="csrf-token"], meta[name="_csrf"]');
      let value = meta ? meta.content : window.csrfToken || window._csrf;
      if (['json', 'number'].includes(meta?.dataset?.type)) {
        try { value = JSON.parse(value); } catch (_error) { return ''; }
      }
      if (meta?.dataset?.type === 'boolean') return '';
      return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\r\n]/.test(value) ? value : '';
    }

    // Compatibility consumer for identity-bound moves recorded by older builds.
    // New mirror diffs never produce metadata moves.
    async function moveFile(operation, options = {}) {
      const source = normalizePath?.(operation?.path), target = normalizePath?.(operation?.to);
      const proof = operation?.moveProof;
      const projectId = options.runProjectId;
      const entity = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\0\r\n]/.test(value);
      if (options.noTraceUndo !== true || !entity(proof?.sourceEntityId) || !entity(proof?.targetEntityId)
        || proof.sourceEntityId !== proof.targetEntityId) return { ok: false, code: 'file_tree_controls_unavailable', changedDocument: false,
        reason: 'A recorded same-entity move is required before its location can be restored.' };
      const deadline = Math.min(Date.now() + 90000, Number.isFinite(options.deadlineAt) ? options.deadlineAt : Infinity);
      const createdDirectories = [], completed = [];
      let entityId = '', entityType = '', attempted = false, currentPath = source;
      const assertCurrent = () => {
        if (!projectId || treeOperations.getProjectId() !== projectId) throw error('aborted_project_changed', 'The project changed during the file move.');
        if (options.isCurrent?.() === false) throw error('codex_cancelled', 'The file move was cancelled.');
        if (Date.now() >= deadline) throw error('file_move_deadline_exceeded', 'The file move verification deadline was reached.');
      };
      const inspectRemainingDirectories = async () => {
        if (!Array.isArray(proof.createdDirectories) || !proof.createdDirectories.length) return {};
        try {
          const directoryCleanup = await textFileCreator?.cleanupCreatedDirectories?.(proof.createdDirectories, {
            projectId, isCurrent: () => { assertCurrent(); return true; }
          });
          if (directoryCleanup) return { directoryCleanup };
        } catch (_error) { /* The verified file move remains complete; only its directory inspection is unresolved. */ }
        return { directoryCleanup: { ok: false, removed: [], remaining: proof.createdDirectories, requiresExplicitCleanup: true } };
      };
      const observedPath = () => {
        if (treeOperations.getProjectId() !== projectId) return '';
        const found = entities().filter(entry => entry.id === entityId && entry.type === entityType);
        return found.length === 1 ? found[0].path : '';
      };
      const snapshot = async () => {
        assertCurrent(); snapshotRouter.invalidateCache?.();
        const result = await snapshotRouter.fetchProjectZipSnapshot({ force: true, maxAgeMs: 0, serverOnly: true,
          includeContent: true, includeBinaryFiles: true, writebackVerification: true,
          zipTimeoutMs: Math.max(1, Math.min(30000, deadline - Date.now())) });
        assertCurrent();
        const skipped = [...(result?.skipped || []), ...(result?.capabilities?.skipped || [])];
        if (!result?.ok || !Array.isArray(result.files) || result.partialSnapshot === true
          || result.pathIdentityComplete === false || result.capabilities?.pathIdentityComplete === false
          || skipped.some(file => file?.unknownPath || ['zip_path_invalid', 'zip_path_duplicate'].includes(file?.reason))
          || result.capabilities?.fullProjectSnapshot === false || (result.id && result.id !== projectId)) {
          throw error('file_move_source_unavailable', 'A complete server source snapshot is required to move a file.');
        }
        return result;
      };
      const contains = (data, path) => data.files.some(file => file.path === path)
        || [...(data.skipped || []), ...(data.capabilities?.skipped || [])].some(file => file.path === path);
      const verify = async (path, data) => {
        assertCurrent();
        const entity = at(path);
        if (!entity || !['doc', 'file'].includes(entity.type) || (entityId && entity.id !== entityId)
          || (entityType && entity.type !== entityType) || (proof.entityType && entity.type !== proof.entityType)
          || (proof.sourceEntityId && entity.id !== proof.sourceEntityId)) {
          throw error('file_move_identity_changed', 'The exact source file identity changed or is unavailable.');
        }
        const file = data.files.find(file => file.path === path);
        if (await digest(file, proof.kind) !== proof.sha256.toLowerCase()) {
          throw error('stale_source_changed', 'The source file changed after Codex read it.');
        }
        assertCurrent();
        if (at(path)?.id !== entity.id || at(path)?.type !== entity.type) throw error('file_move_identity_changed', 'The source file identity changed while checking its contents.');
        return entity;
      };
      const checkStep = async step => {
        const data = await snapshot(); await verify(step.from, data);
        if (contains(data, step.to) || at(step.to)) throw error('file_move_target_exists', 'The destination or an intermediate move path is occupied.');
        if (step.action === 'move' && folderId(parent(step.to), projectId) !== step.folderId) {
          throw error('file_move_folder_changed', 'The destination folder identity changed.');
        }
        assertCurrent();
      };
      const confirmStep = async step => {
        for (let i = 0; i < 8; i++) {
          const data = await snapshot();
          if (!contains(data, step.from) && contains(data, step.to) && at(step.to)?.id === entityId) {
            await verify(step.to, data); currentPath = step.to; return true;
          }
          if (i < 7) await delay(Math.min(250 * (i + 1), 1000));
        }
        return false;
      };
      const send = async step => {
        await checkStep(step);
        const csrf = csrfToken();
        if (!csrf) throw error('file_move_identity_unavailable', 'The page request identity is unavailable. Reload Overleaf before moving files.');
        const Controller = window.AbortController || globalThis.AbortController;
        const controller = new Controller();
        const timer = window.setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
        let response, transportError;
        try {
          assertCurrent(); attempted = true;
          response = await window.fetch(`/project/${encodeURIComponent(projectId)}/${entityType}/${encodeURIComponent(entityId)}/${step.action}`, {
            method: 'POST', credentials: 'same-origin', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', 'X-Csrf-Token': csrf, Accept: 'application/json' },
            body: JSON.stringify(step.action === 'rename' ? { name: basename(step.to) } : { folder_id: step.folderId })
          });
        } catch (caught) { transportError = caught; }
        finally { window.clearTimeout(timer); }
        assertCurrent();
        if (await confirmStep(step)) return;
        if (response && !response.ok && response.status >= 400 && response.status < 500 && response.status !== 408) {
          const rejected = error('file_move_rejected', 'Overleaf rejected the file move.');
          rejected.definitive = true; throw rejected;
        }
        const unknown = error('file_move_unconfirmed', transportError
          ? 'The move response was lost. Check the file location before retrying.'
          : 'The move result could not be confirmed. Check the file location before retrying.');
        unknown.receiptUnconfirmed = true; throw unknown;
      };
      try {
        assertCurrent();
        if (!source || !target || source === target || operation.type !== 'move' || proof?.v !== 1
          || !['text', 'binary'].includes(proof.kind) || !/^[a-f0-9]{64}$/i.test(proof.sha256 || '')) {
          throw error('invalid_project_path', 'A verified source, different destination and content hash are required for a move.');
        }
        if (parent(source)) await textFileCreator?.prepareUploadParent?.(parent(source), { createMissing: false, isCurrent: () => { assertCurrent(); return true; } });
        let data = await snapshot();
        if (!contains(data, source) && proof.sourceEntityId && at(target)?.id === proof.sourceEntityId) {
          entityId = proof.sourceEntityId; entityType = at(target).type;
          await verify(target, data);
          return { ok: true, verified: true, verification: 'overleaf-zip', idempotent: true, changedDocument: false,
            method: 'overleaf.entity-move', moveProof: { ...proof, targetEntityId: entityId }, ...await inspectRemainingDirectories() };
        }
        const sourceEntity = await verify(source, data); entityId = sourceEntity.id; entityType = sourceEntity.type;
        if (contains(data, target) || at(target)) throw error('file_move_target_exists', 'The move destination already exists.');
        const originalParent = parent(source), destinationParent = parent(target);
        const originalFolderId = originalParent === destinationParent ? '' : folderId(originalParent, projectId);
        if (originalParent !== destinationParent && !originalFolderId) throw error('file_move_folder_changed', 'The original folder identity is unavailable.');
        if (destinationParent && originalParent !== destinationParent && !folderId(destinationParent, projectId)) {
          await textFileCreator?.prepareUploadParent?.(destinationParent, { createMissing: true, isCurrent: () => { assertCurrent(); return true; },
            onCreatedDirectory: proof => createdDirectories.push(proof) });
        }
        const destinationFolderId = originalParent === destinationParent ? '' : folderId(destinationParent, projectId);
        if (originalParent !== destinationParent && !destinationFolderId) throw error('file_move_folder_changed', 'The destination folder identity is unavailable.');
        data = await snapshot(); await verify(source, data);
        const steps = [];
        const rename = to => { steps.push({ action: 'rename', from: currentPath, to }); currentPath = to; };
        const move = to => { steps.push({ action: 'move', from: currentPath, to, folderId: destinationFolderId, fromFolderId: originalFolderId }); currentPath = to; };
        if (originalParent === destinationParent) rename(target);
        else if (basename(source) === basename(target)) move(target);
        else if (!contains(data, join(originalParent, basename(target))) && !at(join(originalParent, basename(target)))) {
          rename(join(originalParent, basename(target))); move(target);
        } else if (!contains(data, join(destinationParent, basename(source))) && !at(join(destinationParent, basename(source)))) {
          move(join(destinationParent, basename(source))); rename(target);
        } else {
          const token = window.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 16);
          if (!token) throw error('file_move_target_exists', 'An unoccupied intermediate name could not be reserved safely.');
          const extension = basename(source).match(/\.[^.]+$/)?.[0] || '';
          const temporary = 'codex-move-' + token + extension;
          if ([originalParent, destinationParent].some(folder => contains(data, join(folder, temporary)) || at(join(folder, temporary)))) {
            throw error('file_move_target_exists', 'The temporary move path is occupied. Retry on a fresh project snapshot.');
          }
          rename(join(originalParent, temporary)); move(join(destinationParent, temporary)); rename(target);
        }
        currentPath = source;
        for (const step of steps) { await send(step); completed.push(step); }
        return { ok: true, verified: true, verification: 'overleaf-zip', changedDocument: true, method: 'overleaf.entity-move',
          moveProof: { v: 1, kind: proof.kind, sha256: proof.sha256.toLowerCase(), sourceEntityId: entityId, targetEntityId: entityId, entityType },
          ...await inspectRemainingDirectories(),
          ...(createdDirectories.length ? { createdDirectories } : {}) };
      } catch (caught) {
        let rolledBack = false;
        // Only a definite refusal permits compensation. A lost response may
        // still be in flight; never replay or reverse that uncertain mutation.
        if (caught.definitive && completed.length && treeOperations.getProjectId() === projectId && options.isCurrent?.() !== false) {
          try {
            for (const prior of completed.slice().reverse()) {
              await send({ action: prior.action, from: prior.to, to: prior.from, folderId: prior.fromFolderId });
            }
            rolledBack = true;
          } catch (_rollbackError) { /* Preserve the verified entity and report its location for recovery. */ }
        }
        const observed = entityId ? observedPath() : '';
        const changedDocument = attempted || createdDirectories.length > 0;
        const reason = rolledBack ? 'The move was not completed; the original file location was restored.' : caught.message;
        const moveRecovery = attempted && !rolledBack ? { v: 1, projectId, kind: proof?.kind, sha256: proof?.sha256,
          entityId, entityType, sourcePath: source, targetPath: target, observedPath: observed } : null;
        return { ok: false, code: rolledBack ? 'file_move_rolled_back' : caught.code || 'file_move_failed', reason,
          changedDocument, rolledBack, receiptUnconfirmed: caught.receiptUnconfirmed === true,
          ...(createdDirectories.length ? { createdDirectories } : {}),
          ...(moveRecovery ? { moveRecovery } : {}),
          failure: { code: caught.code || 'file_move_failed', stage: attempted ? 'verify' : 'preflight',
            severity: changedDocument ? 'warning' : 'blocked', terminalState: changedDocument ? 'needs_review' : 'blocked',
            changedDocument, retryable: false, file: observed || source,
            ...(moveRecovery ? { evidence: { moveRecovery } } : {}),
            userMessage: reason, nextAction: changedDocument ? 'Check the file location before retrying.' : 'Read the project again before retrying.' } };
      }
    }
    return { moveFile };
  }
  return { create };
});
