import json
import subprocess
import sys
from itertools import combinations, product
from pathlib import Path

import pytest
import test_matrix_docker


@pytest.fixture(scope="module")
def matrix_collection():
    script = """
import json
import pytest

class Capture:
    def pytest_collection_finish(self, session):
        print('NATIVE_MATRIX=' + json.dumps([
            {'id': item.nodeid, 'function': item.originalname,
             'params': item.callspec.params if hasattr(item, 'callspec') else {}}
            for item in session.items
        ]))

raise SystemExit(pytest.main([
    '--collect-only', '-q', '-p', 'no:cacheprovider', 'test/test_matrix_docker.py'
], plugins=[Capture()]))
"""
    collected = subprocess.run(
        [sys.executable, "-c", script],
        cwd=Path(__file__).parents[1],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert collected.returncode == 0, collected.stdout + collected.stderr
    return json.loads(
        next(
            line.removeprefix("NATIVE_MATRIX=")
            for line in collected.stdout.splitlines()
            if line.startswith("NATIVE_MATRIX=")
        )
    )


async def test_collected_native_controls_cover_each_required_behavior_once(matrix_collection, monkeypatch, tmp_path):
    calls = []

    async def capture(directory, patcher, protocol, **options):
        calls.append({"protocol": protocol, **options})

    monkeypatch.setenv("SYNERGY_BENCH_TEST_HARNESSES", "synergy")
    monkeypatch.setattr(test_matrix_docker, "run_native_matrix", capture)
    for scenario in matrix_collection:
        await getattr(test_matrix_docker, scenario["function"])(tmp_path, monkeypatch, **scenario["params"])
    assert len(calls) == len(matrix_collection)
    assert len({json.dumps(call, sort_keys=True) for call in calls}) == len(calls)

    long = [call for call in calls if call.get("tool_turns") == 120]
    semantics = [call for call in calls if call.get("tool_turns") == 4]
    homes = [call for call in calls if call.get("task_home")]
    unattended = [call for call in calls if call.get("unattended")]
    ordinary = [call for call in calls if not call.get("long_session") and not call.get("unattended")]
    assert len(long + semantics + homes + unattended + ordinary) == len(calls)
    protocols = {"chat-completions", "responses"}
    assert {(call["bun_jit"], call["protocol"]) for call in long} == set(product([False, True], protocols))
    assert all(call["long_session"] and call["models"] == ("fixture-one",) for call in long)
    assert all(call["long_session"] and len(call["models"]) == 1 for call in semantics)
    axes = [(False, True), tuple(protocols), ("fixture-one", "fixture-two")]
    rows = [(call["bun_jit"], call["protocol"], call["models"][0]) for call in semantics]
    for first, second in combinations(range(len(axes)), 2):
        assert {(row[first], row[second]) for row in rows} == set(product(axes[first], axes[second]))
    assert {call["protocol"] for call in ordinary} == protocols
    assert {call["empty_stop"] for call in homes} == {False, True}
    assert all(call["tool_turns"] == 3 and call["long_session"] for call in homes)
    assert next(call for call in homes if call["empty_stop"])["models"] == ("fixture-one",)
    assert all(call["bun_jit"] for call in unattended) and unattended
