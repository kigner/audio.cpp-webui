import { attachLipSync } from './audio-bridge.js';
const illustration = document.documentElement.dataset.character === 'illustration';
const {createCharacter} = await import(illustration ? '../companion/character.js' : './character.js');

const $ = id => document.getElementById(id);
const API = '/api/workbench';
let character, context, player, bridge, model, meta, currentRate = 0;
let lastAudio, busy = false, stopped = false, disposed = false;
let playbackEpoch = 0, modelEpoch = 0, playerReady;
let playbackState = 'idle', playedSamples = 0;
export function previewStats() {
  return { ...character?.stats(), playbackState, playedSamples, audioRate: currentRate, activeViseme: $('viseme').textContent, busy, stopped };
}
const report = (text, error = false) => { $('status').textContent = text; $('status').dataset.error = String(error); };
async function api(path, body) {
  const response = await fetch(API + path, body === undefined ? {} : {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail || `本地服务返回 ${response.status}`);
  return result;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function stopPlayback() {
  playbackEpoch++;
  stopped = true;
  playbackState = 'clear';
  player?.port.postMessage({kind: 'clear'});
  bridge?.clear();
  $('stop').disabled = true;
}
async function preparePlayer(rate) {
  if (!playerReady || context.state === 'closed') {
    context = new AudioContext({latencyHint: 'interactive'});
    const initializingContext = context;
    playerReady = (async () => {
      await context.audioWorklet.addModule(new URL('../worklets/audio-playback.js', import.meta.url));
      player = new AudioWorkletNode(context, 'audio-playback', {numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1]});
      const output = context.createAnalyser();
      player.connect(output); output.connect(context.destination);
      bridge = await attachLipSync(context, player, output, character, {
        delayMs: Number($('lip-delay').value), onViseme: key => { $('viseme').textContent = `嘴型 ${key}`; }
      });
      player.port.onmessage = ({data}) => {
        if (data.kind === 'stats') playedSamples = data.played;
        else playbackState = data.kind;
        if (data.kind === 'started') { character.setSpeaking(true); $('stop').disabled = false; }
        if (['drained', 'underrun'].includes(data.kind)) {
          bridge.clear(); $('viseme').textContent = data.kind === 'drained' ? '播放结束' : '等待音频';
          if (data.kind === 'drained') { $('stop').disabled = true; if (!busy) report('播放结束，可重播比较。'); }
        }
      };
    })().catch(async error => {
      if (context === initializingContext) {
        bridge?.dispose(); bridge = null; player = null; playerReady = null;
      }
      await initializingContext.close().catch(() => {});
      throw error;
    });
  }
  await playerReady;
  if (disposed) throw new Error('预览已经关闭。');
  await context.resume();
  currentRate = rate;
  player.port.postMessage({kind: 'config', inputRate: rate, startBufferMs: 800, resumeBufferMs: 1000});
}
function queue(samples) {
  if (stopped) return;
  player.port.postMessage({kind: 'audio', samples}, [samples.buffer]);
}
async function playBuffer(bytes) {
  stopPlayback();
  const turn = playbackEpoch;
  await preparePlayer(16000);
  if (turn !== playbackEpoch || disposed) return;
  const audio = await context.decodeAudioData(bytes.slice(0));
  if (turn !== playbackEpoch || disposed) return;
  await preparePlayer(audio.sampleRate);
  if (turn !== playbackEpoch || disposed) return;
  const mono = new Float32Array(audio.length);
  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    const data = audio.getChannelData(channel);
    for (let i = 0; i < mono.length; i++) mono[i] += data[i] / audio.numberOfChannels;
  }
  stopped = false;
  player.port.postMessage({kind: 'begin', responseId: 'preview'});
  queue(mono);
  player.port.postMessage({kind: 'end'});
  report('正在播放真实 TTS 音频…');
}
async function refreshModel() {
  const turn = ++modelEpoch;
  $('generate').disabled = true;
  model = $('tts-model').value;
  const [detail, config] = await Promise.all([api(`/models/${encodeURIComponent(model)}`), fetch('/api/realtime/config').then(r => r.json())]);
  if (turn !== modelEpoch || disposed) return;
  meta = config.tts_models?.find(item => item.id === model) || detail;
  if ($('reference-field')) $('reference-field').hidden = !meta.accepts_voice_reference;
  const voices = meta.voices || [];
  $('voice-field').hidden = voices.length === 0;
  $('tts-voice').replaceChildren(...voices.map(voice => new Option(voice.label || voice.value, voice.value)));
  $('generate').disabled = false;
  report('已就绪。点击生成并播放，测试当前本地声音。');
}
async function generate() {
  if (busy) return;
  const text = $('test-text').value.trim();
  if (!text) return report('请输入测试文本。', true);
  stopPlayback();
  busy = true; $('generate').disabled = true; $('tts-model').disabled = true; $('replay').disabled = true;
  try {
    const status = await api('/status');
    if (status.busy || status.realtime_active) throw new Error('当前模型正在使用，请结束任务或通话后再测试。');
    await preparePlayer(16000);
    const options = {};
    const voice = $('tts-voice').value;
    if (voice && meta.voice_parameter) options[meta.voice_parameter] = meta.voice_value_type === 'number' ? Number(voice) : voice;
    const detail = await api(`/models/${encodeURIComponent(model)}`);
    const {id} = await api('/jobs', {task: 'tts', model, inputs: {
      text, language: 'Chinese', stream: !!detail.streaming,
      builtin_voice: meta.accepts_voice_reference ? ($('reference-voice')?.value || '(none)') : '(none)', seed: 1234, max_tokens: 1200
    }, options});
    stopped = false;
    player.port.postMessage({kind: 'begin', responseId: id});
    $('stop').disabled = false;
    let after = 0, received = false;
    for (;;) {
      const job = await api(`/jobs/${id}?after=${after}`);
      if (disposed) return;
      report(stopped ? '已停止播放，等待本地合成完成…' : (job.message || '声音合成中…'));
      for (const part of job.audio_segments || []) {
        if (part.index <= after) continue;
        after = part.index;
        if (stopped) continue;
        if (currentRate !== part.sample_rate) await preparePlayer(part.sample_rate);
        const bytes = Uint8Array.from(atob(part.pcm), char => char.charCodeAt(0));
        const pcm = new DataView(bytes.buffer);
        const samples = new Float32Array(bytes.length / 2);
        for (let i = 0; i < samples.length; i++) samples[i] = pcm.getInt16(i * 2, true) / 32768;
        queue(samples); received = true;
      }
      if (['done', 'error', 'cancelled'].includes(job.status)) {
        if (job.status !== 'done') throw new Error(job.message || '声音生成失败。');
        const artifact = job.artifacts?.find(item => item.kind === 'audio');
        if (!artifact) throw new Error('模型没有返回音频。');
        const response = await fetch(artifact.url);
        if (!response.ok) throw new Error('无法读取生成音频。');
        lastAudio = await response.arrayBuffer();
        $('replay').disabled = false;
        if (!stopped) {
          if (received) player.port.postMessage({kind: 'end'});
          else await playBuffer(lastAudio);
          report(`中文音频已生成 · ${model}`);
        } else report('音频已生成，可点击重播。');
        break;
      }
      await sleep(400);
    }
  } catch (error) { stopPlayback(); report(error.message, true); }
  finally { busy = false; $('generate').disabled = false; $('tts-model').disabled = false; }
}

