import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import pytest
from pier.environments.base import BaseEnvironment, ExecResult

from synergy_bench.agent import SynergyAgent


@pytest.mark.asyncio
async def test_accounting_is_read_only_after_pier_hands_logs_to_the_host(tmp_path: Path, monkeypatch) -> None:
    from pier.models.agent.context import AgentContext

    from synergy_bench import agent as module
    from synergy_bench.storage import atomic_json
    from synergy_bench.trial import BenchmarkTrial

    handed_off = False
    original = module.read_json

    def read(path):
        if not handed_off:
            raise PermissionError("Container-owned private accounting is not readable by the host yet")
        return original(path)

    class Environment:
        env_paths = SimpleNamespace(agent_dir=Path("/logs/agent"))
        capabilities = SimpleNamespace(mounted=True)

        async def upload_file(self, source, target):
            pass

        async def exec(self, command, **kwargs):
            if command.startswith("/opt/synergy/bin/bun"):
                atomic_json(tmp_path / "accounting.json", {"tokens": {"input": {"total": 123}}})
            return ExecResult(return_code=0, stdout="0" if command == "id -u" else "")

        async def prepare_logs_for_host(self):
            nonlocal handed_off
            handed_off = True

    monkeypatch.setattr(module, "read_json", read)
    environment = Environment()
    agent = SynergyAgent(tmp_path, settings={"env": {}})
    context = AgentContext()
    await agent.run("Fixture", cast(BaseEnvironment, environment), context)
    assert context.n_input_tokens is None
    trial = object.__new__(BenchmarkTrial)
    trial._agent = agent
    trial._environment = environment
    trial._are_agent_logs_downloaded = False
    trial._trial_paths = SimpleNamespace(agent_dir=tmp_path)
    await trial._maybe_download_logs(source_dir="/logs/agent", target_dir=tmp_path)
    trial._maybe_populate_agent_context(context)
    assert context.n_input_tokens == 123


@pytest.mark.asyncio
async def test_credential_file_is_private_short_lived_and_never_in_exec_arguments(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sentinel = "benchmark-credential-sentinel"
    monkeypatch.setenv("BENCH_TEST_SECRET", sentinel)
    commands = []
    uploaded = []

    class Environment:
        async def upload_file(self, source: Path, target: str) -> None:
            assert (await asyncio.to_thread(source.stat)).st_mode & 0o777 == 0o600
            assert json.loads(await asyncio.to_thread(source.read_text)) == {"PROVIDER_KEY": sentinel}
            uploaded.append(source)

        async def exec(self, command: str, **kwargs) -> ExecResult:
            commands.append((command, kwargs))
            return ExecResult(return_code=0, stdout="1000" if command == "id -u" else "")

    agent = SynergyAgent(tmp_path, settings={"env": {"PROVIDER_KEY": "BENCH_TEST_SECRET"}})
    with pytest.raises(RuntimeError, match="injected"):
        async with agent.credential_file(cast(BaseEnvironment, Environment())) as remote:
            assert remote.startswith("/tmp/synergy-bench-credentials-")
            assert not await asyncio.to_thread(uploaded[0].exists)
            raise RuntimeError("injected")
    assert commands[-1][0].startswith("rm -f ")
    assert all(sentinel not in command and not kwargs.get("env") for command, kwargs in commands)
    assert any("chown 1000" in command and kwargs.get("user") == "root" for command, kwargs in commands)
