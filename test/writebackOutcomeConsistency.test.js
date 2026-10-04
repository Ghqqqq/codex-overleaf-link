'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFlow, Settlement, Failure } = require('./_helpers/writebackOutcomeHarness');
const { renderNotice } = require('./_helpers/writebackOutcomeUi');
const Results = require('../extension/src/content/runResultActions').create();
const Evidence = require('../extension/src/shared/writebackOperationEvidence');
const reportOf = run => run.events.findLast(event => event.kind === 'report');
const edit = { type: 'write', path: 'main.tex', content: 'Updated synthetic text' };
const create = { type: 'create', path: 'new.tex', content: 'New synthetic text' };

test('complete writeback retains matching report, settlement and terminal success', async () => {
  const f = createFlow(), run = await f.run();
  assert.equal(run.status, 'completed'); assert.equal(reportOf(run).status, 'completed');
  assert.equal(run.settlement.evidence.settled, 'complete');
});

test('missing text receipt is filled by the real Broker before report and terminal state', async () => {
  const f = createFlow({ syncChanges: [create, { ...create, path: 'second.tex' }], truncateReceipt: true });
  const run = await f.run(), result = f.applications.at(-1);
  assert.equal(result.applied.length, 1); assert.equal(result.skipped.length, 1);
  assert.equal(result.receiptUnconfirmed, true); assert.equal(run.status, 'failed');
  assert.equal(run.settlement.evidence.settled, 'needs-review');
  assert.match(reportOf(run).detail, /wrote 1 item, skipped 1 item/);
});

test('unconfirmed text still blocks binary tail dispatch and retains its skipped result', async () => {
  const f = createFlow({ truncateReceipt: true, syncChanges: [create, { ...create, path: 'second.tex' },
    { type: 'binary-create', path: 'figure.png', size: 1, contentBase64: 'QQ==' }] });
  const run = await f.run();
  assert.equal(f.trace.some(item => item.method === 'binaryUploadBegin'), false);
  assert.equal(f.applications.at(-1).skipped.length, 2); assert.equal(run.status, 'failed');
});

for (const [original, current] of [[false, true], [true, false], [true, true], [false, false]]) {
  test(`Retry inherits submitted Auto Compile ${original} despite current ${current}`, async () => {
    const f = createFlow({ autoRecompile: original, creatorOptions: { zipUnavailable: true } });
    await f.run(); assert.equal(f.getRecord().executionSnapshot.autoRecompile, original);
    f.creatorOptions.zipUnavailable = false; f.setCompile(current);
    const run = await f.retry();
    assert.equal(run.status, 'completed'); assert.equal(f.compileCalls().length, original ? 1 : 0);
    assert.equal(f.trace.filter(item => item.kind === 'orchestrator-options').at(-1).options.autoRecompile, original);
    assert.equal(f.h.io.requests.length, 1, 'Retry writes remaining operations without another model run');
  });
}

for (const current of [false, true]) {
  test(`legacy Retry without a snapshot preserves current-setting compatibility: ${current}`, async () => {
    const f = createFlow({ creatorOptions: { zipUnavailable: true } }); await f.run();
    delete f.getRecord().executionSnapshot;
    f.creatorOptions.zipUnavailable = false; f.setCompile(current); await f.retry();
    assert.equal(f.compileCalls().length, current ? 1 : 0);
  });
}

test('Retry with failed writes cannot compile even when its captured setting is true', async () => {
  const f = createFlow({ autoRecompile: true, creatorOptions: { zipUnavailable: true } }); await f.run();
  await f.retry(); assert.equal(f.getRecord().status, 'failed'); assert.equal(f.compileCalls().length, 0);
});

test('Retry preserves original compile choice and save-wait behavior when save is unconfirmed', async () => {
  const f = createFlow({ autoRecompile: true, editNoMutation: true, saveUnknown: true, snapshotUnavailable: true, syncChanges: [edit] });
  await f.run(); f.config.editNoMutation = false; f.setCompile(false); await f.retry();
  assert.equal(f.compileCalls().length, 1); assert.equal(f.compileCalls()[0].params.waitForSaveMs, 5000);
  assert.equal(f.reportInputs.at(-1).saveVerification.state, 'unknown_timeout');
});

