const API = '/api/workbench';
const $ = (id) => document.getElementById(id);
const TASKS = [
  {id:'tts',label:'文字转语音',title:'把文字变成声音',description:'输入要说的话，选择音色，生成属于你的配音。',action:'生成语音',types:['tts','clon']},
  {id:'asr',label:'语音转文字',title:'听见内容，留下文字',description:'上传或录制音频，自动识别其中的语音。',action:'开始转写',types:['asr']},
  {id:'music',label:'音乐创作',title:'用想法创作音乐',description:'描述音乐风格或填写歌词，开始一次创作。',action:'生成音乐',types:['gen']},
  {id:'vc',label:'声音转换',title:'为音频换一种声音',description:'添加源音频，再选择要转换成的声音。',action:'开始转换',types:['vc','svc','s2s']},
  {id:'separation',label:'音源分离',title:'听清每一种声音',description:'从歌曲或录音中分离人声、伴奏或指定声音。',action:'开始分离',types:['sep']},
  {id:'analysis',label:'音频分析',title:'发现声音里的细节',description:'检测语音、区分说话人、对齐字幕，或提取乐谱。',action:'开始分析',types:['vad','diar','align','midi','turn','spk']},
  {id:'design',label:'声音设计',title:'描述你想要的声音',description:'用文字描述音色与表达方式，再听听它的声音。',action:'设计声音',types:['vdes']},
];
const TASK_NAMES = {tts:'文字转语音',clon:'声音克隆',asr:'语音转文字',gen:'音乐创作',vc:'声音转换',svc:'歌声转换',s2s:'音频处理',sep:'音源分离',vad:'语音片段检测',diar:'说话人区分',align:'字幕对齐',midi:'乐谱提取',turn:'说完检测',spk:'说话人识别',vdes:'声音设计'};
const LANGUAGE_NAMES={english:'英语',chinese:'中文',japanese:'日语',french:'法语',german:'德语',italian:'意大利语',portuguese:'葡萄牙语',spanish:'西班牙语',korean:'韩语',russian:'俄语',arabic:'阿拉伯语',hindi:'印地语',vietnamese:'越南语',cantonese:'粤语',thai:'泰语',indonesian:'印尼语',auto:'自动'};
const state = {catalog:null,task:'tts',analysisType:'',page:'workspace',model:null,detail:null,detailSeq:0,librarySeq:0,libraryModel:null,forms:{},overrides:{},modelChoices:{},downloads:[],job:null,playback:null,submitting:false,jobTimer:null,voices:[],recorders:new Set(),uploading:0};
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
let toastTimer;

