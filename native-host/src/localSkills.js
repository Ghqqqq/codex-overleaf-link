'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getProjectMirror } = require('./mirrorWorkspace');
const { getHomeDir } = require('./nativeHostPlatform');
const { truncateText } = require('./debugLog');

const SKILLS_DIR = path.join('.codex-overleaf', 'skills');
const CODEX_OVERLEAF_SKILLS_DIR = path.join('.codex-overleaf', 'skills');
const MAX_SKILL_CONTENT_BYTES = 64 * 1024;
const MAX_SKILL_CONTENT_CHARS = MAX_SKILL_CONTENT_BYTES;
const MAX_SKILL_PREVIEW_CHARS = 240;
const PROJECT_SKILL_SCOPE = 'project';
const CODEX_OVERLEAF_SKILL_SCOPE = 'codex-overleaf';
const OFFICIAL_CODEX_OVERLEAF_SKILL_IDS = ['annotated-rewrite', 'parallel-subagents', 'reviewer-response'];

function listProjectSkills({ projectId, rootDir } = {}) {
  const skillsDir = getProjectSkillsDir(projectId, { rootDir });
  if (!fs.existsSync(skillsDir)) {
    return { skills: [] };
  }

  const skills = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }
    const id = entry.name.slice(0, -3);
    if (!isSafeSkillId(id)) {
      continue;
    }
    const filePath = resolveSkillPath(projectId, id, { rootDir });
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const title = inferSkillTitle(content) || id;
    skills.push({
      id,
      title,
      name: title,
      scope: PROJECT_SKILL_SCOPE,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
      preview: buildSkillPreview(content)
    });
  }

  return { skills: skills.sort((left, right) => left.id.localeCompare(right.id)) };
}

function installProjectSkill({ projectId, skillId, content, rootDir } = {}) {
  const id = validateSkillId(skillId);
  if (typeof content !== 'string') {
    throw new Error('Project-local skills require markdown/text content');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_CONTENT_BYTES) {
    throw new Error(`Project-local skill content exceeds ${MAX_SKILL_CONTENT_BYTES} bytes`);
  }
  if (content.includes('\u0000')) {
    throw new Error('Project-local skill content must be markdown/text');
  }

  const filePath = resolveSkillPath(projectId, id, { rootDir });
  const skillsDir = getProjectSkillsDir(projectId, { rootDir });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  assertNoSymlinkEscape(path.dirname(filePath), skillsDir, 'Unsafe project skill path');
  assertNoSymlinkEscape(filePath, skillsDir, 'Unsafe project skill path');
  fs.writeFileSync(filePath, content, 'utf8');

  const stat = fs.statSync(filePath);
  const title = inferSkillTitle(content) || id;
  return {
    id,
    title,
    name: title,
    scope: PROJECT_SKILL_SCOPE,
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
    preview: buildSkillPreview(content)
  };
}

function removeProjectSkill({ projectId, skillId, rootDir } = {}) {
  const id = validateSkillId(skillId);
  const filePath = resolveSkillPath(projectId, id, { rootDir });
  assertNoSymlinkEscape(filePath, getProjectSkillsDir(projectId, { rootDir }), 'Unsafe project skill path');
  const removed = fs.existsSync(filePath);
  if (removed) {
    fs.rmSync(filePath, { force: true });
  }
  return { id, removed };
}

function listCodexOverleafSkills({ env = process.env, skillsRoot } = {}) {
  const root = getCodexOverleafSkillsRoot({ env, skillsRoot });
  if (!fs.existsSync(root)) {
    return { skills: [] };
  }

  const skills = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isSafeSkillId(entry.name)) {
      continue;
    }
    const filePath = resolveCodexOverleafSkillPath(entry.name, { env, skillsRoot });
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      continue;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const isOfficial = OFFICIAL_CODEX_OVERLEAF_SKILL_IDS.includes(entry.name);
    skills.push({
      ...buildSkillMetadata({
        id: entry.name,
        content,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        scope: CODEX_OVERLEAF_SKILL_SCOPE
      }),
      official: isOfficial,
      removable: !isOfficial
    });
  }

  return { skills: skills.sort((left, right) => left.id.localeCompare(right.id)) };
}

