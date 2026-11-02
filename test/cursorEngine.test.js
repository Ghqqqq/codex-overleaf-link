'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setCursorCredential, getCursorCredentialStatus } = require('../native-host/src/cursorCredentialStore');
const { setCursorSdkFactoryForTests } = require('../native-host/src/cursorSessionRunner');
const { createCursorEventAdapter } = require('../native-host/src/cursorEventAdapter');
const { deriveCursorModelCapabilities } = require('../native-host/src/cursorContextWindows');
const { handleRequest } = require('../native-host/src/taskRunnerRuntime');
const { buildRuntimeFileManifest } = require('../native-host/src/runtimeInstaller');
const SessionState = require('../extension/src/shared/sessionState');
const ModelPickerSupport = require('../extension/src/content/modelPickerSupport');

test('cursor stream adapter merges deltas, maps thinking and tools, and reports usage', () => {
  const events = [];
  const adapter = createCursorEventAdapter({
    emit: event => events.push(event),
    threadId: 'agent-1',
    turnId: 'run-1',
    modelId: 'composer-2.5'
  });
  adapter.ingest({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } });
  adapter.ingest({ type: 'assistant', message: { content: [{ type: 'text', text: ' world' }] } });
  adapter.ingest({ type: 'thinking', text: 'plan' });
  adapter.ingest({ type: 'thinking', text: 'plan more', thinking_duration_ms: 12 });
  adapter.ingest({
    type: 'tool_call', call_id: 'c1', name: 'read', status: 'running', args: { path: 'main.tex' }
  });
  adapter.ingest({
    type: 'tool_call', call_id: 'c1', name: 'read', status: 'completed',
    args: { path: 'main.tex' }, result: { output: 'ok' }
  });
  adapter.ingest({
    type: 'tool_call', call_id: 'c1', name: 'read', status: 'completed',
    args: { path: 'main.tex' }
  });
  adapter.ingest({
    type: 'tool_call', call_id: 'c2', name: 'shell', status: 'completed',
    args: { command: 'ls' }, result: { output: 'a', exitCode: 0 }
  });
  adapter.ingest({
    type: 'tool_call', call_id: 'c3', name: 'edit', status: 'completed',
    args: { path: 'main.tex' }
  });
  adapter.ingest({
    type: 'usage',
    usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, totalTokens: 14 }
  });
  const finished = adapter.finish({ text: 'Hello world' });
  assert.equal(finished.assistantMessage, 'Hello world');
  const methods = events.map(event => event.detail?.method);
  const deltas = events.filter(event => event.detail?.method === 'item/agentMessage/delta');
  assert.equal(deltas.length, 2);
  assert.equal(deltas[0].detail.params.itemId, deltas[1].detail.params.itemId);
  assert.equal(deltas[0].detail.params.delta, 'Hello');
  assert.equal(deltas[1].detail.params.delta, ' world');
  assert.equal(events.some(event => event.detail?.method === 'item/reasoning/summaryTextDelta'), true);
  const tools = events.filter(event => event.detail?.params?.item?.type);
  assert.equal(tools.filter(event => event.detail.params.item.id === 'c1' && event.detail.method === 'item/completed').length, 1);
  assert.equal(tools.find(event => event.detail.params.item.id === 'c1').detail.params.item.type, 'commandExecution');
  assert.equal(tools.find(event => event.detail.params.item.id === 'c2').detail.params.item.type, 'commandExecution');
  assert.equal(tools.find(event => event.detail.params.item.id === 'c3').detail.params.item.type, 'fileChange');
  const usage = events.find(event => event.detail?.method === 'thread/tokenUsage/updated');
  assert.equal(usage.detail.params.tokenUsage.last.totalTokens, 14);
  assert.equal(usage.detail.params.tokenUsage.modelContextWindow, 200000);
  assert.ok(methods.includes('turn/started'));
  assert.ok(methods.includes('turn/completed'));
});

