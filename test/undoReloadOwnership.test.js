'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createNetwork, deferred, drain, read } = require('./_helpers/sharedSessionServiceHarness');
const { extractFunction } = require('./_helpers/extractFunction');
const State = require('../extension/src/shared/sessionState');
const RawDb = require('../extension/src/shared/storageDb');
const Undo = require('../extension/src/shared/undoOperations');
const Settlement = require('../extension/src/shared/writebackSettlement');
const Review = require('../extension/src/content/runReviewController');
const PanelPersistence = require('../extension/src/content/scopedPersistencePanelState');
const SessionPersistence = require('../extension/src/content/sessionPersistence');
const Context = require('../extension/src/page/reviewContext');
const Actions = require('../extension/src/content/runResultActions').create();
const runtime = read('extension/src/content/contentRuntime.js');
const timeline = read('extension/src/content/runTimelineView.js');
const leaseKey = 'codex-overleaf-review-lease-v1:review:' + JSON.stringify(['account-one','project-one','r']);
function lease(n) { return Object.entries(n.local).filter(([key,value])=>key.startsWith(leaseKey+':')&&value?.deadlineAt>Date.now()).map(([,value])=>value)[0]; }
function initialSession() {
  const appliedOperations = [{type:'edit',path:'main.tex',replaceAll:'Before.\n% added\n',verifiedContent:'Before.\n% added\n'}];
  const checkpoint = Undo.buildUndoCheckpoint({files:[{path:'main.tex',content:'Before.\n'}]},appliedOperations);
  return {id:'s',projectId:'project-one',accountScopeId:'account-one',runs:[{id:'r',task:'Undo refresh fixture',mode:'auto',status:'completed',runProjectId:'project-one',executionSnapshot:{mode:'auto',requireReviewing:false,source:'submitted'},appliedOperations,...checkpoint}]};
}
async function harness(network, tab, input, page) {
  const client=network.client(tab), db=client.bridge.decorate(RawDb);
  const reader={Modules:{StorageDb:db},getGlobalPreferences:()=>({overlay:value=>value}),normalizePanelState:State.normalizePanelState};
  vm.createContext(reader);vm.runInContext(extractFunction(runtime,'normalizeLoadedPanelState'),reader);
  let state=reader.normalizeLoadedPanelState({activeSessionId:'s',sessions:[input]});
  state.runs=state.sessions[0].runs;
  let timer, dispatches=0, cancels=0, writes=0;const notices=[];
  const viewScope={projectId:'project-one',accountScopeId:'account-one',generation:1};
  const findRunRecord=()=>state.sessions[0].runs[0];
  const persist=async(options = {})=>PanelPersistence.persistPanelState({reviewRunIds: options.reviewRunIds,state,compactState:State.prepareStateForStorage(state),projectId:'project-one',StorageDb:db,SessionPersistence,Migration:{loadPrefs:async()=>({}),savePrefs:async()=>{},loadSessionTombstones:async()=>({})},persistenceContext:{scope:client.scope},normalizeExperimentalOtByProject:v=>v||{},normalizeGovernanceRulesByProject:v=>v||{},normalizeCustomInstructionsByProject:v=>v||{}});
  const writer={findRunRecord,refreshRunCardControls(){},pendingSaveStateOptions:null,saveStateInFlight:false,saveStateTimer:null,mergeSaveStateOptions:()=>null,setTimeout(fn,delay){timer={fn,delay};return 1;},clearTimeout(){},runQueuedSaveState:persist};
  vm.createContext(writer);
  for(const name of ['saveStateSoon','setRunUndoStatus']) vm.runInContext(extractFunction(runtime,name),writer);
  const flight=new Map();
  const settlementContext = { Modules: { ScopedPersistenceCoordinator: PanelPersistence, SessionState: State, UndoOperations: Undo },
    WritebackSettlement: Settlement, FailureReasons: require('../extension/src/shared/failureReasons'), findRunRecord,
    advanceRunUndoProgress: (run, result) => Undo.advanceUndoCheckpoint(run, result, () => true), flushQueuedSaveState: persist };
  Object.defineProperty(settlementContext, 'state', { get: () => state });
  vm.createContext(settlementContext);
  vm.runInContext(extractFunction(runtime, 'applyTrackedChangeSettlement'), settlementContext);
  const controller=Review.create({Modules:{StorageDb:db,SessionState:State,UndoOperations:Undo,ScopedPersistenceCoordinator:PanelPersistence},WritebackSettlement:Settlement,trackedChangeInFlight:flight,findRunRecord,getRunUndoCount:r=>r.undoOperations.length,isTrackedChangeLifecycleRun:r=>Boolean(r.trackedChangeStatus),hasTrackedEditorUndo:()=>false,buildNoTraceUndoRestore:r=>({operations:r.undoOperations,snapshotRestore:true}),findUnsafeFullFileUndoOperation:()=>null,showPluginConfirm:page?.confirm|| (async()=>true),tr:k=>k,truncateRunTitle:v=>v,formatOperationFiles:()=> 'main.tex',getPageBridgeTimeoutMs:()=>120000,
    callPageBridge:async(method,params)=>{
      if(method==='cancelActiveWrite'){cancels++;Context.cancelOwner(params.reviewOwnerToken);return {ok:true};}
      dispatches++;
      return Context.create({getProjectId:()=> 'project-one'},params).run(async scoped=>{
        page?.entered?.resolve(params); if(page?.gate) await page.gate.promise;
        // Retain this request's guard across the pending external operation.
        const blocked=scoped.reviewGuard();
        if(blocked) throw Object.assign(new Error(blocked.reason),{reviewFailure:blocked});
        if (page?.error) throw new Error(page.error);
        writes++;
        if (method === 'acceptTrackedChanges') return { ok: true, verified: true,
          applied: params.trackedChanges.map(trackedChange => ({ trackedChange, result: { ok: true, verified: true } })), skipped: [] };
        return {ok:true,applied:params.operations.map(operation=>({operation,result:{ok:true,changedDocument:true}})),skipped:[]};
      });
    },formatTrackedChangeFiles:()=> 'main.tex',buildTrackedUndoPostFiles:r=>r.appliedOperations.map(op=>({path:op.path,content:op.verifiedContent})),
    applyTrackedChangeSettlement:settlementContext.applyTrackedChangeSettlement,formatBridgeResultReason:()=>'',
    buildContentFailure: Settlement.buildContentFailure,setRunUndoStatus:writer.setRunUndoStatus,appendRunRecordEvent(){},getRunProjectIdForWriteback:r=>r.runProjectId,refreshRunCardControls(){},getState:()=>state,getCurrentProjectId:()=>viewScope.projectId,getAccountScopeId:()=>viewScope.accountScopeId,getRouteGeneration:()=>viewScope.generation,tx:en=>en,notify:message=>notices.push(message),
    isUndoResultEffectivelyApplied:()=>true,writebackOrchestrator:{invalidateMirrorAfterUndo(){}},appendUndoReviewingPolicyEvent(){},formatOperationType:v=>v,formatApplyResultReason:()=>'',advanceRunUndoProgress:(r,result)=>Undo.advanceUndoCheckpoint(r,result,()=>true),flushQueuedSaveState:persist});
  function button(){
    const existing={cloneNode(){return {...this};},replaceWith(b){this.replacement=b;},addEventListener(){}};
    const consumer={isTrackedChangeLifecycleRun:()=>false,RunResultActions:Actions,projectRunSettlement:Settlement.projectRunSettlement,trackedChangeInFlight:flight,tr:k=>k,tx:en=>en,undoRun(){}};
    vm.createContext(consumer);vm.runInContext(extractFunction(timeline,'configureUndoButton'),consumer);
    consumer.configureUndoButton({querySelector:()=>existing},findRunRecord());return existing.replacement;
  }
  return {client,db,viewScope,get state(){return state;},replaceState:next=>{state=next;},controller,persist,button,notices,run:findRunRecord,counts:()=>({dispatches,cancels,writes}),saveTimer:async()=>{assert.equal(timer.delay,120);timer.fn();await drain();}};
}
function seed(n, source = initialSession()){const session=RawDb.buildSessionRecord(source,{preserveRunActionPayload:true});n.db.seed('sessions',{accountScopeId:session.accountScopeId,projectId:session.projectId,id:session.id,record:session,revision:1});return session;}
function stored(n){return n.db.peek('sessions',['account-one','s']).record;}
async function expire(n){for(const [key,value] of Object.entries(n.local).filter(([key])=>key.startsWith(leaseKey+':'))) await n.chromeApi.storage.local.set({[key]:{...value,deadlineAt:Date.now()-1}});}

