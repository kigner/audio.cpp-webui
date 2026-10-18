import {t, uiText, uiAttr, html, textHTML, applyLanguage} from './i18n.js';
const LANGUAGES=[['en','英语'],['zh','中文'],['ja','日语'],['ko','韩语'],['fr','法语'],['de','德语'],['es','西班牙语'],['it','意大利语'],['pt','葡萄牙语'],['ru','俄语'],['ar','阿拉伯语']];
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const terminal=status=>['completed','done','failed','cancelled','error'].includes(status);
const clock=value=>{const n=Math.max(0,Math.round(Number(value||0)*1000));return `${String(Math.floor(n/3600000)).padStart(2,'0')}:${String(Math.floor(n/60000)%60).padStart(2,'0')}:${String(Math.floor(n/1000)%60).padStart(2,'0')}.${String(n%1000).padStart(3,'0')}`;};
function seconds(value){if(/^\d+(\.\d+)?$/.test(value))return Number(value);const match=/^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(value);return match&&Number(match[2])<60&&Number(match[3])<60?Number(match[1])*3600+Number(match[2])*60+Number(match[3])+Number(match[4].padEnd(3,'0'))/1000:NaN;}
const langName=value=>value==='auto'?'自动检测':LANGUAGES.find(([id])=>id===value)?.[1]||value||'自动检测';

