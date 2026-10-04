'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {harness,captureSelection,runSelected,BEFORE,AFTER,TEXT,SELECTED,sha}=require('./_helpers/projectScopeHarness');
const Selection=require('../extension/src/shared/selectionContext');
const Scope=require('../native-host/src/selectionScope');
const Snapshot=require('../extension/src/shared/runExecutionSnapshot');
const Queue=require('../extension/src/shared/runInputQueue');
const StorageDb=require('../extension/src/shared/storageDb');

test('selection capture proof survives queue and main run serialization without capturing full document text',async()=>{
  const capture=await captureSelection(BEFORE),proof=capture.selected.rebaseEvidence;assert.ok(proof);
  assert.equal(proof.documentLength,BEFORE.length);assert.equal(proof.prefixHash,sha(BEFORE.slice(0,capture.selected.from)));assert.equal(proof.suffixHash,sha(BEFORE.slice(capture.selected.to)));
  const snapshot=Snapshot.capture({mode:'auto',providerId:'builtin',model:'fixture',selectionContext:capture.selected});
  const item=Queue.enqueue([],{text:'edit',payload:Snapshot.toQueuePayload(snapshot)}).item;
  const queued=Queue.claimNext(Queue.normalizeQueue(Queue.compactForStorage([item]))).item;
  assert.deepEqual(queued.executionSnapshot.selectionContext.rebaseEvidence,proof);
  const record=StorageDb.buildSessionRecord({id:'session',runs:[{id:'run',status:'completed',task:'edit',executionSnapshot:snapshot}]});
  assert.deepEqual(record.runs[0].executionSnapshot.selectionContext.rebaseEvidence,proof);
  assert.equal(JSON.stringify(proof).includes(BEFORE),false);
});

test('unchanged selection version preserves the normal edit path',async t=>{
  const h=harness(t,{'main.tex':BEFORE}),capture=await captureSelection(BEFORE);
  const result=await runSelected(h,capture,workspace=>fs.writeFileSync(path.join(workspace,'main.tex'),AFTER));
  assert.equal(result.error,null);assert.deepEqual(result.summary.changedPaths,['main.tex']);
});

test('outside suffix changes rebase to current content while preserving the entire current outside region',async t=>{
  const current=BEFORE.replace('Suffix remains stable.','Suffix is concurrently changed.'),next=current.replace(SELECTED,'replacement passage');
  const h=harness(t,{'main.tex':current}),capture=await captureSelection(BEFORE);
  const result=await runSelected(h,capture,workspace=>fs.writeFileSync(path.join(workspace,'main.tex'),next));
  assert.equal(result.error,null);assert.equal(result.executeCalls,1);assert.equal(result.executedSelection.documentHash,sha(current));
  assert.equal(result.result.syncChanges[0].previousContent,current);assert.equal(result.result.syncChanges[0].content,next);
});

test('prefix insertion uses the complete suffix anchor to update offsets rather than searching repeated text',async t=>{
  const original='Repeated '+SELECTED+' before.\n'+BEFORE;
  const capturedText=original.replace('Repeated '+SELECTED+' before.','Repeated other words before.');
  // Capture the normal selected occurrence with an additional same-text instance after it.
  const source=capturedText+'\nLater '+SELECTED+' occurrence.';
  const capture=await captureSelection(source),prefix='Concurrent prefix inserted.\n',current=prefix+source;
  const from=capture.selected.from+prefix.length,to=capture.selected.to+prefix.length;
  const next=current.slice(0,from)+'replacement passage'+current.slice(to);
  const h=harness(t,{'main.tex':current});
  const result=await runSelected(h,capture,workspace=>fs.writeFileSync(path.join(workspace,'main.tex'),next));
  assert.equal(result.error,null);assert.equal(result.executedSelection.from,from);assert.equal(result.executedSelection.to,to);
  assert.ok(result.result.syncChanges[0].content.endsWith('Later '+SELECTED+' occurrence.'));
});

test('changing both complete anchors still refuses safely before model execution',async t=>{
  const capture=await captureSelection(BEFORE),current='Changed prefix.\n'+BEFORE+'\nChanged suffix.';
  const h=harness(t,{'main.tex':current}),result=await runSelected(h,capture,()=>{throw new Error('must not execute');});
  assert.equal(result.error?.code,'selected_context_unresolved');assert.equal(result.executeCalls,0);
});

test('ambiguous first and last anchored copies are rejected instead of selecting either',async t=>{
  const capture=await captureSelection(BEFORE),s=capture.selected;
  const current=BEFORE.slice(0,s.to)+'\nInserted '+SELECTED+BEFORE.slice(s.to);
  const h=harness(t,{'main.tex':current}),result=await runSelected(h,capture,()=>{throw new Error('must not execute');});
  assert.equal(result.error?.code,'selected_context_unresolved');assert.equal(result.executeCalls,0);
});

test('legacy selections without rebase proof still require the exact document version',async t=>{
  const capture=await captureSelection(BEFORE),legacy={...capture.selected};delete legacy.rebaseEvidence;
  const h=harness(t,{'main.tex':BEFORE+'outside'});await h.sync(await h.snapshot());
  assert.throws(()=>Scope.prepareSelectionScope(legacy,h.mirror.workspacePath,h.context.getCurrentProjectId?.()||'e'.repeat(24)),{code:'selected_context_unresolved'});
  assert.equal(Selection.normalize({...legacy,rebaseEvidence:{prefixHash:'invalid'}}).rebaseEvidence,undefined);
});

