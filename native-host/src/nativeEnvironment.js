'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  buildCodexRuntimeIdentity,
  getCodexRuntimeIdentityFromEnv,
  serializeCodexRuntimeIdentity
} = require('./codexRuntimeIdentity');

const TOOL_NAMES = ['codex', 'latexmk', 'pdflatex', 'xelatex', 'lualatex', 'bibtex', 'biber'];
const LATEX_TOOL_NAMES = ['latexmk', 'pdflatex', 'xelatex', 'lualatex', 'bibtex', 'biber'];
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'win32']);

function buildNativeRuntimeEnv(baseEnv = process.env, options = {}) {
  const env = { ...baseEnv };
  const explicitCodexPath = String(baseEnv.CODEX_OVERLEAF_CODEX_PATH || '').trim();
  const runtimeOptions = { ...options, platform: getNativeRuntimePlatform(options) };
  const loginShellEnv = options.readLoginShellEnv
    ? options.readLoginShellEnv(baseEnv, runtimeOptions)
    : readLoginShellEnv(baseEnv, runtimeOptions);
  const defaultPathSegments = Object.hasOwn(options, 'defaultPathSegments')
    ? options.defaultPathSegments
    : getDefaultPathSegments(baseEnv, runtimeOptions);
  const pathSegments = [
    ...getPathValues(loginShellEnv, runtimeOptions),
    ...getPathValues(baseEnv, runtimeOptions),
    ...defaultPathSegments
  ];

  env.PATH = mergePathSegments(pathSegments, runtimeOptions);
  normalizePathKeys(env, env.PATH, runtimeOptions);
  env.CODEX_OVERLEAF_ENV_READY = '1';
  env.CODEX_OVERLEAF_PLATFORM = runtimeOptions.platform;

  for (const tool of TOOL_NAMES) {
    env[getToolEnvName(tool)] = resolveExecutable(tool, env.PATH, { ...runtimeOptions, env }) || '';
  }
  const codexRuntime = buildCodexRuntimeIdentity({
    selectedPath: explicitCodexPath || env.CODEX_OVERLEAF_CODEX_PATH,
    selectionPolicy: explicitCodexPath ? 'explicit-path' : 'newest-version',
    pathValue: env.PATH,
    delimiter: runtimeOptions.delimiter,
    env,
    platform: runtimeOptions.platform
  });
  env.CODEX_OVERLEAF_CODEX_PATH = codexRuntime.selected?.path || '';
  env.CODEX_OVERLEAF_CODEX_RUNTIME_JSON = serializeCodexRuntimeIdentity(codexRuntime);
  env.CODEX_OVERLEAF_CODEX_VERSION = codexRuntime.selected?.version || '';
  env.CODEX_OVERLEAF_CODEX_SOURCE = codexRuntime.selected?.source || '';

  return env;
}

function readLoginShellEnv(baseEnv = process.env, options = {}) {
  if (getNativeRuntimePlatform(options) === 'win32') {
    return null;
  }
  if (baseEnv.CODEX_OVERLEAF_DISABLE_SHELL_ENV === '1') {
    return null;
  }

  const shell = selectLoginShell(baseEnv, options);
  if (!shell) {
    return null;
  }

  const command = [
    'printf "__CODEX_OVERLEAF_ENV_START__\\n"',
    'printf "PATH=%s\\n" "$PATH"',
    'printf "__CODEX_OVERLEAF_ENV_END__\\n"'
  ].join('; ');
  const args = shouldUseLoginFlag(shell) ? ['-l', '-i', '-c', command] : ['-c', command];
  const result = spawnSync(shell, args, {
    env: {
      ...baseEnv,
      PATH: baseEnv.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'
    },
    encoding: 'utf8',
    timeout: 1500,
    maxBuffer: 64 * 1024
  });

  if (result.error || result.status !== 0) {
    return null;
  }

  return parseMarkedShellEnv(result.stdout || '');
}

function parseMarkedShellEnv(output) {
  const match = String(output).match(/__CODEX_OVERLEAF_ENV_START__\n([\s\S]*?)\n__CODEX_OVERLEAF_ENV_END__/);
  if (!match) {
    return null;
  }

  const env = {};
  for (const line of match[1].split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index <= 0) {
      continue;
    }
    env[line.slice(0, index)] = line.slice(index + 1);
  }
  return env;
}

function selectLoginShell(env = process.env, options = {}) {
  if (getNativeRuntimePlatform(options) === 'win32') {
    return '';
  }

  const candidates = [
    env.SHELL,
    '/bin/zsh',
    '/bin/bash',
    '/bin/sh'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) {
      continue;
    }
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next common shell.
    }
  }
  return '';
}

function shouldUseLoginFlag(shell) {
  return ['zsh', 'bash'].includes(path.basename(shell));
}

function getDefaultPathSegments(env = process.env, options = {}) {
  const platform = getNativeRuntimePlatform(options);
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const home = env.HOME || os.homedir();
  const commonSegments = [
    path.dirname(process.execPath),
    platformPath.join(home, '.local/bin'),
    platformPath.join(home, '.npm-global/bin'),
    platformPath.join(home, 'bin'),
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ];
  if (platform === 'linux') {
    return [
      ...commonSegments.slice(0, 4),
      '/usr/local/texlive/2026/bin/x86_64-linux',
      '/usr/local/texlive/2025/bin/x86_64-linux',
      '/usr/local/texlive/bin/x86_64-linux',
      ...commonSegments.slice(4)
    ];
  }

  if (platform === 'win32') {
    return commonSegments;
  }

  return [
    ...commonSegments.slice(0, 4),
    platformPath.join(home, 'Applications/ChatGPT.app/Contents/Resources'),
    platformPath.join(home, 'Applications/Codex.app/Contents/Resources'),
    '/Applications/ChatGPT.app/Contents/Resources',
    '/Applications/Codex.app/Contents/Resources',
    '/Library/TeX/texbin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    ...commonSegments.slice(4)
  ];
}

