'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { version: PACKAGE_VERSION } = require('../../package.json');
const { getCodexOverleafSkillsRoot } = require('./localSkills');
const { resolveCodexCommand, shouldUseShellForCommand } = require('./codexCommand');
const { runOwnedNativeHelper } = require('./nativeHelperLifecycle');
const { stopCodexAppServer, throwIfAborted, getAbortReason } = require('./codexSessionTiming');

const CODEX_LOCAL_SKILL_SCOPE = 'codex-local';
const MAX_SKILL_BYTES = 64 * 1024;
const MAX_DISCOVERY_BYTES = 4 * 1024 * 1024;
const DISCOVERY_TIMEOUT_MS = 30000;

// System skills are regenerated inside each scoped home. Ordinary skills keep
// their physical source identity, including aliases and same-name skills.
function createCodexLocalSkillIdentity(skill = {}, env = process.env) {
  const name = String(skill.name || '').trim();
  let source;
  if (skill.scope === 'system' && name) source = `system:${name}`;
  else {
    const location = canonicalSkillPath(skill.path);
    if (!location) return '';
    source = `path:${location}`;
  }
  return `local-${crypto.createHash('sha256').update(source).digest('hex')}`;
}

function isCodexOverleafSkillSource(skill = {}, env = process.env) {
  if (!path.isAbsolute(String(skill.path || ''))) return false;
  const root = getCodexOverleafSkillsRoot({ env });
  const roots = comparablePaths(root);
  return comparablePaths(skill.path).some(candidate => roots.some(base => isInside(candidate, base)));
}

async function listCodexLocalSkills(options = {}) {
  const { entries, discoveryWarnings } = await discoverLocalSkills(options);
  return { skills: entries.map(entry => entry.metadata), discoveryWarnings };
}

async function loadSelectedCodexLocalSkill({ skillId, loadCodexLocalSkills = true,
  enabledCodexLocalSkillIds, env = process.env, signal, timeoutMs } = {}) {
  const id = String(skillId || '').trim();
  const empty = { skill: null, missing: [], ignored: [] };
  if (!id) return empty;
  if (loadCodexLocalSkills === false) return { ...empty, ignored: [{ id, reason: 'codex_local_skills_disabled' }] };
  if (Array.isArray(enabledCodexLocalSkillIds) && !enabledCodexLocalSkillIds.includes(id)) {
    return { ...empty, ignored: [{ id, reason: 'codex_local_skill_disabled' }] };
  }
  if (!/^local-[a-f0-9]{64}$/.test(id)) return { ...empty, missing: [id] };
  const { entries } = await discoverLocalSkills({ env, signal, timeoutMs });
  throwIfAborted(signal);
  const entry = entries.find(item => item.metadata.id === id);
  if (!entry) return { ...empty, missing: [id] };
  if (!Array.isArray(enabledCodexLocalSkillIds) && entry.metadata.enabled === false) {
    return { ...empty, ignored: [{ id, reason: 'codex_local_skill_disabled' }] };
  }
  const content = readSelectedContent(entry);
  if (content === null) return { ...empty, missing: [id] };
  return { ...empty, skill: { ...entry.metadata, path: entry.canonicalPath, content } };
}

async function discoverLocalSkills({ env = process.env, signal, timeoutMs = DISCOVERY_TIMEOUT_MS } = {}) {
  return runOwnedNativeHelper(async ownedSignal => {
    throwIfAborted(ownedSignal);
    // Lazy import avoids the home -> isolation -> identity helper cycle.
    const { buildCodexHomeEnv } = require('./codexHome');
    const childEnv = buildCodexHomeEnv(env, { isolateRuntimeHome: true, forceIsolatedSkillSettings: true,
      loadCodexLocalSkills: true, loadCodexOverleafSkills: false });
    throwIfAborted(ownedSignal);
    const result = await runSkillsMetadataProcess(childEnv, ownedSignal, timeoutMs);
    throwIfAborted(ownedSignal);
    return normalizeCatalog(result, childEnv);
  }, signal);
}

