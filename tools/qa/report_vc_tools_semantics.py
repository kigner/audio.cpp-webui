"""Read saved VC/tool outputs against measured fixtures; never runs inference.

PASS checks below establish a specific numerical/content contract. They do not
establish naturalness, speaker similarity, denoising quality or score accuracy.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import struct

import numpy as np

from validate_workbench_results import abc_info


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"),
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def audio(path):
    raw = path.read_bytes()
    if len(raw) < 12 or raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise ValueError("not a RIFF WAVE")
    limit = struct.unpack_from("<I", raw, 4)[0] + 8
    if limit > len(raw):
        raise ValueError("truncated RIFF")
    position, fmt, pcm = 12, None, None
    while position + 8 <= limit:
        kind, length = raw[position:position + 4], struct.unpack_from("<I", raw, position + 4)[0]
        position += 8
        if position + length > limit:
            raise ValueError("truncated WAV chunk")
        if kind == b"fmt ":
            fmt = raw[position:position + length]
        elif kind == b"data":
            pcm = raw[position:position + length]
        position += length + (length & 1)
    if fmt is None or len(fmt) < 16 or not pcm:
        raise ValueError("missing/empty WAV format or audio data")
    code, channels, rate, byte_rate, align, bits = struct.unpack_from("<HHIIHH", fmt)
    if code == 0xFFFE and len(fmt) >= 40:
        code = struct.unpack_from("<H", fmt, 24)[0]
    if channels <= 0 or rate <= 0 or align != channels * (bits // 8) or byte_rate != rate * align or len(pcm) % align:
        raise ValueError("invalid WAV sample geometry")
    if code == 3 and bits in (32, 64):
        values = np.frombuffer(pcm, dtype="<f4" if bits == 32 else "<f8").astype(np.float64)
    elif code == 1 and bits in (8, 16, 24, 32):
        if bits == 8:
            values = (np.frombuffer(pcm, dtype="u1").astype(np.float64) - 128) / 128
        elif bits == 24:
            values = np.array([int.from_bytes(pcm[i:i + 3], "little", signed=True)
                               for i in range(0, len(pcm), 3)], dtype=np.float64) / 8388608
        else:
            values = np.frombuffer(pcm, dtype="<i2" if bits == 16 else "<i4").astype(np.float64) / (2 ** (bits - 1))
    else:
        raise ValueError(f"unsupported WAV encoding {code}/{bits}")
    data = values.reshape(-1, channels)
    return data, rate, {"path": str(path), "sha256": sha(path), "sample_rate": rate,
                        "channels": data.shape[1], "frames": len(data),
                        "duration_seconds": len(data) / rate,
                        "finite": bool(np.isfinite(data).all()),
                        "peak": float(np.max(np.abs(data))) if data.size else 0,
                        "rms": float(np.sqrt(np.mean(data ** 2))) if data.size else 0,
                        "near_full_scale_sample_ratio": float(np.mean(np.abs(data) >= .999)) if data.size else 0}


def mono_at(data, rate, target):
    mono = data.mean(axis=1)
    if rate != target:
        mono = np.interp(np.arange(round(len(mono) * target / rate)) * rate / target,
                         np.arange(len(mono)), mono)
    return mono


def normalized(text):
    return "".join(x.casefold() for x in str(text) if x.isalnum())


def union_seconds(intervals, region=None):
    merged = []
    for start, end in sorted(intervals):
        if region:
            start, end = max(start, region[0]), min(end, region[1])
        if end <= start:
            continue
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(end, merged[-1][1])
        else:
            merged.append([start, end])
    return sum(b - a for a, b in merged)


def check(row, key, status, detail=None):
    row["checks"].append({"name": key, "status": status, "detail": detail})


def require(row, key, condition, detail=None):
    check(row, key, "PASS" if condition else "FAIL", detail)


def safetensors_info(path):
    raw = path.read_bytes()
    if len(raw) < 8:
        raise ValueError("truncated safetensors")
    size = struct.unpack("<Q", raw[:8])[0]
    if size > len(raw) - 8:
        raise ValueError("invalid safetensors header length")
    header = json.loads(raw[8:8 + size])
    result = {"metadata": header.get("__metadata__", {}), "tensors": []}
    arrays = []
    for name, item in header.items():
        if name == "__metadata__":
            continue
        dtype = {"F32": "<f4", "F16": "<f2", "F64": "<f8"}.get(item["dtype"])
        if dtype is None:
            raise ValueError("unsupported probability dtype: " + item["dtype"])
        start, end = item["data_offsets"]
        if not 0 <= start <= end <= len(raw) - 8 - size:
            raise ValueError("invalid safetensors offsets")
        values = np.frombuffer(raw, dtype=dtype, count=(end - start) // np.dtype(dtype).itemsize,
                               offset=8 + size + start)
        shape = item["shape"]
        if int(np.prod(shape)) != values.size or values.nbytes != end - start:
            raise ValueError("probability tensor shape/size mismatch")
        values = values.reshape(shape)
        arrays.append((name, values))
        result["tensors"].append({"name": name, "dtype": item["dtype"], "shape": shape,
                                  "finite": bool(np.isfinite(values).all()),
                                  "min": float(values.min()) if values.size else None,
                                  "max": float(values.max()) if values.size else None})
    return result, arrays


def fixture_inventory(base, manifest):
    fixtures = {}
    for name, expected in manifest["fixtures"].items():
        path = Path(expected["path"])
        _, _, measured = audio(path)
        measured["manifest_sha256_matches"] = measured["sha256"] == expected["sha256"]
        measured["origin"] = expected.get("origin")
        fixtures[name] = measured
    english = fixtures["english"]["duration_seconds"]
    chinese = fixtures["chinese"]["duration_seconds"]
    # Exact splice construction in prepare-remaining-cases.py:50. This is not
    # a human-labeled speech-onset/end annotation for the embedded demos.
    regions = {"english_demo": [.5, .5 + english],
               "inserted_silence": [.5 + english, 1.5 + english],
               "chinese_demo": [1.5 + english, 1.5 + english + chinese]}
    data, rate, _ = audio(Path(fixtures["dialogue"]["path"]))
    silence = data[round(regions["inserted_silence"][0] * rate):
                   round(regions["inserted_silence"][1] * rate)]
    regions["inserted_silence_peak"] = float(np.max(np.abs(silence)))
    regions["expected_duration_seconds"] = 2 + english + chinese
    return fixtures, regions


def inspect_spans(row, data, kind, duration, regions):
    # do_analyze converts all these speech tools to 16k mono before /tasks/run.
    # Independent of the uploaded WAV's original rate and response declaration.
    rate = 16000
    row["independent_coordinate_rate"] = rate
    row["coordinate_evidence"] = "webui/webui.py:5272-5276; Qwen aligner session.cpp:239-244; speech tools native16k"
    declared = data.get("sample_rate")
    if declared is not None:
        require(row, "declared_rate_matches_prepared_audio", declared == rate, declared)
    spans = data.get(kind, [])
    check(row, kind + ".nonempty", "PASS" if spans else "NEED_REVIEW",
          len(spans) if spans else "No detections; empty output is not sufficient semantic evidence.")
    intervals, speakers, previous = [], {}, -1
    for index, span in enumerate(spans):
        start, end = span.get("start_sample"), span.get("end_sample")
        valid = (isinstance(start, int) and not isinstance(start, bool) and
                 isinstance(end, int) and not isinstance(end, bool) and
                 0 <= start <= end)
        require(row, f"{kind}[{index}].valid_sample_interval", valid,
                {"start_sample": start, "end_sample": end, "rate": rate})
        require(row, f"{kind}[{index}].start_order", isinstance(start, int) and start >= previous)
        if not valid:
            continue
        within_audio = end <= round(duration * rate) + 1
        bound_detail = {"start_sample": start, "end_sample": end, "rate": rate,
                        "input_duration": duration}
        clamp = row["case"].get("options", {}).get("clamp_timestamps_to_audio")
        if kind == "words" and not within_audio and clamp is False:
            check(row, f"words[{index}].known_input_coordinate_bounds", "NEED_REVIEW",
                  {**bound_detail, "reason": "Explicit clamp=false permits untrimmed model predictions; not a clipping-contract failure."})
        else:
            require(row, f"{kind}[{index}].known_input_coordinate_bounds", within_audio, bound_detail)
        previous = start
        interval = (start / rate, end / rate)
        intervals.append(interval)
        confidence = span.get("confidence")
        if confidence is not None:
            require(row, f"{kind}[{index}].confidence_range", isinstance(confidence, (int, float))
                    and not isinstance(confidence, bool) and np.isfinite(confidence) and 0 <= confidence <= 1,
                    confidence)
        if kind == "speaker_turns":
            speaker = span.get("speaker_id")
            require(row, f"speaker_turns[{index}].speaker_id", isinstance(speaker, str) and bool(speaker))
            speakers.setdefault(str(speaker), []).append(interval)
    row["intervals_seconds"] = intervals
    if kind in {"segments", "speaker_turns"}:
        coverage = {}
        for name in ("english_demo", "inserted_silence", "chinese_demo"):
            region = regions[name]
            coverage[name] = {"covered_seconds": union_seconds(intervals, region),
                              "duration_seconds": region[1] - region[0]}
        row["known_splice_region_overlap"] = coverage
        if coverage["inserted_silence"]["covered_seconds"] > .4:
            check(row, "speech_in_known_inserted_silence", "NEED_REVIEW", coverage["inserted_silence"])
        if any(coverage[name]["covered_seconds"] == 0 for name in ("english_demo", "chinese_demo")):
            check(row, "both_demo_blocks_detected", "NEED_REVIEW", coverage)
        if kind == "speaker_turns":
            dominance = {name: {speaker: union_seconds(value, regions[name])
                               for speaker, value in speakers.items()}
                         for name in ("english_demo", "chinese_demo")}
            row["speaker_overlap_by_known_demo"] = dominance
            top = [max(overlap, key=overlap.get) if overlap and max(overlap.values()) > 0 else None
                   for overlap in dominance.values()]
            if None in top or top[0] == top[1]:
                check(row, "different_demo_speaker_dominance", "NEED_REVIEW", top)
            else:
                check(row, "different_demo_speaker_dominance", "PASS", top)
            check(row, "diarization_boundary_accuracy", "NEED_REVIEW",
                  "Two source identities/splice boundaries known; fine speech boundaries and extra/overlap labels require listening.")
    if kind == "words":
        wanted = normalized(row["case"].get("inputs", {}).get("transcript", ""))
        actual = normalized("".join(str(word.get("word", "")) for word in spans))
        require(row, "aligned_words_cover_requested_transcript", bool(wanted) and actual == wanted,
                {"expected": wanted, "actual": actual})
        check(row, "individual_word_boundary_accuracy", "NEED_REVIEW",
              "Known16k coordinates and text equality do not provide manually labeled per-word timing ground truth.")


def inspect_score(row, documents, paths, duration):
    abc = [path for path in paths if path.suffix.casefold() == ".abc"]
    require(row, "score.abc_artifact", bool(abc))
    for path in abc:
        info = abc_info(path.read_text(encoding="utf-8-sig"))
        row.setdefault("abc", []).append({"path": str(path), **info})
        require(row, "score.has_sounding_abc_notes", info["note_count"] > 0, info)
        if info["unknown_constructs"]:
            check(row, "score.abc_subset_supported", "NEED_REVIEW", info["unknown_constructs"])
    event_docs = [(path, data) for path, data in documents if isinstance(data, dict) and "events" in data]
    require(row, "score.events_json", bool(event_docs))
    expected = [60, 64, 67, 72, 69, 67, 64, 62, 60, 64, 67, 72, 71, 67, 64, 60]
    for path, data in event_docs:
        notes, previous = [], -1.
        for index, event in enumerate(data["events"]):
            time = event.get("time")
            valid = isinstance(time, (int, float)) and np.isfinite(time) and 0 <= time <= duration + .001
            require(row, f"score.event[{index}].time_in_source_seconds", valid, time)
            require(row, f"score.event[{index}].time_order", valid and time >= previous)
            if valid:
                previous = time
            for note in event.get("notes", []):
                pitch, end = note.get("pitch"), note.get("end_time")
                require(row, f"score.event[{index}].midi_pitch", isinstance(pitch, int) and 0 <= pitch <= 127, pitch)
                if end is not None:
                    positive = valid and isinstance(end, (int, float)) and np.isfinite(end) and time < end
                    require(row, f"score.event[{index}].positive_note_duration", positive, {"start": time, "end": end})
                    if positive and end > duration + .001:
                        check(row, f"score.event[{index}].note_extends_source", "NEED_REVIEW",
                              {"start": time, "end": end, "input_duration": duration,
                               "reason": "Notation quantization/sustain may extend a terminal note; no automatic acoustic failure inferred."})
                notes.append({"time": time, **note})
        require(row, "score.has_sounding_event_notes", bool(notes))
        row["score_notes"] = notes
        row["known_synthetic_notes"] = [{"onset": i * .5, "pitch": pitch} for i, pitch in enumerate(expected)]
        # Counts/pitches compared to the deterministic construction are useful
        # review clues; polyphonic decoder tracks are not assumed monophonic.
        matches = []
        for i, pitch in enumerate(expected):
            candidates = [note for note in notes if isinstance(note.get("time"), (int, float))
                          and abs(note["time"] - i * .5) <= .25 and note.get("pitch") == pitch]
            matches.append(bool(candidates))
        row["synthetic_note_near_onset_matches"] = {"matched": sum(matches), "expected": len(expected),
                                                    "tolerance_seconds": .25, "individual": matches}
        check(row, "score.transcription_accuracy", "NEED_REVIEW",
              "ABC/events are parsed and compared with16known synthetic attacks; this is not recorded-song or listening acceptance.")


def inspect_audio_outputs(row, paths, source):
    outputs = []
    for path in paths:
        if path.suffix.casefold() != ".wav":
            continue
        data, rate, info = audio(path)
        outputs.append((data, rate, info))
        require(row, "audio.valid_nonempty_finite", len(data) > 0 and info["finite"], info)
        if info["near_full_scale_sample_ratio"] > .01:
            check(row, "audio.near_full_scale_review", "NEED_REVIEW", info["near_full_scale_sample_ratio"])
    row["audio"] = [info for _, _, info in outputs]
    if not outputs:
        require(row, "audio.present", False)
        return
    task = row["case"]["task"]
    require(row, "audio.group_has_energy", any(info["peak"] > 0 for _, _, info in outputs))
    if source:
        x, sr, meta = audio(Path(source))
        row["source_audio"] = meta
        row["output_to_source_duration_ratios"] = [info["duration_seconds"] / meta["duration_seconds"]
                                                   for _, _, info in outputs]
        if task == "processing":
            # Report zero-lag gain-normalized residual; suppress a quality
            # judgement when filters add delay or resampling changes alignment.
            clean_path = Path(row["fixtures"]["english"]["path"])
            clean, clean_sr, _ = audio(clean_path)
            measurements = []
            for data, rate, info in outputs:
                reference = mono_at(clean, clean_sr, rate)
                noisy = mono_at(x, sr, rate)
                y = data.mean(axis=1)
                n = min(len(reference), len(y), len(noisy))
                ref, out, inp = reference[:n], y[:n], noisy[:n]
                gain = float(np.dot(out, ref) / max(float(np.dot(ref, ref)), 1e-30))
                error = out - gain * ref
                measurements.append({"path": info["path"], "comparison_frames": n,
                                     "gain_against_clean_zero_lag": gain,
                                     "output_residual_rms_zero_lag": float(np.sqrt(np.mean(error ** 2))),
                                     "input_residual_rms_zero_lag": float(np.sqrt(np.mean((inp - ref) ** 2))),
                                     "limitation": "Linear interpolation for different rates, no delay compensation; magnitude alone cannot establish denoising improvement."})
            row["processing_reference_comparison"] = measurements
        if task == "separation":
            stems = [mono_at(data, rate, sr) for data, rate, _ in outputs]
            n = min([len(x), *(len(stem) for stem in stems)])
            summed = np.sum([stem[:n] for stem in stems], axis=0)
            source_mono = x[:n].mean(axis=1)
            row["stem_sum_comparison"] = {"frames": n, "sample_rate": sr,
                                           "sum_minus_input_rms": float(np.sqrt(np.mean((summed - source_mono) ** 2))),
                                           "input_rms": float(np.sqrt(np.mean(source_mono ** 2))),
                                           "limitation": "Stem sum consistency does not establish semantic source isolation. Individual silent stems allowed."}
    check(row, "audio.effect_listening", "NEED_REVIEW",
          "Duration/finite/energy checks cannot establish content, target speaker identity, singing pitch preservation or denoising/separation quality.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, default=Path("build/functional-qa-20261008"))
    args = parser.parse_args()
    base = args.evidence.resolve()
    manifest = read(base / "remaining-replay.json")
    runtime_sha = sha(base / "current-runtime.json")
    fixtures, regions = fixture_inventory(base, manifest)
    selected = {case["id"]: case for case in manifest["cases"]
                if case.get("task") in {"vc", "processing", "separation", "analysis"}}
    supplement = base / "supplemental-common-cases.json"
    if supplement.exists():
        value = read(supplement)
        for case in value.get("cases", []) if isinstance(value, dict) else value:
            if case.get("task") == "vc":
                selected[case["id"]] = case
    native_control = base / "tone-color-native22050-cases.json"
    if native_control.exists():
        for case in read(native_control)["cases"]:
            if case.get("id") == "vc-tone-color-native22050-control":
                selected[case["id"]] = case
    # Include native CLI VC records when they land, preserving their separate
    # surface and provenance; never turn CLI success into restored UI discovery.
    for path in (base / "cases").glob("*.json"):
        try:
            record = read(path)
        except (OSError, ValueError):
            continue
        case = record.get("case", {})
        if record.get("surface") == "cli_raw" and case.get("task") in {"vc", "svc", "s2s"}:
            selected[case["id"]] = case
    rows = []
    for ident, case in selected.items():
        path = base / "cases" / (ident + ".json")
        row = {"id": ident, "model": case["model"], "task": case["task"], "case": case,
               "record_path": str(path), "checks": [], "fixtures": fixtures,
               "status": "PENDING", "quality_status": "NOT_ASSESSED"}
        rows.append(row)
        if not path.exists():
            continue
        try:
            record = read(path)
            row.update(original_verdict=record.get("verdict"), record_sha256=sha(path),
                       surface=record.get("surface", "workbench_http"))
            context = record.get("context", {})
            raw = row["surface"] == "cli_raw"
            record_context = context.get("workbench_context_sha256") if raw else record.get("context_sha256")
            if record_context != runtime_sha:
                row.update(status="NEED_REVIEW", reason="Record context does not match current-runtime evidence")
                continue
            if raw:
                cli = Path(context.get("cli_exe", ""))
                require(row, "cli.current_binary_hash", cli.is_file() and sha(cli) == context.get("cli_sha256"))
                row["surface_boundary"] = "Native CLI only; no restored catalog/UI functionality inferred."
            if record.get("verdict") != "PASS":
                row.update(status=record.get("verdict", "NEED_REVIEW"), reason=record.get("error") or record.get("skip_reason"))
                continue
            paths, documents = [], []
            for artifact in record.get("artifacts", []):
                artifact_path = Path(artifact["path"])
                paths.append(artifact_path)
                require(row, "artifact.original_hash", artifact_path.is_file() and
                        bool(artifact.get("sha256")) and sha(artifact_path) == artifact["sha256"], str(artifact_path))
                if artifact_path.suffix.casefold() == ".json":
                    documents.append((artifact_path, read(artifact_path)))
            source = case.get("uploads", {}).get("audio")
            if not source:
                source = (case.get("inputs", {}).get("audio") or case.get("request", {}).get("audio")
                          or case.get("request", {}).get("source_audio"))
            if case["task"] in {"vc", "svc", "s2s", "processing", "separation"}:
                inspect_audio_outputs(row, paths, source)
            else:
                duration = audio(Path(source))[2]["duration_seconds"] if source else None
                require(row, "analysis.source_duration_known", duration is not None)
                if duration is None:
                    raise ValueError("Analysis source audio missing")
                semantic_payloads = 0
                for _, data in documents:
                    if not isinstance(data, dict):
                        continue
                    for kind in ("segments", "speaker_turns", "words"):
                        if kind in data:
                            semantic_payloads += 1
                            inspect_spans(row, data, kind, duration, regions)
                    custom = data.get("custom_schema_output", {})
                    if custom.get("schema") == "smart_turn.v1":
                        semantic_payloads += 1
                        decision = custom.get("data", {})
                        probability = decision.get("probability")
                        threshold = float(case.get("options", {}).get("threshold", .5))
                        valid = (isinstance(probability, (int, float)) and not isinstance(probability, bool)
                                 and np.isfinite(probability) and 0 <= probability <= 1)
                        require(row, "turn.probability_range", valid, probability)
                        require(row, "turn.strict_threshold_decision", valid and isinstance(decision.get("complete"), bool)
                                and decision["complete"] == (probability > threshold),
                                {"probability": probability, "threshold": threshold, "complete": decision.get("complete")})
                        check(row, "turn.semantic_completion", "NEED_REVIEW",
                              "A single completed sentence without interrupted-turn negative control cannot establish turn-classification accuracy.")
                for artifact_path in paths:
                    if artifact_path.suffix.casefold() != ".safetensors":
                        continue
                    info, tensors = safetensors_info(artifact_path)
                    row["frame_probabilities"] = info
                    metadata = info["metadata"]
                    require(row, "diar.probability_native_geometry", metadata.get("sample_rate") == "16000"
                            and metadata.get("frame_hop_samples") == "160", metadata)
                    for name, values in tensors:
                        require(row, "diar.probability_tensor_range", values.size > 0 and
                                np.isfinite(values).all() and values.min() >= 0 and values.max() <= 1, name)
                        require(row, "diar.probability_timeline_duration", values.ndim == 2 and
                                abs(values.shape[0] * .01 - duration) <= .011,
                                {"shape": list(values.shape), "duration": duration})
                if case["model"] == "sheetsage2":
                    semantic_payloads += 1
                    inspect_score(row, documents, paths, duration)
                if not semantic_payloads:
                    check(row, "analysis.semantic_payload_available", "NEED_REVIEW",
                          "No saved speech segments, speaker turns, words, completion schema or score to assess.")
            statuses = [item["status"] for item in row["checks"]]
            row["status"] = "FAIL" if "FAIL" in statuses else "NEED_REVIEW" if "NEED_REVIEW" in statuses else "PASS"
            row["quality_status"] = "NEED_REVIEW"
        except (OSError, ValueError, KeyError, TypeError, struct.error) as error:
            row.update(status="FAIL" if any(item["status"] == "FAIL" for item in row["checks"])
                       else "NEED_REVIEW", reason="Evidence decode/review unavailable: " + str(error))
        row.pop("fixtures", None)
    for row in rows:
        row.pop("fixtures", None)
        failures = [item for item in row["checks"] if item["status"] == "FAIL"]
        row["independent_failures"] = failures if row.get("original_verdict") == "PASS" else []
        if row["status"] == "PENDING":
            row["category"] = "PENDING_REAL_EXECUTION"
        elif row.get("original_verdict") in {"FAIL", "BLOCKED"}:
            row["category"] = "ORIGINAL_EXECUTION_" + row["original_verdict"]
        elif failures:
            row["category"] = ("EVIDENCE_HASH_CONTRACT" if any(
                item["name"] in {"artifact.original_hash", "cli.current_binary_hash"} for item in failures)
                               else "OUTPUT_CONTENT_CONTRACT")
        elif row.get("reason", "").startswith("Record context"):
            row["category"] = "EVIDENCE_PROVENANCE_REVIEW"
        elif row.get("reason", "").startswith("Evidence decode"):
            row["category"] = "EVIDENCE_DECODE_REVIEW"
        elif row["status"] == "NEED_REVIEW":
            row["category"] = "QUALITY_OR_SEMANTIC_REVIEW"
        else:
            row["category"] = "NUMERICAL_CONTENT_CONTRACT_VERIFIED"
    report = {"generated_at": datetime.now(timezone.utc).isoformat(), "snapshot_is_live": True,
              "current_context_sha256": runtime_sha, "fixtures": fixtures, "dialogue_splice_regions": regions,
              "fixture_source": "build/functional-qa-20261008/prepare-remaining-cases.py:35-64",
              "counts": dict(Counter(row["status"] for row in rows)), "cases": rows,
              "independent_fail_case_count": sum(bool(row["independent_failures"]) for row in rows),
              "boundary": "Read-only saved-output semantic screening. PENDING is unexecuted; numerical/structure PASS is not quality acceptance. Original records remain unchanged. VAD confidence may be default0 rather than an exported posterior."}
    root = Path(__file__).resolve().parents[2]
    source_ranges = {"webui/webui.py": [(5272, 5276)],
                     "src/models/qwen3_forced_aligner/session.cpp": [(239, 249)],
                     "src/models/nemotron_3_diar/session.cpp": [(18, 20), (64, 94), (337, 376)],
                     "src/models/smart_turn/session.cpp": [(42, 57)],
                     "src/models/pulsevad/session.cpp": [(61, 80)],
                     "src/models/sheetsage/processing.cpp": [(881, 940)],
                     "src/models/sheetsage/session.cpp": [(1072, 1101)],
                     "build/functional-qa-20261008/prepare-remaining-cases.py": [(35, 64)]}
    report["source_contracts"] = []
    for relative, ranges in source_ranges.items():
        source = root / relative
        lines = source.read_text(encoding="utf-8").splitlines()
        report["source_contracts"].append({"path": str(source), "sha256": sha(source),
                                           "excerpts": [{"start_line": start, "end_line": end,
                                                         "text": "\n".join(lines[start - 1:end])}
                                                        for start, end in ranges]})
    (base / "vc-tools-semantic-audit.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = ["# VC / 音频工具语义审查", "", f"动态快照：{report['generated_at']}；当前状态 {report['counts']}。", "",
             "只读落盘产物，不运行推理。数值/结构通过不等于音色、降噪、分离、说话人或乐谱质量验收；原用例 verdict 保留。", "",
             f"对话拼接：英文 {regions['english_demo']} 秒，准确插入静音 {regions['inserted_silence']} 秒，中文 {regions['chinese_demo']} 秒。原示例内部逐词与发声边界尚无人手标注。", "",
             "| 用例 | 原结构结果 | 语义审查 | 需审项目 |", "|---|---|---|---|"]
    for row in rows:
        issues = [item["name"] + ": " + str(item["detail"]) for item in row["checks"] if item["status"] != "PASS"]
        detail = "; ".join(issues) or row.get("reason", "尚未执行")
        detail = detail.replace("|", "\\|").replace("\n", " ")
        lines.append(f"| {row['id']} | {row.get('original_verdict', 'PENDING')} | {row['status']} | {detail} |")
    lines += ["", "完整区间、概率、音频统计、哈希和乐谱事件见同名JSON；本报告不增加或修改冻结清单。", ""]
    (base / "vc-tools-semantic-audit.md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps({"counts": report["counts"], "path": str(base / "vc-tools-semantic-audit.json")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
