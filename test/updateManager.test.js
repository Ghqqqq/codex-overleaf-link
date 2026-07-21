const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  GITHUB_LATEST_URL,
  applyStagedUpdate,
  checkForUpdate,
  cleanupOrphanStageRoots,
  confirmUpdate,
  getApplyGate,
  handleUpdateRequest,
  isUpdateMethod,
  revokeUpdate,
  rollbackUpdate
} = require('../native-host/src/updateManager');

const FIXTURE_AUTHORIZATION_ID = '11111111-1111-4111-8111-111111111111';

function createAppliedUpdateFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-update-transaction-'));
  const extensionRoot = path.join(root, 'extension');
  const nativeRoot = path.join(root, 'native');
  const updatesRoot = path.join(nativeRoot, 'updates');
  const stageRoot = path.join(updatesRoot, 'staging-fixture');
  const payloadRoot = path.join(stageRoot, 'payload');
  fs.mkdirSync(path.join(extensionRoot, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(extensionRoot, 'runtime', 'old.js'), 'old\n');
  fs.writeFileSync(path.join(extensionRoot, 'runtime', 'runtime-manifest.json'), '{"schemaVersion":1}\n');
  fs.mkdirSync(path.join(extensionRoot, 'bootstrap'), { recursive: true });
  fs.writeFileSync(path.join(extensionRoot, 'bootstrap', 'background.js'), '// bootstrap\n');
  fs.writeFileSync(path.join(extensionRoot, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    version: '1.9.0',
    background: { service_worker: 'bootstrap/background.js' }
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(extensionRoot, '.codex-overleaf-managed-extension.json'), JSON.stringify({
    managedBy: 'codex-overleaf-link',
    kind: 'extension',
    bootstrapProtocol: 1,
    version: '1.9.0'
  }, null, 2) + '\n');
  fs.mkdirSync(path.join(nativeRoot, 'versions', '1.8.9'), { recursive: true });
  fs.mkdirSync(path.join(nativeRoot, 'versions', '1.9.0'), { recursive: true });
  fs.writeFileSync(path.join(nativeRoot, 'active-version'), '1.9.0\n');
  fs.writeFileSync(path.join(nativeRoot, 'previous-version'), '1.8.9\n');
  fs.writeFileSync(path.join(nativeRoot, '.codex-overleaf-managed-native.json'), JSON.stringify({
    managedBy: 'codex-overleaf-link',
    kind: 'native',
    bootstrapProtocol: 1,
    version: '1.9.0'
  }, null, 2) + '\n');
  fs.mkdirSync(path.join(payloadRoot, 'extension-runtime'), { recursive: true });
  fs.writeFileSync(path.join(payloadRoot, 'extension-runtime', 'new.js'), 'new\n');
  fs.mkdirSync(path.join(payloadRoot, 'native-runtime'), { recursive: true });
  fs.writeFileSync(path.join(payloadRoot, 'native-runtime', 'package.json'), '{"version":"1.9.1"}\n');
  fs.mkdirSync(updatesRoot, { recursive: true });
  fs.writeFileSync(path.join(updatesRoot, 'transaction.json'), JSON.stringify({
    id: 'fixture',
    authorizationId: FIXTURE_AUTHORIZATION_ID,
    state: 'staged',
    sourceVersion: '1.9.0',
    sourcePreviousVersion: '1.8.9',
    targetVersion: '1.9.1',
    stageRoot,
    payloadRoot,
    createdAt: '2026-07-10T00:00:00.000Z'
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(updatesRoot, 'authorization.json'), JSON.stringify({
    schemaVersion: 1,
    id: FIXTURE_AUTHORIZATION_ID,
    targetVersion: '1.9.1',
    sourceVersion: '1.9.0',
    state: 'bound',
    grantedAt: '2026-07-10T00:00:00.000Z',
    expiresAt: '2026-07-10T02:00:00.000Z',
    transactionId: 'fixture'
  }, null, 2) + '\n');
  return {
    root,
    context: { managed: true, extensionRoot, nativeRoot, updatesRoot }
  };
}

test('stable discovery follows the public latest redirect without consuming GitHub API quota', async () => {
  const calls = [];
  const nativeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-update-manager-'));
  fs.writeFileSync(path.join(nativeRoot, 'active-version'), '1.9.0\n');
  try {
    const result = await checkForUpdate(
      { updatesRoot: '/unused', nativeRoot, extensionRoot: '/unused' },
      { currentVersion: '1.9.0' },
      {
        fetch: async (url, options) => {
          calls.push({ url, options });
          return {
            ok: true,
            status: 200,
            url: 'https://github.com/Ghqqqq/codex-overleaf-link/releases/tag/v1.8.6',
            headers: { get: () => '' }
          };
        }
      }
    );

    assert.equal(GITHUB_LATEST_URL, 'https://github.com/Ghqqqq/codex-overleaf-link/releases/latest');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, 'HEAD');
    assert.equal(result.available, false);
    assert.equal(result.reason, 'downgrade_rejected');
    assert.equal(result.latestVersion, '1.8.6');
  } finally {
    fs.rmSync(nativeRoot, { recursive: true, force: true });
  }
});

test('recognizes only the managed update RPC surface', () => {
  assert.equal(isUpdateMethod('update.check'), true);
  assert.equal(isUpdateMethod('update.authorize'), true);
  assert.equal(isUpdateMethod('update.revoke'), true);
  assert.equal(isUpdateMethod('update.rollback'), true);
  assert.equal(isUpdateMethod('codex.run'), false);
});

test('native apply rejects a staged transaction when target-bound authorization is absent', () => {
  const fixture = createAppliedUpdateFixture();
  try {
    fs.rmSync(path.join(fixture.context.updatesRoot, 'authorization.json'));
    assert.throws(
      () => applyStagedUpdate(fixture.context, { transactionId: 'fixture' }, {
        getWorkState: () => ({ projectLocks: 0, runControllers: 0 })
      }),
      error => error?.code === 'update_consent_required'
    );
    assert.equal(fs.existsSync(path.join(fixture.context.extensionRoot, 'runtime', 'old.js')), true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('native apply rejects a mixed source and managed extension tree before moving runtime files', () => {
  const fixture = createAppliedUpdateFixture();
  try {
    const manifestPath = path.join(fixture.context.extensionRoot, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.background.service_worker = 'src/background.js';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    assert.throws(
      () => applyStagedUpdate(fixture.context, { transactionId: 'fixture' }, {
        getWorkState: () => ({ projectLocks: 0, runControllers: 0 })
      }),
      error => error?.code === 'update_managed_layout_invalid'
    );
    assert.equal(fs.existsSync(path.join(fixture.context.extensionRoot, 'runtime', 'old.js')), true);
    assert.equal(fs.existsSync(path.join(fixture.context.extensionRoot, 'slots', 'previous')), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('v1.9.4 health confirmation accepts only the authorization-free inbound migration journal', () => {
  const fixture = createAppliedUpdateFixture();
  try {
    const journalPath = path.join(fixture.context.updatesRoot, 'transaction.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    delete journal.authorizationId;
    journal.state = 'awaiting_health';
    journal.sourceVersion = '1.9.3';
    journal.targetVersion = '1.9.4';
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n');
    fs.rmSync(path.join(fixture.context.updatesRoot, 'authorization.json'));
    fs.writeFileSync(path.join(fixture.context.nativeRoot, 'active-version'), '1.9.4\n');
    const manifestPath = path.join(fixture.context.extensionRoot, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.version = '1.9.4';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

    assert.deepEqual(confirmUpdate(fixture.context, {
      transactionId: 'fixture',
      extensionVersion: '1.9.4',
      nativeVersion: '1.9.4'
    }), { version: '1.9.4', state: 'committed' });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('revoking before apply removes authorization, journal and staging without changing active pointers', () => {
  const fixture = createAppliedUpdateFixture();
  try {
    fs.writeFileSync(path.join(fixture.context.updatesRoot, 'candidate.json'), '{"latestVersion":"1.9.1"}\n');
    const result = revokeUpdate(fixture.context, {
      authorizationId: FIXTURE_AUTHORIZATION_ID,
      targetVersion: '1.9.1',
      transactionId: 'fixture'
    });
    assert.deepEqual(result, { state: 'revoked', targetVersion: '1.9.1' });
    assert.equal(fs.existsSync(path.join(fixture.context.updatesRoot, 'authorization.json')), false);
    assert.equal(fs.existsSync(path.join(fixture.context.updatesRoot, 'transaction.json')), false);
    assert.equal(fs.existsSync(path.join(fixture.context.updatesRoot, 'candidate.json')), true);
    assert.equal(fs.readFileSync(path.join(fixture.context.nativeRoot, 'active-version'), 'utf8').trim(), '1.9.0');
    assert.deepEqual(revokeUpdate(fixture.context, {
      authorizationId: FIXTURE_AUTHORIZATION_ID,
      targetVersion: '1.9.1',
      transactionId: ''
    }), { state: 'already_revoked', targetVersion: '1.9.1' });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('native apply gate fails closed on project locks and run controllers', () => {
  assert.deepEqual(getApplyGate({ getWorkState: () => ({ projectLocks: 1, runControllers: 1 }) }), {
    idle: false,
    blockers: ['native_project_locked', 'native_run_active'],
    workState: { projectLocks: 1, runControllers: 1 }
  });
});

test('unmanaged native runtime returns migration guidance', async () => {
  const result = await handleUpdateRequest({ id: '1', method: 'update.status', params: {} }, { env: {} });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'update_not_managed');
});

test('a committed update restores its source manifest without retaining the failed target as fallback', () => {
  const fixture = createAppliedUpdateFixture();
  try {
    const applied = applyStagedUpdate(fixture.context, { transactionId: 'fixture' }, {
      getWorkState: () => ({ projectLocks: 0, runControllers: 0 })
    });
    assert.equal(applied.state, 'awaiting_health');
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.context.extensionRoot, '.codex-overleaf-managed-extension.json'), 'utf8')).version, '1.9.1');
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.context.nativeRoot, '.codex-overleaf-managed-native.json'), 'utf8')).version, '1.9.1');
    confirmUpdate(fixture.context, {
      transactionId: 'fixture',
      extensionVersion: '1.9.1',
      nativeVersion: '1.9.1'
    });
    rollbackUpdate(fixture.context, { reasonCode: 'fixture_health_regression' });

    const manifest = JSON.parse(fs.readFileSync(path.join(fixture.context.extensionRoot, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, '1.9.0');
    assert.equal(fs.existsSync(path.join(fixture.context.extensionRoot, 'runtime', 'old.js')), true);
    assert.equal(fs.readFileSync(path.join(fixture.context.nativeRoot, 'active-version'), 'utf8').trim(), '1.9.0');
    assert.equal(fs.existsSync(path.join(fixture.context.nativeRoot, 'previous-version')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.context.extensionRoot, '.codex-overleaf-managed-extension.json'), 'utf8')).version, '1.9.0');
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.context.nativeRoot, '.codex-overleaf-managed-native.json'), 'utf8')).version, '1.9.0');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('orphan staging cleanup retains only the active transaction directory', () => {
  const updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-update-staging-'));
  const retained = path.join(updatesRoot, 'staging-11111111-1111-4111-8111-111111111111');
  const orphan = path.join(updatesRoot, 'staging-22222222-2222-4222-8222-222222222222');
  const unrelated = path.join(updatesRoot, 'candidate-cache');
  fs.mkdirSync(retained);
  fs.mkdirSync(orphan);
  fs.mkdirSync(unrelated);
  try {
    cleanupOrphanStageRoots(updatesRoot, [retained]);
    assert.equal(fs.existsSync(retained), true);
    assert.equal(fs.existsSync(orphan), false);
    assert.equal(fs.existsSync(unrelated), true);
  } finally {
    fs.rmSync(updatesRoot, { recursive: true, force: true });
  }
});
