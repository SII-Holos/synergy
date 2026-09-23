from __future__ import annotations

import asyncio
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from pier.environments.base import BaseEnvironment
from pier.environments.factory import EnvironmentFactory
from pier.models.agent.context import AgentContext
from pier.models.task.config import ArtifactConfig, StepConfig
from pier.models.task.config import EnvironmentConfig as TaskEnvironmentConfig
from pier.models.task.task import Task
from pier.models.task.verifier_mode import resolve_effective_verifier_env_config
from pier.models.trial.config import TrialConfig
from pier.models.verifier.result import VerifierResult
from pier.trial.execution import AgentTimeoutError
from pier.trial.trial import Trial, VerifierTimeoutError
from pier.verifier.verifier import Verifier

from .agent import SynergyAgent
from .lifecycle import Lifecycle
from .storage import atomic_json, read_json


class VerifierPreparationError(RuntimeError):
    pass


class BenchmarkTrial(Trial):
    """Pier 0.3.1 lifecycle correction; see third_party/pier/NOTICE for provenance.

    Keep verifier setup separate from its execution budget, and commit its reward before
    container cleanup. A timed-out verifier is a result, never an automatic retry.
    """

    def __init__(self, config: TrialConfig, *, _task: Task | None = None) -> None:
        super().__init__(config, _task=_task)
        self._cleanup_seconds = float(config.agent.kwargs["settings"]["cleanup_seconds"])
        self._verifier_environments: list[BaseEnvironment] = []
        self._lifecycle = Lifecycle(self._trial_paths.trial_dir.parent)

    async def _setup_environment(self) -> None:
        deadline = self.config.agent.kwargs["settings"].get("preparation_timeout_seconds", 1800)
        async with self._lifecycle.stage("environment_preparation", deadline=deadline):
            await super()._setup_environment()

    async def _setup_agent(self) -> None:
        async with self._lifecycle.stage("harness_setup", deadline=self._AGENT_SETUP_TIMEOUT_SEC):
            await super()._setup_agent()

    async def _execute_agent(self) -> None:
        try:
            async with self._lifecycle.stage("agent", deadline=self._execution.agent_timeout_sec):
                await super()._execute_agent()
        except TimeoutError as error:
            raise AgentTimeoutError(
                f"Agent execution timed out after {self._execution.agent_timeout_sec} seconds"
            ) from error

    async def _collect_artifacts(self) -> None:
        async with self._lifecycle.stage("artifacts", deadline=300):
            await super()._collect_artifacts()

    async def _run_verification(self) -> None:
        preparation = self.config.agent.kwargs["settings"].get("preparation_timeout_seconds", 1800)
        async with self._lifecycle.stage("verifier", deadline=preparation + self._verifier_timeout_sec + 1):
            await super()._run_verification()

    def _maybe_populate_agent_context(self, agent_result: AgentContext | None) -> None:
        if agent_result is not None and isinstance(self._agent, SynergyAgent):
            self._agent.populate_context_post_run(agent_result)
            return
        super()._maybe_populate_agent_context(agent_result)

    async def _verify_with_retry(self) -> None:
        try:
            self.result.verifier_result = (
                await self._verify_once(step_cfg=None)
                if resolve_effective_verifier_env_config(self._task.config, None) is not None
                else await asyncio.wait_for(self._verify_once(step_cfg=None), timeout=self._verifier_timeout_sec)
            )
        except TimeoutError as error:
            raise VerifierTimeoutError(
                f"Verifier execution timed out after {self._verifier_timeout_sec} seconds"
            ) from error

    async def _verify_with_separate_environment(
        self,
        env_config: TaskEnvironmentConfig,
        *,
        key: str,
        step_cfg: StepConfig | None,
        verifier_env: dict[str, str] | None,
        artifacts_dir: Path,
        artifacts: Sequence[str | ArtifactConfig] | None = None,
    ) -> VerifierResult:
        environment = self._new_verifier_environment(env_config, key=key, step_cfg=step_cfg)
        env_paths = environment.env_paths
        deadline = self.config.agent.kwargs["settings"].get("preparation_timeout_seconds", 1800)
        try:
            async with self._lifecycle.stage("verifier_preparation", deadline=deadline):
                await environment.start(force_build=False)
                await environment.empty_dirs([env_paths.verifier_dir], chmod=True)
                await self._artifact_handler.upload_artifacts(
                    environment,
                    artifacts_dir=artifacts_dir,
                    source_artifacts_dir=self._environment.env_paths.artifacts_dir,
                    target_artifacts_dir=env_paths.artifacts_dir,
                    artifacts=artifacts,
                )
        except TimeoutError as error:
            raise VerifierPreparationError("Verifier environment preparation timed out") from error
        async with self._lifecycle.stage("verifier_execution", deadline=self._verifier_timeout_sec):
            return await Verifier(
                task=self._task,
                trial_paths=self._trial_paths,
                environment=environment,
                override_env=self.config.verifier.env or None,
                logger=self._logger,
                skip_tests_upload=True,
                verifier_env=verifier_env,
                step_name=step_cfg.name if step_cfg is not None else None,
            ).verify()

    def _new_verifier_environment(
        self,
        env_config: TaskEnvironmentConfig,
        *,
        key: str,
        step_cfg: StepConfig | None,
    ) -> BaseEnvironment:
        environment = EnvironmentFactory.create_environment_from_config(
            config=self.config.environment,
            environment_dir=self._verifier_env_build_context(step_cfg),
            environment_name=self._task.name,
            session_id=self._separate_verifier_session_id(key),
            trial_paths=self._trial_paths,
            task_env_config=env_config,
            logger=self._logger,
            mounts_json=self._verifier_env_mounts(env_config),
            agent_install_spec=None,
            network_allowlist=None,
            default_user=(
                step_cfg.verifier.user
                if step_cfg is not None and step_cfg.verifier.user is not None
                else self._task.config.verifier.user
            ),
        )
        self._verifier_environments.append(environment)
        return environment

    async def _stop(self, environment: BaseEnvironment, *, delete: bool) -> None:
        try:
            # Pier's delete=True removes all compose images, including shared task images.
            await asyncio.wait_for(environment.stop(delete=False), timeout=self._cleanup_seconds)
        except Exception as error:
            file = self._trial_paths.agent_dir / "environment-cleanup.json"
            record: dict[str, Any] = read_json(file) if file.exists() else {"status": "failed", "errors": []}
            record["errors"].append(type(error).__name__)
            atomic_json(file, record)

    async def _stop_agent_environment(self, *, keep_images: bool = False) -> None:
        if self._is_agent_environment_stopped:
            return
        await self._stop(self._environment, delete=self.config.environment.delete and not keep_images)
        self._is_agent_environment_stopped = True

    async def _cleanup_verifiers(self) -> None:
        await asyncio.gather(
            *(
                self._stop(environment, delete=self.config.environment.delete)
                for environment in self._verifier_environments
            )
        )
        self._verifier_environments.clear()

    async def _cleanup_and_finalize(self) -> None:
        await self._cleanup_verifiers()
        await super()._cleanup_and_finalize()
