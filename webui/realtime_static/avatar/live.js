import { attachLipSync } from './audio-bridge.js';

export async function mountLiveAvatar({illustration = false} = {}) {
  const {createCharacter} = await import(illustration ? '../companion/character.js' : './character.js');
  const style = document.createElement('link');
  style.rel = 'stylesheet'; style.href = new URL('./live.css', import.meta.url).href;
  document.head.append(style);
  const stage = document.createElement('div'); stage.id = 'live-avatar-stage';
  stage.setAttribute('aria-label', illustration ? '暖灯卧室人物预览' : '写实半身人物预览');
  const notice = document.createElement('p'); notice.id = 'live-avatar-notice'; notice.textContent = '正在加载人物…';
  document.body.prepend(stage); document.body.append(notice);
  const character = await createCharacter(stage);
  document.body.classList.add('avatar-preview');
  notice.textContent = '人物预览 · 口型跟随播放声音';
  let bridge, activeClient, epoch = 0;
  window.addEventListener('pagehide', () => { epoch++; bridge?.dispose(); character.dispose(); }, {once: true});
  return {
    attachClient(client) {
      activeClient = client;
      client.addEventListener('audio-output', async ({detail}) => {
        if (activeClient !== client) return;
        const turn = ++epoch;
        bridge?.dispose();
        try {
          const next = await attachLipSync(detail.context, detail.source, detail.output, character);
          if (turn !== epoch || activeClient !== client) { next.dispose(); return; }
          bridge = next;
          notice.textContent = '人物预览 · 口型跟随播放声音';
        } catch (error) { if (turn === epoch && activeClient === client) notice.textContent = `口型连接失败：${error.message}`; }
      });
      client.addEventListener('playback-state', ({detail}) => {
        if (activeClient !== client) return;
        if (['clear', 'drained', 'underrun'].includes(detail?.kind)) bridge?.clear();
        if (detail?.kind === 'started') character.setSpeaking(true);
      });
      client.addEventListener('audio-output-closed', () => {
        if (activeClient !== client) return;
        epoch++; bridge?.dispose(); bridge = null; character.resetMouth(); character.setSpeaking(false);
      });
    }
  };
}
