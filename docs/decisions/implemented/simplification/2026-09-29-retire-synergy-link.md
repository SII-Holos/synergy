# Decision Record: Retire Synergy Link remote execution

Status: implemented

## Problem

Synergy Link added a second remote execution identity, target catalog, session lifecycle, tool selector, permission class, and Holos transport path alongside the newer Environment and Execution Host model. Bash and process calls could choose between these paths, making Scope, Workspace, and Environment ownership harder to reason about. The Link path remained live in full product composition despite no longer being the intended execution architecture.

## Decision

Synergy removes the standalone Link host and protocol packages, the sender client, target API and Settings surface, `connect` tool, Link Bash and process selectors, special execution bypass, release artifacts, and Link-specific documentation. Bash and process execution select an Environment through the existing runtime and use its containment decision and completion model. Holos identity, login, presence, messaging, and Clarus remain independent network capabilities.

A versioned storage migration removes saved `synergy_link` target records and obsolete `shell_remote_execute` permission rules. A versioned configuration migration removes the Link executor concurrency key and permission overrides from global, legacy, config-set, and registered project files before the strict current schema loads. Both migrations preserve unrelated records and JSONC comments. Historical Session tool parts and their outputs remain readable through the generic tool renderer; removing the `connect` tool does not rewrite past conversations. Existing standalone deployments outside this repository are not modified by the migration.

## Alternatives considered

**Keep Link as a deprecated transport.** This would retain two destination and session models in active code, plus the risk of Link-specific execution bypasses. It would also continue to expose a target UI and tool inputs that compete with Environment selection.

**Adapt Link targets into Environments.** The standalone host's Holos-owned identity, consent, and session lease differ from the Execution Host's allocation identity and receipt semantics. An adapter would preserve a second protocol and make Environment behavior depend on it.

**Delete all historical Link data.** Past tool results are part of Session history and may be needed to understand completed work. Only actionable target and permission state is retired; old tool parts remain inert history.

## Consequences

Existing Link targets and `connect` calls stop working after upgrade, and this repository no longer builds or releases a Link host. Users run remote shell work through configured Environments. The product has one execution destination and containment path. Holos remains available for agent network functions. Stored history may still display old Link tool names and output, but those records cannot dispatch new Link work.
