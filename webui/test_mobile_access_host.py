"""Synthetic audio host for test_mobile_access_browser.cjs; no model or API calls."""
import json
import math
from pathlib import Path
import queue
import struct
import wave
import tempfile
import numpy as np
from types import SimpleNamespace
from unittest.mock import Mock, patch

from mobile_access import MobileAccess
from realtime_pipeline import AudioChunk, ResponseDone
from workbench_server import Workbench


class SyntheticPipeline:
    def __init__(self, **_):
        self.generation = 0
        self.events = queue.Queue()
        self.sent = False

    def start(self):
        pass

    def configure(self, _):
        pass

    def stop(self):
        pass

    def cancel(self):
        self.generation += 1

    def feed_audio(self, _):
        if not self.sent:
            self.sent = True
            pcm = struct.pack("<16000h", *(int(math.sin(i * 440 * 2 * math.pi / 16000) * 4000) for i in range(16000)))
            # The shipped demo checks actual voice-driven mouth movement, without
            # calling a model or using personal recordings. Keep a tone fallback.
            voice = Path(__file__).parent / "voice" / "demo_02_woman.wav"
            if voice.is_file():
                with wave.open(str(voice)) as wav:
                    if wav.getsampwidth() == 2 and wav.getframerate() == 48000:
                        samples = np.frombuffer(wav.readframes(6 * 48000), dtype="<i2")
                        mono = samples.reshape(-1, wav.getnchannels()).mean(axis=1)
                        pcm = mono[::3].astype("<i2").tobytes()
            self.events.put(AudioChunk(pcm=pcm, generation=self.generation))
            self.events.put(ResponseDone(generation=self.generation))

    def drain_events(self):
        result = []
        while not self.events.empty():
            result.append(self.events.get_nowait())
        return result


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="aixora-mobile-browser-") as directory:
        work = Workbench(SimpleNamespace(OUTPUT_DIR=directory,
                         realtime_tts_models=lambda: [{"id":"fixture-tts", "supports_streaming":False}],
                         load_realtime_tts_model=Mock()))
        manager = MobileAccess(work, directory=Path(directory)/"mobile", port=0)
        manager.save_config({"config":{"tts_model":"fixture-tts", "asr_model":"fixture-asr",
                                        "llm_model":"fixture-llm", "tts_playback_mode":"offline"},
                             "character":{"name":"小暖"}, "noise_gate":-66})
        with patch("realtime_server.RealtimePipeline", SyntheticPipeline), patch("mobile_access.lan_addresses", return_value=["127.0.0.1"]):
            try:
                manager.set_enabled(True)
                import qrcode
                qr = Path(directory)/"qr.png"
                state = manager.status()
                qrcode.make(state["urls"][0]).save(qr)
                print(json.dumps({"status":state, "qr":str(qr)}), flush=True)
                input()  # Parent sends a newline, allowing orderly TLS/lease cleanup.
            finally:
                manager.stop()
