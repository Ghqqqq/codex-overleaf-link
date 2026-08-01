(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafModuleRegistry.define('ScopedPersistenceReceipt', [], factory);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createFenceMeta(meta, currentMeta, writerId) {
    var startedAt = new Date().toISOString();
    var revision = currentMeta.revision + 1;
    return {
      ...meta,
      revision: revision,
      durableRevision: currentMeta.durableRevision,
      pendingCommit: { revision: revision, writerId: writerId, startedAt: startedAt },
      writerId: writerId,
      updatedAt: startedAt
    };
  }

  function createCommittedMeta(fenceMeta) {
    return {
      ...fenceMeta,
      durableRevision: fenceMeta.revision,
      pendingCommit: null,
      updatedAt: new Date().toISOString()
    };
  }

  function createRecoveredMeta(currentMeta, fenceMeta, writerId) {
    var revision = fenceMeta.revision + 1;
    return {
      ...currentMeta,
      revision: revision,
      durableRevision: revision,
      pendingCommit: null,
      queueRevision: fenceMeta.queueRevision + 1,
      writerId: writerId,
      updatedAt: new Date().toISOString()
    };
  }

  function decorateReceiptError(error, revision) {
    if (error && typeof error === 'object') {
      error.code = error.code || 'persistence_receipt_write_failed';
      error.persistenceActionCommitted = true;
      error.persistenceRevision = revision;
    }
    return error;
  }

  return Object.freeze({
    createFenceMeta: createFenceMeta,
    createCommittedMeta: createCommittedMeta,
    createRecoveredMeta: createRecoveredMeta,
    decorateReceiptError: decorateReceiptError
  });
});
