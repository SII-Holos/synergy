import concurrent.futures
import email.parser
import hashlib
import json
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path


def download_artifact(artifact: dict, root: Path) -> Path:
    path = root / artifact["file"]
    if path.name != artifact["file"]:
        raise ValueError("Invalid distribution filename")
    if path.exists():
        if hashlib.sha256(path.read_bytes()).hexdigest() != artifact["sha256"]:
            raise ValueError("Cached distribution checksum changed")
        return path
    for attempt in range(3):
        print(json.dumps({"download": path.name, "attempt": attempt + 1}), flush=True)
        try:
            with urllib.request.urlopen(artifact["url"], timeout=120) as response:
                data = response.read(128 * 1024**2 + 1)
            break
        except (urllib.error.URLError, TimeoutError):
            if attempt == 2:
                raise
            time.sleep(2**attempt)
    if len(data) > 128 * 1024**2 or hashlib.sha256(data).hexdigest() != artifact["sha256"]:
        raise ValueError("Downloaded distribution checksum mismatch")
    path.write_bytes(data)
    return path


def freeze_wheels(root: Path) -> None:
    packages = {}
    artifacts = []
    for path in sorted(root.glob("*.whl")):
        with zipfile.ZipFile(path) as wheel:
            names = [name for name in wheel.namelist() if name.count("/") == 1 and name.endswith(".dist-info/METADATA")]
            if len(names) != 1:
                raise ValueError("Wheel must have one distribution metadata record")
            metadata = email.parser.BytesParser().parsebytes(wheel.read(names[0]))
        name, version = metadata["Name"], metadata["Version"]
        normalized = name.lower().replace("_", "-").replace(".", "-")
        if normalized in packages:
            raise ValueError("Dependency cache contains multiple wheels for one distribution")
        packages[normalized] = version
        artifacts.append({"file": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    if not packages:
        raise ValueError("Dependency cache is empty")
    (root / "constraints.txt").write_text("".join(f"{name}=={version}\n" for name, version in sorted(packages.items())))
    (root / "manifest.json").write_text(json.dumps({"packages": packages, "wheels": artifacts}, indent=2) + "\n")


if __name__ == "__main__":
    root = Path("/opt/benchmark/wheels")
    root.mkdir(parents=True)
    downloads = Path("/opt/benchmark/distributions")
    downloads.mkdir()
    lock = json.loads(Path(__file__).with_name("wheel-sources.lock.json").read_text())
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        paths = list(pool.map(lambda row: download_artifact(row, downloads), lock["artifacts"]))
    for path in paths:
        if path.suffix == ".whl":
            shutil.copyfile(path, root / path.name)
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "wheel",
            "--no-index",
            "--no-deps",
            "--find-links",
            str(root),
            "--wheel-dir",
            str(root),
            str(downloads / "planarity-0.6.tar.gz"),
        ],
        check=True,
    )
    freeze_wheels(root)
    shutil.rmtree(downloads)
