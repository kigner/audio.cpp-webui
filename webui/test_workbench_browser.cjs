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
    installable:true, description:`Fixture ${label}`, backend:'cpu', format:'GGUF',
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
    ], ...extra};
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
    uploadGates:new Map(), submitGate:null, jobPolls:new Map(), errors:[], voices:[], referenceRequests:[], referenceSaves:[], unloads:[]};
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
      // Use the real markup/styles and presentation controls without inference/session scripts.
      let body=await fs.readFile(full);
      if(file==='index.html')body=Buffer.from(body.toString('utf8').replace(/<script[^>]+src="[^"]+"[^>]*><\/script>/g,'')+'<script type="module" src="scene.js"></script>');
      const contentType={'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png'}[path.extname(full)]||'application/octet-stream';
      return route.fulfill({status:200,contentType,body});
    }
    if(pathname==='/api/realtime/config'||pathname==='/config')return json({});
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
      state.voices=state.voices.filter(v=>v.name!==name);state.voices.push({name,label:name.slice(0,-4),text:body.text,url:`${API}/references/${encodeURIComponent(name)}/audio`});return json({name,voices:state.voices,message:'参考音频已保存。'});
    }
    const reference=/^\/api\/workbench\/references\/([^/]+)(\/audio)?$/.exec(pathname);
    if(reference){if(reference[2])return route.fulfill({status:200,contentType:'audio/wav',body:wav()});state.voices=state.voices.filter(v=>v.name!==decodeURIComponent(reference[1]));return json({voices:state.voices,message:'参考音频已删除。'});}
    if (pathname === `${API}/downloads`) return json({downloads:[]});
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
      const name = /filename="([^"]+)"/.exec(request.postDataBuffer()?.toString('utf8') || '')?.[1] || 'fixture.wav';
      const upload = {id:`upload-${state.uploads.length+1}`, name};
      state.uploads.push(upload);
      if (state.uploadGates.has(name)) await state.uploadGates.get(name).promise;
      return json(upload);
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
    const reference=page.locator('#task-inputs .reference-source-tabs');
    if(await reference.count())await reference.getByRole('button',{name:'上传 / 录音',exact:true}).click();
  }
  await page.locator(selector).setInputFiles({name, mimeType:'audio/wav', buffer:wav(marker)});
  await page.waitForFunction(({selector,name})=>(document.querySelector(selector)?.closest('.reference-upload-fields')||document.querySelector(selector)?.closest('.upload-zone'))?.querySelector('.upload-status')?.textContent.includes(name),{selector,name});
}
async function referenceMore(page) {
  await page.locator('#task-form .reference-controls').waitFor({state:'attached'});
  const tabs=page.locator('#task-form .reference-source-tabs');
  if(await tabs.count())await tabs.getByRole('button',{name:'上传 / 录音',exact:true}).click();
  await page.locator('#task-form details.reference-more').evaluateAll(items=>items.forEach(el=>el.open=true));
}
async function assertVisibleControl(page,selector,message) {
  await page.locator(selector).scrollIntoViewIfNeeded();
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
  ['TTS reference workspace keeps library read-only and temporary editing aligned', async (page, backend) => {
    Object.assign(backend.models.find(item=>item.id==='tts-two'),{voice_mode:'reference',profile:{accepts_voice_reference:true,send_reference_text:true,send_seed:false,send_max_tokens:false}});
    await page.setViewportSize({width:1440,height:1000});await pick(page,'tts-two');
    backend.voices.push({name:'narrator.wav',label:'温暖男声',text:'欢迎来到声音工作台，这是一段用于试听和配音的参考语音。',url:`${API}/references/narrator.wav/audio`});
    await page.getByRole('button',{name:'刷新列表',exact:true}).click();
    const rects=()=>page.locator('.compact-reference-sources>div').evaluateAll(items=>items.map(el=>{const r=el.getBoundingClientRect();return {y:r.y,bottom:r.bottom,height:r.height,width:r.width};}));
    const empty=await rects();
    assert.ok(Math.abs(empty[0].height-empty[1].height)<2&&Math.abs(empty[0].y-empty[1].y)<2);
    assert.equal(await page.locator('.reference-save').isVisible(),false);
    assert.equal(await page.locator('.reference-library-fields [data-input-key="reference_name"]').count(),0);
    await page.locator('[data-input-key="builtin_voice"]').selectOption('narrator.wav');
    await waitValue(page,'[data-reference-transcript]','欢迎来到声音工作台，这是一段用于试听和配音的参考语音。');
    assert.equal(await page.locator('[data-reference-transcript]').evaluate(el=>el.readOnly),true);
    assert.equal(await page.locator('[data-input-key="reference_text"]').inputValue(),'');
    assert.equal(await page.locator('[data-input-key="reference_text"]').isDisabled(),true);
    assert.equal(backend.referenceRequests.length,0);
    assert.deepEqual(await rects(),empty,'Selection must use reserved rows without layout movement');
    await page.locator('[data-input-key="text"]').fill('让每一段文字，都有自然的声音。');
    const positions=await page.locator('#task-form').evaluate(el=>{
      const r=s=>el.querySelector(s).getBoundingClientRect();return {references:r('.reference-sources').bottom,text:r('[data-input-key="text"]').top,textRight:r('[data-input-key="text"]').right,settings:r('.task-action-bar').top,settingsLeft:r('.task-action-bar').left,run:r('#run-button').right,right:r('.task-action-bar').right};
    });
    assert.ok(positions.references<positions.text&&positions.references<positions.settings&&positions.textRight<positions.settingsLeft);
    assert.ok(Math.abs(positions.right-positions.run-15)<2,'Generate action must align with the settings panel padding');
    await snapshot(page,'tts-library-desktop');
    await page.locator('.reference-upload-fields .reference-automatic input').uncheck();
    await upload(page,'#task-form [data-input-key="voice"]','uploaded-reference.wav');
    assert.equal(await page.locator('[data-reference-preview]').isVisible(),false);
    assert.equal(await page.locator('[data-input-key="builtin_voice"]').inputValue(),'');
    assert.equal(await page.locator('[data-reference-transcript]').inputValue(),'');
    assert.deepEqual(await rects(),empty,'Uploading must use reserved player and save rows');
    await page.locator('[data-input-key="reference_text"]').fill('上传音频的原文，可以校正后保存。');
    await page.locator('[data-input-key="reference_name"]').fill('新录制的声音');
    assert.equal(await page.locator('.reference-upload-fields .reference-save').isVisible(),true);
    await snapshot(page,'tts-upload-desktop');
    await page.locator('.reference-controls').getByRole('button',{name:'重新识别',exact:true}).click();
    await waitUntil(()=>backend.referenceRequests.length===1,'Temporary audio was not submitted for recognition');
    assert.deepEqual(backend.referenceRequests[0],{audio:'upload-1',source:''});
    backend.finish('reference-1','重新识别后的原文',[]);await waitValue(page,'[data-input-key="reference_text"]','重新识别后的原文');
    await page.waitForFunction(()=>!document.querySelector('.reference-save').disabled);
    await page.locator('.reference-save').click();
    await waitValue(page,'[data-input-key="builtin_voice"]','新录制的声音.wav');
    assert.equal(backend.referenceSaves[0].audio,'upload-1');assert.equal(backend.referenceSaves[0].source,'');
    assert.equal(backend.referenceSaves[0].text,'重新识别后的原文');
    assert.equal(await page.locator('.reference-save').isVisible(),false);
    assert.deepEqual(await rects(),empty,'Saving to the library must preserve source positions');
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
    for(const width of [1366,960,390]){
      await page.setViewportSize({width,height:900});await assertBrowserScroll(page);
      await assertVisibleControl(page,'#run-button','Generate action unreachable');
    }
    await page.evaluate(()=>window.scrollTo(0,0));await snapshot(page,'tts-library-mobile');
    await page.getByRole('button',{name:'管理音频',exact:true}).click();await page.locator('#reference-editor').waitFor({state:'visible'});
  }],
  ['TTS recording stays in its reserved upload panel and becomes a temporary reference', async (page, backend) => {
    Object.assign(backend.models.find(item=>item.id==='tts-two'),{voice_mode:'reference',profile:{accepts_voice_reference:true,send_reference_text:true,send_seed:false,send_max_tokens:false}});
    await pick(page,'tts-two');await page.locator('.reference-automatic input').uncheck();
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
    await page.locator('.reference-save').waitFor({state:'visible'});
    assert.equal(await page.evaluate(()=>window.stoppedReferenceTracks),1);
    assert.equal(backend.uploads.length,1);assert.ok(backend.uploads[0].name.startsWith('录音-'));
    assert.equal(await page.locator('.recording-time').isVisible(),false);assert.equal(await page.locator('.recording-stop').isVisible(),false);
    assert.equal(await height(),before);assert.equal(await page.locator('.reference-upload-fields audio').isVisible(),true);
    await page.locator('[data-input-key="reference_text"]').fill('录音对应的原文');
    await page.locator('[data-input-key="text"]').fill('使用这段录音合成的新文本');
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'Recorded reference did not submit');
    assert.equal(backend.requests[0].inputs.voice,'upload-1');assert.equal(backend.requests[0].inputs.reference_text,'录音对应的原文');
    assert.equal(backend.requests[0].inputs.builtin_voice,undefined);
  }],
  ['library pages expand long content through the browser', async (page, backend) => {
    const longText=Array.from({length:50},(_,i)=>`第 ${i+1} 行参考音频原文`).join('\n');
    backend.voices.push({name:'long-reference.wav',label:'长参考文本',text:longText,url:`${API}/references/long-reference.wav/audio`});
    backend.models.find(item=>item.id==='tts-one').files=Array.from({length:50},(_,i)=>`model-file-${i}.gguf`);
    const expanded=async selector=>{
      const metrics=await page.evaluate(selector=>{const el=document.querySelector(selector);return {height:el.clientHeight,scroll:el.scrollHeight,overflow:getComputedStyle(el).overflowY,maxHeight:getComputedStyle(el).maxHeight};},selector);
      assert.equal(metrics.overflow,'visible',`${selector} creates internal scrolling`);
      assert.ok(metrics.scroll<=metrics.height+1,`${selector} clips content`);
      assert.equal(metrics.maxHeight,'none');
    };
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:768});
      await page.locator('[data-route="references"]').click();await waitText(page,'.reference-transcript',longText);
      await expanded('.reference-transcript');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollHeight>innerHeight));
      await page.locator('[data-route="models"]').click();
      await expanded('#model-list');await page.locator('#model-list [data-model="tts-one"]').click();
      await page.locator('.details-files summary').click();await expanded('.details-files ul');
      await page.locator('.details-files li').last().scrollIntoViewIfNeeded();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    }
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
        return {page:document.documentElement.scrollHeight,viewport:innerHeight,inputHeight:input.height,runBottom:run.bottom,resultHeight:result.height};
      });
      await assertBrowserScroll(page);
      assert.equal(await page.locator('.input-card>.card-heading').isVisible(),false,`${route}: redundant input heading remains`);
      if(route==='tts'){
        assert.ok(await page.locator('.task-primary').evaluate(el=>{
          const text=el.querySelector('textarea').getBoundingClientRect(),settings=document.querySelector('.task-action-bar').getBoundingClientRect(),result=document.querySelector('.result-card').getBoundingClientRect();
          return text.right<settings.left&&Math.abs(settings.left-result.left)<2&&settings.bottom<result.top&&Math.abs(text.bottom-result.bottom)<2;
        }),'TTS text must fill the left column beside settings and results');
      }else assert.ok(await page.locator('.task-primary').evaluate(el=>Math.abs(el.getBoundingClientRect().width-document.querySelector('#task-inputs').getBoundingClientRect().width)<2),`${route}: primary input must fill a row`);
      assert.equal(await page.locator('.reference-source-tabs,.reference-more').count(),0,`${route}: old reference tabs remain`);
      if(route!=='tts')assert.ok(await page.locator('.result-card').evaluate(el=>el.getBoundingClientRect().top-document.querySelector('.input-card').getBoundingClientRect().bottom<20),`${route}: unnecessary gap before results`);
      assert.ok(geometry.inputHeight>100,`${route}: input collapsed ${JSON.stringify(geometry)}`);
      if(route==='asr')assert.ok(geometry.resultHeight>=180,'ASR must reserve the empty result editor');
      else if(route==='tts')assert.ok(geometry.resultHeight>=180&&geometry.resultHeight<=200,'TTS reserves status, audio and waveform space from the start');
      else assert.ok(geometry.resultHeight>=140,`${route}: empty result card must reserve output space ${JSON.stringify(geometry)}`);
      await assertVisibleControl(page,'#run-button',`${route}: execution button is clipped by an ancestor`);
      assert.ok(await page.locator('.workspace-operation').evaluate(el=>el.getBoundingClientRect().width>=document.querySelector('#page-workspace').getBoundingClientRect().width*.9),`${route}: main card does not fill the workspace`);
      await snapshot(page,`regular-${route}-prepared`);
      await page.setViewportSize({width:390,height:844});await assertBrowserScroll(page);
      await assertVisibleControl(page,'#run-button',`${route}: narrow-screen execution button clipped`);
      await page.evaluate(()=>window.scrollTo(0,0));await snapshot(page,`compact-${route}-mobile`);
      await page.setViewportSize({width:1366,height:768});
    }
  }],
  ['result header preserves real task stages, cancellation and an empty output card', async (page, backend) => {
    await page.setViewportSize({width:1366,height:768});await task(page,'tts','TTS One');
    await page.locator('[data-input-key="text"]').fill('第一段是开场白。第二段介绍产品。第三段是结束语。');
    const blank=await page.locator('.result-card').evaluate(el=>({height:el.getBoundingClientRect().height,background:getComputedStyle(el).backgroundColor}));
    assert.ok(blank.height>=180&&blank.height<=200);assert.notEqual(blank.background,'rgba(0, 0, 0, 0)');
    assert.equal(await page.locator('#job-status').isVisible(),false);await snapshot(page,'tts-result-idle');
    backend.submitGate=deferred();await page.locator('#run-button').click();
    await waitText(page,'#job-status','正在准备任务');assert.equal(await page.locator('#cancel-job').isVisible(),false);
    backend.submitGate.resolve();backend.submitGate=null;
    await page.locator('#cancel-job').waitFor({state:'visible'});
    for(const message of ['正在准备模型…','声音合成中…','声音合成中… 第 2/3 段 · 已完成 1 段']){
      backend.jobs.get('job-1').message=message;await waitText(page,'#job-status',message);
    }
    assert.equal(await page.locator('#job-status').getAttribute('data-state'),'running');
    assert.ok(await page.locator('#job-status').evaluate(el=>{const label=document.querySelector('#result-heading').getBoundingClientRect(),status=el.getBoundingClientRect(),stop=document.querySelector('#cancel-job').getBoundingClientRect();return label.right<=status.left&&status.right<=stop.left&&status.top<stop.bottom&&stop.top<status.bottom;}),'Task status and stop must follow the result label');
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
    Object.assign(backend.jobs.get('job-2'),{status:'error',message:'显存不足，请缩短文本或调整模型设置。'});backend.status.busy=false;backend.status.job=null;
    await waitText(page,'#job-status','显存不足');assert.equal(await page.locator('#job-status').getAttribute('data-state'),'error');
    assert.equal(await page.locator('#cancel-job').isVisible(),false);
    await snapshot(page,'tts-result-error');
  }],
  ['ASR long output uses bounded editing with fixed copy and export actions', async (page, backend) => {
    backend.models.find(item=>item.id==='asr-one').streaming=true;
    await page.setViewportSize({width:1366,height:768});await task(page,'asr','ASR One');
    await upload(page,'#task-form [data-input-key="audio"]','long-recording.wav');
    await page.locator('[data-input-key="detailed"]').check();await page.locator('[data-input-key="dialogue"]').check();
    assert.equal(await page.locator('[data-input-key="detailed"]').isChecked(),false);
    await page.locator('[data-input-key="stream"]').check();
    assert.equal(await page.locator('[data-input-key="dialogue"]').isChecked(),false);
    await page.locator('[data-input-key="stream"]').uncheck();
    for(const selector of ['[data-input-key="language"]','[data-input-key="context"]','[data-input-key="detailed"]','[data-input-key="dialogue"]','[data-input-key="stream"]'])await assertVisibleControl(page,selector,'ASR common option clipped');
    const emptyHeight=await page.locator('#result-content textarea').evaluate(el=>el.getBoundingClientRect().height);
    assert.equal(await page.locator('#result-content textarea').inputValue(),'');
    assert.equal(await page.locator('#copy-result').isVisible(),false);
    const contextGeometry=await page.locator('[data-input-key="context"]').evaluate(el=>{
      const field=el.closest('.field-group'),row=field.getBoundingClientRect(),input=el.getBoundingClientRect(),label=field.querySelector('.field-label').getBoundingClientRect(),options=document.querySelector('#common-options').getBoundingClientRect(),language=document.querySelector('[data-input-key="language"]').getBoundingClientRect();
      return {full:Math.abs(row.width-options.width)<2,right:Math.abs(input.right-options.right)<2,sameRow:input.top<label.bottom&&input.bottom>label.top,above:row.bottom<=language.top};
    });
    assert.deepEqual(contextGeometry,{full:true,right:true,sameRow:true,above:true});
    await snapshot(page,'asr-empty-result-full-context');
    const heights=[];
    for(const lines of [12,2000]){
      await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===heights.length+1,'ASR did not submit');
      const text=Array.from({length:lines},(_,index)=>`${index+1} 这是完整的识别文字，包含专业术语、标点和长音频内容。`).join('\n');
      backend.finish(`job-${heights.length+1}`,text,[]);await waitValue(page,'#result-content textarea.result-text',text);
      await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
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
    assert.equal(heights[0],emptyHeight,'Empty and populated transcript editors must have the same initial height');
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===3,'ASR partial result did not submit');
    backend.jobs.get('job-3').text='流式识别文字';await waitValue(page,'#result-content textarea','流式识别文字');
    assert.equal(await page.locator('#result-content textarea').evaluate(el=>el.readOnly),true);
    backend.finish('job-3','流式识别文字',[]);await waitText(page,'#job-status','处理完成');
    assert.equal(await page.locator('#result-content textarea').evaluate(el=>el.readOnly),false,'Unchanged final transcript must become editable');
    const corrected='用户校正的最终文字';await page.locator('#result-content textarea.result-text').fill(corrected);
    await page.evaluate(()=>{
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.fixtureClipboard=text;}}});
      const original=URL.createObjectURL;URL.createObjectURL=blob=>{window.fixtureExport=blob.text();return original.call(URL,blob);};
    });
    await page.locator('#copy-result').click();assert.equal(await page.evaluate(()=>window.fixtureClipboard),corrected);
    await page.locator('#export-result').click();assert.equal(await page.evaluate(()=>window.fixtureExport),corrected);
    await task(page,'tts');await task(page,'asr');await waitValue(page,'#result-content textarea.result-text',corrected);
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
  ['conversion reference panels share compact layout and keep library and uploads exclusive', async (page, backend) => {
    backend.voices.push({name:'saved.wav',label:'Saved reference',text:'参考原文',url:`${API}/references/saved.wav/audio`});
    await page.locator('[data-route="references"]').click();await task(page,'vc','Voice conversion');
    await page.setViewportSize({width:1366,height:768});
    await upload(page,'#task-form [data-input-key="audio"]','conversion-source.wav',300);
    assert.equal(await page.locator('.reference-source-tabs,.reference-more').count(),0);
    const panels=await page.locator('.reference-sources>div').evaluateAll(items=>items.map(el=>{const r=el.getBoundingClientRect();return {top:r.top,width:r.width};}));
    assert.ok(Math.abs(panels[0].top-panels[1].top)<2&&Math.abs(panels[0].width-panels[1].width)<2,'Conversion reference panels must share one row equally');
    assert.equal(await page.locator('#task-form .reference-automatic').isVisible(),false,'Conversion must not expose unsupported reference transcription');
    await page.locator('#run-button').click();assert.equal(backend.requests.length,0,'Conversion without a target reached inference');
    await page.locator('[data-input-key="builtin_voice"]').selectOption('saved.wav');
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'Library conversion was not submitted');
    assert.equal(backend.requests[0].inputs.builtin_voice,'saved.wav');assert.equal(backend.requests[0].inputs.voice,undefined);
    backend.finish('job-1','',['converted.wav']);await waitText(page,'#job-status','converted.wav');
    assert.equal(await page.locator('#result-content audio').count(),2,'Conversion needs source and output comparison players');
    const geometry=await page.locator('#result-content audio').evaluateAll(items=>items.map(el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,width:r.width};}));
    assert.ok(geometry.every(box=>box.width>120&&box.bottom<=768),`Conversion players clipped ${JSON.stringify(geometry)}`);
    await snapshot(page,'regular-vc-reference-result');
    await waitText(page,'#job-status','用时 1.3 s');assert.equal(await page.locator('#job-status').getAttribute('data-state'),'done');
    await upload(page,'#task-form [data-input-key="voice"]','new-target.wav');
    assert.equal(await page.locator('[data-input-key="builtin_voice"]').inputValue(),'');
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===2,'Uploaded conversion target did not submit');
    assert.equal(backend.requests[1].inputs.voice,'upload-2');assert.equal(backend.requests[1].inputs.builtin_voice,undefined);
    backend.finish('job-2','',['converted-upload.wav']);await waitText(page,'#job-status','converted-upload.wav');
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
  ['ACE cover common controls and required source stay usable in a regular window', async (page, backend) => {
    const entry=backend.models.find(item=>item.id==='music-ace');entry.parameters=presetParameters('ace_step');
    Object.assign(entry.music_inputs,{source_audio_routes:['cover','remix'],source_required_routes:['cover','remix']});
    await page.setViewportSize({width:1366,height:768});await task(page,'music');await pick(page,'music-ace');
    await page.locator('#param-task_route').selectOption('cover');
    await page.locator('[data-input-key="text"]').fill('轻快的钢琴流行曲');await page.locator('[data-input-key="lyrics"]').fill('这是演唱的歌词\n按原曲旋律重新演绎');
    await upload(page,'#task-form [data-input-key="audio"]','cover-source.wav');
    for(const selector of ['#param-task_route','[data-input-key="duration"]','#param-audio_cover_strength','#run-button'])await assertVisibleControl(page,selector,'ACE cover control clipped');
    assert.equal(await page.locator('#common-options #param-audio_cover_strength').count(),1);
    const inputs=await page.locator('#task-inputs').evaluate(el=>{const prompt=el.querySelector('[data-input-key="text"]').getBoundingClientRect(),source=el.querySelector('.upload-zone').getBoundingClientRect(),lyrics=el.querySelector('[data-input-key="lyrics"]').getBoundingClientRect();return {prompt:prompt.height,source:source.height,aligned:Math.abs(prompt.top-source.top)<2&&Math.abs(prompt.bottom-source.bottom)<2,lyrics:lyrics.height,lyricsBelow:lyrics.top>source.bottom};});
    assert.ok(inputs.prompt<=100&&inputs.aligned,'Music description and source must form a compact, aligned row');
    assert.ok(inputs.lyrics>=180&&inputs.lyricsBelow,'Lyrics need their own writing area');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1));
    await snapshot(page,'regular-music-ace-cover');
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'ACE cover did not submit');
    assert.equal(backend.requests[0].inputs.audio,'upload-1');assert.equal(backend.requests[0].options.task_route,'cover');
  }],
  ['TTS uploaded reference and current output preserve visible common controls', async (page, backend) => {
    Object.assign(backend.models.find(item=>item.id==='tts-two'),{voice_mode:'reference',profile:{accepts_voice_reference:true,send_reference_text:true,require_voice:true,send_seed:false,send_max_tokens:false}});
    await page.setViewportSize({width:1366,height:768});await pick(page,'tts-two');
    await referenceMore(page);await page.locator('#task-form .reference-upload-fields .reference-automatic input').uncheck();
    const emptyHeight=await page.locator('.reference-sources').evaluate(el=>el.getBoundingClientRect().height);
    await upload(page,'#task-form [data-input-key="voice"]','uploaded-reference.wav');
    assert.ok(Math.abs(await page.locator('.reference-sources').evaluate(el=>el.getBoundingClientRect().height)-emptyHeight)<2,'Upload must use the reserved player space');
    await page.locator('[data-input-key="reference_text"]').fill('上传参考音频实际说出的文字');
    await page.locator('[data-input-key="text"]').fill('通过上传的参考音频生成这段新的语音');
    await page.locator('[data-input-key="language"]').selectOption('chinese');
    await page.locator('#param-speaker').selectOption('voice-b');
    await page.locator('[data-input-key="stream"]').check();
    await page.locator('#param-speed').fill('1.1');
    for(const selector of ['[data-input-key="language"]','#param-speaker','#param-speed','#run-button'])await assertVisibleControl(page,selector,'TTS uploaded-reference common control clipped');
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'Uploaded-reference TTS did not submit');
    assert.ok(await page.locator('#result-heading').evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),'Submitting brings output progress into view');
    assert.equal(backend.requests[0].inputs.voice,'upload-1');assert.equal(backend.requests[0].inputs.reference_text,'上传参考音频实际说出的文字');
    assert.equal(backend.requests[0].inputs.language,'chinese');assert.equal(backend.requests[0].inputs.stream,true);
    assert.equal(backend.requests[0].options.speaker,'voice-b');assert.equal(backend.requests[0].options.speed,1.1);
    backend.finish('job-1','',['uploaded-reference-output.wav']);Object.assign(backend.jobs.get('job-1'),{message:'生成完成，用时 3.6s。',elapsed:11.8});await waitText(page,'#job-status','uploaded-reference-output.wav');
    await waitText(page,'#job-status','生成完成，用时 3.6 s');
    assert.equal(await page.locator('#job-status').isVisible(),true);
    assert.ok(await page.locator('#job-status').evaluate(el=>Math.abs(el.getBoundingClientRect().right-document.querySelector('.result-title').getBoundingClientRect().right)<2),'Output status belongs at the right edge');
    assert.ok(await page.locator('#job-status').evaluate(el=>{const a=document.querySelector('#result-heading').getBoundingClientRect(),b=el.getBoundingClientRect();return a.right<=b.left&&a.top<b.bottom&&b.top<a.bottom;}),'Status must follow the result label on the same row');
    assert.equal(await page.getByRole('button',{name:'显示波形',exact:true}).count(),0);
    await assertVisibleControl(page,'#run-button','TTS execute button clipped after output');
    await assertVisibleControl(page,'#result-content audio','TTS current output player clipped');
    assert.equal(await page.locator('#result-content .artifact-heading').count(),0,'Single audio filename must share the completion message');
    assert.ok(await page.locator('.result-card').evaluate(el=>{
      const result=el.getBoundingClientRect(),text=document.querySelector('[data-input-key="text"]').getBoundingClientRect(),audio=el.querySelector('audio').getBoundingClientRect();
      return result.height>=180&&result.height<=200&&Math.abs(text.bottom-result.bottom)<2&&audio.bottom<=result.bottom;
    }),'TTS output must keep its reserved height and align with the editor bottom');
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
    assert.equal(await page.locator('.reference-source-tabs').count(),0);
    await page.locator('#task-form').evaluate(form=>form.requestSubmit());
    await waitText(page,'#job-status','这个模型需要参考声音');
    assert.equal(backend.requests.length,0,'Empty reference bypassed the reference requirement');
    await page.locator('[data-input-key="builtin_voice"]').selectOption('qwen-no-text.wav');
    await page.locator('#run-button').click();await waitText(page,'#job-status','这个模型需要参考原文');
    assert.equal(backend.requests.length,0,'Base library entry without a transcript reached the inference API');
    await advanced(page);await page.locator('#options-json').fill('{"x_vector_only_mode":"false"}');
    await page.locator('#apply-model-settings').click();
    await page.locator('#run-button').click();await waitText(page,'#job-status','这个模型需要参考原文');
    assert.equal(backend.requests.length,0,'The string false incorrectly disabled the transcript requirement');
    await advanced(page);await page.locator('#options-json').fill('{"x_vector_only_mode":true}');
    await page.locator('#apply-model-settings').click();
    await page.locator('#run-button').click();await waitUntil(()=>backend.requests.length===1,'X-vector-only library reference was blocked without a transcript');
    assert.equal(backend.requests[0].inputs.builtin_voice,'qwen-no-text.wav');
    assert.equal(backend.requests[0].options.x_vector_only_mode,true);
    backend.finish('job-1','',['qwen-x-vector-library.wav']);await waitText(page,'#job-status','qwen-x-vector-library.wav');
    await advanced(page);await page.locator('#options-json').fill('');await page.locator('#apply-model-settings').click();
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
    await advanced(page);await page.locator('#options-json').fill('{"x_vector_only_mode":true}');await page.locator('#apply-model-settings').click();
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
  ['RVC source and optional model files fit beside three common controls', async (page, backend) => {
    Object.assign(backend.models.find(item=>item.id==='voice-convert'),{family:'rvc',voice_mode:'rvc',profile:{model_as_target_voice:true,accepts_voice_reference:false,send_seed:false},parameters:presetParameters('rvc')});
    await page.setViewportSize({width:1366,height:768});await task(page,'vc','Voice conversion');
    await upload(page,'#task-form [data-input-key="audio"]','rvc-source.wav');
    assert.equal(await page.locator('[data-input-key="rvc_voice_model"]').count(),1);
    assert.equal(await page.locator('[data-input-key="rvc_retrieval_index"]').count(),1);
    for(const selector of ['#param-voice_id','#param-semitone_shift','#param-retrieval_blend','#run-button'])await assertVisibleControl(page,selector,'RVC common control clipped');
    const fileLabels=await page.locator('[data-input-key="rvc_voice_model"], [data-input-key="rvc_retrieval_index"]').evaluateAll(inputs=>inputs.map(input=>{const r=input.closest('.upload-zone').getBoundingClientRect(),target=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return !!target&&input.closest('.upload-zone').contains(target);}));
    assert.deepEqual(fileLabels,[true,true],'RVC optional file controls clipped');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1));await snapshot(page,'regular-vc-rvc-options');
  }],
  ['dense advanced model settings scroll internally with a fixed apply footer', async (page, backend) => {
    const real=[...presetParameters('ace_step'),...presetParameters('rvc')];
    backend.models.find(item=>item.id==='tts-one').parameters=real.slice(0,27).map((param,index)=>({...param,name:`expert_${index}_${param.name}`,level:'expert'}));
    await pick(page,'tts-one');await page.setViewportSize({width:1366,height:768});await advanced(page);
    assert.equal(await page.locator('#expert-controls > .field-group').count(),28,'27 realistic controls plus the seed should render');
    const content=await page.locator('.model-settings-content').evaluate(el=>({scroll:el.scrollHeight,client:el.clientHeight}));
    assert.ok(content.scroll>content.client,'Many advanced fields must scroll inside the popover');
    await assertVisibleControl(page,'#apply-model-settings','Advanced apply footer clipped');
    await page.locator('.model-settings-content').evaluate(el=>el.scrollTop=el.scrollHeight);
    await assertVisibleControl(page,'#options-json','Advanced JSON field cannot be reached');
    await assertVisibleControl(page,'#apply-model-settings','Advanced footer scrolled away');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1));await snapshot(page,'regular-model-settings-dense');
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
    assert.equal(await page.locator('#scenario-list > button').count(),1);
    assert.equal(await page.locator('#scenario-list > article.planned').count(),5);
    assert.deepEqual(await page.locator('#scenario-list .tool-card-title').allTextContents(),['实时语音聊天','自动字幕','字幕翻译','译文朗读','视频译配','长文朗读']);
    const before=backend.requests.length;
    await page.locator('[data-scenario="video-dubbing"]').click();
    assert.ok(page.url().endsWith('#scenarios'));assert.equal(backend.requests.length,before);
    await snapshot(page,'scenarios-desktop');
    await page.setViewportSize({width:390,height:900});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await snapshot(page,'scenarios-mobile');
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('[data-scenario="realtime-chat"]').click();
    assert.ok(page.url().endsWith('#scenarios/realtime-chat'));
    const frame=page.frameLocator('#realtime-frame');
    await frame.getByRole('button',{name:'返回场景应用',exact:true}).click();
    await page.locator('#page-scenarios').waitFor();
    assert.equal(await page.locator('[data-route="scenarios"]').getAttribute('aria-current'),'page');
    await page.evaluate(()=>{location.hash='realtime';});
    await page.locator('#page-realtime').waitFor();
    assert.ok(page.url().endsWith('#scenarios/realtime-chat'),'Legacy realtime link should open the current scene');
    backend.status.realtime_active=true;
    await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:document.querySelector('#realtime-frame').contentWindow,data:{type:'audiocpp:realtime-state',active:true,microphone:true}})));
    assert.equal(await page.locator('#realtime-nav-status').textContent(),'通话中');
    await frame.getByRole('button',{name:'返回场景应用',exact:true}).click();
    await page.locator('#page-scenarios').waitFor();
    assert.equal(await page.locator('#end-realtime-session').isVisible(),true,'Catalog navigation should retain the active call controls');
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
    await frame.locator('#settings-modal').evaluate(el=>el.showModal());
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
    await referenceMore(page);assert.equal(await page.locator('#task-form [data-input-key="reference_name"]').isVisible(),false);
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
    await waitText(page,'#resident-model-name','qwen3-asr');
    assert.equal(await page.locator('#resident-model').isVisible(),true);
    assert.ok(await page.locator('#resident-model').evaluate(el=>el.getBoundingClientRect().bottom<=document.querySelector('#connection-status').getBoundingClientRect().top));
    await snapshot(page,'resident-model-sidebar-desktop');
    await page.locator('#sidebar-toggle').click();
    assert.equal(await page.locator('.resident-model-copy').isVisible(),false);
    assert.equal(await page.locator('#resident-model').getAttribute('title'),'常驻模型 · qwen3-asr');
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
  ['reference library saves corrected text, confirms overwrite, edits and deletes', async (page, backend) => {
    await page.locator('[data-route="references"]').click();
    const editor=page.locator('#reference-editor');
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
    await snapshot(page,'reference-library-saved');
    await page.setViewportSize({width:420,height:900});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Reference library overflows a narrow screen');
    await snapshot(page,'reference-library-mobile');
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('#reference-list').getByRole('button',{name:'编辑',exact:true}).click();
    await waitValue(page,'#reference-editor [data-input-key="reference_text"]','最终校正文本');
    await editor.locator('[data-input-key="reference_text"]').fill('再次修正');
    let dialogs=0;page.on('dialog',dialog=>{dialogs++;void dialog.accept();});
    await editor.locator('.reference-save').click();
    await waitUntil(()=>backend.referenceSaves.some(r=>r.overwrite),'overwrite confirmation was not applied');
    assert.equal(dialogs,1);
    await page.locator('#reference-search').fill('再次修正');
    await page.waitForFunction(()=>document.querySelector('#reference-list').textContent.includes('再次修正'));
    await page.locator('#reference-list').getByRole('button',{name:'删除',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#reference-count').textContent==='0 段参考音频');
    assert.equal(dialogs,2);assert.equal(backend.voices.length,0);
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
      const controls=['[data-input-key="builtin_voice"]','[data-input-key="voice"]','[data-input-key="text"]','#common-options','#run-button'].map(selector=>form.querySelector(selector));
      return controls.every((control,index)=>!index||!!(controls[index-1].compareDocumentPosition(control)&Node.DOCUMENT_POSITION_FOLLOWING));
    });
    assert.equal(ordered,true,'Reference material, synthesis text, common settings and execution order');
    assert.equal(await page.locator('[data-input-key="builtin_voice"] option').first().textContent(),'选择参考音频');
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
    await page.locator('#reference-editor').getByRole('button',{name:'重新识别',exact:true}).click();
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
    for(let i=1;i<commonBoxes.length;i++){const before=commonBoxes[i-1],after=commonBoxes[i];assert.ok(after.top>=before.bottom||(before.right<after.left&&before.top<after.bottom&&after.top<before.bottom),'Common controls must keep voice, streaming, language, speed order while wrapping in the right column');}
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
    assert.equal(await page.locator('#workspace-load-status').textContent(),'当前模型 · tts-one','Selecting a different model must not mislabel the loaded model');
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
    assert.ok(Math.abs(popup.x-anchor.x)<2,'Model list is not aligned below the trigger');
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
    await page.locator('#param-load_options-threads').fill('6');
    await page.locator('#options-json').fill('{"temperature":0.7}');
    assert.equal(await page.locator('#run-button').isDisabled(),true);
    assert.equal(backend.loads.length,0,'Parameter edits must not silently reload');
    await page.locator('#apply-model-settings').click();await waitUntil(()=>backend.loads.length===1,'Settings did not reload explicitly');
    assert.equal(backend.loads[0].options['load_options.threads'],6);
    assert.equal(backend.loads[0].options.speed,1.25);assert.equal(backend.loads[0].options.temperature,.7);
    await page.waitForFunction(()=>!document.querySelector('#run-button').disabled);
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
  for(const entry of entries){
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
      for(const [key,name,reset] of [['rvc_voice_model','voice.pth','使用内置音色'],['rvc_retrieval_index','voice.index','不使用索引']]){
        await page.locator(`[data-input-key="${key}"]`).setInputFiles({name,mimeType:'application/octet-stream',buffer:Buffer.from('fixture')});
        await page.getByRole('button',{name:reset,exact:true}).waitFor({state:'visible'});await page.getByRole('button',{name:reset,exact:true}).click();
        assert.equal(await page.getByRole('button',{name:reset,exact:true}).isVisible(),false);
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
      assert.ok(layout.bottomGap<=24,`${entry.id}: empty stretched operation ${JSON.stringify(layout)}`);
      assert.equal(await page.locator('#task-form button.upload-clear').count(),0,'Workspace audio is replaced through upload or recording');
    }
    await assertVisibleControl(page,'#run-button',`${entry.id}: run action clipped`);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${entry.id}: horizontal overflow`);
    // Toast timing is covered by the interaction cases; hide it for the catalog gallery.
    await page.locator('#toast').evaluate(element=>{element.hidden=true;});
    await page.evaluate(()=>window.scrollTo(0,0));await snapshot(page,`desktop-${entry.id}`);
  }
}]);

cases.push(['home startup, logo navigation, resident status and pixel interaction',async(page,backend)=>{
  backend.status.hardware={backend:'cuda',vram_gb:8,name:'NVIDIA GeForce RTX 4060 Laptop GPU'};
  backend.status.asr={model:'asr-one',managed:true};
  await page.goto(ORIGIN+'/');
  await page.locator('#page-home').waitFor({state:'visible'});
  await waitText(page,'#home-hardware','RTX 4060');
  await waitText(page,'#home-resident-list','TTS One');
  await waitText(page,'#home-resident-list','ASR One');
  assert.equal(await page.locator('#home-version').textContent(),'browser-fixture');
  assert.equal(await page.locator('#pixel-sound').getAttribute('aria-pressed'),'false');
  await page.locator('#pixel-canvas').click();await waitText(page,'#pixel-beats','001');
  await page.locator('#pixel-canvas').press('Space');await waitText(page,'#pixel-beats','002');
  await page.locator('#pixel-pause').click();assert.equal(await page.locator('#pixel-pause').textContent(),'播放动画');
  await snapshot(page,'home-desktop');
  for(const route of ['tts','asr','music','design','vc','tools','models','references','scenarios','settings']){
    await page.locator(`[data-route="${route}"]`).click();
    const workspace=['tts','asr','music','design','vc'].includes(route);
    assert.equal(await page.locator(workspace?'#workspace-load-status':'#global-model-status').isVisible(),true,route);
    if(!workspace)await waitText(page,'#global-model-status','TTS One');
  }
  await page.locator('.brand').click();await page.locator('#page-home').waitFor({state:'visible'});
  assert.equal(backend.loads.length,0,'Homepage and navigation must never load models');
  await page.setViewportSize({width:390,height:844});await snapshot(page,'home-mobile');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('#pixel-pause').textContent(),'播放动画');
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
      const box=el.getBoundingClientRect(),fields=[...el.querySelectorAll('#expert-controls input')].map(input=>{const r=input.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width};});
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
      page.on('console', message => {if (message.type() === 'error') {if(backend.expectedHttpErrors&&/status of (500|503|409)/.test(message.text())){backend.expectedHttpErrors--;return;}errors.push(message.text());}});
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
