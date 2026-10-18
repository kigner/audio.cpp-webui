// Character preferences belong to the character, independently of the TTS model.
export const CHARACTER_STORAGE = 'audiocpp.realtime.characters';
export const DEFAULT_ANIMATION = Object.freeze({
  mouth: true, blink: true, breath: true, head: true, shoulders: true,
  listening: true, strength: 1, delayMs: 90,
});
export const CHARACTER_DEFAULTS = Object.freeze({
  companion: {name: '小暖', referenceId: 'demo_02_woman', referenceAudio: 'voice/demo_02_woman.wav', ttsModel: 'voxcpm1',
    visual: './assets/character.json', background: './backgrounds/bedroom-private.png'},
  baijie: {name: '白洁', referenceId: 'ref_w1', referenceAudio: 'voice/ref-w1.wav', ttsModel: 'voxcpm1',
    visual: './assets/baijie/character.json', background: './backgrounds/baijie-living-room.png'},
  lily: {name: 'Lily', referenceId: 'F1', referenceAudio: '', ttsModel: 'supertonic', ttsVoice: 'F1',
    visual: './assets/lily/character.json', background: './backgrounds/lily-living-room.png'},
  office: {name: '办公室', referenceId: 'ref_w1', referenceAudio: 'voice/ref-w1.wav', ttsModel: 'voxcpm1',
    background: './backgrounds/office-day.png', static: true},
  living: {name: '客厅', referenceId: 'demo_02_woman', referenceAudio: 'voice/demo_02_woman.wav', ttsModel: 'voxcpm1',
    background: './backgrounds/living-day.png', static: true},
  system: {name: '纯净', referenceAudio: ''},
});

export function normalizeAnimation(value = {}) {
  const result = {...DEFAULT_ANIMATION};
  for (const key of ['mouth', 'blink', 'breath', 'head', 'shoulders', 'listening']) {
    if (typeof value?.[key] === 'boolean') result[key] = value[key];
  }
  for (const [key, min, max] of [['strength', .25, 1.5], ['delayMs', 0, 180]]) {
    if (Number.isFinite(Number(value?.[key])) && value?.[key] != null) {
      result[key] = Math.max(min, Math.min(max, Number(value[key])));
    }
  }
  return result;
}

export function normalizeCharacters(value = {}) {
  const roles = {};
  for (const [id, defaults] of Object.entries(CHARACTER_DEFAULTS)) {
    const saved = value?.roles?.[id] || {};
    // Migrate only the old shared factory voice; keep explicit clears and custom audio.
    const oldDefault = value?.version !== 2 && ['baijie', 'lily'].includes(id)
      && /(?:^|[/\\])demo_02_woman\.wav$/i.test(saved.referenceAudio || '');
    roles[id] = {
      id, name: String(value?.version !== 2 && id === 'system' && saved.name === '系统' ? defaults.name : saved.name || defaults.name).trim().slice(0, 40) || defaults.name,
      referenceId: defaults.referenceId || '',
      referenceAudio: String(oldDefault ? defaults.referenceAudio : saved.referenceAudio ?? defaults.referenceAudio),
      referenceText: oldDefault ? '' : String(saved.referenceText || ''),
      ttsModel: String(saved.ttsModel ?? defaults.ttsModel ?? ''),
      ttsVoice: String(saved.ttsVoice ?? defaults.ttsVoice ?? ''),
      animation: normalizeAnimation(saved.animation),
    };
  }
  return {version: 2, activeId: Object.hasOwn(roles, value?.activeId) ? value.activeId : 'companion', roles};
}

export function loadCharacters(storage = localStorage) {
  const saved = storage.getItem(CHARACTER_STORAGE);
  if (saved) {
    try {return normalizeCharacters(JSON.parse(saved));} catch {}
  }
  // Preserve an existing user voice on the first migration; new users get the tested female voice.
  const legacyReference = storage.getItem('audiocpp.tts.voiceRef');
  return normalizeCharacters({roles: {companion: {
    ...(legacyReference ? {referenceAudio: legacyReference,
      ttsModel: storage.getItem('audiocpp.tts.model') || CHARACTER_DEFAULTS.companion.ttsModel,
      ttsVoice: storage.getItem('audiocpp.tts.voice') || ''} : {}),
    referenceText: legacyReference ? storage.getItem('audiocpp.tts.refText') || '' : '',
  }}});
}

export function saveCharacters(value, storage = localStorage) {
  const state = normalizeCharacters(value);
  storage.setItem(CHARACTER_STORAGE, JSON.stringify(state));
  return state;
}

export function currentCharacter(state) {return state.roles[state.activeId];}
