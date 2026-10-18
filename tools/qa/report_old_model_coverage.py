"""Read saved current-runtime evidence against the initial downloaded-model inventory.

No HTTP, inference, downloads, or model mutations.  The denominator is frozen at
45 initially visible entries plus four undiscovered legacy logical entries.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def norm(path):
    return str(path or "").replace("\\", "/").rstrip("/").casefold()


def cell(value):
    return str(value).replace("|", "\\|").replace("\n", " ")


def logical_task(entry):
    if entry.get("family") == "builtin_audio_utils":
        return "processing"
    return {"clon": "tts", "gen": "music", "vdes": "design", "svc": "vc", "s2s": "vc",
            "sep": "separation", "vad": "vad", "diar": "diar", "align": "align"}.get(entry["task"], entry["task"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, default=Path("build/functional-qa-20261008"))
    args = parser.parse_args()
    base = args.evidence.resolve()
    inventory_path = base / "model-inventory.json"
    inventory = read(inventory_path)
    runtime_path = base / "current-runtime.json"
    runtime = read(runtime_path)
    runtime_sha = hashlib.sha256(runtime_path.read_bytes()).hexdigest()
    cli_path = Path(runtime["bundle_root"]) / "build/windows-cuda-release/bin/audiocpp_cli.exe"
    cli_sha = hashlib.sha256(cli_path.read_bytes()).hexdigest() if cli_path.exists() else None
    started = datetime.fromisoformat(runtime["started_at"])
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone(timedelta(hours=8)))
    entries = []
    for original in inventory["entries"]:
        entry = dict(original)
        entry["initial_ui_visible"] = True
        entry["initially_present_weights"] = True
        entry["spec_new_family_flag"] = entry.pop("new_family", None)
        entry["algorithm_introduced_in_merge"] = entry["id"].startswith("builtin-gtcrn-") if entry["family"] == "builtin_audio_utils" else entry["spec_new_family_flag"]
        entry["identity_note"] = (
            "New GTCRN algorithm/variant introduced in this merge; asset was already present in the initial physical inventory."
            if entry["id"].startswith("builtin-gtcrn-") else
            "Existing utility algorithm/asset; new generic builtin adapter/catalog exposure is not a new model."
            if entry["family"] == "builtin_audio_utils" else
            "Initial weights existed despite a newly supported family; download time and family lineage are separate."
            if entry["spec_new_family_flag"] else "Pre-merge supported family with initially present weights.")
        entries.append(entry)
    excluded_components = []
    for physical in inventory["unmatched_physical_directories"]:
        role = physical.get("role", "")
        if "no independent catalog entry" in role:
            excluded_components.append(physical)
            continue
        if "Vevo2" in physical["path"]:
            identities = [("vevo2", "vevo2", "vc"), ("vevo2-svc", "vevo2", "svc"), ("vevo2-s2s", "vevo2", "s2s")]
            reason = "Legacy Safetensors directory differs from current Vevo2-GGUF catalog discovery. CLI test-spec override binds the external whisper frontend; it does not repair UI discovery."
        elif "Voxtral" in physical["path"]:
            identities = [("voxtral-realtime", "voxtral_realtime", "asr")]
            reason = "Legacy Safetensors directory differs from current GGUF catalog discovery; required source resources were present."
        else:
            raise ValueError(f"Unclassified initial physical model: {physical}")
        for model_id, family, task in identities:
            entries.append({"id": model_id, "family": family, "task": task, "abs_path": physical["path"],
                            "initial_ui_visible": False, "initially_present_weights": True,
                            "spec_new_family_flag": False, "algorithm_introduced_in_merge": False, "physical_inventory": physical,
                            "identity_note": "Old physical download not discovered in the initial UI catalog.",
                            "discovery_blocker": reason, "candidates": [{"path": physical["path"]}]})
    assert len(entries) == 49, f"Initial denominator changed: {len(entries)}"
    assert len({entry["id"] for entry in entries}) == 49
    records = []
    excluded_records = []
    for path in sorted((base / "cases").glob("*.json")):
        record = read(path)
        case = record.get("case", {})
        raw = record.get("surface") == "cli_raw"
        context = record.get("context", {})
        current = ((context.get("workbench_context_sha256") == runtime_sha
                    and context.get("cli_sha256") == cli_sha and context.get("head") == runtime["head"])
                   if raw else record.get("context_sha256") == runtime_sha)
        if not current:
            excluded_records.append({"path": str(path), "reason": "Missing/different runtime or CLI executable hash"})
            continue
        request = record.get("request", {})
        action = request.get("action", case.get("action", "generate"))
        expected = case.get("expect", "done")
        normal = record.get("verdict") == "PASS" and expected == "done" and action == "generate"
        if not raw:
            normal = normal and record.get("job", {}).get("status") == "done"
        records.append({"id": case.get("id", path.stem), "model": case.get("model"),
                        "family": case.get("family", context.get("family")), "task": case.get("task"),
                        "surface": "cli_raw" if raw else "workbench_http", "path": str(path),
                        "verdict": record.get("verdict"), "expected": expected, "action": action,
                        "successful_normal_execution": bool(normal), "error": record.get("error"),
                        "elapsed": record.get("elapsed"), "artifacts": record.get("artifacts", []),
                        "resolved_install_path": record.get("detail", {}).get("install_path"),
                        "raw_model_path": context.get("model_path") if raw else None,
                        "context_boundary": "Current runtime JSON SHA and current executable hash" if raw else "Current runtime JSON SHA"})
    for path in sorted((base / "live-execution").glob("*/execution.json")):
        record = read(path)
        try:
            browser_started = datetime.fromisoformat(record.get("started", "").replace("Z", "+00:00"))
        except ValueError:
            continue
        if browser_started.timestamp() < started.timestamp() or "without mocked responses" not in record.get("method", ""):
            continue
        for post in record.get("posts", []):
            body = post.get("body", {})
            if not post.get("url", "").endswith("/jobs") or not body:
                continue
            case = record.get("manifest", {})
            action = body.get("action", "generate")
            normal = record.get("status") == "pass" and record.get("job", {}).get("status") == "done" and action == "generate"
            records.append({"id": case.get("id", path.parent.name), "model": body.get("model"),
                            "family": None, "task": body.get("task"), "surface": "real_browser",
                            "path": str(path), "verdict": record.get("status"), "expected": case.get("expect", "done"),
                            "action": action, "successful_normal_execution": bool(normal),
                            "error": record.get("error", record.get("failure")), "checks": record.get("checks", []),
                            "resolved_install_path": None, "raw_model_path": None,
                            "context_boundary": "Actual POST/job after current instance start; browser report has no binary SHA"})
    plans = []
    for path in sorted(base.glob("*cases*.json")) + [base / "remaining-replay.json"]:
        if not path.exists():
            continue
        document = read(path)
        values = document if isinstance(document, list) else document.get("cases", []) if isinstance(document, dict) else []
        for case in values:
            if isinstance(case, dict) and case.get("id"):
                plans.append({"id": case["id"], "model": case.get("model"), "family": case.get("family"),
                              "task": case.get("task"), "path": str(path), "skip_reason": case.get("skip_reason")})
    rows = []
    order = {task: i for i, task in enumerate(("tts", "asr", "music", "design", "vc", "processing", "separation", "vad", "diar", "turn", "align", "midi"))}
    for entry in sorted(entries, key=lambda e: (order.get(logical_task(e), 99), e["id"])):
        matched = [r for r in records if r["surface"] != "cli_raw" and r["model"] == entry["id"]]
        matched += [r for r in records if r["surface"] == "cli_raw" and r["family"] == entry["family"]
                    and r["task"] == entry["task"] and norm(r["raw_model_path"]) == norm(entry["abs_path"])]
        related_raw = [r for r in records if r["surface"] == "cli_raw" and r["family"] == entry["family"] and r not in matched]
        successes = [r for r in matched if r["successful_normal_execution"]]
        failures = [r for r in matched if str(r["verdict"]).upper() == "FAIL"]
        ui_success = [r for r in successes if r["surface"] != "cli_raw"]
        state = "SUCCESS_WITH_RETAINED_FAILURES" if ui_success and failures else "CURRENT_UI_PATH_SUCCESS" if ui_success else (
            "UI_DISCOVERY_BLOCKED_CLI_SUCCESS" if successes and not entry["initial_ui_visible"] else
            "FAILED_NO_SUCCESS" if failures else "UI_DISCOVERY_BLOCKED" if not entry["initial_ui_visible"] else "PENDING_REAL_EXECUTION")
        candidates = {norm(c["path"]) for c in entry.get("candidates", [])} | {norm(entry["abs_path"])}
        selected_paths = sorted({r["resolved_install_path"] for r in matched if r.get("resolved_install_path")})
        entry_plans = [p for p in plans if p["model"] == entry["id"] or (p["family"] == entry["family"] and p["task"] == entry["task"])]
        rows.append({**entry, "menu": logical_task(entry), "coverage_state": state,
                     "http": [r for r in matched if r["surface"] == "workbench_http"],
                     "browser": [r for r in matched if r["surface"] == "real_browser"],
                     "cli": [r for r in matched if r["surface"] == "cli_raw"],
                     "related_cli_different_task_not_coverage": related_raw,
                     "planned": entry_plans, "resolved_ui_install_paths": selected_paths,
                     "resolved_paths_match_initial_candidates": all(norm(p) in candidates for p in selected_paths) if selected_paths else None,
                     "path_evidence_boundary": "HTTP detail.install_path is UI-resolved asset metadata; per-case native model-path commandline was not captured by this report. CLI model_path is explicit.",
                     "normal_execution_success": bool(successes), "retained_failure_count": len(failures),
                     "quality_acceptance": "NOT_GRANTED_BY_COVERAGE_REPORT"})
    counts = Counter(r["coverage_state"] for r in rows)
    output = {"generated_at": datetime.now(timezone(timedelta(hours=8))).isoformat(),
              "scope": "Initial downloaded model logical-entry reconciliation; saved current-runtime records only; no inference or product modifications.",
              "inventory_path": str(inventory_path), "inventory_sha256": hashlib.sha256(inventory_path.read_bytes()).hexdigest(),
              "runtime_context_sha256": runtime_sha, "current_cli_sha256": cli_sha,
              "summary": {"initial_visible_entries": 45, "undiscovered_legacy_logical_entries": 4,
                          "total_initial_logical_entries": len(rows), "excluded_component_directories": len(excluded_components),
                          "states": dict(counts), "with_any_normal_execution_success": sum(r["normal_execution_success"] for r in rows),
                          "http_success_entries": sum(any(e["successful_normal_execution"] for e in r["http"]) for r in rows),
                          "browser_success_entries": sum(any(e["successful_normal_execution"] for e in r["browser"]) for r in rows),
                          "cli_same_task_success_entries": sum(any(e["successful_normal_execution"] for e in r["cli"]) for r in rows)},
              "boundaries": ["45 includes preexisting VoxCPM1 two entries and seven built-in utility assets despite new_family=true; this flag does not mean newly downloaded. Four utility algorithms are old; three GTCRN variants were introduced in this merge but already physically present at initial inventory.",
                             "SUCCESS_WITH_RETAINED_FAILURES preserves all failed evidence, including historical browser QA assertion/manifest failures. This state/count is not a product defect count; inspect the individual diagnosis and retest.",
                             "Vevo raw zero-shot TTS does not cover its three UI VC/SVC/S2S entries. Related different-task CLI evidence is listed separately.",
                             "All logical routes are counted; duplicate physical copies/components are not additional model entries.",
                             "A normal successful execution is not every option/route/quality acceptance. Original failures and semantic audits remain open.",
                             "Attempts/old portable runtime are excluded. Browser boundary is weaker than HTTP/CLI executable-context SHA proof."],
              "excluded_components": excluded_components, "excluded_records": excluded_records, "models": rows}
    (base / "old-model-coverage.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = ["# 升级前已下载模型逐入口覆盖对账", "", "快照：" + output["generated_at"], "",
             "基线固定45初始可见入口+Vevo三条/Voxtral一条未识别入口=49；DAC两处和whisper-medium为组件，排除。物理已有与new_family标志独立列，不用installed58替代旧模型完整性。", "",
             "| 分类 | 条目数 |", "|---|---:|"]
    lines += [f"| {state} | {count} |" for state, count in counts.items()]
    lines += ["", "HTTP/browser/CLI成功条目可以重叠；只计算正常生成/识别，不将负例/取消/分析动作当生成。结构成功不关闭原失败或语义问题。", "",
              "| 菜单/初始入口 | 初始物理目录 | new_family谱系 / 本次引入算法 | 当前HTTP | 真实browser | 同task CLI | 当前状态/阻塞 |", "|---|---|---|---|---|---|---|"]
    for row in rows:
        def evidence(surface):
            return "; ".join(f"[{e['id']}]({e['path'].replace(chr(92), '/')}) {e['verdict']}" for e in row[surface]) or "未执行"
        explanation = row["coverage_state"] + ("；" + row.get("discovery_blocker", "") if row.get("discovery_blocker") else "")
        lines.append("| " + " | ".join(cell(v) for v in (f"{row['menu']} / {row['id']}", row["abs_path"], f"{row['spec_new_family_flag']} / {row['algorithm_introduced_in_merge']}", evidence("http"), evidence("browser"), evidence("cli"), explanation)) + " |")
    lines += ["", "## 边界与续跑", "", "- 初始builtin7中DFN2/RNNoise/ZipEnhancer/FlashSR是旧算法，GTCRN三变体是本次新增但初始已有本地资产；VoxCPM1初始也已有权重。物理已有、family谱系和算法引入时间独立。",
              "- SUCCESS_WITH_RETAINED_FAILURES保留所有原失败，也含已诊断的浏览器QA断言/清单误报；其计数不是产品缺陷数，应同时读独立诊断和真实重测。",
              "- Vevo zero-shot TTS raw成功仅列related_cli，不能抵扣三条转换入口。Voxtral正确CLI stream成功不关闭UI发现缺口或尾词待审。",
              "- HTTP记录带current-runtime SHA；CLI再核当前CLI完整SHA。browser仅核真实POST/job与当前实例启动后，报告无binary SHA，证据层级明确降低。",
              "- HTTP detail.install_path是UI解析元数据，未声称捕获每case native model路径；JSON保留全部初始候选目录和实际解析路径。",
              "- JSON保存每条原记录、失败、预期结果、计划、CLI不同task旁证与组件排除，不删除历史。", "",
              "```powershell", "rtk proxy .\\venv\\Scripts\\python.exe -X utf8 tools/qa/report_old_model_coverage.py", "```", ""]
    (base / "old-model-coverage.md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps(output["summary"], ensure_ascii=False))


if __name__ == "__main__":
    main()
