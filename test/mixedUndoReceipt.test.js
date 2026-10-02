'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const Router = require('../extension/src/page/writebackRouter');
const Creator = require('../extension/src/page/textFileCreator');
const Journal = require('../extension/src/page/writebackReceiptJournal');
const SaveState = require('../extension/src/page/saveState');
const Guard = require('../extension/src/page/writeGuard');
const Contract = require('../extension/src/shared/pageRpcContract');
const Storage = require('../extension/src/shared/storageDb');
const Session = require('../extension/src/shared/sessionState');

// Reuse the existing native-history/document fixture, but replace its direct
// router call with the actual MAIN-world message handler, dispatcher and journal.
// Only native DOM/history actions and the remote delete receipt remain fixture
// surfaces. The orchestrator, checkpoints, native review, mode guard and receipt
// ownership execute their production implementations.
const fixtureSource = fs.readFileSync(path.join(__dirname, 'createdFileUndo.test.js'), 'utf8');
const fixtureEnd = fixtureSource.indexOf("\ntest('Track creates");
assert.ok(fixtureEnd > 0);
const bridgeSource = fs.readFileSync(path.join(__dirname, '../extension/src/pageBridge.js'), 'utf8');
const handlerStart = bridgeSource.indexOf('  const pageBridgeMessageHandler = async event => {');
const handlerEnd = bridgeSource.indexOf('\n  window.__codexOverleafPageBridgeMessageHandler', handlerStart);
const dispatchStart = bridgeSource.indexOf('  async function dispatch(method, params) {');
const dispatchEnd = bridgeSource.indexOf('\n  function ', dispatchStart + 1);
assert.ok(handlerStart >= 0 && handlerEnd > handlerStart && dispatchStart >= 0 && dispatchEnd > dispatchStart);

