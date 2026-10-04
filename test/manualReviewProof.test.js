const assert = require('node:assert/strict');
const test = require('node:test');
const { webcrypto, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Proof = require('../extension/src/shared/manualReviewProof');
const Recovery = require('../extension/src/page/manualReviewRecovery');
const Capture = require('../extension/src/page/trackedChangeCapture');

const key = (id, kind = 'insert', from = 1, to = 4, hash = '3:abcdef:123456') =>
  'native:' + JSON.stringify([id, kind, from, to, hash]);
const owned = key('change-insert-1');
const other = key('change-insert-4', 'insert', 4, 7);
const hash = text => createHash('sha256').update(text).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
function savedProof() {
  return { v: 1, id: 'proof-1', runProjectId: 'project-a', accountScopeId: 'account-a', files: [
    { path: 'main.tex', nativeDocId: 'doc-main', postHash: hash('aNEWold'), targetKeys: [owned], preservedKeys: [other] }
  ] };
}

function harness(options = {}) {
  const state = { projectId: 'project-a', accountScopeId: 'account-a', active: 'main.tex', now: 0,
    cancelled: false, opens: [], mutations: [], hashHook: null, openHook: null,
    docs: new Map([['main.tex', { id: 'doc-main', text: 'aNEWold', keys: [owned, other] }]]) };
  const ref = (path, value) => ({ path, key: value, id: JSON.parse(value.slice(7))[0] });
  const api = Recovery.create({
    window: { fetch() { state.mutations.push('fetch'); }, dispatch() { state.mutations.push('dispatch'); } },
    crypto: { randomUUID: () => 'proof-1', subtle: { async digest(...args) {
      const result = await webcrypto.subtle.digest(...args);
      if (state.hashHook) { const hook = state.hashHook; state.hashHook = null; hook(); }
      return result;
    } } },
    now: () => state.now,
    getProjectId: () => state.projectId,
    getAccountScopeId: () => state.accountScopeId,
    getActiveFilePath: () => state.active,
    readActiveEditorText: () => state.docs.get(state.active)?.text,
    async openFileByPath(path) {
      state.opens.push(path); state.active = path;
      if (state.openHook) { const hook = state.openHook; state.openHook = null; hook(); }
      return { ok: state.docs.has(path) };
    },
    prepareTrackedChangeCapture(path) {
      const doc = state.docs.get(path);
      return doc ? { source: 'native', ready: doc.ready !== false, nativeDocId: doc.id,
        refs: doc.keys.map(value => ref(path, value)), acceptByIdSupported: false } : { ready: false };
    },
    checkWritebackRunProjectId(params) { return params.runProjectId === state.projectId ? null : { ok: false, code: 'wrong_project' }; },
    assertCurrent() { if (state.cancelled) throw Object.assign(new Error('Cancelled'), { code: 'codex_cancelled' }); },
    ...options
  });
  const params = { runProjectId: 'project-a', accountScopeId: 'account-a', deadlineAt: 10000,
    postFiles: [{ path: 'main.tex', content: 'aNEWold' }] };
  const plan = { ok: true, files: [{ path: 'main.tex', nativeDocId: 'doc-main', scope: { ok: true,
    targets: [ref('main.tex', owned)], unrelated: [ref('main.tex', other)] } }] };
  return { state, api, params, plan, doc: () => state.docs.get('main.tex'),
    verify: proof => api.verify({ ...params, manualReviewProof: proof === undefined ? savedProof() : proof }) };
}

test('manual review proof normalizer preserves the strict schema and returns a detached value', () => {
  const input = savedProof(), output = Proof.normalize(input);
  assert.deepEqual(output, input); assert.notEqual(output, input);
  output.files[0].targetKeys.push(key('later')); assert.equal(input.files[0].targetKeys.length, 1);
  const uppercase = savedProof(); uppercase.files[0].postHash = uppercase.files[0].postHash.toUpperCase();
  assert.equal(Proof.normalize(uppercase).files[0].postHash, savedProof().files[0].postHash);
});

test('proof paths preserve literal percent characters without URL decoding', () => {
  for (const path of ['%2e%2e/main.tex', 'chapter%20one.tex', '100%.tex', '%2Fmain.tex']) {
    const proof = savedProof(); proof.files[0].path = path;
    assert.equal(Proof.normalize(proof).files[0].path, path);
  }
});

test('manual proof rejects invalid identities, paths, keys, duplicates, unknown fields, and bounded payloads', () => {
  const mutations = [
    p => { p.v = 2; }, p => { p.accountScopeId = ''; }, p => { p.id = 'x'.repeat(161); },
    p => { p.secret = 'unrecognized'; }, p => { p.files[0].secret = true; },
    p => { p.files[0].path = '../main.tex'; },
    p => { p.files[0].path = '/main.tex'; }, p => { p.files[0].path = 'a//main.tex'; },
    p => { p.files[0].path = ' main.tex'; }, p => { p.files[0].path = 'a\\main.tex'; },
    p => { p.files[0].nativeDocId = 'doc\n'; }, p => { p.files[0].postHash = 'not-sha256'; },
    p => { p.files[0].targetKeys = []; }, p => { p.files[0].targetKeys = ['native-merge:[]']; },
    p => { p.files[0].targetKeys = [key('x', 'delete', 1, 4)]; },
    p => { p.files[0].targetKeys = [key('x', 'insert', 1, 1)]; },
    p => { p.files[0].targetKeys = [key('x', 'insert', 1, 4, '2:abcdef:123456')]; },
    p => { p.files[0].targetKeys.push(owned); }, p => { p.files[0].preservedKeys.push(owned); },
    p => { p.files.push(clone(p.files[0])); },
    p => { p.files = Array.from({ length: Proof.LIMITS.maxFiles + 1 }, (_, i) => ({ ...p.files[0], path: `f${i}.tex` })); },
    p => { p.files[0].preservedKeys = Array.from({ length: Proof.LIMITS.maxRefsPerFile }, (_, i) => key(`k${i}`)); },
    p => { p.files = Array.from({ length: 5 }, (_, i) => ({ ...p.files[0], path: `f${i}.tex`, preservedKeys:
      Array.from({ length: 1000 }, (_, j) => key(`k${j}`)) })); },
    p => { p.files = Array.from({ length: 10 }, (_, i) => ({ ...p.files[0], path: `f${i}.tex`, preservedKeys:
      Array.from({ length: 150 }, (_, j) => key('k'.repeat(240) + j)) })); }
  ];
  for (const mutate of mutations) { const input = savedProof(); mutate(input); assert.equal(Proof.normalize(input), null, JSON.stringify(input).slice(0, 160)); }
});

test('build pins exact postimage and full ready native ledger without mutating the editor', async () => {
  const h = harness(); const before = clone(h.params);
  assert.deepEqual(await h.api.build(h.params, h.plan), savedProof());
  assert.deepEqual(h.params, before); assert.deepEqual(h.state.mutations, []);
});

test('build refuses merged, unknown, incomplete, duplicate or stale target scopes', async () => {
  for (const mutate of [
    h => { h.plan.files[0].scope.merged = {}; },
    h => { h.plan.files[0].scope.targets[0].key = 'native-merge:[]'; },
    h => { h.plan.files[0].scope.targets[0].key = key('missing'); h.plan.files[0].scope.targets[0].id = 'missing'; },
    h => { h.plan.files[0].scope.targets.push(clone(h.plan.files[0].scope.targets[0])); },
    h => { h.plan.files[0].scope.targets[0].id = 'wrong-id'; },
    h => { h.plan.files[0].scope.targets[0].path = 'other.tex'; },
    h => { h.doc().ready = false; }, h => { h.doc().text = 'later'; },
    h => { h.doc().id = 'replacement-doc'; }, h => { h.plan.files.push(clone(h.plan.files[0])); },
    h => { h.params.postFiles.push(clone(h.params.postFiles[0])); },
    h => { h.params.accountScopeId = ''; }
  ]) { const h = harness(); mutate(h); assert.equal(await h.api.build(h.params, h.plan), null); assert.deepEqual(h.state.mutations, []); }
});

test('verified manual acceptance proves target removal with unchanged text and unrelated refs', async () => {
  const h = harness(); const proof = await h.api.build(h.params, h.plan); h.doc().keys = [other];
  const before = clone(proof), result = await h.verify(proof);
  assert.equal(result.ok, true); assert.equal(result.verified, true); assert.equal(result.changedDocument, false);
  assert.equal(result.applied.length, 1); assert.equal(result.applied[0].trackedChange.key, owned);
  assert.equal(result.applied[0].result.method, 'overleaf-manual-review-verified');
  assert.deepEqual(result.skipped, []); assert.deepEqual(proof, before); assert.deepEqual(h.state.mutations, []);
});

test('verification refuses pending target, altered unrelated refs, text or document identity', async () => {
  for (const mutate of [
    () => {}, h => { h.doc().keys = []; }, h => { h.doc().keys = [other, key('extra')]; },
    h => { h.doc().keys = [key('other-replaced')]; },
    h => { h.doc().keys = [other]; h.doc().text = 'aold'; },
    h => { h.doc().keys = [other]; h.doc().id = 'other-doc'; },
    h => { h.doc().keys = [other]; h.doc().ready = false; },
    h => { h.doc().keys = [other]; h.params.postFiles[0].content = 'forged'; },
    h => { h.doc().keys = [other]; h.state.projectId = 'other-project'; },
    h => { h.doc().keys = [other]; h.state.accountScopeId = 'other-account'; },
    h => { h.doc().keys = [other]; h.state.cancelled = true; },
    h => { h.doc().keys = [other]; h.state.now = 10000; }
  ]) { const h = harness(); mutate(h); const result = await h.verify();
    assert.equal(result.ok, false); assert.equal(result.changedDocument, false); assert.deepEqual(result.applied, []);
    assert.ok(result.skipped[0].result.failure.nextAction); assert.deepEqual(h.state.mutations, []); }
});

test('missing or malformed proof fails before navigation', async () => {
  const h = harness(); h.state.active = 'other.tex';
  for (const input of [null, {}, { ...savedProof(), runProjectId: 'other-project' }, { ...savedProof(), accountScopeId: 'other-account' }]) {
    assert.equal((await h.verify(input)).ok, false);
  }
  assert.deepEqual(h.state.opens, []); assert.deepEqual(h.state.mutations, []);
});

test('all await boundaries recheck scope, cancellation, text and ledger during hashing', async () => {
  for (const mutate of [
    h => { h.state.projectId = 'other'; }, h => { h.state.accountScopeId = 'other'; },
    h => { h.state.active = 'other.tex'; }, h => { h.doc().id = 'other-doc'; },
    h => { h.doc().text = 'late'; }, h => { h.doc().keys.push(key('late')); },
    h => { h.state.cancelled = true; }, h => { h.state.now = 10000; }
  ]) {
    const build = harness(); build.state.hashHook = () => mutate(build);
    assert.equal(await build.api.build(build.params, build.plan), null);
    const verify = harness(); verify.doc().keys = [other]; verify.state.hashHook = () => mutate(verify);
    assert.equal((await verify.verify()).ok, false); assert.deepEqual(verify.state.mutations, []);
  }
});

test('navigation is read-only and rejects scope changes, deadline, cancellation and missing files', async () => {
  for (const mutate of [
    h => { h.state.projectId = 'other'; }, h => { h.state.accountScopeId = 'other'; },
    h => { h.state.cancelled = true; }, h => { h.state.now = 10000; }, h => { h.state.docs.delete('main.tex'); }
  ]) { const h = harness(); h.doc().keys = [other]; h.state.active = 'elsewhere.tex'; h.state.openHook = () => mutate(h);
    assert.equal((await h.verify()).ok, false); assert.deepEqual(h.state.opens, ['main.tex']); assert.deepEqual(h.state.mutations, []); }
  const h = harness(); h.doc().keys = [other]; h.state.active = 'elsewhere.tex';
  assert.equal((await h.verify()).ok, true); assert.deepEqual(h.state.opens, ['main.tex']);
});

test('multi-file verification reports success only when every file is proven', async () => {
  const h = harness(); h.doc().keys = [other];
  h.state.docs.set('second.tex', { id: 'doc-second', text: 'aNEWold', keys: [other] });
  const proof = savedProof(); proof.files.push({ ...clone(proof.files[0]), path: 'second.tex', nativeDocId: 'doc-second' });
  h.params.postFiles.push({ path: 'second.tex', content: 'aNEWold' });
  assert.equal((await h.verify(proof)).applied.length, 2);
  h.state.docs.get('second.tex').keys.push(owned);
  const result = await h.verify(proof); assert.equal(result.ok, false); assert.deepEqual(result.applied, []);
});

test('proof build and verification compose with the real History-OT native ranges adapter', async () => {
  const changes = [
    { id: 'change-insert-1', snapshotRange: { start: 1, end: 4 }, op: { p: 1, i: 'NEW' } },
    { id: 'change-insert-4', snapshotRange: { start: 4, end: 7 }, op: { p: 4, i: 'old' } }
  ];
  const capture = Capture.create({ getCodeMirrorEditorView: () => ({ state: {
    doc: { length: 7, toString: () => 'aNEWold' }, values: [{ ranges: { docId: 'doc-main', changes, comments: [] }, threads: {} }]
  } }), getTrackedChangeDocumentId: () => 'doc-main' });
  const h = harness({ prepareTrackedChangeCapture: capture.prepareTrackedChangeCapture });
  const before = capture.prepareTrackedChangeCapture('main.tex');
  assert.equal(before.acceptByIdSupported, false);
  h.plan.files[0].scope = { ok: true, targets: [before.refs[0]], unrelated: [before.refs[1]] };
  const proof = await h.api.build(h.params, h.plan); assert.ok(proof);
  changes.shift();
  assert.equal((await h.verify(proof)).ok, true); assert.deepEqual(h.state.mutations, []);
});

test('shared proof and page recovery load in MAIN without a registry and with the content registry', () => {
  const source = relative => fs.readFileSync(path.join(__dirname, '..', 'extension/src', relative), 'utf8');
  for (const registry of [false, true]) {
    const context = vm.createContext({ TextEncoder });
    if (registry) vm.runInContext(source('content/moduleRegistryKernel.js'), context);
    vm.runInContext(source('shared/projectFiles.js'), context);
    vm.runInContext(source('shared/manualReviewProof.js'), context);
    vm.runInContext(source('page/manualReviewRecovery.js'), context);
    assert.deepEqual(clone(context.CodexOverleafManualReviewProof.normalize(savedProof())), savedProof());
    assert.equal(typeof context.CodexOverleafManualReviewRecovery.create, 'function');
    if (registry) assert.equal(context.CodexOverleafModuleRegistry.resolve('ManualReviewProof'), context.CodexOverleafManualReviewProof);
  }
});

test('guard block returns and unavailable hashing preserve the caller proof and checkpoints', async () => {
  for (const options of [{ assertCurrent: () => false }, { assertCurrent: () => ({ ok: false, code: 'codex_cancelled' }) },
    { crypto: { randomUUID: () => 'proof-1' } }]) {
    const h = harness(options), paramsBefore = clone(h.params), proof = savedProof(), proofBefore = clone(proof);
    assert.equal(await h.api.build(h.params, h.plan), null); h.doc().keys = [other];
    assert.equal((await h.verify(proof)).ok, false); assert.deepEqual(h.params, paramsBefore);
    assert.deepEqual(proof, proofBefore); assert.deepEqual(h.state.mutations, []);
  }
});
