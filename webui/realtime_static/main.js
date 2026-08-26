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
import { ChatView } from "./ui/chat.js";
import { $, truncateError, DEBUG } from "./ui/dom.js";

// ── Settings (persisted in localStorage) ───────────────────────────────
const DEFAULT_RT_URL = "ws://127.0.0.1:8765/v1/realtime";
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
  ttsVoiceRef: "audiocpp.tts.voiceRef",
  ttsRefText: "audiocpp.tts.refText",
  asrUrl: "audiocpp.asr.url",
  asrModel: "audiocpp.asr.model",
  asrLanguage: "audiocpp.asr.language",
  llmUrl: "audiocpp.llm.url",
  llmModel: "audiocpp.llm.model",
  llmKey: "audiocpp.llm.key",
  instructions: "audiocpp.llm.instructions",
  noiseGate: "audiocpp.noiseGate",
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
  ttsVoiceRef: "",
  ttsRefText: "",
  asrUrl: "http://127.0.0.1:8081",
  asrModel: "qwen3-asr",
  asrLanguage: "",
  llmUrl: "https://api.deepseek.com/v1",
  llmModel: "deepseek-chat",
  llmKey: "",
  instructions: DEFAULT_INSTRUCTIONS,
  noiseGate: String(GATE_DEFAULT_DB),
};

function loadSettings() {
  const s = {};
  for (const [k, def] of Object.entries(DEFAULTS)) {
    if (k === "llmKey") {
      localStorage.removeItem(STORAGE[k]);
      s[k] = def;
      continue;
    }
    const v = localStorage.getItem(STORAGE[k]);
    if (k === "ttsUrl" && v === LEGACY_DEFAULT_TTS_URL) {
      localStorage.removeItem(STORAGE[k]);
      s[k] = def;
      continue;
    }
    s[k] = v === null ? def : v;
  }
  return s;
}

/** Env defaults fetched from the realtime server's /config endpoint. Empty
 *  until the fetch resolves; merged in so the Settings panel pre-fills fields
 *  the user hasn't customized. localStorage still wins over env defaults. */
let envDefaults = {};
/** @type {Array<Record<string, any>>} */
let availableTtsModels = [];

const ENV_SETTING_KEYS = {
  ttsUrl: "tts_server",
  ttsModel: "tts_model",
  ttsServerSource: "tts_server_source",
  ttsPlaybackMode: "tts_playback_mode",
  ttsVoice: "tts_voice",
  ttsVoiceRef: "tts_voice_ref",
  ttsRefText: "tts_reference_text",
  asrUrl: "asr_server",
  asrModel: "asr_model",
  asrLanguage: "asr_language",
  llmUrl: "llm_base_url",
  llmModel: "llm_model",
  instructions: "instructions",
};

