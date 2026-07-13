'use strict';

const { spawn } = require('node:child_process');
const { resolveCodexCommand, shouldUseShellForCommand } = require('./codexCommand');
const fs = require('node:fs');
const path = require('node:path');
const { version: PACKAGE_VERSION } = require('../../package.json');
const { SUBAGENT_QUEUE_DIR, collectMirrorChangesDetailed, getProjectMirror, markMirrorDirty, syncOverleafToMirror } = require('./mirrorWorkspace');
const { computeLineDiff } = require('./diffEngine');
const { computeTextPatches } = require('./textPatch');
const { buildCodexHomeEnv } = require('./codexHome');
const { buildCodexSpeedArgs } = require('./codexArgs');
const { truncateText } = require('./debugLog');
const { enforceNativeOkResponseBudget } = require('./nativeResponseBudget');
const { buildCodexTurnPrompt: buildCodexPromptParts } = require('./codexPromptAssembly');
const { evaluateSkillCommand } = require('./commandApproval');
const {
  getCodexOverleafSkillsRoot,
  loadSelectedCodexOverleafSkill,
  loadSelectedProjectSkills
} = require('./localSkills');
const { createSubagentBroker } = require('./subagentBroker');

const PARALLEL_SUBAGENTS_SKILL_ID = 'parallel-subagents';

const TURN_ATTACHMENTS_DIR = '.codex-overleaf-attachments';
const MAX_TURN_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const MAX_TURN_ATTACHMENTS = 8;
const MAX_TURN_ATTACHMENT_TOTAL_BYTES = MAX_TURN_ATTACHMENT_BYTES * MAX_TURN_ATTACHMENTS;

