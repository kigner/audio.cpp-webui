import {t, uiText, uiAttr, rawText, sourceText, html, textHTML, applyLanguage, getLanguage, setLanguage} from './i18n.js';
import {createScenarioStudio} from './scenarios.js?v=scenario-editors-24';
import {createSpeakType} from './speaktype.js?v=2';
const speakType=createSpeakType({root:document.getElementById('page-speaktype'),api,showToast});
const scenarioStudio=createScenarioStudio({root:document.getElementById('page-scenario-studio'),api,showToast,navigate,plainMessage});
const API = '/api/workbench';
const $ = (id) => document.getElementById(id);
const TASKS = [
  {id:'tts',label:'语音合成',action:'生成语音',types:['tts','clon']},
  {id:'asr',label:'语音识别',action:'开始识别',types:['asr']},
  {id:'music',label:'音乐与音效',action:'生成音乐',types:['gen']},
  {id:'vc',label:'声音转换',action:'开始转换',types:['vc','svc']},
  {id:'processing',label:'音频处理',action:'开始处理',types:['s2s']},
  {id:'separation',label:'音源分离',action:'开始分离',types:['sep']},
  {id:'analysis',label:'检测与分析',action:'开始分析',types:['vad','diar','align','midi','turn']},
  {id:'design',label:'声音设计',action:'生成声音',types:['vdes']},
];
const PRIMARY_TASKS = ['tts','asr','music','vc','design'];
const SCENARIOS = [
  {id:'realtime-chat',label:'实时语音聊天',description:'通过语音或文字与对话模型交流，使用选定声音回复。',icon:'chat',available:true},
  {id:'subtitles',label:'自动字幕与校对',description:'导入单人口播音频或视频，识别语音、校对字幕并导出 SRT / VTT。',icon:'text',available:true},
  {id:'video-dubbing',label:'视频翻译配音',description:'识别原文、翻译、逐句配音与时长检查，保留背景音乐并混音导出视频。',icon:'play',available:true},
  {id:'speaktype',label:'全局快捷键听写',description:'启动 SpeakType，用全局快捷键录音，将识别文字输入其他应用。',icon:'text',available:true},
];
const TOOLS = [
  {id:'processing',task:'processing',label:'音频处理',description:'降噪、增强、超分辨率与语音到语音处理',icon:'wave'},
  {id:'separation',task:'separation',label:'音源分离',description:'提取人声、伴奏或指定声音',icon:'sliders'},
  {id:'vad',task:'analysis',type:'vad',label:'语音片段检测',action:'开始检测',result:'检测结果',description:'检测音频中的语音区间',icon:'sliders'},
  {id:'diar',task:'analysis',type:'diar',label:'说话人区分',action:'区分说话人',result:'区分结果',description:'按说话人区分音频片段',icon:'chat'},
  {id:'turn',task:'analysis',type:'turn',label:'说完检测',action:'开始检测',result:'检测结果',description:'判断一段语音是否已经说完',icon:'chat'},
  {id:'align',task:'analysis',type:'align',label:'字幕对齐',action:'开始对齐',result:'对齐结果',description:'为原文匹配音频时间戳',icon:'text'},
  {id:'midi',task:'analysis',type:'midi',label:'乐谱提取',action:'提取乐谱',result:'提取结果',description:'从音频提取 MIDI 或乐谱',icon:'music'},
];
const TASK_NAMES = {tts:'语音合成',clon:'声音克隆',asr:'语音识别',gen:'音乐与音效',vc:'声音转换',svc:'歌声转换',s2s:'音频处理',sep:'音源分离',vad:'语音片段检测',diar:'说话人区分',align:'字幕对齐',midi:'乐谱提取',turn:'说完检测',spk:'说话人识别',vdes:'声音设计'};
const LANGUAGE_NAMES={english:'英语',chinese:'中文',japanese:'日语',french:'法语',german:'德语',italian:'意大利语',portuguese:'葡萄牙语',spanish:'西班牙语',korean:'韩语',russian:'俄语',arabic:'阿拉伯语',hindi:'印地语',vietnamese:'越南语',cantonese:'粤语',thai:'泰语',indonesian:'印尼语',turkish:'土耳其语',dutch:'荷兰语',ukrainian:'乌克兰语',polish:'波兰语',romanian:'罗马尼亚语',greek:'希腊语',czech:'捷克语',finnish:'芬兰语',zh_anhui:'安徽方言',zh_fujian:'福建方言',zh_gansu:'甘肃方言',zh_guizhou:'贵州方言',zh_hebei:'河北方言',zh_henan:'河南方言',zh_hubei:'湖北方言',zh_hunan:'湖南方言',zh_jiangxi:'江西方言',zh_liaoning:'辽宁方言',zh_minnan:'闽南语',zh_ningxia:'宁夏方言',zh_shaanxi:'陕西方言',zh_shandong:'山东方言',zh_shanghai:'上海话',zh_shanxi:'山西方言',zh_sichuan:'四川话',zh_tianjin:'天津话',zh_wenzhou:'温州话',zh_wu:'吴语',zh_yunnan:'云南方言',auto:'自动'};
const state = {catalog:null,task:'tts',tool:null,key:'tts',route:'tts',analysisType:'',page:'workspace',model:null,detail:null,detailSeq:0,librarySeq:0,libraryModel:null,workspaces:{},overrides:{},downloads:[],job:null,playback:null,submitting:false,jobTimer:null,voices:[],recorders:new Set(),uploading:0,runtime:null,loading:null,realtime:null};
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
let toastTimer,initializing=true,statusPoll=null,runtimeRevision=0;

function node(tag, className='', text) { const n=document.createElement(tag);if(className)n.className=className;if(text!==undefined&&text!=='')uiText(n,text);return n; }
function rawNode(tag, className='', text) {const n=node(tag,className);if(text!==undefined)rawText(n,text);return n;}
function button(text, className, fn) { const n=node('button',className,text);n.type='button';n.addEventListener('click',fn);return n; }
function replace(el, ...children) { el.replaceChildren(...children.filter(Boolean)); }
function taskInfo() { const task=TASKS.find(t=>t.id===state.task);return state.tool?{...task,...state.tool}:task; }
function workspace(key=state.key) { return state.workspaces[key] ||= {forms:{},options:{},model:null,result:null}; }
function clearWorkspaceResult(key=state.key) {const current=workspace(key);if(current.result?.sourceUrl){URL.revokeObjectURL(current.result.sourceUrl);delete current.result.sourceUrl;}current.result=null;current.message='';current.resultEpoch=(current.resultEpoch||0)+1;if(key===state.key)stopStreamPlayback();}
function formValues() { return workspace().forms; }
function modelOptions(key=state.key,model=state.model) { return workspace(key).options[model||''] ||= {values:{},inputs:{},json:''}; }
function fieldValues(key) {return ['language','context','detailed','dialogue','stream','duration','seed','max_tokens','builtin_voice'].includes(key)?modelOptions().inputs:formValues();}
function preference(name,fallback) { try{return JSON.parse(localStorage.getItem(`audiocpp-${name}`))??fallback;}catch{return fallback;} }
function savePreference(name,value) { try{localStorage.setItem(`audiocpp-${name}`,JSON.stringify(value));}catch{} }
function icon(name) { const el=document.createElementNS('http://www.w3.org/2000/svg','svg');el.setAttribute('class','icon');el.setAttribute('aria-hidden','true');const use=document.createElementNS(el.namespaceURI,'use');use.setAttribute('href',`#icon-${name}`);el.append(use);return el; }
function plainMessage(value) { return String(value??'').replace(/^([ \t]*)(?:[✅❌⏳⚠ℹ🚨💡📝⚪🔄✔✖❗🧠🎵🌐⏱📏🔀🎤🗒🧹📦🎛🧊][\uFE0E\uFE0F]?[ \t]*)+/gmu,'$1').replace(/📥 (加载模型|Load)|⬇[\uFE0E\uFE0F]? (下载模型|Download Model)/g,(_,load,download)=>load||download).trim(); }
function friendlyError(error) { return plainMessage(error instanceof Error ? error.message : error || '操作未完成，请稍后重试。'); }
function showToast(message) { uiText($('toast'), plainMessage(message));$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5000); }
async function api(path, options={}) {
  const headers = new Headers(options.headers || {});
  let body=options.body;
  if(body!==undefined && !(body instanceof FormData)){headers.set('Content-Type','application/json');body=JSON.stringify(body);}
  let response;
  const {onUploadProgress,onUploadComplete,...requestOptions}=options;
  try { response=await (onUploadProgress?uploadResponse(API+path,{...requestOptions,headers,body},onUploadProgress,onUploadComplete):fetch(API+path,{...requestOptions,headers,body})); }
  catch { throw new Error('暂时无法连接本地服务，请确认 WebUI 仍在运行，然后重试。'); }
  const raw=await response.text();let data;
  try { data=raw?JSON.parse(raw):{}; } catch { throw new Error(response.ok?'服务返回了无法读取的内容，请刷新页面重试。':`服务暂时无法处理请求（${response.status}），请稍后重试。`); }
  if(!response.ok){const detail=data.detail??data.error??data.message;const error=new Error(typeof detail==='string'?detail:detail?JSON.stringify(detail):`请求未完成（${response.status}）。`);error.status=response.status;throw error;}
  return data;
}
function uploadResponse(url,options,onProgress,onComplete) {
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();xhr.open(options.method||'POST',url);
    options.headers.forEach((value,key)=>xhr.setRequestHeader(key,value));
    xhr.upload.onprogress=onProgress;xhr.upload.onload=()=>onComplete?.();
    xhr.onload=()=>{if(xhr.status)resolve(new Response(xhr.responseText,{status:xhr.status,statusText:xhr.statusText}));else reject(new Error('Upload disconnected'));};
    xhr.onerror=xhr.onabort=xhr.ontimeout=()=>reject(new Error('Upload disconnected'));
    xhr.send(options.body);
  });
}
async function runAction(control, fn) { control.disabled=true;try{await fn();}catch(error){showToast(friendlyError(error));}finally{control.disabled=false;} }
function formatBytes(value) { if(!Number.isFinite(Number(value)) || Number(value)<=0)return '待确认';let n=Number(value),i=0;const units=['B','KB','MB','GB','TB'];while(n>=1024&&i<units.length-1){n/=1024;i++;}return `${n.toFixed(i>1?1:0)} ${units[i]}`; }
function formatDuration(value) { const n=Number(value);if(!Number.isFinite(n)||n<0)return '';return n<60?`${Math.ceil(n)} 秒`:`${Math.floor(n/60)} 分 ${Math.round(n%60)} 秒`; }
function shortText(value) { if(typeof value==='string')return value;if(value==null)return '';return JSON.stringify(value); }
function sourceLink(source) { const raw=typeof source==='string'?source:source?.url||source?.repo||'';if(!raw)return null;let url=raw;if(/^[\w.-]+\/[\w.-]+$/.test(url))url='https://huggingface.co/'+url;try{const u=new URL(url);if(!['https:','http:'].includes(u.protocol))return null;return u.href;}catch{return null;} }
function safeArtifactUrl(raw) { try{const url=new URL(raw,location.href);return url.origin===location.origin&&['http:','https:'].includes(url.protocol)?url.href:null;}catch{return null;} }
function choicesOf(values) { return (values||[]).map(v=>Array.isArray(v)?{label:String(v[0]),value:v[1]}:v&&typeof v==='object'?{label:String(v.label??v.name??v.value),value:v.value??v.id??v.name,raw:v.raw}:{label:String(v),value:v}); }
function fillSelect(select, choices, value) { select.replaceChildren();for(const c of choicesOf(choices)){const opt=rawNode('option','',c.label);if(!c.raw)uiText(opt,c.label);opt.value=c.value==null?'':String(c.value);select.append(opt);}if(value!=null)select.value=String(value); }
function badge(text, type='') { return node('span',`badge ${type}`,text); }
function backendLabel(value) { return value==='cuda'?'NVIDIA GPU':value==='cpu'?'CPU':String(value||'自动'); }

