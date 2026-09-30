'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const Telemetry = require('../native-host/src/subagentTelemetry');
const Scope = require('../native-host/src/readProgressGuard');
const Subagents = require('../extension/src/shared/subagentActivityModel');

const ROOT = { threadId: 'parent-thread', turnId: 'parent-turn' };
const tick = () => new Promise(resolve => setImmediate(resolve));

// Minimal projection of the observed 0.158.0-alpha.2.1 SubAgentActivity
// rollout records onto its generated v2 schema. Not captured stdio frames.
// Test identities and text are synthetic; no private run data is embedded.
function activity(kind = 'started', childId = 'child-a', id = 'activity-' + kind, overrides = {}) {
  return {
    method: 'item/completed',
    params: {
      ...ROOT,
      item: { type: 'subAgentActivity', id, kind, agentThreadId: childId,
        agentPath: '/root/' + childId },
      ...overrides
    }
  };
}

function dispatch(childId = 'child-a', states = {}) {
  return { method: 'item/completed', params: { ...ROOT, item: {
    type: 'collabAgentToolCall', id: 'dispatch-' + childId,
    tool: 'spawnAgent', senderThreadId: ROOT.threadId, receiverThreadIds: [childId],
    status: 'completed', agentsStates: states
  } } };
}

function history(childId = 'child-a', status = 'inProgress', items = []) {
  return { thread: { id: childId, turns: [{ id: 'turn-' + childId, status, items }] } };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(read = (_method, params) => history(params.threadId)) {
  const events = [], requests = [], run = { status: 'running', subagents: [] };
  const scope = Scope.createRunEventScope(() => ROOT);
  let stopped = false;
  const observer = Telemetry.createNativeSubagentObserver({
    getRoot: () => ROOT, ownsParent: params => scope.owns(params), isStopped: () => stopped,
    emit(event) { events.push(event); Subagents.ingest(run, event); },
    request(method, params) {
      requests.push({ method, params });
      assert.equal(method, 'thread/read', 'observation must never resume or start a thread');
      return read(method, params);
    }
  });
  return { observer, events, requests, run, stop() { stopped = true; } };
}

test('native first started registers two running child records before history arrives', async t => {
  t.mock.method(Date, 'now', () => 0);
  const s = setup();
  t.after(() => s.observer.close());
  assert.equal(s.observer.observe(activity()), false, 'parent lifecycle notifications remain parent-owned');
  s.observer.observe(activity('started', 'child-b'));
  assert.equal(s.run.subagents.length, 2);
  assert.deepEqual(s.run.subagents.map(child => child.status), ['running', 'running']);
  assert.deepEqual(s.run.subagents.map(child => child.parentThreadId), [ROOT.threadId, ROOT.threadId]);
  assert.equal(s.run.subagents[0].title, 'Child a');
  await tick();
  assert.deepEqual(s.requests, ['child-a', 'child-b'].map(threadId => ({
    method: 'thread/read', params: { threadId, includeTurns: true }
  })));
  assert.equal(s.run.status, 'running');
});

test('outer item/completed with kind started does not complete the child', async t => {
  const s = setup();
  t.after(() => s.observer.close());
  s.observer.observe(activity());
  await tick();
  assert.equal(s.run.subagents[0].status, 'running');
  assert.equal(s.run.subagents[0].finishedAt, undefined);
});

test('completed dispatch without child terminal evidence stays pending', async t => {
  const s = setup();
  t.after(() => s.observer.close());
  s.observer.observe(dispatch());
  await tick();
  assert.equal(s.run.subagents.length, 1);
  assert.equal(s.run.subagents[0].status, 'pending');
  assert.equal(s.run.status, 'running');
});

test('first observed completed registers a child but waits for its actual outcome', async t => {
  const pending = deferred(), s = setup(() => pending.promise);
  t.after(() => s.observer.close());
  s.observer.observe(activity('completed'));
  assert.equal(s.run.subagents.length, 1);
  assert.equal(s.run.subagents[0].status, 'pending');
  await tick();
  pending.resolve(history('child-a', 'failed'));
  await tick();
  assert.equal(s.run.subagents[0].status, 'failed');
  assert.equal(s.run.status, 'running');
});

test('completion bypasses the history throttle and a shared ID retains distinct kinds', async t => {
  let now = 0, reads = 0;
  t.mock.method(Date, 'now', () => now);
  const s = setup(() => history('child-a', ++reads === 1 ? 'inProgress' : 'completed'));
  t.after(() => s.observer.close());
  s.observer.observe(activity('started', 'child-a', 'same-item'));
  await tick();
  assert.equal(s.requests.length, 1);
  now = 1;
  s.observer.observe(activity('completed', 'child-a', 'same-item'));
  await tick();
  assert.equal(s.requests.length, 2);
  assert.equal(s.run.subagents[0].status, 'completed');
});

test('interruption bypasses the history throttle without inferring successful completion', async t => {
  t.mock.method(Date, 'now', () => 100);
  let reads = 0;
  const s = setup(() => history('child-a', ++reads === 1 ? 'inProgress' : 'interrupted'));
  t.after(() => s.observer.close());
  s.observer.observe(activity());
  await tick();
  s.observer.observe(activity('interrupted'));
  await tick();
  assert.equal(s.requests.length, 2);
  assert.equal(s.run.subagents[0].status, 'cancelled');
});

test('terminal events during an in-flight read coalesce into one forced follow-up', async t => {
  const first = deferred();
  const s = setup((_method, params) => s.requests.length === 1
    ? first.promise : history(params.threadId, 'completed'));
  t.after(() => s.observer.close());
  s.observer.observe(activity());
  await tick();
  s.observer.observe(activity('completed'));
  s.observer.observe(activity('interrupted'));
  s.observer.observe(activity('completed'));
  assert.equal(s.requests.length, 1);
  first.resolve(history());
  await tick();
  assert.equal(s.requests.length, 2);
  assert.equal(s.run.subagents[0].status, 'completed');
});

test('duplicate native lifecycle delivery neither republishes nor rereads', async t => {
  let now = 100, complete = false;
  t.mock.method(Date, 'now', () => now);
  const s = setup(() => history('child-a', complete ? 'completed' : 'inProgress'));
  t.after(() => s.observer.close());
  const started = activity();
  s.observer.observe({ ...started, method: 'item/started' });
  await tick();
  const startedEvents = s.events.length;
  now = 5000;
  s.observer.observe(started);
  s.observer.observe(started);
  await tick();
  assert.equal(s.events.length, startedEvents);
  assert.equal(s.requests.length, 1);
  complete = true;
  const completed = activity('completed');
  s.observer.observe(completed);
  await tick();
  const completedEvents = s.events.length;
  now = 10000;
  s.observer.observe(completed);
  s.observer.observe(started);
  await tick();
  assert.equal(s.events.length, completedEvents);
  assert.equal(s.requests.length, 2);
  assert.equal(s.run.subagents.length, 1);
  assert.equal(s.run.subagents[0].status, 'completed');
});

test('repeated history snapshots do not duplicate child messages or terminal transitions', async t => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const item = { type: 'agentMessage', id: 'child-answer', phase: 'final_answer', text: 'Child answer' };
  const s = setup(() => history('child-a', 'completed', [item]));
  t.after(() => s.observer.close());
  s.observer.observe(activity());
  await tick();
  now = 2001;
  s.observer.observe(activity('interacted'));
  await tick();
  assert.equal(s.requests.length, 2);
  const messages = s.events.filter(event => event.detail.event?.detail.params?.item?.id === item.id);
  assert.equal(messages.length, 1);
  assert.equal(s.events.filter(event => event.type === 'codex.subagent.observed' && event.status === 'completed').length, 2,
    'one terminal transition plus one observed interaction, without a repeated terminal snapshot');
  assert.equal(s.run.subagents[0].events.filter(event => event.title === item.text).length, 1);
});

