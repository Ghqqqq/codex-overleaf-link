'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const {
  MAX_NATIVE_INPUT_MESSAGE_BYTES, MAX_NATIVE_OUTPUT_MESSAGE_BYTES,
  decodeFrames, encodeMessage
} = require('../native-host/src/nativeMessaging');
const { encodeOutputFrame } = require('../native-host/src/nativeTransportEnvelope');

test('Native framing preserves Unicode messages across complete and fragmented frames', () => {
  const first = { id: 'first', text: '正文🙂' }, second = { id: 'second', result: '' };
  const frame = encodeMessage(first), next = encodeMessage(second);
  assert.equal(frame.readUInt32LE(0), frame.length - 4);
  const read = decodeFrames(Buffer.concat([frame, next.subarray(0, 7)]));
  assert.deepEqual(read.messages, [first]);
  assert.deepEqual(decodeFrames(Buffer.concat([read.remainder, next.subarray(7)])).messages, [second]);
});

test('malformed and oversized frames fail before an invalid message reaches its consumer', () => {
  const payload = Buffer.from('not-json'), malformed = Buffer.alloc(4 + payload.length);
  malformed.writeUInt32LE(payload.length); payload.copy(malformed, 4);
  assert.throws(() => decodeFrames(malformed));
  const oversized = Buffer.alloc(4); oversized.writeUInt32LE(MAX_NATIVE_INPUT_MESSAGE_BYTES + 1);
  assert.throws(() => decodeFrames(oversized));
  assert.throws(() => encodeMessage({ value: 'x'.repeat(MAX_NATIVE_OUTPUT_MESSAGE_BYTES + 1) }));
});

test('an oversized response preserves request identity and reports failure in a receivable frame', () => {
  const frame = encodeOutputFrame({ id: 'request', ok: true,
    result: { payload: 'x'.repeat(MAX_NATIVE_OUTPUT_MESSAGE_BYTES + 1) } });
  assert.ok(frame.length <= MAX_NATIVE_OUTPUT_MESSAGE_BYTES + 4);
  const [response] = decodeFrames(frame).messages;
  assert.equal(response.id, 'request');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'native_response_too_large');
});

function clock() {
  let now = 0, nextId = 0;
  const timers = new Map();
  return {
    timers,
    setTimeout(fn, ms) {
      const id = ++nextId;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, timer] of timers) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    }
  };
}

