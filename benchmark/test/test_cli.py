from pathlib import Path

import pytest

from synergy_bench import cli
from synergy_bench.storage import atomic_json


def test_clean_uses_only_owned_attempt_records(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    run = tmp_path / "run"
    atomic_json(run / "owner.json", {"kind": "synergy-benchmark-run", "version": 1})
    records = [run / "trials/0000/attempt-001/environment.json", run / "debug/0000/attempt-debug/environment.json"]
    for record in records:
        atomic_json(record, {"project": "owned-project"})
        atomic_json(record.parent / "trial/agent/environment.json", {"images": []})
    removed = []
    monkeypatch.setattr(cli, "remove_environment", lambda root, record: removed.append(record))
    cli.clean(run)
    assert set(removed) == set(records)
    assert not run.exists()