function installCodexOverleafSkill({ skillId, content, env = process.env, skillsRoot } = {}) {
  const id = validateSkillId(skillId);
  validateSkillContent(content, 'Codex Overleaf skills');

  const root = getCodexOverleafSkillsRoot({ env, skillsRoot });
  const filePath = resolveCodexOverleafSkillPath(id, { env, skillsRoot });
  const skillDir = path.dirname(filePath);
  assertNoSymlinkEscape(skillDir, root, 'Unsafe Codex Overleaf skill path');
  fs.mkdirSync(skillDir, { recursive: true });
  assertNoSymlinkEscape(skillDir, root, 'Unsafe Codex Overleaf skill path');
  assertNoSymlinkEscape(filePath, root, 'Unsafe Codex Overleaf skill path');
  fs.writeFileSync(filePath, content, 'utf8');

  const stat = fs.statSync(filePath);
  return buildSkillMetadata({
    id,
    content,
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
    scope: CODEX_OVERLEAF_SKILL_SCOPE
  });
}

function removeCodexOverleafSkill({ skillId, env = process.env, skillsRoot } = {}) {
  const id = validateSkillId(skillId);
  if (OFFICIAL_CODEX_OVERLEAF_SKILL_IDS.includes(id)) {
    throw new Error(`Cannot remove official skill: ${id}`);
  }
  const root = getCodexOverleafSkillsRoot({ env, skillsRoot });
  const skillDir = resolveInside(root, id, 'Unsafe Codex Overleaf skill path');
  const removed = fs.existsSync(skillDir);
  if (removed) {
    fs.rmSync(skillDir, { recursive: true, force: true });
  }
  return { id, scope: CODEX_OVERLEAF_SKILL_SCOPE, removed };
}

function ensureCodexOverleafSkillInstalled({ skillId, content, env = process.env } = {}) {
  const root = getCodexOverleafSkillsRoot({ env });
  const skillPath = resolveCodexOverleafSkillPath(skillId, { env });
  if (fs.existsSync(skillPath)) {
    assertNoSymlinkEscape(skillPath, root, 'Existing official skill path is unsafe');
    const stat = fs.lstatSync(skillPath);
    if (stat.isFile()) {
      return;
    }
    // symlink, directory, or other — remove and reinstall
    fs.rmSync(skillPath, { recursive: true, force: true });
  }
  installCodexOverleafSkill({ skillId, content, env });
}

function loadSelectedProjectSkills({ projectId, selectedSkillIds, rootDir, projectRoot } = {}) {
  const ids = normalizeSelectedSkillIds(selectedSkillIds);
  const skills = [];
  const missing = [];

  for (const id of ids) {
    const filePath = resolveSkillPath(projectId, id, { rootDir, projectRoot });
    assertNoSymlinkEscape(filePath, getProjectSkillsDir(projectId, { rootDir, projectRoot }), 'Unsafe project skill path');
    if (!fs.existsSync(filePath)) {
      missing.push(id);
      continue;
    }
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_SKILL_CONTENT_BYTES) {
      missing.push(id);
      continue;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    skills.push({
      id,
      title: inferSkillTitle(content) || id,
      content: truncateText(content, MAX_SKILL_CONTENT_CHARS)
    });
  }

  return { skills, missing };
}

function materializeProjectSkillsAsCodexSkills({
  projectId,
  rootDir,
  projectRoot,
  targetRoot
} = {}) {
  const target = path.resolve(String(targetRoot || ''));
  if (!targetRoot) {
    throw new Error('Codex skill target root is required');
  }
  const skillsDir = getProjectSkillsDir(projectId, { rootDir, projectRoot });
  const result = { installed: [], skipped: [] };
  if (!fs.existsSync(skillsDir)) {
    return result;
  }

  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }
    const id = entry.name.slice(0, -3);
    if (!isSafeSkillId(id)) {
      result.skipped.push({ id, reason: 'unsafe_id' });
      continue;
    }
    const sourcePath = resolveSkillPath(projectId, id, { rootDir, projectRoot });
    assertNoSymlinkEscape(sourcePath, skillsDir, 'Unsafe project skill path');
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile() || stat.size > MAX_SKILL_CONTENT_BYTES) {
      result.skipped.push({ id, reason: 'invalid_content' });
      continue;
    }
    const skillDir = resolveInside(target, id, 'Unsafe materialized project skill path');
    const skillPath = resolveInside(skillDir, 'SKILL.md', 'Unsafe materialized project skill path');
    fs.rmSync(skillDir, { recursive: true, force: true });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillPath, fs.readFileSync(sourcePath, 'utf8'), 'utf8');
    result.installed.push(id);
  }
  return result;
}

