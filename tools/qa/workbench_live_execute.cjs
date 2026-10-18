/*
 * Real-browser execution; run only when the workbench/GPU is idle.
 *   node tools/qa/workbench_live_execute.cjs
 *   node tools/qa/workbench_live_execute.cjs --case path/to/case.json
 *   node tools/qa/workbench_live_execute.cjs --case path/to/cases.json --case-id selected-id
 *   node tools/qa/workbench_live_execute.cjs --task asr --model qwen3-asr --audio sample.wav
 *   node tools/qa/workbench_live_execute.cjs --play-report path/to/execution.json
 * Case: {id, task, model, inputs:{text,builtin_voice,audio,...}, options:{...},
 *        timeout_ms:300000, cancel_after_ms:null, cancel_stage_pattern:null,
 *        play_audio:true, download:true,
 *        persist_route:true}. A cancellation case expects final status "cancelled".
 * Default: Pocket TTS, demo_01_man library voice, short English text.
 */
const fs=require('node:fs');
const qaContext=require('./workbench_qa_context.cjs'),qaConfig=qaContext.configuration();
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const runtime=process.env.CODEX_NODE_DEPENDENCIES||'C:/Users/KIN/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const {chromium}=require(path.join(runtime,'playwright'));
const args=process.argv.slice(2), flags={};
for(let i=0;i<args.length;i++) {if(!args[i].startsWith('--'))throw Error(`Unexpected argument: ${args[i]}`);const key=args[i].slice(2);flags[key]=args[i+1]&&!args[i+1].startsWith('--')?args[++i]:true;}
if(flags.help) {console.log('Use --case <JSON file or JSON object>, or --task/--model/--text/--builtin-voice/--audio/--options <JSON>/--stop-after-ms. Inference requires an idle real workbench. --play-report <execution.json> only plays existing real artifact URLs with all API mutations blocked. Default is Pocket TTS with demo_01_man.wav.');process.exit(0);}
const playbackReport=flags['play-report']?JSON.parse(fs.readFileSync(path.resolve(flags['play-report']),'utf8')):null;
const caseDocument=flags.case?JSON.parse(String(flags.case).trim().startsWith('{')?flags.case:fs.readFileSync(path.resolve(flags.case),'utf8')):playbackReport?.manifest||{};
const manifest=flags['case-id']?(caseDocument.cases||[]).find(candidate=>candidate.id===flags['case-id']):caseDocument;
if(!manifest)throw Error(`Case not found: ${flags['case-id']}`);
if(Array.isArray(manifest.cases))throw Error('An aggregate case document requires --case-id.');
const spec={id:'tts-pocket-browser',task:'tts',model:'pocket-tts',timeout_ms:300000,play_audio:true,download:true,persist_route:true,...manifest};
spec.inputs={...(manifest.inputs||{})};spec.options={...(manifest.options||{})};
if(!flags.case&&!flags.model&&!flags.task&&!playbackReport)Object.assign(spec.inputs,{builtin_voice:'demo_01_man.wav',text:'Hello. This short test checks the browser voice synthesis workflow.'});
for(const key of ['task','model','id'])if(flags[key])spec[key]=flags[key];
if(!manifest.id&&!flags.id&&(flags.task||flags.model))spec.id=`${spec.task}-${spec.model}-browser`;
for(const key of ['text','audio','voice','language','context','transcript','lyrics','instruct','seed','max_tokens'])if(flags[key])spec.inputs[key]=['seed','max_tokens'].includes(key)?Number(flags[key]):flags[key];
if(flags['builtin-voice'])spec.inputs.builtin_voice=flags['builtin-voice'];
if(flags.options)Object.assign(spec.options,JSON.parse(flags.options));
if(flags.stream)spec.inputs.stream=true;
if(flags.detailed)spec.inputs.detailed=true;
if(flags.dialogue)spec.inputs.dialogue=true;
if(flags['stop-after-ms'])spec.cancel_after_ms=Number(flags['stop-after-ms']);
if(flags['timeout-ms'])spec.timeout_ms=Number(flags['timeout-ms']);
const base=flags.url||process.env.WORKBENCH_URL||playbackReport?.base||'http://127.0.0.1:7860';
const safe=value=>String(value).replace(/[^\w.-]/g,'_');
const output=path.resolve(flags.output||process.env.WORKBENCH_EXECUTION_OUTPUT||path.join(qaConfig.directory,'live-execution'),`${safe(spec.id)}${playbackReport?'-playback-only':''}-${new Date().toISOString().replace(/[:.]/g,'-')}`);
qaContext.evidenceDirectory(output);
fs.mkdirSync(output,{recursive:true});
const report={started:new Date().toISOString(),base,manifest:spec,method:'Real Chrome clicks and inputs; actual workbench POST requests and real inference, without mocked responses.',checks:[],posts:[],uploads:[],downloads:[],audio:[],screenshots:[],pageErrors:[],failures:[]};
if(playbackReport)Object.assign(report,{method:'Playback-only regression of existing real artifact URLs in native Chrome media elements. No inference, source modification or mocked API responses; all API mutations blocked.',sourceReport:path.resolve(flags['play-report'])});
let browser,page,jobId,job,routeName,submitted=false;
const pendingResponses=[];
const persist=()=>fs.writeFileSync(path.join(output,'execution.json'),JSON.stringify(report,null,2));
function assert(condition,name,details) {report.checks.push({name,status:condition?'pass':'fail',details:details===undefined?undefined:JSON.parse(JSON.stringify(details))});if(!condition)throw Error(name);}
function submittedInputMatches(expected,actual) {return expected===''||expected===null?actual===undefined||actual===null||actual==='':String(actual)===String(expected);}
function submittedOptionMatches(name,expected,actual,detail) {return JSON.stringify(actual)===JSON.stringify(expected)||actual===undefined&&expected===true&&detail?.id==='qwen3-tts-1.7b-vdesign'&&detail.family==='qwen3_tts'&&['do_sample','subtalker_do_sample'].includes(name)&&detail.parameters?.some(param=>param.name===name&&param.default===true&&['bool','boolean'].includes(param.type)&&param.scope==='request')&&!Object.hasOwn(detail.profile?.default_options||{},name);}
function parameterUpdateValue(name,value) {const text=String(value??'').replace(/\r\n/g,'\n');return ['bpm','timesignature'].includes(name)&&/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text.trim())?String(Number(text)):name==='keyscale'?text.trim():text;}
async function shot(name) {const file=path.join(output,`${safe(name)}.png`);await page.screenshot({path:file,fullPage:true});report.screenshots.push(file);persist();return file;}
async function verifyFreshNativeModel() {
  if(!spec.required_native_model_path)return;
  const binding=qaContext.readContext(qaConfig);
  assert(binding.sha256===report.runtime_context.sha256,'fresh model uses the original browser runtime context');
  const observed=await qaContext.verifyContext(page,base,binding);
  const caseFile=path.join(output,'fresh-native-case.json'),runtimeFile=path.join(output,'fresh-native-runtime-proof.json');
  fs.writeFileSync(caseFile,JSON.stringify(spec));fs.writeFileSync(runtimeFile,JSON.stringify(observed));
  const root=path.resolve(__dirname,'../..'),python=path.resolve(process.env.WORKBENCH_QA_PYTHON||path.join(root,'venv','Scripts','python.exe'));
  const checked=spawnSync(python,[path.join(__dirname,'verify_fresh_native_model.py'),'--case-file',caseFile,'--context',binding.path,'--runtime-proof',runtimeFile,'--base',base],{cwd:root,encoding:'utf8',timeout:60000,windowsHide:true,shell:false});
  assert(!checked.error&&checked.status===0,'fresh native model is verified before browser inference',{exit_code:checked.status,error:checked.error?.message,stderr:(checked.stderr||'').slice(-2000)});
  report.fresh_native_model_before_inference=JSON.parse(checked.stdout);
  report.fresh_native_model_before_inference.browser_runtime_context_after=await qaContext.verifyContext(page,base,binding);
  persist();
}
async function get(endpoint) {const response=await page.request.get(`${base}/api/workbench${endpoint}`);if(!response.ok())throw Error(`${endpoint}: HTTP ${response.status()}`);return response.json();}
function slimJob(value) {return {...value,audio_segments:(value.audio_segments||[]).map(segment=>({index:segment.index,sample_rate:segment.sample_rate,pcm_bytes:Math.floor((segment.pcm||'').length*3/4)}))};}
function routeFor(detail) {if(['tts','asr','music','design','vc'].includes(detail.task))return detail.task;if(['processing','separation'].includes(detail.task))return `tools/${detail.task}`;if(detail.task==='analysis')return `tools/${detail.model_task}`;throw Error(`No UI route for ${detail.task}`);}
async function navigateUi(target) {
  if(!target.startsWith('tools/'))await page.locator(`[data-route=${JSON.stringify(target)}]`).click();
  else {await page.locator('[data-route="tools"]').click();const index=['processing','separation','vad','diar','turn','align','midi'].indexOf(target.split('/')[1]);await page.locator('#tool-list .tool-card').nth(index).click();}
}

