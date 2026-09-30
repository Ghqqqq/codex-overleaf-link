(function initChangeHistoryModel(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./settlementFacts'), require('./sessionState'));
  } else root.CodexOverleafModuleRegistry.define('ChangeHistoryModel', ['SettlementFacts', 'SessionState'], factory);
})(typeof globalThis !== 'undefined' ? globalThis : window, function changeHistoryModelFactory(SettlementFacts, SessionState) {
  'use strict';
  const array = value => Array.isArray(value) ? value : [];
  const text = value => typeof value === 'string' ? value : '';
  const opaque = value => /^\[.*(?:omitted|redacted|chars=\d+|hash=).*?\]$/i.test(text(value).trim());

  function project(records, options = {}) {
    const { projectId, accountScopeId } = options;
    if (!projectId || !accountScopeId) return [];
    const sanitize = options.sanitizeText || text;
    const safe = value => text(sanitize(text(value))).trim();
    const sessions = new Map();
    const live = new Map();
    for (const session of array(options.storedSessions)) {
      if (session?.projectId === projectId && session.accountScopeId === accountScopeId) sessions.set(session.id, session);
    }
    // In-memory sessions already passed the runtime's account/project hydrate
    // boundary. Their review state is newer than the persisted audit snapshot.
    for (const session of array(options.sessions)) {
      if (!session?.id) continue;
      const prior = sessions.get(session.id);
      const runs = new Map(array(prior?.runs).map(run => [run.id, run]));
      const current = session.id === options.activeSessionId ? array(options.activeRuns) : array(session.runs);
      for (const run of current) if (run?.id) runs.set(run.id, run);
      sessions.set(session.id, { ...prior, ...session, runs: [...runs.values()] });
      live.set(session.id, new Set(current.filter(run => run?.id && (!run.runProjectId || run.runProjectId === projectId)).map(run => run.id)));
    }
    function path(value) {
      const raw = text(value).replace(/\\/g, '/').replace(/^\.\//, '');
      if (/(^|\/)\.codex-overleaf-(subagents|attachments)(\/|$)/.test(raw)) return '';
      const result = safe(raw);
      if (!result || /^\[.*\]$/.test(result)) return '';
      return result.slice(0, 320);
    }
    const seen = new Set();
    return array(records).filter(record => record?.projectId === projectId
      && (!record.accountScopeId || record.accountScopeId === accountScopeId)
      && sessions.has(record.sessionId))
      .slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .filter(record => {
        const key = JSON.stringify([record.sessionId, record.turnId || record.id]);
        if (seen.has(key)) return false;
        seen.add(key); return true;
      }).slice(0, 50).map(record => {
        const session = sessions.get(record.sessionId);
        const candidate = array(session.runs).find(run => run.id === record.turnId);
        const run = candidate && (!candidate.runProjectId || candidate.runProjectId === projectId) ? candidate : null;
        const facts = SettlementFacts.compactSettlementFacts(run?.settlement || run?.settlementFacts || {});
        const projection = run ? SettlementFacts.projectRunSettlement(run) : null;
        const applied = array(record.appliedFiles).filter(file => path(typeof file === 'string' ? file : file?.path));
        const review = text(run?.trackedChangeStatus);
        const hasWrites = applied.length > 0 || run?.changedDocument === true
          || ['changed', 'possibly-changed'].includes(facts.documentEffect)
          || ['pending', 'accepted', 'rejected', 'needs_review'].includes(review)
          || run?.undoStatus === 'applied';
        let files = applied.slice();
        files.push(...facts.fileSettlements.filter(file => ['complete', 'partial'].includes(file.applied)
          || ['changed', 'possibly-changed'].includes(file.documentEffect)));
        if (!files.length && hasWrites) files = array(record.changedFiles);
        const paths = [...new Set(files.flatMap(file => typeof file === 'string'
          ? [path(file)] : [path(file?.path), path(file?.destinationPath)]).filter(Boolean))];
        const unsafeSave = record.saveVerification?.ok === false
          || ['failed', 'unavailable'].includes(record.saveVerification?.state);
        let status;
        if (review === 'accepted') status = 'accepted';
        else if (review === 'rejected' || run?.undoStatus === 'applied') status = 'undone';
        else if (review === 'needs_review' || projection?.terminalState === 'needs_review'
          || facts.documentEffect === 'possibly-changed'
          || ['partial', 'needs-review'].includes(facts.evidence.settled)
          || hasWrites && (unsafeSave || ['failed', 'interrupted', 'needs_review_after_navigation'].includes(run?.status))) status = 'attention';
        else if (run?.status === 'running' || record.resultStatus === 'draft' && !record.completedAt) status = 'running';
        else if (review === 'pending') status = 'pending';
        else if (!hasWrites) status = 'unchanged';
        else status = run ? 'written' : 'unknown';
        const suppliedSummary = safe(run?.safeTaskSummary || '');
        const summary = suppliedSummary && !opaque(suppliedSummary)
          ? SessionState.computeSafeTaskSummary(suppliedSummary) : '';
        // Audit promptSummary deliberately stores a privacy marker. Never
        // recover it, render it, or turn it into an apparent task summary.
        return {
          key: JSON.stringify([record.sessionId, record.turnId || record.id]),
          projectId, accountScopeId, sessionId: record.sessionId, turnId: record.turnId,
          createdAt: text(record.createdAt), paths, hasWrites, status, summary,
          operation: paths.length === 1 ? text(files[0]?.type) : '',
          canJump: Boolean(run && live.get(record.sessionId)?.has(record.turnId))
        };
      });
  }
  return { project };
});
