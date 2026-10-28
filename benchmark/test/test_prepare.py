import json
import os
import signal
import socket
import subprocess
import sys
from contextlib import nullcontext
from pathlib import Path

import pytest

from synergy_bench.prepare import recipe_links, source_recipe
from synergy_bench.storage import atomic_json


@pytest.mark.parametrize("outcome", ["timeout", "failure", "success"])
def test_preparation_command_reaps_owned_descendants_and_retains_build_output(
    tmp_path: Path, monkeypatch, capsys, outcome
) -> None:
    from synergy_bench import prepare

    owner, inherited = socket.socketpair()
    owner.settimeout(10)
    program = tmp_path / "build.py"
    descendant = (
        "import os, signal, sys; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        "os.write(int(sys.argv[1]), b'ready'); os.close(int(sys.argv[1])); signal.pause()"
    )
    program.write_text(
        "import json, os, signal, socket, subprocess, sys\n"
        "connection = socket.socket(fileno=int(sys.argv[1]))\n"
        "if os.getpgrp() != os.getpid():\n"
        " connection.sendall(json.dumps({'owner': os.getpid(), 'isolated': False}).encode() + b'\\n')\n"
        " sys.exit(8)\n"
        "ready, notify = os.pipe()\n"
        f"child = subprocess.Popen([sys.executable, '-c', {descendant!r}, str(notify)], "
        "pass_fds=(connection.fileno(), notify), stdin=subprocess.DEVNULL, "
        "stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n"
        "os.close(notify)\n"
        "assert os.read(ready, 5) == b'ready'\n"
        "os.close(ready)\n"
        "print('layer: native compilation ready', flush=True)\n"
        "connection.sendall(json.dumps({'owner': os.getpid(), 'child': child.pid, "
        "'isolated': True}).encode() + b'\\n')\n"
        "if sys.argv[2] == 'timeout': signal.pause()\n"
        "sys.exit(7 if sys.argv[2] == 'failure' else 0)\n"
    )
    original = subprocess.Popen
    process = None
    identity = None
    isolated = False

    def launch(*args, **kwargs):
        nonlocal process, identity, isolated
        process = original(*args, pass_fds=(inherited.fileno(),), **kwargs)
        isolated = kwargs.get("start_new_session") is True
        inherited.close()
        received = b""
        while not received.endswith(b"\n"):
            part = owner.recv(1024)
            assert part, "build exited before its descendant became ready"
            received += part
        identity = json.loads(received)
        assert identity["owner"] == process.pid and identity["isolated"]
        assert identity["child"] > 0
        return process

    monkeypatch.setattr(prepare.subprocess, "Popen", launch)
    log = tmp_path / "build.log"
    try:
        with (
            pytest.raises(subprocess.TimeoutExpired)
            if outcome == "timeout"
            else pytest.raises(RuntimeError, match="failed; see")
            if outcome == "failure"
            else nullcontext()
        ):
            prepare.command([sys.executable, str(program), str(inherited.fileno()), outcome], log, timeout=0.1)
        assert process is not None and process.poll() is not None
        owner.settimeout(2)
        assert owner.recv(1) == b"", "preparation returned with an owned descendant still running"
        assert log.read_text() == "layer: native compilation ready\n"
        progress = capsys.readouterr().out
        assert "started" in progress and "finished" in progress and str(log) in progress
        assert "layer: native compilation ready" not in progress
    finally:
        if process is not None:
            try:
                if isolated:
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
            except ProcessLookupError:
                pass
            process.wait(timeout=5)
        owner.close()
        inherited.close()