test('cursor engine writes through the shared mirror diff and keeps the key out of the result', async (t) => {
  process.env.CODEX_OVERLEAF_CURSOR_SDK_TEST = '1';
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-engine-'));
  const rootDir = path.join(home, 'mirrors');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = testEnv(home, rootDir);
  const secret = 'cursor_test_secret_value';
  assert.deepEqual(setCursorCredential({ apiKey: secret }, env), { configured: true });
  assert.deepEqual(getCursorCredentialStatus(env), { configured: true });
  const status = await handleRequest({ id: 'status', method: 'cursor.credential.get' }, env);
  assert.equal(status.ok, true);
  assert.equal(JSON.stringify(status).includes(secret), false);

  const calls = [];
  const deleted = [];
  setCursorSdkFactoryForTests(() => fakeSdk(calls, deleted));

  const project = {
    id: 'cursor-project',
    capabilities: { fullProjectSnapshot: true },
    files: [{ path: 'main.tex', content: 'before' }]
  };
  const events = [];
  const created = await handleRequest({
    id: 'run-auto',
    method: 'codex.run',
    params: {
      projectId: 'cursor-project',
      agentEngine: 'cursor',
      mode: 'auto',
      task: 'Replace the sentence',
      customInstructions: 'Keep theorems numbered.',
      locale: 'zh',
      project
    }
  }, env, event => events.push(event));
  assert.equal(created.ok, true, created.error?.message);
  assert.equal(created.result.assistantMessage, 'done');
  assert.equal(created.result.cursorAgentId, 'agent-1');
  assert.equal(created.result.syncChanges.some(change => change.path === 'main.tex'), true);
  assert.equal(JSON.stringify(created).includes(secret), false);
  assert.equal(calls[0].op, 'create');
  assert.equal(calls[0].model, 'auto');
  assert.match(calls[0].prompt, /Keep theorems numbered/);
  assert.match(calls[0].prompt, /Chinese \(zh\)/);
  assert.equal(events.some(event => event.type === 'cursor.runtime.selected'), true);
  assert.equal(events.some(event => event.type === 'codex.runtime.selected'), false);
  const bound = events.find(event => event.type === 'codex.turn.bound');
  assert.equal(bound?.detail?.agentEngine, 'cursor');
  assert.equal(bound?.detail?.threadId, 'agent-1');
  assert.equal(bound?.detail?.turnId, 'run-1');
  assert.equal(typeof bound?.detail?.steer, 'undefined');
  const deltas = events.filter(event => event.detail?.method === 'item/agentMessage/delta');
  assert.ok(deltas.length >= 1);
  assert.equal(new Set(deltas.map(event => event.detail.params.itemId)).size, 1);

  const asked = await handleRequest({
    id: 'run-ask',
    method: 'codex.run',
    params: {
      projectId: 'cursor-project',
      agentEngine: 'cursor',
      mode: 'ask',
      task: 'What is in the file?',
      skillInvocation: { id: 'annotated-rewrite', scope: 'codex-overleaf', title: 'Annotated rewrite' },
      project,
      cursorAgentId: 'agent-1'
    }
  }, env, () => {});
  assert.equal(asked.ok, true, asked.error?.message);
  assert.deepEqual(asked.result.syncChanges, []);
  assert.equal(calls[1].op, 'resume');
  assert.match(String(calls[1].prompt || ''), /annotated-rewrite|Selected Codex skill/i);
  assert.ok(calls[1].disallowedTools.includes('edit'));
  assert.equal(JSON.stringify(asked).includes(secret), false);

  const compacted = await handleRequest({
    id: 'run-compact',
    method: 'codex.run',
    params: {
      projectId: 'cursor-project',
      agentEngine: 'cursor',
      operation: 'compact',
      cursorAgentId: 'agent-1'
    }
  }, env, () => {});
  assert.equal(compacted.ok, true, compacted.error?.message);
  assert.equal(compacted.result.operation, 'compact');
  assert.equal(compacted.result.threadId, 'agent-1');
  assert.equal(calls.some(call => call.op === 'summarize'), true);

  const cleared = await handleRequest({
    id: 'clear-cursor',
    method: 'codex.history.clearPlugin',
    params: { sessionId: 'ses-1', cursorAgentId: 'agent-1', projectId: 'cursor-project' }
  }, env);
  assert.equal(cleared.ok, true, cleared.error?.message);
  assert.deepEqual(deleted, ['agent-1']);
  assert.equal(cleared.result.skipped, false);

  calls.length = 0;
  const codex = await handleRequest({
    id: 'run-default',
    method: 'codex.run',
    params: {
      projectId: 'cursor-project',
      mode: 'ask',
      task: 'Stay on Codex',
      project
    }
  }, env, () => {});
  assert.equal(codex.ok, false);
  assert.equal(calls.length, 0);
});

