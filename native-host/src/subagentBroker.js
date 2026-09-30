'use strict';

// Parallel-subagents broker (v1.6, spec: docs/superpowers/specs/
// 2026-06-10-v1.6-parallel-subagents-design.md).
//
// The sandboxed model cannot spawn processes (Seatbelt kills nested Codex at
// client init — verified empirically), but it CAN write workspace files. The
// broker runs in the native host (outside the sandbox), watches a file-based
// job queue inside the mirror workspace, and fans each accepted job out to a
// real sibling Codex run via an injected `runWorkerTask`. Ownership of files
// is disjoint by protocol; violations are attributed at wave level and the
// runner hard-blocks them from writeback (spec S5/S8).
//
// Everything time- or process-shaped is injectable so the unit suite can run
// with fake workers and millisecond limits.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { SUBAGENT_QUEUE_DIR } = require('./mirrorWorkspace');
const { safeWorkspaceRelativePath } = require('./subagentWorkspacePath');
const { compactEvent, publicText } = require('./subagentTelemetry');
const { createSubagentWorkspace } = require('./subagentWorkspace');

const PROTOCOL_VERSION = 1;
const JOB_ID_PATTERN = /^[a-z0-9-]{1,32}$/;
const MAX_JOB_FILE_BYTES = 32 * 1024;
const SUMMARY_LIMIT_CHARS = 2048;

const DEFAULT_LIMITS = Object.freeze({
  maxWorkers: 3,
  maxJobsPerRun: 8,
  perWorkerTimeoutMs: 600000,
  brokerBudgetMs: 1800000,
  pollIntervalMs: 500,
  drainGraceMs: 30000
});

