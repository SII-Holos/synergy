# Decision Record: Prewarm execution worker pools at server startup

Status: implemented

## Problem

The first user-visible LLM turn after a fresh runtime start, and the first tool call needing capability classification after the pools went cold, paid the full child-process cold-start cost: Bun runtime boot plus the product module graph inside the worker before `ready`, and then per-turn lazy provider/tokenizer loading. Both worker pools were created lazily by their first request (`pool ??=` in the `AgentTurn` and `PolicyWorker` facades), and the Agent pool's default warm reserve was zero, so the idle sweep retired every worker after 60 seconds and the next message repaid the same cost. The runtime architecture document already described the Policy pool as prewarmed at global-runtime startup, but no call path actually prewarmed it.

## Decision

- Server-mode runtime startup prewarms both pools immediately after `configureExecution`, before transport listen and resident start: `AgentTurn.prewarm()` constructs the Agent pool (whose constructor spawns toward the warm reserve), and `PolicyWorker.prewarm()` constructs and starts the Policy pool. Spawning is asynchronous and HTTP availability never waits on a worker handshake; one-shot runtimes and the in-process test adapter stay cold.
- Startup also warms the tokenizer encoding for the resolved default model in the background, so the first prompt-budget measurement does not lazily import the BPE rank data.
- The default Agent warm reserve (`execution.agentWorkerMinIdle`) moves from 0 to 1, so idle-timeout and turn-count recycling replace the warm worker instead of emptying the pool; memory-constrained deployments set it back to 0.
- Both pools record a `agent.worker.ready_latency` / `policy.worker.ready_latency` duration metric at every worker `ready`, making cold-start cost and prewarm effect observable in the performance catalog.

## Alternatives considered

- **Protocol-level prewarming messages that push provider plans into idle workers** — rejected: it requires a wire-format version bump for marginal benefit, because a warm worker already carries the SDK cache and the first turn's provider plan rebuild is cheap relative to process cold start.
- **Raising `agentWorkerIdleTimeoutMs` instead of the warm reserve** — rejected: it keeps workers alive without need, still leaves the very first message after startup cold, and the reserve expresses the intent directly as an already-validated configuration field.
- **Awaiting worker readiness before the transport listens** — rejected: it couples HTTP availability to child-process handshakes and makes a broken worker executable block startup; prewarm deliberately races with extension initialization and transport listen instead.

## Consequences

Server startup now overlaps worker module loading with extension initialization and transport listen, so the first turn and first classification normally find a ready worker; one-shot CLI invocations stay cold by design. A resident server permanently holds at least one warm Agent worker and the Policy pool's workers, trading bounded resident memory for first-message latency; the cost stays tunable through `execution.agentWorkerMinIdle` and `execution.policyWorkers`. A worker that cannot start now fails inside the background prewarm and surfaces through the existing startup circuit and retry machinery instead of at the first message — same failure mode, observed earlier. The ready-latency metrics quantify remaining cold-start cost per platform, and prewarm is deliberately skipped in tests so suites never pay worker spawn costs they do not exercise.