test('cursor catalog parameters become reasoning and fast choices', () => {
  const grok = deriveCursorModelCapabilities({
    id: 'grok-4.7',
    parameters: [
      { id: 'reasoning_effort', values: [{ value: 'low' }, { value: 'high' }, { value: 'xhigh' }] },
      { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] }
    ],
    variants: [
      { params: [{ id: 'fast', value: 'true' }] },
      { isMaxMode: true, params: [{ id: 'fast', value: 'true' }] }
    ]
  });
  assert.equal(grok.reasoningParamId, 'reasoning_effort');
  assert.deepEqual(grok.reasoningEfforts, ['low', 'high', 'xhigh']);
  assert.equal(grok.reasoningPresentation, 'effort');
  assert.deepEqual(grok.speedTiers, ['standard', 'fast']);
  assert.equal(grok.maxModeWhenFast, false);
  const opus = deriveCursorModelCapabilities({
    id: 'claude-opus-5-5',
    parameters: [{ id: 'effort', values: [{ value: 'high' }, { value: 'max' }] }, { id: 'fast', values: [{ value: 'true' }] }],
    variants: [{ isMaxMode: true, params: [{ id: 'fast', value: 'true' }] }]
  });
  assert.deepEqual(opus.reasoningEfforts, ['high', 'max']);
  assert.equal(opus.maxModeWhenFast, true);
  const composer = deriveCursorModelCapabilities({
    id: 'composer-2.5',
    parameters: [{ id: 'fast', values: [{ value: 'false' }, { value: 'true' }] }],
    variants: [{ isDefault: true, params: [{ id: 'fast', value: 'true' }] }]
  });
  assert.equal(composer.reasoningPresentation, 'none');
  assert.equal(composer.defaultSpeedTier, 'fast');
  assert.equal(ModelPickerSupport.speedChoiceVisible(['standard']), false);
  assert.equal(ModelPickerSupport.speedChoiceVisible(['standard', 'fast']), true);
  assert.equal(ModelPickerSupport.speedChoiceVisible(grok.speedTiers), true);
});

test('a stale cursor catalog is refreshed before the composer reads it', async () => {
  process.env.CODEX_OVERLEAF_CURSOR_SDK_TEST = '1';
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-catalog-'));
  const env = testEnv(home, path.join(home, 'mirrors'));
  fs.mkdirSync(path.join(home, '.codex-overleaf'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex-overleaf', 'cursor-model-cache.json'), JSON.stringify({
    customized: true,
    models: [{ id: 'grok-4.7', label: 'grok-4.7', enabled: true }]
  }));
  setCursorCredential({ apiKey: 'cursor_test_secret_value' }, env);
  let listed = 0;
  setCursorSdkFactoryForTests(() => ({
    Cursor: {
      models: {
        async list() {
          listed += 1;
          return [{
            id: 'grok-4.7',
            displayName: 'grok-4.7',
            parameters: [
              { id: 'reasoning_effort', values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
              { id: 'fast', values: [{ value: 'false' }, { value: 'true' }] }
            ],
            variants: [{ params: [{ id: 'fast', value: 'false' }, { id: 'reasoning_effort', value: 'high' }] }]
          }];
        }
      }
    }
  }));
  const first = await handleRequest({ id: 'models-1', method: 'codex.models', params: { agentEngine: 'cursor' } }, env);
  const model = first.result.models.find(item => item.id === 'grok-4.7');
  assert.equal(first.ok, true, first.error?.message);
  assert.deepEqual(model.reasoningEfforts, ['low', 'medium', 'high']);
  assert.equal(model.reasoningPresentation, 'effort');
  assert.deepEqual(model.speedTiers, ['standard', 'fast']);
  const second = await handleRequest({ id: 'models-2', method: 'codex.models', params: { agentEngine: 'cursor' } }, env);
  assert.equal(second.ok, true);
  assert.equal(listed, 1);
});

