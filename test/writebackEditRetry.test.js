'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const SessionState = require('../extension/src/shared/sessionState');
const WritebackIntent = require('../extension/src/shared/writebackIntent');
const { extractFromContentScript } = require('./_helpers/contentScriptSource');

const owner = { projectId: 'p1', accountScopeId: 'acct', sessionId: 's1', runId: 'r1' };
const edit = { type: 'edit', path: 'Tex/Chap_05.tex', patches: [{ from: 0, to: 0, expected: '', insert: 'x' }] };
const openFailure = { ok: false, code: 'file_open_failed',
  failure: { code: 'target_file_open_failed', stage: 'navigation', changedDocument: false } };

function settleHarness(record) {
  const context = {
    Modules: { WritebackIntent, SessionState }, crypto: { randomUUID: () => 'retry-1' },
    findRunRecord: () => record, recoveryOwner: () => ({ ...owner }),
    writebackController: { buildSaveCheck: async () => null }, flushQueuedSaveState: async () => {}
  };
  return vm.runInNewContext('(' + extractFromContentScript('settleWritebackRecovery') + ')', context);
}

test('untouched edits that could not open their file become a persisted Retry sync intent', async () => {
  const record = { id: 'r1', runProjectId: 'p1', retryRequireReviewing: false };
  const settle = settleHarness(record);
  await settle({ applied: [{ operation: { type: 'edit', path: 'roadmap.md' }, result: { ok: true } }],
    skipped: [{ operation: edit, result: openFailure }] },
  { files: [{ path: 'Tex/Chap_05.tex', content: '' }, { path: 'roadmap.md', content: 'plan' }] },
  { state: 'verified_saved' }, {});
  assert.deepEqual(record.retryWriteback.operations.map(op => op.path), ['Tex/Chap_05.tex']);
  assert.deepEqual(record.retryWriteback.baseFiles, [{ path: 'Tex/Chap_05.tex', content: '' }],
    'the replay keeps the pre-image so the stale guard can refuse a changed document');
  assert.equal('retryRequireReviewing' in record, false);
  const persisted = SessionState.pickWritebackRecovery(JSON.parse(JSON.stringify(record)));
  assert.equal(persisted.retryWriteback.operations[0].type, 'edit');
});

test('edits that may have touched the document are never replayed automatically', async () => {
  const record = { id: 'r1', runProjectId: 'p1' };
  const settle = settleHarness(record);
  await settle({ applied: [], skipped: [{ operation: edit, result: { ok: false, failure: {
    code: 'write_observed_mismatch', stage: 'verify', changedDocument: true } } }] },
  { files: [{ path: 'Tex/Chap_05.tex', content: '' }] }, { state: 'not_checked' }, {});
  assert.equal(record.retryWriteback, undefined);
});

test('persisted edit retries require the pre-image of the file they patch', () => {
  const intent = { ...owner, id: 'i1', operations: [edit], baseFiles: [] };
  assert.equal(SessionState.pickWritebackRecovery({ id: 'r1', runProjectId: 'p1', retryWriteback: intent }).retryWriteback, undefined);
  const withBase = { ...intent, baseFiles: [{ path: edit.path, content: '' }] };
  assert.ok(SessionState.pickWritebackRecovery({ id: 'r1', runProjectId: 'p1', retryWriteback: withBase }).retryWriteback);
});

test('Retry sync replays edits as patch writes against the stored base files', () => {
  const body = extractFromContentScript('retryRunWriteback');
  assert.match(body, /op\.type === 'edit'\s*\n?\s*\? \{ type: 'write', path: op\.path, patches: op\.patches/);
  assert.match(body, /files: intent\.baseFiles/);
});

test('a successful Retry sync merges into the run settlement instead of replacing it with the envelope', () => {
  const Settlement = require('../extension/src/shared/writebackSettlement');
  const file = (path, applied, readBack, failureCodes = []) => ({ path, operationIds: [], relatedPaths: [], applied,
    documentEffect: 'changed', readBack, recoveryKind: 'none', failureCodes });
  const previous = { schemaVersion: 1, documentEffect: 'changed',
    evidence: { applied: 'partial', readBack: 'partial', saved: 'verified', mirrored: 'complete', compiled: 'failed', settled: 'needs-review' },
    fileSettlements: [file('roadmap.md', 'complete', 'exact'), file('tex_v1/Backmatter.tex', 'failed', 'unavailable', ['file_upload_unconfirmed'])],
    failures: [{ code: 'file_upload_unconfirmed', stage: 'verify', severity: 'warning', terminalState: 'needs_review', file: '', changedDocument: true }] };
  const op = { type: 'create', path: 'tex_v1/Backmatter.tex', content: 'x' };
  const retry = Settlement.settle({ operations: [op], applyResult: { ok: true, skipped: [],
    applied: [{ operation: op, result: { ok: true, verified: true, changedDocument: true } }] }, saveVerification: { state: 'verified_saved' } });
  assert.ok(retry.facts && !retry.facts.facts, 'settle() wraps facts in an envelope');
  const merged = Settlement.mergeRetrySettlement(previous, retry.facts);
  assert.deepEqual(merged.fileSettlements.map(entry => entry.path), ['roadmap.md', 'tex_v1/Backmatter.tex']);
  assert.equal(merged.fileSettlements[1].applied, 'complete');
  assert.deepEqual(merged.failures, []);
  assert.equal(merged.evidence.applied, 'complete');
  assert.equal(merged.evidence.settled, 'complete');
  assert.equal(merged.evidence.compiled, 'failed', 'evidence the retry did not re-check is kept');
  const body = extractFromContentScript('retryRunWriteback');
  assert.match(body, /mergeRetrySettlement\(live\(\)\.settlement, result\.settlement\.facts\)/);
});

test('an untouched delete with an unreadable server copy is staged for Retry sync with its pre-image', async () => {
  const record = { id: 'r1', runProjectId: 'p1', retryRequireReviewing: false };
  const settle = settleHarness(record);
  const del = { type: 'delete', path: 'tex_v1/Fig_old.tex' };
  await settle({ applied: [], skipped: [{ operation: del, result: { ok: false, code: 'source_zip_unavailable',
    failure: { code: 'source_zip_unavailable', stage: 'preflight', changedDocument: false } } }] },
  { files: [{ path: 'tex_v1/Fig_old.tex', content: '% fig' }] }, { state: 'not_checked' }, {});
  assert.deepEqual(record.retryWriteback.operations, [{ type: 'delete', path: 'tex_v1/Fig_old.tex' }]);
  assert.deepEqual(record.retryWriteback.baseFiles, [{ path: 'tex_v1/Fig_old.tex', content: '% fig' }]);
  const body = extractFromContentScript('retryRunWriteback');
  assert.match(body, /op\.type === 'delete' \? \{ type: 'delete', path: op\.path \}/);
});
