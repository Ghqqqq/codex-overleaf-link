(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./sessionState'));
  else root.CodexOverleafModuleRegistry.define('ComposerAttachmentDraft', ['SessionState'], factory);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (SessionState) {
  'use strict';
  const EPOCH_KEY = 'composer-attachment-draft:clear-epoch';
  const normalize = value => SessionState.normalizeComposerAttachmentsForPersistence(value);
  function normalizeOmitted(value) {
    const names = (Array.isArray(value?.names) ? value.names : [])
      .filter(name => typeof name === 'string')
      .map(name => name.replace(/\0/g, '').trim().slice(0, 180))
      .filter(Boolean).slice(0, 8);
    return { count: names.length, names };
  }
  const scopeKey = scope => JSON.stringify([scope?.accountScopeId || '', scope?.projectId || '']);
  function checkedScope(scope) {
    const accountScopeId = String(scope?.accountScopeId || '').trim();
    const projectId = String(scope?.projectId || '').trim();
    if (!accountScopeId || !projectId) throw failure('account_scope_unavailable');
    return { accountScopeId, projectId };
  }
  function failure(code) {
    return Object.assign(new Error(code === 'composer_draft_cleared'
      ? 'Saved attachments were cleared in another tab. Reload, then reattach files before retrying.'
      : code === 'composer_draft_conflict'
        ? 'The saved attachment draft changed in another tab. Reload before changing it.'
        : 'Attachment draft scope is unavailable or changed.'), { code });
  }
  function createStore(openDb) {
    async function access(input, value) {
      const scope = checkedScope(input);
      const id = 'composer-attachment-draft:' + scopeKey(scope);
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('artifacts', value ? 'readwrite' : 'readonly');
        const store = tx.objectStore('artifacts');
        let result, error;
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(error || tx.error || new Error('Attachment draft transaction failed.'));
        const epochRequest = store.get(EPOCH_KEY);
        epochRequest.onsuccess = () => {
          const epoch = Number(epochRequest.result?.epoch) || 0;
          const clearedAt = Number(epochRequest.result?.clearedAt) || 0;
          const request = store.get(id);
          request.onsuccess = () => {
            try {
              const previous = request.result;
              if (previous && (previous.accountScopeId !== scope.accountScopeId || previous.projectId !== scope.projectId)) {
                throw failure('account_scope_unavailable');
              }
              const revision = Number(previous?.revision) || 0;
              result = { epoch, clearedAt, revision, attachments: normalize(previous?.attachments), omittedAttachments: normalizeOmitted(previous?.omittedAttachments) };
              if (!value) return;
              const attachments = normalize(value.attachments);
              const omittedAttachments = normalizeOmitted(value.omittedAttachments);
              const hasDraft = attachments.length || omittedAttachments.count;
              if (value.epoch !== epoch) {
                // A clear performed by this page also invalidates its old base.
                // Its empty draft needs no write; an old nonempty draft cannot return.
                if (!hasDraft) return;
                throw failure('composer_draft_cleared');
              }
              if (value.revision !== revision) {
                // Writing what another tab already stored changes nothing (for example
                // both tabs clearing an empty draft on send); only a real edit conflicts.
                if (JSON.stringify(attachments) === JSON.stringify(result.attachments)
                  && JSON.stringify(omittedAttachments) === JSON.stringify(result.omittedAttachments)) return;
                throw failure('composer_draft_conflict');
              }
              if (hasDraft && value.unbased && clearedAt && value.changedAt <= clearedAt) {
                throw failure('composer_draft_cleared');
              }
              result = { epoch, clearedAt, revision: revision + 1, attachments, omittedAttachments };
              store.put({ id, type: 'composer-attachment-draft', ...scope, ...result });
            } catch (caught) { error = caught; tx.abort(); }
          };
        };
      });
    }
    async function clear(storeNames) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeNames, 'readwrite');
        const artifacts = tx.objectStore('artifacts');
        const request = artifacts.get(EPOCH_KEY);
        let epoch;
        request.onsuccess = () => {
          epoch = (Number(request.result?.epoch) || 0) + 1;
          for (const name of storeNames) tx.objectStore(name).clear();
          artifacts.put({ id: EPOCH_KEY, type: 'composer-attachment-draft-epoch', epoch, clearedAt: Date.now() });
        };
        tx.oncomplete = () => resolve({ composerDraftEpoch: epoch });
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('History clear failed.'));
      });
    }
    return { read: scope => access(scope), write: (scope, value) => access(scope, value), clear };
  }

  function createController(options) {
    let scope = options.getScope(), key = scopeKey(scope), generation = 0;
    let base = null, hydrated = false, changedVersion = 0, savedVersion = 0;
    let dirtySince = 0, dirtyUnbased = false, loadSequence = 0;
    let saving = Promise.resolve();
    const publish = () => options.setAttachments(normalize(options.getAttachments()));
    function syncScope() {
      const next = options.getScope(), nextKey = scopeKey(next);
      if (nextKey === key) return;
      scope = next; key = nextKey; generation++;
      base = null; hydrated = false; changedVersion = savedVersion = 0; dirtySince = 0; dirtyUnbased = false;
      options.clear(); publish();
    }
    async function load(requestedScope = options.getScope()) {
      syncScope();
      if (scopeKey(requestedScope) !== key) throw failure('stale_hydration');
      const captured = generation, sequence = ++loadSequence;
      const snapshot = await options.read(checkedScope(scope));
      if (captured !== generation || sequence !== loadSequence || scopeKey(options.getScope()) !== key) throw failure('stale_hydration');
      if (base && snapshot.epoch !== base.epoch) {
        // Adopt an observed history clear together with its empty local view;
        // otherwise the next edit could attach an old view to the new epoch.
        options.clear(); changedVersion = savedVersion = 0; dirtySince = 0; dirtyUnbased = false;
        hydrated = false; base = snapshot; publish();
      }
      const keepLocal = changedVersion || hydrated;
      // A read alone does not give an unchanged visible draft a newer CAS base.
      if (!base || !keepLocal) base = snapshot;
      return keepLocal ? normalize(options.getAttachments()) : snapshot.attachments;
    }
    function hydrate(attachments) {
      syncScope();
      if (hydrated) return;
      // Loading is allowed to finish after a local add/remove. Local edits win.
      if (!changedVersion && !options.getAttachments().length) {
        options.restore(normalize(attachments));
        const omitted = normalizeOmitted(base?.omittedAttachments);
        if (omitted.count) options.onRestoreOmittedAttachments?.(omitted);
      }
      hydrated = true; publish();
    }
    function changed() {
      const before = key;
      syncScope();
      if (before !== key) return;
      if (changedVersion === savedVersion) { dirtySince = Date.now(); dirtyUnbased = !base; }
      changedVersion++; hydrated = true; publish(); options.scheduleSave();
    }
    function save(requestedScope = options.getScope()) {
      syncScope();
      if (scopeKey(requestedScope) !== key) return Promise.resolve();
      const captured = generation;
      const work = async () => {
        if (captured !== generation || scopeKey(options.getScope()) !== key || changedVersion === savedVersion) return;
        const version = changedVersion;
        const attachments = normalize(options.getAttachments());
        const omittedAttachments = normalizeOmitted({ names: options.getOmittedAttachmentNames?.() });
        const unbased = dirtyUnbased, changedAt = dirtySince;
        if (!base) await load(scope);
        if (captured !== generation || scopeKey(options.getScope()) !== key) return;
        const written = await options.write(checkedScope(scope), { ...base, attachments, omittedAttachments, unbased, changedAt });
        if (captured !== generation) return;
        base = written; savedVersion = version;
        if (changedVersion === version) { dirtySince = 0; dirtyUnbased = false; }
      };
      const next = saving.then(work, work);
      saving = next.catch(() => {});
      return next;
    }
    return { syncScope, load, hydrate, changed, save };
  }
  return { createStore, createController, normalize, EPOCH_KEY };
});
