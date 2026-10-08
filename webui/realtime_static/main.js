// @ts-check
/**
 * audio.cpp Realtime Voice — simplified orb frontend.
 * Connects directly to the configured realtime WebSocket and keeps local
 * TTS/ASR/LLM settings in the browser.
 *
 * @typedef {"idle" | "connecting" | "queued" | "your-turn" |
 *           "listening" | "user-speaking" | "processing" |
 *           "ai-speaking" | "error"} AppState
 */

import { S2sWsRealtimeClient } from "./ws/s2s-ws-client.js";
import { ChatView } from "./ui/chat.js?v=roles-5";
import { $, truncateError, DEBUG } from "./ui/dom.js";
import {loadCharacters, saveCharacters, normalizeCharacters, currentCharacter, DEFAULT_ANIMATION, CHARACTER_DEFAULTS} from "./companion/profile.js";

// ── Settings (persisted in localStorage) ───────────────────────────────
const DEFAULT_RT_URL = new URL("/v1/realtime", window.location.href).href.replace(/^http/, "ws");
let realtimeApiBase = "";
let realtimeConfigReady = false;
const LEGACY_DEFAULT_TTS_URL = "http://127.0.0.1:8080";
const DEFAULT_INSTRUCTIONS =
  "You are a friendly voice assistant. Keep replies short and spoken. " +
  "Always reply in the same language the user speaks. " +
  "If the user speaks Chinese, use Simplified Chinese (简体中文), not Traditional Chinese.";

const STORAGE = {
  rtUrl: "audiocpp.rt.url",
  ttsUrl: "audiocpp.tts.url",
  ttsModel: "audiocpp.tts.model",
  ttsServerSource: "audiocpp.tts.serverSource",
  ttsPlaybackMode: "audiocpp.tts.playbackMode",
  ttsInferenceSteps: "audiocpp.tts.inferenceSteps",
  ttsVocoderMergeSteps: "audiocpp.tts.vocoderMergeSteps",
  ttsVoice: "audiocpp.tts.voice",
  asrUrl: "audiocpp.asr.url",
  asrModel: "audiocpp.asr.model",
  asrLanguage: "audiocpp.asr.language",
  llmUrl: "audiocpp.llm.url",
  llmModel: "audiocpp.llm.model",
  llmKey: "audiocpp.llm.key",
  instructions: "audiocpp.llm.instructions",
  noiseGate: "audiocpp.noiseGate",
  micDeviceId: "audiocpp.mic.deviceId",
};

// Noise gate: slider minimum = off (gate disabled), rest = active threshold dBFS.
const GATE_OFF_DB = -66;
const GATE_MAX_DB = -3;
const GATE_DEFAULT_DB = -50;

const DEFAULTS = {
  rtUrl: DEFAULT_RT_URL,
  ttsUrl: "http://127.0.0.1:8088",
  ttsModel: "qwen3-tts",
  ttsServerSource: "managed",
  ttsPlaybackMode: "auto",
  ttsInferenceSteps: "",
  ttsVocoderMergeSteps: "",
  ttsVoice: "",
  asrUrl: "http://127.0.0.1:8081",
  asrModel: "qwen3-asr",
  asrLanguage: "",
  llmUrl: "https://api.deepseek.com/v1",
  llmModel: "deepseek-chat",
  llmKey: "",
  instructions: DEFAULT_INSTRUCTIONS,
  noiseGate: String(GATE_DEFAULT_DB),
  micDeviceId: "",
};

function loadSettings() {
  const s = {};
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = localStorage.getItem(STORAGE[k]);
    if (k === "ttsUrl" && v === LEGACY_DEFAULT_TTS_URL) {
      localStorage.removeItem(STORAGE[k]);
      s[k] = def;
      continue;
    }
    if (k === "ttsPlaybackMode" && v === "smooth") {
      // v0.6 briefly exposed sentence buffering as a separate mode. It still
      // starves when backend RTF exceeds 1, so migrate it to full-WAV playback.
      localStorage.setItem(STORAGE[k], "offline");
      s[k] = "offline";
      continue;
    }
    s[k] = v === null ? def : v;
  }
  const characters = loadCharacters();
  const role = currentCharacter(characters);
  return {...s, characters, ttsModel: role.ttsModel || s.ttsModel, ttsVoice: role.ttsVoice};
}

/** Env defaults fetched from the realtime server's /config endpoint. Empty
 *  until the fetch resolves; merged in so the Settings panel pre-fills fields
 *  the user hasn't customized. localStorage still wins over env defaults. */
let envDefaults = {};
/** @type {Array<Record<string, any>>} */
let availableTtsModels = [];
let referenceVoices = [];
let referenceLibraryReady = false;
let referenceLibraryRequest = 0;

const ENV_SETTING_KEYS = {
  ttsUrl: "tts_server",
  ttsModel: "tts_model",
  ttsServerSource: "tts_server_source",
  ttsPlaybackMode: "tts_playback_mode",
  ttsVoice: "tts_voice",
  asrUrl: "asr_server",
  asrModel: "asr_model",
  asrLanguage: "asr_language",
  llmUrl: "llm_base_url",
  llmModel: "llm_model",
  instructions: "instructions",
};

async function refreshEnvDefaults() {
  try {
    // The integrated host namespaces its API; the standalone server keeps its
    // original routes. Validate the payload so Gradio's /config is never used.
    const urls = [
      new URL("../api/realtime/config", window.location.href).href,
      new URL("../config", window.location.href).href,
      new URL("/config", window.location.origin).href,
    ];
    for (const u of urls) {
      try {
        const res = await fetch(u, { cache: "no-store" });
        if (res.ok) {
          const config = await res.json();
          if (!Array.isArray(config.tts_models)) continue;
          envDefaults = config;
          realtimeApiBase = String(config.api_base || "");
          const wsUrl = new URL(`${realtimeApiBase}/v1/realtime`, window.location.origin);
          settings.rtUrl = wsUrl.href.replace(/^http/, "ws");
          realtimeConfigReady = true;
          availableTtsModels = Array.isArray(envDefaults.tts_models)
            ? envDefaults.tts_models
            : [];
          // Apply: any field the user hasn't set in localStorage takes the env value.
          for (const k of Object.keys(DEFAULTS)) {
            if (k === "ttsModel" && currentCharacter(settings.characters).ttsModel) continue;
            if (k === "ttsVoice") continue;
            const envKey = ENV_SETTING_KEYS[k];
            if (envKey && envDefaults[envKey] != null && localStorage.getItem(STORAGE[k]) === null) {
              settings[k] = String(envDefaults[envKey]);
            }
          }
          renderTtsModelOptions();
          renderAsrModelOptions();
          syncTtsSettingsUi(false);
          updateSetupSummary();
          updateLlmKeyStatus();
          return;
        }
      } catch { /* try next */ }
    }
  } catch (e) {
    console.warn("[main] /config fetch failed:", e);
  }
}

function saveSettings(s) {
  for (const k of Object.keys(DEFAULTS)) {
    // The realtime transport belongs to this host; preserve legacy overrides
    // in storage but never send a credential to an old/different origin.
    if (k === "rtUrl") continue;
    localStorage.setItem(STORAGE[k], String(s[k] ?? ""));
  }
  s.characters = saveCharacters(s.characters);
}

function characterInstructions(s) {
  return `${s.instructions}\n当前对话角色名是${JSON.stringify(currentCharacter(s.characters).name)}。以这个名字称呼自己。`;
}

