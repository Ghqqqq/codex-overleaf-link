'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),Module=require('node:module'),crypto=require('node:crypto'),cp=require('node:child_process');
const ROOT=path.resolve(__dirname,'../..'),read=f=>fs.readFileSync(path.join(ROOT,f),'utf8'),req=f=>require(path.join(ROOT,f));
const clone=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x)),no=()=>{},sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const source=read,temporary=[];
const Mirror=req('native-host/src/mirrorWorkspace'),OriginalRunner=req('native-host/src/codexSessionRunner'),Environment=req('native-host/src/nativeEnvironment');
const ProjectFiles=req('extension/src/shared/projectFiles'),Controller=req('extension/src/content/writebackController'),Plan=req('extension/src/content/writebackPlan'),Broker=req('extension/src/content/assetTransferBroker'),Governance=req('extension/src/shared/governanceRules');
const { harness: retryHarness }=require('./runRetryHarness');
const PROJECT='project-one',BASE='Synthetic manuscript baseline text for exact project content verification. '.repeat(4),SAVED=BASE+'\nSAVED_POST_IMAGE_A',LATE=BASE+'\nEXTERNAL_LATE_IMAGE_B';
const project=(content=BASE,full=true)=>({id:PROJECT,activePath:'main.tex',files:[{path:'main.tex',kind:'text',source:'overleaf-zip',content}],capabilities:{fullProjectSnapshot:full,method:'overleaf-zip'}});
function nativeFixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'col-b02-mirror-'));temporary.push(root);
  const env={HOME:root,CODEX_OVERLEAF_HOME:path.join(root,'home'),CODEX_OVERLEAF_USER_CODEX_HOME:path.join(root,'user-codex'),CODEX_OVERLEAF_CODEX_HOME:path.join(root,'plugin-codex'),CODEX_OVERLEAF_PROVIDER_STORE_DIR:path.join(root,'providers'),CODEX_OVERLEAF_MIRROR_ROOT:path.join(root,'mirrors')};
  const executions=[],calls=[],debug=[];let customExecute=null;
  const filename=path.join(ROOT,'native-host/src/taskRunnerRuntime.js'),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
  m.require=function(name){
    if(name==='./nativeEnvironment')return{...Environment,refreshCodexRuntimeEnv:e=>({...e,CODEX_OVERLEAF_ENV_READY:'1',CODEX_OVERLEAF_CODEX_PATH:process.execPath,CODEX_OVERLEAF_CODEX_RUNTIME_JSON:''})};
    if(name==='./debugLog')return{...req('native-host/src/debugLog'),logDebug:(event,detail)=>debug.push({event,detail:clone(detail)})};
    if(name==='./codexSessionRunner')return{...OriginalRunner,runCodexSession:input=>OriginalRunner.runCodexSession({...input,executeCodex:async value=>{
      executions.push({params:clone(input.params),workspacePath:value.workspacePath,content:fs.readFileSync(path.join(value.workspacePath,'main.tex'),'utf8')});
      if(customExecute)return customExecute(value);
      return{assistantMessage:'Synthetic read completed.',threadId:'synthetic-thread',syncChanges:[]};
    }})};
    return Module.prototype.require.call(this,name);
  };
  m._compile(source('native-host/src/taskRunnerRuntime.js'),filename);
  const runtime=m.exports;let seq=0;
  async function dispatch(method,params,id){const request={id:id||'request-'+(++seq),method,params};const result=await runtime.handleRequest(request,env);calls.push({request:clone(request),result:clone(result)});return result;}
  const mirror=Mirror.getProjectMirror(PROJECT,{rootDir:env.CODEX_OVERLEAF_MIRROR_ROOT});
  const baseline=()=>JSON.parse(fs.readFileSync(mirror.baselinePath,'utf8'));
  return{root,env,runtime,mirror,baseline,executions,calls,debug,dispatch,setExecute:fn=>{customExecute=fn},
    async seed(p=project()){const r=await dispatch('mirror.sync',{projectId:PROJECT,project:p});assert.equal(r.ok,true,JSON.stringify(r));return p;},
    async status(){const r=await dispatch('mirror.status',{projectId:PROJECT});assert.equal(r.ok,true);return r.result;},
    clean(){assert.equal(runtime.getActiveNativeWorkState().projectLocks,0);assert.equal(runtime.getActiveNativeWorkState().runControllers,0);fs.rmSync(root,{recursive:true,force:true});assert.equal(fs.existsSync(root),false);}};
}
function foreignWrite(file,content){cp.execFileSync(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'base64'))",file,Buffer.from(content).toString('base64')],{stdio:'pipe'});}

