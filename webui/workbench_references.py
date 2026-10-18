"""Reference library adapter over the downstream WebUI's WAV/prompt_text store."""
from pathlib import Path
import threading
from urllib.parse import quote

from fastapi import HTTPException

try:
    from .workbench_reference_audio import require_short_reference, wav_duration
except ImportError:
    from workbench_reference_audio import require_short_reference, wav_duration


class ReferenceLibrary:
    def __init__(self, backend):
        self.b = backend
        self.lock = threading.RLock()

    def path(self, name):
        if not name or name == "(none)" or Path(name).name != name or "\\" in name:
            raise HTTPException(404, "参考音频不存在，请刷新列表。")
        root = Path(self.b.PROMPTS_DIR).resolve()
        path = (root / name).resolve()
        if not path.is_relative_to(root) or name not in self.b.builtin_voices() or not path.is_file():
            raise HTTPException(404, "参考音频不存在，请刷新列表。")
        return path

    def list(self):
        with self.lock:
            texts = self.b._load_voice_texts() if hasattr(self.b, "_load_voice_texts") else {}
            return [{"name": name, "label": Path(name).stem,
                     "voice_ref": str((Path(self.b.PROMPTS_DIR) / name).resolve()),
                     "duration": wav_duration(Path(self.b.PROMPTS_DIR) / name),
                     "text": texts.get(Path(name).stem, ""),
                     "url": "/api/workbench/references/" + quote(name, safe="") + "/audio"}
                    for name in self.b.builtin_voices() if name != "(none)"]

    def save(self, request, work):
        with self.lock:
            filename = self.b._builtin_voice_filename(request.name)
            existing = next((name for name in self.b.builtin_voices()
                             if name.casefold() == filename.casefold()), None)
            if existing and not request.overwrite:
                raise HTTPException(409, "已有同名参考音频，请确认覆盖或修改名称。")
            if existing:
                filename = existing
            audio = work.input_path(request.audio) if request.audio else str(self.path(request.source))
            require_short_reference(audio, self.b)
            _, message = self.b.save_builtin_voice(audio, filename, request.text)
            if "❌" in message:
                raise HTTPException(400, message.replace("❌", "").strip())
            return {"name": filename, "voices": self.list(), "message": "参考音频已保存。"}

    def delete(self, name):
        with self.lock:
            self.path(name)
            *_, message = self.b.delete_builtin_voice(name)
            if "❌" in message:
                raise HTTPException(400, message.replace("❌", "").strip())
            return {"voices": self.list(), "message": "参考音频已删除。"}
