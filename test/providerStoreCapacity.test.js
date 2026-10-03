'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { handleRequest } = require('../native-host/src/taskRunner');
const { getProviderStorePaths, loadProviderState, recordProviderDiagnostic } = require('../native-host/src/providerStore');
const { computeConnectionFingerprint } = require('../native-host/src/providerProfile');
const { resolveRunProvider, resolveProviderModels } = require('../native-host/src/providerRuntime');
const { decodeInputFrames, getRequestQuotaViolation, encodeOutputFrame } = require('../native-host/src/nativeTransportEnvelope');
const { MAX_NATIVE_INPUT_MESSAGE_BYTES } = require('../native-host/src/nativeMessaging');

const STORE_LIMIT = 1024 * 1024;
const JOURNAL_LIMIT = 2 * STORE_LIMIT + 1024;
const SYNTHETIC_KEY = 'CAPACITY_SYNTHETIC_KEY_NEVER_REAL';

function draft(padding = '') {
  return {
    name: 'Capacity Test Provider',
    baseUrl: 'https://capacity.example.invalid/v1',
    wireApiPreference: 'responses',
    models: [{ id: 'synthetic-model', label: 'Synthetic Model', reasoningEfforts: [] }],
    defaultModelId: 'synthetic-model',
    reasoningAdapter: 'none',
    reasoningCapability: 'none',
    customHeaders: { 'x-padding': padding }
  };
}

async function withStore(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-capacity-'));
  const env = {
    HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, 'codex-home'),
    CODEX_OVERLEAF_PROVIDER_STORE_DIR: path.join(root, 'store')
  };
  try {
    return await callback(env, getProviderStorePaths(env));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function request(env, method, params = {}) {
  const payload = Buffer.from(JSON.stringify({ id: 'capacity-test', method, params }));
  assert.ok(payload.length < MAX_NATIVE_INPUT_MESSAGE_BYTES);
  const frame = Buffer.alloc(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  const decoded = decodeInputFrames(frame);
  assert.equal(decoded.messages.length, 1);
  assert.equal(decoded.remainder.length, 0);
  assert.equal(getRequestQuotaViolation(decoded.messages[0]), null);
  const response = await handleRequest(decoded.messages[0], env);
  return decodeInputFrames(encodeOutputFrame(response)).messages[0];
}

async function save(env, padding = '') {
  const response = await request(env, 'codex.providers.upsert', {
    draft: draft(padding), secretMutation: { kind: 'replace', value: SYNTHETIC_KEY }
  });
  assert.equal(response.ok, true, JSON.stringify(response.error));
  return response.result.providers.find(item => item.id === response.result.savedProviderId);
}

function snapshot(paths) {
  return {
    public: fs.readFileSync(paths.publicFile),
    secrets: fs.readFileSync(paths.secretFile)
  };
}

function assertUnchanged(paths, before) {
  assert.deepEqual(snapshot(paths), before);
  assert.equal(fs.existsSync(paths.transactionFile), false);
  assert.equal(fs.existsSync(paths.lockFile), false);
  assert.equal(fs.readdirSync(paths.root).some(name => name.includes('.tmp-')), false);
}

async function assertUsable(env, profile) {
  const listed = await request(env, 'codex.providers.list');
  assert.equal(listed.ok, true);
  const current = listed.result.providers.find(item => item.id === profile.id);
  assert.equal(current.revision, profile.revision);
  assert.equal(resolveRunProvider({
    model: 'synthetic-model', providerSelection: { providerId: 'builtin', providerRevision: 0 }
  }, env).providerLaunch, null);
  let called = false;
  resolveProviderModels({ providerSelection: { providerId: 'builtin', providerRevision: 0 } }, env, () => {
    called = true;
    return { models: [{ id: 'synthetic-model' }] };
  });
  assert.equal(called, true);
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function utf8Padding(bytes) {
  return '界'.repeat(Math.floor(bytes / 3)) + 'x'.repeat(bytes % 3);
}

function journal(state) {
  return {
    schemaVersion: 1,
    nextRevision: state.public.storeRevision + 1,
    previousPublic: state.public,
    previousSecrets: state.secrets
  };
}

function addExistingProviders(state, count) {
  for (let i = 0; i < count; i += 1) {
    const id = `existing-${i}`;
    state.public.profiles.push({ ...state.public.profiles[0], id, customHeaders: {} });
    state.secrets.secrets[id] = '界'.repeat(8192);
  }
}

function writeState(paths, state) {
  fs.writeFileSync(paths.publicFile, json(state.public));
  fs.writeFileSync(paths.secretFile, json(state.secrets));
}

for (const [label, padding] of [
  ['ASCII', 'X'.repeat(STORE_LIMIT)],
  ['multi-byte UTF-8', '界'.repeat(Math.floor(STORE_LIMIT / 3))],
  ['JSON escaping', '\\'.repeat(STORE_LIMIT / 2)]
]) {
  test(`Native dispatcher rejects an oversized ${label} update without changing saved state`, async t => {
    await withStore(async (env, paths) => {
      const profile = await save(env, 'old');
      const before = snapshot(paths);
      const replacements = [];
      const rename = fs.renameSync;
      t.mock.method(fs, 'renameSync', (from, to) => {
        replacements.push(to);
        return rename(from, to);
      });
      const response = await request(env, 'codex.providers.upsert', {
        profileId: profile.id, expectedRevision: profile.revision,
        draft: draft(padding), secretMutation: { kind: 'replace', value: 'SYNTHETIC_REPLACEMENT' }
      });
      t.mock.restoreAll();
      assert.deepEqual(replacements, [], 'capacity rejection precedes the first Store replacement');
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'provider_store_too_large');
      assertUnchanged(paths, before);
      await assertUsable(env, profile);
      const deleted = await request(env, 'codex.providers.delete', {
        providerId: profile.id, expectedRevision: profile.revision
      });
      assert.equal(deleted.ok, true);
      assert.equal(deleted.result.providers.some(item => item.id === profile.id), false);
    });
  });
}

test('cumulative profiles share the serialized Store budget', async () => {
  await withStore(async (env, paths) => {
    const first = await save(env, 'A'.repeat(600000));
    const before = snapshot(paths);
    const response = await request(env, 'codex.providers.upsert', {
      draft: draft('B'.repeat(600000)), secretMutation: { kind: 'unchanged' }
    });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'provider_store_too_large');
    assertUnchanged(paths, before);
    await assertUsable(env, first);
  });
});

test('serialized secret file growth is rejected before replacing either Store file', async () => {
  await withStore(async (env, paths) => {
    const profile = await save(env);
    const state = loadProviderState(env);
    // Existing valid secret entries can originate from earlier Store revisions.
    // Each key respects normalizeSecret, while their total approaches the file cap.
    addExistingProviders(state, 42);
    state.secrets.secrets[profile.id] = utf8Padding(STORE_LIMIT - 32 - Buffer.byteLength(json(state.secrets)) + SYNTHETIC_KEY.length);
    assert.equal(Buffer.byteLength(json(state.secrets)), STORE_LIMIT - 32);
    writeState(paths, state);
    const before = snapshot(paths);
    const response = await request(env, 'codex.providers.upsert', {
      profileId: profile.id, expectedRevision: profile.revision,
      draft: draft(), secretMutation: { kind: 'replace', value: '界'.repeat(8192) }
    });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'provider_store_too_large');
    assert.match(response.error.message, /provider-secrets\.json/);
    assertUnchanged(paths, before);
    await assertUsable(env, profile);
  });
});

