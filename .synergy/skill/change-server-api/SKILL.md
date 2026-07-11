---
name: change-server-api
description: Add or modify a Synergy HTTP route, request/response schema, OpenAPI operation, generated SDK method, frontend API call, scoped snapshot, upload/download endpoint, or stream boundary. Use for packages/synergy/src/server, packages/sdk, or packages/app calls to internal server APIs.
---

# Change a Server API

## Trace the Contract

1. Inspect the nearest route, its owning domain service, route tests, generated SDK method, and every first-party consumer.
2. Decide whether the route is global, home-scoped, project-scoped, session-owned, or workspace-owned. Preserve Scope/directory resolution and authorization.
3. Decide whether the behavior is request/response state, a sequenced state event, or a streaming transport. Do not force WebSocket, SSE, WebRTC, file/blob, or external URL behavior into an ordinary SDK call.

## Implement

1. Validate path, query, form, and body input with precise Zod schemas.
2. Add `describeRoute` metadata, stable `operationId`, response schemas, and structured error responses. Add `.meta({ ref: "TypeName" })` for reusable API-visible schemas.
3. Keep business logic in the owning domain rather than the route handler.
4. For state changes, persist first and publish the established event shape so frontend state can reconcile without per-event refetches.
5. Preserve scoped snapshot watermark headers where middleware supplies them. Do not claim Web snapshot gating that the client does not implement.
6. Regenerate contracts from the repository root:

```bash
./script/generate.ts
```

7. Replace or add frontend calls through `createSynergyClient()` / the generated SDK. Preserve auth, Scope/directory parameters, errors, and asset URL formats.

## Verify

1. Test validation, success, domain error, Scope ownership, and event behavior at the narrowest route/domain level.
2. Typecheck the runtime, SDK, and affected client.
3. Run the affected frontend context/component test when response identity or event reconciliation changes.
4. Inspect the generated diff; do not hand-edit generated SDK files.
5. Run `bun run quality:quick` after focused checks.

Update [Frontend data sync](../../../docs/architecture/frontend-data-sync.md) when snapshot/event/replay semantics change, and update API/help/product docs when the route is a public or user-facing contract.

## Handoff

Report route and operation ID, Scope ownership, schema/errors, generated method, event/snapshot behavior, consumers migrated, generated files, and tests.
