import shutil
from pathlib import Path


# Provenance: https://github.com/SII-Holos/synergy/commit/6e58d113fc54c87550b893d79c7f7e7b502cedfc
# Local adaptation: Share the bytecode exclusion across task fixtures and retain real source-copy errors.
def copy_task_fixture(source: Path, destination: Path) -> Path:
    return shutil.copytree(source, destination, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