test('actual Undo writer/reader/button preserves a live peer, quarantines a lost owner, then offers explicit retry',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const n=createNetwork(), input=seed(n), gate=deferred(), entered=deferred();
  try{
    const owner=await harness(n,1,input,{gate,entered});
    const pending=owner.controller.undoRun('r'); await entered.promise; await owner.saveTimer();
    assert.equal(stored(n).runs[0].undoStatus,'running');
    const observer=await harness(n,2,stored(n));
    await observer.controller.recoverInterruptedUndoStatuses();
    assert.equal(observer.run().undoStatus,'running');assert.equal(observer.button().disabled,true);
    await assert.rejects(observer.controller.undoRun('r'),{code:'review_busy'});
    await assert.rejects(observer.controller.acceptRun('r'),{code:'review_busy'});
    assert.equal(observer.controller.verifyManualReview,undefined);
    assert.equal(observer.counts().dispatches,0);
    owner.client.disconnect(); await drain(); assert.equal(owner.counts().cancels,1);
    await observer.controller.recoverInterruptedUndoStatuses(); assert.equal(observer.button().disabled,true);
    gate.resolve(); await assert.rejects(pending,{code:'storage_lock_lost'});
    assert.equal(owner.counts().writes,0); assert.equal(stored(n).runs[0].undoStatus,'running');
    await expire(n);t.mock.timers.tick(30000);await drain();
    assert.equal(observer.run().undoStatus,'partial');assert.equal(observer.button().disabled,false);
    assert.equal(observer.run().undoBaseFiles[0].content,'Before.\n% added\n');
    assert.equal(observer.counts().dispatches,0,'recovery never automatically replays Undo');
    await observer.controller.undoRun('r');assert.equal(observer.counts().writes,1);
    assert.equal(stored(n).runs[0].undoStatus,'applied');
    assert.equal(lease(n),undefined,'normal release clears the dispatched lease');
  } finally {n.close();}
});

test('confirmation reservation spends no Page deadline and disconnect before dispatch leaves no quarantine',async()=>{
  const n=createNetwork(), input=seed(n), gate=deferred(), confirming=deferred();
  try{
    const owner=await harness(n,1,input,{confirm:async()=>{confirming.resolve();return gate.promise;}});
    const pending=owner.controller.undoRun('r');await confirming.promise;
    assert.equal(lease(n),undefined);
    owner.client.disconnect();await drain();gate.resolve(true);
    await assert.rejects(pending,{code:'storage_lock_lost'});
    assert.equal(owner.counts().dispatches,0);
    const observer=await harness(n,2,input);await observer.controller.undoRun('r');
    assert.equal(observer.counts().writes,1);
  }finally{n.close();}
});