function node(tag, className='', text) { const n=document.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=String(text);return n; }
function button(text, className, fn) { const n=node('button',className,text);n.type='button';n.addEventListener('click',fn);return n; }
function replace(el, ...children) { el.replaceChildren(...children.filter(Boolean)); }
function taskInfo() { return TASKS.find(t=>t.id===state.task); }
function formValues() { return state.forms[state.task] ||= {}; }
function friendlyError(error) { return error instanceof Error ? error.message : String(error || '操作未完成，请稍后重试。'); }
function showToast(message) { $('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5000); }
async function api(path, options={}) {
  const headers = new Headers(options.headers || {});
  let body=options.body;
  if(body!==undefined && !(body instanceof FormData)){headers.set('Content-Type','application/json');body=JSON.stringify(body);}
  let response;
  try { response=await fetch(API+path,{...options,headers,body}); }
  catch { throw new Error('暂时无法连接本地服务，请确认 WebUI 仍在运行，然后重试。'); }
  const raw=await response.text();let data;
  try { data=raw?JSON.parse(raw):{}; } catch { throw new Error(response.ok?'服务返回了无法读取的内容，请刷新页面重试。':`服务暂时无法处理请求（${response.status}），请稍后重试。`); }
  if(!response.ok){const detail=data.detail??data.error??data.message;throw new Error(typeof detail==='string'?detail:detail?JSON.stringify(detail):`请求未完成（${response.status}）。`);}
  return data;
}
async function runAction(control, fn) { control.disabled=true;try{await fn();}catch(error){showToast(friendlyError(error));}finally{control.disabled=false;} }
function formatBytes(value) { if(!Number.isFinite(Number(value)) || Number(value)<=0)return '待确认';let n=Number(value),i=0;const units=['B','KB','MB','GB','TB'];while(n>=1024&&i<units.length-1){n/=1024;i++;}return `${n.toFixed(i>1?1:0)} ${units[i]}`; }
function formatDuration(value) { const n=Number(value);if(!Number.isFinite(n)||n<0)return '';return n<60?`${Math.ceil(n)} 秒`:`${Math.floor(n/60)} 分 ${Math.round(n%60)} 秒`; }
function shortText(value) { if(typeof value==='string')return value;if(value==null)return '';return JSON.stringify(value); }
function sourceLink(source) { const raw=typeof source==='string'?source:source?.url||source?.repo||'';if(!raw)return null;let url=raw;if(/^[\w.-]+\/[\w.-]+$/.test(url))url='https://huggingface.co/'+url;try{const u=new URL(url);if(!['https:','http:'].includes(u.protocol))return null;return u.href;}catch{return null;} }
function safeArtifactUrl(raw) { try{const url=new URL(raw,location.href);return url.origin===location.origin&&['http:','https:'].includes(url.protocol)?url.href:null;}catch{return null;} }
function choicesOf(values) { return (values||[]).map(v=>Array.isArray(v)?{label:String(v[0]),value:v[1]}:v&&typeof v==='object'?{label:String(v.label??v.name??v.value),value:v.value??v.id??v.name}:{label:String(v),value:v}); }
function fillSelect(select, choices, value) { select.replaceChildren();for(const c of choicesOf(choices)){const opt=node('option','',c.label);opt.value=c.value==null?'':String(c.value);select.append(opt);}if(value!=null)select.value=String(value); }
function badge(text, type='') { return node('span',`badge ${type}`,text); }
function backendLabel(value) { return value==='cuda'?'NVIDIA GPU':value==='cpu'?'CPU':String(value||'自动'); }

function readTheme() { try{return localStorage.getItem('audiocpp-workbench-theme')||'light';}catch{return 'light';} }
function readPalette() {try{return localStorage.getItem('audiocpp-workbench-palette')||'forest';}catch{return 'forest';}}
function syncRealtimeTheme() {const frame=$('realtime-frame');if(frame.hasAttribute('src')&&frame.contentWindow)frame.contentWindow.postMessage({type:'audiocpp:theme',theme:document.documentElement.dataset.theme,palette:document.documentElement.dataset.palette},location.origin);}
function applyPalette(value=readPalette()) {if(!['classic','forest'].includes(value))value='forest';document.documentElement.dataset.palette=value;document.querySelectorAll('[data-palette-choice]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.paletteChoice===value)));syncRealtimeTheme();}
function setPalette(value) {try{localStorage.setItem('audiocpp-workbench-palette',value);}catch{}applyPalette(value);}
document.querySelectorAll('[data-palette-choice]').forEach(b=>b.addEventListener('click',()=>setPalette(b.dataset.paletteChoice)));
function applyTheme(value=readTheme()) { if(!['light','dark','system'].includes(value))value='system';document.documentElement.dataset.theme=value==='system'?(systemTheme.matches?'dark':'light'):value;$('theme-select').value=value;syncRealtimeTheme(); }
function setTheme(value) { try{localStorage.setItem('audiocpp-workbench-theme',value);}catch{}applyTheme(value); }
$('theme-select').addEventListener('change',event=>setTheme(event.target.value));
systemTheme.addEventListener('change',()=>{if(readTheme()==='system')applyTheme();});
$('realtime-frame').addEventListener('load',syncRealtimeTheme);
applyPalette();applyTheme();

function navigate(page, updateHash=true) {
  if(!['workspace','realtime','models','api','settings'].includes(page))page='workspace';
  if(state.page!==page)window.scrollTo(0,0);
  state.page=page;
  document.body.classList.toggle('scene-mode',page==='realtime');
  document.querySelectorAll('.page').forEach(p=>{p.hidden=p.id!==`page-${page}`;p.classList.toggle('active',!p.hidden);});
  document.querySelectorAll('[data-page]').forEach(b=>{const active=b.dataset.page===page;b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  const labels={workspace:'音频工作台',realtime:'实时聊天',models:'模型中心',api:'API 调用',settings:'设置'};
  $('breadcrumb').textContent=`工作空间 / ${labels[page]}`;
  if(updateHash&&location.hash!==`#${page}`)history.replaceState(null,'',`#${page}`);
  if(page==='realtime'){const frame=$('realtime-frame');if(!frame.hasAttribute('src'))frame.src=frame.dataset.src;}
  if(page==='api')loadApiDocs();
  if(page==='models')pollDownloads();
}
window.addEventListener('message',event=>{
  if(event.origin!==location.origin||event.source!==$('realtime-frame').contentWindow)return;
  if(event.data?.type==='audiocpp:back'){navigate('workspace');if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});}
});
document.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.page)));
window.addEventListener('hashchange',()=>navigate(location.hash.slice(1),false));
$('browse-models').addEventListener('click',()=>{$('model-task-filter').value=state.task;renderLibrary();navigate('models');});
for(const t of TASKS){const b=button(t.label,'task-button',()=>selectTask(t.id));b.dataset.task=t.id;b.setAttribute('role','tab');$('task-nav').append(b);}
fillSelect($('model-task-filter'),[{label:'所有用途',value:''},...TASKS.map(t=>({label:t.label,value:t.id}))],'');
['model-search','model-task-filter','model-state-filter'].forEach(id=>$(id).addEventListener('input',renderLibrary));
$('refresh-catalog').addEventListener('click',event=>runAction(event.currentTarget,async()=>{await loadCatalog();showToast('模型列表已更新');}));

function modelTask(model) { return model.model_task||model.ui_task||model.task; }
function fitsTask(model, task=state.task) { const t=TASKS.find(v=>v.id===task);return t&&(t.types.includes(modelTask(model))||modelTask(model)===task); }
async function loadCatalog() {
  const data=await api('/catalog');state.catalog=data;
  $('connection-error').hidden=true;
  $('version-label').textContent=`audio.cpp ${data.version||''}`;
  updateStatus(data);
  renderLibrary();
  await refreshWorkspaceModels();
}
async function selectTask(id, modelId) {
  if(id!==state.task)stopRecordings();
  state.task=id;
  if(modelId){state.modelChoices[id]=modelId;if(id==='analysis')state.analysisType=modelTask((state.catalog?.models||[]).find(m=>m.id===modelId)||{});}
  for(const b of $('task-nav').children){const active=b.dataset.task===id;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;}
  const t=taskInfo();$('task-title').textContent=t.title;$('task-description').textContent=t.description;
  await refreshWorkspaceModels();
}
$('task-nav').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;const i=TASKS.findIndex(t=>t.id===state.task);const next=event.key==='Home'?0:event.key==='End'?TASKS.length-1:(i+(event.key==='ArrowRight'?1:-1)+TASKS.length)%TASKS.length;event.preventDefault();selectTask(TASKS[next].id);$('task-nav').children[next].focus();});
async function refreshWorkspaceModels() {
  const models=(state.catalog?.models||[]).filter(m=>m.installed&&fitsTask(m)&&(state.task!=='analysis'||!state.analysisType||modelTask(m)===state.analysisType));
  const wanted=state.modelChoices[state.task];const selected=models.find(m=>m.id===wanted)||models[0];
  fillSelect($('workspace-model'),models.length?models.map(m=>({label:m.label||m.id,value:m.id})):[{label:'还没有适用的已安装模型',value:''}],selected?.id||'');
  $('workspace-model').disabled=!models.length;
  if(selected){if(state.model!==selected.id||!state.detail)await selectModel(selected.id);}
  else {state.model=null;state.detail=null;state.detailSeq++;$('workspace-model-description').textContent='先到模型中心下载一个适用模型。下载完成后，这里会自动更新。';replace($('workspace-model-badges'));replace($('effect-controls'),node('p','muted small','选好模型后，会显示适用于它的设置。'));replace($('expert-controls'));renderInputs();updateRunButton();}
}
$('workspace-model').addEventListener('change',event=>selectModel(event.target.value));
async function selectModel(id) {
  const seq=++state.detailSeq;const changed=state.model!==id;state.model=id;state.modelChoices[state.task]=id;
  if(changed){stopRecordings();state.detail=null;state.overrides={};$('options-json').value='';}
  updateRunButton();
  $('workspace-model-description').textContent='正在读取模型设置…';
  try {
    const detail=await api(`/models/${encodeURIComponent(id)}`);if(seq!==state.detailSeq)return;
    state.detail=detail;
    $('workspace-model-description').textContent=detail.description||detail.input_hint||'已安装，可直接使用。';
    const badges=[badge('已安装','success'),badge(TASK_NAMES[modelTask(detail)]||taskInfo().label)];
    if(detail.backend)badges.push(badge(backendLabel(detail.backend)));
    if(detail.streaming)badges.push(badge('支持流式'));
    replace($('workspace-model-badges'),...badges);
    renderInputs();renderParameters();updateRunButton();
  }catch(error){if(seq!==state.detailSeq)return;state.detail=null;$('workspace-model-description').textContent=friendlyError(error);updateRunButton();}
}
function updateRunButton() { const b=$('run-button');b.disabled=!state.detail||!!state.job||state.submitting||state.uploading>0||state.recorders.size>0;b.textContent=state.job?'任务进行中…':state.submitting?'正在提交…':state.uploading?'正在上传…':`${taskInfo().action} →`; }
function stopRecordings() {for(const recorder of state.recorders)if(recorder.state==='recording')recorder.stop();}
function updateRecordingBanner() {const recording=[...state.recorders].filter(r=>r.state==='recording');$('recording-banner').hidden=!recording.length;if(recording.length){const started=Math.min(...recording.map(r=>r._started||Date.now()));$('recording-elapsed').textContent=` · ${formatDuration((Date.now()-started)/1000)}`;}}
$('stop-all-recordings').addEventListener('click',stopRecordings);
function languageChoices(values,automatic='自动') {const seen=new Set(['','auto']);const choices=[{label:automatic,value:''}];for(const item of choicesOf(values)){const key=String(item.value).toLowerCase();if(seen.has(key))continue;seen.add(key);choices.push({label:LANGUAGE_NAMES[key]||item.label,value:item.value});}return choices;}
function visibleParameters() {const task=state.task,detail=state.detail||{};const dedicatedLanguage=(['tts','asr'].includes(task)&&detail.languages?.length)||(task==='analysis'&&modelTask(detail)==='align');return (detail.parameters||[]).filter(p=>!(dedicatedLanguage&&p.name==='language')&&!(task==='design'&&['instruction','instruct'].includes(p.name)));}

