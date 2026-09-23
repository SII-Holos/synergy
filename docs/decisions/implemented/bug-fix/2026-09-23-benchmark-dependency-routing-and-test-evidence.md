# Decision Record: Explicit dependency routing and positive test evidence

Status: implemented

## Problem

Native verifier setup can fail before tests start when task containers cannot reach dependency hosts. A working host proxy does not make a loopback listener reachable from Docker. DeepSWE then synthesizes failed CTRF entries for missing results, which the evaluator previously counted as executed tests. The [incident](../../../postmortem/0025-benchmark-verifier-dependencies-and-missing-tests.md) also shows why a model-modified lockfile and an offline verifier require a different diagnosis from an ordinary DNS failure.

## Decision

The evaluator accepts an optional `dependency_proxy_env` reference to an HTTP proxy without URL credentials. It forwards a host loopback proxy through a temporary listener bound to the Docker bridge and propagates proxy variables only to native internet-enabled environments. Cancellation closes active relay connections. Native no-network policies, inference routing, product source and verifier assertions remain unchanged.

The plan retains a digest of the configured upstream route. Resume rejects a changed route, and paired report conditions include that identity. Free deterministic socket and Docker tests verify forwarding, scope and cleanup; formal execution still starts directly without paid probes or a new admission phase.

Positive test evidence excludes explicit `missing from report (...)` placeholders and lists their counts separately. Native reward and raw reports remain immutable. An authorized regrade uses retained output in a separate attempt with declared dependency differences; it cannot retroactively turn the original attempt into a clean success.

## Alternatives considered

**Inherit every host proxy or change Docker globally.** This makes an undeclared host setting affect results and can widen a task's network permissions or affect unrelated containers. Explicit run configuration keeps ownership and reproducibility visible.

**Enable internet for offline verifiers.** This hides missing image dependencies and changes the native task policy. Dependency-only regrading instead declares any supplied package cache while retaining offline verification.

**Trust every failed CTRF row as an executed test.** Synthesized rows cannot distinguish a build failure from a failed assertion. Raw results and positive execution evidence remain separate.

**Rerun the full matrix after each evaluator repair.** The user authorized only affected executions. Selected supplemental cells preserve healthy results and retain both historical cost and different evaluator provenance.

## Consequences

Ordinary internet-enabled tasks can use the operator's proxy without a host-wide mutation. Dependency failures still remain possible and are retained; a successful connectivity check is not proof that every future download succeeds. The relay adds a run-owned service and therefore needs explicit cleanup tests. Proxy configuration does not supply dependencies to intentionally offline tasks.

Missing-test placeholders no longer inflate observed test counts. A repeated execution or regrade has its own source and conditions, so the final study remains an explicitly combined dataset rather than an invented single clean run. The root README continues to route benchmark usage to the package README; its product overview does not change.