test('Retry ownership refusal still prevents any page write or compile', async () => {
  const f = createFlow({ autoRecompile: true, creatorOptions: { zipUnavailable: true } }); await f.run();
  f.getRecord().retryWriteback.accountScopeId = 'different-account';
  const calls = f.trace.length; await f.retry(); assert.equal(f.trace.length, calls);
});

for (const blockedFirst of [false, true]) {
  test(`real Page mixed failure primary is consistent regardless of order: blockedFirst=${blockedFirst}`, async () => {
    const f = createFlow({ editNoMutation: true, creatorOptions: { zipUnavailable: true }, syncChanges: blockedFirst ? [create, edit] : [edit, create] });
    const run = await f.run(), event = reportOf(run), primary = Settlement.projectRunSettlement(run).primaryFailure;
    assert.equal(primary.code, 'source_zip_unavailable'); assert.equal(event.failure.code, primary.code);
    assert.equal(event.failure.file, primary.file); assert.equal(primary.file, 'new.tex');
    const rendered = renderNotice(f, event, run).snapshot();
    assert.match(rendered.notices[0].text, /project could not be checked/i);
    assert.equal(rendered.buttons.length, 0, 'source ZIP recovery uses the independent Retry sync toolbar');
    assert.equal(rendered.toolbar['sync-retry'].hidden, false);
  });
}

test('current settlement drives Notice and generic action even when historical report failure differs', async () => {
  const f = createFlow({ editNoMutation: true, creatorOptions: { zipUnavailable: true }, syncChanges: [edit, create] });
  const run = await f.run();
  const originalFailure = f.applications.at(-1).skipped[0].result.failure;
  const historic = { ...reportOf(run), failure: originalFailure };
  const before = JSON.stringify(historic);
  const rendered = renderNotice(f, historic, run).snapshot();
  assert.match(rendered.notices[0].text, /project could not be checked/i);
  assert.equal(rendered.buttons.length, 0);
  assert.equal(JSON.stringify(historic), before, 'rendering does not rewrite the historic report');
});

test('known uncertain write takes review priority over a later preflight blocker', async () => {
  const f = createFlow({ creatorOptions: { zipFailsAfterUpload: true }, syncChanges: [create],
    unsupportedChanges: [{ type: 'create', path: 'withheld.tex', reason: 'subagent_unfinished_output' }] });
  const run = await f.run(), event = reportOf(run), primary = Settlement.projectRunSettlement(run).primaryFailure;
  assert.equal(primary.code, 'file_upload_unconfirmed'); assert.equal(event.failure.code, primary.code);
  assert.equal(run.settlement.evidence.settled, 'needs-review');
  const notice = renderNotice(f, event, run), rendered = notice.snapshot();
  assert.equal(rendered.buttons.length, 1); assert.match(rendered.buttons[0].text, /Review/);
  assert.notEqual(rendered.buttons[0].text, 'Edit & resend');
  const clicked = await notice.click(); assert.deepEqual(clicked.before, clicked.after);
});

test('ordinary recoverable failure still refills without automatic Native or Page dispatch', async () => {
  const f = createFlow({ editNoMutation: true, syncChanges: [edit] }), run = await f.run();
  const notice = renderNotice(f, reportOf(run), run);
  assert.equal(notice.snapshot().buttons[0].text, 'Edit & resend');
  const clicked = await notice.click(); assert.deepEqual(clicked.before, clicked.after); assert.equal(clicked.composer, run.task);
});

