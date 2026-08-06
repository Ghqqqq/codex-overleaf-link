'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const SessionState = require('../extension/src/shared/sessionState');
const { create } = require('../extension/src/content/sessionForkController');

test('fork copies history through the selected turn and strips executable lifecycle payloads', async () => {
  let state = SessionState.normalizePanelState({
    sessions: [SessionState.createSession({
      title: 'Paper review', codexThreadId: 'thread-source',
      runs: [
        { id: 'run-1', task: 'one', status: 'completed', codexTurnId: 'turn-1', undoOperations: [{ type: 'edit' }] },
        { id: 'run-2', task: 'two', status: 'completed', codexTurnId: 'turn-2', undoTrackedChanges: [{ id: 'track' }] },
        { id: 'run-3', task: 'three', status: 'completed', codexTurnId: 'turn-3' }
      ]
    })]
  });
  const controller = create({
    SessionState,
    getState: () => state,
    setState: next => { state = next; },
    sendBackgroundNative: async request => ({ ok: true, result: { threadId: 'thread-forked', lastTurnId: request.params.lastTurnId } }),
    saveState: async () => {},
    applyStateToPanel: () => {},
    showPluginToast: () => {},
    tr: (key, values = {}) => key === 'forkSessionTitle' ? `${values.title} (fork)` : key
  });
  const forked = await controller.forkRunFromNode('run-2');
  assert.equal(forked.codexThreadId, 'thread-forked');
  assert.equal(forked.runs.length, 2);
  assert.equal(forked.runs.every(run => run.forkSnapshot), true);
  assert.deepEqual(forked.runs[0].undoOperations, []);
  assert.deepEqual(forked.runs[1].undoTrackedChanges, []);
  assert.equal(forked.forkedFromRunId, 'run-2');
});

