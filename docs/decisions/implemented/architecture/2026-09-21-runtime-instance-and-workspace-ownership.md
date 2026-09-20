# Decision Record: Runtime instances and explicit workspace ownership

Status: implemented

## Problem

Package separation cannot provide independent runtimes while imports mutate global registries and configuration, storage, events and background resources belong to the process. Runtime closure then risks interfering with another host or leaving callbacks against closed storage. Treating every Scope as a directory also makes Home and missing projects implicit filesystem execution targets, coupling conversation ownership to local execution.

## Decision

The lifecycle accepts three explicit inputs: an immutable Host, a composition and storage ownership. Composition runs inside a new Runtime context and seals before startup. Registries and mutable services use instance state; imported modules do not activate capabilities. Local and full product hosts share the lifecycle while selecting their own capabilities. Workers receive explicit host and execution state and initialize their composition at their entrypoint. The public lifecycle and its ownership rules live in [Runtime and Scope](../../../architecture/runtime-and-scope.md).

A Runtime owns its admission, resources, tasks and teardown. Opening failure unwinds acquired resources. Closing rejects new work, cancels and drains execution, disposes services and Scope resources, and closes owned storage before releasing Home ownership. Borrowed storage remains caller-owned. Bound callbacks retain their Runtime; nested Scope and observability contexts cannot cross owners. Process history and completion tracking serve distinct purposes: removing visible history does not release a child process or its output drain. Native HTTP handlers are replaced outside the Runtime after transport drainage because the supported Bun version retains their creation context after stopping. Database maintenance timers are owned and stopped with their connection.

Scope owns identity and data; its nullable local binding describes filesystem capability. Session workspace is required and nullable. Home has no local workspace, children inherit an explicit parent binding, and a missing or archived project retains readable history while execution fails before input writes. Workspace capability checks apply both to tool discovery and retained handles and are independent of permission profiles. Plugin and MCP tools default to requiring a workspace unless explicitly declared otherwise.

Scope ID is the event and client ownership key. Runtime-wide events use a null Scope ID. Frontend persisted selections resolve legacy directory references at the owning migration boundary, then use the connection and stable Scope identity. Scope metadata upgrades eagerly and Session workspace upgrades on access, including deferred import, preserving message and rollout storage paths.

## Alternatives considered

**Keep one process-global runtime and require subprocess isolation.** This prevents a research host or embedded client from composing core and full instances together and leaves import order as an application contract. Separate processes remain useful for model and policy execution, but do not substitute for explicit ownership in the host.

**Retain old and new execution paths behind a mode flag.** This doubles lifecycle, migration and error behavior during the highest-risk architectural change. The implementation uses one lifecycle and explicit compositions; compatibility normalization stays at persisted-state and client migration boundaries.

**Treat a missing workspace as Home or the launch directory.** This lets a request execute against a different directory than its persisted identity. Explicit null bindings and unavailable-workspace errors preserve ownership without adding directory guesses to each caller.

**Rewrite all session history at startup.** This scales startup cost with historical messages and rollout evidence. Metadata and access-time upgrades preserve the existing prepare/migrate/validate/activate storage sequence without a new full-history startup pass.

## Consequences

Hosts and tests must supply their environment, composition and storage owner explicitly. Tests exercising environment-dependent behavior construct an owner with that environment instead of mutating process variables after startup. Pure logic tests need no Runtime.

Executable discovery and its cache belong to the Host, including benchmark preparation before product startup. Build-time helper digest tables contain artifact identities, without resolving Home during module evaluation. Conditional and platform-specific tests must construct their Runtime just as ordinary tests do; source imports on a developer machine alone cannot validate compiled entrypoints. Home-safe plugin templates explicitly declare that their tools do not require a workspace.

Behavioral validation targets independent instances, startup failure and cancellation, resource drain, nullable workspaces, retained tool guards, preserved history and client identity. Real process and HTTP fixture tests exercise executable entrypoints, worker protocols and shutdown without paid model calls. Performance comparisons use isolated Homes and the same workload on the base and changed revisions; unit test counts are not evidence of startup or memory performance. The [validation report](../../../research/2026-09-21-runtime-instance-validation.md) records the workloads, observed results and evidence limits.

The split changes generated API schemas and the Browser protocol because local paths are nullable and Scope ID is canonical. SDK generation, worker bootstrap, CLI and installed artifacts must stay aligned with their composition; import-time registration cannot be used as a compatibility path.
