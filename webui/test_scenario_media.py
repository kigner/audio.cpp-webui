"""Subtitle round trips and short media checks; no model/runtime inference."""

import hashlib
import math
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
import wave

import numpy as np

try:
    from . import scenario_media as media
except ImportError:
    import scenario_media as media


def _temporary_directory():
    # Workspace-local tests also work in Windows AppContainer sandboxes whose
    # virtual temp directory does not grant the rename right used by os.replace.
    root = Path(__file__).resolve().parent.parent / "build" / "scenario-media-tests"
    root.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(dir=root)


class SubtitleTests(unittest.TestCase):
    def test_srt_multiline_unicode_roundtrip(self):
        source = "\ufeff7\r\n00:00:00,125 --> 00:00:02,300\r\n你好\r\nEnglish text\r\n\r\n9\r\n01:02:03,004 --> 01:02:06,500\r\n下一句\r\n"
        cues = media.parse_subtitles(source)
        self.assertEqual(cues[0]["text"], "你好\nEnglish text")
        self.assertEqual(cues[1]["start"], 3723.004)
        self.assertEqual(media.parse_subtitles(media.format_srt(cues)), cues)
        self.assertEqual(media.parse_subtitles(media.format_vtt(cues)), cues)

    def test_vtt_notes_settings_and_named_cues(self):
        source = "WEBVTT\n\nNOTE source\nmetadata\n\nintro\n00:01.000 --> 00:02.500 align:start position:10%\nHello\n\nSTYLE\n::cue {color: white}\n"
        self.assertEqual(media.parse_subtitles(source),
                         [{"id": 1, "start": 1.0, "end": 2.5, "text": "Hello"}])

    def test_vtt_header_metadata(self):
        source = "WEBVTT\nKind: captions\nLanguage: en\n\n00:00.000 --> 00:01.000\nHello"
        self.assertEqual(media.parse_subtitles(source)[0]["text"], "Hello")

    def test_invalid_or_incomplete_cues_are_rejected(self):
        for text in ("plain text", "1\n00:60:00,000 --> 00:61:00,000\ntext",
                     "1\n00:00:02,000 --> 00:00:01,000\ntext",
                     "1\n00:00:00,000 --> 00:00:01,000\n"):
            with self.subTest(text=text), self.assertRaises(ValueError):
                media.parse_subtitles(text)

    def test_nonfinite_unsorted_and_empty_cues_are_rejected(self):
        for cues in ([{"start": math.nan, "end": 1, "text": "x"}],
                     [{"start": 0, "end": math.inf, "text": "x"}],
                     [{"start": 0, "end": 1, "text": ""}],
                     [{"start": 1, "end": 2, "text": "a"},
                      {"start": 0, "end": 1, "text": "b"}], []):
            with self.subTest(cues=cues), self.assertRaises(ValueError):
                media.validate_cues(cues)

    def test_overlapping_captions_remain_editable(self):
        cues = [{"start": 0, "end": 2, "text": "a"},
                {"start": 1, "end": 3, "text": "b"}]
        self.assertEqual(len(media.parse_subtitles(media.format_srt(cues))), 2)

    def test_utf16_import_and_utf8_layer_export(self):
        with _temporary_directory() as directory:
            source = Path(directory) / "原文.srt"
            source.write_text("1\n00:00:00,000 --> 00:00:01,000\n中文", encoding="utf-16")
            cues = media.parse_subtitles(source)
            cues[0]["translation"] = "English"
            target = Path(directory) / "英文.vtt"
            media.write_subtitles(cues, target, layer="translation")
            self.assertTrue(target.read_bytes().startswith(b"WEBVTT"))
            self.assertEqual(media.parse_subtitles(target)[0]["text"], "English")
            self.assertEqual(media.parse_subtitles(source)[0]["text"], "中文")

    def test_timestamp_millisecond_carry(self):
        self.assertEqual(media.format_timestamp(59.9996), "00:01:00,000")
        self.assertEqual(media.format_timestamp(3600.125, True), "01:00:00.125")


