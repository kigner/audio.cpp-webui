#!/usr/bin/env python3
"""Read-only postvalidation of run_workbench_functional.py evidence.

No HTTP, subprocesses, models, or GPU are used. PASS means deterministic evidence
checks passed, never listening/transcription/musical-quality acceptance. Expected
errors, pending cases, blocked catalog paths, and insufficient evidence stay
separate. Only this script's JSON/Markdown reports are written.
"""
from __future__ import annotations

import argparse
import array
from collections import Counter
from datetime import datetime, timezone
import fnmatch
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import sys


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_EVIDENCE = ROOT / "build/functional-qa-20261008"
AUDIO_SUFFIXES = {".wav"}
TERMINAL = {"done", "error", "cancelled"}


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"),
                      parse_constant=lambda x: (_ for _ in ()).throw(ValueError(f"nonfinite JSON: {x}")))


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def wav_info(path):
    """Decode PCM or IEEE-float RIFF samples, independent of recorded metadata."""
    data = Path(path).read_bytes()
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("not a RIFF WAVE file")
    declared = struct.unpack_from("<I", data, 4)[0] + 8
    if declared > len(data):
        raise ValueError("truncated RIFF payload")
    pos, fmt, pcm = 12, None, None
    while pos + 8 <= declared:
        kind, length = data[pos:pos + 4], struct.unpack_from("<I", data, pos + 4)[0]
        pos += 8
        if pos + length > declared:
            raise ValueError("truncated WAV chunk")
        payload = data[pos:pos + length]
        if kind == b"fmt ":
            fmt = payload
        elif kind == b"data":
            pcm = payload
        pos += length + (length & 1)
    if fmt is None or len(fmt) < 16 or pcm is None:
        raise ValueError("WAV missing fmt/data")
    code, channels, rate, byte_rate, align, bits = struct.unpack_from("<HHIIHH", fmt)
    if code == 0xFFFE and len(fmt) >= 40:
        code = struct.unpack_from("<H", fmt, 24)[0]
    if rate <= 0 or channels <= 0 or bits not in (8, 16, 24, 32, 64):
        raise ValueError("invalid WAV sample format")
    width = bits // 8
    if align != channels * width or byte_rate != rate * align or not pcm or len(pcm) % align:
        raise ValueError("invalid/empty WAV frames or block alignment")
    if code == 3 and bits in (32, 64):
        samples = array.array("f" if bits == 32 else "d", pcm)
        if sys.byteorder != "little":
            samples.byteswap()
    elif code == 1:
        scale = 2 ** (bits - 1)
        if bits == 8:
            samples = [(x - 128) / scale for x in pcm]
        elif bits == 24:
            samples = [int.from_bytes(pcm[i:i + 3], "little", signed=True) / scale
                       for i in range(0, len(pcm), 3)]
        else:
            integers = array.array({16: "h", 32: "i", 64: "q"}[bits], pcm)
            if sys.byteorder != "little":
                integers.byteswap()
            samples = (x / scale for x in integers)
    else:
        raise ValueError(f"unsupported WAV encoding {code}/{bits}")
    peak, squares, count = 0.0, 0.0, 0
    for sample in samples:
        if not math.isfinite(sample):
            raise ValueError("nonfinite WAV samples")
        peak, squares, count = max(peak, abs(sample)), squares + sample * sample, count + 1
    frames = len(pcm) // align
    return {"sample_rate": rate, "channels": channels, "frames": frames,
            "duration": frames / rate, "peak": peak, "rms": math.sqrt(squares / count), "finite": True}


def midi_info(data):
    """Parse Standard MIDI chunks/events, including running status and VLQs."""
    if len(data) < 14 or data[:4] != b"MThd":
        raise ValueError("MIDI missing MThd")
    header_size = struct.unpack_from(">I", data, 4)[0]
    if header_size < 6 or 8 + header_size > len(data):
        raise ValueError("invalid MIDI header")
    format_id, track_count, division = struct.unpack_from(">HHH", data, 8)
    if format_id > 2 or track_count < 1 or division == 0 or (format_id == 0 and track_count != 1):
        raise ValueError("invalid MIDI format/tracks/time division")
    pos, notes, events = 8 + header_size, 0, 0

    def vlq(track, at):
        value = 0
        for _ in range(4):
            if at >= len(track):
                raise ValueError("truncated MIDI VLQ")
            byte, at = track[at], at + 1
            value = (value << 7) | (byte & 127)
            if byte < 128:
                return value, at
        raise ValueError("oversized MIDI VLQ")

    for _ in range(track_count):
        if pos + 8 > len(data) or data[pos:pos + 4] != b"MTrk":
            raise ValueError("MIDI missing declared MTrk")
        size = struct.unpack_from(">I", data, pos + 4)[0]
        pos += 8
        if pos + size > len(data):
            raise ValueError("truncated MIDI track")
        track, pos = data[pos:pos + size], pos + size
        at, running, end_track = 0, None, False
        while at < len(track):
            _, at = vlq(track, at)
            if at >= len(track):
                raise ValueError("MIDI delta with no event")
            status = track[at]
            if status >= 128:
                at += 1
            elif running is not None:
                status = running
            else:
                raise ValueError("MIDI data without running status")
            events += 1
            if status == 0xFF:
                running = None
                if at >= len(track):
                    raise ValueError("truncated MIDI meta event")
                meta, at = track[at], at + 1
                length, at = vlq(track, at)
                if at + length > len(track):
                    raise ValueError("truncated MIDI meta payload")
                if meta == 0x2F:
                    if length != 0 or at != len(track):
                        raise ValueError("invalid MIDI end-of-track")
                    end_track = True
                at += length
            elif status in (0xF0, 0xF7):
                running = None
                length, at = vlq(track, at)
                if at + length > len(track):
                    raise ValueError("truncated MIDI SysEx")
                at += length
            elif 0x80 <= status <= 0xEF:
                running = status
                length = 1 if status & 0xF0 in (0xC0, 0xD0) else 2
                if at + length > len(track) or any(x >= 128 for x in track[at:at + length]):
                    raise ValueError("invalid MIDI channel event")
                if status & 0xF0 == 0x90 and track[at + 1] > 0:
                    notes += 1
                at += length
            else:
                raise ValueError("unsupported MIDI system event")
        if not end_track:
            raise ValueError("MIDI missing end-of-track")
    if pos != len(data):
        raise ValueError("extra MIDI chunks/data")
    return {"format": format_id, "tracks": track_count, "note_on_count": notes, "events": events}


