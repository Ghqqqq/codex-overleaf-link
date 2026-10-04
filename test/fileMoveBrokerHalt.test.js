'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const Broker = require('../extension/src/content/assetTransferBroker');
const Router = require('../extension/src/page/writebackRouter');
const Guard = require('../extension/src/page/writeGuard');
const Stale = require('../extension/src/shared/staleGuard');
const Files = require('../extension/src/shared/projectFiles');
const { fixture } = require('./_helpers/fileMoveFixture');
for (const unknown of [false, true]) test('a failed move halts later text and binary writes; receipt unknown=' + unknown, async () => {
  const h = fixture(unknown ? { unknownStep: 1 } : { target: 'dest/new.tex', failStep: 2 });
  Object.assign(h.window, { CodexOverleafWriteGuard: Guard, CodexOverleafStaleGuard: Stale });
  let created = 0;
  const router = Router.create({ window: h.window, treeOperations: h.treeOperations, moveFile: h.mover.moveFile,
    normalizeSafeProjectPath: Files.normalizeSafeProjectPath,
    ensureEditing: async () => ({ ok: true }), ensureReviewing: async () => ({ ok: true }),
    createTextFile: async () => { created++; return { ok: true }; } });
  const requests = [];
  const broker = Broker.create({ callPageBridge: async (method, params) => {
    requests.push(method); assert.equal(method, 'applyOperations'); return router.applyOperations(params.operations, params);
  }, sendBackgroundNative: async () => { throw new Error('Binary transfer must never start'); } });
  const result = await broker.applyOperations({ runProjectId: h.state.projectId, requireEditing: true,
    operations: [h.operation, { type: 'create', path: 'later.tex', content: 'do not write' },
      { type: 'binary-create', path: 'later.png', contentBase64: 'bm8=', sha256: 'a'.repeat(64), size: 2 }] });
  assert.deepEqual(requests, ['applyOperations']); assert.equal(created, 0); assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 3); assert.equal(result.haltRemainingOperations, true);
  assert.equal(result.receiptUnconfirmed === true, unknown);
  assert.equal(result.skipped.at(-1).result.changedDocument, false);
  if (!unknown) assert.match(result.skipped.at(-1).result.reason, /stopped this file plan/);
});