def test_ci_preparation_forwards_its_budget_and_publishes_only_verified_bytes(tmp_path: Path, monkeypatch) -> None:
    from synergy_bench import ci_prepare

    source = tmp_path / "source"
    source.mkdir()
    artifact = tmp_path / "artifact"
    artifact.mkdir()
    (artifact / "payload").write_bytes(b"verified build")
    observed = []

    def build(*args, **kwargs):
        observed.append(kwargs["timeout"])
        return artifact

    def verify(stage):
        assert (stage / "payload").read_bytes() == b"verified build"
        assert not (tmp_path / "output/prepared").exists()

    monkeypatch.setattr(ci_prepare, "prepare_source", build)
    monkeypatch.setattr(ci_prepare, "verify_prepared", verify)
    target = ci_prepare.prepare(tmp_path / "output", source, timeout=900)
    assert observed == [900]
    assert (target / "payload").read_bytes() == b"verified build"


@pytest.mark.parametrize("stage", ["source", "publish"])
def test_ci_deadline_records_failures_before_and_after_docker_without_publishing(tmp_path: Path, monkeypatch, stage):
    from synergy_bench import ci_prepare

    artifact = tmp_path / "artifact"
    artifact.mkdir()
    (artifact / "payload").write_text("unpublished")

    def build(*args, **kwargs):
        assert 0 < signal.getitimer(signal.ITIMER_REAL)[0] <= 900
        if stage == "source":
            signal.raise_signal(signal.SIGALRM)
        return artifact

    def verify(*args):
        assert 0 < signal.getitimer(signal.ITIMER_REAL)[0] <= 900
        signal.raise_signal(signal.SIGALRM)

    monkeypatch.setattr(ci_prepare, "prepare_source", build)
    monkeypatch.setattr(ci_prepare, "verify_prepared", verify)
    output = tmp_path / "output"
    with pytest.raises(TimeoutError):
        ci_prepare.main(["--output", str(output), "--source", str(tmp_path), "--timeout", "900"])
    receipt = json.loads((output / "preparation.json").read_text())
    assert receipt["status"] == "failed"
    assert receipt["stage"] == stage
    assert receipt["error"] == "TimeoutError"
    assert receipt["elapsed_seconds"] >= 0
    assert set(receipt) == {"status", "stage", "timeout_seconds", "elapsed_seconds", "error"}
    assert not (output / "prepared").exists()
    assert not list(output.glob(".publish-*"))
    assert signal.getitimer(signal.ITIMER_REAL) == (0, 0)


def test_current_source_preparation_resolves_the_renamed_runtime_package(tmp_path):
    from synergy_bench.prepare import source_protocol

    atomic_json(tmp_path / "packages/local-runtime/package.json", {"name": "@ericsanchezok/synergy-local-runtime"})
    assert source_protocol(tmp_path, None) == "synergy-rollout-v1"


def test_session_export_release_uses_its_own_public_package_and_rejects_unknown_history(tmp_path):
    from synergy_bench.prepare import source_protocol

    atomic_json(tmp_path / "packages/synergy/package.json", {"name": "synergy"})
    assert source_protocol(tmp_path, "024dd683e091d9fce3d1d26b79b2e188ce636b52") == "synergy-session-v1"
    with pytest.raises(ValueError, match="Unsupported historical Synergy source"):
        source_protocol(tmp_path, "unverified-history")


@pytest.mark.parametrize(
    "name",
    [
        "external.mjs",
        "capture.mjs",
        "native-outcome.mjs",
        "session-capture.mjs",
        "session-relay.mjs",
        "session-entry.mjs",
    ],
)
def test_session_export_runtime_invalidates_when_an_executed_observer_changes(tmp_path, name):
    from synergy_bench.prepare import synergy_runtime_digest

    (tmp_path / name).write_text("first observer")
    before = synergy_runtime_digest(tmp_path, protocol="synergy-session-v1")
    (tmp_path / name).write_text("updated observer")
    assert synergy_runtime_digest(tmp_path, protocol="synergy-session-v1") != before


