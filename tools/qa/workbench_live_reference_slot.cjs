/* Independent real dual-residency probe. Default prepares a plan; only --run loads models. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process');
const qaContext=require('./workbench_qa_context.cjs'),qaConfig=qaContext.configuration();
const directory=qaConfig.directory,base=process.env.WORKBENCH_URL||'http://127.0.0.1:7860';
const output=path.join(directory,'reference-slot',new Date().toISOString().replace(/[:.]/g,'-'));
const plan={status:'prepared_not_executed',script:path.resolve(__filename),output,
  command:'node tools/qa/workbench_live_reference_slot.cjs --run',
  phases:['require current runtime and empty idle slots','select Pocket without loading, explicitly UI-load Pocket','snapshot actual Pocket exe/SHA/PID/argv/config/port','upload known WAV with automatic ASR OFF, run one real manual reference transcription','derive both real health URLs from process argv/config; verify both current source binaries and unchanged resident Pocket','UI unload both script-owned slots, delete only own upload; verify original reference bytes and WAV hashes'],
  boundary:'Root must reserve GPU. This is an additional probe, not a rerun of CRUD, cancellation or simulated recording. No generate job, reference library writes, model downloads or product edits. Actual process/config evidence determines ports; 8081 is documented only as the default.'};
fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'plan.json'),JSON.stringify(plan,null,2));
if(!process.argv.includes('--run')){console.log(JSON.stringify(plan,null,2));process.exit(0);}
const {chromium}=require('C:/Users/KIN/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const expected=qaContext.readContext(qaConfig).expected;
const fixture=path.resolve('webui/voice/demo_01_man.wav'),voiceDir=path.dirname(fixture),prompt=path.join(voiceDir,'prompt_text');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const canonical=value=>path.resolve(value).toLowerCase();
const wavHashes=()=>Object.fromEntries(fs.readdirSync(voiceDir).filter(name=>/\.wav$/i.test(name)).sort().map(name=>[name,hash(fs.readFileSync(path.join(voiceDir,name)))]));
const original={prompt_sha256:hash(fs.readFileSync(prompt)),wavs:wavHashes()};
const report={...plan,status:'running',method:'Actual Chrome controls, one real reference ASR request, CIM process and raw config evidence; no mocks.',
  started:new Date().toISOString(),expected_server_exe:expected.server_exe,expected_server_sha256:expected.server_sha256,
  fixture,fixture_sha256:hash(fs.readFileSync(fixture)),original,checks:[],posts:[],uploads:[],jobs:[],processes:[],artifacts:[],screenshots:[],pageErrors:[],failures:[]};
let browser,page,originalAuto,expectedLoad=false,allowedUnload=false,uploadAllowed=false,transcriptionAllowed=false,currentJob=null;
const ownedModels=new Set(),ownedJobs=new Set(),pending=[];
const save=()=>fs.writeFileSync(path.join(output,'reference-slot.json'),JSON.stringify(report,null,2));
function scrub(value){if(Array.isArray(value))return value.map(scrub);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!key.includes('token')).map(([key,item])=>[key,scrub(item)]));return value;}
function assert(ok,name,details){report.checks.push({name,status:ok?'pass':'fail',details});save();if(!ok)throw Error(name);}
async function get(endpoint){const response=await page.request.get(base+'/api/workbench'+endpoint);if(!response.ok())throw Error(`${endpoint}: ${response.status()}`);return response.json();}
async function shot(name){const file=path.join(output,name+'.png');await page.screenshot({path:file,fullPage:true});report.screenshots.push(file);save();}
async function settled(predicate,label,timeout=30000){let status;const began=Date.now();while(Date.now()-began<timeout){status=await get('/status');if(!status.busy&&!status.realtime_active&&predicate(status))return status;await page.waitForTimeout(250);}assert(false,label,scrub(status));}
function argument(command,name){const match=new RegExp('(?:^|\\s)--'+name+'\\s+(?:"([^"]+)"|(\\S+))').exec(command||'');return match?match[1]||match[2]:null;}
function processInventory(){
  const ps=path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const source="$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter \"Name='audiocpp_server.exe'\" | Select-Object ProcessId,ParentProcessId,@{Name='CreatedUTC';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}},ExecutablePath,CommandLine)";
  return JSON.parse(cp.execFileSync(ps,['-NoProfile','-NonInteractive','-Command',source],{encoding:'utf8',timeout:20000}).replace(/^\ufeff/,''));
}
function snapshot(model,label){
  const all=processInventory(),candidates=[];
  for(const process of all){const configFile=argument(process.CommandLine,'config');if(!configFile||!fs.existsSync(configFile))continue;
    const file=path.resolve(configFile);if(!canonical(file).startsWith(canonical(os.tmpdir())+path.sep))continue;
    if(!/^audiocpp_(?:webui_cfg|realtime_asr)_.*\.json$/.test(path.basename(file)))continue;
    const bytes=fs.readFileSync(file),config=JSON.parse(bytes);if(config.models?.[0]?.id===model)candidates.push({process,file,bytes,config});}
  assert(candidates.length===1,label+': exactly one actual managed process for '+model,{candidates:candidates.map(value=>value.process),all});
  const {process,file,bytes,config}=candidates[0];assert(path.isAbsolute(process.ExecutablePath||''),label+': actual executable path is absolute',process);
  const exe=path.resolve(process.ExecutablePath),exeSha=hash(fs.readFileSync(exe));
  assert(canonical(exe)===canonical(expected.server_exe),label+': process runs current source server path',{actual:exe,expected:expected.server_exe});
  assert(exeSha===expected.server_sha256,label+': actual executable SHA matches current build',{actual:exeSha,expected:expected.server_sha256});
  const host=argument(process.CommandLine,'host')||config.host,port=Number(argument(process.CommandLine,'port')||config.port);
  assert(['127.0.0.1','localhost'].includes(host)&&Number.isInteger(port)&&port>0&&port<=65535,label+': actual argv/config gives a safe local health URL',{host,port});
  assert(String(config.port)===String(port),label+': actual command and temporary config ports agree',{argv:argument(process.CommandLine,'port'),config:config.port});
  assert(config.models?.length===1&&config.models[0].id===model,label+': actual config identifies the resident model',config.models);
  const copy=path.join(output,label+'-config.json');fs.writeFileSync(copy,bytes);
  const evidence={label,pid:process.ProcessId,parent_pid:process.ParentProcessId,created_utc:process.CreatedUTC,exe,exe_sha256:exeSha,
    argv:process.CommandLine,config_source:file,config_path:copy,config_sha256:hash(bytes),config,host,port,url:`http://${host}:${port}`};
  report.artifacts.push({path:copy,bytes:bytes.length,sha256:hash(bytes),purpose:label+' actual server config'});report.processes.push(evidence);save();return evidence;
}
async function health(evidence,label){const response=await page.request.get(evidence.url+'/health',{timeout:10000});let body;try{body=await response.json();}catch{body=await response.text();}
  const modelsResponse=await page.request.get(evidence.url+'/v1/models',{timeout:10000}),models=await modelsResponse.json();
  const value={derived_url:evidence.url,status:response.status(),body:scrub(body),models_status:modelsResponse.status(),models:scrub(models)};report[label]=value;
  assert(response.ok()&&modelsResponse.ok(),label+': actual process-derived endpoints respond',value);
  assert(models.data?.some(row=>row.id===evidence.config.models[0].id&&row.loaded!==false),label+': actual server lists expected loaded model',value);return value;}
async function unload(label){const before=await get('/status');assert(!before.busy&&!before.realtime_active,label+': unload starts idle',scrub(before));
  const residents=[before.server?.model,before.asr?.model].filter(Boolean);assert(residents.every(model=>ownedModels.has(model)),label+': only script-owned slots may be unloaded',{residents,owned:[...ownedModels]});
  if(!residents.length)return before;
  await page.locator('[data-route="settings"]').click();await page.locator('[data-settings-tab="runtime"]').click();allowedUnload=true;
  try{const response=page.waitForResponse(value=>new URL(value.url()).pathname==='/api/workbench/unload-all'&&value.request().method()==='POST');await page.locator('#unload-all-models').click();assert((await response).ok(),label+': explicit UI unload-all succeeds');}
  finally{allowedUnload=false;}
  return settled(value=>!value.server?.model&&!value.asr?.model,label+': both slots are released');}
async function main(){
  assert(hash(fs.readFileSync(expected.server_exe))===expected.server_sha256,'current-runtime binary SHA is still valid');
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',error=>report.pageErrors.push(error.message));
  await page.route('**/api/**',async intercepted=>{const request=intercepted.request(),endpoint=new URL(request.url()).pathname;if(['GET','HEAD','OPTIONS'].includes(request.method()))return intercepted.continue();
    let body;try{body=request.postDataJSON();}catch{body={multipart:true,bytes:request.postDataBuffer()?.length};}
    const permitted=request.method()==='POST'&&(expectedLoad&&endpoint==='/api/workbench/models/pocket-tts/load'||uploadAllowed&&endpoint==='/api/workbench/uploads'||transcriptionAllowed&&endpoint==='/api/workbench/reference-transcriptions'&&report.uploads.some(upload=>upload.id===body.audio)||allowedUnload&&endpoint==='/api/workbench/unload-all');
    report.posts.push({time:new Date().toISOString(),endpoint,method:request.method(),body,permitted});save();if(!permitted){report.failures.push({name:'unexpected mutation blocked',endpoint});return intercepted.abort('blockedbyclient');}return intercepted.continue();});
  page.on('response',response=>{if(response.request().method()!=='POST')return;pending.push((async()=>{const endpoint=new URL(response.url()).pathname,item=report.posts.findLast(row=>row.endpoint===endpoint&&!row.response);let body;try{body=await response.json();}catch{body=await response.text();}if(item)item.response={status:response.status(),body:scrub(body)};save();})());});
  await page.goto(base+'/#tts',{waitUntil:'domcontentloaded'});await page.locator('#connection-status[data-state="online"]').waitFor();
report.runtime_context=await qaContext.verifyContext(page,base,qaContext.readContext(qaConfig));  const uiHealth=await get('/health');report.uiHealth=scrub(uiHealth);assert(uiHealth.instance_id===expected.health.instance_id&&uiHealth.runtime_revision===expected.health.runtime_revision,'live UI identity matches current runtime evidence',scrub(uiHealth));
  const initial=await get('/status');report.initialRuntime=initial;assert(!initial.busy&&!initial.realtime_active&&!initial.server?.model&&!initial.asr?.model,'probe starts with empty idle model slots',scrub(initial));
  originalAuto=await page.evaluate(()=>localStorage.getItem('audiocpp-reference-auto'));
  assert((await get('/models/pocket-tts')).installed&&(await get('/models/qwen3-asr')).installed,'both actual Pocket and Qwen reference models are installed');
  const beforePreview=report.posts.length;await page.locator('[data-route="tts"]').click();await page.locator('#model-picker-trigger').click();await page.locator('#model-picker-search').fill('pocket-tts');
  const selected=page.waitForResponse(value=>new URL(value.url()).pathname==='/api/workbench/models/pocket-tts');await page.locator('[data-model="pocket-tts"] .model-row-select').click();await selected;await page.keyboard.press('Escape');await page.waitForTimeout(300);
  assert(report.posts.length===beforePreview&&!(await get('/status')).server?.model,'Pocket selection previews without starting a model');
  expectedLoad=true;ownedModels.add('pocket-tts');try{const loaded=page.waitForResponse(value=>new URL(value.url()).pathname==='/api/workbench/models/pocket-tts/load'&&value.request().method()==='POST',{timeout:300000});await page.locator('#model-picker-trigger').click();await page.locator('#model-picker-search').fill('pocket-tts');await page.locator('[data-load-model="pocket-tts"]').click();assert((await loaded).ok(),'explicit Pocket UI load succeeds');}finally{expectedLoad=false;}
  const before=await settled(value=>value.server?.model==='pocket-tts','Pocket becomes resident');report.beforeRuntime=before;
  assert(before.server.configuration.managed&&before.server.model==='pocket-tts','nonnull Pocket resides in the main managed slot before ASR',before.server);
  await page.locator('#run-button:enabled').waitFor();const mainBefore=snapshot('pocket-tts','pocket-before');await health(mainBefore,'main_health_before');await shot('01-pocket-main-resident');
  await page.locator('[data-route="references"]').click();await page.locator('#new-reference').click();const editor=page.locator('#reference-editor');await editor.locator('.reference-automatic input').setChecked(false);
  assert(await page.evaluate(()=>JSON.parse(localStorage.getItem('audiocpp-reference-auto')))===false,'reference automatic ASR is OFF before upload');
  uploadAllowed=true;let upload;try{const uploaded=page.waitForResponse(value=>new URL(value.url()).pathname==='/api/workbench/uploads'&&value.request().method()==='POST');await editor.locator('input[type="file"]').setInputFiles(fixture);const response=await uploaded;assert(response.ok(),'known WAV uploads through real reference UI');upload=await response.json();const suffix=path.extname(upload.name).toLowerCase();assert(/^[a-f0-9]{32}$/.test(upload.id)&&suffix==='.wav','upload identifies only a new QA-owned WAV',upload);report.uploads.push({...upload,path:path.resolve('webui/output/workbench-inputs',upload.id+suffix)});save();}finally{uploadAllowed=false;}
  await page.waitForTimeout(600);assert(!report.posts.some(row=>row.endpoint==='/api/workbench/reference-transcriptions'),'automatic OFF upload starts no recognition');
  transcriptionAllowed=true;ownedModels.add('qwen3-asr');try{const created=page.waitForResponse(value=>new URL(value.url()).pathname==='/api/workbench/reference-transcriptions'&&value.request().method()==='POST');await editor.getByRole('button',{name:'音频转录',exact:true}).click();const response=await created;assert(response.ok(),'one manual reference recognition request is really accepted');const job=await response.json();currentJob=job.id;ownedJobs.add(job.id);report.jobs.push({id:job.id,upload:upload.id});save();}finally{transcriptionAllowed=false;}
  let job;const began=Date.now();while(Date.now()-began<300000){job=await get('/jobs/'+currentJob);if(['done','error','cancelled'].includes(job.status))break;await page.waitForTimeout(250);}
  report.jobs[0].result=job;assert(['done','error','cancelled'].includes(job?.status),'own reference recognition reaches a terminal state',job);currentJob=null;
  assert(job.status==='done'&&job.text?.trim().length>0,'real reference backend returns recognized text',job);
  await editor.locator('.reference-stop').waitFor({state:'hidden'});assert(await editor.locator('[data-input-key="reference_text"]').inputValue()===job.text,'reference text is actually filled in the UI');await shot('02-reference-real-text');
  const after=await settled(value=>value.server?.model==='pocket-tts'&&value.asr?.model==='qwen3-asr','both models remain resident');report.afterRuntime=after;
  assert(after.server.configuration.managed&&after.asr.managed,'main and reference slots are managed and nonnull',scrub(after));
  assert(JSON.stringify(before.server.configuration)===JSON.stringify(after.server.configuration),'main runtime configuration remains unchanged',{before:before.server.configuration,after:after.server.configuration});
  const mainAfter=snapshot('pocket-tts','pocket-after'),asr=snapshot('qwen3-asr','reference-asr');
  assert(mainBefore.pid===mainAfter.pid&&mainBefore.created_utc===mainAfter.created_utc,'reference ASR preserves the actual Pocket process identity',{before:mainBefore.pid,after:mainAfter.pid});
  assert(mainBefore.exe===mainAfter.exe&&mainBefore.exe_sha256===mainAfter.exe_sha256&&mainBefore.argv===mainAfter.argv&&mainBefore.config_sha256===mainAfter.config_sha256,'Pocket executable, arguments and raw config remain unchanged');
  assert(asr.pid!==mainAfter.pid&&asr.port!==mainAfter.port,'reference ASR uses a distinct actual process and port',{main:{pid:mainAfter.pid,port:mainAfter.port},asr:{pid:asr.pid,port:asr.port}});
  await health(mainAfter,'main_health_after');await health(asr,'asr_health_actual');await shot('03-independent-slots-proved');
  report.finalRuntime=await unload('final dual-slot cleanup');await shot('04-both-slots-released');
}
main().catch(async error=>{report.failures.push({name:'execution',error:error.stack});console.error(error.stack);if(page)await shot('failure').catch(()=>{});}).finally(async()=>{
  try{
    if(currentJob){assert(ownedJobs.has(currentJob),'cleanup cancels only its own reference job');const response=await page.request.post(base+'/api/workbench/jobs/'+currentJob+'/cancel',{data:{}});report.posts.push({method:'POST',endpoint:'/api/workbench/jobs/'+currentJob+'/cancel',cleanup:true,status:response.status()});let terminal;const began=Date.now();while(Date.now()-began<30000){terminal=await get('/jobs/'+currentJob);if(['done','error','cancelled'].includes(terminal.status))break;await page.waitForTimeout(250);}assert(['done','error','cancelled'].includes(terminal?.status),'own job finishes before upload cleanup',terminal);currentJob=null;}
    if(page){const status=await get('/status');if(status.server?.model||status.asr?.model)await unload('failure cleanup');if(originalAuto!==undefined){await page.evaluate(value=>value===null?localStorage.removeItem('audiocpp-reference-auto'):localStorage.setItem('audiocpp-reference-auto',value),originalAuto);assert(await page.evaluate(()=>localStorage.getItem('audiocpp-reference-auto'))===originalAuto,'original automatic-reference preference restored exactly');}}
    for(const upload of report.uploads){const file=path.resolve(upload.path),allowed=path.resolve('webui/output/workbench-inputs',upload.id+'.wav');assert(/^[a-f0-9]{32}$/.test(upload.id)&&canonical(file)===canonical(allowed),'cleanup path is precisely the QA-created upload');if(fs.existsSync(file)){assert(hash(fs.readFileSync(file))===report.fixture_sha256,'own upload still matches the known WAV before deletion');fs.unlinkSync(file);upload.cleaned=true;}}
    assert(hash(fs.readFileSync(prompt))===original.prompt_sha256,'user prompt_text exact original bytes preserved');assert(JSON.stringify(wavHashes())===JSON.stringify(original.wavs),'all original user WAV names and hashes preserved');
  }catch(error){report.failures.push({name:'cleanup',error:error.stack});}
  await Promise.allSettled(pending);report.finished=new Date().toISOString();report.status=report.failures.length||report.pageErrors.length||report.checks.some(row=>row.status==='fail')?'fail':'pass';report.summary={pass:report.checks.filter(row=>row.status==='pass').length,fail:report.checks.filter(row=>row.status==='fail').length};save();if(browser)await browser.close();console.log(JSON.stringify({status:report.status,summary:report.summary,report:path.join(output,'reference-slot.json')}));process.exitCode=report.status==='pass'?0:1;
});
