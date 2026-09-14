import json
from pathlib import Path

import pytest

from synergy_bench.evidence import collect_evidence


def test_missing_trace_is_independent_of_execution_and_reward(tmp_path: Path) -> None:
    (tmp_path / "agent").mkdir()
    (tmp_path / "agent" / "execution.json").write_text(json.dumps({"exit_code": 0, "outcome": "completed"}))
    result = collect_evidence(tmp_path, {"verifier_result": {"rewards": {"reward": 0.0}}})
    assert result["execution"]["outcome"] == "completed"
    assert result["verifier"]["rewards"] == {"reward": 0.0}
    assert result["evidence"]["valid"] is False
    assert result["accounting"] is None


def test_evidence_preserves_raw_accounting_and_hashes(tmp_path: Path) -> None:
    agent = tmp_path / "agent"
    agent.mkdir()
    accounting = {"cost": {"status": "unavailable"}, "cacheReadTokens": 17}
    (agent / "execution.json").write_text(json.dumps({"outcome": "failed", "exit_code": 2}))
    (agent / "accounting.json").write_text(json.dumps(accounting))
    result = collect_evidence(tmp_path, {})
    assert result["accounting"] == accounting
    assert len(result["files"]["agent/accounting.json"]["sha256"]) == 64


def test_truncated_execution_does_not_discard_verifier_result(tmp_path: Path) -> None:
    (tmp_path / "agent").mkdir()
    (tmp_path / "agent/execution.json").write_text('{"exit_code":')
    result = collect_evidence(tmp_path, {"verifier_result": {"rewards": {"reward": 1.0}}})
    assert result["execution"] is None
    assert result["verifier"]["rewards"]["reward"] == 1.0
    assert "execution_invalid" in result["evidence"]["issues"]


def test_unreadable_payload_keeps_scoring_and_marks_evidence_failure(tmp_path: Path, monkeypatch) -> None:
    agent = tmp_path / "agent"
    agent.mkdir()
    payload = agent / "rollout.zip"
    payload.write_bytes(b"retained bytes")
    original = Path.open

    def opened(self, *args, **kwargs):
        if self == payload:
            raise PermissionError("injected read failure")
        return original(self, *args, **kwargs)

    monkeypatch.setattr(Path, "open", opened)
    result = collect_evidence(tmp_path, {"verifier_result": {"rewards": {"reward": 0.0}}})
    assert result["verifier"]["rewards"]["reward"] == 0.0
    assert "file_unreadable:agent/rollout.zip" in result["evidence"]["issues"]


def test_summary_reports_wrong_answers_as_task_failures_without_infrastructure_failure(tmp_path: Path) -> None:
    from synergy_bench.evidence import summarize

    attempt = tmp_path / "trials/0000/attempt-001"
    attempt.mkdir(parents=True)
    (attempt / "evidence.json").write_text(
        json.dumps(
            {
                "execution": {"outcome": "completed"},
                "verifier": {"rewards": {"reward": 0.0}},
                "evidence": {"valid": True},
            }
        )
    )
    result = summarize(tmp_path)
    assert result["task_failures"] == 1
    assert result["exit_code"] == 0


@pytest.mark.parametrize("category", ["trials", "probes"])
@pytest.mark.parametrize("recovered,possible_request", [(True, False), (False, False), (True, True)])
def test_summary_retains_startup_failures_but_distinguishes_recovery(tmp_path, category, recovered, possible_request):
    from synergy_bench.evidence import summarize
    from synergy_bench.storage import atomic_json

    first = tmp_path / category / "0000/attempt-001"
    atomic_json(
        first / "evidence.json",
        {
            "version": 3,
            "attempt_status": "completed",
            "execution": {
                "outcome": "timeout",
                "lifecycle": {"timeout_stage": "startup", "model_started_at": None},
            },
            "wire_usage": {"attempts": 0, "tokens": {}},
            "evidence": {"valid": False, "archive_valid": True, "issues": ["accounting_missing"]},
        },
    )
    if possible_request:
        atomic_json(first / "wire/torn/downstream.json", {"model": "fixture"})
    if recovered:
        atomic_json(
            tmp_path / category / "0000/attempt-002/evidence.json",
            {
                "version": 3,
                "attempt_status": "completed",
                "execution": {"outcome": "completed"},
                "wire_usage": {"attempts": 1, "tokens": {}},
                "evidence": {"valid": True},
            },
        )
    result = summarize(tmp_path)
    assert result["recording_or_infrastructure_failures"] == 1
    resolved = int(recovered and not possible_request)
    assert result["recovered_startup_failures"] == resolved
    assert result["unresolved_recording_or_infrastructure_failures"] == 1 - resolved
    assert result["exit_code"] == 1 - resolved


