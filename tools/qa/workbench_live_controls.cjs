/* Real-page UI audit. Never loads a model, submits inference, or changes user files. */
const fs = require('node:fs');
const path = require('node:path');
const runtime = process.env.CODEX_NODE_DEPENDENCIES || 'C:/Users/KIN/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const {chromium} = require(path.join(runtime, 'playwright'));

const base = process.env.WORKBENCH_URL || 'http://127.0.0.1:7860';
const output = path.resolve(process.env.WORKBENCH_QA_OUTPUT || 'build/functional-qa-20261008');
const shots = path.join(output, 'live-controls-screenshots');
const routes = [
  ['tts','语音合成'], ['asr','语音识别'], ['music','音乐与音效'],
  ['design','声音设计'], ['vc','声音转换'], ['references','参考音频'],
  ['tools','音频工具'], ['models','模型中心'], ['settings','系统设置'],
];
const tools = ['processing','separation','vad','diar','turn','align','midi'];
const report = {started:new Date().toISOString(), base, method:'Real Chrome UI, real GET responses; no mocked successful requests. Only known demo audio fixture uploads are allowed; all other API mutations blocked.',
  exclusions:['scenarios','model loading/inference/unloading','downloads','microphone capture','user-data create/delete','service shutdown'],
  navigation:[], models:[], interactions:[], failures:[], pageErrors:[], blockedMutations:[], uploads:[], screenshots:[]};
