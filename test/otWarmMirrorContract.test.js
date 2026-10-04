'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {nativeFixture,otScenario,PROJECT,BASE,SAVED,LATE,sha}=require('./_helpers/mirrorProofHarness');
for(const stale of [false,true])test('real OT producer reaches Native with matching current overlay in one run; stale whole mirror='+stale,async()=>{
 const r=await otScenario({stale});assert.equal(r.trace.length,1);assert.equal(r.trace[0].request.otWarmStart,true);assert.equal(r.trace[0].response.ok,true);assert.equal(r.executions.length,1);assert.equal(r.snapshotReads,0);assert.equal(r.run.status,'completed');assert.equal(r.mirrorContent,SAVED);
});
// Windows rejects ':' before materialization; projectScope/literalFocusIdentity cover that guard.
for(const focusPath of ['@file:main.tex','a%20b.tex'])test('real OT producer preserves the literal focused path through Native admission: '+focusPath,{skip:process.platform==='win32'&&focusPath.includes(':')},async()=>{
 const r=await otScenario({focusPath});assert.equal(r.trace.length,1);assert.equal(r.trace[0].request.otWarmStart,true);assert.equal(r.trace[0].request.focusFilesAreLiteral,true);assert.deepEqual(r.trace[0].request.focusFiles,[focusPath]);assert.deepEqual(r.trace[0].request.fileOverlays.map(file=>file.path),[focusPath]);assert.equal(r.trace[0].response.ok,true);assert.equal(r.snapshotReads,0);assert.equal(r.executions.length,1);assert.equal(r.run.status,'completed');assert.equal(r.mirrorContent,SAVED);
});
test('OT producer passes only its focused overlays when another editor file is active',async()=>{
 const r=await otScenario({extraActive:true});assert.equal(r.trace.length,1);assert.deepEqual(r.trace[0].request.fileOverlays.map(x=>x.path),['main.tex']);assert.equal(r.trace[0].response.ok,true);
});
test('a changed current overlay is rejected before mutation and the actual retry refreshes it',async()=>{
 const r=await otScenario({mismatch:true});assert.equal(r.trace.length,2);assert.equal(r.trace[0].response.error.code,'mirror_stale');assert.equal(r.trace[1].request.otWarmStart,undefined);assert.equal(r.executions.length,1);assert.equal(r.snapshotReads,1);assert.equal(r.scans.length,2);assert.equal(r.run.status,'completed');assert.equal(r.mirrorContent,LATE);
});
for(const options of [{mismatch:true,badSnapshot:true},{mismatch:true,sensitive:true},{mismatch:true,cancelRetry:true},{scopeChange:true}])test('OT retry keeps safety/cancel/project guards '+JSON.stringify(options),async()=>{
 const r=await otScenario(options);assert.equal(r.executions.length,0);assert.equal(r.trace.length,options.scopeChange?0:1);assert.equal(r.run.status,options.cancelRetry||options.scopeChange?'cancelled':'failed');assert.equal(r.mirrorContent,SAVED);
});
for(const options of [{enabled:false,stale:false},{missingOverlay:true}])test('ordinary warm and full-read fallback still work '+JSON.stringify(options),async()=>{
 const r=await otScenario(options);assert.equal(r.trace.length,1);assert.equal(r.trace[0].response.ok,true);assert.equal(r.executions.length,1);assert.equal(r.run.status,'completed');
});
test('Native OT overlay proof cannot mutate baseline via an injected hash or an extra path',async()=>{
 const n=nativeFixture();try{
  await n.seed();await n.dispatch('mirror.patchFiles',{projectId:PROJECT,files:[{path:'main.tex',baseHash:sha(BASE),nextContent:SAVED,observedAt:new Date().toISOString()}],source:'ot'});const before=n.baseline();
  const p={projectId:PROJECT,task:'Read only',mode:'ask',model:'fixture-model',useExistingMirror:true,otWarmStart:true,restrictToFocusFiles:true,focusFiles:['main.tex'],loadCodexLocalSkills:false,loadCodexOverleafSkills:false};
  const good=await n.dispatch('codex.run',{...p,fileOverlays:[{path:'main.tex',content:SAVED,hash:'untrusted'}]});assert.equal(good.ok,true);assert.deepEqual(n.baseline(),before);
  const bad=await n.dispatch('codex.run',{...p,fileOverlays:[{path:'main.tex',content:SAVED},{path:'other.tex',content:BASE}]});assert.equal(bad.error.code,'mirror_stale');assert.deepEqual(n.baseline(),before);assert.equal(n.executions.length,1);
 }finally{n.clean();}
});
