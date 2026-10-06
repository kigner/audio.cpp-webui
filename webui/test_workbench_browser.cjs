/* Deterministic browser regression for the real workbench UI.
 * No server, model, microphone, download, or cloud request is used.
 * Run: node webui/test_workbench_browser.cjs
 * Optional: AUDIOCPP_PLAYWRIGHT_MODULE, AUDIOCPP_BROWSER_EXECUTABLE.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require(process.env.AUDIOCPP_PLAYWRIGHT_MODULE || 'playwright');

const ORIGIN = 'http://127.0.0.1:17780';
const API = '/api/workbench';
const STATIC = path.join(__dirname, 'workbench_static');
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
    model('asr-one', 'ASR One', 'asr', 'asr'),
    model('music-one', 'Music One', 'music', 'gen', {music_inputs:{lyrics:false, source_audio:false, duration:false, text_role:'prompt'}}),
    model('music-ace', 'ACE Route Fixture', 'music', 'gen', {family:'ace_step',
      music_inputs:{lyrics:true, source_audio:true, source_audio_routes:['audio2audio'],
        source_required_routes:['audio2audio'], duration:true, duration_default:30, duration_min:-1, duration_max:120},
      parameters:[{name:'task_route', label:'创作方式', type:'select', choices:['text2music','audio2audio'],
        default:'text2music', level:'basic', scope:'request'}]}),
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
        {id:'music', types:['gen']}, {id:'analysis', types:['align','midi']}], ...status});
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
      status.server = {text:'模型已加载', model:load[1], configuration};
      status.asr={model:null,managed:false};
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
  await page.waitForFunction(({selector,text}) => document.querySelector(selector)?.textContent.includes(text), {selector,text});
}
async function waitValue(page, selector, value) {
  await page.waitForFunction(({selector,value}) => document.querySelector(selector)?.value === value, {selector,value:String(value)});
}
async function task(page, id, label) {
  await page.locator(`[data-route="${id}"]`).click();
  await page.waitForFunction(id => document.querySelector('#page-workspace').dataset.task === id, id);
  if (label && (await page.locator('#model-picker-label').textContent()) !== label) {
    const models = {tts:'tts-one',asr:'asr-one',music:'music-one'};
    await pick(page, models[id]);
  }
  if (label) await waitText(page, '#model-picker-label', label);
}
async function pick(page, id) {
  await page.locator('#model-picker-trigger').click();
  await page.locator(`#model-picker-list [data-model="${id}"] .model-row-load`).click();
  await page.waitForFunction(() => !document.querySelector('#model-picker-popover').matches(':popover-open'));
  await page.locator('#workspace-grid').waitFor({state:'visible'});
}
async function advanced(page) {
  const details = page.locator('#expert-panel');
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
}
async function upload(page, selector, name, marker = 0) {
  await page.locator(selector).setInputFiles({name, mimeType:'audio/wav', buffer:wav(marker)});
  await page.waitForFunction(({selector,name})=>document.querySelector(selector)?.closest('.upload-zone')?.querySelector('.upload-status')?.textContent.includes(name),{selector,name});
}
async function snapshot(page, name) {
  if (!process.env.AUDIOCPP_BROWSER_SCREENSHOTS) return;
  await fs.mkdir(process.env.AUDIOCPP_BROWSER_SCREENSHOTS, {recursive:true});
  await page.screenshot({path:path.join(process.env.AUDIOCPP_BROWSER_SCREENSHOTS, `${name}.png`), fullPage:true});
}

const cases = [
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
    await page.locator('#task-form [data-input-key="reference_name"]').waitFor();
    assert.equal(await page.locator('#task-form .reference-controls').evaluate(el=>el.querySelector('.reference-name-row').closest('.field-group').previousElementSibling.className),'reference-actions');
    assert.equal(await page.locator('#task-form .reference-save').count(),1);
    await page.locator('#task-form [data-input-key="reference_name"]').fill('合成页保存名称');
    await upload(page,'#task-form [data-input-key="voice"]','tts-reference.wav');
    assert.equal(await page.locator('#task-form [data-input-key="reference_name"]').inputValue(),'合成页保存名称');
  }],
  ['reference compact rows, default appearance and all-model memory release', async (page, backend) => {
    assert.equal(await page.locator('html').getAttribute('data-palette'),'classic');
    assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
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
    await page.locator('#unload-all-models').click();
    await waitUntil(()=>backend.unloads.length===1,'all-model release was not requested');
    await page.waitForFunction(()=>!document.querySelector('#settings-runtime').textContent.includes('Qwen3-ASR'));
    assert.equal(backend.status.server.model,null);assert.equal(backend.status.asr.model,null);
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
    await page.locator('[data-input-key="builtin_voice"]').selectOption('saved.wav');
    await waitValue(page,'#task-form [data-input-key="reference_text"]','已保存原文');
    assert.ok((await page.locator('#task-form audio').first().getAttribute('src')).includes('/references/saved.wav/audio'));
    await upload(page,'#task-form [data-input-key="voice"]','new-reference.wav');
    await waitUntil(()=>backend.referenceRequests.length===1,'TTS reference ASR missing');
    await page.waitForFunction(()=>document.querySelector('#workspace-grid').hidden===false);
    assert.equal(await page.locator('[data-input-key="builtin_voice"]').inputValue(),'');
    backend.finish('reference-1','新参考原文',[]);await waitValue(page,'#task-form [data-input-key="reference_text"]','新参考原文');
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
    backend.models.push(model('voice-convert','Voice conversion','vc','vc'),model('enhance','Enhance','processing','s2s'),model('voice-design','Voice design','design','vdes'));
    await page.locator('[data-route="models"]').click();await page.locator('#refresh-catalog').click();
    await page.locator('[data-route="vc"]').click();await page.locator('#model-picker-trigger').click();
    assert.deepEqual(await page.locator('#model-picker-list [data-model]').evaluateAll(rows=>rows.map(r=>r.dataset.model)),['voice-convert']);
    await page.keyboard.press('Escape');await page.locator('[data-route="design"]').click();await page.locator('#model-picker-trigger').click();
    assert.deepEqual(await page.locator('#model-picker-list [data-model]').evaluateAll(rows=>rows.map(r=>r.dataset.model)),['voice-design']);
    await page.keyboard.press('Escape');await page.locator('[data-route="tools"]').click();await page.getByRole('button',{name:'音频处理',exact:false}).click();
    await page.locator('#model-picker-trigger').click();assert.deepEqual(await page.locator('#model-picker-list [data-model]').evaluateAll(rows=>rows.map(r=>r.dataset.model)),['enhance']);
  }],
  ['unloaded workspace waits for load, keeps selection quiet, and retries a failed load', async (page, backend) => {
    assert.equal(await page.locator('#workspace-start').isVisible(),true);
    assert.equal(await page.locator('#workspace-grid').isVisible(),false);
    assert.equal(await page.locator('#parameter-toggle').isVisible(),false);
    await snapshot(page,'initial');
    await page.locator('#model-picker-trigger').click();
    await snapshot(page,'models');
    await page.locator('[data-model-select="tts-two"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-model-select="tts-two"]').getAttribute('aria-pressed')==='true');
    assert.equal(backend.loads.length,0);
    assert.equal(await page.locator('#workspace-grid').isVisible(),false);
    await page.reload();
    await waitText(page,'#model-picker-label','加载语音合成模型');
    assert.equal(await page.locator('#workspace-grid').isVisible(),false,'Remembered selection must not replace the unloaded page');
    await page.locator('#model-picker-trigger').click();
    await page.waitForFunction(()=>document.querySelector('[data-model-select="tts-two"]').getAttribute('aria-pressed')==='true');
    backend.loadGate=deferred();backend.loadError=true;
    await page.locator('[data-load-model="tts-two"]').click();
    await waitUntil(()=>backend.loads.length===1,'Load request did not start');
    assert.equal(await page.locator('#workspace-grid').isVisible(),false);
    assert.equal(await page.locator('[data-load-model="tts-two"]').isDisabled(),true);
    backend.loadGate.resolve();
    await waitText(page,'#toast','Fixture load failed');
    await waitText(page,'#model-picker-status','加载失败：Fixture load failed');
    assert.equal(await page.locator('[data-load-model="tts-two"]').textContent(),'重试');
    await page.locator('#toast').evaluate(el=>el.hidden=true);
    assert.equal(await page.locator('#workspace-load-status').isVisible(),true,'Load failure vanished with its toast');
    await page.waitForFunction(()=>!document.querySelector('[data-load-model="tts-two"]').disabled);
    assert.equal(await page.locator('#workspace-grid').isVisible(),false);
    assert.equal(await page.locator('#model-picker-popover').isVisible(),true);
    backend.loadGate=null;backend.loadError=false;
    await page.locator('[data-load-model="tts-two"]').click();
    await waitText(page,'#model-picker-label','TTS Two');
    await page.locator('#workspace-grid').waitFor({state:'visible'});
    assert.equal(await page.locator('#workspace-load-status').textContent(),'已加载 · API：tts-two');
    await snapshot(page,'loaded');
    assert.equal(backend.loads.length,2);
    await task(page,'asr');
    await waitText(page,'#model-picker-label','加载语音识别模型');
    assert.equal(await page.locator('#workspace-grid').isVisible(),false);
    await page.locator('[data-route="music"]').click();
    await waitText(page,'#model-picker-label','加载音乐与音效模型');
    await page.setViewportSize({width:390,height:844});
    await page.locator('#model-picker-trigger').click();
    await snapshot(page,'mobile');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    const popup=await page.locator('#model-picker-popover').boundingBox();
    assert.ok(popup.x>=0&&popup.x+popup.width<=391);
  }],
  ['unloaded navigation during a pending load cannot show another task model form', async (page, backend) => {
    backend.loadGate=deferred();
    await page.locator('#model-picker-trigger').click();
    await page.locator('[data-load-model="tts-one"]').click();
    await waitUntil(()=>backend.loads.length===1,'Load request did not start');
    await task(page,'asr');
    backend.loadGate.resolve();
    await waitUntil(()=>backend.status.server.model==='tts-one','Load did not finish');
    await page.waitForFunction(()=>document.querySelector('#model-picker-label').textContent==='加载语音识别模型');
    assert.equal(await page.locator('#workspace-grid').isVisible(),false);
    backend.loadGate=null;
    await pick(page,'asr-one');
    assert.equal(await page.locator('#model-picker-label').textContent(),'ASR One');
    assert.equal(await page.locator('input[type=file][data-input-key="audio"]').isVisible(),true);
  }],
  ['card workspace keeps task controls outside cards and persists both palettes', async (page) => {
    assert.equal(await page.locator('#task-title').textContent(),'语音合成');
    assert.equal(await page.locator('#task-title').isVisible(),true);
    const cards=await page.evaluate(()=>[document.querySelector('.workspace-operation'),document.querySelector('#workspace-settings')].map(el=>{const s=getComputedStyle(el),box=el.getBoundingClientRect();return {radius:s.borderRadius,shadow:s.boxShadow,border:s.borderTopWidth,background:s.backgroundColor,top:box.top};}));
    assert.deepEqual(cards[1],cards[0],'Parameter panel should align with and share the main card appearance');
    assert.equal(cards[0].border,'0px');
    const spacing=await page.evaluate(()=>{const sidebar=document.querySelector('#app-sidebar'),main=document.querySelector('.workspace-operation').getBoundingClientRect(),panel=document.querySelector('#workspace-settings').getBoundingClientRect(),toolbar=document.querySelector('#app-toolbar').getBoundingClientRect();return {nav:sidebar.getBoundingClientRect().width,left:main.left-sidebar.getBoundingClientRect().right,gap:panel.left-main.right,top:main.top-toolbar.bottom,navBorder:getComputedStyle(sidebar).borderRightWidth};});
    assert.deepEqual(spacing,{nav:176,left:8,gap:8,top:8,navBorder:'0px'});
    assert.equal(await page.locator('#task-title, #model-picker-trigger, #parameter-toggle').evaluateAll(items=>items.every(item=>!item.closest('.card'))),true);
    assert.equal(await page.locator('.input-card, .result-card').evaluateAll(items=>items.every(item=>getComputedStyle(item).borderTopWidth==='0px'&&getComputedStyle(item).boxShadow==='none')),true);
    assert.equal(await page.locator('.topbar').count(), 0);
    assert.equal(await page.locator('#parameter-close').count(), 0);
    assert.equal(await page.locator('.parameter-rail').count(), 0);
    assert.equal(await page.locator('#app-toolbar #parameter-toggle').count(), 1);
    assert.equal(await page.locator('#app-toolbar #sidebar-toggle').count(), 0);
    assert.equal(await page.locator('#app-sidebar #sidebar-toggle').count(), 1);
    assert.equal(await page.locator('#workspace-settings #parameter-toggle').count(), 0);
    assert.equal(await page.locator('#app-sidebar .nav-caption').count(), 0);
    assert.deepEqual(await page.locator('#app-toolbar button').evaluateAll(items=>items.map(item=>item.id)),['tools-back','model-picker-trigger','parameter-toggle']);
    assert.deepEqual(await page.locator('html').evaluate(el=>[el.dataset.palette,el.dataset.theme]), ['classic','light']);
    assert.equal(await page.locator('body').evaluate(el=>getComputedStyle(el).fontSize), '14.4px');
    await page.locator('#parameter-toggle').click();
    const layout = await page.evaluate(() => {const content=document.querySelector('.main-content').getBoundingClientRect(),canvas=document.querySelector('.workspace-operation').getBoundingClientRect(),header=document.querySelector('#app-toolbar').getBoundingClientRect(),settings=document.querySelector('#workspace-settings').getBoundingClientRect();return {content:content.width,canvas:canvas.width,settings:settings.width,header:header.width};});
    assert.equal(layout.settings,0,'Collapsed parameters must not reserve any width');
    assert.equal(layout.canvas+layout.settings,layout.content-16);
    assert.equal(await page.locator('#workspace-settings').isVisible(),false);
    assert.equal(await page.locator('#parameter-toggle').isVisible(),true);
    await snapshot(page,'parameters-collapsed');
    assert.equal(layout.header,layout.canvas,'Task controls should share the workspace width');
    await page.locator('#parameter-toggle').click();
    assert.deepEqual(await page.locator('#app-sidebar > .main-nav [data-route]').evaluateAll(items => items.map(item => item.dataset.route)), ['tts','asr','music','design','vc','tools','scenarios','references','models','settings']);
    assert.equal(await page.locator('.sidebar-bottom #connection-status').count(), 1);
    const online = await page.locator('#server-dot').evaluate(el => getComputedStyle(el).backgroundColor);
    assert.equal(online, 'rgb(38, 134, 91)');
    await pick(page, 'tts-one');
    const geometry=await page.evaluate(()=>{const toolbar=document.querySelector('#app-toolbar').getBoundingClientRect(),picker=document.querySelector('#model-picker-trigger').getBoundingClientRect(),title=document.querySelector('#task-title').getBoundingClientRect();return {toolbar:toolbar.height,picker:picker.height,clearance:toolbar.bottom-picker.bottom,titleGap:picker.left-title.right};});
    assert.equal(geometry.toolbar,48);assert.equal(geometry.picker,38);assert.ok(geometry.clearance>=5);assert.equal(geometry.titleGap,16);
    assert.equal(await page.locator('#app-toolbar h1').count(),1);
    assert.equal(await page.locator('#load-workspace-model').count(),0);
    assert.equal(await page.locator('#workspace-load-status').count(),1);
    await snapshot(page,'cards-expanded-light');
    assert.equal(await page.locator('.brand-name').textContent(),'Aixora Audio');
    await task(page, 'asr', 'ASR One');
    assert.equal(await page.locator('#task-title').textContent(),'语音识别');
    await page.locator('#sidebar-toggle').click();
    assert.equal(await page.locator('#app-sidebar .nav-label').first().isVisible(), false);
    assert.equal(await page.locator('#server-dot').isVisible(), true);
    assert.equal(await page.locator('#app-sidebar .brand-name').isVisible(),false);
    assert.equal(await page.locator('#app-sidebar .brand-logo').isVisible(),true);
    assert.equal(await page.locator('#app-sidebar').evaluate(el=>el.getBoundingClientRect().width),60);
    await page.locator('#sidebar-toggle').click();
    await page.locator('[data-route="settings"]').click();
    assert.equal(await page.locator('#parameter-toggle').isVisible(),false,'Workspace controls must not leak into settings');
    await snapshot(page,'settings');
    await page.locator('[data-palette-choice="classic"]').click();
    const classic = await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor);
    await page.locator('[data-palette-choice="studio"]').click();
    assert.notEqual(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), classic);
    await page.locator('#theme-select').selectOption('dark');
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.palette === 'studio' && document.documentElement.dataset.theme === 'dark');
    assert.equal(await page.locator('[data-palette-choice="studio"]').getAttribute('aria-pressed'), 'true');
    await page.locator('[data-palette-choice="classic"]').click();
    await page.locator('#theme-select').selectOption('light');
    assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), classic);
    await page.locator('[data-settings-tab="runtime"]').click();
    await waitText(page,'#runtime-health','12345');
    await snapshot(page,'runtime');
    await page.locator('[data-settings-tab="api"]').click();
    await waitText(page,'#api-base',ORIGIN);
    await snapshot(page,'api');
    await page.locator('[data-route="models"]').click();
    assert.equal(await page.locator('#parameter-toggle').isVisible(),false);
    await page.locator('#model-list [data-model="tts-one"]').click();
    await waitText(page,'#model-detail','TTS One');
    await snapshot(page,'model-center');
    await page.locator('[data-route="tools"]').click();
    assert.equal(await page.locator('#parameter-toggle').isVisible(),false);
    await snapshot(page,'tools');
  }],
  ['menu defaults update immediately and an actually loaded model wins over an old selection', async (page, backend) => {
    await page.locator('#model-picker-trigger').click();
    assert.equal(await page.locator('[data-load-model="tts-one"]').textContent(),'已加载');
    await page.locator('[data-model-select="tts-two"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-model-select="tts-two"]').getAttribute('aria-pressed')==='true');
    assert.equal(await page.locator('[data-load-model="tts-one"]').textContent(),'已加载');
    assert.equal(await page.locator('[data-load-model="tts-two"]').textContent(),'加载','Previewing a row must not mark it loaded');
    await page.keyboard.press('Escape');
    await task(page,'asr');
    assert.equal(await page.locator('#model-picker-label').textContent(),'加载语音识别模型');
    await page.locator('[data-route="tts"]').click();
    await waitText(page,'#model-picker-label','TTS One');
    assert.equal(backend.loads.length,0,'Returning to a loaded model should not load it again');
    await task(page,'asr','ASR One');
    await task(page,'tts','TTS One');
    const gate=deferred();backend.detailGates.set('asr-one',gate);
    await task(page,'asr');
    assert.equal(await page.locator('#model-picker-label').textContent(),'加载语音识别模型','Previous menu label survived a pending model detail request');
    assert.equal(await page.locator('#workspace-start').isVisible(),true);
    gate.resolve();backend.detailGates.delete('asr-one');
    await page.locator('[data-route="music"]').click();
    await waitText(page,'#model-picker-label','加载音乐与音效模型');
    await page.locator('[data-route="tools"]').click();
    await page.locator('#tool-list').getByRole('button',{name:/字幕对齐/}).click();
    assert.equal(await page.locator('#task-title').textContent(),'字幕对齐');
    assert.equal(await page.locator('#model-picker-label').textContent(),'加载字幕对齐模型');
    assert.equal(await page.locator('#page-workspace #tools-back').isVisible(),true);
    assert.equal(await page.locator('#app-toolbar #tools-back').count(),1);
    await pick(page,'align-one');
    await snapshot(page,'tool');
    await page.locator('#tools-back').click();
    assert.equal(await page.locator('#page-tools').isVisible(),true);
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
  ['model loading keeps its button stable when selection details finish during a click', async (page, backend) => {
    const gate=deferred();backend.detailGates.set('tts-two',gate);
    await page.locator('#model-picker-trigger').click();
    await page.locator('[data-model-select="tts-two"]').click();
    const load=page.locator('[data-load-model="tts-two"]'),box=await load.boundingBox();
    await load.evaluate(el=>window.pendingLoadButton=el);
    await page.evaluate(()=>{window.selectionInputsRefreshed=false;const observer=new MutationObserver(()=>{window.selectionInputsRefreshed=true;observer.disconnect();});observer.observe(document.querySelector('#task-inputs'),{childList:true});});
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
    gate.resolve();backend.detailGates.delete('tts-two');
    await page.waitForFunction(()=>window.selectionInputsRefreshed&&document.querySelector('[data-model-select="tts-two"]').getAttribute('aria-pressed')==='true');
    await page.mouse.up();
    await waitUntil(()=>backend.loads.length===1,'Selection refresh swallowed the load click',2000);
    assert.equal(await page.evaluate(()=>window.pendingLoadButton.isConnected),true,'Selection replaced the load button');
    await waitText(page,'#workspace-load-status','已加载 · API：tts-two');
  }],
  ['unloaded detail errors and unconfirmed load responses remain retryable', async (page, backend) => {
    await page.locator('#model-picker-trigger').click();backend.detailError='tts-two';
    await page.locator('[data-load-model="tts-two"]').click();
    await waitText(page,'#model-picker-status','加载失败：Fixture detail failed');
    assert.equal(backend.loads.length,0);
    assert.equal(await page.locator('#model-picker-popover').isVisible(),true);
    await page.waitForFunction(()=>!document.querySelector('[data-load-model="tts-two"]').disabled);
    backend.detailError=null;backend.loadNoModel=true;
    await page.locator('[data-load-model="tts-two"]').click();
    await waitText(page,'#model-picker-status','尚未确认模型 tts-two 已加载');
    assert.equal(await page.locator('#workspace-grid').isVisible(),false);
    assert.equal(await page.locator('[data-load-model="tts-two"]').textContent(),'重试');
    await page.waitForFunction(()=>!document.querySelector('[data-load-model="tts-two"]').disabled);
    backend.loadNoModel=false;await page.locator('[data-load-model="tts-two"]').click();
    await waitText(page,'#workspace-load-status','已加载 · API：tts-two');
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
    assert.equal(await page.locator('#workspace-grid').isVisible(),false);
    assert.equal(await page.locator('#workspace-start').isVisible(),true);
    assert.equal(await page.locator('#model-picker-label').textContent(),'加载语音合成模型');
    assert.equal(await page.locator('#model-picker-heading').textContent(),'语音合成模型');
    assert.ok(!/已安装|已选择/.test(await page.locator('#model-picker-list').textContent()));
    assert.equal(backend.loads.length,0,'Selecting a row loaded the model');
    await page.locator('[data-load-model="tts-two"]').click();
    await waitText(page,'#model-picker-label','TTS Two');
    assert.equal(backend.loads.length,1);
    assert.equal(backend.loads[0].model,'tts-two');
    await page.locator('#model-picker-trigger').click();
    assert.equal(await page.locator('[data-load-model="tts-two"]').textContent(),'已加载');
    assert.equal(await page.locator('[data-load-model="tts-one"]').textContent(),'加载');
    await snapshot(page,'models-loaded');
    await page.locator('#task-title').click();
    assert.equal(await page.locator('#model-picker-popover').isVisible(),false,'Outside click did not dismiss the non-modal dropdown');
    await page.locator('[data-input-key="text"]').fill('The workspace stays interactive');
  }],
  ['task/model options stay isolated and explicit reload receives displayed options', async (page, backend) => {
    await advanced(page);
    await page.locator('#param-speed').fill('1.25');
    await page.locator('#param-load_options-threads').fill('6');
    await page.locator('#options-json').fill('{"temperature":0.7}');
    await pick(page, 'tts-two');
    await waitValue(page, '#param-speed', '1');
    await waitValue(page, '#param-load_options-threads', '4');
    await waitValue(page, '#options-json', '');
    await page.locator('#param-speed').fill('0.85');
    await page.locator('#param-load_options-threads').fill('3');
    await pick(page, 'tts-one');
    await waitValue(page, '#param-speed', '1.25');
    await waitValue(page, '#param-load_options-threads', '6');
    await waitValue(page, '#options-json', '{"temperature":0.7}');
    await task(page, 'asr', 'ASR One');
    await advanced(page);
    await waitValue(page, '#param-load_options-threads', '4');
    await page.locator('#param-load_options-threads').fill('2');
    await task(page, 'tts', 'TTS One');
    await waitValue(page, '#param-load_options-threads', '6');
    await pick(page, 'tts-one');
    assert.equal(backend.loads.at(-1).model, 'tts-one');
    assert.equal(backend.loads.at(-1).options['load_options.threads'], 6);
    assert.equal(backend.loads.at(-1).options.speed, 1.25);
    assert.equal(backend.loads.at(-1).options.temperature, .7);
    await page.locator('#param-load_options-threads').fill('8');
    await pick(page, 'tts-one');
    assert.equal(backend.loads.at(-1).options['load_options.threads'], 8);
    await pick(page, 'tts-two');
    await waitValue(page, '#param-speed', '0.85');
    await task(page, 'asr', 'ASR One');
    await waitValue(page, '#param-load_options-threads', '2');
  }],
  ['late TTS completion stays with TTS and each current result keeps every artifact', async (page, backend) => {
    await page.locator('[data-input-key="text"]').fill('First synthesis request');
    await page.locator('#run-button').click();
    await page.waitForFunction(() => !document.querySelector('#cancel-job').hidden);
    assert.equal(backend.requests.length, 1);
    await task(page, 'asr');
    assert.equal(await page.locator('#workspace-start').isVisible(),true);
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
    backend.finish('job-2', 'Second synthesis completed', ['second.wav']);
    await waitText(page, '#result-content', 'Second synthesis completed');
    const names = await page.locator('#result-content .artifact-name').allTextContents();
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
    await page.locator('[data-input-key="seed"]').fill('42');
    await page.locator('[data-input-key="stream"]').check();
    await pick(page, 'tts-two');
    await waitValue(page, '#param-speaker', 'voice-a');
    await waitValue(page, '[data-input-key="language"]', '');
    await waitValue(page, '[data-input-key="seed"]', '');
    assert.equal(await page.locator('[data-input-key="stream"]').isChecked(), false);
    await page.locator('[data-input-key="language"]').selectOption('english');
    await page.locator('[data-input-key="seed"]').fill('99');
    await pick(page, 'tts-one');
    await waitValue(page, '#param-speaker', 'voice-b');
    await waitValue(page, '[data-input-key="language"]', 'chinese');
    await waitValue(page, '[data-input-key="seed"]', '42');
    assert.equal(await page.locator('[data-input-key="stream"]').isChecked(), true);
    await page.locator('#reset-options').click();
    await waitValue(page, '#param-speaker', 'voice-a');
    await waitValue(page, '[data-input-key="text"]', 'Keep this text when resetting parameters');
    await task(page, 'asr', 'ASR One');
    await upload(page, 'input[type=file][data-input-key="audio"]', 'keep-source.wav');
    await page.locator('[data-input-key="context"]').fill('Keep this transcription hint');
    await page.locator('#reset-options').click();
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
  ['slow upload responses cannot replace newer or removed material', async (page, backend) => {
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
    const removed = backend.holdUpload('removed-source.wav');
    await page.locator('input[type=file][data-input-key="audio"]').setInputFiles({name:'removed-source.wav', mimeType:'audio/wav', buffer:wav()});
    await waitUntil(() => backend.uploads.length === 3, 'Pending removable upload did not reach fixture');
    await page.locator('#task-inputs .upload-clear').click();
    removed.resolve();
    await page.waitForFunction(() => !document.querySelector('#run-button').disabled);
    await task(page, 'tts', 'TTS One');
    await task(page, 'asr', 'ASR One');
    assert.ok(!(await page.locator('#task-inputs').textContent()).includes('removed-source.wav'));
    assert.ok(!(await page.locator('#task-inputs').textContent()).includes('new-source.wav'));
    assert.equal(await page.locator('#task-inputs audio:not([hidden])').count(), 0);
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
    await page.locator('#task-inputs').getByRole('button', {name:'使用麦克风录制'}).click();
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
    const originalMarker = await page.locator('#result-content audio').evaluate(async audio => {
      const data = await (await fetch(audio.src)).arrayBuffer();
      return new DataView(data).getInt16(44, true);
    });
    assert.equal(originalMarker, 101, 'ASR result original-audio player changed to the next draft');
    await waitText(page, '#task-inputs', 'next-draft.wav');
  }],
  ['uploaded audio waveform seeks real audio and clears with its material', async (page) => {
    await task(page, 'asr', 'ASR One');
    await page.locator('[data-input-key="audio"]').setInputFiles({name:'waveform.wav', mimeType:'audio/wav', buffer:wav(2000)});
    await page.locator('#task-inputs .audio-waveform').waitFor();
    const seek = page.locator('#task-inputs .waveform-position');
    assert.equal(Number(await seek.getAttribute('max')), .1);
    await seek.evaluate(element => {element.value = '.05'; element.dispatchEvent(new Event('input', {bubbles:true}));});
    await page.waitForFunction(() => Math.abs(document.querySelector('#task-inputs audio').currentTime - .05) < .001);
    await page.locator('#task-inputs .upload-clear').click();
    assert.equal(await page.locator('#task-inputs .waveform-panel').count(), 0);
    assert.equal(await page.locator('#task-inputs audio').isVisible(), false);
  }],
  ['card layout fits desktop and narrow screens in both palettes and themes', async (page) => {
    for(const palette of ['classic','studio'])for(const theme of ['light','dark']){
      await page.evaluate(({palette,theme})=>{document.documentElement.dataset.palette=palette;document.documentElement.dataset.theme=theme;},{palette,theme});
      for(const width of [1440,1024,390,320]){
        await page.setViewportSize({width,height:1000});
        await page.waitForFunction(()=>document.querySelector('#parameter-toggle').getAttribute('aria-expanded')===String(innerWidth>1180));
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${palette}/${theme}/${width} horizontal overflow`);
        assert.equal(await page.locator('#task-title, #model-picker-trigger, #parameter-toggle').evaluateAll(items=>items.every(item=>!item.closest('.card'))),true);
        if(width>=760)assert.ok(await page.locator('.sidebar-controls').evaluate(el=>el.querySelector('.brand').getBoundingClientRect().right<=el.querySelector('button').getBoundingClientRect().left),'Brand overlaps navigation toggle');
        await snapshot(page,`cards-${palette}-${theme}-${width}`);
        await page.locator('#model-picker-trigger').click();
        assert.ok(await page.locator('#model-picker-popover').evaluate(el=>{const box=el.getBoundingClientRect(),sidebar=document.querySelector('#app-sidebar').getBoundingClientRect();return box.left>=sidebar.right&&box.right<=innerWidth;}),'Model picker covers navigation or leaves viewport');
        await page.keyboard.press('Escape');
        if(width<=1180){
          await page.locator('#parameter-toggle').click();
          assert.ok(await page.locator('#workspace-settings').evaluate(el=>{const box=el.getBoundingClientRect();return box.left>=0&&box.right<=innerWidth;}),'Parameters leave viewport');
          assert.equal(await page.locator('#parameter-toggle').evaluate(el=>document.elementFromPoint(el.getBoundingClientRect().left+16,el.getBoundingClientRect().top+16)?.closest('button')===el),true,'Parameter toggle is covered by its drawer');
          await page.keyboard.press('Escape');
          assert.equal(await page.evaluate(()=>document.activeElement.id),'parameter-toggle');
        }
      }
    }
  }],
  ['narrow-screen parameter drawer opens, closes, and restores focus', async (page) => {
    await page.setViewportSize({width:390, height:844});
    await page.waitForFunction(() => document.querySelector('#parameter-toggle').getAttribute('aria-expanded') === 'false');
    assert.equal(await page.locator('#workspace-settings').isVisible(),false);
    await snapshot(page,'mobile-loaded');
    await page.locator('#parameter-toggle').click();
    await page.waitForFunction(() => document.querySelector('#parameter-toggle').getAttribute('aria-expanded') === 'true');
    await page.waitForFunction(() => {
      const box = document.querySelector('#workspace-settings').getBoundingClientRect();
      return box.x >= 0 && box.x + box.width <= innerWidth + 1;
    });
    const box = await page.locator('#workspace-settings').boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 391, `Drawer outside viewport: ${JSON.stringify(box)}`);
    for (let index = 0; index < 18; index++) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id === 'parameter-toggle' || document.querySelector('#workspace-settings').contains(document.activeElement)), true,
        `Parameter drawer allowed Tab ${index+1} to leave: ${await page.evaluate(() => document.activeElement.outerHTML.slice(0,250))}`);
    }
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id === 'parameter-toggle' || document.querySelector('#workspace-settings').contains(document.activeElement)), true);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#parameter-toggle').getAttribute('aria-expanded') === 'false');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'parameter-toggle');
    await page.locator('#parameter-toggle').click();
    await page.locator('#parameter-toggle').click();
    assert.equal(await page.locator('#parameter-toggle').getAttribute('aria-expanded'), 'false');
    await page.locator('#parameter-toggle').click();
    await page.locator('#parameter-backdrop').click({position:{x:8,y:100}});
    assert.equal(await page.locator('#parameter-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#parameter-backdrop').isVisible(), false);
    assert.equal(await page.locator('#workspace-settings').isVisible(),false);
    await page.locator('#sidebar-toggle').click();
    assert.equal(await page.locator('#sidebar-backdrop').isVisible(), true);
    for (let index = 0; index < 18; index++) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id==='sidebar-toggle'||document.querySelector('#app-sidebar').contains(document.activeElement)), true, 'Sidebar drawer allowed Tab to leave its controls');
    }
    await page.locator('#sidebar-backdrop').click({position:{x:380,y:100}});
    assert.equal(await page.locator('#sidebar-backdrop').isVisible(), false);
    assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'), 'false');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Horizontal document overflow');
  }],
];

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
        await waitText(page, '#model-picker-label', backend.status.server.model?'TTS One':'加载语音合成模型');
        await run(page, backend);
        assert.deepEqual(backend.errors, [], 'Unexpected network or fixture errors');
        assert.deepEqual(errors, [], 'Browser console/page errors');
        console.log(`PASS ${name}`);
      } catch (error) {
        failures++;
        console.error(`FAIL ${name}\n${error.stack || error}`);
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