def abc_info(text):
    """Validate the ABC subset emitted by sheetsage/processing.cpp, not audio quality."""
    if not text.strip() or "\ufffd" in text or any(ord(x) < 32 and x not in "\r\n\t" for x in text):
        raise ValueError("empty/corrupt ABC text")
    fields, body, after_key = {}, [], False
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("%"):
            continue
        match = re.match(r"^([A-Za-z]):\s*(.*)$", line)
        if match:
            key, value = match.groups()
            fields.setdefault(key, []).append(value)
            after_key = after_key or key == "K"
        elif after_key:
            body.append(line.split("%", 1)[0])
        else:
            raise ValueError("ABC body before K header")
    if not all(key in fields for key in ("X", "M", "L", "K")) or not body:
        raise ValueError("ABC missing X/M/L/K or musical body")
    if any(not x.isdigit() or int(x) <= 0 for x in fields["X"]):
        raise ValueError("invalid ABC X header")
    for key in ("M", "L"):
        for value in fields[key]:
            if key == "M" and value in ("C", "C|", "none"):
                continue
            match = re.fullmatch(r"([1-9]\d*)/([1-9]\d*)", value)
            if not match:
                raise ValueError(f"invalid ABC {key} fraction")
    if any(not re.match(r"^(?:[A-Ga-g][#b]?(?:m(?:in)?|maj|mix|dor|phr|lyd|loc)?|none)(?:\s|$)", x)
           for x in fields["K"]):
        raise ValueError("invalid ABC key signature")
    # SheetSage2 emits notes/rests, integer durations, ties, quoted chords,
    # barlines, and inline meter/key changes. Unknown constructs need review.
    token = re.compile(r'\s+|"[^"\n]*"|\[(?:K|M|V):[^\]\n]+\]|'
                       r'(?:\^{1,2}|_{1,2}|=)?[A-Ga-gzZxX][,\x27]*(?:\d+(?:/\d*)?|/+\d*)?-?|'
                       r'\|\]|\[\||\|:|:\||\|\||[|:()]|\[[1-9][0-9,]*')
    notes, rests, unknown = 0, 0, []
    for line in body:
        at = 0
        while at < len(line):
            match = token.match(line, at)
            if not match:
                unknown.append(line[at:at + 32])
                break
            value, at = match.group(), match.end()
            if re.match(r"^(?:\^{1,2}|_{1,2}|=)?[A-Ga-g]", value):
                notes += 1
            elif re.match(r"^[zZxX]", value):
                rests += 1
            if re.search(r"(?:^|[^\d])0(?:/|$)|/0(?:[^\d]|$)", value):
                raise ValueError("zero ABC note duration")
    if notes + rests == 0 and not unknown:
        raise ValueError("ABC has no musical events")
    return {"note_count": notes, "rest_count": rests, "unknown_constructs": unknown,
            "parser_scope": "SheetSage2 generated ABC subset"}


class Checks:
    def __init__(self):
        self.items = []

    def add(self, name, ok, detail=None):
        self.items.append({"name": name, "status": "PASS" if ok else "FAIL", "detail": detail})

    def review(self, name, detail):
        self.items.append({"name": name, "status": "NEED_REVIEW", "detail": detail})

    def not_applicable(self, name, detail):
        self.items.append({"name": name, "status": "NOT_APPLICABLE", "detail": detail})