test('a stale page must read the first durable terminal decision before dispatching any Undo',async()=>{
  const n=createNetwork(),input=seed(n);
  try{
    const stale=await harness(n,1,input), peer=await harness(n,2,input);
    await peer.controller.undoRun('r'); assert.equal(stored(n).runs[0].undoStatus,'applied');
    await stale.controller.undoRun('r');assert.equal(stale.counts().dispatches,0);
    assert.equal(stale.run().undoStatus,'applied');await stale.persist();
    assert.equal(stored(n).runs[0].undoStatus,'applied');
  }finally{n.close();}
});

test('durable orphan lease survives fresh background service state and old token cancellation cannot stop a new review',async()=>{
  const n=createNetwork(),input=seed(n);
  try{
    await n.chromeApi.storage.local.set({[leaseKey+':previous-worker-owner']:{token:'previous-worker-owner',deadlineAt:Date.now()+120000}});
    const observer=await harness(n,1,{...input,runs:input.runs.map(r=>({...r,undoStatus:'running',undoOwnerProtocol:1}))});
    await observer.controller.recoverInterruptedUndoStatuses();assert.equal(observer.button().disabled,true);
    await assert.rejects(observer.controller.undoRun('r'),{code:'review_busy'});
    await expire(n);Context.cancelOwner('previous-worker-owner');
    await observer.controller.recoverInterruptedUndoStatuses();await observer.controller.undoRun('r');
    assert.equal(observer.counts().writes,1);assert.equal(stored(n).runs[0].undoStatus,'applied');
  }finally{n.close();}
});


test('a late Page reply cannot advance a newly selected session',async()=>{
  const n=createNetwork(),input=seed(n),gate=deferred(),entered=deferred();
  try{
    const owner=await harness(n,1,input,{gate,entered});
    const pending=owner.controller.undoRun('r');await entered.promise;await owner.saveTimer();
    owner.state.activeSessionId='new-session';gate.resolve();
    await assert.rejects(pending,{code:'review_context_changed'});
    assert.equal(stored(n).runs[0].undoStatus,'running');
    assert.equal(owner.state.activeSessionId,'new-session');
    assert.equal(owner.run().undoOperations.length,1);
  }finally{n.close();}
});


test('production bridge/Broker/Journal/router carry owner token to the actual Page mutation guard',async()=>{
  const Broker=require('../extension/src/content/assetTransferBroker');
  const Journal=require('../extension/src/page/writebackReceiptJournal');
  const Router=require('../extension/src/page/writebackRouter');
  const ProjectFiles=require('../extension/src/shared/projectFiles');
  const StaleGuard=require('../extension/src/shared/staleGuard');
  const gate=deferred(),entered=deferred();let deletes=0,sequence=0,deletionGate=null,deletionEntered=null;
  const router=Router.create({window:{document:{},CodexOverleafProjectFiles:ProjectFiles,CodexOverleafStaleGuard:StaleGuard},
    treeOperations:{getProjectId:()=> 'project-one'},getReviewingState:()=>({reviewing:{ok:false}}),isEditingConfirmedForNoTraceUndo:()=>true,delay:async()=>{},
    deleteTextFile:async(_operation,options)=>{
      deletionEntered?.resolve();if(deletionGate) await deletionGate.promise;
      if(!options.canDelete()) return {ok:false,code:'codex_cancelled',changedDocument:false};
      deletes++;return {ok:true,verified:true,verification:'overleaf-zip',changedDocument:true};}});
  const journal=Journal.create({getProjectId:()=> 'project-one',prepareEditor:async()=>{entered.resolve();await gate.promise;return {ok:true};},applyOperations:router.applyOperations});
  const bridge={Modules:{AssetTransferBroker:Broker},sendBackgroundNative(){assert.fail('no binary upload');},pageBridgeClient:{call:(method,params)=>{assert.equal(method,'applyOperations');return journal.apply({...params,writebackRequestId:'request-'+ ++sequence});}}};
  vm.createContext(bridge);vm.runInContext(extractFunction(runtime,'callPageBridge'),bridge);
  const input={operations:[{type:'delete',path:'asset.png',undoCreatedFile:{v:1,kind:'binary',sha256:'a'.repeat(64)}}],baseFiles:[],reviewingPolicy:'no-trace-undo',runProjectId:'project-one',deadlineAt:Date.now()+120000,reviewOwnerToken:'cancelled-old-page-request'};
  const pending=bridge.callPageBridge('applyOperations',input);await entered.promise;Context.cancelOwner(input.reviewOwnerToken);gate.resolve();
  const result=await pending;assert.equal(deletes,0);assert.equal(result.skipped[0].result.code,'codex_cancelled');
  const next=await bridge.callPageBridge('applyOperations',{...input,reviewOwnerToken:'new-page-request'});
  assert.equal(deletes,1,JSON.stringify(next));assert.equal(next.applied.length,1);
  deletionGate=deferred();deletionEntered=deferred();
  const duringPreflight=bridge.callPageBridge('applyOperations',{...input,reviewOwnerToken:'owner-lost-during-delete-preflight'});
  await deletionEntered.promise;Context.cancelOwner('owner-lost-during-delete-preflight');deletionGate.resolve();
  const stopped=await duringPreflight;assert.equal(deletes,1);assert.equal(stopped.applied.length,0);assert.equal(stopped.skipped[0].result.code,'codex_cancelled');
});


