'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { buildOperationSummary, splitDeletePlan } = require('../../extension/src/shared/summary');
const {
  MIN_COMPATIBLE_EXTENSION_VERSION,
  REQUIRED_CAPABILITIES,
  SUPPORTED_NATIVE_PROTOCOL
} = require('../../extension/src/shared/compatibility');
const { runCodexSession } = require('./codexSessionRunner');
const { resolveCodexModels } = require('./codexModels');
const {
  handleProviderRequest,
  isProviderMethod,
  providerErrorResponse,
  resolveProviderModels,
  resolveRunProviderForRun
} = require('./providerRuntime');
const { clearPluginCodexHistory } = require('./codexHome');
const { logDebug, truncateText } = require('./debugLog');
const { HOST_NAME } = require('./manifest');
const { getNativeRuntimePlatform, summarizeNativeEnvironment } = require('./nativeEnvironment');
const {
  NATIVE_REQUEST_QUOTAS,
  firstQuotaViolation,
  validateNativeRequestQuotas,
  validateOperationListQuota,
  validateOperationPayloadQuota
} = require('./nativeQuotas');
const { version: PACKAGE_VERSION } = require('../../package.json');

const activeProjectLocks = new Map();
const activeRunControllers = new Map();
// Parallel index of active runs by projectKey so codex.cancel can find a
// controller even when the original request id is unknown (e.g. after the
// Overleaf tab was reloaded — the requestId lived in content-side JS state
// and is gone, but the native-host-side controller is still running).
const activeRunByProject = new Map();
const pendingPlans = new Map();
const PENDING_PLAN_TTL_MS = 30 * 60 * 1000;
const CODEX_RUN_PASSTHROUGH_ERROR_CODES = new Set(['thread_resume_failed', 'codex_no_usable_result']);

async function handleRequest(request, env = process.env, emit = () => {}) {
  if (!request || typeof request !== 'object') {
    return errorResponse(undefined, 'invalid_request', 'Request must be an object');
  }

  const quotaError = validateNativeRequestQuotas(request);
  if (quotaError) {
    return quotaErrorResponse(request.id, quotaError);
  }

  if (request.method === 'bridge.ping') {
    return okResponse(request.id, {
      host: HOST_NAME,
      platform: getNativeRuntimePlatform({ env }),
      protocolVersion: 2,
      supportedProtocol: { ...SUPPORTED_NATIVE_PROTOCOL },
      capabilities: Object.fromEntries(REQUIRED_CAPABILITIES.map(capability => [capability, true])),
      minExtensionVersion: MIN_COMPATIBLE_EXTENSION_VERSION,
      version: PACKAGE_VERSION,
      environment: summarizeNativeEnvironment(env)
    });
  }

  if (request.method === 'mirror.sync') {
    return handleMirrorSync(request, env);
  }

  if (request.method === 'mirror.patchFiles') {
    return handleMirrorPatchFiles(request, env);
  }

  if (request.method === 'mirror.confirmWriteback') {
    return handleMirrorConfirmWriteback(request, env);
  }

  if (request.method === 'mirror.status') {
    return handleMirrorStatus(request, env);
  }

  if (request.method === 'mirror.scanSensitive') {
    return handleMirrorScanSensitive(request, env);
  }

  if (isProviderMethod(request.method)) {
    return handleProviderRequest(request, env, emit);
  }

  if (request.method === 'codex.models') {
    try {
      return okResponse(request.id, resolveProviderModels(
        request.params || {},
        env,
        resolveCodexModels
      ));
    } catch (error) {
      return providerErrorResponse(request.id, error);
    }
  }

  if (request.method === 'codex.run') {
    return handleCodexRun(request, env, emit);
  }

  if (request.method === 'codex.cancel') {
    return handleCodexCancel(request);
  }

  if (request.method === 'codex.history.clearPlugin') {
    return handleCodexHistoryClear(request, env);
  }

  if (request.method === 'skills.list') {
    return handleSkillsList(request, env);
  }

  if (request.method === 'skills.install') {
    return handleSkillsInstall(request, env);
  }

  if (request.method === 'skills.remove') {
    return handleSkillsRemove(request, env);
  }

  if (request.method === 'task.run') {
    return handleTaskRun(request, env, emit);
  }

  if (request.method === 'task.confirm') {
    return handleTaskConfirm(request);
  }

  return errorResponse(request.id, 'method_not_found', `Unknown method: ${request.method}`);
}

function quotaErrorResponse(id, violation) {
  return errorResponse(
    id,
    'native_request_quota_exceeded',
    `Native request quota exceeded: ${violation.reason} (${violation.actual}/${violation.limit}).`,
    {
      field: violation.field,
      limit: violation.limit,
      actual: violation.actual
    }
  );
}