/** Build the `audiocpp` config block sent inside session.update. */
function appConfigFromSettings(s) {
  /** @type {Record<string, any>} */
  const ttsOptions = {};
  const meta = ttsModelMeta(s.ttsModel);
  const voice = meta ? meta.voices?.find(item => item.value === s.ttsVoice)?.value || "" : s.ttsVoice;
  if (voice && meta?.voice_parameter) {
    ttsOptions[meta.voice_parameter] = meta.voice_value_type === "number" ? Number(voice) : voice;
  }
  const acceptsReference = meta?.accepts_voice_reference !== false;
  const role = currentCharacter(s.characters);
  const reference = acceptsReference && !voice ? role.referenceAudio : "";
  if (meta?.family === "dots_tts") {
    const inferenceSteps = Number(s.ttsInferenceSteps);
    const mergeSteps = Number(s.ttsVocoderMergeSteps);
    if (Number.isInteger(inferenceSteps) && inferenceSteps > 0) {
      ttsOptions.num_inference_steps = inferenceSteps;
    }
    if (Number.isInteger(mergeSteps) && mergeSteps > 0) {
      ttsOptions.vocoder_merge_steps = mergeSteps;
    }
  }
  const requestedPlayback = s.ttsPlaybackMode === "smooth"
    ? "offline"
    : s.ttsPlaybackMode;
  const effectivePlayback = requestedPlayback === "auto"
    ? (meta?.realtime_auto_mode || (meta?.supports_streaming ? "streaming" : "offline"))
    : requestedPlayback;
  return {
    tts_server: s.ttsUrl,
    tts_model: s.ttsModel,
    tts_server_source: s.ttsServerSource,
    // Send the resolved mode to both /activate and the realtime client so the
    // browser's jitter-buffer behavior matches the backend session mode.
    tts_playback_mode: effectivePlayback,
    tts_options: ttsOptions,
    tts_voice: meta?.voice_parameter ? "" : voice,
    tts_voice_ref: reference,
    tts_reference_text: reference ? role.referenceText : "",
    asr_server: s.asrUrl,
    asr_model: s.asrModel,
    asr_language: s.asrLanguage,
    llm_base_url: s.llmUrl,
    llm_model: s.llmModel,
    ...(s.llmKey ? { llm_api_key: s.llmKey } : {}),
    instructions: characterInstructions(s),
  };
}

let settings = loadSettings();
let characterDraft = structuredClone(settings.characters);
let referenceUploadBusy = false;
let characterEditEpoch = 0;
const liveCharacterReady = import("./companion/live.js")
  .then(module => module.mountLiveCharacter(currentCharacter(settings.characters)))
  .catch(error => {
    console.error("角色加载失败", error);
    window.dispatchEvent(new CustomEvent("character-error", {detail: `角色画面加载失败：${error.message}`}));
    return null;
  });
export async function liveCharacterStats() {return (await liveCharacterReady)?.stats();}

// ── State machine ──────────────────────────────────────────────────────
const STATE_CLASS = {
  idle: "state-idle", connecting: "state-connecting",
  queued: "state-queued", "your-turn": "state-your-turn",
  listening: "state-listening", "user-speaking": "state-user-speaking",
  processing: "state-processing", "ai-speaking": "state-ai-speaking",
  error: "state-error",
};
const STATE_VIEWS = {
  idle:            { caption: "未开始",  disabled: false },
  connecting:      { caption: "连接中",    disabled: true  },
  queued:          { caption: "排队中…", disabled: true },
  "your-turn":     { caption: "准备就绪",  disabled: true  },
  listening:       { caption: "正在聆听",    disabled: false },
  "user-speaking": { caption: "正在聆听…",    disabled: false },
  processing:      { caption: "正在回复",  disabled: false },
  "ai-speaking":   { caption: "正在回复",      disabled: false },
  error:           { caption: "点击重试",  disabled: false },
};
const LIVE_STATES = new Set(["listening", "user-speaking", "processing", "ai-speaking"]);

/** @type {AppState} */
let currentState = "idle";
/** @type {S2sWsRealtimeClient | null} */
let client = null;
let connectionAttempt = 0;
/** @type {AudioContext | null} */
let audioContext = null;
/** @type {MediaStream | null} */
let micStream = null;
/** @type {ChatView} */
let chat;

// DOM refs
const circleBtn = /** @type {HTMLButtonElement} */ ($("#main-circle"));
const captionEl = $("#circle-caption");
const realtimeNotice = $("#realtime-notice");
const realtimeNoticeText = $("#realtime-notice-text");
const realtimeNoticeSettings = /** @type {HTMLButtonElement} */ ($("#realtime-notice-settings"));
const realtimeNoticeDismiss = /** @type {HTMLButtonElement} */ ($("#realtime-notice-dismiss"));
const micBtn = /** @type {HTMLButtonElement} */ ($("#mic-btn"));
const stopBtn = /** @type {HTMLButtonElement} */ ($("#stop-btn"));
const micGate = $("#mic-gate");
const mgaArc = /** @type {SVGSVGElement} */ (document.querySelector("#mic-gate-arc"));
const mgaTrack = /** @type {SVGPathElement} */ (document.querySelector("#mga-track"));
const mgaFill = /** @type {SVGPathElement} */ (document.querySelector("#mga-fill"));
const mgaHit = /** @type {SVGPathElement} */ (document.querySelector("#mga-hit"));
const mgaHandle = /** @type {SVGCircleElement} */ (document.querySelector("#mga-handle"));
const gateValue = /** @type {HTMLElement} */ ($("#gate-value"));
const gateMeterFill = /** @type {HTMLElement} */ ($("#gate-meter-fill"));
const queueBar = $("#queue-bar");
const queuePosition = $("#queue-position");
const queueLeave = /** @type {HTMLButtonElement} */ ($("#queue-leave"));
const queueFunnel = $("#queue-funnel");
const queueFunnelMsg = $("#queue-funnel-msg");
const queueFunnelJoin = /** @type {HTMLButtonElement} */ ($("#queue-funnel-join"));
const queueFunnelLeave = /** @type {HTMLButtonElement} */ ($("#queue-funnel-leave"));

let muted = false;
let queuedTicketId = "";

// Settings modal refs
const settingsBtn = $("#settings-btn");
const settingsModal = $("#settings-modal");
const settingsForm = settingsModal?.querySelector("form") || null;
const settingsFields = {
  rtUrl: $("#rt-url"),
  ttsUrl: $("#tts-url"),
  ttsModel: $("#tts-model"),
  ttsServerSource: $("#tts-server-source"),
  ttsPlaybackMode: $("#tts-playback-mode"),
  ttsInferenceSteps: $("#tts-inference-steps"),
  ttsVocoderMergeSteps: $("#tts-vocoder-merge-steps"),
  ttsVoice: $("#tts-voice"),
  asrUrl: $("#asr-url"),
  asrModel: $("#asr-model"),
  asrLanguage: $("#asr-language"),
  llmUrl: $("#llm-url"),
  llmModel: $("#llm-model"),
  llmKey: $("#llm-key"),
  instructions: $("#instructions"),
  noiseGate: $("#noise-gate"),
  micDeviceId: $("#mic-device"),
};
const ttsModelCapability = $("#tts-model-capability");
const ttsDotsOptions = $("#tts-dots-options");
const referenceFields = {audio: $("#tts-voice-ref"), text: $("#tts-ref-text")};
const characterGrid = $("#character-grid");
const characterName = $("#character-name");

function applyCharacterProfile(role) {
  document.body.dataset.character = role.id;
  chat?.setAssistantName(role.name);
  void liveCharacterReady.then(controller => controller?.setCharacter(role)).catch(error => showRealtimeError(error));
}

