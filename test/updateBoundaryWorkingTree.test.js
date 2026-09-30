'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function boundary() {
  const previous = process.env.CODEX_OVERLEAF_TEST_IMPORT;
  process.env.CODEX_OVERLEAF_TEST_IMPORT = '1';
  try { return await import(pathToFileURL(path.resolve(__dirname, '../scripts/verify-update-boundary.mjs')).href); }
  finally {
    if (previous === undefined) delete process.env.CODEX_OVERLEAF_TEST_IMPORT;
    else process.env.CODEX_OVERLEAF_TEST_IMPORT = previous;
  }
}

test('protected boundary includes committed, staged, unstaged and untracked candidate paths', async () => {
  const { collectProtectedChanges } = await boundary();
  const calls = [];
  const result = collectProtectedChanges('v2.4.1', ['extension/bootstrap'], args => {
    calls.push(args);
    return args[0] === 'diff' ? 'extension/bootstrap/background.js\nextension/bootstrap/popup.html\n'
      : 'extension/bootstrap/new.js\nextension/bootstrap/popup.html\n';
  });
  assert.deepEqual(calls[0], ['diff', '--name-only', 'v2.4.1', '--', 'extension/bootstrap']);
  assert.deepEqual(calls[1], ['ls-files', '--others', '--exclude-standard', '--', 'extension/bootstrap']);
  assert.deepEqual(result, ['extension/bootstrap/background.js', 'extension/bootstrap/new.js', 'extension/bootstrap/popup.html']);
});

test('a manifest shape change requires both a protocol step and a new release baseline', async () => {
  const { assertBootstrapManifestVersionTransition } = await boundary();
  const previousManifest = { manifest_version: 3, version: '2.4.1', host_permissions: ['https://www.overleaf.com/*'] };
  const currentManifest = { ...previousManifest, version: '2.5.0', host_permissions: [...previousManifest.host_permissions, 'https://cn.overleaf.com/*'] };
  const input = { previousManifest, currentManifest, previousPackageVersion: '2.4.1', currentPackageVersion: '2.5.0',
    previousBootstrapProtocol: 2, currentBootstrapProtocol: 3 };
  assert.doesNotThrow(() => assertBootstrapManifestVersionTransition(input));
  assert.throws(() => assertBootstrapManifestVersionTransition({ ...input, currentBootstrapProtocol: 2 }), /changed beyond/);
  assert.throws(() => assertBootstrapManifestVersionTransition({ ...input,
    currentManifest: { ...currentManifest, version: '2.4.5' }, currentPackageVersion: '2.4.5'
  }), /new major\/minor baseline/);
});

test('bootstrap protocols cannot be skipped, downgraded or migrated in a patch release', async () => {
  const { assertBootstrapProtocolTransition } = await boundary();
  const input = { previousPackageVersion: '2.4.1', currentPackageVersion: '2.5.0',
    previousBootstrapProtocol: 2, currentBootstrapProtocol: 3 };
  assert.equal(assertBootstrapProtocolTransition(input), true);
  assert.equal(assertBootstrapProtocolTransition({ ...input, currentBootstrapProtocol: 2 }), false);
  for (const currentBootstrapProtocol of [1, 4, undefined]) {
    assert.throws(() => assertBootstrapProtocolTransition({ ...input, currentBootstrapProtocol }), /remain stable or increase/);
  }
  for (const currentPackageVersion of ['2.4.5', '2.5.1', '1.9.0']) {
    assert.throws(() => assertBootstrapProtocolTransition({ ...input, currentPackageVersion }), /new major\/minor baseline/);
  }
});

test('historical Bootstrap template version is stamped without hiding permission or candidate-version changes', async () => {
  const { materializePreviousBootstrapManifest, assertBootstrapManifestVersionTransition } = await boundary();
  const template = { manifest_version: 3, version: '2.4.0', permissions: ['storage'],
    host_permissions: ['https://www.overleaf.com/project/*'] };
  const previousManifest = materializePreviousBootstrapManifest(template, '2.4.1');
  assert.deepEqual(previousManifest, { ...template, version: '2.4.1' });
  assert.equal(template.version, '2.4.0');
  const input = { previousManifest, currentManifest: { ...previousManifest, version: '2.5.0',
    host_permissions: [...template.host_permissions, 'https://cn.overleaf.com/project/*'] },
    previousPackageVersion: '2.4.1', currentPackageVersion: '2.5.0',
    previousBootstrapProtocol: 2, currentBootstrapProtocol: 3 };
  assert.doesNotThrow(() => assertBootstrapManifestVersionTransition(input));
  assert.throws(() => assertBootstrapManifestVersionTransition({ ...input, currentBootstrapProtocol: 2 }), /changed beyond/);
  assert.throws(() => assertBootstrapManifestVersionTransition({ ...input,
    currentManifest: { ...input.currentManifest, version: '2.4.1' }
  }), /must match their package release versions/);
  assert.throws(() => materializePreviousBootstrapManifest(template, '2.4.1-rc.1'), /Invalid stable package version/);
});
