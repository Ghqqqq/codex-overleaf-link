'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { background, memoryStorage, ownerClient, recoveryOptions, bind, event, flush, prefix } = require('./_helpers/backgroundJournalHarness');

async function seeded(id, terminal = false) {
  const storage = memoryStorage(), first = background(storage), route = { current: first }, owner = ownerClient(route);
  const response = first.run(id); bind(owner,id); event(first,id); await flush();
  if (terminal) { first.ports[0].emit({ id, ok: true, result: { status: 'completed' } }); await response; }
  return { storage, first, route, owner, response };
}
function freshWorker(f) {
  const second = background(f.storage); f.route.current = second;
  return second;
}
function observer(route,id) {
  const client = ownerClient(route), target = recoveryOptions(id);
  return { client, target, recover: () => client.control.recoverJournals(target.options) };
}
for (const terminal of [false,true]) test(`worker restart recovers the persisted ${terminal?'terminal':'active'} journal after its reconnected owner is lost`, async () => {
  const id = 'restart-' + terminal, f = await seeded(id,terminal), second = freshWorker(f);
  f.owner.ports.at(-1).workerLost(); await f.owner.timer.fire(50);
  f.owner.control.destroy(); await second.timer.fire(150);
  assert.equal(f.storage.values[prefix+id].ownerLost,true);
  const view=observer(f.route,id), result=await view.recover();
  assert.equal(result.changed,true); assert.equal(view.target.session.runs[0].status,'interrupted');
  assert.equal(view.target.session.runs[0].codexThreadId,'thread-one');
  assert.equal(view.target.session.pendingInputs[0].status,'paused');
  assert.equal(second.pending().totalRequests,0,'loading a journal never reconstructs a Native request');
  assert.equal(second.ports.length,0,'restoration must not restart or cancel an untracked Native request');
  await view.client.control.acknowledge(id); assert.equal(f.storage.values[prefix+id],undefined);
  view.client.control.destroy(); f.first.timer.clear(); second.timer.clear();
});
test('normal owner loss cancels once and acknowledgement removes its recovery record',async()=>{
  const id='ordinary',f=await seeded(id);f.owner.control.destroy();await f.first.timer.fire(150);
  assert.equal(f.storage.values[prefix+id].ownerLost,true);
  assert.equal(f.first.ports[0].messages.filter(x=>x.method==='codex.cancel').length,1);
  const view=observer(f.route,id);assert.equal((await view.recover()).changed,true);
  f.first.ports[0].emit({id,ok:false,error:{code:'codex_cancelled'}});await f.response;
  await view.client.control.acknowledge(id);assert.equal(f.storage.values[prefix+id],undefined);view.client.control.destroy();
});
test('rebind during grace preserves a live owner and shared terminal protection',async()=>{
  const id='grace',f=await seeded(id,true);f.owner.control.destroy();const other=ownerClient(f.route);bind(other,id);
  await f.first.timer.fire(150);assert.equal(f.storage.values[prefix+id].ownerLost,false);
  const view=observer(f.route,id);assert.equal((await view.recover()).changed,false);
  other.control.release(id);await other.control.acknowledge(id);other.control.destroy();view.client.control.destroy();
});
test('rebind that arrives while a restored journal is being read prevents owner loss',async()=>{
  const id='slow-rebind',f=await seeded(id),second=freshWorker(f);
  const gate=f.storage.delayNextRead(keys=>Array.isArray(keys)?keys.includes(prefix+id):keys===prefix+id);
  const old=ownerClient(f.route);bind(old,id);await flush();old.control.destroy();const interruption=second.timer.fire(150);
  await flush();const next=ownerClient(f.route);bind(next,id);gate.resolve();await interruption;await flush();
  assert.equal(f.storage.values[prefix+id].ownerLost,false);
  const view=observer(f.route,id);assert.equal((await view.recover()).changed,false);
  next.control.release(id);await next.control.acknowledge(id);next.control.destroy();view.client.control.destroy();f.owner.control.destroy();
});
test('ack during a restored journal read prevents the late read from recreating it',async()=>{
  const id='slow-ack',f=await seeded(id),second=freshWorker(f);
  const gate=f.storage.delayNextRead(keys=>Array.isArray(keys)?keys.includes(prefix+id):keys===prefix+id);
  const reconnect=ownerClient(f.route);bind(reconnect,id);await flush();
  assert.equal((await second.ack(id)).ok,true);gate.resolve();await flush();reconnect.control.destroy();await second.timer.fire(150);
  assert.equal(f.storage.values[prefix+id],undefined);assert.equal((await second.list()).journals.length,0);
  f.owner.control.destroy();
});
test('a binding cannot restore a persisted journal from a different project',async()=>{
  const id='wrong-project',f=await seeded(id),second=freshWorker(f),other=ownerClient(f.route);
  other.control.bind({requestId:id,projectKey:'project-other',clientRunId:'client-'+id,sessionId:'session-one'});
  await flush();other.control.destroy();await second.timer.fire(150);
  assert.equal(f.storage.values[prefix+id].ownerLost,false);assert.equal((await second.list()).journals.length,0);f.owner.control.destroy();
});
test('a valid reconnected owner revokes a previous ownerLost marker before passive recovery',async()=>{
  const id='late-live',f=await seeded(id);f.owner.control.destroy();await f.first.timer.fire(150);
  assert.equal(f.storage.values[prefix+id].ownerLost,true);
  const next=ownerClient(f.route);bind(next,id);await flush();assert.equal(f.storage.values[prefix+id].ownerLost,false);
  const view=observer(f.route,id);assert.equal((await view.recover()).changed,false);
  f.first.ports[0].emit({id,ok:false,error:{code:'codex_cancelled'}});await f.response;
  next.control.release(id);await next.control.acknowledge(id);next.control.destroy();view.client.control.destroy();
});
test('prune waits behind queued writes and permanently removes the oldest terminal journal',async()=>{
  const storage=memoryStorage(),bg=background(storage),id='pruned-1',first=bg.run(id);await flush();
  const gate=storage.delayNextCompletion(input=>input[prefix+id]?.events.length===1&&!input[prefix+id]?.terminal);
  event(bg,id);await flush();bg.ports[0].emit({id,ok:true,result:{status:'completed'}});
  for(let i=2;i<=17;i++){const next='pruned-'+i,response=bg.run(next);bg.ports[0].emit({id:next,ok:true,result:{status:'completed'}});await response;}
  gate.resolve();await first;await flush();
  assert.equal(storage.values[prefix+id],undefined,'old pending snapshots cannot resurrect a pruned key');
  assert.equal(Object.keys(storage.values).filter(k=>k.startsWith(prefix)).length,16);
  assert.equal((await bg.list()).journals.length,16);
  const writes=storage.trace.filter(x=>x.key===prefix+id);assert.equal(writes.at(-1).operation,'remove');
});
test('ack waits for an outstanding write chain before durable deletion',async()=>{
  const storage=memoryStorage(),bg=background(storage),id='ack',response=bg.run(id);await flush();
  const gate=storage.delayNextCompletion(input=>input[prefix+id]?.events.length===1&&!input[prefix+id]?.terminal);
  event(bg,id);await flush();bg.ports[0].emit({id,ok:true,result:{status:'completed'}});
  let done=false;const ack=bg.ack(id).then(value=>{done=true;return value});await flush();assert.equal(done,false);
  gate.resolve();await response;assert.equal((await ack).ok,true);await flush();assert.equal(storage.values[prefix+id],undefined);
});
test('capacity pruning does not delete active journals to meet the terminal retention target',async()=>{
  const storage=memoryStorage(),bg=background(storage);
  for(let i=0;i<18;i++)bg.run('active-'+i);
  await flush();assert.equal(Object.keys(storage.values).filter(k=>k.startsWith(prefix)).length,18);
  assert.equal(storage.trace.some(x=>x.operation==='remove'),false);
});