test('native and legacy discovery share one record for the same child', async t => {
  const s = setup();
  t.after(() => s.observer.close());
  s.observer.observe(dispatch());
  await tick();
  s.observer.observe(activity());
  await tick();
  assert.equal(s.run.subagents.length, 1);
  assert.equal(s.run.subagents[0].status, 'running');
  assert.equal(s.requests.length, 1);
});

test('foreign parents, stale turns, invalid child IDs and unknown activity kinds are rejected', async t => {
  const s = setup();
  t.after(() => s.observer.close());
  s.observer.observe(activity('started', 'child-a', 'a', { threadId: 'other-parent' }));
  s.observer.observe(activity('started', 'child-a', 'b', { turnId: 'old-turn' }));
  s.observer.observe(activity('started', 'child-a', 'c', { threadId: undefined, turnId: undefined }));
  for (const id of [ROOT.threadId, '../invalid', '', 'x'.repeat(161)]) {
    s.observer.observe(activity('started', id));
    s.observer.observe(dispatch(id));
  }
  s.observer.observe(activity('unrecognized'));
  await tick();
  assert.equal(s.events.length, 0);
  assert.equal(s.requests.length, 0);
  assert.equal(s.run.subagents.length, 0);
});

test('native registration retains the sixteen-child bound and sanitized labels', async t => {
  const s = setup();
  t.after(() => s.observer.close());
  for (let index = 0; index < 17; index++) {
    const frame = activity('started', 'child-' + index);
    frame.params.item.agentPath = '/Users/private/source.tex';
    frame.params.item.agentRole = 'Bearer abcdefghijklmnop';
    s.observer.observe(frame);
  }
  await tick();
  assert.equal(s.run.subagents.length, 16);
  assert.equal(s.requests.length, 16);
  assert.ok(s.run.subagents.every(child => child.title === 'Bearer [REDACTED_SECRET]'));
});

