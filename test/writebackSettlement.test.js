const assert = require('node:assert/strict');
const test = require('node:test');

const Settlement = require('../extension/src/shared/writebackSettlement');
const SettlementFacts = require('../extension/src/shared/settlementFacts');

test('verified_quiet stays quiet-observed and never becomes verified_saved', () => {
  assert.deepEqual(Settlement.normalizeSaveEvidence({ ok: true, state: 'verified_quiet' }), {
    state: 'verified_quiet',
    confidence: 'quiet-observed'
  });
  assert.deepEqual(Settlement.normalizeSaveEvidence({ ok: true }), {
    state: 'verified_quiet',
    confidence: 'quiet-observed'
  });
});

test('possible mutation prevents a cancelled write from claiming unchanged', () => {
  const result = Settlement.settle({
    operations: [{ id: 'op-1', type: 'edit', path: 'main.tex' }],
    applyResult: {
      applied: [],
      skipped: [{
        operation: { id: 'op-1', type: 'edit', path: 'main.tex' },
        result: { ok: false, code: 'codex_cancelled', mayHaveMutated: true }
      }]
    }
  });
  assert.equal(result.facts.documentEffect, 'possibly-changed');
  assert.equal(result.facts.fileSettlements[0].documentEffect, 'possibly-changed');
  assert.equal(
    Settlement.projectRunSettlement(
      Settlement.applySettlementTransition({}, result)
    ).changedDocument,
    null
  );
});

test('page-side verification is projected into readback facts without duplicate orchestration', () => {
  const exact = Settlement.settle({
    operations: [{ id: 'op-1', type: 'edit', path: 'main.tex' }],
    applyResult: {
      applied: [{
        operation: { id: 'op-1', type: 'edit', path: 'main.tex' },
        result: { ok: true, changedDocument: true, verified: true, verifiedContent: 'after' }
      }],
      skipped: []
    }
  });
  assert.equal(exact.facts.evidence.readBack, 'exact');
  assert.equal(exact.facts.fileSettlements[0].readBack, 'exact');

  const mismatch = Settlement.settle({
    operations: [{ id: 'op-1', type: 'edit', path: 'main.tex' }],
    applyResult: {
      applied: [],
      skipped: [{
        operation: { id: 'op-1', type: 'edit', path: 'main.tex' },
        result: {
          ok: false,
          code: 'write_observed_mismatch',
          changedDocument: true
        }
      }]
    }
  });
  assert.equal(mismatch.facts.evidence.readBack, 'mismatch');
  assert.equal(mismatch.facts.evidence.settled, 'needs-review');
});

test('in-flight mirror work does not introduce a new persisted settlement state', () => {
  const result = Settlement.settle({ mirror: { state: 'pending' } });
  assert.equal(result.facts.evidence.mirrored, 'not-attempted');
});

test('save failures and unavailable state remain distinguishable from not attempted', () => {
  assert.equal(Settlement.normalizeSaveEvidence({ ok: false, state: 'unknown_timeout' }).confidence, 'failed');
  assert.equal(Settlement.normalizeSaveEvidence({ ok: false, state: 'unavailable' }).confidence, 'unavailable');
  assert.equal(Settlement.normalizeSaveEvidence({}).confidence, 'not-attempted');
});

test('missing results for planned operations settle as needs review', () => {
  const result = Settlement.settle({
    operations: [
      { id: 'one', type: 'edit', path: 'main.tex' },
      { id: 'two', type: 'edit', path: 'refs.bib' }
    ],
    applyResult: {
      applied: [{
        operation: { id: 'one', type: 'edit', path: 'main.tex' },
        result: { ok: true, changedDocument: true }
      }],
      skipped: []
    }
  });
  assert.equal(result.facts.evidence.applied, 'partial');
  assert.equal(result.facts.evidence.settled, 'needs-review');
  assert.equal(result.facts.failures[0].code, 'write_result_missing');
  assert.equal(result.facts.fileSettlements.find(file => file.path === 'refs.bib').applied, 'failed');
});

test('tracked-change success clears only refs and expected files', () => {
  const run = {
    trackedChangeStatus: 'pending',
    appliedOperations: [{ type: 'edit', path: 'main.tex' }],
    undoOperations: [{ type: 'edit', path: 'main.tex' }],
    undoBaseFiles: [{ path: 'main.tex', content: 'old' }],
    undoTrackedChanges: [{ key: 'a', path: 'main.tex' }],
    undoExpectedFiles: [{ path: 'main.tex', content: 'old' }],
    undoStatus: ''
  };
  const settlement = Settlement.settleTrackedChangeLifecycle({
    kind: 'accept',
    run,
    result: { ok: true, applied: [] }
  });
  const next = Settlement.applySettlementTransition(run, settlement);
  assert.equal(next.trackedChangeStatus, 'accepted');
  assert.deepEqual(next.undoTrackedChanges, []);
  assert.deepEqual(next.undoExpectedFiles, []);
  assert.deepEqual(next.appliedOperations, run.appliedOperations);
  assert.deepEqual(next.undoOperations, run.undoOperations);
  assert.deepEqual(next.undoBaseFiles, run.undoBaseFiles);
  assert.equal(next.undoStatus, '');
});