async function refreshEnvDefaults() {
  try {
    // The realtime page is served at /realtime/, so the backend root is two
    // levels up. Fall back to same origin if that fails.
    const urls = [
      new URL("../../config", window.location.href).href,
      new URL("/config", window.location.origin).href,
    ];
    for (const u of urls) {
      try {
        const res = await fetch(u, { cache: "no-store" });
        if (res.ok) {
          envDefaults = await res.json();
          availableTtsModels = Array.isArray(envDefaults.tts_models)
            ? envDefaults.tts_models
            : [];
          // Apply: any field the user hasn't set in localStorage takes the env value.
          for (const k of Object.keys(DEFAULTS)) {
            const envKey = ENV_SETTING_KEYS[k];
            if (envKey && envDefaults[envKey] != null && localStorage.getItem(STORAGE[k]) === null) {
              settings[k] = String(envDefaults[envKey]);
            }
          }
          renderTtsModelOptions();
          syncTtsSettingsUi(false);
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
    if (k === "llmKey") {
      localStorage.removeItem(STORAGE[k]);
      continue;
    }
    localStorage.setItem(STORAGE[k], String(s[k] ?? ""));
  }
}

/** Build the `audiocpp` config block sent inside session.update. */
function appConfigFromSettings(s) {
  /** @type {Record<string, any>} */
  const ttsOptions = {};
  const meta = ttsModelMeta(s.ttsModel);
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
  return {
    tts_server: s.ttsUrl,
    tts_model: s.ttsModel,
    tts_server_source: s.ttsServerSource,
    tts_playback_mode: s.ttsPlaybackMode,
    tts_options: ttsOptions,
    tts_voice: s.ttsVoice,
    tts_voice_ref: s.ttsVoiceRef,
    tts_reference_text: s.ttsRefText,
    asr_server: s.asrUrl,
    asr_model: s.asrModel,
    asr_language: s.asrLanguage,
    llm_base_url: s.llmUrl,
    llm_model: s.llmModel,
    llm_api_key: s.llmKey,
    instructions: s.instructions,
  };
}

let settings = loadSettings();

// ── State machine ──────────────────────────────────────────────────────
const STATE_CLASS = {
  idle: "state-idle", connecting: "state-connecting",
  queued: "state-queued", "your-turn": "state-your-turn",
  listening: "state-listening", "user-speaking": "state-user-speaking",
  processing: "state-processing", "ai-speaking": "state-ai-speaking",
  error: "state-error",
};
const STATE_VIEWS = {
  idle:            { caption: "点击开始对话",  disabled: false },
  connecting:      { caption: "连接中",    disabled: true  },
  queued:          { caption: "排队中…", disabled: true },
  "your-turn":     { caption: "准备就绪",  disabled: true  },
  listening:       { caption: "",              disabled: false },
  "user-speaking": { caption: "",              disabled: false },
  processing:      { caption: "正在生成回复",  disabled: false },
  "ai-speaking":   { caption: "正在播放",      disabled: false },
  error:           { caption: "点击重试",  disabled: false },
};
const LIVE_STATES = new Set(["listening", "user-speaking", "processing", "ai-speaking"]);

/** @type {AppState} */
let currentState = "idle";
/** @type {S2sWsRealtimeClient | null} */
let client = null;
/** @type {AudioContext | null} */
let audioContext = null;
/** @type {MediaStream | null} */
let micStream = null;
/** @type {ChatView} */
let chat;

// DOM refs
const circleBtn = /** @type {HTMLButtonElement} */ ($("#main-circle"));
const captionEl = $("#circle-caption");
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
  ttsVoiceRef: $("#tts-voice-ref"),
  ttsRefText: $("#tts-ref-text"),
  asrUrl: $("#asr-url"),
  asrModel: $("#asr-model"),
  asrLanguage: $("#asr-language"),
  llmUrl: $("#llm-url"),
  llmModel: $("#llm-model"),
  llmKey: $("#llm-key"),
  instructions: $("#instructions"),
  noiseGate: $("#noise-gate"),
};
const ttsModelCapability = $("#tts-model-capability");
const ttsDotsOptions = $("#tts-dots-options");

function ttsModelMeta(modelId) {
  return availableTtsModels.find((model) => model.id === modelId) || null;
}

function ttsModelLabel(model) {
  const badge = model.streaming_kind === "native"
    ? "⚡ 原生流式"
    : model.supports_streaming
      ? "◐ 分段流式"
      : "完整 WAV";
  return `${badge} · ${model.label || model.id}`;
}

function renderTtsModelOptions() {
  const select = /** @type {HTMLSelectElement | null} */ (settingsFields.ttsModel);
  if (!select) return;
  const currentValue = select.value;
  select.innerHTML = "";
  if (!availableTtsModels.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "未检测到本地已安装的 TTS 模型";
    select.append(option);
    select.disabled = true;
    settings.ttsModel = "";
    return;
  }
  select.disabled = false;
  for (const model of availableTtsModels) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = ttsModelLabel(model);
    select.append(option);
  }
  const installedIds = new Set(availableTtsModels.map((model) => model.id));
  const selected = installedIds.has(currentValue)
    ? currentValue
    : installedIds.has(settings.ttsModel)
    ? settings.ttsModel
    : installedIds.has(envDefaults.tts_model)
      ? envDefaults.tts_model
      : availableTtsModels[0].id;
  settings.ttsModel = selected;
  select.value = selected;
}

function syncTtsSettingsUi(applyModelDefaults = false) {
  const meta = ttsModelMeta(settingsFields.ttsModel?.value || settings.ttsModel);
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
      ttsModelCapability.textContent = "请先在本地 WebUI 安装一个 TTS 模型。";
    } else if (meta.streaming_kind === "native") {
      ttsModelCapability.textContent =
        `原生细粒度流式 · PCM16 ${meta.stream_sample_rate || "?"} Hz；自动模式将边生成边播放。`;
    } else if (meta.supports_streaming) {
      ttsModelCapability.textContent =
        `分段流式 · PCM16 ${meta.stream_sample_rate || "?"} Hz；每个模型文本段完成后立即播放。`;
    } else {
      ttsModelCapability.textContent = "非流式模型；自动模式保持完整 WAV 兼容调用。";
    }
  }
}

