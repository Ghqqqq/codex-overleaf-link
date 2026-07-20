const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runCodexSession } = require('../native-host/src/codexSessionRunner');
const { mapAgentEventToActivity } = require('../extension/src/shared/agentTranscript');

test('emits structured stream events for assistant message deltas', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-stream-'));
  const events = [];
  try {
    await runCodexSession({
      params: {
        projectId: 'stream-test',
        task: 'check main.tex',
        mode: 'ask',
        project: { files: [{ path: 'main.tex', content: '\\documentclass{article}' }] }
      },
      rootDir,
      emit: event => events.push(event),
      executeCodex: async ({ emit }) => {
        emit({
          type: 'codex.session.event',
          title: 'item/created',
          status: 'running',
          detail: {
            method: 'item/created',
            params: { item: { id: 'msg_1', type: 'agentMessage', role: 'assistant', text: '' } }
          }
        });
        emit({
          type: 'codex.session.event',
          title: 'item/agentMessage/delta',
          status: 'running',
          detail: {
            method: 'item/agentMessage/delta',
            params: { itemId: 'msg_1', delta: 'Hello ' }
          }
        });
        emit({
          type: 'codex.session.event',
          title: 'item/agentMessage/delta',
          status: 'running',
          detail: {
            method: 'item/agentMessage/delta',
            params: { itemId: 'msg_1', delta: 'world' }
          }
        });
        emit({
          type: 'codex.session.event',
          title: 'turn/completed',
          status: 'completed',
          detail: { method: 'turn/completed', params: {} }
        });
      }
    });

    const streamEvents = events.filter(e => e.type === 'codex.session.event' && e.detail?.method === 'item/agentMessage/delta');
    assert.equal(streamEvents.length, 2);
    assert.equal(streamEvents[0].detail.params.delta, 'Hello ');
    assert.equal(streamEvents[1].detail.params.delta, 'world');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('emits structured stream events for reasoning deltas', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-stream-'));
  const events = [];
  try {
    await runCodexSession({
      params: {
        projectId: 'stream-test-2',
        task: 'analyze',
        mode: 'ask',
        project: { files: [{ path: 'main.tex', content: 'content' }] }
      },
      rootDir,
      emit: event => events.push(event),
      executeCodex: async ({ emit }) => {
        emit({
          type: 'codex.session.event',
          title: 'item/reasoning/summaryTextDelta',
          status: 'running',
          detail: {
            method: 'item/reasoning/summaryTextDelta',
            params: { itemId: 'r_1', delta: 'Thinking about structure' }
          }
        });
        emit({
          type: 'codex.session.event',
          title: 'turn/completed',
          status: 'completed',
          detail: { method: 'turn/completed', params: {} }
        });
      }
    });

    const reasoningEvents = events.filter(e =>
      e.type === 'codex.session.event' && e.detail?.method === 'item/reasoning/summaryTextDelta'
    );
    assert.equal(reasoningEvents.length, 1);
    assert.equal(reasoningEvents[0].detail.params.delta, 'Thinking about structure');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('mapAgentEventToActivity returns stream kind for agentMessage delta', () => {
  const activity = mapAgentEventToActivity({
    type: 'codex.session.event',
    title: 'item/agentMessage/delta',
    status: 'running',
    detail: {
      method: 'item/agentMessage/delta',
      params: { itemId: 'msg_1', delta: 'Hello world' }
    }
  });

  assert.equal(activity.kind, 'stream');
  assert.equal(activity.visible, true);
  assert.equal(activity.streamRole, 'assistant');
  assert.equal(activity.appendText, true);
  assert.equal(activity.title, 'Hello world');
  assert.match(activity.streamKey, /agent:msg_1/);
});

test('mapAgentEventToActivity returns stream kind for reasoning summary delta', () => {
  const activity = mapAgentEventToActivity({
    type: 'codex.session.event',
    title: 'item/reasoning/summaryTextDelta',
    status: 'running',
    detail: {
      method: 'item/reasoning/summaryTextDelta',
      params: { itemId: 'r_1', delta: 'Considering options' }
    }
  });

  assert.equal(activity.kind, 'stream');
  assert.equal(activity.visible, true);
  assert.equal(activity.streamRole, 'reasoning');
  assert.equal(activity.appendText, true);
  assert.match(activity.streamKey, /reasoning:r_1/);
});

test('mapAgentEventToActivity returns completed activity for turn/completed', () => {
  const activity = mapAgentEventToActivity({
    type: 'codex.session.event',
    title: 'turn/completed',
    status: 'completed',
    detail: { method: 'turn/completed', params: {} }
  }, { locale: 'zh' });

  assert.equal(activity.kind, 'activity');
  assert.equal(activity.visible, true);
  assert.match(activity.title, /完成本地处理/);
  assert.equal(activity.status, 'completed');
});