test('worker replacement cannot let an old pending release delete the new owner lease',async()=>{
  const n=createNetwork(),input=seed(n),work=deferred(),marked=deferred(),removing=deferred(),finishRemove=deferred(),newWork=deferred(),newMarked=deferred();
  try{
    const owner=await harness(n,1,input),observer=await harness(n,2,input);
    const remove=n.chromeApi.storage.local.remove;let oldKey;
    n.chromeApi.storage.local.remove=async key=>{if(!oldKey){oldKey=key;removing.resolve();await finishRemove.promise;}return remove(key);};
    const pending=owner.db.withSharedReviewLock({...owner.client.scope,runId:'r'},async assertOwner=>{await assertOwner.markDispatched();marked.resolve();await work.promise;});
    await marked.promise;work.resolve();await removing.promise;await expire(n);n.restartBackground();
    const next=observer.db.withSharedReviewLock({...observer.client.scope,runId:'r'},async assertOwner=>{await assertOwner.markDispatched();newMarked.resolve(assertOwner.token);await newWork.promise;});
    const token=await newMarked.promise;finishRemove.resolve();await drain();
    assert.equal(n.local[leaseKey+':'+token].token,token);assert.ok(n.local[leaseKey+':'+token].deadlineAt>Date.now());
    assert.equal(n.local[oldKey],undefined);
    newWork.resolve();await next;await pending;
  }finally{n.close();}
});

test('disconnect during dispatched-marker storage cannot grant a same-worker peer before the marker settles',async()=>{
  const n=createNetwork(),input=seed(n),setting=deferred(),finishSet=deferred();
  try{
    const owner=await harness(n,1,input),observer=await harness(n,2,input);
    const set=n.chromeApi.storage.local.set;let intercepted=false;
    n.chromeApi.storage.local.set=async values=>{if(!intercepted&&Object.keys(values).some(key=>key.startsWith(leaseKey+':'))){intercepted=true;setting.resolve();await finishSet.promise;}return set(values);};
    const pending=owner.db.withSharedReviewLock({...owner.client.scope,runId:'r'},async assertOwner=>{await assertOwner.markDispatched();assert.fail('a lost marker ACK cannot dispatch Page work');});
    await setting.promise;owner.client.disconnect();await drain();
    await assert.rejects(observer.db.withSharedReviewLock({...observer.client.scope,runId:'r'},async()=>{}),{code:'review_busy'});
    finishSet.resolve();await assert.rejects(pending,{code:'storage_lock_lost'});
    assert.ok(lease(n),'the late marker leaves a bounded isolation fence');
    await assert.rejects(observer.db.withSharedReviewLock({...observer.client.scope,runId:'r'},async()=>{}),{code:'review_busy'});
  }finally{n.close();}
});


test('legacy running Undo requires explicit old-page and file inspection before any retry',async()=>{
  const n=createNetwork(),input=seed(n);let checked=false,checks=0;
  input.runs[0].undoStatus='running';delete input.runs[0].undoOwnerProtocol;
  n.db.seed('sessions',{accountScopeId:input.accountScopeId,projectId:input.projectId,id:input.id,record:input,revision:1});
  try{
    const observer=await harness(n,1,input,{confirm:async options=>{checks++;assert.equal(options.title,'undoNoTraceTitle');assert.match(options.message,/close or reload every older project page/);return checked;}});
    await observer.controller.recoverInterruptedUndoStatuses();
    assert.equal(observer.run().undoStatus,'running');assert.equal(observer.button().disabled,false);assert.equal(observer.button().textContent,'undoRun');
    await observer.controller.undoRun('r');assert.equal(checks,1);assert.equal(observer.counts().dispatches,0);assert.equal(observer.run().undoStatus,'running');assert.equal(observer.button().disabled,false);assert.equal(stored(n).runs[0].undoStatus,'running');
    checked=true;await observer.controller.undoRun('r');assert.equal(checks,2);assert.equal(observer.counts().writes,1);
    assert.equal(stored(n).runs[0].undoOwnerProtocol,1);assert.equal(stored(n).runs[0].undoStatus,'applied');
  }finally{n.close();}
});


test('a current-page complete checkpoint survives a shared budget-omitted first recovery record',async()=>{
  const n=createNetwork(),input=seed(n);
  const compact={...input,runs:input.runs.map(run=>({...run,undoOperations:[],undoBaseFiles:[],undoExpectedFiles:[],appliedOperations:[],recoveryRetention:{state:'omitted',reason:'run-budget',bytes:8000000}}))};
  n.db.seed('sessions',{accountScopeId:input.accountScopeId,projectId:input.projectId,id:input.id,record:compact,revision:1});
  try{
    const owner=await harness(n,1,input);await owner.controller.undoRun('r');
    assert.equal(owner.counts().writes,1);assert.equal(stored(n).runs[0].undoStatus,'applied');assert.equal(stored(n).runs[0].undoOwnerProtocol,1);
  }finally{n.close();}
});


test('an owner-marker durable save failure dispatches no Page write and retains the in-memory checkpoint',async()=>{
  const n=createNetwork(),input=seed(n);
  try{
    const owner=await harness(n,1,input);
    owner.db.putRecords=async()=>{throw Object.assign(new Error('synthetic storage quota'),{code:'storage_quota_exceeded'});};
    await assert.rejects(owner.controller.undoRun('r'),{code:'review_state_not_persisted'});
    assert.equal(owner.counts().dispatches,0);assert.equal(owner.run().undoOperations.length,1);assert.equal(owner.run().undoBaseFiles[0].content,'Before.\n% added\n');
    assert.equal(stored(n).runs[0].undoOwnerProtocol,undefined);
  }finally{n.close();}
});


