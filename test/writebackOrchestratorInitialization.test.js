const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '../extension/src/content/writebackOrchestrator.js'),
  'utf8'
);

test('writeback orchestrator initializes injected settlement dependencies in strict mode', () => {
  const windowObject = {};
  new Function('window', source)(windowObject);

  const onMirrorRefreshSettled = () => {};
  const writebackSettlement = {};
  let orchestrator;

  assert.doesNotThrow(() => {
    orchestrator = windowObject.CodexOverleafWritebackOrchestrator.create({
      onMirrorRefreshSettled,
      writebackSettlement
    });
  });
  assert.equal(typeof orchestrator.applySyncChangesToOverleaf, 'function');
  assert.equal(typeof orchestrator.resolveCompileLogContext, 'function');
});

test('governance-only rejection remains visible in the completion report', async () => {
  const windowObject = {};
  new Function('window', source)(windowObject);

  const operation = { type: 'edit', path: 'example/test2.tex' };
  const skippedEntry = {
    operation,
    result: {
      ok: false,
      code: 'governance_blocked',
      reason: 'Project governance marked this path read-only, so Codex did not write it.'
    }
  };
  let completionReport = null;

  const orchestrator = windowObject.CodexOverleafWritebackOrchestrator.create({
    tr: key => key,
    tx: english => english,
    appendRunEvent() {},
    appendChangeSummary() {},
    appendCompletionReport(input) {
      completionReport = input;
    },
    appendApplyResult() {},
    getState: () => ({ mode: 'auto', requireReviewing: true }),
    getAssistantAnswerForCurrentRun: () => 'Local edit completed.',
    cleanFinalAnswer: value => value,
    buildSyncApplyOperations: () => [operation],
    partitionUnsafeProjectPathOperations: operations => ({ safe: operations, skipped: [] }),
    evaluateGovernedOperations: () => ({
      allowed: [],
      blocked: [{ operation, reason: 'readonly' }]
    }),
    buildGovernanceSkippedApplyResult: () => ({
      ok: false,
      applied: [],
      skipped: [skippedEntry]
    }),
    getSkippedEntries: result => result.skipped,
    filterSyncChangesByOperations: () => [],
    formatWritebackSkippedNextStep: result => result.skipped.length
      ? 'Nothing was written in this run. Review the skipped reasons, fix them, and retry.'
      : '',
    summarizeOperationForAudit: () => ({ path: operation.path }),
    buildAuditSummaryFromApply: input => input,
    writebackSettlement: { settle: input => input }
  });

  const outcome = await orchestrator.applySyncChangesToOverleaf(
    [{ type: 'edit', path: operation.path }],
    {},
    { mode: 'auto', assistantMessage: 'Local edit completed.' }
  );

  assert.equal(outcome.hasSkippedOperations, true);
  assert.equal(completionReport.applyResults.length, 1);
  assert.deepEqual(completionReport.applyResults[0].skipped, [skippedEntry]);
  assert.equal(completionReport.unchangedReason, skippedEntry.result.reason);
  assert.match(completionReport.nextStep, /Review the skipped reasons/);
});
