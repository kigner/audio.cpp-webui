/* Deterministic browser regression for the real workbench UI.
 * No server, model, microphone, download, or cloud request is used.
 * Run: node webui/test_workbench_browser.cjs
 * Optional: AUDIOCPP_PLAYWRIGHT_MODULE, AUDIOCPP_BROWSER_EXECUTABLE,
 * AUDIOCPP_BROWSER_TEST_FILTER, AUDIOCPP_BROWSER_SCREENSHOTS.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require(process.env.AUDIOCPP_PLAYWRIGHT_MODULE || 'playwright');

const ORIGIN = 'http://127.0.0.1:17780';
const API = '/api/workbench';
const STATIC = path.join(__dirname, 'workbench_static');
const PRESET_PARAMETERS = require('./configs/model_params.json');
const ACE_CONTROLS = require('./configs/ace_step_controls.json');
const clone = value => JSON.parse(JSON.stringify(value));

function wav(marker = 0) {
  const samples = 1600;
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  data.writeInt16LE(marker, 44);
  return data;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => {resolve = done;});
  return {promise, resolve};
}

async function waitUntil(check, message) {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function model(id, label, task, modelTask, extra = {}) {
  return {id, label, task, model_task:modelTask, family:id, installed:true,
    installable:true, deletable:extra.installed!==false, description:`Fixture ${label}`, backend:'cpu', format:'GGUF',
    profile:{accepts_voice_reference:false, send_seed:false, send_max_tokens:false},
    languages:['english', 'chinese'], voice_mode:'builtin', streaming:false,
    ...(task==='asr'?{asr_inputs:{context:true,context_label:'专有名词',details:true,dialogue:true}}:{}),
    parameters:[
      {name:'speaker', label:'内置音色', type:'select', choices:['voice-a','voice-b'],
        default:'voice-a', level:'basic', scope:'request'},
      {name:'speed', label:'语速', type:'number', default:1, min:.5, max:2,
        step:.05, level:'effect', scope:'request'},
      {name:'load_options.threads', label:'推理线程', type:'int', default:4,
        min:1, max:16, level:'expert', scope:'load'},
    ], ...extra,...(extra.family==='ace_step'?{music_inputs:{...extra.music_inputs,ace_step:{...ACE_CONTROLS,dit_variant:'acestep-v15-turbo'}}}:{})};
}

function fixture() {
  const models = [
    model('tts-one', 'TTS One', 'tts', 'tts', {streaming:true, profile:{accepts_voice_reference:false, send_seed:true, send_max_tokens:false}}),
    model('tts-two', 'TTS Two', 'tts', 'clon', {description:'**TTS Two**：必须提供参考音频；参考文本需与音频一致。', streaming:true, profile:{accepts_voice_reference:false, send_seed:true, send_max_tokens:false}}),
    model('tts-missing', 'TTS Not Installed', 'tts', 'tts', {installed:false}),
    model('asr-one', 'ASR One', 'asr', 'asr', {parameters:[
      {name:'load_options.threads', label:'推理线程', type:'int', default:4,
        min:1, max:16, level:'expert', scope:'load'}]}),
    model('music-one', 'Music One', 'music', 'gen', {music_inputs:{lyrics:false, source_audio:false, duration:false, text_role:'prompt'}}),
    model('music-ace', 'ACE Route Fixture', 'music', 'gen', {family:'ace_step',
      music_inputs:{lyrics:true, source_audio:true, source_audio_routes:['audio2audio'],
        source_required_routes:['audio2audio'], duration:true, duration_default:30, duration_min:-1, duration_max:120},
      parameters:[{name:'task_route', label:'创作方式', type:'select', choices:['text2music','audio2audio'],
        default:'text2music', level:'basic', scope:'request'}]}),
    model('voice-convert', 'Voice conversion', 'vc', 'vc', {voice_mode:'reference',
      profile:{accepts_voice_reference:true, require_vc_target:true, send_reference_text:false, send_seed:false},
      parameters:[{name:'pitch', label:'音高', type:'number', default:0, min:-12, max:12,
        level:'effect', scope:'request'}]}),
    model('voice-design', 'Voice design', 'design', 'vdes'),
    model('align-one', 'Align One', 'analysis', 'align'),
    model('midi-one', 'MIDI One', 'analysis', 'midi'),
  ];
  const status = {server:{text:'未加载模型', model:null, configuration:{
    managed:false, load_options:{}, session_options:{}, mode:'offline'}},
    hardware:{vram_gb:null, backend:'cpu'}, asr:{model:null,managed:false}, busy:false, job:null, realtime_active:false};
  const state = {models, status, loads:[], loadGate:null, loadError:false, loadNoModel:false, detailError:null, detailGates:new Map(), expectedHttpErrors:0, requests:[], uploads:[], jobs:new Map(),
    uploadGates:new Map(), uploadDurations:new Map(), uploadAttempts:[], referenceClips:[], referenceSaveGate:null, submitGate:null, jobPolls:new Map(), errors:[], voices:[], referenceRequests:[], referenceSaves:[], unloads:[]};
  state.holdUpload = name => {const gate = deferred(); state.uploadGates.set(name, gate); return gate;};
  state.finish = (id, text, names) => {
    const job = state.jobs.get(id);
    assert.ok(job, `Unknown fixture job ${id}`);
    Object.assign(job, {status:'done', message:'处理完成', text, elapsed:1.25,
      artifacts:names.map((name, index) => ({name, kind:name.endsWith('.wav')?'audio':'file',
        url:`${API}/files/${id}-${index}`}))});
    status.busy = false; status.job = null;
  };
  state.route = async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = body => route.fulfill({status:200, contentType:'application/json', body:JSON.stringify(body)});
    if (url.origin !== ORIGIN) {
      state.errors.push(`External request blocked: ${request.method()} ${url.href}`);
      return route.abort('blockedbyclient');
    }
    const pathname = url.pathname;
    if (pathname === '/' || pathname.startsWith('/workbench-static/')) {
      const file = pathname === '/' ? 'index.html' : pathname.slice('/workbench-static/'.length);
      const full = path.resolve(STATIC, file);
      if (!full.startsWith(STATIC + path.sep)) throw new Error(`Unsafe static path: ${file}`);
      const contentType = {'.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png'}[path.extname(full)] || 'application/octet-stream';
      return route.fulfill({status:200, contentType, body:await fs.readFile(full)});
    }
    if (pathname === '/favicon.ico') return route.fulfill({status:204, body:''});
    if (pathname.startsWith('/realtime/')) {
      const file=pathname.slice('/realtime/'.length)||'index.html';
      const root=path.join(__dirname,'realtime_static'),full=path.resolve(root,file);
      if(!full.startsWith(root+path.sep))throw new Error(`Unsafe realtime path: ${file}`);
      // Load the real UI modules. Merely opening settings/history must not start inference.
      let body=await fs.readFile(full);
      if(file==='index.html'&&state.staleRealtimeDocument&&!url.search) {
        // Model the cached pre-library document: the new script cannot find its
        // reference refresh button. A new iframe URL must bypass this document.
        body=Buffer.from(body.toString('utf8').replace('id="tts-reference-refresh"','id="legacy-reference-refresh"'));
      }
      const contentType={'.html':'text/html','.js':'application/javascript','.mjs':'application/javascript','.css':'text/css','.png':'image/png'}[path.extname(full)]||'application/octet-stream';
      return route.fulfill({status:200,contentType,body});
    }
    if(pathname==='/api/realtime/config'||pathname==='/config')return json(state.realtimeConfig||{api_base:'/api/realtime',tts_models:[],asr_models:[]});
    if(pathname===`${API}/mobile/qr`)return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>'});
    if(pathname===`${API}/mobile/config`) {
      const body=clone(request.postDataJSON());
      (state.mobileSaves||=[]).push(body);
      const gate=state.mobileSaveGate;state.mobileSaveGate=null;if(gate)await gate.promise;
      if(state.mobileSaveError)return route.fulfill({status:503,json:{detail:'Fixture: mobile sync unavailable'}});
      state.mobileConfig=body;
      return json(mobileStatus());
    }
    if(pathname===`${API}/mobile`) {
      if(request.method()==='POST'){
        const body=request.postDataJSON();(state.mobileToggles||=[]).push(body);state.mobileRunning=body.enabled;
      }
      return json(mobileStatus());
    }
    function mobileStatus(){
      const saved=state.mobileConfig;
      return {enabled:!!state.mobileRunning,running:!!state.mobileRunning,configured:!!saved,error:'',addresses:[],urls:[],
        character:saved?.character.name||'',models:saved?.config||{}};
    }
    if (pathname === `${API}/catalog`) return json({version:'browser-fixture', models,
      tasks:[{id:'tts', types:['tts','clon']}, {id:'asr', types:['asr']},
        {id:'music', types:['gen']}, {id:'vc',types:['vc']}, {id:'design',types:['vdes']},
        {id:'analysis', types:['align','midi']}], ...status});
    if (pathname === `${API}/status`) return json(status);
    if (pathname === `${API}/voices`) return json({voices:state.voices});
    if (pathname === `${API}/reference-transcriptions`) {
      const body=clone(request.postDataJSON());state.referenceRequests.push(body);
      const id=`reference-${state.referenceRequests.length}`;
      status.asr={model:'qwen3-asr',managed:true};status.busy=true;status.job=id;
      state.jobs.set(id,{id,status:'running',text:'',message:'识别中',artifacts:[],audio_segments:[]});return json({id});
    }
    if (pathname === `${API}/references` && request.method() === 'POST') {
      const body=clone(request.postDataJSON());state.referenceSaves.push(body);const name=body.name.replace(/\.wav$/i,'')+'.wav';
      if(state.voices.some(v=>v.name===name)&&!body.overwrite){state.expectedHttpErrors++;return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({detail:'已有同名参考音频'})});}
      state.voices=state.voices.filter(v=>v.name!==name);state.voices.push({name,label:name.slice(0,-4),text:body.text,duration:state.referenceClips.find(c=>c.id===body.audio)?.duration||.1,url:`${API}/references/${encodeURIComponent(name)}/audio`});if(state.referenceSaveGate)await state.referenceSaveGate.promise;return json({name,voices:state.voices,message:'参考音频已保存。'});
    }
    if(pathname===`${API}/reference-clips`&&request.method()==='POST'){
      const body=clone(request.postDataJSON());const clip={...body,id:`clip-${state.referenceClips.length+1}`,name:'reference-clip.wav',duration:body.end_seconds-body.start_seconds};
      clip.url=`${API}/uploads/${clip.id}/audio`;state.referenceClips.push(clip);return json(clip);
    }
    if(/^\/api\/workbench\/uploads\/[^/]+\/audio$/.test(pathname))return route.fulfill({status:200,contentType:'audio/wav',body:wav()});
    const reference=/^\/api\/workbench\/references\/([^/]+)(\/audio)?$/.exec(pathname);
    if(reference){if(reference[2])return route.fulfill({status:200,contentType:'audio/wav',body:wav()});state.voices=state.voices.filter(v=>v.name!==decodeURIComponent(reference[1]));return json({voices:state.voices,message:'参考音频已删除。'});}
    if (pathname === `${API}/downloads`) return json({downloads:state.downloads||[]});
    const downloadModel=/^\/api\/workbench\/downloads\/([^/]+)$/.exec(pathname);
    if(downloadModel&&request.method()==='POST'){
      const found=models.find(item=>item.id===decodeURIComponent(downloadModel[1]));
      found.installed=true;found.deletable=true;
      state.downloads=[{id:'reinstall',model:found.id,label:found.label,status:'done'}];return json(state.downloads[0]);
    }
    if (pathname === `${API}/health`) return json({application:'audio.cpp.workbench',
      install_id:'fixture', instance_id:'fixture-instance', pid:12345,
      shutting_down:false, shutdown_available:false, shutdown_token:'fixture-only'});
    if (pathname === `${API}/logs`) return json({directory:'fixture/logs', logs:[]});
    if (pathname === `${API}/api-docs`) return json({base_url:ORIGIN, endpoints:[]});
    if (pathname === `${API}/unload-all`) {
      state.unloads.push(pathname);status.server.model=null;status.asr={model:null,managed:false};
      return json({message:'已卸载工作台所有内存模型。',...status});
    }
    if (pathname === `${API}/uploads` && request.method() === 'POST') {
      const raw=request.postDataBuffer()?.toString('utf8')||'',name=/filename="([^"]+)"/.exec(raw)?.[1]||'fixture.wav';
      const purpose=/name="purpose"\r\n\r\n([^\r\n]+)/.exec(raw)?.[1]||'',recorded=/name="recorded"\r\n\r\ntrue/.test(raw),duration=state.uploadDurations.get(name)??.1;
      state.uploadAttempts.push({name,purpose,recorded,duration});
      if(purpose==='tts-reference'&&duration>30||purpose==='reference-library'&&duration>=1200){
        state.expectedHttpErrors++;return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({detail:purpose==='tts-reference'?'参考音频推理会占用大量显存，请选择30秒内的音频':'音频库原始音频须小于20分钟。'})});
      }
      const upload = {id:`upload-${state.uploads.length+1}`, name,duration};
      state.uploads.push(upload);
      if (state.uploadGates.has(name)) await state.uploadGates.get(name).promise;
      return json(upload);
    }
    const removal=/^\/api\/workbench\/models\/([^/]+)\/(deletion|delete)$/.exec(pathname);
    if(removal){
      const found=models.find(item=>item.id===decodeURIComponent(removal[1]));
      if(removal[2]==='deletion'){
        if(state.deletionPreviewGate)await state.deletionPreviewGate.promise;
        return json({model:found.id,label:found.label,path:'D:/models/'+found.id,files:5,bytes:1048576,token:'confirmed-fixture',
          affected:state.deletionAffected||[{id:found.id,label:found.label}],blocker:state.deletionBlocker||
            (status.server.model?{reason:'请先卸载所有已加载的模型，释放权重文件后再删除。',unload:true}:null)});
      }
      (state.deletions||=[]).push({id:found.id,...clone(request.postDataJSON())});
      if(state.deletionGate)await state.deletionGate.promise;
      if(state.deletionError){state.expectedHttpErrors++;return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({detail:state.deletionError})});}
      for(const item of models.filter(m=>(state.deletionAffected||[{id:found.id}]).some(affected=>affected.id===m.id))){item.installed=false;item.deletable=false;}
      return json({message:'本地模型文件已删除；参数配置、音色库和生成结果已保留。',...status});
    }
    const detail = /^\/api\/workbench\/models\/([^/]+)$/.exec(pathname);
    if (detail) {
      const found = models.find(item => item.id === decodeURIComponent(detail[1]));
      assert.ok(found, `Unexpected fixture model ${detail[1]}`);
      if (state.detailGates.has(found.id)) await state.detailGates.get(found.id).promise;
      if(state.detailError===found.id){state.expectedHttpErrors++;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'Fixture detail failed'})});}
      return json(found);
    }
    const load = /^\/api\/workbench\/models\/([^/]+)\/load$/.exec(pathname);
    if (load && request.method() === 'POST') {
      const body = request.postDataJSON();
      state.loads.push({model:load[1], ...clone(body)});
      if (state.loadGate) await state.loadGate.promise;
      if (state.loadError) {state.expectedHttpErrors++;return route.fulfill({status:500, contentType:'application/json', body:JSON.stringify({detail:'Fixture load failed'})});}
      if(state.loadNoModel)return json({message:'loaded',...status});
      const options = body.options || {};
      const configuration = {managed:true, load_options:{...(options.load_options || {})},
        session_options:{...(options.session_options || {})}, mode:'offline'};
      for (const [key, value] of Object.entries(options)) {
        for (const scope of ['load_options','session_options']) {
          if (key.startsWith(scope+'.')) configuration[scope][key.slice(scope.length+1)] = value;
        }
      }
      // The real Python backend stores runtime values as strings, with JSON whitespace.
      for(const scope of ['load_options','session_options'])configuration[scope]=Object.fromEntries(
        Object.entries(configuration[scope]).map(([key,value])=>[key,
          typeof value==='object'?JSON.stringify(Array.isArray(value)?value:Object.fromEntries(Object.entries(value).reverse()),null,1):String(value)]));
      if(status.asr.model===load[1])status.asr={model:load[1],managed:true,configuration};
      else status.server = {text:'模型已加载', model:load[1], configuration};
      return json({message:'loaded', ...status});
    }
    if (pathname === `${API}/jobs` && request.method() === 'POST') {
      const body = clone(request.postDataJSON());
      const id = `job-${state.requests.length+1}`;
      state.requests.push(body);
      const job = {id, task:body.task, model:body.model, status:'running', message:'正在处理',
        text:'', artifacts:[], audio_segments:[], elapsed:0};
      state.jobs.set(id, job); status.busy = true; status.job = id;
      if (state.submitGate) await state.submitGate.promise;
      return json(job);
    }
    const cancelJob=/^\/api\/workbench\/jobs\/([^/]+)\/cancel$/.exec(pathname);
    if(cancelJob){const current=state.jobs.get(cancelJob[1]);assert.ok(current);current.message='正在停止任务…';return json(current);}
    const job = /^\/api\/workbench\/jobs\/([^/]+)$/.exec(pathname);
    if (job) {
      assert.ok(state.jobs.has(job[1]), `Unexpected fixture job ${job[1]}`);
      state.jobPolls.set(job[1], (state.jobPolls.get(job[1]) || 0) + 1);
      return json(state.jobs.get(job[1]));
    }
    if (pathname.startsWith(`${API}/files/`)) {
      return route.fulfill({status:200, contentType:'audio/wav', body:wav()});
    }
    state.errors.push(`Unhandled fixture request: ${request.method()} ${pathname}`);
    return route.fulfill({status:404, contentType:'application/json', body:'{"detail":"Missing browser fixture"}'});
  };
  return state;
}

async function waitText(page, selector, text) {
  await page.waitForFunction(({selector,text}) => {
    const el=document.querySelector(selector);if(!el)return false;
    return el.textContent.includes(text)||[...el.querySelectorAll('textarea')].some(input=>input.value.includes(text));
  }, {selector,text});
}
async function waitValue(page, selector, value) {
  await page.waitForFunction(({selector,value}) => document.querySelector(selector)?.value === value, {selector,value:String(value)});
}
async function task(page, id, label) {
  await page.locator(`[data-route="${id}"]`).click();
  await page.waitForFunction(id => document.querySelector('#page-workspace').dataset.task === id, id);
  if (label && ((await page.locator('#model-picker-label').textContent()) !== label || (await page.locator('#workspace-load').textContent()) !== '已加载')) {
    const models = {tts:'tts-one',asr:'asr-one',music:'music-one',vc:'voice-convert',design:'voice-design'};
    await pick(page, models[id]);
  }
  if (label) {await waitText(page, '#model-picker-label', label);await page.locator('#parameter-toggle').waitFor({state:'visible'});}
}
async function pick(page, id) {
  await page.locator('#model-picker-trigger').click();
  await page.locator(`#model-picker-list [data-model="${id}"] .model-row-load`).click();
  await page.waitForFunction(() => !document.querySelector('#model-picker-popover').matches(':popover-open'));
  await page.waitForFunction(id => document.querySelector(`[data-load-model="${id}"]`)?.textContent==='已加载'&&!document.querySelector(`[data-load-model="${id}"]`)?.disabled,id);
  await page.locator('#workspace-grid').waitFor({state:'visible'});
}
async function advanced(page) {
  if (!await page.locator('#workspace-settings').isVisible()) await page.locator('#parameter-toggle').click();
  await page.locator('#expert-panel').waitFor();
}
async function upload(page, selector, name, marker = 0) {
  if(selector.includes('voice')&&selector.includes('task-form')) {
    const reference=page.locator('#task-form .tts-reference-tabs');
    if(await reference.count())await reference.getByRole('tab',{name:'上传 / 录音',exact:true}).click();
  }
  await page.locator(selector).setInputFiles({name, mimeType:'audio/wav', buffer:wav(marker)});
  await page.waitForFunction(({selector,name})=>(document.querySelector(selector)?.closest('.reference-upload-fields')||document.querySelector(selector)?.closest('.upload-zone'))?.querySelector('.upload-status')?.textContent.includes(name),{selector,name});
}
async function referenceMore(page) {
  await page.locator('#task-form .reference-controls').waitFor({state:'attached'});
  const tabs=page.locator('#task-form .tts-reference-tabs');
  if(await tabs.count())await tabs.getByRole('tab',{name:'上传 / 录音',exact:true}).click();
  await page.locator('#task-form details.reference-more').evaluateAll(items=>items.forEach(el=>el.open=true));
}
async function assertVisibleControl(page,selector,message) {
  await page.locator(selector).evaluate(el=>el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}));
  const geometry=await page.locator(selector).evaluate(el=>{
    const r=el.getBoundingClientRect(),target=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
    return {width:r.width,height:r.height,top:r.top,bottom:r.bottom,visible:target===el||el.contains(target),viewport:innerHeight};
  });
  assert.ok(geometry.width>0&&geometry.height>0&&geometry.top>=-1&&geometry.bottom<=geometry.viewport+1&&geometry.visible,`${message}: ${JSON.stringify(geometry)}`);
}
async function assertBrowserScroll(page) {
  const panels=await page.locator('.main-content,#page-workspace,.workspace-operation,#workspace-grid,.input-card,#task-form,#task-inputs,.task-reference,.result-card,#result-content,#job-status').evaluateAll(items=>items.filter(el=>el.getClientRects().length).map(el=>({name:el.id||el.className,overflow:getComputedStyle(el).overflowY})));
  assert.deepEqual(panels.filter(panel=>['auto','scroll','hidden'].includes(panel.overflow)),[],'Main panels must use browser scrolling');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Unexpected horizontal page scrolling');
}
function presetParameters(family) {
  const basic=['task_route','voice_id','speaker','language'],effect=['audio_cover_strength','semitone_shift','retrieval_blend'];
  return clone(PRESET_PARAMETERS[family]).map(param=>({...param,scope:'request',level:basic.includes(param.name)?'basic':effect.includes(param.name)?'effect':'expert'}));
}
async function snapshot(page, name) {
  if (!process.env.AUDIOCPP_BROWSER_SCREENSHOTS) return;
  await fs.mkdir(process.env.AUDIOCPP_BROWSER_SCREENSHOTS, {recursive:true});
  await page.screenshot({path:path.join(process.env.AUDIOCPP_BROWSER_SCREENSHOTS, `${name}.png`), fullPage:true});
}

const cases = [
  ['model deletion confirms shared entries and preserves parameters after reinstall', async (page, backend) => {
    await task(page,'tts','TTS One');
    await page.locator('[data-input-key="text"]').fill('保留我的合成文本');
    await page.locator('#param-speed').fill('1.3');
    backend.deletionAffected=[{id:'tts-one',label:'TTS One'},{id:'tts-two',label:'TTS Two'}];
    await page.locator('[data-route="models"]').click();await page.locator('#model-list [data-model="tts-one"]').click();
    await page.locator('#model-detail').getByRole('button',{name:'删除本地模型',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'删除本地模型',exact:true});await dialog.waitFor();
    assert.match(await dialog.textContent(),/D:\/models\/tts-one/);assert.match(await dialog.textContent(),/TTS Two/);
    assert.equal(await dialog.getByRole('button',{name:'确认删除',exact:true}).isDisabled(),true);
    await snapshot(page,'model-delete-desktop');
    await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal(backend.deletions?.length||0,0);
    await page.locator('#model-detail').getByRole('button',{name:'删除本地模型',exact:true}).click();
    await dialog.getByRole('button',{name:'卸载全部模型',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.model-delete-actions .danger').disabled);
    assert.equal(backend.unloads.length,1);
    const gate=backend.deletionGate=deferred();await dialog.getByRole('button',{name:'确认删除',exact:true}).click();
    await waitUntil(()=>backend.deletions?.length===1,'Deletion request missing');
    assert.equal(backend.deletions[0].token,'confirmed-fixture');
    assert.equal(await dialog.getByRole('button',{name:'正在删除…',exact:true}).isDisabled(),true);
    await page.keyboard.press('Escape');assert.equal(await dialog.isVisible(),true);gate.resolve();
    await dialog.waitFor({state:'hidden'});await page.locator('#model-detail').getByRole('button',{name:'下载模型',exact:true}).waitFor();
    assert.equal(backend.models.find(m=>m.id==='tts-one').installed,false);assert.equal(backend.models.find(m=>m.id==='tts-two').installed,false);
    await page.locator('#model-detail').getByRole('button',{name:'下载模型',exact:true}).click();
    await page.locator('#model-detail').getByRole('button',{name:'选用模型',exact:true}).waitFor();
    await page.locator('[data-route="tts"]').click();await pick(page,'tts-one');
    await waitValue(page,'#param-speed','1.3');await waitValue(page,'[data-input-key="text"]','保留我的合成文本');
  }],
  ['model deletion handles stale confirmation and mobile layout', async (page, backend) => {
    backend.status.server.model=null;
    await page.setViewportSize({width:390,height:900});
    await page.locator('[data-route="models"]').click();await page.locator('#model-list [data-model="tts-one"]').click();
    await page.locator('#model-detail').getByRole('button',{name:'删除本地模型',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'删除本地模型',exact:true});await dialog.waitFor();
    assert.ok(await dialog.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.height<=innerHeight&&el.scrollWidth<=el.clientWidth;}));
    await snapshot(page,'model-delete-mobile');
    backend.deletionError='模型文件或关联入口已变化，请重新查看删除范围后确认。';
    await dialog.getByRole('button',{name:'确认删除',exact:true}).click();await waitText(page,'.model-delete-message','已变化');
    assert.equal(backend.models.find(m=>m.id==='tts-one').installed,true);
    backend.deletionError=null;
    await dialog.getByRole('button',{name:'重新检查',exact:true}).click();
    await dialog.getByRole('button',{name:'确认删除',exact:true}).waitFor();
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
    assert.equal(backend.deletions.length,1);
  }],
  ['model deletion blocks active downloads and cancellation stays closed during refresh', async (page, backend) => {
    backend.deletionBlocker={reason:'请先完成或取消当前下载（暂停的下载也需取消），再删除模型。',unload:false};
    await page.locator('[data-route="models"]').click();await page.locator('#model-list [data-model="tts-one"]').click();
    await page.locator('#model-detail').getByRole('button',{name:'删除本地模型',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'删除本地模型',exact:true});await dialog.waitFor();
    assert.equal(await dialog.getByRole('button',{name:'确认删除',exact:true}).isDisabled(),true);
    assert.equal(await dialog.getByRole('button',{name:'卸载全部模型',exact:true}).count(),0);
    const gate=backend.deletionPreviewGate=deferred();
    const response=page.waitForResponse(r=>r.url().endsWith('/models/tts-one/deletion'));
    await dialog.getByRole('button',{name:'重新检查',exact:true}).click();
    await dialog.getByRole('button',{name:'取消',exact:true}).click();gate.resolve();await response;
    assert.equal(await dialog.count(),0);assert.equal(backend.deletions?.length||0,0);
  }],
  ['reference pending save preserves the original and clip after navigation', async (page, backend) => {
    backend.uploadDurations.set('navigation-original.wav',120);
    await page.locator('[data-route="references"]').click();const editor=page.locator('#reference-editor');
    await editor.locator('.reference-automatic input').uncheck();
    await upload(page,'#reference-editor [data-input-key="voice"]','navigation-original.wav');
    const original=await editor.locator('.reference-original-preview').getAttribute('src');
    await editor.locator('[data-clip-range="_clipStart"]').fill('10');await editor.locator('[data-clip-range="_clipEnd"]').fill('25');
    await editor.getByRole('button',{name:'裁剪片段',exact:true}).click();await editor.locator('.reference-clip-preview audio').waitFor();
    const clip=await editor.locator('.reference-clip-preview audio').getAttribute('src');
    await editor.locator('[data-input-key="reference_name"]').fill('跨页保存片段');
    const gate=backend.referenceSaveGate=deferred(),saved=page.waitForResponse(response=>new URL(response.url()).pathname===`${API}/references`&&response.request().method()==='POST');
    await editor.locator('.reference-save').click();await waitUntil(()=>backend.referenceSaves.length===1,'Delayed reference save missing');
    await page.locator('[data-route="tts"]').click();gate.resolve();await saved;await waitText(page,'#toast','参考音频已保存');backend.referenceSaveGate=null;
    await page.locator('[data-route="references"]').click();
    assert.equal(await editor.locator('.reference-original-preview').getAttribute('src'),original,'A save completed on another page must preserve the original');
    assert.equal(await editor.locator('[data-clip-range="_clipStart"]').inputValue(),'10');assert.equal(await editor.locator('[data-clip-range="_clipEnd"]').inputValue(),'25');
    assert.equal(await editor.locator('.reference-clip-preview audio').getAttribute('src'),clip,'The prepared clip must survive a save completed on another page');
    await editor.locator('[data-clip-range="_clipStart"]').fill('50');await editor.locator('[data-clip-range="_clipEnd"]').fill('70');
    await editor.getByRole('button',{name:'裁剪片段',exact:true}).click();await waitUntil(()=>backend.referenceClips.length===2,'Same-original follow-up clip missing');
    assert.equal(backend.referenceClips[1].audio,'upload-1');assert.equal(backend.referenceSaves[0].audio,'clip-1');assert.equal(backend.uploads.length,1);assert.equal(backend.referenceRequests.length,0);
  }],
  ['reference auto transcription waits for clipping when the original exceeds thirty seconds', async (page, backend) => {
    backend.uploadDurations.set('long-original.wav',30.01);backend.uploadDurations.set('short-original.wav',30);
    await page.locator('[data-route="references"]').click();const editor=page.locator('#reference-editor');
    assert.equal(await editor.locator('.reference-automatic input').isChecked(),true);
    await upload(page,'#reference-editor [data-input-key="voice"]','long-original.wav');
    await waitText(page,'#reference-editor .reference-status','请选择不超过30秒的片段');
    assert.equal(backend.referenceRequests.length,0,'Long original must not be transcribed with automatic recognition enabled');
    assert.equal(await editor.getByRole('button',{name:'音频转录',exact:true}).isDisabled(),true);
    assert.equal(await editor.locator('.reference-save').isDisabled(),true);
    await editor.getByRole('button',{name:'裁剪片段',exact:true}).click();
    await waitUntil(()=>backend.referenceRequests.length===1,'Clipped audio should be transcribed automatically');
    assert.equal(backend.referenceRequests[0].audio,'clip-1');assert.equal(backend.referenceClips[0].audio,'upload-1');
    backend.finish('reference-1','裁剪片段的原文',[]);await waitValue(page,'#reference-editor [data-input-key="reference_text"]','裁剪片段的原文');
    await upload(page,'#reference-editor [data-input-key="voice"]','short-original.wav');
    await waitUntil(()=>backend.referenceRequests.length===2,'A thirty-second upload should retain automatic recognition');
    assert.equal(backend.referenceRequests[1].audio,'upload-2');
    backend.finish('reference-2','短音频的原文',[]);await waitValue(page,'#reference-editor [data-input-key="reference_text"]','短音频的原文');
    assert.equal(await editor.getByRole('button',{name:'音频转录',exact:true}).isEnabled(),true);
  }],
  ['reference clips preserve the original while recognizing and saving multiple entries', async (page, backend) => {
    backend.uploadDurations.set('long-original.wav',120);
    await page.locator('[data-route="references"]').click();await page.locator('#reference-editor .reference-automatic input').uncheck();
    const editor=page.locator('#reference-editor');
    assert.ok(await page.locator('.references-grid').evaluate(el=>{const cards=[...el.children].map(item=>item.getBoundingClientRect());return cards[0].right<=cards[1].left&&Math.abs(cards[0].width-cards[1].width)<2&&el.firstElementChild.contains(document.querySelector('#reference-list'));}),'Saved entries must occupy the left half');
    await upload(page,'#reference-editor [data-input-key="voice"]','long-original.wav');
    const original=await editor.locator('.reference-original-preview').getAttribute('src');
    assert.equal(backend.uploadAttempts[0].purpose,'reference-library');assert.equal(backend.referenceRequests.length,0);
    assert.equal(await editor.locator('.reference-save').isDisabled(),true);
    for(const [index,start,end,name] of [[1,0,20,'片段一'],[2,40,65,'片段二']]){
      await editor.locator('[data-clip-range="_clipStart"]').fill(String(start));await editor.locator('[data-clip-range="_clipEnd"]').fill(String(end));
      await editor.getByRole('button',{name:'裁剪片段',exact:true}).click();await waitUntil(()=>backend.referenceClips.length===index,'Clip request missing');
      await editor.locator('.reference-clip-preview audio').waitFor();
      await editor.locator('.reference-retry').click();await waitUntil(()=>backend.referenceRequests.length===index,'Clip recognition missing');
      assert.equal(backend.referenceRequests[index-1].audio,`clip-${index}`);
      backend.finish(`reference-${index}`,`${name}原文`,[]);await waitValue(page,'#reference-editor [data-input-key="reference_text"]',`${name}原文`);
      await editor.locator('[data-input-key="reference_name"]').fill(name);await editor.locator('.reference-save').click();
      await waitUntil(()=>backend.voices.length===index,'Clip save missing');
      assert.equal(backend.referenceSaves[index-1].audio,`clip-${index}`);assert.equal(backend.referenceClips[index-1].audio,'upload-1');
      assert.equal(await editor.locator('.reference-original-preview').getAttribute('src'),original,'Saving must preserve the original preview');
      await waitValue(page,'#reference-editor [data-input-key="reference_name"]','');
    }
    assert.equal(backend.uploads.length,1);assert.deepEqual(backend.voices.map(item=>item.duration),[20,25]);
    await snapshot(page,'reference-clips-desktop');await page.setViewportSize({width:390,height:900});await assertBrowserScroll(page);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await snapshot(page,'reference-clips-mobile');
  }],
  ['reference clip range changes discard stale recognition and enforce the source limit', async (page, backend) => {
    backend.uploadDurations.set('original.wav',900);backend.uploadDurations.set('twenty-minutes.wav',1200);
    await page.locator('[data-route="references"]').click();await page.locator('#reference-editor .reference-automatic input').uncheck();
    const editor=page.locator('#reference-editor');await upload(page,'#reference-editor [data-input-key="voice"]','original.wav');
    await editor.getByRole('button',{name:'裁剪片段',exact:true}).click();await editor.locator('.reference-clip-preview audio').waitFor();
    await editor.locator('.reference-retry').click();await waitUntil(()=>backend.referenceRequests.length===1,'First clip recognition missing');
    await editor.locator('[data-clip-range="_clipStart"]').fill('40');await editor.locator('[data-clip-range="_clipEnd"]').fill('60');
    backend.finish('reference-1','过时片段的文字',[]);await page.waitForFunction(()=>document.querySelector('#reference-editor .reference-stop').hidden);
    assert.equal(await editor.locator('[data-input-key="reference_text"]').inputValue(),'');assert.equal(await editor.locator('.reference-adopt').isVisible(),false);
    assert.equal(await editor.locator('.reference-save').isDisabled(),true);
    await editor.getByRole('button',{name:'裁剪片段',exact:true}).click();await waitUntil(()=>backend.referenceClips.length===2,'Second clip missing');await editor.locator('.reference-clip-preview audio').waitFor();
    await editor.locator('.reference-retry').click();await waitUntil(()=>backend.referenceRequests.length===2,'New clip recognition missing');
    assert.equal(backend.referenceRequests[1].audio,'clip-2');backend.finish('reference-2','当前片段的文字',[]);await waitValue(page,'#reference-editor [data-input-key="reference_text"]','当前片段的文字');
    await editor.locator('[data-input-key="voice"]').setInputFiles({name:'twenty-minutes.wav',mimeType:'audio/wav',buffer:wav()});
    await waitText(page,'#toast','小于20分钟');assert.equal(backend.uploads.length,1);
  }],
  ['TTS overlong uploads show the memory warning and cannot reach recognition or inference', async (page, backend) => {
    Object.assign(backend.models.find(item=>item.id==='tts-two'),{voice_mode:'reference',profile:{accepts_voice_reference:true,require_voice:true,send_reference_text:true}});
    backend.uploadDurations.set('too-long.wav',30.01);await pick(page,'tts-two');await referenceMore(page);
    await page.locator('#task-form [data-input-key="voice"]').setInputFiles({name:'too-long.wav',mimeType:'audio/wav',buffer:wav()});
    await waitText(page,'#toast','参考音频推理会占用大量显存，请选择30秒内的音频');
    assert.equal(backend.uploadAttempts[0].purpose,'tts-reference');assert.equal(backend.uploads.length,0);assert.equal(backend.referenceRequests.length,0);
    await page.locator('[data-input-key="text"]').fill('这次不应发送推理请求');await page.locator('#run-button').click();await waitText(page,'#job-status','需要参考声音');assert.equal(backend.requests.length,0);
    assert.equal(await page.locator('.reference-upload-fields audio').getAttribute('src'),null);
  }],
  ['TTS recording stops at thirty seconds and navigation clears its timer without uploading', async (page, backend) => {
    Object.assign(backend.models.find(item=>item.id==='tts-two'),{voice_mode:'reference',profile:{accepts_voice_reference:true,require_voice:true,send_reference_text:true}});
    await pick(page,'tts-two');await referenceMore(page);await page.locator('.reference-automatic input').uncheck();await page.clock.install();
    await page.evaluate(bytes=>{
      window.referenceStops=0;window.referenceTrackStops=0;
      Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>({getTracks:()=>[{stop:()=>window.referenceTrackStops++}]})});
      window.MediaRecorder=class extends EventTarget{
        static isTypeSupported(){return true;}constructor(){super();this.state='inactive';this.mimeType='audio/webm';}start(){this.state='recording';}
        stop(){if(this.state!=='recording')throw new Error('Duplicate recording stop');this.state='inactive';window.referenceStops++;const event=new Event('dataavailable');event.data=new Blob([new Uint8Array(bytes)],{type:'audio/wav'});this.dispatchEvent(event);this.dispatchEvent(new Event('stop'));}
      };
    },Array.from(wav()));
    await page.getByRole('button',{name:'录音',exact:true}).click();await page.clock.runFor(29999);assert.equal(await page.evaluate(()=>window.referenceStops),0);
    await page.clock.runFor(1);await waitUntil(()=>backend.uploads.length===1,'Automatic recording stop did not upload');
    assert.equal(await page.evaluate(()=>window.referenceStops),1);assert.equal(await page.evaluate(()=>window.referenceTrackStops),1);assert.equal(backend.uploadAttempts[0].recorded,true);
    await page.waitForFunction(()=>document.querySelector('.recording-start')&&!document.querySelector('.recording-start').disabled);
    await page.getByRole('button',{name:'录音',exact:true}).click();await page.locator('[data-route="references"]').click();await page.clock.runFor(31000);
    assert.equal(await page.evaluate(()=>window.referenceStops),2);assert.equal(await page.evaluate(()=>window.referenceTrackStops),2);assert.equal(backend.uploads.length,1,'Navigating away must discard unfinished recording');
  }],
  ['TTS refresh constructs the reference players once after startup data is ready', async (page, backend) => {
    Object.assign(backend.models.find(item=>item.id==='tts-two'),{voice_mode:'reference',profile:{accepts_voice_reference:true,require_voice:true,send_reference_text:true}});
    await page.addInitScript(()=>{
      window.referencePlayers=[];
      const create=document.createElement.bind(document);
      document.createElement=(name,...args)=>{
        const element=create(name,...args);
        if(name.toLowerCase()==='audio')window.referencePlayers.push(element);
        return element;
      };
    });
    const originalRoute=backend.route;
    for(const mode of ['empty','saved','loaded','catalog-error','detail-error']){
      backend.status.server.model=mode==='loaded'?'tts-two':null;
      backend.detailError=mode==='detail-error'?'tts-two':null;
      const catalog=deferred(),requested=deferred();
      backend.route=async route=>{
        if(new URL(route.request().url()).pathname===`${API}/catalog`){
          requested.resolve();await catalog.promise;
          if(mode==='catalog-error'){
            backend.expectedHttpErrors++;
            return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'Fixture catalog failed'})});
          }
        }
        return originalRoute(route);
      };
      await page.evaluate(mode=>{
        localStorage.removeItem('audiocpp-model-choices');
        if(mode==='saved'||mode==='detail-error')localStorage.setItem('audiocpp-model-choices',JSON.stringify({tts:'tts-two'}));
      },mode);
      const initialized=page.waitForResponse(`${ORIGIN}${API}/downloads`);
      await page.reload();await requested.promise;
      assert.equal(await page.locator('.reference-library-fields audio').count(),0,`${mode}: do not show a temporary player before catalog resolution`);
      assert.equal(await page.locator('#workspace-loading').isVisible(),true);
      assert.equal(await page.locator('#common-options').isVisible(),false,'Do not expose options without their inputs during refresh');
      assert.equal(await page.locator('#run-button').isVisible(),false);
      catalog.resolve();await initialized;
      const player=page.locator('.reference-library-fields audio');await player.waitFor({state:'visible'});
      assert.equal(await page.locator('#workspace-loading').isVisible(),false);
      assert.equal(await page.evaluate(()=>window.referencePlayers.filter(audio=>audio.hasAttribute('data-reference-preview')).length),1,`${mode}: startup must not recreate the library player`);
      assert.equal(await page.locator('.reference-upload-fields audio').count(),1);
      assert.equal(await player.getAttribute('src'),null);
      assert.equal(await player.getAttribute('aria-disabled'),'true');
      assert.equal(backend.loads.length,0,'Restoring the selected model must not load it');
    }
    backend.route=originalRoute;
  }],
  ['TTS startup recovers after the reference library request fails on refresh', async (page, backend) => {
    const originalRoute=backend.route;
    backend.route=route=>{
      if(new URL(route.request().url()).pathname===`${API}/voices`){
        backend.expectedHttpErrors++;
        return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'Fixture voices failed'})});
      }
      return originalRoute(route);
    };
    const initialized=page.waitForResponse(`${ORIGIN}${API}/downloads`);
    await page.evaluate(()=>history.replaceState(null,'','#references'));
    await page.reload();await initialized;
    backend.route=originalRoute;
    await task(page,'tts','TTS One');
    await page.locator('[data-input-key="text"]').fill('请求恢复后仍可准备合成文本。');
    assert.equal(await page.locator('[data-input-key="text"]').inputValue(),'请求恢复后仍可准备合成文本。');
    assert.equal(backend.loads.length,0);
  }],
  ['TTS reference tabs preserve sources above text and generation precedes the output card', async (page, backend) => {
    Object.assign(backend.models.find(item=>item.id==='tts-two'),{voice_mode:'reference',profile:{accepts_voice_reference:true,require_voice:true,send_reference_text:true,send_seed:false,send_max_tokens:false}});
    await page.setViewportSize({width:1440,height:1000});await pick(page,'tts-two');
    backend.voices.push({name:'narrator.wav',label:'温暖男声',text:'欢迎来到声音工作台，这是一段用于试听和配音的参考语音。',url:`${API}/references/narrator.wav/audio`});
    await page.getByRole('button',{name:'刷新列表',exact:true}).click();
    const sourceTabs=page.locator('.tts-reference-tabs'),libraryTab=sourceTabs.getByRole('tab',{name:'音频库',exact:true}),uploadTab=sourceTabs.getByRole('tab',{name:'上传 / 录音',exact:true});
    assert.equal(await sourceTabs.getByRole('tablist').count(),1);
    assert.equal(await sourceTabs.getByRole('combobox',{name:'音频库',exact:true}).count(),1);
    assert.equal(await sourceTabs.getByRole('tabpanel',{includeHidden:true}).count(),2);
    assert.equal(await sourceTabs.getByRole('tabpanel',{name:'音频库',exact:true}).count(),1);
    assert.equal(await libraryTab.getAttribute('aria-selected'),'true');
    assert.equal(await uploadTab.getAttribute('aria-selected'),'false');
    assert.equal(await page.locator('.reference-library-fields').isVisible(),true);
    assert.equal(await page.locator('.reference-upload-fields').isVisible(),false);
    const libraryPlayer=page.locator('.reference-library-fields audio'),uploadPlayer=page.locator('.reference-upload-fields audio');
    for(const player of [libraryPlayer,uploadPlayer]){
      assert.equal(await player.getAttribute('src'),null);
      assert.equal(await player.getAttribute('aria-disabled'),'true');
    }
    assert.equal(await libraryPlayer.isVisible(),true,'The active empty library player must stay visible');
    assert.equal(await uploadPlayer.isVisible(),false);
    assert.equal(await page.locator('[data-reference-transcript]').getAttribute('placeholder'),'参考音频文本');
    assert.equal(await page.locator('[data-reference-transcript]').isDisabled(),true);
    const editorGeometry=()=>page.locator('[data-input-key="text"]').evaluate(el=>{const rect=el.getBoundingClientRect();return {height:rect.height,bottom:rect.bottom+scrollY,viewport:innerHeight};});
    const tallEditor=await editorGeometry();
    assert.ok(Math.abs(tallEditor.viewport-tallEditor.bottom-38)<2,'Synthesis text must fill available height with 38px of bottom space');
    await page.setViewportSize({width:1440,height:768});
    const regularEditor=await editorGeometry();
    assert.ok(Math.abs(regularEditor.viewport-regularEditor.bottom-38)<2,'The editor must follow browser height changes');
    assert.ok(Math.abs(tallEditor.height-regularEditor.height-232)<2,'A taller browser should expand the editor');
    await page.setViewportSize({width:1440,height:560});
    assert.ok((await editorGeometry()).height>=180,'Short windows must retain a usable editor');
    await assertBrowserScroll(page);
    await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>scrollTo(0,0));
    assert.ok(await page.locator('.reference-library-fields').evaluate(el=>{
      const r=selector=>el.querySelector(selector).getBoundingClientRect();
      const select=r('select'),actions=r('.reference-library-actions');
      return select.right<=actions.left&&Math.abs(select.top-actions.top)<3;
    }),'Library actions belong to the right of the dropdown');
    await snapshot(page,'tts-empty-desktop');
    await libraryTab.focus();await page.keyboard.press('ArrowRight');
    assert.equal(await uploadTab.getAttribute('aria-selected'),'true');
    assert.equal(await uploadTab.evaluate(el=>el===document.activeElement),true);
    assert.equal(await sourceTabs.getByRole('tabpanel',{name:'上传 / 录音',exact:true}).count(),1);
    assert.equal(await page.locator('.reference-library-fields').isVisible(),false);
    assert.equal(await page.locator('.reference-upload-fields').isVisible(),true);
    const uploadEditor=await editorGeometry();
    assert.ok(Math.abs(uploadEditor.viewport-uploadEditor.bottom-38)<2,'Reference tab height changes must keep the editor above the bottom space');
    assert.equal(await uploadPlayer.isVisible(),true,'The active empty upload player must stay visible');
    assert.equal(await page.locator('.reference-save').isVisible(),true);
    assert.equal(await page.locator('.reference-save').isDisabled(),true);
    assert.equal(await page.locator('[data-input-key="reference_name"]').isDisabled(),true);
    assert.equal(await page.locator('[data-input-key="reference_text"]').isDisabled(),true);
    assert.equal(await page.locator('.reference-controls').getByRole('button',{name:'音频转录',exact:true}).isDisabled(),true);
    assert.equal(await page.locator('#task-form [data-input-key="voice"]').isEnabled(),true);
    assert.equal(await page.locator('.reference-upload-actions').getByRole('button',{name:'录音',exact:true}).isEnabled(),true);
    assert.equal(await page.locator('.reference-library-fields [data-input-key="reference_name"]').count(),0);
    await page.keyboard.press('Home');assert.equal(await libraryTab.getAttribute('aria-selected'),'true');
    await page.keyboard.press('End');assert.equal(await uploadTab.getAttribute('aria-selected'),'true');
    await page.keyboard.press('ArrowLeft');assert.equal(await libraryTab.getAttribute('aria-selected'),'true');
    await page.locator('[data-input-key="builtin_voice"]').selectOption('narrator.wav');
    await waitValue(page,'[data-reference-transcript]','欢迎来到声音工作台，这是一段用于试听和配音的参考语音。');
    assert.equal(await page.locator('[data-reference-transcript]').evaluate(el=>el.readOnly),true);
    assert.equal(await page.locator('[data-input-key="reference_text"]').inputValue(),'');
    assert.equal(await page.locator('[data-input-key="reference_text"]').isDisabled(),true);
    assert.equal(backend.referenceRequests.length,0);
    assert.match(await libraryPlayer.getAttribute('src'),/narrator\.wav\/audio$/);
    assert.equal(await libraryPlayer.getAttribute('aria-disabled'),'false');
    assert.equal(await uploadPlayer.getAttribute('aria-disabled'),'true');
    await uploadTab.click();
    assert.equal(await page.locator('[data-input-key="builtin_voice"]').inputValue(),'narrator.wav');
    assert.equal(await page.locator('[data-reference-transcript]').inputValue(),'欢迎来到声音工作台，这是一段用于试听和配音的参考语音。');
    await libraryTab.click();
    await page.locator('[data-input-key="text"]').fill('让每一段文字，都有自然的声音。');
    const positions=await page.locator('#task-form').evaluate(el=>{
      const r=s=>{const control=document.querySelector(s),box=control.getBoundingClientRect(),style=getComputedStyle(control);return {left:box.left,right:box.right,contentLeft:box.left+parseFloat(style.paddingLeft)+parseFloat(style.borderLeftWidth),top:box.top,bottom:box.bottom};};return {references:r('.tts-reference-tabs'),text:r('[data-input-key="text"]'),heading:r('#common-options-heading'),settings:r('#common-options'),run:r('#run-button'),result:r('.result-card')};
    });
    assert.ok(positions.references.bottom<=positions.text.top&&Math.abs(positions.references.right-positions.text.right)<2&&positions.text.right<positions.settings.left,'Reference tabs belong above synthesis text in the left column');
    assert.ok(positions.heading.bottom<positions.settings.top&&positions.run.top-positions.settings.bottom===26,'The generate button stays one line below the common settings divider');
    assert.equal(await page.locator('.result-card').isVisible(),false,'TTS hides the output card until generation or an error');
    assert.equal(await page.locator('#result-heading').isVisible(),false,'TTS has no visible output label');
    assert.equal(await page.locator('#common-options-heading').evaluate(el=>getComputedStyle(el).borderBottomWidth),'1px','Common options label has a divider below it');
    assert.ok(await page.locator('#common-options').evaluate(el=>{const style=getComputedStyle(el);return style.backgroundColor==='rgba(0, 0, 0, 0)'&&style.borderTopWidth==='0px'&&style.borderLeftWidth==='0px'&&style.borderRightWidth==='0px'&&style.borderBottomWidth==='1px';}),'Common options must be transparent with only a bottom divider');
    assert.equal(await page.locator('#common-options-heading').textContent(),'合成选项');
    assert.equal(await page.locator('#common-options #run-button').count(),0);
    assert.equal(await page.locator('.tts-result-section #run-button').count(),1);
    assert.ok(Math.abs(positions.settings.contentLeft-positions.run.left)<2,`Generate action must align with the left content edge above the output: ${JSON.stringify(positions)}`);
    assert.equal(await page.locator('#common-options #common-options-heading').count(),0);
    await snapshot(page,'tts-library-desktop');
    await uploadTab.click();await page.locator('.reference-upload-fields .reference-automatic input').uncheck();
    await upload(page,'#task-form [data-input-key="voice"]','uploaded-reference.wav');
    assert.equal(await libraryPlayer.isVisible(),false);
    assert.equal(await libraryPlayer.getAttribute('src'),null);
    assert.equal(await libraryPlayer.getAttribute('aria-disabled'),'true');
    assert.equal(await page.locator('[data-input-key="builtin_voice"]').inputValue(),'');
    assert.equal(await page.locator('[data-reference-transcript]').inputValue(),'');
    assert.equal(await uploadPlayer.getAttribute('aria-disabled'),'false');
    assert.equal(await page.locator('[data-input-key="reference_text"]').isEnabled(),true);
    await page.locator('[data-input-key="reference_text"]').fill('上传音频的原文，可以校正后保存。');
    await page.locator('[data-input-key="reference_name"]').fill('新录制的声音');
    assert.equal(await uploadTab.getAttribute('aria-selected'),'true');
    const uploadedSource=await uploadPlayer.getAttribute('src');
    await libraryTab.click();
    await page.locator('#task-form').evaluate(form=>form.requestSubmit());
    await waitText(page,'#job-status','需要参考声音');
    assert.equal(backend.requests.length,0);
    await uploadTab.click();
    assert.equal(await page.locator('#run-button').isEnabled(),true);
    assert.equal(await uploadPlayer.getAttribute('src'),uploadedSource);
    assert.equal(await page.locator('[data-input-key="reference_text"]').inputValue(),'上传音频的原文，可以校正后保存。');
    assert.equal(await page.locator('[data-input-key="reference_name"]').inputValue(),'新录制的声音');
    assert.equal(await page.locator('.reference-upload-fields .reference-save').isVisible(),true);
    await snapshot(page,'tts-upload-desktop');
    await page.locator('.reference-controls').getByRole('button',{name:'音频转录',exact:true}).click();
    await waitUntil(()=>backend.referenceRequests.length===1,'Temporary audio was not submitted for recognition');
    assert.deepEqual(backend.referenceRequests[0],{audio:'upload-1',source:''});
    backend.finish('reference-1','重新识别后的原文',[]);await waitValue(page,'[data-input-key="reference_text"]','重新识别后的原文');
    await page.waitForFunction(()=>!document.querySelector('.reference-save').disabled);
    await page.locator('.reference-save').click();
    await waitValue(page,'[data-input-key="builtin_voice"]','新录制的声音.wav');
    assert.equal(backend.referenceSaves[0].audio,'upload-1');assert.equal(backend.referenceSaves[0].source,'');
    assert.equal(backend.referenceSaves[0].text,'重新识别后的原文');
    assert.equal(await libraryTab.getAttribute('aria-selected'),'true','Saving an upload must return to its new library entry');
    assert.equal(await page.locator('.reference-save').isVisible(),false);
    assert.equal(await page.locator('.reference-save').isDisabled(),true);
    assert.equal(await uploadPlayer.isVisible(),false);
    assert.equal(await uploadPlayer.getAttribute('src'),null);
    assert.equal(await uploadPlayer.getAttribute('aria-disabled'),'true');
    assert.equal(await page.locator('[data-input-key="reference_text"]').isDisabled(),true);
    assert.equal(await page.locator('[data-input-key="reference_name"]').isDisabled(),true);
    await uploadTab.click();
    assert.equal(await page.locator('[data-input-key="builtin_voice"]').inputValue(),'新录制的声音.wav');
    await page.locator('#run-button').click();await waitText(page,'#job-status','需要参考声音');
    assert.equal(backend.requests.length,0,'An empty active upload tab must not use the hidden library selection');
    await libraryTab.click();
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'Library generation not submitted');
    assert.equal(backend.requests[0].inputs.builtin_voice,'新录制的声音.wav');assert.equal(backend.requests[0].inputs.voice,undefined);
    assert.equal(backend.requests[0].inputs.reference_text,'重新识别后的原文');
    await page.locator('#cancel-job').waitFor({state:'visible'});await snapshot(page,'tts-generating-desktop');
    await page.locator('#cancel-job').click();await waitText(page,'#job-status','正在停止');
    Object.assign(backend.jobs.get('job-1'),{status:'cancelled',message:'任务已取消。'});backend.status.busy=false;backend.status.job=null;
    await waitText(page,'#job-status','任务已取消');
    await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);await page.locator('#run-button').click();
    await waitUntil(()=>backend.requests.length===2,'Second synthesis not submitted');backend.finish('job-2','',['合成语音.wav']);
    await waitText(page,'#job-status','合成语音.wav');await snapshot(page,'tts-result-desktop');
    for(const width of [1366,960,390,320]){
      await page.setViewportSize({width,height:900});await assertBrowserScroll(page);
      await assertVisibleControl(page,'#run-button','Generate action unreachable');
      assert.ok(await page.locator('#common-options').evaluate(el=>{
        const area=el.getBoundingClientRect(),items=[...el.querySelectorAll('.generate-row,.field-group')].map(item=>item.getBoundingClientRect()).filter(box=>box.width&&box.height);
        return items.every((box,i)=>box.left>=area.left-1&&box.right<=area.right+1&&(!i||(box.top<items[i-1].bottom&&items[i-1].top<box.bottom?box.left>=items[i-1].right-1:box.top>=items[i-1].bottom-1)));
      }),`TTS controls must flow left to right and wrap within common options at ${width}px`);
    }
    await page.evaluate(()=>window.scrollTo(0,0));await snapshot(page,'tts-library-mobile');
    await libraryTab.click();
    await page.getByRole('button',{name:'管理音频',exact:true}).click();await page.locator('#reference-editor').waitFor({state:'visible'});
    await task(page,'asr','ASR One');assert.equal(await page.locator('.result-title>#result-heading').isVisible(),false,'ASR keeps its result heading hidden');
    await task(page,'tts');await pick(page,'tts-two');assert.equal(await page.locator('#result-heading').isVisible(),false,'Returning to TTS hides the output label');assert.equal(await page.locator('.tts-result-section #run-button').count(),1);
  }],
  ['TTS recording enables the expanded upload panel when the temporary reference is ready', async (page, backend) => {
    Object.assign(backend.models.find(item=>item.id==='tts-two'),{voice_mode:'reference',profile:{accepts_voice_reference:true,require_voice:true,send_reference_text:true,send_seed:false,send_max_tokens:false}});
    await pick(page,'tts-two');await referenceMore(page);await page.locator('.reference-automatic input').uncheck();
    await page.evaluate(bytes=>{
      window.stoppedReferenceTracks=0;
      Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>({getTracks:()=>[{stop:()=>window.stoppedReferenceTracks++}]})});
      window.MediaRecorder=class extends EventTarget {
        static isTypeSupported(){return true;}
        constructor(){super();this.state='inactive';this.mimeType='audio/webm';}
        start(){this.state='recording';}
        stop(){this.state='inactive';const event=new Event('dataavailable');event.data=new Blob([new Uint8Array(bytes)],{type:'audio/wav'});this.dispatchEvent(event);this.dispatchEvent(new Event('stop'));}
      };
    },Array.from(wav()));
    const height=()=>page.locator('.reference-sources').evaluate(el=>el.getBoundingClientRect().height),before=await height();
    await page.getByRole('button',{name:'录音',exact:true}).click();
    await page.locator('.reference-upload-actions').getByRole('button',{name:'停止录音',exact:true}).waitFor();
    assert.equal(await page.locator('#run-button').isDisabled(),true);assert.equal(await height(),before);
    assert.equal(await page.locator('#recording-banner').count(),0);
    await page.waitForFunction(()=>parseInt(document.querySelector('.recording-time').textContent)>=1);
    for(const width of [1440,1024,768,390,320]){
      await page.setViewportSize({width,height:1000});
      const controls=await page.locator('.reference-upload-actions').evaluate(el=>{
        const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
        return {row:box(el),items:[...el.querySelectorAll('.recording-start,.recording-time,.recording-stop')].map(box)};
      });
      for(let i=0;i<controls.items.length;i++){
        const item=controls.items[i];assert.ok(item.left>=controls.row.left&&item.right<=controls.row.right+1,`Recording controls overflow at ${width}: ${JSON.stringify(controls)}`);
        if(i)assert.ok(controls.items[i-1].right<=item.left&&Math.abs(controls.items[i-1].top-item.top)<12,`Recording controls must stay inline at ${width}`);
      }
      await assertBrowserScroll(page);await snapshot(page,`recording-inline-${width}`);
    }
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('.reference-upload-actions').getByRole('button',{name:'停止录音',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.reference-upload-fields audio')?.getAttribute('aria-disabled')==='false');
    assert.equal(await page.evaluate(()=>window.stoppedReferenceTracks),1);
    assert.equal(backend.uploads.length,1);assert.ok(backend.uploads[0].name.startsWith('录音-'));
    assert.equal(await page.locator('.recording-time').isVisible(),false);assert.equal(await page.locator('.recording-stop').isVisible(),false);
    assert.equal(await page.locator('.reference-upload-fields audio').isVisible(),true);
    assert.equal(await page.locator('.reference-upload-fields audio').getAttribute('aria-disabled'),'false');
    assert.equal(await page.locator('[data-input-key="reference_text"]').isEnabled(),true);
    assert.equal(await page.locator('[data-input-key="reference_name"]').isEnabled(),true);
    await page.locator('[data-input-key="reference_text"]').fill('录音对应的原文');
    await page.locator('[data-input-key="text"]').fill('使用这段录音合成的新文本');
    await page.locator('.tts-reference-tabs').getByRole('tab',{name:'音频库',exact:true}).click();
    assert.equal(await page.locator('[data-input-key="reference_text"]').inputValue(),'录音对应的原文');
    await page.locator('#run-button').click();await waitText(page,'#job-status','需要参考声音');
    assert.equal(backend.requests.length,0,'An empty active library must not use the hidden recorded reference');
    await page.locator('.tts-reference-tabs').getByRole('tab',{name:'上传 / 录音',exact:true}).click();
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'Recorded reference did not submit');
    assert.equal(backend.requests[0].inputs.voice,'upload-1');assert.equal(backend.requests[0].inputs.reference_text,'录音对应的原文');
    assert.equal(backend.requests[0].inputs.builtin_voice,undefined);
  }],
  ['TTS reference feedback stays beside automatic recognition through stop, success and failure', async (page, backend) => {
    Object.assign(backend.models.find(item=>item.id==='tts-two'),{voice_mode:'reference',profile:{accepts_voice_reference:true,send_reference_text:true}});
    await page.setViewportSize({width:1920,height:1080});await pick(page,'tts-two');
    await upload(page,'#task-form [data-input-key="voice"]','feedback-reference.wav');
    await waitUntil(()=>backend.referenceRequests.length===1,'Automatic reference recognition did not start');
    const uploadPanel=page.locator('.reference-upload-fields'),status='.reference-upload-fields .reference-status';
    const assertFooter=async feedbackSelector=>{
      const layout=await uploadPanel.locator('.reference-upload-footer').evaluate((el,feedbackSelector)=>{
        const box=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width};};
        return {footer:box(el),automatic:box(el.querySelector('.reference-automation')),checkbox:box(el.querySelector('.reference-automatic')),feedback:box(el.querySelector(feedbackSelector)),saveFields:box(el.querySelector('.reference-save-fields')),nameLabel:box(el.querySelector('.reference-save-fields .field-label')),name:box(el.querySelector('[data-input-key="reference_name"]')),save:box(el.querySelector('.reference-save'))};
      },feedbackSelector);
      assert.ok(Math.abs(layout.automatic.width-layout.saveFields.width)<2&&layout.automatic.right<=layout.saveFields.left&&Math.abs((layout.automatic.top+layout.automatic.bottom)-(layout.saveFields.top+layout.saveFields.bottom))<3,`Upload footer must have two equal, vertically centered halves: ${JSON.stringify(layout)}`);
      assert.ok(Math.abs(layout.checkbox.left-layout.automatic.left)<2&&layout.checkbox.right<=layout.feedback.left&&layout.feedback.right<=layout.automatic.right+1&&layout.checkbox.top<layout.feedback.bottom&&layout.feedback.top<layout.checkbox.bottom,'Recognition feedback must stay to the right of the left-aligned automatic checkbox');
      assert.ok(Math.abs(layout.nameLabel.left-layout.saveFields.left)<2&&layout.nameLabel.right<=layout.name.left&&layout.name.right<=layout.save.left&&layout.save.right<=layout.saveFields.right+1,'Name label, input and save action must stay left-aligned in the right half');
    };
    await waitText(page,status,'识别中');await assertFooter('.reference-status');
    await uploadPanel.locator('.reference-stop').click();await waitText(page,status,'正在停止任务');await assertFooter('.reference-status');
    Object.assign(backend.jobs.get('reference-1'),{status:'cancelled',message:'任务已停止。'});backend.status.busy=false;backend.status.job=null;
    await waitText(page,status,'任务已停止');await assertFooter('.reference-status');
    await uploadPanel.getByRole('button',{name:'音频转录',exact:true}).click();
    await waitUntil(()=>backend.referenceRequests.length===2,'Reference recognition retry did not start');
    backend.finish('reference-2','识别成功后的原文',[]);await waitValue(page,'[data-input-key="reference_text"]','识别成功后的原文');
    await uploadPanel.locator('.reference-feedback .upload-controls').waitFor({state:'visible'});
    assert.equal(await page.locator(status).isVisible(),false);await assertFooter('.upload-controls');
    await uploadPanel.getByRole('button',{name:'音频转录',exact:true}).click();
    await waitUntil(()=>backend.referenceRequests.length===3,'Reference recognition failure fixture did not start');
    Object.assign(backend.jobs.get('reference-3'),{status:'error',message:'参考识别失败，请重试。'});backend.status.busy=false;backend.status.job=null;
    await waitText(page,status,'参考识别失败');await assertFooter('.reference-status');
    assert.equal(await page.locator('[data-input-key="reference_text"]').inputValue(),'识别成功后的原文');
    assert.deepEqual(backend.referenceRequests,Array.from({length:3},()=>({audio:'upload-1',source:''})));
  }],
  ['library pages expand long content through the browser', async (page, backend) => {
    const longText=Array.from({length:50},(_,i)=>`第 ${i+1} 行参考音频原文`).join('\n');
    backend.voices.push({name:'long-reference.wav',label:'长参考文本',text:longText,url:`${API}/references/long-reference.wav/audio`});
    backend.models.find(item=>item.id==='tts-one').files=Array.from({length:50},(_,i)=>`model-file-${i}.gguf`);
    for(let i=backend.models.length;i<100;i++)backend.models.push(model(`library-${i}`,`Library model ${i}`,'tts','tts'));
    const expanded=async selector=>{
      const metrics=await page.evaluate(selector=>{const el=document.querySelector(selector);return {height:el.clientHeight,scroll:el.scrollHeight,overflow:getComputedStyle(el).overflowY,maxHeight:getComputedStyle(el).maxHeight};},selector);
      assert.equal(metrics.overflow,'visible',`${selector} creates internal scrolling`);
      assert.ok(metrics.scroll<=metrics.height+1,`${selector} clips content`);
      assert.equal(metrics.maxHeight,'none');
    };
    const visible=async selector=>{
      await page.waitForFunction(selector=>{const rect=document.querySelector(selector)?.getBoundingClientRect();return rect&&rect.top>=-1&&rect.bottom<=innerHeight+1&&rect.height>0;},selector);
    };
    const settleScroll=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:768});
      await page.locator('[data-route="references"]').click();await waitText(page,'.reference-transcript',longText);
      await expanded('.reference-transcript');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollHeight>innerHeight));
      await page.locator('[data-route="models"]').click();
      if(width===1440){await page.locator('#refresh-catalog').click();await page.waitForFunction(()=>document.querySelectorAll('#model-list [data-model]').length===100);}
      await expanded('#model-list');await page.locator('#model-list [data-model="tts-one"]').click();
      await waitText(page,'#model-detail h2','TTS One');
      const summary=page.locator('.details-files summary');
      if(width===1440){
        assert.equal(await page.locator('#model-detail').evaluate(el=>getComputedStyle(el).position),'sticky','A short desktop model card keeps following the catalog');
        assert.ok(await page.locator('#model-detail').evaluate(el=>el.getBoundingClientRect().height<innerHeight),'The collapsed card must fit the viewport');
        await page.evaluate(()=>window.scrollTo(0,1200));await settleScroll();
        assert.ok(await page.evaluate(()=>scrollY>=1200),'The long catalog must allow scrolling before expansion');
      }else await summary.scrollIntoViewIfNeeded();
      await visible('.details-files summary');await summary.click();
      await page.waitForFunction(()=>getComputedStyle(document.querySelector('#model-detail')).position!=='sticky');
      await visible('.details-files summary');
      await expanded('#model-detail');await expanded('.details-files ul');
      assert.ok(await page.locator('#model-detail').evaluate(el=>el.getBoundingClientRect().height>innerHeight),'Expanded model files must exceed the viewport');
      if(process.env.AUDIOCPP_BROWSER_SCREENSHOTS){
        await fs.mkdir(process.env.AUDIOCPP_BROWSER_SCREENSHOTS,{recursive:true});
        await page.screenshot({path:path.join(process.env.AUDIOCPP_BROWSER_SCREENSHOTS,`model-files-expanded-${width}.png`)});
      }
      const before=await page.locator('#model-detail').evaluate(el=>({top:el.getBoundingClientRect().top,scroll:scrollY}));
      await page.evaluate(()=>window.scrollBy(0,240));await settleScroll();
      const after=await page.locator('#model-detail').evaluate(el=>({top:el.getBoundingClientRect().top,scroll:scrollY}));
      assert.ok(after.scroll>before.scroll,'The browser must scroll the expanded model card');
      assert.ok(Math.abs((before.top-after.top)-(after.scroll-before.scroll))<2,'The long model card must move with browser scrolling');
      await page.locator('.details-files li').last().scrollIntoViewIfNeeded();
      await visible('.details-files li:last-child');
      await summary.scrollIntoViewIfNeeded();await visible('.details-files summary');
      assert.ok(await page.evaluate(()=>scrollY>0),'Collapse must also be exercised after scrolling');
      await summary.click();await visible('.details-files summary');
      await page.waitForFunction(desktop=>getComputedStyle(document.querySelector('#model-detail')).position===(desktop?'sticky':'static'),width===1440);
      if(width===1440){
        await summary.click();await page.waitForFunction(()=>getComputedStyle(document.querySelector('#model-detail')).position!=='sticky');
        await visible('.details-files summary');
        await page.setViewportSize({width:390,height:768});
        await page.waitForFunction(()=>{const panel=document.querySelector('#model-detail');return getComputedStyle(panel).position==='static'&&getComputedStyle(panel).marginTop==='0px';});
        await page.locator('.details-files li').last().scrollIntoViewIfNeeded();await visible('.details-files li:last-child');
        await page.setViewportSize({width:1440,height:768});
        await page.waitForFunction(()=>getComputedStyle(document.querySelector('#model-detail')).position!=='sticky');
        await page.locator('.details-files li').last().scrollIntoViewIfNeeded();await visible('.details-files li:last-child');
        await page.locator('#model-list [data-model="tts-two"]').click();await waitText(page,'#model-detail h2','TTS Two');
        await page.waitForFunction(()=>{const panel=document.querySelector('#model-detail');return getComputedStyle(panel).position==='sticky'&&getComputedStyle(panel).marginTop==='0px';});
        await visible('#model-detail h2');
      }
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    }
  }],
  ['library model paths distinguish download storage from manual import', async (page, backend) => {
    backend.models.find(item=>item.id==='tts-one').install_path='models/tts-one';
    Object.assign(backend.models.find(item=>item.id==='tts-two'),{installed:false,installable:true,install_path:'models/tts-two'});
    Object.assign(backend.models.find(item=>item.id==='tts-missing'),{install_path:'models/manual-tts',manual_install:true,installable:false});
    await page.locator('[data-route="models"]').click();
    await page.locator('#model-list [data-model="tts-one"]').click();await waitText(page,'#model-detail h2','TTS One');
    assert.equal(await page.locator('#model-detail .install-path .field-label').textContent(),'模型下载保存位置');
    assert.equal(await page.locator('#model-detail .install-path code').textContent(),'models/tts-one');
    await page.locator('#model-list [data-model="tts-two"]').click();await waitText(page,'#model-detail h2','TTS Two');
    assert.equal(await page.locator('#model-detail .install-path .field-label').textContent(),'模型下载保存位置');
    assert.equal(await page.locator('#model-detail .install-path code').textContent(),'models/tts-two');
    assert.equal(await page.locator('#model-detail').getByRole('button',{name:'下载模型',exact:true}).isVisible(),true);
    await page.locator('#model-list [data-model="tts-missing"]').click();await waitText(page,'#model-detail h2','TTS Not Installed');
    assert.equal(await page.locator('#model-detail .install-path .field-label').textContent(),'权重导入目录');
    assert.equal(await page.locator('#model-detail .install-path code').textContent(),'models/manual-tts');
  }],
  ['unloaded five primary pages support preparation and regular-window layouts', async (page, backend) => {
    await page.setViewportSize({width:1366,height:768});
    const entries=[['tts','tts-one','TTS One'],['asr','asr-one','ASR One'],['music','music-one','Music One'],['design','voice-design','Voice design'],['vc','voice-convert','Voice conversion']];
    for(const [route,id,label] of entries){
      await task(page,route);
      assert.equal(await page.locator('#workspace-grid').isVisible(),true,`${route}: unloaded workspace hidden`);
      assert.equal(await page.locator('#run-button').isDisabled(),true);
      await page.locator('#task-form').evaluate(form=>form.requestSubmit());
      assert.equal(backend.requests.length,0,'Submitting the preparation form bypassed explicit model loading');
      if(['tts','music','design'].includes(route))await page.locator('[data-input-key="text"]').fill(`${route} preparation before load`);
      if(route==='design')await page.locator('[data-input-key="instruct"]').fill('温暖、清晰的年轻女声');
      if(['asr','vc'].includes(route))await upload(page,'#task-form [data-input-key="audio"]',`${route}-source.wav`);
      assert.equal(await page.locator('#job-status').isVisible(),false,`${route}: idle status must stay silent`);
      assert.equal(await page.locator('#run-hint').isVisible(),false,`${route}: repeated operating instructions remain`);
      assert.equal(await page.locator('#task-form .upload-clear,.required').count(),0);
      assert.equal(await page.locator('#result-content').textContent(),'');
      await snapshot(page,`regular-${route}-unselected`);
      await page.locator('#model-picker-trigger').click();await page.locator(`[data-model-select="${id}"]`).click();
      await waitText(page,'#model-picker-label',label);await page.keyboard.press('Escape');
      await page.locator('#parameter-toggle').waitFor({state:'visible'});
      assert.equal(backend.loads.length,0,'Metadata selection loaded a model');
      assert.equal(await page.locator('#run-button').isDisabled(),true);
      if(['tts','music','design'].includes(route))await waitValue(page,'[data-input-key="text"]',`${route} preparation before load`);
      const geometry=await page.locator('#page-workspace').evaluate(el=>{
        const input=el.querySelector(el.dataset.task==='tts'?'.task-primary':'.input-card').getBoundingClientRect(),run=el.querySelector('#run-button').getBoundingClientRect(),result=el.querySelector('.result-card').getBoundingClientRect();
        const main=el.closest('.main-content').getBoundingClientRect(),grid=el.querySelector('#workspace-grid').getBoundingClientRect();
        return {page:document.documentElement.scrollHeight,viewport:innerHeight,inputHeight:input.height,runBottom:run.bottom,resultHeight:result.height,leftGap:grid.left-main.left,rightGap:main.right-grid.right};
      });
      assert.ok(Math.abs(geometry.leftGap-geometry.rightGap)<1,`${route}: desktop operation margins differ ${JSON.stringify(geometry)}`);
      await assertBrowserScroll(page);
      assert.equal(await page.locator('.input-card>.card-heading').isVisible(),false,`${route}: redundant input heading remains`);
      if(['tts','design','vc'].includes(route)){
        assert.ok(await page.locator('.task-primary').evaluate(el=>{
          const text=el.getBoundingClientRect(),run=document.querySelector('#run-button').getBoundingClientRect(),settings=document.querySelector('#common-options').getBoundingClientRect();
          const style=getComputedStyle(document.querySelector('#common-options')),contentLeft=settings.left+parseFloat(style.paddingLeft)+parseFloat(style.borderLeftWidth);
          const side=document.querySelector('.tts-side-column').getBoundingClientRect(),hasSettings=!document.querySelector('#common-options').hidden;
          return document.querySelector('.tts-result-section').contains(document.querySelector('#run-button'))&&text.right<side.left&&(!hasSettings||settings.bottom<run.top&&Math.abs(contentLeft-run.left)<2);
        }),`${route}: execution stays below right-column settings`);
      }else if(route==='music'){
        assert.ok(await page.locator('.task-primary').evaluate(el=>Math.abs(el.getBoundingClientRect().width-el.closest('.music-controls-column').getBoundingClientRect().width)<2),'Music preparation input fills the controls column');
      }else assert.ok(await page.locator('.task-primary').evaluate(el=>Math.abs(el.getBoundingClientRect().width-document.querySelector('#task-inputs').getBoundingClientRect().width)<2),`${route}: primary input must fill a row`);
      assert.equal(await page.locator(['tts','vc'].includes(route)?'.reference-more':'.reference-source-tabs,.reference-more').count(),0,`${route}: old reference tabs remain`);
      if(['tts','design','vc','asr'].includes(route))assert.equal(await page.locator('.result-card').isVisible(),false,`${route}: empty results should stay hidden`);
      else assert.ok(await page.locator('.result-card').evaluate(el=>el.getBoundingClientRect().top-document.querySelector('.input-card').getBoundingClientRect().bottom<20),`${route}: unnecessary gap before results`);
      assert.ok(geometry.inputHeight>100,`${route}: input collapsed ${JSON.stringify(geometry)}`);
      if(route==='asr')assert.equal(geometry.resultHeight,0,'ASR must not reserve space for empty results');
      else if(['tts','design','vc'].includes(route))assert.equal(geometry.resultHeight,0,`${route}: hides the result group before generation`);
      else if(route==='music')assert.equal(geometry.resultHeight,0,'Music hides the empty result card');
      else assert.ok(geometry.resultHeight>=140,`${route}: empty result card must reserve output space ${JSON.stringify(geometry)}`);
      await assertVisibleControl(page,'#run-button',`${route}: execution button is clipped by an ancestor`);
      assert.ok(await page.locator('.workspace-operation').evaluate(el=>el.getBoundingClientRect().width>=document.querySelector('#page-workspace').getBoundingClientRect().width*.9),`${route}: main card does not fill the workspace`);
      await snapshot(page,`regular-${route}-prepared`);
      await page.setViewportSize({width:390,height:844});await assertBrowserScroll(page);
      assert.ok(await page.locator('#workspace-grid').evaluate(el=>{const main=document.querySelector('.main-content').getBoundingClientRect(),grid=el.getBoundingClientRect();return Math.abs((grid.left-main.left)-(main.right-grid.right))<1;}),`${route}: narrow-screen operation margins differ`);
      await assertVisibleControl(page,'#run-button',`${route}: narrow-screen execution button clipped`);
      await page.evaluate(()=>window.scrollTo(0,0));await snapshot(page,`compact-${route}-mobile`);
      await page.setViewportSize({width:1366,height:768});
    }
  }],
  ['result header preserves real task stages and cancellation with an initially hidden output card', async (page, backend) => {
    await page.setViewportSize({width:1366,height:768});await task(page,'tts','TTS One');
    await page.locator('[data-input-key="text"]').fill('第一段是开场白。第二段介绍产品。第三段是结束语。');
    assert.equal(await page.locator('.result-card').isVisible(),false);
    assert.equal(await page.locator('#job-status').isVisible(),false);await snapshot(page,'tts-result-idle');
    backend.submitGate=deferred();await page.locator('#run-button').click();
    await waitText(page,'#job-status','正在准备任务');assert.equal(await page.locator('#cancel-job').isVisible(),false);
    const blank=await page.locator('.result-card').evaluate(el=>({height:el.getBoundingClientRect().height,background:getComputedStyle(el).backgroundColor,gap:el.getBoundingClientRect().top-document.querySelector('#run-button').getBoundingClientRect().bottom}));
    assert.ok(blank.height>=180&&blank.height<=200);assert.notEqual(blank.background,'rgba(0, 0, 0, 0)');assert.equal(blank.gap,26);
    backend.submitGate.resolve();backend.submitGate=null;
    await page.locator('#cancel-job').waitFor({state:'visible'});
    for(const message of ['正在准备模型…','声音合成中…','声音合成中… 第 2/3 段 · 已完成 1 段']){
      backend.jobs.get('job-1').message='ℹ️ '+message;await waitText(page,'#job-status',message);
      assert.equal(await page.locator('#job-status').textContent(),message);
    }
    assert.equal(await page.locator('#job-status').getAttribute('data-state'),'running');
    assert.equal(await page.locator('#job-status').evaluate(el=>getComputedStyle(el,'::before').content),'none');
    assert.ok(await page.locator('#job-status').evaluate(el=>{const run=document.querySelector('#run-button').getBoundingClientRect(),card=el.closest('.result-card').getBoundingClientRect(),status=el.getBoundingClientRect(),stop=document.querySelector('#cancel-job').getBoundingClientRect();return run.bottom<=card.top&&status.right<=stop.left&&status.top<stop.bottom&&stop.top<status.bottom;}),'Task status and stop must remain together inside the card below the generate button');
    assert.equal(await page.locator('.result-card').evaluate(el=>el.getBoundingClientRect().height),blank.height);
    await assertBrowserScroll(page);await snapshot(page,'tts-result-progress');
    await assertVisibleControl(page,'#cancel-job','Stop action clipped in the desktop result header');
    await page.locator('#cancel-job').click();assert.equal(await page.locator('#cancel-job').isDisabled(),true);
    await waitText(page,'#job-status','正在停止任务');
    Object.assign(backend.jobs.get('job-1'),{status:'cancelled',message:'任务已停止。'});backend.status.busy=false;backend.status.job=null;
    await waitText(page,'#job-status','任务已停止。');assert.equal(await page.locator('#cancel-job').isVisible(),false);
    assert.equal(await page.locator('#result-content').innerText(),'');
    await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===2,'Retry did not submit');
    Object.assign(backend.jobs.get('job-2'),{status:'error',message:'❌ 显存不足，请缩短文本或调整模型设置。'});backend.status.busy=false;backend.status.job=null;
    await waitText(page,'#job-status','显存不足');assert.equal(await page.locator('#job-status').getAttribute('data-state'),'error');
    assert.equal(await page.locator('#job-status').textContent(),'显存不足，请缩短文本或调整模型设置。');
    assert.equal(await page.locator('#cancel-job').isVisible(),false);
    await snapshot(page,'tts-result-error');
  }],
  ['ASR long output uses bounded editing with inline copy and file downloads', async (page, backend) => {
    backend.models.find(item=>item.id==='asr-one').streaming=true;
    await page.setViewportSize({width:1366,height:768});await task(page,'asr','ASR One');
    await upload(page,'#task-form [data-input-key="audio"]','long-recording.wav');
    await page.locator('[data-input-key="detailed"]').check();await page.locator('[data-input-key="dialogue"]').check();
    assert.equal(await page.locator('[data-input-key="detailed"]').isChecked(),false);
    await page.locator('[data-input-key="stream"]').check();
    assert.equal(await page.locator('[data-input-key="dialogue"]').isChecked(),false);
    await page.locator('[data-input-key="stream"]').uncheck();
    for(const selector of ['[data-input-key="language"]','[data-input-key="context"]','[data-input-key="detailed"]','[data-input-key="dialogue"]','[data-input-key="stream"]'])await assertVisibleControl(page,selector,'ASR common option clipped');
    assert.equal(await page.locator('.result-card').isVisible(),false);
    assert.equal(await page.locator('#result-heading').isVisible(),false);
    assert.equal(await page.locator('#run-button').evaluate(el=>el.form.id),'task-form');
    assert.ok(await page.locator('#run-button').evaluate(el=>{
      const input=document.querySelector('.input-card').getBoundingClientRect(),result=document.querySelector('.result-card').getBoundingClientRect(),run=el.getBoundingClientRect(),options=document.querySelector('#common-options').getBoundingClientRect();
      return !!el.closest('#task-form')&&run.top>options.bottom&&Math.abs(run.right-input.right)<2&&getComputedStyle(el.closest('.generate-row')).borderTopWidth==='1px';
    }),'ASR execution is right aligned below a divider in the input column');
    assert.equal(await page.locator('#result-content textarea').inputValue(),'');
    assert.equal(await page.locator('#copy-result').isVisible(),false);
    assert.equal(await page.locator('#task-inputs .task-primary>.field-group>.field-label').textContent(),'转录文件');
    assert.equal(await page.locator('#common-options-heading').textContent(),'识别选项');
    assert.equal(await page.locator('#common-options-heading').isVisible(),true);
    const contextGeometry=await page.locator('[data-input-key="context"]').evaluate(el=>{
      const field=el.closest('.field-group'),input=el.getBoundingClientRect(),label=field.querySelector('.field-label').getBoundingClientRect(),options=document.querySelector('#common-options').getBoundingClientRect();
      return {right:Math.abs(input.right-options.right)<2,sameRow:input.top<label.bottom&&input.bottom>label.top};
    });
    assert.deepEqual(contextGeometry,{right:true,sameRow:true});
    await snapshot(page,'asr-empty-result-inline-context');
    const heights=[];let runningHeight;
    for(const lines of [12,2000]){
      await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===heights.length+1,'ASR did not submit');
      await page.locator('.result-card').waitFor({state:'visible'});
      runningHeight=await page.locator('#result-content textarea').evaluate(el=>el.getBoundingClientRect().height);
      assert.equal(await page.locator('#result-heading').isVisible(),true);
      assert.ok(await page.locator('#run-button').evaluate(el=>el.getBoundingClientRect().right<document.querySelector('.result-card').getBoundingClientRect().left),'Recognition button should stay in the left column');
      const text=Array.from({length:lines},(_,index)=>`${index+1} 这是完整的识别文字，包含专业术语、标点和长音频内容。`).join('\n');
      backend.finish(`job-${heights.length+1}`,text,['transcript_1c3fcd145f884be4820ebd24d43f4dbe.txt','segments.json']);backend.jobs.get(`job-${heights.length+1}`).message='流式转写完成（音频 150.2s），用时 12.8s，首字 2.9s，含模型加载 2.1s。';await waitValue(page,'#result-content textarea.result-text',text);
      await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
      assert.equal(await page.locator('#result-downloads a[download]').count(),0);
      assert.equal(await page.locator('#export-result').isVisible(),true,'ASR provides a text download button');
      assert.equal(await page.locator('#result-content .artifact a').count(),0,'ASR downloads should appear only in the result header');
      assert.equal(await page.locator('#copy-result').textContent(),'复制文本');
      assert.equal(await page.locator('#copy-result').evaluate(el=>el.previousElementSibling.id==='job-status'&&el.previousElementSibling.previousElementSibling.id==='result-heading'&&el.nextElementSibling.id==='export-result'),true,'Header order');
      const header=await page.locator('#job-status').evaluate(el=>{
        const status=el.getBoundingClientRect(),copy=document.querySelector('#copy-result').getBoundingClientRect();
        const title=document.querySelector('#result-heading'),upload=document.querySelector('#task-inputs .task-primary>.field-group>.field-label'),heading=getComputedStyle(title),label=getComputedStyle(upload);
        return {inline:copy.left>=status.right&&copy.top<status.bottom,font:heading.fontSize===label.fontSize&&heading.fontWeight===label.fontWeight,aligned:Math.abs(title.getBoundingClientRect().top-upload.getBoundingClientRect().top)<1&&Math.abs(title.getBoundingClientRect().height-upload.getBoundingClientRect().height)<1};
      });
      assert.deepEqual(header,{inline:true,font:true,aligned:true});
      assert.equal(await page.locator('#job-status').textContent(),'音频 150.2s，用时 12.8 s，首字 2.9s');
      const event=page.waitForEvent('download');await page.locator('#export-result').click();const download=await event;
      assert.equal(await fs.readFile(await download.path(),'utf8'),text);
      const geometry=await page.locator('#result-content textarea').evaluate(el=>{
        const box=el.getBoundingClientRect(),copy=document.querySelector('#copy-result').getBoundingClientRect(),run=document.querySelector('#run-button').getBoundingClientRect();
        return {height:box.height,top:box.top,bottom:box.bottom,scroll:el.scrollHeight,client:el.clientHeight,page:document.documentElement.scrollHeight,viewport:innerHeight,copyBottom:copy.bottom,runBottom:run.bottom};
      });
      await assertBrowserScroll(page);
      assert.ok(geometry.height>160,`ASR editor collapsed ${JSON.stringify(geometry)}`);
      if(lines===2000)assert.ok(geometry.scroll>geometry.client,'Long transcript must scroll internally');
      await assertVisibleControl(page,'#run-button','ASR execute button clipped');
      await assertVisibleControl(page,'#copy-result','ASR copy button clipped');
      assert.ok(await page.locator('#result-content textarea').evaluate(el=>el.getBoundingClientRect().width>=document.querySelector('.result-card').getBoundingClientRect().width*.9),'ASR transcript does not use the result width');
      heights.push(geometry.height);await snapshot(page,`regular-asr-${lines===12?'one-minute':'long-output'}`);
    }
    assert.equal(heights[0],heights[1],'Transcript length changed the result panel height');
    assert.equal(heights[0],runningHeight,'Running and completed transcript editors must have the same initial height');
    for(const height of [1100,400]){
      await page.setViewportSize({width:1366,height});
      const resized=await page.locator('#result-content textarea').evaluate(el=>{const box=el.getBoundingClientRect();return {height:box.height,bottom:box.bottom+scrollY,minimum:parseFloat(getComputedStyle(el).minHeight)};});
      assert.ok(resized.height>=resized.minimum,'Keep the previous default height as the minimum');
      if(height===1100){assert.ok(resized.height>heights[0],'A taller browser expands the result editor');assert.ok(Math.abs(height-resized.bottom-38)<2,'Result editor fills the page with the existing bottom padding');}
      else assert.ok(Math.abs(resized.height-resized.minimum)<2,'Short windows retain the minimum height');
      await snapshot(page,`asr-viewport-${height}`);
    }
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Narrow ASR layout must wrap without horizontal overflow');
    assert.ok(await page.locator('.result-card').evaluate(el=>el.getBoundingClientRect().top>=document.querySelector('.input-card').getBoundingClientRect().bottom),'Narrow ASR results follow the input column');
    await snapshot(page,'asr-narrow-result-downloads');
    await page.setViewportSize({width:1366,height:768});
    await task(page,'tts');assert.equal(await page.locator('#result-downloads').isVisible(),false);
    await task(page,'asr');assert.equal(await page.locator('#result-downloads a[download]').count(),0);
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===3,'ASR partial result did not submit');
    backend.jobs.get('job-3').text='流式识别文字';await waitValue(page,'#result-content textarea','流式识别文字');
    assert.equal(await page.locator('#result-content textarea').evaluate(el=>el.readOnly),true);
    backend.finish('job-3','流式识别文字',[]);await waitText(page,'#job-status','处理完成');
    assert.equal(await page.locator('#result-downloads').isVisible(),false,'New results must clear old download links');
    assert.equal(await page.locator('#result-content textarea').evaluate(el=>el.readOnly),false,'Unchanged final transcript must become editable');
    const corrected='用户校正的最终文字';await page.locator('#result-content textarea.result-text').fill(corrected);
    await page.evaluate(()=>{
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.fixtureClipboard=text;}}});
    });
    await page.locator('#copy-result').click();assert.equal(await page.evaluate(()=>window.fixtureClipboard),corrected);
    assert.equal(await page.locator('#export-result').isVisible(),true);
    await task(page,'tts');assert.equal(await page.locator('.task-action-bar #run-button').count(),1,'Other tasks must retain their action row');
    assert.equal(await page.locator('.result-actions>#copy-result').count(),1,'Other tasks must retain their copy action placement');
    await task(page,'asr');await waitValue(page,'#result-content textarea.result-text',corrected);
    assert.equal(await page.locator('.result-card').isVisible(),true,'Returning to ASR should retain its existing result');
  }],
  ['ASR dependency controls omit inactive hotwords and explain unavailable diarization', async (page, backend) => {
    Object.assign(backend.models.find(item=>item.id==='asr-one'),{family:'kroko_asr',languages:[],streaming:true,
      asr_inputs:{context:false,details:true,dialogue:true,dialogue_available:false},parameters:[
        {name:'decoding_method',label:'解码方式',type:'choice',choices:['greedy_search','modified_beam_search'],default:'greedy_search',scope:'request',level:'basic'},
        {name:'hotwords',label:'热词',type:'text',lines:2,default:'',scope:'request',level:'basic',requires:{decoding_method:['modified_beam_search']}},
        {name:'hotwords_score',label:'热词权重',type:'float',default:1.5,scope:'request',level:'expert',requires:{decoding_method:['modified_beam_search']}},
        {name:'enable_endpoint',label:'端点检测',type:'bool',default:false,scope:'request',level:'basic'},
        {name:'rule1_min_trailing_silence_sec',label:'静音阈值',type:'float',default:2.4,scope:'request',level:'expert',requires:{enable_endpoint:[true]}},
      ]});
    await task(page,'asr','ASR One');
    assert.equal(await page.locator('[data-input-key="language"]').count(),0);
    assert.equal(await page.locator('[data-input-key="dialogue"]').isDisabled(),true);
    assert.equal(await page.locator('#param-hotwords,#param-hotwords_score,#param-rule1_min_trailing_silence_sec').count(),0);
    await page.locator('#param-decoding_method').selectOption('modified_beam_search');
    await page.locator('#param-hotwords').fill('品牌名称\n专业术语');
    await page.locator('#param-enable_endpoint').check();await advanced(page);
    await page.locator('#param-hotwords_score').fill('2');await page.locator('#param-rule1_min_trailing_silence_sec').fill('3');await page.keyboard.press('Escape');
    await upload(page,'#task-form [data-input-key="audio"]','hotwords.wav');await page.locator('#run-button').click();
    await waitUntil(()=>backend.requests.length===1,'Hotword request missing');
    assert.equal(backend.requests[0].options.hotwords,'品牌名称\n专业术语');assert.equal(backend.requests[0].options.hotwords_score,2);
    assert.equal(backend.requests[0].inputs.dialogue,false);
    backend.finish('job-1','热词识别',[]);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
    await page.locator('#param-decoding_method').selectOption('greedy_search');await page.locator('#param-enable_endpoint').uncheck();
    assert.equal(await page.locator('#param-hotwords,#param-hotwords_score,#param-rule1_min_trailing_silence_sec').count(),0);
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===2,'Greedy request missing');
    for(const key of ['hotwords','hotwords_score','rule1_min_trailing_silence_sec'])assert.equal(backend.requests[1].options[key],undefined,`Inactive ${key} leaked`);
    backend.finish('job-2','普通识别',[]);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
    await page.locator('#param-decoding_method').selectOption('modified_beam_search');
    assert.equal(await page.locator('#param-hotwords').inputValue(),'品牌名称\n专业术语','Temporarily hidden settings should retain their draft');
  }],
  ['ASR language defaults timestamps and detailed downloads follow the selected mode', async (page, backend) => {
    Object.assign(backend.models.find(item=>item.id==='asr-one'),{family:'owsm',languages:['eng','zho'],streaming:true,
      asr_inputs:{details:true,language_default:'eng',language_auto:'auto'},parameters:[
        {name:'language',label:'语言',type:'text',default:'eng',scope:'request',level:'basic'},
        {name:'target_language',label:'目标语言',type:'choice',choices:[['不翻译',''],'eng','zho'],scope:'request',level:'basic'},
        {name:'return_timestamps',label:'时间戳',type:'bool',default:false,scope:'request',level:'basic',modes:['offline']},
      ]});
    await task(page,'asr','ASR One');
    assert.match(await page.locator('[data-input-key="language"] option:checked').textContent(),/^模型默认/);
    assert.equal(await page.locator('[data-input-key="language"] option[value="auto"]').textContent(),'自动识别');
    assert.equal(await page.locator('#param-target_language option[value=""]').count(),1);
    assert.equal(await page.locator('#param-target_language option:checked').textContent(),'不翻译');
    await page.locator('[data-input-key="language"]').selectOption('auto');await page.locator('#param-return_timestamps').check();
    assert.equal(await page.locator('[data-input-key="detailed"]').isChecked(),true);
    await upload(page,'#task-form [data-input-key="audio"]','timestamps.wav');await page.locator('#run-button').click();
    await waitUntil(()=>backend.requests.length===1,'Timestamp request missing');
    assert.equal(backend.requests[0].inputs.language,'auto');assert.equal(backend.requests[0].inputs.detailed,true);assert.equal(backend.requests[0].options.return_timestamps,true);
    await page.route(`${ORIGIN}${API}/files/job-1-0`,route=>route.fulfill({status:200,contentType:'application/json',body:'{"words":[{"word":"你好","start":0,"end":1}]}'}));
    backend.finish('job-1','你好',['details.json']);await page.getByRole('button',{name:'下载详情',exact:true}).waitFor();
    const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'下载详情',exact:true}).click();
    const download=await downloaded;assert.equal(download.suggestedFilename(),'details.json');
    assert.equal(JSON.parse(await fs.readFile(await download.path(),'utf8')).words[0].word,'你好');
    await page.locator('[data-input-key="stream"]').check();assert.equal(await page.locator('#param-return_timestamps').count(),0);
    assert.equal(await page.locator('[data-input-key="detailed"]').isChecked(),false);
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===2,'Streaming request missing');
    assert.equal(backend.requests[1].inputs.stream,true);assert.equal(backend.requests[1].inputs.detailed,false);assert.equal(backend.requests[1].options.return_timestamps,undefined);
    backend.finish('job-2','流式结果',[]);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
    await page.locator('[data-input-key="stream"]').uncheck();
    assert.equal(await page.locator('#param-return_timestamps').isChecked(),true);assert.equal(await page.locator('[data-input-key="detailed"]').isChecked(),true);
    await advanced(page);await page.locator('#options-json').fill('{"return_timestamps":true}');await page.keyboard.press('Escape');
    await page.locator('[data-input-key="detailed"]').uncheck();
    assert.equal(await page.locator('#param-return_timestamps').isChecked(),false);
    assert.equal(JSON.parse(await page.locator('#options-json').inputValue()).return_timestamps,false,'UI changes must update an existing JSON override');
  }],
  ['ASR aligner selection uses catalog paths and settings stay readable on desktop and mobile', async (page, backend) => {
    const alignerPath='D:/audio/models/Qwen3-ForcedAligner-0.6B/model.gguf';
    const aligner={id:'qwen3-forced-aligner',label:'Qwen3 Forced Aligner',value:alignerPath,install_path:'D:/audio/models/Qwen3-ForcedAligner-0.6B',installed:false};
    backend.models.push(model(aligner.id,aligner.label,'analysis','align',{family:'qwen3_forced_aligner',installed:false}));
    Object.assign(backend.models.find(item=>item.id==='asr-one'),{family:'qwen3_asr',languages:['zh','en'],
      asr_inputs:{context:true,details:true,language_auto:'auto',language_default:'auto'},parameters:[
        {name:'return_timestamps',label:'时间戳',type:'bool',default:false,scope:'request',level:'expert',modes:['offline']},
        {name:'audio_chunk_duration_sec',label:'分块时长（秒）',type:'float',default:30,min:1,max:120,scope:'request',level:'expert'},
        {name:'audio_chunk_mode',label:'音频分块方式',type:'choice',choices:['none','vad'],default:'vad',scope:'request',level:'expert'},
        {name:'session_options.qwen3_asr.forced_aligner_path',label:'强制对齐模型',type:'model',model_choices:[aligner],default:'',wide:true,scope:'session',level:'expert'},
        {name:'load_options.threads',label:'推理线程数',type:'int',default:4,min:1,max:16,scope:'load',level:'expert'},
      ]});
    await page.reload();await task(page,'asr','ASR One');await upload(page,'#task-form [data-input-key="audio"]','aligner.wav');
    assert.equal(await page.locator('#common-options #param-return_timestamps').count(),0);
    await advanced(page);assert.equal(await page.locator('#workspace-settings #param-return_timestamps').count(),1);
    await page.locator('#param-return_timestamps').check();
    assert.equal(await page.locator('#apply-model-settings').isDisabled(),true,'Timestamps alone are a request option; selecting the aligner is what requires reload');
    await page.locator('#finish-model-settings').click();await page.locator('#run-button').click();
    await waitText(page,'#asr-notice','时间戳需要强制对齐模型');assert.equal(backend.requests.length,0);
    assert.equal(await page.locator('.result-card').isVisible(),false,'Validation reminders must not reveal an empty transcript');
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:1000});
      const notice=await page.locator('#asr-notice').evaluate(el=>{
        const box=el.getBoundingClientRect(),run=document.querySelector('#run-button').getBoundingClientRect(),form=document.querySelector('#task-form').getBoundingClientRect();
        return {below:box.top>=run.bottom,left:Math.abs(box.left-form.left)<1,full:Math.abs(box.width-form.width)<1,align:getComputedStyle(el).textAlign,overflow:el.scrollWidth>el.clientWidth+1};
      });
      assert.deepEqual(notice,{below:true,left:true,full:true,align:'left',overflow:false});await snapshot(page,`asr-notice-${width}`);
    }
    await task(page,'tts');assert.equal(await page.locator('#asr-notice').isVisible(),false);
    await task(page,'asr');await waitText(page,'#asr-notice','时间戳需要强制对齐模型');
    await advanced(page);const pathSelector='#param-session_options-qwen3_asr-forced_aligner_path';
    assert.equal(await page.locator(pathSelector).evaluate(el=>el.tagName),'SELECT');
    assert.equal(await page.locator(`${pathSelector} option`).count(),2);
    assert.equal(await page.locator(`${pathSelector} option`).nth(1).isDisabled(),true);
    assert.match(await page.locator('.model-choice-path').textContent(),/尚未安装兼容模型/);
    const loads=backend.loads.length;
    await page.locator('.model-choice-link').click();await waitText(page,'#model-detail',aligner.label);
    assert.equal(await page.locator('#page-models').isVisible(),true);
    assert.equal(await page.locator('#model-list .model-row').count(),1);
    assert.equal(backend.loads.length,loads,'Viewing the card must not load a model');
    // Simulate a completed model-center installation, then return to ASR.
    aligner.installed=true;backend.models.find(m=>m.id===aligner.id).installed=true;
    await task(page,'asr');await advanced(page);
    assert.equal(await page.locator(`${pathSelector} option`).nth(1).isDisabled(),false);
    // Previously entered nested JSON remains visible, and selecting None clears it.
    await page.locator('#options-json').fill(JSON.stringify({session_options:{'qwen3_asr.forced_aligner_path':'E:/custom/aligner.gguf'}}));
    assert.equal(await page.locator(pathSelector).inputValue(),'E:/custom/aligner.gguf');
    await page.locator(pathSelector).selectOption('');
    assert.equal(JSON.parse(await page.locator('#options-json').inputValue()).session_options['qwen3_asr.forced_aligner_path'],undefined);
    await page.locator(pathSelector).selectOption(alignerPath);
    assert.match(await page.locator('.model-choice-path').textContent(),/D:\/audio\/models/);
    assert.equal(await page.locator('#run-button').isDisabled(),true,'A changed aligner requires explicit reload');
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:1000});
      const layout=await page.locator('#expert-controls').evaluate(el=>{
        const scalar=el.querySelector('#param-audio_chunk_duration_sec').getBoundingClientRect(),path=el.querySelector('.wide-parameter select').getBoundingClientRect(),box=el.getBoundingClientRect();
        const fields=[...el.querySelectorAll('input,select')].map(input=>({width:input.getBoundingClientRect().width,group:input.closest('.field-group').getBoundingClientRect().width}));
        return {scalar:scalar.width,path:path.width,box:box.width,columns:getComputedStyle(el).gridTemplateColumns.split(' ').length,fields};
      });
      assert.equal(layout.columns,width>600?2:1);assert.ok(layout.path>layout.scalar*1.5);
      assert.ok(layout.fields.every(field=>field.width<=field.group+1),'Control overflows its field');
      assert.equal(await page.locator('#expert-controls .parameter-section-title').count(),2);
      await waitText(page,'#expert-controls','加载与内存');
      await page.locator('#apply-model-settings').click({trial:true});
      await assertVisibleControl(page,'#apply-model-settings','ASR apply footer clipped');await assertBrowserScroll(page);await snapshot(page,`asr-settings-${width}`);
    }
    await page.locator('#apply-model-settings').click();await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'Aligned request missing after explicit model reload');
    assert.equal(await page.locator('#asr-notice').isVisible(),false,'Starting recognition clears the reminder');
    assert.equal(backend.requests[0].options['session_options.qwen3_asr.forced_aligner_path'],alignerPath);
    assert.equal(backend.loads.at(-1).options['session_options.qwen3_asr.forced_aligner_path'],alignerPath);
  }],
  ['ASR selects the resident model without loading and keeps runtime settings separate', async (page, backend) => {
    backend.models.push(model('qwen3-asr','Qwen3-ASR 0.6B','asr','asr',{family:'qwen3_asr',parameters:[
      {name:'load_options.threads',label:'推理线程',type:'int',default:4,min:1,max:16,level:'expert',scope:'load'}]}));
    backend.status.asr={model:'qwen3-asr',managed:true,configuration:{managed:true,load_options:{},session_options:{},mode:'offline'}};
    await task(page,'tts','TTS One');
    const loads=backend.loads.length;
    await page.reload();await task(page,'asr');
    await page.locator('#model-picker-trigger').click();await page.locator('[data-model-select="qwen3-asr"]').click();await page.keyboard.press('Escape');
    await waitText(page,'#model-picker-label','Qwen3-ASR 0.6B');
    await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
    assert.equal(await page.locator('#workspace-load').isVisible(),false);
    assert.equal(await page.locator('#run-button').isEnabled(),true);
    await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
    await upload(page,'[data-input-key="audio"]','resident-asr.wav');
    await page.locator('[data-input-key="context"]').fill('Aixora，专有名词');
    await page.locator('[data-input-key="language"]').selectOption('chinese');
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'Resident ASR did not submit');
    assert.equal(backend.loads.length,loads);
    assert.equal(backend.requests[0].model,'qwen3-asr');assert.equal(backend.requests[0].inputs.context,'Aixora，专有名词');
    backend.finish('job-1','常驻识别完成',[]);await waitValue(page,'#result-content textarea','常驻识别完成');
    await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
    assert.equal(backend.status.server.model,'tts-one');
    await snapshot(page,'asr-resident-ready');
    await advanced(page);await page.locator('#param-load_options-threads').fill('2');
    await waitText(page,'#apply-model-settings','应用并重载');
    assert.equal(await page.locator('#run-button').isDisabled(),true);
    await page.locator('#apply-model-settings').click();await page.waitForFunction(()=>!document.querySelector('#workspace-settings').matches(':popover-open'));
    await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
    assert.equal(backend.status.server.model,'tts-one');assert.equal(backend.status.asr.configuration.load_options.threads,'2');
    assert.equal(await page.locator('#run-button').isEnabled(),true);
    backend.status.asr={model:null,managed:false};await page.reload();await task(page,'asr');
    await page.waitForFunction(()=>document.querySelector('#run-button').disabled);
    assert.equal(await page.locator('#workspace-load').isVisible(),true);
  }],
  ['conversion reference tabs keep target sources exclusive beside options and results', async (page, backend) => {
    backend.voices.push({name:'saved.wav',label:'Saved reference',text:'参考原文',url:`${API}/references/saved.wav/audio`});
    await page.locator('[data-route="references"]').click();await task(page,'vc','Voice conversion');
    await page.setViewportSize({width:1366,height:768});
    await upload(page,'#task-form [data-input-key="audio"]','conversion-source.wav',300);
    const target=page.getByRole('group',{name:'目标音色',exact:true}),libraryTab=target.getByRole('tab',{name:'音频库',exact:true}),uploadTab=target.getByRole('tab',{name:'上传 / 录音',exact:true});
    assert.equal(await libraryTab.getAttribute('aria-selected'),'true');
    assert.equal(await target.getByRole('tabpanel',{name:'上传 / 录音',exact:true}).isVisible(),false);
    assert.equal(await page.locator('#common-options-heading').textContent(),'转换选项');
    assert.equal(await page.locator('.result-card').isVisible(),false);
    const layout=await page.evaluate(()=>{const box=s=>document.querySelector(s).getBoundingClientRect().toJSON();return {source:box('.task-primary'),target:box('.tts-reference-tabs'),options:box('#common-options'),run:box('#run-button')};});
    assert.ok(layout.source.bottom<=layout.target.top&&layout.target.right<layout.options.left&&layout.options.bottom<layout.run.top,'Source and target belong on the left; options and execution on the right');
    assert.equal(await page.locator('#task-form .reference-automatic').isVisible(),false,'Conversion must not expose unsupported reference transcription');
    await page.locator('#run-button').click();assert.equal(backend.requests.length,0,'Conversion without a target reached inference');
    await page.locator('[data-input-key="builtin_voice"]').selectOption('saved.wav');
    await uploadTab.click();await page.locator('#run-button').click();assert.equal(backend.requests.length,0,'An empty upload tab must not use the hidden library target');
    await libraryTab.click();
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'Library conversion was not submitted');
    assert.equal(backend.requests[0].inputs.builtin_voice,'saved.wav');assert.equal(backend.requests[0].inputs.voice,undefined);
    assert.equal(backend.requests[0].inputs.audio,'upload-1');
    backend.finish('job-1','',['converted.wav']);await waitText(page,'#job-status','converted.wav');
    assert.equal(await page.locator('#result-content audio').count(),2,'Conversion needs source and output comparison players');
    assert.equal(await page.locator('.tts-side-column .result-card').isVisible(),true);
    const geometry=await page.locator('#result-content audio').evaluateAll(items=>items.map(el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,width:r.width};}));
    assert.ok(geometry.every(box=>box.width>120&&box.bottom<=768),`Conversion players clipped ${JSON.stringify(geometry)}`);
    await snapshot(page,'regular-vc-reference-result');
    await waitText(page,'#job-status','用时 1.3 s');assert.equal(await page.locator('#job-status').getAttribute('data-state'),'done');
    await upload(page,'#task-form [data-input-key="voice"]','new-target.wav');
    assert.equal(await page.locator('[data-input-key="builtin_voice"]').inputValue(),'');
    assert.equal(await uploadTab.getAttribute('aria-selected'),'true');
    await libraryTab.click();await page.locator('#run-button').click();assert.equal(backend.requests.length,1,'An empty library tab must not use the hidden uploaded target');
    await uploadTab.click();
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===2,'Uploaded conversion target did not submit');
    assert.equal(backend.requests[1].inputs.voice,'upload-2');assert.equal(backend.requests[1].inputs.builtin_voice,undefined);
    assert.equal(backend.requests[1].inputs.audio,'upload-1');assert.equal(backend.referenceRequests.length,0);
    backend.finish('job-2','',['converted-upload.wav']);await waitText(page,'#job-status','converted-upload.wav');
    await snapshot(page,'regular-vc-upload-result');
    await page.setViewportSize({width:390,height:844});await assertBrowserScroll(page);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await assertVisibleControl(page,'#run-button','Narrow conversion action clipped');
    await assertVisibleControl(page,'#result-content>.artifact audio','Narrow source player clipped');
    await assertVisibleControl(page,'#result-content .result-files audio','Narrow converted player clipped');
    await snapshot(page,'compact-vc-upload-result');
  }],
  ['runtime JSON arrays and objects normalize backend string values after explicit apply', async (page, backend) => {
    backend.models.find(item=>item.id==='tts-one').parameters.push({name:'session_options.cache',label:'会话缓存',type:'int',default:0,level:'basic',scope:'session'});
    await pick(page,'tts-one');await advanced(page);
    assert.equal(await page.locator('#workspace-settings #param-session_options-cache').count(),1,'Runtime scope must stay advanced even when metadata level is basic');
    assert.equal(await page.locator('#common-options #param-session_options-cache').count(),0);
    await page.locator('#param-session_options-cache').fill('512');
    assert.equal(await page.locator('#workspace-load').isVisible(),true,'Runtime setting changes must retain the reload action');
    assert.equal(await page.locator('#workspace-load').textContent(),'应用并重载');
    await page.locator('#options-json').fill('{"session_options":{"token_ids":[1,2,3],"settings":{"b":2,"a":1}}}');
    assert.equal(await page.locator('#run-button').isDisabled(),true);
    await page.locator('#task-form').evaluate(form=>form.requestSubmit());
    assert.equal(backend.requests.length,0,'Enter/form submission bypassed pending runtime settings');
    const count=backend.loads.length;await page.locator('#apply-model-settings').click();
    await waitUntil(()=>backend.loads.length===count+1,'JSON settings did not explicitly reload');
    assert.equal(backend.status.server.configuration.session_options.token_ids,'[\n 1,\n 2,\n 3\n]');
    assert.equal(backend.status.server.configuration.session_options.cache,'512');
    await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
    await page.locator('[data-input-key="text"]').fill('JSON运行设置应用后的内容');await page.locator('#run-button').click();
    await waitUntil(()=>backend.requests.length===1,'Normalized runtime values remain pending');
    assert.equal(backend.loads.length,count+1,'Task caused an implicit extra reload');
  }],
  ['unloaded reference and language drafts survive selection, loading and task navigation', async (page, backend) => {
    Object.assign(backend.models.find(item=>item.id==='tts-two'),{voice_mode:'reference',profile:{accepts_voice_reference:true,send_reference_text:true,send_seed:false,send_max_tokens:false}});
    backend.voices.push({name:'saved.wav',label:'Saved reference',text:'已保存的参考原文',url:`${API}/references/saved.wav/audio`});
    await page.locator('[data-route="references"]').click();await task(page,'tts');
    await page.locator('[data-input-key="text"]').fill('模型加载前写好的合成内容');
    await page.locator('[data-input-key="builtin_voice"]').selectOption('saved.wav');
    await page.locator('#model-picker-trigger').click();await page.locator('[data-model-select="tts-two"]').click();
    await page.locator('#parameter-toggle').waitFor({state:'visible'});await page.keyboard.press('Escape');
    await page.locator('[data-input-key="language"]').selectOption('chinese');
    await waitValue(page,'[data-input-key="text"]','模型加载前写好的合成内容');
    await waitValue(page,'[data-input-key="language"]','chinese');await waitValue(page,'[data-input-key="builtin_voice"]','saved.wav');
    assert.equal(backend.loads.length,0);await page.locator('#workspace-load').click();
    await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
    await waitValue(page,'[data-input-key="builtin_voice"]','saved.wav');
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'Prepared reference synthesis did not submit');
    assert.equal(backend.requests[0].inputs.builtin_voice,'saved.wav');assert.equal(backend.requests[0].inputs.language,'chinese');
    backend.finish('job-1','',['prepared-tts.wav']);await waitText(page,'#job-status','prepared-tts.wav');
    await task(page,'vc');await upload(page,'#task-form [data-input-key="audio"]','vc-draft.wav');
    await page.locator('[data-input-key="builtin_voice"]').selectOption('saved.wav');await pick(page,'voice-convert');
    await task(page,'tts');await waitValue(page,'[data-input-key="text"]','模型加载前写好的合成内容');
    await waitValue(page,'[data-input-key="language"]','chinese');await waitValue(page,'[data-input-key="builtin_voice"]','saved.wav');
    await task(page,'vc');await waitText(page,'#task-inputs','vc-draft.wav');await waitValue(page,'[data-input-key="builtin_voice"]','saved.wav');
  }],
  ['ACE cover compares original and target with route controls and compact results', async (page, backend) => {
    const entry=backend.models.find(item=>item.id==='music-ace');entry.parameters=presetParameters('ace_step');
    Object.assign(entry.music_inputs,{source_audio_routes:['cover','remix'],source_required_routes:['cover','remix']});
    await page.setViewportSize({width:1366,height:768});await task(page,'music');await pick(page,'music-ace');
    await page.locator('#param-task_route').selectOption('cover');
    await page.locator('[data-input-key="text"]').fill('轻快的钢琴流行曲');await page.locator('[data-input-key="lyrics"]').fill('这是演唱的歌词\n按原曲旋律重新演绎');
    await upload(page,'#task-form [data-input-key="audio"]','cover-source.wav');
    for(const selector of ['#param-task_route','#music-source-duration','#param-source_caption','#param-source_lyrics','#param-audio_cover_strength','#param-cover_noise_strength','#run-button'])await assertVisibleControl(page,selector,'ACE cover control clipped');
    assert.equal(await page.locator('#common-options #param-audio_cover_strength').count(),1);
    assert.ok((await page.locator('#effect-controls').boundingBox()).height<100,'Route controls should not stretch into tall empty rows');
    const inputs=await page.locator('#task-inputs').evaluate(el=>{const prompt=el.querySelector('[data-input-key="text"]').getBoundingClientRect(),source=el.querySelector('.upload-zone').getBoundingClientRect(),original=el.querySelector('#param-source_lyrics').getBoundingClientRect(),lyrics=el.querySelector('[data-input-key="lyrics"]').getBoundingClientRect();return {prompt:prompt.height,sourceAbove:source.bottom<prompt.top,paired:original.right<lyrics.left,aligned:Math.abs(original.y-lyrics.y)<2,lyrics:lyrics.height,original:original.height};});
    assert.ok(inputs.prompt<=100&&inputs.sourceAbove&&inputs.paired&&inputs.aligned,'Source audio must precede aligned original and target editors');
    assert.ok(inputs.lyrics>=300&&inputs.lyrics===inputs.original,'Both lyrics editors need equal editing space');
    assert.equal(await page.locator('#task-form #param-num_inference_steps').count(),0);
    assert.equal(await page.locator('#workspace-settings #param-num_inference_steps').count(),1);
    assert.equal(await page.locator('#task-inputs .field-help').count(),0);
    assert.equal(await page.locator('.result-card').isVisible(),false,'Empty music results must not reserve a colored block');
    assert.equal(await page.locator('#result-heading').isVisible(),false,'Music results need no heading');
    await assertBrowserScroll(page);
    await snapshot(page,'regular-music-ace-cover');
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'ACE cover did not submit');
    await page.locator('.result-card').waitFor({state:'visible'});
    assert.ok((await page.locator('.result-card').boundingBox()).height<120,'A status-only result should remain compact');
    assert.equal(await page.locator('.result-card').evaluate(el=>getComputedStyle(el).backgroundColor===getComputedStyle(document.querySelector('.upload-zone')).backgroundColor),true,'The whole running result card must use the surface background');
    assert.equal(backend.requests[0].inputs.audio,'upload-1');assert.equal(backend.requests[0].options.task_route,'cover');
    assert.equal(backend.requests[0].inputs.duration,-1,'Follow-source duration must use the backend auto-duration contract');
  }],
  ['TTS uploaded reference and current output preserve visible common controls', async (page, backend) => {
    Object.assign(backend.models.find(item=>item.id==='tts-two'),{voice_mode:'reference',profile:{accepts_voice_reference:true,send_reference_text:true,require_voice:true,send_seed:false,send_max_tokens:false}});
    await page.setViewportSize({width:1366,height:768});await pick(page,'tts-two');
    await referenceMore(page);await page.locator('#task-form .reference-upload-fields .reference-automatic input').uncheck();
    assert.equal(await page.locator('.reference-upload-fields audio').isVisible(),true);
    assert.equal(await page.locator('.reference-upload-fields audio').getAttribute('aria-disabled'),'true');
    await upload(page,'#task-form [data-input-key="voice"]','uploaded-reference.wav');
    assert.equal(await page.locator('.reference-upload-fields audio').getAttribute('aria-disabled'),'false');
    assert.equal(await page.locator('[data-input-key="reference_text"]').isEnabled(),true);
    await page.locator('[data-input-key="reference_text"]').fill('上传参考音频实际说出的文字');
    await page.locator('[data-input-key="text"]').fill('通过上传的参考音频生成这段新的语音');
    await page.locator('[data-input-key="language"]').selectOption('chinese');
    await page.locator('#param-speaker').selectOption('voice-b');
    await page.locator('[data-input-key="stream"]').check();
    await page.locator('#param-speed').fill('1.1');
    for(const selector of ['[data-input-key="language"]','#param-speaker','#param-speed','#run-button'])await assertVisibleControl(page,selector,'TTS uploaded-reference common control clipped');
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'Uploaded-reference TTS did not submit');
    assert.ok(await page.locator('#job-status').evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),'Submitting brings output progress into view');
    assert.equal(backend.requests[0].inputs.voice,'upload-1');assert.equal(backend.requests[0].inputs.reference_text,'上传参考音频实际说出的文字');
    assert.equal(backend.requests[0].inputs.language,'chinese');assert.equal(backend.requests[0].inputs.stream,true);
    assert.equal(backend.requests[0].options.speaker,'voice-b');assert.equal(backend.requests[0].options.speed,1.1);
    backend.finish('job-1','',['uploaded-reference-output.wav']);Object.assign(backend.jobs.get('job-1'),{message:'生成完成，用时 3.6s。',elapsed:11.8});await waitText(page,'#job-status','uploaded-reference-output.wav');
    await waitText(page,'#job-status','生成完成，用时 3.6 s');
    assert.equal(await page.locator('#job-status').isVisible(),true);
    assert.ok(await page.locator('#job-status').evaluate(el=>Math.abs(el.getBoundingClientRect().right-document.querySelector('.result-title').getBoundingClientRect().right)<2),'Output status belongs at the right edge');
    assert.ok(await page.locator('#job-status').evaluate(el=>{const run=document.querySelector('#run-button').getBoundingClientRect(),card=el.closest('.result-card').getBoundingClientRect(),status=el.getBoundingClientRect();return run.bottom<=card.top&&status.top>=card.top&&status.bottom<=card.bottom;}),'Status belongs inside the result card below the generate button');
    assert.equal(await page.getByRole('button',{name:'显示波形',exact:true}).count(),0);
    await assertVisibleControl(page,'#run-button','TTS execute button clipped after output');
    await assertVisibleControl(page,'#result-content audio','TTS current output player clipped');
    assert.equal(await page.locator('#result-content .artifact-heading').count(),0,'Single audio filename must share the completion message');
    assert.ok(await page.locator('.result-card').evaluate(el=>{
      const result=el.getBoundingClientRect(),settings=document.querySelector('#common-options').getBoundingClientRect(),text=document.querySelector('[data-input-key="text"]').getBoundingClientRect(),audio=el.querySelector('audio').getBoundingClientRect();
      return result.height>=180&&result.height<=200&&settings.bottom<result.top&&text.right<result.left&&Math.abs(settings.right-result.right)<2&&audio.bottom<=result.bottom;
    }),'TTS output must keep its initial height below the right-column settings');
    const downloadEvent=page.waitForEvent('download');await page.locator('#job-status a[download]').click();
    assert.equal((await downloadEvent).suggestedFilename(),'uploaded-reference-output.wav');
    await assertBrowserScroll(page);await snapshot(page,'regular-tts-uploaded-reference-result');
  }],
  ['Qwen3 Base requires reference audio while library uploads and CustomVoice remain usable', async (page, backend) => {
    const catalog=require('./configs/models_catalog.json').models;
    const base=catalog.find(entry=>entry.id==='qwen3-tts'),custom=catalog.find(entry=>entry.id==='qwen3-tts-1.7b-custom');
    assert.equal(base.profile.require_voice,true,'Base catalog metadata must require reference audio');
    assert.equal(base.profile.require_reference_text,true,'Base ICL metadata must require the reference transcript');
    const base17=catalog.find(entry=>entry.id==='qwen3-tts-1.7b');
    assert.equal(base17.profile.require_voice,true,'1.7B Base must keep the same reference requirement');
    assert.equal(base17.profile.require_reference_text,true,'1.7B Base must keep the ICL transcript requirement');
    assert.equal(custom.profile.accepts_voice_reference,false,'CustomVoice must use its builtin speakers');
    const parameters=presetParameters('qwen3_tts');
    backend.models.push(
      model(base.id,base.display_name,'tts',base.task,{family:base.family,voice_mode:'reference',profile:{...base.profile,send_seed:false,send_max_tokens:false},parameters:parameters.filter(param=>!['speaker','instruction'].includes(param.name))}),
      model(custom.id,custom.display_name,'tts',custom.task,{family:custom.family,voice_mode:'builtin',profile:{...custom.profile,send_seed:false,send_max_tokens:false},parameters:parameters.map(param=>param.name==='instruction'?{...param,level:'effect'}:param)}));
    backend.voices.push({name:'qwen-reference.wav',label:'Qwen reference',text:'这段声音的参考原文',url:`${API}/references/qwen-reference.wav/audio`});
    backend.voices.push({name:'qwen-no-text.wav',label:'Qwen without transcript',text:'',url:`${API}/references/qwen-no-text.wav/audio`});
    await page.locator('[data-route="references"]').click();await page.locator('[data-route="models"]').click();await page.locator('#refresh-catalog').click();
    await task(page,'tts');await pick(page,base.id);
    await page.locator('[data-input-key="text"]').fill('用参考声音生成的新内容');
    await page.locator('#run-button').click();
    await waitText(page,'#job-status','这个模型需要参考声音');
    assert.equal(await page.locator('#job-status').isVisible(),true,'Missing-reference guidance must be visible');
    assert.equal(backend.requests.length,0,'Base with no reference reached the inference API');
    assert.equal(await page.locator('.tts-reference-tabs').getByRole('tab').count(),2);
    assert.equal(await page.locator('.tts-reference-tabs').getByRole('tab',{name:'音频库',exact:true}).getAttribute('aria-selected'),'true');
    await page.locator('#task-form').evaluate(form=>form.requestSubmit());
    await waitText(page,'#job-status','这个模型需要参考声音');
    assert.equal(backend.requests.length,0,'Empty reference bypassed the reference requirement');
    await page.locator('[data-input-key="builtin_voice"]').selectOption('qwen-no-text.wav');
    await page.locator('#run-button').click();await waitText(page,'#job-status','这个模型需要参考原文');
    assert.equal(backend.requests.length,0,'Base library entry without a transcript reached the inference API');
    await advanced(page);await page.locator('#options-json').fill('{"x_vector_only_mode":"false"}');
    await page.locator('#finish-model-settings').click();
    await page.locator('#run-button').click();await waitText(page,'#job-status','这个模型需要参考原文');
    assert.equal(backend.requests.length,0,'The string false incorrectly disabled the transcript requirement');
    await advanced(page);await page.locator('#options-json').fill('{"x_vector_only_mode":true}');
    await page.locator('#finish-model-settings').click();
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'X-vector-only library reference was blocked without a transcript');
    assert.equal(backend.requests[0].inputs.builtin_voice,'qwen-no-text.wav');
    assert.equal(backend.requests[0].options.x_vector_only_mode,true);
    backend.finish('job-1','',['qwen-x-vector-library.wav']);await waitText(page,'#job-status','qwen-x-vector-library.wav');
    await advanced(page);await page.locator('#options-json').fill('');await page.locator('#finish-model-settings').click();
    await page.locator('[data-input-key="builtin_voice"]').selectOption('qwen-reference.wav');
    await waitValue(page,'[data-reference-transcript]','这段声音的参考原文');
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===2,'Base library reference did not submit');
    assert.equal(backend.requests[1].inputs.builtin_voice,'qwen-reference.wav');assert.equal(backend.requests[1].inputs.voice,undefined);
    backend.finish('job-2','',['qwen-library.wav']);await waitText(page,'#job-status','qwen-library.wav');
    await referenceMore(page);await page.locator('#task-form .reference-upload-fields .reference-automatic input').uncheck();
    await upload(page,'#task-form [data-input-key="voice"]','qwen-upload.wav');
    await page.locator('#run-button').click();await waitText(page,'#job-status','这个模型需要参考原文');
    assert.equal(backend.requests.length,2,'Uploaded Base audio without a transcript reached the inference API');
    await page.locator('#task-form [data-input-key="reference_text"]').fill('上传参考音频中说出的实际文字');
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===3,'Base uploaded reference did not submit');
    assert.equal(backend.requests[2].inputs.voice,'upload-1');assert.equal(backend.requests[2].inputs.builtin_voice,undefined);
    assert.equal(backend.requests[2].inputs.reference_text,'上传参考音频中说出的实际文字');
    backend.finish('job-3','',['qwen-upload.wav']);await waitText(page,'#job-status','qwen-upload.wav');
    await advanced(page);await page.locator('#options-json').fill('{"x_vector_only_mode":true}');await page.locator('#finish-model-settings').click();
    await page.locator('.tts-reference-tabs').getByRole('tab',{name:'音频库',exact:true}).click();
    await page.locator('[data-input-key="builtin_voice"]').selectOption('');
    await page.locator('#run-button').click();await waitText(page,'#job-status','这个模型需要参考声音');
    assert.equal(backend.requests.length,3,'X-vector-only mode incorrectly exempted the audio requirement');
    await upload(page,'#task-form [data-input-key="voice"]','qwen-x-vector-upload.wav');
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===4,'X-vector-only upload was blocked without a transcript');
    assert.equal(backend.requests[3].inputs.voice,'upload-2');assert.equal(backend.requests[3].inputs.reference_text,undefined);
    backend.finish('job-4','',['qwen-x-vector-upload.wav']);await waitText(page,'#job-status','qwen-x-vector-upload.wav');
    await pick(page,custom.id);assert.equal(await page.locator('#task-form [data-input-key="voice"]').count(),0);
    await page.locator('#param-speaker').fill('Vivian');await page.locator('[data-input-key="text"]').fill('使用内置说话人直接合成');
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===5,'CustomVoice was incorrectly blocked without reference audio');
    assert.equal(backend.requests[4].model,custom.id);assert.equal(backend.requests[4].options.speaker,'Vivian');
    assert.equal(backend.requests[4].inputs.voice,undefined);assert.equal(backend.requests[4].inputs.builtin_voice,undefined);
  }],
  ['RVC checkboxes select builtin voice and disable indexes while retaining uploaded files', async (page, backend) => {
    Object.assign(backend.models.find(item=>item.id==='voice-convert'),{family:'rvc',voice_mode:'rvc',profile:{model_as_target_voice:true,accepts_voice_reference:false,send_seed:false},parameters:presetParameters('rvc')});
    await page.setViewportSize({width:1366,height:768});await task(page,'vc','Voice conversion');
    await upload(page,'#task-form [data-input-key="audio"]','rvc-source.wav');
    assert.equal(await page.locator('[data-input-key="rvc_voice_model"]').count(),1);
    assert.equal(await page.locator('[data-input-key="rvc_retrieval_index"]').count(),1);
    assert.equal(await page.locator('.tts-reference-tabs').count(),0,'RVC model and index must remain independent file inputs');
    assert.equal(await page.locator('.tts-main-column [data-input-key="rvc_voice_model"],.tts-main-column [data-input-key="rvc_retrieval_index"]').count(),2);
    assert.equal(await page.locator('.tts-side-column #param-voice_id,.tts-side-column #param-semitone_shift,.tts-side-column #param-retrieval_blend').count(),3);
    for(const selector of ['#param-voice_id','#param-semitone_shift','#param-retrieval_blend','#run-button'])await assertVisibleControl(page,selector,'RVC common control clipped');
    const fileLabels=await page.locator('[data-input-key="rvc_voice_model"], [data-input-key="rvc_retrieval_index"]').evaluateAll(inputs=>inputs.map(input=>{const r=input.closest('.upload-zone').getBoundingClientRect(),target=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return !!target&&input.closest('.upload-zone').contains(target);}));
    assert.deepEqual(fileLabels,[true,true],'RVC optional file controls clipped');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1));await snapshot(page,'regular-vc-rvc-options');
    const builtin=page.getByRole('checkbox',{name:'使用内置音色',exact:true}),noIndex=page.getByRole('checkbox',{name:'不使用音色索引',exact:true});
    for(const toggle of [builtin,noIndex]){
      assert.equal(await toggle.isChecked(),true);
      const geometry=await toggle.evaluate(input=>{const row=input.closest('label').getBoundingClientRect(),button=input.closest('.upload-zone').querySelector('.upload-actions').getBoundingClientRect();return {row:row.toJSON(),button:button.toJSON()};});
      assert.ok(geometry.row.top>=geometry.button.bottom&&Math.abs(geometry.row.left-geometry.button.left)<2,'RVC checkbox must occupy the row below its file button');
    }
    assert.equal(await page.getByRole('button',{name:'使用内置音色',exact:true}).count(),0);
    assert.equal(await page.locator('#param-retrieval_blend').isDisabled(),true);
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'Default builtin conversion');
    assert.equal(backend.requests[0].inputs.rvc_use_builtin,true);assert.equal(backend.requests[0].inputs.rvc_no_index,true);
    assert.equal(backend.requests[0].options.retrieval_blend,0);assert.equal(backend.requests[0].inputs.rvc_voice_model,undefined);
    backend.finish('job-1','',['builtin.wav']);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
    await builtin.uncheck();await page.locator('#run-button').click();await waitText(page,'#job-status','请选择 RVC 文件');assert.equal(backend.requests.length,1);
    await page.locator('[data-input-key="rvc_voice_model"]').setInputFiles({name:'custom.pth',mimeType:'application/octet-stream',buffer:Buffer.from('model')});
    await waitText(page,'.rvc-file-choice','custom.pth');assert.equal(await builtin.isChecked(),false);
    assert.equal(await page.locator('#param-voice_id').isDisabled(),true);
    await noIndex.uncheck();await page.locator('#param-retrieval_blend').evaluate(input=>{input.value='0.6';input.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.locator('#run-button').click();await waitText(page,'#job-status','选择索引文件');assert.equal(backend.requests.length,1);
    await noIndex.check();
    await page.locator('[data-input-key="rvc_retrieval_index"]').setInputFiles({name:'custom.index',mimeType:'application/octet-stream',buffer:Buffer.from('index')});
    await page.waitForFunction(()=>!document.querySelector('[data-input-key="rvc_no_index"]').checked);
    assert.equal(await page.locator('#param-retrieval_blend').inputValue(),'0.6');
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===2,'Custom RVC files conversion');
    assert.equal(backend.requests[1].inputs.rvc_voice_model,'upload-2');assert.equal(backend.requests[1].inputs.rvc_retrieval_index,'upload-3');assert.equal(backend.requests[1].options.retrieval_blend,0.6);
    backend.finish('job-2','',['custom.wav']);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
    await advanced(page);await page.locator('#options-json').fill('{"voice_model_path":"advanced.pth","retrieval_index_path":"advanced.index","retrieval_blend":0.8}');await page.keyboard.press('Escape');
    await builtin.check();await noIndex.check();
    assert.equal(await page.locator('#param-voice_id').isDisabled(),false);assert.equal(await page.locator('#param-retrieval_blend').inputValue(),'0');
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===3,'Disabled uploaded files conversion');
    assert.equal(backend.requests[2].inputs.rvc_voice_model,undefined);assert.equal(backend.requests[2].inputs.rvc_retrieval_index,undefined);
    assert.equal(backend.requests[2].options.voice_model_path,undefined);assert.equal(backend.requests[2].options.retrieval_index_path,undefined);assert.equal(backend.requests[2].options.retrieval_blend,0);
    backend.finish('job-3','',['builtin-again.wav']);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
    await task(page,'tts');await task(page,'vc');
    assert.equal(await builtin.isChecked(),true);assert.equal(await noIndex.isChecked(),true);
    assert.equal(await page.locator('.rvc-file-choice .upload-status').allTextContents().then(names=>names.join(',')),'custom.pth,custom.index');
    await snapshot(page,'rvc-checkboxes-retained-files');
    await page.setViewportSize({width:390,height:844});await assertBrowserScroll(page);
    await assertVisibleControl(page,'[data-input-key="rvc_use_builtin"]','Builtin checkbox clipped');await assertVisibleControl(page,'[data-input-key="rvc_no_index"]','Index checkbox clipped');await snapshot(page,'rvc-checkboxes-narrow');
  }],
  ['dense advanced model settings scroll internally with a fixed apply footer', async (page, backend) => {
    const real=[...presetParameters('ace_step'),...presetParameters('rvc')];
    backend.models.find(item=>item.id==='tts-one').parameters=real.slice(0,27).map((param,index)=>({...param,name:`expert_${index}_${param.name}`,level:'expert'}));
    await pick(page,'tts-one');await page.setViewportSize({width:1366,height:768});
    const pageHeight=await page.evaluate(()=>document.documentElement.scrollHeight);await advanced(page);
    assert.equal(await page.locator('#expert-controls > .field-group').count(),28,'27 realistic controls plus the seed should render');
    const content=await page.locator('.model-settings-content').evaluate(el=>({scroll:el.scrollHeight,client:el.clientHeight}));
    assert.ok(content.scroll>content.client,'Many advanced fields must scroll inside the popover');
    await assertVisibleControl(page,'#apply-model-settings','Advanced apply footer clipped');
    await page.locator('.model-settings-content').evaluate(el=>el.scrollTop=el.scrollHeight);
    await assertVisibleControl(page,'#options-json','Advanced JSON field cannot be reached');
    await assertVisibleControl(page,'#apply-model-settings','Advanced footer scrolled away');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight),pageHeight,'Advanced popover must not stretch the page');await snapshot(page,'regular-model-settings-dense');
  }],
  ['music edit instruction uses one main input without a duplicated advanced field', async (page, backend) => {
    Object.assign(backend.models.find(item=>item.id==='music-one'),{music_inputs:{lyrics:false,source_audio:true,require_source_audio:true,text_role:'instruction',text_label:'编辑指令'},profile:{require_source_audio:true,edit_instruction_key:'instruction',accepts_voice_reference:false,send_seed:false},parameters:[{name:'instruction',label:'表达风格',type:'text',default:'',level:'effect',scope:'request'}]});
    await task(page,'music','Music One');await page.locator('[data-input-key="text"]').fill('保留旋律，将乐器改为钢琴');
    assert.equal(await page.locator('#param-instruction').count(),0,'Main editing instruction is duplicated');
    await upload(page,'#task-form [data-input-key="audio"]','edit-source.wav');await page.locator('#run-button').click();
    await waitUntil(()=>backend.requests.length===1,'Music editing did not submit');assert.equal(backend.requests[0].inputs.text,'保留旋律，将乐器改为钢琴');
  }],
  ['scenario directory, planned workflows and realtime navigation', async (page, backend) => {
    await page.getByRole('button',{name:'场景应用',exact:true}).click();
    assert.equal(await page.locator('#page-scenarios').isVisible(),true);
    assert.equal(await page.locator('#parameter-toggle').isVisible(),false);
    assert.equal(await page.locator('#scenario-list > button').count(),4);
    assert.equal(await page.locator('#scenario-list > article.planned').count(),0);
    assert.deepEqual(await page.locator('#scenario-list .tool-card-title').allTextContents(),['实时语音聊天','自动字幕与校对','视频翻译配音','全局快捷键听写']);
    assert.equal(await page.locator('[data-scenario="long-form-reading"]').count(),0);
    await snapshot(page,'scenarios-desktop');
    await page.setViewportSize({width:390,height:900});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await snapshot(page,'scenarios-mobile');
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('[data-scenario="realtime-chat"]').click();
    assert.ok(page.url().endsWith('#scenarios/realtime-chat'));
    const frame=page.frameLocator('#realtime-frame');
    await frame.getByRole('button',{name:'返回工作台',exact:true}).click();
    await page.locator('#page-scenarios').waitFor();
    assert.equal(await page.locator('[data-route="scenarios"]').getAttribute('aria-current'),'page');
    await page.evaluate(()=>{location.hash='realtime';});
    await page.locator('#page-realtime').waitFor();
    assert.ok(page.url().endsWith('#scenarios/realtime-chat'),'Legacy realtime link should open the current scene');
    backend.status.realtime_active=true;
    await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:document.querySelector('#realtime-frame').contentWindow,data:{type:'audiocpp:realtime-state',active:true,microphone:true}})));
    assert.equal(await page.locator('#realtime-nav-status').textContent(),'通话中');
    await frame.getByRole('button',{name:'返回工作台',exact:true}).click();
    await page.locator('#page-scenarios').waitFor();
    await page.locator('#end-realtime-session').waitFor({state:'hidden'});
    assert.notEqual(await page.locator('#realtime-nav-status').textContent(),'通话中','Returning from the scene ends the call');
  }],
  ['realtime iframe bypasses stale markup and opens settings and history after reload', async (page, backend) => {
    backend.staleRealtimeDocument=true;
    await page.goto(`${ORIGIN}/#scenarios/realtime-chat`);
    const frame=page.frameLocator('#realtime-frame');
    for(let attempt=0;attempt<2;attempt++) {
      await frame.locator('#call-more summary').click();
      await frame.getByRole('button',{name:'聊天设置',exact:true}).click();
      await frame.locator('#settings-modal[open]').waitFor();
      await frame.getByRole('tab',{name:'角色',exact:true}).click();
      await frame.locator('#tts-reference-refresh').waitFor();
      await frame.getByRole('button',{name:'取消',exact:true}).click();
      await frame.locator('#call-more summary').click();
      await frame.getByRole('button',{name:'对话记录',exact:true}).click();
      await frame.locator('#chat-panel.open').waitFor();
      assert.equal(await frame.locator('#chat-panel').evaluate(el=>el.inert),false);
      await frame.getByRole('button',{name:'关闭对话记录',exact:true}).click();
      if(!attempt)await page.reload();
    }
    assert.equal(backend.requests.length,0,'Opening panels must not activate models or submit jobs');
  }],
  ['buttons keep consistent semantics, focus and themes across pages and realtime', async page => {
    const style=el=>{const s=getComputedStyle(el);return {radius:s.borderRadius,height:s.minHeight,font:s.fontSize,background:s.backgroundColor,color:s.color};};
    await page.locator('[data-route="references"]').click();
    const secondary=await page.locator('#new-reference').evaluate(style),compact=await page.locator('.reference-save').evaluate(style);
    assert.equal(secondary.radius,'8px');assert.equal(secondary.height,'36px');assert.equal(secondary.font,'13.5px');
    assert.equal(compact.radius,'8px');assert.equal(compact.height,'32px');
    await page.keyboard.press('Tab');
    await page.locator('#new-reference').focus();
    assert.equal(await page.locator('#new-reference').evaluate(el=>getComputedStyle(el).outlineStyle),'solid');
    await page.locator('[data-route="scenarios"]').click();await page.locator('[data-scenario="realtime-chat"]').click();
    const frame=page.frameLocator('#realtime-frame');
    await frame.locator('#call-more summary').click();await frame.locator('#settings-btn').click();
    await frame.locator('#settings-modal[open]').waitFor();
    for(const palette of ['classic','studio'])for(const theme of ['light','dark']) {
      await page.evaluate(({palette,theme})=>{document.documentElement.dataset.palette=palette;document.documentElement.dataset.theme=theme;document.querySelector('#realtime-frame').contentWindow.postMessage({type:'audiocpp:theme',palette,theme},location.origin);},{palette,theme});
      await frame.locator('html').evaluate((el,{palette,theme})=>{el.dataset.palette=palette;el.dataset.theme=theme;},{palette,theme});
      const primary=await frame.locator('#settings-save').evaluate(style),cancel=await frame.locator('.modal-footer .btn.plain').evaluate(style);
      assert.equal(primary.radius,'8px');assert.equal(primary.height,'36px');assert.equal(primary.font,'13.5px');
      assert.notEqual(primary.background,cancel.background);assert.notEqual(primary.color,primary.background);
      await snapshot(page,`realtime-buttons-${palette}-${theme}`);
    }
    await frame.locator('#settings-save').evaluate(el=>{el.disabled=true;});
    await frame.locator('#settings-save').hover();
    assert.equal(await frame.locator('#settings-save').evaluate(el=>getComputedStyle(el).opacity),'0.5');
  }],
  ['reference names survive uploads and the save row follows recognition in every reference form', async (page, backend) => {
    await page.locator('[data-route="references"]').click();
    await page.locator('#reference-editor .check-label input').uncheck();
    const name=page.locator('#reference-editor [data-input-key="reference_name"]');
    await name.fill('预先填写的保存名称');
    await upload(page,'#reference-editor [data-input-key="voice"]','different-file.wav');
    assert.equal(await name.inputValue(),'预先填写的保存名称');
    const gate=backend.holdUpload('slow-name.wav');
    await page.locator('#reference-editor [data-input-key="voice"]').setInputFiles({name:'slow-name.wav',mimeType:'audio/wav',buffer:wav()});
    await waitUntil(()=>backend.uploads.some(u=>u.name==='slow-name.wav'),'pending upload did not start');
    await name.fill('上传期间修改的名称');gate.resolve();
    await waitText(page,'#reference-editor .upload-status','slow-name.wav');
    assert.equal(await name.inputValue(),'上传期间修改的名称');
    assert.equal(await page.locator('#reference-editor .reference-controls').evaluate(el=>el.querySelector('.reference-name-row').closest('.field-group').previousElementSibling.className),'reference-actions');
    await page.locator('#new-reference').click();
    await upload(page,'#reference-editor [data-input-key="voice"]','default-name.wav');
    assert.equal(await name.inputValue(),'default-name');
    const entry=backend.models.find(m=>m.id==='tts-one');Object.assign(entry,{voice_mode:'reference',profile:{accepts_voice_reference:true,send_reference_text:true}});
    await page.locator('[data-route="tts"]').click();
    await page.locator('#parameter-toggle').waitFor({state:'visible'});
    await referenceMore(page);assert.equal(await page.locator('#task-form [data-input-key="reference_name"]').isVisible(),true);
    assert.equal(await page.locator('#task-form [data-input-key="reference_name"]').isDisabled(),true);
    assert.equal(await page.locator('#task-form .reference-save').count(),1);
    await upload(page,'#task-form [data-input-key="voice"]','tts-reference.wav');
    await page.locator('#task-form [data-input-key="reference_name"]').fill('合成页保存名称');
    await upload(page,'#task-form [data-input-key="voice"]','tts-replacement.wav');
    assert.equal(await page.locator('#task-form [data-input-key="reference_name"]').inputValue(),'合成页保存名称');
  }],
  ['reference compact rows, default appearance and all-model memory release', async (page, backend) => {
    assert.equal(await page.locator('html').getAttribute('data-palette'),'classic');
    assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
    assert.equal(await page.locator('#resident-model').isVisible(),false);
    await page.locator('[data-route="references"]').click();
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:900});
      const boxes=await page.locator('#reference-editor').evaluate(el=>{
        const box=selector=>{const r=el.querySelector(selector).getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right};};
        return {name:box('[data-input-key="reference_name"]'),save:box('.reference-save'),automatic:box('.check-label'),retry:box('.reference-actions button')};
      });
      for(const [a,b] of [[boxes.name,boxes.save],[boxes.automatic,boxes.retry]]) {
        assert.ok(a.top<b.bottom&&b.top<a.bottom,'Reference controls should share one row');
        assert.ok(a.right<=b.left,'Reference controls overlap');
      }
      assert.ok(boxes.name.top>boxes.retry.bottom,'Save name must follow recognition controls');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    }
    await snapshot(page,'reference-compact-mobile');
    await page.setViewportSize({width:1440,height:1000});
    await snapshot(page,'reference-compact-desktop');
    backend.status.asr={model:'qwen3-asr',managed:true};
    await page.locator('[data-route="settings"]').click();
    await page.locator('[data-settings-tab="runtime"]').click();
    await waitText(page,'#settings-runtime','Qwen3-ASR 0.6B');
    await waitText(page,'#resident-model-name','Qwen3-ASR 0.6B');
    assert.equal(await page.locator('#resident-model').isVisible(),true);
    assert.ok(await page.locator('#resident-model').evaluate(el=>el.getBoundingClientRect().bottom<=document.querySelector('#connection-status').getBoundingClientRect().top));
    await snapshot(page,'resident-model-sidebar-desktop');
    await page.locator('#sidebar-toggle').click();
    assert.equal(await page.locator('.resident-model-copy').isVisible(),false);
    assert.equal(await page.locator('#resident-model').getAttribute('title'),'常驻模型 · Qwen3-ASR 0.6B · 本地服务在线');
    assert.equal(await page.locator('#resident-model .icon').isVisible(),true);
    await page.locator('#sidebar-toggle').click();
    await page.setViewportSize({width:390,height:900});
    await page.locator('#sidebar-toggle').click();
    assert.equal(await page.locator('#resident-model-name').isVisible(),true);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await snapshot(page,'resident-model-sidebar-mobile');
    await page.locator('#sidebar-toggle').click();
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('#unload-all-models').click();
    await waitUntil(()=>backend.unloads.length===1,'all-model release was not requested');
    await page.waitForFunction(()=>!document.querySelector('#settings-runtime').textContent.includes('Qwen3-ASR'));
    assert.equal(backend.status.server.model,null);assert.equal(backend.status.asr.model,null);
    assert.equal(await page.locator('#resident-model').isVisible(),false);
  }],
  ['reference library saves corrected text, updates existing entries without a dialog, edits and deletes', async (page, backend) => {
    await page.locator('[data-route="references"]').click();
    const editor=page.locator('#reference-editor');
    let dialogs=0;page.on('dialog',dialog=>{dialogs++;void dialog.accept();});
    await upload(page,'#reference-editor [data-input-key="voice"]','reference.wav');
    await waitUntil(()=>backend.referenceRequests.length===1,'reference ASR was not submitted');
    await editor.locator('[data-input-key="reference_text"]').fill('用户手动校正');
    backend.finish('reference-1','自动识别原文',[]);
    await waitText(page,'#reference-editor .reference-status','已保留');
    assert.equal(await editor.locator('[data-input-key="reference_text"]').inputValue(),'用户手动校正');
    await editor.locator('.reference-adopt').click();
    await waitValue(page,'#reference-editor [data-input-key="reference_text"]','自动识别原文');
    assert.equal(await editor.locator('.reference-status').textContent(),'');
    assert.equal(await editor.locator('.reference-status').isVisible(),false);
    await editor.locator('[data-input-key="reference_text"]').fill('最终校正文本');
    await editor.locator('[data-input-key="reference_name"]').fill('温暖男声');
    await editor.locator('.reference-save').click();
    await page.waitForFunction(()=>document.querySelector('#reference-list').textContent.includes('最终校正文本'));
    assert.equal(backend.referenceSaves[0].text,'最终校正文本');
    assert.equal(dialogs,0);
    await snapshot(page,'reference-library-saved');
    await page.setViewportSize({width:420,height:900});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Reference library overflows a narrow screen');
    await snapshot(page,'reference-library-mobile');
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('#reference-list').getByRole('button',{name:'编辑',exact:true}).click();
    await waitValue(page,'#reference-editor [data-input-key="reference_text"]','最终校正文本');
    await editor.locator('[data-input-key="reference_text"]').fill('再次修正');
    await editor.locator('.reference-save').click();
    await page.waitForFunction(()=>document.querySelector('#reference-list').textContent.includes('再次修正'));
    assert.equal(backend.referenceSaves.length,2,'Each save should update in one request');
    assert.ok(backend.referenceSaves.every(r=>r.overwrite));assert.equal(dialogs,0);
    await page.locator('#reference-search').fill('再次修正');
    await page.waitForFunction(()=>document.querySelector('#reference-list').textContent.includes('再次修正'));
    await page.locator('#reference-list').getByRole('button',{name:'删除',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#reference-count').textContent==='0 段参考音频');
    assert.equal(dialogs,1);assert.equal(backend.voices.length,0);
    await snapshot(page,'reference-library');
  }],
  ['reference upload replacement ignores stale text and transcribes latest audio', async (page, backend) => {
    await page.locator('[data-route="references"]').click();
    await upload(page,'#reference-editor [data-input-key="voice"]','first.wav');
    await waitUntil(()=>backend.referenceRequests.length===1,'first reference ASR missing');
    await upload(page,'#reference-editor [data-input-key="voice"]','second.wav');
    backend.finish('reference-1','旧音频原文',[]);
    await waitUntil(()=>backend.referenceRequests.length===2,'latest reference ASR missing');
    backend.finish('reference-2','新音频原文',[]);
    await waitValue(page,'#reference-editor [data-input-key="reference_text"]','新音频原文');
    assert.equal(backend.referenceRequests[1].audio,backend.uploads[1].id);
  }],
  ['reference audio selection fills preview and text and uploaded audio clears saved selection', async (page, backend) => {
    const entry=backend.models.find(m=>m.id==='tts-two');Object.assign(entry,{voice_mode:'reference',profile:{accepts_voice_reference:true,send_reference_text:true,send_seed:false}});
    backend.voices.push({name:'saved.wav',label:'Saved reference',text:'已保存原文',url:`${API}/references/saved.wav/audio`});
    await page.locator('[data-route="references"]').click();await page.locator('[data-route="tts"]').click();await pick(page,'tts-two');
    const ordered=await page.locator('#task-form').evaluate(form=>{
      const columnOrder=(column,selectors)=>{
        const controls=selectors.map(selector=>form.querySelector(selector));
        return controls.every((control,index)=>control?.closest(column)&&(!index||!!(controls[index-1].compareDocumentPosition(control)&Node.DOCUMENT_POSITION_FOLLOWING)));
      };
      return columnOrder('.tts-main-column',['[data-input-key="builtin_voice"]','[data-input-key="voice"]','[data-input-key="text"]'])&&columnOrder('.tts-side-column',['#common-options','#run-button']);
    });
    assert.equal(ordered,true,'Both reference tabs precede left-column text; generation follows the right-column common controls');
    assert.equal(await page.locator('[data-input-key="builtin_voice"] option').first().textContent(),'从音频库选择');
    await page.locator('#model-picker-trigger').click();
    assert.equal(await page.locator('#model-picker-status').isVisible(),false);
    await page.keyboard.press('Escape');
    await page.locator('[data-input-key="builtin_voice"]').selectOption('saved.wav');
    await waitValue(page,'#task-form [data-reference-transcript]','已保存原文');
    assert.ok((await page.locator('#task-form audio').first().getAttribute('src')).includes('/references/saved.wav/audio'));
    await upload(page,'#task-form [data-input-key="voice"]','new-reference.wav');
    await waitUntil(()=>backend.referenceRequests.length===1,'TTS reference ASR missing');
    await page.waitForFunction(()=>document.querySelector('#workspace-grid').hidden===false);
    assert.equal(await page.locator('[data-input-key="builtin_voice"]').inputValue(),'');
    backend.finish('reference-1','新参考原文',[]);await waitValue(page,'#task-form [data-input-key="reference_text"]','新参考原文');
    assert.equal(await page.locator('#task-form .reference-status').textContent(),'');
    assert.equal(await page.locator('#task-form .reference-status').isVisible(),false);
    await page.locator('[data-input-key="text"]').fill('生成内容');await page.locator('#run-button').click();
    await waitUntil(()=>backend.requests.length===1,'TTS request missing');
    assert.equal(backend.requests[0].inputs.voice,backend.uploads[0].id);
    assert.equal(backend.requests[0].inputs.reference_text,'新参考原文');
    assert.equal(backend.requests[0].inputs.builtin_voice,undefined);
  }],
  ['reference auto transcription can be disabled and busy realtime preserves manual entry', async (page, backend) => {
    await page.locator('[data-route="references"]').click();
    await page.locator('#reference-editor .check-label input').uncheck();
    await upload(page,'#reference-editor [data-input-key="voice"]','manual.wav');
    assert.equal(backend.referenceRequests.length,0);
    backend.status.realtime_active=true;
    await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:document.querySelector('#realtime-frame').contentWindow,data:{type:'audiocpp:realtime-state',active:true}})));
    await page.locator('#reference-editor [data-input-key="reference_text"]').fill('保留的手动原文');
    await page.locator('#reference-editor').getByRole('button',{name:'音频转录',exact:true}).click();
    await waitText(page,'#reference-editor .reference-status','当前任务结束后');
    assert.equal(backend.referenceRequests.length,0);
    assert.equal(await page.locator('#reference-editor [data-input-key="reference_text"]').inputValue(),'保留的手动原文');
  }],
  ['direct design and conversion navigation excludes audio processing models', async (page, backend) => {
    backend.models.push(model('enhance','Enhance','processing','s2s'));
    await page.locator('[data-route="models"]').click();await page.locator('#refresh-catalog').click();
    await page.locator('[data-route="vc"]').click();await page.locator('#model-picker-trigger').click();
    assert.deepEqual(await page.locator('#model-picker-list [data-model]').evaluateAll(rows=>rows.map(r=>r.dataset.model)),['voice-convert']);
    await page.keyboard.press('Escape');await page.locator('[data-route="design"]').click();await page.locator('#model-picker-trigger').click();
    assert.deepEqual(await page.locator('#model-picker-list [data-model]').evaluateAll(rows=>rows.map(r=>r.dataset.model)),['voice-design']);
    await page.keyboard.press('Escape');await page.locator('[data-route="tools"]').click();await page.getByRole('button',{name:'音频处理',exact:false}).click();
    await page.locator('#model-picker-trigger').click();assert.deepEqual(await page.locator('#model-picker-list [data-model]').evaluateAll(rows=>rows.map(r=>r.dataset.model)),['enhance']);
  }],
  ['voice design language choices preserve each model request contract', async (page, backend) => {
    const variants=[
      {family:'qwen3_tts',languages:['zh','en'],default:'auto',expected:['auto','zh','en'],value:'en',label:'英语'},
      {family:'fireredtts3',languages:['Chinese','English','ZH_Sichuan'],default:'Chinese',expected:['Chinese','English','ZH_Sichuan'],value:'ZH_Sichuan',label:'四川话'},
      {family:'irodori_tts',languages:['japanese'],mapping:{japanese:'ja'},default:'ja',expected:['ja'],value:'ja',label:'日语'},
      {family:'moss_voicegen',languages:['English','Chinese'],choices:['English','Chinese'],default:'English',expected:['English','Chinese'],value:'Chinese',label:'中文'},
      {family:'firered_audio',languages:['zh','en'],default:'zh',expected:['zh','en'],value:'zh',label:'中文'},
      {family:'breeze_tts',languages:[],expected:[]},
    ];
    for(const variant of variants)backend.models.push(model(`design-${variant.family}`,variant.family,'design','vdes',{
      family:variant.family,languages:variant.languages,
      profile:{accepts_voice_reference:false,send_seed:false,send_max_tokens:false,lang_map:variant.mapping},
      parameters:variant.expected.length?[{name:'language',label:'模型语言',type:variant.choices?'choice':'text',choices:variant.choices,default:variant.default,level:'basic',scope:'request'}]:[],
    }));
    await page.locator('[data-route="models"]').click();await page.locator('#refresh-catalog').click();await task(page,'design');
    for(const [index,variant] of variants.entries()){
      await pick(page,`design-${variant.family}`);
      assert.equal(await page.locator('[data-input-key="language"]').count(),0,'Voice design must not add a second language input');
      if(variant.expected.length){
        const language=page.getByLabel('合成语言',{exact:true});
        assert.equal(await language.evaluate(el=>el.tagName),'SELECT');
        assert.deepEqual(await language.locator('option').evaluateAll(items=>items.map(item=>item.value)),variant.expected);
        assert.equal(await language.inputValue(),variant.default);
        await language.selectOption({label:variant.label});
      }else assert.equal(await page.locator('#param-language').count(),0,'No language selector without a supported request option');
      await page.locator('[data-input-key="instruct"]').fill('温暖、自然的声音');await page.locator('[data-input-key="text"]').fill('测试合成语言');
      await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===index+1,'Voice design request missing');
      assert.equal(backend.requests[index].options.language,variant.value);
      backend.finish(`job-${index+1}`,'',['voice-design.wav']);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
    }
  }],
  ['voice design common options preserve model defaults, requests and advanced settings', async (page, backend) => {
    const variants=[
      {id:'design-qwen',family:'qwen3_tts',values:{temperature:1.15,do_sample:false},defaults:{temperature:.9,do_sample:true},maxTokens:true},
      {id:'design-firered3',family:'fireredtts3',values:{num_inference_steps:16,guidance_scale:2.5},defaults:{num_inference_steps:10},jsonDefaults:{guidance_scale:2}},
      {id:'design-irodori-v3',family:'irodori_tts',values:{duration_sec:0,duration_scale:1.2,caption_guidance_scale:4},defaults:{duration_sec:0,duration_scale:1,caption_guidance_scale:3}},
      {id:'design-irodori-v4',family:'irodori_tts',values:{duration_sec:8,duration_scale:1.1,caption_guidance_scale:2},defaults:{duration_sec:0,duration_scale:1,caption_guidance_scale:3}},
      {id:'design-moss',family:'moss_voicegen',values:{temperature:1.25,repetition_penalty:1.2},defaults:{temperature:1.5,repetition_penalty:1.1}},
      {id:'design-firered-audio',family:'firered_audio',values:{num_inference_steps:12,guidance_scale:3},defaults:{num_inference_steps:10,guidance_scale:2}},
      {id:'design-breeze',family:'breeze_tts',values:{temperature:.8,guidance_scale:1.5},defaults:{temperature:.9,guidance_scale:1},maxTokens:true},
    ];
    for(const variant of variants){
      const spec=require(`../model_specs/${variant.family}.json`),parameters=new Map();
      for(const p of spec.options?.request||[])parameters.set(p.name,{...p,type:{string:'text',float:'number',int:'number'}[p.type]||p.type,step:p.type==='int'?1:undefined});
      for(const p of PRESET_PARAMETERS[variant.family]||[])parameters.set(p.name,{...parameters.get(p.name),...clone(p)});
      backend.models.push(model(variant.id,variant.id,'design','vdes',{family:variant.family,
        languages:spec.languages||['English','Chinese'],profile:{send_seed:true,send_max_tokens:!!variant.maxTokens},
        parameters:[...[...parameters.values()].map(p=>({...p,scope:'request',level:p.name==='language'?'basic':'expert'})),
          {name:'session_options.graph_mb',label:'计算图内存',type:'number',default:512,level:'expert',scope:'session'},
          {name:'load_options.threads',label:'推理线程',type:'int',default:4,level:'expert',scope:'load'}]}));
    }
    await page.locator('[data-route="models"]').click();await page.locator('#refresh-catalog').click();await task(page,'design');
    await page.setViewportSize({width:1366,height:768});
    assert.equal(await page.locator('#common-options [data-input-key="seed"]').count(),0,'Common options require a selected model contract');
    for(const [index,variant] of variants.entries()){
      await pick(page,variant.id);const loads=backend.loads.length;
      await page.locator('[data-input-key="instruct"]').fill('自然、沉稳的成年声音');await page.locator('[data-input-key="text"]').fill('测试常用合成选项。');
      for(const [key,expected] of Object.entries(variant.defaults)){
        const input=page.locator(`#common-options #param-${key}`);
        assert.equal(await input.count(),1,`${variant.id}: missing common ${key}`);
        assert.equal(typeof expected==='boolean'?await input.isChecked():Number(await input.inputValue()),expected);
        assert.equal(await page.locator(`#workspace-settings #param-${key}`).count(),0,`${key} must not appear twice`);
      }
      assert.equal(await page.locator('#common-options [data-input-key="seed"]').count(),1);
      assert.equal(await page.locator('#workspace-settings [data-input-key="seed"]').count(),0);
      await advanced(page);
      assert.deepEqual(await page.locator('#expert-controls .parameter-section-title').allTextContents(),['加载与内存','高级合成参数']);
      assert.equal(await page.locator('#workspace-settings [data-input-key="max_tokens"]').count(),variant.maxTokens?1:0);
      await page.locator('#options-json').fill(JSON.stringify({...variant.defaults,...variant.jsonDefaults,seed:100+index}));await page.keyboard.press('Escape');
      await waitValue(page,'#common-options [data-input-key="seed"]',String(100+index));
      for(const [key,value] of Object.entries(variant.values)){
        const input=page.locator(`#common-options #param-${key}`);
        if(typeof value==='boolean')await input.setChecked(value);
        else if(await input.getAttribute('type')==='range')await input.evaluate((el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));},String(value));
        else await input.fill(String(value));
        assert.equal(JSON.parse(await page.locator('#options-json').inputValue())[key],value,'Visible controls must update an existing JSON override');
      }
      await page.locator('#common-options [data-input-key="seed"]').fill(String(40+index));
      assert.equal(JSON.parse(await page.locator('#options-json').inputValue()).seed,undefined);
      assert.equal(backend.loads.length,loads,'Common request options must not reload the model');
      await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===index+1,'Voice design common request missing');
      const request=backend.requests[index];assert.equal(request.inputs.seed,40+index);
      for(const [key,value] of Object.entries(variant.values))assert.equal(request.options[key],value,`${variant.id}: ${key} request mismatch`);
      assert.equal(request.options.seed,undefined);assert.equal(request.options.load_options,undefined);assert.equal(request.options.session_options,undefined);
      backend.finish(`job-${index+1}`,'',['common-design.wav']);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
    }
    await pick(page,'design-qwen');await waitValue(page,'#param-temperature','1.15');assert.equal(await page.locator('#param-do_sample').isChecked(),false);
    await waitValue(page,'#common-options [data-input-key="seed"]','40');assert.equal(await page.locator('#param-guidance_scale').count(),0);
    for(const width of [1366,390]){
      await page.setViewportSize({width,height:900});await assertBrowserScroll(page);
      for(const selector of ['#param-temperature','#param-do_sample','#input-design-seed','#run-button'])await assertVisibleControl(page,selector,'Voice design common option clipped');
      await snapshot(page,`design-common-${width}`);await advanced(page);await snapshot(page,`design-settings-${width}`);await page.keyboard.press('Escape');
    }
    await advanced(page);await page.locator('#reset-options').click();await page.keyboard.press('Escape');
    await waitValue(page,'#param-temperature','0.9');assert.equal(await page.locator('#param-do_sample').isChecked(),true);
    await waitValue(page,'#common-options [data-input-key="seed"]','');await waitValue(page,'#options-json','');
    await page.setViewportSize({width:1366,height:768});await pick(page,'design-firered3');await waitValue(page,'#param-guidance_scale','2.5');
    await task(page,'tts');assert.equal(await page.locator('#common-options [data-input-key="seed"]').count(),0,'Design seed placement must not leak to TTS');
  }],
  ['unloaded workspace allows preparation, metadata selection and explicit load retry', async (page, backend) => {
    assert.equal(await page.locator('#workspace-start').isVisible(),false);
    assert.equal(await page.locator('#workspace-grid').isVisible(),true);
    assert.equal(await page.locator('#parameter-toggle').isVisible(),false);
    await page.locator('[data-input-key="text"]').fill('先准备合成文本');
    assert.equal(await page.locator('#run-button').isDisabled(),true);
    await snapshot(page,'initial');
    await page.locator('#model-picker-trigger').click();
    await page.locator('[data-model-select="tts-two"]').click();
    await waitText(page,'#model-picker-label','TTS Two');
    await page.waitForFunction(()=>document.querySelector('[data-model-select="tts-two"]').getAttribute('aria-pressed')==='true');
    assert.equal(backend.loads.length,0);
    assert.equal(await page.locator('#model-picker-popover').isVisible(),true);
    await page.keyboard.press('Escape');
    await waitValue(page,'[data-input-key="text"]','先准备合成文本');
    await advanced(page);await page.locator('#param-load_options-threads').fill('6');
    assert.equal(backend.loads.length,0,'Editing settings must not load a model');
    await page.locator('#apply-model-settings').click();
    assert.equal(backend.loads.length,0,'Saving settings before first load must not infer load authorization');
    await page.reload();await waitText(page,'#model-picker-label','TTS Two');
    assert.equal(await page.locator('#workspace-grid').isVisible(),true);
    assert.equal(await page.locator('#run-button').isDisabled(),true);
    await page.locator('#model-picker-trigger').click();
    backend.loadGate=deferred();backend.loadError=true;
    await page.locator('[data-load-model="tts-two"]').click();
    await waitUntil(()=>backend.loads.length===1,'Load request did not start');
    assert.equal(await page.locator('#workspace-grid').isVisible(),true);
    assert.equal(await page.locator('[data-load-model="tts-two"]').isDisabled(),true);
    backend.loadGate.resolve();await waitText(page,'#toast','Fixture load failed');
    await waitText(page,'#model-picker-status','加载失败：Fixture load failed');
    assert.equal(await page.locator('[data-load-model="tts-two"]').textContent(),'重试');
    await page.locator('#toast').evaluate(el=>el.hidden=true);
    assert.equal(await page.locator('#workspace-load-status').isVisible(),true);
    await page.waitForFunction(()=>!document.querySelector('[data-load-model="tts-two"]').disabled);
    assert.equal(await page.locator('#run-button').isDisabled(),true);
    backend.loadGate=null;backend.loadError=false;
    await page.locator('#model-picker-trigger').click();
    await page.locator('[data-load-model="tts-two"]').click();
    await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
    assert.equal(await page.locator('#run-button').isDisabled(),false);
    assert.equal(backend.loads.length,2);await snapshot(page,'loaded');
    await task(page,'asr');await waitText(page,'#model-picker-label','选择语音识别模型');
    assert.equal(await page.locator('[data-input-key="audio"]').count(),1);
    assert.equal(await page.locator('#run-button').isDisabled(),true);
    await task(page,'music');await waitText(page,'#model-picker-label','选择音乐与音效模型');
    await page.setViewportSize({width:390,height:844});
    await page.locator('#model-picker-trigger').click();await snapshot(page,'mobile');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    const popup=await page.locator('#model-picker-popover').boundingBox();
    assert.ok(popup.x>=0&&popup.x+popup.width<=391);
  }],
  ['unloaded navigation during a pending load keeps the current task preparation page', async (page, backend) => {
    backend.loadGate=deferred();await page.locator('#model-picker-trigger').click();
    await page.locator('[data-load-model="tts-one"]').click();
    await waitUntil(()=>backend.loads.length===1,'Load request did not start');
    await task(page,'asr');backend.loadGate.resolve();
    await waitUntil(()=>backend.status.server.model==='tts-one','Load did not finish');
    await waitText(page,'#model-picker-label','选择语音识别模型');
    assert.equal(await page.locator('#workspace-grid').isVisible(),true);
    assert.equal(await page.locator('[data-input-key="audio"]').count(),1);
    assert.equal(await page.locator('[data-input-key="text"]').count(),0);
    assert.equal(await page.locator('#run-button').isDisabled(),true);
    backend.loadGate=null;await pick(page,'asr-one');
    assert.equal(await page.locator('#model-picker-label').textContent(),'ASR One');
  }],
  ['workspace toolbar and anchored model settings preserve themes and navigation', async (page, backend) => {
    assert.equal(await page.locator('#task-title').textContent(),'语音合成');
    assert.equal(await page.locator('#workspace-settings').isVisible(),false);
    assert.equal(await page.locator('#task-title, #model-picker-trigger, #parameter-toggle, #workspace-load').evaluateAll(items=>items.every(item=>!item.closest('.card'))),true);
    assert.equal(await page.locator('#parameter-toggle').getAttribute('aria-label'),'模型设置');
    assert.equal(await page.locator('#parameter-toggle svg').count(),1);
    assert.equal(await page.locator('#parameter-toggle').textContent(),'');
    assert.equal(await page.locator('#workspace-load').isVisible(),false,'Loaded model must not leave a redundant toolbar button');
    assert.equal(await page.locator('#workspace-load-status').isVisible(),true,'The loaded model remains visible when its task is selected');
    const before=await page.locator('.workspace-operation').boundingBox();
    await advanced(page);const after=await page.locator('.workspace-operation').boundingBox();
    assert.equal(after.width,before.width,'Model popover must not reserve a sidebar column');
    assert.equal(await page.locator('#workspace-settings').evaluate(el=>el.matches(':popover-open')),true);
    assert.equal(await page.locator('#common-options #param-speed').count(),1);
    assert.equal(await page.locator('#workspace-settings #param-speed').count(),0);
    assert.equal(await page.locator('#workspace-settings #param-load_options-threads').count(),1);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'parameter-toggle');
    assert.deepEqual(await page.locator('#app-sidebar > .main-nav [data-route]').evaluateAll(items=>items.map(item=>item.dataset.route)),['tts','asr','music','design','vc','scenarios','references','tools','models','settings']);
    assert.equal(await page.locator('#app-sidebar .nav-auxiliary [data-route]').count(),4);
    assert.equal(await page.locator('.sidebar-bottom #connection-status').count(),1);
    assert.equal(await page.locator('#server-dot').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(38, 134, 91)');
    assert.deepEqual(await page.locator('#task-setting-inputs input,#task-setting-inputs select').evaluateAll(controls=>controls.map(el=>el.dataset.inputKey||el.id)),['param-speaker','stream','language']);
    const commonBoxes=await page.locator('#common-options').evaluate(el=>['#param-speaker','[data-input-key="stream"]','[data-input-key="language"]','#param-speed'].map(selector=>{const r=el.querySelector(selector).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};}));
    for(let i=1;i<commonBoxes.length;i++){const before=commonBoxes[i-1],after=commonBoxes[i];assert.ok(after.top>=before.bottom||(before.right<after.left&&before.top<after.bottom&&after.top<before.bottom),'Common controls must keep voice, streaming, language, speed order while wrapping in the left column');}
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:900});
      const pairs=await page.locator('#common-options .field-group').evaluateAll(groups=>groups.flatMap(group=>{const label=group.querySelector('.field-label'),control=group.querySelector('input,select');if(!label||!control)return [];const a=label.getBoundingClientRect(),b=control.getBoundingClientRect();return [{inline:a.right<=b.left&&a.top<b.bottom&&b.top<a.bottom}];}));
      assert.ok(pairs.every(pair=>pair.inline),'Common labels must share a row with their controls');
      await assertBrowserScroll(page);
      await snapshot(page,`common-controls-inline-${width}`);
    }
    await page.setViewportSize({width:1440,height:1000});
    await snapshot(page,'workspace-common-options');
    await task(page,'asr','ASR One');await page.locator('#sidebar-toggle').click();
    assert.equal(await page.locator('#app-sidebar .nav-label').first().isVisible(),false);
    assert.equal(await page.locator('#app-sidebar').evaluate(el=>el.getBoundingClientRect().width),60);
    await page.locator('#sidebar-toggle').click();await page.locator('[data-route="settings"]').click();
    assert.equal(await page.locator('#parameter-toggle').isVisible(),false);
    await page.locator('[data-palette-choice="classic"]').click();
    const classic=await page.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor);
    await page.locator('[data-palette-choice="studio"]').click();
    assert.notEqual(await page.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor),classic);
    await page.locator('#theme-select').selectOption('dark');await page.reload();
    await page.waitForFunction(()=>document.documentElement.dataset.palette==='studio'&&document.documentElement.dataset.theme==='dark');
    assert.equal(await page.locator('[data-palette-choice="studio"]').getAttribute('aria-pressed'),'true');
    await page.locator('[data-palette-choice="classic"]').click();await page.locator('#theme-select').selectOption('light');
    assert.equal(await page.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor),classic);
    await page.locator('[data-settings-tab="runtime"]').click();await waitText(page,'#runtime-health','12345');
    await page.locator('[data-settings-tab="api"]').click();await waitText(page,'#api-base',ORIGIN);
    await page.locator('[data-route="models"]').click();assert.equal(await page.locator('#parameter-toggle').isVisible(),false);
    await page.locator('#model-list [data-model="tts-one"]').click();await waitText(page,'#model-detail','TTS One');
    await page.locator('[data-route="tools"]').click();assert.equal(await page.locator('#parameter-toggle').isVisible(),false);
  }],
  ['selected model metadata stays separate from the loaded model across navigation', async (page, backend) => {
    await page.locator('#model-picker-trigger').click();
    assert.equal(await page.locator('[data-load-model="tts-one"]').textContent(),'已加载');
    await page.locator('[data-model-select="tts-two"]').click();await waitText(page,'#model-picker-label','TTS Two');
    assert.equal(await page.locator('#workspace-load-status').textContent(),'任务模型 · TTS One','Selecting a different model must not mislabel the loaded model');
    assert.equal(await page.locator('#workspace-load').isVisible(),true,'A newly selected model still needs a load action');
    assert.equal(await page.locator('[data-load-model="tts-one"]').textContent(),'已加载');
    assert.equal(await page.locator('[data-load-model="tts-two"]').textContent(),'加载');
    assert.equal(await page.locator('#run-button').isDisabled(),true);
    await page.keyboard.press('Escape');await task(page,'asr');await waitText(page,'#model-picker-label','选择语音识别模型');
    await task(page,'tts');await waitText(page,'#model-picker-label','TTS Two');
    assert.equal(backend.loads.length,0);assert.equal(await page.locator('#run-button').isDisabled(),true);
    await pick(page,'tts-one');await task(page,'asr','ASR One');await task(page,'tts','TTS One');
    const gate=deferred();backend.detailGates.set('asr-one',gate);await task(page,'asr');
    assert.equal(await page.locator('#workspace-grid').isVisible(),true);
    assert.equal(await page.locator('[data-input-key="audio"]').count(),1);
    assert.equal(await page.locator('[data-input-key="text"]').count(),0);
    gate.resolve();backend.detailGates.delete('asr-one');
    await task(page,'music');await waitText(page,'#model-picker-label','选择音乐与音效模型');
    await page.locator('[data-route="tools"]').click();await page.locator('#tool-list').getByRole('button',{name:/字幕对齐/}).click();
    assert.equal(await page.locator('#task-title').textContent(),'字幕对齐');
    assert.equal(await page.locator('#page-workspace #tools-back').isVisible(),true);
    await pick(page,'align-one');await page.locator('#tools-back').click();assert.equal(await page.locator('#page-tools').isVisible(),true);
  }],
  ['hash navigation and task drafts survive browser back/forward', async (page) => {
    await page.locator('[data-input-key="text"]').fill('TTS draft survives navigation');
    await task(page, 'asr', 'ASR One');
    await page.locator('[data-input-key="context"]').fill('ASR proper-name draft');
    await page.goBack();
    await pick(page,'tts-one');
    await waitValue(page, '[data-input-key="text"]', 'TTS draft survives navigation');
    assert.equal(new URL(page.url()).hash, '#tts');
    await page.goForward();
    await pick(page,'asr-one');
    await waitValue(page, '[data-input-key="context"]', 'ASR proper-name draft');
    assert.equal(new URL(page.url()).hash, '#asr');
    await task(page, 'tts', 'TTS One');
    await waitValue(page, '[data-input-key="text"]', 'TTS draft survives navigation');
  }],
  ['model picker lists only installed models for the active task', async (page) => {
    await page.locator('#model-picker-trigger').click();
    assert.deepEqual(await page.locator('#model-picker-list [data-model]').evaluateAll(rows => rows.map(row => row.dataset.model)), ['tts-one','tts-two']);
    await page.locator('#model-picker-search').fill('Two');
    assert.equal(await page.locator('#model-picker-list [data-model]').count(), 1);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#model-picker-popover').matches(':popover-open'));
    assert.equal(await page.locator('#model-picker-trigger').getAttribute('aria-expanded'), 'false');
    await task(page, 'asr', 'ASR One');
    await page.locator('#model-picker-trigger').click();
    assert.deepEqual(await page.locator('#model-picker-list [data-model]').evaluateAll(rows => rows.map(row => row.dataset.model)), ['asr-one']);
    await page.keyboard.press('Escape');
  }],
  ['model loading keeps its button stable when selection metadata refreshes during a click', async (page, backend) => {
    const gate=deferred();backend.detailGates.set('tts-two',gate);
    await page.locator('#model-picker-trigger').click();await page.locator('[data-model-select="tts-two"]').click();
    const load=page.locator('[data-load-model="tts-two"]'),box=await load.boundingBox();
    await load.evaluate(el=>window.pendingLoadButton=el);
    await page.evaluate(()=>{window.fixtureClickTrace=[];for(const event of ['pointerdown','pointerup','click'])document.addEventListener(event,e=>window.fixtureClickTrace.push({event,target:e.target.closest('button')?.outerHTML.slice(0,400),prevented:e.defaultPrevented}),true);});
    await page.evaluate(()=>{window.selectionInputsRefreshed=false;const observer=new MutationObserver(()=>{window.selectionInputsRefreshed=true;observer.disconnect();});observer.observe(document.querySelector('#task-inputs'),{childList:true});});
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
    gate.resolve();backend.detailGates.delete('tts-two');
    await page.waitForFunction(()=>window.selectionInputsRefreshed);
    const current=await load.boundingBox();
    const point=await page.evaluate(({x,y})=>{
      const el=document.elementFromPoint(x,y);return {html:el?.outerHTML?.slice(0,350),connected:window.pendingLoadButton.isConnected,disabled:window.pendingLoadButton.disabled};
    },{x:box.x+box.width/2,y:box.y+box.height/2});
    assert.equal(point.connected,true,'Metadata replaced the load button');
    assert.equal(point.disabled,false,'Metadata disabled the load button');
    assert.ok(box.x+box.width/2>=current.x&&box.x+box.width/2<=current.x+current.width&&box.y+box.height/2>=current.y&&box.y+box.height/2<=current.y+current.height,`Metadata moved the load target away from the pointer: ${JSON.stringify({before:box,after:current,point})}`);
    backend.loadGate=deferred();await page.mouse.up();
    try{await waitUntil(()=>backend.loads.length===1,'Selection refresh swallowed the load click');}
    catch(error){throw new Error(`${error.message}: ${JSON.stringify(await page.evaluate(()=>({trace:window.fixtureClickTrace,connected:window.pendingLoadButton.isConnected,popup:document.querySelector('#model-picker-popover').matches(':popover-open'),status:document.querySelector('#workspace-load-status').textContent})))}`);}
    assert.equal(await page.evaluate(()=>window.pendingLoadButton.isConnected),true);
    assert.equal(await page.locator('#model-picker-label').textContent(),'TTS Two');
    assert.equal(await page.locator('#run-button').isDisabled(),true);
    backend.loadGate.resolve();await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
  }],
  ['unloaded detail errors and unconfirmed load responses remain retryable', async (page, backend) => {
    await page.locator('#model-picker-trigger').click();backend.detailError='tts-two';
    await page.locator('[data-load-model="tts-two"]').click();
    await waitText(page,'#model-picker-status','加载失败：Fixture detail failed');
    assert.equal(backend.loads.length,0);
    assert.equal(await page.locator('#model-picker-popover').isVisible(),false);
    await page.waitForFunction(()=>!document.querySelector('[data-load-model="tts-two"]').disabled);
    backend.detailError=null;backend.loadNoModel=true;
    await page.locator('#model-picker-trigger').click();
    await page.locator('[data-load-model="tts-two"]').click();
    await waitText(page,'#model-picker-status','尚未确认模型 tts-two 已加载');
    assert.equal(await page.locator('#workspace-grid').isVisible(),true);
    assert.equal(await page.locator('[data-load-model="tts-two"]').textContent(),'重试');
    await page.waitForFunction(()=>!document.querySelector('[data-load-model="tts-two"]').disabled);
    backend.loadNoModel=false;await page.locator('#model-picker-trigger').click();await page.locator('[data-load-model="tts-two"]').click();
    await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
  }],
  ['model dropdown previews selection without loading and explicit load uses that selection', async (page, backend) => {
    await page.locator('#model-picker-trigger').click();
    await page.locator('#model-picker-trigger').click();
    assert.equal(await page.locator('#model-picker-popover').isVisible(),false,'Trigger did not close the dropdown');
    await page.locator('#model-picker-trigger').click();
    assert.equal(await page.locator(':modal').count(),0);
    assert.equal(await page.locator('[data-model="tts-two"] .model-row-description').textContent(),'需参考音频；参考文本需与音频一致。');
    assert.equal(await page.locator('[data-load-model="tts-two"]').textContent(),'加载');
    assert.equal(await page.locator('[data-model="tts-two"] .model-row-api').textContent(),'tts-two');
    assert.equal(await page.locator('[data-model="tts-two"] .model-row-api').getAttribute('aria-label'),'API 模型名：tts-two');
    const anchor=await page.locator('#model-picker-trigger').boundingBox(),popup=await page.locator('#model-picker-popover').boundingBox();
    assert.ok(Math.abs(popup.y-anchor.y-anchor.height-8)<2,'Model list is not anchored below the trigger');
    const mainLeft=await page.locator('.main-content').evaluate(el=>el.getBoundingClientRect().left);
    assert.ok(Math.abs(popup.x-mainLeft)<2,'Model list must align with the workspace boundary beside the navigation');
    await page.locator('#model-picker-search').fill('Two');
    await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('[data-model-select="tts-two"]').getAttribute('aria-pressed')==='true');
    assert.equal(await page.locator('#model-picker-popover').isVisible(),true);
    assert.equal(await page.locator('[data-model-select="tts-two"]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('#workspace-grid').isVisible(),true);
    assert.equal(await page.locator('#workspace-start').isVisible(),false);
    assert.equal(await page.locator('#model-picker-label').textContent(),'TTS Two');
    assert.equal(await page.locator('#model-picker-heading').textContent(),'语音合成模型');
    assert.ok(!/已安装|已选择/.test(await page.locator('#model-picker-list').textContent()));
    assert.equal(backend.loads.length,0,'Selecting a row loaded the model');
    await page.locator('[data-load-model="tts-two"]').click();
    await waitText(page,'#model-picker-label','TTS Two');
    assert.equal(backend.loads.length,1);
    assert.equal(backend.loads[0].model,'tts-two');
    await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
    await page.locator('#model-picker-trigger').click();
    assert.equal(await page.locator('[data-load-model="tts-two"]').textContent(),'已加载');
    assert.equal(await page.locator('[data-load-model="tts-one"]').textContent(),'加载');
    await snapshot(page,'models-loaded');
    await page.locator('#task-title').click();
    assert.equal(await page.locator('#model-picker-popover').isVisible(),false,'Outside click did not dismiss the non-modal dropdown');
    await page.locator('[data-input-key="text"]').fill('The workspace stays interactive');
  }],
  ['task/model options stay isolated and explicit settings reload receives displayed options', async (page, backend) => {
    await page.locator('#param-speed').fill('1.25');await advanced(page);
    await waitText(page,'#apply-model-settings','应用并重载模型');
    assert.equal(await page.locator('#apply-model-settings').isVisible(),true);
    assert.equal(await page.locator('#apply-model-settings').isDisabled(),true,'Request options must not trigger a reload');
    await page.locator('#finish-model-settings').click();assert.equal(backend.loads.length,0);
    await advanced(page);
    await page.locator('#param-load_options-threads').fill('6');
    assert.equal(await page.locator('#apply-model-settings').isEnabled(),true);
    await page.locator('#param-load_options-threads').fill('');
    assert.equal(await page.locator('#apply-model-settings').isDisabled(),true,'Clearing the runtime change removes the need to reload');
    await page.locator('#param-load_options-threads').fill('6');
    await page.locator('#options-json').fill('{"temperature":0.7}');
    assert.equal(await page.locator('#run-button').isDisabled(),true);
    assert.equal(backend.loads.length,0,'Parameter edits must not silently reload');
    await page.locator('#apply-model-settings').click();await waitUntil(()=>backend.loads.length===1,'Settings did not reload explicitly');
    assert.equal(backend.loads[0].options['load_options.threads'],6);
    assert.equal(backend.loads[0].options.speed,1.25);assert.equal(backend.loads[0].options.temperature,.7);
    await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
    await advanced(page);assert.equal(await page.locator('#apply-model-settings').isDisabled(),true,'Applied settings must not prompt another reload');
    await page.locator('#finish-model-settings').click();
    await page.locator('[data-input-key="text"]').fill('已应用参数后的合成');await page.locator('#run-button').click();
    await waitUntil(()=>backend.requests.length===1,'Task after reload was not submitted');
    assert.equal(backend.loads.length,1,'Running after explicit apply must not reload again');
    assert.equal(backend.requests[0].options['load_options.threads'],6);
    backend.finish('job-1','参数已应用',['after-settings.wav']);await waitText(page,'#result-content','参数已应用');
    await pick(page,'tts-two');await advanced(page);
    await waitValue(page,'#param-speed','1');await waitValue(page,'#param-load_options-threads','4');
    await waitValue(page,'#options-json','');await page.locator('#param-speed').fill('0.85');
    await page.locator('#param-load_options-threads').fill('3');
    await page.keyboard.press('Escape');await pick(page,'tts-one');await advanced(page);
    await waitValue(page,'#param-speed','1.25');await waitValue(page,'#param-load_options-threads','6');
    await waitValue(page,'#options-json','{"temperature":0.7}');
    await page.keyboard.press('Escape');await task(page,'asr','ASR One');await advanced(page);
    await waitValue(page,'#param-load_options-threads','4');await page.locator('#param-load_options-threads').fill('2');
    await page.keyboard.press('Escape');await task(page,'tts','TTS One');await advanced(page);
    await waitValue(page,'#param-load_options-threads','6');await page.keyboard.press('Escape');
    await pick(page,'tts-two');await waitValue(page,'#param-speed','0.85');
    await task(page,'asr','ASR One');await advanced(page);await waitValue(page,'#param-load_options-threads','2');
  }],
  ['late TTS completion stays with TTS and each current result keeps every artifact', async (page, backend) => {
    await page.locator('[data-input-key="text"]').fill('First synthesis request');
    await page.locator('#run-button').click();
    await page.waitForFunction(() => !document.querySelector('#cancel-job').hidden);
    assert.equal(backend.requests.length, 1);
    await task(page, 'asr');
    assert.equal(await page.locator('#workspace-start').isVisible(),false);
    backend.finish('job-1', 'First synthesis completed', ['first.wav','alternate.wav','synthesis.json']);
    await page.waitForFunction(() => document.querySelector('#active-job-banner').hidden);
    assert.equal(await page.locator('#page-workspace').getAttribute('data-task'), 'asr');
    assert.ok(!(await page.locator('#result-content').textContent()).includes('First synthesis completed'));
    await pick(page,'asr-one');
    await task(page, 'tts', 'TTS One');
    await waitText(page, '#result-content', 'First synthesis completed');
    assert.equal(await page.locator('#result-content a[download]').count(), 3);
    assert.deepEqual(await page.locator('#result-content .artifact-name').allTextContents(), ['first.wav','alternate.wav','synthesis.json']);
    await page.locator('[data-input-key="text"]').fill('Second synthesis request');
    await page.locator('#run-button').click();
    await page.waitForFunction(() => !document.querySelector('#cancel-job').hidden);
    assert.equal(backend.requests.length, 2);
    assert.ok(!(await page.locator('#job-status').textContent()).includes('用时'),'Starting a new job must clear the previous time');
    assert.equal(await page.locator('#job-status').isVisible(),true);
    backend.finish('job-2', 'Second synthesis completed', ['second.wav']);
    await waitText(page, '#result-content', 'Second synthesis completed');
    const names = await page.locator('.result-card a[download]').allTextContents();
    assert.deepEqual(names, ['second.wav']);
    assert.ok(!(await page.locator('#result-content').textContent()).includes('First synthesis completed'));
    assert.equal(backend.requests[0].inputs.text, 'First synthesis request');
    assert.equal(backend.requests[0].model, 'tts-one');
  }],
  ['alignment and score extraction keep separate tool drafts', async (page) => {
    await page.locator('[data-route="tools"]').click();
    await page.locator('#tool-list').getByRole('button', {name:/字幕对齐/}).click();
    await pick(page,'align-one');
    await waitText(page, '#model-picker-label', 'Align One');
    assert.equal(new URL(page.url()).hash, '#tools/align');
    await page.locator('[data-input-key="transcript"]').fill('Alignment transcript belongs to alignment');
    await upload(page, 'input[type=file][data-input-key="audio"]', 'align-source.wav');
    await page.locator('#tools-back').click();
    await page.locator('#tool-list').getByRole('button', {name:/乐谱提取/}).click();
    await pick(page,'midi-one');
    await waitText(page, '#model-picker-label', 'MIDI One');
    assert.equal(new URL(page.url()).hash, '#tools/midi');
    assert.equal(await page.locator('[data-input-key="transcript"]').count(), 0);
    assert.ok(!(await page.locator('#task-inputs').textContent()).includes('align-source.wav'));
    await upload(page, 'input[type=file][data-input-key="audio"]', 'midi-source.wav');
    await page.locator('#tools-back').click();
    await page.locator('#tool-list').getByRole('button', {name:/字幕对齐/}).click();
    await pick(page,'align-one');
    await waitValue(page, '[data-input-key="transcript"]', 'Alignment transcript belongs to alignment');
    await waitText(page, '#task-inputs', 'align-source.wav');
    assert.ok(!(await page.locator('#task-inputs').textContent()).includes('midi-source.wav'));
  }],
  ['basic model parameters stay isolated and reset preserves text and audio drafts', async (page) => {
    await advanced(page);
    await page.locator('[data-input-key="text"]').fill('Keep this text when resetting parameters');
    await page.locator('#param-speaker').selectOption('voice-b');
    await page.locator('[data-input-key="language"]').selectOption('chinese');
    await page.locator('[data-input-key="seed"]').fill('42');await page.keyboard.press('Escape');
    await page.locator('[data-input-key="stream"]').check();
    await pick(page, 'tts-two');
    await waitValue(page, '#param-speaker', 'voice-a');
    await waitValue(page, '[data-input-key="language"]', '');
    await waitValue(page, '[data-input-key="seed"]', '');
    assert.equal(await page.locator('[data-input-key="stream"]').isChecked(), false);
    await page.locator('[data-input-key="language"]').selectOption('english');
    await advanced(page);await page.locator('[data-input-key="seed"]').fill('99');await page.keyboard.press('Escape');
    await pick(page, 'tts-one');
    await waitValue(page, '#param-speaker', 'voice-b');
    await waitValue(page, '[data-input-key="language"]', 'chinese');
    await waitValue(page, '[data-input-key="seed"]', '42');
    assert.equal(await page.locator('[data-input-key="stream"]').isChecked(), true);
    await advanced(page);await page.locator('#reset-options').click();await page.keyboard.press('Escape');
    await waitValue(page, '#param-speaker', 'voice-a');
    await waitValue(page, '[data-input-key="text"]', 'Keep this text when resetting parameters');
    await task(page, 'asr', 'ASR One');
    await upload(page, 'input[type=file][data-input-key="audio"]', 'keep-source.wav');
    await page.locator('[data-input-key="context"]').fill('Keep this transcription hint');
    await advanced(page);await page.locator('#reset-options').click();await page.keyboard.press('Escape');
    await waitText(page, '#task-inputs', 'keep-source.wav');
    // Recognition hints are model parameters; resetting them must keep the audio.
    await waitValue(page, '[data-input-key="context"]', '');
  }],
  ['music inputs follow capabilities and ACE route changes source-audio requirements', async (page) => {
    await task(page, 'music', 'Music One');
    assert.equal(await page.locator('[data-input-key="lyrics"]').count(), 0);
    assert.equal(await page.locator('[data-input-key="audio"]').count(), 0);
    assert.equal(await page.locator('[data-input-key="duration"]').count(), 0);
    await page.locator('[data-input-key="text"]').fill('Keep the music prompt across routes');
    await pick(page, 'music-ace');
    assert.equal(await page.locator('[data-input-key="lyrics"]').count(), 1);
    assert.equal(await page.locator('[data-input-key="duration"]').count(), 1);
    assert.equal(await page.locator('[data-input-key="audio"]').count(), 0);
    await page.locator('#param-task_route').selectOption('audio2audio');
    await page.locator('[data-input-key="audio"]').waitFor();
    assert.equal(await page.locator('[data-input-key="audio"]').getAttribute('type'), 'file');
    await waitValue(page, '[data-input-key="text"]', 'Keep the music prompt across routes');
    await page.locator('#param-task_route').selectOption('text2music');
    await page.waitForFunction(() => !document.querySelector('[data-input-key="audio"]'));
    await waitValue(page, '[data-input-key="text"]', 'Keep the music prompt across routes');
  }],
  ['slow upload responses cannot replace newer material', async (page, backend) => {
    await task(page, 'asr', 'ASR One');
    const old = backend.holdUpload('old-source.wav');
    await page.locator('input[type=file][data-input-key="audio"]').setInputFiles({name:'old-source.wav', mimeType:'audio/wav', buffer:wav(101)});
    await waitUntil(() => backend.uploads.length === 1, 'First upload did not reach fixture');
    await task(page, 'tts', 'TTS One');
    await task(page, 'asr', 'ASR One');
    await upload(page, 'input[type=file][data-input-key="audio"]', 'new-source.wav', 202);
    old.resolve();
    await page.waitForFunction(() => !document.querySelector('#run-button').disabled);
    await waitText(page, '#task-inputs', 'new-source.wav');
    assert.ok(!(await page.locator('#task-inputs').textContent()).includes('old-source.wav'));
  }],
  ['microphone permission resolved after navigation stops the stream without recording', async (page, backend) => {
    await page.evaluate(() => {
      window.__mic = {requested:0, stopped:0, started:0};
      const stream = {getTracks:() => [{stop:() => {window.__mic.stopped++;}}]};
      navigator.mediaDevices.getUserMedia = () => {
        window.__mic.requested++;
        return new Promise(resolve => {window.__resolveMic = () => resolve(stream);});
      };
      window.MediaRecorder = class extends EventTarget {
        static isTypeSupported() {return true;}
        constructor() {super(); this.state = 'inactive'; this.mimeType = 'audio/webm';}
        start() {this.state = 'recording'; window.__mic.started++;}
        stop() {this.state = 'inactive'; this.dispatchEvent(new Event('stop'));}
      };
    });
    await task(page, 'asr', 'ASR One');
    await page.locator('#task-inputs').getByRole('button', {name:'录音'}).click();
    await page.waitForFunction(() => window.__mic.requested === 1);
    await task(page, 'tts', 'TTS One');
    await page.evaluate(() => window.__resolveMic());
    await page.waitForFunction(() => window.__mic.stopped > 0);
    assert.equal(await page.evaluate(() => window.__mic.started), 0);
    assert.equal(await page.locator('#recording-banner').isVisible(), false);
    assert.equal(backend.uploads.length, 0);
  }],
  ['ASR submission keeps its original audio when draft changes before job acknowledgment', async (page, backend) => {
    await task(page, 'asr', 'ASR One');
    await upload(page, 'input[type=file][data-input-key="audio"]', 'submitted-source.wav', 101);
    backend.submitGate = deferred();
    await page.locator('#run-button').click();
    await waitUntil(() => backend.requests.length === 1, 'ASR job was not submitted');
    await upload(page, 'input[type=file][data-input-key="audio"]', 'next-draft.wav', 202);
    backend.submitGate.resolve();
    await page.waitForFunction(() => !document.querySelector('#cancel-job').hidden);
    backend.finish('job-1', 'Original audio transcript', []);
    await waitText(page, '#result-content', 'Original audio transcript');
    assert.equal(backend.requests[0].inputs.audio, 'upload-1');
    assert.equal(await page.locator('#result-content audio').count(),0,'ASR must not duplicate the input audio in its text result');
    await waitText(page, '#task-inputs', 'next-draft.wav');
  }],
  ['TTS output waveform appears with playback and seeks through the generated audio', async (page, backend) => {
    const audio=wav();
    for(let i=0;i<1600;i++)audio.writeInt16LE(Math.round(24000*Math.sin(i*.12)*(.15+.85*i/1600)),44+i*2);
    await page.route(`${ORIGIN}${API}/files/job-1-0`,route=>{
      const range=route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
      const start=range?Number(range[1]):0,end=range?.[2]?Math.min(Number(range[2]),audio.length-1):audio.length-1;
      const headers={'accept-ranges':'bytes','content-length':String(end-start+1)};
      if(range)headers['content-range']=`bytes ${start}-${end}/${audio.length}`;
      return route.fulfill({status:range?206:200,headers,contentType:'audio/wav',body:audio.subarray(start,end+1)});
    });
    assert.equal(await page.locator('#result-content .waveform-panel').count(),0);
    await page.locator('[data-input-key="text"]').fill('生成后显示音频声波。');
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'TTS waveform request was not submitted');
    backend.finish('job-1','',['waveform-result.wav']);
    await page.locator('#result-content .audio-waveform').waitFor({state:'visible'});
    assert.equal(await page.getByRole('button',{name:'显示波形',exact:true}).count(),0,'Output waveform must load without another click');
    assert.equal(await page.locator('#result-content audio').isVisible(),true);
    const waveform=await page.locator('#result-content .audio-waveform').evaluate(canvas=>{
      const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      const box=canvas.getBoundingClientRect(),audio=document.querySelector('#result-content audio').getBoundingClientRect();
      return {painted:pixels.filter((value,index)=>index%4===3&&value>0).length,below:box.top>=audio.bottom};
    });
    assert.ok(waveform.painted>3000&&waveform.below,'Real sample peaks must render below the playback bar');
    const canvas=page.locator('#result-content .audio-waveform'),bounds=await canvas.boundingBox();
    await canvas.click({position:{x:bounds.width*.6,y:bounds.height/2}});
    await page.waitForFunction(()=>{const audio=document.querySelector('#result-content audio');return Math.abs(audio.currentTime/audio.duration-.6)<.03;});
    await snapshot(page,'tts-waveform-result');
    await pick(page,'tts-two');assert.equal(await page.locator('#result-content .waveform-panel').count(),0,'Changing models must discard the previous waveform');
  }],
  ['separation result waveform groups keep labels outside and align players at every width', async (page, backend) => {
    const audio=wav();
    for(let sample=0;sample<1600;sample++)audio.writeInt16LE(Math.round(24000*Math.sin(sample*.12)*(.15+.85*sample/1600)),44+sample*2);
    await page.route(`${ORIGIN}${API}/files/*`,route=>{
      const range=route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
      const start=range?Number(range[1]):0,end=range?.[2]?Math.min(Number(range[2]),audio.length-1):audio.length-1;
      const headers={'accept-ranges':'bytes','content-length':String(end-start+1)};
      if(range)headers['content-range']=`bytes ${start}-${end}/${audio.length}`;
      return route.fulfill({status:range?206:200,headers,contentType:'audio/wav',body:audio.subarray(start,end+1)});
    });
    backend.models.push(model('separation-one','Separation One','separation','sep',{parameters:[]}));
    await page.locator('[data-route="models"]').click();await page.locator('#refresh-catalog').click();
    await page.locator('[data-route="tools"]').click();
    await page.locator('#tool-list').getByRole('button',{name:/^音源分离 /}).click();
    await pick(page,'separation-one');
    await upload(page,'[data-input-key="audio"]','source.wav',16000);
    for(const count of [1,6]){
      const jobNumber=backend.requests.length+1;
      await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===jobNumber,'Separation request missing');
      const names=['drums','bass','other','vocals','guitar','piano'].slice(0,count).map(name=>`audiocpp_sep_1792160309945_${name}.wav`);
      backend.finish(`job-${jobNumber}`,'',names);
      await page.waitForFunction(count=>document.querySelectorAll('#result-content .result-files .audio-waveform').length===count,count);
      assert.deepEqual(await page.locator('#result-content .result-files .artifact-heading a').allTextContents(),names);
      for(const width of [1440,390]){
        await page.setViewportSize({width,height:1000});
        const layouts=await page.locator('#result-content .result-files .separation-track').evaluateAll(tracks=>tracks.map(track=>{
          const group=track.querySelector('.separation-audio-group'),heading=track.querySelector('.artifact-heading');
          const player=group.querySelector('audio'),audio=player.getBoundingClientRect(),wave=group.querySelector('canvas').getBoundingClientRect();
          return {controls:player.controls,width:audio.width,height:audio.height,below:wave.top>=audio.bottom,aligned:Math.abs(audio.left-wave.left)<1&&Math.abs(audio.width-wave.width)<1,labelOutside:!group.contains(heading)&&heading.getBoundingClientRect().bottom<=group.getBoundingClientRect().top,border:parseFloat(getComputedStyle(group).borderTopWidth)};
        }));
        assert.equal(layouts.length,count);
        assert.ok(layouts.every(layout=>layout.controls&&layout.width>=240&&layout.height>=30&&layout.below&&layout.aligned&&layout.labelOutside&&layout.border>0),JSON.stringify(layouts));
        assert.equal(await page.locator('#result-content .waveform-position:visible, #result-content .waveform-time:visible').count(),0);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
        await snapshot(page,`separation-waveform-groups-${count}-${width}`);
      }
      const canvas=page.locator('#result-content .result-files .audio-waveform').first();
      await canvas.click({position:{x:100,y:10}});
      await page.waitForFunction(()=>document.querySelector('#result-content .result-files audio').currentTime>0);
      await page.setViewportSize({width:1440,height:1000});
    }
  }],
  ['separation upload waveform appears below audio and updates on replacement', async (page) => {
    await page.locator('[data-route="tools"]').click();
    await page.locator('#tool-list').getByRole('button',{name:/^音源分离 /}).click();
    await upload(page,'[data-input-key="audio"]','source.wav',16000);
    const canvas=page.locator('#task-inputs .audio-waveform');
    await canvas.waitFor({state:'visible'});
    const before=await canvas.evaluate(element=>element.toDataURL());
    assert.equal(await page.locator('#task-inputs .waveform-position:visible, #task-inputs .waveform-time:visible').count(),0);
    assert.ok(await canvas.evaluate(element=>element.getBoundingClientRect().top>=document.querySelector('#task-inputs audio').getBoundingClientRect().bottom));
    await upload(page,'[data-input-key="audio"]','replacement.wav',1000);
    await page.waitForFunction(before=>{
      const canvas=document.querySelector('#task-inputs .audio-waveform');
      return canvas&&canvas.toDataURL()!==before;
    },before);
    assert.equal(await page.locator('#task-inputs .waveform-panel').count(),1);
    await canvas.click({position:{x:100,y:20}});
    await page.waitForFunction(()=>document.querySelector('#task-inputs audio').currentTime>0);
  }],
  ['waveform preview stays hidden while uploaded audio remains playable and replaceable', async (page) => {
    await task(page, 'vc', 'Voice conversion');
    await page.locator('[data-input-key="audio"]').setInputFiles({name:'waveform.wav', mimeType:'audio/wav', buffer:wav(2000)});
    await page.waitForFunction(()=>document.querySelector('#task-inputs audio')?.readyState>=1);
    assert.equal(await page.getByRole('button',{name:'显示波形',exact:true}).count(),0);
    assert.equal(await page.locator('.waveform-panel').count(),0);
    const audio=page.locator('#task-inputs audio').first();
    assert.equal(await audio.isVisible(),true);
    assert.equal(await audio.evaluate(el=>el.controls),true);
    await audio.evaluate(el=>el.currentTime=.05);
    await page.waitForFunction(() => Math.abs(document.querySelector('#task-inputs audio').currentTime - .05) < .001);
    const original=await audio.getAttribute('src');
    await upload(page,'[data-input-key="audio"]','replacement.wav',1000);
    assert.notEqual(await audio.getAttribute('src'),original);
    assert.equal(await page.locator('#task-inputs .waveform-panel').count(),0);
    assert.equal(await audio.isVisible(),true);
  }],
  ['workspace and model popovers fit regular and narrow screens in both palettes and themes', async (page, backend) => {
    for(const palette of ['classic','studio'])for(const theme of ['light','dark']){
      await page.evaluate(({palette,theme})=>{document.documentElement.dataset.palette=palette;document.documentElement.dataset.theme=theme;},{palette,theme});
      for(const width of [1440,1366,1024,390,320]){
        await page.setViewportSize({width,height:900});
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${palette}/${theme}/${width} horizontal overflow`);
        assert.equal(await page.locator('#workspace-settings').isVisible(),false);
        assert.equal(await page.locator('#task-title, #model-picker-trigger, #parameter-toggle').evaluateAll(items=>items.every(item=>!item.closest('.card'))),true);
        await snapshot(page,`workspace-${palette}-${theme}-${width}`);
        await page.locator('#model-picker-trigger').click();
        assert.ok(await page.locator('#model-picker-popover').evaluate(el=>{const box=el.getBoundingClientRect();return box.left>=0&&box.right<=innerWidth;}),'Model picker leaves viewport');
        await page.keyboard.press('Escape');await advanced(page);
        assert.ok(await page.locator('#workspace-settings').evaluate(el=>{const box=el.getBoundingClientRect();return box.left>=0&&box.right<=innerWidth&&box.top>=0&&box.bottom<=innerHeight+1;}),'Model settings leave viewport');
        await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'parameter-toggle');
      }
    }
  }],
  ['model settings light-dismiss and navigation drawer restore focus on narrow screens', async (page, backend) => {
    await page.setViewportSize({width:390,height:844});assert.equal(await page.locator('#workspace-settings').isVisible(),false);
    await advanced(page);assert.equal(await page.locator('#parameter-toggle').getAttribute('aria-expanded'),'true');
    await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'parameter-toggle');
    assert.equal(await page.locator('#parameter-toggle').getAttribute('aria-expanded'),'false');
    await advanced(page);await page.locator('#parameter-toggle').click();
    assert.equal(await page.locator('#workspace-settings').isVisible(),false);
    await advanced(page);await page.locator('#task-title').click();assert.equal(await page.locator('#workspace-settings').isVisible(),false);
    await page.locator('#sidebar-toggle').click();assert.equal(await page.locator('#sidebar-backdrop').isVisible(),true);
    for(let index=0;index<18;index++){
      await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id==='sidebar-toggle'||document.querySelector('#app-sidebar').contains(document.activeElement)),true,'Sidebar drawer allowed Tab to leave');
    }
    await page.locator('#sidebar-backdrop').click({position:{x:380,y:100}});
    assert.equal(await page.locator('#sidebar-backdrop').isVisible(),false);
    assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'),'false');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  }],
];

if(process.env.AUDIOCPP_BROWSER_MODEL_METADATA)cases.push(['desktop review with actual model input contracts',async(page,backend)=>{
  const entries=JSON.parse(await fs.readFile(process.env.AUDIOCPP_BROWSER_MODEL_METADATA,'utf8'));
  backend.models.push(...entries.map(entry=>({...entry,installed:true})));
  backend.voices.push({name:'desktop-reference.wav',label:'纪录片男声',text:'在这片土地上，每一次日出，都是一个新的开始。',url:`${API}/references/desktop-reference.wav/audio`});
  await page.locator('[data-route="references"]').click();await page.locator('[data-route="models"]').click();await page.locator('#refresh-catalog').click();
  await page.setViewportSize({width:1366,height:768});
  const failures=[];
  for(const entry of entries){
    try{
    const toolLabels={processing:'音频处理',separation:'音源分离',vad:'语音片段检测',diar:'说话人区分',turn:'说完检测',align:'字幕对齐',midi:'乐谱提取'};
    const tool=toolLabels[entry.task==='analysis'?entry.model_task:entry.task];
    if(tool){await page.locator('[data-route="tools"]').click();await page.locator('#tool-list').getByRole('button',{name:new RegExp(`^${tool} `)}).click();}
    else await task(page,entry.task);
    await pick(page,entry.id);
    if(entry.task==='music'&&entry.id==='ace-step')await page.locator('#param-task_route').selectOption('cover');
    if(await page.locator('[data-input-key="instruct"]').count())await page.locator('[data-input-key="instruct"]').fill('温暖、沉稳的成年男声，语气自然，适合纪录片旁白。');
    if(await page.locator('[data-input-key="text"]').count())await page.locator('[data-input-key="text"]').fill(entry.task==='music'?(entry.music_inputs.text_role==='lyrics'?'[Verse]\n晚风吹过街角\n灯光落在你的肩膀\n[Chorus]\n让我们沿着河流去远方':entry.music_inputs.text_role==='instruction'?'保留原曲旋律，把主奏乐器改为钢琴。':'温暖的原声流行，钢琴与木吉他，轻快而舒缓。'):'在这片土地上，每一次日出，都是一个新的开始。\n我们沿着河流，寻找那些被时间珍藏的故事。');
    if(await page.locator('#param-tags').count())await page.locator('#param-tags').fill('acoustic pop, warm, piano, female vocals');
    if(await page.locator('[data-input-key="lyrics"]').count())await page.locator('[data-input-key="lyrics"]').fill('[Verse]\n晚风吹过街角\n灯光落在你的肩膀\n[Chorus]\n让我们沿着河流去远方');
    if(await page.locator('[data-input-key="transcript"]').count())await page.locator('[data-input-key="transcript"]').fill('在这片土地上，每一次日出，都是一个新的开始。\n我们沿着河流，寻找那些被时间珍藏的故事。');
    if(entry.task==='separation'&&await page.locator('[data-input-key="text"]').count())await page.locator('[data-input-key="text"]').fill('提取录音中的说话声，排除背景音乐。');
    if(await page.locator('[data-input-key="audio"]').count())await upload(page,'#task-form [data-input-key="audio"]','source-audio.wav');
    if(await page.locator('[data-input-key="builtin_voice"]').count())await page.locator('[data-input-key="builtin_voice"]').selectOption('desktop-reference.wav');
    if(entry.task==='design')assert.equal(await page.locator('#task-form [data-input-key="voice"]').count(),0,'Voice design must match the local text-plus-description request');
    if(entry.id==='rvc'){
      for(const [key,name,toggleKey] of [['rvc_voice_model','voice.pth','rvc_use_builtin'],['rvc_retrieval_index','voice.index','rvc_no_index']]){
        await page.locator(`[data-input-key="${key}"]`).setInputFiles({name,mimeType:'application/octet-stream',buffer:Buffer.from('fixture')});
        await page.waitForFunction(key=>!document.querySelector(`[data-input-key="${key}"]`).checked,toggleKey);
        await page.locator(`[data-input-key="${toggleKey}"]`).check();
        assert.equal(await page.locator(`[data-input-key="${toggleKey}"]`).isVisible(),true);
      }
    }
    assert.equal(await page.locator('#job-status').isVisible(),false);
    if(tool){
      const layout=await page.evaluate(()=>{
        const rect=selector=>document.querySelector(selector).getBoundingClientRect();
        const inputs=rect('#task-inputs'),action=rect('.task-action-bar'),result=rect('.result-card'),operation=rect('.workspace-operation');
        return {inputGap:action.top-inputs.bottom,resultGap:result.top-action.bottom,bottomGap:operation.bottom-result.bottom};
      });
      assert.ok(layout.inputGap>=0&&layout.inputGap<=20,`${entry.id}: stretched input gap ${JSON.stringify(layout)}`);
      assert.ok(layout.resultGap>=0&&layout.resultGap<=20,`${entry.id}: detached result ${JSON.stringify(layout)}`);
      // Short pages retain natural space below results; only containment is required.
      assert.ok(layout.bottomGap>=-1,`${entry.id}: result extends outside operation ${JSON.stringify(layout)}`);
      assert.equal(await page.locator('#task-form button.upload-clear').count(),0,'Workspace audio is replaced through upload or recording');
    }
    await assertVisibleControl(page,'#run-button',`${entry.id}: run action clipped`);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${entry.id}: horizontal overflow`);
    // Toast timing is covered by the interaction cases; hide it for the catalog gallery.
    await page.locator('#toast').evaluate(element=>{element.hidden=true;});
    await page.evaluate(()=>window.scrollTo(0,0));await snapshot(page,`desktop-${entry.id}`);
    if(entry.task==='design'){
      await advanced(page);await page.locator('.model-settings-content').evaluate(el=>el.scrollTop=0);
      await snapshot(page,`settings-${entry.id}`);await page.keyboard.press('Escape');
    }
    console.log(`MODEL PASS ${entry.id}`);
    }catch(error){
      failures.push(`${entry.id}: ${error.stack||error}`);
      await snapshot(page,`desktop-${entry.id}-failure`);
      console.log(`MODEL FAIL ${entry.id}: ${error.message}`);
    }
  }
  assert.deepEqual(failures,[],`Actual model input contracts failed:\n${failures.join('\n')}`);
}]);

cases.push(['home startup, logo navigation, running models and quick access',async(page,backend)=>{
  backend.status.hardware={backend:'cuda',vram_gb:8,name:'NVIDIA GeForce RTX 4060 Laptop GPU'};
  backend.status.asr={model:'asr-one',managed:true};
  await page.goto(ORIGIN+'/');
  await page.locator('#page-home').waitFor({state:'visible'});
  await waitText(page,'#home-hardware','RTX 4060');
  await waitText(page,'#home-resident-list','TTS One');
  await waitText(page,'#home-resident-list','ASR One');
  assert.equal(await page.locator('#home-version').textContent(),'browser-fixture');
  assert.equal(await page.locator('#home-resident-heading').textContent(),'当前运行的模型');
  assert.equal(await page.locator('#page-home canvas').count(),0);
  assert.deepEqual(await page.locator('.home-shortcut .tool-card-title').allTextContents(),['实时语音聊天','视频翻译配音']);
  await snapshot(page,'home-desktop');
  for(const route of ['tts','asr','music','design','vc','tools','models','references','scenarios','settings']){
    await page.locator(`[data-route="${route}"]`).click();
    const workspace=['tts','asr','music','design','vc'].includes(route);
    assert.equal(await page.locator(workspace?'#workspace-load-status':'#global-model-status').isVisible(),true,route);
    if(!workspace)await waitText(page,'#global-model-status','TTS One');
    assert.equal(await page.locator(workspace?'#workspace-load-status':'#global-model-status').evaluate(el=>getComputedStyle(el).color),await page.locator('#server-dot').evaluate(el=>getComputedStyle(el).backgroundColor),`${route}: loaded task model should be green`);
  }
  await page.locator('.brand').click();await page.locator('#page-home').waitFor({state:'visible'});
  await page.locator('.home-shortcut[data-route="scenarios/realtime-chat"]').click();
  await page.locator('#page-realtime').waitFor({state:'visible'});
  assert.equal(new URL(page.url()).hash,'#scenarios/realtime-chat');
  await page.evaluate(()=>{location.hash='home';});await page.locator('#page-home').waitFor({state:'visible'});
  const originalRoute=backend.route;
  backend.route=route=>new URL(route.request().url()).pathname===`${API}/scenarios/capabilities`
    ?route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({asr_models:[],tts_models:[]})}):originalRoute(route);
  const capabilities=page.waitForResponse(response=>new URL(response.url()).pathname===`${API}/scenarios/capabilities`);
  await page.locator('.home-shortcut[data-route="scenarios/video-dubbing"]').click();await capabilities;
  await page.locator('#page-scenario-studio [data-scene-step="import"]').waitFor({state:'visible'});
  assert.equal(new URL(page.url()).hash,'#scenarios/video-dubbing');
  await page.locator('.brand').click();await page.locator('#page-home').waitFor({state:'visible'});backend.route=originalRoute;
  assert.equal(backend.loads.length,0,'Homepage and navigation must never load models');
  await page.setViewportSize({width:390,height:844});await snapshot(page,'home-mobile');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.emulateMedia({colorScheme:'dark'});await page.evaluate(()=>{localStorage.setItem('audiocpp-workbench-theme','dark');});
  await page.reload();await page.locator('#page-home').waitFor({state:'visible'});await snapshot(page,'home-dark-mobile');
  backend.status.server.model=null;backend.status.asr={model:null};await page.reload();
  await waitText(page,'#home-service','本地服务在线');await waitText(page,'#home-resident-list','尚未加载模型');
  assert.equal(await page.locator('#home-resident-list').textContent(),'尚未加载模型');
}]);

cases.push(['model-specific common controls are rebuilt on every selection',async(page,backend)=>{
  const asr=backend.models.find(m=>m.id==='asr-one');asr.languages=['en'];asr.asr_inputs={context:false,details:true,dialogue:true};
  await task(page,'asr');await pick(page,'asr-one');
  assert.equal(await page.locator('#common-options [data-input-key="language"]').count(),0);
  assert.equal(await page.locator('#common-options [data-input-key="context"]').count(),0);
  assert.equal(await page.locator('#common-options [data-input-key="stream"]').count(),0);
  await task(page,'tts');await pick(page,'tts-one');
  assert.equal(await page.locator('#common-options [data-input-key="language"]').count(),1);
  assert.equal(await page.locator('#common-options [data-input-key="detailed"]').count(),0);
  Object.assign(backend.models.find(m=>m.id==='tts-two'),{languages:['japanese'],streaming:false,parameters:[]});
  await pick(page,'tts-two');
  assert.deepEqual(await page.locator('#common-options [data-input-key="language"] option').allTextContents(),['自动','日语']);
  assert.equal(await page.locator('#common-options [data-input-key="stream"]').count(),0);
  await page.locator('[data-input-key="language"]').selectOption('japanese');
  await page.locator('[data-input-key="text"]').fill('単一言語のモデル');await page.locator('#run-button').click();
  await waitUntil(()=>backend.requests.length===1,'Single-language TTS did not submit');
  assert.equal(backend.requests[0].inputs.language,'japanese');assert.equal(backend.requests[0].inputs.stream,undefined);
  backend.finish('job-1','',['japanese.wav']);await waitText(page,'#job-status','japanese.wav');
  await pick(page,'tts-one');
  backend.models.find(m=>m.id==='tts-two').languages=[];await pick(page,'tts-two');
  assert.equal(await page.locator('#common-options [data-input-key="language"]').count(),0,'Models without a language option must not expose a generic selector');
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===2,'Default-language TTS did not submit');
  assert.equal(backend.requests[1].inputs.language,undefined,'Model default must not send an unsupported language');
  backend.finish('job-2','',['default.wav']);await waitText(page,'#job-status','default.wav');
  await task(page,'asr');
  assert.equal(await page.locator('#common-options [data-input-key="language"]').count(),0);
  assert.equal(await page.locator('#common-options #param-speaker').count(),0);
}]);

cases.push(['IndexTTS emotion controls stay beside generation with one language and visible result seed',async(page,backend)=>{
  const labels={emotion_text:'情感描述',emotion_alpha:'情感强度',use_emotion_text:'从朗读文本推断情感',duration_factor:'时长倍率',interval_silence_ms:'句间停顿'};
  const parameters=presetParameters('index_tts2').map(p=>({...p,label:labels[p.name]||p.label,level:Object.hasOwn(labels,p.name)?'effect':'expert'}));
  Object.assign(backend.models.find(m=>m.id==='tts-two'),{family:'index_tts2',label:'IndexTTS2',parameters,
    streaming:false,voice_mode:'reference',profile:{accepts_voice_reference:true,require_voice:true,send_reference_text:false,send_seed:true,send_max_tokens:false}});
  await page.setViewportSize({width:1366,height:768});await pick(page,'tts-two');
  const emptyPlayers=page.locator('.reference-library-fields audio,.reference-upload-fields audio');
  assert.equal(await emptyPlayers.count(),2);
  assert.ok(await emptyPlayers.evaluateAll(items=>items.every(el=>!el.hasAttribute('src')&&el.getAttribute('aria-disabled')==='true')),'Models without transcripts must retain their unavailable reference players');
  assert.equal(await page.locator('.reference-library-fields audio').isVisible(),true);
  assert.equal(await page.locator('.reference-upload-fields audio').isVisible(),false);
  for(const name of Object.keys(labels))assert.equal(await page.locator(`#common-options #param-${name}`).count(),1,name);
  assert.equal(await page.locator('#param-lang').count(),0);
  assert.equal(await page.locator('[data-input-key="language"]').count(),1);
  await page.locator('#param-emotion_text').fill('开心又激动，带着期待');
  await page.locator('#param-emotion_alpha').fill('0.7');
  await page.locator('[data-input-key="language"]').selectOption('chinese');
  await page.locator('[data-input-key="text"]').fill('终于等到你了，今天真是个好日子。');
  await referenceMore(page);
  await upload(page,'#task-form [data-input-key="voice"]','reference.wav');
  await advanced(page);
  assert.equal(await page.locator('#workspace-settings #param-lang,#workspace-settings [data-input-key="language"],#workspace-settings #param-emotion_text').count(),0);
  await page.locator('[data-input-key="seed"]').fill('42');await page.keyboard.press('Escape');
  for(const selector of ['#param-emotion_text','#param-emotion_alpha','#run-button'])await assertVisibleControl(page,selector,'IndexTTS common control clipped');
  await snapshot(page,'index-tts-common-controls');
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'IndexTTS did not submit');
  assert.equal(backend.requests[0].options.emotion_text,'开心又激动，带着期待');
  assert.equal(backend.requests[0].options.emotion_alpha,0.7);
  assert.equal(backend.requests[0].inputs.language,'chinese');assert.equal(backend.requests[0].inputs.seed,42);
  assert.equal(backend.requests[0].options.lang,undefined);
  backend.finish('job-1','',['emotion.wav']);backend.jobs.get('job-1').message='生成完成，用时 2.3s。随机种子：42';
  await waitText(page,'#job-status','随机种子：42');await waitText(page,'#job-status','emotion.wav');
  await snapshot(page,'index-tts-result-seed');
  await page.locator('#toast').waitFor({state:'hidden'});
  await page.setViewportSize({width:390,height:844});
  for(const selector of ['#param-emotion_text','#param-emotion_alpha','#run-button'])await assertVisibleControl(page,selector,'Narrow IndexTTS control clipped');
  await assertBrowserScroll(page);await snapshot(page,'index-tts-mobile');
  await page.setViewportSize({width:1366,height:768});await pick(page,'tts-one');assert.equal(await page.locator('#param-emotion_text').count(),0);
  await pick(page,'tts-two');await waitValue(page,'#param-emotion_text','开心又激动，带着期待');
}]);

cases.push(['dedicated music and ASR inputs remove duplicate model settings',async(page,backend)=>{
  Object.assign(backend.models.find(m=>m.id==='music-one'),{family:'minimax_music3',
    profile:{send_seed:true},music_inputs:{duration:true,duration_default:20,duration_min:1},parameters:[
      {name:'duration_sec',label:'时长',type:'number',default:20,level:'effect',scope:'request'},
      {name:'seed',label:'随机种子',type:'int',default:0,level:'expert',scope:'request'},
      {name:'temperature',label:'采样温度',type:'number',default:1,level:'expert',scope:'request'}]});
  await task(page,'music');await pick(page,'music-one');
  assert.equal(await page.locator('#common-options [data-input-key="duration"]').count(),1);
  assert.equal(await page.locator('#param-duration_sec,#param-seed').count(),0);
  await advanced(page);assert.equal(await page.locator('[data-input-key="seed"]').count(),1);
  assert.equal(await page.locator('#expert-controls #param-temperature').count(),1);await page.keyboard.press('Escape');
  backend.models.find(m=>m.id==='asr-one').parameters=[{name:'instruct',label:'音频指令',type:'text',level:'effect',scope:'request'}];
  await task(page,'asr');await pick(page,'asr-one');
  assert.equal(await page.locator('[data-input-key="context"]').count(),1);
  assert.equal(await page.locator('#param-instruct').count(),0);
}]);

cases.push(['UI updates keep model settings aligned and close both popovers as loading starts',async(page,backend)=>{
  const entry=backend.models.find(item=>item.id==='tts-one');
  entry.parameters.push(...Array.from({length:6},(_,i)=>({name:`extra_${i}`,label:`高级设置 ${i+1}`,type:'number',default:i,level:'expert',scope:'request'})));
  await pick(page,'tts-one');await advanced(page);
  for(const width of [1440,1024,768,390,320]){
    await page.setViewportSize({width,height:900});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const layout=await page.locator('#workspace-settings').evaluate(el=>{
      const box=el.getBoundingClientRect(),fields=[...el.querySelectorAll('#expert-controls input[id^="param-extra_"]')].map(input=>{const r=input.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width};});
      return {left:box.left,right:box.right,width:box.width,fields,columns:getComputedStyle(el.querySelector('#expert-controls')).gridTemplateColumns.split(' ').length};
    });
    assert.ok(layout.left>=0&&layout.right<=width+1);assert.equal(layout.columns,width>560?2:1);
    if(width>560){assert.ok(Math.abs(layout.fields[0].y-layout.fields[1].y)<2,'Paired settings must align');assert.ok(Math.abs(layout.fields[0].width-layout.fields[1].width)<2);}
    await assertVisibleControl(page,'#apply-model-settings','Settings footer is clipped');await assertBrowserScroll(page);await snapshot(page,`model-settings-grid-${width}`);
  }
  await page.setViewportSize({width:1440,height:1000});await page.locator('#param-load_options-threads').fill('6');
  backend.loadGate=deferred();await page.locator('#apply-model-settings').click();
  await waitUntil(()=>backend.loads.length===2,'Settings reload did not start');
  assert.equal(await page.locator('#workspace-settings').isVisible(),false,'Settings must close before reload completes');
  assert.equal(await page.locator('#workspace-load-status').getAttribute('data-state'),'loading');
  backend.loadGate.resolve();await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
  backend.loadGate=deferred();await page.locator('#model-picker-trigger').click();await page.locator('[data-load-model="tts-two"]').click();
  await waitUntil(()=>backend.loads.length===3,'Model load did not start');
  assert.equal(await page.locator('#model-picker-popover').isVisible(),false,'Picker must close before loading completes');
  backend.loadGate.resolve();await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
}]);

cases.push(['UI updates separate warning link colors and discard results when changing model',async(page,backend)=>{
  await page.locator('[data-input-key="text"]').fill('保留输入草稿');await page.locator('#run-button').click();
  await waitUntil(()=>backend.requests.length===1,'Synthesis did not start');backend.finish('job-1','',['warning-result.wav']);
  Object.assign(backend.jobs.get('job-1'),{status:'error',message:'音频生成不完整，请检查参数'});
  await waitText(page,'#job-status','音频生成不完整');await page.locator('#job-status a[download]').waitFor();
  for(const theme of ['light','dark'])for(const palette of ['classic','studio']){
    await page.evaluate(({theme,palette})=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.palette=palette;},{theme,palette});
    const colors=await page.locator('#job-status').evaluate(el=>({message:getComputedStyle(el).color,link:getComputedStyle(el.querySelector('a')).color}));
    assert.notEqual(colors.message,colors.link,`${theme}/${palette}: warning colors leaked into the download link`);
    await snapshot(page,`result-warning-link-${theme}-${palette}`);
  }
  const gate=deferred();backend.detailGates.set('tts-two',gate);
  await page.locator('#model-picker-trigger').click();await page.locator('[data-model-select="tts-two"]').click();
  assert.equal(await page.locator('#job-status').isVisible(),false);assert.equal(await page.locator('.result-card a[download],.result-card audio').count(),0);
  assert.equal(await page.locator('#result-content').textContent(),'');
  gate.resolve();backend.detailGates.delete('tts-two');await page.locator('#parameter-toggle').waitFor();await page.keyboard.press('Escape');
  await page.locator('#model-picker-trigger').click();await page.locator('[data-model-select="tts-one"]').click();await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
  assert.equal(await page.locator('#job-status').isVisible(),false);assert.equal(await page.locator('[data-input-key="text"]').inputValue(),'保留输入草稿');
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===2,'Second synthesis did not start');
  await page.locator('#model-picker-trigger').click();await page.locator('[data-model-select="tts-two"]').click();await page.keyboard.press('Escape');
  assert.equal(await page.locator('#active-job-banner').isVisible(),true,'Hidden running result must keep a task recovery entry');
  await page.locator('#return-active-job').click();await page.locator('#cancel-job').waitFor();
  assert.equal(await page.locator('#model-picker-label').textContent(),'TTS One');
  await page.locator('#model-picker-trigger').click();await page.locator('[data-model-select="tts-two"]').click();await page.keyboard.press('Escape');
  backend.finish('job-2','旧模型迟到的结果',['late-old-model.wav']);await page.waitForFunction(()=>!document.querySelector('#workspace-load').disabled);
  assert.equal(await page.locator('#job-status').isVisible(),false);assert.equal(await page.locator('.result-card a[download],.result-card audio').count(),0);
  assert.equal(await page.locator('#result-content').textContent(),'');
  await pick(page,'tts-one');backend.submitGate=deferred();await page.locator('#run-button').click();
  await waitUntil(()=>backend.requests.length===3,'Pending synthesis did not submit');
  await page.locator('#model-picker-trigger').click();await page.locator('[data-model-select="tts-two"]').click();
  await page.locator('[data-model-select="tts-one"]').click();await page.keyboard.press('Escape');
  assert.equal(await page.locator('#job-status').isVisible(),false);
  backend.submitGate.resolve();await waitUntil(()=>backend.jobs.has('job-3'),'Pending task did not acknowledge');
  backend.finish('job-3','切换前提交的结果',['late-ack.wav']);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
  assert.equal(await page.locator('#job-status').isVisible(),false);assert.equal(await page.locator('#result-content').textContent(),'');
}]);

cases.push(['parameter migration keeps explicit defaults and model-specific zero limits',async(page,backend)=>{
  backend.models.push(model('migration-h3','Migration H3','music','gen',{
    family:'minimax_h3',music_inputs:{duration:false,source_audio:false,lyrics:false},
    profile:{send_seed:true,default_options:{height:32,width:32}},
    parameters:[{name:'height',type:'number',label:'高度',default:32,minimum:32,level:'expert',scope:'request'},
      {name:'width',type:'number',label:'宽度',default:32,minimum:32,level:'expert',scope:'request'}]}));
  backend.models.push(model('migration-tts','Migration TTS','tts','tts',{
    max_tokens_min:0,profile:{accepts_voice_reference:false,send_max_tokens:true,send_seed:false},parameters:[]}));
  await page.reload();await page.locator('#parameter-toggle').waitFor({state:'visible'});
  await task(page,'music');await pick(page,'migration-h3');await advanced(page);
  assert.equal(await page.locator('#param-height').inputValue(),'32');
  await page.locator('#param-height').fill('768');await page.locator('#param-height').fill('32');
  await page.locator('[data-input-key="text"]').fill('Quiet instrumental music');
  await page.keyboard.press('Escape');
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'H3 request');
  assert.equal(backend.requests[0].options.height,32,'An explicit default remains a request override');
  backend.finish('job-1','',['music.wav']);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
  await task(page,'tts');await pick(page,'migration-tts');await advanced(page);
  await page.locator('[data-input-key="text"]').fill('Hello.');
  await page.locator('[data-input-key="max_tokens"]').fill('0');
  assert.equal(await page.locator('[data-input-key="max_tokens"]').evaluate(el=>el.checkValidity()),true);
  await page.keyboard.press('Escape');
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===2,'Zero limit request');
  assert.equal(backend.requests[1].inputs.max_tokens,0);
  backend.finish('job-2','',['speech.wav']);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
  await advanced(page);
  await page.locator('[data-input-key="max_tokens"]').fill('');
  await page.keyboard.press('Escape');
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===3,'Blank limit request');
  assert.equal(Object.hasOwn(backend.requests[2].inputs,'max_tokens'),false);
}]);

cases.push(['parameter migration analyzes ACE source and preserves edits and resets',async(page,backend)=>{
  const parameters=clone(PRESET_PARAMETERS.ace_step).map(p=>({...p,scope:'request',level:p.name==='task_route'?'basic':'expert'}));
  parameters.find(p=>p.name==='num_inference_steps').route_defaults={remix:16};
  backend.models.push(model('migration-ace','Migration ACE','music','gen',{
    family:'ace_step',profile:{send_seed:true},parameters,
    music_inputs:{source_audio:true,source_audio_routes:['cover'],source_required_routes:['cover'],lyrics:true,duration:false}}));
  await page.reload();await page.locator('#parameter-toggle').waitFor({state:'visible'});
  await task(page,'music');await pick(page,'migration-ace');await advanced(page);
  await page.locator('#param-task_route').selectOption('remix');
  assert.equal(await page.locator('#param-num_inference_steps').inputValue(),'16');
  await page.locator('#param-task_route').selectOption('cover');
  assert.equal(await page.locator('#param-num_inference_steps').inputValue(),'8');
  await upload(page,'#task-form [data-input-key="audio"]','source.wav');
  await page.locator('#options-json').fill('{"source_caption":"Old caption","num_inference_steps":8}');
  await page.keyboard.press('Escape');
  await page.locator('#analyze-music-source').click();await waitUntil(()=>backend.requests.length===1,'Analysis request');
  assert.equal(backend.requests[0].action,'analyze_source');
  assert.equal(backend.requests[0].inputs.text,undefined,'Analysis does not require a generation prompt');
  assert.equal(await page.locator('#analyze-music-source').isDisabled(),true);
  await advanced(page);
  await page.locator('#param-bpm').fill('120'); // a user edit during analysis wins
  backend.finish('job-1','',[]);
  Object.assign(backend.jobs.get('job-1'),{parameter_updates:{source_caption:'Warm piano',source_lyrics:'Hello',bpm:90,keyscale:'C major',timesignature:'4/4'}});
  await waitValue(page,'#param-source_caption','Warm piano');
  assert.equal(await page.locator('#param-source_lyrics').inputValue(),'Hello');
  assert.equal(await page.locator('#param-bpm').inputValue(),'120');
  assert.equal(JSON.parse(await page.locator('#options-json').inputValue()).source_caption,'Warm piano');
  assert.equal(JSON.parse(await page.locator('#options-json').inputValue()).num_inference_steps,8);
  assert.equal((await page.locator('#result-content').textContent()).includes('未产生输出文件'),false);
  await page.locator('[data-input-key="text"]').fill('A piano cover');
  await page.keyboard.press('Escape');
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===2,'Generation after analysis');
  assert.equal(backend.requests[1].options.source_caption,undefined,'Cover retains source text as an editable reference, not an unused condition');
  assert.equal(backend.requests[1].options.bpm,120);
  assert.equal(backend.requests[1].options.keyscale,'C major');
  backend.finish('job-2','',['music.wav']);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
  await page.locator('#analyze-music-source').click();await waitUntil(()=>backend.requests.length===3,'Second analysis');
  await advanced(page);
  await page.locator('#reset-options').click();
  backend.finish('job-3','',[]);Object.assign(backend.jobs.get('job-3'),{parameter_updates:{source_caption:'Stale caption'}});
  await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
  assert.equal(await page.locator('#param-source_caption').count(),0,'Text generation must hide original fields after reset');
  await page.locator('#param-task_route').selectOption('cover');await page.keyboard.press('Escape');
  await page.locator('#analyze-music-source').click();await waitUntil(()=>backend.requests.length===4,'Analysis with an edited JSON draft');
  await advanced(page);await page.locator('#options-json').fill('null');
  backend.finish('job-4','',[]);Object.assign(backend.jobs.get('job-4'),{parameter_updates:{source_caption:'Ignore invalid draft'}});
  await page.waitForFunction(()=>document.querySelector('#job-status').dataset.state==='done');
  assert.equal(await page.locator('#options-json').inputValue(),'null');
  assert.equal(await page.locator('#param-source_caption').inputValue(),'');
  await page.locator('#options-json').fill('{}');await page.keyboard.press('Escape');
}]);


cases.push(['QA repair multiline analysis preserves all five visible values and edited POST',async(page,backend)=>{
  const parameters=presetParameters('ace_step');
  backend.models.push(model('qa-multiline-ace','QA Multiline ACE','music','gen',{
    family:'ace_step',parameters,profile:{send_seed:false},
    music_inputs:{source_audio:true,source_audio_routes:['cover'],source_required_routes:['cover'],lyrics:true,duration:false}}));
  await page.reload();await page.locator('#parameter-toggle').waitFor({state:'visible'});
  await task(page,'music');await pick(page,'qa-multiline-ace');await advanced(page);
  await page.locator('#param-task_route').selectOption('remix');
  await upload(page,'#task-form [data-input-key="audio"]','source.wav');
  await page.keyboard.press('Escape');await page.locator('#analyze-music-source').click();
  await waitUntil(()=>backend.requests.length===1,'Real UI source analysis submission');
  const updates={source_caption:'A music box',source_lyrics:'[Music Box melody]\n[Instrumental]',bpm:120,keyscale:'C major',timesignature:'4'};
  backend.finish('job-1','',[]);Object.assign(backend.jobs.get('job-1'),{parameter_updates:updates});
  await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);await advanced(page);
  assert.equal(await page.locator('#param-source_lyrics').evaluate(el=>el.tagName),'TEXTAREA');
  assert.equal(await page.locator('#param-source_lyrics').getAttribute('rows'),'12');
  for(const [key,value] of Object.entries(updates))assert.equal(await page.locator(`#param-${key}`).inputValue(),String(value),key);
  await snapshot(page,'qa-repair-ace-multiline-five-values');
  const edited=updates.source_lyrics+'\n[Ending]';await page.locator('#param-source_lyrics').fill(edited);
  await page.locator('[data-input-key="text"]').fill('A piano cover');await page.keyboard.press('Escape');
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===2,'Generation retains edited lyrics');
  assert.equal(backend.requests[1].options.source_lyrics,edited);
}]);

cases.push(['QA repair Seed legacy saved route migrates visible values and POST but new invalid JSON rejects',async(page,backend)=>{
  const route={name:'route',label:'转换路线',type:'choice',choices:['v2_vc','v1_svc','v1_whisper_bigvgan_vc','v1_xlsr_hift_vc'],default:'v2_vc',scope:'request',level:'effect'};
  const seed=model('qa-seed','QA Seed','vc','vc',{family:'seed_vc',parameters:[route]});backend.models.push(seed);
  await page.reload();await page.locator('#parameter-toggle').waitFor({state:'visible'});await task(page,'vc');await pick(page,'qa-seed');
  await upload(page,'#task-form [data-input-key="audio"]','source.wav');await advanced(page);
  await page.locator('#param-route').selectOption('v1_svc');await page.locator('#options-json').fill('{"route":"v1_svc","length_adjust":1.1}');
  await page.keyboard.press('Escape');await task(page,'music');
  route.choices=['v2_vc','v1_whisper_bigvgan_vc','v1_xlsr_hift_vc'];await task(page,'vc');await advanced(page);
  assert.equal(await page.locator('#param-route').inputValue(),'v2_vc');
  assert.deepEqual(JSON.parse(await page.locator('#options-json').inputValue()),{route:'v2_vc',length_adjust:1.1});
  await snapshot(page,'qa-repair-seed-restored-route');
  await page.keyboard.press('Escape');await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'Migrated route submission');
  assert.equal(backend.requests[0].options.route,'v2_vc');assert.equal(backend.requests[0].options.length_adjust,1.1);
  backend.finish('job-1','',['converted.wav']);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
  await advanced(page);await page.locator('#options-json').fill('{"route":"v1_svc"}');await page.keyboard.press('Escape');
  assert.equal(await page.locator('#run-button').isDisabled(),true);await waitText(page,'#run-hint','不支持这条转换路线');
  assert.equal(backend.requests.length,1,'A newly typed invalid route must not be silently migrated or submitted');
}]);

cases.push(['QA repair OmniVoice native language choices submit valid codes including uncommon languages',async(page,backend)=>{
  const languages=require('./configs/omnivoice_languages.json').languages;
  backend.models.push(model('qa-omni','QA OmniVoice','tts','tts',{family:'omnivoice',languages,parameters:[]}));
  await page.reload();await page.locator('#parameter-toggle').waitFor({state:'visible'});await pick(page,'qa-omni');
  const language=page.locator('[data-input-key="language"]');
  const options=await language.locator('option').evaluateAll(elements=>elements.map(el=>({value:el.value,label:el.label})));
  assert.equal(options.length,languages.length+1);assert.ok(!options.some(option=>option.value==='600+ languages'));
  const uncommon=languages.find(([name,code])=>code==='aae');assert.equal(options.find(option=>option.value===uncommon[1]).label,uncommon[0]);
  await page.locator('[data-input-key="text"]').fill('A valid language selection.');
  for(const code of ['en','zh',uncommon[1]]){
    await language.selectOption(code);await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===['en','zh',uncommon[1]].indexOf(code)+1,'Language submitted');
    assert.equal(backend.requests.at(-1).inputs.language,code);
    if(code===uncommon[1])await snapshot(page,'qa-repair-omnivoice-uncommon-code');
    backend.finish(`job-${backend.requests.length}`,'',['voice.wav']);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
  }
}]);

for(const delayedCreation of [false,true])cases.push([`QA repair reference stop acknowledges immediately and rejects duplicate clicks ${delayedCreation?'before id':'after id'}`,async(page,backend)=>{
  const gate=deferred(),created=deferred();let cancellations=0;const previous=backend.route;
  backend.route=async route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(delayedCreation&&pathname===`${API}/reference-transcriptions`){
      backend.referenceRequests.push(clone(route.request().postDataJSON()));
      backend.status.busy=true;backend.status.job='reference-1';backend.status.asr={model:'qwen3-asr',managed:true};
      backend.jobs.set('reference-1',{id:'reference-1',status:'running',message:'识别中',text:'',artifacts:[],audio_segments:[]});
      await created.promise;return route.fulfill({status:200,contentType:'application/json',body:'{"id":"reference-1"}'});
    }
    if(pathname===`${API}/jobs/reference-1/cancel`){cancellations++;await gate.promise;return route.fulfill({status:200,contentType:'application/json',body:'{"status":"cancelling"}'});}
    return previous(route);
  };
  await page.locator('[data-route="references"]').click();
  await page.locator('#reference-editor .reference-automatic input').uncheck();
  await upload(page,'#reference-editor [data-input-key="voice"]','reference.wav');
  await page.locator('#reference-editor').getByRole('button',{name:'音频转录',exact:true}).click();
  await waitUntil(()=>backend.referenceRequests.length===1,'Reference started');
  const stop=page.locator('#reference-editor .reference-stop');await stop.click();
  assert.equal(await stop.isDisabled(),true);
  assert.match(await page.locator('#reference-editor .reference-status').textContent(),/正在停止任务/);
  await stop.evaluate(el=>el.click());
  if(delayedCreation){assert.equal(cancellations,0);created.resolve();}
  await waitUntil(()=>cancellations===1,'Exactly one cancel POST after job id exists');
  await new Promise(resolve=>setTimeout(resolve,550));assert.equal(cancellations,1);assert.equal(await stop.isDisabled(),true);
  gate.resolve();Object.assign(backend.jobs.get('reference-1'),{status:'cancelled',message:'任务已停止。'});backend.status.busy=false;backend.status.job=null;
  await waitText(page,'#reference-editor .reference-status','任务已停止');
  assert.equal(await stop.isVisible(),false);
}]);

cases.push(['startup status stays independent of slow catalog and references',async(page,backend)=>{
  const originalRoute=backend.route,catalog=deferred(),voices=deferred(),requests=new Set();
  backend.status.asr={model:'qwen3-asr',managed:true};
  backend.route=async route=>{
    const pathname=new URL(route.request().url()).pathname;requests.add(pathname);
    if(pathname===`${API}/catalog`){
      // An older catalog snapshot must not clear independently restored residents.
      await catalog.promise;
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({version:'fixture',models:backend.models,server:{model:'tts-one'},asr:{model:null}})});
    }
    if(pathname===`${API}/voices`)await voices.promise;
    return originalRoute(route);
  };
  await page.reload();
  await waitUntil(()=>['catalog','voices','status'].every(path=>requests.has(`${API}/${path}`)),'Startup reads must start concurrently');
  await waitText(page,'#resident-model-name','Qwen3-ASR 0.6B');
  assert.equal(await page.locator('#workspace-loading').isVisible(),true);
  assert.equal(await page.locator('#run-button').isVisible(),false);
  await snapshot(page,'startup-consistent-loading');
  catalog.resolve();voices.resolve();
  await page.locator('[data-input-key="text"]').waitFor({state:'visible'});
  assert.equal(await page.locator('#resident-model').isVisible(),true);
  assert.equal(await page.locator('#resident-model-name').textContent(),'Qwen3-ASR 0.6B');
  assert.equal(backend.loads.length,0,'Refresh must never reload models');
  backend.route=originalRoute;
}]);

cases.push(['resident unload cannot be reversed by an older status response',async(page,backend)=>{
  backend.status.asr={model:'qwen3-asr',managed:true};
  await page.reload();await waitText(page,'#resident-model-name','Qwen3-ASR 0.6B');
  const originalRoute=backend.route,gate=deferred(),requested=deferred(),oldStatus=clone(backend.status);
  backend.route=async route=>{
    if(new URL(route.request().url()).pathname===`${API}/status`){
      requested.resolve();await gate.promise;
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(oldStatus)});
    }
    return originalRoute(route);
  };
  await page.clock.install();await page.clock.runFor(7100);await requested.promise;
  await page.locator('[data-route="settings"]').click();await page.locator('[data-settings-tab="runtime"]').click();
  await page.locator('#unload-all-models').click();
  await page.locator('#resident-model').waitFor({state:'hidden'});
  const received=page.waitForResponse(`${ORIGIN}${API}/status`);gate.resolve();await received;
  await page.waitForFunction(()=>!document.getElementById('unload-all-models').disabled);
  assert.equal(await page.locator('#resident-model').isVisible(),false);
  await waitText(page,'#global-model-status','未加载任务模型');
  backend.route=originalRoute;
}]);

cases.push(['resident status persists across menus and combines with the service dot when collapsed',async(page,backend)=>{
  backend.status.asr={model:'qwen3-asr',managed:true};
  await page.reload();await waitText(page,'#resident-model-name','Qwen3-ASR 0.6B');
  for(const route of ['tts','asr','music','design','vc','scenarios','references','tools','models','settings']){
    await page.locator(`[data-route="${route}"]`).click();
    assert.equal(await page.locator('#resident-model').isVisible(),true,route);
    const status=['tts','asr','music','design','vc'].includes(route)?'#workspace-load-status':'#global-model-status';
    await waitText(page,status,'TTS One');
    assert.equal((await page.locator(status).textContent()).includes('ASR'),false,'Residents belong in the sidebar');
  }
  await page.locator('[data-route="tts"]').click();
  await snapshot(page,'resident-and-task-model-status');
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:1000});
    if(width===1440)await page.locator('#sidebar-toggle').click();
    assert.equal(await page.locator('#resident-model .icon').isVisible(),true);
    assert.equal(await page.locator('.resident-service-dot').isVisible(),true);
    assert.equal(await page.locator('#connection-status').isVisible(),false,'Collapsed residents should have one combined indicator');
    const geometry=await page.locator('.resident-model-mark').evaluate(el=>{
      const icon=el.querySelector('.icon').getBoundingClientRect(),dot=el.querySelector('.status-dot').getBoundingClientRect();
      return {dx:Math.abs(icon.x+icon.width/2-dot.x-dot.width/2),dy:Math.abs(icon.y+icon.height/2-dot.y-dot.height/2),color:getComputedStyle(el).color,dot:getComputedStyle(el.querySelector('.status-dot')).backgroundColor};
    });
    assert.ok(geometry.dx<1&&geometry.dy<1,'Service dot must be centered inside the model icon');
    assert.equal(geometry.color,geometry.dot,'Loaded resident and online service should both be green');
    await snapshot(page,`resident-combined-${width}`);
    if(width===1440)await page.locator('#sidebar-toggle').click();
  }
  backend.status.asr={model:null,managed:false};backend.status.server.model=null;
  await page.reload();await waitText(page,'#sidebar-status','本地服务在线');
  assert.equal(await page.locator('#resident-model').isVisible(),false);
  assert.equal(await page.locator('#server-dot').isVisible(),true,'Without a resident show only the service dot');
  const originalRoute=backend.route;
  backend.route=route=>{
    if(new URL(route.request().url()).pathname===`${API}/status`){backend.expectedHttpErrors++;return route.fulfill({status:503,body:'{}'});}
    return originalRoute(route);
  };
  await page.clock.install();await page.clock.runFor(7100);await waitText(page,'#sidebar-status','本地服务离线');
  assert.equal(await page.locator('#server-dot').evaluate(el=>el.classList.contains('online')),false);
  backend.route=originalRoute;
}]);

cases.push(['music without lyrics keeps its results at the top of the output column',async(page,backend)=>{
  const entry=backend.models.find(item=>item.id==='music-one');
  entry.family='stable_audio';entry.profile={accepts_voice_reference:false,send_seed:true};
  Object.assign(entry.music_inputs,{source_audio:true,duration:true,duration_default:30,duration_min:1});
  await page.reload();await task(page,'music','Music One');
  await page.locator('[data-input-key="text"]').fill('rap');
  assert.equal(await page.locator('[data-input-key="lyrics"],#param-source_lyrics').count(),0);
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'Stable Audio generation');
  for(const complete of [false,true]){
    if(complete){backend.finish('job-1','',['stable-audio.wav']);await page.locator('#result-content audio').waitFor();}
    await page.setViewportSize({width:1440,height:1000});
    assert.ok(await page.locator('.result-card').evaluate(el=>{
      const result=el.getBoundingClientRect(),input=document.querySelector('.task-primary').getBoundingClientRect();
      return Math.abs(result.top-input.top)<2&&result.left>input.right;
    }),'A music model without lyrics must show progress and results at the top right');
  }
  assert.equal(await page.locator('#result-content audio').count(),1);
  await snapshot(page,'music-no-lyrics-result-desktop');
  await page.setViewportSize({width:390,height:844});await assertBrowserScroll(page);
  assert.ok(await page.locator('.result-card').evaluate(el=>{
    const result=el.getBoundingClientRect(),controls=document.querySelector('.music-controls-column').getBoundingClientRect();
    return result.top>=controls.bottom&&result.top-controls.bottom<30;
  }),'Narrow-screen results should follow controls without a lyrics-sized blank area');
  await snapshot(page,'music-no-lyrics-result-mobile');
}]);

cases.push(['ACE source editor protects corrections and submits independent original and target text',async(page,backend)=>{
  const entry=backend.models.find(item=>item.id==='music-ace');entry.parameters=presetParameters('ace_step');entry.profile.send_seed=true;
  for(const param of entry.parameters){if(['bpm','keyscale','timesignature'].includes(param.name))param.level='basic';if(param.name==='num_inference_steps')param.route_defaults={remix:16};}
  Object.assign(entry.music_inputs,{source_audio_routes:['cover','cover-nofsq','remix'],source_required_routes:['cover','cover-nofsq','remix']});
  await page.reload();await task(page,'music');await pick(page,'music-ace');await page.locator('#param-task_route').selectOption('remix');
  await upload(page,'#task-form [data-input-key="audio"]','original-song.wav');
  assert.equal(await page.locator('#task-form [data-input-key="seed"]').count(),0);
  assert.equal(await page.locator('#workspace-settings [data-input-key="seed"]').count(),1);
  assert.equal(await page.locator('#common-options #param-flow_edit_n_max').count(),1);
  assert.equal(await page.locator('#param-audio_cover_strength').count(),0);
  await page.locator('#analyze-music-source').click();await waitUntil(()=>backend.requests.length===1,'First source analysis');
  backend.finish('job-1','',[]);Object.assign(backend.jobs.get('job-1'),{message:'分析完成；已回填高级参数。 **描述** Full analysis details and lyrics',parameter_updates:{source_caption:'Warm acoustic pop',source_lyrics:'[Verse 1]\n原曲第一句\n原曲第二句',bpm:103,keyscale:'C# minor',timesignature:'4'}});
  await waitValue(page,'#param-source_lyrics','[Verse 1]\n原曲第一句\n原曲第二句');
  assert.equal((await page.locator('#job-status').textContent()).includes('Full analysis'),false);
  assert.equal(await page.locator('[data-input-key="lyrics"]').inputValue(),'','Analysis must not replace target lyrics');
  await advanced(page);await page.locator('#options-json').fill(JSON.stringify({source_lyrics:'JSON original lyrics'}));await page.keyboard.press('Escape');
  assert.equal(await page.locator('#param-source_lyrics').inputValue(),'JSON original lyrics');
  await page.locator('#param-source_lyrics').fill('[Verse 1]\n校正后的原词');
  assert.equal(JSON.parse(await page.locator('#options-json').inputValue()).source_lyrics,'[Verse 1]\n校正后的原词');
  await page.getByRole('button',{name:'沿用原曲提示',exact:true}).click();await page.getByRole('button',{name:'沿用原歌词',exact:true}).click();
  await page.locator('[data-input-key="text"]').fill('Bright guitar pop');await page.locator('[data-input-key="lyrics"]').fill('[Verse 1]\n这是新的歌词');
  await page.locator('#analyze-music-source').click();await waitUntil(()=>backend.requests.length===2,'Repeated analysis');
  backend.finish('job-2','',[]);Object.assign(backend.jobs.get('job-2'),{parameter_updates:{source_caption:'Updated description',source_lyrics:'New recognition'}});
  await page.locator('.music-analysis-choice').waitFor();
  assert.equal(await page.locator('#param-source_lyrics').inputValue(),'[Verse 1]\n校正后的原词');
  await page.getByRole('button',{name:'保留修改',exact:true}).click();
  await page.locator('#param-task_route').selectOption('cover');assert.equal(await page.locator('#param-flow_edit_n_max').count(),0);assert.equal(await page.locator('#common-options #param-cover_noise_strength').count(),1);
  await page.locator('#param-task_route').selectOption('remix');await advanced(page);assert.equal(await page.locator('#param-num_inference_steps').inputValue(),'16');
  await page.locator('[data-input-key="seed"]').fill('42');await page.keyboard.press('Escape');
  assert.equal(await page.locator('#music-duration-mode').count(),0);
  assert.equal(await page.locator('[data-input-key="duration"]').count(),0);
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===3,'Edited music generation');
  const request=backend.requests[2];assert.equal(request.options.source_caption,'Updated description');assert.equal(request.options.source_lyrics,'[Verse 1]\n校正后的原词');assert.equal(request.inputs.text,'Bright guitar pop');assert.equal(request.inputs.lyrics,'[Verse 1]\n这是新的歌词');assert.equal(request.inputs.duration,-1);assert.equal(request.inputs.seed,42);
  backend.finish('job-3','',['cover.wav']);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
  await page.locator('#analyze-music-source').click();await waitUntil(()=>backend.requests.length===4,'Replace analysis corrections');backend.finish('job-4','',[]);Object.assign(backend.jobs.get('job-4'),{parameter_updates:{source_lyrics:'Accepted recognition'}});
  await page.getByRole('button',{name:'采用分析结果',exact:true}).click();assert.equal(await page.locator('#param-source_lyrics').inputValue(),'Accepted recognition');assert.equal(await page.locator('[data-input-key="lyrics"]').inputValue(),'[Verse 1]\n这是新的歌词');
  await page.locator('#analyze-music-source').click();await waitUntil(()=>backend.requests.length===5,'Analysis of old upload');await upload(page,'#task-form [data-input-key="audio"]','replacement-song.wav');backend.finish('job-5','',[]);Object.assign(backend.jobs.get('job-5'),{parameter_updates:{source_lyrics:'Stale old upload'}});await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);assert.equal(await page.locator('#param-source_lyrics').inputValue(),'','Replacing the source clears old recognition and rejects its late response');
  for(const theme of ['light','dark']){await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);for(const width of [1440,1024,768,390,320]){await page.setViewportSize({width,height:1000});await assertBrowserScroll(page);assert.equal(await page.locator('#param-source_lyrics').isVisible(),true);assert.equal(await page.locator('[data-input-key="lyrics"]').isVisible(),true);if(width===1440||width===390)await snapshot(page,`ace-source-editor-${theme}-${width}`);}}
}]);

cases.push(['ACE editing controls validate ranges filter drafts and preserve mode-specific input',async(page,backend)=>{
  const entry=backend.models.find(item=>item.id==='music-ace');entry.parameters=presetParameters('ace_step');
  await page.reload();await task(page,'music');await pick(page,'music-ace');
  assert.equal(await page.locator('#param-source_caption').count(),0);
  assert.equal(await page.locator('#param-source_lyrics').count(),0);
  assert.equal(await page.locator('[data-input-key="audio"]').count(),0);
  const first=await page.locator('#param-task_route').boundingBox();
  await page.locator('#param-task_route').selectOption('complete');
  const complete=await page.locator('#param-task_route').boundingBox();assert.equal(complete.x,first.x);assert.equal(complete.y,first.y);
  assert.equal(await page.locator('[data-input-key="lyrics"]').count(),0);
  await page.locator('#param-complete_track_classes input[value="drums"]').check();
  await page.locator('#param-complete_track_classes input[value="bass"]').check();
  await page.locator('[data-input-key="text"]').fill('A warm arrangement');
  for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await assertBrowserScroll(page);await snapshot(page,`ace-complete-${width}`);}await page.setViewportSize({width:1440,height:1000});
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'No-source completion');
  assert.equal(backend.requests[0].inputs.audio,undefined);
  assert.deepEqual(backend.requests[0].options.complete_track_classes,['drums','bass']);
  assert.equal(backend.requests[0].options.thinking,undefined);
  backend.finish('job-1','',['complete.wav']);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
  backend.uploadDurations.set('context.wav',30);await upload(page,'[data-input-key="audio"]','context.wav');
  await advanced(page);await page.locator('#options-json').fill('{"thinking":true,"audio_codes":"old","source_lyrics":"old","repaint_injection_ratio":0}');await page.keyboard.press('Escape');
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===2,'Source completion');
  assert.equal(backend.requests[1].options.thinking,false);assert.equal(backend.requests[1].options.audio_codes,undefined);assert.equal(backend.requests[1].options.source_lyrics,undefined);
  assert.equal(backend.requests[1].options.repaint_injection_ratio,undefined);assert.equal(backend.requests[1].inputs.duration,-1);
  backend.finish('job-2','',['complete.wav']);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
  await page.locator('#param-task_route').selectOption('repaint');
  assert.equal(await page.locator('#param-repainting_start').inputValue(),'0');assert.equal(await page.locator('#param-repainting_end').inputValue(),'30');
  await page.locator('#param-repainting_start').fill('5');await page.locator('#param-repainting_end').fill('4');
  await page.locator('#run-button').click();await waitText(page,'#job-status','有效的音频区间');assert.equal(backend.requests.length,2);
  await page.locator('#param-repainting_end').fill('12');
  await page.locator('#param-repaint_mode').selectOption('conservative');assert.equal(await page.locator('#param-repaint_strength').count(),0);
  await page.locator('#param-repaint_mode').selectOption('custom');await advanced(page);await page.locator('#param-repaint_injection_ratio').evaluate(el=>{el.value='0.3';el.dispatchEvent(new Event('input',{bubbles:true}));});await page.keyboard.press('Escape');
  await page.locator('#param-repaint_mode').selectOption('balanced');assert.equal(await page.locator('#param-repaint_injection_ratio').count(),0);
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===3,'Repaint request');
  assert.equal(backend.requests[2].options.repaint_mode,'balanced');assert.equal(backend.requests[2].options.repaint_strength,0.5);assert.equal(backend.requests[2].options.repaint_injection_ratio,undefined);
  assert.equal(backend.requests[2].options.repainting_start,5);assert.equal(backend.requests[2].options.repainting_end,12);
  for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});await assertBrowserScroll(page);await snapshot(page,`ace-repaint-${theme}-${width}`);}}
  backend.finish('job-3','',['repaint.wav']);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
  await page.locator('#param-task_route').selectOption('lego');await page.locator('#param-track_name').selectOption('guitar');
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===4,'Lego request');assert.equal(backend.requests[3].options.thinking,false);assert.equal(backend.requests[3].options.track_name,'guitar');assert.equal(backend.requests[3].options.complete_track_classes,undefined);
  backend.finish('job-4','',['guitar.wav']);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
  await page.locator('#param-task_route').selectOption('extract');assert.equal(await page.locator('[data-input-key="lyrics"]').count(),0);assert.equal(await page.locator('#param-repainting_start').count(),0);
  await page.locator('#param-track_name').selectOption('vocals');await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===5,'Extract request');assert.equal(backend.requests[4].options.track_name,'vocals');assert.equal(backend.requests[4].options.repainting_start,undefined);
  backend.finish('job-5','',['vocals.wav']);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
  await page.locator('#param-task_route').selectOption('cover-nofsq');assert.equal(await page.locator('#param-audio_cover_strength').count(),0);assert.equal(await page.locator('#param-cover_noise_strength').count(),0);
  await page.locator('#param-task_route').selectOption('remix');assert.equal(await page.locator('#param-guidance_scale').count(),0);
  await page.locator('#param-flow_edit_n_min').evaluate(el=>{el.value='0.9';el.dispatchEvent(new Event('input',{bubbles:true}));});await page.locator('#param-flow_edit_n_max').evaluate(el=>{el.value='0.2';el.dispatchEvent(new Event('input',{bubbles:true}));});await page.locator('#run-button').click();await waitText(page,'#job-status','流编辑起止比例');assert.equal(backend.requests.length,5);
  await page.locator('#param-task_route').selectOption('repaint');backend.uploadDurations.set('shorter.wav',8);await upload(page,'[data-input-key="audio"]','shorter.wav');
  assert.equal(await page.locator('#param-source_lyrics').inputValue(),'');assert.equal(await page.locator('#param-repainting_start').inputValue(),'0');assert.equal(await page.locator('#param-repainting_end').inputValue(),'8');
  await page.getByRole('button',{name:'移除',exact:true}).click();assert.equal(await page.locator('#param-repainting_end').inputValue(),'');
  await page.locator('#param-source_lyrics').fill('Old source draft');
  const gate=backend.holdUpload('delayed-source.wav');
  await page.locator('[data-input-key="audio"]').setInputFiles({name:'delayed-source.wav',mimeType:'audio/wav',buffer:wav()});
  await waitUntil(()=>backend.uploadAttempts.some(item=>item.name==='delayed-source.wav'),'Delayed source upload started');
  await task(page,'tts');await page.locator('#parameter-toggle').waitFor({state:'visible'});await page.locator('[data-input-key="text"]').fill('Keep this speech draft');gate.resolve();
  await task(page,'music');await waitText(page,'#task-inputs','delayed-source.wav');await waitValue(page,'#param-source_lyrics','');
  await task(page,'tts');assert.equal(await page.locator('[data-input-key="text"]').inputValue(),'Keep this speech draft');
}]);

cases.push(['VC options switch Seed routes without submitting hidden drafts',async(page,backend)=>{
  const v1=['v1_whisper_bigvgan_vc','v1_xlsr_hift_vc','v1_svc'];
  const parameters=[...presetParameters('seed_vc').map(p=>({...p,level:'effect',...(p.name==='route'?{choices:['v2_vc',...v1.slice(0,2)],default:'v2_vc'}:{})})),
    {name:'voice_anonymization',label:'声音匿名化',type:'bool',default:false,level:'effect'},
    {name:'f0_condition',label:'使用音高条件',type:'bool',default:false,level:'expert'},
    {name:'auto_f0_adjust',label:'自动对齐音高',type:'bool',default:false,level:'effect'},
    {name:'semitone_shift',label:'音高',type:'number',default:0,level:'effect'}];
  const controls={routes:['v2_vc',...v1.slice(0,2)],default_route:'v2_vc',f0_default:false,
    parameter_routes:{intelligibility_guidance_scale:['v2_vc'],similarity_guidance_scale:['v2_vc'],voice_anonymization:['v2_vc'],
      inference_guidance_scale:v1,f0_condition:v1,auto_f0_adjust:v1,semitone_shift:v1},aliases:{semi_tone_shift:'semitone_shift'}};
  Object.assign(backend.models.find(m=>m.id==='voice-convert'),{family:'seed_vc',parameters,vc_controls:controls,profile:{send_seed:true,accepts_voice_reference:true}});
  await task(page,'vc','Voice conversion');await upload(page,'#task-form [data-input-key="audio"]','source.wav');
  assert.equal(await page.locator('#common-options #param-num_inference_steps').count(),1);
  assert.equal(await page.locator('#param-inference_guidance_scale,#param-semitone_shift,#param-auto_f0_adjust,#param-f0_condition').count(),0);
  assert.equal(await page.locator('#common-options [data-input-key="seed"]').getAttribute('placeholder'),'留空随机');
  await advanced(page);await page.locator('#options-json').fill('{"route":"v2_vc","num_inference_steps":18,"inference_guidance_scale":0.4,"intelligibility_guidance_scale":0.8,"auto_f0_adjust":true,"semi_tone_shift":5,"seed":17}');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#param-num_inference_steps').inputValue(),'18');
  await page.locator('[data-input-key="seed"]').fill('0');
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'Seed V2 request');
  assert.deepEqual(backend.requests[0].options,{route:'v2_vc',num_inference_steps:18,intelligibility_guidance_scale:0.8});
  assert.equal(backend.requests[0].inputs.seed,0);
  backend.finish('job-1','',['converted.wav']);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
  await page.locator('#param-route').selectOption('v1_whisper_bigvgan_vc');
  assert.equal(await page.locator('#param-intelligibility_guidance_scale,#param-similarity_guidance_scale,#param-voice_anonymization').count(),0);
  assert.equal(await page.locator('#param-semitone_shift,#param-auto_f0_adjust').count(),0,'V1 VC pitch must wait for F0 conditioning');
  assert.equal(await page.locator('#param-inference_guidance_scale').inputValue(),'0.4');
  await advanced(page);
  const extra=JSON.parse(await page.locator('#options-json').inputValue());extra.f0_condition='false';await page.locator('#options-json').fill(JSON.stringify(extra));
  assert.equal(await page.locator('#param-f0_condition').isChecked(),false);assert.equal(await page.locator('#param-semitone_shift').count(),0);
  await page.locator('#param-f0_condition').check();await snapshot(page,'vc-options-seed-advanced');await page.keyboard.press('Escape');
  assert.equal(await page.locator('#param-auto_f0_adjust').isChecked(),true);
  assert.equal(await page.locator('#param-semitone_shift').inputValue(),'5');
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===2,'Seed V1 request');
  assert.deepEqual(backend.requests[1].options,{route:'v1_whisper_bigvgan_vc',num_inference_steps:18,inference_guidance_scale:0.4,f0_condition:true,auto_f0_adjust:true,semitone_shift:5});
  backend.finish('job-2','',['converted-v1.wav']);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
  await page.locator('#param-semitone_shift').fill('');
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===3,'Seed V1 cleared pitch request');
  assert.equal(backend.requests[2].options.semitone_shift,undefined);assert.equal(backend.requests[2].options.semi_tone_shift,undefined);
  backend.finish('job-3','',['converted-v1-cleared.wav']);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
  await page.locator('#param-route').selectOption('v2_vc');assert.equal(await page.locator('#param-intelligibility_guidance_scale').inputValue(),'0.8');
  await page.locator('[data-input-key="seed"]').fill('');await snapshot(page,'vc-options-seed-v2');
  await advanced(page);await page.locator('#reset-options').click();await page.keyboard.press('Escape');
  assert.equal(await page.locator('#param-route').inputValue(),'v2_vc');assert.equal(await page.locator('#param-num_inference_steps').inputValue(),'30');
  assert.equal(await page.locator('[data-input-key="seed"]').inputValue(),'');
  await page.setViewportSize({width:390,height:844});await assertBrowserScroll(page);await assertVisibleControl(page,'#run-button','Seed conversion action clipped');await snapshot(page,'vc-options-seed-narrow');
}]);

cases.push(['VC options respect Vevo task routes and advanced sampling applicability',async(page,backend)=>{
  const parameters=presetParameters('vevo2').map(p=>({...p,level:['route','num_inference_steps','use_pitch_shift'].includes(p.name)?'effect':'expert',...(p.name==='route'?{choices:['style_preserved_vc','style_converted_vc'],default:'style_preserved_vc'}:{})}));
  Object.assign(backend.models.find(m=>m.id==='voice-convert'),{family:'vevo2',parameters,
    vc_controls:{routes:['style_preserved_vc','style_converted_vc'],default_route:'style_preserved_vc',parameter_routes:{temperature:['style_converted_vc'],top_p:['style_converted_vc'],top_k:['style_converted_vc']}}});
  await task(page,'vc','Voice conversion');await upload(page,'#task-form [data-input-key="audio"]','source.wav');await upload(page,'#task-form [data-input-key="voice"]','target.wav');
  assert.deepEqual(await page.locator('#param-route option').evaluateAll(items=>items.map(o=>o.value)),['style_preserved_vc','style_converted_vc']);
  assert.equal(await page.locator('#param-temperature,#param-top_k,#param-top_p').count(),0);
  await advanced(page);await page.locator('#options-json').fill('{"temperature":0.9,"top_k":12,"top_p":0.8,"num_inference_steps":14}');await page.keyboard.press('Escape');
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'Vevo preserved request');
  assert.deepEqual(backend.requests[0].options,{num_inference_steps:14});
  backend.finish('job-1','',['converted.wav']);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
  await page.locator('#param-route').selectOption('style_converted_vc');await advanced(page);
  assert.equal(await page.locator('#expert-controls #param-temperature').inputValue(),'0.9');
  await page.locator('#param-temperature').evaluate(input=>{input.value='0.6';input.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.equal(JSON.parse(await page.locator('#options-json').inputValue()).temperature,0.6);
  await page.locator('#options-json').fill('{"route":"editing"}');await page.keyboard.press('Escape');
  assert.equal(await page.locator('#run-button').isDisabled(),true);await waitText(page,'#run-hint','不支持这条转换路线');
  assert.equal(backend.requests.length,1);
}]);

cases.push(['VC options seed defaults and unsupported controls stay model scoped',async(page,backend)=>{
  const entries=[model('vc-mean','MeanVC2','vc','vc',{family:'meanvc2',profile:{send_seed:true,accepts_voice_reference:false},parameters:[{name:'seed',type:'int',default:42,level:'expert'}]}),
    model('vc-tone','Tone Color VC','vc','vc',{family:'tone_color_vc',profile:{send_seed:true,accepts_voice_reference:false},parameters:[{name:'seed',type:'int',default:1234,level:'expert'},{name:'temperature',label:'采样温度',type:'number',min:0,default:0.3,level:'effect'}]}),
    model('vc-mio','MioCodec','vc','vc',{family:'miocodec',profile:{send_seed:false,accepts_voice_reference:false},parameters:[]})];
  backend.models.push(...entries);await page.reload();await task(page,'vc');await pick(page,'vc-mean');
  await upload(page,'#task-form [data-input-key="audio"]','source.wav');
  assert.equal(await page.locator('#common-options [data-input-key="seed"]').getAttribute('placeholder'),'默认 42');
  await page.locator('[data-input-key="seed"]').fill('7');await pick(page,'vc-tone');
  assert.equal(await page.locator('[data-input-key="seed"]').inputValue(),'');
  assert.equal(await page.locator('[data-input-key="seed"]').getAttribute('placeholder'),'默认 1234');
  assert.equal(await page.locator('[data-input-key="seed"]').getAttribute('max'),'2147483647');
  assert.equal(await page.locator('#common-options #param-temperature').count(),1);
  await page.locator('#param-temperature').fill('0');await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'Tone request');
  assert.deepEqual(backend.requests[0].options,{temperature:0});assert.equal(backend.requests[0].inputs.seed,undefined);
  backend.finish('job-1','',['tone.wav']);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);await snapshot(page,'vc-options-tone');
  await pick(page,'vc-mio');assert.equal(await page.locator('[data-input-key="seed"]').count(),0);assert.equal(await page.locator('#common-options').isVisible(),false);
  await advanced(page);await page.locator('#options-json').fill('{"seed":91}');await page.keyboard.press('Escape');
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===2,'MioCodec request');
  assert.equal(backend.requests[1].options.seed,undefined);assert.equal(backend.requests[1].inputs.seed,undefined);
  backend.finish('job-2','',['mio.wav']);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
  await pick(page,'vc-mean');assert.equal(await page.locator('[data-input-key="seed"]').inputValue(),'7');
}]);

cases.push(['RVC pending upload respects checkbox changes and workspace navigation',async(page,backend)=>{
  Object.assign(backend.models.find(item=>item.id==='voice-convert'),{family:'rvc',voice_mode:'rvc',profile:{model_as_target_voice:true,accepts_voice_reference:false,send_seed:false},parameters:presetParameters('rvc')});
  await task(page,'vc','Voice conversion');
  const gate=backend.holdUpload('delayed.pth');
  await page.locator('[data-input-key="rvc_voice_model"]').setInputFiles({name:'delayed.pth',mimeType:'application/octet-stream',buffer:Buffer.from('model')});
  await waitUntil(()=>backend.uploadAttempts.some(item=>item.name==='delayed.pth'),'RVC upload started');
  await page.locator('[data-input-key="rvc_use_builtin"]').uncheck();await page.locator('[data-input-key="rvc_use_builtin"]').check();
  await task(page,'tts');await page.locator('[data-input-key="text"]').fill('保留这段合成文本');gate.resolve();
  await task(page,'vc');await waitText(page,'.rvc-file-choice','delayed.pth');
  assert.equal(await page.locator('[data-input-key="rvc_use_builtin"]').isChecked(),true,'Upload completion must not override a newer explicit checkbox choice');
  await page.locator('[data-input-key="rvc_use_builtin"]').uncheck();
  assert.equal(await page.locator('.rvc-file-choice .upload-status').first().textContent(),'delayed.pth');
  await task(page,'tts');await waitValue(page,'[data-input-key="text"]','保留这段合成文本');
}]);

cases.push(['TTS preset voices follow language and seed edits supersede JSON',async(page,backend)=>{
  Object.assign(backend.models.find(m=>m.id==='tts-two'),{family:'kokoro_tts',languages:['en-us','zh'],streaming:false,
    profile:{accepts_voice_reference:false,send_seed:true,send_max_tokens:false},
    tts_controls:{voice_languages:{af_heart:'en-us',zf_xiaobei:'zh',zf_xiaoxiao:'zh'}},parameters:[
      {name:'voice',label:'内置音色',type:'choice',choices:['af_heart','zf_xiaobei','zf_xiaoxiao'],default:'af_heart',scope:'request',level:'basic'}]});
  await pick(page,'tts-two');
  assert.equal(await page.locator('[data-input-key="voice"]').count(),0);
  assert.equal(await page.locator('#param-voice').inputValue(),'af_heart');
  await page.locator('[data-input-key="language"]').selectOption('zh');
  assert.deepEqual(await page.locator('#param-voice option').evaluateAll(items=>items.map(el=>el.value)),['zf_xiaobei','zf_xiaoxiao']);
  await page.locator('#param-voice').selectOption('zf_xiaoxiao');
  await page.locator('[data-input-key="text"]').fill('你好，欢迎使用。');
  await advanced(page);await page.locator('#options-json').fill('{"seed":42}');
  assert.equal(await page.locator('[data-input-key="seed"]').inputValue(),'42');
  await page.locator('[data-input-key="seed"]').fill('0');await page.keyboard.press('Escape');
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'Kokoro request missing');
  assert.equal(backend.requests[0].options.voice,'zf_xiaoxiao');
  assert.equal(backend.requests[0].inputs.language,'zh');assert.equal(backend.requests[0].inputs.seed,0);
  assert.equal(backend.requests[0].options.seed,undefined);
  backend.finish('job-1','',['voice.wav']);await waitText(page,'#job-status','voice.wav');
  await advanced(page);await page.locator('[data-input-key="seed"]').fill('');await page.keyboard.press('Escape');
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===2,'Default seed request missing');
  assert.equal(backend.requests[1].inputs.seed,undefined);assert.equal(backend.requests[1].options.seed,undefined);
  backend.finish('job-2','',['voice.wav']);await waitText(page,'#job-status','voice.wav');
  await snapshot(page,'tts-kokoro-voices');
}]);

cases.push(['TTS reference parameters survive source selection and Turbo hides unsupported inputs',async(page,backend)=>{
  Object.assign(backend.models.find(m=>m.id==='tts-two'),{family:'qwen3_tts',voice_mode:'reference',languages:['chinese','english'],
    profile:{accepts_voice_reference:true,require_voice:true,require_reference_text:true,send_seed:true},parameters:[
      {name:'x_vector_only_mode',label:'仅提取音色',type:'bool',default:false,scope:'request',level:'effect',placement:'reference'}]});
  backend.voices.push({name:'saved.wav',text:'',url:`${API}/references/saved.wav/audio`});
  await page.locator('[data-route="references"]').click();await task(page,'tts');await pick(page,'tts-two');
  await page.locator('[data-input-key="builtin_voice"]').selectOption('saved.wav');
  const verifyVoiceMode=async(mode)=>{
    assert.equal(await page.locator('#param-x_vector_only_mode').count(),1);
    const row=page.locator(`.tts-reference-group #tts-reference-${mode} .reference-media-slot`);
    const audio=await row.locator('audio').boundingBox(),control=await row.locator('.reference-voice-mode').boundingBox();
    assert.ok(audio&&control,'Reference audio and voice-only control must both be visible');
    assert.ok(control.x>=audio.x+audio.width+8,'Voice-only control must sit to the right of the player');
    assert.ok(Math.abs(control.y+control.height/2-audio.y-audio.height/2)<2,'Reference controls must share one row');
    assert.equal(await page.locator('#tts-reference-options').isVisible(),false);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Reference controls must fit the viewport');
  };
  await verifyVoiceMode('library');
  await page.locator('#param-x_vector_only_mode').check();
  await snapshot(page,'tts-xvector-library-desktop');
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:1000});
    await page.locator('#tts-reference-upload-tab').click();await verifyVoiceMode('upload');
    assert.equal(await page.locator('#param-x_vector_only_mode').isChecked(),true);
    await snapshot(page,`tts-xvector-upload-${width}`);
    await page.locator('#tts-reference-library-tab').click();await verifyVoiceMode('library');
    assert.equal(await page.locator('#param-x_vector_only_mode').isChecked(),true);
  }
  await page.setViewportSize({width:1440,height:1000});
  await advanced(page);await page.locator('#options-json').fill('{"x_vector_only_mode":false}');
  await page.locator('#options-json').dispatchEvent('change');await page.keyboard.press('Escape');
  await verifyVoiceMode('library');assert.equal(await page.locator('#param-x_vector_only_mode').isChecked(),false);
  await page.locator('#param-x_vector_only_mode').check();
  await page.locator('[data-input-key="text"]').fill('只使用参考音色。');
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'Reference parameter request missing');
  assert.equal(backend.requests[0].options.x_vector_only_mode,true);
  backend.finish('job-1','',['reference.wav']);await waitText(page,'#job-status','reference.wav');
  Object.assign(backend.models.find(m=>m.id==='tts-one'),{family:'chatterbox_turbo',languages:[],streaming:false,
    profile:{accepts_voice_reference:false,send_reference_text:false,send_seed:true,send_max_tokens:false},parameters:presetParameters('chatterbox_turbo')});
  await pick(page,'tts-one');
  assert.equal(await page.locator('#task-form [data-input-key="voice"],#task-form [data-input-key="builtin_voice"],#task-form [data-input-key="reference_text"],#task-form [data-input-key="language"]').count(),0);
  await advanced(page);assert.equal(await page.locator('#param-max_new_tokens').count(),1);
  assert.deepEqual(await page.locator('#task-form input:invalid').evaluateAll(items=>items.map(el=>el.id)),[]);
  await page.locator('[data-input-key="seed"]').fill('-1');await page.keyboard.press('Escape');
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===2,'Turbo request missing');
  assert.equal(backend.requests[1].inputs.seed,-1);assert.equal(backend.requests[1].inputs.voice,undefined);
  assert.equal(backend.requests[1].inputs.builtin_voice,undefined);assert.equal(backend.requests[1].options.x_vector_only_mode,undefined);
}]);

cases.push(['TTS speaker references preserve positions and stay isolated between models',async(page,backend)=>{
  for(const [id,family,first,allow_empty] of [['tts-two','moss_ttsd',1,true],['tts-one','vibevoice',0,false]])Object.assign(backend.models.find(m=>m.id===id),{
    family,voice_mode:'reference',streaming:false,languages:[],parameters:[],tts_controls:{speakers:{first,allow_empty}},
    profile:{accepts_voice_reference:true,send_reference_text:allow_empty,require_voice:false,send_seed:true,send_max_tokens:false}});
  backend.voices.push({name:'speaker.wav',label:'第二位说话人',text:'第二位的原文',url:`${API}/references/speaker.wav/audio`});
  await page.locator('[data-route="references"]').click();await task(page,'tts');await pick(page,'tts-two');
  await page.locator('[data-input-key="builtin_voice"]').selectOption('speaker.wav');
  await page.locator('#multi-speaker-references').check();
  assert.equal(await page.locator('.tts-reference-group').isVisible(),false);
  await page.getByLabel('[S2] 音频库',{exact:true}).selectOption('speaker.wav');
  await page.locator('[data-input-key="text"]').fill('[S1] 你好。[S2] 很高兴见到你。');
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'MOSS reference request missing');
  assert.deepEqual(backend.requests[0].inputs.speaker_references,[{voice:''},{builtin_voice:'speaker.wav'}]);
  assert.equal(backend.requests[0].inputs.builtin_voice,undefined);assert.equal(backend.requests[0].inputs.reference_text,undefined);
  backend.finish('job-1','',['dialogue.wav']);await waitText(page,'#job-status','dialogue.wav');
  await snapshot(page,'tts-moss-speakers-desktop');
  await page.setViewportSize({width:390,height:844});await assertBrowserScroll(page);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await snapshot(page,'tts-moss-speakers-mobile');
  await page.setViewportSize({width:1440,height:1000});await pick(page,'tts-one');
  assert.equal(await page.locator('#multi-speaker-references').isChecked(),false);
  await page.locator('#multi-speaker-references').check();
  await page.getByLabel('Speaker 1 音频库',{exact:true}).selectOption('speaker.wav');
  await page.locator('[data-input-key="text"]').fill('Speaker 0: Hello.\nSpeaker 1: Hi.');
  await page.locator('#run-button').click();await waitText(page,'#job-status','不能跳过空位');
  assert.equal(backend.requests.length,1);
  await page.getByLabel('Speaker 0 音频库',{exact:true}).selectOption('speaker.wav');
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===2,'VibeVoice reference request missing');
  assert.equal(backend.requests[1].inputs.speaker_references.length,2);
  backend.finish('job-2','',['vibe.wav']);await waitText(page,'#job-status','vibe.wav');
  await pick(page,'tts-two');assert.equal(await page.getByLabel('[S2] 音频库',{exact:true}).inputValue(),'speaker.wav');
  await page.getByLabel('[S2] 音频库',{exact:true}).selectOption('');
  await page.locator('#input-tts-speaker_1').setInputFiles({name:'uploaded-speaker.wav',mimeType:'audio/wav',buffer:wav()});
  await waitUntil(()=>backend.uploads.length===1,'Speaker upload missing');
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===3,'Uploaded speaker request missing');
  assert.equal(backend.requests[2].inputs.speaker_references[1].voice,backend.uploads[0].id);
  assert.equal(backend.requests[2].inputs.speaker_references[1].builtin_voice,undefined);
}]);

cases.push(['runtime precision distinguishes defaults, package format and explicit conversion', async (page, backend) => {
  const prefix='session_options.index_tts2.',selector=name=>`#param-session_options-index_tts2-${name}`;
  Object.assign(backend.models.find(m=>m.id==='tts-two'),{family:'index_tts2',format:'gguf',precision:'q8_0',parameters:[
    {name:prefix+'weight_type',label:'权重加载格式',type:'choice',choices:['native','f32','f16','bf16','q8_0'],default:'f16',scope:'session',level:'expert',runtime_group:'common'},
    {name:prefix+'mem_saver',label:'节省显存',type:'bool',default:true,scope:'session',level:'expert',runtime_group:'common'},
    {name:prefix+'conv_weight_type',label:'卷积权重格式',type:'choice',choices:['native','f32','f16'],scope:'session',level:'expert',runtime_group:'advanced'},
    {name:prefix+'graph_arena_mb',label:'计算图内存（MB）',type:'number',min:1,scope:'session',level:'expert',runtime_group:'advanced'},
  ]});
  await pick(page,'tts-two');assert.equal(backend.loads.at(-1).options[prefix+'weight_type'],undefined);
  await advanced(page);await waitText(page,'.runtime-package','GGUF · Q8_0');
  assert.equal(await page.locator(selector('weight_type')).inputValue(),'');
  assert.equal(await page.locator(selector('mem_saver')).inputValue(),'');
  assert.equal(await page.locator(selector('conv_weight_type')).isVisible(),false);
  const before=backend.loads.length;
  await page.locator(selector('weight_type')).selectOption('native');
  await page.locator(selector('mem_saver')).selectOption('false');
  assert.equal(backend.loads.length,before,'Editing precision must not reload');
  await page.locator('#apply-model-settings').click();await waitUntil(()=>backend.loads.length===before+1,'Explicit precision reload missing');
  assert.equal(backend.loads.at(-1).options[prefix+'weight_type'],'native');
  assert.equal(backend.loads.at(-1).options[prefix+'mem_saver'],false);
  await advanced(page);await page.locator(selector('weight_type')).selectOption('f32');
  await page.locator('.runtime-details summary').click();
  assert.deepEqual(await page.locator(selector('conv_weight_type')+' option').evaluateAll(items=>items.map(el=>el.value)),['','native','f32','f16']);
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:width===390?844:1000});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await assertVisibleControl(page,selector('conv_weight_type'),'Runtime precision control clipped');
    assert.ok(await page.locator('.runtime-grid .field-group').evaluateAll(items=>items.every(el=>el.scrollWidth<=el.clientWidth+1)));
    await page.locator('#apply-model-settings').click({trial:true});
    await assertVisibleControl(page,'#apply-model-settings','Runtime settings footer clipped');
    await snapshot(page,`runtime-precision-${width}`);
  }
  await page.locator('#apply-model-settings').click();await waitUntil(()=>backend.loads.length===before+2,'F32 reload missing');
  assert.equal(backend.loads.at(-1).options[prefix+'weight_type'],'f32');
  await advanced(page);await page.locator(selector('weight_type')).selectOption('');await page.locator(selector('mem_saver')).selectOption('');
  await page.locator('#apply-model-settings').click();await waitUntil(()=>backend.loads.length===before+3,'Default reset reload missing');
  assert.equal(backend.loads.at(-1).options[prefix+'weight_type'],undefined);
  assert.equal(backend.loads.at(-1).options[prefix+'mem_saver'],undefined);
}]);

cases.push(['runtime controls update nested JSON in every workspace and reject unsupported formats', async (page, backend) => {
  for(const [route,id] of [['asr','asr-one'],['music','music-one'],['vc','voice-convert'],['design','voice-design']]){
    const entry=backend.models.find(m=>m.id===id);entry.parameters=[{name:'session_options.demo.weight_type',label:'权重加载格式',type:'choice',choices:['native','f32'],scope:'session',level:'expert',runtime_group:'common'}];
    await task(page,route);await pick(page,id);await advanced(page);
    await page.locator('#options-json').fill('{"session_options":{"demo.weight_type":"f32"}}');
    await page.locator('#finish-model-settings').click();await advanced(page);
    const input=page.locator('#param-session_options-demo-weight_type');
    assert.equal(await input.inputValue(),'f32',route);
    await input.selectOption('native');assert.equal(JSON.parse(await page.locator('#options-json').inputValue()).session_options['demo.weight_type'],'native',route);
    await input.selectOption('');assert.equal(JSON.parse(await page.locator('#options-json').inputValue()).session_options['demo.weight_type'],undefined,route);
    await page.locator('#options-json').fill('{"session_options":{"demo.weight_type":"q8_0"}}');
    const loads=backend.loads.length;await page.locator('#apply-model-settings').click();await waitText(page,'#toast','不支持 q8_0');assert.equal(backend.loads.length,loads);
    await advanced(page);await page.locator('#reset-options').click();await page.locator('#finish-model-settings').click();
  }
}]);

cases.push(['SpeakType scenario starts native dictation and keeps it across navigation', async (page, backend) => {
  const data={available:true,active:false,running:false,message:'尚未启动',model:null,
    models:[{id:'asr-one',label:'ASR One',languages:['auto','zh','en'],language_default:'auto'},
      {id:'crisper',label:'CrisperWhisper',languages:['en','zh'],language_default:'en'},
      {id:'moonshine',label:'Moonshine',languages:[''],language_default:'',language_fixed:true,supported_languages:['en']}],default_model:'asr-one',language:'auto',
    toggle_hotkey:'ctrl+shift+space',cancel_hotkey:'esc'};
  const calls=[];
  await page.route('**/api/workbench/speaktype{,/**}', async route=>{
    const request=route.request(),pathname=new URL(request.url()).pathname;
    if(pathname.endsWith('/start')){
      calls.push(request.postDataJSON());Object.assign(data,{active:true,running:true,message:'已启动'});
    }else if(pathname.endsWith('/stop'))Object.assign(data,{active:false,running:false,message:'已退出'});
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.locator('[data-route="scenarios"]').first().click();
  await page.locator('[data-scenario="speaktype"]').click();
  await waitText(page,'#speaktype-toggle','ctrl+shift+space');
  await page.locator('#speaktype-model').selectOption('crisper');
  assert.equal(await page.locator('#speaktype-language').inputValue(),'en');
  assert.equal(await page.locator('#speaktype-language option[value="auto"]').count(),0);
  await page.locator('#speaktype-model').selectOption('moonshine');
  assert.equal(await page.locator('#speaktype-language').isDisabled(),true);
  assert.match(await page.locator('#speaktype-language').textContent(),/英语/);
  await page.locator('#speaktype-model').selectOption('asr-one');
  await page.locator('#speaktype-language').selectOption('zh');
  await page.locator('#speaktype-start').click();await waitText(page,'#speaktype-status','已启动');
  assert.deepEqual(calls,[{model:'asr-one',language:'zh',ui_language:'zh'}]);
  assert.equal(await page.locator('#speaktype-start').isDisabled(),true);
  assert.equal(await page.locator('#speaktype-model').isDisabled(),true);
  await snapshot(page,'speaktype-desktop');
  await page.locator('[data-route="scenarios"]').first().click();
  assert.equal(data.running,true);
  await page.locator('[data-scenario="speaktype"]').click();await waitText(page,'#speaktype-status','已启动');
  await page.setViewportSize({width:390,height:844});
  await assertVisibleControl(page,'#speaktype-stop','SpeakType stop clipped');
  await snapshot(page,'speaktype-mobile');
  await page.locator('#speaktype-stop').click();await waitText(page,'#speaktype-status','已退出');
  data.models=[];await page.locator('#speaktype-refresh').click();await waitText(page,'#speaktype-status','模型中心');
  assert.equal(await page.locator('#speaktype-start').isDisabled(),true);
}]);

cases.push(['interface language preserves drafts, runtime and request values', async (page, backend) => {
  const draft='语音合成';
  await page.locator('#input-tts-text').fill(draft);
  const loaded=backend.loads.length;
  await page.locator('[data-route="settings"]').first().click();
  await page.locator('#ui-language').selectOption('en');
  assert.equal(await page.locator('html').getAttribute('lang'),'en');
  assert.equal(await page.locator('#settings-heading').textContent(),'Settings');
  assert.equal(await page.locator('#theme-select').inputValue(),'light');
  assert.equal(await page.locator('#input-tts-text').inputValue(),draft);
  assert.equal(backend.loads.length,loaded,'language switch must not reload a model');
  await page.locator('[data-route="tts"]').first().click();
  assert.equal(await page.locator('#input-tts-text').inputValue(),draft);
  assert.equal(await page.locator('#run-button').textContent(),'Generate Speech');
  await page.locator('#run-button').click();
  await waitUntil(()=>backend.requests.length===1,'English UI did not submit');
  assert.equal(backend.requests[0].model,'tts-one');
  assert.equal(backend.requests[0].inputs.text,draft);
  backend.finish('job-1',draft,[]);
  await waitValue(page,'#result-content textarea',draft);
  const privacy=await page.evaluate(async()=>{
    const {html,applyLanguage,uiText,setLanguage}=await import('/workbench-static/i18n.js');
    const root=document.createElement('div'),userText='语音合成';
    root.innerHTML=html`<label>原文</label><textarea>${userText}</textarea><p>${userText}</p>`;
    document.body.append(root);applyLanguage(root);
    const result={label:root.querySelector('label').textContent,input:root.querySelector('textarea').value,text:root.querySelector('p').textContent};
    const label=root.querySelector('label'),badge=document.createElement('b');uiText(badge,'需重载');label.append(badge);setLanguage('zh');setLanguage('en');
    result.badge=badge.isConnected&&badge.textContent;root.remove();return result;
  });
  assert.deepEqual(privacy,{label:'Source',input:draft,text:draft,badge:'Reload'});
  backend.voices.push({name:'user.wav',label:draft,text:draft});
  await page.locator('[data-route="references"]').first().click();
  await waitText(page,'.reference-row-heading strong',draft);
  assert.equal(await page.locator('.reference-transcript').textContent(),draft);
  await page.locator('[data-route="settings"]').first().click();
  await page.locator('#ui-language').selectOption('zh');
  assert.equal(await page.locator('#settings-heading').textContent(),'系统设置');
  assert.equal(await page.locator('#run-button').textContent(),'生成语音');
  assert.equal(await page.locator('#input-tts-text').inputValue(),draft);
  assert.equal(await page.locator('#result-content textarea').inputValue(),draft);
  await page.locator('#ui-language').selectOption('en');
  await page.setViewportSize({width:390,height:844});
  await assertVisibleControl(page,'#ui-language','Language selector clipped');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(el=>el.getClientRects().length&&el.getBoundingClientRect().right>innerWidth+1).map(el=>[el.tagName,el.id,el.className,el.getBoundingClientRect().right]).slice(0,12))));
  await snapshot(page,'settings-english-mobile');
  await page.reload();
  assert.equal(await page.locator('#ui-language').inputValue(),'en');
  assert.equal(await page.locator('#settings-heading').textContent(),'Settings');
}]);

cases.push(['upstream parameter aliases preserve saved ASR values and nested runtime settings',async(page,backend)=>{
  const entry=backend.models.find(m=>m.id==='asr-one');
  entry.parameters=[{name:'pnc',label:'标点',type:'bool',default:true,level:'basic',scope:'request'}];
  await task(page,'asr','ASR One');
  await page.locator('#param-pnc').uncheck();
  await task(page,'tts');
  entry.option_aliases={pnc:'punc','load_options.demo.mem_saver':'session_options.demo.mem_saver'};
  entry.parameters=[{name:'punc',label:'标点',type:'bool',default:true,level:'basic',scope:'request'},
    {name:'session_options.demo.mem_saver',label:'节省显存',type:'choice',choices:['true','false'],level:'expert',scope:'session'}];
  await task(page,'asr','ASR One');
  assert.equal(await page.locator('#param-punc').isChecked(),false,'Saved false must survive the rename');
  await upload(page,'#task-form [data-input-key="audio"]','migration.wav');await advanced(page);
  await page.locator('#options-json').fill('{"pnc":true,"punc":false,"load_options":{"demo.mem_saver":true}}');
  await waitValue(page,'#param-session_options-demo-mem_saver','true');
  assert.equal(await page.locator('#param-punc').isChecked(),false,'Current spelling wins over a stale alias');
  await page.locator('#param-session_options-demo-mem_saver').selectOption('false');
  await page.keyboard.press('Escape');
  if(await page.locator('#workspace-load').textContent()!=='已加载')await page.locator('#workspace-load').click();
  await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'Migrated ASR request missing');
  assert.equal(backend.requests[0].options.punc,false);
  assert.equal(backend.requests[0].options.pnc,undefined);
  assert.equal(backend.requests[0].options['session_options.demo.mem_saver'],'false');
  assert.equal(backend.requests[0].options.load_options?.['demo.mem_saver'],undefined);
}]);

cases.push(['upstream review VC saved aliases yield one editable canonical request',async(page,backend)=>{
  Object.assign(backend.models.find(m=>m.id==='voice-convert'),{
    family:'seed_vc',profile:{accepts_voice_reference:false,send_seed:false},
    option_aliases:{length_adjust:'duration_scale'},
    parameters:[{name:'duration_scale',label:'时长伸缩',type:'number',default:1,min:.05,level:'effect',scope:'request'}],
  });
  await task(page,'vc','Voice conversion');await upload(page,'#task-form [data-input-key="audio"]','source.wav');
  assert.equal(await page.locator('#param-length_adjust').count(),0);
  await advanced(page);await page.locator('#options-json').fill('{"length_adjust":1.1,"duration_scale":1.4}');
  await page.keyboard.press('Escape');await waitValue(page,'#param-duration_scale','1.4');
  await page.locator('#param-duration_scale').fill('1.6');
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'Migrated conversion missing');
  assert.equal(backend.requests[0].options.duration_scale,1.6);
  assert.equal(backend.requests[0].options.length_adjust,undefined);
}]);

cases.push(['upstream review RVC canonical index validates and no-index clears it',async(page,backend)=>{
  Object.assign(backend.models.find(m=>m.id==='voice-convert'),{
    family:'rvc',voice_mode:'rvc',profile:{model_as_target_voice:true,accepts_voice_reference:false,send_seed:false},
    option_aliases:{retrieval_index_path:'retrieval_index_file'},
    parameters:presetParameters('rvc').map(p=>p.name==='retrieval_index_path'?{...p,name:'retrieval_index_file'}:p),
  });
  await task(page,'vc','Voice conversion');await upload(page,'#task-form [data-input-key="audio"]','source.wav');
  await page.locator('[data-input-key="rvc_use_builtin"]').uncheck();
  await page.locator('[data-input-key="rvc_no_index"]').uncheck();
  await advanced(page);await page.locator('#param-voice_model_path').fill('custom.pth');
  await page.locator('#param-retrieval_index_file').fill('custom.index');await page.keyboard.press('Escape');
  await page.locator('#param-retrieval_blend').evaluate(input=>{input.value='.6';input.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'Canonical RVC index incorrectly rejected');
  assert.equal(backend.requests[0].options.retrieval_index_file,'custom.index');
  assert.equal(backend.requests[0].options.retrieval_index_path,undefined);
  backend.finish('job-1','',['converted.wav']);await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
  await page.locator('[data-input-key="rvc_no_index"]').check();await advanced(page);
  assert.equal(await page.locator('#param-retrieval_index_file').isDisabled(),true);
  await page.keyboard.press('Escape');await page.locator('#run-button').click();
  await waitUntil(()=>backend.requests.length===2,'No-index conversion missing');
  assert.equal(backend.requests[1].options.retrieval_index_file,undefined);
  assert.equal(backend.requests[1].options.retrieval_index_path,undefined);
  assert.equal(backend.requests[1].options.retrieval_blend,0);
}]);

cases.push(['upstream review DotTTS Edit restores visible instructions without streaming',async(page,backend)=>{
  Object.assign(backend.models.find(m=>m.id==='tts-one'),{
    family:'dots_tts',streaming:false,voice_mode:'reference',
    profile:{accepts_voice_reference:true,require_voice:true,voice_input_role:'source_audio',send_reference_text:false,send_seed:false},
    option_aliases:{instruction:'instruct'},
    parameters:[{name:'instruct',label:'编辑指令',type:'text',rows:2,level:'expert',scope:'request'}],
  });
  await page.reload();await task(page,'tts','TTS One');
  assert.equal(await page.locator('[data-input-key="stream"]').count(),0);
  await advanced(page);await page.locator('#options-json').fill('{"instruction":"old edit"}');await page.keyboard.press('Escape');
  await pick(page,'tts-two');await pick(page,'tts-one');await advanced(page);
  await waitValue(page,'#param-instruct','old edit');assert.equal(await page.locator('#param-instruction').count(),0);
  await page.locator('#param-instruct').fill('updated edit');await page.keyboard.press('Escape');
  await page.locator('[data-input-key="text"]').fill('Target text.');
  await upload(page,'#task-form [data-input-key="voice"]','source.wav');
  await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'Offline Edit request missing');
  assert.equal(backend.requests[0].options.instruct,'updated edit');
  assert.equal(backend.requests[0].options.instruction,undefined);
  assert.equal(Boolean(backend.requests[0].inputs.stream),false);
}]);

function mobileRealtimeConfig(backend){
  backend.realtimeConfig={api_base:'/api/realtime',tts_model:'tts-one',asr_model:'asr-one',llm_model:'fixture-chat',
    tts_models:['tts-one','tts-two'].map(id=>({id,label:id,family:'supertonic',accepts_voice_reference:false,
      voice_parameter:'voice',voices:[{label:'F1',value:'F1'},{label:'F2',value:'F2'}]})),
    asr_models:[{id:'asr-one',label:'ASR One'},{id:'asr-two',label:'ASR Two'}]};
}
async function openMobileSettings(page,backend){
  mobileRealtimeConfig(backend);
  await page.evaluate(()=>{location.hash='settings/mobile';});
  await page.locator('#settings-mobile').waitFor({state:'visible'});
  await waitText(page,'#mobile-config-state','已同步');
  return page.frameLocator('#realtime-frame');
}
async function editMobileSettings(page){
  await page.locator('#mobile-edit').click();
  const frame=page.frameLocator('#realtime-frame');
  await frame.locator('#settings-modal[open]').waitFor();
  return frame;
}
async function changeRealtimeLlm(frame,value){
  await frame.locator('[data-settings-tab="llm"]').click();
  await frame.locator('#llm-model').fill(value);
  await frame.locator('#settings-save').click();
  await frame.locator('#settings-modal[open]').waitFor({state:'hidden'});
}

cases.push(['mobile voice settings return to their entry and sync with one save',async(page,backend)=>{
  await openMobileSettings(page,backend);
  assert.equal(await page.locator('#mobile-save').count(),0);
  assert.equal(await page.locator('#mobile-enabled').isChecked(),false);
  assert.deepEqual(backend.mobileToggles||[],[],'Opening mobile settings must not enable LAN access');
  const frame=await editMobileSettings(page);
  await frame.locator('[data-character-id="office"]').click();
  await frame.locator('#character-name').fill('手机助手');
  await frame.locator('[data-settings-tab="tts"]').click();
  await frame.locator('#tts-model').selectOption('tts-two');
  await frame.locator('#tts-voice').selectOption('F2');
  await frame.locator('[data-settings-tab="asr"]').click();
  await frame.locator('#asr-model').fill('asr-two');
  await frame.locator('[data-settings-tab="llm"]').click();
  await frame.locator('#llm-key').fill('fixture-mobile-key-not-a-real-credential');
  await changeRealtimeLlm(frame,'fixture-chat-two');
  await waitUntil(()=>backend.mobileConfig?.character.name==='手机助手','Saved character did not sync');
  assert.equal(backend.mobileConfig.character.id,'office');
  assert.equal(backend.mobileConfig.config.tts_model,'tts-two');
  assert.equal(backend.mobileConfig.config.asr_model,'asr-two');
  assert.equal(backend.mobileConfig.config.llm_model,'fixture-chat-two');
  assert.equal(backend.mobileConfig.config.llm_api_key,'fixture-mobile-key-not-a-real-credential');
  assert.deepEqual(backend.mobileConfig.config.tts_options,{voice:'F2'});
  await frame.locator('#scene-back').click();
  await page.locator('#settings-mobile').waitFor({state:'visible'});
  assert.equal(new URL(page.url()).hash,'#settings/mobile');
  await waitText(page,'#mobile-summary','手机助手 · asr-two · fixture-chat-two · tts-two');
  await waitText(page,'#mobile-config-state','已同步');
  assert.equal(await page.locator('#mobile-enabled').isChecked(),false);
  assert.deepEqual(backend.mobileToggles||[],[]);
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await snapshot(page,'mobile-settings-auto-sync');
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('[data-route="scenarios"]').click();
  await page.locator('[data-scenario="realtime-chat"]').click();
  await frame.locator('#scene-back').click();
  await page.locator('#page-scenarios').waitFor({state:'visible'});
  assert.equal(new URL(page.url()).hash,'#scenarios','A previous mobile visit must not affect the scene entry');
}]);

cases.push(['mobile voice settings also follow saves from the scenario entry',async(page,backend)=>{
  mobileRealtimeConfig(backend);
  await page.locator('[data-route="scenarios"]').click();
  await page.locator('[data-scenario="realtime-chat"]').click();
  const frame=page.frameLocator('#realtime-frame');
  await frame.locator('#call-more summary').click();
  await frame.locator('#settings-btn').click();
  await changeRealtimeLlm(frame,'saved-from-scene');
  await waitUntil(()=>backend.mobileConfig?.config.llm_model==='saved-from-scene','Scene settings did not sync');
  await frame.locator('#scene-back').click();
  await page.locator('#page-scenarios').waitFor({state:'visible'});
  await page.evaluate(()=>{location.hash='settings/mobile';});
  await waitText(page,'#mobile-summary','saved-from-scene');
  await waitText(page,'#mobile-config-state','已同步');
  assert.deepEqual(backend.mobileToggles||[],[]);
}]);

cases.push(['mobile voice settings ignore cancelled drafts and their unsaved credentials',async(page,backend)=>{
  await openMobileSettings(page,backend);
  const before=clone(backend.mobileConfig),count=backend.mobileSaves.length;
  const frame=await editMobileSettings(page);
  await frame.locator('[data-character-id="living"]').click();
  await frame.locator('#character-name').fill('未保存的角色');
  await frame.locator('[data-settings-tab="llm"]').click();
  await frame.locator('#llm-model').fill('unsaved-model');
  await frame.locator('#llm-key').fill('unsaved-key');
  await frame.locator('.modal-footer [value="close"]').click();
  assert.equal(backend.mobileSaves.length,count,'Cancelling must not sync the draft');
  await frame.locator('#scene-back').click();
  await page.locator('#settings-mobile').waitFor({state:'visible'});
  await waitText(page,'#mobile-config-state','已同步');
  assert.deepEqual(backend.mobileConfig,before);
  assert.equal(backend.mobileSaves.length,count,'Returning after cancel must keep the saved configuration');
}]);

cases.push(['mobile voice settings serialize quick saves so the latest configuration wins',async(page,backend)=>{
  await openMobileSettings(page,backend);
  backend.mobileRunning=true;
  const frame=await editMobileSettings(page),gate=deferred(),count=backend.mobileSaves.length;
  backend.mobileSaveGate=gate;
  await changeRealtimeLlm(frame,'first-save');
  await waitUntil(()=>backend.mobileSaves.length>count,'First mobile save was not submitted');
  await frame.locator('#call-more summary').click();await frame.locator('#settings-btn').click();
  await changeRealtimeLlm(frame,'latest-save');
  assert.equal(backend.mobileSaves.length,count+1,'Only one configuration request may be in flight');
  gate.resolve();
  await waitUntil(()=>backend.mobileConfig?.config.llm_model==='latest-save','Latest configuration was lost');
  await frame.locator('#scene-back').click();
  await page.locator('#settings-mobile').waitFor({state:'visible'});
  await waitText(page,'#mobile-summary','latest-save');
  await waitText(page,'#mobile-config-state','已同步');
  assert.equal(await page.locator('#mobile-enabled').isChecked(),true,'Syncing must keep the existing LAN state');
  assert.deepEqual(backend.mobileToggles||[],[]);
}]);

cases.push(['mobile voice settings show sync failures and retry the saved configuration on return',async(page,backend)=>{
  await openMobileSettings(page,backend);
  const previous=clone(backend.mobileConfig),frame=await editMobileSettings(page);
  backend.mobileSaveError=true;backend.expectedHttpErrors++;
  await changeRealtimeLlm(frame,'retry-saved-model');
  await waitText(page,'#mobile-config-state','语音配置同步失败');
  assert.deepEqual(backend.mobileConfig,previous,'A failed sync must not change the server snapshot');
  assert.equal(await frame.locator('body').evaluate(()=>localStorage.getItem('audiocpp.llm.model')),'retry-saved-model');
  backend.mobileSaveError=false;
  await frame.locator('#scene-back').click();
  await page.locator('#settings-mobile').waitFor({state:'visible'});
  await waitText(page,'#mobile-config-state','已同步');
  await waitText(page,'#mobile-summary','retry-saved-model');
  assert.deepEqual(backend.mobileToggles||[],[]);
}]);

cases.push(['mobile voice settings keep direct realtime links and home returns usable',async(page)=>{
  await page.goto(`${ORIGIN}/#scenarios/realtime-chat`);
  await page.reload();
  const frame=page.frameLocator('#realtime-frame');
  await frame.locator('#scene-back').click();
  await page.locator('#page-scenarios').waitFor({state:'visible'});
  await page.locator('a.brand[href="#home"]').click();
  await page.locator('.home-shortcut[data-route="scenarios/realtime-chat"]').click();
  await frame.locator('#scene-back').click();
  await page.locator('#page-home').waitFor({state:'visible'});
}]);

cases.push(['mobile voice settings preserve existing phone configuration when another browser opens settings',async(page,backend)=>{
  mobileRealtimeConfig(backend);
  backend.mobileConfig={character:{id:'office',name:'原手机助手'},config:{asr_model:'asr-two',tts_model:'tts-two',llm_model:'existing-phone-chat'}};
  const previous=clone(backend.mobileConfig);
  await page.evaluate(()=>{location.hash='settings/mobile';});
  await waitText(page,'#mobile-summary','原手机助手 · asr-two · existing-phone-chat · tts-two');
  assert.equal(await page.locator('#realtime-frame').getAttribute('src'),null,'Viewing the QR page must not load browser defaults over an existing snapshot');
  assert.deepEqual(backend.mobileSaves||[],[]);
  assert.deepEqual(backend.mobileConfig,previous);
  const frame=await editMobileSettings(page);
  await changeRealtimeLlm(frame,'explicit-new-browser-save');
  await waitUntil(()=>backend.mobileConfig.config.llm_model==='explicit-new-browser-save','An explicit save must still update mobile settings');
  assert.deepEqual(backend.mobileToggles||[],[]);
}]);

cases.push(['model input isolation discards restored credentials without changing realtime cache',async(page)=>{
  await page.addInitScript(()=>{
    localStorage.setItem('audiocpp.llm.key','fixture-realtime-key-not-a-real-credential');
    localStorage.setItem('audiocpp.realtime.characters','fixture-saved-character-cache');
    const observer=new MutationObserver(()=>{
      const search=document.getElementById('model-search'),token=document.getElementById('hf-token');
      if(search&&token){search.value='fixture-saved-character-name';token.value='fixture-realtime-key-not-a-real-credential';observer.disconnect();}
    });
    observer.observe(document,{childList:true,subtree:true});
  });
  await page.reload();await page.locator('[data-route="models"]').click();
  await page.locator('#model-list [data-model="tts-missing"]').waitFor();
  assert.equal(await page.locator('#model-search').inputValue(),'');
  assert.equal(await page.locator('#hf-token').inputValue(),'');
  assert.ok(await page.locator('#model-list [data-model]').count()>0);
  assert.equal(await page.evaluate(()=>localStorage.getItem('audiocpp.llm.key')),'fixture-realtime-key-not-a-real-credential');
  assert.equal(await page.evaluate(()=>localStorage.getItem('audiocpp.realtime.characters')),'fixture-saved-character-cache');
  await page.locator('#model-list [data-model="tts-missing"]').click();
  const request=page.waitForRequest(r=>r.url().endsWith('/api/workbench/downloads/tts-missing')&&r.method()==='POST');
  await page.locator('#model-detail').getByRole('button',{name:'下载模型',exact:true}).click();
  assert.equal((await request).postDataJSON().token,'','Realtime credentials must never become a download token');
}]);

cases.push(['model input isolation keeps only the model search query across page changes',async(page)=>{
  await page.locator('[data-route="models"]').click();await page.locator('#model-search').fill('ASR One');
  assert.equal(await page.locator('#model-list [data-model]').count(),1);
  assert.equal(await page.locator('#model-list [data-model="asr-one"]').count(),1);
  const url=page.url();await page.locator('#model-search').press('Enter');assert.equal(page.url(),url);
  await page.locator('[data-route="tts"]').click();
  await page.evaluate(()=>{document.getElementById('model-search').value='fixture-unrelated-browser-restoration';});
  await page.locator('[data-route="models"]').click();
  assert.equal(await page.locator('#model-search').inputValue(),'ASR One');
  assert.equal(await page.locator('#model-list [data-model="asr-one"]').count(),1);
  await page.reload();await page.locator('#model-search').waitFor({state:'visible'});
  assert.equal(await page.locator('#model-search').inputValue(),'','A new document must start with an independent empty query');
}]);

cases.push(['model input isolation separates search from explicitly entered download credentials',async(page)=>{
  await page.evaluate(()=>localStorage.setItem('audiocpp.llm.key','fixture-realtime-key-not-a-real-credential'));
  await page.locator('[data-route="models"]').click();
  const ownership=await page.evaluate(()=>{
    const search=document.getElementById('model-search'),token=document.getElementById('hf-token');
    return {searchForm:search.form?.id,tokenForm:token.form?.id,searchName:search.name,tokenName:token.name,
      searchAutocomplete:search.autocomplete,tokenAutocomplete:token.autocomplete};
  });
  assert.equal(ownership.searchForm,'model-search-form');assert.equal(ownership.tokenForm,'model-download-credentials');
  assert.notEqual(ownership.searchName,ownership.tokenName);assert.equal(ownership.searchAutocomplete,'off');assert.equal(ownership.tokenAutocomplete,'new-password');
  await page.locator('.download-auth summary').click();await page.locator('#hf-token').fill('fixture-hf-token-not-a-real-credential');
  const url=page.url();await page.locator('#hf-token').press('Enter');assert.equal(page.url(),url);
  await page.locator('#model-list [data-model="tts-missing"]').click();
  const request=page.waitForRequest(r=>r.url().endsWith('/api/workbench/downloads/tts-missing')&&r.method()==='POST');
  await page.locator('#model-detail').getByRole('button',{name:'下载模型',exact:true}).click();
  assert.equal((await request).postDataJSON().token,'fixture-hf-token-not-a-real-credential');
  await waitValue(page,'#hf-token','');
  assert.equal(await page.evaluate(()=>localStorage.getItem('audiocpp.llm.key')),'fixture-realtime-key-not-a-real-credential');
}]);

cases.push(['model input isolation rejects late browser autofill while preserving manual edits',async(page)=>{
  await page.locator('[data-route="models"]').click();await page.locator('#model-search').fill('ASR One');
  await page.evaluate(()=>{
    for(const [id,value] of [['model-search','fixture-unrelated-saved-role'],['hf-token','fixture-unrelated-saved-key']]){
      const input=document.getElementById(id),matches=input.matches.bind(input);
      input.matches=selector=>[':autofill',':-webkit-autofill'].includes(selector)||matches(selector);
      input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));
    }
  });
  assert.equal(await page.locator('#model-search').inputValue(),'ASR One');
  assert.equal(await page.locator('#hf-token').inputValue(),'');
  assert.equal(await page.locator('#model-list [data-model="asr-one"]').count(),1);
  await page.evaluate(()=>{for(const id of ['model-search','hf-token'])delete document.getElementById(id).matches;});
  await page.locator('#model-search').fill('TTS');assert.ok(await page.locator('#model-list [data-model="tts-one"]').count());
  await page.locator('.download-auth summary').click();await page.locator('#hf-token').fill('fixture-explicit-hf-token');
  assert.equal(await page.locator('#hf-token').inputValue(),'fixture-explicit-hf-token');
}]);

async function startStreamPlayerFixture(page,backend,seconds=4){
  await page.evaluate(()=>{
    const createGain=AudioContext.prototype.createGain;
    AudioContext.prototype.createGain=function(){const gain=createGain.call(this);window.streamTestContext=this;window.streamTestGain=gain;return gain;};
  });
  await task(page,'tts','TTS One');
  await page.locator('[data-input-key="text"]').fill('流式播放控件测试。');
  await page.locator('[data-input-key="stream"]').check();
  await page.locator('#run-button').click();
  await waitUntil(()=>backend.requests.length===1,'Streaming task was not submitted');
  backend.jobs.get('job-1').audio_segments=[{index:1,sample_rate:24000,pcm:Buffer.alloc(Math.round(24000*seconds)*2).toString('base64')}];
  await page.locator('#result-content .stream-player').waitFor({state:'visible'});
  assert.equal(backend.jobs.get('job-1').status,'running');
  assert.equal(await page.locator('#result-content audio').count(),0);
  await page.waitForFunction(()=>window.streamTestContext?.state==='running');
}

cases.push(['stream player appears before completion and controls the buffered audio',async(page,backend)=>{
  await startStreamPlayerFixture(page,backend);
  await page.locator('.stream-player button').click();
  await page.waitForFunction(()=>window.streamTestContext.state==='suspended');
  const paused=await page.locator('.stream-player progress').evaluate(el=>el.value);
  await page.waitForTimeout(350);
  assert.ok(Math.abs(await page.locator('.stream-player progress').evaluate(el=>el.value)-paused)<0.02,'Pausing must stop playback progress');
  await page.locator('.stream-player').evaluate(el=>{window.streamTestPlayer=el;});
  backend.jobs.get('job-1').audio_segments.push({index:2,sample_rate:16000,pcm:Buffer.alloc(16000*3*2).toString('base64')});
  await page.waitForFunction(()=>document.querySelector('.stream-player progress')?.max===7);
  assert.equal(await page.locator('.stream-player').evaluate(el=>el===window.streamTestPlayer),true,'Polling must preserve the player');
  assert.equal(await page.evaluate(()=>window.streamTestContext.state),'suspended');
  await page.locator('.stream-player input').evaluate(el=>{el.value='0.25';el.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.ok(Math.abs(await page.evaluate(()=>window.streamTestGain.gain.value)-0.25)<0.001,'Volume must control the actual audio output');
  await page.locator('.stream-player button').click();
  await page.waitForFunction(()=>window.streamTestContext.state==='running');
  await page.waitForFunction(value=>document.querySelector('.stream-player progress').value>value+0.1,paused);
  await page.locator('.stream-player button').click();
  await page.waitForFunction(()=>window.streamTestContext.state==='suspended');
  await page.evaluate(()=>window.dispatchEvent(new StorageEvent('storage',{key:'audiocpp-ui-language',newValue:'en'})));
  assert.equal(await page.locator('.stream-player button').textContent(),'Play');
  assert.equal(await page.locator('.stream-player input').getAttribute('aria-label'),'Volume');
  if(await page.locator('#workspace-settings').isVisible())await page.locator('#parameter-toggle').click();
  for(const width of [390,320]){
    await page.setViewportSize({width,height:900});await page.locator('.stream-player').scrollIntoViewIfNeeded();
    const layout=await page.locator('.stream-player').evaluate(el=>({left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,overflow:el.scrollWidth>el.clientWidth+1,width:innerWidth}));
    assert.ok(layout.left>=0&&layout.right<=layout.width+1&&!layout.overflow,'Live player must fit narrow screens');
    await assertVisibleControl(page,'.stream-player button','Pause/resume control clipped');
    await assertVisibleControl(page,'.stream-player input','Volume control clipped');
    await snapshot(page,`stream-player-${width}`);
  }
  backend.finish('job-1','',['speech.wav']);await page.waitForFunction(()=>document.querySelector('#job-status').dataset.state==='done');
  assert.equal(await page.locator('.stream-player').isVisible(),true,'Completed generation must keep paused audio controllable');
  assert.equal(await page.locator('#job-status a[download="speech.wav"]').count(),1,'Complete audio must remain downloadable');
  await page.locator('#stop-stream-playback').click();
  await page.locator('#result-content audio').waitFor({state:'visible'});
  assert.equal(await page.locator('.stream-player').count(),0);
  assert.equal(await page.evaluate(()=>window.streamTestContext.state),'closed');
  assert.equal(await page.locator('#result-content audio').evaluate(el=>el.controls&&el.paused),true);
}]);

cases.push(['stream player closes when generation is cancelled',async(page,backend)=>{
  await startStreamPlayerFixture(page,backend);
  await page.locator('#cancel-job').click();
  Object.assign(backend.jobs.get('job-1'),{status:'cancelled',message:'任务已停止。',audio_segments:[]});backend.status.busy=false;backend.status.job=null;
  await waitText(page,'#job-status','任务已停止。');
  assert.equal(await page.locator('.stream-player').count(),0);
  assert.equal(await page.locator('#stop-stream-playback').isVisible(),false);
  assert.equal(await page.evaluate(()=>window.streamTestContext.state),'closed');
}]);

cases.push(['stream player hands off to the complete file without replaying it',async(page,backend)=>{
  await startStreamPlayerFixture(page,backend,0.3);
  backend.finish('job-1','',['speech.wav']);
  await page.locator('#result-content audio').waitFor({state:'visible'});
  assert.equal(await page.locator('.stream-player').count(),0);
  assert.equal(await page.evaluate(()=>window.streamTestContext.state),'closed');
  assert.equal(await page.locator('#result-content audio').evaluate(el=>el.paused&&el.currentTime===0),true,'Completing the stream must not autoplay the file a second time');
}]);

(async () => {
  const options = {headless:true};
  if (process.env.AUDIOCPP_BROWSER_EXECUTABLE) options.executablePath = process.env.AUDIOCPP_BROWSER_EXECUTABLE;
  const browser = await chromium.launch(options);
  let failures = 0;
  try {
    const selected = cases.filter(([name]) => !process.env.AUDIOCPP_BROWSER_TEST_FILTER || name.includes(process.env.AUDIOCPP_BROWSER_TEST_FILTER));
    assert.ok(selected.length, 'AUDIOCPP_BROWSER_TEST_FILTER matched no cases');
    for (const [name, run] of selected) {
      const backend = fixture();
      if (!name.startsWith('model dropdown') && !name.startsWith('unloaded')) backend.status.server.model='tts-one';
      const context = await browser.newContext({viewport:{width:1440,height:1000}, serviceWorkers:'block'});
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {if (message.type() === 'error') {if(backend.expectedHttpErrors&&/status of (400|500|503|409)/.test(message.text())){backend.expectedHttpErrors--;return;}errors.push(message.text());}});
      await page.route('**/*', async route => {
        try {await backend.route(route);}
        catch (error) {backend.errors.push(error.stack || String(error)); await route.abort('failed').catch(()=>{});}
      });
      try {
        await page.goto(`${ORIGIN}/#tts`);
        await waitText(page, '#model-picker-label', backend.status.server.model?'TTS One':'选择语音合成模型');
        await page.locator('#model-picker-list [data-model="tts-one"]').waitFor({state:'attached'});
        if(backend.status.server.model)await page.locator('#parameter-toggle').waitFor({state:'visible'});
        await run(page, backend);
        assert.deepEqual(backend.errors, [], 'Unexpected network or fixture errors');
        assert.deepEqual(errors, [], 'Browser console/page errors');
        console.log(`PASS ${name}`);
      } catch (error) {
        failures++;
        console.error(`FAIL ${name}\n${error.stack || error}`);
        console.error('UI feedback:',await page.locator('#toast').textContent());
        await snapshot(page,`failure-${name.replace(/[^a-z0-9]+/gi,'-')}`).catch(()=>{});
        if (errors.length || backend.errors.length) console.error(JSON.stringify({browser:errors, network:backend.errors}, null, 2));
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  const count = cases.filter(([name]) => !process.env.AUDIOCPP_BROWSER_TEST_FILTER || name.includes(process.env.AUDIOCPP_BROWSER_TEST_FILTER)).length;
  console.log(`Workbench browser regression: ${count - failures}/${count} passed`);
  if (failures) process.exitCode = 1;
})().catch(error => {console.error(error); process.exitCode = 1;});
