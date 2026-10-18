/* Temp-only configuration/identity regression. No real browser or backend. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {configuration,readContext,verifyContext}=require('./workbench_qa_context.cjs');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-context-'));
async function main(){
  const directory=path.join(temporary,'中文证据'),filename=path.join(directory,'current-runtime.json');fs.mkdirSync(directory);
  assert.equal(configuration([],{}).directory,path.resolve('build/workbench-qa'));
  assert.equal(configuration(['--output-root',directory,'--runtime-context',filename],{}).contextPath,filename);
  assert.equal(configuration([],{WORKBENCH_QA_OUTPUT_ROOT:directory,WORKBENCH_RUNTIME_CONTEXT:filename}).directory,directory);
  assert.throws(()=>configuration(['--runtime-context'],{}),/requires a value/);
  const binary=path.join(directory,'server.exe');fs.writeFileSync(binary,'test bytes, not executable');
  const sha=crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  const health={instance_id:'test',pid:123,runtime_revision:'new-revision'};
  fs.writeFileSync(filename,JSON.stringify({health,server_exe:binary,server_sha256:sha}));
  const config=configuration(['--output-root',directory],{}),context=readContext(config),urls=[];
  const page={request:{get:async url=>{urls.push(url);return {ok:()=>true,json:async()=>({...health})};}}};
  const result=await verifyContext(page,'http://127.0.0.1:1',context);assert.equal(result.server_sha256,sha);assert.deepEqual(urls,['http://127.0.0.1:1/api/workbench/health']);
  for(const key of ['instance_id','pid','runtime_revision']){
    const changed={...context,expected:{...context.expected,health:{...health,[key]:'changed'}}};
    await assert.rejects(()=>verifyContext(page,'http://127.0.0.1:1',changed),new RegExp('changed: '+key));
  }
  fs.writeFileSync(binary,'modified');await assert.rejects(()=>verifyContext(page,'http://127.0.0.1:1',context),/SHA changed/);
  fs.writeFileSync(filename,'{}');assert.throws(()=>readContext(config),/must identify/);
  fs.writeFileSync(path.join(directory,'TESTING-FROZEN.json'),'{}');assert.throws(()=>configuration(['--output-root',path.join(directory,'nested')],{}),/directory is frozen/);
  console.log('PASS context paths, Unicode, CLI/env, required arguments, identity/PID/revision and binary SHA guards (temp-only)');
}
main().finally(()=>fs.rmSync(temporary,{recursive:true,force:true})).catch(error=>{console.error(error);process.exitCode=1;});
