import asyncio
from types import SimpleNamespace

import pytest

from synergy_bench.environment import CachedDockerEnvironment
from synergy_bench.resources import Capacity, Request, ResourcePool
from synergy_bench.scheduling import PhaseResources, current_resources


def environment(tmp_path, *, keep=False):
    from pier.models.task.config import EnvironmentConfig
    from pier.models.trial.paths import TrialPaths

    (tmp_path / "Dockerfile").write_text("FROM scratch\n")
    return CachedDockerEnvironment(
        environment_dir=tmp_path,
        environment_name="admission-fixture",
        session_id="sb-admission",
        trial_paths=TrialPaths(trial_dir=tmp_path / "trial"),
        task_env_config=EnvironmentConfig(cpus=1, memory_mb=2048),
        benchmark_cache=str(tmp_path / "cache"),
        benchmark_platform="linux/amd64",
        keep_containers=keep,
    )


async def test_build_wait_records_its_resource_pressure_before_cancellation(tmp_path, monkeypatch):
    from unittest.mock import AsyncMock

    from synergy_bench.storage import read_json

    env = environment(tmp_path)
    pool = ResourcePool(Capacity(2, 8 * 1024**3), 2)
    phases = PhaseResources(pool, tmp_path / "run")
    pressure = asyncio.Event()
    record = phases.record

    def observe(event, project, **fields):
        record(event, project, **fields)
        if event == "pressure":
            pressure.set()

    monkeypatch.setattr(phases, "record", observe)
    monkeypatch.setattr(env, "_image_id", AsyncMock(return_value=None))
    compose = AsyncMock(side_effect=AssertionError("build must wait for its reservation"))
    monkeypatch.setattr(env, "_compose_command", compose)
    token = current_resources.set(phases)
    try:
        async with pool.reserve(Request(0.45, 1024), adaptive=True) as owner:
            await owner.sample(1024, 1.02)
            pending = asyncio.create_task(env._run_docker_compose_command(["build"]))
            try:
                await asyncio.wait_for(pressure.wait(), 2)
                events = read_json(phases.directory / "scheduling.json")["events"]
                assert any(
                    event["event"] == "pressure"
                    and event["project"] == env.session_id
                    and event["phase"] == "preparation"
                    and event["reason"] == "cpu_budget"
                    for event in events
                )
                compose.assert_not_awaited()
            finally:
                pending.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await pending
        async with pool.reserve(Request(2, 8 * 1024**3)):
            assert pool.active == 1
    finally:
        current_resources.reset(token)


async def test_compose_reserves_real_networks_before_starting_and_keeps_up_options(tmp_path, monkeypatch):
    env = environment(tmp_path)
    pool = ResourcePool(Capacity(2, 4 * 1024**3), 2)
    phases = PhaseResources(pool, tmp_path)
    commands = []

    async def compose(args, **kwargs):
        assert pool.active == int(args[0] != "pull")
        commands.append(args)
        return SimpleNamespace(return_code=0, stdout="", stderr="")

    monkeypatch.setattr(env, "_compose_command", compose)
    token = current_resources.set(phases)
    try:
        await env._run_docker_compose_command(["up", "--detach", "--wait", "--force-recreate"])
        assert commands == [
            ["pull", "--ignore-buildable", "--policy", "missing"],
            ["create", "--no-build", "--pull", "never"],
            ["up", "--detach", "--wait", "--force-recreate"],
        ]
    finally:
        await phases.finish(resources_removed=True)
        current_resources.reset(token)


@pytest.mark.parametrize("keep", [False, True])
async def test_partial_network_exhaustion_cleans_only_its_project_or_retains_debug(tmp_path, monkeypatch, keep):
    from synergy_bench import environment as module

    env = environment(tmp_path, keep=keep)
    pool = ResourcePool(Capacity(2, 4 * 1024**3), 2, pressure_timeout_seconds=0.1)
    phases = PhaseResources(pool, tmp_path)
    commands = []
    inspected = []

    async def compose(args, **kwargs):
        commands.append(args)
        return SimpleNamespace(
            return_code=int(args[0] == "create" and len(commands) == 2),
            stdout="all predefined address pools have been fully subnetted",
            stderr="",
        )

    def inspect(args, **kwargs):
        inspected.append(args)
        assert "label=com.docker.compose.project=sb-admission" in args
        return ""

    monkeypatch.setattr(env, "_compose_command", compose)
    monkeypatch.setattr(module, "command", inspect)
    token = current_resources.set(phases)
    try:
        if keep:
            with pytest.raises(RuntimeError, match="retained"):
                await env._run_docker_compose_command(["up", "--detach", "--wait"])
            assert len(commands) == 2
            assert not inspected
            assert pool.active == 1
        else:
            await env._run_docker_compose_command(["up", "--detach", "--wait"])
            assert [args[0] for args in commands] == ["pull", "create", "down", "create", "up"]
            assert commands[2] == ["down", "--volumes", "--remove-orphans"]
            assert len(inspected) == 3
            assert any(row.get("reason") == "network_address_pressure" for row in phases.events)
    finally:
        await phases.finish(resources_removed=True)
        current_resources.reset(token)


