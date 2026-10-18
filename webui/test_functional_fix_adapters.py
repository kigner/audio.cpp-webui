"""Regressions for failures found by the frozen functional QA; no inference."""
import base64
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import wave

try:
    from webui import webui as app
except ImportError:
    import webui as app


def wav_bytes(rate=48000, channels=2):
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(b"\x10\x00" * (rate // 100) * channels)
    return output.getvalue()


class FunctionalAdapterRepairs(unittest.TestCase):
    def test_current_version_json_precedes_stale_git_tag(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, ".git").mkdir()
            Path(root, "version.json").write_text('{"version":"0.6.0"}', encoding="utf-8")
            with mock.patch.object(app.subprocess, "run") as git:
                self.assertEqual(app._current_app_version(root, root, environ={}), "0.6.0")
            git.assert_not_called()

    def test_nested_portable_keeps_its_own_version(self):
        with tempfile.TemporaryDirectory() as root:
            portable = Path(root, "portable")
            portable.mkdir()
            Path(root, ".git").mkdir()
            Path(root, "version.json").write_text('{"version":"0.6.0"}', encoding="utf-8")
            Path(portable, "version.json").write_text('{"version":"0.5.2"}', encoding="utf-8")
            self.assertEqual(app._current_app_version(str(portable), str(portable), environ={}), "0.5.2")

    def test_voxcpm_clone_is_public_clone_with_native_tts_session(self):
        entry = app.catalog_by_id("voxcpm1-clone")
        self.assertEqual(entry["ui_task"], "clon")
        self.assertEqual(entry["task"], "tts")
        self.assertTrue(app.profile_for(entry)["supports_streaming"])
        self.assertTrue(app.profile_for(entry)["require_voice"])
        config_path = app._write_temp_config(entry)
        try:
            config = json.loads(Path(config_path).read_text(encoding="utf-8"))
            self.assertEqual(config["models"][0]["task"], "tts")
        finally:
            os.unlink(config_path)

    def test_omnivoice_only_normalizes_the_exact_legacy_language_alias(self):
        profile = app.profile_for({"family": "omnivoice"})
        self.assertEqual(app.resolve_language(profile, " 600+ languages "), "Auto")
        for language in ("en", "Chinese", "unsupported-language", "600+ Languages"):
            self.assertEqual(app.resolve_language(profile, language), language)
        self.assertEqual(app.resolve_language({}, "600+ languages"), "600+ languages")

    def test_qwen_auto_and_nemotron_streaming_use_16k_mono_without_touching_source(self):
        with tempfile.TemporaryDirectory() as root:
            original = Path(root, "input.wav")
            original.write_bytes(wav_bytes())
            before = original.read_bytes()
            generated = set()
            for family, stream, options, converted in (
                    ("qwen3_asr", False, {}, True),
                    ("qwen3_asr", False, {"audio_chunk_mode": "auto"}, True),
                    ("qwen3_asr", False, {"audio_chunk_mode": "vad"}, True),
                    ("qwen3_asr", False, {"audio_chunk_mode": "none"}, False),
                    ("qwen3_asr", False, {"audio_chunk_mode": "fixed"}, False),
                    ("qwen3_asr", True, {"audio_chunk_mode": "none"}, True),
                    ("nemotron_asr", False, {}, False),
                    ("nemotron_asr", True, {}, True)):
                with self.subTest(family=family, stream=stream, options=options):
                    output = app._prepare_asr_input(str(original), app.profile_for({"family": family}),
                                                    stream=stream, options=options)
                    if converted:
                        generated.add(output)
                        self.assertNotEqual(output, str(original))
                        with wave.open(output, "rb") as wav:
                            self.assertEqual((wav.getframerate(), wav.getnchannels()), (16000, 1))
                    else:
                        self.assertEqual(output, str(original))
            self.assertEqual(original.read_bytes(), before)
            for output in generated:
                os.unlink(output)

    def test_dot_instruction_rejected_before_loading_for_both_tts_modes(self):
        with mock.patch.object(app, "_ensure_with_options") as load:
            for key in ("instruction", "instruct"):
                args = ("dots-tts-meanflow", "Hello.", "English", None, "(none)", "", 42, 128,
                        {key: "Speak softly."}, "")
                path, message = app.do_tts(*args)
                self.assertIsNone(path)
                self.assertIn("Edit", message)
                with self.assertRaises(app.gr.Error):
                    list(app.do_tts_stream(*args))
        load.assert_not_called()

    def test_dot_edit_keeps_instruction_and_source_audio(self):
        entry = app.catalog_by_id("dots-tts-edit")
        options = app._merged_options(app.profile_for(entry),
                                      {"instruction": "<replace>word</replace>", "source_audio": "source.wav"}, "")
        before = copy.deepcopy(options)
        app._validate_tts_options(entry, options)
        self.assertEqual(options, before)
        self.assertEqual(options["template_name"], "edit")

    def test_seed_cross_task_routes_reject_before_loading(self):
        with mock.patch.object(app, "_ensure_with_options") as load:
            for model, route in (("seed-vc", "v1_svc"), ("seed-vc-svc", "v2_vc")):
                path, message = app.do_vc(model, "source.wav", "ref.wav", "(none)", None, None,
                                          42, {"route": route}, "")
                self.assertIsNone(path)
                self.assertIn(route, message)
        load.assert_not_called()
        for route in ("v2_vc", "v1_whisper_bigvgan_vc", "v1_xlsr_hift_vc"):
            app._validate_vc_options({"family": "seed_vc", "task": "vc"}, {"route": route})
        app._validate_vc_options({"family": "seed_vc", "task": "svc"}, {"route": "v1_svc"})

    def test_vox_legacy_precision_reaches_native_session_config(self):
        entry = {"id": "vox-test", "family": "voxcpm1", "task": "tts", "mode": "offline",
                 "installed": True, "incomplete": False, "label": "Vox", "abs_path": "model.gguf"}
        with mock.patch.object(app, "catalog_by_id", return_value=entry), \
                mock.patch.object(app, "_workbench_runtime_guard", None), \
                mock.patch.object(app, "_workbench_runtime_ready", None), \
                mock.patch.object(app, "_server_proc", None), \
                mock.patch.object(app, "_loaded_session_options", None), \
                mock.patch.object(app, "_loaded_load_options", None), \
                mock.patch.object(app, "_loaded_mode", None), \
                mock.patch.object(app, "server_alive", return_value=False), \
                mock.patch.object(app, "_stop_server"), \
                mock.patch.object(app, "_wait_health", return_value=True), \
                mock.patch.object(app, "_ui_log"), \
                mock.patch.object(app, "_start_server") as start:
            options = {"load_options.voxcpm1.weight_type": "q8_0",
                       "load_options": {"voxcpm1.audiovae_weight_type": "f16"}}
            app._ensure_with_options("vox-test", app.TTS_TASKS, options)
        native = start.call_args.args[0]
        self.assertEqual(native["session_options"], {"voxcpm1.weight_type": "q8_0",
                                                     "voxcpm1.audiovae_weight_type": "f16"})
        self.assertNotIn("load_options", native)
        self.assertEqual(options, {})

    def test_conflicting_vox_precision_is_an_explicit_error(self):
        with self.assertRaises(app.gr.Error):
            app._runtime_precision_options({"family": "voxcpm1"},
                                           {"voxcpm1.weight_type": "f16"},
                                           {"voxcpm1.weight_type": "q8_0"})
        session, loading = app._runtime_precision_options({"family": "other"}, {}, {"weight_type": "f16"})
        self.assertIsNone(session)
        self.assertEqual(loading, {"weight_type": "f16"})

    def test_tone_source_and_reference_are_prepared_at_native_rate(self):
        with tempfile.TemporaryDirectory() as root:
            source, reference = Path(root, "source.wav"), Path(root, "reference.wav")
            source.write_bytes(wav_bytes())
            reference.write_bytes(wav_bytes(16000, 1))
            hashes = [hashlib.sha256(path.read_bytes()).hexdigest() for path in (source, reference)]
            with mock.patch.object(app, "OUTPUT_DIR", root), \
                    mock.patch.object(app, "_ensure_with_options"), \
                    mock.patch.object(app, "_ui_log"), \
                    mock.patch.object(app, "_run_task", return_value={"audio": base64.b64encode(wav_bytes(22050, 1)).decode()}) as run:
                output, message = app.do_vc("tone-color-vc", str(source), str(reference), "(none)",
                                            None, None, 42, {"temperature": 0.3}, "")
            self.assertTrue(output, message)
            request = run.call_args.args[2]
            for key in ("audio", "voice_ref"):
                with wave.open(request[key], "rb") as wav:
                    self.assertEqual(wav.getframerate(), 22050)
            self.assertEqual(hashes, [hashlib.sha256(path.read_bytes()).hexdigest() for path in (source, reference)])
            for key in ("audio", "voice_ref"):
                if request[key] not in (str(source), str(reference)):
                    os.unlink(request[key])


class LegacySourceDiscoveryRepairs(unittest.TestCase):
    def prepare_source(self, root, family, directory):
        model = Path(root, "models", directory)
        source = next(source for source in app.MODEL_SPECS[family]["sources"]
                      if source["format"] == "safetensors")
        paths = []
        for reference in list(source["files"].values()) + list(source["tensors"].values()):
            name, relative = reference.split(":", 1)
            target = (Path(root, "whisper-medium") if name == "whisper" else model) / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"fixture")
            paths.append(target)
        return model, paths

    def test_complete_voxtral_old_source_is_discovered_without_gguf(self):
        with tempfile.TemporaryDirectory() as root:
            model, paths = self.prepare_source(root, "voxtral_realtime", "Voxtral-Mini-4B-Realtime-2602")
            raw = next(entry for entry in app.CATALOG["models"] if entry["id"] == "voxtral-realtime")
            with mock.patch.object(app, "MODEL_SEARCH_ROOTS", (str(Path(root, "models")),)), \
                    mock.patch.object(app, "CATALOG", {"models": [raw]}):
                entry = app.catalog_models()[0]
                self.assertTrue(entry["installed"])
                self.assertFalse(entry["download_installed"])
                self.assertEqual(entry["source_format"], "safetensors")
                self.assertEqual(Path(entry["abs_path"]), model)
                self.assertEqual(entry["session_options"]["voxtral_realtime.weight_type"], "q8_0")
                paths[-1].unlink()
                incomplete = app.catalog_models()[0]
                self.assertFalse(incomplete["installed"])
                self.assertTrue(incomplete["incomplete"])
                self.assertIn("model:model.safetensors", incomplete["missing_files"])

    def test_complete_gguf_remains_preferred_over_legacy_source(self):
        with tempfile.TemporaryDirectory() as root:
            self.prepare_source(root, "voxtral_realtime", "Voxtral-Mini-4B-Realtime-2602")
            raw = next(entry for entry in app.CATALOG["models"] if entry["id"] == "voxtral-realtime")
            package = Path(root, "models", "Voxtral-Mini-4B-Realtime-2602-GGUF")
            package.mkdir()
            for relative in app.REQUIRED_FILES[raw["download_id"]]:
                target = package / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b"GGUF")
            with mock.patch.object(app, "MODEL_SEARCH_ROOTS", (str(Path(root, "models")),)), \
                    mock.patch.object(app, "CATALOG", {"models": [raw]}):
                entry = app.catalog_models()[0]
            self.assertTrue(entry["download_installed"])
            self.assertEqual(Path(entry["abs_path"]), package)
            self.assertNotIn("source_roots", entry)

    def test_vevo_external_whisper_binds_a_temporary_spec_and_requires_all_files(self):
        with tempfile.TemporaryDirectory() as root:
            model, paths = self.prepare_source(root, "vevo2", "Vevo2")
            raw = next(entry for entry in app.CATALOG["models"] if entry["id"] == "vevo2")
            original_spec = copy.deepcopy(app.MODEL_SPECS["vevo2"])
            original_bytes = {path: path.read_bytes() for path in paths}
            with mock.patch.object(app, "MODEL_SEARCH_ROOTS", (str(Path(root, "models")),)), \
                    mock.patch.object(app, "CATALOG", {"models": [raw]}):
                entry = app.catalog_models()[0]
                self.assertTrue(entry["installed"])
                self.assertEqual(Path(entry["abs_path"]), model)
                self.assertEqual(Path(entry["source_roots"]["whisper"]), Path(root, "whisper-medium"))
                config_path = app._write_temp_config(entry)
                config = json.loads(Path(config_path).read_text(encoding="utf-8"))
                native = config["models"][0]
                spec_path = native["model_spec_override"]
                override = json.loads(Path(spec_path).read_text(encoding="utf-8"))
                source = next(source for source in override["sources"] if source["format"] == "safetensors")
                self.assertEqual(Path(source["roots"]["whisper"]), Path(root, "whisper-medium"))
                self.assertEqual(native["session_options"]["vevo2.conv_weight_type"], "f16")
                os.unlink(config_path)
                os.unlink(spec_path)
                self.assertEqual(app.MODEL_SPECS["vevo2"], original_spec)
                self.assertEqual(original_bytes, {path: path.read_bytes() for path in paths})
                Path(root, "whisper-medium", "model.safetensors").unlink()
                incomplete = app.catalog_models()[0]
                self.assertFalse(incomplete["installed"])
                self.assertIn("whisper:model.safetensors", incomplete["missing_files"])


if __name__ == "__main__":
    unittest.main()
