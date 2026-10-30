const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const vm=require('node:vm');
const {chromium}=require(process.env.AUDIOCPP_PLAYWRIGHT_MODULE||'playwright');
const STATIC=path.join(__dirname,'workbench_static');

function mocks(){
  window.fixture={ready:true,permission:'allow',tracks:[],sockets:[],playbacks:[],routes:[],copies:[]};
  const makeStream=()=>{const track={stopped:false,onended:null,stop(){this.stopped=true;}};fixture.tracks.push(track);return {getTracks:()=>[track],getAudioTracks:()=>[track]};};
  Object.defineProperty(navigator,'mediaDevices',{value:{
    enumerateDevices:async()=>[{kind:'audioinput',deviceId:'mic-1',label:'Test microphone'},{kind:'audiooutput',deviceId:'speaker-1',label:'Test headphones'}],
    addEventListener(){},getUserMedia:async()=>{if(fixture.permission==='deny')throw Object.assign(new Error('denied'),{name:'NotAllowedError'});if(fixture.permission==='wait')return new Promise(resolve=>fixture.grant=()=>resolve(makeStream()));return makeStream();}
  }});
  Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>fixture.copies.push(text)}});
  const node=()=>({connect(){return this;},disconnect(){},gain:{value:0}});
  window.AudioContext=class{
    constructor(){this.created=performance.now();this.destination={};this.audioWorklet={addModule:async()=>{}};}
    get currentTime(){return (performance.now()-this.created)/1000;}
    async resume(){}async close(){this.closed=true;}async setSinkId(value){fixture.sink=value;}
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
    constructor(){this.readyState=0;this.bufferedAmount=0;this.sent=[];fixture.sockets.push(this);setTimeout(()=>{this.readyState=1;this.onopen?.();},0);}
    send(data){this.sent.push(typeof data==='string'?JSON.parse(data):{binary:data.byteLength});if(typeof data==='string'&&JSON.parse(data).type==='start')queueMicrotask(()=>{this.emit({type:'preparing'});if(fixture.ready)this.emit({type:'ready'});});}
    emit(data){this.onmessage?.({data:JSON.stringify(data)});}
    close(){this.readyState=3;queueMicrotask(()=>this.onclose?.());}
  };
}

const action=(page,name)=>page.locator(`[data-interpretation="${name}"]`);
async function emit(page,message){await page.evaluate(message=>fixture.sockets.at(-1).emit(message),message);}
async function listening(page){await action(page,'start').click();await page.waitForFunction(()=>document.querySelector('[data-interpretation="start"]').textContent.includes('结束翻译'));}
async function screenshot(page,name){if(process.env.AUDIOCPP_BROWSER_SCREENSHOTS){await fs.mkdir(process.env.AUDIOCPP_BROWSER_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.AUDIOCPP_BROWSER_SCREENSHOTS,name+'.png'),fullPage:true});}}
const cases=[
 ['minimal-friendly-layout',async(page)=>{assert.equal(await action(page,'source').inputValue(),'zh');assert.equal(await action(page,'target').inputValue(),'en');assert.equal(await page.locator('select').count(),4);assert.equal(await page.locator('textarea,input[type=number]').count(),0);await action(page,'swap').click();assert.equal(await action(page,'source').inputValue(),'en');assert.equal(await action(page,'target').inputValue(),'zh');await screenshot(page,'interpretation-desktop');}],
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
 for(const [name,run] of cases){const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'});const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));await context.addInitScript(mocks);page.setDefaultTimeout(7000);
  await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.pathname==='/fixture'){return route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="zh-CN" data-theme="light"><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/workbench-static/app.css"><link rel="stylesheet" href="/workbench-static/scenarios.css"><link rel="stylesheet" href="/workbench-static/interpretation.css"></head><body style="margin:0;padding:24px"><section class="page management-page" id="root"></section><script type="module">import {createInterpretation} from '/workbench-static/interpretation.js';window.studio=createInterpretation({root:document.getElementById('root'),api:async()=>({ready:window.capabilityReady!==false,languages:[['zh','中文'],['en','英语'],['ja','日语']]}),navigate:route=>{fixture.routes.push(route);studio.hide();},showToast:()=>{}});await studio.open();</script></body></html>`});}if(url.pathname.startsWith('/workbench-static/')){const file=path.join(STATIC,url.pathname.slice('/workbench-static/'.length));return route.fulfill({contentType:{'.js':'text/javascript','.css':'text/css','.json':'application/json'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file)});}return route.fulfill({status:404,body:'not found'});});
  try{await page.goto('http://127.0.0.1:41317/fixture');await action(page,'source').waitFor();await run(page);assert.deepEqual(errors,[]);console.log('PASS',name);}catch(error){failures++;console.error('FAIL',name,error.stack,errors);await screenshot(page,'failure-'+name);}finally{await context.close();}
 }
 await browser.close();console.log(`Interpretation browser: ${cases.length+1-failures}/${cases.length+1}`);if(failures)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