async function runCodexSession({ params = {}, env = process.env, emit = () => {}, rootDir, executeCodex, signal } = {}) {
  throwIfAborted(signal);
  const projectId = params.projectId || params.project?.projectId || params.project?.id || params.project?.url || 'overleaf-project';
  const skillInvocation = normalizeSkillInvocation(params.skillInvocation);
  const skillInstallTurn = isSkillInstallerInvocation(skillInvocation);
  if (skillInstallTurn && Array.isArray(params.attachments) && params.attachments.length) {
    throw new Error('Skill installer turns do not accept attachments');
  }

  let mirror;
  if (params.skipMirrorSync) {
    mirror = getProjectMirror(projectId, { rootDir });
    mirror.fileCount = 0;
  } else {
    emitCodexEvent(emit, 'overleaf.sync.started', 'Syncing Overleaf project to local workspace', {
      projectId,
      fileCount: Array.isArray(params.project?.files) ? params.project.files.length : 0
    });

    mirror = await syncOverleafToMirror({
      projectId,
      project: params.project || { files: [] },
      rootDir
    });
    throwIfAborted(signal);

    emitCodexEvent(emit, 'overleaf.sync.completed', 'Overleaf project synced to local workspace', {
      projectId: mirror.projectKey,
      workspacePath: mirror.workspacePath,
      fileCount: mirror.fileCount
    }, 'completed');
  }

  const projectLocalSkills = loadProjectLocalSkillsContext(params, mirror);
  if (projectLocalSkills.missing.length) {
    emitCodexEvent(emit, 'codex.local_skills.missing', 'Selected project-local skills were missing', {
      missingSkillIds: projectLocalSkills.missing
    }, 'failed');
  }
  const turnAttachments = materializeTurnAttachments(params.attachments, mirror.workspacePath);
  const settings = buildCodexSettings(params);
  const skillLoading = normalizeSkillLoadingSettings(params);
  const codexSkillInvocationContext = loadCodexSkillInvocationContext({
    skillInvocation,
    loadCodexOverleafSkills: skillLoading.loadCodexOverleafSkills,
    enabledCodexOverleafSkillIds: params.enabledCodexOverleafSkillIds,
    env,
    emit
  });
  const effectiveSkillInvocation = getEffectiveSkillInvocation(codexSkillInvocationContext);
  const runnerWorkspacePath = skillInstallTurn
    ? getCodexOverleafSkillsRoot({ env })
    : mirror.workspacePath;
  if (skillInstallTurn) {
    fs.mkdirSync(runnerWorkspacePath, { recursive: true });
  }
  const runner = executeCodex || runCodexAppServerSession;
  // Parallel-subagents broker (v1.6): activated solely by the official skill
  // being enabled for this run. Workers are sibling Codex runs spawned by the
  // host (fresh sandbox — never nested), confined to the same mirror; the
  // broker enforces file ownership and wall-clock deadlines (spec §5-§7).
  const subagentBroker = !skillInstallTurn
    && skillLoading.loadCodexOverleafSkills !== false
    && Array.isArray(params.enabledCodexOverleafSkillIds)
    && params.enabledCodexOverleafSkillIds.includes(PARALLEL_SUBAGENTS_SKILL_ID)
    ? createSubagentBroker({
      workspacePath: mirror.workspacePath,
      signal,
      emit: (type, title, detail, status) => emitCodexEvent(emit, type, title, detail, status),
      onMirrorDirty: () => markMirrorDirty({ projectId, rootDir, reason: 'subagent_run_cancelled' }),
      runWorkerTask: ({ jobId, prompt, signal: workerSignal }) => runner({
        workspacePath: mirror.workspacePath,
        task: prompt,
        userTask: `subagent:${jobId}`,
        session: null,
        threadId: '',
        mode: params.mode || 'auto',
        model: params.model || '',
        reasoningEffort: params.reasoningEffort || '',
        speedTier: normalizeSpeedTier(params.speedTier),
        loadCodexLocalSkills: skillLoading.loadCodexLocalSkills,
        loadCodexOverleafSkills: skillLoading.loadCodexOverleafSkills,
        skillInvocation: null,
        installCodexOverleafSkillsTarget: false,
        projectLocalSkills: null,
        // Recursion guard (spec S6): workers inherit skills EXCEPT the
        // fan-out skill itself, stripped per worker app-server process.
        disableCodexOverleafSkillIds: [PARALLEL_SUBAGENTS_SKILL_ID],
        sandboxMode: settings.sandboxMode,
        approvalPolicy: settings.approvalPolicy,
        env,
        // Worker raw events stay out of the parent timeline (spec §8);
        // lifecycle events come from the broker, full text from result files.
        emit: () => {},
        signal: workerSignal
      })
    })
    : null;
  if (subagentBroker) {
    subagentBroker.start();
  } else if (!skillInstallTurn) {
    // No broker this run: remove any stale queue from a previous brokered run
    // so the model never reads a leftover closed handshake and reports the
    // feature as half-available (v1.6.1 — observed in E2E).
    fs.rmSync(path.join(mirror.workspacePath, SUBAGENT_QUEUE_DIR), { recursive: true, force: true });
  }
  let runnerResult;
  try {
    runnerResult = await runner({
      workspacePath: runnerWorkspacePath,
      task: buildCodexTurnPrompt(params, mirror, projectLocalSkills, turnAttachments, codexSkillInvocationContext),
      userTask: String(params.task || ''),
      session: params.session || null,
      threadId: params.threadId || '',
      mode: params.mode || 'auto',
      model: params.model || '',
      reasoningEffort: params.reasoningEffort || '',
      speedTier: normalizeSpeedTier(params.speedTier),
      loadCodexLocalSkills: skillLoading.loadCodexLocalSkills,
      loadCodexOverleafSkills: skillLoading.loadCodexOverleafSkills,
      skillInvocation: effectiveSkillInvocation,
      installCodexOverleafSkillsTarget: skillInstallTurn,
      projectLocalSkills: null,
      sandboxMode: settings.sandboxMode,
      approvalPolicy: settings.approvalPolicy,
      env,
      emit,
      // While subagent workers are active, the parent idle watchdog resets
      // instead of failing the run (spec P2-7 fix).
      hasExternalActivity: subagentBroker ? () => subagentBroker.hasActiveWorkers() : undefined,
      signal
    });
  } catch (error) {
    if (subagentBroker) {
      await subagentBroker.stop({ drain: false });
    }
    throw error;
  }
  // Parent turn finished: drain remaining workers so their edits are part of
  // the single mirror diff below, then close the queue.
  if (subagentBroker) {
    await subagentBroker.stop({ drain: true });
  }
  throwIfAborted(signal);

  if (skillInstallTurn) {
    return enforceNativeOkResponseBudget({
      status: 'completed',
      projectId: mirror.projectKey,
      workspacePath: mirror.workspacePath,
      assistantMessage: cleanAssistantMessage(runnerResult?.assistantMessage),
      threadId: runnerResult?.threadId || '',
      syncChanges: [],
      unsupportedChanges: []
    });
  }

  const collected = await collectMirrorChangesDetailed({
    projectId,
    rootDir
  });
  const filteredChanges = filterSyncChangesForFocus({
    changes: collected.changes || [],
    focusFiles: params.focusFiles || params.session?.focusFiles,
    restrictToFocusFiles: params.restrictToFocusFiles
  });
  let rawSyncChanges = filteredChanges.changes;
  const unsupportedChanges = [
    ...(collected.unsupportedChanges || []),
    ...filteredChanges.unsupportedChanges
  ];
  // Spec S8: ownership violations hard-block writeback. Changes on violated
  // paths are demoted to unsupportedChanges (surfaced, never auto-applied) —
  // this must hold even when requireReviewing is off and ordinary
  // syncChanges would write directly.
  const subagentViolationPaths = subagentBroker ? subagentBroker.getViolationPaths() : null;
  if (subagentViolationPaths && subagentViolationPaths.size) {
    const blocked = rawSyncChanges.filter(change => subagentViolationPaths.has(change.path));
    rawSyncChanges = rawSyncChanges.filter(change => !subagentViolationPaths.has(change.path));
    for (const change of blocked) {
      unsupportedChanges.push({
        type: 'unsupported-local-file',
        path: change.path,
        reason: 'subagent_unauthorized_edit'
      });
    }
  }
  if (rawSyncChanges.length || unsupportedChanges.length) {
    markMirrorDirty({
      projectId,
      rootDir,
      reason: params.mode === 'ask' ? 'ask_mode_local_changes' : 'codex_run_local_changes'
    });
  }
  throwIfAborted(signal);

  if (params.mode === 'ask') {
    emitCodexEvent(emit, 'overleaf.sync.changes', 'Ask mode finished without Overleaf writeback', {
      changedCount: 0,
      files: [],
      unsupportedCount: 0,
      unsupportedFiles: [],
      ignoredChangedCount: rawSyncChanges.length,
      ignoredUnsupportedCount: unsupportedChanges.length
    }, rawSyncChanges.length || unsupportedChanges.length ? 'warning' : 'completed');
    return enforceNativeOkResponseBudget({
      status: 'completed',
      projectId: mirror.projectKey,
      workspacePath: mirror.workspacePath,
      assistantMessage: cleanAssistantMessage(runnerResult?.assistantMessage),
      threadId: runnerResult?.threadId || '',
      syncChanges: [],
      unsupportedChanges: []
    });
  }

  const syncChanges = rawSyncChanges.map(change => {
    if (change.type === 'write' && typeof change.previousContent === 'string') {
      return {
        ...change,
        diff: computeLineDiff(change.previousContent, change.content),
        patches: computeTextPatches(change.previousContent, change.content)
      };
    }
    return change;
  });
  const response = enforceNativeOkResponseBudget({
    status: 'completed',
    projectId: mirror.projectKey,
    workspacePath: mirror.workspacePath,
    assistantMessage: cleanAssistantMessage(runnerResult?.assistantMessage),
    threadId: runnerResult?.threadId || '',
    syncChanges,
    unsupportedChanges
  });

  emitCodexEvent(emit, 'overleaf.sync.changes', 'Local Codex changes collected for Overleaf sync', {
    changedCount: response.syncChanges.length,
    files: response.syncChanges.map(change => change.path),
    unsupportedCount: response.unsupportedChanges.length,
    unsupportedFiles: response.unsupportedChanges.map(change => change.path)
  }, 'completed');

  return response;
}