function readCharacterForm() {
  const role = currentCharacter(characterDraft);
  role.name = characterName.value.trim() || CHARACTER_DEFAULTS[role.id].name;
  role.referenceAudio = referenceFields.audio.value;
  role.referenceText = referenceFields.text.value;
  role.ttsModel = settingsFields.ttsModel.value;
  role.ttsVoice = settingsFields.ttsVoice.value;
  for (const input of document.querySelectorAll("[data-animation]")) {
    role.animation[input.dataset.animation] = input.type === "checkbox" ? input.checked : Number(input.value);
  }
  characterDraft = normalizeCharacters(characterDraft);
  return currentCharacter(characterDraft);
}

function fillCharacterForm() {
  const role = currentCharacter(characterDraft);
  renderCharacterGrid();
  characterName.value = role.name;
  document.getElementById("character-name-status").textContent = "";
  const model = role.ttsModel || settingsFields.ttsModel.value || settings.ttsModel;
  if (model && !Array.from(settingsFields.ttsModel.options).some(option => option.value === model)) {
    settingsFields.ttsModel.add(new Option(`${model}（未安装）`, model));
  }
  settingsFields.ttsModel.value = model;
  renderVoiceOptions(true);
  // Preserve an uninstalled model's preset until its metadata becomes available.
  if (role.ttsVoice && !Array.from(settingsFields.ttsVoice.options).some(option => option.value === role.ttsVoice)) {
    settingsFields.ttsVoice.add(new Option(role.ttsVoice, role.ttsVoice));
  }
  settingsFields.ttsVoice.value = role.ttsVoice;
  referenceFields.text.value = role.referenceText;
  renderReferenceOptions(role.referenceAudio);
  document.getElementById("character-animation-controls").hidden = !CHARACTER_DEFAULTS[role.id].visual;
  for (const input of document.querySelectorAll("[data-animation]")) {
    if (input.type === "checkbox") input.checked = role.animation[input.dataset.animation];
    else input.value = role.animation[input.dataset.animation];
  }
  updateAnimationLabels();
  syncTtsSettingsUi(false);
}

function renderCharacterGrid() {
  characterGrid.replaceChildren(...Object.values(characterDraft.roles).map(role => {
    const button = document.createElement("button");
    button.type = "button"; button.className = "character-card";
    button.dataset.characterId = role.id;
    button.setAttribute("aria-pressed", String(role.id === characterDraft.activeId));
    const portrait = document.createElement("span");
    portrait.className = `character-portrait${role.id === "system" ? " system" : ""}`;
    portrait.dataset.character = role.id;
    portrait.setAttribute("aria-hidden", "true");
    if (role.id === "system") portrait.textContent = "◌";
    const name = document.createElement("span"); name.textContent = role.name;
    button.append(portrait, name);
    return button;
  }));
}

function updateAnimationLabels() {
  document.getElementById("character-strength-value").textContent = `${document.querySelector('[data-animation="strength"]').value}×`;
  document.getElementById("character-delay-value").textContent = `${document.querySelector('[data-animation="delayMs"]').value} ms`;
}

characterGrid.addEventListener("click", event => {
  const button = event.target.closest("[data-character-id]");
  if (!button || button.dataset.characterId === characterDraft.activeId) return;
  readCharacterForm(); characterDraft.activeId = button.dataset.characterId;
  fillCharacterForm(); applyCharacterProfile(currentCharacter(characterDraft));
});
document.getElementById("character-name-save").addEventListener("click", () => {
  const role = readCharacterForm();
  settings.characters.roles[role.id].name = role.name;
  settings.characters = saveCharacters(settings.characters);
  characterName.value = role.name;
  renderCharacterGrid();
  applyCharacterProfile(role);
  document.getElementById("character-name-status").textContent = "角色名称已保存";
});
for (const input of document.querySelectorAll("[data-animation]")) {
  input.addEventListener("input", () => {updateAnimationLabels(); applyCharacterProfile(readCharacterForm());});
}
document.getElementById("character-animation-reset").addEventListener("click", () => {
  readCharacterForm(); currentCharacter(characterDraft).animation = {...DEFAULT_ANIMATION};
  fillCharacterForm(); applyCharacterProfile(currentCharacter(characterDraft));
});

function ttsModelMeta(modelId) {
  return availableTtsModels.find((model) => model.id === modelId) || null;
}

function renderAsrModelOptions() {
  const list = document.querySelector("#asr-model-list");
  if (!list) return;
  list.replaceChildren();
  const models = Array.isArray(envDefaults.asr_models) ? envDefaults.asr_models : [];
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.id;
    option.label = model.label || model.id;
    list.append(option);
  }
  if (models.length && !localStorage.getItem(STORAGE.asrModel)
      && !models.some((model) => model.id === settings.asrModel)) {
    settings.asrModel = models[0].id;
  }
}

function updateSetupSummary(result = null) {
  const labels = {
    asr: result?.asr?.message || (settings.asrModel ? "已选择识别模型，等待检测" : "选择识别模型"),
    llm: result?.llm?.message || (settings.llmModel ? "已填写服务，连接后验证" : "配置对话服务"),
    tts: result?.tts?.message || (settings.ttsModel ? "已选择声音模型" : "安装并选择声音模型"),
  };
  for (const [key, label] of Object.entries(labels)) {
    const element = document.querySelector(`#setup-${key}-status`);
    if (element) element.textContent = label;
  }
}

async function checkSetup() {
  const button = /** @type {HTMLButtonElement | null} */ (document.querySelector("#setup-check"));
  if (button) { button.disabled = true; button.textContent = "检测中…"; }
  try {
    await refreshEnvDefaults();
    if (!realtimeConfigReady) throw new Error("实时服务尚未就绪，请重启应用后重试。");
    const response = await fetch(`${realtimeApiBase}/preflight`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(appConfigFromSettings(settings)),
    });
    if (!response.ok) throw new Error("暂时无法检测服务，请稍后重试。");
    updateSetupSummary(await response.json());
  } catch (error) {
    showRealtimeError(error);
  } finally {
    if (button) { button.disabled = false; button.textContent = "检测准备情况"; }
  }
}

function ttsModelLabel(model) {
  const playback = model.realtime_auto_mode === "offline" || !model.supports_streaming
    ? "完整生成后播放" : "支持边生成边播放";
  return `${model.label || model.id} · ${playback}`;
}

function renderTtsModelOptions() {
  const select = /** @type {HTMLSelectElement | null} */ (settingsFields.ttsModel);
  if (!select) return;
  const editing = settingsModal?.open;
  const currentValue = editing ? select.value : settings.ttsModel;
  select.innerHTML = "";
  if (!availableTtsModels.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "未检测到本地已安装的 TTS 模型";
    select.append(option);
    select.disabled = true;
    if (currentValue) {
      select.add(new Option(`${currentValue}（未安装）`, currentValue));
      select.value = currentValue;
    }
    return;
  }
  select.disabled = false;
  for (const model of availableTtsModels) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = ttsModelLabel(model);
    option.title = model.label || model.id;
    select.append(option);
  }
  const installedIds = new Set(availableTtsModels.map((model) => model.id));
  const selected = currentValue || (installedIds.has(envDefaults.tts_model)
      ? envDefaults.tts_model
      : availableTtsModels[0].id);
  if (!installedIds.has(selected)) select.add(new Option(`${selected}（未安装）`, selected));
  if (!editing) settings.ttsModel = selected;
  select.value = selected;
  select.title = select.selectedOptions[0]?.title || select.selectedOptions[0]?.textContent || "";
}

function renderVoiceOptions(reset = false) {
  const meta = ttsModelMeta(settingsFields.ttsModel?.value || settings.ttsModel);
  const select = settingsFields.ttsVoice;
  const current = reset ? "" : select.value || (!settingsModal.open ? settings.ttsVoice : "");
  const voices = meta?.voices || [];
  select.replaceChildren(new Option(voices.length ? "模型默认音色" : "模型未提供内置音色列表", ""));
  for (const voice of voices) select.add(new Option(voice.label, voice.value));
  if (!meta && current) select.add(new Option(current, current));
  select.value = !meta || voices.some(voice => voice.value === current) ? current : "";
  select.disabled = !voices.length;
}

