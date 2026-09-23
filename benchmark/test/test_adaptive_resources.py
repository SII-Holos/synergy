import asyncio

import pytest

from synergy_bench.resources import Capacity, Request, ResourcePool, working_set_request


def test_sustained_cpu_pressure_and_recovery_use_independent_samples(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from synergy_bench import resources
    from synergy_bench.config import Resources

    clock = [0.0]
    cpu = [SimpleNamespace(_asdict=lambda: {"user": 100, "idle": 100})]
    monkeypatch.setattr(resources.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(resources.psutil, "cpu_times", lambda: cpu[0])
    monkeypatch.setattr(
        resources.psutil, "virtual_memory", lambda: SimpleNamespace(total=64 * 1024**3, available=10 * 1024**3)
    )
    monkeypatch.setattr(resources, "host_limits", lambda cpus, total, available: (cpus, total, available))
    check = resources.HostPressure(tmp_path, Resources(min_free_disk_gib=0), 64 * 1024**3)
    request = Request(1, 1024**3)
    assert not check(request)
    for second in range(1, 6):
        clock[0] = float(second)
        cpu[0] = SimpleNamespace(_asdict=lambda second=second: {"user": 100 + second * 100, "idle": 100})
        ready = check(request)
    assert not ready
    assert check.reason == "cpu_saturated"
    clock[0] = 6
    cpu[0] = SimpleNamespace(_asdict=lambda: {"user": 600, "idle": 200})
    assert check(request)


async def test_failed_shared_admission_releases_its_unstarted_reservation(tmp_path, monkeypatch):
    pool = ResourcePool(Capacity(1, 100), 1, shared_directory=tmp_path)

    def fail(lease):
        raise OSError("lease publication failed")

    monkeypatch.setattr(pool.shared, "update", fail)
    with pytest.raises(OSError):
        async with pool.reserve(Request(1, 100), adaptive=True):
            pytest.fail("failed publication must not dispatch")
    assert pool.active == 0
    assert not pool._leases
    assert not list((tmp_path / "leases").glob("*.json"))


def test_working_set_estimate_does_not_reserve_native_hard_limit():
    request = working_set_request(Request(4, 8 * 1024**3))
    assert request == Request(0.45, 1024**3 + 128 * 1024**2)
    assert working_set_request(Request(0.1, 256 * 1024**2)).memory_bytes == 384 * 1024**2


async def test_first_sample_growth_and_missing_telemetry_control_new_starts():
    request = Request(1, 100)
    pool = ResourcePool(Capacity(4, 400), 48)
    entered = asyncio.Event()

    async def second():
        async with pool.reserve(request, adaptive=True) as lease:
            entered.set()
            await lease.sample(100, 0.1)

    async with pool.reserve(request, adaptive=True) as first:
        waiting = asyncio.create_task(second())
        await asyncio.sleep(0.02)
        assert not entered.is_set()
        await first.sample(260, 0.1)
        assert first.request.memory_bytes == 325
        await asyncio.sleep(0.02)
        assert not entered.is_set()
        await first.sample(None, None)
        assert not pool.fits(Request(1, 1))
    await asyncio.wait_for(waiting, 2)
    assert pool.active == 0


async def test_same_container_phase_transition_updates_in_place_without_deadlock():
    pool = ResourcePool(Capacity(2, 200), 2)
    async with pool.reserve(Request(1, 100), adaptive=True) as lease:
        await lease.sample(100, 1)
        await lease.phase("verifier")
        await lease.sample(180, 1)
        assert lease.request.memory_bytes == 225
        assert pool.active == 1
        assert not pool.fits(Request(1, 1))
    assert pool.active == 0


async def test_verifier_enters_before_waiting_new_solver():
    pool = ResourcePool(Capacity(1, 100), 48)
    order = []

    async def job(name, priority):
        async with pool.reserve(Request(1, 100), priority=priority):
            order.append(name)

    async with pool.reserve(Request(1, 100)):
        agent = asyncio.create_task(job("agent", 0))
        await asyncio.sleep(0)
        verifier = asyncio.create_task(job("verifier", 1))
        await asyncio.sleep(0)
    await asyncio.gather(agent, verifier)
    assert order == ["verifier", "agent"]


async def test_48_sampled_cells_share_capacity_without_duplicate_execution():
    request = working_set_request(Request(2, 8 * 1024**3))
    pool = ResourcePool(Capacity(64, 64 * 1024**3), 48)
    started = set()
    full = asyncio.Event()

    async def cell(index):
        async with pool.reserve(request, adaptive=True) as lease:
            assert index not in started
            started.add(index)
            await lease.sample(256 * 1024**2, 0.1)
            if len(started) == 48:
                full.set()
            await full.wait()

    await asyncio.wait_for(asyncio.gather(*(cell(i) for i in range(48))), 3)
    assert len(started) == 48
    assert pool.active == 0


async def test_phase_leases_keep_unresolved_resources_and_release_before_separate_verifier(tmp_path):
    from synergy_bench.scheduling import PhaseResources

    pool = ResourcePool(Capacity(2, 2 * 1024**3), 48)
    stages = PhaseResources(pool, tmp_path)
    await stages.acquire("sb-test", Request(4, 8 * 1024**3))
    await stages.sample({"sb-test": (512 * 1024**2, 0.1)})
    with pytest.raises(RuntimeError, match="resources remain"):
        await stages.finish(resources_removed=False)
    assert pool.active == 1
    await stages.release("sb-test")
    assert pool.active == 0
    await stages.acquire("sb-test__verifier__trial", Request(4, 8 * 1024**3))
    assert pool.active == 1
    assert next(iter(stages.leases.values()))[1].stage == "verifier"
    await stages.finish(resources_removed=True)
    assert pool.active == 0
    assert [event["event"] for event in stages.events if event["event"] in {"started", "released"}] == [
        "started",
        "released",
        "started",
        "released",
    ]
