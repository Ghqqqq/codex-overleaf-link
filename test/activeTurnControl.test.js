const assert = require('node:assert/strict');
const test = require('node:test');
const ActiveTurnControl = require('../extension/src/content/activeTurnControl');

test('active turn owner binds the native request and exposes journal recovery', async () => {
  const posted = [];
  const port = {
    postMessage(message) { posted.push(message); },
    disconnect() {},
    onDisconnect: { addListener() {} }
  };
  const runtimeMessages = [];
  const control = ActiveTurnControl.create({
    chrome: {
      runtime: {
        connect() { return port; },
        async sendMessage(message) {
          runtimeMessages.push(message);
          if (message.type === 'codex-overleaf/run-journal/list') {
            return { ok: true, journals: [{ requestId: 'run-1' }] };
          }
          return { ok: true };
        }
      }
    }
  });

  control.bind({
    requestId: 'run-1',
    projectKey: 'project-1',
    clientRunId: 'turn-1',
    sessionId: 'session-1'
  });
  assert.equal(posted[0].type, 'bind');
  assert.equal(posted[0].requestId, 'run-1');
  assert.equal((await control.listJournals('project-1'))[0].requestId, 'run-1');
  await control.acknowledge('run-1');
  assert.deepEqual(runtimeMessages.map(message => message.type), [
    'codex-overleaf/run-journal/list',
    'codex-overleaf/run-journal/ack'
  ]);
});