// Optional settled-controls audit. Pure snapshot/predicate functions also support local fixtures.
function settledControlSnapshot(expectation) {
  const visible=el=>!!el&&!el.hidden&&getComputedStyle(el).display!=='none'&&getComputedStyle(el).visibility!=='hidden'&&el.getClientRects().length>0;
  const control=el=>el?{present:true,visible:visible(el),disabled:!!el.disabled,type:el.type||el.tagName,value:el.type==='checkbox'?el.checked:el.value}: {present:false,visible:false};
  const button=id=>{const el=document.getElementById(id);return el?{present:true,visible:visible(el),hidden:el.hidden,disabled:!!el.disabled,text:el.textContent}: {present:false,visible:false};};
  const inputs=Object.fromEntries(Object.keys(expectation.inputs).map(key=>[key,control(document.querySelector(`#task-form [data-input-key=${JSON.stringify(key)}], #workspace-settings [data-input-key=${JSON.stringify(key)}]`))]));
  const options=Object.fromEntries(Object.keys(expectation.options).map(key=>[key,control(document.getElementById(`param-${key.replace(/[^\w-]/g,'-')}`))]));
  const media=Object.fromEntries(expectation.media.map(key=>{const file=document.querySelector(`#task-inputs input[type="file"][data-input-key=${JSON.stringify(key)}]`),el=file?.closest('.upload-zone')?.querySelector('audio');return [key,el?{present:true,visible:visible(el),readyState:el.readyState,duration:Number.isFinite(el.duration)?el.duration:null,currentSrc:el.currentSrc,src:el.src,error:el.error?{code:el.error.code,message:el.error.message}:null}:{present:false,visible:false}];}));
  return {workspaceModel:document.getElementById('workspace-model')?.value,workspaceUnloaded:document.getElementById('page-workspace')?.classList.contains('workspace-unloaded'),jobStatus:document.getElementById('job-status')?.dataset.state,run:button('run-button'),load:button('workspace-load'),settings:button('parameter-toggle'),inputs,options,media};
}
function settledControlFailures(snapshot,expectation,runtime) {
  const failures=[],equal=(actual,expected)=>typeof expected==='boolean'?actual===expected:String(actual)===String(expected);
  if(!runtime||runtime.busy||runtime.realtime_active)failures.push('runtime is not confirmed idle');
  if(runtime?.server?.model!==expectation.model&&runtime?.asr?.model!==expectation.model)failures.push('runtime model does not match selected model');
  if(snapshot.workspaceModel!==expectation.model||snapshot.workspaceUnloaded!==false)failures.push('workspace model detail is not settled');
  if(snapshot.jobStatus!==expectation.status)failures.push('terminal result state is missing');
  if(!snapshot.run.present||!snapshot.run.visible||snapshot.run.disabled!==false)failures.push('Generate is not visible and enabled');
  for(const [key,value] of Object.entries(expectation.inputs)){const row=snapshot.inputs[key];if(!row?.present||!row.visible||row.disabled||!equal(row.value,value))failures.push(`input ${key} is absent, hidden, disabled, or changed`);}
  for(const key of expectation.media){const row=snapshot.media[key];if(!row?.present||!row.visible||row.readyState<1||!(row.duration>0)||!row.currentSrc||row.error)failures.push(`source audio ${key} metadata is not ready`);}
  return failures;
}
async function verifySettledControls(stage) {
  assert(spec.model==='nemotron-asr'&&spec.task==='asr','settled-controls flag is scoped to this Nemotron ASR regression');
  const files=['audio','voice','rvc_voice_model','rvc_retrieval_index'];
  const expectation={model:spec.model,status:job.status,inputs:Object.fromEntries(Object.entries(report.expectedInputs).filter(([key])=>!files.includes(key))),options:Object.fromEntries((report.optionEntry?.controls||[]).map(key=>[key,spec.options[key]])),media:['audio','voice'].filter(key=>Object.hasOwn(spec.inputs,key))};
  const began=Date.now(),timeout=30000,deadline=began+timeout,samples=[];let consecutive=0,final;
  while(Date.now()<deadline){
    let runtime=null,runtimeError=null;
    try{const response=await page.request.get(`${base}/api/workbench/status`,{timeout:Math.max(1,Math.min(10000,deadline-Date.now()))});if(!response.ok())throw Error(`HTTP ${response.status()}`);runtime=await response.json();}catch(error){runtimeError=String(error);}
    const snapshot=await page.evaluate(settledControlSnapshot,expectation),failures=settledControlFailures(snapshot,expectation,runtime);
    final={time:new Date().toISOString(),elapsed_ms:Date.now()-began,runtime,runtimeError,snapshot,failures};samples.push(final);
    consecutive=failures.length?0:consecutive+1;if(consecutive>=2)break;
    if(Date.now()<deadline)await page.waitForTimeout(Math.min(250,deadline-Date.now()));
  }
  const record={stage,timeout_ms:timeout,required_consecutive_samples:2,expectation,samples,status:consecutive>=2?'pass':'fail'};(report.settledControls||=[]).push(record);persist();
  assert(consecutive>=2,`settled controls reach the expected state within ${timeout}ms: ${stage}`,record);
  assert(final.snapshot.run.disabled===false,`settled Generate disabled property is false: ${stage}`,final.snapshot.run);
  for(const key of Object.keys(expectation.inputs))assert(!final.failures.some(text=>text.startsWith(`input ${key} `)),`settled common input retains its actual DOM value: ${stage}/${key}`,final.snapshot.inputs[key]);
  for(const key of expectation.media)assert(!final.failures.some(text=>text.startsWith(`source audio ${key} `)),`settled source player has real audio metadata: ${stage}/${key}`,final.snapshot.media[key]);
}


