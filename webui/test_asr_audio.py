import os
import tempfile
import unittest
import wave

try:
    from webui import webui as app
except ImportError:
    import webui as app


class AsrAudioPreparationTests(unittest.TestCase):
    def setUp(self):
        fd, self.source = tempfile.mkstemp(prefix="audiocpp_asr_", suffix=".wav")
        os.close(fd)
        with wave.open(self.source, "wb") as wav:
            wav.setnchannels(2)
            wav.setsampwidth(2)
            wav.setframerate(48000)
            wav.writeframes(b"\0\0" * 2 * 480)
        self.addCleanup(self._remove, self.source)

    @staticmethod
    def _remove(path):
        try:
            os.remove(path)
        except OSError:
            pass

    def _assert_mono_16khz(self, path):
        self.addCleanup(self._remove, path)
        self.assertNotEqual(path, self.source)
        with wave.open(path, "rb") as wav:
            self.assertEqual(wav.getnchannels(), 1)
            self.assertEqual(wav.getframerate(), 16000)
            self.assertEqual(wav.getsampwidth(), 2)

    def test_parakeet_streaming_is_converted_to_mono_16khz(self):
        converted = app._prepare_asr_input(
            self.source, {"stream_input_16k_mono": True}, stream=True)
        self._assert_mono_16khz(converted)

    def test_parakeet_offline_keeps_the_existing_input_path(self):
        prepared = app._prepare_asr_input(
            self.source, {"stream_input_16k_mono": True}, stream=False)
        self.assertEqual(prepared, self.source)

    def test_other_streaming_models_keep_the_existing_input_path(self):
        prepared = app._prepare_asr_input(self.source, {}, stream=True)
        self.assertEqual(prepared, self.source)

    def test_sensevoice_offline_is_converted_before_silero_vad(self):
        profile = app.profile_for({"family": "sense_asr"})
        converted = app._prepare_asr_input(self.source, profile, stream=False)
        self._assert_mono_16khz(converted)

    def test_sensevoice_streaming_remains_mono_16khz(self):
        profile = app.profile_for({"family": "sense_asr"})
        converted = app._prepare_asr_input(self.source, profile, stream=True)
        self._assert_mono_16khz(converted)


if __name__ == "__main__":
    unittest.main()