$('generate').addEventListener('click', generate);
$('stop').addEventListener('click', () => { stopPlayback(); report('已停止播放。'); });
$('replay').addEventListener('click', () => playBuffer(lastAudio).catch(error => report(error.message, true)));
$('natural-motion').addEventListener('change', () => character?.setMotionEnabled($('natural-motion').checked));
$('listen-mode')?.addEventListener('change', () => character?.setListening?.($('listen-mode').checked));
$('lip-delay').addEventListener('input', () => { const ms = Number($('lip-delay').value); $('delay-value').value = `${ms} ms`; bridge?.setDelay(ms); });
$('tts-model').addEventListener('change', () => refreshModel().catch(error => report(error.message, true)));
$('audio-file').addEventListener('change', async () => {
  const file = $('audio-file').files[0]; if (!file || busy) return;
  try { lastAudio = await file.arrayBuffer(); await playBuffer(lastAudio); $('replay').disabled = false; }
  catch (error) { report(error.message, true); }
});
const metrics = setInterval(() => { if (character) $('fps').textContent = `${Math.round(character.stats().fps || 0)} FPS`; }, 1000);
window.addEventListener('pagehide', () => {
  disposed = true; clearInterval(metrics); stopPlayback(); bridge?.dispose(); character?.dispose(); void context?.close();
}, {once: true});
try {
  character = await createCharacter($('character'));
  if (disposed) { character.dispose(); throw new Error('预览已经关闭。'); }
  $('character-status').textContent = illustration ? '暖灯夜话' : '半身人物 · 实时嘴型';
  const catalog = await api('/catalog');
  const models = catalog.models.filter(item => item.installed && item.task === 'tts');
  if (!models.length) throw new Error('未找到已安装的 TTS 模型。可以先使用已有音频查看效果。');
  $('tts-model').replaceChildren(...models.map(item => new Option(item.label, item.id)));
  const currentModel = catalog.server?.model;
  const preferredModel = models.some(item => item.id === currentModel) ? currentModel : 'voxcpm1';
  if (models.some(item => item.id === preferredModel)) $('tts-model').value = preferredModel;
  $('tts-model').disabled = false;
  await refreshModel();
} catch (error) {
  if (!character) $('character-status').textContent = `人物加载失败：${error.message}`;
  report(error.message, true);
}
