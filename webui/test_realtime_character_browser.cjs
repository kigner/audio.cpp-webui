/* Transparent character rendering with local assets and real WebGL2.
 * node webui/test_realtime_character_browser.cjs
 * Optional AUDIOCPP_PLAYWRIGHT_MODULE, AUDIOCPP_BROWSER_EXECUTABLE,
 * AUDIOCPP_BROWSER_SCREENSHOTS. No server, microphone or cloud calls.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require(process.env.AUDIOCPP_PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const options = {headless:true,args:['--enable-gpu','--use-angle=d3d11']};
  if (process.env.AUDIOCPP_BROWSER_EXECUTABLE) options.executablePath = process.env.AUDIOCPP_BROWSER_EXECUTABLE;
  const browser = await chromium.launch(options);
  const page = await browser.newPage({viewport:{width:1365,height:768}});
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    if (url.pathname === '/') return route.fulfill({contentType:'text/html',body:`<!doctype html>
      <style>body{margin:0}#room,#character{position:fixed;inset:0}#room{background:#60452c}</style>
      <div id="room"></div><div id="character"></div>
      <script type="module">
        import {createCharacter} from '/companion/character.js';
        window.createCharacter = createCharacter;
        window.character = await createCharacter(document.querySelector('#character'));
        character.setMotionEnabled(false);character.setListening(false);
      </script>`});
    if (url.pathname === '/companion/assets/static.json') return route.fulfill({json:{image:'character.png',label:'Static character fixture'}});
    const filename = path.join(__dirname,'realtime_static',url.pathname);
    const types = {'.js':'text/javascript','.json':'application/json','.png':'image/png'};
    try {return route.fulfill({body:await fs.readFile(filename),contentType:types[path.extname(filename)]||'application/octet-stream'});}
    catch {return route.fulfill({status:404,body:'Fixture route missing'});}
  });
  try {
    await page.goto('http://127.0.0.1:17782/');
    await page.waitForFunction(() => typeof window.character?.stats==='function');
    await page.evaluate(() => {
      window.pixels = () => {
        const canvas = document.querySelector('canvas'), gl = canvas.getContext('webgl2');
        const result = new Uint8Array(canvas.width*canvas.height*4);
        gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,result);
        return result;
      };
    });
    await page.waitForFunction(() => pixels().some((v,i) => i%4===3 && v>=250));
    assert.equal(await page.evaluate(() => document.querySelector('canvas').getContext('webgl2').getContextAttributes().alpha),true);
    for (const viewport of [{width:1365,height:768},{width:1920,height:1080},{width:700,height:900},{width:390,height:844}]) {
      await page.setViewportSize(viewport);
      await page.waitForFunction(({width,height}) => {
        const canvas = document.querySelector('canvas');
        return canvas.clientWidth===width && canvas.clientHeight===height && character.stats().bounds.y+character.stats().bounds.height<=height+.1;
      },viewport);
      // Wait for the resize observer and a rendered frame, independently of image fit calculations.
      await page.waitForTimeout(100);
      const {bounds,image} = await page.evaluate(() => character.stats());
      assert(bounds.x>=-.01 && bounds.y>=-.01,'foreground must stay within the viewport');
      assert(bounds.x+bounds.width<=viewport.width+.01 && bounds.y+bounds.height<=viewport.height+.01);
      assert(Math.abs(bounds.width/bounds.height-image[0]/image[1])<1e-6,'portrait must retain its aspect ratio');
      if (viewport.width>=900) assert(bounds.x+bounds.width/2>viewport.width*.65,'desktop character should sit on the right');
      const alpha = await page.evaluate(() => {
        const canvas=document.querySelector('canvas'), data=pixels();
        let top=0, opaque=0;
        for(let i=3;i<data.length;i+=4)if(data[i]>=250)opaque++;
        for(let i=(canvas.height-1)*canvas.width*4+3;i<data.length;i+=4)top+=data[i];
        return {top,opaque};
      });
      assert.equal(alpha.top,0,'transparent headroom must remain visible');assert(alpha.opaque>10000);
    }
    console.log('PASS complete, proportional, right-aligned portrait across desktop and portrait viewports');

    await page.setViewportSize({width:1365,height:768});
    await page.waitForTimeout(150);
    const independence = await page.evaluate(async () => {
      const before=pixels();
      document.querySelector('#room').style.background='#225588';
      await new Promise(resolve=>setTimeout(resolve,100));
      const after=pixels();
      const canvas=document.querySelector('canvas');
      let leftAlpha=0;
      for(let y=0;y<canvas.height;y++)leftAlpha+=after[(y*canvas.width+10)*4+3];
      return {same:before.every((v,i)=>v===after[i]),leftAlpha};
    });
    assert(independence.same,'changing the background must not alter the foreground');
    assert.equal(independence.leftAlpha,0,'the room must show through the empty left side');
    assert(!requests.some(name=>name.endsWith('/scene.png')),'the old baked scene must not be loaded');
    console.log('PASS background independence and transparent foreground pixels');

    await page.evaluate(() => {window.neutral=pixels();character.setViseme('aa',.65);});
    await page.waitForFunction(() => character.stats().mouthMax>.95);
    const changes = await page.evaluate(() => {
      const data=pixels(), canvas=document.querySelector('canvas'), {bounds,image}=character.stats();
      let changed=0,outsideMouth=0;
      for(let i=0;i<data.length;i+=4){
        if(Math.max(...[0,1,2].map(c=>Math.abs(data[i+c]-neutral[i+c])))<=8)continue;
        changed++;
        const screenX=(i/4%canvas.width)/canvas.width*innerWidth;
        const screenY=(canvas.height-1-Math.floor(i/4/canvas.width))/canvas.height*innerHeight;
        const x=(screenX-bounds.x)/bounds.width*image[0],y=(screenY-bounds.y)/bounds.height*image[1];
        // Observed mouth area in the actual new portrait, independent of rig coordinates.
        if(x<430||x>675||y<445||y>605)outsideMouth++;
      }
      return {changed,outsideMouth};
    });
    assert(changes.changed>100,'viseme should visibly change the mouth');assert.equal(changes.outsideMouth,0,'mouth patches should stay on the portrait mouth');
    const screenshots=process.env.AUDIOCPP_BROWSER_SCREENSHOTS;
    if(screenshots){await fs.mkdir(screenshots,{recursive:true});await page.screenshot({path:path.join(screenshots,'character-mouth.png')});}
    await page.evaluate(() => {character.resetMouth();character.setMotionEnabled(true);character.setAnimationSettings({breath:false,head:false,shoulders:false,listening:false});});
    await page.waitForFunction(() => character.stats().blink>.6,{},{polling:'raf'});
    if(screenshots)await page.screenshot({path:path.join(screenshots,'character-blink.png')});
    assert((await page.evaluate(()=>character.stats())).blinks>=1);
    console.log('PASS visible mouth patch registration and blinking after layer separation');

    await page.setViewportSize({width:2400,height:1500});
    await page.evaluate(() => {character.resetMouth();character.setMotionEnabled(false);character.setListening(false);});
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      window.skinSamples = () => {
        const data=pixels(),canvas=document.querySelector('canvas'),{bounds,image}=character.stats();
        // Skin beside/below the lips in the portrait, inside the feathered patch.
        return [[496,511],[614,503],[586,551],[533,568]].map(([x,y]) => {
          const cx=Math.round((bounds.x+x/image[0]*bounds.width)/innerWidth*canvas.width);
          const cy=canvas.height-1-Math.round((bounds.y+y/image[1]*bounds.height)/innerHeight*canvas.height);
          let total=0;
          for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
            const i=((cy+dy)*canvas.width+cx+dx)*4;
            total+=.2126*data[i]+.7152*data[i+1]+.0722*data[i+2];
          }
          return total/25;
        });
      };
      window.neutralSkin=skinSamples();
    });
    const {bounds:faceBounds,image:faceImage}=await page.evaluate(()=>character.stats());
    const faceClip={x:faceBounds.x+370/faceImage[0]*faceBounds.width,y:faceBounds.y+300/faceImage[1]*faceBounds.height,
      width:340/faceImage[0]*faceBounds.width,height:320/faceImage[1]*faceBounds.height};
    if(screenshots)await page.screenshot({path:path.join(screenshots,'face-neutral.png'),clip:faceClip});
    for(const viseme of ['aa','E','O','U','PP','listening']){
      await page.evaluate(key=>{character.resetMouth();character.setAnimationSettings({listening:true});character.setListening(key==='listening');if(key!=='listening')character.setViseme(key,1);},viseme);
      await page.waitForFunction(key=>key==='listening'?character.stats().listening>.95:character.stats().mouthMax>.99,viseme);
      const drift=await page.evaluate(()=>skinSamples().map((v,i)=>v-neutralSkin[i]));
      console.log(`Mouth skin luminance drift ${viseme}: ${drift.map(v=>v.toFixed(1)).join(', ')}`);
      assert(drift.every(v=>Math.abs(v)<6),`${viseme} must preserve surrounding skin tone: ${drift}`);
      if(screenshots)await page.screenshot({path:path.join(screenshots,`face-${viseme}.png`),clip:faceClip});
    }
    console.log('PASS surrounding skin tone across five visemes and listening');

    for(const role of [
      {id:'baijie',subject:[[989,23],[1602,893]],mouth:[1250,156,1327,221],clip:{x:1350,y:95,width:240,height:190}},
      {id:'lily',subject:[[589,0],[1658,941]],mouth:[1185,142,1275,214],clip:{x:1310,y:65,width:230,height:210}},
    ]){
    await page.evaluate(async id=>{
      character.dispose();
      window.character=await createCharacter(document.querySelector('#character'),new URL(`/companion/assets/${id}/character.json`,location.href),{onLayout(bounds){window.sceneBounds=bounds;}});
      character.setMotionEnabled(false);character.setListening(false);
    },role.id);
    for(const viewport of [{width:1920,height:1080},{width:1920,height:914},{width:700,height:900},{width:390,height:844}]){
      await page.setViewportSize(viewport);await page.waitForTimeout(120);
      const state=await page.evaluate(()=>({bounds:character.stats().bounds,scene:sceneBounds}));
      assert.deepEqual(state.scene,state.bounds,'foreground and sofa must share their transform');
      const {bounds:b}=state;
      for(const [x,y] of role.subject){
        assert(b.x+x/1672*b.width>=-.01&&b.x+x/1672*b.width<=viewport.width+.01);
        assert(b.y+y/941*b.height>=-.01&&b.y+y/941*b.height<=viewport.height+.01,'approved foreground crop remains visible');
      }
    }
    await page.setViewportSize({width:1920,height:1080});await page.waitForTimeout(100);
    await page.evaluate(()=>{window.neutral=pixels();});
    for(const viseme of ['aa','E','O','U','PP']){
      await page.evaluate(key=>{character.resetMouth();character.setViseme(key,1);},viseme);
      await page.waitForFunction(()=>character.stats().mouthMax>.99);
      const change=await page.evaluate(([left,top,right,bottom])=>{
        const data=pixels(),canvas=document.querySelector('canvas'),{bounds:b}=character.stats();let changed=0,outside=0;
        for(let i=0;i<data.length;i+=4){
          if(Math.max(...[0,1,2].map(c=>Math.abs(data[i+c]-neutral[i+c])))<=8)continue;
          changed++;
          const x=((i/4%canvas.width)/canvas.width*innerWidth-b.x)/b.width*1672;
          const y=((canvas.height-1-Math.floor(i/4/canvas.width))/canvas.height*innerHeight-b.y)/b.height*941;
          if(x<left||x>right||y<top||y>bottom)outside++;
        }
        return {changed,outside};
      },role.mouth);
      assert(change.changed>8,`${viseme} should move ${role.id}'s lips`);assert.equal(change.outside,0,`${role.id} mouth patches must stay on her face`);
      if(screenshots)await page.screenshot({path:path.join(screenshots,`${role.id}-${viseme}.png`),clip:role.clip});
    }
    await page.evaluate(()=>{character.resetMouth();character.setMotionEnabled(true);character.setAnimationSettings({breath:false,head:false,shoulders:false,listening:false});});
    await page.waitForFunction(()=>character.stats().blink>.65,null,{polling:'raf'});
    if(screenshots)await page.screenshot({path:path.join(screenshots,`${role.id}-blink.png`),clip:role.clip});
    console.log(`PASS ${role.id} approved pose, shared sofa placement and registered mouth/eye animation`);
    }

    const staticStart=requests.length;
    await page.evaluate(async () => {
      character.dispose();
      window.character=await createCharacter(document.querySelector('#character'),new URL('/companion/assets/static.json',location.href));
    });
    await page.waitForFunction(() => pixels().some((v,i) => i%4===3 && v>=250));
    assert.equal((await page.evaluate(()=>character.stats())).animated,false);
    assert(!requests.slice(staticStart).some(name=>/face-atlas|face-registration/.test(name)),'a plain character image must not need expression assets');
    await page.evaluate(()=>character.dispose());assert.equal(await page.locator('canvas').count(),0);
    assert.deepEqual(errors,[]);
    console.log('PASS plain PNG character support without expression assets and renderer cleanup');
    console.log('Realtime character browser: 7/7 passed');
  } catch(error) {
    console.error(JSON.stringify({errors,requests,state:await page.evaluate(()=>({hidden:document.hidden,stats:window.character?.stats?.(),width:document.querySelector('canvas')?.width,height:document.querySelector('canvas')?.height,error:document.querySelector('canvas')?.getContext('webgl2').getError()}))}));
    throw error;
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