async function handleCodexRun(request, env, emit) {
  let params = request.params || {};
  if (isCodexMissing(env)) {
    return errorResponse(
      request.id,
      'codex_not_found',
      'Codex CLI was not found. Install Codex or make sure the `codex` command is available in your login shell.'
    );
  }

  const projectKey = resolveProjectKey(params);
  const lockToken = acquireProjectLock(projectKey);
  if (!lockToken) {
    return errorResponse(request.id, 'project_locked', `Project ${projectKey} is currently in use by codex.run`);
  }
  const abortController = new AbortController();
  if (request.id) {
    activeRunControllers.set(request.id, abortController);
    activeRunByProject.set(projectKey, { id: request.id, controller: abortController });
  }
  let providerResolution;
  try {
    try {
      providerResolution = await resolveRunProviderForRun(params, env, {
        signal: abortController.signal,
        emit
      });
      params = {
        ...params,
        model: providerResolution.modelId,
        reasoningEffort: providerResolution.reasoningEffort,
        providerSelection: providerResolution.providerSelection
      };
    } catch (error) {
      return providerErrorResponse(request.id, error);
    }

    if (params.useExistingMirror) {
      const { getMirrorStatus, applyFileOverlays } = require('./mirrorWorkspace');
      const rootDir = env.CODEX_OVERLEAF_MIRROR_ROOT;
      const status = getMirrorStatus(projectKey, { rootDir });
      const maxFreshness = params.expectedMirrorFreshness || 15000;
      const mirrorMissingOrStale = !status.exists || !Number.isFinite(status.ageMs) || status.ageMs > maxFreshness;

      if (isOtWarmMirrorReuseRequest(params)) {
        const otWarmMirrorReuse = validateOtFocusedWarmMirrorReuse(params, status);
        if (!otWarmMirrorReuse.ok) {
          return errorResponse(
            request.id,
            'mirror_stale',
            otWarmMirrorReuse.message || `Mirror is ${status.ageMs}ms old (max ${maxFreshness}ms)`
          );
        }
      } else if (mirrorMissingOrStale) {
        return errorResponse(
          request.id,
          'mirror_stale',
          `Mirror is ${status.ageMs}ms old (max ${maxFreshness}ms)`
        );
      }

      if (Array.isArray(params.fileOverlays) && params.fileOverlays.length) {
        await applyFileOverlays({ projectId: projectKey, overlays: params.fileOverlays, rootDir });
      }
    } else if (!isSnapshotlessSkillInstallerRun(params) && !hasRunnableProjectSnapshotEvidence(params)) {
      return errorResponse(
        request.id,
        'codex_run_requires_snapshot_evidence',
        'codex.run requires an explicit full project snapshot or a focused partial snapshot'
      );
    }

    const result = await runCodexSession({
      params: params.useExistingMirror ? { ...params, skipMirrorSync: true } : params,
      env,
      emit,
      rootDir: env.CODEX_OVERLEAF_MIRROR_ROOT,
      providerLaunch: providerResolution.providerLaunch,
      signal: abortController.signal
    });
    const syncChanges = Array.isArray(result.syncChanges) ? result.syncChanges : [];
    return okResponse(request.id, {
      ...result,
      syncChanges
    });
  } catch (error) {
    if (isCancellationError(error)) {
      logDebug('codex.run.cancelled', {
        code: error.code,
        message: error.message
      });
      return errorResponse(request.id, 'codex_cancelled', 'Codex run was cancelled by the user');
    }
    if (shouldPassthroughCodexRunError(error)) {
      logDebug('codex.run.passthrough_failed', {
        code: error.code,
        message: error.message,
        stack: error.stack
      });
      return errorResponse(request.id, error.code, truncateText(error.message, 12000));
    }
    logDebug('codex.run.failed', {
      code: error.code,
      message: error.message,
      stack: error.stack
    });
    return errorResponse(request.id, 'codex_run_failed', truncateText(error.message, 12000));
  } finally {
    if (request.id && activeRunControllers.get(request.id) === abortController) {
      activeRunControllers.delete(request.id);
    }
    if (activeRunByProject.get(projectKey)?.controller === abortController) {
      activeRunByProject.delete(projectKey);
    }
    releaseProjectLock(projectKey, lockToken);
  }
}