function normalizeCatalog(result, env) {
  if (!Array.isArray(result?.data)) throw codedError('codex_local_skills_invalid_response', 'Codex returned an invalid local skill catalog.');
  const entries = new Map();
  let skippedCount = 0;
  for (const group of result.data) {
    if (!Array.isArray(group?.skills)) throw codedError('codex_local_skills_invalid_response', 'Codex returned an invalid local skill catalog.');
    if (group.errors !== undefined && !Array.isArray(group.errors)) {
      throw codedError('codex_local_skills_invalid_response', 'Codex returned an invalid local skill catalog.');
    }
    // Invalid source files are omitted by Codex. Keep valid skills available
    // while exposing only a count, never filesystem paths or error contents.
    skippedCount += group.errors?.length || 0;
    for (const skill of group.skills) {
      if (!skill || typeof skill !== 'object' || isCodexOverleafSkillSource(skill, env)) continue;
      const name = cleanText(skill.name, 160);
      const canonicalPath = canonicalSkillPath(skill.path);
      const id = createCodexLocalSkillIdentity(skill, env);
      if (!id || !name || !canonicalPath) continue;
      const sourceKind = getSkillSourceKind(skill, canonicalPath, env);
      const description = cleanText(skill.description, 2048);
      const metadata = { id, name, title: cleanText(skill.interface?.displayName, 160) || name,
        description, preview: cleanText(skill.interface?.shortDescription || skill.shortDescription || description, 240),
        scope: CODEX_LOCAL_SKILL_SCOPE, sourceKind,
        sourceLabel: sourceKind === 'plugin' ? cleanText(skill.pluginId, 160) || pluginNamePrefix(name) : '',
        enabled: skill.enabled !== false, removable: false };
      const existing = entries.get(id);
      if (existing) {
        // An enabled alias makes this same physical skill discoverable.
        existing.metadata.enabled ||= metadata.enabled;
        continue;
      }
      entries.set(id, { metadata, canonicalPath, discoveredPath: String(skill.path) });
    }
  }
  const resolvedEntries = Array.from(entries.values());
  const names = new Map(), titles = new Map();
  for (const { metadata } of resolvedEntries) {
    names.set(metadata.name, (names.get(metadata.name) || 0) + 1);
    titles.set(metadata.title, (titles.get(metadata.title) || 0) + 1);
  }
  for (const entry of resolvedEntries) {
    if (names.get(entry.metadata.name) > 1 || titles.get(entry.metadata.title) > 1) {
      entry.metadata.sourceHint = buildSourceHint(entry, env, resolvedEntries);
    }
  }
  return {
    entries: resolvedEntries.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name) || a.metadata.id.localeCompare(b.metadata.id)),
    discoveryWarnings: skippedCount ? [{ code: 'codex_local_skills_skipped', count: skippedCount }] : []
  };
}

function buildSourceHint(entry, env, entries) {
  if (entry.metadata.sourceKind === 'system') return `.system/${entry.metadata.name}`;
  const { getUserCodexHome } = require('./codexHome');
  const userHome = getUserCodexHome(env), directory = path.dirname(entry.canonicalPath);
  const relativeDirectory = root => {
    for (const base of comparablePaths(root)) {
      if (directory === base || isInside(directory, base)) return path.relative(base, directory).split(path.sep).join('/');
    }
    return null;
  };
  if (entry.metadata.sourceKind === 'plugin') {
    const relative = relativeDirectory(path.join(userHome, 'plugins'));
    if (relative !== null) return `plugins/${relative.replace(/^cache\//, '')}`;
  }
  const relative = relativeDirectory(userHome);
  if (relative !== null) return relative || path.basename(directory);
  // A user skill symlink may point outside the home. Recover its original
  // relative entry from the composed discovery path without exposing its target.
  const discovered = path.resolve(entry.discoveredPath), runtimeSkills = path.join(String(env.CODEX_HOME || ''), 'skills');
  if (isInside(discovered, runtimeSkills)) {
    const inSkills = path.relative(runtimeSkills, discovered);
    if (canonicalSkillPath(path.join(userHome, 'skills', inSkills)) === entry.canonicalPath) {
      return `skills/${path.dirname(inSkills).split(path.sep).join('/')}`;
    }
  }
  const parts = directory.split(path.sep).filter(Boolean);
  const peers = entries.filter(other => other !== entry && (other.metadata.name === entry.metadata.name
    || other.metadata.title === entry.metadata.title)).map(other => path.dirname(other.canonicalPath).split(path.sep).filter(Boolean));
  let count = Math.min(3, parts.length);
  while (count < parts.length && peers.some(other => other.slice(-count).join('/') === parts.slice(-count).join('/'))) count++;
  return `…/${parts.slice(-count).join('/')}`;
}

function getSkillSourceKind(skill, canonicalPath, env) {
  if (skill.scope === 'system') return 'system';
  if (skill.pluginId) return 'plugin';
  // Current app-server metadata reports plugin skills as scope "user" and
  // does not carry a pluginId. Classify only returned files under the active
  // user plugin root; discovering old cache directories is never necessary.
  const { getUserCodexHome } = require('./codexHome');
  const pluginRoots = comparablePaths(path.join(getUserCodexHome(env), 'plugins'));
  if (pluginRoots.some(root => isInside(canonicalPath, root))) return 'plugin';
  return skill.scope === 'user' ? 'user' : 'local';
}

function pluginNamePrefix(name) {
  const prefix = name.includes(':') ? name.slice(0, name.indexOf(':')).trim() : '';
  return /[/\\]/.test(prefix) ? '' : prefix;
}

