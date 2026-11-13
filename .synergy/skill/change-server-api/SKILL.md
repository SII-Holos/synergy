---
name: change-server-api
description: Add or modify a Synergy HTTP route, request/response schema, OpenAPI operation, generated SDK method, frontend API call, scoped snapshot, upload/download endpoint, or stream boundary. Use for packages/server/src/server, packages/sdk, or apps/web calls to internal server APIs.
---

# Change a Server API

## Trace the Contract

1. Inspect the nearest route, its owning domain service, route tests, generated SDK method, and every first-party consumer.
2. Decide whether the route is global, home-scoped, project-scoped, session-owned, or workspace-owned. Preserve Scope/directory resolution and authorization.

   For private object catalogs, resolve stored ownership and current access before returning metadata. Page authorized identity indexes before loading bodies; test interleaved foreign records beyond one page, duplicate visible identities, removed membership and administrator accounts. Anonymous capacity endpoints must expose counts without loading private records. Keep metadata reservations distinct from execution acceptance. Derived historical indexes retain a processed sequence, catch up older writers' tails and resolve versions at the cursor's fixed watermark; an empty filtered page must retain its continuation.

   For credentialed resource catalogs, separate administrator configuration, member descriptors and private secret records. Commit credential rotation and metadata together. Retain revoked grant revisions, update authorized indexes atomically, and merge bounded index pages before loading records. Verify current project roles independently of resource grants, endpoint/key redaction, restart, rollback and cross-project scope.

   Keep cleanup metadata inspection separate from acquiring new resource use. After a committed bind loses its response, availability or execution-role changes must not prevent the current owner from resolving its retained generation. Preserve machine and object-binding checks, return only established metadata, and verify that inspection never reacquires resources or replays work. Exercise archive/transfer fences, response loss followed by disablement, reconnect and altered returned identities.

For scoped external credentials, select capability purposes in trusted route code, resolve the target's canonical owner and intersect current authority. Do not accept a purpose from request bodies or reuse a broader browser token. Store only token digests; uncertain issuance must resolve metadata without redisclosing the original secret. Test revoked credentials during a real stream and signed actor attribution through admission.

For authoritative machine observations, trace every writer into the ledger, including browser routes and domain exports. Human visibility control or immutable-byte upload authority does not authenticate the observation producer. Reuse the current machine connection and native writer; test rejected human writes without state changes and accepted genuine machine frames. Preserve separately authorized immutable content uploads.

3. Decide whether the behavior is request/response state, a sequenced state event, or a streaming transport. Do not force WebSocket, SSE, WebRTC, file/blob, or external URL behavior into an ordinary SDK call.

4. Check the `operationId` for a generated-method collision before implementing. The generator keys a method by the id's first two segments with a leading `global.` stripped, so `global.session.status` and `session.status` both resolve to `Session.status` — the generated method silently retargets one route and the other disappears from the SDK entirely, with no build error. Give the newer route a non-colliding id (`global.session.statuses`, not `global.session.status`) and confirm after regeneration that both methods exist and target their own paths.

## Implement

1. Validate path, query, form, and body input with precise Zod schemas.
2. Add `describeRoute` metadata, stable `operationId`, response schemas, and structured error responses. Add `.meta({ ref: "TypeName" })` for reusable API-visible schemas.
   For credential-bearing routes, replace validator response hooks that echo submitted data with the owning structured error. Exercise malformed bodies containing secret-like values and confirm neither responses nor logs reproduce them. Declare required request bodies in mounted OpenAPI metadata and test the generated caller; runtime validation alone does not make the SDK argument required.
3. Keep business logic in the owning domain rather than the route handler. For binary media, document the supported MIME types, preserve structured error reasons and propagate the request abort signal. Test the generated SDK blob path as well as the mounted route; request previews must use saved owner configuration without creating task sessions.

   Native attachment reads require canonical producer evidence for the exact current message/part version. Never capture a global asset hash on demand to establish read authority. Verify owner/reference mismatches, unavailable retained bytes and part changes across a held bounded read. Native saves derive their immutable descriptor before choosing a destination and abort staged output if evidence disappears during transfer.
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
   For live metadata subscriptions, bound raw frames before an SDK parser buffers them. Capture the subscriber's exact identity and retire it on replacement; perform current authorization and the actual enqueue inside the same admitted callback. Do not retain a maintenance operation for the entire connection. Test an operation ending immediately after authorization, slow consumers and renderer acknowledgement separately from network backpressure. Reconnect without retained history must start a new stream identity rather than reuse an old cursor.
