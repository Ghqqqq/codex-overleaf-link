'use strict';

const { truncateText } = require('./debugLog');
const { formatOverleafWorkspaceRules } = require('./overleafWorkspaceRules');
const { buildReadProgressRules } = require('./readProgressGuard');

const PROJECT_CUSTOM_INSTRUCTIONS_MAX_CHARS = 12000;
const NATIVE_MESSAGE_PROMPT_MAX_CHARS = 1024 * 1024;

/** Stable parent-thread guidance; the active mode and task belong to the turn. */
function buildCodexDeveloperInstructions(options = {}) {
  const params = options.params && typeof options.params === 'object' ? options.params : options;
  const locale = (options.locale ?? params.locale) === 'zh' ? 'Chinese (zh)' : 'English (en)';
  const skillInvocation = options.skillInvocation || params.skillInvocation;
  return [
    'You are Codex working inside the Codex Overleaf Link panel, helping an academic author with their LaTeX project in Overleaf. The user reads your answer in a narrow (~380px) side panel.',
    [
      'Reply language and style:',
      `- Reply in the language of the user's latest request. If unclear, use the UI language: ${locale}. Keep LaTeX source, file paths, and identifiers unchanged.`,
      '- Lead with the answer or outcome. Use short paragraphs and lists; avoid wide tables and long code dumps. Do not restate the request.',
      '- Complete the requested analysis or edit within this turn. Do not end with only a plan or a promise to act later.',
      '- For edits, summarize what changed per file with citations. The panel already shows written files, diffs, and Undo; do not paste whole diffs.'
    ].join('\n'),
    ...(isSkillInstallerInvocation(skillInvocation) ? [] : [formatOverleafWorkspaceRules()]),
    ['Project location citation rules:', formatProjectLocationCitationRules()].join('\n'),
    ['Answer formatting:', formatMathOutputRules()].join('\n'),
    [
      'Academic integrity:',
      '- Never invent citations, BibTeX entries, data, results, or quotations.',
      '- When a claim needs a source you cannot verify in the project, say so and suggest what kind of source is needed instead of adding one.'
    ].join('\n'),
    [
      'Editing discipline for writable turns:',
      '- Change only what the request needs. Keep unrelated text, whitespace, and formatting untouched; small diffs keep Overleaf tracked changes and Undo reviewable.',
      '- Keep \\label, \\ref, and \\cite keys and file names stable unless asked to change them.',
      '- Keep the document compilable, with balanced braces and environments.'
    ].join('\n'),
    [
      'Modes:',
      '- Each turn states its active mode. These modes govern project work; explicit skill-install turns follow their separate installation scope.',
      '- Ask is read-only: inspect and explain. When suggesting edits, show short LaTeX snippets with citations and mention that Auto mode can apply them.',
      '- Auto may edit the local workspace. The browser bridge handles authorization, deletion approval, and syncing to Overleaf.'
    ].join('\n'),
    buildReadProgressRules()
  ].join('\n\n');
}