test('history cannot replay a different thread or the inherited parent turn', async t => {
  for (const result of [
    history('foreign-thread', 'completed'),
    { thread: { id: 'child-a', turns: [{ id: ROOT.turnId, status: 'completed',
      items: [{ type: 'agentMessage', id: 'parent-answer', text: 'Must not leak' }] }] } }
  ]) {
    const s = setup(() => result);
    t.after(() => s.observer.close());
    s.observer.observe(activity());
    await tick();
    assert.equal(s.run.subagents[0].status, 'running');
    assert.equal(s.events.filter(event => event.type === 'codex.subagent.event').length, 0);
  }
});

test('unsupported history preserves discovery and never fabricates child completion', async t => {
  const s = setup(() => Promise.reject(new Error('thread/read unsupported')));
  t.after(() => s.observer.close());
  s.observer.observe(activity());
  await tick();
  assert.equal(s.run.subagents[0].historyUnavailable, true);
  s.observer.observe(activity('completed'));
  await tick();
  assert.equal(s.requests.length, 1);
  assert.equal(s.run.subagents[0].status, 'running');
  s.run.status = 'completed';
  assert.equal(Subagents.effectiveStatus(s.run.subagents[0], s.run), 'unknown');
});

test('close before the scheduled read prevents any outbound history request', async () => {
  const s = setup();
  s.observer.observe(activity());
  const count = s.events.length;
  s.observer.close();
  assert.equal(s.observer.observe(activity('completed')), false);
  await tick();
  assert.equal(s.requests.length, 0);
  assert.equal(s.events.length, count);
});

for (const outcome of ['resolve', 'reject']) {
  test('late close ignores an in-flight ' + outcome + ' and drops the queued terminal refresh', async () => {
    const first = deferred(), s = setup(() => first.promise);
    s.observer.observe(activity());
    await tick();
    s.observer.observe(activity('completed'));
    const count = s.events.length;
    s.observer.close();
    if (outcome === 'resolve') first.resolve(history('child-a', 'completed',
      [{ type: 'agentMessage', id: 'late-answer', text: 'Must not arrive' }]));
    else first.reject(new Error('late failure'));
    await tick();
    assert.equal(s.requests.length, 1);
    assert.equal(s.events.length, count);
    assert.equal(s.run.subagents[0].status, 'running');
  });
}

test('a stopped owner prevents a scheduled read without requiring explicit close', async t => {
  const s = setup();
  t.after(() => s.observer.close());
  s.observer.observe(activity());
  s.stop();
  await tick();
  assert.equal(s.requests.length, 0);
  assert.equal(s.observer.observe(activity('completed')), false);
});

