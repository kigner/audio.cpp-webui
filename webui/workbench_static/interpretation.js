import {t,uiText,html,textHTML} from './i18n.js';

export function createInterpretation({root,api,navigate,showToast,onRuntimeChange=()=>{}}) {
  const key='audiocpp.interpretation.preferences';
  let preferences={source_language:'zh',target_language:'en',voice:'',input:'',output:''};
  try {const saved=JSON.parse(localStorage.getItem(key)||'{}');for(const name of Object.keys(preferences))if(typeof saved[name]==='string'&&saved[name].length<256)preferences[name]=saved[name];}catch{}
  let capabilities=null,phase='idle',epoch=0,socket=null,stream=null,context=null,capture=null,input=null,mute=null;
  let readingDevices=false;
  let nextAudio=0,pending=0,engine='',flushResolve=null,completed=false;
  let earlyAudio=[],earlyBytes=0;
  let recordingEpoch=0,recordingTimer=null,recordingFailures=0;
  const savedClips=new Map();
  const sources=new Set(),rows=new Map();
  const find=selector=>root.querySelector(selector);
  const running=()=>['preparing','listening','finishing','playing'].includes(phase);
  const remember=()=>{try{localStorage.setItem(key,JSON.stringify(preferences));}catch{}};

  function layout() {
    root.innerHTML=html`<header class="page-heading page-topbar"><div><button class="button subtle small-button" data-interpretation="back">返回场景应用</button><h1 data-i18n="实时翻译">实时翻译</h1></div></header>
      <p class="page-description" data-i18n="说中文，听英文。自动断句、翻译并朗读，所有处理都在本机完成。">说中文，听英文。自动断句、翻译并朗读，所有处理都在本机完成。</p>
      <div class="interpretation-grid"><section class="card interpretation-controls">
        <div class="card-heading"><h2 data-i18n="翻译方向">翻译方向</h2><span class="badge">LFM3</span></div>
        <div class="interpretation-direction"><label class="scene-field"><span data-i18n="我说">我说</span><select data-interpretation="source" aria-label="我说" data-i18n-aria-label="我说"></select></label><button class="button subtle interpretation-swap" data-interpretation="swap" title="交换语言" data-i18n-title="交换语言" aria-label="交换语言" data-i18n-aria-label="交换语言">⇄</button><label class="scene-field"><span data-i18n="译成">译成</span><select data-interpretation="target" aria-label="译成" data-i18n-aria-label="译成"></select></label></div>
        <label class="scene-field"><span data-i18n="朗读音色">朗读音色</span><select data-interpretation="voice" aria-label="朗读音色" data-i18n-aria-label="朗读音色"></select></label>
        <label class="scene-field"><span data-i18n="麦克风">麦克风</span><select data-interpretation="input" aria-label="麦克风" data-i18n-aria-label="麦克风"></select></label>
        <label class="scene-field" data-interpretation="output-field"><span data-i18n="播放设备">播放设备</span><select data-interpretation="output" aria-label="播放设备" data-i18n-aria-label="播放设备"></select></label>
        <div class="interpretation-devices"><button class="button subtle small-button" data-interpretation="devices" data-i18n="读取音频设备">读取音频设备</button><p class="muted small" data-interpretation="device-hint" data-i18n="允许麦克风权限后，可读取可用的实体和虚拟音频设备。">允许麦克风权限后，可读取可用的实体和虚拟音频设备。</p><details><summary data-i18n="输出到虚拟麦克风">输出到虚拟麦克风</summary><p class="muted small" data-i18n="播放设备选择虚拟声卡的播放端（如 CABLE Input）；其他软件的麦克风选择对应录音端（如 CABLE Output）。">播放设备选择虚拟声卡的播放端（如 CABLE Input）；其他软件的麦克风选择对应录音端（如 CABLE Output）。</p></details></div>
        <div class="interpretation-live" role="status" aria-live="polite"><div class="interpretation-indicator" data-interpretation="indicator"></div><strong data-interpretation="status"></strong><span data-interpretation="activity" class="muted small"></span></div>
        <div class="interpretation-meter" aria-hidden="true"><span data-interpretation="meter"></span></div>
        <p class="inline-error" data-interpretation="error" role="alert" hidden></p>
        <button class="button primary" data-interpretation="start" disabled data-i18n="开始翻译">开始翻译</button>
        <button class="button subtle" data-interpretation="cancel" hidden data-i18n="立即停止">立即停止</button>
        <p class="muted small" data-i18n="建议戴耳机，避免译音再次进入麦克风。">建议戴耳机，避免译音再次进入麦克风。</p>
        <div data-interpretation="install" hidden><p class="muted small" data-i18n="请先在模型中心安装 LFM3-Audio。">请先在模型中心安装 LFM3-Audio。</p><button class="button secondary" data-interpretation="models" data-i18n="前往模型中心">前往模型中心</button></div>
      </section><section class="card interpretation-results"><div class="card-heading"><h2 data-i18n="双语记录">双语记录</h2><div class="interpretation-actions"><a class="button subtle small-button" data-interpretation="download" hidden download data-i18n="下载本轮译音">下载本轮译音</a><button class="button subtle small-button" data-interpretation="copy" disabled data-i18n="复制全文">复制全文</button></div></div>
        <p class="muted small interpretation-saving" data-interpretation="saving" aria-live="polite" data-i18n="译音会在每句完成后自动保存。">译音会在每句完成后自动保存。</p>
        <div class="interpretation-columns" aria-hidden="true"><span data-interpretation="source-label"></span><span data-interpretation="target-label"></span></div>
        <div data-interpretation="rows"></div><div class="interpretation-empty" data-interpretation="empty"><span class="interpretation-empty-icon" aria-hidden="true">⇄</span><strong data-i18n="准备好，就开始说话">准备好，就开始说话</strong><p class="muted" data-i18n="原文和译文会逐句出现在这里，译音会按顺序播放。">原文和译文会逐句出现在这里，译音会按顺序播放。</p></div>
      </section></div>`;
    find('[data-interpretation="back"]').onclick=()=>navigate('scenarios');
    find('[data-interpretation="models"]').onclick=()=>navigate('models');
    find('[data-interpretation="start"]').onclick=()=>phase==='listening'?finish():start();
    find('[data-interpretation="cancel"]').onclick=()=>{hide();status('本轮翻译已停止');};
    find('[data-interpretation="copy"]').onclick=async()=>{try{await navigator.clipboard.writeText([...rows.values()].filter(row=>row.translation).map(row=>`${row.source}\n${row.translation}`).join('\n\n'));showToast('已复制双语记录。');}catch{showToast('复制失败，请重试。');}};
    find('[data-interpretation="swap"]').onclick=()=>{[preferences.source_language,preferences.target_language]=[preferences.target_language,preferences.source_language];languages();remember();};
    for(const name of ['source','target'])find(`[data-interpretation="${name}"]`).onchange=event=>{
      const field=name==='source'?'source_language':'target_language',other=name==='source'?'target_language':'source_language',old=preferences[field];
      preferences[field]=event.target.value;if(preferences[field]===preferences[other])preferences[other]=old;
      languages();remember();
    };
    for(const name of ['voice','input','output'])find(`[data-interpretation="${name}"]`).onchange=async event=>{
      if(name==='output'&&event.target.value==='__choose_output__'){
        try{const device=await navigator.mediaDevices.selectAudioOutput({deviceId:preferences.output||''});preferences.output=device.deviceId;await devices();}
        catch(error){event.target.value=preferences.output;showToast(error.name==='NotAllowedError'?'播放设备权限未开启，请允许访问后重试。':'未能选择播放设备，请重试。');return;}
      }else preferences[name]=event.target.value;
      remember();
    };
    find('[data-interpretation="devices"]').onclick=readDevices;
  }

  function languages() {
    const supported=capabilities?.languages||[['zh','中文'],['en','英语']];
    if(!supported.some(([id])=>id===preferences.source_language))preferences.source_language='zh';
    if(!supported.some(([id])=>id===preferences.target_language)||preferences.target_language===preferences.source_language)preferences.target_language=preferences.source_language==='en'?'zh':'en';
    for(const name of ['source','target']) {
      const select=find(`[data-interpretation="${name}"]`),field=name==='source'?'source_language':'target_language';
      select.replaceChildren(...supported.map(([id,label])=>{const option=document.createElement('option');option.value=id;uiText(option,label);return option;}));select.value=preferences[field];
      uiText(find(`[data-interpretation="${name}-label"]`),supported.find(([id])=>id===preferences[field])?.[1]||preferences[field]);
    }
    const voices=(capabilities?.voices||[]).filter(voice=>voice.language===preferences.target_language);
    if(!voices.some(voice=>voice.id===preferences.voice))preferences.voice='';
    const automatic=document.createElement('option');automatic.value='';uiText(automatic,'跟随目标语言');
    find('[data-interpretation="voice"]').replaceChildren(automatic,...voices.map(voice=>{const option=document.createElement('option');option.value=voice.id;uiText(option,voice.label);return option;}));
    find('[data-interpretation="voice"]').value=preferences.voice;
  }

  async function devices() {
    let list=[];try{list=await navigator.mediaDevices?.enumerateDevices()||[];}catch{}
    if(!find('[data-interpretation="input"]'))return;
    for(const [name,kind,label] of [['input','audioinput','系统默认麦克风'],['output','audiooutput','系统默认播放设备']]) {
      const select=find(`[data-interpretation="${name}"]`),defaultOption=document.createElement('option');defaultOption.value='';uiText(defaultOption,label);
      const available=list.filter(device=>device.kind===kind);
      if(available.length&&!available.some(device=>device.deviceId&&device.label)&&select.options.length)continue;
      select.replaceChildren(defaultOption,...available.filter(device=>device.deviceId&&device.deviceId!=='default'&&device.deviceId!=='communications').map((device,index)=>{const option=document.createElement('option');option.value=device.deviceId;option.textContent=device.label||`${t(name==='input'?'麦克风':'播放设备')} ${index+1}`;return option;}));
      if(preferences[name]&&![...select.options].some(option=>option.value===preferences[name])){
        const missing=document.createElement('option');missing.value=preferences[name];uiText(missing,'上次选择的设备（暂不可用）');select.append(missing);
        if(running()&&list.some(device=>device.kind===kind&&device.label)){fail(t(name==='input'?'所选麦克风已断开，请重新选择设备。':'所选播放设备已断开，请重新选择设备。'));}
      }
      select.value=preferences[name];
      if(name==='output'&&typeof navigator.mediaDevices?.selectAudioOutput==='function'){
        const choose=document.createElement('option');choose.value='__choose_output__';uiText(choose,'选择其他播放设备…');select.append(choose);
      }
    }
    const supported=typeof (window.AudioContext||window.webkitAudioContext)?.prototype?.setSinkId==='function';
    find('[data-interpretation="output"]').disabled=running()||readingDevices||!supported;
    if(!supported){
      preferences.output='';find('[data-interpretation="output"]').value='';
      uiText(find('[data-interpretation="device-hint"]'),'当前浏览器仅支持系统默认播放设备，请在系统声音设置中切换。');
    }
    return list.some(device=>device.kind==='audioinput'&&device.deviceId&&device.label);
  }

  async function readDevices() {
    if(readingDevices||running())return;
    readingDevices=true;status();
    const button=find('[data-interpretation="devices"]'),generation=epoch;let permission=null;
    try{
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('浏览器无法使用麦克风，请在本机浏览器中打开工作台。');
      permission=await navigator.mediaDevices.getUserMedia({audio:true});
      if(generation!==epoch||root.hidden)return;
      await devices();uiText(button,'刷新设备');
    }catch(error){showToast(error.name==='NotAllowedError'?'麦克风权限未开启，请允许浏览器使用麦克风后重试。':error.message);}
    finally{permission?.getTracks().forEach(track=>track.stop());readingDevices=false;status();}
  }

  function status(message) {
    const label=message||(phase==='preparing'&&stream?'正在收音，模型准备中…':({idle:'准备就绪',preparing:'正在准备翻译…',listening:'正在收音',finishing:'正在译完最后几句…',playing:'正在播完译音…',error:'翻译已停止'})[phase]);
    uiText(find('[data-interpretation="status"]'),label);
    const button=find('[data-interpretation="start"]');
    uiText(button,phase==='listening'?'结束翻译':phase==='preparing'?'正在准备…':phase==='finishing'||phase==='playing'?'正在结束…':'开始翻译');
    button.disabled=!capabilities?.ready||readingDevices||running()&&phase!=='listening';
    find('[data-interpretation="cancel"]').hidden=!running();
    find('[data-interpretation="indicator"]').classList.toggle('active',phase==='listening'||phase==='preparing'&&!!stream);
    root.querySelectorAll('select,[data-interpretation="swap"]').forEach(control=>control.disabled=running()||readingDevices);
    find('[data-interpretation="devices"]').disabled=running()||readingDevices;
    if(typeof (window.AudioContext||window.webkitAudioContext)?.prototype?.setSinkId!=='function')find('[data-interpretation="output"]').disabled=true;
    activity();
  }

  function activity() {
    const duration=context?Math.max(0,nextAudio-context.currentTime):0;
    const info=[engine? t(engine):'',pending?`${t('待处理')} ${pending} ${t('句')}`:'',duration>.3?`${t('待播')} ${duration.toFixed(1)}s`:''].filter(Boolean).join(' · ');
    find('[data-interpretation="activity"]').textContent=info;
  }

  function stopMic() {
    capture?.disconnect();capture=null;input?.disconnect();input=null;mute?.disconnect();mute=null;
    if(stream){for(const track of stream.getTracks()){track.onended=null;track.stop();}stream=null;}
    find('[data-interpretation="meter"]')?.style.setProperty('width','0%');
  }

  function cleanupAudio() {
    stopMic();for(const source of sources){source.onended=null;try{source.stop();}catch{}}sources.clear();
    void context?.close().catch(()=>{});context=null;nextAudio=0;flushResolve=null;earlyAudio=[];earlyBytes=0;
    for(const row of rows.values())row.element.classList.remove('playing');
  }

  function hide() {
    epoch++;completed=false;phase='idle';pending=0;engine='';
    const previous=socket;socket=null;previous?.close();cleanupAudio();
    if(find('[data-interpretation="status"]'))status();
  }

  function fail(message) {
    hide();phase='error';const error=find('[data-interpretation="error"]');error.hidden=false;error.textContent=t(message);status();
  }

  function rowFor(id,values={}) {
    if(!rows.has(id)) {
      const element=document.createElement('article');element.className='interpretation-row';element.dataset.segment=String(id);
      element.innerHTML=html`<div class="interpretation-row-heading"><span></span><div class="interpretation-row-save"><small class="muted" data-row-status></small><small class="muted" data-row-saving hidden data-i18n="语音保存中…">语音保存中…</small><a class="button subtle small-button" data-row-download hidden download data-i18n="下载本句">下载本句</a></div></div><div class="interpretation-pair"><p data-row-source></p><p data-row-translation></p></div>`;
      const row={element,source:'',translation:'',audio:0};rows.set(id,row);find('[data-interpretation="rows"]').append(element);
      find('[data-interpretation="empty"]').hidden=true;
    }
    const row=rows.get(id);Object.assign(row,values);
    if(values.start!==undefined)row.element.querySelector('.interpretation-row-heading span').textContent=`${Math.floor(values.start/60).toString().padStart(2,'0')}:${Math.floor(values.start%60).toString().padStart(2,'0')}`;
    row.element.querySelector('[data-row-source]').textContent=row.source;
    row.element.querySelector('[data-row-translation]').textContent=row.translation;
    const clip=savedClips.get(id);if(clip)download(row.element.querySelector('[data-row-download]'),clip.audio);
    find('[data-interpretation="copy"]').disabled=![...rows.values()].some(value=>value.translation);
    return row;
  }

  function rowStatus(row,label){uiText(row.element.querySelector('[data-row-status]'),label);}

  function download(link,audio) {
    if(!audio||!/^\/api\/workbench\/files\/[a-zA-Z0-9_-]+$/.test(audio.url||''))return;
    link.href=audio.url;link.download=audio.name||'interpretation.wav';link.hidden=false;
  }

  function watchRecording(id) {
    const generation=++recordingEpoch;recordingFailures=0;savedClips.clear();clearTimeout(recordingTimer);
    const link=find('[data-interpretation="download"]');link.hidden=true;link.removeAttribute('href');
    find('[data-interpretation="saving"]').classList.remove('inline-error');
    uiText(find('[data-interpretation="saving"]'),'译音会在每句完成后自动保存。');
    async function refresh(){
      try{
        const record=await api(`/interpretation/recordings/${encodeURIComponent(id)}`);
        if(generation!==recordingEpoch)return;
        recordingFailures=0;
        for(const clip of record.clips||[]){savedClips.set(clip.id,clip);const row=rows.get(clip.id);if(row){download(row.element.querySelector('[data-row-download]'),clip.audio);row.element.querySelector('[data-row-saving]').hidden=true;}}
        download(link,record.audio);
        const saving=find('[data-interpretation="saving"]');saving.classList.toggle('inline-error',!!record.message);
        uiText(saving,record.message||({recording:'译音会在每句完成后自动保存。',saving:'正在保存本轮译音…',done:'本轮译音已保存，可下载 WAV 文件。',empty:'本轮没有可保存的译音。'})[record.state]||'语音保存未完成，请检查输出目录。');
        if(['recording','saving'].includes(record.state))recordingTimer=setTimeout(refresh,600);
        else for(const row of rows.values())row.element.querySelector('[data-row-saving]').hidden=true;
      }catch{
        if(generation!==recordingEpoch)return;
        if(++recordingFailures<4)recordingTimer=setTimeout(refresh,1500);
        else uiText(find('[data-interpretation="saving"]'),'未能读取语音文件，请在输出目录中查看。');
      }
    }
    void refresh();
  }
  function settle() {
    if(completed&&!sources.size){phase='idle';engine='';pending=0;stopMic();status('本轮翻译已结束');}
  }

  function play(message,generation) {
    if(!context||generation!==epoch)return;
    const bytes=Uint8Array.from(atob(message.pcm),value=>value.charCodeAt(0));
    if(bytes.length%2||message.sample_rate!==24000)throw new Error('收到的译音格式不正确，请重新开始。');
    const view=new DataView(bytes.buffer),buffer=context.createBuffer(1,bytes.length/2,24000),channel=buffer.getChannelData(0);
    for(let index=0;index<channel.length;index++)channel[index]=view.getInt16(index*2,true)/32768;
    const row=rowFor(message.id),source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);
    const when=Math.max(nextAudio,context.currentTime+.06);nextAudio=when+buffer.duration;sources.add(source);row.audio++;
    if(message.first){rowStatus(row,'正在朗读');setTimeout(()=>{if(generation===epoch&&sources.has(source))row.element.classList.add('playing');},Math.max(0,(when-context.currentTime)*1000));}
    source.onended=()=>{sources.delete(source);source.disconnect();if(generation!==epoch)return;row.audio--;if(!row.audio&&row.done){row.element.classList.remove('playing');rowStatus(row,'已播放');}activity();settle();};
    source.start(when);activity();
  }

  function receive(message,generation) {
    if(generation!==epoch)return;
    switch(message.type) {
      case 'preparing':phase='preparing';status();break;
      case 'ready':rows.clear();find('[data-interpretation="rows"]').replaceChildren();find('[data-interpretation="empty"]').hidden=false;find('[data-interpretation="copy"]').disabled=true;if(message.recording_id)watchRecording(message.recording_id);phase='listening';capture.port.postMessage({kind:'enable',value:true});for(const pcm of earlyAudio)socket.send(pcm);earlyAudio=[];earlyBytes=0;status();onRuntimeChange();break;
      case 'speech':find('[data-interpretation="indicator"]').classList.toggle('speaking',!!message.active);break;
      case 'queued':pending=message.pending;activity();break;
      case 'segment':pending=message.pending;engine='正在识别';rowStatus(rowFor(message.id,message),'正在识别');activity();break;
      case 'recognized':engine='正在翻译';rowStatus(rowFor(message.id,message),'正在翻译');activity();break;
      case 'translated':engine='正在合成';rowStatus(rowFor(message.id,message),'准备朗读');activity();break;
      case 'audio':engine='正在朗读';play(message,generation);break;
      case 'empty':{const row=rows.get(message.id);row?.element.remove();rows.delete(message.id);find('[data-interpretation="empty"]').hidden=rows.size>0;break;}
      case 'segment_done':{pending=message.pending;engine='';const row=rows.get(message.id);if(row){row.done=true;row.element.querySelector('[data-row-saving]').hidden=savedClips.has(message.id);if(!row.audio){row.element.classList.remove('playing');rowStatus(row,'已播放');}}activity();break;}
      case 'finishing':phase='finishing';status();break;
      case 'finished':completed=true;phase='playing';status();settle();break;
      case 'error':fail(message.message||'翻译失败，请重新开始。');break;
    }
  }

  async function start() {
    if(running()||readingDevices||!capabilities?.ready)return;
    hide();const generation=epoch;phase='preparing';completed=false;
    find('[data-interpretation="error"]').hidden=true;status();
    try {
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('浏览器无法使用麦克风，请在本机浏览器中打开工作台。');
      const media=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,...(preferences.input?{deviceId:{exact:preferences.input}}:{})}});
      if(generation!==epoch){media.getTracks().forEach(track=>track.stop());return;}
      stream=media;stream.getAudioTracks().forEach(track=>track.onended=()=>fail('麦克风已断开，请检查设备后重新开始。'));
      await devices();
      if(generation!==epoch)return;
      const Audio=window.AudioContext||window.webkitAudioContext;
      const audio=new Audio({latencyHint:'interactive'});context=audio;await audio.resume();
      if(generation!==epoch){await audio.close().catch(()=>{});return;}
      if(preferences.output){
        if(!audio.setSinkId)throw new Error('当前浏览器无法使用所选播放设备，请选择系统默认播放设备。');
        try{await audio.setSinkId(preferences.output);}catch(error){throw new Error(error.name==='NotAllowedError'?'播放设备权限未开启，请允许访问后重试。':'所选播放设备不可用，请重新选择设备。');}
      }
      await audio.audioWorklet.addModule('/realtime/worklets/mic-capture.js?v=interpretation-1');
      if(generation!==epoch){await audio.close();return;}
      capture=new AudioWorkletNode(audio,'mic-capture');capture.port.postMessage({kind:'enable',value:true});
      capture.port.onmessage=event=>{
        if(generation!==epoch)return;
        const data=event.data;
        if(data instanceof ArrayBuffer){
          if(phase==='preparing'){earlyBytes+=data.byteLength;if(earlyBytes>16000*2*30){fail('模型准备时间过长，请重新开始。');return;}earlyAudio.push(data);}
          else if(socket?.readyState===WebSocket.OPEN&&['listening','finishing'].includes(phase)){if(socket.bufferedAmount>2*1024*1024){fail('音频连接跟不上收音，请检查服务后重新开始。');return;}socket.send(data);}
        }
        else if(data?.kind==='level')find('[data-interpretation="meter"]').style.width=`${Math.min(100,Math.sqrt(Math.max(0,data.rms))*180)}%`;
        else if(data?.kind==='flushed')flushResolve?.();
      };
      input=audio.createMediaStreamSource(media);mute=audio.createGain();mute.gain.value=0;input.connect(capture).connect(mute).connect(audio.destination);
      status('正在收音，模型准备中…');
      if(generation!==epoch)return;
      const ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/workbench/interpretation/live`);socket=ws;
      ws.onopen=()=>{if(generation===epoch)ws.send(JSON.stringify({type:'start',source_language:preferences.source_language,target_language:preferences.target_language,voice:preferences.voice}));};
      ws.onmessage=event=>{try{receive(JSON.parse(event.data),generation);}catch(error){if(generation===epoch)fail(error.message);}};
      ws.onerror=()=>{if(generation===epoch)fail('无法连接翻译服务，请检查工作台是否仍在运行。');};
      ws.onclose=()=>{onRuntimeChange();if(generation===epoch){socket=null;stopMic();if(!completed)fail('翻译连接已断开，请重新开始。');}};
    } catch(error) {
      if(generation!==epoch)return;
      const labels={NotAllowedError:'麦克风权限未开启，请允许浏览器使用麦克风后重试。',NotFoundError:'没有找到麦克风，请连接设备后重试。',NotReadableError:'麦克风正被其他程序占用，请检查设备后重试。',OverconstrainedError:'所选麦克风不可用，请重新选择设备。'};
      fail(labels[error.name]||error.message||'无法开始翻译，请重试。');
    }
  }

  async function finish() {
    if(phase!=='listening')return;
    const generation=epoch;phase='finishing';status();
    if(capture)await new Promise(resolve=>{flushResolve=resolve;capture.port.postMessage({kind:'flush'});setTimeout(resolve,250);});
    flushResolve=null;if(generation!==epoch)return;stopMic();
    if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'finish'}));
    else fail('翻译连接已断开，请重新开始。');
  }

  async function open() {
    if(!root.children.length)layout();
    try{capabilities=await api('/interpretation/capabilities');languages();const available=await devices();find('[data-interpretation="install"]').hidden=capabilities.ready;status(capabilities.ready?undefined:'模型尚未准备好');if(!available&&navigator.mediaDevices?.getUserMedia&&!root.hidden)await readDevices();}
    catch(error){fail(error.message);}
  }
  window.addEventListener('pagehide',hide);
  navigator.mediaDevices?.addEventListener?.('devicechange',()=>void devices());
  return {open,hide};
}