function buildCodexTurnPrompt(params = {}, mirror = {}, projectLocalSkills, turnAttachments = [], codexSkillInvocationContext = null) {
  const prompt = buildCodexPromptParts({
    params,
    mirror,
    projectLocalSkills,
    turnAttachments,
    codexSkillInvocationContext
  });
  return [prompt.systemPrompt, prompt.userPrompt].filter(Boolean).join('\n\n');
}

function materializeTurnAttachments(attachments = [], workspacePath = '') {
  if (!workspacePath) {
    return [];
  }
  const attachmentDir = path.join(workspacePath, TURN_ATTACHMENTS_DIR);
  fs.rmSync(attachmentDir, { recursive: true, force: true });

  const normalized = normalizeTurnAttachments(attachments);
  if (!normalized.length) {
    return [];
  }

  fs.mkdirSync(attachmentDir, { recursive: true });
  const usedNames = new Set();
  return normalized.map(attachment => {
    const fileName = dedupeAttachmentFileName(attachment.name, usedNames);
    const target = path.join(attachmentDir, fileName);
    const resolvedTarget = path.resolve(target);
    const resolvedDir = path.resolve(attachmentDir);
    if (!resolvedTarget.startsWith(resolvedDir + path.sep)) {
      throw new Error('Unsafe attachment path');
    }
    fs.writeFileSync(target, attachment.bytes);
    return {
      name: fileName,
      path: `${TURN_ATTACHMENTS_DIR}/${fileName}`,
      mimeType: attachment.mimeType,
      size: attachment.bytes.length
    };
  });
}

function normalizeTurnAttachments(value) {
  const input = Array.isArray(value) ? value : [];
  if (input.length > MAX_TURN_ATTACHMENTS) {
    throw new Error(`Too many attachments (${input.length}/${MAX_TURN_ATTACHMENTS})`);
  }
  const result = [];
  let totalBytes = 0;
  for (const item of input) {
    const name = sanitizeAttachmentFileName(item?.name);
    const contentBase64 = String(item?.contentBase64 || '').replace(/\s+/g, '');
    if (!name || !contentBase64) {
      continue;
    }
    const declared = Number(item?.size);
    const estimatedBytes = Math.max(
      Number.isFinite(declared) && declared > 0 ? declared : 0,
      estimateBase64DecodedBytes(contentBase64)
    );
    if (estimatedBytes > MAX_TURN_ATTACHMENT_BYTES) {
      throw new Error(`Attachment is too large: ${name}`);
    }
    const bytes = Buffer.from(contentBase64, 'base64');
    if (!bytes.length) {
      continue;
    }
    if (bytes.length > MAX_TURN_ATTACHMENT_BYTES) {
      throw new Error(`Attachment is too large: ${name}`);
    }
    totalBytes += Math.max(estimatedBytes, bytes.length);
    if (totalBytes > MAX_TURN_ATTACHMENT_TOTAL_BYTES) {
      throw new Error(`Attachments are too large (${totalBytes}/${MAX_TURN_ATTACHMENT_TOTAL_BYTES} bytes)`);
    }
    result.push({
      name,
      mimeType: String(item?.mimeType || '').trim().slice(0, 120),
      bytes
    });
  }
  return result;
}

function estimateBase64DecodedBytes(value) {
  const clean = String(value || '').replace(/\s+/g, '');
  if (!clean) {
    return 0;
  }
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(clean.length * 3 / 4) - padding);
}