test('partial Undo review remains ahead of the historical Edit action', async () => {
  const f = createFlow({ initialFiles: { 'second.tex': 'Second original' }, editNoMutationPaths: ['second.tex'],
    syncChanges: [edit, { type: 'write', path: 'second.tex', content: 'Changed second' }] });
  const run = await f.run(), event = reportOf(run);
  const transition = Settlement.settleLegacyUndo({ run, status: 'partial', result: { ok: false, skipped: [{ operation: { type: 'edit', path: 'main.tex' }, result: { ok: false, code: 'undo_not_verified', changedDocument: true } }] } });
  Object.assign(run, Settlement.applySettlementTransition(run, transition));
  const notice = renderNotice(f, event, run); assert.notEqual(notice.snapshot().buttons[0].text, 'Edit & resend');
  const clicked = await notice.click(); assert.equal(clicked.actions[0].type, 'open-file'); assert.deepEqual(clicked.before, clicked.after);
});

test('legacy failure normalization uses the shared contract without losing mutation uncertainty', () => {
  const operation = { type: 'edit', path: 'main.tex' };
  const result = { ok: false, code: 'stale_snapshot', reason: 'Changed source' };
  assert.equal(Evidence.normalizeFailure(result, operation).code, Failure.normalizeFailureReason(result, operation).code);
  const uncertain = Evidence.normalizeFailure({ ok: false, code: 'unknown_transport_code', changedDocument: true,
    failure: { code: 'unknown_transport_code', stage: 'write', changedDocument: true } }, operation);
  assert.equal(uncertain.changedDocument, true);
  assert.equal(Evidence.normalizeFailure({ ok: false, reason: 'Unclassified rejection' }, operation).code, 'unknown_legacy_failure');
  assert.equal(Evidence.normalizeFailure({ ok: true }, operation), null);
});

for (const locale of ['en', 'zh']) {
  const tx = (en, zh) => locale === 'zh' ? zh : en;
  const options = { tx, trackedChangeInFlight: new Map(), isTrackedChangeLifecycleRun: () => false,
    projectRunSettlement: Settlement.projectRunSettlement };
  test(`omitted Undo material is explicit in details and attention summary: ${locale}`, () => {
    const run = { id: 'retained-facts-only', status: 'completed', recoveryRetention: { state: 'omitted', reason: 'session-budget', bytes: 9876543 } };
    const rows = Results.projectCompletionMeta([{ key: 'writeResult', label: 'Write result', value: 'wrote 2 items, skipped 0 items' }], run, options);
    const expected = tx('Persistent recovery data was not retained: local recovery budget exceeded. After reload, use Overleaf history to recover.', '持久恢复材料未保留：超过本地恢复预算，刷新后请使用 Overleaf 历史恢复。');
    assert.equal(rows.find(row => row.key === 'recoveryRetention').value, expected);
    const summary = Results.summarizeCompletionMeta(rows, run, { tx });
    assert.equal(summary.open, true); assert.equal(summary.warnKeys.has('recoveryRetention'), true);
    assert.equal(summary.facts.some(fact => /Nothing to undo|无可撤销写入/.test(fact.text)), false);
    assert.match(summary.facts.find(fact => fact.key === 'recoveryRetention').text, locale === 'zh' ? /未保留/ : /not retained/);
  });
  test(`terminal Undo/Accept statuses keep priority over omitted-material marker: ${locale}`, () => {
    for (const state of [{ undoStatus: 'applied' }, { trackedChangeStatus: 'rejected' }, { trackedChangeStatus: 'accepted' }]) {
      const run = { id: 'terminal', ...state, recoveryRetention: { state: 'omitted', reason: 'fallback' } };
      const rows = Results.projectCompletionMeta([{ key: 'undo', value: '0' }], run, { ...options, isTrackedChangeLifecycleRun: () => Boolean(run.trackedChangeStatus) });
      assert.doesNotMatch(rows[0].value, /not retained|未保留/);
    }
  });
  test(`omitted directory review data remains visible beside terminal Undo/Accept: ${locale}`, () => {
    for (const state of [{ undoStatus: 'applied' }, { trackedChangeStatus: 'accepted' }]) {
      for (const directoryCleanup of [true, false, undefined]) {
        const run = { id: 'terminal-directory', ...state,
          recoveryRetention: { state: 'omitted', reason: 'session-budget', directoryCleanup } };
        const before = JSON.stringify(run);
        const rows = Results.projectCompletionMeta([{ key: 'undo', value: '0' }], run,
          { ...options, isTrackedChangeLifecycleRun: () => Boolean(run.trackedChangeStatus) });
        const summary = Results.summarizeCompletionMeta(rows, run, { tx });
        const warning = rows.find(row => row.key === 'recoveryRetention');
        assert.equal(Boolean(warning), directoryCleanup === true);
        assert.equal(summary.warnKeys.has('recoveryRetention'), directoryCleanup === true);
        assert.equal(summary.open, directoryCleanup === true);
        if (warning) assert.match(warning.value, locale === 'zh' ? /目录.*人工检查/ : /folder.*manually/i);
        assert.match(rows.find(row => row.key === 'undo').value, locale === 'zh' ? /已撤销|已接受/ : /undone|accepted/);
        assert.match(summary.facts.find(fact => fact.key === 'undo').text, locale === 'zh' ? /已撤销|已接受/ : /undone|accepted/);
        assert.equal(Settlement.projectRunSettlement(run).canUndo, false);
        assert.equal(JSON.stringify(run), before);
      }
    }
  });
}

