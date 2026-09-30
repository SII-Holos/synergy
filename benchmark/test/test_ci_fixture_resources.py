import pytest
from fixtures.resources import fixture_resources

from synergy_bench.config import Resources
from synergy_bench.resources import Request, ResourcePool, usable_capacity, working_set_request


@pytest.mark.asyncio
async def test_ci_preparation_can_start_while_an_independent_native_trial_waits(monkeypatch):
    monkeypatch.setenv("CI", "true")
    settings = Resources(**fixture_resources())
    capacity = usable_capacity(4, 16 * 1024**3, settings.reserve_cpus, int(settings.reserve_memory_gib * 1024**3))
    pool = ResourcePool(capacity, 2)
    async with pool.reserve(working_set_request(Request(1, 2 * 1024**3))):
        assert pool.fits(Request(2, 4 * 1024**3))
        assert not pool.fits(Request(4, 4 * 1024**3))


def test_local_fixture_keeps_research_resource_defaults(monkeypatch):
    monkeypatch.delenv("CI", raising=False)
    settings = Resources(**fixture_resources())
    assert settings.reserve_cpus == Resources().reserve_cpus
    assert settings.reserve_memory_gib == Resources().reserve_memory_gib