// Cancel paths, in priority order:
//   1. By requestId (legacy + primary, when the caller still has it)
//   2. By projectKey (after page refresh — requestId is lost but projectKey
//      is derivable from the Overleaf URL)
//   3. Force-release the project lock when no controller is registered for
//      the given projectKey. Covers the zombie-lock case where a previous
//      run leaked the lock (unhandled error path, process bug, etc.) and
//      the user otherwise has no way to recover short of restarting Chrome.
//      Only fires when `force: true` is explicitly set so accidental calls
//      can't punch through a real live run.
function handleCodexCancel(request) {
  const params = request.params || {};
  const targetId = params.requestId || params.id;
  const projectKey = typeof params.projectKey === 'string' ? params.projectKey : '';
  const force = params.force === true;

  if (targetId && activeRunControllers.has(targetId)) {
    activeRunControllers.get(targetId).abort(createCancellationError());
    return okResponse(request.id, {
      cancelled: true,
      requestId: targetId
    });
  }

  if (projectKey) {
    const entry = activeRunByProject.get(projectKey);
    if (entry?.controller) {
      entry.controller.abort(createCancellationError());
      return okResponse(request.id, {
        cancelled: true,
        projectKey,
        requestId: entry.id || ''
      });
    }
    if (force && activeProjectLocks.has(projectKey)) {
      activeProjectLocks.delete(projectKey);
      activeRunByProject.delete(projectKey);
      logDebug('codex.cancel.force_released_zombie_lock', { projectKey });
      return okResponse(request.id, {
        cancelled: false,
        lockReleased: true,
        projectKey,
        reason: 'No active controller; force-released the project lock entry'
      });
    }
  }

  return okResponse(request.id, {
    cancelled: false,
    reason: 'No active Codex run matched the cancellation request'
  });
}

function handleCodexHistoryClear(request, env) {
  try {
    return okResponse(request.id, clearPluginCodexHistory(request.params || {}, env));
  } catch (error) {
    return errorResponse(request.id, 'codex_history_clear_failed', error.message);
  }
}

function handleSkillsList(request, env) {
  try {
    const { CODEX_OVERLEAF_SKILL_SCOPE, listCodexOverleafSkills, listProjectSkills } = require('./localSkills');
    if (request.params?.scope === CODEX_OVERLEAF_SKILL_SCOPE) {
      // Install/restore official skills before listing so newly shipped ones
      // (e.g. parallel-subagents) appear in the Skills UI right after a
      // runtime update instead of only after the next codex run (v1.6.1).
      try {
        require('./codexHome').ensureDefaultCodexOverleafSkills({ env });
      } catch (_error) { /* listing still proceeds */ }
      return okResponse(request.id, listCodexOverleafSkills({ env }));
    }
    return okResponse(request.id, listProjectSkills({
      projectId: request.params?.projectId,
      rootDir: env.CODEX_OVERLEAF_MIRROR_ROOT
    }));
  } catch (error) {
    return errorResponse(request.id, 'skills_list_failed', error.message);
  }
}

function handleSkillsInstall(request, env) {
  try {
    const { CODEX_OVERLEAF_SKILL_SCOPE, installCodexOverleafSkill, installProjectSkill } = require('./localSkills');
    if (request.params?.scope === CODEX_OVERLEAF_SKILL_SCOPE) {
      return okResponse(request.id, installCodexOverleafSkill({
        skillId: request.params?.skillId || request.params?.id,
        content: request.params?.content,
        env
      }));
    }
    return okResponse(request.id, installProjectSkill({
      projectId: request.params?.projectId,
      skillId: request.params?.skillId || request.params?.id,
      content: request.params?.content,
      rootDir: env.CODEX_OVERLEAF_MIRROR_ROOT
    }));
  } catch (error) {
    return errorResponse(request.id, 'skills_install_failed', error.message);
  }
}

function handleSkillsRemove(request, env) {
  try {
    const { CODEX_OVERLEAF_SKILL_SCOPE, removeCodexOverleafSkill, removeProjectSkill } = require('./localSkills');
    if (request.params?.scope === CODEX_OVERLEAF_SKILL_SCOPE) {
      return okResponse(request.id, removeCodexOverleafSkill({
        skillId: request.params?.skillId || request.params?.id,
        env
      }));
    }
    return okResponse(request.id, removeProjectSkill({
      projectId: request.params?.projectId,
      skillId: request.params?.skillId || request.params?.id,
      rootDir: env.CODEX_OVERLEAF_MIRROR_ROOT
    }));
  } catch (error) {
    return errorResponse(request.id, 'skills_remove_failed', error.message);
  }
}

function hasRunnableProjectSnapshotEvidence(params = {}) {
  if (params.project?.capabilities?.fullProjectSnapshot === true) {
    return true;
  }
  if (params.project?.capabilities?.fullProjectSnapshot !== false) {
    return false;
  }
  if (params.restrictToFocusFiles !== true) {
    return false;
  }
  const normalizedFocusFiles = normalizeSnapshotEvidencePaths(params.focusFiles);
  if (!normalizedFocusFiles.length || !Array.isArray(params.project?.files)) {
    return false;
  }
  const evidenceFiles = new Map();
  for (const file of params.project.files) {
    const filePath = normalizeSnapshotEvidencePath(file?.path);
    if (!filePath || !isUsableSnapshotEvidenceContent(file?.content)) {
      continue;
    }
    evidenceFiles.set(filePath, file);
  }
  return normalizedFocusFiles.every(filePath => evidenceFiles.has(filePath));
}