test('blocked lifecycle result preserves the actionable state', () => {
  const result = {
    ok: false,
    skipped: [{
      operation: { type: 'accept', path: 'main.tex' },
      result: {
        ok: false,
        failure: {
          code: 'editor_project_id_unavailable',
          stage: 'accept',
          severity: 'blocked',
          userMessage: 'blocked',
          retryable: true,
          nextAction: 'Retry after the editor is ready.',
          terminalState: 'blocked'
        }
      }
    }]
  };
  const settlement = Settlement.settleTrackedChangeLifecycle({ kind: 'accept', result });
  assert.equal(settlement.decision, 'blocked');
  assert.deepEqual(settlement.statePatch, {});
});

test('post-navigation ordering keeps same-project normal and guard failures abandoned', () => {
  assert.equal(Settlement.settlePostNavigation({
    navigation: { occurred: false },
    runResult: { hasSkippedOperations: true }
  }), null);
  assert.equal(Settlement.settlePostNavigation({
    navigation: { occurred: true, identityGuardFailed: true },
    runResult: { hasSkippedOperations: false }
  }), 'abandoned_after_navigation');
  assert.equal(Settlement.settlePostNavigation({
    navigation: { occurred: true },
    runResult: {
      applied: {
        skipped: [{ result: { code: 'aborted_project_changed' } }]
      }
    }
  }), 'abandoned_after_navigation');
  assert.equal(Settlement.settlePostNavigation({
    navigation: { occurred: true },
    runResult: { hasSkippedOperations: true }
  }), 'needs_review_after_navigation');
  assert.equal(Settlement.settlePostNavigation({
    navigation: { occurred: true },
    runResult: { hasSkippedOperations: false, applied: { applied: [], skipped: [] } }
  }), 'background_completed');
});

test('settlement fact compaction is deterministic and idempotent', () => {
  const facts = {
    changedDocument: true,
    fileSettlements: Array.from({ length: 100 }, (_, index) => ({
      path: `file-${String(index).padStart(3, '0')}.tex`,
      documentEffect: index % 3 === 0 ? 'changed' : 'unchanged',
      failureCodes: index % 17 === 0 ? ['write_observed_mismatch'] : [],
      detail: 'x'.repeat(300)
    }))
  };
  const once = Settlement.compactSettlementFacts(facts, 4096);
  const twice = Settlement.compactSettlementFacts(once, 4096);
  assert.equal(JSON.stringify(once), JSON.stringify(twice));
});

test('session settlement compaction protects active facts and preserves source values', () => {
  const file = (path, documentEffect, failureCodes = []) => ({
    path,
    documentEffect,
    failureCodes,
    detail: 'x'.repeat(100)
  });
  const runs = [{
    id: 'settled-old',
    status: 'completed',
    settlement: {
      fileSettlements: [
        file('c-unknown.tex', 'unknown'),
        file('b-changed.tex', 'changed'),
        file('a-failed.tex', 'unchanged', ['write_failed'])
      ]
    }
  }, {
    id: 'active',
    status: 'running',
    settlement: {
      fileSettlements: [file('active.tex', 'changed')]
    }
  }];
  const source = JSON.stringify(runs);
  const compacted = SettlementFacts.compactSessionSettlementFacts(runs, {
    maxDetailBytes: 1,
    estimateBytes: value => JSON.stringify(value).length
  });

  assert.equal(JSON.stringify(runs), source);
  assert.equal(compacted.get('settled-old').fileSettlements.length, 0);
  assert.equal(compacted.get('active').fileSettlements.length, 0);
  assert.deepEqual(compacted.get('settled-old').compaction.omittedFileSettlements, {
    failureOrRecovery: 1,
    changed: 1,
    unchangedOrUnknown: 1
  });
});

