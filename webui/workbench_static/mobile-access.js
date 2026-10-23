import {t, uiText} from './i18n.js';

export function createMobileAccess({navigate, showToast}) {
  const $ = id => document.getElementById(id);
  let state = null;
  let saving = false;
  let saveTimer;
  let pendingMessages = [];
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
    $('mobile-enabled').disabled = !data.configured;
    $('mobile-connection').hidden = !data.running;
    uiText($('mobile-state'), data.error || (data.running ? '手机访问已开启' : '手机访问未开启'));
    $('mobile-summary').textContent = data.configured
      ? [data.character, data.models.asr_model, data.models.llm_model, data.models.tts_model].filter(Boolean).join(' · ')
      : t('请先保存电脑当前的实时语音配置。');
    const previous = $('mobile-address').value;
    $('mobile-address').replaceChildren(...data.addresses.map(ip => new Option(ip, ip)));
    if (data.addresses.includes(previous)) $('mobile-address').value = previous;
    if (data.running) address();
  }
  async function refresh() {
    try { render(await request()); } catch (error) { uiText($('mobile-state'), error.message); }
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
    pendingMessages.push(type);
    if (!frame.getAttribute('src')) {
      frame.src = frame.dataset.src;
    } else frame.contentWindow.postMessage({type:'audiocpp:mobile-ping'}, location.origin);
  }
  function saveDone(message) {
    saving = false;
    clearTimeout(saveTimer);
    $('mobile-save').disabled = false;
    showToast(t(message));
  }
  $('mobile-save').addEventListener('click', () => {
    if (saving) return;
    saving = true;
    $('mobile-save').disabled = true;
    saveTimer = setTimeout(() => saveDone('保存超时，请打开实时语音后重试。'), 20000);
    sendToRealtime('audiocpp:mobile-save');
  });
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== $('realtime-frame').contentWindow) return;
    if (event.data?.type === 'audiocpp:realtime-ready') {
      const messages = pendingMessages;
      pendingMessages = [];
      for (const type of messages) event.source.postMessage({type}, location.origin);
    }
    if (event.data?.type === 'audiocpp:mobile-saved') {
      saveDone(event.data.error || '已保存，下次手机通话时生效。');
      void refresh();
    }
  });
  return {refresh};
}