test('known child terminal and error messages stay in the child lane', async t => {
  const s = setup();
  t.after(() => s.observer.close());
  s.observer.observe(activity());
  await tick();
  const count = s.events.length;
  assert.equal(s.observer.observe({ method: 'error', params: {
    threadId: 'child-a', turnId: 'turn-child-a', error: { message: 'Child-only failure' }
  } }), true);
  assert.equal(s.observer.observe({ method: 'turn/completed', params: {
    threadId: 'child-a', turn: { id: 'turn-child-a', status: 'failed' }
  } }), true);
  assert.ok(s.events.slice(count).every(event => event.type === 'codex.subagent.event'));
  assert.equal(s.run.subagents[0].status, 'failed');
  assert.equal(s.run.status, 'running');
});

function runnerHarness() {
  const child = new EventEmitter(), events = [], requests = [], histories = new Map();
  const run = { status: 'running', subagents: [] };
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdout.setEncoding = child.stderr.setEncoding = () => {};
  child.kill = () => true;
  const push = message => child.stdout.emit('data', JSON.stringify(message) + '\n');
  child.stdin.write = line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    requests.push(request);
    const result = request.method === 'thread/start' ? { thread: { id: ROOT.threadId } }
      : request.method === 'turn/start' ? { turn: { id: ROOT.turnId } }
      : request.method === 'thread/read' ? (histories.get(request.params.threadId) || history(request.params.threadId)) : {};
    queueMicrotask(() => push({ id: request.id, result }));
  };
  const clock = () => ({ reset() {}, cancel() {} });
  const imports = {
    'node:child_process': { spawn: () => child }, 'node:fs': {}, 'node:path': path,
    '../../package.json': { version: 'subagent-protocol-test' },
    './codexHome': { buildCodexHomeEnv: env => env },
    './codexArgs': { buildCodexSpeedArgs: () => [] },
    './debugLog': { truncateText: (value, size) => String(value).slice(0, size) },
    './subagentTelemetry': Telemetry, './readProgressGuard': Scope,
    './codexCommand': { resolveCodexCommand: () => 'no-real-process', shouldUseShellForCommand: () => false },
    './codexProviderLaunch': {
      prepareProviderLaunch: async launch => ({ launch, close: async () => {} }),
      applyProviderEnvironment: env => env, buildProviderConfigArgs: () => []
    },
    './codexSessionTiming': {
      createOptionalTimeout: clock, createCodexIdleWatchdog: clock,
      parseOptionalPositiveInteger: () => 0, getAbortReason: () => new Error('aborted'),
      rejectPendingRequests(pending, error) { for (const request of pending.values()) request.reject(error); pending.clear(); },
      stopCodexAppServer: async () => {}, throwIfAborted() {}
    }
  };
  for (const name of ['mirrorWorkspace', 'diffEngine', 'selectionScope', 'writingStyleRuntime', 'codexModelRecovery',
    'textPatch', 'nativeTransportEnvelope', 'codexPromptAssembly', 'commandApproval', 'localSkills', 'subagentBroker',
    'nativeAssetTransfer', 'turnAttachments']) imports['./' + name] = {};
  const module = { exports: {} };
  const filename = path.join(__dirname, '../native-host/src/codexSessionRunner.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, process, console,
    require(id) { assert.ok(Object.hasOwn(imports, id), 'Unexpected dependency: ' + id); return imports[id]; },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Map, Set, Promise
  }, { filename });
  let settled = false;
  const done = module.exports.runCodexAppServerSession({
    task: 'Synthetic protocol replay', workspacePath: '/tmp', env: {},
    mode: 'ask', sandboxMode: 'read-only', approvalPolicy: 'never',
    model: 'gpt-6-luna', reasoningEffort: 'max',
    emit(event) { events.push(event); Subagents.ingest(run, event); }
  }).then(result => { settled = true; return result; });
  return { push, requests, events, histories, run, done, settled: () => settled };
}