function renderReferenceOptions(current = referenceFields.audio.value) {
  const select = referenceFields.audio;
  const selected = findReferenceVoice(current);
  select.replaceChildren(new Option(referenceLibraryReady ? "不使用参考音频" : "参考音频库暂不可用", ""));
  for (const voice of referenceVoices) select.add(new Option(voice.label || voice.name, voice.voice_ref));
  if (current && !selected) select.add(new Option("已保存的参考音频（未在库中）", current));
  select.value = selected?.voice_ref || current;
  if (selected && current !== selected.voice_ref && !referenceFields.text.value) referenceFields.text.value = selected.text || "";
  updateReferencePreview();
}

function updateReferencePreview() {
  const voice = referenceVoices.find(item => item.voice_ref === referenceFields.audio.value);
  const preview = document.getElementById("tts-reference-preview");
  const url = voice?.url || "";
  if ((preview.getAttribute("src") || "") !== url) {
    preview.pause();
    if (url) preview.setAttribute("src", url);
    else preview.removeAttribute("src");
    preview.load();
  }
  preview.hidden = !voice;

  const meta = ttsModelMeta(settingsFields.ttsModel.value);
  const preset = settingsFields.ttsVoice.value;
  const builtin = meta?.voices?.find(item => item.value === preset);
  const presetOnly = meta?.accepts_voice_reference === false || settingsFields.ttsModel.value === "supertonic";
  const builtinPreview = document.getElementById("character-builtin-preview");
  const builtinUrl = presetOnly ? builtin?.url || builtin?.preview_url || "" : "";
  if ((builtinPreview.getAttribute("src") || "") !== builtinUrl) {
    builtinPreview.pause();
    if (builtinUrl) builtinPreview.setAttribute("src", builtinUrl);
    else builtinPreview.removeAttribute("src");
    builtinPreview.load();
  }
  builtinPreview.hidden = !builtinUrl || Boolean(builtinPreview.error);
  if (presetOnly) preview.pause();
  const builtinField = document.getElementById("character-builtin-field");
  const builtinSelect = document.getElementById("character-builtin-voice");
  builtinField.hidden = !presetOnly;
  builtinSelect.replaceChildren(...Array.from(settingsFields.ttsVoice.options, option => new Option(option.text, option.value)));
  builtinSelect.value = preset;
  builtinSelect.disabled = settingsFields.ttsVoice.disabled;
  document.getElementById("tts-reference-fields").hidden = presetOnly;
}

function findReferenceVoice(current) {
  const normalized = String(current).replaceAll("\\", "/").toLowerCase();
  // Stable factory ids accept both ref_w1 and the shipped ref-w1 filename.
  const libraryKey = value => String(value).split("/").pop().replace(/\.[^.]+$/, "").replaceAll("-", "_").toLowerCase();
  return referenceVoices.find(voice => voice.voice_ref.replaceAll("\\", "/").toLowerCase() === normalized
    || (normalized.startsWith("voice/") && libraryKey(voice.name) === libraryKey(normalized)));
}

document.getElementById("character-builtin-preview").addEventListener("error", event => {
  event.currentTarget.hidden = true;
});
document.getElementById("character-builtin-voice").addEventListener("change", event => {
  settingsFields.ttsVoice.value = event.currentTarget.value;
  syncTtsSettingsUi(false);
});

async function refreshReferenceLibrary() {
  const request = ++referenceLibraryRequest;
  try {
    const response = await fetch(new URL("../api/workbench/voices", location.href), {cache: "no-store"});
    if (!response.ok) throw new Error("reference library unavailable");
    const data = await response.json();
    if (!Array.isArray(data.voices)) throw new Error("invalid reference library");
    if (request !== referenceLibraryRequest) return;
    referenceVoices = data.voices.filter(voice => voice.name && voice.voice_ref);
    referenceLibraryReady = true;
    document.getElementById("tts-reference-status").textContent = referenceVoices.length ? "" : "音频库为空，可上传参考音频。";
  } catch {
    if (request !== referenceLibraryRequest) return;
    document.getElementById("tts-reference-status").textContent = "参考音频库读取失败，请重试。";
  }
  if (!settingsModal.open) {
    for (const role of Object.values(settings.characters.roles)) {
      const voice = findReferenceVoice(role.referenceAudio);
      if (voice && role.referenceAudio !== voice.voice_ref) {
        role.referenceAudio = voice.voice_ref;
        if (!role.referenceText) role.referenceText = voice.text || "";
      }
    }
    characterDraft = structuredClone(settings.characters);
    referenceFields.text.value = currentCharacter(characterDraft).referenceText;
    renderReferenceOptions(currentCharacter(characterDraft).referenceAudio);
  } else renderReferenceOptions();
}

referenceFields.audio.addEventListener("change", () => {
  const voice = referenceVoices.find(item => item.voice_ref === referenceFields.audio.value);
  referenceFields.text.value = voice?.text || "";
  // A reference and a preset are alternative voice sources.
  if (voice) settingsFields.ttsVoice.value = "";
  updateReferencePreview();
  syncTtsSettingsUi(false);
});
settingsFields.ttsVoice.addEventListener("change", () => {
  syncTtsSettingsUi(false);
});
document.getElementById("tts-reference-refresh").addEventListener("click", () => void refreshReferenceLibrary());

async function uploadCharacterAudio() {
  const input = document.getElementById("character-audio-upload");
  const file = input.files[0];
  if (!file || referenceUploadBusy) return;
  readCharacterForm();
  const status = document.getElementById("tts-reference-status");
  const owner = characterDraft.activeId;
  const editEpoch = characterEditEpoch;
  referenceLibraryRequest++;
  referenceUploadBusy = true; input.disabled = true;
  document.getElementById("settings-save").disabled = true;
  status.textContent = "正在上传并加入音频库…";
  const request = async (path, body) => {
    const response = await fetch(new URL(`../api/workbench/${path}`, location.href), {
      method: "POST", ...(body instanceof FormData ? {body} : {headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)}),
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.detail || "参考音频保存失败。"), {status: response.status});
    return data;
  };
  try {
    const form = new FormData(); form.append("file", file);
    const upload = await request("uploads", form);
    const name = file.name.replace(/\.[^.]+$/, "") || "参考音频";
    let result;
    try {result = await request("references", {audio: upload.id, name, text: ""});}
    catch (error) {
      if (error.status !== 409) throw error;
      result = await request("references", {audio: upload.id, name: `${name}-${Date.now()}`, text: ""});
    }
    referenceLibraryRequest++;
    referenceVoices = result.voices;
    referenceLibraryReady = true;
    const voice = referenceVoices.find(item => item.name === result.name);
    if (!voice) throw new Error("音频已保存，请刷新音频库后重新选择。");
    // Library storage is immediate; the role association follows the dialog's save/cancel.
    if (settingsModal.open && editEpoch === characterEditEpoch) {
      const role = characterDraft.roles[owner];
      role.referenceAudio = voice.voice_ref; role.referenceText = voice.text || "";
      role.ttsVoice = "";
      if (characterDraft.activeId === owner) {
        fillCharacterForm(); settingsFields.ttsVoice.value = ""; syncTtsSettingsUi(false);
      }
    }
    status.textContent = "已加入音频库。";
  } catch (error) {status.textContent = error.message;}
  finally {
    referenceUploadBusy = false; input.disabled = false; input.value = "";
    document.getElementById("settings-save").disabled = false;
  }
}
document.getElementById("character-audio-upload").addEventListener("change", () => void uploadCharacterAudio());

