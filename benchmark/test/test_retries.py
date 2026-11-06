import pytest

from synergy_bench.prepare import retry_command
from synergy_bench.storage import read_json


def test_only_transient_preparation_failures_retry_and_all_attempts_remain(tmp_path, monkeypatch):
    from synergy_bench import prepare

    calls = []

    def execute(args, log, **kwargs):
        calls.append(args)
        if len(calls) < 3:
            with log.open("a") as file:
                file.write("500 Internal Server Error\n")
            raise RuntimeError("Docker unavailable")
        return "ready"

    monkeypatch.setattr(prepare, "command", execute)
    assert retry_command(["docker", "pull", "fixture"], tmp_path / "build.log", timeout=1, backoff=0) == "ready"
    records = read_json(tmp_path / "build.log.attempts.json")
    assert len(records) == 3 and records[-1]["status"] == "completed"
    assert records[0]["retryable"] is True


def test_permanent_preparation_error_is_not_retried(tmp_path, monkeypatch):
    from synergy_bench import prepare

    def execute(args, log, **kwargs):
        log.write_text("manifest unknown: invalid fixed version")
        raise RuntimeError("bad image")

    monkeypatch.setattr(prepare, "command", execute)
    with pytest.raises(RuntimeError):
        retry_command(["docker", "pull", "fixture"], tmp_path / "build.log", timeout=1, backoff=0)
    assert len(read_json(tmp_path / "build.log.attempts.json")) == 1


async def test_compose_preparation_retries_with_individual_logs_and_total_deadline(tmp_path, monkeypatch):
    from synergy_bench import process
    from synergy_bench.process import run_preparation_process

    calls = []

    async def execute(args, *, log, deadline, **kwargs):
        calls.append((log, deadline))
        log.write_text("503 service unavailable" if len(calls) < 3 else "ready")
        return 1 if len(calls) < 3 else 0

    monkeypatch.setattr(process, "run_process", execute)
    result = await run_preparation_process(
        ["docker", "compose", "build"], env={}, log=tmp_path / "build.log", deadline=10, backoff=0
    )
    assert result == 0
    assert len(calls) == 3 and len({row[0] for row in calls}) == 3
    assert calls[-1][1] <= calls[0][1]
    records = read_json(tmp_path / "build.log.attempts.json")
    assert [row["status"] for row in records] == ["failed", "failed", "completed"]