function readTheme() { try{return localStorage.getItem('audiocpp-workbench-theme')||'light';}catch{return 'light';} }
function readPalette() {try{return localStorage.getItem('audiocpp-workbench-palette')==='studio'?'studio':'classic';}catch{return 'classic';}}
function syncRealtimeTheme() {const frame=$('realtime-frame');if(frame.hasAttribute('src')&&frame.contentWindow)frame.contentWindow.postMessage({type:'audiocpp:theme',theme:document.documentElement.dataset.theme,palette:document.documentElement.dataset.palette},location.origin);}
function applyPalette(value=readPalette()) {const palette=value==='studio'?'studio':'classic';document.documentElement.dataset.palette=palette;document.querySelectorAll('[data-palette-choice]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.paletteChoice===palette)));syncRealtimeTheme();}
function setPalette(value) {try{localStorage.setItem('audiocpp-workbench-palette',value);}catch{}applyPalette(value);}
document.querySelectorAll('[data-palette-choice]').forEach(b=>b.addEventListener('click',()=>setPalette(b.dataset.paletteChoice)));
function applyTheme(value=readTheme()) { if(!['light','dark','system'].includes(value))value='system';document.documentElement.dataset.theme=value==='system'?(systemTheme.matches?'dark':'light'):value;$('theme-select').value=value;syncRealtimeTheme(); }
function setTheme(value) { try{localStorage.setItem('audiocpp-workbench-theme',value);}catch{}applyTheme(value); }
$('theme-select').addEventListener('change',event=>setTheme(event.target.value));
systemTheme.addEventListener('change',()=>{if(readTheme()==='system')applyTheme();});
$('realtime-frame').addEventListener('load',syncRealtimeTheme);
applyPalette();applyTheme();

async function navigate(route, updateHash=true, modelId) {
  if(route==='workspace'||!route)route=preference('last-task','tts');
  if(route==='api')route='settings/api';
  if(route==='tools/conversion')route='vc';
  if(route==='tools/design')route='design';
  if(route==='realtime')route='scenarios/realtime-chat';
  const tool=TOOLS.find(t=>route===`tools/${t.id}`);
  const task=TASKS.find(t=>PRIMARY_TASKS.includes(t.id)&&t.id===route);
  const settings=route==='settings'||route.startsWith('settings/');
  const scenario=route==='scenarios/subtitles'?'subtitles':route==='scenarios/video-dubbing'?'dubbing':null;
  const page=task||tool?'workspace':settings?'settings':route==='scenarios/speaktype'?'speaktype':route==='scenarios/realtime-chat'?'realtime':scenario?'scenario-studio':route;
  if(!['home','workspace','tools','scenarios','scenario-studio','speaktype','realtime','models','settings','references'].includes(page))return navigate('home',updateHash);
  if(page!=='speaktype')speakType.hide();
  if(state.route!==route){stopRecordings();window.scrollTo(0,0);}closeModelPicker(false);setParameters(false,false);
  state.route=route;state.page=page;
  document.querySelector('.main-content').prepend($('global-model-status'));
  updateHomeStatus();
  document.body.classList.toggle('scene-mode',page==='realtime');
  $('workspace-heading-row').hidden=page!=='workspace';
  $('parameter-toggle').hidden=page!=='workspace';
  document.body.classList.remove('sidebar-open','parameters-open');
  syncDrawers();
  $('sidebar-toggle').setAttribute('aria-expanded',String(!document.body.classList.contains('sidebar-collapsed')&&!matchMedia('(max-width:760px)').matches));
  document.querySelectorAll('.page').forEach(p=>{p.hidden=p.id!==`page-${page}`;p.classList.toggle('active',!p.hidden);});
  const nav=tool?'tools':settings?'settings':page==='realtime'||page==='speaktype'||scenario?'scenarios':route;
  document.querySelectorAll('[data-route]').forEach(b=>{const active=b.dataset.route===nav;b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  if(updateHash&&location.hash!==`#${route}`)history.pushState(null,'',`#${route}`);
  else if(location.hash!==`#${route}`)history.replaceState(null,'',`#${route}`);
  const pageHeader=$(`page-${page}`).querySelector('.page-topbar');
  if(pageHeader)pageHeader.append($('global-model-status'));
  if(page==='workspace'){
    state.task=task?.id||tool.task;state.tool=tool||null;state.key=route;state.analysisType=tool?.type||'';
    state.detailSeq++;state.detail=null;state.model=workspace().model;
    if(modelId){if(modelId!==state.model)clearWorkspaceResult();workspace().model=state.model=modelId;}
    $('page-workspace').dataset.task=state.task;$('page-workspace').dataset.tool=tool?.id||'';
    document.body.classList.add('workspace-mode');
    uiText($('task-title'), taskInfo().label);
    $('workspace-navigation').hidden=!tool;
    updateLoadStatus();
    uiText($('input-heading'), state.task==='asr'?'音频素材':state.task==='music'?'创作输入':state.task==='tts'?'文本与声音':state.task==='design'?'声音描述与试听文本':state.task==='vc'?'源音频与目标声音':'处理素材');
    uiText($('result-heading'), tool?.result||({asr:'识别结果',vc:'转换结果',processing:'处理结果',separation:'分离结果',analysis:'分析结果'})[state.task]||'生成结果');
    uiText($('parameter-title'), '模型设置');
    renderInputs();renderParameters();savePreference('last-task',route);applyParameterState();renderWorkspaceResults();
    await refreshWorkspaceModels();
  }else if(page==='tools')renderTools();
  else if(page==='scenarios')renderScenarios();
  else if(page==='speaktype')await speakType.open();
  else if(scenario)await scenarioStudio.open(scenario);
  else if(page==='references'){renderReferenceEditor();if(!initializing)await refreshReferences();}
  else if(page==='realtime'){const frame=$('realtime-frame');if(!frame.hasAttribute('src'))frame.src=frame.dataset.src;}
  else if(page==='models')pollDownloads();
  else if(page==='settings')selectSettingsTab(route.split('/')[1]||'appearance');
  if(page!=='workspace')document.body.classList.remove('workspace-mode');
  updateActiveJobBanner();
}
function routeForModel(model) {const actual=modelTask(model);const task=TASKS.find(t=>t.id===model.task)||TASKS.find(t=>t.types.includes(actual));if(!task)return 'tools';if(PRIMARY_TASKS.includes(task.id))return task.id;const tool=TOOLS.find(t=>t.task===task.id&&(!t.type||t.type===actual));return tool?`tools/${tool.id}`:'tools';}
function selectTask(id,modelId) {const model=(state.catalog?.models||[]).find(m=>m.id===modelId);return navigate(model?routeForModel(model):PRIMARY_TASKS.includes(id)?id:`tools/${TOOLS.find(t=>t.task===id)?.id||''}`,true,modelId);}
function renderTools() {
  replace($('tool-list'),...TOOLS.map(tool=>{
    const card=button('','tool-card',()=>navigate(`tools/${tool.id}`));const mark=node('span','tool-card-icon');mark.append(icon(tool.icon));
    card.append(mark,node('span','tool-card-title',tool.label),node('span','tool-card-description',tool.description));return card;
  }));
}
function renderScenarios() {
  replace($('scenario-list'),...SCENARIOS.map(scene=>{
    const card=scene.available?button('','tool-card scenario-card',()=>navigate(`scenarios/${scene.id}`)):node('article','tool-card scenario-card planned');
    card.dataset.scenario=scene.id;
    const top=node('span','scenario-card-top'),mark=node('span','tool-card-icon');mark.append(icon(scene.icon));
    top.append(mark,node('span',`badge ${scene.available?'success':'planned-badge'}`,scene.available?'已接入':'规划中'));
    card.append(top,node('span','tool-card-title',scene.label),node('span','tool-card-description',scene.description));
    return card;
  }));
}
function applyParameterState() {
  document.body.classList.remove('parameters-collapsed','parameters-open');
  positionModelSettings();
  syncDrawers();
}
function syncDrawers() {
  const sidebar=matchMedia('(max-width:760px)').matches&&document.body.classList.contains('sidebar-open');
  $('sidebar-backdrop').hidden=!sidebar;
  $('parameter-toggle').setAttribute('aria-expanded',String($('workspace-settings').matches(':popover-open')));
  $('sidebar-toggle').setAttribute('aria-expanded',String(sidebar||!matchMedia('(max-width:760px)').matches&&!document.body.classList.contains('sidebar-collapsed')));
  const control=$('sidebar-toggle'),text=`${control.getAttribute('aria-expanded')==='true'?'收起':'展开'}导航`;uiAttr(control, 'title', text);uiAttr(control, 'aria-label', text);
}
function positionModelSettings() {
  const panel=$('workspace-settings');if(!panel.matches(':popover-open'))return;
  const anchor=$('parameter-toggle').getBoundingClientRect(),top=anchor.bottom+8;
  const leftEdge=Math.max(0,document.querySelector('.main-content').getBoundingClientRect().left);
  panel.style.width=`${Math.min(720,innerWidth-leftEdge-12)}px`;panel.style.top=`${top}px`;panel.style.setProperty('--settings-top',`${top}px`);
  panel.style.left=`${leftEdge}px`;
}
function setParameters(open,focus=true) {
  const panel=$('workspace-settings');
  if(open&&state.detail){closeModelPicker(false);document.body.classList.remove('sidebar-open');panel.showPopover();positionModelSettings();}
  else if(panel.matches(':popover-open'))panel.hidePopover();
  syncDrawers();if(focus&&!$('parameter-toggle').hidden)$('parameter-toggle').focus();
}
function selectSettingsTab(tab) {
  if(!['appearance','runtime','api'].includes(tab))tab='appearance';
  document.querySelectorAll('[data-settings-tab]').forEach(b=>{const active=b.dataset.settingsTab===tab;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active));});
  for(const [key,id] of Object.entries({appearance:'settings-appearance',runtime:'settings-runtime-section',api:'page-api'}))$(id).hidden=key!==tab;
  if(tab==='api')loadApiDocs();if(tab==='runtime')loadRuntimeInfo();
}
window.addEventListener('message',event=>{
  if(event.origin!==location.origin||event.source!==$('realtime-frame').contentWindow)return;
  if(event.data?.type==='audiocpp:back'){navigate('scenarios');if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});}
  if(event.data?.type==='audiocpp:realtime-state'){state.realtime=event.data;updateRealtimeBadge();updateRunButton();}
});
document.querySelectorAll('[data-route]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.route)));
document.querySelectorAll('[data-settings-tab]').forEach(b=>b.addEventListener('click',()=>navigate(`settings/${b.dataset.settingsTab}`)));
window.addEventListener('hashchange',()=>navigate(location.hash.slice(1),false));
document.body.classList.toggle('sidebar-collapsed',preference('sidebar-collapsed',false));
$('sidebar-toggle').addEventListener('click',()=>{const mobile=matchMedia('(max-width:760px)').matches;const name=mobile?'sidebar-open':'sidebar-collapsed';document.body.classList.toggle(name);if(mobile)document.body.classList.remove('parameters-open');else savePreference(name,document.body.classList.contains(name));syncDrawers();});
$('sidebar-backdrop').addEventListener('click',()=>{document.body.classList.remove('sidebar-open');syncDrawers();$('sidebar-toggle').focus();});
$('parameter-toggle').setAttribute('popovertarget','workspace-settings');
$('parameter-toggle').addEventListener('click',event=>{event.preventDefault();setParameters(!$('workspace-settings').matches(':popover-open'));});
$('workspace-settings').addEventListener('toggle',syncDrawers);
$('close-model-settings').addEventListener('click',()=>setParameters(false));
$('finish-model-settings').addEventListener('click',()=>setParameters(false));
$('workspace-load').addEventListener('click',()=>{if(state.model)loadModel(state.model);});
$('apply-model-settings').addEventListener('click',async()=>{const settings=runtimeSettingsState();if(settings.error){showToast(settings.error);return;}if(settings.pending){await loadModel(state.model);if(!workspace().loadError)setParameters(false);}else setParameters(false);});
window.addEventListener('resize',applyParameterState);
new ResizeObserver(positionModelPicker).observe($('app-toolbar'));
window.addEventListener('keydown',event=>{
  if($('model-picker-popover').matches(':popover-open')){if(event.key==='Escape'){event.preventDefault();closeModelPicker();}return;}
  if(event.key==='Escape'){if($('workspace-settings').matches(':popover-open'))setParameters(false);if(document.body.classList.contains('sidebar-open'))$('sidebar-backdrop').click();}
  if(event.key!=='Tab')return;
  const drawer=document.body.classList.contains('sidebar-open')?$('app-sidebar'):null;
  if(!drawer)return;
  const controls=[...drawer.querySelectorAll('button,a[href],input,select,textarea,summary,[tabindex="0"]')].filter(el=>!el.disabled&&el.tabIndex>=0&&el.getClientRects().length&&!el.closest('details:not([open])')||el.tagName==='SUMMARY'&&!el.disabled&&el.getClientRects().length);
  if(!controls.length)return;
  const focused=controls.indexOf(document.activeElement);
  const next=focused<0?(event.shiftKey?controls.length-1:0):(focused+(event.shiftKey?-1:1)+controls.length)%controls.length;
  event.preventDefault();controls[next].focus();
},true);
$('tools-back').addEventListener('click',()=>navigate('tools'));
$('return-active-job').addEventListener('click',async()=>{const record=state.job;if(!record)return;await navigate(record.key,true,record.model);if(state.job===record){if(record.sourceBlob&&!record.sourceUrl)record.sourceUrl=URL.createObjectURL(record.sourceBlob);workspace(record.key).result=record;renderWorkspaceResults();updateActiveJobBanner();}});
$('end-realtime-session').addEventListener('click',()=>$('realtime-frame').contentWindow?.postMessage({type:'audiocpp:realtime-stop'},location.origin));
$('browse-models').addEventListener('click',()=>{$('model-task-filter').value=state.task;renderLibrary();navigate('models');});
fillSelect($('model-task-filter'),[{label:'所有用途',value:''},...TASKS.map(t=>({label:t.label,value:t.id}))],'');
['model-search','model-task-filter','model-state-filter'].forEach(id=>$(id).addEventListener('input',renderLibrary));
$('refresh-catalog').addEventListener('click',event=>runAction(event.currentTarget,async()=>{await loadCatalog();showToast('模型列表已更新');}));

function modelTask(model) { return model.model_task||model.ui_task||model.task; }
function fitsTask(model, task=state.task) { if(TASKS.some(t=>t.id===model.task))return model.task===task;const t=TASKS.find(v=>v.id===task);return t&&(t.types.includes(modelTask(model))||modelTask(model)===task); }
async function loadCatalog() {
  const data=await api('/catalog');state.catalog=data;
  for(const task of data.tasks||[]){const local=TASKS.find(t=>t.id===task.id);if(local&&Array.isArray(task.types))local.types=task.types;}
  $('connection-error').hidden=true;
  $('version-label').textContent=`Aixora Audio ${data.version||''}`;
  // Catalog construction can finish after a newer runtime response.
  if(!state.runtime)updateStatus(data);
  else {updateResidentModel(state.runtime.asr?.model);updateHomeStatus();}
  renderLibrary();
  renderTools();
  await refreshWorkspaceModels();
}
async function refreshWorkspaceModels() {
  const models=(state.catalog?.models||[]).filter(m=>m.installed&&fitsTask(m)&&(state.task!=='analysis'||!state.analysisType||modelTask(m)===state.analysisType));
  const loaded=models.find(m=>m.id===state.runtime?.server?.model);
  const wanted=workspace().model||preference('model-choices',{})[state.key]||loaded?.id;const selected=models.find(m=>m.id===wanted);
  fillSelect($('workspace-model'),models.length?models.map(m=>({label:m.label||m.id,value:m.id})):[{label:'还没有适用的已安装模型',value:''}],selected?.id||'');
  $('workspace-model').disabled=!models.length;
  // Populate the picker before awaiting detail so a late response cannot replace a pressed load button.
  renderModelPicker();
  if(selected){if(state.model!==selected.id||!state.detail||selected.installed!==state.detail.installed||state.detail.parameters?.some(p=>p.model_choices))await selectModel(selected.id);}
  else {state.model=null;state.detail=null;state.detailSeq++;state.overrides={};$('options-json').value='';renderInputs();renderParameters();updateRunButton();}
  updateLoadStatus();
}
$('workspace-model').addEventListener('change',event=>selectCandidate(event.target.value));
async function selectCandidate(id) {workspace().candidate=id;$('workspace-model').value=id;setParameters(false,false);await selectModel(id);}
async function selectModel(id, failOnError=false) {
  const seq=++state.detailSeq,key=state.key;const changed=state.model!==id;
  if(!state.model&&id){const prepared=modelOptions(key,null).inputs,target=modelOptions(key,id);target.inputs={...prepared,...target.inputs};}
  state.model=id;workspace().model=id;workspace().candidate=id;
  const prefs=preference('model-choices',{});prefs[key]=id;savePreference('model-choices',prefs);
  state.overrides=modelOptions().values;$('options-json').value=modelOptions().json;
  if(changed){stopRecordings();clearWorkspaceResult();state.detail=null;renderInputs();renderParameters();renderWorkspaceResults();updateActiveJobBanner();}
  updateRunButton();
  try {
    const detail=await api(`/models/${encodeURIComponent(id)}`);if(seq!==state.detailSeq||key!==state.key||id!==state.model)return;
    state.detail=detail;restoreSavedRoute(detail,modelOptions());$('options-json').value=modelOptions().json;
    renderInputs();renderParameters();updateRunButton();updateLoadStatus();
  }catch(error){if(seq!==state.detailSeq||key!==state.key)return;state.detail=null;updateRunButton();if(failOnError)throw error;showToast(friendlyError(error));}
}
function activeModelRuntime() {return state.task==='asr'&&state.model&&state.model===state.runtime?.asr?.model?state.runtime.asr:state.runtime?.server;}
function updateRunButton() {const b=$('run-button'),live=state.runtime?.realtime_active||state.realtime?.active,settings=runtimeSettingsState();b.disabled=!state.detail?.installed||state.model!==activeModelRuntime()?.model||settings.pending||!!settings.error||!!state.job||!!state.referenceJob||!!state.loading||state.runtime?.busy||live||state.submitting||state.uploading>0||state.recorders.size>0;uiText(b, taskInfo().action);const analyze=$('analyze-music-source');if(analyze)analyze.disabled=b.disabled||!formValues().audio;updateLoadStatus();}
function modelUsageHint(model) {
  return plainMessage(model.description).replace(/^\s*\*\*[^*]+\*\*\s*[:：]?\s*/,'').replace(/\*\*|`/g,'').replace(/必须提供/g,'需').replace(/\s+/g,' ').trim();
}
function renderModelPicker() {
  const focused=document.activeElement?.dataset.modelSelect;
  const query=$('model-picker-search').value.trim().toLowerCase();
  const models=(state.catalog?.models||[]).filter(m=>m.installed&&fitsTask(m)&&(!state.analysisType||modelTask(m)===state.analysisType)&&(!query||`${m.label} ${t(m.label)} ${m.id} ${m.family}`.toLowerCase().includes(query)));
  replace($('model-picker-list'),...models.map(model=>{
    const row=node('div','model-row');row.dataset.model=model.id;row.classList.toggle('selected',model.id===state.model);
    const select=button('','model-row-select',()=>selectCandidate(model.id));select.dataset.modelSelect=model.id;select.setAttribute('aria-pressed',String(model.id===state.model));
    const top=node('span','model-row-top');top.append(node('span','model-row-title',model.label||model.id));
    const meta=node('span','model-row-meta');for(const label of [model.format,model.precision,model.size_bytes?formatBytes(model.size_bytes):'',model.min_vram_gb?`显存估算 ${model.min_vram_gb} GB`:''])if(label)meta.append(node('span','',label));
    select.append(top,meta);const hint=modelUsageHint(model);if(hint){const description=node('span','model-row-description');uiText(description,hint,100);uiAttr(description, 'title', hint);select.append(description);}
    const actions=node('div','model-row-actions'),apiName=rawNode('code','model-row-api',model.id);uiAttr(apiName, 'title', `API 模型名：${model.id}`);uiAttr(apiName, 'aria-label', `API 模型名：${model.id}`);
    const load=button('加载','button secondary small-button model-row-load',()=>loadModel(model.id));load.dataset.loadModel=model.id;load.dataset.modelLabel=model.label||model.id;actions.append(apiName,load);row.append(select,actions);return row;
  }));
  if(!models.length)$('model-picker-list').append(node('p','muted small',query?'没有找到匹配的已安装模型。':'当前任务暂无已安装模型，请到模型中心安装。'));
  updateLoadStatus();
  if(focused&&$('model-picker-popover').matches(':popover-open'))$('model-picker-list').querySelector(`[data-model-select="${CSS.escape(focused)}"]`)?.focus({preventScroll:true});
}
function closeModelPicker(focus=true) {const picker=$('model-picker-popover');if(!picker.matches(':popover-open'))return;picker.hidePopover();$('model-picker-trigger').setAttribute('aria-expanded','false');if(focus)$('model-picker-trigger').focus();}
function positionModelPicker() {
  const picker=$('model-picker-popover');if(!picker.matches(':popover-open'))return;
  const anchor=$('model-picker-trigger').getBoundingClientRect(),top=anchor.bottom+8;
  const leftEdge=Math.max(0,document.querySelector('.main-content').getBoundingClientRect().left);
  picker.style.width=`${Math.min(720,innerWidth-leftEdge-12)}px`;
  picker.style.top=`${top}px`;picker.style.setProperty('--picker-top',`${top}px`);
  picker.style.left=`${leftEdge}px`;
}
// Identify the invoker so native light-dismiss does not close it before this click toggles it.
$('model-picker-trigger').setAttribute('popovertarget','model-picker-popover');
$('model-picker-trigger').addEventListener('click',event=>{event.preventDefault();const picker=$('model-picker-popover');if(picker.matches(':popover-open'))return closeModelPicker();setParameters(false,false);document.body.classList.remove('sidebar-open');syncDrawers();$('model-picker-search').value='';renderModelPicker();picker.showPopover();positionModelPicker();$('model-picker-search').focus();});
$('model-picker-search').addEventListener('input',renderModelPicker);
$('model-picker-popover').addEventListener('toggle',event=>$('model-picker-trigger').setAttribute('aria-expanded',String(event.newState==='open')));
$('model-picker-popover').addEventListener('keydown',event=>{if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;const rows=[...$('model-picker-list').querySelectorAll('.model-row-select')],index=rows.indexOf(document.activeElement);if(!rows.length||(index<0&&document.activeElement!==$('model-picker-search'))||index<0&&['Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?rows.length-1:(index+(event.key==='ArrowDown'?1:-1)+rows.length)%rows.length;rows[next].focus();});
window.addEventListener('resize',positionModelPicker);
window.addEventListener('scroll',positionModelPicker,true);
function restoreSavedRoute(detail, saved) {
  if(detail?.family!=='seed_vc'&&!(detail?.task==='vc'&&detail.vc_controls?.routes?.length))return;
  const route=detail.parameters?.find(param=>param.name==='route');if(!route)return;
  const allowed=new Set(detail.vc_controls?.routes||choicesOf(route.choices).map(choice=>String(choice.value)));
  const invalid=value=>value!=null&&value!==''&&!allowed.has(String(value));
  let restored=false;
  if(invalid(saved.values.route)){saved.values.route=route.default;restored=true;}
  try{const extra=JSON.parse(saved.json||'{}');if(extra&&typeof extra==='object'&&!Array.isArray(extra)&&invalid(extra.route)){extra.route=route.default;saved.json=JSON.stringify(extra,null,2);restored=true;}}catch{}
  if(restored)showToast('原转换路线不适用于当前模型入口，已恢复默认路线。');
}
function collectOptions(detail=state.detail, saved=modelOptions()) {
  let options={...saved.values};
  if(detail?.task==='asr')options=Object.fromEntries(Object.entries(options).filter(([name])=>detail.parameters?.some(p=>p.name===name)));
  for(const param of detail?.parameters||[])if(param.json_list&&Object.hasOwn(options,param.name)&&typeof options[param.name]==='string'){
    try{const parsed=JSON.parse(options[param.name]);if(!Array.isArray(parsed))throw new Error();options[param.name]=parsed;}catch{throw new Error(`${param.label||param.name} 需要 JSON 数组，例如 [1, 2]。`);}
  }
  const raw=saved.json.trim();
  if(raw){let extra;try{extra=JSON.parse(raw);}catch{throw new Error('高级参数 JSON 格式不正确。');}if(!extra||Array.isArray(extra)||typeof extra!=='object')throw new Error('高级参数必须是 JSON 对象。');options={...options,...extra};}
  if(detail?.task==='tts')for(const param of detail.parameters||[])if(['bool','boolean'].includes(param.type)&&typeof options[param.name]==='string'){
    const value=options[param.name].toLowerCase();if(['true','1','yes','on','false','0','no','off'].includes(value))options[param.name]=['true','1','yes','on'].includes(value);
  }
  if(detail?.family==='ace_step'&&options.route){options.task_route??=options.route;delete options.route;}
  if(detail?.family==='seed_vc'&&options.route){const route=detail.parameters?.find(param=>param.name==='route');if(route&&!choicesOf(route.choices).some(choice=>String(choice.value)===String(options.route)))throw new Error('当前模型入口不支持这条转换路线，请选择适用路线。');}
  if(detail?.task==='vc'){
    const controls=detail.vc_controls||{};
    if(options.route&&controls.routes?.length&&!controls.routes.includes(options.route))throw new Error('当前模型入口不支持这条转换路线，请选择适用路线。');
    for(const [alias,name] of Object.entries(controls.aliases||{}))if(Object.hasOwn(options,alias)){options[name]??=options[alias];delete options[alias];}
    for(const name of Object.keys(options))if(!vcParameterActive(name,detail,options))delete options[name];
    if(detail.profile?.send_seed===false)delete options.seed;
    if(detail.family==='rvc'){
      if(formValues().rvc_use_builtin===true)delete options.voice_model_path;
      if(formValues().rvc_no_index===true){delete options.retrieval_index_path;options.retrieval_blend=0;}
    }
  }
  if(detail?.task==='asr')for(const param of detail.parameters||[])if(!asrParameterActive(param,detail,options,saved.inputs))delete options[param.name];
  return options;
}

function vcParameterActive(name,detail,options) {
  const controls=detail.vc_controls||{},route=options.route||controls.default_route;
  if(controls.parameter_routes?.[name]&&!controls.parameter_routes[name].includes(route))return false;
  if(detail.family==='seed_vc'&&['auto_f0_adjust','semitone_shift'].includes(name))return ['true','1'].includes(String(options.f0_condition??controls.f0_default).toLowerCase());
  return true;
}

function asrParameterActive(param,detail,options,inputs) {
  if(param.scope&&param.scope!=='request')return true;
  const mode=inputs.stream?'streaming':'offline',value=name=>options[name]??detail.parameters?.find(p=>p.name===name)?.default;
  return (!param.modes||param.modes.includes(mode))&&Object.entries(param.requires||{}).every(([name,values])=>values.includes(value(name)))&&Object.entries(param.excludes||{}).every(([name,values])=>!values.includes(value(name)))&&(param.requires_value||[]).every(name=>!!value(name));
}
function asrLanguageChoices(detail) {
  const capability=detail.asr_inputs||{},fallback=capability.language_default;
  const label=fallback&&String(fallback).toLowerCase()!=='auto'?`模型默认（${languageLabel(fallback)}）`:capability.language_auto?'自动识别':'模型默认';
  const choices=languageChoices(detail.languages||[],label);
  if(capability.language_auto&&fallback&&String(fallback).toLowerCase()!=='auto')choices.splice(1,0,{label:'自动识别',value:capability.language_auto});
  return choices;
}
function runtimeOptions(options) {
  const result={};
  for(const scope of ['load_options','session_options']){
    const values=Object.hasOwn(options,scope)?options[scope]:{};if(!values||typeof values!=='object'||Array.isArray(values))throw new Error(`${scope} 必须是 JSON 对象。`);
    result[scope]={...values};for(const [key,value] of Object.entries(options))if(key.startsWith(`${scope}.`))result[scope][key.slice(scope.length+1)]=value;
  }
  return result;
}
function runtimeSettingsState() {
  try{
    // The backend stores runtime values as JSON strings; ignore spacing and key order.
    const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
    const runtimeValue=value=>{const text=typeof value==='string'?value:JSON.stringify(value);try{return JSON.stringify(canonical(JSON.parse(text)));}catch{return text;}};
    const normalize=options=>Object.fromEntries(Object.entries(runtimeOptions(options)).map(([scope,values])=>[scope,Object.fromEntries(Object.keys(values).sort().map(key=>[key,runtimeValue(values[key])]))]));
    const desired=normalize(collectOptions()),configuration=activeModelRuntime()?.configuration;
    const active=normalize(configuration?.managed?configuration:modelOptions().appliedRuntime||{});
    return {pending:!!(state.detail&&state.model===activeModelRuntime()?.model&&JSON.stringify(desired)!==JSON.stringify(active)),error:''};
  }catch(error){return {pending:false,error:error.message};}
}
function updateLoadStatus() {
  const settings=runtimeSettingsState();
  uiText($('model-picker-label'), state.model?(state.detail?.label||state.catalog?.models.find(m=>m.id===state.model)?.label||state.model):`选择${taskInfo().label}模型`);
  uiText($('model-picker-heading'), `${taskInfo().label}模型`);
  $('workspace-start').hidden=true;$('workspace-grid').hidden=initializing;$('workspace-loading').hidden=!initializing;$('workspace-grid').setAttribute('aria-busy',String(initializing));$('model-picker-trigger').disabled=initializing;$('parameter-toggle').hidden=initializing||state.page!=='workspace'||!state.detail;
  $('page-workspace').classList.toggle('workspace-unloaded',!state.detail);
  const blocked=modelLoadBlockReason(),busy=!!blocked,ws=workspace(),failed=ws.loadError;
   const loadedModel=activeModelRuntime()?.model;
  let message='',status='';
  if(state.loading?.key===state.key){message=`正在加载 · ${state.loading.model}`;status='loading';}
  else if(failed){message=`加载失败：${ws.loadError}`;status='error';}
  else if(!state.runtime&&$('connection-status').dataset.state==='offline'){message='本地服务离线，请重新运行启动器';status='error';}
  else if(settings.pending){message='设置待应用 · 需重载模型';status='pending';}
  else if(state.runtime?.server?.model){message=`任务模型 · ${modelLabel(state.runtime.server.model)}`;status='ready';}
  const load=$('workspace-load');load.disabled=busy||!state.detail?.installed||!!settings.error;uiText(load, state.loading?'加载中…':failed?'重试加载':settings.pending?'应用并重载':state.model===loadedModel?'已加载':'加载模型');
  load.hidden=!!loadedModel&&state.model===loadedModel&&!state.loading&&!failed&&!settings.pending&&!settings.error;
  uiAttr(load, 'title', blocked||settings.error||(state.model===loadedModel?'重新加载当前模型设置':'加载所选模型'));
  uiText($('run-hint'), settings.error||'');$('run-hint').hidden=!settings.error;
  const loaded=!!state.model&&state.model===loadedModel;
  uiText($('model-settings-status'), settings.error||(settings.pending?'设置待应用':loaded?'运行参数已应用':''));
  const apply=$('apply-model-settings');uiText(apply, loaded?'应用并重载模型':'保存设置');apply.disabled=!!settings.error||busy||loaded&&!settings.pending;
  uiAttr(apply, 'title', blocked||settings.error||(loaded?(settings.pending?'应用当前设置并重新加载模型':'修改标注“需重载”的参数后可应用'):'保存参数，稍后从模型选择器加载'));
  $('finish-model-settings').hidden=!loaded;
  $('parameter-toggle').classList.toggle('pending',settings.pending);
  const indicator=$('workspace-load-status');indicator.hidden=!message;replace(indicator,node('span','',message));uiAttr(indicator, 'title', message);indicator.dataset.state=status;
  const feedback=$('model-picker-status');feedback.hidden=!failed&&!blocked;uiText(feedback, failed?message:blocked);feedback.dataset.state=status;
  for(const row of $('model-picker-list').querySelectorAll('[data-model]')){
    const selected=row.dataset.model===(ws.candidate||state.model);row.classList.toggle('selected',selected);row.querySelector('.model-row-select').setAttribute('aria-pressed',String(selected));
  }
  for(const control of $('model-picker-list').querySelectorAll('[data-load-model]')){
    const loading=state.loading?.model===control.dataset.loadModel,loaded=control.dataset.loadModel===loadedModel||(state.task==='asr'&&control.dataset.loadModel===state.runtime?.asr?.model),error=ws.loadErrorModel===control.dataset.loadModel&&ws.loadError;
    control.disabled=busy;uiText(control, loading?'加载中…':error?'重试':loaded?'已加载':'加载');control.classList.toggle('loaded',loaded&&!loading&&!error);
    uiAttr(control, 'aria-label', `${loaded?'重新加载':'加载'} ${control.dataset.modelLabel}`);uiAttr(control, 'title', blocked||error||(loaded?'重新加载以应用运行参数':''));
  }
  for(const control of $('model-picker-list').querySelectorAll('.model-row-select'))control.disabled=!!state.loading;
}
function modelLoadBlockReason() {
  if(initializing)return '正在读取工作空间…';
  if(state.loading)return '模型正在加载，请稍候。';
  if(state.runtime?.realtime_active||state.realtime?.active)return '实时聊天正在使用模型，请先结束通话。';
  if(state.referenceJob)return '正在识别参考文本，请等待识别完成。';
  if(state.job||state.submitting||state.runtime?.busy)return '已有任务正在执行，请等待完成或先停止任务。';
  return '';
}
$('options-json').addEventListener('input',()=>{modelOptions().json=$('options-json').value;updateRunButton();if(state.task==='music')renderInputs();renderParameters();});
async function loadModel(model) {
  const blocked=modelLoadBlockReason();if(blocked){showToast(blocked);return;}
  closeModelPicker();if($('workspace-settings').matches(':popover-open'))setParameters(false);
  const key=state.key;workspace(key).loadError='';workspace(key).loadErrorModel=model;state.loading={model,key};updateRunButton();
  try{
    const detail=model===state.model&&state.detail?state.detail:await api(`/models/${encodeURIComponent(model)}`);
    if(key!==state.key)return;
    if(!detail?.installed)throw new Error('模型尚未准备好，请先在模型中心完成安装。');
    const options=collectOptions(detail,modelOptions(key,model));runtimeOptions(options);validateModelChoices(options,detail);
    const result=await api(`/models/${encodeURIComponent(model)}/load`,{method:'POST',body:{options}});updateStatus(result);
    if(result.server?.model!==model&&result.asr?.model!==model)throw new Error(`服务尚未确认模型 ${model} 已加载，请检查运行日志后重试。`);
    modelOptions(key,model).appliedRuntime=runtimeOptions(options);workspace(key).model=model;workspace(key).candidate=model;
    if(key===state.key){await selectModel(model,true);closeModelPicker();showToast(`模型已加载 · ${model}`);}
  }
  catch(error){workspace(key).loadError=friendlyError(error);showToast(friendlyError(error));}
  finally{state.loading=null;await pollStatus();updateRunButton();}
}
function updateActiveJobBanner() {
  const record=state.job||state.pendingRecord;
  $('active-job-banner').hidden=!record||state.page==='workspace'&&state.key===record.key&&state.model===record.model&&(workspace().result===record||state.pendingRecord===record&&(workspace().resultEpoch||0)===record.resultEpoch);
  if(record)uiText($('active-job-label'), `${record.label} · ${plainMessage(record.result?.message||'正在处理')}`);
}
function updateRealtimeBadge() {
  const active=!!(state.realtime?.active||state.runtime?.realtime_active);
  $('realtime-nav-status').hidden=!active;$('end-realtime-session').hidden=!active;
  uiText($('realtime-nav-status'), state.realtime?.microphone?'通话中':'会话中');
}
function stopRecordings() {state.recordingEpoch=(state.recordingEpoch||0)+1;for(const recorder of state.recorders)if(recorder.state==='recording')recorder.stop();}
function languageLabel(value,fallback=value) {const key=String(value).toLowerCase();if(LANGUAGE_NAMES[key])return LANGUAGE_NAMES[key];try{const name=new Intl.DisplayNames([getLanguage()==='en'?'en':'zh-CN'],{type:'language'}).of(key);return name&&name!==key?name:fallback;}catch{return fallback;}}
function languageChoices(values,automatic='自动') {const seen=new Set(['','auto']);const choices=[{label:automatic,value:''}];for(const item of choicesOf(values)){const key=String(item.value).toLowerCase();if(seen.has(key))continue;seen.add(key);choices.push({label:languageLabel(key,item.label),value:item.value});}return choices;}

const OPTION_CHOICE_NAMES={auto:'自动',default:'默认',native:'跟随权重文件',f32:'F32',f16:'F16',bf16:'BF16',q8_0:'Q8_0',none:'不启用',off:'关闭',on:'开启',true:'开启',false:'关闭',fixed:'固定',grow:'自动扩展',tiered:'分档',full:'完整',full_context:'完整上下文',streaming:'流式',cpu:'处理器',model:'跟随模型',base:'基础版',flash:'快速版',eager:'即时计算',flash_attention:'融合注意力',first_block_cache:'首块缓存',spectrum:'频谱加速',word_budget:'按字数预算',tag_aware:'按标签',endline:'按换行',japanese:'日语分段',vad:'按语音片段',verbatim:'逐字转写',intended:'清理后的文本',verbatimize:'按原文还原口语',greedy_search:'贪心搜索',modified_beam_search:'改进束搜索',low_latency:'低延迟',high_latency:'高延迟',very_high_latency:'较高延迟',low:'低',very_low:'很低',ultra_low:'极低',very_high:'很高',stable:'稳定',quick:'快速',exact:'精确',semantic:'语义',text:'文本',audio:'音频',edit:'编辑',editing:'编辑',instruct:'按指令',instruction_tts:'指令语音合成',zero_shot:'零样本克隆',cross_lingual:'跨语言',tts:'语音合成',tts_interleave:'交错语音合成',text_to_audio:'文字生成音频',long_form:'长音频',joint:'联合',independent:'独立',alternating:'交替',same:'保持一致',masked:'遮罩',edges:'边缘',melody:'旋律',segment:'分段',attribution:'归属',custom:'自定义',init_audio:'以源音频初始化',inpaint_audio:'局部重绘',happy:'开心',sad:'悲伤',angry:'愤怒',fearful:'恐惧',disgusted:'厌恶',surprised:'惊讶',neutral:'中性',expressive:'富有表现力',clear:'清晰',english_female:'英语女声',english_male:'英语男声',us_female:'美式女声',us_male:'美式男声',uk_female:'英式女声',uk_male:'英式男声',style_preserved_vc:'保留风格换声',style_converted_vc:'转换风格换声',style_preserved_svc:'保留风格歌声转换',style_converted_svc:'转换风格歌声转换',singing_style_conversion:'演唱风格转换',latin:'拉丁文字',pre_romanized:'已罗马化',quiet_energy:'低能量边界'};
const DESIGN_COMMON_PARAMETERS={
  qwen3_tts:['do_sample','temperature'],
  fireredtts3:['num_inference_steps','guidance_scale'],
  irodori_tts:['duration_sec','duration_scale','caption_guidance_scale'],
  moss_voicegen:['temperature','repetition_penalty'],
  firered_audio:['num_inference_steps','guidance_scale'],
  breeze_tts:['temperature','guidance_scale'],
};
function visibleParameters() {
  const task=state.task,detail=state.detail||{};
  const dedicatedLanguage=task==='tts'||(task==='asr'&&detail.languages?.length)||(task==='analysis'&&modelTask(detail)==='align');
  const dedicatedSeed=['tts','music','vc','processing','design'].includes(task)&&detail.profile?.send_seed!==false;
  return (detail.parameters||[]).filter(p=>{
    if(dedicatedLanguage&&(p.name==='language'||detail.family==='index_tts2'&&p.name==='lang'))return false;
    if(dedicatedSeed&&p.name==='seed')return false;
    if(task==='asr'&&detail.asr_inputs?.context&&['context','instruct'].includes(p.name))return false;
    if(task==='design'&&['instruction','instruct',detail.profile?.vdes_option_key].includes(p.name))return false;
    if(task==='music'){
      if(['lyrics','duration'].includes(p.name))return false;
      if(detail.music_inputs?.duration&&['duration_sec','duration_seconds'].includes(p.name))return false;
      if(detail.family==='yue2'&&p.name==='style')return false;
      if(detail.music_inputs?.text_role==='instruction'&&p.name===detail.profile?.edit_instruction_key)return false;
    }
    return true;
  });
}

function field(label, input, help='', required=false) {
  help=plainMessage(help);
  const group=node('div','field-group'),labelEl=node('label','field-label',label);
  if(input.id)labelEl.htmlFor=input.id;
  group.append(labelEl,input);
  if(help){const control=input.matches('input,textarea,select')?input:input.querySelector('input');if(control){uiAttr(control, 'title', help);uiAttr(control, 'aria-description', help);}}
  return group;
}
function textInput(key,label,{help='',placeholder='',required=false,rows=0,type='text',value, min, max,step,values=fieldValues(key)}={}) {
  const input=node(rows?'textarea':'input',rows>=4?'large-text':rows===3?'short-text':'');input.id=`input-${state.page==='references'?'reference':state.task}-${key}`;input.dataset.inputKey=key;input._values=values;if(rows){input.rows=rows;input.style.setProperty('--text-lines',rows);}else input.type=type;uiAttr(input, 'placeholder', placeholder);input.required=required;
  if(min!==undefined)input.min=min;if(max!==undefined)input.max=max;if(step!==undefined)input.step=step;
  input.value=values[key]??value??'';input.addEventListener('input',()=>{values[key]=type==='number'?(input.value===''?'':Number(input.value)):input.value;if(key==='reference_text')values._referenceTextRevision=(values._referenceTextRevision||0)+1;});
  return field(label,input,help,required);
}
function selectInput(key,label,choices,{help='',value=''}={}) { const values=fieldValues(key);const input=node('select');input.id=`input-${state.task}-${key}`;input.dataset.inputKey=key;fillSelect(input,choices,values[key]??value);input.addEventListener('change',()=>values[key]=input.value);return field(label,input,help); }
function checkboxInput(key,label,help='') { help=plainMessage(help);const values=fieldValues(key);const group=node('div',`field-group${help?' field-inline-control':''}`);const row=node('label','check-label');const input=node('input');input.type='checkbox';input.dataset.inputKey=key;input.checked=!!values[key];input.addEventListener('change',()=>values[key]=input.checked);row.append(input,node('span','',label));group.append(row);if(help){uiAttr(input, 'title', help);uiAttr(input, 'aria-description', help);}return group; }
const WAVEFORM_PREVIEW_ENABLED=false;
const waveformCache=new WeakMap();
async function wavWaveformData(blob) {
  const header=new DataView(await blob.slice(0,12).arrayBuffer());
  if(header.byteLength<12||header.getUint32(0)!==0x52494646||header.getUint32(8)!==0x57415645)return null;
  const limit=Math.min(blob.size,header.getUint32(4,true)+8);
  let format,dataOffset,dataSize;
  for(let offset=12;offset+8<=limit;){
    const chunk=new DataView(await blob.slice(offset,offset+8).arrayBuffer());
    const kind=chunk.getUint32(0),size=chunk.getUint32(4,true),start=offset+8;
    if(start+size>limit)throw new Error('音频文件不完整，无法读取波形。');
    if(kind===0x666d7420&&size>=16){
      const info=new DataView(await blob.slice(start,start+Math.min(size,40)).arrayBuffer());
      const encoding=info.getUint16(0,true);
      format={encoding:encoding===0xfffe&&size>=40?info.getUint16(24,true):encoding,channels:info.getUint16(2,true),rate:info.getUint32(4,true),align:info.getUint16(12,true),bits:info.getUint16(14,true)};
    }else if(kind===0x64617461){dataOffset=start;dataSize=size;}
    if(format&&dataOffset!==undefined)break;
    offset=start+size+(size%2);
  }
  if(!format||dataOffset===undefined)return null;
  const {encoding,channels,rate,align,bits}=format,bytes=bits/8;
  if(!(encoding===1&&[8,16,24,32].includes(bits)||encoding===3&&[32,64].includes(bits)))return null;
  if(!channels||!rate||align!==channels*bytes||!dataSize||dataSize%align)throw new Error('音频格式无效，无法读取波形。');
  const frames=dataSize/align,peaks=new Float32Array(320),step=Math.max(1,Math.ceil(frames/peaks.length));
  const chunkSize=Math.max(align,Math.floor(1024*1024/align)*align);
  for(let offset=0;offset<dataSize;offset+=chunkSize){
    const samples=new DataView(await blob.slice(dataOffset+offset,dataOffset+Math.min(dataSize,offset+chunkSize)).arrayBuffer());
    for(let position=0;position<samples.byteLength;position+=align){
      const bin=Math.floor((offset+position)/align/step);
      for(let channel=0;channel<channels;channel++){
        const index=position+channel*bytes;
        let value;
        if(encoding===3)value=bits===32?samples.getFloat32(index,true):samples.getFloat64(index,true);
        else if(bits===8)value=(samples.getUint8(index)-128)/128;
        else if(bits===16)value=samples.getInt16(index,true)/32768;
        else if(bits===24)value=((samples.getUint8(index)|(samples.getUint8(index+1)<<8)|(samples.getInt8(index+2)<<16)))/8388608;
        else value=samples.getInt32(index,true)/2147483648;
        if(Number.isFinite(value))peaks[bin]=Math.max(peaks[bin],Math.min(1,Math.abs(value)));
      }
    }
  }
  return {peaks,duration:frames/rate};
}
function waveformData(blob) {
  if(!waveformCache.has(blob))waveformCache.set(blob,(async()=>{
    const wav=await wavWaveformData(blob);if(wav)return wav;
    if(blob.size>32*1024*1024)throw new Error('音频较大，请使用播放器定位。');
    const Context=window.OfflineAudioContext||window.webkitOfflineAudioContext;
    if(!Context)throw new Error('当前浏览器不支持波形预览。');
    const buffer=await new Context(1,1,16000).decodeAudioData(await blob.arrayBuffer());
    const peaks=new Float32Array(320),step=Math.max(1,Math.ceil(buffer.length/peaks.length));
    for(let channel=0;channel<buffer.numberOfChannels;channel++){const samples=buffer.getChannelData(channel);for(let i=0;i<peaks.length;i++)for(let j=i*step;j<Math.min(samples.length,(i+1)*step);j++)peaks[i]=Math.max(peaks[i],Math.abs(samples[j]));}
    return {peaks,duration:buffer.duration};
  })());return waveformCache.get(blob);
}
function attachWaveform(container,audio,blob,onDemand=false,enabled=WAVEFORM_PREVIEW_ENABLED) {
  if(!enabled)return null;
  const panel=node('div','waveform-panel'),hint=node('span','muted small','正在读取波形…');panel.append(hint);container.append(panel);
  async function draw(source){try{
    if(!audio.readyState)await new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timer);audio.removeEventListener('loadedmetadata',loaded);audio.removeEventListener('error',failed);};const loaded=()=>{done();resolve();},failed=()=>{done();reject(new Error('无法读取波形，仍可使用播放器试听。'));},timer=setTimeout(failed,10000);audio.addEventListener('loadedmetadata',loaded,{once:true});audio.addEventListener('error',failed,{once:true});});
    if(!Number.isFinite(audio.duration))throw new Error('无法读取音频时长。');
    const {peaks,duration}=await waveformData(source);if(!panel.isConnected)return;
    const canvas=node('canvas','audio-waveform');canvas.width=640;canvas.height=100;canvas.setAttribute('aria-hidden','true');
    const progress=node('input','waveform-position');progress.type='range';progress.min=0;progress.max=duration;progress.step=.01;progress.value=0;uiAttr(progress, 'aria-label', '音频播放位置');
    const time=node('span','muted small waveform-time');
    const paint=()=>{const ctx=canvas.getContext('2d'),style=getComputedStyle(panel),position=audio.currentTime||0;ctx.clearRect(0,0,640,100);for(let i=0;i<peaks.length;i++){const height=Math.max(1,peaks[i]*90);ctx.fillStyle=style.getPropertyValue(i/peaks.length<position/duration?'--accent':'--muted');ctx.fillRect(i*2,(100-height)/2,1,height);}progress.value=position;uiText(time, `${formatDuration(position)} / ${formatDuration(duration)}`);};
    progress.addEventListener('input',()=>{audio.currentTime=Number(progress.value);paint();});canvas.addEventListener('click',event=>{const bounds=canvas.getBoundingClientRect();audio.currentTime=Math.max(0,Math.min(duration,(event.clientX-bounds.left)/bounds.width*duration));paint();});audio.addEventListener('timeupdate',paint);replace(panel,canvas,progress,time);paint();
  }catch(error){uiText(hint, error.message||'无法读取波形，仍可使用播放器试听。');}}
  const loadWaveform=async()=>{try{if(blob)await draw(blob);else{const response=await fetch(audio.src);if(!response.ok)throw new Error('无法读取音频。');await draw(await response.blob());}}catch(error){uiText(hint, error.message||'无法读取波形，仍可使用播放器试听。');}};
  if(!onDemand)void loadWaveform();
  else{const load=button('显示波形','text-button small',async()=>{load.disabled=true;uiText(hint, '正在读取波形…');await loadWaveform();load.remove();});uiText(hint, '');panel.prepend(load);}
  return panel;
}
function uploadInput(key,label,{required=false,help='',accept='audio/*,.wav,.mp3,.flac,.m4a,.ogg,.webm',record=true,values=formValues(),onUploaded,onClear,fallback,referencePurpose}={}) {
  const ownerKey=state.key,ownerPage=state.page;const zone=node('div','upload-zone');const file=node('input');file.type='file';file.accept=accept;file.id=`input-${ownerPage==='references'?'reference':state.task}-${key}`;file.dataset.inputKey=key;uiAttr(file, 'aria-label', label);
  const purpose=referencePurpose||(key==='voice'?(ownerPage==='references'?'reference-library':ownerPage==='workspace'&&state.task==='tts'?'tts-reference':''):'');
  const waveformOnDemand=ownerPage==='workspace';
  const showWaveform=ownerPage==='workspace'&&state.task==='separation';
  const revisionKey=`_${key}Revision`;
  const fallbackRevisionKey=fallback?`_${fallback.key}Revision`:'';let fallbackInput;
  if(fallback)values[fallback.key]??=!values[key];
  const controls=node('div','upload-controls');const status=rawNode('span','upload-status',(key!=='voice'||values.voice||values._referenceEditing?values[`_${key}Name`]:'')||'');const clear=button('移除','upload-clear',()=>{values[revisionKey]=(values[revisionKey]||0)+1;values[key]='';values[`_${key}Name`]='';delete values[`_${key}Blob`];delete values[`_${key}Duration`];if(values[`_${key}Url`])URL.revokeObjectURL(values[`_${key}Url`]);delete values[`_${key}Url`];file.value='';uiText(status, '');preview.hidden=true;preview.removeAttribute('src');onClear?.();if(ownerPage==='references')renderReferenceEditor();});
  const preview=node('audio');preview.controls=true;preview.preload='metadata';preview.hidden=true;let waveform;
  if(values[`_${key}Url`]&&(key!=='voice'||values.voice||values._referenceEditing&&values._referenceSource)){preview.src=values[`_${key}Url`];preview.hidden=false;}
  async function upload(blob,name,revision=(values[revisionKey]=(values[revisionKey]||0)+1),recorded=false) {
    if(revision!==values[revisionKey])return;
    const fallbackRevision=values[fallbackRevisionKey]||0;
    state.uploading++;updateRunButton();file.disabled=true;uiText(status, '正在上传…');controls.style.visibility='visible';
    try {const data=new FormData();data.append('file',blob,name);if(purpose)data.append('purpose',purpose);if(recorded)data.append('recorded','true');const result=await api('/uploads',{method:'POST',body:data});if(revision!==values[revisionKey])return;values[key]=result.id;values[`_${key}Name`]=result.name||name;values[`_${key}Duration`]=result.duration;values[`_${key}Blob`]=blob;rawText(status,values[`_${key}Name`]);if(record){const old=values[`_${key}Url`];if(old)URL.revokeObjectURL(old);const url=URL.createObjectURL(blob);values[`_${key}Url`]=url;preview.src=url;preview.hidden=false;waveform?.remove();waveform=attachWaveform(zone,preview,blob,false,showWaveform);}if(fallback&&fallbackRevision===(values[fallbackRevisionKey]||0)){values[fallback.key]=false;fallbackInput.checked=false;if(zone.isConnected)renderParameters();}const rendered=onUploaded?.(result);if(!rendered&&!zone.isConnected&&state.key===ownerKey&&state.page===ownerPage){if(ownerPage==='references')renderReferenceEditor();else{renderInputs();if(fallback)renderParameters();}}}
    catch(error){if(revision===values[revisionKey]){if(purpose==='tts-reference'){values[key]='';delete values[`_${key}Blob`];if(values[`_${key}Url`])URL.revokeObjectURL(values[`_${key}Url`]);delete values[`_${key}Url`];delete values[`_${key}Duration`];values[`_${key}Name`]='';onClear?.();preview.removeAttribute('src');preview.hidden=false;}uiText(status, friendlyError(error));controls.style.visibility='visible';showToast(friendlyError(error));}}
    finally{state.uploading--;file.disabled=false;if(!record)clear.hidden=!values[key];updateRunButton();}
  }
  file.addEventListener('change',()=>{if(file.files[0])upload(file.files[0],file.files[0].name);});
  controls.append(status);if(!fallback&&(!waveformOnDemand||!record))controls.append(clear);
  clear.addEventListener('click',()=>{waveform?.remove();waveform=null;});
  zone.append(file,controls);
  if(record){
    const recordingControls=node('div','recording-controls'),elapsed=node('span','recording-time','0 秒');elapsed.hidden=true;elapsed.setAttribute('role','timer');uiAttr(elapsed, 'aria-label', '已录音时长');let recordingTimer,recordingStopTimer;
    const stop=button('','button subtle small-button recording-stop',()=>{if(recordBtn._recorder?.state==='recording')recordBtn._recorder.stop();});stop.append(node('span','recording-stop-icon'));stop.hidden=true;uiAttr(stop, 'title', '停止录音');uiAttr(stop, 'aria-label', '停止录音');
    function resetRecording(){clearInterval(recordingTimer);clearTimeout(recordingStopTimer);const focused=document.activeElement===stop;elapsed.hidden=true;stop.hidden=true;recordBtn.disabled=false;uiText(recordBtn, '录音');recordBtn.classList.remove('recording');if(focused)recordBtn.focus({preventScroll:true});}
    const recordBtn=button('录音','button subtle small-button recording-start',async()=>{
      if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){showToast('此浏览器不支持录音，请使用 Chrome / Edge，或上传音频文件。');return;}
      if(state.recorders.size||state.recordingRequest){showToast('已有录音或麦克风权限请求正在进行。');return;}
      let stream,recorder;
      const request={epoch:state.recordingEpoch,key:ownerKey,model:state.model,page:ownerPage};state.recordingRequest=request;recordBtn.disabled=true;
      try {
        stream=await navigator.mediaDevices.getUserMedia({audio:true});
        if(request.epoch!==state.recordingEpoch||request.key!==state.key||request.model!==state.model||state.page!==request.page||!zone.isConnected){stream.getTracks().forEach(t=>t.stop());return;}
        const revision=(values[revisionKey]=(values[revisionKey]||0)+1),chunks=[];const supported=['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4'].find(t=>MediaRecorder.isTypeSupported(t));recorder=new MediaRecorder(stream,supported?{mimeType:supported}:{});
        recordBtn._recorder=recorder;state.recorders.add(recorder);
        recorder.addEventListener('dataavailable',event=>{if(event.data.size)chunks.push(event.data);});
        recorder.addEventListener('stop',async()=>{stream.getTracks().forEach(t=>t.stop());state.recorders.delete(recorder);resetRecording();const current=request.epoch===state.recordingEpoch&&request.key===state.key&&request.model===state.model&&request.page===state.page&&zone.isConnected;const type=recorder.mimeType||'audio/webm';const ext=type.includes('mp4')?'m4a':type.includes('ogg')?'ogg':'webm';if(current&&chunks.length&&!recorder._failed)await upload(new Blob(chunks,{type}),`录音-${Date.now()}.${ext}`,revision,true);else if(current){uiText(status, recorder._failed?'录音中断，请重试。':'没有录制到音频，请重试。');controls.style.visibility='visible';}updateRunButton();});
        recorder.addEventListener('error',()=>{recorder._failed=true;stream.getTracks().forEach(t=>t.stop());state.recorders.delete(recorder);resetRecording();uiText(status, '录音中断，请重试。');controls.style.visibility='visible';updateRunButton();});
        recorder.start();const started=Date.now();uiText(elapsed, '0 秒');elapsed.hidden=false;stop.hidden=false;recordBtn.classList.add('recording');recordingTimer=setInterval(()=>{uiText(elapsed, `${Math.floor((Date.now()-started)/1000)} 秒`);},250);stop.focus({preventScroll:true});updateRunButton();
        if(purpose==='tts-reference')recordingStopTimer=setTimeout(()=>{if(recorder.state==='recording')recorder.stop();},30000);
      }catch(error){stream?.getTracks().forEach(t=>t.stop());if(recorder)state.recorders.delete(recorder);resetRecording();if(request.epoch===state.recordingEpoch)showToast(error.name==='NotAllowedError'?'录音需要麦克风权限，请在浏览器地址栏允许访问后重试。':'无法启动麦克风，请检查设备是否被占用。');}
      finally{if(state.recordingRequest===request)state.recordingRequest=null;recordBtn.disabled=recorder?.state==='recording'&&!recorder._failed;updateRunButton();}
    });
    recordingControls.append(recordBtn,elapsed,stop);zone.append(recordingControls);
    if(ownerPage==='workspace'){const slot=node('div','audio-player-slot');slot.append(preview);zone.append(slot);}
    else zone.append(preview);
    if(values[`_${key}Blob`])waveform=attachWaveform(zone,preview,values[`_${key}Blob`],false,showWaveform);
  }
  if(waveformOnDemand){
    file.classList.add('sr-only');file.tabIndex=-1;
    const actions=node('div','upload-actions'),choose=button(fallback?.chooseLabel||(record?'上传音频':'选择文件'),'button secondary small-button',()=>file.click());
    const microphone=zone.querySelector('.recording-controls');actions.append(file,choose);if(microphone)actions.append(microphone);
    if(ownerPage==='workspace'&&state.task==='music'&&state.detail?.family==='ace_step'&&key==='audio'){clear.hidden=!values[key];actions.append(clear);}
    zone.prepend(actions);
  }
  if(fallback){
    zone.classList.add('rvc-file-choice');
    const row=node('label','check-label rvc-file-toggle');fallbackInput=node('input');fallbackInput.type='checkbox';fallbackInput.dataset.inputKey=fallback.key;fallbackInput.checked=values[fallback.key];uiAttr(fallbackInput, 'title', fallback.help);
    fallbackInput.addEventListener('change',()=>{values[fallback.key]=fallbackInput.checked;values[fallbackRevisionKey]=(values[fallbackRevisionKey]||0)+1;renderParameters();updateRunButton();});
    row.append(fallbackInput,node('span','',fallback.label));zone.append(row);
  }
  return field(label,zone,help,required);
}
function addSpeakerReferences(tabs) {
  const controls=state.detail?.tts_controls?.speakers;if(!controls)return;
  const saved=modelOptions(),inputs=saved.inputs,rows=inputs.speaker_references||=[{},{}];
  const ownerKey=state.key,ownerModel=state.model,group=tabs.querySelector('.tts-reference-group');
  const toolbar=node('div','speaker-reference-toolbar'),toggle=node('input');toggle.type='checkbox';toggle.id='multi-speaker-references';toggle.checked=!!inputs.multi_speaker;
  const label=node('label','check-label');label.htmlFor=toggle.id;label.append(toggle,node('span','','按说话人设置音色'));toolbar.append(label);tabs.insertBefore(toolbar,group);
  const panel=node('div','speaker-reference-panel');panel.hidden=!toggle.checked;group.hidden=toggle.checked;tabs.append(panel);
  const refresh=()=>{if(state.key===ownerKey&&state.model===ownerModel){renderInputs();renderParameters();updateRunButton();}};
  toggle.addEventListener('change',()=>{inputs.multi_speaker=toggle.checked;setModelOption('voice_samples',undefined);setModelOption(`${state.detail.family}.voice_samples`,undefined);for(const audio of tabs.querySelectorAll('audio'))audio.pause();refresh();});
  panel.append(node('p','muted small',controls.allow_empty?'按 [S1]、[S2]… 对应音色；空位使用模型生成的声音。':'按 Speaker 0、Speaker 1… 对应音色；已设置音色时，中间不能留空。'));
  rows.forEach((slot,index)=>{
    const key=`speaker_${index}`,name=controls.first?`[S${index+controls.first}]`:`Speaker ${index}`;
    const card=node('div','speaker-reference-card'),heading=node('div','speaker-reference-heading');
    heading.append(node('span','field-label',name));
    const select=node('select');uiAttr(select, 'aria-label', `${name} 音频库`);
    fillSelect(select,[{label:'不选音频库 / 使用上传',value:''},...state.voices.map(v=>({label:v.label||v.name,value:v.name,raw:true}))],slot.builtin_voice||'');
    const player=node('audio');player.controls=true;player.preload='metadata';player.hidden=true;
    const sync=()=>{const voice=state.voices.find(v=>v.name===slot.builtin_voice);player.hidden=!voice;if(voice)player.src=voice.url||`${API}/references/${encodeURIComponent(voice.name)}/audio`;else player.removeAttribute('src');};
    sync();
    let transcriptInput;
    const clearTranscript=()=>{delete slot.reference_text;if(transcriptInput)transcriptInput.value='';};
    const upload=uploadInput(key,`${name} 上传或录音`,{values:slot,referencePurpose:'tts-reference',onUploaded:()=>{slot.builtin_voice='';select.value='';clearTranscript();sync();},onClear:()=>{clearTranscript();updateRunButton();}});
    upload.querySelectorAll('[data-input-key]').forEach(el=>delete el.dataset.inputKey);
    upload.hidden=!!slot.builtin_voice;
    select.addEventListener('change',()=>{slot.builtin_voice=select.value;slot[`_${key}Revision`]=(slot[`_${key}Revision`]||0)+1;upload.hidden=!!slot.builtin_voice;for(const audio of card.querySelectorAll('audio'))audio.pause();sync();updateRunButton();});
    card.append(heading,select,player,upload);
    if(controls.allow_empty){const text=transcriptInput=node('textarea','short-text');text.rows=2;uiAttr(text, 'placeholder', '这段参考音频的原文（可选）');uiAttr(text, 'aria-label', `${name} 参考原文`);text.value=slot.reference_text??state.voices.find(v=>v.name===slot.builtin_voice)?.text??'';text.addEventListener('input',()=>slot.reference_text=text.value);select.addEventListener('change',()=>{delete slot.reference_text;text.value=state.voices.find(v=>v.name===slot.builtin_voice)?.text||'';});card.append(text);}
    panel.append(card);
  });
  const actions=node('div','reference-actions');actions.append(button('添加说话人','button secondary small-button',()=>{rows.push({});refresh();}));
  if(rows.length>1)actions.append(button('移除末位说话人','button secondary small-button',()=>{const slot=rows.pop(),key=`speaker_${rows.length}`;slot[`_${key}Revision`]=(slot[`_${key}Revision`]||0)+1;if(slot[`_${key}Url`])URL.revokeObjectURL(slot[`_${key}Url`]);refresh();}));
  actions.append(button('刷新列表','button secondary small-button',event=>runAction(event.currentTarget,async()=>{await refreshReferences();refresh();})),button('管理音频','button secondary small-button',()=>navigate('references')));panel.append(actions);
}

function addReferenceFields(container, profile, {saved=true}={}) {
  if(profile.accepts_voice_reference===false)return;
  const sourceAudio=profile.voice_input_role==='source_audio';
  const values=formValues(),inputs=modelOptions().inputs;
  const sideBySide=state.page==='workspace';
  if(saved&&sideBySide){
    const sources=node('div','reference-sources');
    const library=node('div','reference-library-fields');
    addSavedReferenceInput(library,values,inputs,sourceAudio?'已保存的源音频':'参考音频库');
    const actions=node('div','reference-actions reference-library-actions');
    actions.append(button('刷新列表','button secondary small-button',event=>runAction(event.currentTarget,async()=>{
      await refreshReferences();
      const select=library.querySelector('select');
      fillSelect(select,[{label:state.task==='tts'?'从音频库选择':'选择参考音频',value:''},...state.voices.map(v=>({label:v.label||v.name,value:v.name,raw:true}))],inputs.builtin_voice||'');
      if(inputs.builtin_voice&&!state.voices.some(v=>v.name===inputs.builtin_voice))clearReference(values,inputs);
    })),button('管理音频','button secondary small-button',()=>navigate('references')));
    library.append(actions);
    const audio=node('audio');audio.controls=true;audio.preload='metadata';audio._values=values;audio.dataset.referencePreview='';
    if(inputs.builtin_voice&&values._voiceUrl)audio.src=values._voiceUrl;else audio.hidden=true;
    const playerSlot=node('div','audio-player-slot');playerSlot.append(audio);library.append(playerSlot);
    const upload=node('div','reference-upload-fields');upload.append(referenceUpload(values,inputs,sourceAudio?'要编辑的源音频':'上传或录制参考音频',!!profile.require_voice,!sourceAudio&&profile.send_reference_text!==false));
    sources.append(library,upload);container.append(sources);
  }else if(saved){
    const mode=values._referenceMode||(inputs.builtin_voice?'library':values.voice?'upload':'library'),tabs=node('div','reference-source-tabs');
    for(const [id,label] of [['library','音频库'],['upload','上传 / 录音']]){const control=button(label,`button secondary small-button${id===mode?' active':''}`,()=>{if(values._referenceMode!==id){values._referenceMode=id;renderInputs();}});control.setAttribute('aria-pressed',String(id===mode));tabs.append(control);}
    const library=node('div','reference-library-fields');library.hidden=mode!=='library';addSavedReferenceInput(library,values,inputs,sourceAudio?'已保存的源音频':'使用参考音频库');
    if(inputs.builtin_voice&&values._voiceUrl){const audio=node('audio');audio.controls=true;audio.preload='metadata';audio.src=values._voiceUrl;library.append(audio);}
    library.append(button('管理参考音频','text-button small',()=>navigate('references')));
    const upload=node('div','reference-upload-fields');upload.hidden=mode!=='upload';upload.append(referenceUpload(values,inputs,sourceAudio?'要编辑的源音频':'添加参考音频',!!profile.require_voice,!sourceAudio&&profile.send_reference_text!==false));
    container.append(tabs,library,upload);
  }else container.append(referenceUpload(values,inputs,sourceAudio?'要编辑的源音频':'添加参考音频',!!profile.require_voice,!sourceAudio&&profile.send_reference_text!==false));
  if(!sourceAudio&&profile.send_reference_text!==false)container.append(textInput('reference_text',sideBySide?'音频对应文本':'参考文本',{rows:2,help:'对应参考音频中的原话；自动识别后可校正。'}));
  const controls=referenceControls(values,inputs,{transcribe:!sourceAudio&&profile.send_reference_text!==false,library:saved,inline:sideBySide});
  if(sideBySide){
    const upload=container.querySelector('.reference-upload-fields');
    if(upload){
      const label=upload.querySelector('.field-label'),heading=upload.querySelector('.field-heading')||node('div','field-title-row');
      if(!heading.contains(label)){label.replaceWith(heading);heading.append(label);}
      heading.append(controls.querySelector('.reference-automatic'));
    }
    layoutReferenceSources(container,controls,values,inputs,!sourceAudio&&profile.send_reference_text!==false);
  }
  else{const more=node('details','reference-more');more.append(node('summary','text-button small','识别文本与保存到音频库'),controls);container.append(more);}
}
function layoutReferenceSources(container,controls,values,inputs,transcribe) {
  const sources=container.querySelector('.reference-sources');if(!sources)return;
  sources.classList.add('compact-reference-sources');
  sources.classList.toggle('without-transcript',!transcribe);
  const library=sources.querySelector('.reference-library-fields'),upload=sources.querySelector('.reference-upload-fields');
  const libraryHeading=node('div','reference-card-heading');
  libraryHeading.append(library.querySelector('.field-label'),library.querySelector('.reference-library-actions'));
  const select=library.querySelector('select'),libraryPlayer=library.querySelector('.audio-player-slot');
  const libraryText=node('textarea','reference-library-text');libraryText.readOnly=true;libraryText.rows=2;uiAttr(libraryText, 'placeholder', '参考音频文本');
  uiAttr(libraryText, 'aria-label', '音频库对应文本');libraryText.dataset.referenceTranscript='';libraryText._values=values;
  libraryText.value=inputs.builtin_voice?values.reference_text||'':'';
  const libraryTranscript=node('div','reference-transcript-slot');
  libraryTranscript.append(libraryText);libraryTranscript.hidden=!transcribe;
  const libraryFoot=node('div','reference-footer-slot');libraryFoot.setAttribute('aria-hidden','true');
  replace(library,libraryHeading,select,libraryPlayer,libraryTranscript,libraryFoot);

  const uploadField=upload.firstElementChild,heading=uploadField.querySelector('.field-heading,.field-title-row');
  heading.className='reference-card-heading';heading.querySelector('.field-help')?.remove();heading.querySelector('.required')?.remove();
  uiText(heading.querySelector('.field-label'), '上传 / 录音');
  const zone=uploadField.querySelector('.upload-zone'),actions=zone.querySelector('.upload-actions');
  actions.classList.add('reference-upload-actions');
  const player=zone.querySelector('.audio-player-slot'),uploadStatus=zone.querySelector('.upload-controls');
  libraryPlayer.classList.add('reference-media-slot');player.classList.add('reference-media-slot');
  const textGroup=container.querySelector('[data-input-key="reference_text"]')?.closest('.field-group')||textInput('reference_text','对应文本',{rows:2,values});
  const text=textGroup.querySelector('textarea');text._temporaryReference=true;uiAttr(text, 'placeholder', '');uiAttr(text, 'aria-label', '参考音频原文');text.value=values.voice?values.reference_text||'':'';
  const textHeading=node('div','reference-transcript-heading');
  const status=controls.querySelector('.reference-status'),textActions=controls.querySelector('.reference-actions');
  heading.insertBefore(uploadStatus,heading.querySelector('.reference-automatic'));
  heading.insertBefore(status,heading.querySelector('.reference-automatic'));
  textHeading.append(textActions);
  replace(textGroup,textHeading,text);textGroup.classList.add('reference-transcript-slot');textGroup.hidden=!transcribe;
  const nameGroup=controls.querySelector('.reference-name-row').closest('.field-group');nameGroup.classList.add('reference-footer-slot');
  uiAttr(nameGroup.querySelector('input'), 'placeholder', '例如：温暖男声');
  uiText(nameGroup.querySelector('.reference-save'), '保存到音频库');
  controls.classList.add('temporary-reference-editor');replace(zone,actions,player);
  replace(controls,heading,zone,textGroup,nameGroup);replace(upload,controls);
  if(state.task==='tts'||state.task==='vc'){
    sources.classList.add('tts-reference-sources');
    const libraryBody=node('div','reference-card-body'),toolbar=node('div','reference-library-toolbar');
    toolbar.append(select,libraryHeading.querySelector('.reference-library-actions'));
    libraryBody.append(toolbar,libraryPlayer,libraryTranscript);replace(library,libraryHeading,libraryBody);
    const footer=node('div','reference-upload-footer'),automatic=node('div','reference-automation'),feedback=node('div','reference-feedback');
    feedback.append(uploadStatus,status);automatic.append(heading.querySelector('.reference-automatic'),feedback);
    nameGroup.classList.add('reference-save-fields');footer.append(automatic,nameGroup);
    const uploadBody=node('div','reference-card-body');uploadBody.append(zone,textGroup,footer);
    replace(controls,uploadBody);
    select.setAttribute('aria-labelledby',`${state.task}-reference-library-tab`);
    libraryHeading.remove();
    const tabs=node('div','tts-reference-tabs'),label=node('span','field-label',state.task==='vc'?'目标音色':'参考音频'),group=node('div','tts-reference-group'),tablist=node('div','reference-source-tabs');
    label.id=`${state.task}-reference-label`;group.setAttribute('role','group');group.setAttribute('aria-labelledby',label.id);
    tablist.setAttribute('role','tablist');uiAttr(tablist, 'aria-label', `${sourceText(label)}来源`);
    for(const [mode,label,panel] of [['library','音频库',library],['upload','上传 / 录音',upload]]){
      const tab=button(label,'button secondary small-button reference-source-tab',()=>{
        if((values._referenceMode||'library')===mode)return;
        values._referenceMode=mode;
        for(const audio of tabs.querySelectorAll('audio'))audio.pause();
        syncReferenceControls(values);
      });
      tab.id=`${state.task}-reference-${mode}-tab`;tab.dataset.referenceMode=mode;tab.setAttribute('role','tab');
      panel.id=`${state.task}-reference-${mode}`;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',tab.id);tab.setAttribute('aria-controls',panel.id);
      tablist.append(tab);
    }
    tablist.addEventListener('keydown',event=>{
      const tabs=[...tablist.children],index=tabs.indexOf(document.activeElement);if(index<0)return;
      const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:null;
      if(next===null)return;event.preventDefault();tabs[next].click();tabs[next].focus();
    });
    group.append(tablist,library,upload);tabs.append(label,group);replace(sources,tabs);
    if(state.task==='tts')addSpeakerReferences(tabs);
  }
  sources._values=values;syncReferenceControls(values);
}
function setReferenceText(values,text) {
  values.reference_text=text;values._referenceTextRevision=(values._referenceTextRevision||0)+1;
  for(const input of document.querySelectorAll('[data-input-key="reference_text"]'))if(input._values===values)input.value=input._temporaryReference&&!values.voice?'':text;
}
function referenceSource(values,inputs={}) {if(values._referenceEditing&&values._referenceClip)return {audio:values._referenceClip.id,source:''};if(values._referenceMode==='library')return {audio:'',source:inputs.builtin_voice||values._referenceSource||''};if(values._referenceMode==='upload')return {audio:values.voice||'',source:''};return {audio:values.voice||'',source:values.voice?'':inputs.builtin_voice||values._referenceSource||''};}
function clearReference(values,inputs={}) {
  delete values._referenceClip;values._referenceClipDirty=false;
  inputs.builtin_voice='';values._referenceSource='';values._referencePending=null;values._referenceMessage='';setReferenceText(values,'');syncReferenceControls(values);
  for(const select of document.querySelectorAll('[data-input-key="builtin_voice"]'))if(select._values===inputs)select.value='';
  for(const audio of document.querySelectorAll('[data-reference-preview]'))if(audio._values===values){audio.pause();audio.hidden=!audio.closest('.tts-reference-sources');audio.removeAttribute('src');audio.setAttribute('aria-disabled','true');audio.tabIndex=-1;}
}
function chooseReference(values,inputs,name) {
  const item=state.voices.find(v=>v.name===name);values._voiceRevision=(values._voiceRevision||0)+1;
  if(values._voiceUrl)URL.revokeObjectURL(values._voiceUrl);delete values._voiceBlob;values.voice='';
  inputs.builtin_voice=item?.name||'';values._referenceSource=item?.name||'';values._voiceName=item?.label||item?.name||'';values._voiceUrl=item?.url||'';if(item)values._referenceMode='library';
  values._voiceDuration=item?.duration;delete values._referenceClip;values._referenceClipDirty=false;
  values.reference_name=state.page==='workspace'?'':item?.label||item?.name?.replace(/\.wav$/i,'')||'';values._referencePending=null;values._referenceMessage='';setReferenceText(values,item?.text||'');
}
function addSavedReferenceInput(container,values,inputs,label) {
  if(inputs.builtin_voice&&values._referenceSource!==inputs.builtin_voice)chooseReference(values,inputs,inputs.builtin_voice);
  const select=node('select');select.dataset.inputKey='builtin_voice';select._values=inputs;select.id=`input-${state.task}-builtin_voice`;
  fillSelect(select,[{label:state.task==='tts'?'从音频库选择':'选择参考音频',value:''},...state.voices.map(v=>({label:v.label||v.name,value:v.name,raw:true}))],inputs.builtin_voice||'');
  select.addEventListener('change',()=>{chooseReference(values,inputs,select.value);renderInputs();});container.append(field(label,select));
}
function referenceUpload(values,inputs,label,required=false,autoTranscribe=true) {
  return uploadInput('voice',label,{values,required,help:values._referenceEditing?'原始音频小于20分钟；每个保存条目最多30秒。':'清晰、无背景音乐的单人语音。',
    onClear:()=>clearReference(values,inputs),onUploaded:result=>{
      clearReference(values,inputs);
      values._referenceMode='upload';
      if(!(values.reference_name||'').trim())values.reference_name=result.name.replace(/\.[^.]+$/,'');
      for(const input of document.querySelectorAll('[data-input-key="reference_name"]'))if(input._values===values)input.value=values.reference_name;
      syncReferenceControls(values);
      if(values._referenceEditing){
        values._clipStart=0;values._clipEnd=Math.min(30,Number(result.duration)||30);values._referenceClipDirty=Number(result.duration)>30;
        if(values._referenceClipDirty)values._referenceMessage='请选择不超过30秒的片段，再转录或保存。';
        renderReferenceEditor();
        if(!values._referenceClipDirty&&autoTranscribe&&preference('reference-auto',true))void transcribeReference(values,inputs);
        return true;
      }
      if(autoTranscribe&&preference('reference-auto',true))void transcribeReference(values,inputs);
    }});
}
function syncReferenceControls(values) {
  for(const sources of document.querySelectorAll('.compact-reference-sources'))if(sources._values===values){
    const temporary=!!values.voice;sources.dataset.source=temporary?'upload':values._referenceSource?'library':'';
    sources.querySelector('[data-reference-transcript]').value=temporary?'':values.reference_text||'';
    const editor=sources.querySelector('.temporary-reference-editor');
    const expanded=sources.classList.contains('tts-reference-sources');
    const text=editor.querySelector('textarea');text.disabled=!temporary;text.style.visibility=temporary||expanded?'visible':'hidden';
    editor.querySelector('.reference-footer-slot').style.visibility=temporary||expanded?'visible':'hidden';
    editor.querySelector('.reference-actions').style.visibility=temporary||expanded?'visible':'hidden';
    if(expanded){
      const transcribe=!sources.classList.contains('without-transcript');
      const mode=values._referenceMode||'library';
      for(const tab of sources.querySelectorAll('[role="tab"]')){
        const selected=tab.dataset.referenceMode===mode;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;
        sources.querySelector(`#${tab.getAttribute('aria-controls')}`).hidden=!selected;
      }
      if(state.task==='tts'){
        const voiceMode=sources.querySelector('#param-x_vector_only_mode')?.closest('.field-group');
        const player=sources.querySelector(`#tts-reference-${mode} .reference-media-slot`);
        if(voiceMode&&player){voiceMode.classList.add('reference-voice-mode');if(voiceMode.parentElement!==player)player.append(voiceMode);}
        const options=sources.querySelector('.tts-reference-options');if(options)options.hidden=!options.childElementCount;
      }
      const library=sources.querySelector('.reference-library-fields'),selected=!!values._referenceSource&&!temporary;
      library.querySelector('.reference-media-slot').hidden=false;
      library.querySelector('.reference-transcript-slot').hidden=!transcribe;
      library.querySelector('textarea').disabled=!selected;
      editor.querySelector('.reference-media-slot').hidden=false;
      editor.querySelector('.reference-transcript-slot').hidden=!transcribe;
      editor.querySelector('.reference-footer-slot').hidden=false;
      editor.querySelector('[data-input-key="reference_name"]').disabled=!temporary;
      editor.querySelector('.reference-retry').disabled=!temporary||state.referenceJob?.values===values;
      for(const [audio,enabled] of [[library.querySelector('audio'),selected],[editor.querySelector('audio'),temporary]]){
        audio.hidden=false;audio.setAttribute('aria-disabled',String(!enabled));audio.tabIndex=enabled?0:-1;
      }
    }
    const uploadStatus=sources.querySelector('.upload-controls');uploadStatus.style.visibility=temporary||state.uploading||state.recorders.size?'visible':'hidden';
  }
  for(const panel of document.querySelectorAll('.reference-controls'))if(panel._values===values){
    if(state.referenceJob?.values===values||values._referencePending){const more=panel.closest('.reference-more');if(more)more.open=true;}
    const active=state.referenceJob?.values===values;
    const status=panel.querySelector('.reference-status');uiText(status, plainMessage(active&&state.referenceJob.cancelling?'正在停止任务…':panel.classList.contains('temporary-reference-editor')&&active?'识别中…':values._referenceMessage));uiAttr(status, 'title', plainMessage(values._referenceMessage));
    panel.querySelector('.reference-adopt').hidden=!values._referencePending;
    const stop=panel.querySelector('.reference-stop');stop.hidden=!active;stop.disabled=active&&!!state.referenceJob.cancelling;
  }
  for(const save of document.querySelectorAll('.reference-save'))if(save._values===values)save.disabled=state.referenceJob?.values===values||values._referenceClipDirty||!!values._clipRequest||!!save.closest('.tts-reference-sources')&&!values.voice;
  if(values._referenceEditing)for(const panel of document.querySelectorAll('#reference-editor .reference-controls'))if(panel._values===values)panel.querySelector('.reference-retry').disabled=!!values._referenceClipDirty||!!values._clipRequest||state.referenceJob?.values===values;
  if(state.task==='tts'&&state.detail?.family==='irodori_tts'){
    const input=$('param-no_ref');let options;try{options=collectOptions();}catch{}
    if(input&&options&&!Object.hasOwn(options,'no_ref'))input.checked=!(values._referenceMode==='upload'?values.voice:modelOptions().inputs.builtin_voice);
  }
}
function referenceNameRow(values,inputs={},inline=false) {
  const group=textInput('reference_name',inline?'音频名称':'保存名称',{values,placeholder:'例如：温暖男声'});
  const input=group.querySelector('input'),row=node('div','reference-name-row');
  const save=button('保存','button secondary small-button reference-save',event=>runAction(event.currentTarget,()=>saveReference(values,inputs)));
  save._values=values;save.disabled=state.referenceJob?.values===values;
  input.replaceWith(row);row.append(input,save);return group;
}
function referenceControls(values,inputs={}, {transcribe=true,library=false,inline=false}={}) {
  const panel=node('div',`reference-controls${inline?' reference-controls-inline':''}`);panel._values=values;
  const actions=node('div','reference-actions');const retry=button('音频转录','button secondary small-button reference-retry',()=>transcribeReference(values,inputs));retry.hidden=!transcribe;
  const automatic=node('label','check-label reference-automatic');uiAttr(automatic, 'title', library?'30秒内的音频上传后自动识别；较长音频裁剪后识别片段文本':'上传或录音完成后，自动识别音频对应文本');const check=node('input');check.type='checkbox';check.checked=preference('reference-auto',true);check.addEventListener('change',()=>savePreference('reference-auto',check.checked));automatic.append(check,node('span','',inline?'自动识别':'自动识别文本'));automatic.hidden=!transcribe;
  const stop=button('停止识别','button subtle small-button reference-stop',()=>{const job=state.referenceJob;if(job?.values!==values||job.cancelling)return;job.cancelling=true;state.referenceNext=null;values._referenceMessage='正在停止任务…';syncReferenceControls(values);if(job.id)void cancelReference(job);});stop.hidden=state.referenceJob?.values!==values;stop.disabled=state.referenceJob?.values===values&&!!state.referenceJob.cancelling;
  const adopt=button('采用识别文本','button secondary small-button reference-adopt',()=>{if(values._referencePending){setReferenceText(values,values._referencePending);values._referencePending=null;values._referenceMessage='';syncReferenceControls(values);}});adopt.hidden=!values._referencePending;
  const status=node('p','field-help reference-status',plainMessage(values._referenceMessage));status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  actions.append(automatic,retry,stop,adopt);
  actions.hidden=inline&&!transcribe;
  const manage=button('管理参考音频','text-button small',()=>navigate('references'));if(!library)actions.append(manage);
  panel.append(actions,referenceNameRow(values,inputs,inline),status);return panel;
}
async function cancelReference(record) {
  if(record.cancelSent)return;record.cancelSent=true;
  try{await api(`/jobs/${encodeURIComponent(record.id)}/cancel`,{method:'POST',body:{}});}
  catch(error){if(state.referenceJob===record){record.cancelling=false;record.cancelSent=false;record.values._referenceMessage=friendlyError(error);syncReferenceControls(record.values);}showToast(friendlyError(error));}
}
async function transcribeReference(values,inputs={}) {
  if(values._referenceEditing&&(values._referenceClipDirty||values._clipRequest)){values._referenceMessage='请先裁剪出不超过30秒的参考片段。';syncReferenceControls(values);return;}
  const source=referenceSource(values,inputs),revision=values._voiceRevision,textRevision=values._referenceTextRevision||0;
  if(!source.audio&&!source.source){values._referenceMessage='请先上传、录制或选择参考音频。';syncReferenceControls(values);return;}
  if(state.referenceJob){values._referenceMessage='等待上一段参考音频识别结束…';syncReferenceControls(values);state.referenceNext=()=>{if(values._voiceRevision===revision&&(values._referenceTextRevision||0)===textRevision)void transcribeReference(values,inputs);};return;}
  if(state.job||state.loading||state.submitting||state.runtime?.busy||state.runtime?.realtime_active||state.realtime?.active){values._referenceMessage='当前任务结束后，请点击音频转录。';syncReferenceControls(values);return;}
  const record={values,id:null};state.referenceJob=record;values._referencePending=null;values._referenceMessage='正在使用 Qwen3-ASR 0.6B 识别参考文本…';syncReferenceControls(values);updateRunButton();
  try{
    const created=await api('/reference-transcriptions',{method:'POST',body:source});record.id=created.id;if(record.cancelling)void cancelReference(record);
    let job;
    while(true){job=await api(`/jobs/${encodeURIComponent(record.id)}`);if(['done','error','cancelled'].includes(job.status))break;await new Promise(resolve=>setTimeout(resolve,500));}
    if(values._voiceRevision!==revision)return;
    if(job.status==='done'&&job.text){
      if((values._referenceTextRevision||0)===textRevision){setReferenceText(values,job.text);values._referenceMessage='';}
      else{values._referencePending=job.text;values._referenceMessage='识别完成；已保留你修改的文字，可点击采用识别文本。';}
    }else values._referenceMessage=job.status==='cancelled'?'任务已停止。':job.status==='done'?'没有识别到文字，可点击音频转录或手动填写。':job.message||'识别失败，请重试或手动填写。';
  }catch(error){if(values._voiceRevision===revision)values._referenceMessage=friendlyError(error);}
  finally{state.referenceJob=null;syncReferenceControls(values);await pollStatus();updateRunButton();const next=state.referenceNext;state.referenceNext=null;next?.();}
}
async function saveReference(values,inputs={}) {
  if(values._referenceEditing&&(values._referenceClipDirty||values._clipRequest))throw new Error('请先裁剪出不超过30秒的参考片段。');
  if(state.referenceJob?.values===values)throw new Error('请等待参考文本识别完成，或先停止识别。');
  const source=referenceSource(values,inputs),revision=values._voiceRevision,name=(values.reference_name||'').trim();
  if(!source.audio&&!source.source)throw new Error('请先上传、录制或选择参考音频。');
  if(!name)throw new Error('请填写保存名称。');
  const body={...source,name,text:values.reference_text||'',overwrite:true};
  const result=await api('/references',{method:'POST',body});
  state.voices=result.voices||[];renderReferenceList();
  if(values._voiceRevision===revision){if(values._referenceEditing){values.reference_name='';if(state.page==='references'&&state.referenceValues===values)renderReferenceEditor();}else{chooseReference(values,inputs,result.name);if(state.page==='workspace'&&formValues()===values)renderInputs();}}
  showToast(result.message||'参考音频已保存。');
}
async function refreshReferences() {const data=await api('/voices');state.voices=data.voices||[];renderReferenceList();}
function invalidateReferenceClip(values) {
  values._voiceRevision=(values._voiceRevision||0)+1;delete values._referenceClip;values._referenceClipDirty=true;values._referencePending=null;setReferenceText(values,'');
  values._referenceMessage='裁剪范围已改变，请重新裁剪片段。';
  const job=state.referenceJob;if(job?.values===values&&!job.cancelling){job.cancelling=true;state.referenceNext=null;if(job.id)void cancelReference(job);}
  const preview=$('reference-editor').querySelector('.reference-clip-preview');if(preview){preview.querySelector('audio')?.pause();preview.hidden=true;}
  syncReferenceControls(values);
}
async function prepareReferenceClip(values) {
  const start=Number(values._clipStart),end=Number(values._clipEnd);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end-start>30)throw new Error('请选择有效的起止时间，片段长度最多30秒。');
  const duration=Number(values._voiceDuration);if(Number.isFinite(duration)&&duration>0&&end>duration)throw new Error('结束时间不能超过原始音频时长。');
  invalidateReferenceClip(values);const request={revision:values._voiceRevision};values._clipRequest=request;values._referenceMessage='正在裁剪片段…';syncReferenceControls(values);
  try{
    const source=values.voice?{audio:values.voice,source:''}:{audio:'',source:values._referenceSource||''};
    const clip=await api('/reference-clips',{method:'POST',body:{...source,start_seconds:start,end_seconds:end}});
    if(values._voiceRevision!==request.revision||state.referenceValues!==values)return;
    values._referenceClip=clip;values._referenceClipDirty=false;values._referenceMessage='片段已就绪。';
  }catch(error){if(values._voiceRevision===request.revision)values._referenceMessage=friendlyError(error);throw error;
  }finally{
    if(values._clipRequest===request)delete values._clipRequest;
    if(state.page==='references'&&state.referenceValues===values)renderReferenceEditor();
  }
  if(values._referenceClip&&preference('reference-auto',true))void transcribeReference(values);
}
function referenceClipEditor(values) {
  const editor=node('div','ref-clip-editor');if(!values.voice&&!values._referenceSource)return editor;
  const duration=Number(values._voiceDuration);if(values._clipStart==null)values._clipStart=0;if(values._clipEnd==null)values._clipEnd=Math.min(30,duration||30);
  if(!values._referenceClip&&duration>30)values._referenceClipDirty=true;
  const range=node('div','reference-clip-range');
  for(const [key,label] of [['_clipStart','开始（秒）'],['_clipEnd','结束（秒）']]){
    const input=node('input');input.type='number';input.min=0;input.step=.01;input.value=values[key];if(duration>0)input.max=duration;input.dataset.clipRange=key;uiAttr(input, 'aria-label', label);
    input.addEventListener('input',()=>{values[key]=input.value;invalidateReferenceClip(values);});range.append(field(label,input));
  }
  const apply=button('裁剪片段','button secondary small-button',event=>runAction(event.currentTarget,()=>prepareReferenceClip(values)));apply.disabled=!!values._clipRequest;range.append(apply);editor.append(range,node('p','field-help','每个片段最多30秒；保存后可继续从原始音频裁剪。'));
  if(values._referenceClip){const preview=node('div','reference-clip-preview'),audio=node('audio');audio.controls=true;audio.preload='metadata';audio.src=values._referenceClip.url;preview.append(node('span','field-label','当前片段'),audio);editor.append(preview);}
  return editor;
}
function renderReferenceEditor() {
  const values=state.referenceValues ||= {};values._referenceEditing=true;replace($('reference-editor'),
    referenceUpload(values,{},'原始音频'),
    referenceClipEditor(values),
    textInput('reference_text','参考文本',{values,rows:4,help:'对应音频中的原话；自动识别使用 Qwen3-ASR 0.6B，结果可校正。'}),
    referenceControls(values,{}, {library:true}));
  $('reference-editor').querySelector('.upload-zone audio')?.classList.add('reference-original-preview');syncReferenceControls(values);
}
function renderReferenceList() {
  const query=$('reference-search').value.trim().toLowerCase();const items=state.voices.filter(v=>`${v.label||v.name} ${v.text||''}`.toLowerCase().includes(query));
  uiText($('reference-count'), `${state.voices.length} 段参考音频`);
  replace($('reference-list'),...items.map(item=>{
    const row=node('section','reference-row');row.dataset.reference=item.name;
    const top=node('div','reference-row-heading');top.append(rawNode('strong','',item.label||item.name));
    const actions=node('div','reference-actions');actions.append(button('编辑','button secondary small-button',()=>{stopRecordings();const values={};chooseReference(values,{},item.name);state.referenceValues=values;renderReferenceEditor();$('reference-editor').scrollIntoView({behavior:'smooth',block:'start'});}),button('删除','button subtle small-button',event=>runAction(event.currentTarget,async()=>{
      if(!window.confirm(t(`确定删除参考音频“${item.label||item.name}”及其参考文本？`)))return;
      const result=await api(`/references/${encodeURIComponent(item.name)}`,{method:'DELETE'});state.voices=result.voices||[];
      for(const ws of Object.values(state.workspaces)){for(const options of Object.values(ws.options))if(options.inputs.builtin_voice===item.name)options.inputs.builtin_voice='';if(ws.forms._referenceSource===item.name){chooseReference(ws.forms,{},'');}}
      if(state.referenceValues?._referenceSource===item.name){state.referenceValues._voiceRevision++;state.referenceValues={};renderReferenceEditor();}renderReferenceList();showToast(result.message);
    })));
    top.append(actions);row.append(top);if(item.url){const audio=node('audio');audio.controls=true;audio.preload='none';audio.src=item.url;row.append(audio);}row.append(item.text?rawNode('p','reference-transcript',item.text):node('p','reference-transcript','未填写参考文本'));return row;
  }),items.length?null:node('p','muted small',query?'没有匹配的参考音频。':'上传或录制一段参考音频，校正文本后保存。'));
}
$('reference-search').addEventListener('input',renderReferenceList);
$('refresh-references').addEventListener('click',event=>runAction(event.currentTarget,refreshReferences));
$('new-reference').addEventListener('click',()=>{stopRecordings();if(state.referenceValues)state.referenceValues._voiceRevision++;state.referenceValues={};renderReferenceEditor();});

