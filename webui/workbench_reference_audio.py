"""Bounded reference-audio inspection and non-destructive clipping."""
import math
from pathlib import Path
import subprocess
import tempfile
import wave

from fastapi import HTTPException


REFERENCE_SECONDS = 30.0
LIBRARY_SECONDS = 1200.0
REFERENCE_TOO_LONG = "参考音频推理会占用大量显存，请选择30秒内的音频"


def wav_duration(path):
    """Read a PCM WAV header without decoding the user's complete recording."""
    try:
        with wave.open(str(path), "rb") as source:
            duration = source.getnframes() / source.getframerate()
            return duration if math.isfinite(duration) and duration > 0 else None
    except (OSError, EOFError, wave.Error, ZeroDivisionError):
        return None


def _ffmpeg(backend):
    try:
        return backend._find_ffmpeg()
    except Exception as error:
        raise HTTPException(400, "无法读取或裁剪音频，请检查 ffmpeg 是否可用。") from error


def audio_duration(path, backend, *, limit=LIBRARY_SECONDS + .1):
    duration = wav_duration(path)
    if duration is not None:
        return duration
    # WebM recordings often have no duration metadata. Count bounded decoded PCM on
    # disk instead of trusting the container or loading a long waveform into RAM.
    command = [_ffmpeg(backend), "-nostdin", "-v", "error", "-i", str(path),
               "-t", str(limit), "-map", "0:a:0", "-vn", "-sn", "-dn",
               "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"]
    try:
        with tempfile.TemporaryFile() as decoded:
            result = subprocess.run(command, stdout=decoded, stderr=subprocess.PIPE, timeout=90)
            duration = decoded.tell() / 16000
        if result.returncode or duration <= 0:
            raise ValueError("invalid audio")
        return duration
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        raise HTTPException(400, "无法读取音频时长，请重新选择有效音频。") from error


def require_short_reference(path, backend):
    duration = audio_duration(path, backend, limit=REFERENCE_SECONDS + .1)
    if duration > REFERENCE_SECONDS:
        raise HTTPException(400, REFERENCE_TOO_LONG)
    return duration


def clip_reference(path, output, start, end, backend):
    if not (math.isfinite(start) and math.isfinite(end)) or start < 0 or end <= start:
        raise HTTPException(400, "请选择有效的音频裁剪范围。")
    if end - start > REFERENCE_SECONDS:
        raise HTTPException(400, "每段参考音频最多 30 秒，请缩短裁剪范围。")
    duration = audio_duration(path, backend)
    if end > duration + .000001:
        raise HTTPException(400, "裁剪范围超出了原始音频时长。")
    output = Path(output)
    try:
        if wav_duration(path) is not None:
            with wave.open(str(path), "rb") as source, wave.open(str(output), "wb") as target:
                rate = source.getframerate()
                first = int(start * rate)
                count = min(int((end - start) * rate), source.getnframes() - first)
                if count <= 0:
                    raise HTTPException(400, "裁剪片段过短，请重新选择。")
                target.setparams(source.getparams())
                source.setpos(first)
                while count:
                    frames = min(count, 65536)
                    data = source.readframes(frames)
                    if len(data) != frames * source.getnchannels() * source.getsampwidth():
                        raise HTTPException(400, "音频内容不完整，请重新上传。")
                    target.writeframesraw(data)
                    count -= frames
        else:
            command = [_ffmpeg(backend), "-nostdin", "-y", "-v", "error",
                       "-ss", str(start), "-i", str(path), "-t", str(end - start),
                       "-map", "0:a:0", "-vn", "-sn", "-dn", "-c:a", "pcm_s16le", str(output)]
            result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=90)
            if result.returncode:
                raise HTTPException(400, "音频裁剪失败，请重新选择裁剪范围。")
        return require_short_reference(output, backend)
    except (OSError, EOFError, wave.Error, subprocess.SubprocessError) as error:
        output.unlink(missing_ok=True)
        raise HTTPException(400, "音频裁剪失败，请重新选择裁剪范围。") from error
    except Exception:
        output.unlink(missing_ok=True)
        raise
