const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildNativeRuntimeEnv,
  getDefaultPathSegments,
  readLoginShellEnv,
  resolveExecutable,
  summarizeNativeEnvironment
} = require('../native-host/src/nativeEnvironment');

test('native runtime env discovers Codex and TeX tools from the user login shell path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-env-'));
  const shellBin = path.join(root, 'shell-bin');
  fs.mkdirSync(shellBin, { recursive: true });
  fs.writeFileSync(path.join(shellBin, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(shellBin, 'latexmk'), '#!/bin/sh\n', { mode: 0o755 });

  try {
    const env = buildNativeRuntimeEnv({
      HOME: root,
      PATH: '/usr/bin:/bin',
      SHELL: '/bin/zsh'
    }, {
      readLoginShellEnv: () => ({
        PATH: shellBin
      }),
      defaultPathSegments: []
    });

    assert.equal(env.CODEX_OVERLEAF_CODEX_PATH, path.join(shellBin, 'codex'));
    assert.equal(env.CODEX_OVERLEAF_LATEXMK_PATH, path.join(shellBin, 'latexmk'));
    assert.equal(env.PATH.split(path.delimiter)[0], shellBin);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native runtime env falls back to standard macOS developer paths without user input', () => {
  const env = buildNativeRuntimeEnv({
    HOME: '/Users/example',
    PATH: '/usr/bin:/bin'
  }, {
    platform: 'darwin',
    readLoginShellEnv: () => null
  });

  const segments = env.PATH.split(':');
  assert.equal(segments.includes('/Users/example/Applications/ChatGPT.app/Contents/Resources'), true);
  assert.equal(segments.includes('/Users/example/Applications/Codex.app/Contents/Resources'), true);
  assert.equal(segments.includes('/Applications/ChatGPT.app/Contents/Resources'), true);
  assert.equal(segments.includes('/Applications/Codex.app/Contents/Resources'), true);
  assert.equal(segments.includes('/Library/TeX/texbin'), true);
  assert.equal(segments.includes('/opt/homebrew/bin'), true);
  assert.equal(segments.includes('/Users/example/.local/bin'), true);
});

