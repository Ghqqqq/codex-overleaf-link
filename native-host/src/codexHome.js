'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { filterTomlRootKeys } = require('./tomlStatements');
const { copyInheritedAuth, removeMissingInheritedAuth } = require('./codexInheritedAuth');
const {
  getHomeDir,
  getNativeHostPlatform
} = require('./nativeHostPlatform');
const {
  ensureCodexOverleafSkillInstalled,
  getCodexOverleafSkillsRoot,
  materializeProjectSkillsAsCodexSkills,
  OFFICIAL_CODEX_OVERLEAF_SKILL_IDS
} = require('./localSkills');

const COPIED_USER_CODEX_FILES = [
  'auth.json',
  'config.toml',
  'installation_id',
  'models_cache.json',
  'version.json'
];

const LINKED_USER_CODEX_DIRS = [
  'vendor_imports'
];

// User-global Codex instruction/memory entries that must never enter the plugin
// Codex home. The extension supplies its own per-project personalization via the
// prompt; inheriting the user's global Codex guidance here is a leak. The plugin
// home is reused across runs, so these are removed every prepare to also clear
// entries left by earlier extension versions.
const ISOLATED_USER_INSTRUCTION_ENTRIES = ['AGENTS.md', 'rules', 'memories'];

const LOCAL_SKILL_USER_CODEX_DIRS = [
  'plugins',
  'superpowers'
];

const LOCAL_SKILL_PLUGIN_HOME_ENTRIES = [
  'plugins',
  'superpowers',
  path.join('.tmp', 'plugins'),
  path.join('.tmp', 'plugins.sha'),
  path.join('.tmp', 'app-server-remote-plugin-sync-v1'),
  path.join('cache', 'codex_apps_tools')
];

const LOCAL_SKILL_CONFIG_SECTIONS = [
  'skills',
  'plugins',
  'mcp_servers',
  'marketplaces'
];

const HISTORY_DIRS = [
  'sessions',
  'archived_sessions',
  'history'
];

function getUserCodexHome(env = process.env, options = {}) {
  const home = getHomeDir({ ...options, env });
  return path.resolve(env.CODEX_OVERLEAF_USER_CODEX_HOME || env.CODEX_HOME || path.join(home, '.codex'));
}

function getPluginCodexHome(env = process.env, options = {}) {
  const home = getHomeDir({ ...options, env });
  return path.resolve(env.CODEX_OVERLEAF_CODEX_HOME || path.join(home, '.codex-overleaf', 'codex-home'));
}