@pytest.mark.parametrize("failure", ["unknown", "cancelled", "cleanup", "cancelled-cleanup"])
async def test_failed_creation_does_not_start_and_never_releases_unverified_resources(tmp_path, monkeypatch, failure):
    from synergy_bench import environment as module

    env = environment(tmp_path)
    phases = PhaseResources(ResourcePool(Capacity(2, 4 * 1024**3), 2), tmp_path)
    commands = []

    async def compose(args, **kwargs):
        commands.append(args[0])
        if args[0] == "create" and failure.startswith("cancelled"):
            raise asyncio.CancelledError()
        return SimpleNamespace(return_code=int(args[0] == "create"), stdout="invalid daemon response", stderr="")

    monkeypatch.setattr(env, "_compose_command", compose)
    monkeypatch.setattr(
        module, "command", lambda *args, **kwargs: "owned-network" if failure.endswith("cleanup") else ""
    )
    token = current_resources.set(phases)
    try:
        with pytest.raises(asyncio.CancelledError if failure.startswith("cancelled") else RuntimeError) as caught:
            await env._run_docker_compose_command(["up", "--detach", "--wait"])
        if failure == "cancelled-cleanup":
            assert isinstance(caught.value.__cause__, RuntimeError)
            assert "retaining scheduler reservation" in str(caught.value.__cause__)
        assert commands == ["pull", "create", "down"]
        assert phases.pool.active == int(failure.endswith("cleanup"))
    finally:
        await phases.finish(resources_removed=True)
        current_resources.reset(token)


@pytest.mark.parametrize("docker_gib", [64, 8])
def test_idle_docker_vm_is_not_charged_for_unrelated_host_memory(tmp_path, monkeypatch, docker_gib):
    from synergy_bench import resources
    from synergy_bench.config import Resources

    gib = 1024**3
    monkeypatch.setattr(resources.psutil, "virtual_memory", lambda: SimpleNamespace(total=64 * gib, available=48 * gib))
    monkeypatch.setattr(resources, "host_limits", lambda cpus, total, available: (cpus, total, available))
    pressure = resources.HostPressure(tmp_path, Resources(min_free_disk_gib=0))
    ResourcePool(Capacity(4, (docker_gib - 2) * gib), 1).validate(Request(0.25, gib))
    pressure.previous = (resources.time.monotonic(), 1, 1)
    pressure.cpu_ready = True
    assert pressure(Request(0.25, gib)), pressure.reason


@pytest.mark.parametrize("observed,admitted", [(100, True), (400, False)])
async def test_daemon_budget_counts_other_containers_and_owned_working_set_once(tmp_path, observed, admitted):
    import time
    from unittest.mock import AsyncMock

    from synergy_bench.docker_resources import DockerSnapshot

    snapshot = DockerSnapshot(
        time.time(),
        [
            {"ID": "owned", "project": "sb-owned", "memory_bytes": observed, "cpu_percent": 0},
            {"ID": "other", "project": "other-project", "memory_bytes": 100, "cpu_percent": 0},
        ],
    )
    sampler = SimpleNamespace(snapshot=AsyncMock(return_value=snapshot))
    first = ResourcePool(Capacity(4, 1000), 4, shared_directory=tmp_path, sampler=sampler)
    second = ResourcePool(
        Capacity(4, 1000), 4, shared_directory=tmp_path, sampler=sampler, pressure_timeout_seconds=0.01
    )
    async with first.reserve(Request(1, 200), project="sb-owned"):
        manager = second.reserve(Request(1, 650), project="sb-second")
        if admitted:
            async with manager:
                assert second.active == 1
        else:
            # The owner remains active, so cancel after observing a refused admission.
            task = asyncio.create_task(manager.__aenter__())
            await asyncio.sleep(0.03)
            assert not task.done()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task


@pytest.mark.parametrize("unknown", [True, False])
async def test_missing_or_stale_daemon_samples_never_become_free_memory(tmp_path, unknown):
    import time
    from unittest.mock import AsyncMock

    from synergy_bench.docker_resources import DockerSnapshot
    from synergy_bench.resources import ResourcePressureError

    sampler = SimpleNamespace(
        snapshot=AsyncMock(
            side_effect=OSError("daemon unavailable") if unknown else None,
            return_value=DockerSnapshot(time.time() - 11, []),
        )
    )
    pool = ResourcePool(Capacity(4, 1000), 4, sampler=sampler, pressure_timeout_seconds=0.01)
    with pytest.raises(ResourcePressureError):
        async with pool.reserve(Request(1, 100)):
            pytest.fail("unknown memory must not admit")
    assert pool.active == 0