@pytest.mark.parametrize(
    ("kind", "version", "overrides"),
    [
        ("deepseek", None, {"@deepseek-ai/dsh-web-app": "0.1.5-rc.1"}),
        ("deepseek", "0.1.5-rc.1", {"@deepseek-ai/dsh-web-app": "0.1.5-rc.1"}),
        ("deepseek", "0.1.6", {}),
        ("codex", None, {}),
    ],
)
def test_native_preparation_pins_the_verified_deepseek_web_bundle(tmp_path, monkeypatch, kind, version, overrides):
    from synergy_bench import engines, resources
    from synergy_bench.storage import read_json

    class BeforeInstall(Exception):
        pass

    monkeypatch.setattr(resources, "build_reservation", lambda *args, **kwargs: nullcontext())
    monkeypatch.setattr(engines, "command", lambda *args, **kwargs: "node@sha256:fixture")

    def install(args, log, **kwargs):
        assert args[args.index("install") : args.index("install") + 5] == [
            "install",
            "--package-lock-only",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
        ]
        stage = Path(args[args.index("-v") + 1].removesuffix(":/work"))
        manifest = read_json(stage / "package.json")
        assert manifest.get("overrides", {}) == overrides
        assert manifest["dependencies"][engines.PACKAGES[kind]["name"]] == (
            version or engines.PACKAGES[kind]["version"]
        )
        raise BeforeInstall()

    monkeypatch.setattr(engines, "retry_command", install)
    with pytest.raises(BeforeInstall):
        engines.prepare_external(kind, version, tmp_path, "linux/amd64")


def test_recipe_resolves_public_names_without_a_benchmark_workspace(tmp_path: Path) -> None:
    atomic_json(tmp_path / "package.json", {"workspaces": {"packages": ["components/*"]}})
    atomic_json(tmp_path / "components/renamed/package.json", {"name": "@example/runtime"})
    assert recipe_links(tmp_path, {"@example/runtime": "workspace:*"}) == {"@example/runtime": "components/renamed"}
    with pytest.raises(ValueError, match="not provided"):
        recipe_links(tmp_path, {"@example/missing": "workspace:*"})


@pytest.mark.parametrize(
    ("protocol", "has_pty_builder", "native_stages"),
    [
        pytest.param("synergy-rollout-v1", True, ["native", "native_pty"], id="current-rollout"),
        pytest.param("synergy-rollout-v1", False, ["native"], id="rollout-without-pty-builder"),
        pytest.param("synergy-session-v1", False, [], id="historical-session"),
    ],
)
def test_source_recipe_prepares_native_assets_from_the_measured_source(
    tmp_path: Path, protocol: str, has_pty_builder: bool, native_stages: list[str]
) -> None:
    source = tmp_path / "source"
    atomic_json(source / "package.json", {"workspaces": {"packages": ["packages/*"]}})
    atomic_json(source / "packages/recipe/package.json", {"name": "@example/recipe"})
    builder = source / "packages/local-runtime/script/build-pty.ts"
    if has_pty_builder:
        builder.parent.mkdir(parents=True)
        builder.write_text("await Bun.write('.artifacts/pty/fixture', 'built from the measured source')\n")
    recipe = source_recipe(
        source,
        image_id="oven/bun@sha256:fixture",
        protocol=protocol,
        links=recipe_links(source, {"@example/recipe": "workspace:*"}),
    )
    stages = {
        header: body.splitlines() for header, _, body in (part.partition("\n") for part in recipe.split("FROM ")[1:])
    }
    assert list(stages)[0] == "oven/bun@sha256:fixture AS source"
    source_steps = stages["oven/bun@sha256:fixture AS source"]
    assert "RUN mkdir -p /opt/synergy/bin && cp /usr/local/bin/bun /opt/synergy/bin/bun" in source_steps
    assert (
        "RUN mkdir -p /opt/synergy/runtime/node_modules/@example && "
        "ln -s ../../../source/packages/recipe /opt/synergy/runtime/node_modules/@example/recipe" in source_steps
    )
    if not native_stages:
        assert len(stages) == 1
        assert source_steps[-1].endswith("/runtime/session-prepare.mjs")
        return

    assert source_steps[-1].endswith("/runtime/prepare.ts")
    assert stages["node:22.14.0-bullseye AS native"] == [
        "COPY --from=source /opt/synergy /opt/synergy",
        "WORKDIR /opt/synergy/source",
        "RUN /opt/synergy/bin/bun packages/local-runtime/script/build-watcher.ts --local",
    ]
    expected_final = [
        "COPY --from=native /opt/synergy/source/packages/local-runtime/.artifacts/watcher "
        "/opt/synergy/source/packages/local-runtime/.artifacts/watcher"
    ]
    if has_pty_builder:
        assert stages["rust:1.94.0-bookworm AS native_pty"] == [
            "COPY --from=source /opt/synergy /opt/synergy",
            "WORKDIR /opt/synergy/source",
            "RUN /opt/synergy/bin/bun packages/local-runtime/script/build-pty.ts",
        ]
        expected_final.append(
            "COPY --from=native_pty /opt/synergy/source/packages/local-runtime/.artifacts/pty "
            "/opt/synergy/source/packages/local-runtime/.artifacts/pty"
        )
    assert stages["source"] == expected_final
    assert len(stages) == len(native_stages) + 2