function isSnapshotlessSkillInstallerRun(params = {}) {
  return params.skipMirrorSync === true
    && String(params.skillInvocation?.id || '').trim() === 'skill-installer';
}

function validateOtFocusedWarmMirrorReuse(params = {}, status = {}) {
  if (!isOtWarmMirrorReuseRequest(params)) {
    return { ok: false };
  }
  if (Array.isArray(params.fileOverlays) && params.fileOverlays.length) {
    return {
      ok: false,
      message: 'OT warm mirror reuse does not accept file overlays'
    };
  }
  if (status?.exists !== true) {
    return {
      ok: false,
      message: 'OT warm mirror reuse requires an existing trusted mirror'
    };
  }
  if (params.restrictToFocusFiles !== true) {
    return {
      ok: false,
      message: 'OT warm mirror reuse requires restrictToFocusFiles=true'
    };
  }
  const normalizedFocusFiles = normalizeSnapshotEvidencePaths(params.focusFiles);
  if (!normalizedFocusFiles.length) {
    return {
      ok: false,
      message: 'OT warm mirror reuse requires focused files'
    };
  }

  const freshFiles = new Set();
  for (const file of Array.isArray(status.otFreshFiles) ? status.otFreshFiles : []) {
    if (file?.state !== 'fresh') {
      continue;
    }
    const filePath = normalizeSnapshotEvidencePath(file.path);
    if (filePath) {
      freshFiles.add(filePath);
    }
  }
  const missingFiles = normalizedFocusFiles.filter(filePath => !freshFiles.has(filePath));
  if (missingFiles.length) {
    return {
      ok: false,
      message: `OT warm mirror focused files are not OT-fresh: ${missingFiles.join(', ')}`
    };
  }

  return { ok: true };
}

function isOtWarmMirrorReuseRequest(params = {}) {
  return params.otWarmStart === true || params.warmStartStrategy === 'ot-warm-mirror';
}

function isUsableSnapshotEvidenceContent(content) {
  if (typeof content !== 'string') {
    return false;
  }
  const text = content.trim();
  return Boolean(text) && !/^(loading|loading\.{3}|loading…)$/i.test(text);
}

function normalizeSnapshotEvidencePaths(value) {
  const seen = new Set();
  const paths = [];
  for (const item of Array.isArray(value) ? value : []) {
    const filePath = normalizeSnapshotEvidencePath(item);
    if (!filePath || seen.has(filePath)) {
      continue;
    }
    seen.add(filePath);
    paths.push(filePath);
  }
  return paths;
}

function normalizeSnapshotEvidencePath(value) {
  return String(value || '')
    .replace(/^@file:/i, '')
    .replace(/\\/g, '/')
    .trim()
    .replace(/^\/+/, '');
}

function createCancellationError() {
  const error = new Error('Codex run was cancelled by the user');
  error.code = 'codex_cancelled';
  return error;
}

function isCancellationError(error = {}) {
  return error.code === 'codex_cancelled'
    || error.name === 'AbortError'
    || /cancelled by the user|was cancelled/i.test(error.message || '');
}

function shouldPassthroughCodexRunError(error = {}) {
  return CODEX_RUN_PASSTHROUGH_ERROR_CODES.has(error.code);
}

function isCodexMissing(env = process.env) {
  return (
    env.CODEX_OVERLEAF_ENV_READY === '1' ||
    Object.prototype.hasOwnProperty.call(env, 'CODEX_OVERLEAF_CODEX_PATH')
  ) && !env.CODEX_OVERLEAF_CODEX_PATH;
}

async function handleMirrorSync(request, env) {
  const { syncOverleafToMirror } = require('./mirrorWorkspace');
  const params = request.params || {};
  const projectId = params.projectId || 'unknown';
  const projectKey = resolveProjectKey(params);
  const rootDir = env.CODEX_OVERLEAF_MIRROR_ROOT;

  const lockToken = acquireProjectLock(projectKey);
  if (!lockToken) {
    return errorResponse(request.id, 'project_locked', `Project ${projectKey} is currently in use by codex.run`);
  }
  if (params.project?.capabilities?.fullProjectSnapshot !== true) {
    releaseProjectLock(projectKey, lockToken);
    return errorResponse(
      request.id,
      'mirror_sync_requires_full_project',
      'mirror.sync requires an explicit full project snapshot'
    );
  }

  try {
    const result = await syncOverleafToMirror({
      projectId,
      project: params.project || { files: [] },
      rootDir
    });
    return okResponse(request.id, {
      fileCount: result.fileCount,
      writtenCount: result.writtenCount || 0,
      projectKey: result.projectKey
    });
  } catch (error) {
    return errorResponse(request.id, 'mirror_sync_failed', error.message);
  } finally {
    releaseProjectLock(projectKey, lockToken);
  }
}

