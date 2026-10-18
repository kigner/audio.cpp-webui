"""Review-gated subtitle/dubbing sessions with durable exports and disposable work."""
from __future__ import annotations

import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import quote, urlsplit
import uuid

from fastapi import File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
import httpx

try:
    from . import scenario_media as media
    from .workbench_metadata import model_languages, task_for
    from .workbench_reference_audio import require_short_reference
    from .workbench_references import ReferenceLibrary
except ImportError:
    import scenario_media as media
    from workbench_metadata import model_languages, task_for
    from workbench_reference_audio import require_short_reference
    from workbench_references import ReferenceLibrary

PREFIX = "/api/workbench/scenarios"
MEDIA_EXTENSIONS = {".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".mp4", ".mov", ".mkv", ".webm", ".avi"}
TERMINAL = {"done", "error", "cancelled"}
LANGUAGE_ALIASES = {"english": "en", "chinese": "zh", "mandarin": "zh", "中文": "zh", "英语": "en", "japanese": "ja", "korean": "ko", "french": "fr", "german": "de", "spanish": "es", "portuguese": "pt", "russian": "ru", "italian": "it"}


def output_name(value):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(value)).strip(" .")[:72].rstrip(" .") or "素材"
    if re.fullmatch(r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", name, re.I):
        name = "_" + name
    return name


def open_output_folder(path):
    path = Path(path).resolve(strict=True)
    if not path.is_dir():
        raise ValueError("输出目录不存在。")
    if os.name == "nt":
        os.startfile(str(path), "explore")
    else:
        subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(path)],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def language_code(value):
    token = str(value or "auto").strip().lower()
    return LANGUAGE_ALIASES.get(token, token.split("-")[0])


def backend_language(backend, entry, value):
    """Bridge project ISO codes to the existing model-specific dropdown contract."""
    code = language_code(value)
    if code == "auto":
        return ""
    mapping = backend.profile_for(entry).get("lang_map", {})
    for name, accepted in mapping.items():
        if language_code(name) == code or language_code(accepted) == code:
            return name
    if entry.get("family") == "qwen3_tts":
        # Qwen's codec_language_id keys are names (english), not ISO codes (en).
        return next((name for name, iso in LANGUAGE_ALIASES.items() if iso == code), code)
    return code


def alignment_text(text):
    """Crisper's aligner splits on spaces; its Chinese hypothesis is per character."""
    words = []
    cjk = r"[\u3400-\u9fff\u3040-\u30ff]"
    lexical = r"(?:(?!" + cjk + r")\w)+"
    for token in re.findall(cjk + "|" + lexical + r"(?:['’-]" + lexical + r")*|[^\w\s]", text):
        if token[0].isalnum():
            words.append(token)
        elif words:
            words[-1] += token
    return " ".join(words)


def asr_segments(details):
    """Use the server's real word/segment spans, including long-input offsets."""
    cues = []
    for chunk in details if isinstance(details, list) else [details]:
        if not isinstance(chunk, dict):
            continue
        result = chunk.get("result", chunk)
        if not isinstance(result, dict):
            continue
        offset = float(chunk.get("offset_seconds", 0))
        rate = result.get("sample_rate")
        segments = [item for item in result.get("segments", []) if isinstance(item, dict) and item.get("text")]
        word_items = result.get("words") or result.get("word_timestamps") or []
        items = word_items or segments
        words = bool(word_items)
        timed, pending_text = [], ""
        def join_text(left, right):
            joiner = "" if not left or re.search(r"[\u3400-\u9fff\u3040-\u30ff]$", left) or re.match(r"[\u3400-\u9fff\u3040-\u30ff，。！？、,.!?]", right) else " "
            return left + joiner + right
        for item in items:
            if not isinstance(item, dict):
                continue
            text = str(item.get("text", item.get("word", ""))).strip()
            if not text:
                continue
            if "start" in item and "end" in item:
                start, end = float(item["start"]), float(item["end"])
            elif rate and "start_sample" in item and "end_sample" in item:
                start, end = float(item["start_sample"]) / float(rate), float(item["end_sample"]) / float(rate)
            else:
                if any(char.isalnum() for char in text):
                    raise ValueError("识别结果有文字缺少时间戳，请重新对齐字幕。")
                continue
            if math.isfinite(start) and math.isfinite(end) and end > start >= 0:
                if pending_text:
                    text = join_text(pending_text, text)
                    pending_text = ""
                timed.append({"start": start + offset, "end": end + offset, "text": text})
            elif math.isfinite(start) and start == end and start >= 0:
                # The aligner may place an unmatched character at an actual
                # boundary. Keep it with a neighboring measured word span;
                # never manufacture a duration for the individual character.
                if timed:
                    timed[-1]["text"] = join_text(timed[-1]["text"], text)
                else:
                    pending_text = join_text(pending_text, text)
            elif any(char.isalnum() for char in text):
                raise ValueError("识别结果有文字缺少有效时长，请重新对齐字幕。")
        if not words:
            cues.extend(timed)
            continue
        transcript = str(result.get("text", ""))
        normalize = lambda value: "".join(char.lower() for char in value if char.isalnum())
        exact_text = normalize(transcript) == normalize("".join(word["text"] for word in timed))
        phrase_ends, char_count = set(), 0
        if exact_text:
            for i, char in enumerate(transcript):
                if char.isalnum():
                    char_count += 1
                elif char in "。！？.!?，,；;：:\n" or (char.isspace() and i and i + 1 < len(transcript) and
                        re.match(r"[\u3400-\u9fff]", transcript[i - 1]) and re.match(r"[\u3400-\u9fff]", transcript[i + 1])):
                    phrase_ends.add(char_count)
        positions = [i for i, char in enumerate(transcript) if char.isalnum()]
        def finish(cue):
            first, last = cue.pop("_char_start"), cue.pop("_char_end")
            if exact_text and positions:
                begin = positions[first] if first else 0
                end = positions[last] if last < len(positions) else len(transcript)
                cue["text"] = transcript[begin:end].strip()
            cues.append(cue)
        current, char_count = None, 0
        for word in timed:
            # Exact transcript punctuation/phrase boundaries outrank acoustic
            # gaps: aligned CJK characters can have large internal gaps even
            # within 今天 / 我们 / 输出. A gap alone must not split those words.
            if current and not (exact_text and phrase_ends) and (word["start"] - current["end"] > .65 or
                            (word["start"] - current["end"] > .15 and word["end"] - current["start"] > 7)):
                finish(current)
                current = None
            if current is None:
                current = dict(word)
                current["_char_start"] = char_count
            else:
                # CJK timestamps contain characters; Latin word pieces need a space.
                joiner = "" if re.search(r"[\u3400-\u9fff]$", current["text"]) or re.match(r"[\u3400-\u9fff，。！？、,.!?]", word["text"]) else " "
                current["text"] += joiner + word["text"]
                current["end"] = word["end"]
            char_count += len(normalize(word["text"]))
            current["_char_end"] = char_count
            if (char_count in phrase_ends or re.search(r"[。！？.!?]$", current["text"])) and current["end"] - current["start"] > .7:
                finish(current)
                current = None
        if current:
            finish(current)
    if not cues:
        raise ValueError("识别结果没有真实时间轴。请选择支持时间戳的识别模型，或导入已校对的 SRT / VTT。")
    cues.sort(key=lambda cue: cue["start"])
    return [{"id": i + 1, **cue, "translation": ""} for i, cue in enumerate(cues)]