@pytest.mark.parametrize("failure", [RuntimeError("injected build failure"), KeyboardInterrupt()])
def test_preparation_failure_never_exposes_a_resumable_plan(tmp_path: Path, monkeypatch, failure) -> None:
    import yaml
    from test_config import config

    from synergy_bench import runner
    from synergy_bench.prepare import BENCHMARK
    from synergy_bench.storage import read_json

    monkeypatch.setenv("BENCH_FIXTURE_KEY", "fixture")
    path = tmp_path / "experiment.yaml"
    path.write_text(
        yaml.safe_dump(
            {
                **config(),
                "suite": str(BENCHMARK / "suites/local-24.json"),
                "output": "runs",
                "harnesses": {"A": {"source": {"path": str(tmp_path)}, "kind": "synergy"}},
            }
        )
    )
    monkeypatch.setattr(runner, "command", lambda *args, **kwargs: "fixture Docker")
    monkeypatch.setattr(
        runner,
        "inspect_host",
        lambda *args: {"disk_ready": True, "capacity": {"cpus": 8, "memory_bytes": 16 * 1024**3}},
    )

    def prepare(*args, **kwargs):
        raise failure

    monkeypatch.setattr(runner, "prepare_source", prepare)
    with pytest.raises(type(failure)):
        runner.initialize(path)
    root = next((tmp_path / "runs").iterdir())
    assert read_json(root / "preparation.json")["status"] == (
        "interrupted" if isinstance(failure, KeyboardInterrupt) else "failed"
    )
    assert read_json(root / "preparation.json")["stage"] == "source"
    assert not (root / "plan.json").exists()


def test_cleanup_rejects_an_unverified_container_identifier(tmp_path: Path, monkeypatch) -> None:
    from synergy_bench import prepare

    file = tmp_path / "container.id"
    file.write_text("another-project")
    monkeypatch.setattr(prepare, "command", lambda *args, **kwargs: pytest.fail("Unverified Docker mutation"))
    with pytest.raises(ValueError, match="Invalid owned container"):
        prepare.remove_owned_container(file)


@pytest.mark.parametrize(
    "external", ["external.mjs", "capture.mjs", "capture-plugin.mjs", "capture-pi.mjs", "native-outcome.mjs"]
)
@pytest.mark.parametrize("synergy", ["entry.ts", "deadline.mjs"])
def test_external_observer_changes_do_not_invalidate_synergy_runtime(tmp_path, external, synergy):
    from synergy_bench.prepare import synergy_runtime_digest

    (tmp_path / synergy).write_text("native Synergy entry")
    (tmp_path / external).write_text("external observer one")
    first = synergy_runtime_digest(tmp_path)
    (tmp_path / external).write_text("external observer two")
    assert synergy_runtime_digest(tmp_path) == first
    (tmp_path / synergy).write_text("changed Synergy entry")
    assert synergy_runtime_digest(tmp_path) != first
