'use strict';
// Full production persistence/migration/fork paths, with isolated storage and Chrome I/O.
const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createHash}=require('node:crypto');
const {repo,clone,source,sources,createEnvironment,closeAll}=require('./_helpers/sharedStorageHarness');
const SessionState=require(path.join(repo,'extension/src/shared/sessionState'));
const SessionPersistence=require(path.join(repo,'extension/src/content/sessionPersistence'));
const PanelState=require(path.join(repo,'extension/src/content/scopedPersistencePanelState'));
const Fork=require(path.join(repo,'extension/src/content/sessionForkController'));
const ResultActions=require(path.join(repo,'extension/src/content/runResultActions'));
const Settlement=require(path.join(repo,'extension/src/shared/writebackSettlement'));
const RunController=require(path.join(repo,'extension/src/content/runController'));
const UndoOperations=require(path.join(repo,'extension/src/shared/undoOperations'));
const CaptureController=require(path.join(repo,'extension/src/content/trackedChangeCaptureController'));
const StorageKeys=require(path.join(repo,'extension/src/shared/storageKeys'));
const {extractFunction}=require(path.join(repo,'test/_helpers/extractFunction'));
const runtime=source('extension/src/content/contentRuntime.js');
const timelineSource=source('extension/src/content/runTimelineView.js');
const resultActionsSource=source('extension/src/content/runResultActions.js');
const observations=[];
const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
const baseTime='2026-10-04T00:00:00.000Z';
const plain=value=>clone(value);
function observe(issue,scenario,data) { const value={issue,scenario,...data};observations.push(value); }
function makeRun(id,status='completed',mode='ask',extras={}) {
  return {id,task:'Synthetic '+id,status,mode,model:'fixture-model',startedAt:baseTime,finishedAt:baseTime,
    codexThreadId:'thread-source',codexTurnId:'turn-source',runProjectId:'project-a',
    events:[{kind:'report',title:'Synthetic answer',status:status==='completed'?'completed':'failed',timestamp:baseTime}],...extras};
}
function makeState(runs,id='session-source') {
  const session=SessionState.createSession({title:'Fixture history',titleSource:'manual',runs,codexThreadId:'thread-source',mode:'ask'});
  session.id=id; session.accountScopeId='account-one'; session.createdAt=baseTime;session.updatedAt=baseTime;
  return SessionState.normalizePanelState({sessions:[session],activeSessionId:id});
}
function bindReader(h) {
  const ctx={Modules:{StorageDb:h.StorageDb,StorageMigration:h.Migration},cachedAccountScopeId:h.accountScopeId,
    getCurrentProjectId:()=>h.projectId,storageKey:StorageKeys.getProjectStorageKey('codexOverleafPanelState', 'https://www.overleaf.com/project/'+h.projectId),
    loadComposerAttachmentsForProject:async()=>[],normalizeGovernanceRulesByProject:v=>v||{},PANEL_DEFAULT_WIDTH:380,
    chrome:h.io.chrome,normalizePanelState:SessionState.normalizePanelState,getGlobalPreferences:()=>({overlay:value=>value})};
  vm.createContext(ctx);
  for(const name of ['loadStoredStateForProject','normalizeLoadedPanelState','buildScopedFallbackStorageKey','isScopedPersistenceIdentityFailure'])
    vm.runInContext(extractFunction(runtime,name),ctx);
  return async()=>{
    ctx.storageKey=StorageKeys.getProjectStorageKey('codexOverleafPanelState', 'https://www.overleaf.com/project/'+h.projectId);ctx.cachedAccountScopeId=h.accountScopeId;
    const loaded=await ctx.loadStoredStateForProject(h.accountScopeId);
    return {loaded:plain(loaded),normalized:ctx.normalizeLoadedPanelState(loaded)};
  };
}
async function persist(h,state,options={}) {
  let aggressive=0;
  const compact=SessionState.prepareStateForStorage(state,{onAggressive:()=>aggressive++});
  const metrics={compactUtf8Bytes:bytes(compact),onAggressive:aggressive,compactRunCount:compact.sessions.reduce((n,s)=>n+s.runs.length,0)};
  const before=h.io.calls.length;
  let error=null;
  try {
    await PanelState.persistPanelState({state,compactState:compact,projectId:h.projectId,Migration:h.Migration,StorageDb:h.StorageDb,
      ...options,SessionPersistence,normalizeExperimentalOtByProject:v=>v||{},normalizeGovernanceRulesByProject:v=>v||{},normalizeCustomInstructionsByProject:v=>v||{},
      persistenceContext:{scope:{accountScopeId:h.accountScopeId,projectId:h.projectId},nextMeta:{},writerId:'writer-fixture'}});
  } catch(e){error={code:e.code,message:e.message};}
  const put=h.io.calls.slice(before).find(c=>c.method==='put');
  return {...metrics,error,put:plain(put||null)};
}
function longState(runCount,eventsPerRun=300) {
  return makeState(Array.from({length:runCount},(_,ri)=>makeRun('long-'+ri,'completed','ask',{
    events:Array.from({length:eventsPerRun},(_,ei)=>({title:'Event '+ri+' '+ei+' '+'x'.repeat(2200),kind:'activity',status:'completed',timestamp:baseTime}))
  })));
}
function buttonRoot() {
  const nodes=new Map();
  const make=selector=>({hidden:false,disabled:false,title:'',listeners:{},classList:{add(){},remove(){}},
    setAttribute(){},cloneNode(){return make(selector);},replaceWith(value){nodes.set(selector,value);},
    addEventListener(type,fn){this.listeners[type]=fn;},remove(){}});
  return {nodes,querySelector(selector){if(!nodes.has(selector))nodes.set(selector,make(selector));return nodes.get(selector);},querySelectorAll:()=>[]};
}
function actionView(run,forkHandler=async()=>{}) {
  const root=buttonRoot();
  const ctx={tr:key=>key,tx:en=>en,trackedChangeInFlight:new Map(),projectRunSettlement:Settlement.projectRunSettlement,
    RunResultActions:ResultActions.create({tr:key=>key,getLocale:()=>'en',forkRunFromNode:forkHandler}), forkRunFromNode:forkHandler,undoRun:()=>{throw new Error('unexpected_undo_click');},
    retryWriteback:()=>{throw new Error('unexpected_writeback_click');},getCurrentRunView:()=>null,
    canEditRun:value=>RunController.isRetryReplacementEligible(value,Settlement.projectRunSettlement(value)),refillComposerForRetry:()=>{},
    configureLifecycleUndoButton:()=>{throw new Error('stripped_fork_must_not_be_lifecycle');},
    wireAcceptInlineConfirm:()=>{throw new Error('stripped_fork_must_not_accept');},root,run};
  vm.createContext(ctx);
  vm.runInContext(extractFunction(resultActionsSource,'configureForkButton'),ctx);
  for(const name of ['isTrackedChangeLifecycleRun','configureEditButton','configureWritebackButton','configureUndoButton','configureAcceptButton'])
    vm.runInContext(extractFunction(timelineSource,name),ctx);
  ctx.configureForkButton(root,run);ctx.configureEditButton(root,run);ctx.configureWritebackButton(root,run);
  ctx.configureUndoButton(root,run);ctx.configureAcceptButton(root,run);
  const summary=Object.fromEntries(['fork','edit','sync-retry','undo','accept'].map(action=>{
    const button=root.querySelector('[data-run-'+action+']');return [action,{hidden:button.hidden,disabled:button.disabled,hasClick:Boolean(button.listeners.click)}];
  }));
  return {root,summary,clickFork:async()=>{const b=root.querySelector('[data-run-fork]');assert.equal(b.disabled,false);assert.ok(b.listeners.click);await b.listeners.click({stopPropagation(){}});}};
}
async function checkActualUndoAcceptEntries(run) {
  const calls={page:0,mirror:0,view:0};
  const captures=CaptureController.create({getRuns:()=>[run],buildExpectedFilesAfterOperations:UndoOperations.buildExpectedFilesAfterOperations});
  const ctx={Modules:{UndoOperations},findRunRecord:id=>id===run.id?run:null,
    getTrackedChangeCaptureController:()=>captures,trackedChangeInFlight:new Map(),
    getPendingMirrorRefresh:()=>{calls.mirror++;throw new Error('unexpected_mirror_wait');},
    callPageBridge:()=>{calls.page++;throw new Error('unexpected_page_action');},
    refreshRunCardControls:()=>{calls.view++;throw new Error('unexpected_action_started');}};
  vm.createContext(ctx);
  for(const name of ['buildTrackedUndoPostFiles','hasTrackedEditorUndo','getRunUndoCount','undoRun','acceptRun'])
    vm.runInContext(extractFunction(runtime,name),ctx);
  vm.runInContext(extractFunction(timelineSource,'isTrackedChangeLifecycleRun'),ctx);
  try{await ctx.undoRun(run.id);await ctx.acceptRun(run.id);assert.deepEqual(calls,{page:0,mirror:0,view:0});}
  finally{captures.dispose();}
  return calls;
}
async function createForkFixture(status='completed') {
  const h=createEnvironment(),read=bindReader(h);
  let state=makeState([makeRun('source-run',status,status==='completed'?'auto':'ask',status==='completed'?{
    appliedOperations:[{type:'edit',path:'main.tex',content:'after'}],undoOperations:[{type:'edit',path:'main.tex',replaceAll:'before'}],
    undoBaseFiles:[{path:'main.tex',content:'after'}],undoExpectedFiles:[{path:'main.tex',content:'after'}],
    undoTrackedChanges:[{path:'main.tex',id:'tracked-source'}],trackedChangeStatus:'pending'
  }:{})]);
  const requests=[],saves=[],toasts=[];
  const controller=Fork.create({SessionState,getState:()=>state,setState:value=>{state=value;},
    getScope:()=>({accountScopeId:h.accountScopeId,projectId:h.projectId,generation:1}),
    sendBackgroundNative:async request=>{requests.push(clone(request));assert.equal(request.method,'codex.thread.fork');return{ok:true,result:{threadId:'thread-fork-'+requests.length}};},
    saveState:async()=>{const result=await persist(h,state);saves.push(result);assert.equal(result.error,null);},applyStateToPanel:()=>{},showPluginToast:value=>toasts.push(value),tr:key=>key});
  const forked=await controller.forkRunFromNode('source-run');
  return {h,read,controller,requests,saves,forked,get state(){return state;},setState:value=>{state=value;}};
}
const actionCounts=run=>Object.fromEntries(['appliedOperations','undoOperations','undoBaseFiles','undoExpectedFiles','undoTrackedChanges'].map(k=>[k,run[k]?.length||0]));