test('native runtime env resolves Codex from an app resource candidate on every runner platform', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-chatgpt-app-'));
  const resources = path.join(root, 'Applications', 'ChatGPT.app', 'Contents', 'Resources');
  const bundledCodex = path.join(resources, 'codex');
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(bundledCodex, '#!/bin/sh\n', { mode: 0o755 });

  try {
    const env = buildNativeRuntimeEnv({
      HOME: root,
      PATH: ''
    }, {
      platform: process.platform,
      delimiter: path.delimiter,
      readLoginShellEnv: () => null,
      defaultPathSegments: [resources]
    });

    assert.equal(env.CODEX_OVERLEAF_CODEX_PATH, bundledCodex);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native runtime env merges Windows Path and PATH while resolving PATHEXT executables', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-win-env-'));
  const pathBin = path.join(root, 'win-path-bin');
  const upperPathBin = path.join(root, 'win-upper-path-bin');
  fs.mkdirSync(pathBin, { recursive: true });
  fs.mkdirSync(upperPathBin, { recursive: true });
  fs.writeFileSync(path.join(pathBin, 'codex.cmd'), '@echo off\r\n', { mode: 0o755 });
  fs.writeFileSync(path.join(upperPathBin, 'latexmk.exe'), 'MZ', { mode: 0o755 });

  try {
    const env = buildNativeRuntimeEnv({
      HOME: root,
      Path: pathBin,
      PATH: upperPathBin,
      PATHEXT: '.CMD;.EXE'
    }, {
      platform: 'win32',
      delimiter: ';',
      readLoginShellEnv: () => null,
      defaultPathSegments: []
    });

    assert.deepEqual(env.PATH.split(';'), [pathBin, upperPathBin]);
    assert.equal(Object.hasOwn(env, 'Path'), false);
    assert.equal(env.CODEX_OVERLEAF_CODEX_PATH, path.join(pathBin, 'codex.cmd'));
    assert.equal(env.CODEX_OVERLEAF_LATEXMK_PATH, path.join(upperPathBin, 'latexmk.exe'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveExecutable finds Windows PATHEXT commands from an injected Windows PATH', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-win-pathext-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\r\n', { mode: 0o755 });

  try {
    assert.equal(
      resolveExecutable('codex', bin, { platform: 'win32', delimiter: ';', env: { PATHEXT: '.COM;.EXE;.CMD' } }),
      path.join(bin, 'codex.cmd')
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native runtime env normalizes Windows Path to a single PATH key when only Path was provided', () => {
  const env = buildNativeRuntimeEnv({
    HOME: 'C:\\Users\\alice',
    Path: 'C:\\Users\\alice\\bin'
  }, {
    platform: 'win32',
    delimiter: ';',
    readLoginShellEnv: () => null,
    defaultPathSegments: []
  });

  assert.equal(Object.hasOwn(env, 'Path'), false);
  assert.equal(env.PATH, 'C:\\Users\\alice\\bin');
});

test('native runtime env stamps validated platform metadata', () => {
  const env = buildNativeRuntimeEnv({
    HOME: '/home/alice',
    PATH: '/usr/bin'
  }, {
    platform: 'linux',
    readLoginShellEnv: () => null,
    defaultPathSegments: []
  });

  assert.equal(env.CODEX_OVERLEAF_PLATFORM, 'linux');
});

test('readLoginShellEnv skips POSIX shell probing on Windows', () => {
  assert.equal(readLoginShellEnv({
    HOME: os.homedir(),
    PATH: process.env.PATH,
    SHELL: '/bin/zsh'
  }, { platform: 'win32' }), null);
});

test('Linux default PATH uses Linux user and TeX Live paths without macOS-only paths', () => {
  const segments = getDefaultPathSegments({ HOME: '/home/alice' }, { platform: 'linux' });

  assert.equal(segments.includes('/home/alice/.local/bin'), true);
  assert.equal(segments.includes('/home/alice/.npm-global/bin'), true);
  assert.equal(segments.includes('/home/alice/bin'), true);
  assert.equal(segments.some(segment => segment.startsWith('/usr/local/texlive/')), true);
  assert.equal(segments.includes('/opt/homebrew/bin'), false);
  assert.equal(segments.includes('/Library/TeX/texbin'), false);
});

test('native environment summary reports discovered tools without exposing raw shell internals', () => {
  const env = {
    PATH: '/usr/bin:/bin',
    CODEX_OVERLEAF_CODEX_PATH: '/opt/homebrew/bin/codex',
    CODEX_OVERLEAF_LATEXMK_PATH: '/Library/TeX/texbin/latexmk',
    CODEX_OVERLEAF_PDFLATEX_PATH: ''
  };

  const summary = summarizeNativeEnvironment(env);

  assert.equal(summary.codex.ok, true);
  assert.equal(summary.codex.path, '/opt/homebrew/bin/codex');
  assert.equal(summary.codex.multipleInstallations, false);
  assert.equal(summary.codex.candidates.length, 1);
  assert.deepEqual(summary.latex.available, ['latexmk']);
  assert.deepEqual(summary.latex.missing, ['pdflatex', 'xelatex', 'lualatex', 'bibtex', 'biber']);
  assert.equal(Object.hasOwn(summary, 'rawShellOutput'), false);
});

test('native environment summary splits Windows path preview with platform metadata', () => {
  const summary = summarizeNativeEnvironment({
    CODEX_OVERLEAF_PLATFORM: 'win32',
    PATH: 'C:\\Users\\alice\\bin;D:\\TeXLive\\bin;C:\\Windows\\System32'
  });

  assert.deepEqual(summary.pathPreview, [
    'C:\\Users\\alice\\bin',
    'D:\\TeXLive\\bin',
    'C:\\Windows\\System32'
  ]);
});
