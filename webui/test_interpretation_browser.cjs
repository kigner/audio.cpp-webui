const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const vm=require('node:vm');
const http=require('node:http');
const {chromium}=require(process.env.AUDIOCPP_PLAYWRIGHT_MODULE||'playwright');
const STATIC=path.join(__dirname,'workbench_static');
const fixtureHTML=`<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/workbench-static/app.css"><link rel="stylesheet" href="/workbench-static/scenarios.css"><link rel="stylesheet" href="/workbench-static/interpretation.css"></head><body style="margin:0;padding:24px"><section class="page management-page" id="root"></section><script type="module">import {createInterpretation} from '/workbench-static/interpretation.js';window.studio=createInterpretation({root:document.getElementById('root'),api:async path=>path.startsWith('/interpretation/recordings/')?fixture.recordings[path.split('/').at(-1)]:({ready:window.capabilityReady!==false,languages:[['zh','中文'],['en','英语'],['ja','日语']],voices:[{id:'british_english_female',label:'英式英语女声',language:'en'},{id:'british_english_male',label:'英式英语男声',language:'en'},{id:'american_english_female',label:'美式英语女声',language:'en'},{id:'american_english_male',label:'美式英语男声',language:'en'},{id:'japanese_female',label:'日语女声',language:'ja'},{id:'japanese_male',label:'日语男声',language:'ja'}]}),navigate:route=>{fixture.routes.push(route);studio.hide();},showToast:()=>{}});await studio.open();</script></body></html>`;

function mocks(){
  window.fixture={ready:true,permission:'allow',tracks:[],sockets:[],playbacks:[],routes:[],copies:[],constraints:[],recordings:{},devices:[{kind:'audioinput',deviceId:'mic-1',label:'Test microphone'},{kind:'audioinput',deviceId:'cable-rec',label:'CABLE Output (VB-Audio Virtual Cable)'},{kind:'audiooutput',deviceId:'speaker-1',label:'Test headphones'},{kind:'audiooutput',deviceId:'cable-play',label:'CABLE Input (VB-Audio Virtual Cable)'}]};
  const makeStream=()=>{const track={stopped:false,onended:null,stop(){this.stopped=true;}};fixture.tracks.push(track);return {getTracks:()=>[track],getAudioTracks:()=>[track]};};
  Object.defineProperty(navigator,'mediaDevices',{value:{
    enumerateDevices:async()=>fixture.devices,
    selectAudioOutput:async()=>fixture.devices.find(device=>device.deviceId==='cable-play'),
    addEventListener(name,callback){if(name==='devicechange')fixture.devicechange=callback;},getUserMedia:async options=>{fixture.constraints.push(options);if(fixture.permission==='deny')throw Object.assign(new Error('denied'),{name:'NotAllowedError'});if(fixture.permission==='wait')return new Promise(resolve=>fixture.grant=()=>resolve(makeStream()));return makeStream();}
  }});
  Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>fixture.copies.push(text)}});
  const node=()=>({connect(){return this;},disconnect(){},gain:{value:0}});
  window.AudioContext=class{
    constructor(){this.created=performance.now();this.destination={};this.audioWorklet={addModule:async()=>{}};}
    get currentTime(){return (performance.now()-this.created)/1000;}
    async resume(){}async close(){this.closed=true;}async setSinkId(value){if(fixture.sinkError)throw Object.assign(new Error('output denied'),{name:'NotAllowedError'});fixture.sink=value;}
    createGain(){return node();}createMediaStreamSource(){return node();}
    createBuffer(channels,length,rate){return {duration:length/rate,getChannelData:()=>new Float32Array(length)};}
    createBufferSource(){const context=this;const source={connect(){},disconnect(){},stop(){this.stopped=true;clearTimeout(this.timer);},start(when){this.when=when;fixture.playbacks.push(this);this.timer=setTimeout(()=>this.onended?.(),Math.max(0,(when-context.currentTime+this.buffer.duration)*1000));}};return source;}
  };
  window.AudioWorkletNode=class{
    constructor(){fixture.capture=this;this.port={onmessage:null,postMessage:data=>{if(data.kind==='flush')queueMicrotask(()=>{this.port.onmessage?.({data:new Int16Array([1,2,3]).buffer});this.port.onmessage?.({data:{kind:'flushed'}});});}};}
    connect(){return this;}disconnect(){}
  };
  window.WebSocket=class{
    static OPEN=1;
    constructor(){this.readyState=0;this.bufferedAmount=0;this.sent=[];fixture.sockets.push(this);this.id='interpretation-test-'+fixture.sockets.length;fixture.recordings[this.id]={state:'recording',clips:[],audio:null,pending:0};setTimeout(()=>{this.readyState=1;this.onopen?.();},0);}
    send(data){this.sent.push(typeof data==='string'?JSON.parse(data):{binary:data.byteLength});if(typeof data==='string'&&JSON.parse(data).type==='start')queueMicrotask(()=>{this.emit({type:'preparing'});if(fixture.ready)this.emit({type:'ready',recording_id:this.id});});}
    emit(data){this.onmessage?.({data:JSON.stringify(data)});}
    close(){this.readyState=3;queueMicrotask(()=>this.onclose?.());}
  };
}

