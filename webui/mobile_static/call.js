import {S2sWsRealtimeClient} from './ws/s2s-ws-client.js';
import {mountLiveCharacter} from './companion/live.js';
import {normalizeAnimation, CHARACTER_DEFAULTS} from './companion/profile.js';

const $ = id => document.getElementById(id);
let active = null;
let info = null;
let muted = false;
let character = null;
let characterKey = '';
let controlsTimer, statusTimer, noticeTimer;
const statusText = {connecting:'正在准备通话…', connected:'正在聆听', 'user-speaking':'正在聆听', processing:'正在思考…', 'ai-speaking':'正在回答…'};

async function loadInfo() {
  const response = await fetch('/info', {cache:'no-store'});
  if (!response.ok) throw new Error('连接已失效，请在电脑上重新扫描二维码。');
  info = await response.json();
  $('character').textContent = info.character.name;
  const profile = {...info.character, animation:normalizeAnimation(info.character.animation)};
  if (!Object.hasOwn(CHARACTER_DEFAULTS, profile.id)) profile.id = 'companion';
  const key = JSON.stringify(profile);
  if (key !== characterKey) {
    try {
      if (character) await character.setCharacter(profile);
      else character = await mountLiveCharacter(profile, {framing:'mobile'});
      characterKey = key;
    } catch {
      showError('人物画面未能加载，请刷新页面重试。');
    }
  }
}

// Read-only diagnostics, also used by the browser regression.
export function mobileCharacterStats() { return character?.stats(); }

function setStatus(message, duration = 2400) {
  clearTimeout(statusTimer);
  $('status').textContent = message;
  $('status').dataset.faded = 'false';
  if (duration) statusTimer = setTimeout(() => { $('status').dataset.faded = 'true'; }, duration);
}

function setControlsVisible(visible) {
  document.body.classList.toggle('ui-hidden', !visible);
  for (const element of document.querySelectorAll('.chrome')) element.inert = !visible;
}

function showControls() {
  clearTimeout(controlsTimer);
  setControlsVisible(true);
  if (active?.connected) controlsTimer = setTimeout(() => {
    if (!$('help-dialog').open && !document.querySelector('.chrome :focus-visible')) setControlsVisible(false);
  }, 3500);
}

function showError(message) {
  clearTimeout(noticeTimer);
  $('error').textContent = message;
  $('notice').hidden = !message;
  if (message) {
    showControls();
    noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 10000);
  }
}

async function release(call) {
  call.stream?.getTracks().forEach(track => track.stop());
  await call.client?.close().catch(() => {});
  if (call.context && call.context.state !== 'closed') await call.context.close().catch(() => {});
}

function stop(message = '通话已结束') {
  const previous = active;
  active = null;
  if (previous) void release(previous);
  document.body.dataset.active = 'false';
  document.body.dataset.muted = 'false';
  muted = false;
  $('muted-indicator').hidden = true;
  $('mute').setAttribute('aria-pressed','false');
  $('mute').setAttribute('aria-label','静音');
  $('mute').querySelector('span').textContent = '静音';
  $('start').hidden = false;
  $('start').disabled = false;
  $('mute').hidden = $('end').hidden = true;
  setStatus(message);
  showControls();
}

