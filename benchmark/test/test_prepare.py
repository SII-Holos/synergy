from pathlib import Path

import pytest

from synergy_bench.prepare import recipe_links
from synergy_bench.storage import atomic_json


def test_recipe_resolves_public_names_without_a_benchmark_workspace(tmp_path: Path) -> None:
    atomic_json(tmp_path / "package.json", {"workspaces": {"packages": ["components/*"]}})
    atomic_json(tmp_path / "components/renamed/package.json", {"name": "@example/runtime"})
    assert recipe_links(tmp_path, {"@example/runtime": "workspace:*"}) == {"@example/runtime": "components/renamed"}
    with pytest.raises(ValueError, match="not provided"):
        recipe_links(tmp_path, {"@example/missing": "workspace:*"})
