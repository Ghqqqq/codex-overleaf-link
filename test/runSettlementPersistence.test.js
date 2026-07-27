const assert = require('node:assert/strict');
const test = require('node:test');

const Adapter = require('../extension/src/content/runSettlementPersistence');
const Settlement = require('../extension/src/shared/writebackSettlement');

function createHarness() {
  const record = {
    id: 'run-1',
    status: 'completed',
    runProjectId: 'project-1'
  };
  let saveCount = 0;
  const adapter = Adapter.create({
    writebackSettlement: Settlement,
    getCurrentRunView: () => ({
      recordId: 'run-1',
      sessionId: 'session-1',
      runProjectId: 'project-1'
    }),
    findRunRecord: (recordId, sessionId) =>
      recordId === 'run-1' && sessionId === 'session-1' ? record : null,
    getCurrentProjectId: () => 'project-1',
    saveStateSoon: () => { saveCount++; }
  });
  return { adapter, record, getSaveCount: () => saveCount };
}

test('run settlement adapter applies canonical facts to the active run', () => {
  const harness = createHarness();
  harness.adapter.applyToCurrentRun(Settlement.settle({
    operations: [{ id: 'op-1', type: 'edit', path: 'main.tex' }],
    applyResult: {
      applied: [{
        operation: { id: 'op-1', type: 'edit', path: 'main.tex' },
        result: { ok: true, changedDocument: true }
      }],
      skipped: []
    }
  }));

  assert.equal(harness.record.settlement.documentEffect, 'changed');
  assert.equal('settlementFacts' in harness.record, false);
});

test('background mirror completion updates the same canonical settlement', () => {
  const harness = createHarness();
  harness.record.settlement = Settlement.compactSettlementFacts({
    documentEffect: 'changed',
    evidence: { mirrored: 'not-attempted', settled: 'complete' }
  });

  harness.adapter.settleMirrorRefresh({
    recordId: 'run-1',
    sessionId: 'session-1',
    runProjectId: 'project-1',
    state: 'complete'
  });

  assert.equal(harness.record.settlement.evidence.mirrored, 'complete');
  assert.equal(harness.getSaveCount(), 1);
});

test('mirror completion from another project cannot mutate the active project', () => {
  const harness = createHarness();
  harness.record.settlement = Settlement.compactSettlementFacts({
    documentEffect: 'changed',
    evidence: { mirrored: 'not-attempted', settled: 'complete' }
  });

  harness.adapter.settleMirrorRefresh({
    recordId: 'run-1',
    sessionId: 'session-1',
    runProjectId: 'project-2',
    state: 'complete'
  });

  assert.equal(harness.record.settlement.evidence.mirrored, 'not-attempted');
  assert.equal(harness.getSaveCount(), 0);
});