$('start').addEventListener('click', async () => {
  if (active) return;
  showError('');
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    showError('浏览器未开放麦克风。请用 Safari 打开电脑显示的 HTTPS 地址，并确认已继续访问该网站。');
    return;
  }
  const call = {};
  active = call;
  $('start').hidden = true;
  $('end').hidden = false;
  showControls();
  setStatus('请允许麦克风访问…', 0);
  try {
    // Both operations begin directly in the tap gesture for iOS audio policy.
    const Context = window.AudioContext || window.webkitAudioContext;
    call.context = new Context({latencyHint:'interactive'});
    const resumed = call.context.resume();
    const microphone = navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true}, video:false});
    // Consume a rejected resume immediately while microphone permission is pending.
    void resumed.catch(() => {});
    call.stream = await microphone;
    if (active !== call) return;
    await resumed;
    await loadInfo();
    if (active !== call) return;
    call.client = new S2sWsRealtimeClient({
      directUrl:`wss://${location.host}/v1/realtime`, micStream:call.stream, audioContext:call.context,
      appConfig:{tts_playback_mode:info.playback_mode},
      noiseGate:{enabled:info.noise_gate > -66, thresholdDb:info.noise_gate},
    });
    character?.attachClient(call.client);
    call.client.addEventListener('status', event => {
      if (active !== call) return;
      const status = event.detail.status;
      if (status === 'closed' || status === 'error') {
        stop('连接已断开');
        showError('请确认电脑仍在运行、手机与电脑连接同一网络，然后重新开始通话。');
      } else setStatus(muted ? '麦克风已静音' : statusText[status] || '通话中', status === 'connecting' ? 0 : 1800);
    });
    call.client.addEventListener('server-error', () => {
      if (active !== call) return;
      stop('通话未能继续');
      showError('请在电脑上检查实时语音配置，并结束正在运行的其他任务后重试。');
    });
    await call.client.connect();
    if (active !== call) return;
    document.body.dataset.active = 'true';
    call.connected = true;
    $('mute').hidden = false;
    showControls();
    if (!sessionStorage.getItem('aixora.mobile.controls-hint')) {
      setStatus('轻点画面可显示或隐藏通话按钮', 3200);
      sessionStorage.setItem('aixora.mobile.controls-hint', '1');
    }
  } catch (error) {
    if (active !== call) return;
    stop('尚未开始通话');
    showError(error.name === 'NotAllowedError'
      ? '麦克风未获允许。请在 Safari 的网站设置中允许麦克风，再点击“开始通话”。'
      : error.name === 'NotFoundError' ? '没有找到麦克风，请检查设备后重试。'
      : '无法开始通话。请检查电脑上的语音配置和网络连接，再试一次。');
  } finally {
    if (active !== call) await release(call);
  }
});
$('end').addEventListener('click', () => stop());
$('mute').addEventListener('click', () => {
  if (!active?.client) return;
  muted = !muted;
  active.client.setMuted(muted);
  $('mute').setAttribute('aria-pressed',String(muted));
  $('mute').querySelector('span').textContent = muted ? '取消静音' : '静音';
  $('mute').setAttribute('aria-label', muted ? '取消静音' : '静音');
  $('muted-indicator').hidden = !muted;
  document.body.dataset.muted = String(muted);
  setStatus(muted ? '麦克风已静音' : '正在聆听');
  showControls();
});
$('reveal').addEventListener('click', () => {
  if (active?.connected && !document.body.classList.contains('ui-hidden')) {
    clearTimeout(controlsTimer);
    setControlsVisible(false);
  } else showControls();
});
document.addEventListener('keydown', event => { if (event.key === 'Escape' || event.key === 'Tab') showControls(); });
$('dismiss-notice').addEventListener('click', () => showError(''));
$('help').addEventListener('click', () => { showControls(); $('help-dialog').showModal(); });
$('close-help').addEventListener('click', () => $('help-dialog').close());
$('help-dialog').addEventListener('close', showControls);
const standalone = () => navigator.standalone || matchMedia('(display-mode: standalone)').matches;
function updateFullscreen() {
  const full = document.fullscreenElement || document.webkitFullscreenElement;
  $('fullscreen').hidden = Boolean(standalone());
  $('fullscreen').setAttribute('aria-label', full ? '退出全屏' : '全屏');
  $('fullscreen').title = full ? '退出全屏' : '全屏';
  showControls();
}
$('fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      const request = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
      if (!request) { $('help-dialog').showModal(); return; }
      await request.call(document.documentElement);
    }
  } catch { $('help-dialog').showModal(); }
  updateFullscreen();
});
document.addEventListener('fullscreenchange', updateFullscreen);
document.addEventListener('webkitfullscreenchange', updateFullscreen);
updateFullscreen();
window.addEventListener('character-error', () => showError('人物动画暂时不可用，请在通话结束后刷新页面。'));
window.addEventListener('pagehide', () => stop());
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && active) stop('已离开通话页面，点击可重新开始');
});
loadInfo().then(() => {
  setStatus('准备好就开始吧');
  $('start').disabled = false;
}).catch(error => { setStatus('无法连接电脑'); showError(error.message); });
