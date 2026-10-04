'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {harness,PROJECT,MAIN,TEXT}=require('./_helpers/projectScopeHarness');
const ProjectFiles=require('../extension/src/shared/projectFiles');
const {createStoredZip}=require('./_helpers/storedZip');

test('literal percent filenames remain distinct through snapshot, reference and Native mirror consumers',async t=>{
  const files={'main.tex':MAIN,'chapter%20one.tex':TEXT('percent'),'chapter one.tex':TEXT('space'),'chapter%2520one.tex':TEXT('double-percent'),'100%.tex':TEXT('bare-percent'),'dir%2Fname.tex':TEXT('literal-separator-text')};
  const h=harness(t,files),project=await h.snapshot();assert.equal((await h.sync(project)).ok,true);
  assert.deepEqual(Array.from(project.files,file=>file.path),Object.keys(files));
  for(const [name,content] of Object.entries(files))assert.equal(h.read(name),content);
  const ref=await h.reference.readProject({projectId:PROJECT,requestId:'literal-files'});
  assert.equal(ref.ok,true);assert.deepEqual(Array.from(ref.files,file=>file.path),Object.keys(files));
  assert.equal(project.capabilities.fullProjectSnapshot,true);assert.equal(project.capabilities.contentComplete,true);
});

test('canonical path normalization is literal and URL decoding is explicit and single-result',()=>{
  for(const name of ['chapter%20one.tex','100%.tex','dir%2Fname.tex','%2e%2e/file.tex'])assert.equal(ProjectFiles.normalizeSafeProjectPath(name),name);
  assert.equal(ProjectFiles.normalizeUrlEncodedProjectPath('chapter%20one.tex'),'chapter one.tex');
  assert.equal(ProjectFiles.normalizeUrlEncodedProjectPath('chapter%2520one.tex'),'chapter%20one.tex');
  assert.equal(ProjectFiles.normalizeUrlEncodedProjectPath('100%25.tex'),'100%.tex');
  for(const name of ['../escape.tex','/absolute.tex','C:/drive.tex','dir\\bad.tex','dir//bad.tex'])assert.equal(ProjectFiles.normalizeSafeProjectPath(name),'');
  for(const name of ['%2e%2e/escape.tex','dir%2Fescape.tex','dir%252Fescape.tex','%2fabsolute.tex'])assert.equal(ProjectFiles.normalizeUrlEncodedProjectPath(name),'');
});

test('invalid ZIP paths are incomplete evidence and cannot authorize full mirror cleanup',async t=>{
  const h=harness(t,{'main.tex':MAIN,'../escape.tex':TEXT('unsafe')});
  const snapshot=await h.router.buildProjectSnapshot({zipOnly:true,includeContent:true,includeBinaryFiles:true});
  assert.equal(snapshot.capabilities.fullProjectSnapshot,false);
  assert.equal(snapshot.capabilities.contentComplete,false);
  assert.ok(snapshot.capabilities.skipped.some(item=>item.reason==='zip_path_invalid'));
  assert.equal((await h.sync(snapshot)).ok,false);
  assert.equal(fs.existsSync(h.mirror.workspacePath),false);
  const ref=await h.reference.readProject({projectId:PROJECT,requestId:'invalid-zip'});assert.equal(ref.ok,false);assert.equal(ref.code,'reference_project_incomplete');
});

test('duplicate literal ZIP entries fail completeness instead of silently selecting one payload',async t=>{
  const h=harness(t),zip=new Uint8Array(createStoredZip({'main.tex':MAIN,'same.tex':TEXT('one'),'twin.tex':TEXT('two')}));
  const from=Buffer.from('twin.tex'),to=Buffer.from('same.tex');let replacements=0;
  for(let i=0;i<=zip.length-from.length;i++)if(from.every((byte,j)=>zip[i+j]===byte)){zip.set(to,i);replacements++;}
  assert.equal(replacements,2,'replace central and local filename records only');h.setZip(zip.buffer);
  const snapshot=await h.router.buildProjectSnapshot({zipOnly:true,includeContent:true,includeBinaryFiles:true});
  assert.equal(snapshot.capabilities.fullProjectSnapshot,false);assert.equal(snapshot.capabilities.contentComplete,false);
  assert.ok(snapshot.capabilities.skipped.some(item=>item.reason==='zip_path_duplicate'));
  assert.equal((await h.sync(snapshot)).ok,false);
  assert.equal((await h.reference.readProject({projectId:PROJECT,requestId:'duplicate-zip'})).ok,false);
});