function musicInputCapabilities() {
  const capabilities=state.detail?.music_inputs||{};
  let options=state.overrides;try{options=collectOptions();}catch{}
  const route=options.task_route??state.detail?.parameters?.find(p=>p.name==='task_route')?.default;
  const rule=capabilities.ace_step?.routes?.[route];
  return {...capabilities,source_audio:rule?rule.source:capabilities.source_audio&&(!capabilities.source_audio_routes||capabilities.source_audio_routes.includes(route)),require_source_audio:rule?!!rule.required:capabilities.require_source_audio||capabilities.source_required_routes?.includes(route),
    ...(rule?{lyrics:rule.lyrics==='optional'?!!(modelOptions().inputs._musicLyrics??formValues().lyrics):!!rule.lyrics,optional_lyrics:rule.lyrics==='optional'}:{})};
}
const ACE_SOURCE_FIELDS=['source_caption','source_lyrics'];
const ACE_MAIN_FIELDS=['complete_track_classes','track_name','repainting_start','repainting_end'];
function aceRoute(options){if(!options){try{options=collectOptions();}catch{options=state.overrides;}}return options.task_route??state.detail?.parameters?.find(p=>p.name==='task_route')?.default??'text2music';}
function aceParameterRoutes(){return state.detail?.music_inputs?.ace_step?.parameter_routes||{};}
function aceGuidanceAvailable(options){const variant=options['load_options.ace_step.dit_model_path']||options.load_options?.['ace_step.dit_model_path']||state.detail?.music_inputs?.ace_step?.dit_variant;return aceRoute(options)!=='remix'&&(!variant||!variant.includes('turbo'));}
function setModelOption(key,value){
  const saved=modelOptions();if(value===undefined)delete saved.values[key];else saved.values[key]=value;
  const aliases=state.task==='vc'?Object.entries(state.detail?.vc_controls?.aliases||{}).filter(([,name])=>name===key).map(([alias])=>alias):[];
  for(const alias of aliases)delete saved.values[alias];
  try{
    const extra=JSON.parse(saved.json||'{}');if(!extra||typeof extra!=='object'||Array.isArray(extra))return;
    const [scope,...parts]=key.split('.'),nested=parts.join('.');let changed=false;
    for(const [object,name] of [[extra,key],...aliases.map(alias=>[extra,alias]),...(['session_options','load_options'].includes(scope)?[[extra[scope],nested]]:[])]){
      if(object&&Object.hasOwn(object,name)){if(value===undefined)delete object[name];else object[name]=value;changed=true;}
    }
    if(changed){saved.json=JSON.stringify(extra,null,2);$('options-json').value=saved.json;}
  }catch{}
}
function musicSourceChanged(key){
  const target=workspace(key),forms=target.forms;
  for(const saved of Object.values(target.options)){
    delete saved.musicAnalysisPending;delete saved.musicEdited;
    const keys=[...ACE_SOURCE_FIELDS,'repainting_start','repainting_end'];
    for(const key of keys)delete saved.values[key];
    try{const extra=JSON.parse(saved.json||'{}');for(const key of keys)delete extra[key];saved.json=Object.keys(extra).length?JSON.stringify(extra,null,2):'';}catch{}
    if(forms.audio&&Number(forms._audioDuration)>0){saved.values.repainting_start=0;saved.values.repainting_end=Math.floor(forms._audioDuration*100)/100;}
  }
  if(state.key===key){$('options-json').value=modelOptions().json;renderInputs();renderParameters();updateRunButton();}return true;
}
function aceMusicEditing(){return state.task==='music'&&state.detail?.family==='ace_step'&&musicInputCapabilities().source_audio;}
function musicDurationControl(){
  const group=node('div','music-duration-control'),duration=Number(formValues()._audioDuration),output=node('output','',duration>0?`${duration.toFixed(2)} 秒`:'等待源音频');output.id='music-source-duration';group.append(field('源音频时长',output));
  return group;
}
function musicRouteControls(context,source){
  const group=node('div','music-route-controls'),route=aceRoute();
  for(const name of ACE_MAIN_FIELDS){const p=context.find(p=>p.name===name);if(!p||!aceParameterRoutes()[name]?.includes(route))continue;group.append(parameterControl({...p,...(name.startsWith('repainting_')?{max:formValues()._audioDuration}:{} )}));}
  if(['repaint','lego'].includes(route)){
    const audio=source?.querySelector('audio');
    const play=button('试听选区','button secondary small-button',async()=>{
      try{const opts=collectOptions(),start=Number(opts.repainting_start),end=Number(opts.repainting_end);validateMusicRange(opts);audio.currentTime=start;await audio.play();audio.ontimeupdate=()=>{if(audio.currentTime>=end){audio.pause();audio.ontimeupdate=null;}};}catch(error){showToast(friendlyError(error));}
    });play.id='music-preview-range';play.disabled=!formValues().audio;group.append(play);
  }
  const music=musicInputCapabilities();if(music.optional_lyrics){const check=node('input');check.type='checkbox';check.checked=music.lyrics;check.id='music-use-lyrics';check.addEventListener('change',()=>{modelOptions().inputs._musicLyrics=check.checked;renderInputs();renderParameters();});const label=node('label','check-label');label.htmlFor=check.id;label.append(check,node('span','','填写歌词'));group.append(label);}
  return group;
}
function validateMusicRange(options){
  const start=Number(options.repainting_start),end=Number(options.repainting_end),duration=Number(formValues()._audioDuration);
  if(options.repainting_start==null||options.repainting_end==null||!Number.isFinite(start)||!Number.isFinite(end)||!(duration>0)||start<0||end<=start||end>duration)throw new Error('请选择有效的音频区间：开始时间须小于结束时间，且不超过源音频时长。');
}
function musicRequestOptions(options,inputs){
  if(state.detail?.family!=='ace_step')return options;
  const out={...options},route=aceRoute(options);out.task_route=route;
  for(const [name,routes] of Object.entries(aceParameterRoutes()))if(!routes.includes(route))delete out[name];
  if(!aceGuidanceAvailable(out))delete out.guidance_scale;
  if(inputs.audio){delete out.audio_codes;delete out.audio_code_string;delete out.duration_seconds;if(['complete','lego'].includes(route))out.thinking=false;}
  delete out.flow_edit_morph;
  if(route==='repaint'){
    out.repaint_mode??='balanced';
    if(out.repaint_mode==='custom'){delete out.repaint_strength;out.repaint_crossfade_frames??=10;out.repaint_injection_ratio??=0.5;}
    else{delete out.repaint_crossfade_frames;delete out.repaint_injection_ratio;if(out.repaint_mode==='balanced')out.repaint_strength??=0.5;else delete out.repaint_strength;}
  }
  return out;
}
function musicTargetField(key,label,sourceKey,rows){
  const group=textInput(key,label,{rows}),labelEl=group.querySelector('.field-label'),heading=node('div','music-editor-heading');
  const copy=button(key==='lyrics'?'沿用原歌词':'沿用原曲提示','text-button',()=>{
    let value;try{value=collectOptions()[sourceKey]??'';}catch(error){showToast(friendlyError(error));return;}
    const input=group.querySelector('textarea');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  labelEl.replaceWith(heading);heading.append(labelEl,copy);return group;
}
function renderMusicAnalysisChoice(container){
  const saved=modelOptions(),pending=saved.musicAnalysisPending;
  if(!pending||pending.audio!==formValues().audio||pending.parameterValues!==saved.values)return;
  const row=node('div','music-analysis-choice');row.append(node('span','','原曲信息已有修改'));
  row.append(button('保留修改','text-button',()=>{delete saved.musicAnalysisPending;renderInputs();renderParameters();}));
  row.append(button('采用分析结果','text-button',()=>{
    let extra;try{extra=JSON.parse(saved.json||'{}');if(!extra||typeof extra!=='object'||Array.isArray(extra))throw new Error('高级参数必须是 JSON 对象。');}catch(error){showToast(friendlyError(error));return;}
    for(const [name,value] of Object.entries(pending.values)){saved.values[name]=value;if(Object.hasOwn(extra,name))extra[name]=value;delete saved.musicEdited?.[name];}
    saved.json=Object.keys(extra).length?JSON.stringify(extra,null,2):'';delete saved.musicAnalysisPending;$('options-json').value=saved.json;renderInputs();renderParameters();
  }));
  container.append(row);
}
function renderInputs() {
  // Build native audio controls once the startup catalog and model detail are ready.
  if(initializing)return;
  stopRecordings();
  const common=$('common-options'),commonHeading=$('common-options-heading'),actions=document.querySelector('.task-action-bar'),generate=document.querySelector('.generate-row'),result=document.querySelector('#workspace-grid .result-card'),resultHeading=$('result-heading');
  actions.append(generate,$('asr-notice'));
  $('task-form').append(actions);$('workspace-grid').append(result);
  result.querySelector('.result-title').prepend(resultHeading);
  resultHeading.hidden=['tts','design','vc','music'].includes(state.task);
  if(state.task==='asr')$('job-status').after($('copy-result'),$('export-result'));
  else result.querySelector('.result-actions').prepend($('copy-result'),$('export-result'));
  uiText($('export-result'), state.task==='asr'?'下载文件':'导出文本');
  actions.prepend(commonHeading,common);
  const container=$('task-inputs');replace(container);
  const detail=state.detail,profile=detail?.profile||{},task=state.task,actual=modelTask(detail||{});
  const primary=node('div','task-primary form-fields'),secondary=node('div','task-reference form-fields');
  const aceEdit=aceMusicEditing();let musicHeader;
  $('page-workspace').classList.toggle('ace-music-edit',!!aceEdit);
  if(task==='tts'||task==='design'){
    if(task==='design')secondary.append(textInput('instruct','声音描述',{rows:3,required:true,placeholder:'例如：温暖、低沉的成年男声，语气平静。'}));
    primary.append(textInput('text',task==='tts'?'合成文本':'试听文本',{rows:13,required:true}));
    if(task==='tts'&&(!detail||detail.voice_mode!=='builtin')&&profile.accepts_voice_reference!==false)addReferenceFields(secondary,profile);
  }else if(task==='asr'){
    primary.append(uploadInput('audio','转录文件',{required:true}));
  }else if(task==='music'){
    const music=musicInputCapabilities();
    const context=visibleParameters(),tags=context.find(p=>p.name==='tags'),route=context.find(p=>p.name==='task_route');
    if(detail?.family==='ace_step'){
      musicHeader=node('div','music-source-section');
      if(route){const toolbar=node('div','music-route-toolbar');toolbar.append(parameterControl(route));musicHeader.append(toolbar);}
    }
    if(aceEdit){
      primary.append(node('h3','music-editor-title',['cover','cover-nofsq','remix'].includes(aceRoute())?'原曲信息':'分析参考'));
      secondary.append(node('h3','music-editor-title','目标版本'));
      for(const [name,label,lines] of [['source_caption','源音频提示',3],['source_lyrics','源音频歌词',12]]){
        if(name==='source_lyrics'&&!music.lyrics)continue;
        const param=context.find(p=>p.name===name)||{name,type:'text',default:''};
        primary.append(parameterControl({...param,label,lines}));
      }
      secondary.append(musicTargetField('text','目标提示','source_caption',3));
      if(music.lyrics)secondary.append(musicTargetField('lyrics','目标歌词','source_lyrics',12));
    }else{
      if(tags)primary.append(parameterControl(tags));
      const description=textInput('text',music.text_label||'音乐或音效描述',{rows:music.text_role==='lyrics'?7:3,required:music.text_role==='lyrics'||music.text_role==='instruction',placeholder:music.text_role==='lyrics'?'':music.text_role==='instruction'?'描述希望如何修改音乐…':'例如：轻快的流行音乐，温暖的钢琴，明亮的节奏。'});
      if(route&&!musicHeader){const label=description.querySelector('.field-label'),heading=node('div','input-context-heading');label.replaceWith(heading);heading.append(label,parameterControl(route));}
      (music.text_role==='lyrics'?secondary:primary).append(description);
      if(music.lyrics)secondary.append(textInput('lyrics','歌词',{rows:7,required:!!music.require_lyrics}));
    }
    if(music.source_audio){
      const sourceWorkspace=state.key;
      const source=uploadInput('audio',music.require_source_audio?'源音频':'源音频（可选）',{required:!!music.require_source_audio,
        onUploaded:()=>{if(aceEdit)return musicSourceChanged(sourceWorkspace);},
        onClear:()=>{if(aceEdit)musicSourceChanged(sourceWorkspace);}});
      if(detail?.family==='ace_step'){const analyze=button('分析源音频','button secondary small-button',()=>submitTask('analyze_source'));analyze.id='analyze-music-source';analyze.disabled=$('run-button').disabled||!formValues().audio;source.querySelector('.upload-actions').append(analyze);}
      musicHeader ||= node('div','music-source-section');
      const columns=node('div','music-source-options'),sourceColumn=node('div','music-source-column form-fields'),creation=node('section','music-creation-options');
      creation.setAttribute('aria-labelledby','common-options-heading');
      sourceColumn.append(source);creation.append(commonHeading);
      if(aceEdit){creation.append(musicRouteControls(context,source));renderMusicAnalysisChoice(sourceColumn);}
      creation.append(common);columns.append(sourceColumn,creation);musicHeader.append(columns);
    }
  }else if(task==='vc'||task==='processing'){
    primary.append(uploadInput('audio',task==='vc'?'要转换的源音频':'要处理的源音频',{required:true}));
    if(detail?.voice_mode==='rvc'||profile.model_as_target_voice){
      secondary.classList.add('paired-inputs');
      secondary.append(uploadInput('rvc_voice_model','RVC 声音模型（可选）',{accept:'.pth,.pt',record:false,fallback:{key:'rvc_use_builtin',label:'使用内置音色',chooseLabel:'选择 RVC 文件',help:'勾选时使用右侧选择的内置音色；已上传的自定义模型会保留。'}}));
      secondary.append(uploadInput('rvc_retrieval_index','RVC 检索索引（可选）',{accept:'.index',record:false,fallback:{key:'rvc_no_index',label:'不使用音色索引',chooseLabel:'选择 RVC 索引文件',help:'勾选时关闭索引融合；取消后可调整目标音色融合比例，内置音色可使用自带索引。'}}));
    }
    else if((task==='vc'||detail)&&profile.accepts_voice_reference!==false){addReferenceFields(secondary,{...profile,require_voice:profile.require_vc_target,send_reference_text:false});}
  }else if(task==='separation'){
    primary.append(uploadInput('audio','要分离的音频',{required:true}));
    if(profile.require_separation_prompt||detail?.family==='sam_audio')secondary.append(textInput('text','想提取什么声音',{rows:2,required:true,placeholder:'例如：说话的人声、狗叫声、钢琴声。'}));
  }else if(task==='analysis'){
    primary.append(uploadInput('audio','要分析的音频',{required:true}));
    if((actual||state.analysisType)==='align')secondary.append(textInput('transcript','音频原文',{rows:4,required:true}));
  }
  if(task==='tts'||task==='design'||task==='vc'){
    const sources=(task==='vc'?null:secondary.querySelector('.reference-sources'))||node('div');sources.classList.add('tts-workflow-columns');
    const left=node('div','tts-main-column'),right=node('div','tts-side-column');
    if(task==='vc'){
      left.append(primary);if(secondary.childElementCount)left.append(secondary);
    }else{
      left.append(...sources.querySelectorAll('.tts-reference-tabs'));
      if(task==='design')left.append(secondary);
      if(task==='tts'){const referenceOptions=node('div','tts-reference-options');referenceOptions.id='tts-reference-options';referenceOptions.append(...visibleParameters().filter(p=>p.placement==='reference').map(parameterControl));referenceOptions.hidden=!referenceOptions.childElementCount;left.append(referenceOptions);}
      left.append(primary);
    }
    const resultSection=node('div','tts-result-section');resultSection.append(actions,result);
    right.append(commonHeading,common,resultSection);
    replace(sources,left,right);container.append(sources);
  }
  else if(aceEdit){
    const columns=node('div','music-ace-editor');columns.append(primary,secondary);
    container.append(musicHeader,columns,actions,result);
  }
  else if(task==='music'){
    const columns=node('div','music-workflow-columns'),left=node('div','music-controls-column'),right=node('div','music-output-column');
    const resultSlot=node('div','music-result-slot');resultSlot.append(result);
    left.append(primary,actions);if(secondary.childElementCount)right.append(secondary);right.append(resultSlot);
    columns.append(left,right);if(musicHeader)container.append(musicHeader);container.append(columns);
  }
  else{container.append(primary);if(secondary.childElementCount)container.append(secondary);}
  container.classList.toggle('single-input',!secondary.childElementCount);
  syncReferenceControls(formValues());
  uiText($('task-title'), taskInfo().label);
}

function sameModelPath(a,b) {const normalize=value=>String(value||'').replace(/\\/g,'/').replace(/\/$/,'');const left=normalize(a),right=normalize(b);return /^[a-z]:\//i.test(left)?left.toLowerCase()===right.toLowerCase():left===right;}
function modelChoice(param,value) {return value&&(param.model_choices||[]).find(m=>sameModelPath(m.value,value)||sameModelPath(m.install_path,value));}
function validateModelChoices(options,detail=state.detail) {
  const runtime=runtimeOptions(options);
  for(const param of detail?.parameters||[]){
    if(param.scope&&param.scope!=='request'&&!param.model_choices){
      const [scope,...parts]=param.name.split('.'),value=runtime[scope]?.[parts.join('.')],choices=param.choices||param.values;
      if(value!=null&&value!==''&&choices?.length&&!choicesOf(choices).some(choice=>String(choice.value)===String(value)))throw new Error(`${param.label}不支持 ${value}，请使用当前模型提供的选项。`);
    }
    if(!param.model_choices)continue;
    const [scope,...parts]=param.name.split('.'),value=runtime[scope]?.[parts.join('.')];
    const selected=modelChoice(param,value);
    if(selected&&!selected.installed)throw new Error(`强制对齐模型尚未安装完整：请在模型中心下载 ${selected.label}，再选择并应用重载。`);
  }
}
function parameterControl(param) {
  const values=state.overrides,key=param.name;const modified=Object.hasOwn(values,key);
  const runtime=!!param.scope&&param.scope!=='request',runtimeBool=runtime&&['bool','boolean'].includes(param.type);
  let route;if(param.route_defaults){try{route=collectOptions().task_route;}catch{route=values.task_route;}}
  let current=modified?values[key]:(param.route_defaults?.[route]??param.default);
  const ace=state.task==='music'&&state.detail?.family==='ace_step';
  if(ace||['tts','asr','design','vc'].includes(state.task)){try{current=collectOptions()[key]??current;}catch{}}
  if(runtime){
    current=modified?values[key]:(runtimeBool||param.choices?.length||param.values?.length?undefined:param.default);
    try{const [scope,...parts]=key.split('.');current=runtimeOptions(collectOptions())[scope]?.[parts.join('.')]??current;}catch{}
  }
  if(state.task==='tts'&&state.detail?.family==='irodori_tts'&&key==='no_ref'){
    try{if(!Object.hasOwn(collectOptions(),key))current=!(formValues()._referenceMode==='upload'?formValues().voice:modelOptions().inputs.builtin_voice);}catch{}
  }
  const type=param.type,designLanguage=state.task==='design'&&key==='language';let input,choices=param.choices||param.values;
  const voiceLanguages=state.task==='tts'&&key==='voice'?state.detail?.tts_controls?.voice_languages:null;
  if(voiceLanguages){
    let language=fieldValues('language').language;try{language=collectOptions().language??language;}catch{}
    if(language)choices=choicesOf(choices).filter(choice=>voiceLanguages[choice.value]===language);
    let explicit=modified;try{explicit=Object.hasOwn(collectOptions(),key);}catch{}
    if(explicit&&voiceLanguages[current]&&language&&voiceLanguages[current]!==language)choices.unshift({label:`${current}（语言不匹配）`,value:current});
    if(choices?.length&&!choicesOf(choices).some(choice=>choice.value===current))current=choicesOf(choices)[0].value;
  }
  if(designLanguage&&!choices?.length){
    const mapping=state.detail?.profile?.lang_map||{};
    choices=(state.detail?.languages||[]).map(value=>mapping[String(value).toLowerCase()]??value);
    if(choices.length&&param.default!=null&&!choices.includes(param.default))choices.unshift(param.default);
  }
  if(param.model_choices){try{const [scope,...parts]=key.split('.');current=runtimeOptions(collectOptions())[scope]?.[parts.join('.')]??current;}catch{}}
  if(ace&&type==='multiselect'){
    const group=node('fieldset','field-group music-track-choices');group.id=`param-${key}`;group.append(node('legend','field-label',param.label||'补全声部'));
    const selected=Array.isArray(current)?current:String(current||'').split(',').map(x=>x.trim());
    for(const [label,value] of state.detail.music_inputs?.ace_step?.tracks||[]){const check=node('input');check.type='checkbox';check.value=value;check.checked=selected.includes(value);const row=node('label','check-label');row.append(check,node('span','',label));group.append(row);check.addEventListener('change',()=>{setModelOption(key,[...group.querySelectorAll('input:checked')].map(el=>el.value));updateRunButton();});}
    return group;
  }
  const rows=Number(param.lines??param.rows??(state.task==='music'&&key==='tags'?3:1));
  if(param.model_choices){
    input=node('select');const empty=node('option','','不使用');empty.value='';input.append(empty);
    const selected=modelChoice(param,current);
    for(const model of param.model_choices){const option=node('option','',`${model.label} · ${model.installed?'已安装':model.incomplete?'未安装完整':'未安装'}`);option.value=model===selected?current:model.value;option.disabled=!model.installed;input.append(option);}
    if(current&&!selected){const option=node('option','','当前配置（自定义模型）');option.value=current;input.append(option);}
    input.value=current||'';
  }
  else if((type==='text'||!type||key==='tags')&&rows>1){input=node('textarea','short-text');input.rows=rows;input.value=current==null?'':typeof current==='object'?JSON.stringify(current):current;}
  else if(runtimeBool){input=node('select');fillSelect(input,[{label:'模型默认',value:''},{label:'开启',value:'true'},{label:'关闭',value:'false'}],current==null?'':String(current));}
  else if(type==='bool'||type==='boolean') {input=node('input');input.type='checkbox';input.checked=state.task==='vc'&&typeof current==='string'?['true','1'].includes(current.toLowerCase()):!!current;}
  else if(choices?.length){input=node('select');const items=choicesOf(choices);for(const item of items)item.label=['language','lang','target_language'].includes(key)?languageLabel(item.value,item.label):OPTION_CHOICE_NAMES[item.value]||item.label;if(state.task==='music'&&key==='task_route'){const names={auto:'自动',text2music:'根据描述生成',cover:'翻唱',continuation:'续写',complete:'补全伴奏',lego:'添加声部',extract:'提取声部',repaint:'局部重绘',remix:'重混改词'};for(const item of items)item.label=state.detail?.music_inputs?.ace_step?.routes?.[item.value]?.label||names[item.value]||item.label;}if((runtime||current==null)&&!items.some(item=>item.value===''))items.unshift({label:'模型默认',value:''});if(runtime&&current!=null&&!items.some(item=>String(item.value)===String(current)))items.push({label:`${current}（不支持）`,value:current});fillSelect(input,items,current??'');}
  else if(['slider','number','int','float'].includes(type)){input=node('input');input.type=type==='slider'?'range':'number';const min=param.min??param.minimum,max=param.max??param.maximum;if(min!=null)input.min=min;if(max!=null)input.max=max;input.step=param.step??(type==='int'?1:'any');input.value=current??'';if(current==null)uiAttr(input, 'placeholder', '模型默认');}
  else{input=node('input');input.type='text';input.value=current==null?'':typeof current==='object'?JSON.stringify(current):current;uiAttr(input, 'placeholder', param.placeholder||'模型默认');}
  input.id=`param-${key.replace(/[^\w-]/g,'-')}`;
  if(state.task==='vc'&&state.detail?.family==='rvc'){
    const values=formValues();
    input.disabled=key==='voice_id'&&values.rvc_use_builtin===false||key==='voice_model_path'&&values.rvc_use_builtin===true||['retrieval_blend','retrieval_index_path'].includes(key)&&values.rvc_no_index===true;
  }
  if(state.task==='design'&&(state.detail?.family==='irodori_tts'&&key==='duration_scale'||state.detail?.family==='qwen3_tts'&&key==='temperature'))input.min=param.step||0.05;
  const label=(designLanguage?'合成语言':state.task==='music'?{task_route:'创作方式',audio_cover_strength:'贴近原曲',cover_noise_strength:'保旋律强度',flow_edit_n_min:'流编辑起始比例',flow_edit_n_max:'流编辑结束比例',flow_edit_n_avg:'每步平均次数'}[key]:'')||param.label||key;let help=designLanguage?'选择试听文本的合成语种；不会翻译文本。':plainMessage(param.help||param.info||param.description),group;
  if(state.task==='design'&&state.detail?.family==='irodori_tts')help={duration_sec:'目标时长，单位为秒；0 表示自动估算。',duration_scale:'调整自动估算的时长；1 保持默认，指定目标时长后不生效。'}[key]||help;
  if(state.task==='design'&&state.detail?.family==='qwen3_tts'&&key==='temperature')help='控制采样随机性；仅在开启随机采样时生效。';
  if(help){uiAttr(input, 'title', help);uiAttr(input, 'aria-description', help);}
  if(input.type==='checkbox'){group=node('div','field-group');const row=node('label','check-label');row.htmlFor=input.id;row.append(input,node('span','',label));group.append(row);}
  else group=field(label,input);
  if(param.model_choices){
    const path=node('p','muted small model-choice-path');
    const describe=()=>{const selected=modelChoice(param,input.value);uiText(path, input.value?`模型路径：${input.value}`:param.model_choices.some(m=>m.installed)?'选择模型后自动使用其安装路径。':'尚未安装兼容模型，请先在模型中心下载 Qwen3 Forced Aligner。');uiAttr(path, 'title', selected?.install_path||input.value);};
    describe();input.addEventListener('input',describe);group.append(path);
    group.append(button('在模型中心查看','button secondary small-button model-choice-link',event=>runAction(event.currentTarget,async()=>{
      const selected=modelChoice(param,input.value)||param.model_choices[0];
      $('model-search').value=selected?.id||'qwen3_forced_aligner';$('model-task-filter').value='';$('model-state-filter').value='';renderLibrary();
      await navigate('models');if(selected)await selectLibraryModel(selected.id);
    })));
  }
  if((input.type==='text'||input.tagName==='TEXTAREA')&&['basic','effect'].includes(param.level))group.classList.add('common-text-control');
  if(param.scope&&param.scope!=='request'){const tag=node('span','runtime-tag','需重载');uiAttr(tag, 'title', '更改后点击模型设置底部的“应用并重载模型”');group.querySelector('label')?.append(tag);}
  if(runtime)group.classList.add('runtime-parameter');
  if(runtime||['tts','asr'].includes(state.task)){
    group.classList.add(`${state.task}-parameter`);group.dataset.kind=input.tagName==='SELECT'?'choice':input.type||'text';
    group.classList.toggle('wide-parameter',!!param.wide||input.type==='text'||input.tagName==='TEXTAREA');
    const width=value=>[...String(value??'')].reduce((size,c)=>size+(c.charCodeAt(0)>255?2:1),0);
    const content=input.tagName==='SELECT'?[...input.options].map(o=>o.textContent):[current,param.min,param.max,input.placeholder];
    group.style.setProperty('--control-width',`${Math.min(input.tagName==='SELECT'?32:18,Math.max(10,...content.map(width))+4)}ch`);
  }
  let output;if(input.type==='range'){output=rawNode('div','range-value',current);input.after(output);}
  input.addEventListener('input',()=>{
    let value=input.type==='checkbox'?input.checked:input.value;
    if(runtimeBool&&value!=='')value=value==='true';
    if(input.type==='number'||input.type==='range')value=value===''?'':Number(value);
    if(value==='')delete values[key];else values[key]=value;
    if(runtime||ace||['tts','asr','design','vc'].includes(state.task))setModelOption(key,value===''?undefined:value);
    if(state.task==='music'&&state.detail?.family==='ace_step'&&ACE_SOURCE_FIELDS.includes(key)){
      const saved=modelOptions();(saved.musicEdited||={})[key]=true;
      try{const extra=JSON.parse(saved.json||'{}');if(extra&&typeof extra==='object'&&!Array.isArray(extra)&&Object.hasOwn(extra,key)){extra[key]=value;saved.json=JSON.stringify(extra,null,2);$('options-json').value=saved.json;}}catch{}
    }
    if(output)uiText(output, value);
    updateRunButton();
    if(state.task==='music'&&key==='task_route'){renderInputs();renderParameters();}
    if(ace&&key==='repaint_mode'){for(const key of ['repaint_crossfade_frames','repaint_injection_ratio'])setModelOption(key,undefined);renderParameters();}
  });
  if(state.task==='asr')input.addEventListener('change',()=>{
    if(key==='return_timestamps'&&input.checked){fieldValues('detailed').detailed=true;fieldValues('dialogue').dialogue=false;}
    if((state.detail.parameters||[]).some(p=>Object.hasOwn(p.requires||{},key)||Object.hasOwn(p.excludes||{},key)||p.requires_value?.includes(key))||key==='return_timestamps')renderParameters();
  });
  if(state.task==='vc'&&['route','f0_condition'].includes(key))input.addEventListener('change',renderParameters);
  return group;
}
function runtimeSettings(parameters){
  const controls=[],detail=state.detail;
  if(detail?.format||detail?.precision){
    const packageInfo=node('p','runtime-package muted small',`模型包：${[detail.format,detail.precision].filter(Boolean).map(value=>String(value).toUpperCase()).join(' · ')}`);
    uiAttr(packageInfo, 'title', '模型目录标注的下载包格式，不代表自定义文件或所有张量的实际精度。运行时转换不会改写下载文件，也不能恢复量化损失。');controls.push(packageInfo);
  }
  if(!parameters.length)return controls;
  controls.push(node('h3','parameter-section-title','加载与内存'));
  controls.push(...parameters.filter(p=>p.runtime_group!=='advanced').map(parameterControl));
  const advanced=parameters.filter(p=>p.runtime_group==='advanced');
  if(advanced.length){
    const details=node('details','runtime-details'),grid=node('div','runtime-grid'),saved=modelOptions();details.open=!!saved.runtimeExpanded;
    details.append(node('summary','','分模块精度、缓存与其他加载参数'));grid.append(...advanced.map(parameterControl));details.append(grid);
    details.addEventListener('toggle',()=>{saved.runtimeExpanded=details.open;});controls.push(details);
  }
  return controls;
}
function renderParameters() {
  $('workspace-settings').dataset.task=state.task;
  const design=state.task==='design',vc=state.task==='vc',designCommon=design?(DESIGN_COMMON_PARAMETERS[state.detail?.family]||[]):[];
  uiAttr($('options-json'), 'placeholder', design||vc?'{}':'{"temperature": 0.9}');
  const ace=state.task==='music'&&state.detail?.family==='ace_step',aceEdit=aceMusicEditing();
  let options=state.overrides;try{options=collectOptions();}catch{}
  if(state.task==='asr'&&options.return_timestamps){modelOptions().inputs.detailed=true;modelOptions().inputs.dialogue=false;}
  let route=options.task_route;
  route??=state.detail?.parameters?.find(p=>p.name==='task_route')?.default;
  const parameters=visibleParameters().filter(p=>{
    if(state.task==='asr'&&!asrParameterActive(p,state.detail,options,modelOptions().inputs))return false;
    if(vc&&!vcParameterActive(p.name,state.detail,options))return false;
    if(state.task==='music'&&['tags','task_route'].includes(p.name))return false;
    if(ace){
      if([...ACE_SOURCE_FIELDS,...ACE_MAIN_FIELDS].includes(p.name))return false;
      if(aceParameterRoutes()[p.name]&&!aceParameterRoutes()[p.name].includes(route))return false;
      if(p.name==='guidance_scale'&&!aceGuidanceAvailable(options))return false;
      const mode=options.repaint_mode||'balanced';
      if(p.name==='repaint_strength'&&mode!=='balanced')return false;
      if(['repaint_crossfade_frames','repaint_injection_ratio'].includes(p.name)&&mode!=='custom')return false;
    }
    return true;
  }).map(p=>designCommon.includes(p.name)?{...p,level:'effect'}:ace&&aceParameterRoutes()[p.name]&&!['repaint_crossfade_frames','repaint_injection_ratio'].includes(p.name)?{...p,level:'effect'}:ace&&p.name==='num_inference_steps'?{...p,level:'expert'}:p);
  const runtime=p=>p.scope&&p.scope!=='request';
  const reference=state.task==='tts'?parameters.filter(p=>p.placement==='reference'):[];
  const referenceOptions=$('tts-reference-options');if(referenceOptions){
    document.querySelector('#task-inputs .reference-voice-mode')?.remove();
    replace(referenceOptions,...reference.map(parameterControl));referenceOptions.hidden=!reference.length;
    syncReferenceControls(formValues());
  }
  const basic=parameters.filter(p=>p.level==='basic'&&!runtime(p)&&!reference.includes(p));
  const voice=p=>['speaker','speaker_id','voice','voice_id'].includes(p.name);
  replace($('basic-controls'),...basic.filter(p=>!voice(p)).map(parameterControl));
  const settings=$('task-setting-inputs');replace(settings);
  settings.append(...basic.filter(voice).map(parameterControl));
  if(state.task==='tts'&&state.detail?.streaming)settings.append(checkboxInput('stream','流式生成','开启时边生成边播放，关闭时离线生成。'));
  if(state.task==='asr'&&state.detail?.streaming)settings.append(checkboxInput('stream','流式转写'));
  if((state.task==='tts'&&state.detail?.languages?.length)||(state.task==='asr'&&state.detail?.languages?.length>1)){
    const group=selectInput('language',state.task==='asr'?'识别语言':'语言',state.task==='asr'?asrLanguageChoices(state.detail):languageChoices(state.detail.languages,state.detail.tts_controls?.voice_languages?'跟随音色':'自动'));
    if(state.task==='tts'){
      const input=group.querySelector('select');if(options.language!=null)input.value=options.language;
      input.addEventListener('change',()=>{
        setModelOption('language',undefined);
        const voices=state.detail.tts_controls?.voice_languages;
        if(voices&&input.value){const voice=options.voice??state.detail.parameters.find(p=>p.name==='voice')?.default;if(voices[voice]!==input.value)setModelOption('voice',Object.keys(voices).find(v=>voices[v]===input.value));}
        renderParameters();
      });
    }
    settings.append(group);
  }
  if(state.task==='asr'){
    if(state.detail?.asr_inputs?.details)settings.append(checkboxInput('detailed','详细结果','保存模型实际返回的分段、时间戳等 JSON 信息，完成后可下载详情；仅支持离线识别。'));
    if(state.detail?.asr_inputs?.dialogue){const group=checkboxInput('dialogue','区分说话人','额外调用说话人分离模型，再分段识别；需先安装该模型。');const input=group.querySelector('input');if(state.detail.asr_inputs.dialogue_available===false){input.checked=false;input.disabled=true;uiAttr(input, 'title', '需先安装说话人分离模型');}settings.append(group);}
    if(state.detail?.asr_inputs?.context){const context=textInput('context',state.detail.asr_inputs.context_label||'专有名词',{placeholder:state.detail.asr_inputs.context_label==='音频指令'?'描述需要识别或理解的内容':'人名、品牌名或专业术语'});context.classList.add('asr-context');settings.append(context);}
    const modes=[...settings.querySelectorAll('input[data-input-key="stream"],input[data-input-key="detailed"],input[data-input-key="dialogue"]')];
    for(const mode of modes)mode.addEventListener('change',()=>{if(mode.checked)for(const other of modes)if(other!==mode){other.checked=false;fieldValues(other.dataset.inputKey)[other.dataset.inputKey]=false;}if(mode.dataset.inputKey==='dialogue'&&mode.checked||mode.dataset.inputKey==='detailed'&&!mode.checked)setModelOption('return_timestamps',false);renderParameters();});
  }
  if(state.task==='music'&&state.detail?.music_inputs?.duration){const music=state.detail.music_inputs;settings.append(aceEdit&&(formValues().audio||musicInputCapabilities().require_source_audio)?musicDurationControl():textInput('duration','时长（秒）',{type:'number',value:music.duration_default,min:music.duration_min,max:music.duration_max,step:'any',help:music.duration_min<0?'设为 -1 时由模型决定。':''}));}
  if(state.analysisType==='align')settings.append(textInput('language','对齐语言',{required:!!state.detail?.profile?.require_analysis_language,placeholder:'例如：Chinese / English'}));
  const effect=parameters.filter(p=>p.level==='effect'&&!runtime(p)&&!reference.includes(p)&&!(state.task==='music'&&p.name==='audio_cover_strength'&&route&&!['cover','cover-nofsq','remix'].includes(route)));const expert=parameters.filter(p=>runtime(p)||!['effect','basic'].includes(p.level));
  replace($('effect-controls'),...effect.map(parameterControl));
  const profile=state.detail?.profile||{};
  const maxTokens=['tts','design'].includes(state.task)&&profile.send_max_tokens!==false?textInput('max_tokens','生成长度上限（max_tokens）',{type:'number',min:state.detail?.max_tokens_min??1,step:1,placeholder:state.detail?.family==='vibevoice'?'按文本长度自动计算':'使用模型默认',help:'过小可能截断内容。'}):null;
  const controls=runtimeSettings(expert.filter(runtime)),requestControls=expert.filter(p=>!runtime(p)).map(parameterControl);
  if(design&&maxTokens)requestControls.push(maxTokens);
  if(requestControls.length){controls.push(node('h3','parameter-section-title',state.task==='asr'?'识别参数':vc?'高级转换参数':design?'高级合成参数':'采样与生成参数'),...requestControls);}
  replace($('expert-controls'),...controls);
  if(['tts','music','vc','processing','design'].includes(state.task)&&profile.send_seed!==false&&(!(design||vc)||state.detail)){
    const seedDefault=state.detail?.parameters?.find(p=>p.name==='seed')?.default;
    const placeholder=vc?(seedDefault==null?'留空随机':`默认 ${seedDefault}`):design?'默认':'留空使用默认';
    const seed=textInput('seed','随机种子',{type:'number',min:-1,max:vc&&state.detail.family==='tone_color_vc'?2147483647:undefined,step:1,placeholder,help:`${vc&&seedDefault==null?'留空随机':'留空使用模型默认值'}；固定种子用于复现结果，-1 表示随机。`});
    if(design||vc||state.task==='tts'){const input=seed.querySelector('input');if(options.seed!=null)input.value=options.seed;input.addEventListener('input',()=>setModelOption('seed',undefined));}
    $(design||vc?'effect-controls':'expert-controls').append(seed);
  }
  if(!design&&maxTokens)$('expert-controls').append(maxTokens);
  $('common-options').hidden=!settings.childElementCount&&!$('basic-controls').childElementCount&&!$('effect-controls').childElementCount;
  uiText($('common-options-heading'), state.task==='music'?'创作选项':state.task==='asr'?'识别选项':state.task==='vc'?'转换选项':'合成选项');
  $('common-options-heading').hidden=!['tts','design','vc','asr','music'].includes(state.task)||($('common-options').hidden&&!document.querySelector('.music-route-controls')?.childElementCount);
}
$('reset-options').addEventListener('click',()=>{const options=modelOptions();options.values={};options.inputs={};options.json='';delete options.musicEdited;delete options.musicAnalysisPending;state.overrides=options.values;$('options-json').value='';renderInputs();renderParameters();updateRunButton();showToast('已恢复默认参数；运行设置需应用后生效');});

function collectInputs() {
  const values=formValues();const inputs={};
  for(const root of [$('task-form'),$('workspace-settings')])for(const el of root.querySelectorAll('[data-input-key]')){const key=el.dataset.inputKey;if(key==='reference_name'||el.closest('.reference-library-fields[hidden],.reference-upload-fields[hidden],.tts-reference-group[hidden]'))continue;const value=el.type==='file'?values[key]:el.type==='checkbox'?el.checked:el.type==='number'?(el.value===''?'':Number(el.value)):el.value;if(value!==''&&value!=null)inputs[key]=value;}
  const profile=state.detail?.profile||{};
  if(profile.accepts_voice_reference===false&&state.task==='tts'){delete inputs.voice;delete inputs.builtin_voice;delete inputs.reference_text;}
  if(inputs.builtin_voice&&inputs.voice)delete inputs.voice;
  if(inputs.rvc_use_builtin===true)delete inputs.rvc_voice_model;
  if(inputs.rvc_no_index===true)delete inputs.rvc_retrieval_index;
  if(state.task==='tts'&&inputs.builtin_voice&&profile.send_reference_text!==false)inputs.reference_text=values.reference_text||'';
  if(state.task==='tts'&&state.detail.tts_controls?.voice_languages){
    const voice=$('param-voice')?.value;if(voice&&!inputs.language){inputs.language=state.detail.tts_controls.voice_languages[voice];}
  }
  if(state.task==='tts'&&state.detail.tts_controls?.speakers&&modelOptions().inputs.multi_speaker){
    inputs.speaker_references=modelOptions().inputs.speaker_references.map((slot,index)=>slot.builtin_voice?{builtin_voice:slot.builtin_voice,reference_text:slot.reference_text}:{voice:slot[`speaker_${index}`]||'',reference_text:slot.reference_text});
    delete inputs.voice;delete inputs.builtin_voice;delete inputs.reference_text;
  }
  if(state.task==='tts'&&state.detail.family==='irodori_tts'&&collectOptions().no_ref===true){delete inputs.voice;delete inputs.builtin_voice;}
  if(aceMusicEditing()&&inputs.audio&&state.detail.music_inputs?.duration)inputs.duration=-1;
  if(state.task==='asr'&&collectOptions().return_timestamps){inputs.detailed=true;inputs.dialogue=false;}
  return inputs;
}
function validateInputs(inputs,options={}) {
  const profile=state.detail.profile||{};
  if(['asr','vc','processing','separation','analysis'].includes(state.task)&&!inputs.audio)throw new Error('请先上传或录制要处理的音频。');
  validateModelChoices(options);
  if(state.task==='asr'&&state.detail.family==='qwen3_asr'&&options.return_timestamps&&!options['session_options.qwen3_asr.forced_aligner_path']&&!options.session_options?.['qwen3_asr.forced_aligner_path'])throw new Error('时间戳需要强制对齐模型：请先在模型设置中选择已安装的 Qwen3 Forced Aligner，并应用重载。');
  if(profile.require_source_audio&&!inputs.audio)throw new Error('这个操作需要源音频，请先添加文件。');
  const speakerReferences=inputs.speaker_references,hasSpeakers=speakerReferences?.some(slot=>slot.voice||slot.builtin_voice);
  const rawSpeakers=!speakerReferences&&state.detail.tts_controls?.speakers&&(options.voice_samples||options[`${state.detail.family}.voice_samples`]);
  if(profile.require_voice&&!inputs.voice&&!inputs.builtin_voice&&!hasSpeakers&&!String(rawSpeakers||'').split(',').some(s=>s.trim()))throw new Error('这个模型需要参考声音，请选择已保存的音色或添加参考音频。');
  if(hasSpeakers&&state.detail.tts_controls?.speakers?.allow_empty===false){const last=speakerReferences.findLastIndex(slot=>slot.voice||slot.builtin_voice);if(speakerReferences.slice(0,last+1).some(slot=>!slot.voice&&!slot.builtin_voice))throw new Error('VibeVoice 的说话人参考不能跳过空位，请从 Speaker 0 起依次选择。');}
  if(state.task==='tts'&&state.detail.family==='irodori_tts'&&options.no_ref===false&&!inputs.voice&&!inputs.builtin_voice)throw new Error('关闭“不使用参考音频”后，请选择或上传参考音频。');
  const voiceLanguages=state.detail.tts_controls?.voice_languages,language=options.language||inputs.language;
  if(voiceLanguages&&language&&options.voice&&voiceLanguages[options.voice]!==language)throw new Error('所选音色与语言不匹配，请选择对应音色，或将语言设为跟随音色。');
  const xVectorOnly=state.detail.family==='qwen3_tts'&&(options.x_vector_only_mode===true||['true','1','yes','on'].includes(String(options.x_vector_only_mode)));
  const referenceText=inputs.reference_text||state.voices.find(voice=>voice.name===inputs.builtin_voice)?.text||'';
  if(!xVectorOnly&&(profile.require_reference_text||state.detail.requires_reference_text||(profile.require_reference_text_with_voice&&(inputs.voice||inputs.builtin_voice)))&&!referenceText.trim())throw new Error('这个模型需要参考原文，请填写参考音频实际说出的内容。');
  if(state.task==='vc'&&profile.require_vc_target&&!inputs.voice&&!inputs.builtin_voice)throw new Error('请添加目标声音参考。');
  if(state.task==='vc'&&state.detail.family==='rvc'){
    const custom=inputs.rvc_voice_model||options.voice_model_path;
    if(inputs.rvc_use_builtin===false&&!custom)throw new Error('请选择 RVC 文件，或勾选“使用内置音色”。');
    if(inputs.rvc_no_index===false&&custom&&Number(options.retrieval_blend)>0&&!inputs.rvc_retrieval_index&&!options.retrieval_index_path)throw new Error('请为自定义 RVC 音色选择索引文件，或勾选“不使用音色索引”。');
  }
  if(inputs.dialogue&&inputs.stream)throw new Error('说话人对话模式与流式处理不能同时开启，请选择一种。');
  if(inputs.detailed&&(inputs.dialogue||inputs.stream))throw new Error('详细结果仅支持普通离线转写，请关闭说话人对话和流式处理。');
  if(state.task==='music'){const music=musicInputCapabilities();if(music.require_source_audio&&!inputs.audio)throw new Error('当前创作方式需要源音频。');if(music.require_lyrics&&!inputs.lyrics)throw new Error('请填写歌词。');}
  if(state.task==='music'&&state.detail.family==='ace_step'){
    const route=aceRoute(options),tracks=state.detail.music_inputs?.ace_step?.tracks?.map(([,value])=>value)||[];
    if(['lego','extract'].includes(route)&&!tracks.includes(options.track_name))throw new Error('请选择目标声部。');
    if(route==='complete'){const selected=Array.isArray(options.complete_track_classes)?options.complete_track_classes:String(options.complete_track_classes||'').split(',').map(x=>x.trim());if(!selected.length||selected.some(value=>!tracks.includes(value)))throw new Error('请至少选择一个补全声部。');}
    if(['repaint','lego'].includes(route))validateMusicRange(options);
    if(route==='remix'){const start=Number(options.flow_edit_n_min??0),end=Number(options.flow_edit_n_max??1),avg=Number(options.flow_edit_n_avg??2);if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>1||start>end)throw new Error('流编辑起止比例须满足 0 ≤ 起始 ≤ 终止 ≤ 1。');if(!Number.isInteger(avg)||avg<1)throw new Error('每步平均次数须为正整数。');}
  }
}
$('task-form').addEventListener('submit',event=>{event.preventDefault();submitTask();});
async function submitTask(action='generate'){
  if(state.job||state.referenceJob||state.loading||state.submitting||state.runtime?.busy||state.runtime?.realtime_active||state.realtime?.active||!state.detail?.installed||state.model!==activeModelRuntime()?.model||runtimeSettingsState().pending||state.uploading||state.recorders.size)return;
  const key=state.key,resultEpoch=workspace(key).resultEpoch||0;
  workspace(key).message='';
  try{
    const inputs=collectInputs();let options=collectOptions();
    if(action!=='analyze_source')for(const root of [$('task-form'),$('workspace-settings')])for(const input of root.querySelectorAll('input[type="number"]'))if(!input.checkValidity())throw new Error(`请检查参数「${input.closest('.field-group')?.querySelector('label')?.textContent||input.name||input.id}」的范围和步长。`);
    if(action==='analyze_source'){if(state.task!=='music'||state.detail.family!=='ace_step'||!inputs.audio)throw new Error('请先添加 ACE-Step 源音频。');}else{validateInputs(inputs,options);if(state.task==='music')options=musicRequestOptions(options,inputs);}
    runtimeOptions(options);const source=workspace(key).forms._audioBlob;
    const saved=modelOptions(),record={key,resultEpoch,task:state.task,model:state.model,action,label:`${action==='analyze_source'?'源音频分析':taskInfo().label} · ${state.detail.label||state.model}`,stream:state.task==='tts'&&!!inputs.stream,lastAudioIndex:-1,result:{status:'queued',message:'正在准备任务…',artifacts:[]}};
    if(action==='analyze_source'){delete saved.musicAnalysisPending;Object.assign(record,{sourceAudio:inputs.audio,parameterValues:saved.values,submittedValues:{...saved.values},submittedJson:saved.json});}
    state.pendingRecord=record;
    renderWorkspaceResults();
    ($('result-content').closest('.tts-result-section')||$('result-content').closest('.result-card')).scrollIntoView({block:'nearest'});
    state.submitting=true;updateRunButton();
    updateActiveJobBanner();stopStreamPlayback();if(record.stream)beginStreamPlayback();
    const job=await api('/jobs',{method:'POST',body:{task:record.task,model:record.model,inputs,options,...(action==='analyze_source'?{action}:{})}});record.id=job.id;
    if(record.task==='vc'&&source)record.sourceBlob=source;
    if((workspace(key).resultEpoch||0)===resultEpoch){
      if(record.sourceBlob)record.sourceUrl=URL.createObjectURL(record.sourceBlob);
      const previous=workspace(key).result;if(previous?.sourceUrl)URL.revokeObjectURL(previous.sourceUrl);
      workspace(key).result=record;
    }
    state.job=record;
    if(state.key===key)renderWorkspaceResults();updateActiveJobBanner();pollJob();
  }catch(error){stopStreamPlayback();if((workspace(key).resultEpoch||0)===resultEpoch)workspace(key).message=friendlyError(error);if(state.key!==key)showToast(friendlyError(error));}
  finally{state.submitting=false;state.pendingRecord=null;if(state.key===key)renderWorkspaceResults();updateRunButton();updateActiveJobBanner();}
}

function applyMusicAnalysis(record,job){
  const saved=modelOptions(record.key,record.model);
  if(job.status!=='done'||record.action!=='analyze_source'||workspace(record.key).result!==record||saved.values!==record.parameterValues||workspace(record.key).forms.audio!==record.sourceAudio)return;
  let extra,submittedExtra;try{extra=JSON.parse(saved.json||'{}');submittedExtra=JSON.parse(record.submittedJson||'{}');}catch{return;}
  if(!extra||typeof extra!=='object'||Array.isArray(extra))return;
  let jsonChanged=false;const pending={};
  for(const [name,value] of Object.entries(job.parameter_updates||{})){
    if(!['source_caption','source_lyrics','bpm','keyscale','timesignature'].includes(name))continue;
    if(saved.values[name]!==record.submittedValues[name]||extra[name]!==submittedExtra[name])continue;
    if(ACE_SOURCE_FIELDS.includes(name)&&saved.musicEdited?.[name]){pending[name]=value;continue;}
    saved.values[name]=value;
    if(Object.hasOwn(extra,name)){extra[name]=value;jsonChanged=true;}
  }
  if(jsonChanged)saved.json=JSON.stringify(extra,null,2);
  if(Object.keys(pending).length)saved.musicAnalysisPending={audio:record.sourceAudio,parameterValues:saved.values,values:pending};
  if(state.key===record.key&&state.model===record.model){$('options-json').value=saved.json;renderInputs();renderParameters();}
}
function isAudioArtifact(artifact) {return artifact.kind==='audio'||/\.(wav|mp3|flac|ogg|m4a|webm)$/i.test(artifact.name||'');}
function singleAudioArtifact(artifacts) {const audio=(artifacts||[]).filter(artifact=>safeArtifactUrl(artifact.url)&&isAudioArtifact(artifact));return audio.length===1?audio[0]:null;}
function artifactLink(artifact) {const link=rawNode('a','artifact-name',artifact.name||'输出文件');link.href=safeArtifactUrl(artifact.url);link.download=artifact.name||'';uiAttr(link, 'title', `下载 ${artifact.name||'输出文件'}`);return link;}
async function downloadAsrDetails(artifact) {
  const response=await fetch(safeArtifactUrl(artifact.url));
  if(!response.ok)throw new Error('详情文件下载失败，请重试。');
  const url=URL.createObjectURL(await response.blob()),link=node('a');link.href=url;link.download=artifact.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function setJobStatus(message,status,artifacts) {
  const notice=state.task==='asr'&&(['error','warning','cancelled'].includes(status)||/^\s*(?:⚠|警告[：:]|提醒[：:])/u.test(message||''));
  const el=$(notice?'asr-notice':'job-status'),other=$(notice?'job-status':'asr-notice');other.hidden=true;uiText(other, '');
  message=plainMessage(message);el.hidden=!message;el.className=`job-status ${['queued','running'].includes(status)?'running':status}`;el.dataset.state=status;uiText(el, message);
  const audio=singleAudioArtifact(artifacts);if(audio){el.append(' · ',artifactLink(audio));el.hidden=false;}
}
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
  if(!state.job)return;const record=state.job,id=record.id;
  try{
    const query=record.stream?`?after=${record.lastAudioIndex}`:'';
    const job=await api(`/jobs/${encodeURIComponent(id)}${query}`);if(state.job?.id!==id)return;playStreamSegments(job.audio_segments);
    record.result={...job,audio_segments:undefined};
    if(['done','error','cancelled'].includes(job.status)){
      applyMusicAnalysis(record,job);
      if(job.status==='done')finishStreamPlayback();else stopStreamPlayback();state.job=null;
      if(state.key===record.key)renderWorkspaceResults();else showToast(`${record.label} · ${job.status==='done'?'已完成':'已结束'}`);
      updateRunButton();updateActiveJobBanner();pollStatus();return;
    }
    if(state.key===record.key)renderWorkspaceResults();updateActiveJobBanner();
  }catch(error){
    if(state.job?.id!==id)return;
    record.result.message=error.status===404?'服务已重启或任务已失效，请重新提交。':`${friendlyError(error)} 正在尝试重新连接任务…`;
    if(error.status===404){record.result.status='error';state.job=null;stopStreamPlayback();updateRunButton();updateActiveJobBanner();}
    if(state.key===record.key)renderWorkspaceResults();if(!state.job){pollStatus();return;}
  }
  state.jobTimer=setTimeout(pollJob,1100);
}
function renderWorkspaceResults() {
  const current=workspace(),pending=state.pendingRecord?.key===state.key&&state.pendingRecord.model===state.model&&state.pendingRecord.resultEpoch===(current.resultEpoch||0)?state.pendingRecord:null,record=pending||current.result;
  const card=$('result-content').closest('.result-card'),hasText=!!record?.result?.text;
  card.hidden=['tts','design','vc','music','asr'].includes(state.task)&&!record&&(state.task==='asr'||!current.message);
  card.classList.toggle('has-result',!!record);card.classList.toggle('has-text',hasText);
  $('copy-result').hidden=!hasText;$('export-result').hidden=!hasText;
  const cancel=$('cancel-job');cancel.hidden=!record||!record.id||state.job?.id!==record.id;cancel.disabled=!!record?.cancelRequested;uiText(cancel, record?.cancelRequested?'正在停止…':({tts:'取消生成',music:'取消生成',design:'取消生成',asr:'取消识别',vc:'取消转换'}[state.task]||'停止任务'));
  if(!record){state.renderedResult=null;setJobStatus(current.message||'',current.message?'error':'idle');renderResult({status:current.message?'error':'idle',text:'',artifacts:[]},null);return;}
  const result=record.result,completed=result.status==='done';
  const seconds=String(result.message||'').match(/(?:用时|\bin)\s*(\d+(?:\.\d+)?)\s*s\b/i)?.[1]??(Number.isFinite(result.elapsed)&&result.elapsed>=0?result.elapsed.toFixed(1):null);
  let message=result.message||(completed?'已完成':'正在处理…');
  if(record.action==='analyze_source'&&completed)message='源音频分析完成';
  if(completed&&seconds!==null&&!/(?:用时|\bin)\s*\d+(?:\.\d+)?\s*s\b/i.test(message))message+=` · 用时 ${seconds} s`;
  message=message.replace(/用时\s*(\d+(?:\.\d+)?)\s*s\b/,'用时 $1 s');
  if(state.task==='asr'&&completed)message=plainMessage(message).replace(/^(?:流式|对话)?(?:转写|转录|识别|任务)完成\s*/,'').replace(/[，,]\s*含模型加载\s*\d+(?:\.\d+)?\s*s/g,'').replace(/^（([^）]*)）[，,]?\s*/,'$1，').replace(/[。.]$/,'').trim();
  const stopping=record.cancelRequested&&!['done','error','cancelled'].includes(result.status);
  const status=current.message?'error':stopping?'cancelling':state.task==='asr'&&completed&&/^\s*⚠/u.test(result.message||'')?'warning':result.status;
  setJobStatus(current.message|| (stopping?'正在停止任务…':message),status,result.artifacts);
  renderResult(result,record);
}
function renderResult(job,record) {
  const signature=JSON.stringify([state.task,record?.sourceUrl,job.status,job.text,job.artifacts]);
  if(state.renderedResult?.record===record&&state.renderedResult.signature===signature)return;
  state.renderedResult={record,signature};
  const children=[],downloads=[];
  if(record?.sourceUrl){
    const source=node('div',state.task==='separation'?'artifact separation-track':'artifact');source.append(node('span','artifact-name','原始音频'));
    const group=state.task==='separation'?node('div','separation-audio-group'):source;if(group!==source)source.append(group);
    const audio=node('audio');audio.controls=true;audio.preload='metadata';audio.src=record.sourceUrl;group.append(audio);attachWaveform(group,audio,undefined,false,state.task==='separation');children.push(source);
  }
  if(job.text||state.task==='asr'){const text=typeof job.text==='string'?job.text:JSON.stringify(job.text,null,2),box=node('textarea','result-text');box.value=record?.editedSource===text?record.editedText:text;uiAttr(box, 'aria-label', state.task==='asr'?'识别文字结果':'文字结果');box.spellcheck=false;box.readOnly=!record||!['done','error','cancelled'].includes(job.status);box.addEventListener('input',()=>{if(record){record.editedSource=text;record.editedText=box.value;}});children.push(box);}
  const files=node('div','result-files'),inlineAudio=singleAudioArtifact(job.artifacts);
  for(const artifact of job.artifacts||[]){const url=safeArtifactUrl(artifact.url);if(!url)continue;if(state.task==='asr'&&!isAudioArtifact(artifact)){if(/\.json$/i.test(artifact.name||''))downloads.push(button('下载详情','button secondary small-button',event=>runAction(event.currentTarget,()=>downloadAsrDetails(artifact))));continue;}const item=node('div','artifact');if(artifact!==inlineAudio||state.task==='separation'){const heading=node('div','artifact-heading');heading.append(artifactLink(artifact));item.append(heading);}
    if(isAudioArtifact(artifact)){
      item.classList.add('audio-artifact');const group=state.task==='separation'?node('div','separation-audio-group'):item;
      if(group!==item){item.classList.add('separation-track');group.setAttribute('role','group');uiAttr(group, 'aria-label', artifact.name||'分离音轨');item.append(group);}
      const audio=node('audio');audio.controls=true;audio.preload='metadata';audio.src=url;uiAttr(audio, 'aria-label', artifact.name||'生成音频');audio.addEventListener('play',stopStreamPlayback);group.append(audio);attachWaveform(group,audio,undefined,false,['tts','design','vc','music','separation'].includes(state.task));
    }files.append(item);
  }
  if(files.childElementCount)children.push(files);
  if(!job.text&&!files.childElementCount&&job.status==='done'&&state.task!=='asr'&&record?.action!=='analyze_source')children.push(node('p','result-placeholder','未产生输出文件'));
  replace($('result-content'),...children);
  replace($('result-downloads'),...downloads);$('result-downloads').hidden=!downloads.length;
}
function currentResultText() {return $('result-content').querySelector('.result-text')?.value||'';}
$('copy-result').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(currentResultText());showToast('文字已复制');}catch{showToast('请选中文字手动复制。');}});
$('export-result').addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([currentResultText()],{type:'text/plain;charset=utf-8'})),link=node('a');link.href=url;link.download=`${state.task==='asr'?'transcript':'result'}_${workspace().result?.id||'text'}.txt`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
$('cancel-job').addEventListener('click',async()=>{const record=state.job;if(!record||record.cancelRequested)return;record.cancelRequested=true;stopStreamPlayback();renderWorkspaceResults();try{await api(`/jobs/${encodeURIComponent(record.id)}/cancel`,{method:'POST',body:{}});}catch(error){record.cancelRequested=false;showToast(friendlyError(error));}finally{if(state.key===record.key)renderWorkspaceResults();}});

