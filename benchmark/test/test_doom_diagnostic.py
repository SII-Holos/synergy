import hashlib
import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest

SOURCE = Path(__file__).parents[1] / "tasks/doom-frame-diagnostic-v1/make-doom-for-mips/tests/test_outputs.py"


def test_doom_diagnostic_source_matches_locked_provenance():
    from synergy_bench.catalog import tree_digest

    root = SOURCE.parents[2]
    provenance = json.loads((root / "provenance.json").read_text())
    task = root / "make-doom-for-mips"
    assert tree_digest(task) == provenance["diagnostic_digest"]
    assert hashlib.sha256(SOURCE.read_bytes()).hexdigest() == provenance["diagnostic_test_sha256"]
    for name, checksum in provenance["unchanged_files_sha256"].items():
        assert hashlib.sha256((task / name).read_bytes()).hexdigest() == checksum


def diagnostic_module(monkeypatch):
    pillow = types.ModuleType("PIL")
    pillow.Image = object()
    monkeypatch.setitem(sys.modules, "PIL", pillow)
    spec = importlib.util.spec_from_file_location("doom_diagnostic", SOURCE)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_doom_diagnostic_requires_fresh_frame_and_text_from_same_launch(tmp_path, monkeypatch):
    diagnostic = diagnostic_module(monkeypatch)
    frame = tmp_path / "frame.bmp"
    frame.write_bytes(b"stale")
    child = tmp_path / "vm.py"
    child.write_text(
        "import sys,time\n"
        "from pathlib import Path\n"
        "time.sleep(.2)\n"
        "Path(sys.argv[1]).write_bytes(b'fresh')\n"
        "print('I_InitGraphics: DOOM screen size: w x h: 320 x 200', flush=True)\n"
        "time.sleep(10)\n"
    )
    output = diagnostic.capture_vm(frame, [sys.executable, str(child), str(frame)], timeout=3)
    assert diagnostic.EXPECTED_TEXT in output
    assert frame.read_bytes() == b"fresh"


def test_doom_diagnostic_rejects_frame_without_matching_launch_text(tmp_path, monkeypatch):
    diagnostic = diagnostic_module(monkeypatch)
    frame = tmp_path / "frame.bmp"
    child = tmp_path / "vm.py"
    child.write_text("import sys\nfrom pathlib import Path\nPath(sys.argv[1]).write_bytes(b'frame')\n")
    with pytest.raises(TimeoutError, match="both frame.bmp and initialization text"):
        diagnostic.capture_vm(frame, [sys.executable, str(child), str(frame)], timeout=1)
