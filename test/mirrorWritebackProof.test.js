'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const Controller=require('../extension/src/content/writebackController');
const {nativeFixture,writebackScenario,PROJECT,BASE,SAVED,LATE,sha}=require('./_helpers/mirrorProofHarness');
for(const content of [SAVED,''])test('verified text post-image permits in-place confirmation: '+(content?'text':'empty'),async()=>{
 const r=await writebackScenario({content});assert.equal(r.result.hasSkippedOperations,false);assert.equal(r.result.settlement.facts.evidence.saved,'verified');
 const request=r.nativeCalls.find(x=>x.method==='mirror.confirmWriteback');assert.ok(request);assert.deepEqual(request.params.expectedFiles,[{path:'main.tex',sha256:sha(content)}]);
 assert.equal(r.nativeCalls.some(x=>x.method==='mirror.sync'),false);assert.equal(r.baseline.files.find(x=>x.path==='main.tex').content,content);assert.equal(r.settlements[0].state,'complete');assert.equal(r.pending,null);
});
test('late external mirror content cannot be acknowledged as the saved page post-image',async()=>{
 const r=await writebackScenario({late:true});const confirmation=r.nativeResults.find(x=>x.request.method==='mirror.confirmWriteback');
 assert.equal(confirmation.result.result.ok,false);assert.equal(confirmation.result.result.reason,'postimage_mismatch');
 assert.ok(r.nativeCalls.some(x=>x.method==='mirror.sync'));assert.equal(r.baseline.files.find(x=>x.path==='main.tex').content,SAVED);assert.equal(r.status.exists,true);assert.equal(r.result.hasSkippedOperations,false);
});
test('missing verified post-image uses full snapshot fallback without attempting proofless confirmation',async()=>{
 const r=await writebackScenario({missingProof:true});assert.equal(r.nativeCalls.some(x=>x.method==='mirror.confirmWriteback'),false);assert.ok(r.nativeCalls.some(x=>x.method==='mirror.sync'));assert.equal(r.baseline.files.find(x=>x.path==='main.tex').content,SAVED);
});
for(const options of [{create:true},{dirty:true},{unread:true}])test('existing structural/dirty/unread fallback stays available '+JSON.stringify(options),async()=>{
 const r=await writebackScenario(options);assert.equal(r.result.hasSkippedOperations,false);
 if(options.create)assert.equal(r.nativeCalls.some(x=>x.method==='mirror.confirmWriteback'),false);
 if(options.unread){assert.equal(r.status.exists,false);assert.equal(r.settlements[0].state,'not-attempted');}else{assert.equal(r.settlements[0].state,'complete');assert.ok(r.nativeCalls.some(x=>x.method==='mirror.sync'));}
});
test('confirmation proof builder refuses structural, binary, failed and unverified results',async()=>{
 for(const type of ['create','delete','rename','binary-create','overwrite-binary'])assert.equal(await Controller.buildMirrorWritebackConfirmation({applied:[{operation:{type,path:'main.tex'},result:{ok:true,verified:true,verifiedContent:'x'}}]}),null);
 for(const result of [{ok:false,verified:true,verifiedContent:'x'},{ok:true,verifiedContent:'x'},{ok:true,verified:true}])assert.equal(await Controller.buildMirrorWritebackConfirmation({applied:[{operation:{type:'edit',path:'main.tex'},result}]}),null);
});
test('Native refuses proofless or mismatched confirmation without updating any baseline entry',async()=>{
 const n=nativeFixture();try{
  await n.seed({files:[{path:'main.tex',content:BASE},{path:'other.tex',content:BASE}],capabilities:{fullProjectSnapshot:true}});const before=n.baseline();
  fs.writeFileSync(path.join(n.mirror.workspacePath,'main.tex'),SAVED);fs.writeFileSync(path.join(n.mirror.workspacePath,'other.tex'),LATE);
  const missing=await n.dispatch('mirror.confirmWriteback',{projectId:PROJECT,paths:['main.tex']});assert.equal(missing.result.ok,false);
  const mismatch=await n.dispatch('mirror.confirmWriteback',{projectId:PROJECT,paths:['main.tex','other.tex'],expectedFiles:[{path:'main.tex',sha256:sha(SAVED)},{path:'other.tex',sha256:sha(SAVED)}]});assert.equal(mismatch.result.reason,'postimage_mismatch');assert.deepEqual(n.baseline(),before);
 }finally{n.clean();}
});
for(const confirmReply of ['missing','wrong','duplicate'])test('unproven or contradictory Native confirmation falls back: '+confirmReply,async()=>{
 const r=await writebackScenario({confirmReply});assert.ok(r.nativeCalls.some(x=>x.method==='mirror.confirmWriteback'));assert.ok(r.nativeCalls.some(x=>x.method==='mirror.sync'));
 assert.equal(r.baseline.files.find(x=>x.path==='main.tex').content,SAVED);assert.equal(r.settlements[0].state,'complete');
});
test('scope change while Native confirms cannot publish mirror confirmation for the newly active project',async()=>{
 const r=await writebackScenario({navigateDuringConfirm:true});assert.equal(r.settlements[0].state,'not-attempted');assert.ok(r.nativeCalls.some(x=>x.method==='mirror.invalidate'));
 assert.equal(r.nativeCalls.some(x=>x.method==='mirror.sync'),false);assert.equal(r.events.some(x=>/workspace confirmed in place/.test(x.title||'')),false);
});
test('malformed/duplicate proofs and binary targets do not change the Native baseline',async()=>{
 const n=nativeFixture();try{
  await n.seed({files:[{path:'main.tex',content:BASE},{path:'figure.png',kind:'binary',size:1,contentBase64:'YQ=='}],capabilities:{fullProjectSnapshot:true}});const before=n.baseline();
  for(const expectedFiles of [[null],[{path:'main.tex',sha256:'bad'}],[{path:'main.tex',sha256:sha(BASE)},{path:'main.tex',sha256:sha(BASE)}]]){
    const paths=expectedFiles.length===2?['main.tex','main.tex']:['main.tex'];
    const r=await n.dispatch('mirror.confirmWriteback',{projectId:PROJECT,paths,expectedFiles});assert.equal(r.result.ok,false);assert.deepEqual(n.baseline(),before);
  }
  const binary=await n.dispatch('mirror.confirmWriteback',{projectId:PROJECT,paths:['figure.png'],expectedFiles:[{path:'figure.png',sha256:sha('a')}]});assert.equal(binary.result.reason,'not_text');assert.deepEqual(n.baseline(),before);
  assert.equal(await Controller.buildMirrorWritebackConfirmation({applied:[null]}),null);
 }finally{n.clean();}
});
