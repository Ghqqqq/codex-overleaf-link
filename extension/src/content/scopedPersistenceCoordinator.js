(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./scopedPersistencePanelState'),
      require('./scopedPersistenceDetachedCommit')
    );
  } else {
    root.CodexOverleafModuleRegistry.define(
      'ScopedPersistenceCoordinator',
      ['ScopedPersistencePanelState', 'ScopedPersistenceDetachedCommit'],
      factory
    );
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PanelState, DetachedCommit) {
  'use strict';

  function createController(options) {
    options = options || {};
    var Transaction = options.Transaction;
    if (!Transaction || typeof Transaction.createCoordinator !== 'function') return null;
    var writerId = getStableWriterId(options.sessionStorage);
    var coordinator = Transaction.createCoordinator({
      adapter: Transaction.createBrowserAdapter({ chromeApi: options.chromeApi }),
      writerId: writerId
    });
    var commitDetached = (options.DetachedCommit || DetachedCommit)?.create?.({
      Transaction: Transaction, chromeApi: options.chromeApi, writerId: writerId
    });
    var activeScope = null;

    function scope(projectId) {
      var accountScopeId = '';
      try {
        accountScopeId = typeof options.getAccountScopeId === 'function'
          ? options.getAccountScopeId() || ''
          : '';
      } catch (_error) {
        accountScopeId = '';
      }
      return { accountScopeId: accountScopeId, projectId: projectId };
    }

    return Object.freeze({
      async beginHydration(projectId) {
        var nextScope = scope(projectId);
        if (!nextScope.accountScopeId) {
          activeScope = null;
          return null;
        }
        var token = await coordinator.beginHydration(nextScope);
        if (coordinator.isCurrent(token)) activeScope = nextScope;
        return token;
      },
      isCurrent: coordinator.isCurrent,
      async commit(projectId, commitOptions, action) {
        var nextScope = scope(projectId);
        if (!nextScope.accountScopeId) {
          return { ok: false, reason: 'account_scope_unavailable' };
        }
        if (!activeScope
          || activeScope.accountScopeId !== nextScope.accountScopeId
          || activeScope.projectId !== nextScope.projectId) {
          var hydration = await coordinator.beginHydration(nextScope);
          if (!coordinator.isCurrent(hydration)) {
            return { ok: false, reason: 'stale_view' };
          }
          activeScope = nextScope;
        }
        var view = await coordinator.captureCommitView(nextScope, {
          detached: Boolean(commitOptions && commitOptions.detached)
        });
        return coordinator.commit(view, action, {
          rebase: !commitOptions || commitOptions.rebase !== false,
          queueMutation: commitOptions && commitOptions.queueMutation,
          queueMutations: commitOptions && commitOptions.queueMutations,
          sessionTombstones: commitOptions && commitOptions.sessionTombstones
        });
      },
      commitDetached: commitDetached
    });
  }
  function getStableWriterId(storage) {
    var key = 'codex-overleaf-scoped-writer-id';
    try {
      var existing = storage?.getItem?.(key);
      if (existing) return existing;
      var created = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : 'writer-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
      storage?.setItem?.(key, created);
      return created;
    } catch (_error) {
      return '';
    }
  }
  return Object.freeze({
    createController: createController,
    persistPanelState: PanelState?.persistPanelState || null
  });
});