test('runner routes native children separately and resolves only the root final answer', { timeout: 3000 }, async () => {
  const h = runnerHarness();
  await tick();
  for (const id of ['child-a', 'child-b']) h.push(activity('started', id));
  await tick();
  assert.equal(h.run.subagents.length, 2);
  assert.ok(h.run.subagents.every(child => child.status === 'running'));
  h.push({ method: 'turn/completed', params: {
    threadId: 'child-a', turn: { id: ROOT.turnId, status: 'completed',
      items: [{ type: 'agentMessage', id: 'child-only', phase: 'final_answer', text: 'CHILD_ONLY' }] }
  } });
  h.push({ method: 'error', params: { threadId: 'child-b', error: { message: 'Child error' } } });
  h.push({ method: 'turn/completed', params: { threadId: 'unrelated-child',
    turn: { id: ROOT.turnId, status: 'completed' } } });
  await tick();
  assert.equal(h.settled(), false, 'neither known nor unknown children can settle the parent');
  for (const id of ['child-a', 'child-b']) {
    h.histories.set(id, history(id, 'completed'));
    h.push(activity('completed', id));
  }
  await tick();
  assert.equal(h.requests.filter(request => request.method === 'thread/read').length, 4);
  assert.ok(h.run.subagents.every(child => child.status === 'completed'));
  assert.equal(h.settled(), false);
  assert.equal(h.events.some(event => event.type === 'codex.session.event' &&
    ['child-a', 'child-b', 'unrelated-child'].includes(event.detail.params.threadId)), false);
  h.push({ method: 'turn/completed', params: { threadId: ROOT.threadId, turn: {
    id: ROOT.turnId, status: 'completed',
    items: [{ type: 'agentMessage', id: 'root-final', phase: 'final_answer', text: 'ROOT_ONLY' }]
  } } });
  const result = await h.done;
  assert.equal(result.assistantMessage, 'ROOT_ONLY');
  assert.equal(result.threadId, ROOT.threadId);
});

test('logical task paths produce friendly names without exposing the namespace', async t => {
  const s = setup();
  t.after(() => s.observer.close());
  const first = activity();
  first.params.item.agentPath = '/root/first_five_lines';
  s.observer.observe(first);
  const second = activity('started', 'child-b');
  second.params.item.agentPath = '/root/bibliography_count';
  s.observer.observe(second);
  await tick();
  assert.deepEqual(s.run.subagents.map(child => child.title), ['First five lines', 'Bibliography count']);
  assert.ok(s.events.every(event => !event.detail.title.includes('/root/')));
});

test('unconfirmed agent paths use a safe fallback, never a filesystem basename', async t => {
  const s = setup();
  t.after(() => s.observer.close());
  const paths = ['/Users/private/secret.tex', '/root/group/name', '/root/private.tex',
    '/root/../private', '/root/', 'C:\\Users\\private\\secret.tex', '\\\\server\\share\\secret.tex',
    'file:///Users/private/secret.tex', '~/private/secret.tex', 'Bearer abcdefghijklmnop'];
  for (let index = 0; index < paths.length; index++) {
    const frame = activity('started', 'safe-' + index);
    frame.params.item.agentPath = paths[index];
    s.observer.observe(frame);
  }
  await tick();
  assert.deepEqual(s.run.subagents.map(child => child.title), paths.map((_value, index) => 'Agent safe-' + index));
  assert.ok(s.events.every(event => !event.title.includes('private') && !event.title.includes('secret.tex')));
});

test('unsafe role paths cannot bypass the safe title fallback', async t => {
  const s = setup();
  t.after(() => s.observer.close());
  const frame = dispatch();
  frame.params.item.agentRole = 'Inspect /Users/private/secret.tex';
  s.observer.observe(frame);
  await tick();
  assert.equal(s.run.subagents[0].title, 'Agent child-a');
});

test('native discovery improves a legacy fallback title while keeping one record', async t => {
  const s = setup();
  t.after(() => s.observer.close());
  s.observer.observe(dispatch());
  await tick();
  assert.equal(s.run.subagents[0].title, 'Agent child-a');
  const frame = activity();
  frame.params.item.agentPath = '/root/first_five_lines';
  s.observer.observe(frame);
  assert.equal(s.run.subagents.length, 1);
  assert.equal(s.run.subagents[0].title, 'First five lines');
});

