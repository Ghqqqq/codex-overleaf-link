(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexOverleafOwnedDirectoryCleanup = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  function create(deps = {}) {
    const { document, treeOperations, delay, now, readServerSnapshot,
      assertVerificationOwner, normalizeDomText, normalizeSafeProjectPath } = deps;
    const { invalidateDomProjectPathCache } = treeOperations;
    function folderIdentity(row) {
      const entity = row?.querySelector?.('[data-file-type="folder"]');
      return ['data-file-id', 'data-folder-id', 'data-entity-id']
        .map(name => entity?.getAttribute?.(name) || row?.getAttribute?.(name) || '').find(Boolean) || '';
    }
    // Resolve every path component within its direct native child group. A
    // collapsed/ambiguous tree is unknown, never proof that a folder is absent.
    function locateOwnedFolder(path) {
      let group = document.querySelector('[data-testid="file-tree-list-root"], .file-tree-list[role="tree"]');
      const parts = path.split('/');
      for (let index = 0; index < parts.length; index++) {
        if (!group?.children) throw new Error('The native folder tree is unavailable.');
        const inner = Array.from(group.children).find(node => node.classList?.contains('file-tree-folder-list-inner')) || group;
        const matches = Array.from(inner.children).filter(node => node.getAttribute?.('role') === 'treeitem'
          && node.querySelector?.('[data-file-type="folder"]') && normalizeDomText(node.getAttribute('aria-label')) === parts[index]);
        if (matches.length > 1) throw new Error('The folder path is ambiguous.');
        if (!matches.length) return null;
        const row = matches[0];
        if (index === parts.length - 1) return row;
        if (row.getAttribute('aria-expanded') !== 'true') throw new Error('The ancestor folder must be expanded before cleanup.');
        const sibling = row.nextElementSibling;
        group = sibling?.getAttribute('role') === 'tree' ? sibling : row.querySelector('[role="tree"]');
      }
      return null;
    }
    // Native folder Delete can remove a subtree. Read/empty checks cannot
    // make that mutation conditional on the subtree staying empty. Retain the
    // proof for explicit native cleanup; never click Delete automatically.
    async function cleanupCreatedDirectories(proofs, options = {}) {
      const items = Array.isArray(proofs) ? proofs : [];
      const removed = [], completed = new Set(), failures = [], review = [];
      for (const proof of items.slice().sort((a, b) => String(b?.path || '').split('/').length - String(a?.path || '').split('/').length)) {
        try {
          const path = normalizeSafeProjectPath(proof?.path);
          if (proof?.v !== 1 || !path || path !== proof.path || !proof.projectId || !proof.nativeFolderId
            || (options.projectId && proof.projectId !== options.projectId)) throw new Error('The created folder identity is not proven.');
          const assertCurrent = () => assertVerificationOwner(proof.projectId, options.isCurrent);
          const exactRow = () => {
            const row = locateOwnedFolder(path);
            if (row && folderIdentity(row) !== proof.nativeFolderId) throw new Error('The created folder identity changed.');
            return row;
          };
          assertCurrent();
          for (let depth = 1; depth <= path.split('/').length; depth++) {
            const prefix = path.split('/').slice(0, depth).join('/'), row = locateOwnedFolder(prefix);
            if (!row) break;
            if (prefix === path && folderIdentity(row) !== proof.nativeFolderId) throw new Error('The created folder identity changed.');
            if (row.getAttribute('aria-expanded') === 'true') continue;
            const toggle = row.querySelector('.folder-expand-collapse-button');
            if (!toggle) throw new Error('The folder cannot be expanded safely.');
            assertCurrent(); toggle.click();
            const deadline = now() + 5000;
            while (locateOwnedFolder(prefix)?.getAttribute('aria-expanded') !== 'true') {
              assertCurrent(); if (now() >= deadline) throw new Error('The folder expansion was not confirmed.');
              await delay(100); invalidateDomProjectPathCache();
            }
          }
          exactRow();
          const snapshot = await readServerSnapshot({ projectId: proof.projectId, isCurrent: options.isCurrent, includeBinaryFiles: true });
          assertCurrent();
          const row = exactRow();
          const entries = [...snapshot.files, ...(snapshot.skipped || []), ...(snapshot.capabilities?.skipped || [])];
          const serverHasEntries = entries.some(entry => String(entry?.path || '').startsWith(path + '/'));
          if (!row) {
            if (serverHasEntries) throw new Error('Server entries remain under the folder path; absence is unconfirmed.');
            completed.add(proof); removed.push({ ...proof, alreadyAbsent: true, verification: 'overleaf-native-tree-and-zip' }); continue;
          }
          const sibling = row.nextElementSibling;
          const group = sibling?.getAttribute('role') === 'tree' ? sibling : row.querySelector('[role="tree"]');
          if (row.getAttribute('aria-expanded') !== 'true' || !group?.children) throw new Error('The folder contents are unknown.');
          const inner = Array.from(group.children).find(node => node.classList?.contains('file-tree-folder-list-inner')) || group;
          const empty = inner.children.length === 0 && !serverHasEntries;
          review.push({ ...proof, empty, requiresExplicitCleanup: true });
          failures.push({ path, code: empty ? 'directory_requires_explicit_cleanup' : 'created_directory_not_empty',
            reason: empty ? 'The new empty folder remains. Review and remove it through Overleaf if appropriate.'
              : 'The created folder contains entries or unread files and was left untouched.' });
        } catch (error) { failures.push({ path: proof?.path || '', code: error?.code || 'created_directory_cleanup_unconfirmed', reason: error?.message || '' }); }
      }
      return { ok: completed.size === items.length, removed, remaining: items.filter(item => !completed.has(item)),
        failures, review, requiresExplicitCleanup: review.length > 0, changedDocument: false };
    }
    return { folderIdentity, cleanupCreatedDirectories };
  }
  return { create };
});
