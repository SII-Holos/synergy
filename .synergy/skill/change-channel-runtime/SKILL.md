---
name: change-channel-runtime
description: Add, modify, or review Synergy Channel targets, provider lifecycle, managed Project ownership, ChannelHost Scope/Session routing, native Clarus task handling over Holos, durable result or extension delivery, Channel diagnostics and routes, or Channel account navigation. Use across packages/synergy/src/channel, adjacent Holos/Session/Agenda/server owners, generated SDK contracts, and packages/app Channel surfaces.
---

# Change the Channel Runtime

## Trace the Contract

1. Read [Channels](../../../docs/architecture/channels.md), [Sessions and messages](../../../docs/architecture/session-and-messages.md), [Connections](../../../docs/product/connections.md), and the nearest package `AGENTS.md` files.
2. Classify the provider as `chat` or `task_only`, and its lifecycle as `self_connected` or `borrowed_transport`.
3. Trace target identity, provider configuration, account start/stop/status, `ChannelHost`, managed ownership, Session endpoint lookup, inbox delivery, navigation projection, routes, generated SDK consumers, diagnostics, and recovery state.
4. Load `change-persistence` for ownership, indexes, provider-private state, or outboxes; `change-server-api` for routes or generated contracts; `develop-frontend` for account/navigation UI; `add-tool` for first-party Channel tools; and `develop-synergy` for isolated runtime verification.

## Preserve Ownership

1. Keep Scope and Session creation in Channel core. A project/task-capable provider reports remote facts through `ChannelHost`; it does not call Scope, Session, or model execution directly.
2. Use typed `ChannelTarget` identity for new chat, Project, and Task endpoints. Preserve existing Feishu legacy endpoint keys and Home-Scope behavior byte-for-byte.
3. Keep task-only Project targets as ownership/navigation identity only. Discovery and Project-level events must not create a Project conversation Session or invoke a model.
4. Map each external Project identity to one canonical managed Project Scope with hashed forward and reverse ownership indexes. Keep raw external IDs out of path components, reject path escape and symbolic links, initialize an independent Git repository, and never remove a Scope in response to remote archive.
5. Map one external Task ID to one stable unattended Session in its managed Project Scope. Deliver assignments and updates through the persistent inbox with deterministic delivery keys; keep participation and deadline guidance hidden and system-authored.

## Preserve Native Clarus Semantics

1. Borrow the existing authenticated Holos Agent Tunnel through `HolosRuntime.getNativeTunnel()`. Do not add another WebSocket, reconnect loop, credential owner, daemon, or Holos server change.
2. Validate account identity, process epoch, connection generation, event schemas, request correlation, and acknowledgement identity at the transport boundary. Dispose observers and in-flight work on account stop or transport replacement.
3. Treat Clarus as task-only. Accept subscription state and runtime Task events; classify legacy Project message, file, system, and notary events as unknown without Session delivery.
4. Persist result and extension outbox records before dispatch. Only `not_dispatched` may retry automatically with a fresh request ID and lineage; `rejected`, `ambiguous`, and `acknowledged` are terminal for automatic retry. Recovered `pending` records become `ambiguous`.
5. Keep remote Project pause as display/protocol state for already accepted work. Use the standard Session Abort path for local cancellation, and keep accepted-task result, extension, and deadline behavior available while remotely paused.
6. Use Agenda `session_guidance` only for durable hidden steering into the owning Task Session. It must not create an Agenda execution Session or a visible fake user prompt.
7. Keep `clarus-agent-participation` available as a memory-backed builtin Skill in a fresh `SYNERGY_HOME`. Its content must describe only the native assignment Session and result/extension tools; do not bundle standalone listener, CLI, daemon, credential, or second-WebSocket workflows.

## Keep API and Product Projection Complete

1. Add precise route schemas and OpenAPI metadata for Channel account actions, then regenerate the SDK and migrate ordinary Web calls to generated methods. Keep diagnostics downloads on the established file/blob path.
2. Bound and redact durable diagnostics before persistence and export. Never expose credentials, auth headers, raw local paths, or unbounded prompt/result payloads.
3. Project managed Projects once under the owning Channel account from canonical Scope/Session navigation state. Do not add a provider-specific Project store, duplicate generic Projects, or a dedicated Clarus hierarchy.
4. Present provider-capability actions, account and remote Project states, semantic icons, keyboard access, localized labels, and archive-guard guidance through shared components.
5. Update [Channels](../../../docs/architecture/channels.md), product connection/workspace docs, storage paths, and `packages/app/PRODUCT.md` when their contracts change.

## Verify

1. Write the smallest failing behavioral test first. Use real temporary Scope, Storage, Session, inbox, Agenda, and filesystem state; fake only Holos/Clarus network boundaries.
2. Run the focused Channel, Holos native tunnel, Session endpoint/navigation, Agenda guidance, tool, server route, and frontend account/navigation tests affected by the change.
3. Run `bun test test/channel/` and the relevant Holos, Agenda, Session, tool, and server suites from `packages/synergy`; preserve Feishu compatibility coverage.
4. For route changes, run `./script/generate.ts` twice and confirm generated OpenAPI/SDK output is stable. Run App/UI tests, localization checks, typecheck, build, Skill validation, and `bun run quality:quick` as applicable.
5. Exercise the protocol in an isolated second runtime with a separate `SYNERGY_HOME` and explicit ports. Verify disabled and zero-Project idle behavior, discovery, one Task Session per Task ID, result/extension settlement, reconnect recovery, diagnostics download, and cleanup without using the active runtime.

## Handoff

Report provider shape and lifecycle, target identity, Scope/Session ownership, durable state and recovery semantics, routes/SDK/UI wiring, focused and broad checks, isolated runtime evidence, and any environment-only limitation.
