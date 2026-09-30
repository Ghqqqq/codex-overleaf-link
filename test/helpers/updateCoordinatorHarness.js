const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const UPDATE_KEY = 'codex-overleaf-managed-update-state-v1';
const CONSENT_KEY = 'codex-overleaf-update-consent-v1';

async function createCoordinatorHarness(options = {}) {
  const version = '2.4.1';
  const data = { [UPDATE_KEY]: { state: 'idle', currentVersion: version, latestVersion: version }, [CONSENT_KEY]: {} };
  const events = [];
  let listener, rejectWrite = false, reloads = 0;
  const sandbox = vm.createContext({ URL, crypto, Date, setTimeout, clearTimeout, console,
    chrome: {
      runtime: { id: 'fixture', getManifest: () => ({ version }),
        getURL: value => 'chrome-extension://fixture/' + value,
        onMessage: { addListener(value) { listener = value; } },
        reload() { reloads += 1; } },
      storage: {
        local: {
          async get(keys) {
            return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])]));
          },
          async set(values) {
            if (rejectWrite) throw new Error('fixture storage unavailable');
            Object.assign(data, structuredClone(values));
            events.push({ type: 'write', values: structuredClone(values) });
          },
          async remove(key) { delete data[key]; }
        },
        session: { async get(key) { return { [key]: true }; }, async set() {} },
        onChanged: { addListener() {} }
      },
      alarms: { create() {}, async clear() {}, onAlarm: { addListener() {} } },
      action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
      tabs: { async query() { return []; }, async sendMessage() { return { idle: true, blockers: [] }; }, async reload() {} }
    }
  });
  for (const file of ['extension/bootstrap/updateStatus.js', 'extension/src/shared/managedUpdateProjection.js',
    'extension/src/shared/updateConsent.js', 'extension/src/shared/updateRevocationIntent.js',
    'extension/src/shared/updateRuntimeIdentity.js', 'extension/src/backgroundUpdateCoordinator.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../..', file), 'utf8'), sandbox, { filename: file });
  }
  sandbox.CodexOverleafUpdateCoordinator.init({ nativeBridge: {
    getPendingState: () => ({ executionRequests: 0 }),
    async requestInternal(request) {
      events.push({ type: 'native', method: request.method, params: structuredClone(request.params), state: structuredClone(data) });
      const response = await options.onNative?.(request, data);
      if (response !== undefined) return response;
      const result = request.method === 'update.status'
        ? { managed: true, activeVersion: version, runtimeVersion: version, installedAligned: true, transaction: null, authorization: null }
        : request.method === 'update.cancel' ? { state: 'cancelled', operationId: request.params.operationId }
        : request.method === 'update.check' ? { available: true, currentVersion: version, latestVersion: '2.4.2' }
        : request.method === 'update.canApply' ? { idle: true, blockers: [] } : {};
      return { ok: true, result };
    }
  } });
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  events.length = 0;
  return {
    data, events, UPDATE_KEY, CONSENT_KEY,
    seed(update, consent = {}) { data[UPDATE_KEY] = structuredClone(update); data[CONSENT_KEY] = structuredClone(consent); events.length = 0; },
    failWrites(value = true) { rejectWrite = value; },
    reloads: () => reloads,
    send(type) { return new Promise(resolve => {
      const handled = listener({ type }, { id: 'fixture', url: 'https://www.overleaf.com/project/example' }, resolve);
      if (!handled) resolve({ ok: false, error: { code: 'unhandled_action' } });
    }); }
  };
}

module.exports = { createCoordinatorHarness, UPDATE_KEY, CONSENT_KEY };
