'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { gzipSync } = require('node:zlib');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const Transfer = require('../extension/src/shared/sharedSessionTransfer');
const { createEnvironment, closeAll } = require('./_helpers/sharedStorageHarness');
const clone = value => JSON.parse(JSON.stringify(value));
const record = (id, text = '') => ({ id, projectId: 'project-a', accountScopeId: 'account-one',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z', task: text });
function packed(text, declaredBytes = Buffer.byteLength(text)) {
  return { method: 'put-compressed', encoding: 'gzip-base64', version: 1, decodedBytes: declaredBytes,
    data: gzipSync(text).toString('base64') };
}

test('ordinary ASCII and Chinese payloads use exact UTF-8 accounting and unchanged raw transport', async () => {
  assert.equal(Transfer.byteLength('abc'), 3); assert.equal(Transfer.byteLength('中文🙂'), 10);
  const entries = [{ record: record('one', '中文🙂 with ASCII'), base: null }];
  const encoded = await Transfer.encode(entries);
  assert.equal(encoded.method, 'put');
  assert.deepEqual(await Transfer.decode({ method: encoded.method, ...encoded.payload }), entries);
});

test('raw entry payload accepts its exact byte boundary and uses compression just beyond it', async () => {
  const entries = [{ record: record('one'), base: { id: 'one', text: '' } }];
  const overhead = Buffer.byteLength(JSON.stringify(entries));
  entries[0].record.task = 'a'.repeat(Transfer.MAX_WIRE_BYTES - overhead);
  assert.equal(Buffer.byteLength(JSON.stringify(entries)), Transfer.MAX_WIRE_BYTES);
  assert.equal((await Transfer.encode(entries)).method, 'put');
  entries[0].base.text = '中';
  const encoded = await Transfer.encode(entries);
  assert.equal(encoded.method, 'put-compressed');
  assert.deepEqual(await Transfer.decode({method: encoded.method, ...encoded.payload}), entries);
});

test('large record and baseline roundtrip losslessly through the gzip method', async () => {
  const item = record('large', '长历史正文🙂'.repeat(1000000));
  const entries = [{ record: { ...item, task: item.task + '新版' }, base: item }];
  const encoded = await Transfer.encode(entries);
  assert.equal(encoded.method, 'put-compressed');
  assert.ok(Transfer.byteLength(JSON.stringify(encoded.payload)) < Transfer.MAX_WIRE_BYTES);
  assert.deepEqual(await Transfer.decode({method: encoded.method, ...encoded.payload}), entries);
});

test('missing compression APIs fail explicitly and never fall back to lossy data', async () => {
  const item = record('large', 'x'.repeat(13 * 1024 * 1024));
  await assert.rejects(Transfer.encode([{record: item, base: item}], {}), {code:'shared_session_compression_unavailable'});
  const encoded = await Transfer.encode([{record: item, base: item}]);
  await assert.rejects(Transfer.decode({method: encoded.method, ...encoded.payload}, {}), {code:'shared_session_compression_unavailable'});
});

test('per-record and whole decoded batch bounds reject before unlimited allocation', async () => {
  await assert.rejects(Transfer.encode([{record: record('over', 'x'.repeat(Transfer.MAX_RECORD_BYTES))}]), {code:'shared_session_too_large'});
  const item = record('under', 'x'.repeat(17 * 1024 * 1024));
  await assert.rejects(Transfer.encode(Array.from({length:5},()=>({record:item}))), {code:'shared_session_too_large'});
});

test('incompressible oversized payload is rejected at the compressed wire bound', async () => {
  const text = randomBytes(10 * 1024 * 1024).toString('base64');
  const item = record('entropy', text);
  await assert.rejects(Transfer.encode([{record:item,base:item}]), {code:'shared_session_too_large'});
});

test('damaged, inconsistent and mixed compressed envelopes cannot be acknowledged', async () => {
  const valid = packed(JSON.stringify([{record:record('one')}])) ;
  for (const patch of [{data:'not-base64'}, {data:Buffer.from('invalid gzip').toString('base64')},
    {decodedBytes:valid.decodedBytes+1}, {version:2}, {encoding:'unknown'}, {entries:[]}]) {
    await assert.rejects(Transfer.decode({...valid,...patch}), {code:'shared_session_transfer_invalid'});
  }
  await assert.rejects(Transfer.decode(packed('not JSON')), {code:'shared_session_transfer_invalid'});
  await assert.rejects(Transfer.decode(packed('{"not":"entries"}')), {code:'shared_session_transfer_invalid'});
});

test('decompression stream stops at its byte limit even when metadata understates expansion', async () => {
  const bomb = packed(' '.repeat(Transfer.MAX_DECODED_BYTES + 1), Transfer.MAX_DECODED_BYTES);
  await assert.rejects(Transfer.decode(bomb), {code:'shared_session_too_large'});
});

test('receiver rejects an oversized record hidden inside a small compressed envelope', async () => {
  const text = JSON.stringify([{record:record('oversized', 'x'.repeat(Transfer.MAX_RECORD_BYTES))}]);
  await assert.rejects(Transfer.decode(packed(text)), {code:'shared_session_too_large'});
});

test('a missing lock rejects a packed write before parsing or decompressing its malformed data', async () => {
  const h = createEnvironment();
  try {
    const response = await h.io.chrome.runtime.sendMessage({type:'codex-overleaf/shared-sessions-v1',method:'put-compressed',
      scope:{accountScopeId:h.accountScopeId,projectId:h.projectId},data:'not-base64'});
    assert.equal(response.ok,false);assert.equal(response.error.code,'storage_lock_lost');
  } finally {h.close();}
});

test('compressed multi-record conflicts stay atomic and retries do not advance a failed baseline', async () => {
  const h = createEnvironment();
  try {
    const big = record('large', 'x'.repeat(13*1024*1024)), small = record('small','original');
    await h.StorageDb.putRecords('sessions',[big,small]);
    const oldBig = await h.StorageDb.getRecord('sessions','large'), oldSmall = await h.StorageDb.getRecord('sessions','small');
    await h.StorageDb.putRecords('sessions',[{...oldSmall,task:'remote changed'}]);
    await assert.rejects(h.StorageDb.putRecords('sessions',[
      {...oldBig,title:'local candidate'}, {...oldSmall,task:'local conflicting'}
    ]),{code:'shared_session_conflict'});
    assert.equal((await h.StorageDb.getRecord('sessions','large')).title,undefined);
    assert.equal((await h.StorageDb.getRecord('sessions','small')).task,'remote changed');
    const currentBig=await h.StorageDb.getRecord('sessions','large'),currentSmall=await h.StorageDb.getRecord('sessions','small');
    await h.StorageDb.putRecords('sessions',[{...currentBig,title:'committed retry'},{...currentSmall,title:'independent field'}]);
    assert.equal((await h.StorageDb.getRecord('sessions','large')).title,'committed retry');
    assert.equal((await h.StorageDb.getRecord('sessions','small')).task,'remote changed');
    assert.ok(h.io.calls.some(call=>call.method==='put-compressed' && call.error==='shared_session_conflict'));
  } finally {h.close();}
});

test('oversized new data preserves prior durable history and a later valid write still succeeds', async () => {
  const h=createEnvironment();
  try {
    await h.StorageDb.putRecords('sessions',[record('one','saved')]);
    const old=await h.StorageDb.getRecord('sessions','one');
    await assert.rejects(h.StorageDb.putRecords('sessions',[{...old,task:'x'.repeat(Transfer.MAX_RECORD_BYTES)}]),{code:'shared_session_too_large'});
    assert.equal((await h.StorageDb.getRecord('sessions','one')).task,'saved');
    await h.StorageDb.putRecords('sessions',[{...old,task:'retry works'}]);
    assert.equal((await h.StorageDb.getRecord('sessions','one')).task,'retry works');
  }finally{h.close();}
});

test('a large baseline remains part of a bounded write even when the new record becomes short', async () => {
  const h=createEnvironment();
  try {
    await h.StorageDb.putRecords('sessions',[record('one','x'.repeat(13*1024*1024))]);
    const old=await h.StorageDb.getRecord('sessions','one');
    await h.StorageDb.putRecords('sessions',[{...old,task:'short new value'}]);
    assert.equal((await h.StorageDb.getRecord('sessions','one')).task,'short new value');
    assert.ok(h.io.calls.filter(call=>call.method==='put').at(-1).wireEstimateBytes>13*1024*1024);
  }finally{h.close();}
});

test('a lock lost during decode is rechecked before any database commit', async () => {
  const h=createEnvironment(),original=Transfer.decode;
  let release,entered;
  const ready=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
  Transfer.decode=async(...args)=>{entered();await held;return original(...args);};
  try {
    const pending=h.StorageDb.putRecords('sessions',[record('one','unsaved')]);
    await ready;h.close();release();
    await assert.rejects(pending,{code:'storage_lock_lost'});
    assert.equal((await h.StorageDb.getAllByIndex('sessions','projectId','project-a')).length,0);
  }finally{release();Transfer.decode=original;h.close();}
});

test('an old receiver explicitly rejects the new method without an empty-batch success', async () => {
  const source=fs.readFileSync(path.join(__dirname,'fixtures/shared-session-legacy-handle.js'),'utf8');
  const handle=vm.runInNewContext('('+source+')',{senderOrigin:()=> 'https://www.overleaf.com',scope:value=>value,
    failure:(code,message)=>Object.assign(new Error(message),{code})});
  await assert.rejects(handle({method:'put-compressed',scope:{accountScopeId:'account-one',projectId:'project-a'}},{}),{code:'shared_store_method_invalid'});
});

test('raw and compressed support are included in content and both background loading paths', () => {
  const root=path.join(__dirname,'..');
  const entry=fs.readFileSync(path.join(root,'extension/entries/content-entry.mjs'),'utf8');
  const background=fs.readFileSync(path.join(root,'extension/src/background.js'),'utf8');
  assert.ok(entry.indexOf("import '../src/shared/sharedSessionTransfer.js'")<entry.indexOf("import '../src/shared/sharedSessionBridge.js'"));
  assert.match(background,/if \(!globalThis\.CodexOverleafSharedSessionTransfer\)/);
  assert.match(background,/runtimeBase.*shared\/sharedSessionTransfer\.js[\s\S]*'shared\/sharedSessionTransfer\.js'/);
  const files=require('../native-host/src/runtimeInstaller').buildRuntimeFileManifest({packageRoot:root});
  assert.ok(files.some(file=>file.relativePath==='extension/src/shared/sharedSessionTransfer.js'));
});
test('legacy-admissible raw Chinese single and multi-record puts and imports remain accepted', async()=>{
  const large=record('large','中'.repeat(10*1024*1024));
  for(const message of [
    {method:'put',entries:[{record:large,base:null}]},
    {method:'import',record:large},
    {method:'put',entries:[{record:record('a','中'.repeat(5*1024*1024))},{record:record('b','中'.repeat(5*1024*1024))}]}
  ]){
    const entries=message.method==='import'?[{record:message.record}]:message.entries;
    const json=JSON.stringify(entries);
    assert.ok(json.length*2<=24*1024*1024);
    assert.ok(Buffer.byteLength(json)>24*1024*1024);
    assert.deepEqual(await Transfer.decode(message),entries);
    assert.equal((await Transfer.encode(entries)).method,'put');
    assert.equal((await Transfer.encode(entries,{})).method,'put','legacy raw stays available without compression APIs');
  }
});
test('the Unicode window does not raise the new ASCII record limit beyond 24MiB',async()=>{
  await assert.rejects(Transfer.encode([{record:record('ascii','x'.repeat(25*1024*1024))}]),{code:'shared_session_too_large'});
});
function historyRecord(h,id,runs=[]) {
  return h.StorageDb.buildSessionRecord({id,projectId:h.projectId,accountScopeId:h.accountScopeId,title:id,titleSource:'manual',
    createdAt:'2026-10-04T00:00:00.000Z',updatedAt:'2026-10-04T00:00:00.000Z',mode:'ask',runs});
}
function longHistoryRun(id,character) {
  return {id,task:'bounded history',mode:'ask',status:'completed',events:Array.from({length:160},(_,index)=>({
    kind:'activity',status:'completed',timestamp:'2026-10-04T00:00:00.000Z',title:id+index+character.repeat(44000)}))};
}
test('three-way merge cannot store a record larger than the accepted candidate window',async()=>{
  const h=createEnvironment();try{
    await h.StorageDb.putRecords('sessions',[historyRecord(h,'merge'),historyRecord(h,'sibling')]);
    const base=await h.StorageDb.getRecord('sessions','merge'),sibling=await h.StorageDb.getRecord('sessions','sibling');
    const remote=h.StorageDb.buildSessionRecord({...base,runs:[longHistoryRun('remote','甲')]});
    const local=h.StorageDb.buildSessionRecord({...base,runs:[longHistoryRun('local','乙')]});
    await h.StorageDb.putRecords('sessions',[remote]);
    await assert.rejects(h.StorageDb.putRecords('sessions',[{...sibling,task:'must roll back'},local]),{code:'shared_session_too_large'});
    assert.deepEqual((await h.StorageDb.getRecord('sessions','merge')).runs.map(run=>run.id),['remote']);
    const unchangedSibling=await h.StorageDb.getRecord('sessions','sibling');
    assert.equal(unchangedSibling.task,sibling.task);assert.equal(unchangedSibling.sharedRevision,sibling.sharedRevision);
  }finally{h.close();}
});
test('the complete write acknowledgement budget aborts all individually valid sibling updates',async()=>{
  const h=createEnvironment();try{
    await h.StorageDb.putRecords('sessions',[historyRecord(h,'a'),historyRecord(h,'b')]);
    const a=await h.StorageDb.getRecord('sessions','a'),b=await h.StorageDb.getRecord('sessions','b');
    const updates=[h.StorageDb.buildSessionRecord({...a,runs:[longHistoryRun('a','甲')]}),h.StorageDb.buildSessionRecord({...b,runs:[longHistoryRun('b','乙')]})];
    await assert.rejects(h.StorageDb.putRecords('sessions',updates),{code:'shared_session_too_large'});
    assert.equal((await h.StorageDb.getRecord('sessions','a')).runs.length,0);
    assert.equal((await h.StorageDb.getRecord('sessions','b')).runs.length,0);
  }finally{h.close();}
});
test('an oversized record merged by the old worker can still be read and explicitly shortened after upgrade',async()=>{
  const oldWorker=require('./fixtures/shared-session-legacy-worker.cjs');
  const h=createEnvironment({}, {backgroundModule:oldWorker});try{
    await h.StorageDb.putRecords('sessions',[historyRecord(h,'old-merge')]);
    const base=await h.StorageDb.getRecord('sessions','old-merge');
    const remote=h.StorageDb.buildSessionRecord({...base,runs:[longHistoryRun('remote','甲')]});
    const local=h.StorageDb.buildSessionRecord({...base,runs:[longHistoryRun('local','乙')]});
    await h.StorageDb.putRecords('sessions',[remote]);await h.StorageDb.putRecords('sessions',[local]);
    const old=await h.StorageDb.getRecord('sessions','old-merge');
    assert.ok(Buffer.byteLength(JSON.stringify(old))>Transfer.MAX_RECORD_BYTES);
    h.replaceService(require('../extension/src/backgroundSharedSessions'));
    const readable=await h.StorageDb.getRecord('sessions','old-merge');assert.equal(readable.runs.length,2);
    await assert.rejects(h.StorageDb.putRecords('sessions',[readable]),{code:'shared_session_too_large'});
    assert.equal((await h.StorageDb.getRecord('sessions','old-merge')).runs.length,2);
    const shorter=h.StorageDb.buildSessionRecord({...readable,runs:[readable.runs[0]],task:'explicitly shortened'});
    await h.StorageDb.putRecords('sessions',[shorter]);
    const saved=await h.StorageDb.getRecord('sessions','old-merge');assert.equal(saved.task,'explicitly shortened');assert.equal(saved.runs.length,1);
    assert.deepEqual(saved.runs[0].events,readable.runs[0].events);
  }finally{h.close();}
});
test('an old baseline above the total decoded budget fails explicitly instead of being discarded',async()=>{
  const base=record('one','x'.repeat(Transfer.MAX_DECODED_BYTES));
  await assert.rejects(Transfer.encode([{record:record('one','short'),base}]),{code:'shared_session_too_large'});
});
test('high-entropy BMP text in the old window remains raw and does not require compression',async()=>{
  let seed=123456789,block='';
  for(let index=0;index<65536;index++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;block+=String.fromCharCode(0x4e00+seed%20902);}
  const entries=[{record:record('legacy-entropy',block.repeat(160)),base:null}];
  const json=JSON.stringify(entries);assert.ok(json.length*2<=Transfer.MAX_WIRE_BYTES);assert.ok(Buffer.byteLength(json)>Transfer.MAX_WIRE_BYTES);
  class MustNotCompress{constructor(){throw new Error('legacy-compatible raw data must not be compressed');}}
  const encoded=await Transfer.encode(entries,{CompressionStream:MustNotCompress});
  assert.equal(encoded.method,'put');assert.deepEqual(await Transfer.decode({method:'put',...encoded.payload}),entries);
});
test.after(closeAll);
