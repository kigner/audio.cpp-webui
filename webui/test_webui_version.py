import json
import os
import tempfile
import unittest

try:
    from webui import webui as app
except ImportError:
    import webui as app


class WebuiVersionTests(unittest.TestCase):
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
