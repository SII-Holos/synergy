import asyncio

import pytest

from synergy_bench.resources import Capacity, Request, ResourcePool


async def test_fixed_reservations_admit_eight_native_tasks_across_schedulers(tmp_path):
    from contextlib import AsyncExitStack

    from synergy_bench.storage import read_json

    native = Request(4.2, 8 * 1024**3 + 128 * 1024**2)
    options = dict(
        shared_directory=tmp_path,
        shared_concurrency=8,
        memory_reservation_bytes=1024**3,
        cpu_reservation=1,
    )
    pools = [ResourcePool(Capacity(12, 13 * 1024**3), 8, **options) for _ in range(2)]
    ninth = asyncio.Event()

    async def waiting():
        async with pools[1].reserve(native):
            ninth.set()

    async with AsyncExitStack() as stack:
        for index in range(8):
            await stack.enter_async_context(pools[index % 2].reserve(native))
        rows = [read_json(file) for file in tmp_path.glob("leases/*.json")]
        assert len(rows) == 8
        assert all(row["memory_bytes"] == 1024**3 and row["cpus"] == 1 for row in rows)
        assert all(row["unscaled_memory_bytes"] == native.memory_bytes and row["unscaled_cpus"] == 4.2 for row in rows)
        pending = asyncio.create_task(waiting())
        await asyncio.sleep(0)
        assert not ninth.is_set()
    await asyncio.wait_for(pending, 3)
    assert ninth.is_set()


@pytest.mark.parametrize("field", ["cpu_reservation", "memory_reservation_gib"])
@pytest.mark.parametrize("value", [0, -1, float("nan"), float("inf")])
def test_fixed_reservation_config_rejects_invalid_values(field, value):
    from pydantic import ValidationError

    from synergy_bench.config import Resources

    with pytest.raises(ValidationError):
        Resources(**{field: value})


async def test_admission_sampling_does_not_block_other_async_work():
    import threading

    release = threading.Event()
    entered = asyncio.Event()
    loop = asyncio.get_running_loop()

    def sample():
        loop.call_soon_threadsafe(entered.set)
        assert release.wait(2), "admission sampling blocked the event loop"
        return True

    async def unblock():
        await entered.wait()
        release.set()

    async def job():
        async with ResourcePool(Capacity(1, 100), 1, admission=sample).reserve(Request(1, 100)):
            pass

    await asyncio.gather(job(), unblock())


async def test_explicit_memory_reservation_changes_admission_not_native_request(tmp_path):
    from synergy_bench.storage import read_json

    native = Request(2, 800)
    pool = ResourcePool(Capacity(8, 1400), 3, shared_directory=tmp_path, memory_reservation_fraction=0.5)
    async with pool.reserve(native), pool.reserve(native), pool.reserve(native):
        leases = [read_json(file) for file in tmp_path.glob("leases/*.json")]
        assert len(leases) == 3
        assert all(row["memory_bytes"] == 400 and row["unscaled_memory_bytes"] == 800 for row in leases)
        assert not pool.fits(Request(2, 400))
        assert native.memory_bytes == 800
    assert not list(tmp_path.glob("leases/*.json"))


