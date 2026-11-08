---
name: change-server-api
description: Add or modify a Synergy HTTP route, request/response schema, OpenAPI operation, generated SDK method, frontend API call, scoped snapshot, upload/download endpoint, or stream boundary. Use for packages/server/src/server, packages/sdk, or apps/web calls to internal server APIs.
---

# Change a Server API

## Trace the Contract

1. Inspect the nearest route, its owning domain service, route tests, generated SDK method, and every first-party consumer.
2. Decide whether the route is global, home-scoped, project-scoped, session-owned, or workspace-owned. Preserve Scope/directory resolution and authorization.
3. Decide whether the behavior is request/response state, a sequenced state event, or a streaming transport. Do not force WebSocket, SSE, WebRTC, file/blob, or external URL behavior into an ordinary SDK call.

4. Check the `operationId` for a generated-method collision before implementing. The generator keys a method by the id's first two segments with a leading `global.` stripped, so `global.session.status` and `session.status` both resolve to `Session.status` — the generated method silently retargets one route and the other disappears from the SDK entirely, with no build error. Give the newer route a non-colliding id (`global.session.statuses`, not `global.session.status`) and confirm after regeneration that both methods exist and target their own paths.

## Implement

1. Validate path, query, form, and body input with precise Zod schemas.
2. Add `describeRoute` metadata, stable `operationId`, response schemas, and structured error responses. Add `.meta({ ref: "TypeName" })` for reusable API-visible schemas.
   For credential-bearing routes, replace validator response hooks that echo submitted data with the owning structured error. Exercise malformed bodies containing secret-like values and confirm neither responses nor logs reproduce them. Declare required request bodies in mounted OpenAPI metadata and test the generated caller; runtime validation alone does not make the SDK argument required.
3. Keep business logic in the owning domain rather than the route handler. For binary media, document the supported MIME types, preserve structured error reasons and propagate the request abort signal. Test the generated SDK blob path as well as the mounted route; request previews must use saved owner configuration without creating task sessions.
4. For state changes, persist first and publish the established event shape so frontend state can reconcile without per-event refetches.
5. Preserve scoped snapshot watermark headers where middleware supplies them. Do not claim Web snapshot gating that the client does not implement.
   Optional owner schemas must also project actual HTTP and event payloads. Use `Session.publicInfo()` at Session response boundaries; internal reads, imports and archive exports retain canonical metadata. Verify owner selection, absence while a different owner remains selected, ordinary mutation, and reinstall against the same stored records. Dynamic schema facades must retain named OpenAPI references on the facade itself so generated SDK body argument names remain stable.
6. Regenerate contracts from the repository root:

```bash
./script/generate.ts
```

7. Replace or add frontend calls through `createSynergyClient()` / the generated SDK. Preserve auth, Scope/directory parameters, errors, and asset URL formats.

## Verify

1. Test validation, success, domain error, Scope ownership, and event behavior at the narrowest route/domain level.
   Hold transient domain states while reading their validated API projections. A successful idle read does not cover waiting, cancellation or teardown phases; reuse the owning domain schema instead of maintaining a second enum in the projection.

   For nested Hono routers, test `generateSpecs()` on the mounted parent and assert the new operation IDs. A child router's custom `onError` can wrap middleware and hide `describeRoute` metadata while HTTP tests still pass; map domain errors inside handlers or at the owning server boundary instead.

2. Typecheck the runtime, SDK, and affected client.
   For authorization-code exchanges, test concurrent single-use consumption, exact client/callback/issuer binding, S256 failure, current-account revocation and hashed persistence. Exercise refresh rotation and replay across a service restart, including rejection of all tokens derived from the revoked grant. A failed refresh response must not roll back the revocation it reports. Verify registered-origin preflight without allowing cross-origin cookie credentials.

   Native clients persist refresh intent before network use and publish access only after saving the rotated credential. Test lost responses, failed encryption/promotion, restart and logout racing late completion. An old refresh credential may support a separate revocation-only endpoint; keep authority/client binding, uniform unknown-token responses and independent-login preservation explicit. Exercise the real OS credential adapter and current-frame IPC through the production preload, alongside deterministic failure fixtures; Node consumers of shared filesystem utilities need a real Node child check.

   Give native credential fixtures a unique application name before readiness as well as isolated application data. OS key providers can key by application name, so a fresh directory alone can still target an existing app's credentials. Remove only the exact fixture-owned keychain item during cleanup; never loosen access to a pre-existing item. Electron ESM fixtures must finish module evaluation before awaiting app readiness inside their asynchronous runner, and capture bounded process output so descendant-held pipes cannot stall cleanup.

