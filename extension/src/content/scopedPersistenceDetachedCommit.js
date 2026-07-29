(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafScopedPersistenceDetachedCommit = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function create(options) {
    options = options || {};
    var Transaction = options.Transaction;
    if (!Transaction
      || typeof Transaction.createBrowserAdapter !== 'function'
      || typeof Transaction.createCoordinator !== 'function') {
      return null;
    }
    var adapter = Transaction.createBrowserAdapter({ chromeApi: options.chromeApi });
    return async function commitDetached(projectId, accountScopeId, commitOptions, action) {
      var nextScope = {
        accountScopeId: String(accountScopeId || '').trim(),
        projectId: String(projectId || '').trim()
      };
      if (!nextScope.accountScopeId) {
        return { ok: false, reason: 'account_scope_unavailable' };
      }
      if (!nextScope.projectId) {
        return { ok: false, reason: 'project_scope_unavailable' };
      }
      var coordinator = Transaction.createCoordinator({
        adapter: adapter,
        writerId: options.writerId
      });
      var hydration = await coordinator.beginHydration(nextScope);
      if (!coordinator.isCurrent(hydration)) {
        return { ok: false, reason: 'stale_view' };
      }
      var view = await coordinator.captureCommitView(nextScope, { detached: true });
      return coordinator.commit(view, action, {
        rebase: !commitOptions || commitOptions.rebase !== false,
        queueMutation: commitOptions && commitOptions.queueMutation,
        queueMutations: commitOptions && commitOptions.queueMutations,
        sessionTombstones: commitOptions && commitOptions.sessionTombstones
      });
    };
  }

  return Object.freeze({ create: create });
});