test('thread/read recovers only the child user task and publishes a metadata update', async t => {
  const pending = deferred(), s = setup(() => pending.promise);
  t.after(() => s.observer.close());
  s.observer.observe(activity());
  assert.equal(s.run.subagents[0].task, '');
  await tick();
  const parentInput = { type: 'userMessage', id: 'parent-input',
    content: [{ type: 'text', text: 'Entire parent task' }] };
  const childInput = { type: 'userMessage', id: 'child-input', content: [
    { type: 'text', text: 'Read the first five lines of main.tex.', text_elements: [] },
    { type: 'text', text: 'Do not edit any file.', text_elements: [] }
  ] };
  const result = history('child-a', 'inProgress', [childInput]);
  result.thread.turns.unshift({ id: ROOT.turnId, status: 'completed', items: [parentInput] });
  pending.resolve(result);
  await tick();
  assert.equal(s.run.subagents[0].task, 'Read the first five lines of main.tex.\nDo not edit any file.');
  assert.equal(s.events.filter(event => event.type === 'codex.subagent.observed' && event.detail.task).length, 1);
  assert.equal(s.requests.length, 1, 'metadata recovery must not add polling');
  assert.equal(s.run.subagents[0].status, 'running');
});

test('later guidance and repeated snapshots do not replace the original delegated task', async t => {
  let now = 0, text = 'Initial delegated task';
  t.mock.method(Date, 'now', () => now);
  const s = setup(() => history('child-a', 'inProgress', [
    { type: 'userMessage', id: 'input', content: [{ type: 'text', text }] }
  ]));
  t.after(() => s.observer.close());
  s.observer.observe(activity());
  await tick();
  text = 'Later guidance';
  now = 2001;
  s.observer.observe(activity('interacted'));
  await tick();
  assert.equal(s.run.subagents[0].task, 'Initial delegated task');
  assert.equal(s.events.filter(event => event.type === 'codex.subagent.observed').length, 3,
    'initial discovery, one metadata update, one interaction');
});

test('live child user input also populates the task without exposing raw content', async t => {
  const s = setup();
  t.after(() => s.observer.close());
  s.observer.observe(activity());
  await tick();
  assert.equal(s.observer.observe({ method: 'item/completed', params: {
    threadId: 'child-a', turnId: 'turn-child-a',
    item: { type: 'userMessage', id: 'live-input', content: [{ type: 'text', text: 'Count bibliography entries.' }] }
  } }), true);
  assert.equal(s.run.subagents[0].task, 'Count bibliography entries.');
  const itemEvent = s.events.find(event => event.detail.event?.detail.params?.item?.id === 'live-input');
  assert.equal(Object.hasOwn(itemEvent.detail.event.detail.params.item, 'content'), false);
});

test('task recovery ignores encrypted payloads, parent wrappers and environment inputs', async t => {
  const items = [
    { type: 'userMessage', id: 'environment', content: [{ type: 'text',
      text: '<environment_context><cwd>/Users/private/project</cwd></environment_context>' }] },
    { type: 'userMessage', id: 'parent-wrapper', content: [{ type: 'text',
      text: 'Same Codex Overleaf session context:\nEntire parent request.' }] },
    { type: 'userMessage', id: 'instructions', content: [{ type: 'text',
      text: '<user_instructions>Rules, not a task</user_instructions>' }] },
    { type: 'userMessage', id: 'encrypted', content: [
      { type: 'text', text: 'Message Type: NEW_TASK\nTask name: /root/first_five_lines\nPayload:\n' },
      { type: 'encrypted_content', encrypted_content: 'gAAAA' + 'A'.repeat(80) }
    ] },
    { type: 'userMessage', id: 'encrypted-string', content: [{ type: 'text', text: 'gAAAA' + 'A'.repeat(80) }] },
    { type: 'agentMessage', id: 'answer', text: 'An answer must not become the assignment.' }
  ];
  const s = setup(() => history('child-a', 'completed', items));
  t.after(() => s.observer.close());
  s.observer.observe(activity());
  await tick();
  assert.equal(s.run.subagents[0].task, '');
  assert.equal(s.run.subagents[0].status, 'completed');
  assert.ok(s.events.every(event => event.detail.task === ''));
});

