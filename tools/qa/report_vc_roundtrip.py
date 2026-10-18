"""Read saved VC roundtrip ASR evidence; never run inference or grant audio quality."""
import argparse
import hashlib
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
import difflib

from report_tts_roundtrip import normalized_chars, english_words


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=Path("build/functional-qa-20261008/vc-roundtrip-cases.json"))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--kind", choices=("vc", "design"), default="vc")
    parser.add_argument("--review-threshold", type=float, default=.75)
    args = parser.parse_args()
    if not 0 <= args.review_threshold <= 1:
        parser.error("threshold must be between 0 and 1")
    manifest = json.loads(args.manifest.read_text(encoding="utf-8-sig"))
    rows = []
    for case in manifest["cases"]:
        source = case["quality_source"]
        row = {"source_case": source["case_id"], "source_surface": source["surface"], "model": source["model"],
               "asr_case": case["id"], "expected_text": source["expected_text"], "expected_text_policy": source["expected_text_policy"],
               "audio_sha256": source["audio_sha256"], "state": "PENDING_ASR", "char_similarity": None, "english_word_similarity": None}
        path = args.manifest.parent / "cases" / (case["id"] + ".json")
        if path.exists():
            record = json.loads(path.read_text(encoding="utf-8-sig"))
            row.update(asr_record=str(path), functional_verdict=record.get("verdict"), transcript=record.get("job", {}).get("text", ""))
            saved_source = record.get("case", {}).get("quality_source", {})
            provenance = (record.get("surface", "workbench_http") != "cli_raw"
                          and record.get("context_sha256") == manifest["context_sha256"]
                          and Path(manifest["context_path"]).is_file() and sha(Path(manifest["context_path"])) == manifest["context_sha256"]
                          and record.get("case") == case
                          and saved_source == source
                          and Path(source["case_record"]).is_file() and sha(Path(source["case_record"])) == source["case_record_sha256"]
                          and Path(source["audio_path"]).is_file() and sha(Path(source["audio_path"])) == source["audio_sha256"])
            if source.get("source_audio_path"):
                original = Path(source["source_audio_path"])
                provenance = provenance and original.is_file() and sha(original) == source["source_audio_sha256"]
            if source.get("expected_text_provenance"):
                origin = source["expected_text_provenance"]
                provenance = provenance and Path(origin["path"]).is_file() and sha(Path(origin["path"])) == origin["sha256"]
            if not provenance:
                row["state"] = "EVIDENCE_CHANGED_NEEDS_REVIEW"
            elif record.get("verdict") != "PASS" or record.get("job", {}).get("status") != "done":
                row["state"] = "ASR_EXECUTION_NEEDS_REVIEW"
            else:
                expected, actual = normalized_chars(source["expected_text"]), normalized_chars(row["transcript"])
                row["char_similarity"] = round(difflib.SequenceMatcher(None, expected, actual, autojunk=False).ratio(), 4)
                words = english_words(source["expected_text"])
                if words:
                    row["english_word_similarity"] = round(difflib.SequenceMatcher(None, words, english_words(row["transcript"]), autojunk=False).ratio(), 4)
                low = not actual or row["char_similarity"] < args.review_threshold or (row["english_word_similarity"] is not None and row["english_word_similarity"] < args.review_threshold)
                row["state"] = "LOW_TEXT_SIMILARITY_NEEDS_LISTENING" if low else "HIGH_TEXT_SIMILARITY_LISTENING_PENDING"
        rows.append(row)
    report = {"generated_at": datetime.now(timezone.utc).isoformat(), "manifest": str(args.manifest.resolve()),
              "context_sha256": manifest["context_sha256"], "review_threshold": args.review_threshold,
              "method": "NFKC/casefold Unicode letters and numbers; English word sequence similarity separately; punctuation ignored.",
              "limits": manifest["limits"] + " ASR can misrecognize; low score is NEED_REVIEW, not an acoustic FAIL; high score does not prove voice/pitch/quality.",
              "counts": dict(Counter(row["state"] for row in rows)), "sources": manifest["source_audit"], "cases": rows}
    output = args.output or args.manifest.parent / (args.kind + "-roundtrip-quality.json")
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    title = "VC" if args.kind == "vc" else "声音设计"
    limits = "失败源例不进入ASR；无词哼唱不构造预期文本。" if args.kind == "vc" else "预期文字来自实际生成请求；描述与音色符合度仍待听审。"
    lines = [f"# {title}内容往返文字筛查", "", "只读报告；文字相似度不替代音色、音高、歌声或音质验收。" + limits, "",
             "| 源case | surface | 预期文字依据 | 字符/英文词 | 状态 |", "|---|---|---|---|---|"]
    for row in rows:
        values = "/".join("-" if row[key] is None else f"{row[key]:.1%}" for key in ("char_similarity", "english_word_similarity"))
        lines.append(f"| {row['source_case']} | {row['source_surface']} | {row['expected_text_policy']} | {values} | {row['state']} |")
    lines += ["", "## 源路径对账", "", "| 源case | 状态 | 预期文字或例外 |", "|---|---|---|"]
    for row in manifest["source_audit"]:
        lines.append(f"| {row['source_case']} | {row['state']} | {row['expected_text'] or row['expected_text_policy']} |")
    output.with_suffix(".md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(output.resolve()), "selected_sources": len(rows), "counts": report["counts"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