async function handleMirrorPatchFiles(request, env) {
  const { patchMirrorFiles } = require('./mirrorWorkspace');
  const params = request.params || {};
  const projectId = params.projectId || 'unknown';
  const projectKey = resolveProjectKey(params);
  const rootDir = env.CODEX_OVERLEAF_MIRROR_ROOT;

  const lockToken = acquireProjectLock(projectKey);
  if (!lockToken) {
    return errorResponse(request.id, 'project_locked', `Project ${projectKey} is currently in use by codex.run`);
  }

  try {
    const result = await patchMirrorFiles({
      projectId,
      files: params.files,
      rootDir,
      source: params.source || 'ot'
    });
    return okResponse(request.id, result);
  } catch (error) {
    return errorResponse(request.id, 'mirror_patch_files_failed', error.message);
  } finally {
    releaseProjectLock(projectKey, lockToken);
  }
}

async function handleMirrorConfirmWriteback(request, env) {
  const { confirmWritebackFiles } = require('./mirrorWorkspace');
  const params = request.params || {};
  const projectId = params.projectId || 'unknown';
  const projectKey = resolveProjectKey(params);
  const rootDir = env.CODEX_OVERLEAF_MIRROR_ROOT;

  const lockToken = acquireProjectLock(projectKey);
  if (!lockToken) {
    return errorResponse(request.id, 'project_locked', `Project ${projectKey} is currently in use by codex.run`);
  }

  try {
    const result = await confirmWritebackFiles({
      projectId,
      paths: params.paths,
      rootDir
    });
    return okResponse(request.id, result);
  } catch (error) {
    return errorResponse(request.id, 'mirror_confirm_writeback_failed', error.message);
  } finally {
    releaseProjectLock(projectKey, lockToken);
  }
}

function handleMirrorStatus(request, env) {
  const { getMirrorStatus } = require('./mirrorWorkspace');
  const params = request.params || {};
  const projectId = params.projectId || 'unknown';
  const rootDir = env.CODEX_OVERLEAF_MIRROR_ROOT;
  const status = getMirrorStatus(projectId, { rootDir });
  return okResponse(request.id, status);
}

function handleMirrorScanSensitive(request, env) {
  try {
    const { scanMirrorSensitiveFiles } = require('./mirrorSensitiveScan');
    const params = request.params || {};
    return okResponse(request.id, scanMirrorSensitiveFiles({
      projectId: params.projectId || 'unknown',
      rootDir: env.CODEX_OVERLEAF_MIRROR_ROOT
    }));
  } catch (error) {
    return errorResponse(request.id, 'mirror_sensitive_scan_failed', error.message);
  }
}

async function handleTaskRun(request, env, emit) {
  const params = request.params || {};
  const mode = params.mode;

  if (!['ask', 'confirm', 'auto'].includes(mode)) {
    return errorResponse(request.id, 'invalid_mode', 'Mode must be "ask", "confirm", or "auto"');
  }

  if (mode === 'auto' && !params.checkpoint?.ok && !isVerifiedReviewing(params.reviewing)) {
    return errorResponse(request.id, 'safety_required', 'Auto Mode requires an Overleaf checkpoint or verified Reviewing/Track Changes');
  }

  const fileCount = Array.isArray(params.project?.files) ? params.project.files.length : 0;
  const totalChars = Array.isArray(params.project?.files)
    ? params.project.files.reduce((sum, file) => sum + String(file?.content || '').length, 0)
    : 0;
  emitTaskEvent(emit, 'native.task.received', 'Native bridge received task', {
    mode,
    model: params.model,
    reasoningEffort: params.reasoningEffort,
    speedTier: params.speedTier,
    fileCount,
    totalChars
  });

  let agentSpec;
  try {
    agentSpec = resolveExternalAgent(env);
  } catch (error) {
    return errorResponse(request.id, 'invalid_agent_command', error.message);
  }

  if (agentSpec) {
    try {
      logDebug('agent.run.start', {
        command: agentSpec.label,
        mode,
        model: params.model,
        reasoningEffort: params.reasoningEffort,
        speedTier: params.speedTier,
        fileCount
      });
      emitTaskEvent(emit, 'agent.command.started', 'Codex agent command started', {
        mode,
        model: params.model,
        reasoningEffort: params.reasoningEffort,
        speedTier: params.speedTier,
        fileCount
      });
      const result = await runExternalAgent(agentSpec, params, emit, {
        env,
        timeoutMs: parseOptionalPositiveInteger(env.CODEX_OVERLEAF_AGENT_TIMEOUT_MS),
        outputMaxBytes: parsePositiveInteger(env.CODEX_OVERLEAF_AGENT_OUTPUT_MAX_BYTES, 1024 * 1024)
      });
      logDebug('agent.run.ok', {
        status: result?.status,
        operationCount: Array.isArray(result?.operations) ? result.operations.length : 0
      });
      emitTaskEvent(emit, 'agent.command.completed', 'Codex agent command completed', {
        status: result?.status || 'completed',
        operationCount: Array.isArray(result?.operations) ? result.operations.length : 0
      }, 'completed');
      const normalized = normalizeAgentResult(mode, result, params);
      const resultQuotaError = validateTaskResultOperationQuotas(normalized);
      if (resultQuotaError) {
        return quotaErrorResponse(request.id, resultQuotaError);
      }
      return okResponse(request.id, prepareResultForResponse(mode, normalized));
    } catch (error) {
      logDebug('agent.run.failed', {
        message: error.message,
        stack: error.stack
      });
      emitTaskEvent(emit, 'agent.command.failed', 'Codex agent command failed', {
        message: error.message
      }, 'failed');
      return errorResponse(request.id, 'agent_failed', truncateText(error.message, 12000));
    }
  }

  const operations = params.proposedOperations || [];
  const result = buildDefaultTaskResult(mode, operations, params);
  const resultQuotaError = validateTaskResultOperationQuotas(result);
  if (resultQuotaError) {
    return quotaErrorResponse(request.id, resultQuotaError);
  }
  return okResponse(request.id, prepareResultForResponse(mode, result));
}

