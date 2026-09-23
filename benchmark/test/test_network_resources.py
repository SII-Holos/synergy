import asyncio
import os

import pytest

from synergy_bench.network_resources import available_subnets
from synergy_bench.resources import Capacity, Request, ResourcePool, working_set_request


def test_docker_default_pool_exhaustion_and_recovery():
    pools = [{"base": "192.168.0.0/16", "size": 20}]
    occupied = [f"192.168.{index * 16}.0/20" for index in range(16)]
    assert available_subnets(pools, occupied) == 0
    assert available_subnets(pools, occupied[:-2]) == 2


def test_documented_default_pools_have_30_slots_after_the_default_bridge():
    from synergy_bench.network_resources import DEFAULT_POOLS

    assert available_subnets(DEFAULT_POOLS, ["172.17.0.0/16"]) == 30


def test_unreadable_network_inventory_is_unknown(monkeypatch):
    from synergy_bench import network_resources

    monkeypatch.setattr(network_resources, "command", lambda *args, **kwargs: "invalid metadata")
    assert network_resources.inspect_network_capacity(network_resources.DEFAULT_POOLS) is None


@pytest.mark.skipif(os.environ.get("SYNERGY_BENCH_DOCKER") != "1", reason="Read-only local Docker inventory")
def test_real_docker_network_capacity_is_observable():
    import json

    from synergy_bench.network_resources import DEFAULT_POOLS, inspect_network_capacity
    from synergy_bench.prepare import command

    configured = json.loads(command(["docker", "info", "--format", "{{json .DefaultAddressPools}}"], timeout=10))
    pools = configured or DEFAULT_POOLS
    available = inspect_network_capacity(pools)
    assert available is not None
    assert 0 <= available <= available_subnets(pools, [])


def test_address_capacity_counts_whole_allocations_and_host_routes():
    pools = [{"Base": "10.0.0.0/8", "Size": 24}]
    assert available_subnets(pools, ["10.0.0.0/25", "10.0.0.128/25"]) == 65535
    assert available_subnets(pools, ["10.0.0.0/9"]) == 32768
    assert available_subnets(pools, ["10.0.0.0/8"]) == 0


def test_network_admission_pauses_on_exhaustion_or_unknown_samples(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from synergy_bench import resources
    from synergy_bench.config import Resources

    memory = SimpleNamespace(total=64 * 1024**3, available=32 * 1024**3)
    monkeypatch.setattr(resources.psutil, "virtual_memory", lambda: memory)
    monkeypatch.setattr(resources, "host_limits", lambda cpus, total, available: (cpus, total, available))
    capacity = [0]
    monkeypatch.setattr(resources, "inspect_network_capacity", lambda pools: capacity[0])
    pressure = resources.HostPressure(tmp_path, Resources(min_free_disk_gib=0), memory.total, [])
    pressure.previous = (resources.time.monotonic(), 1, 1)
    pressure.cpu_ready = True
    request = Request(0.25, 1024**3, networks=2)
    assert not pressure(request)
    assert pressure.reason == "network_address_pressure"
    capacity[0] = None
    assert not pressure(request)
    assert pressure.reason == "network_sample_unavailable"
    capacity[0] = 2
    assert pressure(request)


async def test_network_capacity_queues_48_cells_until_prior_networks_are_removed():
    available = [2]
    pool = ResourcePool(Capacity(64, 64 * 1024**3), 48, admission=lambda request: available[0] >= request.networks)
    order = []

    async def cell(index):
        request = working_set_request(Request(2, 8 * 1024**3, networks=2))
        assert request.networks == 2
        async with pool.reserve(request, adaptive=True) as lease:
            available[0] -= 2
            order.append(index)
            await lease.sample(1, 0.1)
            assert lease.request.networks == 2
            await asyncio.sleep(0)
            available[0] += 2

    await asyncio.wait_for(asyncio.gather(*(cell(index) for index in range(48))), 5)
    assert len(order) == len(set(order)) == 48
    assert pool.active == 0