function harness(options = {}) {
  let h, dependencies, clock = 0, modeCalls = 0, preparationCalls = 0;
  const receipts = [], rpcCalls = [], serverChecks = [];
  const fixtureRequire = id => id === '../extension/src/page/writebackRouter' ? {
    create(deps) {
      dependencies = deps;
      return Router.create({ ...deps,
        async setReviewingEnabled(enabled, params) {
          modeCalls++;
          if (options.modeNeverConfirms) return { ok: false, code: 'editing_not_confirmed' };
          const result = await deps.setReviewingEnabled(enabled, params);
          if (options.lateModeReceipt && modeCalls === 1) {
            // The async UI transition has committed, while the previous mode
            // observation returned failure. The next authoritative read sees it.
            return { ok: false, code: 'editing_not_confirmed', reason: 'Mode observation expired.' };
          }
          return result;
        },
        confirmReviewWriteback: (params, result) => SaveState.confirmReviewWriteback({
          params, result, getProjectId: deps.treeOperations.getProjectId,
          now: () => clock, timeoutMs: 600,
          delay: async ms => { clock += ms; },
          readSnapshot: async () => {
            serverChecks.push(params.runProjectId);
            return { ok: !options.saveUnavailable, files: [...h.docs.values()].map(file => ({
              ...file, source: 'overleaf-zip'
            })) };
          }
        })
      });
    }
  } : require(id);
  const makeHarness = vm.runInNewContext(fixtureSource.slice(0, fixtureEnd) + '\nharness;', {
    require: fixtureRequire, __dirname, Buffer, setTimeout, clearTimeout
  });
  h = makeHarness({ mixed: true, track: options.track !== false });
  const editor = { closest: () => null, getAttribute: () => '', getClientRects: () => [{}] };
  let visibleEditor = !options.reopenEditor;
  const document = { querySelector: () => null,
    querySelectorAll: selector => selector === '.cm-content' && visibleEditor ? [editor] : [] };
  const window = { ...dependencies.window, document,
    location: { origin: 'https://www.overleaf.com' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    setTimeout(callback, ms) { clock += ms; queueMicrotask(callback); },
    postMessage(message) { receipts.push(structuredClone(message)); }
  };
  const treeOperations = { ...dependencies.treeOperations,
    collectProjectTextPaths: () => [...h.docs.values()].filter(file => typeof file.content === 'string').map(file => file.path),
    async openFileByPath(target, params) {
      const opened = await dependencies.treeOperations.openFileByPath(target, params);
      visibleEditor = opened.ok;
      return opened;
    }
  };
  const creator = Creator.create({ window, document, treeOperations });
  const journal = Journal.create({ getProjectId: () => h.state.projectId,
    async prepareEditor(params) { preparationCalls++; return creator.prepareEditor(params); },
    applyOperations: (operations, params) => h.router.applyOperations(operations, params)
  });
  const guard = Guard.create({ window, treeOperations, sleep: async () => {} });
  const pageContext = {
    window, pageRpcContract: Contract, writeGuard: guard,
    PAGE_BRIDGE_CAPABILITY_METHOD: 'initializeCapability',
    PAGE_BRIDGE_INSTALL_VERSION: '2.5.0', PAGE_BRIDGE_INSTALL_REVISION: Contract.REVISION,
    pageBridgeCapabilityGuard: { hasValidPageBridgeCapability: () => true },
    pageRpcHandlers: { applyOperations: journal.apply, rejectTrackedChanges: h.router.rejectTrackedChanges }
  };
  vm.createContext(pageContext);
  vm.runInContext(bridgeSource.slice(dispatchStart, dispatchEnd) + '\n'
    + bridgeSource.slice(handlerStart, handlerEnd) + '\nglobalThis.handle = pageBridgeMessageHandler;', pageContext);
  h.context.callPageBridge = async (method, params) => {
    const id = 'mixed-undo-rpc-' + (rpcCalls.length + 1);
    rpcCalls.push({ id, method, params: structuredClone(params) });
    await pageContext.handle({ source: window, origin: window.location.origin,
      data: { source: 'codex-overleaf/content', id, method, params: structuredClone(params), capability: 'fixture' } });
    const receipt = receipts.find(message => message.id === id);
    assert.ok(receipt, 'The production handler must post a matching response');
    return receipt.result;
  };
  return { ...h, journal, rpcCalls, receipts, serverChecks,
    preparations: () => preparationCalls, modeCalls: () => modeCalls };
}

for (const track of [true, false]) {
  test('mixed Undo crosses the message handler and receipt journal once with Track=' + track, async () => {
    const h = harness({ track, reopenEditor: true });
    await h.undo();
    assert.equal(track ? h.run.trackedChangeStatus : h.run.undoStatus, track ? 'rejected' : 'applied',
      JSON.stringify(h.receipts));
    assert.equal(h.docs.get('main.tex').content, 'before\n');
    assert.deepEqual([...h.docs.keys()], ['main.tex']);
    assert.equal(h.preparations(), 1);
    assert.ok(h.serverChecks.length > 0, 'Native text restoration requires its actual server confirmation');
    const deletion = h.rpcCalls.find(call => call.method === 'applyOperations');
    assert.ok(deletion);
    assert.equal(deletion.params.deadlineAt, h.rpcCalls.find(call => call.method === 'rejectTrackedChanges').params.deadlineAt);
    assert.ok(Number.isFinite(deletion.params.deadlineAt));
    const saved = h.journal.get({ requestId: deletion.id, runProjectId: h.run.runProjectId });
    assert.equal(saved.state, 'completed');
    assert.equal(saved.result.applied.length, 3);
    assert.equal(saved.result.skipped.length, 0);
    assert.equal(saved.requestId, deletion.id, 'The handler supplies the actual request ID');
  });
}

test('refresh preserves native identities before mixed Undo through the receipt boundary', async () => {
  const h = harness();
  const stored = Storage.buildSessionRecord({ id: 'qa-session', projectId: h.run.runProjectId,
    requireReviewing: true, runs: [h.run] }, { preserveRunActionPayload: true });
  Object.assign(h.run, Session.normalizeRuns(JSON.parse(JSON.stringify(stored.runs)), { restoreRunningRuns: true })[0]);
  await h.undo();
  assert.equal(h.run.trackedChangeStatus, 'rejected', JSON.stringify(h.receipts));
  assert.equal(h.state.undoClicks, 1);
  assert.equal(h.state.removed.length, 3);
});

test('unconfirmed native save keeps created files and does not dispatch their deletion', async () => {
  const h = harness({ saveUnavailable: true });
  await h.undo();
  assert.equal(h.docs.get('main.tex').content, 'before\n');
  assert.equal(h.state.removed.length, 0);
  assert.equal(h.preparations(), 0);
  assert.equal(h.rpcCalls.some(call => call.method === 'applyOperations'), false);
  assert.equal(h.receipts[0].result.saveVerification.ok, false);
  assert.equal(h.receipts[0].result.skipped[0].result.code, 'undo_not_verified');
});

test('an unconfirmed editing mode never grants created-file deletion permission', async () => {
  const h = harness({ modeNeverConfirms: true });
  await h.undo();
  assert.equal(h.docs.get('main.tex').content, 'before\n');
  assert.equal(h.state.removed.length, 0);
  assert.equal(h.run.trackedChangeStatus, 'needs_review');
  assert.ok(h.receipts.at(-1).result.skipped.every(entry => entry.result.code === 'editing_not_confirmed'));
});

test('a stale negative mode receipt cannot block a subsequently stable Editing state', async () => {
  const h = harness({ lateModeReceipt: true });
  await h.undo();
  assert.equal(h.docs.get('main.tex').content, 'before\n');
  assert.deepEqual([...h.docs.keys()], ['main.tex'], JSON.stringify(h.receipts));
  assert.equal(h.run.trackedChangeStatus, 'rejected');
});
