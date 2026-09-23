import pytest

from synergy_bench.report import paired_compare, report_data, write_report
from synergy_bench.storage import atomic_json


def test_sealed_prior_costs_are_referenced_without_opening_old_runs(tmp_path):
    from synergy_bench.storage import read_json

    fixture(tmp_path, [(1, 30)])
    plan = read_json(tmp_path / "plan.json")
    plan["config"]["prior_costs"] = [
        {
            "label": "sealed study",
            "sha256": "a" * 64,
            "observed_requests": 4,
            "known_tokens": 120,
            "unknown_usage_requests": 1,
        }
    ]
    atomic_json(tmp_path / "plan.json", plan)
    report = report_data(tmp_path)
    assert report["family_known_tokens"] == 150
    assert report["family_observed_requests"] == 5
    assert report["scored"][0]["known_tokens"] == 30
    assert report["prior_costs"][0]["unknown_usage_requests"] == 1


def fixture(root, rows):
    plan = {
        "version": 4,
        "result_version": 5,
        "task_timeout_seconds": 10800,
        "config": {"seed": 13, "platform": "linux/amd64"},
        "schedule": [{"harness": "a", "model": "m", "variant": "a__m", "task": "task", "repeat": 0}],
        "tasks": {"task": {"digest": "unchanged"}},
        "variants": {"a__m": {"model_profile": {"model": "m"}}},
    }
    atomic_json(root / "plan.json", plan)
    for number, (reward, tokens) in enumerate(rows, 1):
        atomic_json(
            root / f"trials/0000/attempt-{number:03d}/evidence.json",
            {
                "version": 5,
                "attempt_status": "completed",
                "execution": {"outcome": "completed"},
                "verifier": {"rewards": {"reward": reward}},
                "evidence": {"valid": True, "usage": "complete"},
                "wire_usage": {"attempts": 1, "tokens": {"total": {"known": tokens, "total": tokens, "unknown": 0}}},
            },
        )


def test_all_attempts_cost_but_first_execution_scores(tmp_path):
    fixture(tmp_path, [(0, 30), (1, 70)])
    result = report_data(tmp_path)
    assert result["attempts"] == 2
    assert result["scored"][0]["reward"] == 0
    assert result["usage"]["known_tokens"] == 100
    assert result["groups"][0]["successes"] == 0
    write_report(tmp_path, tmp_path / "report")
    assert (tmp_path / "report/index.html").exists()
    assert "全部尝试" in (tmp_path / "report/index.html").read_text()
    assert (tmp_path / "report/attempts.csv").read_text().count("\n") == 3


def test_incomplete_usage_keeps_bound_and_missing_attempts(tmp_path):
    fixture(tmp_path, [(0, 30)])
    (tmp_path / "trials/0001/attempt-001").mkdir(parents=True)
    atomic_json(
        tmp_path / "trials/0001/attempt-001/trial.json", {"task": "other", "model": "m", "harness": "a", "repeat": 0}
    )
    result = report_data(tmp_path)
    assert result["attempts"] == 2
    assert result["usage"]["total_tokens"] is None
    assert result["usage"]["known_tokens"] == 30
    assert result["usage"]["unknown_attempts"] == 1


@pytest.mark.parametrize("terminal", [False, True])
def test_completed_requests_do_not_finalize_an_active_attempt_total(tmp_path, terminal):
    from synergy_bench.storage import read_json

    fixture(tmp_path, [(1, 30)])
    attempt = tmp_path / "trials/0000/attempt-001"
    evidence = attempt / "evidence.json"
    if not terminal:
        evidence.unlink()
    atomic_json(
        attempt / "wire/request/request.json",
        {
            "id": "request",
            "protocol": "chat-completions",
            "status": "completed",
            "usage": {"prompt_tokens": 25, "completion_tokens": 5},
        },
    )
    if terminal:
        value = read_json(evidence)
        value.pop("wire_usage")
        atomic_json(evidence, value)
    report = report_data(tmp_path)
    row = report["scored"][0]
    assert row["known_tokens"] == 30
    assert row["tokens"] == (30 if terminal else None)
    assert row["usage_fields"]["input"]["total"] == (25 if terminal else None)
    assert row["usage_fields"]["input"]["known"] == 25
    assert row["unknown_requests"] == 0
    assert report["usage"]["total_tokens"] == (30 if terminal else None)


def test_clustered_pairs_expose_missing_and_refuse_inexact_token_delta():
    left = [
        {"task": str(i), "repeat": 0, "model": "same", "conditions": "same", "reward": i % 2, "tokens": 10}
        for i in range(4)
    ]
    right = [{**row, "reward": 1, "tokens": 8} for row in left[:-1]]
    right[0]["tokens"] = None
    result = paired_compare(left, right, seed=19, samples=100)
    assert result == paired_compare(left, right, seed=19, samples=100)
    assert result["pairs"] == 3
    assert len(result["missing_right"]) == 1
    assert result["token_difference"] is None
    assert result["reward_difference"]["mean"] > 0
    right[1]["model"] = "different"
    assert paired_compare(left, right, seed=19, samples=100)["pairs"] == 2