test('exact UTF-8 public-file limit saves and remains deletable; one extra byte leaves it unchanged', async () => {
  await withStore(async (env, paths) => {
    const profile = await save(env);
    const initial = loadProviderState(env);
    const padding = utf8Padding(STORE_LIMIT - Buffer.byteLength(json(initial.public)));
    const update = await request(env, 'codex.providers.upsert', {
      profileId: profile.id, expectedRevision: profile.revision,
      draft: draft(padding), secretMutation: { kind: 'unchanged' }
    });
    assert.equal(update.ok, true, JSON.stringify(update.error));
    assert.equal(fs.statSync(paths.publicFile).size, STORE_LIMIT);
    const updated = update.result.providers.find(item => item.id === profile.id);
    const before = snapshot(paths);
    const rejected = await request(env, 'codex.providers.upsert', {
      profileId: updated.id, expectedRevision: updated.revision,
      draft: draft(`${padding}x`), secretMutation: { kind: 'unchanged' }
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'provider_store_too_large');
    assertUnchanged(paths, before);
    await assertUsable(env, updated);
    const deleted = await request(env, 'codex.providers.delete', {
      providerId: updated.id, expectedRevision: updated.revision
    });
    assert.equal(deleted.ok, true, JSON.stringify(deleted.error));
    assert.equal(deleted.result.providers.some(item => item.id === profile.id), false);
  });
});

async function seedLargeCombinedState(env, paths) {
  const profile = await save(env, 'P'.repeat(600000));
  const state = loadProviderState(env);
  addExistingProviders(state, 24);
  assert.ok(Buffer.byteLength(json(state.public)) < STORE_LIMIT);
  assert.ok(Buffer.byteLength(json(state.secrets)) < STORE_LIMIT);
  assert.ok(Buffer.byteLength(JSON.stringify(journal(state))) > STORE_LIMIT);
  writeState(paths, state);
  return profile;
}

test('historical individually valid stores remain clearable and deletable with a combined journal above 1 MiB', async () => {
  await withStore(async (env, paths) => {
    const profile = await seedLargeCombinedState(env, paths);
    const cleared = await request(env, 'codex.providers.clear-secret', {
      providerId: profile.id, expectedRevision: profile.revision
    });
    assert.equal(cleared.ok, true, JSON.stringify(cleared.error));
    const current = cleared.result.providers.find(item => item.id === profile.id);
    assert.equal(current.hasSecret, false);
    const deleted = await request(env, 'codex.providers.delete', {
      providerId: profile.id, expectedRevision: current.revision
    });
    assert.equal(deleted.ok, true, JSON.stringify(deleted.error));
    assert.equal(deleted.result.providers.some(item => item.id === profile.id), false);
    assert.equal(fs.existsSync(paths.transactionFile), false);
  });
});

test('an interrupted large transaction is readable and restores both previous store revisions', async t => {
  await withStore(async (env, paths) => {
    const profile = await seedLargeCombinedState(env, paths);
    const before = snapshot(paths);
    const rename = fs.renameSync;
    let interrupted = false;
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (to === paths.publicFile) interrupted = true;
      if (interrupted) throw Object.assign(new Error('synthetic unavailable filesystem'), { code: 'EIO' });
      return rename(from, to);
    });
    const deleted = await request(env, 'codex.providers.delete', {
      providerId: profile.id, expectedRevision: profile.revision
    });
    t.mock.restoreAll();
    assert.equal(deleted.ok, false);
    assert.equal(deleted.error.code, 'provider_store_unavailable');
    const transactionBytes = fs.statSync(paths.transactionFile).size;
    assert.ok(transactionBytes > STORE_LIMIT && transactionBytes <= JOURNAL_LIMIT);
    await assertUsable(env, profile);
    assert.deepEqual(snapshot(paths), before);
    assert.equal(fs.existsSync(paths.transactionFile), false);
  });
});

