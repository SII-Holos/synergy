import hashlib
import os
from pathlib import Path
from unittest.mock import patch

import pytest

from synergy_bench.catalog import tree_digest
from synergy_bench.prepare import bundle_digest, verify_prepared
from synergy_bench.source import entry
from synergy_bench.storage import atomic_json, digest


def prepared(root: Path) -> Path:
    bundle = root / "bundle"
    for name in ["source/code.ts", "source/node_modules/dependency/index.js", "runtime/main.ts", "bin/bun"]:
        file = bundle / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes((name * 30).encode())
    (bundle / "source/link.ts").symlink_to("code.ts")
    files = [entry(bundle / "source", name) for name in ["code.ts", "link.ts"]]
    identity = {"source": "test"}
    atomic_json(
        root / "receipt.json",
        {
            "id": digest(identity),
            "identity": identity,
            "source": {"files": files, "digest": digest(files)},
            "runtime_digest": tree_digest(bundle / "runtime"),
            "binary_digest": tree_digest(bundle / "bin"),
            "bundle_digest": bundle_digest(bundle),
        },
    )
    return root


def test_verification_reads_each_file_once_and_rechecks_every_invocation(tmp_path):
    artifact = prepared(tmp_path)
    reads = []
    original = Path.open

    def observed(file, *args, **kwargs):
        if "bundle" in file.parts and "r" in (args[0] if args else kwargs.get("mode", "r")):
            reads.append(file)
        return original(file, *args, **kwargs)

    with patch.object(Path, "open", observed):
        verify_prepared(artifact)
        first = list(reads)
        assert len(first) == len(set(first)) == 4
        verify_prepared(artifact)
        assert reads == first + first


@pytest.mark.parametrize(
    "name", ["source/code.ts", "source/node_modules/dependency/index.js", "runtime/main.ts", "bin/bun"]
)
def test_every_content_layer_is_checked_even_with_original_mtime(tmp_path, name):
    artifact = prepared(tmp_path)
    file = artifact / "bundle" / name
    info = file.stat()
    file.write_bytes(b"!" * info.st_size)
    os.utime(file, ns=(info.st_atime_ns, info.st_mtime_ns))
    with pytest.raises(ValueError):
        verify_prepared(artifact)


def test_inventory_hashes_streamed_bytes_and_preserves_legacy_digests(tmp_path):
    from synergy_bench.inventory import Inventory

    artifact = prepared(tmp_path)
    inventory = Inventory(artifact / "bundle")
    assert inventory.tree_digest() == bundle_digest(artifact / "bundle")
    assert inventory.tree_digest("runtime", excluded={"node_modules", "__pycache__", ".git"}) == tree_digest(
        artifact / "bundle/runtime"
    )
    assert (
        inventory.files["bin/bun"]["sha256"] == hashlib.sha256((artifact / "bundle/bin/bun").read_bytes()).hexdigest()
    )


def test_excluded_directory_symlinks_preserve_the_legacy_tree_identity(tmp_path):
    from synergy_bench.inventory import Inventory

    (tmp_path / "dependency").mkdir()
    (tmp_path / "dependency/code.js").write_text("retained")
    (tmp_path / "node_modules").symlink_to("dependency", target_is_directory=True)
    inventory = Inventory(tmp_path)
    assert inventory.tree_digest(excluded={"node_modules", "__pycache__", ".git"}) == tree_digest(tmp_path)