test('owner-query failure keeps its run busy while actual init and other recovery records continue',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const n=createNetwork(),input=seed(n);input.runs[0].undoStatus='running';input.runs[0].undoOwnerProtocol=1;
  input.runs.push({...input.runs[0],id:'other-run'});
  try{
    const h=await harness(n,1,input);const query=h.db.hasSharedReviewOwner;let failures=0,unavailable=true,continued=false;
    h.db.hasSharedReviewOwner=async request=>{if(request.runId==='r'&&unavailable){failures++;throw new Error('synthetic unavailable owner store');}return query(request);};
    const startup={getGlobalPreferences:()=>({initialize:async()=>{}}),refreshAccountScopeId:async()=>{},getProjectStorageKey:()=> 'fixture',LEGACY_STORAGE_KEY:'fixture',window:{location:{href:'https://www.overleaf.com/project/project-one'}},loadStoredState:async()=>h.state,normalizeLoadedPanelState:value=>value,getRunReviewController:()=>h.controller,panelContinuation:()=>{continued=true;}};
    vm.createContext(startup);const entry=extractFunction(runtime.slice(runtime.indexOf('  async function init()')),'init');
    vm.runInContext(entry.slice(0,entry.indexOf('    initializeRunQueueScheduler();'))+'    panelContinuation();\n  }',startup);
    await startup.init();assert.equal(continued,true);assert.equal(h.run().undoStatus,'running');assert.equal(h.button().disabled,true);assert.match(h.button().title,/checks are unavailable/);
    assert.equal(h.state.sessions[0].runs.find(run=>run.id==='other-run').undoStatus,'partial');assert.equal(h.notices.length,1);
    t.mock.timers.tick(5000);await drain();t.mock.timers.tick(10000);await drain();t.mock.timers.tick(30000);await drain();
    assert.equal(failures,3,'automatic owner-query failures have a finite retry budget');assert.equal(h.notices.length,1);assert.equal(h.run().undoOperations.length,1);
    unavailable=false;await h.controller.recoverInterruptedUndoStatuses();assert.equal(h.run().undoStatus,'partial');assert.equal(h.button().disabled,false);assert.equal(h.run().undoRecoveryUnavailable,undefined);assert.equal(h.counts().dispatches,0);
  }finally{n.close();}
});

test('expired immutable token cleanup cannot remove an unexpired owner or a late old-token row',async()=>{
  const n=createNetwork(),input=seed(n);
  try{
    const h=await harness(n,1,input),old=leaseKey+':expired-owner',fresh=leaseKey+':fresh-owner';
    await n.chromeApi.storage.local.set({[old]:{token:'expired-owner',deadlineAt:Date.now()-1},[fresh]:{token:'fresh-owner',deadlineAt:Date.now()+120000}});
    const late=leaseKey+':late-old-owner';
    await n.chromeApi.storage.local.set({[late]:{token:'late-old-owner',deadlineAt:Date.now()+60000}});
    const owner=await h.db.hasSharedReviewOwner({...h.client.scope,runId:'r'});assert.ok(n.local[late],'a late old set keeps its own bounded token row');assert.equal(owner.busy,true);assert.equal(n.local[old],undefined);assert.ok(n.local[fresh]);
    await n.chromeApi.storage.local.set({[old]:{token:'expired-owner',deadlineAt:Date.now()-1}});
    const remove=n.chromeApi.storage.local.remove;n.chromeApi.storage.local.remove=async key=>{if(key===old)throw new Error('synthetic cleanup failure');return remove(key);};
    const stillBusy=await h.db.hasSharedReviewOwner({...h.client.scope,runId:'r'});assert.equal(stillBusy.busy,true);assert.ok(n.local[fresh]);assert.ok(n.local[old]);
    n.chromeApi.storage.local.remove=remove;await h.db.hasSharedReviewOwner({...h.client.scope,runId:'r'});assert.equal(n.local[old],undefined);assert.ok(n.local[fresh]);
    await n.chromeApi.storage.local.set({[leaseKey+':invalid-row']:{token:'mismatched-token',deadlineAt:Date.now()-1}});
    await assert.rejects(h.db.hasSharedReviewOwner({...h.client.scope,runId:'r'}),{code:'review_lease_invalid'});assert.ok(n.local[leaseKey+':invalid-row'],'unverified rows are retained and fail closed');
  }finally{n.close();}
});

for (const change of ['state replacement', 'session switch and return']) test(`lease recovery timer recaptures a same-scope ${change}`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const n=createNetwork(),input=seed(n);input.runs[0].undoStatus='running';input.runs[0].undoOwnerProtocol=1;
  try{
    await n.chromeApi.storage.local.set({[leaseKey+':pending-owner']:{token:'pending-owner',deadlineAt:Date.now()+120000}});
    const h=await harness(n,1,input),oldRun=h.run();await h.controller.recoverInterruptedUndoStatuses();
    if(change==='state replacement'){
      const next=JSON.parse(JSON.stringify(h.state));next.runs=next.sessions[0].runs;h.replaceState(next);
    }else{
      h.state.sessions.push({id:'other-session',projectId:'project-one',accountScopeId:'account-one',runs:[]});
      h.state.activeSessionId='other-session';h.state.runs=[];
    }
    await expire(n);t.mock.timers.tick(30000);await drain();
    if(change==='session switch and return'){h.state.activeSessionId='s';h.state.runs=h.state.sessions[0].runs;}
    assert.equal(h.run().undoStatus,'partial');assert.equal(h.button().disabled,false);assert.equal(h.counts().dispatches,0);
    if(change==='state replacement')assert.equal(oldRun.undoStatus,'running','old captured state stays untouched');
  }finally{n.close();}
});

test('a same-scope view replacement during owner await discards the old result and deduplicates a fresh check',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const n=createNetwork(),input=seed(n);input.runs[0].undoStatus='running';input.runs[0].undoOwnerProtocol=1;
  try{
    const h=await harness(n,1,input),oldRun=h.run(),held=n.holdMessage('review-owner',1);
    const pending=h.controller.recoverInterruptedUndoStatuses();await held.entered.promise;
    const next=JSON.parse(JSON.stringify(h.state));next.runs=next.sessions[0].runs;h.replaceState(next);
    await n.deliver(held.envelope);await pending;
    assert.equal(oldRun.undoStatus,'running');assert.equal(h.run().undoStatus,'running','old awaited absence does not mutate the replacement view');
    t.mock.timers.tick(50);await drain();assert.equal(h.run().undoStatus,'partial');assert.equal(oldRun.undoStatus,'running');
    assert.equal(n.messages.filter(message=>message.message.method==='review-owner').length,2);assert.equal(h.counts().dispatches,0);
  }finally{n.close();}
});