/** Build dynamic per-turn context and the current user request. */
function buildCodexTurnPrompt(options = {}) {
  const context = normalizePromptOptions(options);
  const sections = [
    `Mode for this turn: ${context.mode}`,
    ['Write expectation for this turn:', formatWriteExpectation(context)].join('\n')
  ];
  if (!isSkillInstallerInvocation(context.skillInvocation)) {
    sections.push([
      'Current Overleaf workspace:',
      ...(context.projectKey || context.projectId ? [`- Project: ${context.projectKey || context.projectId}`] : []),
      ...formatWorkspaceSnapshotContext(context.unreadFiles)
    ].join('\n'));
  }
  if (!context.threadId && Array.isArray(context.session.history) && context.session.history.length) {
    sections.push(['Recent turns in this UI session:', formatSessionHistory(context.session.history)].join('\n'));
  }
  if (context.focusFiles.length) {
    sections.push(['Focus files:', formatFocusFiles(context.focusFiles)].join('\n'));
  }
  if (String(context.compileLog || '').trim()) {
    sections.push(['Compilation context (@compile-log):', formatCompileLogContext(context)].join('\n'));
  }
  if (String(context.customInstructions || '').trim()) {
    sections.push(['Project custom instructions:', formatCustomInstructionsContext(context.customInstructions)].join('\n'));
  }
  if (context.selectedSkillIds.length && (context.projectLocalSkills.skills?.length || context.projectLocalSkills.missing?.length)) {
    sections.push(['Project local skills:', formatProjectLocalSkillsContext(context)].join('\n'));
  }
  if (normalizeSkillInvocation(context.skillInvocation) || normalizeSkillInvocation(context.codexSkillInvocationContext?.invocation)
      || context.codexSkillInvocationContext?.ignored?.length || context.codexSkillInvocationContext?.missing?.length) {
    sections.push(['Selected Codex skill:', formatSkillInvocationContext(context)].join('\n'));
  }
  if (context.attachments.length) {
    sections.push(['Attachments for this turn:', formatTurnAttachmentsContext(context.attachments)].join('\n'));
  }
  const systemPrompt = sections.join('\n\n');
  const userPrompt = ['Current user request:', context.userTask || '(empty request)'].join('\n');
  return { systemPrompt, userPrompt };
}

/**
 * Validate prompt size against native messaging limits.
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {string} developerInstructions
 * @returns {{ ok: boolean, totalChars: number, exceedsLimit: boolean }}
 */
function validatePromptSize(systemPrompt, userPrompt, developerInstructions = '') {
  const totalChars = String(systemPrompt || '').length + String(userPrompt || '').length
    + String(developerInstructions || '').length;
  const exceedsLimit = totalChars > NATIVE_MESSAGE_PROMPT_MAX_CHARS;
  return {
    ok: !exceedsLimit,
    totalChars,
    exceedsLimit
  };
}

function normalizePromptOptions(options = {}) {
  const params = options.params && typeof options.params === 'object' ? options.params : options;
  const mirror = options.mirror || {};
  const session = options.session || params.session || {};
  const skills = normalizeLoadedSkills(
    options.skills || options.projectLocalSkills?.skills || options.localSkills?.skills || []
  );
  const selectedSkillIds = Array.isArray(options.selectedSkillIds)
    ? options.selectedSkillIds
    : Array.isArray(params.selectedSkillIds)
      ? params.selectedSkillIds
      : skills.map(skill => skill.id).filter(Boolean);
  const projectLocalSkills = options.projectLocalSkills || options.localSkills || {
    skills,
    missing: [],
    selected: selectedSkillIds
  };
  const compileContext = options.compileContext || {};
  const activePath = normalizeProjectPath(options.activePath || params.activePath || params.project?.activePath);
  const contextFiles = options.contextFiles || params.contextFiles || params.focusFiles || session.focusFiles;
  const focusFiles = normalizeFocusFiles(contextFiles);
  if (activePath && !focusFiles.includes(activePath)) {
    focusFiles.unshift(activePath);
  }

  return {
    params,
    session,
    threadId: String(options.threadId ?? params.threadId ?? '').trim(),
    projectKey: mirror.projectKey || options.projectKey || params.projectId || params.project?.id || params.project?.projectId,
    projectId: options.projectId || params.projectId || params.project?.id || params.project?.projectId,
    workspacePath: mirror.workspacePath || options.workspacePath || '',
    unreadFiles: Array.isArray(mirror.skippedFiles) ? mirror.skippedFiles : [],
    userTask: String(options.task !== undefined ? options.task : params.task || '').trim(),
    mode: options.mode || params.mode || 'auto',
    customInstructions: options.customInstructions !== undefined ? options.customInstructions : params.customInstructions,
    selectedSkillIds,
    projectLocalSkills,
    loadCodexLocalSkills: options.loadCodexLocalSkills !== undefined
      ? options.loadCodexLocalSkills
      : params.loadCodexLocalSkills !== false,
    loadCodexOverleafSkills: options.loadCodexOverleafSkills !== undefined
      ? options.loadCodexOverleafSkills
      : params.loadCodexOverleafSkills !== false,
    skillInvocation: options.skillInvocation || params.skillInvocation || null,
    codexSkillInvocationContext: options.codexSkillInvocationContext || null,
    attachments: options.turnAttachments || options.attachments || [],
    focusFiles: focusFiles.slice(0, 8),
    compileLog: compileContext.logSummary !== undefined ? compileContext.logSummary : params.compileLog,
    compileErrors: compileContext.errors !== undefined ? compileContext.errors : params.compileErrors,
    compileWarnings: compileContext.warnings !== undefined ? compileContext.warnings : params.compileWarnings,
    compileLogFresh: compileContext.fresh !== undefined ? compileContext.fresh : params.compileLogFresh,
    compileLogCompiledAt: compileContext.compiledAt !== undefined ? compileContext.compiledAt : params.compileLogCompiledAt
  };
}