def test_overcommitted_admission_requires_observed_docker_headroom(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from synergy_bench import resources

    monkeypatch.setattr(resources, "pressure_ready", lambda *args, **kwargs: True)
    monkeypatch.setattr(resources.psutil, "virtual_memory", lambda: SimpleNamespace(total=1000))
    plan = {
        "host": {"capacity": {"memory_bytes": 1000}},
        "config": {
            "resources": {
                "memory_reservation_fraction": 0.5,
                "reserve_memory_gib": 0,
                "reserve_memory_fraction": 0,
                "min_free_disk_gib": 0,
            }
        },
    }
    monkeypatch.setattr(resources, "command", lambda *args, **kwargs: "900B / 1200B\n")
    assert not resources.admission_for(tmp_path, plan)()
    monkeypatch.setattr(resources, "command", lambda *args, **kwargs: "300B / 1200B\n200B / 1200B\n")
    assert resources.admission_for(tmp_path, plan)()
    monkeypatch.setattr(resources, "command", lambda *args, **kwargs: "-- / --\n")
    assert not resources.admission_for(tmp_path, plan)()


@pytest.mark.parametrize("fraction", [0, -1, 1.01, float("nan"), float("inf")])
def test_invalid_memory_reservation_fraction_is_rejected(fraction):
    from pydantic import ValidationError

    from synergy_bench.config import Resources

    with pytest.raises(ValidationError):
        Resources(memory_reservation_fraction=fraction)
    with pytest.raises(ValueError):
        ResourcePool(Capacity(4, 1000), 2, memory_reservation_fraction=fraction)


def test_memory_limits_admission_even_when_cpu_is_available():
    pool = ResourcePool(Capacity(cpus=12, memory_bytes=12 * 1024**3), concurrency=8)
    assert pool.fits(Request(cpus=1, memory_bytes=8 * 1024**3))
    with pytest.raises(ValueError, match="capacity"):
        pool.validate(Request(cpus=1, memory_bytes=16 * 1024**3))


@pytest.mark.asyncio
async def test_waiting_task_runs_after_owner_releases_resources():
    pool = ResourcePool(Capacity(cpus=12, memory_bytes=12 * 1024**3), concurrency=8)
    large = Request(cpus=2, memory_bytes=8 * 1024**3)
    entered = asyncio.Event()

    async def second():
        async with pool.reserve(large):
            entered.set()

    async with pool.reserve(large):
        task = asyncio.create_task(second())
        await asyncio.sleep(0)
        assert not entered.is_set()
        assert pool.active == 1
    await task
    assert entered.is_set()
    assert pool.active == 0


@pytest.mark.asyncio
async def test_cancelled_waiter_does_not_leak_or_take_capacity():
    pool = ResourcePool(Capacity(cpus=1, memory_bytes=1024), concurrency=1)
    request = Request(cpus=1, memory_bytes=512)

    async def wait():
        async with pool.reserve(request):
            pytest.fail("waiter must be cancelled before admission")

    async with pool.reserve(request):
        task = asyncio.create_task(wait())
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    async with pool.reserve(request):
        assert pool.active == 1
    assert pool.active == 0


def test_docker_stats_units_and_host_reserves():
    from synergy_bench.resources import parse_bytes, usable_capacity

    assert parse_bytes("1.5GiB") == int(1.5 * 1024**3)
    assert parse_bytes("12.2MB") == 12200000
    assert parse_bytes("--") is None
    with pytest.raises(ValueError, match="reserve"):
        usable_capacity(2, 4 * 1024**3, 2, 2 * 1024**3)


async def test_pressure_delays_new_admission_without_cancelling_active_job():
    from synergy_bench.resources import Capacity, Request, ResourcePool

    ready = False
    pool = ResourcePool(Capacity(4, 4 * 1024**3), 2, admission=lambda: ready)
    entered = asyncio.Event()

    async def job():
        async with pool.reserve(Request(1, 1024**3)):
            entered.set()

    running = asyncio.create_task(job())
    await asyncio.sleep(0.05)
    assert not entered.is_set()
    ready = True
    await asyncio.wait_for(running, 3)
    assert entered.is_set()


async def test_light_work_can_backfill_a_waiting_eight_gib_task():
    pool = ResourcePool(Capacity(12, 12 * 1024**3), 4)
    large = Request(2, 8 * 1024**3)
    small = Request(1, 2 * 1024**3)
    order = []

    async def job(name, request):
        async with pool.reserve(request):
            order.append(name)

    async with pool.reserve(large):
        heavy = asyncio.create_task(job("heavy", large))
        await asyncio.sleep(0)
        light = asyncio.create_task(job("light", small))
        await asyncio.sleep(0.02)
        assert order == ["light"]
    await asyncio.gather(heavy, light)
    assert order == ["light", "heavy"]


def test_nonfinite_resource_requests_cannot_wait_forever():
    for cpus in [float("nan"), float("inf")]:
        with pytest.raises(ValueError):
            Request(cpus, 1024)


async def test_permanent_external_pressure_fails_instead_of_queueing_forever():
    pool = ResourcePool(Capacity(4, 4096), 2, admission=lambda: False, pressure_timeout_seconds=0.02)
    with pytest.raises(ValueError, match="pressure"):
        async with pool.reserve(Request(1, 1024)):
            pytest.fail("must not admit")
    assert pool.active == 0


async def test_independent_schedulers_share_the_same_machine_budget(tmp_path):
    import asyncio

    from synergy_bench.resources import Capacity, Request, ResourcePool

    first = ResourcePool(Capacity(2, 200), 2, shared_directory=tmp_path, scope="first")
    second = ResourcePool(Capacity(2, 200), 2, shared_directory=tmp_path, scope="second")
    entered = asyncio.Event()

    async def competing():
        async with second.reserve(Request(2, 200)):
            entered.set()

    async with first.reserve(Request(2, 200)):
        pending = asyncio.create_task(competing())
        await asyncio.sleep(0.05)
        assert not entered.is_set()
    await asyncio.wait_for(pending, 2)
    assert entered.is_set()
    assert not list(tmp_path.glob("leases/*.json"))


async def test_shared_heavy_reservation_allows_light_backfill(tmp_path):
    import asyncio

    first = ResourcePool(Capacity(10, 1000), 2, shared_directory=tmp_path)
    second = ResourcePool(Capacity(10, 1000), 2, shared_directory=tmp_path)
    light = asyncio.Event()

    async def run(request, event=None):
        async with second.reserve(request):
            if event:
                event.set()

    async with first.reserve(Request(8, 800)):
        heavy = asyncio.create_task(run(Request(8, 800)))
        await asyncio.sleep(0.01)
        small = asyncio.create_task(run(Request(2, 200), light))
        try:
            await asyncio.wait_for(light.wait(), 2)
            assert not heavy.done()
        finally:
            if not light.is_set():
                heavy.cancel()
                small.cancel()
                await asyncio.gather(heavy, small, return_exceptions=True)
    await asyncio.wait_for(asyncio.gather(heavy, small), 2)


def test_build_slots_bound_independent_builders_and_release_after_process_death(tmp_path):
    import subprocess
    import sys

    from synergy_bench.resources import BuildSlots

    held = BuildSlots(tmp_path, limit=1)
    assert held.acquire()
    second = BuildSlots(tmp_path, limit=1)
    assert not second.acquire()
    held.release()
    script = (
        "from pathlib import Path;import sys,time;from synergy_bench.resources import BuildSlots;"
        "s=BuildSlots(Path(sys.argv[1]),limit=1);assert s.acquire();print('ready',flush=True);time.sleep(60)"
    )
    child = subprocess.Popen([sys.executable, "-c", script, str(tmp_path)], stdout=subprocess.PIPE, text=True)
    try:
        assert child.stdout.readline().strip() == "ready"
        assert not second.acquire()
        child.kill()
        child.wait(timeout=3)
        assert second.acquire()
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=3)
        second.release()


async def test_recording_and_proxy_allowance_are_part_of_admission():
    from contextlib import AsyncExitStack

    from synergy_bench.resources import with_runtime_overhead

    native = Request(1, 2 * 1024**3)
    observed = with_runtime_overhead(native)
    assert observed.cpus > native.cpus
    assert observed.memory_bytes == native.memory_bytes + 128 * 1024**2
    pool = ResourcePool(Capacity(12, int(15.6 * 0.85 * 1024**3)), 8)
    async with AsyncExitStack() as stack:
        for _ in range(6):
            await stack.enter_async_context(pool.reserve(observed))
        assert pool.active == 6
        assert not pool.fits(observed)