test('008 CONTROL small actual main write and reload succeeds through shared sender/locks',async()=>{
  const h=createEnvironment();try {
    const state=makeState([makeRun('small')]),result=await persist(h,state);assert.equal(result.error,null);
    const read=await bindReader(h)();assert.equal(read.normalized.sessions[0].runs[0].id,'small');
    assert.ok(result.put.ok);assert.ok(result.put.wireEstimateBytes<24*1024*1024);
    observe('PROJ-008','small-main-writer-control',{...result,readRunCount:read.normalized.sessions[0].runs.length});
  }finally{h.close();}
});
test('008 medium main payload exceeds compact target without aggressive notice and remains readable',async()=>{
  const h=createEnvironment();try{
    const state=longState(10),result=await persist(h,state);assert.equal(result.error,null);
    const records=await h.StorageDb.getAllByIndex('sessions','projectId','project-a');
    const mainBytes=bytes(records);assert.ok(mainBytes>4*1024*1024);assert.ok(result.compactUtf8Bytes<4*1024*1024);assert.equal(result.onAggressive,0);
    const read=await bindReader(h)();assert.equal(read.normalized.sessions[0].runs.length,10);
    observe('PROJ-008','accepted-main-payload-over-compact-target',{...result,mainUtf8Bytes:mainBytes,readRunCount:read.normalized.sessions[0].runs.length});
  }finally{h.close();}
});
test('large main history survives initial and repeated shared writes without dropping text or recovery data',async()=>{
  const h=createEnvironment();try{
    const state=longState(20),last=state.sessions[0].runs.at(-1);
    last.mode='auto';last.status='interrupted';last.nativeEventSeq=42;
    last.interruptedDraft={requestId:'recovery-request',threadId:'thread-source',turnId:'turn-source',lastEventSeq:42,reason:'owner_lost'};
    last.appliedOperations=[{type:'edit',path:'main.tex',replaceAll:'after text'}];
    last.undoOperations=[{type:'edit',path:'main.tex',replaceAll:'before text'}];
    last.undoBaseFiles=[{path:'main.tex',content:'after text'}];
    const result=await persist(h,state,{recoveryRuns:[{sessionId:state.sessions[0].id,runId:last.id,projectId:h.projectId,accountScopeId:h.accountScopeId}]});
    assert.equal(result.error,null);
    const loaded=await bindReader(h)();
    assert.deepEqual(loaded.normalized.sessions[0].runs.map(run=>run.events.map(event=>event.title)),
      state.sessions[0].runs.map(run=>run.events.map(event=>event.title)));
    const restored=loaded.normalized.sessions[0].runs.at(-1);
    assert.deepEqual(plain(restored.undoOperations),plain(last.undoOperations));
    assert.deepEqual(plain(restored.undoBaseFiles),plain(last.undoBaseFiles));
    assert.deepEqual(plain(restored.interruptedDraft),plain(last.interruptedDraft));
    assert.equal(restored.nativeEventSeq,42);
    const next=loaded.normalized;
    next.sessions[0].task='later draft';next.sessions[0].updatedAt='2026-10-05T00:00:00.000Z';
    const repeated=await persist(h,next);assert.equal(repeated.error,null);
    assert.equal((await bindReader(h)()).normalized.sessions[0].task,'later draft');
  }finally{h.close();}
});
test('fork identity and action isolation survive real shared main write/read',async()=>{
  const f=await createForkFixture();try{
    const before=f.forked.runs[0],beforeActions=actionView(before).summary;
    assert.equal(before.forkSnapshot,true);assert.ok(before.forkSourceRunId);assert.ok(f.forked.forkedFromSessionId);
    assert.ok(Object.values(actionCounts(before)).every(n=>n===0));assert.equal(beforeActions.fork.disabled,true);
    const durable=(await f.h.StorageDb.getAllByIndex('sessions','projectId','project-a')).find(s=>s.id===f.forked.id);
    assert.equal(durable.forkedFromSessionId,'session-source');assert.equal(durable.runs[0].forkSnapshot,true);
    const read=await f.read();f.setState(read.normalized);
    const after=f.state.sessions.find(s=>s.id===f.forked.id).runs[0],view=actionView(after,id=>f.controller.forkRunFromNode(id));
    assert.equal(after.forkSnapshot,true);assert.equal(after.forkSourceRunId,'source-run');
    assert.equal(f.state.sessions.find(s=>s.id===f.forked.id).forkedFromSessionId,'session-source');
    assert.ok(Object.values(actionCounts(after)).every(n=>n===0));
    assert.equal(view.summary.undo.hidden,true);assert.equal(view.summary.accept.hidden,true);assert.equal(view.summary['sync-retry'].hidden,true);
    const actualEntryCalls=await checkActualUndoAcceptEntries(after);
    assert.equal(view.summary.fork.disabled,true);assert.equal(view.summary.fork.hasClick,false);const requestsBefore=f.requests.length;
    assert.equal(f.requests.length,requestsBefore);
    observe('PROJ-012','completed-fork-main-roundtrip',{beforeMarkers:{forkSnapshot:before.forkSnapshot,forkSourceRunId:before.forkSourceRunId},
      durableMarkers:{forkSnapshot:durable.runs[0].forkSnapshot??null,forkSourceRunId:durable.runs[0].forkSourceRunId??null,forkedFromSessionId:durable.forkedFromSessionId??null},
      afterMarkers:{forkSnapshot:after.forkSnapshot,forkSourceRunId:after.forkSourceRunId},beforeActions,afterActions:view.summary,
      actionCounts:actionCounts(after),actualEntryCalls,additionalForkRequests:f.requests.length-requestsBefore,threadIdPreserved:after.codexThreadId==='thread-source'});
  }finally{f.h.close();}
});
test('cancelled Ask fork keeps toolbar edit disabled after persisted reload',async()=>{
  const f=await createForkFixture('cancelled');try{
    const before=f.forked.runs[0],pre=actionView(before).summary;
    const read=await f.read(),after=read.normalized.sessions.find(s=>s.id===f.forked.id).runs[0],post=actionView(after).summary;
    assert.equal(pre.edit.hidden,true);assert.equal(post.edit.hidden,true);assert.equal(post.edit.hasClick,false);
    assert.equal(post.undo.hidden,true);assert.equal(post.accept.hidden,true);assert.equal(post['sync-retry'].hidden,true);
    observe('PROJ-012','cancelled-ask-toolbar-change',{beforeActions:pre,afterActions:post,actionCounts:actionCounts(after),noModelExecution:true});
  }finally{f.h.close();}
});
function legacyBlob(project,sessionId){return{activeSessionId:sessionId,mode:'ask',sessions:[{id:sessionId,title:'Old '+project,titleSource:'manual',task:'',createdAt:baseTime,updatedAt:baseTime,mode:'ask',codexThreadId:'old-thread-'+project,runs:[makeRun('old-run-'+project,'completed','ask',{runProjectId:project})]}]};}
const legacyKey=project=>StorageKeys.getProjectStorageKey('codexOverleafPanelState', 'https://www.overleaf.com/project/'+project);
test('reader retains separately persisted run and session fork provenance',async()=>{
  const f=await createForkFixture();try{
    const durable=await f.h.StorageDb.getRecord('sessions',f.forked.id);
    // This control isolates the real reader from the known writer omission.
    // It deliberately adds valid provenance at the raw store API, not via the builder.
    durable.forkedFromSessionId='session-source';durable.forkedFromRunId='source-run';
    durable.runs[0].forkSnapshot=true;durable.runs[0].forkSourceRunId='source-run';
    await f.h.StorageDb.putRecords('sessions',[durable]);
    const stored=await f.h.StorageDb.getRecord('sessions',f.forked.id);
    assert.equal(stored.forkedFromSessionId,'session-source');
    const read=await f.read(),loaded=read.loaded.sessions.find(s=>s.id===f.forked.id),normalized=read.normalized.sessions.find(s=>s.id===f.forked.id);
    assert.equal(loaded.forkedFromSessionId,'session-source');assert.equal(normalized.forkedFromSessionId,'session-source');
    assert.equal(normalized.runs[0].forkSnapshot,true);assert.equal(actionView(normalized.runs[0]).summary.fork.disabled,true);
    observe('PROJ-012','reader-provenance-control',{storedSessionOrigin:stored.forkedFromSessionId,loadedSessionOrigin:loaded.forkedFromSessionId??null,
      runMarkerRetained:normalized.runs[0].forkSnapshot,forkRemainsDisabled:true,rawStoreControl:true});
  }finally{f.h.close();}
});
test('014 CONTROL one old project migrates, then same account reload sees it and another account does not',async()=>{
  const h=createEnvironment({[legacyKey('project-a')]:legacyBlob('project-a','old-session-a')});try{
    const read=bindReader(h),first=await read();assert.equal(first.normalized.sessions[0].id,'old-session-a');
    assert.equal(h.io.values[legacyKey('project-a')],undefined);const second=await read();assert.equal(second.normalized.sessions[0].id,'old-session-a');
    h.select('account-two','project-a');const other=await read();assert.equal(other.loaded.sessions.length,0);
    h.select('account-one','project-a');assert.equal((await read()).loaded.sessions[0].id,'old-session-a');
    observe('PROJ-014','single-project-and-account-claim-controls',{ownFirstCount:first.loaded.sessions.length,ownReloadCount:second.loaded.sessions.length,otherAccountCount:other.loaded.sessions.length,legacyRemoved:true});
  }finally{h.close();}
});
test('old project blobs each migrate even after another project advances the global schema',async()=>{
  const initial={[legacyKey('project-a')]:legacyBlob('project-a','old-session-a'),[legacyKey('project-b')]:legacyBlob('project-b','old-session-b')};
  const h=createEnvironment(initial);try{
    const read=bindReader(h),a=await read();h.select('account-one','project-b');const b=await read();
    assert.equal(a.loaded.sessions.length,1);assert.equal(b.loaded.sessions.length,1);assert.equal(b.loaded.sessions[0].id,'old-session-b');assert.equal(h.io.values[legacyKey('project-b')],undefined);
    assert.equal(h.io.values.codexOverleafPrefs.storageSchemaVersion,h.StorageDb.TARGET_SCHEMA_VERSION);
    const bAlone=createEnvironment({[legacyKey('project-b')]:initial[legacyKey('project-b')]},{projectId:'project-b'});
    try{assert.equal((await bindReader(bAlone)()).loaded.sessions[0].id,'old-session-b');}finally{bAlone.close();}
    observe('PROJ-014','two-project-sequential-migration',{firstProjectCount:a.loaded.sessions.length,secondProjectCount:b.loaded.sessions.length,
      secondLegacyRetained:false,globalSchema:h.io.values.codexOverleafPrefs.storageSchemaVersion,secondMigratesWhenFirst:true,notPhysicalDeletion:true});
  }finally{h.close();}
});
test('014 CONTROL no legacy blob and tombstoned old sessions stay absent',async()=>{
  const blank=createEnvironment();try{assert.equal((await bindReader(blank)()).loaded.sessions.length,0);}finally{blank.close();}
  const blob=legacyBlob('project-a','old-session-a');blob.sessions.push({...clone(blob.sessions[0]),id:'deleted-old'});
  const h=createEnvironment({[legacyKey('project-a')]:blob});try{
    await h.Migration.addSessionTombstones('project-a',['deleted-old']);const read=await bindReader(h)();
    assert.deepEqual(read.loaded.sessions.map(s=>s.id),['old-session-a']);
    const stored=await h.StorageDb.getAllByIndex('sessions','projectId','project-a');assert.equal(stored.some(s=>s.id==='deleted-old'),false);
    observe('PROJ-014','missing-blob-and-tombstone-controls',{emptyCount:0,visibleIds:read.loaded.sessions.map(s=>s.id),deletedImported:false});
  }finally{h.close();}
});
test('shared writer CONTROL wrong captured account, missing account and a deleted session are rejected',async()=>{
  const h=createEnvironment();try{
    const state=makeState([makeRun('guarded')]);assert.equal((await persist(h,state)).error,null);
    const record=(await h.StorageDb.getAllByIndex('sessions','projectId','project-a'))[0];
    await assert.rejects(h.StorageDb.putRecords('sessions',[{...record,accountScopeId:'account-two'}]),e=>e.code==='account_scope_unavailable');
    await assert.rejects(PanelState.persistPanelState({state,compactState:{},projectId:'project-a',persistenceContext:{scope:{projectId:'project-a'}}}),e=>e.code==='account_scope_unavailable');
    await h.StorageDb.deleteRecord('sessions',record.id);
    await assert.rejects(h.StorageDb.putRecords('sessions',[record]),e=>e.code==='shared_session_deleted');
    observe('CONTROLS','shared-account-and-deletion-guards',{wrongAccountRejected:true,missingAccountRejected:true,deletedSessionRejected:true});
  }finally{h.close();}
});
test('legacy cleanup failure cannot replay old contents or let another account claim the source',async()=>{
  const h=createEnvironment({[legacyKey('project-a')]:legacyBlob('project-a','old-session-a')});
  try{
    h.io.chrome.storage.local.remove=async()=>{throw new Error('synthetic cleanup failure');};
    const first=await bindReader(h)();assert.equal(first.loaded.sessions.length,1);
    const record=await h.StorageDb.getRecord('sessions','old-session-a');record.task='new durable draft';record.updatedAt='2026-10-06T00:00:00.000Z';
    await h.StorageDb.putRecords('sessions',[record]);
    assert.equal((await bindReader(h)()).loaded.sessions[0].task,'new durable draft');
    h.select('account-two','project-a');assert.equal((await bindReader(h)()).loaded.sessions.length,0);
    assert.ok(h.io.values[legacyKey('project-a')]);
  }finally{h.close();}
});
test('failed legacy write retains source and claim for its original account retry',async()=>{
  const h=createEnvironment({[legacyKey('project-a')]:legacyBlob('project-a','old-session-a')});
  try{
    const put=h.StorageDb.putRecords;h.StorageDb.putRecords=async()=>{throw new Error('synthetic write failure');};
    await assert.rejects(h.Migration.runMigrationIfNeeded('project-a',legacyKey('project-a'),'account-one'),/synthetic write failure/);
    assert.ok(h.io.values[legacyKey('project-a')]);h.StorageDb.putRecords=put;
    h.select('account-two','project-a');const other=await h.Migration.runMigrationIfNeeded('project-a',legacyKey('project-a'),'account-two');
    assert.equal(other.sessions.length,0,'a failed import does not transfer its claimed source to another account');
    h.select('account-one','project-a');const own=await h.Migration.runMigrationIfNeeded('project-a',legacyKey('project-a'),'account-one');
    assert.equal(own.sessions[0].id,'old-session-a');
  }finally{h.close();}
});
test('migration retry after preference failure preserves newer sessions and current global preferences',async()=>{
  const h=createEnvironment({[legacyKey('project-a')]:legacyBlob('project-a','old-session-a')});
  try{
    const set=h.io.chrome.storage.local.set;let rejectPrefs=true;
    h.io.chrome.storage.local.set=async patch=>{if(rejectPrefs&&patch[h.Migration.PREFS_KEY])throw new Error('synthetic preference failure');return set(patch);};
    await assert.rejects(h.Migration.runMigrationIfNeeded('project-a',legacyKey('project-a'),'account-one'),/synthetic preference failure/);
    rejectPrefs=false;const current=await h.StorageDb.getRecord('sessions','old-session-a');
    current.task='newer saved draft';current.updatedAt='2026-10-06T00:00:00.000Z';await h.StorageDb.putRecords('sessions',[current]);
    await h.Migration.savePrefs({storageSchemaVersion:3,model:'current-global-model'},'account-one','project-a');
    const result=await h.Migration.runMigrationIfNeeded('project-a',legacyKey('project-a'),'account-one');
    assert.equal(result.sessions[0].task,'newer saved draft');assert.equal(result.prefs.model,'current-global-model');
    assert.equal(h.io.values[legacyKey('project-a')],undefined);
  }finally{h.close();}
});
test('legacy-admissible Chinese main history preserves contents through first and repeated saves',async()=>{
  const h=createEnvironment();try{
    const state=longState(16);
    for(const run of state.sessions[0].runs) for(const event of run.events)event.title='中文'.repeat(1100);
    const built=h.StorageDb.buildSessionRecord({...state.sessions[0],projectId:h.projectId,accountScopeId:h.accountScopeId},{preserveRunActionPayload:true});
    const entries=JSON.stringify([{record:built,base:null}]);
    assert.ok(entries.length*2<=24*1024*1024,'sample was accepted by the old receiver estimate');
    assert.ok(Buffer.byteLength(entries)>24*1024*1024,'sample exercises the Unicode compatibility window');
    assert.equal((await persist(h,state)).error,null);
    const loaded=await bindReader(h)();
    assert.deepEqual(loaded.normalized.sessions[0].runs.map(run=>run.events.map(event=>event.title)),state.sessions[0].runs.map(run=>run.events.map(event=>event.title)));
    loaded.normalized.sessions[0].task='后续草稿';loaded.normalized.sessions[0].updatedAt='2026-10-07T00:00:00.000Z';
    assert.equal((await persist(h,loaded.normalized)).error,null);
    assert.equal((await bindReader(h)()).normalized.sessions[0].task,'后续草稿');
  }finally{h.close();}
});
test.after(closeAll);