test('live Undo availability remains visible alongside the persistent-retention warning', () => {
  const run = { recoveryRetention: { state: 'omitted', reason: 'session-budget' }, undoOperations: [{ type: 'edit', path: 'main.tex', replaceAll: 'before' }] };
  const rows = [{ key: 'undo', value: 'this run has 1 reversible write' }];
  const summary = Results.summarizeCompletionMeta(rows, run, { tx: en => en });
  assert.equal(summary.facts.find(fact => fact.key === 'undo').text, '1 undoable');
  assert.ok(summary.facts.some(fact => fact.key === 'recoveryRetention'));
  assert.equal(Settlement.projectRunSettlement(run).canUndo, true);
});

test('fallback or invalid recovery omission does not claim a size-budget failure', () => {
  for (const reason of ['fallback', 'invalid']) {
    const run = { recoveryRetention: { state: 'omitted', reason } };
    const rows = Results.projectCompletionMeta([], run, { tx: en => en,
      isTrackedChangeLifecycleRun: () => false, projectRunSettlement: Settlement.projectRunSettlement });
    const notice = rows.find(row => row.key === 'recoveryRetention').value;
    assert.match(notice, /Persistent recovery data was not retained/);
    assert.doesNotMatch(notice, /budget exceeded/);
  }
});

test('possible-mutation evidence survives facts compaction and keeps the same review primary', () => {
  const uncertain = { code: 'source_zip_unavailable', stage: 'verify', severity: 'warning', userMessage: 'Readback unknown', retryable: false, mayHaveMutated: true };
  const blocked = { code: 'source_zip_unavailable', stage: 'preflight', severity: 'blocked', userMessage: 'Upload blocked', retryable: false, changedDocument: false };
  const operations = [{ type: 'edit', path: 'first.tex' }, { type: 'create', path: 'second.tex' }];
  const applied = { ok: false, applied: [], skipped: operations.map((operation, index) => ({ operation, result: { ok: false, failure: index ? blocked : uncertain, mayHaveMutated: !index } })) };
  const facts = Settlement.settle({ operations, applyResult: applied }).facts;
  const projection = Settlement.projectRunSettlement({ settlement: facts });
  assert.equal(projection.primaryFailure.file, 'first.tex');
  assert.equal(projection.requiresWriteReview, true);
  assert.equal(facts.evidence.settled, 'needs-review');
});

