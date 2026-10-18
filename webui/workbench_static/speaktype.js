import {t, uiText, html, getLanguage} from './i18n.js';
export function createSpeakType({root,api,showToast}) {
  let pending=false, visible=false, timer=null, current=null;
  root.innerHTML=html`<header class="page-heading page-topbar"><h1>全局快捷键听写</h1></header>
    <p class="page-description">启动 SpeakType 悬浮条，在其他应用的输入框中用语音输入文字。</p>
    <div class="card speaktype-card">
      <h2>SpeakType</h2>
      <p id="speaktype-status" role="status" aria-live="polite">正在读取配置…</p>
      <div class="field"><label for="speaktype-model">识别模型</label><select id="speaktype-model"></select></div>
      <div class="field"><label for="speaktype-language">识别语言</label><select id="speaktype-language"></select><p id="speaktype-language-help" class="muted small"></p></div>
      <div class="reference-actions"><button id="speaktype-start" class="button primary" disabled>启动听写</button><button id="speaktype-stop" class="button secondary" disabled>退出听写</button><button id="speaktype-refresh" class="button secondary">刷新状态</button></div>
      <p class="muted small">退出听写会取消尚未完成的识别。需要保留最后一句时，请先按听写快捷键停止录音，等文字输入完成再退出。</p>
    </div>
    <div class="card speaktype-card"><h2>使用方式</h2><ol>
      <li>启动后，将光标放到记事本、聊天窗口或编辑器的输入框。</li>
      <li>按 <kbd id="speaktype-toggle">…</kbd> 开始录音，再按一次停止；按 <kbd id="speaktype-cancel">…</kbd> 取消当前片段。</li>
      <li>悬浮条显示识别过程，最终文字会输入原目标窗口。切换窗口后，文字只复制到剪贴板。</li>
      <li>拖动悬浮条顶部可调整位置；点击收起变为小条，听写继续运行，不改变输入焦点。</li>
    </ol><p class="muted small">切换工作台页面不影响听写；退出整个工作台会关闭由它启动的 SpeakType。麦克风、快捷键和悬浮条沿用现有 SpeakType 配置。</p></div>`;
  const $=id=>root.querySelector(`#speaktype-${id}`);
  function controls() {
    const active=!!current?.active;
    $('start').disabled=pending||active||!current?.available||!$('model').value;
    $('stop').disabled=pending||!active;
    $('model').disabled=pending||active;
    $('language').disabled=pending||active||$('language').options.length<2;
    $('refresh').disabled=pending;
    uiText($('start'), pending?'正在处理…':'启动听写');
  }
  function languageName(value) {
    if(String(value).toLowerCase()==='auto')return '自动识别';
    try{return new Intl.DisplayNames([getLanguage()==='en'?'en':'zh-CN'],{type:'language'}).of(value)||value;}catch{return value;}
  }
  function languages(preferred) {
    const model=current?.models.find(m=>m.id===$('model').value), values=model?.languages||[''];
    const selected=preferred??$('language').value;
    const signature=JSON.stringify([model?.id,values,getLanguage()]);
    if($('language').dataset.signature!==signature){
      $('language').replaceChildren(...values.map(value=>new Option(t(value?languageName(value):
        `模型默认${model?.supported_languages?.length===1?' · '+languageName(model.supported_languages[0]):'（自动处理）'}`),value)));
      $('language').dataset.signature=signature;
    }
    $('language').value=values.includes(selected)?selected:(model?.language_default??values[0]);
    uiText($('language-help'), model?.language_fixed?'语言由当前模型或权重决定，无需手动指定。':
      values.some(v=>v.toLowerCase()==='auto')?'仅列出当前模型支持的语言，可自动识别。':'此模型需要明确的识别语言，请选择实际说话的语言。');
    controls();
  }
  function render(data) {
    const selected=(data.active&&data.model)||$('model').value||data.model||data.default_model;
    const signature=JSON.stringify(data.models);
    if($('model').dataset.signature!==signature){
      $('model').replaceChildren(...data.models.map(m=>new Option(m.label,m.id)));
      $('model').dataset.signature=signature;
    }
    if(data.models.some(m=>m.id===selected))$('model').value=selected;
    const preferred=!current||data.active?data.language:undefined;
    current=data;
    languages(preferred);
    uiText($('status'), !data.available?'需要 Windows 和完整的 SpeakType 运行文件。':!data.models.length?'没有已安装的流式识别模型，请先到模型中心安装。':data.message);
    uiText($('toggle'), data.toggle_hotkey);
    uiText($('cancel'), data.cancel_hotkey);
    controls();
  }
  async function refresh() {
    clearTimeout(timer);
    try {render(await api('/speaktype'));}
    catch(error){uiText($('status'), error.message);}
    finally {if(visible)timer=setTimeout(refresh,2000);}
  }
  async function action(name) {
    pending=true;controls();clearTimeout(timer);
    uiText($('status'), name==='start'?'正在准备识别模型并启动悬浮条…':'正在退出听写…');
    try {render(await api(`/speaktype/${name}`,{method:'POST',body:name==='start'?{model:$('model').value,language:$('language').value,ui_language:getLanguage()}:{}}));}
    catch(error){uiText($('status'), error.message);showToast(error.message);}
    finally {pending=false;controls();if(visible)timer=setTimeout(refresh,4000);}
  }
  $('start').addEventListener('click',()=>action('start'));
  $('stop').addEventListener('click',()=>action('stop'));
  $('refresh').addEventListener('click',refresh);
  $('model').addEventListener('change',()=>languages());
  window.addEventListener('audiocpp:language',()=>{if(current)languages($('language').value);});
  return {open(){visible=true;return refresh();},hide(){visible=false;clearTimeout(timer);}};
}
