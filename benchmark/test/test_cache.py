import threading
import time
from types import SimpleNamespace

import pytest

from synergy_bench.cache import cache_lock, collect_cache, inspect_cache, publish
from synergy_bench.storage import atomic_json


def test_same_key_builders_wait_and_crashed_builder_releases(tmp_path):
    observed = []

    def second():
        with cache_lock(tmp_path / "key", timeout=2):
            observed.append("second")

    with cache_lock(tmp_path / "key", timeout=2):
        thread = threading.Thread(target=second)
        thread.start()
        time.sleep(0.05)
        assert observed == []
    thread.join(2)
    assert observed == ["second"]
    with pytest.raises(RuntimeError), cache_lock(tmp_path / "key", timeout=2):
        raise RuntimeError("builder exited")
    with cache_lock(tmp_path / "key", timeout=2):
        pass


def test_atomic_cache_validates_bytes_and_protects_references(tmp_path):
    stage = tmp_path / "stage"
    stage.mkdir()
    (stage / "data").write_text("immutable")
    target = publish(stage, tmp_path / "cache", {"kind": "fixture"})
    report = inspect_cache(tmp_path / "cache")
    assert report["entries"][0]["valid"] is True
    atomic_json(tmp_path / "cache/references/run.json", {"artifacts": [target.name]})
    assert collect_cache(tmp_path / "cache", budget_bytes=0)["removed"] == []
    (target / "data").write_text("corrupt")
    assert inspect_cache(tmp_path / "cache")["entries"][0]["valid"] is False


def test_gc_never_claims_shared_unknown_directories(tmp_path):
    shared = tmp_path / "cache/objects/shared"
    shared.mkdir(parents=True)
    (shared / "data").write_text("unrelated")
    assert collect_cache(tmp_path / "cache", budget_bytes=0)["removed"] == []
    assert (shared / "data").read_text() == "unrelated"


def test_active_cache_readers_block_collection_and_frozen_run_protects_objects(tmp_path):
    from synergy_bench.cache import cache_activity, reference_run

    stage = tmp_path / "stage"
    stage.mkdir()
    (stage / "file").write_text("owned")
    target = publish(stage, tmp_path / "cache", {"recipe": 1})
    with cache_activity(tmp_path / "cache"):
        with pytest.raises(ValueError, match="active"):
            collect_cache(tmp_path / "cache", budget_bytes=0, min_free_bytes=0)
        reference_run(tmp_path / "cache", tmp_path / "run", artifacts=[target.name])
    assert collect_cache(tmp_path / "cache", budget_bytes=0, min_free_bytes=0)["removed"] == []


def test_image_gc_preserves_frozen_references_and_never_removes_retagged_images(tmp_path, monkeypatch):
    from synergy_bench.cache import reference_run
    from synergy_bench.storage import digest

    identity = {"platform": "linux/amd64", "context": "frozen"}
    key = digest(identity)
    cache = tmp_path / "cache"
    atomic_json(
        cache / "images" / (key + ".json"),
        {
            "owner": "synergy-benchmark-image-v1",
            "identity": identity,
            "id": "sha256:original",
            "tag": "synergy-bench-task:" + key,
            "created_at": 1,
        },
    )
    monkeypatch.setattr("synergy_bench.cache.image_metadata", lambda tag: {"Id": "sha256:original", "Size": 100})
    removed = []
    monkeypatch.setattr("synergy_bench.cache.remove_cached_image", lambda row: removed.append(row))
    reference_run(cache, tmp_path / "run", images=[key])
    report = inspect_cache(cache)
    assert report["owned_bytes"] == 100
    assert report["entries"][0]["protected"]
    assert collect_cache(cache, budget_bytes=0, min_free_bytes=0)["removed"] == []
    assert removed == []
    monkeypatch.setattr("synergy_bench.cache.image_metadata", lambda tag: {"Id": "sha256:unrelated", "Size": 500})
    assert not inspect_cache(cache)["entries"][0]["valid"]


