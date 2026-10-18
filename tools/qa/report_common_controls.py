"""Read saved QA evidence; map common UI controls to requests without inference.

This report never treats editing a widget, a queued manifest, an expected error,
or a CLI bypass as successful UI parameter consumption. Run again as cases land.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def meaningful(value):
    # Numeric zero can be a valid selected speaker or duration. Boolean False
    # tests the disabled branch only, not activation of the named feature.
    return value is not None and value != "" and value is not False


def short(value, limit=85):
    text = json.dumps(value, ensure_ascii=False)
    return text if len(text) <= limit else text[:limit - 1] + "…"


def cell(value):
    return str(value).replace("|", "\\|").replace("\n", " ")


def cases(document):
    return document if isinstance(document, list) else document.get("cases", [])


def field_key(control, detail):
    key = control.get("key")
    if key:
        return key
    control_id = control.get("id", "")
    if control_id.startswith("param-"):
        # DOM ids lose punctuation. Resolve by the exact metadata parameter
        # name; never convert hyphens to dots/underscores heuristically.
        matches = [p["name"] for p in detail.get("parameters", [])
                   if "param-" + re.sub(r"[^\w-]", "-", p["name"]) == control_id]
        return matches[0] if len(matches) == 1 else None
    return control_id.rsplit("-", 1)[-1] if control_id else None


def task_for(route, detail):
    if route.startswith("tools-"):
        return "processing" if route == "tools-processing" else (
            "separation" if route == "tools-separation" else "analysis")
    return detail.get("task", route)


def inferred_controls(detail):
    """Metadata-derived common controls for new entries absent from DOM audit.

    Mirrors app.js visibleParameters/renderParameters. These are explicitly
    inferred controls, not successful browser observations.
    """
    task = detail.get("task")
    profile = detail.get("profile", {})
    result = []
    def add(key, kind="input", typ="text"):
        result.append({"id": "param-" + re.sub(r"[^\w-]", "-", key)
                       if kind == "option" else "input-" + str(task) + "-" + key,
                       "key": key, "type": typ, "status": "not-observed"})
    if task in ("tts", "design"):
        if task == "tts" and profile.get("accepts_voice_reference") is not False:
            add("builtin_voice", typ="select")
        if task == "design":
            add("instruct", typ="textarea")
        add("text", typ="textarea")
    if task == "tts":
        add("language", typ="select")
        if detail.get("streaming"):
            add("stream", typ="checkbox")
    if task == "asr":
        cap = detail.get("asr_inputs", {})
        if cap.get("context"):
            add("context")
        if detail.get("streaming"):
            add("stream", typ="checkbox")
        if len(detail.get("languages", [])) > 1:
            add("language", typ="select")
        for key in ("detailed", "dialogue"):
            if cap.get(key):
                add(key, typ="checkbox")
    if task == "music":
        add("text", typ="textarea")
        cap = detail.get("music_inputs", {})
        if cap.get("lyrics"):
            add("lyrics", typ="textarea")
        if cap.get("duration"):
            add("duration", typ="number")
    if task == "vc" and not profile.get("model_as_target_voice"):
        add("builtin_voice", typ="select")
        add("reference_name")
    if task == "analysis" and detail.get("model_task") == "align":
        add("transcript", typ="textarea")
        add("language")
    for param in detail.get("parameters", []):
        name = param["name"]
        if param.get("scope", "request") != "request" or param.get("level") not in ("basic", "effect"):
            continue
        if name == "seed" and task in ("tts", "music", "vc", "processing", "design") and profile.get("send_seed") is not False:
            continue
        if task == "tts" and (name == "language" or detail.get("family") == "index_tts2" and name == "lang"):
            continue
        if task == "asr" and (name == "language" and detail.get("languages") or detail.get("asr_inputs", {}).get("context") and name in ("context", "instruct")):
            continue
        if task == "design" and name in ("instruction", "instruct", profile.get("vdes_option_key")):
            continue
        if task == "analysis" and detail.get("model_task") == "align" and name == "language":
            continue
        if task == "music" and (name in ("lyrics", "duration") or detail.get("music_inputs", {}).get("duration") and name in ("duration_sec", "duration_seconds")):
            continue
        add(name, "option", "checkbox" if param.get("type") in ("bool", "boolean") else param.get("type", "text"))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, default=Path("build/functional-qa-20261008"))
    args = parser.parse_args()
    base = args.evidence.resolve()
    live = read(base / "live-controls.json")
    runtime_path = base / "current-runtime.json"
    context_sha = hashlib.sha256(runtime_path.read_bytes()).hexdigest()
    runtime = read(runtime_path)
    details = {}
    for name in ("model-details.json", "browser-menu-model-details.json"):
        path = base / name
        if path.exists():
            details.update(read(path))
    plans = []
    plan_sources = ("cases.json", "remaining-replay.json", "supplemental-tts-cases.json",
                    "unicode-tts-cases.json", "asr-supplemental-cases.json", "browser-menu-cases.json",
                    "supplemental-common-cases.json", "supplemental-common-browser-cases.json",
                    "long-stream-asr-cases.json", "tts-roundtrip-cases.json")
    for name in plan_sources:
        path = base / name
        if path.exists():
            for case in cases(read(path)):
                plans.append({"case": case, "path": str(path)})
    executions = []
    excluded = []
    for path in sorted((base / "cases").glob("*.json")):
        record = read(path)
        if record.get("surface") == "cli_raw":
            excluded.append({"path": str(path), "reason": "CLI bypass is not UI request coverage"})
            continue
        if record.get("context_sha256") != context_sha:
            excluded.append({"path": str(path), "reason": "Different or missing current runtime context"})
            continue
        case = record.get("case", {})
        if record.get("detail"):
            details[case.get("model")] = record["detail"]
        request = record.get("request")
        if not request:
            continue
        good = (record.get("verdict") == "PASS" and case.get("expect", "done") == "done"
                and record.get("job", {}).get("status") == "done"
                and request.get("action", "generate") == "generate")
        executions.append({"id": case.get("id", path.stem), "model": case.get("model"),
                            "task": case.get("task"), "action": request.get("action", "generate"),
                            "request": request, "successful_generation": good,
                           "verdict": record.get("verdict"), "expect": case.get("expect", "done"),
                           "surface": "workbench_http", "path": str(path),
                           "error": record.get("error", ""), "started_at": record.get("started_at")})
    runtime_start = datetime.fromisoformat(runtime["started_at"]).replace(tzinfo=timezone.utc)
    # current-runtime started_at is local +08:00, unlike browser ISO timestamps.
    runtime_start = runtime_start.timestamp() - 8 * 3600
    for path in sorted((base / "live-execution").glob("*/execution.json")):
        record = read(path)
        try:
            started = datetime.fromisoformat(record.get("started", "").replace("Z", "+00:00")).timestamp()
        except ValueError:
            continue
        if started < runtime_start or "without mocked responses" not in record.get("method", ""):
            continue
        case = record.get("manifest", {})
        for post in record.get("posts", []):
            if not post.get("url", "").endswith("/jobs") or not post.get("body"):
                continue
            good = (record.get("status") == "pass" and record.get("job", {}).get("status") == "done"
                    and post["body"].get("action", "generate") == "generate")
            executions.append({"id": case.get("id", path.parent.name), "model": post["body"].get("model"),
                               "task": post["body"].get("task"), "action": post["body"].get("action", "generate"),
                               "request": post["body"],
                               "successful_generation": good, "verdict": record.get("status"),
                               "expect": case.get("expect", "done"), "surface": "real_browser",
                               "path": str(path), "started_at": record.get("started"),
                               "runtime_boundary": "after current instance restart; browser evidence has no binary SHA"})
    management = []
    for name in ("ui-management/management.json", "ui-management-unicode/management.json"):
        path = base / name
        if not path.exists():
            continue
        record = read(path)
        writes = [p for p in record.get("posts", [])
                  if p.get("endpoint", p.get("url", "")).endswith("/references")
                  and p.get("body", {}).get("name")]
        checks = [c for c in record.get("checks", []) if c.get("status") == "pass"
                  and any(k in c.get("name", "").lower() for k in ("creat", "save", "overwrit", "unicode", "reference"))]
        if writes and checks:
            management.append({"path": str(path), "posts": writes, "checks": checks,
                               "scope": "Shared reference-save adapter; not every VC pane Save click"})
    expert = []
    for model in live["models"]:
        for control in model.get("expertControls", []):
            detail = details.get(model["id"], {})
            expert.append({"model": model["id"], "control": control,
                           "key": field_key(control, detail), "state": "INVENTORY_ONLY"})
    rows = []
    def build_row(model, control, observed=True):
        model_id = model["id"]
        detail = details.get(model_id, {})
        key = field_key(control, detail)
        scope = "options" if control.get("id", "").startswith("param-") else "inputs"
        field = "references.body.name" if key == "reference_name" else f"{scope}.{key}"
        relevant = [e for e in executions if e["model"] == model_id
                    and key in e["request"].get(scope, {})]
        selected = [{k: e[k] for k in ("id", "path", "surface", "action", "verdict", "expect", "successful_generation")}
                    | {"value": e["request"][scope][key]} for e in relevant]
        planned = [{"id": p["case"]["id"], "path": p["path"], "value": p["case"][scope][key]}
                   for p in plans if p["case"].get("model") == model_id
                   and key in p["case"].get(scope, {})]
        success = [e for e in selected if e["successful_generation"]]
        active = [e for e in success if meaningful(e["value"])]
        active_plan = [p for p in planned if meaningful(p["value"])]
        notes = []
        conditional_branch_evidence = []
        state = "EXECUTED_REQUEST" if active else "DISABLED_OR_EMPTY_ONLY" if success else (
            "EXECUTED_FAILURE_OR_NEGATIVE" if selected else "PLANNED" if active_plan else "INTERACTION_ONLY")
        if control.get("status") == "single-choice":
            state = "SINGLE_CHOICE_DEFAULT_ONLY"
            notes.append("Only one model-default language choice; editing/alternate-language consumption is not applicable.")
        if key == "reference_name":
            state = "SHARED_REFERENCE_SAVE_EXECUTED" if management else "INTERACTION_ONLY"
            notes.append("collectInputs skips this field; saveReference sends references.body.name. Shared CRUD coverage is not each VC pane Save.")
        if control.get("type") == "checkbox":
            notes.append("False tests the disabled branch only; enabled feature requires a true request with successful outcome.")
        if any(e["action"] != "generate" for e in selected):
            notes.append("Source analysis is a separate successful operation, not consumption by the generation path; its fields do not activate generation coverage.")
        if key == "builtin_voice":
            notes.append("Library selection differs from uploaded voice UUID. TTS may auto-fill reference_text; selected library wins over upload.")
        if model_id.startswith("dots-tts-") and key == "instruction":
            state = "CONFIRMED_REJECTED"
            notes.append("Existing GGUF embedded request contract rejects instruction; valid no-instruction runs do not cover this control.")
        effect = "NOT_INDEPENDENTLY_MEASURED"
        if model_id in {"seed-vc", "seed-vc-svc"} and key == "length_adjust":
            notes.append("V2 parses/validates length_adjust but uses source_mel.frames unchanged (session.cpp:385-388,694-698); only V1 multiplies it (:933). Successful V2 request alone does not prove duration control.")
            v2 = [e for e in relevant if e["successful_generation"]
                  and e["request"].get("options", {}).get("route") == "v2_vc"]
            if v2:
                effect = "V2_CONFIRMED_NO_COMPUTATIONAL_CONSUMER"
                notes.append("Current V2 nondefault request retains near-source duration; this observation is not a controlled audio A/B. See seedvc-length-adjust-audit.json.")
        if model_id == "index-tts2" and key == "interval_silence_ms":
            effect = "OBSERVED_EFFECT_8820_ZERO_FRAMES_AT_22050HZ"
        if model_id.startswith("index-tts") and key == "interval_silence_ms":
            notes.append("Requires two actual backend text chunks. Index2 controlled 0/400ms pair proves effect; Index2.5 request alone does not.")
        if model_id.startswith("index-tts") and key == "use_emotion_text":
            notes.append("True with nonempty emotion_text uses explicit description; blank emotion_text is needed to test inference from spoken text.")
            conditional_branch_evidence = [{"id": e["id"], "path": e["path"],
                                           "branch": "infer emotion from spoken text", "status": "SUCCESSFUL_REQUEST_AND_STATIC_CONSUMER"}
                                          for e in relevant if e["successful_generation"]
                                          and e["request"].get("options", {}).get("use_emotion_text") is True
                                          and not e["request"].get("options", {}).get("emotion_text")]
            notes.append("Fallback branch: " + (", ".join(e["id"] for e in conditional_branch_evidence)
                                               or "not executed on this model; shared Index2 branch evidence is separate"))
        if model_id == "rvc" and key == "retrieval_blend":
            notes.append("0 disables retrieval. Nonzero requires valid matching packaged vectors or an uploaded FAISS index, not merely a changed slider; see rvc-packaged-retrieval-audit.json.")
            if not any(isinstance(e["value"], (int, float)) and e["value"] > 0 for e in success):
                active = []
                active_plan = [p for p in planned if isinstance(p["value"], (int, float)) and p["value"] > 0]
                state = "PLANNED" if active_plan else "DISABLED_OR_EMPTY_ONLY" if success else "PLANNED_DISABLED_ONLY" if planned else "INTERACTION_ONLY"
                failed_enabled = [e for e in selected if e["verdict"] == "FAIL" and e["expect"] == "done"
                                  and isinstance(e["value"], (int, float)) and e["value"] > 0]
                if failed_enabled:
                    state = "ENABLED_EXECUTION_FAILED"
                    notes.append("Nonzero retrieval was actually attempted and failed: " + ", ".join(e["id"] for e in failed_enabled) + ". Successful zero baseline is disabled coverage; frozen plan entries are intent, not proof of pending or successful execution.")
        if model_id == "rvc" and key == "speaker_id":
            notes.append("0 is a valid first speaker. Do not send speaker 1 to a single-speaker checkpoint merely for nondefault coverage.")
        if key == "language" and control.get("type") == "select":
            options = [o.get("value") for o in control.get("options", [])]
            outside = [e["value"] for e in selected if e["value"] not in options and options]
            if outside:
                notes.append("Some HTTP values were not visible select choices; direct API coverage cannot prove choosing that value in the UI.")
            if model_id == "omnivoice" and "600+ languages" in options:
                state = "API_SUCCESS_UI_CHOICE_UNVERIFIED"
                notes.append("Visible literal '600+ languages' is absent from native language map; static unsupported-language path. Requires separate real browser reproduction; English API success does not validate this choice.")
                rejected = [e for e in relevant if e["request"][scope][key] == "600+ languages"
                            and e.get("expect") == "done"
                            and "unsupported OmniVoice language" in e.get("error", "")]
                if rejected:
                    state = "CONFIRMED_UI_LANGUAGE_REJECTED"
                    notes.append("Real expected-done case rejected the visible choice: " + ", ".join(e["id"] for e in rejected))
        param = next((p for p in detail.get("parameters", []) if p["name"] == key), None)
        return {"model": model_id, "route": model.get("route", detail.get("task")),
                "control": control, "observed_dom": observed, "field": field, "key": key,
                "parameter_metadata": param, "profile": detail.get("profile", {}),
                "interaction_state": "EDITED_VALID" if control.get("status") == "pass" else control.get("status"),
                "request_state": state, "executed": selected, "planned": planned,
                "activation_executed": bool(active), "activation_planned": bool(active_plan),
                "real_browser_success_cases": [e["id"] for e in active if e["surface"] == "real_browser"],
                "effect_evidence": effect, "notes": notes,
                "conditional_branch_evidence": conditional_branch_evidence,
                "reference_save_evidence": management if key == "reference_name" else [],
                "consumer_evidence": ["webui/workbench_static/app.js:306-313 collectOptions",
                                      "webui/workbench_static/app.js:800-824 parameterControl",
                                      "webui/workbench_static/app.js:860-866 collectInputs",
                                      "new-model-parameter-audit.md (model-specific static consumers; not a run verdict)",
                                      "parameter-effect-evidence.json (only named measured controls)"]}
    for model in live["models"]:
        for control in model.get("controls", []):
            rows.append(build_row(model, control))
    observed_ids = {m["id"] for m in live["models"]}
    extra = []
    for model_id in sorted({p["case"].get("model") for p in plans} - observed_ids):
        if model_id not in details:
            continue
        model = {"id": model_id, "route": details[model_id].get("task")}
        for control in inferred_controls(details[model_id]):
            extra.append(build_row(model, control, False))
    missing = [r for r in rows if r["request_state"] not in
               ("SINGLE_CHOICE_DEFAULT_ONLY", "SHARED_REFERENCE_SAVE_EXECUTED", "CONFIRMED_REJECTED")
               and not r["activation_executed"] and not r["activation_planned"]]
    uploads = []
    for model_id in sorted(observed_ids | {r["model"] for r in extra}):
        detail = details.get(model_id, {})
        task = detail.get("task")
        if task not in ("asr", "vc", "processing", "separation", "analysis", "music", "tts"):
            continue
        fields = ["audio"] if task in ("asr", "vc", "processing", "separation", "analysis") else []
        if task == "tts" and detail.get("profile", {}).get("accepts_voice_reference") is not False or task == "vc" and not detail.get("profile", {}).get("model_as_target_voice"):
            fields.append("voice")
        if task == "music" and detail.get("music_inputs", {}).get("source_audio"):
            fields.append("audio")
        for key in fields:
            found = [e for e in executions if e["model"] == model_id and meaningful(e["request"].get("inputs", {}).get(key))]
            uploads.append({"model": model_id, "key": key,
                            "executed": [{"id": e["id"], "surface": e["surface"], "successful_generation": e["successful_generation"],
                                          "transport_value": e["request"]["inputs"][key], "path": e["path"]} for e in found],
                            "planned": [{"id": p["case"]["id"], "path": p["path"], "fixture": p["case"]["uploads"][key]}
                                        for p in plans if p["case"].get("model") == model_id and key in p["case"].get("uploads", {})],
                            "note": "Separate from 149 observed non-file controls. Fixture path is uploaded to a UUID; an uploaded reference is not library-selection coverage."})
    output = {"generated_at": datetime.now().astimezone().isoformat(), "status": "RUNNING_SNAPSHOT",
              "context_sha256": context_sha, "runtime": runtime,
              "scope": "149 observed common controls, metadata-derived new controls, required file inputs, and 444 expert inventory kept separate",
              "boundaries": ["Editing alone is INTERACTION_ONLY; queued cases never pass.",
                             "EXECUTED_REQUEST means a successful generation received the explicit field; it does not prove acoustic effect or every C++ consumer.",
                             "Expected errors/cancellation and real failures are not successful consumption.",
                             "CLI raw and old/missing-runtime records are excluded from UI coverage.",
                             "Blank/default-only values do not activate a feature. Bool false is disabled coverage.",
                             "Only common controls observed by DOM count in the 149 denominator. Advanced 444 are inventory, not tested-option claims.",
                             "Browser time is after current restart, but browser JSON has no executable SHA; HTTP records carry context SHA."],
              "sources": list(plan_sources), "summary": {"observed_models": len(live["models"]),
                  "common_controls": len(rows), "edited": sum(r["interaction_state"] == "EDITED_VALID" for r in rows),
                  "single_choice": sum(r["request_state"] == "SINGLE_CHOICE_DEFAULT_ONLY" for r in rows),
                  "request_states": dict(Counter(r["request_state"] for r in rows)),
                  "metadata_derived_extra_controls": len(extra), "expert_inventory_only": len(expert),
                  "missing_activation_in_execution_and_plan": len(missing)},
              "controls": rows, "metadata_derived_new_controls": extra, "file_inputs": uploads,
              "expert_inventory_only": expert, "missing_activation_in_execution_and_plan": missing,
              "excluded_records": excluded,
              "shared_actions": {"readonly_interactions": live.get("interactions", []),
                  "readonly_navigation": live.get("navigation", []),
                  "reference_save": management,
                  "evidence": ["ui-management/management.json (original clipboard CRLF false failure retained)",
                      "ui-management-settings-retest/management.json (21 checks corrected retest)",
                      "ui-management-unicode/management.json (17 real CRUD/Unicode playback checks)",
                      "busy-ui/busy-ui.json (37 pass +1 not applicable; independent browser observing root job)",
                      "live-execution/*/execution.json (real generated results, text actions, audio playback, downloads)",
                      "reference-asr-plan.json (pending recording/transcription; virtual MediaRecorder is not physical microphone)"]}}
    (base / "common-control-coverage.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = ["# 常用控件→真实请求/计划覆盖矩阵", "", f"快照：{output['generated_at']}。测试继续中；再次运行本脚本可更新，不启动推理。", "",
             "149个已观察常用控件分母：46模型、143个实际编辑有效、6个仅模型默认的单选语言。444个高级控件只做清点，另列元数据推导的新模型控件及文件上传，均不混入149。", "",
             "EXECUTED_REQUEST仅表示真实成功任务收到显式字段；参数消费者须结合源码，声学实效须独立对照。HTTP直传值不代表浏览器能选到该值。INTERACTION_ONLY没有成功生成消费；PLANNED尚未执行；预期错误/取消不算生成。原失败和旧runtime不会被替代用例抹去。", "",
             "| 请求覆盖状态 | 行数 |", "|---|---:|"]
    lines.extend(f"| {k} | {v} |" for k, v in output["summary"]["request_states"].items())
    lines += ["", "复跑命令：`rtk proxy .\\venv\\Scripts\\python.exe -X utf8 tools/qa/report_common_controls.py`。JSON保存完整值、逐case绝对路径、metadata/profile、来源和限制。", "",
              "## 已观察149项逐行映射", "", "| 模型/控件 | 字段 | 交互 | 请求状态 | 成功请求值/代表case | 计划case | 实效与限制 |", "|---|---|---|---|---|---|---|"]
    def row_line(r):
        good = [e for e in r["executed"] if e["successful_generation"]]
        actual = "; ".join(f"{e['id']}={short(e['value'])}" for e in good[:3]) or (
            "失败/负例: " + ", ".join(e["id"] for e in r["executed"][:3]) if r["executed"] else "无")
        planned = ", ".join(p["id"] for p in r["planned"][:3]) or "无"
        notes = " ".join(r["notes"])
        if r["effect_evidence"] != "NOT_INDEPENDENTLY_MEASURED":
            notes = r["effect_evidence"] + " " + notes
        return "| " + " | ".join(cell(v) for v in (f"{r['model']} / {r['key']}", r["field"], r["interaction_state"], r["request_state"], actual, planned, notes or "未独立量化实效")) + " |"
    lines.extend(row_line(r) for r in rows)
    lines += ["", "## 新模型元数据推导常用控件（另计，未作为真实DOM通过）", "", "| 模型/控件 | 字段 | 交互 | 请求状态 | 成功请求值/代表case | 计划case | 实效与限制 |", "|---|---|---|---|---|---|---|"]
    lines.extend(row_line(r) for r in extra)
    lines += ["", "## 尚未激活且既定清单也未计划的逐模型控件", "", "下列只表示逐模型缺口；相同共用适配器已有其他模型实跑时，可作为共用逻辑代表证据，不能改成该模型已跑。", ""]
    lines.extend(f"- `{r['model']} / {r['field']}`：{r['request_state']}。" for r in missing)
    lines += ["", "## 文件与动作边界", "", "- 必需源音频、参考上传/录音在JSON的file_inputs单列；真实POST中的UUID与manifest绝对fixture路径不能直接字符串比较。库选择与上传参考分别核对。",
              "- 三个VC reference_name走POST /references.body.name；共享保存/覆盖/Unicode CRUD已执行，未声称在三个VC面板分别点过保存。",
              "- 搜索/筛选/刷新/ESC/窄屏/主题/API例子复制/参考CRUD/忙时禁用均引用真实管理或只读UI证据；结果复制/导出/下载/播放须引用真实live-execution检查。",
              "- 物理麦克风尚未验证；虚拟MediaRecorder+后端转录可证明浏览器录音管道，不证明声卡与现场收音。",
              "- `new-model-parameter-audit.md`、`stream-sample-rate-audit.json`是静态消费者/原生rate证据；`parameter-effect-evidence.json`的Index间隔是独立PCM实效。", ""]
    (base / "common-control-coverage.md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps(output["summary"], ensure_ascii=False))


if __name__ == "__main__":
    main()
