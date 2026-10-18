import {t,uiText,uiAttr,rawText,setLanguage,applyLanguage} from '/studio-copy/i18n.js';
(() => {
  const overlay = document.getElementById("overlay");
  const stateLabel = document.getElementById("state-label");
  const modeBadge = document.getElementById("mode-badge");
  const notice = document.getElementById("notice");
  const transcript = document.getElementById("transcript");
  const modelName = document.getElementById("model-name");
  const latency = document.getElementById("latency-value");
  const connection = document.getElementById("connection");
  const closeButton = document.getElementById("close-button");
  const compactButton = document.getElementById("compact-button");
  const dragHandle = document.getElementById("drag-handle");
  const canvas = document.getElementById("waveform");
  const ctx = canvas.getContext("2d");

  let placeholder = "按 Ctrl + Alt + F9 开始听写";
  let state = "idle";
  let targetLevel = 0;
  let displayLevel = 0;
  let levelAt = 0;
  let finalAt = 0;
  let socket;
  let reconnectAttempt = 0;
  const reconnectDelays = [500, 1000, 2000, 5000];
  let compact = false;
  const states = {idle:'准备就绪',connecting:'正在连接',listening:'正在听写',finalizing:'正在整理',error:'识别出错'};
  const notices = {'READY':'准备就绪','PASTED':'已输入文字','COPIED — TARGET CHANGED':'已复制 · 输入窗口已切换',
    'COPIED - TARGET CHANGED':'已复制 · 输入窗口已切换','NO SPEECH DETECTED':'未检测到语音','CANCELLED':'已取消',
    'SEGMENT DETECTED':'正在识别语音片段'};

  async function toggleCompact() {
    compactButton.disabled=true;
    try {
      if(!window.pywebview?.api?.set_compact){uiText(notice, '请重启 SpeakType 以使用窗口操作');return;}
      compact=await window.pywebview.api.set_compact(!compact);
      document.body.classList.toggle('compact',compact);
      uiText(compactButton, compact?'↗':'−');
      uiAttr(compactButton, 'title', compact?'展开听写悬浮窗':'收起，听写继续运行');
      uiAttr(compactButton, 'aria-label', compact?'展开听写悬浮窗':'收起，听写继续运行');
      compactButton.setAttribute('aria-expanded',String(!compact));
      resizeCanvas();
    } catch (_) {uiText(notice, '窗口调整失败，请重试');}
    finally {compactButton.disabled=false;}
  }

  async function closeApplication() {
    closeButton.disabled = true;
    uiText(connection, "正在退出");
    try {
      if (window.pywebview?.api?.close) {
        await window.pywebview.api.close();
      } else {
        window.close();
      }
    } catch (_) {
      closeButton.disabled = false;
      uiText(connection, "退出失败");
    }
  }

  function setState(next) {
    state = next || "idle";
    overlay.className = `overlay state-${state}`;
    uiText(stateLabel, states[state] || state);
    if(state==='connecting'){finalAt=0;setTranscript('');}
    if(state==='listening')uiText(notice, '停顿后自动识别');
    if(state==='finalizing')uiText(notice, '正在完成最后一句');
    if (state !== "listening") targetLevel = 0;
  }

  function setTranscript(text, className = "") {
    if(text)rawText(transcript,text);else uiText(transcript,placeholder);
    transcript.className = `transcript ${text ? "" : "placeholder"} ${className}`.trim();
    transcript.title = text || t(placeholder);
    transcript.scrollTop = transcript.scrollHeight;
  }

  function formatHotkey(spec) {
    return String(spec)
      .split("+")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" + ");
  }

  function applyConfig(message) {
    setLanguage(message.ui_language);
    if (message.model) modelName.textContent = message.model;
    if (message.mode) modeBadge.textContent = message.mode;
    if (message.toggle_hotkey) {
      placeholder = `按 ${formatHotkey(message.toggle_hotkey)} 开始听写`;
      uiAttr(dragHandle, 'title', `按住拖动 · ${formatHotkey(message.toggle_hotkey)} 启停 · ${formatHotkey(message.cancel_hotkey||'esc')} 取消`);
      if (transcript.classList.contains("placeholder")) setTranscript("");
    }
  }

  function handle(message) {
    switch (message.type) {
      case "config":
        applyConfig(message);
        break;
      case "state":
        setState(message.value);
        break;
      case "level":
        // The server sends RMS * 3.6. A speech-oriented dB scale makes normal
        // microphone levels visible without changing the audio sent to ASR.
        const rms = Math.max(0, Math.min(1, Number(message.value) || 0)) / 3.6;
        targetLevel = rms > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 42)) : 0;
        levelAt = performance.now();
        break;
      case "partial":
        if (!message.text && finalAt > 0) break;
        setTranscript(message.text || "");
        if (message.latency_ms != null) latency.textContent = String(message.latency_ms);
        break;
      case "final":
        finalAt = performance.now();
        setTranscript(message.text || "", "final-flash");
        if (message.latency_ms != null) latency.textContent = String(message.latency_ms);
        setTimeout(() => transcript.classList.remove("final-flash"), 280);
        break;
      case "notice":
        uiText(notice, notices[message.message] || message.message || "准备就绪");
        uiAttr(notice, 'title', notices[message.message] || message.message || '准备就绪');
        break;
      case "error":
        setState("error");
        uiText(notice, "请检查模型与语言");
        setTranscript(String(message.message||'语音识别失败').includes('<|auto|>')?
          '此模型不支持自动语言，请退出听写，在工作台选择实际语言后重新启动。':message.message || "语音识别失败", "error-text");
        break;
      default:
        break;
    }
  }

  function connect() {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${protocol}://${location.host}/ws/ui`);
    uiText(connection, "正在连接");
    socket.onopen = () => {
      reconnectAttempt = 0;
      uiText(connection, "已连接");
    };
    socket.onmessage = (event) => {
      try {
        handle(JSON.parse(event.data));
      } catch (_) {
        uiText(connection, "状态异常");
      }
    };
    socket.onclose = () => {
      uiText(connection, "正在重连");
      const delay = reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)];
      reconnectAttempt += 1;
      setTimeout(connect, delay);
    };
    socket.onerror = () => socket.close();
  }

  function resizeCanvas() {
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function drawWave(time) {
    if(compact){requestAnimationFrame(drawWave);return;}
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const level = state === 'listening' && time - levelAt < 350 ? targetLevel : 0;
    displayLevel += (level - displayLevel) * (level > displayLevel ? 0.45 : 0.12);
    ctx.clearRect(0, 0, width, height);
    const count = Math.max(12, Math.floor(width / 9));
    const gap = 4;
    const barWidth = Math.max(1.25, (width - gap * (count - 1)) / count);
    const center = height / 2;
    for (let i = 0; i < count; i += 1) {
      const envelope = Math.sin((i / (count - 1)) * Math.PI) ** 0.68;
      const movement = 0.7 + Math.sin(time * 0.008 + i * 0.7) * 0.3;
      const h = 2 + envelope * movement * displayLevel * (height - 4);
      const alpha = 0.18 + envelope * (state === "listening" ? 0.74 : 0.27);
      ctx.fillStyle = `rgba(86, 246, 210, ${alpha})`;
      ctx.beginPath();
      ctx.roundRect(i * (barWidth + gap), center - h / 2, barWidth, h, barWidth / 2);
      ctx.fill();
    }
    requestAnimationFrame(drawWave);
  }

  applyLanguage();
  window.addEventListener("resize", resizeCanvas);
  closeButton.addEventListener("click", closeApplication);
  compactButton.addEventListener('click',toggleCompact);
  // Do not use browser/native title-bar dragging: it can activate a tool window.
  dragHandle.addEventListener('mousedown',event=>{
    if(event.button!==0)return;
    event.preventDefault();
    window.pywebview?.api?.start_drag?.().catch(()=>{uiText(notice, '暂时无法移动窗口');});
  });
  for(const button of [closeButton,compactButton])button.addEventListener('mousedown',event=>event.preventDefault());
  resizeCanvas();
  requestAnimationFrame(drawWave);
  connect();
})();
