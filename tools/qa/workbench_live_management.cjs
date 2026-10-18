/* Real UI reference CRUD, two authorized downloads, settings. No model inference. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const qaContext=require('./workbench_qa_context.cjs'),qaConfig=qaContext.configuration();
const {chromium}=require(path.join(process.env.CODEX_NODE_DEPENDENCIES||'C:/Users/KIN/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules','playwright'));
const base=process.env.WORKBENCH_URL||'http://127.0.0.1:7860',root=process.cwd();
const settingsOnly=process.argv.includes('--settings-only');
const referencesOnly=process.argv.includes('--references-only'),unicode=process.argv.includes('--unicode');
const output=path.join(qaConfig.directory,unicode?'ui-management-unicode':settingsOnly?'ui-management-settings-retest':'ui-management',new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(output,{recursive:true});
const expected=qaContext.readContext(qaConfig).expected;
const qaName=`${unicode?'qa_中文音频_20261008_':'qa-ui-'}${Date.now()}`,qaFile=`${qaName}.wav`,voiceDir=path.join(root,'webui/voice'),prompt=path.join(voiceDir,'prompt_text');
const beforePrompt=fs.readFileSync(prompt),sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const beforeWavs=Object.fromEntries(fs.readdirSync(voiceDir).filter(name=>/\.wav$/i.test(name)).map(name=>[name,sha(fs.readFileSync(path.join(voiceDir,name)))]));
fs.writeFileSync(path.join(output,'prompt_text.before.bin'),beforePrompt);
const report={started:new Date().toISOString(),method:'Real Chrome UI and production adapters; no mocked responses or GPU inference.',runtime:expected,qaName,
  original:{promptSha256:sha(beforePrompt),wavs:beforeWavs},checks:[],posts:[],downloads:[],uploads:[],screenshots:[],failures:[],pageErrors:[]};
let browser,page,created=false,currentDownload=null;
const save=()=>fs.writeFileSync(path.join(output,'management.json'),JSON.stringify(report,null,2));
function assert(ok,name,details) {report.checks.push({name,status:ok?'pass':'fail',details});save();if(!ok)throw Error(name);}
const logical=bytes=>bytes.toString('utf8').replace(/\r\n/g,'\n').replace(/\n$/,'').split('\n');
function userUnchanged() {
  const lines=logical(fs.readFileSync(prompt)).filter(line=>line.split('|')[0].trim()!==qaName);
  return JSON.stringify(lines)===JSON.stringify(logical(beforePrompt))&&Object.entries(beforeWavs).every(([name,hash])=>fs.existsSync(path.join(voiceDir,name))&&sha(fs.readFileSync(path.join(voiceDir,name)))===hash);
}
async function shot(name) {const filename=path.join(output,`${name}.png`);await page.screenshot({path:filename,fullPage:true});report.screenshots.push(filename);save();}
async function get(endpoint) {const response=await page.request.get(`${base}/api/workbench${endpoint}`);if(!response.ok())throw Error(`${endpoint}: ${response.status()}`);return response.json();}
async function waitDownload(model,states,timeout=180000) {
  const began=Date.now();let last='';
  while(Date.now()-began<timeout) {
    const record=(await get('/downloads')).downloads.find(item=>item.model===model||item.id===model);
    if(record) {if(JSON.stringify(record)!==last){report.downloads.push({time:new Date().toISOString(),...record});last=JSON.stringify(record);save();}if(states.includes(record.status))return record;if(['error','failed'].includes(record.status))throw Error(`Download failed: ${JSON.stringify(record)}`);}
    await page.waitForTimeout(250);
  }
  throw Error(`Download ${model} did not reach ${states.join('/')}`);
}
async function selectLibraryModel(model) {
  await page.locator('[data-route="models"]').click();await page.locator('#model-search').fill(model);
  await page.locator(`#model-list [data-model="${model}"]`).click();await page.locator('#model-detail h2').waitFor();
  await page.waitForTimeout(100);
}
function packageHashes(directory) {
  const result=[];function walk(folder){for(const item of fs.readdirSync(folder,{withFileTypes:true})){const full=path.join(folder,item.name);if(item.isDirectory())walk(full);else if(item.isFile()){const bytes=fs.readFileSync(full);result.push({path:full,size:bytes.length,sha256:sha(bytes)});}}}walk(directory);return result;
}
async function refCrud() {
  await page.locator('[data-route="references"]').click();await page.locator('#new-reference').click();
  const beforePosts=report.posts.length;await page.locator('#reference-editor .reference-save').click();
  assert(report.posts.length===beforePosts,'save without source is rejected before POST',{toast:await page.locator('#toast').textContent()});
  await page.locator('#reference-editor .reference-automatic input').setChecked(false);
  const upload=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/workbench/uploads'&&r.request().method()==='POST');
  await page.locator('#reference-editor input[type="file"]').setInputFiles(path.join(voiceDir,'demo_01_man.wav'));
  const uploaded=await (await upload).json();report.uploads.push({...uploaded,path:path.join(root,'webui/output/workbench-inputs',`${uploaded.id}.wav`)});
  await page.locator('#reference-editor audio').evaluate(el=>el.load());
  await page.waitForFunction(()=>document.querySelector('#reference-editor audio')?.readyState>=1);
  const preview=await page.locator('#reference-editor audio').evaluate(async audio=>{const duration=audio.duration;await audio.play();const start=performance.now();while(audio.currentTime<Math.min(.1,duration/3)&&performance.now()-start<10000)await new Promise(resolve=>setTimeout(resolve,50));audio.pause();return {duration,currentTime:audio.currentTime,readyState:audio.readyState,error:audio.error?.message||null};});
  assert(preview.duration>0&&preview.currentTime>0&&!preview.error,'real uploaded reference preview decodes and plays',preview);
  await page.locator('#reference-editor [data-input-key="reference_name"]').fill(`${qaName}|invalid`);
  await page.locator('#reference-editor [data-input-key="reference_text"]').fill('QA reference transcript one.');
  const invalid=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/workbench/references'&&r.request().method()==='POST');await page.locator('#reference-editor .reference-save').click();
  assert((await invalid).status()===400,'invalid QA name is rejected by real adapter');
  await page.locator('#reference-editor .reference-save:enabled').waitFor();
  await page.locator('#reference-editor [data-input-key="reference_name"]').fill(qaName);
  const saved=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/workbench/references'&&r.request().method()==='POST'&&r.status()===200);await page.locator('#reference-editor .reference-save').click();await saved;created=true;
  const row=page.locator(`[data-reference="${qaFile}"]`);await row.waitFor();
  await row.locator('audio').evaluate(audio=>audio.load());
  await page.waitForFunction(name=>document.querySelector(`[data-reference=${JSON.stringify(name)}] audio`)?.readyState>=1,qaFile);
  const savedPreview=await row.locator('audio').evaluate(async audio=>{await audio.play();const start=performance.now();while(audio.currentTime<.1&&performance.now()-start<10000)await new Promise(resolve=>setTimeout(resolve,50));audio.pause();return {url:audio.currentSrc,duration:audio.duration,currentTime:audio.currentTime,error:audio.error?.message||null};});
  assert(savedPreview.duration>0&&savedPreview.currentTime>0&&!savedPreview.error&&decodeURIComponent(savedPreview.url).includes(qaFile),'saved library reference URL decodes and plays with its actual filename',savedPreview);
  assert((await get('/references')).voices.some(v=>v.name===qaFile&&v.text==='QA reference transcript one.'),'created reference and transcript are real saved records');assert(userUnchanged(),'user WAVs and original prompt records preserved after create');await shot('references-created');
  await row.getByRole('button',{name:'编辑',exact:true}).click();
  await page.locator('#reference-editor [data-input-key="reference_text"]').fill('QA reference transcript updated.');
  page.once('dialog',dialog=>{report.checks.push({name:'duplicate overwrite prompt displayed',status:'pass',details:dialog.message()});void dialog.dismiss();});
  const conflict=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/workbench/references'&&r.status()===409);await page.locator('#reference-editor .reference-save').click();await conflict;await page.locator('#reference-editor .reference-save:enabled').waitFor();
  assert((await get('/references')).voices.find(v=>v.name===qaFile)?.text==='QA reference transcript one.','declining duplicate overwrite preserves QA record');
  page.once('dialog',dialog=>void dialog.accept());
  const overwritten=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/workbench/references'&&r.request().method()==='POST'&&r.status()===200);await page.locator('#reference-editor .reference-save').click();await overwritten;
  assert((await get('/references')).voices.find(v=>v.name===qaFile)?.text==='QA reference transcript updated.','accepting duplicate overwrite updates only QA transcript');await shot('references-updated');
  await page.locator('#reference-search').fill(qaName);assert(await page.locator('.reference-row').count()===1,'reference search finds own QA record');
  await page.locator('#reference-search').fill('__no_such_qa_voice__');assert(await page.locator('.reference-row').count()===0,'reference search empty state');await page.locator('#reference-search').fill('');
  page.once('dialog',dialog=>void dialog.dismiss());await row.getByRole('button',{name:'删除',exact:true}).click();assert((await get('/references')).voices.some(v=>v.name===qaFile),'declining delete preserves own QA record');
  page.once('dialog',dialog=>void dialog.accept());const deleted=page.waitForResponse(r=>decodeURIComponent(new URL(r.url()).pathname)===`/api/workbench/references/${qaFile}`&&r.request().method()==='DELETE');await row.getByRole('button',{name:'删除',exact:true}).click();await deleted;created=false;
  assert(!(await get('/references')).voices.some(v=>v.name===qaFile)&&!fs.existsSync(path.join(voiceDir,qaFile)),'accepted delete removes only QA WAV and record');await shot('references-cleaned');
}
async function modelDownloads() {
  const active=(await get('/downloads')).downloads.filter(d=>!['completed','complete','done','cancelled','canceled','paused','failed','error'].includes(d.status));assert(active.length===0,'no unrelated workbench download is active',active);
  const model='smart-turn',detail=await get(`/models/${model}`);assert(!detail.installed,'Smart Turn starts uninstalled',detail.installed);
  assert(path.resolve(detail.install_path).startsWith(path.join(root,'models')+path.sep),'Smart Turn download destination is project models',detail.install_path);
  await selectLibraryModel(model);currentDownload=model;await page.locator('#model-detail').getByRole('button',{name:'下载模型',exact:true}).click();
  const item=page.locator('.download-item').filter({has:page.locator('.download-name',{hasText:detail.label})});
  await item.getByRole('button',{name:'暂停',exact:true}).click({timeout:10000});assert((await waitDownload(model,['paused'])).status==='paused','real download reaches paused');await shot('smart-turn-paused');
  await item.getByRole('button',{name:'继续',exact:true}).click();await waitDownload(model,['queued','starting','preparing','probing','running','downloading']);
  await item.getByRole('button',{name:'取消',exact:true}).click();assert((await waitDownload(model,['cancelled','canceled'])).status.startsWith('cancel'),'resumed real download reaches cancelled');await shot('smart-turn-cancelled');
  await item.getByRole('button',{name:'重试',exact:true}).click();await waitDownload(model,['completed','complete','done'],600000);currentDownload=null;
  await page.locator('#refresh-catalog').click();await selectLibraryModel(model);const installed=await get(`/models/${model}`);assert(installed.installed,'Smart Turn real download installs model');
  report.smartTurnPackage=packageHashes(installed.install_path);await shot('smart-turn-installed');
  const pulse=await get('/models/pulsevad');assert(!pulse.installed,'PulseVAD starts uninstalled',pulse.installed);assert(path.resolve(pulse.install_path).startsWith(path.join(root,'models')+path.sep),'PulseVAD download destination is project models',pulse.install_path);
  await selectLibraryModel('pulsevad');currentDownload='pulsevad';await page.locator('#model-detail').getByRole('button',{name:'下载模型',exact:true}).click();await waitDownload('pulsevad',['completed','complete','done'],600000);currentDownload=null;
  await page.locator('#refresh-catalog').click();await selectLibraryModel('pulsevad');const pulseInstalled=await get('/models/pulsevad');assert(pulseInstalled.installed,'PulseVAD real download installs model');report.pulseVadPackage=packageHashes(pulseInstalled.install_path);await shot('pulsevad-installed');
}
async function settings() {
  await page.locator('[data-route="settings"]').click();
  for(const palette of ['classic','studio'])for(const theme of ['light','dark','system']) {
    await page.locator(`[data-palette-choice="${palette}"]`).click();await page.locator('#theme-select').selectOption(theme);
    assert(await page.locator('html').getAttribute('data-palette')===palette&&await page.locator('#theme-select').inputValue()===theme,`appearance ${palette}/${theme} applies`);await shot(`settings-${palette}-${theme}`);
  }
  await page.locator('[data-settings-tab="runtime"]').click();await page.locator('#refresh-runtime-logs').click();await page.locator('#runtime-health').waitFor();
  assert((await page.locator('#runtime-health').textContent()).includes('本地服务已就绪'),'runtime health is visible');
  const log=page.waitForEvent('download');await page.locator('#download-runtime-logs').click();const download=await log;const file=path.join(output,'runtime-diagnostic.log');await download.saveAs(file);assert(fs.statSync(file).size>0,'real diagnostic-log download has content');await shot('settings-runtime');
  await page.locator('[data-settings-tab="api"]').click();await page.locator('#api-endpoints .card').first().waitFor();
  const cards=page.locator('#api-endpoints .card');for(let index=0;index<await cards.count();index++)for(const language of ['python','curl']) {
    const card=cards.nth(index);await card.locator(`[data-code-lang="${language}"]`).click();const expectedCode=await card.locator('pre').textContent();await card.getByRole('button',{name:'复制代码',exact:true}).click();let text='';const normalized=value=>value.replace(/\r\n/g,'\n');const began=Date.now();while(Date.now()-began<3000){text=await page.evaluate(()=>navigator.clipboard.readText());if(normalized(text)===normalized(expectedCode))break;await page.waitForTimeout(50);}assert(normalized(text)===normalized(expectedCode),`API example ${index}/${language} copy matches displayed code`,{expectedCode,clipboard:text,comparison:'Windows clipboard CRLF normalized to LF',toast:await page.locator('#toast').textContent(),waitMs:Date.now()-began});
  }
  await shot('settings-api');await page.setViewportSize({width:390,height:844});await page.locator('[data-settings-tab="appearance"]').click();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'narrow settings avoid horizontal document overflow');await shot('settings-narrow');
  await page.setViewportSize({width:1440,height:1000});
}
async function main() {
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--autoplay-policy=no-user-gesture-required']});const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true,permissions:['clipboard-read','clipboard-write']});page=await context.newPage();
  page.on('pageerror',error=>report.pageErrors.push(error.message));
  await page.route('**/api/**',async intercepted=>{
    const request=intercepted.request(),endpoint=decodeURIComponent(new URL(request.url()).pathname);
    if(['GET','HEAD','OPTIONS'].includes(request.method()))return intercepted.continue();
    let body;try{body=request.postDataJSON();}catch{body={multipart:true,bytes:request.postDataBuffer()?.length};}
    const allowed=request.method()==='POST'&&(endpoint==='/api/workbench/uploads'||endpoint==='/api/workbench/references'&&[qaName,`${qaName}|invalid`].includes(body.name)||/^\/api\/workbench\/downloads\/(smart-turn|pulsevad)(\/(pause|resume|cancel))?$/.test(endpoint))||request.method()==='DELETE'&&endpoint===`/api/workbench/references/${qaFile}`;
    report.posts.push({method:request.method(),url:request.url(),endpoint,body,allowed});save();if(!allowed){report.failures.push({name:'unauthorized API mutation blocked',endpoint});return intercepted.abort('blockedbyclient');}return intercepted.continue();
  });
  await page.goto(`${base}/#references`,{waitUntil:'domcontentloaded'});await page.locator('#connection-status[data-state="online"]').waitFor({timeout:60000});
report.runtime_context=await qaContext.verifyContext(page,base,qaContext.readContext(qaConfig));  const health=await get('/health');delete health.shutdown_token;report.liveHealth=health;report.liveVersion=(await get('/catalog')).version;
  assert(health.instance_id===expected.health.instance_id&&health.pid===expected.health.pid,'live service matches current-runtime.json instance and PID',health);
  assert((await get('/logs')).directory===path.join(root,'webui/logs'),'service logs resolve inside current source checkout');
  if(!settingsOnly){await refCrud();if(!referencesOnly)await modelDownloads();}if(!referencesOnly)await settings();
}
main().catch(error=>{report.failures.push({name:'management UI',error:error.stack});console.error(error.stack);}).finally(async()=>{
  try {
    if(currentDownload) {await page.request.post(`${base}/api/workbench/downloads/${currentDownload}/cancel`,{data:{}});report.downloadCleanup=`Cancelled own active ${currentDownload} download after failure.`;}
    if(created&&userUnchanged()) {await page.request.delete(`${base}/api/workbench/references/${qaFile}`);created=false;report.referenceCleanup='Removed own QA record after failure.';}
    assert(userUnchanged(),'all original user WAV hashes and logical prompt records unchanged at completion');
    if(!created&&sha(fs.readFileSync(prompt))!==sha(beforePrompt)) {fs.writeFileSync(prompt,beforePrompt);report.promptRestoration='Restored original bytes from evidence backup after QA CRUD and verifying no user-line changes.';}
    assert(sha(fs.readFileSync(prompt))===sha(beforePrompt),'prompt_text original bytes restored exactly');
    for(const upload of report.uploads)if(/^[a-f0-9]{32}$/.test(upload.id)&&fs.existsSync(upload.path)){fs.unlinkSync(upload.path);upload.cleaned=true;}
  }catch(error){report.failures.push({name:'cleanup',error:error.stack});}
  report.finished=new Date().toISOString();report.status=report.failures.length||report.pageErrors.length||report.checks.some(check=>check.status==='fail')?'fail':'pass';save();if(browser)await browser.close();console.log(JSON.stringify({status:report.status,checks:report.checks.length,failures:report.failures.length,report:path.join(output,'management.json')}));process.exitCode=report.status==='pass'?0:1;
});
