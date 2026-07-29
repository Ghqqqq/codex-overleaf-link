const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const NativeCompatibilityController = require(
  '../extension/src/content/nativeCompatibilityController'
);

test('tracked Codex runs use the compatibility controller public API', () => {
  const controller = NativeCompatibilityController.create({
    compatibility: {},
    nativeChannel: {},
    gatedMethods: new Set(['codex.run'])
  });
  const compatibility = { classification: 'compatible' };
  const payload = controller.attachEvidence({
    method: 'codex.run',
    params: { task: 'read the project' }
  }, compatibility);

  assert.deepEqual(payload.params.nativeCompatibility, compatibility);

  const runtimeSource = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  const sendTrackedRunBody = runtimeSource.match(
    /async function sendTrackedCodexRun\(params\) \{[\s\S]*?\n  \}/
  )?.[0] || '';

  assert.match(sendTrackedRunBody, /nativeCompatibilityController\.ensureForMethod\('codex\.run'\)/);
  assert.match(sendTrackedRunBody, /nativeCompatibilityController\.attachEvidence\(/);
  assert.doesNotMatch(sendTrackedRunBody, /\bensureNativeCompatibilityForMethod\b/);
  assert.doesNotMatch(sendTrackedRunBody, /\battachNativeCompatibilityEvidence\b/);
});
