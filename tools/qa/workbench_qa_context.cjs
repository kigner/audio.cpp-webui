/* Shared evidence paths and identity guard for real workbench regressions. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function evidenceDirectory(directory){
  for(let current=path.resolve(directory);;current=path.dirname(current)){
    if(fs.existsSync(path.join(current,'TESTING-FROZEN.json')))throw Error('Evidence directory is frozen: '+current);
    if(path.dirname(current)===current)break;
  }
  return path.resolve(directory);
}
function configuration(argv=process.argv.slice(2),env=process.env){
  const flag=name=>{const index=argv.indexOf('--'+name);if(index<0)return undefined;const value=argv[index+1];if(!value||value.startsWith('--'))throw Error('--'+name+' requires a value');return value;};
  const directory=evidenceDirectory(flag('output-root')||env.WORKBENCH_QA_OUTPUT_ROOT||'build/workbench-qa');
  const contextPath=path.resolve(flag('runtime-context')||env.WORKBENCH_RUNTIME_CONTEXT||path.join(directory,'current-runtime.json'));
  return {directory,contextPath};
}
function readContext(config){
  const bytes=fs.readFileSync(config.contextPath),expected=JSON.parse(bytes);
  if(!expected.health?.instance_id||!expected.health?.runtime_revision||!expected.server_exe||!expected.server_sha256)throw Error('Runtime evidence must identify the live UI revision/instance and server binary');
  return {expected,path:config.contextPath,sha256:sha(bytes)};
}
async function verifyContext(page,base,context){
  const response=await page.request.get(base+'/api/workbench/health');
  if(!response.ok())throw Error('Runtime identity health: HTTP '+response.status());
  const health=await response.json();
  for(const key of ['instance_id','pid','runtime_revision'])if(context.expected.health[key]!==undefined&&health[key]!==context.expected.health[key])throw Error('Runtime identity changed: '+key);
  if(sha(fs.readFileSync(context.expected.server_exe))!==context.expected.server_sha256)throw Error('Runtime server binary SHA changed');
  return {path:context.path,sha256:context.sha256,health:{instance_id:health.instance_id,pid:health.pid,runtime_revision:health.runtime_revision},server_exe:context.expected.server_exe,server_sha256:context.expected.server_sha256};
}
module.exports={configuration,evidenceDirectory,readContext,verifyContext};
