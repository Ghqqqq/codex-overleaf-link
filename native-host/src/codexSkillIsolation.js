'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getCodexOverleafSkillsRoot } = require('./localSkills');

async function applyCodexSkillIsolation({ input = {}, childEnv = process.env, request, emit = () => {} } = {}) {
  if (input.loadCodexLocalSkills !== false && input.loadCodexOverleafSkills !== false
    && !Array.isArray(input.enabledCodexOverleafSkillIds) && !Array.isArray(input.disableCodexOverleafSkillIds)) {
    return { disabled: [] };
  }
  if (typeof request !== 'function') {
    throw new Error('Codex skill isolation requires an app-server request function');
  }

  const listResult = await request('skills/list', {
    cwd: input.workspacePath,
    includeDisabled: true,
    ...(input.workspacePath ? { cwds: [input.workspacePath] } : {}),
    forceReload: true
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
    emitCodexEvent(emit, 'codex.skill_isolation.applied', 'Applied Codex skill loading settings for this turn', {
      disabledSkillNames: disabled.filter(Boolean)
    }, 'completed');
  }
  return { disabled };
}

function flattenCodexSkillsList(listResult = {}) {
  const data = Array.isArray(listResult?.data) ? listResult.data : [];
  return data.flatMap(entry => Array.isArray(entry?.skills) ? entry.skills : []);
}

function shouldDisableCodexSkillForIsolation(skill = {}, input = {}, childEnv = process.env) {
  if (isCodexSystemSkill(skill)) {
    return input.loadCodexLocalSkills === false && !isAllowedSystemSkillForIsolation(skill, input);
  }
  const id = getOverleafSkillId(skill.path, input, childEnv);
  if (id && input.installCodexOverleafSkillsTarget !== true) {
    if (input.loadCodexOverleafSkills === false) return true;
    if (Array.isArray(input.enabledCodexOverleafSkillIds) && !input.enabledCodexOverleafSkillIds.includes(id)) return true;
    if (Array.isArray(input.disableCodexOverleafSkillIds) && input.disableCodexOverleafSkillIds.includes(id)) return true;
  }
  return input.loadCodexLocalSkills === false && !isAllowedCodexOverleafSkillPath(skill.path, input, childEnv);
}

function getOverleafSkillId(skillPath, input, childEnv) {
  if (!skillPath || !path.isAbsolute(String(skillPath))) return '';
  const roots = [getCodexOverleafSkillsRoot({ env: childEnv })];
  // A composed home with local inheritance disabled contains only plugin or
  // explicitly materialized project skills. Real paths identify plugin aliases.
  if (input.loadCodexLocalSkills === false) roots.push(path.join(String(childEnv.CODEX_HOME || ''), 'skills'));
  for (const root of roots) for (const base of comparablePaths(root)) for (const candidate of comparablePaths(skillPath)) {
    const relative = path.relative(base, candidate);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative.split(path.sep)[0];
  }
  return '';
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

function emitCodexEvent(emit, type, title, detail = {}, status = 'running') {
  emit({ type, title, status, detail, timestamp: new Date().toISOString() });
}

module.exports = { applyCodexSkillIsolation };