test('passive recovery waits for a live rebind clearing a restored ownerLost marker',async()=>{
  const id='lost-before-rebind',f=await seeded(id);f.owner.control.destroy();await f.first.timer.fire(150);
  const second=freshWorker(f),gate=f.storage.delayNextRead(keys=>keys===prefix+id);
  const next=ownerClient(f.route);bind(next,id);await flush();let listed=false;
  const result=second.list().then(value=>{listed=true;return value});await flush();assert.equal(listed,false);
  gate.resolve();assert.equal((await result).journals.length,0);await flush();
  assert.equal(f.storage.values[prefix+id].ownerLost,false);next.control.release(id);await next.control.acknowledge(id);next.control.destroy();
});
test('foreign tab/document and mismatched client run cannot claim a stored journal',async()=>{
  const id='owner-identity',f=await seeded(id);f.owner.control.destroy();await f.first.timer.fire(150);
  const second=freshWorker(f);
  const { sender }=require('./_helpers/backgroundJournalHarness');
  const foreign=ownerClient(f.route,{...sender,documentId:'foreign-document',tab:{...sender.tab,id:202}});bind(foreign,id);
  const mismatch=ownerClient(f.route);mismatch.control.bind({requestId:id,projectKey:'project-one',clientRunId:'other-client',sessionId:'session-one'});
  await flush();assert.equal(f.storage.values[prefix+id].ownerLost,true);
  assert.equal((await second.list()).journals.length,1,'unmatched live bindings cannot hide recovery evidence');
  foreign.control.destroy();mismatch.control.destroy();await second.timer.fire(150);
});
test('legacy journals without sender metadata still recover through matching project/run/session binding',async()=>{
  const id='legacy',f=await seeded(id);delete f.storage.values[prefix+id].ownerTabId;delete f.storage.values[prefix+id].ownerDocumentId;
  const second=freshWorker(f),next=ownerClient(f.route);bind(next,id);await flush();next.control.destroy();await second.timer.fire(150);
  assert.equal(f.storage.values[prefix+id].ownerLost,true);f.owner.control.destroy();
});
test('late hydration cannot replace a newer same-ID journal or let the old bind cancel it',async()=>{
  const id='reused-after-read',f=await seeded(id),second=freshWorker(f),gate=f.storage.delayNextRead(keys=>keys===prefix+id);
  const old=ownerClient(f.route);bind(old,id);await flush();
  const newResponse=second.run(id,{clientRunId:'new-client',task:'New request'});await flush();gate.resolve();await flush();
  old.control.destroy();await second.timer.fire(150);
  assert.equal(f.storage.values[prefix+id].clientRunId,'new-client');assert.equal(f.storage.values[prefix+id].ownerLost,false);
  assert.equal(second.ports[0].messages.some(x=>x.method==='codex.cancel'),false);
  second.ports[0].emit({id,ok:true,result:{status:'completed'}});await newResponse;f.owner.control.destroy();
});
test('queued acknowledgement cannot delete a newly created same-ID journal',async()=>{
  const storage=memoryStorage(),bg=background(storage),id='reused-after-ack',first=bg.run(id);await flush();
  const gate=storage.delayNextCompletion(input=>input[prefix+id]?.events.length===1&&!input[prefix+id]?.terminal);
  event(bg,id);await flush();bg.ports[0].emit({id,ok:true,result:{status:'completed'}});
  const ack=bg.ack(id),next=bg.run(id,{clientRunId:'new-client',task:'New request'});gate.resolve();await first;await ack;await flush();
  assert.equal(storage.values[prefix+id].clientRunId,'new-client');assert.equal(storage.values[prefix+id].terminal,false);
  bg.ports[0].emit({id,ok:true,result:{status:'completed'}});await next;assert.equal(storage.values[prefix+id].clientRunId,'new-client');
});
test('old owner-loss completion cannot cancel a replacement request with the same identity fields',async()=>{
  const id='reused-after-owner-loss',f=await seeded(id);
  const gate=f.storage.delayNextCompletion(input=>input[prefix+id]?.ownerLost===true);
  f.owner.control.destroy();const loss=f.first.timer.fire(150);await flush();
  const next=f.first.run(id,{task:'Replacement request'});await flush();gate.resolve();await loss;await flush();
  assert.equal(f.first.ports[0].messages.some(x=>x.method==='codex.cancel'),false);
  assert.equal(f.storage.values[prefix+id].task,'Replacement request');assert.equal(f.storage.values[prefix+id].ownerLost,false);
  f.first.ports[0].emit({id,ok:true,result:{status:'completed'}});await next;
});


