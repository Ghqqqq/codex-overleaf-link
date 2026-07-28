const test = require('node:test');
const assert = require('node:assert/strict');

const Settlement = require('../extension/src/shared/writebackSettlement');

function utf8Bytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

test('normal writeback emits canonical evidence without duplicate status or projected actions', () => {
  const result = Settlement.settle({
    operations: [{ id: 'op-1', type: 'edit', path: 'main.tex', expected: 'before' }],
    applyResult: {
      applied: [{
        operation: { id: 'op-1', type: 'edit', path: 'main.tex', expected: 'before' },
        result: { ok: true, changedDocument: true }
      }],
      skipped: []
    },
    readbacks: [{ path: 'main.tex', state: 'match' }],
    saveVerification: { state: 'verified_quiet' },
    mirror: { state: 'complete' },
    compile: { state: 'succeeded' }
  });

  assert.equal(result.facts.documentEffect, 'changed');
  assert.equal(result.facts.evidence.applied, 'complete');
  assert.equal(result.facts.evidence.readBack, 'exact');
  assert.equal(result.facts.evidence.saved, 'quiet-observed');
  assert.equal(result.facts.evidence.mirrored, 'complete');
  assert.equal(result.facts.evidence.compiled, 'succeeded');
  assert.equal('primaryFailure' in result.facts, false);
  assert.equal('terminalState' in result.facts, false);
  assert.equal('actions' in result.facts, false);
});

test('possible mutation never projects changedDocument false', () => {
  const result = Settlement.settle({
    operations: [{ id: 'op-1', type: 'edit', path: 'main.tex' }],
    applyResult: {
      applied: [],
      skipped: [{
        operation: { id: 'op-1', type: 'edit', path: 'main.tex' },
        result: {
          ok: false,
          mayHaveMutated: true,
          code: 'cancelled_after_mutation'
        }
      }]
    }
  });
  const run = Settlement.applySettlementTransition({}, result);
  const projection = Settlement.projectRunSettlement(run);

  assert.equal(result.facts.documentEffect, 'possibly-changed');
  assert.equal(projection.changedDocument, null);
});

test('projection requires actual recovery payloads and terminal lifecycle states disable actions', () => {
  const facts = Settlement.compactSettlementFacts({
    documentEffect: 'changed',
    failures: [{
      code: 'accept_not_verified',
      stage: 'accept',
      severity: 'warning',
      userMessage: 'Review',
      retryable: true,
      terminalState: 'needs_review'
    }],
    recoveryAvailability: {
      trackedChanges: true,
      editorHistory: true,
      legacyBaseline: true
    }
  });
  const missingPayload = Settlement.projectRunSettlement({
    trackedChangeStatus: 'needs_review',
    settlementFacts: facts
  });
  assert.equal(missingPayload.canAccept, false);
  assert.equal(missingPayload.canUndo, false);
  assert.equal(missingPayload.canRetry, true);
  assert.equal(missingPayload.failureTerminalState, 'needs_review');

  const actionable = Settlement.projectRunSettlement({
    trackedChangeStatus: 'needs_review',
    settlementFacts: facts,
    undoTrackedChanges: [{ id: 'change-1' }],
    undoExpectedFiles: [{ path: 'main.tex', content: 'before' }]
  });
  assert.equal(actionable.canAccept, true);
  assert.equal(actionable.canUndo, true);

  for (const status of ['accepted', 'rejected']) {
    const terminal = Settlement.projectRunSettlement({
      trackedChangeStatus: status,
      settlementFacts: facts,
      undoTrackedChanges: [{ id: 'change-1' }],
      undoExpectedFiles: [{ path: 'main.tex', content: 'before' }]
    });
    assert.equal(terminal.canAccept, false);
    assert.equal(terminal.canUndo, false);
  }
});

test('top-level tracked-change failure cannot become terminal from a partial applied entry', () => {
  for (const kind of ['accept', 'reject']) {
    const run = {
      trackedChangeStatus: 'pending',
      undoTrackedChanges: [{ id: 'change-1', path: 'main.tex' }],
      undoExpectedFiles: [{ path: 'main.tex', content: 'before' }]
    };
    const settlement = Settlement.settleTrackedChangeLifecycle({
      kind,
      run,
      result: {
        ok: false,
        applied: [{
          trackedChange: { id: 'change-1', path: 'main.tex' },
          result: { ok: true, changedDocument: true }
        }],
        skipped: []
      }
    });
    const next = Settlement.applySettlementTransition(run, settlement);

    assert.equal(settlement.decision, 'needs_review');
    assert.equal(next.trackedChangeStatus, 'needs_review');
    assert.equal(next.undoTrackedChanges.length, 1);
    assert.equal(next.undoExpectedFiles.length, 1);
  }
});