function isVerifiedReviewing(reviewing) {
  return reviewing?.ok === true && reviewing.status !== 'manual-override';
}

async function handleTaskConfirm(request) {
  const planId = request.params?.planId;
  purgeExpiredPendingPlans();
  if (!planId || !pendingPlans.has(planId)) {
    return errorResponse(request.id, 'plan_not_found', 'No pending task plan matched the supplied planId');
  }

  const plan = pendingPlans.get(planId);
  pendingPlans.delete(planId);

  return okResponse(request.id, {
    status: 'confirmed',
    notes: plan.notes || '',
    userReport: plan.userReport,
    operations: plan.operations
  });
}

function buildDefaultTaskResult(mode, operations, params = {}) {
  if (mode === 'ask') {
    return {
      status: 'completed',
      summary: buildOperationSummary([]),
      notes: '',
      userReport: buildDefaultUserReport(mode, [], params),
      operations: []
    };
  }

  const summary = buildOperationSummary(operations);

  if (mode === 'confirm') {
    return {
      status: 'requires_task_confirmation',
      summary,
      notes: '',
      userReport: buildDefaultUserReport(mode, operations, params),
      operations
    };
  }

  const split = splitDeletePlan(operations);
  if (split.needsConfirmation.length > 0) {
    return {
      status: 'delete_plan_required',
      summary: buildOperationSummary(split.immediate),
      notes: '',
      userReport: buildDefaultUserReport(mode, operations, params),
      operations: split.immediate,
      deletePlan: buildOperationSummary(split.needsConfirmation).deletePlan,
      pendingOperations: split.needsConfirmation
    };
  }

  return {
    status: 'completed',
    summary,
    notes: '',
    userReport: buildDefaultUserReport(mode, operations, params),
    operations
  };
}

function normalizeAgentResult(mode, result, params = {}) {
  const operations = Array.isArray(result.operations) ? result.operations : [];
  if (mode === 'ask') {
    return {
      status: 'completed',
      summary: buildOperationSummary([]),
      notes: typeof result.notes === 'string' ? result.notes : '',
      userReport: normalizeUserReport(result.userReport, buildDefaultUserReport(mode, [], params)),
      operations: []
    };
  }

  const normalized = {
    ...result,
    summary: result.summary || buildOperationSummary(operations),
    notes: typeof result.notes === 'string' ? result.notes : '',
    userReport: normalizeUserReport(result.userReport, buildDefaultUserReport(mode, collectResultOperations(result), params)),
    operations
  };

  if (!normalized.status) {
    normalized.status = mode === 'confirm' ? 'requires_task_confirmation' : 'completed';
  }

  return normalized;
}