function field(label, input, help='', required=false) { const group=node('div','field-group');const labelEl=node('label','field-label',label);if(input.id)labelEl.htmlFor=input.id;if(required)labelEl.append(node('span','required','必填'));group.append(labelEl,input);if(help)group.append(node('p','field-help',help));return group; }
function textInput(key,label,{help='',placeholder='',required=false,rows=0,type='text',value, min, max,step}={}) {
  const values=formValues();const input=node(rows?'textarea':'input',rows>=4?'large-text':'');input.id=`input-${state.task}-${key}`;input.dataset.inputKey=key;if(rows)input.rows=rows;else input.type=type;input.placeholder=placeholder;input.required=required;
  if(min!==undefined)input.min=min;if(max!==undefined)input.max=max;if(step!==undefined)input.step=step;
  input.value=values[key]??value??'';input.addEventListener('input',()=>{values[key]=type==='number'?(input.value===''?'':Number(input.value)):input.value;});
  return field(label,input,help,required);
}
function selectInput(key,label,choices,{help='',value=''}={}) { const values=formValues();const input=node('select');input.id=`input-${state.task}-${key}`;input.dataset.inputKey=key;fillSelect(input,choices,values[key]??value);input.addEventListener('change',()=>values[key]=input.value);return field(label,input,help); }
function checkboxInput(key,label,help='') { const values=formValues();const group=node('div','field-group');const row=node('label','check-label');const input=node('input');input.type='checkbox';input.dataset.inputKey=key;input.checked=!!values[key];input.addEventListener('change',()=>values[key]=input.checked);row.append(input,node('span','',label));group.append(row);if(help)group.append(node('p','field-help',help));return group; }
function uploadInput(key,label,{required=false,help='',accept='audio/*,.wav,.mp3,.flac,.m4a,.ogg,.webm',record=true}={}) {
  const values=formValues();const zone=node('div','upload-zone');const file=node('input');file.type='file';file.accept=accept;file.id=`input-${state.task}-${key}`;file.dataset.inputKey=key;file.setAttribute('aria-label',label);
  const controls=node('div','upload-controls');const status=node('span','upload-status',values[`_${key}Name`]||'还没有添加文件');const clear=button('移除','upload-clear',()=>{values[key]='';values[`_${key}Name`]='';if(values[`_${key}Url`])URL.revokeObjectURL(values[`_${key}Url`]);delete values[`_${key}Url`];file.value='';status.textContent='还没有添加文件';preview.hidden=true;preview.removeAttribute('src');});
  const preview=node('audio');preview.controls=true;preview.preload='metadata';preview.hidden=true;
  if(values[`_${key}Url`]){preview.src=values[`_${key}Url`];preview.hidden=false;}
  async function upload(blob,name) {
    state.uploading++;updateRunButton();file.disabled=true;status.textContent='正在上传…';
    try {const data=new FormData();data.append('file',blob,name);const result=await api('/uploads',{method:'POST',body:data});values[key]=result.id;values[`_${key}Name`]=result.name||name;status.textContent=values[`_${key}Name`];if(record){const old=values[`_${key}Url`];if(old)URL.revokeObjectURL(old);const url=URL.createObjectURL(blob);values[`_${key}Url`]=url;preview.src=url;preview.hidden=false;}}
    catch(error){status.textContent=friendlyError(error);showToast(friendlyError(error));}
    finally{state.uploading--;file.disabled=false;updateRunButton();}
  }
  file.addEventListener('change',()=>{if(file.files[0])upload(file.files[0],file.files[0].name);});
  controls.append(status,clear);
  zone.append(file,controls);
  if(record){
    const recordBtn=button('使用麦克风录制','button subtle small-button',async()=>{
      if(recordBtn._recorder?.state==='recording'){recordBtn._recorder.stop();return;}
      if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){showToast('此浏览器不支持录音，请使用 Chrome / Edge，或上传音频文件。');return;}
      if(state.recorders.size){showToast('已有录音正在进行，请先用顶部按钮停止录音。');return;}
      let stream,recorder;
      try {
        stream=await navigator.mediaDevices.getUserMedia({audio:true});const chunks=[];const supported=['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4'].find(t=>MediaRecorder.isTypeSupported(t));recorder=new MediaRecorder(stream,supported?{mimeType:supported}:{});
        recorder._started=Date.now();recordBtn._recorder=recorder;state.recorders.add(recorder);recordBtn.textContent='停止录音';recordBtn.classList.add('recording');status.textContent='录音中…';updateRunButton();
        recorder.addEventListener('dataavailable',event=>{if(event.data.size)chunks.push(event.data);});
        recorder.addEventListener('stop',async()=>{stream.getTracks().forEach(t=>t.stop());state.recorders.delete(recorder);updateRecordingBanner();recordBtn.textContent='使用麦克风录制';recordBtn.classList.remove('recording');const type=recorder.mimeType||'audio/webm';const ext=type.includes('mp4')?'m4a':type.includes('ogg')?'ogg':'webm';if(chunks.length)await upload(new Blob(chunks,{type}),`录音-${Date.now()}.${ext}`);else{status.textContent='没有录制到音频，请重试。';updateRunButton();}});
        recorder.addEventListener('error',()=>{stream.getTracks().forEach(t=>t.stop());state.recorders.delete(recorder);updateRecordingBanner();recordBtn.textContent='重新录音';recordBtn.classList.remove('recording');status.textContent='录音中断，请重试。';updateRunButton();});recorder.start();updateRecordingBanner();
      }catch(error){stream?.getTracks().forEach(t=>t.stop());if(recorder)state.recorders.delete(recorder);updateRecordingBanner();updateRunButton();showToast(error.name==='NotAllowedError'?'录音需要麦克风权限，请在浏览器地址栏允许访问后重试。':'无法启动麦克风，请检查设备是否被占用。');}
    });
    zone.append(recordBtn,preview);
  }
  return field(label,zone,help,required);
}
function addReferenceFields(container, profile) {
  if(profile.accepts_voice_reference===false)return;
  const sourceAudio=profile.voice_input_role==='source_audio';
  const voices=[{label:'上传或录制新的声音',value:''},...state.voices.map(v=>({label:v.name,value:v.name}))];
  container.append(selectInput('builtin_voice',sourceAudio?'已保存的源音频':'参考音色',voices,{help:'可使用已保存的声音，也可添加自己的音频。'}));
  container.append(uploadInput('voice',sourceAudio?'要编辑的源音频':'参考声音',{required:!!profile.require_voice,help:sourceAudio?'上传本次需要编辑的语音。':'尽量使用单人、清晰、没有背景音乐的音频。'}));
  if(!sourceAudio&&profile.send_reference_text!==false)container.append(textInput('reference_text','参考音频中的原话',{rows:2,help:profile.require_reference_text||state.detail?.requires_reference_text?'此模型需要参考原文。已保存的音色会自动读取它的原文；上传新音频时请填写。':'填写参考音频实际说出的内容，可帮助模型更准确地学习声音。'}));
}
function renderInputs() {
  stopRecordings();
  const container=$('task-inputs');replace(container);
  const detail=state.detail,profile=detail?.profile||{},task=state.task,actual=modelTask(detail||{});
  if(detail)for(const param of visibleParameters())if(param.level==='basic')container.append(parameterControl(param));
  if(task==='tts'||task==='design'){
    if(task==='design')container.append(textInput('instruct','描述想要的声音',{rows:3,required:true,placeholder:'例如：温暖、低沉的成年男声，语气平静，像在讲述一个故事。'}));
    container.append(textInput('text','要说的内容',{rows:5,required:true,placeholder:'在这里输入要合成的文字…'}));
    if(task==='tts'&&detail?.languages?.length)container.append(selectInput('language','语言',languageChoices(detail.languages)));
    if(task==='tts'&&detail?.voice_mode!=='builtin')addReferenceFields(container,profile);
    if(task==='design'&&profile.require_voice)addReferenceFields(container,profile);
  }else if(task==='asr'){
    container.append(uploadInput('audio','待转写的音频',{required:true}));
    const options=node('details','expert-panel');options.append(node('summary','','转写选项'));const inner=node('div','form-fields');inner.style.marginTop='15px';
    if(detail?.languages?.length)inner.append(selectInput('language','识别语言',languageChoices(detail.languages,'自动检测')));
    inner.append(textInput('context','专有名词提示',{rows:2,placeholder:'例如：人名、品牌名、专业术语',help:'模型支持时用于辅助识别专有名词。'}));
    inner.append(checkboxInput('detailed','保留时间戳等详细结果','仅支持普通离线转写，与说话人对话和流式模式互斥。'));
    inner.append(checkboxInput('dialogue','区分对话中的说话人','使用 Sortformer，适用于 120 秒以内的对话，与详细结果和流式模式互斥。'));
    if(detail?.streaming)inner.append(checkboxInput('stream','使用流式处理','当前工作台会在处理完成后显示完整结果。'));
    const modes=[...inner.querySelectorAll('input[type="checkbox"]')].filter(input=>['detailed','dialogue','stream'].includes(input.dataset.inputKey));
    for(const mode of modes)mode.addEventListener('change',()=>{if(mode.checked)for(const other of modes)if(other!==mode){other.checked=false;formValues()[other.dataset.inputKey]=false;}});
    options.append(inner);container.append(options);
  }else if(task==='music'){
    container.append(textInput('text','描述音乐或音效',{rows:4,placeholder:'例如：轻快的流行音乐，温暖的钢琴，明亮的节奏。'}));
    container.append(textInput('lyrics','歌词',{rows:4,required:!!profile.require_lyrics,placeholder:'可选；纯音乐可留空。'}));
    container.append(textInput('duration','目标时长（秒）',{type:'number',value:30,min:-1,step:1,help:'设为 -1 时由模型决定；支持的时长取决于模型。'}));
    container.append(uploadInput('audio','源音频',{required:!!profile.require_source_audio,help:'续写、翻唱或编辑时使用；纯文字生成可留空。'}));
  }else if(task==='vc'){
    container.append(uploadInput('audio','要转换的源音频',{required:true}));
    if(detail?.voice_mode==='rvc'||profile.model_as_target_voice){container.append(uploadInput('rvc_voice_model','目标声音模型',{accept:'.pth,.pt',record:false,help:'可选，上传 RVC 声音模型；留空时使用选定的打包音色。'}));container.append(uploadInput('rvc_retrieval_index','声音检索索引',{accept:'.index',record:false,help:'可选，仅用于 RVC。'}));}
    else if(profile.accepts_voice_reference!==false){container.append(selectInput('builtin_voice','已保存的目标音色',[{label:'上传或录制新的声音',value:''},...state.voices.map(v=>({label:v.name,value:v.name}))]));container.append(uploadInput('voice','目标声音',{required:!!profile.require_vc_target,help:'上传想要转换成的声音参考，或选择已保存的目标音色。'}));}
  }else if(task==='separation'){
    container.append(uploadInput('audio','要分离的音频',{required:true}));
    if(profile.require_separation_prompt||detail?.family==='sam_audio')container.append(textInput('text','想提取什么声音',{rows:2,required:true,placeholder:'例如：说话的人声、狗叫声、钢琴声。'}));
  }else if(task==='analysis'){
    const kind=node('select');kind.id='analysis-kind';fillSelect(kind,[{label:'自动选择已安装的用途',value:''},...TASKS.find(t=>t.id==='analysis').types.map(value=>({label:TASK_NAMES[value],value}))],state.analysisType);kind.addEventListener('change',()=>{state.analysisType=kind.value;refreshWorkspaceModels();});container.append(field('想分析什么',kind,'工作台会只显示适用于此用途的模型。'));
    if(detail)container.append(node('div','no-model-note',`当前分析：${TASK_NAMES[actual]||'音频分析'}`));
    container.append(uploadInput('audio','要分析的音频',{required:true}));
    if(actual==='align'){container.append(textInput('transcript','音频原文',{rows:4,required:true,help:'粘贴音频中实际说出的完整原文，模型将为它标注时间位置。'}));container.append(textInput('language','语言',{required:!!profile.require_analysis_language,placeholder:'例如：Chinese / English'}));}
  }
  if(!detail)container.prepend(node('div','no-model-note','先在模型中心安装一个适用模型，即可开始。'));
  $('input-hint').textContent=detail?'首次运行需要加载模型，请稍候。':'先选择一个已安装的模型';
}

