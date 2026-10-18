"""Offline evidence snapshot for the 2026-10-09 fixes; never runs models or HTTP.

Exit zero means the report was written, not that every test or quality gate passed.
The original frozen evidence is read only. Default status remains IN_PROGRESS.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import time
import uuid


ROOT = Path(__file__).resolve().parents[2]
MENU = {name: i for i, name in enumerate(("tts", "asr", "music", "design", "vc", "references", "processing", "separation", "analysis", "models", "settings"))}


def stable_read(path):
    """Reject truncated/actively replaced input rather than treating it as PASS."""
    before = path.stat()
    raw = path.read_bytes()
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or len(raw) != before.st_size:
        raise ValueError("file changed during read")
    encoding = "utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
    return raw.decode(encoding), hashlib.sha256(raw).hexdigest()


def load(path, excluded, sources):
    try:
        text, digest = stable_read(path)
        document = json.loads(text)
        if not isinstance(document, dict):
            raise ValueError("expected JSON object")
        sources[str(path)] = digest
        return document
    except (OSError, ValueError, UnicodeError) as error:
        excluded.append({"path": str(path), "reason": str(error)})
        return None


def context_matches(actual, current):
    health, expected = actual.get("health", {}), current.get("health", {})
    return bool(expected.get("instance_id") and
                all(health.get(k) == expected.get(k) for k in ("instance_id", "pid", "runtime_revision")) and
                current.get("server_sha256") and actual.get("server_sha256") == current["server_sha256"])


def api_row(document, path, current):
    case = document.get("case", {})
    verdict = document.get("verdict")
    if not case.get("id") or verdict not in {"PASS", "FAIL", "BLOCKED", "PENDING", "NEED_REVIEW", "SKIP"}:
        raise ValueError("missing case id or recognized verdict")
    if not isinstance(document.get("elapsed"), (int, float)):
        raise ValueError("no completed elapsed field")
    if document.get("surface") != "workbench_http":
        raise ValueError("not a workbench HTTP execution (separate surface)")
    job = document.get("job") or {}
    expected = case.get("expect", "done")
    contradiction = []
    if verdict == "PASS":
        if job.get("status") != expected:
            contradiction.append("PASS does not match expected terminal job status")
        if case.get("contains") and case["contains"] not in (job.get("text", "") + " " + job.get("message", "")):
            contradiction.append("PASS lacks required error/text substring")
    outcome = "INCONSISTENT" if contradiction else verdict
    if outcome == "PASS" and expected in {"error", "cancelled"}:
        outcome = "EXPECTED_ERROR" if expected == "error" else "EXPECTED_CANCELLED"
    regression = case.get("regression", {})
    return {"id": case["id"], "task": case.get("task"), "model": case.get("model"),
            "outcome": outcome, "recorded_verdict": verdict, "expected": expected,
            "terminal": job.get("status"), "elapsed": document["elapsed"], "path": str(path),
            "category": regression.get("category", "unclassified_extra"), "origin": regression.get("origin", {}),
            "context_matches_current": context_matches(document.get("context", {}), current),
            "request": document.get("request"), "runtime_configuration": document.get("runtime", {}).get("server", {}).get("configuration"),
            "artifacts": document.get("artifacts", []), "backend_log": document.get("backend_log"),
            "fresh_native_model_before_inference": document.get("fresh_native_model_before_inference"),
            "fresh_native_model_after_inference": document.get("fresh_native_model"),
            "error": document.get("error") or (job.get("message") if outcome not in {"PASS", "EXPECTED_CANCELLED"} else None),
            "contradictions": contradiction}


def browser_row(document, path, current, helper=None):
    # Helpers save intermediate JSON after every check; only finished records count.
    if not document.get("finished") or str(document.get("status", "")).lower() not in {"pass", "fail"}:
        raise ValueError("browser/helper has not finished")
    checks = document.get("checks", [])
    counts = Counter(check.get("status", "unknown") for check in checks)
    failures = document.get("failures", [])
    failed = str(document["status"]).lower() == "fail" or counts["fail"] > 0 or bool(failures) or bool(document.get("pageErrors"))
    manifest = document.get("manifest", {})
    if not helper and not manifest.get("id"):
        raise ValueError("browser execution lacks manifest id")
    return {"id": manifest.get("id", helper), "task": manifest.get("task", "references" if helper != "final-management" else "settings"),
            "model": manifest.get("model"), "outcome": "FAIL" if failed else "PASS", "path": str(path),
            "finished": document["finished"], "checks": dict(counts), "failures": failures,
            "failed_checks": [check for check in checks if check.get("status") == "fail"],
            "context_matches_current": context_matches(document.get("runtime_context", {}), current),
            "method": document.get("method"), "posts": document.get("posts", []),
            "job_id": document.get("jobId"), "terminal": (document.get("job") or {}).get("status"),
            "generation_submitted": any(str(post.get("url", "")).endswith("/api/workbench/jobs") for post in document.get("posts", [])),
            "execution_kind": "playback_only" if str(document.get("method", "")).startswith("Playback-only") else "real_backend",
            "downloads": document.get("downloads", []), "artifacts": document.get("artifacts", []),
            "audio": document.get("audio", []), "screenshots": document.get("screenshots", []),
            "text_export": document.get("textExport"), "parameter_refill": document.get("parameterRefill"),
            "settled_controls": document.get("settledControls"),
            "settled_media": document.get("settledMedia"),
            "fresh_native_model_before_inference": document.get("fresh_native_model_before_inference"),
            "page_errors": document.get("pageErrors", []),
            "processes": document.get("processes", []), "configs": document.get("configs", []),
            "final_runtime": document.get("final_runtime", document.get("finalRuntime")),
            "restored": document.get("restored"), "origin": manifest.get("regression", {}).get("origin", {})}


def collect(paths, current, excluded, sources, convert):
    rows = []
    for path in sorted(paths):
        document = load(path, excluded, sources)
        if document is not None:
            try:
                rows.append(convert(document, path, current))
            except (TypeError, ValueError, AttributeError) as error:
                excluded.append({"path": str(path), "reason": str(error)})
    return rows


def log_result(path, sources):
    empty = {"path": str(path), "pass": None, "total": None, "gallery_models": 0, "ctest_names": []}
    if not path.is_file():
        return {**empty, "status": "NOT_AVAILABLE"}
    try:
        text, digest = stable_read(path)
        sources[str(path)] = digest
        unit = re.search(r"Ran\s+(\d+)\s+tests?\s+in", text)
        chrome = re.search(r"Workbench browser regression:\s*(\d+)/(\d+)\s+passed", text)
        ctest = re.search(r"(\d+)% tests passed,\s*(\d+) tests failed out of\s*(\d+)", text)
        status, passed, total = "UNPARSED", None, None
        if unit:
            total = int(unit[1])
            status = "PASS" if re.search(r"^OK\s*$", text, re.M) and not re.search(r"^FAILED\b", text, re.M) else "FAIL"
            passed = total if status == "PASS" else None
        if chrome:
            passed, total = int(chrome[1]), int(chrome[2])
            status = "PASS" if passed == total else "FAIL"
        if ctest:
            total, failed = int(ctest[3]), int(ctest[2])
            passed, status = total - failed, "PASS" if ctest[1] == "100" and failed == 0 else "FAIL"
        return {"path": str(path), "sha256": digest, "status": status, "pass": passed, "total": total,
                "gallery_models": len(re.findall(r"^MODEL PASS\s", text, re.M)),
                "ctest_names": re.findall(r"Test\s+#\d+:\s+(\S+)\s+\.*\s*Passed", text)}
    except (OSError, ValueError, UnicodeError) as error:
        return {**empty, "status": "UNREADABLE", "error": str(error)}


def root_review(evidence, state, actual_counts, excluded, sources):
    result = {"verified": False, "status": "NOT_FINAL_SNAPSHOT"}
    path = evidence / "final-root-review.json"
    if state != "FINAL_SNAPSHOT":
        return result
    if not path.is_file():
        return {**result, "status": "NOT_AVAILABLE"}
    document = load(path, excluded, sources)
    if not document:
        return {**result, "status": "INVALID_REVIEW"}
    if document.get("status") != "FUNCTIONAL_REVIEW_COMPLETE_HUMAN_QUALITY_PENDING" or document.get("reviewer") != "root" or not document.get("reviewed_at"):
        return {**result, "status": "INVALID_REVIEW_STATUS"}
    references = document.get("references")
    if not isinstance(references, list) or not references:
        return {**result, "status": "MISSING_REFERENCES"}
    checked = []
    for reference in references:
        if not isinstance(reference, dict) or not reference.get("path") or not reference.get("sha256"):
            return {**result, "status": "INVALID_REFERENCE"}
        target = Path(reference["path"])
        target = target.resolve() if target.is_absolute() else (evidence / target).resolve()
        try:
            _, digest = stable_read(target)
            unchanged = str(target) not in sources or sources[str(target)] == digest
            sources[str(target)] = digest
            matched = unchanged and digest == reference["sha256"]
        except (OSError, ValueError, UnicodeError):
            digest, matched = None, False
        checked.append({"path": str(target), "expected_sha256": reference["sha256"], "actual_sha256": digest, "matches": matched})
    required = {"current-runtime.json", "integrity-audit.json", "visual-review.json", "final-idle-runtime.json", "parameter-posthoc.json"}
    required_present = required.issubset({Path(row["path"]).name for row in checked})
    counts_match = {key: document.get(key) == value for key, value in actual_counts.items()}
    result = {**result, "references": checked, "required_references_present": required_present, "counts_match": counts_match}
    if not required_present or not all(row["matches"] for row in checked):
        return {**result, "status": "STALE_OR_MISSING_REFERENCES"}
    if not all(counts_match.values()):
        return {**result, "status": "COUNTS_CHANGED"}
    return {**result, "verified": True, "status": document["status"], "path": str(path), "sha256": sources[str(path)], "review": document}


def snapshot(evidence, frozen, state="IN_PROGRESS"):
    excluded, sources = [], {}
    current = load(evidence / "current-runtime.json", excluded, sources) or {}
    marker = load(frozen / "TESTING-FROZEN.json", excluded, sources) or {}
    original = load(frozen / "final-validation-summary.json", excluded, sources) or {}
    original_path = str(frozen / "final-validation-summary.json")
    ledger = next((row for row in marker.get("evidence_file_ledger", []) if row.get("path") == original_path), {})
    original_verified = bool(ledger.get("sha256") and ledger["sha256"] == sources.get(original_path))
    api = collect((evidence / "cases").glob("*.json"), current, excluded, sources, api_row)
    historical_api = collect((evidence / "cases" / "attempts").glob("*.json"), current, excluded, sources, api_row)
    browser = collect((evidence / "live-execution").glob("*/execution.json"), current, excluded, sources, browser_row)
    helpers = []
    for name in ("reference-asr", "reference-slot", "final-management"):
        helpers += collect((evidence / name).glob(f"*/{name}.json"), current, excluded, sources,
                           lambda d, p, c, name=name: browser_row(d, p, c, name))
    latest = {}
    for row in sorted(browser, key=lambda row: row["finished"]):
        latest[row["id"]] = row
    negative_plan = {}
    for manifest in ("fix-api-minimal-cases.json", "fix-api-cases.json"):
        if (evidence / manifest).is_file():
            document = load(evidence / manifest, excluded, sources) or {}
            for case in document.get("cases", []):
                if case.get("regression", {}).get("category") == "new_negative_contract":
                    negative_plan[case["id"]] = {"id": case["id"], "contains": case.get("contains"), "origin": case["regression"].get("origin", {})}
    documents = {}
    for name in ("integrity-audit.json", "ui-fix-validation.json", "new-rvc/fresh-download-verified.json", "adapters/validation.json", "final-ui-observations.json", "parameter-posthoc.json", "tts-roundtrip-quality.json", "visual-review.json", "rvc-initial-media-transient-audit.json"):
        if (evidence / name).is_file():
            documents[name] = load(evidence / name, excluded, sources)
    corrections = []
    for path in sorted(evidence.glob("fix-browser-minimal-cases-attempt*.json")):
        document = load(path, excluded, sources) or {}
        if document.get("qa_correction"):
            corrections.append(document["qa_correction"])
    vevo_manifest = evidence / "fix-api-vevo2-s2s-processing-attempt2.json"
    if vevo_manifest.is_file():
        document = load(vevo_manifest, excluded, sources) or {}
        for case in document.get("cases", []):
            correction = case.get("regression", {}).get("qa_correction") or {}
            if correction.get("category") == "HARNESS_MANIFEST" and correction.get("original_record"):
                verified = correction.get("original_record_sha256") == sources.get(correction["original_record"])
                corrections.append({**correction, "failed_attempt": correction["original_record"],
                                    "classification": "QA_CASE_ERROR" if verified else "UNVERIFIED_QA_CORRECTION",
                                    "original_record_sha_matches": verified, "corrected_case_id": case.get("id"),
                                    "corrected_record": str(evidence / "cases" / f"{case.get('id')}.json"),
                                    "explanation": str(evidence / "vevo2-s2s-route-audit.md"),
                                    "browser_manifest": str(evidence / "fix-browser-vevo2-s2s-processing-routed.json")})
    logs = {name: log_result(evidence / name, sources) for name in (
        "build-validation/attempt2/ctest.log", "adapters/webui-unittest.log", "adapters/targeted.log",
        "ui-browser-full-regression.log", "ui-browser-regression.log", "ui-metadata-regression.log", "model-gallery-regression.log")}
    qa_error_paths = {row.get("failed_attempt") for row in corrections if row.get("classification") == "QA_CASE_ERROR"}
    api_qa_errors = [row for row in api if row["path"] in qa_error_paths]
    browser_qa_errors = [row for row in browser if row["path"] in qa_error_paths]
    actual_counts = {"api_effective_counts": dict(Counter(row["outcome"] for row in api if row["path"] not in qa_error_paths)),
                     "browser_latest_counts": dict(Counter(row["outcome"] for row in latest.values())),
                     "helper_groups": len({row["id"] for row in helpers}),
                     "historical_qa_case_errors_preserved": {"api": len(api_qa_errors), "browser": len(browser_qa_errors)}}
    review = root_review(evidence, state, actual_counts, excluded, sources)
    return {"generated_at": datetime.now(timezone.utc).isoformat(), "state": state,
            "method": "Filesystem-only stable completed records; no HTTP, subprocess or GPU. Zero report exit is not test acceptance.",
            "evidence": str(evidence), "frozen": str(frozen), "current_runtime": current,
            "original": {"summary": original, "summary_matches_frozen_ledger": original_verified,
                         "marker_sha256": sources.get(str(frozen / "TESTING-FROZEN.json"))},
            "api": api, "api_counts": dict(Counter(row["outcome"] for row in api)), "historical_api_attempts": historical_api,
            "api_effective_counts": dict(Counter(row["outcome"] for row in api if row["path"] not in qa_error_paths)), "api_qa_case_errors": api_qa_errors,
            "browser_attempts": browser, "browser_attempt_counts": dict(Counter(row["outcome"] for row in browser)),
            "browser_effective_counts": dict(Counter(row["outcome"] for row in browser if row["path"] not in qa_error_paths)), "browser_qa_case_errors": browser_qa_errors,
            "browser_latest": list(latest.values()), "browser_latest_counts": dict(Counter(row["outcome"] for row in latest.values())),
            "helper_attempts": helpers, "negative_contract_plan": list(negative_plan.values()),
            "documents": documents, "case_corrections": corrections, "validation_logs": logs, "excluded_incomplete_or_invalid": excluded,
            "root_review": review,
            "source_sha256": sources}


def link(path, label=None):
    return f"[{label or Path(path).name}](<{str(path).replace(chr(92), '/')}>)" if path else "—"


def cell(value):
    return str(value if value is not None else "—").replace("|", "\\|").replace("\n", " ")


def table(lines, columns, rows):
    lines += ["", "| " + " | ".join(columns) + " |", "|" + "|".join("---" for _ in columns) + "|"]
    lines += ["| " + " | ".join(cell(value) for value in row) + " |" for row in rows]


def render(report, json_path):
    base, frozen = Path(report["evidence"]), Path(report["frozen"])
    original = report["original"]["summary"]
    review = report.get("root_review") or {}
    reviewed = report["state"] == "FINAL_SNAPSHOT" and review.get("verified") is True
    review_text = (f"已完成根任务功能复核，引用SHA与实际统计匹配；音质仍待人工验收。{link(review['path'], '根复核记录')}。" if reviewed
                   else f"功能最终复核尚未确认（根复核状态：{review.get('status', 'NOT_AVAILABLE')}）；需根任务审阅，普通快照不授予验收。")
    lines = ["# 当前分支功能修复复测", "", f"状态：**{report['state']}**。证据快照：{report['generated_at']}。",
             "", "本报告由已落盘的终态证据生成；进行中的或半写记录单列排除，不计通过。脚本退出0只表示报告生成成功。" + review_text,
             "", f"完整参数、实际POST、runtime配置、失败历史及文件SHA索引：{link(json_path, '报告JSON')}。",
             "", "## 冻结的原始160例", "", "原始149个可运行HTTP、4个UI发现阻塞、7个CLI例独立冻结；浏览器和修复复测不并入160，也不改写原失败。",
             "", f"原始汇总：{link(frozen / 'final-validation-summary.json')}；冻结标记SHA `{report['original']['marker_sha256']}`；汇总与冻结账本匹配：{report['original']['summary_matches_frozen_ledger']}。"]
    table(lines, ["原始分类", "数量"], original.get("counts", {}).items())
    lines += ["", f"原始验收：{original.get('acceptance', 'UNKNOWN')}；音质：{original.get('quality_acceptance', 'UNKNOWN')}；人工听审：{original.get('human_listening', 'UNKNOWN')}。",
              "", "## 当前修复证据数量", "", f"API已完成记录 {len(report['api'])}（有效合同 {len(report['api']) - len(report['api_qa_case_errors'])}，另已核QA用例错误 {len(report['api_qa_case_errors'])}）；浏览器已完成尝试 {len(report['browser_attempts'])}（有效合同 {len(report['browser_attempts']) - len(report['browser_qa_case_errors'])}，另已核QA用例错误 {len(report['browser_qa_case_errors'])}），独立case {len(report['browser_latest'])}；独立参考/管理helper {len(report['helper_attempts'])}。"]
    table(lines, ["范围", "实际分类"], [("API（正例与预期拒绝分列）", report["api_counts"]), ("浏览器全部尝试（失败历史保留）", report["browser_attempt_counts"]), ("浏览器每case最新终态", report["browser_latest_counts"])])
    table(lines, ["有效合同范围（仅排除已核QA_CASE_ERROR）", "实际分类"], [("API", report["api_effective_counts"]), ("真实浏览器", report["browser_effective_counts"])])
    table(lines, ["独立参考/管理helper", "实际结果", "逐项checks", "记录"], [(row["id"], row["outcome"], row["checks"], link(row["path"])) for row in report["helper_attempts"]])
    untrusted = [r["path"] for r in report["api"] + report["browser_attempts"] + report["helper_attempts"] if not r["context_matches_current"]]
    lines += ["", f"未与当前UI实例/PID/revision及server SHA同时匹配的终态记录：{len(untrusted)}（JSON逐项标记，不能据此声称当前构建已通过）。",
              "", "7条新拒绝合同是4条普通Dot指令拒绝、2条Seed跨task非法route拒绝、1条Vox精度冲突拒绝。它们验证清晰拒绝，不把原来期望生成成功的失败改成通过。"]
    actual = {row["id"]: row for row in report["api"]}
    table(lines, ["新拒绝case", "原例", "实际终态"], [(r["id"], r["origin"].get("case_id"), actual.get(r["id"], {}).get("outcome", "NOT_EXECUTED")) for r in report["negative_contract_plan"]])
    lines += ["", "## 修复范围与验收边界", "", "- UI：多行参数保留换行、参考停止即时反馈/禁重复、Omni646有效语言、Seed入口合法route与旧状态迁移、普通Dot指令隐藏/Edit保留、Vox无效load控件隐藏。",
              "- Python适配：克隆任务路由、旧精度显式迁移/冲突拒绝、模型所需输入采样率、旧语言别名兼容、原raw模型入口发现。",
              "- C++：RVC索引与GGUF资源边界、Qwen离线时间轴、SeedV2长度调节；具体源码/构建证据以新目录日志为准。",
              "- 12个布局旧失败归为 QA_LAYOUT_CONTRACT：bottomGap是短内容下方自然余白，无填满视口的产品合同；保留真实控件间距/溢出断言，未为阈值强改CSS。原报告保留。",
              "- Dot Edit没有专用Edit权重，未做真实Edit推理；普通SoAR/MeanFlow成功或拒绝不替代Edit验收。" + link(base / 'dot-edit-acceptance-boundary.md', '边界说明'),
              "- 音频非空/有限值、播放器前进、下载或ASR往返文字筛查不代表自然度、音色相似度、音乐听感已通过。人工听审另行验收。",
              "- WAV虚拟麦克风配合真实MediaRecorder/上传/后端属于模拟输入；不证明实体麦克风、声卡或真人实时录音。",
              "- 当前仅工作区修复与本地复测；未提交、未推送、未同步portable。"]
    precision = actual.get("fix-tts-voxcpm1-load-precision-contract")
    if precision:
        lines += ["", "Vox继承的quality_note描述的是冻结来源缺陷背景。当前实际runtime配置如下，依据新配置评估迁移，不把旧文案当现状：", "", "```json", json.dumps(precision["runtime_configuration"], ensure_ascii=False, indent=2), "```"]
    fresh = report["documents"].get("new-rvc/fresh-download-verified.json") or {}
    lines += ["", "## 新下载RVC", "", f"文件：{link(fresh.get('path'))}；大小：{fresh.get('bytes', 'UNKNOWN')}；SHA256：`{fresh.get('sha256', 'UNKNOWN')}`。",
              "", f"新网络下载：{fresh.get('fresh_network_download', 'UNKNOWN')}；下载前目标存在：{fresh.get('previous_target_existed', 'UNKNOWN')}；与远端LFS SHA一致：{bool(fresh.get('sha256') and fresh.get('sha256') == fresh.get('remote_lfs_sha256'))}。",
              "", "用户禁止继续使用E/portable旧RVC权重。下载hash记录只证明新包；实际D路径加载须结合RVC终态记录中的fresh gate/原生临时配置及日志核对，不能由catalog路径推断。"]
    native_rows = [(r["id"], (r.get("fresh_native_model_before_inference") or {}).get("weight_path"),
                    (r.get("fresh_native_model_before_inference") or {}).get("sha256"), link(r["path"], "原生加载证明"))
                   for r in report["api"] + report["browser_attempts"] if r.get("fresh_native_model_before_inference")]
    table(lines, ["RVC执行case", "实际加载文件", "实际核验SHA", "证据"], native_rows)
    table(lines, ["离线验证", "实际结果", "证据"], [(name, f"{r['status']} {r['pass']}/{r['total']}" + (f"；metadata模型{r['gallery_models']}" if r.get('gallery_models') else ""), link(r['path'])) for name, r in report["validation_logs"].items()])
    lines += ["", "Chrome前端60项/新5项/metadata gallery采用模拟HTTP或fixture，属于真实Chrome的单元交互验证；与下表真实后端浏览器执行分开。CUDA3ctest与382Python结果由日志正文解析，不能以退出码替代。",
              "", "## API参数及输出索引"]
    api = sorted(report["api"], key=lambda r: (MENU.get(r["task"], 99), r["id"]))
    table(lines, ["case / 模型", "实际结果", "原例关联", "参数/配置", "输出/后端日志"], [(f"{r['id']} / {r['model']}", r["outcome"], r["origin"].get("case_id"), link(r["path"], "执行JSON"), " ".join(link(a.get("path")) for a in r["artifacts"] if a.get("path")) + " " + link(r["backend_log"], "log")) for r in api])
    lines += ["", "## 真实浏览器与参考/管理索引", "", "每次尝试均保留，实际POST inputs/options、播放/下载和逐项断言在执行JSON；截图存在本身不算视觉通过。"]
    lines += ["", f"上述浏览器尝试中，实际提交主生成job：{sum(r['generation_submitted'] for r in report['browser_attempts'])}；在提交前停止的尝试仍按真实FAIL保留，不能声称已验证推理。"]
    table(lines, ["case / 完成时间", "实际结果 / checks", "参数/断言", "输出", "截图"], [(f"{r['id']} / {r['finished']}", f"{r['outcome']} {r['checks']}", link(r["path"], "执行JSON"), " ".join(link(a.get("path")) for a in r["downloads"] + r["artifacts"] + ([r["text_export"]] if r.get("text_export") else []) if isinstance(a, dict) and a.get("path")) or "—", " ".join(link(p) for p in r["screenshots"][-2:])) for r in report["browser_attempts"] + report["helper_attempts"]])
    lines += ["", "播放旧产物的独立复测会标记playback_only，不代表再次推理；JSON保存该分类。参数实效/文字筛查独立报告如下，不改写功能case verdict："]
    table(lines, ["独立后验报告", "证据"], [(name, link(base / name)) for name in ("parameter-posthoc.json", "tts-roundtrip-quality.json") if name in report["documents"]])
    posthoc = report["documents"].get("parameter-posthoc.json") or {}
    if posthoc:
        lines += ["", f"参数实效报告：{link(base / 'parameter-posthoc.json', 'JSON')} / {link(base / 'parameter-posthoc.md', '说明')}。以下status原样读取；PENDING/NEED_REVIEW不计通过，也不混入API数量。"]
        table(lines, ["配对", "实际status", "关键数值/原因"], [(name, pair.get("status", "UNKNOWN"), json.dumps({key: value for key, value in pair.items() if key not in {"status", "case_ids", "word_comparisons", "artifacts", "records", "notes", "fresh_native_proof", "pair_contract"}}, ensure_ascii=False)) for name, pair in posthoc.get("pairs", {}).items()])
        lines += ["", "时间轴配对比较包含各chunk offset一次；Qwen容差是诊断阈值，不等于逐词声学对齐验收。Seed时长变化或RVC PCM差异只证明观测到参数效果，不自动代表音质改善。"]
    if "visual-review.json" in report["documents"]:
        lines += ["", f"实际人工视觉复核：{link(base / 'visual-review.json', '逐截图记录')} / {link(base / 'visual-review.md', '视觉复核说明')}。以记录中实际查看的文件及观察为准，截图存在不自动授予视觉PASS。"]
    failures = [r for r in report["api"] + report["historical_api_attempts"] + report["browser_attempts"] + report["helper_attempts"] if r["outcome"] not in {"PASS", "EXPECTED_ERROR", "EXPECTED_CANCELLED"}]
    lines += ["", "## 保留的失败与未完成", "", f"失败/待审/阻塞终态（含API历史尝试）：{len(failures)}；排除未完成/无效文件：{len(report['excluded_incomplete_or_invalid'])}。"]
    correction_map = {r.get("failed_attempt"): r for r in report["case_corrections"]}
    table(lines, ["case", "状态", "已确认分类", "证据"], [(r["id"], r["outcome"], correction_map.get(r["path"], {}).get("classification", "未由此脚本自动归因"), link(r["path"])) for r in failures])
    if any("nemotron" in str(correction.get("failed_attempt", "")) for correction in report["case_corrections"]):
        lines += ["", f"Nemotron原browser context失败属于QA_CASE_ERROR：未提交POST；新attempt2仅删除metadata明确不暴露的context，其他输入/expect保持。原失败不覆盖。{link(base / 'browser-attempt2-correction.md', '12例静态复核与修正说明')}。"]
    for correction in report["case_corrections"]:
        if correction.get("corrected_case_id") == "fix-api-restored-vevo2-s2s-processing-attempt2":
            corrected = actual.get(correction["corrected_case_id"], {})
            browser = next((row for row in report["browser_latest"] if row["id"] == "fix-browser-vevo2-s2s-processing-routed"), {})
            lines += ["", f"Vevo2 S2S原wrong-task HTTP400按FAIL保留；分类 {correction['classification']}（原记录SHA匹配：{correction['original_record_sha_matches']}）。submit在reserve/load/inference前拒绝错误Workbench task=vc，不能称为模型推理失败。{link(correction['explanation'], '路由审计')}；更正processing独立API：{corrected.get('outcome', 'NOT_EXECUTED')} {link(correction['corrected_record'], '执行记录')}；新浏览器：{browser.get('outcome', 'NOT_EXECUTED')} {link(browser.get('path') or correction['browser_manifest'], '浏览器证据/计划')}。"]
    settled = [(row["id"], sample.get("stage"), sample.get("status"), sample.get("timeout_ms"), len(sample.get("samples", [])), link(row["path"]))
               for row in report["browser_attempts"] for sample in row.get("settled_controls") or []]
    if settled:
        lines += ["", "Nemotron终态/返回菜单稳定态补验单列；实际按钮disabled、公共字段和源音频metadata逐样本保存在执行JSON，颜色不作为disabled依据。"]
        table(lines, ["case", "阶段", "实际status", "窗口ms", "实际样本", "DOM/媒体证据"], settled)
    settled_media = [(row["id"], sample.get("stage"), sample.get("status"), sample.get("timeout_ms"), len(sample.get("samples", [])), link(row["path"]))
                     for row in report["browser_attempts"] for sample in row.get("settled_media") or []]
    if settled_media:
        lines += ["", "Tone终态/返回菜单的源、上传参考、结果播放器metadata稳定态单列；输出播放器按实际job artifacts匹配，不要求折叠seed/advanced可见。"]
        table(lines, ["case", "阶段", "实际status", "窗口ms", "实际样本", "DOM/媒体证据"], settled_media)
    media_audit = report["documents"].get("rvc-initial-media-transient-audit.json") or {}
    if media_audit:
        lines += ["", f"RVC.5初始0:00截图后已有同DOM真实metadata和播放推进证据，审计状态：{media_audit.get('status', 'UNKNOWN')}；{link(base / 'rvc-initial-media-transient-audit.json', '完整记录')}。该case没有返回路由，不外推为返回菜单媒体验收。"]
    table(lines, ["未纳入终态数量的文件", "原因"], [(link(r["path"]), r["reason"]) for r in report["excluded_incomplete_or_invalid"]])
    integrity = report["documents"].get("integrity-audit.json") or {}
    lines += ["", "## 完整性与最终复核", "", f"保护审计：{integrity.get('status', 'NOT_AVAILABLE')}，时间 {integrity.get('completed_at', 'UNKNOWN')}；{link(base / 'integrity-audit.json')}。" +
              (f"该最终审计已在全部任务与卸载之后完成；双槽空闲和身份记录：{link(base / 'final-idle-runtime.json')}；{link(review['path'], '根复核记录')}。" if reviewed else "这是该时点快照；最终任务结束后的用户数据保护与双槽卸载仍待根复核确认。"),
              "", f"原冻结SHA、用户数据、E模型、helper历史字节均以审计的实际summary为准：`{integrity.get('summary', {})}`。",
              "", ("功能、视觉、参数配对、最终卸载及用户数据还原已由根复核。仍未验收：主观音质与人工听审、实体麦克风/声卡、未安装专用权重的Dot Edit真实推理；未提交、推送或同步portable。" if reviewed else "最终需复核：真实失败仍存否、参数配对、ASR时间轴与文字语义、参考停止/双槽exe及端口、模型中心/系统设置、人工视觉、最终卸载及用户数据还原。人工听审、实体麦克风及Dot Edit专用权重推理保留独立边界。"),
              "", "重新生成（仅文件读取，不推理）：", "", "```powershell", "rtk proxy .\\venv\\Scripts\\python.exe -X utf8 tools/qa/report_functional_fixes.py", "# FINAL_SNAPSHOT还需根复核引用SHA及统计匹配；不授予音质/硬件验收", "rtk proxy .\\venv\\Scripts\\python.exe -X utf8 tools/qa/report_functional_fixes.py --state FINAL_SNAPSHOT", "```", ""]
    return "\n".join(lines)


def write_output(path, text, frozen):
    path = path.resolve()
    if path == frozen or frozen in path.parents or any((parent / "TESTING-FROZEN.json").is_file() for parent in path.parents):
        raise ValueError("refuse writing under frozen evidence")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temporary.write_text(text, encoding="utf-8")
        for attempt in range(20):
            try:
                os.replace(temporary, path)
                break
            except PermissionError:
                if attempt == 19:
                    raise
                time.sleep(min(.05 * (attempt + 1), .2))
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, default=ROOT / "build/functional-fixes-20261009")
    parser.add_argument("--frozen", type=Path, default=ROOT / "build/functional-qa-20261008")
    parser.add_argument("--output", type=Path, default=ROOT / "docs/testing/functional-fixes-20261009.md")
    parser.add_argument("--json-output", type=Path)
    parser.add_argument("--state", choices=("IN_PROGRESS", "FINAL_SNAPSHOT"), default="IN_PROGRESS")
    args = parser.parse_args()
    evidence, frozen = args.evidence.resolve(), args.frozen.resolve()
    json_path = (args.json_output or evidence / "functional-fixes-report.json").resolve()
    report = snapshot(evidence, frozen, args.state)
    write_output(json_path, json.dumps(report, ensure_ascii=False, indent=2) + "\n", frozen)
    write_output(args.output, render(report, json_path), frozen)
    print(json.dumps({"state": report["state"], "api": report["api_counts"], "browser_attempts": report["browser_attempt_counts"], "browser_latest": report["browser_latest_counts"], "excluded": len(report["excluded_incomplete_or_invalid"]), "markdown": str(args.output.resolve()), "json": str(json_path)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