function renderLibrary() {
  const query=$('model-search').value.trim().toLowerCase(),task=$('model-task-filter').value,filter=$('model-state-filter').value;
  const models=(state.catalog?.models||[]).filter(m=>(!query||[m.label,t(m.label),m.id,m.family,m.description,t(m.description),TASK_NAMES[modelTask(m)],t(TASK_NAMES[modelTask(m)])].join(' ').toLowerCase().includes(query))&&(!task||fitsTask(m,task))&&(!filter||(filter==='installed'?m.installed:filter==='manual'?!m.installable&&!m.installed:m.installable&&!m.installed)));
  uiText($('model-count'), `${models.length} 个模型 · ${(state.catalog?.models||[]).filter(m=>m.installed).length} 个已安装`);
  const children=models.map(model=>{const row=button('','model-row',()=>selectLibraryModel(model.id));row.classList.toggle('selected',state.libraryModel===model.id);row.dataset.model=model.id;const top=node('div','model-row-top');top.append(node('span','model-row-title',model.label||model.id),badge(model.installed?'已安装':model.installable?'可下载':'手动导入',model.installed?'success':''));const meta=node('div','model-row-meta');meta.append(node('span','',TASK_NAMES[modelTask(model)]||modelTask(model)),node('span','',model.family||''));if(model.size_bytes)meta.append(node('span','',formatBytes(model.size_bytes)));if(model.min_vram_gb)meta.append(node('span','',`参考显存 ${model.min_vram_gb} GB`));row.append(top,meta);return row;});
  replace($('model-list'),...(children.length?children:[node('div','empty-state','没有匹配的模型')]));
}
async function selectLibraryModel(id) {
  const panel=$('model-detail');panel.classList.remove('model-detail-flow');panel.style.removeProperty('--model-detail-offset');
  state.libraryModel=id;const seq=++state.librarySeq;renderLibrary();replace($('model-detail'),node('p','loading-inline','正在读取模型信息…'));
  try{const detail=await api(`/models/${encodeURIComponent(id)}`);if(seq!==state.librarySeq)return;renderModelDetail(detail);}catch(error){if(seq===state.librarySeq)replace($('model-detail'),node('p','muted small',friendlyError(error)));}
}
function syncModelDetailLayout() {
  const panel=$('model-detail');
  if(state.page!=='models'||!panel.getClientRects().length)return;
  const tall=matchMedia('(min-width:961px)').matches&&panel.offsetHeight>innerHeight-40;
  if(tall===panel.classList.contains('model-detail-flow'))return;
  if(tall){
    // Keep the card where it was viewed when releasing it from sticky positioning.
    const offset=Math.max(0,panel.getBoundingClientRect().top-panel.parentElement.getBoundingClientRect().top);
    panel.style.setProperty('--model-detail-offset',`${offset}px`);
  }else panel.style.removeProperty('--model-detail-offset');
  panel.classList.toggle('model-detail-flow',tall);
}
new ResizeObserver(syncModelDetailLayout).observe($('model-detail'));
window.addEventListener('resize',syncModelDetailLayout);
async function showModelDeletion(id) {
  const dialog=node('dialog','model-delete-dialog');dialog.setAttribute('aria-labelledby','model-delete-title');
  let pending=false,closed=false;
  dialog.addEventListener('cancel',event=>{if(pending)event.preventDefault();});
  dialog.addEventListener('close',()=>{closed=true;dialog.remove();});
  async function refreshCatalog() {
    await loadCatalog();if(state.libraryModel===id)await selectLibraryModel(id);
  }
  async function render() {
    const plan=await api(`/models/${encodeURIComponent(id)}/deletion`);
    if(closed)return;
    if(!dialog.isConnected)document.body.append(dialog);
    const title=node('h2','','删除本地模型');title.id='model-delete-title';
    const path=node('div','install-path');path.append(rawNode('span','field-label',plan.label),rawNode('code','',plan.path));
    const affected=node('ul','model-delete-affected');
    for(const entry of plan.affected||[])affected.append(rawNode('li','',entry.label));
    const message=node('p','model-delete-message');message.setAttribute('role','status');
    const actions=node('div','model-delete-actions');
    const cancel=button('取消','button secondary',()=>dialog.close());
    const confirm=button('确认删除','button danger',async()=>{
      pending=true;cancel.disabled=true;confirm.disabled=true;uiText(confirm, '正在删除…');
      try {
        const result=await api(`/models/${encodeURIComponent(id)}/delete`,{method:'POST',body:{token:plan.token}});
        updateStatus(result);dialog.close();showToast(result.message);await refreshCatalog();
      } catch(error) {
        uiText(message, friendlyError(error));confirm.hidden=true;
        actions.append(button('重新检查','button secondary',event=>runAction(event.currentTarget,render)));
        await refreshCatalog().catch(()=>{});
      } finally {pending=false;cancel.disabled=false;}
    });
    actions.append(cancel);
    if(plan.blocker){
      uiText(message, plan.blocker.reason);confirm.disabled=true;
      if(plan.blocker.unload)actions.append(button('卸载全部模型','button secondary',event=>runAction(event.currentTarget,async()=>{
        pending=true;cancel.disabled=true;
        try {updateStatus(await api('/unload-all',{method:'POST',body:{}}));await render();}
        finally {pending=false;cancel.disabled=false;}
      })));
      else actions.append(button('重新检查','button secondary',event=>runAction(event.currentTarget,render)));
    }
    actions.append(confirm);
    replace(dialog,title,path,node('p','',`将永久删除 ${plan.files} 个文件（${plan.bytes===0?'0 B':formatBytes(plan.bytes)}），以下入口会受影响：`),affected,
      node('p','muted small','参数配置、音色库和生成结果保留。仅删除此安装位置；目录外的共享组件、其他副本和下载缓存保留。'),message,actions);
    if(!dialog.open)dialog.showModal();cancel.focus();
  }
  await render();
}

