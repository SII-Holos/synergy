from __future__ import annotations

import asyncio
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

from pier.environments.agent_setup import EGRESS_PROXY_SERVICE
from pier.environments.base import ExecResult
from pier.environments.docker.docker import DockerEnvironment

from .cache import async_cache_lock, reference_run
from .catalog import tree_digest
from .prepare import command
from .process import run_preparation_process, run_process
from .resources import Request
from .scheduling import current_resources, queued
from .storage import atomic_json, digest, read_json

# Pier 0.3.1 Docker lifecycle extension. See third_party/pier/NOTICE.
# Preserve its native resource, network and build recipes; own cache identity, inference routing and teardown evidence.
IMAGE_OWNER = "synergy-benchmark-image-v1"


def environment_identity(
    directory: Path, task: dict[str, Any], install: dict[str, Any] | None, platform: str
) -> dict[str, Any]:
    return {"context": tree_digest(directory), "task": task, "install": install, "platform": platform, "recipe": 1}


class CachedDockerEnvironment(DockerEnvironment):
    def __init__(
        self,
        *args: Any,
        benchmark_cache: str,
        benchmark_platform: str,
        inference_port: int | None = None,
        benchmark_run: str | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        # The cache-key lock below owns shared builds; Pier's task-name lock conflates independent variants.
        self._image_build_locks = {}
        self._benchmark_cache = Path(benchmark_cache)
        self._benchmark_run = Path(benchmark_run) if benchmark_run else None
        self._inference_port = inference_port
        self._benchmark_identity = environment_identity(
            self.environment_dir,
            self.task_env_config.model_dump(mode="json"),
            self.agent_install_spec.model_dump(mode="json") if self.agent_install_spec else None,
            benchmark_platform,
        )
        self._benchmark_identity["cache_namespace"] = digest(str(self._benchmark_cache.resolve()))
        self._env_vars.main_image_name = "synergy-bench-task:" + digest(self._benchmark_identity)
        self._benchmark_proxy: dict[str, Any] | None = None
        if self._benchmark_run:
            reference_run(self._benchmark_cache, self._benchmark_run, images=[digest(self._benchmark_identity)])

    def _prepare_egress_proxy_compose(self) -> None:
        super()._prepare_egress_proxy_compose()
        if not self._egress_proxy_compose_path:
            return
        file = self._egress_proxy_compose_path
        value = read_json(file)
        service = value["services"][EGRESS_PROXY_SERVICE]
        directory = Path(service["build"]["context"])
        bootstrap = directory / "start-squid.sh"
        script = bootstrap.read_text().replace(
            "acl Safe_ports port 80 443", "acl Safe_ports port ${BENCH_INFERENCE_PORT:-80 443}"
        )
        script = script.replace("acl SSL_ports port 443", "acl SSL_ports port ${BENCH_INFERENCE_PORT:-443}")
        script = script.replace("<<'EOF'", "<<EOF")
        script = script.replace(
            "cat > /tmp/squid.conf",
            "awk '!($1 ~ /:/ && $0 ~ /host[.]docker[.]internal/)' /etc/hosts > /tmp/benchmark-hosts\n\n"
            "cat > /tmp/squid.conf",
        )
        script = script.replace(
            "pid_filename /tmp/squid.pid", "pid_filename /tmp/squid.pid\nhosts_file /tmp/benchmark-hosts"
        )
        bootstrap.write_text(script)
        if self._inference_port:
            service["environment"]["BENCH_INFERENCE_PORT"] = str(self._inference_port)
        service["extra_hosts"] = ["host.docker.internal:host-gateway"]
        service["platform"] = self._benchmark_identity["platform"]
        identity = {
            "kind": "inference-proxy",
            "context": tree_digest(directory),
            "platform": self._benchmark_identity["platform"],
            "cache_namespace": self._benchmark_identity["cache_namespace"],
        }
        self._benchmark_proxy = identity
        if self._benchmark_run:
            reference_run(self._benchmark_cache, self._benchmark_run, images=[digest(identity)])
        service["build"].setdefault("labels", {})["org.synergy.benchmark.cache-key"] = digest(identity)
        service["image"] = "synergy-bench-egress:" + digest(identity)
        service["pull_policy"] = "never"
        atomic_json(file, value)

    async def _compose_command(
        self, args: list[str], *, check: bool = True, timeout_sec: int | None = None
    ) -> ExecResult:
        from pier.environments.docker.docker import _sanitize_docker_compose_project_name

        command_args = [
            "docker",
            "compose",
            "--project-name",
            _sanitize_docker_compose_project_name(self.session_id),
            "--project-directory",
            str(self.environment_dir.resolve()),
        ]
        for path in self._docker_compose_paths:
            command_args.extend(["-f", str(path.resolve())])
        command_args.extend(args)
        env = self._env_vars.to_env_dict(include_os_env=True)
        env.update(self._compose_task_env or {})
        env.update(self._persistent_env or {})
        if self._windows_container_name:
            env["PIER_CONTAINER_NAME"] = self._windows_container_name
        log = self.trial_paths.trial_dir / "compose" / (args[0] + "-" + uuid.uuid4().hex + ".log")
        # Native execution inherits its caller's deadline; preparation's ceiling must not truncate paid work.
        deadline = timeout_sec if timeout_sec is not None or args[0] == "exec" else 1800
        if args[0] in {"build", "pull", "up"}:
            code = await run_preparation_process(
                command_args, env=env, log=log, deadline=timeout_sec if timeout_sec is not None else 1800
            )
        else:
            code = await run_process(command_args, env=env, log=log, deadline=deadline)
        if check and code:
            if args[0] == "up":
                await self._compose_command(["logs", "--no-color"], check=False, timeout_sec=30)
            raise RuntimeError(f"Docker compose {args[0]} failed with exit {code}; inspect retained compose log")
        return ExecResult(return_code=code, stdout=log.read_text(errors="replace"), stderr="")

    async def stop(self, delete: bool) -> None:
        try:
            if self._egress_proxy_compose_path:
                await self._compose_command(
                    ["exec", "-T", EGRESS_PROXY_SERVICE, "sh", "-c", "cat /tmp/squid.conf /tmp/squid_access.log"],
                    check=False,
                    timeout_sec=20,
                )
            await self._compose_command(["logs", "--no-color"], check=False, timeout_sec=20)
        finally:
            try:
                await self.prepare_logs_for_host()
            finally:
                try:
                    # Pier swallows teardown errors; benchmark evidence must retain them without deleting shared images.
                    await self._run_docker_compose_command(["stop" if self._keep_containers else "down"])
                finally:
                    self._cleanup_resources_compose_file()

    async def _image_id(self, tag: str) -> str | None:
        try:
            return await asyncio.to_thread(
                command, ["docker", "image", "inspect", tag, "--format", "{{.Id}}"], timeout=30
            )
        except subprocess.CalledProcessError as error:
            if b"No such image" in (error.stderr or b""):
                return None
            raise

    async def _image_cache_key(self, tag: str) -> str:
        return await asyncio.to_thread(
            command,
            [
                "docker",
                "image",
                "inspect",
                tag,
                "--format",
                '{{index .Config.Labels "org.synergy.benchmark.cache-key"}}',
            ],
            timeout=30,
        )

    async def _run_docker_compose_command(
        self, command_args: list[str], check: bool = True, timeout_sec: int | None = None
    ) -> ExecResult:
        if self._mounts_compose_path:
            value = read_json(self._mounts_compose_path)
            value["services"]["main"]["extra_hosts"] = ["host.docker.internal:host-gateway"]
            value["services"]["main"]["platform"] = self._benchmark_identity["platform"]
            if not self._use_prebuilt:
                value["services"]["main"].update(image=self._env_vars.main_image_name, pull_policy="never")
                value["services"]["main"]["build"] = {
                    "labels": {"org.synergy.benchmark.cache-key": digest(self._benchmark_identity)}
                }
            atomic_json(self._mounts_compose_path, value)
        if command_args[0] != "build":
            scheduler = current_resources.get()
            if scheduler and command_args[0] == "up":
                native = self.task_env_config
                await scheduler.acquire(
                    self.session_id,
                    Request(
                        float(native.cpus or 1),
                        int(native.memory_mb or 1024) * 1024**2,
                        networks=2 if self._egress_proxy_compose_path else 1,
                    ),
                )
            result = await self._compose_command(command_args, check=check, timeout_sec=timeout_sec)
            if scheduler and command_args[0] in {"down", "stop"} and result.return_code == 0:
                remaining = await asyncio.to_thread(
                    command,
                    ["docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={self.session_id}"],
                    timeout=15,
                )
                if not remaining:
                    await scheduler.release(self.session_id)
            return result
        if "--no-cache" in command_args:
            raise ValueError("Frozen benchmark images cannot force-build in an existing experiment")
        entries = [("main", self._env_vars.main_image_name, self._benchmark_identity)]
        if self._benchmark_proxy:
            entries.append(
                (EGRESS_PROXY_SERVICE, "synergy-bench-egress:" + digest(self._benchmark_proxy), self._benchmark_proxy)
            )
        for service, tag, identity in entries:
            key = digest(identity)
            async with queued(
                async_cache_lock(self._benchmark_cache / "locks" / key, wait_seconds=None),
                self.session_id,
                "image_cache_lock",
            ):
                file = self._benchmark_cache / "images" / (key + ".json")
                pending = self._benchmark_cache / "images" / (key + ".pending.json")
                observed = await self._image_id(tag)
                if file.exists():
                    receipt = read_json(file)
                    if receipt["owner"] != IMAGE_OWNER or receipt["identity"] != identity:
                        raise ValueError("Image cache identity changed")
                    if observed and observed != receipt["id"]:
                        raise ValueError("Image cache content changed")
                    if observed:
                        continue
                    raise ValueError(
                        "Frozen image is missing; restore its recorded image ID "
                        "or use a new cache directory and experiment"
                    )
                elif observed:
                    intent = read_json(pending) if pending.exists() else {}
                    if (
                        intent.get("owner") != IMAGE_OWNER
                        or intent.get("identity") != identity
                        or await self._image_cache_key(tag) != key
                    ):
                        raise ValueError("Benchmark image tag exists without a valid build ownership receipt")
                started = time.time()
                if not observed:
                    atomic_json(pending, {"owner": IMAGE_OWNER, "identity": identity, "started_at": started})
                    from .resources import build_slot

                    run = getattr(self, "_benchmark_run", None)
                    plan = read_json(run / "plan.json") if run and (run / "plan.json").exists() else {}
                    limit = plan.get("config", {}).get("resources", {}).get("build_concurrency", 2)
                    async with queued(
                        build_slot(self._benchmark_cache, wait_seconds=None, limit=limit), self.session_id, "build_slot"
                    ):
                        scheduler = current_resources.get()
                        if scheduler:
                            async with queued(
                                scheduler.pool.reserve(
                                    Request(2, 4 * 1024**3), priority=int("__verifier__" in self.session_id)
                                ),
                                self.session_id,
                                "build_resources",
                            ):
                                await self._compose_command(["build", service], check=check, timeout_sec=timeout_sec)
                        else:
                            await self._compose_command(["build", service], check=check, timeout_sec=timeout_sec)
                image_id = await self._image_id(tag)
                if not image_id:
                    raise ValueError("Prepared image was not published")
                atomic_json(
                    file,
                    {
                        "owner": IMAGE_OWNER,
                        "id": image_id,
                        "tag": tag,
                        "identity": identity,
                        "started_at": started,
                        "created_at": time.time(),
                    },
                )
                pending.unlink(missing_ok=True)
        return ExecResult(return_code=0, stdout="", stderr="")
