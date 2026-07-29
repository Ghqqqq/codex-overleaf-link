(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./scopedPersistenceQueuePolicy'),
      require('./scopedPersistenceBrowserAdapter')
    );
  } else {
    root.CodexOverleafModuleRegistry.define('ScopedPersistenceTransaction', [
      'ScopedPersistenceQueuePolicy',
      'ScopedPersistenceBrowserAdapter'
    ], factory);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (QueuePolicy, BrowserAdapter) {
  'use strict';

  var applyQueueMutations = QueuePolicy.applyQueueMutations;
  var cleanPart = QueuePolicy.cleanPart;
  var createQueueClaim = QueuePolicy.createQueueClaim;
  var isClaimCurrent = QueuePolicy.isClaimCurrent;
  var mergeTombstones = QueuePolicy.mergeTombstones;
  var normalizeMeta = QueuePolicy.normalizeMeta;
  var normalizeQueueMutations = QueuePolicy.normalizeQueueMutations;
  var normalizeRevision = QueuePolicy.normalizeRevision;
  var createBrowserAdapter = BrowserAdapter.createBrowserAdapter;
  var normalizeScope = BrowserAdapter.normalizeScope;
  var scopeKey = BrowserAdapter.scopeKey;

  function sameScope(left, right) {
    return Boolean(left && right
      && left.accountScopeId === right.accountScopeId
      && left.projectId === right.projectId);
  }


  function createCoordinator(options) {
    options = options || {};
    var adapter = options.adapter || createBrowserAdapter(options);
    var writerId = cleanPart(options.writerId) || randomId();
    var generation = 0;
    var active = null;

    async function beginHydration(inputScope) {
      var scope = normalizeScope(inputScope);
      generation += 1;
      var tokenGeneration = generation;
      active = makeToken(scope, tokenGeneration, 0, false, 0);
      var meta = await strictRead(adapter, scope);
      var token = makeToken(scope, tokenGeneration, meta.revision, false, meta.queueRevision);
      if (active && active.generation === tokenGeneration && sameScope(active, token)) active = token;
      return token;
    }

    async function captureCommitView(inputScope, captureOptions) {
      var scope = normalizeScope(inputScope);
      var detached = Boolean(captureOptions && captureOptions.detached);
      if (!detached && active && active.projectId === scope.projectId) {
        scope = normalizeScope({
          accountScopeId: active.accountScopeId,
          projectId: scope.projectId
        });
      }
      if (!detached && active && sameScope(active, scope)) {
        return makeToken(scope, active.generation, active.revision, false, active.queueRevision);
      }
      var meta = await strictRead(adapter, scope);
      return makeToken(scope, detached ? 0 : generation, meta.revision, detached, meta.queueRevision);
    }

    function isCurrent(token) {
      return Boolean(token && active && token.detached !== true
        && token.generation === active.generation && sameScope(token, active));
    }

    async function commit(token, action, commitOptions) {
      if (!token || typeof action !== 'function' || !token.projectId) {
        return { ok: false, reason: 'invalid_commit' };
      }
      var scope = normalizeScope(token);
      if (!token.detached && !isCurrent(token)) return { ok: false, reason: 'stale_view' };
      return adapter.withLock(scope, async function () {
        if (!token.detached && !isCurrent(token)) return { ok: false, reason: 'stale_view' };
        var currentMeta = await strictRead(adapter, scope);
        if (!token.detached && !isCurrent(token)) return { ok: false, reason: 'stale_view' };
        var conflict = currentMeta.revision !== normalizeRevision(token.revision);
        if (conflict && !(commitOptions && commitOptions.rebase === true)) {
          return {
            ok: false,
            reason: 'revision_conflict',
            expectedRevision: token.revision,
            actualRevision: currentMeta.revision
          };
        }
        var queueMutations = normalizeQueueMutations(commitOptions);
        if (queueMutations.length
          && currentMeta.queueRevision !== normalizeRevision(token.queueRevision)) {
          if (!token.detached && isCurrent(token)) {
            active = makeToken(
              scope,
              token.generation,
              currentMeta.revision,
              false,
              currentMeta.queueRevision
            );
          }
          return {
            ok: false,
            reason: 'queue_revision_conflict',
            expectedRevision: token.queueRevision,
            actualRevision: currentMeta.queueRevision,
            actualStateRevision: currentMeta.revision
          };
        }
        var projected = applyQueueMutations(currentMeta, queueMutations, writerId);
        if (!projected.ok) return projected;
        var nextMeta = {
          ...projected.meta,
          revision: currentMeta.revision + 1,
          writerId: writerId,
          updatedAt: new Date().toISOString(),
          sessionTombstones: mergeTombstones(
            projected.meta.sessionTombstones,
            commitOptions && commitOptions.sessionTombstones,
            200
          )
        };
        await adapter.write(scope, nextMeta);
        if (!token.detached && isCurrent(token)) {
          active = makeToken(
            scope,
            token.generation,
            nextMeta.revision,
            false,
            nextMeta.queueRevision
          );
        }
        var value;
        try {
          value = await action({
            scope: scope,
            baseRevision: currentMeta.revision,
            conflict: conflict,
            writerId: writerId,
            currentMeta: currentMeta,
            nextMeta: nextMeta
          });
        } catch (error) {
          if (queueMutations.some(function (mutation) {
            return ['remove', 'release', 'restore'].includes(cleanPart(mutation.type));
          })) {
            var recoveredMeta = {
              ...currentMeta,
              revision: nextMeta.revision + 1,
              queueRevision: nextMeta.queueRevision + 1,
              writerId: writerId,
              updatedAt: new Date().toISOString()
            };
            try {
              await adapter.write(scope, recoveredMeta);
              if (!token.detached && isCurrent(token)) {
                active = makeToken(
                  scope,
                  token.generation,
                  recoveredMeta.revision,
                  false,
                  recoveredMeta.queueRevision
                );
              }
            } catch (recoveryError) {
              if (error && typeof error === 'object') {
                error.persistenceRecoveryError = recoveryError.message || String(recoveryError);
              }
            }
          }
          throw error;
        }
        return {
          ok: true,
          value: value,
          revision: nextMeta.revision,
          queueRevision: nextMeta.queueRevision,
          queueClaims: nextMeta.queueClaims,
          rebased: conflict,
          superseded: !token.detached && !isCurrent(token)
        };
      });
    }

    return Object.freeze({
      beginHydration: beginHydration,
      captureCommitView: captureCommitView,
      commit: commit,
      getActiveView: function () {
        return active
          ? makeToken(active, active.generation, active.revision, false, active.queueRevision)
          : null;
      },
      getWriterId: function () { return writerId; },
      invalidate: function () {
        generation += 1;
        active = null;
      },
      isCurrent: isCurrent
    });
  }

  function makeToken(scope, tokenGeneration, revision, detached, queueRevision) {
    return Object.freeze({
      accountScopeId: scope.accountScopeId,
      projectId: scope.projectId,
      generation: normalizeRevision(tokenGeneration),
      revision: normalizeRevision(revision),
      queueRevision: normalizeRevision(queueRevision),
      detached: detached === true
    });
  }

  async function strictRead(adapter, scope) {
    return normalizeMeta(await adapter.read(scope));
  }

  function randomId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'writer-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  return Object.freeze({
    createBrowserAdapter: createBrowserAdapter,
    createCoordinator: createCoordinator,
    createQueueClaim: createQueueClaim,
    isClaimCurrent: isClaimCurrent,
    mergeTombstones: mergeTombstones,
    normalizeScope: normalizeScope,
    sameScope: sameScope,
    scopeKey: scopeKey
  });
});