function sanitizeAttachmentFileName(value) {
  const basename = String(value || '')
    .replace(/\0/g, '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .pop()
    ?.trim()
    .slice(0, 180) || '';
  return basename.replace(/[/:]/g, '-');
}

function dedupeAttachmentFileName(name, usedNames) {
  let candidate = name || 'attachment';
  if (!usedNames.has(candidate)) {
    usedNames.add(candidate);
    return candidate;
  }
  const parsed = path.parse(candidate);
  let index = 2;
  do {
    candidate = `${parsed.name}-${index}${parsed.ext}`;
    index += 1;
  } while (usedNames.has(candidate));
  usedNames.add(candidate);
  return candidate;
}

function normalizeFocusFiles(value) {
  const seen = new Set();
  const files = [];
  for (const item of Array.isArray(value) ? value : []) {
    const filePath = normalizeProjectPath(item);
    if (!filePath || seen.has(filePath)) {
      continue;
    }
    seen.add(filePath);
    files.push(filePath);
    if (files.length >= 8) {
      break;
    }
  }
  return files;
}

function filterSyncChangesForFocus({ changes = [], focusFiles = [], restrictToFocusFiles = false } = {}) {
  if (!restrictToFocusFiles) {
    return { changes, unsupportedChanges: [] };
  }
  const focusSet = new Set(normalizeFocusFiles(focusFiles));
  if (!focusSet.size) {
    return { changes, unsupportedChanges: [] };
  }

  const accepted = [];
  const rejected = [];
  for (const change of changes || []) {
    if (focusSet.has(normalizeProjectPath(change?.path))) {
      accepted.push(change);
    } else if (change?.path) {
      rejected.push({
        type: 'ignored-local-change',
        path: change.path,
        reason: 'out_of_focus_partial_snapshot'
      });
    }
  }
  return {
    changes: accepted,
    unsupportedChanges: rejected
  };
}

function normalizeProjectPath(value) {
  return String(value || '')
    .replace(/^@file:/i, '')
    .replace(/\\/g, '/')
    .trim()
    .replace(/^\/+/, '');
}

function loadProjectLocalSkillsContext(params = {}, mirror = {}) {
  const selectedSkillIds = Array.isArray(params.selectedSkillIds) ? params.selectedSkillIds : [];
  if (!selectedSkillIds.length) {
    return { skills: [], missing: [], selected: [] };
  }
  const projectId = mirror.projectKey || params.projectId || params.project?.id || params.project?.projectId;
  return loadSelectedProjectSkills({
    projectId,
    selectedSkillIds,
    rootDir: params.rootDir,
    projectRoot: mirror.projectRoot
  });
}

function normalizeSkillLoadingSettings(params = {}) {
  return {
    loadCodexLocalSkills: params.loadCodexLocalSkills !== false,
    loadCodexOverleafSkills: params.loadCodexOverleafSkills !== false
  };
}

function loadCodexSkillInvocationContext({
  skillInvocation,
  loadCodexOverleafSkills = true,
  enabledCodexOverleafSkillIds,
  env = process.env,
  emit = () => {}
} = {}) {
  const invocation = normalizeSkillInvocation(skillInvocation);
  if (!invocation) {
    return { invocation: null, skill: null, missing: [], ignored: [] };
  }
  if (isSkillInstallerInvocation(invocation)) {
    return { invocation, skill: null, missing: [], ignored: [] };
  }

  const result = loadSelectedCodexOverleafSkill({
    skillId: invocation.id,
    loadCodexOverleafSkills,
    enabledCodexOverleafSkillIds,
    env
  });
  if (result.missing.length) {
    emitCodexEvent(emit, 'codex.overleaf_skills.missing', 'Selected Codex Overleaf skill was missing', {
      missingSkillIds: result.missing
    }, 'failed');
  }
  if (result.ignored.length) {
    emitCodexEvent(emit, 'codex.overleaf_skill_invocation.ignored', 'Selected Codex Overleaf skill was ignored', {
      ignoredSkillIds: result.ignored.map(item => item.id),
      reason: result.ignored[0]?.reason || 'ignored'
    }, 'warning');
  }

  return {
    invocation,
    skill: result.skill,
    missing: result.missing,
    ignored: result.ignored
  };
}

function getEffectiveSkillInvocation(context = {}) {
  const invocation = normalizeSkillInvocation(context.invocation);
  if (!invocation) {
    return null;
  }
  if (isSkillInstallerInvocation(invocation)) {
    return invocation;
  }
  return context.skill ? invocation : null;
}

function normalizeSkillInvocation(value) {
  const id = String(value?.id || '').trim();
  if (!isSafeSkillId(id)) {
    return null;
  }
  const title = String(value?.title || 'Skill Installer').trim().slice(0, 80) || 'Skill Installer';
  if (id === 'skill-installer') {
    return { id, title };
  }
  if (value?.scope !== 'codex-overleaf') {
    return null;
  }
  return { id, title, scope: 'codex-overleaf' };
}

function isSkillInstallerInvocation(value) {
  return normalizeSkillInvocation(value)?.id === 'skill-installer';
}

function isSafeSkillId(id) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(String(id || ''))
    && !String(id || '').includes('..');
}

function buildCodexSettings(params = {}) {
  if (isSkillInstallerInvocation(params.skillInvocation)) {
    return {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never'
    };
  }
  if (params.mode === 'ask') {
    return {
      sandboxMode: 'read-only',
      approvalPolicy: 'never'
    };
  }
  return {
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never'
  };
}

function buildThreadStartParams(input = {}) {
  return {
    cwd: input.workspacePath,
    model: input.model || null,
    approvalPolicy: input.approvalPolicy,
    sandbox: input.sandboxMode,
    experimentalRawEvents: false
  };
}

function buildThreadResumeParams(input = {}) {
  return {
    threadId: input.threadId,
    cwd: input.workspacePath,
    model: input.model || null,
    approvalPolicy: input.approvalPolicy,
    sandbox: input.sandboxMode
  };
}

function buildCodexAppServerArgs(input = {}) {
  const args = [
    ...buildCodexSpeedArgs(normalizeSpeedTier(input.speedTier))
  ];
  if (input.loadCodexLocalSkills === false) {
    args.push('--disable', 'plugins');
  }
  args.push(
    'app-server',
    '--listen',
    'stdio://'
  );
  return [
    ...args
  ];
}

async function applyCodexSkillIsolation({ input = {}, childEnv = process.env, request, emit = () => {} } = {}) {
  if (input.loadCodexLocalSkills !== false) {
    return { disabled: [] };
  }
  if (typeof request !== 'function') {
    throw new Error('Codex skill isolation requires an app-server request function');
  }

  const listResult = await request('skills/list', {
    cwd: input.workspacePath,
    includeDisabled: true
  });
  const skills = flattenCodexSkillsList(listResult);
  const disabled = [];
  for (const skill of skills) {
    if (skill?.enabled === false || !shouldDisableCodexSkillForIsolation(skill, input, childEnv)) {
      continue;
    }
    const params = buildSkillDisableParams(skill);
    if (!params) {
      continue;
    }
    await request('skills/config/write', params);
    disabled.push(String(skill.name || skill.path || '').trim());
  }
  if (disabled.length) {
    emitCodexEvent(emit, 'codex.skill_isolation.applied', 'Disabled non-Overleaf Codex skills for this turn', {
      disabledSkillNames: disabled.filter(Boolean)
    }, 'completed');
  }
  return { disabled };
}

