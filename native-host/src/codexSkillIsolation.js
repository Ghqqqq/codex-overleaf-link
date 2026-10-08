'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getCodexOverleafSkillsRoot } = require('./localSkills');
const { createCodexLocalSkillIdentity } = require('./codexLocalSkills');

async function applyCodexSkillIsolation({ input = {}, childEnv = process.env, request, emit = () => {} } = {}) {
  if (input.loadCodexLocalSkills !== false && input.loadCodexOverleafSkills !== false
    && !Array.isArray(input.enabledCodexOverleafSkillIds) && !Array.isArray(input.disableCodexOverleafSkillIds)
    && !Array.isArray(input.enabledCodexLocalSkillIds)) {
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
  if (Array.isArray(input.enabledCodexLocalSkillIds) && (!Array.isArray(listResult?.data)
    || listResult.data.some(group => !Array.isArray(group?.skills)
      || (group.errors !== undefined && !Array.isArray(group.errors))))) {
    throw Object.assign(new Error('Local Codex skills could not be prepared. Refresh the skill list and try again.'),
      { code: 'codex_local_skill_unavailable' });
  }
  const skills = flattenCodexSkillsList(listResult);
  const disabled = [];
  const enabled = [];
  for (const skill of skills) {
    const localSelection = getLocalSkillSelection(skill, input, childEnv);
    const shouldDisable = shouldDisableCodexSkillForIsolation(skill, input, childEnv);
    if (localSelection === true && skill?.enabled === false) {
      const params = buildSkillDisableParams(skill, { preferPath: true });
      if (params) {
        await request('skills/config/write', { ...params, enabled: true });
        enabled.push(String(skill.name || skill.path || '').trim());
      }
      continue;
    }
    if (skill?.enabled === false || !shouldDisable) {
      continue;
    }
    const params = buildSkillDisableParams(skill, { preferPath: localSelection !== null });
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
  return { disabled, enabled };
}

function getLocalSkillSelection(skill, input, childEnv) {
  if (!Array.isArray(input.enabledCodexLocalSkillIds)
    || getOverleafSkillId(skill.path, input, childEnv)) return null;
  if (isCodexSystemSkill(skill) && isAllowedSystemSkillForIsolation(skill, input)) return true;
  if (input.loadCodexLocalSkills === false) return false;
  const id = createCodexLocalSkillIdentity(skill, childEnv);
  return Boolean(id) && input.enabledCodexLocalSkillIds.includes(id);
}

function flattenCodexSkillsList(listResult = {}) {
  const data = Array.isArray(listResult?.data) ? listResult.data : [];
  return data.flatMap(entry => Array.isArray(entry?.skills) ? entry.skills : []);
}

function shouldDisableCodexSkillForIsolation(skill = {}, input = {}, childEnv = process.env) {
  const localSelection = getLocalSkillSelection(skill, input, childEnv);
  if (localSelection !== null) return !localSelection;
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

function buildSkillDisableParams(skill = {}, { preferPath = false } = {}) {
  const name = String(skill.name || '').trim();
  const skillPath = String(skill.path || '').trim();
  if (preferPath && path.isAbsolute(skillPath)) return { path: skillPath, enabled: false };
  if (isCodexSystemSkill(skill) && name) {
    return { name, enabled: false };
  }
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
