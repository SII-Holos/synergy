# Decision Record: Independent benchmark harness and model dimensions

Status: implemented

## Problem

An experiment that couples the model to Synergy configuration cannot measure whether improvements come from the harness or the model. Native CLI summary events also omit some auxiliary requests. Counting only a successful retry conceals the cost of unsuccessful attempts.

## Decision

[Configuration v2](../../../../benchmark/src/synergy_bench/config.py) declares native harness variants and model profiles separately. Matrix cells retain independent task and repeat identities. Five [native configurations](../../../../benchmark/src/synergy_bench/harnesses.py) preserve the upstream CLI loop, tools and prompts. Package versions, frozen source, runtime composition and generated configuration are experimental conditions.

OpenCode variants can explicitly set `bun_jit`; omission preserves the native default, while false sets `BUN_JSC_useJIT=0` in the retained native process configuration. The [Bun option distinction](https://github.com/oven-sh/bun/issues/22901) informs this mapping; it does not establish the cause of every runtime stall. The strict boolean belongs to the harness axis, applies equally to each selected model, and is rejected for unverified harnesses. Actual CLI integration exercises both default and interpreted variants over both model protocols.

A host [inference gateway](../../../../benchmark/src/synergy_bench/gateway.py) records durable dispatch intent and raw responses for every provider request. Credentials remain on the host; an ephemeral capability authenticates each isolated task. A versioned [protocol bridge](../../../../benchmark/src/synergy_bench/bridge.py) converts Responses and Chat Completions messages, tools and streams without adding an agent loop or context compaction. Unsupported features fail explicitly. Codex's hosted web search is disabled in its native configuration because a Chat Completions endpoint cannot execute that hosted tool.

Native transport evidence is cross-checked against the gateway. Native CLI extensions install observers after the CLI configures its transport. Repeated installation is idempotent. Synergy retains its public rollout and accounting contracts. Result v3 separates execution, native reward, verifier execution, positive evidence of test startup, archive validity and usage completeness.

The [report](../../../../benchmark/src/synergy_bench/report.py) counts all retained attempts, including preflight calls, while selecting the first model execution for scoring. Unknown usage retains known lower bounds. Paired comparisons require matching model, task, repeat and experimental conditions, expose missing pairs, and use seeded task-cluster bootstrap. Native reward observations receive Wilson intervals; missing rewards produce success bounds rather than invented scores.

Completed request usage is not a finalized attempt total while the attempt lacks terminal evidence. Live and interrupted snapshots retain the observed token lower bound and original per-request unknown count; they cannot assert complete consumption or invent an extra unknown request merely because the lifecycle is unfinished.

Native startup timeouts may create up to three automatic attempts only when native lifecycle evidence confirms no model execution, the entire request ledger is empty, the archive is complete and cleanup has no reported failure. Each attempt retains its terminal evidence, retry reason and 1/2-second backoff. Task startup budgets survive recovery; a new explicit doctor invocation records its own reason. Possible delivery, incomplete evidence and post-dispatch failures remain outside this path.

Each attempt starts its own queue clock before resource admission. Prior execution and teardown never become the next attempt's queue latency; retry backoff remains a separately retained value.

## Alternatives considered

**Run every model through Synergy's loop.** This would compare model behavior but remove the native harness differences the experiment needs to measure.

**Use native CLI final summaries as the only bill.** Helpers, compaction, retries and interrupted streams do not consistently appear in those summaries. Independent request intent and raw response evidence are needed for reconciliation.

**Treat provider compatibility as an agent adapter detail.** A named, versioned bridge makes wire conversions reviewable and keeps them separate from each CLI's execution behavior.

**Score the latest or best attempt.** This changes the effective sampling policy after outcomes are visible and hides failed attempt costs.

**Automatically disable JIT after a native stall or on an emulated host.** This would change execution conditions during an experiment and conceal the cost of the stalled attempt. Explicit named variants retain the original execution and make the new runtime choice reviewable.

## Consequences

This adds explicit transport and installation maintenance for each pinned upstream release. Unsupported model features remain visible errors. A bridge cannot preserve features that the target protocol cannot represent; its identity and restrictions belong in experimental conditions. Native model failures remain valid benchmark outcomes when execution and recording are intact. Historical runs remain read-only under changed evaluator contracts.

Interpreted OpenCode can have different CPU, memory and latency behavior. It is an experimental runtime option, not a general guarantee against native hangs. A diagnostic variant cannot replace a preselected scoring attempt or repair its missing native usage.