test('ordinary ZIP directory records do not degrade otherwise complete literal file identities',async t=>{
  const h=harness(t,{'main.tex':MAIN,'chapters/':'','chapters/a%20b.tex':TEXT('nested')});
  const snapshot=await h.snapshot();assert.equal(snapshot.capabilities.fullProjectSnapshot,true);assert.equal(snapshot.capabilities.contentComplete,true);
  assert.deepEqual(Array.from(snapshot.files,file=>file.path),['main.tex','chapters/a%20b.tex']);
  assert.equal((await h.sync(snapshot)).ok,true);assert.equal(h.read('chapters/a%20b.tex'),TEXT('nested'));
});


test('malformed UTF-8 ZIP names cannot silently become replacement characters with a complete snapshot',async t=>{
  const h=harness(t),zip=new Uint8Array(createStoredZip({'main.tex':MAIN,'bad.tex':TEXT('invalid name')}));
  const name=Buffer.from('bad.tex');let changed=0;
  for(let i=0;i<=zip.length-name.length;i++)if(name.every((byte,j)=>zip[i+j]===byte)){zip[i]=0xff;changed++;}
  assert.equal(changed,2);h.setZip(zip.buffer);
  const snapshot=await h.router.buildProjectSnapshot({zipOnly:true,includeContent:true,includeBinaryFiles:true});
  assert.equal(snapshot.capabilities.fullProjectSnapshot,false);assert.ok(snapshot.capabilities.skipped.some(item=>item.unknownPath===true));
  assert.equal((await h.sync(snapshot)).ok,false);
  assert.equal((await h.reference.readProject({projectId:PROJECT,requestId:'malformed-name'})).code,'reference_project_incomplete');
});

test('literal filenames survive Native diff, governance, Content planning, Page mutation and Undo preimages without a second decode',async t=>{
  const Mirror=require('../native-host/src/mirrorWorkspace');
  const {createFlow}=require('./_helpers/writebackOutcomeHarness');
  const files={'main.tex':MAIN,'a%20b.tex':TEXT('percent'),'a b.tex':TEXT('space'),'100%.tex':TEXT('bare'),'dir%2Fname.tex':TEXT('literal slash')};
  if(process.platform!=='win32')files['@file:main.tex']=TEXT('literal atfile');
  const h=harness(t,files);assert.equal((await h.sync(await h.snapshot())).ok,true);
  for(const name of Object.keys(files).filter(name=>name!=='main.tex'))fs.writeFileSync(path.join(h.mirror.workspacePath,name),files[name]+'Updated exact target.');
  const diff=await Mirror.collectMirrorChangesDetailed({projectId:PROJECT,rootDir:h.rootDir});
  assert.equal(diff.changes.length,Object.keys(files).length-1);
  const flow=createFlow({initialFiles:files,syncChanges:diff.changes,governance:{readonlyPatterns:['main.tex']}});
  const run=await flow.run();assert.equal(run.settlement.evidence.applied,'complete');
  for(const name of Object.keys(files))assert.equal(flow.f.files.get(name),files[name]+(name==='main.tex'?'':'Updated exact target.'));
  assert.deepEqual(new Map(run.undoExpectedFiles.map(file=>[file.path,file.content])),new Map(Object.entries(files).filter(([name])=>name!=='main.tex')));
});