async function writebackScenario(options={}) {
 const n=nativeFixture();try{
  const content=options.content??SAVED;
  let before=await n.seed(),remote=new Map(before.files.map(f=>[f.path,f.content]));
  if(options.unread){before={...before,capabilities:{...before.capabilities,skipped:[{path:'large.png',reason:'binary_file_too_large',size:10485761}]}};await n.seed(before);}
  const target=options.create?'new.tex':'main.tex';fs.writeFileSync(path.join(n.mirror.workspacePath,target),content);
  const events=[],reports=[],nativeCalls=[],pageCalls=[],settlements=[],applied=[];
  const view={runProjectId:PROJECT,recordId:'run-proof',sessionId:'session-proof'};
  let currentProjectId=PROJECT;
  const getAppliedEntries=x=>x?.applied||[],getSkippedEntries=x=>x?.skipped||[],tx=x=>x,tr=x=>x;
  const plan=Plan.create({tx,tr,normalizeSafeProjectPath:ProjectFiles.normalizeSafeProjectPath,GovernanceRules:Governance,getGovernanceRulesForCurrentProject:()=>({}),showPluginConfirm:async()=>true,formatOperationFiles:()=>'',getAppliedEntries,getSkippedEntries});
  const sendBackgroundNative=async request=>{
   nativeCalls.push(clone(request));
   if(request.method==='mirror.confirmWriteback'){
     if(options.late)foreignWrite(path.join(n.mirror.workspacePath,'main.tex'),LATE);
     if(options.dirty)await n.dispatch('mirror.invalidate',{projectId:PROJECT});
   }
   const response=await n.dispatch(request.method,request.params);
   if(request.method==='mirror.confirmWriteback'){
     if(options.navigateDuringConfirm)currentProjectId='other-project';
     if(options.confirmReply==='missing')delete response.result.confirmed;
     if(options.confirmReply==='wrong')response.result.confirmed=[{path:target,hash:sha(LATE)}];
     if(options.confirmReply==='duplicate')response.result.confirmed=[{path:target,hash:sha(LATE)},{path:target,hash:sha(content)}];
   }
   return response;
  };
  const callPageBridge=async(method,params={})=>{
    pageCalls.push({method,params:clone(params)});
    if(method==='applyOperations')return{ok:true,applied:params.operations.map(operation=>{remote.set(operation.path,content);return{operation,result:{ok:true,changedDocument:true,verified:true,
      ...(options.missingProof?{}:{verifiedContent:content}),
      ...(operation.type==='create'?{saveReceipt:{v:1,projectId:PROJECT,path:operation.path,source:'overleaf-zip',verifiedAt:new Date().toISOString(),sha256:sha(content)}}:{})}};}),skipped:[]};
    if(method==='waitForSaveState')return{ok:true,state:'verified_saved'};
    if(method==='invalidateProjectSnapshot')return{ok:true};
    if(method==='getProjectSnapshot')return{id:PROJECT,files:[...remote].map(([path,content])=>({path,content,kind:'text',source:'overleaf-zip'})),capabilities:before.capabilities};
    throw new Error('Unexpected page method '+method);
  };
  const outer=vm.createContext({window:{},module:{exports:{}},require:name=>req('extension/src/shared/'+name.replace(/^\.\//,''))});
  vm.runInContext(source('extension/src/shared/writebackSettlement.js'),outer);const settlement=outer.module.exports;
  vm.runInContext(source('extension/src/content/writebackOrchestrator.js'),outer);
  const orchestrator=outer.window.CodexOverleafWritebackOrchestrator.create({...plan,tr,tx,getLocale:()=> 'en',getState:()=>({mode:'auto',requireReviewing:false,autoRecompile:false}),getCurrentRunView:()=>view,getCurrentProjectId:()=>currentProjectId,getAssistantAnswerForCurrentRun:()=> 'Synthetic edit.',cleanFinalAnswer:x=>x,
    appendRunEvent:x=>events.push(clone(x)),appendRunRecordEvent:no,appendChangeSummary:()=> 'synced',appendCompletionReport:x=>reports.push(clone(x)),appendOperationsPreview:no,appendPartialWritebackWarning:no,appendApplyResult:x=>applied.push(clone(x)),renderReadOnlyDiffReview:no,showPluginConfirm:async()=>true,ensureReviewingBeforeWrite:async()=>({ok:true}),recordUndoFromApply:no,
    assetTransferBroker:Broker.create({callPageBridge,sendBackgroundNative}),callPageBridge,sendBackgroundNative,writebackController:Controller,writebackSettlement:settlement,buildSyncApplyOperations:Controller.buildSyncApplyOperations,getAppliedOperationPaths:Controller.getAppliedOperationPaths,getAppliedSyncChanges:Controller.getAppliedSyncChanges,getSkippedEntries,
    hasApplyResultEntries:x=>getAppliedEntries(x).length+getSkippedEntries(x).length>0,hasSkippedApplyOperations:xs=>xs.some(x=>getSkippedEntries(x).length),formatWritebackSkippedNextStep:()=>'',resetContextProject:no,sanitizeRunProjectSnapshot:x=>x,RUN_SNAPSHOT_ZIP_TIMEOUT_MS:30000,onMirrorRefreshSettled:x=>settlements.push(clone(x))});
  const change=options.create?{type:'create',path:target,content}:{type:'write',path:target,previousContent:BASE,previousExists:true,content};
  const result=await orchestrator.applySyncChangesToOverleaf([change],before,{mode:'auto',requireReviewing:false,autoRecompile:false});await orchestrator.getPendingMirrorRefresh();
  return{result:clone(result),baseline:n.baseline(),status:await n.status(),remote:[...remote],nativeCalls,pageCalls,settlements,nativeResults:n.calls,events,reports,target,content,pending:orchestrator.getPendingMirrorRefresh()};
 }finally{n.clean();}
}

async function otScenario(options={}) {
 const n=nativeFixture();try{
  const focusPath=options.focusPath||'main.tex';
  const focusedProject=(content,full=true)=>{const value=project(content,full);value.activePath=focusPath;value.files[0].path=focusPath;return value;};
  const baseProject=project();if(focusPath!=='main.tex')baseProject.files.push({path:focusPath,kind:'text',content:BASE});if(options.extraActive)baseProject.files.push({path:'other.tex',kind:'text',content:BASE});await n.seed(baseProject);
  const OtController=req('extension/src/content/otWarmMirrorController');
  const queued=OtController.queuePatchEvents([],[{path:focusPath,baseHash:sha(BASE),nextContent:SAVED,observedAt:new Date().toISOString(),observedVersion:2}]);assert.equal(queued.ok,true);
  const request=OtController.buildPatchFilesRequest({projectId:PROJECT,events:queued.queue});
  const patch=await n.dispatch(request.method,request.params);assert.equal(patch.result.appliedFiles.length,1);
  if(options.stale!==false){const b=n.baseline();b.lastFullSyncAt='2000-01-01T00:00:00.000Z';b.capturedAt=b.lastFullSyncAt;fs.writeFileSync(n.mirror.baselinePath,JSON.stringify(b));}
  const initial=options.missingOverlay?{...focusedProject(SAVED,false),files:[]}:focusedProject(options.mismatch?LATE:SAVED,false);
  if(options.extraActive){initial.activePath='other.tex';initial.files.push({path:'other.tex',content:BASE,kind:'text'});}
  const retry=options.badSnapshot?{...focusedProject(SAVED,false),files:[]}:focusedProject(options.sensitive?LATE+'\n-----BEGIN SYNTHETIC PRIVATE KEY-----':options.mismatch?LATE:SAVED);
  const h=retryHarness({initialProject:initial,retryProject:retry,focusFiles:[focusPath],approve:false,stale:false}),c=h.context;
  c.state.experimentalOtByProject={[PROJECT]:options.enabled!==false};const trace=[];
  c.sendBackgroundNative=async request=>{h.io.backgroundCalls.push(request.method);const response=await n.dispatch(request.method,request.params);if(options.scopeChange&&request.method==='mirror.status')h.changeProject();return response;};
  c.nativeChannel.sendNativeTracked=request=>{const id='content-'+(h.io.requests.length+1);h.io.requests.push(clone(request.params));return{id,promise:n.dispatch(request.method,request.params,id).then(response=>{trace.push({id,request:clone(request.params),response:clone(response)});return response;})};};
  if(options.cancelRetry)c.getRunProjectSnapshot=async()=>{h.io.snapshotReads++;c.runCancellationRequested=true;c.runCancellationController.abort();return clone(retry);};
  await h.start();assert.deepEqual(h.io.errors,[],h.io.errors.join(';'));
  return{trace,run:clone(c.state.sessions.find(s=>s.id==='A').runs[0]),executions:n.executions,snapshotReads:h.io.snapshotReads,retryGuards:h.io.retryGuards,scans:h.io.scans,baseline:n.baseline(),mirrorContent:fs.readFileSync(path.join(n.mirror.workspacePath,focusPath),'utf8')};
 }finally{n.clean();}
}
module.exports={nativeFixture,writebackScenario,otScenario,PROJECT,BASE,SAVED,LATE,project,sha};
