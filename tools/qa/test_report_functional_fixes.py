"""Temp-only evidence classification regressions; no HTTP or model execution."""
import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location("report_functional_fixes", Path(__file__).with_name("report_functional_fixes.py"))
REPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REPORT)
CURRENT = {"health": {"instance_id": "current", "pid": 42, "runtime_revision": "revision"}, "server_sha256": "sha"}


class ReportTests(unittest.TestCase):
    def api(self, verdict="PASS", status="done", expect="done"):
        return {"surface": "workbench_http", "case": {"id": "one", "expect": expect, "status": "prepared_not_executed"},
                "elapsed": 1, "verdict": verdict, "job": {"status": status}, "context": CURRENT}

    def browser(self, status="pass", finished="2026-10-09T01:00:00Z"):
        return {"manifest": {"id": "one"}, "status": status, "finished": finished, "checks": [], "runtime_context": CURRENT}

    def test_actual_completed_api_overrides_stale_manifest_status(self):
        row = REPORT.api_row(self.api(), Path("one.json"), CURRENT)
        self.assertEqual("PASS", row["outcome"])
        self.assertTrue(row["context_matches_current"])

    def test_independent_negative_does_not_become_positive_pass(self):
        document = self.api(status="error", expect="error")
        document["case"]["contains"] = "Edit"
        document["job"]["message"] = "Only Edit supports instruction"
        row = REPORT.api_row(document, Path("one.json"), CURRENT)
        self.assertEqual("EXPECTED_ERROR", row["outcome"])

    def test_positive_claim_with_error_is_inconsistent(self):
        self.assertEqual("INCONSISTENT", REPORT.api_row(self.api(status="error"), Path("one.json"), CURRENT)["outcome"])

    def test_missing_error_substring_cannot_pass(self):
        document = self.api(status="error", expect="error")
        document["case"]["contains"] = "Edit"
        self.assertEqual("INCONSISTENT", REPORT.api_row(document, Path("one.json"), CURRENT)["outcome"])

    def test_completed_connection_failure_without_job_is_kept(self):
        document = self.api(verdict="FAIL")
        document.pop("job")
        self.assertEqual("FAIL", REPORT.api_row(document, Path("one.json"), CURRENT)["outcome"])

    def test_partial_api_excluded(self):
        document = self.api()
        document.pop("elapsed")
        with self.assertRaises(ValueError):
            REPORT.api_row(document, Path("one.json"), CURRENT)

    def test_browser_running_and_failure_claim(self):
        with self.assertRaises(ValueError):
            REPORT.browser_row(self.browser(finished=None), Path("one.json"), CURRENT)
        document = self.browser()
        document["checks"] = [{"name": "backfill", "status": "fail"}]
        self.assertEqual("FAIL", REPORT.browser_row(document, Path("one.json"), CURRENT)["outcome"])

    def test_context_mismatch_is_flagged(self):
        document = self.api()
        document["context"] = {"health": {"instance_id": "old"}, "server_sha256": "sha"}
        self.assertFalse(REPORT.api_row(document, Path("one.json"), CURRENT)["context_matches_current"])

    def test_optional_settle_evidence_is_preserved_without_changing_verdict(self):
        document = self.browser()
        document["settledControls"] = [{"stage": "terminal", "status": "pass", "samples": []}]
        document["settledMedia"] = [{"stage": "returned-route", "status": "pass", "samples": []}]
        row = REPORT.browser_row(document, Path("one.json"), CURRENT)
        self.assertEqual("PASS", row["outcome"])
        self.assertEqual(document["settledControls"], row["settled_controls"])
        self.assertEqual(document["settledMedia"], row["settled_media"])

    def test_utf16_ctest_body_is_parsed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ctest.log"
            path.write_text("warning from wrapper\n1/3 Test #42: model_request_math_test .... Passed 0.13 sec\n100% tests passed, 0 tests failed out of 3\n", encoding="utf-16")
            result = REPORT.log_result(path, {})
            self.assertEqual(("PASS", 3, 3), (result["status"], result["pass"], result["total"]))
            self.assertEqual(["model_request_math_test"], result["ctest_names"])

    def test_failed_unit_log_not_promoted_by_exit_text(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tests.log"
            path.write_text("exit_code=0\nRan 2 tests in 0.1s\nFAILED (failures=1)\n", encoding="utf-8")
            self.assertEqual("FAIL", REPORT.log_result(path, {})["status"])

    def test_retry_history_and_half_write_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            evidence, frozen = base / "fix", base / "old"
            for subdirectory in (evidence / "cases", frozen, evidence / "live-execution" / "first", evidence / "live-execution" / "retry"):
                subdirectory.mkdir(parents=True)
            (evidence / "current-runtime.json").write_text(json.dumps(CURRENT), encoding="utf-8")
            (frozen / "TESTING-FROZEN.json").write_text("{}", encoding="utf-8")
            (frozen / "final-validation-summary.json").write_text("{}", encoding="utf-8")
            (evidence / "cases" / "failure.json").write_text(json.dumps(self.api(verdict="FAIL")), encoding="utf-8")
            (evidence / "cases" / "partial.json").write_text('{"verdict":', encoding="utf-8")
            (evidence / "live-execution" / "first" / "execution.json").write_text(json.dumps(self.browser(status="fail")), encoding="utf-8")
            (evidence / "live-execution" / "retry" / "execution.json").write_text(json.dumps(self.browser(finished="2026-10-09T02:00:00Z")), encoding="utf-8")
            result = REPORT.snapshot(evidence, frozen)
            self.assertEqual({"FAIL": 1}, result["api_counts"])
            self.assertEqual({"FAIL": 1, "PASS": 1}, result["browser_attempt_counts"])
            self.assertEqual({"PASS": 1}, result["browser_latest_counts"])
            self.assertEqual(1, len(result["excluded_incomplete_or_invalid"]))
            self.assertEqual("IN_PROGRESS", result["state"])
            result["documents"]["parameter-posthoc.json"] = {"pairs": {
                "qwen": {"status": "PASS_CROSS_RATE_TIMELINE", "word_count": [12, 12], "max_endpoint_delta_seconds": 0.0},
                "seed": {"status": "PENDING_OR_NEED_REVIEW_EVIDENCE", "reason": "not executed"}}}
            result["documents"]["visual-review.json"] = {}
            markdown = REPORT.render(result, evidence / "report.json")
            self.assertIn("PASS_CROSS_RATE_TIMELINE", markdown)
            self.assertIn("PENDING_OR_NEED_REVIEW_EVIDENCE", markdown)
            self.assertIn("max_endpoint_delta_seconds", markdown)
            self.assertIn("visual-review.json", markdown)

    def test_frozen_write_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            frozen = Path(directory).resolve()
            with self.assertRaises(ValueError):
                REPORT.write_output(frozen / "report.md", "must not write", frozen)

    def test_wrong_task_failure_stays_fail_with_independent_corrected_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence, frozen = Path(directory) / "fix", Path(directory) / "old"
            (evidence / "cases").mkdir(parents=True)
            frozen.mkdir()
            (evidence / "current-runtime.json").write_text(json.dumps(CURRENT), encoding="utf-8")
            (frozen / "TESTING-FROZEN.json").write_text("{}", encoding="utf-8")
            (frozen / "final-validation-summary.json").write_text("{}", encoding="utf-8")
            failed = evidence / "cases/fix-api-restored-vevo2-s2s.json"
            document = self.api(verdict="FAIL")
            document["case"]["id"] = failed.stem
            document.pop("job")
            document["error"] = "HTTP400 Workbench task mismatch"
            failed.write_text(json.dumps(document), encoding="utf-8")
            corrected = self.api()
            corrected["case"]["id"] = "fix-api-restored-vevo2-s2s-processing-attempt2"
            (evidence / "cases/fix-api-restored-vevo2-s2s-processing-attempt2.json").write_text(json.dumps(corrected), encoding="utf-8")
            correction = {"cases": [{"id": corrected["case"]["id"], "regression": {"qa_correction": {
                "category": "HARNESS_MANIFEST", "original_record": str(failed),
                "original_record_sha256": hashlib.sha256(failed.read_bytes()).hexdigest()}}}]}
            (evidence / "fix-api-vevo2-s2s-processing-attempt2.json").write_text(json.dumps(correction), encoding="utf-8")
            result = REPORT.snapshot(evidence, frozen)
            self.assertEqual({"FAIL": 1, "PASS": 1}, result["api_counts"])
            self.assertEqual({"PASS": 1}, result["api_effective_counts"])
            self.assertEqual([str(failed)], [row["path"] for row in result["api_qa_case_errors"]])
            self.assertEqual("QA_CASE_ERROR", result["case_corrections"][0]["classification"])
            markdown = REPORT.render(result, evidence / "report.json")
            self.assertIn("不能称为模型推理失败", markdown)
            self.assertIn("vevo2-s2s-route-audit.md", markdown)
            self.assertIn("更正processing独立API：PASS", markdown)
            self.assertIn("新浏览器：NOT_EXECUTED", markdown)

    def root_review_fixture(self, base):
        evidence, frozen = base / "fix", base / "old"
        evidence.mkdir()
        frozen.mkdir()
        (frozen / "TESTING-FROZEN.json").write_text("{}", encoding="utf-8")
        (frozen / "final-validation-summary.json").write_text("{}", encoding="utf-8")
        documents = {"current-runtime.json": CURRENT, "integrity-audit.json": {"status": "PASS"},
                     "visual-review.json": {"status": "PASS"}, "final-idle-runtime.json": {"busy": False},
                     "parameter-posthoc.json": {"pairs": {}}}
        references = []
        for name, document in documents.items():
            path = evidence / name
            path.write_text(json.dumps(document), encoding="utf-8")
            references.append({"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        review = {"status": "FUNCTIONAL_REVIEW_COMPLETE_HUMAN_QUALITY_PENDING", "reviewed_at": "2026-10-09T01:00:00Z",
                  "reviewer": "root", "references": references, "api_effective_counts": {}, "browser_latest_counts": {},
                  "helper_groups": 0, "historical_qa_case_errors_preserved": {"api": 0, "browser": 0}}
        (evidence / "final-root-review.json").write_text(json.dumps(review), encoding="utf-8")
        return evidence, frozen

    def test_root_review_requires_final_snapshot_and_matching_references(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence, frozen = self.root_review_fixture(Path(directory))
            progress = REPORT.snapshot(evidence, frozen, "IN_PROGRESS")
            self.assertFalse(progress["root_review"]["verified"])
            self.assertNotIn(str(evidence / "final-root-review.json"), progress["source_sha256"])
            self.assertNotIn("final-root-review.json", REPORT.render(progress, evidence / "report.json"))
            final = REPORT.snapshot(evidence, frozen, "FINAL_SNAPSHOT")
            self.assertTrue(final["root_review"]["verified"])
            markdown = REPORT.render(final, evidence / "report.json")
            self.assertIn("已完成根任务功能复核", markdown)
            self.assertIn("音质仍待人工验收", markdown)
            self.assertIn("全部任务与卸载之后完成", markdown)
            self.assertIn("final-idle-runtime.json", markdown)
            self.assertNotIn("最终需复核：", markdown)
            self.assertNotIn("后续参考操作结束仍须核", markdown)

    def test_stale_root_review_reference_does_not_grant_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence, frozen = self.root_review_fixture(Path(directory))
            (evidence / "visual-review.json").write_text('{"status":"CHANGED"}', encoding="utf-8")
            report = REPORT.snapshot(evidence, frozen, "FINAL_SNAPSHOT")
            self.assertFalse(report["root_review"]["verified"])
            self.assertEqual("STALE_OR_MISSING_REFERENCES", report["root_review"]["status"])
            self.assertNotIn("已完成根任务功能复核", REPORT.render(report, evidence / "report.json"))

    def test_new_case_invalidates_root_review_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence, frozen = self.root_review_fixture(Path(directory))
            (evidence / "cases").mkdir()
            (evidence / "cases/one.json").write_text(json.dumps(self.api()), encoding="utf-8")
            report = REPORT.snapshot(evidence, frozen, "FINAL_SNAPSHOT")
            self.assertFalse(report["root_review"]["verified"])
            self.assertEqual("COUNTS_CHANGED", report["root_review"]["status"])
            self.assertNotIn("已完成根任务功能复核", REPORT.render(report, evidence / "report.json"))


if __name__ == "__main__":
    unittest.main()