def validate_asr_stream_progress(case, record, checks):
    family = (record.get("detail") or {}).get("family") or case.get("family")
    if family == "moonshine_asr":
        source = ROOT / "src/models/moonshine_asr/session.cpp"
        if source.is_file():
            text = source.read_text(encoding="utf-8")
            policy = re.search(r"MoonshineSTTSession::streaming_policy\(\) const\s*\{(.*?)\n\}", text, re.S)
            if policy and "policy.output = runtime::StreamingOutputKind::FinalResult;" in policy.group(1):
                checks.not_applicable("asr.streaming_transcript_progress",
                                      {"family": family, "output": "FinalResult", "source": str(source),
                                       "sha256": sha256(source), "reason": "Native session buffers audio and publishes only the final transcript."})
                log = Path(record.get("backend_log") or "")
                checks.add("asr.streaming_backend_log", log.is_file() and log.stat().st_size > 0,
                           {"path": str(log), "sha256": sha256(log) if log.is_file() else None})
                return
    changes = record.get("text_changes") or []
    valid = isinstance(changes, list) and all(isinstance(x, dict) and isinstance(x.get("text"), str)
                                             and finite(x.get("elapsed")) and isinstance(x.get("status"), str) for x in changes)
    if not valid:
        checks.add("asr.streaming_text_trace_shape", False)
        return
    nonempty = []
    for item in changes:
        if item["text"] and (not nonempty or item["text"] != nonempty[-1]["text"]):
            nonempty.append(item)
    partials = [item for item in nonempty if item["status"] not in TERMINAL]
    if len(nonempty) < 2 or not partials:
        checks.review("asr.streaming_transcript_progress", "No two distinct nonempty text snapshots including a nonterminal snapshot; final text alone does not prove incremental display.")
        return
    checks.add("asr.streaming_text_time_order", all(b["elapsed"] >= a["elapsed"] for a, b in zip(changes, changes[1:])))
    checks.add("asr.streaming_transcript_progress", True, {"distinct_nonempty_snapshots": len(nonempty), "nonterminal_snapshots": len(partials),
                                                          "scope": "Sampled Workbench job text; not exhaustive native SSE events."})
    checks.add("asr.sampled_text_append_only", all(b["text"].startswith(a["text"]) for a, b in zip(nonempty, nonempty[1:])))
    final = (record.get("job") or {}).get("text", "")
    checks.add("asr.final_preserves_sampled_prefixes", all(final.startswith(item["text"]) for item in partials))
    checks.add("asr.terminal_text_snapshot", bool(changes) and changes[-1]["status"] in TERMINAL and changes[-1]["text"] == final)


def failure_category(record):
    """Categorize saved evidence; never claim a missing install is a backend bug."""
    if record.get("failure_category") or record.get("block_category"):
        return record.get("failure_category") or record["block_category"]
    job = record.get("job") or {}
    message = " ".join(str(x) for x in [job.get("message", ""), record.get("error", ""),
                                       record.get("skip_reason", "")]).lower()
    if any(x in message for x in ("unknown", "unsupported", "invalid")) and "option" in message:
        return "BACKEND_PARAMETER_FAILURE"
    if any(x in message for x in ("out of memory", "cuda error 2", "cuda out of memory", "cuda_malloc", "cudamalloc", "insufficient vram", "显存不足", "内存不足", "failed to allocate", "alloc_buffer: failed")):
        return "VRAM_RESOURCE_FAILURE"
    if any(x in message for x in ("download", "下载", "http 429", "http 403", "http 404", "huggingface")) and any(x in message for x in ("fail", "error", "missing", "失败", "未", "403", "404", "429")):
        return "DOWNLOAD_PREREQUISITE"
    detail = record.get("detail") or {}
    if detail.get("incomplete") or any(x in message for x in ("incomplete model", "missing required", "模型文件不完整")):
        return "MODEL_INCOMPLETE"
    if detail.get("installed") is False or any(x in message for x in ("not installed", "model not found", "未安装", "请先下载", "请先在音频分析页下载安装")):
        return "MODEL_NOT_INSTALLED"
    if any(x in message for x in ("fixture", "input file", "upload", "输入文件", "上传")) and any(x in message for x in ("missing", "not found", "不存在", "找不到")):
        return "INPUT_PREREQUISITE"
    if any(x in message for x in ("load failed", "failed to load", "loading model", "模型加载失败", "failed to open model")):
        return "BACKEND_LOAD_FAILURE"
    return "BACKEND_RUNTIME_FAILURE" if job.get("status") == "error" else "HARNESS_FAILURE"


def prerequisite_status(case):
    required = case.get("requires") or {}
    issues = []
    for field, value in (case.get("uploads") or {}).items():
        if not Path(value).is_file():
            issues.append({"category": "INPUT_PREREQUISITE", "field": field, "path": value})
    target = required.get("target_path")
    if required.get("download_before_case") and target:
        path = Path(target)
        weights = [p for p in path.rglob("*") if p.is_file() and p.suffix.lower() in {".gguf", ".safetensors", ".bin", ".pt"}] if path.is_dir() else []
        if not weights:
            issues.append({"category": "DOWNLOAD_PREREQUISITE", "package_id": required.get("package_id"), "target_path": target})
    return {"state": "NOT_READY" if issues else "LOCAL_FILES_PRESENT_CATALOG_NOT_RECHECKED", "issues": issues}


def check_provenance(case, record, checks):
    saved = record.get("case") or {}
    raw = record.get("surface") == "cli_raw" or saved.get("surface") == "cli_raw"
    keys = ("task", "model", "family", "mode", "request", "session_options", "spec_override", "outputs") if raw else ("task", "model", "inputs", "options", "uploads")
    for key in keys:
        if key in case and case.get(key) != saved.get(key):
            checks.review("provenance.case." + key, {"manifest": case.get(key), "saved_record": saved.get(key)})
    if not raw and case.get("action", "generate") != saved.get("action", "generate"):
        checks.review("provenance.case.action", "Current manifest action differs from the saved request")
    context = record.get("context") or {}
    path = context.get("workbench_context_path") if raw else record.get("context_path")
    expected = context.get("workbench_context_sha256") if raw else record.get("context_sha256")
    if path and expected:
        current = Path(path)
        if not current.is_file() or sha256(current) != expected:
            checks.review("provenance.runtime_context", "Runtime snapshot file is missing or its SHA256 changed after this result")
    elif not raw:
        checks.review("provenance.runtime_context", "No saved runtime context SHA256; structure is readable but current-runtime acceptance is unproved")
    if raw:
        cli = context.get("cli_exe")
        expected = context.get("cli_sha256")
        if not cli or not expected or not Path(cli).is_file() or sha256(cli) != expected:
            checks.review("provenance.cli_binary", "CLI executable is missing or differs from the saved execution hash")