function loadSelectedCodexOverleafSkill({
  skillId,
  loadCodexOverleafSkills = true,
  enabledCodexOverleafSkillIds,
  env = process.env,
  skillsRoot
} = {}) {
  const rawId = String(skillId || '').trim();
  if (!rawId) {
    return { skill: null, missing: [], ignored: [] };
  }
  const id = validateSkillId(rawId);
  if (loadCodexOverleafSkills === false) {
    return {
      skill: null,
      missing: [],
      ignored: [{
        id,
        reason: 'codex_overleaf_skills_disabled'
      }]
    };
  }
  // Per-skill enable check: if enabledCodexOverleafSkillIds is provided and does not include
  // this skill, treat it as not available. Absent param = all enabled (backward-safe).
  if (Array.isArray(enabledCodexOverleafSkillIds) && !enabledCodexOverleafSkillIds.includes(id)) {
    return {
      skill: null,
      missing: [],
      ignored: [{
        id,
        reason: 'codex_overleaf_skill_disabled'
      }]
    };
  }

  const filePath = resolveCodexOverleafSkillPath(id, { env, skillsRoot });
  if (!fs.existsSync(filePath)) {
    return { skill: null, missing: [id], ignored: [] };
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > MAX_SKILL_CONTENT_BYTES) {
    return { skill: null, missing: [id], ignored: [] };
  }
  const content = fs.readFileSync(filePath, 'utf8');
  return {
    skill: {
      id,
      title: inferSkillTitle(content) || id,
      scope: CODEX_OVERLEAF_SKILL_SCOPE,
      path: filePath,
      content: truncateText(content, MAX_SKILL_CONTENT_CHARS)
    },
    missing: [],
    ignored: []
  };
}