class ScenarioProjects:
    def __init__(self, workbench):
        self.work = workbench
        self.b = workbench.b
        self.root = Path(self.b.OUTPUT_DIR) / "scenario-projects"
        self.root.mkdir(parents=True, exist_ok=True)
        self.exports_root = Path(self.b.OUTPUT_DIR) / "scenario-exports"
        self.exports_root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.jobs = {}

    def directory(self, ident):
        if not re.fullmatch(r"[a-f0-9]{32}", str(ident)):
            raise HTTPException(404, "素材不存在。")
        return self.root / ident

    def file(self, ident, relative):
        root = self.directory(ident).resolve()
        path = (root / str(relative)).resolve()
        if not path.is_relative_to(root) or path == root or not path.is_file():
            raise HTTPException(404, "素材文件不存在。")
        return path

    def export_file(self, relative):
        root = self.exports_root.resolve()
        path = (root / str(relative)).resolve()
        if (not path.is_relative_to(root) or path == root or not path.is_file()
                or any(part.startswith(".") for part in Path(relative).parts)
                or path.suffix.lower() not in {".mp4", ".wav", ".srt", ".vtt"}):
            raise HTTPException(404, "成品文件不存在。")
        return path

    def output_directory(self, project):
        relative = project.get("export_directory")
        if not relative:
            return None
        root = self.exports_root.resolve()
        directory = (root / relative).resolve()
        if directory == root or not directory.is_relative_to(root):
            raise ValueError("成品目录超出了输出目录。")
        return directory if directory.is_dir() else None

    def publish_exports(self, project, items, job=None):
        """Publish a complete, verified bundle before any session files are removed."""
        label = output_name(Path(project["media"]["name"]).stem)[:48]
        language = output_name(project.get("target_language") if project["scenario"] == "dubbing"
                               else project.get("detected_language") or project.get("source_language") or "auto")[:12]
        created = time.strftime('%Y%m%d-%H%M%S', time.localtime(project.get("created_at", time.time())))
        group = f"{label}_{language}_{created}_{project['id'][:8]}"
        folder = f"{group}/{time.strftime('%H%M%S')}_{uuid.uuid4().hex[:10]}"
        root = self.exports_root.resolve()
        if root.parent != Path(self.b.OUTPUT_DIR).resolve():
            raise ValueError("成品目录超出了输出目录。")
        target = root / folder
        target.parent.mkdir(exist_ok=True)
        if target.parent.resolve().parent != root or target.parent.is_symlink():
            raise ValueError("成品目录超出了当前素材范围。")
        published, names = [], set()
        with tempfile.TemporaryDirectory(prefix=".partial-", dir=root) as temporary:
            staging = Path(temporary)
            for source, requested_name in items:
                source = Path(source)
                name = output_name(Path(requested_name).stem) + source.suffix.lower()
                base, index = name, 2
                while name.casefold() in names:
                    name = f"{Path(base).stem}-{index}{Path(base).suffix}"
                    index += 1
                names.add(name.casefold())
                destination = staging / name
                digest = hashlib.sha256()
                with source.open("rb") as src, destination.open("xb") as dst:
                    for chunk in iter(lambda: src.read(1024 * 1024), b""):
                        if job and job["cancel"].is_set():
                            raise RuntimeError("任务已停止。")
                        dst.write(chunk)
                        digest.update(chunk)
                with destination.open("rb") as saved:
                    if hashlib.file_digest(saved, "sha256").digest() != digest.digest():
                        raise OSError("成品保存校验失败，当前流程已保留。")
                published.append({"output_path": f"{folder}/{name}", "name": name})
            if job:
                self.checkpoint(job)
            staging.rename(target)
        project["export_directory"] = group
        return published

    def archive_legacy_exports(self, project):
        """Keep old completed files even when an edit cleared the old download list."""
        root = self.directory(project["id"])
        legacy = {str(item["path"]): item.get("name", item["path"])
                  for item in project.get("exports", []) if "path" in item}
        for pattern in ("dubbed-*.mp4", "dubbed-*.wav", "export-*.srt", "subtitles-*.srt", "subtitles-*.vtt"):
            for path in root.glob(pattern):
                if path.is_file():
                    legacy.setdefault(path.name, path.name)
        # Old video exports did not expose a standalone WAV. Preserve completed
        # mixes during this one-time migration, without keeping sentence caches.
        if any(Path(name).suffix == ".mp4" for name in legacy):
            for path in root.glob("mix-*.wav"):
                legacy.setdefault(path.name, path.name)
        archived = project.get("archived_legacy_files", {})
        signatures, items = {}, []
        for relative, name in legacy.items():
            path = self.file(project["id"], relative)
            info = path.stat()
            signature = f"{info.st_size}:{info.st_mtime_ns}"
            if archived.get(relative) != signature:
                signatures[relative] = signature
                items.append((path, name))
        if not items:
            return
        project["exports"] = [item for item in project.get("exports", []) if "output_path" in item] + self.publish_exports(project, items)
        project["archived_legacy_files"] = {**archived, **signatures}
        self.save(project)

    def cleanup_root(self, ident):
        """Validate the exact managed tree before recursive removal on Windows."""
        path = self.directory(ident)
        root = self.root.resolve()
        resolved = path.resolve()
        root_info = self.root.lstat()
        if (self.root.is_symlink() or getattr(root_info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
                or root.parent != Path(self.b.OUTPUT_DIR).resolve() or resolved.parent != root or resolved.name != ident):
            raise ValueError("缓存目录超出了当前素材范围。")
        if not path.exists():
            return path
        for parent, directories, files in os.walk(path, followlinks=False):
            for candidate in [Path(parent), *(Path(parent) / name for name in directories + files)]:
                info = candidate.lstat()
                if (candidate.is_symlink() or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
                        or not candidate.resolve().is_relative_to(resolved)):
                    raise ValueError("缓存包含外部链接，未清理当前素材。")
        return path

    def reset(self, ident, revision):
        with self.lock, self.work.lock:
            root = self.cleanup_root(ident)
            if not root.exists():
                return {"reset": True, "output_directory": None}
            project = self.read(ident)
            self.check_revision(project, revision)
            if self.work.active_job or self.work.leases or any(job.get("project_id") == ident and job["status"] not in TERMINAL for job in self.jobs.values()):
                raise HTTPException(409, "请先停止当前任务，再处理新素材。")
            original = project["media"].get("source_path")
            if original and Path(original).resolve().is_relative_to(root.resolve()):
                raise ValueError("原始素材位于当前缓存目录，未清理。")
            self.archive_legacy_exports(project)
            output = self.output_directory(project)
            self.work.release_scenario_model(ident)
            # Keep the source and session record until other files are removed,
            # so a Windows sharing violation can be retried with the same revision.
            source = project["media"].get("path")
            try:
                for child in sorted(root.iterdir(), key=lambda child: child.name == source):
                    if child.name == "project.json":
                        continue
                    if child.is_dir():
                        shutil.rmtree(child)
                    else:
                        child.unlink()
                (root / "project.json").unlink()
                root.rmdir()
            except OSError as exc:
                if root.exists() and not (root / "project.json").exists():
                    self.save(project)
                raise HTTPException(409, "缓存仍被占用，请停止播放后重试；已导出成品会保留。") from exc
            for jobid, job in list(self.jobs.items()):
                if job.get("project_id") == ident:
                    self.jobs.pop(jobid, None)
                    self.work.jobs.pop(jobid, None)
            return {"reset": True, "output_directory": str(output) if output else None}

    def open_output(self, ident):
        with self.lock, self.work.lock:
            project = self.read(ident)
            if self.work.active_job or self.work.leases:
                raise HTTPException(409, "请等待当前任务结束。")
            self.archive_legacy_exports(project)
            directory = self.output_directory(project)
            if directory is None:
                raise ValueError("请先导出成品。")
            # Open the latest published batch, where the finished files live,
            # rather than the material's parent folder of timestamped batches.
            for item in reversed(project.get("exports", [])):
                if item.get("output_path"):
                    exported = self.export_file(item["output_path"])
                    if not exported.is_relative_to(directory):
                        raise ValueError("成品目录超出了当前素材范围。")
                    directory = exported.parent
                    break
            try:
                open_output_folder(directory)
            except OSError as exc:
                raise ValueError(f"无法打开输出目录：{directory}。{exc}") from exc
            return {"opened": True, "output_directory": str(directory)}

    def read(self, ident):
        try:
            project = json.loads((self.directory(ident) / "project.json").read_text(encoding="utf-8"))
            self.restore_legacy_timing(project)
            return project
        except FileNotFoundError:
            raise HTTPException(404, "素材不存在。")

    @staticmethod
    def restore_legacy_timing(project):
        if "video_follows_audio" not in project:
            project["video_follows_audio"] = False
            # Before this option existed, 1 meant automatic fit, not strict 1x.
            for cue in project["segments"]:
                if cue.get("speed") == 1:
                    cue.pop("speed")

    def save(self, project):
        if not project.get("preview"):
            project.pop("output_timeline", None)
        project["updated_at"] = time.time()
        path = self.directory(project["id"]) / "project.json"
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(path)

    def keep_result(self, source, destination):
        source = Path(source)
        # These handlers create a fresh file for this reserved operation. Keep
        # its single durable copy in the project rather than orphaning duplicates.
        if source.resolve().parent == Path(self.b.OUTPUT_DIR).resolve() and source.name.startswith("audiocpp_"):
            shutil.move(str(source), str(destination))
        else:
            shutil.copy2(source, destination)

    def url(self, ident, path):
        return PREFIX + "/projects/" + ident + "/files/" + quote(str(path).replace("\\", "/"), safe="/")

    def public(self, project):
        value = copy.deepcopy(project)
        # Existing material keeps its original timing until the user opts in.
        self.restore_legacy_timing(value)
        if not value.get("preview"):
            value.pop("output_timeline", None)
        ident = value["id"]
        if value.get("job_id") not in self.jobs:
            value["job_id"] = None
        uploaded = value["media"].pop("path")
        value["media"]["url"] = self.url(ident, uploaded)
        value["media"]["uploaded_path"] = str((self.directory(ident) / uploaded).resolve())
        for key in ("tts_reference", "tts_library_reference"):
            if value.get(key):
                relative = value[key].pop("path")
                value[key]["url"] = self.url(ident, relative)
                input_id = "scenario-reference-" + ident + "-" + Path(relative).stem
                self.work.uploads[input_id] = self.directory(ident) / relative
                value[key]["input_id"] = input_id
        for segment in value["segments"]:
            if segment.get("audio"):
                segment["audio"]["url"] = self.url(ident, segment["audio"].pop("path"))
        for item in value.get("exports", []) + ([value["preview"]] if value.get("preview") else []):
            item["url"] = (PREFIX + "/exports/" + quote(item.pop("output_path"), safe="/")
                           if "output_path" in item else self.url(ident, item.pop("path")))
            item.pop("audio_path", None)
        output = self.output_directory(project)
        value["output_directory"] = str(output) if output else None
        value.pop("export_directory", None)
        for private in ("speech_path", "background_path", "original_audio_path", "reference_path", "reference_text", "separated", "asr_details_path", "aligned_details_path", "archived_legacy_files"):
            value.pop(private, None)
        return value

    def list(self):
        projects = []
        with self.lock:
            for file in self.root.glob("*/project.json"):
                try:
                    p = json.loads(file.read_text(encoding="utf-8"))
                    projects.append(self.public(p))
                except (ValueError, KeyError, OSError):
                    continue
        return {"projects": sorted(projects, key=lambda p: p["updated_at"], reverse=True)}

    def models(self, task):
        result = []
        specs = getattr(self.b, "MODEL_SPECS", {})
        for entry in self.b.catalog_models():
            if task_for(entry) != task:
                continue
            profile = self.b.profile_for(entry)
            spec = specs.get(entry["family"], {})
            languages = model_languages(entry, spec, profile, self.b.params_for(entry["id"])) or spec.get("languages", [])
            voices = []
            for parameter in self.b.params_for(entry["id"]):
                if parameter.get("name") in {"voice", "voice_id", "speaker"} and parameter.get("choices"):
                    voices = [v[1] if isinstance(v, (list, tuple)) else v for v in parameter["choices"]]
                    break
            result.append({"id": entry["id"], "name": entry.get("label", entry["id"]),
                           "family": entry["family"], "installed": bool(entry.get("installed")),
                           "languages": languages, "voices": voices,
                           "voice_mode": "reference" if profile.get("require_voice") else "builtin",
                           "accepts_voice_reference": bool(profile.get("accepts_voice_reference", True)),
                           "require_voice": bool(profile.get("require_voice")),
                           "requires_reference_text": bool(profile.get("require_reference_text") or profile.get("require_reference_text_with_voice")),
                           "send_reference_text": bool(profile.get("send_reference_text", True)),
                           "min_vram_gb": entry.get("min_vram_gb"),
                           "timestamps": "word_timestamps" in spec.get("capabilities", {}).get("asr", [])})
        return result

    def recommend(self, models, language, task):
        language = language_code(language)
        candidates = [m for m in models if m["installed"] and (language == "auto" or not m["languages"] or language in {language_code(v) for v in m["languages"]})]
        vram = getattr(self.b, "LOCAL_VRAM_GB", None)
        if vram:
            suitable = [m for m in candidates if not m["min_vram_gb"] or m["min_vram_gb"] <= vram]
            candidates = suitable or candidates
        priority = ((["qwen3-asr", "crisperwhisper", "sensevoice", "whisper"] if language == "auto" else ["crisperwhisper", "qwen3-asr", "sensevoice", "whisper"]) if task == "asr" else
                    ["supertonic", "pocket-tts", "qwen3-tts", "fireredtts3"] if language == "en" else
                    ["supertonic", "qwen3-tts", "fireredtts3"])
        candidates.sort(key=lambda m: (priority.index(m["id"]) if m["id"] in priority else 99,
                                      not m.get("timestamps") if task == "asr" else m["voice_mode"] == "reference"))
        return {"id": candidates[0]["id"], "reason": "已安装，支持当前语言" + ("，可生成真实字幕时间戳" if task == "asr" and candidates[0]["timestamps"] else "，适合当前设备")} if candidates else None

    def capabilities(self, source_language="auto", target_language="en"):
        asr, tts = self.models("asr"), self.models("tts")
        return {"asr_models": asr, "tts_models": tts,
                "recommended_asr": self.recommend(asr, source_language, "asr"),
                "recommended_tts": self.recommend(tts, target_language, "tts"),
                "llm_defaults": {"url": os.environ.get("AUDIOCPP_LLM_BASE_URL", "https://api.deepseek.com/v1"),
                                 "model": os.environ.get("AUDIOCPP_LLM_MODEL", "deepseek-chat"),
                                 "key_set": bool(os.environ.get("AUDIOCPP_LLM_API_KEY"))}}

    def create(self, filename, source, *, name="", scenario="subtitles", subtitle=None, source_path="", replace_id="", replace_revision=None):
        extension = Path(filename).suffix.lower()
        if extension not in MEDIA_EXTENSIONS:
            raise ValueError("请选择支持的音频或视频文件。")
        if scenario not in {"subtitles", "dubbing"}:
            raise ValueError("未知应用场景。")
        ident = uuid.uuid4().hex
        root = self.directory(ident)
        root.mkdir()
        try:
            destination = root / ("source" + extension)
            with destination.open("wb") as output:
                shutil.copyfileobj(source, output, 1024 * 1024)
            original = None
            if source_path:
                original = Path(source_path)
                if not original.is_absolute() or re.search(r"(?:^|[\\/])fakepath(?:[\\/]|$)", source_path, re.I):
                    raise ValueError("原始文件路径必须是真实的绝对路径，不能使用浏览器 fakepath。")
                try:
                    original = original.resolve(strict=True)
                    if not original.is_file():
                        raise ValueError("原始文件路径不是文件。")
                    digests = []
                    for path in (original, destination):
                        digest = hashlib.sha256()
                        with path.open("rb") as stream:
                            for block in iter(lambda: stream.read(1024 * 1024), b""):
                                digest.update(block)
                        digests.append(digest.digest())
                except FileNotFoundError:
                    raise ValueError("原始文件不存在，请重新选择素材。") from None
                except OSError as exc:
                    raise ValueError(f"无法读取原始文件：{exc}") from None
                if digests[0] != digests[1]:
                    raise ValueError("原始文件内容与上传素材不一致，请重新选择素材。")
            info = media.probe_media(destination)
            if not info.get("has_audio"):
                raise ValueError("素材没有可识别的音轨。")
            if not info.get("duration") or info["duration"] <= 0:
                raise ValueError("无法确定素材时长。")
            cap = self.capabilities()
            project = {"id": ident, "name": (name or Path(filename).stem).strip()[:160], "scenario": scenario,
                       "revision": 1, "created_at": time.time(), "segments": [], "exports": [], "preview": None,
                       "media": {**info, "name": Path(filename).name, "path": destination.name},
                       "source_language": "auto", "detected_language": "", "target_language": "en",
                       "asr_model": (cap["recommended_asr"] or {}).get("id", ""),
                       "tts_model": (cap["recommended_tts"] or {}).get("id", ""), "tts_voice": "",
                       "tts_options": {}, "options": {"subtitle_mode": "translation", "translation_instructions": ""},
                       "has_background": False, "mix": {"background_volume": .35, "voice_volume": 1.0},
                       "video_follows_audio": True,
                       "confirmed_source": False, "confirmed_translation": False, "confirmed_audio": False,
                       "job_id": None}
            if original is not None:
                project["media"]["source_path"] = str(original)
            if subtitle is not None:
                project["segments"] = [{**cue, "translation": ""} for cue in media.parse_subtitles(subtitle)]
                self.validate_segments(project["segments"], info["duration"])
            with self.lock:
                self.save(project)
                if replace_id:
                    self.reset(replace_id, replace_revision)
            return self.public(project)
        except Exception:
            shutil.rmtree(self.cleanup_root(ident))
            raise

    def check_revision(self, project, revision):
        if revision is None or revision != project["revision"]:
            raise HTTPException(409, "内容已更新，请刷新后继续。")

    def validate_segments(self, segments, duration):
        normalized = media.validate_cues(segments)
        if any(cue["end"] > duration + .25 for cue in normalized):
            raise ValueError("字幕时间超出了素材时长，请先校对时间。")
        ids = [str(cue["id"]) for cue in normalized]
        if len(ids) != len(set(ids)):
            raise ValueError("字幕行编号不能重复。")
        return normalized

    def patch(self, ident, changes):
        with self.lock:
            p = self.read(ident)
            self.check_revision(p, changes.get("revision"))
            was_translation_ready = p["scenario"] == "dubbing" and p["confirmed_source"]
            source_changed = translation_changed = audio_changed = timing_changed = False
            previous = {str(cue["id"]): cue for cue in p["segments"]}
            if "segments" in changes:
                if not isinstance(changes["segments"], list):
                    raise ValueError("字幕必须是列表。")
                normalized = self.validate_segments(changes["segments"], p["media"]["duration"]) if changes["segments"] else []
                updated = []
                source_changed = set(previous) != {str(cue["id"]) for cue in normalized}
                for cue in normalized:
                    old = previous.get(str(cue["id"]), {})
                    item = {key: cue[key] for key in ("id", "start", "end", "text")}
                    item["translation"] = str(cue.get("translation", "")).strip()
                    requested_speed = cue.get("speed", old.get("speed"))
                    speed = float(requested_speed) if requested_speed is not None else None
                    if speed is not None:
                        if not math.isfinite(speed) or not .5 <= speed <= 2:
                            raise ValueError("配音倍速必须介于 0.5 到 2 倍之间。")
                        item["speed"] = speed
                    text_edit = item["text"] != old.get("text")
                    time_edit = any(item[k] != old.get(k) for k in ("start", "end"))
                    source_edit = text_edit or time_edit
                    translation_edit = item["translation"] != old.get("translation", "")
                    speed_edit = speed != old.get("speed")
                    if text_edit:
                        item["translation"] = ""
                    if old.get("audio") and not text_edit and not translation_edit:
                        item["audio"] = old["audio"]
                    source_changed |= source_edit
                    translation_changed |= translation_edit
                    audio_changed |= speed_edit
                    timing_changed |= time_edit or speed_edit
                    updated.append(item)
                p["segments"] = updated
            if "video_follows_audio" in changes and not isinstance(changes["video_follows_audio"], bool):
                raise ValueError("画面跟随配音必须是开关值。")
            if changes.get("tts_reference_upload"):
                reference = Path(self.work.input_path(changes["tts_reference_upload"]))
                require_short_reference(reference, self.b)
                destination = self.directory(ident) / ("voice-reference-" + uuid.uuid4().hex + reference.suffix)
                shutil.copyfile(reference, destination)
                p["tts_reference"] = {"path": destination.name, "name": str(changes.get("tts_reference_name") or "参考音频")[:200]}
                audio_changed = True
                for cue in p["segments"]:
                    cue.pop("audio", None)
            if "tts_reference_library" in changes:
                name = str(changes["tts_reference_library"] or "")
                if name:
                    library = ReferenceLibrary(self.b)
                    reference = library.path(name)
                    require_short_reference(reference, self.b)
                    item = next(item for item in library.list() if item["name"] == name)
                    destination = self.directory(ident) / ("voice-library-" + uuid.uuid4().hex + reference.suffix)
                    shutil.copyfile(reference, destination)
                    p["tts_library_reference"] = {"path": destination.name, "name": name, "text": item["text"]}
                else:
                    p.pop("tts_library_reference", None)
                audio_changed = True
                for cue in p["segments"]:
                    cue.pop("audio", None)
            for key in ("name", "scenario", "source_language", "target_language", "asr_model", "tts_model", "tts_voice", "tts_reference_mode", "tts_reference_text", "has_background", "tts_options", "mix", "options", "video_follows_audio"):
                current = p.get(key, False) if key == "video_follows_audio" else p.get(key)
                if key not in changes or changes[key] == current:
                    continue
                value = changes[key]
                if key == "scenario" and value not in {"subtitles", "dubbing"}:
                    raise ValueError("未知应用场景。")
                if key in {"asr_model", "tts_model"}:
                    entry = self.b.catalog_by_id(value)
                    if not entry or task_for(entry) != ("asr" if key == "asr_model" else "tts"):
                        raise ValueError("请选择支持当前任务的模型。")
                if key == "mix":
                    value = {k: float(value.get(k, p["mix"].get(k, 1))) for k in ("background_volume", "voice_volume")}
                    if any(not math.isfinite(v) or not 0 <= v <= 2 for v in value.values()):
                        raise ValueError("混音音量必须介于 0 到 2。")
                if key == "tts_options" and not isinstance(value, dict):
                    raise ValueError("无效配音参数。")
                if key == "tts_reference_mode" and value not in {"original", "library", "upload", "none"}:
                    raise ValueError("请选择有效的参考音频来源。")
                if key == "tts_reference_text":
                    value = str(value or "").strip()
                if key == "options":
                    if not isinstance(value, dict):
                        raise ValueError("无效场景参数。")
                    value = {k: value.get(k, p.get("options", {}).get(k)) for k in ("subtitle_mode", "translation_instructions")}
                    if value["subtitle_mode"] not in {"none", "translation", "bilingual"}:
                        raise ValueError("未知字幕导出方式。")
                    value["translation_instructions"] = str(value["translation_instructions"] or "")[:2000]
                p[key] = value
                if key == "tts_model":
                    p.pop("tts_reference_mode", None)
                    p["tts_voice"] = ""
                if key == "target_language":
                    for cue in p["segments"]:
                        cue["translation"] = ""
                        cue.pop("audio", None)
                    translation_changed = True
                elif key in {"tts_model", "tts_voice", "tts_options", "tts_reference_mode", "tts_reference_text"}:
                    for cue in p["segments"]:
                        cue.pop("audio", None)
                    audio_changed = True
                elif key == "has_background":
                    p.pop("background_path", None)
                    p.pop("speech_path", None)
                    p.pop("separated", None)
                    tts_entry = self.b.catalog_by_id(p["tts_model"])
                    if tts_entry and self.b.profile_for(tts_entry).get("require_voice"):
                        for cue in p["segments"]:
                            cue.pop("audio", None)
                    audio_changed = True
                elif key == "mix":
                    audio_changed = True
                elif key == "video_follows_audio":
                    audio_changed = timing_changed = True
                elif key == "options":
                    p["exports"] = []
            if timing_changed:
                self.refresh_audio_checks(p)
            if source_changed:
                p["confirmed_source"] = False
            if source_changed or translation_changed:
                p["confirmed_translation"] = False
            if source_changed or translation_changed or audio_changed:
                p["confirmed_audio"] = False
                p["preview"] = None
                p["exports"] = []
            for key in ("confirmed_source", "confirmed_translation", "confirmed_audio"):
                if key not in changes:
                    continue
                if changes[key]:
                    if not p["segments"]:
                        raise ValueError("请先生成或导入字幕。")
                    if key == "confirmed_translation" and (not p["confirmed_source"] or any(not c.get("translation") for c in p["segments"])):
                        raise ValueError("请先确认原文并完成每句翻译。")
                    if key == "confirmed_audio" and (not p["confirmed_translation"] or not p.get("preview") or self.audio_issues(p)):
                        raise ValueError("请先完成全部配音、解决时长问题并试听混音。")
                p[key] = bool(changes[key])
                if not changes[key] and key != "confirmed_audio":
                    p["confirmed_audio"] = False
                    if key == "confirmed_source":
                        p["confirmed_translation"] = False
            p["revision"] += 1
            self.save(p)
            result = self.public(p)
        if not was_translation_ready and p["scenario"] == "dubbing" and p["confirmed_source"]:
            self.work.release_scenario_model(ident)
        return result

    def import_subtitles(self, ident, revision, text):
        p = self.read(ident)
        return self.patch(ident, {"revision": revision, "segments": [{**c, "translation": ""} for c in media.parse_subtitles(text)]})

    def submit(self, ident, request):
        action = request.get("action")
        if action not in {"recognize", "translate", "synthesize", "mix", "export", "export_subtitles"}:
            raise ValueError("未知任务操作。")
        with self.lock:
            p = self.read(ident)
            self.check_revision(p, request.get("revision"))
            if action in {"translate", "synthesize", "mix", "export"} and not p["confirmed_source"]:
                raise ValueError("请先校对并确认原文字幕。")
            if action in {"synthesize", "mix", "export"} and not p["confirmed_translation"]:
                raise ValueError("请先校对并确认译文。")
            if action == "export" and not p["confirmed_audio"]:
                raise ValueError("请先试听混音并确认配音。")
            if action in {"recognize", "synthesize"}:
                entry = self.b.catalog_by_id(p["asr_model" if action == "recognize" else "tts_model"])
                if not entry or not entry.get("installed"):
                    raise ValueError("模型尚未安装，请先在模型中心准备模型。")
                if action == "synthesize":
                    self.validate_tts_reference(p, entry)
            jobid = uuid.uuid4().hex
            self.work.reserve(jobid)
            job = {"id": jobid, "project_id": ident, "project_revision": p["revision"],
                   "task": "asr" if action == "recognize" else "tts", "action": action,
                   "status": "queued", "message": "正在准备…", "stage": action, "progress": 0,
                   "cancel": threading.Event(), "started": time.monotonic(), "audio_segments": [], "artifacts": [], "text": ""}
            self.jobs[jobid] = job
            self.work.jobs[jobid] = job
            p["job_id"] = jobid
            self.save(p)
            threading.Thread(target=self.run, args=(job, p, copy.deepcopy(request)), daemon=True, name="scenario-job").start()
            return {"id": jobid}

    def job(self, ident):
        with self.lock:
            if ident not in self.jobs:
                raise HTTPException(404, "任务不存在。")
            return {k: copy.deepcopy(v) for k, v in self.jobs[ident].items() if k not in {"cancel", "started"}}

    def cancel(self, ident):
        with self.lock:
            if ident not in self.jobs:
                raise HTTPException(404, "任务不存在。")
            job = self.jobs[ident]
            if job["status"] not in TERMINAL:
                job["cancel"].set()
                job.update(status="cancelling", message="正在停止任务…")
                proc = getattr(self.b, "_server_proc", None)
                if self.work.active_job == ident and proc is not None and proc.poll() is None:
                    proc.terminate()
            return self.job(ident)

    def checkpoint(self, job, message=None, progress=None, stage=None):
        if job["cancel"].is_set():
            raise RuntimeError("任务已停止。")
        with self.lock:
            current = self.read(job["project_id"])
            if current["revision"] != job["project_revision"]:
                raise RuntimeError("内容在处理期间已修改，过期结果未覆盖新内容。")
            if message:
                job["message"] = self.work.clean_message(message)
            if progress is not None:
                job["progress"] = round(progress, 3)
            if stage:
                job["stage"] = stage

    def commit(self, job, project):
        with self.lock:
            self.checkpoint(job)
            project["revision"] += 1
            self.save(project)
            job["project_revision"] = project["revision"]

    def ensure_audio(self, job, p):
        root = self.directory(p["id"])
        if not p.get("original_audio_path"):
            self.checkpoint(job, "正在提取音轨…", .02, "extract")
            p["original_audio_path"] = Path(media.extract_audio(root / p["media"]["path"], root / "original.wav", cancel=job["cancel"])).name
        if p["has_background"] and not p.get("separated"):
            self.checkpoint(job, "正在分离人声与背景音乐…", .06, "separate")
            entries = [e for e in self.b.catalog_models() if task_for(e) == "separation" and e.get("installed") and e["family"] in {"htdemucs", "htdemucs_6stems", "bs_roformer", "mel_band_roformer"}]
            if not entries:
                raise ValueError("素材含背景音乐，请先在模型中心准备音源分离模型（HTDemucs）。")
            entries.sort(key=lambda e: e["family"] != "htdemucs_6stems")
            total = p["media"]["duration"]
            vocals, backgrounds, durations = [], [], []
            count = math.ceil(total / 20)
            recovered_server = False
            for index in range(count):
                self.checkpoint(job, f"正在分离人声与背景音乐 {index + 1} / {count}…", .06 + .35 * index / count, "separate")
                duration = min(20, total - index * 20)
                chunk = media.extract_audio(root / p["original_audio_path"], root / f"separation-{job['id']}-{index}.wav",
                    start=index * 20, duration=duration, sample_rate=44100, channels=2, cancel=job["cancel"])
                while True:
                    result = self.b.do_sep(entries[0]["id"], chunk, "", {}, "")
                    self.checkpoint(job)
                    if "❌" not in str(result[-1]) and result[-2]:
                        break
                    proc = getattr(self.b, "_server_proc", None)
                    exit_code = proc.poll() if proc is not None else None
                    if proc is not None and exit_code is None and getattr(self.b, "_loaded_id", None) == entries[0]["id"]:
                        # Windows may reset the socket before signalling process exit.
                        try:
                            exit_code = proc.wait(timeout=.5)
                        except subprocess.TimeoutExpired:
                            pass
                        self.checkpoint(job)
                    crashed = exit_code not in (None, 0) and getattr(self.b, "_loaded_id", None) == entries[0]["id"]
                    detail = self.work.clean_message(result[-1])
                    if crashed:
                        detail = f"分离服务异常退出（0x{exit_code & 0xffffffff:08X}），片段 {index + 1} / {count}。" + detail
                    if not crashed or recovered_server:
                        raise ValueError("背景音乐分离失败：" + detail)
                    # Only a confirmed crash of our managed model is recoverable.
                    # do_sep reloads a dead server; keep completed tracks and retry
                    # this chunk once for the whole job, never after cancellation.
                    recovered_server = True
                    message = f"分离服务意外退出，正在重新加载并重试片段 {index + 1} / {count}（仅一次）…"
                    self.checkpoint(job, message)
                    if hasattr(self.b, "_ui_log"):
                        self.b._ui_log(
                            f"separation server exited (0x{exit_code & 0xffffffff:08X}); "
                            f"reloading and retrying chunk {index + 1}/{count} once")
                vocal, stems = None, []
                for stemindex, original in enumerate(result[-2]):
                    label = Path(original).stem.lower()
                    destination = root / f"stem-{job['id']}-{index}-{stemindex}.wav"
                    self.keep_result(original, destination)
                    if re.search(r"(?:^|[_-])vocals?(?:$|[_-])", label):
                        vocal = destination
                    else:
                        stems.append(destination)
                del result
                if vocal is None or not stems:
                    raise ValueError("分离模型没有返回可区分的人声与背景轨，无法安全替换原人声。")
                vocals.append(vocal)
                backgrounds.append(media.mix_background(stems, root / f"background-{job['id']}-{index}.wav", duration, cancel=job["cancel"]))
                durations.append(duration)
                for stem in stems:
                    stem.unlink(missing_ok=True)
                Path(chunk).unlink(missing_ok=True)
            p["speech_path"] = Path(media.concatenate_audio(vocals, root / ("vocals-" + job["id"] + ".wav"), durations=durations, cancel=job["cancel"])).name
            p["background_path"] = Path(media.concatenate_audio(backgrounds, root / ("background-" + job["id"] + ".wav"), durations=durations, cancel=job["cancel"])).name
            for temporary in [*vocals, *backgrounds]:
                Path(temporary).unlink(missing_ok=True)
            p["separated"] = True
        return root / p.get("speech_path", p["original_audio_path"])

    def recognize(self, job, p):
        audio = self.ensure_audio(job, p)
        self.checkpoint(job, "正在识别语音与字幕时间轴…", .12, "recognize")
        entry = self.b.catalog_by_id(p["asr_model"])
        spec = getattr(self.b, "MODEL_SPECS", {}).get(entry["family"], {})
        params = {x["name"] for x in spec.get("options", {}).get("request", [])}
        options = {"return_timestamps": True} if "return_timestamps" in params and entry["family"] != "qwen3_asr" else {}
        language = language_code(p["source_language"])
        if entry["family"] == "crisperwhisper":
            if language == "auto":
                detector = next((e for e in self.b.catalog_models() if e.get("family") == "qwen3_asr" and e.get("installed")), None)
                if detector is None:
                    raise ValueError("该识别模型需要指定源语言，请选择源语言或使用 Qwen3-ASR 自动检测。")
                sample = media.extract_audio(audio, self.directory(p["id"]) / ("detect-" + job["id"] + ".wav"), start=0, duration=min(16, p["media"]["duration"]), sample_rate=16000, channels=1, cancel=job["cancel"])
                for _text, _message, detection, _path in self.b.do_asr_with_details(detector["id"], sample, "", "", False, False, {}, "", True):
                    self.checkpoint(job)
                    for chunk in detection or []:
                        detected = (chunk.get("result") or {}).get("language")
                        if detected:
                            language = language_code(detected)
                if language == "auto":
                    raise ValueError("未能检测源语言，请手动指定。")
                p["detected_language"] = language
            options["language"] = language
        final_details, message = [], ""
        # Timestamp-free recognition is split at actual low-energy boundaries so
        # the hidden forced aligner receives a bounded transcript and audio pair.
        chunks = ([path for path, _ in self.b._split_wav_chunks(str(audio), 24, pad_to_max=False)]
                  if not options.get("return_timestamps") and hasattr(self.b, "_split_wav_chunks") else [str(audio)])
        offset = 0.0
        for index, path in enumerate(chunks):
            self.checkpoint(job, f"正在识别字幕 {index + 1} / {len(chunks)}…", (.45 if p["has_background"] else .12) + .35 * index / len(chunks), "recognize")
            details = None
            for _text, message, chunk_details, _path in self.b.do_asr_with_details(p["asr_model"], path,
                    "" if language == "auto" else language, "", False, False, options, "", True):
                self.checkpoint(job)
                if chunk_details:
                    details = chunk_details
            if "❌" in str(message) or not details:
                raise ValueError("语音识别失败：" + self.work.clean_message(message))
            for chunk in details:
                chunk["offset_seconds"] = float(chunk.get("offset_seconds", 0)) + offset
                final_details.append(chunk)
            offset += media.audio_duration(path)
            if Path(path).resolve() != Path(audio).resolve() and Path(path).name.startswith("audiocpp_vcseg"):
                Path(path).unlink(missing_ok=True)
        for chunk in final_details:
            detected = (chunk.get("result") or {}).get("language")
            if detected:
                p["detected_language"] = language_code(detected)
                break
        if "❌" in str(message) or not final_details:
            raise ValueError("语音识别失败：" + self.work.clean_message(message))
        try:
            cues = asr_segments(final_details)
        except ValueError:
            cues = self.align_details(job, p, audio, final_details)
        self.validate_segments(cues, p["media"]["duration"])
        p["segments"] = cues
        detailfile = self.directory(p["id"]) / ("asr-" + job["id"] + ".json")
        detailfile.write_text(json.dumps(final_details, ensure_ascii=False, indent=2), encoding="utf-8")
        p["asr_details_path"] = detailfile.name
        p.update(confirmed_source=False, confirmed_translation=False, confirmed_audio=False, preview=None, exports=[])

    def align_details(self, job, p, audio, details):
        aligner = next((e for e in self.b.catalog_models() if e.get("installed") and e.get("task") == "align" and e.get("family") == "crisperwhisper"), None)
        if aligner is None:
            raise ValueError("当前识别模型不提供字幕时间戳。请选择 CrisperWhisper，或先准备时间对齐模型。")
        self.checkpoint(job, "正在自动对齐字幕时间…", .85, "align")
        root, aligned = self.directory(p["id"]), []
        duration = media.audio_duration(audio)
        for i, chunk in enumerate(details):
            self.checkpoint(job)
            offset = float(chunk.get("offset_seconds", 0))
            end = float(details[i + 1].get("offset_seconds", duration)) if i + 1 < len(details) else duration
            text = (chunk.get("result") or {}).get("text", "")
            path = media.extract_audio(audio, root / f"align-{job['id']}-{i}.wav", start=offset, duration=end - offset, sample_rate=16000, channels=1, cancel=job["cancel"])
            self.b._ensure_with_options(aligner["id"], {"align"}, {})
            lang = language_code(p.get("detected_language") or p["source_language"])
            if lang == "auto":
                raise ValueError("时间对齐需要源语言，请手动指定后重试。")
            result = self.b._run_task(aligner, aligner["id"], {"audio": path, "text": alignment_text(text),
                "options": {"language": lang}}, timeout=1800, log_label="subtitle alignment")
            result.setdefault("sample_rate", 16000)
            result["text"] = text
            aligned.append({"offset_seconds": offset, "result": result})
        outfile = root / ("aligned-" + job["id"] + ".json")
        outfile.write_text(json.dumps(aligned, ensure_ascii=False, indent=2), encoding="utf-8")
        p["aligned_details_path"] = outfile.name
        return asr_segments(aligned)

    def selected(self, p, request):
        ids = request.get("segment_ids")
        cues = [c for c in p["segments"] if ids is None or str(c["id"]) in {str(i) for i in ids}]
        if not cues:
            raise ValueError("没有选择可处理的字幕行。")
        return cues

    def translate(self, job, p, request):
        config = request.get("llm") or {}
        base = str(config.get("url") or os.environ.get("AUDIOCPP_LLM_BASE_URL", "")).rstrip("/")
        model = str(config.get("model") or os.environ.get("AUDIOCPP_LLM_MODEL", ""))
        key = str(config.get("key") or os.environ.get("AUDIOCPP_LLM_API_KEY", ""))
        parsed = urlsplit(base)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("请在聊天设置中配置大语言模型服务地址。")
        if not model:
            raise ValueError("请在聊天设置中填写大语言模型名称。")
        cues = self.selected(p, request)
        shorten = bool((request.get("options") or {}).get("shorten"))
        target = language_code(p["target_language"])
        with httpx.Client(timeout=httpx.Timeout(120, connect=15), follow_redirects=False, trust_env=False) as client:
            for offset in range(0, len(cues), 12):
                self.checkpoint(job, f"正在{'精简' if shorten else '翻译'}字幕 {offset + 1} / {len(cues)}…", offset / len(cues), "translate")
                batch = cues[offset:offset + 12]
                source = [{"id": str(c["id"]), "text": c.get("translation") if shorten else c["text"],
                           "source_text": c["text"], "duration_seconds": round(c["end"] - c["start"], 3),
                           **({"current_audio_seconds": c.get("audio", {}).get("duration"),
                               "suggested_max_words": max(1, math.floor((c["end"] - c["start"]) * 2.4))} if shorten and target == "en" else {})} for c in batch]
                instruction = ("You translate single-speaker video subtitles. Translate into " + target +
                    ". Preserve meaning, names, numbers and technical terms. Make each sentence natural and concise for speech within its duration. " +
                    ("The existing translation exceeds the spoken time budget. Rewrite it substantially shorter, aiming for suggested_max_words when provided and at least 25% fewer words. Compare current_audio_seconds with duration_seconds. Remove framing and filler (such as 'in this episode, let us take a look at'), retain the core claim and all essential facts, and avoid repeating the previous wording. " if shorten else "") +
                    "Return ONLY a JSON object with a translations array of {id,text}. Return exactly one nonempty translation for every supplied id, in order. Do not change ids or add commentary.")
                if p.get("options", {}).get("translation_instructions"):
                    instruction += " Additional translation style preference: " + p["options"]["translation_instructions"]
                try:
                    response = client.post(base + "/chat/completions", headers={"Authorization": "Bearer " + key} if key else {},
                        json={"model": model, "stream": False, "temperature": .2, "messages": [
                            {"role": "system", "content": instruction}, {"role": "user", "content": json.dumps(source, ensure_ascii=False)}]})
                    if response.status_code != 200:
                        raise ValueError(f"翻译服务返回 HTTP {response.status_code}。请检查聊天设置。")
                    content = response.json()["choices"][0]["message"]["content"]
                    content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip())
                    translated = json.loads(content)
                    rows = translated.get("translations") if isinstance(translated, dict) else translated
                    if not isinstance(rows, list) or [str(r.get("id")) for r in rows] != [str(c["id"]) for c in batch] or any(not str(r.get("text", "")).strip() for r in rows):
                        raise ValueError("翻译返回的行编号或内容不完整，请重试。")
                except (httpx.HTTPError, KeyError, IndexError, TypeError, json.JSONDecodeError):
                    # Provider bodies, connection URLs and keys never enter the job log.
                    raise ValueError("翻译服务连接失败或结果格式不正确，请检查聊天设置后重试。") from None
                self.checkpoint(job)
                for cue, row in zip(batch, rows):
                    cue["translation"] = str(row["text"]).strip()
                    cue.pop("audio", None)
        p.update(confirmed_translation=False, confirmed_audio=False, preview=None, exports=[])

    def tts_reference_mode(self, p, profile):
        if not profile.get("accepts_voice_reference", True):
            return "none"
        return p.get("tts_reference_mode") or ("original" if profile.get("require_voice") else "none")

    def validate_tts_reference(self, p, entry):
        profile = self.b.profile_for(entry)
        mode = self.tts_reference_mode(p, profile)
        if mode == "none" and profile.get("require_voice"):
            raise ValueError("该配音模型必须提供参考音频，请选择原声或上传参考音频。")
        if mode == "original" and not any(2 <= c["end"] - c["start"] <= 12 and c["text"].strip() for c in p["segments"]):
            raise ValueError("素材中没有 2 到 12 秒的参考字幕句，请上传参考音频或更换预置音色模型。")
        if mode in {"upload", "library"}:
            reference = p.get("tts_library_reference" if mode == "library" else "tts_reference")
            if not reference:
                raise ValueError("请先从音频库选择参考音频。" if mode == "library" else "请先上传参考音频。")
            require_short_reference(self.file(p["id"], reference["path"]), self.b)
            options = {**profile.get("default_options", {}), **p.get("tts_options", {})}
            required = getattr(self.b, "_tts_reference_text_required", None)
            needs_text = required(entry, profile, True, options) if required else (profile.get("require_reference_text") or profile.get("require_reference_text_with_voice"))
            text = reference.get("text") if mode == "library" else p.get("tts_reference_text")
            if needs_text and not str(text or "").strip():
                raise ValueError("该配音模型需要参考原文，请填写与参考音频一致的文字。")

    def synthesize(self, job, p, request):
        entry = self.b.catalog_by_id(p["tts_model"])
        self.validate_tts_reference(p, entry)
        audio = self.ensure_audio(job, p)
        root = self.directory(p["id"])
        profile = self.b.profile_for(entry)
        mode = self.tts_reference_mode(p, profile)
        reference = reference_text = ""
        if mode == "original":
            cue = next(c for c in p["segments"] if 2 <= c["end"] - c["start"] <= 12 and c["text"].strip())
            reference = media.extract_audio(audio, root / "reference.wav", start=cue["start"], duration=cue["end"] - cue["start"], sample_rate=24000, channels=1, cancel=job["cancel"])
            reference_text = cue["text"]
        elif mode == "upload":
            reference = str(self.file(p["id"], p["tts_reference"]["path"]))
            reference_text = p.get("tts_reference_text", "")
        elif mode == "library":
            reference = str(self.file(p["id"], p["tts_library_reference"]["path"]))
            reference_text = p["tts_library_reference"].get("text", "")
        if not profile.get("send_reference_text", True):
            reference_text = ""
        options = dict(p.get("tts_options", {}))
        voice = p.get("tts_voice")
        if voice and mode == "none":
            parameters = self.b.params_for(entry["id"])
            voicekey = next((v["name"] for v in parameters if v["name"] in {"voice", "voice_id", "speaker"}), "voice")
            options[voicekey] = voice
        cues = self.selected(p, request)
        p.update(confirmed_audio=False, preview=None, exports=[])
        for i, cue in enumerate(cues):
            self.checkpoint(job, f"正在生成配音 {i + 1} / {len(cues)}…", i / len(cues), "synthesize")
            def progress(_value, desc=None):
                self.checkpoint(job, desc)
            path, message = self.b.do_tts(entry["id"], cue["translation"], backend_language(self.b, entry, p["target_language"]),
                reference or None, "(none)", reference_text, 1234, None, options, "", progress=progress)
            self.checkpoint(job)
            if not path or not Path(path).is_file() or "❌" in str(message):
                raise ValueError(f"第 {cue['id']} 句配音失败：{self.work.clean_message(message)}")
            destination = root / f"speech-{job['id']}-{i}.wav"
            self.keep_result(path, destination)
            duration = media.audio_duration(destination, cancel=job["cancel"])
            cue["audio"] = {"path": destination.name, "duration": duration, "status": "ready"}
            self.refresh_audio_checks(p)
            self.commit(job, p)
        p.update(confirmed_audio=False, preview=None, exports=[])

    def audio_issues(self, p):
        return any(not c.get("audio") or not math.isfinite(float(c["audio"].get("duration", 0))) or
                   float(c["audio"].get("duration", 0)) <= 0 or float(c["audio"].get("overflow", 0)) > .05 or
                   float(c["audio"].get("overlap", 0)) > .05 or float(c["audio"].get("tail_overflow", 0)) > 0
                   for c in p["segments"])

    def refresh_audio_checks(self, p):
        """Changing timing reuses raw speech and only changes its placement/speed."""
        follow = p.get("video_follows_audio", False)
        for index, cue in enumerate(p["segments"]):
            audio = cue.get("audio")
            if not audio:
                continue
            window = cue["end"] - cue["start"]
            requested = cue.get("speed")
            speed = 1. if follow else (requested if requested is not None else min(1.2, max(1., audio["duration"] / window)))
            duration = audio["duration"] / speed
            next_start = p["segments"][index + 1]["start"] if index + 1 < len(p["segments"]) else p["media"]["duration"]
            audio.update(speed=speed, overflow=0 if follow else max(0, duration - window),
                         overlap=0 if follow else max(0, cue["start"] + duration - next_start),
                         tail_overflow=0 if follow else max(0, cue["start"] + duration - p["media"]["duration"]),
                         video_extension=max(0, cue["start"] + duration - next_start) if follow else 0)

    def mix(self, job, p):
        if any(not c.get("audio") for c in p["segments"]):
            raise ValueError("请先完成全部字幕句的配音。")
        self.ensure_audio(job, p)
        self.checkpoint(job, "正在检查时长并混音…", .2, "mix")
        root = self.directory(p["id"])
        follow = p.get("video_follows_audio", False)
        for cue in p["segments"]:
            cue["audio"]["duration"] = media.audio_duration(root / cue["audio"]["path"], cancel=job["cancel"])
        timeline = media.plan_dubbing_timeline(p["segments"], p["media"]["duration"], follow_video=follow)
        placements = {str(c["id"]): c for c in timeline["segments"]}
        segments = [{**c, **placements[str(c["id"])], "audio_path": str(root / c["audio"]["path"])} for c in p["segments"]]
        speech = media.render_speech_track(segments, root / ("timeline-" + job["id"] + ".wav"), timeline["duration"], cancel=job["cancel"])
        checks = {str(c["id"]): c for c in speech["segments"]}
        for cue in p["segments"]:
            check = checks[str(cue["id"])]
            cue["audio"].update({key: check[key] for key in ("speed", "overflow", "overlap", "tail_overflow") if key in check})
            cue["audio"]["video_extension"] = placements[str(cue["id"])]["video_extension"]
        if self.audio_issues(p):
            self.commit(job, p)
            raise ValueError("存在超时或重叠的配音，请精简译文、调整语速或重做对应句后再混音。")
        mixed = media.mix_audio(speech["path"], root / ("mix-" + job["id"] + ".wav"), timeline["duration"],
            background=(root / p["background_path"]) if p.get("background_path") else None,
            background_gain=p["mix"]["background_volume"], speech_gain=p["mix"]["voice_volume"], cancel=job["cancel"], loop_background=follow)
        preview = {"path": Path(mixed).name, "name": "混音预览.wav", "duration": timeline["duration"], "has_video": False}
        if follow and p["media"]["has_video"]:
            self.checkpoint(job, "正在对齐画面…", .7, "mix")
            video = media.export_video(root / p["media"]["path"], mixed, root / ("preview-" + job["id"] + ".mp4"),
                                       timeline=timeline, cancel=job["cancel"])
            preview.update(path=Path(video).name, name="译配预览.mp4", audio_path=Path(mixed).name, has_video=True)
        p["preview"] = preview
        p["output_timeline"] = timeline
        p["confirmed_audio"] = False

    def output_segments(self, p):
        """Keep source timing for editing and use rendered timing for output subtitles."""
        if not p.get("video_follows_audio") or not p.get("preview") or not p.get("output_timeline"):
            return p["segments"]
        timings = {str(c["id"]): c for c in p["output_timeline"]["segments"]}
        return [{**cue, "start": timings[str(cue["id"])]["start"], "end": timings[str(cue["id"])]["end"]} for cue in p["segments"]]

    def export(self, job, p, request):
        if not p.get("preview") or self.audio_issues(p):
            raise ValueError("请先完成混音预览与时长检查。")
        root = self.directory(p["id"])
        self.checkpoint(job, "正在导出译配成品…", .1, "export")
        options = {**p.get("options", {}), **(request.get("options") or {})}
        mode = options.get("subtitle_mode", "translation")
        if mode not in {"none", "translation", "bilingual"}:
            raise ValueError("未知字幕导出方式。")
        subtitles = None
        if mode != "none":
            cues = [{**c, "text": c["translation"] if mode == "translation" else c["text"] + "\n" + c["translation"]} for c in self.output_segments(p)]
            subtitles = media.write_subtitles(cues, root / ("export-" + job["id"] + ".srt"))
        name = "dubbed-" + job["id"]
        mixed = root / p["preview"].get("audio_path", p["preview"]["path"])
        if p["media"]["has_video"]:
            result = media.export_video(root / p["media"]["path"], mixed, root / (name + ".mp4"), subtitles=subtitles,
                burn_subtitles=bool(options.get("burn_subtitles")), cancel=job["cancel"],
                timeline=p.get("output_timeline") if p.get("video_follows_audio") else None)
        else:
            result = str(root / (name + ".wav"))
            shutil.copy2(mixed, result)
        basename = p["name"] + "-" + p["target_language"]
        items = [(Path(result), basename + Path(result).suffix)]
        if p["media"]["has_video"]:
            items.append((mixed, basename + ".wav"))
        if subtitles:
            items.append((Path(subtitles), basename + ".srt"))
        p["exports"].extend(self.publish_exports(p, items, job))
        Path(result).unlink()
        if subtitles:
            Path(subtitles).unlink()

    def export_subtitles(self, job, p, request):
        layer = request.get("layer", "source")
        fmt = request.get("format", "srt")
        if layer not in {"source", "translation", "bilingual"} or fmt not in {"srt", "vtt"}:
            raise ValueError("请选择 SRT / VTT 和字幕语言。")
        if not p["segments"] or (layer != "source" and any(not c.get("translation") for c in p["segments"])):
            raise ValueError("没有可导出的完整字幕。")
        if (p["scenario"] == "dubbing" and layer != "source" and p.get("video_follows_audio")
                and (not p.get("preview") or not p.get("output_timeline"))):
            raise ValueError("请先生成混音预览，再导出对齐成片的字幕。")
        root = self.directory(p["id"])
        output = self.output_segments(p) if p["scenario"] == "dubbing" else p["segments"]
        cues = ([{**c, "text": c["text"] + "\n" + c["translation"]} for c in output] if layer == "bilingual" else output)
        path = media.write_subtitles(cues, root / ("subtitles-" + job["id"] + "." + fmt), format=fmt, layer="translation" if layer == "translation" else "text")
        p["exports"].extend(self.publish_exports(p, [(Path(path), p["name"] + "-" + layer + "." + fmt)], job))
        Path(path).unlink()

    def run(self, job, p, request):
        self.work.local.operation = job["id"]
        job["status"] = "running"
        try:
            self.checkpoint(job)
            action = job["action"]
            if action == "translate":
                self.work.release_scenario_model(p["id"], operation=job["id"])
            if action in {"translate", "synthesize", "export", "export_subtitles"}:
                getattr(self, action)(job, p, request)
            else:
                getattr(self, action)(job, p)
            self.checkpoint(job)
            self.commit(job, p)
            if action in {"export", "export_subtitles"}:
                self.work.release_scenario_model(p["id"], operation=job["id"])
            job.update(status="done", message="已完成。", progress=1)
        except Exception as exc:
            message = self.work.clean_message(getattr(exc, "detail", None) or exc)
            secret = (request.get("llm") or {}).get("key")
            if secret:
                message = message.replace(secret, "[已隐藏]")
            job.update(status="cancelled" if job["cancel"].is_set() else "error",
                       message="任务已停止。" if job["cancel"].is_set() else message,
                       error="" if job["cancel"].is_set() else message)
        finally:
            request.pop("llm", None)
            job["elapsed"] = time.monotonic() - job["started"]
            self.work.release(job["id"])