test('a browser-only retry owner protects shared running history without restoring or cancelling its old Native request', async () => {
  const id = 'retry-without-journal', storage = memoryStorage(), bg = background(storage), route = { current: bg };
  const owner = ownerClient(route), view = observer(route, id);
  view.target.session.runs[0].nativeRequestId = id;
  view.target.options.listSessions = () => [view.target.session];
  assert.equal(await owner.control.bindBrowserRun({ requestId: id, projectKey: 'project-one',
    clientRunId: 'client-' + id, sessionId: 'session-one' }), true);
  assert.equal((await view.recover()).changed, false);
  assert.equal(view.target.session.runs[0].status, 'running');
  assert.equal(storage.values[prefix + id], undefined, 'browser ownership must not resurrect the old journal');
  owner.control.destroy();
  await bg.timer.fire(150);
  assert.equal(bg.ports.length, 0, 'losing a browser-only owner must not dispatch Native cancellation');
  assert.equal((await view.recover()).changed, true);
  assert.equal(view.target.session.runs[0].status, 'interrupted');
  view.client.control.destroy();
});

test('a browser owner for a different session or run cannot protect a journal-free running record', async () => {
  for (const difference of [{ sessionId: 'other-session' }, { clientRunId: 'other-run' }, { projectKey: 'other-project' }]) {
    const id = 'mismatch-retry', bg = background(memoryStorage()), route = { current: bg };
    const owner = ownerClient(route), view = observer(route, id);
    view.target.session.runs[0].nativeRequestId = id;
    view.target.options.listSessions = () => [view.target.session];
    assert.equal(await owner.control.bindBrowserRun({ requestId: id, projectKey: 'project-one',
      clientRunId: 'client-' + id, sessionId: 'session-one', ...difference }), true);
    assert.equal((await view.recover()).changed, true);
    owner.control.destroy(); view.client.control.destroy();
  }
});