function prepareResultForResponse(mode, result) {
  if (mode === 'auto') {
    const operations = collectResultOperations(result);
    const split = splitDeletePlan(operations);
    if (split.needsConfirmation.length > 0) {
      return {
        ...result,
        status: 'delete_plan_required',
        summary: buildOperationSummary(split.immediate),
        operations: split.immediate,
        deletePlan: buildOperationSummary(split.needsConfirmation).deletePlan,
        pendingOperations: split.needsConfirmation
      };
    }
  }

  const confirmOperations = mode === 'confirm' ? collectResultOperations(result) : [];
  if (confirmOperations.length > 0) {
    result = {
      ...result,
      status: 'requires_task_confirmation',
      summary: buildOperationSummary(confirmOperations),
      operations: confirmOperations
    };
  }

  if (mode !== 'confirm' || result.status !== 'requires_task_confirmation') {
    return result;
  }

  purgeExpiredPendingPlans();
  const planId = `plan_${crypto.randomUUID()}`;
  pendingPlans.set(planId, {
    createdAt: Date.now(),
    expiresAt: Date.now() + PENDING_PLAN_TTL_MS,
    notes: result.notes || '',
    userReport: result.userReport,
    operations: Array.isArray(result.operations) ? result.operations : []
  });

  const {
    operations: _operations,
    pendingOperations: _pendingOperations,
    deletePlan: _deletePlan,
    ...redacted
  } = result;
  return {
    ...redacted,
    planId
  };
}

function validateTaskResultOperationQuotas(result = {}) {
  const operations = collectResultOperations(result);
  return firstQuotaViolation([
    validateOperationListQuota(operations, 'operations'),
    validateOperationPayloadQuota(operations, 'operations')
  ]);
}

function buildDefaultUserReport(mode, operations = [], params = {}) {
  const checked = (params.project?.files || [])
    .map(file => file?.path)
    .filter(path => typeof path === 'string' && path.length > 0)
    .slice(0, 20);
  const hasOperations = operations.length > 0;

  return {
    conclusion: hasOperations
      ? 'Codex 已准备好建议修改，等待确认或写入。'
      : '这轮任务已完成，没有写入 Overleaf 文件。',
    checked,
    findings: [],
    plannedChanges: hasOperations ? operations.map(formatOperationForUserReport) : [],
    appliedChanges: [],
    unchangedReason: hasOperations ? '' : (mode === 'ask' ? '这轮是只问不改。' : ''),
    nextStep: hasOperations
      ? '请确认修改方案后写入 Overleaf。'
      : '可以继续追问，或加入更多 @context 后再检查。'
  };
}

function normalizeUserReport(value, fallback) {
  if (!value || typeof value !== 'object') {
    return fallback;
  }
  return {
    conclusion: typeof value.conclusion === 'string' ? value.conclusion : fallback.conclusion,
    checked: normalizeStringArray(value.checked, fallback.checked),
    findings: normalizeStringArray(value.findings, fallback.findings),
    plannedChanges: normalizeStringArray(value.plannedChanges, fallback.plannedChanges),
    appliedChanges: normalizeStringArray(value.appliedChanges, fallback.appliedChanges),
    unchangedReason: typeof value.unchangedReason === 'string' ? value.unchangedReason : fallback.unchangedReason,
    nextStep: typeof value.nextStep === 'string' ? value.nextStep : fallback.nextStep
  };
}

function normalizeStringArray(value, fallback = []) {
  if (!Array.isArray(value)) {
    return fallback;
  }
  return value.filter(item => typeof item === 'string');
}

function formatOperationForUserReport(operation) {
  const labels = {
    edit: '编辑',
    create: '新建',
    rename: '重命名',
    move: '移动',
    delete: '删除'
  };
  const label = labels[operation?.type] || operation?.type || '处理';
  const filePath = operation?.path || operation?.to || '未知文件';
  return `${filePath}：${label}`;
}

function collectResultOperations(result) {
  const operations = Array.isArray(result.operations) ? result.operations : [];
  const pendingOperations = Array.isArray(result.pendingOperations) ? result.pendingOperations : [];
  if (!pendingOperations.length) {
    return operations;
  }

  const seen = new Set();
  const combined = [];
  for (const operation of [...operations, ...pendingOperations]) {
    const key = JSON.stringify(operation);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    combined.push(operation);
  }
  return combined;
}