test('a real child task is recoverable after non-task input wrappers', async t => {
  const s = setup(() => history('child-a', 'inProgress', [
    { type: 'userMessage', id: 'environment', content: [{ type: 'text', text: '<environment_context>Workspace</environment_context>' }] },
    { type: 'userMessage', id: 'header', content: [{ type: 'text', text: 'Message Type: NEW_TASK\nPayload:\n' }] },
    { type: 'userMessage', id: 'actual-task', content: [{ type: 'text', text: 'Inspect main.tex without changes.' }] }
  ]));
  t.after(() => s.observer.close());
  s.observer.observe(activity());
  await tick();
  assert.equal(s.run.subagents[0].task, 'Inspect main.tex without changes.');
});

test('both dispatch and recovered task metadata redact secrets and local paths and stay bounded', async t => {
  const text = 'Read "/Users/private folder/input.tex", C:\\Users\\private\\input.tex, '
    + '\\\\private-server\\share\\input.tex and file:///tmp/input.tex. '
    + 'Keep main.tex project-relative. Authorization: Bearer abcdefghijklmnop. ' + 'x'.repeat(5000);
  for (const source of ['dispatch', 'history']) {
    const s = setup(() => history('child-a', 'inProgress', [
      { type: 'userMessage', id: 'task', content: [{ type: 'text', text }] }
    ]));
    t.after(() => s.observer.close());
    if (source === 'dispatch') {
      const frame = dispatch();
      frame.params.item.prompt = text;
      s.observer.observe(frame);
    } else s.observer.observe(activity());
    await tick();
    const task = s.run.subagents[0].task;
    assert.equal(task.length, 4096);
    assert.match(task, /\[local path\]/);
    assert.match(task, /main\.tex project-relative/);
    assert.doesNotMatch(task, /private|input\.tex|abcdefghijklmnop|file:\/\//);
  }
});

test('encrypted legacy prompt strings remain unavailable', async t => {
  const s = setup();
  t.after(() => s.observer.close());
  const frame = dispatch();
  frame.params.item.prompt = 'gAAAA' + 'A'.repeat(80);
  s.observer.observe(frame);
  await tick();
  assert.equal(s.run.subagents[0].task, '');
});

test('a history response naming another parent cannot contribute metadata or terminal state', async t => {
  const result = history('child-a', 'completed', [{ type: 'userMessage', id: 'foreign-input',
    content: [{ type: 'text', text: 'Another parent task' }] }]);
  result.thread.parentThreadId = 'other-parent';
  const s = setup(() => result);
  t.after(() => s.observer.close());
  s.observer.observe(activity());
  await tick();
  assert.equal(s.run.subagents[0].task, '');
  assert.equal(s.run.subagents[0].status, 'running');
  assert.equal(s.events.length, 1);
});

test('active interrupted history never produces a false cancelled preview before completion', async t => {
  let terminal = false;
  const s = setup(() => history('child-a', terminal ? 'completed' : 'interrupted'));
  t.after(() => s.observer.close());
  s.observer.observe(activity());
  await tick();
  assert.equal(s.run.subagents[0].status, 'running');
  terminal = true;
  s.observer.observe(activity('completed'));
  await tick();
  assert.equal(s.run.subagents[0].status, 'completed');
  assert.equal(s.events.some(event => event.status === 'cancelled'), false);
  assert.equal(s.run.status, 'running');
});

test('shutdown is thread liveness, not a task cancellation or a terminal override', async t => {
  for (const initial of ['pending', 'completed', 'failed', 'cancelled']) {
    const s = setup(() => ({ thread: { id: 'child-a', turns: [] } }));
    t.after(() => s.observer.close());
    const status = { completed: 'completed', failed: 'errored', cancelled: 'interrupted' }[initial];
    s.observer.observe(dispatch('child-a', status ? { 'child-a': { status } } : {}));
    await tick();
    s.observer.observe(dispatch('child-a', { 'child-a': { status: 'shutdown' } }));
    await tick();
    assert.equal(s.run.subagents[0].status, initial);
  }
});

for (const [direct, stale, expected] of [
  ['completed', 'interrupted', 'completed'],
  ['interrupted', 'completed', 'cancelled'],
  ['failed', 'completed', 'failed']
]) {
  test('direct ' + direct + ' outranks a late ' + stale + ' history snapshot', async t => {
    const pending = deferred(), s = setup(() => pending.promise);
    t.after(() => s.observer.close());
    s.observer.observe(activity());
    await tick();
    assert.equal(s.observer.observe({ method: 'turn/completed', params: {
      threadId: 'child-a', turn: { id: 'turn-child-a', status: direct }
    } }), true);
    pending.resolve(history('child-a', stale));
    await tick();
    assert.equal(s.run.subagents[0].status, expected);
    assert.equal(s.run.status, 'running');
  });
}

test('direct terminal evidence can correct an earlier history-only outcome', async t => {
  const s = setup(() => history('child-a', 'completed'));
  t.after(() => s.observer.close());
  s.observer.observe(activity());
  await tick();
  assert.equal(s.run.subagents[0].status, 'completed');
  s.observer.observe({ method: 'turn/completed', params: {
    threadId: 'child-a', turn: { id: 'turn-child-a', status: 'interrupted' }
  } });
  assert.equal(s.run.subagents[0].status, 'cancelled');
});

test('weaker legacy state cannot overwrite a direct outcome or its recorded answer', async t => {
  const s = setup();
  t.after(() => s.observer.close());
  s.observer.observe(activity());
  await tick();
  s.observer.observe({ method: 'turn/completed', params: {
    threadId: 'child-a', turn: { id: 'turn-child-a', status: 'completed' }
  } });
  s.observer.observe(dispatch('child-a', { 'child-a': { status: 'interrupted', message: 'Stale cancellation summary' } }));
  await tick();
  assert.equal(s.run.subagents[0].status, 'completed');
  assert.equal(s.run.subagents[0].events.some(event => event.title.includes('Stale cancellation summary')), false);
});

test('a new child turn rejects old history metadata and old terminal replays', async t => {
  const pending = deferred(), s = setup(() => pending.promise);
  t.after(() => s.observer.close());
  s.observer.observe(activity());
  await tick();
  s.observer.observe({ method: 'turn/completed', params: {
    threadId: 'child-a', turn: { id: 'turn-child-a', status: 'interrupted' }
  } });
  s.observer.observe({ method: 'turn/started', params: {
    threadId: 'child-a', turn: { id: 'new-child-turn', status: 'inProgress' }
  } });
  assert.equal(s.run.subagents[0].status, 'running');
  pending.resolve(history('child-a', 'completed', [{ type: 'userMessage', id: 'old-input',
    content: [{ type: 'text', text: 'Stale task from the retired turn' }] }]));
  await tick();
  for (const method of ['turn/completed', 'turn/started']) {
    assert.equal(s.observer.observe({ method, params: {
      threadId: 'child-a', turn: { id: 'turn-child-a', status: 'completed' }
    } }), true);
  }
  assert.equal(s.run.subagents[0].status, 'running');
  assert.equal(s.run.subagents[0].task, '');
  s.observer.observe({ method: 'turn/completed', params: {
    threadId: 'child-a', turn: { id: 'new-child-turn', status: 'completed' }
  } });
  assert.equal(s.run.subagents[0].status, 'completed');
});

test('late duplicate turn/started cannot revive a terminal child', async t => {
  const s = setup(() => history('child-a', 'completed'));
  t.after(() => s.observer.close());
  s.observer.observe(activity());
  await tick();
  const count = s.events.length;
  s.observer.observe({ method: 'turn/started', params: {
    threadId: 'child-a', turn: { id: 'turn-child-a', status: 'inProgress' }
  } });
  assert.equal(s.run.subagents[0].status, 'completed');
  assert.equal(s.events.length, count);
});

test('close discards a late task metadata response as well as its terminal state', async () => {
  const pending = deferred(), s = setup(() => pending.promise);
  s.observer.observe(activity());
  await tick();
  const count = s.events.length;
  s.observer.close();
  pending.resolve(history('child-a', 'completed', [{ type: 'userMessage', id: 'late-input',
    content: [{ type: 'text', text: 'Late metadata must not arrive' }] }]));
  await tick();
  assert.equal(s.events.length, count);
  assert.equal(s.run.subagents[0].task, '');
  assert.equal(s.run.subagents[0].status, 'running');
});