function parameterControl(param) {
  const key=param.name;const modified=Object.hasOwn(state.overrides,key);const current=modified?state.overrides[key]:param.default;
  const type=param.type;let input;const choices=param.choices||param.values;
  if(type==='bool'||type==='boolean') {input=node('input');input.type='checkbox';input.checked=!!current;}
  else if(choices?.length){input=node('select');const items=choicesOf(choices);if(current==null)items.unshift({label:'模型默认',value:''});fillSelect(input,items,current);}
  else if(['slider','number','int','float'].includes(type)){input=node('input');input.type=type==='slider'?'range':'number';const min=param.min??param.minimum,max=param.max??param.maximum;if(min!=null)input.min=min;if(max!=null)input.max=max;input.step=param.step??(type==='int'?1:'any');input.value=current??'';if(current==null)input.placeholder='模型默认';}
  else{input=node('input');input.type='text';input.value=current==null?'':typeof current==='object'?JSON.stringify(current):current;input.placeholder='模型默认';}
  input.id=`param-${key.replace(/[^\w-]/g,'-')}`;
  const label=param.label||key;const help=param.help||param.info||param.description||'';let group;
  if(input.type==='checkbox'){group=node('div','field-group');const row=node('label','check-label');row.htmlFor=input.id;row.append(input,node('span','',label));group.append(row);if(help)group.append(node('p','field-help',help));}
  else group=field(label,input,help);
  if(param.scope&&param.scope!=='request'){const tag=node('span','runtime-tag','需重载');group.querySelector('label')?.append(tag);}
  let output;if(input.type==='range'){output=node('div','range-value',current);input.after(output);}
  input.addEventListener('input',()=>{
    let value=input.type==='checkbox'?input.checked:input.value;
    if(input.type==='number'||input.type==='range')value=value===''?'':Number(value);
    if(value===''||value===param.default)delete state.overrides[key];else state.overrides[key]=value;
    if(output)output.textContent=value;
  });
  return group;
}
function renderParameters() {
  const parameters=visibleParameters();
  const effect=parameters.filter(p=>p.level==='effect');const expert=parameters.filter(p=>!['effect','basic'].includes(p.level));
  replace($('effect-controls'),...(effect.length?effect.map(parameterControl):[node('p','muted small','这个模型使用默认设置即可。')]));
  replace($('expert-controls'),...expert.map(parameterControl));
  const profile=state.detail?.profile||{};
  if(['tts','music','vc','design'].includes(state.task)&&profile.send_seed!==false)$('expert-controls').append(textInput('seed','随机种子',{type:'number',min:-1,step:1,placeholder:'留空使用默认',help:'用于复现结果；-1 表示随机。'}));
  if(['tts','design'].includes(state.task)&&profile.send_max_tokens!==false)$('expert-controls').append(textInput('max_tokens','生成长度上限（max_tokens）',{type:'number',min:1,step:1,placeholder:'使用模型默认',help:'一般无需修改；过小可能导致生成内容不完整。'}));
  if(state.task==='tts'&&state.detail?.streaming)$('expert-controls').append(checkboxInput('stream','边生成边试听','音频片段生成后自动播放，完成后仍可下载完整音频。'));
}
$('reset-options').addEventListener('click',()=>{state.overrides={};$('options-json').value='';delete formValues().seed;delete formValues().max_tokens;renderInputs();renderParameters();showToast('已恢复当前模型的默认设置');});

