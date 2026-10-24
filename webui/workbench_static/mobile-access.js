import {t, uiText} from './i18n.js';

export function createMobileAccess({navigate, showToast}) {
  const $ = id => document.getElementById(id);
  let state = null, syncing = false, syncFailed = false, syncTimer, refreshVersion = 0;
  const pendingMessages = new Set();
  const request = async (path = '', body) => {
    const response = await fetch(`/api/workbench/mobile${path}`, body === undefined ? {cache:'no-store'} : {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || t('操作失败，请重试。'));
    return data;
  };
  function address() {
    const ip = $('mobile-address').value;
    const index = state?.addresses.indexOf(ip) ?? -1;
    $('mobile-url').value = state?.urls[index] || '';
    $('mobile-qr').src = `/api/workbench/mobile/qr?address=${encodeURIComponent(ip)}`;
  }
  function render(data) {
    state = data;
    $('mobile-enabled').checked = data.running;
    $('mobile-enabled').disabled = syncing || !data.configured;
    $('mobile-connection').hidden = !data.running;
    uiText($('mobile-state'), data.error || (data.running ? '手机访问已开启' : '手机访问未开启'));
    $('mobile-summary').textContent = data.configured
      ? [data.character, data.models.asr_model, data.models.llm_model, data.models.tts_model].filter(Boolean).join(' · ')
      : t('请先在实时语音中选好模型并保存设置。');
    const previous = $('mobile-address').value;
    $('mobile-address').replaceChildren(...data.addresses.map(ip => new Option(ip, ip)));
    if (data.addresses.includes(previous)) $('mobile-address').value = previous;
    if (data.running) address();
  }
  async function refresh(sync = true) {
    const version = ++refreshVersion;
    try {
      const data = await request();
      if (version !== refreshVersion) return;
      render(data);
      // Existing phone settings survive opening this page from another browser.
      // The realtime page publishes every explicit save; initialize or retry here.
      if (sync && !syncing && (!data.configured || syncFailed)) {
        startSync(); sendToRealtime('audiocpp:mobile-sync');
      }
    } catch (error) { uiText($('mobile-state'), error.message); }
  }
  $('mobile-enabled').addEventListener('change', async () => {
    const enabled = $('mobile-enabled').checked;
    $('mobile-enabled').disabled = true;
    uiText($('mobile-state'), enabled ? '正在开启手机访问…' : '正在关闭手机访问…');
    try { render(await request('', {enabled})); }
    catch (error) { showToast(error.message); await refresh(); }
  });
  $('mobile-address').addEventListener('change', address);
  $('mobile-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('mobile-url').value); showToast(t('地址已复制')); }
    catch { $('mobile-url').select(); showToast(t('请复制选中的地址')); }
  });
  $('mobile-edit').addEventListener('click', () => {
    navigate('realtime');
    sendToRealtime('audiocpp:mobile-edit');
  });
  function sendToRealtime(type) {
    const frame = $('realtime-frame');
    pendingMessages.add(type);
    if (!frame.getAttribute('src')) {
      frame.src = frame.dataset.src;
    } else frame.contentWindow.postMessage({type:'audiocpp:mobile-ping'}, location.origin);
  }
  function startSync() {
    syncing = true; syncFailed = false; clearTimeout(syncTimer); ++refreshVersion;
    $('mobile-enabled').disabled = true;
    uiText($('mobile-config-state'), '正在同步语音配置…');
    syncTimer = setTimeout(() => syncDone(t('同步超时，请重新打开此页面。')), 20000);
  }
  function syncDone(error) {
    syncing = false; syncFailed = !!error; clearTimeout(syncTimer);
    $('mobile-enabled').disabled = !state?.configured;
    const message = error ? t('语音配置同步失败：{message}', {message:error}) : t('已同步，下次手机通话时生效。');
    uiText($('mobile-config-state'), message);
    if (error) showToast(message);
  }
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== $('realtime-frame').contentWindow) return;
    if (event.data?.type === 'audiocpp:realtime-ready') {
      const messages = [...pendingMessages];
      pendingMessages.clear();
      for (const type of messages) event.source.postMessage({type}, location.origin);
    }
    if (event.data?.type === 'audiocpp:mobile-syncing') startSync();
    if (event.data?.type === 'audiocpp:mobile-saved') {
      syncDone(event.data.error);
      void refresh(false);
    }
  });
  return {refresh};
}