def test_report_keeps_planned_missing_denominator(tmp_path):
    from synergy_bench.storage import read_json

    fixture(tmp_path, [(1, 30)])
    plan = read_json(tmp_path / "plan.json")
    plan["schedule"].append({**plan["schedule"][0], "task": "missing"})
    atomic_json(tmp_path / "plan.json", plan)
    result = report_data(tmp_path)
    assert result["usage"]["known_tokens"] == 30
    assert len(result["scored"]) == 1
    assert result["groups"][0]["planned"] == 2
    assert result["groups"][0]["success_rate"] is None
    assert result["groups"][0]["success_bounds"] == [0.5, 1]
    assert result["groups"][0]["observed_success_rate"] == 1
    assert len(result["missing"]) == 1


def test_debug_cost_and_resource_statistics_never_change_scoring(tmp_path):
    from synergy_bench.storage import read_json

    fixture(tmp_path, [(0, 30)])
    result = read_json(tmp_path / "trials/0000/attempt-001/evidence.json")
    result["resources"] = {"peak_memory_bytes": 1024, "peak_cpu_percent": 150}
    result["stages"] = {"environment_preparation": [{"status": "completed", "wall_seconds": 4}]}
    atomic_json(tmp_path / "debug/0000/attempt-debug/evidence.json", result)
    report = report_data(tmp_path)
    assert report["usage"]["known_tokens"] == 60
    assert len(report["scored"]) == 1
    assert report["groups"][0]["all_attempts"]["peak_memory_bytes"] == 1024
    assert report["groups"][0]["all_attempts"]["stage_seconds"]["environment_preparation"]["p50"] == 4


def test_startup_failure_does_not_replace_the_first_dispatched_attempt(tmp_path):
    from synergy_bench.storage import read_json

    fixture(tmp_path, [(0, 0), (1, 70)])
    file = tmp_path / "trials/0000/attempt-001/evidence.json"
    value = read_json(file)
    value["wire_usage"] = {"attempts": 0, "tokens": {}}
    value["execution"] = {"outcome": "timed_out", "lifecycle": {"model_started_at": None, "timeout_stage": "startup"}}
    atomic_json(file, value)
    report = report_data(tmp_path)
    assert report["scored"][0]["attempt"] == "attempt-001"
    assert report["all_attempts"][0]["model_started"] is False


def test_related_runs_add_cost_without_selecting_a_better_score(tmp_path):
    from synergy_bench.report import family_report

    fixture(tmp_path / "scoring", [(0, 30)])
    fixture(tmp_path / "related", [(1, 70)])
    result = family_report(tmp_path / "scoring", [tmp_path / "related"])
    assert result["usage"]["known_tokens"] == 100
    assert result["scored"][0]["reward"] == 0
    assert result["groups"][0]["successes"] == 0
    assert result["groups"][0]["all_attempts"]["known_tokens"] == 100
    assert len(result["included_runs"]) == 2
    assert result["scoring_run"] == "scoring"


def test_missing_wire_records_do_not_report_complete_zero_bytes(tmp_path):
    fixture(tmp_path, [(1, 30)])
    row = report_data(tmp_path)["all_attempts"][0]
    assert row["wire_bytes"]["request"] == {"known": 0, "unknown_requests": 1}
    assert row["wire_bytes"]["response"] == {"known": 0, "unknown_requests": 1}


def test_incomplete_experiment_conditions_are_not_paired(tmp_path):
    fixture(tmp_path, [(1, 30)])
    rows = report_data(tmp_path)["scored"]
    compared = paired_compare(rows, rows, samples=10)
    assert compared["pairs"] == 0
    assert len(compared["unpairable_left"]) == 1
    assert len(compared["unpairable_right"]) == 1


