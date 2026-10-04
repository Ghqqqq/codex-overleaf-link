(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafReviewContext = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // One context per request. The small response reserve lets an expired review
  // return its known partial evidence before the caller's transport timer fires.
  function create(deps, input = {}) {
    const now = deps.now || Date.now;
    const timers = typeof deps.window?.setTimeout === 'function' ? deps.window : globalThis;
    const started = now(), limit = input.deadlineAt == null ? started + 120000 : input.deadlineAt;
    const deadlineAt = Number.isFinite(limit) ? limit - Math.min(250, Math.max(0, limit - started) / 10) : started;
    const cancellation = deps.readWriteCancellationSequence?.();
    const appliedLists = new Set(), observations = new Map();
    let stopped = null, mutationStarted = false;
    const params = { ...input, deadlineAt };
    const failure = (code, reason) => ({ ok: false, code, reason, changedDocument: false,
      failure: { code: code === 'codex_cancelled' ? 'codex_run_cancelled' : 'tracked_changes_remain',
        stage: 'reviewing', severity: 'blocked', terminalState: 'blocked', changedDocument: false,
        userMessage: reason, nextAction: 'Check the retained per-file results in Overleaf before retrying.',
        evidence: { originalCode: code, writeStarted: false } } });
    function check() {
      if (stopped) return stopped;
      if (!Number.isFinite(limit) || now() >= deadlineAt)
        return stopped = failure('writeback_deadline_exceeded', 'The review time budget expired; no further review writes were started.');
      if (typeof deps.readWriteCancellationSequence === 'function' && deps.readWriteCancellationSequence() !== cancellation)
        return stopped = failure('codex_cancelled', 'The review was cancelled; no further review writes were started.');
      const project = deps.getProjectId?.() || /\/project\/([^/?#]+)/.exec(deps.window?.location?.pathname || '')?.[1];
      if (!params.runProjectId || (project && project !== params.runProjectId))
        return stopped = failure('aborted_project_changed', 'The original review project is no longer active.');
      const blocked = deps.checkWritebackRunProjectId?.(params);
      if (blocked) return stopped = blocked.skipped?.[0]?.result || blocked;
      return null;
    }
    function assert() {
      const blocked = check();
      if (blocked) throw Object.assign(new Error(blocked.reason || blocked.code), { reviewFailure: blocked });
    }
    async function wait(work) {
      assert();
      let timer;
      try {
        const timeout = new Promise((_, reject) => {
          timer = timers.setTimeout(() => {
            const blocked = check() || failure('writeback_deadline_exceeded', 'The review time budget expired.');
            stopped = blocked;
            reject(Object.assign(new Error(blocked.reason), { reviewFailure: blocked }));
          }, Math.max(0, deadlineAt - now()));
        });
        const result = await Promise.race([Promise.resolve().then(() => { assert(); return work(); }), timeout]);
        assert();
        return result;
      } finally { if (timer != null) timers.clearTimeout(timer); }
    }
    const remember = entry => {
      if (entry.result?.changedDocument === true || entry.result?.failure?.changedDocument === true) mutationStarted = true;
      const ref = entry.trackedChange || { path: entry.operation?.path || '', key: 'snapshot-undo:' + (entry.operation?.path || ''), id: '' };
      observations.set(ref.path + '\0' + (ref.key || ref.id || ''), { trackedChange: ref, result: entry.result });
    };
    const scoped = { ...deps, reviewGuard: check, reviewAwait: work => wait(work),
      reviewDeadlineAt: deadlineAt,
      createReviewApplied() { const list = []; appliedLists.add(list); return list; } };
    for (const name of ['openFileByPath', 'setReviewingEnabled', 'verifyActiveEditorText']) {
      if (typeof deps[name] === 'function') scoped[name] = (...args) => wait(() => deps[name](...args));
    }
    scoped.delay = ms => wait(() => deps.delay(Math.min(ms, Math.max(0, deadlineAt - now()))));
    if (typeof deps.readActiveEditorText === 'function') scoped.readActiveEditorText = (...args) => { assert(); return deps.readActiveEditorText(...args); };
    if (typeof deps.clickNode === 'function') scoped.clickNode = (...args) => { assert(); mutationStarted = true; return deps.clickNode(...args); };
    for (const name of ['applyOperationsCore', 'applyOperationsWithNoTraceUndo']) {
      if (typeof deps[name] !== 'function') continue;
      scoped[name] = async (operations, options = {}) => {
        assert();
        const result = await deps[name](operations, { ...options, deadlineAt,
          reviewGuard: check, reviewAwait: work => wait(work),
          onOperationResult(entry) { remember(entry); options.onOperationResult?.(entry); } });
        for (const entry of result.applied || []) remember(entry);
        // Preserve a completed in-flight result even if cancellation just arrived.
        return result;
      };
    }
    if (typeof deps.confirmReviewWriteback === 'function') scoped.confirmReviewWriteback = async (original, result) => {
      for (const entry of result.applied || []) remember(entry);
      return deps.confirmReviewWriteback({ ...original, deadlineAt, reviewGuard: check, reviewAwait: work => wait(work) }, result);
    };
    async function run(work) {
      try { assert(); return await work(scoped, params); }
      catch (error) {
        if (!error?.reviewFailure) throw error;
        for (const list of appliedLists) for (const entry of list) remember(entry);
        const applied = [...observations.values()].filter(entry => entry.result?.ok !== false);
        const path = deps.getActiveFilePath?.() || '';
        const changedDocument = mutationStarted || applied.some(entry => entry.result?.changedDocument !== false);
        const blocked = { ...error.reviewFailure, changedDocument,
          failure: { ...error.reviewFailure.failure, changedDocument,
            evidence: { ...error.reviewFailure.failure?.evidence, writeStarted: changedDocument } } };
        return { ok: false, applied, skipped: [{ trackedChange: { path }, result: blocked }] };
      }
    }
    return Object.freeze({ run, check, assert, wait, params, scoped });
  }
  return Object.freeze({ create });
});