function formatWorkspaceSnapshotContext(unreadFiles) {
  if (!unreadFiles.length) return [
    '- The local workspace was synced from Overleaf before this turn; trust the files over conflicting session history.'
  ];
  return [
    '- The readable project files were synced from Overleaf before this turn.',
    '- The following assets were not read because of the binary size limits. A retained local copy may be stale; a missing local copy does not mean the asset was deleted from Overleaf.',
    '- Do not rely on these assets as current evidence or edit them. Their local changes cannot be written back until their current Overleaf content is read. Other readable files remain available for this task.',
    ...unreadFiles.map(file => `- Unavailable current content: ${JSON.stringify(file.path)} (${file.reason}).`)
  ];
}

function normalizeLoadedSkills(skills = []) {
  return (Array.isArray(skills) ? skills : [])
    .map(skill => ({
      id: String(skill?.id || '').trim(),
      title: String(skill?.title || skill?.name || skill?.id || '').trim(),
      content: String(skill?.content || '')
    }))
    .filter(skill => skill.id && skill.content);
}

function formatTurnAttachmentsContext(attachments = []) {
  if (!attachments.length) {
    return '- none provided.';
  }
  return [
    '- These files are user-provided context for this turn only.',
    '- Read them if relevant. Do not edit them, do not include them in writeback, and do not write them to Overleaf.',
    ...attachments.map(attachment => {
      const attachmentPath = attachment.path || attachment.relativePath || attachment.name || 'attachment';
      const size = Number.isFinite(Number(attachment.size)) ? Number(attachment.size) : 0;
      const details = [
        attachment.mimeType || 'application/octet-stream',
        `${size} bytes`
      ].join(', ');
      return `- ${attachmentPath} (${details})`;
    })
  ].join('\n');
}