function preparePluginCodexHome(env = process.env, options = {}) {
  const userHome = getUserCodexHome(env, options);
  const pluginHome = getPluginCodexHome(env, options);
  const loadCodexLocalSkills = options.loadCodexLocalSkills !== false;
  const loadCodexOverleafSkills = options.loadCodexOverleafSkills !== false;
  const installCodexOverleafSkillsTarget = options.installCodexOverleafSkillsTarget === true;

  fs.mkdirSync(pluginHome, { recursive: true });
  chmodIfPossible(pluginHome, 0o700);
  if (samePath(userHome, pluginHome)) {
    return { userHome, pluginHome, copied: [], linked: [], skippedLinks: [] };
  }

  const copied = [];
  const linked = [];
  const skippedLinks = [];
  for (const fileName of COPIED_USER_CODEX_FILES) {
    if (fileName === 'config.toml' && options.skipCopiedUserConfig === true) continue;
    const source = path.join(userHome, fileName);
    const target = path.join(pluginHome, fileName);
    if (!isRegularFile(source)) {
      if (fileName === 'auth.json') removeMissingInheritedAuth(source, target);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    copyUserCodexFile(source, target, fileName, { loadCodexLocalSkills });
    if (fileName === 'auth.json') {
      chmodIfPossible(target, 0o600);
    }
    copied.push(fileName);
  }

  // Personalization isolation: the plugin Codex home must never inherit the
  // user's global Codex instructions/memory. Remove them every run — this also
  // clears stale entries left by earlier extension versions. This runs after
  // the samePath early-return above, so it never touches the user's real
  // ~/.codex when the plugin home and user home are the same directory.
  for (const entryName of ISOLATED_USER_INSTRUCTION_ENTRIES) {
    removePluginHomeEntry(pluginHome, entryName, skippedLinks);
  }
  if (!isRegularFile(path.join(userHome, 'config.toml'))) {
    removePluginHomeEntry(pluginHome, 'config.toml', skippedLinks);
  }

  if (!loadCodexLocalSkills) {
    for (const entryName of LOCAL_SKILL_PLUGIN_HOME_ENTRIES) {
      removePluginHomeEntry(pluginHome, entryName, skippedLinks);
    }
  }

  const userDirsToLink = loadCodexLocalSkills
    ? [...LINKED_USER_CODEX_DIRS, ...LOCAL_SKILL_USER_CODEX_DIRS]
    : LINKED_USER_CODEX_DIRS;
  for (const dirName of userDirsToLink) {
    const source = path.join(userHome, dirName);
    const target = path.join(pluginHome, dirName);
    if (!isDirectory(source)) {
      continue;
    }
    const linkResult = ensureSymlink(source, target, options);
    if (!linkResult.ok) {
      skippedLinks.push({
        name: dirName,
        reason: linkResult.reason
      });
      continue;
    }
    linked.push(dirName);
  }

  ensureDefaultCodexOverleafSkills({ env });

  const skillsResult = composePluginSkillsDirectory({
    userHome,
    pluginHome,
    env,
    options,
    loadCodexLocalSkills,
    loadCodexOverleafSkills,
    installCodexOverleafSkillsTarget,
    projectLocalSkills: options.projectLocalSkills || null
  });
  if (skillsResult.linked) {
    linked.push('skills');
  }
  skippedLinks.push(...skillsResult.skippedLinks);

  return { userHome, pluginHome, copied, linked, skippedLinks };
}

function ensureDefaultCodexOverleafSkills({ env = process.env } = {}) {
  for (const id of OFFICIAL_CODEX_OVERLEAF_SKILL_IDS) {
    const src = path.resolve(__dirname, 'skills', id, 'SKILL.md');
    const content = fs.readFileSync(src, 'utf8');
    ensureCodexOverleafSkillInstalled({ skillId: id, content, env });
  }
}

function copyUserCodexFile(source, target, fileName, options = {}) {
  if (fileName === 'auth.json') {
    copyInheritedAuth(source, target);
    return;
  }
  if (fileName !== 'config.toml') {
    fs.copyFileSync(source, target);
    return;
  }
  const content = sanitizeCopiedCodexConfig(fs.readFileSync(source, 'utf8'), options);
  fs.writeFileSync(target, content, 'utf8');
}

function sanitizeCopiedCodexConfig(content, options = {}) {
  content = stripPersonalizationFromCodexConfig(content);
  if (options.loadCodexLocalSkills === false) {
    content = sanitizeCodexConfigForLocalSkillIsolation(content);
  }
  return content;
}

// Remove the complete top-level personality assignment. Statement boundaries
// keep keys/table headers inside multiline strings from becoming filter input.
// Key paths are decoded before filtering, including quoted/dotted spellings.
// Table-scoped fields remain distinct. Unselected source text is preserved.
function stripPersonalizationFromCodexConfig(content) {
  return filterTomlRootKeys(content, ['personality']);
}

function sanitizeCodexConfigForLocalSkillIsolation(content) {
  return filterTomlRootKeys(content, ['notify', ...LOCAL_SKILL_CONFIG_SECTIONS]);
}

function removePluginHomeEntry(pluginHome, entryName, skippedLinks) {
  const target = path.join(pluginHome, entryName);
  if (!isSafePluginHomePath(target, pluginHome)) {
    skippedLinks.push({
      name: entryName,
      reason: 'unsafe_target'
    });
    return;
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function buildCodexHomeEnv(env = process.env, options = {}) {
  const userHome = getUserCodexHome(env, options);
  let canonicalHome = getPluginCodexHome(env, options);
  // Per-skill writes belong to the plugin even when an older installation
  // explicitly shared its Codex home with the user's normal Codex session.
  if (samePath(userHome, canonicalHome) && (options.forceIsolatedSkillSettings === true
    || Array.isArray(options.enabledCodexLocalSkillIds))) {
    canonicalHome += '-overleaf-runtime';
    if (samePath(userHome, canonicalHome)) throw new Error('The isolated skill home must not alias the user Codex home.');
  }
  if (options.isolateRuntimeHome === true && !samePath(userHome, canonicalHome)) {
    const { prepareScopedPluginCodexHome } = require('./codexHomeScope');
    const prepared = prepareScopedPluginCodexHome(env, options, {
      userHome, canonicalHome, prepare: preparePluginCodexHome, ensureSkills: ensureDefaultCodexOverleafSkills,
      prepareConfig: sanitizeCopiedCodexConfig
    });
    return { ...env, CODEX_HOME: prepared.pluginHome, CODEX_SQLITE_HOME: env.CODEX_SQLITE_HOME || canonicalHome,
      CODEX_OVERLEAF_CODEX_HOME: canonicalHome, CODEX_OVERLEAF_USER_CODEX_HOME: userHome };
  }
  const prepared = preparePluginCodexHome(env, options);
  return {
    ...env,
    CODEX_HOME: prepared.pluginHome,
    CODEX_OVERLEAF_CODEX_HOME: prepared.pluginHome,
    CODEX_OVERLEAF_USER_CODEX_HOME: prepared.userHome
  };
}

function composePluginSkillsDirectory({
  userHome,
  pluginHome,
  env,
  options = {},
  loadCodexLocalSkills = true,
  loadCodexOverleafSkills = true,
  installCodexOverleafSkillsTarget = false,
  projectLocalSkills = null
} = {}) {
  const targetRoot = path.join(pluginHome, 'skills');
  if (!isSafePluginHomePath(targetRoot, pluginHome)) {
    return { linked: false, skippedLinks: [{ name: 'skills', reason: 'unsafe_target' }] };
  }
  fs.rmSync(targetRoot, { recursive: true, force: true });

  if (installCodexOverleafSkillsTarget) {
    const overleafSkillsRoot = getCodexOverleafSkillsRoot({ env });
    fs.mkdirSync(overleafSkillsRoot, { recursive: true });
    const linkResult = ensureSymlink(overleafSkillsRoot, targetRoot, options);
    return linkResult.ok
      ? { linked: true, skippedLinks: [] }
      : { linked: false, skippedLinks: [{ name: 'skills', reason: linkResult.reason }] };
  }

  const sources = [];
  if (loadCodexLocalSkills) {
    sources.push({
      name: 'codex-local',
      root: path.join(userHome, 'skills'),
      replaceExisting: false
    });
  }
  if (loadCodexOverleafSkills) {
    sources.push({
      name: 'codex-overleaf',
      root: getCodexOverleafSkillsRoot({ env }),
      replaceExisting: true
    });
  }

  let linked = false;
  const skippedLinks = [];
  for (const source of sources) {
    if (!isDirectory(source.root)) {
      continue;
    }
    for (const entry of fs.readdirSync(source.root, { withFileTypes: true })) {
      if (!(entry.isDirectory() || (source.name === 'codex-local' && entry.isSymbolicLink()
        && isDirectory(path.join(source.root, entry.name)))) || !isSafeSkillEntryName(entry.name)) {
        continue;
      }
      if (source.name === 'codex-overleaf') {
        if (Array.isArray(options.enabledCodexOverleafSkillIds) && !options.enabledCodexOverleafSkillIds.includes(entry.name)) continue;
        if (Array.isArray(options.disableCodexOverleafSkillIds) && options.disableCodexOverleafSkillIds.includes(entry.name)) continue;
      }
      const sourcePath = path.join(source.root, entry.name);
      const targetPath = path.join(targetRoot, entry.name);
      if (!isSafePluginHomePath(targetPath, pluginHome)) {
        skippedLinks.push({ name: `skills/${entry.name}`, reason: 'unsafe_target' });
        continue;
      }
      if (source.replaceExisting) {
        preserveLocalSkillAlias(targetPath, targetRoot, options);
        fs.rmSync(targetPath, { recursive: true, force: true });
      }
      const linkResult = ensureSymlink(sourcePath, targetPath, options);
      if (!linkResult.ok) {
        skippedLinks.push({
          name: `skills/${entry.name}`,
          reason: linkResult.reason
        });
        continue;
      }
      linked = true;
    }
  }

  if (projectLocalSkills?.projectId) {
    try {
      const materialized = materializeProjectSkillsAsCodexSkills({
        projectId: projectLocalSkills.projectId,
        rootDir: projectLocalSkills.rootDir,
        projectRoot: projectLocalSkills.projectRoot,
        targetRoot
      });
      if (materialized.installed.length) {
        linked = true;
      }
      for (const item of materialized.skipped) {
        skippedLinks.push({
          name: `skills/${item.id || 'project-local'}`,
          reason: item.reason || 'project_skill_skipped'
        });
      }
    } catch (error) {
      skippedLinks.push({
        name: 'skills/project-local',
        reason: error.message || 'project_skill_materialize_failed'
      });
    }
  }

  if (!linked && !skippedLinks.length) {
    fs.rmSync(targetRoot, { recursive: true, force: true });
  }
  return { linked, skippedLinks };
}

function preserveLocalSkillAlias(targetPath, targetRoot, options) {
  let target;
  try {
    if (!fs.lstatSync(targetPath).isSymbolicLink()) return;
    target = fs.realpathSync(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const suffix = createHash('sha256').update(target).digest('hex').slice(0, 16);
  const alias = path.join(targetRoot, `${path.basename(targetPath)}.codex-local-${suffix}`);
  const result = ensureSymlink(target, alias, options);
  if (!result.ok) throw new Error('The local skill alias could not be preserved.');
}

function clearPluginCodexHistory(optionsOrEnv = {}, maybeEnv = null) {
  const { options, env } = normalizeClearHistoryArgs(optionsOrEnv, maybeEnv);
  const pluginHome = getPluginCodexHome(env);

  if (options.threadId) {
    return clearPluginCodexThreadHistory(pluginHome, options.threadId);
  }

  if (options.scope !== 'all') {
    return {
      pluginHome,
      removed: [],
      scope: 'thread',
      skipped: true,
      reason: 'missing_thread_id'
    };
  }

  const removed = [];

  for (const dirName of HISTORY_DIRS) {
    const target = path.join(pluginHome, dirName);
    if (!isInsideDirectory(target, pluginHome) || !fs.existsSync(target)) {
      continue;
    }
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(dirName);
  }

  return {
    pluginHome,
    removed,
    scope: 'all'
  };
}

function normalizeClearHistoryArgs(optionsOrEnv, maybeEnv) {
  if (maybeEnv) {
    return {
      options: normalizeClearHistoryOptions(optionsOrEnv),
      env: maybeEnv
    };
  }

  const first = optionsOrEnv || {};
  const looksLikeEnv = hasAnyOwn(first, [
    'HOME',
    'CODEX_HOME',
    'CODEX_OVERLEAF_CODEX_HOME',
    'CODEX_OVERLEAF_USER_CODEX_HOME'
  ]) && !hasAnyOwn(first, ['scope', 'threadId', 'sessionId']);

  if (looksLikeEnv) {
    return {
      options: { scope: 'all' },
      env: first
    };
  }

  return {
    options: normalizeClearHistoryOptions(first),
    env: process.env
  };
}

function normalizeClearHistoryOptions(options = {}) {
  return {
    ...options,
    threadId: String(options.threadId || '').trim(),
    scope: options.scope || (options.threadId ? 'thread' : '')
  };
}

function clearPluginCodexThreadHistory(pluginHome, threadId) {
  const removed = [];
  for (const dirName of HISTORY_DIRS) {
    const root = path.join(pluginHome, dirName);
    if (!isInsideDirectory(root, pluginHome) || !fs.existsSync(root)) {
      continue;
    }
    for (const filePath of listRegularFiles(root)) {
      if (!fileContainsThreadId(filePath, threadId)) {
        continue;
      }
      fs.rmSync(filePath, { force: true });
      removed.push(toForwardSlashPath(path.relative(pluginHome, filePath)));
      removeEmptyParents(path.dirname(filePath), root);
    }
  }
  return {
    pluginHome,
    removed,
    scope: 'thread',
    threadId
  };
}

function listRegularFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  }
  return files;
}

function fileContainsThreadId(filePath, threadId) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) {
      return false;
    }
    return fs.readFileSync(filePath, 'utf8').includes(JSON.stringify(threadId));
  } catch {
    return false;
  }
}