function renderModelDetail(model) {
  const panel=$('model-detail');const children=[node('div','eyebrow',model.family||'MODEL'),node('h2','',model.label||model.id)];
  const badges=node('div','badge-row');badges.append(badge(TASK_NAMES[modelTask(model)]||modelTask(model)),badge(model.installed?'已安装':model.installable?'可下载':'需手动导入',model.installed?'success':''));if(model.streaming)badges.append(badge('支持流式'));children.push(badges);
  const description=plainMessage(model.description||model.input_hint);if(description)children.push(node('p','description',description));
  const memory=model.memory_range_gb?.length?`${model.memory_range_gb.join('–')} GiB（预算）`:model.min_vram_gb?`${model.min_vram_gb} GB（估算）`:'未提供估算';
  const size=model.size_bytes!=null?formatBytes(model.size_bytes):model.size_estimate_gb?`约 ${model.size_estimate_gb} GiB（原始权重）`:'待确认';
  const data=node('dl','detail-data');const entries=[[model.size_kind==='bundled'?'附带资源':'下载大小',size],[model.memory_device==='ram'?'系统内存预算':'显存预算',memory],['运行设备',backendLabel(model.backend||state.catalog?.hardware?.backend)]];
  for(const [label,value] of entries){const row=node('div');row.append(node('dt','',label),node('dd','',value));data.append(row);}children.push(data);
  const availableVram=Number(state.catalog?.hardware?.vram_gb);if(model.backend!=='cpu'&&model.memory_device!=='ram'&&model.min_vram_gb&&availableVram&&model.min_vram_gb>availableVram)children.push(node('div','notice warning',`估算需求超过本机 ${availableVram.toFixed(1)} GB 显存，可能无法加载。`));
  if(model.size_note)children.push(node('p','field-help',plainMessage(model.size_note)));
  if(model.memory_basis)children.push(node('p','field-help',plainMessage(model.memory_basis)));
  if(model.requirements&&!model.size_note&&!model.memory_basis){const text=typeof model.requirements==='string'?model.requirements:JSON.stringify(model.requirements,null,2);if(text)children.push(node('p','field-help',plainMessage(text)));}
  if(model.missing?.length)children.push(node('p','field-help',`缺失 ${model.missing.length} 个文件，可重新下载修复。`));
  if(model.install_path){const path=node('div','install-path');path.append(node('span','field-label',model.manual_install?'权重导入目录':'模型下载保存位置'),rawNode('code','',model.install_path));if(model.manual_install)path.append(node('p','field-help','放入下方所列文件后刷新模型。'));children.push(path);}
  const actions=node('div','detail-actions');
  if(model.installed)actions.append(button('选用模型','button primary full',()=>navigate(routeForModel(model),true,model.id)));
  else if(model.installable)actions.append(button('下载模型','button primary full',event=>runAction(event.currentTarget,()=>startDownload(model.id))));
  else{actions.append(button('需要手动准备权重','button secondary full',()=>{}));actions.lastChild.disabled=true;if(model.install_path)actions.append(button('复制模型位置','button secondary full',async()=>{try{await navigator.clipboard.writeText(model.install_path);showToast('模型位置已复制');}catch{showToast('请选中上方模型位置手动复制。');}}));}
  if(model.deletable)actions.append(button('删除本地模型','button danger full',event=>runAction(event.currentTarget,()=>showModelDeletion(model.id))));
  children.push(actions);
  const sources=[...(model.sources?.length?model.sources.map(s=>({url:s.url,label:'适配权重 · '+s.label})):[{url:model.source,label:'查看模型来源'}]),...(model.original_sources||[]).map(url=>({url,label:'原作者模型 · '+new URL(url).pathname.slice(1)}))];
  for(const source of sources){const url=sourceLink(source.url);if(url){const a=rawNode('a','detail-source',source.label+' ↗');a.href=url;a.target='_blank';a.rel='noopener noreferrer';children.push(a);}}
  if(model.info_checked_at)children.push(node('p','field-help',`资料核对：${model.info_checked_at}`));
  if(model.files?.length){const details=node('details','details-files');details.append(node('summary','',`模型文件（${model.files.length}）`));const list=node('ul');for(const f of model.files)list.append(rawNode('li','',typeof f==='string'?f:f.name||f.path||shortText(f)));details.append(list);children.push(details);}
  replace(panel,...children);
}
async function startDownload(id) { const token=$('hf-token').value.trim();await api(`/downloads/${encodeURIComponent(id)}`,{method:'POST',body:{token}});$('hf-token').value='';showToast('正在准备下载，自动选择线路。');await pollDownloads();$('download-list').scrollIntoView({behavior:'smooth',block:'nearest'}); }
const DOWNLOAD_NAMES={queued:'等待下载',pending:'等待下载',starting:'准备中',preparing:'准备中',probing:'检测线路',running:'下载中',downloading:'下载中',paused:'已暂停',pausing:'正在暂停',completed:'已完成',complete:'已完成',done:'已完成',error:'下载失败',failed:'下载失败',cancelled:'已取消',canceled:'已取消',installing:'正在安装',verifying:'正在校验'};
function activeDownload(d){return ['queued','pending','starting','preparing','probing','running','downloading','installing','verifying','pausing'].includes(d.status);}
function downloadRouteLabel(route){const value=plainMessage(shortText(route));const known={'HF official direct':'HF 官方直连','HF official via detected proxy':'HF 官方 · 自动检测代理','HF mirror direct':'HF 镜像直连','HF mirror via detected proxy':'HF 镜像 · 自动检测代理',official:'HF 官方直连',mirror:'HF 镜像直连',proxy:'自动检测代理',auto:'自动选择',probing:'正在检测线路'};return known[value]||value.replace(/HF official/g,'HF 官方').replace(/HF mirror/g,'HF 镜像').replace(/via detected proxy/g,'· 自动检测代理').replace(/\bdirect\b/g,'直连');}
let downloadPolling=false;
async function pollDownloads() {
  if(downloadPolling)return;downloadPolling=true;
  try{const data=await api('/downloads');const previous=state.downloads;state.downloads=data.downloads||[];renderDownloads();if(state.downloads.some(d=>['done','complete','completed'].includes(d.status)&&!previous.some(p=>p.id===d.id&&p.status===d.status))){await loadCatalog();if(state.libraryModel)selectLibraryModel(state.libraryModel);}}
  catch(error){if(state.page==='models'&&!state.downloads.length)replace($('download-list'),node('p','muted small',friendlyError(error)));}
  finally{downloadPolling=false;}
}
function downloadMessage(download) {const el=node('div','download-message');el.append(node('span','',DOWNLOAD_NAMES[download.status]||download.status));if(download.message)el.append(document.createTextNode(' · '),node('span','',downloadRouteLabel(download.message)));return el;}
function renderDownloads() {
  const active=state.downloads.filter(activeDownload).length;$('download-badge').textContent=active;$('download-badge').hidden=!active;$('downloads-count').textContent=state.downloads.length?`(${state.downloads.length})`:'';
  const children=state.downloads.map(d=>{const item=node('div','download-item');const top=node('div','download-top');const info=node('div');info.append(node('div','download-name',d.label||d.model||d.id),downloadMessage(d));const actions=node('div','download-actions');
    const act=(action,label)=>button(label,'button secondary small-button',event=>runAction(event.currentTarget,async()=>{await api(`/downloads/${encodeURIComponent(d.model||d.id)}/${action}`,{method:'POST',body:{}});await pollDownloads();}));
    if(['queued','pending','starting','preparing','probing','running','downloading'].includes(d.status))actions.append(act('pause','暂停'));
    if(['paused','failed','error','cancelled','canceled'].includes(d.status))actions.append(act('resume',d.status==='paused'?'继续':'重试'));
    if(activeDownload(d)||d.status==='paused')actions.append(act('cancel','取消'));
    top.append(info,actions);item.append(top);
    const total=Number(d.total_bytes),done=Number(d.bytes)||0;const progress=node('div','download-progress');const fill=node('span');fill.style.width=`${total>0?Math.min(100,done/total*100):['done','complete','completed'].includes(d.status)?100:0}%`;progress.append(fill);item.append(progress);
    const meta=node('div','download-meta');meta.append(node('span','',`${done?formatBytes(done):'0 B'} / ${formatBytes(total)}`));if(d.speed)meta.append(node('span','',typeof d.speed==='number'?`${formatBytes(d.speed)}/s`:d.speed));if(d.eta)meta.append(node('span','',`剩余 ${typeof d.eta==='number'?formatDuration(d.eta):d.eta}`));if(d.route){const route=node('span');route.append(node('span','','线路：'),node('span','',downloadRouteLabel(d.route)));meta.append(route);};item.append(meta);return item;});
  replace($('download-list'),...(children.length?children:[node('p','muted small','暂无下载任务')]));
}

