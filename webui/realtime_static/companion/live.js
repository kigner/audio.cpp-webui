import {attachLipSync} from '../avatar/audio-bridge.js';
import {createCharacter} from './character.js';
import {CHARACTER_DEFAULTS} from './profile.js';

export async function mountLiveCharacter(profile, {framing} = {}) {
  const stage = document.getElementById('live-character-stage');
  const backdrop = document.querySelector('.scene-background');
  let character, bridge, activeClient, output, epoch = 0, disposed = false;
  let characterReady;
  let characterUrl;
  let characterLayout;
  let attachment = Promise.resolve();
  function applySceneLayout(){
    const bounds=characterLayout;
    backdrop.style.backgroundSize=bounds?`${bounds.width}px ${bounds.height}px`:'';
    backdrop.style.backgroundPosition=bounds?`${bounds.x}px ${bounds.y}px`:'';
    backdrop.style.setProperty('--scene-left',`${bounds?.x||0}px`);
    backdrop.style.setProperty('--scene-top',`${bounds?.y||0}px`);
  }
  function connectOutput() {
    const turn = ++epoch;
    bridge?.dispose(); bridge = null;
    if (!output || !CHARACTER_DEFAULTS[profile.id].visual || disposed) return;
    const currentOutput = output;
    // Finish/dispose an earlier attachment before rewiring the same audio source.
    attachment = attachment.then(async () => {
      if (turn !== epoch || disposed || !CHARACTER_DEFAULTS[profile.id].visual) return;
      await characterReady;
      if (turn !== epoch || disposed || !CHARACTER_DEFAULTS[profile.id].visual || !character) return;
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
    const definition = CHARACTER_DEFAULTS[profile.id];
    stage.hidden = !definition.visual;
    backdrop.style.backgroundImage = definition.background ? `url("${new URL(definition.background,import.meta.url).href}")` : '';
    if(!definition.visual||new URL(definition.visual,import.meta.url).href!==characterUrl){
      backdrop.style.backgroundSize = '';
      backdrop.style.backgroundPosition = '';
      backdrop.style.removeProperty('--scene-left');
      backdrop.style.removeProperty('--scene-top');
    }
    document.body.dataset.character = profile.id;
    document.body.dataset.staticScene = String(Boolean(definition.static));
    if (stage.hidden) {
      epoch++; bridge?.dispose(); bridge = null;
      character?.dispose(); character = null; characterUrl = null; characterLayout = null;
      return;
    }
    const url = new URL(definition.visual,import.meta.url).href;
    if (characterUrl !== url) {
      characterUrl = url;
      epoch++; bridge?.dispose(); bridge = null;
      character?.dispose(); character = null;
      characterReady = createCharacter(stage,url,{framing,onLayout(bounds){
        if(disposed||characterUrl!==url)return;
        characterLayout=bounds;applySceneLayout();
      }}).then(value => {
        if (disposed || characterUrl !== url) {value.dispose();return;}
        character = value;
      });
    }
    await characterReady;
    if (disposed || profile !== next || stage.hidden || !character) return;
    character.setAnimationSettings(profile.animation);
    character.setListening(true);
    applySceneLayout();
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
        if (detail?.kind === 'started' && CHARACTER_DEFAULTS[profile.id].visual) character?.setSpeaking(true);
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