test('browser-only ownership rebinds after worker replacement and an old release cannot remove the new attempt', async () => {
  const id = 'retry-reconnect', storage = memoryStorage(), first = background(storage), route = { current: first };
  const owner = ownerClient(route), view = observer(route, id);
  const binding = { requestId: id, projectKey: 'project-one', clientRunId: 'client-' + id, sessionId: 'session-one' };
  view.target.session.runs[0].nativeRequestId = id;
  view.target.options.listSessions = () => [view.target.session];
  assert.equal(await owner.control.bindBrowserRun({ ...binding, ownerToken: 'old' }), true);
  assert.equal(await owner.control.bindBrowserRun({ ...binding, ownerToken: 'new' }), true);
  owner.control.release(id, 'old');
  assert.equal((await view.recover()).changed, false);
  const second = background(storage); route.current = second;
  owner.ports.at(-1).workerLost();
  assert.equal((await view.recover()).changed, false, 'a restarted worker must probe the page before its reconnect timer fires');
  await owner.timer.fire(50);
  assert.equal((await view.recover()).changed, false);
  assert.equal(second.ports.length, 0);
  owner.control.release(id, 'new');
  assert.equal((await view.recover()).changed, true);
  owner.control.destroy(); view.client.control.destroy();
});


test('the actual Retry sync entry waits for owner ACK, protects another page, and releases after writeback', async () => {
  const vm = require('node:vm');
  const { extractFromContentScript } = require('./_helpers/contentScriptSource');
  const WritebackIntent = require('../extension/src/shared/writebackIntent');
  const id = 'runtime-retry', bg = background(memoryStorage()), route = { current: bg };
  const owner = ownerClient(route), view = observer(route, id);
  const record = view.target.session.runs[0];
  record.nativeRequestId = id; record.status = 'failed';
  record.retryWriteback = { id: 'retry-intent', projectId: 'project-one', accountScopeId: 'account-one',
    sessionId: 'session-one', runId: record.id, operations: [{ type: 'create', path: 'qa.tex', content: 'x' }], baseFiles: [] };
  let permitBind, finishWrite, writeStarted = false;
  const bindGate = new Promise(resolve => { permitBind = resolve; });
  const writeGate = new Promise(resolve => { finishWrite = resolve; });
  const bind = owner.control.bindBrowserRun;
  const context = vm.createContext({
    currentRunView: null, trackedChangeInFlight: new Set(), state: {},
    getActiveSession: () => view.target.session, Modules: { WritebackIntent },
    getCurrentProjectId: () => 'project-one', cachedAccountScopeId: 'account-one', spaRouteGeneration: 0,
    findRunRecord: () => record, AbortController, crypto: { randomUUID: () => 'owner-attempt' },
    activeTurnControl: { ...owner.control, bindBrowserRun: async value => { await bindGate; return bind(value); } },
    setRunning() {}, renderRunHistory() {}, panel: { querySelector: () => null }, cssEscape: value => value,
    tx: en => en, showPluginToast() {}, saveStateSoon() {}, flushQueuedSaveState: async () => {},
    applySyncChangesToOverleaf: async () => { writeStarted = true; await writeGate; return { hasSkippedOperations: false }; },
    finishRunView: async (_title, status) => { record.status = status; }
  });
  vm.runInContext(extractFromContentScript('retryRunWriteback'), context);
  const retry = context.retryRunWriteback(record.id);
  await flush();
  assert.equal(record.status, 'failed'); assert.equal(writeStarted, false, 'no write may precede owner ACK');
  permitBind(); await flush();
  assert.equal(record.status, 'running'); assert.equal(writeStarted, true);
  view.target.options.listSessions = () => [view.target.session];
  assert.equal((await view.recover()).changed, false);
  finishWrite(); await retry;
  assert.equal(record.status, 'completed'); assert.equal(context.currentRunView, null);
  assert.equal(record.retryingWriteback, undefined);
  const known = await owner.control.knownJournals([id], [{ requestId: id, projectKey: 'project-one',
    clientRunId: record.id, sessionId: 'session-one' }]);
  assert.equal(known.size, 0, 'completed retry must not leave a permanent browser owner');
  owner.control.destroy(); view.client.control.destroy();
});


test('an unreadable live-page owner probe never proves a retry is orphaned', async () => {
  const id = 'unreadable-owner', storage = memoryStorage(), first = background(storage), route = { current: first };
  const owner = ownerClient(route), view = observer(route, id);
  assert.equal(await owner.control.bindBrowserRun({ requestId: id, projectKey: 'project-one', clientRunId: 'client-' + id, sessionId: 'session-one' }), true);
  view.target.session.runs[0].nativeRequestId = id;
  view.target.options.listSessions = () => [view.target.session];
  route.current = background(storage);
  owner.ports.at(-1).workerLost();
  const entry = storage.runtimeOwners.find(value => value.read()?.requestId === id), originalRead = entry.read;
  entry.read = () => { throw new Error('Synthetic page unavailable'); };
  const result = await view.recover();
  assert.equal(result.changed, false); assert.equal(result.recheckAfterMs, 1000);
  assert.equal(view.target.session.runs[0].status, 'running');
  entry.read = originalRead;
  assert.equal((await view.recover()).changed, false);
  owner.control.destroy(); view.client.control.destroy();
});