function syncTtsSettingsUi(applyModelDefaults = false, resetVoice = false) {
  const meta = ttsModelMeta(settingsFields.ttsModel?.value || settings.ttsModel);
  renderVoiceOptions(resetVoice);
  const acceptsReference = meta?.accepts_voice_reference !== false;
  document.getElementById("character-voice-hint").textContent = !acceptsReference
    ? "当前声音模型使用内置音色，角色参考音频会保留。"
    : settingsFields.ttsVoice.value ? "当前使用模型内置音色；选择角色参考音频可切换声音。" : "";
  document.getElementById("tts-reference-text-hint").textContent = meta?.requires_reference_text ? "此模型使用参考音频时需要原文" : "从参考音频库自动填入，可修改";
  updateReferencePreview();
  const playback = /** @type {HTMLSelectElement | null} */ (settingsFields.ttsPlaybackMode);
  const source = settingsFields.ttsServerSource?.value || settings.ttsServerSource;
  const urlInput = /** @type {HTMLInputElement | null} */ (settingsFields.ttsUrl);
  if (urlInput) {
    urlInput.disabled = source === "managed";
    if (source === "managed") {
      urlInput.value = envDefaults.tts_server || "http://127.0.0.1:8088";
    }
  }

  if (playback) {
    const streamOption = Array.from(playback.options)
      .find((option) => option.value === "streaming");
    if (streamOption) streamOption.disabled = !meta?.supports_streaming;
    if (!meta?.supports_streaming && playback.value === "streaming") {
      playback.value = "auto";
    }
  }

  if (ttsDotsOptions) ttsDotsOptions.hidden = meta?.family !== "dots_tts";
  if (applyModelDefaults && meta?.family === "dots_tts") {
    const defaults = meta.realtime_defaults || {};
    const inference = String(defaults.num_inference_steps ?? 10);
    const merge = String(defaults.vocoder_merge_steps ?? 4);
    if (settingsFields.ttsInferenceSteps) settingsFields.ttsInferenceSteps.value = inference;
    if (settingsFields.ttsVocoderMergeSteps) settingsFields.ttsVocoderMergeSteps.value = merge;
  }

  if (ttsModelCapability) {
    if (!meta) {
      ttsModelCapability.textContent = "请到模型中心安装声音模型。";
    } else if (meta.streaming_kind === "native" && meta.realtime_auto_mode === "offline") {
      ttsModelCapability.textContent =
        "推荐完整生成后播放。";
    } else if (meta.streaming_kind === "native") {
      ttsModelCapability.textContent =
        "";
    } else if (meta.supports_streaming) {
      ttsModelCapability.textContent =
        "分段播放；停顿时可切换完整播放。";
    } else {
      ttsModelCapability.textContent = "仅支持完整生成后播放。";
    }
  }
}

settingsFields.ttsModel?.addEventListener("change", () => {
  settingsFields.ttsModel.title =
    settingsFields.ttsModel.selectedOptions[0]?.title
    || settingsFields.ttsModel.selectedOptions[0]?.textContent
    || "";
  syncTtsSettingsUi(true, true);
});
settingsFields.ttsServerSource?.addEventListener("change", () => syncTtsSettingsUi(false));
settingsFields.ttsPlaybackMode?.addEventListener("change", () => syncTtsSettingsUi(false));

// ── Radial gate arc (around the mic button) ─────────────────────────────
// A ~200° arc centred on the left so the wide gap faces the orb (right).
const ARC_R = 40;
const ARC_SPAN_DEG = 200;
const ARC_START_DEG = 180 - ARC_SPAN_DEG / 2;

function dbToFraction(db) {
  const clamped = Math.min(GATE_MAX_DB, Math.max(GATE_OFF_DB, db));
  return (clamped - GATE_OFF_DB) / (GATE_MAX_DB - GATE_OFF_DB);
}

function fractionToDb(f) {
  const clamped = Math.min(1, Math.max(0, f));
  return Math.round(GATE_OFF_DB + clamped * (GATE_MAX_DB - GATE_OFF_DB));
}

function arcPoint(f, r = ARC_R) {
  const deg = ARC_START_DEG + f * ARC_SPAN_DEG;
  const rad = (deg * Math.PI) / 180;
  return { x: 50 + r * Math.cos(rad), y: 50 + r * Math.sin(rad) };
}

function fullArcD() {
  const a = arcPoint(0);
  const b = arcPoint(1);
  const largeArc = ARC_SPAN_DEG > 180 ? 1 : 0;
  return `M ${a.x} ${a.y} A ${ARC_R} ${ARC_R} 0 ${largeArc} 1 ${b.x} ${b.y}`;
}

function initGateArc() {
  const d = fullArcD();
  mgaTrack.setAttribute("d", d);
  mgaFill.setAttribute("d", d);
  mgaHit.setAttribute("d", d);
  mgaFill.setAttribute("pathLength", "100");
  mgaFill.style.strokeDasharray = "100 100";
  mgaFill.style.strokeDashoffset = "100";
  renderGateHandle();
}

function renderGateHandle() {
  const off = Number(settings.noiseGate) <= GATE_OFF_DB;
  const p = arcPoint(dbToFraction(Number(settings.noiseGate)));
  mgaHandle.setAttribute("cx", String(p.x));
  mgaHandle.setAttribute("cy", String(p.y));
  micGate.classList.toggle("gate-off", off);
}

function paintInputLevel(rms) {
  document.getElementById("scene-waveform")?.style.setProperty("--mic-level", String(Math.min(1, Math.max(0, rms * 8))));
  const db = rms > 0 ? 20 * Math.log10(rms) : GATE_OFF_DB;
  const f = dbToFraction(db);
  mgaFill.style.strokeDashoffset = String(100 * (1 - f));
  if (settingsModal && settingsModal.open) gateMeterFill.style.width = `${f * 100}%`;
  const enabled = Number(settings.noiseGate) > GATE_OFF_DB;
  micGate.classList.toggle("gate-open", enabled && f >= dbToFraction(Number(settings.noiseGate)));
}

function setGateThreshold(db) {
  settings.noiseGate = String(Math.min(GATE_MAX_DB, Math.max(GATE_OFF_DB, Math.round(db))));
  const off = Number(settings.noiseGate) <= GATE_OFF_DB;
  settingsFields.noiseGate.value = settings.noiseGate;
  gateValue.textContent = off ? "Off" : `${settings.noiseGate} dB`;
  renderGateHandle();
  localStorage.setItem(STORAGE.noiseGate, settings.noiseGate);
  if (client && LIVE_STATES.has(currentState)) {
    const thr = Number(settings.noiseGate);
    client.setNoiseGate({ enabled: thr > GATE_OFF_DB, thresholdDb: thr });
  }
}

function syncGateUi() {
  settingsFields.noiseGate.value = settings.noiseGate;
  const off = Number(settings.noiseGate) <= GATE_OFF_DB;
  gateValue.textContent = off ? "Off" : `${settings.noiseGate} dB`;
  renderGateHandle();
}

// Drag on the arc band to set the threshold
let gateDragging = false;
function gatePointerToDb(e) {
  const rect = mgaArc.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  let deg = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  const f = (deg - ARC_START_DEG) / ARC_SPAN_DEG;
  return fractionToDb(f);
}
mgaHit.addEventListener("pointerdown", (e) => {
  gateDragging = true;
  mgaHit.setPointerCapture(e.pointerId);
  setGateThreshold(gatePointerToDb(e));
});
mgaHit.addEventListener("pointermove", (e) => {
  if (gateDragging) setGateThreshold(gatePointerToDb(e));
});
const endGateDrag = (e) => {
  if (!gateDragging) return;
  gateDragging = false;
  try { mgaHit.releasePointerCapture(e.pointerId); } catch {}
};
mgaHit.addEventListener("pointerup", endGateDrag);
mgaHit.addEventListener("pointercancel", endGateDrag);