test('an older awaited recovery cannot replace a newer recovery generation timer or result',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const n=createNetwork(),input=seed(n);input.runs[0].undoStatus='running';input.runs[0].undoOwnerProtocol=1;
  try{
    const h=await harness(n,1,input),oldRun=h.run(),held=n.holdMessage('review-owner',1);
    const pending=h.controller.recoverInterruptedUndoStatuses();await held.entered.promise;
    const next=JSON.parse(JSON.stringify(h.state));next.runs=next.sessions[0].runs;h.replaceState(next);
    await h.controller.recoverInterruptedUndoStatuses();assert.equal(h.run().undoStatus,'partial');
    await n.deliver(held.envelope);await pending;t.mock.timers.tick(30000);await drain();
    assert.equal(oldRun.undoStatus,'running');assert.equal(h.run().undoStatus,'partial');
    assert.equal(n.messages.filter(message=>message.message.method==='review-owner').length,2,'superseded generation adds no timer or query');
  }finally{n.close();}
});


for(const field of ['projectId','accountScopeId','generation'])test(`an old recovery await and timer cannot cross changed ${field}`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const n=createNetwork(),input=seed(n);input.runs[0].undoStatus='running';input.runs[0].undoOwnerProtocol=1;
  try{
    const h=await harness(n,1,input),held=n.holdMessage('review-owner',1);
    const pending=h.controller.recoverInterruptedUndoStatuses();await held.entered.promise;
    h.viewScope[field]=field==='generation'?2:'changed-scope';await n.deliver(held.envelope);await pending;
    t.mock.timers.tick(30000);await drain();assert.equal(h.run().undoStatus,'running');
    assert.equal(n.messages.filter(message=>message.message.method==='review-owner').length,1);assert.equal(h.counts().dispatches,0);
  }finally{n.close();}
});


test('ordinary Undo continues after clearing context during its durable owner marker save', async () => {
  const n = createNetwork();
  try {
    const h = await harness(n, 1, seed(n));
    h.replaceState(State.updateActiveSession(h.state, { focusFiles: ['main.tex'] }));
    const held = n.holdMessage('put', 1);
    const pending = h.controller.undoRun('r');
    // Capture a rejection immediately so the old bug is an assertion failure.
    const outcome = pending.then(() => null, error => error);
    await held.entered.promise;
    const oldState = h.state, oldRun = h.run();
    const tray = require('../extension/src/content/contextTray').createContextTrayController({
      getState: () => h.state, setState: h.replaceState, updateActiveSession: State.updateActiveSession,
      saveState: async () => {}, getCurrentProjectId: () => h.viewScope.projectId
    });
    await tray.clearFocusFile();
    assert.notEqual(h.state, oldState);
    assert.notEqual(h.run(), oldRun);
    await n.deliver(held.envelope);
    assert.equal(await outcome, null);
    assert.equal(h.counts().dispatches, 1);
    assert.equal(h.counts().writes, 1);
    assert.equal(h.run().undoStatus, 'applied');
    assert.equal(stored(n).runs[0].undoStatus, 'applied');
    assert.deepEqual(h.state.focusFiles, []);
  } finally { n.close(); }
});

for (const phase of ['Page result', 'terminal save']) test(`ordinary Undo settles the live run after draft/context changes during ${phase}`, async () => {
  const n = createNetwork(), gate = deferred(), entered = deferred();
  try {
    const h = await harness(n, 1, seed(n), { gate, entered });
    const pending = h.controller.undoRun('r').then(() => null, error => error);
    await entered.promise;
    let held;
    if (phase === 'terminal save') {
      held = n.holdMessage('put', 1);
      gate.resolve();
      await held.entered.promise;
    }
    const oldRun = h.run();
    const tray = require('../extension/src/content/contextTray').createContextTrayController({
      getState: () => h.state, setState: h.replaceState, updateActiveSession: State.updateActiveSession,
      saveState: async () => {}, getCurrentProjectId: () => h.viewScope.projectId
    });
    await tray.clearFocusFile();
    h.replaceState(State.updateActiveSession(h.state, { task: 'A later draft' }));
    if (held) await n.deliver(held.envelope); else gate.resolve();
    assert.equal(await pending, null);
    assert.notEqual(h.run(), oldRun);
    assert.equal(h.counts().writes, 1);
    assert.equal(h.run().undoStatus, 'applied');
    assert.equal(stored(n).runs[0].undoStatus, 'applied');
    assert.equal(h.state.task, 'A later draft');
    const reloaded = await harness(n, 2, stored(n));
    assert.equal(reloaded.run().undoStatus, 'applied');
    assert.equal(reloaded.button().disabled, true);
  } finally { n.close(); }
});


function trackedSession() {
  const session = initialSession();
  Object.assign(session.runs[0], { trackedChangeStatus: 'pending',
    undoTrackedChanges: [{ key: 'native:doc-one:change-one', id: 'change-one', path: 'main.tex' }],
    executionSnapshot: { mode: 'auto', requireReviewing: true, source: 'submitted' } });
  return session;
}
for (const phase of ['Page result', 'terminal save']) test(`Accept settles the live run after context changes during ${phase}`, async () => {
  const n = createNetwork(), gate = deferred(), entered = deferred();
  try {
    const h = await harness(n, 1, seed(n, trackedSession()), { gate, entered });
    const pending = h.controller.acceptRun('r').then(() => null, error => error);
    await entered.promise;
    let held;
    if (phase === 'terminal save') {
      held = n.holdMessage('put', 1); gate.resolve(); await held.entered.promise;
    }
    const tray = require('../extension/src/content/contextTray').createContextTrayController({
      getState: () => h.state, setState: h.replaceState, updateActiveSession: State.updateActiveSession,
      saveState: async () => {}, getCurrentProjectId: () => h.viewScope.projectId
    });
    await tray.clearFocusFile();
    h.replaceState(State.updateActiveSession(h.state, { task: 'Later draft' }));
    if (held) await n.deliver(held.envelope); else gate.resolve();
    assert.equal(await pending, null);
    assert.equal(h.run().trackedChangeStatus, 'accepted');
    assert.equal(stored(n).runs[0].trackedChangeStatus, 'accepted');
    assert.equal(h.counts().writes, 1);
    assert.deepEqual(h.run().undoTrackedChanges, []);
    assert.equal(h.state.task, 'Later draft');
  } finally { n.close(); }
});