class DubbingTimelineTests(unittest.TestCase):
    def test_following_video_uses_pauses_then_extends_without_speeding_speech(self):
        cues = [
            {"id": 1, "start": 0.5, "end": 1, "text": "a", "audio": {"duration": 1.2}},
            {"id": 2, "start": 2, "end": 3, "text": "b", "audio": {"duration": 3}, "speed": 1.8},
            {"id": 3, "start": 4, "end": 4.8, "text": "c", "audio": {"duration": 2}},
        ]
        plan = media.plan_dubbing_timeline(cues, 5)
        self.assertEqual(plan["duration"], 7)
        self.assertEqual([(s["start"], s["end"]) for s in plan["segments"]],
                         [(0.5, 1.7), (2, 5), (5, 7)])
        self.assertEqual([s["video_extension"] for s in plan["segments"]], [0, 1, 1])
        self.assertEqual([s["speed"] for s in plan["segments"]], [1, 1, 1])
        self.assertEqual(plan["spans"][0],
                         {"source_start": 0, "source_end": 0.5, "start": 0, "end": 0.5})
        self.assertEqual(plan["spans"][-1]["source_end"], 5)
        self.assertEqual(cues[1]["speed"], 1.8)
        self.assertEqual(cues[2]["start"], 4)

    def test_fixed_video_distinguishes_explicit_one_from_auto_speed(self):
        cue = {"start": 0, "end": 1, "text": "a", "audio": {"duration": 1.5}}
        automatic = media.plan_dubbing_timeline([cue], 1, False)["segments"][0]
        explicit = media.plan_dubbing_timeline([{**cue, "speed": 1}], 1, False)["segments"][0]
        self.assertEqual(automatic["speed"], 1.2)
        self.assertEqual(explicit["speed"], 1)
        self.assertEqual(explicit["tail_overflow"], 0.5)
        self.assertEqual(explicit["video_extension"], 0)

    def test_following_video_rejects_unmappable_or_unknown_audio(self):
        cue = {"start": 0, "end": 1, "text": "a", "audio": {"duration": 1}}
        for cues in ([cue, cue], [{**cue, "start": 1, "end": 2}],
                     [{**cue, "audio": {"duration": 0}}]):
            with self.subTest(cues=cues), self.assertRaises(ValueError):
                media.plan_dubbing_timeline(cues, 1)


def _tone(path, duration, frequency=660, gain=0.2):
    values = (np.sin(np.arange(round(duration * 48000)) * 2 * np.pi * frequency / 48000)
              * gain * 32767).astype("<i2")
    with wave.open(str(path), "wb") as output:
        output.setparams((2, 2, 48000, 0, "NONE", "not compressed"))
        output.writeframes(np.repeat(values[:, None], 2, axis=1).tobytes())
    return str(path)


class ShortMediaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            media.find_tool("ffmpeg")
            media.find_tool("ffprobe")
        except media.MediaError as exc:
            raise unittest.SkipTest(str(exc))

    def setUp(self):
        self.temporary = _temporary_directory()
        self.directory = Path(self.temporary.name) / "中文 [素材], '测试'"
        self.directory.mkdir()
        self.source = _tone(self.directory / "原始声音.wav", 0.5)
        self.original_hash = hashlib.sha256(Path(self.source).read_bytes()).hexdigest()

    def tearDown(self):
        self.assertEqual(hashlib.sha256(Path(self.source).read_bytes()).hexdigest(), self.original_hash)
        self.temporary.cleanup()

    def test_extract_range_and_probe(self):
        output = media.extract_audio(self.source, self.directory / "片段.wav", start=0.1,
                                     duration=0.2, sample_rate=16000, channels=1)
        info = media.probe_media(output)
        self.assertFalse(info["has_video"])
        self.assertTrue(info["has_audio"])
        self.assertEqual((info["sample_rate"], info["channels"]), (16000, 1))
        self.assertAlmostEqual(info["duration"], 0.2, places=3)

    def test_source_cannot_be_output(self):
        for action in (lambda: media.extract_audio(self.source, self.source),
                       lambda: media.mix_audio(self.source, self.source, 0.5),
                       lambda: media.mix_background([self.source], self.source, 0.5),
                       lambda: media.render_speech_track(
                           [{"start": 0, "end": 0.5, "text": "a", "audio_path": self.source}],
                           self.source, 0.5)):
            with self.assertRaises(media.MediaError):
                action()

    def test_timeline_placement_and_bounded_auto_speed(self):
        cues = [{"id": 3, "start": 0.25, "end": 0.65, "text": "a", "audio_path": self.source}]
        result = media.render_speech_track(cues, self.directory / "speech.wav", 1.0)
        self.assertAlmostEqual(result["duration"], 1.0, places=5)
        self.assertAlmostEqual(result["segments"][0]["speed"], 1.2)
        self.assertGreater(result["segments"][0]["overflow"], 0)
        with wave.open(result["path"], "rb") as audio:
            samples = np.frombuffer(audio.readframes(audio.getnframes()), "<i2").reshape(-1, 2)
        self.assertFalse(samples[:12000].any())
        self.assertTrue(samples[12000:18000].any())
        self.assertFalse(samples[36000:].any())

    def test_user_speed_and_tail_are_preserved(self):
        cues = [{"start": 0.7, "end": 1.0, "text": "a", "audio_path": self.source, "speed": 0.75}]
        result = media.render_speech_track(cues, self.directory / "speech.wav", 1.0)
        self.assertEqual(result["segments"][0]["speed"], 0.75)
        self.assertGreater(result["duration"], 1.3)
        self.assertGreater(result["segments"][0]["tail_overflow"], 0.3)
        with self.assertRaisesRegex(media.MediaError, "不会裁掉句尾"):
            media.mix_audio(result["path"], self.directory / "mixed.wav", 1.0)

    def test_explicit_one_preserves_complete_generated_pcm(self):
        cues = [{"start": 0.25, "end": 0.55, "text": "a", "audio_path": self.source, "speed": 1}]
        result = media.render_speech_track(cues, self.directory / "natural.wav", 1)
        self.assertEqual(result["segments"][0]["speed"], 1)
        self.assertEqual(result["segments"][0]["audio_duration"], 0.5)
        with wave.open(self.source, "rb") as original, wave.open(result["path"], "rb") as mixed:
            mixed.setpos(12000)
            self.assertEqual(original.readframes(24000), mixed.readframes(24000))

    def test_following_non_48k_speech_has_no_rounding_overflow_or_tail_error(self):
        for rate in (22050, 32000, 44100):
            original = self.directory / f"原配音{rate}.wav"
            with wave.open(str(original), "wb") as audio:
                audio.setparams((1, 2, rate, 0, "NONE", "not compressed"))
                audio.writeframes(bytes(1001 * 2))
            cues = [{"start": 0.000011, "end": 0.02, "text": "a", "audio_path": str(original),
                     "audio": {"duration": 1001 / rate}}]
            plan = media.plan_dubbing_timeline(cues, 0.03)
            mapped = [{**cues[0], **plan["segments"][0]}]
            result = media.render_speech_track(mapped, self.directory / f"配音{rate}.wav", plan["duration"])
            timing = result["segments"][0]
            self.assertEqual((timing["overflow"], timing["overlap"], timing["tail_overflow"]), (0, 0, 0))
            mixed = media.mix_audio(result["path"], self.directory / f"混音{rate}.wav", plan["duration"])
            self.assertLessEqual(abs(media.audio_duration(mixed) - plan["duration"]), 1 / 48000)

    def test_invalid_sentence_speed_is_rejected(self):
        for speed in (0, math.nan, math.inf, 2.1):
            with self.subTest(speed=speed), self.assertRaises(ValueError):
                media.render_speech_track([{"start": 0, "end": 1, "text": "a",
                    "audio_path": self.source, "speed": speed}], self.directory / "invalid.wav", 1)

    def test_background_uses_only_separated_stems_and_gain(self):
        stem = _tone(self.directory / "drums.wav", 0.5, 330)
        vocals = _tone(self.directory / "song_vocals.wav", 0.5, 440)
        with self.assertRaisesRegex(ValueError, "vocals"):
            media.mix_background([stem, vocals], self.directory / "background.wav", 0.5)
        background = media.mix_background([stem], self.directory / "background.wav", 0.8)
        output = media.mix_audio(self.source, self.directory / "mixed.wav", 0.8,
                                 background=background, background_gain=0, speech_gain=0.5)
        with wave.open(output, "rb") as audio:
            self.assertEqual(audio.getnframes(), 38400)
            samples = np.frombuffer(audio.readframes(24000), "<i2")
        self.assertLessEqual(int(np.abs(samples.astype(np.int32)).max()), 3277)

    def test_background_loops_at_original_speed_to_extended_duration(self):
        output = media.mix_audio(self.source, self.directory / "loop.wav", 1.25,
                                 background=self.source, speech_gain=0, loop_background=True)
        with wave.open(output, "rb") as result, wave.open(self.source, "rb") as original:
            block = original.readframes(24000)
            self.assertEqual(result.getnframes(), 60000)
            self.assertEqual(result.readframes(24000), block)
            self.assertEqual(result.readframes(24000), block)
            self.assertEqual(result.readframes(12000), block[:48000])

    def test_concatenation_preserves_audio_and_explicit_separation_chunk_lengths(self):
        second = _tone(self.directory / "第二段.wav", 0.15, 330)
        full = media.concatenate_audio([self.source, second], self.directory / "全部拼接.wav")
        self.assertAlmostEqual(media.audio_duration(full), 0.65, places=5)
        restored = media.concatenate_audio([self.source, second], self.directory / "分离拼接.wav",
                                           durations=[0.2, 0.3])
        self.assertAlmostEqual(media.audio_duration(restored), 0.5, places=5)
        with wave.open(restored, "rb") as audio:
            samples = np.frombuffer(audio.readframes(audio.getnframes()), "<i2").reshape(-1, 2)
        self.assertTrue(samples[9600:16800].any())
        self.assertFalse(samples[16800:].any())
        with self.assertRaisesRegex(ValueError, "一一对应"):
            media.concatenate_audio([self.source, second], self.directory / "invalid.wav", durations=[0.2])

    def test_pre_cancel_leaves_no_partial_output(self):
        cancel = threading.Event()
        cancel.set()
        output = self.directory / "cancelled.wav"
        with self.assertRaises(media.MediaCancelled):
            media.extract_audio(self.source, output, cancel=cancel)
        self.assertFalse(output.exists())

    def test_running_process_is_terminated_on_cancel(self):
        cancel = threading.Event()
        timer = threading.Timer(0.15, cancel.set)
        started = time.monotonic()
        timer.start()
        try:
            with self.assertRaises(media.MediaCancelled):
                media.run_process([sys.executable, "-c", "import time; time.sleep(30)"], cancel)
        finally:
            timer.cancel()
        self.assertLess(time.monotonic() - started, 3)

    def test_video_export_unicode_paths_soft_and_burned_subtitles(self):
        source = self.directory / "原视频.mp4"
        media.run_process([media.find_tool("ffmpeg"), "-v", "error", "-y", "-f", "lavfi",
                           "-i", "color=c=blue:s=160x90:r=25:d=0.8", "-f", "lavfi",
                           "-i", "sine=frequency=440:sample_rate=48000:duration=0.8",
                           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source])
        dubbed = _tone(self.directory / "英语配音.wav", 0.8, 660)
        subtitles = self.directory / "English [1], '.srt"
        media.write_subtitles([{"start": 0.1, "end": 0.7, "text": "Hello!"}], subtitles)
        for burn in (False, True):
            output = media.export_video(source, dubbed, self.directory / f"输出{burn}.mp4",
                                        subtitles=subtitles, burn_subtitles=burn)
            info = media.probe_media(output)
            self.assertEqual(info["video_codec"], "h264")
            self.assertEqual(info["audio_codec"], "aac")
            decoded = media.extract_audio(output, self.directory / f"导出{burn}.wav")
            with wave.open(decoded, "rb") as audio:
                samples = np.frombuffer(audio.readframes(24000), "<i2").reshape(-1, 2)[:, 0]
            peak = np.argmax(np.abs(np.fft.rfft(samples))) * 48000 / len(samples)
            self.assertAlmostEqual(peak, 660, delta=3)

    def test_video_follows_natural_speech_and_mapped_subtitles_without_tail_loss(self):
        source = self.directory / "红绿蓝原片.mp4"
        media.run_process([media.find_tool("ffmpeg"), "-v", "error", "-y", "-f", "lavfi",
                           "-i", "color=c=red:s=160x90:r=25:d=1", "-f", "lavfi",
                           "-i", "color=c=green:s=160x90:r=25:d=1", "-f", "lavfi",
                           "-i", "color=c=blue:s=160x90:r=25:d=1", "-filter_complex",
                           "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]",
                           "-c:v", "libx264", "-pix_fmt", "yuv420p", source])
        cues = [{"id": i, "start": start, "end": start + 0.3, "text": f"Sentence {i}",
                 "audio": {"duration": duration},
                 "audio_path": _tone(self.directory / f"原配音{i}.wav", duration)}
                for i, start, duration in ((1, 0.2, 1.7), (2, 1.2, 0.3), (3, 2.2, 1.2))]
        hashes = [hashlib.sha256(Path(cue["audio_path"]).read_bytes()).hexdigest() for cue in cues]
        plan = media.plan_dubbing_timeline(cues, 3)
        self.assertAlmostEqual(plan["duration"], 4.1)
        mapped = [{**cue, **timing} for cue, timing in zip(cues, plan["segments"])]
        track = media.render_speech_track(mapped, self.directory / "完整译配.wav", plan["duration"])
        subtitles = media.write_subtitles(mapped, self.directory / "顺延字幕.srt")
        for burn in (False, True):
            output = media.export_video(source, track["path"], self.directory / f"跟随{burn}.mp4",
                                        subtitles, burn, timeline=plan)
            self.assertAlmostEqual(media.probe_media(output)["duration"], 4.1, delta=0.06)
            for timestamp, channel in ((1.3, 0), (2.3, 1), (3.9, 2)):
                frame = media.run_process([media.find_tool("ffmpeg"), "-v", "error", "-ss", str(timestamp),
                                           "-i", output, "-frames:v", "1", "-f", "rawvideo",
                                           "-pix_fmt", "rgb24", "pipe:1"])
                colors = np.frombuffer(frame, dtype=np.uint8).reshape(-1, 3).mean(axis=0)
                self.assertEqual(int(np.argmax(colors)), channel)
            if not burn:
                extracted = media.run_process([media.find_tool("ffmpeg"), "-v", "error", "-i", output,
                                               "-map", "0:s:0", "-f", "srt", "pipe:1"])
                exported_cues = media.parse_subtitles(extracted.decode("utf-8"))
                self.assertAlmostEqual(exported_cues[-1]["start"], 2.9, places=3)
                self.assertAlmostEqual(exported_cues[-1]["end"], 4.1, places=3)
            decoded = media.extract_audio(output, self.directory / f"句尾{burn}.wav")
            with wave.open(decoded, "rb") as audio:
                audio.setpos(round(4.0 * audio.getframerate()))
                self.assertTrue(np.frombuffer(audio.readframes(2000), dtype="<i2").any())
        self.assertEqual(hashes, [hashlib.sha256(Path(cue["audio_path"]).read_bytes()).hexdigest() for cue in cues])

    def test_video_retiming_handles_271_windows_and_cancel_cleanup(self):
        source = self.directory / "大量片段.mp4"
        media.run_process([media.find_tool("ffmpeg"), "-v", "error", "-y", "-f", "lavfi", "-i",
                           "color=c=blue:s=160x90:r=100:d=2.8", "-c:v", "libx264", source])
        cues = [{"start": i / 100, "end": (i + 1) / 100, "text": "a", "audio": {"duration": 0.015}}
                for i in range(271)]
        plan = media.plan_dubbing_timeline(cues, 2.8)
        speech = _tone(self.directory / "完整声音.wav", plan["duration"])
        output = media.export_video(source, speech, self.directory / "271句.mp4", timeline=plan)
        self.assertAlmostEqual(media.probe_media(output)["duration"], plan["duration"], delta=0.03)
        cancel = threading.Event()
        cancel.set()
        with self.assertRaises(media.MediaCancelled):
            media.export_video(source, speech, self.directory / "不完整.mp4", timeline=plan, cancel=cancel)
        self.assertFalse((self.directory / "不完整.mp4").exists())
        self.assertFalse(list(self.directory.glob("export_*")))


if __name__ == "__main__":
    unittest.main()
