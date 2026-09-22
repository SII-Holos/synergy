from contextlib import nullcontext
from pathlib import Path

import pytest

from synergy_bench import engines
from synergy_bench.harnesses import PACKAGES
from synergy_bench.storage import atomic_json, read_json


@pytest.fixture
def native_commands(monkeypatch):
    calls = []

    def command(args, log=None, *, timeout=None):
        calls.append(args)
        if log is not None:
            log.write_text("native preparation fixture\n")
        if args[:3] == ["docker", "image", "inspect"]:
            return "node@sha256:" + "0" * 64 if "RepoDigests" in args[-1] else "sha256:" + "1" * 64
        if args[:2] == ["docker", "run"]:
            stage = Path(args[args.index("-v") + 1].removesuffix(":/work"))
            atomic_json(
                stage / "package-lock.json", {"lockfileVersion": 3, "packages": {"": read_json(stage / "package.json")}}
            )
            return ""
        if args[:2] == ["docker", "build"]:
            return ""
        if args[:2] == ["docker", "create"]:
            Path(args[args.index("--cidfile") + 1]).write_text("native-fixture")
            return "native-fixture"
        if args[:2] == ["docker", "cp"]:
            bundle = Path(args[-1])
            bundle.mkdir()
            (bundle / "native.txt").write_text("native fixture")
            return ""
        raise AssertionError(args)

    monkeypatch.setattr(engines, "command", command)
    monkeypatch.setattr(engines, "retry_command", command)
    monkeypatch.setattr(engines, "remove_owned_container", lambda _: None)
    monkeypatch.setattr("synergy_bench.resources.build_reservation", lambda *args, **kwargs: nullcontext())
    return calls


def test_default_deepseek_dependency_cutoff_is_frozen_and_warm_preparation_is_offline(tmp_path, native_commands):
    cache = tmp_path / "cache"
    target = engines.prepare_external("deepseek", None, cache, "linux/amd64")
    receipt = read_json(target / "receipt.json")
    assert receipt["identity"]["dependency_before"] == "2026-09-22T05:00:00Z"
    install = next(args for args in native_commands if "--package-lock-only" in args)
    assert "--before=2026-09-22T05:00:00Z" in install
    assert read_json(target / "package.json")["dependencies"] == {"@deepseek-ai/dsh": "0.1.5-rc.1"}
    count = len(native_commands)
    assert engines.prepare_external("deepseek", "0.1.5-rc.1", cache, "linux/amd64") == target
    assert len(native_commands) == count


@pytest.mark.parametrize(("kind", "version"), [("deepseek", "0.1.5-rc.2"), ("codex", None)])
def test_other_native_versions_do_not_inherit_the_deepseek_cutoff(tmp_path, native_commands, kind, version):
    target = engines.prepare_external(kind, version, tmp_path / "cache", "linux/amd64")
    assert read_json(target / "receipt.json")["identity"].get("dependency_before") is None
    install = next(args for args in native_commands if "--package-lock-only" in args)
    assert not any(arg.startswith("--before=") for arg in install)


def test_dependency_cutoff_change_cannot_reuse_a_frozen_native_bundle(tmp_path, native_commands, monkeypatch):
    cache = tmp_path / "cache"
    monkeypatch.setitem(PACKAGES["deepseek"], "dependency_before", "2026-09-22T05:00:00Z")
    first = engines.prepare_external("deepseek", None, cache, "linux/amd64")
    monkeypatch.setitem(PACKAGES["deepseek"], "dependency_before", "2026-09-22T05:01:00Z")
    second = engines.prepare_external("deepseek", None, cache, "linux/amd64")
    assert second != first
    assert read_json(first / "receipt.json")["identity"]["dependency_before"] == "2026-09-22T05:00:00Z"
    assert read_json(second / "receipt.json")["identity"]["dependency_before"] == "2026-09-22T05:01:00Z"