// Settings noise-gate slider also updates the arc handle live
settingsFields.noiseGate?.addEventListener("input", () => {
  setGateThreshold(Number(settingsFields.noiseGate.value));
});

// ── State management ───────────────────────────────────────────────────
function setState(next) {
  currentState = next;
  document.body.dataset.callState = next;
  const view = STATE_VIEWS[next];
  circleBtn.disabled = view.disabled;
  circleBtn.className = `circle ${STATE_CLASS[next]}`;
  circleBtn.setAttribute("aria-label", LIVE_STATES.has(next) ? "通话进行中" : next === "error" ? "重试语音对话" : "开始语音对话");
  if (client?.options.textOnly && LIVE_STATES.has(next)) {
    circleBtn.setAttribute("aria-label", "启用麦克风继续当前会话");
    circleBtn.title = "启用麦克风继续当前会话";
    if (next === "listening") circleBtn.className = "circle state-idle";
  } else circleBtn.title = circleBtn.getAttribute("aria-label");
  if (next === "error") setCaption(view.caption, "error");
  else setCaption(view.caption, "");
  if (next === "listening") setCaption(client?.options.textOnly ? "文字会话已连接" : muted ? "已静音" : "正在聆听", "");
  // Live indicator: side buttons appear + gate arc lights up
  const wrap = circleBtn.closest(".orb-wrap");
  if (wrap) {
    if (LIVE_STATES.has(next)) wrap.classList.add("live");
    else wrap.classList.remove("live");
  }
  for (const button of [micBtn, stopBtn]) {
    button.setAttribute("aria-hidden", String(!LIVE_STATES.has(next)));
    button.disabled = !LIVE_STATES.has(next);
  }
  micBtn.disabled = !LIVE_STATES.has(next) || !micStream;
  const microphone = micStream?.getAudioTracks().find(track => track.readyState === "live");
  document.body.dataset.microphone = microphone && !muted ? "on" : "off";
  document.getElementById("scene-waveform").title = microphone?.label || "麦克风音量";
  stopBtn.disabled = !(LIVE_STATES.has(next) || next === "connecting");
  stopBtn.setAttribute("aria-hidden", String(stopBtn.disabled));
  document.getElementById("text-cancel").hidden = !["processing", "ai-speaking"].includes(next);
  // Show/hide queue UI
  queueBar.hidden = next !== "queued";
  queueFunnel.hidden = next !== "your-turn";
  window.parent.postMessage({type: "audiocpp:realtime-state", state: next,
    active: !!client && next !== "idle" && next !== "error",
    microphone: !!micStream?.getAudioTracks().some(track => track.readyState === "live"), muted}, location.origin);
}

function setCaption(text, kind) {
  const trimmed = text.trim();
  captionEl.textContent = trimmed;
  captionEl.className = `circle-caption${kind ? ` ${kind}` : ""}${trimmed ? "" : " empty"}`;
}

const REALTIME_ERROR_MESSAGES = {
  llm_auth: "LLM API Key 无效，请在设置中检查并重新保存。",
  llm_connection: "无法连接 LLM 服务，请检查 Base URL 或网络。",
  llm_rate_limit: "LLM 请求过于频繁或额度不足，请稍后重试。",
  llm_request: "LLM 请求被拒绝，请检查模型名称和服务配置。",
  llm_service: "LLM 服务暂时不可用，请稍后重试。",
  tts_connection: "无法连接 TTS 服务，请确认服务已启动。",
  tts_reference_audio: "当前 TTS 模型缺少或无法读取参考音频，请检查 Voice ref。",
  tts_reference_text: "当前 TTS 模型缺少参考文本，请填写 Reference text。",
  tts_voice: "TTS 音色无效，请检查 Voice name 或 Voice ref。",
  tts_request: "TTS 合成失败，请检查模型、音色和服务状态。",
  tts_response: "TTS 未返回有效音频，请检查模型和音色配置。",
  tts_internal: "TTS 合成失败，请检查模型和服务状态。",
  tts_activation: "TTS 模型准备失败，请检查模型和服务状态。",
  asr_connection: "无法连接 ASR 服务，请确认服务已启动。",
  asr_request: "ASR 请求失败，请检查服务地址和模型名称。",
  asr_service: "ASR 服务暂时不可用，请确认服务已启动。",
  asr_response: "ASR 返回了无效结果，请检查服务版本。",
  pipeline_internal: "实时语音处理失败，请重试。",
};

function realtimeErrorMessage(error) {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code || "")
    : "";
  if (code && REALTIME_ERROR_MESSAGES[code]) return REALTIME_ERROR_MESSAGES[code];
  const raw = error instanceof Error ? error.message : String(error || "");
  if (/websocket (failed to open|closed)/i.test(raw)) {
    return "无法连接实时语音服务，请确认本地 WebUI 已启动。";
  }
  return truncateError(raw || "实时语音发生错误，请重试。");
}

function showRealtimeError(error) {
  const message = realtimeErrorMessage(error);
  realtimeNoticeText.textContent = message;
  realtimeNotice.hidden = false;
  return message;
}

function hideRealtimeError() {
  realtimeNotice.hidden = true;
  realtimeNoticeText.textContent = "";
}

// ── Audio ──────────────────────────────────────────────────────────────
const MIC_CONSTRAINTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
let microphoneDevices = [];

function renderMicrophoneOptions(selected = settings.micDeviceId) {
  const select = settingsFields.micDeviceId;
  const systemDefault = microphoneDevices.find(device => device.deviceId === "default");
  select.replaceChildren(new Option(systemDefault?.label || "系统默认麦克风", ""));
  for (const device of microphoneDevices) {
    if (!device.deviceId || device.deviceId === "default") continue;
    select.add(new Option(device.label || `麦克风 ${select.options.length}`, device.deviceId));
  }
  // Keep a saved, disconnected device visible; never silently switch its input.
  if (selected && ![...select.options].some(option => option.value === selected)) {
    select.add(new Option("已保存的麦克风（未检测到，请刷新或重新选择）", selected));
  }
  select.value = selected;
}

async function refreshMicrophones() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  microphoneDevices = devices.filter(device => device.kind === "audioinput");
  renderMicrophoneOptions(settingsModal.open ? settingsFields.micDeviceId.value : settings.micDeviceId);
}

async function openMicrophone(deviceId = settings.micDeviceId) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("浏览器无法使用麦克风，请通过 localhost 或 HTTPS 打开页面。");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({audio: {
      ...MIC_CONSTRAINTS.audio,
      ...(deviceId ? {deviceId: {exact: deviceId}} : {}),
    }});
  } catch (error) {
    const messages = {
      NotAllowedError: "麦克风权限被拒绝，请允许浏览器访问麦克风后重试。",
      NotFoundError: "未找到麦克风，请在会话参数的语音识别中重新选择。",
      OverconstrainedError: "所选麦克风不可用，请在会话参数的语音识别中重新选择。",
      NotReadableError: "无法打开麦克风，请检查设备连接及其他应用是否占用。",
    };
    throw new Error(messages[error.name] || `麦克风开启失败：${error.message || error}`);
  }
}

