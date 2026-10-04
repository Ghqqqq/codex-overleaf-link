 'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {harness,captureSelection,runSelected,BEFORE,SELECTED,TEXT}=require('./_helpers/projectScopeHarness');
const {createFlow}=require('./_helpers/writebackOutcomeHarness');

test('Native mixed selection result reaches real Content partial settlement and preserves current outside text in Undo',async t=>{
  const current=BEFORE+'Concurrent suffix preserved.\n',next=current.replace(SELECTED,'replacement passage');
  const native=harness(t,{'main.tex':current,'other.tex':TEXT('other')}),capture=await captureSelection(BEFORE);
  const result=await runSelected(native,capture,workspace=>{
    fs.writeFileSync(path.join(workspace,'main.tex'),next);fs.writeFileSync(path.join(workspace,'other.tex'),TEXT('illegal outside edit'));
  });
  assert.equal(result.error,null);assert.equal(native.baseline().dirty,true);
  const flow=createFlow({initialFiles:{'main.tex':current,'other.tex':TEXT('other')},
    syncChanges:result.result.syncChanges,unsupportedChanges:result.result.unsupportedChanges});
  const record=await flow.run();
  assert.equal(flow.f.files.get('main.tex'),next);assert.equal(flow.f.files.get('other.tex'),TEXT('other'));
  assert.equal(record.settlement.evidence.applied,'partial');assert.equal(record.settlement.evidence.settled,'partial');
  assert.equal(record.settlement.failures[0].code,'selection_scope_violation');assert.equal(record.settlement.failures[0].retryable,false);
  assert.deepEqual(record.undoExpectedFiles.map(file=>[file.path,file.content]),[['main.tex',current]]);
  assert.equal(record.undoOperations.length,1);assert.notEqual(record.status,'completed');
  assert.match(JSON.stringify(flow.reportInputs),/selection_scope_violation/);
});

test('a fully withheld selection result surfaces an actionable blocked failure without Page writes',async t=>{
  const native=harness(t,{'main.tex':BEFORE}),capture=await captureSelection(BEFORE);
  const result=await runSelected(native,capture,workspace=>fs.writeFileSync(path.join(workspace,'main.tex'),'illegal prefix '+BEFORE));
  assert.equal(result.result.syncChanges.length,0);
  const flow=createFlow({initialFiles:{'main.tex':BEFORE},syncChanges:result.result.syncChanges,unsupportedChanges:result.result.unsupportedChanges});
  const record=await flow.run();assert.equal(flow.f.files.get('main.tex'),BEFORE);
  assert.equal(record.settlement.failures[0].code,'selection_scope_violation');assert.equal(record.settlement.failures[0].stage,'preflight');
  assert.equal(record.settlement.failures[0].severity,'blocked');assert.equal(record.settlement.failures[0].changedDocument,false);
  assert.equal(record.undoOperations.length,0);assert.equal(flow.trace.some(item=>item.method==='applyOperations'),false);
  assert.match(JSON.stringify(flow.reportInputs),/Select the intended region again/);
});