// Optional Tone media audit: no seed/advanced-control visibility requirement.
function settledMediaSnapshot(expectation) {
  const visible=el=>!!el&&!el.hidden&&getComputedStyle(el).display!=='none'&&getComputedStyle(el).visibility!=='hidden'&&el.getClientRects().length>0;
  const media=el=>el?{present:true,visible:visible(el),readyState:el.readyState,duration:Number.isFinite(el.duration)?el.duration:null,src:el.src,currentSrc:el.currentSrc,error:el.error?{code:el.error.code,message:el.error.message}:null}:{present:false,visible:false};
  const run=document.getElementById('run-button'),settings=document.getElementById('parameter-toggle'),load=document.getElementById('workspace-load');
  const sources=Object.fromEntries(expectation.sourceKeys.map(key=>{const input=document.querySelector(`#task-inputs input[type="file"][data-input-key=${JSON.stringify(key)}]`);return [key,media(input?.closest('.upload-zone')?.querySelector('audio'))];}));
  const players=[...document.querySelectorAll('#result-content audio')].map(media);
  const artifacts=expectation.artifacts.map(artifact=>{const url=new URL(artifact.url,location.href).href;return {name:artifact.name,url,players:players.filter(player=>player.src===url||player.currentSrc===url)};});
  return {workspaceModel:document.getElementById('workspace-model')?.value,workspaceUnloaded:document.getElementById('page-workspace')?.classList.contains('workspace-unloaded'),jobStatus:document.getElementById('job-status')?.dataset.state,run:{present:!!run,visible:visible(run),disabled:run?.disabled,text:run?.textContent},settings:{present:!!settings,visible:visible(settings),disabled:settings?.disabled},load:{present:!!load,visible:visible(load),disabled:load?.disabled,text:load?.textContent},sources,players,artifacts};
}
function settledMediaFailures(snapshot,expectation,runtime) {
  const failures=[],ready=row=>row?.present&&row.visible&&row.readyState>=1&&row.duration>0&&!!row.currentSrc&&row.error===null;
  if(!runtime||runtime.busy||runtime.realtime_active)failures.push('runtime is not confirmed idle');
  if(runtime?.server?.model!==expectation.model&&runtime?.asr?.model!==expectation.model)failures.push('runtime model does not match');
  if(snapshot.workspaceModel!==expectation.model||snapshot.workspaceUnloaded!==false||!snapshot.settings.visible)failures.push('model detail is not restored');
  if(snapshot.jobStatus!==expectation.status)failures.push('terminal result state is missing');
  if(!snapshot.run.present||!snapshot.run.visible||snapshot.run.disabled!==false)failures.push('Generate is not visible and enabled');
  for(const key of expectation.sourceKeys)if(!ready(snapshot.sources[key]))failures.push(`uploaded ${key} metadata is not ready`);
  if(!expectation.artifacts.length)failures.push('job has no returned audio artifacts');
  if(snapshot.artifacts.length!==expectation.artifacts.length)failures.push('artifact-player contract is incomplete');
  for(const artifact of snapshot.artifacts)if(artifact.players.length!==1||!ready(artifact.players[0]))failures.push(`returned artifact ${artifact.name} player is missing, duplicated, or not ready`);
  // A source comparison player is allowed in addition to the job's returned artifacts.
  for(const [index,player] of snapshot.players.entries())if(!ready(player))failures.push(`result-card audio ${index} metadata is not ready`);
  return failures;
}
async function verifySettledMedia(stage) {
  assert(spec.model==='tone-color-vc'&&spec.task==='vc','settled-media flag is scoped to this Tone upload regression');
  const expectation={model:spec.model,status:job.status,sourceKeys:['audio','voice'].filter(key=>Object.hasOwn(spec.inputs,key)),artifacts:(job.artifacts||[]).filter(artifact=>artifact.kind==='audio'||/\.(wav|mp3|flac|ogg|m4a|webm)$/i.test(artifact.name)).map(({name,url})=>({name,url}))};
  const began=Date.now(),timeout=30000,deadline=began+timeout,samples=[];let consecutive=0,final;
  while(Date.now()<deadline){
    let runtime=null,runtimeError=null;
    try{const response=await page.request.get(`${base}/api/workbench/status`,{timeout:Math.max(1,Math.min(10000,deadline-Date.now()))});if(!response.ok())throw Error(`HTTP ${response.status()}`);runtime=await response.json();}catch(error){runtimeError=String(error);}
    const snapshot=await page.evaluate(settledMediaSnapshot,expectation),failures=settledMediaFailures(snapshot,expectation,runtime);
    final={time:new Date().toISOString(),elapsed_ms:Date.now()-began,runtime,runtimeError,snapshot,failures};samples.push(final);
    consecutive=failures.length?0:consecutive+1;if(consecutive>=2)break;
    if(Date.now()<deadline)await page.waitForTimeout(Math.min(250,deadline-Date.now()));
  }
  const record={stage,timeout_ms:timeout,required_consecutive_samples:2,expectation,samples,status:consecutive>=2?'pass':'fail'};(report.settledMedia||=[]).push(record);persist();
  assert(consecutive>=2,`settled media reaches the expected state within ${timeout}ms: ${stage}`,record);
  assert(final.snapshot.run.disabled===false,`settled media Generate disabled property is false: ${stage}`,final.snapshot.run);
  for(const key of expectation.sourceKeys)assert(!final.failures.some(text=>text.startsWith(`uploaded ${key} `)),`settled uploaded ${key} has real audio metadata: ${stage}`,final.snapshot.sources[key]);
  assert(final.snapshot.artifacts.length===expectation.artifacts.length&&final.snapshot.artifacts.every(artifact=>artifact.players.length===1),`settled returned artifact players match job artifacts: ${stage}`,final.snapshot.artifacts);
}

