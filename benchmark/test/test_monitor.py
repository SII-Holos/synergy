import json

import pytest

from synergy_bench.monitor import ResourceMonitor


async def test_resource_recording_failure_is_fatal_instead_of_an_unknown_sample(tmp_path, monkeypatch):
    from synergy_bench.monitor import ResourceRecordingError

    monitor = ResourceMonitor(tmp_path, "sb-run")

    def failed_save(*args):
        raise OSError("storage unavailable")

    monkeypatch.setattr("synergy_bench.monitor.atomic_json", failed_save)

    async def sample():
        monitor.persist()

    monkeypatch.setattr(monitor, "sample", sample)
    with pytest.raises(ResourceRecordingError):
        await monitor.run()


async def test_live_event_disconnect_retains_observed_lower_bound(tmp_path, monkeypatch):
    import uuid
    from pathlib import Path

    from aiohttp import web

    socket = Path("/tmp") / ("sb-events-" + uuid.uuid4().hex + ".sock")
    row = {"Action": "oom", "Actor": {"ID": "one", "Attributes": {"com.docker.compose.project": "sb-run"}}}

    async def events(request):
        return web.Response(body=(json.dumps(row) + "\n").encode())

    app = web.Application()
    app.router.add_get("/events", events)
    server = web.AppRunner(app)
    await server.setup()
    await web.UnixSite(server, str(socket)).start()
    monkeypatch.setenv("DOCKER_HOST", "unix://" + str(socket))
    monkeypatch.delenv("DOCKER_CONTEXT", raising=False)
    monitor = ResourceMonitor(tmp_path, "sb-run")
    try:
        await monitor.observe_events()
        monitor.persist()
        record = json.loads((tmp_path / "resources.json").read_text())
        assert monitor.event_ready.is_set()
        assert record["oom_events"] is None
        assert record["observed_oom_events"] == 1
        assert record["oom_coverage"] == "partial_live_stream"
        assert json.loads((tmp_path / "container-events-live.jsonl").read_text()) == row
    finally:
        await server.cleanup()
        socket.unlink(missing_ok=True)


async def test_resource_samples_include_separate_verifier_and_exclude_other_runs(tmp_path, monkeypatch):
    import uuid
    from pathlib import Path

    from aiohttp import web

    socket = Path("/tmp") / ("sb-stats-" + uuid.uuid4().hex + ".sock")
    seen = []

    async def containers(request):
        return web.json_response(
            [
                {"Id": identity, "Labels": {"com.docker.compose.project": project}}
                for identity, project in [
                    ("one", "sb-run"),
                    ("two", "sb-run__verifier__trial"),
                    ("other", "sb-run-other"),
                ]
            ]
        )

    async def stats(request):
        seen.append(request.match_info["id"])
        return web.json_response(
            {
                "memory_stats": {"usage": 2 * 1024**3, "stats": {"inactive_file": 1024**3}},
                "cpu_stats": {"system_cpu_usage": 2000, "cpu_usage": {"total_usage": 300}, "online_cpus": 2},
                "precpu_stats": {"system_cpu_usage": 1000, "cpu_usage": {"total_usage": 200}},
            }
        )

    app = web.Application()
    app.router.add_get("/containers/json", containers)
    app.router.add_get("/containers/{id}/stats", stats)
    server = web.AppRunner(app)
    await server.setup()
    await web.UnixSite(server, str(socket)).start()
    monkeypatch.setenv("DOCKER_HOST", "unix://" + str(socket))
    monkeypatch.delenv("DOCKER_CONTEXT", raising=False)
    monitor = ResourceMonitor(tmp_path, "sb-run")
    try:
        await monitor.sample()
        assert sorted(seen) == ["one", "two"]
        assert monitor.samples[0]["memory_bytes"] == 2 * 1024**3
        assert monitor.samples[0]["cpu_percent"] == 40
        assert monitor.samples[0]["process_rss_sum_bytes"] is None
    finally:
        await server.cleanup()
        socket.unlink(missing_ok=True)


async def test_oom_events_survive_container_cleanup_and_exclude_other_trials(tmp_path, monkeypatch):
    from synergy_bench.storage import read_json

    async def process(args, *, log, **kwargs):
        log.write_text(
            "\n".join(
                json.dumps(
                    {"Action": "oom", "Actor": {"ID": project, "Attributes": {"com.docker.compose.project": project}}}
                )
                for project in ["sb-run", "sb-run__verifier__trial", "sb-other"]
            )
        )
        return 0

    monkeypatch.setattr("synergy_bench.monitor.run_process", process)
    monitor = ResourceMonitor(tmp_path, "sb-run")
    await monitor.collect_events()
    monitor.persist()
    record = read_json(tmp_path / "resources.json")
    assert record["oom_events"] is None
    assert record["observed_oom_events"] == 2
    assert record["oom_coverage"] == "observed_event_window"


async def test_closing_live_subscription_drains_late_events_without_losing_prior_events(tmp_path, monkeypatch):
    def event(identity):
        return {"Action": "oom", "Actor": {"ID": identity, "Attributes": {"com.docker.compose.project": "sb-run"}}}

    early, late = event("early"), event("late")

    async def process(args, *, log, **kwargs):
        log.write_text(json.dumps(late) + "\n" + json.dumps(late) + "\n")
        return 0

    monkeypatch.setattr("synergy_bench.monitor.run_process", process)
    monitor = ResourceMonitor(tmp_path, "sb-run")
    monitor.event_connected = True
    monitor.oom_coverage = "live_stream"
    monitor.accept_event(early)
    await monitor.collect_events()
    monitor.persist()
    record = json.loads((tmp_path / "resources.json").read_text())
    assert record["oom_coverage"] == "live_stream"
    assert record["oom_events"] == 2
    assert record["container_events"] == [early, late]


def test_oom_dedup_uses_kernel_event_identity_and_preserves_distinct_occurrences(tmp_path):
    row = {
        "Type": "container",
        "Action": "oom",
        "timeNano": 1789000000000000001,
        "Actor": {"ID": "container-one", "Attributes": {"com.docker.compose.project": "sb-run"}},
    }
    monitor = ResourceMonitor(tmp_path, "sb-run")
    monitor.accept_event(row)
    monitor.accept_event({**row, "status": "oom", "id": "container-one", "extra": "CLI serialization"})
    assert len(monitor.events) == 1
    monitor.accept_event({**row, "timeNano": row["timeNano"] + 1})
    assert len(monitor.events) == 2