for (const extraByte of [0, 1]) {
  test(`transaction reader ${extraByte ? 'rejects one byte over' : 'accepts exactly'} its bounded budget`, async () => {
    await withStore(async (env, paths) => {
      const profile = await save(env);
      const state = loadProviderState(env);
      const encoded = JSON.stringify(journal(state));
      fs.writeFileSync(paths.transactionFile, encoded + ' '.repeat(JOURNAL_LIMIT + extraByte - Buffer.byteLength(encoded)));
      const before = snapshot(paths);
      const response = await request(env, 'codex.providers.list');
      assert.equal(response.ok, !extraByte);
      assert.deepEqual(snapshot(paths), before);
      if (extraByte) {
        assert.equal(response.error.code, 'provider_store_corrupt');
        assert.equal(fs.existsSync(paths.transactionFile), true);
      } else {
        assert.equal(fs.existsSync(paths.transactionFile), false);
        await assertUsable(env, profile);
      }
    });
  });
}

test('exact secret-file limit can be saved and cleared, while one extra byte preserves the old key', async () => {
  await withStore(async (env, paths) => {
    const profile = await save(env);
    const state = loadProviderState(env);
    addExistingProviders(state, 42);
    const secret = utf8Padding(STORE_LIMIT - Buffer.byteLength(json(state.secrets)) + SYNTHETIC_KEY.length);
    assert.ok(secret.length < 8192);
    writeState(paths, state);
    const saved = await request(env, 'codex.providers.upsert', {
      profileId: profile.id, expectedRevision: profile.revision,
      draft: draft(), secretMutation: { kind: 'replace', value: secret }
    });
    assert.equal(saved.ok, true, JSON.stringify(saved.error));
    assert.equal(fs.statSync(paths.secretFile).size, STORE_LIMIT);
    const current = saved.result.providers.find(item => item.id === profile.id);
    const before = snapshot(paths);
    const rejected = await request(env, 'codex.providers.upsert', {
      profileId: profile.id, expectedRevision: current.revision,
      draft: draft(), secretMutation: { kind: 'replace', value: `${secret}x` }
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'provider_store_too_large');
    assertUnchanged(paths, before);
    await assertUsable(env, current);
    const cleared = await request(env, 'codex.providers.clear-secret', {
      providerId: profile.id, expectedRevision: current.revision
    });
    assert.equal(cleared.ok, true, JSON.stringify(cleared.error));
    assert.equal(cleared.result.providers.find(item => item.id === profile.id).hasSecret, false);
    assert.ok(fs.statSync(paths.secretFile).size < STORE_LIMIT);
  });
});

async function seedNormalizationExpansion(env, paths, { secondProfile = false, compact = false } = {}) {
  const profile = await save(env);
  const state = loadProviderState(env);
  state.public.profiles[0].modelDiagnostics['synthetic-model'] = {
    status: 'tested', at: 1, wireApi: 'responses', upstreamResponseMode: 'streaming',
    durationMs: 0, connectionFingerprint: 'synthetic-fingerprint'
  };
  state.public.profiles[0].x = 1; // Legacy unknown field must survive rollback and unrelated edits.
  if (secondProfile) {
    state.public.profiles.push({ ...state.public.profiles[0], id: 'second-profile', customHeaders: {} });
    state.secrets.secrets['second-profile'] = SYNTHETIC_KEY;
  }
  const encode = compact ? value => `${JSON.stringify(value)}\n` : json;
  state.public.profiles[0].customHeaders['x-padding'] = 'x'.repeat(STORE_LIMIT - Buffer.byteLength(encode(state.public)));
  fs.writeFileSync(paths.publicFile, encode(state.public));
  fs.writeFileSync(paths.secretFile, json(state.secrets));
  assert.equal(fs.statSync(paths.publicFile).size, STORE_LIMIT);
  assert.ok(Buffer.byteLength(json(loadProviderState(env).public)) > STORE_LIMIT);
  return profile;
}

for (const compact of [false, true]) {
  test(`deleting a full ${compact ? 'compact' : 'pretty'} legacy Store does not serialize read-time defaults into rollback`, async () => {
    await withStore(async (env, paths) => {
      const profile = await seedNormalizationExpansion(env, paths, { compact });
      const result = await request(env, 'codex.providers.delete', {
        providerId: profile.id, expectedRevision: profile.revision
      });
      assert.equal(result.ok, true, JSON.stringify(result.error));
      assert.equal(result.result.providers.some(item => item.id === profile.id), false);
      assert.equal(fs.existsSync(paths.transactionFile), false);
    });
  });
}

test('clearing a key leaves unrelated legacy diagnostics unexpanded at the full Store boundary', async () => {
  await withStore(async (env, paths) => {
    const profile = await seedNormalizationExpansion(env, paths, { secondProfile: true });
    const oldPublic = JSON.parse(fs.readFileSync(paths.publicFile, 'utf8'));
    const result = await request(env, 'codex.providers.clear-secret', {
      providerId: 'second-profile', expectedRevision: profile.revision
    });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    const savedPublic = JSON.parse(fs.readFileSync(paths.publicFile, 'utf8'));
    assert.deepEqual(savedPublic.profiles[0], oldPublic.profiles[0]);
    assert.equal(result.result.providers.find(item => item.id === 'second-profile').hasSecret, false);
    assert.ok(fs.statSync(paths.publicFile).size <= STORE_LIMIT);
  });
});

for (const compact of [false, true]) {
  test(`interrupted deletion restores ${compact ? 'compact' : 'pretty'} raw legacy diagnostics without persisting defaults`, async t => {
    await withStore(async (env, paths) => {
      const profile = await seedNormalizationExpansion(env, paths, { compact });
      const before = snapshot(paths);
      const rename = fs.renameSync;
      let interrupted = false;
      t.mock.method(fs, 'renameSync', (from, to) => {
        if (to === paths.publicFile) interrupted = true;
        if (interrupted) throw Object.assign(new Error('synthetic unavailable filesystem'), { code: 'EIO' });
        return rename(from, to);
      });
      const result = await request(env, 'codex.providers.delete', {
        providerId: profile.id, expectedRevision: profile.revision
      });
      t.mock.restoreAll();
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'provider_store_unavailable');
      assert.equal(fs.existsSync(paths.transactionFile), true);
      // The compact fixture approaches the separate Native output-frame quota;
      // read the real Store directly to verify recovery independently of framing.
      const recovered = loadProviderState(env);
      assert.equal(recovered.public.profiles[0].id, profile.id);
      assert.equal(recovered.public.profiles[0].revision, profile.revision);
      assert.deepEqual(snapshot(paths), before);
      assert.equal(fs.existsSync(paths.transactionFile), false);
    });
  });
}

test('applying a diagnostic preserves unrelated legacy string-model entries', async () => {
  await withStore(async (env, paths) => {
    const profile = await save(env);
    const state = loadProviderState(env);
    state.public.profiles[0].models = ['synthetic-model', 'unchanged-model'];
    writeState(paths, state);
    const current = loadProviderState(env).public.profiles[0];
    const result = recordProviderDiagnostic({
      profileId: profile.id, expectedRevision: profile.revision, modelId: 'synthetic-model',
      connectionFingerprint: computeConnectionFingerprint(current, SYNTHETIC_KEY, 'synthetic-model'),
      wireApi: 'responses', upstreamResponseMode: 'streaming'
    }, env);
    assert.equal(result.recorded, true);
    assert.deepEqual(loadProviderState(env).public.profiles[0].models.map(item => item.id), ['synthetic-model', 'unchanged-model']);
    assert.equal(JSON.parse(fs.readFileSync(paths.publicFile, 'utf8')).profiles[0].models[1], 'unchanged-model');
  });
});
