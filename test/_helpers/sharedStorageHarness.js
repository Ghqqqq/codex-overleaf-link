'use strict';
// The only database substitute: asynchronous requests/cursors, serialized atomic
// transactions, and key/index ranges. This does not model disk or browser quota.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const roots = [];
const repo = (() => { let p = __dirname; while (!fs.existsSync(path.join(p, 'extension/src/shared/storageDb.js'))) { const next = path.dirname(p); if (next === p) throw new Error('repository_not_found'); p = next; } return p; })();
const sources = new Set();
function source(relative) { sources.add(relative); return fs.readFileSync(path.join(repo, relative), 'utf8'); }
function loadModule(relative, replacements = {}, globals = {}) {
  const filename = path.join(repo, relative), module = { exports: {} };
  vm.runInNewContext(source(relative), { module, exports: module.exports, console,
    structuredClone, TextEncoder, setTimeout, clearTimeout, setInterval, clearInterval,
    crypto: webcrypto, ...globals,
    require(request) {
      if (Object.hasOwn(replacements, request)) return replacements[request];
      const resolved = request.startsWith('.') ? path.resolve(path.dirname(filename), request) : request;
      return require(resolved);
    }
  }, { filename });
  return module.exports;
}
function createMemoryIndexedDb() {
  const databases = new Map();
  const ranges = { only: value => ({ only: value }), bound: (lower, upper, lowerOpen, upperOpen) => ({ lower, upper, lowerOpen, upperOpen }) };
  const encode = key => JSON.stringify(key);
  const keyAt = (record, keyPath) => Array.isArray(keyPath) ? keyPath.map(p => record[p]) : record[keyPath];
  const compare = (a, b) => {
    if (Array.isArray(a) && Array.isArray(b)) { for (let i = 0; i < Math.min(a.length,b.length); i++) { const c = compare(a[i],b[i]); if (c) return c; } return a.length-b.length; }
    return a === b ? 0 : a < b ? -1 : 1;
  };
  const matches = (key, range) => !range ? true : Object.hasOwn(range, 'only') ? compare(key,range.only)===0
    : (compare(key,range.lower)>0 || !range.lowerOpen && compare(key,range.lower)===0)
      && (compare(key,range.upper)<0 || !range.upperOpen && compare(key,range.upper)===0);
  function makeDb() {
    const schema = new Map(), data = new Map(); let tail = Promise.resolve();
    return {
      objectStoreNames: { contains: name => schema.has(name) },
      createObjectStore(name, options) {
        schema.set(name, { keyPath: options.keyPath, indexes: new Map() }); data.set(name,new Map());
        return { createIndex: (index, keyPath) => schema.get(name).indexes.set(index,keyPath) };
      },
      transaction(names, mode) {
        names = Array.isArray(names) ? names : [names];
        const ready = tail; let release, local, active = false, pending = 0, ended = false, epoch = 0;
        tail = new Promise(resolve => { release = resolve; });
        const tx = {
          error: null,
          abort() { if (ended) return; ended = true; setImmediate(() => { tx.onabort?.({target:tx}); release(); }); },
          objectStore(name) {
            if (!names.includes(name) || !schema.has(name)) throw new Error('invalid_store:' + name);
            const transact = (request, operation) => {
              pending++; epoch++;
              ready.then(() => setImmediate(() => {
                if (ended) return;
                if (!active) { active = true; local = new Map(names.map(n => [n,new Map(data.get(n))])); }
                try { request.result = operation(local.get(name)); request.onsuccess?.({target:request}); }
                catch (error) { request.error = tx.error = error; request.onerror?.({target:request}); tx.abort(); }
                pending--; finish();
              }));
              return request;
            };
            const request = operation => transact({}, store => clone(operation(store)));
            const cursor = (range, indexName) => {
              const req = {}; let entries = null, position = 0;
              const advance = () => transact(req, store => {
                if (!entries) entries = [...store.entries()].filter(([,record]) => matches(keyAt(record,indexName ? schema.get(name).indexes.get(indexName) : schema.get(name).keyPath),range))
                  .sort((a,b) => compare(keyAt(a[1],schema.get(name).keyPath),keyAt(b[1],schema.get(name).keyPath)));
                const next = entries[position++];
                if (!next) return null;
                const [key,record] = next;
                return { value: clone(record), key: keyAt(record,schema.get(name).keyPath),
                  continue: advance,
                  update: nextRecord => request(map => { map.set(key,clone(nextRecord)); return key; }),
                  delete: () => request(map => map.delete(key)) };
              });
              advance(); return req;
            };
            return {
              get: key => request(map => map.get(encode(key))),
              getAll: () => request(map => [...map.values()]),
              put: record => request(map => { const key = keyAt(record,schema.get(name).keyPath); map.set(encode(key),clone(record)); return key; }),
              delete: key => request(map => map.delete(encode(key))),
              clear: () => request(map => map.clear()),
              openCursor: range => cursor(range),
              index: indexName => ({
                getAll: range => request(map => [...map.values()].filter(record => matches(keyAt(record,schema.get(name).indexes.get(indexName)),range))),
                openCursor: range => cursor(range,indexName)
              })
            };
          }
        };
        function finish() {
          if (pending || ended) return;
          const ticket = epoch;
          setImmediate(() => {
            if (ended || pending || ticket!==epoch) return;
            ended = true;
            if (mode === 'readwrite') for (const [name,map] of local || []) data.set(name,map);
            tx.oncomplete?.({target:tx}); release();
          });
        }
        return tx;
      }
    };
  }
  return { IDBKeyRange:ranges, indexedDB: { open(name) {
    const request = {};
    setImmediate(() => {
      const fresh = !databases.has(name); if (fresh) databases.set(name,makeDb());
      request.result = databases.get(name);
      if (fresh) request.onupgradeneeded?.({target:request});
      request.onsuccess?.({target:request});
    });
    return request;
  } } };
}
function eventHub() {
  const handlers = new Set();
  return { addListener: fn => handlers.add(fn), removeListener: fn => handlers.delete(fn), clear: () => handlers.clear(), emit: (...args) => { for (const fn of [...handlers]) fn(...args); } };
}
function createChrome(initial = {}) {
  const values = clone(initial), calls = [], ports = new Set();
  const chrome = { storage: { local: {
    async get(keys) { if (keys == null) return clone(values); const list = Array.isArray(keys)?keys:[keys]; return Object.fromEntries(list.filter(k=>Object.hasOwn(values,k)).map(k=>[k,clone(values[k])])); },
    async set(patch) { Object.assign(values,clone(patch)); },
    async remove(keys) { for (const key of Array.isArray(keys)?keys:[keys]) delete values[key]; }
  }, onChanged:eventHub() }, runtime: { id:'fixture-extension', onMessage:eventHub(), onConnect:eventHub() } };
  return { chrome, values, calls, attachEnvironment(env) {
    const sender = () => ({ id:chrome.runtime.id, frameId:0, url:env.location.href, tab:{id:42,url:env.location.href} });
    chrome.runtime.sendMessage = async message => {
      const summary = { method:message.method, accountScopeId:message.scope?.accountScopeId, projectId:message.scope?.projectId,
        entryCount:message.entries?.length || 0,
        recordUtf8Bytes:message.entries ? Buffer.byteLength(JSON.stringify(message.entries.map(entry=>entry.record)),'utf8') : 0,
        proposedRunCount:message.entries?.reduce((n,entry)=>n+(entry.record?.runs?.length||0),0)||0,
        wireEstimateBytes:message.entries ? JSON.stringify(message.entries).length*2 : 0 };
      calls.push(summary);
      return new Promise(resolve => chrome.runtime.onMessage.emit(clone(message),sender(),response => {
        summary.ok=response.ok; summary.error=response.error?.code; resolve(clone(response));
      }));
    };
    chrome.runtime.connect = ({name}) => {
      let disconnected = false;
      const client={name,onMessage:eventHub(),onDisconnect:eventHub()}, server={name,sender:sender(),onMessage:eventHub(),onDisconnect:eventHub()};
      client.postMessage=msg=>queueMicrotask(()=>{if(!disconnected)server.onMessage.emit(clone(msg));});
      server.postMessage=msg=>queueMicrotask(()=>{if(!disconnected)client.onMessage.emit(clone(msg));});
      client.disconnect=server.disconnect=()=>{if(disconnected)return;disconnected=true;ports.delete(client);client.onDisconnect.emit();server.onDisconnect.emit();};
      ports.add(client); chrome.runtime.onConnect.emit(server); return client;
    };
  }, close() { for(const port of [...ports])port.disconnect(); } };
}
function createEnvironment(initial = {}, options = {}) {
  const idb=createMemoryIndexedDb(), io=createChrome(initial);
  let accountScopeId=options.accountScopeId || 'account-one', projectId=options.projectId || 'project-a';
  const env={chrome:io.chrome,crypto:webcrypto,setTimeout,clearTimeout,setInterval,clearInterval,
    location:{ protocol:'https:', hostname:'www.overleaf.com', pathname:'/project/'+projectId, href:'https://www.overleaf.com/project/'+projectId },
    codexOverleafDeriveAccountScopeId:()=>accountScopeId};
  io.attachEnvironment(env);
  const legacy=loadModule('extension/src/shared/storageDb.js',{},idb);
  const bridge=require(path.join(repo,'extension/src/shared/sharedSessionBridge.js')).createBridge(env);
  const StorageDb=bridge.decorate(legacy);
  let service=(options.backgroundModule || require(path.join(repo,'extension/src/backgroundSharedSessions.js'))).createService({ chromeApi:io.chrome, ...idb,
    mergeSessionReviewState:StorageDb.mergeSessionReviewState });
  service.install();
  const Migration=loadModule('extension/src/shared/storageMigration.js',{'./storageDb':StorageDb},{chrome:io.chrome});
  roots.push(io);
  return { env, io, idb, legacy, bridge, StorageDb, Migration, get service(){return service;},
    replaceService(module){
      io.close();io.chrome.runtime.onMessage.clear();io.chrome.runtime.onConnect.clear();
      service=module.createService({chromeApi:io.chrome,...idb,mergeSessionReviewState:StorageDb.mergeSessionReviewState});service.install();
    },
    get accountScopeId(){return accountScopeId;},get projectId(){return projectId;},
    select(account,project){accountScopeId=account;projectId=project;env.location.pathname='/project/'+project;env.location.href='https://www.overleaf.com/project/'+project;},
    close:()=>io.close() };
}
module.exports={repo,clone,source,sources,loadModule,createMemoryIndexedDb,createEnvironment,closeAll:()=>roots.forEach(io=>io.close())};
