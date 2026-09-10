import asyncio
import json
from pathlib import Path
from typing import cast

import pytest
from pier.environments.base import BaseEnvironment, ExecResult

from synergy_bench.agent import SynergyAgent


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