function createSubagentBroker(options = {}) {
  const workspacePath = options.workspacePath;
  if (!workspacePath) {
    throw new Error('subagent broker requires a workspacePath');
  }
  const runWorkerTask = options.runWorkerTask;
  if (typeof runWorkerTask !== 'function') {
    throw new Error('subagent broker requires a runWorkerTask function');
  }
  const emit = typeof options.emit === 'function' ? options.emit : () => {};
  const onMirrorDirty = typeof options.onMirrorDirty === 'function' ? options.onMirrorDirty : () => {};
  const parentSignal = options.signal || null;
  const env = options.env || process.env;
  const boundedMs = (value, fallback, max) => Number.isFinite(Number(value)) && Number(value) > 0
    ? Math.min(max, Math.max(60000, Number(value))) : fallback;
  const limits = { ...DEFAULT_LIMITS,
    perWorkerTimeoutMs: boundedMs(env.CODEX_OVERLEAF_SUBAGENT_TIMEOUT_MS, DEFAULT_LIMITS.perWorkerTimeoutMs, 900000),
    brokerBudgetMs: boundedMs(env.CODEX_OVERLEAF_SUBAGENT_BUDGET_MS, DEFAULT_LIMITS.brokerBudgetMs, 3600000),
    ...(options.limits || {}) };

  const queueRoot = path.join(workspacePath, SUBAGENT_QUEUE_DIR);
  const jobsDir = path.join(queueRoot, 'jobs');
  const resultsDir = path.join(queueRoot, 'results');
  const logsDir = path.join(queueRoot, 'logs');
  const { atomicWrite, appendLog, adoptionHash, hashWorkspace, hashPaths, buildWorkerPrompt } =
    createSubagentWorkspace({ workspacePath, logsDir });
  const adoptionsDir = path.join(queueRoot, 'adoptions');
  const adoptionResultsDir = path.join(queueRoot, 'adoption-results');
  const quarantined = new Map();
  const seenAdoptions = new Set();
  let adoptionToken = '';

  const jobs = new Map(); // id -> { job, status, startedAt, ownedBefore }
  const seenFiles = new Set();
  const violations = [];
  const violationPaths = new Set();
  let queued = [];
  let running = new Map(); // id -> { controller, deadlineTimer, promise }
  let acceptedCount = 0;
  let startedAt = 0;
  let accepting = false;
  let pollTimer = null;
  let waveIndex = 0;
  let waveSnapshot = null; // { hashes: Map(path->hash), ownedUnion: Set, jobIds: [] }
  let anyWorkerStarted = false;
  let cancelled = false;
  let closed = false;

  function start() {
    // Stale queue dirs from a previous run carry old results/logs — clear
    // them so the model never reads another run's state (spec S9).
    fs.rmSync(queueRoot, { recursive: true, force: true });
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(adoptionsDir, { recursive: true });
    fs.mkdirSync(adoptionResultsDir, { recursive: true });
    fs.mkdirSync(path.join(queueRoot, 'work'), { recursive: true });
    startedAt = Date.now();
    accepting = true;
    writeBrokerFile('ready');
    pollTimer = setInterval(pollOnce, limits.pollIntervalMs);
    if (parentSignal) {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  function writeBrokerFile(status) {
    const payload = {
      protocolVersion: PROTOCOL_VERSION,
      status,
      maxWorkers: limits.maxWorkers,
      maxJobsPerRun: limits.maxJobsPerRun,
      perWorkerTimeoutMs: limits.perWorkerTimeoutMs,
      brokerBudgetMs: limits.brokerBudgetMs,
      activeWorkers: running.size,
      adoptionToken,
      adoptionDirectory: 'adoptions',
      acceptedUntil: new Date(startedAt + limits.brokerBudgetMs - limits.perWorkerTimeoutMs).toISOString()
    };
    atomicWrite(path.join(queueRoot, 'broker.json'), JSON.stringify(payload, null, 2));
  }


  function pollOnce() {
    if (closed || cancelled) {
      return;
    }
    try {
      intakeJobs();
      fillSlots();
      processAdoptions();
    } catch (_error) {
      // The queue is adversarial model output; the broker never throws on it.
    }
  }

  function intakeJobs() {
    if (!accepting || !fs.existsSync(jobsDir)) {
      return;
    }
    for (const name of fs.readdirSync(jobsDir).sort()) {
      if (!name.endsWith('.json') || name.startsWith('.tmp-') || seenFiles.has(name)) {
        continue;
      }
      seenFiles.add(name);
      admitJobFile(name);
    }
  }

  function admitJobFile(name) {
    const filePath = path.join(jobsDir, name);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (_error) {
      return;
    }
    if (stat.size > MAX_JOB_FILE_BYTES) {
      return writeRejection({ id: idFromFileName(name), reason: 'job_too_large' });
    }
    let job;
    try {
      job = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_error) {
      return writeRejection({ id: idFromFileName(name), reason: 'invalid_json' });
    }
    const rejection = validateJob(job);
    if (rejection) {
      return writeRejection({ id: jobIdOrFallback(job, name), ...rejection });
    }
    acceptedCount += 1;
    jobs.set(job.id, { job, status: 'queued' });
    queued.push(job.id);
    emit('codex.subagent.queued', publicText(job.title || job.id, 160), {
      jobId: job.id, files: job.files, task: publicText(job.task, 4096)
    }, 'running');
  }

  function idFromFileName(name) {
    return name.replace(/\.json$/, '').slice(0, 32) || 'unknown';
  }

  function jobIdOrFallback(job, name) {
    return typeof job?.id === 'string' && job.id ? job.id.slice(0, 32) : idFromFileName(name);
  }

  function validateJob(job) {
    if (!job || typeof job !== 'object') {
      return { reason: 'invalid_json' };
    }
    if (typeof job.id !== 'string' || !JOB_ID_PATTERN.test(job.id)) {
      return { reason: 'invalid_id' };
    }
    if (jobs.has(job.id)) {
      return { reason: 'duplicate_id' };
    }
    if (acceptedCount >= limits.maxJobsPerRun) {
      return { reason: 'too_many_jobs' };
    }
    if (typeof job.task !== 'string' || !job.task.trim()) {
      return { reason: 'missing_task' };
    }
    if (!Array.isArray(job.files) || !job.files.length) {
      return { reason: 'missing_files' };
    }
    const owned = [];
    for (const file of job.files) {
      const safe = safeWorkspaceRelativePath(file);
      if (!safe) {
        return { reason: 'unsafe_path', path: String(file) };
      }
      if (!fs.existsSync(path.join(workspacePath, safe))) {
        return { reason: 'missing_file', path: safe };
      }
      owned.push(safe);
    }
    // Overlapping ownership no longer rejects: same-file jobs are admitted
    // and SERIALIZED by the scheduler (fillSlots never runs two jobs whose
    // files intersect). Prompt-scoped same-file delegation is then safe —
    // the physical lost-update race only exists under concurrency (v1.6.1).
    // Wave-aware admission: the parent turn has no default absolute deadline,
    // so the broker enforces its own wall-clock envelope across ALL waves.
    const projectedWaves = Math.ceil((queued.length + running.size + 1) / limits.maxWorkers);
    if (Date.now() + projectedWaves * limits.perWorkerTimeoutMs > startedAt + limits.brokerBudgetMs) {
      return { reason: 'insufficient_time' };
    }
    job.files = owned;
    job.readOnlyContext = Array.isArray(job.readOnlyContext)
      ? job.readOnlyContext.map(safeWorkspaceRelativePath).filter(Boolean)
      : [];
    return null;
  }


  function writeRejection(input) {
    const result = {
      id: input.id,
      status: 'rejected',
      reason: input.reason,
      path: input.path,
      conflictsWith: input.conflictsWith
    };
    writeResult(result);
    emit('codex.subagent.rejected', input.id, result, 'warning');
  }

  function writeResult(result) {
    atomicWrite(path.join(resultsDir, `${result.id}.json`), JSON.stringify(result, null, 2));
  }

  function fillSlots() {
    while (accepting && !cancelled && queued.length && running.size < limits.maxWorkers) {
      const runningFiles = new Set();
      for (const id of running.keys()) {
        for (const file of jobs.get(id).job.files) {
          runningFiles.add(file);
        }
      }
      // FIFO with skip: pick the first queued job whose ownership does not
      // intersect any running job's files — overlapping jobs wait their turn
      // (temporal exclusivity replaces the old overlap rejection).
      const index = queued.findIndex(id => !jobs.get(id).job.files.some(file => runningFiles.has(file)));
      if (index === -1) {
        return;
      }
      const [jobId] = queued.splice(index, 1);
      const entry = jobs.get(jobId);
      try {
        startWorker(entry);
      } catch (error) {
        // A job is spliced out of `queued` before it starts; if startWorker
        // throws it would vanish with no result, hanging a lead still polling
        // for its count. Emit a failed result so the poll loop can proceed.
        if (entry) {
          entry.status = 'failed';
        }
        appendLog(jobId, `start_failed: ${error?.stack || error?.message || String(error)}`);
        try {
          writeResult({ id: jobId, status: 'failed', reason: error?.message || 'subagent failed to start' });
        } catch (_writeError) { /* result dir may be gone */ }
        emit('codex.subagent.failed', publicText(entry?.job?.title || jobId, 160), {
          jobId, status: 'failed', reason: publicText(error?.message || 'subagent failed to start', 1200)
        }, 'warning');
      }
    }
  }

  function startWorker(entry) {
    const { job } = entry;
    if (running.size === 0) {
      beginWave();
    }
    anyWorkerStarted = true;
    entry.status = 'running';
    entry.startedAt = Date.now();
    entry.wave = waveIndex;
    entry.ownedBefore = hashPaths(job.files);
    waveSnapshot.jobIds.push(job.id);
    for (const file of job.files) {
      waveSnapshot.ownedUnion.add(file);
    }

    const controller = new AbortController();
    let timedOut = false;
    const deadlineTimer = setTimeout(() => {
      // Broker-owned wall-clock deadline (spec P1-5 fix): the runner's
      // absolute timeout is an opt-in env override and the idle watchdog
      // never fires on a chatty-but-stuck worker, so the broker is the only
      // component positioned to bound worker wall-clock time.
      timedOut = true;
      controller.abort(new Error('subagent timeout'));
    }, limits.perWorkerTimeoutMs);

    emit('codex.subagent.started', publicText(job.title || job.id, 160), {
      jobId: job.id,
      task: publicText(job.task, 4096),
      files: job.files,
      activeWorkers: running.size + 1,
      maxWorkers: limits.maxWorkers
    }, 'running');

    const promise = runWorkerTask({
      jobId: job.id,
      prompt: buildWorkerPrompt(job),
      signal: controller.signal,
      onEvent: event => {
        if (closed || entry.status !== 'running') return;
        try {
          const bounded = compactEvent(event);
          if (!bounded) return;
          const params = bounded.detail?.params || {};
          entry.threadId = bounded.detail?.threadId || params.threadId || params.thread?.id || entry.threadId || '';
          entry.sequence = (entry.sequence || 0) + 1;
          emit('codex.subagent.event', publicText(job.title || job.id, 160), {
            source: 'broker', jobId: job.id, threadId: entry.threadId,
            sequence: entry.sequence, event: bounded
          }, 'running');
        } catch (_error) { /* Observability must not fail or stop the worker. */ }
      }
    }).then(workerResult => {
      finishWorker(entry, {
        status: 'completed',
        summary: String(workerResult?.assistantMessage || '').slice(0, SUMMARY_LIMIT_CHARS),
        tokensUsed: workerResult?.tokensUsed
      }, workerResult);
    }).catch(error => {
      // Any broker-initiated abort that is not the wall-clock deadline
      // (parent cancel, drain) reads as 'cancelled'; only genuine worker
      // errors read as 'failed'.
      const status = timedOut ? 'timeout' : controller.signal.aborted ? 'cancelled' : 'failed';
      appendLog(job.id, `${status}: ${error?.stack || error?.message || String(error)}`);
      finishWorker(entry, { status, reason: error?.message || String(error) });
    }).finally(() => {
      clearTimeout(deadlineTimer);
      running.delete(job.id);
      if (running.size === 0) {
        endWave();
      }
      fillSlots();
    });

    running.set(job.id, { controller, deadlineTimer, promise });
  }

  function finishWorker(entry, resultFields, workerResult) {
    const { job } = entry;
    entry.status = resultFields.status;
    const ownedAfter = hashPaths(job.files);
    const changedFiles = job.files.filter(file => entry.ownedBefore.get(file) !== ownedAfter.get(file));
    if (resultFields.status !== 'completed' && changedFiles.length) {
      // A worker that did not finish cleanly (timeout / cancelled / failed)
      // may have left a half-written file on disk. The mirror scan would
      // otherwise ship that partial edit straight to Overleaf, so withhold it
      // the same way ownership violations are withheld — the runner's S8
      // demotion reads getViolationPaths() and drops these from writeback
      // (spec S8 safety extension, v1.6.2).
      for (const file of changedFiles) {
        quarantined.set(file, { jobId: job.id, status: resultFields.status, adoptedHash: '' });
      }
    }
    const result = {
      id: job.id,
      ...resultFields,
      threadId: workerResult?.threadId || entry.threadId || '',
      changedFiles,
      durationMs: Date.now() - entry.startedAt
    };
    entry.result = result;
    writeResult(result);
    if (resultFields.status === 'completed' && workerResult?.assistantMessage) {
      atomicWrite(path.join(resultsDir, `${job.id}.last-message.md`), String(workerResult.assistantMessage));
    }
    const eventType = resultFields.status === 'completed' ? 'codex.subagent.completed' : 'codex.subagent.failed';
    emit(eventType, publicText(job.title || job.id, 160), {
      jobId: job.id,
      threadId: result.threadId,
      status: resultFields.status,
      reason: publicText(resultFields.reason, 1200),
      summary: publicText(workerResult?.assistantMessage || resultFields.summary, 24000),
      changedFiles,
      durationMs: result.durationMs
    }, resultFields.status === 'completed' ? 'completed' : 'warning');
  }


  // ---- wave tracking (spec S5): owned attribution is per worker; unowned
  // changes can only be attributed to the wave's set of suspects.
  function beginWave() {
    adoptionToken = '';
    writeBrokerFile('ready');
    waveIndex += 1;
    waveSnapshot = {
      hashes: hashWorkspace(),
      ownedUnion: new Set(),
      jobIds: []
    };
  }

  function endWave() {
    if (!waveSnapshot) {
      return;
    }
    const after = hashWorkspace();
    const before = waveSnapshot.hashes;
    const changed = new Set();
    for (const [file, hash] of after) {
      if (before.get(file) !== hash) {
        changed.add(file);
      }
    }
    for (const file of before.keys()) {
      if (!after.has(file)) {
        changed.add(file);
      }
    }
    for (const file of changed) {
      if (waveSnapshot.ownedUnion.has(file)) {
        continue;
      }
      const violation = {
        path: file,
        wave: waveIndex,
        suspects: [...waveSnapshot.jobIds, 'parent']
      };
      violations.push(violation);
      violationPaths.add(file);
      emit('codex.subagent.violation', file, violation, 'warning');
    }
    waveSnapshot = null;
    if (!closed && !cancelled && accepting && running.size === 0) {
      // Workers have exited before this capability is published. A worker
      // cannot pre-authorize its own incomplete output while still running.
      adoptionToken = crypto.randomBytes(24).toString('hex');
      writeBrokerFile('ready');
    }
  }


  function processAdoptions() {
    if (closed || cancelled || running.size || !adoptionToken || !fs.existsSync(adoptionsDir)) return;
    for (const name of fs.readdirSync(adoptionsDir).filter(name => /^[a-z0-9-]{1,32}\.json$/.test(name)).slice(0, 64)) {
      if (seenAdoptions.has(name)) continue;
      seenAdoptions.add(name);
      let result = { ok: false, reason: 'invalid_adoption' };
      try {
        const requestPath = path.join(adoptionsDir, name), stat = fs.lstatSync(requestPath);
        if (!stat.isFile() || stat.size > MAX_JOB_FILE_BYTES) throw new Error('invalid_adoption_file');
        const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
        if (request.token !== adoptionToken || request.reviewed !== true || !Array.isArray(request.files)
          || !request.files.length || request.files.length > 100) throw new Error('adoption_not_authorized');
        const approved = [];
        for (const item of request.files) {
          const safe = safeWorkspaceRelativePath(item?.path), held = quarantined.get(safe);
          const entry = held && jobs.get(held.jobId);
          if (!safe || !held || held.jobId !== item.jobId || !entry?.job?.files.includes(safe)
            || violationPaths.has(safe) || !/^[a-f0-9]{64}$/i.test(item.sha256 || '')
            || adoptionHash(safe) !== item.sha256.toLowerCase()) throw new Error('adoption_content_or_owner_mismatch');
          approved.push({ path: safe, sha256: item.sha256.toLowerCase(), held });
        }
        for (const item of approved) item.held.adoptedHash = item.sha256;
        result = { ok: true, files: approved.map(item => ({ path: item.path, sha256: item.sha256 })) };
      } catch (error) { result = { ok: false, reason: String(error?.message || error).slice(0, 200) }; }
      atomicWrite(path.join(adoptionResultsDir, name), JSON.stringify(result, null, 2));
    }
  }

  function blockedPaths() {
    const blocked = new Set(violationPaths);
    for (const [file, held] of quarantined) {
      if (!held.adoptedHash || adoptionHash(file) !== held.adoptedHash) blocked.add(file);
    }
    return blocked;
  }

  function onParentAbort() {
    cancelled = true;
    accepting = false;
    for (const { controller } of running.values()) {
      controller.abort(new Error('run cancelled'));
    }
    for (const jobId of queued.splice(0)) {
      const entry = jobs.get(jobId);
      entry.status = 'cancelled';
      writeResult({ id: jobId, status: 'cancelled', reason: 'run cancelled' });
      emit('codex.subagent.failed', publicText(entry.job.title || jobId, 160), {
        jobId, status: 'cancelled', reason: 'run cancelled'
      }, 'warning');
    }
    if (anyWorkerStarted) {
      // Partial worker edits must be deterministically discarded: cancellation
      // already skips writeback, and the dirty mark forces the next run's
      // mirror sync to rebuild the workspace from Overleaf (spec P1-3 fix).
      onMirrorDirty();
    }
    close();
  }

  async function stop({ drain = true } = {}) {
    processAdoptions();
    accepting = false;
    // Queued-but-unstarted jobs would otherwise vanish with no result file,
    // hanging a lead still polling for its job count. Settle them first
    // (mirrors onParentAbort's queue handling).
    for (const jobId of queued.splice(0)) {
      const entry = jobs.get(jobId);
      if (entry) {
        entry.status = 'cancelled';
      }
      writeResult({ id: jobId, status: 'cancelled', reason: 'The run ended before this subagent started.' });
      emit('codex.subagent.failed', publicText(entry?.job?.title || jobId, 160), {
        jobId, status: 'cancelled', reason: 'The run ended before this subagent started.'
      }, 'warning');
    }
    if (drain && running.size) {
      let graceTimer = null;
      const grace = new Promise(resolve => {
        graceTimer = setTimeout(resolve, limits.drainGraceMs);
      });
      await Promise.race([
        Promise.allSettled([...running.values()].map(worker => worker.promise)),
        grace
      ]);
      // The grace timer gates an awaited race; if the workers settled first it
      // must be cleared or it keeps the event loop alive for drainGraceMs
      // (the "keep timers gated, then clear" discipline from c3cd357).
      if (graceTimer) {
        clearTimeout(graceTimer);
      }
    }
    for (const { controller } of running.values()) {
      controller.abort(new Error('broker drained'));
    }
    // Bounded final settle: a worker that ignores its abort must not hang
    // stop() forever — that strands codex.run and leaks the project lock (the
    // very zombie-lock case handleCodexCancel exists to recover from).
    await settleRunningWithin(limits.drainGraceMs);
    if (jobs.size) {
      emit('codex.subagent.drained', 'subagents drained', {
        jobs: jobs.size,
        violations: violations.length
      }, 'completed');
    }
    close();
  }

  async function settleRunningWithin(timeoutMs) {
    if (!running.size) {
      return;
    }
    let timer = null;
    const fallback = new Promise(resolve => {
      timer = setTimeout(resolve, Math.max(0, timeoutMs));
    });
    await Promise.race([
      Promise.allSettled([...running.values()].map(worker => worker.promise)),
      fallback
    ]);
    if (timer) {
      clearTimeout(timer);
    }
  }

  function close() {
    if (closed) {
      return;
    }
    closed = true;
    if (pollTimer) {
      clearInterval(pollTimer);
    }
    parentSignal?.removeEventListener?.('abort', onParentAbort);
    try {
      writeBrokerFile('closed');
    } catch (_error) { /* workspace may already be gone */ }
  }

  return {
    start,
    stop,
    pollOnce,
    hasActiveWorkers: () => running.size > 0,
    hasAcceptedJobs: () => jobs.size > 0,
    getViolationPaths: blockedPaths,
    getBlockedReason: file => violationPaths.has(file) ? 'subagent_unauthorized_edit' : 'subagent_unfinished_output',
    getAuditSummary: () => ({
      jobs: [...jobs.values()].map(entry => ({
        id: entry.job?.id,
        title: entry.job?.title,
        files: entry.job?.files,
        status: entry.status,
        reason: entry.result?.reason,
        durationMs: entry.result?.durationMs
      })),
      violations: violations.slice(),
      quarantined: [...quarantined].map(([file, item]) => ({ path: file, jobId: item.jobId, status: item.status,
        adopted: Boolean(item.adoptedHash && adoptionHash(file) === item.adoptedHash) }))
    })
  };
}

module.exports = {
  createSubagentBroker,
  SUBAGENT_QUEUE_DIR,
  DEFAULT_SUBAGENT_LIMITS: DEFAULT_LIMITS
};