document.getElementById("mic-refresh").addEventListener("click", async event => {
  const button = event.currentTarget;
  const status = document.getElementById("mic-device-status");
  button.disabled = true;
  status.textContent = "正在读取麦克风…";
  try {
    // Device labels need permission. This preview never joins the conversation.
    const stream = await openMicrophone("");
    try { await refreshMicrophones(); }
    finally { stream.getTracks().forEach(track => track.stop()); }
    status.textContent = "请选择要使用的麦克风；虚拟声卡仅接收其他软件送入的声音。";
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});
navigator.mediaDevices?.addEventListener("devicechange", () => {
  void refreshMicrophones().catch(error => console.warn("麦克风列表刷新失败", error));
});

function createResumedAudioContext() {
  try {
    const Ctx = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    const ctx = new Ctx({ latencyHint: "interactive" });
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return /** @type {AudioContext} */ (ctx);
  } catch (err) {
    console.warn("[main] AudioContext init failed:", err);
    return null;
  }
}

async function primeMicPermission() {
  const stream = await openMicrophone();
  for (const track of stream.getTracks()) track.stop();
  void refreshMicrophones().catch(error => console.warn("麦克风列表刷新失败", error));
}

/** @returns {Promise<MediaStream>} */
async function acquireMicStream() {
  micStream = await openMicrophone();
  return micStream;
}

// ── Client lifecycle ───────────────────────────────────────────────────
function onClientStatus(status) {
  switch (status) {
    case "idle": setState("idle"); break;
    case "creating-session": setState("connecting"); break;
    case "queued": setState("queued"); break;
    case "your-turn": setState("your-turn"); break;
    case "connecting": setState("connecting"); break;
    case "connected": setState("listening"); break;
    case "user-speaking": setState("user-speaking"); break;
    case "processing": setState("processing"); break;
    case "ai-speaking": setState("ai-speaking"); break;
    case "closed": setState("idle"); break;
    case "error": setState("error"); break;
  }
}

function onFatalError(error) {
  console.error("[main] fatal:", error);
  setState("error");
  setCaption(showRealtimeError(error), "error");
}

function onQueuePosition(position) {
  setState("queued");
  queuePosition.textContent = `排队位置: ${position}`;
}

async function activateTts(s, textOnly = false) {
  if (!s.ttsModel) throw new Error("没有可用的本地 TTS 模型，请先在 WebUI 安装模型");
  const url = new URL(`${realtimeApiBase}/activate`, window.location.origin);
  const response = await fetch(url.href, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...appConfigFromSettings(s), input_mode: textOnly ? "text" : "voice" }),
  });
  if (!response.ok) {
    let message = `TTS 模型准备失败（HTTP ${response.status}）`;
    try {
      const body = await response.json();
      if (body?.detail) message = String(body.detail);
    } catch { /* keep the status message */ }
    throw Object.assign(new Error(message), { code: "tts_activation", stage: "tts" });
  }
  return response.json();
}

async function doStart(textOnly = false) {
  if (client && LIVE_STATES.has(currentState)) {
    if (!textOnly && client.options.textOnly) {
      const activeClient = client;
      await activateTts(settings, false);
      if (client !== activeClient) return;
      await activeClient.enableMicrophone();
      if (client !== activeClient) return;
      setState(currentState);
    }
    return;
  }
  if (currentState === "idle" || currentState === "error") {
    if (client) await doStop();
    const attempt = ++connectionAttempt;
    chat.clear();
    hideRealtimeError();
    setState("connecting");
    setCaption(textOnly ? "正在连接对话服务…" : "请求麦克风权限…", "muted");
    if (!audioContext || audioContext.state === "closed") audioContext = createResumedAudioContext();
    try { if (!textOnly) await primeMicPermission(); } catch (err) {
      if (audioContext) void audioContext.close().catch(() => {});
      audioContext = null;
      throw err;
    }
    try {
      await refreshEnvDefaults();
      await refreshReferenceLibrary();
      if (attempt !== connectionAttempt) return;
      if (!realtimeConfigReady) throw new Error("实时服务尚未就绪，请重启应用后重试。");
      setCaption("正在准备对话模型…", "muted");
      await activateTts(settings, textOnly);
      if (attempt !== connectionAttempt) return;
    } catch (err) {
      if (micStream) {
        for (const track of micStream.getTracks()) track.stop();
        micStream = null;
      }
      if (audioContext) void audioContext.close().catch(() => {});
      audioContext = null;
      throw err;
    }
    const gateThreshold = Number(settings.noiseGate) || GATE_DEFAULT_DB;
    const liveCharacter = await liveCharacterReady;
    if (attempt !== connectionAttempt) return;
    const c = new S2sWsRealtimeClient({
      directUrl: new URL(`${realtimeApiBase}/v1/realtime`, window.location.origin).href.replace(/^http/, "ws"),
      instructions: characterInstructions(settings),
      voice: appConfigFromSettings(settings).tts_voice,
      appConfig: appConfigFromSettings(settings),
      textOnly,
      acquireMic: acquireMicStream,
      noiseGate: { enabled: gateThreshold > GATE_OFF_DB, thresholdDb: gateThreshold },
      ...(audioContext ? { audioContext } : {}),
    });
    client = c;
    liveCharacter?.attachClient(c);
    c.addEventListener("queue", (e) => {
      const { position, queueId } = /** @type {CustomEvent} */ (e).detail;
      if (queueId) queuedTicketId = queueId;
      onQueuePosition(position);
    });
    c.addEventListener("ready-to-join", () => {
      setState("your-turn");
      queueFunnelMsg.textContent = "已就绪！点击加入开始对话。";
    });
    c.addEventListener("status", (e) => { if (client === c) onClientStatus(/** @type {CustomEvent} */ (e).detail.status); });
    c.addEventListener("transcript", (e) => { if (client === c) chat.onTranscript(/** @type {CustomEvent} */ (e).detail); });
    c.addEventListener("response-finished", (e) => { if (client === c) chat.onResponseFinished(/** @type {CustomEvent} */ (e).detail); });
    c.addEventListener("error", (e) => { if (client === c) { void doStop().then(() => onFatalError(/** @type {CustomEvent} */ (e).detail.error)); } });
    c.addEventListener("server-error", (e) => {
      const error = /** @type {CustomEvent} */ (e).detail.error;
      console.warn("[main] server error (non-fatal):", error);
      showRealtimeError(error);
    });
    c.addEventListener("input-level", (e) => {
      paintInputLevel(/** @type {CustomEvent} */ (e).detail.rms);
    });
    try { await c.connect(); if (client === c) chat.reset(); } catch (err) {
      if (client === c) await doStop();
      if (audioContext) void audioContext.close().catch(() => {});
      audioContext = null;
      throw err;
    }
  }
}

async function doStop() {
  connectionAttempt++;
  const activeClient = client;
  client = null;
  if (activeClient) {
    try {
      await activeClient.close();
    } catch (err) {
      console.warn("[main] error closing client:", err);
    }
  } else if (audioContext && audioContext.state !== "closed") {
    try {
      await audioContext.close();
    } catch {
      // ignored
    }
  }
  audioContext = null;
  if (micStream) {
    for (const track of micStream.getTracks()) track.stop();
    micStream = null;
  }
  paintInputLevel(0);
  muted = false;
  micBtn.classList.remove("muted");
  queueBar.hidden = true;
  queueFunnel.hidden = true;
  queuedTicketId = "";
  setState("idle");
}

// ── Events ─────────────────────────────────────────────────────────────
circleBtn.addEventListener("click", async () => {
  try {
    if (currentState === "idle" || currentState === "error" || client?.options.textOnly) {
      await doStart();
    }
  } catch (err) {
    onFatalError(err);
  }
});

stopBtn.addEventListener("click", () => { void doStop(); });

