import json

from synergy_bench.monitor import ResourceMonitor


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
    seen = []

    async def process(args, *, log, **kwargs):
        seen.append(args)
        if args[1] == "ps":
            log.write_text("one sb-run\ntwo sb-run__verifier__trial\nother sb-run-other\n")
        elif args[1] == "stats":
            log.write_text("\n".join(json.dumps({"MemUsage": "1GiB / 8GiB", "CPUPerc": "20%"}) for _ in args[5:]))
        else:
            log.write_text("123456\n")
        return 0

    monkeypatch.setattr("synergy_bench.monitor.run_process", process)
    monitor = ResourceMonitor(tmp_path, "sb-run")
    await monitor.sample()
    stats = next(args for args in seen if args[1] == "stats")
    assert stats[5:] == ["one", "two"]
    assert monitor.samples[0]["memory_bytes"] == 2 * 1024**3
    assert monitor.samples[0]["cpu_percent"] == 40


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
