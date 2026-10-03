import asyncio
import os

from synergy_bench.docker_resources import DockerSnapshot, DockerStats


async def healthy_docker_snapshot(sampler: DockerStats, *, timeout_seconds: float) -> DockerSnapshot:
    async with asyncio.timeout(timeout_seconds):
        while True:
            snapshot = await sampler.snapshot()
            if snapshot.healthy:
                return snapshot
            await asyncio.sleep(1)


def fixture_resources():
    return (
        {"cache_budget_gib": 10, "min_free_disk_gib": 2, "reserve_cpus": 1}
        if os.environ.get("CI") == "true"
        else {"cache_budget_gib": 384}
    )