async function setControl(locator,value,name) {
  await locator.waitFor({state:'visible'});
  const type=await locator.evaluate(el=>el.tagName==='SELECT'?'select':el.type||'textarea');
  if(type==='checkbox')await locator.setChecked(Boolean(value));
  else if(type==='select') {
    const options=await locator.locator('option').evaluateAll(elements=>elements.map(el=>({value:el.value,label:el.label})));
    const option=options.find(o=>o.value===String(value))||options.find(o=>o.label===String(value)||o.value.replace(/\.[^.]+$/,'')===String(value));
    if(!option)throw Error(`No accepted choice for ${name}: ${value}`);await locator.selectOption(option.value);value=option.value;
  }else if(type==='range') {
    const bounds=await locator.evaluate(el=>({min:Number(el.min||0),max:Number(el.max||100),step:Number(el.step||1)}));
    const steps=Math.round((Number(value)-bounds.min)/bounds.step);
    if(steps<0||Number(value)>bounds.max||steps>1000)throw Error(`Slider value requires an invalid or excessive keyboard range: ${name}`);
    const beforeHome=await locator.inputValue();await locator.focus();await locator.press('Home');
    const atHome=await locator.inputValue();
    if(steps===0&&atHome===beforeHome) {
      assert(bounds.step>0&&bounds.min+bounds.step<=bounds.max,`range has a distinct adjacent value: ${name}`,bounds);
      await locator.press('ArrowRight');const adjacent=await locator.inputValue();
      assert(adjacent!==atHome,`range accepts an adjacent keyboard step: ${name}`,{before:atHome,adjacent});
      await locator.press('Home');(report.rangeInteractions||=[]).push({name,before:beforeHome,adjacent,final:await locator.inputValue(),forced_adjacent_then_home:true});
    }
    for(let i=0;i<steps;i++)await locator.press('ArrowRight');
  }else await locator.fill(typeof value==='object'?JSON.stringify(value):String(value));
  const result=await locator.evaluate(el=>({value:el.type==='checkbox'?el.checked:el.value,valid:el.checkValidity(),message:el.validationMessage}));
  assert(result.valid,`valid UI input: ${name}`,result);return result.value;
}
async function setOptionControl(control,value,name) {
  if(await control.evaluate(el=>el.type)==='checkbox') {
    const before=await control.isChecked(),target=Boolean(value),forced=before===target;
    if(forced)await control.setChecked(!target);
    await setControl(control,value,name);
    return {name,before,target,forced_opposite_then_target:forced};
  }
  await setControl(control,value,name);
  return null;
}
async function enterOptions(detail) {
  const extra={},checkboxInteractions=[],entries=Object.entries(spec.options).sort(([a],[b])=>a==='task_route'?-1:b==='task_route'?1:0);
  for(const [key,value] of entries) {
    const control=page.locator(`[id=${JSON.stringify(`param-${key.replace(/[^\w-]/g,'-')}`)}]`);
    if(!await control.count()) {extra[key]=value;continue;}
    if(!await control.isVisible())await page.locator('#parameter-toggle').click();
    const checkbox=await setOptionControl(control,value,key);if(checkbox)checkboxInteractions.push(checkbox);
    if(await page.locator('#workspace-settings').evaluate(el=>el.matches(':popover-open')))await page.keyboard.press('Escape');
  }
  if(Object.keys(extra).length) {await page.locator('#parameter-toggle').click();await page.locator('#options-json').fill(JSON.stringify(extra));await page.keyboard.press('Escape');}
  report.optionEntry={controls:entries.filter(([key])=>!Object.hasOwn(extra,key)).map(([key])=>key),advancedJson:extra,checkboxInteractions};
}
async function enterInputs() {
  const expected={};
  for(const [key,value] of Object.entries(spec.inputs)) {
    if(['audio','voice','rvc_voice_model','rvc_retrieval_index'].includes(key)) {
      const file=path.resolve(typeof value==='object'?value.path:value);assert(fs.existsSync(file),`input file exists: ${key}`,{file});
      const input=page.locator(`#task-inputs input[type="file"][data-input-key=${JSON.stringify(key)}]`);
      const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/workbench/uploads'&&r.request().method()==='POST');
      await input.setInputFiles(file);const uploaded=await (await response).json();
      expected[key]=uploaded.id;report.uploads.push({key,...uploaded,source:file,path:path.resolve('webui/output/workbench-inputs',`${uploaded.id}${path.extname(file).toLowerCase()}`)});
      await page.waitForFunction(()=>!document.querySelector('.upload-status')?.textContent.includes('正在上传'));
      continue;
    }
    let input=page.locator(`#task-form [data-input-key=${JSON.stringify(key)}], #workspace-settings [data-input-key=${JSON.stringify(key)}]`).first();
    if(!await input.count())throw Error(`This model does not expose input ${key}.`);
    if(!await input.isVisible())await page.locator('#parameter-toggle').click();
    expected[key]=await setControl(input,value,key);
    if(await page.locator('#workspace-settings').evaluate(el=>el.matches(':popover-open')))await page.keyboard.press('Escape');
  }
  report.expectedInputs=expected;
}
async function verifyDownloads() {
  const links=page.locator('#job-status a[download], #result-content a[download]');
  const count=await links.count();assert(count===(job.artifacts||[]).length,'one download link per returned artifact',{links:count,artifacts:job.artifacts?.length||0});
  for(let i=0;i<count;i++) {
    const href=await links.nth(i).getAttribute('href'),downloaded=page.waitForEvent('download');await links.nth(i).click();const file=await downloaded;
    const destination=path.join(output,`download-${i}-${safe(path.basename(file.suggestedFilename()))}`);await file.saveAs(destination);
    const bytes=fs.readFileSync(destination);assert(bytes.length>0,`download ${i} contains data`,{href,size:bytes.length});
    report.downloads.push({href,path:destination,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
  }
}
async function verifyTextActions() {
  const result=page.locator('#result-content .result-text');
  await result.waitFor();const value=await result.inputValue();assert(value.trim().length>0,'result text is nonempty before copy/export');
  await page.locator('#copy-result').click();const normalize=text=>text.replace(/\r\n/g,'\n');let copied='';const start=Date.now();
  while(Date.now()-start<3000){copied=await page.evaluate(()=>navigator.clipboard.readText());if(normalize(copied)===normalize(value))break;await page.waitForTimeout(50);}
  assert(normalize(copied)===normalize(value),'result Copy writes displayed text to the real clipboard',{comparison:'Windows CRLF normalized to LF',characters:value.length});
  const event=page.waitForEvent('download');await page.locator('#export-result').click();const download=await event;
  const destination=path.join(output,`export-${safe(download.suggestedFilename())}`);await download.saveAs(destination);const bytes=fs.readFileSync(destination);
  assert(normalize(bytes.toString('utf8'))===normalize(value),'result Export downloads displayed text',{path:destination,bytes:bytes.length});
  report.textExport={path:destination,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
}
function verifyResultContract() {
  const wanted=spec.assertions||{},artifacts=job.artifacts||[],audio=artifacts.filter(a=>a.kind==='audio'||/\.(wav|mp3|flac|ogg|m4a|webm)$/i.test(a.name));
  if(wanted.min_artifacts!=null)assert(artifacts.length>=wanted.min_artifacts,'result meets minimum artifact count',{expected:wanted.min_artifacts,actual:artifacts.length});
  if(wanted.minimum_audio_artifacts!=null)assert(audio.length>=wanted.minimum_audio_artifacts,'result meets minimum audio artifact count',{expected:wanted.minimum_audio_artifacts,actual:audio.length});
  if(wanted.nonempty_text)assert(typeof job.text==='string'&&job.text.trim().length>0,'backend returns nonempty result text',{characters:job.text?.length||0});
  for(const suffix of wanted.artifact_suffixes||[])assert(artifacts.some(a=>(a.name||'').toLowerCase().endsWith(suffix.toLowerCase())),`result includes ${suffix} artifact`,{names:artifacts.map(a=>a.name)});
  if(wanted.parameter_updates_nonempty)assert(Object.keys(job.parameter_updates||{}).length>0,'source analysis returns parameter updates',job.parameter_updates);
}
async function verifyParameterRefill() {
  const names=['source_caption','source_lyrics','bpm','keyscale','timesignature'],updates=job.parameter_updates||{};
  const expected=names.map(name=>({name,expected:updates[name],status:!Object.hasOwn(updates,name)?'not_returned':updates[name]==null||String(updates[name]).trim()===''?'not_tested_empty_update':'pending'}));
  const meaningful=expected.filter(row=>row.status==='pending');
  assert(meaningful.length>0,'source analysis has nonempty updates to verify in UI',{fields:expected});
  const popover=page.locator('#workspace-settings');let opened=false;
  try {
    if(!await popover.evaluate(el=>el.matches(':popover-open'))){await page.locator('#parameter-toggle').click();opened=true;}
    let fields,deadline=Date.now()+3000;
    do {
      const controls=await page.evaluate(names=>Object.fromEntries(names.map(name=>{const id='param-'+name.replace(/[^\w-]/g,'-'),element=document.getElementById(id);return [name,element?{id,present:true,tag:element.tagName,type:element.type,value:element.value,visible:!!element.getClientRects().length}:{id,present:false}];})),names);
      fields=expected.map(row=>{if(row.status!=='pending')return row;const control=controls[row.name],matches=control.present&&parameterUpdateValue(row.name,control.value)===parameterUpdateValue(row.name,row.expected);return {...row,status:matches?'pass':'fail',control,normalizedExpected:parameterUpdateValue(row.name,row.expected),normalizedActual:control.present?parameterUpdateValue(row.name,control.value):null};});
      if(fields.every(row=>row.status!=='fail')||Date.now()>=deadline)break;
      await page.waitForTimeout(100);
    }while(true);
    report.parameterRefill={method:'Actual post-analysis DOM input values; CRLF normalized, bpm/timesignature numeric strings canonicalized, keyscale outer whitespace trimmed; lyrics line breaks remain significant.',fields};
    await shot('05-analysis-refilled-controls');let failure;
    for(const field of fields.filter(row=>['pass','fail'].includes(row.status))){const name=`source analysis fills actual UI control: ${field.name}`;report.checks.push({name,status:field.status,details:field});if(field.status==='fail'&&!failure)failure=name;}
    persist();if(failure)throw Error(failure);
  }finally{if(opened)await page.keyboard.press('Escape');}
}
async function verifyAudio(selector='#result-content audio') {
  const players=page.locator(selector);
  for(let i=0;i<await players.count();i++) {
    const player=players.nth(i);await player.evaluate(el=>{if(el.readyState===0)el.load();});
    await page.waitForFunction(({selector,index})=>{const el=document.querySelectorAll(selector)[index];return el?.readyState>=2&&Number.isFinite(el.duration)&&el.duration>0;},{selector,index:i},{timeout:30000});
    const metadata=await player.evaluate(el=>({url:el.currentSrc,duration:el.duration,readyState:el.readyState,error:el.error?.message||null}));
    const playback=await player.evaluate(async el=>{
      const events=[],started=performance.now(),url=el.currentSrc;
      const types=['play','playing','waiting','stalled','timeupdate','ended','error'];
      const observe=event=>events.push({event:event.type,elapsedMs:Math.round(performance.now()-started),currentTime:el.currentTime,readyState:el.readyState});
      for(const type of types)el.addEventListener(type,observe);
      let playTimer,error=null,initialTime;
      try{
        el.pause();el.currentTime=0;initialTime=el.currentTime;
        await Promise.race([el.play(),new Promise((_,reject)=>{playTimer=setTimeout(()=>reject(Error('Media play() did not settle within 10 seconds.')),10000);})]);
        clearTimeout(playTimer);
        // Windows/headless audio output can start later than play() resolves.
        // Observe the same element's clock instead of a single fixed 400ms sample.
        const minimumAdvance=Math.min(.1,el.duration/3),deadline=performance.now()+10000;
        while(performance.now()<deadline&&!el.error&&el.isConnected&&el.currentSrc===url&&el.currentTime-initialTime<minimumAdvance&&!el.ended)await new Promise(resolve=>setTimeout(resolve,50));
        return {currentTime:el.currentTime,initialTime,advanced:el.currentTime-initialTime>=minimumAdvance||el.ended&&el.currentTime>initialTime,paused:el.paused,ended:el.ended,connected:el.isConnected,sameSource:el.currentSrc===url,error:el.error?.message||null,elapsedMs:Math.round(performance.now()-started),events};
      }catch(failure){error=failure.message;return {currentTime:el.currentTime,initialTime,advanced:false,error,elapsedMs:Math.round(performance.now()-started),events};}
      finally{clearTimeout(playTimer);el.pause();for(const type of types)el.removeEventListener(type,observe);}
    });
    report.audio.push({metadata,playback});
    assert(playback.advanced&&!playback.error&&playback.connected&&playback.sameSource,`audio ${i} decodes and advances`,{metadata,playback});
  }
  const returnedAudio=(job.artifacts||[]).filter(a=>a.kind==='audio'||/\.(wav|mp3|flac|ogg|m4a|webm)$/i.test(a.name));
  assert((await players.count())>=returnedAudio.length,'all returned audio artifacts have players',{players:await players.count(),returnedAudio:returnedAudio.length});
}
async function main() {
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true,permissions:['clipboard-read','clipboard-write']});page=await context.newPage();page.setDefaultTimeout(30000);
  page.on('pageerror',error=>report.pageErrors.push(error.message));
  await page.route('**/api/**',async intercepted=>{
    const request=intercepted.request(),pathname=new URL(request.url()).pathname;
    if(['GET','HEAD','OPTIONS'].includes(request.method()))return intercepted.continue();
    const allowed=!playbackReport&&request.method()==='POST'&&(pathname==='/api/workbench/uploads'||pathname==='/api/workbench/jobs'||pathname===`/api/workbench/models/${encodeURIComponent(spec.model)}/load`||(jobId&&pathname===`/api/workbench/jobs/${jobId}/cancel`));
    if(!allowed) {report.failures.push({name:'Unexpected API mutation blocked',method:request.method(),url:request.url()});return intercepted.abort('blockedbyclient');}
    let body;try{body=request.postDataJSON();}catch{body={multipart:request.headers()['content-type']?.startsWith('multipart/form-data'),bytes:request.postDataBuffer()?.length};}
    report.posts.push({time:new Date().toISOString(),method:request.method(),url:request.url(),body});persist();return intercepted.continue();
  });
  page.on('response',response=>{
    if(response.request().method()!=='POST')return;
    pendingResponses.push((async()=>{const record=report.posts.findLast(p=>p.url===response.url()&&!p.response);if(record){let data;try{data=await response.json();}catch{data=await response.text().catch(()=>null);}record.response={status:response.status(),data};persist();}})());
  });
  await page.goto(`${base}/#tts`,{waitUntil:'domcontentloaded'});await page.locator('#connection-status[data-state="online"]').waitFor();
  report.runtime_context=await qaContext.verifyContext(page,base,qaContext.readContext(qaConfig));persist();
  if(playbackReport){
    job=playbackReport.job;assert(job?.status==='done','source report contains a completed existing job',{id:job?.id,status:job?.status});report.job=slimJob(job);
    const artifacts=(job.artifacts||[]).filter(a=>a.kind==='audio'||/\.(wav|mp3|flac|ogg|m4a|webm)$/i.test(a.name));
    assert(artifacts.length>0,'source report has existing audio artifacts',{artifacts});
    await page.evaluate(artifacts=>{const panel=document.createElement('section');panel.id='qa-existing-audio';for(const artifact of artifacts){const audio=document.createElement('audio');audio.controls=true;audio.preload='auto';audio.src=artifact.url;panel.append(audio);}document.body.append(panel);},artifacts);
    await verifyAudio('#qa-existing-audio audio');assert(report.posts.length===0,'playback-only sends no API mutations',{posts:report.posts});return;
  }
  await page.evaluate(()=>localStorage.setItem('audiocpp-reference-auto','false'));
  const initial=await get('/status');assert(!initial.busy&&!initial.realtime_active,'runtime is idle before browser execution',initial);
  const detail=await get(`/models/${encodeURIComponent(spec.model)}`);assert(detail.installed,'selected model is installed',{model:spec.model,installed:detail.installed});
  routeName=routeFor(detail);assert(spec.task===detail.task||spec.task===detail.model_task,'case task agrees with model route',{requested:spec.task,actual:detail.task,modelTask:detail.model_task});
  await navigateUi(routeName);await page.locator('#model-picker-trigger').click();await page.locator('#model-picker-search').fill(spec.model);
  const selected=page.waitForResponse(r=>r.url().endsWith(`/api/workbench/models/${encodeURIComponent(spec.model)}`));
  await page.locator(`[data-model=${JSON.stringify(spec.model)}] .model-row-select`).click();await selected;await page.locator('#parameter-toggle').waitFor({state:'visible'});await page.keyboard.press('Escape');
  await page.waitForTimeout(250);assert(report.posts.length===0,'selecting model sends no loading or inference POST',{posts:report.posts});
  report.beforeLoad={generateEnabled:await page.locator('#run-button').isEnabled(),runtime:await get('/status')};
  await enterOptions(detail);await enterInputs();await shot('01-selected-and-inputs');
  // Use the per-row explicit load action even if this model is already resident.
  await page.locator('#model-picker-trigger').click();await page.locator('#model-picker-search').fill(spec.model);
  const loaded=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/workbench/models/${encodeURIComponent(spec.model)}/load`,{timeout:spec.timeout_ms});
  await page.locator(`[data-load-model=${JSON.stringify(spec.model)}]`).click();const loadResponse=await loaded;const loadResult=await loadResponse.json();
  assert(loadResponse.ok(),'explicit browser load succeeds',loadResult);
  await page.locator('#run-button:enabled').waitFor({timeout:spec.timeout_ms});assert(await page.locator('#run-button').isEnabled(),'loading enables Generate');await shot('02-loaded');
  await verifyFreshNativeModel();
  const started=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/workbench/jobs'&&r.request().method()==='POST');
  await page.locator(spec.action==='analyze_source'?'#analyze-music-source':'#run-button').click();const response=await started;assert(response.ok(),'browser submits a real job',{status:response.status()});jobId=(await response.json()).id;submitted=true;report.jobId=jobId;
  const post=report.posts.findLast(p=>new URL(p.url).pathname==='/api/workbench/jobs');assert(post?.body.model===spec.model,'submitted model matches the case',post?.body);
  assert(post.body.task===detail.task,'submitted task matches the active menu',{expected:detail.task,actual:post.body.task});
  if(spec.action)assert(post.body.action===spec.action,'submitted action matches the selected UI button',{expected:spec.action,actual:post.body.action});
  for(const [key,value] of Object.entries(report.expectedInputs))assert(submittedInputMatches(value,post.body.inputs[key]),`submitted input matches UI: ${key}`,{expected:value,actual:post.body.inputs[key],...(value===''||value===null?{contract:'collectInputs omits empty optional inputs; explicit empty is equivalent',omitted:!Object.hasOwn(post.body.inputs,key)}:{})});
  for(const [key,value] of Object.entries(spec.options)) {
    const actual=post.body.options[key],explicitCheckbox=report.optionEntry.checkboxInteractions.some(row=>row.name===key),matches=explicitCheckbox?JSON.stringify(actual)===JSON.stringify(value):submittedOptionMatches(key,value,actual,detail);
    assert(matches,`submitted option matches UI: ${key}`,{expected:value,actual,...(explicitCheckbox?{contract:'Real model-parameter checkbox input events require an explicit, type-strict POST value.'}:matches&&actual===undefined?{contract:'Only Qwen3-TTS 1.7B VoiceDesign sampling true defaults may be omitted: unchanged checkboxes do not create overrides; C++ Qwen3TTSGenerationOptions defaults both to true.',omitted:true}:{})});
  }
  await shot('03-running');const began=Date.now();let cancelled=false,cancelStageSince=null;
  const cancelStage=spec.cancel_stage_pattern?new RegExp(spec.cancel_stage_pattern,'i'):null;
  report.jobProgress=[];
  while(Date.now()-began<spec.timeout_ms) {
    job=await get(`/jobs/${jobId}`);
    const previous=report.jobProgress.at(-1);
    if(!previous||previous.status!==job.status||previous.message!==job.message)report.jobProgress.push({time:new Date().toISOString(),elapsed_ms:Date.now()-began,status:job.status,message:job.message});
    if(['done','error','cancelled'].includes(job.status))break;
    const stageMatches=!cancelStage||cancelStage.test(String(job.message||''));
    if(cancelStage&&stageMatches&&cancelStageSince===null)cancelStageSince=Date.now();
    const cancelElapsed=Date.now()-(cancelStage?cancelStageSince??Date.now():began);
    if(spec.cancel_after_ms!=null&&!cancelled&&stageMatches&&cancelElapsed>=spec.cancel_after_ms) {
      report.cancelRequestedFrom={time:new Date().toISOString(),elapsed_ms:Date.now()-began,stage_elapsed_ms:cancelElapsed,status:job.status,message:job.message};
      if(cancelStage)assert(cancelStage.test(String(job.message||'')),'Stop is requested during the required real synthesis stage',report.cancelRequestedFrom);
      await page.locator('#cancel-job').click();cancelled=true;
      const immediate=await page.evaluate(()=>({state:document.querySelector('#job-status')?.dataset.state,label:document.querySelector('#job-status')?.textContent,disabled:document.querySelector('#cancel-job')?.disabled}));
      report.cancelImmediate=immediate;
      assert(['cancelling','cancelled'].includes(immediate.state),'Stop immediately acknowledges cancellation',immediate);
      if(immediate.state==='cancelling'){
        assert(immediate.disabled===true,'Stopping disables duplicate Stop clicks',immediate);
        assert(immediate.label?.includes('正在停止任务'),'Stopping immediately displays 正在停止任务',immediate);
      }else assert(immediate.label?.includes('任务已停止'),'Instant cancellation displays 任务已停止',immediate);
      await shot('04-cancelling');
    }
    await page.waitForTimeout(700);
  }
  report.job=slimJob(job||{});assert(job&&['done','error','cancelled'].includes(job.status),'job reaches a terminal state',report.job);
  assert(job.status===(spec.cancel_after_ms!=null?'cancelled':'done'),'job has the expected final status',report.job);
  await page.waitForFunction(status=>document.querySelector('#job-status')?.dataset.state===status,job.status,{timeout:10000});
  if(spec.cancel_after_ms!=null){
    assert(cancelled,'The real browser Stop button was clicked',{cancelRequestedFrom:report.cancelRequestedFrom});
    assert(String(job.message||'').includes('任务已停止'),'Backend cancellation finishes with 任务已停止',{message:job.message});
    assert((await page.locator('#job-status').textContent()).includes('任务已停止'),'Final UI cancellation label is 任务已停止');
  }
  if(spec.assert_settled_controls)await verifySettledControls('terminal');
  if(spec.assert_settled_media)await verifySettledMedia('terminal');
  await shot('05-complete');
  if(job.status==='done') {
    verifyResultContract();
    if(spec.assertions?.parameter_updates_nonempty)await verifyParameterRefill();
    if(detail.task==='tts'&&spec.inputs.stream)assert(job.audio_segments?.length>0,'streaming TTS returns actual PCM segments',{segments:job.audio_segments?.length||0,rates:[...new Set((job.audio_segments||[]).map(segment=>segment.sample_rate))]});
    if(spec.play_audio)await verifyAudio();if(spec.download)await verifyDownloads();if(spec.text_actions)await verifyTextActions();
    if(spec.persist_route) {
      const before=await page.locator('#result-content').evaluate(el=>({text:el.querySelector('textarea')?.value||'',audio:[...el.querySelectorAll('audio')].map(a=>a.src)}));
      await navigateUi('models');await navigateUi(routeName);
      await page.waitForFunction(status=>document.querySelector('#job-status')?.dataset.state===status,job.status);
      if(spec.assert_settled_controls)await verifySettledControls('returned-route');
      if(spec.assert_settled_media)await verifySettledMedia('returned-route');
      const after=await page.locator('#result-content').evaluate(el=>({text:el.querySelector('textarea')?.value||'',audio:[...el.querySelectorAll('audio')].map(a=>a.src)}));
      assert(JSON.stringify(before)===JSON.stringify(after),'results persist after navigating away and back',{before,after});await shot('06-persistent-result');
    }
  }
}
main().catch(async error=>{
  report.failures.push({name:'execution',error:error.stack});console.error(error.stack);
  if(submitted&&jobId&&(!job||!['done','error','cancelled'].includes(job.status))) {
    try {if(await page.locator('#cancel-job').isVisible())await page.locator('#cancel-job').click();report.cleanup='Requested cancellation of this script-owned job after failure.';}catch(cleanup){report.cleanup=cleanup.message;}
  }
  if(page)await shot('failure').catch(()=>{});
}).finally(async()=>{
  await Promise.allSettled(pendingResponses);report.finished=new Date().toISOString();report.status=report.failures.length||report.pageErrors.length||report.checks.some(c=>c.status==='fail')?'fail':'pass';persist();
  if(browser)await browser.close();console.log(JSON.stringify({status:report.status,report:path.join(output,'execution.json'),job:jobId,checks:report.checks.length,failures:report.failures.length}));process.exitCode=report.status==='pass'?0:1;
});
