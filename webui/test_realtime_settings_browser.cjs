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
  const options = {headless:true};
  if (process.env.AUDIOCPP_BROWSER_EXECUTABLE) options.executablePath = process.env.AUDIOCPP_BROWSER_EXECUTABLE;
  const browser = await chromium.launch(options);
  const page = await browser.newPage({viewport:{width:1440,height:900}});
  const errors = [], activations = [];
  page.on('pageerror', error => errors.push(error.message));
  let libraryFails = false;
  const reference = {name:'示例.wav',label:'示例女声',text:'你好，今天过得怎么样？',
    voice_ref:'D:/fixture/voice/示例.wav',url:'/api/workbench/references/example/audio'};
  const models = [
    {id:'clone',family:'qwen3_tts',label:'Qwen Base',voices:[],accepts_voice_reference:true,requires_reference_text:true},
    {id:'preset',family:'magpie_tts',label:'Preset TTS',voice_parameter:'voice_id',accepts_voice_reference:false,
      voices:[{label:'Aria',value:'Aria'},{label:'Jason',value:'Jason'}]},
    {id:'cached',family:'pocket_tts',label:'Pocket',voices:[{label:'Alba',value:'alba'}],accepts_voice_reference:true}
  ];
  const config = {api_base:'/api/realtime',tts_model:'clone',tts_models:models,asr_models:[]};
  await page.addInitScript(() => {
    localStorage.setItem('audiocpp.tts.model','clone');
    localStorage.setItem('audiocpp.tts.voiceRef','voice/示例.wav');
    localStorage.setItem('audiocpp.tts.refText','保存的原文');
    window.micRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => {window.micRequests++;throw new Error('Unexpected microphone request');};
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/realtime/config') return route.fulfill({json:config});
    if (url.pathname === '/api/workbench/voices') return route.fulfill(libraryFails ? {status:503,body:'unavailable'} : {json:{voices:[reference]}});
    if (url.pathname === '/api/realtime/activate') {
      activations.push(route.request().postDataJSON());
      return route.fulfill({status:503,json:{detail:'Fixture: activation intentionally stopped'}});
    }
    if (url.pathname.startsWith('/api/workbench/references/')) return route.fulfill({status:204});
    const relative = decodeURIComponent(url.pathname).replace(/^\//,'');
    const filename = relative.startsWith('realtime/') ? path.join(__dirname,'realtime_static',relative.slice(9)||'index.html') :
      relative.startsWith('workbench/') ? path.join(__dirname,'workbench_static',relative.slice(10)) : '';
    if (filename) {
      const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png'};
      try {return route.fulfill({body:await fs.readFile(filename),contentType:types[path.extname(filename)]||'application/octet-stream'});} catch {}
    }
    return route.fulfill({status:404,body:'Fixture route missing'});
  });
  const open = async () => {
    await page.locator('#call-more summary').click();
    await page.locator('#settings-btn').click();
    await page.locator('[data-settings-tab="tts"]').click();
    await page.waitForFunction(() => document.querySelector('#tts-voice-ref').options.length > 1);
  };
  const save = () => page.locator('#settings-save').click();
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
    await open();
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
    await page.locator('#tts-model').selectOption('preset');
    assert.equal(await page.locator('#tts-reference-fields').isHidden(),true);
    assert.deepEqual(await page.locator('#tts-voice option').evaluateAll(items=>items.map(item=>item.value)),['','Aria','Jason']);
    await page.locator('#tts-voice').selectOption('Jason');
    await save();
    payload = await send();
    assert.equal(payload.tts_options.voice_id,'Jason');
    assert.equal(payload.tts_voice,'');
    assert.equal(payload.tts_voice_ref,'');
    assert.equal(payload.tts_reference_text,'');
    console.log('PASS model presets use the correct request parameter and clear incompatible reference');

    await open();
    await page.locator('#tts-model').selectOption('cached');
    assert.equal(await page.locator('#tts-voice').inputValue(),'');
    await page.locator('#tts-voice').selectOption('alba');
    await save();
    payload = await send();
    assert.equal(payload.tts_voice,'alba');
    assert.equal(payload.tts_options.voice_id,undefined);
    console.log('PASS switching models clears previous preset and preserves cached-voice request route');

    await open();
    await page.locator('#tts-model').selectOption('clone');
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
    await page.locator('#tts-model').selectOption('preset');
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
    await page.locator('#call-more summary').click();
    await page.locator('#scene-picker').click();
    await page.locator('[data-scene-choice="bedroom"]').click();
    await save();
    assert.equal(await page.locator('body').getAttribute('data-scene'),'bedroom');
    await page.locator('#call-more summary').click();
    await page.locator('#chat-btn').click();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#chat-panel')).opacity === '1');
    let bounds = await page.locator('#chat-panel').boundingBox();
    assert(bounds.x < 100 && bounds.x + bounds.width < 720);
    assert.equal(await page.locator('#chat-panel').evaluate(el=>el.inert),false);
    const screenshots = process.env.AUDIOCPP_BROWSER_SCREENSHOTS;
    if (screenshots) {await fs.mkdir(screenshots,{recursive:true});await page.screenshot({path:path.join(screenshots,'bedroom-history.png')});}
    await page.locator('#call-more summary').click();
    await page.locator('#scene-picker').click();
    await page.locator('[data-scene-choice="living-room"]').click();
    await save();
    assert.equal(await page.locator('#scene-location').textContent(),'客厅 · 午后');
    if (screenshots) await page.screenshot({path:path.join(screenshots,'living-room-history.png')});
    await open();
    await page.locator('#tts-voice-ref').selectOption(reference.voice_ref);
    if (screenshots) await page.screenshot({path:path.join(screenshots,'reference-library.png')});
    await page.locator('.modal-footer [value="close"]').click();
    await page.setViewportSize({width:390,height:844});
    bounds = await page.locator('#chat-panel').boundingBox();
    assert(bounds.x >= 0 && bounds.x + bounds.width <= 390);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
    console.log('PASS both scenes, left history panel and narrow-screen layout');
    assert.deepEqual(errors,[]);
    assert.equal(await page.evaluate(()=>window.micRequests),0);
    console.log('Realtime settings browser: 5/5 passed');
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
