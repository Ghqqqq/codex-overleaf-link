'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {harness,PROJECT,MAIN,TEXT}=require('./_helpers/projectScopeHarness');
const {extractFunction}=require('./_helpers/extractFunction');
const ContextTray=require('../extension/src/content/contextTray');
const Session=require('../extension/src/shared/sessionState');
const Snapshot=require('../extension/src/shared/runExecutionSnapshot');
const RunController=require('../extension/src/content/runController');
const Runner=require('../native-host/src/codexSessionRunner');

async function chipParams(project,selectedPath){
  let state=Session.normalizePanelState({mode:'auto',sessions:[Session.createSession({mode:'auto'})]});
  const tray=ContextTray.createContextTrayController({getState:()=>state,setState:value=>{state=value;},getPanel:()=>null,updateActiveSession:Session.updateActiveSession});
  await tray.selectFocusFile(selectedPath);
  assert.deepEqual(tray.getActiveFocusFiles(),[selectedPath]);
  const snapshot=Snapshot.capture({...state,focusFiles:tray.getActiveFocusFiles()});
  assert.deepEqual(snapshot.focusFiles,[selectedPath]);
  const c=vm.createContext({state,RunExecutionSnapshot:Snapshot,runController:RunController,getCurrentProjectId:()=>PROJECT,cachedAccountScopeId:'scope',
    currentRunView:{executionSnapshot:snapshot,sessionContext:state.session,recordId:'fixture',sessionId:state.activeSessionId},
    getEnabledCodexOverleafSkillIds:()=>[],getCustomInstructionsForCurrentProject:()=>'',getSkillLoadingSettings:()=>({loadCodexLocalSkills:false,loadCodexOverleafSkills:false})});
  vm.runInContext(extractFunction(fs.readFileSync(path.resolve(__dirname,'../extension/src/content/contentRuntime.js'),'utf8'),'buildCodexRunParams'),c);
  return c.buildCodexRunParams({task:'focus fixture',project,focusFiles:snapshot.focusFiles,restrictToFocusFiles:true,skillLoadingSettings:{loadCodexLocalSkills:false,loadCodexOverleafSkills:false}});
}

for(const focus of ['main.tex','@file:main.tex'])test('file chip → state → snapshot → runtime → Native focus keeps exact identity: '+focus,async t=>{
  const h=harness(t,{'main.tex':MAIN,'@file:main.tex':TEXT('literal prefix')});
  const params=await chipParams(await h.snapshot(),focus);assert.equal(params.focusFilesAreLiteral,true);assert.deepEqual(params.focusFiles,[focus]);
  let executeCalls=0;
  const task=Runner.runCodexSession({params,rootDir:h.rootDir,env:{},executeCodex:async({workspacePath})=>{
    executeCalls++;fs.writeFileSync(path.join(workspacePath,'main.tex'),MAIN+'main edit');fs.writeFileSync(path.join(workspacePath,'@file:main.tex'),TEXT('literal prefix')+'literal edit');
    return{assistantMessage:'isolated focus fixture'};
  }});
  if(process.platform==='win32') {await assert.rejects(task,{code:'project_path_unrepresentable'});assert.equal(executeCalls,0);return;}
  const result=await task;assert.deepEqual(result.syncChanges.map(item=>item.path),[focus]);
  assert.deepEqual(result.unsupportedChanges.map(item=>item.path),[focus==='main.tex'?'@file:main.tex':'main.tex']);
  assert.equal(result.unsupportedChanges[0].reason,'out_of_focus_partial_snapshot');
});

test('Content focused-partial evidence matches canonical names while explicitly legacy hints remain compatible',()=>{
  const project={files:[{path:'@file:main.tex',content:TEXT('only literal')}],capabilities:{fullProjectSnapshot:false}};
  const snapshotWarnings={blocking:['Full project snapshot was not captured']};
  assert.equal(RunController.canUseFocusedPartialSnapshot({project,snapshotWarnings,focusFiles:['main.tex'],focusFilesAreLiteral:true}),false);
  assert.equal(RunController.canUseFocusedPartialSnapshot({project,snapshotWarnings,focusFiles:['@file:main.tex'],focusFilesAreLiteral:true}),true);
  assert.equal(RunController.canUseFocusedPartialSnapshot({project,snapshotWarnings,focusFiles:['@file:main.tex'],focusFilesAreLiteral:'true'}),false);
  const legacyProject={...project,files:[{path:'main.tex',content:MAIN}]};
  assert.equal(RunController.canUseFocusedPartialSnapshot({project:legacyProject,snapshotWarnings,focusFiles:['@file:/main.tex']}),true);
});


test('the real Native handshake advertises literal-path semantics without changing required legacy capabilities',async t=>{
  const Native=require('../native-host/src/taskRunnerRuntime'),h=harness(t);
  const response=await Native.handleRequest({id:'literal-capability',method:'bridge.ping'}, {HOME:h.rootDir,CODEX_OVERLEAF_HOME:h.rootDir,CODEX_OVERLEAF_MIRROR_ROOT:h.rootDir,PATH:''});
  assert.equal(response.ok,true);assert.equal(response.result.capabilities.literalProjectPaths,true);
  assert.equal(response.result.capabilities.codexRun,true);
});


test('invalid literal focus cannot turn a requested restriction into an unrestricted result',async t=>{
  const h=harness(t,{'main.tex':MAIN});
  const params=await chipParams(await h.snapshot(),'main.tex');params.focusFiles=['../invalid'];
  const result=await Runner.runCodexSession({params,rootDir:h.rootDir,env:{},executeCodex:async({workspacePath})=>{
    fs.writeFileSync(path.join(workspacePath,'main.tex'),MAIN+'edited');return{assistantMessage:'isolated invalid-focus fixture'};
  }});
  assert.equal(result.syncChanges.length,0);assert.equal(result.unsupportedChanges[0].reason,'out_of_focus_partial_snapshot');
});