fs.mkdirSync(shots,{recursive:true});
let browser, page, allowUpload=false;
const safe = value => value.replace(/[^\w.-]/g,'_');
function save() {fs.writeFileSync(path.join(output,'live-controls.json'),JSON.stringify(report,null,2));}
async function shot(name) {
  const filename=path.join(shots,`${safe(name)}.png`);
  await page.screenshot({path:filename,fullPage:true}); report.screenshots.push(filename); return filename;
}
async function check(name, action) {
  try {const details=await action();report.interactions.push({name,status:'pass',details});}
  catch(error) {report.failures.push({name,error:error.message});report.interactions.push({name,status:'fail',error:error.message});}
  save();
}
async function go(route) {
  await page.goto(`${base}/#${route}`,{waitUntil:'domcontentloaded'});
  await page.locator('#connection-status[data-state="online"]').waitFor({timeout:30000});
  await page.waitForTimeout(150);
}
async function descriptors() {
  return page.locator('#task-setting-inputs input, #task-setting-inputs select, #task-setting-inputs textarea, #basic-controls input, #basic-controls select, #basic-controls textarea, #effect-controls input, #effect-controls select, #effect-controls textarea, #task-inputs input, #task-inputs select, #task-inputs textarea').evaluateAll(elements => elements.filter(el =>
    (el.id||el.dataset.inputKey) && el.type!=='file' && el.type!=='hidden' && el.checkVisibility({visibilityProperty:true})).map(el => ({
      id:el.id,key:el.dataset.inputKey || el.id.replace(/^param-/,''),
      selector:el.id?`[id=${JSON.stringify(el.id)}]`:`#${el.closest('#task-setting-inputs,#task-inputs').id} [data-input-key=${JSON.stringify(el.dataset.inputKey)}]`,
      label:el.closest('.field-group')?.querySelector('.field-label, .check-label')?.textContent?.trim() || el.getAttribute('aria-label') || el.id,
      type:el.tagName==='SELECT'?'select':el.tagName==='TEXTAREA'?'textarea':el.type,
      value:el.type==='checkbox'?el.checked:el.value,disabled:el.disabled,
      min:el.min || null,max:el.max || null,step:el.step || null,
      options:el.tagName==='SELECT'?[...el.options].map(o=>({label:o.label,value:o.value,disabled:o.disabled})):undefined,
    })));
}
async function exerciseControl(control, detail) {
  const locator=page.locator(control.selector);
  if(!await locator.isVisible())return {...control,status:'hidden-after-route-change'};
  if(!await locator.isEnabled())return {...control,status:'disabled',reason:'Current real runtime/UI state blocks editing.'};
  let desired;
  if(control.type==='checkbox') {desired=!control.value;await locator.setChecked(desired);}
  else if(control.type==='select') {
    const option=control.options.find(o=>!o.disabled&&o.value!==String(control.value)&&o.value!=='') || control.options.find(o=>!o.disabled&&o.value!==String(control.value));
    if(!option)return {...control,status:'single-choice',editable:true};
    desired=option.value;await locator.selectOption(desired);
  }else if(control.type==='range') {
    await locator.focus();await locator.press('Home');await locator.press('ArrowRight');
    if(await locator.inputValue()===String(control.value))await locator.press('ArrowRight');
  }else if(control.type==='number') {
    const minimum=control.min!=null&&Number.isFinite(Number(control.min))?Number(control.min):-Infinity;
    const maximum=control.max!=null&&Number.isFinite(Number(control.max))?Number(control.max):Infinity;
    const step=control.step&&control.step!=='any'?Number(control.step):1;
    const current=control.value===''?(Number.isFinite(minimum)?minimum:0):Number(control.value);
    desired=current+step<=maximum?current+step:current-step>=minimum?current-step:current;
    await locator.fill(String(desired));
  }else {
    const param=detail.parameters.find(p=>`param-${p.name.replace(/[^\w-]/g,'-')}`===control.id);
    desired=param?.json_list?'["piano"]':({text:'This is a short interface test.',instruct:'A warm and calm adult voice.',transcript:'This is a short interface test.',keyscale:'C major',timesignature:'4/4',language:'English',tags:'piano, calm'})[control.key]||'QA interface value';
    if(desired===control.value)desired+=' 2';
    await locator.fill(desired);
  }
  const after=await locator.evaluate(el=>({value:el.type==='checkbox'?el.checked:el.value,valid:el.checkValidity(),validationMessage:el.validationMessage}));
  const changed=String(after.value)!==String(control.value);
  return {...control,after:after.value,valid:after.valid,status:changed&&after.valid?'pass':'fail',validationMessage:after.validationMessage};
}
async function modelAudit(model, route) {
  const record={route,id:model.id,label:model.label,controls:[],status:'running'}; report.models.push(record);
  try {
    await page.locator('#model-picker-trigger').click();
    await page.locator('#model-picker-search').fill(model.id);
    const response=page.waitForResponse(r=>r.url().endsWith(`/api/workbench/models/${encodeURIComponent(model.id)}`)&&r.request().method()==='GET',{timeout:20000});
    await page.locator(`[data-model=${JSON.stringify(model.id)}] .model-row-select`).click();
    const detail=await (await response).json();
    await page.waitForFunction(id=>document.querySelector('#model-picker-label')?.textContent===id,detail.label);
    await page.locator('#parameter-toggle').waitFor({state:'visible'});
    await page.keyboard.press('Escape');
    const tested=new Set();
    // A route selector can redraw controls. Re-scan until every currently visible key was visited.
    for(let round=0;round<3;round++) {
      const controls=(await descriptors()).filter(c=>!tested.has(c.selector));
      if(!controls.length)break;
      for(const control of controls) {tested.add(control.selector);record.controls.push(await exerciseControl(control,detail));}
    }
    if(route==='vc'&&detail.voice_mode!=='rvc'&&detail.profile.accepts_voice_reference!==false) {
      // A saved-library choice hides the temporary audio name. Exercise it with a
      // known local upload, explicitly suppressing the automatic ASR workflow.
      await page.evaluate(()=>localStorage.setItem('audiocpp-reference-auto','false'));
      const automatic=page.locator('#task-inputs .reference-automatic input');
      if(await automatic.isVisible())await automatic.setChecked(false);
      allowUpload=true;
      try {
        const uploaded=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/workbench/uploads'&&r.request().method()==='POST');
        await page.locator('#task-inputs input[type="file"][data-input-key="voice"]').setInputFiles(path.resolve('webui/voice/demo_01_man.wav'));
        const fixture=await (await uploaded).json();
        const entry={model:model.id,...fixture,path:path.resolve('webui/output/workbench-inputs',`${fixture.id}.wav`),source:path.resolve('webui/voice/demo_01_man.wav'),automaticAsrDisabled:true,savedToLibrary:false};
        report.uploads.push(entry);record.uploadFixture=entry;
        await page.locator('#input-vc-reference_name').waitFor({state:'visible'});
        const name=(await descriptors()).find(c=>c.key==='reference_name');
        if(!name)throw Error('Temporary reference name is not visible after fixture upload.');
        const retested={...await exerciseControl(name,detail),coverage:'Temporary upload made this name field visible; no library save.'};
        const prior=record.controls.findIndex(control=>control.selector===name.selector);
        if(prior>=0) {retested.priorAttempts=[record.controls[prior]];record.controls[prior]=retested;}
        else record.controls.push(retested);
      }finally {allowUpload=false;}
    }
    record.visibleAfter=await descriptors();
    record.screenshot=await shot(`${route}-${model.id}-common`);
    await page.locator('#parameter-toggle').click();
    record.expertControls=await page.locator('#expert-controls input, #expert-controls select, #expert-controls textarea').evaluateAll(elements=>elements.filter(el=>el.checkVisibility()).map(el=>({
      id:el.id,type:el.tagName==='SELECT'?'select':el.type||'textarea',value:el.type==='checkbox'?el.checked:el.value,
      label:el.closest('.field-group')?.querySelector('label')?.textContent?.trim(),
      options:el.tagName==='SELECT'?[...el.options].map(o=>({label:o.label,value:o.value})):undefined,
    })));
    record.settingsScreenshot=await shot(`${route}-${model.id}-settings`);
    await page.keyboard.press('Escape');
    record.settingsEscapeClosed=!(await page.locator('#workspace-settings').evaluate(el=>el.matches(':popover-open')));
    record.status=record.controls.some(c=>c.status==='fail')||!record.settingsEscapeClosed?'fail':'pass';
    if(record.status==='fail')report.failures.push({name:`model:${model.id}`,controls:record.controls.filter(c=>c.status==='fail'),settingsEscapeClosed:record.settingsEscapeClosed});
  }catch(error) {record.status='fail';record.error=error.message;report.failures.push({name:`model:${model.id}`,error:error.message});await page.keyboard.press('Escape').catch(()=>{});}
  save(); console.log(`${record.status.toUpperCase()} ${route} ${model.id} controls=${record.controls.length}`);
}
async function referencesAudit() {
  await check('references search, refresh, new editor without saving',async()=>{
    await go('references');const before=await page.locator('.reference-row').count();
    await page.locator('#reference-search').fill('__qa_nonexistent_reference__');
    if(await page.locator('.reference-row').count())throw Error('Nonmatching reference search retained rows.');
    await page.locator('#reference-search').fill('');await page.locator('#refresh-references').click();
    await page.locator('#new-reference').click();await page.locator('#reference-editor textarea[data-input-key="reference_text"]').fill('Interface test; not saved.');
    const automatic=page.locator('#reference-editor .reference-automatic input');const value=await automatic.isChecked();
    await automatic.setChecked(!value);await automatic.setChecked(value);
    const screenshot=await shot('references');return {before,after:await page.locator('.reference-row').count(),screenshot};
  });
}
async function libraryAudit() {
  await check('models search, task/state filters, details and refresh',async()=>{
    await go('models');const search=page.locator('#model-search');await search.fill('__qa_nonexistent_model__');
    if(await page.locator('#model-list [data-model]').count())throw Error('Nonmatching model search retained rows.');
    await search.fill('');const task=page.locator('#model-task-filter'),state=page.locator('#model-state-filter');
    const counts=[];
    for(const value of await task.locator('option').evaluateAll(options=>options.map(o=>o.value))) {await task.selectOption(value);counts.push({task:value,count:await page.locator('#model-list [data-model]').count()});}
    await task.selectOption('');for(const value of ['installed','available','manual','']) {await state.selectOption(value);counts.push({state:value,count:await page.locator('#model-list [data-model]').count()});}
    await page.locator('#refresh-catalog').click();await page.locator('#model-list [data-model]').first().click();
    await page.locator('#model-detail h2').waitFor();const fileDetails=page.locator('#model-detail .details-files');if(await fileDetails.count())await fileDetails.locator('summary').click();
    return {counts,screenshot:await shot('models')};
  });
}
async function settingsAudit() {
  await check('settings palettes, themes, tabs, API code tabs, logs, restore appearance',async()=>{
    await go('settings');const original=await page.evaluate(()=>({theme:localStorage.getItem('audiocpp-workbench-theme'),palette:localStorage.getItem('audiocpp-workbench-palette')}));
    try {
      for(const palette of ['classic','studio']) {await page.locator(`[data-palette-choice="${palette}"]`).click();if(await page.locator('html').getAttribute('data-palette')!==palette)throw Error(`Palette did not apply: ${palette}`);}
      for(const theme of ['light','dark','system']) {await page.locator('#theme-select').selectOption(theme);if(await page.locator('#theme-select').inputValue()!==theme)throw Error(`Theme did not apply: ${theme}`);}
      await shot('settings-appearance');
      await page.locator('[data-settings-tab="runtime"]').click();await page.locator('#refresh-runtime-logs').click();await page.locator('#runtime-health').waitFor();await shot('settings-runtime');
      await page.locator('[data-settings-tab="api"]').click();await page.locator('#api-endpoints .card').first().waitFor();
      const codeTabs=page.locator('#api-endpoints [data-code-lang]');for(let i=0;i<await codeTabs.count();i++)await codeTabs.nth(i).click();
      await shot('settings-api');
    }finally {
      await page.evaluate(value=>{for(const key of ['theme','palette']){const name=`audiocpp-workbench-${key}`;if(value[key]===null)localStorage.removeItem(name);else localStorage.setItem(name,value[key]);}},original);
      await go('settings');
    }
    return {restored:true};
  });
}
async function main() {
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},permissions:[]});page=await context.newPage();
  page.on('pageerror',error=>{report.pageErrors.push(error.message);});
  await page.route('**/api/**',async route=>{
    const request=route.request();if(['GET','HEAD','OPTIONS'].includes(request.method()))return route.continue();
    if(allowUpload&&request.method()==='POST'&&new URL(request.url()).pathname==='/api/workbench/uploads')return route.continue();
    const blocked={method:request.method(),url:request.url()};report.blockedMutations.push(blocked);report.failures.push({name:'unexpected-api-mutation',...blocked});await route.abort('blockedbyclient');
  });
  await go('tts');const catalog=await page.request.get(`${base}/api/workbench/catalog`).then(r=>r.json());
  report.catalog={version:catalog.version,total:catalog.models.length,installed:catalog.models.filter(m=>m.installed).length};
  const actual=await page.locator('.main-nav [data-route]').evaluateAll(elements=>elements.map(el=>({route:el.dataset.route,label:el.textContent.trim()})));
  report.navigation=actual;
  const expected=routes.map(r=>r[0]);if(JSON.stringify(actual.filter(n=>n.route!=='scenarios').map(n=>n.route))!==JSON.stringify(expected))throw Error('Actual sidebar order differs from audit order.');
  for(const [route,label] of routes) {
    console.log(`ROUTE ${route} ${label}`);
    if(['tts','asr','music','design','vc'].includes(route)) {
      await go(route);for(const model of catalog.models.filter(m=>m.installed&&m.task===route))await modelAudit(model,route);
    }else if(route==='references')await referencesAudit();
    else if(route==='tools') {
      await go('tools');const cards=await page.locator('#tool-list .tool-card-title').allTextContents();report.interactions.push({name:'audio-tools-card-order',status:'pass',cards});
      for(const tool of tools) {await go(`tools/${tool}`);for(const model of catalog.models.filter(m=>m.installed&&(tool==='processing'||tool==='separation'?m.task===tool:m.task==='analysis'&&m.model_task===tool)))await modelAudit(model,`tools-${tool}`);}
    }else if(route==='models')await libraryAudit();else if(route==='settings')await settingsAudit();
    save();
  }
  await check('narrow viewport sidebar and model/settings popovers',async()=>{
    await page.setViewportSize({width:390,height:844});await go('tts');await page.locator('#sidebar-toggle').click();await shot('narrow-sidebar');await page.locator('#sidebar-backdrop').click();
    await page.locator('#model-picker-trigger').click();await shot('narrow-model-picker');await page.keyboard.press('Escape');
    if(await page.locator('#model-picker-popover').evaluate(el=>el.matches(':popover-open')))throw Error('Escape did not close narrow model picker.');return {screenshot:await shot('narrow-workspace')};
  });
}
main().catch(error=>{report.failures.push({name:'fatal',error:error.stack});console.error(error.stack);}).finally(async()=>{
  const controls=report.models.flatMap(m=>m.controls),statuses=controls.reduce((counts,control)=>(counts[control.status]=(counts[control.status]||0)+1,counts),{});
  report.finished=new Date().toISOString();report.summary={models:report.models.length,modelPasses:report.models.filter(m=>m.status==='pass').length,
    controls:controls.length,controlStatuses:statuses,actuallyEdited:statuses.pass||0,notChangeableSingleChoice:statuses['single-choice']||0,
    skipped:(statuses['hidden-after-route-change']||0)+(statuses.disabled||0),fixtureUploads:report.uploads.length,
    failures:report.failures.length,pageErrors:report.pageErrors.length,blockedMutations:report.blockedMutations.length};
  save();if(browser)await browser.close();console.log(JSON.stringify(report.summary));process.exitCode=report.failures.length||report.pageErrors.length?1:0;
});