8. Native WebSocket callbacks do not inherit the upgrading request's Scope. Capture the owning request context for callbacks that read scoped state or emit scoped telemetry, and test an actual server socket alongside an unrelated Scope request. Directly calling a route or domain callback inside a test Scope hides this boundary.
   Await the WebSocket helper before transferring admission ownership. Hono's Bun middleware calls `next()` and returns no response when native upgrade returns false; no socket event will release a never-opened lease. Dispose that lease on the non-upgrade return, and keep asynchronous helper rejection inside the cleanup `catch`. Test the actual helper with native false, throw and true outcomes on each transport leg, retaining real pairing/admission and verifying watcher removal through subsequent revocation.

   Machine bridges must test signed identity and capability claims, concurrent authentication, durable connection generations and service restart with real sockets. Carry connection liveness through the actual storage commit guard, and keep heartbeat expiry separate from execution ownership. Test current-account removal as well as machine-credential revocation; an authenticated socket is not permanent authorization.

   Service-signed permits need a migration-owned deployment key and separate signature domains for each proof family. Test every authority-bearing claim, mismatched handshake identity, key retention across restart and an interrupted migration, and refusal to replace missing or corrupt completed credentials. Validate public DTOs separately from secret records; a valid signature alone is not Runtime acceptance.

   Root execution grants require retained native reception and independently verified materialization. Sign exact root/receipt identities, recheck current driver and resource authority, and keep reconciliation separate from binding publication. Test lost ACK without replay, binding rollback preserving B, actor versus driver revocation, and shared Session resource selection without participant permission unions.

   When materialization needs model metadata, expose a separate accepted-receipt description operation. Verify it before any root exists and assert that it creates neither a root index nor call usage. Share current authorization with the binding owner, but keep description signatures distinct and exclude upstream configuration and secrets.

   Resource gateways issue finite per-call capabilities and consume durable budgets before transmission. Recheck authority after bounded body reads, retain admission through stream disposal and never replay a started call. Test locked SDKs, resource rotation, commit-time revocation, redirects, unread-body shutdown and real HTTP cancellation; distinguish transport EOF from model completion and token usage. Secrets and caller transport headers must not cross the credential boundary.

   Machine resource clients retain signing keys in their connection owner and use generated control methods with verified deployment trust. Validate returned identities and signatures, preserve structured errors, and bound response reads and concurrent transport work with cancellable waiting. Explicitly cancel active readers before pool disposal; an HTTP request signal alone does not prove body drainage. Test real TLS, held bodies, response loss and reconnect without replay. Concurrent tests must associate completion with observed arrivals rather than assuming request order.

   Command forwarding must distinguish a dropped native send from an enqueued backpressured frame and an uncertain exception. Exercise an actual socket with lost ACK, late receipt after HTTP cancellation, per-Session waiting cancellation and reconnect. Read-only receipt queries never replay input or issue skip; explicit retry reconciles the original attempt before fresh authorization. Cross-service tests must inspect the native Inbox in an independent database and verify that the service retains no input body.

   For ordered controls, verify that a rejected intent can be followed by a different valid action through the public API. Close rejected sequence slots with a retained skip proof; test lost closure ACK separately from unknown command reception. An unchanged native pause timestamp does not identify a second human pause intent: version it and test a stale Continue against that version.

   A cancellation response can acknowledge durable reception before physical drainage finishes. Publish it only after native commit, keep the original callback and capacity slot owned until drainage settles, and send one reply per exchange. Verify a real held execution lease through the public service and resident bridge, post-commit disconnect, failed drainage, and duplicate reception after the same run resumes. An immutable receipt cannot establish current process exit.

   Keep current execution observations outside durable command receipts. Observe native evidence without recovery, then recheck read access and ownership after the remote reply. Test held newer controls, saturated command windows with reserved query capacity, concurrent revocation/binding changes, missing evidence, offline reads and a task resumed after cancellation. Unknown physical completion must not become an idle or stopped assertion.

   Keep collaborative pending reads separate from private history access and reply admission. Reuse native owner windows, qualify cursors by source and native view, and query exact winner identities without answer values. Test another actor's decision, a removed cursor, a changed view and current access after a held reply; absence from a page cannot establish the caller's commit.

9. Optional APIs follow the runtime component selection exposed by `global.capabilities`; installing a package must not claim that it is active before restart. Managed SDK startup uses the public `runtime-ready` protocol, explicit executable/version/home, private credentials and owned-process cleanup. Verify a real Node.js caller as well as Bun fixtures, including timeout, abort, attach ownership and Scope headers retaining caller authentication.
10. Resource APIs select catalog identities without allocating compute. Test stale selection/generation conflicts, Scope mismatches, retained uses and save retry without command replay. Keep file-operation payloads out of activity responses. Session turn admission must wait for resource binding changes before reading its execution context.

    Register an HTTP resource origin through the selected Server composition before opening the Runtime. Capture original selectors, Scope, signal and read/write mode before awaiting resolution. Inherit a present resource frame's opaque origin and reject missing provenance instead of replacing it with a Host origin. Test actual HTTP bytes through the canonical storage-backed file owner, compare inherited origin identity, reject malformed frames before body reads, and count provider allocations during dormant browsing. Minimal route fixtures must explicitly compose the HTTP owner.