test('mixed outside-file changes preserve the independently valid selection write and name the blocked result',async t=>{
  const h=harness(t,{'main.tex':BEFORE,'other.tex':TEXT('other')}),capture=await captureSelection(BEFORE);
  const result=await runSelected(h,capture,workspace=>{fs.writeFileSync(path.join(workspace,'main.tex'),AFTER);fs.writeFileSync(path.join(workspace,'other.tex'),TEXT('outside changed'));});
  assert.equal(result.error,null);assert.deepEqual(result.summary.changedPaths,['main.tex']);
  assert.deepEqual(result.summary.unsupported,[{path:'other.tex',reason:'selection_scope_violation'}]);assert.equal(h.baseline().dirty,true);
});

test('same-file prefix edits remain blocked; moves and duplicates cannot disguise a selected-only write',async t=>{
  const capture=await captureSelection(BEFORE),h=harness(t,{'main.tex':BEFORE});await h.sync(await h.snapshot());
  const scope=Scope.prepareSelectionScope(capture.selected,h.mirror.workspacePath,'e'.repeat(24));
  const valid={type:'write',path:'main.tex',previousContent:BEFORE,content:AFTER};
  assert.deepEqual(Scope.filterSelectionChanges([{...valid,content:'prefix changed'+AFTER}],scope).changes,[]);
  const move={type:'move',path:'main.tex',to:'outside.tex'};
  const mixed=Scope.filterSelectionChanges([valid,move],scope);assert.deepEqual(mixed.changes,[],'ambiguous repeated selected-path operations are not partially accepted');
  assert.equal(mixed.unsupportedChanges.length,2);
});

test('UTF-16 offsets and empty flanks rebase only when the unchanged complete flank proves the position',async t=>{
  for (const source of ['🧪 prefix\n'+BEFORE,SELECTED+'\n'+TEXT('Suffix'), TEXT('Prefix')+'\n'+SELECTED]) {
    const capture=await captureSelection(source);
    const current=source.startsWith(SELECTED) ? source+' Changed suffix.' : '🧪 added\n'+source;
    const from=source.startsWith(SELECTED) ? 0 : capture.selected.from+'🧪 added\n'.length;
    const next=current.slice(0,from)+'replacement passage'+current.slice(from+SELECTED.length);
    const h=harness(t,{'main.tex':current}),result=await runSelected(h,capture,workspace=>fs.writeFileSync(path.join(workspace,'main.tex'),next));
    assert.equal(result.error,null);assert.equal(result.executedSelection.from,from);
    assert.equal(result.executedSelection.documentHash,sha(current));assert.equal(result.result.syncChanges[0].previousContent,current);
  }
});

test('a changed selected passage is refused before model execution',async t=>{
  const capture=await captureSelection(BEFORE);
  const h=harness(t,{'main.tex':BEFORE.replace(SELECTED,'completely different passage')});
  const result=await runSelected(h,capture,()=>{throw new Error('must not execute');});
  assert.equal(result.error?.code,'selected_context_unresolved');assert.equal(result.executeCalls,0);
});

test('Page capture still rejects project switches and document changes across asynchronous hashing',async()=>{
  const wrong=await captureSelection(BEFORE,'edit',{wrongProducerProject:true});assert.equal(wrong.selected,null);
  const changed=await captureSelection(BEFORE,'edit',{changeDuringCapture:true});assert.equal(changed.selected,null);
});

test('reference-only selections do not constrain normal whole-project Auto output',async t=>{
  const h=harness(t,{'main.tex':BEFORE,'other.tex':TEXT('other')}),capture=await captureSelection(BEFORE,'reference');
  const result=await runSelected(h,capture,workspace=>fs.writeFileSync(path.join(workspace,'other.tex'),TEXT('normal full-project edit')));
  assert.equal(result.error,null);assert.deepEqual(result.summary.changedPaths,['other.tex']);assert.deepEqual(result.summary.unsupported,[]);
});

test('long literal selection paths retain their full identity across capture and Native filtering',async t=>{
  const long='a'.repeat(160)+'/'+'b'.repeat(159)+'extra.tex',oldAlias=long.slice(0,320);
  const h=harness(t,{'main.tex':TEXT('main'),[long]:BEFORE,[oldAlias]:BEFORE});
  const capture=await captureSelection(BEFORE,'edit',{path:long});
  assert.equal(capture.selected.path,long);
  const result=await runSelected(h,capture,workspace=>fs.writeFileSync(path.join(workspace,long),AFTER));
  assert.equal(result.error,null);assert.deepEqual(result.summary.changedPaths,[long]);assert.equal(h.read(oldAlias),BEFORE);
  for(const invalid of ['folder\\file.tex',' a.tex','a.tex ','a'.repeat(2049)])assert.equal(Selection.normalize({...capture.selected,path:invalid}),null);
});


test('selection proof refuses half-surrogate boundaries and malformed UTF-16 instead of hashing replacement aliases',async()=>{
  const source='😀'+BEFORE;
  const complete=await captureSelection(source,'edit',{from:0,to:2,returnResult:true});assert.equal(complete.selected.text,'😀');
  for(const [from,to] of [[0,1],[1,2]]) {
    const captured=await captureSelection(source,'edit',{from,to,returnResult:true});assert.equal(captured.selected,null);
  }
  const malformed=await captureSelection('\ud83d unpaired '+BEFORE,'edit',{returnResult:true});assert.equal(malformed.selected,null);
  const regular=await captureSelection(BEFORE);
  assert.equal(Selection.normalize({...regular.selected,text:'\ude00',from:1,to:2}),null);
});
