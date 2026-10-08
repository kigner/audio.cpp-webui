import {attachLipSync} from '../avatar/audio-bridge.js';
import {createCharacter} from './character.js';

export async function mountLiveCharacter(profile) {
  const stage = document.getElementById('live-character-stage');
  let character, bridge, activeClient, output, epoch = 0, disposed = false;
  let characterReady;
  let attachment = Promise.resolve();
  function connectOutput() {
    const turn = ++epoch;
    bridge?.dispose(); bridge = null;
    if (!output || profile.id === 'system' || disposed) return;
    const currentOutput = output;
    // Finish/dispose an earlier attachment before rewiring the same audio source.
    attachment = attachment.then(async () => {
      if (turn !== epoch || disposed || profile.id === 'system') return;
      await characterReady;
      if (turn !== epoch || disposed || profile.id === 'system') return;
      const next = await attachLipSync(currentOutput.context, currentOutput.source, currentOutput.output, character, {delayMs: profile.animation.delayMs});
      if (turn !== epoch || disposed) {next.dispose(); return;}
      next.setDelay(profile.animation.delayMs);
      bridge = next;
    }).catch(error => {
      if (turn === epoch && !disposed && currentOutput.context.state !== 'closed') {
        window.dispatchEvent(new CustomEvent('character-error', {detail: error.message}));
      }
    });
    return attachment;
  }
  async function setCharacter(next) {
    profile = next;
    stage.hidden = profile.id === 'system';
    document.body.dataset.character = profile.id;
    if (stage.hidden) {
      epoch++; bridge?.dispose(); bridge = null;
      character?.resetMouth(); character?.setSpeaking(false);
      return;
    }
    if (!characterReady) characterReady = createCharacter(stage).then(value => character = value);
    await characterReady;
    if (disposed || profile.id === 'system') return;
    character.setAnimationSettings(profile.animation);
    character.setListening(true);
    if (bridge) bridge.setDelay(profile.animation.delayMs);
    else if (output) void connectOutput();
  }
  const controller = {
    setCharacter,
    attachClient(client) {
      activeClient = client;
      client.addEventListener('audio-output', ({detail}) => {
        if (activeClient !== client) return;
        output = detail; void connectOutput();
      });
      client.addEventListener('playback-state', ({detail}) => {
        if (activeClient !== client) return;
        if (['clear', 'drained', 'underrun'].includes(detail?.kind)) bridge?.clear();
        if (detail?.kind === 'started' && profile.id !== 'system') character?.setSpeaking(true);
      });
      client.addEventListener('audio-output-closed', () => {
        if (activeClient !== client) return;
        epoch++; output = null; bridge?.dispose(); bridge = null;
        character?.resetMouth(); character?.setSpeaking(false);
      });
    },
    stats: () => ({...character?.stats(), characterId: profile.id, name: profile.name, hidden: stage.hidden}),
  };
  window.addEventListener('pagehide', () => {
    disposed = true; epoch++; bridge?.dispose(); character?.dispose();
  }, {once: true});
  await setCharacter(profile);
  return controller;
}