11. Built Web page paths may overlap domain APIs. Test direct browser navigation with the owner both selected and absent, waiting for rendered page content and successful browser API reads. An unchanged URL alone cannot prove that the Web shell loaded. Keep early HTML negotiation restricted to known page paths; both it and the final SPA fallback must reject API/fetch requests using the same document-navigation rule. Verify absent APIs return 404 with the Web adapter mounted, including SDK requests without an Accept header. Retain authentication, Scope, CORS, CSP and API errors, and verify generated OpenAPI operations survive the navigation handler.

Update [Frontend data sync](../../../docs/architecture/frontend-data-sync.md) when snapshot/event/replay semantics change, and update API/help/product docs when the route is a public or user-facing contract.

## Handoff

For machine handoff actions, address an existing durable handoff and derive its signed plan from current stored ownership and connection authority. Keep the path separate from input/Continue admission. Test post-response revocation, finite plan tampering and explicit inspection after an unknown send with the real transport; verify that a missing native callback advertises no capability. Object reads require a completely verified package closure, not merely a hash written during an interrupted export. Exercise cold reopening, cancellation and unreachable retained bytes through the native owner before exposing range relay.

For long destination copies, refresh a separate machine-signed finite proof per bounded range. Bind the full stored handoff and live destination connection, reauthorize both participants after the source response, and reject browser credentials. Native receivers verify contiguous offsets and the final frame checksum before retention. Test same-Store producer reads through real native staging; never bypass the binary owner's gate or silently replace corrupt cached bytes with remote content.

Controller fixtures must open the prepared/enrolled Homes supplying their machine keys. Another Store with copied binding metadata does not establish that machine's installed writer. Hold native work while a short HTTP observer ends, verify its distinct connection lifetime and inspect the same job; also drop an actual completion receipt and count preparation calls. Concurrent retries must join the exact owned native job; inspection cannot silently restart it. Snapshot caller objects, signals and private ports before asynchronous authorization, and mutate them while the real verifier is held.

Report route and operation ID, Scope ownership, schema/errors, generated method, event/snapshot behavior, consumers migrated, generated files, and tests.

Verify optional schema fields from both the full product and a minimal consumer type graph. An unavailable exact field must match its runtime rejection type; do not import an unrelated optional owner, cast the generated SDK call or drop input merely to satisfy an augmentation-dependent type.

Verify service probes through the real transport and outer admission layer during maintenance, release and close. Liveness must not depend on storage admission; readiness reads must retain their declared response without creating an accepted-operation tail. Restrict admission exceptions to exact read-only probe paths.

With the current hono-openapi validator, keep a multi-field query object inline instead of attaching a schema-component reference to the whole query DTO. Verify every required path and query field in the mounted OpenAPI operation, then call the freshly generated SDK against the real route. A successful SDK build cannot establish that every query field was serialized; test actual request data rather than bypassing a missing generated parameter with raw fetch or casts.

Separate immutable machine fact acknowledgement from current human projections. A retained signature can authorize reconciliation of that original fact without authorizing fresh private metadata. Replay a genuine old fact after visibility changes and a later private binding change; require only its original binding/purpose/digest. Verify cleanup-only inspection through actual lost replies without resubmitting retirement or returning content.

When a pending machine reply can outlive an authorization change, compare the original and final authorization modes before returning that reply. A narrower cleanup permission cannot authorize an earlier private projection. Hold a genuine nonempty response across the real cancellation and role-removal transactions, then verify both denial of that response and successful original cleanup. Do not infer machine nonexecution from the rejected late HTTP response.

When a feature needs peer selection but the ordinary registry is private, expose only feature-scoped metadata under its existing owner; do not broaden registry access or reuse a full registration DTO. Bind bounded cursors to the authenticated scope and preserve filtered empty pages. For an existing operation's native caption, resolve its original target and mapping rather than a new default; recheck current roles, complete references and connection after the finite read. Snapshot caller credentials and cancellation before awaiting admission, and test mutation of the input object as well as real revocation.

For machine fact recovery, distinguish original Source receipts from Target cleanup permits and retain the native Home/primary/artifact owner through signing and acknowledgement. After a business-effect producer may have dispatched, empty or inconsistent acknowledgements and failed owner/abort checks cannot establish non-dispatch. Test committed replies replaced with empty data, another fact hash and observer cancellation; preserve unknown outcomes and reconcile the original fact while retaining explicit service rejection semantics.
