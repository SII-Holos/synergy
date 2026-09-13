# Decision Record: Preserve benchmark agent inference egress

Status: implemented

## Problem

Restricted-network benchmark tasks require evaluator-managed inference egress. Invoking the Synergy runner without Pier's agent environment leaves the provider unreachable even when the allowlist and credentials are valid. Native verifier rewards from these executions cannot establish model quality.

## Decision

The [agent adapter](../../../../benchmark/src/synergy_bench/agent.py) passes `environment.agent_process_env(None)` to its runner invocation, matching the pinned Pier 0.3.1 installed-agent integration. Provider credentials retain their temporary private-file lifecycle. Setup, cleanup and verifier commands retain their own execution environments. [Adapter tests](../../../../benchmark/test/test_agent.py) cover proxy-enabled and ordinary environments together with private credential cleanup.

## Alternatives considered

**Enable general task networking.** This changes the dataset's execution conditions and bypasses its intended isolation, so the adapter preserves the original policy.

**Persist a proxy URL in experiment configuration.** Pier owns the proxy lifecycle and its ephemeral authentication. Persisting those values couples reproducible experiment inputs to one environment instance and risks retaining credentials.

## Consequences

The adapter preserves Pier's configured inference route for restricted-network tasks. Passing the environment does not by itself verify streaming transport through that proxy; provider requests and response capture still require end-to-end validation. The integration depends on the pinned evaluator API and must be verified when Pier changes. Evaluator identity changes with the adapter; prior attempts remain separate evidence and cannot be silently resumed as equivalent successful model trials.