def test_reward_alone_does_not_claim_functional_tests_started(tmp_path):
    (tmp_path / "agent").mkdir()
    value = collect_evidence(tmp_path, {"verifier_result": {"rewards": {"reward": 1.0}}})
    assert value["grading"]["functional_tests"] == "unknown"
    assert value["grading"]["raw_rewards"] == {"reward": 1.0}


def test_junit_start_evidence_is_independent_of_native_score(tmp_path):
    (tmp_path / "agent").mkdir()
    (tmp_path / "verifier").mkdir()
    (tmp_path / "verifier/results.xml").write_text(
        '<testsuite tests="3" failures="2"><testcase name="real"/></testsuite>'
    )
    value = collect_evidence(tmp_path, {"verifier_result": {"rewards": {"reward": 0.0}}})
    assert value["grading"]["functional_tests"] == "started"
    assert value["grading"]["test_count"] == 3


def test_probe_omits_grading_without_claiming_tests_ran(tmp_path):
    value = collect_evidence(tmp_path, {}, verification_required=False)
    assert "verifier_missing" not in value["evidence"]["issues"]
    assert value["grading"]["functional_tests"] == "unknown"


def test_native_archive_hash_alone_does_not_prove_a_readable_archive(tmp_path):
    import hashlib

    from synergy_bench.storage import atomic_json

    agent = tmp_path / "agent"
    agent.mkdir()
    payload = b"not a gzip or native archive"
    (agent / "rollout.tar.gz").write_bytes(payload)
    atomic_json(agent / "execution.json", {"harness": "opencode", "outcome": "completed"})
    atomic_json(
        agent / "archive.json",
        {"valid": True, "sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload), "recording": "complete"},
    )
    result = collect_evidence(tmp_path, {})
    assert result["evidence"]["archive_valid"] is False


def test_collected_tests_and_reward_do_not_establish_execution(tmp_path):
    from synergy_bench.evidence import grading_evidence

    (tmp_path / "verifier").mkdir()
    (tmp_path / "verifier/test-stdout.txt").write_text("collected 18 items\ninternal error before execution\n")
    assert grading_evidence(tmp_path, {})["functional_tests"] == "unknown"


def test_ctrf_and_go_test_events_provide_independent_execution_evidence(tmp_path):
    from synergy_bench.evidence import grading_evidence
    from synergy_bench.storage import atomic_json

    atomic_json(
        tmp_path / "verifier/ctrf.json",
        {
            "results": {
                "tool": {"name": "fixture"},
                "tests": [
                    {"name": "a", "status": "passed"},
                    {"name": "b", "status": "failed"},
                    {"name": "c", "status": "skipped"},
                ],
            }
        },
    )
    (tmp_path / "verifier/run.log").write_text(
        '{"Action":"run","Package":"pkg","Test":"TestA"}\n{"Action":"run","Package":"pkg","Test":"TestA"}\n'
    )
    result = grading_evidence(tmp_path, {})
    assert result["functional_tests"] == "started"
    assert result["test_count"] == 2
    assert len(result["observations"]) == 2
    assert result["test_count_semantics"] == "maximum_observed_count_across_overlapping_reports"
