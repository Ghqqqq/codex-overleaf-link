'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RUNTIME_ENV_KEY = 'CODEX_OVERLEAF_CODEX_RUNTIME_JSON';
const MAX_CODEX_CANDIDATES = 8;
const VERSION_TIMEOUT_MS = 3000;

function buildCodexRuntimeIdentity(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const delimiter = options.delimiter || (platform === 'win32' ? ';' : path.delimiter);
  const selectedPath = String(options.selectedPath || '').trim();
  const discovered = discoverCodexCandidates(options.pathValue || env.PATH || '', {
    delimiter,
    env,
    platform
  });
  const candidatePaths = selectedPath
    ? [selectedPath, ...discovered.filter(candidate => !sameExecutablePath(candidate, selectedPath, platform))]
    : discovered;
  const candidates = candidatePaths.slice(0, MAX_CODEX_CANDIDATES).map(candidatePath => ({
    path: candidatePath,
    displayPath: compactHomePath(candidatePath, env, platform),
    version: readCodexVersion(candidatePath, { env, platform }),
    source: classifyCodexSource(candidatePath),
    selected: false
  }));
  const selectedIndex = selectCodexCandidateIndex(candidates, {
    selectedPath,
    selectionPolicy: options.selectionPolicy,
    platform
  });
  if (selectedIndex >= 0) {
    candidates[selectedIndex].selected = true;
  }
  const selected = selectedIndex >= 0 ? candidates[selectedIndex] : null;

  return {
    schemaVersion: 1,
    selected,
    candidates,
    multipleInstallations: candidates.length > 1,
    selectedBy: selected
      ? options.selectionPolicy === 'newest-version' ? 'newest-version' : options.selectionPolicy === 'explicit-path' ? 'explicit-path' : 'path-order'
      : 'not-found'
  };
}

function selectCodexCandidateIndex(candidates, options = {}) {
  if (!candidates.length) return -1;
  if (options.selectionPolicy !== 'newest-version') {
    if (!options.selectedPath) return -1;
    return candidates.findIndex(candidate => sameExecutablePath(
      candidate.path,
      options.selectedPath,
      options.platform
    ));
  }

  let selectedIndex = 0;
  for (let index = 1; index < candidates.length; index += 1) {
    if (compareCodexVersions(candidates[index].version, candidates[selectedIndex].version) > 0) {
      selectedIndex = index;
    }
  }
  return selectedIndex;
}

function compareCodexVersions(left, right) {
  const leftVersion = parseCodexVersion(left);
  const rightVersion = parseCodexVersion(right);
  if (!leftVersion && !rightVersion) return 0;
  if (!leftVersion) return -1;
  if (!rightVersion) return 1;

  for (let index = 0; index < 3; index += 1) {
    if (leftVersion.core[index] !== rightVersion.core[index]) {
      return leftVersion.core[index] - rightVersion.core[index];
    }
  }
  if (!leftVersion.prerelease && rightVersion.prerelease) return 1;
  if (leftVersion.prerelease && !rightVersion.prerelease) return -1;
  if (!leftVersion.prerelease && !rightVersion.prerelease) return 0;
  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

function parseCodexVersion(value) {
  const match = String(value || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?/);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] || ''
  };
}

function comparePrerelease(left, right) {
  const leftParts = left.split('.');
  const rightParts = right.split('.');
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    if (leftParts[index] === undefined) return -1;
    if (rightParts[index] === undefined) return 1;
    if (leftParts[index] === rightParts[index]) continue;
    const leftNumber = /^\d+$/.test(leftParts[index]) ? Number(leftParts[index]) : null;
    const rightNumber = /^\d+$/.test(rightParts[index]) ? Number(rightParts[index]) : null;
    if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return leftParts[index].localeCompare(rightParts[index]);
  }
  return 0;
}

function discoverCodexCandidates(pathValue, options = {}) {
  const platform = options.platform || process.platform;
  const delimiter = options.delimiter || (platform === 'win32' ? ';' : path.delimiter);
  const extensions = executableExtensions(options.env || process.env, platform);
  const seen = new Set();
  const result = [];

  for (const rawSegment of String(pathValue || '').split(delimiter)) {
    const segment = rawSegment.trim();
    if (!segment) continue;
    for (const extension of extensions) {
      const candidate = path.join(segment, `codex${extension}`);
      const key = platform === 'win32' ? candidate.toLowerCase() : candidate;
      if (seen.has(key) || !isExecutableFile(candidate, platform)) continue;
      seen.add(key);
      result.push(candidate);
      break;
    }
  }
  return result;
}

function executableExtensions(env, platform) {
  if (platform !== 'win32') return [''];
  const configured = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  return ['', ...new Set(configured)];
}

