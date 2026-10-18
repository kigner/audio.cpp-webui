/* Real page and AudioWorklets, synthetic microphone, fixture HTTP/WebSocket.
 * No physical microphone, model activation or cloud requests.
 * Optional AUDIOCPP_PLAYWRIGHT_MODULE and AUDIOCPP_BROWSER_EXECUTABLE.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require(process.env.AUDIOCPP_PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const options = {headless:true, args:['--autoplay-policy=no-user-gesture-required']};
  if (process.env.AUDIOCPP_BROWSER_EXECUTABLE) options.executablePath = process.env.AUDIOCPP_BROWSER_EXECUTABLE;
  const browser = await chromium.launch(options);
  // Chromium loads AudioWorklet scripts outside Playwright page routing.
  const server = http.createServer(async (request,response) => {
    const name = request.url?.split('/').at(-1);
    if (!['mic-capture.js','audio-playback.js'].includes(name)) {response.writeHead(404).end();return;}
    try {
      const source = await fs.readFile(path.join(__dirname,'realtime_static','worklets',name));
      response.writeHead(200,{'Content-Type':'text/javascript'}).end(source);
    } catch {response.writeHead(500).end();}
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let page = await browser.newPage({viewport:{width:1280,height:800}});
  const errors = [], activations = [], audio = [];
  const consoleErrors = [];
  page.on('console', message => {if (message.type() === 'error') consoleErrors.push(message.text());});
  let connections = 0;
  let activationGate = null;
  page.on('pageerror', error => errors.push(error.message));
  const config = {api_base:'/api/realtime',tts_model:'preset',asr_models:[],tts_models:[
    {id:'preset',family:'magpie_tts',label:'Fixture TTS',accepts_voice_reference:false,
      voices:[{label:'Aria',value:'Aria'}]},
  ]};
  await page.addInitScript(() => {
    window.micRequests = [];
    window.micTracks = [];
    window.micUnavailable = false;
    navigator.mediaDevices.enumerateDevices = async () => [
      {kind:'audioinput',deviceId:'default',label:'默认 - CABLE Output'},
      {kind:'audioinput',deviceId:'virtual',label:'CABLE Output'},
      ...(!window.micUnavailable ? [{kind:'audioinput',deviceId:'physical',label:'实体麦克风'}] : []),
      {kind:'audiooutput',deviceId:'speaker',label:'扬声器'},
    ];
    navigator.mediaDevices.getUserMedia = async constraints => {
      if (window.micGate) await window.micGate;
      window.micRequests.push(constraints);
      const selected = constraints.audio.deviceId?.exact;
      if (selected === 'physical' && window.micUnavailable) throw new DOMException('Disconnected', 'OverconstrainedError');
      const context = new AudioContext({sampleRate:48000});
      await context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      gain.gain.value = selected === 'physical' ? 0.2 : 0;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(gain).connect(destination);
      oscillator.start();
      for (const track of destination.stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => {stop();void context.close();};
        window.micTracks.push(track);
      }
      return destination.stream;
    };
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (['/workbench-static/i18n.js','/workbench-static/locales/en.json'].includes(url.pathname)) {
      return route.fulfill({body:await fs.readFile(path.join(__dirname,'workbench_static',url.pathname.slice('/workbench-static/'.length))),contentType:url.pathname.endsWith('.json')?'application/json':'text/javascript'});
    }
    if (url.pathname === '/api/realtime/config') return route.fulfill({json:config});
    if (url.pathname === '/api/workbench/voices') return route.fulfill({json:{voices:[]}});
    if (url.pathname === '/api/realtime/activate') {
      activations.push(route.request().postDataJSON());
      if (activationGate) await activationGate;
      return route.fulfill({json:{status:'ok'}});
    }
    if (url.pathname === '/fixture-shell') return route.fulfill({contentType:'text/html',body:
      '<iframe src="/realtime/" style="width:1200px;height:750px"></iframe>'});
    // Character rendering is independent of microphone selection/capture.
    if (url.pathname.endsWith('/companion/live.js')) return route.fulfill({contentType:'text/javascript',body:'export async function mountLiveCharacter(){return null;}'});
    if (url.pathname.startsWith('/realtime/')) {
      const relative = decodeURIComponent(url.pathname.slice('/realtime/'.length)) || 'index.html';
      const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png'};
      try {return route.fulfill({body:await fs.readFile(path.join(__dirname,'realtime_static',relative)),contentType:types[path.extname(relative)]||'application/octet-stream'});} catch {}
    }
    return route.fulfill({status:404,body:'Fixture route missing'});
  });
  await page.routeWebSocket('**/v1/realtime', ws => {
    connections++;
    ws.send(JSON.stringify({type:'session.created'}));
    ws.onMessage(raw => {
      const message = JSON.parse(raw);
      if (message.type === 'session.update') ws.send(JSON.stringify({type:'session.updated'}));
      if (message.type === 'input_audio_buffer.append') audio.push(Buffer.from(message.audio,'base64'));
      if (message.type === 'user.text') {
        ws.send(JSON.stringify({type:'user.text.accepted',generation:1,request_id:message.request_id}));
        ws.send(JSON.stringify({type:'response.done',generation:1,response:{id:'fixture',status:'completed'}}));
      }
    });
  });
  const state = value => page.waitForFunction(value => document.body.dataset.callState === value, value);
  const openSettings = async () => {
    await page.locator('#call-more summary').click();
    await page.locator('#settings-btn').click();
    await page.locator('[data-settings-tab="asr"]').click();
    await page.waitForFunction(() => document.querySelector('#mic-device').options.length >= 3);
  };
  const waitAudio = async () => {
    const start = audio.length;
    for (let count=0;count<100 && audio.length<start+5;count++) await page.waitForTimeout(50);
    assert.ok(audio.length >= start+5, `microphone must keep streaming: ${JSON.stringify({consoleErrors,errors,state:await page.locator('body').getAttribute('data-call-state'),notice:await page.locator('#realtime-notice-text').textContent()})}`);
  };
  let checks = 0;
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/realtime/`);
    await state('idle');
    await openSettings();
    assert.equal(await page.evaluate(() => window.micRequests.length),0);
    assert.match(await page.locator('#mic-device option:checked').textContent(), /CABLE/);
    assert.equal(await page.locator('#mic-device option[value="speaker"]').count(),0);
    checks++;

    await page.locator('#mic-refresh').click();
    await page.waitForFunction(() => !document.querySelector('#mic-refresh').disabled);
    assert.equal(await page.evaluate(() => window.micTracks.every(track => track.readyState === 'ended')),true);
    assert.equal(activations.length,0);
    checks++;

    await page.locator('#mic-device').selectOption('physical');
    await page.locator('#settings-save').click();
    await page.waitForFunction(() => localStorage.getItem('audiocpp.mic.deviceId') === 'physical');
    await page.reload();
    await state('idle');
    await openSettings();
    assert.equal(await page.locator('#mic-device').inputValue(),'physical');
    await page.locator('#mic-device').selectOption('virtual');
    await page.locator('.modal-footer button[value="close"]').click();
    checks++;

    await page.locator('#main-circle').click();
    await state('listening');
    await waitAudio();
    assert.deepEqual(await page.evaluate(() => window.micRequests.map(r => r.audio.deviceId?.exact)),['physical','physical']);
    assert.ok(audio.some(buffer => buffer.some(byte => byte !== 0)), 'chosen physical input must produce non-silent PCM');
    assert.equal(await page.locator('#scene-waveform').isVisible(),true);
    await page.waitForFunction(() => Number(document.querySelector('#scene-waveform').style.getPropertyValue('--mic-level')) > 0);
    checks++;

    const beforeLanguage={connections,activations:activations.length,mic:await page.evaluate(()=>window.micRequests.length)};
    await page.evaluate(async()=>{const {setLanguage}=await import('/workbench-static/i18n.js');setLanguage('en');});
    assert.equal(await page.locator('html').getAttribute('lang'),'en');
    assert.equal(await page.locator('.circle-caption').textContent(),'Listening');
    await waitAudio();
    assert.deepEqual({connections,activations:activations.length,mic:await page.evaluate(()=>window.micRequests.length)},beforeLanguage);
    await page.evaluate(async()=>{const {setLanguage}=await import('/workbench-static/i18n.js');setLanguage('zh');});
    checks++;

    await page.locator('#mic-btn').click();
    await page.waitForTimeout(150);
    const mutedFrames = audio.length;
    await page.waitForTimeout(250);
    assert.equal(audio.length,mutedFrames);
    assert.equal(await page.locator('#scene-waveform').isVisible(),false);
    await page.locator('#mic-btn').click();
    await waitAudio();
    checks++;

    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.locator('#scene-waveform').isVisible(),true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    await page.setViewportSize({width:1280,height:800});
    await page.locator('#stop-btn').click();
    await state('idle');
    assert.equal(await page.locator('#scene-waveform').isVisible(),false);
    assert.equal(await page.evaluate(() => window.micTracks.every(track => track.readyState === 'ended')),true);
    checks++;

    const beforeText = await page.evaluate(() => window.micRequests.length);
    await page.locator('#text-toggle').click();
    await page.locator('#text-input').fill('fixture text');
    await page.locator('#text-send').click();
    await state('listening');
    assert.equal(await page.evaluate(() => window.micRequests.length),beforeText);
    assert.equal(await page.locator('#scene-waveform').isVisible(),false);
    const beforeEnable = connections;
    await page.locator('#main-circle').click();
    await page.waitForFunction(() => document.body.dataset.microphone === 'on');
    await waitAudio();
    assert.equal(connections,beforeEnable,'enabling microphone preserves text session');
    assert.equal(await page.evaluate(() => window.micRequests.at(-1).audio.deviceId.exact),'physical');
    checks++;

    // Saving a different device disconnects the old capture before reconnect.
    await openSettings();
    await page.locator('#mic-device').selectOption('virtual');
    await page.locator('#settings-save').click();
    await state('idle');
    assert.equal(await page.evaluate(() => window.micTracks.every(track => track.readyState === 'ended')),true);
    checks++;

    await openSettings();
    await page.locator('#mic-device').selectOption('physical');
    await page.locator('#settings-save').click();
    await page.evaluate(() => {window.micUnavailable=true;});
    await openSettings();
    await page.waitForFunction(() => document.querySelector('#mic-device').selectedOptions[0].textContent.includes('未检测到'));
    assert.equal(await page.locator('#mic-device').inputValue(),'physical');
    await page.locator('#settings-save').click();
    const beforeUnavailable = activations.length;
    await page.locator('#main-circle').click();
    await state('error');
    assert.match(await page.locator('#realtime-notice-text').textContent(),/所选麦克风不可用/);
    assert.equal(activations.length,beforeUnavailable,'missing device must fail before model activation');
    assert.equal(await page.locator('#scene-waveform').isVisible(),false);
    checks++;

    // The shell retains the iframe when Back is clicked: unloading cannot hide a leak.
    const shell = page;
    await shell.goto(`http://127.0.0.1:${server.address().port}/fixture-shell`);
    page = await (await shell.locator('iframe').elementHandle()).contentFrame();
    await state('idle');
    await page.locator('#main-circle').click();
    await state('listening');
    await waitAudio();
    await page.locator('#scene-back').click();
    await state('idle');
    assert.equal(await page.evaluate(() => window.micTracks.every(track => track.readyState === 'ended')),true);
    await page.waitForTimeout(100);
    const afterBack = audio.length;
    await page.waitForTimeout(200);
    assert.equal(audio.length,afterBack,'Back must stop sending microphone audio');
    checks++;

    // A model activation finishing after Back must not reopen capture or the socket.
    let releaseActivation;
    activationGate = new Promise(resolve => {releaseActivation = resolve;});
    const beforePending = activations.length;
    const beforePendingConnections = connections;
    await page.locator('#main-circle').click();
    for (let n=0;n<100 && activations.length===beforePending;n++) await page.waitForTimeout(20);
    assert.equal(activations.length,beforePending+1);
    await page.locator('#scene-back').click();
    await state('idle');
    activationGate = null;
    releaseActivation();
    await page.waitForTimeout(250);
    assert.equal(connections,beforePendingConnections);
    assert.equal(await page.evaluate(() => window.micTracks.every(track => track.readyState === 'ended')),true);
    checks++;

    // Late permission must be released and must not start model activation.
    await page.evaluate(() => {window.micGate = new Promise(resolve => {window.releaseMic = resolve;});});
    const beforePermission = activations.length;
    await page.locator('#main-circle').click();
    await state('connecting');
    await page.locator('#scene-back').click();
    await state('idle');
    await page.evaluate(() => {window.releaseMic();window.micGate = null;});
    await page.waitForTimeout(250);
    assert.equal(activations.length,beforePermission);
    assert.equal(await page.evaluate(() => window.micTracks.every(track => track.readyState === 'ended')),true);
    checks++;

    await page.locator('#main-circle').click();
    await state('listening');
    await waitAudio();
    await page.locator('#scene-back').click();
    await state('idle');
    assert.equal(await page.evaluate(() => window.micTracks.every(track => track.readyState === 'ended')),true);
    checks++;

    assert.deepEqual(errors,[]);
    console.log(`Realtime microphone browser regression: ${checks}/${checks} passed`);
  } finally {await browser.close();await new Promise(resolve => server.close(resolve));}
})().catch(error => {console.error(error);process.exitCode=1;});
