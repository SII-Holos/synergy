import subprocess
import sys
from itertools import product
from pathlib import Path

import pytest


def collect(selection):
    collected = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "--collect-only",
            "-q",
            "-p",
            "no:cacheprovider",
            "test/test_matrix_docker.py",
            "-k",
            selection,
        ],
        cwd=Path(__file__).parents[1],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert collected.returncode == 0, collected.stdout + collected.stderr
    return [line.split("::")[-1] for line in collected.stdout.splitlines() if "::test_" in line]


@pytest.fixture(scope="module")
def matrix_collection():
    groups = {
        (mode, protocol, model): collect(
            f"test_synergy_long_sessions and {'not jitless' if mode == 'jit' else 'jitless'} and {protocol} and {model}"
        )
        for mode, protocol, model in product(
            ["jit", "jitless"], ["chat-completions", "responses"], ["fixture-one", "fixture-two"]
        )
    }
    return groups, collect("not test_synergy_long_sessions"), collect("")


@pytest.mark.parametrize("model", ["fixture-one", "fixture-two"])
@pytest.mark.parametrize("protocol", ["chat-completions", "responses"])
@pytest.mark.parametrize("mode", ["jit", "jitless"])
def test_long_control_selection_retains_short_and_120_round_cases_for_one_model(
    matrix_collection, model, protocol, mode
):
    groups, _, _ = matrix_collection
    selected = groups[mode, protocol, model]
    assert sorted(selected) == sorted(
        f"test_synergy_long_sessions_preserve_native_tools_and_usage[{mode}-{length}-{protocol}-{model}]"
        for length in ["short", "long"]
    )


def test_synergy_ci_partitions_every_native_control_once(matrix_collection):
    groups, ordinary, complete = matrix_collection
    assert sorted(ordinary) == sorted(
        [
            "test_native_matrix_uses_restricted_egress_and_two_independent_models[chat-completions]",
            "test_native_matrix_uses_restricted_egress_and_two_independent_models[responses]",
            "test_synergy_preserves_task_home_and_native_stopping[tool-roundtrip]",
            "test_synergy_preserves_task_home_and_native_stopping[empty-provider-stop]",
            "test_synergy_unattended_sessions_inherit_and_exclude_question",
        ]
    )
    assigned = [*ordinary, *(case for group in groups.values() for case in group)]
    assert len(assigned) == len(set(assigned)) == 21
    assert sorted(assigned) == sorted(complete)
