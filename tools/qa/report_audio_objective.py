"""Read-only paired-fixture DSP observations; no inference or listening verdict.

Uses existing Python312 scipy/numpy. Alignment and gain fitting are reported
explicitly; they may hide delay/gain defects and never grant acoustic acceptance.
"""
import argparse
import hashlib
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import scipy
from scipy.signal import correlate, correlation_lags, resample_poly

from report_vc_tools_semantics import audio


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def quantized(values):
    return (np.clip(values, -1, 1) * 32767).astype("<i2").astype(np.float64) / 32768


def at_rate(values, source_rate, target_rate):
    if source_rate == target_rate:
        return values.copy()
    common = math.gcd(source_rate, target_rate)
    return resample_poly(values, target_rate // common, source_rate // common,
                         window=("kaiser", 5.), padtype="constant")


def paired(reference, output, lag):
    # scipy correlate(output, reference): positive lag means delayed output.
    x_start, y_start = max(0, -lag), max(0, lag)
    count = min(len(reference) - x_start, len(output) - y_start)
    if count <= 0:
        raise ValueError("No aligned overlap")
    return reference[x_start:x_start + count], output[y_start:y_start + count], x_start, y_start


def alignment(reference, output, rate, max_seconds=.25):
    x, y = reference - reference.mean(), output - output.mean()
    values = correlate(y, x, mode="full", method="fft")
    lags = correlation_lags(len(y), len(x), mode="full")
    keep = np.abs(lags) <= round(max_seconds * rate)
    # Full cross-correlation gives a deterministic candidate. Score normalized
    # on its exact overlap afterward; low correlation remains NEED_REVIEW.
    lag = int(lags[keep][np.argmax(np.abs(values[keep]))])
    a, b, start, ystart = paired(x, y, lag)
    corr = float(np.dot(a, b) / max(np.linalg.norm(a) * np.linalg.norm(b), 1e-30))
    return {"lag_output_minus_reference_samples": lag, "lag_seconds": lag / rate,
            "max_search_seconds": max_seconds, "signed_overlap_correlation": corr,
            "overlap_frames": len(a), "reference_start": start, "output_start": ystart,
            "reference_overlap_fraction": len(a) / len(reference),
            "confidence": "NEED_REVIEW" if abs(corr) < .2 else "CORRELATION_SUPPORTED_NOT_HUMAN_VERIFIED"}


def ratio_db(signal, error):
    numerator, denominator = float(np.dot(signal, signal)), float(np.dot(error, error))
    if numerator <= 0:
        return None
    return float(10 * np.log10(numerator / max(denominator, 1e-30)))


def metrics(reference, output):
    x, y = reference - reference.mean(), output - output.mean()
    gain = float(np.dot(x, y) / max(np.dot(x, x), 1e-30))
    target, residual = gain * x, y - gain * x
    return {"raw_amplitude_snr_db": ratio_db(x, y - x),
            "scale_invariant_sdr_db": ratio_db(target, residual),
            "least_squares_output_gain": gain,
            "output_to_reference_rms_ratio": float(np.linalg.norm(y) / max(np.linalg.norm(x), 1e-30)),
            "residual_rms_after_gain_fit": float(np.sqrt(np.mean(residual ** 2)))}


