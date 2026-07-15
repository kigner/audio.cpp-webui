from __future__ import annotations

import argparse
import asyncio
import sys
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.asr.streaming import StreamingAsrClient
from app.config import load_config


def read_mono_pcm16(path: Path, target_rate: int) -> bytes:
    with wave.open(str(path), "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            raise ValueError("smoke input must be mono PCM16 WAV")
        source_rate = wav.getframerate()
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2")
    if source_rate == target_rate:
        return samples.tobytes()
    output_size = round(samples.size * target_rate / source_rate)
    positions = np.linspace(0, samples.size - 1, output_size)
    output = np.interp(positions, np.arange(samples.size), samples.astype(np.float32))
    return np.clip(output, -32768, 32767).astype("<i2").tobytes()


async def run(path: Path) -> None:
    config = load_config(Path(__file__).resolve().parents[1] / "config.json")
    pcm = read_mono_pcm16(path, config.asr.sample_rate)
    client = StreamingAsrClient(config.asr, config.vad)
    await client.connect()
    await client.start_session("smoke")

    async def print_events() -> None:
        async for event in client.events():
            if event.type in {"partial", "final", "error"}:
                print(f"{event.type}: {event.text or event.message}")

    consumer = asyncio.create_task(print_events())
    frame_bytes = config.asr.sample_rate * config.asr.frame_ms // 1000 * 2
    for offset in range(0, len(pcm), frame_bytes):
        await client.send_audio(pcm[offset : offset + frame_bytes])
    await client.finish_session()
    await consumer
    await client.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("wav", type=Path)
    args = parser.parse_args()
    asyncio.run(run(args.wav))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
