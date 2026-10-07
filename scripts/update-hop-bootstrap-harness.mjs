import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function chromeStoredValue(value) {
  if (Array.isArray(value)) return value.map(chromeStoredValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, chromeStoredValue(value[key])]));
}

// Chrome transport/storage are supplied here; every Bootstrap/runtime script
// comes from the installed candidate and every Native reply is a real frame.
export async function confirmThroughInstalledBootstrap({ extensionRoot, native, transactionId, targetVersion }) {
  const stateKey = 'codex-overleaf-managed-update-state-v1';
  const data = {
    [stateKey]: { state: 'awaiting_health', currentVersion: targetVersion, latestVersion: targetVersion },
    'codex-overleaf-managed-update-tabs-v1': [1]
  };
  const noop = { addListener() {}, removeListener() {} };
  const timers = new Set();
  const loaded = [];
  const documentUrl = 'https://www.overleaf.com/project/update-hop';
  const documentId = 'update-hop-main-document';
  const documentEvidence = [];
  const pageContext = vm.createContext({ location: { href: documentUrl } });
  let reloads = 0;
  const chrome = {
    runtime: {
      id: 'update-hop', lastError: null, getURL: value => 'chrome-extension://update-hop/' + value,
      getManifest: () => JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8')),
      onMessage: noop, onConnect: noop, reload() { reloads += 1; },
      connectNative() {
        const listeners = [];
        return { onMessage: { addListener: listener => listeners.push(listener) }, onDisconnect: noop,
          postMessage(message) {
            native.request(message).then(response => listeners.forEach(listener => listener({ ...response, id: message.id })))
              .catch(error => listeners.forEach(listener => listener({ id: message.id, ok: false,
                error: { code: 'update_hop_transport_failed', message: error.message } })));
          } };
      }
    },
    storage: {
      local: {
        async get(keys) { return chromeStoredValue(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])]))); },
        async set(values) { Object.assign(data, chromeStoredValue(structuredClone(values))); },
        async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
      },
      session: { async get(key) { return { [key]: true }; }, async set() {}, async remove() {} },
      onChanged: noop
    },
    alarms: { create() {}, async clear() {}, onAlarm: noop },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    permissions: { onAdded: noop, onRemoved: noop, async contains() { return true; } },
    scripting: { async getRegisteredContentScripts() { return []; }, async registerContentScripts() {},
      async unregisterContentScripts() {}, async insertCSS() {}, async executeScript(input) {
        const target = input?.target;
        const exactFrame = target?.frameIds?.length === 1 && target.frameIds[0] === 0;
        const exactDocument = target?.documentIds?.length === 1 && target.documentIds[0] === documentId;
        if (target?.tabId !== 1 || target.allFrames || (!exactFrame && !exactDocument)
          || input.world !== 'ISOLATED' || input.files || typeof input.func !== 'function') {
          throw new Error('Update-hop VM only provides a healthy main-document snapshot; receiver reinjection needs the browser rehearsal.');
        }
        pageContext.__args = input.args || [];
        const result = await vm.runInContext(`(${input.func.toString()})(...__args)`, pageContext);
        documentEvidence.push({ documentId, url: documentUrl, targetedBy: exactDocument ? 'documentId' : 'frameId' });
        return [{ frameId: 0, documentId, result }];
      } },
    tabs: {
      async query() { return [{ id: 1, url: documentUrl }]; },
      async sendMessage(_id, message) {
        if (message.type === 'codex-overleaf/runtime-health-probe') return { ok: true, version: targetVersion };
        if (message.type === 'codex-overleaf/update-idle-probe') return { idle: true, blockers: [] };
        return {};
      },
      async reload() {}
    }
  };
  const sandbox = {
    chrome, crypto, URL, console, indexedDB: { open() { throw new Error('Unexpected IndexedDB access in update-hop rehearsal.'); } },
    IDBKeyRange: {},
    fetch: async url => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(resolveAsset(url), 'utf8')) }),
    setTimeout(callback, delay) {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
      timers.add(timer); return timer;
    },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
    importScripts(...files) { files.forEach(load); }
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  function resolveAsset(input) {
    const relative = String(input).replace('chrome-extension://update-hop/', '');
    const filename = path.resolve(extensionRoot, relative);
    if (!filename.startsWith(extensionRoot + path.sep)) throw new Error('Bootstrap asset escapes the installed extension.');
    return filename;
  }
  function load(input) {
    const filename = resolveAsset(input);
    loaded.push(path.relative(extensionRoot, filename));
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }
  let deadline;
  try {
    load('bootstrap/background.js');
    if (!sandbox.__CODEX_OVERLEAF_BOOTSTRAP_READY__?.then) throw new Error('Installed Bootstrap did not expose initialization readiness.');
    await Promise.race([
      sandbox.__CODEX_OVERLEAF_BOOTSTRAP_READY__,
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Installed Bootstrap health initialization timed out.')), 25000); })
    ]);
    const status = await native.invoke('update.status');
    const confirmation = native.calls.find(call => call.method === 'update.confirm' && call.params?.transactionId === transactionId);
    const revision = sandbox.__CODEX_OVERLEAF_BOOTSTRAP_REVISION__;
    if (!confirmation || confirmation.params.bootstrapRevision !== revision || !revision
      || confirmation.params.extensionVersion !== targetVersion || confirmation.params.nativeVersion !== targetVersion
      || status.transaction?.id !== transactionId || status.transaction.state !== 'committed' || reloads) {
      throw new Error(`Installed Bootstrap did not confirm the target pair: ${JSON.stringify({ revision, reloads, state: data[stateKey], status })}`);
    }
    return { revision, loaded, status, documentEvidence };
  } finally {
    clearTimeout(deadline);
    for (const timer of timers) clearTimeout(timer);
  }
}
