from __future__ import annotations

import asyncio
import json
import os
import shlex
from pathlib import Path
from typing import Any

from pier.agents.base import BaseAgent
from pier.agents.installed.base import NonZeroAgentExitCodeError
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
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

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        logs = environment.env_paths.agent_dir.as_posix()
        local = self.logs_dir / "instruction.md"
        local.write_text(instruction)
        await environment.upload_file(local, f"{logs}/instruction.md")
        credentials = {target: os.environ[reference] for target, reference in self.settings["env"].items()}
        command = shlex.join(
            [
                "/opt/synergy/bin/bun",
                "/opt/synergy/runtime/trial.ts",
                "/benchmark-input/options.json",
                f"{logs}/instruction.md",
                logs,
            ]
        )
        try:
            result = await environment.exec(command, env=credentials)
            if result.return_code:
                raise NonZeroAgentExitCodeError(f"Synergy exited with code {result.return_code}")
        except asyncio.CancelledError:
            cleanup = int(self.settings["cleanup_seconds"])
            try:
                await asyncio.wait_for(
                    environment.exec(
                        f"test ! -f {shlex.quote(logs + '/runner.pid')} || "
                        f"kill -TERM $(cat {shlex.quote(logs + '/runner.pid')}); "
                        f"for i in $(seq 1 {cleanup}); do test -f {shlex.quote(logs + '/finished')} "
                        "&& exit 0; sleep 1; done",
                        timeout_sec=cleanup + 1,
                    ),
                    timeout=cleanup + 2,
                )
            except (TimeoutError, RuntimeError):
                pass
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
