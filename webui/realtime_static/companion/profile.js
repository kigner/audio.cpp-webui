// Character preferences belong to the character, independently of the TTS model.
export const CHARACTER_STORAGE = 'audiocpp.realtime.characters';
export const DEFAULT_ANIMATION = Object.freeze({
  mouth: true, blink: true, breath: true, head: true, shoulders: true,
  listening: true, strength: 1, delayMs: 90,
});
export const CHARACTER_DEFAULTS = Object.freeze({
  companion: {name: '小暖', referenceAudio: 'voice/demo_02_woman.wav'},
  system: {name: '系统', referenceAudio: ''},
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
    roles[id] = {
      id, name: String(saved.name || defaults.name).trim().slice(0, 40) || defaults.name,
      referenceAudio: String(saved.referenceAudio ?? defaults.referenceAudio),
      referenceText: String(saved.referenceText || ''),
      animation: normalizeAnimation(saved.animation),
    };
  }
  return {activeId: Object.hasOwn(roles, value?.activeId) ? value.activeId : 'companion', roles};
}

export function loadCharacters(storage = localStorage) {
  const saved = storage.getItem(CHARACTER_STORAGE);
  if (saved) {
    try {return normalizeCharacters(JSON.parse(saved));} catch {}
  }
  // Preserve an existing user voice on the first migration; new users get the tested female voice.
  const legacyReference = storage.getItem('audiocpp.tts.voiceRef');
  return normalizeCharacters({roles: {companion: {
    ...(legacyReference ? {referenceAudio: legacyReference} : {}),
    referenceText: legacyReference ? storage.getItem('audiocpp.tts.refText') || '' : '',
  }}});
}

export function saveCharacters(value, storage = localStorage) {
  const state = normalizeCharacters(value);
  storage.setItem(CHARACTER_STORAGE, JSON.stringify(state));
  return state;
}

export function currentCharacter(state) {return state.roles[state.activeId];}
