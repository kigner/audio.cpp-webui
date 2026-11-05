"""Keep runtime recordings private while retaining reviewed example voices."""
import hashlib
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

try:
    from webui import webui as app
except ImportError:
    import webui as app


class VoicePrivacyTests(unittest.TestCase):
    def test_shared_defaults_are_copied_on_first_local_edit_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            voice, examples = root / 'voice', root / 'demo_voices'
            voice.mkdir(); examples.mkdir()
            shared = examples / 'prompt_text'
            shared.write_text('public-demo|Public example transcript.\n', encoding='utf-8')
            original = hashlib.sha256(shared.read_bytes()).hexdigest()
            with mock.patch.object(app, 'PROMPTS_DIR', str(voice)):
                self.assertEqual(app._load_voice_texts(), {'public-demo': 'Public example transcript.'})
                app._write_voice_prompt('private-fixture', 'Private fixture transcript.')
                self.assertEqual(app._load_voice_texts(), {
                    'public-demo': 'Public example transcript.', 'private-fixture': 'Private fixture transcript.'})
            self.assertEqual(hashlib.sha256(shared.read_bytes()).hexdigest(), original)
            self.assertNotIn('private-fixture', shared.read_text(encoding='utf-8'))

    def test_existing_local_prompt_and_empty_prompt_override_public_defaults(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            voice, examples = root / 'voice', root / 'demo_voices'
            voice.mkdir(); examples.mkdir()
            (examples / 'prompt_text').write_text('public-demo|Public text\n', encoding='utf-8')
            prompt = voice / 'prompt_text'
            prompt.write_text('local-fixture|Local text\n', encoding='utf-8')
            with mock.patch.object(app, 'PROMPTS_DIR', str(voice)):
                self.assertEqual(app._load_voice_texts(), {'local-fixture': 'Local text'})
                prompt.write_text('', encoding='utf-8')
                self.assertEqual(app._load_voice_texts(), {})

    def test_deleting_a_shared_prompt_does_not_restore_it_from_defaults(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            voice, examples = root / 'voice', root / 'demo_voices'
            voice.mkdir(); examples.mkdir()
            (examples / 'prompt_text').write_text('public-demo|Public text\n', encoding='utf-8')
            with mock.patch.object(app, 'PROMPTS_DIR', str(voice)):
                app._delete_voice_prompt('public-demo')
                self.assertTrue((voice / 'prompt_text').is_file())
                self.assertEqual(app._load_voice_texts(), {})

    def test_example_initialization_preserves_local_audio_and_does_not_repeat(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            shared, voice = root / 'demo_voices', root / 'voice'
            shared.mkdir(); voice.mkdir()
            (shared / 'example.wav').write_bytes(b'public-example')
            (shared / 'another.wav').write_bytes(b'another-example')
            (voice / 'example.wav').write_bytes(b'local-recording')
            with mock.patch.object(app, 'HERE', str(root)), mock.patch.object(app, 'PROMPTS_DIR', str(voice)):
                app._initialize_builtin_voices()
                self.assertEqual((voice / 'example.wav').read_bytes(), b'local-recording')
                self.assertEqual((voice / 'another.wav').read_bytes(), b'another-example')
                (voice / 'another.wav').unlink()
                app._initialize_builtin_voices()
                self.assertFalse((voice / 'another.wav').exists())

    def test_runtime_voice_directory_is_untracked_and_new_names_are_ignored(self):
        root = Path(__file__).resolve().parents[1]
        if not (root / '.git').exists():
            self.skipTest('Git privacy boundary is checked in the source checkout.')
        tracked = subprocess.check_output(['git', 'ls-files', '-z', '--', 'webui/voice'], cwd=root)
        self.assertEqual(tracked, b'')
        for name in ['prompt_text', 'future-recording.wav', 'arbitrary-personal-name.flac']:
            result = subprocess.run(['git', 'check-ignore', '--no-index', '-q', '--', 'webui/voice/' + name], cwd=root)
            self.assertEqual(result.returncode, 0, name)


if __name__ == '__main__':
    unittest.main()