// Recursion guard (spec S6): disable specific Codex-Overleaf skills for one
// app-server child process — used to strip `parallel-subagents` from worker
// runs so an inheriting worker cannot discover the queue and fan out again.
// Skill directories are named by skill id (<root>/<id>/SKILL.md).
async function applyWorkerSkillStrip({ input = {}, request } = {}) {
  const ids = Array.isArray(input.disableCodexOverleafSkillIds)
    ? input.disableCodexOverleafSkillIds.filter(Boolean)
    : [];
  if (!ids.length || typeof request !== 'function') {
    return { disabled: [] };
  }
  const listResult = await request('skills/list', {
    cwd: input.workspacePath,
    includeDisabled: true
  });
  const disabled = [];
  for (const skill of flattenCodexSkillsList(listResult)) {
    if (skill?.enabled === false) {
      continue;
    }
    const skillDirName = path.basename(path.dirname(String(skill?.path || '')));
    if (!ids.includes(skillDirName)) {
      continue;
    }
    const params = buildSkillDisableParams(skill);
    if (!params) {
      continue;
    }
    await request('skills/config/write', params);
    disabled.push(skillDirName);
  }
  return { disabled };
}

function flattenCodexSkillsList(listResult = {}) {
  const data = Array.isArray(listResult?.data) ? listResult.data : [];
  return data.flatMap(entry => Array.isArray(entry?.skills) ? entry.skills : []);
}

function shouldDisableCodexSkillForIsolation(skill = {}, input = {}, childEnv = process.env) {
  if (isCodexSystemSkill(skill)) {
    return !isAllowedSystemSkillForIsolation(skill, input);
  }
  return !isAllowedCodexOverleafSkillPath(skill.path, input, childEnv);
}

function isCodexSystemSkill(skill = {}) {
  return String(skill.scope || '') === 'system' || isSystemSkillPath(skill.path);
}

function isAllowedSystemSkillForIsolation(skill = {}, input = {}) {
  return input.installCodexOverleafSkillsTarget === true && String(skill.name || '') === 'skill-installer';
}

function isAllowedCodexOverleafSkillPath(skillPath, input = {}, childEnv = process.env) {
  if (input.loadCodexOverleafSkills === false && input.installCodexOverleafSkillsTarget !== true) {
    return false;
  }
  const pathText = String(skillPath || '');
  if (!pathText || !path.isAbsolute(pathText) || isSystemSkillPath(pathText)) {
    return false;
  }
  const roots = [
    path.join(String(childEnv.CODEX_HOME || ''), 'skills'),
    getCodexOverleafSkillsRoot({ env: childEnv })
  ].filter(Boolean);
  return roots.some(root => isInsideOrSamePath(pathText, root));
}

function isSystemSkillPath(skillPath) {
  return String(skillPath || '').split(path.sep).includes('.system');
}

function buildSkillDisableParams(skill = {}) {
  const name = String(skill.name || '').trim();
  if (isCodexSystemSkill(skill) && name) {
    return { name, enabled: false };
  }
  const skillPath = String(skill.path || '').trim();
  if (path.isAbsolute(skillPath)) {
    return { path: skillPath, enabled: false };
  }
  if (name) {
    return { name, enabled: false };
  }
  return null;
}

function isInsideOrSamePath(target, root) {
  const targetPaths = comparablePaths(target);
  const rootPaths = comparablePaths(root);
  return targetPaths.some(targetPath => rootPaths.some(rootPath => (
    targetPath === rootPath || targetPath.startsWith(rootPath + path.sep)
  )));
}

function comparablePaths(value) {
  const resolved = path.resolve(String(value || ''));
  const candidates = [resolved];
  try {
    candidates.push(fs.realpathSync.native(resolved));
  } catch (_) {
    // Fall back to the lexical path when the file is not present yet.
  }
  return Array.from(new Set(candidates));
}

function buildTurnStartParams(input = {}, threadId = input.threadId || '') {
  const params = {
    threadId,
    input: [
      {
        type: 'text',
        text: input.task,
        text_elements: []
      }
    ],
    cwd: input.workspacePath,
    model: input.model || null,
    effort: normalizeReasoningEffort(input.reasoningEffort)
  };
  if (supportsReasoningSummary(input.model)) {
    params.summary = 'detailed';
  }
  return params;
}

function supportsReasoningSummary(model) {
  return String(model || '').toLowerCase() !== 'gpt-5.3-codex-spark';
}

