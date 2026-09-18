# Decision Record: One shared tool-timeout contract, owned by `util`

Status: implemented

## Problem

The tool-timeout observation — how long a tool call may run, which smaller operation window is currently in force, and what that window means — was produced by the runtime and rendered by the shared UI through two hand-maintained, unlinked definitions.

`packages/harness/src/tool/timeout.ts` declared `ToolTimeout.Metadata` with a ten-member `Source` union. `packages/ui/src/components/tool/timeout.ts` re-declared the same shape locally with every field optional and `source: string`, then read it through an unchecked cast. Nothing tied the two together: a change on the producer side could not break the consumer, and the consumer accepted source values the producer cannot emit.

The duplication was structural, not careless. `packages/ui` may not import runtime-private modules, and its only workspace dependencies are `plugin`, `sdk`, and `util` — so there was no legal import path for the shared shape. Worse, the consumer used only `displayMs` and ignored `source`, `toolTimeoutMs`, and `operationTimeoutMs` entirely. Because `source` names what the window actually is, a window that hands a command to the background (`auto_background`) rendered as `Ns timeout` — the badge claimed an abort that does not happen. The same read path also collapsed the window to `displayMs`, so the operation window and the execution budget were indistinguishable to every renderer.

Nothing in `docs/decisions/` had ever recorded this contract. It had accumulated through repeated local fixes rather than a decision, which is why the producer, the consumer, and the tool descriptions could each hold a different belief about the same field.

## Decision

The timeout contract is defined once in `packages/util/src/tool-timeout.ts` as `ToolTimeoutSource` and `ToolTimeoutMetadata`, and both sides import it: the runtime re-exports it through `ToolTimeout` to keep existing call sites on `ToolTimeout.Metadata`, and the shared UI imports it directly and drops its local declaration and cast.

`packages/util` is the owner because the dependency direction is already acyclic and needs no new edge: `harness → util` and `ui → util` both exist. It is a leaf package, so no runtime concern leaks into the frontend graph.

Field names keep their `Ms` suffix and millisecond units. The object is persisted on tool parts and re-read from history, so renaming would strand the observation on every already-stored part; it is also neither agent- nor human-facing, so the repository's seconds-at-the-boundary convention does not apply to it.

`displayMs` keeps its meaning — the smaller operation window when one exists, otherwise the execution budget — but `source` becomes load-bearing: renderers use it to decide what the window is, not merely how long. The contract is deliberately not published through `packages/plugin`: exposing it would turn an internal diagnostic bag into a versioned plugin API with no plugin consumer.

## Alternatives considered

- **Add the type to `packages/harness` and let the UI import it** — rejected: `packages/ui` cannot depend on `harness` without pulling runtime-private modules into the frontend build, and adding that dependency would invert the package boundary the shared-UI contract depends on.
- **Expose the shape through `packages/plugin`** — rejected: `plugin` is a published, versioned author API. The timeout observation has no plugin consumer, so this would create manifest and versioning obligations in exchange for nothing.
- **Rename the fields to `*Seconds` for consistency with the boundary convention** — rejected: the fields are persisted in part metadata. Renaming requires a migration to re-read history, and the convention targets agent- and human-facing surfaces, which this is not. Consistency is better served by one entry point than by one unit.
- **Add a Zod schema with `.meta({ ref })` and nest it into `state.metadata`** — rejected: that publishes the shape into `packages/sdk/openapi.json` and the generated SDK, expanding the change into an API-compatibility surface. A compile-time-only alias removes the duplication with zero wire change.
- **Derive the shared type from the runtime module and re-export it from `util`** — rejected: `util` cannot import `harness`; the direction is the reverse.

## Consequences

- One definition exists. A change to the shape now surfaces as a compile error on both sides instead of drifting silently.
- `packages/ui/src/components/tool/timeout.ts` no longer declares a weaker copy, and its cast is gone. Metadata on `ToolProps` and `BasicToolProps` is typed as `Record<string, any> & { toolTimeout?: ToolTimeoutMetadata }`, so plugin-authored renderers keep reading their own keys while the timeout entry gains a shared shape.
- The renderer can distinguish an operation window from an execution budget for the first time, which is what lets `source` drive honest countdown labels.
- `packages/util` becomes the owner of a contract it does not produce. That is the cost of the boundary: the producer stays in the runtime, and only the shape is shared.
- No generated artifact changed. `packages/sdk/openapi.json` and `packages/sdk/js/src/gen/types.gen.ts` are untouched because `state.metadata` remains an open record in the published schema.