def validate_spans(data, checks, name, duration=None, offset=0, require=None, rate_fallback=None):
    """Server uses samples; /alignment may additionally supply start/end seconds."""
    rate = data.get("sample_rate", rate_fallback)
    counts = {}
    for key in ("segments", "speaker_turns", "words"):
        rows = data.get(key, [])
        if key not in data and key != require:
            continue
        if not isinstance(rows, list):
            checks.add(f"{name}.{key}.array", False, type(rows).__name__)
            continue
        counts[key] = len(rows)
        checks.add(f"{name}.{key}.array", True, len(rows))
        if key == require and not rows:
            checks.review(f"{name}.{key}.nonempty", "No detections; structure alone cannot prove model quality on this input")
        previous = -1
        for index, row in enumerate(rows):
            label = f"{name}.{key}[{index}]"
            if not isinstance(row, dict):
                checks.add(label, False, "expected object")
                continue
            start, end = row.get("start_sample"), row.get("end_sample")
            valid = all(isinstance(x, int) and not isinstance(x, bool) for x in (start, end))
            valid = valid and 0 <= start <= end
            checks.add(label + ".sample_span", valid, [start, end])
            if not valid:
                continue
            checks.add(label + ".start_order", start >= previous, [previous, start])
            previous = start
            if "confidence" in row:
                checks.add(label + ".confidence_finite", finite(row["confidence"]), row["confidence"])
            if key == "words":
                checks.add(label + ".word", isinstance(row.get("word"), str) and bool(row["word"].strip()))
            elif key == "speaker_turns":
                checks.add(label + ".speaker_id", isinstance(row.get("speaker_id"), str) and bool(row["speaker_id"].strip()))
            if finite(rate) and rate > 0:
                if duration is not None:
                    checks.add(label + ".within_audio", offset + end / rate <= duration + max(.02, 1 / rate),
                               {"offset": offset, "end_seconds": end / rate, "duration": duration, "sample_rate": rate})
                for seconds_key, sample in (("start", start), ("end", end)):
                    if seconds_key in row:
                        value = row[seconds_key]
                        checks.add(label + f".{seconds_key}_consistent", finite(value) and abs(value - sample / rate) <= .002)
            else:
                checks.review(label + ".timebase", "No positive sample_rate; cannot verify seconds/range")
    return counts


def validate_details(data, checks, duration=None, require_timestamps=False):
    if not isinstance(data, list) or not data:
        checks.add("asr.details.nonempty_chunk_array", False)
        return
    checks.add("asr.details.nonempty_chunk_array", True, len(data))
    previous_offset, previous_end, spans = -1, None, 0
    for index, chunk in enumerate(data):
        name = f"asr.details[{index}]"
        if not isinstance(chunk, dict) or not isinstance(chunk.get("result"), dict):
            checks.add(name + ".shape", False, "expected offset_seconds/result")
            continue
        offset, result = chunk.get("offset_seconds"), chunk["result"]
        valid = finite(offset) and offset >= 0
        checks.add(name + ".offset", valid)
        if not valid:
            continue
        checks.add(name + ".offset_order", offset > previous_offset)
        checks.add(name + ".offset_origin_or_continuity",
                   abs(offset) <= .002 if index == 0 else previous_end is None or abs(offset - previous_end) <= .025,
                   {"offset": offset, "previous_end": previous_end})
        if duration is not None:
            checks.add(name + ".offset_within_audio", offset < duration + .002)
        checks.add(name + ".text", isinstance(result.get("text"), str) and bool(result["text"].strip()))
        chunk_ms = (result.get("timing") or {}).get("audio_duration_ms")
        chunk_duration = chunk_ms / 1000 if finite(chunk_ms) and chunk_ms > 0 else None
        if chunk_duration is not None:
            if duration is not None:
                checks.add(name + ".chunk_within_audio", offset + chunk_duration <= duration + .025)
            previous_end = offset + chunk_duration
        else:
            previous_end = None
            checks.review(name + ".chunk_duration", "Missing timing.audio_duration_ms; offset continuity cannot be proved")
        counts = validate_spans(result, checks, name, duration, offset)
        if chunk_duration is not None:
            validate_spans(result, checks, name + ".local_chunk", chunk_duration)
        spans += sum(counts.values())
        previous_offset = offset
    if require_timestamps:
        checks.add("asr.details.timestamps_present", spans > 0, spans)


