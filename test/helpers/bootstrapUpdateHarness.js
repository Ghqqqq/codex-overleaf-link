// Full production Bootstrap/background/coordinator; only Chrome and Native transport I/O are supplied by each test.
"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), vm = require("node:vm");
const ROOT = path.resolve(__dirname, "../..");
const UPDATE_KEY = "codex-overleaf-managed-update-state-v1";
async function createBootstrapHarness(options = {}) {
  const version = options.version || "2.5.0", data = { [UPDATE_KEY]: { state: "idle", currentVersion: version, latestVersion: version } }, listeners = [], nativeCalls = [], loaded = [], timers = /* @__PURE__ */ new Map(), probes = [];
  let timerId = 0, reloads = 0;
  const noop = { addListener() {
  } };
  let active = options.active !== false;
  const chrome = { runtime: { id: "fixture", lastError: null, getURL: (p) => "chrome-extension://fixture/" + p, getManifest: () => ({ version, background: { service_worker: "bootstrap/background.js" } }), onMessage: { addListener: (l) => listeners.push(l) }, onConnect: noop, reload() {
    reloads++;
  }, connectNative() {
    const callbacks = [];
    return { onMessage: { addListener: (l) => callbacks.push(l) }, onDisconnect: noop, postMessage(request) {
      nativeCalls.push(structuredClone(request));
      Promise.resolve(options.native(request)).then((response) => queueMicrotask(() => callbacks.forEach((l) => l({ ...response, id: request.id })))).catch((error) => queueMicrotask(() => callbacks.forEach((l) => l({ id: request.id, ok: false, error: { code: error.code || "fixture_error", message: error.message } }))));
    } };
  } }, storage: { local: { async get(keys) {
    return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((k) => [k, structuredClone(data[k])]));
  }, async set(v) {
    Object.assign(data, structuredClone(v));
  }, async remove(keys) {
    for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
  } }, session: { async get(k) {
    return { [k]: true };
  }, async set() {
  }, async remove() {
  } }, onChanged: noop }, alarms: { create() {
  }, async clear() {
  }, onAlarm: noop }, action: { async setBadgeText() {
  }, async setBadgeBackgroundColor() {
  } }, permissions: { onAdded: noop, onRemoved: noop, async contains() {
    return true;
  } }, scripting: { async getRegisteredContentScripts() {
    return [];
  }, async registerContentScripts() {
  }, async unregisterContentScripts() {
  }, async insertCSS() {
  }, async executeScript() {
  } }, tabs: { async query() {
    if (!active) return [];
    return options.tabs || [];
  }, async sendMessage(id, message) {
    probes.push({ id, type: message.type });
    if (message.type === "codex-overleaf/runtime-health-probe") return { ok: true, version: options.healthVersion || version };
    if (message.type === "codex-overleaf/update-idle-probe") return options.idle || { idle: true, blockers: [] };
    return {};
  }, async reload() {
  } } };
  const sandbox = { chrome, URL, crypto, console, indexedDB: { open() {
    throw Error("Unexpected IndexedDB");
  } }, IDBKeyRange: {}, fetch: async () => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(path.join(ROOT, "extension/runtime-manifest.json"), "utf8")) }), setTimeout(cb, delay) {
    const id = ++timerId;
    timers.set(id, { cb, delay });
    return id;
  }, clearTimeout(id) {
    timers.delete(id);
  }, importScripts(...files) {
    files.forEach(load);
  } };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  function load(input) {
    let rel = input.replace("chrome-extension://fixture/", "");
    if (rel.startsWith("runtime/")) rel = rel.slice(8);
    if (!rel.startsWith("bootstrap/") && !rel.startsWith("src/")) rel = "src/" + rel;
    const file = path.join(ROOT, "extension", rel);
    loaded.push(rel);
    vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: file });
  }
  if (options.bootstrap !== false) load("bootstrap/background.js");
  else {
    load("bootstrap/updateStatus.js");
    load("src/background.js");
  }
  if (options.pendingTabs) data["codex-overleaf-managed-update-tabs-v1"] = options.pendingTabs;
  for (let i = 0; i < 10; i++) await new Promise(setImmediate);
  return { data, loaded, nativeCalls, probes, chrome, sandbox, listeners, reloads: () => reloads, setActive(v) {
    active = v;
  }, dispose() {
    timers.clear();
  }, async settle() {
    for (let i = 0; i < 12; i++) await new Promise(setImmediate);
  }, async send(type, sender = { id: "fixture", url: "chrome-extension://fixture/bootstrap/popup.html" }) {
    let handled = false;
    return new Promise((resolve) => {
      for (const listener of listeners) {
        if (listener({ type }, sender, resolve) === true) handled = true;
      }
      if (!handled) resolve({ unhandled: true });
    });
  } };
}
module.exports = { createBootstrapHarness, UPDATE_KEY };