const textToggle = document.getElementById("text-toggle");
const textComposer = document.getElementById("text-composer");
const textInput = /** @type {HTMLTextAreaElement} */ (document.getElementById("text-input"));
const textSend = /** @type {HTMLButtonElement} */ (document.getElementById("text-send"));
textToggle.addEventListener("click", () => {
  textComposer.hidden = !textComposer.hidden;
  textToggle.setAttribute("aria-expanded", String(!textComposer.hidden));
  textToggle.setAttribute("aria-label", textComposer.hidden ? "展开文字输入" : "收起文字输入");
  document.body.classList.toggle("text-input-open", !textComposer.hidden);
  if (!textComposer.hidden) textInput.focus();
});
textInput.addEventListener("input", () => {
  textInput.style.height = "auto";
  textInput.style.height = `${Math.min(textInput.scrollHeight, 144)}px`;
});
textInput.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    textComposer.requestSubmit();
  }
});
textComposer.addEventListener("submit", async event => {
  event.preventDefault();
  const text = textInput.value.trim();
  if (!text || textSend.disabled || currentState === "connecting") return;
  textSend.disabled = true;
  try {
    hideRealtimeError();
    await doStart(true);
    if (!client) return;
    client.sendText(text);
    if (textInput.value.trim() === text) {
      textInput.value = "";
      textInput.style.height = "auto";
    }
  } catch (error) {
    if (!client) setState("error");
    showRealtimeError(error);
  }
  finally { textSend.disabled = false; textInput.focus(); }
});
document.getElementById("text-cancel").addEventListener("click", () => client?.cancelResponse());

micBtn.addEventListener("click", () => {
  muted = !muted;
  micBtn.classList.toggle("muted", muted);
  micBtn.setAttribute("aria-label", muted ? "取消静音" : "静音");
  client?.setMuted(muted);
  setState(currentState);
});

queueLeave.addEventListener("click", () => { void doStop(); });
queueFunnelLeave?.addEventListener("click", () => { void doStop(); });
queueFunnelJoin?.addEventListener("click", () => {
  queueFunnel.hidden = true;
  client?.join();
});

realtimeNoticeDismiss.addEventListener("click", hideRealtimeError);
realtimeNoticeSettings.addEventListener("click", () => settingsBtn.click());

// ── Settings modal ─────────────────────────────────────────────────────
function updateLlmKeyStatus() {
  const entered = settingsFields.llmKey.value.trim();
  document.getElementById("llm-key-status").textContent = entered && entered !== settings.llmKey
    ? "新密钥尚未保存，请点击保存设置。"
    : settings.llmKey ? "已保存在此浏览器；留空保留，输入新密钥可替换。"
    : envDefaults.llm_api_key_set ? "使用启动配置中的密钥；输入新密钥可替换。"
    : "保存在此浏览器；输入后点击保存设置。";
}
settingsFields.llmKey.addEventListener("input", updateLlmKeyStatus);

function fillSettingsForm() {
  characterEditEpoch++;
  characterDraft = structuredClone(settings.characters);
  renderTtsModelOptions();
  renderVoiceOptions();
  renderMicrophoneOptions();
  for (const [k, el] of Object.entries(settingsFields)) {
    if (el) el.value = settings[k] ?? "";
  }
  fillCharacterForm();
  document.getElementById("character-advanced").open = false;
  if (settingsFields.llmKey) settingsFields.llmKey.placeholder =
    settings.llmKey || envDefaults.llm_api_key_set ? "已配置；留空保留，输入新密钥替换" : "填写服务商提供的 API Key";
  updateLlmKeyStatus();
  syncTtsSettingsUi(
    !settings.ttsInferenceSteps || !settings.ttsVocoderMergeSteps,
  );
}

function readSettingsForm() {
  const s = { ...settings };
  for (const [k, el] of Object.entries(settingsFields)) {
    if (k === "rtUrl") continue;
    if (k === "llmKey") {
      const key = el?.value.trim();
      if (key) s[k] = key;
    } else if (el) s[k] = el.value;
  }
  readCharacterForm();
  s.characters = structuredClone(characterDraft);
  return s;
}

settingsBtn?.addEventListener("click", () => {
  fillSettingsForm();
  syncGateUi();
  settingsModal?.showModal();
  void refreshEnvDefaults();
  void refreshReferenceLibrary();
  void refreshMicrophones().catch(error => console.warn("麦克风列表刷新失败", error));
});

settingsForm?.addEventListener("submit", (e) => {
  // The dialog's submit button (value="save") closes the dialog; we just read
  // the form on close. Nothing to do here on submit itself.
});

settingsModal?.addEventListener("close", () => {
  document.getElementById("tts-reference-preview").pause();
  const rv = settingsModal.returnValue;
  if (rv !== "save") {
    characterDraft = structuredClone(settings.characters);
    applyCharacterProfile(currentCharacter(settings.characters));
    return;
  }
  const previous = settings;
  const next = readSettingsForm();
  settings = next;
  saveSettings(next);
  applyCharacterProfile(currentCharacter(settings.characters));
  hideRealtimeError();
  syncGateUi();
  syncTtsSettingsUi(false);
  updateSetupSummary();
  // Server/model/mode changes need a model activation transaction before the
  // microphone resumes. Voice/options and LLM values can apply live.
  if (client) {
    const reconnectKeys = [
      "rtUrl", "ttsUrl", "ttsModel", "ttsServerSource", "ttsPlaybackMode",
      "asrUrl", "asrModel", "micDeviceId",
    ];
    const reconnect = reconnectKeys.some((key) => next[key] !== previous[key]);
    if (reconnect) {
      void doStop().then(() => setCaption("设置已保存，请点击开始新对话", "muted"));
    } else {
      client.updateAppConfig(appConfigFromSettings(next));
      const thr = Number(settings.noiseGate);
      client.setNoiseGate({ enabled: thr > GATE_OFF_DB, thresholdDb: thr });
    }
  }
});

// Cleanup on page unload
window.addEventListener("beforeunload", () => { void doStop(); });
window.addEventListener("pagehide", () => { void doStop(); });
document.querySelector("#setup-check")?.addEventListener("click", () => { void checkSetup(); });
for (const button of document.querySelectorAll("[data-setup]")) {
  button.addEventListener("click", () => {
    if (!settingsModal.open) settingsBtn.click();
    document.querySelector(`#${button.getAttribute("data-setup")}`)?.scrollIntoView({ block: "center" });
  });
}
// Only same-origin UI preferences are shared with the shell; no service
// settings, transcripts, or credentials are sent via postMessage.
if (window.parent !== window) document.body.classList.add("embedded");
function applyTheme(theme, palette) {
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.palette = palette === "classic" ? "classic" : "studio";
}
const shellTheme = localStorage.getItem("audiocpp-workbench-theme") || "light";
applyTheme(shellTheme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : shellTheme,
  localStorage.getItem("audiocpp-workbench-palette") || "studio");
window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin || event.source !== window.parent) return;
  if (event.data?.type === "audiocpp:theme") applyTheme(event.data.theme, event.data.palette);
  if (event.data?.type === "audiocpp:realtime-stop") void doStop();
});

// ── Init ───────────────────────────────────────────────────────────────
chat = new ChatView();
applyCharacterProfile(currentCharacter(settings.characters));
initGateArc();
syncGateUi();
setState("idle");
chat.renderEmptyState();
// Pull env defaults (TTS/ASR/LLM URLs, voice_ref, ...) from the backend so the
// Settings panel pre-fills with what run_realtime.bat configured. Non-blocking;
// Omitted fields retain backend defaults; explicit empty voice fields clear them.
void refreshEnvDefaults();
void refreshReferenceLibrary();
window.addEventListener("character-error", event => showRealtimeError(event.detail));
// Strip booting class after first paint
requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove("booting")));