function runCodexAppServerSession(input) {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(getAbortReason(input.signal));
      return;
    }
    const childEnv = buildCodexHomeEnv(input.env || process.env, {
      loadCodexLocalSkills: input.loadCodexLocalSkills !== false,
      loadCodexOverleafSkills: input.loadCodexOverleafSkills !== false,
      installCodexOverleafSkillsTarget: input.installCodexOverleafSkillsTarget === true,
      projectLocalSkills: input.projectLocalSkills || null
    });
    const codexCommand = resolveCodexCommand(childEnv);
    if (!codexCommand) {
      reject(new Error('Codex CLI was not found. Install Codex or make sure the `codex` command is available in your login shell.'));
      return;
    }

    const child = spawn(codexCommand, buildCodexAppServerArgs(input), {
      env: childEnv,
      shell: shouldUseShellForCommand(codexCommand, childEnv),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const pending = new Map();
    let nextId = 1;
    let stdoutBuffer = '';
    let stderr = '';
    let activeThreadId = '';
    let activeTurnId = '';
    const assistantMessages = new Map();
    const assistantMessageOrder = [];
    let settled = false;
    // Two-layer timeout strategy:
    //   1. Optional absolute deadline (CODEX_OVERLEAF_CODEX_TIMEOUT_MS) —
    //      legacy override; off by default. When set, the whole run must
    //      finish within that envelope.
    //   2. Idle watchdog — fires after a stretch of silence from the
    //      app-server (no stdout / no messages). Default 10 minutes; the
    //      runtime resets it on every incoming line and on every outgoing
    //      request. This catches the failure mode where Codex sends
    //      turn/started, then hangs without ever emitting completed/error
    //      and the project lock would otherwise be held forever.
    const timeout = createOptionalTimeout(childEnv.CODEX_OVERLEAF_CODEX_TIMEOUT_MS, timeoutMs => {
      fail(new Error(`Codex app-server did not complete within configured timeout (${timeoutMs}ms)`));
    });
    const idleTimeoutMs = parseOptionalPositiveInteger(childEnv.CODEX_OVERLEAF_CODEX_IDLE_TIMEOUT_MS) || 600000;
    const idleWatchdog = createCodexIdleWatchdog(idleTimeoutMs, ms => {
      // While the subagent broker reports active workers the parent may be
      // legitimately quiet (waiting on results); reset instead of failing
      // (spec P2-7). The broker's own wall-clock deadlines bound the wait.
      if (input.hasExternalActivity?.()) {
        idleWatchdog.reset();
        return;
      }
      fail(new Error(`Codex app-server produced no events for ${ms}ms (idle watchdog); the run was aborted to release the project lock.`));
    });
    const onAbort = () => {
      fail(getAbortReason(input.signal));
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      idleWatchdog.reset();
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) {
          handleMessage(line);
        }
      }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', fail);
    child.on('close', code => {
      if (settled) {
        return;
      }
      fail(new Error(stderr || `codex app-server exited before turn completed with code ${code}`));
    });

    start().catch(fail);

    async function start() {
      await request('initialize', {
        clientInfo: {
          name: 'codex-overleaf-link',
          version: PACKAGE_VERSION
        },
        capabilities: null
      });
      notify('initialized');
      await applyCodexSkillIsolation({
        input,
        childEnv,
        request,
        emit: input.emit
      });
      await applyWorkerSkillStrip({
        input,
        request
      });

      if (input.threadId) {
        try {
          const resumeResponse = await request('thread/resume', buildThreadResumeParams(input));
          activeThreadId = resumeResponse?.thread?.id || resumeResponse?.threadId || input.threadId;
        } catch (resumeError) {
          const error = new Error(resumeError.message || 'thread/resume failed');
          error.code = 'thread_resume_failed';
          throw error;
        }
      } else {
        const threadResponse = await request('thread/start', buildThreadStartParams(input));
        activeThreadId = threadResponse?.thread?.id || threadResponse?.threadId || '';
        if (!activeThreadId) {
          throw new Error('Codex app-server did not return a thread id');
        }
      }

      const turnResponse = await startTurnWithSummaryFallback(activeThreadId);
      activeTurnId = turnResponse?.turn?.id || '';
    }

    async function startTurnWithSummaryFallback(threadId) {
      const params = buildTurnStartParams(input, threadId);
      try {
        return await request('turn/start', params);
      } catch (error) {
        if (!params.summary || !isUnsupportedReasoningSummaryError(error)) {
          throw error;
        }
        emitCodexEvent(input.emit, 'codex.session.event', 'reasoning summary unsupported; retrying without it', {
          method: 'turn/start',
          params: {
            model: input.model || '',
            retriedWithoutSummary: true
          }
        }, 'completed');
        const retryParams = { ...params };
        delete retryParams.summary;
        return request('turn/start', retryParams);
      }
    }

    function request(method, params) {
      const id = nextId++;
      const message = { id, method, params };
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return new Promise((resolveRequest, rejectRequest) => {
        pending.set(id, {
          resolve: resolveRequest,
          reject: rejectRequest
        });
      });
    }

    function notify(method, params) {
      child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    }

    function response(id, result) {
      child.stdin.write(`${JSON.stringify({ id, result })}\n`);
    }

    function handleMessage(line) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        emitCodexEvent(input.emit, 'codex.session.raw', 'Codex app-server emitted non-JSON output', {
          text: truncateText(line, 1000)
        });
        return;
      }

      if (Object.prototype.hasOwnProperty.call(message, 'id') &&
        (Object.prototype.hasOwnProperty.call(message, 'result') || message.error)) {
        const pendingRequest = pending.get(message.id);
        if (!pendingRequest) {
          return;
        }
        pending.delete(message.id);
        if (message.error) {
          pendingRequest.reject(new Error(message.error.message || JSON.stringify(message.error)));
        } else {
          pendingRequest.resolve(message.result);
        }
        return;
      }

      if (Object.prototype.hasOwnProperty.call(message, 'id') && message.method) {
        handleServerRequest(message);
        return;
      }

      if (message.method) {
        recordAssistantMessage(message);
        // For `error` events surface the actual error text as the visible
        // title so the run timeline reads "Reconnecting... 2/5" instead of
        // a generic "error". Other methods continue to use the method name.
        const eventTitle = message.method === 'error'
          ? (extractCodexAppServerErrorMessage(message.params) || message.method)
          : message.method;
        emitCodexEvent(input.emit, 'codex.session.event', eventTitle, {
          method: message.method,
          params: message.params || {}
        }, inferNotificationStatus(message));
        if (message.method === 'turn/completed' && (!activeTurnId || message.params?.turn?.id === activeTurnId || message.params?.turnId === activeTurnId)) {
          succeed();
        }
        if (message.method === 'error' && isTransientCodexAppServerError(message.params)) {
          return;
        }
        if (message.method === 'error') {
          fail(new Error(message.params?.error?.message || 'Codex turn failed'));
        }
      }
    }

    function handleServerRequest(message) {
      emitCodexEvent(input.emit, 'codex.session.request', message.method, {
        method: message.method,
        params: message.params || {}
      }, 'running');

      if (/fileChange\/requestApproval/.test(message.method)) {
        if (isSkillInstallerInvocation(input.skillInvocation)) {
          response(message.id, { decision: 'decline', reason: 'Skill installation must not edit Overleaf workspace files.' });
          return;
        }
        response(message.id, { decision: input.mode === 'ask' ? 'decline' : 'accept' });
        return;
      }
      if (/commandExecution\/requestApproval/.test(message.method)) {
        response(message.id, decideCommandApproval({
          mode: input.mode,
          skillInvocation: input.skillInvocation,
          env: childEnv,
          workspacePath: input.workspacePath,
          params: message.params || {}
        }));
        return;
      }
      response(message.id, { decision: 'decline' });
    }

    function recordAssistantMessage(message) {
      const method = String(message.method || '');
      const params = message.params || {};
      const item = params.item || {};
      if (method === 'item/agentMessage/delta') {
        const itemId = String(params.itemId || item.id || 'current');
        const next = `${assistantMessages.get(itemId) || ''}${String(params.delta || '')}`;
        setAssistantMessage(itemId, next);
        return;
      }
      if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) {
        const itemId = String(item.id || params.itemId || 'current');
        setAssistantMessage(itemId, item.text);
      }
    }

    function setAssistantMessage(itemId, text) {
      if (!assistantMessages.has(itemId)) {
        assistantMessageOrder.push(itemId);
      }
      assistantMessages.set(itemId, text);
    }

    function succeed() {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      child.kill('SIGTERM');
      resolve({
        assistantMessage: buildFinalAssistantMessage(assistantMessages, assistantMessageOrder),
        threadId: activeThreadId
      });
    }

    function fail(error) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      for (const pendingRequest of pending.values()) {
        pendingRequest.reject(error);
      }
      pending.clear();
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGTERM');
      }
      reject(error);
    }

    function cleanup() {
      timeout.cancel();
      idleWatchdog.cancel();
      input.signal?.removeEventListener('abort', onAbort);
    }
  });
}