function collectInputs() {
  const values=formValues();const inputs={};
  for(const root of [$('task-form'),$('expert-controls')])for(const el of root.querySelectorAll('[data-input-key]')){const key=el.dataset.inputKey;const value=el.type==='file'?values[key]:el.type==='checkbox'?el.checked:el.type==='number'?(el.value===''?'':Number(el.value)):el.value;if(value!==''&&value!=null)inputs[key]=value;}
  const profile=state.detail?.profile||{};
  if(profile.accepts_voice_reference===false&&state.task==='tts'){delete inputs.voice;delete inputs.builtin_voice;delete inputs.reference_text;}
  if(inputs.builtin_voice&&inputs.voice)delete inputs.voice;
  return inputs;
}
function validateInputs(inputs) {
  const profile=state.detail.profile||{};
  if(['asr','vc','separation','analysis'].includes(state.task)&&!inputs.audio)throw new Error('请先上传或录制要处理的音频。');
  if(profile.require_source_audio&&!inputs.audio)throw new Error('这个操作需要源音频，请先添加文件。');
  if(profile.require_voice&&!inputs.voice&&!inputs.builtin_voice)throw new Error('这个模型需要参考声音，请选择已保存的音色或添加参考音频。');
  if((profile.require_reference_text||state.detail.requires_reference_text||(profile.require_reference_text_with_voice&&(inputs.voice||inputs.builtin_voice)))&&!inputs.reference_text&&!inputs.builtin_voice)throw new Error('这个模型需要参考原文，请填写参考音频实际说出的内容。');
  if(state.task==='vc'&&profile.require_vc_target&&!inputs.voice&&!inputs.builtin_voice)throw new Error('请添加目标声音参考。');
  if(inputs.dialogue&&inputs.stream)throw new Error('说话人对话模式与流式处理不能同时开启，请选择一种。');
  if(inputs.detailed&&(inputs.dialogue||inputs.stream))throw new Error('详细结果仅支持普通离线转写，请关闭说话人对话和流式处理。');
}
$('task-form').addEventListener('submit',async event=>{
  event.preventDefault();if(state.job||state.submitting||!state.detail||state.uploading||state.recorders.size)return;
  try{
    const inputs=collectInputs();validateInputs(inputs);let options={...state.overrides};for(const param of visibleParameters()){if(param.json_list&&Object.hasOwn(options,param.name)&&typeof options[param.name]==='string'){try{const parsed=JSON.parse(options[param.name]);if(!Array.isArray(parsed))throw new Error();options[param.name]=parsed;}catch{throw new Error(`${param.label||param.name} 需要填写 JSON 数组，例如 [1, 2]。`);}}}const raw=$('options-json').value.trim();if(raw){let extra;try{extra=JSON.parse(raw);}catch{throw new Error('其他参数的 JSON 格式不正确，请检查引号和逗号。');}if(!extra||Array.isArray(extra)||typeof extra!=='object')throw new Error('其他参数必须是 JSON 对象，例如 {"temperature": 0.9}。');options={...options,...extra};}
    const submittedTask=state.task,submittedModel=state.model,submittedLabel=`${taskInfo().label} · ${state.detail.label||state.model}`;
    state.submitting=true;updateRunButton();
    stopStreamPlayback();if(submittedTask==='tts'&&inputs.stream)beginStreamPlayback();
    const job=await api('/jobs',{method:'POST',body:{task:submittedTask,model:submittedModel,inputs,options}});state.job={id:job.id,stream:submittedTask==='tts'&&!!inputs.stream,lastAudioIndex:-1};
    replace($('result-content'));$('result-subtitle').textContent=submittedLabel;setJobStatus('正在准备任务…','running');$('cancel-job').hidden=false;pollJob();
  }catch(error){stopStreamPlayback();setJobStatus(friendlyError(error),'error');}
  finally{state.submitting=false;updateRunButton();}
});
function setJobStatus(message,status) {const el=$('job-status');el.hidden=false;el.className=`job-status ${status==='error'?'error':['queued','running'].includes(status)?'running':''}`;el.textContent=message;}
function stopStreamPlayback() {
  const playback=state.playback;state.playback=null;$('stop-stream-playback').hidden=true;if(!playback)return;
  for(const source of playback.sources){try{source.stop();}catch{}source.disconnect();}playback.sources.clear();
  if(playback.context.state!=='closed')playback.context.close().catch(()=>{});
}
function beginStreamPlayback() {
  const AudioContextClass=window.AudioContext||window.webkitAudioContext;
  if(!AudioContextClass){showToast('此浏览器不支持流式试听，完成后仍可播放完整音频。');return;}
  try{const context=new AudioContextClass();const playback={context,sources:new Set(),nextTime:0,finished:false};state.playback=playback;$('stop-stream-playback').hidden=false;context.resume().catch(()=>{if(state.playback===playback){stopStreamPlayback();showToast('浏览器未允许自动试听，完成后请播放完整音频。');}});}
  catch{showToast('无法启动流式试听，完成后仍可播放完整音频。');}
}
function finishStreamPlayback() {const playback=state.playback;if(!playback)return;playback.finished=true;if(!playback.sources.size)stopStreamPlayback();}
function playStreamSegments(segments) {
  if(!state.job?.stream)return;
  for(const segment of [...(segments||[])].sort((a,b)=>Number(a.index)-Number(b.index))){
    const index=Number(segment.index);if(!Number.isInteger(index)||index<=state.job.lastAudioIndex)continue;state.job.lastAudioIndex=index;
    const playback=state.playback;if(!playback)continue;
    try{const sampleRate=Number(segment.sample_rate);if(!Number.isFinite(sampleRate)||sampleRate<8000||sampleRate>192000)throw new Error('invalid sample rate');const raw=atob(segment.pcm||'');if(!raw.length||raw.length%2)continue;const bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);const data=new DataView(bytes.buffer);const buffer=playback.context.createBuffer(1,raw.length/2,sampleRate);const samples=buffer.getChannelData(0);for(let i=0;i<samples.length;i++)samples[i]=data.getInt16(i*2,true)/32768;const source=playback.context.createBufferSource();source.buffer=buffer;source.connect(playback.context.destination);const start=Math.max(playback.nextTime,playback.context.currentTime+0.06);playback.nextTime=start+buffer.duration;playback.sources.add(source);source.onended=()=>{source.disconnect();playback.sources.delete(source);if(state.playback===playback&&playback.finished&&!playback.sources.size)stopStreamPlayback();};source.start(start);}
    catch{stopStreamPlayback();showToast('流式试听中断，任务会继续生成完整音频。');}
  }
}
$('stop-stream-playback').addEventListener('click',()=>{stopStreamPlayback();showToast('已停止试听，生成任务会继续。');});
async function pollJob() {
  if(!state.job)return;const id=state.job.id;
  try{
    const query=state.job.stream?`?after=${state.job.lastAudioIndex}`:'';
    const job=await api(`/jobs/${encodeURIComponent(id)}${query}`);if(state.job?.id!==id)return;playStreamSegments(job.audio_segments);
    const labels={queued:'等待执行…',running:'正在处理，请稍候…',done:'处理完成',error:'任务未完成',cancelled:'任务已停止'};
    setJobStatus(job.message||labels[job.status]||'正在处理…',job.status);
    if(job.text||job.artifacts?.length)renderResult(job);
    if(['done','error','cancelled'].includes(job.status)){if(job.status==='done')finishStreamPlayback();else stopStreamPlayback();state.job=null;$('cancel-job').hidden=true;updateRunButton();if(job.status==='done'&&job.elapsed!=null)$('result-subtitle').textContent=`处理完成 · 用时 ${formatDuration(job.elapsed)}`;if(job.status==='done'&&!job.text&&!job.artifacts?.length)replace($('result-content'),node('p','muted small',job.message||'处理完成，服务未返回输出文件。'));pollStatus();return;}
  }catch(error){setJobStatus(`${friendlyError(error)} 正在尝试重新连接任务…`,'running');}
  state.jobTimer=setTimeout(pollJob,1100);
}
function renderResult(job) {
  const children=[];if(job.text)children.push(node('div','result-text',typeof job.text==='string'?job.text:JSON.stringify(job.text,null,2)));
  for(const artifact of job.artifacts||[]){const url=safeArtifactUrl(artifact.url);if(!url)continue;const item=node('div','artifact');const heading=node('div','artifact-heading');const link=node('a','','下载文件');link.href=url;link.download=artifact.name||'';heading.append(node('span','artifact-name',artifact.name||'输出文件'),link);item.append(heading);
    if(artifact.kind==='audio'||/\.(wav|mp3|flac|ogg|m4a|webm)$/i.test(artifact.name||'')){const audio=node('audio');audio.controls=true;audio.preload='metadata';audio.src=url;audio.addEventListener('play',stopStreamPlayback);item.append(audio);}children.push(item);
  }
  replace($('result-content'),...children);
}
$('cancel-job').addEventListener('click',event=>runAction(event.currentTarget,async()=>{if(!state.job)return;stopStreamPlayback();await api(`/jobs/${encodeURIComponent(state.job.id)}/cancel`,{method:'POST',body:{}});setJobStatus('已请求停止，正在等待当前操作结束…','running');}));