function resolveProjectKey(params = {}) {
  const projectId = params.projectId || params.project?.projectId || params.project?.id || params.project?.url || 'unknown';
  const raw = String(projectId).trim();
  const fromUrl = raw.match(/\/project\/([^/?#]+)/)?.[1];
  const candidate = fromUrl || raw.split(/[/?#]/).filter(Boolean).pop() || 'unknown';
  return candidate.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'unknown';
}

function acquireProjectLock(projectKey) {
  if (activeProjectLocks.has(projectKey)) {
    return null;
  }
  const token = Symbol(projectKey);
  activeProjectLocks.set(projectKey, token);
  return token;
}

function releaseProjectLock(projectKey, token) {
  if (activeProjectLocks.get(projectKey) === token) {
    activeProjectLocks.delete(projectKey);
  }
}

function isProjectLocked(projectKey) {
  return activeProjectLocks.has(projectKey);
}

function resolveExternalAgent(env) {
  if (env.CODEX_OVERLEAF_AGENT_FILE) {
    const args = parseAgentArgsJson(env.CODEX_OVERLEAF_AGENT_ARGS_JSON);
    return {
      file: env.CODEX_OVERLEAF_AGENT_FILE,
      args,
      label: [env.CODEX_OVERLEAF_AGENT_FILE, ...args].join(' ')
    };
  }

  return null;
}

function parseAgentArgsJson(value) {
  if (!value) {
    return [];
  }
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
    throw new Error('CODEX_OVERLEAF_AGENT_ARGS_JSON must be a JSON array of strings');
  }
  return parsed;
}

function runExternalAgent(agentSpec, params, emit = () => {}, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(agentSpec.file, agentSpec.args || [], {
      env: options.env || process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const timeoutMs = parseOptionalPositiveInteger(options.timeoutMs);
    const outputMaxBytes = parsePositiveInteger(options.outputMaxBytes, 1024 * 1024);
    let stdout = '';
    let stderr = '';
    let stderrRemainder = '';
    let outputBytes = 0;
    let settled = false;

    const timeout = timeoutMs
      ? setTimeout(() => {
        fail(new Error(`Agent command timed out after ${timeoutMs}ms`));
      }, timeoutMs)
      : null;

    function trackOutputBytes(chunk) {
      outputBytes += Buffer.byteLength(String(chunk), 'utf8');
      if (outputBytes > outputMaxBytes) {
        fail(new Error(`Agent output limit exceeded (${outputBytes}/${outputMaxBytes} bytes)`));
        return false;
      }
      return true;
    }

    function fail(error) {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGTERM');
      }
      reject(error);
    }

    function succeed(result) {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve(result);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (!trackOutputBytes(chunk) || settled) {
        return;
      }
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      if (!trackOutputBytes(chunk) || settled) {
        return;
      }
      const parsed = parseAgentEventLines(`${stderrRemainder}${chunk}`);
      stderrRemainder = parsed.remainder;
      stderr += parsed.stderr;
      for (const event of parsed.events) {
        emitTaskEvent(emit, event.type || 'agent.progress', event.title || event.type || 'Agent progress', event.detail || {}, event.status || 'running');
      }
    });
    child.on('error', fail);
    child.on('close', code => {
      if (settled) {
        return;
      }
      if (stderrRemainder) {
        const parsed = parseAgentEventLines(`${stderrRemainder}\n`);
        stderr += parsed.stderr;
        for (const event of parsed.events) {
          emitTaskEvent(emit, event.type || 'agent.progress', event.title || event.type || 'Agent progress', event.detail || {}, event.status || 'running');
        }
      }

      if (code !== 0) {
        fail(new Error(truncateText(stderr || `Agent command exited with code ${code}`, 12000)));
        return;
      }

      try {
        succeed(JSON.parse(stdout || '{}'));
      } catch (error) {
        fail(new Error(`Agent returned invalid JSON: ${error.message}. stdout=${truncateText(stdout, 4000)}`));
      }
    });

    child.stdin.end(JSON.stringify(params));
  });
}

function purgeExpiredPendingPlans(now = Date.now()) {
  for (const [planId, plan] of pendingPlans.entries()) {
    if (Number.isFinite(plan?.expiresAt) && plan.expiresAt <= now) {
      pendingPlans.delete(planId);
    }
  }
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalPositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseAgentEventLines(text) {
  const lines = text.split(/\r?\n/);
  const remainder = lines.pop() || '';
  const events = [];
  const stderrLines = [];

  for (const line of lines) {
    if (!line.startsWith('CODEX_OVERLEAF_EVENT ')) {
      stderrLines.push(line);
      continue;
    }

    try {
      events.push(JSON.parse(line.slice('CODEX_OVERLEAF_EVENT '.length)));
    } catch (error) {
      stderrLines.push(`Invalid agent event: ${error.message}`);
    }
  }

  return {
    events,
    stderr: stderrLines.length ? `${stderrLines.join('\n')}\n` : '',
    remainder
  };
}

function emitTaskEvent(emit, type, title, detail = {}, status = 'running') {
  if (typeof emit !== 'function') {
    return;
  }

  emit({
    type,
    title,
    status,
    detail,
    timestamp: new Date().toISOString()
  });
}

function okResponse(id, result) {
  return {
    id,
    ok: true,
    result
  };
}

function errorResponse(id, code, message, details = {}) {
  return {
    id,
    ok: false,
    error: {
      code,
      message,
      ...details
    }
  };
}

function getActiveNativeWorkState() {
  return {
    projectLocks: activeProjectLocks.size,
    runControllers: activeRunControllers.size
  };
}

module.exports = {
  NATIVE_REQUEST_QUOTAS,
  buildDefaultTaskResult,
  getActiveNativeWorkState,
  handleRequest,
  parseAgentEventLines,
  purgeExpiredPendingPlans
};