settingsFields.ttsModel?.addEventListener("change", () => {
  syncTtsSettingsUi(true);
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
  const view = STATE_VIEWS[next];
  circleBtn.disabled = view.disabled;
  circleBtn.className = `circle ${STATE_CLASS[next]}`;
  if (next === "error") setCaption(view.caption, "error");
  else setCaption(view.caption, "");
  // Live indicator: side buttons appear + gate arc lights up
  const wrap = circleBtn.closest(".orb-wrap");
  if (wrap) {
    if (LIVE_STATES.has(next)) wrap.classList.add("live");
    else wrap.classList.remove("live");
  }
  // Show/hide queue UI
  queueBar.hidden = next !== "queued";
  queueFunnel.hidden = next !== "your-turn";
}

function setCaption(text, kind) {
  const trimmed = text.trim();
  captionEl.textContent = trimmed;
  captionEl.className = `circle-caption${kind ? ` ${kind}` : ""}${trimmed ? "" : " empty"}`;
}

// ── Audio ──────────────────────────────────────────────────────────────
const MIC_CONSTRAINTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };

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
  try {
    const s = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    for (const track of s.getTracks()) track.stop();
  } catch (err) {
    throw new Error(`Microphone access denied${err instanceof Error ? `: ${err.message}` : ""}`);
  }
}

/** @returns {Promise<MediaStream>} */
async function acquireMicStream() {
  micStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
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
  const msg = error instanceof Error ? error.message : String(error);
  setCaption(truncateError(msg), "error");
}

function onQueuePosition(position) {
  setState("queued");
  queuePosition.textContent = `排队位置: ${position}`;
}

async function activateTts(s) {
  if (!s.ttsModel) throw new Error("没有可用的本地 TTS 模型，请先在 WebUI 安装模型");
  const url = new URL(s.rtUrl || DEFAULT_RT_URL);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/activate";
  url.search = "";
  url.hash = "";
  const response = await fetch(url.href, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(appConfigFromSettings(s)),
  });
  if (!response.ok) {
    let message = `TTS 模型准备失败（HTTP ${response.status}）`;
    try {
      const body = await response.json();
      if (body?.detail) message = String(body.detail);
    } catch { /* keep the status message */ }
    throw new Error(message);
  }
  return response.json();
}

async function doStart() {
  if (currentState === "idle" || currentState === "error") {
    chat.clear();
    setState("connecting");
    setCaption("请求麦克风权限…", "muted");
    if (!audioContext || audioContext.state === "closed") audioContext = createResumedAudioContext();
    try { await primeMicPermission(); } catch (err) {
      if (audioContext) void audioContext.close().catch(() => {});
      audioContext = null;
      throw err;
    }
    if (!availableTtsModels.length) await refreshEnvDefaults();
    setCaption("正在准备 TTS 模型…", "muted");
    try {
      await activateTts(settings);
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
    const c = new S2sWsRealtimeClient({
      directUrl: settings.rtUrl,
      instructions: settings.instructions,
      voice: settings.ttsVoice,
      appConfig: appConfigFromSettings(settings),
      acquireMic: acquireMicStream,
      noiseGate: { enabled: gateThreshold > GATE_OFF_DB, thresholdDb: gateThreshold },
      ...(audioContext ? { audioContext } : {}),
    });
    client = c;
    c.addEventListener("queue", (e) => {
      const { position, queueId } = /** @type {CustomEvent} */ (e).detail;
      if (queueId) queuedTicketId = queueId;
      onQueuePosition(position);
    });
    c.addEventListener("ready-to-join", () => {
      setState("your-turn");
      queueFunnelMsg.textContent = "已就绪！点击加入开始对话。";
    });
    c.addEventListener("status", (e) => onClientStatus(/** @type {CustomEvent} */ (e).detail.status));
    c.addEventListener("transcript", (e) => chat.onTranscript(/** @type {CustomEvent} */ (e).detail));
    c.addEventListener("response-finished", (e) => chat.onResponseFinished(/** @type {CustomEvent} */ (e).detail));
    c.addEventListener("error", (e) => onFatalError(/** @type {CustomEvent} */ (e).detail.error));
    c.addEventListener("server-error", (e) => {
      console.warn("[main] server error (non-fatal):", /** @type {CustomEvent} */ (e).detail.error);
    });
    c.addEventListener("input-level", (e) => {
      paintInputLevel(/** @type {CustomEvent} */ (e).detail.rms);
    });
    try { await c.connect(); chat.reset(); } catch (err) {
      if (audioContext) void audioContext.close().catch(() => {});
      audioContext = null;
      throw err;
    }
  }
}

async function doStop() {
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
    if (currentState === "idle" || currentState === "error") {
      await doStart();
    }
  } catch (err) {
    onFatalError(err);
  }
});