function mergePathSegments(values, options = {}) {
  const delimiter = getPathDelimiter(options);
  const seen = new Set();
  const merged = [];
  for (const value of values) {
    for (const segment of splitPathValue(value, delimiter)) {
      const clean = segment.trim();
      if (!clean || seen.has(clean)) {
        continue;
      }
      seen.add(clean);
      merged.push(clean);
    }
  }
  return merged.join(delimiter);
}

function resolveExecutable(name, pathValue, options = {}) {
  const delimiter = getPathDelimiter(options);
  const executableNames = getExecutableCandidates(name, options);
  for (const directory of splitPathValue(pathValue, delimiter)) {
    if (!directory) {
      continue;
    }
    for (const executableName of executableNames) {
      const candidate = path.join(directory, executableName);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return '';
}

function summarizeNativeEnvironment(env = process.env, options = {}) {
  const codexRuntime = getCodexRuntimeIdentityFromEnv(env);
  const selectedCodex = codexRuntime.selected || {};
  const runtimeOptions = { ...options, platform: getNativeRuntimePlatform({ ...options, env }) };
  const availableLatex = LATEX_TOOL_NAMES.filter(tool => Boolean(env[getToolEnvName(tool)]));
  const missingLatex = LATEX_TOOL_NAMES.filter(tool => !env[getToolEnvName(tool)]);
  return {
    codex: {
      ok: Boolean(env.CODEX_OVERLEAF_CODEX_PATH),
      path: env.CODEX_OVERLEAF_CODEX_PATH || '',
      version: selectedCodex.version || '',
      source: selectedCodex.source || '',
      selectedBy: codexRuntime.selectedBy || 'not-found',
      multipleInstallations: codexRuntime.multipleInstallations === true,
      candidates: codexRuntime.candidates.map(candidate => ({
        path: candidate.displayPath || candidate.path || '',
        version: candidate.version || '',
        source: candidate.source || 'path',
        selected: candidate.selected === true
      }))
    },
    latex: {
      ok: availableLatex.length > 0,
      available: availableLatex,
      missing: missingLatex,
      tools: Object.fromEntries(LATEX_TOOL_NAMES.map(tool => [tool, env[getToolEnvName(tool)] || '']))
    },
    pathPreview: splitPathValue(env.PATH, getPathDelimiter(runtimeOptions)).filter(Boolean).slice(0, 12)
  };
}

function getToolEnvName(tool) {
  return `CODEX_OVERLEAF_${String(tool).replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_PATH`;
}

function getNativeRuntimePlatform(options = {}) {
  return validateNativeRuntimePlatform(options.platform)
    || validateNativeRuntimePlatform(options.env?.CODEX_OVERLEAF_PLATFORM)
    || validateNativeRuntimePlatform(process.platform)
    || 'linux';
}

function validateNativeRuntimePlatform(platform) {
  return SUPPORTED_PLATFORMS.has(platform) ? platform : '';
}

function getPathDelimiter(options = {}) {
  if (options.delimiter) {
    return options.delimiter;
  }
  return getNativeRuntimePlatform(options) === 'win32' ? ';' : ':';
}

function getPathValues(env, options = {}) {
  if (!env) {
    return [];
  }
  if (getNativeRuntimePlatform(options) !== 'win32') {
    return [env.PATH];
  }

  const values = [];
  if (Object.hasOwn(env, 'Path')) {
    values.push(env.Path);
  }
  if (Object.hasOwn(env, 'PATH')) {
    values.push(env.PATH);
  }
  if (!values.length) {
    for (const [key, value] of Object.entries(env)) {
      if (key.toLowerCase() === 'path') {
        values.push(value);
      }
    }
  }
  return values;
}

function splitPathValue(value, delimiter) {
  return String(value || '').split(delimiter);
}

function getExecutableCandidates(name, options = {}) {
  const candidates = [name];
  if (getNativeRuntimePlatform(options) !== 'win32' || path.extname(name)) {
    return candidates;
  }

  for (const extension of getWindowsPathExtensions(options.env || process.env)) {
    candidates.push(`${name}${extension}`);
  }
  return [...new Set(candidates)];
}

function getWindowsPathExtensions(env) {
  const raw = env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  const extensions = [];
  for (const extension of String(raw).split(';')) {
    const clean = extension.trim();
    if (!clean) {
      continue;
    }
    extensions.push(clean.toLowerCase(), clean.toUpperCase(), clean);
  }
  return [...new Set(extensions)];
}

function normalizePathKeys(env, pathValue, options = {}) {
  if (getNativeRuntimePlatform(options) !== 'win32') {
    return;
  }

  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') {
      delete env[key];
    }
  }
  env.PATH = pathValue;
}

module.exports = {
  buildNativeRuntimeEnv,
  getDefaultPathSegments,
  getNativeRuntimePlatform,
  mergePathSegments,
  parseMarkedShellEnv,
  readLoginShellEnv,
  resolveExecutable,
  summarizeNativeEnvironment
};
