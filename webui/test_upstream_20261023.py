"""Regression coverage for the October backend and model-contract integration."""
import base64
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import wave

import numpy as np

try:
    from webui import webui as app
except ImportError:
    import webui as app


ROOT = Path(__file__).resolve().parents[1]


class UpstreamIntegrationTests(unittest.TestCase):
    def test_specs_have_no_duplicate_json_keys_or_option_names(self):
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError(f"Duplicate JSON key: {key}")
                result[key] = value
            return result

        for path in sorted((ROOT / "model_specs").glob("*.json")):
            with self.subTest(spec=path.name):
                spec = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique)
                for scope, rows in spec.get("options", {}).items():
                    names = [row["name"] for row in rows]
                    self.assertEqual(len(names), len(set(names)), (path.name, scope))
                    for row in rows:
                        self.assertIsInstance(row.get("required"), bool, (path.name, row["name"]))

    def test_saved_request_aliases_use_current_names_and_explicit_values_win(self):
        cases = [
            ("qwen3-tts-1.7b-custom", {"speaker": "Vivian", "voice_id": "Serena",
                                      "instruction": "calm", "max_new_tokens": 200},
             {"voice_id": "Serena", "instruct": "calm", "max_tokens": 200}),
            ("index-tts2", {"duration_factor": 1.2}, {"duration_scale": 1.2}),
            ("lfm2-audio-tts", {"audio_chunk_seconds": 0.5}, {"audio_chunk_duration_sec": 0.5}),
            ("sopro-tts", {"max_seconds": 12, "ref_seconds": 4},
             {"max_duration_sec": 12, "reference_duration_sec": 4}),
        ]
        for ident, old, expected in cases:
            with self.subTest(model=ident):
                self.assertEqual(app._canonicalize_options(app.catalog_by_id(ident), old), expected)

    def test_saved_runtime_options_move_to_current_scopes(self):
        cases = [
            ("sopro-tts", {"load_options.sopro_tts.matmul_weight_type": "f16"},
             {"session_options": {"sopro_tts.matmul_weight_type": "f16"}}),
            ("yue2", {"load_options": {"yue2.mem_saver": True}},
             {"session_options": {"yue2.mem_saver": "true"}}),
            ("vevo2", {"session_options.vevo2.whisper_graph_context_mb": 128},
             {"session_options": {"vevo2.whisper_graph_arena_mb": "128"}}),
            ("qwen3-asr", {"load_options.use_gpu": True, "max_tokens": 500},
             {"load_options": {"use_gpu": "true"}}),
        ]
        for ident, options, expected in cases:
            with self.subTest(model=ident), mock.patch.object(app, "ensure_model_loaded") as load:
                app._ensure_with_options(ident, (app.catalog_by_id(ident)["task"],), options)
                self.assertEqual(load.call_args.kwargs, expected)
                self.assertEqual(options, {"max_tokens": 500} if ident == "qwen3-asr" else {})

    def test_browser_receives_model_specific_parameter_migrations(self):
        qwen = app._option_aliases(app.catalog_by_id("qwen3-tts-1.7b-custom"))
        self.assertEqual(qwen["speaker"], "voice_id")
        self.assertEqual(qwen["instruction"], "instruct")
        sopro = app._option_aliases(app.catalog_by_id("sopro-tts"))
        self.assertEqual(sopro["load_options.sopro_tts.matmul_weight_type"],
                         "session_options.sopro_tts.matmul_weight_type")
        self.assertNotIn("load_options.use_gpu", sopro)

    def test_native_catalog_keeps_upstream_video_entries_independent_of_local_ui(self):
        native_dir = ROOT / 'webui/native/configs'
        native = json.loads((native_dir / 'models_catalog.json').read_text(encoding='utf-8'))['models']
        params = json.loads((native_dir / 'model_params.json').read_text(encoding='utf-8'))
        self.assertTrue(any(entry['family'] == 'liveavatar' for entry in native))
        self.assertFalse(any(entry['family'] == 'liveavatar' for entry in app.CATALOG['models']))
        self.assertTrue(params)
        for name in ('models_catalog.json', 'model_params.json'):
            self.assertNotEqual((native_dir / name).resolve(), (ROOT / 'webui/configs' / name).resolve())

    def test_new_analysis_tasks_reach_the_generic_audio_route(self):
        for ident, task, preserved in [("ast-audioset", "cls", True),
                                       ("ced-base", "cls", True),
                                       ("micro-wake-word", "wake", False)]:
            with self.subTest(model=ident), \
                    mock.patch.object(app, "ensure_model_loaded") as load, \
                    mock.patch.object(app, "_ensure_wav", return_value="source.wav"), \
                    mock.patch.object(app, "_to_16k_mono_wav", return_value="16k.wav") as convert, \
                    mock.patch.object(app, "_audio_duration_seconds", return_value=1), \
                    mock.patch.object(app, "_ui_log"), \
                    mock.patch.object(app, "_run_task", return_value={}) as run:
                self.assertIn(task, app.ANALYZE_TASKS)
                app.do_analyze(ident, "source.wav", "", "")
                load.assert_called_once()
                self.assertEqual(run.call_args.args[2]["audio"], "source.wav" if preserved else "16k.wav")
                self.assertEqual(convert.call_count, 0 if preserved else 1)

    def test_moss_stereo_stream_preserves_rate_and_frame_count_when_downmixed(self):
        # Large same-sign samples also catch int16 overflow during channel mixing.
        stereo = np.array([[30000, 32000], [-32000, -30000], [2000, -2000]], dtype=np.int16)
        expected = np.array([31000, -31000, 0], dtype=np.int16)
        events = [{"type": "speech.audio.delta", "audio": base64.b64encode(stereo.tobytes()).decode()}]
        response = mock.MagicMock(status_code=200)
        response.__enter__.return_value = response
        with tempfile.TemporaryDirectory() as output, \
                mock.patch.object(app, "OUTPUT_DIR", output), \
                mock.patch.object(app, "ensure_model_loaded"), \
                mock.patch.object(app, "_ui_log"), \
                mock.patch.object(app.requests, "post", return_value=response), \
                mock.patch.object(app, "_iter_sse_events", return_value=iter(events)):
            rows = list(app.do_tts_stream("moss-tts-nano", "Hello.", "", None, "(none)", "", None, None, {}, ""))
            chunks = [row[0] for row in rows if row[0] is not None]
            self.assertEqual(chunks[0][0], 48000)
            np.testing.assert_array_equal(np.concatenate([chunk[1] for chunk in chunks]), expected)
            with wave.open(rows[-1][1], "rb") as wav:
                self.assertEqual((wav.getframerate(), wav.getnchannels(), wav.getnframes()), (48000, 1, 3))
                np.testing.assert_array_equal(np.frombuffer(wav.readframes(3), dtype=np.int16), expected)

    def test_realtime_selects_complete_wav_for_stereo_tts(self):
        entry = {**app.catalog_by_id("moss-tts-nano"), "installed": True}
        with mock.patch.object(app, "catalog_models", return_value=[entry]):
            model, = app.realtime_tts_models()
        self.assertFalse(model["supports_streaming"])
        self.assertEqual(model["realtime_auto_mode"], "offline")

    def test_voxtral_deltas_append_even_when_consecutive_words_repeat(self):
        response = mock.MagicMock(status_code=200)
        response.__enter__.return_value = response
        events = [{"type": "transcript.text.delta", "delta": part} for part in ("你好", "你好", "。")]
        events.append({"type": "transcript.text.done", "timing": {"ttft_ms": 12}})
        with mock.patch.object(app.requests, "post", return_value=response), \
                mock.patch.object(app, "_iter_sse_events", return_value=iter(events)):
            rows = list(app._asr_transcribe_stream("voxtral-realtime", app.catalog_by_id("voxtral-realtime"), "test.wav", {}))
        self.assertEqual([row[0] for row in rows], ["你好", "你好你好", "你好你好。", "你好你好。"])
        self.assertEqual(rows[-1][1:], (True, 12))


if __name__ == "__main__":
    unittest.main()
