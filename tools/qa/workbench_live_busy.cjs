/* Observe another real job. Never submits, loads, unloads, cancels, or changes files. */
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require('C:/Users/KIN/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const base=process.env.WORKBENCH_URL||'http://127.0.0.1:7860',output=path.resolve('build/functional-qa-20261008/busy-ui');fs.mkdirSync(output,{recursive:true});
const report={started:new Date().toISOString(),method:'Read-only real Chrome observation of root-owned live API jobs. All API mutations blocked. No fixture jobs or responses.',checks:[],attempts:[],screenshots:[],blockedMutations:[],pageErrors:[],limitations:['This separate browser observes API-owned jobs; result preservation for a browser-submitted job is covered by live_execute navigation assertions.']};
const deadline=Date.now()+Number(process.env.BUSY_UI_TIMEOUT_MS||300000),routes=['tts','asr','music','design','vc','tools/processing','tools/separation','tools/vad','tools/diar','tools/turn','tools/align','tools/midi'];let browser,page;
const save=()=>fs.writeFileSync(path.join(output,'busy-ui.json'),JSON.stringify(report,null,2));
const get=async()=>{const response=await page.request.get(`${base}/api/workbench/status`);if(!response.ok())throw Error(`Status ${response.status()}`);return response.json();};
const key=status=>status.job?.id||status.job?.job_id||JSON.stringify(status.job);
function check(ok,name,details){report.checks.push({name,status:ok===null?'not_applicable':ok?'pass':'fail',details});save();}
async function waitBusy(){while(Date.now()<deadline){const status=await get();if(status.busy&&status.job)return status;await page.waitForTimeout(500);}throw Error('No sufficiently long real job observed before deadline.');}
async function navigate(route){if(route.startsWith('tools/')){await page.locator('[data-route="tools"]').click();await page.locator('#tool-list .tool-card').nth(['processing','separation','vad','diar','turn','align','midi'].indexOf(route.split('/')[1])).click();}else await page.locator(`[data-route="${route}"]`).click();}
async function screenshot(name){const file=path.join(output,`${name}.png`);await page.screenshot({path:file,fullPage:true});report.screenshots.push(file);save();}
async function sampleRoute(route){
  while(Date.now()<deadline){
    const before=await waitBusy();await navigate(route);await page.locator('#model-picker-trigger').click();
    const rows=page.locator('#model-picker-list .model-row');let candidate=null;
    if(await rows.count()){
      const activeModel=before.server?.model||before.asr?.model;
      const active=page.locator(`#model-picker-list [data-model=${JSON.stringify(activeModel)}] .model-row-select`);
      const button=await active.count()?active:rows.first().locator('.model-row-select');candidate=await button.evaluate(el=>el.closest('[data-model]').dataset.model);
      const selected=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/workbench/models/${encodeURIComponent(candidate)}`);await button.click();await selected;
    }
    await page.keyboard.press('Escape');await page.waitForTimeout(150);
    await page.locator('#model-picker-trigger').click();const loads=await page.locator('#model-picker-list [data-load-model]').evaluateAll(elements=>elements.map(el=>({model:el.dataset.loadModel,disabled:el.disabled,title:el.title})));
    await page.keyboard.press('Escape');
    const controls=await page.locator('#run-button,#workspace-load,#apply-model-settings').evaluateAll(elements=>elements.map(el=>({id:el.id,text:el.textContent,disabled:el.disabled,hidden:el.hidden})));
    const result=await page.locator('#result-content').evaluate(el=>({text:el.querySelector('.result-text')?.value||'',audio:[...el.querySelectorAll('audio')].map(audio=>audio.src),downloads:[...el.querySelectorAll('a[download]')].map(link=>link.href)}));
    const after=await get(),stable=before.busy&&after.busy&&key(before)===key(after);report.attempts.push({route,before,after,stable,candidate,controls,loads,result});save();
    if(!stable)continue;
    check(controls.every(control=>control.disabled),`${route}: Generate, load and apply/reload disabled during the same real job`,{job:after.job,controls});
    check(loads.length?loads.every(control=>control.disabled):null,`${route}: every model row load action disabled`,{count:loads.length,job:after.job,note:loads.length?undefined:'No installed model rows are available; no load button was tested.'});
    check(!result.text&&!result.audio.length&&!result.downloads.length,`${route}: another menu does not display the external job result`,result);
    await screenshot(route.replace('/','-'));return;
  }
  throw Error(`No stable busy sample for ${route}`);
}
async function sampleUnload(){while(Date.now()<deadline){const before=await waitBusy();await page.locator('[data-route="settings"]').click();await page.locator('[data-settings-tab="runtime"]').click();await page.locator('#refresh-runtime-logs').click();await page.waitForTimeout(100);const controls=await page.locator('#unload-model,#unload-all-models').evaluateAll(elements=>elements.map(el=>({id:el.id,disabled:el.disabled})));const after=await get();if(!after.busy||key(before)!==key(after)){report.attempts.push({route:'settings/runtime',stable:false,before,after});continue;}check(controls.length===2&&controls.every(control=>control.disabled),'both Unload actions are disabled during the same real job',{job:after.job,controls});await screenshot('settings-runtime-busy');return;}throw Error('No stable busy sample for unload controls.');}
async function main(){
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);page.on('pageerror',error=>report.pageErrors.push(error.message));
  await page.route('**/api/**',async route=>{const request=route.request();if(['GET','HEAD','OPTIONS'].includes(request.method()))return route.continue();report.blockedMutations.push({method:request.method(),url:request.url()});save();return route.abort('blockedbyclient');});
  await page.goto(`${base}/#tts`,{waitUntil:'domcontentloaded'});await page.locator('#connection-status[data-state="online"]').waitFor();
  for(const route of routes)await sampleRoute(route);await sampleUnload();
  check(report.blockedMutations.length===0,'busy UI observation attempted no mutation',report.blockedMutations);
}
main().catch(error=>{report.error=error.stack;console.error(error.stack);}).finally(async()=>{report.finished=new Date().toISOString();report.status=report.error?'incomplete':report.checks.some(row=>row.status==='fail')||report.pageErrors.length||report.blockedMutations.length?'fail':'pass';save();if(browser)await browser.close();console.log(JSON.stringify({status:report.status,checks:report.checks.length,report:path.join(output,'busy-ui.json')}));process.exitCode=report.status==='pass'?0:1;});
