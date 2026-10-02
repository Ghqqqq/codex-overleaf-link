(function initCodexOverleafBinaryAssetUploader(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafBinaryAssetUploader = api;
})(typeof window !== 'undefined' ? window : globalThis, function binaryAssetUploaderFactory() {
  'use strict';

  const MAX_ASSET_BYTES = 10 * 1024 * 1024;

  function create(deps = {}) {
    const windowRef = deps.window || globalThis.window;
    const documentRef = deps.document || windowRef?.document;
    const treeOperations = deps.treeOperations;
    const snapshotRouter = deps.snapshotRouter;
    const transfers = new Map();
    // Keep bounded receipts after payload release; status reads never re-upload.
    const receipts = new Map();
    function pruneReceipts() {
      for (const [id, transfer] of receipts) {
        if (transfer.finishedAt && Date.now() - transfer.finishedAt > 600000) receipts.delete(id);
      }
      while (receipts.size >= 32) {
        const entry = Array.from(receipts).find(([, value]) => value.finishedAt);
        if (!entry) break;
        receipts.delete(entry[0]);
      }
    }

    function begin(params = {}) {
      let transferId;
      let projectPath;
      try {
        transferId = cleanTransferId(params.transferId);
        projectPath = normalizePath(params.path);
      } catch (error) {
        return failure('binary_asset_path_invalid', error.message);
      }
      const size = Number(params.size);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ASSET_BYTES) {
        return failure('binary_asset_size_invalid', 'Asset size is invalid or exceeds 10 MiB.');
      }
      if (!/^[a-f0-9]{64}$/i.test(String(params.sha256 || ''))) {
        return failure('binary_asset_hash_invalid', 'Asset SHA-256 is missing or invalid.');
      }
      pruneReceipts();
      if (transfers.has(transferId) || receipts.has(transferId)) {
        return failure('binary_upload_transfer_conflict', 'Asset transfer ID is already in use.');
      }
      if (transfers.size >= 32 || receipts.size >= 32) {
        return failure('binary_upload_busy', 'Too many asset transfers are pending.');
      }
      transfers.set(transferId, {
        id: transferId,
        path: projectPath,
        size,
        sha256: String(params.sha256).toLowerCase(),
        mimeType: String(params.mimeType || 'application/octet-stream'),
        projectId: treeOperations.getProjectId(),
        overwrite: params.overwrite === true,
        chunks: [],
        received: 0
      });
      return { ok: true, transferId };
    }

    function append(params = {}) {
      const transfer = transfers.get(String(params.transferId || ''));
      if (!transfer) return failure('binary_upload_transfer_missing', 'Asset upload transfer was not found.');
      if (Number(params.offset) !== transfer.received) {
        return failure('binary_upload_chunk_order_invalid', 'Asset chunks arrived out of order.');
      }
      let bytes;
      try { bytes = decodeBase64(params.contentBase64, windowRef); } catch (_error) {
        return failure('binary_upload_chunk_invalid', 'Asset chunk is not valid Base64.');
      }
      if (transfer.received + bytes.length > transfer.size) {
        return failure('binary_upload_size_mismatch', 'Asset chunks exceed the declared size.');
      }
      transfer.chunks.push(bytes);
      transfer.received += bytes.length;
      return { ok: true, transferId: transfer.id, received: transfer.received };
    }

    function commit(params = {}) {
      const id = String(params.transferId || '');
      const existing = receipts.get(id);
      if (existing) {
        if (existing.projectId !== treeOperations.getProjectId()) {
          return Promise.resolve(failure('binary_upload_scope_changed', 'Asset project changed.'));
        }
        return existing.promise;
      }
      const transfer = transfers.get(id);
      if (!transfer) return Promise.resolve(failure('binary_upload_transfer_missing', 'Asset upload transfer was not found.'));
      receipts.set(id, transfer);
      transfer.promise = commitOnce(params).catch(error => ({
        ...failure(error.code || 'binary_upload_failed', error.message),
        changedDocument: transfer.mutationAttempted === true
      })).then(result => {
        transfer.result = result;
        transfer.finishedAt = Date.now();
        transfer.chunks = [];
        return result;
      });
      return transfer.promise;
    }

    async function status(params = {}) {
      pruneReceipts();
      const transfer = receipts.get(String(params.transferId || ''));
      if (!transfer || !params.runProjectId || transfer.projectId !== params.runProjectId
        || treeOperations.getProjectId() !== transfer.projectId) {
        return failure('binary_upload_receipt_missing', 'Asset upload receipt is unavailable for this project.');
      }
      if (transfer.result?.ok !== true && transfer.mutationAttempted === true) {
        const evidence = await waitForPath(transfer, {}, 2500).catch(() => null);
        if (evidence?.hashVerified === true) {
          transfer.result = { ok: true, written: true, path: transfer.path,
            changedDocument: true, method: 'remote-hash-reconciliation' };
        }
      }
      return { ok: true, transferId: transfer.id, runProjectId: transfer.projectId,
        state: transfer.finishedAt || transfer.result?.ok === true ? 'completed' : 'running',
        result: transfer.result || null, changedDocument: transfer.mutationAttempted === true };
    }

    async function commitOnce(params = {}) {
      const transferId = String(params.transferId || '');
      const transfer = transfers.get(transferId);
      if (!transfer) return failure('binary_upload_transfer_missing', 'Asset upload transfer was not found.');
      try {
        assertTransferProject(transfer);
        if (transfer.received !== transfer.size) return failure('binary_upload_incomplete', 'Asset upload is incomplete.');
        const bytes = joinChunks(transfer.chunks, transfer.size);
        const digest = await sha256Hex(bytes, windowRef.crypto);
        if (digest !== transfer.sha256) {
          return failure('binary_upload_checksum_mismatch', 'Asset checksum did not match the Native Host descriptor.');
        }
        const fileName = transfer.path.split('/').pop();
        const file = new windowRef.File([bytes], fileName, { type: transfer.mimeType });
        const attempts = [
          // Prefer Overleaf's visible uploader. Its UI contract is more
          // stable than the private multipart endpoint across deployments.
          () => uploadWithDom(file, transfer),
          () => uploadWithMultipart(file, transfer),
          () => uploadWithLegacyManager(file, transfer)
        ];
        const errors = [];
        for (const attempt of attempts) {
          try {
            assertTransferProject(transfer);
            const result = await attempt();
            const evidence = result?.ok ? await waitForPath(transfer, result, 12000) : null;
            const observed = evidence?.observed;
            const hashVerified = evidence?.hashVerified === true;
            assertTransferProject(transfer);
            const overwriteVerified = hashVerified || result?.confirmedByTransport === true;
            if (result?.ok && observed && overwriteVerified) {
              return { ok: true, written: true, path: transfer.path, method: result.method, changedDocument: true };
            }
            if (result?.ok && observed && !overwriteVerified) errors.push('Overleaf did not expose enough evidence to verify the binary replacement.');
            if (result?.reason) errors.push(result.reason);
          } catch (error) {
            errors.push(error.message);
          }
          // Once submission may have happened, changing transports can duplicate
          // or overwrite a successful upload. Reconcile the same attempt instead.
          if (transfer.mutationAttempted === true) {
            const evidence = await waitForPath(transfer, {}, 12000).catch(() => null);
            if (evidence?.hashVerified === true) {
              return { ok: true, written: true, path: transfer.path,
                method: 'remote-hash-reconciliation', changedDocument: true };
            }
            break;
          }
        }
        return { ...failure('binary_upload_unavailable', errors.filter(Boolean).join('; ') || 'No supported Overleaf asset upload path succeeded.'),
          changedDocument: transfer.mutationAttempted === true };
      } finally {
        transfers.delete(transferId);
      }
    }

    function abort(params = {}) {
      const id = String(params.transferId || '');
      if (receipts.has(id)) return { ok: true, aborted: false, committed: true };
      return { ok: true, aborted: transfers.delete(id) };
    }

    function assertTransferProject(transfer) {
      if (transfers.get(transfer.id) !== transfer && receipts.get(transfer.id) !== transfer) throw new Error('Asset upload was cancelled or replaced.');
      if (!transfer.projectId || treeOperations.getProjectId() !== transfer.projectId) {
        throw new Error('Project changed during asset upload.');
      }
    }

    async function uploadWithMultipart(file, transfer) {
      const projectId = treeOperations.getProjectId();
      if (!projectId || typeof windowRef.fetch !== 'function') return { ok: false, reason: 'Project upload endpoint is unavailable.' };
      const parentPath = transfer.path.split('/').slice(0, -1).join('/');
      const folderId = await findFolderId(parentPath);
      if (parentPath && !folderId) return { ok: false, reason: 'Target folder id is unavailable for direct upload.' };
      const form = new windowRef.FormData();
      form.append('qqfile', file, file.name);
      form.append('name', file.name);
      if (folderId) form.append('folder_id', folderId);
      const csrf = findCsrfToken();
      const headers = csrf ? { 'X-CSRF-Token': csrf } : {};
      const query = folderId ? `?folder_id=${encodeURIComponent(folderId)}` : '';
      assertTransferProject(transfer);
      transfer.mutationAttempted = true;
      const response = await windowRef.fetch(`/project/${encodeURIComponent(projectId)}/upload${query}`, {
        method: 'POST', body: form, credentials: 'same-origin', headers
      });
      const responseText = await response.text();
      if (!response.ok) throw new Error(formatUploadHttpError(response.status, responseText));
      try {
        const payload = responseText ? JSON.parse(responseText) : null;
        if (payload && (payload.success === false || payload.ok === false || payload.error)) {
          throw new Error(payload.error?.message || payload.error || payload.message || 'Overleaf rejected the asset upload.');
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          // Some Overleaf deployments return an empty or HTML success body.
        } else {
          throw error;
        }
      }
      return { ok: true, method: 'overleaf.multipart', confirmedByTransport: true };
    }

    async function uploadWithDom(file, transfer) {
      const parentPath = transfer.path.split('/').slice(0, -1).join('/');
      if (typeof deps.prepareUploadParent !== 'function') {
        return { ok: false, reason: 'Verified folder selection is unavailable for asset upload.' };
      }
      await deps.prepareUploadParent(parentPath, {
        createMissing: true,
        onMutation: () => { transfer.mutationAttempted = true; },
        isCurrent: () => treeOperations.getProjectId() === transfer.projectId && transfers.get(transfer.id) === transfer
      });
      assertTransferProject(transfer);
      let input = findFileInput();
      if (!input) {
        const button = findUploadButton();
        if (!button) return { ok: false, reason: 'Overleaf upload button was not found.' };
        button.click();
        input = await waitForFileInput(4000);
      }
      if (!input) return { ok: false, reason: 'Overleaf upload file input was not found.' };
      const data = new windowRef.DataTransfer();
      data.items.add(file);
      assertTransferProject(transfer);
      assignFilesToInput(input, data.files, windowRef);
      transfer.mutationAttempted = true;
      input.dispatchEvent(new windowRef.Event('input', { bubbles: true }));
      input.dispatchEvent(new windowRef.Event('change', { bubbles: true }));
      await clickReplaceIfShown(transfer);
      return { ok: true, method: 'overleaf.file-input' };
    }

    async function uploadWithLegacyManager(file, transfer) {
      const manager = treeOperations.findFileTreeManager();
      if (!manager) return { ok: false, reason: 'Legacy file-tree manager is unavailable.' };
      for (const name of ['uploadFile', 'uploadAsset', 'createBinaryFile', 'createFile', 'addFile']) {
        if (typeof manager[name] !== 'function') continue;
        try {
          transfer.mutationAttempted = true;
          await manager[name](transfer.path, file);
          return { ok: true, method: `fileTreeManager.${name}`, confirmedByTransport: true };
        } catch (error) { return { ok: false, reason: error.message }; }
      }
      return { ok: false, reason: 'Legacy file-tree manager has no compatible asset method.' };
    }

    async function findFolderId(parentPath) {
      const node = parentPath ? (deps.findFolderNode?.(parentPath)
        || findNativeTreeNode(parentPath, 'folder') || treeOperations.findFileTreeNode(parentPath)) : null;
      const domId = readTreeEntityId(node);
      if (domId) return domId;
      for (const root of [windowRef._ide, windowRef.Overleaf, windowRef.overleaf, windowRef.OL]) {
        const folder = root?.project?.rootFolder?.[0] || root?.project?.rootFolder || root?.rootFolder?.[0] || root?.rootFolder;
        if (!parentPath && (folder?._id || folder?.id)) return folder._id || folder.id;
      }
      try {
        const list = await snapshotRouter?.buildProjectFileList({
          force: true, maxAgeMs: 0, preferLightweight: true, allowZipFallback: false
        });
        const folder = (list?.files || []).find(item => item.path === parentPath && /folder/i.test(item.kind || item.type || ''));
        if (folder) return folder.id || folder._id || folder.entityId || '';
      } catch (_error) { /* DOM and legacy adapters remain available */ }
      return '';
    }

    function findCsrfToken() {
      return documentRef.querySelector('meta[name="ol-csrfToken"], meta[name="csrf-token"], meta[name="_csrf"]')?.content
        || windowRef.csrfToken || windowRef._csrf || '';
    }
    function findFileInput() {
      return chooseOverleafFileInput(Array.from(documentRef.querySelectorAll('input[type="file"]')));
    }
    function findUploadButton() {
      return chooseOverleafUploadButton(Array.from(documentRef.querySelectorAll('button, [role="button"]')));
    }
    function chooseOverleafUploadButton(nodes) {
      return nodes.filter(node => {
        if (!node || node.disabled || isCodexOwnedNode(node)) return false;
        const label = `${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''} ${node.textContent || ''}`;
        return /upload|上传/i.test(label);
      }).sort((left, right) => uploadButtonScore(right) - uploadButtonScore(left))[0] || null;
    }
    async function waitForFileInput(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const input = findFileInput();
        if (input) return input;
        await delay(50);
      }
      return null;
    }
    async function clickReplaceIfShown(transfer) {
      await delay(180);
      assertTransferProject(transfer);
      if (!transfer.overwrite) return;
      const button = Array.from(documentRef.querySelectorAll('[role="dialog"] button')).find(node => !isCodexOwnedNode(node)
        && /replace|overwrite|替换|覆盖/i.test(node.textContent || ''));
      if (button) button.click();
    }
    function readTreeEntityId(node) {
      const owner = node?.closest?.('[data-entity-id], [data-file-id], [data-folder-id], [data-id]');
      const row = node?.closest?.('[role="treeitem"]') || node;
      const entity = row?.querySelector?.(':scope > .entity[data-file-id]');
      for (const candidate of [node, entity, owner]) {
        const id = candidate?.dataset?.entityId || candidate?.dataset?.fileId
          || candidate?.dataset?.folderId || candidate?.dataset?.id;
        if (id) return id;
      }
      return '';
    }
    function findNativeTreeNode(projectPath, type) {
      const root = documentRef.querySelector?.('[data-testid="file-tree-list-root"]');
      for (const row of root?.querySelectorAll?.('[role="treeitem"]') || []) {
        const entity = row.querySelector?.(':scope > .entity[data-file-id]');
        if (entity?.dataset?.fileType === type && readNativeTreePath(row, root) === projectPath) return row;
      }
      return null;
    }
    function readNativeTreePath(row, root) {
      const parts = [row.getAttribute('aria-label')];
      let group = row.closest('[role="tree"]');
      const seen = new Set();
      while (group && group !== root) {
        if (seen.has(group) || seen.size >= 64) return '';
        seen.add(group);
        const folder = group.previousElementSibling;
        const entity = folder?.querySelector?.(':scope > .entity[data-file-id]');
        if (folder?.getAttribute?.('role') !== 'treeitem' || entity?.dataset?.fileType !== 'folder') return '';
        parts.unshift(folder.getAttribute('aria-label'));
        group = group.parentElement?.closest?.('[role="tree"]');
      }
      if (group !== root || parts.some(part => !part || /[/\\]/.test(part))) return '';
      return parts.join('/');
    }
    async function waitForPath(transfer, result, timeoutMs) {
      const projectPath = transfer.path;
      const deadline = Date.now() + timeoutMs;
      let lastObserved = null;
      while (Date.now() < deadline) {
        assertTransferProject(transfer);
        // A matching digest identifies bytes, not their project path. In the
        // native tree, require the exact ancestry; the generic tree adapter
        // can resolve a root name to an identically named nested file.
        const nativeRoot = documentRef.querySelector?.('[data-testid="file-tree-list-root"]');
        const node = nativeRoot ? findNativeTreeNode(projectPath, 'file')
          : treeOperations.findFileTreeNode(projectPath, { invalidateCache: true });
        let observed = node || (!nativeRoot && treeOperations.projectPathExists(projectPath))
          ? { path: projectPath, id: readTreeEntityId(node) } : null;
        if (!observed?.id) {
          try {
            const list = await snapshotRouter?.buildProjectFileList({
              force: true, maxAgeMs: 0, preferLightweight: true, allowZipFallback: false
            });
            const file = (list?.files || []).find(item => item.path === projectPath);
            if (file) observed = file;
          } catch (_error) { /* continue until the deadline */ }
        }
        assertTransferProject(transfer);
        if (observed) {
          lastObserved = observed;
          const hashVerified = await verifyRemoteHash(observed, transfer).catch(() => false);
          assertTransferProject(transfer);
          // An existing path is not replacement evidence. Re-read identity and
          // bytes while the native uploader and file-tree events settle.
          if (hashVerified || result.confirmedByTransport === true) {
            return { observed, hashVerified };
          }
        }
        await delay(250);
      }
      return { observed: lastObserved, hashVerified: false };
    }
    async function verifyRemoteHash(observed, transfer) {
      const fileId = observed?.id || observed?._id || observed?.entityId || observed?.fileId || '';
      const projectId = treeOperations.getProjectId();
      if (!fileId || !projectId || typeof windowRef.fetch !== 'function') return false;
      const response = await windowRef.fetch(`/project/${encodeURIComponent(projectId)}/file/${encodeURIComponent(fileId)}`, {
        credentials: 'same-origin', cache: 'no-store'
      });
      if (!response.ok) return false;
      const digest = await sha256Hex(new Uint8Array(await response.arrayBuffer()), windowRef.crypto);
      return digest === transfer.sha256;
    }
    function delay(ms) { return new Promise(resolve => windowRef.setTimeout(resolve, ms)); }
    return { abort, append, begin, commit, status };
  }

  function normalizePath(value) {
    const path = String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!path || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Asset path is invalid.');
    return path;
  }
  function cleanTransferId(value) {
    const id = String(value || '');
    if (!/^[a-zA-Z0-9_-]{8,120}$/.test(id)) throw new Error('Asset transfer id is invalid.');
    return id;
  }
  function chooseOverleafFileInput(inputs) {
    return Array.from(inputs || [])
      .filter(input => input && !input.disabled && !isCodexOwnedNode(input))
      .sort((left, right) => uploadInputScore(right) - uploadInputScore(left))[0] || null;
  }
  function isCodexOwnedNode(node) {
    return Boolean(node?.closest?.('#codex-overleaf-panel, [data-codex-overleaf-root], .codex-overleaf-panel'));
  }
  function uploadInputScore(input) {
    let score = 0;
    if (input?.closest?.('.uppy-Dashboard, [data-uppy-drag-drop-supported]')) score += 100;
    if (input?.closest?.('[role="dialog"], .modal')) score += 40;
    if (/uppy|upload/i.test(`${input?.className || ''} ${input?.getAttribute?.('data-testid') || ''}`)) score += 30;
    if (input?.multiple) score += 10;
    if (input?.isConnected !== false) score += 1;
    return score;
  }
  function uploadButtonScore(node) {
    let score = 0;
    const label = `${node?.getAttribute?.('aria-label') || ''} ${node?.getAttribute?.('title') || ''} ${node?.textContent || ''}`.trim();
    if (/^(upload|上传)$/i.test(label)) score += 50;
    if (node?.closest?.('[data-testid*="file-tree"], .file-tree, .ide-react-file-tree')) score += 30;
    if (node?.isConnected !== false) score += 1;
    return score;
  }
  function assignFilesToInput(input, files, windowRef) {
    const prototype = windowRef?.HTMLInputElement?.prototype;
    const setter = prototype && Object.getOwnPropertyDescriptor(prototype, 'files')?.set;
    if (setter) {
      setter.call(input, files);
      return;
    }
    Object.defineProperty(input, 'files', { configurable: true, value: files });
  }
  function formatUploadHttpError(status, responseText) {
    const detail = summarizeUploadResponse(responseText);
    return `Overleaf upload endpoint returned HTTP ${status}${detail ? ` (${detail})` : ''}.`;
  }
  function summarizeUploadResponse(value) {
    const text = String(value || '').trim();
    if (!text || /^\s*</.test(text)) return '';
    let message = text;
    try {
      const payload = JSON.parse(text);
      message = payload?.error?.message || payload?.error || payload?.message || text;
    } catch (_error) { /* use the bounded plain-text response */ }
    return String(message || '').replace(/\s+/g, ' ').slice(0, 240);
  }
  function decodeBase64(value, windowRef) {
    const binary = windowRef.atob(String(value || ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  function joinChunks(chunks, size) {
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return output;
  }
  async function sha256Hex(bytes, cryptoImpl) {
    const digest = await cryptoImpl.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function failure(code, reason) { return { ok: false, code, reason, changedDocument: false }; }
  return { assignFilesToInput, chooseOverleafFileInput, create, formatUploadHttpError, joinChunks, normalizePath };
});
