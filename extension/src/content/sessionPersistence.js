(function initCodexOverleafSessionPersistence() {
  'use strict';

  function migration() {
    return window.CodexOverleafStorageMigration;
  }

  async function loadTombstones() {
    return migration()?.loadSessionTombstones?.() || {};
  }

  async function getDeletedSessionIds(projectId) {
    const Migration = migration();
    return Migration?.getDeletedSessionIds?.(await loadTombstones(), projectId) || [];
  }

  async function addTombstones(projectId, sessionIds) {
    return migration()?.addSessionTombstones?.(projectId, sessionIds) || loadTombstones();
  }

  function isVisibleRecord(record, deletedIds, accountScopeId) {
    return Boolean(record)
      && !(deletedIds || []).includes(record.id)
      && Boolean(accountScopeId)
      && record.accountScopeId === accountScopeId;
  }

  async function writeSessions(options = {}) {
    const { StorageDb, projectId } = options;
    const accountScopeId = typeof options.accountScopeId === 'string'
      ? options.accountScopeId.trim()
      : '';
    if (!accountScopeId) {
      throw Object.assign(new Error('Session persistence requires an account identity.'), {
        code: 'account_scope_unavailable'
      });
    }
    const Migration = options.Migration || migration();
    const requested = (Array.isArray(options.deletedSessionIds) ? options.deletedSessionIds : [])
      .filter(id => typeof id === 'string' && id);
    const tombstones = requested.length && Migration?.addSessionTombstones
      ? await Migration.addSessionTombstones(projectId, requested)
      : await Migration?.loadSessionTombstones?.() || {};
    const deleted = new Set(requested);
    for (const id of Migration?.getDeletedSessionIds?.(tombstones, projectId) || []) deleted.add(id);
    const queueTombstones = options.queueTombstones && typeof options.queueTombstones === 'object'
      ? options.queueTombstones
      : {};
    const rawSessionRecords = (options.sessionRecords || [])
      .filter(record => !deleted.has(record.id) && record.accountScopeId === accountScopeId);
    const rawExistingSessions = (await StorageDb.getAllByIndex('sessions', 'projectId', projectId))
      .filter(record => record?.accountScopeId === accountScopeId);
    const rawExistingById = new Map(rawExistingSessions.map(record => [record.id, record]));
    const sessionRecords = rawSessionRecords
      .map(record => applyQueuePolicy(
        record,
        rawExistingById.get(record.id),
        options,
        queueTombstones
      ));
    const existingSessions = rawExistingSessions
      .map(record => applyQueuePolicy(record, record, options, queueTombstones));
    const deletedExisting = existingSessions.filter(record => deleted.has(record.id));
    if (deletedExisting.length) {
      await Promise.all(deletedExisting.map(record => StorageDb.deleteRecord('sessions', record.id)));
    }
    const existingById = new Map(existingSessions
      .filter(record => !deleted.has(record.id))
      .map(record => [record.id, record]));
    const writable = sessionRecords.filter(record => {
      const existing = existingById.get(record.id);
      if (!existing) return true;
      return (Date.parse(record.updatedAt || '') || 0) >= (Date.parse(existing.updatedAt || '') || 0);
    });
    const cleanedExisting = existingSessions.filter((record, index) =>
      record !== rawExistingSessions[index] && !writable.some(item => item.id === record.id)
    );
    if (cleanedExisting.length || writable.length) {
      await StorageDb.putRecords('sessions', [...cleanedExisting, ...writable]);
    }
    return writable;
  }

  function applyQueuePolicy(record, existingRecord, options, queueTombstones) {
    const original = Array.isArray(record?.pendingInputs) ? record.pendingInputs : [];
    let pendingInputs = original.filter(item => item?.id && !queueTombstones[item.id]);
    const existingById = new Map(
      (Array.isArray(existingRecord?.pendingInputs) ? existingRecord.pendingInputs : [])
        .filter(item => item?.id && !queueTombstones[item.id])
        .map(item => [item.id, item])
    );
    const claims = options.queueClaims && typeof options.queueClaims === 'object'
      ? options.queueClaims
      : {};
    for (const claim of Object.values(claims)) {
      if (!claim?.itemId || claim.ownerId === options.writerId) continue;
      const index = pendingInputs.findIndex(item => item.id === claim.itemId);
      const authoritative = existingById.get(claim.itemId);
      if (authoritative && index >= 0) pendingInputs[index] = authoritative;
      else if (authoritative) pendingInputs.push(authoritative);
      else if (index >= 0) pendingInputs.splice(index, 1);
    }
    const unchanged = pendingInputs.length === original.length
      && pendingInputs.every((item, index) => item === original[index]);
    return unchanged ? record : { ...record, pendingInputs };
  }

  window.CodexOverleafSessionPersistence = {
    loadTombstones,
    getDeletedSessionIds,
    addTombstones,
    isVisibleRecord,
    writeSessions
  };
})();