def fixture_components(manifest):
    fixtures = manifest["fixtures"]
    paths = {key: Path(fixtures[key]["path"]) for key in ("english", "chinese", "noisy_english", "piano8", "music_speech_mix")}
    decoded = {key: audio(path) for key, path in paths.items()}
    if any(rate != 48000 for _, rate, _ in decoded.values()):
        raise ValueError("Fixture reconstruction requires the existing exact48k inputs")
    en = decoded["english"][0].mean(axis=1)
    zh = decoded["chinese"][0].mean(axis=1)
    rng = np.random.default_rng(20261008)
    noise = rng.normal(0, .025, len(en))
    noisy_before_clip = en + noise
    piano = np.zeros(8 * 48000)
    notes = [60, 64, 67, 72, 69, 67, 64, 62, 60, 64, 67, 72, 71, 67, 64, 60]
    for i, note in enumerate(notes):
        t = np.arange(min(48000, len(piano) - i * 24000)) / 48000
        hz = 440 * 2 ** ((note - 69) / 12)
        attack = np.minimum(1, t / .006)
        signal = sum(np.sin(2 * np.pi * hz * h * t) * np.exp(-t * (3 + h)) / h ** 1.6 for h in range(1, 7))
        piano[i * 24000:i * 24000 + len(t)] += .22 * attack * signal
    piano *= .65 / max(.65, np.max(np.abs(piano)))
    speech = np.zeros_like(piano)
    speech[:len(en)] = en
    speech[5 * 48000:] = zh[:3 * 48000]
    mix_before_clip = .55 * piano + .65 * speech
    expected = {"noisy_english": quantized(noisy_before_clip), "piano8": quantized(piano),
                "music_speech_mix": quantized(mix_before_clip)}
    evidence = {"source": "prepare-remaining-cases.py:16-57", "checks": [],
                "noisy_prequantization_clipped_sample_fraction": float(np.mean(np.abs(noisy_before_clip) > 1)),
                "mix_prequantization_clipped_sample_fraction": float(np.mean(np.abs(mix_before_clip) > 1)),
                "noise_generator": "numpy default_rng20261008 normal mean0 sigma0.025; exact PCM quantization reconstructed",
                "mix_components": "0.55*unquantized deterministic piano +0.65*speech (English from0; Chinese first3s from5s)",
                "fixtures": {key: {**meta, "manifest_hash_matches": meta["sha256"] == fixtures[key]["sha256"]}
                             for key, (_, _, meta) in decoded.items()}}
    for key, samples in expected.items():
        actual = decoded[key][0][:, 0]
        matches = len(actual) == len(samples) and np.array_equal(actual, samples)
        evidence["checks"].append({"fixture": key, "exact_pcm_reconstruction": matches,
                                   "max_abs_error": float(np.max(np.abs(actual - samples))) if len(actual) == len(samples) else None})
    if not all(item["exact_pcm_reconstruction"] for item in evidence["checks"]) or not all(item["manifest_hash_matches"] for item in evidence["fixtures"].values()):
        raise ValueError("Known fixture provenance/reconstruction mismatch; do not compute quality metrics")
    evidence["mix_quantization_residual_rms"] = float(np.sqrt(np.mean((decoded["music_speech_mix"][0][:, 0] - mix_before_clip) ** 2)))
    return {"clean": en, "noisy": decoded["noisy_english"][0][:, 0], "mix": decoded["music_speech_mix"][0][:, 0],
            "speech_component": .65 * speech, "music_component": .55 * piano}, evidence