function formatWriteExpectation({ mode = 'auto', skillInvocation = null } = {}) {
  if (isSkillInstallerInvocation(skillInvocation)) {
    return [
      '- This is a skill-install turn.',
      '- You may use network and local commands needed to install or list Codex skills.',
      '- Only install into $CODEX_HOME/skills, which is mapped to Codex Overleaf plugin skills for this turn.',
      '- Do not edit Overleaf project files.'
    ].join('\n');
  }
  if (mode === 'ask') {
    return '- This is read-only. Inspect and explain; do not edit files.';
  }
  return '- Decide from the request whether it asks for changes. If it asks you to fix, revise, polish, rewrite, apply or otherwise change the project, edit the workspace files directly instead of only suggesting; if it asks a question, answer it without editing. If you intentionally leave files unchanged for a change request, explain the blocker.';
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

function normalizeProjectPath(value) {
  const path = String(value || '')
    .replace(/^@file:/i, '')
    .replace(/\\/g, '/')
    .trim();
  if (!path || /^file:\/\//i.test(path) || /^[A-Za-z]:\//.test(path)) {
    return '';
  }
  const projectPath = path.replace(/^\/+/, '');
  const wasAbsolutePath = path.startsWith('/');
  if (wasAbsolutePath && /^(Users|home|tmp|var|private|Volumes)\//i.test(projectPath)) {
    return '';
  }
  if (/(^|\/)\.codex-overleaf\/projects(\/|$)/.test(projectPath)) {
    return '';
  }
  return projectPath;
}

function formatProjectLocationCitationRules() {
  return [
    '- In any user-visible output, cite project locations using only Overleaf project-relative paths of files in this workspace.',
    '- Use path:LINE[:COLUMN] for a position and path:START-END for a span (for example, path/to/file.tex:12:3 or main.tex:12-20).',
    '- Do not wrap project location citations in backticks or inline code; write main.tex:28 as normal text so the browser can turn it into a jump button.',
    '- Do not cite local absolute paths, temporary workspace paths, file:// URLs, or markdown links to local files.',
    '- If a line number is uncertain, cite only the project-relative file path.'
  ].join('\n');
}

function formatMathOutputRules() {
  return [
    '- In user-visible prose, format inline mathematics as $...$ and display mathematics as $$...$$ on separate lines.',
    '- Never wrap mathematical expressions in backticks or fenced code blocks unless you are showing literal source code.',
    '- Do not emit bare TeX commands as prose when explicit math delimiters can express the same formula.',
    '- Keep prose outside math delimiters. Inside mathematics, wrap necessary words with \\text{...} and use \\mid for conditional bars.',
    '- For long display equations, use \\begin{aligned}...\\end{aligned} and place explicit row breaks near relation operators.'
  ].join('\n');
}

function formatFocusFiles(files) {
  if (!files.length) {
    return '- none; use the whole project when needed.';
  }
  return files.map(filePath => `- ${filePath}`).join('\n');
}

function formatCompileLogContext(context = {}) {
  const log = redactCompileLogText(String(context.compileLog || '').trim());
  if (!log) {
    return '- none provided.';
  }

  const errors = normalizeCompileMessages(context.compileErrors).map(redactCompileLogText);
  const warnings = normalizeCompileMessages(context.compileWarnings).map(redactCompileLogText);
  const fresh = context.compileLogFresh === false
    ? 'possibly stale'
    : 'fresh';
  const compiledAt = context.compileLogCompiledAt
    ? new Date(context.compileLogCompiledAt).toISOString()
    : 'unknown';

  return [
    `- status: ${fresh}`,
    `- compiledAt: ${compiledAt}`,
    `- errors: ${errors.length}`,
    `- warnings: ${warnings.length}`,
    errors.length ? `- error summary:\n${errors.slice(0, 8).map(message => `  - ${message}`).join('\n')}` : '',
    warnings.length ? `- warning summary:\n${warnings.slice(0, 8).map(message => `  - ${message}`).join('\n')}` : '',
    '- log:',
    fencedBlock(log)
  ].filter(Boolean).join('\n');
}

function redactCompileLogText(value) {
  let text = String(value || '');
  const replacements = [
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/g, 'Bearer [REDACTED]'],
    [/\b(?:ghp|github_pat|xox[baprs]|glpat)-?[_A-Za-z0-9=-]{16,}\b/g, '[REDACTED_TOKEN]'],
    [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, '[REDACTED_TOKEN]'],
    [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_TOKEN]'],
    [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
    [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED_GOOGLE_KEY]'],
    [/\bhf_[A-Za-z0-9]{20,}\b/g, '[REDACTED_HF_TOKEN]'],
    [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
    [/file:\/\/\/[^\s'"<>]+/g, '<local-path>'],
    [/(^|[\s({["'=])\/Users\/[^:\s'"<>)]*/g, '$1<local-path>'],
    [/(^|[\s({["'=])\/private\/var\/[^:\s'"<>)]*/g, '$1<local-path>'],
    [/(^|[\s({["'=])\/var\/folders\/[^:\s'"<>)]*/g, '$1<local-path>'],
    [/(^|[\s({["'=])\/tmp\/[^:\s'"<>)]*/g, '$1<local-path>'],
    [/(^|[\s({["'=])\/Library\/TeX\/[^:\s'"<>)]*/g, '$1<TEXLIVE_PATH>'],
    [/(^|[\s({["'=])\/usr\/local\/texlive\/[^:\s'"<>)]*/g, '$1<TEXLIVE_PATH>'],
    // Remaining canonical Unix top-levels (kept in sync with pathRedaction.js
    // UNIX_TOPLEVELS). Runs after the TeX-specific rules so texlive trees keep
    // their <TEXLIVE_PATH> placeholder; the /Users, /private/var, /var/folders,
    // and /tmp rules above already handled those dirs.
    [/(^|[\s({["'=])\/(?:home|root|private|var|Volumes|etc|opt|usr|srv|mnt|media)\/[^:\s'"<>)]*/g, '$1<local-path>'],
    [/[A-Za-z]:\\Users\\[^:\s'"<>)]*/g, '<local-path>'],
    [/[A-Za-z]:\\(?:Program Files|texlive)\\[^:\s'"<>)]*/gi, '<local-path>']
  ];
  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

function formatCustomInstructionsContext(customInstructions = '') {
  const instructions = truncateText(
    String(customInstructions || '').trim(),
    PROJECT_CUSTOM_INSTRUCTIONS_MAX_CHARS
  );
  if (!instructions) {
    return '- none provided.';
  }
  return fencedBlock(instructions);
}

function formatProjectLocalSkillsContext(context = {}) {
  const selectedSkillIds = Array.isArray(context.selectedSkillIds) ? context.selectedSkillIds : [];
  if (!selectedSkillIds.length) {
    return '- none selected.';
  }
  const loaded = context.projectLocalSkills || { skills: [], missing: [] };
  const sections = [];
  for (const skill of loaded.skills || []) {
    sections.push([
      `## ${skill.id}: ${skill.title || skill.name || skill.id}`,
      fencedBlock(skill.content)
    ].join('\n'));
  }
  if (Array.isArray(loaded.missing) && loaded.missing.length) {
    sections.push([
      'Missing selected local skills:',
      loaded.missing.map(id => `- ${id}`).join('\n')
    ].join('\n'));
  }
  return sections.length ? sections.join('\n\n') : '- none loaded.';
}

function formatSkillInvocationContext(context = {}) {
  const invocation = normalizeSkillInvocation(context.skillInvocation);
  const codexSkillInvocationContext = context.codexSkillInvocationContext || {};
  const contextInvocation = normalizeSkillInvocation(codexSkillInvocationContext.invocation);
  const effectiveInvocation = contextInvocation || invocation;
  const skillLabel = effectiveInvocation?.scope === 'codex-local' ? 'local Codex' : 'Codex Overleaf';
  if (Array.isArray(codexSkillInvocationContext.ignored) && codexSkillInvocationContext.ignored.length) {
    return [
      `Ignored selected ${skillLabel} skill:`,
      ...codexSkillInvocationContext.ignored.map(item => `- ${item.id}`),
      effectiveInvocation?.scope === 'codex-local'
        ? '- Reason: The selected local Codex skill is disabled for this turn.'
        : '- Reason: Codex Overleaf skills are disabled for this turn.',
      '- The stale slash selection was ignored; no selected skill instructions were forced into this prompt.'
    ].join('\n');
  }
  if (Array.isArray(codexSkillInvocationContext.missing) && codexSkillInvocationContext.missing.length) {
    return [
      `Missing selected ${skillLabel} skill:`,
      ...codexSkillInvocationContext.missing.map(id => `- ${id}`),
      '- The stale slash selection was ignored; no selected skill instructions were forced into this prompt.'
    ].join('\n');
  }
  if (!effectiveInvocation) {
    return '- none.';
  }
  if (isSkillInstallerInvocation(effectiveInvocation)) {
    return [
      `- ${effectiveInvocation.id} (${effectiveInvocation.title})`,
      '- Use the Codex skill-installer behavior for this turn.',
      '- Install skills into the Codex Overleaf plugin skill home; this bridge maps $CODEX_HOME/skills to that persistent plugin skills directory.',
      '- Accept natural-language requests, curated skill names, GitHub repo paths, or GitHub URLs.',
      '- If the request does not name a skill or location, list installable curated skills and ask which one to install.',
      '- Do not edit the Overleaf project workspace or write installed skill files into the project mirror.'
    ].join('\n');
  }
  const loadedSkill = codexSkillInvocationContext.skill;
  if (loadedSkill) {
    return [
      `- ${effectiveInvocation.id} (${effectiveInvocation.title})`,
      `- REQUIRED for this turn: read and use this selected ${skillLabel} skill before answering.`,
      '- Follow the embedded SKILL.md instructions when they apply to the current user request.',
      ...(effectiveInvocation.scope === 'codex-local' && loadedSkill.path
        ? [`- Skill source: ${loadedSkill.path}`, '- Resolve relative skill resources against this SKILL.md directory.'] : []),
      '',
      `Selected ${skillLabel} SKILL.md:`,
      `## ${loadedSkill.id}: ${loadedSkill.title || effectiveInvocation.title || loadedSkill.id}`,
      fencedBlock(loadedSkill.content)
    ].join('\n');
  }
  return [
    `- ${effectiveInvocation.id} (${effectiveInvocation.title})`,
    `- Use this selected ${skillLabel} skill for the current turn.`,
    '- Follow the skill instructions and workflow when they apply to the user request.'
  ].join('\n');
}

function normalizeSkillInvocation(value) {
  const id = String(value?.id || value?.skillId || '').trim();
  if (!isSafeSkillId(id)) {
    return null;
  }
  const title = String(value?.title || value?.name || (id === 'skill-installer' ? 'Skill Installer' : id))
    .trim()
    .slice(0, 80) || 'Skill Installer';
  if (id === 'skill-installer' && (!value?.scope || value.scope === 'builtin')) {
    return { id, title };
  }
  if (!['codex-overleaf', 'codex-local'].includes(value?.scope) && !Object.prototype.hasOwnProperty.call(value || {}, 'skillId')) {
    return null;
  }
  return { id, title, scope: value?.scope === 'codex-local' ? 'codex-local' : 'codex-overleaf' };
}

function isSkillInstallerInvocation(value) {
  const invocation = normalizeSkillInvocation(value);
  return invocation?.id === 'skill-installer' && !invocation.scope;
}

function isSafeSkillId(id) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(String(id || ''))
    && !String(id || '').includes('..');
}

function normalizeCompileMessages(value) {
  const messages = Array.isArray(value) ? value : [];
  return messages
    .map(message => String(message || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function fencedBlock(value) {
  return [
    '```text',
    String(value || '').replace(/```/g, '` ` `'),
    '```'
  ].join('\n');
}

function formatSessionHistory(history) {
  const turns = Array.isArray(history) ? history.slice(-8) : [];
  if (!turns.length) {
    return '- none';
  }
  return turns.map((turn, index) => {
    const task = truncateText(String(turn?.task || 'untitled task'), 600);
    const result = truncateText(String(turn?.result || turn?.status || 'no result recorded'), 1200);
    return `${index + 1}. User asked: ${task}\n   Previous outcome: ${result}`;
  }).join('\n');
}

module.exports = { buildCodexDeveloperInstructions, buildCodexTurnPrompt, validatePromptSize };
