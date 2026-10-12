# Decision Record: Optional components own activation and absence

Status: implemented

## Problem

Selecting a reduced Runtime did not remove every product assumption. Import-time event definitions changed a process-global schema catalog; core Agent instructions and permissions advertised optional tools; aggregate packages brought unrelated implementation dependencies into installations. Shared migration receipts could also mark optional domain data complete before that owner was installed. Hiding navigation alone could not prevent restored tabs, deferred requests or reconnect responses from invoking absent APIs.

## Decision

Each leaf capability owns its independently publishable dependency closure, configuration, agents, tool guidance, session extensions, migrations, events, HTTP adapters and resident lifecycle. Required components are validated before storage opens. Workflows and Connections are declarative complete presets; embedding uses leaf factories or explicit component arrays. Integration packages register collaboration only when both owners are selected. See [Workflows](../../../architecture/workflows.md), [Channels](../../../architecture/channels.md) and the [package map](../../../reference/packages.md).

Definitions are inert on import. Runtime composition explicitly registers event schemas and workflow variants, then seals registration. OpenAPI describes selected owners. Public Session responses and events project only registered extensions while canonical storage retains them. Navigation refreshes its existing membership when the owner composition changes, preserving recorded activity and restoring optional identities on reinstall. The capabilities endpoint publishes stable UI features only from selected owners with registered HTTP adapters, after Runtime services are ready. Component names remain diagnostic information. Workbench reads registered resource sources without importing optional resource implementations.

Agent permission contributions receive stable registration identity, owner and builtin role. Base contributions precede user configuration; the existing visible-primary memory-write patch remains a final contribution, with explicit user permissions reapplied last. Product guidance requires the current session's permitted, available tools, including expandable tools. Generic authorization guidance stays in Harness. ACP advertises MCP only when its connected Runtime exposes that capability.

Note owns generic documents and extension data. Blueprint owns its document kind, policy, metadata and authoring instructions. Unsupported kinds remain stored but disappear from Note queries and actions. Configuration distinguishes retained stored values from the selected public projection: reads hide absent owners, writes validate visible fields and preserve hidden data, including during domain replacement. Anima owns its daily schedule and configuration. Component-created Agenda items record their required owners; absent owners suppress discovery and execution without changing stored status. Narrow historical identity parsing applies the same rule to earlier records. Versioned owner migrations catch up delayed installations without replaying shared orphan deletion. Cross-domain configuration moves durably publish the destination before removing the source and preserve explicit destination settings.

Web gates entry points and request execution on discovered features and connection epochs. A reduced selection cancels owner requests and subscriptions, clears plugin presentation and stops autosave; local drafts and retained records remain available after reinstall. A confirmed capability permits ordinary inactive Scope retention, while capability loss retires even hidden presentations. Ordinary conversation text and sent attachments remain readable while optional controls disappear. See [Frontend synchronization](../../../architecture/frontend-data-sync.md).

Availability also follows the owner of a retained operation. Blueprint remains usable when Lattice or the plugin Blueprint bridge is removed, but their loop records cannot be listed, modified, resumed or adjudicated by Blueprint recovery. A sealed Runtime source registry authorizes those operations. Session bindings and Note run metadata carry evidence-derived source projections; versioned owner catch-up uses real loop records and hides unresolved bindings without deleting them. Control messages and tool results record presentation requirements so removing a source hides its dedicated controls while preserving conversation content. The plugin Blueprint bridge publishes its own feature through the selected Blueprint HTTP adapter; installing both endpoint packages alone does not activate the integration.

Durable queue admission and continuation check the registered execution owners, including historical message origins. Unavailable work remains stored and is excluded from automatic recovery. Explicit Continue returns a conflict before changing the pause latch or reopening its rollout. A new ordinary human request starts its own task without resuming the unavailable root. The host records that independence at admission and transfers it into the canonical root, so interruption, restart or owner reinstall cannot restore the old task's authority. Execution uses a transient base Session view and never erases the retained owner fields. Owner callbacks inspect retained operation records when a completed notification no longer has a live Session binding. Runtime disposal also cancels owned Blueprint deadlines.

When a selected owner's API and page share a path, the explicit Web App adapter handles HTML document navigation for the known page paths after the normal authentication, Scope and response-security middleware. JSON requests, API methods and OpenAPI operations retain their existing route contracts. Browser acceptance waits for rendered content and successful owner requests so an API JSON response cannot masquerade as a working deep link.

Cold-start configuration preserves unregistered root and nested fields before the first public read. Legacy Library, Holos, MCP, Boss and plugin settings wait for owner-specific catch-up receipts even when historical shared receipts are complete. Plugin credentials and caches move only with Plugin Host selected, after its older catalog migrations; original stores remain intact. Legacy execution conversion consumes only registered owners' fields and retains unknown experiment settings. Blueprint alone upgrades its historical waiting phase, including delayed record access and imported sessions.

An exclusive host ConfigSource excludes migrations marked `configuration: "files"` after composition completes and before storage opens, leaving no completion receipt for ignored files. Returning to local configuration can still execute their catch-up. Plugin store migration has its own receipt and continues independently, like provider credential migration.

## Alternatives considered

**Multiple factories inside the aggregate packages.** This would change activation but leave the same installation dependency closure, masking undeclared imports and preventing independent distribution of leaf capabilities.

**Package-name checks and scattered feature booleans.** These cannot establish that an HTTP adapter or service is ready, and each presentation path would need to reconstruct composition semantics. Runtime-owned feature discovery supplies one observation for all Web surfaces.

**Deleting or coercing unknown data when an owner is absent.** That would make reinstall destructive and conflate availability with data ownership. Retained storage and public projections provide absence without changing historical identity.

**Replaying the shared Scope migration.** Its orphan reclamation has different effects from the missing Library scope conversion. A separately tracked, idempotent owner catch-up repairs delayed installation without deleting unrelated data.

## Consequences

Component development includes absence, reinstall and interleaved-Runtime behavioral tests. Composition checks inspect actual tools, agents, final instructions, events, schemas, routes, lifecycle and browser requests. Packed installations, native workers and managed Node SDK checks expose dependencies that workspace resolution can hide. The [architecture workflow](../../../../.synergy/skill/architecture/SKILL.md) and [testing guide](../../../../.synergy/skill/testing-guide/SKILL.md) define the verification procedure.

The package and release inventories grow to reflect existing capability ownership. Explicit adapters add composition choices, and configuration projection and migration require dedicated roundtrip tests. These costs keep reduced installations independent while preserving the full product selection and recoverable user data.