def component_projection(output, speech, music):
    matrix = np.column_stack([speech - speech.mean(), music - music.mean()])
    y = output - output.mean()
    gains, _, _, _ = np.linalg.lstsq(matrix, y, rcond=None)
    fit = matrix @ gains
    return {"speech_coefficient": float(gains[0]), "piano_coefficient": float(gains[1]),
            "unexplained_residual_rms": float(np.sqrt(np.mean((y - fit) ** 2))),
            "boundary": "Two-component linear projection only; not BSS Eval, formal SIR or isolation-quality PASS."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, default=Path("build/functional-qa-20261008"))
    args = parser.parse_args()
    base = args.evidence.resolve()
    manifest = read(base / "remaining-replay.json")
    components, fixture_evidence = fixture_components(manifest)
    context_sha = sha(base / "current-runtime.json")
    rows = []
    for planned in manifest["cases"]:
        if planned["task"] not in {"processing", "separation"}:
            continue
        row = {"id": planned["id"], "task": planned["task"], "model": planned["model"], "status": "PENDING",
               "quality_acceptance": "NOT_GRANTED"}
        rows.append(row)
        path = base / "cases" / (planned["id"] + ".json")
        if not path.exists():
            continue
        record = read(path)
        row.update(record=str(path), record_sha256=sha(path), original_verdict=record.get("verdict"))
        if record.get("verdict") != "PASS" or record.get("context_sha256") != context_sha or record.get("job", {}).get("status") != "done":
            row.update(status="SOURCE_NOT_CURRENT_SUCCESS", error=record.get("error"))
            continue
        source = record.get("case", {})
        fixture_key = "noisy_english" if planned["task"] == "processing" else "music_speech_mix"
        expected_input = fixture_evidence["fixtures"][fixture_key]
        actual_input = Path(source.get("uploads", {}).get("audio", ""))
        if source.get("task") != planned["task"] or source.get("model") != planned["model"] or not actual_input.is_file() or sha(actual_input) != expected_input["sha256"]:
            row.update(status="SOURCE_FIXTURE_MISMATCH", reason="Saved request must use the exact hash-verified paired fixture")
            continue
        row["input_fixture"] = {"path": str(actual_input), "sha256": sha(actual_input), "fixture": fixture_key}
        outputs = []
        for item in record.get("artifacts", []):
            output_path = Path(item["path"])
            if output_path.suffix.lower() != ".wav":
                continue
            if sha(output_path) != item["sha256"]:
                raise ValueError("Artifact hash changed: " + str(output_path))
            data, rate, info = audio(output_path)
            outputs.append((data.mean(axis=1), rate, info))
        row["artifacts"] = [info for _, _, info in outputs]
        row["status"] = "NEED_REVIEW"
        if planned["task"] == "processing":
            if len(outputs) != 1:
                row["reason"] = "Expected one output for paired processing observation"
                continue
            output, rate, _ = outputs[0]
            clean, noisy = [at_rate(components[key], 48000, rate) for key in ("clean", "noisy")]
            aligned = alignment(clean, output, rate)
            x, y, xstart, _ = paired(clean, output, aligned["lag_output_minus_reference_samples"])
            baseline = noisy[xstart:xstart + len(x)]
            before, after = metrics(x, baseline), metrics(x, y)
            difference = None if after["scale_invariant_sdr_db"] is None or before["scale_invariant_sdr_db"] is None else after["scale_invariant_sdr_db"] - before["scale_invariant_sdr_db"]
            row.update(alignment=aligned, input_baseline=before, output_observation=after,
                       scale_invariant_sdr_change_db=difference,
                       task_interpretation="SUPER_RESOLUTION_ON_NOISY_SPEECH_NOT_A_DENOISE_RANKING" if "flashsr" in planned["id"] else "PAIRED_ADDITIVE_NOISE_PROCESSING_OBSERVATION")
        else:
            if not outputs or len({(rate, len(samples)) for samples, rate, _ in outputs}) != 1:
                row["reason"] = "Stem rate/length mismatch; cannot directly sum a common waveform"
                continue
            rate = outputs[0][1]
            mix, speech, music = [at_rate(components[key], 48000, rate)
                                  for key in ("mix", "speech_component", "music_component")]
            total = np.sum([item[0] for item in outputs], axis=0)
            aligned = alignment(mix, total, rate)
            x, y, xstart, ystart = paired(mix, total, aligned["lag_output_minus_reference_samples"])
            row.update(alignment=aligned, stem_sum_reconstruction=metrics(x, y), stems=[])
            speech, music = speech[xstart:xstart + len(x)], music[xstart:xstart + len(x)]
            vocal, accompaniment = np.zeros(len(x)), np.zeros(len(x))
            has_vocal = False
            for samples, _, info in outputs:
                stem = samples[ystart:ystart + len(x)]
                name = Path(info["path"]).stem.casefold()
                is_vocal = "vocal" in name
                if is_vocal:
                    vocal += stem
                    has_vocal = True
                else:
                    accompaniment += stem
                row["stems"].append({"name": name, "energy_fraction_of_input": float(np.dot(stem, stem) / max(np.dot(x, x), 1e-30)),
                                     "component_projection": component_projection(stem, speech, music)})
            if has_vocal:
                row.update(vocals_against_known_speech=metrics(speech, vocal),
                           remaining_stems_against_known_piano=metrics(music, accompaniment))
            else:
                row["reason"] = "No named vocal stem, so no target-isolation metric assigned"
    source = base / "prepare-remaining-cases.py"
    report = {"generated_at": datetime.now(timezone.utc).isoformat(), "current_context_sha256": context_sha,
              "scope": "Read-only nine frozen processing/separation API outputs; no inference or new test cases.",
              "environment": {"python": sys.executable, "numpy": np.__version__, "scipy": scipy.__version__},
              "fixture_source": {"path": str(source), "sha256": sha(source)}, "fixture_ground_truth": fixture_evidence,
              "method": "At each output's own sample rate: scipy anti-aliased resample_poly for paired clean/noisy/component references; integer cross-correlation lag search +/-250ms; same overlap for before/after; DC removal; raw-amplitude SNR and least-squares scale-invariant SDR. Separation uses one shared sum-alignment, no independent per-stem timing fitting.",
              "limits": "All results remain NEED_REVIEW. Alignment/gain fitting can hide latency and level defects; no time-warp fitting or perceptual metric. Native builtin preprocessing uses linear resampling, unlike the anti-aliased reference, so metrics include that entire pipeline difference. Native rate/bandwidth differ; do not rank scores across16k/48k or treat noise residual as naturalness. Synthetic piano/speech mixture is not recorded-song isolation acceptance. FlashSR is super-resolution, not a denoising comparator.",
              "cases": rows}
    output = base / "audio-objective-observations.json"
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    lines = ["# 现有音频产物客观观察", "", report["limits"], "", "已重建噪声、钢琴和混音，三个fixture的PCM逐样本完全一致；未运行推理。", "",
             "| case | 状态 | 输出率 | 对齐lag ms | 输入SI-SDR dB | 输出SI-SDR dB | 差值dB |", "|---|---|---:|---:|---:|---:|---:|"]
    for row in rows:
        if row["task"] == "processing" and row.get("output_observation"):
            display = lambda value: "NA" if value is None else f"{value:.3f}"
            lines.append(f"| {row['id']} | NEED_REVIEW | {row['artifacts'][0]['sample_rate']} | {row['alignment']['lag_seconds']*1000:.3f} | {display(row['input_baseline']['scale_invariant_sdr_db'])} | {display(row['output_observation']['scale_invariant_sdr_db'])} | {display(row['scale_invariant_sdr_change_db'])} |")
        else:
            lines.append(f"| {row['id']} | {row['status']} | - | - | - | - | - |")
    lines += ["", "分离各stem的能量、两分量投影、整组重构和人声/钢琴配对数值见JSON；不是听感PASS。", ""]
    output.with_suffix(".md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps({"report": str(output), "cases": len(rows), "fixture_pcm_reconstruction": fixture_evidence["checks"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