test('readonly writeback check is a separate action and never calls Retry sync or model submission', async () => {
  const f = createFlow({ creatorOptions: { zipUnavailable: true } }), run = await f.run();
  run.writebackCheck = { v: 1, purpose: 'writeback-revalidation', projectId: 'example', files: [{ path: 'new.tex', absent: true }] };
  let checks = 0, retries = 0;
  f.c.retryRunWriteback = () => { retries++; };
  const ui = renderNotice(f, reportOf(run), run, { checkWriteback: async id => { assert.equal(id, run.id); checks++; } });
  assert.equal(ui.snapshot().toolbar['sync-check'].hidden, false);
  assert.equal(ui.snapshot().toolbar['sync-retry'].hidden, false);
  const before = { model: f.h.io.requests.length, page: f.trace.filter(item => item.kind === 'page').length };
  await ui.clickCheck(); assert.equal(checks, 1); assert.equal(retries, 0);
  assert.deepEqual({ model: f.h.io.requests.length, page: f.trace.filter(item => item.kind === 'page').length }, before);
});

test('readonly check is disabled during a run and hidden for fork snapshots or missing proof', async () => {
  const f = createFlow(), run = await f.run();
  const check = { v: 1, purpose: 'writeback-revalidation', files: [{ path: 'one.tex', sha256: 'a'.repeat(64) }] };
  let calls = 0;
  f.c.currentRunView = { recordId: run.id };
  const busy = renderNotice(f, reportOf(run), { ...run, writebackCheck: check }, { checkWriteback: async () => { calls++; } });
  assert.equal(busy.snapshot().toolbar['sync-check'].disabled, true); await busy.clickCheck(); assert.equal(calls, 0);
  f.c.currentRunView = null;
  for (const variant of [{ ...run, writebackCheck: null }, { ...run, forkSnapshot: true, writebackCheck: check }]) {
    assert.equal(renderNotice(f, reportOf(run), variant, { checkWriteback: async () => { calls++; } }).snapshot().toolbar['sync-check'].hidden, true);
  }
});

test('live readonly check remains available after Undo while proof remains without changing terminal ownership', async () => {
  const f = createFlow(), run = await f.run();
  run.undoStatus = 'applied'; run.writebackCheck = { v: 1, purpose: 'writeback-revalidation', files: [{ path: 'one.tex', sha256: 'a'.repeat(64) }] };
  const before = JSON.stringify(run);
  const ui = renderNotice(f, reportOf(run), run, { checkWriteback: async () => {} });
  assert.equal(ui.snapshot().toolbar['sync-check'].hidden, false); await ui.clickCheck(); assert.equal(JSON.stringify(run), before);
});

test('manual review proof exposes only original-run navigation and readonly verification callbacks', async () => {
  const f = createFlow(), run = await f.run(), calls = [];
  run.trackedChangeStatus = 'pending';
  run.manualReviewProof = { v: 1, id: 'proof', runProjectId: 'example', accountScopeId: 'account-one',
    files: [{ path: 'one.tex', nativeDocId: 'doc-one', postHash: 'a'.repeat(64), targetKeys: ['own'], preservedKeys: ['other'] }] };
  const ui = renderNotice(f, reportOf(run), run, {
    openManualReviewFile: async (id, file) => calls.push(['open', id, file]),
    verifyManualReview: async id => calls.push(['verify', id])
  });
  assert.deepEqual(ui.snapshot().buttons.map(button => button.recoveryFor), ['manual-review-open', 'manual-review-verify']);
  const before = { model: f.h.io.requests.length, page: f.trace.filter(item => item.kind === 'page').length };
  await ui.click(0); await ui.click(1);
  assert.deepEqual(calls, [['open', run.id, 'one.tex'], ['verify', run.id]]);
  assert.deepEqual(ui.actions, [], 'neither the generic current-project open nor Edit/Retry callback runs');
  assert.deepEqual({ model: f.h.io.requests.length, page: f.trace.filter(item => item.kind === 'page').length }, before);
});