function normalizeSelectedSkillIds(selectedSkillIds) {
  const seen = new Set();
  const ids = [];
  for (const value of Array.isArray(selectedSkillIds) ? selectedSkillIds : []) {
    const id = validateSkillId(value);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function getProjectSkillsDir(projectId, options = {}) {
  validateProjectId(projectId);
  const mirror = options.projectRoot
    ? { projectRoot: options.projectRoot }
    : getProjectMirror(projectId, options);
  const root = path.resolve(mirror.projectRoot);
  const skillsDir = path.resolve(mirror.projectRoot, SKILLS_DIR);
  if (skillsDir !== root && !skillsDir.startsWith(root + path.sep)) {
    throw new Error('Unsafe project skills path');
  }
  return skillsDir;
}

function getCodexOverleafSkillsRoot({ env = process.env, skillsRoot } = {}) {
  const defaultRoot = getDefaultCodexOverleafSkillsRoot({ env });
  if (skillsRoot) {
    return validateCodexOverleafSkillsRoot(path.resolve(skillsRoot), defaultRoot);
  }
  if (env.CODEX_OVERLEAF_SKILLS_ROOT) {
    return validateCodexOverleafSkillsRoot(path.resolve(env.CODEX_OVERLEAF_SKILLS_ROOT), defaultRoot);
  }
  return validateCodexOverleafSkillsRoot(defaultRoot, defaultRoot);
}

function getDefaultCodexOverleafSkillsRoot({ env = process.env } = {}) {
  return path.resolve(getHomeDir({ env }), CODEX_OVERLEAF_SKILLS_DIR);
}

function validateCodexOverleafSkillsRoot(root, defaultRoot) {
  const resolvedRoot = path.resolve(root);
  const resolvedDefault = path.resolve(defaultRoot);
  if (!isInsideOrSamePath(resolvedRoot, resolvedDefault)) {
    throw new Error(`Codex Overleaf skill root must stay inside ${resolvedDefault}`);
  }
  assertNoSymlinkEscape(resolvedRoot, path.dirname(resolvedDefault), 'Codex Overleaf skill root escapes the plugin data root');
  return resolvedRoot;
}

function resolveSkillPath(projectId, skillId, options = {}) {
  const id = validateSkillId(skillId);
  const skillsDir = getProjectSkillsDir(projectId, options);
  const target = path.resolve(skillsDir, `${id}.md`);
  if (target !== skillsDir && !target.startsWith(skillsDir + path.sep)) {
    throw new Error('Unsafe project skill path');
  }
  assertNoSymlinkEscape(target, skillsDir, 'Unsafe project skill path');
  return target;
}

function resolveCodexOverleafSkillPath(skillId, options = {}) {
  const id = validateSkillId(skillId);
  const root = getCodexOverleafSkillsRoot(options);
  const skillDir = resolveInside(root, id, 'Unsafe Codex Overleaf skill path');
  return resolveInside(skillDir, 'SKILL.md', 'Unsafe Codex Overleaf skill path');
}

function resolveInside(root, child, message) {
  const base = path.resolve(root);
  const target = path.resolve(base, child);
  if (!isInsideOrSamePath(target, base)) {
    throw new Error(message);
  }
  return target;
}

function assertNoSymlinkEscape(target, containmentRoot, message) {
  const root = path.resolve(containmentRoot);
  const resolvedTarget = path.resolve(target);
  if (!isInsideOrSamePath(resolvedTarget, root)) {
    throw new Error(message);
  }

  const relativeParts = path.relative(root, resolvedTarget).split(path.sep).filter(Boolean);
  let current = root;
  assertNotSymlink(current, message);
  for (const part of relativeParts) {
    current = path.join(current, part);
    assertNotSymlink(current, message);
  }
}

function assertNotSymlink(target, message) {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) {
      throw new Error(message);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

function isInsideOrSamePath(target, root) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateProjectId(projectId) {
  if (typeof projectId !== 'string' || !projectId.trim()) {
    throw new Error('Project id is required');
  }
  if (projectId.length > 512) {
    throw new Error('Project id is too long');
  }
}

function validateSkillId(skillId) {
  const id = String(skillId || '').trim();
  if (!isSafeSkillId(id)) {
    throw new Error('Invalid skill id');
  }
  return id;
}

function validateSkillContent(content, label) {
  if (typeof content !== 'string') {
    throw new Error(`${label} require markdown/text content`);
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_CONTENT_BYTES) {
    throw new Error(`${label} content exceeds ${MAX_SKILL_CONTENT_BYTES} bytes`);
  }
  if (content.includes('\u0000')) {
    throw new Error(`${label} content must be markdown/text`);
  }
}

function isSafeSkillId(id) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(String(id || ''))
    && !String(id).includes('..');
}

function inferSkillTitle(content) {
  for (const line of String(content || '').split(/\r?\n/)) {
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (heading) {
      return truncateText(heading[1].trim(), 120);
    }
  }
  for (const line of String(content || '').split(/\r?\n/)) {
    const clean = line.trim();
    if (clean) {
      return truncateText(clean.replace(/^#+\s*/, ''), 120);
    }
  }
  return '';
}

function buildSkillPreview(content) {
  return truncateText(
    String(content || '')
      .replace(/^#\s+.*(?:\r?\n)+/, '')
      .replace(/\s+/g, ' ')
      .trim(),
    MAX_SKILL_PREVIEW_CHARS
  );
}

function buildSkillMetadata({ id, content, size, updatedAt, scope }) {
  const title = inferSkillTitle(content) || id;
  return {
    id,
    title,
    name: title,
    scope,
    size,
    updatedAt,
    preview: buildSkillPreview(content)
  };
}

module.exports = {
  CODEX_OVERLEAF_SKILL_SCOPE,
  MAX_SKILL_CONTENT_BYTES,
  MAX_SKILL_CONTENT_CHARS,
  OFFICIAL_CODEX_OVERLEAF_SKILL_IDS,
  PROJECT_SKILL_SCOPE,
  ensureCodexOverleafSkillInstalled,
  getDefaultCodexOverleafSkillsRoot,
  getCodexOverleafSkillsRoot,
  installCodexOverleafSkill,
  installProjectSkill,
  listCodexOverleafSkills,
  listProjectSkills,
  loadSelectedCodexOverleafSkill,
  loadSelectedProjectSkills,
  materializeProjectSkillsAsCodexSkills,
  removeCodexOverleafSkill,
  removeProjectSkill
};
