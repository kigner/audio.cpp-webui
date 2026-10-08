/* Real realtime page with fixture APIs; no model, microphone or cloud calls.
 * node webui/test_realtime_settings_browser.cjs
 * Optional AUDIOCPP_PLAYWRIGHT_MODULE, AUDIOCPP_BROWSER_EXECUTABLE,
 * AUDIOCPP_BROWSER_SCREENSHOTS.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require(process.env.AUDIOCPP_PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const options = {headless:true,args:['--enable-gpu','--use-angle=d3d11','--autoplay-policy=no-user-gesture-required']};
  if (process.env.AUDIOCPP_BROWSER_EXECUTABLE) options.executablePath = process.env.AUDIOCPP_BROWSER_EXECUTABLE;
  const browser = await chromium.launch(options);
  const page = await browser.newPage({viewport:{width:1440,height:900}});
  const errors = [], activations = [];
  const consoleErrors = [];
  page.on('console', message => {if(message.type()==='error')consoleErrors.push(message.text());});
  page.on('pageerror', error => errors.push(error.message));
  let libraryFails = false;
  const reference = {name:'示例.wav',label:'示例女声',text:'你好，今天过得怎么样？',
    voice_ref:'D:/fixture/voice/示例.wav',url:'/api/workbench/references/example/audio'};
  const female = {name:'demo_02_woman.wav',label:'内置女声',text:'默认角色的参考原文',voice_ref:'D:/fixture/voice/demo_02_woman.wav',url:'/api/workbench/references/female/audio'};
  let voices = [reference,female];
  const uploads = [], referenceSaves = [], requests = [];
  const models = [
    {id:'clone',family:'qwen3_tts',label:'Qwen Base',voices:[],accepts_voice_reference:true,requires_reference_text:true},
    {id:'preset',family:'magpie_tts',label:'Preset TTS',voice_parameter:'voice_id',accepts_voice_reference:false,
      voices:[{label:'Aria',value:'Aria'},{label:'Jason',value:'Jason'}]},
    {id:'cached',family:'pocket_tts',label:'Pocket',voices:[{label:'Alba',value:'alba'}],accepts_voice_reference:true}
  ];
  const config = {api_base:'/api/realtime',tts_model:'clone',tts_models:models,asr_models:[]};
  await page.addInitScript(() => {
    if (!localStorage.getItem('fixture-initialized')) {
      localStorage.setItem('audiocpp.tts.model','clone');
      localStorage.setItem('audiocpp.tts.voiceRef','voice/示例.wav');
      localStorage.setItem('audiocpp.tts.refText','保存的原文');
      localStorage.setItem('fixture-initialized','1');
    }
    window.micRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => {window.micRequests++;throw new Error('Unexpected microphone request');};
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    if (url.pathname === '/api/realtime/config') return route.fulfill({json:config});
    if (url.pathname === '/api/workbench/voices') return route.fulfill(libraryFails ? {status:503,body:'unavailable'} : {json:{voices}});
    if (url.pathname === '/api/workbench/uploads') {
      uploads.push(route.request().postDataBuffer().toString());
      return route.fulfill({json:{id:'uploaded-audio',name:'示例.wav'}});
    }
    if (url.pathname === '/api/workbench/references' && route.request().method() === 'POST') {
      const value = route.request().postDataJSON();referenceSaves.push(value);
      if (value.name === '示例') return route.fulfill({status:409,json:{detail:'已有同名参考音频'}});
      const voice = {name:value.name+'.wav',label:value.name,text:value.text,voice_ref:'D:/fixture/voice/'+value.name+'.wav',url:'/api/workbench/references/uploaded/audio'};
      voices = [...voices,voice];return route.fulfill({json:{name:voice.name,voices}});
    }
    if (url.pathname === '/api/realtime/activate') {
      activations.push(route.request().postDataJSON());
      return route.fulfill({status:503,json:{detail:'Fixture: activation intentionally stopped'}});
    }
    if (url.pathname.startsWith('/api/workbench/references/')) return route.fulfill({status:204});
    const relative = decodeURIComponent(url.pathname).replace(/^\//,'');
    const filename = relative.startsWith('realtime/') ? path.join(__dirname,'realtime_static',relative.slice(9)||'index.html') :
      relative.startsWith('workbench/') ? path.join(__dirname,'workbench_static',relative.slice(10)) : '';
    if (filename) {
      const types = {'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.css':'text/css','.png':'image/png'};
      try {return route.fulfill({body:await fs.readFile(filename),contentType:types[path.extname(filename)]||'application/octet-stream'});} catch {}
    }
    return route.fulfill({status:404,body:'Fixture route missing'});
  });
  const open = async () => {
    await page.locator('#call-more summary').click();
    await page.locator('#settings-btn').click();
    await page.locator('[data-settings-tab="character"]').click();
    await page.waitForFunction(() => document.querySelector('#tts-voice-ref').options.length > 1);
  };
  const save = () => page.locator('#settings-save').click();
  const selectModel = async value => {
    await page.locator('[data-settings-tab="tts"]').click();
    await page.locator('#tts-model').selectOption(value);
    await page.locator('[data-settings-tab="character"]').click();
  };
  const selectVoice = async value => {
    await page.locator('[data-settings-tab="tts"]').click();
    await page.locator('#tts-voice').selectOption(value);
    await page.locator('[data-settings-tab="character"]').click();
  };
  const send = async () => {
    if (await page.locator('#text-composer').isHidden()) await page.locator('#text-toggle').click();
    await page.locator('#text-input').fill('测试请求');
    const request = page.waitForRequest('**/api/realtime/activate');
    await page.locator('#text-send').click();
    await request;
    await page.waitForFunction(() => document.body.dataset.callState === 'error');
    await page.locator('#realtime-notice-dismiss').click();
    return activations.at(-1);
  };
  try {
    await page.goto('http://127.0.0.1:17781/realtime/');
    await page.waitForFunction(() => document.querySelector('#tts-model').options.length === 3);
    await page.waitForSelector('#live-character-stage canvas');
    await open();
    let bounds = await page.locator('#settings-modal').boundingBox();assert.equal(bounds.x,0);assert.ok(bounds.width<=440);
    assert.equal(await page.locator('#character-select').inputValue(),'companion');
    assert.equal(await page.locator('#character-advanced').evaluate(el=>el.open),false);
    assert.equal(await page.locator('[data-scene-choice]').count(),0);
    console.log('PASS default animated role, collapsed animation controls and left parameter drawer');
    assert.equal(await page.locator('#tts-voice').isDisabled(),true);
    assert.equal(await page.locator('#tts-voice-ref').inputValue(),reference.voice_ref);
    assert.equal(await page.locator('#tts-ref-text').inputValue(),'保存的原文');
    await page.locator('#tts-voice-ref').selectOption('');
    assert.equal(await page.locator('#tts-ref-text').inputValue(),'');
    await page.locator('#tts-voice-ref').selectOption(reference.voice_ref);
    assert.equal(await page.locator('#tts-ref-text').inputValue(),reference.text);
    assert.equal(await page.locator('#tts-reference-preview').getAttribute('src'),reference.url);
    await save();
    let payload = await send();
    assert.equal(payload.tts_voice_ref,reference.voice_ref);
    assert.equal(payload.tts_reference_text,reference.text);
    assert.equal(payload.tts_voice,'');
    console.log('PASS reference library selection, transcript, preview, legacy path migration and request');

    await open();
    await selectModel('preset');
    assert.equal(await page.locator('#tts-reference-fields').isHidden(),false);
    assert.equal(await page.locator('#tts-voice-ref').inputValue(),reference.voice_ref);
    assert.deepEqual(await page.locator('#tts-voice option').evaluateAll(items=>items.map(item=>item.value)),['','Aria','Jason']);
    await selectVoice('Jason');
    await save();
    payload = await send();
    assert.equal(payload.tts_options.voice_id,'Jason');
    assert.equal(payload.tts_voice,'');
    assert.equal(payload.tts_voice_ref,'');
    assert.equal(payload.tts_reference_text,'');
    console.log('PASS presets exclude incompatible references from requests while retaining the role reference');

    await open();
    await selectModel('cached');
    assert.equal(await page.locator('#tts-voice').inputValue(),'');
    await selectVoice('alba');
    await save();
    payload = await send();
    assert.equal(payload.tts_voice,'alba');
    assert.equal(payload.tts_options.voice_id,undefined);
    console.log('PASS switching models clears previous preset and preserves cached-voice request route');

    await open();
    await selectModel('clone');
    await page.locator('#tts-voice-ref').selectOption(reference.voice_ref);
    await save();
    await open();
    libraryFails = true;
    await page.locator('#tts-reference-refresh').click();
    await page.waitForFunction(()=>document.querySelector('#tts-reference-status').textContent.includes('失败'));
    assert.equal(await page.locator('#tts-voice-ref').inputValue(),reference.voice_ref);
    await page.locator('#tts-voice-ref').selectOption('');
    await page.locator('.modal-footer [value="close"]').click();
    libraryFails = false;
    await open();
    assert.equal(await page.locator('#tts-voice-ref').inputValue(),reference.voice_ref);
    assert.equal(await page.locator('#tts-ref-text').inputValue(),reference.text);
    await selectModel('preset');
    await page.locator('.modal-footer [value="close"]').click();
    await open();
    assert.equal(await page.locator('#tts-model').inputValue(),'clone');
    await page.locator('#tts-voice-ref').selectOption('');
    await save();
    payload = await send();
    assert.equal(payload.tts_voice_ref,'');
    assert.equal(payload.tts_reference_text,'');
    console.log('PASS refresh failure, cancel and explicit clear preserve correct state');

    await page.reload();
    await page.waitForFunction(() => document.querySelector('#tts-model').options.length === 3);
    await open();
    await page.locator('#character-name').fill('晚晴');
    await page.locator('#character-advanced summary').click();
    await page.locator('[data-animation="head"]').uncheck();
    await page.locator('[data-animation="delayMs"]').fill('120');
    await page.locator('#character-audio-upload').setInputFiles({name:'示例.wav',mimeType:'audio/wav',buffer:Buffer.from('fixture audio')});
    await page.waitForFunction(()=>document.querySelector('#tts-reference-status').textContent==='已加入音频库。');
    assert.equal(uploads.length,1);assert.equal(referenceSaves.length,2);
    assert.equal(referenceSaves[0].audio,'uploaded-audio');assert.equal(referenceSaves[0].overwrite,undefined);
    const uploaded = voices.at(-1);
    assert.equal(await page.locator('#tts-voice-ref').inputValue(),uploaded.voice_ref);
    await page.locator('#tts-ref-text').fill('上传音频的原文');
    await save();
    payload = await send();assert.equal(payload.tts_voice_ref,uploaded.voice_ref);assert.equal(payload.tts_reference_text,'上传音频的原文');assert.ok(payload.instructions.includes('晚晴'));
    const roles = await page.evaluate(()=>JSON.parse(localStorage.getItem('audiocpp.realtime.characters')));
    assert.equal(roles.roles.companion.name,'晚晴');assert.equal(roles.roles.companion.animation.head,false);assert.equal(roles.roles.companion.animation.delayMs,120);
    await page.reload();await page.waitForFunction(()=>document.querySelector('#tts-model').options.length===3);
    await open();assert.equal(await page.locator('#character-name').inputValue(),'晚晴');
    assert.equal(await page.locator('#character-advanced').evaluate(el=>el.open),false);
    await page.locator('#character-select').selectOption('system');
    assert.equal(await page.locator('#character-name').inputValue(),'系统');assert.equal(await page.locator('#tts-voice-ref').inputValue(),'');
    await save();assert.equal(await page.locator('#live-character-stage').isHidden(),true);
    payload = await send();assert.equal(payload.tts_voice_ref,'');assert.ok(payload.instructions.includes('系统'));
    console.log('PASS auto-upload library registration, duplicate-name protection, role persistence and blank system role');
    await page.locator('#call-more summary').click();
    await page.locator('#chat-btn').click();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#chat-panel')).opacity === '1');
    bounds = await page.locator('#chat-panel').boundingBox();
    assert(bounds.x < 100 && bounds.x + bounds.width < 720);
    assert.equal(await page.locator('#chat-panel').evaluate(el=>el.inert),false);
    const screenshots = process.env.AUDIOCPP_BROWSER_SCREENSHOTS;
    if (screenshots) {await fs.mkdir(screenshots,{recursive:true});await page.screenshot({path:path.join(screenshots,'system-history.png')});}
    await open();
    await page.locator('#character-select').selectOption('companion');
    assert.equal(await page.locator('#character-name').inputValue(),'晚晴');
    assert.equal(await page.locator('#tts-voice-ref').inputValue(),uploaded.voice_ref);
    await page.locator('#character-advanced summary').click();
    assert.equal(await page.locator('[data-animation="head"]').isChecked(),false);
    await page.locator('#character-animation-reset').click();
    assert.equal(await page.locator('[data-animation="head"]').isChecked(),true);
    assert.equal(await page.locator('[data-animation="delayMs"]').inputValue(),'90');
    await page.locator('.modal-footer [value="close"]').click();
    await page.waitForFunction(()=>document.body.dataset.character==='system');
    assert.equal(await page.locator('body').getAttribute('data-character'),'system');
    await open();await page.locator('#character-select').selectOption('companion');await save();
    assert.equal(await page.locator('#scene-location').textContent(),'晚晴');
    if (screenshots) await page.screenshot({path:path.join(screenshots,'companion-history.png')});
    await open();
    if (screenshots) await page.screenshot({path:path.join(screenshots,'character-settings.png')});
    await page.locator('.modal-footer [value="close"]').click();
    await page.setViewportSize({width:390,height:844});
    bounds = await page.locator('#chat-panel').boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= 390);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
    await open();bounds = await page.locator('#settings-modal').boundingBox();assert.equal(bounds.x,0);assert.equal(bounds.width,390);
    await page.locator('.modal-footer [value="close"]').click();
    await page.evaluate(()=>{localStorage.removeItem('audiocpp.realtime.characters');localStorage.removeItem('audiocpp.tts.voiceRef');localStorage.removeItem('audiocpp.tts.refText');});
    await page.reload();await page.waitForFunction(()=>document.querySelector('#tts-model').options.length===3);
    await open();assert.equal(await page.locator('#character-select').inputValue(),'companion');
    assert.equal(await page.locator('#character-name').inputValue(),'小暖');assert.equal(await page.locator('#tts-voice-ref').inputValue(),female.voice_ref);
    assert.equal(await page.locator('#tts-ref-text').inputValue(),female.text);
    await page.locator('#character-advanced summary').click();
    for(const key of ['mouth','blink','breath','listening','head','shoulders'])assert.equal(await page.locator(`[data-animation="${key}"]`).isChecked(),true);
    assert.ok(requests.every(request=>!request.includes('/scenes/')));
    console.log('PASS role cancel, animation reset/defaults, tested female voice and responsive left drawer');
    assert.deepEqual(errors,[]);
    assert.equal(await page.evaluate(()=>window.micRequests),0);
    console.log('Realtime settings browser: 7/7 passed');
  } catch(error) {
    console.error(JSON.stringify({consoleErrors,errors,ui:await page.evaluate(()=>({character:document.body.dataset.character,dialogOpen:document.getElementById('settings-modal').open,returnValue:document.getElementById('settings-modal').returnValue,saved:localStorage.getItem('audiocpp.realtime.characters')}))}));throw error;
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
