(function initContextUsage(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexOverleafModuleRegistry.define('ContextUsage', [], factory);
})(typeof globalThis !== 'undefined' ? globalThis : window, function contextUsageFactory() {
  'use strict';

  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const identity = value => typeof value === 'string' && value.trim() && value.length <= 512
    && !/[\0\r\n]/.test(value) ? value.trim() : '';
  const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString() : '';

  // Store a bounded fact from one model response, never the cumulative billed
  // token total. The last reported response is an estimate of context occupancy;
  // tool output added since then is not included until the next server update.
  function normalize(value) {
    if (!value || value.v !== 1) return null;
    const threadId = identity(value.threadId), turnId = identity(value.turnId);
    const runId = identity(value.runId), providerId = identity(value.providerId), model = identity(value.model);
    const usedTokens = count(value.usedTokens), providerRevision = count(value.providerRevision);
    const observedAt = timestamp(value.observedAt);
    if (!threadId || !turnId || !runId || !providerId || !model || usedTokens === null
      || providerRevision === null || !observedAt) return null;
    const capacity = count(value.contextWindow);
    const eventSeq = count(value.eventSeq);
    return { v: 1, threadId, turnId, runId, providerId, providerRevision, model,
      usedTokens, contextWindow: capacity > 0 ? capacity : null,
      eventSeq: eventSeq > 0 ? eventSeq : null, observedAt };
  }

  function matches(value, scope = {}) {
    const snapshot = normalize(value);
    return Boolean(snapshot && snapshot.threadId === identity(scope.threadId || scope.codexThreadId)
      && snapshot.providerId === identity(scope.providerId)
      && snapshot.providerRevision === count(scope.providerRevision)
      && snapshot.model === identity(scope.model));
  }

  // The caller supplies the captured run owner, after its Native thread/turn
  // binding is known. Reject worker, previous-turn and unbound notifications.
  function fromEvent(event, owner = {}) {
    if (!event || (event.type && event.type !== 'codex.session.event') || event.subagent === true) return null;
    const notification = event.detail || event;
    if (notification.method !== 'thread/tokenUsage/updated') return null;
    const params = notification.params || {};
    const threadId = identity(params.threadId), turnId = identity(params.turnId);
    if (!threadId || !turnId || threadId !== identity(owner.threadId || owner.codexThreadId)
      || turnId !== identity(owner.turnId || owner.codexTurnId) || owner.forkSnapshot === true) return null;
    const usedTokens = count(params.tokenUsage?.last?.totalTokens);
    if (usedTokens === null) return null;
    return normalize({ v: 1, threadId, turnId, runId: owner.runId || owner.id,
      providerId: owner.providerId, providerRevision: owner.providerRevision, model: owner.model,
      usedTokens, contextWindow: params.tokenUsage?.modelContextWindow,
      eventSeq: event.nativeEventSeq ?? event.eventSeq ?? event.seq ?? owner.eventSeq,
      observedAt: timestamp(event.timestamp || event.at) || timestamp(owner.observedAt) || new Date().toISOString() });
  }

  function isNewer(next, previous) {
    next = normalize(next); previous = normalize(previous);
    if (!next) return false;
    if (!previous) return true;
    if (next.runId === previous.runId && next.threadId === previous.threadId && next.turnId === previous.turnId
      && next.eventSeq !== null && previous.eventSeq !== null)
      return next.eventSeq > previous.eventSeq;
    return Date.parse(next.observedAt) > Date.parse(previous.observedAt);
  }

  function select(session, scope = {}) {
    if (!session || session.forkSnapshot === true) return null;
    const inThread = value => value && value.threadId === identity(scope.threadId || scope.codexThreadId)
      && value.providerId === identity(scope.providerId)
      && value.providerRevision === count(scope.providerRevision);
    let selected = normalize(session.contextUsage);
    if (!inThread(selected)) selected = null;
    for (const run of Array.isArray(session.runs) ? session.runs : []) {
      if (run?.forkSnapshot === true) continue;
      const candidate = normalize(run.contextUsage);
      if (!inThread(candidate) || candidate.runId !== run.id) continue;
      if (isNewer(candidate, selected)) selected = candidate;
    }
    // A later turn can grow this thread using another model. Selecting an older
    // model again must not resurrect its obsolete, smaller context estimate.
    return selected?.model === identity(scope.model) ? selected : null;
  }

  return { normalize, fromEvent, matches, isNewer, select };
});
