const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  RUNTIME_ENV_KEY,
  buildCodexRuntimeEvent,
  buildCodexRuntimeIdentity,
  getCodexRuntimeIdentityFromEnv,
  serializeCodexRuntimeIdentity
} = require('../native-host/src/codexRuntimeIdentity');
const { formatDoctorHuman } = require('../native-host/src/nativeDoctor');

function writeFakeCodex(binDir, version) {
  fs.mkdirSync(binDir, { recursive: true });
  const fileName = process.platform === 'win32' ? 'codex.cmd' : 'codex';
  const target = path.join(binDir, fileName);
  const content = process.platform === 'win32'
    ? `@echo off\r\necho codex-cli ${version}\r\n`
    : `#!/bin/sh\nprintf 'codex-cli ${version}\\n'\n`;
  fs.writeFileSync(target, content, { mode: 0o755 });
  return target;
}

test('runtime identity pins PATH order and records duplicate Codex versions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-runtime-identity-'));
  try {
    const nvmBin = path.join(root, '.nvm', 'versions', 'node', 'v22.21.1', 'bin');
    const homebrewBin = path.join(root, 'opt', 'homebrew', 'bin');
    const selectedPath = writeFakeCodex(nvmBin, '0.144.6');
    writeFakeCodex(homebrewBin, '0.139.0');
    const identity = buildCodexRuntimeIdentity({
      selectedPath,
      pathValue: [nvmBin, homebrewBin].join(path.delimiter),
      delimiter: path.delimiter,
      env: { HOME: root, PATH: [nvmBin, homebrewBin].join(path.delimiter) },
      platform: process.platform
    });

    assert.equal(identity.selected.path, selectedPath);
    assert.equal(identity.selected.version, '0.144.6');
    assert.equal(identity.selected.source, 'npm-nvm');
    assert.equal(identity.multipleInstallations, true);
    assert.deepEqual(identity.candidates.map(candidate => candidate.version), ['0.144.6', '0.139.0']);
    assert.match(identity.selected.displayPath, /^~/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime identity can select the newest discovered Codex version', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-runtime-newest-'));
  try {
    const olderBin = path.join(root, 'older', 'bin');
    const newerBin = path.join(root, 'newer', 'bin');
    const olderPath = writeFakeCodex(olderBin, '0.146.0');
    const newerPath = writeFakeCodex(newerBin, '0.148.0-alpha.9');
    const identity = buildCodexRuntimeIdentity({
      selectedPath: olderPath,
      selectionPolicy: 'newest-version',
      pathValue: [olderBin, newerBin].join(path.delimiter),
      delimiter: path.delimiter,
      env: { HOME: root, PATH: [olderBin, newerBin].join(path.delimiter) },
      platform: process.platform
    });

    assert.equal(identity.selected.path, newerPath);
    assert.equal(identity.selected.version, '0.148.0-alpha.9');
    assert.equal(identity.selectedBy, 'newest-version');
    assert.deepEqual(identity.candidates.map(candidate => candidate.selected), [false, true]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime identity survives the native environment boundary and builds a technical event', () => {
  const identity = {
    schemaVersion: 1,
    selected: {
      path: '/Users/alice/.nvm/versions/node/v22/bin/codex',
      displayPath: '~/.nvm/versions/node/v22/bin/codex',
      version: '0.144.6',
      source: 'npm-nvm',
      selected: true
    },
    candidates: [
      { path: '/Users/alice/.nvm/versions/node/v22/bin/codex', displayPath: '~/.nvm/versions/node/v22/bin/codex', version: '0.144.6', source: 'npm-nvm', selected: true },
      { path: '/opt/homebrew/bin/codex', displayPath: '/opt/homebrew/bin/codex', version: '0.139.0', source: 'homebrew-prefix', selected: false }
    ],
    multipleInstallations: true,
    selectedBy: 'path-order'
  };
  const env = { [RUNTIME_ENV_KEY]: serializeCodexRuntimeIdentity(identity) };

  assert.equal(getCodexRuntimeIdentityFromEnv(env).selected.version, '0.144.6');
  const event = buildCodexRuntimeEvent(env);
  assert.equal(event.type, 'codex.runtime.selected');
  assert.equal(event.detail.warningCode, 'multiple_codex_installations');
  assert.equal(event.detail.path, '~/.nvm/versions/node/v22/bin/codex');
  assert.equal(event.detail.candidates.length, 2);
});

test('doctor output explains the selected Codex and duplicate candidates', () => {
  const output = formatDoctorHuman({
    ok: true,
    status: 'ok',
    browser: 'chrome',
    manifest: { path: '~/manifest.json', allowedOrigins: [], errors: [] },
    registration: { kind: 'file' },
    bridge: { path: '~/.codex-overleaf/bridge', errors: [] },
    compatibility: { classification: 'compatible', nativeVersion: '2.1.3' },
    codex: {
      ok: true,
      path: '~/.nvm/versions/node/v22/bin/codex',
      version: '0.144.6',
      source: 'npm-nvm',
      multipleInstallations: true,
      candidates: [
        { path: '~/.nvm/versions/node/v22/bin/codex', version: '0.144.6', source: 'npm-nvm', selected: true },
        { path: '/opt/homebrew/bin/codex', version: '0.139.0', source: 'homebrew-prefix', selected: false }
      ]
    },
    ping: { ok: true }
  });

  assert.match(output, /Codex path: ~\/\.nvm\/versions\/node\/v22\/bin\/codex/);
  assert.match(output, /Codex version: 0\.144\.6/);
  assert.match(output, /multiple Codex installations detected/);
  assert.match(output, /\/opt\/homebrew\/bin\/codex \(0\.139\.0, homebrew-prefix\)/);
});