test('unsupported outer whitespace is rejected as incomplete, while a literal @file: name is never stripped',async t=>{
  const h=harness(t,{'main.tex':MAIN,'@file:main.tex':TEXT('literal atfile')},'@file:main.tex');
  const valid=await h.snapshot();assert.equal(valid.activePath,'@file:main.tex');
  const synced=await h.sync(valid);
  if(process.platform==='win32'){assert.equal(synced.ok,false);assert.match(synced.error.message,/cannot be represented faithfully/);assert.equal(fs.existsSync(h.mirror.workspacePath),false);}
  else{assert.equal(synced.ok,true);assert.equal(h.read('@file:main.tex'),TEXT('literal atfile'));}
  for(const name of [' main.tex','main.tex ']){
    assert.equal(ProjectFiles.normalizeSafeProjectPath(name),'');
    h.setFiles({'main.tex':MAIN,[name]:TEXT('whitespace identity')});
    const snapshot=await h.router.buildProjectSnapshot({zipOnly:true,includeContent:true,includeBinaryFiles:true});
    assert.equal(snapshot.capabilities.fullProjectSnapshot,false);assert.equal(snapshot.capabilities.contentComplete,false);
    assert.ok(snapshot.capabilities.skipped.some(item=>item.path===name&&item.reason==='zip_path_invalid'));
  }
  const malformed=h.context.sanitizeRunProjectSnapshot({activePath:'@file:main.tex',files:[{path:'main.tex',content:MAIN},{path:'main.tex',content:'duplicate'}],capabilities:{fullProjectSnapshot:true}});
  assert.equal(malformed.activePath,'');assert.equal(malformed.capabilities.fullProjectSnapshot,false);assert.equal(malformed.files.length,0);
});

test('duplicate ZIP identity cannot enter the focused-partial execution path via its first entry or editor overlay',async t=>{
  const RunController=require('../extension/src/content/runController');
  const h=harness(t),zip=new Uint8Array(createStoredZip({'main.tex':MAIN,'dupe.tex':TEXT('second main'),'other.tex':TEXT('safe other')}));
  const from=Buffer.from('dupe.tex'),to=Buffer.from('main.tex');
  for(let i=0;i<=zip.length-from.length;i++)if(from.every((byte,j)=>zip[i+j]===byte))zip.set(to,i);
  h.setZip(zip.buffer);
  const project=await h.snapshot(),snapshotWarnings=h.context.getProjectSnapshotWarnings(project);
  assert.equal(project.files.some(file=>file.path==='main.tex'),false);
  assert.equal(RunController.canUseFocusedPartialSnapshot({project,snapshotWarnings,focusFiles:['main.tex']}),false);
  assert.equal(RunController.canUseFocusedPartialSnapshot({project,snapshotWarnings,focusFiles:['other.tex']}),true);
  const vm=require('node:vm'),{createRequire}=require('node:module');
  const filename=path.resolve(__dirname,'../native-host/src/taskRunnerRuntime.js'),realRequire=createRequire(filename),module={exports:{}};
  let runnerCalls=0;
  const requireGuard=id=>id==='./codexSessionRunner' ? {runCodexSession:async()=>{runnerCalls++;return{assistantMessage:'Guard control',syncChanges:[],unsupportedChanges:[]};}}
    : id==='./providerRuntime' ? {...realRequire(id),resolveRunProviderForRun:async()=>({modelId:'synthetic',reasoningEffort:'high',providerSelection:{kind:'builtin'}})} : realRequire(id);
  // The full request dispatcher, quotas, focused evidence, locks and cleanup are real;
  // only provider lookup and the final model runner are isolated from external state.
  vm.runInNewContext('(function(require,module,exports,process){'+fs.readFileSync(filename,'utf8')+'\n})',
    {AbortController,setTimeout,clearTimeout,Buffer,console})(requireGuard,module,module.exports,{env:{},platform:process.platform});
  const params={projectId:PROJECT,project,focusFiles:['main.tex'],restrictToFocusFiles:true,task:'guard fixture',mode:'auto'};
  const refused=await module.exports.handleRequest({id:'duplicate-focus',method:'codex.run',params},{CODEX_OVERLEAF_MIRROR_ROOT:h.rootDir});
  assert.equal(refused.ok,false);assert.equal(refused.error.code,'codex_run_requires_snapshot_evidence');assert.equal(runnerCalls,0);
  const accepted=await module.exports.handleRequest({id:'safe-focus',method:'codex.run',params:{...params,focusFiles:['other.tex']}},{CODEX_OVERLEAF_MIRROR_ROOT:h.rootDir});
  assert.equal(accepted.ok,true);assert.equal(runnerCalls,1);
});
