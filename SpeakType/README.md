# SpeakType

SpeakType 是一个 Windows 本地语音输入演示客户端。它使用 pywebview 显示不抢焦点的底部悬浮条，通过全局热键录音，把音频交给本机 `audio.cpp` ASR 服务，并且只在收到 `final` 后向原目标窗口输入文本。

## 当前协议状态

项目已按本机 `D:\AItools\audio.cpp` 当前服务实现接入真实协议：

- `POST http://127.0.0.1:8081/v1/audio/transcriptions`
- `multipart/form-data`：`model`、`stream=true`、可选 `language`、WAV `file`
- `Accept: text/event-stream`
- partial：`transcript.text.delta`
- final：`transcript.text.done`
- 结束：`data: [DONE]`

当前版本的 audio.cpp 服务会先读取一个请求的完整 HTTP 请求体，再运行模型并返回 SSE；它不是持续推送麦克风帧的 WebSocket。SpeakType 因此在客户端运行 Silero VAD：持续采集麦克风，在静音处切出一句完整音频，立即按顺序 POST 每个语音段，并在录音仍继续时接收该段的 SSE partial/final。界面标记为 `VAD + SSE`。未来服务提供持久会话、WebSocket 或真正的分块输入接口时，只需替换 `app/asr/streaming.py`。

## 安装

依赖随 audio.cpp 整合包/开发环境统一管理，**无需单独安装**：整合包的 `venv`（以及仓库开发用的
`D:\AItools\audio.cpp\venv`）已预装本项目所需的全部包（`sounddevice / pywebview / pywin32 /
pyperclip` + `torch`）。VAD 使用随本目录自带的 `third_party/silero-vad`，不依赖 pip `silero-vad`。
全项目统一依赖清单见仓库根 `requirements.txt`。

## 启动

1. 先启动流式 ASR 服务（整合包内，另开一个窗口）：`run_server_asr_stream.bat`
   —— `nemotron-asr` 监听 `127.0.0.1:8081`，`mode=streaming`。
2. 双击本目录的 `run_speaktype.bat` 即可。它会自动使用相邻的 `..\venv`（开发时=仓库 venv，
   整合包内=bundle venv）。也可从整合包根目录用 `run_speaktype.bat`（瘦转发到本脚本）。

也可以双击 `run_speaktype.pyw` 启动无控制台窗口版本。

没有启动 C++ 服务时，用 Mock 完整演示 UI、partial/final、热键和文本注入：

```powershell
run_speaktype.bat --mock
```

也可以双击 `run_mock.pyw` 启动无控制台窗口的 Mock 演示。

## 操作

- `Ctrl + Shift + Space`：开始录音；再按一次停止并提交。（可在 `config.json` 的 `hotkeys.toggle_recording` 改；悬浮窗提示会自动跟随该配置。）
- `Esc`：取消当前尚未提交的片段。
- 开始录音前先让记事本、浏览器输入框或编辑器获得焦点。
- 如果 final 到达时前台窗口已改变，文本只会复制到剪贴板，界面显示 `COPIED — TARGET CHANGED`。

悬浮窗使用唯一标题和当前 PID 查找 HWND，并应用 `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`。默认不会点击穿透，方便调试；可在 `config.json` 中设置 `ui.click_through=true`。

## 配置

主要配置位于 `config.json`：

- `asr.base_url` 和 `asr.stream_url` 仅允许解析到 `127.0.0.1`。
- `asr.transport=streaming` 使用 audio.cpp SSE 适配器；其他值使用普通文件转写降级模式。
- `asr.final_timeout_s` 包含停止录音后的上传和推理时间，默认 30 秒。
- `asr.language=auto` 会作为真实 multipart 字段发送；`trailing_silence_ms` 默认给每段追加 400ms 静音，避免句尾音节未被 RNNT 刷出。
- `vad.threshold`、`min_speech_duration_ms`、`min_silence_duration_ms`、`speech_pad_ms` 和 `max_speech_duration_s` 控制 Silero 切段。
- `demo.mock=true` 可永久启用 Mock；命令行 `--mock` 只影响当前启动。
- `injection.restore_clipboard` 控制纯文本剪贴板是否在粘贴后恢复。

音频默认采集为 16 kHz、单声道、signed 16-bit PCM、20 ms/帧。若默认麦克风不接受 16 kHz，采集线程会使用设备默认采样率，网络线程再线性重采样到 16 kHz。音频回调只复制数据到两秒容量的有界队列；队列满时丢弃最旧帧并写日志。

## 测试

```powershell
..\venv\Scripts\python.exe -m pytest -q
```

自动化测试覆盖状态机、SSE 事件标准化和 `session_id + segment_id` final 去重。日志写入 `logs/app.log`，不会保存原始录音，也不会记录完整 API Key。

## 手动验收建议

1. 运行 `run.py --mock`，打开记事本并按热键录音、停止，确认 final 恰好粘贴一次。
2. 录音后切换到另一个窗口再停止，确认只复制、不误粘贴。
3. 录音中按 `Esc`，确认不提交文本。
4. 关闭应用后重新运行，确认热键已释放。
5. 使用真实服务运行 `run.py`，说一句话后停顿约半秒，确认仍在录音时出现 SSE partial/final；停止时确认最后未遇静音的语音段也会提交。
