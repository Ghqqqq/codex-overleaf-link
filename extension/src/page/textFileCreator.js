(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexOverleafTextFileCreator = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const MAX_CONFIRMATION_OBSERVATIONS = 8;

  function create(deps = {}) {
    const { window, document, treeOperations, uploadHelpers, snapshotRouter } = deps;
    const { getProjectId, findFileTreeNode, projectPathExists, collectProjectTextPaths,
      invalidateDomProjectPathCache } = treeOperations;
    const normalizeSafeProjectPath = value => {
      const path = String(value || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '').trim();
      return path && !path.split('/').some(part => !part || part === '.' || part === '..') ? path : '';
    };
    const normalizeDomText = value => String(value || '').replace(/\s+/g, ' ').trim();
    const delay = ms => new Promise(resolve => window.setTimeout(resolve, ms));
    const now = typeof deps.now === 'function' ? deps.now : Date.now;
    const verificationReads = new Set();
    const verificationBudget = () => ({ remainingMs: 90000 });
    async function pauseVerification(budget, durationMs) {
      const started = now();
      await delay(Math.max(0, Math.min(durationMs, budget.remainingMs)));
      budget.remainingMs = Math.max(0, budget.remainingMs - Math.max(0, now() - started));
    }
    function assertVerificationOwner(projectId, isCurrent) {
      if (!projectId || getProjectId() !== projectId) {
        throw Object.assign(new Error('The project changed during writeback.'), { code: 'aborted_project_changed' });
      }
      if (isCurrent?.() === false) {
        throw Object.assign(new Error('Writeback was cancelled.'), { code: 'codex_cancelled' });
      }
    }
    async function readServerSnapshot({ projectId, isCurrent, budget = verificationBudget() }) {
      const started = now(), deadline = started + Math.max(0, budget.remainingMs);
      let last;
      try {
        for (let attempt = 0; attempt < 3 && now() < deadline; attempt++) {
          assertVerificationOwner(projectId, isCurrent);
          const Controller = window.AbortController || globalThis.AbortController;
          const controller = typeof Controller === 'function' ? new Controller() : null;
          if (controller) verificationReads.add(controller);
          let result;
          try {
            result = await snapshotRouter.fetchProjectZipSnapshot({ force: true, maxAgeMs: 0,
              serverOnly: true, writebackVerification: true, includeBinaryFiles: false, includeContent: true,
              signal: controller?.signal, saveCheckId: String(now()) + '-' + attempt,
              zipTimeoutMs: Math.min(30000, Math.max(1, deadline - now())) });
          } catch (error) {
            if (['codex_cancelled', 'aborted_project_changed'].includes(error?.code)) throw error;
            result = { ok: false, reason: error?.message || String(error) };
          } finally { if (controller) verificationReads.delete(controller); }
          assertVerificationOwner(projectId, isCurrent);
          if (result?.ok === true && Array.isArray(result.files)) return result;
          last = Object.assign(new Error('The server project snapshot could not be read.'), {
            code: 'source_zip_unavailable', diagnostics: result?.diagnostics || null,
            technicalMessage: result?.reason || 'No complete server snapshot was returned.'
          });
          const attempts = result?.diagnostics?.attempts || [];
          if (attempts.length && attempts.every(item => [401, 403].includes(item.status))) break;
          if (attempt < 2 && now() < deadline) await delay(Math.min(1000 * (2 ** attempt), deadline - now()));
        }
        throw last || Object.assign(new Error('The project verification budget was exhausted.'), { code: 'source_zip_unavailable' });
      } finally { budget.remainingMs = Math.max(0, budget.remainingMs - Math.max(0, now() - started)); }
    }
    function verificationFailure(error, changedDocument, phase) {
      const interrupted = ['codex_cancelled', 'aborted_project_changed'].includes(error?.code);
      const code = interrupted ? error.code : changedDocument ? 'file_upload_unconfirmed' : 'source_zip_unavailable';
      const reason = interrupted ? error.message : changedDocument
        ? 'The file was submitted, but its saved content could not be confirmed.'
        : 'The project could not be checked before uploading this file.';
      return { ok: false, code, reason, changedDocument, diagnostics: {
        verificationPhase: phase, ...(error?.diagnostics || {}), reason: error?.technicalMessage || error?.message || ''
      }, failure: { code, stage: changedDocument ? 'verify' : 'preflight', severity: changedDocument ? 'warning' : 'blocked',
        retryable: !interrupted, terminalState: interrupted ? 'cancelled' : changedDocument ? 'needs_review' : 'blocked',
        changedDocument, userMessage: reason, nextAction: interrupted ? '' : 'Retry sync to check the file and upload only if it is missing.',
        technicalMessage: error?.technicalMessage || error?.message || '' } };
    }
    async function makeSaveReceipt(projectId, path, content) {
      const cryptoApi = window.crypto || globalThis.crypto;
      if (!cryptoApi?.subtle || typeof TextEncoder !== 'function') return undefined;
      const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(content));
      return { v: 1, source: 'overleaf-zip', projectId, path,
        sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
        verifiedAt: new Date().toISOString() };
    }
    async function beginCreateBatch(operations, options = {}) {
      const projectId = getProjectId(), budget = verificationBudget();
      const batch = { projectId, budget, targets: new Set(operations.map(op => op.path)),
        before: new Map(), pending: new Map(), blocked: new Set(), isCurrent: options.isCurrent, error: null };
      try {
        const snapshot = await readServerSnapshot({ projectId, budget, isCurrent: options.isCurrent });
        batch.before = new Map(snapshot.files.map(file => [file.path, file]));
      } catch (error) { batch.error = error; }
      return batch;
    }
    async function finishCreateBatch(batch, entries, appliedEntries = []) {
      let observed = new Map(), lastError = batch.error;
      try {
        for (let attempt = 0; entries.length && attempt < 3 && batch.budget.remainingMs > 0; attempt++) {
          const snapshot = await readServerSnapshot(batch);
          observed = new Map(snapshot.files.map(file => [file.path, file]));
          if (entries.every(entry => observed.get(entry.operation.path)?.content === entry.operation.content)) break;
          if (attempt < 2) await pauseVerification(batch.budget, 500 * (2 ** attempt));
        }
        assertVerificationOwner(batch.projectId, batch.isCurrent);
      } catch (error) { lastError = error; }
      const results = [];
      for (const entry of entries) {
        const operation = entry.operation;
        if (!lastError && observed.get(operation.path)?.content === operation.content) {
          results.push({ operation, result: { ok: true, verified: true, changedDocument: true,
            method: 'overleaf.native-text-upload', verification: 'overleaf-zip',
            saveReceipt: await makeSaveReceipt(batch.projectId, operation.path, operation.content) } });
        } else {
          results.push({ operation, result: verificationFailure(lastError || new Error(
            observed.has(operation.path) ? 'Server content differs from the submitted file.' : 'The file is not yet present in the server snapshot.'
          ), true, 'post-upload') });
        }
      }
      // The final fresh snapshot can also prove unrelated edits in this batch.
      if (!lastError) for (const entry of appliedEntries) {
        const content = entry.result?.verifiedContent ?? (entry.operation?.type === 'create' ? entry.operation.content : undefined);
        if (typeof content === 'string' && observed.get(entry.operation.path)?.content === content) {
          entry.result.saveReceipt = await makeSaveReceipt(batch.projectId, entry.operation.path, content);
        }
      }
      return results;
    }
    const controlName = node => {
      const labelledBy = (node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
        .map(id => document.getElementById?.(id)?.textContent || '').join(' ');
      const explicit = normalizeDomText(labelledBy || node.getAttribute('aria-label'));
      if (explicit) return explicit;
      // Material Symbols are text nodes too: raw textContent produces
      // "note_addNew file". Keep visually-hidden labels but exclude icons
      // deliberately removed from the accessibility tree.
      const copy = node.cloneNode?.(true);
      copy?.querySelectorAll('[aria-hidden="true"], [hidden], svg').forEach(child => child.remove());
      return normalizeDomText((copy ? copy.textContent : node.textContent) || node.getAttribute('title'));
    };
    const findFolder = folderPath => {
      let group = document.querySelector('[data-testid="file-tree-list-root"], .file-tree-list[role="tree"]');
      if (!group?.children) return findFileTreeNode(folderPath, { invalidateCache: true });
      let folder = null;
      for (const part of folderPath.split('/')) {
        if (!group) return null;
        const inner = Array.from(group.children).find(node => node.classList?.contains('file-tree-folder-list-inner')) || group;
        const matches = Array.from(inner.children).filter(node => node.getAttribute('role') === 'treeitem'
          && node.querySelector('[data-file-type="folder"]')
          && normalizeDomText(node.getAttribute('aria-label')) === part);
        if (matches.length !== 1) return null;
        folder = matches[0];
        // Current Overleaf renders the child list beside its folder row.
        // Older layouts put it inside the row. Neither path uses text-file
        // extension heuristics to identify a folder.
        const sibling = folder.nextElementSibling;
        group = sibling?.getAttribute('role') === 'tree' ? sibling : folder.querySelector('[role="tree"]');
      }
      return folder;
    };

    async function createFolderWithDom(entryPath, options = {}) {
      const target = normalizeSafeProjectPath(entryPath);
      const projectId = getProjectId();
      const assertCurrent = () => {
        if (!target) throw Object.assign(new Error('A valid folder path is required.'), { code: 'invalid_project_path' });
        assertVerificationOwner(projectId, options.isCurrent);
      };
      const visible = node => Boolean(node && !node.disabled && node.getClientRects?.().length);
      const dialogs = () => Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible);
      const waitFor = async read => {
        const deadline = Date.now() + 5000;
        do {
          assertCurrent();
          invalidateDomProjectPathCache();
          const value = read();
          if (value) return value;
          await delay(100);
        } while (Date.now() < deadline);
        throw new Error('Overleaf did not confirm folder creation before timeout.');
      };
      const choose = (scope, pattern) => {
        const matches = Array.from(scope.querySelectorAll('button')).filter(node => visible(node) && pattern.test(controlName(node)));
        if (matches.length !== 1) throw new Error('A unique Overleaf folder control could not be identified.');
        return matches[0];
      };
      const parts = target.split('/');
      const name = parts.pop();
      const parentPath = parts.join('/');
      const expandParent = async () => {
        if (!parentPath) return;
        const parent = findFolder(parentPath);
        if (!parent) throw new Error('The target parent folder is unavailable.');
        if (parent.getAttribute?.('aria-expanded') !== 'false') return;
        assertCurrent();
        const toggle = parent.querySelector('.folder-expand-collapse-button') || parent.querySelector('.file-tree-entity-button');
        if (!toggle) throw new Error('The target folder cannot be expanded safely.');
        toggle.click();
        await waitFor(() => findFolder(parentPath)?.getAttribute('aria-expanded') === 'true');
      };
      let ownedDialog = null;
      try {
        assertCurrent();
        if (findFolder(target)) return;
        if (projectPathExists(target)) throw new Error('The target path already exists as a file.');
        if (dialogs().length) throw new Error('An existing Overleaf dialog must be closed before creating folders.');
        const anchorPath = collectProjectTextPaths('').find(path => !path.includes('/'));
        const anchor = parentPath ? findFolder(parentPath) : anchorPath && findFileTreeNode(anchorPath, { invalidateCache: true });
        if (!anchor) throw new Error('The target parent folder could not be selected safely.');
        if (!parentPath || anchor.getAttribute?.('aria-selected') !== 'true') {
          (anchor.matches?.('button') ? anchor : anchor.querySelector?.('.file-tree-entity-button') || anchor).click();
        }
        await delay(100);
        assertCurrent();
        await expandParent();
        const tree = document.querySelector('#ide-rail-tabs-tabpane-file-tree, #ide-redesign-file-tree, .ide-redesign-file-tree, .file-tree');
        if (!tree) throw new Error('The Overleaf file-tree toolbar is unavailable.');
        choose(tree, /^(?:New folder|新建文件夹)$/i).click();
        ownedDialog = await waitFor(() => dialogs().length === 1 && dialogs()[0]);
        const inputs = Array.from(ownedDialog.querySelectorAll('input[type="text"], input:not([type])')).filter(visible);
        if (inputs.length !== 1) throw new Error('The Overleaf name field could not be identified safely.');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (!setter) throw new Error('The Overleaf name field cannot be edited.');
        setter.call(inputs[0], name);
        inputs[0].dispatchEvent(new window.Event('input', { bubbles: true }));
        inputs[0].dispatchEvent(new window.Event('change', { bubbles: true }));
        await delay(0);
        assertCurrent();
        if (findFolder(target) || projectPathExists(target)) throw new Error('The target path appeared during creation; no replacement was attempted.');
        options.onMutation?.();
        choose(ownedDialog, /^(?:Create|创建)$/i).click();
        await waitFor(() => !dialogs().length);
        await expandParent();
        await waitFor(() => findFolder(target));
      } finally {
        if (ownedDialog && getProjectId() === projectId && dialogs().includes(ownedDialog)) {
          const cancel = Array.from(ownedDialog.querySelectorAll('button')).filter(node => visible(node) && /^(?:Cancel|取消)$/i.test(controlName(node)));
          if (cancel.length === 1) cancel[0].click();
        }
      }
    }

    // Upload a complete text file through Overleaf, then verify server ZIP
    // bytes. Never write into whichever editor happens to be active.
    async function createTextFileWithDom(operation, options = {}) {
      const filePath = operation.path;
      const target = normalizeSafeProjectPath(filePath);
      const projectId = getProjectId();
      if (!target || !projectId || typeof operation.content !== 'string' || !window.CodexOverleafProjectFiles?.isTextProjectPath(target)) {
        return { ok: false, code: 'invalid_project_path', reason: 'A valid text-file path and project are required.' };
      }
      let mutationAttempted = false;
      let verificationPhase = 'preflight', zipReadCount = 0, lastZipFailure = null;
      const readBudget = options.batch?.budget || verificationBudget();
      let uploadDialog = null;
      const assertCurrent = () => assertVerificationOwner(projectId, options.isCurrent);
      const visible = node => Boolean(node && !node.disabled && node.getClientRects?.().length);
      const dialogs = () => Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible);
      const waitFor = async (read, timeoutMs = 5000) => {
        const until = Date.now() + timeoutMs;
        do {
          assertCurrent();
          invalidateDomProjectPathCache();
          const value = read();
          if (value) return value;
          await delay(100);
        } while (Date.now() < until);
        throw new Error('Overleaf did not confirm the requested file-tree change before timeout.');
      };
      const chooseButton = (scope, pattern) => {
        const matches = Array.from(scope.querySelectorAll('button')).filter(node => visible(node)
          && pattern.test(controlName(node)));
        if (matches.length !== 1) throw new Error('A unique Overleaf file-tree control could not be identified.');
        return matches[0];
      };
      const ensureFolderExpanded = async folderPath => {
        const node = findFolder(folderPath);
        if (!node) throw new Error('The target parent folder is unavailable.');
        if (node.getAttribute?.('aria-expanded') !== 'false') return;
        assertCurrent();
        const toggle = node.querySelector('.folder-expand-collapse-button') || node.querySelector('.file-tree-entity-button');
        if (!toggle) throw new Error('The target folder cannot be expanded safely.');
        toggle.click();
        await waitFor(() => findFolder(folderPath)?.getAttribute('aria-expanded') === 'true');
      };
      const readServerFiles = async () => {
        zipReadCount += 1;
        try {
          const result = await readServerSnapshot({ projectId, budget: readBudget,
            isCurrent: () => { assertCurrent(); return true; } });
          return result.files;
        } catch (error) { lastZipFailure = { reason: error.message, diagnostics: error.diagnostics }; throw error; }
      };
      const uploadText = async () => {
        const parentPath = target.split('/').slice(0, -1).join('/');
        const anchorPath = collectProjectTextPaths('').find(path => !path.includes('/'));
        const anchor = parentPath ? findFolder(parentPath) : anchorPath && findFileTreeNode(anchorPath, { invalidateCache: true });
        if (!anchor || dialogs().length) throw new Error('The upload parent cannot be selected safely.');
        assertCurrent();
        if (!parentPath || anchor.getAttribute?.('aria-selected') !== 'true') {
          (anchor.matches?.('button') ? anchor : anchor.querySelector?.('.file-tree-entity-button') || anchor).click();
        }
        await delay(100);
        if (parentPath) await ensureFolderExpanded(parentPath);
        assertCurrent();
        const tree = document.querySelector('#ide-rail-tabs-tabpane-file-tree, #ide-redesign-file-tree, .ide-redesign-file-tree, .file-tree');
        chooseButton(tree, /^(?:Upload|上传)$/i).click();
        const dialog = await waitFor(() => dialogs().length === 1 && dialogs()[0]);
        uploadDialog = dialog;
        const input = await waitFor(() => uploadHelpers.chooseOverleafFileInput(dialog.querySelectorAll('input[type="file"]')));
        if (projectPathExists(target)) throw new Error('The target appeared before upload; no replacement was attempted.');
        const file = new window.File([operation.content], target.split('/').pop(), { type: 'text/plain' });
        const data = new window.DataTransfer();
        data.items.add(file);
        assertCurrent();
        uploadHelpers.assignFilesToInput(input, data.files, window);
        mutationAttempted = true;
        options.batch?.pending.set(target, operation);
        input.dispatchEvent(new window.Event('change', { bubbles: true }));
        // Never click Replace/Overwrite. A concurrent name conflict must stop.
        verificationPhase = 'post-upload';
        const deadline = now() + readBudget.remainingMs;
        let observations = 0;
        if (options.batch) {
          await waitFor(() => {
            if (dialogs().some(d => /replace|overwrite|替换|覆盖/i.test(d.innerText || ''))) {
              options.batch.blocked.add(target);
              throw new Error('Overleaf reported an upload conflict; replacement was not authorized.');
            }
            return projectPathExists(target);
          }, 30000);
          return;
        }
        do {
          assertCurrent();
          const conflict = dialogs().some(d => /replace|overwrite|替换|覆盖/i.test(d.innerText || ''));
          if (conflict) throw new Error('Overleaf reported an upload conflict; replacement was not authorized.');
          const file = (await readServerFiles()).find(entry => entry.path === target);
          if (file && typeof file.content === 'string' && file.content === operation.content) {
            if (dialogs().includes(dialog)) {
              const close = Array.from(dialog.querySelectorAll('button')).find(node => visible(node)
                && /^(?:Close dialog|Close|Done|Cancel|关闭|完成|取消)$/i.test(controlName(node)));
              if (close) close.click();
            }
            await waitFor(() => !dialogs().length);
            return;
          }
          const remaining = deadline - now();
          if (remaining <= 0) break;
          await pauseVerification(readBudget, Math.min(250 * (2 ** Math.min(observations++, 3)), remaining));
        } while (now() < deadline && observations < MAX_CONFIRMATION_OBSERVATIONS);
        throw new Error('The new file content was not confirmed in the server source ZIP. No editor content was modified.');
      };
      try {
        assertCurrent();
        if (options.batch?.error) throw options.batch.error;
        const existing = options.batch?.before.get(target);
        if (existing && options.allowExistingMatches === true && existing.content === operation.content) {
          return { ok: true, verified: true, changedDocument: false, idempotent: true,
            method: 'overleaf.existing-text-match', verification: 'overleaf-zip',
            saveReceipt: await makeSaveReceipt(projectId, target, operation.content) };
        }
        if (projectPathExists(target)) return { ok: false, code: 'target_file_already_exists', reason: 'The target file already exists.' };
        if (!uploadHelpers?.assignFilesToInput || !snapshotRouter?.fetchProjectZipSnapshot) throw new Error('Verified text upload support is unavailable.');
        if (options.batch ? options.batch.before.has(target) : (await readServerFiles()).some(file => file.path === target)) {
          return { ok: false, code: 'target_file_already_exists', reason: 'The server already contains the target file.' };
        }
        const parts = target.split('/');
        for (let depth = 1; depth < parts.length; depth += 1) {
          const folderPath = parts.slice(0, depth).join('/');
          if (!findFolder(folderPath)) await createFolderWithDom(folderPath, {
            isCurrent: () => { assertCurrent(); return true; },
            onMutation: () => { mutationAttempted = true; }
          });
          await ensureFolderExpanded(folderPath);
        }
        await uploadText();
        if (options.batch) return { ok: false, pendingVerification: true, changedDocument: true };
        return { ok: true, method: 'overleaf.native-text-upload', changedDocument: true,
          verified: true, verification: 'overleaf-zip',
          saveReceipt: await makeSaveReceipt(projectId, target, operation.content) };
      } catch (error) {
        return {
          ...verificationFailure(error, mutationAttempted, verificationPhase),
          diagnostics: { verificationPhase, zipReadCount, lastZipFailure }
        };
      } finally {
        if (uploadDialog && getProjectId() === projectId && dialogs().includes(uploadDialog)) {
          const close = Array.from(uploadDialog.querySelectorAll('button')).find(node => visible(node)
            && /^(?:Close dialog|Close|Done|Cancel|关闭|完成|取消)$/i.test(controlName(node)));
          close?.click();
        }
      }
    }
    // Binary uploads use the same folder hierarchy as verified text uploads.
    // A folder is not a text document and must never use basename fallback.
    async function prepareUploadParent(folderPath, options = {}) {
      const target = normalizeSafeProjectPath(folderPath);
      const projectId = getProjectId();
      if (!target || !projectId) throw new Error('A valid upload parent and project are required.');
      const assertCurrent = () => assertVerificationOwner(projectId, options.isCurrent);
      const expand = async path => {
        assertCurrent();
        const node = findFolder(path);
        if (!node) throw new Error(`Target folder ${path} is unavailable in the Overleaf file tree.`);
        if (node.getAttribute('aria-expanded') !== 'false') return node;
        const toggle = node.querySelector('.folder-expand-collapse-button');
        if (!toggle) throw new Error('The upload parent cannot be expanded safely.');
        toggle.click();
        const deadline = Date.now() + 5000;
        do {
          assertCurrent();
          invalidateDomProjectPathCache();
          const expanded = findFolder(path);
          if (expanded?.getAttribute('aria-expanded') === 'true') return expanded;
          await delay(100);
        } while (Date.now() < deadline);
        throw new Error('Overleaf did not confirm the expanded upload parent.');
      };
      const parts = target.split('/');
      for (let depth = 1; depth <= parts.length; depth += 1) {
        const path = parts.slice(0, depth).join('/');
        assertCurrent();
        if (!findFolder(path) && options.createMissing === true) await createFolderWithDom(path, {
          isCurrent: () => { assertCurrent(); return true; }, onMutation: options.onMutation
        });
        await expand(path);
      }
      assertCurrent();
      const parent = findFolder(target);
      if (parent.getAttribute('aria-selected') !== 'true') {
        (parent.querySelector('.file-tree-entity-button') || parent).click();
        await delay(100);
      }
      const selected = await expand(target);
      if (selected.getAttribute('aria-selected') !== 'true') {
        throw new Error('Overleaf did not confirm the selected upload parent.');
      }
      return selected;
    }

    async function prepareEditor(params = {}) {
      const hasEditor = () => {
        return ['.cm-content', '.ace_editor', '.ProseMirror', 'textarea'].some(selector => {
          const nodes = deps.collectElements?.(selector, 120) || document.querySelectorAll(selector);
          return Array.from(nodes).some(node => {
            if (!node || node.closest?.('#codex-overleaf-panel, [hidden], [aria-hidden="true"], [inert]')) return false;
            if (/invisible element to manage focus/i.test(node.getAttribute?.('aria-label') || '')) return false;
            if (typeof node.getClientRects === 'function' && !node.getClientRects().length) return false;
            const style = window.getComputedStyle?.(node);
            return style?.display !== 'none' && !['hidden', 'collapse'].includes(style?.visibility);
          });
        });
      };
      if (hasEditor()) return { ok: true };
      const projectId = params.runProjectId || params.projectId || getProjectId();
      const readCancellation = deps.readWriteCancellationSequence || (() => 0);
      const cancellation = readCancellation();
      const isCurrent = () => Boolean(projectId) && getProjectId() === projectId && readCancellation() === cancellation;
      const aborted = () => ({ ok: false, code: 'aborted_project_changed',
        reason: 'Project changed or the operation was cancelled before editor preparation.' });
      if (!isCurrent()) return aborted();
      const paths = collectProjectTextPaths('');
      const activePath = treeOperations.getActiveFilePath?.() || '';
      const target = paths.includes(activePath) ? activePath : paths[0];
      if (!target) return { ok: false, code: 'target_editor_not_ready',
        reason: 'No known text file is available to prepare Overleaf Editing/Reviewing controls.' };
      const opened = await treeOperations.openFileByPath(target, { force: true });
      if (!isCurrent()) return aborted();
      if (!opened.ok) return opened;
      const deadline = Date.now() + 5000;
      while (!hasEditor() && Date.now() < deadline) {
        if (!isCurrent()) return aborted();
        await delay(100);
      }
      if (!isCurrent()) return aborted();
      if (!hasEditor()) return { ok: false, code: 'target_editor_not_ready',
        reason: 'Overleaf did not expose its text editor before mode preparation timed out.' };
      return { ok: true };
    }

    async function ensureWriteMode(reviewing, params = {}) {
      const ensureMode = reviewing ? deps.ensureReviewing : deps.ensureEditing;
      if (typeof ensureMode !== 'function') return { ok: false, reason: 'Editor mode controls are unavailable.' };
      const prepared = await prepareEditor(params);
      return prepared.ok ? ensureMode(params) : prepared;
    }

    // Only the router's checked text pre-image authorizes this fallback.
    // Never treat a missing row, a closed modal, or a successful click as a
    // deletion receipt: absence must be read from the server source ZIP.
    async function deleteFile(operation, options = {}) {
      const target = normalizeSafeProjectPath(operation.path);
      const projectId = getProjectId();
      const expected = options.expectedContent;
      const binary = operation.undoCreatedFile?.v === 1 && operation.undoCreatedFile.kind === 'binary'
        && options.undoCreatedFile === true && /^[a-f0-9]{64}$/i.test(options.expectedSha256 || '');
      const matchesExpected = async file => {
        if (!binary) return file && file.content === expected;
        if (typeof file?.contentBase64 !== 'string') return false;
        const cryptoApi = window.crypto || globalThis.crypto;
        if (!cryptoApi?.subtle) return false;
        const decode = window.atob || globalThis.atob;
        if (typeof decode !== 'function') return false;
        const bytes = Uint8Array.from(decode(file.contentBase64.replace(/\s/g, '')), value => value.charCodeAt(0));
        const hash = await cryptoApi.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
          === options.expectedSha256.toLowerCase();
      };
      const canDelete = options.canDelete || (() => typeof deps.readActiveEditorText === 'function'
        && treeOperations.getActiveFilePath?.() === target && deps.readActiveEditorText() === expected);
      let mutationAttempted = false;
      let stage = 'preflight';
      let ownedDialog = null;
      const visible = node => Boolean(node && !node.disabled && node.getClientRects?.().length);
      const dialogs = () => Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible);
      const assertCurrent = () => assertVerificationOwner(projectId, options.isCurrent);
      const waitFor = async (read, timeoutMs = 5000) => {
        const deadline = Date.now() + timeoutMs;
        do {
          assertCurrent();
          invalidateDomProjectPathCache();
          const value = await read();
          if (value) return value;
          await delay(100);
        } while (Date.now() < deadline);
        throw new Error(`Overleaf did not confirm ${stage} before timeout.`);
      };
      const readServerFiles = async () => {
        assertCurrent();
        snapshotRouter.invalidateCache?.();
        const result = await snapshotRouter.fetchProjectZipSnapshot({ force: true, maxAgeMs: 0,
          includeBinaryFiles: binary, includeContent: true, zipTimeoutMs: 15000 });
        assertCurrent();
        if (result?.ok !== true || !Array.isArray(result.files)
          || (result.skipped || []).some(file => file?.path === target)) {
          throw new Error('Server source ZIP is unavailable; deletion cannot be verified safely.');
        }
        return result.files;
      };
      const choose = (scope, selector, pattern) => {
        const matches = Array.from(scope.querySelectorAll(selector)).filter(node => visible(node)
          && node.getAttribute('aria-disabled') !== 'true' && pattern.test(controlName(node)));
        if (matches.length !== 1) throw new Error('A unique Overleaf deletion control could not be identified.');
        return matches[0];
      };
      const resolveRow = () => {
        const node = findFileTreeNode(target, { invalidateCache: true });
        return node?.closest?.('[role="treeitem"]') || node;
      };
      // Current Overleaf keeps the stable document ID on the draggable
      // entity inside the row. The menu only mounts on hover/selection.
      const rowIdentity = row => row?.querySelector('[data-file-type="doc"][data-file-id]')?.getAttribute('data-file-id')
        || row?.querySelector('[data-file-type="file"][data-file-id]')?.getAttribute('data-file-id')
        || row?.getAttribute('data-entity-id') || row?.getAttribute('data-doc-id')
        || row?.getAttribute('data-file-id') || row?.querySelector('[id^="menu-button-"]')?.id || '';
      try {
        if (!target || !projectId || typeof canDelete !== 'function'
          || (!binary && (typeof expected !== 'string' || !window.CodexOverleafProjectFiles?.isTextProjectPath(target)))) {
          throw new Error('A checked file pre-image is required for deletion.');
        }
        assertCurrent();
        if (dialogs().length) throw new Error('An existing Overleaf dialog must be closed before deleting files.');
        if (!snapshotRouter?.fetchProjectZipSnapshot) throw new Error('Verified deletion support is unavailable.');
        const original = (await readServerFiles()).find(file => file.path === target);
        if (!original && options.undoCreatedFile === true && !resolveRow()) {
          return { ok: true, method: 'overleaf.native-created-file-delete', changedDocument: false,
            idempotent: true, verified: true, verification: 'overleaf-zip' };
        }
        const originalMatches = await matchesExpected(original);
        assertCurrent();
        if (!originalMatches || canDelete() !== true) {
          throw new Error('The file no longer matches the checked pre-image; deletion was stopped.');
        }
        const parentPath = target.split('/').slice(0, -1).join('/');
        if (parentPath) await prepareUploadParent(parentPath, options);
        const row = resolveRow();
        const identity = rowIdentity(row);
        if (!row || !identity || row.querySelector('[data-file-type="folder"]')) {
          throw new Error('An exact Overleaf file row could not be identified.');
        }
        stage = 'file selection';
        (row.querySelector('.file-tree-entity-details, .file-tree-entity-button') || row).click();
        await waitFor(() => {
          const selected = Array.from(document.querySelectorAll('[data-testid="file-tree-list-root"] [role="treeitem"][aria-selected="true"]'));
          return selected.length === 1 && rowIdentity(selected[0]) === identity && canDelete() === true;
        });
        assertCurrent();
        const currentRow = resolveRow();
        if (rowIdentity(currentRow) !== identity) throw new Error('The target file identity changed.');
        stage = 'delete context menu';
        // Overleaf handles contextmenu below the treeitem, on its entity.
        // Dispatch from the visible label so all native ancestors receive it.
        const eventTarget = currentRow.querySelector('.item-name span, .file-tree-entity-details') || currentRow;
        const rect = eventTarget.getBoundingClientRect();
        eventTarget.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true,
          button: 2, buttons: 2, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
        const menu = await waitFor(() => {
          const menus = Array.from(document.querySelectorAll('[role="menu"]')).filter(node => visible(node)
            && !node.closest('#codex-overleaf-panel'));
          return menus.length === 1 && menus[0];
        });
        choose(menu, '[role="menuitem"]', /^(?:Delete|删除)$/i).click();
        stage = 'delete confirmation';
        ownedDialog = await waitFor(() => dialogs().length === 1 && dialogs()[0]);
        const verifyDialog = () => {
          const entries = Array.from(ownedDialog.querySelectorAll('li')).map(controlName);
          const name = target.split('/').pop();
          return dialogs().length === 1 && dialogs()[0] === ownedDialog
            && entries.length === 1 && (entries[0] === name || entries[0] === target);
        };
        if (!verifyDialog()) throw new Error('The deletion dialog does not name exactly the authorized file.');
        const latest = (await readServerFiles()).find(file => file.path === target);
        const latestMatches = await matchesExpected(latest);
        assertCurrent();
        if (!latestMatches || canDelete() !== true
          || rowIdentity(resolveRow()) !== identity || !verifyDialog()) {
          throw new Error('The target changed before confirmation; deletion was stopped.');
        }
        const confirm = choose(ownedDialog, 'button', /^(?:Delete|删除)$/i);
        stage = 'server deletion receipt';
        mutationAttempted = true;
        confirm.click();
        await waitFor(async () => !(await readServerFiles()).some(file => file.path === target), 15000);
        return { ok: true, method: binary ? 'overleaf.native-created-file-delete' : 'overleaf.native-text-delete', changedDocument: true,
          verified: true, verification: 'overleaf-zip' };
      } catch (error) {
        return { ok: false, code: mutationAttempted ? 'file_tree_operation_unverified' : 'file_tree_controls_unavailable',
          reason: error.message, stage: stage.replace(/ /g, '_'), changedDocument: mutationAttempted };
      } finally {
        // Close only the dialog opened by this operation; never another modal.
        if (ownedDialog && dialogs().includes(ownedDialog) && getProjectId() === projectId) {
          const cancel = Array.from(ownedDialog.querySelectorAll('button')).filter(node => visible(node)
            && /^(?:Cancel|取消)$/i.test(controlName(node)));
          if (cancel.length === 1) cancel[0].click();
        }
      }
    }

    async function createFile(operation, options = {}) {
      return createTextFileWithDom(operation, options);
    }
    return { createFile, deleteFile, prepareEditor, ensureWriteMode, prepareUploadParent, findFolderNode: findFolder,
      beginCreateBatch, finishCreateBatch,
      cancelVerifications() { for (const controller of verificationReads) controller.abort(); } };
  }
  return { create };
});
