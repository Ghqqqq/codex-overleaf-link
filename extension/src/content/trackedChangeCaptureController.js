(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafTrackedChangeCaptureController = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  function create(deps = {}) {
    const now = deps.now || (() => Date.now());
    const defer = deps.setTimeout || setTimeout;
    const cancelTimer = deps.clearTimeout || clearTimeout;
    let timer = null, busy = false, disposed = false;
    const runs = () => deps.getRuns() || [];
    const mergedRecovery = capture => capture?.source === 'native'
      && capture.state === 'needs_review' && ['capture_timeout', 'capture_expired'].includes(capture.reason);
    const pending = run => Array.isArray(run.trackedChangeCaptures)
      && run.trackedChangeCaptures.some(capture => capture.state === 'pending' || mergedRecovery(capture));
    const terminal = run => ['accepted', 'rejected'].includes(run.trackedChangeStatus)
      || run.undoStatus === 'applied' || run.forkSnapshot === true;
    function buildPostFiles(run) {
      const expectedFiles = Array.isArray(run?.undoExpectedFiles) ? run.undoExpectedFiles : [];
      const appliedOperations = Array.isArray(run?.appliedOperations) ? run.appliedOperations : [];
      if (!expectedFiles.length || !appliedOperations.length) return [];
      const postFilesByPath = deps.buildExpectedFilesAfterOperations({ files: expectedFiles }, appliedOperations);
      const expectedPaths = new Set(expectedFiles.map(file => file?.path).filter(Boolean));
      return Array.from(postFilesByPath.entries())
        .filter(([path, content]) => expectedPaths.has(path) && typeof content === 'string')
        .map(([path, content]) => ({ path, content }));
    }
    function hasLegacyUntrackedCheckpoint(run) {
      if (!run || run.executionSnapshot || run.trackedChangeStatus || run.undoStatus === 'applied'
        || run.forkSnapshot || run.undoTrackedChanges?.length || run.trackedChangeCaptures?.length) return false;
      const operations = Array.isArray(run.undoOperations) ? run.undoOperations : [];
      const before = Array.isArray(run.undoExpectedFiles) ? run.undoExpectedFiles : [];
      if (!operations.length || !before.length || before.some(file => !file?.path || typeof file.content !== 'string')) return false;
      const paths = new Set(before.map(file => file.path));
      if (paths.size !== before.length || operations.some(op => op?.type !== 'edit' || !paths.has(op.path))) return false;
      const complete = files => Array.isArray(files) && files.length === paths.size
        && new Set(files.map(file => file?.path)).size === paths.size
        && files.every(file => paths.has(file?.path) && typeof file.content === 'string');
      const storedPost = run.undoBaseFiles;
      try {
        const post = buildPostFiles(run);
        if (!complete(storedPost) || !complete(post)) return false;
        const postByPath = new Map(post.map(file => [file.path, file.content]));
        if (!storedPost.every(file => postByPath.get(file.path) === file.content)) return false;
        const restored = deps.buildExpectedFilesAfterOperations({ files: storedPost }, operations);
        // A legacy checkpoint must prove both directions; empty refs alone grant nothing.
        return before.every(file => restored.get(file.path) === file.content);
      } catch (_error) { return false; }
    }
    function schedule() {
      if (disposed || timer !== null || busy || !runs().some(pending)) return;
      timer = defer(() => {
        timer = null;
        flush().catch(error => deps.onError?.(error));
      }, 500);
    }
    function record(run, captures) {
      if (!Array.isArray(captures) || !captures.length) return;
      const next = [...(run.trackedChangeCaptures || []), ...captures.filter(Boolean)];
      if (next.every(capture => capture.state === 'observed')) return;
      run.trackedChangeCaptures = next;
      deps.notify?.(run, next.some(capture => capture.state === 'pending') ? 'pending' : 'needs_review', {
        captures: next.map(capture => ({ path: capture.path, reason: capture.reason, ...capture.diagnostics }))
      });
      deps.persist().then(schedule).catch(error => deps.onError?.(error));
    }
    async function flush() {
      if (disposed || busy) return;
      busy = true;
      try {
        for (const run of runs().filter(pending)) {
          if (terminal(run)) { run.trackedChangeCaptures = []; await deps.persist(); continue; }
          if (run.runProjectId !== deps.getProjectId()) continue;
          const newer = runs().some(other => other.id !== run.id
            && other.runProjectId === run.runProjectId
            && Date.parse(other.startedAt) > Date.parse(run.startedAt));
          const original = run.trackedChangeCaptures;
          const captures = original.map(capture => ({ ...capture }));
          const postFiles = buildPostFiles(run);
          for (let i = 0; i < captures.length; i++) {
            const capture = captures[i];
            const recoverMerged = mergedRecovery(capture);
            if (capture.state !== 'pending' && !recoverMerged) continue;
            const expected = postFiles.find(file => file.path === capture.path);
            if (newer || !expected || (!recoverMerged && now() >= capture.expiresAt) || run.status === 'cancelled') {
              capture.state = 'needs_review';
              capture.reason = newer ? 'capture_superseded' : !expected ? 'capture_baseline_missing'
                : run.status === 'cancelled' ? 'capture_cancelled' : 'capture_expired';
              continue;
            }
            let response;
            try {
              response = await deps.callPageBridge('reconcileTrackedChangeCapture', {
                runProjectId: run.runProjectId, capture, expectedContent: expected.content
              });
            } catch (_error) {
              response = null;
            }
            // Never patch a superseded hydrated record or another project's state.
            if (disposed || deps.getProjectId() !== run.runProjectId
              || !runs().includes(run) || terminal(run) || run.trackedChangeCaptures !== original) return;
            const superseded = runs().some(other => other.id !== run.id
              && other.runProjectId === run.runProjectId
              && Date.parse(other.startedAt) > Date.parse(run.startedAt));
            if (superseded || run.status === 'cancelled') {
              captures[i] = { ...capture, state: 'needs_review', reason: 'capture_superseded' };
            } else if (response?.capture?.path === capture.path
              && response.capture.runProjectId === run.runProjectId
              && ['observed', 'pending', 'needs_review'].includes(response.capture.state)) {
              captures[i] = response.capture;
            } else {
              captures[i] = { ...capture, state: 'needs_review', reason: 'capture_bridge_unavailable' };
            }
          }
          if (!runs().includes(run) || terminal(run) || deps.getProjectId() !== run.runProjectId) continue;
          if (captures.length && captures.every(capture => capture.state === 'observed')) {
            const refs = deps.normalizeTrackedChanges([
              ...(run.undoTrackedChanges || []), ...captures.flatMap(capture => capture.refs || [])
            ]);
            if (refs.length) {
              run.undoTrackedChanges = refs;
              run.trackedChangeStatus = 'pending';
              run.trackedChangeCaptures = [];
              await deps.persist();
              deps.refresh(run);
              deps.notify?.(run, 'observed', { count: refs.length });
              continue;
            }
          }
          const changed = JSON.stringify(original.map(summary)) !== JSON.stringify(captures.map(summary));
          if (changed) {
            run.trackedChangeCaptures = captures;
            await deps.persist();
            deps.refresh?.(run);
            if (!pending(run)) deps.notify?.(run, 'needs_review', {
              reasons: captures.filter(capture => capture.state !== 'observed').map(capture => capture.reason)
            });
          }
        }
      } finally {
        busy = false;
        if (runs().some(run => pending(run) && run.runProjectId === deps.getProjectId())) schedule();
      }
    }
    function summary(capture) {
      return { state: capture.state, reason: capture.reason, refs: (capture.refs || []).map(ref => ref.key) };
    }
    function dispose() {
      disposed = true;
      if (timer !== null) cancelTimer(timer);
      timer = null;
    }
    return { record, schedule, flush, dispose, buildPostFiles, hasLegacyUntrackedCheckpoint };
  }
  return { create };
});