def test_managed_dataset_and_source_budgets_preserve_active_inputs(tmp_path):
    from synergy_bench.cache import enforce_budget, reference_run, register_directory

    cache = tmp_path / "cache"
    directory = cache / "datasets" / ("a" * 64)
    directory.mkdir(parents=True)
    (directory / "source.txt").write_bytes(b"x" * 100)
    register_directory(cache, directory, identity={"commit": "frozen"})
    assert inspect_cache(cache)["owned_bytes"] == 100
    reference_run(cache, tmp_path / "run", artifacts=[directory.name])
    with pytest.raises(ValueError, match="budget"):
        enforce_budget(cache, budget_bytes=90, min_free_bytes=0)
    assert (directory / "source.txt").exists()
    (cache / "references").rename(cache / "saved-references")
    assert enforce_budget(cache, budget_bytes=90, min_free_bytes=0)["remaining_bytes"] == 0
    assert not directory.exists()


def test_budget_check_does_not_delete_unknown_cache_or_collect_during_execution(tmp_path):
    from synergy_bench.cache import cache_activity, enforce_budget

    cache = tmp_path / "cache"
    with cache_activity(cache):
        assert enforce_budget(cache, budget_bytes=100, min_free_bytes=0)["remaining_bytes"] == 0


def test_disk_reserve_failure_preserves_frozen_inputs_and_unowned_files(tmp_path, monkeypatch):
    from synergy_bench.cache import enforce_budget, reference_run

    cache = tmp_path / "cache"
    stage = tmp_path / "stage"
    stage.mkdir()
    (stage / "data").write_text("frozen")
    frozen = publish(stage, cache, {"fixture": "protected"})
    reference_run(cache, tmp_path / "run", artifacts=[frozen.name])
    stage.mkdir()
    (stage / "data").write_text("recyclable")
    recyclable = publish(stage, cache, {"fixture": "recyclable"})
    unowned = cache / "objects" / "shared"
    unowned.mkdir()
    (unowned / "data").write_text("unrelated")
    free = [1]
    monkeypatch.setattr("synergy_bench.cache.shutil.disk_usage", lambda _: SimpleNamespace(free=free[0]))
    with pytest.raises(ValueError, match="protected inputs"):
        enforce_budget(cache, budget_bytes=1000000, min_free_bytes=20)
    assert not recyclable.exists()
    assert (frozen / "data").read_text() == "frozen"
    assert (unowned / "data").read_text() == "unrelated"
    free[0] = 20
    assert enforce_budget(cache, budget_bytes=1000000, min_free_bytes=20)["removed"] == []


def test_directory_receipt_precedes_publication_and_survives_interruption(tmp_path):
    from synergy_bench.cache import directory_entries, register_directory

    cache = tmp_path / "cache"
    stage = cache / "preparing/source"
    stage.mkdir(parents=True)
    (stage / "bundle").write_text("immutable")
    target = cache / "prepared" / ("d" * 64)
    register_directory(cache, target, identity={"source": "fixed"}, contents=stage)
    assert directory_entries(cache, verify=True)[0]["valid"] is False
    assert directory_entries(cache, verify=True)[0]["bytes"] == 0
    target.parent.mkdir()
    stage.rename(target)
    row = directory_entries(cache, verify=True)[0]
    assert row["valid"] is True
    assert row["bytes"] == len("immutable")


def test_source_build_image_counted_only_with_owned_directory_and_exact_id(tmp_path, monkeypatch):
    from synergy_bench.cache import inspect_cache, register_directory
    from synergy_bench.storage import atomic_json

    cache = tmp_path / "cache"
    source = cache / "prepared" / ("a" * 64)
    source.mkdir(parents=True)
    tag = "synergy-bench:" + source.name
    atomic_json(source / "receipt.json", {"image": tag, "image_id": "sha256:owned"})
    monkeypatch.setattr("synergy_bench.cache.image_metadata", lambda tag: {"Id": "sha256:owned", "Size": 100})
    assert inspect_cache(cache)["entries"] == []
    register_directory(cache, source, identity={"source": "fixed"})
    rows = inspect_cache(cache)["entries"]
    image = next(row for row in rows if row["kind"] == "image")
    assert image["bytes"] == 100
    assert image["valid"] and not image["protected"]
    monkeypatch.setattr("synergy_bench.cache.image_metadata", lambda tag: {"Id": "sha256:other", "Size": 999})
    image = next(row for row in inspect_cache(cache)["entries"] if row["kind"] == "image")
    assert image["bytes"] == 0 and not image["valid"]
