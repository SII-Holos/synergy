# Decision Record: OpenAPI spec generation is a per-process singleton

Status: implemented

## Problem

CI failed deterministically on an unrelated PR with `TypeError: undefined is not an object (evaluating 'providerListSchema.properties')` in `openapi.test.ts:20`. Root cause: `hono-openapi`'s `getSpec` consumes each route's `describeRoute`/`resolver` schema entry in place during generation — the first call replaces the registered resolver with the resolved `$ref` plain object, so a **second** `generateSpecs` call in the same process emits paths whose `$ref`s have no backing components. The `/doc` route handler cached its own copy via `openAPIRouteHandler`, while `Server.openapi()` (`openapi()` in `packages/synergy/src/server/server.ts`) regenerated from scratch; any process that served `/doc` and later called `Server.openapi()` produced a componentless spec. The trigger was a new compression test requesting `/doc` — the first test-file-level `/doc` consumer, which reshuffled the Bun test shard so the failure appeared on a seemingly unrelated PR.

## Decision

Make spec generation once-per-process a public invariant instead of an implicit assumption:

- `Server.openapi()` memoizes the build in a module-level `_openapiSpecs` promise; all callers (`/doc` route, CLI `generate`, tests) share one cached spec.
- The `/doc` route no longer uses `openAPIRouteHandler` (which maintained a separate untyped cache) and simply serves `openapi()`, keeping a single generation path and a single set of metadata (`version: "1.0.0"`).
- A regression test (`survives a /doc request earlier in the same process` in `packages/synergy/test/server/openapi.test.ts`) pins the ordering property: requesting `/doc` first must not strip components from a later `Server.openapi()` call.

## Alternatives considered

- **Drop the `/doc` cache and regenerate per request** — rejected: it keeps the double-generation landmine for any later consumer and pays a full spec rebuild per request.
- **Patch hono-openapi to snapshot resolvers before rewriting** — rejected for now: the mutation is upstream design (vendored in `node_modules`, not our source), and the singleton removes the failure class with far less surface.

## Consequences

Spec generation cost is paid at most once per process; `/doc`, CLI `generate`, and tests are guaranteed byte-identical output. Any future route/test that generates specs alongside `/doc` is safe. The trade-off: in-process spec mutation after the first generation (e.g. a plugin registering new routes at runtime and expecting `/doc` to reflect them) is no longer observed; no current code path depends on that.