3. Run the affected frontend context/component test when response identity or event reconciliation changes.
   For narrowed configuration snapshots, compare the actual bootstrap response with the authoritative configuration under the real optional-owner composition. Cover absent, disabled and enabled settings plus explicit model selection; a hand-written frontend fixture with the setting already present cannot detect a dropped server field. Keep unregistered owners absent rather than importing their implementations into Server.
4. Inspect the generated diff; do not hand-edit generated SDK files. Use `bun run --cwd packages/sdk/js build --compile-only` to validate the existing client concurrently with source readers. Full generation cleans and rewrites `src/gen`, so reserve it for explicit generation work, not read-only package checks.
   Keep generated source included in the SDK's TypeScript project and add new browser client exports to the existing Web source aliases. Vite discovers the nearest matching TypeScript project; excluding generated modules can make a nested worktree inherit an unrelated ancestor configuration. Verify the production Web build as well as direct SDK compilation.
5. Run `bun run quality:quick` after focused checks.
6. For event transports, test dropped sends, send exceptions, and subscription removal through the client's observed close/reconnect path. Verify that successful heartbeats require an active event subscription and that one failed client does not interrupt healthy subscribers.
7. File response bodies can outlive their HTTP handlers. Capture native file identity before returning and retain the Workspace binding until body completion or cancellation. Exercise unread bodies, caller abort, Workspace disposal and atomic pathname replacement; returning a lazy path-based stream does not establish resource ownership.
8. Native WebSocket callbacks do not inherit the upgrading request's Scope. Capture the owning request context for callbacks that read scoped state or emit scoped telemetry, and test an actual server socket alongside an unrelated Scope request. Directly calling a route or domain callback inside a test Scope hides this boundary.
   Await the WebSocket helper before transferring admission ownership. Hono's Bun middleware calls `next()` and returns no response when native upgrade returns false; no socket event will release a never-opened lease. Dispose that lease on the non-upgrade return, and keep asynchronous helper rejection inside the cleanup `catch`. Test the actual helper with native false, throw and true outcomes on each transport leg, retaining real pairing/admission and verifying watcher removal through subsequent revocation.

   Machine bridges must test signed identity and capability claims, concurrent authentication, durable connection generations and service restart with real sockets. Carry connection liveness through the actual storage commit guard, and keep heartbeat expiry separate from execution ownership. Test current-account removal as well as machine-credential revocation; an authenticated socket is not permanent authorization.

9. Optional APIs follow the runtime component selection exposed by `global.capabilities`; installing a package must not claim that it is active before restart. Managed SDK startup uses the public `runtime-ready` protocol, explicit executable/version/home, private credentials and owned-process cleanup. Verify a real Node.js caller as well as Bun fixtures, including timeout, abort, attach ownership and Scope headers retaining caller authentication.
10. Resource APIs select catalog identities without allocating compute. Test stale selection/generation conflicts, Scope mismatches, retained uses and save retry without command replay. Keep file-operation payloads out of activity responses. Session turn admission must wait for resource binding changes before reading its execution context.
11. Built Web page paths may overlap domain APIs. Test direct browser navigation with the owner both selected and absent, waiting for rendered page content and successful browser API reads. An unchanged URL alone cannot prove that the Web shell loaded. Keep early HTML negotiation restricted to known page paths; both it and the final SPA fallback must reject API/fetch requests using the same document-navigation rule. Verify absent APIs return 404 with the Web adapter mounted, including SDK requests without an Accept header. Retain authentication, Scope, CORS, CSP and API errors, and verify generated OpenAPI operations survive the navigation handler.

Update [Frontend data sync](../../../docs/architecture/frontend-data-sync.md) when snapshot/event/replay semantics change, and update API/help/product docs when the route is a public or user-facing contract.

## Handoff

Report route and operation ID, Scope ownership, schema/errors, generated method, event/snapshot behavior, consumers migrated, generated files, and tests.
