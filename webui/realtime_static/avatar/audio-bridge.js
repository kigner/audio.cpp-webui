import { HeadAudio } from './vendor/headaudio/modules/headaudio.mjs';

// Tap the samples that the existing player actually consumes, not incoming WS chunks.
export async function attachLipSync(context, source, output, character, {delayMs = 90, onViseme = () => {}} = {}) {
  await context.audioWorklet.addModule(new URL('./vendor/headaudio/modules/headworklet.mjs', import.meta.url));
  if (context.state === 'closed') throw new Error('声音播放已结束。');
  const node = new HeadAudio(context, {parameterData: {silMode: 0}});
  try {
    await node.loadModel(new URL('./vendor/headaudio/dist/model-en-mixed.bin', import.meta.url).href);
  } catch (error) {
    node.port.close();
    throw error;
  }
  if (context.state === 'closed') { node.port.close(); throw new Error('声音播放已结束。'); }
  const delay = context.createDelay(0.2);
  delay.delayTime.value = delayMs / 1000;
  source.connect(node);
  source.disconnect(output);
  source.connect(delay);
  delay.connect(output);
  let disposed = false, frame = 0, last = performance.now(), quietUntil = 0;
  node.onvalue = (key, value) => {
    if (disposed || performance.now() < quietUntil) return;
    character.setViseme(key, value);
    if (value > 0.15 && key !== 'viseme_sil') onViseme(key.replace('viseme_', ''), value);
  };
  node.onstarted = () => { if (!disposed) character.setSpeaking(true); };
  node.onended = () => { if (!disposed) character.setSpeaking(false); };
  function update(now) {
    if (disposed) return;
    node.update(Math.min(now - last, 100));
    last = now;
    frame = requestAnimationFrame(update);
  }
  frame = requestAnimationFrame(update);
  const clear = () => {
    quietUntil = performance.now() + 150;
    node.resetAll();
    node.visemeActive = -1;
    node.visemeAlphas.fill(0);
    character.setSpeaking(false);
    character.resetMouth();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    clear();
    try { source.disconnect(node); source.disconnect(delay); delay.disconnect(); } catch {}
    if (context.state !== 'closed') { try { source.connect(output); } catch {} }
    node.port.close();
    context.removeEventListener('statechange', closed);
  };
  const closed = () => { if (context.state === 'closed') dispose(); };
  context.addEventListener('statechange', closed);
  return {clear, dispose, setDelay(ms) { delay.delayTime.value = Math.max(0, Math.min(180, ms)) / 1000; }};
}
