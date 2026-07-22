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
      && (!accountScopeId || record.accountScopeId === accountScopeId);
  }

  async function writeSessions(options = {}) {
    const { StorageDb, projectId } = options;
    const Migration = options.Migration || migration();
    const requested = (Array.isArray(options.deletedSessionIds) ? options.deletedSessionIds : [])
      .filter(id => typeof id === 'string' && id);
    const tombstones = requested.length && Migration?.addSessionTombstones
      ? await Migration.addSessionTombstones(projectId, requested)
      : await Migration?.loadSessionTombstones?.() || {};
    const deleted = new Set(requested);
    for (const id of Migration?.getDeletedSessionIds?.(tombstones, projectId) || []) deleted.add(id);
    const sessionRecords = (options.sessionRecords || []).filter(record => !deleted.has(record.id));
    const existingSessions = await StorageDb.getAllByIndex('sessions', 'projectId', projectId);
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
    if (writable.length) await StorageDb.putRecords('sessions', writable);
    return writable;
  }

  window.CodexOverleafSessionPersistence = {
    loadTombstones,
    getDeletedSessionIds,
    addTombstones,
    isVisibleRecord,
    writeSessions
  };
})();
