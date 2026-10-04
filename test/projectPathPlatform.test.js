'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),os=require('node:os');
const {createRequire}=require('node:module');
const Mirror=require('../native-host/src/mirrorWorkspace');
const Platform=require('../native-host/src/projectPathPlatform');

test('Windows paths reject stream syntax, devices and normalization aliases while POSIX keeps colon literals',()=>{
  for(const name of ['@file:main.tex','file.tex:stream','aux.tex','CON','dir/LPT9.log','COM¹.txt','dir/end.','dir/end ','a?b.tex','a*b.tex','a|b.tex']){
    assert.equal(Platform.isRepresentableProjectPath(name,'win32'),false,name);
  }
  for(const name of ['a%20b.tex','a b.tex','100%.tex','dir%2Ffile.tex','unicode/论文.tex'])assert.equal(Platform.isRepresentableProjectPath(name,'win32'),true,name);
  assert.equal(Platform.isRepresentableProjectPath('@file:main.tex','darwin'),true);
  assert.throws(()=>Platform.assertProjectPathsForPlatform(['a.tex','A.tex'],'win32'),{code:'project_path_unrepresentable'});
});

test('actual mirror sync preflights Windows-only names before deletion, writes or baseline updates; request platform cannot bypass it',async t=>{
  const rootDir=fs.mkdtempSync(path.join(os.tmpdir(),'col-platform-path-'));t.after(()=>fs.rmSync(rootDir,{recursive:true,force:true}));
  const projectId='platform-scope';const first={files:[{path:'old.tex',content:'keep original'}],capabilities:{fullProjectSnapshot:true}};
  const mirror=await Mirror.syncOverleafToMirror({projectId,project:first,rootDir});
  const baseline=fs.readFileSync(mirror.baselinePath,'utf8');
  const filename=path.resolve(__dirname,'../native-host/src/mirrorWorkspace.js');
  // Only the runtime platform is simulated; filesystem/path and the complete sync implementation remain real.
  const module={exports:{}};const wrapper=vm.runInNewContext('(function(require,module,exports,process){'+fs.readFileSync(filename,'utf8')+'\n})');
  wrapper(createRequire(filename),module,module.exports,{platform:'win32',env:{}});
  for(const invalid of ['@file:main.tex','nested/CON.tex','nested/end.']){
    await assert.rejects(module.exports.syncOverleafToMirror({projectId,rootDir,platform:'darwin',project:{platform:'darwin',files:[{path:'new.tex',content:'should not write'},{path:invalid,content:'unsafe'}],capabilities:{fullProjectSnapshot:true}}}),{code:'project_path_unrepresentable'});
    assert.equal(fs.readFileSync(path.join(mirror.workspacePath,'old.tex'),'utf8'),'keep original');assert.equal(fs.existsSync(path.join(mirror.workspacePath,'new.tex')),false);
    assert.equal(fs.readFileSync(mirror.baselinePath,'utf8'),baseline);
  }
});