const ownershipChanges = {
  'project': h => { h.viewScope.projectId = 'project-two'; },
  'account': h => { h.viewScope.accountScopeId = 'account-two'; },
  'route generation': h => { h.viewScope.generation++; },
  'active session': h => { h.replaceState({ ...h.state, activeSessionId: 'other-session' }); },
  'owning session account': h => { h.state.sessions[0].accountScopeId = 'account-two'; },
  'owning session project': h => { h.state.sessions[0].projectId = 'project-two'; },
  'run account': h => { h.run().runAccountScopeId = 'account-two'; },
  'run turn': h => { h.run().codexTurnId = 'different-turn'; },
  'same-ID replacement': h => { h.replaceState(State.updateActiveSession(h.state, { runs: [{ ...h.run() }] })); },
  'replacement checkpoint': h => {
    h.replaceState(State.updateActiveSession(h.state, { runs: [{ ...h.run(), undoBaseFiles: [{ path: 'main.tex', content: 'Different source' }] }] }));
  },
  'in-place checkpoint': h => { h.run().undoBaseFiles[0].content = 'Different source'; },
  'terminal status': h => { h.run().undoStatus = 'applied'; }
};
for (const [change, mutate] of Object.entries(ownershipChanges)) test(`Undo rejects changed ${change} while confirmation is open`, async () => {
  const n = createNetwork(), confirming = deferred(), answer = deferred();
  try {
    const h = await harness(n, 1, seed(n), { confirm: () => { confirming.resolve(); return answer.promise; } });
    const pending = h.controller.undoRun('r').then(() => null, error => error);
    await confirming.promise;
    mutate(h);
    const changedRun = JSON.stringify(h.run());
    answer.resolve(true);
    assert.equal((await pending)?.code, 'review_context_changed');
    assert.equal(h.counts().dispatches, 0);
    assert.equal(JSON.stringify(h.run()), changedRun, 'old action cannot update the changed record');
  } finally { n.close(); }
});

for (const action of ['undoRun', 'acceptRun']) test(`${action} rejects changed evidence after Page dispatch without settling a stale result`, async () => {
  const n = createNetwork(), gate = deferred(), entered = deferred();
  try {
    const h = await harness(n, 1, seed(n, action === 'acceptRun' ? trackedSession() : initialSession()), { gate, entered });
    const pending = h.controller[action]('r').then(() => null, error => error);
    await entered.promise;
    h.run().undoBaseFiles[0].content = 'Replacement checkpoint';
    const changedRun = JSON.stringify(h.run());
    gate.resolve();
    assert.equal((await pending)?.code, 'review_context_changed');
    assert.equal(JSON.stringify(h.run()), changedRun);
  } finally { n.close(); }
});

test('ordinary Undo leaves a retryable live record when Page fails after context was cleared', async () => {
  const n = createNetwork(), gate = deferred(), entered = deferred();
  try {
    const h = await harness(n, 1, seed(n), { gate, entered, error: 'Synthetic Page failure' });
    const pending = h.controller.undoRun('r').then(() => null, error => error);
    await entered.promise;
    h.replaceState(State.updateActiveSession(h.state, { focusFiles: [], task: 'Next task' }));
    gate.resolve();
    assert.equal((await pending)?.message, 'Synthetic Page failure');
    assert.equal(h.run().undoStatus, 'partial');
    assert.equal(h.button().disabled, false);
    assert.equal(h.run().undoOperations.length, 1);
    await h.saveTimer();
    assert.equal(stored(n).runs[0].undoStatus, 'partial');
  } finally { n.close(); }
});

for (const action of ['undoRun', 'acceptRun']) test(`${action} compensates the live clone when terminal persistence fails`, async () => {
  const n = createNetwork(), gate = deferred(), entered = deferred();
  try {
    const h = await harness(n, 1, seed(n, action === 'acceptRun' ? trackedSession() : initialSession()), { gate, entered });
    const pending = h.controller[action]('r').then(() => null, error => error);
    await entered.promise;
    const held = n.holdMessage('put', 1);
    gate.resolve(); await held.entered.promise;
    h.replaceState(State.updateActiveSession(h.state, { focusFiles: [], task: 'Preserve the new draft' }));
    held.envelope.resolve({ ok: false, error: { code: 'shared_store_unavailable', message: 'Synthetic durable store failure' } });
    assert.equal((await pending)?.code, 'shared_store_unavailable');
    assert.equal(h.run()[action === 'acceptRun' ? 'trackedChangeStatus' : 'undoStatus'], action === 'acceptRun' ? 'needs_review' : 'partial');
    assert.equal(h.run().undoOperations.length, 1);
    assert.equal(h.run().undoBaseFiles[0].content, 'Before.\n% added\n');
    if (action === 'acceptRun') assert.equal(h.run().undoTrackedChanges.length, 1);
    assert.equal(h.state.task, 'Preserve the new draft');
    assert.notEqual(stored(n).runs[0].undoStatus, 'applied');
    assert.notEqual(stored(n).runs[0].trackedChangeStatus, 'accepted');
  } finally { n.close(); }
});


