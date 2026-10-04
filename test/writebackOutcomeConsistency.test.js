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
        if (warning) assert.match(warning.value, locale === 'zh' ? /文件夹.*未核验/ : /folder.*unknown/i);
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

test('retired recovery fields expose no new toolbar or review actions', async () => {
  const f = createFlow({ creatorOptions: { zipUnavailable: true } }), run = await f.run();
  run.writebackCheck = { v: 1, purpose: 'writeback-revalidation', files: [{ path: 'new.tex', absent: true }] };
  run.manualReviewProof = { v: 1, files: [{ path: 'new.tex' }] };
  const calls = [];
  const ui = renderNotice(f, reportOf(run), run, {
    checkWriteback: async () => calls.push('check'),
    openManualReviewFile: async () => calls.push('open-review'),
    verifyManualReview: async () => calls.push('verify-review'),
    checkCreatedDirectories: async () => calls.push('directories')
  });
  assert.equal(ui.snapshot().toolbar['sync-check'].hidden, true);
  assert.equal(ui.snapshot().toolbar['sync-retry'].hidden, false, 'the pre-existing create retry remains available');
  assert.equal(ui.snapshot().buttons.some(button => /manual-review|directory-cleanup/.test(button.recoveryFor)), false);
  await ui.clickCheck(); await ui.clickDirectories();
  assert.deepEqual(calls, []);
});

function pendingFolders(run) {
  return { v: 1, accountScopeId: 'account-one', projectId: 'example', sessionId: 'A', runId: run.id,
    directories: [{ v: 1, projectId: 'example', path: 'new/nested', nativeFolderId: 'folder-one',
      ownershipConfirmed: false, observedAfterCreate: true }] };
}

test('directory observations stay passive in existing Details after Undo or Accept', async () => {
  const f = createFlow(), run = await f.run(); run.pendingDirectoryCleanup = pendingFolders(run);
  const before = JSON.stringify(run);
  for (const terminal of [{ undoStatus: 'applied' }, { trackedChangeStatus: 'accepted' }]) {
    const ui = renderNotice(f, reportOf(run), { ...run, ...terminal });
    const snapshot = ui.snapshot();
    assert.equal(snapshot.directoryCleanup.hidden, true, 'no independent recovery card is rendered');
    assert.match(snapshot.text, /recorded these folders at completion/);
    assert.match(snapshot.text, /current status has not been rechecked/);
    assert.match(snapshot.text, /new\/nested/);
    assert.equal(snapshot.buttons.some(button => /director/.test(button.recoveryFor)), false);
  }
  assert.equal(JSON.stringify(run), before);
});

test('directory details do not project foreign scope, fork, or unsafe paths', async () => {
  const f = createFlow(), run = await f.run(), pending = pendingFolders(run);
  for (const variant of [
    { ...run, pendingDirectoryCleanup: { ...pending, projectId: 'different-project' } },
    { ...run, pendingDirectoryCleanup: { ...pending, accountScopeId: 'different-account' } },
    { ...run, pendingDirectoryCleanup: { ...pending, runId: 'different-run' } },
    { ...run, forkSnapshot: true, pendingDirectoryCleanup: pending },
    { ...run, pendingDirectoryCleanup: { ...pending, directories: [{ ...pending.directories[0], path: '../other' }] } }
  ]) assert.doesNotMatch(renderNotice(f, reportOf(run), variant).snapshot().text, /recorded these folders/);
});

for (const confirm of [false, true]) {
  test('create/delete changes retain the original separate delete confirmation: approve=' + confirm, async () => {
    const initial = { 'old.tex': 'Original source' };
    const f = createFlow({ initialFiles: initial, confirm,
      syncChanges: [create, { type: 'delete', path: 'old.tex' }] });
    const run = await f.run(), event = reportOf(run);
    assert.equal(f.f.files.get('new.tex'), create.content, 'approved create remains independent of a declined delete');
    assert.equal(f.f.files.get('old.tex'), initial['old.tex']);
    assert.notEqual(event.failure?.code, 'file_plan_confirmation_rejected');
    assert.ok(run.undoOperations.length, 'written files retain their original Undo');
    assert.equal(run.writebackCheck, undefined);
    if (!confirm) assert.ok(f.reportInputs.some(report => report.applyResults?.some(result => result.skipped?.some(entry => entry.operation?.path === 'old.tex' && entry.result?.code === 'delete_confirmation_rejected'))));
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

for (const locale of ['en', 'zh']) {
  test('directory-only retention omission does not imply lost Undo material: ' + locale, () => {
    const tx = (en, zh) => locale === 'zh' ? zh : en;
    const run = { undoOperations: [{ type: 'edit', path: 'main.tex', replaceAll: 'before' }],
      recoveryRetention: { state: 'omitted', reason: 'session-budget', directoryCleanup: true, coreRetained: true } };
    const rows = Results.projectCompletionMeta([{ key: 'undo', label: 'Undo', value: '1 undoable' }], run,
      { tx, isTrackedChangeLifecycleRun: () => false, projectRunSettlement: Settlement.projectRunSettlement });
    const notice = rows.find(row => row.key === 'recoveryRetention').value;
    assert.match(notice, locale === 'zh' ? /文件夹历史观测记录未保留/ : /folder observations were not retained/);
    assert.doesNotMatch(notice, locale === 'zh' ? /持久恢复材料未保留|历史恢复/ : /Persistent recovery data|history to recover/);
    const summary = Results.summarizeCompletionMeta(rows, run, { tx });
    assert.match(summary.facts.find(fact => fact.key === 'recoveryRetention').text, locale === 'zh' ? /文件夹观测/ : /Folder observations/);
    assert.equal(Settlement.projectRunSettlement(run).canUndo, true);
    assert.match(summary.facts.find(fact => fact.key === 'undo').text, /1/);
  });
}