function isExecutableFile(candidate, platform) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readCodexVersion(candidatePath, options = {}) {
  if (!candidatePath) return '';
  const platform = options.platform || process.platform;
  const result = spawnSync(candidatePath, ['--version'], {
    encoding: 'utf8',
    env: options.env || process.env,
    maxBuffer: 64 * 1024,
    shell: platform === 'win32' && /\.(?:cmd|bat)$/i.test(candidatePath),
    timeout: VERSION_TIMEOUT_MS,
    windowsHide: true
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  const match = output.match(/\bcodex(?:-cli)?\s+v?([^\s]+)/i);
  return match ? match[1] : '';
}

function classifyCodexSource(candidatePath) {
  const normalized = normalizeSlashes(candidatePath).toLowerCase();
  let resolved = normalized;
  try {
    resolved = normalizeSlashes(fs.realpathSync(candidatePath)).toLowerCase();
  } catch {
    // Keep the visible path when a symlink target cannot be resolved.
  }
  if (normalized.includes('/applications/chatgpt.app/')) return 'chatgpt-app';
  if (normalized.includes('/applications/codex.app/')) return 'codex-app';
  if (normalized.includes('/.nvm/versions/node/')) return 'npm-nvm';
  if (resolved.includes('/node_modules/@openai/codex')) return 'npm-global';
  if (normalized.includes('/opt/homebrew/') || normalized.includes('/homebrew/')) return 'homebrew-prefix';
  if (normalized.includes('/.npm-global/')) return 'npm-global';
  return 'path';
}

function compactHomePath(candidatePath, env = process.env, platform = process.platform) {
  const home = String(env.HOME || env.USERPROFILE || os.homedir() || '');
  if (!home) return candidatePath;
  const caseFold = value => platform === 'win32' ? value.toLowerCase() : value;
  const normalizedCandidate = path.normalize(candidatePath);
  const normalizedHome = path.normalize(home);
  if (caseFold(normalizedCandidate) === caseFold(normalizedHome)) return '~';
  if (caseFold(normalizedCandidate).startsWith(`${caseFold(normalizedHome)}${path.sep}`)) {
    return `~${path.sep}${normalizedCandidate.slice(normalizedHome.length + 1)}`;
  }
  return candidatePath;
}

function serializeCodexRuntimeIdentity(identity) {
  return JSON.stringify(identity || emptyIdentity());
}

function getCodexRuntimeIdentityFromEnv(env = process.env) {
  try {
    const parsed = JSON.parse(String(env[RUNTIME_ENV_KEY] || ''));
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.candidates)) return parsed;
  } catch {
    // Fall through to the legacy single-path representation.
  }
  const selectedPath = String(env.CODEX_OVERLEAF_CODEX_PATH || '').trim();
  const selected = selectedPath ? {
    path: selectedPath,
    displayPath: compactHomePath(selectedPath, env, env.CODEX_OVERLEAF_PLATFORM || process.platform),
    version: String(env.CODEX_OVERLEAF_CODEX_VERSION || ''),
    source: String(env.CODEX_OVERLEAF_CODEX_SOURCE || classifyCodexSource(selectedPath)),
    selected: true
  } : null;
  return {
    schemaVersion: 1,
    selected,
    candidates: selected ? [selected] : [],
    multipleInstallations: false,
    selectedBy: selected ? 'legacy-path' : 'not-found'
  };
}

function buildCodexRuntimeEvent(env = process.env) {
  const identity = getCodexRuntimeIdentityFromEnv(env);
  const selected = identity.selected;
  if (!selected) return null;
  const version = selected.version || 'unknown version';
  const candidateCount = identity.candidates.length;
  return {
    type: 'codex.runtime.selected',
    title: identity.multipleInstallations
      ? `Using Codex CLI ${version}; ${candidateCount} installations were detected.`
      : `Using Codex CLI ${version}.`,
    status: 'completed',
    detail: {
      path: selected.displayPath || selected.path,
      version: selected.version || '',
      source: selected.source || 'path',
      selectedBy: identity.selectedBy || 'path-order',
      multipleInstallations: identity.multipleInstallations === true,
      warningCode: identity.multipleInstallations ? 'multiple_codex_installations' : '',
      candidates: identity.candidates.map(candidate => ({
        path: candidate.displayPath || candidate.path,
        version: candidate.version || '',
        source: candidate.source || 'path',
        selected: candidate.selected === true
      })),
      technical: true
    }
  };
}

function sameExecutablePath(left, right, platform) {
  const normalize = value => path.normalize(String(value || ''));
  return platform === 'win32'
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
}

function normalizeSlashes(value) {
  return String(value || '').replace(/\\/g, '/');
}

function emptyIdentity() {
  return {
    schemaVersion: 1,
    selected: null,
    candidates: [],
    multipleInstallations: false,
    selectedBy: 'not-found'
  };
}

module.exports = {
  RUNTIME_ENV_KEY,
  buildCodexRuntimeEvent,
  buildCodexRuntimeIdentity,
  discoverCodexCandidates,
  getCodexRuntimeIdentityFromEnv,
  readCodexVersion,
  serializeCodexRuntimeIdentity
};