function decideCommandApproval({ mode = 'auto', params = {}, skillInvocation = null, env = process.env, workspacePath = '' } = {}) {
  if (isSkillInstallerInvocation(skillInvocation)) {
    return decideSkillInstallerCommandApproval({ params, env, workspacePath });
  }
  if (mode === 'ask') {
    return { decision: 'decline' };
  }
  return isAllowedLocalCommand(params)
    ? { decision: 'accept' }
    : {
      decision: 'decline',
      reason: 'Command is outside the Codex Overleaf local inspection/LaTeX allowlist.'
    };
}

function decideSkillInstallerCommandApproval({ params = {}, env = process.env, workspacePath = '' } = {}) {
  const command = extractCommandValue(params);
  const approval = evaluateSkillCommand({
    command,
    cwd: workspacePath
  }, {
    env,
    workspacePath,
    skillsRoot: getCodexOverleafSkillsRoot({ env })
  });
  return approval.approved
    ? { decision: 'accept' }
    : {
      decision: 'decline',
      reason: approval.reason
    };
}

function isAllowedLocalCommand(params = {}) {
  const command = extractCommandValue(params);
  if (typeof command === 'string' && hasUnsupportedShellSyntax(command)) {
    return false;
  }
  const tokens = Array.isArray(command) ? command.map(String) : tokenizeShellCommand(String(command || ''));
  if (!tokens.length) {
    return false;
  }

  const executable = pathBasename(tokens[0]);
  if (['bash', 'sh', 'zsh'].includes(executable)) {
    const inline = extractShellInlineCommand(tokens);
    return inline ? isAllowedLocalCommand({ command: inline }) : false;
  }

  const allowed = new Set([
    'rg', 'grep', 'cat', 'head', 'tail', 'nl', 'find', 'ls',
    'wc', 'diff', 'sort', 'tr', 'printf', 'cut', 'uniq',
    'stat', 'file', 'basename', 'dirname', 'realpath',
    'shasum', 'md5', 'md5sum',
    'latexmk', 'pdflatex', 'xelatex', 'lualatex', 'bibtex', 'biber',
    'kpsewhich', 'chktex', 'lacheck'
  ]);
  if (!allowed.has(executable)) {
    return false;
  }

  return !tokens.some(isUnsafeShellToken)
    && !hasDisallowedCommandArguments(executable, tokens.slice(1));
}

function extractCommandValue(params = {}) {
  if (Array.isArray(params.command) || typeof params.command === 'string') {
    return params.command;
  }
  if (Array.isArray(params.cmd) || typeof params.cmd === 'string') {
    return params.cmd;
  }
  if (Array.isArray(params.argv)) {
    return params.argv;
  }
  if (typeof params.shellCommand === 'string') {
    return params.shellCommand;
  }
  return '';
}

function extractShellInlineCommand(tokens = []) {
  const index = tokens.findIndex(token => token === '-c' || token === '-lc' || token === '-ilc');
  if (index < 0 || index + 1 >= tokens.length || tokens.length !== index + 2) {
    return '';
  }
  return tokens[index + 1];
}

function hasUnsupportedShellSyntax(command) {
  return hasAmbiguousShellEscape(command) || hasUnbalancedShellQuote(command);
}

function hasAmbiguousShellEscape(command) {
  return /\\["';&|<>`$(){}\n\r]/.test(command);
}

function hasUnbalancedShellQuote(command) {
  let quote = '';
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === '\\' && quote !== "'") {
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    }
  }
  return Boolean(quote);
}

