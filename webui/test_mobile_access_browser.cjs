/* Real HTTPS and AudioWorklets, synthetic microphone/model, isolated browser.
 * Desktop UI uses an existing source workbench and intercepts mobile mutations.
 * Never writes the user's voice configuration or enables their LAN listener.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const readline = require('node:readline');
const {chromium} = require(process.env.AUDIOCPP_PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const host = spawn(process.env.AUDIOCPP_PYTHON || path.join(__dirname,'..','venv','Scripts','python.exe'),
    [path.join(__dirname,'test_mobile_access_host.py')], {stdio:['pipe','pipe','inherit'], windowsHide:true});
  const lines = readline.createInterface({input:host.stdout});
  let browser;
  try {
    const [line] = await Promise.race([once(lines,'line'), once(host,'exit').then(() => {throw new Error('TLS fixture failed');})]);
    const fixture = JSON.parse(line);
    const args = ['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'];
    browser = await chromium.launch({headless:true, args,
      ...(process.env.AUDIOCPP_BROWSER_EXECUTABLE ? {executablePath:process.env.AUDIOCPP_BROWSER_EXECUTABLE} : {})});
    const context = await browser.newContext({ignoreHTTPSErrors:true, viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const phone = await context.newPage();
    const errors = [];
    const failedAssets = [];
    phone.on('response', response => {if (response.url().includes('/assets/') && response.status() >= 400) failedAssets.push(response.url());});
    phone.on('pageerror', error => errors.push(error.message));
    let audioFrames = 0, returnedAudio = 0;
    phone.on('websocket', ws => {
      ws.on('framesent', frame => {if (String(frame.payload).includes('input_audio_buffer.append')) audioFrames++;});
      ws.on('framereceived', frame => {if (String(frame.payload).includes('response.output_audio.delta')) returnedAudio++;});
    });
    await phone.addInitScript(() => {
      window.micTracks = [];
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        if (window.denyMic) throw new DOMException('Denied', 'NotAllowedError');
        if (window.delayMic) await new Promise(resolve => {window.resolveMic = resolve;});
        const stream = await original(constraints);
        window.micTracks.push(...stream.getTracks());
        return stream;
      };
      window.playbackSamples = 0;
      const Worklet = window.AudioWorkletNode;
      window.AudioWorkletNode = new Proxy(Worklet, {construct(Target,args,newTarget) {
        const node = Reflect.construct(Target,args,newTarget);
        if (args[1] === 'audio-playback') {
          const post = node.port.postMessage.bind(node.port);
          node.port.postMessage = (message,...rest) => {
            if (message.kind === 'audio') window.playbackSamples += message.samples.length;
            return post(message,...rest);
          };
        }
        return node;
      }});
    });
    await phone.goto(fixture.status.urls[0]);
    await phone.waitForFunction(() => !document.getElementById('start').disabled);
    await phone.evaluate(async () => {window.characterStats = (await import('/assets/call.js')).mobileCharacterStats;});
    await phone.waitForFunction(() => window.characterStats()?.animated);
    assert.equal(await phone.evaluate(() => window.characterStats().characterId),'companion');
    await phone.waitForFunction(() => window.characterStats().blinks > 0);
    assert(await phone.evaluate(() => window.characterStats().headMovement > 0));
    assert.equal(new URL(phone.url()).search,'');
    assert.equal(await phone.locator('input,select,textarea').count(),0);
    assert.equal(await phone.evaluate(() => isSecureContext),true);
    const output = path.join(__dirname,'..','build','mobile-access-review');
    await fs.mkdir(output,{recursive:true});
    for (const size of [{width:390,height:844},{width:320,height:568},{width:844,height:390}]) {
      await phone.setViewportSize(size);
      assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
      assert.equal(await phone.locator('#start').isVisible(),true);
      await phone.waitForTimeout(150);
      const layout = await phone.evaluate(() => {
        const rect = id => {
          const {x,y,width,height,right,bottom} = document.getElementById(id).getBoundingClientRect();
          return {x,y,width,height,right,bottom};
        };
        const help = rect('help'), fullscreen = rect('fullscreen'), name = rect('character');
        const hits = ['help','fullscreen'].every(id => {
          const box = rect(id);
          return [[box.width/2,4],[4,box.height/2],[box.width-4,box.height/2],[box.width/2,box.height-4],[box.width/2,box.height/2]].every(([x,y]) =>
            document.elementFromPoint(box.x+x,box.y+y)?.closest('button')?.id === id);
        });
        return {help,fullscreen,name,hits};
      });
      assert(layout.help.right < size.width / 2 && layout.fullscreen.x > size.width / 2,'Help and fullscreen must occupy opposite top corners');
      assert(layout.help.width >= 44 && layout.fullscreen.width >= 44 && layout.hits,`Both touch targets must be large enough and unobstructed: ${JSON.stringify(layout)}`);
      assert(layout.name.x > size.width / 2 && layout.name.y > size.height / 2,'Character name must be in the bottom right');
      await phone.locator('#help').tap();
      assert.equal(await phone.locator('#help-dialog').isVisible(),true);
      await phone.locator('#close-help').tap();
      await phone.locator('#fullscreen').tap();
      await phone.waitForFunction(() => !!document.fullscreenElement);
      assert.equal(await phone.locator('#help-dialog').isVisible(),false,'Fullscreen must not trigger the help button');
      await phone.locator('#fullscreen').tap();
      await phone.waitForFunction(() => !document.fullscreenElement);
      await phone.screenshot({path:path.join(output,`phone-${size.width}.png`),fullPage:true});
    }
    await phone.setViewportSize({width:390,height:844});
    await phone.locator('#fullscreen').click();
    await phone.waitForFunction(() => !!document.fullscreenElement);
    await phone.locator('#fullscreen').click();
    await phone.waitForFunction(() => !document.fullscreenElement);
    await phone.locator('#start').click();
    await phone.locator('#mute').waitFor({state:'visible'});
    await phone.waitForFunction(() => window.playbackSamples > 0);
    assert(audioFrames > 0 && returnedAudio > 0, 'Both microphone and returned PCM must travel over WSS');
    try {
      await phone.waitForFunction(() => window.characterStats().mouthMax > .2, {}, {polling:'raf', timeout:12000});
    } catch (error) {
      console.error({character:await phone.evaluate(() => window.characterStats()),notice:await phone.locator('#error').textContent(),failedAssets});
      throw error;
    }
    await phone.screenshot({path:path.join(output,'phone-speaking.png')});
    await phone.waitForFunction(() => document.body.classList.contains('ui-hidden'));
    await phone.waitForFunction(() => document.getElementById('status').dataset.faded === 'true');
    await phone.locator('#mute').waitFor({state:'hidden'});
    await phone.screenshot({path:path.join(output,'phone-clean.png')});
    assert.equal(await phone.locator('#mute').isVisible(),false);
    await phone.locator('#reveal').click({position:{x:12,y:200}});
    await phone.locator('#mute').waitFor({state:'visible'});
    assert.equal(await phone.locator('#mute').isVisible(),true);
    await phone.locator('#mute').click();
    const before = audioFrames;
    await phone.waitForTimeout(250);
    const stable = audioFrames;
    await phone.waitForTimeout(250);
    assert.equal(audioFrames,stable,'Muted capture must stop sending');
    assert(stable >= before);
    await phone.locator('#mute').click();
    await phone.waitForTimeout(250);
    assert(audioFrames > stable,'Unmute must resume sending');
    await phone.locator('#end').click();
    await phone.waitForFunction(() => window.micTracks.every(track => track.readyState === 'ended'));
    await phone.evaluate(() => {window.denyMic = true;});
    await phone.locator('#start').click();
    await phone.waitForFunction(() => document.getElementById('error').textContent.includes('麦克风未获允许'));
    await phone.locator('#dismiss-notice').click();
    assert.equal(await phone.locator('#notice').isVisible(),false);
    await phone.evaluate(() => {window.denyMic = false; window.delayMic = true;});
    await phone.locator('#start').click();
    await phone.waitForFunction(() => !!window.resolveMic);
    await phone.locator('#end').click();
    await phone.evaluate(() => window.resolveMic());
    await phone.waitForTimeout(500);
    await phone.waitForFunction(() => window.micTracks.every(track => track.readyState === 'ended'));
    assert.equal(await phone.locator('#start').isVisible(),true);
    await phone.evaluate(() => {window.delayMic = false;});
    await phone.locator('#start').click();
    await phone.locator('#mute').waitFor({state:'visible'});
    await phone.reload();
    await phone.waitForFunction(() => !document.getElementById('start').disabled);
    assert.equal(await phone.locator('#mute').isVisible(),false);
    // Public character preferences follow the PC configuration. No mobile editor.
    for (const id of ['baijie','lily','office','living','system']) {
      await phone.route('**/info', async route => {
        const response = await route.fetch();
        const info = await response.json();
        info.character = {id,name:id,animation:{blink:true,head:true}};
        await route.fulfill({json:info});
      });
      await phone.reload();
      await phone.waitForFunction(() => !document.getElementById('start').disabled);
      assert.equal(await phone.evaluate(() => document.body.dataset.character),id);
      assert.equal(await phone.locator('#live-character-stage canvas').count(),['baijie','lily'].includes(id)?1:0);
      if (['baijie','lily'].includes(id)) {
        await phone.waitForTimeout(2500);
        for (const viewport of [{width:390,height:844},{width:844,height:390}]) {
          await phone.setViewportSize(viewport);
          await phone.waitForTimeout(150);
          await phone.screenshot({path:path.join(output,`phone-${id}-${viewport.width}.png`)});
        }
        await phone.setViewportSize({width:390,height:844});
      }
      await phone.unroute('**/info');
    }
    // iPhone-style browser: no element fullscreen API. Help is only opened on demand.
    await phone.evaluate(() => {document.documentElement.requestFullscreen=undefined;document.documentElement.webkitRequestFullscreen=undefined;});
    assert.equal(await phone.locator('#help-dialog').isVisible(),false);
    await phone.locator('#fullscreen').click();
    assert.equal(await phone.locator('#help-dialog').isVisible(),true);
    await phone.locator('#close-help').click();
    assert.equal(await phone.locator('#help-dialog').isVisible(),false);
    assert.deepEqual(errors,[]);
    assert.deepEqual(failedAssets,[]);

    const desktop = await browser.newPage({viewport:{width:1440,height:1000}});
    const desktopErrors = [];
    desktop.on('pageerror', error => desktopErrors.push(error.message));
    let saved = null;
    let state = {...fixture.status,enabled:false,running:false,configured:false,addresses:[],urls:[]};
    await desktop.route('**/api/workbench/mobile**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/qr')) return route.fulfill({body:await fs.readFile(fixture.qr),contentType:'image/png'});
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        if (url.pathname.endsWith('/config')) {
          saved = body; state = {...state,configured:true,character:body.character.name,models:body.config};
        }
        else state = {...fixture.status,enabled:body.enabled,running:body.enabled};
      }
      return route.fulfill({json:state});
    });
    await desktop.goto(`${process.env.AUDIOCPP_WORKBENCH_URL || 'http://127.0.0.1:7860'}/#settings/mobile`);
    await desktop.locator('#settings-mobile').waitFor({state:'visible'});
    assert.equal(await desktop.locator('#mobile-save').count(),0,'Saved realtime settings sync without a second button');
    await desktop.waitForFunction(() => !document.getElementById('mobile-enabled').disabled);
    assert(saved.config.tts_model && saved.config.asr_model && saved.config.llm_model);
    assert(saved.character.name && typeof saved.config.instructions === 'string');
    assert.equal(saved.character.id,'companion');
    assert.equal(typeof saved.character.animation.mouth,'boolean');
    await desktop.locator('#mobile-enabled').check();
    await desktop.locator('#mobile-connection').waitFor({state:'visible'});
    await desktop.waitForFunction(() => document.getElementById('mobile-qr').naturalWidth > 0);
    await desktop.screenshot({path:path.join(output,'desktop.png'),fullPage:true});
    await desktop.setViewportSize({width:390,height:844});
    assert.equal(await desktop.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    await desktop.screenshot({path:path.join(output,'desktop-narrow.png'),fullPage:true});
    await desktop.setViewportSize({width:1440,height:1000});
    await desktop.locator('#mobile-edit').click();
    await desktop.frameLocator('#realtime-frame').locator('dialog[open]').waitFor({state:'visible'});
    assert.deepEqual(desktopErrors,[]);
    console.log('Mobile access browser: HTTPS/WSS, voice-driven mouth animation, six scenes, auto-hide/reveal, fullscreen/fallback help, mute/end, microphone denial/cancellation, desktop configuration bridge, QR and 320/390/844px layouts passed. Fixture audio and model; iPhone acceptance pending.');
  } finally {
    await browser?.close();
    host.stdin.end('\n');
    lines.close();
    await Promise.race([once(host,'exit'),new Promise(resolve => setTimeout(() => {host.kill(); resolve();},5000))]);
  }
})().catch(error => {console.error(error); process.exitCode=1;});