for (const action of ['undoRun', 'acceptRun']) test(`${action} rebinds a draft clone while its dispatch lease is being saved`, async () => {
  const n = createNetwork();
  try {
    const h = await harness(n, 1, seed(n, action === 'acceptRun' ? trackedSession() : initialSession()));
    const held = n.holdMessage('review-dispatched', 1);
    const pending = h.controller[action]('r').then(() => null, error => error);
    await held.entered.promise;
    h.replaceState(State.updateActiveSession(h.state, { task: 'Next draft', focusFiles: [] }));
    await n.deliver(held.envelope);
    assert.equal(await pending, null);
    assert.equal(h.counts().dispatches, 1);
    assert.equal(h.run()[action === 'acceptRun' ? 'trackedChangeStatus' : 'undoStatus'], action === 'acceptRun' ? 'accepted' : 'applied');
  } finally { n.close(); }
});

test('ordinary Undo reconciles distinct active-run aliases with the same normalization identity', async () => {
  const n = createNetwork();
  try {
    const h = await harness(n, 1, seed(n));
    h.replaceState({ ...h.state, runs: State.normalizeRuns(h.state.runs) });
    assert.notEqual(h.state.runs[0], h.run());
    await h.controller.undoRun('r');
    assert.equal(h.state.runs[0].undoStatus, 'applied');
    assert.equal(h.run().undoStatus, 'applied');
    assert.equal(stored(n).runs[0].undoStatus, 'applied');
  } finally { n.close(); }
});

for (const action of ['undoRun', 'acceptRun']) for (const failSave of [false, true])
test(`${action} preserves late mirror evidence and warning events when terminal save ${failSave ? 'fails' : 'succeeds'}`, async () => {
  const n = createNetwork(), gate = deferred(), entered = deferred();
  try {
    const h = await harness(n, 1, seed(n, action === 'acceptRun' ? trackedSession() : initialSession()), { gate, entered });
    const pending = h.controller[action]('r').then(() => null, error => error);
    await entered.promise;
    const held = n.holdMessage('put', 1);
    gate.resolve(); await held.entered.promise;
    h.replaceState(State.updateActiveSession(h.state, { task: 'Newer draft' }));
    require('../extension/src/content/runSettlementPersistence').create({ writebackSettlement: Settlement,
      findRunRecord: h.run, getCurrentProjectId: () => h.viewScope.projectId, saveStateSoon() {}
    }).settleMirrorRefresh({ recordId: 'r', sessionId: 's', runProjectId: 'project-one', state: 'complete' });
    const context = { window: {} };
    vm.runInNewContext(read('extension/src/content/writebackOrchestrator.js'), context);
    const orchestrator = context.window.CodexOverleafWritebackOrchestrator.create({
      getCurrentProjectId: () => 'project-one', tx: en => en,
      appendRunRecordEvent: (_id, event) => h.run().events.push(event),
      sendBackgroundNative: async () => { throw new Error('Synthetic mirror invalidation warning'); }
    });
    await orchestrator.invalidateMirrorAfterUndo('r', 'project-one', { changedDocument: true });
    const warnings = structuredClone(h.run().events);
    assert.equal(warnings.length, 1, 'the actual mirror failure appends its warning');
    if (failSave) held.envelope.resolve({ ok: false, error: { code: 'shared_store_unavailable', message: 'Synthetic durable save failure' } });
    else await n.deliver(held.envelope);
    const error = await pending;
    assert.equal(error?.code || null, failSave ? 'shared_store_unavailable' : null);
    assert.equal(h.run()[action === 'acceptRun' ? 'trackedChangeStatus' : 'undoStatus'],
      action === 'acceptRun' ? (failSave ? 'needs_review' : 'accepted') : (failSave ? 'partial' : 'applied'));
    assert.equal(h.run().settlement.evidence.mirrored, 'complete');
    assert.deepEqual(structuredClone(h.run().events), warnings);
    assert.equal(h.state.task, 'Newer draft');
    if (failSave) assert.equal(h.run().undoOperations.length, 1);
  } finally { n.close(); }
});


for (const action of ['undoRun', 'acceptRun']) for (const change of ['status', 'checkpoint', 'settled evidence', 'readback evidence', 'save evidence', 'per-file evidence'])
test(`${action} does not overwrite a conflicting ${change} during terminal persistence`, async () => {
  const n = createNetwork(), gate = deferred(), entered = deferred();
  try {
    const h = await harness(n, 1, seed(n, action === 'acceptRun' ? trackedSession() : initialSession()), { gate, entered });
    const pending = h.controller[action]('r').then(() => null, error => error);
    await entered.promise;
    const held = n.holdMessage('put', 1); gate.resolve(); await held.entered.promise;
    h.replaceState(State.updateActiveSession(h.state, { task: 'Later draft' }));
    if (change === 'status') h.run()[action === 'acceptRun' ? 'trackedChangeStatus' : 'undoStatus'] = action === 'acceptRun' ? 'rejected' : 'partial';
    if (change === 'checkpoint') h.run().undoBaseFiles = [{ path: 'main.tex', content: 'A different checkpoint' }];
    if (change === 'settled evidence') h.run().settlement.evidence.settled = 'needs-review';
    if (change === 'readback evidence') h.run().settlement.evidence.readBack = 'mismatch';
    if (change === 'save evidence') h.run().settlement.evidence.saved = 'unconfirmed';
    if (change === 'per-file evidence') h.run().settlement.fileSettlements = [{ path: 'main.tex', readBack: 'mismatch' }];
    const changed = structuredClone(h.run());
    await n.deliver(held.envelope);
    assert.equal((await pending)?.code, 'review_state_not_persisted');
    assert.deepEqual(structuredClone(h.run()), changed);
  } finally { n.close(); }
});
