const assert = require('node:assert/strict');
const test = require('node:test');
const Draft = require('../extension/src/shared/composerAttachmentDraft');
const StorageDb = require('../extension/src/shared/storageDb');
const { createMemoryDraftDb } = require('./_helpers/memoryDraftDb');
const scope = { accountScopeId: 'synthetic-account-a', projectId: 'synthetic-project-a' };
const attachment = name => ({ name, id: name, size: 4, kind: 'file', contentBase64: 'QUFBQQ==' });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; }
function client(store, overrides = {}) {
  let currentScope = { ...scope }, attachments = [], published = [], saves = 0;
  const controller = Draft.createController({
    getScope: () => currentScope, getAttachments: () => attachments,
    setAttachments: value => { published = value; }, restore: value => { attachments = value; },
    clear: () => { attachments = []; }, read: store.read, write: store.write,
    scheduleSave: () => { saves++; }, ...overrides
  });
  return { controller,
    add(name) { attachments.push(attachment(name)); controller.changed(); },
    clear() { attachments = []; controller.changed(); },
    switchTo(value) { currentScope = value; controller.syncScope(); },
    names: () => attachments.map(x => x.name), published: () => published.map(x => x.name),
    saves: () => saves };
}
test('draft store isolates account/project and rejects missing identity', async () => {
  const db = createMemoryDraftDb(), store = Draft.createStore(db.openDb);
  await store.write(scope, { ...await store.read(scope), attachments: [attachment('a.txt')] });
  for (const other of [{ ...scope, projectId: 'other' }, { ...scope, accountScopeId: 'other' }]) {
    assert.deepEqual((await store.read(other)).attachments, []);
  }
  await assert.rejects(store.read({ projectId: 'only-project' }), { code: 'account_scope_unavailable' });
  assert.equal((await store.read(scope)).attachments[0].name, 'a.txt');
});
test('draft store enforces three small attachments and rejects a stale revision', async () => {
  const db = createMemoryDraftDb(), store = Draft.createStore(db.openDb), base = await store.read(scope);
  const oversized = { ...attachment('large.txt'), contentBase64: 'A'.repeat(1024 * 1024 + 1) };
  const result = await store.write(scope, { ...base, attachments: [oversized, ...['a','b','c','d'].map(attachment)] });
  assert.deepEqual(result.attachments.map(x => x.name), ['a','b','c']);
  await assert.rejects(store.write(scope, { ...base, attachments: [attachment('old.txt')] }), { code: 'composer_draft_conflict' });
});
test('transaction failure is not acknowledged and leaves old attachment bytes unchanged', async () => {
  const db = createMemoryDraftDb(), store = Draft.createStore(db.openDb);
  const first = await store.write(scope, { ...await store.read(scope), attachments: [attachment('old.txt')] });
  db.failNextCommit();
  await assert.rejects(store.write(scope, { ...first, attachments: [attachment('new.txt')] }), /commit failure/);
  assert.deepEqual((await store.read(scope)).attachments.map(x => x.name), ['old.txt']);
});
test('explicit remove is durable and repeated hydration cannot resurrect a removed attachment', async () => {
  const db = createMemoryDraftDb(), store = Draft.createStore(db.openDb), first = client(store);
  await first.controller.load(); first.add('a.txt'); await first.controller.save();
  const second = client(store), loaded = await second.controller.load(); second.controller.hydrate(loaded);
  assert.deepEqual(second.names(), ['a.txt']); second.clear(); second.controller.hydrate(loaded);
  assert.deepEqual(second.names(), []); await second.controller.save();
  assert.deepEqual((await store.read(scope)).attachments, []);
});
test('scope switch clears current attachments and rejects an old in-flight load', async () => {
  const db = createMemoryDraftDb(), store = Draft.createStore(db.openDb), gate = deferred();
  const first = client(store, { read: async value => { const result = await store.read(value); await gate.promise; return result; } });
  const loading = first.controller.load(); first.add('a.txt');
  first.switchTo({ ...scope, accountScopeId: 'synthetic-account-b' });
  gate.resolve(); await assert.rejects(loading, { code: 'stale_hydration' });
  assert.deepEqual(first.names(), []); assert.deepEqual(first.published(), []);
});
test('same-scope late load cannot roll metadata or attachments back', async () => {
  const gate = deferred(); let reads = 0; const writes = [];
  const first = client({ read: async () => {
    const number = ++reads;
    if (number === 1) await gate.promise;
    return { epoch: 0, revision: number, attachments: [attachment(`v${number}.txt`)] };
  }, write: async (value, draft) => { writes.push(draft); return { ...draft, revision: 3 }; } });
  const old = first.controller.load();
  first.controller.hydrate(await first.controller.load()); gate.resolve();
  await assert.rejects(old, { code: 'stale_hydration' });
  first.add('new.txt'); await first.controller.save();
  assert.equal(writes[0].revision, 2); assert.deepEqual(first.names(), ['v2.txt','new.txt']);
});
test('history clear blocks an old initialized tab while own empty clear remains saveable', async () => {
  const db = createMemoryDraftDb(), store = Draft.createStore(db.openDb), first = client(store);
  await first.controller.load(); first.add('old.txt'); await store.clear(['artifacts']);
  await assert.rejects(first.controller.save(), { code: 'composer_draft_cleared' });
  await assert.rejects(first.controller.save(), { code: 'composer_draft_cleared' });
  assert.deepEqual((await store.read(scope)).attachments, []);
  first.clear(); await first.controller.save();
  first.add('fresh.txt'); await first.controller.save();
  assert.deepEqual((await store.read(scope)).attachments.map(x => x.name), ['fresh.txt']);
});
test('history clear before a cold delayed read cannot grant a new epoch to an old dirty draft', async () => {
  const db = createMemoryDraftDb(), store = Draft.createStore(db.openDb), gate = deferred();
  const first = client(store, { read: async value => { await gate.promise; return store.read(value); } });
  first.add('old.txt'); const saving = first.controller.save();
  await store.clear(['artifacts']); gate.resolve();
  await assert.rejects(saving, { code: 'composer_draft_cleared' });
  await assert.rejects(first.controller.save(), { code: 'composer_draft_cleared' });
  assert.deepEqual((await store.read(scope)).attachments, []);
});
test('ordinary untouched saves do not rewrite a draft cleared by another tab', async () => {
  const db = createMemoryDraftDb(), store = Draft.createStore(db.openDb), first = client(store);
  await first.controller.load(); first.add('old.txt'); await first.controller.save();
  await store.clear(['artifacts']); await first.controller.save();
  assert.deepEqual((await store.read(scope)).attachments, []);
});
test('a same-scope reload adopts a newer clear only after removing its old visible draft', async () => {
  const db = createMemoryDraftDb(), store = Draft.createStore(db.openDb), first = client(store);
  await first.controller.load(); first.add('old.txt'); await first.controller.save();
  await store.clear(['artifacts']); first.controller.hydrate(await first.controller.load());
  assert.deepEqual(first.names(), []);
  first.add('new.txt'); await first.controller.save();
  assert.deepEqual((await store.read(scope)).attachments.map(x => x.name), ['new.txt']);
});
test('StorageDb clearAllStores advances the persisted draft epoch in its clear transaction', async () => {
  const db = createMemoryDraftDb(), store = Draft.createStore(db.openDb);
  const priorIndexedDb = global.indexedDB;
  global.indexedDB = { open() {
    const request = {}; setImmediate(async () => request.onsuccess({ target: { result: await db.openDb() } })); return request;
  } };
  try {
    const before = await store.write(scope, { ...await store.read(scope), attachments: [attachment('old.txt')] });
    await StorageDb.clearAllStores();
    const after = await store.read(scope);
    assert.equal(after.epoch, before.epoch + 1); assert.deepEqual(after.attachments, []);
    await assert.rejects(store.write(scope, { ...before, attachments: before.attachments }), { code: 'composer_draft_cleared' });
  } finally { if (priorIndexedDb === undefined) delete global.indexedDB; else global.indexedDB = priorIndexedDb; }
});