@pytest.mark.parametrize(
    "execution,eligible",
    [
        ({"outcome": "cancelled", "interrupted": True}, False),
        ({"outcome": "cancelled"}, False),
        ({"outcome": "timeout", "interrupted": False, "timed_out": True}, True),
    ],
)
def test_cancelled_execution_keeps_first_score_and_all_cost_without_becoming_a_pair(tmp_path, execution, eligible):
    from synergy_bench.storage import read_json

    for name in ["left", "right"]:
        root = tmp_path / name
        fixture(root, [(0, 30), (1, 70)])
        plan = read_json(root / "plan.json")
        plan.update(
            concurrency=4,
            host={"docker": {"cpus": 8, "memory_bytes": 16000}, "capacity": {"cpus": 6, "memory_bytes": 12000}},
            evaluator={"python": "same"},
        )
        plan["tasks"]["task"].update(resources={"cpus": 1, "memory_bytes": 1000})
        plan["config"].update(
            startup_timeout_seconds=120,
            request_idle_timeout_seconds=None,
            cleanup_seconds=60,
            export_timeout_seconds=300,
            preparation_timeout_seconds=1800,
            resources={"reserve_cpus": 2},
        )
        atomic_json(root / "plan.json", plan)
        if name == "right":
            file = root / "trials/0000/attempt-001/evidence.json"
            value = read_json(file)
            value["execution"] = execution
            atomic_json(file, value)
    left, right = [report_data(tmp_path / name) for name in ["left", "right"]]
    compared = paired_compare(left["scored"], right["scored"], samples=10)
    assert compared["pairs"] == int(eligible)
    assert right["usage"]["known_tokens"] == 100
    assert right["scored"][0]["attempt"] == "attempt-001"
    assert right["scored"][0]["reward"] == 0
    if not eligible:
        assert compared["unpairable_right"][0]["pairing_exclusions"] == ["cancelled_execution"]
        assert len(compared["missing_right"]) == 1


@pytest.mark.parametrize(
    "change",
    [
        None,
        "concurrency",
        "docker",
        "capacity",
        "deadline",
        "task_deadline",
        "missing_deadline",
        "idle",
        "policy",
        "seed",
        "missing",
        "legacy",
    ],
)
def test_pairing_requires_matching_declared_execution_conditions(tmp_path, change):
    from synergy_bench.storage import read_json

    for name in ["left", "right"]:
        root = tmp_path / name
        fixture(root, [(1, 30)])
        plan = read_json(root / "plan.json")
        plan.update(
            concurrency=4,
            host={"docker": {"cpus": 8, "memory_bytes": 16000}, "capacity": {"cpus": 6, "memory_bytes": 12000}},
            evaluator={"python": "same"},
        )
        plan["tasks"]["task"].update(resources={"cpus": 1, "memory_bytes": 1000})
        plan["config"].update(
            startup_timeout_seconds=120,
            request_idle_timeout_seconds=None,
            cleanup_seconds=60,
            export_timeout_seconds=300,
            preparation_timeout_seconds=1800,
            resources={"reserve_cpus": 2},
        )
        if name == "right":
            if change == "concurrency":
                plan["concurrency"] = 6
            elif change in {"docker", "capacity"}:
                plan["host"][change]["memory_bytes"] += 1000
            elif change == "deadline":
                plan["config"]["startup_timeout_seconds"] = 60
            elif change == "task_deadline":
                plan["task_timeout_seconds"] = 900
            elif change == "missing_deadline":
                plan.pop("task_timeout_seconds")
            elif change == "idle":
                plan["config"]["request_idle_timeout_seconds"] = 180
            elif change == "legacy":
                plan["config"].pop("request_idle_timeout_seconds")
            elif change == "policy":
                plan["config"]["resources"]["reserve_cpus"] = 1
            elif change == "seed":
                plan["config"]["seed"] += 1
            elif change == "missing":
                plan.pop("host")
        atomic_json(root / "plan.json", plan)
    left, right = [report_data(tmp_path / name)["scored"] for name in ["left", "right"]]
    compared = paired_compare(left, right, samples=10)
    assert compared["pairs"] == (1 if change is None else 0)
    if change in {"missing", "legacy", "missing_deadline"}:
        assert len(compared["unpairable_right"]) == 1
    elif change:
        assert len(compared["missing_left"]) == len(compared["missing_right"]) == 1


def test_native_reward_can_include_auxiliary_verifier_metrics():
    from synergy_bench.report import reward_of

    assert reward_of({"verifier": {"rewards": {"reward": 1, "f2p_total": 88, "p2p": 1.0}}}) == 1
    assert reward_of({"verifier": {"rewards": {"f2p": 0.5, "p2p": 1.0}}}) is None


def test_exact_token_comparison_requires_per_request_reconciliation(tmp_path):
    from synergy_bench.storage import read_json

    fixture(tmp_path, [(1, 30)])
    file = tmp_path / "trials/0000/attempt-001/evidence.json"
    result = read_json(file)
    result["reconciliation"] = {
        "status": "mismatch",
        "fields": {field: {"status": "matched"} for field in ["input", "output", "total"]},
        "requests": {"status": "mismatch", "coverage": 1},
    }
    atomic_json(file, result)
    assert report_data(tmp_path)["scored"][0]["comparable_usage"] is False
    result["reconciliation"].update(status="matched", requests={"status": "matched", "coverage": 1})
    atomic_json(file, result)
    assert report_data(tmp_path)["scored"][0]["comparable_usage"] is True
    result["reconciliation"]["requests"] = {"status": "partial", "coverage": 0.5}
    atomic_json(file, result)
    assert report_data(tmp_path)["scored"][0]["comparable_usage"] is False
