"""Prepare text roundtrips from saved successful current VC results; no inference.

Each successful lexical source case is retained, rather than choosing one per
model. Synthetic humming has no expected words and is explicitly inapplicable.
"""
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
    runtime, runtime_sha = read(runtime_path), sha(runtime_path)
    cli_path = Path(runtime["bundle_root"]) / "build/windows-cuda-release/bin/audiocpp_cli.exe"
    cli_sha = sha(cli_path)
    remaining = read(base / "remaining-replay.json")
    plans = [(case, "workbench_http") for case in remaining["cases"] if case["task"] == "vc"]
    # raw-plan-vc.json is overwritten by each --only native replay. The final
    # raw manifest keeps all three frozen logical routes and must drive scope.
    raw_plans = [case for case in read(base / "final-raw-cases.json")["cases"]
                 if case.get("task") in {"vc", "svc", "s2s"}]
    if len(raw_plans) != 3:
        raise ValueError("The bounded VC quality plan requires three frozen native routes.")
    plans += [(case, "cli_raw") for case in raw_plans]
    fixture_by_sha = {item["sha256"]: item for item in remaining["fixtures"].values()}
    explicit_control = base / "tone-color-native22050-cases.json"
    provenance = None
    if explicit_control.exists():
        controls = read(explicit_control)
        control_cases = controls["cases"]
        if len(control_cases) != 1 or control_cases[0].get("id") != "vc-tone-color-native22050-control":
            raise ValueError("Only the explicitly authorized native-rate ToneColor control may extend this plan.")
        provenance_path = Path(controls["fixture_provenance"])
        prepared = read(provenance_path)["inputs"]["audio"]
        original_fixture = fixture_by_sha.get(prepared["original"]["sha256"])
        if not original_fixture or not original_fixture.get("transcript"):
            raise ValueError("Native-rate source lacks known original fixture transcript provenance.")
        for item in (prepared["original"], prepared["prepared"]):
            if sha(Path(item["path"])) != item["sha256"]:
                raise ValueError("Native-rate source fixture provenance hash changed.")
        fixture_by_sha[prepared["prepared"]["sha256"]] = {**original_fixture, "resampled_from_known_fixture": True}
        provenance = {"path": str(provenance_path), "sha256": sha(provenance_path),
                      "original": prepared["original"], "prepared": prepared["prepared"]}
        plans.append((control_cases[0], "workbench_http"))
    cases, audit = [], []
    for planned, surface in plans:
        row = {"source_case": planned["id"], "surface": surface, "state": "PENDING_SOURCE_EXECUTION"}
        record_path = base / "cases" / (planned["id"] + ".json")
        record = read(record_path) if record_path.exists() else None
        source = record.get("case", {}) if record else planned
        request = source.get("request", {})
        source_audio = request.get("source_audio") if surface == "cli_raw" else source.get("uploads", {}).get("audio")
        row["source_audio_path"] = source_audio
        expected, policy = "", "UNESTABLISHED"
        if source_audio and Path(source_audio).is_file():
            source_sha = sha(Path(source_audio))
            fixture = fixture_by_sha.get(source_sha, {})
            row.update(source_audio_sha256=source_sha, fixture_origin=fixture.get("origin"))
            if source.get("task") == "s2s" and request.get("task_route") == "editing":
                expected, policy = request.get("target_text", "").strip(), "EDITING_TARGET_TEXT"
            elif fixture.get("transcript"):
                expected = fixture["transcript"]
                policy = "HASH_MATCHED_RESAMPLE_PROVENANCE_TRANSCRIPT" if fixture.get("resampled_from_known_fixture") else "HASH_MATCHED_SOURCE_FIXTURE_TRANSCRIPT"
            elif source_sha == remaining["fixtures"]["humming"]["sha256"]:
                policy = "SYNTHETIC_HUMMING_WITHOUT_LEXICAL_CONTENT"
        row.update(expected_text=expected, expected_text_policy=policy)
        if record:
            row.update(original_verdict=record.get("verdict"), source_record=str(record_path),
                       source_record_sha256=sha(record_path))
            context = record.get("context", {})
            current = (context.get("workbench_context_sha256") == runtime_sha
                       and context.get("cli_sha256") == cli_sha and context.get("head") == runtime.get("head")) if surface == "cli_raw" else record.get("context_sha256") == runtime_sha
            if not current:
                row["state"] = "EXCLUDED_NONCURRENT_CONTEXT"
            elif record.get("verdict") != "PASS":
                row["state"] = "EXCLUDED_UNSUCCESSFUL_SOURCE"
            elif surface == "cli_raw" and record.get("exit_code") != 0:
                row["state"] = "EXCLUDED_SOURCE_WITHOUT_SUCCESSFUL_EXIT"
            elif surface == "workbench_http" and record.get("job", {}).get("status") != "done":
                row["state"] = "EXCLUDED_SOURCE_WITHOUT_DONE_JOB"
            elif not expected:
                row["state"] = "NOT_APPLICABLE_TEXT" if policy.startswith("SYNTHETIC_HUMMING") else "EXPECTED_TEXT_NEEDS_REVIEW"
            else:
                artifacts = [item for item in record.get("artifacts", []) if Path(item.get("path", "")).suffix.lower() == ".wav"]
                if len(artifacts) != 1:
                    row["state"] = "SOURCE_AUDIO_SELECTION_NEEDS_REVIEW"
                else:
                    artifact = artifacts[0]
                    path = Path(artifact["path"])
                    if not path.is_file() or sha(path) != artifact.get("sha256"):
                        row["state"] = "EXCLUDED_AUDIO_HASH_MISMATCH"
                    else:
                        _, _, info = audio(path)
                        if not info["finite"] or not info["frames"] or not info["peak"]:
                            row["state"] = "EXCLUDED_INVALID_AUDIO"
                        else:
                            quality = {"model": source.get("model"), "case_id": source["id"],
                                       "surface": surface, "expected_text": expected,
                                       "expected_text_policy": policy, "case_record": str(record_path),
                                       "case_record_sha256": sha(record_path),
                                       "audio_path": str(path), "audio_sha256": artifact["sha256"],
                                       "source_audio_path": source_audio, "source_audio_sha256": row.get("source_audio_sha256"),
                                       "context_sha256": runtime_sha, "source_request": request if surface == "cli_raw" else source.get("inputs", {}),
                                       "audio_measurements": info}
                            if source["id"] == "vc-tone-color-native22050-control":
                                quality.update(source_manifest=str(explicit_control), source_manifest_sha256=sha(explicit_control),
                                               expected_text_provenance=provenance)
                            cases.append({"id": "roundtrip-" + source["id"], "task": "asr", "model": "qwen3-asr",
                                          "inputs": {"stream": False, "detailed": False, "dialogue": False, "context": ""},
                                          "uploads": {"audio": str(path)},
                                          "options": {"max_tokens": 128, "audio_chunk_mode": "none"},
                                          "expect": "done", "timeout": 900,
                                          "coverage": ["vc-content-preservation-text-screening", "offline-asr"],
                                          "quality_source": quality})
                            row.update(state="PREPARED_NOT_EXECUTED", asr_case=cases[-1]["id"], audio_sha256=artifact["sha256"])
        audit.append(row)
    document = {"generated_at": datetime.now(timezone.utc).isoformat(), "snapshot_is_live": True,
                "source": str(base), "context_path": str(runtime_path), "context_sha256": runtime_sha,
                "scope": "14 frozen main VC/CLI routes plus at most the one explicitly authorized native22050 ToneColor API control; successful current source outputs only. No browser/common duplicates or audio-tools ASR.",
                "limits": "ASR similarity screens lexical content only; no voice, pitch, timbre, singing or acoustic acceptance. S2S editing is compared with its target text. Failed source executions stay failures.",
                "frozen_main_routes": 14, "explicit_native_control_routes": int(provenance is not None),
                "planned_routes": len(plans), "lexical_routes": sum(bool(row["expected_text"]) for row in audit),
                "prepared_cases": len(cases), "source_audit": audit, "cases": cases}
    output = args.output or base / "vc-roundtrip-cases.json"
    output.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"manifest": str(output), "routes": len(plans), "lexical_routes": document["lexical_routes"],
                      "prepared_cases": len(cases), "source_states": {state: sum(row["state"] == state for row in audit) for state in sorted({row["state"] for row in audit})}}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
