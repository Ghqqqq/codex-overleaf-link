'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { rebaseCodexConfigPaths } = require('./codexConfigPaths');
const { AUTH_SOURCE_MARKER, copyInheritedAuth, removeMissingInheritedAuth } = require('./codexInheritedAuth');
const { getCodexOverleafSkillsRoot } = require('./localSkills');

const HISTORY_DIRS = ['sessions', 'archived_sessions', 'history'];
const SCOPE_MARKER = '.codex-overleaf-scope.json';

function prepareScopedPluginCodexHome(env, options, home) {
  const { userHome, canonicalHome, prepare, ensureSkills, prepareConfig } = home;
  fs.mkdirSync(canonicalHome, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(canonicalHome, 0o700); } catch { /* Match the existing best-effort home permissions. */ }
  synchronizeAuth(path.join(userHome, 'auth.json'), path.join(canonicalHome, 'auth.json'));
  ensureSkills({ env });
  const overleafRoot = getCodexOverleafSkillsRoot({ env });
  const capturedConfig = readOptionalFile(path.join(userHome, 'config.toml'));
  const descriptor = {
    version: 1,
    userHome,
    local: options.loadCodexLocalSkills !== false,
    overleaf: options.loadCodexOverleafSkills !== false,
    installer: options.installCodexOverleafSkillsTarget === true,
    enabled: normalizedIds(options.enabledCodexOverleafSkillIds),
    disabled: normalizedIds(options.disableCodexOverleafSkillIds),
    config: digest(capturedConfig),
    localSkills: options.loadCodexLocalSkills !== false ? directoryIdentity(path.join(userHome, 'skills')) : [],
    // Installer targets stay stable while installed skill contents grow.
    pluginSkills: options.installCodexOverleafSkillsTarget === true
      ? overleafRoot
      : options.loadCodexOverleafSkills !== false ? directoryIdentity(overleafRoot) : [],
    projectSkills: options.projectLocalSkills || null
  };
  const key = digest(JSON.stringify(descriptor));
  const scopesRoot = path.join(canonicalHome, 'runtime-homes');
  fs.mkdirSync(scopesRoot, { recursive: true, mode: 0o700 });
  const scopeHome = path.join(scopesRoot, key);
  for (const name of HISTORY_DIRS) fs.mkdirSync(path.join(canonicalHome, name), { recursive: true });

  if (!isReady(scopeHome, key)) {
    const staging = fs.mkdtempSync(path.join(scopesRoot, '.prepare-'));
    try {
      prepare({ ...env, CODEX_OVERLEAF_CODEX_HOME: staging, CODEX_OVERLEAF_USER_CODEX_HOME: userHome }, {
        ...options,
        skipCopiedUserConfig: true,
        enabledCodexOverleafSkillIds: descriptor.enabled || undefined,
        disableCodexOverleafSkillIds: descriptor.disabled || undefined
      });
      // Published scopes inherit from the canonical home, including provenance.
      // The staging prepare's direct user copy must never escape publication.
      fs.rmSync(path.join(staging, 'auth.json'), { force: true });
      fs.rmSync(path.join(staging, AUTH_SOURCE_MARKER), { force: true });
      synchronizeAuth(path.join(canonicalHome, 'auth.json'), path.join(staging, 'auth.json'));
      const configFile = path.join(staging, 'config.toml');
      const config = prepareConfig(capturedConfig.toString('utf8'), options);
      fs.writeFileSync(configFile, rebaseCodexConfigPaths(config, canonicalHome), { mode: 0o600 });
      for (const name of HISTORY_DIRS) {
        fs.symlinkSync(path.join(canonicalHome, name), path.join(staging, name), options.platform === 'win32' || process.platform === 'win32' ? 'junction' : 'dir');
      }
      fs.writeFileSync(path.join(staging, SCOPE_MARKER), JSON.stringify({ version: 1, key }), { mode: 0o600 });
      try { fs.renameSync(staging, scopeHome); }
      catch (error) {
        // Another process may have atomically published this complete scope.
        // Never remove a final directory or return an incomplete environment.
        if (!isReady(scopeHome, key)) throw error;
      }
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  synchronizeAuth(path.join(userHome, 'auth.json'), path.join(canonicalHome, 'auth.json'));
  synchronizeAuth(path.join(canonicalHome, 'auth.json'), path.join(scopeHome, 'auth.json'));
  // Refresh discovery caches without rewriting a live scope's configuration or
  // replacing the skill paths a process has already discovered.
  for (const name of ['installation_id', 'models_cache.json', 'version.json']) {
    const source = path.join(userHome, name);
    if (isFile(source)) fs.copyFileSync(source, path.join(scopeHome, name));
  }
  return { userHome, pluginHome: scopeHome, canonicalHome };
}

function synchronizeAuth(source, target) {
  if (isFile(source)) copyInheritedAuth(source, target);
  else removeMissingInheritedAuth(source, target);
}

function normalizedIds(value) {
  return Array.isArray(value) ? Array.from(new Set(value.map(id => String(id || '').trim()).filter(Boolean))).sort() : null;
}

function directoryIdentity(root) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries.filter(entry => entry.isDirectory()).map(entry => {
    const location = path.join(root, entry.name);
    return [entry.name, fs.realpathSync(location)];
  }).sort((a, b) => a[0].localeCompare(b[0]));
}

function isReady(directory, key) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(directory, SCOPE_MARKER), 'utf8'));
    if (marker.version === 1 && marker.key === key && !fs.lstatSync(directory).isSymbolicLink()) return true;
    throw new Error('The plugin Codex scope has invalid ownership metadata.');
  } catch (error) {
    if (error.code === 'ENOENT' && !fs.existsSync(directory)) return false;
    throw error;
  }
}

function isFile(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }
function readOptionalFile(file) { try { return fs.readFileSync(file); } catch (error) { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; } }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

module.exports = { prepareScopedPluginCodexHome };
