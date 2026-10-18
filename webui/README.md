# Aixora Studio Guide

> **语言 / Language:** **English** · [中文](README.zh.md)

Aixora Studio is a local audio workspace for speech generation, transcription, music, audio processing, realtime conversations and video translation with dubbing.

## Start and stop

1. Extract the complete package and double-click **`run_webui.bat`** in its root directory.
2. Wait for the browser to open, or visit `http://127.0.0.1:7899`. The portable package launcher uses port **7899**; follow the startup message if you have changed it.
3. Install a model in the model center. Open a task page, select the model, click **Load**, then enter text or upload your material.
4. When finished, choose **System settings → Exit workspace service**, or run `run_webui.bat --stop`.

The service keeps running after you close the browser. Double-click `run_webui.bat` to open the interface again.

To switch to English, open **系统设置 → 外观 → 界面语言** and choose **English**. The browser remembers your choice. SpeakType uses this language when you start dictation.

Python and runtime dependencies are included. Keep the complete folder structure. The usage guide in the package root lists the bundled models; download others from the model center.

## Workspace pages

| Page | What you can do |
|---|---|
| Speech synthesis | Read text aloud, clone a reference voice or play audio as it is generated |
| Speech recognition | Transcribe recordings and view timestamps or speaker details |
| Music and sound effects | Generate and edit audio with prompts, lyrics or source audio |
| Voice design | Describe a voice, generate it and listen |
| Voice conversion | Change the voice in speech or singing |
| Scenarios | Create subtitles, translate and dub videos, chat by voice or use global dictation |
| Reference audio | Save voice references and their transcripts |
| Audio tools | Separate tracks, enhance, denoise, analyze and convert audio |
| Model center | Find, download and delete models |
| System settings | Change appearance, view loaded models and logs, or stop the service |

After you select a model, the page shows its languages, inputs and settings. Start with the defaults. When a setting is marked **Reload required**, click **Apply and reload model** after changing it.

For voice cloning, provide a clear reference recording. If a reference transcript is required, enter the words spoken in that recording. Put the new text in the synthesis text box. The results area offers playback, details and downloads.

**Installed** means the model files have been downloaded; **loaded** means the model is ready to run. **Unload model** frees memory and VRAM. **Delete model files** frees disk space. You can resume interrupted downloads in the model center.

## Realtime conversation

1. Open **Scenarios → Realtime conversation**.
2. In chat settings, enter a conversation service URL, model name and API key. Use a local or cloud service that supports the Chat Completions API.
3. Select a character, speech model, voice, recognition model and microphone, then choose a conversation language.
4. Save, click the microphone and allow browser microphone access. You can also type messages.
5. Stop the call or use the upper-left Back button to end the conversation and turn off the microphone. Starting again reuses the matching loaded speech model.

With the language set to **Automatic**, replies follow the language you speak. You can also select a specific language. Choose a speech model that supports it.

## Global dictation

Open **Scenarios → Global dictation**, select an installed streaming recognition model and start it. Switch to a text field in Notepad, a chat app or another program. Use the shortcut shown on the page to start dictation, and press it again to stop.

Studio starts the recognition service and floating toolbar for you. Stop dictation from the scenario page when finished.

## Appearance and settings

The default appearance is **Classic blue-purple + Light**. System settings also offer graphite/amber, dark mode and system appearance. Your saved choices are kept.

Studio supports Chinese and English. Appearance and some chat settings are saved in your current browser; set them again when using a different browser or port.

## Updates and files

Finish tasks and calls, stop the workspace service, then double-click **`update.bat`** in the package root and follow the prompts.

For everyday use, you only need to run `run_webui.bat` and `update.bat`. Keep `_env.bat` and `webui/start_webui.bat` as well: the launcher calls them automatically.

| Location | Contents |
|---|---|
| `models/` | Installed models |
| `webui/voice/` | Voice references and transcripts |
| `webui/output/` | Generated files and scenario projects |
| `webui/logs/` | Startup and runtime logs |
| `SpeakType/config.json` | Global dictation settings |
| `_update/backup/` | Backups saved during updates |

To move to another computer, copy the complete package directory. Set up browser-saved appearance and chat settings again on the new computer.

## Choose a GPU or CPU

The launcher selects an available backend in **CUDA → Vulkan → CPU** order. Install your graphics card manufacturer's driver before using GPU acceleration.

To choose a backend manually, stop Studio, open Command Prompt in the package directory and run:

```bat
set AUDIOCPP_BACKEND=vulkan
run_webui.bat
```

You can replace `vulkan` with `cuda` or `cpu`.

## Troubleshooting

- **The interface will not open:** read `webui/logs/startup.log`, or run `run_webui.bat --diagnostic` for startup details.
- **The port is in use:** stop Studio and check whether another program is using port **7899**. To change the port, edit the `AUDIOCPP_UI_PORT` setting in the root `run_webui.bat`, restart Studio and use the new address. Setting this variable in a terminal does not override the value assigned by that launcher.
- **No transcript in realtime chat:** check browser microphone access, your input device and the recognition model.
- **Transcript but no reply:** check the conversation service URL, model name and API key.
- **Reply but no sound:** check that the speech model is loaded and supports the language, then check playback and system volume.
- **Not enough VRAM:** unload unused models in system settings, shorten the input or choose a smaller model.
- **The old page appears after an update:** stop and restart the service, then refresh the browser.
