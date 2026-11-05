"""Keep local recordings out of the frozen public voice directory."""
import json
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
    def test_local_prompt_edits_preserve_other_entries(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            voice = root / 'voice'
            voice.mkdir()
            prompt = voice / 'prompt_text'
            prompt.write_text('public-demo|Public example transcript.\n', encoding='utf-8')
            with mock.patch.object(app, 'PROMPTS_DIR', str(voice)):
                self.assertEqual(app._load_voice_texts(), {'public-demo': 'Public example transcript.'})
                app._write_voice_prompt('private-fixture', 'Private fixture transcript.')
                self.assertEqual(app._load_voice_texts(), {
                    'public-demo': 'Public example transcript.', 'private-fixture': 'Private fixture transcript.'})

    def test_local_prompt_and_empty_prompt_are_read_directly(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            voice = root / 'voice'
            voice.mkdir()
            prompt = voice / 'prompt_text'
            prompt.write_text('local-fixture|Local text\n', encoding='utf-8')
            with mock.patch.object(app, 'PROMPTS_DIR', str(voice)):
                self.assertEqual(app._load_voice_texts(), {'local-fixture': 'Local text'})
                prompt.write_text('', encoding='utf-8')
                self.assertEqual(app._load_voice_texts(), {})

    def test_deleting_a_prompt_does_not_restore_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            voice = root / 'voice'
            voice.mkdir()
            (voice / 'prompt_text').write_text('public-demo|Public text\n', encoding='utf-8')
            with mock.patch.object(app, 'PROMPTS_DIR', str(voice)):
                app._delete_voice_prompt('public-demo')
                self.assertTrue((voice / 'prompt_text').is_file())
                self.assertEqual(app._load_voice_texts(), {})

    def test_only_original_examples_are_tracked_and_new_names_are_ignored(self):
        root = Path(__file__).resolve().parents[1]
        if not (root / '.git').exists():
            self.skipTest('Git privacy boundary is checked in the source checkout.')
        tracked = subprocess.check_output(['git', 'ls-files', '-z', '--', 'webui/voice'], cwd=root).decode('utf-8')
        baseline = json.loads((root / 'scripts/demo_voices_baseline.json').read_text(encoding='utf-8'))
        self.assertEqual(set(tracked.rstrip('\0').split('\0')),
                         {'webui/voice/' + entry['name'] for entry in baseline['files']})
        for name in ['prompt_text', 'future-recording.wav', 'arbitrary-personal-name.flac']:
            result = subprocess.run(['git', 'check-ignore', '--no-index', '-q', '--', 'webui/voice/' + name], cwd=root)
            self.assertEqual(result.returncode, 0, name)


if __name__ == '__main__':
    unittest.main()
