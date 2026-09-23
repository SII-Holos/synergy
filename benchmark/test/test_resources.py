import asyncio

import pytest

from synergy_bench.resources import Capacity, Request, ResourcePool


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
    pool = ResourcePool(Capacity(4, 4 * 1024**3), 2, admission=lambda request: ready)
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
    pool = ResourcePool(Capacity(4, 4096), 2, admission=lambda request: False, pressure_timeout_seconds=0.02)
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
