// @ts-check
/**
 * Buffered PCM playback for the realtime voice client.
 *
 * Incoming audio builds a short jitter buffer before playback. If a live TTS
 * stream runs dry, playback pauses and waits for a larger resume buffer rather
 * than repeatedly exposing tiny bursts separated by silence. The main thread
 * can also force a completed sentence to start with `flush`.
 *
 *   main -> worklet:
 *     { kind: "config", inputRate, startBufferMs, resumeBufferMs }
 *     { kind: "begin", responseId }
 *     { kind: "audio", samples: Float32Array }
 *     { kind: "flush" }
 *     { kind: "end", responseId }
 *     { kind: "clear" }
 *
 *   worklet -> main:
 *     { kind: "started", responseId }
 *     { kind: "stats", queuedMs, played, playing, rebuffering }
 *     { kind: "underrun", responseId }
 *     { kind: "drained", responseId }
 */

const STATS_INTERVAL_FRAMES = 12000;
const FADE_FRAMES = 32;
const DEFAULT_START_BUFFER_MS = 800;
const DEFAULT_RESUME_BUFFER_MS = 1000;

class AudioPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._inputRate = 16000;
    this._stepRatio = this._inputRate / sampleRate;
    this._startBufferMs = DEFAULT_START_BUFFER_MS;
    this._resumeBufferMs = DEFAULT_RESUME_BUFFER_MS;
    this._queue = [];
    this._readIdx = 0;
    this._fracPos = 0;
    this._playing = false;
    this._needsRebuffer = false;
    this._streamEnded = true;
    this._responseId = "";
    this._drainedPosted = true;
    this._framesSinceStats = 0;
    this._totalPlayed = 0;
    this._fadeIn = 0;
    this._fadeOut = 0;
    this._lastSample = 0;

    this.port.onmessage = (e) => {
      const data = e.data;
      if (!data || typeof data !== "object") return;
      switch (data.kind) {
        case "config":
          if (typeof data.inputRate === "number" && data.inputRate > 0) {
            this._inputRate = data.inputRate;
            this._stepRatio = this._inputRate / sampleRate;
          }
          if (typeof data.startBufferMs === "number" && data.startBufferMs >= 0) {
            this._startBufferMs = data.startBufferMs;
          }
          if (typeof data.resumeBufferMs === "number" && data.resumeBufferMs >= 0) {
            this._resumeBufferMs = data.resumeBufferMs;
          }
          break;
        case "begin":
          this._responseId = typeof data.responseId === "string" ? data.responseId : "";
          this._streamEnded = false;
          this._drainedPosted = false;
          break;
        case "audio":
          if (data.samples instanceof Float32Array && data.samples.length > 0) {
            this._queue.push(data.samples);
            this._streamEnded = false;
            this._drainedPosted = false;
            this._maybeStart(false);
          }
          break;
        case "flush":
          this._maybeStart(true);
          break;
        case "end":
          this._streamEnded = true;
          this._maybeStart(true);
          if (!this._playing && this._queue.length === 0) this._postDrained();
          break;
        case "clear":
          this._queue.length = 0;
          this._readIdx = 0;
          this._fracPos = 0;
          this._playing = false;
          this._needsRebuffer = false;
          this._streamEnded = true;
          this._drainedPosted = true;
          this._fadeIn = 0;
          this._fadeOut = 0;
          this._lastSample = 0;
          this._responseId = "";
          break;
      }
    };
  }

  _queuedSamples() {
    let total = -this._readIdx;
    for (const buf of this._queue) total += buf.length;
    return Math.max(0, total);
  }

  _queuedMs() {
    return (this._queuedSamples() / this._inputRate) * 1000;
  }

  _maybeStart(force) {
    if (this._playing || this._queue.length === 0) return;
    const threshold = this._needsRebuffer ? this._resumeBufferMs : this._startBufferMs;
    if (!force && this._queuedMs() < threshold) return;
    this._playing = true;
    this._needsRebuffer = false;
    this._fadeIn = FADE_FRAMES;
    this._fadeOut = 0;
    this.port.postMessage({ kind: "started", responseId: this._responseId });
  }

  _postDrained() {
    if (this._drainedPosted) return;
    this._drainedPosted = true;
    this.port.postMessage({ kind: "drained", responseId: this._responseId });
  }

  /** Linear-interp read at the current fractional position. */
  _readInterpolated() {
    if (this._queue.length === 0) return null;
    const head = this._queue[0];
    const idx = this._readIdx;
    const frac = this._fracPos;

    let a = head[idx];
    let b;
    if (idx + 1 < head.length) {
      b = head[idx + 1];
    } else if (this._queue.length > 1) {
      b = this._queue[1][0];
    } else {
      b = a;
    }
    return a + (b - a) * frac;
  }

  /** Advance the read position by `stepRatio`; pop consumed buffers. */
  _advance() {
    this._fracPos += this._stepRatio;
    while (this._fracPos >= 1) {
      this._fracPos -= 1;
      this._readIdx += 1;
    }
    while (this._queue.length > 0 && this._readIdx >= this._queue[0].length) {
      this._readIdx -= this._queue[0].length;
      this._queue.shift();
    }
  }

  _finishRun() {
    this._playing = false;
    this._lastSample = 0;
    this._fadeOut = 0;
    if (this._streamEnded) {
      this._postDrained();
    } else {
      this._needsRebuffer = true;
      this.port.postMessage({ kind: "underrun", responseId: this._responseId });
    }
  }

  process(_, outputs) {
    const channels = outputs[0];
    if (!channels || channels.length === 0) return true;
    const out = channels[0];
    const stereo = channels.length > 1 ? channels[1] : null;

    for (let i = 0; i < out.length; i++) {
      let sample = 0;

      if (this._playing) {
        const v = this._readInterpolated();
        if (v === null) {
          if (this._fadeOut === 0) this._fadeOut = FADE_FRAMES;
          sample = this._lastSample * (this._fadeOut / FADE_FRAMES);
          this._fadeOut -= 1;
          if (this._fadeOut === 0) this._finishRun();
        } else {
          sample = v;
          this._lastSample = v;
          this._fadeOut = 0;
          this._advance();
        }

        if (this._fadeIn > 0) {
          const gain = 1 - this._fadeIn / FADE_FRAMES;
          sample *= gain;
          this._fadeIn -= 1;
        }

        this._totalPlayed += 1;
      }

      out[i] = sample;
      if (stereo) stereo[i] = sample;
    }

    this._framesSinceStats += out.length;
    if (this._framesSinceStats >= STATS_INTERVAL_FRAMES) {
      this._framesSinceStats = 0;
      this.port.postMessage({
        kind: "stats",
        queuedMs: this._queuedMs(),
        played: this._totalPlayed,
        playing: this._playing,
        rebuffering: this._needsRebuffer,
      });
    }

    return true;
  }
}

registerProcessor("audio-playback", AudioPlaybackProcessor);