function removeEmptyParents(startDir, stopDir) {
  let current = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  while (current && current !== stop && isInsideDirectory(current, stop)) {
    try {
      fs.rmdirSync(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

function hasAnyOwn(object, keys) {
  return keys.some(key => Object.prototype.hasOwnProperty.call(object, key));
}

function toForwardSlashPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function isRegularFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isSafeSkillEntryName(value) {
  const name = String(value || '');
  return Boolean(name)
    && name !== '.'
    && name !== '..'
    && !name.includes('/')
    && !name.includes('\\')
    && !name.includes('\0');
}

function isSafePluginHomePath(target, pluginHome) {
  return path.resolve(target) === path.resolve(pluginHome) || isInsideDirectory(target, pluginHome);
}

function ensureSymlink(source, target, options = {}) {
  try {
    const existing = fs.lstatSync(target);
    if (existing.isSymbolicLink() && path.resolve(fs.readlinkSync(target)) === path.resolve(source)) {
      return { ok: true };
    }
    return { ok: false, reason: 'target_exists' };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return { ok: false, reason: error.code || 'lstat_failed' };
    }
  }

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(source, target, getDirectorySymlinkType(options));
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.code || 'link_failed' };
  }
}

function getDirectorySymlinkType(options = {}) {
  return getNativeHostPlatform(options) === 'win32' ? 'junction' : 'dir';
}

function chmodIfPossible(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Best effort: native host still works on filesystems that do not support POSIX modes.
  }
}

function samePath(left, right) {
  const resolvedLeft = path.resolve(left), resolvedRight = path.resolve(right);
  if (resolvedLeft === resolvedRight) return true;
  try { return fs.realpathSync(resolvedLeft) === fs.realpathSync(resolvedRight); }
  catch { return false; }
}

function isInsideDirectory(target, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

module.exports = {
  buildCodexHomeEnv,
  clearPluginCodexHistory,
  composePluginSkillsDirectory,
  ensureDefaultCodexOverleafSkills,
  getPluginCodexHome,
  getUserCodexHome,
  preparePluginCodexHome
};
