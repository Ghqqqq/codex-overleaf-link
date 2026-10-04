'use strict';
// Real Page capture, Content snapshot and Native mirror/selection chain; network and model execution are synthetic.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createHash,webcrypto}=require('node:crypto');
const os=require('node:os');
const repo=(()=>{let dir=__dirname;while(!fs.existsSync(path.join(dir,'extension/src/page/snapshotRouter.js'))){const up=path.dirname(dir);if(up===dir)throw new Error('repository_not_found');dir=up;}return dir;})();
const source=file=>fs.readFileSync(path.join(repo,file),'utf8');
const ProjectFiles=require(path.join(repo,'extension/src/shared/projectFiles'));
const SessionState=require(path.join(repo,'extension/src/shared/sessionState'));
const SelectionView=require(path.join(repo,'extension/src/content/selectionContextView'));
const RunSnapshot=require(path.join(repo,'extension/src/shared/runExecutionSnapshot'));
const RunController=require(path.join(repo,'extension/src/content/runController'));
const WritebackController=require(path.join(repo,'extension/src/content/writebackController'));
const ReferenceProjects=require(path.join(repo,'extension/src/page/referenceProjects'));
const Native=require(path.join(repo,'native-host/src/taskRunnerRuntime'));
const Runner=require(path.join(repo,'native-host/src/codexSessionRunner'));
const Mirror=require(path.join(repo,'native-host/src/mirrorWorkspace'));
const {createStoredZip}=require(path.join(repo,'test/_helpers/storedZip'));
const {extractFunction}=require(path.join(repo,'test/_helpers/extractFunction'));
const routerSource=source('extension/src/page/snapshotRouter.js');
const runtimeSource=source('extension/src/content/contentRuntime.js');
const pageSource=source('extension/src/pageBridge.js');
const diagnosticsSource=source('extension/src/content/diagnosticsPanel.js');
const PROJECT='e'.repeat(24);
const MAIN='\\documentclass{article}\n\\begin{document}\n'+ 'Synthetic stable project source. '.repeat(6)+'\n\\end{document}\n';
const TEXT=name=>'% '+name+'\n'+('Synthetic content for '+name+'. ').repeat(7);
const SELECTED='selected passage';
const BEFORE='Prefix remains stable.\n'+SELECTED+'\nSuffix remains stable.\n'+MAIN;
const AFTER=BEFORE.replace(SELECTED,'replacement passage');
const clone=value=>JSON.parse(JSON.stringify(value));
const sha=value=>createHash('sha256').update(value).digest('hex');
function harness(t,files={'main.tex':MAIN},active='main.tex'){
  const rootDir=fs.mkdtempSync(path.join(os.tmpdir(),'col-project-scope-'));
  t.after(()=>fs.rmSync(rootDir,{recursive:true,force:true}));
  let currentFiles={...files},activeText=currentFiles[active]||'',zip=createStoredZip(currentFiles);
  const fetches=[];
  const window={location:{href:'https://www.overleaf.com/project/'+PROJECT,origin:'https://www.overleaf.com'},
    CodexOverleafProjectFiles:ProjectFiles,btoa:text=>Buffer.from(text,'latin1').toString('base64'),setTimeout,clearTimeout};
  const fetch=async(url)=>{assert.ok(String(url).includes('/project/'+PROJECT+'/'),'only synthetic target project may be fetched');fetches.push(String(url));return{ok:true,headers:{get:key=>key==='content-type'?'application/zip':String(zip.byteLength)},arrayBuffer:async()=>zip};};
  const context=vm.createContext({window,TextDecoder,TextEncoder,AbortController,setTimeout,clearTimeout,fetch});
  vm.runInContext(routerSource,context);vm.runInContext(diagnosticsSource,context);
  const router=window.CodexOverleafSnapshotRouter.create({window,normalizePath:ProjectFiles.normalizeSafeProjectPath,
    readActiveEditorText:()=>activeText,treeOperations:{getProjectId:()=>PROJECT,getActiveFilePath:()=>active,
      getEditorStoreFilePath:()=>active,collectDocRecords:()=>[]}});
  Object.assign(context,{RUN_SNAPSHOT_ZIP_TIMEOUT_MS:30000,getActiveFocusFiles:()=>[],Modules:{ProjectFiles},
    DiagnosticsPanel:window.CodexOverleafDiagnosticsPanel,
    callPageBridge:async(method,params)=>{assert.equal(method,'getProjectSnapshot');return router.buildProjectSnapshot(params);}});
  for(const name of ['normalizeSnapshotPath','sanitizeRunProjectSnapshot','getRunProjectSnapshot','getProjectSnapshotWarnings','isTextSnapshotFile','uniqueContentSignatures'])vm.runInContext(extractFunction(runtimeSource,name),context);
  const mirror=Mirror.getProjectMirror(PROJECT,{rootDir});
  const reference=ReferenceProjects.create({window,fetch,snapshotRouter:router});
  const h={rootDir,mirror,context,router,reference,fetches,
    setZip(bytes){zip=bytes;},
    setFiles(next){currentFiles={...next};activeText=currentFiles[active]||'';zip=createStoredZip(currentFiles);},
    async snapshot(){return context.getRunProjectSnapshot();},
    async sync(project){return Native.handleRequest({id:'sync-fixture',method:'mirror.sync',params:{projectId:PROJECT,project}},{CODEX_OVERLEAF_MIRROR_ROOT:rootDir});},
    read(file){return fs.readFileSync(path.join(mirror.workspacePath,file),'utf8');},
    baseline(){return JSON.parse(fs.readFileSync(mirror.baselinePath,'utf8'));},
    snapshotEvidence(project){return {files:project.files.map(file=>({path:file.path,hash:sha(file.content||'')})),capabilities:{fullProjectSnapshot:project.capabilities.fullProjectSnapshot,contentComplete:project.capabilities.contentComplete,skipped:clone(project.capabilities.skipped||[])},warnings:clone(context.getProjectSnapshotWarnings(project))};}
  };return h;
}
async function captureSelection(text,mode='edit',options={}){
  const from=options.from ?? text.indexOf(SELECTED),to=options.to ?? (from+SELECTED.length);assert.ok(from>=0);
  const doc={toString:()=>text,lineAt:offset=>({number:text.slice(0,offset).split('\n').length})};
  const range={from,to,head:to,empty:false};
  const view={state:{doc,selection:{main:range,ranges:[range]}},dom:{getBoundingClientRect:()=>({top:0,bottom:500})},coordsAtPos:()=>({left:1,right:2,top:30,bottom:42})};
  let capturedProject=PROJECT;
  const crypto=options.changeDuringCapture?{subtle:{digest:async(...args)=>{const result=await webcrypto.subtle.digest(...args);view.state={...view.state,doc:{...doc,toString:()=>text+'later'}};return result;}}}:webcrypto;
  const ctx=vm.createContext({TextEncoder,Uint8Array,window:{crypto,innerHeight:700},getProjectId:()=>capturedProject,
    getCodeMirrorEditorView:()=>view,getActiveFilePath:()=> options.path || 'main.tex'});
  vm.runInContext(extractFunction(pageSource,'getSelectionContext'),ctx);
  const session=SessionState.createSession({mode:'auto'});session.id='selection-session';
  let state=SessionState.normalizePanelState({sessions:[session],activeSessionId:session.id});
  const calls={page:0,selectionWrite:0,notifications:[]};
  const selectionView=SelectionView.create({getProjectId:()=>PROJECT,getState:()=>state,getPanel:()=>null,openComposer:async()=>{},
    callPageBridge:async(method,params)=>{calls.page++;assert.equal(method,'getSelectionContext');if(options.wrongProducerProject)capturedProject='f'.repeat(24);return ctx.getSelectionContext(params);},
    setSelection:(selection,meta)=>{calls.selectionWrite++;state=SessionState.updateActiveSession(state,{selectionContext:selection,...(meta?.edit?{mode:'auto'}:{})});},
    toast:message=>calls.notifications.push(message)});
  const selected=await selectionView.attach(mode);
  if(options.wrongProducerProject||options.changeDuringCapture||options.returnResult)return{selected,calls};
  assert.ok(selected,'real attach must capture selection');
  assert.equal(selected.documentHash,sha(text));assert.equal(selected.text,SELECTED);
  const snapshot=RunSnapshot.capture({mode:state.mode,providerId:'builtin',model:'synthetic-no-model',reasoningEffort:'high',speedTier:'standard',requireReviewing:false,
    focusFiles:[],selectionContext:selectionView.capture()});
  const build=vm.createContext({RunExecutionSnapshot:RunSnapshot,runController:RunController,state,
    currentRunView:{executionSnapshot:snapshot,sessionContext:state.session,recordId:'run-fixture',sessionId:session.id,runAccountScopeId:'account-fixture'},
    getCurrentProjectId:()=>PROJECT,cachedAccountScopeId:'account-fixture',getEnabledCodexOverleafSkillIds:()=>[],getCustomInstructionsForCurrentProject:()=>'',
    getSkillLoadingSettings:()=>({loadCodexLocalSkills:false,loadCodexOverleafSkills:false})});
  vm.runInContext(extractFunction(runtimeSource,'buildCodexRunParams'),build);
  return{selected,calls,params:project=>build.buildCodexRunParams({task:'Change only the captured passage.',project,focusFiles:[],
    customInstructions:'',skillLoadingSettings:{loadCodexLocalSkills:false,loadCodexOverleafSkills:false},enabledCodexOverleafSkillIds:[],attachments:[],skillInvocation:null,submittedMode:state.mode})};
}
async function runSelected(h,selection,mutate){
  const project=await h.snapshot();assert.equal(h.context.getProjectSnapshotWarnings(project).blocking.length,0);
  const params=selection.params(project);assert.equal(params.selectionContext.documentHash,selection.selected.documentHash);
  const events=[];let executeCalls=0,promptHasSelection=false,executedSelection=null,result=null,error=null;
  try{
    result=await Runner.runCodexSession({params,rootDir:h.rootDir,env:{},emit:event=>events.push(event),executeCodex:async input=>{
      executeCalls++;assert.equal(input.workspacePath,h.mirror.workspacePath);assert.equal(input.loadCodexLocalSkills,false);assert.equal(input.loadCodexOverleafSkills,false);
      promptHasSelection=input.task.includes(selection.selected.documentHash)&&input.task.includes(SELECTED);
      const captured=input.task.match(/Captured editor selection[^\n]*\n(\{[^\n]*\})/);
      if(captured)executedSelection=JSON.parse(captured[1]);
      await mutate(input.workspacePath);return{assistantMessage:'Synthetic local runner completed.',threadId:'synthetic-thread'};
    }});
  }catch(failure){error={code:failure.code,message:failure.message};}
  const operations=result?WritebackController.buildSyncApplyOperations(result.syncChanges,project):[];
  return{result,error,executeCalls,promptHasSelection,executedSelection,events,operations,summary:{error,executeCalls,promptHasSelection,
    changedPaths:result?.syncChanges.map(change=>change.path)||[],unsupported:result?.unsupportedChanges.map(change=>({path:change.path,reason:change.reason}))||[],
    writebackOperationPaths:operations.map(operation=>operation.path),localMainHash:sha(h.read('main.tex')),baselineDirty:h.baseline().dirty===true}};
}


module.exports={harness,captureSelection,runSelected,PROJECT,MAIN,TEXT,SELECTED,BEFORE,AFTER,sha,clone};