function runSkillsMetadataProcess(env, signal, timeoutMs) {
  const command = resolveCodexCommand(env);
  if (!command) throw codedError('codex_not_found', 'Codex CLI was not found.');
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const child = spawn(command, ['app-server', '--listen', 'stdio://'], {
      cwd: env.CODEX_HOME, env, shell: shouldUseShellForCommand(command, env),
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']
    });
    const pending = new Map();
    let sequence = 0, buffer = '', outputBytes = 0, settled = false;
    const onAbort = () => finish(getAbortReason(signal));
    const budget = Math.min(DISCOVERY_TIMEOUT_MS, Math.max(1, Number(timeoutMs) || DISCOVERY_TIMEOUT_MS));
    const timer = setTimeout(() => finish(codedError('codex_local_skills_timeout', 'Local Codex skill discovery timed out.')), budget);
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (settled || !countOutput(chunk)) return;
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (settled) break;
        if (line.trim()) handleMessage(line);
      }
    });
    // Stderr may contain user configuration paths or server diagnostics. Count
    // it for bounded lifetime, but never return it as catalog/UI content.
    child.stderr.on('data', chunk => { if (!settled) countOutput(chunk); });
    child.stdin.on('error', () => finish(codedError('codex_local_skills_failed', 'Local Codex skill discovery failed.')));
    child.on('error', error => finish(codedError(error.code === 'ENOENT' ? 'codex_not_found' : 'codex_local_skills_failed', 'Codex could not start local skill discovery.')));
    child.on('close', () => { if (!settled) finish(codedError('codex_local_skills_failed', 'Codex exited before local skill discovery completed.')); });
    (async () => {
      throwIfAborted(signal);
      await request('initialize', { clientInfo: { name: 'codex-overleaf-link', version: PACKAGE_VERSION }, capabilities: null });
      child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
      const result = await request('skills/list', { cwd: env.CODEX_HOME, cwds: [env.CODEX_HOME], includeDisabled: true, forceReload: true });
      finish(null, result);
    })().catch(finish);

    function countOutput(chunk) {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes <= MAX_DISCOVERY_BYTES) return true;
      finish(codedError('codex_local_skills_output_limit', 'Local Codex skill discovery exceeded its output limit.'));
      return false;
    }
    function request(method, params) {
      return new Promise((resolveRequest, rejectRequest) => {
        if (settled) return rejectRequest(codedError('codex_local_skills_closed', 'Local Codex skill discovery has closed.'));
        const id = ++sequence;
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    }
    function handleMessage(line) {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const waiter = pending.get(message?.id);
      if (waiter && (Object.hasOwn(message, 'result') || message.error)) {
        pending.delete(message.id);
        if (message.error) waiter.reject(codedError('codex_local_skills_failed', 'Codex could not list local skills.'));
        else waiter.resolve(message.result);
      } else if (message && Object.hasOwn(message, 'id') && message.method) {
        child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unsupported during skill discovery' } })}\n`);
      }
    }
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      for (const waiter of pending.values()) waiter.reject(error || codedError('codex_local_skills_closed', 'Local Codex skill discovery has closed.'));
      pending.clear();
      stopCodexAppServer(child, { processGroup: process.platform !== 'win32', reason: error }).then(() => {
        if (error) reject(error); else resolve(result);
      }, reject);
    }
  });
}

function readSelectedContent(entry) {
  let fd;
  try {
    if (canonicalSkillPath(entry.discoveredPath) !== entry.canonicalPath) return null;
    fd = fs.openSync(entry.canonicalPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) return null;
    const bytes = Buffer.alloc(MAX_SKILL_BYTES + 1);
    let length = 0, count;
    while ((count = fs.readSync(fd, bytes, length, bytes.length - length, length)) > 0) {
      length += count;
      if (length > MAX_SKILL_BYTES) return null;
    }
    if (canonicalSkillPath(entry.discoveredPath) !== entry.canonicalPath || bytes.subarray(0, length).includes(0)) return null;
    const current = fs.statSync(entry.canonicalPath);
    if (current.dev !== stat.dev || current.ino !== stat.ino) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP'].includes(error.code) || error instanceof TypeError) return null;
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function canonicalSkillPath(value) {
  if (!path.isAbsolute(String(value || '')) || path.basename(String(value)) !== 'SKILL.md') return '';
  try {
    const resolved = fs.realpathSync(String(value));
    return fs.statSync(resolved).isFile() ? resolved : '';
  } catch { return ''; }
}
function comparablePaths(value) {
  const resolved = path.resolve(value);
  try { return [resolved, fs.realpathSync(resolved)]; } catch { return [resolved]; }
}
function isInside(candidate, root) { const relative = path.relative(root, candidate); return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function cleanText(value, limit) { return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : ''; }
function codedError(code, message) { return Object.assign(new Error(message), { code }); }

module.exports = { CODEX_LOCAL_SKILL_SCOPE, createCodexLocalSkillIdentity, isCodexOverleafSkillSource,
  listCodexLocalSkills, loadSelectedCodexLocalSkill };