export function createScenarioStudio({root,api,showToast,navigate,plainMessage=value=>String(value??'')}){
  const preferenceKey='audiocpp.scenario.preferences';
  const state={scenario:'subtitles',step:'import',project:null,resumeId:null,capabilities:{},media:null,subtitle:null,dirty:false,busy:false,job:null,error:'',llmOpen:false,filter:'',generation:0,...readPreferences()};
  let timer=null,saveTimer=null,saveChain=Promise.resolve(),editVersion=0,activeAudio=null,capabilityGeneration=0,clipEnd=null,clipTimer=null;
  let followPlayback=true;
  let referenceRecorder=null,referenceRequest=null,referenceEpoch=0;
  const referenceBusy=()=>!!referenceRecorder||!!referenceRequest||!!state.referenceJob;
  function stopReferenceRecording(){referenceEpoch++;referenceRequest=null;const recorder=referenceRecorder;referenceRecorder=null;if(recorder?.state==='recording')recorder.stop();referenceActivity();}
  new MutationObserver(()=>{if(root.hidden){stopReferenceRecording();void cancelReferenceTranscription();}}).observe(root,{attributes:true,attributeFilter:['hidden']});
  window.addEventListener('pagehide',stopReferenceRecording);
  const subtitleUrls=new Map();
  const settingsObserver=new ResizeObserver(()=>fitCueList());
  function preferenceValues(source){
    const values={};
    for(const key of ['asr_model','tts_model','tts_voice'])if(typeof source[key]==='string')values[key]=source[key].slice(0,200);
    for(const key of ['source_language','target_language'])if(LANGUAGES.some(([id])=>id===source[key])||key==='source_language'&&source[key]==='auto')values[key]=source[key];
    for(const key of ['has_background','video_follows_audio','tts_user_choice'])if(typeof source[key]==='boolean')values[key]=source[key];
    for(const key of ['voice_volume','background_volume']){const value=source.mix?.[key];if(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=(key==='voice_volume'?1.5:1))(values.mix||={})[key]=value;}
    if(['translation','bilingual','none'].includes(source.options?.subtitle_mode))values.options={subtitle_mode:source.options.subtitle_mode};
    return values;
  }
  function readPreferences(){try{return preferenceValues(JSON.parse(localStorage.getItem(preferenceKey)||'{}')||{});}catch{return {};}}
  function rememberPreferences(){const preferences=preferenceValues({...state,...state.project,tts_user_choice:!!state.tts_user_choice});try{localStorage.setItem(preferenceKey,JSON.stringify(preferences));}catch{}return preferences;}
  function releasePlayback(){
    clearTimeout(clipTimer);clipEnd=null;activeAudio?.pause();activeAudio?.removeAttribute?.('src');activeAudio?.load?.();activeAudio=null;
    root.querySelectorAll('audio,video').forEach(player=>{player.pause();player.removeAttribute('src');player.load();});
  }
  function clearSession(){
    clearTimeout(timer);clearTimeout(saveTimer);releasePlayback();
    for(const url of subtitleUrls.values())URL.revokeObjectURL(url);subtitleUrls.clear();
    state.generation++;capabilityGeneration++;editVersion++;followPlayback=true;
    Object.assign(state,{project:null,resumeId:null,media:null,subtitle:null,step:'import',dirty:false,job:null,filter:'',error:'',operation:'',llmOpen:false,llmDraft:null,referenceMessage:'',referenceName:'',referenceNameFor:null});
    try{localStorage.removeItem('audiocpp.scenario.project');}catch{}
  }
  const route=path=>`/scenarios${path}`;
  const projectRoute=()=>route(`/projects/${encodeURIComponent(state.project.id)}`);
  const segments=()=>state.project?.segments||[];
  const busy=()=>state.busy||referenceBusy()||!!state.job&&(!terminal(state.job.status)||state.job.synchronized===false);
  function referenceActivity(){
    if(!root||root.hidden)return;
    for(const control of root.querySelectorAll('button,input,select,textarea')){
      if(control.closest('[data-scene-reference-upload]')||control.dataset.sceneAction==='reference-stop')continue;
      if(referenceBusy()){if(!control.hasAttribute('data-reference-locked'))control.dataset.referenceLocked=String(control.disabled);control.disabled=true;}
      else if(control.hasAttribute('data-reference-locked')){control.disabled=control.dataset.referenceLocked==='true';delete control.dataset.referenceLocked;}
    }
  }
  const btn=(label,action,kind='',attrs='')=>html`<button type="button" class="button ${kind||'secondary'}" data-scene-action="${action}" ${attrs}>${textHTML(label)}</button>`;
  const field=(label,body,help='')=>`<label class="scene-field">${textHTML(label)}${body}${help?`<small>${textHTML(plainMessage(help))}</small>`:''}</label>`;
  const options=(items,value)=>items.map(([id,label,raw])=>`<option value="${escape(id)}" ${id===value?'selected':''} ${raw?'':`data-i18n="${escape(label)}"`}>${escape(raw?label:t(label))}</option>`).join('');
  const select=(key,items,value)=>`<select data-scene-field="${key}" ${busy()?'disabled':''}>${options(items,value)}</select>`;
  function error(message){state.error=plainMessage(message)||'操作未完成，请重试。';render();showToast(state.error);}
  function scheduleSave(){clearTimeout(saveTimer);if(!state.project||!state.dirty)return;saveTimer=setTimeout(()=>{if(!busy())save().catch(e=>error(`修改暂未写入：${e.message}。请重试当前操作。`));},500);}
  function markDirty(){editVersion++;state.dirty=true;state.error='';scheduleSave();}
  function edited(input){markDirty();const ready=root.querySelector('[data-scene-action="voice-ready"]');if(ready)ready.disabled=segments().some(invalidAudio);const exportButton=root.querySelector('[data-scene-action="export"]');if(exportButton)exportButton.disabled=!state.project?.preview;root.querySelector('.scene-downloads')?.classList.add('scene-downloads-stale');const row=input.closest('.scene-cue,.scene-translation-cue,.scene-voice-cue');if(row&&state.scenario==='dubbing'&&!row.querySelector('.scene-stale')){const note=document.createElement('small');note.className='scene-stale scene-edit-note';uiText(note, input.dataset.sceneEdit==='text'?'原文已修改，相关译文与配音需更新':input.dataset.sceneTime?'时间已修改，请重新确认并检查混音':input.hasAttribute('data-scene-speed')?'配音倍速已调整，需重新混音':'修改已记录，相关配音需重新生成');row.append(note);}if(root.querySelector('[data-scene-player="preview"]')&&!state.project?.preview){const media=root.querySelector('.scene-media');if(media){media.dataset.previewStale='';uiAttr(media, 'title', '混音参数已修改，请重新生成混音预览。');}}syncSubtitleTracks();}
  function selectedModel(kind){return state.project?.[`${kind}_model`]||state[`${kind}_model`]||state.capabilities[`recommended_${kind}`]?.id||'';}
  function supportsLanguage(model,language){const aliases={english:'en',chinese:'zh',japanese:'ja',korean:'ko',french:'fr',german:'de',spanish:'es',italian:'it',portuguese:'pt',russian:'ru',arabic:'ar'};return model&&(!model.languages?.length||model.languages.some(v=>(aliases[String(v).toLowerCase()]||String(v).toLowerCase().split(/[-_]/)[0])===language));}
  function modelPicker(kind){
    const models=state.capabilities[`${kind}_models`]||[],selected=selectedModel(kind),recommended=state.capabilities[`recommended_${kind}`];
    const values=models.map(model=>[model.id,`${model.name}${model.id===recommended?.id?' · 推荐':''}${model.installed?'':' · 未安装'}`]);
    if(selected&&!values.some(([id])=>id===selected))values.unshift([selected,selected]);
    return `<div class="scene-model-choice">${select(`${kind}_model`,[['','选择模型'],...values],selected)}</div>`;
  }
  function originalPath(file){const value=file?.path||'';return /^(?:[a-z]:[\\/]|\\\\)/i.test(value)&&!/[\\/]fakepath[\\/]/i.test(value)?value:'';}
  function mediaPath(){return state.project?.media?.source_path||state.project?.media?.uploaded_path||'';}
  function syncSubtitleTracks(){
    const used=new Set(),p=state.project;
    for(const video of root.querySelectorAll('video[data-scene-caption]')){
      const layer=video.dataset.sceneCaption==='source'?'source':p?.options?.subtitle_mode||'translation',previous=video.querySelector('track[data-scene-subtitle]');
      if(!p||layer==='none'||!segments().length){previous?.remove();continue;}
      const clean=value=>String(value??'').replace(/\r\n?/g,'\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/\n[ \t]*\n+/g,'\n').trim().replace(/[&<>]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[char]));
      const timed=videoFollowsAudio()&&video.dataset.sceneCaption==='output'&&p.preview?p.output_timeline?.segments:null,byId=new Map((timed||[]).map(s=>[String(s.id),s]));
      const cues=segments().map(s=>{const timing=byId.get(String(s.id));return timing?{...s,start:timing.start,end:timing.end}:s;});
      const content='WEBVTT\n\n'+cues.filter(s=>Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.end>s.start).map((s,i)=>`${i+1}\n${clock(s.start)} --> ${clock(s.end)}\n${clean(layer==='source'?s.text:layer==='bilingual'?`${s.text}\n${s.translation||''}`:s.translation)}\n`).join('\n');
      const language=(layer==='source'?p.detected_language||p.source_language:p.target_language)||'und',srclang=language==='auto'?'und':language,key=JSON.stringify([layer,srclang,content]);
      let url=subtitleUrls.get(key);if(!url){url=URL.createObjectURL(new Blob([content],{type:'text/vtt;charset=utf-8'}));subtitleUrls.set(key,url);}used.add(url);
      if(previous?.getAttribute('src')===url)continue;
      previous?.remove();const track=document.createElement('track');track.dataset.sceneSubtitle=layer;track.kind='subtitles';track.default=true;track.srclang=srclang;uiAttr(track,'label',layer==='bilingual'?'双语字幕':`${langName(language)}字幕`);track.src=url;track.addEventListener('load',()=>{track.track.mode='showing';},{once:true});video.append(track);track.track.mode='showing';
    }
    for(const [key,url]of subtitleUrls)if(!used.has(url)){URL.revokeObjectURL(url);subtitleUrls.delete(key);}
  }
  const playbackTime=value=>{const n=Math.max(0,Math.floor(Number(value)||0));return `${Math.floor(n/60).toString().padStart(2,'0')}:${(n%60).toString().padStart(2,'0')}`;};
  function copyPathButton(){return btn('复制路径','copy-path','subtle small-button scene-copy-path',`data-i18n-title="${state.project?.media?.source_path?'复制原文件路径':'复制上传后的文件路径'}" title="${t(state.project?.media?.source_path?'复制原文件路径':'复制上传后的文件路径')}" ${mediaPath()?'':'disabled'}`);}
  function replaceMedia(){return state.step==='import'?`${btn('更换素材','upload','secondary small-button',busy()?'disabled':'')}<input type="file" data-scene-upload="media" accept="audio/*,video/*,.mkv" hidden>`:'';}
  function mediaView(preview=false){
    const p=state.project;if(!p?.media?.url)return '';
    const source=preview?p.preview?.url:p.media.url;if(!source)return '';
    const video=p.media.has_video&&(preview?/\.(mp4|webm|mov)(\?|$)/i.test(source)||p.preview?.has_video:!preview);
    if(!preview&&!video)return html`<div class="scene-media scene-audio"><audio data-scene-player="source" preload="metadata" src="${escape(source)}" hidden></audio><div class="scene-audio-controls"><button type="button" class="scene-play" data-scene-action="play-source" aria-label="播放素材">▶</button><span class="scene-player-time" data-scene-current>00:00</span><input type="range" data-scene-seek min="0" max="${Number(p.media.duration)||0}" step="0.01" value="0" aria-label="播放进度"><span class="scene-player-time">${playbackTime(p.media.duration)}</span><button type="button" class="scene-mute icon-button" data-scene-action="mute-source" aria-label="静音" aria-pressed="false"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4Z M15 8c3 2 3 6 0 8 M18 5c5 4 5 10 0 14"/></svg></button><select data-scene-rate aria-label="播放速度">${options([['0.75','0.75×'],['1','1.0×'],['1.25','1.25×'],['1.5','1.5×'],['2','2.0×']],'1')}</select></div><div class="scene-source-meta"><span class="scene-source-name" title="${escape(p.media.name)}">${escape(p.media.name)}</span>${replaceMedia()}${copyPathButton()}${state.step!=='export'?newMediaButton():''}</div></div>`;
    if(preview&&p.media.has_video&&!video&&!videoFollowsAudio())return html`<div class="scene-media is-video"><video data-scene-sync-video data-scene-caption="output" muted playsinline preload="metadata" src="${escape(p.media.url)}"></video><audio data-scene-player="preview" controls preload="metadata" src="${escape(source)}"></audio><div class="scene-media-caption"><span>画面对齐预览 · 新配音与背景混音</span><span>${clock(p.media.duration)}</span></div></div>`;
    return `<div class="scene-media ${video?'is-video':''}"><${video?'video':'audio'} ${video?`data-scene-caption="${preview?'output':'source'}"`:''} data-scene-player="${preview?'preview':'source'}" controls preload="metadata" src="${escape(source)}"></${video?'video':'audio'}><div class="scene-media-caption"><span>${preview?textHTML('混音预览'):escape(p.media.name)}</span><span>${clock(preview?(p.preview?.duration??p.output_timeline?.duration??p.media.duration):p.media.duration)}</span></div>${preview?'':`<div class="scene-source-meta">${replaceMedia()}${copyPathButton()}${state.step!=='export'?newMediaButton():''}</div>`}</div>`;
  }
  function jobMessage(job){
    if(!job)return state.operation||'准备任务';
    if(job.status==='cancelling')return '正在停止';
    if(terminal(job.status))return ['error','failed'].includes(job.status)?'任务失败':job.status==='cancelled'?'任务已停止':'更新结果';
    const message=plainMessage(job.message||''),stage=job.stage||job.action;
    if(job.status==='queued'||/准备[.…]*$|任务已提交/.test(message))return '准备任务';
    if(/准备.*(?:模型|分离|对齐|识别|配音)|Preparing model/i.test(message))return ({separate:'加载分离模型',align:'加载对齐模型',recognize:'加载识别模型',synthesize:'加载配音模型'})[stage]||'加载模型';
    const label=/合并音频|Merging audio/i.test(message)?'合并音频':/保存音频|Saving audio/i.test(message)?'保存音频':/精简/.test(message)?'精简译文':({extract:'提取音轨',separate:'分离人声',recognize:'识别字幕',align:'对齐时间',translate:'翻译字幕',synthesize:'生成配音',mix:'检查混音',export:'导出成品',export_subtitles:'导出字幕'})[stage]||'处理任务';
    const count=/(\d+)\s*\/\s*(\d+)/.exec(message);
    return label+(count?` ${count[1]}/${count[2]}`:'');
  }
  function activeJob(){return state.job&&terminal(state.job.status)&&state.job.synchronized!==false?null:state.job;}
  function progressPercent(){const job=activeJob(),value=job?job.progress:state.operationProgress;return value==null?NaN:Number(value);}
  function renderTaskMessage(){return busy()?`<span class="scene-job-message ${Number.isFinite(progressPercent())?'':'scene-waiting'}" data-scene-job-message role="status" aria-live="polite">${textHTML(jobMessage(activeJob()))}</span>`:'';}
  function renderJob(){
    if(!busy())return '';
    const job=activeJob(),running=job&&!terminal(job.status),percent=progressPercent();
    if(!Number.isFinite(percent)&&!running)return '';
    return `<div class="scene-progress">${Number.isFinite(percent)?html`<progress max="100" value="${Math.min(100,Math.max(0,percent<=1?percent*100:percent))}" aria-label="任务进度"></progress>`:''}${running?btn(job.status==='cancelling'?'取消中…':'取消任务','stop','subtle small-button',job.status==='cancelling'?'disabled':''):''}</div>`;
  }
  function renderImportExtra(){
    if(state.scenario!=='dubbing')return renderTaskMessage();
    const hint=state.subtitle?state.subtitle.name:segments().length?'已有 '+segments().length+' 句字幕':'已有原文字幕，可跳过识别';
    return '<div class="scene-import-extra"><span class="small">'+(busy()?renderTaskMessage():state.subtitle?escape(hint):textHTML(hint))+'</span>'+btn('上传字幕','subtitle-upload','secondary small-button',busy()?'disabled':'')+'<input type="file" data-scene-upload="subtitle" accept=".srt,.vtt" hidden></div>';
  }
  async function savedProject(){
    if(!state.resumeId)return null;
    try{const result=await api(route('/projects/'+encodeURIComponent(state.resumeId)));return result.project||result;}
    catch(e){if(e.status!==404)throw e;state.resumeId=null;try{localStorage.removeItem('audiocpp.scenario.project');}catch{}return null;}
  }
  function updateJob(){const container=root.querySelector('[data-scene-progress]');if(container){const markup=renderJob();if(container._progressMarkup!==markup){container.innerHTML=markup;container._progressMarkup=markup;}}const label=root.querySelector('[data-scene-job-message]');if(label){uiText(label, jobMessage(activeJob()));label.classList.toggle('scene-waiting',!Number.isFinite(progressPercent()));}const errorBox=root.querySelector('[data-scene-error]');if(errorBox){errorBox.hidden=!state.error;uiText(errorBox, plainMessage(state.error));}}
  function render(){
    if(!root)return;
    if(root.querySelector('[data-scene-reference-upload]'))stopReferenceRecording();
    const modelStatus=root.querySelector('#global-model-status')||(!root.hidden?document.getElementById('global-model-status'):null);
    const steps=state.scenario==='subtitles'?[['import','导入素材'],['review','校对字幕'],['export','导出字幕']]:[['import','导入素材'],['review','校对原文'],['translate','翻译校对'],['voice','逐句配音'],['export','混音导出']];
    const oldPlayer=root.querySelector('[data-scene-player="source"]');
    root.innerHTML=html`<header class="workspace-page-heading scene-navigation page-topbar"><button type="button" class="icon-button" data-scene-action="back" aria-label="返回场景应用"><svg class="icon" aria-hidden="true"><use href="#icon-arrow-left"/></svg></button><h1>场景应用</h1></header><div class="scene-toolbar"><div class="scene-title"><h2>${textHTML(state.scenario==='subtitles'?'自动字幕':'视频译配')}</h2></div></div><nav class="scene-steps" aria-label="工作步骤">${steps.map(([id,label],i)=>`<button type="button" data-scene-step="${id}" title="${escape(t(label)+(stepDone(id)?' · '+t('已完成'):''))}" data-i18n-title="${escape(label+(stepDone(id)?' · 已完成':''))}" aria-label="${escape(t(label)+(stepDone(id)?' · '+t('已完成'):''))}" data-i18n-aria-label="${escape(label+(stepDone(id)?' · 已完成':''))}" class="${state.step===id?'active':''}" ${state.step===id?'aria-current="step"':''}><span>${i+1}</span>${textHTML(label)}${stepDone(id)?html`<b aria-label="已完成">完成</b>`:''}</button>`).join('')}</nav><div class="scene-stage card" aria-busy="${busy()}">${({import:renderImport,review:renderReview,translate:renderTranslate,voice:renderVoice,export:renderExport})[state.step]()}<div class="scene-stage-status" data-scene-progress>${renderJob()}</div></div><div class="notice error scene-error" data-scene-error role="alert" ${state.error?'':'hidden'}>${textHTML(plainMessage(state.error))}</div>`;
    if(modelStatus)root.querySelector('.scene-navigation').append(modelStatus);
    const referenceUpload=root.querySelector('[data-scene-reference-upload]');
    if(referenceUpload)mountReferenceUpload(referenceUpload);
    if(referenceUpload&&busy())referenceUpload.querySelectorAll('button,input').forEach(control=>control.disabled=true);
    const newPlayer=root.querySelector('[data-scene-player="source"]');
    if(oldPlayer&&newPlayer&&oldPlayer.src===newPlayer.src&&oldPlayer.tagName===newPlayer.tagName)newPlayer.replaceWith(oldPlayer);
    else {oldPlayer?.pause();clipEnd=null;clearTimeout(clipTimer);}
    settingsObserver.disconnect();const settings=root.querySelector('.scene-translate-settings,.scene-voice-settings');if(settings)settingsObserver.observe(settings);
    applyLanguage(root);syncSubtitleTracks();resizeCueInputs();fitCueList();syncPlayback(root.querySelector('[data-scene-player="source"]'));
  }
  function stepDone(step){const p=state.project;return !!p&&({import:!!p.media,review:p.confirmed_source,translate:p.confirmed_translation,voice:p.confirmed_audio,export:!!p.exports?.length})[step];}
  function renderImport(){
    const p=state.project,hasSubs=!!segments().length||!!state.subtitle;
    return html`<div class="scene-import-grid"><div class="scene-import-media">${p?mediaView():html`<div class="scene-dropzone" data-scene-drop tabindex="0" role="button" aria-label="添加音频或视频"><svg class="icon" aria-hidden="true"><use href="#icon-file"/></svg><strong>拖入音频或视频文件</strong><span>MP4、MOV、MKV、WebM、WAV、MP3、M4A、FLAC</span><div class="scene-actions scene-resume-actions">${btn(state.resumeId?'更换素材':'选择文件','upload','primary',busy()?'disabled':'')}${state.resumeId?btn('继续上次任务','resume','secondary small-button',busy()?'disabled':''):''}</div><input type="file" data-scene-upload="media" accept="audio/*,video/*,.mkv" hidden></div>`}${renderImportExtra()}</div><div class="scene-import-options"><div class="scene-form-grid">${field('源语言',select('source_language',[['auto','自动检测'],...LANGUAGES],p?.source_language||state.source_language||'auto'))}${state.scenario==='dubbing'?field('目标语言',select('target_language',LANGUAGES,p?.target_language||state.target_language||'en')):''}<div class="scene-field"><span>识别模型</span>${modelPicker('asr')}</div>${state.scenario==='dubbing'?html`<div class="scene-field"><span>配音模型</span>${modelPicker('tts')}</div>`:''}</div><div class="scene-import-action"><label class="scene-check"><input type="checkbox" data-scene-field="has_background" ${(p?.has_background??state.has_background??true)?'checked':''} ${busy()?'disabled':''}>分离背景音乐</label>${btn(hasSubs?'下一步：校对字幕':'开始识别',hasSubs?'review':'recognize','primary',busy()||!p&&!state.media?'disabled':'')}</div></div></div>`;
  }
  function empty(message,label,step){return `<div class="scene-empty">${renderTaskMessage()}<p>${textHTML(plainMessage(message))}</p>${btn(label,`step-${step}`,'primary')}</div>`;}
  function edit(segment,index,key){return html`<textarea rows="1" data-scene-edit="${key}" data-segment="${escape(segment.id)}" aria-label="第 ${index+1} 句${key==='text'?'原文':'译文'}" ${busy()?'disabled':''}>${escape(segment[key])}</textarea>`;}
  function renderCueRows(){const list=visibleSegments();return list.length?list.map(({s,i})=>`<article class="scene-cue" data-scene-cue="${escape(s.id)}"><span class="scene-cue-number">${String(i+1).padStart(2,'0')}</span><div class="scene-cue-time">${['start','end'].map((key,j)=>html`${j?'<span aria-hidden="true">→</span>':''}<input type="text" value="${clock(s[key])}" data-scene-time="${key}" data-segment="${escape(s.id)}" aria-label="第 ${i+1} 句${key==='start'?'开始':'结束'}时间" ${busy()?'disabled':''}>`).join('')}</div>${edit(s,i,'text')}<div class="scene-cue-actions">${btn('播放本句','locate','subtle small-button',`data-segment="${escape(s.id)}"`)}</div></article>`).join(''):html`<p class="scene-no-matches">没有匹配的字幕</p>`;}
  function resizeCueInputs(){root.querySelectorAll('.scene-cues textarea').forEach(input=>{input.style.height='0px';input.style.height=`${Math.max(38,input.scrollHeight+2)}px`;});}
  function fitCueList(){
    const list=root.querySelector('.scene-review-editor .scene-cues,.scene-task-editor .scene-cues');if(!list)return;
    const contentHeight=[...list.children].reduce((height,row)=>height+row.getBoundingClientRect().height,0);
    list.style.setProperty('--scene-content-height',`${contentHeight}px`);if(innerWidth<=760){list.style.removeProperty('--scene-list-height');return;}
    const footer=root.querySelector('.scene-footer'),status=root.querySelector('.scene-stage-status'),footerHeight=footer.getBoundingClientRect().height+parseFloat(getComputedStyle(footer).marginTop)+(status?.getBoundingClientRect().height||0);
    const top=list.getBoundingClientRect().top,available=innerHeight-top-window.scrollY-footerHeight-72;
    if(list.closest('.scene-task-editor')){
      const settings=innerWidth>900?root.querySelector('.scene-translate-settings,.scene-voice-settings'):null;
      const aligned=settings?settings.getBoundingClientRect().bottom-top:0;
      list.style.setProperty('--scene-list-height',`${Math.max(240,aligned,settings?.matches('.scene-translate-settings')?0:available)}px`);
    }else list.style.setProperty('--scene-list-height',`${Math.min(contentHeight,Math.max(240,Math.min(640,innerHeight-top-footerHeight-72)))}px`);
  }
  window.addEventListener('resize',()=>{if(!root.hidden){resizeCueInputs();fitCueList();}});
  function stopAtCueEnd(player){
    clearTimeout(clipTimer);if(clipEnd===null||!player||player.paused)return;
    const remaining=clipEnd-player.currentTime;
    if(remaining<=.02){const end=clipEnd;clipEnd=null;player.pause();player.currentTime=end;return;}
    clipTimer=setTimeout(()=>stopAtCueEnd(player),Math.max(20,remaining/player.playbackRate*1000));
  }
  function syncPlayback(player){
    if(!player)return;
    const media=player.closest('.scene-audio');
    if(media){
      const play=media.querySelector('[data-scene-action="play-source"]'),seek=media.querySelector('[data-scene-seek]'),mute=media.querySelector('[data-scene-action="mute-source"]');
      uiText(play, player.paused?'▶':'Ⅱ');uiAttr(play, 'aria-label', player.paused?'播放素材':'暂停播放');
      uiText(media.querySelector('[data-scene-current]'), playbackTime(player.currentTime));
      if(Number.isFinite(player.duration))seek.max=player.duration;
      seek.value=player.currentTime;media.querySelector('[data-scene-rate]').value=String(player.playbackRate);
      uiAttr(mute, 'aria-label', player.muted?'取消静音':'静音');mute.setAttribute('aria-pressed',String(player.muted));
    }
    const current=segments().find(s=>player.currentTime>=s.start&&player.currentTime<s.end),list=root.querySelector('.scene-review-editor .scene-cues,.scene-task-editor .scene-cues');
    if(list){
      let activeRow=null,changed=false;
      for(const row of list.querySelectorAll('[data-scene-cue]')){
        const active=!player.paused&&row.dataset.sceneCue===current?.id;if(active){activeRow=row;changed=!row.classList.contains('playing');}
        row.classList.toggle('playing',active);uiText(row.querySelector('[data-scene-action="locate"]'), active&&!player.paused?'暂停':'播放本句');
      }
      if(activeRow&&changed&&!player.paused&&followPlayback&&!list.contains(document.activeElement)&&!state.filter){
        const bounds=list.getBoundingClientRect(),row=activeRow.getBoundingClientRect();
        if(row.top<bounds.top||row.bottom>bounds.bottom)list.scrollTop+=row.top-bounds.top;
      }
    }
    stopAtCueEnd(player);
  }
  function renderReview(){
    if(!segments().length)return busy()?`${mediaView()}<div class="scene-empty">${renderTaskMessage()}</div>`:empty('请先识别或导入字幕。','导入素材','import');
    return html`<div class="scene-review-grid ${state.project.media.has_video?'has-video':'audio-only'}"><div class="scene-review-media">${mediaView()}${renderTaskMessage()}</div><div class="scene-review-editor"><div class="scene-review-toolbar">${renderSearch()}<span class="muted small" data-scene-count>${state.filter?`${visibleSegments().length} / `:''}${segments().length} 句</span><label class="scene-follow"><input type="checkbox" data-scene-follow ${followPlayback?'checked':''}>跟随播放</label>${btn('重新识别','recognize','subtle small-button',busy()?'disabled':'')}</div><div class="scene-cue-head"><span>序号</span><span>开始 → 结束</span><span>字幕内容</span><span>试听</span></div><div class="scene-cues" tabindex="0" aria-label="字幕列表">${renderCueRows()}</div></div></div><div class="scene-footer">${btn('返回素材','step-import','subtle small-button')}${btn(state.scenario==='subtitles'?'下一步：导出字幕':'下一步：翻译校对','confirm-source','primary',busy()?'disabled':'')}</div>`;
  }
  function renderSearch(){return html`<input type="search" class="scene-search" data-scene-search value="${escape(state.filter)}" placeholder="搜索字幕内容" aria-label="搜索字幕内容">`;}
  function visibleSegments(){const q=state.filter.toLowerCase();return segments().map((s,i)=>({s,i})).filter(({s})=>!q||`${s.text} ${s.translation||''}`.toLowerCase().includes(q));}
  function llmSettings(){
    const defaults=state.capabilities.llm_defaults||{},value=key=>{if(state.llmDraft?.[key]!==undefined)return state.llmDraft[key];try{return localStorage.getItem(`audiocpp.llm.${key}`)||defaults[{url:'llm_base_url',model:'llm_model'}[key]]||defaults[key]||'';}catch{return '';}};
    return html`<div class="scene-llm-fields"><p class="muted small">与实时语音中的对话设置共用同一连接。密钥不会写入字幕内容。</p><div class="scene-form-grid">${field('API 地址',`<input type="url" data-scene-llm="url" value="${escape(value('url'))}" placeholder="https://…/v1" autocomplete="off">`)}${field('模型名称',html`<input data-scene-llm="model" value="${escape(value('model'))}" placeholder="对话模型 ID" autocomplete="off">`)}${field('API Key',`<input type="password" data-scene-llm="key" value="${escape(value('key'))}" placeholder="${t(defaults.llm_api_key_set||defaults.key_set?'已配置服务端密钥，可留空':'填写连接密钥')}" data-i18n-placeholder="${defaults.llm_api_key_set||defaults.key_set?'已配置服务端密钥，可留空':'填写连接密钥'}" autocomplete="off">`)}</div>${btn('保存连接设置','save-llm','secondary small-button')}</div>`;
  }
  function renderTranslate(){
    if(!state.project?.confirmed_source)return empty('请先校对并确认原文字幕。','校对原文','review');
    const translated=segments().some(s=>s.translation),p=state.project,list=visibleSegments();
    return html`<div class="scene-translate-grid"><aside class="scene-translate-settings">
      <div class="scene-translate-controls">${field('目标语言',select('target_language',LANGUAGES,p.target_language||'en'))}${btn('连接设置','llm','subtle small-button',`aria-expanded="${state.llmOpen}"`)}</div>
      ${state.llmOpen?llmSettings():''}
      ${field('翻译要求',html`<textarea rows="3" data-scene-field="translation_instructions" placeholder="自然口语、保留产品名、贴合原句时长" ${busy()?'disabled':''}>${escape(p.options?.translation_instructions||'')}</textarea>`)}
      <div class="scene-translate-start">${btn(translated?'重新翻译全部':'开始翻译','translate','primary',busy()?'disabled':'')}</div>${mediaView()}${renderTaskMessage()}
    </aside><div class="scene-task-editor"><div class="scene-review-toolbar">${renderSearch()}<span class="muted small">${textHTML(`${state.filter?`${list.length} / `:''}${segments().length} 句`)} · ${textHTML(langName(p.detected_language||p.source_language))} → ${textHTML(langName(p.target_language||'en'))}</span></div>
      <div class="scene-translation-head ${translated?'':'source-only'}"><span>时间</span><span>原文</span>${translated?html`<span>译文</span>`:''}</div>
      <div class="scene-cues scene-translation-cues" tabindex="0" aria-label="翻译字幕列表">${list.length?list.map(({s,i})=>`<article class="scene-translation-cue ${translated?'':'source-only'}"><div class="scene-cue-time"><span>${i+1} · ${clock(s.start)}</span>${translated?btn('重译','translate-one','subtle small-button',`data-segment="${escape(s.id)}" ${busy()?'disabled':''}`):''}</div><p>${escape(s.text)}</p>${translated?`<div>${edit(s,i,'translation')}${s.translation_stale?html`<small class="scene-stale">原文已修改，需重译</small>`:''}</div>`:''}</article>`).join(''):html`<p class="scene-no-matches">没有匹配的字幕</p>`}</div>
    </div></div><div class="scene-footer">${btn('返回原文','step-review','subtle small-button')}${translated?btn('下一步：逐句配音','confirm-translation','primary',busy()?'disabled':''):''}</div>`;
  }
  function videoFollowsAudio(){return !!state.project?.video_follows_audio;}
  function speedOf(s){if(videoFollowsAudio())return 1;const explicit=Number(s.speed);return Number.isFinite(explicit)&&explicit>0?explicit:Number(s.audio?.speed)||1;}
  function voiceWindow(s,i){return videoFollowsAudio()?Math.max(.001,Number(segments()[i+1]?.start??state.project.media.duration)-s.start):Math.max(.001,s.end-s.start);}
  function audioDuration(s){return Number(s.audio?.duration||0)/speedOf(s);}
  function audioOverrun(s){if(!s.audio)return 0;const duration=audioDuration(s),end=s.start+duration,next=segments()[segments().indexOf(s)+1]?.start??state.project.media.duration;return Math.max(0,duration-(s.end-s.start),end-next,end-state.project.media.duration);}
  function overflow(s){return audioOverrun(s)>.05;}
  function invalidAudio(s){return !s.audio?.url||s.audio_stale||s.audio.status==='stale'||s.translation_stale||(!videoFollowsAudio()&&overflow(s));}
  function referenceMode(model){return !(model?.accepts_voice_reference??model?.voice_mode==='reference')?'none':state.project?.tts_reference_mode||((model?.require_voice??model?.voice_mode==='reference')?'original':'none');}
  function autoReferenceText(){try{return JSON.parse(localStorage.getItem('audiocpp-reference-auto'))??true;}catch{return true;}}
  function referenceTools(model){const p=state.project,transcribe=model.send_reference_text!==false,uploaded=!!p.tts_reference;
    return html`<div class="scene-reference-tools">${transcribe?html`<div class="reference-actions">${btn('音频转录','reference-transcribe','secondary small-button',busy()||!uploaded?'disabled':'')}${btn('停止识别','reference-stop','subtle small-button','hidden')}<label class="check-label"><input type="checkbox" data-scene-reference-auto ${autoReferenceText()?'checked':''}>自动识别文本</label></div>`:''}<span class="muted small" data-scene-reference-status role="status">${escape(state.referenceMessage||'')}</span><div class="reference-name-row"><input data-scene-reference-name aria-label="音频保存名称" placeholder="例如：温暖男声" value="${escape(state.referenceNameFor===p.id?state.referenceName||'':'')}" ${busy()||!uploaded?'disabled':''}>${btn('保存到音频库','reference-save','secondary small-button',busy()||!uploaded?'disabled':'')}</div></div>`;}
  function syncReferenceJob(){referenceActivity();const status=root.querySelector('[data-scene-reference-status]');if(status)uiText(status, state.referenceJob?'正在识别参考文本…':state.referenceMessage||'');const stop=root.querySelector('[data-scene-action="reference-stop"]');if(stop){stop.hidden=!state.referenceJob;stop.disabled=!!state.referenceJob?.cancelling;}}
  async function cancelReferenceTranscription(){const job=state.referenceJob;if(!job)return;job.cancelling=true;syncReferenceJob();if(job.id&&!job.cancelSent){job.cancelSent=true;try{await api(`/jobs/${encodeURIComponent(job.id)}/cancel`,{method:'POST',body:{}});}catch(e){job.cancelling=false;job.cancelSent=false;showToast(plainMessage(e.message));syncReferenceJob();}}}
  async function transcribeReference(){
    if(busy())return;const p=state.project,reference=p?.tts_reference;if(!reference?.input_id){showToast('请先上传或录制参考音频。');return;}
    const job={id:null},oldText=p.tts_reference_text;state.referenceJob=job;state.referenceMessage='';syncReferenceJob();
    try{const created=await api('/reference-transcriptions',{method:'POST',body:{audio:reference.input_id}});job.id=created.id;if(job.cancelling)await cancelReferenceTranscription();let result;
      while(true){result=await api(`/jobs/${encodeURIComponent(job.id)}`);if(terminal(result.status))break;await new Promise(resolve=>setTimeout(resolve,500));}
      if(state.project?.id!==p.id||state.project.tts_reference?.input_id!==reference.input_id)return;
      if(result.status==='done'&&result.text&&!job.cancelling){if(state.project.tts_reference_text===oldText){state.project.tts_reference_text=result.text;segments().forEach(s=>{delete s.audio;delete s.audio_stale;});invalidate('audio');markDirty();await save();}else state.referenceMessage='已保留你修改的参考原文。';}
      else state.referenceMessage=job.cancelling||result.status==='cancelled'?'识别已停止。':plainMessage(result.message)||'没有识别到文字，请重试或手动填写。';
    }catch(e){state.referenceMessage=plainMessage(e.message);}finally{if(state.referenceJob===job)state.referenceJob=null;syncReferenceJob();if(!root.hidden)render();}
  }
  async function saveReferenceToLibrary(){await run(async()=>{if(state.dirty)await save();const p=state.project,name=(state.referenceNameFor===p.id?state.referenceName||'':'').trim();if(!p.tts_reference?.input_id)throw new Error('请先上传或录制参考音频。');if(!name)throw new Error('请填写音频保存名称。');const result=await api('/references',{method:'POST',body:{audio:p.tts_reference.input_id,name,text:p.tts_reference_text||'',overwrite:true}});state.referenceVoices=result.voices||[];await save({tts_reference_library:result.name,tts_reference_mode:'library',confirmed_audio:false});showToast(result.message||'参考音频已保存。');});}
  function mountReferenceUpload(zone){
    const reference=state.project.tts_reference,projectId=state.project.id,model=selectedModel('tts');
    zone.innerHTML=html`<div class="upload-actions"><input type="file" accept="audio/*" data-scene-reference-upload hidden><button type="button" class="button secondary small-button" data-reference-choose>上传音频</button><div class="recording-controls"><button type="button" class="button subtle small-button" data-reference-record>录音</button><span class="recording-time" role="timer" hidden>0 秒</span><button type="button" class="button subtle small-button recording-stop" aria-label="停止录音" hidden><span class="recording-stop-icon"></span></button></div></div><span class="muted small">${escape(reference?.name||'')}</span>${reference?.url?`<audio controls preload="metadata" src="${escape(reference.url)}"></audio>`:''}`;
    const file=zone.querySelector('input'),choose=zone.querySelector('[data-reference-choose]'),record=zone.querySelector('[data-reference-record]'),elapsed=zone.querySelector('[role=timer]'),stop=zone.querySelector('.recording-stop');
    const current=()=>zone.isConnected&&!root.hidden&&state.project?.id===projectId&&selectedModel('tts')===model;
    async function upload(blob,name,recorded=false){let stored=false;await run(async()=>{if(state.dirty)await save();const form=new FormData();form.append('file',blob,name);form.append('purpose','tts-reference');if(recorded)form.append('recorded','true');const result=await api('/uploads',{method:'POST',body:form});if(state.project?.id!==projectId||selectedModel('tts')!==model)return;state.referenceNameFor=projectId;state.referenceName=(result.name||name).replace(/\.[^.]+$/,'');state.referenceMessage='';await save({tts_reference_upload:result.id,tts_reference_name:result.name,tts_reference_mode:'upload',tts_reference_text:'',confirmed_audio:false});stored=true;});if(stored&&autoReferenceText()&&state.capabilities.tts_models?.find(m=>m.id===model)?.send_reference_text!==false)void transcribeReference();}
    choose.addEventListener('click',()=>file.click());file.addEventListener('change',()=>{if(file.files[0]&&!busy())void upload(file.files[0],file.files[0].name);});
    stop.addEventListener('click',()=>{if(referenceRecorder?.state==='recording')referenceRecorder.stop();});
    record.addEventListener('click',async()=>{
      if(busy())return;
      if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){showToast('此浏览器不支持录音，请使用 Chrome / Edge，或上传音频文件。');return;}
      const request={epoch:referenceEpoch};referenceRequest=request;record.disabled=true;choose.disabled=true;file.disabled=true;referenceActivity();
      let stream,recorder,clockTimer,stopTimer;
      const reset=()=>{clearInterval(clockTimer);clearTimeout(stopTimer);elapsed.hidden=true;stop.hidden=true;record.disabled=false;choose.disabled=false;file.disabled=false;record.classList.remove('recording');if(referenceRecorder===recorder)referenceRecorder=null;referenceActivity();};
      try{
        stream=await navigator.mediaDevices.getUserMedia({audio:true});
        if(request.epoch!==referenceEpoch||!current()){stream.getTracks().forEach(track=>track.stop());return;}
        const chunks=[],type=['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4'].find(type=>MediaRecorder.isTypeSupported(type));
        recorder=new MediaRecorder(stream,type?{mimeType:type}:{});referenceRecorder=recorder;
        recorder.addEventListener('dataavailable',event=>{if(event.data.size)chunks.push(event.data);});
        recorder.addEventListener('stop',()=>{stream.getTracks().forEach(track=>track.stop());reset();if(request.epoch!==referenceEpoch||!current())return;const type=recorder.mimeType||'audio/webm',ext=type.includes('mp4')?'m4a':type.includes('ogg')?'ogg':'webm';if(chunks.length&&!recorder._failed)void upload(new Blob(chunks,{type}),`录音-${Date.now()}.${ext}`,true);else showToast('没有录制到有效音频，请重试。');});
        recorder.addEventListener('error',()=>{recorder._failed=true;stream.getTracks().forEach(track=>track.stop());reset();showToast('录音中断，请重试。');});
        recorder.start();const started=Date.now();elapsed.hidden=false;stop.hidden=false;record.classList.add('recording');clockTimer=setInterval(()=>{uiText(elapsed, `${Math.floor((Date.now()-started)/1000)} 秒`);},250);stopTimer=setTimeout(()=>{if(recorder.state==='recording')recorder.stop();},30000);stop.focus();
      }catch(error){stream?.getTracks().forEach(track=>track.stop());reset();if(request.epoch===referenceEpoch)showToast(error.name==='NotAllowedError'?'录音需要麦克风权限，请在浏览器地址栏允许访问后重试。':'无法启动麦克风，请检查设备是否被占用。');}
      finally{if(referenceRequest===request)referenceRequest=null;if(!referenceRecorder)reset();referenceActivity();}
    });
  }
  function referenceControls(model){
    if(!(model?.accepts_voice_reference??model?.voice_mode==='reference'))return html`<p class="scene-voice-reference muted small">此模型使用预置声音，无需参考音频。</p>`;
    const required=model.require_voice??model.voice_mode==='reference',mode=referenceMode(model),p=state.project,tab=mode==='upload'?'upload':'library',library=p.tts_library_reference;
    const voices=[...(state.referenceVoices||[])];if(library&&!voices.some(v=>v.name===library.name))voices.push(library);
    const choices=[['',required?'从音频库选择':'不使用参考音频'],['__original__','使用原素材声音（自动截取）'],...voices.map(v=>[v.name,v.label||v.name,true])],selected=mode==='original'?'__original__':mode==='library'?library?.name||'':'';
    return html`<div class="scene-reference-controls tts-reference-tabs"><span class="field-label">${textHTML(required?'参考音频（必需）':'参考音频（可选）')}</span><div class="tts-reference-group"><div class="reference-source-tabs" role="tablist" aria-label="参考音频来源">${[['library','音频库'],['upload','上传 / 录音']].map(([id,label])=>btn(label,'reference-tab','secondary small-button reference-source-tab',`role="tab" id="scene-reference-${id}-tab" data-reference-mode="${id}" aria-controls="scene-reference-${id}" aria-selected="${tab===id}" tabindex="${tab===id?'0':'-1'}" ${busy()?'disabled':''}`)).join('')}</div>
    <div id="scene-reference-library" role="tabpanel" aria-labelledby="scene-reference-library-tab" ${tab==='library'?'':'hidden'}><div class="reference-library-toolbar">${field('参考音频库',select('tts_reference_library',choices,selected))}${btn('刷新列表','reference-refresh','secondary small-button',busy()?'disabled':'')}${btn('管理音频','reference-manage','secondary small-button',busy()?'disabled':'')}</div>${mode==='original'?html`<p class="scene-voice-reference muted small">自动截取原素材中 2 到 12 秒的声音与对应原文，用于克隆音色。</p>`:mode==='library'&&library?`<audio controls preload="metadata" src="${escape(library.url)}"></audio>${model.send_reference_text!==false?field('音频库对应文本',`<textarea rows="3" readonly>${escape(library.text||'')}</textarea>`):''}`:`<p class="scene-voice-reference muted small">${textHTML(required?'请选择参考音频。':'使用模型默认声音。')}</p>`}</div>
    <div id="scene-reference-upload" role="tabpanel" aria-labelledby="scene-reference-upload-tab" ${tab==='upload'?'':'hidden'}>${tab==='upload'?html`<div data-scene-reference-upload></div><p class="muted small">清晰、无背景音乐的单人语音，最长 30 秒。</p>${model.send_reference_text!==false?field(model.requires_reference_text?'参考原文（必填）':'参考原文（可选）',html`<textarea rows="3" data-scene-field="tts_reference_text" placeholder="填写参考音频中实际说出的原文" ${busy()?'disabled':''}>${escape(p.tts_reference_text||'')}</textarea>`):''}${referenceTools(model)}`:''}</div></div></div>`;
  }
  function renderVoice(){
    if(!state.project?.confirmed_translation&&!segments().some(s=>s.audio?.url))return empty('请先校对并确认译文。','校对译文','translate');
    const model=(state.capabilities.tts_models||[]).find(m=>m.id===selectedModel('tts')),voices=(model?.voices||[]).map(v=>typeof v==='string'?[v,v]:[v.id||v.name,v.label||v.name||v.id]);
    const follows=videoFollowsAudio(),missing=segments().filter(invalidAudio),generated=segments().some(s=>s.audio?.url),list=visibleSegments();
    return html`<div class="scene-voice-grid"><aside class="scene-voice-settings"><div class="scene-voice-controls"><div class="scene-field"><span>配音模型</span>${modelPicker('tts')}</div>${voices.length&&referenceMode(model)==='none'?field('声音',select('tts_voice',voices,state.project.tts_voice||voices[0][0])):''}${referenceControls(model)}<label class="scene-alignment-switch"><input type="checkbox" role="switch" data-scene-field="video_follows_audio" ${follows?'checked':''} ${busy()?'disabled':''}>画面跟随配音</label></div>${mediaView()}${renderTaskMessage()}</aside>
    <div class="scene-task-editor"><div class="scene-review-toolbar">${renderSearch()}<span class="muted small">${textHTML(`${state.filter?`${list.length} / `:''}${segments().length} 句`)}${generated&&missing.length?' · '+textHTML(`${missing.length} 句待处理`):''}</span>${btn(generated?'生成待更新片段':'生成配音','synthesize','primary',busy()?'disabled':'')}</div>
      <div class="scene-cues scene-voice-cues" tabindex="0" aria-label="逐句配音列表">${list.length?list.map(({s,i})=>{const slot=voiceWindow(s,i),duration=audioDuration(s),over=!follows&&overflow(s),stale=s.audio_stale||s.audio?.status==='stale',extension=Math.max(0,duration-slot),gapUsed=Math.min(Math.max(0,duration-(s.end-s.start)),Math.max(0,slot-(s.end-s.start))),fit=follows&&extension>.05?`${state.project.media.has_video?'画面':'时间轴'}延长 ${extension.toFixed(2)} 秒`:follows&&gapUsed>.05?`使用空隙 ${gapUsed.toFixed(2)} 秒`:`配音 ${duration.toFixed(2)} 秒`;return html`<article class="scene-voice-cue"><div class="scene-cue-time"><span>${i+1} · ${clock(s.start)}</span><span>可用 ${slot.toFixed(2)} 秒</span></div><div class="scene-voice-text">${edit(s,i,'translation')}${s.audio?html`<div class="scene-fit ${over?'over':''}" role="img" aria-label="配音 ${duration.toFixed(2)} 秒，可用 ${slot.toFixed(2)} 秒"><span style="width:${Math.min(duration/slot*100,100)}%"></span></div>`:''}</div><div class="scene-voice-tools"><div class="scene-duration ${over?'over':''}"><span>${textHTML(stale?'待重做':over?`超出 ${audioOverrun(s).toFixed(2)} 秒`:s.audio?fit:'待生成')}</span>${follows?'':field('配音倍速',html`<input type="number" step="0.05" min="0.5" max="2" value="${speedOf(s)}" data-scene-speed data-segment="${escape(s.id)}" aria-label="第 ${i+1} 句配音倍速" ${busy()?'disabled':''}>`)}</div><div class="scene-actions">${btn('原声','locate','subtle small-button',`data-segment="${escape(s.id)}"`)}${s.audio?.url?btn('试听','listen','subtle small-button',`data-segment="${escape(s.id)}"`):''}${btn(s.audio?'重做':'生成','synthesize-one','secondary small-button',`data-segment="${escape(s.id)}" ${busy()?'disabled':''}`)}${over?btn('精简译文','shorten','subtle small-button',`data-segment="${escape(s.id)}" ${busy()?'disabled':''}`):''}</div></div></article>`;}).join(''):html`<p class="scene-no-matches">没有匹配的字幕</p>`}</div></div></div>
    <div class="scene-footer">${btn('返回译文','step-translate','subtle small-button')}${btn('下一步：混音导出','voice-ready','primary',busy()||missing.length?'disabled':'')}</div>`;
  }
  function subtitleDownload(layer,format,label){const needsMix=state.scenario==='dubbing'&&layer!=='source'&&videoFollowsAudio()&&(!state.project?.preview||!state.project?.output_timeline);return btn(label||`导出 ${format.toUpperCase()}`,'subtitle-export','secondary small-button',`data-layer="${layer}" data-format="${format}" ${busy()||needsMix?'disabled':''} ${needsMix?'title="'+t('请先生成混音预览，确定成片字幕时间')+'" data-i18n-title="请先生成混音预览，确定成片字幕时间"':''}`);}
  function exportFormat(format,label){const item=[...(state.project.exports||[])].reverse().find(item=>item.name?.toLowerCase().endsWith(`.${format}`));return `<div class="scene-export-format"><span class="scene-format-name">${format.toUpperCase()}</span><span class="muted small">${textHTML(label)}</span>${item?html`<a class="button primary small-button scene-download" href="${escape(item.url)}" download="${escape(item.name)}">下载 ${format.toUpperCase()}</a>`:subtitleDownload('source',format)}</div>`;}
  function renderExport(){
    const p=state.project;
    if(!p?.confirmed_source)return empty('请先完成字幕校对。','校对字幕','review');
    if(state.scenario==='subtitles')return html`<div class="scene-export-grid"><div class="scene-export-source">${mediaView()}${renderTaskMessage()}</div><div class="scene-export-options"><div class="scene-export-heading"><h2>下载字幕</h2><div class="scene-actions"><span class="muted small">${textHTML(`${segments().length} 句`)} · ${textHTML(langName(p.detected_language||p.source_language))}</span>${outputDirectoryButton()}</div></div>${exportFormat('srt','播放器 / 剪辑软件')}${exportFormat('vtt','网页播放器')}</div></div><div class="scene-footer">${btn('返回校对','step-review','subtle small-button')}<div class="scene-actions">${btn('继续视频译配','continue-dubbing','secondary small-button',busy()?'disabled':'')}${newMediaButton()}</div></div>`;
    if(!p.confirmed_translation||segments().some(invalidAudio))return empty(videoFollowsAudio()?'请先完成译文与配音。':'请先完成译文与配音，并处理超时片段。','检查配音','voice');
    const tag=p.media.has_video?'video':'audio',finalMedia=[...(p.exports||[])].reverse().find(item=>(p.media.has_video?/\.mp4(\?|$)/i:/\.wav(\?|$)/i).test(item.url));
    const preview=finalMedia?html`<div class="scene-media"><${tag} ${tag==='video'?'data-scene-caption="output"':''} controls preload="metadata" src="${escape(finalMedia.url)}"></${tag}><div class="scene-media-caption">成品预览</div></div>`:p.preview?mediaView(true):mediaView();
    return html`<div class="scene-export-grid scene-mix-grid"><div class="scene-export-source">${preview}${renderTaskMessage()}</div><div class="scene-export-options">
      <div class="scene-mix-controls">${field('配音音量',html`<input type="range" min="0" max="1.5" step="0.05" value="${p.mix?.voice_volume??1}" data-scene-field="voice_volume" aria-label="配音音量" ${busy()?'disabled':''}>`)}${p.has_background?field('背景音乐音量',html`<input type="range" min="0" max="1" step="0.05" value="${p.mix?.background_volume??.3}" data-scene-field="background_volume" aria-label="背景音乐音量" ${busy()?'disabled':''}>`):''}${p.media.has_video?field('视频字幕',select('subtitle_mode',[['translation','译文字幕'],['bilingual','双语字幕'],['none','不叠加字幕']],p.options?.subtitle_mode||'translation')):''}</div>
      <div class="scene-actions scene-mix-actions">${btn(p.preview?'更新混音预览':'生成混音预览','mix','secondary small-button',busy()?'disabled':'')}${btn(`导出 ${p.media.has_video?'MP4':'WAV'}`,'export','primary',busy()||!p.preview?'disabled':'')}</div>
      <div class="scene-actions scene-subtitle-actions"><span class="muted small">字幕</span>${subtitleDownload('translation','srt','译文 SRT')}${subtitleDownload('bilingual','vtt','双语 VTT')}${outputDirectoryButton()}</div>${renderDownloads()}
    </div></div><div class="scene-footer">${btn('返回配音','step-voice','subtle small-button')}${newMediaButton()}</div>`;
  }
  function outputDirectoryButton(){return state.project?.exports?.length?btn('打开输出目录','open-output','subtle small-button',busy()?'disabled':''):'';}
  function newMediaButton(){return state.project?btn('处理新素材','new-media','subtle small-button scene-new-media',busy()?'disabled':''):'';}
  function renderDownloads(){return (state.project.exports||[]).length?`<div class="scene-downloads">${state.project.exports.map(item=>html`<a class="scene-download" href="${escape(item.url)}" download="${escape(item.name)}"><svg class="icon" aria-hidden="true"><use href="#icon-download"/></svg><span>${escape(item.name)}</span><span class="small">下载</span></a>`).join('')}</div>`:'';}
  async function capabilities(){const seq=++capabilityGeneration,p=state.project;const [data,references]=await Promise.all([api(route(`/capabilities?source_language=${encodeURIComponent(p?.source_language||state.source_language||'auto')}&target_language=${encodeURIComponent(p?.target_language||state.target_language||'en')}`)),api('/voices')]);if(seq!==capabilityGeneration)return false;state.capabilities=data;state.referenceVoices=references.voices||[];return true;}
  function acceptProject(project){state.project=project.project||project;state.resumeId=null;state.dirty=false;try{localStorage.setItem('audiocpp.scenario.project',state.project.id);}catch{}rememberPreferences();return state.project;}
  async function loadProject(id,restoreScenario=false){clearTimeout(timer);state.job=null;acceptProject(await api(route(`/projects/${encodeURIComponent(id)}`)));state.media=null;state.subtitle=null;state.step=segments().length?'review':'import';if(restoreScenario)state.scenario=state.project.scenario==='dubbing'?'dubbing':'subtitles';await capabilities();state.tts_user_choice=!!state.project.tts_model&&state.project.tts_model!==state.capabilities.recommended_tts?.id;if(state.project.job_id){const job=await api(route(`/jobs/${encodeURIComponent(state.project.job_id)}`));state.job={...job,synchronized:terminal(job.status)};if(!terminal(job.status))schedulePoll();}render();if(restoreScenario)await navigate(`scenarios/${state.scenario==='dubbing'?'video-dubbing':'subtitles'}`);}
  function patchBody(){const p=state.project;return {revision:p.revision,name:p.name,scenario:state.scenario,source_language:p.source_language||'auto',target_language:p.target_language||'en',asr_model:selectedModel('asr'),tts_model:selectedModel('tts'),tts_voice:p.tts_voice||'',...(p.tts_reference_mode?{tts_reference_mode:p.tts_reference_mode}:{}),tts_reference_text:p.tts_reference_text||'',has_background:p.has_background??true,video_follows_audio:videoFollowsAudio(),...(segments().length?{segments:segments()}:{}),confirmed_source:!!p.confirmed_source,confirmed_translation:!!p.confirmed_translation,confirmed_audio:!!p.confirmed_audio,mix:p.mix||{},options:p.options||{}};}
  async function save(extra={}){clearTimeout(saveTimer);saveChain=saveChain.catch(()=>{}).then(async()=>{const current=state.project;if(!current)return;const version=editVersion,result=await api(projectRoute(),{method:'PATCH',body:{...patchBody(),...extra}}),p=result.project||result;if(state.project!==current)return p;if(version===editVersion)acceptProject(p);else current.revision=p.revision;return p;});return saveChain;}
  async function ensureProject(file){
    if(state.project&&!file){if(state.dirty)await save();return;}
    const media=file||state.media;if(!media)throw new Error('请先选择音频或视频文件。');
    if(state.project&&state.dirty)await save();
    const previous=state.project||await savedProject(),settings={source_language:'auto',target_language:'en',tts_voice:'',has_background:true,video_follows_audio:true,...rememberPreferences(),asr_model:selectedModel('asr'),tts_model:selectedModel('tts')};delete settings.tts_user_choice;
    state.operation='准备上传素材';state.operationProgress=null;render();const form=new FormData();form.append('file',media);if(originalPath(media))form.append('source_path',originalPath(media));if(!state.project&&state.subtitle)form.append('subtitle',state.subtitle);form.append('scenario',state.scenario);form.append('name',media.name.replace(/\.[^.]+$/,''));
    if(previous){form.append('replace_id',previous.id);form.append('replace_revision',previous.revision);}
    releasePlayback();
    const result=await api(route('/projects'),{method:'POST',body:form,onUploadProgress:event=>{
      const known=event.lengthComputable&&event.total>0;state.operationProgress=known?event.loaded/event.total:null;
      state.operation=known?`上传素材 ${Math.floor(event.loaded/event.total*100)}%（${(event.loaded/1024**2).toFixed(1)} / ${(event.total/1024**2).toFixed(1)} MB）`:`上传素材（已传输 ${(event.loaded/1024**2).toFixed(1)} MB）`;updateJob();
    },onUploadComplete:()=>{state.operationProgress=null;state.operation='上传完成，正在保存并解析素材';updateJob();}});
    clearSession();
    acceptProject(result);Object.assign(state.project,settings);state.operationProgress=null;state.operation='保存素材设置';render();await save();state.operation='读取模型选项';updateJob();await capabilities();
  }
  function llm(){const defaults=state.capabilities.llm_defaults||{},get=key=>{try{return localStorage.getItem(`audiocpp.llm.${key}`)||'';}catch{return '';}};return {url:get('url')||defaults.llm_base_url||defaults.url||'',model:get('model')||defaults.llm_model||defaults.model||'',key:get('key')};}
  async function action(name,extra={}){await ensureProject();const body={revision:state.project.revision,action:name,...extra};if(name==='translate')body.llm=llm();const result=await api(`${projectRoute()}/actions`,{method:'POST',body});state.job={...result,id:result.id||result.job?.id,status:result.status||'running',message:result.message||'任务已提交…',action:name,synchronized:false};if(!state.job.id)throw new Error('服务未返回任务编号，请刷新页面后重试。');render();schedulePoll();}
  function schedulePoll(){clearTimeout(timer);timer=setTimeout(pollJob,700);}
  async function pollJob(){const id=state.job?.id;if(!id||terminal(state.job.status)&&state.job.synchronized!==false)return;try{const latest=await api(route(`/jobs/${encodeURIComponent(id)}`));if(state.job?.id!==id)return;state.job={...state.job,...latest};if(terminal(latest.status)){const completed=['completed','done'].includes(latest.status),actionName=state.job.action;acceptProject(await api(projectRoute()));state.error='';if(completed){if(actionName==='recognize')state.step='review';if(actionName==='translate')state.step='translate';if(actionName==='mix'||actionName==='export')state.step='export';}else if(latest.status==='cancelled')showToast('任务已停止。');else state.error=latest.error||latest.message||'任务未完成，请检查后重试。';await capabilities();state.job.synchronized=true;render();}else{schedulePoll();updateJob();}}catch(e){if(state.job?.id!==id)return;state.error=`读取任务进度失败：${e.message}。正在重试。`;updateJob();schedulePoll();}}
  function validateSource(){const list=segments();if(!list.length)throw new Error('字幕为空，请先识别或导入字幕。');let end=0;for(let i=0;i<list.length;i++){const s=list[i];if(!s.text?.trim())throw new Error(`第 ${i+1} 句字幕为空。`);if(!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.end<=s.start)throw new Error(`第 ${i+1} 句时间无效。`);if(s.start<end-.001)throw new Error(`第 ${i+1} 句与上一句时间重叠，请校对时间。`);end=s.end;}}
  async function run(fn){if(state.busy)return;clearTimeout(saveTimer);state.busy=true;state.operation='准备任务';state.operationProgress=null;state.error='';render();try{await saveChain.catch(()=>{});await fn();}catch(e){error(e.message);}finally{state.busy=false;state.operationProgress=null;render();scheduleSave();}}
  async function handle(actionName,control){
    if(actionName.startsWith('step-')){state.step=actionName.slice(5);state.filter='';render();return;}
    if(actionName==='back'){await navigate('scenarios');return;}
    if(actionName==='llm'){state.llmOpen=!state.llmOpen;render();return;}
    if(actionName==='save-llm'){try{root.querySelectorAll('[data-scene-llm]').forEach(input=>localStorage.setItem(`audiocpp.llm.${input.dataset.sceneLlm}`,input.value.trim()));state.llmDraft=null;state.llmOpen=false;showToast('对话连接设置已保存。');render();}catch{error('浏览器未能保存连接设置。');}return;}
    if(actionName==='upload'){if(!busy())root.querySelector('[data-scene-upload="media"]')?.click();return;}
    if(actionName==='copy-path'){const path=mediaPath();if(path){try{await navigator.clipboard.writeText(path);showToast('路径已复制');}catch{showToast('复制失败，请允许浏览器访问剪贴板。');}}return;}
    if(actionName==='subtitle-upload'){root.querySelector('[data-scene-upload="subtitle"]')?.click();return;}
    if(actionName==='reference-manage'){await navigate('references');return;}
    if(actionName==='reference-transcribe'){await transcribeReference();return;}
    if(actionName==='reference-stop'){await cancelReferenceTranscription();return;}
    if(actionName==='reference-save'){await saveReferenceToLibrary();return;}
    if(actionName==='reference-refresh'){await run(async()=>{state.referenceVoices=(await api('/voices')).voices||[];});return;}
    if(actionName==='reference-tab'){if(busy()||control.getAttribute('aria-selected')==='true')return;const model=state.capabilities.tts_models?.find(m=>m.id===selectedModel('tts'));state.project.tts_reference_mode=control.dataset.referenceMode==='upload'?'upload':state.project.tts_library_reference?'library':(model?.require_voice??model?.voice_mode==='reference')?'original':'none';segments().forEach(s=>{delete s.audio;delete s.audio_stale;});invalidate('audio');markDirty();render();return;}
    if(actionName==='play-source'){const player=root.querySelector('[data-scene-player="source"]');if(player){clipEnd=null;clearTimeout(clipTimer);if(player.paused)player.play().catch(e=>error(e.message));else player.pause();}return;}
    if(actionName==='mute-source'){const player=root.querySelector('[data-scene-player="source"]');if(player){player.muted=!player.muted;syncPlayback(player);}return;}
    if(actionName==='locate'){
      const s=segments().find(s=>String(s.id)===control.dataset.segment);if(!s)return;
      let player=root.querySelector('[data-scene-player="source"]');
      if(!player){activeAudio?.pause();activeAudio=new Audio(state.project.media.url);player=activeAudio;for(const type of ['timeupdate','play','pause','ratechange'])player.addEventListener(type,()=>syncPlayback(player));}
      if(!player.paused&&player.currentTime>=s.start&&player.currentTime<s.end){clipEnd=null;clearTimeout(clipTimer);player.pause();return;}
      clipEnd=s.end;player.currentTime=s.start;player.play().then(()=>syncPlayback(player)).catch(e=>{clipEnd=null;error(e.message);});return;
    }
    if(actionName==='listen'){const s=segments().find(s=>String(s.id)===control.dataset.segment);if(s?.audio?.url){activeAudio?.pause();activeAudio=new Audio(s.audio.url);activeAudio.playbackRate=speedOf(s);activeAudio.play().catch(e=>error(e.message));}return;}
    if(actionName==='stop'){if(!state.job||state.job.status==='cancelling')return;state.job.status='cancelling';state.job.message='正在停止任务…';updateJob();try{await api(route(`/jobs/${encodeURIComponent(state.job.id)}/cancel`),{method:'POST',body:{}});schedulePoll();}catch(e){state.job.status='running';error(e.message);}return;}
    if(busy())return;
    if(actionName==='recognize'&&segments().length&&!window.confirm(t('重新识别会覆盖当前字幕及相关翻译、配音结果，是否继续？')))return;
    await run(async()=>{
      const segmentId=control.dataset.segment,one=segmentId?{segment_ids:[segments().find(s=>String(s.id)===segmentId)?.id]}:{};
      if(actionName==='resume'){const project=await savedProject();if(!project){showToast('上次任务已不存在，请选择新素材。');return;}await loadProject(project.id,true);}
      else if(actionName==='new-media'){const preferences=rememberPreferences();releasePlayback();const result=await api(`${projectRoute()}/reset`,{method:'POST',body:{revision:state.project.revision}});if(!result.reset)throw new Error('清理未完成，请重试。');clearSession();Object.assign(state,preferences);await capabilities();}
      else if(actionName==='open-output'){const result=await api(`${projectRoute()}/open-output`,{method:'POST',body:{}});if(!result.opened)throw new Error('输出目录未能打开，请重试。');showToast(`已请求打开输出目录：${result.output_directory}`);}
      else if(actionName==='review'){await ensureProject();state.step='review';}
      else if(actionName==='recognize')await action('recognize');
      else if(actionName==='confirm-source'){validateSource();await save({confirmed_source:true});state.step=state.scenario==='subtitles'?'export':'translate';}
      else if(actionName==='translate'||actionName==='translate-one'||actionName==='shorten'){if(!llm().url||!llm().model){state.llmOpen=true;throw new Error('请先填写大语言模型的 API 地址和模型名称。');}await action('translate',{...one,...(actionName==='shorten'?{options:{shorten:true}}:{})});}
      else if(actionName==='confirm-translation'){if(segments().some(s=>!s.translation?.trim()||s.translation_stale))throw new Error('请完成所有句子的译文校对与更新。');await save({confirmed_translation:true});state.step='voice';}
      else if(actionName==='synthesize'||actionName==='synthesize-one'){if(segments().some(s=>!s.translation?.trim()||s.translation_stale))throw new Error('请先完成译文校对与更新。');if(!state.project.confirmed_translation)await save({confirmed_translation:true});await action('synthesize',one);}
      else if(actionName==='voice-ready'){if(segments().some(invalidAudio))throw new Error(videoFollowsAudio()?'请先生成或更新全部配音片段。':'请先处理尚未生成或超时的配音片段。');if(state.dirty)await save();state.step='export';}
      else if(actionName==='mix')await action('mix');
      else if(actionName==='export'){await save({confirmed_audio:true});await action('export',{options:{subtitle_mode:state.project.options?.subtitle_mode||'translation'}});}
      else if(actionName==='subtitle-export')await action('export_subtitles',{format:control.dataset.format,layer:control.dataset.layer});
      else if(actionName==='continue-dubbing'){await save({scenario:'dubbing'});state.scenario='dubbing';state.step='translate';await navigate('scenarios/video-dubbing');}
    });
  }
  function invalidate(kind,s){const p=state.project;if(!p)return;if(kind==='source'||kind==='timing'){p.confirmed_source=false;p.confirmed_translation=false;if(kind==='source'&&s){if(s.translation)s.translation_stale=true;if(s.audio)s.audio_stale=true;}}if(kind==='translation'){p.confirmed_translation=false;if(s?.audio)s.audio_stale=true;}p.confirmed_audio=false;p.preview=null;p.output_timeline=null;p.exports=[];}
  async function updateRecommendation(project,key,value){state.busy=true;state.operation='更新模型推荐';render();try{if(!await capabilities())return;if(key==='target_language'){const target=project||state,model=state.capabilities.tts_models?.find(m=>m.id===target.tts_model);if(!state.tts_user_choice||!supportsLanguage(model,value)){target.tts_model=state.capabilities.recommended_tts?.id||'';if(project)project.tts_voice='';state.tts_user_choice=false;}}}finally{state.busy=false;state.operationProgress=null;render();scheduleSave();}}
  async function updateField(input){const key=input.dataset.sceneField,value=input.type==='checkbox'?input.checked:input.type==='range'?Number(input.value):input.value,p=state.project;
    if(!p){state[key]=value;if(key==='tts_model')state.tts_user_choice=true;if(key==='target_language'||key==='source_language')await updateRecommendation(null,key,value);rememberPreferences();return;}
    if(key==='tts_reference_library'){await run(async()=>{if(state.dirty)await save();await save(value==='__original__'?{tts_reference_mode:'original',confirmed_audio:false}:{tts_reference_mode:value?'library':'none',tts_reference_library:value,confirmed_audio:false});});return;}
    if(key==='video_follows_audio'){await run(async()=>{if(state.dirty)await save();acceptProject(await api(projectRoute(),{method:'PATCH',body:{revision:state.project.revision,video_follows_audio:value}}));activeAudio?.pause();});return;}
    if(key==='voice_volume'||key==='background_volume'){p.mix={...p.mix,[key]:value};p.preview=null;p.output_timeline=null;p.confirmed_audio=false;p.exports=[];}
    else if(key==='translation_instructions'||key==='subtitle_mode'){p.options={...p.options,[key]:value};p.exports=[];}
    else{p[key]=value;if(key==='target_language'){segments().forEach(s=>{s.translation='';delete s.translation_stale;delete s.audio;delete s.audio_stale;});invalidate('translation');}if(['tts_model','tts_voice','tts_reference_mode','tts_reference_text'].includes(key)){segments().forEach(s=>{delete s.audio;delete s.audio_stale;});p.confirmed_audio=false;p.preview=null;p.output_timeline=null;p.exports=[];}}
    edited(input);if(['source_language','target_language'].includes(key))await updateRecommendation(p,key,value);else if(key==='tts_model'){state.tts_user_choice=true;p.tts_voice='';delete p.tts_reference_mode;render();}else if(['tts_voice','tts_reference_mode','voice_volume','background_volume','subtitle_mode'].includes(key))render();rememberPreferences();
  }
  async function upload(file,kind){if(!file||busy())return;if(kind==='media'){await run(()=>ensureProject(file));return;}if(!/\.(srt|vtt)$/i.test(file.name)){error('请上传 SRT 或 VTT 字幕。');return;}if(!state.project){state.subtitle=file;render();return;}await run(async()=>{if(state.dirty)await save();const form=new FormData();form.append('file',file);form.append('revision',state.project.revision);acceptProject(await api(`${projectRoute()}/subtitles`,{method:'POST',body:form}));state.subtitle=file;state.step='review';});}
  root?.addEventListener('click',event=>{if(event.target.closest('.scene-downloads-stale')){event.preventDefault();return;}const target=event.target.closest('[data-scene-action],[data-scene-step]');if(!target)return;if(target.dataset.sceneAction)handle(target.dataset.sceneAction,target);else if(target.dataset.sceneStep){state.step=target.dataset.sceneStep;state.filter='';render();}});
  root?.addEventListener('change',event=>{const input=event.target;if(input.hasAttribute('data-scene-follow')){followPlayback=input.checked;return;}if(input.hasAttribute('data-scene-rate')){const player=root.querySelector('[data-scene-player="source"]');if(player)player.playbackRate=Number(input.value);return;}if(input.dataset.sceneUpload){upload(input.files?.[0],input.dataset.sceneUpload);return;}if(busy())return;if(input.dataset.sceneField){updateField(input).catch(e=>error(e.message));return;}const s=segments().find(s=>String(s.id)===input.dataset.segment);if(!s)return;if(input.dataset.sceneEdit){if(s[input.dataset.sceneEdit]===input.value)return;s[input.dataset.sceneEdit]=input.value;invalidate(input.dataset.sceneEdit==='text'?'source':'translation',s);if(input.dataset.sceneEdit==='translation')s.translation_stale=false;edited(input);}else if(input.dataset.sceneTime){const value=seconds(input.value);if(!Number.isFinite(value)){input.setAttribute('aria-invalid','true');error('时间格式应为 00:00:00.000，或秒数。');return;}s[input.dataset.sceneTime]=value;invalidate('timing',s);edited(input);}else if(input.hasAttribute('data-scene-speed')){const value=Number(input.value);if(value<.5||value>2){error('配音倍速应在 0.50 至 2.00 之间。');return;}s.speed=value;invalidate('audio',s);edited(input);render();}});
  root?.addEventListener('input',event=>{const input=event.target;if(input.hasAttribute('data-scene-seek')){const player=root.querySelector('[data-scene-player="source"]');if(player){clipEnd=null;clearTimeout(clipTimer);player.currentTime=Number(input.value);syncPlayback(player);}return;}if(input.matches('.scene-cues textarea')){resizeCueInputs();fitCueList();}if(!busy()&&input.dataset.sceneEdit){const s=segments().find(s=>String(s.id)===input.dataset.segment);if(s){s[input.dataset.sceneEdit]=input.value;invalidate(input.dataset.sceneEdit==='text'?'source':'translation',s);if(input.dataset.sceneEdit==='translation')s.translation_stale=false;edited(input);}}if(!busy()&&input.dataset.sceneField==='translation_instructions')updateField(input).catch(e=>error(e.message));if(event.target.dataset.sceneLlm){state.llmDraft||={};state.llmDraft[event.target.dataset.sceneLlm]=event.target.value;}if(input.hasAttribute('data-scene-search')){state.filter=input.value;if(state.step==='review'){root.querySelector('.scene-cues').innerHTML=renderCueRows();uiText(root.querySelector('[data-scene-count]'), `${state.filter?`${visibleSegments().length} / `:''}${segments().length} 句`);resizeCueInputs();fitCueList();syncPlayback(root.querySelector('[data-scene-player="source"]'));}else{const start=input.selectionStart;render();const search=root.querySelector('[data-scene-search]');search?.focus();search?.setSelectionRange(start,start);}}});
  root?.addEventListener('dragover',event=>{if(event.target.closest('[data-scene-drop]')){event.preventDefault();event.target.closest('[data-scene-drop]').classList.add('dragging');}});
  root?.addEventListener('dragleave',event=>event.target.closest('[data-scene-drop]')?.classList.remove('dragging'));
  root?.addEventListener('drop',event=>{if(event.target.closest('[data-scene-drop]')){event.preventDefault();upload(event.dataTransfer.files?.[0],'media');}});
  root?.addEventListener('keydown',event=>{if(event.target.hasAttribute('data-scene-drop')&&['Enter',' '].includes(event.key)){event.preventDefault();root.querySelector('[data-scene-upload="media"]')?.click();}});
  root?.addEventListener('change',event=>{if(event.target.hasAttribute('data-scene-reference-auto'))try{localStorage.setItem('audiocpp-reference-auto',JSON.stringify(event.target.checked));}catch{}});
  root?.addEventListener('input',event=>{if(event.target.hasAttribute('data-scene-reference-name')){state.referenceName=event.target.value;state.referenceNameFor=state.project?.id;}});
  root?.addEventListener('keydown',event=>{const tab=event.target.closest('[data-reference-mode]');if(!tab||busy())return;const tabs=[...tab.parentElement.children],index=tabs.indexOf(tab),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:null;if(next!==null){event.preventDefault();const id=tabs[next].id;tabs[next].click();root.querySelector(`#${id}`)?.focus();}});
  for(const type of ['play','pause','seeked','ratechange','timeupdate','loadedmetadata','volumechange','ended'])root?.addEventListener(type,event=>{if(event.target.dataset.scenePlayer==='source')syncPlayback(event.target);},true);
  for(const type of ['play','pause','seeking','ratechange','timeupdate','ended'])root?.addEventListener(type,event=>{const audio=event.target;if(audio.tagName!=='AUDIO'||audio.dataset.scenePlayer!=='preview')return;const video=root.querySelector('[data-scene-sync-video]');if(!video)return;video.muted=true;if(type==='pause'||type==='ended')video.pause();else if(type==='ratechange')video.playbackRate=audio.playbackRate;else{if(type!=='timeupdate'||Math.abs(video.currentTime-audio.currentTime)>.25)video.currentTime=audio.currentTime;if(type==='play')video.play().catch(()=>{});}},true);
  return {async open(scenario){const generation=++state.generation;state.scenario=scenario;state.error='';render();try{if(!state.project){try{state.resumeId=localStorage.getItem('audiocpp.scenario.project');}catch{}}await capabilities();if(generation===state.generation)render();}catch(e){if(generation===state.generation)error(e.message);}}};
}