function isUnsafeShellToken(token) {
  return ['&&', '||', ';', '|', '>', '>>', '<', '<<', '`'].includes(token)
    || /\$\(/.test(token);
}

function hasDisallowedCommandArguments(executable, args = []) {
  const flags = args.map(String);
  if (executable === 'find') {
    return flags.some(flag => [
      '-exec', '-execdir', '-delete', '-ok', '-okdir',
      '-fprint', '-fprint0', '-fprintf', '-fls'
    ].includes(flag));
  }
  if (executable === 'rg') {
    return flags.some(flag => flag === '--pre' || flag.startsWith('--pre='));
  }
  if (executable === 'sort') {
    return flags.some(flag => flag === '-o'
      || flag.startsWith('-o')
      || flag === '--output'
      || flag.startsWith('--output=')
      || flag === '-T'
      || flag.startsWith('-T')
      || flag === '--temporary-directory'
      || flag.startsWith('--temporary-directory='));
  }
  if (executable === 'latexmk') {
    return !flags.includes('-norc')
      || flags.some(isUnsafeLatexmkArgument)
      || flags.some(isUnsafeTexEngineArgument);
  }
  if (['pdflatex', 'xelatex', 'lualatex'].includes(executable)) {
    if (executable === 'lualatex' && !flags.some(flag => flag === '--safer' || flag === '-safer')) {
      return true;
    }
    return flags.some(isUnsafeTexEngineArgument);
  }
  if (executable === 'shasum' || executable === 'md5sum') {
    return flags.some(flag => flag === '-c' || flag === '--check');
  }
  return false;
}

function isUnsafeLatexmkArgument(value) {
  const flag = String(value || '').toLowerCase();
  return /^-(?:e|r)(?:$|=)/.test(flag)
    || /^-(?:usepretex|useposttex)(?:$|=)/.test(flag)
    || /^-(?:pdflatex|xelatex|lualatex|latex|bibtex|biber|makeindex|dvi_filter|ps_filter|pdf_previewer)(?:$|=)/.test(flag);
}

function isUnsafeTexEngineArgument(value) {
  const flag = String(value || '').toLowerCase();
  if (/(?:shell-escape|shell-restricted|write18)/.test(flag)) {
    return true;
  }
  if (/^--?(?:output-directory|aux-directory|outdir|auxdir)(?:$|=)/.test(flag)) {
    return true;
  }
  if (flag === '-jobname' || flag === '--jobname') {
    return true;
  }
  const jobName = flag.match(/^--?jobname=(.*)$/)?.[1] || '';
  return Boolean(jobName && (jobName.includes('..') || /[\\/]/.test(jobName)));
}

function pathBasename(value) {
  return String(value || '').split(/[\\/]/).pop();
}

function tokenizeShellCommand(command) {
  const tokens = [];
  let current = '';
  let quote = '';
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = '';
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    if (char === '&' && command[index + 1] === '&') {
      if (current) tokens.push(current);
      tokens.push('&&');
      current = '';
      index += 1;
      continue;
    }
    if (char === '|' && command[index + 1] === '|') {
      if (current) tokens.push(current);
      tokens.push('||');
      current = '';
      index += 1;
      continue;
    }
    if (';|<>`'.includes(char)) {
      if (current) tokens.push(current);
      tokens.push(char);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function createOptionalTimeout(value, onTimeout) {
  const timeoutMs = parseOptionalPositiveInteger(value);
  if (!timeoutMs) {
    return {
      cancel() {}
    };
  }
  const timer = setTimeout(() => onTimeout(timeoutMs), timeoutMs);
  return {
    cancel() {
      clearTimeout(timer);
    }
  };
}

// Idle-style watchdog: fires only after the app-server has been silent for
// `idleMs`. Callers must invoke .reset() on every signal of liveness
// (incoming line, outgoing request). cancel() stops the timer on settle.
// Returns no-op when idleMs is non-positive (defensive guard against bad env
// var values).
function createCodexIdleWatchdog(idleMs, onIdle) {
  if (!(idleMs > 0)) {
    return {
      reset() {},
      cancel() {}
    };
  }
  let timer = setTimeout(() => onIdle(idleMs), idleMs);
  return {
    reset() {
      clearTimeout(timer);
      timer = setTimeout(() => onIdle(idleMs), idleMs);
    },
    cancel() {
      clearTimeout(timer);
    }
  };
}

function parseOptionalPositiveInteger(value) {
  if (value === undefined || value === null || value === '') {
    return 0;
  }
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) {
    return;
  }
  throw getAbortReason(signal);
}

function getAbortReason(signal) {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error('Codex run was cancelled by the user');
  error.code = 'codex_cancelled';
  return error;
}

function buildFinalAssistantMessage(messages = new Map(), order = []) {
  const values = [];
  const seenIds = new Set();
  const ids = order.length ? order : Array.from(messages.keys());

  for (const id of ids) {
    seenIds.add(id);
    addAssistantMessage(values, messages.get(id));
  }
  for (const [id, value] of messages) {
    if (!seenIds.has(id)) {
      addAssistantMessage(values, value);
    }
  }

  return values.join('\n\n');
}

function addAssistantMessage(values, value) {
  const clean = cleanAssistantMessage(value);
  if (clean && !values.includes(clean)) {
    values.push(clean);
  }
}

function emitCodexEvent(emit, type, title, detail = {}, status = 'running') {
  emit({
    type,
    title,
    status,
    detail,
    timestamp: new Date().toISOString()
  });
}

function inferNotificationStatus(message) {
  if (message.method === 'error' && isTransientCodexAppServerError(message.params)) {
    return 'warning';
  }
  if (/completed|updated|delta|started/.test(message.method || '')) {
    return /completed/.test(message.method || '') ? 'completed' : 'running';
  }
  return 'running';
}

function isTransientCodexAppServerError(params = {}) {
  const message = extractCodexAppServerErrorMessage(params);
  return /^Reconnecting(?:\.\.\.|…)?\s+\d+\s*\/\s*\d+\.?$/i.test(message);
}

function extractCodexAppServerErrorMessage(params = {}) {
  const candidates = [
    params?.error?.message,
    params?.message,
    params?.title,
    params?.error
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return '';
}

function normalizeReasoningEffort(value) {
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value) ? value : null;
}

function normalizeSpeedTier(value) {
  return value === 'fast' ? 'fast' : 'standard';
}

function isUnsupportedReasoningSummaryError(error) {
  const message = String(error?.message || error || '');
  return /unsupported_parameter/i.test(message) && /reasoning\.summary|summary/i.test(message);
}

function cleanAssistantMessage(value) {
  return String(value || '').trim();
}

module.exports = {
  applyCodexSkillIsolation,
  buildCodexTurnPrompt,
  buildCodexAppServerArgs,
  buildFinalAssistantMessage,
  buildCodexSettings,
  buildThreadStartParams,
  buildThreadResumeParams,
  buildTurnStartParams,
  createOptionalTimeout,
  decideCommandApproval,
  runCodexAppServerSession,
  runCodexSession
};
