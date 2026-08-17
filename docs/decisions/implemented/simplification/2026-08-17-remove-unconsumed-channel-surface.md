# Decision Record: Remove unconsumed channel surface

Status: implemented

## Problem

The channel domain shipped three surfaces with no production consumer:

- `ChannelHost` `status` seam (`packages/synergy/src/channel/host.ts`): providers could publish status through `host.status.update`, but no provider called it; the only caller was `test/channel/host.test.ts`. Channel core owns canonical status via the `statuses` map and `Channel.status()`.
- `Channel.Event.MessageReceived` (`packages/synergy/src/channel/index.ts`): published on message receipt but had zero subscribers in `packages/synergy/src`, `packages/app/src`, `packages/desktop`, `packages/plugin`, or `packages/ui`; it only leaked into the generated SDK surface (`packages/sdk/openapi.json`, `packages/sdk/js/src/gen/types.gen.ts`).
- `diagnostics.hasData` (`packages/synergy/src/channel/diagnostics.ts`): exported, zero callers anywhere. Its sibling `list`/`Channel.getDiagnostics` are retained.

## Decision

- Delete the `status` option from `ChannelHost.create()` and the `status` member from the host instance. `test/channel/host.test.ts` no longer exercises a status seam and asserts that creating a host leaves core status untouched; core status stays canonical via the `statuses` map and `Channel.status()`, covered by `test/channel/lifecycle.test.ts` and `test/channel/refresh.test.ts`.
- Remove `Event.MessageReceived` and its publish site. The SDK was regenerated with `./script/generate.ts`, which removed the event from the generated OpenAPI and SDK types.
- Delete `diagnostics.hasData`.

`Channel.getDiagnostics` and `diagnostics.list` remain: production uses `streamDiagnostics` for the NDJSON route (`server/channel.ts`), but the list form pins the retained-diagnostics-window behavior across `test/channel/diagnostics.test.ts` and `refresh.test.ts` — that behavior is load-bearing, not test scaffolding.

The `findProjectScope`/`ensureProjectScope`/`archiveProjectScope` wrappers remain: they are test-only today, but production host paths go through `ManagedProjectOwnership` directly; moving the wrappers to a test helper is a follow-up refactor, not part of this removal.

## Alternatives considered

- **Keep the status seam for future providers** — rejected: a seam every provider must be able to use but none uses is speculative generality; reintroducing it is a small diff when a provider needs it.
- **Keep `MessageReceived` for future subscribers** — rejected: shipping an unobserved public event grows the SDK contract and generated types; the publish site remains available if a consumer appears.
- **Keep `hasData` for symmetry with `list`** — rejected: symmetry with an unused function is not a consumer.

## Consequences

Removing `MessageReceived` shrinks the public event contract; out-of-repo SDK consumers subscribing to it (none observed) would break. The event was published but never consumed in-repo, so no internal behavior changes. Future provider work may re-add the status seam; the removed code is recoverable from history.