test('a new session keeps the Cursor engine and the last model for each engine', () => {
  const current = SessionState.normalizePanelState({
    agentEngine: 'cursor',
    model: 'grok-4.7',
    reasoningEffort: 'high',
    sessions: [{
      id: 'session_old',
      agentEngine: 'cursor',
      model: 'grok-4.7',
      cursorModel: 'grok-4.7',
      codexModel: 'gpt-5.4',
      task: 'Draft the introduction',
      runs: []
    }],
    activeSessionId: 'session_old'
  });
  const active = SessionState.getActiveSession(current);
  const created = SessionState.createSession({
    agentEngine: current.agentEngine,
    model: current.model,
    cursorModel: active.cursorModel,
    codexModel: active.codexModel,
    reasoningEffort: current.reasoningEffort
  });
  const next = SessionState.normalizePanelState({
    ...current,
    sessions: [...current.sessions, created],
    activeSessionId: created.id
  });
  const session = SessionState.getActiveSession(next);
  assert.equal(next.agentEngine, 'cursor');
  assert.equal(next.model, 'grok-4.7');
  assert.equal(session.cursorModel, 'grok-4.7');
  assert.equal(session.codexModel, 'gpt-5.4');
  assert.equal(session.cursorAgentId, '');
  const replaced = SessionState.deleteSession(current, active.id);
  assert.equal(replaced.agentEngine, 'cursor');
  assert.equal(SessionState.getActiveSession(replaced).cursorModel, 'grok-4.7');
  assert.equal(SessionState.getActiveSession(replaced).codexModel, 'gpt-5.4');
});

test('runtime manifest includes the Cursor SDK when it is installed', () => {
  const entries = buildRuntimeFileManifest({ packageRoot: path.join(__dirname, '..') });
  assert.equal(entries.some(entry => entry.relativePath === 'node_modules/@cursor/sdk/package.json'), true);
});

function testEnv(home, rootDir) {
  return {
    HOME: home,
    CODEX_OVERLEAF_MIRROR_ROOT: rootDir,
    CODEX_OVERLEAF_ENV_READY: '1',
    CODEX_OVERLEAF_CODEX_PATH: path.join(home, 'missing-codex'),
    CODEX_OVERLEAF_DISABLE_SHELL_ENV: '1'
  };
}

function fakeSdk(calls, deleted) {
  return {
    Agent: {
      async create(options) {
        calls.push({
          op: 'create',
          cwd: options.local.cwd,
          model: options.model.id,
          disallowedTools: options.disallowedTools || [],
          prompt: ''
        });
        return fakeAgent(options, 'agent-1', calls);
      },
      async resume(id, options) {
        calls.push({
          op: 'resume',
          id,
          cwd: options.local.cwd,
          disallowedTools: options.disallowedTools || [],
          prompt: ''
        });
        return fakeAgent(options, id, calls);
      },
      async delete(id) {
        deleted.push(id);
      }
    },
    Cursor: { models: { async list() { return [{ id: 'composer-2.5', label: 'Composer' }]; } } }
  };
}

function fakeAgent(options, agentId, calls) {
  return {
    agentId,
    async send(message) {
      const prompt = typeof message === 'string' ? message : String(message?.text || '');
      const last = calls[calls.length - 1];
      if (last) last.prompt = prompt;
      fs.writeFileSync(path.join(options.local.cwd, 'main.tex'), 'after');
      return fakeRun();
    },
    async summarize() {
      calls.push({ op: 'summarize', id: agentId });
      return fakeRun({ result: 'summarized' });
    },
    async [Symbol.asyncDispose]() {}
  };
}

function fakeRun(overrides = {}) {
  return {
    id: 'run-1',
    async *stream() {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } };
    },
    async wait() {
      return { status: 'finished', result: overrides.result || 'done', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } };
    },
    async steer() {
      return 'complete_delivered';
    },
    async cancel() {},
    supports() {
      return true;
    }
  };
}