@pytest.mark.parametrize(
    "endpoint", ["tcp://127.0.0.1:2375", "ssh://example.invalid", "npipe:////./pipe/docker_engine"]
)
@pytest.mark.parametrize("context", [False, True])
async def test_unsupported_docker_endpoint_fails_before_pressure_wait_or_lease(
    tmp_path, monkeypatch, endpoint, context
):
    import json

    from synergy_bench.docker_resources import DockerStats

    monkeypatch.setenv("DOCKER_HOST", "unix:///unused.sock" if context else endpoint)
    if context:
        monkeypatch.setenv("DOCKER_CONTEXT", "unsupported-fixture")
        monkeypatch.setattr("synergy_bench.docker_resources.command", lambda *args, **kwargs: json.dumps(endpoint))
    else:
        monkeypatch.delenv("DOCKER_CONTEXT", raising=False)
    pool = ResourcePool(Capacity(4, 1000), 4, sampler=DockerStats(), shared_directory=tmp_path)

    def wait(reason):
        pytest.fail("Unsupported endpoints must not enter the pressure queue")

    with pytest.raises(ValueError, match="local Docker Unix endpoint") as error:
        async with pool.reserve(Request(1, 100), on_wait=wait, project="sb-unsupported"):
            pytest.fail("Unsupported endpoints must not admit work")
    assert type(error.value).__name__ == "DockerEndpointError"
    assert endpoint not in str(error.value)
    assert pool.active == 0
    assert list(tmp_path.glob("*.json")) == []


async def test_transient_docker_sample_failure_recovers_through_pressure_queue():
    import time
    from unittest.mock import AsyncMock

    from synergy_bench.docker_resources import DockerSnapshot

    sampler = SimpleNamespace(snapshot=AsyncMock(side_effect=[OSError("unavailable"), DockerSnapshot(time.time(), [])]))
    pool = ResourcePool(Capacity(4, 1000), 4, sampler=sampler)
    reasons = []
    async with pool.reserve(Request(1, 100), on_wait=reasons.append):
        assert pool.active == 1
    assert reasons == ["docker_sample_unavailable"]
    assert pool.active == 0


async def test_old_shared_lease_cannot_silently_disappear(tmp_path):
    from synergy_bench.resources import ResourcePressureError
    from synergy_bench.storage import atomic_json

    file = tmp_path / "leases/old.json"
    atomic_json(file, {"cpus": 1, "memory_bytes": 100, "scope": "sb-12345678-"})
    pool = ResourcePool(Capacity(4, 1000), 4, shared_directory=tmp_path)
    with pytest.raises(ResourcePressureError, match="lease version"):
        async with pool.reserve(Request(1, 100)):
            pytest.fail("old ownership must be reconciled by its original runner")
    assert file.exists()


def test_orphaned_network_keeps_its_reservation_until_owned_cleanup(tmp_path, monkeypatch):
    from synergy_bench import resources
    from synergy_bench.storage import atomic_json

    file = tmp_path / "leases/orphan.json"
    atomic_json(file, {"version": 2, "project": "sb-orphan", "cpus": 1, "memory_bytes": 100})
    remaining = [True]

    def inventory(args, **kwargs):
        assert args[-1] == "label=com.docker.compose.project=sb-orphan"
        return "network-id" if args[1] == "network" and remaining[0] else ""

    monkeypatch.setattr(resources, "command", inventory)
    shared = resources.SharedResources(tmp_path, None)
    assert shared.available(Capacity(4, 1000)).memory_bytes == 900
    assert file.exists() and not shared.healthy and shared.active == 0
    remaining[0] = False
    assert shared.available(Capacity(4, 1000)).memory_bytes == 1000
    assert not file.exists() and shared.healthy


@pytest.mark.parametrize("sampled_at", [None, 0])
def test_shared_acquisition_rechecks_health_after_another_owner_publishes(tmp_path, sampled_at):
    from synergy_bench.resources import ResourceLease, SharedResources

    capacity = Capacity(4, 1000)
    contender = SharedResources(tmp_path, None)
    owner = SharedResources(tmp_path, None)
    assert contender.available(capacity) == capacity
    assert contender.healthy
    assert owner.acquire("owner", Request(1, 100), capacity, "sb-owner")
    lease = ResourceLease(ResourcePool(capacity, 4), "owner", Request(1, 100), True, "sb-owner")
    lease.sampled_at = sampled_at
    owner.update(lease)
    try:
        assert not contender.acquire("contender", Request(1, 100), capacity, "sb-contender")
        assert not (tmp_path / "leases/contender.json").exists()
    finally:
        owner.release("owner")
        contender.release("contender")
