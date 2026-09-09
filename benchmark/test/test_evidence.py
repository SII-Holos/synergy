import json
from pathlib import Path

from synergy_bench.evidence import collect_evidence


def test_missing_trace_is_independent_of_execution_and_reward(tmp_path: Path) -> None:
    (tmp_path / "agent").mkdir()
    (tmp_path / "agent" / "execution.json").write_text(json.dumps({"exit_code": 0, "outcome": "completed"}))
    result = collect_evidence(tmp_path, {"verifier_result": {"rewards": {"reward": 0.0}}})
    assert result["execution"]["outcome"] == "completed"
    assert result["verifier"]["rewards"] == {"reward": 0.0}
    assert result["evidence"]["complete"] is False
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
    assert "execution_invalid" in result["evidence"]["missing"]
