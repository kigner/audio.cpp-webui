// Browser-only overlay contract: no microphone, native hotkeys, or text injection.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require(process.env.AUDIOCPP_PLAYWRIGHT_MODULE || 'playwright');

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.AUDIOCPP_BROWSER_EXECUTABLE});
  try {
    const page=await browser.newPage({viewport:{width:560,height:210},deviceScaleFactor:1.25}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.exposeFunction('resizeOverlay',async compact=>{
      await page.setViewportSize(compact?{width:360,height:64}:{width:560,height:210});
      return compact;
    });
    await page.addInitScript(()=>{
      window.nativeCalls=[];
      window.pywebview={api:{set_compact:async value=>{nativeCalls.push(['compact',value]);return resizeOverlay(value);},
        start_drag:async()=>{nativeCalls.push(['drag']);return true;},close:async()=>{nativeCalls.push(['close']);return true;}}};
      window.WebSocket=class {
        constructor(){window.overlaySocket=this;setTimeout(()=>this.onopen?.(),0);}
        close(){}
        emit(data){this.onmessage({data:JSON.stringify(data)});}
      };
    });
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url()),name=url.pathname==='/'?'index.html':url.pathname.replace('/assets/','');
      if(url.pathname.startsWith('/studio-copy/')){
        const file=url.pathname.slice('/studio-copy/'.length);
        if(!['i18n.js','locales/en.json'].includes(file))return route.fulfill({status:404,body:''});
        return route.fulfill({status:200,contentType:file.endsWith('.js')?'application/javascript':'application/json',body:await fs.readFile(path.join(__dirname,'../../webui/workbench_static',file))});
      }
      if(!['index.html','app.js','styles.css'].includes(name))return route.fulfill({status:204,body:''});
      await route.fulfill({status:200,contentType:name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html',
        body:await fs.readFile(path.join(__dirname,'../web',name))});
    });
    await page.goto('http://127.0.0.1:18765/');
    await page.waitForFunction(()=>window.overlaySocket?.onmessage);
    await page.evaluate(()=>{
      overlaySocket.emit({type:'config',model:'CrisperWhisper',toggle_hotkey:'ctrl+alt+f9',cancel_hotkey:'esc'});
      overlaySocket.emit({type:'state',value:'listening'});
      overlaySocket.emit({type:'partial',text:'移动或收起悬浮窗，听写仍会继续。',latency_ms:120});
      window.levelTimer=setInterval(()=>overlaySocket.emit({type:'level',value:.036}),65);
    });
    assert.equal(await page.locator('#state-label').textContent(),'正在听写');
    await page.evaluate(()=>overlaySocket.emit({type:'config',ui_language:'en',model:'CrisperWhisper',toggle_hotkey:'ctrl+alt+f9',cancel_hotkey:'esc'}));
    assert.equal(await page.locator('#state-label').textContent(),'Dictating');
    assert.equal(await page.locator('#transcript').textContent(),'移动或收起悬浮窗，听写仍会继续。');
    await page.evaluate(()=>overlaySocket.emit({type:'config',ui_language:'zh',model:'CrisperWhisper',toggle_hotkey:'ctrl+alt+f9',cancel_hotkey:'esc'}));
    await page.waitForTimeout(180);
    const textLayout=()=>page.locator('#transcript').evaluate(el=>({height:el.clientHeight,bottom:el.getBoundingClientRect().bottom,
      footerTop:document.querySelector('footer').getBoundingClientRect().top}));
    assert.ok((await textLayout()).height>=52,'reserve two visible lines for the transcript');
    await page.setViewportSize({width:450,height:132});
    assert.ok((await textLayout()).height>=24,'small native viewport must still show a complete line');
    assert.ok((await textLayout()).bottom<(await textLayout()).footerTop);
    await page.setViewportSize({width:560,height:210});
    const output=process.env.AUDIOCPP_BROWSER_SCREENSHOTS;
    if(output){await fs.mkdir(output,{recursive:true});await page.screenshot({path:path.join(output,'overlay-expanded.png')});}
    const waveHeight=()=>page.locator('#waveform').evaluate(canvas=>{
      const {data,width,height}=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height);
      let top=height,bottom=-1;
      for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(data[(y*width+x)*4+3]){top=Math.min(top,y);bottom=Math.max(bottom,y);}
      return bottom-top+1;
    });
    assert.ok(await waveHeight()>=10,'ordinary speech should be clearly visible');
    await page.evaluate(()=>{clearInterval(levelTimer);overlaySocket.emit({type:'level',value:0});});
    await page.waitForTimeout(700);
    assert.ok(await waveHeight()<=4,'silence should return to a quiet baseline');
    await page.locator('#drag-handle').hover();await page.mouse.down();await page.mouse.up();
    await page.waitForFunction(()=>nativeCalls.some(call=>call[0]==='drag'));
    await page.locator('#compact-button').click();
    await page.waitForFunction(()=>document.body.classList.contains('compact'));
    assert.equal(await page.locator('#state-label').textContent(),'正在听写');
    assert.equal(await page.locator('.speech-panel').isVisible(),false);
    await page.evaluate(()=>overlaySocket.emit({type:'final',text:'收起期间的识别结果仍可正常接收。'}));
    if(output)await page.screenshot({path:path.join(output,'overlay-compact.png')});
    await page.locator('#compact-button').click();
    await page.waitForFunction(()=>!document.body.classList.contains('compact'));
    assert.equal(await page.locator('#transcript').textContent(),'收起期间的识别结果仍可正常接收。');
    await page.waitForTimeout(1700);
    await page.evaluate(()=>{overlaySocket.emit({type:'state',value:'idle'});overlaySocket.emit({type:'partial',text:''});});
    assert.equal(await page.locator('#transcript').textContent(),'收起期间的识别结果仍可正常接收。');
    await page.evaluate(()=>overlaySocket.emit({type:'error',message:'CrisperWhisper tokenizer does not contain <|auto|>'}));
    assert.match(await page.locator('#transcript').textContent(),/选择实际语言/);
    if(output)await page.screenshot({path:path.join(output,'overlay-error.png')});
    const layout=await page.locator('#transcript').evaluate(el=>({bottom:el.getBoundingClientRect().bottom,visible:el.clientHeight}));
    assert.ok(layout.bottom<210&&layout.visible>=52);
    await page.locator('#close-button').click();
    assert.deepEqual(await page.evaluate(()=>nativeCalls),[['drag'],['compact',true],['compact',false],['close']]);
    assert.deepEqual(errors,[]);
    console.log('PASS overlay drag, compact/restore, ongoing events, localized error and layout');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