function renderLibrary() {
  const query=$('model-search').value.trim().toLowerCase(),task=$('model-task-filter').value,filter=$('model-state-filter').value;
  const models=(state.catalog?.models||[]).filter(m=>(!query||[m.label,m.id,m.family,m.description,TASK_NAMES[modelTask(m)]].join(' ').toLowerCase().includes(query))&&(!task||fitsTask(m,task))&&(!filter||(filter==='installed'?m.installed:filter==='manual'?!m.installable&&!m.installed:m.installable&&!m.installed)));
  $('model-count').textContent=`${models.length} 个模型 · ${(state.catalog?.models||[]).filter(m=>m.installed).length} 个已安装`;
  const children=models.map(model=>{const row=button('','model-row',()=>selectLibraryModel(model.id));row.classList.toggle('selected',state.libraryModel===model.id);row.dataset.model=model.id;const top=node('div','model-row-top');top.append(node('span','model-row-title',model.label||model.id),badge(model.installed?'已安装':model.installable?'可下载':'手动导入',model.installed?'success':''));const meta=node('div','model-row-meta');meta.append(node('span','',TASK_NAMES[modelTask(model)]||modelTask(model)),node('span','',model.family||''));if(model.size_bytes)meta.append(node('span','',formatBytes(model.size_bytes)));if(model.min_vram_gb)meta.append(node('span','',`参考显存 ${model.min_vram_gb} GB`));row.append(top,meta);return row;});
  replace($('model-list'),...(children.length?children:[node('div','empty-state','没有找到符合条件的模型，试试其他关键词或筛选条件。')]));
}
async function selectLibraryModel(id) {
  state.libraryModel=id;const seq=++state.librarySeq;renderLibrary();replace($('model-detail'),node('p','loading-inline','正在读取模型信息…'));
  try{const detail=await api(`/models/${encodeURIComponent(id)}`);if(seq!==state.librarySeq)return;renderModelDetail(detail);}catch(error){if(seq===state.librarySeq)replace($('model-detail'),node('p','muted small',friendlyError(error)));}
}
function renderModelDetail(model) {
  const panel=$('model-detail');const children=[node('div','eyebrow',model.family||'MODEL'),node('h2','',model.label||model.id)];
  const badges=node('div','badge-row');badges.append(badge(TASK_NAMES[modelTask(model)]||modelTask(model)),badge(model.installed?'已安装':model.installable?'可下载':'需手动导入',model.installed?'success':''));if(model.streaming)badges.append(badge('支持流式'));children.push(badges);
  children.push(node('p','description',model.description||model.input_hint||'选择这个模型进行音频处理。'));
  const data=node('dl','detail-data');const entries=[['下载大小',formatBytes(model.size_bytes)],['参考显存',model.min_vram_gb?`${model.min_vram_gb} GB（估算）`:'未提供估算'],['运行设备',backendLabel(model.backend||state.catalog?.hardware?.backend)]];
  for(const [label,value] of entries){const row=node('div');row.append(node('dt','',label),node('dd','',value));data.append(row);}children.push(data);
  const availableVram=Number(state.catalog?.hardware?.vram_gb);if(model.min_vram_gb&&availableVram&&model.min_vram_gb>availableVram)children.push(node('div','notice warning',`参考需求高于本机 ${availableVram.toFixed(1)} GB 显存，可能无法完整加载。显存需求为估算值。`));
  if(model.requirements){const text=typeof model.requirements==='string'?model.requirements:JSON.stringify(model.requirements,null,2);if(text)children.push(node('p','field-help',text));}
  if(model.missing?.length)children.push(node('p','field-help',`缺失 ${model.missing.length} 个文件，可重新下载修复。`));
  if(model.install_path){const path=node('div','install-path');path.append(node('span','field-label',model.manual_install?'手动准备权重的位置':'本地模型位置'),node('code','',model.install_path));if(model.manual_install)path.append(node('p','field-help','将模型需要的文件放到此位置，然后点击“刷新模型”。模型文件清单可在下方展开查看。'));children.push(path);}
  const actions=node('div','detail-actions');
  if(model.installed){actions.append(button('在工作台使用 →','button primary full',async()=>{const task=TASKS.find(t=>t.types.includes(modelTask(model))||t.id===modelTask(model));if(task){await selectTask(task.id,model.id);navigate('workspace');}}));actions.append(button('加载模型','button secondary full',event=>runAction(event.currentTarget,async()=>{showToast('正在加载模型，首次加载可能需要一些时间。');await api(`/models/${encodeURIComponent(model.id)}/load`,{method:'POST',body:{options:{}}});showToast('模型已加载');pollStatus();})));}
  else if(model.installable)actions.append(button('下载模型','button primary full',event=>runAction(event.currentTarget,()=>startDownload(model.id))));
  else{actions.append(button('需要手动准备权重','button secondary full',()=>{}));actions.lastChild.disabled=true;if(model.install_path)actions.append(button('复制模型位置','button secondary full',async()=>{try{await navigator.clipboard.writeText(model.install_path);showToast('模型位置已复制');}catch{showToast('请选中上方模型位置手动复制。');}}));}
  children.push(actions);
  const url=sourceLink(model.source);if(url){const a=node('a','detail-source','查看模型来源 ↗');a.href=url;a.target='_blank';a.rel='noopener noreferrer';children.push(a);}else if(model.source)children.push(node('p','field-help',`模型来源：${shortText(model.source)}`));
  if(model.files?.length){const details=node('details','details-files');details.append(node('summary','',`模型文件（${model.files.length}）`));const list=node('ul');for(const f of model.files)list.append(node('li','',typeof f==='string'?f:f.name||f.path||shortText(f)));details.append(list);children.push(details);}
  replace(panel,...children);
}
async function startDownload(id) { const token=$('hf-token').value.trim();await api(`/downloads/${encodeURIComponent(id)}`,{method:'POST',body:{token}});$('hf-token').value='';showToast('正在准备下载，自动选择线路。');await pollDownloads();$('download-list').scrollIntoView({behavior:'smooth',block:'nearest'}); }
const DOWNLOAD_NAMES={queued:'等待下载',pending:'等待下载',starting:'准备中',preparing:'准备中',probing:'检测线路',running:'下载中',downloading:'下载中',paused:'已暂停',pausing:'正在暂停',completed:'已完成',complete:'已完成',done:'已完成',error:'下载失败',failed:'下载失败',cancelled:'已取消',canceled:'已取消',installing:'正在安装',verifying:'正在校验'};
function activeDownload(d){return ['queued','pending','starting','preparing','probing','running','downloading','installing','verifying','pausing'].includes(d.status);}
function downloadRouteLabel(route){const value=shortText(route);const known={'HF official direct':'HF 官方直连','HF official via detected proxy':'HF 官方 · 自动检测代理','HF mirror direct':'HF 镜像直连','HF mirror via detected proxy':'HF 镜像 · 自动检测代理',official:'HF 官方直连',mirror:'HF 镜像直连',proxy:'自动检测代理',auto:'自动选择',probing:'正在检测线路'};return known[value]||value.replace(/HF official/g,'HF 官方').replace(/HF mirror/g,'HF 镜像').replace(/via detected proxy/g,'· 自动检测代理').replace(/\bdirect\b/g,'直连');}
let downloadPolling=false;
async function pollDownloads() {
  if(downloadPolling)return;downloadPolling=true;
  try{const data=await api('/downloads');const previous=state.downloads;state.downloads=data.downloads||[];renderDownloads();if(state.downloads.some(d=>['done','complete','completed'].includes(d.status)&&!previous.some(p=>p.id===d.id&&p.status===d.status))){await loadCatalog();if(state.libraryModel)selectLibraryModel(state.libraryModel);}}
  catch(error){if(state.page==='models'&&!state.downloads.length)replace($('download-list'),node('p','muted small',friendlyError(error)));}
  finally{downloadPolling=false;}
}
function renderDownloads() {
  const active=state.downloads.filter(activeDownload).length;$('download-badge').textContent=active;$('download-badge').hidden=!active;$('downloads-count').textContent=state.downloads.length?`(${state.downloads.length})`:'';
  const children=state.downloads.map(d=>{const item=node('div','download-item');const top=node('div','download-top');const info=node('div');info.append(node('div','download-name',d.label||d.model||d.id),node('div','download-message',`${DOWNLOAD_NAMES[d.status]||d.status}${d.message?' · '+downloadRouteLabel(d.message):''}`));const actions=node('div','download-actions');
    const act=(action,label)=>button(label,'button secondary small-button',event=>runAction(event.currentTarget,async()=>{await api(`/downloads/${encodeURIComponent(d.model||d.id)}/${action}`,{method:'POST',body:{}});await pollDownloads();}));
    if(['queued','pending','starting','preparing','probing','running','downloading'].includes(d.status))actions.append(act('pause','暂停'));
    if(['paused','failed','error','cancelled','canceled'].includes(d.status))actions.append(act('resume',d.status==='paused'?'继续':'重试'));
    if(activeDownload(d)||d.status==='paused')actions.append(act('cancel','取消'));
    top.append(info,actions);item.append(top);
    const total=Number(d.total_bytes),done=Number(d.bytes)||0;const progress=node('div','download-progress');const fill=node('span');fill.style.width=`${total>0?Math.min(100,done/total*100):['done','complete','completed'].includes(d.status)?100:0}%`;progress.append(fill);item.append(progress);
    const meta=node('div','download-meta');meta.append(node('span','',`${done?formatBytes(done):'0 B'} / ${formatBytes(total)}`));if(d.speed)meta.append(node('span','',typeof d.speed==='number'?`${formatBytes(d.speed)}/s`:d.speed));if(d.eta)meta.append(node('span','',`剩余 ${typeof d.eta==='number'?formatDuration(d.eta):d.eta}`));if(d.route)meta.append(node('span','',`线路：${downloadRouteLabel(d.route)}`));item.append(meta);return item;});
  replace($('download-list'),...(children.length?children:[node('p','muted small','暂无下载任务。从模型列表选择一个模型，即可开始下载。')]));
}