test('tracked lifecycle reducer matches the retained success-first policy matrix', () => {
  const cases = [
    [{ ok: true, applied: [], skipped: [] }, 'accepted'],
    [{ ok: false, applied: [{ result: { ok: true } }], skipped: [] }, 'accepted'],
    [{
      ok: false,
      applied: [{ result: { ok: true } }],
      skipped: [{
        result: {
          ok: false,
          failure: {
            code: 'accept_not_verified',
            stage: 'accept',
            severity: 'warning',
            userMessage: 'review',
            retryable: true,
            nextAction: 'Review the tracked changes before continuing.',
            terminalState: 'needs_review'
          }
        }
      }]
    }, 'accepted'],
    [{
      ok: false,
      applied: {
        applied: [{ result: { ok: true } }],
        skipped: [{
          result: {
            ok: false,
            failure: {
              code: 'accept_not_verified',
              stage: 'accept',
              severity: 'warning',
              userMessage: 'review',
              retryable: true,
              nextAction: 'Review the tracked changes before continuing.',
              terminalState: 'needs_review'
            }
          }
        }]
      }
    }, 'accepted'],
    [{
      ok: false,
      applied: {
        applied: [],
        skipped: [{
          result: {
            ok: false,
            failure: {
              code: 'accept_not_verified',
              stage: 'accept',
              severity: 'warning',
              userMessage: 'review',
              retryable: true,
              nextAction: 'Review the tracked changes before continuing.',
              terminalState: 'needs_review'
            }
          }
        }]
      }
    }, 'needs_review'],
    [{
      ok: false,
      applied: [],
      skipped: [{
        result: {
          ok: false,
          failure: {
            code: 'accept_not_verified',
            stage: 'accept',
            severity: 'warning',
            userMessage: 'review',
            retryable: true,
            nextAction: 'Review the tracked changes before continuing.',
            terminalState: 'needs_review'
          }
        }
      }]
    }, 'needs_review']
  ];
  for (const [result, expected] of cases) {
    assert.equal(
      Settlement.settleTrackedChangeLifecycle({ kind: 'accept', result }).decision,
      expected
    );
  }
});

test('tracked lifecycle retains the mature terminal policy for empty and generic evidence', () => {
  assert.equal(
    Settlement.settleTrackedChangeLifecycle({ kind: 'accept', result: {} }).decision,
    'accepted'
  );
  assert.equal(
    Settlement.settleTrackedChangeLifecycle({ kind: 'reject', result: {} }).decision,
    'rejected'
  );
  assert.equal(
    Settlement.settleTrackedChangeLifecycle({
      kind: 'accept',
      result: {
        ok: false,
        applied: [],
        skipped: [{
          result: {
            ok: false,
            failure: {
              code: 'navigation_timeout',
              stage: 'navigation',
              severity: 'warning',
              userMessage: 'Navigation took too long.',
              retryable: true,
              nextAction: 'Retry.',
              terminalState: 'degraded'
            }
          }
        }]
      }
    }).decision,
    'accepted'
  );
});

test('tracked lifecycle keeps nested failures as evidence without overturning a successful action', () => {
  const settlement = Settlement.settleTrackedChangeLifecycle({
    kind: 'accept',
    result: {
      ok: false,
      applied: {
        applied: [{ trackedChange: { path: 'main.tex' }, result: { ok: true } }],
        skipped: [{
          trackedChange: { path: 'refs.bib' },
          result: {
            ok: false,
            failure: {
              code: 'accept_not_verified',
              stage: 'accept',
              severity: 'warning',
              userMessage: 'Review refs.bib.',
              retryable: true,
              nextAction: 'Review the tracked changes before continuing.',
              terminalState: 'needs_review'
            }
          }
        }]
      }
    }
  });

  assert.equal(settlement.decision, 'accepted');
  assert.equal(settlement.facts.failures.length, 1);
  assert.equal(settlement.facts.failures[0].code, 'accept_not_verified');
});

test('legacy undo terminal state is projected through the settlement reducer', () => {
  const run = {
    id: 'run-legacy-undo',
    undoStatus: 'running',
    undoOperations: [{ type: 'edit', path: 'main.tex' }]
  };
  const next = Settlement.applySettlementTransition(
    run,
    Settlement.settleLegacyUndo({ run, status: 'applied' })
  );

  assert.equal(next.undoStatus, 'applied');
  assert.equal(next.settlement.evidence.settled, 'complete');
  assert.deepEqual(next.undoOperations, run.undoOperations);
});

test('post-navigation status is projected through the settlement reducer', () => {
  const next = Settlement.applySettlementTransition(
    { id: 'run-background', status: 'running' },
    Settlement.transitionPostNavigationStatus({
      status: 'background_completed',
      statusText: 'Completed in background',
      finishedAt: '2026-07-26T13:00:00.000Z'
    })
  );

  assert.equal(next.status, 'background_completed');
  assert.equal(next.statusText, 'Completed in background');
  assert.equal(next.finishedAt, '2026-07-26T13:00:00.000Z');
});