test('tracked changes remaining without a proof offer scoped navigation, never a blind verifier', async () => {
  const f = createFlow(), run = await f.run(), calls = [];
  const transition = Settlement.settleTrackedChangeLifecycle({ kind: 'accept', run, result: { ok: false,
    skipped: [{ operation: { type: 'edit', path: 'one.tex' }, result: { ok: false, code: 'tracked_changes_remain', changedDocument: false } }] } });
  Object.assign(run, Settlement.applySettlementTransition(run, transition));
  const ui = renderNotice(f, reportOf(run), run, { openManualReviewFile: async (id, file) => calls.push([id, file]),
    verifyManualReview: async () => { throw new Error('missing proof must not offer verification'); } });
  assert.deepEqual(ui.snapshot().buttons.map(button => button.recoveryFor), ['manual-review-open']);
  await ui.click(); assert.deepEqual(calls, [[run.id, 'one.tex']]); assert.deepEqual(ui.actions, []);
});

test('accepted and forked runs suppress manual-review proof actions; an active run disables them', async () => {
  const f = createFlow(), run = await f.run();
  const proof = { v: 1, files: [{ path: 'one.tex' }] };
  const actions = { openManualReviewFile: async () => { throw new Error('disabled action'); }, verifyManualReview: async () => { throw new Error('disabled action'); } };
  for (const variant of [{ ...run, trackedChangeStatus: 'accepted', manualReviewProof: proof },
    { ...run, forkSnapshot: true, manualReviewProof: proof }]) {
    assert.equal(renderNotice(f, reportOf(run), variant, actions).snapshot().buttons.some(button => button.recoveryFor.startsWith('manual-review')), false);
  }
  f.c.currentRunView = { recordId: run.id };
  const busy = renderNotice(f, reportOf(run), { ...run, trackedChangeStatus: 'pending', manualReviewProof: proof }, actions);
  await busy.click(0); await busy.click(1); assert.deepEqual(busy.actions, []);
  f.c.currentRunView = null;
});

function pendingFolders(run) {
  return { v: 1, accountScopeId: 'account-one', projectId: 'example', sessionId: 'A', runId: run.id,
    directories: [{ v: 1, projectId: 'example', path: 'new/nested', nativeFolderId: 'folder-one',
      ownershipConfirmed: false, observedAfterCreate: true }] };
}

test('directory recovery remains a readonly action after Undo or Accept', async () => {
  const f = createFlow(), run = await f.run(), calls = [];
  run.pendingDirectoryCleanup = pendingFolders(run);
  const before = { model: f.h.io.requests.length, page: f.trace.filter(item => item.kind === 'page').length };
  for (const terminal of [{ undoStatus: 'applied' }, { trackedChangeStatus: 'accepted' }]) {
    const ui = renderNotice(f, reportOf(run), { ...run, ...terminal }, { checkCreatedDirectories: async id => calls.push(id) });
    assert.equal(ui.snapshot().directoryCleanup.hidden, false);
    assert.match(ui.snapshot().directoryCleanup.text, /new\/nested/);
    assert.match(ui.snapshot().directoryCleanup.text, /Checking only reads their status/);
    await ui.clickDirectories();
  }
  assert.deepEqual(calls, [run.id, run.id]);
  assert.deepEqual({ model: f.h.io.requests.length, page: f.trace.filter(item => item.kind === 'page').length }, before);
});

test('directory paths are hidden for foreign scope, missing identity, fork, or unsafe paths', async () => {
  const f = createFlow(), run = await f.run(), pending = pendingFolders(run);
  for (const variant of [
    { ...run, pendingDirectoryCleanup: { ...pending, projectId: 'different-project' } },
    { ...run, pendingDirectoryCleanup: { ...pending, accountScopeId: 'different-account' } },
    { ...run, pendingDirectoryCleanup: { ...pending, runId: 'different-run' } },
    { ...run, forkSnapshot: true, pendingDirectoryCleanup: pending },
    { ...run, pendingDirectoryCleanup: { ...pending, directories: [{ ...pending.directories[0], path: '../other' }] } }
  ]) assert.equal(renderNotice(f, reportOf(run), variant).snapshot().directoryCleanup.hidden, true);
  f.c.cachedAccountScopeId = undefined;
  const missing = { ...run, pendingDirectoryCleanup: { ...pending, accountScopeId: undefined } };
  assert.equal(renderNotice(f, reportOf(run), missing).snapshot().directoryCleanup.hidden, true);
});

