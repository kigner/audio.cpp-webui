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
  const baijieVoice = {name:'ref-w1.wav',label:'白洁参考音频',text:'白洁的原文',voice_ref:'D:/fixture/voice/ref-w1.wav',url:'/api/workbench/references/baijie/audio'};
  let voices = [reference,female,baijieVoice];
  const uploads = [], referenceSaves = [], requests = [];
  const models = [
    {id:'voxcpm1',family:'voxcpm1',label:'VoxCPM1',voices:[],accepts_voice_reference:true,requires_reference_text:true},
    {id:'supertonic',family:'supertonic',label:'Supertonic 3',voice_parameter:'voice',accepts_voice_reference:false,voices:[{label:'F1',value:'F1'},{label:'F2',value:'F2'}]},
    {id:'clone',family:'qwen3_tts',label:'Qwen Base',voices:[],accepts_voice_reference:true,requires_reference_text:true},
    {id:'preset',family:'magpie_tts',label:'Preset TTS',voice_parameter:'voice_id',accepts_voice_reference:false,
      voices:[{label:'Aria',value:'Aria'},{label:'Jason',value:'Jason'}]},
    {id:'cached',family:'pocket_tts',label:'Pocket',voices:[{label:'Alba',value:'alba'}],accepts_voice_reference:true}
  ];
  const config = {api_base:'/api/realtime',tts_model:'clone',tts_models:models,asr_models:[]};
  const sample = Buffer.alloc(44+4800);
  sample.write('RIFF');sample.writeUInt32LE(sample.length-8,4);sample.write('WAVEfmt ',8);
  sample.writeUInt32LE(16,16);sample.writeUInt16LE(1,20);sample.writeUInt16LE(1,22);
  sample.writeUInt32LE(24000,24);sample.writeUInt32LE(48000,28);sample.writeUInt16LE(2,32);sample.writeUInt16LE(16,34);
  sample.write('data',36);sample.writeUInt32LE(4800,40);
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
    if (url.pathname.startsWith('/api/workbench/references/')) return route.fulfill({body:sample,contentType:'audio/wav'});
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
  const selectCharacter = id => page.locator(`[data-character-id="${id}"]`).click();
  const selectReference = async value => {
    await page.locator('#tts-voice-ref').selectOption(value);
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
    await page.waitForFunction(() => document.querySelector('#tts-model').options.length === 5);
    await page.waitForSelector('#live-character-stage canvas');
    assert.equal(await page.locator('#scene-picker').count(),0,'character selection belongs in session settings');
    await page.locator('#call-more summary').click();
    await page.locator('#scene-fullscreen').click();
    await page.waitForFunction(()=>document.fullscreenElement);
    await page.evaluate(()=>document.exitFullscreen());
    await page.waitForFunction(()=>!document.fullscreenElement);
    const openLlm = async () => {await open();await page.locator('[data-settings-tab="llm"]').click();};
    const firstKey = 'fixture-key-not-a-real-credential';
    await openLlm();
    await page.locator('#llm-key').fill(firstKey);
    await save();
    await page.waitForFunction(key=>localStorage.getItem('audiocpp.llm.key')===key,firstKey);
    assert.equal(await page.evaluate(()=>localStorage.getItem('audiocpp.llm.key')),firstKey);
    assert.equal((await send()).llm_api_key,firstKey);
    await openLlm();
    assert.equal(await page.locator('#llm-key').inputValue(),firstKey,'saved key should remain in the masked password field');
    assert.equal(await page.locator('#llm-key').getAttribute('type'),'password');
    assert.match(await page.locator('#llm-key-status').textContent(),/已保存在此浏览器/);
    await page.locator('.modal-footer [value="close"]').click();
    await page.reload();await page.waitForFunction(()=>document.querySelector('#tts-model').options.length===5);
    await openLlm();
    assert.equal(await page.locator('#llm-key').inputValue(),firstKey);
    await page.locator('.modal-footer [value="close"]').click();
    assert.equal((await send()).llm_api_key,firstKey);
    console.log('PASS API key save, masked reopen, reload and outgoing request');

    await openLlm();
    await page.locator('#llm-key').fill('');
    await save();
    assert.equal((await send()).llm_api_key,firstKey);
    await openLlm();
    await page.locator('#llm-key').fill('fixture-cancelled-key');
    assert.match(await page.locator('#llm-key-status').textContent(),/尚未保存/);
    await page.locator('.modal-footer [value="close"]').click();
    assert.equal((await send()).llm_api_key,firstKey);
    console.log('PASS empty key preserves saved credential and cancel discards replacement');

    const secondKey = 'fixture-replacement-key';
    await openLlm();
    await page.locator('#llm-key').fill(`  ${secondKey}  `);
    await save();
    await page.waitForFunction(key=>localStorage.getItem('audiocpp.llm.key')===key,secondKey);
    assert.equal(await page.evaluate(()=>localStorage.getItem('audiocpp.llm.key')),secondKey);
    assert.equal((await send()).llm_api_key,secondKey);
    await openLlm();
    await page.locator('#llm-key').fill('   ');
    await save();
    assert.equal((await send()).llm_api_key,secondKey);
    console.log('PASS API key replacement trims surrounding whitespace and ignores blank edits');

    config.llm_api_key_set = true;
    await page.evaluate(()=>localStorage.removeItem('audiocpp.llm.key'));
    await page.reload();await page.waitForFunction(()=>document.querySelector('#tts-model').options.length===5);
    await openLlm();
    assert.equal(await page.locator('#llm-key').inputValue(),'');
    assert.match(await page.locator('#llm-key-status').textContent(),/使用启动配置中的密钥/);
    await save();
    assert.equal((await send()).llm_api_key,undefined);
    config.llm_api_key_set = false;
    console.log('PASS server-only key shows its source without sending a fake masked credential');

    await open();
    let bounds = await page.locator('#settings-modal').boundingBox();assert.equal(bounds.x,0);assert.equal(bounds.width,560);
    assert.equal(await page.locator('.character-card[aria-pressed="true"]').getAttribute('data-character-id'),'companion');
    assert.equal(await page.locator('#character-advanced').evaluate(el=>el.open),false);
    assert.equal(await page.locator('[data-scene-choice]').count(),0);
    console.log('PASS default animated role, collapsed animation controls and left parameter drawer');
    assert.equal(await page.locator('#tts-voice').isDisabled(),true);
    assert.equal(await page.locator('#tts-voice-ref').inputValue(),reference.voice_ref);
    assert.equal(await page.locator('#tts-ref-text').inputValue(),'保存的原文');
    assert.equal(await page.locator('#tts-voice-ref').isVisible(),true,'library selection is directly available');
    assert.equal(await page.locator('.character-upload').isVisible(),true,'upload remains alongside library selection');
    assert.equal(await page.locator('#tts-ref-text').isVisible(),true,'library transcripts remain editable');
    assert.equal(await page.locator('#character-reference-replace').count(),0);
    await selectReference('');
    assert.equal(await page.locator('#tts-ref-text').inputValue(),'');
    await selectReference(reference.voice_ref);
    assert.equal(await page.locator('#tts-ref-text').inputValue(),reference.text);
    assert.equal(await page.locator('#tts-reference-preview').getAttribute('src'),reference.url);
    const editedReferenceText = `${reference.text}（已校正）`;
    await page.locator('#tts-ref-text').fill(editedReferenceText);
    await page.locator('#tts-reference-refresh').click();
    assert.equal(await page.locator('#tts-ref-text').inputValue(),editedReferenceText);
    await save();
    let payload = await send();
    assert.equal(payload.tts_voice_ref,reference.voice_ref);
    assert.equal(payload.tts_reference_text,editedReferenceText);
    assert.equal(payload.tts_voice,'');
    console.log('PASS reference library selection, transcript, preview, legacy path migration and request');

    await open();
    await selectModel('preset');
    assert.equal(await page.locator('#tts-reference-fields').isHidden(),true);
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
    await selectReference(reference.voice_ref);
    await save();
    await open();
    libraryFails = true;
    await page.locator('#tts-reference-refresh').click();
    await page.waitForFunction(()=>document.querySelector('#tts-reference-status').textContent.includes('失败'));
    assert.equal(await page.locator('#tts-voice-ref').inputValue(),reference.voice_ref);
    await selectReference('');
    await page.locator('.modal-footer [value="close"]').click();
    libraryFails = false;
    await open();
    assert.equal(await page.locator('#tts-voice-ref').inputValue(),reference.voice_ref);
    assert.equal(await page.locator('#tts-ref-text').inputValue(),reference.text);
    await selectModel('preset');
    await page.locator('.modal-footer [value="close"]').click();
    await open();
    assert.equal(await page.locator('#tts-model').inputValue(),'clone');
    await selectReference('');
    await save();
    payload = await send();
    assert.equal(payload.tts_voice_ref,'');
    assert.equal(payload.tts_reference_text,'');
    console.log('PASS refresh failure, cancel and explicit clear preserve correct state');

    await page.reload();
    await page.waitForFunction(() => document.querySelector('#tts-model').options.length === 5);
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
    await page.reload();await page.waitForFunction(()=>document.querySelector('#tts-model').options.length===5);
    await open();assert.equal(await page.locator('#character-name').inputValue(),'晚晴');
    assert.equal(await page.locator('#character-advanced').evaluate(el=>el.open),false);
    await selectCharacter('system');
    assert.equal(await page.locator('#character-name').inputValue(),'纯净');assert.equal(await page.locator('#tts-voice-ref').inputValue(),'');
    await save();assert.equal(await page.locator('#live-character-stage').isHidden(),true);
    assert.equal(await page.locator('.scene-background').evaluate(el=>el.style.backgroundImage),'');
    payload = await send();assert.equal(payload.tts_voice_ref,'');assert.ok(payload.instructions.includes('纯净'));
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
    await selectCharacter('companion');
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
    await open();await selectCharacter('companion');await save();
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('audiocpp.realtime.characters')).roles[document.body.dataset.character].name),'晚晴');
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
    await page.reload();await page.waitForFunction(()=>document.querySelector('#tts-model').options.length===5);
    await open();assert.equal(await page.locator('.character-card[aria-pressed="true"]').getAttribute('data-character-id'),'companion');
    assert.equal(await page.locator('#character-name').inputValue(),'小暖');assert.equal(await page.locator('#tts-voice-ref').inputValue(),female.voice_ref);
    assert.equal(await page.locator('#tts-ref-text').inputValue(),female.text);
    await page.locator('#character-advanced summary').click();
    for(const key of ['mouth','blink','breath','listening','head','shoulders'])assert.equal(await page.locator(`[data-animation="${key}"]`).isChecked(),true);
    assert.ok(requests.every(request=>!request.includes('/scenes/')));
    console.log('PASS role cancel, animation reset/defaults, tested female voice and responsive left drawer');
    await selectCharacter('baijie');
    assert.equal(await page.locator('#character-name').inputValue(),'白洁');
    assert.equal(await page.locator('.character-card[aria-pressed="true"]').getAttribute('data-character-id'),'baijie');
    await page.locator('#character-name').fill('');await save();
    await page.waitForFunction(async()=>{
      const module=await import([...document.scripts].find(s=>s.src.includes('/main.js')).src);
      return (await module.liveCharacterStats())?.characterId==='baijie'&&document.querySelector('.scene-background').style.backgroundSize;
    });
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('audiocpp.realtime.characters')).roles[document.body.dataset.character].name),'白洁','blank names retain the selected role default');
    await page.setViewportSize({width:1920,height:1080});await page.waitForTimeout(250);
    if(screenshots)await page.screenshot({path:path.join(screenshots,'baijie-live.png')});
    const sceneSize=await page.locator('.scene-background').evaluate(el=>el.style.backgroundSize);
    await open();await selectCharacter('system');await save();
    await open();await selectCharacter('baijie');await save();
    await page.waitForFunction(()=>document.querySelector('.scene-background').style.backgroundSize);
    assert.equal(await page.locator('.scene-background').evaluate(el=>el.style.backgroundSize),sceneSize);
    await page.reload();await page.waitForSelector('#live-character-stage canvas');
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('audiocpp.realtime.characters')).roles[document.body.dataset.character].name),'白洁');
    await open();await selectCharacter('companion');await save();
    await page.waitForFunction(()=>document.body.dataset.character==='companion');
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('audiocpp.realtime.characters')).roles[document.body.dataset.character].name),'小暖');
    await page.waitForFunction(()=>document.querySelector('.scene-background').style.backgroundSize==='');
    console.log('PASS Baijie selection, thumbnail, persistence and scene layout across role switches');
    await open();await selectCharacter('lily');
    assert.equal(await page.locator('#character-name').inputValue(),'Lily');
    assert.equal(await page.locator('.character-card[aria-pressed="true"]').getAttribute('data-character-id'),'lily');
    await page.locator('#character-name').fill('');await save();
    await page.waitForFunction(()=>document.querySelector('#live-character-stage canvas')?.getAttribute('aria-label')==='Lily 透明人物'&&document.querySelector('.scene-background').style.backgroundSize);
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('audiocpp.realtime.characters')).roles[document.body.dataset.character].name),'Lily');
    assert.match(await page.locator('.scene-background').evaluate(el=>el.style.backgroundImage),/lily-living-room\.png/);
    await page.waitForTimeout(150);
    if(screenshots)await page.screenshot({path:path.join(screenshots,'lily-live.png')});
    for(const id of ['baijie','system','lily']){
      await open();await selectCharacter(id);await save();
      await page.waitForFunction(id=>document.body.dataset.character===id,id);
    }
    await page.waitForFunction(()=>document.querySelector('#live-character-stage canvas')?.getAttribute('aria-label')==='Lily 透明人物'&&document.querySelector('.scene-background').style.backgroundSize);
    await page.reload();await page.waitForSelector('#live-character-stage canvas');
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('audiocpp.realtime.characters')).roles[document.body.dataset.character].name),'Lily');
    await open();assert.equal(await page.locator('.character-card[aria-pressed="true"]').getAttribute('data-character-id'),'lily');
    assert.equal(await page.locator('#tts-voice-ref').inputValue(),'');
    assert.equal(await page.locator('#tts-model').inputValue(),'supertonic');
    assert.equal(await page.locator('#tts-voice').inputValue(),'F1');
    await page.locator('.modal-footer [value="close"]').click();
    console.log('PASS Lily selection, preview, default name/voice and persistence across role switches');

    assert.equal(await page.locator('#scene-location').count(),0,'no role name in the scene header');
    await open();
    assert.equal(await page.locator('.character-card').count(),6);
    const cards=await page.locator('.character-card').evaluateAll(items=>items.map(item=>({id:item.dataset.characterId,x:item.getBoundingClientRect().x,y:item.getBoundingClientRect().y})));
    assert.equal(cards[0].y,cards[2].y);assert.equal(cards[3].y,cards[5].y);assert(cards[3].y>cards[0].y);
    assert.equal(await page.locator('#scene-captions').evaluate(el=>el.closest('details').id),'character-advanced');
    assert.equal(await page.locator('#character-builtin-preview').isHidden(),true,'F1 has no playable sample');
    assert.equal(await page.locator('#character-builtin-voice').inputValue(),'F1');
    assert.equal(await page.locator('#tts-reference-fields').isHidden(),true);
    await page.locator('#character-builtin-voice').selectOption('F2');
    assert.equal(await page.locator('#tts-voice').inputValue(),'F2');
    await page.locator('#character-builtin-voice').selectOption('F1');
    assert.equal(await page.locator('#tts-voice-ref').isHidden(),true);
    await selectCharacter('baijie');
    assert.equal(await page.locator('#tts-model').inputValue(),'voxcpm1');
    assert.equal(await page.locator('#tts-voice-ref').isVisible(),true);
    assert.equal(await page.locator('#tts-reference-fields').isVisible(),true);
    assert.equal(await page.locator('#tts-voice-ref').inputValue(),baijieVoice.voice_ref);
    assert.equal(await page.locator('#tts-reference-preview').getAttribute('src'),baijieVoice.url);
    assert.equal(await page.locator('#tts-ref-text').isVisible(),true);
    await save();payload=await send();
    assert.equal(payload.tts_model,'voxcpm1');assert.equal(payload.tts_reference_text,baijieVoice.text);
    await open();await selectCharacter('lily');await save();payload=await send();
    assert.equal(payload.tts_model,'supertonic');assert.equal(payload.tts_options.voice,'F1');assert.equal(payload.tts_voice_ref,'');
    models.find(model=>model.id==='supertonic').voices[0].url=female.url;
    await open();
    await page.waitForFunction(url=>document.querySelector('#character-builtin-preview').getAttribute('src')===url&&document.querySelector('#character-builtin-preview').readyState>=1,female.url);
    assert.equal(await page.locator('#character-builtin-preview').isVisible(),true,'a playable preset sample gets a player');
    assert.equal(await page.locator('#tts-voice-ref').isHidden(),true);
    if(screenshots)await page.screenshot({path:path.join(screenshots,'preset-sample-fixture.png')});
    await page.locator('.modal-footer [value="close"]').click();
    delete models.find(model=>model.id==='supertonic').voices[0].url;
    await open();
    await page.waitForFunction(()=>document.querySelector('#tts-reference-preview').hidden);
    assert.equal(await page.locator('.modal-header h2').textContent(),'聊天设置');
    assert.equal(await page.locator('#settings-btn').getAttribute('aria-label'),'聊天设置');
    for(const viewport of [{width:1440,height:900},{width:1000,height:740},{width:390,height:844}]){
      await page.setViewportSize(viewport);
      const layout=await page.evaluate(()=>{
        const header=document.querySelector('#settings-modal .modal-header').getBoundingClientRect();
        const tabs=document.querySelector('.scene-settings-tabs').getBoundingClientRect();
        const panels=document.querySelector('#settings-modal .tab-panels');
        return {headerHeight:header.height,topHeight:tabs.bottom,scrollHeight:panels.scrollHeight,clientHeight:panels.clientHeight};
      });
      assert(layout.headerHeight<=52&&layout.topHeight<=108,'settings heading and tabs stay compact');
      assert(layout.scrollHeight<=layout.clientHeight+1,'default preset settings fit without scrolling');
    }
    await page.setViewportSize({width:1440,height:900});
    if(screenshots)await page.screenshot({path:path.join(screenshots,'lily-builtin-settings.png')});
    await page.locator('.modal-footer [value="close"]').click();
    console.log('PASS six thumbnails in two rows and role-specific model/reference request contracts');

    await open();await selectCharacter('office');
    assert.equal(await page.locator('#character-animation-controls').isHidden(),true);
    assert.equal(await page.locator('#character-advanced').isHidden(),false);
    await page.locator('#character-name').fill('晴岚');await page.locator('#character-name-save').click();
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('audiocpp.realtime.characters')).roles.office.name),'晴岚');
    await save();
    assert.equal(await page.locator('#live-character-stage canvas').count(),0,'static scenes release the animated renderer');
    assert.match(await page.locator('.scene-background').evaluate(el=>el.style.backgroundImage),/office-day/);
    if(screenshots)await page.screenshot({path:path.join(screenshots,'office-live.png')});
    payload=await send();assert.equal(payload.tts_model,'voxcpm1');assert(payload.instructions.includes('晴岚'));
    await open();await page.locator('#character-name').fill('办公室');await page.locator('#character-name-save').click();
    await page.locator('.modal-footer [value="close"]').click();
    await open();await selectCharacter('living');await save();
    assert.equal(await page.locator('#live-character-stage canvas').count(),0);
    assert.match(await page.locator('.scene-background').evaluate(el=>el.style.backgroundImage),/living-day/);
    payload=await send();assert.equal(payload.tts_model,'voxcpm1');assert.equal(payload.tts_voice_ref,female.voice_ref);
    if(screenshots)await page.screenshot({path:path.join(screenshots,'living-live.png')});
    await open();
    if(screenshots)await page.screenshot({path:path.join(screenshots,'six-role-settings.png')});
    await page.locator('.modal-footer [value="close"]').click();
    console.log('PASS name save and both static scenes retain chat without a WebGL renderer');

    for(const viewport of [{width:1440,height:900},{width:1920,height:1080},{width:1000,height:740}]){
      await page.setViewportSize(viewport);
      const dock=await page.locator('.call-controls').boundingBox();
      assert(Math.abs(dock.x+dock.width-viewport.width/2)<1,'dock ends at the screen midpoint');
      assert(dock.x>=0);
    }
    await open();await selectCharacter('lily');await save();
    await page.waitForFunction(async()=>{
      const module=await import([...document.scripts].find(s=>s.src.includes('/main.js')).src);
      return (await module.liveCharacterStats())?.characterId==='lily'&&document.querySelector('#live-character-stage canvas');
    });
    for(const viewport of [{width:1440,height:900},{width:1920,height:1080},{width:1000,height:740}]){
      await page.setViewportSize(viewport);await page.waitForTimeout(150);
      const state=await page.evaluate(async()=>{
        const module=await import([...document.scripts].find(s=>s.src.includes('/main.js')).src);
        return module.liveCharacterStats();
      });
      const left=state.bounds.x+589/1672*state.bounds.width,right=state.bounds.x+1658/1672*state.bounds.width;
      assert(left>=viewport.width/2-.1);assert(right<=viewport.width);assert(right-left<=viewport.width/2);
    }
    console.log('PASS toolbar midpoint and complete Lily silhouette in the right half at three desktop sizes');

    // Use the public chat event API on the real DOM, independent of cloud/model availability.
    await page.setViewportSize({width:1440,height:900});
    await page.reload();await page.waitForSelector('#live-character-stage canvas');
    await page.clock.install();
    await page.evaluate(async()=>{
      const {ChatView}=await import('/realtime/ui/chat.js?v=chat-fade-1');window.speechTest=new ChatView();speechTest.setAssistantName('Lily');
      speechTest.onTranscript({role:'user',text:'你好',partial:false,itemId:'user-1'});
      speechTest.onTranscript({role:'user',text:'输入框发来的文字',partial:false,itemId:'typed-1'});
    });
    await page.clock.fastForward(7000);
    assert.equal(await page.locator('.bubble.user:not(.out)').count(),2,'microphone and typed text wait for a reply');
    await page.evaluate(()=>speechTest.onTranscript({role:'assistant',text:'',partial:true,responseId:'spoken-1'}));
    assert.equal(await page.locator('.bubble.user:not(.out)').count(),2,'empty reply does not hide user text');
    await page.evaluate(()=>{
      speechTest.onTranscript({role:'assistant',text:'你好，今天有什么想和我分享的吗？我会在这里听你慢慢说。不论是今天遇到的小事，还是最近一直放在心里的想法，你都可以从最想说的地方开始。',partial:false,responseId:'spoken-1'});
    });
    assert.equal(await page.locator('.bubble.user:not(.out)').count(),0,'first reply fades all pending user text');
    assert.equal(await page.locator('.bubble-role, .hist-msg.user .hist-role, .hist-msg.assistant .hist-role').count(),0,'messages have no visible speaker names');
    await page.clock.runFor(1000);
    assert.equal(await page.locator('#bubble-stack').evaluate(el=>el.parentElement===document.body),true);
    const bubbles=await page.locator('#bubble-stack').boundingBox();
    const chatDock=await page.locator('.call-controls').boundingBox();
    assert(bubbles.x<100&&bubbles.width===560,'chat text uses the original left-side layout');
    assert(Math.abs(bubbles.y+bubbles.height-(chatDock.y-22))<1,'chat text remains above the bottom controls');
    assert.equal(await page.locator('.bubble.assistant:not(.out)').count(),1);
    const surfaces=await page.evaluate(()=>['.bubble.assistant','.call-controls','.chat-panel-inner'].map(selector=>getComputedStyle(document.querySelector(selector)).backgroundColor));
    assert(surfaces.every(color=>color.startsWith('rgba(')&&Number(color.split(',').at(-1).replace(')',''))<.7),'chat surfaces are translucent');
    if(screenshots){
      await page.waitForFunction(()=>[...document.querySelectorAll('.bubble.in')].every(el=>Number(getComputedStyle(el).opacity)===1));
      await page.screenshot({path:path.join(screenshots,'restored-chat-text.png')});
    }
    await page.clock.fastForward(6500);
    assert.equal(await page.locator('.bubble.assistant:not(.out)').count(),1,'reply waits for its audio first chunk');
    await page.evaluate(()=>{
      speechTest.onAudioChunk({responseId:'spoken-1'});
      speechTest.onResponseFinished({responseId:'spoken-1',status:'completed'});
    });
    await page.clock.fastForward(6500);
    assert.equal(await page.locator('.bubble.assistant:not(.out)').count(),1,'long replies get more reading time');
    await page.clock.fastForward(14000);
    assert.equal(await page.locator('.bubble.assistant:not(.out)').count(),0);
    assert.equal(await page.locator('.hist-msg.assistant').count(),1,'conversation history keeps the reply');
    await page.evaluate(()=>{
      speechTest.onTranscript({role:'assistant',text:'在的',partial:false,responseId:'short'});
      speechTest.onAudioChunk({responseId:'short'});
    });
    await page.clock.fastForward(1000);
    assert.equal(await page.locator('.bubble.assistant:not(.out)').count(),1);
    await page.evaluate(()=>{
      speechTest.onAudioChunk({responseId:'short'});
      speechTest.onResponseFinished({responseId:'short',status:'completed'});
    });
    await page.clock.fastForward(500);
    assert.equal(await page.locator('.bubble.assistant:not(.out)').count(),0,'short acknowledgements fade in 1-2 seconds, without later chunks extending the timer');
    await page.evaluate(()=>{
      speechTest.onAudioChunk({responseId:'early-audio'});
      speechTest.onTranscript({role:'assistant',text:'好的',partial:false,responseId:'early-audio'});
    });
    await page.clock.fastForward(1500);
    assert.equal(await page.locator('.bubble.assistant:not(.out)').count(),0,'audio arriving before transcript still arms the reading timer');
    await page.evaluate(()=>{
      speechTest.onTranscript({role:'assistant',text:'在的',partial:true,responseId:'growing'});
      speechTest.onAudioChunk({responseId:'growing'});
    });
    await page.clock.fastForward(1000);
    await page.evaluate(()=>speechTest.onTranscript({role:'assistant',text:'在的，你可以慢慢说，我会认真听你分享今天发生的事情。',partial:false,responseId:'growing'}));
    await page.clock.fastForward(1000);
    assert.equal(await page.locator('.bubble.assistant:not(.out)').count(),1,'new streamed text gets additional reading time');
    await page.clock.fastForward(20000);
    await page.evaluate(()=>speechTest.onTranscript({role:'assistant',text:'没有收到音频的回复',partial:false,responseId:'silent'}));
    await page.clock.fastForward(31000);
    assert.equal(await page.locator('.bubble.assistant:not(.out)').count(),0,'stalled synthesis has a bounded fallback');
    await page.evaluate(()=>{
      speechTest.onTranscript({role:'assistant',text:'即将被打断的内容',partial:true,responseId:'cancelled'});
      speechTest.reset({dismiss:true});
    });
    assert.equal(await page.locator('.bubble.assistant:not(.out)').count(),0);
    console.log('PASS chat placement, transparency, hidden names, reply-triggered user fade and adaptive audio-triggered reply fade');
    assert.deepEqual(errors,[]);
    assert.equal(await page.evaluate(()=>window.micRequests),0);
    console.log('Realtime settings browser: all checks passed');
  } catch(error) {
    console.error(JSON.stringify({consoleErrors,errors,ui:await page.evaluate(()=>({character:document.body.dataset.character,dialogOpen:document.getElementById('settings-modal').open,returnValue:document.getElementById('settings-modal').returnValue,saved:localStorage.getItem('audiocpp.realtime.characters')}))}));throw error;
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
