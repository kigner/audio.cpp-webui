"""Media and subtitle primitives for the local scenario workbench.

All destinations belong to the caller's project directory. Sources are read-only;
generated speech is never cut to fit a subtitle or silently cut at the film end.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import uuid
import wave

import numpy as np


class MediaError(RuntimeError):
    pass


class MediaCancelled(MediaError):
    pass


def _cancelled(cancel):
    return bool(cancel and (cancel.is_set() if hasattr(cancel, "is_set") else cancel()))


def check_cancel(cancel):
    if _cancelled(cancel):
        raise MediaCancelled("任务已停止")


def find_tool(name):
    """Find an explicit, bundled, or PATH FFmpeg executable without downloading."""
    if name not in ("ffmpeg", "ffprobe"):
        raise ValueError("Unsupported media tool")
    suffix = ".exe" if os.name == "nt" else ""
    here = Path(__file__).resolve().parent
    explicit = os.environ.get("AUDIOCPP_" + name.upper())
    if explicit:
        candidate = Path(explicit).expanduser()
        if candidate.is_dir():
            candidate /= name + suffix
        if candidate.is_file():
            return str(candidate.resolve())
        raise MediaError(f"配置的 {name} 不存在：{candidate}")
    candidates = [here / (name + suffix), here / "ffmpeg" / "bin" / (name + suffix),
                  here.parent / "ffmpeg" / "bin" / (name + suffix)]
    if name == "ffprobe":
        ffmpeg = os.environ.get("AUDIOCPP_FFMPEG") or shutil.which("ffmpeg")
        if ffmpeg:
            parent = Path(ffmpeg)
            candidates.insert(0, (parent if parent.is_dir() else parent.parent) / (name + suffix))
        candidates.insert(0, here / (name + suffix))
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate.resolve())
    found = shutil.which(name)
    if found:
        return found
    raise MediaError(f"找不到 {name}。请安装 FFmpeg，或设置 AUDIOCPP_{name.upper()}。")


def run_process(args, cancel=None, cwd=None, timeout=None):
    """Run argument lists, drain both pipes, and terminate promptly on cancellation."""
    check_cancel(cancel)
    import time

    started = time.monotonic()
    process = subprocess.Popen(
        [str(arg) for arg in args], stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=cwd,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        while True:
            check_cancel(cancel)
            if timeout and time.monotonic() - started > timeout:
                raise MediaError("媒体处理超时")
            try:
                stdout, stderr = process.communicate(timeout=0.1)
                break
            except subprocess.TimeoutExpired:
                continue
    except BaseException:
        process.terminate()
        try:
            process.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
        raise
    if process.returncode:
        message = stderr.decode("utf-8", errors="replace").strip()[-1800:]
        raise MediaError(message or f"媒体处理失败（{process.returncode}）")
    check_cancel(cancel)
    return stdout


def _number(value, fallback=0.0):
    try:
        result = float(value)
        return result if math.isfinite(result) else fallback
    except (TypeError, ValueError):
        return fallback


def probe_media(path, cancel=None):
    source = Path(path).resolve()
    if not source.is_file():
        raise MediaError(f"素材不存在：{source}")
    raw = run_process([find_tool("ffprobe"), "-v", "error", "-show_format",
                       "-show_streams", "-of", "json", str(source)], cancel, timeout=30)
    try:
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError) as exc:
        raise MediaError("无法读取素材信息") from exc
    streams = data.get("streams", [])
    audio = next((s for s in streams if s.get("codec_type") == "audio"), {})
    video = next((s for s in streams if s.get("codec_type") == "video"
                  and not s.get("disposition", {}).get("attached_pic")), {})
    duration = max([_number(data.get("format", {}).get("duration"))]
                   + [_number(s.get("duration")) for s in streams])
    if duration <= 0:
        raise MediaError("素材没有可用的时长")
    return {"duration": duration, "has_video": bool(video), "has_audio": bool(audio),
            "sample_rate": int(_number(audio.get("sample_rate"))),
            "channels": int(_number(audio.get("channels"))),
            "width": int(_number(video.get("width"))),
            "height": int(_number(video.get("height"))),
            "video_codec": video.get("codec_name", ""),
            "audio_codec": audio.get("codec_name", "")}


def audio_duration(path, cancel=None):
    check_cancel(cancel)
    try:
        with wave.open(str(path), "rb") as audio:
            return audio.getnframes() / audio.getframerate()
    except (wave.Error, EOFError):
        info = probe_media(path, cancel)
        if not info["has_audio"]:
            raise MediaError("文件不包含音轨")
        return info["duration"]


def _destination(dest, sources=()):
    dest = Path(dest).resolve()
    if any(os.path.normcase(str(dest)) == os.path.normcase(str(Path(p).resolve()))
           for p in sources if p):
        raise MediaError("输出不能覆盖原素材")
    dest.parent.mkdir(parents=True, exist_ok=True)
    temporary = dest.with_name(f".{dest.stem}.{uuid.uuid4().hex}{dest.suffix}")
    return dest, temporary


def _ffmpeg_output(arguments, dest, sources=(), cancel=None, cwd=None):
    dest, temporary = _destination(dest, sources)
    try:
        run_process([find_tool("ffmpeg"), "-nostdin", "-y", "-v", "error",
                     *arguments, str(temporary)], cancel, cwd)
        if not temporary.is_file() or temporary.stat().st_size == 0:
            raise MediaError("媒体处理没有生成有效文件")
        check_cancel(cancel)
        os.replace(temporary, dest)
        return str(dest)
    finally:
        temporary.unlink(missing_ok=True)


def extract_audio(source, dest, cancel=None, start=None, duration=None,
                  sample_rate=48000, channels=2):
    """Extract PCM16 WAV; selecting a range is explicit and only for source crops."""
    if sample_rate <= 0 or channels not in (1, 2):
        raise ValueError("Invalid audio format")
    args = []
    if start is not None:
        if not math.isfinite(float(start)) or float(start) < 0:
            raise ValueError("Invalid clip start")
        args += ["-ss", f"{float(start):.9f}"]
    args += ["-i", str(Path(source).resolve()), "-map", "0:a:0", "-vn"]
    if duration is not None:
        if not math.isfinite(float(duration)) or float(duration) <= 0:
            raise ValueError("Invalid clip duration")
        args += ["-t", f"{float(duration):.9f}"]
    args += ["-ar", str(sample_rate), "-ac", str(channels), "-c:a", "pcm_s16le"]
    return _ffmpeg_output(args, dest, (source,), cancel)


_TIMESTAMP = re.compile(r"^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})$")
_TIMING_LINE = re.compile(r"^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$")


def parse_timestamp(value):
    match = _TIMESTAMP.fullmatch(str(value).strip())
    if not match:
        raise ValueError(f"无效时间：{value}（格式为 00:00:00.000）")
    hours, minutes, seconds, millis = match.groups()
    if int(minutes) >= 60 or int(seconds) >= 60:
        raise ValueError(f"无效时间：{value}")
    return int(hours or 0) * 3600 + int(minutes) * 60 + int(seconds) + int(millis) / 1000


def format_timestamp(seconds, vtt=False):
    value = float(seconds)
    if not math.isfinite(value) or value < 0:
        raise ValueError("字幕时间必须为非负数")
    millis = int(round(value * 1000))
    hours, millis = divmod(millis, 3600000)
    minutes, millis = divmod(millis, 60000)
    secs, millis = divmod(millis, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{'.' if vtt else ','}{millis:03d}"


def validate_cues(segments):
    result = []
    previous_start = -1.0
    for index, source in enumerate(segments, 1):
        cue = dict(source)
        try:
            start, end = float(cue["start"]), float(cue["end"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"第 {index} 句缺少有效时间") from exc
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
            raise ValueError(f"第 {index} 句必须满足 0 ≤ 开始时间 < 结束时间")
        if start < previous_start:
            raise ValueError(f"第 {index} 句的开始时间早于上一句，请先按时间排序")
        text = str(cue.get("text", "")).strip().replace("\r\n", "\n").replace("\r", "\n")
        if not text:
            raise ValueError(f"第 {index} 句字幕不能为空")
        cue.update(id=cue.get("id", index), start=start, end=end, text=text)
        result.append(cue)
        previous_start = start
    if not result:
        raise ValueError("没有有效字幕")
    return result


def _read_subtitle_text(value):
    if isinstance(value, os.PathLike) or ("\n" not in str(value) and "-->" not in str(value)
                                         and Path(str(value)).is_file()):
        data = Path(value).read_bytes()
        encodings = ("utf-16",) if data[:2] in (b"\xff\xfe", b"\xfe\xff") else ("utf-8-sig", "gb18030")
        for encoding in encodings:
            try:
                return data.decode(encoding)
            except UnicodeError:
                pass
        raise ValueError("字幕编码无法读取，请使用 UTF-8")
    return str(value).lstrip("\ufeff")


def parse_subtitles(path_or_text):
    text = _read_subtitle_text(path_or_text).replace("\r\n", "\n").replace("\r", "\n").strip()
    is_vtt = text.startswith("WEBVTT")
    if is_vtt:
        text = re.sub(r"^WEBVTT[^\n]*\n?", "", text, count=1).lstrip()
    segments = []
    for block in re.split(r"\n\s*\n", text):
        lines = block.splitlines()
        if not lines or (is_vtt and re.match(r"^(NOTE(?:\s|$)|STYLE$|REGION$)", lines[0])):
            continue
        timing_index = next((i for i, line in enumerate(lines[:2]) if "-->" in line), None)
        if timing_index is None:
            # Header metadata is permitted in WebVTT before its first cue.
            if is_vtt and not segments and all(":" in line for line in lines):
                continue
            raise ValueError("字幕块缺少 SRT / VTT 时间轴")
        match = _TIMING_LINE.fullmatch(lines[timing_index])
        if not match:
            raise ValueError(f"无效字幕时间轴：{lines[timing_index]}")
        segments.append({"id": len(segments) + 1, "start": parse_timestamp(match[1]),
                         "end": parse_timestamp(match[2]), "text": "\n".join(lines[timing_index + 1:])})
    return validate_cues(segments)


def _format_subtitles(segments, vtt=False, layer="text"):
    cues = validate_cues(segments)
    blocks = []
    for index, cue in enumerate(cues, 1):
        text = str(cue.get(layer, "")).strip()
        if not text:
            raise ValueError(f"第 {index} 句没有可导出的字幕")
        # Blank lines delimit cues and therefore cannot appear inside a cue.
        text = re.sub(r"\n\s*\n", "\n", text.replace("\r", ""))
        blocks.append(f"{index}\n{format_timestamp(cue['start'], vtt)} --> "
                      f"{format_timestamp(cue['end'], vtt)}\n{text}")
    return ("WEBVTT\n\n" if vtt else "") + "\n\n".join(blocks) + "\n"


def format_srt(segments, layer="text"):
    return _format_subtitles(segments, False, layer)


def format_vtt(segments, layer="text"):
    return _format_subtitles(segments, True, layer)


def write_subtitles(segments, path, format=None, layer="text"):
    kind = str(format or Path(path).suffix.lstrip(".")).lower()
    if kind not in ("srt", "vtt"):
        raise ValueError("字幕导出格式只支持 SRT / VTT")
    text = _format_subtitles(segments, kind == "vtt", layer)
    dest, temporary = _destination(path)
    try:
        temporary.write_text(text, encoding="utf-8", newline="\n")
        os.replace(temporary, dest)
    finally:
        temporary.unlink(missing_ok=True)
    return str(dest)


def _normalized_wav(source, dest, cancel=None, speed=1.0):
    if not math.isfinite(float(speed)) or not 0.5 <= float(speed) <= 2.0:
        raise ValueError("配音速度必须在 0.5 至 2.0 之间")
    args = ["-i", str(Path(source).resolve()), "-map", "0:a:0", "-vn"]
    if abs(speed - 1.0) > 0.00001:
        args += ["-af", f"atempo={speed:.9f}"]
    args += ["-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le"]
    return _ffmpeg_output(args, dest, (source,), cancel)


def concatenate_audio(paths, dest, cancel=None, durations=None):
    """Join audio without whole-film buffers.

    By default every input is retained in full. ``durations`` explicitly restores
    the source chunk lengths after separation (trim padding or add silence); it
    must not be used to fit generated TTS into subtitle windows.
    """
    paths = list(paths)
    if not paths:
        raise ValueError("没有可拼接的音频")
    if durations is not None:
        durations = [float(value) for value in durations]
        if len(durations) != len(paths) or any(not math.isfinite(value) or value <= 0 for value in durations):
            raise ValueError("音频分段与源时长必须一一对应")
    dest, temporary = _destination(dest, paths)
    try:
        with tempfile.TemporaryDirectory(prefix="concat_", dir=dest.parent) as work:
            with wave.open(str(temporary), "wb") as output:
                output.setparams((2, 2, 48000, 0, "NONE", "not compressed"))
                for index, source in enumerate(paths):
                    check_cancel(cancel)
                    normalized = Path(_normalized_wav(source, Path(work) / "chunk.wav", cancel))
                    try:
                        with wave.open(str(normalized), "rb") as audio:
                            remaining = audio.getnframes() if durations is None else int(round(durations[index] * 48000))
                            while remaining:
                                check_cancel(cancel)
                                count = min(48000, remaining)
                                raw = audio.readframes(count)
                                # Separation can return a slightly short final
                                # chunk. Explicit source timing preserves the
                                # next chunk's original position without drift.
                                if len(raw) < count * 4:
                                    raw += b"\0" * (count * 4 - len(raw))
                                output.writeframesraw(raw)
                                remaining -= count
                    finally:
                        normalized.unlink(missing_ok=True)
        check_cancel(cancel)
        os.replace(temporary, dest)
    finally:
        temporary.unlink(missing_ok=True)
    return str(dest)


def _mix_wavs(records, dest, duration, cancel=None):
    """Mix normalized PCM16 clips in one-second blocks to bound memory use."""
    total_frames = int(math.ceil(float(duration) * 48000 - 1e-7))
    if total_frames <= 0:
        raise ValueError("混音时长必须大于 0")
    pending = sorted([(int(round(start * 48000)), str(path), float(gain))
                      for path, start, gain in records], key=lambda item: item[0])
    if any(start < 0 or not math.isfinite(gain) or gain < 0 for start, _, gain in pending):
        raise ValueError("无效的混音位置或音量")
    dest, temporary = _destination(dest, [record[0] for record in records])
    active = []
    cursor = 0
    try:
        with wave.open(str(temporary), "wb") as output:
            output.setparams((2, 2, 48000, 0, "NONE", "not compressed"))
            for block_start in range(0, total_frames, 48000):
                check_cancel(cancel)
                count = min(48000, total_frames - block_start)
                block = np.zeros((count, 2), dtype=np.float32)
                while cursor < len(pending) and pending[cursor][0] < block_start + count:
                    start, path, gain = pending[cursor]
                    audio = wave.open(path, "rb")
                    if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (2, 2, 48000):
                        audio.close()
                        raise MediaError("混音输入必须为 48 kHz 双声道 PCM16 WAV")
                    if start < block_start:
                        audio.setpos(min(block_start - start, audio.getnframes()))
                    active.append((start, audio, gain))
                    cursor += 1
                remaining = []
                for start, audio, gain in active:
                    offset = max(0, start - block_start)
                    samples = np.frombuffer(audio.readframes(count - offset), dtype="<i2").reshape(-1, 2)
                    block[offset:offset + len(samples)] += samples.astype(np.float32) * gain
                    if audio.tell() < audio.getnframes():
                        remaining.append((start, audio, gain))
                    else:
                        audio.close()
                active = remaining
                output.writeframesraw(np.clip(block, -32768, 32767).astype("<i2").tobytes())
        check_cancel(cancel)
        os.replace(temporary, dest)
    finally:
        for _, audio, _ in active:
            audio.close()
        temporary.unlink(missing_ok=True)
    return str(dest)


def _sentence_speed(cue, original_duration, budget, max_speed=1.20):
    """An explicit 1.0 is a user choice, not the automatic-fit sentinel."""
    if cue.get("speed") is None:
        return min(max_speed, max(1.0, original_duration / budget))
    speed = float(cue["speed"])
    if not math.isfinite(speed) or not 0.5 <= speed <= 2.0:
        raise ValueError("配音速度必须在 0.5 至 2.0 之间")
    return speed


def _timing_overflow(actual, budget):
    # PCM normalization/placement rounds to a 48 kHz sample grid. Do not turn
    # a sub-sample boundary difference into a sentence collision or tail error.
    excess = actual - budget
    return excess if excess > 1.0 / 48000 + 1e-9 else 0.0


def plan_dubbing_timeline(segments, total_duration, follow_video=True):
    """Map natural speech to expandable source windows, or check the fixed film."""
    cues = validate_cues(segments)
    total_duration = float(total_duration)
    if not math.isfinite(total_duration) or total_duration <= 0:
        raise ValueError("素材时长无效")
    timings, spans = [], []
    offset = 0.0
    if follow_video and cues[0]["start"] > 0:
        spans.append({"source_start": 0.0, "source_end": cues[0]["start"],
                      "start": 0.0, "end": cues[0]["start"]})
    for index, cue in enumerate(cues):
        original = _number((cue.get("audio") or {}).get("duration"))
        if original <= 0:
            raise ValueError(f"第 {index + 1} 句没有有效配音时长")
        next_start = cues[index + 1]["start"] if index + 1 < len(cues) else total_duration
        budget = cue["end"] - cue["start"]
        speed = 1.0 if follow_video else _sentence_speed(cue, original, budget)
        duration = (math.ceil(original * 48000 - 1e-7) / 48000
                    if follow_video else original / speed)
        extension = 0.0
        if follow_video:
            window = next_start - cue["start"]
            if window <= 0 or next_start > total_duration:
                raise ValueError("画面跟随配音需要逐句开始时间递增，且位于素材时长内")
            extension = max(0.0, duration - window)
            spans.append({"source_start": cue["start"], "source_end": next_start,
                          "start": cue["start"] + offset,
                          "end": next_start + offset + extension})
        start = cue["start"] + offset
        actual_end = start + duration
        timings.append({"id": cue["id"], "start": start,
                        "end": actual_end if follow_video else cue["end"],
                        "speed": speed, "audio_duration": duration,
                        "original_duration": original,
                        "overflow": 0.0 if follow_video else _timing_overflow(duration, budget),
                        "overlap": 0.0 if follow_video else _timing_overflow(actual_end, next_start),
                        "tail_overflow": 0.0 if follow_video else _timing_overflow(actual_end, total_duration),
                        "video_extension": extension})
        offset += extension
    if not follow_video:
        spans = [{"source_start": 0.0, "source_end": total_duration,
                  "start": 0.0, "end": total_duration}]
    return {"duration": total_duration + offset, "segments": timings, "spans": spans}


def render_speech_track(segments, dest, total_duration, cancel=None, max_speed=1.20):
    """Place complete sentences at cue starts, reporting overflow and collisions."""
    cues = validate_cues(segments)
    if not 1.0 <= max_speed <= 2.0:
        raise ValueError("自动配音速度上限必须在 1.0 至 2.0 之间")
    if not math.isfinite(float(total_duration)) or total_duration <= 0:
        raise ValueError("素材时长无效")
    _destination(dest, [cue.get("audio_path") for cue in cues])
    prepared, timings = [], []
    with tempfile.TemporaryDirectory(prefix="speech_", dir=Path(dest).resolve().parent) as work:
        for index, cue in enumerate(cues):
            check_cancel(cancel)
            path = cue.get("audio_path")
            if not path:
                raise ValueError(f"第 {index + 1} 句没有配音")
            original_duration = audio_duration(path, cancel)
            budget = cue["end"] - cue["start"]
            speed = _sentence_speed(cue, original_duration, budget, max_speed)
            normalized = _normalized_wav(path, Path(work) / f"{index:05d}.wav", cancel, speed)
            actual_duration = audio_duration(normalized, cancel)
            actual_end = cue["start"] + actual_duration
            next_start = cues[index + 1]["start"] if index + 1 < len(cues) else total_duration
            timings.append({"id": cue["id"], "start": cue["start"], "end": cue["end"],
                            "audio_duration": actual_duration, "original_duration": original_duration,
                            "speed": speed, "overflow": _timing_overflow(actual_duration, budget),
                            "overlap": _timing_overflow(actual_end, next_start),
                            "tail_overflow": _timing_overflow(actual_end, total_duration)})
            prepared.append((normalized, cue["start"], 1.0))
        duration = max(total_duration, max(t["start"] + t["audio_duration"] for t in timings))
        path = _mix_wavs(prepared, dest, duration, cancel)
    return {"path": path, "duration": audio_duration(path), "segments": timings}


def mix_background(stem_paths, dest, total_duration, cancel=None):
    """Combine only separated non-vocal stems supplied by the separation stage."""
    paths = [str(path) for path in stem_paths]
    if not paths:
        raise ValueError("没有分离后的背景音轨")
    for path in paths:
        if re.search(r"(?:^|[_\-\s])vocals?(?:$|[_\-\s])", Path(path).stem, re.I):
            raise ValueError("背景音轨不能包含 vocals 原人声")
    _destination(dest, paths)
    with tempfile.TemporaryDirectory(prefix="background_", dir=Path(dest).resolve().parent) as work:
        records = [(_normalized_wav(path, Path(work) / f"{index}.wav", cancel), 0.0, 1.0)
                   for index, path in enumerate(paths)]
        return _mix_wavs(records, dest, total_duration, cancel)


def mix_audio(speech, dest, total_duration, background=None, background_gain=1.0,
              speech_gain=1.0, cancel=None, loop_background=False):
    if audio_duration(speech, cancel) > total_duration + 1.0 / 48000 + 1e-9:
        raise MediaError("配音超出素材结尾，请先调整末句时长；不会裁掉句尾")
    _destination(dest, (speech, background))
    with tempfile.TemporaryDirectory(prefix="mix_", dir=Path(dest).resolve().parent) as work:
        records = [(_normalized_wav(speech, Path(work) / "speech.wav", cancel), 0.0, speech_gain)]
        if background:
            if loop_background:
                background_path = _ffmpeg_output(
                    ["-stream_loop", "-1", "-i", str(Path(background).resolve()),
                     "-map", "0:a:0", "-vn", "-t", f"{total_duration:.9f}",
                     "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le"],
                    Path(work) / "background.wav", (background,), cancel)
            else:
                background_path = _normalized_wav(background, Path(work) / "background.wav", cancel)
            records.append((background_path, 0.0, background_gain))
        return _mix_wavs(records, dest, total_duration, cancel)


def _video_timing_filter(timeline, source_duration):
    """A balanced expression maps one video stream without buffering split clips."""
    duration = _number(timeline.get("duration"))
    spans = timeline.get("spans") or []
    if duration < source_duration - 0.001 or not spans:
        raise ValueError("无效的画面对齐时间轴")
    previous_source = previous_end = 0.0
    for span in spans:
        values = [float(span[key]) for key in ("source_start", "source_end", "start", "end")]
        source_start, source_end, start, end = values
        if (not all(math.isfinite(value) for value in values)
                or abs(source_start - previous_source) > 0.001
                or abs(start - previous_end) > 0.001 or source_end <= source_start
                or end - start < source_end - source_start - 0.001):
            raise ValueError("无效的画面对齐时间轴")
        previous_source, previous_end = source_end, end
    if abs(previous_source - source_duration) > 0.1 or abs(previous_end - duration) > 0.001:
        raise ValueError("画面对齐时间轴与素材时长不一致")

    def expression(items):
        if len(items) == 1:
            span = items[0]
            scale = (span["end"] - span["start"]) / (span["source_end"] - span["source_start"])
            return f"({span['start']:.9f}+(T-{span['source_start']:.9f})*{scale:.12f})"
        middle = len(items) // 2
        return (f"if(lt(T,{items[middle]['source_start']:.9f}),"
                f"{expression(items[:middle])},{expression(items[middle:])})")

    # setpts alone leaves the final frame with its old frame duration. Clone only
    # the missing tail, then trim, so even a very slow final window ends exactly.
    return (f"setpts=PTS-STARTPTS,setpts='{expression(spans)}/TB',"
            f"tpad=stop_mode=clone:stop_duration={duration:.9f},trim=duration={duration:.9f}")


def export_video(source, audio, dest, subtitles=None, burn_subtitles=False, cancel=None,
                 timeline=None):
    """Create browser-compatible H.264/AAC MP4, replacing the original audio."""
    info = probe_media(source, cancel)
    if not info["has_video"]:
        raise MediaError("源素材不含视频，请导出 WAV 音频")
    duration = float(timeline["duration"]) if timeline is not None else info["duration"]
    timing_filter = _video_timing_filter(timeline, info["duration"]) if timeline is not None else None
    if audio_duration(audio, cancel) > duration + 1.0 / 48000 + 1e-9:
        raise MediaError("配音超出视频结尾，请先调整末句；不会裁掉句尾")
    dest, _ = _destination(dest, (source, audio, subtitles))
    with tempfile.TemporaryDirectory(prefix="export_", dir=dest.parent) as work:
        args = ["-i", str(Path(source).resolve()), "-i", str(Path(audio).resolve())]
        if subtitles:
            # A relative ASCII filename avoids FFmpeg filter escaping of Windows
            # drive letters, apostrophes, brackets, commas, and Unicode paths.
            caption = Path(work) / "captions.srt"
            write_subtitles(parse_subtitles(subtitles), caption, "srt")
            if not burn_subtitles:
                args += ["-i", str(caption)]
        args += ["-map", "0:v:0", "-map", "1:a:0"]
        if subtitles and not burn_subtitles:
            args += ["-map", "2:s:0", "-c:s", "mov_text", "-disposition:s:0", "default"]
        filters = [timing_filter] if timing_filter else []
        if subtitles and burn_subtitles:
            filters.append("subtitles=filename=captions.srt")
        if filters:
            # Scripts keep hundreds of cue expressions off the Windows CLI.
            script = Path(work) / "video-filter.txt"
            script.write_text(",".join(filters), encoding="utf-8")
            args += ["-filter_script:v", str(script)]
        if timeline is not None:
            args += ["-t", f"{duration:.9f}"]
        args += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
                 "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]
        return _ffmpeg_output(args, dest, (source, audio, subtitles), cancel, work)
