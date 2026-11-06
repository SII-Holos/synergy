# Decision Record: Bind Oryn publication to its execution artifact

Status: implemented

## Problem

Oryn execution and publication can be retried separately. Reusing a result name across Actions attempts can leave publication with an ambiguous artifact, while a full rerun needs to replace the original plan. A model result is useful only when publication can identify its producing execution and still owns the corresponding admission.

## Decision

The [item workflow](../../../../.github/workflows/oryn-item.yml) exposes the result upload's artifact ID as a job output and its publisher downloads that ID directly. Include the Actions attempt in result names for inspection. Replace the plan artifact when planning runs again. Treat an outcome artifact as non-publishable alongside failure artifacts. Keep read-only model execution, separate App publication tokens, source checks and serialized receipt admission.

Pin the published Oryn revision that distinguishes normal invalidation from failure, assigns unique admission lease IDs and reserves reporting time for schema-validated output. Incomplete evidence requires human review and cannot authorize an action. Runtime behavior remains owned by the immutable [setup pin](../../../../.github/actions/setup-oryn/action.yml). Runtime contract changes are published before a consumer pin upgrade, and historical reruns retain historical code. The [operations guide](../../../operations/oryn.md) owns retry and rollout instructions; local workflow verification does not establish a live model or publication result.

## Alternatives considered

**Choose a result by its shared name.** Separate attempts can create multiple producers; the upload ID is already available and directly identifies the result.

**Automatically reacquire a receipt in execution.** That would move admission writes into the model job, weaken credential separation and permit old plans to consume new budgets without fresh planning.

## Consequences

A publisher consumes exactly its producing execution's files, including failure or normal outcome artifacts. Missing artifacts fail visibly. Planning can rerun without upload-name conflicts, while historical result artifacts retain their attempt identity. The runtime source must be published before a consumer pin upgrade. Historical workflow reruns retain historical code; start a fresh workflow after upgrading and keep all receipt writers on the same contract.