test('settlement compaction keeps mandatory top-level facts under the per-run budget', () => {
  const facts = Settlement.compactSettlementFacts({
    documentEffect: 'changed',
    evidence: {
      applied: 'partial',
      readBack: 'mismatch',
      saved: 'failed',
      mirrored: 'partial',
      compiled: 'failed',
      settled: 'needs-review'
    },
    failures: Array.from({ length: 80 }, (_, index) => ({
      code: `failure-${index}`,
      stage: 'write',
      severity: 'warning',
      userMessage: 'x'.repeat(2000),
      nextAction: 'y'.repeat(2000),
      retryable: true,
      terminalState: 'needs_review'
    })),
    recoveryAvailability: {
      trackedChanges: true,
      editorHistory: true,
      legacyBaseline: true
    },
    fileSettlements: Array.from({ length: 300 }, (_, index) => ({
      path: `sections/file-${index}.tex`,
      documentEffect: index % 2 ? 'changed' : 'unchanged',
      recoveryKind: index % 5 === 0 ? 'tracked-changes' : 'none',
      failureCodes: index % 7 === 0 ? ['write_failed'] : []
    }))
  });

  assert.ok(utf8Bytes(facts) <= Settlement.SETTLEMENT_FACTS_MAX_BYTES);
  assert.equal(facts.documentEffect, 'changed');
  assert.equal(facts.evidence.readBack, 'mismatch');
  assert.equal(facts.recoveryAvailability.trackedChanges, true);
  assert.equal(facts.failures.length, 80);
  assert.ok(facts.compaction.omittedFileSettlements.changed >= 0);
});

test('settlement compaction keeps the primary failure within budget at the operation quota', () => {
  const facts = Settlement.compactSettlementFacts({
    documentEffect: 'possibly-changed',
    failures: Array.from({ length: 1000 }, (_, index) => ({
      code: index === 999 ? 'blocked-primary' : `warning-${index}`,
      stage: index === 999 ? 'native' : 'write',
      severity: index === 999 ? 'blocked' : 'warning',
      userMessage: 'x'.repeat(1000),
      nextAction: 'y'.repeat(1000),
      file: `sections/${'z'.repeat(250)}-${index}.tex`,
      operationType: 'edit',
      retryable: true,
      terminalState: index === 999 ? 'blocked' : 'needs_review'
    }))
  });

  assert.ok(utf8Bytes(facts) <= Settlement.SETTLEMENT_FACTS_MAX_BYTES);
  assert.equal(facts.failures[0].code, 'blocked-primary');
  assert.ok(facts.compaction.omittedFailures > 0);
});

test('post-navigation classification preserves the existing ordered outcomes', () => {
  assert.equal(Settlement.settlePostNavigation({ navigation: { occurred: false } }), null);
  assert.equal(Settlement.settlePostNavigation({
    navigation: { occurred: true, identityGuardFailed: true },
    runResult: { skipped: [] }
  }), 'abandoned_after_navigation');
  assert.equal(Settlement.settlePostNavigation({
    navigation: { occurred: true },
    runResult: {
      skipped: [{ result: { code: 'editor_project_id_unavailable' } }]
    }
  }), 'abandoned_after_navigation');
  assert.equal(Settlement.settlePostNavigation({
    navigation: { occurred: true },
    runResult: { skipped: [{ result: { code: 'write_failed' } }] }
  }), 'needs_review_after_navigation');
  assert.equal(Settlement.settlePostNavigation({
    navigation: { occurred: true },
    runResult: { skipped: [] }
  }), 'background_completed');
});

test('canonical settlement writes migrate the development-only settlementFacts alias', () => {
  const next = Settlement.applySettlementTransition({
    settlementFacts: {
      schemaVersion: 1,
      documentEffect: 'unchanged',
      evidence: { settled: 'complete' }
    }
  }, {
    facts: {
      schemaVersion: 1,
      documentEffect: 'changed',
      evidence: { mirrored: 'complete' }
    }
  });

  assert.equal(next.settlement.documentEffect, 'changed');
  assert.equal(next.settlement.evidence.mirrored, 'complete');
  assert.equal('settlementFacts' in next, false);
});
