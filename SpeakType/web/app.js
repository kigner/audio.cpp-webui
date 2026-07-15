(() => {
  const overlay = document.getElementById("overlay");
  const stateLabel = document.getElementById("state-label");
  const modeBadge = document.getElementById("mode-badge");
  const notice = document.getElementById("notice");
  const transcript = document.getElementById("transcript");
  const modelName = document.getElementById("model-name");
  const latency = document.getElementById("latency-value");
  const connection = document.getElementById("connection");
  const canvas = document.getElementById("waveform");
  const ctx = canvas.getContext("2d");

  let placeholder = "按 Ctrl + Shift + Space 开始听写";
  let state = "idle";
  let targetLevel = 0;
  let displayLevel = 0;
  let finalAt = 0;
  let socket;
  let reconnectAttempt = 0;
  const reconnectDelays = [500, 1000, 2000, 5000];

  function setState(next) {
    state = next || "idle";
    overlay.className = `overlay state-${state}`;
    stateLabel.textContent = state.toUpperCase();
    if (state !== "listening") targetLevel = 0;
  }

  function setTranscript(text, className = "") {
    transcript.textContent = text || placeholder;
    transcript.className = `transcript ${text ? "" : "placeholder"} ${className}`.trim();
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
    if (message.model) modelName.textContent = message.model;
    if (message.mode) modeBadge.textContent = message.mode;
    if (message.toggle_hotkey) {
      placeholder = `按 ${formatHotkey(message.toggle_hotkey)} 开始听写`;
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
        targetLevel = Math.max(0, Math.min(1, Number(message.value) || 0));
        break;
      case "partial":
        if (!message.text && performance.now() - finalAt < 1600) break;
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
        notice.textContent = message.message || "READY";
        break;
      case "error":
        setState("error");
        notice.textContent = "CHECK LOG";
        setTranscript(message.message || "ASR ERROR", "error-text");
        break;
      default:
        break;
    }
  }

  function connect() {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${protocol}://${location.host}/ws/ui`);
    connection.textContent = "UI CONNECTING";
    socket.onopen = () => {
      reconnectAttempt = 0;
      connection.textContent = "UI CONNECTED";
    };
    socket.onmessage = (event) => {
      try {
        handle(JSON.parse(event.data));
      } catch (_) {
        connection.textContent = "BAD UI EVENT";
      }
    };
    socket.onclose = () => {
      connection.textContent = "UI RECONNECTING";
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
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    displayLevel += (targetLevel - displayLevel) * 0.17;
    ctx.clearRect(0, 0, width, height);
    const count = 68;
    const gap = 3;
    const barWidth = Math.max(1.25, (width - gap * (count - 1)) / count);
    const center = height / 2;
    for (let i = 0; i < count; i += 1) {
      const envelope = Math.sin((i / (count - 1)) * Math.PI) ** 0.68;
      const movement = (Math.sin(time * 0.0045 + i * 0.57) + Math.sin(time * 0.0021 - i * 0.31)) * 0.25 + 0.52;
      const idle = state === "listening" ? 2.3 : 1.2;
      const h = idle + envelope * movement * displayLevel * 35;
      const alpha = 0.18 + envelope * (state === "listening" ? 0.74 : 0.27);
      ctx.fillStyle = `rgba(86, 246, 210, ${alpha})`;
      ctx.beginPath();
      ctx.roundRect(i * (barWidth + gap), center - h / 2, barWidth, h, barWidth / 2);
      ctx.fill();
    }
    requestAnimationFrame(drawWave);
  }

  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();
  requestAnimationFrame(drawWave);
  connect();
})();