test('Native UI deadlines settle once and ping expiry preserves active execution and mirror writes', async () => {
  const timing = clock(), ports = [];
  const context = {
    URL, console, crypto: require('node:crypto'), setTimeout: timing.setTimeout, clearTimeout: timing.clearTimeout,
    chrome: {
      runtime: {
        getManifest: () => ({ background: { service_worker: 'src/background.js' } }),
        onMessage: { addListener() {} }, onConnect: { addListener() {} },
        connectNative() {
          const port = { sent: [], disconnected: false,
            onMessage: { addListener(fn) { port.receive = fn; } },
            onDisconnect: { addListener(fn) { port.lost = fn; } },
            postMessage(message) { port.sent.push(message); },
            disconnect() { port.disconnected = true; port.lost(); } };
          ports.push(port);
          return port;
        }
      },
      storage: { session: { get: async () => ({}), set: async () => {} } }
    },
    CodexOverleafCompatibility: require('../extension/src/shared/compatibility'),
    CodexOverleafNativeRequestIdentity: require('../extension/src/shared/nativeRequestIdentity'),
    CodexOverleafGlobalPreferences: { installBackground() {} },
    CodexOverleafSharedSessionsBackground: { installBackground() {} },
    CodexOverleafBackgroundUpdateSafety: { create: () => ({}) },
    CodexOverleafUpdateCoordinator: { init() {} }
  };
  for (const name of ['ManagedUpdateProjection', 'StorageRunActions', 'SharedSessionTransfer',
    'UpdateRuntimeIdentity', 'BootstrapMigration', 'UpdateConsent', 'UpdateRevocation']) {
    context[`CodexOverleaf${name}`] = {};
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/src/background.js'), 'utf8'), context);
  const bridge = context.CodexOverleafNativeBridge;
  const send = (id, method) => bridge.requestInternal({ id, method, params: {} });
  const reads = ['mirror.status', 'codex.models', 'codex.providers.upsert'].map(method => send(method, method));
  const unboundedMethods = ['codex.run', 'codex.steer', 'codex.providers.test', 'codex.thread.fork',
    'task.run', 'task.confirm', 'codex.cancel', 'mirror.sync', 'mirror.patchFiles',
    'mirror.confirmWriteback', 'mirror.invalidate', 'mirror.scanSensitive'];
  const unbounded = unboundedMethods.map(method => send(method, method));
  timing.advance(59999);
  assert.equal(bridge.getPendingState().totalRequests, reads.length + unbounded.length);
  timing.advance(1);
  for (const response of await Promise.all(reads)) {
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'native_request_timeout');
  }
  assert.equal(bridge.getPendingState().totalRequests, unbounded.length);
  assert.equal(timing.timers.size, 0, 'execution and mirror preparation/writeback have no deadline');
  for (const method of unboundedMethods) ports[0].receive({ id: method, ok: true, result: {} });
  for (const response of await Promise.all(unbounded)) assert.equal(response.ok, true);
  for (const method of ['codex.run', 'mirror.sync']) {
    let settled = false;
    const active = send('active', method).then(response => {
      settled = true;
      return response;
    }, error => {
      settled = true;
      return { ok: false, error };
    });
    const busyPing = send('busy-ping', 'bridge.ping');
    const sent = ports[0].sent.length;
    timing.advance(20000);
    assert.equal((await busyPing).error.code, 'native_request_timeout');
    assert.equal(settled, false, `${method} must remain pending after a diagnostic timeout`);
    assert.equal(ports[0].disconnected, false);
    assert.equal(bridge.getPendingState().totalRequests, 1);
    assert.equal(timing.timers.size, 0);
    const read = send('during-work', 'mirror.status');
    assert.equal(ports.length, 1, 'the next request must reuse the active port');
    assert.equal(ports[0].sent.length, sent + 1, 'active work must not be replayed');
    ports[0].receive({ id: 'during-work', ok: true, result: {} });
    assert.equal((await read).ok, true);
    ports[0].receive({ id: 'active', ok: true, result: {} });
    assert.equal((await active).ok, true, 'the original operation must still consume its response');
  }
  const interrupted = send('interrupted', 'mirror.status').catch(error => error);
  const ping = send('ping', 'bridge.ping');
  const sent = ports[0].sent.length;
  timing.advance(19999);
  assert.equal(ports[0].disconnected, false);
  timing.advance(1);
  assert.equal((await ping).error.code, 'native_request_timeout');
  assert.equal((await interrupted).code, 'native_connection_failed');
  assert.equal(ports[0].disconnected, true);
  assert.equal(ports.length, 1, 'expiry must not reconnect or replay pending work');
  assert.equal(ports[0].sent.length, sent);
  assert.equal(bridge.getPendingState().totalRequests, 0);
  assert.equal(timing.timers.size, 0, 'retiring an idle port clears other read deadlines');
  const next = send('next', 'bridge.ping');
  ports[0].receive({ id: 'next', ok: true, result: 'late old port' });
  assert.equal(bridge.getPendingState().totalRequests, 1);
  ports[1].receive({ id: 'next', ok: true, result: 'new port' });
  assert.equal((await next).result, 'new port');
  assert.equal(timing.timers.size, 0, 'a normal response clears its deadline');
  const retried = send('retry', 'mirror.status');
  timing.advance(30000);
  ports[1].lost();
  assert.equal(ports[2].sent.length, 1, 'an actual disconnect retains the existing safe-read retry');
  timing.advance(30000);
  assert.equal((await retried).error.code, 'native_request_timeout');
  assert.equal(bridge.getPendingState().totalRequests, 0);
  assert.equal(timing.timers.size, 0);
});

test('fatal Native events quarantine before abort, await cleanup, and exit within a guarded deadline', async () => {
  for (const event of ['uncaughtException', 'unhandledRejection']) {
    for (const outcome of ['drained', 'deadline', 'reentrant']) {
      const timing = clock(), calls = [], host = new EventEmitter();
      let finish;
      const drained = new Promise(resolve => { finish = resolve; });
      Object.assign(host, { env: {}, stdin: new EventEmitter(), stdout: new EventEmitter(),
        exit: code => calls.push(['exit', code]) });
      const dependencies = {
        './nativeTransportEnvelope': { decodeInputFrames: decodeFrames, encodeOutputFrame },
        './debugLog': { logDebug() {} },
        './taskRunner': { handleRequest() {} },
        './taskRunnerRuntime': {
          quarantineActiveOperations() { calls.push('quarantine'); return []; },
          abortAllActiveOperations() { calls.push('abort'); return drained; }
        },
        './updateManager': {},
        './nativeEnvironment': { buildNativeRuntimeEnv: () => ({}), summarizeNativeEnvironment: () => ({}) }
      };
      vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../native-host/src/index.js'), 'utf8'), {
        Buffer, process: host, require: name => dependencies[name],
        setTimeout: timing.setTimeout, clearTimeout: timing.clearTimeout
      });
      host.emit(event, new Error('synthetic fatal error'));
      assert.deepEqual(calls, ['quarantine', 'abort']);
      assert.equal(host.exitCode, 1);
      if (outcome === 'drained') {
        finish();
        await new Promise(setImmediate);
        assert.deepEqual(calls.at(-1), ['exit', 1]);
        assert.equal(timing.timers.size, 0);
      } else if (outcome === 'deadline') {
        timing.advance(2999);
        assert.deepEqual(calls, ['quarantine', 'abort']);
        timing.advance(1);
        assert.deepEqual(calls.slice(-2), ['quarantine', ['exit', 1]]);
      } else {
        host.emit(event, new Error('second fatal error'));
        assert.deepEqual(calls, ['quarantine', 'abort', ['exit', 1]]);
      }
    }
  }
});