stopBtn.addEventListener("click", () => { void doStop(); });

micBtn.addEventListener("click", () => {
  muted = !muted;
  micBtn.classList.toggle("muted", muted);
  micBtn.setAttribute("aria-label", muted ? "Unmute" : "Mute");
  client?.setMuted(muted);
});

queueLeave.addEventListener("click", () => { void doStop(); });
queueFunnelLeave?.addEventListener("click", () => { void doStop(); });
queueFunnelJoin?.addEventListener("click", () => {
  queueFunnel.hidden = true;
  client?.join();
});

// ── Settings modal ─────────────────────────────────────────────────────
function fillSettingsForm() {
  renderTtsModelOptions();
  for (const [k, el] of Object.entries(settingsFields)) {
    if (el) el.value = settings[k] ?? "";
  }
  syncTtsSettingsUi(
    !settings.ttsInferenceSteps || !settings.ttsVocoderMergeSteps,
  );
}

function readSettingsForm() {
  const s = { ...settings };
  for (const [k, el] of Object.entries(settingsFields)) {
    if (el) s[k] = el.value;
  }
  return s;
}

settingsBtn?.addEventListener("click", () => {
  fillSettingsForm();
  syncGateUi();
  settingsModal?.showModal();
  void refreshEnvDefaults();
});

settingsForm?.addEventListener("submit", (e) => {
  // The dialog's submit button (value="save") closes the dialog; we just read
  // the form on close. Nothing to do here on submit itself.
});

settingsModal?.addEventListener("close", () => {
  const rv = settingsModal.returnValue;
  if (rv !== "save") return;
  const previous = settings;
  const next = readSettingsForm();
  settings = next;
  saveSettings(next);
  syncGateUi();
  syncTtsSettingsUi(false);
  // Server/model/mode changes need a model activation transaction before the
  // microphone resumes. Voice/options and ASR/LLM values can apply live.
  if (client) {
    const reconnectKeys = [
      "rtUrl", "ttsUrl", "ttsModel", "ttsServerSource", "ttsPlaybackMode",
    ];
    const reconnect = reconnectKeys.some((key) => next[key] !== previous[key]);
    if (reconnect) {
      void (async () => {
        await doStop();
        setTimeout(() => { void doStart(); }, 150);
      })();
    } else {
      client.updateAppConfig(appConfigFromSettings(next));
      const thr = Number(settings.noiseGate);
      client.setNoiseGate({ enabled: thr > GATE_OFF_DB, thresholdDb: thr });
    }
  }
});

// Cleanup on page unload
window.addEventListener("beforeunload", () => { void doStop(); });

// ── Init ───────────────────────────────────────────────────────────────
chat = new ChatView();
initGateArc();
syncGateUi();
setState("idle");
chat.renderEmptyState();
// Pull env defaults (TTS/ASR/LLM URLs, voice_ref, ...) from the backend so the
// Settings panel pre-fills with what run_realtime.bat configured. Non-blocking;
// if a session is already starting it still works (env defaults are also the
// backend's fallback for empty browser fields).
void refreshEnvDefaults();
// Strip booting class after first paint
requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove("booting")));
