"""Durable exports and disposable scenario-session lifecycle regressions."""

from pathlib import Path
import threading
import time
import unittest
from unittest.mock import patch

try:
    from . import test_workbench_scenarios as fixtures
    from . import workbench_scenarios as scenarios
except ImportError:
    import test_workbench_scenarios as fixtures
    import workbench_scenarios as scenarios


class ScenarioResetTests(unittest.TestCase):
    # Reuse only fixture helpers, without inheriting the existing test cases.
    setUp = fixtures.ScenarioTests.setUp
    create = fixtures.ScenarioTests.create
    update = fixtures.ScenarioTests.update
    get = fixtures.ScenarioTests.get
    submit = fixtures.ScenarioTests.submit
    ready_dubbing = fixtures.ScenarioTests.ready_dubbing

    def wait(self, job):
        result = fixtures.ScenarioTests.wait(self, job)
        for _ in range(200):
            if self.work.active_job != job:
                return result
            time.sleep(.001)
        self.fail("completed job did not release its reservation")

    def reset(self, p):
        return self.client.post(scenarios.PREFIX + "/projects/" + p["id"] + "/reset",
                                json={"revision": p["revision"]})

    def exported_subtitles(self):
        p = self.create()
        result = self.wait(self.submit(p, "export_subtitles", format="srt", layer="source"))
        self.assertEqual(result["status"], "done", result)
        p = self.get(p)
        self.assertEqual(len(p["exports"]), 1)
        return p, p["exports"][0]

    def output_files(self):
        root = self.root / "scenario-exports"
        return {p: p.read_bytes() for p in root.rglob("*") if p.is_file()}

    def test_subtitle_export_is_durable_without_download_and_survives_reset_restart(self):
        p, exported = self.exported_subtitles()
        outputs = self.output_files()
        self.assertTrue(outputs)
        self.assertEqual(self.store.exports_root.resolve(), (self.root / "scenario-exports").resolve())
        directory = Path(p["output_directory"])
        self.assertTrue(directory.is_absolute())
        self.assertTrue(directory.is_relative_to(self.store.exports_root.resolve()))
        self.assertIn("示例", directory.name)
        self.assertTrue(exported["url"].startswith(scenarios.PREFIX + "/exports/"))
        self.assertNotIn("output_path", exported)
        self.assertNotIn("path", exported)
        expected = self.client.get(exported["url"]).content
        job_id = p["job_id"]
        self.assertIn(job_id, self.store.jobs)

        response = self.reset(p)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["reset"])
        self.assertEqual(Path(response.json()["output_directory"]), directory)
        self.assertFalse(self.store.directory(p["id"]).exists())
        self.assertNotIn(job_id, self.store.jobs)
        self.assertNotIn(job_id, self.work.jobs)
        self.assertEqual(self.client.get(scenarios.PREFIX + "/projects").json()["projects"], [])
        self.assertEqual(self.output_files(), outputs)
        self.assertEqual(self.client.get(exported["url"]).content, expected)

        app = fixtures.FastAPI()
        scenarios.install_scenario_routes(app, self.work)
        with fixtures.TestClient(app) as restarted:
            response = restarted.get(exported["url"] + "?download=true")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.content, expected)
        repeated = self.reset(p)
        self.assertEqual(repeated.status_code, 200, repeated.text)
        self.assertTrue(repeated.json()["reset"])
        self.assertEqual(self.output_files(), outputs)

    def test_reset_removes_all_cached_steps_but_preserves_original_and_other_tasks(self):
        p = self.create(source_path=str(self.source.resolve()))
        other = self.create()
        original = self.source.read_bytes()
        root = self.store.directory(p["id"])
        for filename in ("original.wav", "vocals-cache.wav", "background-cache.wav", "speech-cache.wav",
                         "mix-cache.wav", "preview-cache.mp4", "recognition.json", "translation.json"):
            (root / filename).write_bytes(b"temporary scene data")
        response = self.reset(p)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(root.exists())
        self.assertEqual(self.source.read_bytes(), original)
        self.assertTrue(self.store.directory(other["id"]).is_dir())
        self.assertEqual([v["id"] for v in self.store.list()["projects"]], [other["id"]])
        self.assertFalse(self.output_files())

    def test_reset_rejects_old_revision_running_jobs_and_realtime_leases(self):
        p = self.create()
        old = p
        p = self.update(p, source_language="en")
        response = self.reset(old)
        self.assertEqual(response.status_code, 409, response.text)
        for state in ("running", "cancelling"):
            with self.subTest(state=state):
                job = {"id": "busy", "project_id": p["id"], "status": state, "cancel": threading.Event()}
                self.store.jobs["busy"] = job
                self.work.jobs["busy"] = job
                self.work.active_job = "busy"
                response = self.reset(p)
                self.assertEqual(response.status_code, 409, response.text)
                self.assertFalse(job["cancel"].is_set())
                self.assertTrue(self.store.directory(p["id"]).is_dir())
        self.store.jobs.clear()
        self.work.jobs.clear()
        self.work.active_job = None
        self.work.leases["call"] = {"model": "pocket-tts"}
        response = self.reset(p)
        self.assertEqual(response.status_code, 409, response.text)
        self.assertTrue(self.store.directory(p["id"]).is_dir())

    def test_video_export_retains_final_video_dubbing_and_selected_subtitles(self):
        p = self.ready_dubbing(durations=(1., 1.), video=True)
        raw = self.store.read(p["id"])
        root = self.store.directory(p["id"])
        mixed = Path(fixtures.audio(root / "mix-ready.wav", 8))
        raw.update(video_follows_audio=False, confirmed_audio=True,
                   preview={"path": mixed.name, "name": "预览.wav"})
        self.store.save(raw)
        p = self.get(p)

        def render(_video, _audio, destination, **_kwargs):
            Path(destination).write_bytes(b"finished dubbed video")
            return str(destination)

        with patch.object(scenarios.media, "export_video", side_effect=render):
            result = self.wait(self.submit(p, "export", options={"subtitle_mode": "translation"}))
        self.assertEqual(result["status"], "done", result)
        p = self.get(p)
        exported = {Path(item["name"]).suffix: item for item in p["exports"]}
        self.assertEqual(set(exported), {".mp4", ".wav", ".srt"})
        self.assertEqual(self.client.get(exported[".wav"]["url"]).content, mixed.read_bytes())
        self.assertIn("English 1", self.client.get(exported[".srt"]["url"]).text)
        self.assertEqual(self.reset(p).status_code, 200)
        for item in exported.values():
            self.assertEqual(self.client.get(item["url"]).status_code, 200)

    def test_legacy_exports_and_orphaned_export_files_are_saved_before_reset(self):
        p = self.create()
        raw = self.store.read(p["id"])
        root = self.store.directory(p["id"])
        saved = {"dubbed-old.mp4": b"old exported video", "export-old.srt": b"old translated subtitles",
                 "subtitles-old.vtt": b"old source subtitles", "legacy.wav": b"named exported audio"}
        for filename, content in saved.items():
            (root / filename).write_bytes(content)
        raw.update(exports=[{"path": "legacy.wav", "name": "成品配音.wav"}],
                   preview={"path": "mix-final.wav", "name": "混音.wav"})
        (root / "mix-final.wav").write_bytes(b"latest final mixed audio")
        self.store.save(raw)
        response = self.reset(p)
        self.assertEqual(response.status_code, 200, response.text)
        archived = list(self.output_files().values())
        for content in saved.values():
            self.assertIn(content, archived)
        self.assertIn(b"latest final mixed audio", archived)
        self.assertFalse(root.exists())

    def test_archive_failure_preserves_task_and_all_cache_for_retry(self):
        p = self.create()
        root = self.store.directory(p["id"])
        (root / "dubbed-old.wav").write_bytes(b"important final")
        before = {path.name: path.read_bytes() for path in root.iterdir()}
        # Simulate a full or unwritable output volume while archiving old output.
        with patch.object(self.store, "publish_exports", side_effect=OSError("output volume full")):
            with fixtures.TestClient(self.app, raise_server_exceptions=False) as client:
                response = client.post(scenarios.PREFIX + "/projects/" + p["id"] + "/reset",
                                       json={"revision": p["revision"]})
        self.assertGreaterEqual(response.status_code, 400, response.text)
        self.assertEqual({path.name: path.read_bytes() for path in root.iterdir()}, before)
        response = self.reset(p)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn(b"important final", self.output_files().values())

    def test_reset_does_not_follow_legacy_external_export_paths(self):
        p = self.create()
        outside = self.root / "external-final.wav"
        outside.write_bytes(b"external user data")
        raw = self.store.read(p["id"])
        raw["exports"] = [{"path": str(outside.resolve()), "name": "external.wav"}]
        self.store.save(raw)
        with fixtures.TestClient(self.app, raise_server_exceptions=False) as client:
            response = client.post(scenarios.PREFIX + "/projects/" + p["id"] + "/reset",
                                   json={"revision": p["revision"]})
        self.assertEqual(outside.read_bytes(), b"external user data")
        self.assertNotIn(b"external user data", self.output_files().values())
        if response.status_code != 200:
            self.assertTrue(self.store.directory(p["id"]).is_dir())

    def test_open_output_uses_only_published_directory(self):
        p, _ = self.exported_subtitles()
        latest = self.store.read(p["id"])["exports"][-1]["output_path"]
        expected = self.store.export_file(latest).parent
        with patch.object(scenarios, "open_output_folder") as opened:
            response = self.client.post(scenarios.PREFIX + "/projects/" + p["id"] + "/open-output",
                                        json={"path": str(self.root.parent)})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["opened"])
        opened.assert_called_once()
        self.assertEqual(Path(opened.call_args.args[0]), expected)
        self.assertEqual(Path(response.json()["output_directory"]), expected)

    def test_open_output_uses_latest_batch_and_reports_windows_failure(self):
        p, _ = self.exported_subtitles()
        result = self.wait(self.submit(p, "export_subtitles", format="vtt", layer="source"))
        self.assertEqual(result["status"], "done", result)
        latest = self.store.read(p["id"])["exports"][-1]["output_path"]
        expected = self.store.export_file(latest).parent
        with patch.object(scenarios, "open_output_folder") as opened:
            self.store.open_output(p["id"])
            opened.assert_called_once_with(expected)
        with patch.object(scenarios, "open_output_folder", side_effect=OSError("shell failed")):
            with self.assertRaisesRegex(ValueError, "无法打开输出目录"):
                self.store.open_output(p["id"])

    @unittest.skipUnless(scenarios.os.name == "nt", "Windows Explorer shell verb")
    def test_windows_folder_opens_with_explorer_verb_and_unicode_path(self):
        directory = self.root / "成品 目录"
        directory.mkdir()
        with patch.object(scenarios.os, "startfile") as opened:
            scenarios.open_output_folder(directory)
            opened.assert_called_once_with(str(directory.resolve()), "explore")

    def test_repeated_open_output_and_reset_do_not_archive_legacy_exports_twice(self):
        p = self.create()
        root = self.store.directory(p["id"])
        (root / "dubbed-old.wav").write_bytes(b"legacy finished dubbing")
        route = scenarios.PREFIX + "/projects/" + p["id"] + "/open-output"
        with patch.object(scenarios, "open_output_folder"), \
             patch.object(self.store, "publish_exports", wraps=self.store.publish_exports) as publish:
            first = self.client.post(route)
            self.assertEqual(first.status_code, 200, first.text)
            saved = self.output_files()
            self.assertEqual(list(saved.values()), [b"legacy finished dubbing"])
            second = self.client.post(route)
            self.assertEqual(second.status_code, 200, second.text)
            self.assertEqual(second.json()["output_directory"], first.json()["output_directory"])
            self.assertEqual(self.output_files(), saved)
            response = self.reset(self.get(p))
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(self.output_files(), saved)
            publish.assert_called_once()

    def test_export_batches_share_material_language_directory_without_overwriting(self):
        p = self.update(self.create(), scenario="dubbing", target_language="en", video_follows_audio=False)
        result = self.wait(self.submit(p, "export_subtitles", format="srt", layer="source"))
        self.assertEqual(result["status"], "done", result)
        p = self.get(p)
        first_directory = Path(p["output_directory"])
        first_files = self.output_files()
        first_export = p["exports"][0]
        result = self.wait(self.submit(p, "export_subtitles", format="vtt", layer="source"))
        self.assertEqual(result["status"], "done", result)
        p = self.get(p)
        self.assertEqual(Path(p["output_directory"]), first_directory)
        self.assertIn("_en_", first_directory.name)
        batches = [child for child in first_directory.iterdir() if child.is_dir()]
        self.assertEqual(len(batches), 2)
        outputs = self.output_files()
        self.assertEqual(len(outputs), 2)
        for path, content in first_files.items():
            self.assertEqual(outputs[path], content)
        self.assertEqual({path.suffix for path in first_directory.rglob("*") if path.is_file()}, {".srt", ".vtt"})
        self.assertEqual(self.client.get(first_export["url"]).status_code, 200)

    def test_cache_permission_error_keeps_session_record_and_allows_reset_retry(self):
        p, exported = self.exported_subtitles()
        root = self.store.directory(p["id"])
        locked = root / "preview-locked.mp4"
        locked.write_bytes(b"playing preview")
        original_unlink = Path.unlink

        def unlink_unless_locked(path, *args, **kwargs):
            if path == locked:
                raise PermissionError("preview is open in a player")
            return original_unlink(path, *args, **kwargs)

        with patch.object(Path, "unlink", new=unlink_unless_locked):
            response = self.reset(p)
        self.assertEqual(response.status_code, 409, response.text)
        self.assertTrue((root / "project.json").is_file())
        self.assertEqual(self.get(p)["revision"], p["revision"])
        self.assertTrue(locked.is_file())
        self.assertEqual(self.client.get(exported["url"]).status_code, 200)
        response = self.reset(p)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(root.exists())
        self.assertEqual(self.client.get(exported["url"]).status_code, 200)

    def test_export_download_rejects_path_traversal(self):
        p, _ = self.exported_subtitles()
        outside = self.root / "outside.wav"
        outside.write_bytes(b"not a scenario export")
        for tail in ("%2E%2E%2Foutside.wav", "%2E%2E%5Coutside.wav", "%2F" + str(outside).replace("\\", "%5C")):
            with self.subTest(tail=tail):
                response = self.client.get(scenarios.PREFIX + "/exports/" + tail)
                self.assertEqual(response.status_code, 404, response.text)

    def upload_replacement(self, p, *, video=False):
        info = dict(duration=8, has_video=video, has_audio=True, sample_rate=16000, channels=1)
        with patch.object(scenarios.media, "probe_media", return_value=info):
            return self.client.post(scenarios.PREFIX + "/projects",
                files={"file": ("English tutorial.mp4" if video else "replacement.wav", self.source.read_bytes(),
                                 "video/mp4" if video else "audio/wav")},
                data={"scenario": "dubbing", "replace_id": p["id"], "replace_revision": p["revision"]})

    def test_valid_video_replacement_cleans_previous_steps_and_accepts_english_source(self):
        p, exported = self.exported_subtitles()
        response = self.upload_replacement(p, video=True)
        self.assertEqual(response.status_code, 200, response.text)
        new = response.json()
        self.assertNotEqual(new["id"], p["id"])
        self.assertTrue(new["media"]["has_video"])
        self.assertTrue(new["media"]["name"].endswith(".mp4"))
        self.assertEqual(new["segments"], [])
        self.assertEqual(new["exports"], [])
        self.assertIsNone(new["preview"])
        self.assertFalse(new["confirmed_source"])
        self.assertFalse(new["confirmed_translation"])
        self.assertFalse(new["confirmed_audio"])
        self.assertFalse(self.store.directory(p["id"]).exists())
        self.assertEqual(self.client.get(exported["url"]).status_code, 200)
        new = self.update(new, source_language="en", target_language="zh")
        self.assertEqual((new["source_language"], new["target_language"]), ("en", "zh"))

    def test_invalid_replacement_preserves_original_task_and_leaves_no_new_draft(self):
        p = self.create()
        with patch.object(scenarios.media, "probe_media", side_effect=ValueError("invalid video")):
            response = self.client.post(scenarios.PREFIX + "/projects",
                files={"file": ("broken.mp4", b"bad video", "video/mp4")},
                data={"scenario": "dubbing", "replace_id": p["id"], "replace_revision": p["revision"]})
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual([v["id"] for v in self.store.list()["projects"]], [p["id"]])
        self.assertEqual([d.name for d in self.store.root.iterdir() if d.is_dir()], [p["id"]])

    def test_replacement_cleanup_failure_rolls_back_new_draft(self):
        p = self.create()
        root = self.store.directory(p["id"])
        (root / "dubbed-old.wav").write_bytes(b"final output")
        with patch.object(self.store, "publish_exports", side_effect=OSError("archive unavailable")):
            with fixtures.TestClient(self.app, raise_server_exceptions=False) as client:
                original_client = self.client
                self.client = client
                try:
                    response = self.upload_replacement(p)
                finally:
                    self.client = original_client
        self.assertGreaterEqual(response.status_code, 400, response.text)
        self.assertEqual([d.name for d in self.store.root.iterdir() if d.is_dir()], [p["id"]])
        self.assertEqual((root / "dubbed-old.wav").read_bytes(), b"final output")


if __name__ == "__main__":
    unittest.main()
