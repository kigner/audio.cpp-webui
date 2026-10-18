"""Audio limits use bounded decoding even for containers without duration metadata."""
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave

from fastapi import HTTPException

try:
    from . import workbench_reference_audio as audio
except ImportError:
    import workbench_reference_audio as audio


class ReferenceAudioTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.ffmpeg = Path(__file__).parent / "ffmpeg.exe"
        self.backend = SimpleNamespace(_find_ffmpeg=lambda: str(self.ffmpeg))

    def test_duration_decode_is_bounded_and_does_not_buffer_pcm_in_memory(self):
        source = self.root / "container.webm"
        source.write_bytes(b"encoded audio")
        def decode(command, **kwargs):
            self.assertEqual(command[command.index("-t") + 1], "30.1")
            self.assertEqual(command[command.index("-ac") + 1], "1")
            self.assertEqual(command[command.index("-ar") + 1], "8000")
            self.assertGreater(kwargs["timeout"], 0)
            kwargs["stdout"].write(b"\0" * (31 * 16000))
            return SimpleNamespace(returncode=0)
        with patch.object(audio.subprocess, "run", side_effect=decode):
            with self.assertRaises(HTTPException) as result:
                audio.require_short_reference(source, self.backend)
        self.assertEqual(result.exception.detail, audio.REFERENCE_TOO_LONG)

    def test_failed_clip_removes_partial_output_and_preserves_source(self):
        source, output = self.root / "source.mp3", self.root / "clip.wav"
        source.write_bytes(b"original")
        def fail(command, **_kwargs):
            output.write_bytes(b"partial")
            raise subprocess.TimeoutExpired(command, 90)
        with patch.object(audio, "audio_duration", return_value=60), \
                patch.object(audio.subprocess, "run", side_effect=fail):
            with self.assertRaises(HTTPException):
                audio.clip_reference(source, output, 5, 10, self.backend)
        self.assertFalse(output.exists())
        self.assertEqual(source.read_bytes(), b"original")

    def test_compressed_mp3_and_headerless_webm_can_be_measured_and_clipped(self):
        if not self.ffmpeg.is_file():
            self.skipTest("bundled ffmpeg unavailable")
        for suffix, codec in ((".mp3", "libmp3lame"), (".webm", "libopus")):
            with self.subTest(format=suffix):
                source = self.root / ("original" + suffix)
                subprocess.run([str(self.ffmpeg), "-nostdin", "-y", "-v", "error", "-f", "lavfi",
                    "-i", "sine=frequency=440:sample_rate=24000:duration=35", "-c:a", codec,
                    str(source)], check=True, capture_output=True, timeout=20)
                if suffix == ".webm":
                    # Browser MediaRecorder blobs lack final container duration.
                    command = [str(self.ffmpeg), "-nostdin", "-y", "-v", "error", "-i", str(source),
                               "-c", "copy", "-f", "webm", "pipe:1"]
                    source.write_bytes(subprocess.run(command, check=True, capture_output=True, timeout=20).stdout)
                original = source.read_bytes()
                self.assertAlmostEqual(audio.audio_duration(source, self.backend), 35, places=2)
                with self.assertRaises(HTTPException):
                    audio.require_short_reference(source, self.backend)
                output = self.root / (suffix[1:] + "-clip.wav")
                duration = audio.clip_reference(source, output, 5, 35, self.backend)
                self.assertGreater(duration, 29.9)
                self.assertLessEqual(duration, 30)
                self.assertEqual(source.read_bytes(), original)
                with wave.open(str(output), "rb") as wav:
                    self.assertEqual(wav.getframerate(), 24000 if suffix == ".mp3" else 48000)


if __name__ == "__main__":
    unittest.main()
