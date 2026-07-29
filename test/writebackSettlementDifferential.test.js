const assert = require('node:assert/strict');
const test = require('node:test');

const Settlement = require('../extension/src/shared/writebackSettlement');

const FIXTURES = Object.freeze([
  Object.freeze({
    name: 'unchanged completed run',
    run: Object.freeze({
      status: 'completed',
      changedDocument: false
    }),
    facts: Object.freeze({
      documentEffect: 'unchanged',
      evidence: Object.freeze({ settled: 'complete' })
    })
  }),
  Object.freeze({
    name: 'legacy editor-history undo remains actionable',
    run: Object.freeze({
      status: 'completed',
      changedDocument: true,
      undoOperations: Object.freeze([
        Object.freeze({ type: 'edit', path: 'main.tex' })
      ])
    }),
    facts: Object.freeze({
      documentEffect: 'changed',
      evidence: Object.freeze({ applied: 'complete', settled: 'complete' }),
      recoveryAvailability: Object.freeze({ editorHistory: true })
    })
  }),
  Object.freeze({
    name: 'pending tracked changes keep accept and undo',
    run: Object.freeze({
      status: 'completed',
      changedDocument: true,
      trackedChangeStatus: 'pending',
      undoTrackedChanges: Object.freeze([
        Object.freeze({ id: 'change-1', path: 'main.tex' })
      ]),
      undoExpectedFiles: Object.freeze([
        Object.freeze({ path: 'main.tex', content: 'before' })
      ])
    }),
    facts: Object.freeze({
      documentEffect: 'changed',
      evidence: Object.freeze({ applied: 'complete', settled: 'complete' }),
      recoveryAvailability: Object.freeze({
        trackedChanges: true,
        legacyBaseline: true
      })
    })
  }),
  Object.freeze({
    name: 'accepted tracked changes remain terminal',
    run: Object.freeze({
      status: 'completed',
      changedDocument: true,
      trackedChangeStatus: 'accepted',
      undoTrackedChanges: Object.freeze([]),
      undoExpectedFiles: Object.freeze([])
    }),
    facts: Object.freeze({
      documentEffect: 'changed',
      evidence: Object.freeze({ settled: 'complete' })
    })
  })
]);

function productProjection(value) {
  return {
    changedDocument: value.changedDocument,
    canAccept: value.canAccept,
    canUndo: value.canUndo,
    terminalState: value.terminalState,
    actions: value.actions
  };
}

for (const fixture of FIXTURES) {
  test(`legacy/new settlement differential: ${fixture.name}`, () => {
    const legacy = Settlement.deriveLegacyProjection(fixture.run);
    const canonical = Settlement.projectRunSettlement({
      ...fixture.run,
      settlement: fixture.facts
    });

    assert.deepEqual(productProjection(canonical), productProjection(legacy));
  });
}