test('directory checks are disabled while busy and reject a changed scope after rendering', async () => {
  const f = createFlow(), run = await f.run(); run.pendingDirectoryCleanup = pendingFolders(run);
  let calls = 0; const options = { checkCreatedDirectories: async () => { calls++; } };
  f.c.currentRunView = { recordId: run.id };
  const busy = renderNotice(f, reportOf(run), run, options);
  assert.equal(busy.snapshot().directoryCleanup.disabled, true); await busy.clickDirectories();
  f.c.currentRunView = null;
  const changed = renderNotice(f, reportOf(run), run, options);
  f.c.cachedAccountScopeId = 'changed-account'; await changed.clickDirectories();
  assert.equal(calls, 0);
});

for (const confirm of [false, true]) {
  test('complete create/delete plan reaches terminal/report/recovery consumers: approve=' + confirm, async () => {
    const initial = { 'old.tex': 'Original source' };
    const f = createFlow({ initialFiles: initial, confirm,
      syncChanges: [create, { type: 'delete', path: 'old.tex' }] });
    const run = await f.run(), event = reportOf(run), projection = Settlement.projectRunSettlement(run);
    if (confirm) {
      assert.equal(run.status, 'failed', 'real delete I/O refusal keeps a partially applied plan failed');
      assert.notEqual(projection.primaryFailure.code, 'file_plan_confirmation_rejected');
      assert.equal(f.f.files.get('new.tex'), create.content);
      assert.equal(f.f.files.get('old.tex'), initial['old.tex']);
      assert.equal(run.settlement.documentEffect, 'changed');
      assert.equal(run.settlement.evidence.applied, 'partial');
      assert.ok(run.undoOperations.length, 'written sibling retains Undo');
      return;
    }
    assert.equal(run.status, 'failed', 'rejected plan never reports successful execution');
    assert.equal(event.status, 'failed');
    assert.equal(event.failure.code, 'file_plan_confirmation_rejected');
    assert.equal(event.failure.stage, 'preflight');
    assert.equal(event.failure.severity, 'blocked');
    assert.equal(event.failure.retryable, false);
    assert.equal(projection.primaryFailure.code, event.failure.code);
    const stored = await f.c.Modules.StorageDb.getRecord('sessions', f.c.state.activeSessionId);
    const storedRun = stored.runs.find(item => item.id === run.id);
    assert.equal(storedRun.status, 'failed');
    assert.equal(reportOf(storedRun).status, 'failed');
    assert.equal(Settlement.projectRunSettlement(storedRun).primaryFailure.code, event.failure.code);
    assert.equal(run.settlement.documentEffect, 'unchanged');
    assert.equal(f.trace.some(item => item.kind === 'page' && item.method === 'applyOperations'), false);
    assert.equal(f.f.files.get('old.tex'), initial['old.tex']);
    assert.equal(f.f.files.has('new.tex'), false);
    assert.equal(run.retryWriteback, undefined);
    assert.equal(run.saveCheck, undefined);
    assert.deepEqual(run.undoOperations || [], []);
    const rendered = renderNotice(f, event, run).snapshot();
    assert.match(rendered.notices[0].text, /complete file plan was cancelled/i);
    assert.equal(rendered.buttons.length, 0, 'rejection offers no automatic retry action');
    assert.equal(rendered.toolbar['sync-retry'].hidden, true);
    const before = f.trace.length;
    await f.retry();
    assert.equal(f.trace.length, before, 'rejected plan retains no replay payload');
  });
}

test('normal zero-operation model result stays completed without a refusal failure', async () => {
  const f = createFlow({ syncChanges: [] }), run = await f.run();
  assert.equal(run.status, 'completed');
  assert.equal(reportOf(run).status, 'completed');
  assert.equal(reportOf(run).failure, undefined);
  assert.equal(Settlement.projectRunSettlement(run).primaryFailure, null);
  assert.equal(f.trace.some(item => item.kind === 'page' && item.method === 'applyOperations'), false);
});
