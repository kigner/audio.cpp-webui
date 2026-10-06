// Presentation controls only; speech, sessions and transcript handling stay in main.js.
const byId = id => document.getElementById(id);
const dialog = byId('settings-modal');
const settingsButton = byId('settings-btn');
const embedded = window.parent !== window;
const KEY = 'audiocpp-scene-appearance';
function readAppearance() {
  try { return {scene:'window',captions:true,...JSON.parse(localStorage.getItem(KEY)||'{}')}; }
  catch { return {scene:'window',captions:true}; }
}
let appearance = readAppearance();
function applyAppearance() {
  if(!['window','quiet'].includes(appearance.scene))appearance.scene='window';
  document.body.dataset.scene = appearance.scene;
  document.body.classList.toggle('captions-hidden',!appearance.captions);
  byId('scene-location').textContent=appearance.scene==='window'?'窗边 · 日间':'静谧 · 无人物';
  byId('scene-captions').checked=!!appearance.captions;
  document.querySelectorAll('[data-scene-choice]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.sceneChoice===appearance.scene)));
}
applyAppearance();
document.querySelectorAll('[data-scene-choice]').forEach(button=>button.addEventListener('click',()=>{appearance.scene=button.dataset.sceneChoice;applyAppearance();}));
byId('scene-captions').addEventListener('change',event=>{appearance.captions=event.target.checked;applyAppearance();});
dialog.addEventListener('close',()=>{
  if(dialog.returnValue==='save'){try{localStorage.setItem(KEY,JSON.stringify(appearance));}catch{}}
  else {appearance=readAppearance();applyAppearance();}
});

const guide=document.querySelector('.setup-guide');
guide.dataset.settingsPanel='connection';
dialog.querySelector('.tab-panels').prepend(guide);
for(const panel of ['asr','llm','tts'])byId(`settings-${panel}`).dataset.settingsPanel=panel;
const advanced=document.querySelector('.advanced-settings');
advanced.dataset.settingsPanel='connection';
advanced.open=true;
const tabs=[...document.querySelectorAll('[data-settings-tab]')];
function selectSettingsTab(name) {
  tabs.forEach(tab=>{const selected=tab.dataset.settingsTab===name;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;});
  dialog.querySelectorAll('[data-settings-panel]').forEach(panel=>{panel.hidden=panel.dataset.settingsPanel!==name;});
  dialog.querySelector('.tab-panels').scrollTop=0;
}
tabs.forEach(tab=>tab.addEventListener('click',()=>selectSettingsTab(tab.dataset.settingsTab)));
document.querySelector('.scene-settings-tabs').addEventListener('keydown',event=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  const current=tabs.indexOf(document.activeElement);if(current<0)return;
  const index=event.key==='Home'?0:event.key==='End'?tabs.length-1:(current+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
  event.preventDefault();selectSettingsTab(tabs[index].dataset.settingsTab);tabs[index].focus();
});
selectSettingsTab('llm');
settingsButton.addEventListener('click',()=>{dialog.returnValue='';appearance=readAppearance();applyAppearance();});
byId('scene-picker').addEventListener('click',()=>{settingsButton.click();selectSettingsTab('scene');});
document.querySelectorAll('[data-setup]').forEach(button=>button.addEventListener('click',()=>selectSettingsTab(button.dataset.setup.replace('settings-',''))));

// Keep overlays outside the transformed control dock, so they anchor to the scene.
document.body.append(byId('bubble-stack'),byId('realtime-notice'));
const more = byId('call-more');
byId('call-more-menu').append(...document.querySelector('.topbar-right').children);
document.querySelector('.topbar-right').remove();
more.querySelectorAll('button').forEach(button => button.addEventListener('click', () => { more.open = false; }));
document.addEventListener('pointerdown', event => { if (!more.contains(event.target)) more.open = false; });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && more.open) { more.open = false; more.querySelector('summary').focus(); }
});
const dock = document.querySelector('.call-controls');
const updateDockSize = () => document.body.style.setProperty('--dock-height', `${dock.getBoundingClientRect().height}px`);
new ResizeObserver(updateDockSize).observe(dock);
updateDockSize();
byId('chat-panel').inert=true;
byId('chat-btn').setAttribute('aria-expanded','false');
byId('chat-btn').setAttribute('aria-controls','chat-panel');
byId('scene-back').addEventListener('click',()=>{
  if(embedded)window.parent.postMessage({type:'audiocpp:back'},location.origin);
  else location.href='/';
});
byId('scene-fullscreen').addEventListener('click',async()=>{
  try {
    const doc=embedded?window.parent.document:document;
    if(doc.fullscreenElement)await doc.exitFullscreen();
    else await doc.documentElement.requestFullscreen();
  } catch {
    byId('scene-fullscreen').title='浏览器未允许全屏，可使用 F11；聊天画面已经铺满页面。';
    byId('scene-fullscreen').setAttribute('aria-label','浏览器未允许全屏，可使用 F11');
  }
});
const fullscreenDocument=embedded?window.parent.document:document;
fullscreenDocument.addEventListener('fullscreenchange',()=>{
  const active=!!fullscreenDocument.fullscreenElement;
  byId('scene-fullscreen').querySelector('span').textContent=active?'退出全屏':'全屏';
  byId('scene-fullscreen').setAttribute('aria-label',active?'退出全屏':'全屏聊天');
});
function showConnection(online) {
  byId('scene-connection').hidden = online;
  byId('scene-connection').dataset.state=online?'online':'offline';
  byId('scene-connection').textContent=online?'本地服务在线':'本地服务断开';
}
window.addEventListener('message',event=>{
  if(event.origin!==location.origin||event.source!==window.parent)return;
  if(event.data?.type==='audiocpp:connection')showConnection(event.data.online===true);
});
// The initial config request tests the same origin, without activating a model or microphone.
(async()=>{
  for(const url of ['../api/realtime/config','../config']){
    try { const response=await fetch(url,{cache:'no-store'}); if(response.ok){showConnection(true);return;} } catch {}
  }
  showConnection(false);
})();
