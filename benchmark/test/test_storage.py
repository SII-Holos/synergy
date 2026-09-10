import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from synergy_bench.storage import atomic_json, locked


def test_atomic_replace_flushes_the_parent_directory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    original = os.fsync
    modes = []

    def sync(fd: int) -> None:
        modes.append(os.fstat(fd).st_mode)
        original(fd)

    monkeypatch.setattr(os, "fsync", sync)
    atomic_json(tmp_path / "record.json", {"terminal": True})
    assert any(stat.S_ISREG(mode) for mode in modes)
    assert stat.S_ISDIR(modes[-1])


def test_lock_survives_run_deletion_and_excludes_another_process(tmp_path: Path) -> None:
    root = tmp_path / "run"
    with locked(root):
        shutil.rmtree(root)
        child = subprocess.run(
            [
                sys.executable,
                "-c",
                "from pathlib import Path; from synergy_bench.storage import locked; import sys\n"
                "try:\n with locked(Path(sys.argv[1])): pass\nexcept ValueError:\n sys.exit(17)\n",
                str(root),
            ],
            capture_output=True,
            timeout=30,
        )
        assert child.returncode == 17, child.stderr
        assert not root.exists()
    with locked(root):
        assert root.is_dir()