const action=(page,name)=>page.locator(`[data-interpretation="${name}"]`);
async function emit(page,message){await page.evaluate(message=>fixture.sockets.at(-1).emit(message),message);}
async function listening(page){await action(page,'start').click();await page.waitForFunction(()=>document.querySelector('[data-interpretation="start"]').textContent.includes('结束翻译'));}
async function screenshot(page,name){if(process.env.AUDIOCPP_BROWSER_SCREENSHOTS){await fs.mkdir(process.env.AUDIOCPP_BROWSER_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.AUDIOCPP_BROWSER_SCREENSHOTS,name+'.png'),fullPage:true});}}
const cases=[
 ['minimal-friendly-layout',async(page)=>{assert.equal(await action(page,'source').inputValue(),'zh');assert.equal(await action(page,'target').inputValue(),'en');assert.equal(await page.locator('select').count(),5);assert.equal(await page.locator('textarea,input[type=number]').count(),0);await action(page,'swap').click();assert.equal(await action(page,'source').inputValue(),'en');assert.equal(await action(page,'target').inputValue(),'zh');await screenshot(page,'interpretation-desktop');}],
 ['builtin-voice-follows-target-and-is-sent',async(page)=>{assert.equal(await action(page,'voice').locator('option').count(),5);await action(page,'voice').selectOption('british_english_male');await listening(page);assert.equal(await page.evaluate(()=>fixture.sockets[0].sent[0].voice),'british_english_male');await action(page,'cancel').click();await action(page,'target').selectOption('ja');assert.equal(await action(page,'voice').inputValue(),'');assert.equal(await action(page,'voice').locator('option').count(),3);await action(page,'voice').selectOption('japanese_male');await listening(page);assert.equal(await page.evaluate(()=>fixture.sockets.at(-1).sent[0].voice),'japanese_male');}],
 ['virtual-audio-input-and-output-are-routed-separately',async(page)=>{await action(page,'input').selectOption('mic-1');await action(page,'output').selectOption('cable-play');await listening(page);assert.equal(await page.evaluate(()=>fixture.sink),'cable-play');assert.equal(await page.evaluate(()=>fixture.constraints.at(-1).audio.deviceId.exact),'mic-1');assert.equal(await action(page,'output').locator('option[value="cable-rec"]').count(),0);}],
 ['permission-refresh-keeps-saved-device-selection',async(page)=>{await action(page,'input').selectOption('cable-rec');await action(page,'output').selectOption('cable-play');await page.evaluate(async()=>{fixture.originalDevices=fixture.devices;fixture.devices=[];await studio.open();});assert.equal(await action(page,'input').inputValue(),'cable-rec');assert.equal(await action(page,'output').inputValue(),'cable-play');await page.evaluate(()=>fixture.devices=fixture.originalDevices);await action(page,'devices').click();await page.waitForFunction(()=>fixture.tracks.length&&fixture.tracks.every(track=>track.stopped));assert.equal(await action(page,'output').inputValue(),'cable-play');assert.equal(await page.evaluate(()=>fixture.sockets.length),0);}],
 ['browser-output-picker-and-unplug',async(page)=>{await action(page,'output').selectOption('__choose_output__');await page.waitForFunction(()=>document.querySelector('[data-interpretation="output"]').value==='cable-play');await listening(page);await page.evaluate(()=>{fixture.devices=fixture.devices.filter(device=>device.deviceId!=='cable-play');fixture.devicechange();});await action(page,'error').waitFor({state:'visible'});assert.match(await action(page,'error').textContent(),/播放设备已断开/);assert.equal(await page.evaluate(()=>fixture.tracks.every(track=>track.stopped)),true);}],
 ['output-permission-error-is-not-reported-as-microphone-error',async(page)=>{await action(page,'output').selectOption('cable-play');await page.evaluate(()=>fixture.sinkError=true);await action(page,'start').click();await action(page,'error').waitFor({state:'visible'});assert.match(await action(page,'error').textContent(),/播放设备权限/);assert.equal(await page.evaluate(()=>fixture.sockets.length),0);assert.equal(await page.evaluate(()=>fixture.tracks.every(track=>track.stopped)),true);}],
 ['unsupported-output-selection-uses-explicit-system-default',async(page)=>{await page.evaluate(async()=>{delete AudioContext.prototype.setSinkId;await studio.open();});assert.equal(await action(page,'output').isDisabled(),true);assert.match(await action(page,'device-hint').textContent(),/系统默认/);await listening(page);}],
 ['audio-download-finishes-after-immediate-stop',async(page)=>{await listening(page);await emit(page,{type:'translated',id:1,source:'你好。',translation:'Hello.'});await emit(page,{type:'segment_done',id:1,pending:0});await action(page,'cancel').click();await page.evaluate(()=>{fixture.recordings['interpretation-test-1']={state:'done',clips:[{id:1,audio:{url:'/api/workbench/files/clip1',name:'0001.wav'}}],audio:{url:'/api/workbench/files/full1',name:'session.wav'}};});await action(page,'download').waitFor({state:'visible'});await page.locator('[data-row-download]').waitFor({state:'visible'});const downloaded=page.waitForEvent('download');await action(page,'download').click();const file=await downloaded;assert.equal(file.suggestedFilename(),'session.wav');const bytes=await fs.readFile(await file.path());assert.equal(bytes.subarray(0,4).toString(),'RIFF');assert.equal(bytes.subarray(8,12).toString(),'WAVE');}],
 ['saving-error-does-not-stop-live-translation',async(page)=>{await listening(page);await page.evaluate(()=>{fixture.recordings['interpretation-test-1']={state:'error',clips:[],audio:null,message:'部分译音保存失败，请检查输出目录和磁盘空间。'};});await page.waitForFunction(()=>document.querySelector('[data-interpretation="saving"]').textContent.includes('磁盘'));assert.equal(await action(page,'start').textContent(),'结束翻译');assert.equal(await action(page,'error').isVisible(),false);assert.equal(await page.evaluate(()=>fixture.tracks.some(track=>!track.stopped)),true);}],
 ['language-collision-is-resolved',async(page)=>{await action(page,'source').selectOption('en');assert.equal(await action(page,'target').inputValue(),'zh');}],
 ['missing-model-guides-install',async(page)=>{await page.evaluate(async()=>{window.capabilityReady=false;await studio.open();});await action(page,'models').waitFor({state:'visible'});assert.equal(await action(page,'start').isDisabled(),true);await action(page,'models').click();assert.deepEqual(await page.evaluate(()=>fixture.routes),['models']);}],
 ['permission-error-does-not-open-native-session',async(page)=>{await page.evaluate(()=>fixture.permission='deny');await action(page,'start').click();await action(page,'error').waitFor({state:'visible'});assert.match(await action(page,'error').textContent(),/权限/);assert.equal(await page.evaluate(()=>fixture.sockets.length),0);assert.equal(await action(page,'start').isEnabled(),true);}],
 ['speech-during-model-preparation-is-preserved',async(page)=>{await page.evaluate(()=>fixture.ready=false);await action(page,'start').click();await page.waitForFunction(()=>fixture.sockets.length&&fixture.sockets[0].readyState===1);await page.evaluate(()=>fixture.capture.port.onmessage({data:new Int16Array([10,20,30,40]).buffer}));assert.equal(await page.evaluate(()=>fixture.sockets[0].sent.some(item=>item.binary)),false);await emit(page,{type:'ready'});assert.equal(await page.evaluate(()=>fixture.sockets[0].sent.some(item=>item.binary===8)),true);await action(page,'cancel').click();}],
 ['staged-captions-and-ordered-audio',async(page)=>{
   await listening(page);await emit(page,{type:'segment',id:1,start:0,end:3,pending:0});await emit(page,{type:'recognized',id:1,source:'大家好。',translation:''});assert.equal(await page.locator('[data-row-source]').textContent(),'大家好。');
   await emit(page,{type:'translated',id:1,source:'大家好。',translation:'Hello everyone.'});const pcm=Buffer.alloc(4800).toString('base64');
   await emit(page,{type:'audio',id:1,pcm,sample_rate:24000,first:true});await emit(page,{type:'audio',id:1,pcm,sample_rate:24000,first:false});await emit(page,{type:'speech',active:true});
   assert.equal(await page.evaluate(()=>fixture.playbacks.some(source=>source.stopped)),false,'New speech must not interrupt translated playback');
   await emit(page,{type:'segment_done',id:1,pending:0});assert.equal(await page.locator('.interpretation-row').count(),1);assert.equal(await page.locator('[data-row-translation]').textContent(),'Hello everyone.');
   assert.equal(await page.evaluate(()=>fixture.playbacks[1].when>=fixture.playbacks[0].when+fixture.playbacks[0].buffer.duration-.001),true);
   await action(page,'copy').click();assert.deepEqual(await page.evaluate(()=>fixture.copies),['大家好。\nHello everyone.']);await screenshot(page,'interpretation-captions');
   await action(page,'start').click();await page.waitForFunction(()=>fixture.sockets.at(-1).sent.some(value=>value.type==='finish'));
   assert.equal(await page.evaluate(()=>{const sent=fixture.sockets.at(-1).sent;return sent.findIndex(value=>value.binary)>0&&sent.findIndex(value=>value.binary)<sent.findIndex(value=>value.type==='finish');}),true,'Flush microphone tail before finish');
   await emit(page,{type:'finished'});await page.waitForFunction(()=>document.querySelector('[data-interpretation="start"]').textContent.includes('开始翻译'));
   assert.equal(await page.evaluate(()=>fixture.tracks.every(track=>track.stopped)),true);
 }],
 ['immediate-stop-ignores-late-events',async(page)=>{await listening(page);await action(page,'cancel').click();await emit(page,{type:'translated',id:99,source:'late',translation:'late'});assert.equal(await page.locator('.interpretation-row').count(),0);assert.equal(await page.evaluate(()=>fixture.tracks.every(track=>track.stopped)),true);}],
 ['late-permission-does-not-revive-cancelled-session',async(page)=>{await page.evaluate(()=>fixture.permission='wait');await action(page,'start').click();await action(page,'cancel').click();await page.evaluate(()=>fixture.grant());await page.waitForTimeout(50);assert.equal(await page.evaluate(()=>fixture.sockets.length),0);assert.equal(await page.evaluate(()=>fixture.tracks.every(track=>track.stopped)),true);}],
 ['navigation-stops-microphone',async(page)=>{await listening(page);await action(page,'back').click();assert.equal(await page.evaluate(()=>fixture.tracks.every(track=>track.stopped)),true);assert.equal(await page.evaluate(()=>fixture.sockets.at(-1).readyState),3);}],
 ['native-error-releases-ui',async(page)=>{await listening(page);await emit(page,{type:'error',message:'测试错误'});await action(page,'error').waitFor({state:'visible'});assert.equal(await action(page,'source').isEnabled(),true);assert.equal(await action(page,'start').isEnabled(),true);assert.equal(await page.evaluate(()=>fixture.tracks.every(track=>track.stopped)),true);}],
 ['new-session-clears-previous-segment-identities',async(page)=>{await listening(page);await emit(page,{type:'translated',id:1,source:'上一轮',translation:'Previous turn'});await action(page,'cancel').click();await listening(page);assert.equal(await page.locator('.interpretation-row').count(),0);}],
 ['mobile-and-english-theme',async(page)=>{await page.setViewportSize({width:390,height:844});await page.evaluate(async()=>{const language=await import('/workbench-static/i18n.js');await language.setLanguage('en');language.applyLanguage();document.documentElement.dataset.theme='dark';});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await screenshot(page,'interpretation-mobile-dark');await page.setViewportSize({width:320,height:800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}],
];

(async()=>{
 let Processor;const sent=[];vm.runInNewContext(await fs.readFile(path.join(__dirname,'realtime_static/worklets/mic-capture.js'),'utf8'),{AudioWorkletProcessor:class{constructor(){this.port={postMessage:value=>sent.push(value)};}},sampleRate:48000,registerProcessor:(_,value)=>Processor=value});const processor=new Processor({processorOptions:{chunkMs:40}});processor._ingest(new Float32Array(300).fill(.2));assert.equal(sent.filter(value=>value?.byteLength).length,0);processor.port.onmessage({data:{kind:'flush'}});assert.equal(sent.find(value=>value?.byteLength)?.byteLength,200);assert.equal(sent.at(-1).kind,'flushed');console.log('PASS real-worklet-flush-keeps-tail');
 const browser=await chromium.launch({headless:true,...(process.env.AUDIOCPP_BROWSER_EXECUTABLE?{executablePath:process.env.AUDIOCPP_BROWSER_EXECUTABLE}:{})});let failures=0;
 // Serve real HTTP for media downloads as well as the page and its modules.
 const downloadServer=http.createServer(async(request,response)=>{
  const url=new URL(request.url,'http://127.0.0.1');
  if(url.pathname==='/fixture'){response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(fixtureHTML);return;}
  if(url.pathname.startsWith('/workbench-static/')&&!url.pathname.includes('..')){
   try{const file=path.join(STATIC,url.pathname.slice('/workbench-static/'.length));const bytes=await fs.readFile(file);response.writeHead(200,{'Content-Type':({'.js':'text/javascript','.css':'text/css','.json':'application/json'}[path.extname(file)]||'application/octet-stream')+'; charset=utf-8'});response.end(bytes);return;}catch{}
  }
  if(url.pathname.startsWith('/api/workbench/files/')){
   const wav=Buffer.alloc(48);wav.write('RIFF');wav.writeUInt32LE(40,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(4,40);
   response.writeHead(200,{'Content-Type':'audio/wav','Content-Length':wav.length,'Content-Disposition':'attachment; filename="session.wav"'});response.end(wav);return;
  }
  response.writeHead(404);response.end('not found');
 });
 await new Promise(resolve=>downloadServer.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${downloadServer.address().port}`;
 for(const [name,run] of cases){const context=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000},locale:'zh-CN'});const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));await context.addInitScript(mocks);page.setDefaultTimeout(7000);

  try{await page.goto(origin+'/fixture');await action(page,'source').waitFor();await run(page);assert.deepEqual(errors,[]);console.log('PASS',name);}catch(error){failures++;console.error('FAIL',name,error.stack,errors);await screenshot(page,'failure-'+name);}finally{await context.close();}
 }
 await browser.close();await new Promise(resolve=>downloadServer.close(resolve));console.log(`Interpretation browser: ${cases.length+1-failures}/${cases.length+1}`);if(failures)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