def validate_cli_record(case, record, report, checks):
    """CLI results are process/artifact evidence, never invented HTTP jobs."""
    report.update(surface="cli_raw", original_verdict=record.get("verdict"),
                  functional_scope="CLI backend only; catalog discovery and HTTP/UI acceptance remain separate")
    cli = record.get("cli") or {}
    state = cli.get("status")
    report["cli_status"] = state
    if state not in {"done", "error", "timeout"}:
        report.update(status="PENDING" if record.get("verdict") != "FAIL" else "FAIL",
                      reason=record.get("error") or "No completed CLI process evidence")
        if report["status"] == "FAIL":
            report["failure_category"] = "CLI_PROCESS_EVIDENCE"
        return report
    checks.add("cli.no_http_job", not record.get("job") and not record.get("job_id"))
    checks.add("cli.case_identity", record.get("case", {}).get("id") == case["id"])
    checks.add("cli.exit_success", record.get("exit_code") == 0 and cli.get("exit_code") == 0 and state == "done",
               {"exit_code": record.get("exit_code"), "cli": cli})
    if record.get("verdict") != "PASS" or state != "done":
        category = "CLI_TIMEOUT" if record.get("timeout") else "CLI_EXECUTION_FAILURE"
        argv = (record.get("request") or {}).get("argv") or []
        for entry in record.get("evidence_files") or []:
            path = Path(entry.get("path", ""))
            if path.name == "stderr.log" and path.is_file() and sha256(path) == entry.get("sha256"):
                stderr = path.read_text(encoding="utf-8", errors="replace")
                if "--chunk-size" in argv and "unknown option: --chunk-size" in stderr:
                    category = "TEST_HARNESS_ERROR"
        report.update(status="FAIL", failure_category=category,
                      reason=record.get("error") or "CLI did not pass")
        return report
    request_path = (record.get("request") or {}).get("path")
    if request_path and Path(request_path).is_file():
        try:
            request = read_json(request_path)
            checks.add("cli.request_surface", request.get("surface") == "cli_raw")
            checks.add("cli.request_argv", request.get("argv") == record.get("request", {}).get("argv"))
            checks.add("cli.executable_hash_recorded", bool(request.get("cli_sha256")) and
                       request.get("cli_sha256") == record.get("context", {}).get("cli_sha256"))
        except (OSError, ValueError) as error:
            checks.add("cli.request_readable", False, str(error))
    else:
        checks.add("cli.request_saved", False, request_path)
    outputs = set(case.get("outputs") or record.get("case", {}).get("outputs") or [])
    decoded, texts = [], []
    for index, artifact in enumerate(record.get("artifacts") or []):
        name = f"cli.artifact[{index}]"
        path = Path(artifact.get("path", ""))
        if not path.is_file():
            checks.add(name + ".exists", False, str(path))
            continue
        checks.add(name + ".nonempty", path.stat().st_size > 0)
        checks.add(name + ".sha256", bool(artifact.get("sha256")) and sha256(path) == artifact.get("sha256"))
        try:
            if path.suffix.lower() == ".wav":
                info = wav_info(path)
                checks.add(name + ".wav_decode", True, info)
                checks.add(name + ".nonzero_energy", info["peak"] > 0)
                decoded.append(info)
            elif path.suffix.lower() == ".txt":
                text = path.read_text(encoding="utf-8-sig")
                checks.add(name + ".text_nonempty", bool(text.strip()) and "\ufffd" not in text)
                texts.append(text)
        except (ValueError, OSError, struct.error) as error:
            checks.add(name + ".decode", False, str(error))
    if "audio" in outputs:
        checks.add("cli.audio_output_present", bool(decoded))
    if "text" in outputs:
        checks.add("cli.text_output_present", bool(texts))
        checks.add("cli.text_matches_saved_file", bool(texts) and record.get("text") == texts[0])
    files = record.get("evidence_files") or []
    for required in ("request.json", "stdout.log", "stderr.log"):
        matches = [entry for entry in files if Path(entry.get("path", "")).name == required]
        checks.add("cli.evidence." + required, len(matches) == 1)
        for entry in matches:
            path = Path(entry["path"])
            checks.add("cli.evidence_hash." + required, path.is_file() and sha256(path) == entry.get("sha256"))
    report.update(status="FAIL" if any(c["status"] == "FAIL" for c in checks.items) else
                  "NEED_REVIEW" if any(c["status"] == "NEED_REVIEW" for c in checks.items) else "PASS",
                  quality_status="NEED_REVIEW", quality_note="CLI artifacts require listening/transcript review; no HTTP/UI pass is inferred")
    if report["status"] == "FAIL":
        report["failure_category"] = "CLI_OUTPUT_STRUCTURE_OR_EVIDENCE"
    return report


