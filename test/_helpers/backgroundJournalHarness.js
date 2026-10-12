'use strict';
// Complete background and ActiveTurnControl modules. Only Chrome IO, Native
// ports, clocks and unrelated updater scheduling are synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..');
const source = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const SessionState = require('../../extension/src/shared/sessionState');
const Queue = require('../../extension/src/shared/runInputQueue');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const prefix = 'codex-overleaf:run-journal:';
const sender = { id: 'extension-id', documentId: 'fixture-document', frameId: 0,
  url: 'https://www.overleaf.com/project/project-one', tab: { id: 101, url: 'https://www.overleaf.com/project/project-one' } };
function timers() {
  let sequence = 0; const pending = new Map();
  return { setTimeout(fn, ms) { const id = ++sequence; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    async fire(ms) { for (const [id, item] of [...pending]) if (item.ms === ms) { pending.delete(id); await item.fn(); } await flush(); },
    clear() { pending.clear(); } };
}
function memoryStorage() {
  const values = {}, trace = []; const runtimeOwners = []; let hold = null, readHold = null;
  return { values, trace, runtimeOwners,
    delayNextCompletion(predicate) { const gate = deferred(); hold = { predicate, gate, used: false }; return gate; },
    delayNextRead(predicate) { const gate = deferred(); readHold = { predicate, gate, used: false }; return gate; },
    async get(keys) {
      const result = keys === null ? clone(values) : Object.fromEntries((Array.isArray(keys) ? keys : [keys])
        .filter(k => Object.hasOwn(values,k)).map(k => [k,clone(values[k])]));
      if (readHold && !readHold.used && readHold.predicate(keys)) { readHold.used = true; await readHold.gate.promise; }
      return result;
    },
    async set(input) {
      // Commit in API invocation order, then delay completion. A later journal
      // snapshot still in the production Promise chain has NOT invoked set yet.
      const entry = Object.entries(input)[0];
      Object.assign(values, clone(input)); trace.push({ operation: 'set', key: entry?.[0], terminal: entry?.[1]?.terminal, events: entry?.[1]?.events?.length });
      if (hold && !hold.used && hold.predicate(input)) { hold.used = true; await hold.gate.promise; }
    },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) { delete values[key]; trace.push({ operation: 'remove', key }); } }
  };
}
function background(storage) {
  const listeners = [], connections = [], ports = [], forwarded = [], timer = timers();
  let uuid = 0, tick = Date.parse('2026-10-04T10:00:00.000Z');
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [tick++])); } static now() { return tick++; } }
  const chrome = { runtime: { id: 'extension-id', lastError: null,
    getURL: file => 'chrome-extension://extension-id/' + file, getManifest: () => JSON.parse(source('extension/manifest.json')),
    onMessage: { addListener: fn => listeners.push(fn) }, onConnect: { addListener: fn => connections.push(fn) },
    connectNative() {
      const message = [], disconnect = [];
      const port = { messages: [], onMessage: { addListener: fn => message.push(fn) }, onDisconnect: { addListener: fn => disconnect.push(fn) },
        postMessage(value) { this.messages.push(clone(value)); },
        emit(value) { for (const fn of message) fn(clone(value)); },
        disconnect() { chrome.runtime.lastError = { message: 'Synthetic Native transport disconnect' }; for (const fn of disconnect) fn(); chrome.runtime.lastError = null; } };
      ports.push(port); return port;
    } }, storage: { session: storage, local: memoryStorage(), onChanged: { addListener() {} } },
    tabs: {
      async query() { return Array.from(new Map(storage.runtimeOwners.map(owner => [owner.sender.tab.id, owner.sender.tab])).values()); },
      sendMessage(tab, message, cb) {
        if (message.type === 'codex-overleaf/runtime-health-probe') return Promise.resolve({ ok: true, runOwnerProtocol: 1,
          runOwners: storage.runtimeOwners.filter(owner => owner.sender.tab.id === tab).flatMap(owner => [owner.read()].filter(Boolean)) });
        forwarded.push({ tab, message: clone(message) }); if (typeof cb === 'function') cb();
      }
    } };
  const context = vm.createContext({ chrome, URL, Date: Clock, console: { ...console, error: (...args) => { throw new Error('Unexpected background diagnostic: ' + args.join(' ')); } },
    CodexOverleafUpdateCoordinator: { init() {} }, // unrelated update scheduling is not part of this probe
    crypto: { randomUUID: () => 'fixture-uuid-' + (++uuid) },
    setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout,
    indexedDB: { open() { throw new Error('Unexpected unrelated IndexedDB access'); } },
    IDBKeyRange: { only() { throw new Error('Unexpected unrelated IndexedDB range'); } } });
  context.importScripts = (...files) => {
    for (const input of files) {
      const file = input.replace(/^chrome-extension:\/\/extension-id\/src\//, '');
      assert.match(file, /^[A-Za-z0-9_./-]+\.js$/); assert.equal(file.includes('..'), false);
      vm.runInContext(source('extension/src/' + file), context, { filename: file });
    }
  };
  vm.runInContext(source('extension/src/background.js'), context, { filename: 'background.js' });
  function send(message, actualSender = sender) {
    return new Promise(resolve => { for (const fn of listeners) fn(clone(message), actualSender, resolve); });
  }
  function connectOwner(actualSender = sender) {
    const serverMessages = [], serverDisconnect = [], clientDisconnect = [], clientMessages = [];
    const server = { name: 'codex-overleaf/run-owner', sender: actualSender,
      postMessage: value => clientMessages.forEach(fn => fn(clone(value))),
      onMessage: { addListener: fn => serverMessages.push(fn) }, onDisconnect: { addListener: fn => serverDisconnect.push(fn) } };
    for (const fn of connections) fn(server);
    return { postMessage: value => serverMessages.forEach(fn => fn(clone(value))),
      onMessage: { addListener: fn => clientMessages.push(fn) },
      onDisconnect: { addListener: fn => clientDisconnect.push(fn) },
      disconnect: () => serverDisconnect.forEach(fn => fn()),
      workerLost: () => clientDisconnect.forEach(fn => fn()) };
  }
  return { ports, timer, forwarded, send, connectOwner,
    registerOwnerHealth(actualSender, read) { storage.runtimeOwners.push({ sender: actualSender, read }); },
    pending: () => clone(context.CodexOverleafNativeBridge.getPendingState()),
    run(id, overrides = {}) { return send({ type: 'codex-overleaf/native-request', payload: { id, method: 'codex.run', params: {
      projectId: 'project-one', clientSessionId: 'session-one', clientRunId: 'client-' + id,
      task: 'Synthetic read-only fixture', mode: 'ask', ...overrides, nativeCompatibility: { status: 'ok', classification: 'compatible' }
    } } }); },
    list: () => send({ type: 'codex-overleaf/run-journal/list', projectKey: 'project-one' }),
    ack: id => send({ type: 'codex-overleaf/run-journal/ack', requestId: id }) };
}
function ownerClient(route, actualSender = sender) {
  const timer = timers(), ports = [];
  const ctx = vm.createContext({ setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout });
  vm.runInContext(source('extension/src/content/activeTurnControl.js'), ctx);
  const control = ctx.CodexOverleafActiveTurnControl.create({ chrome: { runtime: {
    connect() { const port = route.current.connectOwner(actualSender); ports.push(port); return port; },
    sendMessage: message => route.current.send(message)
  } } });
  route.current.registerOwnerHealth(actualSender, () => control.getOwner());
  return { control, ports, timer };
}
function recoveryOptions(id, shared = true) {
  const session = { id: 'session-one', projectId: 'project-one', accountScopeId: 'account-one',
    runs: [{ id: 'client-' + id, status: 'running', task: 'Synthetic task', runProjectId: 'project-one', startedAt: '2026-10-04T09:00:00.000Z', events: [] }],
    pendingInputs: Queue.enqueue([], { text: 'Queued next task' }, { randomUUID: () => 'q-one' }).queue };
  return { session, options: { projectKey: 'project-one', accountScopeId: 'account-one', requireOwnerLost: shared,
    findSession: value => value === session.id ? session : null,
    normalizeInterruptedRun: record => Object.assign(record, SessionState.normalizeRuns([record], { restoreRunningRuns: true })[0]),
    mapEvent: raw => ({ title: raw.title, status: raw.status, kind: 'activity', timestamp: raw.timestamp }),
    pauseSessionQueue: value => { value.pendingInputs = Queue.pauseAll(value.pendingInputs, 'page_reload'); } } };
}
function bind(client, id) { client.control.bind({ requestId: id, projectKey: 'project-one', clientRunId: 'client-' + id, sessionId: 'session-one' }); }
function event(bg, id) { bg.ports[0].emit({ id, event: { type: 'codex.turn.bound', title: 'Turn bound', status: 'running',
  timestamp: '2026-10-04T10:00:00.010Z', detail: { threadId: 'thread-one', turnId: 'turn-one' } } }); }

module.exports = { background, memoryStorage, ownerClient, recoveryOptions, bind, event, flush, prefix, sender };
