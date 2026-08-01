(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafScopedPersistenceQueuePolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createQueueClaim(input) {
    return Object.freeze({
      itemId: cleanPart(input && input.itemId),
      ownerId: cleanPart(input && input.ownerId),
      queueRevision: normalizeRevision(input && input.queueRevision),
      claimedAt: cleanPart(input && input.claimedAt) || new Date().toISOString()
    });
  }

  function isClaimCurrent(claim, queueState) {
    return Boolean(claim && queueState
      && cleanPart(claim.itemId) === cleanPart(queueState.itemId)
      && cleanPart(claim.ownerId) === cleanPart(queueState.ownerId)
      && normalizeRevision(claim.queueRevision) === normalizeRevision(queueState.queueRevision));
  }

  function mergeTombstones(existing, additions, limit) {
    var result = Object.assign({}, existing && typeof existing === 'object' ? existing : {});
    var now = new Date().toISOString();
    (Array.isArray(additions) ? additions : []).forEach(function (id) {
      var cleanId = cleanPart(id);
      if (cleanId) result[cleanId] = now;
    });
    var max = Number.isFinite(Number(limit)) ? Math.max(1, Number(limit)) : 100;
    return Object.fromEntries(Object.entries(result)
      .sort(function (left, right) { return String(right[1]).localeCompare(String(left[1])); })
      .slice(0, max));
  }

  function normalizeMeta(value) {
    var revision = normalizeRevision(value && value.revision);
    var hasDurableRevision = Boolean(value
      && Object.prototype.hasOwnProperty.call(value, 'durableRevision'));
    var durableRevision = hasDurableRevision
      ? Math.min(normalizeRevision(value.durableRevision), revision)
      : revision;
    var pendingValue = value && value.pendingCommit;
    var pendingRevision = normalizeRevision(pendingValue && pendingValue.revision);
    var pendingCommit = pendingValue && typeof pendingValue === 'object'
      && pendingRevision > durableRevision
      && pendingRevision <= revision
      ? {
          revision: pendingRevision,
          writerId: cleanPart(pendingValue.writerId),
          startedAt: cleanPart(pendingValue.startedAt)
        }
      : null;
    return {
      revision: revision,
      durableRevision: durableRevision,
      pendingCommit: pendingCommit,
      queueRevision: normalizeRevision(value && value.queueRevision),
      writerId: cleanPart(value && value.writerId),
      updatedAt: cleanPart(value && value.updatedAt),
      queueClaims: normalizeQueueClaims(value && value.queueClaims),
      queueTombstones: normalizeTombstoneMap(value && value.queueTombstones),
      sessionTombstones: normalizeTombstoneMap(value && value.sessionTombstones)
    };
  }

  function normalizeQueueMutations(options) {
    var values = [];
    if (options && options.queueMutation) values.push(options.queueMutation);
    if (options && Array.isArray(options.queueMutations)) values.push.apply(values, options.queueMutations);
    return values.filter(function (value) {
      return value && typeof value === 'object' && cleanPart(value.type);
    });
  }

  function applyQueueMutations(meta, mutations, writerId) {
    var next = normalizeMeta(meta);
    for (var mutation of mutations) {
      var type = cleanPart(mutation.type);
      var itemId = cleanPart(mutation.itemId);
      var sessionId = cleanPart(mutation.sessionId);
      if (!itemId && type !== 'transition') {
        return { ok: false, reason: 'invalid_queue_mutation' };
      }
      if (type === 'remove' || type === 'release' || type === 'restore') {
        var claimed = next.queueClaims[itemId];
        var mutationToken = cleanPart(mutation.claimToken);
        if (claimed && !isExpiredClaim(claimed)
          && (claimed.ownerId !== writerId
            || !mutationToken
            || claimed.claimToken !== mutationToken)) {
          return {
            ok: false,
            reason: 'queue_claim_conflict',
            ownerId: claimed.ownerId,
            itemId: itemId
          };
        }
      }
      if (type === 'claim') {
        var existing = next.queueClaims[itemId];
        if (existing && existing.ownerId !== writerId && !isExpiredClaim(existing)) {
          return {
            ok: false,
            reason: 'queue_claim_conflict',
            ownerId: existing.ownerId,
            itemId: itemId
          };
        }
        next.queueRevision += 1;
        next.queueClaims[itemId] = {
          ...createQueueClaim({
            itemId: itemId,
            ownerId: writerId,
            queueRevision: next.queueRevision
          }),
          sessionId: sessionId,
          claimToken: cleanPart(mutation.claimToken)
        };
        continue;
      }
      if (type === 'remove') {
        next.queueRevision += 1;
        next.queueTombstones = mergeTombstones(next.queueTombstones, [itemId], 500);
        delete next.queueClaims[itemId];
        continue;
      }
      if (type === 'release') {
        next.queueRevision += 1;
        delete next.queueClaims[itemId];
        continue;
      }
      if (type === 'restore') {
        next.queueRevision += 1;
        delete next.queueClaims[itemId];
        delete next.queueTombstones[itemId];
        continue;
      }
      if (type === 'enqueue' || type === 'transition') {
        next.queueRevision += 1;
        continue;
      }
      return { ok: false, reason: 'invalid_queue_mutation' };
    }
    return { ok: true, meta: next };
  }

  function normalizeQueueClaims(value) {
    var source = value && typeof value === 'object' ? value : {};
    var result = {};
    Object.entries(source).forEach(function (entry) {
      var itemId = cleanPart(entry[0]);
      var claim = entry[1] && typeof entry[1] === 'object' ? entry[1] : {};
      var ownerId = cleanPart(claim.ownerId);
      if (!itemId || !ownerId) return;
      result[itemId] = {
        itemId: itemId,
        ownerId: ownerId,
        sessionId: cleanPart(claim.sessionId),
        claimToken: cleanPart(claim.claimToken),
        queueRevision: normalizeRevision(claim.queueRevision),
        claimedAt: cleanPart(claim.claimedAt)
      };
    });
    return result;
  }

  function normalizeTombstoneMap(value) {
    var source = value && typeof value === 'object' ? value : {};
    return Object.fromEntries(Object.entries(source)
      .map(function (entry) { return [cleanPart(entry[0]), cleanPart(entry[1])]; })
      .filter(function (entry) { return entry[0] && entry[1]; }));
  }

  function isExpiredClaim(claim, now) {
    var claimedAt = Date.parse(claim && claim.claimedAt || '');
    return !claimedAt || (Number(now || Date.now()) - claimedAt) > 60 * 1000;
  }

  function normalizeRevision(value) {
    var number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
  }

  function cleanPart(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  return Object.freeze({
    applyQueueMutations: applyQueueMutations,
    cleanPart: cleanPart,
    createQueueClaim: createQueueClaim,
    isClaimCurrent: isClaimCurrent,
    mergeTombstones: mergeTombstones,
    normalizeMeta: normalizeMeta,
    normalizeQueueMutations: normalizeQueueMutations,
    normalizeRevision: normalizeRevision
  });
});
