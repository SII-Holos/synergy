# Decision Record: Register personal product execution contributions

Status: implemented

## Problem

Embedded hosts select their product components independently. Harness injected memory write permissions into every visible primary Agent, while Bash recognized Note paths even when the owning products were absent. Shared execution descriptions also assumed Note and scheduled follow-up tools were callable.

## Decision

Harness exposes Runtime-scoped Agent permission contributions and virtual-file provider registration. Composition seals both registries before execution. Library owns its primary memory permission policy, including explicit denials and configured recall overrides. Note owns path recognition and Markdown reads. Bash materializes only registered providers through the existing Executor staging and cleanup protocol. Shared tool descriptions and Cortex notifications describe generic files, process waiting and automatic child completion.

## Alternatives considered

**Suppress product tool names in each embedding host.** Host filtering cannot remove implicit permission grants or virtual-path dispatch and drifts from shared prompt generation.

**Remove Library and Note behavior from the full product.** Embedded hosts need independent selection; the full product retains its selected capabilities and verified execution semantics.

## Consequences

An embedded host that omits Library and Note receives neither implicit product grants nor a Note virtual-file provider. Product composition must register its contributions explicitly. The change adds two sealed registries while keeping permission resolution, sandboxing, temporary-file lifetime and history storage under their existing owners. Runtime isolation, generic task notifications, Library permission precedence and Note execution are covered by owner tests.
