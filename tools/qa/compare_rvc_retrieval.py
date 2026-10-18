"""Compare saved RVC retrieval=0/.5 runs without inference or model loading."""
from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import wave

import numpy as np


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as handle:
        while data := handle.read(1024 * 1024):
            result.update(data)
    return result.hexdigest()


def first_wav(record):
    for artifact in record.get("artifacts", []):
        path = artifact.get("path", artifact.get("local_path", ""))
        if Path(path).suffix.lower() == ".wav":
            return Path(path), artifact
    return None, None


def pcm16(path):
    with wave.open(str(path), "rb") as handle:
        geometry = {"sample_rate": handle.getframerate(), "channels": handle.getnchannels(),
                    "sample_width": handle.getsampwidth(), "frames": handle.getnframes()}
        if geometry["sample_width"] != 2:
            raise ValueError("Comparison supports PCM16 only; no implicit conversion.")
        samples = np.frombuffer(handle.readframes(handle.getnframes()), dtype="<i2").astype(np.float64) / 32768
    return geometry, samples


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, default=Path("build/functional-qa-20261008"))
    parser.add_argument("--baseline", default="vc-rvc-chocola-pitch")
    parser.add_argument("--variant", default="vc-rvc-common-retrieval-enabled")
    args = parser.parse_args()
    base = args.evidence.resolve()
    paths = [base / "cases" / f"{case}.json" for case in (args.baseline, args.variant)]
    result = {"generated_at": datetime.now().astimezone().isoformat(), "status": "PENDING",
              "quality_status": "NEED_REVIEW",
              "records": [str(p) for p in paths], "missing": [str(p) for p in paths if not p.exists()],
              "source_consumers": ["src/models/rvc/session.cpp:81-88 parses retrieval_blend and speaker_id",
                  "src/models/rvc/native_pipeline.cpp:658-677 opens matching packaged or explicit index",
                  "src/models/rvc/native_pipeline.cpp:728-736 applies retrieval feature blend"],
              "boundary": "PCM difference is an observation. Attribute it to retrieval only with matched input bytes, seed, runtime, session/load settings and all other parameters. Listening is required for quality."}
    if not result["missing"]:
        left, right = [load(p) for p in paths]
        result["verdicts"] = [r.get("verdict") for r in (left, right)]
        checks = {}
        checks["both_successful_generation"] = all(r.get("verdict") == "PASS" and r.get("job", {}).get("status") == "done"
            and r.get("case", {}).get("expect", "done") == "done" for r in (left, right))
        checks["same_current_runtime"] = bool(left.get("context_sha256")) and left.get("context_sha256") == right.get("context_sha256") == hashlib.sha256((base / "current-runtime.json").read_bytes()).hexdigest()
        requests = [r.get("request", {}) for r in (left, right)]
        checks["same_model_task_action"] = all(requests[0].get(key) == requests[1].get(key) for key in ("model", "task", "action"))
        options = [dict(r.get("options", {})) for r in requests]
        blend = [o.pop("retrieval_blend", None) for o in options]
        result["retrieval_blends"] = blend
        checks["expected_0_vs_half"] = blend == [0, 0.5]
        checks["same_all_other_options"] = options[0] == options[1]
        inputs = [dict(r.get("inputs", {})) for r in requests]
        fixture_evidence = []
        fixture_match = True
        uploaded_match = True
        for key in sorted(set(left.get("case", {}).get("uploads", {})) | set(right.get("case", {}).get("uploads", {}))):
            row = {"key": key, "paths": [], "sha256": [], "transport_ids": [i.pop(key, None) for i in inputs]}
            for record in (left, right):
                source = record.get("case", {}).get("uploads", {}).get(key)
                row["paths"].append(source)
                row["sha256"].append(digest(source) if source and Path(source).is_file() else None)
            row["match"] = bool(row["sha256"][0]) and row["sha256"][0] == row["sha256"][1]
            row["transport_files"] = []
            row["transport_sha256"] = []
            for source, transport_id in zip(row["paths"], row["transport_ids"]):
                uploaded = base.parents[1] / "webui/output/workbench-inputs" / (str(transport_id) + Path(source or "").suffix.lower())
                row["transport_files"].append(str(uploaded))
                row["transport_sha256"].append(digest(uploaded) if uploaded.is_file() else None)
            row["uploaded_bytes_match"] = (bool(row["transport_sha256"][0])
                and row["transport_sha256"][0] == row["transport_sha256"][1] == row["sha256"][0])
            fixture_match &= row["match"]
            uploaded_match &= row["uploaded_bytes_match"]
            fixture_evidence.append(row)
        result["input_fixtures"] = fixture_evidence
        checks["same_input_fixture_bytes_now"] = fixture_match and bool(fixture_evidence)
        checks["same_retained_uploaded_bytes"] = uploaded_match and bool(fixture_evidence)
        checks["same_other_inputs_including_seed"] = inputs[0] == inputs[1]
        configs = [(r["runtime"].get("server", {}).get("configuration")
                    if isinstance(r.get("runtime"), dict) else None) for r in (left, right)]
        # Harness runtime snapshots may be a list. Compare explicitly saved
        # session/load request options regardless, and avoid inventing config proof.
        result["runtime_configuration"] = configs
        checks["same_saved_runtime_configuration"] = bool(configs[0]) and configs[0] == configs[1]
        result["checks"] = checks
        result["execution_failures"] = [{"id": r.get("case", {}).get("id"), "verdict": r.get("verdict"), "error": r.get("error")}
                                        for r in (left, right) if r.get("verdict") != "PASS" or r.get("job", {}).get("status") != "done"]
        result["status"] = "SOURCE_EXECUTION_FAIL" if not checks["both_successful_generation"] else "CONTROLLED_REQUESTS_MATCH" if all(checks.values()) else "NOT_A_CONTROLLED_COMPARISON"
        wavs = [first_wav(r) for r in (left, right)]
        if checks["both_successful_generation"] and all(p and p.exists() for p, _ in wavs):
            try:
                decoded = [pcm16(p) for p, _ in wavs]
                result["wav"] = [{"path": str(p), "sha256": digest(p), "sha_matches_record": digest(p) == a.get("sha256"), "geometry": geometry}
                                 for (p, a), (geometry, _) in zip(wavs, decoded)]
                if not all(w["sha_matches_record"] for w in result["wav"]):
                    result["status"] = "EVIDENCE_HASH_MISMATCH"
                geometry_match = decoded[0][0] == decoded[1][0]
                result["same_wav_geometry"] = geometry_match
                if geometry_match:
                    a, b = [d[1] for d in decoded]
                    delta = b - a
                    result["pcm_comparison"] = {"identical": bool(np.array_equal(a, b)),
                        "changed_samples": int(np.count_nonzero(delta)), "total_samples": int(delta.size),
                        "difference_peak": float(np.max(np.abs(delta))),
                        "difference_rms": float(np.sqrt(np.mean(delta * delta)))}
                else:
                    result["pcm_comparison"] = {"note": "Geometry differs; no aligned-sample RMS calculated."}
            except (wave.Error, ValueError) as error:
                result["pcm_comparison"] = {"note": str(error)}
    (base / "rvc-retrieval-effect-evidence.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = ["# RVC检索比例真实输出只读对照", "", f"快照：{result['generated_at']}，状态：{result['status']}。", "",
             "固定chocola/seed/源音频，其余参数逐键比较；仅允许retrieval_blend 0→0.5。上传UUID不同以fixture字节SHA比较，源文件当前哈希不等于历史上传文件独立哈希。", "",
             "```json", json.dumps(result, ensure_ascii=False, indent=2), "```", "", result["boundary"], ""]
    (base / "rvc-retrieval-effect-evidence.md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps({"status": result["status"], "missing": result["missing"], "checks": result.get("checks")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