let apiSequence=0;
async function loadApiDocs() {
  const seq=++apiSequence;
  try{const docs=await api('/api-docs');if(seq!==apiSequence)return;$('api-base').textContent=docs.base_url||'服务尚未启动';$('api-model').textContent=docs.model||'尚未加载模型';
    const children=(docs.endpoints||[]).map(endpoint=>{const card=node('section','card');const heading=node('div','card-heading');const title=node('div','endpoint-title');title.append(node('span','http-method',endpoint.method||'POST'),node('h2','',endpoint.title||endpoint.path));heading.append(title);card.append(heading);card.append(node('p','muted small',endpoint.description||''));card.append(node('p','small',endpoint.path));
      const tabs=node('div','code-tabs'),code=node('pre','code-block');let language='python';const options={python:endpoint.example_python||'# 暂无 Python 示例',curl:endpoint.example_curl||'# 暂无 cURL 示例'};
      for(const lang of ['python','curl']){const b=button(lang==='python'?'Python':'cURL',lang===language?'active':'',()=>{language=lang;for(const other of tabs.querySelectorAll('[data-code-lang]'))other.classList.toggle('active',other.dataset.codeLang===lang);code.textContent=options[lang];});b.dataset.codeLang=lang;tabs.append(b);}
      tabs.append(button('复制代码','copy-button',async()=>{try{await navigator.clipboard.writeText(options[language]);showToast('代码已复制');}catch{showToast('浏览器未允许复制，请选中代码手动复制。');}}));code.textContent=options[language];card.append(tabs,code);return card;});replace($('api-endpoints'),...(children.length?children:[node('div','card','服务尚未提供调用示例。请先加载一个模型。')]));
  }catch(error){if(seq===apiSequence)replace($('api-endpoints'),node('div','card',friendlyError(error)));}
}
function updateStatus(data) {
  const server=data.server||{},hardware=data.hardware||{},runtime=data.runtime||{};
  const model=server.model||data.model;const text=model?(server.text||data.text||'模型已加载'):'服务就绪 · 开始任务时自动加载模型';
  const busy=runtime.busy||data.busy,live=runtime.realtime_active||data.realtime_active;
  $('runtime-status').textContent=live?'实时通话中':busy?'模型处理中':model?`已加载 · ${typeof model==='object'?model.label||model.id:model}`:'模型待加载';
  $('runtime-status').dataset.state=busy||live?'busy':model?'ready':'idle';
  $('runtime-status').title=text;$('sidebar-status').textContent='本地服务在线';$('server-dot').classList.add('online');$('connection-status').dataset.state='online';
  $('realtime-frame').contentWindow?.postMessage({type:'audiocpp:connection',online:true},location.origin);
  const vram=hardware.vram_gb?` · ${Number(hardware.vram_gb).toFixed(1)} GB 显存`:'';$('hardware-label').textContent=`${backendLabel(hardware.backend||state.catalog?.hardware?.backend)}${vram}`;
  $('settings-runtime').textContent=text;$('unload-model').disabled=!!(runtime.busy||data.busy||runtime.realtime_active||data.realtime_active);
}
async function pollStatus() {try{updateStatus(await api('/status'));}catch{$('sidebar-status').textContent='本地服务断开';$('server-dot').classList.remove('online');$('connection-status').dataset.state='offline';$('runtime-status').textContent='模型状态未知';$('runtime-status').dataset.state='idle';$('realtime-frame').contentWindow?.postMessage({type:'audiocpp:connection',online:false},location.origin);}}
$('unload-model').addEventListener('click',event=>runAction(event.currentTarget,async()=>{await api('/unload',{method:'POST',body:{}});showToast('已卸载模型，文件仍保留在本地');await pollStatus();}));
window.addEventListener('beforeunload',event=>{if(state.recorders.size||state.job){event.preventDefault();event.returnValue='';}});

async function initialize() {
  navigate(location.hash.slice(1)||'workspace',false);selectTask('tts');
  try{const voices=await api('/voices');state.voices=voices.voices||[];}catch{}
  try{await loadCatalog();}catch(error){$('connection-error').textContent=friendlyError(error)+' 可使用右侧刷新按钮或刷新页面重新连接。';$('connection-error').hidden=false;$('workspace-model-description').textContent='无法读取模型列表。';}
  await pollDownloads();
  setInterval(()=>{if(!document.hidden||state.downloads.some(activeDownload))pollDownloads();},2500);
  setInterval(()=>{if(!document.hidden)pollStatus();},7000);
  setInterval(updateRecordingBanner,1000);
}
initialize();
