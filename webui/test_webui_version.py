import json
import os
import tempfile
import unittest

try:
    from webui import webui as app
except ImportError:
    import webui as app


class WebuiVersionTests(unittest.TestCase):
    def test_source_ui_version_is_independent_of_runtime_bundle(self):
        with tempfile.TemporaryDirectory() as source, tempfile.TemporaryDirectory() as bundle:
            for root, version in ((source, "0.7.0"), (bundle, "0.6.0")):
                with open(os.path.join(root, "version.json"), "w", encoding="utf-8") as f:
                    json.dump({"version": version}, f)
            self.assertEqual(app._current_app_version(source, bundle, environ={}), "0.7.0")
            self.assertEqual(app._current_app_version(bundle, bundle, environ={}), "0.6.0")

    def test_portable_version_comes_from_version_json(self):
        with tempfile.TemporaryDirectory() as root:
            with open(os.path.join(root, "version.json"), "w", encoding="utf-8") as f:
                json.dump({"version": "0.4.2"}, f)
            self.assertEqual(
                app._current_app_version(root, root, environ={}),
                "0.4.2")

    def test_environment_override_accepts_optional_v_prefix(self):
        self.assertEqual(
            app._current_app_version("missing", "missing",
                                     environ={"AUDIOCPP_VERSION": "v1.2.3"}),
            "1.2.3")

    def test_invalid_version_is_not_displayed(self):
        with tempfile.TemporaryDirectory() as root:
            with open(os.path.join(root, "version.json"), "w", encoding="utf-8") as f:
                json.dump({"version": "latest"}, f)
            self.assertEqual(app._current_app_version(root, root, environ={}), "")


if __name__ == "__main__":
    unittest.main()
