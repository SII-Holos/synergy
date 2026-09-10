from __future__ import annotations

import asyncio
import json
import os
import shlex
import tempfile
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from pier.agents.base import BaseAgent
from pier.agents.installed.base import NonZeroAgentExitCodeError
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep
from pier.models.agent.network import NetworkAllowlist

from .prepare import command
from .storage import atomic_json, read_json


class SynergyAgent(BaseAgent):
    def __init__(self, logs_dir: Path, *, settings: dict[str, Any], **kwargs: Any) -> None:
        super().__init__(logs_dir=logs_dir, **kwargs)
        self.settings = settings

    @staticmethod
    def name() -> str:
        return "synergy-local"

    def version(self) -> str:
        return str(self.settings["artifact_id"])

    def network_allowlist(self) -> NetworkAllowlist:
        return NetworkAllowlist(domains=self.settings["network_domains"])

    def install_spec(self) -> AgentInstallSpec:
        return AgentInstallSpec(
            agent_name="synergy-prerequisites",
            version="1",
            steps=[
                InstallStep(
                    user="root",
                    run=(
                        "if command -v git >/dev/null; then exit 0; fi; "
                        "if command -v apt-get >/dev/null; then apt-get update && "
                        "apt-get install -y --no-install-recommends git ca-certificates; "
                        "elif command -v apk >/dev/null; then apk add --no-cache git ca-certificates; "
                        "else echo 'Synergy requires Git in this task image' >&2; exit 1; fi"
                    ),
                )
            ],
            verification_command="git --version",
        )

    async def setup(self, environment: BaseEnvironment) -> None:
        if self.mcp_servers or self.skills_dir:
            raise ValueError("This adapter does not yet support task-supplied MCP servers or skills")
        result = await environment.exec("/opt/synergy/bin/bun --version", timeout_sec=30)
        if result.return_code:
            raise ValueError("Prepared Bun runtime is not compatible with the task environment")
        containers = await asyncio.to_thread(
            command,
            [
                "docker",
                "ps",
                "-q",
                "--filter",
                f"label=com.docker.compose.project={self.settings['project']}",
            ],
        )
        observed = []
        for container in containers.splitlines():
            value = await asyncio.to_thread(
                command,
                [
                    "docker",
                    "inspect",
                    container,
                    "--format",
                    '{"image":{{json .Image}},"configured_image":{{json .Config.Image}},'
                    '"memory_bytes":{{.HostConfig.Memory}},"nano_cpus":{{.HostConfig.NanoCpus}}}',
                ],
            )
            observed.append(json.loads(value))
        atomic_json(self.logs_dir / "environment.json", {"containers": observed, "bun": result.stdout})

    @asynccontextmanager
    async def credential_file(self, environment: BaseEnvironment) -> AsyncIterator[str]:
        credentials = {target: os.environ[reference] for target, reference in self.settings["env"].items()}
        remote_secret = f"/tmp/synergy-bench-credentials-{uuid.uuid4().hex}.json"
        fd, secret = tempfile.mkstemp(prefix="synergy-bench-credentials-")
        try:
            try:
                with os.fdopen(fd, "w") as handle:
                    json.dump(credentials, handle)
                identity = await environment.exec("id -u", timeout_sec=15)
                uid = (identity.stdout or "").strip()
                if identity.return_code or not uid.isdecimal():
                    raise RuntimeError("Unable to resolve credential file owner")
                await environment.upload_file(Path(secret), remote_secret)
                secured = await environment.exec(
                    f"chmod 600 {shlex.quote(remote_secret)} && chown {uid} {shlex.quote(remote_secret)}",
                    user="root",
                    timeout_sec=30,
                )
                if secured.return_code:
                    raise RuntimeError("Unable to secure uploaded credential file")
            finally:
                await asyncio.to_thread(Path(secret).unlink, missing_ok=True)
            yield remote_secret
        finally:
            try:
                removed = await environment.exec(f"rm -f {shlex.quote(remote_secret)}", user="root", timeout_sec=15)
                if removed.return_code:
                    atomic_json(self.logs_dir / "credential-cleanup.json", {"status": "failed"})
            except Exception as error:
                atomic_json(
                    self.logs_dir / "credential-cleanup.json", {"status": "failed", "error": type(error).__name__}
                )

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        logs = environment.env_paths.agent_dir.as_posix()
        local = self.logs_dir / "instruction.md"
        local.write_text(instruction)
        await environment.upload_file(local, f"{logs}/instruction.md")
        try:
            async with self.credential_file(environment) as remote_secret:
                invocation = shlex.join(
                    [
                        "/opt/synergy/bin/bun",
                        "/opt/synergy/runtime/trial.ts",
                        "/benchmark-input/options.json",
                        f"{logs}/instruction.md",
                        logs,
                        remote_secret,
                    ]
                )
                result = await environment.exec(invocation)
                if result.return_code:
                    raise NonZeroAgentExitCodeError(f"Synergy exited with code {result.return_code}")
        except asyncio.CancelledError:
            cleanup = int(self.settings["cleanup_seconds"]) + int(self.settings["export_timeout_seconds"]) + 15
            try:
                drained = await asyncio.wait_for(
                    environment.exec(
                        f"test ! -f {shlex.quote(logs + '/runner.pid')} || "
                        f"kill -TERM $(cat {shlex.quote(logs + '/runner.pid')}); "
                        f"for i in $(seq 1 {cleanup}); do test -f {shlex.quote(logs + '/finished')} "
                        "&& exit 0; sleep 1; done; exit 1",
                        timeout_sec=cleanup + 1,
                    ),
                    timeout=cleanup + 2,
                )
                if drained.return_code:
                    raise RuntimeError("Wrapper did not finish within the cleanup and export deadline")
            except (TimeoutError, RuntimeError) as error:
                atomic_json(self.logs_dir / "cleanup.json", {"status": "failed", "error": type(error).__name__})
            raise
        finally:
            self.populate_context_post_run(context)

    def populate_context_post_run(self, context: AgentContext) -> None:
        path = self.logs_dir / "accounting.json"
        if not path.exists():
            return
        accounting = read_json(path)
        tokens = accounting.get("tokens", {})
        context.n_input_tokens = tokens.get("input", {}).get("total")
        context.n_cache_tokens = tokens.get("cacheRead", {}).get("total")
        context.n_output_tokens = tokens.get("output", {}).get("total")
        context.metadata = {
            "synergy_accounting": accounting,
            "cost_semantics": "native accounting; no conversion to invoice cost",
        }
