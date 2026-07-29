(function initStorageSessionClaims(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafStorageSessionClaims = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function storageSessionClaimsFactory() {
  'use strict';

  function createSessionClaimer(openDb, getKeyRange) {
    return function claimSessionsForAccount(projectId, accountScopeId, deletedSessionIds) {
      var normalizedProjectId = typeof projectId === 'string' ? projectId.trim() : '';
      var normalizedAccountScopeId = typeof accountScopeId === 'string' ? accountScopeId.trim() : '';
      if (!normalizedProjectId || !normalizedAccountScopeId) {
        return Promise.reject(Object.assign(
          new Error('A project and account scope are required to claim legacy sessions.'),
          { code: !normalizedAccountScopeId ? 'account_scope_unavailable' : 'project_scope_unavailable' }
        ));
      }
      var deleted = {};
      (Array.isArray(deletedSessionIds) ? deletedSessionIds : []).forEach(function (id) {
        if (typeof id === 'string' && id) deleted[id] = true;
      });
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var visible = [];
          var tx = db.transaction('sessions', 'readwrite');
          var store = tx.objectStore('sessions');
          var index = store.index('projectId');
          var request = index.openCursor(getKeyRange().only(normalizedProjectId));
          request.onsuccess = function (event) {
            var cursor = event.target.result;
            if (!cursor) return;
            var record = cursor.value;
            if (record && !deleted[record.id]) {
              var recordScopeId = typeof record.accountScopeId === 'string'
                ? record.accountScopeId.trim()
                : '';
              if (recordScopeId === normalizedAccountScopeId) {
                visible.push(record);
              } else if (!recordScopeId) {
                var claimed = Object.assign({}, record, {
                  accountScopeId: normalizedAccountScopeId,
                  accountScopeUnavailable: false
                });
                cursor.update(claimed);
                visible.push(claimed);
              }
            }
            cursor.continue();
          };
          request.onerror = function (event) { reject(event.target.error); };
          tx.oncomplete = function () { resolve(visible); };
          tx.onerror = function (event) { reject(event.target.error || tx.error); };
          tx.onabort = function (event) { reject(event.target.error || tx.error); };
        });
      });
    };
  }

  return Object.freeze({ createSessionClaimer: createSessionClaimer });
});