def validate_case(case, record_path):
    report = {"id": case["id"], "task": case.get("task"), "stage": case.get("stage"),
              "model": case.get("model"), "expected": case.get("expect", "done"),
              "record_path": str(record_path), "surface": case.get("surface", "workbench_http"),
              "checks": [], "quality_status": "NOT_ASSESSED",
              "prerequisites": prerequisite_status(case)}
    if case.get("runnable") is False or case.get("status") == "blocked":
        report.update(status="BLOCKED", failure_category="CATALOG_DISCOVERY", reason=case.get("blocked_reason", "manifest blocks execution"))
        return report
    if not record_path.exists():
        dependencies = case.get("depends_on", [])
        for ident in [dependencies] if isinstance(dependencies, str) else dependencies:
            path = record_path.with_name(ident + ".json")
            if path.is_file():
                try:
                    dependency = read_json(path)
                except (OSError, ValueError):
                    continue
                if dependency.get("verdict") in {"FAIL", "BLOCKED"}:
                    report.update(status="BLOCKED", failure_category="DEPENDENCY_BLOCKED", dependency=ident,
                                  dependency_failure_category=failure_category(dependency),
                                  reason=f"Prerequisite case {ident} did not pass; no repeated model load attempted")
                    return report
        report.update(status="PENDING", reason="No saved case result")
        if report["prerequisites"]["issues"]:
            report["pending_category"] = report["prerequisites"]["issues"][0]["category"]
        return report
    checks = Checks()
    report["checks"] = checks.items
    try:
        record = read_json(record_path)
    except (ValueError, OSError) as error:
        report.update(status="NEED_REVIEW", reason=f"Result unavailable or not an atomic complete JSON: {error}")
        return report
    if not isinstance(record, dict):
        report.update(status="FAIL", failure_category="EVIDENCE_SCHEMA", reason="Saved case record must be an object")
        return report
    if record.get("verdict") == "BLOCKED":
        report.update(status="BLOCKED", original_verdict="BLOCKED", failure_category=failure_category(record),
                      reason=record.get("skip_reason") or record.get("error") or "Saved blocked result")
        return report
    if record.get("verdict") == "PENDING":
        report.update(status="PENDING", original_verdict="PENDING", pending_category=record.get("pending_category", "DEPENDENCY_PENDING"),
                      reason=record.get("skip_reason") or "Saved pending result")
        return report
    check_provenance(case, record, checks)
    if record.get("surface") == "cli_raw" or record.get("case", {}).get("surface") == "cli_raw":
        report["record_sha256"] = sha256(record_path)
        return validate_cli_record(case, record, report, checks)
    job, expected = record.get("job") or {}, case.get("expect", "done")
    state = job.get("status")
    report.update(record_sha256=sha256(record_path), original_verdict=record.get("verdict"), job_status=state)
    if state not in TERMINAL:
        report.update(status="FAIL" if record.get("verdict") == "FAIL" else "PENDING",
                      reason=record.get("error") or "No saved terminal job state")
        if report["status"] == "FAIL":
            report["failure_category"] = failure_category(record)
        return report
    checks.add("job.expected_state", state == expected, {"expected": expected, "actual": state})
    checks.add("job.task_model", job.get("task") == case.get("task") and job.get("model") == case.get("model"))
    if case.get("contains"):
        checks.add("job.message_contains", case["contains"] in str(job.get("message", "")), case["contains"])
    if state != expected:
        report.update(status="FAIL", failure_category=failure_category(record),
                      reason=job.get("message") or record.get("error") or "Unexpected terminal job state")
        return report
    supplemental = case.get("supplemental_assertions") or {}
    if expected in {"error", "cancelled"}:
        if supplemental.get("must_fail_before_inference"):
            checks.add("negative.no_artifacts", not job.get("artifacts") and not record.get("artifacts"))
            # A final error alone cannot prove no inference happened. Only an
            # explicit request trace may supply this evidence.
            trace = record.get("backend_requests")
            if isinstance(trace, list):
                inference = [x for x in trace if isinstance(x, dict) and x.get("method") == "POST"
                             and x.get("path", "").startswith(("/v1/audio/", "/v1/tasks/"))]
                checks.add("negative.no_inference_requests", not inference, inference)
            else:
                checks.review("negative.before_inference", "Saved result has no backend request trace; verify rejection occurred before loading/inference")
        report["status"] = "FAIL" if any(x["status"] == "FAIL" for x in checks.items) else "EXPECTED_" + expected.upper()
        report["evidence_status"] = "NEED_REVIEW" if any(x["status"] == "NEED_REVIEW" for x in checks.items) else "VERIFIED"
        return report
    text = job.get("text", "")
    if supplemental.get("nonempty_text") or case.get("task") == "asr":
        checks.add("job.nonempty_text", isinstance(text, str) and bool(text.strip()))
    paths, decoded, json_artifacts = [], [], []
    artifacts = record.get("artifacts") or []
    checks.add("artifacts.saved_list", isinstance(artifacts, list))
    for index, artifact in enumerate(artifacts if isinstance(artifacts, list) else []):
        name = f"artifact[{index}]"
        if not isinstance(artifact, dict) or not artifact.get("path"):
            checks.add(name + ".path", False)
            continue
        path = Path(artifact["path"])
        checks.add(name + ".exists", path.is_file(), str(path))
        if not path.is_file():
            continue
        paths.append(path)
        checks.add(name + ".nonempty", path.stat().st_size > 0)
        if artifact.get("sha256"):
            checks.add(name + ".sha256", sha256(path) == artifact["sha256"])
        else:
            checks.review(name + ".sha256", "Original record contains no artifact hash")
        try:
            if path.suffix.lower() in AUDIO_SUFFIXES:
                audio = wav_info(path)
                decoded.append((path, audio))
                checks.add(name + ".wav_decode", True, audio)
            elif path.suffix.lower() == ".json":
                data = read_json(path)
                json_artifacts.append((path, data))
                checks.add(name + ".json_parse", True)
            elif path.suffix.lower() in {".mid", ".midi"}:
                info = midi_info(path.read_bytes())
                checks.add(name + ".midi_parse", True, info)
                if info["note_on_count"] == 0:
                    checks.review(name + ".musical_content", "Valid MIDI has no sounding notes")
            elif path.suffix.lower() == ".abc":
                info = abc_info(path.read_text(encoding="utf-8-sig"))
                checks.add(name + ".abc_parse", True, info)
                if info["unknown_constructs"]:
                    checks.review(name + ".abc_unknown_constructs", info["unknown_constructs"])
                if info["note_count"] == 0:
                    checks.review(name + ".musical_content", "ABC contains only rests; header/body validity cannot establish transcription success")
        except (ValueError, OSError, struct.error) as error:
            checks.add(name + ".decode", False, str(error))
    checks.add("artifacts.minimum_count", len(paths) >= case.get("min_artifacts", 0), len(paths))
    for suffix in supplemental.get("artifact_suffixes", []):
        checks.add("artifacts.suffix." + suffix, any(x.suffix.lower() == suffix.lower() for x in paths))
    minimum_audio = supplemental.get("minimum_audio_artifacts", 1 if case.get("task") in
                                         {"tts", "music", "design", "vc", "processing", "separation"}
                                         and case.get("action", "generate") == "generate" else 0)
    checks.add("audio.minimum_count", len(decoded) >= minimum_audio, {"actual": len(decoded), "expected": minimum_audio})
    if supplemental.get("audio_artifact") is False:
        checks.add("audio.no_unrequested_artifacts", not decoded)
    if decoded:
        if case.get("task") == "separation" or supplemental.get("allow_individual_silent_stems"):
            checks.add("separation.at_least_one_energetic_stem", any(x[1]["peak"] > 0 for x in decoded))
        else:
            checks.add("audio.nonzero_energy", all(x[1]["peak"] > 0 for x in decoded))
        for stem in supplemental.get("stems", []):
            matching = [str(p) for p, _ in decoded if re.search(r"_" + re.escape(stem) + r"\.wav$", p.name)]
            checks.add("separation.label." + stem, len(matching) == 1, matching)
        if supplemental.get("stems"):
            checks.add("separation.exact_stem_count", len(decoded) == len(supplemental["stems"]),
                       {"actual": len(decoded), "expected": len(supplemental["stems"]),
                        "label_evidence": "do_sep preserves backend stem ids in audiocpp_sep_<timestamp>_<id>.wav; browser label rendering requires UI evidence"})
        report["quality_status"] = "NEED_REVIEW"
        report["quality_note"] = "Listening, intelligibility, voice/style and musical quality are not determined by waveform structure."
    duration = None
    input_audio = (case.get("uploads") or {}).get("audio")
    if input_audio:
        try:
            duration = wav_info(Path(input_audio))["duration"]
            report["input_duration_seconds"] = duration
        except (ValueError, OSError, struct.error) as error:
            checks.review("input.duration", str(error))
    if case.get("task") == "asr":
        if (case.get("inputs") or {}).get("detailed") or supplemental.get("details_json_nonempty"):
            chunks = [(p, d) for p, d in json_artifacts if isinstance(d, list)]
            checks.add("asr.details_artifact", bool(chunks))
            for _, data in chunks:
                validate_details(data, checks, duration, supplemental.get("timestamp_spans_within_audio", False))
        if supplemental.get("speaker_labels"):
            lines = re.findall(r"\[(\d+):(\d+)-(\d+):(\d+)\]\s*(?:Speaker\s*\d+|说话人\d+)\s*[:：]\s*(.+)", str(text))
            checks.add("asr.dialogue.speaker_label_structure", bool(lines))
            for start_m, start_s, end_m, end_s, _ in lines:
                start, end = int(start_m) * 60 + int(start_s), int(end_m) * 60 + int(end_s)
                checks.add("asr.dialogue.time_range", 0 <= start <= end and (duration is None or end <= duration + 1))
        if supplemental.get("transcript_streaming_not_pcm"):
            checks.add("asr.no_pcm_stream", (record.get("stream") or {}).get("pcm_bytes", 0) == 0)
            checks.add("asr.streaming_requested", bool((record.get("request") or {}).get("inputs", {}).get("stream")))
            validate_asr_stream_progress(case, record, checks)
        report["quality_status"] = "NEED_REVIEW"
        report["quality_note"] = "Transcript correctness, speaker attribution and boundary accuracy require comparison/listening."
    if case.get("task") == "analysis":
        raw = [(p, d) for p, d in json_artifacts if isinstance(d, dict)
               and any(key in d for key in ("timing", "text", "segments", "speaker_turns", "words", "custom_schema_output", "artifacts"))]
        checks.add("analysis.raw_result_object", bool(raw))
        for path, data in raw:
            required = "segments" if supplemental.get("speech_segments") else "speaker_turns" if supplemental.get("speaker_turns") else "words" if supplemental.get("word_timestamps") else None
            if required:
                checks.add("analysis." + required + ".present", required in data)
            # do_analyze converts these speech routes to 16 kHz mono before
            # /v1/tasks/run; the generic serializer may omit sample_rate.
            validate_spans(data, checks, "analysis", duration, require=required, rate_fallback=16000)
            if supplemental.get("completion_decision"):
                custom = data.get("custom_schema_output") or {}
                decision = custom.get("data") or {}
                checks.add("turn.schema", custom.get("schema") == "smart_turn.v1")
                checks.add("turn.complete_boolean", isinstance(decision.get("complete"), bool))
                probability = decision.get("probability")
                checks.add("turn.probability", finite(probability) and 0 <= probability <= 1, probability)
            if case.get("model") == "muscriptor" and isinstance(data.get("text"), str):
                try:
                    events = json.loads(data["text"])
                    checks.add("score.event_json_nonempty", isinstance(events, list) and bool(events))
                    for event in events if isinstance(events, list) else []:
                        checks.add("score.event_shape", isinstance(event, dict) and event.get("type") in {"start", "end"})
                except ValueError as error:
                    checks.add("score.event_json_parse", False, str(error))
        if supplemental.get("nonempty_score"):
            checks.add("score.notation_artifact", any(x.suffix.lower() in {".abc", ".mid", ".midi"} for x in paths))
        report["quality_status"] = "NEED_REVIEW"
        report["quality_note"] = "Detection, alignment, turn and score accuracy cannot be inferred from schema validity."
    if case.get("action") == "analyze_source" or supplemental.get("parameter_updates_nonempty"):
        updates = job.get("parameter_updates")
        checks.add("music.parameter_updates_nonempty", isinstance(updates, dict) and bool(updates))
        if isinstance(updates, dict):
            allowed = set(supplemental.get("parameter_updates_allowed_keys", ["source_caption", "source_lyrics", "bpm", "keyscale", "timesignature"]))
            checks.add("music.parameter_updates_allowed_keys", not (set(updates) - allowed), sorted(updates))
            meaningful = []
            for key, value in updates.items():
                ok = finite(value) and value > 0 if key == "bpm" else isinstance(value, str)
                checks.add("music.parameter_update." + key, ok)
                if ok and (key == "bpm" or value.strip()):
                    meaningful.append(key)
            checks.add("music.parameter_updates_meaningful", bool(meaningful), meaningful)
        report["quality_status"] = "NEED_REVIEW"
    if case.get("stream_required"):
        stream = record.get("stream") or {}
        checks.add("audio.stream_pcm_present", stream.get("segments", 0) > 0 and stream.get("pcm_bytes", 0) > 0)
    failures = any(x["status"] == "FAIL" for x in checks.items)
    if not failures and record.get("verdict") == "FAIL":
        checks.review("harness.original_failure", record.get("error") or "Original harness failed; deterministic recheck does not replace that result")
    report["status"] = "FAIL" if failures else "NEED_REVIEW" if any(x["status"] == "NEED_REVIEW" for x in checks.items) else "PASS"
    if failures:
        report["failure_category"] = "OUTPUT_STRUCTURE_OR_EVIDENCE"
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, default=DEFAULT_EVIDENCE)
    parser.add_argument("--manifest", type=Path, action="append", help="Repeatable; defaults to cases.json + remaining-replay.json")
    parser.add_argument("--task", action="append", help="Exact Workbench task, repeatable")
    parser.add_argument("--case", action="append", help="Case id/glob, repeatable")
    parser.add_argument("--phase", action="append", help="Stage prefix, e.g. 02-asr or 07-tools")
    parser.add_argument("--output", type=Path, help="Own JSON report path (Markdown saved alongside)")
    args = parser.parse_args(argv)
    manifests = args.manifest or [args.evidence / "cases.json", args.evidence / "remaining-replay.json"]
    cases, sources = {}, []
    for path in manifests:
        if not path.exists():
            if args.manifest:
                parser.error(f"Missing manifest: {path}")
            continue
        data = read_json(path)
        sources.append({"path": str(path.resolve()), "sha256": sha256(path)})
        for case in [*data.get("cases", []), *data.get("blocked_cases", [])]:
            cases[case["id"]] = case
    if not cases:
        parser.error("No manifest cases found")
    if not args.manifest:
        # Raw compatibility probes live beside HTTP cases, but stay explicitly
        # labeled and validated through the process/artifact branch above.
        for path in (args.evidence / "cases").glob("*.json"):
            try:
                record = read_json(path)
            except (OSError, ValueError):
                continue
            if isinstance(record, dict) and record.get("surface") == "cli_raw" and isinstance(record.get("case"), dict):
                cases.setdefault(record["case"]["id"], record["case"])
    selected = [c for c in cases.values() if (not args.task or c.get("task") in args.task)
                and (not args.case or any(fnmatch.fnmatchcase(c["id"], pattern) for pattern in args.case))
                and (not args.phase or any(str(c.get("stage", "")).startswith(p) for p in args.phase))]
    results = [validate_case(case, args.evidence / "cases" / (case["id"] + ".json")) for case in selected]
    counts = dict(Counter(x["status"] for x in results))
    document = {"generated_at": datetime.now(timezone.utc).isoformat(), "scope": "Saved functional evidence only; no model execution",
                "acceptance": "INCOMPLETE" if any(x["status"] in {"PENDING", "BLOCKED", "FAIL", "NEED_REVIEW"}
                                                   or x.get("evidence_status") == "NEED_REVIEW" for x in results)
                                                   or not results else "STRUCTURAL_CHECKS_COMPLETE",
                "quality_acceptance": "NOT_GRANTED", "manifests": sources,
                "filters": {"task": args.task, "case": args.case, "phase": args.phase},
                "counts": counts, "failure_categories": dict(Counter(x["failure_category"] for x in results if x.get("failure_category"))),
                "surface_counts": {surface: dict(Counter(x["status"] for x in results if x["surface"] == surface))
                                   for surface in sorted({x["surface"] for x in results})},
                "pending_categories": dict(Counter(x["pending_category"] for x in results if x.get("pending_category"))),
                "quality_need_review_count": sum(x["quality_status"] == "NEED_REVIEW" for x in results),
                "cases": results}
    output = args.output or args.evidence / "postvalidation.json"
    protected = {path.resolve() for path in manifests}
    if output.resolve() in protected or any(output.resolve().is_relative_to((args.evidence / folder).resolve())
                                            for folder in ("cases", "artifacts", "logs", "live-execution")):
        parser.error("Output must not overwrite manifests, case results, artifacts, logs, or browser evidence")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = ["# Workbench saved-result postvalidation", "", f"Generated: {document['generated_at']}", "",
             "Deterministic structure checks only. Audio, transcript and musical quality still require review.", "",
             "Expected errors/cancellations are negative-test evidence; they are not functional passes.", "",
             f"Counts: {json.dumps(counts, ensure_ascii=False)}", "", "| Case | Status | Quality | Findings |", "|---|---|---|---|"]
    for result in results:
        findings = [x["name"] for x in result["checks"] if x["status"] != "PASS"]
        lines.append(f"| {result['id']} | {result['status']} | {result['quality_status']} | {', '.join(findings) or result.get('reason', '')} |")
    output.with_suffix(".md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output.resolve()), "counts": counts, "quality_acceptance": "NOT_GRANTED"}))
    return 1 if counts.get("FAIL") else 0


if __name__ == "__main__":
    raise SystemExit(main())