let apiSequence=0;
async function loadApiDocs() {
  const seq=++apiSequence;
  try{const docs=await api('/api-docs');if(seq!==apiSequence)return;uiText($('api-base'), docs.base_url||'服务尚未启动');uiText($('api-model'), docs.model||'尚未加载模型');
    const children=(docs.endpoints||[]).map(endpoint=>{const card=node('section','card');const heading=node('div','card-heading');const title=node('div','endpoint-title');title.append(node('span','http-method',endpoint.method||'POST'),node('h2','',endpoint.title||endpoint.path));heading.append(title);card.append(heading);card.append(node('p','muted small',endpoint.description||''));card.append(node('p','small',endpoint.path));
      const tabs=node('div','code-tabs'),code=node('pre','code-block');let language='python';const options={python:endpoint.example_python||'# 暂无 Python 示例',curl:endpoint.example_curl||'# 暂无 cURL 示例'};
      for(const lang of ['python','curl']){const b=button(lang==='python'?'Python':'cURL',lang===language?'active':'',()=>{language=lang;for(const other of tabs.querySelectorAll('[data-code-lang]'))other.classList.toggle('active',other.dataset.codeLang===lang);code.textContent=options[lang];});b.dataset.codeLang=lang;tabs.append(b);}
      tabs.append(button('复制代码','copy-button',async()=>{try{await navigator.clipboard.writeText(options[language]);showToast('代码已复制');}catch{showToast('浏览器未允许复制，请选中代码手动复制。');}}));code.textContent=options[language];card.append(tabs,code);return card;});replace($('api-endpoints'),...(children.length?children:[node('div','card','加载模型后显示调用示例')]));
  }catch(error){if(seq===apiSequence)replace($('api-endpoints'),node('div','card',friendlyError(error)));}
}
function modelLabel(id) {return state.catalog?.models?.find(m=>m.id===id)?.label||(id==='qwen3-asr'?'Qwen3-ASR 0.6B':id);}
function updateResidentModel(model='') {
  const status=$('resident-model'),online=$('connection-status').dataset.state==='online';
  status.hidden=!model;uiAttr(status, 'title', model?`常驻模型 · ${modelLabel(model)} · ${sourceText($('sidebar-status'))}`:'');uiAttr(status, 'aria-label', model?`常驻模型 · ${modelLabel(model)} · ${sourceText($('sidebar-status'))}`:'');
  uiText($('resident-model-name'),modelLabel(model));
  status.querySelector('.status-dot').classList.toggle('online',online);
}
function updateHomeStatus() {
  const runtime=state.runtime,hardware=runtime?.hardware||state.catalog?.hardware||{};
  const online=!!runtime,main=runtime?.server?.model,asr=runtime?.asr?.model;
  const label=modelLabel;
  uiText($('home-service'), online?'本地服务在线':sourceText($('sidebar-status')));
  $('home-version').textContent=state.catalog?.version||'0.7.0';
  $('home-hardware').textContent=hardware.name||backendLabel(hardware.backend);
  uiText($('home-hardware-detail'), [hardware.vram_gb?`${Number(hardware.vram_gb).toFixed(1)} GB 显存`:'',hardware.backend?`推理后端 · ${backendLabel(hardware.backend)}`:''].filter(Boolean).join(' · '));
  const models=[...(main?[{id:main,role:'任务模型'}]:[]),...(asr?[{id:asr,role:'常驻识别服务'}]:[])];
  uiText($('home-resident-count'), `${models.length} 个运行中`);
  const signature=JSON.stringify({online,models:models.map(m=>({...m,label:label(m.id)}))});
  if($('home-resident-list').dataset.models!==signature){
    $('home-resident-list').dataset.models=signature;
    replace($('home-resident-list'),...(models.length?models.map(model=>{const card=node('div','home-resident'),copy=node('div');copy.append(node('strong','',label(model.id)),node('small','',model.role));card.append(icon('box'),copy,node('span','status-dot online'));return card;}):[node('p','muted small',online?'尚未加载模型':'服务离线，暂时无法读取模型状态')]));
  }
  const global=$('global-model-status');global.hidden=state.page==='workspace';
  global.dataset.state=online&&main?'ready':'';
  replace(global,node('span','',!online?sourceText($('sidebar-status')):main?`任务模型 · ${label(main)}`:'未加载任务模型'));
  uiAttr(global, 'title', sourceText(global.firstElementChild));
}
function updateStatus(data) {
  runtimeRevision++;
  data={...state.runtime,...data};
  const server=data.server||{},hardware=data.hardware||{},runtime=data.runtime||{};
  state.runtime={...data,busy:!!(runtime.busy||data.busy),realtime_active:!!(runtime.realtime_active||data.realtime_active)};
  const model=server.model||data.model;const text=model?(server.text||data.text||'模型已加载'):'未加载模型';
  uiText($('sidebar-status'), '本地服务在线');$('server-dot').classList.add('online');$('connection-status').dataset.state='online';uiAttr($('connection-status'), 'title', '本地服务在线');
  $('realtime-frame').contentWindow?.postMessage({type:'audiocpp:connection',online:true},location.origin);
  const vram=hardware.vram_gb?` · ${Number(hardware.vram_gb).toFixed(1)} GB`:'';$('hardware-label').textContent=`${backendLabel(hardware.backend||state.catalog?.hardware?.backend)}${vram}`;
  uiText($('settings-runtime'), `${plainMessage(text)}${data.asr?.model?` · 常驻识别模型：${data.asr.model==='qwen3-asr'?'Qwen3-ASR 0.6B':data.asr.model}`:''}`);
  updateResidentModel(data.asr?.model);updateHomeStatus();
  for(const id of ['unload-model','unload-all-models'])$(id).disabled=!!(runtime.busy||data.busy||runtime.realtime_active||data.realtime_active);
  updateRunButton();updateRealtimeBadge();
}
async function pollStatus() {
  if(statusPoll)return statusPoll;
  const revision=runtimeRevision;
  statusPoll=(async()=>{
    try{const data=await api('/status');if(revision===runtimeRevision)updateStatus(data);}
    catch{if(revision!==runtimeRevision)return;state.runtime=null;uiText($('sidebar-status'), state.shuttingDown?'本地服务已退出':'本地服务离线');$('server-dot').classList.remove('online');$('connection-status').dataset.state='offline';uiAttr($('connection-status'), 'title', sourceText($('sidebar-status')));updateResidentModel();$('realtime-frame').contentWindow?.postMessage({type:'audiocpp:connection',online:false},location.origin);updateHomeStatus();updateRunButton();updateRealtimeBadge();}
  })();
  try{await statusPoll;}finally{statusPoll=null;}
}
$('unload-model').addEventListener('click',event=>runAction(event.currentTarget,async()=>{const result=await api('/unload',{method:'POST',body:{}});updateStatus(result);showToast('已卸载模型，文件仍保留在本地');await pollStatus();}));
$('unload-all-models').addEventListener('click',event=>runAction(event.currentTarget,async()=>{const result=await api('/unload-all',{method:'POST',body:{}});updateStatus(result);showToast(result.message);await pollStatus();}));
async function loadRuntimeInfo() {
  try{const info=await api('/health');state.health=info;uiText($('runtime-health'), info.shutting_down?'正在退出本地服务…':`本地服务已就绪 · PID ${info.pid||'未知'}`);$('shutdown-service').disabled=!info.shutdown_available||info.shutting_down;}
  catch(error){uiText($('runtime-health'), friendlyError(error));$('shutdown-service').disabled=true;}
  try{const data=await api('/logs');state.runtimeLogText=(data.logs||[]).map(log=>`[${log.name}${log.truncated?' · 尾部记录':''}]\n${log.text||'暂无日志'}`).join('\n\n');$('runtime-logs').textContent=state.runtimeLogText||'暂无日志。';}
  catch(error){uiText($('runtime-logs'), friendlyError(error));}
}
$('refresh-runtime-logs').addEventListener('click',loadRuntimeInfo);
$('download-runtime-logs').addEventListener('click',event=>{event.preventDefault();if(!state.runtimeLogText){showToast('暂无可导出的日志。');return;}const url=URL.createObjectURL(new Blob([state.runtimeLogText],{type:'text/plain;charset=utf-8'}));const a=node('a');a.href=url;a.download='audiocpp-runtime.log';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
$('shutdown-service').addEventListener('click',event=>runAction(event.currentTarget,async()=>{
  if(!state.health?.shutdown_available)return;
  if((state.job||state.runtime?.busy||state.runtime?.realtime_active)&&!window.confirm(t('退出本地服务将结束当前任务或实时会话。确定退出？')))return;
  await api('/shutdown',{method:'POST',headers:{'X-Workbench-Shutdown':state.health.shutdown_token},body:{}});state.shuttingDown=true;uiText($('runtime-health'), '本地服务正在退出。重新使用时请运行启动器。');showToast('正在退出本地服务');
}));
window.addEventListener('beforeunload',event=>{if(state.recorders.size||state.job||state.referenceJob){event.preventDefault();event.returnValue='';}});

async function initialize() {
  try{
    try{await navigate(location.hash.slice(1)||'home',false);}catch(error){showToast(friendlyError(error));}
    await Promise.all([
      refreshReferences().catch(()=>{}),
      loadCatalog().catch(error=>{uiText($('connection-error'), friendlyError(error));$('connection-error').hidden=false;}),
      pollStatus(),
    ]);
  }finally{
    initializing=false;if(state.page==='workspace'){renderInputs();renderParameters();}updateRunButton();
  }
  await pollDownloads();
  setInterval(()=>{if(!document.hidden||state.downloads.some(activeDownload))pollDownloads();},2500);
  setInterval(()=>{if(!document.hidden)pollStatus();},7000);
}
initialize();

applyLanguage();
const uiLanguage=document.getElementById('ui-language');
uiLanguage.value=getLanguage();
uiLanguage.addEventListener('change',event=>setLanguage(event.target.value));
window.addEventListener('audiocpp:language',()=>{
  uiLanguage.value=getLanguage();
  const frame=$('realtime-frame');
  if(frame.hasAttribute('src'))frame.contentWindow?.postMessage({type:'audiocpp:language',language:getLanguage()},location.origin);
});