def install_scenario_routes(app, work):
    projects = ScenarioProjects(work)
    app.state.scenarios = projects

    @app.get(PREFIX + "/capabilities")
    def capabilities(source_language: str = "auto", target_language: str = "en"):
        return projects.capabilities(source_language, target_language)

    @app.get(PREFIX + "/projects")
    def list_projects():
        return projects.list()

    @app.post(PREFIX + "/projects")
    def create_project(file: UploadFile = File(...), subtitle: UploadFile | None = File(None), name: str = Form(""), scenario: str = Form("subtitles"), source_path: str = Form(""), replace_id: str = Form(""), replace_revision: int | None = Form(None)):
        text = None
        if subtitle:
            if Path(subtitle.filename or "").suffix.lower() not in {".srt", ".vtt"}:
                raise ValueError("请选择 SRT / VTT 字幕。")
            text = subtitle.file.read(4 * 1024 * 1024 + 1)
            if len(text) > 4 * 1024 * 1024:
                raise ValueError("字幕文件过大。")
            text = text.decode("utf-8-sig")
        return projects.create(file.filename or "", file.file, name=name, scenario=scenario, subtitle=text,
                               source_path=source_path, replace_id=replace_id, replace_revision=replace_revision)

    @app.get(PREFIX + "/projects/{ident}")
    def read_project(ident: str):
        with projects.lock:
            return projects.public(projects.read(ident))

    @app.patch(PREFIX + "/projects/{ident}")
    def patch_project(ident: str, changes: dict):
        return projects.patch(ident, changes)

    @app.post(PREFIX + "/projects/{ident}/reset")
    def reset_project(ident: str, request: dict):
        return projects.reset(ident, request.get("revision"))

    @app.post(PREFIX + "/projects/{ident}/open-output")
    def open_output(ident: str):
        return projects.open_output(ident)

    @app.get(PREFIX + "/exports/{relative:path}")
    def exported_file(relative: str, download: bool = False):
        path = projects.export_file(relative)
        return FileResponse(path, filename=path.name if download else None)

    @app.post(PREFIX + "/projects/{ident}/subtitles")
    def import_subtitles(ident: str, file: UploadFile = File(...), revision: int = Form(...)):
        if Path(file.filename or "").suffix.lower() not in {".srt", ".vtt"}:
            raise ValueError("请选择 SRT / VTT 字幕。")
        data = file.file.read(4 * 1024 * 1024 + 1)
        if len(data) > 4 * 1024 * 1024:
            raise ValueError("字幕文件过大。")
        return projects.import_subtitles(ident, revision, data.decode("utf-8-sig"))

    @app.post(PREFIX + "/projects/{ident}/actions")
    def action(ident: str, request: dict):
        return projects.submit(ident, request)

    @app.get(PREFIX + "/jobs/{ident}")
    def get_job(ident: str):
        return projects.job(ident)

    @app.post(PREFIX + "/jobs/{ident}/cancel")
    def cancel(ident: str):
        return projects.cancel(ident)

    @app.get(PREFIX + "/projects/{ident}/files/{relative:path}")
    def file(ident: str, relative: str, download: bool = False):
        path = projects.file(ident, relative)
        if path.name in {"project.json", "project.tmp"} or path.suffix not in MEDIA_EXTENSIONS | {".srt", ".vtt"}:
            raise HTTPException(404, "文件不可下载。")
        name = path.name
        if download:
            with projects.lock:
                project = projects.read(ident)
                candidates = project.get("exports", []) + ([project["preview"]] if project.get("preview") else [])
                name = next((item.get("name", path.name) for item in candidates if item.get("path") == relative), path.name)
        return FileResponse(path, filename=name if download else None)

    return projects
