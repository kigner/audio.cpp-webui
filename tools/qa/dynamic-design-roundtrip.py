"""Prepare five frozen voice-design text roundtrips from saved PASS outputs only."""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from report_vc_tools_semantics import audio


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("build/functional-qa-20261008"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    base = args.source.resolve()
    runtime_path = base / "current-runtime.json"
    runtime_sha = sha(runtime_path)
    plans = [item for item in read(base / "remaining-replay.json")["cases"] if item["task"] == "design"]
    if len(plans) != 5:
        raise ValueError("This bounded plan requires exactly the existing five design cases.")
    cases, audit = [], []
    for planned in plans:
        row = {"source_case": planned["id"], "surface": "workbench_http", "state": "PENDING_SOURCE_EXECUTION",
               "expected_text": planned.get("inputs", {}).get("text", ""), "expected_text_policy": "ACTUAL_GENERATION_INPUT_TEXT"}
        path = base / "cases" / (planned["id"] + ".json")
        if path.exists():
            record = read(path)
            source = record.get("case", {})
            expected = source.get("inputs", {}).get("text", "").strip()
            row.update(expected_text=expected, original_verdict=record.get("verdict"), source_record=str(path), source_record_sha256=sha(path))
            if record.get("context_sha256") != runtime_sha or record.get("surface") == "cli_raw":
                row["state"] = "EXCLUDED_NONCURRENT_CONTEXT"
            elif record.get("verdict") != "PASS" or record.get("job", {}).get("status") != "done" or record.get("job", {}).get("action") != "generate":
                row["state"] = "EXCLUDED_UNSUCCESSFUL_SOURCE"
            elif not expected:
                row["state"] = "EXPECTED_TEXT_NEEDS_REVIEW"
            else:
                artifacts = [item for item in record.get("artifacts", []) if Path(item.get("path", "")).suffix.lower() == ".wav"]
                if len(artifacts) != 1:
                    row["state"] = "SOURCE_AUDIO_SELECTION_NEEDS_REVIEW"
                else:
                    artifact = artifacts[0]
                    audio_path = Path(artifact["path"])
                    if not audio_path.is_file() or sha(audio_path) != artifact.get("sha256"):
                        row["state"] = "EXCLUDED_AUDIO_HASH_MISMATCH"
                    else:
                        _, _, info = audio(audio_path)
                        if not info["finite"] or not info["frames"] or not info["peak"]:
                            row["state"] = "EXCLUDED_INVALID_AUDIO"
                        else:
                            quality = {"model": source["model"], "case_id": source["id"], "surface": "workbench_http",
                                       "expected_text": expected, "expected_text_policy": row["expected_text_policy"],
                                       "case_record": str(path), "case_record_sha256": sha(path),
                                       "audio_path": str(audio_path), "audio_sha256": artifact["sha256"],
                                       "context_sha256": runtime_sha, "source_request": source["inputs"], "audio_measurements": info}
                            cases.append({"id": "roundtrip-" + source["id"], "task": "asr", "model": "qwen3-asr",
                                          "inputs": {"stream": False, "detailed": False, "dialogue": False, "context": ""},
                                          "uploads": {"audio": str(audio_path)}, "options": {"max_tokens": 128, "audio_chunk_mode": "none", "language": "Auto"},
                                          "expect": "done", "timeout": 900, "coverage": ["voice-design-content-text-screening", "offline-asr"],
                                          "quality_source": quality})
                            row.update(state="PREPARED_NOT_EXECUTED", asr_case=cases[-1]["id"], audio_sha256=artifact["sha256"])
        audit.append(row)
    document = {"generated_at": datetime.now(timezone.utc).isoformat(), "context_path": str(runtime_path), "context_sha256": runtime_sha,
                "scope": "Only five frozen successful API design outputs: Qwen2/MOSS2/FireRed1; no browser duplicates or canonical160 changes.",
                "limits": "ASR agreement screens requested words only; it does not prove the designed voice matches the description, emotion, timbre or acoustic quality.",
                "planned_routes": len(plans), "prepared_cases": len(cases), "source_audit": audit, "cases": cases}
    output = args.output or base / "design-roundtrip-cases.json"
    output.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"manifest": str(output), "planned_routes": len(plans), "prepared_cases": len(cases)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
